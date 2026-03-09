const path = require('path');
const fs = require('fs');
const os = require('os');
const { execSync } = require('child_process');

const GOOSE_DIR = path.join(os.homedir(), '.local', 'share', 'goose', 'sessions');
const DB_PATH = path.join(GOOSE_DIR, 'sessions.db');
const CONFIG_PATH = path.join(os.homedir(), '.config', 'goose', 'config.yaml');

// ============================================================
// Query SQLite via CLI
// ============================================================

function queryDb(sql) {
  if (!fs.existsSync(DB_PATH)) return [];
  try {
    const raw = execSync(
      `sqlite3 -json ${JSON.stringify(DB_PATH)} ${JSON.stringify(sql)}`,
      { encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'] }
    );
    return JSON.parse(raw);
  } catch { return []; }
}

// ============================================================
// Adapter interface
// ============================================================

const name = 'goose';

let _configModel = undefined; // lazy-loaded

function getConfigModel() {
  if (_configModel !== undefined) return _configModel;
  _configModel = null;
  try {
    const raw = fs.readFileSync(CONFIG_PATH, 'utf-8');
    const modelMatch = raw.match(/^GOOSE_MODEL:\s*(.+)$/m);
    if (modelMatch) _configModel = modelMatch[1].trim();
  } catch {}
  return _configModel;
}

function getChats() {
  const chats = [];

  const configModel = getConfigModel();

  // --- SQLite sessions (v1.10.0+) ---
  const dbSessions = queryDb(
    `SELECT id, name, description, working_dir, created_at, updated_at,
            total_tokens, input_tokens, output_tokens, provider_name, model_config_json,
            (SELECT count(*) FROM messages m WHERE m.session_id = s.id) as msg_count
     FROM sessions s ORDER BY updated_at DESC`
  );

  const dbSessionIds = new Set();
  for (const row of dbSessions) {
    dbSessionIds.add(row.id);
    chats.push({
      source: 'goose',
      composerId: row.id,
      name: cleanTitle(row.name || row.description),
      createdAt: parseTimestamp(row.created_at),
      lastUpdatedAt: parseTimestamp(row.updated_at),
      mode: 'goose',
      folder: row.working_dir || null,
      encrypted: false,
      bubbleCount: row.msg_count || 0,
      _storage: 'db',
      _inputTokens: row.input_tokens,
      _outputTokens: row.output_tokens,
      _model: extractSessionModel(row) || configModel,
    });
  }

  // --- Legacy JSONL files ---
  if (fs.existsSync(GOOSE_DIR)) {
    let files;
    try { files = fs.readdirSync(GOOSE_DIR).filter(f => f.endsWith('.jsonl')); } catch { files = []; }

    for (const file of files) {
      const sessionId = file.replace('.jsonl', '');
      if (dbSessionIds.has(sessionId)) continue; // already in DB

      const fullPath = path.join(GOOSE_DIR, file);
      try {
        const stat = fs.statSync(fullPath);
        const meta = peekJsonlMeta(fullPath);
        chats.push({
          source: 'goose',
          composerId: sessionId,
          name: meta.firstPrompt ? cleanTitle(meta.firstPrompt) : null,
          createdAt: meta.timestamp || stat.birthtime.getTime(),
          lastUpdatedAt: stat.mtime.getTime(),
          mode: 'goose',
          folder: meta.workingDir || null,
          encrypted: false,
          _storage: 'jsonl',
          _fullPath: fullPath,
          _model: configModel,
        });
      } catch { /* skip */ }
    }
  }

  return chats;
}

function parseTimestamp(ts) {
  if (!ts) return null;
  if (typeof ts === 'number') return ts;
  const d = new Date(ts);
  return isNaN(d.getTime()) ? null : d.getTime();
}

function cleanTitle(title) {
  if (!title) return null;
  return title.substring(0, 120).trim() || null;
}

function peekJsonlMeta(filePath) {
  const meta = { firstPrompt: null, workingDir: null, timestamp: null };
  try {
    const buf = fs.readFileSync(filePath, 'utf-8');
    for (const line of buf.split('\n')) {
      if (!line) continue;
      const obj = JSON.parse(line);

      if (!meta.timestamp && obj.created) {
        meta.timestamp = parseTimestamp(obj.created);
      }

      if (!meta.workingDir && obj.working_dir) {
        meta.workingDir = obj.working_dir;
      }

      // First user text message
      if (!meta.firstPrompt && obj.role === 'user' && obj.content) {
        let parts;
        try { parts = typeof obj.content === 'string' ? JSON.parse(obj.content) : obj.content; } catch { continue; }
        if (Array.isArray(parts)) {
          const text = parts.filter(p => p.type === 'text').map(p => p.text).join(' ');
          if (text) meta.firstPrompt = text.substring(0, 200);
        }
      }

      if (meta.firstPrompt && meta.workingDir) break;
    }
  } catch {}
  return meta;
}

function getMessages(chat) {
  if (chat._storage === 'db') return getMessagesFromDb(chat);
  if (chat._storage === 'jsonl') return getMessagesFromJsonl(chat);
  // Try DB first, then JSONL
  const dbMessages = getMessagesFromDb(chat);
  if (dbMessages.length) return dbMessages;
  return getMessagesFromJsonl(chat);
}

function getMessagesFromDb(chat) {
  const rows = queryDb(
    `SELECT role, content_json, created_timestamp FROM messages
     WHERE session_id = '${chat.composerId}' ORDER BY created_timestamp ASC`
  );

  const result = [];
  for (const row of rows) {
    let parts;
    try { parts = JSON.parse(row.content_json); } catch { continue; }
    if (!Array.isArray(parts)) continue;

    const role = row.role;
    const contentParts = [];
    const toolCalls = [];

    for (const part of parts) {
      if (part.type === 'text' && part.text) {
        contentParts.push(part.text);
      } else if (part.type === 'toolRequest' && part.toolCall) {
        const tc = part.toolCall.value || {};
        const toolName = tc.name || 'tool';
        let argKeys = '';
        try { argKeys = Object.keys(tc.arguments || {}).join(', '); } catch {}
        contentParts.push(`[tool-call: ${toolName}(${argKeys})]`);
        toolCalls.push({ name: toolName, args: tc.arguments || {} });
      } else if (part.type === 'toolResponse' && part.toolResult) {
        const tr = part.toolResult;
        let preview = '';
        if (tr.value && Array.isArray(tr.value)) {
          preview = tr.value
            .filter(v => v.type === 'text')
            .map(v => v.text)
            .join('\n')
            .substring(0, 500);
        }
        contentParts.push(`[tool-result: ${tr.status || 'done'}] ${preview}`);
      }
    }

    const content = contentParts.join('\n');
    if (!content) continue;

    const mappedRole = role === 'user' ? 'user' : role === 'assistant' ? 'assistant' : role;
    const msg = { role: mappedRole, content };
    if (mappedRole === 'assistant' && chat._model) msg._model = chat._model;
    if (toolCalls.length) msg._toolCalls = toolCalls;
    result.push(msg);
  }

  return result;
}

function getMessagesFromJsonl(chat) {
  const filePath = chat._fullPath || path.join(GOOSE_DIR, chat.composerId + '.jsonl');
  if (!fs.existsSync(filePath)) return [];

  const lines = fs.readFileSync(filePath, 'utf-8').split('\n').filter(Boolean);
  const result = [];

  for (const line of lines) {
    let obj;
    try { obj = JSON.parse(line); } catch { continue; }

    if (!obj.role) continue;

    let parts;
    try {
      parts = typeof obj.content === 'string' ? JSON.parse(obj.content) : obj.content;
    } catch {
      // content might be plain text
      if (typeof obj.content === 'string' && obj.content) {
        result.push({ role: obj.role, content: obj.content });
      }
      continue;
    }

    if (!Array.isArray(parts)) continue;

    const contentParts = [];
    for (const part of parts) {
      if (part.type === 'text' && part.text) {
        contentParts.push(part.text);
      } else if (part.type === 'toolRequest') {
        const tc = part.toolCall?.value || {};
        contentParts.push(`[tool-call: ${tc.name || 'tool'}(${Object.keys(tc.arguments || {}).join(', ')})]`);
      } else if (part.type === 'toolResponse') {
        const tr = part.toolResult || {};
        let preview = '';
        if (Array.isArray(tr.value)) {
          preview = tr.value.filter(v => v.type === 'text').map(v => v.text).join('\n').substring(0, 500);
        }
        contentParts.push(`[tool-result] ${preview}`);
      }
    }

    const content = contentParts.join('\n');
    if (content) {
      const msg = { role: obj.role, content };
      if (obj.role === 'assistant' && chat._model) msg._model = chat._model;
      result.push(msg);
    }
  }

  return result;
}

function extractSessionModel(row) {
  if (row.model_config_json) {
    try {
      const cfg = JSON.parse(row.model_config_json);
      if (cfg.model) return cfg.model;
      if (cfg.model_id) return cfg.model_id;
    } catch {}
  }
  return null;
}

function resetCache() {
  _configModel = undefined;
}

const labels = { 'goose': 'Goose' };

module.exports = { name, labels, getChats, getMessages, resetCache };
