const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { getAppDataPath } = require('./base');

const HOME = os.homedir();
const CURSOR_CHATS_DIR = path.join(HOME, '.cursor', 'chats');
const CURSOR_USER_DIR = path.join(getAppDataPath('Cursor'), 'User');
const WORKSPACE_STORAGE_DIR = path.join(CURSOR_USER_DIR, 'workspaceStorage');
const GLOBAL_STORAGE_DB = path.join(CURSOR_USER_DIR, 'globalStorage', 'state.vscdb');

// ============================================================
// Source 1: ~/.cursor/chats/<hash>/<chatId>/store.db (agent KV)
// ============================================================

function getAgentStoreChats() {
  const results = [];
  if (!fs.existsSync(CURSOR_CHATS_DIR)) return results;

  for (const workspace of fs.readdirSync(CURSOR_CHATS_DIR)) {
    const wsDir = path.join(CURSOR_CHATS_DIR, workspace);
    if (!fs.statSync(wsDir).isDirectory()) continue;
    for (const chat of fs.readdirSync(wsDir)) {
      const dbPath = path.join(wsDir, chat, 'store.db');
      if (fs.existsSync(dbPath)) {
        results.push({ workspace, chatId: chat, dbPath });
      }
    }
  }
  return results;
}

function hexToString(hex) {
  let str = '';
  for (let i = 0; i < hex.length; i += 2) {
    str += String.fromCharCode(parseInt(hex.substring(i, i + 2), 16));
  }
  return str;
}

function readStoreMeta(db) {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get('0');
  if (!row) return null;
  const hex = typeof row.value === 'string' ? row.value : Buffer.from(row.value).toString('hex');
  try {
    return JSON.parse(hexToString(hex));
  } catch {
    try { return JSON.parse(row.value); } catch { return null; }
  }
}

function parseTreeBlob(data) {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const messageRefs = [];
  const childRefs = [];
  let offset = 0;
  while (offset < buf.length) {
    if (offset + 34 > buf.length) break;
    const tag = buf[offset];
    const len = buf[offset + 1];
    if (len !== 0x20) break;
    const hash = buf.slice(offset + 2, offset + 2 + 32).toString('hex');
    if (tag === 0x0a) messageRefs.push(hash);
    else if (tag === 0x12) childRefs.push(hash);
    else break;
    offset += 2 + 32;
  }
  return { messageRefs, childRefs };
}

function normalizeStoreMessage(json) {
  const msg = { role: json.role, content: '', _toolCalls: [] };
  // Content may be string or array of parts
  if (typeof json.content === 'string') {
    msg.content = json.content;
  } else if (Array.isArray(json.content)) {
    msg.content = json.content.map(p => typeof p === 'string' ? p : (p.text || '')).join('\n');
  }
  // Tool calls (OpenAI format)
  if (json.tool_calls && Array.isArray(json.tool_calls)) {
    for (const tc of json.tool_calls) {
      const name = tc.function?.name || tc.name || 'unknown';
      let args = {};
      try {
        args = typeof tc.function?.arguments === 'string' ? JSON.parse(tc.function.arguments) : (tc.function?.arguments || {});
      } catch {}
      const argKeys = typeof args === 'object' ? Object.keys(args).join(', ') : '';
      msg.content += `\n[tool-call: ${name}(${argKeys})]`;
      msg._toolCalls.push({ name, args });
    }
  }
  if (json.model) msg._model = json.model;
  return msg;
}

function collectStoreMessages(db, rootBlobId) {
  const allMessages = [];
  const visited = new Set();
  function walk(blobId) {
    if (visited.has(blobId)) return;
    visited.add(blobId);
    const row = db.prepare('SELECT data FROM blobs WHERE id = ?').get(blobId);
    if (!row) return;
    const data = row.data;
    try {
      const json = typeof data === 'string' ? JSON.parse(data) : JSON.parse(data.toString('utf-8'));
      if (json && json.role) { allMessages.push(normalizeStoreMessage(json)); return; }
    } catch { /* tree blob */ }
    const { messageRefs, childRefs } = parseTreeBlob(data);
    for (const ref of messageRefs) walk(ref);
    for (const ref of childRefs) walk(ref);
  }
  walk(rootBlobId);
  return allMessages;
}

// ============================================================
// Source 2: workspaceStorage + globalStorage (composer bubbles)
// ============================================================

function getWorkspaceMap() {
  const map = [];
  if (!fs.existsSync(WORKSPACE_STORAGE_DIR)) return map;
  for (const hash of fs.readdirSync(WORKSPACE_STORAGE_DIR)) {
    const dir = path.join(WORKSPACE_STORAGE_DIR, hash);
    const wsJson = path.join(dir, 'workspace.json');
    const stateDb = path.join(dir, 'state.vscdb');
    if (!fs.existsSync(wsJson) || !fs.existsSync(stateDb)) continue;
    try {
      const ws = JSON.parse(fs.readFileSync(wsJson, 'utf-8'));
      const folder = (ws.folder || '').replace('file://', '');
      map.push({ hash, folder, stateDb });
    } catch { /* skip */ }
  }
  return map;
}

function getComposerHeaders(stateDbPath) {
  try {
    const db = new Database(stateDbPath, { readonly: true });
    const row = db.prepare("SELECT value FROM ItemTable WHERE key = 'composer.composerData'").get();
    db.close();
    if (!row) return [];
    const data = JSON.parse(row.value);
    return (data.allComposers || []).map((c) => ({
      composerId: c.composerId,
      name: c.name || null,
      createdAt: c.createdAt || null,
      lastUpdatedAt: c.lastUpdatedAt || null,
      mode: c.unifiedMode || c.forceMode || 'unknown',
      isAgentic: c.unifiedMode === 'agent',
    }));
  } catch { return []; }
}

function getModelPreference(globalDb) {
  try {
    const row = globalDb.prepare("SELECT value FROM ItemTable WHERE key = 'cursor/lastSingleModelPreference'").get();
    if (!row) return null;
    const pref = JSON.parse(row.value);
    return pref.composer || pref.agent || null;
  } catch { return null; }
}

function getComposerBubbles(globalDb, composerId) {
  const prefix = `bubbleId:${composerId}:`;
  const rows = globalDb.prepare(
    "SELECT key, value FROM cursorDiskKV WHERE key LIKE ? ORDER BY key"
  ).all(prefix + '%');

  const bubbles = [];
  for (const row of rows) {
    try {
      const obj = JSON.parse(row.value);
      bubbles.push(obj);
    } catch { /* binary blob, skip */ }
  }
  return bubbles;
}

function bubblesToMessages(bubbles) {
  const messages = [];
  for (const b of bubbles) {
    if (!b) continue;
    const type = b.type; // 1=user, 2=assistant
    if (type === 1) {
      const text = b.text || '';
      if (text) {
        messages.push({ role: 'user', content: text });
      }
    } else if (type === 2) {
      const textParts = [];
      // Thinking block
      if (b.thinking && b.thinking.text) {
        textParts.push(`[thinking] ${b.thinking.text}`);
      }
      // Main text
      if (b.text) {
        textParts.push(b.text);
      }
      // Tool calls — format as [tool-call: name(argKeys)] for analytics
      const _toolCalls = [];
      const tfd = b.toolFormerData;
      if (tfd && tfd.name) {
        let args = {};
        try {
          args = typeof tfd.rawArgs === 'string' && tfd.rawArgs !== '' ? JSON.parse(tfd.rawArgs) : (tfd.rawArgs || {});
        } catch {}
        // Fallback: use params field when rawArgs is empty
        if (!args || (typeof args === 'object' && Object.keys(args).length === 0)) {
          try {
            const p = typeof tfd.params === 'string' ? JSON.parse(tfd.params) : tfd.params;
            if (p && typeof p === 'object' && Object.keys(p).length > 0) args = p;
          } catch {}
        }
        const argKeys = typeof args === 'object' ? Object.keys(args).join(', ') : '';
        textParts.push(`[tool-call: ${tfd.name}(${argKeys})]`);
        _toolCalls.push({ name: tfd.name, args });
        if (tfd.result) {
          const preview = typeof tfd.result === 'string' ? tfd.result.substring(0, 300) : JSON.stringify(tfd.result).substring(0, 300);
          textParts.push(`[tool-result: ${tfd.name}] ${preview}`);
        }
      }
      // Code blocks
      if (b.codeBlocks && b.codeBlocks.length > 0) {
        for (const cb of b.codeBlocks) {
          const filePath = cb.uri ? cb.uri.path : '';
          if (filePath) textParts.push(`[file: ${filePath}]`);
        }
      }
      if (textParts.length > 0) {
        messages.push({
          role: 'assistant',
          content: textParts.join('\n'),
          _model: b.modelId || b.model || null,
          _inputTokens: b.tokenCount?.inputTokens,
          _outputTokens: b.tokenCount?.outputTokens,
          _toolCalls,
        });
      }
    }
  }
  return messages;
}

// ============================================================
// Adapter interface
// ============================================================

const name = 'cursor';

function getChats() {
  const chats = [];

  // Source 1: ~/.cursor/chats store.db
  for (const { workspace, chatId, dbPath } of getAgentStoreChats()) {
    try {
      const db = new Database(dbPath, { readonly: true });
      const meta = readStoreMeta(db);
      db.close();
      if (meta) {
        chats.push({
          source: 'cursor',
          composerId: chatId,
          name: meta.name || null,
          createdAt: meta.createdAt || null,
          mode: meta.mode || null,
          folder: null,
          _dbPath: dbPath,
          _rootBlobId: meta.latestRootBlobId,
          _lastUsedModel: meta.lastUsedModel || null,
          _type: 'agent-store',
        });
      }
    } catch { /* skip */ }
  }

  // Source 2: workspaceStorage composers
  let globalDb = null;
  try { globalDb = new Database(GLOBAL_STORAGE_DB, { readonly: true }); } catch { /* no global db */ }

  const modelPref = globalDb ? getModelPreference(globalDb) : null;

  for (const { hash, folder, stateDb } of getWorkspaceMap()) {
    const headers = getComposerHeaders(stateDb);
    for (const h of headers) {
      let bubbleCount = 0;
      if (globalDb) {
        try {
          const countRow = globalDb.prepare(
            "SELECT count(*) as cnt FROM cursorDiskKV WHERE key LIKE ?"
          ).get(`bubbleId:${h.composerId}:%`);
          bubbleCount = countRow ? countRow.cnt : 0;
        } catch { /* skip */ }
      }
      chats.push({
        source: 'cursor',
        composerId: h.composerId,
        name: h.name || null,
        createdAt: h.createdAt || null,
        lastUpdatedAt: h.lastUpdatedAt || null,
        mode: h.mode,
        folder,
        bubbleCount,
        _type: 'workspace',
        _modelPref: modelPref,
      });
    }
  }

  if (globalDb) globalDb.close();
  return chats;
}

function getMessages(chat) {
  if (chat._type === 'agent-store') {
    const db = new Database(chat._dbPath, { readonly: true });
    const msgs = collectStoreMessages(db, chat._rootBlobId);
    db.close();
    // Use lastUsedModel as fallback for assistant messages without model info
    if (chat._lastUsedModel) {
      for (const m of msgs) {
        if (m.role === 'assistant' && !m._model) m._model = chat._lastUsedModel;
      }
    }
    return msgs;
  }

  let globalDb;
  try { globalDb = new Database(GLOBAL_STORAGE_DB, { readonly: true }); } catch { return []; }
  const bubbles = getComposerBubbles(globalDb, chat.composerId);
  globalDb.close();
  const msgs = bubblesToMessages(bubbles);
  // Use model preference as fallback for messages without model info
  if (chat._modelPref) {
    for (const m of msgs) {
      if (m.role === 'assistant' && !m._model) m._model = chat._modelPref;
    }
  }
  return msgs;
}

const labels = { 'cursor': 'Cursor' };

module.exports = { name, labels, getChats, getMessages };
