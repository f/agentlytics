const path = require('path');
const fs = require('fs');
const os = require('os');

const COPILOT_DIR = path.join(os.homedir(), '.copilot');
const SESSION_STATE_DIR = path.join(COPILOT_DIR, 'session-state');

// ============================================================
// Adapter interface
// ============================================================

const name = 'copilot-cli';

/**
 * Parse workspace.yaml from a session directory.
 * Fields: id, cwd, git_root, repository, branch, summary, created_at, updated_at
 */
function parseWorkspace(sessionDir) {
  const yamlPath = path.join(sessionDir, 'workspace.yaml');
  if (!fs.existsSync(yamlPath)) return null;
  try {
    const raw = fs.readFileSync(yamlPath, 'utf-8');
    // Simple YAML parsing — handle key: value lines
    const meta = {};
    for (const line of raw.split('\n')) {
      const match = line.match(/^(\w+):\s*(.*)$/);
      if (match) meta[match[1]] = match[2].trim();
    }
    return meta;
  } catch { return null; }
}

/**
 * Parse events.jsonl and extract user/assistant messages.
 * Event types: session.start, user.message, assistant.message,
 *   assistant.turn_start, assistant.turn_end, session.shutdown
 */
function parseEvents(sessionDir) {
  const eventsPath = path.join(sessionDir, 'events.jsonl');
  if (!fs.existsSync(eventsPath)) return [];
  try {
    const raw = fs.readFileSync(eventsPath, 'utf-8');
    return raw.split('\n').filter(Boolean).map(line => {
      try { return JSON.parse(line); } catch { return null; }
    }).filter(Boolean);
  } catch { return []; }
}

function getChats() {
  const chats = [];
  if (!fs.existsSync(SESSION_STATE_DIR)) return chats;

  let sessionDirs;
  try { sessionDirs = fs.readdirSync(SESSION_STATE_DIR); } catch { return chats; }

  for (const dirName of sessionDirs) {
    const sessionDir = path.join(SESSION_STATE_DIR, dirName);
    try { if (!fs.statSync(sessionDir).isDirectory()) continue; } catch { continue; }

    const meta = parseWorkspace(sessionDir);
    if (!meta) continue;

    const events = parseEvents(sessionDir);
    const userMessages = events.filter(e => e.type === 'user.message');
    const assistantMessages = events.filter(e => e.type === 'assistant.message');
    const firstUser = userMessages[0];

    // Count meaningful messages (user + assistant)
    const bubbleCount = userMessages.length + assistantMessages.length;
    if (bubbleCount === 0) continue;

    // Extract model from shutdown event or assistant messages
    const shutdown = events.find(e => e.type === 'session.shutdown');
    const model = shutdown?.data?.currentModel || null;

    chats.push({
      source: 'copilot-cli',
      composerId: meta.id || dirName,
      name: meta.summary || cleanPrompt(firstUser?.data?.content),
      createdAt: meta.created_at ? new Date(meta.created_at).getTime() : null,
      lastUpdatedAt: meta.updated_at ? new Date(meta.updated_at).getTime() : null,
      mode: 'copilot',
      folder: meta.cwd || meta.git_root || null,
      encrypted: false,
      bubbleCount,
      _sessionDir: sessionDir,
      _model: model,
      _shutdownData: shutdown?.data || null,
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

  // Aggregate token usage from shutdown event's modelMetrics
  const shutdown = events.find(e => e.type === 'session.shutdown');
  const modelMetrics = shutdown?.data?.modelMetrics || {};

  // Build total token counts from model metrics
  let totalInput = 0, totalOutput = 0, totalCacheRead = 0;
  for (const metrics of Object.values(modelMetrics)) {
    const u = metrics.usage || {};
    totalInput += u.inputTokens || 0;
    totalOutput += u.outputTokens || 0;
    totalCacheRead += u.cacheReadTokens || 0;
  }

  for (const event of events) {
    if (event.type === 'user.message') {
      const content = event.data?.content;
      if (content) result.push({ role: 'user', content });

    } else if (event.type === 'assistant.message') {
      const data = event.data || {};
      const parts = [];
      const toolCalls = [];

      // Main text content
      if (data.content) parts.push(data.content);

      // Tool requests
      if (data.toolRequests && Array.isArray(data.toolRequests)) {
        for (const tr of data.toolRequests) {
          const tcName = tr.name || tr.toolName || 'unknown';
          const args = tr.args || tr.arguments || tr.input || {};
          const parsedArgs = typeof args === 'string' ? safeParse(args) : args;
          const argKeys = typeof parsedArgs === 'object' ? Object.keys(parsedArgs).join(', ') : '';
          parts.push(`[tool-call: ${tcName}(${argKeys})]`);
          toolCalls.push({ name: tcName, args: parsedArgs });
        }
      }

      if (parts.length > 0) {
        result.push({
          role: 'assistant',
          content: parts.join('\n'),
          _model: shutdown?.data?.currentModel || chat._model,
          _outputTokens: data.outputTokens,
          _toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
        });
      }
    }
  }

  // Attach aggregate token info to the first assistant message if available
  if (result.length > 0 && totalInput > 0) {
    const firstAssistant = result.find(m => m.role === 'assistant');
    if (firstAssistant) {
      firstAssistant._inputTokens = totalInput;
      if (!firstAssistant._outputTokens) firstAssistant._outputTokens = totalOutput;
      if (totalCacheRead) firstAssistant._cacheRead = totalCacheRead;
    }
  }

  return result;
}

function safeParse(str) {
  try { return JSON.parse(str); } catch { return {}; }
}

const labels = { 'copilot-cli': 'Copilot CLI' };

module.exports = { name, labels, getChats, getMessages };
