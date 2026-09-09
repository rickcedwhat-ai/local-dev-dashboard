# Local Dev Dashboard

A zero-dependency local dashboard to monitor, start, stop, and inspect dev servers across all your local projects.

## Features

- **No external dependencies**: Runs entirely on native Node.js (`http`, `net`, `child_process`).
- **Port detection**: Actively probes IPv4 (`127.0.0.1`) and IPv6 (`::1`) TCP sockets every 2 seconds. Identifies servers whether started inside the dashboard, by VS Code, or by autonomous agents.
- **Process tree termination on Windows**: Uses `taskkill /pid <PID> /T /F` to ensure child and grandchild processes (Vite, esbuild, node) are cleanly terminated without leaving orphaned port locks.
- **Kill Port utility**: If a stale external process is holding a port, click "Kill Port" to inspect and terminate the process holding it.
- **Real-time logs**: Click "Logs" on any service to stream live terminal stdout and stderr via Server-Sent Events (SSE).
- **Hot-reloading configuration**: Edits to `projects.json` are picked up automatically without restarting the server.

## Quick Start

```powershell
node server.mjs
# or double-click start.bat
```

Open `http://localhost:4000` in your browser.

## Porting to Your Other Laptop

1. Copy the `dev-dashboard` folder (or push it to a private git repo).
2. Edit `projects.json` to point the `directory` paths to wherever your repos are cloned on the other machine.
3. Run `node server.mjs`.

## Configuration (`projects.json`)

```json
{
  "projects": [
    {
      "id": "my-project",
      "name": "My Project",
      "directory": "C:\\path\\to\\project",
      "description": "Short description",
      "services": [
        {
          "id": "my-service-dev",
          "name": "Dev Server",
          "command": "npm",
          "args": ["run", "dev", "--", "--port", "5173"],
          "port": 5173,
          "url": "http://localhost:5173"
        }
      ]
    }
  ]
}
```
