const path = require('path');
const os = require('os');

const HOME = os.homedir();

// --- Platform utilities ---

/**
 * Get platform-specific app data directory path for VS Code-like editors.
 * - macOS: ~/Library/Application Support/{appName}/User/...
 * - Windows: ~/AppData/Roaming/{appName}/User/...
 * - Linux: ~/.config/{appName}/User/...
 */
function getAppDataPath(appName) {
  switch (process.platform) {
    case 'darwin':
      return path.join(HOME, 'Library', 'Application Support', appName);
    case 'win32':
      return path.join(HOME, 'AppData', 'Roaming', appName);
    default: // linux, etc.
      return path.join(HOME, '.config', appName);
  }
}

/**
 * Every editor adapter must implement:
 *
 *   name        - string identifier (e.g. 'cursor', 'windsurf')
 *   getChats()  - returns array of chat objects:
 *       { source, composerId, name, createdAt, lastUpdatedAt, mode, folder, bubbleCount, encrypted }
 *   getMessages(chat) - returns array of message objects:
 *       { role: 'user'|'assistant'|'system'|'tool', content: string|Array }
 */

module.exports = {
  getAppDataPath,
};
