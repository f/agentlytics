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

# Starts both frontend (port 5173) and backend (port 4637)
cd ui && npm install && npm run dev
```

`npm run dev` from the `ui/` directory starts both the Vite dev server and the backend concurrently. The Vite dev server proxies `/api/*` requests to the backend via `vite.config.js`. Ctrl+C stops both processes.

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

### Kiro

Reads from `~/Library/Application Support/Kiro/User/globalStorage/kiro.kiroagent/`:
- `workspace-sessions/` — base64-encoded workspace folder names
- Per-workspace `.chat` files with JSON session metadata and messages
- Messages stored in blob format with role, content, model, and timestamps

### Kilo Code CLI

Reads from platform-specific SQLite database:
- Linux: `~/.local/share/kilo/kilo.db`
- macOS: `~/Library/Application Support/kilo/kilo.db`
- Windows: `%APPDATA%/kilo/kilo.db`

Database tables:
- `session` — session metadata with id, title, directory, timestamps
- `message` — messages with role, content, model, usage
- `part` — message content blocks including tool calls and tool results
- Tool calls extracted from `part` table where `type: 'tool'`
- Token usage from `part` table where `type: 'step-finish'`

### Cline CLI

Reads from platform-specific session directories:
- Linux: `~/.cline/data/sessions/<session-id>/`
- macOS: `~/Library/Application Support/cline/data/sessions/<session-id>/`
- Windows: `%APPDATA%/cline/data/sessions/<session-id>/`

Files:
- `<session-id>.json` — session metadata including cwd, model, started_at
- `<session-id>.messages.json` — full conversation in OpenAI format
- Supports token extraction from `usage` field
- Tool calls extracted from `tool_use` content blocks

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
