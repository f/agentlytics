const Database = require('better-sqlite3');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { getAllChats, getMessages, resetCaches } = require('./editors');

const CACHE_DIR = path.join(os.homedir(), '.agentlytics');
const CACHE_DB = path.join(CACHE_DIR, 'cache.db');

/**
 * Normalize folder paths so that case-insensitive duplicates (common on Windows)
 * are stored as a single canonical entry.
 *
 * On Windows (NTFS is case-insensitive):
 *   1. Normalize separators (forward→back) and resolve `.` / `..`
 *   2. Try fs.realpathSync.native to get true on-disk casing
 *   3. Fallback: uppercase drive letter + lowercase rest (since NTFS is CI)
 *   4. Strip trailing separator
 *
 * On macOS/Linux: use realpathSync for symlink resolution, otherwise as-is.
 */
function normalizeFolder(folder) {
  if (!folder) return null;

  // Strip file:// prefix some editors add
  if (folder.startsWith('file://')) folder = folder.slice(7);

  if (process.platform === 'win32') {
    // Canonical separators and resolve relative segments
    folder = path.resolve(folder);

    // Try to get true on-disk casing via native realpath
    try {
      folder = fs.realpathSync.native(folder);
    } catch {
      // Path doesn't exist — normalize deterministically:
      // uppercase drive letter, lowercase everything else
      if (/^[a-zA-Z]:/.test(folder)) {
        folder = folder[0].toUpperCase() + folder.slice(1).toLowerCase();
      }
    }

    // Strip trailing backslash (but keep "D:\")
    if (folder.length > 3 && folder.endsWith('\\')) folder = folder.slice(0, -1);

    // Use forward slashes for consistent API output across platforms
    return folder.replace(/\\/g, '/');
  }

  // macOS / Linux: resolve symlinks via realpathSync
  try {
    return fs.realpathSync(folder);
  } catch {
    return folder;
  }
}

let db = null;

// ============================================================
// Schema
// ============================================================

function initDb() {
  if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
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
  `);

  // ── One-time migration v2: full path normalization for Windows ──
  // Replaces v1 (drive-letter-only) with full case + separator normalization
  const migV2 = db.prepare("SELECT value FROM meta WHERE key = 'folder_norm_v'").get();
  if (!migV2 || migV2.value < '2') {
    if (process.platform === 'win32') {
      // Re-normalize every folder via JS (SQL can't do realpathSync)
      const chatFolders = db.prepare("SELECT id, folder FROM chats WHERE folder IS NOT NULL").all();
      const updChat = db.prepare("UPDATE chats SET folder = ? WHERE id = ?");
      const tcFolders = db.prepare("SELECT id, folder FROM tool_calls WHERE folder IS NOT NULL").all();
      const updTc = db.prepare("UPDATE tool_calls SET folder = ? WHERE id = ?");

      const migrateFolders = db.transaction(() => {
        for (const row of chatFolders) updChat.run(normalizeFolder(row.folder), row.id);
        for (const row of tcFolders) updTc.run(normalizeFolder(row.folder), row.id);
      });
      migrateFolders();
    }
    db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('folder_norm_v', '2')").run();
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
  INSERT INTO messages (chat_id, seq, role, content, model, input_tokens, output_tokens)
  VALUES (?, ?, ?, ?, ?, ?, ?)
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
          } catch {}
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
    ins.run(chat.composerId, seq++, msg.role, storedContent, msg._model || null, msg._inputTokens || null, msg._outputTokens || null);
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
  // Normalize folder paths so case-insensitive duplicates merge (Windows drive letters etc.)
  for (const chat of chats) chat.folder = normalizeFolder(chat.folder);
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

  return { total, analyzed, skipped };
}

// ============================================================
// Query helpers (used by server.js)
// ============================================================

function getCachedChats(opts = {}) {
  let sql = 'SELECT c.*, cs.models AS _models FROM chats c LEFT JOIN chat_stats cs ON cs.chat_id = c.id WHERE 1=1';
  const params = [];
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
    } catch {}
    delete r._models;
  }
  return rows;
}

function countCachedChats(opts = {}) {
  let sql = 'SELECT COUNT(*) as cnt FROM chats WHERE 1=1';
  const params = [];
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
  if (opts.editor) { conditions.push('source = ?'); params.push(opts.editor); }
  if (opts.dateFrom) { conditions.push('COALESCE(last_updated_at, created_at) >= ?'); params.push(opts.dateFrom); }
  if (opts.dateTo) { conditions.push('COALESCE(last_updated_at, created_at) <= ?'); params.push(opts.dateTo); }
  const where = conditions.length > 0 ? ' WHERE ' + conditions.join(' AND ') : '';
  const whereAnd = conditions.length > 0 ? ' AND ' + conditions.join(' AND ') : '';

  const totalChats = db.prepare(`SELECT COUNT(*) as cnt FROM chats${where}`).get(...params).cnt;
  // Editors list is always unfiltered so the breakdown remains visible
  const editors = db.prepare('SELECT source, COUNT(*) as count FROM chats GROUP BY source ORDER BY count DESC').all();

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
    } catch {}
    try {
      const models = JSON.parse(r.models);
      for (const m of models) { modelFreq[m] = (modelFreq[m] || 0) + 1; }
    } catch {}
  }

  return {
    analyzedChats: rows.length,
    totalMessages, totalToolCalls,
    totalUserChars, totalAssistantChars,
    totalInputTokens, totalOutputTokens,
    totalCacheRead, totalCacheWrite,
    topTools: Object.entries(toolFreq).sort((a, b) => b[1] - a[1]).slice(0, 30).map(([name, count]) => ({ name, count })),
    topModels: Object.entries(modelFreq).sort((a, b) => b[1] - a[1]).slice(0, 20).map(([name, count]) => ({ name, count })),
  };
}

function getCachedChat(id) {
  const chat = db.prepare('SELECT * FROM chats WHERE id LIKE ?').get(id + '%');
  if (!chat) return null;

  const stats = db.prepare('SELECT * FROM chat_stats WHERE chat_id = ?').get(chat.id);
  const messages = db.prepare('SELECT role, content, model, input_tokens, output_tokens FROM messages WHERE chat_id = ? ORDER BY seq').all(chat.id);

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
      try { for (const m of JSON.parse(s.models)) { modelFreq[m] = (modelFreq[m] || 0) + 1; } } catch {}
      try { for (const t of JSON.parse(s.tool_calls)) { toolFreq[t] = (toolFreq[t] || 0) + 1; totalToolCalls++; } } catch {}
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
      totalOutputTokens,
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
async function scanAllAsync(onProgress) {
  const chats = getAllChats();
  for (const chat of chats) chat.folder = normalizeFolder(chat.folder);
  const total = chats.length;
  let scanned = 0;
  let analyzed = 0;
  let skipped = 0;

  const existing = {};
  for (const row of db.prepare('SELECT id, last_updated_at FROM chats').all()) {
    existing[row.id] = row.last_updated_at;
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
  batchInsert(chats);

  if (onProgress) onProgress({ scanned: 0, analyzed: 0, skipped: 0, total });

  for (const chat of chats) {
    scanned++;
    const cachedTs = existing[chat.composerId];
    const chatTs = chat.lastUpdatedAt || chat.createdAt || 0;

    if (cachedTs && cachedTs >= chatTs) {
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
  if (opts.editor) { conditions.push('source = ?'); params.push(opts.editor); }
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
    try { for (const m of JSON.parse(r.models)) modelFreq[m] = (modelFreq[m] || 0) + 1; } catch {}
  }
  const topModels = Object.entries(modelFreq).sort((a, b) => b[1] - a[1]).slice(0, 10);

  // ── Top tools ──
  const toolRows = db.prepare(`
    SELECT cs.tool_calls FROM chat_stats cs JOIN chats c ON cs.chat_id = c.id WHERE 1=1${whereAnd}
  `).all(...params);
  const toolFreq = {};
  let totalToolCalls = 0;
  for (const r of toolRows) {
    try { for (const t of JSON.parse(r.tool_calls)) { toolFreq[t] = (toolFreq[t] || 0) + 1; totalToolCalls++; } } catch {}
  }
  const topTools = Object.entries(toolFreq).sort((a, b) => b[1] - a[1]).slice(0, 8);

  return {
    hourly,
    weekdays,
    depthBuckets,
    tokens: {
      input: tokenRow.input,
      output: tokenRow.output,
      cacheRead: tokenRow.cacheRead,
      cacheWrite: tokenRow.cacheWrite,
      userChars: tokenRow.userChars,
      assistantChars: tokenRow.assistantChars,
      sessions: tokenRow.sessions,
    },
    streaks: { current: currentStreak, longest: longestStreak, totalDays: streakRows.length },
    monthlyTrend: { months: Object.keys(monthEditors).sort(), sources: [...allSources], data: monthEditors },
    velocity: velocityRows.map(r => ({ month: r.month, avgMsgs: Math.round(r.avgMsgs * 10) / 10, avgTokens: Math.round(r.avgTokens) })),
    topModels: topModels.map(([name, count]) => ({ name, count })),
    topTools: topTools.map(([name, count]) => ({ name, count })),
    totalToolCalls,
  };
}

function getDb() { return db; }

module.exports = {
  initDb,
  scanAll,
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
  getDb,
};
