const path = require('path');
const fs = require('fs');
const os = require('os');
const { execSync } = require('child_process');

const DB_PATH = path.join(os.homedir(), '.local', 'share', 'opencode', 'opencode.db');

// ============================================================
// Query SQLite via CLI
// ============================================================

function queryDb(sql) {
  if (!fs.existsSync(DB_PATH)) return [];
  try {
    const raw = execSync(
      `sqlite3 -json ${JSON.stringify(DB_PATH)} ${JSON.stringify(sql)}`,
      { encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'] }
    );
    return JSON.parse(raw);
  } catch { return []; }
}

// ============================================================
// Adapter interface
// ============================================================

const name = 'opencode';

function getChats() {
  const rows = queryDb('SELECT s.id, s.title, s.directory, s.time_created, s.time_updated, p.worktree, p.name as project_name, (SELECT count(*) FROM message m WHERE m.session_id = s.id) as msg_count FROM session s LEFT JOIN project p ON s.project_id = p.id ORDER BY s.time_updated DESC');

  return rows.map(row => ({
    source: 'opencode',
    composerId: row.id,
    name: cleanTitle(row.title),
    createdAt: row.time_created,
    lastUpdatedAt: row.time_updated,
    mode: 'opencode',
    folder: row.worktree || row.directory || null,
    encrypted: false,
    bubbleCount: row.msg_count || 0,
  }));
}

function cleanTitle(title) {
  if (!title) return null;
  // Strip default "New session - <date>" titles
  if (title.startsWith('New session - ')) return null;
  return title.substring(0, 120) || null;
}

function getMessages(chat) {
  // Get messages with their parts joined
  const messages = queryDb(`SELECT m.id as msg_id, m.data as msg_data, m.time_created FROM message m WHERE m.session_id = '${chat.composerId}' ORDER BY m.time_created ASC`);

  const result = [];
  for (const msg of messages) {
    let msgData;
    try { msgData = JSON.parse(msg.msg_data); } catch { continue; }

    const role = msgData.role;
    if (!role) continue;

    // Get parts for this message
    const parts = queryDb(`SELECT data FROM part WHERE message_id = '${msg.msg_id}' ORDER BY time_created ASC`);

    const contentParts = [];
    for (const part of parts) {
      let partData;
      try { partData = JSON.parse(part.data); } catch { continue; }

      if (partData.type === 'text' && partData.text) {
        contentParts.push(partData.text);
      } else if (partData.type === 'tool-use' || partData.type === 'tool_use') {
        const toolName = partData.name || partData.toolName || 'tool';
        let argKeys = '';
        try {
          const input = typeof partData.input === 'string' ? JSON.parse(partData.input) : (partData.input || {});
          argKeys = Object.keys(input).join(', ');
        } catch {}
        contentParts.push(`[tool-call: ${toolName}(${argKeys})]`);
      } else if (partData.type === 'tool-result' || partData.type === 'tool_result') {
        const preview = (partData.text || partData.output || '').substring(0, 500);
        contentParts.push(`[tool-result] ${preview}`);
      }
      // Skip step-start, step-finish (metadata only)
    }

    const content = contentParts.join('\n');
    if (!content) continue;

    const mappedRole = role === 'user' ? 'user' : role === 'assistant' ? 'assistant' : role;
    result.push({
      role: mappedRole,
      content,
      _model: msgData.model?.modelID,
    });
  }

  return result;
}

module.exports = { name, getChats, getMessages };
