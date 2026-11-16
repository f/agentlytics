const path = require('path');
const fs = require('fs');
const os = require('os');
const fzstd = require('fzstd');

// DeepSeek Harness (DSH) desktop app stores sessions under ~/.dsh:
//   ~/.dsh/sessions/<munged-cwd>/session-<uuid>/session.v4.jsonl.zstd — full event log
//   ~/.dsh/storages/session_projcache/sessions/session-<uuid>.json — metadata projection
const DSH_ROOT = path.join(os.homedir(), '.dsh');
const PROJCACHE_DIR = path.join(DSH_ROOT, 'storages', 'session_projcache', 'sessions');
const SESSIONS_DIR = path.join(DSH_ROOT, 'sessions');

const name = 'dsh';
const labels = { dsh: 'DeepSeek Harness' };

// Event cache so getChats and getMessages share one decompression pass
const eventCache = new Map();

function resetCache() {
  eventCache.clear();
}

function isInstalled() {
  return fs.existsSync(DSH_ROOT);
}

// Directory names under ~/.dsh/sessions munge "/" as "--"
function unmungeProjectDir(dirName) {
  return dirName.replace(/--/g, '/');
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch {
    return null;
  }
}

// Decompress the zstd event log and return parsed events, cached per session
function getSessionEvents(sessionId) {
  if (eventCache.has(sessionId)) return eventCache.get(sessionId);
  const events = { events: null, header: null, lastTime: null };

  const logPath = findLogPath(sessionId);
  if (logPath) {
    try {
      const compressed = fs.readFileSync(logPath);
      const text = new TextDecoder().decode(fzstd.decompress(compressed));
      const lines = text.split('\n').filter(l => l.trim());
      const eventsList = [];
      for (const line of lines) {
        try { eventsList.push(JSON.parse(line)); } catch { /* skip */ }
      }
      events.events = eventsList;
      events.header = eventsList.find(e => e.type === 'session') || null;
      if (eventsList.length > 0) {
        events.lastTime = eventsList[eventsList.length - 1].time || null;
      }
    } catch { /* unreadable log */ }
  }

  eventCache.set(sessionId, events);
  return events;
}

function findLogPath(sessionId) {
  try {
    const projectDirs = fs.readdirSync(SESSIONS_DIR, { withFileTypes: true })
      .filter(d => d.isDirectory());
    for (const dir of projectDirs) {
      const sessionDir = path.join(SESSIONS_DIR, dir.name, sessionId);
      const logPath = path.join(sessionDir, 'session.v4.jsonl.zstd');
      if (fs.existsSync(logPath)) return logPath;
    }
  } catch { /* no sessions dir */ }
  return null;
}

// Index: sessionId → munged project dir (built once per scan)
let logIndex = null;
function buildLogIndex() {
  logIndex = new Map();
  try {
    for (const dir of fs.readdirSync(SESSIONS_DIR, { withFileTypes: true })) {
      if (!dir.isDirectory()) continue;
      const projectDir = path.join(SESSIONS_DIR, dir.name);
      try {
        for (const entry of fs.readdirSync(projectDir, { withFileTypes: true })) {
          if (entry.isDirectory() && entry.name.startsWith('session-')) {
            logIndex.set(entry.name, projectDir);
          }
        }
      } catch { /* skip */ }
    }
  } catch { /* no sessions dir */ }
}

function getProjcacheEntry(sessionId) {
  const filePath = path.join(PROJCACHE_DIR, `${sessionId}.json`);
  if (!fs.existsSync(filePath)) return null;
  const parsed = readJson(filePath);
  if (!parsed || !parsed.record || !parsed.record.rows) return null;
  return parsed.record;
}

function projcacheRow(record, key) {
  const row = record.rows[key];
  return row && typeof row === 'object' ? row.val : undefined;
}

function extractModelRef(config) {
  if (!config || typeof config !== 'object') return { modelValue: null, providerValue: null };
  const model = typeof config.model === 'string' ? config.model : null;
  const provider = typeof config.provider === 'string' ? config.provider : null;
  return { modelValue: model, providerValue: provider };
}

function countMessages(events) {
  if (!events) return 0;
  return events.filter(e => e.type === 'user/message' || e.type === 'assistant/message').length;
}

function getChats() {
  if (!isInstalled()) return [];
  if (!logIndex) buildLogIndex();

  const chats = [];
  const seen = new Set();

  // 1. Sessions with a full event log
  for (const [sessionId, projectDir] of logIndex) {
    seen.add(sessionId);
    const { header, events, lastTime } = getSessionEvents(sessionId);
    const projcache = getProjcacheEntry(sessionId);

    const titleRow = projcache ? projcacheRow(projcache, 'title') : undefined;
    const workdirRow = projcache ? projcacheRow(projcache, 'workingDirectory') : undefined;
    const lastPromptRow = projcache ? projcacheRow(projcache, 'sessionListMetadata') : undefined;
    const timeContextRow = projcache ? projcacheRow(projcache, 'timeContext') : undefined;
    const modelRow = projcache ? projcacheRow(projcache, 'modelSelection') : undefined;
    const usageRow = projcache ? projcacheRow(projcache, 'tokenUsage') : undefined;

    const folder = (workdirRow && typeof workdirRow === 'string' && workdirRow)
      || (header && header.cwd)
      || unmungeProjectDir(path.basename(projectDir));

    const createdAt = (header && header.createdAt)
      || (projcache && projcache.identity && projcache.identity.createdAt)
      || null;

    const lastUpdatedAt = (timeContextRow && timeContextRow.lastMessageTime)
      || (lastPromptRow && lastPromptRow.lastPromptAt)
      || lastTime
      || null;

    const { modelValue, providerValue } = extractModelRef(modelRow && modelRow.lastUsed);

    chats.push({
      source: 'dsh',
      composerId: sessionId,
      name: typeof titleRow === 'string' && titleRow ? titleRow : null,
      createdAt,
      lastUpdatedAt,
      mode: 'dsh',
      folder: folder || null,
      encrypted: false,
      bubbleCount: countMessages(events),
      _model: modelValue,
      _provider: providerValue,
      _usageTotals: (usageRow && usageRow.totals) || null,
      _storageType: 'event-log',
    });
  }

  // 2. Sessions known only from the metadata projection (log pruned/moved)
  try {
    for (const file of fs.readdirSync(PROJCACHE_DIR)) {
      if (!file.startsWith('session-') || !file.endsWith('.json')) continue;
      const sessionId = file.slice(0, -5);
      if (seen.has(sessionId)) continue;
      seen.add(sessionId);
      const record = getProjcacheEntry(sessionId);
      if (!record) continue;

      const identity = record.identity || {};
      const titleRow = projcacheRow(record, 'title');
      const workdirRow = projcacheRow(record, 'workingDirectory');
      const lastPromptRow = projcacheRow(record, 'sessionListMetadata');
      const timeContextRow = projcacheRow(record, 'timeContext');
      const modelRow = projcacheRow(record, 'modelSelection');
      const usageRow = projcacheRow(record, 'tokenUsage');
      const statsRow = projcacheRow(record, 'sessionStats');

      const { modelValue, providerValue } = extractModelRef(modelRow && modelRow.lastUsed);

      chats.push({
        source: 'dsh',
        composerId: sessionId,
        name: typeof titleRow === 'string' && titleRow ? titleRow : null,
        createdAt: identity.createdAt || null,
        lastUpdatedAt: (timeContextRow && timeContextRow.lastMessageTime)
          || (lastPromptRow && lastPromptRow.lastPromptAt)
          || null,
        mode: 'dsh',
        folder: (workdirRow && typeof workdirRow === 'string' && workdirRow) || identity.cwd || null,
        encrypted: false,
        bubbleCount: statsRow && typeof statsRow.turns === 'number' ? statsRow.turns : 0,
        _model: modelValue,
        _provider: providerValue,
        _usageTotals: (usageRow && usageRow.totals) || null,
        _storageType: 'projcache-only',
      });
    }
  } catch { /* no projcache dir */ }

  return chats.sort((a, b) => (b.lastUpdatedAt || b.createdAt || 0) - (a.lastUpdatedAt || a.createdAt || 0));
}

function argSummary(toolCall) {
  const raw = toolCall?.arguments ?? toolCall?.input ?? null;
  if (raw == null) return '';
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') return Object.keys(parsed).join(', ');
      return raw;
    } catch {
      return raw;
    }
  }
  if (typeof raw === 'object') return Object.keys(raw).join(', ');
  return String(raw);
}

function getMessages(chat) {
  const { events } = getSessionEvents(chat.composerId);
  if (!events) return [];

  const messages = [];
  // toolCallId → message object, so results can be appended inline
  const toolCallMessages = new Map();
  let currentModel = null;
  let lastAssistant = null;

  for (const event of events) {
    const type = event.type;
    const data = event.data;

    if (type === 'request/header' || type === 'model/selection') {
      const config = type === 'request/header' ? (data && data.header && data.header.config) : data;
      const parsed = extractModelRef(config);
      if (parsed.modelValue || parsed.providerValue) currentModel = parsed;
      continue;
    }

    if (type === 'user/message') {
      const contentParts = [];
      const content = data && Array.isArray(data.content) ? data.content : [];
      for (const part of content) {
        if (part && part.type === 'text' && typeof part.text === 'string' && part.text) {
          contentParts.push(part.text);
        }
      }
      if (contentParts.length === 0) continue;
      messages.push({
        role: 'user',
        content: contentParts.join('\n'),
        _model: null,
        _provider: null,
      });
      continue;
    }

    if (type === 'assistant/message') {
      const message = data && data.message;
      const content = message && Array.isArray(message.content) ? message.content : [];
      const contentParts = [];
      const toolCallsInMessage = [];
      for (const part of content) {
        if (!part || typeof part !== 'object') continue;
        if (part.type === 'text' && typeof part.text === 'string') {
          if (part.text) contentParts.push(part.text);
        } else if (part.type === 'reasoning' && typeof part.text === 'string') {
          if (part.text) contentParts.push(`[thinking] ${part.text}`);
        } else if (part.type === 'tool-call') {
          const toolName = part.name || 'tool';
          contentParts.push(`[tool-call: ${toolName}(${argSummary(part)})]`);
          if (part.id) toolCallsInMessage.push({ callId: part.id, name: toolName });
        }
      }
      if (contentParts.length === 0) continue;

      const msg = {
        role: 'assistant',
        content: contentParts.join('\n'),
        _model: currentModel ? currentModel.modelValue : null,
        _provider: currentModel ? currentModel.providerValue : null,
      };
      messages.push(msg);
      lastAssistant = msg;
      for (const tc of toolCallsInMessage) toolCallMessages.set(tc.callId, msg);
      continue;
    }

    if (type === 'tool/result') {
      const message = data && data.message;
      const callId = (message && (message.toolCallId || (message.source && message.source.callId))) || null;
      const content = message && Array.isArray(message.content) ? message.content : [];
      const text = content
        .filter(p => p && p.type === 'text' && typeof p.text === 'string')
        .map(p => p.text)
        .join('\n');
      if (!text) continue;
      const target = callId ? toolCallMessages.get(callId) : null;
      if (target) {
        target.content += `\n[tool-result] ${text.substring(0, 500)}`;
      } else {
        messages.push({
          role: 'assistant',
          content: `[tool-result] ${text.substring(0, 500)}`,
          _model: currentModel ? currentModel.modelValue : null,
          _provider: currentModel ? currentModel.providerValue : null,
        });
      }
      continue;
    }
  }

  // Attach session-level usage totals to the last assistant message so the
  // token economy reflects real usage (the event log has no per-message usage)
  let totals = chat._usageTotals;
  if (!totals) {
    const record = getProjcacheEntry(chat.composerId);
    const usageRow = record ? projcacheRow(record, 'tokenUsage') : undefined;
    totals = usageRow && usageRow.totals;
  }
  if (totals && lastAssistant) {
    lastAssistant._inputTokens = totals.uncachedInputTokens ?? null;
    lastAssistant._outputTokens = totals.outputTokens ?? null;
    lastAssistant._cacheRead = totals.cacheReadTokens ?? null;
    lastAssistant._cacheWrite = totals.cacheWriteTokens ?? null;
  }

  return messages;
}

module.exports = { name, labels, getChats, getMessages, resetCache };
