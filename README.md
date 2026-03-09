<p align="center">
  <img src="misc/logo.svg" width="120" alt="Agentlytics">
</p>

<h1 align="center">Agentlytics</h1>

<p align="center">
  <strong>Your Cursor, Windsurf, Claude Code sessions — analyzed, unified, tracked.</strong><br>
  <sub>One command to turn scattered AI conversations from <b>15 editors</b> into a unified analytics dashboard.<br>Sessions, costs, models, tools — finally in one place. 100% local.</sub>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/agentlytics"><img src="https://img.shields.io/npm/v/agentlytics?color=6366f1&label=npm" alt="npm"></a>
  <a href="#supported-editors"><img src="https://img.shields.io/badge/editors-15-818cf8" alt="editors"></a>
  <a href="#license"><img src="https://img.shields.io/badge/license-MIT-green" alt="license"></a>
  <a href="https://nodejs.org"><img src="https://img.shields.io/badge/node-%E2%89%A520.19%20%7C%20%E2%89%A522.12-brightgreen" alt="node"></a>
</p>

<p align="center">
  <img src="misc/screenshot.png" alt="Agentlytics dashboard" width="100%">
</p>

---

## The Problem

You switch between Cursor, Windsurf, Claude Code, VS Code Copilot, and more — each with its own siloed conversation history.

- ✗ Sessions scattered across editors, no unified view
- ✗ No idea how much you're spending on AI tokens
- ✗ Can't compare which editor is more effective
- ✗ Can't search across all your AI conversations
- ✗ No way to share session context with your team

## The Solution

**One command. Full picture. All local.**

```bash
npx agentlytics
```

Opens at **http://localhost:4637**. Requires Node.js ≥ 20.19 or ≥ 22.12, macOS. No data ever leaves your machine.

```
$ npx agentlytics

(● ●) [● ●] Agentlytics
{● ●} <● ●> Unified analytics for your AI coding agents

Looking for AI coding agents...
   ✓ Cursor              498 sessions
   ✓ Windsurf             20 sessions
   ✓ Windsurf Next        56 sessions
   ✓ Claude Code           6 sessions
   ✓ VS Code              23 sessions
   ✓ Zed                   1 session
   ✓ Codex                 3 sessions
   ✓ Gemini CLI            2 sessions
   ...and 6 more

(● ●) [● ●] {● ●} <● ●> ✓ 691 analyzed, 360 cached (27.1s)
✓ Dashboard ready at http://localhost:4637
```

To only build the cache without starting the server:

```bash
npx agentlytics --collect
```

## Features

- **Dashboard** — KPIs, activity heatmap, editor breakdown, coding streaks, token economy, peak hours, top models & tools
- **Sessions** — Search, filter, and read full conversations with syntax highlighting. Open any chat in a slide-over sidebar.
- **Costs** — Estimate your AI spend broken down by model, editor, project, and month. Spot your most expensive sessions.
- **Projects** — Per-project analytics: sessions, messages, tokens, models, editor breakdown, and drill-down detail views
- **Deep Analysis** — Tool frequency heatmaps, model distribution, token breakdown, and filterable drill-down analytics
- **Compare** — Side-by-side editor comparison with efficiency ratios, token usage, and session patterns
- **Relay** — Share AI session context across your team via MCP

## Supported Editors

| Editor | Msgs | Tools | Models | Tokens |
|--------|:----:|:-----:|:------:|:------:|
| **Cursor** | ✅ | ✅ | ✅ | ✅ |
| **Windsurf** | ✅ | ✅ | ✅ | ✅ |
| **Windsurf Next** | ✅ | ✅ | ✅ | ✅ |
| **Antigravity** | ✅ | ✅ | ✅ | ✅ |
| **Claude Code** | ✅ | ✅ | ✅ | ✅ |
| **VS Code** | ✅ | ✅ | ✅ | ✅ |
| **VS Code Insiders** | ✅ | ✅ | ✅ | ✅ |
| **Zed** | ✅ | ✅ | ✅ | ❌ |
| **OpenCode** | ✅ | ✅ | ✅ | ✅ |
| **Codex** | ✅ | ✅ | ✅ | ✅ |
| **Gemini CLI** | ✅ | ✅ | ✅ | ✅ |
| **Copilot CLI** | ✅ | ✅ | ✅ | ✅ |
| **Cursor Agent** | ✅ | ❌ | ❌ | ❌ |
| **Command Code** | ✅ | ✅ | ❌ | ❌ |
| **Goose** | ✅ | ✅ | ✅ | ❌ |

> Windsurf, Windsurf Next, and Antigravity must be running during scan.

## Relay

Relay enables multi-user context sharing across a team. One person starts a relay server, others join and share selected project sessions. An MCP server is exposed so AI clients can query across everyone's coding history.

### Start a relay

```bash
npx agentlytics --relay
```

Optionally protect with a password:

```bash
RELAY_PASSWORD=secret npx agentlytics --relay
```

This starts a relay server on port `4638` and prints the join command and MCP endpoint:

```
  ⚡ Agentlytics Relay

  Share this command with your team:
    cd /path/to/project
    npx agentlytics --join 192.168.1.16:4638

  MCP server endpoint (add to your AI client):
    http://192.168.1.16:4638/mcp
```

### Join a relay

```bash
cd /path/to/your-project
npx agentlytics --join <host:port>
```

If the relay is password-protected:

```bash
RELAY_PASSWORD=secret npx agentlytics --join <host:port>
```

Username is auto-detected from `git config user.email`. You can override it with `--username <name>`.

You'll be prompted to select which projects to share. The client then syncs session data to the relay every 30 seconds.

### MCP Tools

Connect your AI client to the relay's MCP endpoint (`http://<host>:4638/mcp`) to access these tools:

| Tool | Description |
|------|-------------|
| `list_users` | List all connected users and their shared projects |
| `search_sessions` | Full-text search across all users' chat messages |
| `get_user_activity` | Get recent sessions for a specific user |
| `get_session_detail` | Get full conversation messages for a session |

Example query to your AI: *"What did alice do in auth.js?"*

### Relay REST API

| Endpoint | Description |
|----------|-------------|
| `GET /relay/health` | Health check and user count |
| `GET /relay/users` | List connected users |
| `GET /relay/search?q=<query>` | Search messages across all users |
| `GET /relay/activity/:username` | User's recent sessions |
| `GET /relay/session/:chatId` | Full session detail |
| `POST /relay/sync` | Receives data from join clients |

> Relay is designed for trusted local networks. Set `RELAY_PASSWORD` env on both server and clients to enable password protection.

## How It Works

```
Editor files/APIs → editors/*.js → cache.js (SQLite) → server.js (REST) → React SPA
```

```
Relay:  join clients → POST /relay/sync → relay.db (SQLite) → MCP server → AI clients
```

All data is normalized into a local SQLite cache at `~/.agentlytics/cache.db`. The Express server exposes read-only REST endpoints consumed by the React frontend. Relay data is stored separately in `~/.agentlytics/relay.db`.

## API

| Endpoint | Description |
|----------|-------------|
| `GET /api/overview` | Dashboard KPIs, editors, modes, trends |
| `GET /api/daily-activity` | Daily counts for heatmap |
| `GET /api/dashboard-stats` | Hourly, weekday, streaks, tokens, velocity |
| `GET /api/chats` | Paginated session list |
| `GET /api/chats/:id` | Full chat with messages |
| `GET /api/projects` | Project-level aggregations |
| `GET /api/deep-analytics` | Tool/model/token breakdowns |
| `GET /api/tool-calls` | Individual tool call instances |
| `GET /api/refetch` | SSE: wipe cache and rescan |

All endpoints accept optional `editor` filter. See **[API.md](API.md)** for full request/response documentation.

## Roadmap

- [ ] **Offline Windsurf/Antigravity support** — Read cascade data from local file structure instead of requiring the app to be running (see below)
- [ ] **LLM-powered insights** — Use an LLM to analyze session patterns, generate summaries, detect coding habits, and surface actionable recommendations
- [ ] **Linux & Windows support** — Adapt editor paths for non-macOS platforms
- [ ] **Export & reports** — PDF/CSV export of analytics and session data
- [x] **Cost tracking** — Estimate API costs per editor/model based on token usage

## Contributions Needed

**Windsurf / Windsurf Next / Antigravity offline reading** — Currently these editors require their app to be running because data is fetched via ConnectRPC from the language server process. Unlike Cursor or Claude Code, there's no known local file structure to read cascade history from. If you know where Windsurf stores trajectory data on disk, or can help reverse-engineer the storage format, contributions are very welcome.

**LLM-based analytics** — We'd love to add intelligent analysis on top of the raw data — session summaries, coding pattern detection, productivity insights, and natural language queries over your agent history. If you have ideas or want to build this, open an issue or PR.

## Contributing

See **[CONTRIBUTING.md](CONTRIBUTING.md)** for development setup, editor adapter details, database schema, and how to add support for new editors.

## License

MIT — Built by [@f](https://github.com/f)
