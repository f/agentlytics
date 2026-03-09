const { execSync, execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const Database = require('better-sqlite3');
const { getAppDataPath } = require('./base');

const HOME = os.homedir();
const ANTIGRAVITY_USER_DIR = path.join(getAppDataPath('Antigravity'), 'User');
const ANTIGRAVITY_GLOBAL_STORAGE_DB = path.join(ANTIGRAVITY_USER_DIR, 'globalStorage', 'state.vscdb');
const ANTIGRAVITY_BRAIN_DIR = path.join(HOME, '.gemini', 'antigravity', 'brain');
const OFFLINE_TRAJECTORY_SUMMARIES_KEYS = [
  'antigravityUnifiedStateSync.trajectorySummaries',
  'unifiedStateSync.trajectorySummaries',
];

// Static fallback for legacy placeholders no longer returned by the LS
const LEGACY_MODEL_MAP = {
  'MODEL_PLACEHOLDER_M1': 'Claude 3.5 Sonnet',
  'MODEL_PLACEHOLDER_M2': 'Claude 3.5 Sonnet',
  'MODEL_PLACEHOLDER_M3': 'Claude 3.5 Sonnet',
  'MODEL_PLACEHOLDER_M4': 'Claude 3.5 Haiku',
  'MODEL_PLACEHOLDER_M5': 'Claude 3.5 Haiku',
  'MODEL_PLACEHOLDER_M6': 'Claude 3.5 Haiku',
  'MODEL_PLACEHOLDER_M7': 'Claude 3.5 Sonnet',
  'MODEL_PLACEHOLDER_M8': 'Claude 3.5 Sonnet',
  'MODEL_PLACEHOLDER_M9': 'Claude 3.5 Sonnet',
  'MODEL_PLACEHOLDER_M10': 'Claude 3.5 Sonnet',
  'MODEL_CLAUDE_4_5_SONNET': 'Claude 4.5 Sonnet',
};

// Dynamic model map populated from GetUserStatus RPC (placeholder → friendly label)
let _modelMap = null;

function getModelMap() {
  if (_modelMap) return _modelMap;
  _modelMap = { ...LEGACY_MODEL_MAP };
  try {
    const resp = callRpc('GetUserStatus', {});
    const configs = resp?.userStatus?.cascadeModelConfigData?.clientModelConfigs || [];
    for (const c of configs) {
      const key = c.modelOrAlias?.model;
      const label = c.label;
      if (key && label) _modelMap[key] = label;
    }
  } catch {}
  return _modelMap;
}

// Convert friendly label → pricing-compatible model ID
// "Gemini 3.1 Pro (High)" → "gemini-3.1-pro"
// "Claude Sonnet 4.6 (Thinking)" → "claude-sonnet-4.6"
function labelToModelId(label) {
  return label
    .replace(/\s*\([^)]*\)\s*/g, '')  // strip "(High)", "(Thinking)", etc.
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-');             // spaces → dashes
}

function normalizeModel(modelId) {
  if (!modelId) return null;
  const map = getModelMap();
  const label = map[modelId];
  if (label) return labelToModelId(label);
  return modelId;
}

function fileUriToPath(uri) {
  try {
    const parsed = new URL(uri);
    if (parsed.protocol !== 'file:') return null;
    let filePath = decodeURIComponent(parsed.pathname);
    if (IS_WINDOWS && /^\/[A-Za-z]:/.test(filePath)) filePath = filePath.slice(1);
    return filePath || null;
  } catch {
    return null;
  }
}

function base64ToBytes(b64) {
  try {
    return Uint8Array.from(Buffer.from(String(b64 || '').trim(), 'base64'));
  } catch {
    return null;
  }
}

function bytesToUtf8(bytes) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

function readVarint(buf, offset) {
  let value = 0;
  let shift = 0;
  let i = offset;
  while (i < buf.length) {
    const b = buf[i];
    i += 1;
    value += (b & 0x7f) * (2 ** shift);
    if ((b & 0x80) === 0) return { value, offset: i };
    shift += 7;
    if (shift > 53) return null;
  }
  return null;
}

function readLengthDelimited(buf, offset) {
  const lenRes = readVarint(buf, offset);
  if (!lenRes) return null;
  const len = lenRes.value;
  const start = lenRes.offset;
  const end = start + len;
  if (end > buf.length) return null;
  return { bytes: buf.subarray(start, end), offset: end };
}

function skipField(buf, offset, wireType) {
  if (wireType === 0) {
    const v = readVarint(buf, offset);
    return v ? { offset: v.offset } : null;
  }
  if (wireType === 1) {
    const end = offset + 8;
    return end <= buf.length ? { offset: end } : null;
  }
  if (wireType === 2) {
    const ld = readLengthDelimited(buf, offset);
    return ld ? { offset: ld.offset } : null;
  }
  if (wireType === 5) {
    const end = offset + 4;
    return end <= buf.length ? { offset: end } : null;
  }
  return null;
}

function* iterAllUtf8StringsInProto(buf, maxDepth, depth = 0) {
  if (depth > maxDepth) return;
  let offset = 0;
  while (offset < buf.length) {
    const tagRes = readVarint(buf, offset);
    if (!tagRes) return;
    offset = tagRes.offset;

    const wireType = tagRes.value & 0x7;
    if (wireType !== 2) {
      const skipped = skipField(buf, offset, wireType);
      if (!skipped) return;
      offset = skipped.offset;
      continue;
    }

    const ld = readLengthDelimited(buf, offset);
    if (!ld) return;
    offset = ld.offset;

    const asString = bytesToUtf8(ld.bytes);
    if (asString !== null) yield asString;
    yield* iterAllUtf8StringsInProto(ld.bytes, maxDepth, depth + 1);
  }
}

function parseTimestampMessage(bytes) {
  let seconds = null;
  let nanos = 0;
  let offset = 0;

  while (offset < bytes.length) {
    const tagRes = readVarint(bytes, offset);
    if (!tagRes) return null;
    offset = tagRes.offset;

    const fieldNumber = tagRes.value >>> 3;
    const wireType = tagRes.value & 0x7;

    if (wireType === 0) {
      const valueRes = readVarint(bytes, offset);
      if (!valueRes) return null;
      offset = valueRes.offset;
      if (fieldNumber === 1) seconds = valueRes.value;
      if (fieldNumber === 2) nanos = valueRes.value;
      continue;
    }

    const skipped = skipField(bytes, offset, wireType);
    if (!skipped) return null;
    offset = skipped.offset;
  }

  if (seconds == null) return null;
  if (seconds < 946684800 || seconds > 4102444800) return null;
  if (nanos >= 1e9) nanos = 0;

  return Math.round((seconds * 1000) + (nanos / 1e6));
}

function findTimestampInProto(bytes, maxDepth = 2, depth = 0) {
  const direct = parseTimestampMessage(bytes);
  if (direct) return direct;
  if (depth >= maxDepth) return null;

  let offset = 0;
  while (offset < bytes.length) {
    const tagRes = readVarint(bytes, offset);
    if (!tagRes) return null;
    offset = tagRes.offset;

    const wireType = tagRes.value & 0x7;
    if (wireType !== 2) {
      const skipped = skipField(bytes, offset, wireType);
      if (!skipped) return null;
      offset = skipped.offset;
      continue;
    }

    const ld = readLengthDelimited(bytes, offset);
    if (!ld) return null;
    offset = ld.offset;

    const nested = findTimestampInProto(ld.bytes, maxDepth, depth + 1);
    if (nested) return nested;
  }

  return null;
}

function readGlobalStateValue(key) {
  if (!fs.existsSync(ANTIGRAVITY_GLOBAL_STORAGE_DB)) return null;

  let db = null;
  try {
    db = new Database(ANTIGRAVITY_GLOBAL_STORAGE_DB, { readonly: true, fileMustExist: true });
    const row = db.prepare('SELECT value FROM ItemTable WHERE key = ?').get(key);
    if (!row) return null;
    const v = row.value;
    if (typeof v === 'string') return v;
    if (Buffer.isBuffer(v) || v instanceof Uint8Array) return Buffer.from(v).toString('utf-8');
    return v == null ? null : String(v);
  } catch {
    return null;
  } finally {
    if (db) db.close();
  }
}

function extractFolderFromSummaryProtoBytes(summaryProtoBytes) {
  for (const s of iterAllUtf8StringsInProto(summaryProtoBytes, 6)) {
    const match = s.match(/#?file:\/\/[^\s\x00-\x1f"]+/);
    if (!match) continue;
    let uri = match[0];
    if (uri.startsWith('#')) uri = uri.slice(1);
    const folder = fileUriToPath(uri);
    if (folder) return folder;
  }
  return null;
}

function extractOfflineMetaFromSummaryProtoBytes(summaryProtoBytes) {
  let title = null;
  let primaryCount = 0;
  let secondaryCount = 0;
  const timestamps = [];

  let offset = 0;
  while (offset < summaryProtoBytes.length) {
    const tagRes = readVarint(summaryProtoBytes, offset);
    if (!tagRes) break;
    offset = tagRes.offset;

    const fieldNumber = tagRes.value >>> 3;
    const wireType = tagRes.value & 0x7;

    if (wireType === 0) {
      const valueRes = readVarint(summaryProtoBytes, offset);
      if (!valueRes) break;
      offset = valueRes.offset;
      if (fieldNumber === 2) primaryCount = valueRes.value;
      if (fieldNumber === 16) secondaryCount = valueRes.value;
      continue;
    }

    if (wireType === 2) {
      const ld = readLengthDelimited(summaryProtoBytes, offset);
      if (!ld) break;
      offset = ld.offset;

      if (fieldNumber === 1 && !title) {
        const text = bytesToUtf8(ld.bytes);
        if (text && text.trim()) title = text.trim();
        continue;
      }

      if (fieldNumber === 3 || fieldNumber === 7 || fieldNumber === 10 || fieldNumber === 15) {
        const ts = fieldNumber === 15 ? findTimestampInProto(ld.bytes, 2) : (parseTimestampMessage(ld.bytes) || findTimestampInProto(ld.bytes, 1));
        if (ts) timestamps.push(ts);
        continue;
      }

      continue;
    }

    const skipped = skipField(summaryProtoBytes, offset, wireType);
    if (!skipped) break;
    offset = skipped.offset;
  }

  const uniqueTimestamps = [...new Set(timestamps)].sort((a, b) => a - b);

  return {
    title,
    folder: extractFolderFromSummaryProtoBytes(summaryProtoBytes),
    bubbleCount: Math.max(primaryCount || 0, secondaryCount || 0),
    createdAt: uniqueTimestamps[0] || null,
    lastUpdatedAt: uniqueTimestamps[uniqueTimestamps.length - 1] || null,
  };
}

function buildOfflineMetaMapFromGlobalStateTrajectorySummariesValue(outerValueBase64) {
  const outerBytes = base64ToBytes(outerValueBase64);
  if (!outerBytes) return {};

  const chats = {};
  let offset = 0;

  while (offset < outerBytes.length) {
    const tagRes = readVarint(outerBytes, offset);
    if (!tagRes) break;
    offset = tagRes.offset;

    const fieldNumber = tagRes.value >>> 3;
    const wireType = tagRes.value & 0x7;
    if (fieldNumber !== 1 || wireType !== 2) {
      const skipped = skipField(outerBytes, offset, wireType);
      if (!skipped) break;
      offset = skipped.offset;
      continue;
    }

    const entryLd = readLengthDelimited(outerBytes, offset);
    if (!entryLd) break;
    offset = entryLd.offset;

    let composerId = null;
    let summaryBase64 = null;
    let entryOffset = 0;

    while (entryOffset < entryLd.bytes.length) {
      const entryTag = readVarint(entryLd.bytes, entryOffset);
      if (!entryTag) break;
      entryOffset = entryTag.offset;

      const entryField = entryTag.value >>> 3;
      const entryWire = entryTag.value & 0x7;

      if (entryField === 1 && entryWire === 2) {
        const keyLd = readLengthDelimited(entryLd.bytes, entryOffset);
        if (!keyLd) break;
        entryOffset = keyLd.offset;
        composerId = bytesToUtf8(keyLd.bytes);
        continue;
      }

      if (entryField === 2 && entryWire === 2) {
        const valueLd = readLengthDelimited(entryLd.bytes, entryOffset);
        if (!valueLd) break;
        entryOffset = valueLd.offset;

        let valueOffset = 0;
        while (valueOffset < valueLd.bytes.length) {
          const valueTag = readVarint(valueLd.bytes, valueOffset);
          if (!valueTag) break;
          valueOffset = valueTag.offset;

          const valueField = valueTag.value >>> 3;
          const valueWire = valueTag.value & 0x7;
          if (valueField === 1 && valueWire === 2) {
            const summaryLd = readLengthDelimited(valueLd.bytes, valueOffset);
            if (!summaryLd) break;
            valueOffset = summaryLd.offset;
            summaryBase64 = bytesToUtf8(summaryLd.bytes);
            break;
          }

          const skipped = skipField(valueLd.bytes, valueOffset, valueWire);
          if (!skipped) break;
          valueOffset = skipped.offset;
        }

        continue;
      }

      const skipped = skipField(entryLd.bytes, entryOffset, entryWire);
      if (!skipped) break;
      entryOffset = skipped.offset;
    }

    if (!composerId || !summaryBase64) continue;
    const summaryProtoBytes = base64ToBytes(summaryBase64);
    if (!summaryProtoBytes) continue;

    chats[composerId] = extractOfflineMetaFromSummaryProtoBytes(summaryProtoBytes);
  }

  return chats;
}

function getOfflineChats() {
  for (const key of OFFLINE_TRAJECTORY_SUMMARIES_KEYS) {
    const value = readGlobalStateValue(key);
    if (!value) continue;

    const map = buildOfflineMetaMapFromGlobalStateTrajectorySummariesValue(value);
    const chats = Object.entries(map).map(([composerId, meta]) => ({
      source: 'antigravity',
      composerId,
      name: meta.title || null,
      createdAt: meta.createdAt || null,
      lastUpdatedAt: meta.lastUpdatedAt || null,
      mode: 'cascade',
      folder: meta.folder || null,
      encrypted: false,
      bubbleCount: meta.bubbleCount || 0,
      _stepCount: meta.bubbleCount || 0,
      _type: 'antigravity-offline',
      _dbPath: ANTIGRAVITY_GLOBAL_STORAGE_DB,
      _rawSource: 'offline-global-state',
    }));

    if (chats.length > 0) {
      return chats.sort((a, b) => (b.lastUpdatedAt || b.createdAt || 0) - (a.lastUpdatedAt || a.createdAt || 0));
    }
  }

  return [];
}

function mergeChats(liveChats, offlineChats) {
  if (liveChats.length === 0) return offlineChats;
  if (offlineChats.length === 0) return liveChats;

  const map = new Map();

  for (const chat of offlineChats) {
    map.set(chat.composerId, { ...chat });
  }

  for (const chat of liveChats) {
    const existing = map.get(chat.composerId);
    if (!existing) {
      map.set(chat.composerId, chat);
      continue;
    }

    map.set(chat.composerId, {
      ...existing,
      ...chat,
      name: chat.name || existing.name,
      createdAt: chat.createdAt || existing.createdAt,
      lastUpdatedAt: chat.lastUpdatedAt || existing.lastUpdatedAt,
      folder: chat.folder || existing.folder,
      bubbleCount: chat.bubbleCount || existing.bubbleCount,
      _stepCount: chat._stepCount || existing._stepCount,
    });
  }

  return Array.from(map.values()).sort((a, b) => (b.lastUpdatedAt || b.createdAt || 0) - (a.lastUpdatedAt || a.createdAt || 0));
}

function readOfflineArtifactMessages(chat) {
  const noDataMsg = [{
    role: 'system',
    content: 'Offline metadata was found for this Antigravity session, but no local artifact files were available. Start Antigravity to fetch the full conversation transcript.',
  }];

  const brainDir = path.join(ANTIGRAVITY_BRAIN_DIR, chat.composerId);
  if (!fs.existsSync(brainDir)) return noDataMsg;

  const artifactNames = ['task.md', 'implementation_plan.md', 'walkthrough.md'];
  const messages = [{
    role: 'system',
    content: 'Partial offline Antigravity view from local artifact files. Start Antigravity to load full cascade step history.',
  }];

  for (const artifactName of artifactNames) {
    const artifactPath = path.join(brainDir, artifactName);
    if (!fs.existsSync(artifactPath)) continue;

    let content = null;
    try {
      content = fs.readFileSync(artifactPath, 'utf-8').trim();
    } catch {
      content = null;
    }
    if (!content) continue;

    let meta = null;
    try { meta = JSON.parse(fs.readFileSync(`${artifactPath}.metadata.json`, 'utf-8')); } catch {}
    const header = [`# Offline Artifact: ${artifactName}`];
    if (meta?.summary) header.push(`Summary: ${meta.summary}`);
    if (meta?.updatedAt) header.push(`Updated: ${meta.updatedAt}`);
    header.push('');

    messages.push({
      role: 'assistant',
      content: `${header.join('\n')}${content}`,
    });
  }

  return messages.length > 1 ? messages : noDataMsg;
}

// ============================================================
// Cross-platform process utilities
// ============================================================

const IS_WINDOWS = process.platform === 'win32';

function getProcessList() {
  try {
    if (IS_WINDOWS) {
      // Use PowerShell Get-Process (WMIC is deprecated in Windows 10/11)
      const output = execFileSync('powershell', ['-Command', 'Get-Process | Select-Object Id, Path, CommandLine | ConvertTo-Csv -NoTypeInformation'], {
        encoding: 'utf-8',
        maxBuffer: 10 * 1024 * 1024,
      });
      // Parse CSV: skip header
      const lines = output.split('\n').slice(1);
      return lines.map(line => {
        const parts = line.split(',');
        if (parts.length < 3) return null;
        const pid = parts[0].trim().replace(/^"|"$/g, '');
        const commandLine = parts[2].trim().replace(/^"|"$/g, '');
        if (!pid || !commandLine) return null;
        return { commandLine, pid };
      }).filter(Boolean);
    } else {
      const output = execSync('ps aux', { encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024 });
      return output.split('\n').slice(1).map(line => {
        const parts = line.trim().split(/\s+/);
        if (parts.length < 11) return null;
        const pid = parts[1];
        const commandLine = parts.slice(10).join(' ');
        return { commandLine, pid };
      }).filter(Boolean);
    }
  } catch { return []; }
}

function getListeningPorts(pid) {
  try {
    if (IS_WINDOWS) {
      // Use PowerShell to get netstat output and filter by PID
      const output = execFileSync('powershell', ['-Command', `netstat -ano | Select-String "${pid}$"`], {
        encoding: 'utf-8',
        maxBuffer: 10 * 1024 * 1024,
      });
      const ports = [];
      for (const line of output.split('\n')) {
        if (!line.trim().endsWith(pid)) continue;
        const match = line.match(/127\.0\.0\.1:(\d+).*LISTENING/);
        if (match) {
          ports.push(parseInt(match[1]));
        }
      }
      return ports;
    } else {
      const output = execSync(`lsof -i TCP -P -n -a -p ${pid} 2>/dev/null`, {
        encoding: 'utf-8',
        maxBuffer: 10 * 1024 * 1024,
      });
      const ports = [];
      for (const line of output.split('\n')) {
        const match = line.match(/TCP\s+127\.0\.0\.1:(\d+)\s+\(LISTEN\)/);
        if (match) {
          ports.push(parseInt(match[1]));
        }
      }
      return ports;
    }
  } catch { return []; }
}

// ============================================================
// Find running Antigravity language server (port + CSRF token)
// ============================================================

let _lsCache = null;
let _lsCacheCheckedAt = 0;

function findLanguageServer() {
  if (_lsCache !== null && (Date.now() - _lsCacheCheckedAt) < 10000) return _lsCache || null;

  const serverProcessName = IS_WINDOWS
    ? 'language_server_windows'
    : process.platform === 'darwin'
      ? 'language_server_macos'
      : 'language_server_linux';

  for (const proc of getProcessList()) {
    const { commandLine, pid } = proc;
    if (!commandLine.includes(serverProcessName)) continue;

    const appDirMatch = commandLine.match(/--app_data_dir\s+(\S+)/);
    if (!appDirMatch || !appDirMatch[1].includes('antigravity')) continue;

    const csrfMatch = commandLine.match(/--csrf_token\s+(\S+)/);
    if (!csrfMatch) continue;

    const serverPortMatch = commandLine.match(/--server_port\s+(\d+)/);
    const ports = getListeningPorts(pid);
    if (ports.length === 0) continue;

    let port;
    if (serverPortMatch) {
      port = parseInt(serverPortMatch[1], 10);
      if (!ports.includes(port)) port = Math.min(...ports);
    } else {
      port = Math.min(...ports);
    }

    _lsCache = { port, csrf: csrfMatch[1], pid };
    _lsCacheCheckedAt = Date.now();
    return _lsCache;
  }

  _lsCache = false;
  _lsCacheCheckedAt = Date.now();
  return null;
}

// ============================================================
// Connect protocol HTTP client (always HTTPS, always main CSRF)
// ============================================================

function callRpc(method, body) {
  const ls = findLanguageServer();
  if (!ls) return null;

  const data = JSON.stringify(body || {});
  const url = `https://127.0.0.1:${ls.port}/exa.language_server_pb.LanguageServerService/${method}`;

  try {
    const result = execSync(
      `curl -s -k -X POST ${JSON.stringify(url)} ` +
      `-H "Content-Type: application/json" ` +
      `-H "x-codeium-csrf-token: ${ls.csrf}" ` +
      `-d ${JSON.stringify(data)} ` +
      `--max-time 10`,
      { encoding: 'utf-8', maxBuffer: 50 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'] }
    );
    return JSON.parse(result);
  } catch { return null; }
}

// ============================================================
// Adapter interface
// ============================================================

const name = 'antigravity';

function getChats() {
  const resp = callRpc('GetAllCascadeTrajectories', {});
  const liveChats = [];

  if (resp && resp.trajectorySummaries) {
    for (const [cascadeId, summary] of Object.entries(resp.trajectorySummaries)) {
      const ws = (summary.workspaces || [])[0];
      const folder = ws?.workspaceFolderAbsoluteUri?.replace('file://', '') || null;
      const rawModel = summary.lastGeneratorModelUid;
      liveChats.push({
        source: 'antigravity',
        composerId: cascadeId,
        name: summary.summary || null,
        createdAt: summary.createdTime ? new Date(summary.createdTime).getTime() : null,
        lastUpdatedAt: summary.lastModifiedTime ? new Date(summary.lastModifiedTime).getTime() : null,
        mode: 'cascade',
        folder,
        encrypted: false,
        bubbleCount: summary.stepCount || 0,
        _stepCount: summary.stepCount,
        _model: rawModel ? normalizeModel(rawModel) : rawModel,
        _rawModel: rawModel,
      });
    }
  }

  return mergeChats(liveChats, getOfflineChats());
}

function getSteps(chat) {
  // Prefer GetCascadeTrajectorySteps (returns more steps than GetCascadeTrajectory)
  const resp = callRpc('GetCascadeTrajectorySteps', { cascadeId: chat.composerId });
  if (resp && resp.steps && resp.steps.length > 0) return resp.steps;

  // Fallback to old method
  const resp2 = callRpc('GetCascadeTrajectory', { cascadeId: chat.composerId });
  if (resp2 && resp2.trajectory && resp2.trajectory.steps) return resp2.trajectory.steps;

  return [];
}

/**
 * Get the tail messages beyond the step limit using generatorMetadata.
 * The last generatorMetadata entry with messagePrompts has the conversation context.
 * We find the overlap with step-based messages by matching the last user message content.
 */
function getTailMessages(chat, stepMessages) {
  const resp = callRpc('GetCascadeTrajectory', { cascadeId: chat.composerId });
  if (!resp || !resp.trajectory) return [];

  const gm = resp.trajectory.generatorMetadata || [];
  // Find the last entry that has messagePrompts
  let lastWithMsgs = null;
  for (let i = gm.length - 1; i >= 0; i--) {
    if (gm[i].chatModel && gm[i].chatModel.messagePrompts && gm[i].chatModel.messagePrompts.length > 0) {
      lastWithMsgs = gm[i];
      break;
    }
  }
  if (!lastWithMsgs) return [];

  const mp = lastWithMsgs.chatModel.messagePrompts;

  // Find the last user message from step-based parsing
  let lastUserContent = '';
  for (let i = stepMessages.length - 1; i >= 0; i--) {
    if (stepMessages[i].role === 'user' && stepMessages[i].content.length > 20) {
      lastUserContent = stepMessages[i].content;
      break;
    }
  }
  if (!lastUserContent) return [];

  // Find this message in the messagePrompts (search from end for efficiency)
  const needle = lastUserContent.substring(0, 50);
  let matchIdx = -1;
  for (let i = mp.length - 1; i >= 0; i--) {
    if (mp[i].source === 'CHAT_MESSAGE_SOURCE_USER' && mp[i].prompt && mp[i].prompt.includes(needle)) {
      matchIdx = i;
      break;
    }
  }
  if (matchIdx < 0 || matchIdx >= mp.length - 1) return [];

  // Convert everything after the match point to messages
  const tail = [];
  for (let i = matchIdx + 1; i < mp.length; i++) {
    const m = mp[i];
    const src = m.source || '';
    const prompt = m.prompt || '';
    if (!prompt || !prompt.trim()) continue;

    let role;
    if (src === 'CHAT_MESSAGE_SOURCE_USER') role = 'user';
    else if (src === 'CHAT_MESSAGE_SOURCE_SYSTEM') role = 'assistant';
    else if (src === 'CHAT_MESSAGE_SOURCE_TOOL') role = 'tool';
    else continue;

    tail.push({ role, content: prompt });
  }
  return tail;
}

function parseStep(step) {
  const type = step.type || '';
  const meta = step.metadata || {};

  if (type === 'CORTEX_STEP_TYPE_USER_INPUT' && step.userInput) {
    return {
      role: 'user',
      content: step.userInput.userResponse || step.userInput.items?.map(i => i.text).join('') || '',
    };
  }

  if (type === 'CORTEX_STEP_TYPE_ASK_USER_QUESTION' && step.askUserQuestion) {
    const q = step.askUserQuestion;
    return {
      role: 'user',
      content: q.userResponse || q.question || '',
    };
  }

  if (type === 'CORTEX_STEP_TYPE_PLANNER_RESPONSE' && step.plannerResponse) {
    const pr = step.plannerResponse;
    const parts = [];
    if (pr.thinking) parts.push(`[thinking] ${pr.thinking}`);
    const text = pr.modifiedResponse || pr.response || pr.textContent || '';
    if (text.trim()) parts.push(text.trim());
    const _toolCalls = [];
    if (pr.toolCalls && pr.toolCalls.length > 0) {
      for (const tc of pr.toolCalls) {
        let args = {};
        try { args = tc.argumentsJson ? JSON.parse(tc.argumentsJson) : {}; } catch { args = {}; }
        const argKeys = typeof args === 'object' ? Object.keys(args).join(', ') : '';
        parts.push(`[tool-call: ${tc.name}(${argKeys})]`);
        _toolCalls.push({ name: tc.name, args });
      }
    }
    if (parts.length > 0) {
      const model = meta.generatorModel || meta.generatorModelUid;
      return {
        role: 'assistant',
        content: parts.join('\n'),
        _model: model ? normalizeModel(model) : model,
        _toolCalls,
      };
    }
    return null;
  }

  // Tool-like step types
  if (type === 'CORTEX_STEP_TYPE_TOOL_EXECUTION' && step.toolExecution) {
    const te = step.toolExecution;
    const toolName = te.toolName || te.name || 'tool';
    const result = te.output || te.result || '';
    const preview = typeof result === 'string' ? result.substring(0, 500) : JSON.stringify(result).substring(0, 500);
    return { role: 'tool', content: `[${toolName}] ${preview}` };
  }

  if (type === 'CORTEX_STEP_TYPE_RUN_COMMAND' && step.runCommand) {
    const rc = step.runCommand;
    const cmd = rc.command || rc.commandLine || '';
    const out = (rc.output || rc.stdout || '').substring(0, 500);
    return { role: 'tool', content: `[run_command] ${cmd}${out ? '\n' + out : ''}` };
  }

  if (type === 'CORTEX_STEP_TYPE_COMMAND_STATUS' && step.commandStatus) {
    const cs = step.commandStatus;
    const out = (cs.output || cs.stdout || '').substring(0, 500);
    return out ? { role: 'tool', content: `[command_status] ${out}` } : null;
  }

  if (type === 'CORTEX_STEP_TYPE_VIEW_FILE' && step.viewFile) {
    const vf = step.viewFile;
    const filePath = vf.filePath || vf.path || '';
    return { role: 'tool', content: `[view_file] ${filePath}` };
  }

  if (type === 'CORTEX_STEP_TYPE_CODE_ACTION' && step.codeAction) {
    const ca = step.codeAction;
    const filePath = ca.filePath || ca.path || '';
    return { role: 'tool', content: `[code_action] ${filePath}` };
  }

  if (type === 'CORTEX_STEP_TYPE_GREP_SEARCH' && step.grepSearch) {
    const gs = step.grepSearch;
    const query = gs.query || gs.pattern || '';
    return { role: 'tool', content: `[grep_search] ${query}` };
  }

  if (type === 'CORTEX_STEP_TYPE_LIST_DIRECTORY' && step.listDirectory) {
    const ld = step.listDirectory;
    const dir = ld.directoryPath || ld.path || '';
    return { role: 'tool', content: `[list_directory] ${dir}` };
  }

  if (type === 'CORTEX_STEP_TYPE_MCP_TOOL' && step.mcpTool) {
    const mt = step.mcpTool;
    const name = mt.toolName || mt.name || 'mcp_tool';
    return { role: 'tool', content: `[${name}]` };
  }

  // Skip non-content steps
  if (type === 'CORTEX_STEP_TYPE_CHECKPOINT' || type === 'CORTEX_STEP_TYPE_RETRIEVE_MEMORY' ||
      type === 'CORTEX_STEP_TYPE_MEMORY' || type === 'CORTEX_STEP_TYPE_TODO_LIST' ||
      type === 'CORTEX_STEP_TYPE_EXIT_PLAN_MODE' || type === 'CORTEX_STEP_TYPE_PROXY_WEB_SERVER') {
    return null;
  }

  return null;
}

function getMessages(chat) {
  const steps = getSteps(chat);
  const messages = [];
  for (const step of steps) {
    const msg = parseStep(step);
    if (msg) messages.push(msg);
  }

  // If steps are truncated, fill in the tail from generatorMetadata
  const tail = getTailMessages(chat, messages);
  if (tail.length > 0) {
    messages.push(...tail);
  }

  if (messages.length > 0) return messages;
  return readOfflineArtifactMessages(chat);
}

// ============================================================
// Usage / quota data from language server RPC
// ============================================================

function getUsage() {
  const resp = callRpc('GetUserStatus', {});
  if (!resp || !resp.userStatus) return null;

  const us = resp.userStatus;
  const ps = us.planStatus || {};
  const pi = ps.planInfo || {};
  const modelConfigs = (us.cascadeModelConfigData || {}).clientModelConfigs || [];

  const models = modelConfigs.map((m) => {
    const qi = m.quotaInfo || {};
    return {
      label: m.label || null,
      model: m.modelOrAlias?.model || null,
      remainingFraction: qi.remainingFraction != null ? qi.remainingFraction : null,
      resetTime: qi.resetTime || null,
      supportsImages: m.supportsImages || false,
    };
  });

  // Antigravity returns credits already in display units (no ÷100 needed)
  const promptAlloc = ps.availablePromptCredits || 0;
  const promptUsed = ps.usedPromptCredits || 0;
  const flexAlloc = ps.availableFlexCredits || 0;
  const flexUsed = ps.usedFlexCredits || 0;
  const flowAlloc = ps.availableFlowCredits || 0;

  const remainingPrompt = Math.max(0, promptAlloc - promptUsed);
  const remainingFlex = Math.max(0, flexAlloc - flexUsed);
  const totalRemaining = remainingPrompt + remainingFlex;

  // Credit multipliers per model
  const creditMultipliers = (pi.creditMultiplierOverrides || []).reduce((acc, entry) => {
    const model = entry.modelOrAlias?.model;
    if (model && entry.creditMultiplier != null) acc[model] = entry.creditMultiplier;
    return acc;
  }, {});

  return {
    source: 'antigravity',
    plan: {
      name: pi.planName || null,
      tier: pi.teamsTier || null,
      monthlyPromptCredits: (pi.monthlyPromptCredits || 0) / 100,
      monthlyFlowCredits: (pi.monthlyFlowCredits || 0) / 100,
      canBuyMoreCredits: pi.canBuyMoreCredits || false,
    },
    usage: {
      promptCredits: { allocated: promptAlloc, used: promptUsed, remaining: remainingPrompt },
      flexCredits: { allocated: flexAlloc, used: flexUsed, remaining: remainingFlex },
      flowCredits: { allocated: flowAlloc },
      totalRemainingCredits: totalRemaining,
    },
    billingCycle: {
      start: ps.planStart || null,
      end: ps.planEnd || null,
    },
    features: {
      webSearch: pi.cascadeWebSearchEnabled || false,
      browser: pi.browserEnabled || false,
      knowledgeBase: pi.knowledgeBaseEnabled || false,
      autoRunCommands: pi.cascadeCanAutoRunCommands || false,
      commitMessages: pi.canGenerateCommitMessages || false,
    },
    models,
    creditMultipliers,
    user: {
      name: us.name || null,
      email: us.email || null,
    },
  };
}

function resetCache() { _lsCache = null; _lsCacheCheckedAt = 0; _modelMap = null; }

const labels = { 'antigravity': 'Antigravity' };

module.exports = { name, labels, getChats, getMessages, resetCache, getUsage };
