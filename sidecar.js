#!/usr/bin/env node

/**
 * Tauri sidecar entry point for the Node.js backend.
 * Starts the Express server without relay mode, without auto-opening browser,
 * and without the interactive CLI animations.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const HOME = os.homedir();
const PORT = process.env.PORT || 4637;

// ── Build UI if not already built ──────────────────────────
const publicIndex = path.join(__dirname, 'public', 'index.html');
const uiDir = path.join(__dirname, 'ui');

if (!fs.existsSync(publicIndex) && fs.existsSync(uiDir)) {
  const { execSync } = require('child_process');
  try {
    const uiModules = path.join(uiDir, 'node_modules');
    if (!fs.existsSync(uiModules)) {
      execSync('npm install --no-audit --no-fund', { cwd: uiDir, stdio: 'pipe' });
    }
    execSync('npm run build', { cwd: uiDir, stdio: 'pipe' });
  } catch (err) {
    console.error('UI build failed:', err.message);
    process.exit(1);
  }
}

const cache = require('./cache');

// Initialize cache DB
cache.initDb();

// ── Detect editors & collect sessions ───────────────────────
const { editors: editorModules } = require('./editors');

console.log('[sidecar] Scanning editors...');
const allChats = [];
for (const editor of editorModules) {
  try {
    const chats = editor.getChats();
    allChats.push(...chats);
  } catch { /* skip broken adapters */ }
}
allChats.sort((a, b) => (b.lastUpdatedAt || b.createdAt || 0) - (a.lastUpdatedAt || a.createdAt || 0));

// ── Analyze sessions ──
(async () => {
  const result = await cache.scanAllAsync((p) => {
    // Periodic progress output
    if (p.scanned % 50 === 0) {
      console.log(`[sidecar] Analyzing... ${p.scanned}/${p.total}`);
    }
  }, { chats: allChats });

  console.log(`[sidecar] Done: ${result.analyzed} analyzed, ${result.skipped} cached`);

  // Start server (skip if port already in use)
  const net = require('net');
  const probe = net.createServer();
  probe.once('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.log(`[sidecar] Port ${PORT} already in use — reusing existing backend`);
    } else {
      console.error('[sidecar] Port probe error:', err.message);
    }
  });
  probe.once('listening', () => {
    probe.close(() => {
      const app = require('./server');
      app.listen(PORT, () => {
        console.log(`[sidecar] Server ready on port ${PORT}`);
      });
    });
  });
  probe.listen(PORT);
})();
