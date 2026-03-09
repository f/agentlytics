const cursor = require('./cursor');
const windsurf = require('./windsurf');
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

const editors = [cursor, windsurf, claude, vscode, zed, opencode, codex, gemini, copilot, cursorAgent, commandcode, goose];

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

module.exports = { getAllChats, getMessages, editors, editorLabels, resetCaches };
