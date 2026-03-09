const path = require('path');
const fs = require('fs');
const os = require('os');

const COMMANDCODE_DIR = path.join(os.homedir(), '.commandcode');
const PROJECTS_DIR = path.join(COMMANDCODE_DIR, 'projects');

// ============================================================
// Adapter interface
// ============================================================

const name = 'commandcode';

function getChats() {
  const chats = [];
  if (!fs.existsSync(PROJECTS_DIR)) return chats;

  let projDirs;
  try { projDirs = fs.readdirSync(PROJECTS_DIR); } catch { return chats; }

  for (const projDir of projDirs) {
    const dir = path.join(PROJECTS_DIR, projDir);
    try { if (!fs.statSync(dir).isDirectory()) continue; } catch { continue; }

    // Decode folder path from dir name (e.g. users-fka-code-foo -> /users/fka/code/foo)
    const decodedFolder = '/' + projDir.replace(/-/g, '/');

    let files;
    try { files = fs.readdirSync(dir).filter(f => f.endsWith('.jsonl') && !f.includes('.checkpoints.')); } catch { continue; }

    for (const file of files) {
      const sessionId = file.replace('.jsonl', '');
      const fullPath = path.join(dir, file);
      const metaPath = path.join(dir, `${sessionId}.meta.json`);

      // Read meta.json for title
      let title = null;
      try {
        const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
        title = meta.title || null;
      } catch { /* no meta */ }

      // Parse first and last lines for timestamps
      try {
        const stat = fs.statSync(fullPath);
        const lines = fs.readFileSync(fullPath, 'utf-8').split('\n').filter(Boolean);
        if (lines.length === 0) continue;

        const first = JSON.parse(lines[0]);
        const last = JSON.parse(lines[lines.length - 1]);

        const firstPrompt = extractFirstPrompt(first);
        const bubbleCount = lines.length;

        chats.push({
          source: 'commandcode',
          composerId: sessionId,
          name: title || cleanPrompt(firstPrompt),
          createdAt: first.timestamp ? new Date(first.timestamp).getTime() : stat.birthtime.getTime(),
          lastUpdatedAt: last.timestamp ? new Date(last.timestamp).getTime() : stat.mtime.getTime(),
          mode: 'commandcode',
          folder: decodedFolder,
          encrypted: false,
          bubbleCount,
          _fullPath: fullPath,
          _gitBranch: first.gitBranch || null,
        });
      } catch { /* skip */ }
    }
  }

  return chats;
}

function extractFirstPrompt(obj) {
  if (obj.role !== 'user') return null;
  if (!obj.content) return null;
  if (typeof obj.content === 'string') return obj.content;
  if (Array.isArray(obj.content)) {
    return obj.content
      .filter(c => c.type === 'text')
      .map(c => c.text)
      .join(' ')
      .substring(0, 200);
  }
  return null;
}

function cleanPrompt(text) {
  if (!text) return null;
  return text.replace(/\s+/g, ' ').trim().substring(0, 120) || null;
}

function getMessages(chat) {
  const filePath = chat._fullPath;
  if (!filePath || !fs.existsSync(filePath)) return [];

  const messages = [];
  const lines = fs.readFileSync(filePath, 'utf-8').split('\n').filter(Boolean);

  for (const line of lines) {
    let obj;
    try { obj = JSON.parse(line); } catch { continue; }

    if (obj.role === 'user') {
      const content = extractContent(obj.content);
      if (content) messages.push({ role: 'user', content });
    } else if (obj.role === 'assistant') {
      const { text, toolCalls } = extractAssistantContent(obj.content);
      if (text) {
        messages.push({
          role: 'assistant',
          content: text,
          _toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
        });
      }
    } else if (obj.role === 'system') {
      const text = extractContent(obj.content);
      if (text) messages.push({ role: 'system', content: text });
    }
  }

  return messages;
}

function extractContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  // Skip tool_result blocks for user messages (they are tool outputs)
  return content
    .filter(c => c.type === 'text')
    .map(c => c.text)
    .join('\n') || '';
}

function extractAssistantContent(content) {
  if (typeof content === 'string') return { text: content, toolCalls: [] };
  if (!Array.isArray(content)) return { text: '', toolCalls: [] };
  const parts = [];
  const toolCalls = [];
  for (const block of content) {
    if (block.type === 'thinking' && block.thinking) {
      parts.push(`[thinking] ${block.thinking}`);
    } else if (block.type === 'text' && block.text) {
      parts.push(block.text);
    } else if (block.type === 'tool_use') {
      const args = block.input || {};
      const argKeys = Object.keys(args).join(', ');
      parts.push(`[tool-call: ${block.name || 'unknown'}(${argKeys})]`);
      toolCalls.push({ name: block.name || 'unknown', args });
    } else if (block.type === 'tool_result') {
      const text = typeof block.content === 'string' ? block.content : '';
      parts.push(`[tool-result: ${block.name || 'tool'}] ${text.substring(0, 500)}`);
    }
  }
  return { text: parts.join('\n') || '', toolCalls };
}

const labels = { 'commandcode': 'Command Code' };

module.exports = { name, labels, getChats, getMessages };
