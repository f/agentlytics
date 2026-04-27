const path = require('path');
const fs = require('fs');
const os = require('os');

// ============================================================
// Codebuff adapter
// ------------------------------------------------------------
// Codebuff persists chats under ~/.config/manicode (the legacy folder name
// — the product was previously called Manicode). Non-prod builds use
// manicode-dev / manicode-staging. Layout:
//
//   ~/.config/manicode/projects/<projectBasename>/chats/<chatId>/
//     ├── chat-messages.json   // serialized ChatMessage[]
//     ├── run-state.json       // SDK RunState (has real `cwd`)
//     └── log.jsonl            // internal logs (ignored)
//
// chatId is an ISO timestamp with ':' replaced by '-'. We use
// "<projectBasename>::<chatId>" as composerId to avoid collisions when
// two different projects share the same folder basename.
// ============================================================

const HOME = os.homedir();

function getProjectRoots() {
  const roots = [];
  for (const variant of ['manicode', 'manicode-dev', 'manicode-staging']) {
    const projectsDir = path.join(HOME, '.config', variant, 'projects');
    if (fs.existsSync(projectsDir)) roots.push({ variant, projectsDir });
  }
  return roots;
}

function safeReadJson(filePath) {
  try { return JSON.parse(fs.readFileSync(filePath, 'utf-8')); } catch { return null; }
}

function parseChatIdToTs(chatId) {
  // Codebuff chatIds look like "2026-04-21T16-34-12.000Z" — reverse the
  // substitution so we get a real ISO timestamp back.
  if (!chatId) return null;
  const iso = chatId.replace(/(\d{4}-\d{2}-\d{2}T\d{2})-(\d{2})-(\d{2})/, '$1:$2:$3');
  const ts = Date.parse(iso);
  return Number.isFinite(ts) ? ts : null;
}

function cleanPrompt(text) {
  if (!text) return null;
  const clean = String(text).replace(/\s+/g, ' ').trim().substring(0, 120);
  return clean || null;
}

function extractCwdFromRunState(runState) {
  if (!runState) return null;
  // Common shapes: { sessionState: { ... cwd }, output } or { cwd } at root.
  const candidates = [
    runState?.sessionState?.projectContext?.cwd,
    runState?.sessionState?.fileContext?.cwd,
    runState?.sessionState?.cwd,
    runState?.cwd,
  ];
  for (const c of candidates) if (typeof c === 'string' && c) return c;
  return null;
}

// --- Best-effort model / token extraction ---

function pickNumber(...vals) {
  for (const v of vals) {
    if (typeof v === 'number' && Number.isFinite(v)) return v;
  }
  return undefined;
}

function extractUsageFromMetadata(meta) {
  if (!meta || typeof meta !== 'object') return {};
  const cb = meta.codebuff && typeof meta.codebuff === 'object' ? meta.codebuff : null;
  const usage = (cb && cb.usage) || meta.usage || null;
  if (!usage || typeof usage !== 'object') return {};
  return {
    inputTokens: pickNumber(usage.inputTokens, usage.promptTokens, usage.prompt_tokens, usage.input_tokens),
    outputTokens: pickNumber(usage.outputTokens, usage.completionTokens, usage.completion_tokens, usage.output_tokens),
    cacheRead: pickNumber(
      usage.cacheReadInputTokens, usage.cache_read_input_tokens,
      usage?.promptTokensDetails?.cachedTokens, usage?.prompt_tokens_details?.cached_tokens,
    ),
    cacheWrite: pickNumber(
      usage.cacheCreationInputTokens, usage.cache_creation_input_tokens,
      usage.cachedTokensCreated,
    ),
  };
}

function extractMessageUsageAndModel(msg) {
  // Codebuff ChatMessage shape allows metadata.runState to stash the SDK
  // RunState after completion. Model + usage isn't guaranteed to be there
  // but we try a few known spots.
  const out = { model: undefined, inputTokens: undefined, outputTokens: undefined, cacheRead: undefined, cacheWrite: undefined };
  const meta = msg?.metadata;
  if (!meta || typeof meta !== 'object') return out;

  // Direct provider hints some Codebuff builds attach.
  if (typeof meta.model === 'string') out.model = meta.model;
  if (typeof meta.modelId === 'string' && !out.model) out.model = meta.modelId;

  // Token totals may live on metadata.usage or inside providerMetadata.
  const usageDirect = extractUsageFromMetadata(meta);
  Object.assign(out, {
    inputTokens: out.inputTokens ?? usageDirect.inputTokens,
    outputTokens: out.outputTokens ?? usageDirect.outputTokens,
    cacheRead: out.cacheRead ?? usageDirect.cacheRead,
    cacheWrite: out.cacheWrite ?? usageDirect.cacheWrite,
  });

  // Walk the RunState stash for the most recent assistant message with
  // providerOptions that carry OpenRouter-style usage.
  const rs = meta.runState;
  if (rs && typeof rs === 'object') {
    const history = rs?.sessionState?.mainAgentState?.messageHistory;
    if (Array.isArray(history)) {
      for (let i = history.length - 1; i >= 0; i--) {
        const m = history[i];
        if (m?.role !== 'assistant') continue;
        const po = m.providerOptions;
        const u = extractUsageFromMetadata(po);
        if (u.inputTokens != null || u.outputTokens != null) {
          out.inputTokens = out.inputTokens ?? u.inputTokens;
          out.outputTokens = out.outputTokens ?? u.outputTokens;
          out.cacheRead = out.cacheRead ?? u.cacheRead;
          out.cacheWrite = out.cacheWrite ?? u.cacheWrite;
          if (!out.model && typeof po?.codebuff?.model === 'string') out.model = po.codebuff.model;
          break;
        }
      }
    }
  }

  return out;
}

// --- Block flattening: turn Codebuff ChatMessage blocks into a single
// transcript-style content string + normalized tool-call list. ---

function flattenBlocks(blocks, out = { parts: [], toolCalls: [] }, depth = 0) {
  if (!Array.isArray(blocks)) return out;
  const indent = depth ? '  '.repeat(depth) : '';
  for (const block of blocks) {
    if (!block || typeof block !== 'object') continue;
    switch (block.type) {
      case 'text': {
        if (typeof block.content !== 'string' || !block.content) break;
        if (block.textType === 'reasoning') {
          out.parts.push(`${indent}[thinking] ${block.content}`);
        } else {
          out.parts.push(`${indent}${block.content}`);
        }
        break;
      }
      case 'tool': {
        const toolName = block.toolName || 'tool';
        const input = block.input || {};
        const argKeys = (input && typeof input === 'object') ? Object.keys(input).join(', ') : '';
        out.parts.push(`${indent}[tool-call: ${toolName}(${argKeys})]`);
        out.toolCalls.push({ name: toolName, args: input });
        if (typeof block.output === 'string' && block.output) {
          out.parts.push(`${indent}[tool-result] ${block.output.substring(0, 500)}`);
        }
        break;
      }
      case 'agent': {
        const name = block.agentName || block.agentType || 'agent';
        const status = block.status ? ` (${block.status})` : '';
        out.parts.push(`${indent}[subagent: ${name}${status}]`);
        if (typeof block.content === 'string' && block.content) {
          out.parts.push(`${indent}  ${block.content}`);
        }
        flattenBlocks(block.blocks, out, depth + 1);
        break;
      }
      case 'plan': {
        if (typeof block.content === 'string' && block.content) {
          out.parts.push(`${indent}[plan]\n${block.content}`);
        }
        break;
      }
      case 'mode-divider': {
        if (block.mode) out.parts.push(`${indent}[mode: ${block.mode}]`);
        break;
      }
      case 'ask-user': {
        const qs = Array.isArray(block.questions) ? block.questions : [];
        for (const q of qs) {
          if (q?.question) out.parts.push(`${indent}[ask-user] ${q.question}`);
        }
        break;
      }
      case 'image': {
        out.parts.push(`${indent}[image${block.filename ? `: ${block.filename}` : ''}]`);
        break;
      }
      default:
        break;
    }
  }
  return out;
}

// ============================================================
// Adapter interface
// ============================================================

const name = 'codebuff';
const labels = { 'codebuff': 'Codebuff' };

function getChats() {
  const chats = [];
  const roots = getProjectRoots();
  if (roots.length === 0) return chats;

  for (const { variant, projectsDir } of roots) {
    let projectDirs;
    try { projectDirs = fs.readdirSync(projectsDir); } catch { continue; }
    // Only the non-prod variants get prefixed so the prod composerId stays clean.
    const variantPrefix = variant === 'manicode' ? '' : `${variant}::`;

    for (const projectBase of projectDirs) {
      const projectDir = path.join(projectsDir, projectBase);
      try { if (!fs.statSync(projectDir).isDirectory()) continue; } catch { continue; }

      const chatsDir = path.join(projectDir, 'chats');
      if (!fs.existsSync(chatsDir)) continue;

      let chatIds;
      try { chatIds = fs.readdirSync(chatsDir); } catch { continue; }

      for (const chatId of chatIds) {
        const chatDir = path.join(chatsDir, chatId);
        let dirStat;
        try { dirStat = fs.statSync(chatDir); } catch { continue; }
        if (!dirStat.isDirectory()) continue;

        const messagesPath = path.join(chatDir, 'chat-messages.json');
        if (!fs.existsSync(messagesPath)) continue;

        // Light peek for title + message count — don't hydrate blocks here.
        const messages = safeReadJson(messagesPath);
        if (!Array.isArray(messages) || messages.length === 0) continue;

        const firstUser = messages.find((m) => m && m.variant === 'user' && typeof m.content === 'string');
        const title = cleanPrompt(firstUser && firstUser.content);

        // Recover the real cwd so Agentlytics can group by project correctly.
        const runState = safeReadJson(path.join(chatDir, 'run-state.json'));
        const folder = extractCwdFromRunState(runState) || null;

        chats.push({
          source: 'codebuff',
          composerId: `${variantPrefix}${projectBase}::${chatId}`,
          name: title,
          createdAt: parseChatIdToTs(chatId),
          lastUpdatedAt: dirStat.mtime.getTime(),
          mode: 'codebuff',
          folder,
          encrypted: false,
          bubbleCount: messages.length,
          _fullPath: chatDir,
        });
      }
    }
  }

  return chats;
}

function getMessages(chat) {
  const chatDir = chat._fullPath;
  if (!chatDir) return [];
  const messagesPath = path.join(chatDir, 'chat-messages.json');
  if (!fs.existsSync(messagesPath)) return [];

  const raw = safeReadJson(messagesPath);
  if (!Array.isArray(raw)) return [];

  const out = [];
  for (const msg of raw) {
    if (!msg || typeof msg !== 'object') continue;
    const variant = msg.variant;

    if (variant === 'user') {
      const content = typeof msg.content === 'string' ? msg.content : '';
      if (content) out.push({ role: 'user', content });
      continue;
    }

    if (variant === 'error') {
      const content = typeof msg.content === 'string' ? msg.content : '';
      if (content) out.push({ role: 'system', content: `[error] ${content}` });
      continue;
    }

    if (variant === 'ai' || variant === 'agent') {
      const flattened = flattenBlocks(msg.blocks);
      const parts = [];
      if (typeof msg.content === 'string' && msg.content) parts.push(msg.content);
      if (flattened.parts.length) parts.push(flattened.parts.join('\n'));
      const content = parts.join('\n').trim();
      if (!content) continue;

      const { model, inputTokens, outputTokens, cacheRead, cacheWrite } = extractMessageUsageAndModel(msg);

      out.push({
        role: 'assistant',
        content,
        _model: model,
        _inputTokens: inputTokens,
        _outputTokens: outputTokens,
        _cacheRead: cacheRead,
        _cacheWrite: cacheWrite,
        _toolCalls: flattened.toolCalls.length ? flattened.toolCalls : undefined,
        _credits: typeof msg.credits === 'number' ? msg.credits : undefined,
      });
      continue;
    }
  }

  return out;
}

function getArtifacts(folder) {
  const { scanArtifacts } = require('./base');
  return scanArtifacts(folder, {
    editor: 'codebuff',
    label: 'Codebuff',
    files: ['.codebuffignore', '.manicodeignore', 'knowledge.md'],
    dirs: ['.agents'],
  });
}

module.exports = { name, labels, getChats, getMessages, getArtifacts };
