import http from 'http';
import fs from 'fs';
import path from 'path';
import net from 'net';
import { fileURLToPath } from 'url';
import { spawn, exec } from 'child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 4000;
const CONFIG_PATH = path.join(__dirname, 'projects.json');
const EXAMPLE_CONFIG_PATH = path.join(__dirname, 'projects.example.json');
const PUBLIC_DIR = path.join(__dirname, 'public');

// State
let config = { projects: [] };
const serviceState = new Map();     // serviceId -> { child, pid, status, startTime, logs: [], sseClients: Set }
const portState = new Map();        // port -> boolean (isListening)
const portDetails = new Map();      // port -> { pid, processName, mem }
const httpHealthState = new Map();  // port -> { responsive: boolean, status: number|string }

function loadConfig() {
  try {
    if (!fs.existsSync(CONFIG_PATH) && fs.existsSync(EXAMPLE_CONFIG_PATH)) {
      fs.copyFileSync(EXAMPLE_CONFIG_PATH, CONFIG_PATH);
    }
    const raw = fs.readFileSync(CONFIG_PATH, 'utf-8');
    config = JSON.parse(raw);
    for (const proj of config.projects) {
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

function inspectPortProcess(port) {
  return new Promise((resolve) => {
    exec(`netstat -ano | findstr LISTENING | findstr :${port}`, (err, stdout) => {
      if (err || !stdout.trim()) {
        portDetails.delete(port);
        return resolve(null);
      }
      const lines = stdout.trim().split('\n');
      let foundPid = null;
      for (const line of lines) {
        const parts = line.trim().split(/\s+/);
        const pid = parts[parts.length - 1];
        if (pid && pid !== '0' && !isNaN(pid)) {
          foundPid = pid;
          break;
        }
      }
      if (!foundPid) {
        portDetails.delete(port);
        return resolve(null);
      }

      exec(`tasklist /FI "PID eq ${foundPid}" /FO CSV /NH`, (tErr, tOut) => {
        if (tErr || !tOut.trim()) {
          const detail = { pid: foundPid, processName: 'node.exe', mem: '' };
          portDetails.set(port, detail);
          return resolve(detail);
        }
        const clean = tOut.trim().replace(/"/g, '');
        const fields = clean.split(',');
        const detail = {
          pid: foundPid,
          processName: fields[0] || 'node.exe',
          mem: fields[4] || ''
        };
        portDetails.set(port, detail);
        resolve(detail);
      });
    });
  });
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
    env: {
      ...process.env,
      FORCE_COLOR: '1',
      PORT: String(service.port || '')
    }
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

function stopService(serviceId) {
  const state = serviceState.get(serviceId);
  if (!state || !state.child || !state.pid) {
    const item = findService(serviceId);
    if (item && item.service.port && portState.get(item.service.port)) {
      return killPort(item.service.port);
    }
    return Promise.resolve({ message: 'Service not actively running in dashboard' });
  }

  return new Promise((resolve) => {
    appendLog(serviceId, `>>> [DASHBOARD] Terminating PID ${state.pid} tree...`);
    exec(`taskkill /pid ${state.pid} /T /F`, (err, stdout, stderr) => {
      state.child = null;
      state.pid = null;
      state.status = 'stopped';
      state.startTime = null;
      if (err) {
        appendLog(serviceId, `>>> [DASHBOARD] Taskkill result: ${stderr || err.message}`);
      } else {
        appendLog(serviceId, `>>> [DASHBOARD] Stopped successfully`);
      }
      resolve({ success: true });
    });
  });
}

function killPort(port) {
  return new Promise((resolve) => {
    exec(`netstat -ano | findstr :${port}`, (err, stdout) => {
      if (err || !stdout.trim()) {
        return resolve({ message: `No process found listening on port ${port}` });
      }
      const lines = stdout.trim().split('\n');
      const pids = new Set();
      for (const line of lines) {
        const parts = line.trim().split(/\s+/);
        const pid = parts[parts.length - 1];
        if (pid && pid !== '0' && !isNaN(pid)) {
          pids.add(pid);
        }
      }

      if (pids.size === 0) {
        return resolve({ message: `No valid PID found for port ${port}` });
      }

      const killPromises = Array.from(pids).map(pid => {
        return new Promise(res => {
          exec(`taskkill /pid ${pid} /T /F`, () => res());
        });
      });

      Promise.all(killPromises).then(() => {
        portState.set(port, false);
        portDetails.delete(port);
        httpHealthState.delete(port);
        resolve({ success: true, killedPids: Array.from(pids) });
      });
    });
  });
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
  if (url.pathname === '/api/status') {
    const payload = config.projects.map(proj => {
      return {
        ...proj,
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
    res.end(JSON.stringify(payload));
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
        const { id, name, directory, description, command, args, port, url: serviceUrl } = JSON.parse(body || '{}');
        if (!name || !directory || !port) {
          throw new Error('name, directory, and port are required fields');
        }
        const projId = id || name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
        const serviceId = `${projId}-dev`;

        let project = config.projects.find(p => p.id === projId || p.directory.toLowerCase() === directory.toLowerCase());
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

        const { service } = found;
        service.port = portNum;
        service.url = `http://localhost:${portNum}`;

        if (Array.isArray(service.args)) {
          const portIdx = service.args.indexOf('--port');
          if (portIdx !== -1 && portIdx + 1 < service.args.length) {
            service.args[portIdx + 1] = String(portNum);
          } else if (service.args.indexOf('-p') !== -1) {
            const pIdx = service.args.indexOf('-p');
            service.args[pIdx + 1] = String(portNum);
          } else if (service.command === 'npm' && service.args[0] === 'run') {
            if (!service.args.includes('--')) {
              service.args.push('--');
            }
            service.args.push('--port', String(portNum));
          }
        }

        fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf-8');
        updatePortStatuses();

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, service }));
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

    res.writeHead(200, { 'Content-Type': contentType });
    res.end(data);
  });
});

server.listen(PORT, () => {
  console.log(`\n Project Dashboard running at: http://localhost:${PORT}\n`);
});
