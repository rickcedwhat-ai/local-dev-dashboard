# How to Hook a New Project into the Dev Dashboard

When an AI agent (or you) creates or sets up a new local project, here is how to register it with the dashboard:

## Option 1: Tell the Agent directly (simplest)
Just include this in your prompt:
> "Hook this project into my dev dashboard at `C:\Users\ccata\OneDrive\Documents\Career\dev-dashboard` on port 5180"

The agent will run:
```powershell
node "C:\Users\ccata\OneDrive\Documents\Career\dev-dashboard\register.mjs" "Project Name" "C:\path\to\project" 5180
```

## Option 2: Register via API (HTTP POST)
If the dashboard is running on port 4000, any agent or curl script can call:
```powershell
Invoke-RestMethod -Uri "http://localhost:4000/api/register" -Method Post -ContentType "application/json" -Body (@{
  name = "Project Name"
  directory = "C:\path\to\project"
  port = 5180
} | ConvertTo-Json)
```

## Option 3: Manual / Direct Edit
Add an object to the `projects` array in `projects.json`:
```json
{
  "id": "my-project",
  "name": "My Project",
  "directory": "C:\\path\\to\\project",
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
The dashboard watches `projects.json` and hot-reloads it instantly without requiring a server restart.
