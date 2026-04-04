const Database = require('better-sqlite3');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { getAllChats, getMessages, resetCaches } = require('./editors');
const { calculateCost, getModelPricing, normalizeModelName } = require('./pricing');

const CACHE_DIR = path.join(os.homedir(), '.agentlytics');
const CACHE_DB = path.join(CACHE_DIR, 'cache.db');
const SCHEMA_VERSION = 7; // bump this when schema changes to auto-revalidate

/**
 * Normalize a folder path for consistent storage/lookup.
 * - Strips file:// prefix
 * - On Windows: resolves real disk casing via fs.realpathSync.native(),
 *   falls back to uppercase drive letter + lowercase rest, trims trailing backslash,
 *   and converts backslashes to forward slashes.
 * - On macOS/Linux: resolves symlinks via fs.realpathSync().
 */
function normalizeFolder(folder) {
  if (!folder) return folder;
  // Strip file:// prefix
  folder = folder.replace(/^file:\/\//, '');

  if (process.platform === 'win32') {
    try {
      folder = path.resolve(folder);
      try {
        folder = fs.realpathSync.native(folder);
      } catch {
        // realpathSync.native failed — uppercase drive letter, lowercase rest
        if (/^[a-zA-Z]:/.test(folder)) {
          folder = folder[0].toUpperCase() + folder.slice(1);
        }
      }
      // Remove trailing backslash (but keep "C:\")
      folder = folder.replace(/\\$/, '');
      if (/^[A-Z]:$/.test(folder)) folder += '\\';
      // Convert backslashes to forward slashes
      folder = folder.replace(/\\/g, '/');
    } catch {
      // If all else fails, just return as-is with forward slashes
      folder = folder.replace(/\\/g, '/');
    }
  } else {
    try {
      folder = fs.realpathSync(folder);
    } catch {
      // Path doesn't exist, return as-is
    }
  }
  return folder;
}

let db = null;

// ============================================================
// Schema
// ============================================================

function initDb() {
  if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });

  // Check schema version; wipe DB on mismatch
  if (fs.existsSync(CACHE_DB)) {
    try {
      const tmp = new Database(CACHE_DB, { readonly: true });
      const row = tmp.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get();
      tmp.close();
      if (!row || parseInt(row.value) !== SCHEMA_VERSION) {
        for (const suffix of ['', '-wal', '-shm']) {
          const f = CACHE_DB + suffix;
          if (fs.existsSync(f)) fs.unlinkSync(f);
        }
      }
    } catch {
      // Corrupt or unreadable DB — wipe it
      for (const suffix of ['', '-wal', '-shm']) {
        const f = CACHE_DB + suffix;
        if (fs.existsSync(f)) fs.unlinkSync(f);
      }
    }
  }

  db = new Database(CACHE_DB);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');

  db.exec(`
    CREATE TABLE IF NOT EXISTS chats (
      id TEXT PRIMARY KEY,
      source TEXT NOT NULL,
      name TEXT,
      mode TEXT,
      folder TEXT,
      created_at INTEGER,
      last_updated_at INTEGER,
      encrypted INTEGER DEFAULT 0,
      bubble_count INTEGER DEFAULT 0,
      _meta TEXT
    );

    CREATE TABLE IF NOT EXISTS chat_stats (
      chat_id TEXT PRIMARY KEY,
      total_messages INTEGER DEFAULT 0,
      user_messages INTEGER DEFAULT 0,
      assistant_messages INTEGER DEFAULT 0,
      tool_messages INTEGER DEFAULT 0,
      system_messages INTEGER DEFAULT 0,
      tool_calls TEXT DEFAULT '[]',
      models TEXT DEFAULT '[]',
      total_user_chars INTEGER DEFAULT 0,
      total_assistant_chars INTEGER DEFAULT 0,
      total_input_tokens INTEGER DEFAULT 0,
      total_output_tokens INTEGER DEFAULT 0,
      total_cache_read INTEGER DEFAULT 0,
      total_cache_write INTEGER DEFAULT 0,
      analyzed_at INTEGER,
      FOREIGN KEY (chat_id) REFERENCES chats(id)
    );

    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id TEXT NOT NULL,
      seq INTEGER NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      model TEXT,
      input_tokens INTEGER,
      output_tokens INTEGER,
      cache_read INTEGER,
      cache_write INTEGER,
      FOREIGN KEY (chat_id) REFERENCES chats(id)
    );

    CREATE TABLE IF NOT EXISTS tool_calls (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id TEXT NOT NULL,
      tool_name TEXT NOT NULL,
      args_json TEXT DEFAULT '{}',
      source TEXT,
      folder TEXT,
      timestamp INTEGER,
      FOREIGN KEY (chat_id) REFERENCES chats(id)
    );

    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_chats_source ON chats(source);
    CREATE INDEX IF NOT EXISTS idx_chats_updated ON chats(last_updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_messages_chat ON messages(chat_id);
    CREATE INDEX IF NOT EXISTS idx_tool_calls_name ON tool_calls(tool_name);
    CREATE INDEX IF NOT EXISTS idx_tool_calls_chat ON tool_calls(chat_id);

    CREATE TABLE IF NOT EXISTS gsd_projects (
      folder TEXT PRIMARY KEY,
      name TEXT,
      description TEXT,
      milestone TEXT,
      total_phases INTEGER DEFAULT 0,
      completed_phases INTEGER DEFAULT 0,
      active_phase TEXT,
      todos INTEGER DEFAULT 0,
      backlog INTEGER DEFAULT 0,
      notes INTEGER DEFAULT 0,
      last_modified INTEGER,
      scanned_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS gsd_phases (
      id TEXT PRIMARY KEY,
      folder TEXT NOT NULL,
      phase_number INTEGER,
      phase_name TEXT,
      status TEXT,
      total_tasks INTEGER DEFAULT 0,
      completed_tasks INTEGER DEFAULT 0,
      has_plan INTEGER DEFAULT 0,
      has_research INTEGER DEFAULT 0,
      has_verification INTEGER DEFAULT 0,
      last_modified INTEGER,
      FOREIGN KEY (folder) REFERENCES gsd_projects(folder)
    );

    CREATE INDEX IF NOT EXISTS idx_gsd_phases_folder ON gsd_phases(folder);
  `);

  // Store schema version so future runs can detect mismatches
  db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run('schema_version', SCHEMA_VERSION.toString());

  // v2 migration: normalize folder paths on Windows
  if (process.platform === 'win32') {
    let normV = 0;
    try {
      const row = db.prepare("SELECT value FROM meta WHERE key = 'folder_norm_v'").get();
      if (row) normV = parseInt(row.value) || 0;
    } catch { }
    if (normV < 2) {
      const chatRows = db.prepare('SELECT id, folder FROM chats WHERE folder IS NOT NULL').all();
      const updChat = db.prepare('UPDATE chats SET folder = ? WHERE id = ?');
      for (const r of chatRows) {
        const norm = normalizeFolder(r.folder);
        if (norm !== r.folder) updChat.run(norm, r.id);
      }
      const tcRows = db.prepare('SELECT id, folder FROM tool_calls WHERE folder IS NOT NULL').all();
      const updTc = db.prepare('UPDATE tool_calls SET folder = ? WHERE id = ?');
      for (const r of tcRows) {
        const norm = normalizeFolder(r.folder);
        if (norm !== r.folder) updTc.run(norm, r.id);
      }
      db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('folder_norm_v', '2')").run();
    }
  }
}

// ============================================================
// Scan & populate
// ============================================================

const insertChat = () => db.prepare(`
  INSERT OR REPLACE INTO chats (id, source, name, mode, folder, created_at, last_updated_at, encrypted, bubble_count, _meta)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

const insertStat = () => db.prepare(`
  INSERT OR REPLACE INTO chat_stats (chat_id, total_messages, user_messages, assistant_messages, tool_messages, system_messages, tool_calls, models, total_user_chars, total_assistant_chars, total_input_tokens, total_output_tokens, total_cache_read, total_cache_write, analyzed_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

const insertMsg = () => db.prepare(`
  INSERT INTO messages (chat_id, seq, role, content, model, input_tokens, output_tokens, cache_read, cache_write)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
const updateChatBubbleCount = () => db.prepare(`
  UPDATE chats SET bubble_count = ? WHERE id = ?
`);

function analyzeAndStore(chat) {
  if (chat.encrypted) return;

  let messages;
  try { messages = getMessages(chat); } catch { return; }
  if (!messages || messages.length === 0) return;

  const stats = {
    total: messages.length, user: 0, assistant: 0, tool: 0, system: 0,
    toolCalls: [], models: [],
    userChars: 0, assistantChars: 0,
    inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheWrite: 0,
  };

  const delMsgs = db.prepare('DELETE FROM messages WHERE chat_id = ?');
  const delTc = db.prepare('DELETE FROM tool_calls WHERE chat_id = ?');
  delMsgs.run(chat.composerId);
  delTc.run(chat.composerId);

  const ins = insertMsg();
  const updBubbleCount = updateChatBubbleCount();
  const insTc = db.prepare('INSERT INTO tool_calls (chat_id, tool_name, args_json, source, folder, timestamp) VALUES (?, ?, ?, ?, ?, ?)');
  const chatTs = chat.lastUpdatedAt || chat.createdAt || null;

  let seq = 0;
  for (const msg of messages) {
    const text = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);

    if (msg.role === 'user') {
      stats.user++;
      stats.userChars += text.length;
    } else if (msg.role === 'assistant') {
      stats.assistant++;
      stats.assistantChars += text.length;
      // Extract tool calls from _toolCalls array (preferred) or regex fallback
      if (msg._toolCalls && msg._toolCalls.length > 0) {
        for (const tc of msg._toolCalls) {
          stats.toolCalls.push(tc.name);
          try {
            insTc.run(chat.composerId, tc.name, JSON.stringify(tc.args || {}), chat.source, chat.folder || null, chatTs);
          } catch { }
        }
      } else {
        const toolMatches = text.match(/\[tool-call: ([^\]]+)\]/g);
        if (toolMatches) {
          for (const m of toolMatches) {
            const name = m.match(/\[tool-call: ([^(]+)/)?.[1] || 'unknown';
            stats.toolCalls.push(name.trim());
            insTc.run(chat.composerId, name.trim(), '{}', chat.source, chat.folder || null, chatTs);
          }
        }
      }
      if (msg._inputTokens) stats.inputTokens += msg._inputTokens;
      if (msg._outputTokens) stats.outputTokens += msg._outputTokens;
      if (msg._cacheRead) stats.cacheRead += msg._cacheRead;
      if (msg._cacheWrite) stats.cacheWrite += msg._cacheWrite;
    } else if (msg.role === 'tool') {
      stats.tool++;
    } else if (msg.role === 'system') {
      stats.system++;
    }
    if (msg._model) stats.models.push(msg._model);

    // Store message (truncate very long content for storage)
    const storedContent = text.length > 50000 ? text.substring(0, 50000) : text;
    ins.run(chat.composerId, seq++, msg.role, storedContent, msg._model || null, msg._inputTokens || null, msg._outputTokens || null, msg._cacheRead || null, msg._cacheWrite || null);
  }

  updBubbleCount.run(messages.length, chat.composerId);

  const insStat = insertStat();
  insStat.run(
    chat.composerId, stats.total, stats.user, stats.assistant, stats.tool, stats.system,
    JSON.stringify(stats.toolCalls), JSON.stringify(stats.models),
    stats.userChars, stats.assistantChars,
    stats.inputTokens, stats.outputTokens, stats.cacheRead, stats.cacheWrite,
    Date.now()
  );
}

function scanAll(onProgress, opts = {}) {
  const force = opts.force || false;
  if (force || opts.resetCaches) resetCaches();
  const chats = opts.chats || getAllChats();
  const total = chats.length;
  let scanned = 0;
  let analyzed = 0;
  let skipped = 0;

  // Check which chats need updating
  const existing = {};
  for (const row of db.prepare('SELECT id, last_updated_at, bubble_count FROM chats').all()) {
    existing[row.id] = { ts: row.last_updated_at, bc: row.bubble_count };
  }

  const ins = insertChat();

  const batchInsert = db.transaction((chatBatch) => {
    for (const chat of chatBatch) {
      ins.run(
        chat.composerId, chat.source, chat.name || null, chat.mode || null,
        chat.folder || null, chat.createdAt || null, chat.lastUpdatedAt || null,
        chat.encrypted ? 1 : 0, chat.bubbleCount || 0,
        JSON.stringify({ _type: chat._type, _dbPath: chat._dbPath, _filePath: chat._filePath, _port: chat._port, _csrf: chat._csrf, _https: chat._https, _rootBlobId: chat._rootBlobId, _dataType: chat._dataType, _rawSource: chat._rawSource, _originator: chat._originator, _cliVersion: chat._cliVersion, _modelProvider: chat._modelProvider })
      );
    }
  });

  // Normalize folder paths
  for (const chat of chats) chat.folder = normalizeFolder(chat.folder);

  // Insert all chats in a transaction
  batchInsert(chats);

  if (onProgress) onProgress({ scanned: 0, analyzed: 0, skipped: 0, total });

  // Analyze messages for chats that are new or updated
  for (const chat of chats) {
    scanned++;
    const chatTs = chat.lastUpdatedAt || chat.createdAt || 0;

    // Skip if already cached and not updated (unless force rescan)
    const cached = existing[chat.composerId];
    const cachedTs = cached ? cached.ts : null;
    const cachedBc = cached ? cached.bc : null;
    const chatBc = chat.bubbleCount || 0;
    if (!force && cachedTs && cachedTs >= chatTs && cachedBc >= chatBc) {
      // Check if stats exist
      const hasStat = db.prepare('SELECT 1 FROM chat_stats WHERE chat_id = ?').get(chat.composerId);
      if (hasStat) {
        skipped++;
        if (onProgress) onProgress({ scanned, analyzed, skipped, total });
        continue;
      }
    }

    if (!chat.encrypted && (chat.name || chat.bubbleCount > 0)) {
      try {
        analyzeAndStore(chat);
        analyzed++;
      } catch { skipped++; }
    } else {
      skipped++;
    }

    if (onProgress) onProgress({ scanned, analyzed, skipped, total });
  }

  // Store scan metadata
  db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run('last_scan', Date.now().toString());
  db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run('total_chats', total.toString());

  // GSD scan
  cacheGSDProjects();

  return { total, analyzed, skipped };
}

// ============================================================
// Query helpers (used by server.js)
// ============================================================

// Returns { sql, params } for excluding hidden folders
function hiddenFolderFilter(opts, colName = 'folder') {
  if (!opts.hiddenFolders || opts.hiddenFolders.length === 0) return { sql: '', params: [] };
  const placeholders = opts.hiddenFolders.map(() => '?').join(',');
  return { sql: ` AND (${colName} IS NULL OR ${colName} NOT IN (${placeholders}))`, params: [...opts.hiddenFolders] };
}

function getCachedChats(opts = {}) {
  let sql = `SELECT c.*,
    cs.models AS _models,
    cs.total_input_tokens AS _inTok, cs.total_output_tokens AS _outTok,
    cs.total_cache_read AS _cacheR, cs.total_cache_write AS _cacheW,
    cs.total_user_chars AS _uChars, cs.total_assistant_chars AS _aChars
    FROM chats c LEFT JOIN chat_stats cs ON cs.chat_id = c.id WHERE 1=1`;
  const params = [];
  const hf = hiddenFolderFilter(opts, 'c.folder');
  if (hf.sql) { sql += hf.sql; params.push(...hf.params); }
  if (opts.editor) { sql += ' AND c.source LIKE ?'; params.push(`%${opts.editor}%`); }
  if (opts.folder) { sql += ' AND c.folder LIKE ?'; params.push(`%${opts.folder}%`); }
  if (opts.named !== false) { sql += ' AND (c.name IS NOT NULL OR c.bubble_count > 0)'; }
  if (opts.dateFrom) { sql += ' AND COALESCE(c.last_updated_at, c.created_at) >= ?'; params.push(opts.dateFrom); }
  if (opts.dateTo) { sql += ' AND COALESCE(c.last_updated_at, c.created_at) <= ?'; params.push(opts.dateTo); }
  sql += ' ORDER BY c.last_updated_at DESC';
  if (opts.limit) { sql += ' LIMIT ?'; params.push(opts.limit); }
  if (opts.offset) { sql += ' OFFSET ?'; params.push(opts.offset); }
  const rows = db.prepare(sql).all(params);
  for (const r of rows) {
    r.top_model = null;
    try {
      const models = JSON.parse(r._models || '[]');
      if (models.length > 0) {
        const freq = {};
        for (const m of models) freq[m] = (freq[m] || 0) + 1;
        r.top_model = Object.entries(freq).sort((a, b) => b[1] - a[1])[0][0];
      }
    } catch { }
    // Per-session cost estimate
    let inTok = r._inTok || 0, outTok = r._outTok || 0;
    if (inTok === 0 && outTok === 0 && ((r._uChars || 0) > 0 || (r._aChars || 0) > 0)) {
      inTok = Math.round((r._uChars || 0) / 4);
      outTok = Math.round((r._aChars || 0) / 4);
    }
    r.cost = r.top_model ? (calculateCost(r.top_model, inTok, outTok, r._cacheR || 0, r._cacheW || 0) || 0) : 0;
    delete r._models; delete r._inTok; delete r._outTok; delete r._cacheR; delete r._cacheW; delete r._uChars; delete r._aChars;
  }
  return rows;
}

function countCachedChats(opts = {}) {
  let sql = 'SELECT COUNT(*) as cnt FROM chats WHERE 1=1';
  const params = [];
  const hf = hiddenFolderFilter(opts);
  if (hf.sql) { sql += hf.sql; params.push(...hf.params); }
  if (opts.editor) { sql += ' AND source LIKE ?'; params.push(`%${opts.editor}%`); }
  if (opts.folder) { sql += ' AND folder LIKE ?'; params.push(`%${opts.folder}%`); }
  if (opts.named !== false) { sql += ' AND (name IS NOT NULL OR bubble_count > 0)'; }
  if (opts.dateFrom) { sql += ' AND COALESCE(last_updated_at, created_at) >= ?'; params.push(opts.dateFrom); }
  if (opts.dateTo) { sql += ' AND COALESCE(last_updated_at, created_at) <= ?'; params.push(opts.dateTo); }
  return db.prepare(sql).get(params).cnt;
}

function getCachedOverview(opts = {}) {
  // Build conditions dynamically to support editor + date range filters
  const conditions = [];
  const params = [];
  const hf = hiddenFolderFilter(opts);
  if (hf.sql) { conditions.push(hf.sql.replace(' AND ', '')); params.push(...hf.params); }
  if (opts.editor) { conditions.push('source = ?'); params.push(opts.editor); }
  if (opts.folder) { conditions.push('folder = ?'); params.push(opts.folder); }
  if (opts.dateFrom) { conditions.push('COALESCE(last_updated_at, created_at) >= ?'); params.push(opts.dateFrom); }
  if (opts.dateTo) { conditions.push('COALESCE(last_updated_at, created_at) <= ?'); params.push(opts.dateTo); }
  const where = conditions.length > 0 ? ' WHERE ' + conditions.join(' AND ') : '';
  const whereAnd = conditions.length > 0 ? ' AND ' + conditions.join(' AND ') : '';

  const totalChats = db.prepare(`SELECT COUNT(*) as cnt FROM chats${where}`).get(...params).cnt;
  // When folder-filtered, show only that project's editors; otherwise show all
  const editors = opts.folder
    ? db.prepare(`SELECT source, COUNT(*) as count FROM chats${where} GROUP BY source ORDER BY count DESC`).all(...params)
    : db.prepare('SELECT source, COUNT(*) as count FROM chats GROUP BY source ORDER BY count DESC').all();

  // By mode
  const modes = db.prepare(`SELECT mode, COUNT(*) as count FROM chats WHERE mode IS NOT NULL${whereAnd} GROUP BY mode`).all(...params);
  const byMode = {};
  for (const m of modes) byMode[m.mode] = m.count;

  // By month
  const rows = db.prepare(`
    SELECT
      substr(date(last_updated_at/1000, 'unixepoch'), 1, 7) as month,
      source,
      COUNT(*) as count
    FROM chats
    WHERE last_updated_at IS NOT NULL${whereAnd}
    GROUP BY month, source
    ORDER BY month
  `).all(...params);
  const monthMap = {};
  for (const r of rows) {
    if (!monthMap[r.month]) monthMap[r.month] = { count: 0, editors: {} };
    monthMap[r.month].count += r.count;
    monthMap[r.month].editors[r.source] = r.count;
  }
  const byMonth = Object.keys(monthMap).sort().map(m => ({ month: m, ...monthMap[m] }));

  // Top projects
  const projects = db.prepare(`
    SELECT folder, COUNT(*) as count FROM chats
    WHERE folder IS NOT NULL${whereAnd}
    GROUP BY folder ORDER BY count DESC LIMIT 20
  `).all(...params);
  const topProjects = projects.map(p => ({
    name: p.folder.split(/[/\\]/).slice(-2).join('/'),
    fullPath: p.folder,
    count: p.count,
  }));

  // Timestamps
  const oldest = db.prepare(`SELECT MIN(COALESCE(last_updated_at, created_at)) as ts FROM chats${where}`).get(...params).ts;
  const newest = db.prepare(`SELECT MAX(COALESCE(last_updated_at, created_at)) as ts FROM chats${where}`).get(...params).ts;

  return {
    totalChats,
    editors: editors.map(e => ({ id: e.source, count: e.count })),
    byMode,
    byMonth,
    topProjects,
    oldestChat: oldest,
    newestChat: newest,
  };
}

function getCachedDailyActivity(opts = {}) {
  const conditions = [];
  const params = [];
  const hf = hiddenFolderFilter(opts);
  if (hf.sql) { conditions.push(hf.sql.replace(' AND ', '')); params.push(...hf.params); }
  if (opts.editor) { conditions.push('source = ?'); params.push(opts.editor); }
  if (opts.dateFrom) { conditions.push('COALESCE(last_updated_at, created_at) >= ?'); params.push(opts.dateFrom); }
  if (opts.dateTo) { conditions.push('COALESCE(last_updated_at, created_at) <= ?'); params.push(opts.dateTo); }
  const whereAnd = conditions.length > 0 ? ' AND ' + conditions.join(' AND ') : '';
  const rows = db.prepare(`
    SELECT
      date(COALESCE(last_updated_at, created_at)/1000, 'unixepoch', 'localtime') as day,
      source,
      CAST(strftime('%H', datetime(COALESCE(last_updated_at, created_at)/1000, 'unixepoch', 'localtime')) AS INTEGER) as hour,
      COUNT(*) as count
    FROM chats
    WHERE (last_updated_at IS NOT NULL OR created_at IS NOT NULL)${whereAnd}
    GROUP BY day, source, hour
    ORDER BY day
  `).all(...params);

  const daily = {};
  for (const r of rows) {
    if (!daily[r.day]) daily[r.day] = { total: 0, editors: {}, hours: {} };
    daily[r.day].total += r.count;
    daily[r.day].editors[r.source] = (daily[r.day].editors[r.source] || 0) + r.count;
    if (!daily[r.day].hours[r.source]) daily[r.day].hours[r.source] = new Array(24).fill(0);
    daily[r.day].hours[r.source][r.hour] += r.count;
  }
  return Object.keys(daily).sort().map(day => ({ day, ...daily[day] }));
}

function getCachedDeepAnalytics(opts = {}) {
  let sql = 'SELECT cs.* FROM chat_stats cs JOIN chats c ON cs.chat_id = c.id WHERE 1=1';
  const params = [];
  const hf = hiddenFolderFilter(opts, 'c.folder');
  if (hf.sql) { sql += hf.sql; params.push(...hf.params); }
  if (opts.editor) { sql += ' AND c.source LIKE ?'; params.push(`%${opts.editor}%`); }
  if (opts.folder) { sql += ' AND c.folder = ?'; params.push(opts.folder); }
  if (opts.dateFrom) { sql += ' AND COALESCE(c.last_updated_at, c.created_at) >= ?'; params.push(opts.dateFrom); }
  if (opts.dateTo) { sql += ' AND COALESCE(c.last_updated_at, c.created_at) <= ?'; params.push(opts.dateTo); }
  sql += ' ORDER BY cs.analyzed_at DESC';
  if (opts.limit) { sql += ' LIMIT ?'; params.push(opts.limit); }

  const rows = db.prepare(sql).all(params);

  const toolFreq = {};
  const modelFreq = {};
  let totalMessages = 0, totalUserChars = 0, totalAssistantChars = 0;
  let totalToolCalls = 0, totalInputTokens = 0, totalOutputTokens = 0;
  let totalCacheRead = 0, totalCacheWrite = 0;

  for (const r of rows) {
    totalMessages += r.total_messages;
    totalUserChars += r.total_user_chars;
    totalAssistantChars += r.total_assistant_chars;
    totalInputTokens += r.total_input_tokens;
    totalOutputTokens += r.total_output_tokens;
    totalCacheRead += r.total_cache_read;
    totalCacheWrite += r.total_cache_write;

    try {
      const tools = JSON.parse(r.tool_calls);
      for (const t of tools) { toolFreq[t] = (toolFreq[t] || 0) + 1; totalToolCalls++; }
    } catch { }
    try {
      const models = JSON.parse(r.models);
      for (const m of models) { const k = normalizeModelName(m) || m; modelFreq[k] = (modelFreq[k] || 0) + 1; }
    } catch { }
  }

  // Estimate tokens from chars when no token data available
  let tokensEstimated = false;
  if (totalInputTokens === 0 && totalOutputTokens === 0 && (totalUserChars > 0 || totalAssistantChars > 0)) {
    totalInputTokens = Math.round(totalUserChars / 4);
    totalOutputTokens = Math.round(totalAssistantChars / 4);
    tokensEstimated = true;
  }

  return {
    analyzedChats: rows.length,
    totalMessages, totalToolCalls,
    totalUserChars, totalAssistantChars,
    totalInputTokens, totalOutputTokens, tokensEstimated,
    totalCacheRead, totalCacheWrite,
    topTools: Object.entries(toolFreq).sort((a, b) => b[1] - a[1]).slice(0, 30).map(([name, count]) => ({ name, count })),
    topModels: Object.entries(modelFreq).sort((a, b) => b[1] - a[1]).slice(0, 20).map(([name, count]) => ({ name, count })),
  };
}

function getCachedChat(id) {
  const chat = db.prepare('SELECT * FROM chats WHERE id LIKE ?').get(id + '%');
  if (!chat) return null;

  const stats = db.prepare('SELECT * FROM chat_stats WHERE chat_id = ?').get(chat.id);
  let messages = db.prepare('SELECT role, content, model, input_tokens, output_tokens, cache_read, cache_write FROM messages WHERE chat_id = ? ORDER BY seq').all(chat.id);

  // If no cached messages, try fetching live from the editor
  if (messages.length === 0 && !chat.encrypted) {
    try {
      const meta = JSON.parse(chat._meta || '{}');
      const reconstructed = {
        composerId: chat.id, source: chat.source, name: chat.name, mode: chat.mode,
        folder: chat.folder, createdAt: chat.created_at, lastUpdatedAt: chat.last_updated_at,
        encrypted: !!chat.encrypted, bubbleCount: chat.bubble_count,
        ...meta,
      };
      const liveMessages = getMessages(reconstructed);
      if (liveMessages && liveMessages.length > 0) {
        // Store for next time
        try { analyzeAndStore(reconstructed); } catch { }
        messages = db.prepare('SELECT role, content, model, input_tokens, output_tokens, cache_read, cache_write FROM messages WHERE chat_id = ? ORDER BY seq').all(chat.id);
      }
    } catch { }
  }

  let parsedStats = null;
  if (stats) {
    parsedStats = {
      totalMessages: stats.total_messages,
      userMessages: stats.user_messages,
      assistantMessages: stats.assistant_messages,
      toolMessages: stats.tool_messages,
      systemMessages: stats.system_messages,
      toolCalls: JSON.parse(stats.tool_calls || '[]'),
      models: JSON.parse(stats.models || '[]'),
      totalUserChars: stats.total_user_chars,
      totalAssistantChars: stats.total_assistant_chars,
      totalInputTokens: stats.total_input_tokens,
      totalOutputTokens: stats.total_output_tokens,
      totalCacheRead: stats.total_cache_read,
      totalCacheWrite: stats.total_cache_write,
    };
  }

  const toolCalls = db.prepare('SELECT tool_name, args_json FROM tool_calls WHERE chat_id = ? ORDER BY id').all(chat.id);
  const toolCallDetails = toolCalls.map(tc => ({ name: tc.tool_name, args: safeParseJson(tc.args_json) }));

  return {
    id: chat.id,
    source: chat.source,
    name: chat.name,
    mode: chat.mode,
    folder: chat.folder,
    createdAt: chat.created_at,
    lastUpdatedAt: chat.last_updated_at,
    encrypted: !!chat.encrypted,
    messages: messages.map(m => ({ role: m.role, content: m.content, model: m.model })),
    stats: parsedStats,
    toolCallDetails,
  };
}

function getCachedProjects(opts = {}) {
  // Build date filter
  let dateFilter = '';
  const dateParams = [];
  if (!opts.includeHidden) {
    const hf = hiddenFolderFilter(opts);
    if (hf.sql) { dateFilter += hf.sql; dateParams.push(...hf.params); }
  }
  if (opts.dateFrom) { dateFilter += ' AND COALESCE(last_updated_at, created_at) >= ?'; dateParams.push(opts.dateFrom); }
  if (opts.dateTo) { dateFilter += ' AND COALESCE(last_updated_at, created_at) <= ?'; dateParams.push(opts.dateTo); }

  // All unique projects with their stats
  const projects = db.prepare(`
    SELECT folder, source, COUNT(*) as count,
      MIN(COALESCE(last_updated_at, created_at)) as first_seen,
      MAX(COALESCE(last_updated_at, created_at)) as last_seen
    FROM chats WHERE folder IS NOT NULL${dateFilter}
    GROUP BY folder, source
    ORDER BY folder, count DESC
  `).all(...dateParams);

  // Group by folder
  const map = {};
  for (const r of projects) {
    if (!map[r.folder]) map[r.folder] = { folder: r.folder, totalSessions: 0, editors: {}, firstSeen: r.first_seen, lastSeen: r.last_seen };
    map[r.folder].totalSessions += r.count;
    map[r.folder].editors[r.source] = r.count;
    if (r.first_seen && r.first_seen < map[r.folder].firstSeen) map[r.folder].firstSeen = r.first_seen;
    if (r.last_seen && r.last_seen > map[r.folder].lastSeen) map[r.folder].lastSeen = r.last_seen;
  }

  // For each project, get models and tools from chat_stats
  const result = [];
  for (const [folder, proj] of Object.entries(map)) {
    const statsDateFilter = dateFilter.replace(/COALESCE\(last_updated_at/g, 'COALESCE(c.last_updated_at').replace(/created_at\)/g, 'c.created_at)');
    const stats = db.prepare(`
      SELECT cs.models, cs.tool_calls, cs.total_messages, cs.total_input_tokens, cs.total_output_tokens,
             cs.total_user_chars, cs.total_assistant_chars, cs.total_cache_read, cs.total_cache_write
      FROM chat_stats cs JOIN chats c ON cs.chat_id = c.id
      WHERE c.folder = ?${statsDateFilter}
    `).all(folder, ...dateParams);

    const modelFreq = {};
    const toolFreq = {};
    let totalMessages = 0, totalInputTokens = 0, totalOutputTokens = 0;
    let totalUserChars = 0, totalAssistantChars = 0, totalToolCalls = 0;
    let totalCacheRead = 0, totalCacheWrite = 0;

    for (const s of stats) {
      totalMessages += s.total_messages;
      totalInputTokens += s.total_input_tokens;
      totalOutputTokens += s.total_output_tokens;
      totalUserChars += s.total_user_chars;
      totalAssistantChars += s.total_assistant_chars;
      totalCacheRead += s.total_cache_read;
      totalCacheWrite += s.total_cache_write;
      try { for (const m of JSON.parse(s.models)) { const k = normalizeModelName(m) || m; modelFreq[k] = (modelFreq[k] || 0) + 1; } } catch { }
      try { for (const t of JSON.parse(s.tool_calls)) { toolFreq[t] = (toolFreq[t] || 0) + 1; totalToolCalls++; } } catch { }
    }

    // Estimate tokens from chars when no token data available
    let tokensEstimated = false;
    if (totalInputTokens === 0 && totalOutputTokens === 0 && (totalUserChars > 0 || totalAssistantChars > 0)) {
      totalInputTokens = Math.round(totalUserChars / 4);
      totalOutputTokens = Math.round(totalAssistantChars / 4);
      tokensEstimated = true;
    }

    result.push({
      folder: proj.folder,
      name: proj.folder.split(/[/\\]/).pop(),
      totalSessions: proj.totalSessions,
      editors: proj.editors,
      firstSeen: proj.firstSeen,
      lastSeen: proj.lastSeen,
      totalMessages,
      totalInputTokens,
      totalOutputTokens, tokensEstimated,
      totalUserChars,
      totalAssistantChars,
      totalToolCalls,
      totalCacheRead,
      totalCacheWrite,
      topModels: Object.entries(modelFreq).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([name, count]) => ({ name, count })),
      topTools: Object.entries(toolFreq).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([name, count]) => ({ name, count })),
    });
  }

  return result.sort((a, b) => b.totalSessions - a.totalSessions);
}

function getCachedToolCalls(toolName, opts = {}) {
  const limit = opts.limit || 200;
  let sql = `
    SELECT tc.tool_name, tc.args_json, tc.source, tc.folder, tc.timestamp,
           c.name as chat_name, tc.chat_id
    FROM tool_calls tc
    JOIN chats c ON tc.chat_id = c.id
    WHERE tc.tool_name = ?`;
  const params = [toolName];
  if (opts.folder) { sql += ' AND tc.folder = ?'; params.push(opts.folder); }
  sql += ' ORDER BY tc.timestamp DESC LIMIT ?';
  params.push(limit);
  const rows = db.prepare(sql).all(...params);

  return rows.map(r => ({
    toolName: r.tool_name,
    args: safeParseJson(r.args_json),
    source: r.source,
    folder: r.folder,
    timestamp: r.timestamp,
    chatName: r.chat_name,
    chatId: r.chat_id,
  }));
}

function safeParseJson(s) {
  try { return JSON.parse(s); } catch { return {}; }
}

/**
 * Async version of scanAll that yields the event loop between iterations.
 * Required for SSE streaming so progress events actually flush to the client.
 */
async function scanAllAsync(onProgress, opts = {}) {
  const chats = opts.chats || getAllChats();
  const total = chats.length;
  let scanned = 0;
  let analyzed = 0;
  let skipped = 0;

  // Build existing cache map with both timestamp and bubble count
  const existing = {};
  for (const row of db.prepare('SELECT id, last_updated_at, bubble_count FROM chats').all()) {
    existing[row.id] = { ts: row.last_updated_at, bc: row.bubble_count };
  }

  // Normalize folder paths
  for (const chat of chats) chat.folder = normalizeFolder(chat.folder);

  const ins = insertChat();
  const batchInsert = db.transaction((chatBatch) => {
    for (const chat of chatBatch) {
      ins.run(
        chat.composerId, chat.source, chat.name || null, chat.mode || null,
        chat.folder || null, chat.createdAt || null, chat.lastUpdatedAt || null,
        chat.encrypted ? 1 : 0, chat.bubbleCount || 0,
        JSON.stringify({ _type: chat._type, _dbPath: chat._dbPath, _filePath: chat._filePath, _port: chat._port, _csrf: chat._csrf, _https: chat._https, _rootBlobId: chat._rootBlobId, _dataType: chat._dataType, _rawSource: chat._rawSource, _originator: chat._originator, _cliVersion: chat._cliVersion, _modelProvider: chat._modelProvider })
      );
    }
  });
  batchInsert(chats);

  if (onProgress) onProgress({ scanned: 0, analyzed: 0, skipped: 0, total });

  for (const chat of chats) {
    scanned++;
    const chatTs = chat.lastUpdatedAt || chat.createdAt || 0;
    const chatBc = chat.bubbleCount || 0;

    // Skip if already cached, not updated, and bubble count hasn't grown
    const cached = existing[chat.composerId];
    if (cached && cached.ts && cached.ts >= chatTs && cached.bc >= chatBc) {
      const hasStat = db.prepare('SELECT 1 FROM chat_stats WHERE chat_id = ?').get(chat.composerId);
      if (hasStat) {
        skipped++;
        if (onProgress) onProgress({ scanned, analyzed, skipped, total });
        // Yield event loop so SSE flushes
        await new Promise(r => setImmediate(r));
        continue;
      }
    }

    if (!chat.encrypted && (chat.name || chat.bubbleCount > 0)) {
      try {
        analyzeAndStore(chat);
        analyzed++;
      } catch { skipped++; }
    } else {
      skipped++;
    }

    if (onProgress) onProgress({ scanned, analyzed, skipped, total });
    // Yield event loop so SSE flushes
    await new Promise(r => setImmediate(r));
  }

  db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run('last_scan', Date.now().toString());
  db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run('total_chats', total.toString());

  // GSD scan
  cacheGSDProjects();

  return { total, analyzed, skipped };
}

async function resetAndRescanAsync(onProgress) {
  if (db) db.close();
  if (fs.existsSync(CACHE_DB)) fs.unlinkSync(CACHE_DB);
  for (const suffix of ['-wal', '-shm']) {
    if (fs.existsSync(CACHE_DB + suffix)) fs.unlinkSync(CACHE_DB + suffix);
  }
  initDb();
  return scanAllAsync(onProgress);
}

function getCachedDashboardStats(opts = {}) {
  // Build conditions dynamically to support editor + date range filters
  const conditions = [];
  const params = [];
  const hf = hiddenFolderFilter(opts);
  if (hf.sql) { conditions.push(hf.sql.replace(' AND ', '')); params.push(...hf.params); }
  if (opts.editor) { conditions.push('source = ?'); params.push(opts.editor); }
  if (opts.folder) { conditions.push('folder = ?'); params.push(opts.folder); }
  if (opts.dateFrom) { conditions.push('COALESCE(last_updated_at, created_at) >= ?'); params.push(opts.dateFrom); }
  if (opts.dateTo) { conditions.push('COALESCE(last_updated_at, created_at) <= ?'); params.push(opts.dateTo); }
  const where = conditions.length > 0 ? ' WHERE ' + conditions.join(' AND ') : '';
  const whereAnd = conditions.length > 0 ? ' AND ' + conditions.join(' AND ') : '';

  // ── Hourly distribution (aggregate across all days) ──
  const hourlyRows = db.prepare(`
    SELECT
      CAST(strftime('%H', datetime(COALESCE(last_updated_at, created_at)/1000, 'unixepoch', 'localtime')) AS INTEGER) as hour,
      COUNT(*) as count
    FROM chats
    WHERE (last_updated_at IS NOT NULL OR created_at IS NOT NULL)${whereAnd}
    GROUP BY hour ORDER BY hour
  `).all(...params);
  const hourly = new Array(24).fill(0);
  for (const r of hourlyRows) hourly[r.hour] = r.count;

  // ── Weekday distribution ──
  const weekdayRows = db.prepare(`
    SELECT
      CAST(strftime('%w', datetime(COALESCE(last_updated_at, created_at)/1000, 'unixepoch', 'localtime')) AS INTEGER) as dow,
      COUNT(*) as count
    FROM chats
    WHERE (last_updated_at IS NOT NULL OR created_at IS NOT NULL)${whereAnd}
    GROUP BY dow ORDER BY dow
  `).all(...params);
  const weekdays = new Array(7).fill(0);
  for (const r of weekdayRows) weekdays[r.dow] = r.count;

  // ── Session depth distribution (messages per session) ──
  const depthRows = db.prepare(`
    SELECT cs.total_messages as msgs FROM chat_stats cs
    JOIN chats c ON cs.chat_id = c.id WHERE cs.total_messages > 0${whereAnd}
  `).all(...params);
  const depthBuckets = { '1': 0, '2-5': 0, '6-10': 0, '11-20': 0, '21-50': 0, '51-100': 0, '100+': 0 };
  for (const r of depthRows) {
    const m = r.msgs;
    if (m <= 1) depthBuckets['1']++;
    else if (m <= 5) depthBuckets['2-5']++;
    else if (m <= 10) depthBuckets['6-10']++;
    else if (m <= 20) depthBuckets['11-20']++;
    else if (m <= 50) depthBuckets['21-50']++;
    else if (m <= 100) depthBuckets['51-100']++;
    else depthBuckets['100+']++;
  }

  // ── Token economy ──
  const tokenRow = db.prepare(`
    SELECT
      COALESCE(SUM(cs.total_input_tokens), 0) as input,
      COALESCE(SUM(cs.total_output_tokens), 0) as output,
      COALESCE(SUM(cs.total_cache_read), 0) as cacheRead,
      COALESCE(SUM(cs.total_cache_write), 0) as cacheWrite,
      COALESCE(SUM(cs.total_user_chars), 0) as userChars,
      COALESCE(SUM(cs.total_assistant_chars), 0) as assistantChars,
      COUNT(*) as sessions
    FROM chat_stats cs JOIN chats c ON cs.chat_id = c.id WHERE 1=1${whereAnd}
  `).get(...params);

  // ── Coding streaks ──
  const streakRows = db.prepare(`
    SELECT DISTINCT date(COALESCE(last_updated_at, created_at)/1000, 'unixepoch', 'localtime') as day
    FROM chats WHERE (last_updated_at IS NOT NULL OR created_at IS NOT NULL)${whereAnd}
    ORDER BY day
  `).all(...params);
  let currentStreak = 0, longestStreak = 0, tempStreak = 1;
  const today = new Date().toISOString().split('T')[0];
  for (let i = 1; i < streakRows.length; i++) {
    const prev = new Date(streakRows[i - 1].day);
    const curr = new Date(streakRows[i].day);
    const diff = (curr - prev) / 86400000;
    if (diff === 1) { tempStreak++; }
    else { if (tempStreak > longestStreak) longestStreak = tempStreak; tempStreak = 1; }
  }
  if (tempStreak > longestStreak) longestStreak = tempStreak;
  // Current streak: count backwards from today
  if (streakRows.length > 0) {
    const last = streakRows[streakRows.length - 1].day;
    const lastDate = new Date(last);
    const todayDate = new Date(today);
    const daysDiff = (todayDate - lastDate) / 86400000;
    if (daysDiff <= 1) {
      currentStreak = 1;
      for (let i = streakRows.length - 2; i >= 0; i--) {
        const prev = new Date(streakRows[i].day);
        const curr = new Date(streakRows[i + 1].day);
        if ((curr - prev) / 86400000 === 1) currentStreak++;
        else break;
      }
    }
  }

  // ── Monthly trend by editor ──
  const monthEditorRows = db.prepare(`
    SELECT
      substr(date(COALESCE(last_updated_at, created_at)/1000, 'unixepoch'), 1, 7) as month,
      source,
      COUNT(*) as count
    FROM chats
    WHERE (last_updated_at IS NOT NULL OR created_at IS NOT NULL)${whereAnd}
    GROUP BY month, source ORDER BY month
  `).all(...params);
  const monthEditors = {};
  const allSources = new Set();
  for (const r of monthEditorRows) {
    if (!monthEditors[r.month]) monthEditors[r.month] = {};
    monthEditors[r.month][r.source] = r.count;
    allSources.add(r.source);
  }

  // ── Monthly velocity (avg messages per session per month) ──
  const velocityRows = db.prepare(`
    SELECT
      substr(date(c.last_updated_at/1000, 'unixepoch'), 1, 7) as month,
      AVG(cs.total_messages) as avgMsgs,
      AVG(cs.total_input_tokens + cs.total_output_tokens) as avgTokens
    FROM chat_stats cs JOIN chats c ON cs.chat_id = c.id
    WHERE c.last_updated_at IS NOT NULL${whereAnd}
    GROUP BY month ORDER BY month
  `).all(...params);

  // ── Top models ──
  const modelRows = db.prepare(`
    SELECT cs.models FROM chat_stats cs JOIN chats c ON cs.chat_id = c.id WHERE 1=1${whereAnd}
  `).all(...params);
  const modelFreq = {};
  for (const r of modelRows) {
    try { for (const m of JSON.parse(r.models)) { const k = normalizeModelName(m) || m; modelFreq[k] = (modelFreq[k] || 0) + 1; } } catch { }
  }
  const topModels = Object.entries(modelFreq).sort((a, b) => b[1] - a[1]).slice(0, 10);

  // ── Top tools ──
  const toolRows = db.prepare(`
    SELECT cs.tool_calls FROM chat_stats cs JOIN chats c ON cs.chat_id = c.id WHERE 1=1${whereAnd}
  `).all(...params);
  const toolFreq = {};
  let totalToolCalls = 0;
  for (const r of toolRows) {
    try { for (const t of JSON.parse(r.tool_calls)) { toolFreq[t] = (toolFreq[t] || 0) + 1; totalToolCalls++; } } catch { }
  }
  const topTools = Object.entries(toolFreq).sort((a, b) => b[1] - a[1]).slice(0, 8);

  // If no token data but chars exist, estimate tokens (~4 chars/token)
  let inputTokens = tokenRow.input;
  let outputTokens = tokenRow.output;
  let tokensEstimated = false;
  if (inputTokens === 0 && outputTokens === 0 && (tokenRow.userChars > 0 || tokenRow.assistantChars > 0)) {
    inputTokens = Math.round(tokenRow.userChars / 4);
    outputTokens = Math.round(tokenRow.assistantChars / 4);
    tokensEstimated = true;
  }

  return {
    hourly,
    weekdays,
    depthBuckets,
    tokens: {
      input: inputTokens,
      output: outputTokens,
      cacheRead: tokenRow.cacheRead,
      cacheWrite: tokenRow.cacheWrite,
      userChars: tokenRow.userChars,
      assistantChars: tokenRow.assistantChars,
      sessions: tokenRow.sessions,
      estimated: tokensEstimated,
    },
    streaks: { current: currentStreak, longest: longestStreak, totalDays: streakRows.length },
    monthlyTrend: { months: Object.keys(monthEditors).sort(), sources: [...allSources], data: monthEditors },
    velocity: velocityRows.map(r => ({ month: r.month, avgMsgs: Math.round(r.avgMsgs * 10) / 10, avgTokens: Math.round(r.avgTokens) })),
    topModels: topModels.map(([name, count]) => ({ name, count })),
    topTools: topTools.map(([name, count]) => ({ name, count })),
    totalToolCalls,
  };
}

// ============================================================
// Cost estimation
// ============================================================

function estimateCosts(whereClause = '', params = []) {
  // Per-model token usage from messages table (including cache tokens)
  const modelTokens = db.prepare(`
    SELECT m.model,
           SUM(m.input_tokens) as input, SUM(m.output_tokens) as output,
           SUM(m.cache_read) as cacheRead, SUM(m.cache_write) as cacheWrite
    FROM messages m JOIN chats c ON m.chat_id = c.id
    WHERE m.model IS NOT NULL AND (m.input_tokens > 0 OR m.output_tokens > 0 OR m.cache_read > 0 OR m.cache_write > 0)${whereClause}
    GROUP BY m.model
  `).all(...params);

  // Orphaned tokens: messages with token data but NULL model.
  // Attribute these to the session's dominant model from chat_stats.
  const orphanRows = db.prepare(`
    SELECT m.chat_id,
           SUM(m.input_tokens) as input, SUM(m.output_tokens) as output,
           SUM(m.cache_read) as cacheRead, SUM(m.cache_write) as cacheWrite
    FROM messages m JOIN chats c ON m.chat_id = c.id
    WHERE m.model IS NULL AND (m.input_tokens > 0 OR m.output_tokens > 0 OR m.cache_read > 0 OR m.cache_write > 0)${whereClause}
    GROUP BY m.chat_id
  `).all(...params);

  const orphanByModel = {};
  for (const r of orphanRows) {
    const stat = db.prepare('SELECT models FROM chat_stats WHERE chat_id = ?').get(r.chat_id);
    if (!stat) continue;
    let models;
    try { models = JSON.parse(stat.models || '[]'); } catch { continue; }
    if (models.length === 0) continue;
    const freq = {};
    for (const m of models) freq[m] = (freq[m] || 0) + 1;
    const dominant = Object.entries(freq).sort((a, b) => b[1] - a[1])[0][0];
    if (!orphanByModel[dominant]) orphanByModel[dominant] = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    orphanByModel[dominant].input += r.input || 0;
    orphanByModel[dominant].output += r.output || 0;
    orphanByModel[dominant].cacheRead += r.cacheRead || 0;
    orphanByModel[dominant].cacheWrite += r.cacheWrite || 0;
  }

  // Char-based estimation: sessions with models + chars but zero tokens.
  // Estimate ~4 chars per token (user chars → input, assistant chars → output).
  const CHARS_PER_TOKEN = 4;
  const charRows = db.prepare(`
    SELECT cs.models, cs.total_user_chars as userChars, cs.total_assistant_chars as asstChars
    FROM chat_stats cs JOIN chats c ON cs.chat_id = c.id
    WHERE cs.models != '[]' AND cs.total_input_tokens = 0 AND cs.total_output_tokens = 0
      AND (cs.total_user_chars > 0 OR cs.total_assistant_chars > 0)${whereClause}
  `).all(...params);

  for (const r of charRows) {
    let models;
    try { models = JSON.parse(r.models || '[]'); } catch { continue; }
    if (models.length === 0) continue;
    const freq = {};
    for (const m of models) freq[m] = (freq[m] || 0) + 1;
    const dominant = Object.entries(freq).sort((a, b) => b[1] - a[1])[0][0];
    if (!orphanByModel[dominant]) orphanByModel[dominant] = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    orphanByModel[dominant].input += Math.round((r.userChars || 0) / CHARS_PER_TOKEN);
    orphanByModel[dominant].output += Math.round((r.asstChars || 0) / CHARS_PER_TOKEN);
  }

  // Sessions with token totals but empty models (e.g. Cursor composer chats).
  // Attribute to the dominant model from same editor source.
  const unmodeledRows = db.prepare(`
    SELECT c.source, cs.total_input_tokens as input, cs.total_output_tokens as output,
           cs.total_cache_read as cacheRead, cs.total_cache_write as cacheWrite
    FROM chat_stats cs JOIN chats c ON cs.chat_id = c.id
    WHERE cs.models = '[]' AND (cs.total_input_tokens > 0 OR cs.total_output_tokens > 0)${whereClause}
  `).all(...params);

  if (unmodeledRows.length > 0) {
    // Find dominant model per source from sessions that DO have models
    const sourceModelFreq = {};
    const allSessions = db.prepare(`
      SELECT c.source, cs.models FROM chat_stats cs JOIN chats c ON cs.chat_id = c.id
      WHERE cs.models != '[]'${whereClause}
    `).all(...params);
    for (const s of allSessions) {
      let models;
      try { models = JSON.parse(s.models || '[]'); } catch { continue; }
      if (!sourceModelFreq[s.source]) sourceModelFreq[s.source] = {};
      for (const m of models) sourceModelFreq[s.source][m] = (sourceModelFreq[s.source][m] || 0) + 1;
    }
    // Global fallback: dominant model across all sources
    const globalFreq = {};
    for (const sf of Object.values(sourceModelFreq)) {
      for (const [m, c] of Object.entries(sf)) globalFreq[m] = (globalFreq[m] || 0) + c;
    }
    const globalDominant = Object.entries(globalFreq).sort((a, b) => b[1] - a[1])[0]?.[0];

    for (const r of unmodeledRows) {
      const sf = sourceModelFreq[r.source];
      const dominant = sf
        ? Object.entries(sf).sort((a, b) => b[1] - a[1])[0]?.[0]
        : globalDominant;
      if (!dominant) continue;
      if (!orphanByModel[dominant]) orphanByModel[dominant] = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
      orphanByModel[dominant].input += r.input || 0;
      orphanByModel[dominant].output += r.output || 0;
      orphanByModel[dominant].cacheRead += r.cacheRead || 0;
      orphanByModel[dominant].cacheWrite += r.cacheWrite || 0;
    }
  }

  // Merge modelTokens + orphanByModel into a unified map, normalizing keys
  const tokenMap = {};
  const addTokens = (rawModel, input, output, cacheRead, cacheWrite) => {
    const key = normalizeModelName(rawModel) || rawModel;
    if (!tokenMap[key]) tokenMap[key] = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    tokenMap[key].input += input || 0;
    tokenMap[key].output += output || 0;
    tokenMap[key].cacheRead += cacheRead || 0;
    tokenMap[key].cacheWrite += cacheWrite || 0;
  };
  for (const row of modelTokens) addTokens(row.model, row.input, row.output, row.cacheRead, row.cacheWrite);
  for (const [model, tok] of Object.entries(orphanByModel)) addTokens(model, tok.input, tok.output, tok.cacheRead, tok.cacheWrite);

  let totalCost = 0;
  let unknownModels = [];
  const byModel = [];

  for (const [model, tok] of Object.entries(tokenMap)) {
    const cost = calculateCost(model, tok.input, tok.output, tok.cacheRead, tok.cacheWrite);
    if (cost !== null) {
      totalCost += cost;
      byModel.push({ model, inputTokens: tok.input, outputTokens: tok.output, cacheRead: tok.cacheRead, cacheWrite: tok.cacheWrite, cost });
    } else {
      unknownModels.push(model);
    }
  }

  byModel.sort((a, b) => b.cost - a.cost);
  unknownModels = [...new Set(unknownModels)];

  return { totalCost, byModel, unknownModels };
}

function getCostBreakdown(opts = {}) {
  let whereClause = '';
  const params = [];
  const hf = hiddenFolderFilter(opts, 'c.folder');
  if (hf.sql) { whereClause += hf.sql; params.push(...hf.params); }
  if (opts.editor) { whereClause += ' AND c.source LIKE ?'; params.push(`%${opts.editor}%`); }
  if (opts.folder) { whereClause += ' AND c.folder = ?'; params.push(opts.folder); }
  if (opts.dateFrom) { whereClause += ' AND COALESCE(c.last_updated_at, c.created_at) >= ?'; params.push(opts.dateFrom); }
  if (opts.dateTo) { whereClause += ' AND COALESCE(c.last_updated_at, c.created_at) <= ?'; params.push(opts.dateTo); }
  if (opts.chatId) { whereClause += ' AND c.id = ?'; params.push(opts.chatId); }
  return estimateCosts(whereClause, params);
}

function getCostAnalytics(opts = {}) {
  const conditions = [];
  const params = [];
  const hf = hiddenFolderFilter(opts, 'c.folder');
  if (hf.sql) { conditions.push(hf.sql.replace(' AND ', '')); params.push(...hf.params); }
  if (opts.editor) { conditions.push('c.source LIKE ?'); params.push(`%${opts.editor}%`); }
  if (opts.dateFrom) { conditions.push('COALESCE(c.last_updated_at, c.created_at) >= ?'); params.push(opts.dateFrom); }
  if (opts.dateTo) { conditions.push('COALESCE(c.last_updated_at, c.created_at) <= ?'); params.push(opts.dateTo); }
  if (opts.folder) { conditions.push('c.folder = ?'); params.push(opts.folder); }
  const whereAnd = conditions.length > 0 ? ' AND ' + conditions.join(' AND ') : '';

  // Overall cost breakdown by model
  const overall = getCostBreakdown(opts);

  // Per-chat cost map (single pass — reused for all breakdowns)
  const sessionRows = db.prepare(`
    SELECT c.id, c.source, c.name, c.folder, c.last_updated_at, c.created_at,
      cs.total_messages AS msgs,
      substr(date(COALESCE(c.last_updated_at, c.created_at)/1000, 'unixepoch'), 1, 7) as month
    FROM chats c LEFT JOIN chat_stats cs ON cs.chat_id = c.id
    WHERE 1=1${whereAnd}
  `).all(...params);

  const chatCostCache = new Map();
  for (const r of sessionRows) {
    chatCostCache.set(r.id, getCostBreakdown({ ...opts, chatId: r.id }));
  }

  // Derive byEditor from cached per-chat costs
  const editorAgg = {};
  for (const r of sessionRows) {
    const sc = chatCostCache.get(r.id);
    if (!sc || sc.totalCost <= 0) continue;
    if (!editorAgg[r.source]) editorAgg[r.source] = { cost: 0, models: new Set() };
    editorAgg[r.source].cost += sc.totalCost;
    for (const m of sc.byModel) editorAgg[r.source].models.add(m.model);
  }
  const byEditor = Object.entries(editorAgg)
    .map(([editor, d]) => ({ editor, cost: d.cost, models: d.models.size }))
    .sort((a, b) => b.cost - a.cost);

  // Derive byProject from cached per-chat costs
  const projectAgg = {};
  for (const r of sessionRows) {
    if (!r.folder) continue;
    const sc = chatCostCache.get(r.id);
    if (!sc || sc.totalCost <= 0) continue;
    if (!projectAgg[r.folder]) projectAgg[r.folder] = 0;
    projectAgg[r.folder] += sc.totalCost;
  }
  const byProject = Object.entries(projectAgg)
    .map(([folder, cost]) => ({ folder, name: folder.split('/').pop(), cost }))
    .sort((a, b) => b.cost - a.cost)
    .slice(0, 20);

  // Monthly trend from cached per-chat costs
  const monthCosts = {};
  for (const r of sessionRows) {
    if (!r.month) continue;
    const sc = chatCostCache.get(r.id);
    if (!monthCosts[r.month]) monthCosts[r.month] = { cost: 0, sessions: 0 };
    monthCosts[r.month].cost += sc.totalCost;
    monthCosts[r.month].sessions++;
  }
  const monthly = Object.entries(monthCosts).sort((a, b) => a[0].localeCompare(b[0]))
    .map(([month, d]) => ({ month, cost: Math.round(d.cost * 100) / 100, sessions: d.sessions }));

  // Top expensive sessions from cached per-chat costs
  const sessionCosts = [];
  for (const r of sessionRows) {
    const sc = chatCostCache.get(r.id);
    if (!sc || sc.totalCost <= 0) continue;
    const topModel = sc.byModel.length > 0 ? sc.byModel[0].model : null;
    sessionCosts.push({
      id: r.id, source: r.source, name: r.name, folder: r.folder,
      model: topModel,
      cost: sc.totalCost, messages: r.msgs || 0,
      lastUpdatedAt: r.last_updated_at || r.created_at,
    });
  }
  sessionCosts.sort((a, b) => b.cost - a.cost);

  // Summary stats
  const totalSessions = sessionCosts.length;
  const avgPerSession = totalSessions > 0 ? overall.totalCost / totalSessions : 0;
  const totalDays = monthly.length > 0 ? (() => {
    const first = new Date(monthly[0].month + '-01');
    const last = new Date(monthly[monthly.length - 1].month + '-01');
    return Math.max(1, Math.ceil((last - first) / 86400000) + 30);
  })() : 1;
  const avgPerDay = overall.totalCost / totalDays;

  return {
    totalCost: overall.totalCost,
    byModel: overall.byModel,
    unknownModels: overall.unknownModels,
    byEditor,
    byProject,
    monthly,
    topSessions: sessionCosts.slice(0, 50),
    summary: {
      totalSessions,
      avgPerSession: Math.round(avgPerSession * 100) / 100,
      avgPerDay: Math.round(avgPerDay * 100) / 100,
      totalDays,
    },
  };
}

function getDb() { return db; }

// ============================================================
// GSD cache functions
// ============================================================

const gsd = require('./editors/gsd');

function cacheGSDProjects() {
  // Get all unique known folders from chats table
  const rows = db.prepare('SELECT DISTINCT folder FROM chats WHERE folder IS NOT NULL').all();
  const knownFolders = rows.map(r => r.folder);

  const projects = gsd.getGSDProjects(knownFolders);

  const insProject = db.prepare(`
    INSERT OR REPLACE INTO gsd_projects
      (folder, name, description, milestone, total_phases, completed_phases, active_phase, todos, backlog, notes, last_modified, scanned_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const delPhases = db.prepare('DELETE FROM gsd_phases WHERE folder = ?');
  const insPhase = db.prepare(`
    INSERT OR REPLACE INTO gsd_phases
      (id, folder, phase_number, phase_name, status, total_tasks, completed_tasks, has_plan, has_research, has_verification, last_modified)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const tx = db.transaction(() => {
    for (const p of projects) {
      insProject.run(
        p.folder, p.name, p.description, p.milestone,
        p.totalPhases, p.completedPhases, p.activePhase,
        p.todos, p.backlog, p.notes,
        p.lastModified, Date.now()
      );
      delPhases.run(p.folder);
      const phases = gsd.getGSDPhases(p.folder);
      for (const ph of phases) {
        const id = `${p.folder}::${ph.phaseDir}`;
        insPhase.run(
          id, p.folder, ph.number, ph.name, ph.status,
          ph.tasks.total, ph.tasks.completed,
          ph.hasPlan ? 1 : 0,
          ph.hasResearch ? 1 : 0,
          ph.hasVerification ? 1 : 0,
          ph.lastModified
        );
      }
    }
  });
  tx();
}

function getCachedGSDProjects() {
  const projects = db.prepare('SELECT * FROM gsd_projects ORDER BY last_modified DESC').all();
  for (const p of projects) {
    try {
      const phases = getGSDPhaseTokens(p.folder);
      p.total_cost = phases.reduce((s, r) => s + (r.cost || 0), 0);
    } catch {
      p.total_cost = 0;
    }
  }
  return projects;
}

function getCachedGSDPhases(folder) {
  return db.prepare('SELECT * FROM gsd_phases WHERE folder = ? ORDER BY phase_number ASC').all(folder);
}

function getGSDPhaseTokens(folder) {
  const phases = db.prepare(
    'SELECT id, phase_number, phase_name, status, last_modified FROM gsd_phases WHERE folder = ? ORDER BY phase_number ASC'
  ).all(folder);

  if (phases.length === 0) return [];

  // Sort by last_modified to build sequential non-overlapping time windows.
  // Phases with no last_modified are placed at the end.
  const byTime = [...phases]
    .filter(p => p.last_modified)
    .sort((a, b) => a.last_modified - b.last_modified);

  const windowMap = new Map();
  for (let i = 0; i < byTime.length; i++) {
    const start = i === 0 ? 0 : byTime[i - 1].last_modified;
    const end = i === byTime.length - 1 ? Date.now() : byTime[i].last_modified;
    windowMap.set(byTime[i].id, { start, end });
  }

  const stmt = db.prepare(`
    SELECT cs.total_input_tokens, cs.total_output_tokens,
           cs.total_cache_read, cs.total_cache_write, cs.models
    FROM chats c JOIN chat_stats cs ON cs.chat_id = c.id
    WHERE c.folder = ? AND COALESCE(c.last_updated_at, c.created_at) BETWEEN ? AND ?
  `);

  return phases.map(ph => {
    const win = windowMap.get(ph.id);
    let totalInput = 0, totalOutput = 0, totalCacheRead = 0, totalCacheWrite = 0;
    let sessionCount = 0;
    const modelFreq = {};

    if (win) {
      const rows = stmt.all(folder, win.start, win.end);
      for (const row of rows) {
        totalInput += row.total_input_tokens || 0;
        totalOutput += row.total_output_tokens || 0;
        totalCacheRead += row.total_cache_read || 0;
        totalCacheWrite += row.total_cache_write || 0;
        sessionCount++;
        try {
          const models = JSON.parse(row.models || '[]');
          for (const m of models) {
            const key = typeof m === 'string' ? m : (m && m.model);
            if (key) modelFreq[key] = (modelFreq[key] || 0) + 1;
          }
        } catch { /* skip */ }
      }
    }

    const dominantModel = Object.entries(modelFreq).sort((a, b) => b[1] - a[1])[0]?.[0] || null;
    const cost = dominantModel
      ? (calculateCost(dominantModel, totalInput, totalOutput, totalCacheRead, totalCacheWrite) || 0)
      : 0;
    const totalTokens = totalInput + totalOutput;

    return {
      id: ph.id,
      phase_number: ph.phase_number,
      phase_name: ph.phase_name,
      status: ph.status,
      total_tokens: totalTokens,
      cost,
      session_count: sessionCount,
    };
  });
}

function getCachedGSDOverview() {
  const projects = getCachedGSDProjects();
  const totalProjects = projects.length;
  const totalPhases = projects.reduce((s, p) => s + p.total_phases, 0);
  const completedPhases = projects.reduce((s, p) => s + p.completed_phases, 0);
  const activePhases = projects
    .filter(p => p.active_phase)
    .map(p => ({ folder: p.folder, name: p.name, activePhase: p.active_phase }));
  const executingPhases = db.prepare("SELECT COUNT(*) as c FROM gsd_phases WHERE status = 'executing'").get().c;
  const plannedPhases = db.prepare("SELECT COUNT(*) as c FROM gsd_phases WHERE status = 'planned'").get().c;
  return { totalProjects, totalPhases, completedPhases, activePhases, executingPhases, plannedPhases };
}

module.exports = {
  initDb,
  scanAll,
  scanAllAsync,
  getCachedChats,
  countCachedChats,
  getCachedOverview,
  getCachedDailyActivity,
  getCachedDeepAnalytics,
  getCachedChat,
  getCachedProjects,
  getCachedToolCalls,
  resetAndRescanAsync,
  getCachedDashboardStats,
  getCostBreakdown,
  getCostAnalytics,
  getDb,
  cacheGSDProjects,
  getCachedGSDProjects,
  getCachedGSDPhases,
  getCachedGSDOverview,
  getGSDPhaseTokens,
};
