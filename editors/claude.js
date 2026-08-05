const path = require('path');
const fs = require('fs');
const os = require('os');

function discoverClaudeDirs() {
  const home = os.homedir();
  const seen = new Set();
  const dirs = [];

  function addDir(d) {
    let real;
    try { real = fs.realpathSync(d); } catch { return; }
    if (seen.has(real)) return;
    seen.add(real);
    dirs.push(d);
  }

  addDir(path.join(home, '.claude'));

  let entries;
  try { entries = fs.readdirSync(home); } catch { entries = []; }
  for (const entry of entries) {
    if (!entry.startsWith('.')) continue;
    const full = path.join(home, entry);
    try {
      if (!fs.statSync(full).isDirectory()) continue;
      const hasProjects = fs.existsSync(path.join(full, 'projects')) && fs.statSync(path.join(full, 'projects')).isDirectory();
      const hasHistory = fs.existsSync(path.join(full, 'history.jsonl'));
      if (hasProjects && hasHistory) addDir(full);
    } catch { /* skip */ }
  }

  const envDir = process.env.CLAUDE_CONFIG_DIR;
  if (envDir) {
    try {
      if (fs.existsSync(envDir) && fs.statSync(envDir).isDirectory()) addDir(envDir);
    } catch { /* skip */ }
  }

  return dirs;
}

// ============================================================
// Adapter interface
// ============================================================

const name = 'claude';

function getChats() {
  const chats = [];
  const seenIds = new Set();

  for (const claudeDir of discoverClaudeDirs()) {
    const projectsDir = path.join(claudeDir, 'projects');
    if (!fs.existsSync(projectsDir)) continue;

    for (const projDir of fs.readdirSync(projectsDir)) {
      const dir = path.join(projectsDir, projDir);
      if (!fs.statSync(dir).isDirectory()) continue;

      // Decode folder path from dir name (e.g. -Users-fka-Code-foo -> /Users/fka/Code/foo)
      const decodedFolder = projDir.replace(/-/g, '/');

      // Read sessions-index.json for indexed sessions
      const indexPath = path.join(dir, 'sessions-index.json');
      const indexed = new Map();
      try {
        const index = JSON.parse(fs.readFileSync(indexPath, 'utf-8'));
        for (const entry of index.entries || []) {
          indexed.set(entry.sessionId, entry);
        }
      } catch { /* no index */ }

      // Scan all .jsonl files on disk (some may not be in the index)
      let files;
      try { files = fs.readdirSync(dir).filter(f => f.endsWith('.jsonl')); } catch { continue; }

      for (const file of files) {
        const sessionId = file.replace('.jsonl', '');
        if (seenIds.has(sessionId)) { indexed.delete(sessionId); continue; }
        const fullPath = path.join(dir, file);
        const entry = indexed.get(sessionId);

        if (entry) {
          // Use index metadata
          seenIds.add(sessionId);
          chats.push({
            source: 'claude-code',
            composerId: sessionId,
            name: cleanPrompt(entry.firstPrompt),
            createdAt: entry.created ? new Date(entry.created).getTime() : null,
            lastUpdatedAt: entry.modified ? new Date(entry.modified).getTime() : null,
            mode: 'claude',
            folder: entry.projectPath || decodedFolder,
            encrypted: false,
            bubbleCount: entry.messageCount || 0,
            _fullPath: fullPath,
            _gitBranch: entry.gitBranch,
          });
        } else {
          // Orphan .jsonl — extract metadata from file content
          try {
            const stat = fs.statSync(fullPath);
            const meta = peekSessionMeta(fullPath);
            seenIds.add(sessionId);
            chats.push({
              source: 'claude-code',
              composerId: sessionId,
              name: meta.firstPrompt ? cleanPrompt(meta.firstPrompt) : null,
              createdAt: meta.timestamp || stat.birthtime.getTime(),
              lastUpdatedAt: stat.mtime.getTime(),
              mode: 'claude',
              folder: meta.cwd || decodedFolder,
              encrypted: false,
              _fullPath: fullPath,
            });
          } catch { /* skip */ }
        }

        // Remove from indexed so we know what's left
        indexed.delete(sessionId);
      }

      // Add indexed sessions whose .jsonl files no longer exist (show as unavailable)
      for (const [sessionId, entry] of indexed) {
        if (seenIds.has(sessionId)) continue;
        if (!entry.fullPath || !fs.existsSync(entry.fullPath)) continue;
        seenIds.add(sessionId);
        chats.push({
          source: 'claude-code',
          composerId: sessionId,
          name: cleanPrompt(entry.firstPrompt),
          createdAt: entry.created ? new Date(entry.created).getTime() : null,
          lastUpdatedAt: entry.modified ? new Date(entry.modified).getTime() : null,
          mode: 'claude',
          folder: entry.projectPath || decodedFolder,
          encrypted: false,
          bubbleCount: entry.messageCount || 0,
          _fullPath: entry.fullPath,
        });
      }
    }
  }

  return chats;
}

function peekSessionMeta(filePath) {
  const meta = { firstPrompt: null, cwd: null, timestamp: null };
  try {
    const buf = fs.readFileSync(filePath, 'utf-8');
    for (const line of buf.split('\n')) {
      if (!line) continue;
      const obj = JSON.parse(line);
      if (!meta.cwd && obj.cwd) meta.cwd = obj.cwd;
      if (!meta.timestamp && obj.timestamp) {
        meta.timestamp = typeof obj.timestamp === 'string'
          ? new Date(obj.timestamp).getTime() : obj.timestamp;
      }
      if (!meta.firstPrompt && obj.type === 'user' && obj.message?.content) {
        const text = typeof obj.message.content === 'string'
          ? obj.message.content
          : obj.message.content.filter(c => c.type === 'text').map(c => c.text).join(' ');
        meta.firstPrompt = text.substring(0, 200);
      }
      if (meta.cwd && meta.firstPrompt) break;
    }
  } catch {}
  return meta;
}

function cleanPrompt(prompt) {
  if (!prompt || prompt === 'No prompt') return null;
  // Strip XML tags and system-reminder blocks
  let clean = prompt
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .substring(0, 120);
  return clean || null;
}

function getMessages(chat) {
  const filePath = chat._fullPath;
  if (!filePath || !fs.existsSync(filePath)) return [];

  const messages = [];
  const lines = fs.readFileSync(filePath, 'utf-8').split('\n').filter(Boolean);

  for (const line of lines) {
    let obj;
    try { obj = JSON.parse(line); } catch { continue; }

    if (obj.type === 'user' && obj.message) {
      const content = extractContent(obj.message.content);
      if (content) messages.push({ role: 'user', content });
    } else if (obj.type === 'assistant' && obj.message) {
      const { text, toolCalls } = extractAssistantContent(obj.message.content);
      const usage = obj.message.usage;
      if (text) messages.push({
        role: 'assistant', content: text, _model: obj.message.model,
        _inputTokens: usage?.input_tokens, _outputTokens: usage?.output_tokens,
        _cacheRead: usage?.cache_read_input_tokens, _cacheWrite: usage?.cache_creation_input_tokens,
        _toolCalls: toolCalls,
      });
    } else if (obj.type === 'system') {
      const text = typeof obj.message?.content === 'string' ? obj.message.content : '';
      if (text) messages.push({ role: 'system', content: text });
    }
  }

  return messages;
}

function extractContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
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

// ============================================================
// Usage / quota data from Anthropic OAuth API
// ============================================================

function getClaudeCredentials() {
  // macOS: Keychain; Linux: secret-tool; Windows: not yet supported
  // Requires explicit user permission (allowSubscriptionAccess in config)
  const { isSubscriptionAccessAllowed } = require('./base');
  if (!isSubscriptionAccessAllowed()) return null;
  try {
    const { execSync } = require('child_process');
    let raw;
    if (process.platform === 'darwin') {
      raw = execSync('security find-generic-password -s "Claude Code-credentials" -w', { encoding: 'utf-8', timeout: 5000 }).trim();
    } else if (process.platform === 'linux') {
      raw = execSync('secret-tool lookup service "Claude Code-credentials"', { encoding: 'utf-8', timeout: 5000 }).trim();
    } else {
      return null;
    }
    const creds = JSON.parse(raw);
    const oauth = creds.claudeAiOauth;
    if (!oauth || !oauth.accessToken) return null;
    return oauth;
  } catch { return null; }
}

function claudeApiFetch(token) {
  return new Promise((resolve) => {
    const https = require('https');
    const req = https.get('https://api.anthropic.com/api/oauth/usage', {
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json',
        'User-Agent': 'agentlytics/1.0',
        'Authorization': `Bearer ${token}`,
        'anthropic-beta': 'oauth-2025-04-20',
      },
      timeout: 10000,
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

async function getUsage() {
  const creds = getClaudeCredentials();
  if (!creds) return null;

  const usage = await claudeApiFetch(creds.accessToken);
  if (!usage) return null;

  const result = {
    source: 'claude-code',
    plan: {
      name: creds.subscriptionType || null,
    },
    usage: {},
    extraUsage: null,
  };

  if (usage.five_hour) {
    result.usage.fiveHour = {
      utilization: usage.five_hour.utilization,
      resetsAt: usage.five_hour.resets_at || null,
    };
  }
  if (usage.seven_day) {
    result.usage.sevenDay = {
      utilization: usage.seven_day.utilization,
      resetsAt: usage.seven_day.resets_at || null,
    };
  }
  if (usage.seven_day_sonnet) {
    result.usage.sevenDaySonnet = {
      utilization: usage.seven_day_sonnet.utilization,
      resetsAt: usage.seven_day_sonnet.resets_at || null,
    };
  }
  if (usage.seven_day_opus) {
    result.usage.sevenDayOpus = {
      utilization: usage.seven_day_opus.utilization,
      resetsAt: usage.seven_day_opus.resets_at || null,
    };
  }
  if (usage.extra_usage) {
    result.extraUsage = {
      isEnabled: usage.extra_usage.is_enabled || false,
      monthlyLimit: usage.extra_usage.monthly_limit || null,
      usedCredits: usage.extra_usage.used_credits || null,
      utilization: usage.extra_usage.utilization || null,
    };
  }

  return result;
}

const labels = { 'claude-code': 'Claude Code' };

function getArtifacts(folder) {
  const { scanArtifacts } = require('./base');
  return scanArtifacts(folder, {
    editor: 'claude-code',
    label: 'Claude Code',
    files: ['CLAUDE.md', '.claude/settings.json', '.claude/settings.local.json', '.mcp.json'],
    dirs: ['.claude/commands'],
  });
}

function getMCPServers() {
  const { parseMcpConfigFile } = require('./base');
  const results = [];
  const seenFiles = new Set();
  // Global: <configDir>.json sibling for each discovered claude dir (e.g. ~/.claude -> ~/.claude.json)
  for (const claudeDir of discoverClaudeDirs()) {
    const jsonFile = path.join(path.dirname(claudeDir), path.basename(claudeDir) + '.json');
    if (seenFiles.has(jsonFile)) continue;
    seenFiles.add(jsonFile);
    results.push(...parseMcpConfigFile(jsonFile, { editor: 'claude-code', label: 'Claude Code', scope: 'global' }));
  }
  // Project-level: .mcp.json (scanned per-project later via getAllMCPServers)
  return results;
}

module.exports = { name, labels, getChats, getMessages, getUsage, getArtifacts, getMCPServers };
