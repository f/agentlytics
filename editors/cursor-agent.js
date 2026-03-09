const path = require('path');
const fs = require('fs');
const os = require('os');

const CURSOR_PROJECTS_DIR = path.join(os.homedir(), '.cursor', 'projects');

// ============================================================
// Adapter interface
// ============================================================

const name = 'cursor-agent';

/**
 * Decode project directory name back to folder path.
 * e.g. "Users-fka-Code-Wapple" → "/Users/fka/Code/Wapple"
 */
function decodeProjectDir(dirName) {
  // The encoding replaces "/" with "-". We reconstruct by prepending "/"
  // and replacing "-" back to "/". Handle ambiguity by checking if path exists.
  const candidate = '/' + dirName.replace(/-/g, '/');
  if (fs.existsSync(candidate)) return candidate;
  // Fallback: try common patterns (the first segment is usually "Users")
  const parts = dirName.split('-');
  for (let i = 2; i < parts.length; i++) {
    const prefix = '/' + parts.slice(0, i).join('/');
    const suffix = parts.slice(i).join('-');
    const full = path.join(prefix, suffix);
    if (fs.existsSync(full)) return full;
  }
  return candidate;
}

/**
 * Find all agent transcript JSONL files across all projects.
 * Two patterns:
 *   - <project>/agent-transcripts/<id>.jsonl (flat)
 *   - <project>/agent-transcripts/<id>/<id>.jsonl (nested)
 */
function findTranscripts() {
  const results = [];
  if (!fs.existsSync(CURSOR_PROJECTS_DIR)) return results;

  let projectDirs;
  try { projectDirs = fs.readdirSync(CURSOR_PROJECTS_DIR); } catch { return results; }

  for (const projDir of projectDirs) {
    const transcriptsDir = path.join(CURSOR_PROJECTS_DIR, projDir, 'agent-transcripts');
    if (!fs.existsSync(transcriptsDir)) continue;

    let entries;
    try { entries = fs.readdirSync(transcriptsDir); } catch { continue; }

    const folder = decodeProjectDir(projDir);

    for (const entry of entries) {
      const entryPath = path.join(transcriptsDir, entry);

      // Flat pattern: <id>.jsonl
      if (entry.endsWith('.jsonl')) {
        const sessionId = entry.replace('.jsonl', '');
        results.push({ sessionId, jsonlPath: entryPath, folder });
        continue;
      }

      // Nested pattern: <id>/<id>.jsonl
      try {
        if (fs.statSync(entryPath).isDirectory()) {
          const nestedJsonl = path.join(entryPath, entry + '.jsonl');
          if (fs.existsSync(nestedJsonl)) {
            results.push({ sessionId: entry, jsonlPath: nestedJsonl, folder });
          }
        }
      } catch { /* skip */ }
    }
  }
  return results;
}

/**
 * Parse a JSONL transcript file into an array of raw message objects.
 * Each line: {"role":"user"|"assistant", "message":{"content":[{"type":"text","text":"..."}]}}
 */
function parseJsonl(jsonlPath) {
  try {
    const raw = fs.readFileSync(jsonlPath, 'utf-8');
    return raw.split('\n').filter(Boolean).map(line => {
      try { return JSON.parse(line); } catch { return null; }
    }).filter(Boolean);
  } catch { return []; }
}

/**
 * Extract the first user query text from a parsed transcript (for chat name).
 */
function extractFirstUserText(entries) {
  for (const e of entries) {
    if (e.role !== 'user') continue;
    const parts = e.message?.content;
    if (!Array.isArray(parts)) continue;
    for (const p of parts) {
      if (p.type === 'text' && p.text) {
        // Strip <user_query> wrapper if present
        let text = p.text.replace(/<\/?user_query>/g, '').trim();
        // Strip <attached_files> blocks
        text = text.replace(/<attached_files>[\s\S]*?<\/attached_files>/g, '').trim();
        if (text) return text.substring(0, 120);
      }
    }
  }
  return null;
}

function getChats() {
  const chats = [];
  const transcripts = findTranscripts();

  for (const { sessionId, jsonlPath, folder } of transcripts) {
    try {
      const stat = fs.statSync(jsonlPath);
      const entries = parseJsonl(jsonlPath);
      if (entries.length === 0) continue;

      // Count user/assistant messages
      const userCount = entries.filter(e => e.role === 'user').length;
      const assistantCount = entries.filter(e => e.role === 'assistant').length;
      const bubbleCount = userCount + assistantCount;
      if (bubbleCount === 0) continue;

      chats.push({
        source: 'cursor-agent',
        composerId: sessionId,
        name: extractFirstUserText(entries),
        createdAt: stat.birthtimeMs || stat.mtimeMs,
        lastUpdatedAt: stat.mtimeMs,
        mode: 'agent',
        folder,
        bubbleCount,
        _jsonlPath: jsonlPath,
      });
    } catch { /* skip */ }
  }

  return chats;
}

function getMessages(chat) {
  const jsonlPath = chat._jsonlPath;
  if (!jsonlPath || !fs.existsSync(jsonlPath)) return [];

  const entries = parseJsonl(jsonlPath);
  const result = [];

  for (const entry of entries) {
    const parts = entry.message?.content;
    if (!Array.isArray(parts)) continue;

    const textParts = [];
    for (const p of parts) {
      if (p.type === 'text' && p.text) {
        let text = p.text;
        // Clean up user_query wrappers
        text = text.replace(/<\/?user_query>/g, '').trim();
        // Clean attached_files blocks but note file references
        const fileRefs = [];
        text = text.replace(/<attached_files>([\s\S]*?)<\/attached_files>/g, (_, inner) => {
          const paths = inner.match(/path="([^"]+)"/g);
          if (paths) {
            for (const pm of paths) {
              const fp = pm.match(/path="([^"]+)"/);
              if (fp) fileRefs.push(fp[1]);
            }
          }
          return '';
        }).trim();
        // Clean image_files blocks
        text = text.replace(/<image_files>[\s\S]*?<\/image_files>/g, '[image]').trim();
        if (text) textParts.push(text);
        if (fileRefs.length > 0) {
          textParts.push(fileRefs.map(f => `[file: ${f}]`).join('\n'));
        }
      }
    }

    if (textParts.length > 0) {
      result.push({
        role: entry.role === 'user' ? 'user' : 'assistant',
        content: textParts.join('\n'),
      });
    }
  }

  return result;
}

const labels = { 'cursor-agent': 'Cursor Agent' };

module.exports = { name, labels, getChats, getMessages };
