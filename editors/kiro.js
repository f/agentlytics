const path = require('path');
const fs = require('fs');
const os = require('os');
const { getAppDataPath } = require('./base');

// ============================================================
// Kiro editor adapter
// ============================================================

const name = 'kiro';

const KIRO_AGENT_DIR = path.join(
  getAppDataPath('Kiro'), 'User', 'globalStorage', 'kiro.kiroagent'
);
const WORKSPACE_SESSIONS_DIR = path.join(KIRO_AGENT_DIR, 'workspace-sessions');

function getChats() {
  const chats = [];
  if (!fs.existsSync(KIRO_AGENT_DIR)) return chats;

  // Strategy 1: workspace-sessions (structured, has workspace info)
  if (fs.existsSync(WORKSPACE_SESSIONS_DIR)) {
    try {
      for (const folder of fs.readdirSync(WORKSPACE_SESSIONS_DIR)) {
        const wsDir = path.join(WORKSPACE_SESSIONS_DIR, folder);
        if (!fs.statSync(wsDir).isDirectory()) continue;

        // Decode base64 folder name to get workspace path
        let workspacePath = null;
        try {
          workspacePath = Buffer.from(folder, 'base64').toString('utf-8');
        } catch {}

        const indexPath = path.join(wsDir, 'sessions.json');
        let sessions = [];
        try {
          sessions = JSON.parse(fs.readFileSync(indexPath, 'utf-8'));
        } catch { continue; }

        for (const session of sessions) {
          const sessionFile = path.join(wsDir, `${session.sessionId}.json`);
          const exists = fs.existsSync(sessionFile);

          chats.push({
            source: 'kiro',
            composerId: session.sessionId,
            name: cleanTitle(session.title),
            createdAt: parseInt(session.dateCreated) || null,
            lastUpdatedAt: exists ? getFileMtime(sessionFile) : parseInt(session.dateCreated) || null,
            mode: 'kiro',
            folder: session.workspaceDirectory || workspacePath || null,
            encrypted: false,
            bubbleCount: 0,
            _fullPath: exists ? sessionFile : null,
            _type: 'workspace-session',
          });
        }
      }
    } catch {}
  }

  // Strategy 2: .chat files in hash directories (individual agent executions)
  // Kiro saves a snapshot of the conversation after each API call, so multiple
  // .chat files can share the same executionId. We group by executionId and
  // keep only the latest snapshot (highest message count) per conversation.
  const seenIds = new Set(chats.map(c => c.composerId));
  const executionMap = new Map(); // executionId -> best candidate
  try {
    for (const dir of fs.readdirSync(KIRO_AGENT_DIR)) {
      // Skip known non-workspace directories
      if (['default', 'dev_data', 'index', 'sessions', 'workspace-sessions'].includes(dir)) continue;
      const fullDir = path.join(KIRO_AGENT_DIR, dir);
      if (!fs.statSync(fullDir).isDirectory()) continue;

      let files;
      try { files = fs.readdirSync(fullDir).filter(f => f.endsWith('.chat')); } catch { continue; }

      for (const file of files) {
        const fullPath = path.join(fullDir, file);
        try {
          const stat = fs.statSync(fullPath);
          const meta = peekChatMeta(fullPath);
          const chatId = meta.executionId || `${dir}/${file.replace('.chat', '')}`;
          if (seenIds.has(chatId)) continue;

          const candidate = {
            source: 'kiro',
            composerId: chatId,
            name: meta.title || null,
            createdAt: meta.startTime || stat.birthtime.getTime(),
            lastUpdatedAt: meta.endTime || stat.mtime.getTime(),
            mode: meta.workflow || 'kiro',
            folder: meta.folder || null,
            encrypted: false,
            bubbleCount: meta.messageCount || 0,
            _fullPath: fullPath,
            _type: 'chat-file',
          };

          // Keep the snapshot with the most messages per executionId
          if (meta.executionId) {
            const existing = executionMap.get(meta.executionId);
            if (!existing || meta.messageCount > existing.bubbleCount) {
              // Update createdAt to the earliest startTime seen
              if (existing && existing.createdAt < candidate.createdAt) {
                candidate.createdAt = existing.createdAt;
              }
              executionMap.set(meta.executionId, candidate);
            } else if (existing && meta.startTime && meta.startTime < existing.createdAt) {
              existing.createdAt = meta.startTime;
            }
          } else {
            chats.push(candidate);
          }
        } catch {}
      }
    }
  } catch {}

  // Add the deduplicated execution sessions
  for (const chat of executionMap.values()) {
    chats.push(chat);
  }

  return chats;
}

function peekChatMeta(filePath) {
  const meta = { title: null, folder: null, startTime: null, endTime: null, workflow: null, messageCount: 0, executionId: null };
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const data = JSON.parse(raw);

    meta.executionId = data.executionId || null;

    if (data.metadata) {
      meta.startTime = data.metadata.startTime || null;
      meta.endTime = data.metadata.endTime || null;
      meta.workflow = data.metadata.workflow || null;
    }

    const chat = data.chat || [];
    for (const msg of chat) {
      if (msg.role === 'human') {
        // Try to extract user request from rules block
        const userReq = extractUserRequest(msg.content);
        if (userReq && !meta.title) {
          meta.title = cleanTitle(userReq);
        }
      }
      if (msg.role === 'bot' || msg.role === 'human') meta.messageCount++;
    }

    // Try to extract folder from context
    for (const ctx of data.context || []) {
      if (ctx.type === 'steering' && ctx.id) {
        // Extract workspace from steering file path
        const match = ctx.id.match(/file:\/\/(.*?)\/.kiro\//);
        if (match) meta.folder = match[1];
      }
    }
  } catch {}
  return meta;
}

function isSystemPrompt(content) {
  if (typeof content !== 'string') return false;
  return content.startsWith('<identity>') || content.startsWith('# ');
}

function extractUserRequest(content) {
  if (typeof content !== 'string') return null;
  // "## Included Rules" messages contain the actual user request after </user-rule>
  const ruleEnd = content.lastIndexOf('</user-rule>');
  if (ruleEnd >= 0) {
    let userPart = content.substring(ruleEnd + '</user-rule>'.length).trim();
    // Strip trailing EnvironmentContext block
    const envIdx = userPart.indexOf('<EnvironmentContext>');
    if (envIdx >= 0) userPart = userPart.substring(0, envIdx).trim();
    // Strip steering-reminder blocks
    const steerIdx = userPart.indexOf('<steering-reminder>');
    if (steerIdx >= 0) userPart = userPart.substring(0, steerIdx).trim();
    if (userPart) return userPart;
  }
  return null;
}

function getMessages(chat) {
  if (!chat._fullPath || !fs.existsSync(chat._fullPath)) return [];

  if (chat._type === 'workspace-session') {
    return getWorkspaceSessionMessages(chat._fullPath);
  }
  return getChatFileMessages(chat._fullPath);
}

function getWorkspaceSessionMessages(filePath) {
  const messages = [];
  try {
    const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    const history = data.history || [];

    for (const entry of history) {
      const msg = entry.message;
      if (!msg) continue;

      const role = msg.role === 'user' ? 'user' : msg.role === 'assistant' ? 'assistant' : null;
      if (!role) continue;

      const content = extractContentFromMessage(msg.content);
      if (!content) continue;

      const result = { role, content };

      // Extract model info from promptLogs
      if (role === 'assistant' && entry.promptLogs && entry.promptLogs.length > 0) {
        const log = entry.promptLogs[0];
        result._model = log.modelTitle || null;
      }

      messages.push(result);
    }
  } catch {}
  return messages;
}

function getChatFileMessages(filePath) {
  const messages = [];
  try {
    const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    const chat = data.chat || [];
    const model = data.metadata?.modelId || null;

    for (const msg of chat) {
      if (msg.role === 'human') {
        if (isSystemPrompt(msg.content)) continue;
        // Try extracting user request from rules block first
        const userReq = extractUserRequest(msg.content);
        const content = userReq || extractUserText(msg.content);
        if (content) messages.push({ role: 'user', content });
      } else if (msg.role === 'bot') {
        const content = typeof msg.content === 'string' ? msg.content : '';
        if (content) messages.push({ role: 'assistant', content, _model: model });
      } else if (msg.role === 'tool') {
        const content = typeof msg.content === 'string' ? msg.content : '';
        if (content) messages.push({ role: 'tool', content: content.substring(0, 2000) });
      }
    }
  } catch {}
  return messages;
}

function extractContentFromMessage(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter(c => c.type === 'text' || c.type === 'mention')
    .map(c => c.text)
    .join('\n') || '';
}

function extractUserText(content) {
  if (typeof content === 'string') {
    // Skip system prompt content
    if (isSystemPrompt(content)) return null;
    // Strip XML tags and rules blocks
    return cleanTitle(content);
  }
  if (Array.isArray(content)) {
    return content
      .filter(c => c.type === 'text' || c.type === 'mention')
      .map(c => c.text)
      .join('\n') || '';
  }
  return '';
}

function cleanTitle(title) {
  if (!title) return null;
  let clean = title
    .replace(/<[^>]+>[\s\S]*?<\/[^>]+>/g, '')
    .replace(/<[^>]+>/g, '')
    .replace(/## Included Rules[\s\S]*$/m, '')
    .replace(/\s+/g, ' ')
    .trim()
    .substring(0, 120);
  return clean || null;
}

function getFileMtime(filePath) {
  try { return fs.statSync(filePath).mtime.getTime(); } catch { return null; }
}

const labels = { 'kiro': 'Kiro' };

module.exports = { name, labels, getChats, getMessages };
