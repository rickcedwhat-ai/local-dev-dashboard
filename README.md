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

## Recent project chats

Each project detail view shows its three most recently updated chats. Codex chats
are discovered from local App Server metadata every 30 seconds while the dashboard
is being viewed. Chat titles and timestamps are read without resuming sessions. Working/waiting
indicators inspect lifecycle event names and timestamps from a bounded local session
tail; message contents are neither retained nor exposed to the browser. Archived chats and subagents are excluded. Matching is
by the registered project directory; projectless chats are not assigned by guesswork.
Click a row to open the exact chat with `codex://threads/<id>`.

The activity endpoint also accepts editor-neutral `agent`, `chatId`, `chatTitle`,
and optional `openUrl` fields. Send the same agent/chat ID with both start and finish.
Cursor and Antigravity records are supported now; their automatic discovery adapters
and verified native chat links can be added later. Legacy activity clients still work.
Recent activity records persist locally in ignored `recent-chats.json`; Codex discovery
is refreshed from its metadata service. Set `CODEX_BIN` to override the CLI executable.
If Codex is unavailable, activity-fed chats and the last successful in-memory results
remain visible. Run `npm test` for persistence, routing, and concurrent activity checks.

Chat status uses blue **Working**, amber **Waiting for you**, and muted **Paused**
or **Status unavailable** labels. Completed turns are Idle. Waiting for you means a structured input or approval
request is still pending; ordinary completion never implies a question. Blocking
input/permission calls get a more specific tooltip when present in local events.
Unfinished turns without fresh events for two minutes become unknown rather than
remaining falsely active after a crash. Missing or inaccessible session files are
also unknown. This is local lifecycle evidence, not a desktop runtime subscription;
these adapters deliberately do not open chats, answer prompts, or resume turns.
Other editors can report `chatStatus` through the existing activity endpoint; those
reports expire after 45 minutes. Status refreshes with the dashboard poll (file
reads are cached for up to five seconds).

## Shared PR controls

The dashboard and Arc widget share `public/pr-card-shared.js` and
`public/pr-card-shared.css`: menu decisions, CR chip styles and the CI/review
comet painters. After changing them, sync the plugin copy using
`node /Users/cedrick/Documents/Codex/2026-10-16/lot/work/sync-arc-pr-assets.mjs`.

Waiting-on-author and quiet marks persist in ignored `pr-marks.json` and travel
with `/api/status`. `/api/pr-marks` accepts per-field patches; old localStorage
marks import once per page without overwriting server records. Empty server
records act as tombstones to prevent old browser imports restoring cleared marks.
LocalStorage remains a cache and migration source. Project tab selections still
live only in localStorage.

The widget uses the existing CR action endpoints only after a user selects an
available menu action. It refreshes status every 15 seconds while visible, pauses
while hidden/offscreen, and backs off during outages. No mutation or review is
triggered by polling. Menu actions and network errors are tested with mocks.
