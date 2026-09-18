import http from 'http';
import fs from 'fs';
import path from 'path';
import net from 'net';
import { fileURLToPath } from 'url';
import { spawn, exec, execSync, execFile } from 'child_process';

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

// GitHub insights (open PRs, CI fail, CodeRabbit chip state) from one bulk
// GraphQL query on a slow timer. Auth is the gh CLI keyring.
const GH_REFRESH_MS = 20000;
const GH_REFRESH_BACKOFF_MS = 60000;
const openPrCounts = new Map();
const ciStateBySlug = new Map(); // slug -> 'failing' | 'running' | 'passing'
const crBySlug = new Map(); // slug -> { state, actionable, openPrs, isPrivate, tip, limitedUntil, limitedSince, prUrl, prNumber }
const rateLimitMemory = new Map(); // slug -> { until, since, isPrivate, prUrl }
let rateLimitBanner = { private: null, oss: null }; // { until, since } | null
let ghUnavailable = false;
let ghRefreshInFlight = false;
let ghNextRefreshAt = 0;

const CR_AUTHOR = /^coderabbitai(\[bot\])?$/i;
const STATE_RANK = {
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

function parseRateLimitWindow(text, createdAt) {
  const body = String(text || '');
  if (!/rate\s*limit/i.test(body) && !/reviews?\s+remaining/i.test(body) && !/try\s+again/i.test(body)) {
    return null;
  }
  const since = createdAt ? new Date(createdAt) : new Date();
  if (Number.isNaN(since.getTime())) return null;

  const inMins = body.match(/in\s+(\d+)\s*(minutes?|mins?|hours?|hrs?)/i);
  if (inMins) {
    const n = parseInt(inMins[1], 10);
    const unit = inMins[2].toLowerCase();
    const ms = /hour|hr/.test(unit) ? n * 3600000 : n * 60000;
    return { since: since.toISOString(), until: new Date(since.getTime() + ms).toISOString() };
  }

  const untilAt = body.match(/(?:until|again\s+at|available\s+at|after)\s+(\d{1,2}:\d{2}\s*(?:AM|PM)?)/i);
  if (untilAt) {
    const until = parseLooseTimeOnDay(untilAt[1], since);
    if (until) {
      const start = new Date(until.getTime() - 3600000);
      return {
        since: (start > since ? since : start).toISOString(),
        until: until.toISOString()
      };
    }
  }

  // Known CodeRabbit behavior: rolling ~1h window when limited.
  return {
    since: since.toISOString(),
    until: new Date(since.getTime() + 3600000).toISOString()
  };
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

  // Rate limit: check runs + CR comments/reviews
  const checkSuites = pr.commits?.nodes?.[0]?.commit?.checkSuites?.nodes || [];
  let rateWindow = null;
  for (const suite of checkSuites) {
    for (const run of suite.checkRuns?.nodes || []) {
      const label = `${run.name || ''} ${run.title || ''}`;
      if (/rate\s*limit/i.test(label)) {
        rateWindow = parseRateLimitWindow(label, new Date().toISOString())
          || { since: new Date(Date.now() - 3600000).toISOString(), until: new Date(Date.now() + 900000).toISOString() };
      }
    }
  }
  for (const c of [...comments].reverse()) {
    const w = parseRateLimitWindow(c.body, c.createdAt);
    if (w) { rateWindow = w; break; }
  }
  for (const r of [...reviews].reverse()) {
    const w = parseRateLimitWindow(r.body, r.submittedAt);
    if (w) { rateWindow = w; break; }
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
        isPrivate,
        prUrl: pr.url,
        prNumber: pr.number
      };
    }
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

  // In-progress: recent CR activity without a finished review summary, or
  // check run still queued/in progress.
  let reviewing = false;
  for (const suite of checkSuites) {
    if (!/coderabbit/i.test(suite.app?.name || '')) continue;
    for (const run of suite.checkRuns?.nodes || []) {
      if (run.status === 'IN_PROGRESS' || run.status === 'QUEUED' || run.status === 'PENDING') {
        reviewing = true;
      }
    }
  }
  const recentCr = newestComment || newestReview;
  if (recentCr) {
    const body = newestComment?.body || newestReview?.body || '';
    const at = new Date(newestComment?.createdAt || newestReview?.submittedAt || 0).getTime();
    const age = now - at;
    if (/review command invocation|review_stack|summarize by coderabbit|generating|in progress|on it/i.test(body)
      && age < 15 * 60 * 1000
      && !/Actionable comments posted/i.test(body)
      && !newestReview?.body?.match(/Actionable comments posted/i)) {
      reviewing = true;
    }
    // Command ack without a subsequent review yet
    if (/review command invocation/i.test(body) && age < 15 * 60 * 1000) {
      const reviewAfter = newestReview && new Date(newestReview.submittedAt).getTime() > at;
      if (!reviewAfter) reviewing = true;
    }
  }

  if (reviewing) {
    return {
      state: 'reviewing',
      actionable: 0,
      tip: 'CodeRabbit review in progress',
      detail: 'Results will land on the PR shortly',
      limitedUntil: null,
      limitedSince: null,
      isPrivate,
      prUrl: pr.url,
      prNumber: pr.number
    };
  }

  if (newestReview || reviews.length) {
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

// Aggregate open-PR CI from statusCheckRollup (matches the PR checks UI).
function classifyRepoCi(prNodes) {
  let sawPassing = false;
  let sawRunning = false;
  for (const pr of prNodes || []) {
    const state = pr?.commits?.nodes?.[0]?.commit?.statusCheckRollup?.state;
    if (!state) continue;
    if (state === 'FAILURE' || state === 'ERROR') return 'failing';
    if (state === 'PENDING' || state === 'EXPECTED') sawRunning = true;
    else if (state === 'SUCCESS') sawPassing = true;
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
    actionable: actionableTotal,
    openPrs: openCount,
    isPrivate,
    tip: best.tip,
    detail: best.detail,
    limitedUntil: best.limitedUntil || null,
    limitedSince: best.limitedSince || null,
    prUrl: best.prUrl || null,
    prNumber: best.prNumber || null,
    fill
  };
}

function rebuildRateLimitBanner() {
  let privateWin = null;
  let ossWin = null;
  for (const [, mem] of rateLimitMemory) {
    const untilMs = new Date(mem.until).getTime();
    if (untilMs <= Date.now()) continue;
    const bucket = mem.isPrivate ? 'private' : 'oss';
    const cur = bucket === 'private' ? privateWin : ossWin;
    if (!cur || untilMs > new Date(cur.until).getTime()) {
      const next = { until: mem.until, since: mem.since };
      if (bucket === 'private') privateWin = next;
      else ossWin = next;
    }
  }
  // Also consider live limited states from crBySlug
  for (const [, cr] of crBySlug) {
    if (cr.state !== 'limited' || !cr.limitedUntil) continue;
    if (new Date(cr.limitedUntil).getTime() <= Date.now()) continue;
    const bucket = cr.isPrivate ? 'private' : 'oss';
    const cur = bucket === 'private' ? privateWin : ossWin;
    if (!cur || new Date(cr.limitedUntil) > new Date(cur.until)) {
      const next = { until: cr.limitedUntil, since: cr.limitedSince };
      if (bucket === 'private') privateWin = next;
      else ossWin = next;
    }
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
        resolve({ ok: false, err, stderr: String(stderr || ''), data: null });
        return;
      }
      try {
        const parsed = JSON.parse(raw);
        const errors = parsed.errors || [];
        const rateLimited = errors.some((e) =>
          e.type === 'RATE_LIMITED' || /rate limit/i.test(e.message || '')
        );
        if (rateLimited) {
          resolve({ ok: false, rateLimited: true, data: parsed.data || null, errors });
          return;
        }
        if (err && !parsed.data && parsed.message) {
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

async function refreshOneRepoInsights(s) {
  const query = `query {
    repository(owner: "${s.owner}", name: "${s.name}") {
      isPrivate
      pullRequests(states: OPEN, first: 10) {
        totalCount
        nodes {
          number
          url
          title
          commits(last: 1) {
            nodes {
              commit {
                statusCheckRollup { state }
              }
            }
          }
          reviews(last: 8) {
            nodes {
              author { login }
              state
              body
              submittedAt
            }
          }
          comments(last: 12) {
            nodes {
              author { login }
              body
              createdAt
            }
          }
          reviewThreads(first: 30) {
            nodes {
              isResolved
              comments(first: 1) {
                nodes { author { login } }
              }
            }
          }
        }
      }
    }
  }`;

  const res = await ghApi(['api', 'graphql', '-f', `query=${query}`]);
  if (res.rateLimited) return { rateLimited: true };
  if (!res.ok || !res.data?.repository?.pullRequests) {
    // REST fallback: at least surface open PR count/CI when GraphQL flakes.
    const rest = await ghApi([
      'api',
      `repos/${s.owner}/${s.name}/pulls?state=open&per_page=10`
    ]);
    if (rest.rateLimited) return { rateLimited: true };
    if (!rest.ok || !Array.isArray(rest.data)) return { ok: false };
    const pulls = rest.data;
    openPrCounts.set(s.slug, pulls.length);
    // Best-effort CI from combined status on the first PR head.
    let ci = null;
    if (pulls[0]?.head?.sha) {
      const st = await ghApi([
        'api',
        `repos/${s.owner}/${s.name}/commits/${pulls[0].head.sha}/status`
      ]);
      const state = st.data?.state;
      if (state === 'failure' || state === 'error') ci = 'failing';
      else if (state === 'pending') ci = 'running';
      else if (state === 'success') ci = 'passing';
    }
    if (ci) ciStateBySlug.set(s.slug, ci);
    else ciStateBySlug.delete(s.slug);
    // Minimal CR stub so the chip isn't stuck empty when a PR is open.
    if (!pulls.length) {
      crBySlug.set(s.slug, mergeCrStates([], 0, false, s.slug));
    } else if (!crBySlug.has(s.slug) || crBySlug.get(s.slug)?.state === 'empty') {
      crBySlug.set(s.slug, {
        state: 'pending',
        actionable: 0,
        openPrs: pulls.length,
        isPrivate: false,
        tip: 'Waiting on CodeRabbit',
        detail: 'Review hasn’t started yet',
        limitedUntil: null,
        limitedSince: null,
        prUrl: pulls[0].html_url,
        prNumber: pulls[0].number,
        fill: null
      });
    } else {
      const prev = crBySlug.get(s.slug);
      crBySlug.set(s.slug, { ...prev, openPrs: pulls.length });
    }
    return { ok: true, fallback: true };
  }

  const repo = res.data.repository;
  const isPrivate = !!repo.isPrivate;
  const prs = repo.pullRequests;
  openPrCounts.set(s.slug, prs.totalCount);
  const nodes = prs.nodes || [];
  const ci = classifyRepoCi(nodes);
  if (ci) ciStateBySlug.set(s.slug, ci);
  else ciStateBySlug.delete(s.slug);
  const perPr = nodes.map((pr) => classifyPullRequestCr(pr, isPrivate));
  crBySlug.set(s.slug, mergeCrStates(perPr, prs.totalCount, isPrivate, s.slug));
  return { ok: true };
}

async function refreshGithubInsights() {
  if (ghUnavailable || ghRefreshInFlight) return;
  if (Date.now() < ghNextRefreshAt) return;

  const slugs = [];
  for (const proj of config.projects || []) {
    const parsed = parseRepoSlug(proj.repo);
    if (parsed && !slugs.some((s) => s.slug === parsed.slug)) slugs.push(parsed);
  }
  if (!slugs.length) return;

  ghRefreshInFlight = true;
  try {
    for (const s of slugs) {
      const result = await refreshOneRepoInsights(s);
      if (result?.rateLimited) {
        ghNextRefreshAt = Date.now() + GH_REFRESH_BACKOFF_MS;
        console.log(`GitHub rate-limited on ${s.slug} — backing off ${GH_REFRESH_BACKOFF_MS / 1000}s`);
        return;
      }
    }
    rebuildRateLimitBanner();
    ghNextRefreshAt = Date.now() + GH_REFRESH_MS;
  } catch (e) {
    console.log('GitHub insights refresh failed:', e.message);
  } finally {
    ghRefreshInFlight = false;
  }
}

setInterval(() => { refreshGithubInsights().catch(() => {}); }, 5000);
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
    const registerCmd = `node "${path.join(dashboardPath, 'register.mjs')}" "<Project Name>" "<absolute-directory>" <port>`;
    const prompt = [
      'Add this project to my local Dev Dashboard.',
      '',
      `Dashboard: ${dashboardPath}`,
      '',
      '1. Detect this project\'s display name, absolute directory path, and default/configured dev server port (e.g. Vite server.port).',
      '2. Register it by running:',
      `   ${registerCmd}`,
      '   Or if the dashboard is already running on http://localhost:4000, POST to /api/register with JSON { "name", "directory", "port" }.',
      '3. Confirm the name, path, and port after registering. You do not need to open the dashboard repo.',
    ].join('\n');

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      dashboardPath,
      registerScript: path.join(dashboardPath, 'register.mjs'),
      registerCommand: registerCmd,
      agentPrompt: prompt,
    }));
    return;
  }

  if (url.pathname === '/api/status') {
    const projects = config.projects.map(proj => {
      const slug = parseRepoSlug(proj.repo);
      const cr = slug ? crBySlug.get(slug.slug) : null;
      return {
        ...proj,
        openPrs: slug && openPrCounts.has(slug.slug) ? openPrCounts.get(slug.slug) : null,
        ci: slug ? (ciStateBySlug.get(slug.slug) || null) : null,
        cr: cr || { state: 'empty', actionable: 0, openPrs: 0 },
        git: gitStateByProject.get(proj.id) || null,
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
      rateLimit: rateLimitBanner
    }));
    return;
  }

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
        const { id, name, directory, description, command, args, port, url: serviceUrl, repo, liveUrl } = JSON.parse(body || '{}');
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
        res.end(JSON.stringify({ success: true, project }));
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
