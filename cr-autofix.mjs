/**
 * CodeRabbit actions (Review / Autofix) — optional, easy to rip out.
 *
 * Disable:  CR_AUTOFIX=0 (env) — no UI, no routes, no overlay.
 * Delete:   remove this file, then every block marked
 *           `CR Autofix (removable)` in server.mjs and public/index.html.
 *
 * Behavior:
 * - POST /api/cr-action { action: "autofix"|"review" } via `gh pr comment`
 * - Optimistic autofixing / reviewing until status comments settle
 * - Autofix Completed + unresolved threads → leftover (keep badge; suggest Resolve leftovers)
 * - POST /api/cr-resolve-leftovers resolves CR threads older than Autofix Completed
 * - Delivery blocked → delivery state + optional taskUrl deep link
 * - Queue review while rate-limited → fire at limitedUntil + 60s (catch-up after sleep)
 *   Auto-queued when a PR is limited; cancel skips re-queue for that capacity window
 */

import { execFile } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

export const CR_AUTOFIX_ENABLED = process.env.CR_AUTOFIX !== '0';

/** Fire queued reviews this long after CodeRabbit's limitedUntil. */
export const CR_REVIEW_QUEUE_BUFFER_MS = 60 * 1000;
/** Minimum gap between queued fires on the same repo. */
export const CR_REVIEW_QUEUE_STAGGER_MS = 3 * 60 * 1000;

const QUEUE_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'cr-review-queue.json'
);

const OPTIMISTIC_TTL_MS = 20 * 60 * 1000;
/** @type {Map<string, { startedAt: number, kind: 'autofix'|'review' }>} */
const optimisticByKey = new Map();

const AUTOFIX_STATUS = /autofix status by CodeRabbit/i;
const CODING_STATUS = /coding agent status by CodeRabbit/i;
const TASK_URL_RE = /https:\/\/app\.coderabbit\.ai\/code\/tasks\/[a-f0-9-]+[^\s)"\]]*/i;

export function autofixKey(slug, prNumber) {
  return `${slug}#${prNumber}`;
}

export function markCrActionStarted(slug, prNumber, kind = 'autofix') {
  if (!slug || !prNumber) return;
  optimisticByKey.set(autofixKey(slug, prNumber), {
    startedAt: Date.now(),
    kind: kind === 'review' ? 'review' : 'autofix'
  });
}

/** @deprecated use markCrActionStarted */
export function markAutofixStarted(slug, prNumber) {
  markCrActionStarted(slug, prNumber, 'autofix');
}

export function clearAutofixOptimistic(slug, prNumber) {
  if (!slug || !prNumber) return;
  optimisticByKey.delete(autofixKey(slug, prNumber));
}

export function parseCrTaskUrl(comments) {
  let best = null;
  for (const c of comments || []) {
    const body = c.body || '';
    if (!AUTOFIX_STATUS.test(body) && !CODING_STATUS.test(body) && !/coding-agent-task-id/i.test(body)) {
      continue;
    }
    const m = body.match(TASK_URL_RE);
    if (!m) continue;
    const at = new Date(
      c.updated_at || c.updatedAt || c.created_at || c.createdAt || 0
    ).getTime();
    if (!best || at >= best.at) best = { url: m[0].replace(/[.,;]+$/, ''), at };
  }
  return best?.url || null;
}

/**
 * @param {Array<{ body?: string, created_at?: string, createdAt?: string, updated_at?: string, updatedAt?: string }>|null|undefined} comments
 * @returns {{ phase: 'running'|'completed'|'failed'|'delivery', at: number, taskUrl: string|null }|null}
 */
export function parseAutofixStatus(comments) {
  let best = null;
  for (const c of comments || []) {
    const body = c.body || '';
    const isAutofixStatus = AUTOFIX_STATUS.test(body);
    const isCodingStatus = CODING_STATUS.test(body);
    const hasTaskId = /coding-agent-task-id/i.test(body);
    if (!isAutofixStatus && !isCodingStatus && !hasTaskId) continue;

    const at = new Date(
      c.updated_at || c.updatedAt || c.created_at || c.createdAt || 0
    ).getTime();
    if (!Number.isFinite(at)) continue;

    let phase = null;
    if (/delivery needs attention/i.test(body)) {
      phase = 'delivery';
    } else if (/\*\*Failed:\*\*/i.test(body)) {
      phase = 'failed';
    } else if (/\*\*Completed:\*\*/i.test(body)) {
      phase = 'completed';
    } else if (/\*\*Started:\*\*/i.test(body)) {
      phase = 'running';
    } else if (isCodingStatus && /needs attention/i.test(body)) {
      phase = 'delivery';
    } else if (isAutofixStatus) {
      phase = 'running';
    } else {
      continue;
    }

    const taskM = body.match(TASK_URL_RE);
    const taskUrl = taskM ? taskM[0].replace(/[.,;]+$/, '') : null;

    if (!best || at >= best.at) best = { phase, at, taskUrl };
  }
  return best;
}

function pruneOptimistic(key) {
  const opt = optimisticByKey.get(key);
  if (!opt) return null;
  if (Date.now() - opt.startedAt >= OPTIMISTIC_TTL_MS) {
    optimisticByKey.delete(key);
    return null;
  }
  return opt;
}

/** True when CR comments show a review finished after our optimistic start. */
export function reviewFinishedAfter(comments, sinceAt) {
  const since = Number(sinceAt) || 0;
  for (const c of comments || []) {
    const body = c.body || '';
    const at = new Date(
      c.updated_at || c.updatedAt || c.created_at || c.createdAt || c.submitted_at || c.submittedAt || 0
    ).getTime();
    if (!Number.isFinite(at) || at + 2000 < since) continue;
    if (/Review finished/i.test(body)) return true;
    if (/No actionable comments were generated in the recent review/i.test(body)) return true;
    // Rate-limit reply is a terminal outcome for a Review click — don't keep
    // the optimistic "reviewing" chip over the real limited state.
    if (/Review rate limited/i.test(body)) return true;
    if (/Action not completed/i.test(body) && /rate\s*limit/i.test(body)) return true;
    const m = body.match(/Actionable comments posted:\s*(\d+)/i);
    if (m) return true;
  }
  return false;
}

function reviewActivityAfter(comments, reviews, sinceAt) {
  if (reviewFinishedAfter(comments, sinceAt)) return true;
  if (reviewFinishedAfter(reviews, sinceAt)) return true;
  return false;
}

function settledCrState(state) {
  return state === 'clear'
    || state === 'actionable'
    || state === 'leftover'
    || state === 'delivery'
    || state === 'limited';
}

function runningAutofixOverlay(cr, at) {
  return {
    ...cr,
    state: 'autofixing',
    actionable: 0,
    tip: 'CodeRabbit Autofix running',
    detail: 'Nothing for you to do until Autofix finishes',
    autofix: { phase: 'running', at },
    taskUrl: cr.taskUrl || null
  };
}

function runningReviewOverlay(cr, at) {
  return {
    ...cr,
    state: 'reviewing',
    actionable: 0,
    tip: 'CodeRabbit review in progress',
    detail: 'Results will land on the PR shortly',
    autofix: { phase: 'reviewing', at },
    taskUrl: cr.taskUrl || null
  };
}

function deliveryOverlay(cr, at, taskUrl) {
  return {
    ...cr,
    state: 'delivery',
    tip: 'Autofix delivery blocked',
    detail: 'Changes ready but push failed — open the CR task or retry',
    autofix: { phase: 'delivery', at },
    taskUrl: taskUrl || cr.taskUrl || null
  };
}

function leftoverOverlay(cr, at, taskUrl) {
  const n = Number(cr.actionable) || 0;
  return {
    ...cr,
    state: 'leftover',
    tip: n > 0 ? `Autofix done · ${n} thread${n === 1 ? '' : 's'} left` : 'Autofix done · threads left',
    detail: 'Autofix finished — resolve the leftover threads (or re-review HEAD)',
    autofix: { phase: 'completed', at, leftover: true },
    taskUrl: taskUrl || cr.taskUrl || null,
    freshAfterReview: false
  };
}

/** Unresolved CR threads split by age relative to Autofix Completed. */
export function countUnresolvedCrThreads(threads, splitAtMs) {
  let actionable = 0;
  let newCount = 0;
  let leftoverCount = 0;
  const split = Number(splitAtMs);
  const hasSplit = Number.isFinite(split) && split > 0;
  for (const t of threads || []) {
    if (t.isResolved) continue;
    const c0 = t.comments?.nodes?.[0];
    const author = c0?.author?.login;
    if (!isCrAuthorLogin(author)) continue;
    actionable += 1;
    if (!hasSplit) {
      newCount += 1;
      continue;
    }
    const at = new Date(c0.createdAt || c0.created_at || 0).getTime();
    // Threads posted after Autofix Completed = from a later review.
    if (Number.isFinite(at) && at > split + 2000) newCount += 1;
    else leftoverCount += 1;
  }
  return { actionable, newCount, leftoverCount };
}

function isCrAuthorLogin(login) {
  return /^coderabbitai(\[bot\])?$/i.test(String(login || ''));
}

export function formatNewLeftoverChip(newCount, leftoverCount) {
  const parts = [];
  const n = Number(newCount) || 0;
  const x = Number(leftoverCount) || 0;
  if (n > 0) parts.push(`${n} new`);
  if (x > 0) parts.push(`${x} leftover`);
  return parts.join(' - ') || null;
}

/** Review finished after Autofix — remaining threads are new findings, not stale leftovers. */
function freshActionableAfterReview(cr, taskUrl, counts = null) {
  const actionable = counts?.actionable ?? (Number(cr.actionable) || 0);
  const newCount = counts?.newCount ?? actionable;
  const leftoverCount = counts?.leftoverCount ?? 0;
  if (actionable <= 0) {
    return {
      ...cr,
      state: 'clear',
      actionable: 0,
      tip: 'Good to go',
      detail: 'Re-review cleared leftover threads',
      autofix: null,
      taskUrl: taskUrl || cr.taskUrl || null,
      freshAfterReview: false,
      newCount: 0,
      leftoverCount: 0
    };
  }
  const label = formatNewLeftoverChip(newCount, leftoverCount)
    || `${actionable} actionable`;
  return {
    ...cr,
    state: 'actionable',
    actionable,
    tip: label,
    detail: leftoverCount > 0 && newCount > 0
      ? 'Mix of new findings and leftovers — Autofix for the new ones'
      : newCount > 0
        ? 'Not stale leftovers — Autofix is the usual next step'
        : 'Leftover threads remain after re-review',
    autofix: null,
    taskUrl: taskUrl || cr.taskUrl || null,
    freshAfterReview: true,
    newCount,
    leftoverCount
  };
}

const TERMINAL = new Set(['completed', 'failed', 'delivery']);

/**
 * Apply CR action overlay onto a classified CR state.
 */
export function overlayAutofix(cr, { slug, comments, reviews, threads } = {}) {
  if (!CR_AUTOFIX_ENABLED || !cr) return cr;

  const prNumber = cr.prNumber;
  const taskUrlFromComments = parseCrTaskUrl(comments);
  if (!prNumber || !slug) {
    return {
      ...cr,
      autofix: cr.autofix || null,
      taskUrl: taskUrlFromComments || cr.taskUrl || null
    };
  }

  const key = autofixKey(slug, prNumber);
  const parsed = parseAutofixStatus(comments);
  const opt = pruneOptimistic(key);
  const taskUrl = parsed?.taskUrl || taskUrlFromComments || cr.taskUrl || null;
  const finishedAfter = (sinceAt) => reviewActivityAfter(comments, reviews, sinceAt);
  const countsAfter = (splitAt) => {
    if (!Array.isArray(threads) || !threads.length) {
      const n = Number(cr.actionable) || 0;
      return { actionable: n, newCount: n, leftoverCount: 0 };
    }
    const counted = countUnresolvedCrThreads(threads, splitAt);
    // Don't let an empty thread page wipe a known actionable count.
    if (counted.actionable === 0 && (Number(cr.actionable) || 0) > 0) {
      const n = Number(cr.actionable) || 0;
      return { actionable: n, newCount: n, leftoverCount: 0 };
    }
    return counted;
  };

  if (parsed && TERMINAL.has(parsed.phase)) {
    if (opt && opt.startedAt > parsed.at) {
      // Autofix Completed is older than a newer Review click — keep review running
      // unless comments already show the review finished.
      if (opt.kind === 'review' && finishedAfter(opt.startedAt)) {
        optimisticByKey.delete(key);
      } else if (opt.kind === 'review') {
        return runningReviewOverlay(cr, opt.startedAt);
      } else {
        return runningAutofixOverlay(cr, opt.startedAt);
      }
    } else {
      optimisticByKey.delete(key);
    }
    if (parsed.phase === 'delivery') {
      return deliveryOverlay(cr, parsed.at, taskUrl);
    }
    // Completed/failed with unresolved threads → leftover, unless a newer review
    // already landed (then those threads are fresh findings → Autofix next).
    if (
      parsed.phase === 'completed'
      && (cr.state === 'actionable' || (Number(cr.actionable) || 0) > 0)
    ) {
      if (finishedAfter(parsed.at)) {
        return freshActionableAfterReview(cr, taskUrl, countsAfter(parsed.at));
      }
      return leftoverOverlay(cr, parsed.at, taskUrl);
    }
    return {
      ...cr,
      autofix: { phase: parsed.phase, at: parsed.at },
      taskUrl,
      freshAfterReview: false
    };
  }

  if (opt?.kind === 'review') {
    // Review landed (clear / findings / leftover) or CR said "Review finished".
    if (
      settledCrState(cr.state)
      || finishedAfter(opt.startedAt)
    ) {
      optimisticByKey.delete(key);
      // If Autofix Completed is still on the PR but a newer review finished,
      // don't keep the sticky leftover messaging.
      if (
        parsed?.phase === 'completed'
        && (cr.state === 'actionable' || (Number(cr.actionable) || 0) > 0)
        && finishedAfter(parsed.at)
      ) {
        return freshActionableAfterReview(cr, taskUrl, countsAfter(parsed.at));
      }
    } else if (
      cr.state === 'pending'
      || cr.state === 'ready'
      || cr.state === 'empty'
      || cr.state === 'reviewing'
    ) {
      return runningReviewOverlay({ ...cr, taskUrl }, opt.startedAt);
    }
  }

  const runningAutofix = (parsed && parsed.phase === 'running') || opt?.kind === 'autofix';
  if (runningAutofix) {
    return runningAutofixOverlay({ ...cr, taskUrl }, parsed?.at || opt?.startedAt || Date.now());
  }

  // Sticky leftover: completed autofix still on PR + actionable threads —
  // only when no newer review has finished since that Autofix Completed.
  if (
    cr.autofix?.leftover
    && (cr.state === 'actionable' || (Number(cr.actionable) || 0) > 0)
  ) {
    const autofixAt = cr.autofix.at || 0;
    if (finishedAfter(autofixAt)) {
      return freshActionableAfterReview(cr, taskUrl, countsAfter(autofixAt));
    }
    return leftoverOverlay(cr, autofixAt, taskUrl);
  }

  // Drop stale reviewing meta once classification moved on.
  if (cr.autofix?.phase === 'reviewing' && settledCrState(cr.state)) {
    return { ...cr, autofix: null, taskUrl, freshAfterReview: !!cr.freshAfterReview };
  }

  return {
    ...cr,
    autofix: cr.autofix || null,
    taskUrl,
    freshAfterReview: !!cr.freshAfterReview
  };
}

/** Re-apply optimistic / sticky display on /api/status between GH ticks. */
export function finalizeAutofixForStatus(cr, slug) {
  if (!CR_AUTOFIX_ENABLED || !cr) return cr;
  if (
    cr.state === 'autofixing'
    || cr.state === 'delivery'
    || cr.state === 'leftover'
  ) {
    return cr;
  }
  // Never re-stick reviewing over a settled classification (includes limited).
  if (settledCrState(cr.state)) {
    if (slug && cr.prNumber) {
      const key = autofixKey(slug, cr.prNumber);
      const opt = optimisticByKey.get(key);
      if (opt?.kind === 'review') optimisticByKey.delete(key);
    }
    if (cr.autofix?.phase === 'reviewing') {
      return { ...cr, autofix: null };
    }
    return cr;
  }
  if (cr.autofix?.phase === 'running') {
    return runningAutofixOverlay(cr, cr.autofix.at || Date.now());
  }
  // Active rate-limit window on the payload must win over sticky reviewing meta.
  if (
    cr.limitedUntil
    && new Date(cr.limitedUntil).getTime() > Date.now()
    && cr.autofix?.phase === 'reviewing'
  ) {
    if (slug && cr.prNumber) {
      const key = autofixKey(slug, cr.prNumber);
      if (optimisticByKey.get(key)?.kind === 'review') optimisticByKey.delete(key);
    }
    return {
      ...cr,
      state: 'limited',
      tip: cr.tip || 'Review rate-limited',
      autofix: null
    };
  }
  if (cr.autofix?.phase === 'reviewing') {
    return runningReviewOverlay(cr, cr.autofix.at || Date.now());
  }
  if (cr.autofix?.phase === 'delivery') {
    return deliveryOverlay(cr, cr.autofix.at || Date.now(), cr.taskUrl);
  }
  if (
    cr.autofix?.leftover
    && (cr.state === 'actionable' || (Number(cr.actionable) || 0) > 0)
  ) {
    return leftoverOverlay(cr, cr.autofix.at || Date.now(), cr.taskUrl);
  }
  if (!slug || !cr.prNumber) return cr;
  if (TERMINAL.has(cr.autofix?.phase) && !cr.autofix?.leftover) return cr;
  const opt = pruneOptimistic(autofixKey(slug, cr.prNumber));
  if (!opt) return cr;
  return opt.kind === 'review'
    ? runningReviewOverlay(cr, opt.startedAt)
    : runningAutofixOverlay(cr, opt.startedAt);
}

// --- Queued review after rate limit ---

/** @type {Array<{ id: string, projectId: string, slug: string, owner: string, name: string, prNumber: number, limitedUntil: string, fireAt: string, queuedAt: string }>} */
let reviewQueue = [];
let queueLoaded = false;
let queueTickInFlight = false;
/** @type {{ projectId: string, prNumber: number, at: string, ok: boolean, error?: string }|null} */
let lastQueueFire = null;

function queueEntryId(projectId, prNumber) {
  return `${projectId}#${prNumber}`;
}

function loadReviewQueue() {
  if (queueLoaded) return;
  queueLoaded = true;
  try {
    const raw = fs.readFileSync(QUEUE_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    reviewQueue = Array.isArray(parsed?.entries) ? parsed.entries.filter(Boolean) : [];
  } catch {
    reviewQueue = [];
  }
}

function saveReviewQueue() {
  try {
    fs.writeFileSync(
      QUEUE_PATH,
      `${JSON.stringify({ entries: reviewQueue }, null, 2)}\n`,
      'utf8'
    );
  } catch (err) {
    console.warn('Failed to persist CR review queue:', err.message);
  }
}

export function getQueuedCrReview(projectId, prNumber) {
  loadReviewQueue();
  const id = queueEntryId(projectId, prNumber);
  return reviewQueue.find((e) => e.id === id) || null;
}

export function listQueuedCrReviews() {
  loadReviewQueue();
  return [...reviewQueue];
}

export function getLastCrQueueFire() {
  return lastQueueFire;
}

/** Skip auto-queue for a PR+window after the user cancels (in-memory). */
const canceledAutoQueueUntil = new Map();

/**
 * Queue @coderabbitai review for after rate-limit window (+ buffer).
 * @param {{ projectId: string, owner: string, name: string, prNumber: number, limitedUntil: string }} opts
 */
export function queueCrReview(opts) {
  loadReviewQueue();
  const projectId = String(opts.projectId || '');
  const owner = String(opts.owner || '');
  const name = String(opts.name || '');
  const prNumber = Number(opts.prNumber);
  const limitedUntil = opts.limitedUntil ? new Date(opts.limitedUntil) : null;
  if (!projectId || !owner || !name || !Number.isFinite(prNumber) || !limitedUntil || Number.isNaN(limitedUntil.getTime())) {
    return { ok: false, error: 'projectId, repo, prNumber, and limitedUntil required' };
  }
  const slug = `${owner}/${name}`;
  const id = queueEntryId(projectId, prNumber);
  // PRs by the same author in a repo share one CR allowance — space fires out
  // so the second doesn't burn the slot the first just got.
  let fireAtMs = limitedUntil.getTime() + CR_REVIEW_QUEUE_BUFFER_MS;
  const siblingFires = reviewQueue
    .filter((e) => e.slug === slug && e.id !== id)
    .map((e) => new Date(e.fireAt).getTime())
    .filter(Number.isFinite)
    .sort((a, b) => a - b);
  for (const t of siblingFires) {
    if (Math.abs(fireAtMs - t) < CR_REVIEW_QUEUE_STAGGER_MS) fireAtMs = t + CR_REVIEW_QUEUE_STAGGER_MS;
  }
  const fireAt = new Date(fireAtMs);
  canceledAutoQueueUntil.delete(id);
  const entry = {
    id,
    projectId,
    slug,
    owner,
    name,
    prNumber,
    limitedUntil: limitedUntil.toISOString(),
    fireAt: fireAt.toISOString(),
    queuedAt: new Date().toISOString()
  };
  reviewQueue = reviewQueue.filter((e) => e.id !== id);
  reviewQueue.push(entry);
  saveReviewQueue();
  return { ok: true, entry };
}

/**
 * @param {{ byUser?: boolean }} [opts] byUser=false (automatic cleanup) does not
 *   suppress auto-queue for the same window; only an explicit cancel does.
 */
export function cancelQueuedCrReview(projectId, prNumber, { byUser = true } = {}) {
  loadReviewQueue();
  const id = queueEntryId(projectId, prNumber);
  const existing = reviewQueue.find((e) => e.id === id);
  const before = reviewQueue.length;
  reviewQueue = reviewQueue.filter((e) => e.id !== id);
  if (reviewQueue.length === before) return { ok: false, error: 'Nothing queued' };
  if (byUser && existing?.limitedUntil) {
    canceledAutoQueueUntil.set(id, existing.limitedUntil);
  }
  saveReviewQueue();
  return { ok: true };
}

/**
 * When a PR is rate-limited, queue review for limitedUntil+60s unless already
 * queued or the user canceled for this capacity window.
 */
export function maybeAutoQueueCrReview(opts) {
  if (!CR_AUTOFIX_ENABLED) return { ok: false, skipped: true };
  const projectId = String(opts.projectId || '');
  const prNumber = Number(opts.prNumber);
  const limitedUntil = opts.limitedUntil ? new Date(opts.limitedUntil) : null;
  if (!projectId || !Number.isFinite(prNumber) || !limitedUntil || Number.isNaN(limitedUntil.getTime())) {
    return { ok: false, skipped: true };
  }
  if (limitedUntil.getTime() <= Date.now()) {
    return { ok: false, skipped: true, error: 'limit already expired' };
  }
  const id = queueEntryId(projectId, prNumber);
  const existing = getQueuedCrReview(projectId, prNumber);
  if (existing) {
    // Refresh fireAt if the capacity window moved.
    if (existing.limitedUntil !== limitedUntil.toISOString()) {
      return queueCrReview(opts);
    }
    return { ok: true, entry: existing, already: true };
  }
  const canceledUntil = canceledAutoQueueUntil.get(id);
  if (canceledUntil && canceledUntil === limitedUntil.toISOString()) {
    return { ok: false, skipped: true, canceled: true };
  }
  return queueCrReview(opts);
}

/**
 * Attach queue metadata onto a CR payload for the UI.
 */
export function withQueuedReview(cr, projectId, prNumber) {
  if (!cr) return cr;
  const entry = getQueuedCrReview(projectId, prNumber);
  if (!entry) {
    if (cr.queuedReview) {
      const { queuedReview, ...rest } = cr;
      return rest;
    }
    return cr;
  }
  return {
    ...cr,
    queuedReview: {
      fireAt: entry.fireAt,
      limitedUntil: entry.limitedUntil,
      queuedAt: entry.queuedAt
    }
  };
}

/**
 * Fire due queued reviews. Safe after laptop sleep — anything with fireAt <= now runs.
 * @param {{ postReview: Function, isPrOpen?: Function }} hooks
 */
export async function tickCrReviewQueue({ postReview, isPrOpen } = {}) {
  if (!CR_AUTOFIX_ENABLED || queueTickInFlight) return [];
  loadReviewQueue();
  const now = Date.now();
  const due = reviewQueue.filter((e) => new Date(e.fireAt).getTime() <= now);
  if (!due.length) return [];

  queueTickInFlight = true;
  const fired = [];
  try {
    for (const entry of due) {
      reviewQueue = reviewQueue.filter((e) => e.id !== entry.id);
      saveReviewQueue();

      if (typeof isPrOpen === 'function') {
        try {
          const open = await isPrOpen(entry);
          if (!open) {
            fired.push({ ...entry, ok: false, skipped: true, error: 'PR no longer open' });
            continue;
          }
        } catch {
          /* still try to fire */
        }
      }

      try {
        const result = await postReview(entry);
        const ok = !!result?.ok;
        lastQueueFire = {
          projectId: entry.projectId,
          prNumber: entry.prNumber,
          at: new Date().toISOString(),
          ok,
          error: ok ? undefined : (result?.error || 'Queue fire failed')
        };
        fired.push({ ...entry, ok, error: lastQueueFire.error });
        if (ok) {
          console.log(`CR queue: review posted on ${entry.slug}#${entry.prNumber}`);
        } else {
          console.warn(`CR queue: failed ${entry.slug}#${entry.prNumber}: ${lastQueueFire.error}`);
        }
      } catch (err) {
        lastQueueFire = {
          projectId: entry.projectId,
          prNumber: entry.prNumber,
          at: new Date().toISOString(),
          ok: false,
          error: err.message || String(err)
        };
        fired.push({ ...entry, ok: false, error: lastQueueFire.error });
      }
    }
  } finally {
    queueTickInFlight = false;
  }
  return fired;
}

export function startCrReviewQueueWatcher(hooks, intervalMs = 15000) {
  loadReviewQueue();
  const tick = () => {
    tickCrReviewQueue(hooks).catch((err) => {
      console.warn('CR review queue tick failed:', err.message || err);
    });
  };
  tick();
  return setInterval(tick, intervalMs);
}

/**
 * @param {{ owner: string, name: string, prNumber: number, action?: 'autofix'|'review', env?: NodeJS.ProcessEnv }} opts
 */
export function postCrActionComment({ owner, name, prNumber, action = 'autofix', env }) {
  return new Promise((resolve) => {
    if (!CR_AUTOFIX_ENABLED) {
      resolve({ ok: false, error: 'CR actions disabled (CR_AUTOFIX=0)' });
      return;
    }
    if (!owner || !name || !prNumber) {
      resolve({ ok: false, error: 'owner, name, and prNumber required' });
      return;
    }
    const kind = action === 'review' ? 'review' : 'autofix';
    const body = kind === 'review' ? '@coderabbitai review' : '@coderabbitai autofix';
    const repo = `${owner}/${name}`;
    execFile(
      'gh',
      ['pr', 'comment', String(prNumber), '--repo', repo, '--body', body],
      { timeout: 30000, env: env || process.env, maxBuffer: 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          resolve({
            ok: false,
            error: String(stderr || err.message || 'gh pr comment failed').trim()
          });
          return;
        }
        markCrActionStarted(repo, prNumber, kind);
        resolve({
          ok: true,
          action: kind,
          url: String(stdout || '').trim(),
          repo,
          prNumber
        });
      }
    );
  });
}

/** @deprecated use postCrActionComment */
export function postAutofixComment(opts) {
  return postCrActionComment({ ...opts, action: 'autofix' });
}
