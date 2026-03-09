const path = require('path');
const fs = require('fs');
const os = require('os');

const GEMINI_DIR = path.join(os.homedir(), '.gemini');
const TMP_DIR = path.join(GEMINI_DIR, 'tmp');
const PROJECTS_JSON = path.join(GEMINI_DIR, 'projects.json');

// ============================================================
// Adapter interface
// ============================================================

const name = 'gemini-cli';

/**
 * Load project path mapping from ~/.gemini/projects.json
 * Format: { "projects": { "/Users/dev/Code/myapp": "myapp" } }
 * Returns Map<projectName, folderPath>
 */
function loadProjectMap() {
  const map = new Map();
  try {
    const data = JSON.parse(fs.readFileSync(PROJECTS_JSON, 'utf-8'));
    if (data.projects) {
      for (const [folderPath, projName] of Object.entries(data.projects)) {
        map.set(projName, folderPath);
      }
    }
  } catch {}
  return map;
}

function getChats() {
  const chats = [];
  if (!fs.existsSync(TMP_DIR)) return chats;

  const projectMap = loadProjectMap();

  // Each subdirectory under tmp/ is a project name (e.g. "codename-share")
  let projectDirs;
  try { projectDirs = fs.readdirSync(TMP_DIR); } catch { return chats; }

  for (const projName of projectDirs) {
    const projDir = path.join(TMP_DIR, projName);
    try { if (!fs.statSync(projDir).isDirectory()) continue; } catch { continue; }

    // Sessions are in <projDir>/chats/session-*.json
    const chatsDir = path.join(projDir, 'chats');
    if (!fs.existsSync(chatsDir)) continue;

    let files;
    try {
      files = fs.readdirSync(chatsDir).filter(f => f.startsWith('session-') && f.endsWith('.json'));
    } catch { continue; }

    // Resolve folder from projects.json mapping
    const folder = projectMap.get(projName) || null;

    for (const file of files) {
      const fullPath = path.join(chatsDir, file);
      try {
        const raw = fs.readFileSync(fullPath, 'utf-8');
        const record = JSON.parse(raw);
        if (!record || !record.messages) continue;

        const sessionId = record.sessionId || file.replace('.json', '');
        const messages = record.messages || [];

        // Extract first user prompt for title
        const firstUser = messages.find(m => m.type === 'user');
        const firstPrompt = extractTextContent(firstUser?.content);

        chats.push({
          source: 'gemini-cli',
          composerId: sessionId,
          name: firstPrompt ? cleanPrompt(firstPrompt) : null,
          createdAt: record.startTime ? new Date(record.startTime).getTime() : null,
          lastUpdatedAt: record.lastUpdated ? new Date(record.lastUpdated).getTime() : null,
          mode: 'gemini',
          folder,
          encrypted: false,
          bubbleCount: messages.length,
          _fullPath: fullPath,
        });
      } catch { /* skip malformed files */ }
    }
  }

  return chats;
}

function cleanPrompt(text) {
  if (!text) return null;
  return text.replace(/\s+/g, ' ').trim().substring(0, 120) || null;
}

function extractTextContent(content) {
  if (!content) return '';
  if (typeof content === 'string') return content;
  // Array of { text } parts (user messages)
  if (Array.isArray(content)) {
    return content
      .filter(p => p.text)
      .map(p => p.text)
      .join('\n') || '';
  }
  if (content.text) return content.text;
  return '';
}

function getMessages(chat) {
  const filePath = chat._fullPath;
  if (!filePath || !fs.existsSync(filePath)) return [];

  let record;
  try {
    record = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch { return []; }

  if (!record || !record.messages) return [];

  const result = [];
  for (const msg of record.messages) {
    const type = msg.type;
    const text = extractTextContent(msg.content || msg.displayContent);

    if (type === 'user') {
      if (text) result.push({ role: 'user', content: text });
    } else if (type === 'gemini') {
      const parts = [];
      const toolCalls = [];

      // Thoughts have { subject, description, timestamp }
      if (msg.thoughts && Array.isArray(msg.thoughts)) {
        for (const t of msg.thoughts) {
          const thought = t.description || t.subject || '';
          if (thought) parts.push(`[thinking] ${thought}`);
        }
      }

      // Main text content (string for gemini messages)
      if (text) parts.push(text);

      // Tool calls
      if (msg.toolCalls && Array.isArray(msg.toolCalls)) {
        for (const tc of msg.toolCalls) {
          const args = tc.args || {};
          const argKeys = typeof args === 'object' ? Object.keys(args).join(', ') : '';
          parts.push(`[tool-call: ${tc.name || 'unknown'}(${argKeys})]`);
          toolCalls.push({ name: tc.name || 'unknown', args });
        }
      }

      if (parts.length > 0) {
        const tokens = msg.tokens || {};
        result.push({
          role: 'assistant',
          content: parts.join('\n'),
          _model: msg.model,
          _inputTokens: tokens.input,
          _outputTokens: tokens.output,
          _cacheRead: tokens.cached,
          _toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
        });
      }
    } else if (type === 'info' || type === 'error' || type === 'warning') {
      if (text) result.push({ role: 'system', content: `[${type}] ${text}` });
    }
  }

  return result;
}

const labels = { 'gemini-cli': 'Gemini CLI' };

module.exports = { name, labels, getChats, getMessages };
