const cursor = require('./cursor');
const claudeCode = require('./claude-code');
const cursorEditor = require('../editors/cursor');
const claudeEditor = require('../editors/claude');
const cache = require('../cache');

// Per-editor wiring. Add a new editor by appending an entry — no dispatch
// branches needed. Each analyzer is expected to return a usage snapshot
// carrying `sessions` (count) and `pricing` (orchestrator contract).
const REGISTRY = {
  cursor: {
    sources: ['cursor', 'cursor-agent'],
    editor: cursorEditor,
    analyzer: cursor,
  },
  'claude-code': {
    sources: ['claude-code'],
    editor: claudeEditor,
    analyzer: claudeCode,
  },
};

function getFolders(db, sources) {
  if (!db) return [];
  try {
    const placeholders = sources.map(() => '?').join(',');
    return db.prepare(
      `SELECT DISTINCT folder FROM chats WHERE source IN (${placeholders}) AND folder IS NOT NULL`
    ).all(...sources).map(r => r.folder);
  } catch {
    return [];
  }
}

/**
 * Run the suggestions analyzer for a given editor.
 * Returns { editor, generatedAt, totalSessionsAnalyzed, suggestions: [...] }
 */
function runForEditor(editorName) {
  const entry = REGISTRY[editorName];
  if (!entry) {
    return { editor: editorName, error: 'unsupported editor', suggestions: [] };
  }

  const db = cache.getDb();
  const folders = getFolders(db, entry.sources);
  const config = entry.editor.getConfig(folders);
  const usage = entry.analyzer.analyzeUsage(db);
  const suggestions = entry.analyzer.analyze(config, usage);

  return {
    editor: editorName,
    generatedAt: Date.now(),
    totalSessionsAnalyzed: usage.sessions || 0,
    projectsInspected: config.projects.length,
    globalServers: config.global.mcpServers.length,
    pricing: usage.pricing,
    suggestions,
  };
}

module.exports = { runForEditor };
