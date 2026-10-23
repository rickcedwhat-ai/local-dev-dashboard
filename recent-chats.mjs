import { readLifecycleStatus, activityStatus } from './chat-status.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

export function chatLink(provider, id, supplied) {
  if (provider === 'codex') return `codex://threads/${encodeURIComponent(id)}`;
  // Other editors can register their verified chat links without coupling storage to an editor.
  const schemes = { cursor: 'cursor:', antigravity: 'antigravity:' };
  try { const url = new URL(supplied); return schemes[provider] === url.protocol ? url.href : null; } catch { return null; }
}

export class RecentChats {
  constructor(file) {
    this.file = file;
    try { this.rows = JSON.parse(fs.readFileSync(file, 'utf8')); if (!Array.isArray(this.rows)) this.rows = []; } catch { this.rows = []; }
    this.discovered = new Map();
    this.discovery = { state: 'loading', updatedAt: null };
  }
  record(projectId, body, now = Date.now()) {
    if (!body.chatId) return;
    const provider = String(body.agent || 'other').toLowerCase().slice(0, 80);
    const id = String(body.chatId).slice(0, 200);
    const prev = this.rows.find(r => r.projectId === projectId && r.provider === provider && r.id === id);
    const row = { projectId, provider, id, title: String(body.chatTitle || prev?.title || 'Untitled chat').slice(0, 240),
      updatedAt: new Date(now).toISOString(), pr: body.pr ?? prev?.pr ?? null, phase: body.phase, chatStatus: body.chatStatus || null, summary: String(body.summary || prev?.summary || '').slice(0, 200),
      openUrl: chatLink(provider, id, body.openUrl || prev?.openUrl) };
    this.rows = this.rows.filter(r => !(r.projectId === projectId && r.provider === provider && r.id === id));
    this.rows.push(row);
    // Bound per-project history, retaining other providers alongside Codex discovery.
    this.rows = this.rows.sort((a,b) => Date.parse(b.updatedAt)-Date.parse(a.updatedAt)).filter((r,i,all) => all.slice(0,i).filter(x => x.projectId === r.projectId).length < 30);
    fs.writeFileSync(`${this.file}.tmp`, JSON.stringify(this.rows));
    fs.renameSync(`${this.file}.tmp`, this.file);
  }
  list(projectId) {
    const merged = new Map();
    for (const row of [...(this.discovered.get(projectId) || []), ...this.rows.filter(r => r.projectId === projectId)]) {
      const key = `${row.provider}:${row.id}`;
      const prev = merged.get(key);
      if (!prev || Date.parse(row.updatedAt) >= Date.parse(prev.updatedAt)) merged.set(key, { ...row, sessionPath: row.sessionPath || prev?.sessionPath });
      else if (row.sessionPath) merged.set(key, { ...prev, sessionPath: row.sessionPath });
    }
    return [...merged.values()].sort((a,b) => Date.parse(b.updatedAt)-Date.parse(a.updatedAt)).slice(0,3)
      .map(row => {
        const { sessionPath, ...publicRow } = row;
        const status = row.provider === 'codex' && sessionPath ? readLifecycleStatus(sessionPath) : activityStatus(row);
        return { ...publicRow, status, openUrl: chatLink(row.provider, row.id, row.openUrl) };
      });
  }
}

function directoryAliases(directory) {
  const aliases = new Set([path.resolve(directory)]);
  try { aliases.add(fs.realpathSync(directory)); } catch { /* offline project */ }
  // Existing macOS registrations use both spellings of this case-insensitive folder.
  if (process.platform === 'darwin') for (const dir of [...aliases]) {
    aliases.add(dir.replace('/Documents/projects/', '/Documents/Projects/'));
    aliases.add(dir.replace('/Documents/Projects/', '/Documents/projects/'));
  }
  return [...aliases];
}

export async function discoverCodexChats(projects, { binary, timeout = 25000 } = {}) {
  const bundled = '/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex';
  const child = spawn(binary || process.env.CODEX_BIN || (fs.existsSync(bundled) ? bundled : 'codex'), ['app-server'], { stdio: ['pipe','pipe','pipe'] });
  child.stderr.resume();
  const pending = new Map(); let nextId = 0;
  const fail = error => { for (const p of pending.values()) p.reject(error); pending.clear(); };
  child.on('error', fail);
  child.on('exit', () => fail(new Error('Codex metadata service exited')));
  child.stdin.on('error', fail);
  const lines = createInterface({ input: child.stdout });
  lines.on('line', line => {
    let response; try { response = JSON.parse(line); } catch { return; }
    const p = pending.get(response.id); if (!p) return;
    pending.delete(response.id);
    if (response.error) p.reject(new Error(response.error.message)); else p.resolve(response.result);
  });
  const timer = setTimeout(() => { fail(new Error('Codex metadata request timed out')); child.kill(); }, timeout);
  const request = (method, params) => new Promise((resolve,reject) => {
    const id = ++nextId; pending.set(id,{resolve,reject}); child.stdin.write(JSON.stringify({id,method,params})+'\n');
  });
  try {
    await request('initialize', { clientInfo: { name:'local_dev_dashboard', title:'Local Dev Dashboard', version:'1.0' }, capabilities:null });
    child.stdin.write(JSON.stringify({method:'initialized'})+'\n');
    const result = new Map();
    for (const project of projects.filter(p => p.directory)) {
      const response = await request('thread/list', { cwd:directoryAliases(project.directory), limit:10, sortKey:'updated_at', archived:false, useStateDbOnly:true });
      result.set(project.id, response.data.filter(t => !t.parentThreadId && !t.ephemeral).slice(0,3).map(t => ({
        projectId:project.id, provider:'codex', id:t.id, title:t.name || t.preview?.slice(0,240) || 'Untitled chat',
        sessionPath: t.path, updatedAt:new Date(t.updatedAt*1000).toISOString(), openUrl:chatLink('codex',t.id), phase:null
      })));
    }
    return result;
  } finally { clearTimeout(timer); lines.close(); child.kill(); }
}
