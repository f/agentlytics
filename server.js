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

app.get('/api/all-projects', (req, res) => {
  try {
    res.json(cache.getCachedProjects({ ...parseDateOpts(req.query), includeHidden: true }));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// SPA fallback
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

module.exports = app;
