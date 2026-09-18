# Local Dev Dashboard

A zero-dependency local dashboard to monitor, start, stop, and inspect dev servers across all your local projects.

## Features

- **No external dependencies**: Runs entirely on native Node.js (`http`, `net`, `child_process`).
- **Port detection**: Actively probes IPv4 (`127.0.0.1`) and IPv6 (`::1`) TCP sockets every ~2.5 seconds. Identifies servers whether started inside the dashboard, by Cursor/VS Code, or by agents.
- **Cross-platform process control**: On macOS/Linux uses `lsof` + process-group kill; on Windows uses `netstat`/`taskkill /T` so Vite/esbuild child trees exit cleanly.
- **Kill Port utility**: If a stale external process is holding a port, click "Kill Port" to inspect and terminate the process holding it.
- **Real-time logs**: Click "Logs" on any service to stream live terminal stdout and stderr via Server-Sent Events (SSE).
- **Hot-reloading configuration**: Edits to `projects.json` are picked up automatically without restarting the server.

## Quick Start

```bash
node server.mjs
# or: npm start
# or: ./start.sh
```

On Windows you can also double-click `start.bat`.

Open `http://localhost:4000` in your browser.

Copy `projects.example.json` → `projects.json` (done automatically on first run if missing) and point `directory` paths at your local repos.

## Configuration (`projects.json`)

```json
{
  "projects": [
    {
      "id": "my-project",
      "name": "My Project",
      "directory": "/Users/cedrick/Documents/Projects/my-project",
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

### Project links

Each project has a `links` array. Entries marked `pinned` render as chips on the card
(up to three); the rest collapse into a `•••` menu. `repo` and `liveUrl` are kept in
sync with the GitHub and Live entries for avatar and git auto-detection.

```json
"links": [
  { "label": "GitHub", "url": "https://github.com/example/my-app", "pinned": true },
  { "label": "Linear", "url": "https://linear.app/example" },
  { "label": "Sentry", "url": "https://example.sentry.io/issues/", "space": "Personal" }
]
```

### Opening links in a specific Arc space

Arc ignores Chromium's `--profile-directory` flag, so links normally open in whatever
profile is focused. Routing a link through AppleScript into a named Arc space opens it
in the profile bound to that space instead.

Which space a link uses resolves in three steps, most specific first:

1. `space` on the link itself
2. `defaultArcSpace` on the project
3. `defaultArcSpace` at the top level of `projects.json` (defaults to `Me`)

Set these from the project's settings gear; the dropdowns list the spaces of your front
Arc window. Choose "System browser" to bypass Arc targeting entirely. Cmd-click always
opens normally in the current profile.

## Register a project

```bash
node register.mjs "My New App" "/Users/cedrick/Documents/Projects/my-app" 5180
```

Or POST to `http://localhost:4000/api/register` while the dashboard is running (see `AGENT_INSTRUCTIONS.md`).
