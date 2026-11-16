const path = require('path');
const fs = require('fs');
const os = require('os');
const Database = require('better-sqlite3');

// OpenCode stores data in XDG-style paths across all platforms
function getOpenCodeStoragePath() {
  return path.join(os.homedir(), '.local', 'share', 'opencode', 'storage');
}

const STORAGE_DIR = getOpenCodeStoragePath();
const SESSION_DIR = path.join(STORAGE_DIR, 'session');
const MESSAGE_DIR = path.join(STORAGE_DIR, 'message');
const PART_DIR = path.join(STORAGE_DIR, 'part');

// OpenCode also stores data in a SQLite database
function getOpenCodeDbPath() {
  return path.join(os.homedir(), '.local', 'share', 'opencode', 'opencode.db');
}

const DB_PATH = getOpenCodeDbPath();

// ============================================================
// Query SQLite using better-sqlite3
// ============================================================

function queryDb(sql) {
  if (!fs.existsSync(DB_PATH)) return [];
  try {
    const db = new Database(DB_PATH, { readonly: true });
    const rows = db.prepare(sql).all();
    db.close();
    return rows;
  } catch {
    return [];
  }
}

function extractModelInfo(data) {
  let modelValue = null;
  let providerValue = null;

  if (typeof data?.modelID === 'string') {
    modelValue = data.modelID;
    providerValue = typeof data.providerID === 'string' ? data.providerID : null;
  } else if (data?.model && typeof data.model === 'object') {
    modelValue = typeof data.model.modelID === 'string' ? data.model.modelID : null;
    providerValue = typeof data.providerID === 'string'
      ? data.providerID
      : (typeof data.model.providerID === 'string' ? data.model.providerID : null);
  } else if (typeof data?.model === 'string') {
    modelValue = data.model;
    providerValue = typeof data.providerID === 'string' ? data.providerID : null;
  }

  return { modelValue, providerValue };
}

function extractTokenInfo(data) {
  const tokens = data?.tokens && typeof data.tokens === 'object' ? data.tokens : null;
  const cache = tokens?.cache && typeof tokens.cache === 'object' ? tokens.cache : null;

  return {
    inputTokens: tokens?.input,
    outputTokens: tokens?.output,
    cacheRead: cache?.read,
    cacheWrite: cache?.write,
  };
}

// ============================================================
// OpenCode v2+ storage (session_v2 / session_message tables)
// ============================================================

function hasSqliteV2Schema() {
  if (!fs.existsSync(DB_PATH)) return false;
  try {
    const db = new Database(DB_PATH, { readonly: true });
    const tables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table'"
    ).all().map(r => r.name);
    db.close();
    return tables.includes('session_v2') && tables.includes('session_message');
  } catch {
    return false;
  }
}

function parseModelRef(model) {
  if (!model || typeof model !== 'object') return { modelValue: null, providerValue: null };
  const id = typeof model.id === 'string' ? model.id
    : typeof model.modelID === 'string' ? model.modelID
    : null;
  const provider = typeof model.providerID === 'string' ? model.providerID : null;
  return { modelValue: id, providerValue: provider };
}

function getSqliteV2Sessions() {
  if (!hasSqliteV2Schema()) return [];
  return queryDb(
    `SELECT s.id, s.title, s.directory, s.agent, s.model,
            s.time_created, s.time_updated,
            p.worktree,
            (SELECT count(*) FROM session_message m
             WHERE m.session_id = s.id AND m.type IN ('user','assistant')) as msg_count
     FROM session_v2 s LEFT JOIN project p ON s.project_id = p.id
     ORDER BY s.time_updated DESC`
  );
}

// Normalize tool part state into the legacy text preview shape
function v2ToolPreview(state) {
  if (!state || typeof state !== 'object') return '';
  const content = state.content;
  if (Array.isArray(content)) {
    return content
      .filter(c => c && typeof c === 'object' && typeof c.text === 'string')
      .map(c => c.text)
      .join('\n');
  }
  if (typeof state.output === 'string') return state.output;
  if (typeof state.text === 'string') return state.text;
  return '';
}

function v2ArgSummary(part) {
  const input = part?.state?.input ?? part?.input ?? part?.args ?? null;
  if (input == null) return '';
  if (typeof input === 'string') return input;
  if (typeof input === 'object') return Object.keys(input).join(', ');
  return String(input);
}

function getSqliteV2Messages(sessionId) {
  if (!hasSqliteV2Schema()) return [];
  let db;
  try {
    db = new Database(DB_PATH, { readonly: true });
  } catch {
    return [];
  }
  try {
    const rows = db.prepare(
      `SELECT id, type, seq, data, time_created
       FROM session_message
       WHERE session_id = ? AND type IN ('user','assistant')
       ORDER BY time_created ASC, seq ASC`
    ).all(sessionId);

    const result = [];
    for (const row of rows) {
      let data;
      try { data = JSON.parse(row.data); } catch { continue; }

      const contentParts = [];

      if (row.type === 'user') {
        const text = typeof data.text === 'string' && data.text
          ? data.text
          : (data.metadata && typeof data.metadata.displayText === 'string' ? data.metadata.displayText : '');
        if (text) contentParts.push(text);
      } else {
        const content = Array.isArray(data.content) ? data.content : [];
        for (const part of content) {
          if (!part || typeof part !== 'object') continue;
          const type = part.type;
          if (type === 'text' && typeof part.text === 'string') {
            contentParts.push(part.text);
          } else if (type === 'reasoning' && typeof part.text === 'string') {
            if (part.text) contentParts.push(`[thinking] ${part.text}`);
          } else if (type === 'tool') {
            const toolName = part.name || part.toolName || 'tool';
            contentParts.push(`[tool-call: ${toolName}(${v2ArgSummary(part)})]`);
            const preview = v2ToolPreview(part.state);
            if (preview) contentParts.push(`[tool-result] ${preview.substring(0, 500)}`);
          }
        }
      }

      const content = contentParts.join('\n');
      if (!content) continue;

      let modelValue = null;
      let providerValue = null;
      let tokenInfo = { inputTokens: null, outputTokens: null, cacheRead: null, cacheWrite: null };

      if (row.type === 'user') {
        const parsed = parseModelRef(data.metadata?.model);
        modelValue = parsed.modelValue;
        providerValue = parsed.providerValue;
      } else {
        const parsed = parseModelRef(data.model);
        modelValue = parsed.modelValue;
        providerValue = parsed.providerValue;
        tokenInfo = extractTokenInfo(data);
      }

      result.push({
        role: row.type === 'user' ? 'user' : 'assistant',
        content,
        _model: modelValue,
        _provider: providerValue,
        _inputTokens: tokenInfo.inputTokens,
        _outputTokens: tokenInfo.outputTokens,
        _cacheRead: tokenInfo.cacheRead,
        _cacheWrite: tokenInfo.cacheWrite,
      });
    }
    return result;
  } catch {
    return [];
  } finally {
    try { db.close(); } catch {}
  }
}

function getSqliteSessions() {
  return queryDb(
    `SELECT s.id, s.title, s.directory, s.time_created, s.time_updated,
            p.worktree, p.name as project_name,
            (SELECT count(*) FROM message m WHERE m.session_id = s.id) as msg_count
     FROM session s LEFT JOIN project p ON s.project_id = p.id
     ORDER BY s.time_updated DESC`
  );
}

function getSqliteMessages(sessionId) {
  if (!fs.existsSync(DB_PATH)) return [];
  try {
    const db = new Database(DB_PATH, { readonly: true });
    const messages = db.prepare(
      `SELECT m.id as msg_id, m.data as msg_data, m.time_created
       FROM message m WHERE m.session_id = ? ORDER BY m.time_created ASC`
    ).all(sessionId);

    const result = [];
    for (const msg of messages) {
      let msgData;
      try { msgData = JSON.parse(msg.msg_data); } catch { continue; }

      const role = msgData.role;
      if (!role) continue;

      const parts = db.prepare(
        `SELECT data FROM part WHERE message_id = ? ORDER BY time_created ASC`
      ).all(msg.msg_id);

      const contentParts = [];
      for (const part of parts) {
        let partData;
        try { partData = JSON.parse(part.data); } catch { continue; }
        const type = partData.type;

        if (type === 'text' && partData.text) {
          contentParts.push(partData.text);
        } else if (type === 'thinking' || type === 'reasoning') {
          if (partData.text) contentParts.push(`[thinking] ${partData.text}`);
        } else if (type === 'tool-call' || type === 'tool_use' || type === 'tool-use' || type === 'tool') {
          const toolName = partData.name || partData.toolName || partData.tool || 'tool';
          let argKeys = '';
          try {
            const input = typeof partData.input === 'string' ? JSON.parse(partData.input) : (partData.input || partData.args || partData.arguments || partData.state?.input || {});
            argKeys = typeof input === 'object' ? Object.keys(input).join(', ') : '';
          } catch {}
          contentParts.push(`[tool-call: ${toolName}(${argKeys})]`);
        } else if (type === 'tool-result' || type === 'tool_result') {
          const preview = (partData.text || partData.output || partData.state?.output || '').substring(0, 500);
          contentParts.push(`[tool-result] ${preview}`);
        }
      }

      const content = contentParts.join('\n');
      if (!content) continue;

      const { modelValue, providerValue } = extractModelInfo(msgData);
      const { inputTokens, outputTokens, cacheRead, cacheWrite } = extractTokenInfo(msgData);

      result.push({
        role: role === 'user' ? 'user' : role === 'assistant' ? 'assistant' : role,
        content,
        _model: modelValue,
        _provider: providerValue,
        _inputTokens: inputTokens,
        _outputTokens: outputTokens,
        _cacheRead: cacheRead,
        _cacheWrite: cacheWrite,
      });
    }

    db.close();
    return result;
  } catch {
    return [];
  }
}

// ============================================================
// Scan JSON files from OpenCode storage
// ============================================================

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch { return null; }
}

function getAllSessions() {
  const sessions = [];
  if (!fs.existsSync(SESSION_DIR)) return sessions;

  for (const projectHash of fs.readdirSync(SESSION_DIR)) {
    const projectDir = path.join(SESSION_DIR, projectHash);
    if (!fs.statSync(projectDir).isDirectory()) continue;

    let files;
    try { files = fs.readdirSync(projectDir).filter(f => f.startsWith('ses_') && f.endsWith('.json')); } catch { continue; }

    for (const file of files) {
      const filePath = path.join(projectDir, file);
      const data = readJson(filePath);
      if (data && data.id) {
        sessions.push({ ...data, _filePath: filePath });
      }
    }
  }
  return sessions;
}

function getMessageCount(sessionId) {
  const sessionMsgDir = path.join(MESSAGE_DIR, sessionId);
  if (!fs.existsSync(sessionMsgDir)) return 0;

  try {
    return fs.readdirSync(sessionMsgDir).filter(f => f.startsWith('msg_') && f.endsWith('.json')).length;
  } catch { return 0; }
}

function getMessagesForSession(sessionId) {
  const sessionMsgDir = path.join(MESSAGE_DIR, sessionId);
  if (!fs.existsSync(sessionMsgDir)) return [];

  let files;
  try { files = fs.readdirSync(sessionMsgDir).filter(f => f.startsWith('msg_') && f.endsWith('.json')); } catch { return []; }

  const rawMsgs = [];
  for (const file of files) {
    const msgPath = path.join(sessionMsgDir, file);
    const msg = readJson(msgPath);
    if (!msg || !msg.id) continue;
    rawMsgs.push(msg);
  }

  // Sort by creation time before building output
  rawMsgs.sort((a, b) => (a.time?.created || 0) - (b.time?.created || 0));

  const messages = [];
  for (const msg of rawMsgs) {
    // Get parts for this message
    const msgPartDir = path.join(PART_DIR, msg.id);
    const parts = [];
    if (fs.existsSync(msgPartDir)) {
      try {
        const partFiles = fs.readdirSync(msgPartDir).filter(f => f.startsWith('prt_') && f.endsWith('.json'));
        for (const partFile of partFiles) {
          const part = readJson(path.join(msgPartDir, partFile));
          if (part) parts.push(part);
        }
      } catch { /* skip */ }
    }

    // Build content from parts
    const contentParts = [];
    for (const part of parts) {
      const type = part.type;

      if (type === 'text' && part.text) {
        contentParts.push(part.text);
      } else if (type === 'thinking' || type === 'reasoning') {
        if (part.text) contentParts.push(`[thinking] ${part.text}`);
      } else if (type === 'tool-call' || type === 'tool_use' || type === 'tool') {
        const toolName = part.name || part.toolName || part.tool || 'tool';
        const args = part.args || part.arguments || part.state?.input || {};
        const argKeys = typeof args === 'object' ? Object.keys(args).join(', ') : '';
        contentParts.push(`[tool-call: ${toolName}(${argKeys})]`);
      } else if (type === 'tool-result' || type === 'tool_result') {
        const preview = (part.text || part.output || part.state?.output || '').substring(0, 500);
        contentParts.push(`[tool-result] ${preview}`);
      } else if (type === 'step-start' || type === 'step-finish') {
        // Skip metadata parts
      }
    }

    // If no parts with content, check if message itself has content
    if (contentParts.length === 0 && msg.role) {
      contentParts.push(`[${msg.role}]`);
    }

    const content = contentParts.join('\n');
    if (content) {
      const { modelValue, providerValue } = extractModelInfo(msg);
      const { inputTokens, outputTokens, cacheRead, cacheWrite } = extractTokenInfo(msg);

      messages.push({
        role: msg.role || 'assistant',
        content,
        _model: modelValue,
        _provider: providerValue,
        _inputTokens: inputTokens,
        _outputTokens: outputTokens,
        _cacheRead: cacheRead,
        _cacheWrite: cacheWrite,
        _finish: msg.finish,
      });
    }
  }

  return messages;
}

// ============================================================
// Adapter interface
// ============================================================

const name = 'opencode';

function getChats() {
  const seen = new Set();
  const chats = [];

  // 1. JSON file-based sessions (newer storage format)
  const fileSessions = getAllSessions();
  for (const s of fileSessions) {
    seen.add(s.id);
    chats.push({
      source: 'opencode',
      composerId: s.id,
      name: s.title || null,
      createdAt: s.time?.created || null,
      lastUpdatedAt: s.time?.updated || null,
      mode: s.mode || 'opencode',
      folder: s.directory || null,
      encrypted: false,
      bubbleCount: getMessageCount(s.id),
      _agent: s.agent,
      _model: s.modelID,
      _provider: s.providerID,
      _sessionData: s,
      _storageType: 'file',
    });
  }

  // 2. OpenCode v2+ SQLite sessions — add any not already found
  const v2Sessions = getSqliteV2Sessions();
  for (const row of v2Sessions) {
    if (seen.has(row.id)) continue;
    seen.add(row.id);
    let modelInfo = null;
    try { modelInfo = row.model ? JSON.parse(row.model) : null; } catch { modelInfo = null; }
    chats.push({
      source: 'opencode',
      composerId: row.id,
      name: cleanTitle(row.title),
      createdAt: row.time_created || null,
      lastUpdatedAt: row.time_updated || null,
      mode: 'opencode',
      folder: row.worktree || row.directory || null,
      encrypted: false,
      bubbleCount: row.msg_count || 0,
      _agent: row.agent || null,
      _model: modelInfo?.id || null,
      _provider: modelInfo?.providerID || null,
      _storageType: 'sqlite-v2',
    });
  }

  // 3. Legacy SQLite sessions (older/primary store) — add any not already found in files
  const dbSessions = getSqliteSessions();
  for (const row of dbSessions) {
    if (seen.has(row.id)) continue;
    seen.add(row.id);
    chats.push({
      source: 'opencode',
      composerId: row.id,
      name: cleanTitle(row.title),
      createdAt: row.time_created || null,
      lastUpdatedAt: row.time_updated || null,
      mode: 'opencode',
      folder: row.worktree || row.directory || null,
      encrypted: false,
      bubbleCount: row.msg_count || 0,
      _storageType: 'sqlite',
    });
  }

  return chats.sort((a, b) => (b.lastUpdatedAt || 0) - (a.lastUpdatedAt || 0));
}

function cleanTitle(title) {
  if (!title) return null;
  if (title.startsWith('New session - ')) return null;
  return title.substring(0, 120) || null;
}

function getMessages(chat) {
  // Prefer file-based messages; then OpenCode v2+ SQLite; then legacy SQLite
  const fileMessages = getMessagesForSession(chat.composerId);
  if (fileMessages.length > 0) return fileMessages;
  const v2Messages = getSqliteV2Messages(chat.composerId);
  if (v2Messages.length > 0) return v2Messages;
  return getSqliteMessages(chat.composerId);
}

const labels = { 'opencode': 'OpenCode' };

function getMCPServers() {
  const { parseMcpConfigFile } = require('./base');
  // OpenCode: ~/.config/opencode/opencode.json (mcp key maps to mcpServers format)
  const globalConfig = path.join(os.homedir(), '.config', 'opencode', 'opencode.json');
  const results = [];
  if (fs.existsSync(globalConfig)) {
    try {
      const data = JSON.parse(fs.readFileSync(globalConfig, 'utf-8'));
      const servers = data.mcp || {};
      for (const [name, cfg] of Object.entries(servers)) {
        if (typeof cfg !== 'object') continue;
        results.push({
          name,
          editor: 'opencode',
          editorLabel: 'OpenCode',
          scope: 'global',
          configPath: globalConfig,
          command: cfg.command || null,
          args: cfg.args || [],
          env: cfg.env ? Object.keys(cfg.env) : [],
          url: cfg.url || null,
          transport: cfg.type || (cfg.url ? 'http' : 'stdio'),
          disabled: false,
          disabledTools: [],
        });
      }
    } catch {}
  }
  return results;
}

module.exports = { name, labels, getChats, getMessages, getMCPServers };
