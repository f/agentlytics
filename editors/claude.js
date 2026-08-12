const path = require('path');
const fs = require('fs');
const os = require('os');

const CLAUDE_DIR = path.join(os.homedir(), '.claude');
const PROJECTS_DIR = path.join(CLAUDE_DIR, 'projects');

// ============================================================
// Adapter interface
// ============================================================

const name = 'claude';

function getChats() {
  const chats = [];
  if (!fs.existsSync(PROJECTS_DIR)) return chats;

  for (const projDir of fs.readdirSync(PROJECTS_DIR)) {
    const dir = path.join(PROJECTS_DIR, projDir);
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
      const fullPath = path.join(dir, file);
      const entry = indexed.get(sessionId);

      if (entry) {
        // Use index metadata
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
      if (!entry.fullPath || !fs.existsSync(entry.fullPath)) continue;
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
  // Global: ~/.claude.json (has mcpServers key)
  const globalFile = path.join(os.homedir(), '.claude.json');
  results.push(...parseMcpConfigFile(globalFile, { editor: 'claude-code', label: 'Claude Code', scope: 'global' }));
  // Project-level: .mcp.json (scanned per-project later via getAllMCPServers)
  return results;
}

// ============================================================
// Config surface scanning (for suggestions analyzer)
// ============================================================

const HOME = os.homedir();

function parseFrontmatter(raw) {
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return { frontmatter: {}, body: raw };
  const fm = {};
  const lines = m[1].split(/\r?\n/);
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const kv = line.match(/^\s*([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.*)$/);
    if (!kv) { i++; continue; }
    const key = kv[1];
    let v = kv[2].trim();
    if (/^[>|][-+]?\s*$/.test(v)) {
      const folded = v.startsWith('>');
      const keyIndent = line.match(/^(\s*)/)[1].length;
      const parts = []; i++;
      while (i < lines.length) {
        const l = lines[i];
        if (l.trim() === '') { parts.push(''); i++; continue; }
        const indent = l.match(/^(\s*)/)[1].length;
        if (indent <= keyIndent) break;
        parts.push(l.slice(indent)); i++;
      }
      fm[key] = folded ? parts.join(' ').replace(/\s+/g, ' ').trim() : parts.join('\n').trim();
      continue;
    }
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (v === 'true') v = true;
    else if (v === 'false') v = false;
    else if (v === 'null' || v === '') v = null;
    fm[key] = v;
    i++;
  }
  return { frontmatter: fm, body: m[2] };
}

function readClaudeMd(p) {
  if (!fs.existsSync(p)) return null;
  try {
    const raw = fs.readFileSync(p, 'utf-8');
    const lines = raw.split('\n').length;
    // Count @path imports (concatenated at startup).
    const imports = [...raw.matchAll(/^@([^\s#]+)/gm)].map(m => m[1]);
    return {
      path: p,
      bodyChars: raw.length,
      bodyLines: lines,
      bodyTokens: Math.ceil(raw.length / 4),
      imports,
    };
  } catch { return null; }
}

function scanClaudeRulesDir(dir) {
  const rules = [];
  if (!fs.existsSync(dir)) return rules;
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop();
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (e.isFile() && e.name.endsWith('.md')) {
        try {
          const raw = fs.readFileSync(p, 'utf-8');
          const { frontmatter, body } = parseFrontmatter(raw);
          rules.push({
            path: p,
            filename: e.name,
            paths: frontmatter.paths || null,      // glob[]; missing = unconditional
            description: frontmatter.description || null,
            bodyChars: body.length,
            bodyLines: body.split('\n').length,
            bodyTokens: Math.ceil(body.length / 4),
          });
        } catch { /* skip */ }
      }
    }
  }
  return rules;
}

function scanClaudeSkillsDir(dir) {
  const skills = [];
  if (!fs.existsSync(dir)) return skills;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return skills; }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const skillMd = path.join(dir, e.name, 'SKILL.md');
    if (!fs.existsSync(skillMd)) continue;
    try {
      const raw = fs.readFileSync(skillMd, 'utf-8');
      const { frontmatter, body } = parseFrontmatter(raw);
      // SKILL.md descriptions are always loaded into the "skill listing"
      // (budget ~8K chars). Body is loaded on invocation but can still pin
      // context for the rest of the session.
      skills.push({
        path: skillMd,
        name: e.name,
        skillName: frontmatter.name || null,
        description: frontmatter.description || null,
        allowedTools: frontmatter['allowed-tools'] || null,
        disableModelInvocation: frontmatter['disable-model-invocation'] === true,
        paths: frontmatter.paths || null,
        model: frontmatter.model || null,
        effort: frontmatter.effort || null,
        bodyChars: body.length,
        bodyLines: body ? body.split('\n').length : 0,
        bodyTokens: Math.ceil(body.length / 4),
        // Inline shell blocks `!`cmd`` run at invocation and inject output.
        shellBlocks: (body.match(/!`[^`]+`/g) || []).length,
      });
    } catch { /* skip */ }
  }
  return skills;
}

function scanClaudeAgentsDir(dir) {
  const agents = [];
  if (!fs.existsSync(dir)) return agents;
  // Agents live as <name>/<name>.md OR flat <name>.md. Walk both.
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return agents; }
  const candidates = [];
  for (const e of entries) {
    if (e.isFile() && e.name.endsWith('.md')) candidates.push(path.join(dir, e.name));
    else if (e.isDirectory()) {
      const inner = path.join(dir, e.name, `${e.name}.md`);
      if (fs.existsSync(inner)) candidates.push(inner);
    }
  }
  for (const p of candidates) {
    try {
      const raw = fs.readFileSync(p, 'utf-8');
      const { frontmatter, body } = parseFrontmatter(raw);
      agents.push({
        path: p,
        name: frontmatter.name || path.basename(p, '.md'),
        description: frontmatter.description || null,
        tools: frontmatter.tools || null,
        model: frontmatter.model || null,
        skills: frontmatter.skills || null,
        permissionMode: frontmatter.permissionMode || null,
        bodyChars: body.length,
        bodyLines: body ? body.split('\n').length : 0,
        bodyTokens: Math.ceil(body.length / 4),
      });
    } catch { /* skip */ }
  }
  return agents;
}

function scanClaudeCommandsDir(dir) {
  const cmds = [];
  if (!fs.existsSync(dir)) return cmds;
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop();
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (e.isFile() && e.name.endsWith('.md')) {
        try {
          const raw = fs.readFileSync(p, 'utf-8');
          const { frontmatter, body } = parseFrontmatter(raw);
          cmds.push({
            path: p,
            name: path.basename(p, '.md'),
            description: frontmatter.description || null,
            allowedTools: frontmatter['allowed-tools'] || null,
            bodyChars: body.length,
            bodyTokens: Math.ceil(body.length / 4),
          });
        } catch { /* skip */ }
      }
    }
  }
  return cmds;
}

function readClaudeSettings(p) {
  if (!fs.existsSync(p)) return null;
  try {
    const d = JSON.parse(fs.readFileSync(p, 'utf-8'));
    return {
      path: p,
      model: d.model || null,
      effortLevel: d.effortLevel || null,
      alwaysThinkingEnabled: d.alwaysThinkingEnabled === true,
      autoMemoryEnabled: d.autoMemoryEnabled !== false, // default true
      statusLine: d.statusLine || null,
      env: d.env ? Object.keys(d.env) : [],
      hooks: d.hooks || null,
      enabledPlugins: d.enabledPlugins ? Object.keys(d.enabledPlugins) : [],
      permissions: d.permissions || null,
      outputStyle: d.outputStyle || null,
    };
  } catch { return null; }
}

// Scan installed plugins and return content from the ones the user has enabled.
// Plugins ship: CLAUDE.md, rules/, skills/, agents/, commands/, hooks/,
// .mcp.json, plus a `.claude-plugin/plugin.json` manifest whose `hooks` and
// `mcpServers` blocks are loaded the same way as settings.json hooks and
// project MCP configs.
function scanEnabledPlugins(userSettings) {
  const plugins = [];
  const installedFile = path.join(HOME, '.claude', 'plugins', 'installed_plugins.json');
  if (!fs.existsSync(installedFile)) return plugins;
  const enabledMap = (userSettings && userSettings.enabledPlugins)
    ? new Set(userSettings.enabledPlugins)
    : null;

  let installed;
  try { installed = JSON.parse(fs.readFileSync(installedFile, 'utf-8')); }
  catch { return plugins; }

  const pluginsMap = installed?.plugins || {};
  for (const [pluginKey, entries] of Object.entries(pluginsMap)) {
    if (enabledMap && !enabledMap.has(pluginKey)) continue;
    const entry = Array.isArray(entries) && entries[0];
    if (!entry?.installPath || !fs.existsSync(entry.installPath)) continue;
    const root = entry.installPath;

    // Manifest — has plugin-scoped hooks and mcpServers.
    let manifest = null;
    const manifestFile = path.join(root, '.claude-plugin', 'plugin.json');
    try {
      if (fs.existsSync(manifestFile)) manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf-8'));
    } catch { /* ignore */ }

    const claudeMd = readClaudeMd(path.join(root, 'CLAUDE.md'));
    const rules = scanClaudeRulesDir(path.join(root, 'rules'));
    const skills = scanClaudeSkillsDir(path.join(root, 'skills'));
    const agents = scanClaudeAgentsDir(path.join(root, 'agents'));
    const commands = scanClaudeCommandsDir(path.join(root, 'commands'));

    // Plugin-shipped MCP servers — two sources:
    //  - `.mcp.json` at plugin root (same shape as project `.mcp.json`)
    //  - `mcpServers` block inside manifest
    const { parseMcpConfigFile } = require('./base');
    const mcpServers = [];
    mcpServers.push(...parseMcpConfigFile(
      path.join(root, '.mcp.json'),
      { editor: 'claude-code', label: 'Claude Code', scope: 'plugin' }
    ));
    if (manifest?.mcpServers && typeof manifest.mcpServers === 'object') {
      for (const [name, cfg] of Object.entries(manifest.mcpServers)) {
        mcpServers.push({
          name,
          editor: 'claude-code',
          editorLabel: 'Claude Code',
          scope: 'plugin',
          configPath: manifestFile,
          command: cfg.command || null,
          url: cfg.url || null,
          transport: cfg.url ? (cfg.transport || 'http') : (cfg.transport || 'stdio'),
          disabled: !!cfg.disabled,
          disabledTools: cfg.disabledTools || [],
        });
      }
    }

    const hooks = manifest?.hooks || null;

    plugins.push({
      key: pluginKey,               // e.g. "caveman@caveman"
      name: manifest?.name || pluginKey.split('@')[0],
      version: entry.version || null,
      installPath: root,
      description: manifest?.description || null,
      claudeMd,
      rules,
      skills,
      agents,
      commands,
      hooks,                         // plugin.json hooks block
      mcpServers,
    });
  }
  return plugins;
}

function scanClaudeJsonMcpForProject(claudeJson, projectFolder) {
  if (!claudeJson || !claudeJson.projects) return [];
  const entry = claudeJson.projects[projectFolder];
  if (!entry || !entry.mcpServers) return [];
  const cfgPath = path.join(HOME, '.claude.json');
  return Object.entries(entry.mcpServers).map(([nm, cfg]) => ({
    name: nm,
    editor: 'claude-code',
    editorLabel: 'Claude Code',
    scope: 'user-project',
    configPath: cfgPath,
    command: cfg.command || null,
    url: cfg.url || null,
    transport: cfg.url ? (cfg.transport || 'http') : (cfg.transport || 'stdio'),
    disabled: cfg.disabled || false,
    disabledTools: cfg.disabledTools || [],
    projectFolder,
  }));
}

/**
 * Structured config snapshot for Claude Code — analogous to cursor.getConfig.
 * Scans ~/.claude/* for global surface and walks each projectFolder upward for
 * nested CLAUDE.md / rules / skills / agents / commands / settings / .mcp.json.
 */
function getConfig(projectFolders = []) {
  const { parseMcpConfigFile } = require('./base');

  // Load ~/.claude.json once so we can look up per-project MCP servers below.
  let claudeJson = null;
  try {
    const p = path.join(HOME, '.claude.json');
    if (fs.existsSync(p)) claudeJson = JSON.parse(fs.readFileSync(p, 'utf-8'));
  } catch { /* ignore */ }

  const userSettings = readClaudeSettings(path.join(HOME, '.claude', 'settings.json'));
  const userClaudeMd = readClaudeMd(path.join(HOME, '.claude', 'CLAUDE.md'));
  const userSkills = scanClaudeSkillsDir(path.join(HOME, '.claude', 'skills'));
  const userAgents = scanClaudeAgentsDir(path.join(HOME, '.claude', 'agents'));
  const userCommands = scanClaudeCommandsDir(path.join(HOME, '.claude', 'commands'));
  const userRules = scanClaudeRulesDir(path.join(HOME, '.claude', 'rules'));
  const globalMcp = getMCPServers();
  const enabledPlugins = scanEnabledPlugins(userSettings);

  const global = {
    settings: userSettings,
    claudeMd: userClaudeMd,
    skills: userSkills,
    agents: userAgents,
    commands: userCommands,
    rules: userRules,
    mcpServers: globalMcp,
    plugins: enabledPlugins,
  };

  function walkUp(start) {
    const dirs = [];
    let cur = path.resolve(start);
    const seen = new Set();
    while (cur && !seen.has(cur)) {
      seen.add(cur);
      dirs.push(cur);
      const parent = path.dirname(cur);
      if (parent === cur) break;
      if (cur === HOME || cur === '/') break;
      cur = parent;
    }
    return dirs;
  }

  const seenFolders = new Set();
  const projects = [];
  for (const folder of projectFolders) {
    if (!folder || seenFolders.has(folder)) continue;
    if (!fs.existsSync(folder)) continue;
    seenFolders.add(folder);

    const claudeMds = [];       // ancestor CLAUDE.md files
    const rulesByPath = new Map();
    const skillsByPath = new Map();
    const agentsByPath = new Map();
    const commandsByPath = new Map();
    const settingsFiles = [];
    let mcpServers = [];

    for (const ancestor of walkUp(folder)) {
      const directMd = readClaudeMd(path.join(ancestor, 'CLAUDE.md'));
      if (directMd) claudeMds.push({ ...directMd, sourceFolder: ancestor, kind: 'project' });
      const localMd = readClaudeMd(path.join(ancestor, 'CLAUDE.local.md'));
      if (localMd) claudeMds.push({ ...localMd, sourceFolder: ancestor, kind: 'local' });
      const nestedMd = readClaudeMd(path.join(ancestor, '.claude', 'CLAUDE.md'));
      if (nestedMd) claudeMds.push({ ...nestedMd, sourceFolder: ancestor, kind: 'nested' });

      for (const r of scanClaudeRulesDir(path.join(ancestor, '.claude', 'rules'))) {
        if (!rulesByPath.has(r.path)) rulesByPath.set(r.path, { ...r, sourceFolder: ancestor });
      }
      for (const s of scanClaudeSkillsDir(path.join(ancestor, '.claude', 'skills'))) {
        if (!skillsByPath.has(s.path)) skillsByPath.set(s.path, { ...s, sourceFolder: ancestor });
      }
      for (const a of scanClaudeAgentsDir(path.join(ancestor, '.claude', 'agents'))) {
        if (!agentsByPath.has(a.path)) agentsByPath.set(a.path, { ...a, sourceFolder: ancestor });
      }
      for (const c of scanClaudeCommandsDir(path.join(ancestor, '.claude', 'commands'))) {
        if (!commandsByPath.has(c.path)) commandsByPath.set(c.path, { ...c, sourceFolder: ancestor });
      }

      for (const name of ['settings.json', 'settings.local.json']) {
        const sp = path.join(ancestor, '.claude', name);
        const s = readClaudeSettings(sp);
        if (s) settingsFiles.push({ ...s, sourceFolder: ancestor });
      }

      // Project-shared .mcp.json lives at repo root.
      const pmcp = parseMcpConfigFile(
        path.join(ancestor, '.mcp.json'),
        { editor: 'claude-code', label: 'Claude Code', scope: 'project' }
      ).map(s => ({ ...s, projectFolder: ancestor }));
      mcpServers.push(...pmcp);
    }

    // Per-project MCP servers stored under ~/.claude.json → projects[<folder>].
    mcpServers.push(...scanClaudeJsonMcpForProject(claudeJson, folder));

    if (
      claudeMds.length || rulesByPath.size || skillsByPath.size ||
      agentsByPath.size || commandsByPath.size || settingsFiles.length ||
      mcpServers.length
    ) {
      projects.push({
        folder,
        claudeMds,
        rules: Array.from(rulesByPath.values()),
        skills: Array.from(skillsByPath.values()),
        agents: Array.from(agentsByPath.values()),
        commands: Array.from(commandsByPath.values()),
        settings: settingsFiles,
        mcpServers,
      });
    }
  }

  return { global, projects };
}

module.exports = { name, labels, getChats, getMessages, getUsage, getArtifacts, getMCPServers, getConfig };
