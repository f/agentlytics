const path = require('path');
const fs = require('fs');
const os = require('os');
const { scanArtifacts, parseMcpConfigFile } = require('./base');

const name = 'pi';
const labels = { pi: 'Pi Agent' };
const PI_HOME = process.env.PI_CODING_AGENT_DIR && process.env.PI_CODING_AGENT_DIR.trim()
  ? path.resolve(process.env.PI_CODING_AGENT_DIR.trim())
  : (process.env.PI_HOME && process.env.PI_HOME.trim()
      ? path.resolve(process.env.PI_HOME.trim())
      : path.join(os.homedir(), '.pi', 'agent'));
const SESSIONS_DIR = process.env.PI_CODING_AGENT_SESSION_DIR && process.env.PI_CODING_AGENT_SESSION_DIR.trim()
  ? path.resolve(process.env.PI_CODING_AGENT_SESSION_DIR.trim())
  : path.join(PI_HOME, 'sessions');
const MAX_TOOL_RESULT_PREVIEW = 500;

function getChats() {
  const chats = [];
  if (!fs.existsSync(SESSIONS_DIR)) return chats;

  for (const filePath of walkJsonlFiles(SESSIONS_DIR)) {
    const chat = readChatMetadata(filePath);
    if (chat) chats.push(chat);
  }

  return chats;
}

function getMessages(chat) {
  const filePath = chat && chat._filePath;
  if (!filePath || !fs.existsSync(filePath)) return [];
  return parseSessionMessages(filePath);
}

function walkJsonlFiles(dir) {
  const results = [];
  const stack = [dir];

  while (stack.length > 0) {
    const current = stack.pop();
    let entries;
    try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch { continue; }

    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(fullPath);
      else if (entry.isFile() && entry.name.endsWith('.jsonl')) results.push(fullPath);
    }
  }

  return results.sort();
}

function readChatMetadata(filePath) {
  const lines = readLines(filePath);
  if (lines.length === 0) return null;

  const header = safeParseJson(lines[0]);
  if (!header || header.type !== 'session') return null;

  let firstPrompt = null;
  let messageCount = 0;
  let lastTimestamp = toTimestamp(header.timestamp);

  for (let i = 1; i < lines.length; i++) {
    const entry = safeParseJson(lines[i]);
    if (!entry) continue;
    const ts = toTimestamp(entry.timestamp || entry.message?.timestamp);
    if (ts && (!lastTimestamp || ts > lastTimestamp)) lastTimestamp = ts;

    if (entry.type === 'custom_message') {
      if (entry.display !== false) messageCount++;
      continue;
    }

    if (entry.type !== 'message' || !entry.message) continue;
    const msg = entry.message;
    if (isVisibleRole(msg.role)) messageCount++;
    if (!firstPrompt && msg.role === 'user') {
      const text = extractTextContent(msg.content);
      if (text) firstPrompt = cleanPrompt(text);
    }
  }

  let stat = null;
  try { stat = fs.statSync(filePath); } catch {}

  const sessionId = header.id || path.basename(filePath, '.jsonl').split('_').pop();
  return {
    source: 'pi',
    composerId: sessionId || path.basename(filePath, '.jsonl'),
    name: firstPrompt,
    createdAt: toTimestamp(header.timestamp) || (stat ? stat.birthtimeMs : null),
    lastUpdatedAt: lastTimestamp || (stat ? stat.mtimeMs : null),
    mode: 'pi',
    folder: header.cwd || decodeFolderFromPath(filePath),
    encrypted: false,
    bubbleCount: messageCount,
    _filePath: filePath,
    _version: header.version || null,
    _parentSession: header.parentSession || null,
  };
}

function parseSessionMessages(filePath) {
  const messages = [];

  for (const line of readLines(filePath)) {
    const entry = safeParseJson(line);
    if (!entry) continue;

    if (entry.type === 'model_change') {
      const model = [entry.provider, entry.modelId].filter(Boolean).join('/') || entry.modelId || null;
      if (model) messages.push({ role: 'system', content: `[model changed to ${model}]`, _model: model });
      continue;
    }

    if (entry.type === 'compaction' && entry.summary) {
      messages.push({ role: 'system', content: `[compaction] ${entry.summary}` });
      continue;
    }

    if (entry.type === 'branch_summary' && entry.summary) {
      messages.push({ role: 'system', content: `[branch summary] ${entry.summary}` });
      continue;
    }

    if (entry.type === 'custom_message') {
      if (entry.display !== false) {
        const content = extractTextContent(entry.content);
        if (content) messages.push({ role: 'system', content: `[${entry.customType || 'custom'}] ${content}` });
      }
      continue;
    }

    if (entry.type !== 'message' || !entry.message) continue;
    const msg = entry.message;

    if (msg.role === 'user') {
      const content = extractTextContent(msg.content);
      if (content) messages.push({ role: 'user', content });
      continue;
    }

    if (msg.role === 'assistant') {
      const { text, toolCalls } = extractAssistantContent(msg.content);
      const usage = normalizeUsage(msg.usage);
      if (text || toolCalls.length > 0 || usage) {
        messages.push({
          role: 'assistant',
          content: text || toolCalls.map((tc) => `[tool-call: ${tc.name}]`).join('\n'),
          _model: msg.model || null,
          _provider: msg.provider || null,
          _inputTokens: usage?.input,
          _outputTokens: usage?.output,
          _cacheRead: usage?.cacheRead,
          _cacheWrite: usage?.cacheWrite,
          _toolCalls: toolCalls,
        });
      }
      continue;
    }

    if (msg.role === 'toolResult') {
      const content = extractTextContent(msg.content).substring(0, MAX_TOOL_RESULT_PREVIEW);
      messages.push({
        role: 'tool',
        content: `[tool-result: ${msg.toolName || 'tool'}${msg.isError ? ' error' : ''}]${content ? ` ${content}` : ''}`,
      });
      continue;
    }

    if (msg.role === 'bashExecution') {
      const content = [`$ ${msg.command || ''}`, msg.output || ''].filter(Boolean).join('\n').substring(0, MAX_TOOL_RESULT_PREVIEW);
      messages.push({ role: 'tool', content: `[bash-execution] ${content}` });
      continue;
    }

    if (msg.role === 'custom' && msg.display !== false) {
      const content = extractTextContent(msg.content);
      if (content) messages.push({ role: 'system', content: `[${msg.customType || 'custom'}] ${content}` });
      continue;
    }

    if (msg.role === 'branchSummary' && msg.summary) {
      messages.push({ role: 'system', content: `[branch summary] ${msg.summary}` });
    } else if (msg.role === 'compactionSummary' && msg.summary) {
      messages.push({ role: 'system', content: `[compaction] ${msg.summary}` });
    }
  }

  return messages;
}

function extractAssistantContent(content) {
  const parts = [];
  const toolCalls = [];
  const blocks = Array.isArray(content) ? content : [{ type: 'text', text: String(content || '') }];

  for (const block of blocks) {
    if (!block) continue;
    if (block.type === 'text' && block.text) {
      parts.push(block.text);
    } else if (block.type === 'thinking' && block.thinking) {
      parts.push(`[thinking] ${block.thinking}`);
    } else if (block.type === 'toolCall') {
      const toolName = block.name || 'tool';
      const args = block.arguments || {};
      toolCalls.push({ name: toolName, args });
      const argKeys = args && typeof args === 'object' ? Object.keys(args).join(', ') : '';
      parts.push(`[tool-call: ${toolName}(${argKeys})]`);
    }
  }

  return { text: parts.join('\n'), toolCalls };
}

function extractTextContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts = [];
  for (const block of content) {
    if (!block) continue;
    if (block.type === 'text' && block.text) parts.push(block.text);
    else if (block.type === 'image') parts.push(`[image: ${block.mimeType || 'image'}]`);
    else if (block.type === 'thinking' && block.thinking) parts.push(`[thinking] ${block.thinking}`);
  }
  return parts.join('\n');
}

function normalizeUsage(usage) {
  if (!usage || typeof usage !== 'object') return null;
  return {
    input: numberOrNull(usage.input),
    output: numberOrNull(usage.output),
    cacheRead: numberOrNull(usage.cacheRead),
    cacheWrite: numberOrNull(usage.cacheWrite),
  };
}

function getArtifacts(folder) {
  return scanArtifacts(folder, {
    editor: 'pi',
    label: 'Pi Agent',
    files: ['AGENTS.md', 'CLAUDE.md', '.pi/settings.json', '.pi/SYSTEM.md', '.pi/APPEND_SYSTEM.md'],
    dirs: ['.pi/prompts', '.pi/skills', '.pi/extensions', '.pi/themes'],
  });
}

function getMCPServers() {
  const servers = [];
  servers.push(...parseMcpConfigFile(path.join(PI_HOME, 'settings.json'), { editor: 'pi', label: 'Pi Agent', scope: 'global' }));
  return servers;
}

function readLines(filePath) {
  try { return fs.readFileSync(filePath, 'utf-8').split('\n').filter(Boolean); } catch { return []; }
}

function safeParseJson(line) {
  try { return JSON.parse(line); } catch { return null; }
}

function toTimestamp(value) {
  if (!value) return null;
  if (typeof value === 'number') return value;
  const ts = new Date(value).getTime();
  return Number.isFinite(ts) ? ts : null;
}

function numberOrNull(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function isVisibleRole(role) {
  return role === 'user' || role === 'assistant' || role === 'toolResult' || role === 'bashExecution' || role === 'custom';
}

function cleanPrompt(text) {
  return String(text || '').replace(/\s+/g, ' ').trim().substring(0, 120);
}

function decodeFolderFromPath(filePath) {
  const folderName = path.basename(path.dirname(filePath));
  if (!folderName.startsWith('--') || !folderName.endsWith('--')) return null;
  const inner = folderName.slice(2, -2);
  if (!inner) return null;
  if (process.platform === 'win32') {
    const parts = inner.split('--').filter(Boolean);
    if (parts.length > 1 && /^[A-Za-z]$/.test(parts[0])) return `${parts[0]}:\\${parts.slice(1).join('\\')}`;
  }
  return inner.replace(/--/g, path.sep);
}

module.exports = { name, labels, getChats, getMessages, getArtifacts, getMCPServers };
