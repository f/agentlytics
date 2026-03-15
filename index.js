#!/usr/bin/env node

const chalk = require('chalk');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');

// ── Node.js version check ─────────────────────────────────
const nodeVersion = process.versions.node;
const [nodeMajor, nodeMinor] = nodeVersion.split('.').map(Number);
const isNodeSupported =
  (nodeMajor === 20 && nodeMinor >= 19) ||
  (nodeMajor === 22 && nodeMinor >= 12) ||
  nodeMajor === 23 || nodeMajor === 24 || nodeMajor >= 25;

if (!isNodeSupported) {
  console.error('');
  console.error(`  \x1b[31m✗ Unsupported Node.js version: v${nodeVersion}\x1b[0m`);
  console.error('');
  console.error(`  \x1b[1mAgentlytics requires Node.js 20.19+ or 22.12+\x1b[0m`);
  console.error(`  \x1b[2mYour current version: v${nodeVersion}\x1b[0m`);
  console.error('');
  console.error(`  \x1b[2mTo upgrade, visit: https://nodejs.org\x1b[0m`);
  console.error(`  \x1b[2mOr use a version manager: nvm install 22\x1b[0m`);
  console.error('');
  process.exit(1);
}

const HOME = os.homedir();
const PORT = process.env.PORT || 4637;
const RELAY_PORT = process.env.RELAY_PORT || 4638;
const noCache = process.argv.includes('--no-cache');
const collectOnly = process.argv.includes('--collect');
const isRelay = process.argv.includes('--relay');
const joinIndex = process.argv.indexOf('--join');
const isJoin = joinIndex !== -1;

// ── Relay mode ───────────────────────────────────────────────
if (isRelay) {
  const { initRelayDb, getRelayDb, createRelayApp } = require('./relay-server');
  const { wireMcpToExpress } = require('./mcp-server');

  console.log('');
  console.log(chalk.bold('  ⚡ Agentlytics Relay'));
  console.log(chalk.dim('  Multi-user context sharing server'));
  console.log('');

  initRelayDb();
  console.log(chalk.green('  ✓ Relay database initialized'));

  const app = createRelayApp();
  wireMcpToExpress(app, getRelayDb);
  console.log(chalk.green('  ✓ MCP server registered'));

  if (process.env.RELAY_PASSWORD) {
    console.log(chalk.green('  ✓ Password protection enabled'));
  } else {
    console.log(chalk.yellow('  ⚠ No password set (set RELAY_PASSWORD env to protect)'));
  }

  app.listen(RELAY_PORT, () => {
    const localIp = getLocalIp();
    const relayUrl = `http://${localIp}:${RELAY_PORT}`;

    console.log('');
    console.log(chalk.green(`  ✓ Relay server running on port ${RELAY_PORT}`));
    console.log('');
    console.log(chalk.bold('  Share this command with your team:'));
    console.log('');
    console.log(chalk.cyan(`    npx agentlytics --join ${localIp}:${RELAY_PORT} --username <name>`));
    console.log('');
    console.log(chalk.bold('  MCP server endpoint (add to your AI client):'));
    console.log('');
    console.log(chalk.cyan(`    ${relayUrl}/mcp`));
    console.log('');
    console.log(chalk.dim('  REST endpoints:'));
    console.log(chalk.dim(`    GET  ${relayUrl}/relay/health`));
    console.log(chalk.dim(`    GET  ${relayUrl}/relay/users`));
    console.log(chalk.dim(`    GET  ${relayUrl}/relay/search?q=<query>`));
    console.log(chalk.dim(`    GET  ${relayUrl}/relay/activity/<username>`));
    console.log(chalk.dim(`    GET  ${relayUrl}/relay/session/<chatId>`));
    console.log('');
    console.log(chalk.dim('  Press Ctrl+C to stop'));
    console.log('');
  });

  // Skip the rest of the normal flow
  return;
}

// ── Join mode ────────────────────────────────────────────────
if (isJoin) {
  (async () => {
    const relayAddress = process.argv[joinIndex + 1];
    const usernameIndex = process.argv.indexOf('--username');
    let username = usernameIndex !== -1 ? process.argv[usernameIndex + 1] : null;

    if (!relayAddress) {
      console.error(chalk.red('\n  ✗ Missing relay address. Usage: npx agentlytics --join <host:port> --username <name>\n'));
      process.exit(1);
    }

    // Auto-detect username from git config if not provided
    if (!username) {
      try {
        const gitEmail = execSync('git config user.email', { encoding: 'utf-8' }).trim();
        if (gitEmail) username = gitEmail;
      } catch {}
    }

    // If still no username, ask interactively
    if (!username) {
      const readline = require('readline');
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      username = await new Promise(r => {
        rl.question(chalk.bold('\n  Enter your username: '), (answer) => {
          rl.close();
          r(answer.trim());
        });
      });
      if (!username) {
        console.error(chalk.red('\n  ✗ Username is required.\n'));
        process.exit(1);
      }
    }

    const { startJoinClient } = require('./relay-client');
    startJoinClient(relayAddress, username);
  })();

  // Skip the rest of the normal flow
  return;
}

// ── Helper: get local IP for relay ───────────────────────────
function getLocalIp() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) return iface.address;
    }
  }
  return 'localhost';
}

// ── ASCII banner ─────────────────────────────────────────
const c1 = chalk.hex('#818cf8'), c2 = chalk.hex('#f472b6'), c3 = chalk.hex('#34d399'), c4 = chalk.hex('#fbbf24');
console.log('');
console.log(`  ${c1('(● ●)')} ${c2('[● ●]')}   ${chalk.bold('Agentlytics')}`);
console.log(`  ${c3('{● ●}')} ${c4('<● ●>')}   ${chalk.dim('Unified analytics for your AI coding agents')}`);
if (collectOnly) console.log(chalk.cyan('  ⟳ Collect-only mode (no server)'));
console.log('');

// ── Build UI if not already built ──────────────────────────
const publicIndex = path.join(__dirname, 'public', 'index.html');
const uiDir = path.join(__dirname, 'ui');

if (!collectOnly && !fs.existsSync(publicIndex) && fs.existsSync(uiDir)) {
  console.log(chalk.cyan('  ⟳ Building dashboard UI (first run)...'));
  try {
    const uiModules = path.join(uiDir, 'node_modules');
    if (fs.existsSync(uiModules)) fs.rmSync(uiModules, { recursive: true, force: true });
    console.log(chalk.dim('    Installing UI dependencies...'));
    execSync('npm install --no-audit --no-fund', { cwd: uiDir, stdio: 'pipe' });
    console.log(chalk.dim('    Compiling frontend...'));
    execSync('npm run build', { cwd: uiDir, stdio: 'pipe' });
    console.log(chalk.green('  ✓ UI built successfully'));
  } catch (err) {
    console.error(chalk.red('  ✗ UI build failed:'), err.message);
    process.exit(1);
  }
  console.log('');
}

if (!collectOnly && !fs.existsSync(publicIndex)) {
  console.error(chalk.red('  ✗ No built UI found at public/index.html'));
  console.error(chalk.dim('    Run: cd ui && npm install && npm run build'));
  process.exit(1);
}

const cache = require('./cache');

// Wipe cache if --no-cache flag is passed
if (noCache) {
  const cacheDb = path.join(os.homedir(), '.agentlytics', 'cache.db');
  if (fs.existsSync(cacheDb)) {
    fs.unlinkSync(cacheDb);
    // Remove WAL/SHM journal files to avoid SQLITE_IOERR_SHORT_READ
    for (const suffix of ['-wal', '-shm']) {
      if (fs.existsSync(cacheDb + suffix)) fs.unlinkSync(cacheDb + suffix);
    }
    console.log(chalk.yellow('  ⟳ Cache cleared (--no-cache)'));
  }
}

// ── Warn about installed-but-not-running Windsurf variants (macOS only) ─
if (process.platform === 'darwin') {
const WINDSURF_VARIANTS = [
  { name: 'Windsurf', app: '/Applications/Windsurf.app', dataDir: path.join(HOME, '.codeium', 'windsurf'), ide: 'windsurf' },
  { name: 'Windsurf Next', app: '/Applications/Windsurf Next.app', dataDir: path.join(HOME, '.codeium', 'windsurf-next'), ide: 'windsurf-next' },
  { name: 'Antigravity', app: '/Applications/Antigravity.app', dataDir: path.join(HOME, '.codeium', 'antigravity'), ide: 'antigravity' },
];

(() => {
  // Check which language servers are running
  let runningIdes = [];
  try {
    const ps = execSync('ps aux', { encoding: 'utf-8', maxBuffer: 1024 * 1024 });
    for (const line of ps.split('\n')) {
      if (!line.includes('language_server_macos')) continue;
      const ideMatch = line.match(/--ide_name\s+(\S+)/);
      const appDirMatch = line.match(/--app_data_dir\s+(\S+)/);
      if (ideMatch) runningIdes.push(ideMatch[1]);
      if (appDirMatch) runningIdes.push(appDirMatch[1]);
    }
  } catch {}

  const installedNotRunning = WINDSURF_VARIANTS.filter(v => {
    const installed = fs.existsSync(v.app) || fs.existsSync(v.dataDir);
    const running = runningIdes.some(r => r === v.ide || r.includes(v.ide));
    return installed && !running;
  });

  if (installedNotRunning.length > 0) {
    const names = installedNotRunning.map(v => chalk.bold(v.name)).join(', ');
    console.log(chalk.yellow(`  ⚠ ${names} installed but not running`));
    console.log(chalk.dim('    These editors must be open for their sessions to be detected.'));
    console.log('');
  }
})();
}

// Initialize cache DB
cache.initDb();

// ── Detect editors & collect sessions ───────────────────────
const { editors: editorModules, editorLabels } = require('./editors');

console.log(chalk.dim('  Looking for AI coding agents...'));
const allChats = [];
for (const editor of editorModules) {
  try {
    const chats = editor.getChats();
    allChats.push(...chats);
  } catch { /* skip broken adapters */ }
}
allChats.sort((a, b) => (b.lastUpdatedAt || b.createdAt || 0) - (a.lastUpdatedAt || a.createdAt || 0));

// Count per source
const bySource = {};
for (const chat of allChats) bySource[chat.source] = (bySource[chat.source] || 0) + 1;

const displayList = Object.entries(editorLabels)
  .map(([src, label]) => [src, label, bySource[src] || 0])
  .sort((a, b) => b[2] - a[2]);

for (const [src, label, count] of displayList) {
  if (count > 0) {
    console.log(`  ${chalk.green('✓')} ${chalk.bold(label.padEnd(18))} ${chalk.dim(`${count} session${count === 1 ? '' : 's'}`)}`);
  } else {
    console.log(`  ${chalk.dim('–')} ${chalk.dim(label.padEnd(18) + '–')}`);
  }
}
console.log('');

// ── Analyze sessions with robot animation (async to allow Ctrl+C) ──
const logUpdate = require('log-update');
const BOT_STYLES = [
  { l: '(', r: ')', color: '#818cf8' },
  { l: '[', r: ']', color: '#f472b6' },
  { l: '{', r: '}', color: '#34d399' },
  { l: '<', r: '>', color: '#fbbf24' },
];

(async () => {
  // ── Ask for subscription access permission (first run only) ──
  const CONFIG_DIR = path.join(os.homedir(), '.agentlytics');
  const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');
  let agentConfig = {};
  try { agentConfig = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8')); } catch {}

  if (agentConfig.allowSubscriptionAccess === undefined) {
    console.log(chalk.yellow('  ⚠ Subscription & usage details require access to local auth tokens.'));
    console.log('');
    console.log(chalk.dim('    To show your plan and usage info, Agentlytics needs to read'));
    console.log(chalk.dim('    locally stored tokens from the following sources:'));
    console.log('');
    console.log(chalk.dim('      • Claude Code  – macOS Keychain / Linux secret-tool'));
    console.log(chalk.dim('      • Cursor       – local SQLite (state.vscdb)'));
    console.log(chalk.dim('      • Copilot      – ~/.config/github-copilot/apps.json'));
    console.log(chalk.dim('      • VS Code      – ~/.config/github-copilot/apps.json'));
    console.log(chalk.dim('      • Codex        – local auth.json (JWT decode only)'));
    console.log(chalk.dim('      • Windsurf     – local SQLite (state.vscdb)'));
    console.log('');
    console.log(chalk.dim('    These tokens are used to query each editor\'s own API for'));
    console.log(chalk.dim('    your plan name and usage limits.'));
    console.log('');
    console.log(chalk.bold.white('    → Tokens are kept in-memory only and never sent to any'));
    console.log(chalk.bold.white('      third-party service. They are discarded after the request.'));
    console.log('');
    const readline = require('readline');
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const answer = await new Promise(r => {
      rl.question(chalk.bold('  Allow local token inspection for subscription details? (y/N) '), (a) => {
        rl.close();
        r(a.trim().toLowerCase());
      });
    });
    agentConfig.allowSubscriptionAccess = answer === 'y' || answer === 'yes';
    if (!fs.existsSync(CONFIG_DIR)) fs.mkdirSync(CONFIG_DIR, { recursive: true });
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(agentConfig, null, 2));
    if (agentConfig.allowSubscriptionAccess) {
      console.log(chalk.green('  ✓ Subscription access enabled'));
    } else {
      console.log(chalk.dim('  – Subscription access skipped (plan/usage details won\'t be collected)'));
    }
    console.log('');
  }

  let tick = 0;
  const startTime = Date.now();
  const result = await cache.scanAllAsync((p) => {
    tick++;
    if (tick % 5 !== 0) return;
    const frame = Math.floor(tick / 40);
    const b = BOT_STYLES[frame % 4];
    const dots = '.'.repeat((Math.floor(tick / 10) % 3) + 1).padEnd(3);
    logUpdate(`  ${chalk.hex(b.color)(`${b.l}● ●${b.r}`)}  ${chalk.dim(`Analyzing${dots} ${p.scanned}/${p.total}`)}`);
  }, { chats: allChats });
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  const allFaces = BOT_STYLES.map(b => chalk.hex(b.color)(`${b.l}● ●${b.r}`)).join(' ');
  logUpdate(`  ${allFaces}  ${chalk.green(`✓ ${result.analyzed} analyzed, ${result.skipped} cached (${elapsed}s)`)}`);
  logUpdate.done();
  console.log('');

  // In collect-only mode, exit after cache is built
  if (collectOnly) {
    const cacheDbPath = path.join(os.homedir(), '.agentlytics', 'cache.db');
    console.log(chalk.dim(`  Cache file: ${cacheDbPath}`));
    console.log('');
    process.exit(0);
  }

  // Start server (kill stale agentlytics or find free port)
  const app = require('./server');
  const http = require('http');
  const net = require('net');

  // Pre-cache MCP server tool lists (runs in background, non-blocking)
  app.initMcpToolsCache().then(() => {
    console.log(chalk.green('  ✓ MCP tools cached'));
  }).catch(() => {});

  function isPortFree(port) {
    return new Promise((resolve) => {
      const tester = net.createServer()
        .once('error', () => resolve(false))
        .once('listening', () => tester.close(() => resolve(true)))
        .listen(port, '0.0.0.0');
    });
  }

  async function startServer(port) {
    const free = await isPortFree(port);
    if (!free) {
      // Port in use — check if it's a previous agentlytics instance
      try {
        const data = await new Promise((resolve, reject) => {
          const req = http.get(`http://127.0.0.1:${port}/api/ping`, { timeout: 2000 }, (res) => {
            let body = '';
            res.on('data', (d) => body += d);
            res.on('end', () => { try { resolve(JSON.parse(body)); } catch { reject(); } });
          });
          req.on('error', reject);
        });
        if (data.app === 'agentlytics' && data.pid) {
          console.log(chalk.yellow(`  ⟳ Killing previous Agentlytics instance (PID ${data.pid})...`));
          try { process.kill(data.pid, 'SIGTERM'); } catch {}
          await new Promise(r => setTimeout(r, 1000));
          return startServer(port);
        }
      } catch {}
      console.log(chalk.yellow(`  ⚠ Port ${port} is in use by another app, trying ${port + 1}...`));
      return startServer(port + 1);
    }

    app.listen(port, '0.0.0.0', () => {
      const url = `http://localhost:${port}`;
      console.log(chalk.green(`  ✓ Dashboard ready at ${chalk.bold.white(url)}`));
      console.log('');
      console.log(chalk.dim('  Press Ctrl+C to stop\n'));

      // Auto-open browser
      const open = require('open');
      open(url).catch(() => {});
    });
  }

  startServer(parseInt(PORT));
})();
