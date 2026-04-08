const path = require('path');
const fs = require('fs');
const os = require('os');

const name = 'cline-cli';
const sources = ['cline-cli'];

function getClineDir() {
  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'cline');
  } else if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'cline');
  }
  return path.join(os.homedir(), '.cline');
}

const CLINE_DIR = getClineDir();
const CLINE_DATA_DIR = path.join(CLINE_DIR, 'data');
const SESSIONS_DIR = path.join(CLINE_DATA_DIR, 'sessions');

function getChats() {
  const chats = [];
  if (!fs.existsSync(SESSIONS_DIR)) return chats;

  try {
    const sessionDirs = fs.readdirSync(SESSIONS_DIR);
    for (const sessionDir of sessionDirs) {
      const sessionPath = path.join(SESSIONS_DIR, sessionDir);
      if (!fs.statSync(sessionPath).isDirectory()) continue;

      const sessionJsonPath = path.join(sessionPath, `${sessionDir}.json`);
      let sessionData = null;
      try {
        sessionData = JSON.parse(fs.readFileSync(sessionJsonPath, 'utf-8'));
      } catch { continue; }

      if (!sessionData) continue;

      const startedAt = sessionData.started_at ? new Date(sessionData.started_at).getTime() : null;
      const endedAt = sessionData.ended_at ? new Date(sessionData.ended_at).getTime() : startedAt;

      chats.push({
        source: 'cline-cli',
        composerId: sessionData.session_id || sessionDir,
        name: sessionData.metadata?.title || sessionData.prompt?.substring(0, 100) || null,
        createdAt: startedAt,
        lastUpdatedAt: endedAt,
        mode: 'cline-cli',
        folder: sessionData.cwd || sessionData.workspace_root || null,
        encrypted: false,
        bubbleCount: 0,
        _sessionId: sessionDir,
        _messagesPath: sessionData.messages_path,
      });
    }
  } catch {}

  chats.sort((a, b) => {
    const ta = a.lastUpdatedAt || a.createdAt || 0;
    const tb = b.lastUpdatedAt || b.createdAt || 0;
    return tb - ta;
  });
  return chats;
}

function getMessages(chat) {
  const messages = [];
  if (!chat._sessionId || !chat._messagesPath) return messages;

  if (!fs.existsSync(chat._messagesPath)) return messages;

  try {
    const messagesFile = JSON.parse(fs.readFileSync(chat._messagesPath, 'utf-8'));
    const messagesData = Array.isArray(messagesFile) ? messagesFile : (messagesFile.messages || []);

    for (const msg of messagesData) {
      const role = msg.role === 'user' ? 'user' : msg.role === 'assistant' ? 'assistant' : msg.role === 'system' ? 'system' : null;
      if (!role) continue;

      let content = '';
      if (Array.isArray(msg.content)) {
        content = msg.content.map(c => {
          if (typeof c === 'string') return c;
          if (c.type === 'text') return c.text || '';
          if (c.type === 'tool_use') return `[tool-call: ${c.name}]`;
          if (c.type === 'tool_result') return c.content || '';
          if (c.type === 'thinking') return c.thinking || '';
          return c.text || c.content || '';
        }).join('');
      } else if (typeof msg.content === 'string') {
        content = msg.content;
      }

      if (!content) continue;

      const message = { role, content };

      if (msg.model) message._model = msg.model;
      if (msg.usage) {
        message._inputTokens = msg.usage.prompt_tokens || msg.usage.input_tokens || null;
        message._outputTokens = msg.usage.completion_tokens || msg.usage.output_tokens || null;
      }

      if (msg.tool_calls && msg.tool_calls.length > 0) {
        message._toolCalls = msg.tool_calls.map(tc => {
          let args = tc.function?.arguments || tc.arguments || {};
          if (typeof args === 'string') {
            try { args = JSON.parse(args); } catch { args = {}; }
          }
          return { name: tc.function?.name || tc.name || 'unknown', args };
        });
      }

      messages.push(message);
    }
  } catch {}

  return messages;
}

function resetCache() {}

function getMCPServers() {
  const { parseMcpConfigFile } = require('./base');
  const configPath = path.join(CLINE_DATA_DIR, 'settings', 'cline_mcp_settings.json');
  return parseMcpConfigFile(configPath, { editor: 'cline-cli', label: 'Cline CLI', scope: 'global' });
}

const labels = {
  'cline-cli': 'Cline CLI',
};

module.exports = { name, sources, labels, getChats, getMessages, resetCache, getMCPServers };