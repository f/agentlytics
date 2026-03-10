#!/usr/bin/env node

const chalk = require('chalk');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');

const HOME = os.homedir();
const PORT = process.env.PORT || 4637;
const noCache = process.argv.includes('--no-cache');
const collectOnly = process.argv.includes('--collect');
const noOpen = process.argv.includes('--no-open');

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
    if (!fs.existsSync(uiModules)) {
      console.log(chalk.dim('    Installing UI dependencies...'));
      execSync('npm install --no-audit --no-fund', { cwd: uiDir, stdio: 'pipe' });
    }
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

  // Start server
  const app = require('./server');
  app.listen(PORT, () => {
    const url = `http://localhost:${PORT}`;
    console.log(chalk.green(`  ✓ Dashboard ready at ${chalk.bold.white(url)}`));
    console.log('');
    console.log(chalk.dim('  Press Ctrl+C to stop\n'));

    // Auto-open browser (skip when launched by Tauri)
    if (!noOpen) {
      const open = require('open');
      open(url).catch(() => {});
    }
  });
})();
