<p align="center">
  <img src="misc/logo.svg" width="120" alt="Agentlytics">
</p>

<h1 align="center">Agentlytics</h1>

<p align="center">
  <strong>Unified analytics for your AI coding agents</strong><br>
  <sub>Cursor · Windsurf · Claude Code · VS Code Copilot · Zed · Antigravity · OpenCode</sub>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/agentlytics"><img src="https://img.shields.io/npm/v/agentlytics?color=6366f1&label=npm" alt="npm"></a>
  <a href="#supported-editors"><img src="https://img.shields.io/badge/editors-9-818cf8" alt="editors"></a>
  <a href="#license"><img src="https://img.shields.io/badge/license-MIT-green" alt="license"></a>
  <a href="https://nodejs.org"><img src="https://img.shields.io/badge/node-%E2%89%A518-brightgreen" alt="node"></a>
</p>

<p align="center">
  <video src="https://github.com/user-attachments/assets/e6934f58-84e0-4173-b4bf-4b0331dd1428" autoplay loop muted playsinline width="100%"></video>
</p>

---

Agentlytics reads local chat history from every major AI coding assistant and presents a unified analytics dashboard in your browser. **No data ever leaves your machine** — everything runs locally against SQLite databases and local files.

## Quick Start

```bash
npx agentlytics
```

Or install globally:

```bash
npm install -g agentlytics
agentlytics
```

The dashboard opens automatically at **http://localhost:4637**.

> **Requires:** Node.js ≥ 18, macOS (currently the only supported platform)

## Features

- **Dashboard** — KPIs, activity heatmap, editor breakdown, mode distribution, top projects, coding streaks, token economy, peak hours, session depth, conversation velocity, top models & tools
- **Sessions** — Paginated list with search, editor filter, full conversation viewer with syntax-highlighted markdown, tool call details, and diff views
- **Projects** — Per-project analytics with sessions, messages, tokens, tool calls, models, and editor breakdown
- **Deep Analysis** — Tool call frequency, model distribution, token breakdown. Click any tool to drill into individual calls with full arguments
- **Compare** — Side-by-side editor comparison with efficiency ratios, grouped bar charts, tool and model breakdowns
- **Refetch** — One-click cache rebuild with live SSE progress

## Supported Editors

| Editor | Source ID | Data Source | Msgs | Tools | Models | Tokens |
|--------|-----------|-------------|:----:|:-----:|:------:|:------:|
| **Cursor** | `cursor` | Local SQLite + state.vscdb | ✅ | ✅ | ⚠️ | ⚠️ |
| **Windsurf** | `windsurf` | ConnectRPC (language server) | ✅ | ✅ | ✅ | ✅ |
| **Windsurf Next** | `windsurf-next` | ConnectRPC (language server) | ✅ | ✅ | ✅ | ✅ |
| **Antigravity** | `antigravity` | ConnectRPC (HTTPS) | ✅ | ✅ | ✅ | ✅ |
| **Claude Code** | `claude-code` | `~/.claude/projects/` JSONL | ✅ | ✅ | ✅ | ✅ |
| **VS Code** | `vscode` | Copilot Chat JSONL | ✅ | ✅ | ✅ | ✅ |
| **VS Code Insiders** | `vscode-insiders` | Copilot Chat JSONL | ✅ | ✅ | ✅ | ✅ |
| **Zed** | `zed` | SQLite + zstd blobs | ✅ | ✅ | ✅ | ❌ |
| **OpenCode** | `opencode` | SQLite | ✅ | ✅ | ✅ | ✅ |

> **Note:** Windsurf, Windsurf Next, and Antigravity must be running during scan — data is served from their language server process.

## How It Works

```
Editor files/APIs → editors/*.js → cache.js (SQLite) → server.js (REST) → React SPA
```

1. **Editor adapters** read chat data from local files, databases, or running processes
2. **Cache layer** normalizes everything into `~/.agentlytics/cache.db`
3. **Express server** exposes read-only REST endpoints
4. **React frontend** renders charts via Chart.js

## Development

```bash
git clone https://github.com/f/agentlytics.git
cd agentlytics && npm install

# Frontend dev server (port 5173, proxies API to backend)
cd ui && npm install && npm run dev

# Backend (port 4637) — in another terminal
npm start
```

### CLI Options

```bash
agentlytics              # normal start (uses cache)
agentlytics --no-cache   # wipe cache and full rescan
```

## API Reference

All endpoints are `GET` and return JSON.

| Endpoint | Description | Params |
|----------|-------------|--------|
| `/api/overview` | Dashboard KPIs, editors, modes, monthly trend | `editor` |
| `/api/daily-activity` | Daily activity for heatmap | `editor` |
| `/api/dashboard-stats` | Detailed stats: hourly, weekday, streaks, tokens, velocity | `editor` |
| `/api/chats` | Paginated chat list | `editor`, `folder`, `named`, `limit`, `offset` |
| `/api/chats/:id` | Full chat with messages and stats | — |
| `/api/projects` | All projects with aggregated analytics | — |
| `/api/deep-analytics` | Tool/model/token aggregations | `editor`, `folder`, `limit` |
| `/api/tool-calls` | Individual tool call instances | `name` *(required)*, `folder`, `limit` |
| `/api/refetch` | SSE stream: wipe cache and rescan | — |

<details>
<summary><strong>Database Schema</strong></summary>

Location: `~/.agentlytics/cache.db`

**`chats`** — one row per session

| Column | Type | Description |
|--------|------|-------------|
| `id` | TEXT PK | Unique chat ID |
| `source` | TEXT | Editor identifier |
| `name` | TEXT | Chat title |
| `mode` | TEXT | Session mode |
| `folder` | TEXT | Project directory |
| `created_at` | INTEGER | Creation timestamp (ms) |
| `last_updated_at` | INTEGER | Last update (ms) |
| `bubble_count` | INTEGER | Message count |
| `encrypted` | INTEGER | 1 if encrypted |

**`messages`** — individual messages (truncated at 50K chars)

| Column | Type | Description |
|--------|------|-------------|
| `chat_id` | TEXT FK | → `chats.id` |
| `seq` | INTEGER | Sequence number |
| `role` | TEXT | `user` / `assistant` / `system` / `tool` |
| `content` | TEXT | Message text |
| `model` | TEXT | Model name |
| `input_tokens` | INTEGER | Input tokens |
| `output_tokens` | INTEGER | Output tokens |

**`chat_stats`** — pre-aggregated per chat

| Column | Type | Description |
|--------|------|-------------|
| `chat_id` | TEXT PK | → `chats.id` |
| `total_messages` | INTEGER | Total count |
| `tool_calls` | TEXT | JSON array of tool names |
| `models` | TEXT | JSON array of model names |
| `total_input_tokens` | INTEGER | Sum of input tokens |
| `total_output_tokens` | INTEGER | Sum of output tokens |
| `total_cache_read` | INTEGER | Cache read tokens |
| `total_cache_write` | INTEGER | Cache write tokens |

**`tool_calls`** — individual tool invocations

| Column | Type | Description |
|--------|------|-------------|
| `chat_id` | TEXT FK | → `chats.id` |
| `tool_name` | TEXT | Function name |
| `args_json` | TEXT | Full arguments |
| `source` | TEXT | Editor |
| `folder` | TEXT | Project directory |
| `timestamp` | INTEGER | Timestamp (ms) |

</details>

<details>
<summary><strong>Editor Adapter Details</strong></summary>

### Cursor
Reads from two stores: **Agent Store** (`~/.cursor/chats/<workspace>/<chatId>/store.db`) with content-addressed SHA-256 blob trees, and **Workspace Composers** (`~/Library/Application Support/Cursor/User/`) with `state.vscdb` databases. Limitation: no model names persisted.

### Windsurf / Windsurf Next / Antigravity
Connects to running language server via ConnectRPC. Discovers process via `ps aux`, extracts CSRF token + port via `lsof`, calls `GetAllCascadeTrajectories` and `GetCascadeTrajectory`.

### Claude Code
Reads `~/.claude/projects/<encoded-path>/sessions-index.json` and individual `.jsonl` session files.

### VS Code / VS Code Insiders
Reads Copilot Chat `.jsonl` files from workspace storage. Reconstructs state via `kind:0` (init) and `kind:1` (JSON patch) records.

### Zed
Reads `~/Library/Application Support/Zed/threads/threads.db` — zstd-compressed JSON blobs decompressed via CLI.

### OpenCode
Reads `~/.local/share/opencode/opencode.db` directly via SQL.

</details>

<details>
<summary><strong>Adding a New Editor</strong></summary>

Create `editors/<name>.js`:

```javascript
module.exports = {
  name: 'my-editor',
  getChats() {
    return [{ source: 'my-editor', composerId: '...', name: '...', mode: 'agent',
              folder: '/path', createdAt: Date.now(), lastUpdatedAt: Date.now() }];
  },
  getMessages(chat) {
    return [{ role: 'user', content: '...', _model: 'gpt-4',
              _toolCalls: [{ name: 'read_file', args: { path: '/foo.js' } }] }];
  },
};
```

Register in `editors/index.js` and add color/label in `ui/src/lib/constants.js`.

</details>

## License

MIT — Built by [@f](https://github.com/f)
