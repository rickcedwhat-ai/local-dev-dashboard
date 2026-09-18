#!/usr/bin/env node
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = path.join(__dirname, 'projects.json');

function normalizeRepoUrl(raw) {
  if (!raw) return null;
  let url = String(raw).trim();
  if (!url) return null;

  const ssh = url.match(/^git@([^:]+):(.+)$/);
  if (ssh) return `https://${ssh[1]}/${ssh[2].replace(/\.git$/, '')}`;

  const sshUrl = url.match(/^ssh:\/\/git@([^/]+)\/(.+)$/);
  if (sshUrl) return `https://${sshUrl[1]}/${sshUrl[2].replace(/\.git$/, '')}`;

  if (/^https?:\/\//i.test(url)) return url.replace(/\.git$/, '');
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

const args = process.argv.slice(2);
if (args.length < 3) {
  console.log(`
Usage:
  node register.mjs <name> <directory> <port> [command] [args...]

Example:
  node register.mjs "My New App" "/Users/cedrick/Documents/Projects/my-app" 5180
  node register.mjs "Backend API" "/Users/cedrick/Documents/Projects/api" 8080 node server.js
`);
  process.exit(1);
}

const [name, directory, portStr, command = 'npm', ...cmdArgs] = args;
const port = parseInt(portStr, 10);
if (isNaN(port)) {
  console.error('Error: port must be a number');
  process.exit(1);
}

let config = { projects: [] };
try {
  if (fs.existsSync(CONFIG_PATH)) {
    config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
  }
} catch (e) {
  console.error('Error reading projects.json:', e.message);
  process.exit(1);
}

const resolvedDir = path.resolve(directory);
const id = name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
const serviceId = `${id}-dev`;

let project = config.projects.find(p => p.id === id || p.directory?.toLowerCase() === resolvedDir.toLowerCase());
if (!project) {
  project = {
    id,
    name,
    directory: resolvedDir,
    description: '',
    services: []
  };
  config.projects.push(project);
}

project.directory = resolvedDir;
if (!project.repo) {
  const detected = detectRepoFromDirectory(resolvedDir);
  if (detected) project.repo = detected;
}

const finalArgs = cmdArgs.length > 0
  ? cmdArgs
  : (command === 'npm' ? ['run', 'dev', '--', '--port', String(port)] : []);

let service = project.services.find(s => s.id === serviceId);
if (!service) {
  service = {
    id: serviceId,
    name: 'Dev Server',
    command,
    args: finalArgs,
    port,
    url: `http://localhost:${port}`
  };
  project.services.push(service);
} else {
  service.port = port;
  service.command = command;
  service.args = finalArgs;
  service.url = `http://localhost:${port}`;
}

fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf-8');
console.log(`\nSuccessfully registered "${name}" on port ${port} in projects.json!`);
if (project.repo) console.log(`GitHub: ${project.repo}`);
if (project.liveUrl) console.log(`Live:   ${project.liveUrl}`);
console.log('');
