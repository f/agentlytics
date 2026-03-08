const chalk = require('chalk');
const http = require('http');
const readline = require('readline');
const crypto = require('crypto');

const cache = require('./cache');

const SYNC_INTERVAL_MS = 30000; // 30 seconds

const EDITOR_LABELS = {
  'cursor': 'Cursor',
  'windsurf': 'Windsurf',
  'windsurf-next': 'Windsurf Next',
  'antigravity': 'Antigravity',
  'claude-code': 'Claude Code',
  'claude': 'Claude Code',
  'vscode': 'VS Code',
  'vscode-insiders': 'VS Code Insiders',
  'zed': 'Zed',
  'opencode': 'OpenCode',
  'codex': 'Codex CLI',
  'gemini-cli': 'Gemini CLI',
  'copilot-cli': 'Copilot CLI',
  'cursor-agent': 'Cursor (Background Agent)',
  'commandcode': 'CommandCode',
};

/**
 * Interactive project picker using readline (no external deps beyond Node built-ins).
 * Returns an array of selected folder paths.
 */
async function pickProjects() {
  cache.initDb();

  // Scan to populate cache
  console.log(chalk.dim('  Scanning local sessions...'));
  cache.scanAll(() => {});

  const db = cache.getDb();
  const projects = db.prepare(`
    SELECT folder, COUNT(*) as count
    FROM chats WHERE folder IS NOT NULL
    GROUP BY folder ORDER BY count DESC
  `).all();

  if (projects.length === 0) {
    console.log(chalk.yellow('  No projects found in local cache.'));
    process.exit(1);
  }

  const cwd = process.cwd();
  const cwdMatch = projects.find(p => p.folder === cwd);

  // If cwd is a known project, offer quick share
  if (cwdMatch) {
    const name = cwdMatch.folder.split('/').pop();
    const editors = db.prepare(`
      SELECT source, COUNT(*) as count FROM chats
      WHERE folder = ? AND source IS NOT NULL
      GROUP BY source ORDER BY count DESC
    `).all(cwdMatch.folder);
    console.log('');
    console.log(chalk.cyan(`    ${name}`) + chalk.dim(` — ${cwdMatch.count} sessions`));
    for (const e of editors) {
      console.log(chalk.yellow(`      • ${EDITOR_LABELS[e.source] || e.source}`) + chalk.dim(` (${e.count} sessions)`));
    }
    console.log('');

    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const answer = await new Promise(r => {
      rl.question(chalk.bold('  Share your sessions with your team? ') + chalk.dim('(Y/n) '), r);
    });
    rl.close();

    const trimmed = answer.trim().toLowerCase();
    if (trimmed === '' || trimmed === 'y' || trimmed === 'yes') {
      return [cwdMatch.folder];
    }
    // Fall through to full picker
  }

  console.log('');
  console.log(chalk.bold('  Select projects to share (comma-separated numbers, or "all"):'));
  console.log('');
  projects.forEach((p, i) => {
    const name = p.folder.split('/').pop();
    console.log(chalk.cyan(`  ${i + 1}.`) + ` ${name} ${chalk.dim(`(${p.count} sessions) — ${p.folder}`)}`);
  });
  console.log('');

  const rl2 = readline.createInterface({ input: process.stdin, output: process.stdout });

  return new Promise((resolve) => {
    rl2.question(chalk.bold('  > '), (answer) => {
      rl2.close();
      const trimmed = answer.trim().toLowerCase();
      if (trimmed === 'all' || trimmed === '*') {
        resolve(projects.map(p => p.folder));
        return;
      }
      const indices = trimmed.split(/[,\s]+/).map(s => parseInt(s.trim()) - 1).filter(i => i >= 0 && i < projects.length);
      if (indices.length === 0) {
        console.log(chalk.red('  No valid selection. Exiting.'));
        process.exit(1);
      }
      resolve(indices.map(i => projects[i].folder));
    });
  });
}

/**
 * Collect data for selected projects from local cache DB.
 */
function collectProjectData(selectedFolders) {
  const db = cache.getDb();
  if (!db) return { chats: [], messages: [], stats: [] };

  const allChats = [];
  const allMessages = [];
  const allStats = [];

  for (const folder of selectedFolders) {
    // Get chats for this project
    const chats = db.prepare(`
      SELECT id, source, name, mode, folder, created_at, last_updated_at, bubble_count
      FROM chats WHERE folder = ?
    `).all(folder);

    for (const chat of chats) {
      allChats.push({
        id: chat.id,
        source: chat.source,
        name: chat.name,
        mode: chat.mode,
        folder: chat.folder,
        created_at: chat.created_at,
        last_updated_at: chat.last_updated_at,
        bubble_count: chat.bubble_count,
      });

      // Get messages
      const messages = db.prepare(
        'SELECT chat_id, seq, role, content, model FROM messages WHERE chat_id = ? ORDER BY seq'
      ).all(chat.id);
      for (const m of messages) {
        allMessages.push({
          chat_id: m.chat_id,
          seq: m.seq,
          role: m.role,
          content: m.content,
          model: m.model,
        });
      }

      // Get stats
      const stat = db.prepare(
        'SELECT * FROM chat_stats WHERE chat_id = ?'
      ).get(chat.id);
      if (stat) {
        allStats.push({
          chat_id: stat.chat_id,
          total_messages: stat.total_messages,
          user_messages: stat.user_messages,
          assistant_messages: stat.assistant_messages,
          tool_calls: JSON.parse(stat.tool_calls || '[]'),
          models: JSON.parse(stat.models || '[]'),
          total_input_tokens: stat.total_input_tokens,
          total_output_tokens: stat.total_output_tokens,
        });
      }
    }
  }

  return { chats: allChats, messages: allMessages, stats: allStats };
}

/**
 * POST data to relay server.
 */
function postToRelay(host, port, username, data, authToken) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({
      username,
      projects: data.projects,
      chats: data.chats,
      messages: data.messages,
      stats: data.stats,
    });

    const headers = {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(payload),
    };
    if (authToken) headers['Authorization'] = `Bearer ${authToken}`;

    const options = {
      hostname: host,
      port: port,
      path: '/relay/sync',
      method: 'POST',
      headers,
    };

    const req = http.request(options, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        try {
          resolve(JSON.parse(body));
        } catch {
          resolve({ raw: body });
        }
      });
    });

    req.on('error', reject);
    req.setTimeout(15000, () => {
      req.destroy(new Error('Request timed out'));
    });
    req.write(payload);
    req.end();
  });
}

/**
 * Main join client entry point.
 */
async function startJoinClient(relayAddress, username) {
  console.log('');
  console.log(chalk.bold('  ⚡ Agentlytics Relay — Join'));
  console.log(chalk.dim(`  Connecting to relay at ${relayAddress}`));
  console.log(chalk.dim(`  Username: ${username}`));
  console.log('');

  // Parse host:port
  const parts = relayAddress.replace(/^https?:\/\//, '').split(':');
  const host = parts[0] || 'localhost';
  const port = parseInt(parts[1]) || 4638;

  // Auth token from RELAY_PASSWORD env
  const relayPassword = process.env.RELAY_PASSWORD || null;
  const authToken = relayPassword
    ? crypto.createHmac('sha256', 'agentlytics-relay').update(relayPassword).digest('hex')
    : null;

  // Test connection
  try {
    const testResult = await postToRelay(host, port, username, { projects: [], chats: [], messages: [], stats: [] }, authToken);
    if (!testResult.ok) {
      const msg = testResult.error || 'unknown error';
      if (msg === 'Unauthorized') {
        console.log(chalk.red('  ✗ Relay requires a password. Set RELAY_PASSWORD env variable.'));
      } else {
        console.log(chalk.red(`  ✗ Failed to connect: ${msg}`));
      }
      process.exit(1);
    }
    console.log(chalk.green('  ✓ Connected to relay'));
  } catch (err) {
    console.log(chalk.red(`  ✗ Cannot reach relay at ${host}:${port}`));
    console.log(chalk.dim(`    ${err.message}`));
    process.exit(1);
  }

  // Pick projects
  const selectedFolders = await pickProjects();
  console.log('');
  console.log(chalk.green(`  ✓ Sharing ${selectedFolders.length} project(s):`));
  for (const f of selectedFolders) {
    console.log(chalk.dim(`    • ${f.split('/').pop()} — ${f}`));
  }
  console.log('');

  // Initial sync
  async function sync() {
    try {
      // Rescan editors to pick up new/updated sessions (reset caches so fresh LS data is obtained)
      cache.scanAll(() => {}, { resetCaches: true });
      const data = collectProjectData(selectedFolders);
      data.projects = selectedFolders;
      const result = await postToRelay(host, port, username, data, authToken);
      if (result.ok) {
        const s = result.synced || {};
        process.stdout.write(chalk.dim(`\r  ⟳ Synced: ${s.chats || 0} chats, ${s.messages || 0} messages — ${new Date().toLocaleTimeString()}    `));
      } else {
        process.stdout.write(chalk.yellow(`\r  ⚠ Sync issue: ${result.error || 'unknown'}    `));
      }
    } catch (err) {
      process.stdout.write(chalk.red(`\r  ✗ Sync failed: ${err.message}    `));
    }
  }

  console.log(chalk.cyan(`  ⟳ Syncing every ${SYNC_INTERVAL_MS / 1000}s (Ctrl+C to stop)`));
  console.log('');

  // Do first sync immediately
  await sync();

  // Then sync periodically
  setInterval(sync, SYNC_INTERVAL_MS);
}

module.exports = { startJoinClient };
