const path = require('path');
const fs = require('fs');
const os = require('os');

const JB_DIR = path.join(os.homedir(), '.copilot', 'jb');

// ============================================================
// Adapter interface
// ============================================================

const name = 'copilot-jetbrains';

/**
 * Parse partition-*.jsonl files from a JetBrains Copilot session directory.
 * Each line is one JSON event; partition-<N>.jsonl files are read in order.
 */
function parseEvents(sessionDir) {
  let entries;
  try { entries = fs.readdirSync(sessionDir); } catch { return []; }
  const partitions = entries
    .filter(f => /^partition-\d+\.jsonl$/.test(f))
    .sort((a, b) =>
      parseInt(a.match(/^partition-(\d+)\.jsonl$/)[1], 10) -
      parseInt(b.match(/^partition-(\d+)\.jsonl$/)[1], 10));

  const events = [];
  for (const p of partitions) {
    try {
      const raw = fs.readFileSync(path.join(sessionDir, p), 'utf-8');
      for (const line of raw.split('\n')) {
        if (!line.trim()) continue;
        try { events.push(JSON.parse(line)); } catch { /* skip malformed */ }
      }
    } catch { /* skip unreadable partition */ }
  }
  return events;
}

/**
 * Parse a JetBrains event `timestamp` field to epoch ms.
 * Handles ISO 8601 and the US-locale `MM/dd/yyyy HH:mm:ss` format emitted by
 * the JetBrains plugin.
 */
function parseTimestamp(ts) {
  if (!ts) return null;
  const str = String(ts);
  if (str.includes('T')) {
    const t = Date.parse(str);
    if (!Number.isNaN(t)) return t;
  }
  const m = str.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2}):(\d{2})$/);
  if (m) return Date.UTC(+m[3], +m[1] - 1, +m[2], +m[4], +m[5], +m[6]);
  return null;
}

function getChats() {
  const chats = [];
  if (!fs.existsSync(JB_DIR)) return chats;

  let sessionDirs;
  try { sessionDirs = fs.readdirSync(JB_DIR); } catch { return chats; }

  for (const dirName of sessionDirs) {
    const sessionDir = path.join(JB_DIR, dirName);
    try { if (!fs.statSync(sessionDir).isDirectory()) continue; } catch { continue; }

    const events = parseEvents(sessionDir);
    const userMessages = events.filter(e => e.type === 'user.message');
    const assistantMessages = events.filter(e => e.type === 'assistant.message');
    const firstUser = userMessages[0];

    // Count meaningful messages (user + assistant)
    const bubbleCount = userMessages.length + assistantMessages.length;
    if (bubbleCount === 0) continue;

    let createdAt = null, lastUpdatedAt = null;
    for (const e of events) {
      const t = parseTimestamp(e.timestamp);
      if (t == null) continue;
      if (createdAt == null || t < createdAt) createdAt = t;
      if (lastUpdatedAt == null || t > lastUpdatedAt) lastUpdatedAt = t;
    }

    chats.push({
      source: 'copilot-jetbrains',
      composerId: dirName,
      name: cleanPrompt(firstUser?.data?.content),
      createdAt,
      lastUpdatedAt,
      mode: 'copilot',
      folder: null,
      encrypted: false,
      bubbleCount,
      _sessionDir: sessionDir,
    });
  }

  return chats;
}

function cleanPrompt(text) {
  if (!text) return null;
  return text.replace(/\s+/g, ' ').trim().substring(0, 120) || null;
}

function getMessages(chat) {
  const sessionDir = chat._sessionDir;
  if (!sessionDir || !fs.existsSync(sessionDir)) return [];

  const events = parseEvents(sessionDir);
  const result = [];

  // Tool calls in the JetBrains format are separate `tool.execution_start` /
  // `tool.execution_complete` events (NOT embedded in assistant.message like
  // the CLI format). Buffer pending tool calls and attach them to the next
  // assistant message iteration, per the spec's grouping algorithm.
  const pendingToolCalls = [];

  for (const event of events) {
    if (event.type === 'user.message') {
      const content = extractContent(event.data?.content);
      if (content) result.push({ role: 'user', content });

    } else if (event.type === 'tool.execution_start') {
      const data = event.data || {};
      const tcName = data.toolName || 'unknown';
      const args = data.arguments || {};
      const parsedArgs = typeof args === 'string' ? safeParse(args) : args;
      pendingToolCalls.push({ name: tcName, args: parsedArgs });

    } else if (event.type === 'assistant.message') {
      const data = event.data || {};
      const parts = [];
      const toolCalls = pendingToolCalls.length > 0 ? pendingToolCalls.splice(0) : [];

      // Main text content — handle legacy double-encoded JSON array shape.
      const text = extractContent(data.content != null ? data.content : data.text);
      if (text) parts.push(text);

      // Render buffered tool calls inline for compactness.
      for (const tc of toolCalls) {
        const argKeys = typeof tc.args === 'object' ? Object.keys(tc.args).join(', ') : '';
        parts.push(`[tool-call: ${tc.name}(${argKeys})]`);
      }

      if (parts.length > 0) {
        result.push({
          role: 'assistant',
          content: parts.join('\n'),
          _toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
        });
      }
    }
  }

  // Flush any tool calls left dangling (turn ended without a final assistant.message).
  if (pendingToolCalls.length > 0) {
    const parts = pendingToolCalls.map(tc => {
      const argKeys = typeof tc.args === 'object' ? Object.keys(tc.args).join(', ') : '';
      return `[tool-call: ${tc.name}(${argKeys})]`;
    });
    result.push({
      role: 'assistant',
      content: parts.join('\n'),
      _toolCalls: pendingToolCalls.splice(0),
    });
  }

  return result;
}

/**
 * Extract assistant response text from a `data.content` value.
 * Handles plain strings and the legacy double-encoded JSON array shape
 * (older partitions store content as a stringified array of
 * {role, content, tool_calls} objects — pick the last role:assistant
 * entry with non-empty content).
 */
function extractContent(contentVal) {
  if (contentVal == null) return '';
  if (typeof contentVal === 'string') {
    const trimmed = contentVal.trim();
    if (trimmed.startsWith('[')) {
      try {
        const arr = JSON.parse(contentVal);
        if (Array.isArray(arr)) {
          for (let i = arr.length - 1; i >= 0; i--) {
            const el = arr[i];
            if (el && el.role === 'assistant' && el.content) {
              return typeof el.content === 'string' ? el.content : extractContent(el.content);
            }
          }
        }
      } catch { /* fall through to raw string */ }
    }
    return contentVal;
  }
  return '';
}

function safeParse(str) {
  try { return JSON.parse(str); } catch { return {}; }
}

const labels = { 'copilot-jetbrains': 'GitHub Copilot - JetBrains' };

module.exports = { name, labels, getChats, getMessages };
