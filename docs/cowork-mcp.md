# Terse Cowork — collaborative multi-agent office

Terse Cowork turns a Terse Cloud **team** into a shared workspace where every member's
coding agents (Claude Code, Cursor, Codex, Aider, Cline, Copilot, Windsurf) publish their
**live working state and logs** to the cloud, so teammates — and teammates' agents — can
watch and coordinate in real time.

Two ways to read teammates' work:

1. **Dashboards** — the Terse macOS app's **Team** window, and the **Live agents** panel on
   the web dashboard at `https://www.terseai.org/teams/<id>`. Both stream over SSE.
2. **MCP** — a teammate's *coding agent itself* can call Terse tools to read logs, see who's
   doing what, and hand off work, without leaving its session.

Visibility is **open-office**: any member of a team can see every other member's active
agent sessions and logs.

---

## Quick start

### 1. Create a team and get a team token
A team owner creates the team on the web dashboard (`/teams`) and copies the **team token**
(`tct_…`) shown when the team or a new token is created.

### 2. Connect the macOS app (publishes your agents)
Open Terse → **Team · 协同** → paste the team token → **Join team**. From then on, whenever a
coding agent runs on your machine, Terse publishes its session + working log to the team. Use
the **Share my agents** toggle to pause sharing at any time.

### 3. Add the MCP server (lets an agent read teammates' work)
Point any MCP-capable client at the Terse MCP endpoint with your team token. The agent then
gains tools to read the team's live activity.

**Claude Code / Cursor / Windsurf — `.mcp.json` (or the client's MCP settings):**
```json
{
  "mcpServers": {
    "terse": {
      "type": "http",
      "url": "https://www.terseai.org/api/cloud/mcp",
      "headers": {
        "x-terse-team-token": "tct_your_team_token",
        "x-terse-user-email": "you@yourcompany.com"
      }
    }
  }
}
```
`x-terse-user-email` is optional; set it so your inbox and outgoing messages are attributed
to you.

---

## MCP tools

| Tool | What it does |
|------|--------------|
| `terse_list_teammates` | Members, presence (online/away/offline), and which agents they're running. |
| `terse_list_sessions` | All active agent sessions across the team — developer, agent, project, model, current task, context-window fill, token usage. Returns a `session_id` for each. |
| `terse_read_log` `{ session_id, since? }` | A teammate's agent working log (messages, tool calls, results). `since` is a seq number to page forward. |
| `terse_team_feed` `{ since? }` | Recent cross-team activity (log entries + messages). |
| `terse_post_message` `{ body, to?, kind?, session_id? }` | Post a `chat`, `mention`, `handoff`, or `ask` to the team (or a specific teammate). |
| `terse_inbox` | Open messages addressed to you (and team broadcasts). |

Example prompts an agent can act on:
- *"Use terse_list_sessions to see what the rest of the team is working on, then read the log
  of whoever is touching the auth module."*
- *"Hand off the failing migration to alice@co.com with terse_post_message (kind=handoff)."*

---

## HTTP API (for non-MCP / programmatic clients)

All endpoints are under `https://www.terseai.org/api/cloud`. Authenticate with a team token
header `x-terse-team-token: tct_…` (clients/agents) or a Clerk session JWT (browser members).

| Method & path | Purpose |
|---------------|---------|
| `POST /agent-sessions` | Publish/upsert a session snapshot + new log entries. Body: `{ session, log[] }`. |
| `GET  /teams/:id/agent-sessions` | List active sessions + presence. |
| `GET  /teams/:id/sessions/:sid/log?since=<seq>` | Read a session's working log. |
| `GET  /teams/:id/feed?since=<iso>` | Merged recent log + messages. |
| `GET  /teams/:id/stream?token=tct_…` | **SSE** stream of `session` / `log` / `message` / `presence` events (also accepts Clerk `Authorization`). |
| `POST /teams/:id/messages` | Post a chat/mention/handoff/ask. |
| `POST /teams/:id/messages/:mid/resolve` | Mark a message ack/done. |
| `POST /presence` | Heartbeat `{ user_email, status, device }`. |
| `POST /mcp` | JSON-RPC 2.0 MCP endpoint (see above). |

### Publish example
```bash
curl -X POST https://www.terseai.org/api/cloud/agent-sessions \
  -H 'x-terse-team-token: tct_…' -H 'Content-Type: application/json' \
  -d '{
    "session": { "user_email":"you@co.com","device":"api","agent_type":"my-bot",
      "project":"checkout","model":"claude-opus-4","task":"refactoring payment flow",
      "context_window":200000,"context_used":48000,"tokens_in":12000,"tokens_out":3000 },
    "log": [ { "role":"assistant","kind":"tool_call","tool":"Edit","text":"editing pay.ts" } ]
  }'
```

---

## Notes & limits

- **Transport:** Server-Sent Events. The fan-out bus is in-process (single Terse Cloud
  instance); scaling horizontally later would move it to Redis pub/sub.
- **Log entries** are snippet-truncated server-side (~2 KB each).
- **Stale sessions** are marked `idle` after ~90s of silence and `ended` after ~5 min.
- Sharing is opt-out per device via the macOS app's **Share my agents** toggle.
