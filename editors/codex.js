const path = require('path');
const fs = require('fs');
const os = require('os');

const name = 'codex';
const DEFAULT_CODEX_HOME = path.join(os.homedir(), '.codex');
const SESSION_SUBDIR = 'sessions';
const MAX_TOOL_RESULT_PREVIEW = 500;

function getChats() {
  const sessionsDir = getSessionsDir();
  if (!fs.existsSync(sessionsDir)) return [];

  const chats = [];
  for (const filePath of walkJsonlFiles(sessionsDir)) {
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

function getSessionsDir() {
  const codexHome = process.env.CODEX_HOME && process.env.CODEX_HOME.trim()
    ? path.resolve(process.env.CODEX_HOME.trim())
    : DEFAULT_CODEX_HOME;
  return path.join(codexHome, SESSION_SUBDIR);
}

function walkJsonlFiles(dir) {
  const results = [];
  const stack = [dir];

  while (stack.length > 0) {
    const current = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
      } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        results.push(fullPath);
      }
    }
  }

  return results.sort();
}

function readChatMetadata(filePath) {
  const lines = readLines(filePath);
  if (lines.length === 0) return null;

  const first = safeParseJson(lines[0]);
  if (!first || first.type !== 'session_meta' || !first.payload) return null;

  let title = null;
  for (let i = 1; i < lines.length; i++) {
    const entry = safeParseJson(lines[i]);
    if (!entry || entry.type !== 'response_item' || !entry.payload) continue;
    const payload = entry.payload;
    if (payload.type !== 'message' || payload.role !== 'user') continue;
    const text = extractUserText(payload.content);
    if (!text || isBootstrapMessage(text)) continue;
    title = cleanPrompt(text);
    break;
  }

  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch {
    stat = null;
  }

  const payload = first.payload;
  return {
    source: 'codex',
    composerId: payload.id || path.basename(filePath, '.jsonl'),
    name: title,
    createdAt: toTimestamp(payload.timestamp) || (stat ? stat.birthtimeMs : null),
    lastUpdatedAt: stat ? stat.mtimeMs : null,
    mode: 'codex',
    folder: payload.cwd || null,
    encrypted: false,
    bubbleCount: 0,
    _filePath: filePath,
    _rawSource: payload.source || null,
    _originator: payload.originator || null,
    _cliVersion: payload.cli_version || null,
    _modelProvider: payload.model_provider || null,
  };
}

function parseSessionMessages(filePath) {
  const lines = readLines(filePath);
  const messages = [];

  let currentModel = null;
  let previousTotals = null;
  let currentTurn = createTurnState();
  let turnHasStarted = false;
  const toolNamesByCallId = new Map();

  function flushTurn() {
    const hasAssistantContent = currentTurn.parts.length > 0;
    const hasTokens = currentTurn.inputTokens > 0 || currentTurn.outputTokens > 0 || currentTurn.cacheRead > 0;
    const hasTools = currentTurn.toolCalls.length > 0;
    if (!hasAssistantContent && !hasTokens && !hasTools) {
      currentTurn = createTurnState();
      toolNamesByCallId.clear();
      return;
    }

    messages.push(composeAssistantMessage(currentTurn));
    currentTurn = createTurnState();
    toolNamesByCallId.clear();
  }

  for (const line of lines) {
    const entry = safeParseJson(line);
    if (!entry) continue;

    if (entry.type === 'turn_context') {
      if (turnHasStarted) flushTurn();
      turnHasStarted = true;
      const model = extractModel(entry.payload);
      if (model) {
        currentModel = model;
        currentTurn.model = model;
      }
      continue;
    }

    if (entry.type === 'response_item' && entry.payload) {
      const payload = entry.payload;

      if (payload.type === 'message') {
        if (payload.role === 'user') {
          const text = extractUserText(payload.content);
          if (!text || isBootstrapMessage(text)) continue;
          if (turnHasStarted) flushTurn();
          messages.push({ role: 'user', content: text });
        } else if (payload.role === 'assistant') {
          const text = extractAssistantText(payload.content);
          if (text) currentTurn.parts.push(text);
          if (!currentTurn.model && currentModel) currentTurn.model = currentModel;
        } else if (payload.role === 'system') {
          const text = extractAssistantText(payload.content);
          if (text) messages.push({ role: 'system', content: text });
        }
        continue;
      }

      if (payload.type === 'reasoning') {
        const summary = extractReasoningSummary(payload);
        if (summary) currentTurn.parts.push(summary);
        continue;
      }

      if (isToolCallPayload(payload.type)) {
        const toolCall = normalizeToolCall(payload);
        currentTurn.parts.push(toolCall.line);
        currentTurn.toolCalls.push({ name: toolCall.name, args: toolCall.args });
        if (payload.call_id) toolNamesByCallId.set(payload.call_id, toolCall.name);
        continue;
      }

      if (isToolOutputPayload(payload.type)) {
        const lineText = normalizeToolResult(payload, toolNamesByCallId.get(payload.call_id));
        if (lineText) currentTurn.parts.push(lineText);
        continue;
      }

      continue;
    }

    if (entry.type === 'event_msg' && entry.payload && entry.payload.type === 'token_count') {
      const tokenInfo = entry.payload.info || {};
      const lastUsage = normalizeRawUsage(tokenInfo.last_token_usage);
      const totalUsage = normalizeRawUsage(tokenInfo.total_token_usage);

      let rawUsage = lastUsage;
      if (!rawUsage && totalUsage) rawUsage = subtractRawUsage(totalUsage, previousTotals);
      if (totalUsage) previousTotals = totalUsage;
      if (!rawUsage) continue;

      const delta = convertToDelta(rawUsage);
      if (delta.inputTokens === 0 && delta.outputTokens === 0 && delta.cacheRead === 0) continue;

      currentTurn.inputTokens += delta.inputTokens;
      currentTurn.outputTokens += delta.outputTokens;
      currentTurn.cacheRead += delta.cacheRead;

      const model = extractModel(tokenInfo) || extractModel(entry.payload);
      if (model) {
        currentModel = model;
        currentTurn.model = model;
      } else if (!currentTurn.model && currentModel) {
        currentTurn.model = currentModel;
      }
    }
  }

  if (turnHasStarted) flushTurn();

  return messages;
}

function createTurnState() {
  return {
    parts: [],
    toolCalls: [],
    inputTokens: 0,
    outputTokens: 0,
    cacheRead: 0,
    model: null,
  };
}

function composeAssistantMessage(turn) {
  const content = turn.parts.join('\n') || '[assistant activity]';
  return {
    role: 'assistant',
    content,
    _model: turn.model || undefined,
    _inputTokens: turn.inputTokens || undefined,
    _outputTokens: turn.outputTokens || undefined,
    _cacheRead: turn.cacheRead || undefined,
    _toolCalls: turn.toolCalls.length > 0 ? turn.toolCalls : undefined,
  };
}

function extractUserText(content) {
  if (!Array.isArray(content)) return '';
  return content
    .filter((item) => item && item.type === 'input_text' && typeof item.text === 'string')
    .map((item) => item.text.trim())
    .filter(Boolean)
    .join('\n')
    .trim();
}

function extractAssistantText(content) {
  if (!Array.isArray(content)) return '';
  return content
    .filter((item) => item && item.type === 'output_text' && typeof item.text === 'string')
    .map((item) => item.text.trim())
    .filter(Boolean)
    .join('\n')
    .trim();
}

function extractReasoningSummary(payload) {
  if (!Array.isArray(payload.summary)) return '';
  return payload.summary
    .filter((item) => item && typeof item.text === 'string' && item.text.trim())
    .map((item) => `[thinking] ${item.text.trim()}`)
    .join('\n')
    .trim();
}

function isBootstrapMessage(text) {
  const trimmed = text.trim();
  return trimmed.startsWith('<user_instructions>') || trimmed.startsWith('<environment_context>');
}

function cleanPrompt(text) {
  return text.replace(/\s+/g, ' ').trim().substring(0, 120) || null;
}

function isToolCallPayload(type) {
  return type === 'function_call' || type === 'custom_tool_call' || type === 'web_search_call';
}

function isToolOutputPayload(type) {
  return type === 'function_call_output' || type === 'custom_tool_call_output';
}

function normalizeToolCall(payload) {
  const name = payload.name || (payload.type === 'web_search_call' ? 'web_search' : 'tool');
  const args = parseToolArgs(payload);
  const argKeys = Object.keys(args).join(', ');
  return {
    name,
    args,
    line: `[tool-call: ${name}(${argKeys})]`,
  };
}

function normalizeToolResult(payload, fallbackName) {
  const name = payload.name || fallbackName || 'tool';
  const preview = previewToolOutput(payload.output);
  return preview ? `[tool-result: ${name}] ${preview}` : `[tool-result: ${name}]`;
}

function parseToolArgs(payload) {
  if (payload.type === 'function_call') {
    return parseJsonRecord(payload.arguments);
  }
  if (payload.type === 'custom_tool_call') {
    return { input: truncateSingleLine(String(payload.input || ''), 300) };
  }
  if (payload.type === 'web_search_call') {
    return parseJsonRecord(payload.arguments || payload.input || payload.query);
  }
  return {};
}

function previewToolOutput(output) {
  if (output == null) return '';
  let value = output;
  if (typeof value === 'string') {
    const parsed = safeParseJson(value);
    if (parsed && typeof parsed === 'object' && typeof parsed.output === 'string') {
      value = parsed.output;
    } else {
      value = value;
    }
  } else if (typeof value === 'object') {
    value = JSON.stringify(value);
  } else {
    value = String(value);
  }

  const trimmed = String(value).trim();
  if (!trimmed) return '';
  return truncateSingleLine(trimmed, MAX_TOOL_RESULT_PREVIEW);
}

function truncateSingleLine(text, maxLen) {
  const oneLine = String(text).replace(/\s+/g, ' ').trim();
  return oneLine.length > maxLen ? oneLine.substring(0, maxLen) + '…' : oneLine;
}

function parseJsonRecord(value) {
  if (value == null) return {};
  if (typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value !== 'string') return {};
  const parsed = safeParseJson(value);
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
}

function normalizeRawUsage(value) {
  if (!value || typeof value !== 'object') return null;
  const input = ensureNumber(value.input_tokens);
  const cached = ensureNumber(value.cached_input_tokens != null ? value.cached_input_tokens : value.cache_read_input_tokens);
  const output = ensureNumber(value.output_tokens);
  const total = ensureNumber(value.total_tokens);
  return {
    input_tokens: input,
    cached_input_tokens: cached,
    output_tokens: output,
    total_tokens: total > 0 ? total : input + output,
  };
}

function subtractRawUsage(current, previous) {
  return {
    input_tokens: Math.max(current.input_tokens - (previous ? previous.input_tokens : 0), 0),
    cached_input_tokens: Math.max(current.cached_input_tokens - (previous ? previous.cached_input_tokens : 0), 0),
    output_tokens: Math.max(current.output_tokens - (previous ? previous.output_tokens : 0), 0),
    total_tokens: Math.max(current.total_tokens - (previous ? previous.total_tokens : 0), 0),
  };
}

function convertToDelta(raw) {
  return {
    inputTokens: raw.input_tokens,
    cacheRead: Math.min(raw.cached_input_tokens, raw.input_tokens),
    outputTokens: raw.output_tokens,
    totalTokens: raw.total_tokens > 0 ? raw.total_tokens : raw.input_tokens + raw.output_tokens,
  };
}

function extractModel(value) {
  if (!value || typeof value !== 'object') return null;

  const direct = asNonEmptyString(value.model)
    || asNonEmptyString(value.model_name);
  if (direct) return direct;

  if (value.info && typeof value.info === 'object') {
    const infoModel = extractModel(value.info);
    if (infoModel) return infoModel;
  }

  if (value.metadata && typeof value.metadata === 'object') {
    const metadataModel = extractModel(value.metadata);
    if (metadataModel) return metadataModel;
  }

  return null;
}

function asNonEmptyString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function ensureNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function toTimestamp(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string' || !value.trim()) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function readLines(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf-8').split(/\r?\n/).filter(Boolean);
  } catch {
    return [];
  }
}

function safeParseJson(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

module.exports = {
  name,
  getChats,
  getMessages,
};
