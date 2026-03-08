const path = require('path');
const fs = require('fs');
const os = require('os');
const { execSync } = require('child_process');
const { getAppDataPath } = require('./base');

const THREADS_DB = path.join(getAppDataPath('Zed'), 'threads', 'threads.db');

// ============================================================
// Decompress zstd blob via CLI
// ============================================================

function decompressZstd(buf) {
  const tmpIn = path.join(os.tmpdir(), `zed_thread_${Date.now()}.zst`);
  const tmpOut = tmpIn.replace('.zst', '.json');
  try {
    fs.writeFileSync(tmpIn, buf);
    execSync(`zstd -d -f -q ${JSON.stringify(tmpIn)} -o ${JSON.stringify(tmpOut)}`, { stdio: ['pipe', 'pipe', 'pipe'] });
    const data = fs.readFileSync(tmpOut, 'utf-8');
    return data;
  } finally {
    try { fs.unlinkSync(tmpIn); } catch {}
    try { fs.unlinkSync(tmpOut); } catch {}
  }
}

// ============================================================
// Query SQLite via CLI (avoids native module dependency)
// ============================================================

function queryDb(sql) {
  if (!fs.existsSync(THREADS_DB)) return [];
  try {
    const raw = execSync(
      `sqlite3 -json ${JSON.stringify(THREADS_DB)} ${JSON.stringify(sql)}`,
      { encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'] }
    );
    return JSON.parse(raw);
  } catch { return []; }
}

function queryBlobHex(id) {
  if (!fs.existsSync(THREADS_DB)) return null;
  try {
    const hex = execSync(
      `sqlite3 ${JSON.stringify(THREADS_DB)} "SELECT hex(data) FROM threads WHERE id = '${id}'"`,
      { encoding: 'utf-8', maxBuffer: 50 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'] }
    ).trim();
    if (!hex) return null;
    return Buffer.from(hex, 'hex');
  } catch { return null; }
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
    _dataType: row.data_type,
    _gitBranch: row.worktree_branch,
  }));
}

function getMessages(chat) {
  const blob = queryBlobHex(chat.composerId);
  if (!blob) return [];

  let json;
  const dataType = chat._dataType || 'zstd';
  try {
    if (dataType === 'zstd') {
      json = decompressZstd(blob);
    } else {
      json = blob.toString('utf-8');
    }
  } catch { return []; }

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

module.exports = { name, getChats, getMessages };
