const path = require('path');
const fs = require('fs');
const os = require('os');

const name = 'kilocode-cli';
const sources = ['kilocode-cli'];

function getKiloDbPath() {
  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'kilo', 'kilo.db');
  } else if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'kilo', 'kilo.db');
  }
  return path.join(os.homedir(), '.local', 'share', 'kilo', 'kilo.db');
}

const KILO_DB_PATH = getKiloDbPath();

function getChats() {
  const chats = [];
  if (!fs.existsSync(KILO_DB_PATH)) return chats;

  let db;
  try {
    const Database = require('better-sqlite3');
    db = new Database(KILO_DB_PATH, { readonly: true });
  } catch { return chats; }

  try {
    const sessions = db.prepare(`
      SELECT id, title, directory, time_created, time_updated
      FROM session
      ORDER BY time_updated DESC
    `).all();

    for (const session of sessions) {
      chats.push({
        source: 'kilocode-cli',
        composerId: session.id,
        name: session.title || null,
        createdAt: session.time_created || null,
        lastUpdatedAt: session.time_updated || null,
        mode: 'kilocode',
        folder: session.directory || null,
        encrypted: false,
        bubbleCount: 0,
        _sessionId: session.id,
      });
    }
  } catch {}

  try { db.close(); } catch {}
  return chats;
}

function getMessages(chat) {
  const messages = [];
  if (!chat._sessionId) return messages;

  if (!fs.existsSync(KILO_DB_PATH)) return messages;

  let db;
  try {
    const Database = require('better-sqlite3');
    db = new Database(KILO_DB_PATH, { readonly: true });
  } catch { return messages; }

  try {
    const messagesData = db.prepare(`
      SELECT id, data, time_created
      FROM message
      WHERE session_id = ?
      ORDER BY time_created ASC
    `).all(chat._sessionId);

    const partsData = db.prepare(`
      SELECT id, data, time_created
      FROM part
      WHERE session_id = ?
      ORDER BY time_created ASC
    `).all(chat._sessionId);

    let currentRole = 'user';
    let currentContent = '';
    let currentModel = null;
    let currentTokens = null;

    for (const msg of messagesData) {
      try {
        const data = JSON.parse(msg.data);
        if (data.role === 'user') {
          if (currentContent || currentRole === 'assistant') {
            const m = { role: currentRole, content: currentContent };
            if (currentModel) m._model = currentModel;
            if (currentTokens) {
              if (currentTokens.input) m._inputTokens = currentTokens.input;
              if (currentTokens.output) m._outputTokens = currentTokens.output;
            }
            messages.push(m);
          }
          currentRole = 'user';
          currentContent = data.content || '';
          currentModel = data.model?.providerID && data.model?.modelID
            ? `${data.model.providerID}/${data.model.modelID}`
            : data.model?.modelID || null;
          currentTokens = null;
        } else if (data.role === 'assistant') {
          if (currentRole === 'user' && currentContent) {
            const m = { role: 'user', content: currentContent };
            if (currentModel) m._model = currentModel;
            messages.push(m);
          }
          currentRole = 'assistant';
          currentContent = '';

          if (data.model?.modelID) {
            currentModel = data.model?.providerID && data.model?.modelID
              ? `${data.model.providerID}/${data.model.modelID}`
              : data.model.modelID;
          }
          if (data.tokens) currentTokens = data.tokens;
        }
      } catch {}
    }

    for (const part of partsData) {
      try {
        const data = JSON.parse(part.data);

        if (data.type === 'text' && data.text) {
          currentContent += (currentContent ? '\n\n' : '') + data.text;
        } else if (data.type === 'tool') {
          const toolName = data.tool || 'tool';
          const toolInput = data.state?.input || {};
          currentContent += (currentContent ? '\n\n' : '') + `[tool-call: ${toolName}]`;
          if (toolInput.command) currentContent += ` ${toolInput.command}`;
          else if (toolInput.filePath) currentContent += ` ${toolInput.filePath}`;
          messages.push({
            role: 'assistant',
            content: currentContent,
            _toolCalls: [{
              name: toolName,
              args: toolInput,
            }],
          });
          currentContent = '';

          if (data.state?.output && !data.state.error) {
            currentContent += `[tool-result]\n${data.state.output}`;
          }
        } else if (data.type === 'file') {
          currentContent += (currentContent ? '\n\n' : '') + `[file: ${data.filename || data.url}]`;
        } else if (data.type === 'step-finish' && data.tokens) {
          currentTokens = data.tokens;
        }
      } catch {}
    }

    if (currentContent || currentRole === 'assistant') {
      const m = { role: currentRole, content: currentContent };
      if (currentModel) m._model = currentModel;
      if (currentTokens) {
        if (currentTokens.input) m._inputTokens = currentTokens.input;
        if (currentTokens.output) m._outputTokens = currentTokens.output;
      }
      if (m.content || m._toolCalls) messages.push(m);
    }
  } catch {}

  try { db.close(); } catch {}
  return messages.filter(m => m.content || m._toolCalls);
}

function resetCache() {}

const labels = {
  'kilocode-cli': 'Kilo Code CLI',
};

module.exports = { name, sources, labels, getChats, getMessages, resetCache };