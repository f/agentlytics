const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { getAppDataPath } = require('./base');

const HOME = os.homedir();
const CURSOR_CHATS_DIR = path.join(HOME, '.cursor', 'chats');
const CURSOR_USER_DIR = path.join(getAppDataPath('Cursor'), 'User');
const WORKSPACE_STORAGE_DIR = path.join(CURSOR_USER_DIR, 'workspaceStorage');
const GLOBAL_STORAGE_DB = path.join(CURSOR_USER_DIR, 'globalStorage', 'state.vscdb');

// ============================================================
// Source 1: ~/.cursor/chats/<hash>/<chatId>/store.db (agent KV)
// ============================================================

function getAgentStoreChats() {
  const results = [];
  if (!fs.existsSync(CURSOR_CHATS_DIR)) return results;

  for (const workspace of fs.readdirSync(CURSOR_CHATS_DIR)) {
    const wsDir = path.join(CURSOR_CHATS_DIR, workspace);
    if (!fs.statSync(wsDir).isDirectory()) continue;
    for (const chat of fs.readdirSync(wsDir)) {
      const dbPath = path.join(wsDir, chat, 'store.db');
      if (fs.existsSync(dbPath)) {
        results.push({ workspace, chatId: chat, dbPath });
      }
    }
  }
  return results;
}

function hexToString(hex) {
  let str = '';
  for (let i = 0; i < hex.length; i += 2) {
    str += String.fromCharCode(parseInt(hex.substring(i, i + 2), 16));
  }
  return str;
}

function readStoreMeta(db) {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get('0');
  if (!row) return null;
  const hex = typeof row.value === 'string' ? row.value : Buffer.from(row.value).toString('hex');
  try {
    return JSON.parse(hexToString(hex));
  } catch {
    try { return JSON.parse(row.value); } catch { return null; }
  }
}

function parseTreeBlob(data) {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const messageRefs = [];
  const childRefs = [];
  let offset = 0;
  while (offset < buf.length) {
    if (offset + 34 > buf.length) break;
    const tag = buf[offset];
    const len = buf[offset + 1];
    if (len !== 0x20) break;
    const hash = buf.slice(offset + 2, offset + 2 + 32).toString('hex');
    if (tag === 0x0a) messageRefs.push(hash);
    else if (tag === 0x12) childRefs.push(hash);
    else break;
    offset += 2 + 32;
  }
  return { messageRefs, childRefs };
}

function normalizeStoreMessage(json) {
  const msg = { role: json.role, content: '', _toolCalls: [] };
  // Content may be string or array of parts
  if (typeof json.content === 'string') {
    msg.content = json.content;
  } else if (Array.isArray(json.content)) {
    msg.content = json.content.map(p => typeof p === 'string' ? p : (p.text || '')).join('\n');
  }
  // Tool calls (OpenAI format)
  if (json.tool_calls && Array.isArray(json.tool_calls)) {
    for (const tc of json.tool_calls) {
      const name = tc.function?.name || tc.name || 'unknown';
      let args = {};
      try {
        args = typeof tc.function?.arguments === 'string' ? JSON.parse(tc.function.arguments) : (tc.function?.arguments || {});
      } catch {}
      const argKeys = typeof args === 'object' ? Object.keys(args).join(', ') : '';
      msg.content += `\n[tool-call: ${name}(${argKeys})]`;
      msg._toolCalls.push({ name, args });
    }
  }
  if (json.model) msg._model = json.model;
  return msg;
}

function collectStoreMessages(db, rootBlobId) {
  const allMessages = [];
  const visited = new Set();
  function walk(blobId) {
    if (visited.has(blobId)) return;
    visited.add(blobId);
    const row = db.prepare('SELECT data FROM blobs WHERE id = ?').get(blobId);
    if (!row) return;
    const data = row.data;
    try {
      const json = typeof data === 'string' ? JSON.parse(data) : JSON.parse(data.toString('utf-8'));
      if (json && json.role) { allMessages.push(normalizeStoreMessage(json)); return; }
    } catch { /* tree blob */ }
    const { messageRefs, childRefs } = parseTreeBlob(data);
    for (const ref of messageRefs) walk(ref);
    for (const ref of childRefs) walk(ref);
  }
  walk(rootBlobId);
  return allMessages;
}

// ============================================================
// Source 2: workspaceStorage + globalStorage (composer bubbles)
// ============================================================

function getWorkspaceMap() {
  const map = [];
  if (!fs.existsSync(WORKSPACE_STORAGE_DIR)) return map;
  for (const hash of fs.readdirSync(WORKSPACE_STORAGE_DIR)) {
    const dir = path.join(WORKSPACE_STORAGE_DIR, hash);
    const wsJson = path.join(dir, 'workspace.json');
    const stateDb = path.join(dir, 'state.vscdb');
    if (!fs.existsSync(wsJson) || !fs.existsSync(stateDb)) continue;
    try {
      const ws = JSON.parse(fs.readFileSync(wsJson, 'utf-8'));
      const folder = (ws.folder || '').replace('file://', '');
      map.push({ hash, folder, stateDb });
    } catch { /* skip */ }
  }
  return map;
}

function getComposerHeaders(stateDbPath) {
  try {
    const db = new Database(stateDbPath, { readonly: true });
    const row = db.prepare("SELECT value FROM ItemTable WHERE key = 'composer.composerData'").get();
    db.close();
    if (!row) return [];
    const data = JSON.parse(row.value);
    return (data.allComposers || []).map((c) => ({
      composerId: c.composerId,
      name: c.name || null,
      createdAt: c.createdAt || null,
      lastUpdatedAt: c.lastUpdatedAt || null,
      mode: c.unifiedMode || c.forceMode || 'unknown',
      isAgentic: c.unifiedMode === 'agent',
    }));
  } catch { return []; }
}

function getModelPreference(globalDb) {
  try {
    const row = globalDb.prepare("SELECT value FROM ItemTable WHERE key = 'cursor/lastSingleModelPreference'").get();
    if (!row) return null;
    const pref = JSON.parse(row.value);
    return pref.composer || pref.agent || null;
  } catch { return null; }
}

function getComposerBubbles(globalDb, composerId) {
  const prefix = `bubbleId:${composerId}:`;
  const rows = globalDb.prepare(
    "SELECT key, value FROM cursorDiskKV WHERE key LIKE ? ORDER BY key"
  ).all(prefix + '%');

  const bubbles = [];
  for (const row of rows) {
    try {
      const obj = JSON.parse(row.value);
      bubbles.push(obj);
    } catch { /* binary blob, skip */ }
  }
  return bubbles;
}

function bubblesToMessages(bubbles) {
  const messages = [];
  for (const b of bubbles) {
    if (!b) continue;
    const type = b.type; // 1=user, 2=assistant
    if (type === 1) {
      const text = b.text || '';
      if (text) {
        messages.push({ role: 'user', content: text });
      }
    } else if (type === 2) {
      const textParts = [];
      // Thinking block
      if (b.thinking && b.thinking.text) {
        textParts.push(`[thinking] ${b.thinking.text}`);
      }
      // Main text
      if (b.text) {
        textParts.push(b.text);
      }
      // Tool calls — format as [tool-call: name(argKeys)] for analytics
      const _toolCalls = [];
      const tfd = b.toolFormerData;
      if (tfd && tfd.name) {
        let args = {};
        try {
          args = typeof tfd.rawArgs === 'string' && tfd.rawArgs !== '' ? JSON.parse(tfd.rawArgs) : (tfd.rawArgs || {});
        } catch {}
        // Fallback: use params field when rawArgs is empty
        if (!args || (typeof args === 'object' && Object.keys(args).length === 0)) {
          try {
            const p = typeof tfd.params === 'string' ? JSON.parse(tfd.params) : tfd.params;
            if (p && typeof p === 'object' && Object.keys(p).length > 0) args = p;
          } catch {}
        }
        const argKeys = typeof args === 'object' ? Object.keys(args).join(', ') : '';
        textParts.push(`[tool-call: ${tfd.name}(${argKeys})]`);
        _toolCalls.push({ name: tfd.name, args });
        if (tfd.result) {
          const preview = typeof tfd.result === 'string' ? tfd.result.substring(0, 300) : JSON.stringify(tfd.result).substring(0, 300);
          textParts.push(`[tool-result: ${tfd.name}] ${preview}`);
        }
      }
      // Code blocks
      if (b.codeBlocks && b.codeBlocks.length > 0) {
        for (const cb of b.codeBlocks) {
          const filePath = cb.uri ? cb.uri.path : '';
          if (filePath) textParts.push(`[file: ${filePath}]`);
        }
      }
      if (textParts.length > 0) {
        messages.push({
          role: 'assistant',
          content: textParts.join('\n'),
          _model: b.modelId || b.model || null,
          _inputTokens: b.tokenCount?.inputTokens,
          _outputTokens: b.tokenCount?.outputTokens,
          _toolCalls,
        });
      }
    }
  }
  return messages;
}

// ============================================================
// Adapter interface
// ============================================================

const name = 'cursor';

function getChats() {
  const chats = [];

  // Source 1: ~/.cursor/chats store.db
  for (const { workspace, chatId, dbPath } of getAgentStoreChats()) {
    try {
      const db = new Database(dbPath, { readonly: true });
      const meta = readStoreMeta(db);
      db.close();
      if (meta) {
        chats.push({
          source: 'cursor',
          composerId: chatId,
          name: meta.name || null,
          createdAt: meta.createdAt || null,
          mode: meta.mode || null,
          folder: null,
          _dbPath: dbPath,
          _rootBlobId: meta.latestRootBlobId,
          _lastUsedModel: meta.lastUsedModel || null,
          _type: 'agent-store',
        });
      }
    } catch { /* skip */ }
  }

  // Source 2: workspaceStorage composers
  let globalDb = null;
  try { globalDb = new Database(GLOBAL_STORAGE_DB, { readonly: true }); } catch { /* no global db */ }

  const modelPref = globalDb ? getModelPreference(globalDb) : null;

  for (const { hash, folder, stateDb } of getWorkspaceMap()) {
    const headers = getComposerHeaders(stateDb);
    for (const h of headers) {
      let bubbleCount = 0;
      if (globalDb) {
        try {
          const countRow = globalDb.prepare(
            "SELECT count(*) as cnt FROM cursorDiskKV WHERE key LIKE ?"
          ).get(`bubbleId:${h.composerId}:%`);
          bubbleCount = countRow ? countRow.cnt : 0;
        } catch { /* skip */ }
      }
      chats.push({
        source: 'cursor',
        composerId: h.composerId,
        name: h.name || null,
        createdAt: h.createdAt || null,
        lastUpdatedAt: h.lastUpdatedAt || null,
        mode: h.mode,
        folder,
        bubbleCount,
        _type: 'workspace',
        _modelPref: modelPref,
      });
    }
  }

  if (globalDb) globalDb.close();
  return chats;
}

function getMessages(chat) {
  if (chat._type === 'agent-store') {
    const db = new Database(chat._dbPath, { readonly: true });
    const msgs = collectStoreMessages(db, chat._rootBlobId);
    db.close();
    // Use lastUsedModel as fallback for assistant messages without model info
    if (chat._lastUsedModel) {
      for (const m of msgs) {
        if (m.role === 'assistant' && !m._model) m._model = chat._lastUsedModel;
      }
    }
    return msgs;
  }

  let globalDb;
  try { globalDb = new Database(GLOBAL_STORAGE_DB, { readonly: true }); } catch { return []; }
  const bubbles = getComposerBubbles(globalDb, chat.composerId);
  globalDb.close();
  const msgs = bubblesToMessages(bubbles);
  // Use model preference as fallback for messages without model info
  if (chat._modelPref) {
    for (const m of msgs) {
      if (m.role === 'assistant' && !m._model) m._model = chat._modelPref;
    }
  }
  return msgs;
}

// ============================================================
// Usage / quota data from Cursor REST API
// ============================================================

function getCursorAccessToken() {
  try {
    const db = new Database(GLOBAL_STORAGE_DB, { readonly: true });
    const row = db.prepare("SELECT value FROM ItemTable WHERE key = 'cursorAuth/accessToken'").get();
    db.close();
    return row ? row.value : null;
  } catch { return null; }
}

function cursorApiFetch(endpoint, token) {
  return new Promise((resolve) => {
    const https = require('https');
    const url = `https://api2.cursor.sh/auth/${endpoint}`;
    const req = https.get(url, {
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
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
  const { isSubscriptionAccessAllowed } = require('./base');
  if (!isSubscriptionAccessAllowed()) return null;
  const token = getCursorAccessToken();
  if (!token) return null;

  const [profile, usage] = await Promise.all([
    cursorApiFetch('full_stripe_profile', token),
    cursorApiFetch('usage', token),
  ]);

  if (!profile && !usage) return null;

  const result = {
    source: 'cursor',
    plan: {
      name: profile?.individualMembershipType || profile?.membershipType || null,
      status: profile?.subscriptionStatus || null,
      isTeamMember: profile?.isTeamMember || false,
      isYearlyPlan: profile?.isYearlyPlan || false,
    },
    usage: {},
    startOfMonth: usage?.startOfMonth || null,
  };

  // Parse per-model usage from the usage endpoint
  if (usage) {
    for (const [model, data] of Object.entries(usage)) {
      if (model === 'startOfMonth') continue;
      result.usage[model] = {
        numRequests: data.numRequests || 0,
        numRequestsTotal: data.numRequestsTotal || 0,
        numTokens: data.numTokens || 0,
        maxRequestUsage: data.maxRequestUsage || null,
        maxTokenUsage: data.maxTokenUsage || null,
      };
    }
  }

  return result;
}

const labels = { 'cursor': 'Cursor' };

function getArtifacts(folder) {
  const { scanArtifacts } = require('./base');
  return scanArtifacts(folder, {
    editor: 'cursor',
    label: 'Cursor',
    files: ['.cursorrules', 'AGENTS.md'],
    dirs: ['.cursor/rules', '.cursor/plans'],
  });
}

function getMCPServers() {
  const { parseMcpConfigFile } = require('./base');
  const globalConfig = path.join(HOME, '.cursor', 'mcp.json');
  return [
    ...parseMcpConfigFile(globalConfig, { editor: 'cursor', label: 'Cursor', scope: 'global' }),
  ];
}

// ============================================================
// Config inspection (for suggestions engine)
// ============================================================

function parseRuleFrontmatter(raw) {
  // Cursor .mdc format: YAML-ish frontmatter between leading '---' fences.
  // Supports scalar values and folded/literal block scalars (`>`, `>-`, `|`, `|-`).
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
    let raw = kv[2].trim();

    // Block scalar: collect continuation lines indented further than the key line
    if (/^[>|][-+]?\s*$/.test(raw)) {
      const folded = raw.startsWith('>');
      const keyIndent = line.match(/^(\s*)/)[1].length;
      const parts = [];
      i++;
      while (i < lines.length) {
        const l = lines[i];
        if (l.trim() === '') { parts.push(''); i++; continue; }
        const indent = l.match(/^(\s*)/)[1].length;
        if (indent <= keyIndent) break;
        parts.push(l.slice(indent));
        i++;
      }
      fm[key] = folded ? parts.join(' ').replace(/\s+/g, ' ').trim() : parts.join('\n').trim();
      continue;
    }

    // Scalar: strip quotes, coerce booleans/null/empty
    let v = raw;
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    if (v === 'true') v = true;
    else if (v === 'false') v = false;
    else if (v === 'null' || v === '') v = null;
    fm[key] = v;
    i++;
  }
  return { frontmatter: fm, body: m[2] };
}

function scanRulesDir(dir) {
  const rules = [];
  if (!fs.existsSync(dir)) return rules;
  // Recurse one level — Cursor supports nested rules dirs
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop();
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (e.isFile() && e.name.endsWith('.mdc')) {
        try {
          const raw = fs.readFileSync(p, 'utf-8');
          const { frontmatter, body } = parseRuleFrontmatter(raw);
          rules.push({
            path: p,
            filename: e.name,
            description: frontmatter.description || null,
            globs: frontmatter.globs || null,
            alwaysApply: frontmatter.alwaysApply === true,
            bodyChars: body.length,
            bodyTokens: Math.ceil(body.length / 4),
          });
        } catch { /* skip unreadable rule */ }
      }
    }
  }
  return rules;
}

function scanSkillsDir(dir) {
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
      const { frontmatter, body } = parseRuleFrontmatter(raw);
      skills.push({
        path: skillMd,
        name: e.name,
        skillName: frontmatter.name || null,
        description: frontmatter.description || null,
        disableModelInvocation: frontmatter['disable-model-invocation'] === true || frontmatter['disable-model-invocation'] === 'true',
        bodyChars: body.length,
        bodyLines: body ? body.split('\n').length : 0,
        bodyTokens: Math.ceil(body.length / 4),
      });
    } catch { /* skip */ }
  }
  return skills;
}

function readCursorrules(filePath) {
  if (!fs.existsSync(filePath)) return null;
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    return { path: filePath, bodyChars: raw.length, bodyTokens: Math.ceil(raw.length / 4) };
  } catch { return null; }
}

function readCliConfig() {
  const p = path.join(HOME, '.cursor', 'cli-config.json');
  if (!fs.existsSync(p)) return null;
  try {
    const data = JSON.parse(fs.readFileSync(p, 'utf-8'));
    return {
      path: p,
      modelId: data.model?.modelId || null,
      displayName: data.model?.displayName || null,
      maxMode: data.maxMode || data.model?.maxMode || false,
      approvalMode: data.approvalMode || null,
      sandboxMode: data.sandbox?.mode || null,
      hasChangedDefaultModel: data.hasChangedDefaultModel || false,
    };
  } catch { return null; }
}

/**
 * Return a structured snapshot of Cursor's configuration — both global
 * (user-level) and per-project — suitable for the suggestions analyzer.
 *
 * @param {string[]} projectFolders - Absolute folder paths to inspect
 */
// Walk Cursor's per-project MCP tool cache. Cursor stores every discovered
// MCP tool's full JSON schema (name, description, args schema) at
// `~/.cursor/projects/<project-key>/mcps/<server-key>/tools/<tool>.json`.
// That file content is what actually gets loaded into the model's system
// prompt on every turn — so file size is a direct proxy for context tokens.
// We aggregate across all project-keys, grouping by normalized server name.
function scanMcpToolSchemaCache() {
  const byServer = new Map(); // serverName → Map<toolName, { chars, tokens, description }>
  const projectsRoot = path.join(HOME, '.cursor', 'projects');
  if (!fs.existsSync(projectsRoot)) return byServer;
  let projectDirs;
  try { projectDirs = fs.readdirSync(projectsRoot, { withFileTypes: true }); } catch { return byServer; }
  for (const p of projectDirs) {
    if (!p.isDirectory()) continue;
    const mcpsDir = path.join(projectsRoot, p.name, 'mcps');
    if (!fs.existsSync(mcpsDir)) continue;
    let serverDirs;
    try { serverDirs = fs.readdirSync(mcpsDir, { withFileTypes: true }); } catch { continue; }
    for (const s of serverDirs) {
      if (!s.isDirectory()) continue;
      // Server key format: "user-<name>" (global), "plugin-<name>-<name>" (plugin),
      // etc. Strip the prefix so findings match the server name users see.
      // Normalize case. Cursor's per-project cache can use different casings
      // for the same server (e.g. "user-Atlassian" vs "user-atlassian") —
      // treat them as one.
      const serverName = s.name.replace(/^user-/, '').replace(/^plugin-[^-]+-/, '').toLowerCase();
      const toolsDir = path.join(mcpsDir, s.name, 'tools');
      if (!fs.existsSync(toolsDir)) continue;
      let toolFiles;
      try { toolFiles = fs.readdirSync(toolsDir); } catch { continue; }
      if (!byServer.has(serverName)) byServer.set(serverName, new Map());
      const entry = byServer.get(serverName);
      for (const f of toolFiles) {
        if (!f.endsWith('.json')) continue;
        try {
          const raw = fs.readFileSync(path.join(toolsDir, f), 'utf-8');
          const json = JSON.parse(raw);
          const toolName = json.name || f.replace(/\.json$/, '');
          // Prefer the largest schema we've seen for this tool (same tool
          // can appear under several project keys; schemas should be
          // identical but take the max to be safe).
          const chars = raw.length;
          const prev = entry.get(toolName);
          if (!prev || prev.chars < chars) {
            entry.set(toolName, {
              chars,
              tokens: Math.ceil(chars / 4),
              description: json.description || '',
            });
          }
        } catch { /* skip malformed */ }
      }
    }
  }
  return byServer;
}

function getConfig(projectFolders = []) {
  const global = {
    mcpServers: getMCPServers(),
    skills: scanSkillsDir(path.join(HOME, '.cursor', 'skills-cursor')),
    cliConfig: readCliConfig(),
    mcpToolSchemas: scanMcpToolSchemaCache(),
  };

  // Cursor loads .cursor/rules/ from the project folder AND from every
  // ancestor directory up to the filesystem root. Walk upward so rules
  // defined at a monorepo root are attributed to each subfolder they apply to.
  function walkUpCursorDirs(start) {
    const dirs = [];
    let cur = path.resolve(start);
    const seenCur = new Set();
    while (cur && !seenCur.has(cur)) {
      seenCur.add(cur);
      dirs.push(cur);
      const parent = path.dirname(cur);
      if (parent === cur) break;
      // Stop at home or root to avoid scanning unrelated system dirs
      if (cur === HOME || cur === '/') break;
      cur = parent;
    }
    return dirs;
  }

  const seen = new Set();
  const projects = [];
  for (const folder of projectFolders) {
    if (!folder || seen.has(folder)) continue;
    if (!fs.existsSync(folder)) continue;
    seen.add(folder);

    const rulesByPath = new Map();
    const skillsByPath = new Map();
    for (const ancestor of walkUpCursorDirs(folder)) {
      for (const r of scanRulesDir(path.join(ancestor, '.cursor', 'rules'))) {
        if (!rulesByPath.has(r.path)) rulesByPath.set(r.path, { ...r, sourceFolder: ancestor });
      }
      for (const s of scanSkillsDir(path.join(ancestor, '.cursor', 'skills'))) {
        if (!skillsByPath.has(s.path)) skillsByPath.set(s.path, { ...s, sourceFolder: ancestor });
      }
    }
    const rules = Array.from(rulesByPath.values());
    const skills = Array.from(skillsByPath.values());
    const legacy = readCursorrules(path.join(folder, '.cursorrules'));
    const { parseMcpConfigFile } = require('./base');
    const mcpServers = parseMcpConfigFile(
      path.join(folder, '.cursor', 'mcp.json'),
      { editor: 'cursor', label: 'Cursor', scope: 'project' }
    ).map(s => ({ ...s, projectFolder: folder }));
    if (rules.length || skills.length || legacy || mcpServers.length) {
      projects.push({ folder, rules, skills, legacyCursorrules: legacy, mcpServers });
    }
  }

  return { global, projects };
}

module.exports = { name, labels, getChats, getMessages, getUsage, getArtifacts, getMCPServers, getConfig };
