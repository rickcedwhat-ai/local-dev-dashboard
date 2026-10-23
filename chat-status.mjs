import fs from 'node:fs';

const ACTIVE_TTL = 2 * 60 * 1000;
const ACTIVITY_TTL = 45 * 60 * 1000;
const cache = new Map();

// Consume event names/timestamps only. Never return or retain message/tool contents.
export function lifecycleStatus(lines, now = Date.now()) {
  let state = 'unknown', latest = 0, turn = null;
  const prompts = new Map();
  const questions = new Set();
  for (const line of lines) {
    let record; try { record = JSON.parse(line); } catch { continue; }
    const timestamp = Date.parse(record.timestamp);
    if (!Number.isFinite(timestamp)) continue;
    const p = record.payload || {};
    latest = Math.max(latest, timestamp);
    if (record.type === 'event_msg') {
      if (p.type === 'task_started') { state = 'working'; turn = p.turn_id; prompts.clear(); }
      else if (p.type === 'task_complete' && (!turn || !p.turn_id || turn === p.turn_id)) { state = questions.size ? 'waiting' : 'idle'; prompts.clear(); }
      else if (['turn_aborted', 'task_aborted'].includes(p.type) && (!turn || !p.turn_id || turn === p.turn_id)) { state = 'paused'; prompts.clear(); }
    }
    if ((record.type === 'event_msg' && p.type === 'user_message') || (record.type === 'response_item' && p.type === 'message' && p.role === 'user')) { questions.clear(); if (state === 'waiting') state = 'working'; }
    if (record.type === 'response_item') {
      if (p.type === 'function_call' && /(?:^|\.)(request_user_input|request_user_input_async|request_permissions)$/.test(p.name || '')) {
        // Async questions are pending input too, even while the agent continues.
        if (p.name.endsWith('request_user_input_async')) questions.add(p.call_id);
        else prompts.set(p.call_id, p.name.endsWith('request_permissions') ? 'approval' : 'input');
      }
      if (p.type === 'function_call_output') prompts.delete(p.call_id);
    }
  }
  if (state === 'working') {
    if ((prompts.size || questions.size) && now - latest <= ACTIVITY_TTL) return { state: 'waiting', reason: [...prompts.values()].includes('approval') ? 'approval' : 'input', source: 'local-events' };
    if (now - latest > ACTIVE_TTL || latest > now + 60000) return { state: 'unknown', reason: 'stale', source: 'local-events' };
  }
  return { state, reason: state === 'waiting' ? 'input' : null, source: 'local-events' };
}

export function readLifecycleStatus(file, now = Date.now()) {
  if (!file) return { state: 'unknown' };
  let fd;
  try {
    const stat = fs.statSync(file);
    const previous = cache.get(file);
    if (previous?.size === stat.size && previous?.mtime === stat.mtimeMs && now - previous.at < 5000) return previous.value;
    fd = fs.openSync(file, 'r');
    // Read backwards in bounded chunks until the last turn start is available.
    // Start with the common small tail; cap unusual long turns at 2 MiB.
    let size = Math.min(stat.size, 64 * 1024), lines;
    for (;;) {
      const buffer = Buffer.alloc(size);
      fs.readSync(fd, buffer, 0, size, stat.size - size);
      lines = buffer.toString('utf8').split('\n');
      if (size < stat.size) lines.shift(); // discard an incomplete first record
      if (size >= stat.size || size >= 2 * 1024 * 1024 || lines.some(l => {
        try { const r = JSON.parse(l); return r.type === 'event_msg' && r.payload?.type === 'task_started'; } catch { return false; }
      })) break;
      size = Math.min(stat.size, size * 2, 2 * 1024 * 1024);
    }
    const value = lifecycleStatus(lines, now);
    if (cache.size > 100) cache.clear();
    cache.set(file, { size: stat.size, mtime: stat.mtimeMs, at: now, value });
    return value;
  } catch { return { state: 'unknown' }; }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}

export function activityStatus(row, now = Date.now()) {
  if (now - Date.parse(row.updatedAt) > ACTIVITY_TTL) return { state: 'unknown', reason: 'stale', source: 'activity' };
  if (['working', 'waiting', 'idle', 'paused', 'error'].includes(row.chatStatus)) return { state: row.chatStatus, reason: row.chatStatus === 'waiting' ? 'input' : null, source: 'activity' };
  return { state: row.phase === 'start' ? 'working' : row.phase === 'finish' ? 'idle' : 'unknown', reason: null, source: 'activity' };
}
