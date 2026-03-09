const path = require('path');
const fs = require('fs');
const os = require('os');

const Database = require('better-sqlite3');

// Zed stores data in different locations depending on the platform
// - Windows: %LOCALAPPDATA%\Zed (not Roaming)
// - macOS: ~/Library/Application Support/Zed
// - Linux: ~/.config/Zed
function getZedDataPath() {
  const home = os.homedir();
  switch (process.platform) {
    case 'win32':
      return path.join(home, 'AppData', 'Local', 'Zed');
    case 'darwin':
      return path.join(home, 'Library', 'Application Support', 'Zed');
    default: // linux, etc.
      return path.join(home, '.config', 'Zed');
  }
}

const THREADS_DB = path.join(getZedDataPath(), 'threads', 'threads.db');

// ============================================================
// Decompress zstd blob via CLI (with cross-platform support)
// ============================================================

function decompressZstd(buf) {
  const tmpIn = path.join(os.tmpdir(), `zed_thread_${Date.now()}.zst`);
  const tmpOut = tmpIn.replace('.zst', '.json');
  try {
    fs.writeFileSync(tmpIn, buf);

    // Try zstd CLI first
    try {
      const { execFileSync } = require('child_process');
      const zstdCmd = process.platform === 'win32' ? 'zstd.exe' : 'zstd';
      execFileSync(zstdCmd, ['-d', '-f', '-q', tmpIn, '-o', tmpOut], { stdio: ['pipe', 'pipe', 'pipe'] });
    } catch {
      // Fallback: try using Node.js zstd library if available
      try {
        const zlib = require('zlib');
        // Check if Node version supports zstd natively (v22+)
        if (zlib.createZstdDecompress) {
          const decompressed = zlib.zstdDecompressSync(buf);
          fs.writeFileSync(tmpOut, decompressed);
        } else {
          throw new Error('zstd not available');
        }
      } catch {
        throw new Error('zstd decompression not available on this system');
      }
    }

    const data = fs.readFileSync(tmpOut, 'utf-8');
    return data;
  } finally {
    try { fs.unlinkSync(tmpIn); } catch {}
    try { fs.unlinkSync(tmpOut); } catch {}
  }
}

// ============================================================
// Query SQLite using better-sqlite3 (cross-platform)
// ============================================================

function queryDb(sql) {
  if (!fs.existsSync(THREADS_DB)) return [];
  try {
    const db = new Database(THREADS_DB, { readonly: true });
    const rows = db.prepare(sql).all();
    db.close();
    return rows;
  } catch (e) {
    // Silently fail if database is locked or inaccessible
    return [];
  }
}

function queryBlob(id) {
  if (!fs.existsSync(THREADS_DB)) return null;
  try {
    const db = new Database(THREADS_DB, { readonly: true });
    const row = db.prepare('SELECT data FROM threads WHERE id = ?').get(id);
    db.close();
    return row ? row.data : null;
  } catch {
    return null;
  }
}

// ============================================================
// Adapter interface
// ============================================================

const name = 'zed';

function getChats() {
  const rows = queryDb(
    'SELECT id, summary, updated_at, data_type, length(data) as data_size, parent_id, worktree_branch FROM threads ORDER BY updated_at DESC'
  );

  return rows.map(row => ({
    source: 'zed',
    composerId: row.id,
    name: row.summary || null,
    createdAt: row.updated_at ? new Date(row.updated_at).getTime() : null,
    lastUpdatedAt: row.updated_at ? new Date(row.updated_at).getTime() : null,
    mode: 'thread',
    folder: null,
    encrypted: false,
    bubbleCount: 0,
    _dataType: row.data_type,
    _gitBranch: row.worktree_branch,
  }));
}

function getMessages(chat) {
  const blob = queryBlob(chat.composerId);
  if (!blob) return [];

  let json;
  const dataType = chat._dataType || 'zstd';
  try {
    if (dataType === 'zstd') {
      json = decompressZstd(blob);
    } else {
      json = blob.toString('utf-8');
    }
  } catch (e) {
    // Decompression failed - zstd CLI not available
    return [];
  }

  let data;
  try { data = JSON.parse(json); } catch { return []; }

  const model = data.model?.model || null;
  const messages = [];
  for (const msg of data.messages || []) {
    if (msg.User) {
      const { text } = extractContent(msg.User.content);
      if (text) messages.push({ role: 'user', content: text });
    } else if (msg.Agent) {
      const { text, toolCalls } = extractContent(msg.Agent.content);
      if (text) messages.push({ role: 'assistant', content: text, _model: model, _toolCalls: toolCalls });
    }
  }
  return messages;
}

function extractContent(content) {
  if (!Array.isArray(content)) return { text: '', toolCalls: [] };
  const parts = [];
  const toolCalls = [];
  for (const block of content) {
    if (block.Text) {
      parts.push(block.Text);
    } else if (block.ToolUse) {
      const tu = block.ToolUse;
      let args = {};
      try {
        args = typeof tu.input === 'string' ? JSON.parse(tu.input) : (tu.input || {});
      } catch {}
      const argKeys = typeof args === 'object' ? Object.keys(args).join(', ') : '';
      parts.push(`[tool-call: ${tu.name || 'tool'}(${argKeys})]`);
      toolCalls.push({ name: tu.name || 'tool', args });
    } else if (block.ToolResult) {
      const tr = block.ToolResult;
      const preview = (tr.content || tr.output || '').substring(0, 500);
      parts.push(`[tool-result: ${tr.tool_use_id || 'tool'}] ${preview}`);
    } else if (block.Thinking) {
      const text = typeof block.Thinking === 'string' ? block.Thinking : (block.Thinking.text || '');
      if (text) parts.push(`[thinking] ${text}`);
    }
  }
  return { text: parts.join('\n') || '', toolCalls };
}

const labels = { 'zed': 'Zed' };

module.exports = { name, labels, getChats, getMessages };
