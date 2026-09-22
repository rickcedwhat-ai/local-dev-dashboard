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
 * - Autofix Completed + unresolved threads → leftover (keep badge; suggest Review)
 * - Delivery blocked → delivery state + optional taskUrl deep link
 */

import { execFile } from 'child_process';

export const CR_AUTOFIX_ENABLED = process.env.CR_AUTOFIX !== '0';

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
      c.updated_at || c.updatedAt || c.created_at || c.createdAt || 0
    ).getTime();
    if (!Number.isFinite(at) || at + 2000 < since) continue;
    if (/Review finished/i.test(body)) return true;
    if (/No actionable comments were generated in the recent review/i.test(body)) return true;
    const m = body.match(/Actionable comments posted:\s*(\d+)/i);
    if (m) return true;
  }
  return false;
}

function settledCrState(state) {
  return state === 'clear' || state === 'actionable' || state === 'leftover' || state === 'delivery';
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
    detail: 'Re-review HEAD — leftover threads may be stale',
    autofix: { phase: 'completed', at, leftover: true },
    taskUrl: taskUrl || cr.taskUrl || null
  };
}

const TERMINAL = new Set(['completed', 'failed', 'delivery']);

/**
 * Apply CR action overlay onto a classified CR state.
 */
export function overlayAutofix(cr, { slug, comments } = {}) {
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

  if (parsed && TERMINAL.has(parsed.phase)) {
    if (opt && opt.startedAt > parsed.at) {
      // Autofix Completed is older than a newer Review click — keep review running
      // unless comments already show the review finished.
      if (opt.kind === 'review' && reviewFinishedAfter(comments, opt.startedAt)) {
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
    // Completed/failed with unresolved threads → leftover (don't fake clear).
    if (
      parsed.phase === 'completed'
      && (cr.state === 'actionable' || (Number(cr.actionable) || 0) > 0)
    ) {
      return leftoverOverlay(cr, parsed.at, taskUrl);
    }
    return {
      ...cr,
      autofix: { phase: parsed.phase, at: parsed.at },
      taskUrl
    };
  }

  if (opt?.kind === 'review') {
    // Review landed (clear / findings / leftover) or CR said "Review finished".
    if (
      settledCrState(cr.state)
      || reviewFinishedAfter(comments, opt.startedAt)
    ) {
      optimisticByKey.delete(key);
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

  // Sticky leftover: completed autofix still on PR + actionable threads.
  if (
    cr.autofix?.leftover
    && (cr.state === 'actionable' || (Number(cr.actionable) || 0) > 0)
  ) {
    return leftoverOverlay(cr, cr.autofix.at || Date.now(), taskUrl);
  }

  // Drop stale reviewing meta once classification moved on.
  if (cr.autofix?.phase === 'reviewing' && settledCrState(cr.state)) {
    return { ...cr, autofix: null, taskUrl };
  }

  return {
    ...cr,
    autofix: cr.autofix || null,
    taskUrl
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
  // Never re-stick reviewing over a settled classification.
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
