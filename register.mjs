#!/usr/bin/env node
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = path.join(__dirname, 'projects.json');

const args = process.argv.slice(2);
if (args.length < 3) {
  console.log(`
Usage:
  node register.mjs <name> <directory> <port> [command] [args...]

Example:
  node register.mjs "My New App" "C:\\path\\to\\app" 5180
  node register.mjs "Backend API" "C:\\path\\to\\api" 8080 node server.js
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

const id = name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
const serviceId = `${id}-dev`;

let project = config.projects.find(p => p.id === id || p.directory.toLowerCase() === path.resolve(directory).toLowerCase());
if (!project) {
  project = {
    id,
    name,
    directory: path.resolve(directory),
    description: '',
    services: []
  };
  config.projects.push(project);
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
console.log(`\nSuccessfully registered "${name}" on port ${port} in projects.json!\n`);
