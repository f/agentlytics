const express = require('express');
const path = require('path');
const fs = require('fs');
const os = require('os');
const cache = require('./cache');
const { generateShareSvg } = require('./share-image');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ============================================================
// Config: ~/.agentlytics/config.json
// ============================================================

const CONFIG_PATH = path.join(os.homedir(), '.agentlytics', 'config.json');

function readConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8')); } catch { return {}; }
}

function writeConfig(config) {
  const dir = path.dirname(CONFIG_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
}

function getHiddenFolders() {
  return readConfig().hiddenProjects || [];
}

// ============================================================
// API endpoints — all reads from SQLite cache
// ============================================================

// Helper: parse date query params into Unix ms timestamps
function parseDateOpts(query) {
  const opts = {};
  if (query.dateFrom) opts.dateFrom = parseInt(query.dateFrom) || null;
  if (query.dateTo) opts.dateTo = parseInt(query.dateTo) || null;
  return opts;
}

app.get('/api/ping', (req, res) => {
  res.json({ app: 'agentlytics', pid: process.pid });
});

app.get('/api/mode', (req, res) => {
  res.json({ mode: 'local' });
});

app.get('/api/overview', (req, res) => {
  try {
    const opts = { editor: req.query.editor || null, ...parseDateOpts(req.query), hiddenFolders: getHiddenFolders() };
    res.json(cache.getCachedOverview(opts));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/daily-activity', (req, res) => {
  try {
    const opts = { editor: req.query.editor || null, ...parseDateOpts(req.query), hiddenFolders: getHiddenFolders() };
    res.json(cache.getCachedDailyActivity(opts));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/chats', (req, res) => {
  try {
    const opts = {
      editor: req.query.editor || null,
      folder: req.query.folder || null,
      named: req.query.named !== 'false',
      limit: req.query.limit ? parseInt(req.query.limit) : 200,
      offset: req.query.offset ? parseInt(req.query.offset) : 0,
      ...parseDateOpts(req.query),
      hiddenFolders: getHiddenFolders(),
    };
    const total = cache.countCachedChats(opts);
    const rows = cache.getCachedChats(opts);
    res.json({
      total,
      chats: rows.map(c => ({
        id: c.id,
        source: c.source,
        name: c.name,
        mode: c.mode,
        folder: c.folder,
        createdAt: c.created_at,
        lastUpdatedAt: c.last_updated_at,
        encrypted: !!c.encrypted,
        bubbleCount: c.bubble_count,
        topModel: c.top_model || null,
        cost: c.cost || 0,
      })),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/chats/:id', (req, res) => {
  try {
    const result = cache.getCachedChat(req.params.id);
    if (!result) return res.status(404).json({ error: 'Chat not found' });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/chats/:id/markdown', (req, res) => {
  try {
    const result = cache.getCachedChat(req.params.id);
    if (!result) return res.status(404).json({ error: 'Chat not found' });

    const lines = [];
    const title = result.name || 'Untitled Session';
    lines.push(`# ${title}\n`);

    // Metadata
    const meta = [];
    if (result.source) meta.push(`**Editor:** ${result.source}`);
    if (result.mode) meta.push(`**Mode:** ${result.mode}`);
    if (result.folder) meta.push(`**Project:** ${result.folder}`);
    if (result.createdAt) meta.push(`**Created:** ${new Date(result.createdAt).toISOString()}`);
    if (result.lastUpdatedAt) meta.push(`**Updated:** ${new Date(result.lastUpdatedAt).toISOString()}`);
    if (result.stats) {
      meta.push(`**Messages:** ${result.stats.totalMessages}`);
      if (result.stats.totalInputTokens) meta.push(`**Input Tokens:** ${result.stats.totalInputTokens}`);
      if (result.stats.totalOutputTokens) meta.push(`**Output Tokens:** ${result.stats.totalOutputTokens}`);
      const models = [...new Set(result.stats.models || [])];
      if (models.length > 0) meta.push(`**Models:** ${models.join(', ')}`);
    }
    if (meta.length > 0) lines.push(meta.join('  \n') + '\n');

    lines.push('---\n');

    // Messages
    for (const msg of result.messages) {
      const label = msg.role === 'user' ? '## User' : msg.role === 'assistant' ? '## Assistant' : `## ${msg.role.charAt(0).toUpperCase() + msg.role.slice(1)}`;
      const modelTag = msg.model ? ` *(${msg.model})*` : '';
      lines.push(`${label}${modelTag}\n`);
      lines.push(msg.content + '\n');
    }

    const md = lines.join('\n');
    const filename = title.replace(/[^a-zA-Z0-9_-]/g, '_').substring(0, 80) + '.md';
    res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(md);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/projects', (req, res) => {
  try {
    res.json(cache.getCachedProjects({ ...parseDateOpts(req.query), hiddenFolders: getHiddenFolders() }));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/deep-analytics', (req, res) => {
  try {
    const opts = {
      editor: req.query.editor || null,
      folder: req.query.folder || null,
      limit: Math.min(parseInt(req.query.limit) || 500, 5000),
      ...parseDateOpts(req.query),
      hiddenFolders: getHiddenFolders(),
    };
    res.json(cache.getCachedDeepAnalytics(opts));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/dashboard-stats', (req, res) => {
  try {
    const opts = { editor: req.query.editor || null, ...parseDateOpts(req.query), hiddenFolders: getHiddenFolders() };
    res.json(cache.getCachedDashboardStats(opts));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/cost-analytics', (req, res) => {
  try {
    const opts = {
      editor: req.query.editor || null,
      ...parseDateOpts(req.query),
      hiddenFolders: getHiddenFolders(),
    };
    res.json(cache.getCostAnalytics(opts));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/costs', (req, res) => {
  try {
    const opts = {
      editor: req.query.editor || null,
      folder: req.query.folder || null,
      chatId: req.query.chatId || null,
      ...parseDateOpts(req.query),
      hiddenFolders: getHiddenFolders(),
    };
    res.json(cache.getCostBreakdown(opts));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/tool-calls', (req, res) => {
  try {
    const name = req.query.name;
    if (!name) return res.status(400).json({ error: 'name query param required' });
    const opts = {
      limit: Math.min(parseInt(req.query.limit) || 200, 1000),
      folder: req.query.folder || null,
    };
    res.json(cache.getCachedToolCalls(name, opts));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/query', (req, res) => {
  try {
    const { sql } = req.body;
    if (!sql || typeof sql !== 'string') return res.status(400).json({ error: 'sql string required' });
    // Only allow SELECT / PRAGMA / EXPLAIN / WITH statements
    const trimmed = sql.trim().replace(/^--.*$/gm, '').trim();
    const first = trimmed.split(/\s+/)[0].toUpperCase();
    if (!['SELECT', 'PRAGMA', 'EXPLAIN', 'WITH'].includes(first)) {
      return res.status(403).json({ error: 'Only SELECT queries are allowed' });
    }
    const db = cache.getDb();
    if (!db) return res.status(500).json({ error: 'Database not initialized' });
    const stmt = db.prepare(sql);
    const rows = stmt.all();
    const columns = rows.length > 0 ? Object.keys(rows[0]) : [];
    res.json({ columns, rows, count: rows.length });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/schema', (req, res) => {
  try {
    const db = cache.getDb();
    if (!db) return res.status(500).json({ error: 'Database not initialized' });
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all();
    const schema = {};
    for (const { name } of tables) {
      schema[name] = db.prepare(`PRAGMA table_info(${name})`).all();
    }
    res.json({ tables: tables.map(t => t.name), schema });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/share-image', (req, res) => {
  try {
    const filterOpts = { hiddenFolders: getHiddenFolders() };
    if (req.query.folder) filterOpts.folder = req.query.folder;
    const overview = cache.getCachedOverview(filterOpts);
    const stats = cache.getCachedDashboardStats(filterOpts);
    const costs = cache.getCostAnalytics(filterOpts);
    const opts = {};
    if (req.query.showEditors !== undefined) opts.showEditors = req.query.showEditors !== 'false';
    if (req.query.showModels !== undefined) opts.showModels = req.query.showModels !== 'false';
    if (req.query.showCosts !== undefined) opts.showCosts = req.query.showCosts !== 'false';
    if (req.query.showTokens !== undefined) opts.showTokens = req.query.showTokens !== 'false';
    if (req.query.showHours !== undefined) opts.showHours = req.query.showHours !== 'false';
    if (req.query.username) opts.username = req.query.username;
    if (req.query.theme) opts.theme = req.query.theme;
    if (req.query.folder) opts.folder = req.query.folder;
    const svg = generateShareSvg(overview, stats, costs, opts);
    res.setHeader('Content-Type', 'image/svg+xml');
    res.send(svg);
  } catch (err) {
    console.error('Share image error:', err);
    res.status(500).json({ error: err.message, stack: err.stack });
  }
});

app.get('/api/usage', async (req, res) => {
  try {
    const { getAllUsage } = require('./editors');
    const usage = await getAllUsage();
    res.json(usage);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/refetch', async (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
  });
  try {
    const result = await cache.resetAndRescanAsync((progress) => {
      res.write(`data: ${JSON.stringify(progress)}\n\n`);
    });
    res.write(`data: ${JSON.stringify({ done: true, total: result.total, analyzed: result.analyzed })}\n\n`);
  } catch (err) {
    res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`);
  }
  res.end();
});

// ============================================================
// Config endpoints
// ============================================================

app.get('/api/config', (req, res) => {
  res.json(readConfig());
});

app.put('/api/config', (req, res) => {
  try {
    const config = readConfig();
    Object.assign(config, req.body);
    writeConfig(config);
    res.json(config);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/check-ai', async (req, res) => {
  const folder = req.query.folder;
  if (!folder) return res.status(400).json({ error: 'folder query param required' });
  try {
    const { execFile } = require('child_process');
    const isWindows = process.platform === 'win32';
    // On Windows, use npx.cmd with shell; on Unix, use npx directly
    const cmd = isWindows ? 'npx.cmd' : 'npx';
    const result = await new Promise((resolve, reject) => {
      execFile(cmd, ['-y', 'check-ai', '--json', folder], {
        timeout: 60000,
        maxBuffer: 1024 * 1024,
        shell: isWindows
      }, (err, stdout) => {
        try {
          const json = JSON.parse(stdout);
          resolve(json);
        } catch (e) {
          reject(new Error(err ? err.message : 'Failed to parse check-ai output'));
        }
      });
    });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// Artifacts — delegates to editors/index.js getAllArtifacts
// ============================================================

app.get('/api/artifacts', (req, res) => {
  try {
    const { getAllArtifacts } = require('./editors');
    const projects = cache.getCachedProjects({ hiddenFolders: getHiddenFolders() });
    const result = [];

    for (const project of projects) {
      const folder = project.folder;
      if (!folder) continue;

      const artifacts = getAllArtifacts(folder);
      if (artifacts.length === 0) continue;

      // Group by editor
      const byEditor = {};
      for (const a of artifacts) {
        if (!byEditor[a.editor]) byEditor[a.editor] = { editor: a.editor, label: a.editorLabel, files: [] };
        byEditor[a.editor].files.push(a);
      }

      result.push({
        folder,
        name: project.name || path.basename(folder),
        totalArtifacts: artifacts.length,
        editors: Object.values(byEditor),
      });
    }

    // Sort by total artifacts descending
    result.sort((a, b) => b.totalArtifacts - a.totalArtifacts);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/artifact-content', (req, res) => {
  try {
    const filePath = req.query.path;
    if (!filePath) return res.status(400).json({ error: 'path query param required' });

    // Security: validate file exists in known artifact results for at least one project
    const { getAllArtifacts } = require('./editors');
    const projects = cache.getCachedProjects({ hiddenFolders: getHiddenFolders() });
    let allowed = false;
    for (const project of projects) {
      if (!project.folder) continue;
      const artifacts = getAllArtifacts(project.folder);
      if (artifacts.some(a => a.path === filePath)) { allowed = true; break; }
    }
    if (!allowed) return res.status(403).json({ error: 'Not an artifact file' });

    if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File not found' });

    const content = fs.readFileSync(filePath, 'utf-8');
    const stat = fs.statSync(filePath);
    res.json({ path: filePath, name: path.basename(filePath), content, size: stat.size, modifiedAt: stat.mtime.getTime() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// MCPs — collect MCP servers from all editors + match tool calls
// ============================================================

// Cache: MCP server tool lists are queried once at startup via initMcpToolsCache()
let _mcpToolsCache = null; // { servers, serverToolResults, toolToServer, serverToolPatterns }

async function initMcpToolsCache() {
  const { getAllMCPServers } = require('./editors');
  const { queryMcpServerTools } = require('./editors/base');
  const projects = cache.getCachedProjects({ hiddenFolders: getHiddenFolders() });
  const projectFolders = projects.map(p => p.folder).filter(Boolean);

  const servers = getAllMCPServers(projectFolders);

  const queryPromises = servers.map(async (server) => {
    if (server.disabled) return { server, tools: [] };
    try {
      const tools = await queryMcpServerTools(server);
      return { server, tools };
    } catch {
      return { server, tools: [] };
    }
  });

  const serverToolResults = await Promise.all(queryPromises);

  const toolToServer = {};
  for (const { server, tools } of serverToolResults) {
    server.tools = tools;
    for (const toolName of tools) {
      toolToServer[toolName] = server.name;
    }
  }

  const serverToolPatterns = {};
  for (const { server, tools } of serverToolResults) {
    if (tools.length === 0) continue;
    serverToolPatterns[server.name] = new Set(tools.map(t => t.toLowerCase()));
  }

  _mcpToolsCache = { servers, serverToolResults, toolToServer, serverToolPatterns };
  return _mcpToolsCache;
}

app.initMcpToolsCache = initMcpToolsCache;

app.get('/api/mcps', async (req, res) => {
  try {
    const db = cache.getDb();

    // Use cached MCP tool data (queried once at startup)
    if (!_mcpToolsCache) await initMcpToolsCache();
    const { servers, serverToolResults, toolToServer, serverToolPatterns } = _mcpToolsCache;

    // 3. Get tool call stats from the SQLite cache
    const toolRows = db.prepare(`
      SELECT tc.tool_name, tc.source, tc.chat_id, tc.folder, tc.timestamp, c.name as chat_name
      FROM tool_calls tc JOIN chats c ON tc.chat_id = c.id
      ORDER BY tc.timestamp DESC
    `).all();

    const toolCallMap = {}; // toolName -> { count, editors: Set, sessions: Set, folders: Set }
    const sessionMap = {};  // chatId -> { ... }

    for (const row of toolRows) {
      const name = row.tool_name;
      if (!toolCallMap[name]) toolCallMap[name] = { count: 0, editors: new Set(), sessions: new Set(), folders: new Set() };
      toolCallMap[name].count++;
      toolCallMap[name].editors.add(row.source);
      toolCallMap[name].sessions.add(row.chat_id);
      if (row.folder) toolCallMap[name].folders.add(row.folder);

      if (!sessionMap[row.chat_id]) {
        sessionMap[row.chat_id] = {
          composerId: row.chat_id,
          source: row.source,
          name: row.chat_name,
          folder: row.folder,
          createdAt: row.timestamp,
          totalToolCalls: 0,
          tools: {},
        };
      }
      sessionMap[row.chat_id].totalToolCalls++;
      sessionMap[row.chat_id].tools[name] = (sessionMap[row.chat_id].tools[name] || 0) + 1;
    }

    // 4. Build tool call summary
    const toolCalls = Object.entries(toolCallMap)
      .map(([name, data]) => ({
        name,
        count: data.count,
        editors: [...data.editors],
        sessionCount: data.sessions.size,
        folders: [...data.folders],
      }))
      .sort((a, b) => b.count - a.count);

    // 5. Match tool calls to MCP servers using actual queried tool names.
    //    Editors prefix MCP tool names in various ways:
    //    - Windsurf: mcp{N}_{toolName}  (e.g. mcp1_query-docs)
    //    - Cursor:   mcp_{ServerName}_{toolName}  (e.g. mcp_Figma_get_figma_data)
    //    - VS Code:  mcp_{sanitizedId}_{toolName}  (e.g. mcp_io_github_byt_execute_sql)
    //    - Others:   {server}_{sep}_{toolName}  (e.g. prompts_chat__search_prompts)
    //
    //    IMPORTANT: Only match tool calls that have an explicit MCP prefix.
    //    Tool calls without a prefix (e.g. "read_file", "edit_file") are built-in
    //    editor tools even if an MCP server happens to expose a tool with the same name.
    const matchedTools = {};

    for (const tc of toolCalls) {
      const tcName = tc.name;
      let serverName = null;

      // Pattern 1: Windsurf — mcp{N}_{toolName}
      const windsurfMatch = tcName.match(/^mcp(\d+)_(.+)$/);
      if (windsurfMatch) {
        const stripped = windsurfMatch[2];
        serverName = toolToServer[stripped];
        if (!serverName) {
          // Fallback: search all server tool sets
          for (const [sn, toolSet] of Object.entries(serverToolPatterns)) {
            if (toolSet.has(stripped.toLowerCase())) { serverName = sn; break; }
          }
        }
      }

      // Pattern 2: Cursor — mcp_{ServerName}_{toolName}
      if (!serverName) {
        const cursorMatch = tcName.match(/^mcp_([^_]+)_(.+)$/);
        if (cursorMatch) {
          const sName = cursorMatch[1];
          const tName = cursorMatch[2];
          for (const [sn, toolSet] of Object.entries(serverToolPatterns)) {
            if (sn.toLowerCase() === sName.toLowerCase() && toolSet.has(tName.toLowerCase())) {
              serverName = sn; break;
            }
          }
          // Even if we can't verify the tool, the prefix confirms it's an MCP call
          if (!serverName) {
            for (const s of servers) {
              if (s.name.toLowerCase() === sName.toLowerCase()) { serverName = s.name; break; }
            }
          }
        }
      }

      // Pattern 3: VS Code / generic — mcp_{sanitizedServerId}_{toolName}
      //   Server IDs like "io.github.f/prompts.chat-mcp" become "io_github_f_prompts_chat_mcp"
      if (!serverName && tcName.startsWith('mcp_') && !tcName.match(/^mcp\d/)) {
        const suffix = tcName.slice(4).toLowerCase(); // after "mcp_"
        // First try matching via queried tool sets
        for (const [sn, toolSet] of Object.entries(serverToolPatterns)) {
          for (const tool of toolSet) {
            if (suffix.endsWith('_' + tool) || suffix.endsWith(tool)) {
              serverName = sn; break;
            }
          }
          if (serverName) break;
        }
        // Fallback: match by sanitized server name (for servers whose tools couldn't be queried)
        //   VS Code may truncate sanitized server IDs, so find the best (longest) prefix match
        if (!serverName) {
          let bestLen = 0;
          let bestServer = null;
          for (const s of servers) {
            const sanitized = s.name.toLowerCase().replace(/[^a-z0-9]/g, '_').replace(/_+/g, '_');
            // Full sanitized name match
            if (suffix.startsWith(sanitized + '_') && sanitized.length > bestLen) {
              bestLen = sanitized.length; bestServer = s.name;
            }
            // Truncated prefix: suffix must start with at least 60% of sanitized name
            const minLen = Math.max(6, Math.ceil(sanitized.length * 0.6));
            for (let len = sanitized.length; len >= minLen; len--) {
              const prefix = sanitized.slice(0, len);
              if (suffix.startsWith(prefix + '_') && len > bestLen) {
                bestLen = len; bestServer = s.name; break;
              }
            }
          }
          if (bestServer) serverName = bestServer;
        }
      }

      // Pattern 4: Double-underscore separator — {server_name}__{toolName}
      if (!serverName) {
        const sepMatch = tcName.match(/^(.+?)__(.+)$/);
        if (sepMatch) {
          const tName = sepMatch[2];
          for (const [sn, toolSet] of Object.entries(serverToolPatterns)) {
            if (toolSet.has(tName.toLowerCase())) { serverName = sn; break; }
          }
        }
      }

      if (serverName) {
        if (!matchedTools[serverName]) matchedTools[serverName] = [];
        matchedTools[serverName].push(tc);
      }
    }

    // 6. Top sessions by tool calls
    const topSessions = Object.values(sessionMap)
      .sort((a, b) => b.totalToolCalls - a.totalToolCalls)
      .slice(0, 50);

    // 7. Per-project MCP stats
    const projects = cache.getCachedProjects({ hiddenFolders: getHiddenFolders() });
    const projectMcpConfigs = [
      { file: '.mcp.json', editor: 'claude-code', label: 'Claude Code' },
      { file: '.cursor/mcp.json', editor: 'cursor', label: 'Cursor' },
      { file: '.vscode/mcp.json', editor: 'vscode', label: 'VS Code' },
      { file: '.gemini/settings.json', editor: 'gemini-cli', label: 'Gemini CLI' },
      { file: '.kiro/settings/mcp.json', editor: 'kiro', label: 'Kiro' },
    ];

    const projectMcps = [];
    for (const proj of projects) {
      if (!proj.folder) continue;
      const configs = [];
      for (const pc of projectMcpConfigs) {
        const configPath = path.join(proj.folder, pc.file);
        if (!fs.existsSync(configPath)) continue;
        try {
          const raw = fs.readFileSync(configPath, 'utf-8');
          const parsed = JSON.parse(raw);
          const mcpServers = parsed.mcpServers || parsed.mcp_servers || parsed.servers || {};
          configs.push({
            file: pc.file,
            editor: pc.editor,
            editorLabel: pc.label,
            serverCount: Object.keys(mcpServers).length,
            serverNames: Object.keys(mcpServers),
          });
        } catch { /* skip invalid configs */ }
      }
      if (configs.length === 0) continue;

      // Count MCP tool calls from this project's sessions
      const projToolCalls = toolRows.filter(r => r.folder === proj.folder);
      const mcpToolCallCount = projToolCalls.filter(r => {
        const n = r.tool_name;
        return n.startsWith('mcp') || n.includes('__');
      }).length;

      // Which configured servers are used (matched to tool calls)
      const configuredServerNames = new Set(configs.flatMap(c => c.serverNames));
      const matchedServerNames = [];
      for (const sn of configuredServerNames) {
        if (matchedTools[sn]) matchedServerNames.push(sn);
      }

      projectMcps.push({
        folder: proj.folder,
        name: proj.name,
        configs,
        totalServers: [...configuredServerNames].length,
        matchedServers: matchedServerNames.length,
        mcpToolCalls: mcpToolCallCount,
        totalSessions: proj.totalSessions || 0,
      });
    }

    projectMcps.sort((a, b) => b.totalServers - a.totalServers || b.mcpToolCalls - a.mcpToolCalls);

    // Strip _env from response (security)
    const safeServers = servers.map(({ _env, ...rest }) => rest);

    res.json({
      servers: safeServers,
      toolCalls,
      matchedTools,
      topSessions,
      projectMcps,
      summary: {
        totalServers: servers.length,
        totalToolCalls: toolRows.length,
        uniqueTools: toolCalls.length,
        sessionsWithTools: Object.keys(sessionMap).length,
        editorsWithServers: [...new Set(servers.map(s => s.editor))],
      },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/all-projects', (req, res) => {
  try {
    res.json(cache.getCachedProjects({ ...parseDateOpts(req.query), includeHidden: true }));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// GSD endpoints
// ============================================================

app.get('/api/gsd/projects', (req, res) => {
  try {
    res.json(cache.getCachedGSDProjects());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/gsd/phases', (req, res) => {
  try {
    const { folder } = req.query;
    if (!folder) return res.status(400).json({ error: 'folder query param required' });
    res.json(cache.getCachedGSDPhases(folder));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/gsd/plan', (req, res) => {
  try {
    const { folder, phase } = req.query;
    if (!folder || !phase) return res.status(400).json({ error: 'folder and phase query params required' });
    const gsd = require('./editors/gsd');
    const detail = gsd.getGSDPlanDetail(folder, phase);
    if (!detail) return res.status(404).json({ error: 'Plan not found' });
    res.json(detail);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/gsd/overview', (req, res) => {
  try {
    res.json(cache.getCachedGSDOverview());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/gsd/config', (req, res) => {
  try {
    const { folder } = req.query;
    if (!folder) return res.status(400).json({ error: 'folder query param required' });
    const configPath = require('path').join(folder, '.planning', 'config.json');
    if (!fs.existsSync(configPath)) return res.json(null);
    res.json(JSON.parse(fs.readFileSync(configPath, 'utf-8')));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/gsd/phase-tokens', (req, res) => {
  try {
    const { folder } = req.query;
    if (!folder) return res.status(400).json({ error: 'folder query param required' });
    res.json(cache.getGSDPhaseTokens(folder));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Generic .planning file reader
// type: 'state' (project-level STATE.md) | 'research' | 'verification' | 'summary' (phase-level, requires phase param)
app.get('/api/gsd/file', (req, res) => {
  try {
    const { folder, phase: phaseDir, type } = req.query;
    if (!folder || !type) return res.status(400).json({ error: 'folder and type required' });

    const planningDir = path.join(folder, '.planning');
    let content = null;

    if (type === 'state') {
      const filePath = path.join(planningDir, 'STATE.md');
      if (fs.existsSync(filePath)) content = fs.readFileSync(filePath, 'utf-8');
    } else if (phaseDir) {
      const phaseFullDir = path.join(planningDir, 'phases', phaseDir);
      const pattern = type === 'research' ? /RESEARCH\.md$/i
        : type === 'verification' ? /VERIFICATION\.md$/i
        : type === 'summary' ? /SUMMARY\.md$/i
        : null;
      if (pattern && fs.existsSync(phaseFullDir)) {
        const files = fs.readdirSync(phaseFullDir).filter(f => pattern.test(f)).sort();
        if (files.length > 0) {
          const sections = files.map(f => {
            const c = fs.readFileSync(path.join(phaseFullDir, f), 'utf-8');
            return files.length > 1 ? `## ${f}\n\n${c}` : c;
          });
          content = sections.join('\n\n---\n\n');
        }
      }
    }

    res.json({ content });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// SPA fallback
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

module.exports = app;
