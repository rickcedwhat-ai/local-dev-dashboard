import http from 'http';
import fs from 'fs';
import path from 'path';
import net from 'net';
import { fileURLToPath } from 'url';
import { spawn, exec, execSync, execFile } from 'child_process';
// --- CR Autofix (removable) ---
import * as crAutofix from './cr-autofix.mjs';
// --- end CR Autofix ---

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 4000;
const CONFIG_PATH = path.join(__dirname, 'projects.json');
const EXAMPLE_CONFIG_PATH = path.join(__dirname, 'projects.example.json');
const PUBLIC_DIR = path.join(__dirname, 'public');
const IS_WIN = process.platform === 'win32';

function buildChildEnv(extra = {}) {
  const pathKey = IS_WIN && process.env.Path && !process.env.PATH ? 'Path' : 'PATH';
  const current = process.env[pathKey] || '';
  const extras = IS_WIN
    ? []
    : ['/opt/homebrew/bin', '/opt/homebrew/sbin', '/usr/local/bin'];
  const parts = [...extras, ...current.split(path.delimiter).filter(Boolean)];
  const seen = new Set();
  const merged = parts.filter((p) => {
    if (seen.has(p)) return false;
    seen.add(p);
    return true;
  }).join(path.delimiter);

  return {
    ...process.env,
    [pathKey]: merged,
    FORCE_COLOR: '1',
    ...extra
  };
}

// State
let config = { projects: [] };
const serviceState = new Map();     // serviceId -> { child, pid, status, startTime, logs: [], sseClients: Set }
const portState = new Map();        // port -> boolean (isListening)
const portDetails = new Map();      // port -> { pid, processName, mem }
const httpHealthState = new Map();  // port -> { responsive: boolean, status: number|string }

function run(cmd) {
  return new Promise((resolve) => {
    exec(cmd, { windowsHide: true }, (err, stdout, stderr) => {
      resolve({ err, stdout: stdout || '', stderr: stderr || '' });
    });
  });
}

function killPidTree(pid) {
  const id = String(pid);
  if (IS_WIN) {
    return run(`taskkill /pid ${id} /T /F`);
  }
  // Prefer process-group kill (works when spawn used detached:true).
  return run(`kill -TERM -${id} 2>/dev/null || (pkill -TERM -P ${id}; kill -TERM ${id})`).then(async (first) => {
    await new Promise((r) => setTimeout(r, 250));
    await run(`kill -KILL -${id} 2>/dev/null || (pkill -KILL -P ${id}; kill -KILL ${id} 2>/dev/null || true)`);
    return first;
  });
}

function normalizeRepoUrl(raw) {
  if (!raw) return null;
  let url = String(raw).trim();
  if (!url) return null;

  const ssh = url.match(/^git@([^:]+):(.+)$/);
  if (ssh) {
    return `https://${ssh[1]}/${ssh[2].replace(/\.git$/, '')}`;
  }

  const sshUrl = url.match(/^ssh:\/\/git@([^/]+)\/(.+)$/);
  if (sshUrl) {
    return `https://${sshUrl[1]}/${sshUrl[2].replace(/\.git$/, '')}`;
  }

  if (/^https?:\/\//i.test(url)) {
    return url.replace(/\.git$/, '');
  }

  return url.replace(/\.git$/, '');
}

function detectRepoFromDirectory(directory) {
  try {
    if (!directory || !fs.existsSync(directory)) return null;
    const raw = execSync('git remote get-url origin', {
      cwd: directory,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 2000
    }).trim();
    return normalizeRepoUrl(raw);
  } catch {
    return null;
  }
}

const DEFAULT_MAIN_SPACE = 'Me';

/** Dashboard-wide shortcuts (billing, usage, consoles) — not tied to a project. */
const DEFAULT_GLOBAL_LINKS = [
  {
    label: 'Gemini usage',
    url: 'https://aistudio.google.com/usage',
    space: DEFAULT_MAIN_SPACE
  },
  {
    label: 'Gemini pricing',
    url: 'https://ai.google.dev/gemini-api/docs/pricing',
    space: DEFAULT_MAIN_SPACE
  },
  {
    label: 'Firebase',
    url: 'https://console.firebase.google.com/',
    space: DEFAULT_MAIN_SPACE
  },
  {
    label: 'GCP billing',
    url: 'https://console.cloud.google.com/billing',
    space: DEFAULT_MAIN_SPACE
  }
];

function sanitizeLink(raw) {
  if (!raw) return null;
  const url = String(raw.url || '').trim();
  if (!url) return null;
  const label = String(raw.label || '').trim() || labelFromUrl(url);
  const link = { label, url };
  const space = String(raw.space || '').trim();
  if (space) link.space = space;
  if (raw.pinned) link.pinned = true;
  return link;
}

function labelFromUrl(url) {
  try {
    const host = new URL(url).hostname.replace(/^www\./, '');
    const known = {
      'github.com': 'GitHub',
      'linear.app': 'Linear',
      'sentry.io': 'Sentry',
      'grafana.net': 'Grafana',
      'grafana.com': 'Grafana',
      'braintrust.dev': 'Braintrust',
      'supabase.com': 'Supabase',
      'vercel.com': 'Vercel',
      'console.firebase.google.com': 'Firebase',
      'console.cloud.google.com': 'Google Cloud'
    };
    if (known[host]) return known[host];
    for (const [domain, name] of Object.entries(known)) {
      if (host.endsWith(`.${domain}`)) return name;
    }
    const base = host.split('.')[0] || host;
    return base.charAt(0).toUpperCase() + base.slice(1);
  } catch {
    return 'Link';
  }
}

// repo/liveUrl stay on disk as aliases of the GitHub/Live entries so avatar
// derivation, register.mjs, and git auto-detection keep working unchanged.
function syncLegacyLinkFields(proj) {
  const gh = proj.links.find((l) => /github\.com/i.test(l.url));
  const live = proj.links.find((l) => l.label.toLowerCase() === 'live');
  if (gh) proj.repo = gh.url; else delete proj.repo;
  if (live) proj.liveUrl = live.url; else delete proj.liveUrl;
}

function enrichProjectLinks(proj) {
  const before = JSON.stringify([proj.links, proj.repo, proj.liveUrl, proj.defaultArcSpace]);

  // One-time migration: fold legacy repo/liveUrl into the links array. After
  // this runs, links is the source of truth and repo is never re-detected.
  if (!Array.isArray(proj.links)) {
    const repo = normalizeRepoUrl(proj.repo) || detectRepoFromDirectory(proj.directory);
    const links = [];
    if (repo) links.push({ label: 'GitHub', url: repo, pinned: true });
    if (proj.liveUrl) links.push({ label: 'Live', url: String(proj.liveUrl).trim(), pinned: true });
    proj.links = links;
  }

  proj.links = proj.links.map(sanitizeLink).filter(Boolean);
  for (const link of proj.links) {
    if (/github\.com/i.test(link.url)) link.url = normalizeRepoUrl(link.url) || link.url;
  }

  if (proj.arcSpace) {
    if (!proj.defaultArcSpace) proj.defaultArcSpace = proj.arcSpace;
    delete proj.arcSpace;
  }

  syncLegacyLinkFields(proj);
  return JSON.stringify([proj.links, proj.repo, proj.liveUrl, proj.defaultArcSpace]) !== before;
}

function enrichGlobalLinks() {
  if (!Array.isArray(config.globalLinks)) {
    config.globalLinks = DEFAULT_GLOBAL_LINKS.map((l) => ({ ...l }));
    return true;
  }
  const cleaned = config.globalLinks.map(sanitizeLink).filter(Boolean);
  const before = JSON.stringify(config.globalLinks);
  config.globalLinks = cleaned;
  return JSON.stringify(cleaned) !== before;
}

function loadConfig() {
  try {
    if (!fs.existsSync(CONFIG_PATH) && fs.existsSync(EXAMPLE_CONFIG_PATH)) {
      fs.copyFileSync(EXAMPLE_CONFIG_PATH, CONFIG_PATH);
    }
    const raw = fs.readFileSync(CONFIG_PATH, 'utf-8');
    config = JSON.parse(raw);
    let configChanged = false;
    if (typeof config.defaultArcSpace !== 'string') {
      config.defaultArcSpace = DEFAULT_MAIN_SPACE;
      configChanged = true;
    }
    if (enrichGlobalLinks()) configChanged = true;
    for (const proj of config.projects) {
      if (enrichProjectLinks(proj)) configChanged = true;
      for (const s of proj.services) {
        if (!serviceState.has(s.id)) {
          serviceState.set(s.id, {
            child: null,
            pid: null,
            status: 'stopped',
            startTime: null,
            logs: [],
            sseClients: new Set()
          });
        }
      }
    }
    if (configChanged) {
      fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf-8');
    }
  } catch (err) {
    console.error('Failed to load projects.json:', err.message);
  }
}

loadConfig();
fs.watchFile(CONFIG_PATH, { interval: 1000 }, () => {
  loadConfig();
});

function appendLog(serviceId, text) {
  const state = serviceState.get(serviceId);
  if (!state) return;
  const lines = text.toString().split(/\r?\n/);
  for (const line of lines) {
    if (line.length === 0) continue;
    state.logs.push(line);
    if (state.logs.length > 500) {
      state.logs.shift();
    }
    for (const res of state.sseClients) {
      res.write(`data: ${JSON.stringify({ line })}\n\n`);
    }
  }
}

function probeHost(port, host) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    socket.setTimeout(350);

    socket.on('connect', () => {
      socket.destroy();
      resolve(true);
    });

    socket.on('timeout', () => {
      socket.destroy();
      resolve(false);
    });

    socket.on('error', () => {
      socket.destroy();
      resolve(false);
    });

    socket.connect(port, host);
  });
}

async function probePort(port) {
  if (await probeHost(port, '127.0.0.1')) return true;
  if (await probeHost(port, '::1')) return true;
  return false;
}

async function inspectPortProcess(port) {
  if (IS_WIN) {
    const { err, stdout } = await run(`netstat -ano | findstr LISTENING | findstr :${port}`);
    if (err || !stdout.trim()) {
      portDetails.delete(port);
      return null;
    }
    let foundPid = null;
    for (const line of stdout.trim().split('\n')) {
      const parts = line.trim().split(/\s+/);
      const pid = parts[parts.length - 1];
      if (pid && pid !== '0' && !isNaN(pid)) {
        foundPid = pid;
        break;
      }
    }
    if (!foundPid) {
      portDetails.delete(port);
      return null;
    }

    const { err: tErr, stdout: tOut } = await run(`tasklist /FI "PID eq ${foundPid}" /FO CSV /NH`);
    if (tErr || !tOut.trim()) {
      const detail = { pid: foundPid, processName: 'node.exe', mem: '' };
      portDetails.set(port, detail);
      return detail;
    }
    const clean = tOut.trim().replace(/"/g, '');
    const fields = clean.split(',');
    const detail = {
      pid: foundPid,
      processName: fields[0] || 'node.exe',
      mem: fields[4] || ''
    };
    portDetails.set(port, detail);
    return detail;
  }

  const { err, stdout } = await run(`lsof -nP -iTCP:${port} -sTCP:LISTEN`);
  if (err || !stdout.trim()) {
    portDetails.delete(port);
    return null;
  }

  let foundPid = null;
  let processName = 'node';
  for (const line of stdout.trim().split('\n')) {
    if (line.startsWith('COMMAND')) continue;
    const parts = line.trim().split(/\s+/);
    if (parts.length < 2) continue;
    const pid = parts[1];
    if (pid && pid !== '0' && !isNaN(pid)) {
      foundPid = pid;
      processName = parts[0] || 'node';
      break;
    }
  }

  if (!foundPid) {
    portDetails.delete(port);
    return null;
  }

  const { stdout: rssOut } = await run(`ps -o rss= -p ${foundPid}`);
  const rssKb = parseInt(String(rssOut).trim(), 10);
  const mem = Number.isFinite(rssKb) ? `${Math.round(rssKb / 1024)} K` : '';
  const detail = { pid: foundPid, processName, mem };
  portDetails.set(port, detail);
  return detail;
}

function checkHttpHealth(port) {
  return new Promise((resolve) => {
    const req = http.get(`http://127.0.0.1:${port}`, { timeout: 1000 }, (res) => {
      res.resume();
      const info = { responsive: true, status: res.statusCode };
      httpHealthState.set(port, info);
      resolve(info);
    });

    req.on('timeout', () => {
      req.destroy();
      const req6 = http.get(`http://[::1]:${port}`, { timeout: 1000 }, (res6) => {
        res6.resume();
        const info = { responsive: true, status: res6.statusCode };
        httpHealthState.set(port, info);
        resolve(info);
      });
      req6.on('timeout', () => {
        req6.destroy();
        const info = { responsive: false, status: 'TIMEOUT' };
        httpHealthState.set(port, info);
        resolve(info);
      });
      req6.on('error', (e) => {
        const info = { responsive: false, status: e.code || 'ERR' };
        httpHealthState.set(port, info);
        resolve(info);
      });
    });

    req.on('error', () => {
      const req6 = http.get(`http://[::1]:${port}`, { timeout: 1000 }, (res6) => {
        res6.resume();
        const info = { responsive: true, status: res6.statusCode };
        httpHealthState.set(port, info);
        resolve(info);
      });
      req6.on('timeout', () => {
        req6.destroy();
        const info = { responsive: false, status: 'TIMEOUT' };
        httpHealthState.set(port, info);
        resolve(info);
      });
      req6.on('error', (e) => {
        const info = { responsive: false, status: e.code || 'ERR' };
        httpHealthState.set(port, info);
        resolve(info);
      });
    });
  });
}

async function updatePortStatuses() {
  const portsToCheck = new Set();
  for (const proj of config.projects) {
    for (const s of proj.services) {
      if (s.port) portsToCheck.add(s.port);
    }
  }

  for (const p of portsToCheck) {
    const open = await probePort(p);
    portState.set(p, open);
    if (open) {
      inspectPortProcess(p).catch(() => {});
      checkHttpHealth(p).catch(() => {});
    } else {
      portDetails.delete(p);
      httpHealthState.delete(p);
    }
  }
}

// Background port polling
setInterval(updatePortStatuses, 2500);
updatePortStatuses();

// GitHub insights: staggered REST is the durable path (open PRs + CI).
// One repo per tick ≈ 30s full cycle across ~7 projects — feels live without
 // bursting. GraphQL is optional CR enrichment and backs off hard when throttled.
const GH_STAGGER_MS = 4000;
const GH_REST_BACKOFF_MS = 120000;
const GH_GRAPHQL_BACKOFF_MS = 300000;
const openPrCounts = new Map();
const ciStateBySlug = new Map(); // slug -> 'failing' | 'running' | 'passing'
const crBySlug = new Map(); // slug -> { state, actionable, openPrs, isPrivate, tip, limitedUntil, limitedSince, prUrl, prNumber }
/** Per open PR for the sidebar detail UI: [{ number, title, url, ci, cr }] */
const prsBySlug = new Map();
const rateLimitMemory = new Map(); // slug -> { until, since, isPrivate, prUrl }
let rateLimitBanner = { private: null, oss: null }; // { until, since } | null
let ghUnavailable = false;
let ghRefreshInFlight = false;
let ghRestNextAt = 0;
let ghGraphqlNextAt = 0;
let ghStaggerIndex = 0;
/** Cached `gh api user` login — used by the UI to scope notifications to “my” PRs. */
let githubLogin = null;
let githubLoginFetchedAt = 0;

const CR_AUTHOR = /^coderabbitai(\[bot\])?$/i;
const STATE_RANK = {
  // --- CR Autofix (removable): autofixing / delivery / leftover ---
  autofixing: 7,
  delivery: 7,
  leftover: 6,
  // --- end CR Autofix ---
  actionable: 6,
  reviewing: 5,
  ready: 4,
  limited: 3,
  pending: 2,
  clear: 1,
  empty: 0
};

// Local git snapshot (branch / dirty / ahead / recent commits) per project.
const GIT_REFRESH_MS = 5000;
const gitStateByProject = new Map();

// Agent activity (LLM start/finish on a project/PR) + protocol handshake.
const AGENT_PROTOCOL_VERSION = 2;
const AGENT_IDLE_MS = 45 * 60 * 1000;
const agentActivityByProject = new Map(); // projectId -> session

function readAgentInstructions() {
  try {
    return fs.readFileSync(path.join(__dirname, 'AGENT_INSTRUCTIONS.md'), 'utf8');
  } catch {
    return '';
  }
}

function protocolPayload(clientProtocol) {
  const current = AGENT_PROTOCOL_VERSION;
  const client = Number(clientProtocol);
  const stale = !Number.isFinite(client) || client < current;
  const protocolUrl = 'http://localhost:4000/api/agent-protocol';
  const payload = {
    protocol: current,
    stale,
    protocolUrl
  };
  if (stale) {
    payload.message = `Dashboard protocol is v${current}; client sent ${clientProtocol ?? 'none'}. GET ${protocolUrl}, save instructions to AGENTS.md, then retry with "protocol": ${current}.`;
  }
  return payload;
}

function resolveProjectForAgent(body = {}) {
  const { projectId, directory, repo, name } = body;
  if (projectId) {
    const byId = config.projects.find((p) => p.id === projectId);
    if (byId) return byId;
  }
  if (directory) {
    const dir = path.resolve(String(directory));
    const byDir = config.projects.find((p) => path.resolve(p.directory || '') === dir);
    if (byDir) return byDir;
  }
  if (repo) {
    const slug = parseRepoSlug(normalizeRepoUrl(repo) || repo);
    if (slug) {
      const byRepo = config.projects.find((p) => {
        const s = parseRepoSlug(p.repo);
        return s && s.slug === slug.slug;
      });
      if (byRepo) return byRepo;
    }
  }
  if (name) {
    const needle = String(name).toLowerCase();
    const byName = config.projects.find((p) =>
      p.name?.toLowerCase() === needle || p.id === needle
    );
    if (byName) return byName;
  }
  return null;
}

function getAgentActivity(projectId) {
  const activity = agentActivityByProject.get(projectId);
  if (!activity) return null;
  if (activity.phase === 'start' && Date.now() - activity.updatedAt > AGENT_IDLE_MS) {
    agentActivityByProject.delete(projectId);
    return null;
  }
  if (activity.phase !== 'start') return null;
  return {
    working: true,
    summary: activity.summary || null,
    pr: activity.pr || null,
    agent: activity.agent || null,
    startedAt: new Date(activity.startedAt).toISOString(),
    updatedAt: new Date(activity.updatedAt).toISOString()
  };
}

function setAgentActivity(projectId, body) {
  const phase = String(body.phase || '').toLowerCase();
  if (phase !== 'start' && phase !== 'finish') {
    throw new Error('phase must be "start" or "finish"');
  }
  const now = Date.now();
  if (phase === 'finish') {
    agentActivityByProject.delete(projectId);
    return { working: false };
  }
  const prev = agentActivityByProject.get(projectId);
  agentActivityByProject.set(projectId, {
    phase: 'start',
    summary: body.summary ? String(body.summary).slice(0, 200) : (prev?.summary || null),
    pr: body.pr != null ? (Number(body.pr) || String(body.pr)) : (prev?.pr || null),
    agent: body.agent ? String(body.agent).slice(0, 80) : (prev?.agent || null),
    startedAt: prev?.phase === 'start' ? prev.startedAt : now,
    updatedAt: now,
    protocol: Number(body.protocol) || AGENT_PROTOCOL_VERSION
  });
  return getAgentActivity(projectId);
}

setInterval(() => {
  const now = Date.now();
  for (const [id, activity] of agentActivityByProject) {
    if (activity.phase === 'start' && now - activity.updatedAt > AGENT_IDLE_MS) {
      agentActivityByProject.delete(id);
    }
  }
}, 60000);

function parseRepoSlug(repoUrl) {
  const match = /github\.com\/([^/]+)\/([^/#?]+)/i.exec(String(repoUrl || ''));
  if (!match) return null;
  const owner = match[1];
  const name = match[2].replace(/\.git$/, '');
  // Guard against anything odd in projects.json reaching the GraphQL document.
  if (!/^[\w.-]+$/.test(owner) || !/^[\w.-]+$/.test(name)) return null;
  return { owner, name, slug: `${owner}/${name}` };
}

function isCrAuthor(login) {
  return CR_AUTHOR.test(String(login || ''));
}

/** CR sometimes finishes with 0 findings only in the evergreen summarize comment
 *  (no Pull Request Review, no reviewThreads). Treat that as clear. */
function crFinishedClearFromText(body) {
  const text = String(body || '');
  if (/No actionable comments were generated in the recent review/i.test(text)) return true;
  const m = text.match(/Actionable comments posted:\s*(\d+)/i);
  return !!(m && parseInt(m[1], 10) === 0);
}

function isRateLimitSignal(text) {
  const body = String(text || '');
  // Do NOT treat CodeRabbit's success footer
  // "…up to N included reviews per hour; 0 remain after this review" as a block —
  // that is quota accounting after a completed review, not an active rate limit.
  return /rate\s*limit/i.test(body)
    || /review\s+limit\s+reached/i.test(body)
    || /next\s+included\s+review\s+available/i.test(body)
    || /(?:no|out\s+of)\s+free\s+(?:OSS\s+)?reviews?/i.test(body)
    || /free\s+(?:OSS\s+)?reviews?\s+for\s+now/i.test(body)
    || /(?:available|ready|resets?|try\s+again)\s+in\s+\d+\s*(?:minutes?|mins?|hours?|hrs?)/i.test(body)
    // "0 reviews remaining" (blocked) — not "0 remain after this review" (success footer).
    || /(?:^|[^\d])0\s+reviews?\s+remaining\b/i.test(body);
}

/** Prefer explicit relative countdowns over clock times over +1h fallback. */
function pickBestRateWindow(candidates) {
  const rank = { relative: 3, clock: 2, hourly: 1, fallback: 0 };
  let best = null;
  for (const w of candidates) {
    if (!w?.until) continue;
    if (!best) {
      best = w;
      continue;
    }
    const ra = rank[w.quality] ?? 0;
    const rb = rank[best.quality] ?? 0;
    if (ra > rb) {
      best = w;
      continue;
    }
    if (ra === rb && new Date(w.until).getTime() < new Date(best.until).getTime()) {
      // Same quality: earlier unlock is usually the fresher countdown.
      best = w;
    }
  }
  return best;
}

function parseRateLimitWindow(text, at) {
  const body = String(text || '');
  if (!isRateLimitSignal(body)) return null;
  const since = at ? new Date(at) : new Date();
  if (Number.isNaN(since.getTime())) return null;

  // Prefer "available in 49 minutes" (CodeRabbit summarize edit) over a bare "in N …".
  const availableIn = body.match(
    /(?:available|ready|resets?|try\s+again)\s+in\s+(\d+)\s*(minutes?|mins?|hours?|hrs?)/i
  ) || body.match(/\bin\s+(\d+)\s*(minutes?|mins?|hours?|hrs?)\b/i);
  if (availableIn) {
    const n = parseInt(availableIn[1], 10);
    const unit = availableIn[2].toLowerCase();
    const ms = /hour|hr/.test(unit) ? n * 3600000 : n * 60000;
    return {
      quality: 'relative',
      since: since.toISOString(),
      until: new Date(since.getTime() + ms).toISOString()
    };
  }

  const untilAt = body.match(/(?:until|again\s+at|available\s+at|after)\s+(\d{1,2}:\d{2}\s*(?:AM|PM)?)/i);
  if (untilAt) {
    const until = parseLooseTimeOnDay(untilAt[1], since);
    if (until) {
      const start = new Date(until.getTime() - 3600000);
      return {
        quality: 'clock',
        since: (start > since ? since : start).toISOString(),
        until: until.toISOString()
      };
    }
  }

  // "up to 1 included review per hour; 0 remain" — only when not the success
  // footer ("0 remain after this review"), which is quota accounting.
  const perHour = body.match(
    /up\s+to\s+(\d+)\s+included\s+reviews?\s+per\s+hour[^;]*;\s*0\s+remain(?!\s+after\s+this\s+review)/i
  );
  if (perHour) {
    const n = Math.max(1, parseInt(perHour[1], 10) || 1);
    return {
      quality: 'hourly',
      since: since.toISOString(),
      until: new Date(since.getTime() + n * 3600000).toISOString()
    };
  }

  // Last resort: rolling ~1h window from this signal (often a short "rate limited" reply).
  return {
    quality: 'fallback',
    since: since.toISOString(),
    until: new Date(since.getTime() + 3600000).toISOString()
  };
}

function collectRateLimitWindows({ comments = [], reviews = [] }) {
  const candidates = [];
  for (const c of comments) {
    const at = c.updatedAt || c.updated_at || c.createdAt || c.created_at;
    const w = parseRateLimitWindow(c.body, at);
    if (w) candidates.push(w);
  }
  for (const r of reviews) {
    const at = r.submittedAt || r.submitted_at;
    const w = parseRateLimitWindow(r.body, at);
    if (w) candidates.push(w);
  }
  return pickBestRateWindow(candidates);
}

function parseLooseTimeOnDay(raw, relativeTo) {
  const m = String(raw).trim().match(/^(\d{1,2}):(\d{2})\s*(AM|PM)?$/i);
  if (!m) return null;
  let hour = parseInt(m[1], 10);
  const minute = parseInt(m[2], 10);
  const ampm = m[3] ? m[3].toUpperCase() : null;
  if (ampm === 'PM' && hour < 12) hour += 12;
  if (ampm === 'AM' && hour === 12) hour = 0;
  const d = new Date(relativeTo);
  d.setHours(hour, minute, 0, 0);
  if (d.getTime() < relativeTo.getTime() - 60000) d.setDate(d.getDate() + 1);
  return d;
}

function isCrAppLabel(value) {
  return /coderabbit/i.test(String(value || ''));
}

/**
 * Live "Review in progress" signal matching the GitHub Checks UI.
 * Prefer commit status context ("CodeRabbit" / pending) over bare queued suites
 * (those can linger after the review finishes).
 */
function crLiveReviewing({
  suites = [],
  checkRuns = [],
  statuses = [],
  comments = [],
  reviews = []
} = {}) {
  const now = Date.now();

  let crStatusCompleted = false;
  for (const s of statuses) {
    const ctx = s.context || '';
    if (!isCrAppLabel(ctx)) continue;
    const state = String(s.state || '').toLowerCase();
    const desc = String(s.description || '');
    // Terminal CodeRabbit statuses (completed, skipped, failed, …) — never
    // “reviewing”, even if a queued check-suite shell is still hanging around.
    if (state === 'success' || state === 'failure' || state === 'error') {
      crStatusCompleted = true;
      continue;
    }
    if (state === 'pending' || state === 'expected') {
      // Pending with an explicit skip/complete message is still odd; prefer text.
      if (/skipped|manual review required|completed|finished/i.test(desc)) {
        crStatusCompleted = true;
        continue;
      }
      return true;
    }
    if (/review in progress|waiting for status|generating review/i.test(desc)) return true;
  }

  for (const run of checkRuns) {
    const label = `${run.app?.slug || ''} ${run.app?.name || ''} ${run.name || ''} ${run.title || ''} ${run.output?.title || ''}`;
    if (!isCrAppLabel(label) && !/review in progress/i.test(label)) continue;
    const st = String(run.status || '').toUpperCase();
    if (st === 'IN_PROGRESS' || st === 'QUEUED' || st === 'WAITING' || st === 'PENDING' || st === 'REQUESTED') {
      return true;
    }
    if (/review in progress|waiting for status/i.test(label)) return true;
  }

  for (const suite of suites) {
    const app = suite.app?.slug || suite.app?.name || '';
    if (!isCrAppLabel(app)) continue;
    const st = String(suite.status || '').toUpperCase().replace(/-/g, '_');
    if (st === 'IN_PROGRESS') return true;

    // QUEUED alone is weak (shells linger). Use it only while fresh and when
    // CodeRabbit has not already posted a completed status context.
    if (!crStatusCompleted && !suite.conclusion && (st === 'QUEUED' || st === 'REQUESTED' || st === 'WAITING' || st === 'PENDING')) {
      const updated = new Date(
        suite.updated_at || suite.updatedAt || suite.created_at || suite.createdAt || 0
      ).getTime();
      if (updated && now - updated < 45 * 60 * 1000) return true;
    }

    for (const run of suite.checkRuns?.nodes || suite.check_runs || []) {
      const rst = String(run.status || '').toUpperCase();
      const title = `${run.name || ''} ${run.title || ''}`;
      if (rst === 'IN_PROGRESS' || rst === 'QUEUED' || rst === 'WAITING' || rst === 'PENDING') return true;
      if (/review in progress|waiting for status/i.test(title)) return true;
    }
  }

  // Explicit in-progress issue comments (ignore evergreen summarize widgets).
  for (const c of comments) {
    const body = c.body || '';
    if (!/review in progress by coderabbit/i.test(body)) continue;
    if (/summarize by coderabbit\.ai/i.test(body)) continue;
    const at = new Date(c.updatedAt || c.updated_at || c.createdAt || c.created_at || 0).getTime();
    const reviewAfter = reviews.some((r) => {
      const submitted = new Date(r.submittedAt || r.submitted_at || 0).getTime();
      return submitted >= at - 2000;
    });
    if (!reviewAfter) return true;
  }

  return false;
}

function reviewingCrResult(prUrl, prNumber, isPrivate) {
  return {
    state: 'reviewing',
    actionable: 0,
    tip: 'CodeRabbit review in progress',
    detail: 'Results will land on the PR shortly',
    limitedUntil: null,
    limitedSince: null,
    isPrivate,
    prUrl,
    prNumber
  };
}

function classifyPullRequestCr(pr, isPrivate) {
  const threads = pr.reviewThreads?.nodes || [];
  let actionable = 0;
  for (const t of threads) {
    if (t.isResolved) continue;
    const author = t.comments?.nodes?.[0]?.author?.login;
    if (isCrAuthor(author)) actionable++;
  }

  const reviews = (pr.reviews?.nodes || []).filter((r) => isCrAuthor(r.author?.login));
  const comments = (pr.comments?.nodes || []).filter((c) => isCrAuthor(c.author?.login));

  // reviews(last: N) / comments(last: N) return chronological order; take newest.
  const newestReview = reviews.length ? reviews[reviews.length - 1] : null;
  const newestComment = comments.length ? comments[comments.length - 1] : null;

  const commit = pr.commits?.nodes?.[0]?.commit;
  const checkSuites = commit?.checkSuites?.nodes || [];
  const statuses = commit?.status?.contexts || [];

  // Rate limit: check runs + CR comments/reviews (prefer explicit countdowns).
  let rateWindow = collectRateLimitWindows({ comments, reviews });
  for (const suite of checkSuites) {
    for (const run of suite.checkRuns?.nodes || []) {
      const label = `${run.name || ''} ${run.title || ''}`;
      if (/rate\s*limit/i.test(label)) {
        rateWindow = pickBestRateWindow([
          rateWindow,
          parseRateLimitWindow(label, new Date().toISOString())
            || {
              quality: 'fallback',
              since: new Date(Date.now() - 3600000).toISOString(),
              until: new Date(Date.now() + 900000).toISOString()
            }
        ].filter(Boolean));
      }
    }
  }

  const now = Date.now();
  if (rateWindow) {
    const untilMs = new Date(rateWindow.until).getTime();
    if (untilMs > now) {
      return {
        state: 'limited',
        actionable: 0,
        tip: 'Review rate-limited',
        detail: `Capacity returns at ${formatClock(rateWindow.until)}`,
        limitedUntil: rateWindow.until,
        limitedSince: rateWindow.since,
        limitQuality: rateWindow.quality || 'fallback',
        isPrivate,
        prUrl: pr.url,
        prNumber: pr.number
      };
    }
  }

  // Live check/status beats stale clear/actionable from an earlier review cycle.
  if (crLiveReviewing({ suites: checkSuites, statuses, comments, reviews })) {
    return reviewingCrResult(pr.url, pr.number, isPrivate);
  }

  if (actionable > 0) {
    return {
      state: 'actionable',
      actionable,
      tip: `${actionable} actionable comment${actionable > 1 ? 's' : ''}`,
      detail: 'CodeRabbit left feedback to address',
      limitedUntil: null,
      limitedSince: null,
      isPrivate,
      prUrl: pr.url,
      prNumber: pr.number
    };
  }

  // Finished cleanly with no formal review / threads (summarize widget only).
  if (
    [...comments, ...reviews].some((x) => crFinishedClearFromText(x.body))
  ) {
    return {
      state: 'clear',
      actionable: 0,
      tip: 'Good to go',
      detail: 'No unresolved CodeRabbit comments',
      limitedUntil: null,
      limitedSince: null,
      isPrivate,
      prUrl: pr.url,
      prNumber: pr.number
    };
  }

  // Soft in-progress from recent invocation without a finished review yet.
  const crThreadCount = threads.filter((t) =>
    isCrAuthor(t.comments?.nodes?.[0]?.author?.login)
  ).length;
  const threadsSettled = crThreadCount > 0 && actionable === 0;

  let reviewing = false;
  if (!threadsSettled) {
    const recentCr = newestComment || newestReview;
    if (recentCr) {
      const body = newestComment?.body || newestReview?.body || '';
      const at = new Date(
        newestComment?.updatedAt || newestComment?.createdAt || newestReview?.submittedAt || 0
      ).getTime();
      const age = now - at;
      const finished = /Actionable comments posted/i.test(newestReview?.body || '')
        || /Review finished/i.test(body)
        || /No actionable comments were generated in the recent review/i.test(body);
      const reviewAfter = newestReview && new Date(newestReview.submittedAt).getTime() >= at - 2000;
      if (
        !finished
        && !reviewAfter
        && age < 45 * 60 * 1000
        && /review command invocation|review_stack_entry_start|generating review|on it/i.test(body)
        && !/summarize by coderabbit\.ai/i.test(body)
      ) {
        reviewing = true;
      }
    }
  }

  if (reviewing) {
    return reviewingCrResult(pr.url, pr.number, isPrivate);
  }

  // reviews(last: N) can be all human replies after a busy thread — still treat
  // resolved CR reviewThreads as "clear" even when no CR review is in that window.
  if (newestReview || reviews.length || crThreadCount > 0) {
    return {
      state: 'clear',
      actionable: 0,
      tip: 'Good to go',
      detail: 'No unresolved CodeRabbit comments',
      limitedUntil: null,
      limitedSince: null,
      isPrivate,
      prUrl: pr.url,
      prNumber: pr.number
    };
  }

  return {
    state: 'pending',
    actionable: 0,
    tip: 'Waiting on CodeRabbit',
    detail: 'Review hasn’t started yet',
    limitedUntil: null,
    limitedSince: null,
    isPrivate,
    prUrl: pr.url,
    prNumber: pr.number
  };
}

function formatClock(iso) {
  try {
    return new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  } catch {
    return iso;
  }
}

function classifyCiFromRollup(state) {
  if (!state) return null;
  if (state === 'FAILURE' || state === 'ERROR') return 'failing';
  if (state === 'PENDING' || state === 'EXPECTED') return 'running';
  if (state === 'SUCCESS') return 'passing';
  return null;
}

// Aggregate open-PR CI from statusCheckRollup (matches the PR checks UI).
function classifyRepoCi(prNodes) {
  let sawPassing = false;
  let sawRunning = false;
  for (const pr of prNodes || []) {
    const state = pr?.commits?.nodes?.[0]?.commit?.statusCheckRollup?.state;
    const one = classifyCiFromRollup(state);
    if (one === 'failing') return 'failing';
    if (one === 'running') sawRunning = true;
    else if (one === 'passing') sawPassing = true;
  }
  if (sawRunning) return 'running';
  if (sawPassing) return 'passing';
  return null;
}

function thinCrForPr(cr) {
  if (!cr) return { state: 'pending', actionable: 0 };
  return {
    state: cr.state || 'pending',
    actionable: Number(cr.actionable) || 0,
    tip: cr.tip || null,
    detail: cr.detail || null,
    limitedUntil: cr.limitedUntil || null,
    limitedSince: cr.limitedSince || null,
    limitQuality: cr.limitQuality || null,
    prUrl: cr.prUrl || null,
    prNumber: cr.prNumber || null,
    fill: cr.fill ?? null,
    autofix: cr.autofix || null,
    taskUrl: cr.taskUrl || null
  };
}

function buildPrsList(pulls, { ciByNumber, crByNumber } = {}) {
  return (pulls || []).slice(0, 10).map((p) => {
    const n = p.number;
    const cr = crByNumber?.get?.(n) || null;
    const user = p.user || p.author || null;
    const login = user?.login || user?.name || null;
    return {
      number: n,
      title: p.title || `PR #${n}`,
      url: p.html_url || p.url || null,
      ci: ciByNumber?.get?.(n) ?? null,
      cr: thinCrForPr(cr),
      author: login
        ? {
            login,
            avatarUrl: user.avatar_url || user.avatarUrl
              || `https://github.com/${login}.png?size=64`
          }
        : null
    };
  });
}

function setPrsForSlug(slug, pulls, opts) {
  if (!pulls?.length) {
    prsBySlug.set(slug, []);
    return;
  }
  prsBySlug.set(slug, buildPrsList(pulls, opts));
}

function aggregateCiFromMap(ciByNumber) {
  let sawPassing = false;
  let sawRunning = false;
  for (const ci of ciByNumber.values()) {
    if (ci === 'failing') return 'failing';
    if (ci === 'running') sawRunning = true;
    else if (ci === 'passing') sawPassing = true;
  }
  if (sawRunning) return 'running';
  if (sawPassing) return 'passing';
  return null;
}

function mergeCrStates(perPr, openCount, isPrivate, slug) {
  if (!openCount) {
    rateLimitMemory.delete(slug);
    return {
      state: 'empty',
      actionable: 0,
      openPrs: 0,
      isPrivate,
      tip: null,
      detail: null,
      limitedUntil: null,
      limitedSince: null,
      prUrl: null,
      prNumber: null,
      fill: null
    };
  }

  let best = null;
  let actionableTotal = 0;
  for (const s of perPr) {
    actionableTotal += s.actionable || 0;
    if (!best || STATE_RANK[s.state] > STATE_RANK[best.state]) best = s;
    if (s.state === 'limited' && s.limitedUntil) {
      rateLimitMemory.set(slug, {
        until: s.limitedUntil,
        since: s.limitedSince,
        quality: s.limitQuality || 'fallback',
        isPrivate,
        prUrl: s.prUrl
      });
    }
  }

  // Capacity restored but still no fresh review → ready (nudge to trigger).
  const mem = rateLimitMemory.get(slug);
  if (mem && best && best.state !== 'limited' && best.state !== 'actionable' && best.state !== 'reviewing' && best.state !== 'clear') {
    const untilMs = new Date(mem.until).getTime();
    if (untilMs <= Date.now()) {
      best = {
        state: 'ready',
        actionable: 0,
        tip: 'Capacity restored',
        detail: 'Trigger a CodeRabbit review on the PR',
        limitedUntil: mem.until,
        limitedSince: mem.since,
        isPrivate,
        prUrl: mem.prUrl || best.prUrl,
        prNumber: best.prNumber
      };
    }
  }
  if (best?.state === 'clear' || best?.state === 'actionable' || best?.state === 'reviewing') {
    rateLimitMemory.delete(slug);
  }

  if (!best) {
    best = {
      state: 'pending',
      actionable: 0,
      tip: 'Waiting on CodeRabbit',
      detail: 'Review hasn’t started yet',
      isPrivate,
      prUrl: null,
      prNumber: null
    };
  }

  let fill = null;
  if (best.state === 'limited' && best.limitedUntil && best.limitedSince) {
    const a = new Date(best.limitedSince).getTime();
    const b = new Date(best.limitedUntil).getTime();
    fill = Math.max(0, Math.min(1, (Date.now() - a) / Math.max(1, b - a)));
  }

  return {
    state: best.state,
    actionable: (best.state === 'autofixing' || best.state === 'reviewing') ? 0 : actionableTotal,
    openPrs: openCount,
    isPrivate,
    tip: best.tip,
    detail: best.detail,
    limitedUntil: best.limitedUntil || null,
    limitedSince: best.limitedSince || null,
    limitQuality: best.limitQuality || null,
    prUrl: best.prUrl || null,
    prNumber: best.prNumber || null,
    fill,
    // --- CR Autofix (removable) ---
    autofix: best.autofix || null,
    taskUrl: best.taskUrl || null
    // --- end CR Autofix ---
  };
}

function rebuildRateLimitBanner() {
  let privateWin = null;
  let ossWin = null;
  const rank = { relative: 3, clock: 2, hourly: 1, fallback: 0 };
  const consider = (bucket, next) => {
    if (!next?.until) return;
    const untilMs = new Date(next.until).getTime();
    if (untilMs <= Date.now()) return;
    const cur = bucket === 'private' ? privateWin : ossWin;
    if (!cur) {
      if (bucket === 'private') privateWin = next;
      else ossWin = next;
      return;
    }
    const rc = rank[cur.quality] ?? 0;
    const rn = rank[next.quality] ?? 0;
    // Prefer explicit countdowns over +1h guesses; same quality → later unlock.
    let take = false;
    if (rn > rc) take = true;
    else if (rn === rc && untilMs > new Date(cur.until).getTime()) take = true;
    if (take) {
      if (bucket === 'private') privateWin = next;
      else ossWin = next;
    }
  };

  for (const [, mem] of rateLimitMemory) {
    consider(mem.isPrivate ? 'private' : 'oss', {
      until: mem.until,
      since: mem.since,
      quality: mem.quality || 'fallback'
    });
  }
  for (const [, cr] of crBySlug) {
    if (cr.state !== 'limited' || !cr.limitedUntil) continue;
    consider(cr.isPrivate ? 'private' : 'oss', {
      until: cr.limitedUntil,
      since: cr.limitedSince,
      quality: cr.limitQuality || 'fallback'
    });
  }
  rateLimitBanner = { private: privateWin, oss: ossWin };
}

function gitExec(dir, args) {
  return new Promise((resolve) => {
    execFile('git', args, {
      cwd: dir,
      timeout: 4000,
      env: buildChildEnv(),
      maxBuffer: 512 * 1024
    }, (err, stdout) => {
      if (err) resolve(null);
      else resolve(String(stdout || '').trim());
    });
  });
}

async function refreshGitStateForProject(proj) {
  const dir = proj.directory;
  if (!dir || !fs.existsSync(path.join(dir, '.git'))) {
    gitStateByProject.delete(proj.id);
    return;
  }

  const [branch, porcelain, aheadBehind, log] = await Promise.all([
    gitExec(dir, ['rev-parse', '--abbrev-ref', 'HEAD']),
    gitExec(dir, ['status', '--porcelain']),
    gitExec(dir, ['rev-list', '--left-right', '--count', '@{u}...HEAD']),
    gitExec(dir, ['log', '-3', '--format=%cr\t%s'])
  ]);

  if (!branch) {
    gitStateByProject.delete(proj.id);
    return;
  }

  const dirty = porcelain ? porcelain.split('\n').filter(Boolean).length : 0;
  let behind = 0;
  let ahead = 0;
  if (aheadBehind) {
    const parts = aheadBehind.split(/\s+/);
    behind = parseInt(parts[0], 10) || 0;
    ahead = parseInt(parts[1], 10) || 0;
  }

  const commits = [];
  if (log) {
    for (const line of log.split('\n')) {
      if (!line) continue;
      const tab = line.indexOf('\t');
      if (tab === -1) {
        commits.push({ age: '', subject: line });
      } else {
        commits.push({ age: line.slice(0, tab), subject: line.slice(tab + 1) });
      }
    }
  }

  gitStateByProject.set(proj.id, {
    branch,
    dirty,
    ahead,
    behind,
    lastCommitAge: commits[0] ? commits[0].age : null,
    commits
  });
}

async function refreshGitStates() {
  const projects = config.projects || [];
  await Promise.all(projects.map((proj) => refreshGitStateForProject(proj)));
}

function ghApi(args) {
  return new Promise((resolve) => {
    execFile('gh', args, {
      timeout: 30000,
      env: buildChildEnv(),
      maxBuffer: 4 * 1024 * 1024
    }, (err, stdout, stderr) => {
      const raw = String(stdout || '');
      if (!raw) {
        if (err?.code === 'ENOENT') ghUnavailable = true;
        resolve({ ok: false, err, stderr: String(stderr || ''), data: null });
        return;
      }
      try {
        const parsed = JSON.parse(raw);
        const errors = parsed.errors || [];
        const rateLimited = errors.some((e) =>
          e.type === 'RATE_LIMITED'
          || e.type === 'RATE_LIMIT'
          || /rate limit/i.test(e.message || '')
          || /rate limit/i.test(parsed.message || '')
        ) || /rate limit/i.test(parsed.message || '');
        if (rateLimited) {
          resolve({ ok: false, rateLimited: true, data: parsed.data || null, errors });
          return;
        }
        if (err && parsed.data === undefined && parsed.message) {
          resolve({ ok: false, err, data: null, message: parsed.message });
          return;
        }
        resolve({ ok: true, data: parsed.data !== undefined ? parsed.data : parsed, errors, err });
      } catch (e) {
        resolve({ ok: false, err: e, stderr: raw.slice(0, 200) });
      }
    });
  });
}

function classifyCiFromRest(statusState, checkRuns) {
  const runs = checkRuns || [];
  let busy = false;
  let failed = false;
  let ok = false;
  for (const run of runs) {
    const conclusion = run.conclusion || null;
    const status = run.status || null;
    if (
      conclusion === 'failure'
      || conclusion === 'timed_out'
      || conclusion === 'startup_failure'
      || conclusion === 'action_required'
    ) {
      failed = true;
    } else if (!conclusion && (status === 'queued' || status === 'in_progress' || status === 'waiting' || status === 'pending')) {
      busy = true;
    } else if (conclusion === 'success' || conclusion === 'neutral' || conclusion === 'skipped') {
      ok = true;
    }
  }
  if (failed || statusState === 'failure' || statusState === 'error') return 'failing';
  // Prefer concrete check runs over legacy combined status — empty forever-
  // queued apps (Cursor/CodeRabbit shells) leave status=pending after green CI.
  if (busy) return 'running';
  if (ok) return 'passing';
  if (statusState === 'pending') return 'running';
  if (statusState === 'success') return 'passing';
  return null;
}

function classifyCrFromRest({ pull, comments, reviews, reviewComments, suites, statuses, isPrivate }) {
  const prUrl = pull.html_url;
  const prNumber = pull.number;
  const crComments = (comments || []).filter((c) => isCrAuthor(c.user?.login));
  const crReviews = (reviews || []).filter((r) => isCrAuthor(r.user?.login));

  let rateWindow = collectRateLimitWindows({ comments: crComments, reviews: crReviews });
  const now = Date.now();
  if (rateWindow && new Date(rateWindow.until).getTime() > now) {
    return {
      state: 'limited',
      actionable: 0,
      tip: 'Review rate-limited',
      detail: `Capacity returns at ${formatClock(rateWindow.until)}`,
      limitedUntil: rateWindow.until,
      limitedSince: rateWindow.since,
      limitQuality: rateWindow.quality || 'fallback',
      isPrivate,
      prUrl,
      prNumber
    };
  }

  // Live check/status beats stale clear from an earlier review cycle.
  if (crLiveReviewing({
    suites: suites || [],
    statuses: statuses || [],
    comments: crComments,
    reviews: crReviews
  })) {
    return reviewingCrResult(prUrl, prNumber, isPrivate);
  }

  const newestReview = crReviews.length ? crReviews[crReviews.length - 1] : null;
  const newestComment = crComments.length ? crComments[crComments.length - 1] : null;

  // "Actionable comments posted: N" is a point-in-time review summary — it stays
  // N even after threads are resolved. Only trust an explicit 0; live counts
  // come from GraphQL reviewThreads.
  let postedCount = null;
  for (const r of [...crReviews].reverse()) {
    const m = r.body?.match(/Actionable comments posted:\s*(\d+)/i);
    if (m) {
      postedCount = parseInt(m[1], 10) || 0;
      break;
    }
  }
  if (postedCount === 0) {
    return {
      state: 'clear',
      actionable: 0,
      tip: 'Good to go',
      detail: 'No unresolved CodeRabbit comments',
      limitedUntil: null,
      limitedSince: null,
      isPrivate,
      prUrl,
      prNumber
    };
  }

  // Same clear signal can live only on the summarize issue comment (no review).
  if (crComments.some((c) => crFinishedClearFromText(c.body))) {
    return {
      state: 'clear',
      actionable: 0,
      tip: 'Good to go',
      detail: 'No unresolved CodeRabbit comments',
      limitedUntil: null,
      limitedSince: null,
      isPrivate,
      prUrl,
      prNumber
    };
  }

  // Soft in-progress from recent invocation without a finished review yet.
  let reviewing = false;
  const recent = newestComment || newestReview;
  if (recent) {
    const body = recent.body || '';
    const at = new Date(recent.created_at || recent.submitted_at || 0).getTime();
    const age = now - at;
    const finished = /Actionable comments posted/i.test(newestReview?.body || '')
      || /Review finished/i.test(body)
      || /No actionable comments were generated in the recent review/i.test(body);
    if (
      !finished
      && age < 20 * 60 * 1000
      && !/summarize by coderabbit\.ai/i.test(body)
      && /review command invocation|review_stack_entry_start|generating review|on it/i.test(body)
    ) {
      reviewing = true;
    }
    if (!finished && /review command invocation|review_stack_entry_start/i.test(body) && age < 20 * 60 * 1000) {
      const reviewAfter = newestReview && new Date(newestReview.submitted_at).getTime() > at;
      if (!reviewAfter && !/summarize by coderabbit\.ai/i.test(body)) reviewing = true;
    }
  }

  if (reviewing) {
    return reviewingCrResult(prUrl, prNumber, isPrivate);
  }

  // REST cannot see isResolved. If a review reported findings, stay neutral
  // until GraphQL reviewThreads confirm clear vs actionable (avoids stale badges).
  if (postedCount != null && postedCount > 0) {
    return {
      state: 'pending',
      actionable: 0,
      tip: 'Checking CodeRabbit threads',
      detail: 'Confirming unresolved comments',
      limitedUntil: null,
      limitedSince: null,
      isPrivate,
      prUrl,
      prNumber
    };
  }

  if (newestReview || crReviews.length) {
    return {
      state: 'clear',
      actionable: 0,
      tip: 'Good to go',
      detail: 'No unresolved CodeRabbit comments',
      limitedUntil: null,
      limitedSince: null,
      isPrivate,
      prUrl,
      prNumber
    };
  }

  return {
    state: 'pending',
    actionable: 0,
    tip: 'Waiting on CodeRabbit',
    detail: 'Review hasn’t started yet',
    limitedUntil: null,
    limitedSince: null,
    isPrivate,
    prUrl,
    prNumber
  };
}

async function enrichCrViaRest(s, pulls) {
  const pull = pulls[0];
  const n = pull.number;
  const sha = pull.head?.sha;
  const [comments, reviews, reviewComments, suites, status] = await Promise.all([
    ghApi(['api', `repos/${s.owner}/${s.name}/issues/${n}/comments?per_page=40`]),
    ghApi(['api', `repos/${s.owner}/${s.name}/pulls/${n}/reviews?per_page=30`]),
    ghApi(['api', `repos/${s.owner}/${s.name}/pulls/${n}/comments?per_page=50`]),
    sha
      ? ghApi(['api', `repos/${s.owner}/${s.name}/commits/${sha}/check-suites`])
      : Promise.resolve({ ok: false, data: null }),
    sha
      ? ghApi(['api', `repos/${s.owner}/${s.name}/commits/${sha}/status`])
      : Promise.resolve({ ok: false, data: null })
  ]);
  if (
    comments.rateLimited
    || reviews.rateLimited
    || reviewComments.rateLimited
    || suites.rateLimited
    || status.rateLimited
  ) {
    return { rateLimited: true };
  }
  const issueComments = comments.ok ? comments.data : [];
  let classified = classifyCrFromRest({
    pull,
    comments: issueComments,
    reviews: reviews.ok ? reviews.data : [],
    reviewComments: reviewComments.ok ? reviewComments.data : [],
    suites: suites.ok ? (suites.data?.check_suites || []) : [],
    statuses: status.ok ? (status.data?.statuses || []) : [],
    isPrivate: false
  });
  // --- CR Autofix (removable) ---
  classified = crAutofix.overlayAutofix(classified, { slug: s.slug, comments: issueComments });
  // --- end CR Autofix ---
  // mergeCrStates expects an array of per-PR classifications
  const perPr = pulls.map((p, i) => (i === 0 ? classified : {
    state: 'pending',
    actionable: 0,
    tip: null,
    detail: null,
    limitedUntil: null,
    limitedSince: null,
    isPrivate: false,
    prUrl: p.html_url,
    prNumber: p.number
  }));
  crBySlug.set(s.slug, mergeCrStates(perPr, pulls.length, false, s.slug));
  return { ok: true, perPr };
}

// REST is the durable path (core API). GraphQL is optional enrichment for
// CodeRabbit details — secondary GraphQL throttles were leaving cards stuck.
async function refreshOneRepoInsights(s) {
  const rest = await ghApi([
    'api',
    `repos/${s.owner}/${s.name}/pulls?state=open&per_page=10`
  ]);
  if (rest.rateLimited) return { rateLimited: true, via: 'rest' };
  if (!rest.ok || !Array.isArray(rest.data)) return { ok: false };
  const pulls = rest.data;
  openPrCounts.set(s.slug, pulls.length);

  const ciByNumber = new Map();
  // REST CI for the primary (newest) open PR; GraphQL fills siblings via rollup.
  if (pulls[0]?.head?.sha) {
    const sha = pulls[0].head.sha;
    const [st, checks] = await Promise.all([
      ghApi(['api', `repos/${s.owner}/${s.name}/commits/${sha}/status`]),
      ghApi(['api', `repos/${s.owner}/${s.name}/commits/${sha}/check-runs?per_page=50`])
    ]);
    if (!st.rateLimited && !checks.rateLimited) {
      const statusState = st.ok ? st.data?.state : null;
      const checkRuns = checks.ok ? (checks.data?.check_runs || []) : [];
      const one = classifyCiFromRest(statusState, checkRuns);
      if (one) ciByNumber.set(pulls[0].number, one);
    }
  }
  const ci = aggregateCiFromMap(ciByNumber);
  if (ci) ciStateBySlug.set(s.slug, ci);
  else ciStateBySlug.delete(s.slug);

  if (!pulls.length) {
    rateLimitMemory.delete(s.slug);
    crBySlug.set(s.slug, mergeCrStates([], 0, false, s.slug));
    prsBySlug.set(s.slug, []);
    return { ok: true };
  }

  // Prefer REST CR classification — works while GraphQL is throttled.
  const prevCr = crBySlug.get(s.slug);
  const restCr = await enrichCrViaRest(s, pulls);
  if (restCr.rateLimited) return { rateLimited: true, via: 'rest' };

  const restCrByNumber = new Map((restCr.perPr || []).map((c) => [c.prNumber, c]));
  setPrsForSlug(s.slug, pulls, { ciByNumber, crByNumber: restCrByNumber });

  // Sticky-preserve clear/actionable across REST's "pending" placeholder.
  // REST cannot see isResolved, so it returns pending when a review posted
  // findings — without this, the UI (and CR notifications) flap every refresh
  // until GraphQL enrichment re-confirms. GraphQL below still overrides to
  // clear once threads are actually resolved.
  {
    const restState = crBySlug.get(s.slug);
    if (
      prevCr
      && restState
      && prevCr.prNumber === restState.prNumber
      && (prevCr.state === 'clear' || prevCr.state === 'actionable')
      && (restState.state === 'pending' || restState.state === 'empty')
    ) {
      crBySlug.set(s.slug, {
        ...prevCr,
        openPrs: restState.openPrs ?? prevCr.openPrs,
        isPrivate: restState.isPrivate ?? prevCr.isPrivate
      });
    }
  }

  // Optional GraphQL enrichment for unresolved reviewThreads (more accurate
  // actionable counts) when not throttled.
  if (Date.now() >= ghGraphqlNextAt) {
    const numbers = pulls.slice(0, 5).map((p) => p.number);
    const prFields = numbers.map((n, i) => `  p${i}: pullRequest(number: ${n}) {
      number
      title
      url
      reviews(last: 8) {
        nodes { author { login } state body submittedAt }
      }
      comments(last: 12) {
        nodes { author { login } body createdAt updatedAt }
      }
      reviewThreads(first: 30) {
        nodes {
          isResolved
          comments(first: 1) { nodes { author { login } } }
        }
      }
      commits(last: 1) {
        nodes {
          commit {
            statusCheckRollup { state }
            status {
              contexts { context state description createdAt }
            }
            checkSuites(first: 12) {
              nodes {
                app { name slug }
                status conclusion updatedAt createdAt
                checkRuns(first: 10) {
                  nodes { name title status conclusion }
                }
              }
            }
          }
        }
      }
    }`).join('\n');
    const query = `query {
      repository(owner: "${s.owner}", name: "${s.name}") {
        isPrivate
        ${prFields}
      }
    }`;
    const gq = await ghApi(['api', 'graphql', '-f', `query=${query}`]);
    if (gq.rateLimited) {
      ghGraphqlNextAt = Date.now() + GH_GRAPHQL_BACKOFF_MS;
      console.log(`GitHub GraphQL throttled — CR thread enrichment pause ${GH_GRAPHQL_BACKOFF_MS / 1000}s (REST CR still live)`);
    } else if (gq.ok && gq.data?.repository) {
      const repo = gq.data.repository;
      const isPrivate = !!repo.isPrivate;
      const nodes = numbers.map((_, i) => repo[`p${i}`]).filter(Boolean);
      const perPr = nodes.map((pr) => {
        let classified = classifyPullRequestCr(pr, isPrivate);
        // --- CR Autofix (removable) ---
        classified = crAutofix.overlayAutofix(classified, {
          slug: s.slug,
          comments: pr.comments?.nodes || []
        });
        // --- end CR Autofix ---
        return classified;
      });
      const gqCiByNumber = new Map(ciByNumber);
      for (const pr of nodes) {
        const rollup = pr?.commits?.nodes?.[0]?.commit?.statusCheckRollup?.state;
        const one = classifyCiFromRollup(rollup);
        if (one) gqCiByNumber.set(pr.number, one);
      }
      const gqCi = aggregateCiFromMap(gqCiByNumber) || classifyRepoCi(nodes);
      if (gqCi) ciStateBySlug.set(s.slug, gqCi);
      else ciStateBySlug.delete(s.slug);

      const crByNumber = new Map(perPr.map((c) => [c.prNumber, c]));
      // Preserve titles/urls from REST pulls; GraphQL may omit some fields under load.
      const titleByNumber = new Map(pulls.map((p) => [p.number, p]));
      for (const pr of nodes) {
        const base = titleByNumber.get(pr.number) || {};
        titleByNumber.set(pr.number, {
          ...base,
          number: pr.number,
          title: pr.title || base.title,
          html_url: pr.url || base.html_url || base.url
        });
      }
      setPrsForSlug(s.slug, pulls.map((p) => titleByNumber.get(p.number) || p), {
        ciByNumber: gqCiByNumber,
        crByNumber
      });

      const fromGq = mergeCrStates(perPr, pulls.length, isPrivate, s.slug);
      const fromRest = crBySlug.get(s.slug);
      // GraphQL is better for unresolved threads; don't let it regress a live
      // REST "reviewing" signal back to pending.
      let merged = preferCrState(fromRest, fromGq);
      // --- CR Autofix (removable) ---
      // Prefer live autofixing over a thin GraphQL actionable/clear flip mid-run.
      // Delivery / leftover are sticky outcomes from Autofix status comments.
      if (fromGq?.state === 'delivery') {
        merged = fromGq;
      } else if (fromRest?.state === 'autofixing' && merged?.state !== 'autofixing' && merged?.state !== 'delivery') {
        merged = {
          ...merged,
          state: 'autofixing',
          actionable: 0,
          tip: fromRest.tip,
          detail: fromRest.detail,
          autofix: fromRest.autofix,
          taskUrl: fromRest.taskUrl || merged.taskUrl
        };
      } else if (fromRest?.state === 'delivery' && merged?.state !== 'delivery') {
        merged = {
          ...merged,
          state: 'delivery',
          tip: fromRest.tip,
          detail: fromRest.detail,
          autofix: fromRest.autofix,
          actionable: merged.actionable ?? fromRest.actionable,
          taskUrl: fromRest.taskUrl || merged.taskUrl
        };
      } else if (fromRest?.state === 'leftover' && merged?.state === 'actionable') {
        merged = {
          ...merged,
          state: 'leftover',
          tip: fromRest.tip,
          detail: fromRest.detail,
          autofix: fromRest.autofix,
          taskUrl: fromRest.taskUrl || merged.taskUrl
        };
      } else if (
        fromRest?.state === 'reviewing'
        && fromRest?.autofix?.phase === 'reviewing'
        && (merged?.state === 'pending' || merged?.state === 'ready' || merged?.state === 'empty')
      ) {
        merged = {
          ...merged,
          state: 'reviewing',
          actionable: 0,
          tip: fromRest.tip,
          detail: fromRest.detail,
          autofix: fromRest.autofix,
          taskUrl: fromRest.taskUrl || merged.taskUrl
        };
      }
      // --- end CR Autofix ---
      crBySlug.set(s.slug, merged);
      return { ok: true, enriched: true };
    }
  }

  return { ok: true };
}

function preferCrState(rest, gq) {
  if (!gq) return rest || null;
  if (!rest) return gq;
  // --- CR Autofix (removable) ---
  if (rest.state === 'autofixing' && gq.state !== 'autofixing') {
    if (gq.state === 'delivery' || gq.state === 'leftover' || gq.autofix?.phase === 'completed' || gq.autofix?.phase === 'failed' || gq.autofix?.phase === 'delivery') {
      return {
        ...gq,
        isPrivate: gq.isPrivate ?? rest.isPrivate,
        openPrs: gq.openPrs ?? rest.openPrs
      };
    }
    return {
      ...rest,
      isPrivate: gq.isPrivate ?? rest.isPrivate,
      openPrs: gq.openPrs ?? rest.openPrs,
      prUrl: gq.prUrl || rest.prUrl,
      prNumber: gq.prNumber || rest.prNumber
    };
  }
  if (gq.state === 'delivery' || rest.state === 'delivery') {
    const src = gq.state === 'delivery' ? gq : rest;
    return {
      ...src,
      isPrivate: gq.isPrivate ?? rest.isPrivate,
      openPrs: gq.openPrs ?? rest.openPrs,
      actionable: gq.actionable || rest.actionable || src.actionable || 0,
      taskUrl: src.taskUrl || gq.taskUrl || rest.taskUrl || null
    };
  }
  if (gq.state === 'leftover' || rest.state === 'leftover') {
    const src = gq.state === 'leftover' ? gq : rest;
    // Prefer GraphQL actionable count under leftover.
    return {
      ...src,
      actionable: gq.actionable || rest.actionable || src.actionable || 0,
      isPrivate: gq.isPrivate ?? rest.isPrivate,
      openPrs: gq.openPrs ?? rest.openPrs,
      taskUrl: src.taskUrl || gq.taskUrl || rest.taskUrl || null
    };
  }
  // --- end CR Autofix ---
  // Live reviewing beats stale clear/actionable from a prior review cycle.
  if (
    rest.state === 'reviewing'
    && (gq.state === 'clear' || gq.state === 'actionable' || gq.state === 'pending' || gq.state === 'ready' || gq.state === 'empty')
  ) {
    return {
      ...rest,
      isPrivate: gq.isPrivate ?? rest.isPrivate,
      openPrs: gq.openPrs ?? rest.openPrs
    };
  }
  if (
    gq.state === 'reviewing'
    && (rest.state === 'clear' || rest.state === 'actionable' || rest.state === 'pending' || rest.state === 'ready' || rest.state === 'empty')
  ) {
    return {
      ...gq,
      isPrivate: gq.isPrivate ?? rest.isPrivate,
      openPrs: gq.openPrs ?? rest.openPrs
    };
  }
  // GraphQL reviewThreads are the source of truth for actionable vs clear
  // (REST "Actionable comments posted: N" and comment totals stay stale after
  // threads are resolved).
  if (gq.state === 'clear' || gq.state === 'actionable') {
    return {
      ...gq,
      isPrivate: gq.isPrivate ?? rest.isPrivate,
      openPrs: gq.openPrs ?? rest.openPrs
    };
  }
  // Don't let a thin GraphQL pass wipe a live REST "reviewing" signal.
  if (rest.state === 'reviewing' && (gq.state === 'pending' || gq.state === 'empty')) {
    return { ...rest, isPrivate: gq.isPrivate ?? rest.isPrivate, openPrs: gq.openPrs ?? rest.openPrs };
  }
  if ((STATE_RANK[gq.state] || 0) >= (STATE_RANK[rest.state] || 0)) return gq;
  return rest;
}

async function refreshGithubLogin() {
  if (ghUnavailable) return;
  if (githubLogin && Date.now() - githubLoginFetchedAt < 30 * 60 * 1000) return;
  const res = await ghApi(['api', 'user']);
  const login = res.data?.login || null;
  if (res.ok && login) {
    githubLogin = String(login).trim() || null;
    githubLoginFetchedAt = Date.now();
  }
}

async function refreshGithubInsights() {
  if (ghUnavailable || ghRefreshInFlight) return;
  if (Date.now() < ghRestNextAt) return;

  await refreshGithubLogin();

  const slugs = [];
  for (const proj of config.projects || []) {
    const parsed = parseRepoSlug(proj.repo);
    if (parsed && !slugs.some((s) => s.slug === parsed.slug)) slugs.push(parsed);
  }
  if (!slugs.length) return;

  // Round-robin: refresh one repo per tick so request load is steady instead
  // of a 7-repo burst every N seconds.
  const s = slugs[ghStaggerIndex % slugs.length];
  ghStaggerIndex = (ghStaggerIndex + 1) % slugs.length;

  ghRefreshInFlight = true;
  try {
    const result = await refreshOneRepoInsights(s);
    if (result?.rateLimited && result.via === 'rest') {
      ghRestNextAt = Date.now() + GH_REST_BACKOFF_MS;
      console.log(`GitHub REST rate-limited on ${s.slug} — backing off ${GH_REST_BACKOFF_MS / 1000}s`);
    } else {
      rebuildRateLimitBanner();
    }
  } catch (e) {
    console.log('GitHub insights refresh failed:', e.message);
  } finally {
    ghRefreshInFlight = false;
  }
}

setInterval(() => { refreshGithubInsights().catch(() => {}); }, GH_STAGGER_MS);
refreshGithubInsights().catch(() => {});
setInterval(() => { refreshGitStates().catch(() => {}); }, GIT_REFRESH_MS);
refreshGitStates().catch(() => {});

function applyPortToService(service, portNum) {
  service.port = portNum;
  service.url = `http://localhost:${portNum}`;

  if (!Array.isArray(service.args)) return;

  const portIdx = service.args.indexOf('--port');
  if (portIdx !== -1 && portIdx + 1 < service.args.length) {
    service.args[portIdx + 1] = String(portNum);
    return;
  }

  if (service.args.indexOf('-p') !== -1) {
    const pIdx = service.args.indexOf('-p');
    service.args[pIdx + 1] = String(portNum);
    return;
  }

  if (service.command === 'npm' && service.args[0] === 'run') {
    if (!service.args.includes('--')) {
      service.args.push('--');
    }
    service.args.push('--port', String(portNum));
  }
}

function findProject(projectId) {
  return config.projects.find((p) => p.id === projectId) || null;
}

function findService(serviceId) {
  for (const proj of config.projects) {
    for (const s of proj.services) {
      if (s.id === serviceId) {
        return { service: s, project: proj };
      }
    }
  }
  return null;
}

function startService(serviceId) {
  const item = findService(serviceId);
  if (!item) throw new Error(`Service ${serviceId} not found`);

  const { service, project } = item;
  const state = serviceState.get(serviceId);

  if (state.status === 'running' && state.child) {
    throw new Error(`Service ${serviceId} is already running (PID ${state.pid})`);
  }

  const cwd = service.cwd || project.directory;
  if (!fs.existsSync(cwd)) {
    throw new Error(`Directory does not exist: ${cwd}`);
  }

  appendLog(serviceId, `>>> [DASHBOARD] Spawning: ${service.command} ${service.args.join(' ')} in ${cwd}`);

  const child = spawn(service.command, service.args, {
    cwd,
    shell: true,
    // New process group on Unix so stop/kill can terminate the whole tree.
    detached: !IS_WIN,
    env: buildChildEnv({
      PORT: String(service.port || '')
    })
  });

  state.child = child;
  state.pid = child.pid;
  state.status = 'running';
  state.startTime = Date.now();

  child.stdout.on('data', (data) => appendLog(serviceId, data));
  child.stderr.on('data', (data) => appendLog(serviceId, data));

  child.on('error', (err) => {
    appendLog(serviceId, `>>> [DASHBOARD ERROR] ${err.message}`);
    state.status = 'error';
  });

  child.on('exit', (code, signal) => {
    appendLog(serviceId, `>>> [DASHBOARD] Process exited with code ${code}, signal ${signal}`);
    state.child = null;
    state.pid = null;
    state.status = 'stopped';
    state.startTime = null;
  });

  return { success: true, pid: child.pid };
}

async function stopService(serviceId) {
  const state = serviceState.get(serviceId);
  if (!state || !state.child || !state.pid) {
    const item = findService(serviceId);
    if (item && item.service.port && portState.get(item.service.port)) {
      return killPort(item.service.port);
    }
    return { message: 'Service not actively running in dashboard' };
  }

  appendLog(serviceId, `>>> [DASHBOARD] Terminating PID ${state.pid} tree...`);
  const { err, stderr } = await killPidTree(state.pid);
  state.child = null;
  state.pid = null;
  state.status = 'stopped';
  state.startTime = null;
  if (err) {
    appendLog(serviceId, `>>> [DASHBOARD] Kill result: ${stderr || err.message}`);
  } else {
    appendLog(serviceId, `>>> [DASHBOARD] Stopped successfully`);
  }
  return { success: true };
}

async function killPort(port) {
  let pids = new Set();

  if (IS_WIN) {
    const { err, stdout } = await run(`netstat -ano | findstr :${port}`);
    if (err || !stdout.trim()) {
      return { message: `No process found listening on port ${port}` };
    }
    for (const line of stdout.trim().split('\n')) {
      const parts = line.trim().split(/\s+/);
      const pid = parts[parts.length - 1];
      if (pid && pid !== '0' && !isNaN(pid)) pids.add(pid);
    }
  } else {
    const { err, stdout } = await run(`lsof -tiTCP:${port} -sTCP:LISTEN`);
    if (err || !stdout.trim()) {
      return { message: `No process found listening on port ${port}` };
    }
    for (const pid of stdout.trim().split(/\n+/)) {
      if (pid && pid !== '0' && !isNaN(pid)) pids.add(pid);
    }
  }

  if (pids.size === 0) {
    return { message: `No valid PID found for port ${port}` };
  }

  await Promise.all(Array.from(pids).map((pid) => killPidTree(pid)));
  portState.set(port, false);
  portDetails.delete(port);
  httpHealthState.delete(port);
  return { success: true, killedPids: Array.from(pids) };
}

// Arc has no --profile-directory support, but its spaces are scriptable and each
// space is bound to a profile, so targeting a space targets that profile.
const ARC_LIST_SPACES = `
tell application "Arc"
  set _out to ""
  repeat with _s in spaces of front window
    set _out to _out & (get title of _s) & linefeed
  end repeat
  return _out
end tell
`;

const ARC_OPEN_IN_SPACE = `
on run argv
  set theURL to item 1 of argv
  set theSpace to item 2 of argv
  set shouldFocus to (item 3 of argv is "focus")
  tell application "Arc"
    tell front window
      tell space theSpace
        make new tab with properties {URL:theURL}
      end tell
      if shouldFocus then tell space theSpace to focus
    end tell
    if shouldFocus then activate
  end tell
  return "ok"
end run
`;

// Script body goes over stdin and values over argv, so URLs and space names
// are never interpolated into the AppleScript source.
function osascriptWithStdin(script, args = []) {
  return new Promise((resolve, reject) => {
    const child = execFile('osascript', ['-', ...args], { timeout: 8000 }, (err, stdout, stderr) => {
      if (err) return reject(new Error((stderr || err.message).trim()));
      resolve(String(stdout));
    });
    child.stdin.end(script);
  });
}

async function listArcSpaces() {
  if (process.platform !== 'darwin') return [];
  if (!fs.existsSync('/Applications/Arc.app')) return [];
  try {
    const out = await osascriptWithStdin(ARC_LIST_SPACES);
    return out.split('\n').map((s) => s.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

function isSafeExternalUrl(raw) {
  try {
    const parsed = new URL(String(raw));
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

async function openUrl(rawUrl, space, focus = true) {
  if (!isSafeExternalUrl(rawUrl)) {
    throw new Error('Only http(s) URLs can be opened');
  }

  if (space && process.platform === 'darwin') {
    await osascriptWithStdin(ARC_OPEN_IN_SPACE, [String(rawUrl), String(space), focus ? 'focus' : 'background']);
    return { success: true, openedIn: space };
  }

  const opener = process.platform === 'darwin' ? 'open' : (IS_WIN ? 'start' : 'xdg-open');
  await new Promise((resolve, reject) => {
    execFile(opener, [String(rawUrl)], { timeout: 8000 }, (err) => (err ? reject(err) : resolve()));
  });
  return { success: true, openedIn: 'default browser' };
}

async function restartService(serviceId) {
  const item = findService(serviceId);
  if (!item) throw new Error(`Service ${serviceId} not found`);

  // Kill port or stop child
  if (item.service.port) {
    await killPort(item.service.port);
  }
  await stopService(serviceId);

  // Wait a short beat for port release
  await new Promise(r => setTimeout(r, 600));

  return startService(serviceId);
}

// HTTP Server
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // API Endpoints
  if (url.pathname === '/api/meta') {
    const dashboardPath = __dirname;
    const registerCurl = `curl -sS -X POST http://localhost:4000/api/register -H 'Content-Type: application/json' -d '{"protocol":${AGENT_PROTOCOL_VERSION},"name":"Project Name","directory":"/absolute/path","port":5180}'`;
    const registerCmd = `export LOCAL_DEV_DASHBOARD=${dashboardPath}; node "$LOCAL_DEV_DASHBOARD/register.mjs" "<Project Name>" "<absolute-directory>" <port>`;
    const prompt = [
      'Add this project to my local Dev Dashboard.',
      '',
      `Dashboard: ${dashboardPath}`,
      `Agent protocol: v${AGENT_PROTOCOL_VERSION}`,
      '',
      '1. Detect this project\'s display name, absolute directory path, and default/configured dev server port (e.g. Vite server.port).',
      '2. Prefer portable register (dashboard must be running):',
      `   ${registerCurl}`,
      `   Optional local helper: ${registerCmd}`,
      '3. At session start (and whenever a dashboard response has stale:true), GET http://localhost:4000/api/agent-protocol and save `instructions` to AGENTS.md in this project (optional editor-specific mirrors OK).',
      '4. When starting or finishing work on a PR, POST http://localhost:4000/api/agent-activity with { "protocol": ' + AGENT_PROTOCOL_VERSION + ', "phase": "start"|"finish", "directory": "<abs path>", "pr": <PR_NUMBER>, "summary": "<short>", "agent": "<cursor|antigravity|other>" }. Use the active PR number — do not copy a stale example.',
      '5. Confirm the name, path, and port after registering.',
    ].join('\n');

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      dashboardPath,
      registerScript: path.join(dashboardPath, 'register.mjs'),
      registerCommand: registerCmd,
      registerCurl,
      agentPrompt: prompt,
      protocol: AGENT_PROTOCOL_VERSION,
    }));
    return;
  }

  if (url.pathname === '/api/agent-protocol') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      protocol: AGENT_PROTOCOL_VERSION,
      stale: false,
      instructions: readAgentInstructions(),
      instructionsPath: 'AGENTS.md',
      protocolUrl: 'http://localhost:4000/api/agent-protocol',
      endpoints: {
        activity: 'POST /api/agent-activity',
        protocol: 'GET /api/agent-protocol',
        register: 'POST /api/register',
      }
    }));
    return;
  }

  if (url.pathname === '/api/agent-activity' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const payload = JSON.parse(body || '{}');
        const proto = protocolPayload(payload.protocol);
        const project = resolveProjectForAgent(payload);
        if (!project) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            error: 'Project not found. Pass projectId, directory, or repo of a registered dashboard project.',
            ...proto
          }));
          return;
        }
        const agent = setAgentActivity(project.id, payload);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          ok: true,
          projectId: project.id,
          name: project.name,
          agent,
          ...proto
        }));
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message, protocol: AGENT_PROTOCOL_VERSION }));
      }
    });
    return;
  }

  if (url.pathname === '/api/status') {
    const projects = config.projects.map(proj => {
      const slug = parseRepoSlug(proj.repo);
      let cr = slug ? crBySlug.get(slug.slug) : null;
      // --- CR Autofix (removable) ---
      cr = crAutofix.finalizeAutofixForStatus(cr, slug?.slug);
      // --- end CR Autofix ---
      let prs = slug ? (prsBySlug.get(slug.slug) || []) : [];
      if (cr && prs.length) {
        // Mirror sticky autofix/leftover onto the matching PR card.
        prs = prs.map((p) => {
          if (cr.prNumber && p.number === cr.prNumber) {
            return { ...p, cr: thinCrForPr({ ...p.cr, ...cr, prNumber: p.number }) };
          }
          return p;
        });
      }
      return {
        ...proj,
        openPrs: slug && openPrCounts.has(slug.slug) ? openPrCounts.get(slug.slug) : null,
        ci: slug ? (ciStateBySlug.get(slug.slug) || null) : null,
        cr: cr || { state: 'empty', actionable: 0, openPrs: 0 },
        prs,
        git: gitStateByProject.get(proj.id) || null,
        agent: getAgentActivity(proj.id),
        services: proj.services.map(s => {
          const state = serviceState.get(s.id) || { status: 'stopped', logs: [], pid: null, startTime: null };
          const isPortOpen = portState.get(s.port) || false;
          const extInfo = portDetails.get(s.port) || null;
          const health = httpHealthState.get(s.port) || null;

          const isStarting = state.status === 'running' && !isPortOpen;
          return {
            ...s,
            isPortOpen,
            dashboardRunning: state.status === 'running',
            isStarting,
            isExternal: isPortOpen && state.status !== 'running',
            pid: state.pid || (extInfo ? extInfo.pid : null),
            externalProcess: extInfo ? extInfo.processName : null,
            externalMem: extInfo ? extInfo.mem : null,
            httpHealth: health,
            uptimeSeconds: state.startTime ? Math.floor((Date.now() - state.startTime) / 1000) : 0,
            recentLogs: state.logs.slice(-5),
            lastLog: state.logs.length > 0 ? state.logs[state.logs.length - 1] : null
          };
        })
      };
    });

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      projects,
      globalLinks: Array.isArray(config.globalLinks) ? config.globalLinks : [],
      github: { login: githubLogin },
      rateLimit: rateLimitBanner,
      apiLimit: {
        restUntil: ghRestNextAt > Date.now() ? new Date(ghRestNextAt).toISOString() : null,
        graphqlUntil: ghGraphqlNextAt > Date.now() ? new Date(ghGraphqlNextAt).toISOString() : null
      },
      // --- CR Autofix (removable) ---
      features: { crAutofix: crAutofix.CR_AUTOFIX_ENABLED }
      // --- end CR Autofix ---
    }));
    return;
  }

  // --- CR Autofix (removable) ---
  if (
    crAutofix.CR_AUTOFIX_ENABLED
    && (url.pathname === '/api/cr-action' || url.pathname === '/api/cr-autofix')
    && req.method === 'POST'
  ) {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const payload = JSON.parse(body || '{}');
        const action = url.pathname === '/api/cr-autofix'
          ? 'autofix'
          : (payload.action === 'review' ? 'review' : 'autofix');
        const project = payload.projectId
          ? findProject(payload.projectId)
          : null;
        const repoUrl = project?.repo || payload.repo || null;
        const slug = parseRepoSlug(repoUrl);
        if (!slug) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Project needs a GitHub repo' }));
          return;
        }
        const cr = crBySlug.get(slug.slug);
        const prNumber = Number(payload.pr || payload.prNumber || cr?.prNumber);
        if (!prNumber) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'No open PR number — open a PR or pass pr' }));
          return;
        }
        const result = await crAutofix.postCrActionComment({
          owner: slug.owner,
          name: slug.name,
          prNumber,
          action,
          env: buildChildEnv()
        });
        if (!result.ok) {
          res.writeHead(502, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(result));
          return;
        }
        if (cr) {
          crBySlug.set(slug.slug, crAutofix.overlayAutofix(
            { ...cr, prNumber },
            { slug: slug.slug, comments: [] }
          ));
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }
  // --- end CR Autofix ---

  if (url.pathname === '/api/start' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const { serviceId } = JSON.parse(body || '{}');
        const result = startService(serviceId);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  if (url.pathname === '/api/stop' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const { serviceId } = JSON.parse(body || '{}');
        const result = await stopService(serviceId);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  if (url.pathname === '/api/restart' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const { serviceId } = JSON.parse(body || '{}');
        const result = await restartService(serviceId);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  if (url.pathname === '/api/restart-all' && req.method === 'POST') {
    const results = [];
    for (const proj of config.projects) {
      for (const s of proj.services) {
        try {
          const r = await restartService(s.id);
          results.push({ id: s.id, success: true, pid: r.pid });
        } catch (e) {
          results.push({ id: s.id, success: false, error: e.message });
        }
      }
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true, results }));
    return;
  }

  if (url.pathname === '/api/stop-all' && req.method === 'POST') {
    for (const proj of config.projects) {
      for (const s of proj.services) {
        await stopService(s.id);
        if (s.port) await killPort(s.port);
      }
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true }));
    return;
  }

  if (url.pathname === '/api/register' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const payload = JSON.parse(body || '{}');
        const { id, name, directory, description, command, args, port, url: serviceUrl, repo, liveUrl, protocol } = payload;
        if (!name || !directory || !port) {
          throw new Error('name, directory, and port are required fields');
        }
        const projId = id || name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
        const serviceId = `${projId}-dev`;

        let project = config.projects.find(p => p.id === projId || p.directory?.toLowerCase() === directory.toLowerCase());
        if (!project) {
          project = {
            id: projId,
            name,
            directory,
            description: description || '',
            services: []
          };
          config.projects.push(project);
        }

        if (description) project.description = description;
        if (repo) project.repo = normalizeRepoUrl(repo);
        if (liveUrl) project.liveUrl = String(liveUrl).trim();
        enrichProjectLinks(project);

        let service = project.services.find(s => s.id === serviceId);
        if (!service) {
          service = {
            id: serviceId,
            name: 'Dev Server',
            command: command || 'npm',
            args: args || ['run', 'dev', '--', '--port', String(port)],
            port: Number(port),
            url: serviceUrl || `http://localhost:${port}`
          };
          project.services.push(service);
        } else {
          service.port = Number(port);
          service.url = serviceUrl || `http://localhost:${port}`;
          if (command) service.command = command;
          if (args) service.args = args;
        }

        fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf-8');
        loadConfig();
        updatePortStatuses();

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, project, ...protocolPayload(protocol) }));
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message, protocol: AGENT_PROTOCOL_VERSION }));
      }
    });
    return;
  }

  if (url.pathname === '/api/link-icons') {
    const iconsPath = path.join(__dirname, 'public', 'link-icons.json');
    if (req.method === 'GET') {
      try {
        const raw = fs.readFileSync(iconsPath, 'utf8');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(raw);
      } catch {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{}');
      }
      return;
    }
    if (req.method === 'POST') {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        try {
          const payload = JSON.parse(body || '{}');
          if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Expected an object of label → url' }));
            return;
          }
          const cleaned = {};
          for (const [key, val] of Object.entries(payload)) {
            const k = String(key || '').trim().toLowerCase();
            if (!k) continue;
            if (val == null || val === '') continue;
            cleaned[k] = String(val).trim();
          }
          fs.writeFileSync(iconsPath, `${JSON.stringify(cleaned, null, 2)}\n`, 'utf8');
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, icons: cleaned }));
        } catch (err) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message }));
        }
      });
      return;
    }
  }

  if (url.pathname === '/api/global-links' && req.method === 'POST') {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      try {
        const payload = JSON.parse(body || '{}');
        const rawLinks = Array.isArray(payload)
          ? payload
          : (Array.isArray(payload.links) ? payload.links : null);
        if (!rawLinks) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Expected { links: [...] }' }));
          return;
        }
        config.globalLinks = rawLinks.map(sanitizeLink).filter(Boolean);
        fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf-8');
        loadConfig();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, globalLinks: config.globalLinks || [] }));
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  if (url.pathname === '/api/arc-spaces') {
    const spaces = await listArcSpaces();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ spaces, defaultSpace: config.defaultArcSpace || DEFAULT_MAIN_SPACE }));
    return;
  }

  if (url.pathname === '/api/open' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const { url: target, space, focus } = JSON.parse(body || '{}');
        const result = await openUrl(target, space, focus !== false);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  if (url.pathname === '/api/kill-port' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const { port } = JSON.parse(body || '{}');
        const result = await killPort(Number(port));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  if (url.pathname === '/api/update-port' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const { serviceId, newPort } = JSON.parse(body || '{}');
        const portNum = parseInt(newPort, 10);
        if (!portNum || isNaN(portNum)) {
          throw new Error('Valid port number is required');
        }

        const found = findService(serviceId);
        if (!found) throw new Error(`Service ${serviceId} not found`);

        applyPortToService(found.service, portNum);
        fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf-8');
        updatePortStatuses();

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, service: found.service }));
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  if (url.pathname === '/api/update-project' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const payload = JSON.parse(body || '{}');
        const { projectId } = payload;
        if (!projectId) throw new Error('projectId is required');

        const project = findProject(projectId);
        if (!project) throw new Error(`Project ${projectId} not found`);

        if (typeof payload.name === 'string' && payload.name.trim()) {
          project.name = payload.name.trim();
        }
        if (typeof payload.description === 'string') {
          project.description = payload.description.trim();
        }
        if (typeof payload.avatar === 'string') {
          const avatar = payload.avatar.trim();
          if (avatar) project.avatar = avatar;
          else delete project.avatar;
        }
        if (typeof payload.repo === 'string') {
          const repo = normalizeRepoUrl(payload.repo.trim());
          if (repo) project.repo = repo;
          else delete project.repo;
        }
        if (typeof payload.liveUrl === 'string') {
          const liveUrl = payload.liveUrl.trim();
          if (liveUrl) project.liveUrl = liveUrl;
          else delete project.liveUrl;
        }
        if (typeof payload.defaultArcSpace === 'string') {
          const space = payload.defaultArcSpace.trim();
          if (space) project.defaultArcSpace = space;
          else delete project.defaultArcSpace;
        }
        if (Array.isArray(payload.links)) {
          const links = [];
          for (const item of payload.links) {
            const link = sanitizeLink(item);
            if (!link) continue;
            if (!isSafeExternalUrl(link.url)) {
              throw new Error(`"${link.label}" must be an http(s) URL`);
            }
            links.push(link);
          }
          project.links = links;
        }

        if (Array.isArray(payload.services)) {
          for (const item of payload.services) {
            if (!item || !item.id) continue;
            const service = project.services.find((s) => s.id === item.id);
            if (!service) continue;

            if (typeof item.name === 'string' && item.name.trim()) {
              service.name = item.name.trim();
            }
            if (item.port !== undefined && item.port !== null && item.port !== '') {
              const portNum = parseInt(item.port, 10);
              if (!portNum || isNaN(portNum) || portNum < 1 || portNum > 65535) {
                throw new Error(`Invalid port for service ${item.id}`);
              }
              applyPortToService(service, portNum);
            }
          }
        }

        enrichProjectLinks(project);
        fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf-8');
        loadConfig();
        updatePortStatuses();

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, project }));
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  if (url.pathname.startsWith('/api/logs/')) {
    const serviceId = url.pathname.replace('/api/logs/', '');
    const state = serviceState.get(serviceId);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ logs: state ? state.logs : [] }));
    return;
  }

  if (url.pathname.startsWith('/api/stream/')) {
    const serviceId = url.pathname.replace('/api/stream/', '');
    const state = serviceState.get(serviceId);
    if (!state) {
      res.writeHead(404);
      res.end('Service not found');
      return;
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive'
    });

    state.sseClients.add(res);

    for (const line of state.logs) {
      res.write(`data: ${JSON.stringify({ line })}\n\n`);
    }

    req.on('close', () => {
      state.sseClients.delete(res);
    });
    return;
  }

  // Static File Serving
  let filePath = path.join(PUBLIC_DIR, url.pathname === '/' ? 'index.html' : url.pathname);
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      if (err.code === 'ENOENT') {
        res.writeHead(404);
        res.end('Not Found');
      } else {
        res.writeHead(500);
        res.end(err.message);
      }
      return;
    }

    const ext = path.extname(filePath);
    let contentType = 'text/html';
    if (ext === '.js' || ext === '.mjs') contentType = 'application/javascript';
    if (ext === '.css') contentType = 'text/css';
    if (ext === '.json') contentType = 'application/json';
    if (ext === '.svg') contentType = 'image/svg+xml';
    if (ext === '.png') contentType = 'image/png';
    if (ext === '.ico') contentType = 'image/x-icon';
    if (ext === '.jpg' || ext === '.jpeg') contentType = 'image/jpeg';
    if (ext === '.webp') contentType = 'image/webp';

    res.writeHead(200, { 'Content-Type': contentType });
    res.end(data);
  });
});

server.listen(PORT, () => {
  console.log(`\n Project Dashboard running at: http://localhost:${PORT}\n`);
});
