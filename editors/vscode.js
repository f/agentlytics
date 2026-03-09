const path = require('path');
const fs = require('fs');
const os = require('os');
const { getAppDataPath } = require('./base');

// VS Code variants: stable and insiders
const VARIANTS = [
  {
    id: 'vscode',
    appSupport: getAppDataPath('Code'),
  },
  {
    id: 'vscode-insiders',
    appSupport: getAppDataPath('Code - Insiders'),
  },
];

// ============================================================
// JSONL reconstruction: kind:0 = init, kind:1 = patch at key path
// ============================================================

function reconstructSession(filePath) {
  const lines = fs.readFileSync(filePath, 'utf-8').split('\n').filter(Boolean);
  let state = null;
  for (const line of lines) {
    let obj;
    try { obj = JSON.parse(line); } catch { continue; }
    if (obj.kind === 0) {
      state = obj.v;
    } else if (obj.kind === 1 && state) {
      let target = state;
      const p = obj.k;
      for (let i = 0; i < p.length - 1; i++) {
        if (target[p[i]] === undefined) {
          target[p[i]] = typeof p[i + 1] === 'number' ? [] : {};
        }
        target = target[p[i]];
      }
      target[p[p.length - 1]] = obj.v;
    }
  }
  return state;
}

// ============================================================
// Extract user text from renderedUserMessage (JSONL) or message.text (JSON)
// ============================================================

function extractUserText(renderedParts) {
  if (!Array.isArray(renderedParts)) return '';
  for (const part of renderedParts) {
    let text = part.text || '';
    // Strip context/reminder wrappers, extract userRequest content
    const userReq = text.match(/<userRequest>([\s\S]*?)<\/userRequest>/);
    if (userReq) return userReq[1].trim();
    const stripped = text
      .replace(/<context>[\s\S]*?<\/context>/g, '')
      .replace(/<reminderInstructions>[\s\S]*?<\/reminderInstructions>/g, '')
      .replace(/<attachments>[\s\S]*?<\/attachments>/g, '')
      .trim();
    if (stripped) return stripped;
  }
  return '';
}

// ============================================================
// Reconstruct assistant response from codeBlocks metadata
// ============================================================

function reconstructResponse(metadata) {
  if (!metadata) return '';

  // Method 1: codeBlocks (simple chat responses)
  const codeBlocks = metadata.codeBlocks || [];
  if (codeBlocks.length > 0) {
    let response = '';
    for (const b of codeBlocks) {
      if (b.markdownBeforeBlock) response += b.markdownBeforeBlock;
      if (b.code) response += '\n```' + (b.language || '') + '\n' + b.code + '```\n';
    }
    if (response.trim()) return response.trim();
  }

  // Method 2: toolCallRounds (agent mode responses)
  const rounds = metadata.toolCallRounds || [];
  if (rounds.length > 0) {
    const parts = [];
    const _toolCalls = [];
    for (const round of rounds) {
      const text = (round.response || '').trim();
      if (text) parts.push(text);
      for (const tc of round.toolCalls || []) {
        let args = {};
        try { args = JSON.parse(tc.arguments || '{}'); } catch {}
        const argKeys = typeof args === 'object' ? Object.keys(args).join(', ') : '';
        parts.push(`[tool-call: ${tc.name || 'tool'}(${argKeys})]`);
        _toolCalls.push({ name: tc.name || 'tool', args });
      }
    }
    if (parts.length > 0) return { text: parts.join('\n'), toolCalls: _toolCalls };
  }

  return '';
}

// ============================================================
// Parse a session file (.jsonl or .json) into { meta, requests }
// ============================================================

function parseSessionFile(filePath) {
  const ext = path.extname(filePath);
  if (ext === '.jsonl') {
    const state = reconstructSession(filePath);
    if (!state) return null;
    return {
      sessionId: state.sessionId,
      createdAt: state.creationDate,
      title: state.customTitle || null,
      requests: state.requests || [],
      format: 'jsonl',
      selectedModel: state.inputState?.selectedModel?.metadata?.id || null,
    };
  } else if (ext === '.json') {
    let data;
    try { data = JSON.parse(fs.readFileSync(filePath, 'utf-8')); } catch { return null; }
    return {
      sessionId: data.sessionId,
      createdAt: data.creationDate || data.lastMessageDate,
      title: data.customTitle || null,
      requests: data.requests || [],
      format: 'json',
      selectedModel: data.inputState?.selectedModel?.metadata?.id || null,
    };
  }
  return null;
}

// ============================================================
// Discover workspace folder from workspaceStorage hash dir
// ============================================================

function getWorkspaceFolder(wsDir) {
  const wsJson = path.join(wsDir, 'workspace.json');
  if (!fs.existsSync(wsJson)) return null;
  try {
    const data = JSON.parse(fs.readFileSync(wsJson, 'utf-8'));
    const uri = data.folder || data.workspace;
    if (uri) return decodeURIComponent(uri.replace('file://', ''));
  } catch {}
  return null;
}

// ============================================================
// Adapter interface
// ============================================================

const name = 'vscode';

function getChats() {
  const chats = [];

  for (const variant of VARIANTS) {
    if (!fs.existsSync(variant.appSupport)) continue;

    // 1. Global (empty window) chat sessions
    const globalDir = path.join(variant.appSupport, 'User', 'globalStorage', 'emptyWindowChatSessions');
    if (fs.existsSync(globalDir)) {
      collectSessions(globalDir, null, variant.id, chats);
    }

    // 2. Workspace chat sessions
    const wsRoot = path.join(variant.appSupport, 'User', 'workspaceStorage');
    if (fs.existsSync(wsRoot)) {
      for (const wsHash of fs.readdirSync(wsRoot)) {
        const wsDir = path.join(wsRoot, wsHash);
        if (!fs.statSync(wsDir).isDirectory()) continue;
        const chatDir = path.join(wsDir, 'chatSessions');
        if (!fs.existsSync(chatDir)) continue;
        const folder = getWorkspaceFolder(wsDir);
        collectSessions(chatDir, folder, variant.id, chats);
      }
    }
  }

  return chats;
}

function collectSessions(dir, folder, source, chats) {
  let files;
  try { files = fs.readdirSync(dir).filter(f => f.endsWith('.jsonl') || f.endsWith('.json')); } catch { return; }

  for (const file of files) {
    const filePath = path.join(dir, file);
    try {
      const stat = fs.statSync(filePath);
      // Quick peek: for listing we only need metadata, not full reconstruction
      const meta = peekMeta(filePath);
      chats.push({
        source,
        composerId: meta.sessionId || file.replace(/\.(jsonl|json)$/, ''),
        name: meta.title || meta.firstUserText || null,
        createdAt: meta.createdAt || stat.birthtime.getTime(),
        lastUpdatedAt: stat.mtime.getTime(),
        mode: 'copilot',
        folder,
        encrypted: false,
        bubbleCount: meta.requestCount || 0,
        _filePath: filePath,
        _modelPref: meta.selectedModel || null,
      });
    } catch { /* skip */ }
  }
}

function peekMeta(filePath) {
  const ext = path.extname(filePath);
  if (ext === '.json') {
    try {
      const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      const firstText = data.requests?.[0]?.message?.text || '';
      return {
        sessionId: data.sessionId,
        title: data.customTitle || null,
        createdAt: data.creationDate || data.lastMessageDate,
        requestCount: data.requests?.length || 0,
        firstUserText: firstText.substring(0, 120) || null,
        selectedModel: data.inputState?.selectedModel?.metadata?.id || null,
      };
    } catch { return {}; }
  }
  // JSONL: read first line (kind:0) for session metadata + scan for customTitle
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const firstNewline = content.indexOf('\n');
    const firstLine = firstNewline > 0 ? content.substring(0, firstNewline) : content;
    const init = JSON.parse(firstLine);
    const state = init.v || {};
    let title = state.customTitle || null;
    // Scan for customTitle patch if not in init
    if (!title) {
      const titleIdx = content.indexOf('"customTitle"');
      if (titleIdx !== -1) {
        const lineStart = content.lastIndexOf('\n', titleIdx) + 1;
        const lineEnd = content.indexOf('\n', titleIdx);
        const patchLine = content.substring(lineStart, lineEnd > 0 ? lineEnd : undefined);
        try {
          const patch = JSON.parse(patchLine);
          if (patch.kind === 1 && patch.k[0] === 'customTitle') title = patch.v;
        } catch {}
      }
    }
    return {
      sessionId: state.sessionId,
      title,
      createdAt: state.creationDate,
      requestCount: null,
      firstUserText: null,
      selectedModel: state.inputState?.selectedModel?.metadata?.id || null,
    };
  } catch { return {}; }
}

function getMessages(chat) {
  if (!chat._filePath || !fs.existsSync(chat._filePath)) return [];

  const parsed = parseSessionFile(chat._filePath);
  if (!parsed) return [];

  const messages = [];
  for (const req of parsed.requests) {
    if (!req) continue;

    // User message
    let userText = '';
    if (parsed.format === 'json') {
      userText = req.message?.text || '';
    } else {
      // JSONL: user text is in result.metadata.renderedUserMessage
      userText = extractUserText(req.result?.metadata?.renderedUserMessage);
    }
    if (userText) {
      messages.push({ role: 'user', content: userText });
    }

    // Assistant response
    let responseText = '';
    let _toolCalls = [];
    if (parsed.format === 'json') {
      // Older format: response is array-like object
      const resp = req.response;
      if (resp) {
        const values = Object.values(resp);
        responseText = values.map(v => v.value || '').filter(Boolean).join('\n');
      }
    } else {
      // JSONL: response from codeBlocks or toolCallRounds
      const result = reconstructResponse(req.result?.metadata);
      if (typeof result === 'object' && result.text) {
        responseText = result.text;
        _toolCalls = result.toolCalls || [];
      } else {
        responseText = result || '';
      }
    }
    if (responseText) {
      const meta = req.result?.metadata;
      messages.push({
        role: 'assistant', content: responseText,
        _model: parsed.selectedModel || null,
        _inputTokens: meta?.promptTokens, _outputTokens: meta?.outputTokens,
        _toolCalls,
      });
    }
  }
  return messages;
}

const labels = { 'vscode': 'VS Code', 'vscode-insiders': 'VS Code Insiders' };

module.exports = { name, labels, getChats, getMessages };
