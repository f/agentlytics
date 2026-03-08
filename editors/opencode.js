const path = require('path');
const fs = require('fs');
const os = require('os');

// OpenCode uses XDG paths cross-platform (~/.local/share/... on all platforms)
const STORAGE_DIR = path.join(os.homedir(), '.local', 'share', 'opencode', 'storage');
const SESSION_DIR = path.join(STORAGE_DIR, 'session');
const MESSAGE_DIR = path.join(STORAGE_DIR, 'message');
const PART_DIR = path.join(STORAGE_DIR, 'part');

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

  const messages = [];
  for (const file of files) {
    const msgPath = path.join(sessionMsgDir, file);
    const msg = readJson(msgPath);
    if (!msg || !msg.id) continue;

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
      // Extract model value - handle both string and object formats
      let modelValue = null;
      if (typeof msg.modelID === 'string') {
        modelValue = msg.modelID;
      } else if (msg.model && typeof msg.model === 'object' && msg.model.modelID) {
        modelValue = msg.model.modelID;
      } else if (typeof msg.model === 'string') {
        modelValue = msg.model;
      }

      messages.push({
        role: msg.role || 'assistant',
        content,
        _model: modelValue,
        _inputTokens: msg.tokens?.input,
        _outputTokens: msg.tokens?.output,
        _cacheRead: msg.tokens?.cache?.read,
        _cacheWrite: msg.tokens?.cache?.write,
        _finish: msg.finish,
      });
    }
  }

  // Sort by creation time
  return messages.sort((a, b) => {
    const aTime = a.time?.created || 0;
    const bTime = b.time?.created || 0;
    return aTime - bTime;
  });
}

// ============================================================
// Adapter interface
// ============================================================

const name = 'opencode';

function getChats() {
  const sessions = getAllSessions();

  return sessions.map(s => ({
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
  })).sort((a, b) => (b.lastUpdatedAt || 0) - (a.lastUpdatedAt || 0));
}

function getMessages(chat) {
  return getMessagesForSession(chat.composerId);
}

module.exports = { name, getChats, getMessages };
