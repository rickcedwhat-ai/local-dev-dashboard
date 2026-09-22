# Local Dev Dashboard — Agent Protocol

**Protocol version: 2**

Tool-agnostic (Cursor, Antigravity, Claude Code, Copilot Chat, etc.). Canonical copy lives on the dashboard — **pull it**, don’t rely on pasted prompts staying fresh.

## Session start (required)

```bash
curl -sS http://localhost:4000/api/agent-protocol
```

1. Read `protocol` + `instructions`.
2. Write `instructions` to **`AGENTS.md`** in this project root (optional: also mirror to your editor’s rules file).
3. Use that `protocol` number on every later dashboard POST.

If any dashboard response has `"stale": true`, repeat this pull, update `AGENTS.md`, then retry with the new protocol. Do **not** expect full instructions in the stale POST body — only `protocolUrl` / `message`.

Dashboard repo (this machine): `/Users/cedrick/Documents/Projects/local-dev-dashboard`  
Base URL: `http://localhost:4000`

---

## GitHub CLI (`gh`) — Cursor sandbox

On this machine, GitHub CLI is normally logged in as **`rickcedwhat-ai`** (keyring). That auth is fine.

Cursor **agent shells default to a sandbox** with a limited network allowlist. In that sandbox, `gh api` / `gh issue` / `gh pr` often fail with **HTTP Forbidden** (sometimes misreported as “token in keyring is invalid”). This is **not** broken auth.

**Required:** when running any `gh` command that talks to GitHub, request elevated permissions so the command is **not** limited to the default sandbox allowlist:

- Prefer `required_permissions: ["full_network"]`
- Or `required_permissions: ["all"]` if keyring/credential access is also blocked

If `gh` returns Forbidden / “keyring is invalid” under the default sandbox:

1. **Do not** run `gh auth logout`, `gh auth refresh`, or paste tokens.
2. Re-run the same `gh` command with `full_network` or `all` and approve the permission prompt.
3. Only treat auth as broken if the same command fails in a normal Terminal.app window outside Cursor.

Antigravity and unsandboxed terminals are unaffected.

---

## Register a project

**Preferred (portable)** — works as long as the dashboard is running:

```bash
curl -sS -X POST http://localhost:4000/api/register \
  -H 'Content-Type: application/json' \
  -d '{"protocol":2,"name":"Project Name","directory":"/absolute/path","port":5180}'
```

Optional local helper (only if you have the dashboard checkout):

```bash
export LOCAL_DEV_DASHBOARD=/Users/cedrick/Documents/Projects/local-dev-dashboard
node "$LOCAL_DEV_DASHBOARD/register.mjs" "<Project Name>" "<absolute-directory>" <port>
```

Confirm name, directory, and port after registering.

---

## Agent activity (required when working on a PR)

Tell the dashboard when you **start** and **finish** work so the card shows “agent working” and humans don’t interrupt mid-fix.

### Start

Replace `<PR_NUMBER>` with the **active** pull request for this branch (do not copy a stale example number).

```bash
curl -sS -X POST http://localhost:4000/api/agent-activity \
  -H 'Content-Type: application/json' \
  -d '{
    "protocol": 2,
    "phase": "start",
    "directory": "/absolute/path/to/this/project",
    "pr": <PR_NUMBER>,
    "summary": "Fixing CodeRabbit actionable comments",
    "agent": "cursor"
  }'
```

Use `"agent": "antigravity"` / `"claude-code"` / etc. when relevant. Identify the project with `directory` (preferred), `projectId`, or `repo`.

### Heartbeat (optional)

Send another `phase: "start"` with an updated `summary` during long sessions so activity doesn’t auto-expire (~45 minutes).

### Finish

```bash
curl -sS -X POST http://localhost:4000/api/agent-activity \
  -H 'Content-Type: application/json' \
  -d '{
    "protocol": 2,
    "phase": "finish",
    "directory": "/absolute/path/to/this/project",
    "summary": "CR comments addressed; waiting on CI"
  }'
```

---

## Manual projects.json shape (rare)

```json
{
  "id": "my-project",
  "name": "My Project",
  "directory": "/Users/cedrick/Documents/Projects/my-project",
  "description": "Short description",
  "services": [
    {
      "id": "my-project-dev",
      "name": "Dev Server",
      "command": "npm",
      "args": ["run", "dev", "--", "--port", "5180"],
      "port": 5180,
      "url": "http://localhost:5180"
    }
  ]
}
```

The dashboard hot-reloads `projects.json`.
