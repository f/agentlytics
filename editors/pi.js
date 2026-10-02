const path = require('path');
const fs = require('fs');
const os = require('os');

// ============================================================
// Pi adapter (covers both variants)
// ------------------------------------------------------------
// Pi (https://pi.dev, earendil-works/pi) and its fork Oh My Pi
// (https://omp.sh, can1357/oh-my-pi) store sessions as JSONL
// trees under:
//
//   ~/.pi/agent/sessions/<munged-cwd>/<timestamp>_<session-id>.jsonl
//   ~/.omp/agent/sessions/<munged-cwd>/<timestamp>_<session-id>.jsonl
//
// The munged-cwd directory name is lossy, but every session's
// header line carries the real `cwd`, so we recover the folder
// from there. Session format (v3): one JSON object per line, all
// entries forming a tree via id/parentId. Relevant entry types:
//   session              — header: { version, id, timestamp, cwd, title }
//   title / title_change — name updates (latest wins)
//   message              — { role: user|assistant|system|toolResult, content, ... }
//   model_change         — { provider, modelId }
// Assistant messages carry { model, provider, usage: { input, output,
// cacheRead, cacheWrite, totalTokens, cost } }. toolResult messages
// carry { toolCallId, toolName, content, isError }.
// We skip UI-only entries (custom, credential_pin, usage) and replay
// the active branch (walk from the last message entry back to the
// root via parentId) — that's the conversation Pi sends to the model.
// ============================================================

const HOME = os.homedir();

const VARIANTS = [
  { id: 'pi', label: 'Pi', sessionsDir: path.join(HOME, '.pi', 'agent', 'sessions') },
  { id: 'oh-my-pi', label: 'Oh My Pi', sessionsDir: path.join(HOME, '.omp', 'agent', 'sessions') },
];

function cleanPrompt(text) {
  if (!text) return null;
  const clean = String(text).replace(/\s+/g, ' ').trim().substring(0, 120);
  return clean || null;
}

function parseSessionFile(filePath) {
  let raw;
  try { raw = fs.readFileSync(filePath, 'utf-8'); } catch { return null; }
  const entries = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try { entries.push(JSON.parse(trimmed)); } catch { /* partial trailing line during write */
    }
  }
  return entries.length ? entries : null;
}

// Latest title wins: title_change entries are appended as the user
// renames, with a leading metadata-only `title` marker and the
// session header both carrying the initial title.
function pickTitle(entries) {
  let title = null;
  for (const e of entries) {
    if (e && typeof e.title === 'string' && e.title) {
      if (e.type === 'title' || e.type === 'title_change' || e.type === 'session') title = e.title;
    }
  }
  return title;
}

function firstUserText(entries) {
  for (const e of entries) {
    const msg = e && e.message;
    if (e && e.type === 'message' && msg && msg.role === 'user') {
      const text = flattenContent(msg.content);
      if (text) return text;
    }
  }
  return null;
}

function flattenContent(content) {
  if (typeof content === 'string') return content.trim() || null;
  if (!Array.isArray(content)) return null;
  const parts = [];
  for (const block of content) {
    if (block && block.type === 'text' && typeof block.text === 'string') parts.push(block.text);
  }
  return parts.length ? parts.join('\n') : null;
}

// The model only ever sees the active branch of the entry tree.
// Entries append chronologically, so the last message entry is the
// tip of the active branch — walk parentId links back to the root.
// Files without usable ids (pre-v2 sessions) replay in file order.
function activeBranchEntries(entries) {
  const messages = entries.filter((e) => e && e.type === 'message');
  if (messages.length === 0) return [];
  const last = messages[messages.length - 1];
  if (!last.id) return messages;

  const byId = new Map();
  for (const e of entries) {
    if (e && e.id) byId.set(e.id, e);
  }
  const chain = [];
  let cur = last;
  while (cur) {
    chain.push(cur);
    cur = cur.parentId ? byId.get(cur.parentId) : null;
    if (chain.length > entries.length) break; // corrupt cycle guard
  }
  chain.reverse();
  return chain.length === messages.length || chain.length > 0 ? chain : messages;
}

function flattenAssistantBlocks(blocks) {
  const parts = [];
  const toolCalls = [];
  if (typeof blocks === 'string') {
    if (blocks.trim()) parts.push(blocks);
    return { parts, toolCalls };
  }
  if (!Array.isArray(blocks)) return { parts, toolCalls };
  for (const block of blocks) {
    if (!block || typeof block !== 'object') continue;
    if (block.type === 'text' && typeof block.text === 'string' && block.text) {
      parts.push(block.text);
    } else if (block.type === 'thinking' && typeof block.text === 'string' && block.text) {
      parts.push(`[thinking] ${block.text}`);
    } else if (block.type === 'toolCall') {
      const toolName = block.name || 'tool';
      const input = block.arguments && typeof block.arguments === 'object' ? block.arguments : {};
      const argKeys = Object.keys(input).join(', ');
      parts.push(`[tool-call: ${toolName}(${argKeys})]`);
      toolCalls.push({ name: toolName, args: input });
    }
  }
  return { parts, toolCalls };
}

// ============================================================
// Adapter interface
// ============================================================

const name = 'pi';
const sources = ['pi', 'oh-my-pi'];
const labels = { pi: 'Pi', 'oh-my-pi': 'Oh My Pi' };

function getChats() {
  const chats = [];

  for (const variant of VARIANTS) {
    if (!fs.existsSync(variant.sessionsDir)) continue;

    let projectDirs;
    try { projectDirs = fs.readdirSync(variant.sessionsDir); } catch { continue; }

    for (const projectDir of projectDirs) {
      const dir = path.join(variant.sessionsDir, projectDir);
      try { if (!fs.statSync(dir).isDirectory()) continue; } catch { continue; }

      let files;
      try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl') && !f.startsWith('.')); } catch { continue; }

      for (const file of files) {
        const fullPath = path.join(dir, file);
        const entries = parseSessionFile(fullPath);
        if (!entries) continue;

        const header = entries.find((e) => e && e.type === 'session');
        let lastModel = null;
        let messageCount = 0;
        for (const e of entries) {
          if (!e) continue;
          if (e.type === 'message') messageCount++;
          // Upstream pi writes `modelId`; oh-my-pi writes `model` (virtual
          // model ids like "openai-codex/gpt-6-astra").
          if (e.type === 'model_change' && typeof e.model === 'string' && e.model) lastModel = e.model;
          else if (e.type === 'model_change' && typeof e.modelId === 'string' && e.modelId) lastModel = e.modelId;
        }
        if (messageCount === 0) continue;

        let stat;
        try { stat = fs.statSync(fullPath); } catch { continue; }

        const title = pickTitle(entries);
        const name_ = title || cleanPrompt(firstUserText(entries));

        chats.push({
          source: variant.id,
          composerId: file.replace(/\.jsonl$/, ''),
          name: name_,
          createdAt: header && header.timestamp ? Date.parse(header.timestamp) || null : null,
          lastUpdatedAt: stat.mtime.getTime(),
          mode: lastModel || variant.id,
          folder: (header && typeof header.cwd === 'string' && header.cwd) || null,
          encrypted: false,
          bubbleCount: messageCount,
          _fullPath: fullPath,
        });
      }
    }
  }

  return chats;
}

function getMessages(chat) {
  const fullPath = chat._fullPath;
  if (!fullPath || !fs.existsSync(fullPath)) return [];

  const entries = parseSessionFile(fullPath);
  if (!entries) return [];

  const out = [];
  for (const entry of activeBranchEntries(entries)) {
    const msg = entry.message;
    if (!msg || typeof msg !== 'object') continue;

    if (msg.role === 'user') {
      const content = flattenContent(msg.content);
      if (content) out.push({ role: 'user', content });
      continue;
    }

    if (msg.role === 'assistant') {
      const flattened = flattenAssistantBlocks(msg.content);
      const content = flattened.parts.join('\n').trim();
      if (!content) continue;
      const usage = msg.usage || {};
      out.push({
        role: 'assistant',
        content,
        _model: typeof msg.model === 'string' ? msg.model : undefined,
        _inputTokens: usage.input,
        _outputTokens: usage.output,
        _cacheRead: usage.cacheRead,
        _cacheWrite: usage.cacheWrite,
        _toolCalls: flattened.toolCalls.length ? flattened.toolCalls : undefined,
      });
      continue;
    }

    if (msg.role === 'system') {
      // Pi system messages mostly carry prompt sections with empty
      // content — only surface ones with real text.
      const content = flattenContent(msg.content);
      if (content) out.push({ role: 'system', content });
      continue;
    }

    if (msg.role === 'toolResult') {
      const text = flattenContent(msg.content);
      if (!text && !msg.isError) continue;
      const preview = (text || '').substring(0, 500);
      out.push({
        role: 'tool',
        content: `[${msg.toolName || 'tool'}${msg.isError ? ' (error)' : ''}] ${preview}`.trim(),
      });
      continue;
    }
  }

  return out;
}

function getArtifacts(folder) {
  const { scanArtifacts } = require('./base');
  return scanArtifacts(folder, {
    editor: 'pi',
    label: 'Pi',
    files: ['AGENTS.md'],
    dirs: ['.pi'],
  });
}

module.exports = { name, sources, labels, getChats, getMessages, getArtifacts };
