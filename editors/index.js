const cursor = require('./cursor');
const windsurf = require('./windsurf');
const antigravity = require('./antigravity');
const claude = require('./claude');
const vscode = require('./vscode');
const zed = require('./zed');
const opencode = require('./opencode');
const codex = require('./codex');
const gemini = require('./gemini');
const copilot = require('./copilot');
const cursorAgent = require('./cursor-agent');
const commandcode = require('./commandcode');
const goose = require('./goose');
const kiro = require('./kiro');
const clineCli = require('./cline-cli');
const kilocodeCli = require('./kilocode-cli');

const editors = [cursor, windsurf, antigravity, claude, vscode, zed, opencode, codex, gemini, copilot, cursorAgent, commandcode, goose, kiro, clineCli, kilocodeCli];

// Build a unified source → display-label map from all editor modules
const editorLabels = {};
for (const editor of editors) {
  if (editor.labels) Object.assign(editorLabels, editor.labels);
}

/**
 * Get all chats from all editor adapters, sorted by most recent first.
 */
function getAllChats() {
  const chats = [];
  for (const editor of editors) {
    try {
      const editorChats = editor.getChats();
      chats.push(...editorChats);
    } catch { /* skip broken adapters */ }
  }

  chats.sort((a, b) => {
    const ta = a.lastUpdatedAt || a.createdAt || 0;
    const tb = b.lastUpdatedAt || b.createdAt || 0;
    return tb - ta;
  });

  return chats;
}

/**
 * Get messages for a chat object, dispatching to the right editor adapter.
 */
function getMessages(chat) {
  const editor = editors.find((e) => e.name === chat.source);
  // Match variants: windsurf-next, antigravity, claude-code, vscode-insiders etc.
  const resolvedEditor = editor || editors.find((e) =>
    chat.source && (chat.source.startsWith(e.name) || (e.sources && e.sources.includes(chat.source)))
  );
  if (!resolvedEditor) return [];
  return resolvedEditor.getMessages(chat);
}

function resetCaches() {
  for (const editor of editors) {
    if (typeof editor.resetCache === 'function') editor.resetCache();
  }
}

/**
 * Get usage / quota data from all editors that support it.
 * Returns an array of usage objects, one per editor/variant.
 */
async function getAllUsage() {
  const results = [];
  for (const editor of editors) {
    if (typeof editor.getUsage !== 'function') continue;
    try {
      const usage = await editor.getUsage();
      if (!usage) continue;
      // Windsurf returns an array (one per variant), Cursor returns a single object
      if (Array.isArray(usage)) results.push(...usage);
      else results.push(usage);
    } catch { /* skip broken adapters */ }
  }
  return results;
}

/**
 * Get all artifacts for a given project folder from all editors.
 * Also scans for general/shared artifact files (plan.md, etc.).
 */
function getAllArtifacts(folder) {
  const { scanArtifacts } = require('./base');
  const artifacts = [];

  // Collect from each editor that implements getArtifacts
  for (const editor of editors) {
    if (typeof editor.getArtifacts !== 'function') continue;
    try {
      artifacts.push(...editor.getArtifacts(folder));
    } catch { /* skip broken adapters */ }
  }

  // General / shared artifact files (not tied to any specific editor)
  if (folder) {
    try {
      artifacts.push(...scanArtifacts(folder, {
        editor: '_general',
        label: 'General',
        files: ['AGENTS.md', '.mcp.json', 'plan.md', 'progress.md', 'TODO.md', 'CONVENTIONS.md', 'ARCHITECTURE.md', 'PLANNING.md'],
        dirs: [],
      }));
    } catch { /* skip */ }
  }

  // Deduplicate by path — editor-specific entries take priority over general
  const seen = new Map();
  for (const a of artifacts) {
    const existing = seen.get(a.path);
    if (!existing || (existing.editor === '_general' && a.editor !== '_general')) {
      seen.set(a.path, a);
    }
  }
  return Array.from(seen.values());
}

/**
 * Get all MCP servers from all editors.
 * Also scans project folders for project-level MCP configs (.mcp.json, .cursor/mcp.json, etc.)
 */
function getAllMCPServers(projectFolders = []) {
  const { parseMcpConfigFile } = require('./base');
  const path = require('path');
  const fs = require('fs');
  const servers = [];

  // 1. Collect global MCP servers from each editor
  for (const editor of editors) {
    if (typeof editor.getMCPServers !== 'function') continue;
    try {
      servers.push(...editor.getMCPServers());
    } catch { /* skip broken adapters */ }
  }

  // 2. Scan project folders for project-level MCP configs
  const projectConfigs = [
    { file: '.mcp.json', editor: 'claude-code', label: 'Claude Code' },
    { file: '.cursor/mcp.json', editor: 'cursor', label: 'Cursor' },
    { file: '.vscode/mcp.json', editor: 'vscode', label: 'VS Code' },
    { file: '.gemini/settings.json', editor: 'gemini-cli', label: 'Gemini CLI' },
    { file: '.kiro/settings/mcp.json', editor: 'kiro', label: 'Kiro' },
  ];

  const seenProjects = new Set();
  for (const folder of projectFolders) {
    if (!folder || seenProjects.has(folder)) continue;
    seenProjects.add(folder);
    for (const pc of projectConfigs) {
      const configPath = path.join(folder, pc.file);
      if (!fs.existsSync(configPath)) continue;
      const found = parseMcpConfigFile(configPath, { editor: pc.editor, label: pc.label, scope: 'project' });
      for (const s of found) {
        s.projectFolder = folder;
      }
      servers.push(...found);
    }
  }

  // 3. Deduplicate by name+editor (keep first occurrence, prefer global over project)
  const seen = new Map();
  for (const s of servers) {
    const key = `${s.name}::${s.editor}::${s.scope}`;
    if (!seen.has(key)) seen.set(key, s);
  }
  return Array.from(seen.values());
}

module.exports = { getAllChats, getMessages, editors, editorLabels, resetCaches, getAllUsage, getAllArtifacts, getAllMCPServers };
