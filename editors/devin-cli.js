const path = require('path');
const fs = require('fs');
const os = require('os');

// Devin CLI / Devin IDE local agent stores its sessions in a SQLite database.
// The same store is used by the `devin` terminal CLI and by the Devin IDE when
// the built-in local agent is used through ACP (backend_type = "windsurf").
// This module is not a standalone adapter: windsurf.js merges these sessions
// into the 'devin' source next to the Cascade trajectories. Chats are tagged
// with _type = 'devin-cli' (persisted in the cache _meta) so getMessages can
// route them back here.
const DEVIN_CLI_DIR = path.join(os.homedir(), '.local', 'share', 'devin', 'cli');
const DB_PATH = path.join(DEVIN_CLI_DIR, 'sessions.db');
const CONFIG_DIR = path.join(os.homedir(), '.config', 'devin');

// ============================================================
// SQLite access via better-sqlite3
// ============================================================

let Database;
function getDatabase() {
  if (!Database) {
    try {
      Database = require('better-sqlite3');
    } catch {
      // better-sqlite3 not available
    }
  }
  return Database;
}

function queryDb(sql, params = []) {
  if (!fs.existsSync(DB_PATH)) return [];
  const Db = getDatabase();
  if (!Db) return [];
  let db;
  try {
    db = new Db(DB_PATH, { readonly: true });
    return db.prepare(sql).all(...params);
  } catch {
    return [];
  } finally {
    try { if (db) db.close(); } catch { /* ignore */ }
  }
}

// ============================================================
// Helpers
// ============================================================

// Timestamps are stored as unix seconds; tolerate milliseconds too.
function toMs(ts) {
  if (ts == null) return null;
  const n = Number(ts);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n < 1e12 ? Math.round(n * 1000) : Math.round(n);
}

function safeJson(value) {
  if (value == null) return null;
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch { return null; }
}

// Devin model ids carry a reasoning-effort suffix ("gpt-5-6-sol-medium") and
// use a reversed Claude naming scheme ("claude-5-fable-medium"). Map them to
// the canonical ids used by pricing.json.
function normalizeDevinModel(id) {
  if (!id || typeof id !== 'string') return null;
  let m = id.toLowerCase().trim();
  if (!m) return null;
  m = m.replace(/-(minimal|low|medium|high|xhigh|max|thinking)$/, '');
  const rev = m.match(/^claude-(\d+)(?:-(\d+))?-(fable|opus|sonnet|haiku)$/);
  if (rev) m = `claude-${rev[3]}-${rev[1]}${rev[2] ? `-${rev[2]}` : ''}`;
  return m;
}

function cleanTitle(title) {
  if (!title || typeof title !== 'string') return null;
  const t = title.trim();
  if (!t || t.toLowerCase() === 'untitled') return null;
  return t;
}

function contentToString(content) {
  if (typeof content === 'string') return content;
  return content == null ? '' : JSON.stringify(content);
}

// ============================================================
// Chat / message extraction (consumed by windsurf.js)
// ============================================================

const SOURCE = 'devin';
const CHAT_TYPE = 'devin-cli';
const MCP_CONFIG_PATH = path.join(CONFIG_DIR, 'mcp_config.json');

const SESSIONS_SQL = `
    SELECT s.id, s.title, s.working_directory, s.model, s.agent_mode,
           s.created_at, s.last_activity_at,
           (SELECT count(DISTINCT COALESCE(json_extract(m.chat_message, '$.message_id'), m.node_id))
              FROM message_nodes m
             WHERE m.session_id = s.id
               AND json_extract(m.chat_message, '$.role') IN ('user', 'assistant', 'tool')) AS msg_count
      FROM sessions s
     WHERE s.hidden = 0
     ORDER BY s.last_activity_at DESC
`;

function getChats() {
  const rows = queryDb(SESSIONS_SQL);

  const chats = [];
  for (const row of rows) {
    // Sessions that never got past the system prompt carry no conversation.
    // msg_count mirrors what getMessages() returns (user + assistant + tool,
    // deduplicated) so the cached bubble_count stays stable across rescans.
    if (!row.msg_count) continue;
    chats.push({
      source: SOURCE,
      _type: CHAT_TYPE,
      composerId: row.id,
      name: cleanTitle(row.title),
      createdAt: toMs(row.created_at),
      lastUpdatedAt: toMs(row.last_activity_at),
      mode: row.agent_mode || null,
      folder: row.working_directory || null,
      encrypted: false,
      bubbleCount: row.msg_count,
      _model: normalizeDevinModel(row.model),
    });
  }
  return chats;
}

// message_nodes is a forest: context compaction re-inserts earlier messages
// under a new root with the same message_id, so nodes must be deduplicated by
// message_id. System nodes are prompt scaffolding, not conversation.
function getMessages(chat) {
  const rows = queryDb(
    'SELECT node_id, chat_message FROM message_nodes WHERE session_id = ? ORDER BY node_id ASC',
    [chat.composerId]
  );

  const seen = new Set();
  const messages = [];
  for (const row of rows) {
    const msg = safeJson(row.chat_message);
    if (!msg || typeof msg !== 'object') continue;
    const role = msg.role;
    if (role !== 'user' && role !== 'assistant' && role !== 'tool') continue;

    const key = msg.message_id || `${role}:${row.node_id}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const content = contentToString(msg.content);

    if (role === 'user') {
      messages.push({ role: 'user', content });
      continue;
    }

    if (role === 'tool') {
      messages.push({ role: 'tool', content });
      continue;
    }

    const meta = msg.metadata || {};
    const metrics = meta.metrics || {};
    const toolCalls = Array.isArray(msg.tool_calls)
      ? msg.tool_calls
          .filter((tc) => tc && typeof tc.name === 'string' && tc.name)
          .map((tc) => ({ name: tc.name, args: safeJson(tc.arguments) || {} }))
      : [];
    // Same "[tool-call: name(argKeys)]" rendering as the Claude/Codex adapters so
    // tool-only turns are not stored as empty assistant messages.
    const toolLines = toolCalls.map((tc) => `[tool-call: ${tc.name}(${Object.keys(tc.args).join(', ')})]`);
    const assistantContent = [content, ...toolLines].filter(Boolean).join('\n');

    messages.push({
      role: 'assistant',
      content: assistantContent,
      _model: normalizeDevinModel(meta.generation_model) || chat._model || null,
      _inputTokens: metrics.input_tokens || 0,
      _outputTokens: metrics.output_tokens || 0,
      _cacheRead: metrics.cache_read_tokens || 0,
      _cacheWrite: metrics.cache_creation_tokens || 0,
      _toolCalls: toolCalls,
    });
  }
  return messages;
}

function isCliChat(chat) {
  return !!chat && chat._type === CHAT_TYPE;
}

module.exports = { MCP_CONFIG_PATH, getChats, getMessages, isCliChat };
