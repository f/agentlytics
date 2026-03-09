const cursor = require('./cursor');
const windsurf = require('./windsurf');
const claude = require('./claude');
const vscode = require('./vscode');
const zed = require('./zed');
const opencode = require('./opencode');
const codex = require('./codex');
const gemini = require('./gemini');
const kimi = require('./kimi');
const copilot = require('./copilot');
const cursorAgent = require('./cursor-agent');
const commandcode = require('./commandcode');

const EDITOR_COLORS = {
  'cursor': '#f59e0b',
  'windsurf': '#06b6d4',
  'windsurf-next': '#22d3ee',
  'antigravity': '#a78bfa',
  'claude-code': '#f97316',
  'claude': '#f97316',
  'vscode': '#3b82f6',
  'vscode-insiders': '#60a5fa',
  'zed': '#10b981',
  'opencode': '#ec4899',
  'codex': '#0f766e',
  'gemini-cli': '#4285f4',
  'kimi-cli': '#84cc16',
  'copilot-cli': '#8957e5',
  'cursor-agent': '#f59e0b',
  'commandcode': '#e11d48',
};

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
  'codex': 'Codex',
  'gemini-cli': 'Gemini CLI',
  'kimi-cli': 'Kimi CLI',
  'copilot-cli': 'Copilot CLI',
  'cursor-agent': 'Cursor Agent',
  'commandcode': 'Command Code',
};

const editors = [cursor, windsurf, claude, vscode, zed, opencode, codex, gemini, kimi, copilot, cursorAgent, commandcode];

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

module.exports = { getAllChats, getMessages, editors, resetCaches, EDITOR_LABELS, EDITOR_COLORS };
