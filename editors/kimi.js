const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const name = 'kimi-cli';
const DEFAULT_KIMI_DIR = path.join(os.homedir(), '.kimi');
const SESSIONS_SUBDIR = 'sessions';
const KIMI_JSON = 'kimi.json';
const CONFIG_TOML = 'config.toml';
const MAX_TOOL_TEXT = 2000;

function getChats() {
  const kimiDir = getKimiDir();
  const sessionsDir = path.join(kimiDir, SESSIONS_SUBDIR);
  if (!fs.existsSync(sessionsDir)) return [];

  const folderMap = loadFolderMap(kimiDir);
  const defaultModel = loadDefaultModel(kimiDir);
  const chats = [];

  for (const session of walkSessions(sessionsDir)) {
    const parsed = parseSession(session.sessionDir, defaultModel);
    if (!parsed || parsed.messages.length === 0) continue;

    chats.push({
      source: name,
      composerId: session.sessionId,
      name: parsed.title,
      createdAt: parsed.createdAt,
      lastUpdatedAt: parsed.lastUpdatedAt,
      mode: 'kimi',
      folder: folderMap.get(session.hash) || null,
      encrypted: false,
      bubbleCount: parsed.messages.length,
      _sessionDir: session.sessionDir,
      _defaultModel: defaultModel,
    });
  }

  return chats;
}

function getMessages(chat) {
  const sessionDir = chat && chat._sessionDir;
  if (!sessionDir || !fs.existsSync(sessionDir)) return [];
  const parsed = parseSession(sessionDir, chat._defaultModel || null);
  return parsed ? parsed.messages : [];
}

function getKimiDir() {
  const fromEnv = process.env.KIMI_SHARE_DIR && process.env.KIMI_SHARE_DIR.trim();
  return fromEnv ? path.resolve(fromEnv) : DEFAULT_KIMI_DIR;
}

function walkSessions(sessionsDir) {
  const sessions = [];
  let hashDirs;
  try {
    hashDirs = fs.readdirSync(sessionsDir, { withFileTypes: true });
  } catch {
    return sessions;
  }

  for (const hashEntry of hashDirs) {
    if (!hashEntry.isDirectory()) continue;
    const hash = hashEntry.name;
    const hashDir = path.join(sessionsDir, hash);
    let sessionDirs;
    try {
      sessionDirs = fs.readdirSync(hashDir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const sessionEntry of sessionDirs) {
      if (!sessionEntry.isDirectory()) continue;
      sessions.push({
        hash,
        sessionId: sessionEntry.name,
        sessionDir: path.join(hashDir, sessionEntry.name),
      });
    }
  }

  return sessions;
}

function loadFolderMap(kimiDir) {
  const map = new Map();
  const jsonPath = path.join(kimiDir, KIMI_JSON);
  let data;
  try {
    data = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));
  } catch {
    return map;
  }

  const workDirs = Array.isArray(data.work_dirs) ? data.work_dirs : [];
  for (const workDir of workDirs) {
    if (!workDir || typeof workDir.path !== 'string' || !workDir.path.trim()) continue;
    const rawPath = workDir.path.trim();
    map.set(hashPath(rawPath), rawPath);
    try {
      const resolved = path.resolve(rawPath);
      map.set(hashPath(resolved), rawPath);
    } catch {
      // Ignore invalid paths and keep the raw mapping.
    }
  }

  return map;
}

function loadDefaultModel(kimiDir) {
  const configPath = path.join(kimiDir, CONFIG_TOML);
  let raw;
  try {
    raw = fs.readFileSync(configPath, 'utf-8');
  } catch {
    return null;
  }

  const match = raw.match(/^default_model\s*=\s*"([^"]+)"/m);
  return match ? match[1].trim() : null;
}

function hashPath(folderPath) {
  return crypto.createHash('md5').update(folderPath).digest('hex');
}

function parseSession(sessionDir, defaultModel) {
  const contextFiles = getContextFiles(sessionDir);
  if (contextFiles.length === 0) return null;

  const contextEntries = [];
  for (const filePath of contextFiles) {
    contextEntries.push(...readJsonl(filePath));
  }

  const wire = parseWireFile(path.join(sessionDir, 'wire.jsonl'));
  const messages = [];
  const assistantIndexes = [];
  const toolNamesById = new Map();

  for (const entry of contextEntries) {
    if (!entry || entry.role === '_checkpoint' || entry.role === '_usage') continue;

    if (entry.role === 'user') {
      const text = extractText(entry.content);
      if (text) messages.push({ role: 'user', content: text });
      continue;
    }

    if (entry.role === 'assistant') {
      const parsed = parseAssistant(entry, defaultModel);
      if (!parsed) continue;
      assistantIndexes.push(messages.length);
      if (Array.isArray(entry.tool_calls)) {
        for (const call of entry.tool_calls) {
          const callId = call && call.id;
          const toolName = call && (call.function && call.function.name || call.name);
          if (callId && toolName) toolNamesById.set(callId, toolName);
        }
      }
      messages.push(parsed);
      continue;
    }

    if (entry.role === 'tool') {
      const toolName = entry.tool_call_id ? toolNamesById.get(entry.tool_call_id) : null;
      const text = extractToolText(entry.content, toolName);
      if (text) messages.push({ role: 'tool', content: text });
      continue;
    }

    if (entry.role === 'system') {
      const text = extractText(entry.content);
      if (text) messages.push({ role: 'system', content: text });
    }
  }

  if (assistantIndexes.length > 0 && wire.statuses.length === assistantIndexes.length) {
    for (let i = 0; i < assistantIndexes.length; i++) {
      const msg = messages[assistantIndexes[i]];
      const usage = wire.statuses[i];
      if (!msg || !usage) continue;
      if (usage.inputTokens > 0) msg._inputTokens = usage.inputTokens;
      if (usage.outputTokens > 0) msg._outputTokens = usage.outputTokens;
      if (usage.cacheRead > 0) msg._cacheRead = usage.cacheRead;
      if (usage.cacheWrite > 0) msg._cacheWrite = usage.cacheWrite;
    }
  }

  const title = getTitle(messages);
  const fallbackTimes = getFallbackTimes(contextFiles, wire.filePath ? [wire.filePath] : []);

  return {
    title,
    messages,
    createdAt: wire.firstTimestamp || fallbackTimes.createdAt,
    lastUpdatedAt: wire.lastTimestamp || fallbackTimes.lastUpdatedAt,
  };
}

function getContextFiles(sessionDir) {
  let fileNames;
  try {
    fileNames = fs.readdirSync(sessionDir);
  } catch {
    return [];
  }

  return fileNames
    .filter((name) => /^context(?:_(?:sub_)?\d+)?\.jsonl$/.test(name))
    .sort(compareContextFiles)
    .map((name) => path.join(sessionDir, name));
}

function compareContextFiles(a, b) {
  const aLive = a === 'context.jsonl';
  const bLive = b === 'context.jsonl';
  if (aLive !== bLive) return aLive ? 1 : -1;

  const aNum = getContextSuffix(a);
  const bNum = getContextSuffix(b);
  if (aNum !== bNum) return aNum - bNum;

  return a.localeCompare(b, undefined, { numeric: true });
}

function getContextSuffix(fileName) {
  const match = fileName.match(/^context(?:_sub)?_(\d+)\.jsonl$/);
  return match ? parseInt(match[1], 10) : Number.MAX_SAFE_INTEGER;
}

function readJsonl(filePath) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf-8');
  } catch {
    return [];
  }

  return raw
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function parseAssistant(entry, defaultModel) {
  const parts = [];

  if (typeof entry.content === 'string') {
    const text = cleanText(entry.content);
    if (text) parts.push(text);
  } else if (Array.isArray(entry.content)) {
    for (const block of entry.content) {
      if (!block) continue;
      if (block.type === 'think' && block.think && !block.encrypted) {
        parts.push(`[thinking] ${cleanText(block.think)}`);
      } else if (block.type === 'text' && block.text) {
        parts.push(cleanText(block.text));
      }
    }
  }

  const toolCalls = [];
  if (Array.isArray(entry.tool_calls)) {
    for (const call of entry.tool_calls) {
      const normalized = normalizeToolCall(call);
      if (!normalized) continue;
      const argKeys = Object.keys(normalized.args || {}).join(', ');
      parts.push(`[tool-call: ${normalized.name}(${argKeys})]`);
      toolCalls.push(normalized);
    }
  }

  const content = parts.filter(Boolean).join('\n').trim();
  if (!content && toolCalls.length === 0) return null;

  const message = {
    role: 'assistant',
    content,
  };

  const model = entry.model || defaultModel || null;
  if (model) message._model = model;
  if (toolCalls.length > 0) message._toolCalls = toolCalls;
  return message;
}

function normalizeToolCall(call) {
  if (!call) return null;
  const name = call.function && call.function.name || call.name || 'unknown';
  const rawArgs = call.function && call.function.arguments !== undefined
    ? call.function.arguments
    : call.arguments !== undefined
      ? call.arguments
      : call.input;

  let args = {};
  if (typeof rawArgs === 'string') {
    try {
      args = JSON.parse(rawArgs);
    } catch {
      args = {};
    }
  } else if (rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs)) {
    args = rawArgs;
  }

  return { name, args };
}

function extractToolText(content, toolName) {
  const parts = [];
  if (typeof content === 'string') {
    const text = cleanText(stripSystemTags(content));
    if (text) parts.push(text);
  } else if (Array.isArray(content)) {
    for (const block of content) {
      if (!block || block.type !== 'text' || !block.text) continue;
      const text = cleanText(stripSystemTags(block.text));
      if (text) parts.push(text);
    }
  }

  const joined = parts.join('\n').trim();
  if (!joined) return null;

  const condensed = joined.length > MAX_TOOL_TEXT
    ? `${joined.substring(0, MAX_TOOL_TEXT)}...`
    : joined;

  return toolName ? `[${toolName}] ${condensed}` : condensed;
}

function extractText(content) {
  if (!content) return '';
  if (typeof content === 'string') return cleanText(content);
  if (Array.isArray(content)) {
    return content
      .map((block) => {
        if (!block) return '';
        if (block.type === 'text' && block.text) return cleanText(block.text);
        if (block.type === 'think' && block.think && !block.encrypted) return cleanText(block.think);
        return '';
      })
      .filter(Boolean)
      .join('\n')
      .trim();
  }
  if (content.text) return cleanText(content.text);
  return '';
}

function cleanText(text) {
  return String(text || '').replace(/\r\n/g, '\n').trim();
}

function stripSystemTags(text) {
  return String(text || '')
    .replace(/^<system>/, '')
    .replace(/<\/system>$/, '')
    .trim();
}

function getTitle(messages) {
  const firstUser = messages.find((msg) => msg.role === 'user' && msg.content && msg.content.trim());
  if (!firstUser) return null;
  return firstUser.content.replace(/\s+/g, ' ').trim().substring(0, 120) || null;
}

function parseWireFile(filePath) {
  if (!fs.existsSync(filePath)) {
    return { filePath: null, firstTimestamp: null, lastTimestamp: null, statuses: [] };
  }

  const entries = readJsonl(filePath);
  let firstTimestamp = null;
  let lastTimestamp = null;
  const statuses = [];

  for (const entry of entries) {
    const timestamp = toTimestampMs(entry.timestamp);
    if (timestamp) {
      if (firstTimestamp === null) firstTimestamp = timestamp;
      lastTimestamp = timestamp;
    }

    const type = entry.message && entry.message.type || entry.type;
    if (type !== 'StatusUpdate') continue;

    const usage = entry.message && entry.message.payload && entry.message.payload.token_usage || {};
    statuses.push({
      inputTokens: usage.input_other || 0,
      outputTokens: usage.output || 0,
      cacheRead: usage.input_cache_read || 0,
      cacheWrite: usage.input_cache_creation || 0,
    });
  }

  return { filePath, firstTimestamp, lastTimestamp, statuses };
}

function toTimestampMs(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return value > 1e12 ? Math.round(value) : Math.round(value * 1000);
}

function getFallbackTimes(contextFiles, extraFiles = []) {
  const filePaths = [...contextFiles, ...extraFiles].filter((filePath) => filePath && fs.existsSync(filePath));
  let createdAt = null;
  let lastUpdatedAt = null;

  for (const filePath of filePaths) {
    let stat;
    try {
      stat = fs.statSync(filePath);
    } catch {
      continue;
    }

    const birthtime = Number.isFinite(stat.birthtimeMs) && stat.birthtimeMs > 0 ? stat.birthtimeMs : stat.mtimeMs;
    const mtime = stat.mtimeMs || birthtime;
    if (birthtime && (createdAt === null || birthtime < createdAt)) createdAt = birthtime;
    if (mtime && (lastUpdatedAt === null || mtime > lastUpdatedAt)) lastUpdatedAt = mtime;
  }

  return { createdAt, lastUpdatedAt };
}

module.exports = { name, getChats, getMessages };
