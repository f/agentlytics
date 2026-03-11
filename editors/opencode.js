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

  // 2. SQLite sessions (older/primary store) — add any not already found in files
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
  // Prefer file-based messages; fall back to SQLite
  const fileMessages = getMessagesForSession(chat.composerId);
  if (fileMessages.length > 0) return fileMessages;
  return getSqliteMessages(chat.composerId);
}

const labels = { 'opencode': 'OpenCode' };

module.exports = { name, labels, getChats, getMessages };
