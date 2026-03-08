# Contributing to Agentlytics

## Architecture

```
Editor files/APIs → editors/*.js → cache.js (SQLite) → server.js (REST) → React SPA
```

1. **Editor adapters** (`editors/*.js`) — read chat data from local files, databases, or running processes
2. **Cache layer** (`cache.js`) — normalizes everything into `~/.agentlytics/cache.db`
3. **Express server** (`server.js`) — read-only REST endpoints
4. **React frontend** (`ui/`) — Chart.js-powered SPA

## Development Setup

```bash
git clone https://github.com/f/agentlytics.git
cd agentlytics && npm install

# Frontend dev server (port 5173, proxies API to backend)
cd ui && npm install && npm run dev

# Backend (port 4637) — in another terminal
npm start
```

The Vite dev server proxies `/api/*` requests to the backend via `vite.config.js`.

### CLI Options

```bash
agentlytics              # normal start (uses cache)
agentlytics --no-cache   # wipe cache and full rescan
```

---

## Adding a New Editor

1. Create `editors/<name>.js` with the adapter interface:

```javascript
module.exports = {
  name: 'my-editor',
  // Optional: list of source IDs this adapter handles
  // sources: ['my-editor', 'my-editor-beta'],

  getChats() {
    return [{
      source: 'my-editor',       // editor identifier
      composerId: '...',          // unique chat ID
      name: '...',                // chat title (nullable)
      createdAt: 1234567890,      // timestamp in ms (nullable)
      lastUpdatedAt: 1234567890,  // timestamp in ms (nullable)
      mode: 'agent',              // session mode (nullable)
      folder: '/path/to/project', // working directory (nullable)
      encrypted: false,           // true if messages can't be read
      bubbleCount: 10,            // message count hint (nullable)
    }];
  },

  getMessages(chat) {
    return [{
      role: 'user',           // 'user' | 'assistant' | 'system' | 'tool'
      content: '...',         // message text
      _model: 'gpt-4',       // model name (optional)
      _inputTokens: 500,     // input token count (optional)
      _outputTokens: 200,    // output token count (optional)
      _cacheRead: 100,        // cache read tokens (optional)
      _cacheWrite: 50,        // cache write tokens (optional)
      _toolCalls: [{          // tool calls (optional)
        name: 'read_file',
        args: { path: '/foo.js' },
      }],
    }];
  },
};
```

2. Register in `editors/index.js`:

```javascript
const myEditor = require('./my-editor');
const editors = [...existingEditors, myEditor];
```

3. Add color and label in `ui/src/lib/constants.js`:

```javascript
export const EDITOR_COLORS = { ..., 'my-editor': '#hex' };
export const EDITOR_LABELS = { ..., 'my-editor': 'My Editor' };
```

---

## Editor Adapter Details

### Cursor

Reads from **two separate data stores**:

1. **Agent Store** (`~/.cursor/chats/<workspace>/<chatId>/store.db`)
   - SQLite with `meta` table (hex-encoded JSON) and `blobs` table (content-addressed SHA-256 tree)
   - Meta contains: `agentId`, `latestRootBlobId`, `name`, `createdAt`
   - Messages retrieved by walking the blob tree: tree nodes contain message refs and child refs
   - Tool calls extracted from OpenAI-format `tool_calls` array on assistant messages

2. **Workspace Composers** (`~/Library/Application Support/Cursor/User/`)
   - `workspaceStorage/<hash>/state.vscdb` — `composer.composerData` key holds all composer headers
   - `globalStorage/state.vscdb` — `cursorDiskKV` table with `bubbleId:<composerId>:<n>` keys
   - Each bubble is JSON with `type` (1=user, 2=assistant), `text`, `toolFormerData`, `tokenCount`
   - Tool args from `toolFormerData.rawArgs` with fallback to `toolFormerData.params`

**Limitations:** Cursor does not persist model names per message. Provider name (e.g., "anthropic") extracted from `providerOptions` when available.

### Windsurf / Windsurf Next / Antigravity

Connects to the **running language server** via ConnectRPC (buf Connect protocol):

1. Discovers process via `ps aux` — finds `language_server_macos_arm` with `--csrf_token`
2. Extracts CSRF token and PID, finds listening port via `lsof`
3. `GetAllCascadeTrajectories` → session summaries
4. `GetCascadeTrajectory` → full conversation steps

**Requires the application to be running.** Data is served from the language server process, not from files on disk. Antigravity uses HTTPS.

### Claude Code

Reads from `~/.claude/projects/<encoded-path>/`:
- `sessions-index.json` — session index with titles and timestamps
- Individual `.jsonl` session files — each line is a JSON message with `type`, `role`, `content`, `model`, `usage`
- Tool calls extracted from `tool_use` content blocks and `tool_result` messages

### Codex

Reads from `${CODEX_HOME:-~/.codex}/sessions/**/*.jsonl`:
- `session_meta` — session metadata including `id`, `cwd`, raw `source`, `originator`, and `cli_version`
- `turn_context` — per-turn state such as the current `model`
- `response_item` — visible transcript items for user/assistant messages, reasoning summaries, and tool calls
- `event_msg` where `payload.type === "token_count"` — token usage deltas or cumulative totals

Adapter behavior:
- Titles come from the first meaningful user prompt, skipping Codex bootstrap wrappers like `<user_instructions>` and `<environment_context>`
- Reasoning summaries render as `[thinking] ...`; encrypted reasoning is ignored
- `function_call`, `custom_tool_call`, and `web_search_call` become visible `[tool-call: ...]` transcript lines and populate `_toolCalls` analytics
- `function_call_output` and `custom_tool_call_output` become condensed `[tool-result: ...]` transcript lines
- Token usage prefers `last_token_usage`; when only `total_token_usage` exists, the adapter diffs against the previous cumulative totals
- Models are carried forward from the latest `turn_context`; if none is available, the session still ingests but leaves `_model` unset

### Kimi CLI

Reads from `${KIMI_SHARE_DIR:-~/.kimi}`:
- `kimi.json` — maps working directories to session hashes via `work_dirs[].path`
- `config.toml` — optional `default_model` fallback for assistant messages
- `sessions/<md5(cwd)>/<session-id>/context*.jsonl` — authoritative transcript chunks
- `sessions/<md5(cwd)>/<session-id>/wire.jsonl` — timestamps and per-assistant token usage

Adapter behavior:
- Session folders are discovered by enumerating `sessions/*/*`
- Project folders are resolved by MD5 hashing each `kimi.json` work-dir path and matching it to the session hash
- Transcript chunks include `context_sub_N.jsonl`, `context_N.jsonl`, and `context.jsonl`, ordered oldest-to-newest with archived chunks first
- `_checkpoint` and `_usage` transcript records are skipped as visible messages
- Assistant `tool_calls` become visible `[tool-call: ...]` transcript lines and populate `_toolCalls` analytics
- Tool messages are condensed from text blocks in tool results and linked back to the originating tool name when possible
- Token usage comes from `wire.jsonl` `StatusUpdate` events and is only attached when the number of status updates matches the number of assistant turns
- Historical model attribution is approximate: when no session-level model is stored, assistant messages fall back to `config.toml` `default_model`

### VS Code / VS Code Insiders

Reads from `~/Library/Application Support/{Code,Code - Insiders}/User/`:
- `workspaceStorage/<hash>/state.vscdb` — workspace-to-folder mapping
- Chat sessions stored as `.jsonl` files in the Copilot Chat extension directory
- JSONL reconstruction: `kind:0` = init state, `kind:1` = JSON patch at key path
- Messages, tool calls, and token usage extracted from reconstructed state

### Zed

Reads from `~/Library/Application Support/Zed/threads/threads.db`:
- SQLite database with `threads` table containing zstd-compressed JSON blobs
- Each thread decompressed via `zstd` CLI
- Messages in OpenAI format with `tool_calls` array on assistant messages

### OpenCode

Reads from `~/.local/share/opencode/opencode.db`:
- SQLite database with `session`, `message`, and `project` tables
- Messages queried directly via SQL with full content, model, and token data

---

## Database Schema

Location: `~/.agentlytics/cache.db`

### `chats`

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

### `messages`

| Column | Type | Description |
|--------|------|-------------|
| `chat_id` | TEXT FK | → `chats.id` |
| `seq` | INTEGER | Sequence number |
| `role` | TEXT | `user` / `assistant` / `system` / `tool` |
| `content` | TEXT | Message text (truncated at 50K chars) |
| `model` | TEXT | Model name |
| `input_tokens` | INTEGER | Input tokens |
| `output_tokens` | INTEGER | Output tokens |

### `chat_stats`

| Column | Type | Description |
|--------|------|-------------|
| `chat_id` | TEXT PK | → `chats.id` |
| `total_messages` | INTEGER | Total count |
| `user_messages` | INTEGER | User messages |
| `assistant_messages` | INTEGER | Assistant messages |
| `tool_calls` | TEXT | JSON array of tool names |
| `models` | TEXT | JSON array of model names |
| `total_input_tokens` | INTEGER | Sum of input tokens |
| `total_output_tokens` | INTEGER | Sum of output tokens |
| `total_cache_read` | INTEGER | Cache read tokens |
| `total_cache_write` | INTEGER | Cache write tokens |

### `tool_calls`

| Column | Type | Description |
|--------|------|-------------|
| `chat_id` | TEXT FK | → `chats.id` |
| `tool_name` | TEXT | Function name |
| `args_json` | TEXT | Full arguments as JSON |
| `source` | TEXT | Editor |
| `folder` | TEXT | Project directory |
| `timestamp` | INTEGER | Timestamp (ms) |
