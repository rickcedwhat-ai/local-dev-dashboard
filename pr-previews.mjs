/**
 * PR preview deploy links parsed from bot comments (reusable presets).
 *
 * - Presets: PR Preview Action (GitHub Pages), …/pr-preview/pr-N/ links, Vercel, Netlify, Cloudflare Pages
 * - Readiness: local HTTP probe of the preview URL (live vs building)
 * - Staleness: preview built before the PR head commit → "stale"
 *
 * Previews are sticky per PR: a refresh whose comment page misses the preview
 * comment keeps the last known link instead of dropping it.
 */

const PROBE_TTL_MS = 30 * 1000;
const PROBE_TIMEOUT_MS = 8000;
/** Allow a little clock skew between the build stamp and the commit date. */
const STALE_SKEW_MS = 60 * 1000;

function commentLogin(c) {
  return String(c?.author?.login || c?.user?.login || '');
}

function commentUpdatedAt(c) {
  return c?.updatedAt || c?.updated_at || c?.createdAt || c?.created_at || null;
}

function firstUrl(body, re) {
  const m = String(body || '').match(re);
  if (!m) return null;
  return (m[1] || m[0]).replace(/[.,;:]+$/, '');
}

const PRESETS = [
  {
    id: 'pr-preview-action',
    provider: 'GitHub Pages',
    match: (c) => /Sticky Pull Request Commentpr-preview|pr-preview-action/i.test(c.body || ''),
    url: (body) => firstUrl(body, /View preview at[\s\S]{0,80}?(https?:\/\/[^\s<>"')|]+)/i),
    builtAt: (body) => {
      const m = String(body || '').match(/at\s+(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2})\s*UTC/i);
      if (!m) return null;
      const d = new Date(`${m[1]}T${m[2]}:00Z`);
      return Number.isNaN(d.getTime()) ? null : d.toISOString();
    },
    removed: (body) => /Preview removed/i.test(body || '')
  },
  {
    // Custom workflows that publish under the pr-preview-action path layout
    // (…/pr-preview/pr-N/…), e.g. a "Docs Preview" table comment.
    id: 'gh-pages-pr-path',
    provider: 'GitHub Pages',
    match: (c) => /\/pr-preview\/pr-\d+\//i.test(c.body || ''),
    url: (body) => firstUrl(body, /\[[^\]]*full[^\]]*\]\((https?:\/\/[^)\s]*\/pr-preview\/pr-\d+\/[^)\s]*)\)/i)
      || firstUrl(body, /https?:\/\/[^\s)"'<>|]*\/pr-preview\/pr-\d+\/[^\s)"'<>|]*/i),
    removed: (body) => /Preview removed/i.test(body || '')
  },
  {
    id: 'vercel',
    provider: 'Vercel',
    match: (c) => /vercel/i.test(commentLogin(c)),
    url: (body) => firstUrl(body, /\[Visit Preview\]\((https?:\/\/[^)\s]+)\)/i)
      || firstUrl(body, /https?:\/\/[\w.-]+\.vercel\.app[^\s)"'<>|]*/i)
  },
  {
    id: 'netlify',
    provider: 'Netlify',
    match: (c) => /netlify/i.test(commentLogin(c)),
    url: (body) => firstUrl(body, /https?:\/\/deploy-preview-\d+--[\w-]+\.netlify\.app[^\s)"'<>|]*/i)
  },
  {
    id: 'cloudflare-pages',
    provider: 'Cloudflare Pages',
    match: (c) => /cloudflare/i.test(commentLogin(c)),
    url: (body) => firstUrl(body, /https?:\/\/[\w-]+\.[\w-]+\.pages\.dev[^\s)"'<>|]*/i)
  }
];

/** @type {Map<string, { url: string, provider: string, presetId: string, builtAt: string|null, commentAt: string|null, headAt: string|null }>} */
const previewByKey = new Map();
/** @type {Map<string, { ok: boolean, status: number|null, at: number }>} */
const probeByUrl = new Map();
const probeInFlight = new Set();

function key(slug, prNumber) {
  return `${slug}#${prNumber}`;
}

export function exportPreviewCache() {
  return Object.fromEntries(previewByKey);
}

export function importPreviewCache(obj) {
  if (!obj || typeof obj !== 'object') return;
  for (const [k, v] of Object.entries(obj)) {
    if (v?.url && !previewByKey.has(k)) previewByKey.set(k, v);
  }
}

/**
 * Newest matching bot comment wins (sticky comments are edited in place).
 * @returns {{ url, provider, presetId, builtAt, commentAt } | { removed: true } | null}
 */
export function extractPreview(comments) {
  const sorted = [...(comments || [])].sort((a, b) =>
    new Date(commentUpdatedAt(b) || 0).getTime() - new Date(commentUpdatedAt(a) || 0).getTime()
  );
  for (const c of sorted) {
    for (const p of PRESETS) {
      if (!p.match(c)) continue;
      if (p.removed?.(c.body)) return { removed: true };
      const url = p.url(c.body);
      if (!url) continue;
      const commentAt = commentUpdatedAt(c);
      return {
        url,
        provider: p.provider,
        presetId: p.id,
        builtAt: p.builtAt?.(c.body) || commentAt,
        commentAt
      };
    }
  }
  return null;
}

/**
 * Record previews seen on a PR's comments. Pass headAt (head commit date) when known.
 */
export function updatePreviewFromComments(slug, prNumber, comments, headAt = null) {
  const k = key(slug, prNumber);
  const prev = previewByKey.get(k) || null;
  const found = extractPreview(comments);
  if (found?.removed) {
    previewByKey.delete(k);
    return;
  }
  if (found) {
    previewByKey.set(k, { ...found, headAt: headAt || prev?.headAt || null });
    probe(found.url);
    return;
  }
  if (prev && headAt) previewByKey.set(k, { ...prev, headAt });
}

async function probe(url) {
  const cached = probeByUrl.get(url);
  if (cached && Date.now() - cached.at < PROBE_TTL_MS) return;
  if (probeInFlight.has(url)) return;
  probeInFlight.add(url);
  try {
    let res = await fetch(url, {
      method: 'HEAD',
      redirect: 'follow',
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS)
    });
    if (res.status === 405 || res.status === 501) {
      res = await fetch(url, {
        method: 'GET',
        redirect: 'follow',
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS)
      });
    }
    probeByUrl.set(url, { ok: res.ok, status: res.status, at: Date.now() });
  } catch {
    probeByUrl.set(url, { ok: false, status: null, at: Date.now() });
  } finally {
    probeInFlight.delete(url);
  }
}

// --- npm soak (dependabot-age-check workflow) ---
// The workflow upserts `<!-- age-check-rebase-after: YYYY-MM-DD -->` while packages are too new
// and never removes it, so "done" is inferred from the head commit landing after the soak ends.

const DAY_MS = 24 * 60 * 60 * 1000;
const SOAK_DAYS = 7;
const SOAK_MARKER_RE = /<!--\s*age-check-rebase-after:\s*(\d{4}-\d{2}-\d{2})\s*-->/i;

/** @type {Map<string, { date: string, until: string, packages: string[], commentAt: string|null }>} */
const soakByKey = new Map();
/** Head commit date per PR (sticky; only GraphQL refreshes know it). */
const headAtByKey = new Map();

/**
 * Newest marker comment → { date, until, packages }. `until` refines the marker's UTC date with
 * "(published N days ago)" relative to when the comment was written; falls back to the date.
 */
export function extractSoak(comments) {
  const sorted = [...(comments || [])].sort((a, b) =>
    new Date(commentUpdatedAt(b) || 0).getTime() - new Date(commentUpdatedAt(a) || 0).getTime()
  );
  for (const c of sorted) {
    const body = String(c.body || '');
    const m = body.match(SOAK_MARKER_RE);
    if (!m) continue;
    const commentAt = commentUpdatedAt(c);
    const packages = [];
    let youngest = null;
    for (const line of body.matchAll(/^\s*-\s+(\S+)\s+\(published\s+([\d.]+)\s+days?\s+ago\)/gim)) {
      packages.push(line[1]);
      const age = parseFloat(line[2]);
      if (Number.isFinite(age) && (youngest == null || age < youngest)) youngest = age;
    }
    let until = new Date(`${m[1]}T00:00:00Z`).getTime();
    const at = commentAt ? new Date(commentAt).getTime() : NaN;
    if (youngest != null && Number.isFinite(at)) {
      const est = at + (SOAK_DAYS - youngest) * DAY_MS;
      // Trust the estimate only when it agrees with the marker's calendar day.
      if (Math.abs(est - until) < 1.5 * DAY_MS) until = est;
    }
    return { date: m[1], until: new Date(until).toISOString(), packages, commentAt };
  }
  return null;
}

export function updateSoakFromComments(slug, prNumber, comments, headAt = null) {
  const k = key(slug, prNumber);
  if (headAt) headAtByKey.set(k, headAt);
  const found = extractSoak(comments);
  if (found) soakByKey.set(k, found);
}

/**
 * state: 'soaking' (before until) | 'ready' (after until, head not rebased since) — null once
 * the head commit is newer than the soak end (rebased) or no soak is known.
 */
export function getSoak(slug, prNumber) {
  const k = key(slug, prNumber);
  const s = soakByKey.get(k);
  if (!s) return null;
  const until = new Date(s.until).getTime();
  const headAt = headAtByKey.get(k);
  const head = headAt ? new Date(headAt).getTime() : NaN;
  if (Number.isFinite(head) && head >= until) return null;
  return {
    state: Date.now() < until ? 'soaking' : 'ready',
    date: s.date,
    until: s.until,
    packages: s.packages
  };
}

export function exportSoakCache() {
  return { soak: Object.fromEntries(soakByKey), headAt: Object.fromEntries(headAtByKey) };
}

export function importSoakCache(obj) {
  if (!obj || typeof obj !== 'object') return;
  for (const [k, v] of Object.entries(obj.soak || {})) {
    if (v?.until && !soakByKey.has(k)) soakByKey.set(k, v);
  }
  for (const [k, v] of Object.entries(obj.headAt || {})) {
    if (v && !headAtByKey.has(k)) headAtByKey.set(k, v);
  }
}

/**
 * UI payload for a PR, or null when no preview is known.
 * state: 'live' | 'building' | 'stale' | 'checking'
 */
export function getPreview(slug, prNumber) {
  const p = previewByKey.get(key(slug, prNumber));
  if (!p) return null;
  probe(p.url);
  const pr = probeByUrl.get(p.url);
  let state = 'checking';
  if (pr) {
    if (!pr.ok) {
      state = 'building';
    } else {
      const built = p.builtAt ? new Date(p.builtAt).getTime() : NaN;
      const head = p.headAt ? new Date(p.headAt).getTime() : NaN;
      state = Number.isFinite(built) && Number.isFinite(head) && built + STALE_SKEW_MS < head
        ? 'stale'
        : 'live';
    }
  }
  return {
    url: p.url,
    provider: p.provider,
    builtAt: p.builtAt,
    headAt: p.headAt,
    state
  };
}
