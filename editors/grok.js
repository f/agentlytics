const path = require('path');
const fs = require('fs');
const os = require('os');

// ============================================================
// Grok (xAI Grok CLI / Grok Build) adapter
// ------------------------------------------------------------
// Reads local session data from $GROK_HOME (default ~/.grok):
//
//   ~/.grok/sessions/<url-encoded-cwd>/<session-id>/
//     ├── summary.json          // title, cwd, timestamps, model
//     ├── chat_history.jsonl    // system/user/assistant/tool/reasoning
//     ├── updates.jsonl         // turn_completed usage + tool stream
//     ├── signals.json          // aggregate stats (optional)
//     └── events.jsonl          // tool lifecycle (optional)
//
// Token usage is taken from turn_completed entries in updates.jsonl
// (inputTokens, outputTokens, cachedReadTokens, cacheCreationTokens)
// and attached to the last assistant message of each user turn.
// ============================================================

const name = 'grok';
const labels = { grok: 'Grok' };

const DEFAULT_GROK_HOME = path.join(os.homedir(), '.grok');
const SESSION_SUBDIR = 'sessions';
const MAX_TOOL_RESULT_PREVIEW = 500;

function getGrokHome() {
  const env = process.env.GROK_HOME && process.env.GROK_HOME.trim();
  return env ? path.resolve(env) : DEFAULT_GROK_HOME;
}

function getSessionsDir() {
  return path.join(getGrokHome(), SESSION_SUBDIR);
}

// ============================================================
// Adapter interface
// ============================================================

function getChats() {
  const sessionsDir = getSessionsDir();
  if (!fs.existsSync(sessionsDir)) return [];

  const chats = [];
  for (const sessionDir of walkSessionDirs(sessionsDir)) {
    const chat = readChatMetadata(sessionDir);
    if (chat) chats.push(chat);
  }
  return chats;
}

function getMessages(chat) {
  const sessionDir = chat && chat._filePath;
  if (!sessionDir || !fs.existsSync(sessionDir)) return [];
  return parseSessionMessages(sessionDir, chat);
}

// ============================================================
// Session discovery
// ============================================================

function walkSessionDirs(root) {
  const results = [];
  const stack = [root];

  while (stack.length > 0) {
    const current = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      // Skip non-session helpers at the root (e.g. nothing nested as a file)
      if (entry.name === 'session_search.sqlite' || entry.name.startsWith('.')) continue;

      const fullPath = path.join(current, entry.name);
      // A session dir has summary.json and/or chat_history.jsonl
      if (isSessionDir(fullPath)) {
        results.push(fullPath);
      } else {
        stack.push(fullPath);
      }
    }
  }

  return results;
}

function isSessionDir(dir) {
  return (
    fs.existsSync(path.join(dir, 'summary.json')) ||
    fs.existsSync(path.join(dir, 'chat_history.jsonl'))
  );
}

function readChatMetadata(sessionDir) {
  const summary = safeReadJson(path.join(sessionDir, 'summary.json')) || {};
  const info = summary.info || {};
  const sessionId = info.id || path.basename(sessionDir);

  // Prefer summary fields; fall back to file mtimes and history peek
  let createdAt = toTimestamp(summary.created_at);
  let lastUpdatedAt =
    toTimestamp(summary.last_active_at) ||
    toTimestamp(summary.updated_at);

  let folder = info.cwd || null;
  let title =
    summary.generated_title ||
    summary.session_summary ||
    null;
  let bubbleCount = summary.num_chat_messages || summary.num_messages || 0;
  let model = summary.current_model_id || null;
  let mode = summary.agent_name || 'grok';

  // Decode parent folder name as cwd if summary lacks it
  if (!folder) {
    folder = decodeSessionParentPath(sessionDir);
  }

  // Stat fallbacks
  try {
    const histPath = path.join(sessionDir, 'chat_history.jsonl');
    if (fs.existsSync(histPath)) {
      const stat = fs.statSync(histPath);
      if (!createdAt) createdAt = Math.round(stat.birthtimeMs || stat.ctimeMs);
      if (!lastUpdatedAt) lastUpdatedAt = Math.round(stat.mtimeMs);
      if (!bubbleCount) {
        // Cheap line count estimate
        const raw = fs.readFileSync(histPath, 'utf-8');
        bubbleCount = raw ? raw.split('\n').filter(Boolean).length : 0;
      }
    } else {
      const stat = fs.statSync(sessionDir);
      if (!createdAt) createdAt = Math.round(stat.birthtimeMs || stat.ctimeMs);
      if (!lastUpdatedAt) lastUpdatedAt = Math.round(stat.mtimeMs);
    }
  } catch { /* ignore */ }

  // First real user prompt as title if summary has none
  if (!title) {
    title = peekFirstUserPrompt(path.join(sessionDir, 'chat_history.jsonl'));
  }

  return {
    source: 'grok',
    composerId: sessionId,
    name: cleanPrompt(title),
    createdAt: createdAt || null,
    lastUpdatedAt: lastUpdatedAt || null,
    mode,
    folder,
    encrypted: false,
    bubbleCount: bubbleCount || 0,
    // Persisted by cache.js for re-analysis
    _filePath: sessionDir,
    _model: model,
    _agentName: summary.agent_name || null,
    _reasoningEffort: summary.reasoning_effort || null,
  };
}

function decodeSessionParentPath(sessionDir) {
  try {
    const parent = path.basename(path.dirname(sessionDir));
    // Grok encodes cwd as URL-encoded path segments joined with nothing special,
    // e.g. %2FUsers%2Fdesai%2Fprojects%2Ffoo
    if (parent.includes('%')) {
      return decodeURIComponent(parent);
    }
  } catch { /* ignore */ }
  return null;
}

function peekFirstUserPrompt(histPath) {
  if (!histPath || !fs.existsSync(histPath)) return null;
  try {
    const lines = fs.readFileSync(histPath, 'utf-8').split('\n');
    for (const line of lines) {
      if (!line) continue;
      const obj = safeParseJson(line);
      if (!obj || obj.type !== 'user') continue;
      if (obj.synthetic_reason) continue;
      const text = extractUserText(obj.content);
      if (!text) continue;
      if (isBootstrapUserText(text)) continue;
      return cleanPrompt(text);
    }
  } catch { /* ignore */ }
  return null;
}

// ============================================================
// Message parsing
// ============================================================

function parseSessionMessages(sessionDir, chat) {
  const histPath = path.join(sessionDir, 'chat_history.jsonl');
  if (!fs.existsSync(histPath)) return [];

  const turnUsages = loadTurnUsages(path.join(sessionDir, 'updates.jsonl'));
  const lines = readLines(histPath);
  const messages = [];

  // Track assistant messages within the current user turn so we can
  // attach turn_completed usage to the last assistant of each turn.
  let turnAssistants = [];
  let turnUsageIdx = 0;
  let defaultModel = (chat && chat._model) || null;

  function flushTurnUsage() {
    if (turnAssistants.length === 0) return;
    const usage = turnUsages[turnUsageIdx];
    if (usage) {
      const last = turnAssistants[turnAssistants.length - 1];
      last._inputTokens = usage.inputTokens || undefined;
      last._outputTokens = usage.outputTokens || undefined;
      last._cacheRead = usage.cachedReadTokens || undefined;
      last._cacheWrite = usage.cacheCreationTokens || undefined;
      if (usage.model && !last._model) last._model = usage.model;
      // Prefer model from usage when present
      if (usage.model) last._model = usage.model;
    }
    turnUsageIdx++;
    turnAssistants = [];
  }

  for (const line of lines) {
    const obj = safeParseJson(line);
    if (!obj || !obj.type) continue;

    if (obj.type === 'system') {
      // System prompts are large and not useful in the session transcript UI
      continue;
    }

    if (obj.type === 'user') {
      if (obj.synthetic_reason) continue;
      const text = extractUserText(obj.content);
      if (!text || isBootstrapUserText(text)) continue;

      // New real user turn → assign usage to previous turn's assistants
      if (turnAssistants.length > 0) flushTurnUsage();

      messages.push({
        role: 'user',
        content: text,
      });
      continue;
    }

    if (obj.type === 'assistant') {
      const model = obj.model_id || defaultModel || null;
      if (model) defaultModel = model;

      const parts = [];
      const toolCalls = [];

      if (obj.content) {
        if (typeof obj.content === 'string' && obj.content.trim()) {
          parts.push(obj.content);
        } else if (Array.isArray(obj.content)) {
          for (const block of obj.content) {
            if (!block) continue;
            if (typeof block === 'string') {
              if (block.trim()) parts.push(block);
            } else if (block.type === 'text' && block.text) {
              parts.push(block.text);
            }
          }
        }
      }

      if (Array.isArray(obj.tool_calls)) {
        for (const tc of obj.tool_calls) {
          const toolName = tc.name || 'tool';
          const args = parseToolArgs(tc.arguments);
          const argKeys = Object.keys(args).join(', ');
          parts.push(`[tool-call: ${toolName}(${argKeys})]`);
          toolCalls.push({ name: toolName, args });
        }
      }

      const content = parts.join('\n').trim();
      // Keep empty assistant messages that only carried tools
      if (!content && toolCalls.length === 0) continue;

      const msg = {
        role: 'assistant',
        content: content || '',
        _model: model || undefined,
        _toolCalls: toolCalls.length ? toolCalls : undefined,
      };
      messages.push(msg);
      turnAssistants.push(msg);
      continue;
    }

    if (obj.type === 'tool_result') {
      const text = typeof obj.content === 'string'
        ? obj.content
        : (Array.isArray(obj.content)
          ? obj.content.map(c => (typeof c === 'string' ? c : c?.text || '')).join('\n')
          : JSON.stringify(obj.content || ''));
      const preview = (text || '').substring(0, MAX_TOOL_RESULT_PREVIEW);
      messages.push({
        role: 'tool',
        content: `[tool-result] ${preview}`,
      });
      continue;
    }

    if (obj.type === 'reasoning') {
      const summaryText = extractReasoningSummary(obj);
      if (summaryText) {
        // Render as assistant thinking so it shows in the transcript
        const msg = {
          role: 'assistant',
          content: `[thinking] ${summaryText}`,
          _model: defaultModel || undefined,
        };
        messages.push(msg);
        turnAssistants.push(msg);
      }
      continue;
    }

    if (obj.type === 'backend_tool_call') {
      const toolName = extractBackendToolName(obj);
      const args = extractBackendToolArgs(obj);
      const argKeys = Object.keys(args).join(', ');
      const msg = {
        role: 'assistant',
        content: `[tool-call: ${toolName}(${argKeys})]`,
        _model: defaultModel || undefined,
        _toolCalls: [{ name: toolName, args }],
      };
      messages.push(msg);
      turnAssistants.push(msg);
      continue;
    }
  }

  // Final turn
  flushTurnUsage();

  return messages;
}

function loadTurnUsages(updatesPath) {
  if (!updatesPath || !fs.existsSync(updatesPath)) return [];
  const usages = [];
  try {
    const lines = readLines(updatesPath);
    for (const line of lines) {
      const obj = safeParseJson(line);
      if (!obj) continue;
      const update = obj.params && obj.params.update;
      if (!update || update.sessionUpdate !== 'turn_completed') continue;
      const usage = update.usage;
      if (!usage) continue;

      const modelUsage = usage.modelUsage || {};
      const models = Object.keys(modelUsage);
      // Prefer the model with the most input tokens when multi-model
      let model = models[0] || null;
      if (models.length > 1) {
        model = models.sort((a, b) =>
          (modelUsage[b].inputTokens || 0) - (modelUsage[a].inputTokens || 0)
        )[0];
      }

      usages.push({
        promptId: update.prompt_id || null,
        stopReason: update.stop_reason || null,
        inputTokens: usage.inputTokens || 0,
        outputTokens: usage.outputTokens || 0,
        cachedReadTokens: usage.cachedReadTokens || 0,
        cacheCreationTokens: usage.cacheCreationTokens || 0,
        reasoningTokens: usage.reasoningTokens || 0,
        model,
      });
    }
  } catch { /* ignore corrupt updates */ }
  return usages;
}

// ============================================================
// Content helpers
// ============================================================

// Injected context blocks Grok prepends to the conversation — not real user prompts.
const CONTEXT_ENVELOPE_TAGS = [
  'user_info',
  'system-reminder',
  'agent_transcripts',
  'open_and_recently_viewed_files',
  'mcp_file_system',
  'git_status',
  'environment_details',
  'attached_files',
  'always_applied_workspace_rules',
  'rules',
  'agent_skills',
  'mcp_servers',
  'system_reminder',
];

const CONTEXT_ENVELOPE_RE = new RegExp(
  `<(${CONTEXT_ENVELOPE_TAGS.join('|')})>[\\s\\S]*?<\\/\\1>`,
  'gi'
);

function extractUserText(content) {
  const raw = flattenContent(content);
  if (!raw) return '';

  // Prefer <user_query> ... </user_query> when present
  const queryMatch = raw.match(/<user_query>\s*([\s\S]*?)\s*<\/user_query>/i);
  if (queryMatch) return queryMatch[1].trim();

  // Strip common injected envelopes so leftover real text remains
  return raw.replace(CONTEXT_ENVELOPE_RE, '').trim();
}

function isBootstrapUserText(text) {
  if (!text) return true;
  const t = text.trim();
  if (!t) return true;

  // Explicit user queries are never bootstrap
  if (/<user_query>/i.test(t)) return false;

  // Pure injected context envelopes
  for (const tag of CONTEXT_ENVELOPE_TAGS) {
    const pure = new RegExp(`^<${tag}>[\\s\\S]*<\\/${tag}>\\s*$`, 'i');
    if (pure.test(t)) return true;
    // Unclosed envelope-only blobs
    if (new RegExp(`^<${tag}>`, 'i').test(t) && !new RegExp(`<\\/${tag}>`, 'i').test(t)) {
      return true;
    }
  }

  // After stripping, if extractUserText would leave nothing meaningful, skip
  const stripped = t.replace(CONTEXT_ENVELOPE_RE, '').trim();
  if (!stripped) return true;

  // Leftover that is still only XML-ish tags
  if (/^<[^>]+>[\s\S]*<\/[^>]+>$/.test(stripped)) {
    const withoutTags = stripped.replace(/<[^>]+>/g, '').trim();
    if (!withoutTags || withoutTags.length < 8) return true;
  }

  return false;
}

function flattenContent(content) {
  if (!content) return '';
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) {
    if (content.text) return String(content.text);
    return '';
  }
  return content
    .map((part) => {
      if (!part) return '';
      if (typeof part === 'string') return part;
      if (part.type === 'text' && part.text) return part.text;
      if (part.text) return part.text;
      return '';
    })
    .filter(Boolean)
    .join('\n');
}

function extractReasoningSummary(obj) {
  if (!obj) return '';
  if (typeof obj.summary === 'string') return obj.summary.trim();
  if (Array.isArray(obj.summary)) {
    return obj.summary
      .map((s) => {
        if (!s) return '';
        if (typeof s === 'string') return s;
        if (s.type === 'summary_text' && s.text) return s.text;
        if (s.text) return s.text;
        return '';
      })
      .filter(Boolean)
      .join('\n')
      .trim();
  }
  return '';
}

function extractBackendToolName(obj) {
  const kind = obj && obj.kind;
  if (!kind) return 'backend_tool';
  if (typeof kind === 'string') return kind;
  if (kind.tool_type) return kind.tool_type;
  if (kind.type) return kind.type;
  return 'backend_tool';
}

function extractBackendToolArgs(obj) {
  const kind = obj && obj.kind;
  if (!kind || typeof kind !== 'object') return {};
  const action = kind.action;
  if (!action || typeof action !== 'object') return {};
  // Common shapes: { type: 'search', query: '...' }
  const args = {};
  for (const [k, v] of Object.entries(action)) {
    if (k === 'type' || k === 'sources') continue;
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
      args[k] = v;
    }
  }
  if (action.type) args.action = action.type;
  return args;
}

function parseToolArgs(raw) {
  if (!raw) return {};
  if (typeof raw === 'object' && !Array.isArray(raw)) return raw;
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    } catch { /* keep raw as command-ish */ }
    return { raw };
  }
  return {};
}

function cleanPrompt(text) {
  if (!text) return null;
  let clean = String(text)
    .replace(/<user_query>\s*([\s\S]*?)\s*<\/user_query>/gi, '$1')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .substring(0, 120);
  return clean || null;
}

// ============================================================
// Artifacts & MCP
// ============================================================

function getArtifacts(folder) {
  const { scanArtifacts } = require('./base');
  return scanArtifacts(folder, {
    editor: 'grok',
    label: 'Grok',
    files: [
      'AGENTS.md',
      'Agents.md',
      'AGENT.md',
      'CLAUDE.md',
      'Claude.md',
      '.grok/config.toml',
    ],
    dirs: ['.grok/rules', '.grok/skills', '.grok/workflows'],
  });
}

function getMCPServers() {
  const results = [];
  const configPath = path.join(getGrokHome(), 'config.toml');
  results.push(...parseGrokMcpToml(configPath, {
    editor: 'grok',
    label: 'Grok',
    scope: 'global',
  }));
  return results;
}

/**
 * Minimal TOML parser for [mcp_servers.<name>] tables.
 * Avoids adding a TOML dependency just for MCP discovery.
 */
function parseGrokMcpToml(filePath, { editor, label, scope }) {
  if (!filePath || !fs.existsSync(filePath)) return [];
  let text;
  try {
    text = fs.readFileSync(filePath, 'utf-8');
  } catch {
    return [];
  }

  const servers = [];
  // Match [mcp_servers.name] or [mcp_servers."name"]
  const sectionRe = /^\[mcp_servers\.([^\]]+)\]\s*$/gm;
  const matches = [];
  let m;
  while ((m = sectionRe.exec(text)) !== null) {
    matches.push({ name: m[1].replace(/^["']|["']$/g, ''), index: m.index, headerLen: m[0].length });
  }

  for (let i = 0; i < matches.length; i++) {
    const start = matches[i].index + matches[i].headerLen;
    const end = i + 1 < matches.length ? matches[i + 1].index : text.length;
    // Also stop at any other top-level [section]
    let body = text.slice(start, end);
    const nextSection = body.search(/\n\[/);
    if (nextSection !== -1) body = body.slice(0, nextSection);

    const cfg = parseSimpleTomlBody(body);
    const serverName = matches[i].name;
    servers.push({
      name: serverName,
      editor,
      editorLabel: label,
      scope,
      configPath: filePath,
      command: cfg.command || null,
      args: cfg.args || [],
      _env: cfg.env || {},
      env: cfg.env ? Object.keys(cfg.env) : [],
      url: cfg.url || null,
      transport: cfg.url ? (cfg.transport || 'http') : (cfg.transport || 'stdio'),
      disabled: cfg.enabled === false || cfg.disabled === true,
      disabledTools: [],
    });
  }

  return servers;
}

function parseSimpleTomlBody(body) {
  const cfg = {};
  const lines = body.split('\n');
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#') || line.startsWith('[')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();

    // Strip trailing comments for simple values
    if (value.startsWith('"') || value.startsWith("'")) {
      // string
      const quote = value[0];
      const end = value.indexOf(quote, 1);
      if (end !== -1) value = value.slice(1, end);
      else value = value.slice(1);
      cfg[key] = value;
    } else if (value.startsWith('[')) {
      // array of strings/numbers
      try {
        // Convert single quotes to double for JSON
        const jsonish = value.replace(/'/g, '"');
        cfg[key] = JSON.parse(jsonish);
      } catch {
        cfg[key] = [];
      }
    } else if (value.startsWith('{')) {
      // inline table { KEY = "val" }
      const env = {};
      const re = /([A-Za-z0-9_]+)\s*=\s*"([^"]*)"/g;
      let em;
      while ((em = re.exec(value)) !== null) env[em[1]] = em[2];
      cfg[key] = env;
    } else if (value === 'true' || value === 'false') {
      cfg[key] = value === 'true';
    } else if (/^-?\d+(\.\d+)?$/.test(value.split('#')[0].trim())) {
      cfg[key] = Number(value.split('#')[0].trim());
    } else {
      cfg[key] = value.split('#')[0].trim();
    }
  }
  return cfg;
}

// ============================================================
// Utils
// ============================================================

function safeReadJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch {
    return null;
  }
}

function safeParseJson(line) {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

function readLines(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf-8').split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

function toTimestamp(value) {
  if (value == null) return null;
  if (typeof value === 'number' && Number.isFinite(value)) {
    // Heuristic: seconds vs ms
    return value < 1e12 ? Math.round(value * 1000) : Math.round(value);
  }
  if (typeof value === 'string') {
    const ms = Date.parse(value);
    return Number.isFinite(ms) ? ms : null;
  }
  return null;
}

module.exports = {
  name,
  labels,
  getChats,
  getMessages,
  getArtifacts,
  getMCPServers,
};
