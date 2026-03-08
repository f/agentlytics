const path = require('path');
const fs = require('fs');
const os = require('os');
const { execSync } = require('child_process');
const http = require('http');

const HOME = os.homedir();

// Windsurf-family variants: Windsurf, Windsurf Next, Antigravity
const VARIANTS = [
  { id: 'windsurf', matchKey: 'ide', matchVal: 'windsurf', https: false },
  { id: 'windsurf-next', matchKey: 'ide', matchVal: 'windsurf-next', https: false },
  { id: 'antigravity', matchKey: 'appDataDir', matchVal: 'antigravity', https: true },
];

// ============================================================
// Find running Windsurf language server (port + CSRF token)
// ============================================================

let _lsCache = null;

function findLanguageServers() {
  if (_lsCache) return _lsCache;
  _lsCache = [];
  try {
    const ps = execSync('ps aux', { encoding: 'utf-8', maxBuffer: 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'] });
    for (const line of ps.split('\n')) {
      if (!line.includes('language_server_macos') || !line.includes('--csrf_token')) continue;
      const csrfMatch = line.match(/--csrf_token\s+(\S+)/);
      const ideMatch = line.match(/--ide_name\s+(\S+)/);
      const appDirMatch = line.match(/--app_data_dir\s+(\S+)/);
      if (!csrfMatch) continue;
      const csrf = csrfMatch[1];
      const ide = ideMatch ? ideMatch[1] : 'windsurf';
      const appDataDir = appDirMatch ? appDirMatch[1] : null;
      // Find port by checking listening sockets for this process
      const pidMatch = line.match(/^\S+\s+(\d+)/);
      if (!pidMatch) continue;
      const pid = pidMatch[1];
      try {
        const lsof = execSync(`lsof -i TCP -P -n -a -p ${pid} 2>/dev/null`, { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] });
        for (const l of lsof.split('\n')) {
          const portMatch = l.match(/TCP\s+127\.0\.0\.1:(\d+)\s+\(LISTEN\)/);
          if (portMatch) {
            _lsCache.push({ ide, appDataDir, port: parseInt(portMatch[1]), csrf, pid });
          }
        }
      } catch { /* skip */ }
    }
  } catch { /* ps failed */ }
  return _lsCache;
}

function getLsForVariant(variant) {
  const servers = findLanguageServers();
  let matches;
  if (variant.matchKey === 'appDataDir') {
    matches = servers.filter(s => s.appDataDir === variant.matchVal);
  } else {
    // Exclude servers that have appDataDir set (they belong to a different variant)
    matches = servers.filter(s => s.ide === variant.matchVal && !s.appDataDir);
  }
  return matches.length > 0 ? matches[0] : null;
}

// ============================================================
// Connect protocol HTTP client for language server RPC
// ============================================================

function callRpc(port, csrf, method, body, useHttps) {
  const data = JSON.stringify(body || {});
  const scheme = useHttps ? 'https' : 'http';
  const url = `${scheme}://127.0.0.1:${port}/exa.language_server_pb.LanguageServerService/${method}`;
  const insecure = useHttps ? '-k ' : '';
  try {
    const result = execSync(
      `curl -s ${insecure}-X POST ${JSON.stringify(url)} ` +
      `-H "Content-Type: application/json" ` +
      `-H "x-codeium-csrf-token: ${csrf}" ` +
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

const name = 'windsurf';
const sources = ['windsurf', 'windsurf-next', 'antigravity'];

function getChats() {
  const chats = [];

  for (const variant of VARIANTS) {
    const ls = getLsForVariant(variant);
    if (!ls) continue;

    const resp = callRpc(ls.port, ls.csrf, 'GetAllCascadeTrajectories', {}, variant.https);
    if (!resp || !resp.trajectorySummaries) continue;

    for (const [cascadeId, summary] of Object.entries(resp.trajectorySummaries)) {
      const ws = (summary.workspaces || [])[0];
      const folder = ws?.workspaceFolderAbsoluteUri?.replace('file://', '') || null;
      chats.push({
        source: variant.id,
        composerId: cascadeId,
        name: summary.summary || null,
        createdAt: summary.createdTime ? new Date(summary.createdTime).getTime() : null,
        lastUpdatedAt: summary.lastModifiedTime ? new Date(summary.lastModifiedTime).getTime() : null,
        mode: 'cascade',
        folder,
        encrypted: false,
        bubbleCount: summary.stepCount || 0,
        _port: ls.port,
        _csrf: ls.csrf,
        _https: variant.https,
        _stepCount: summary.stepCount,
        _model: summary.lastGeneratorModelUid,
      });
    }
  }

  return chats;
}

function getSteps(chat) {
  if (!chat._port || !chat._csrf) return [];

  // Prefer GetCascadeTrajectorySteps (returns more steps than GetCascadeTrajectory)
  const resp = callRpc(chat._port, chat._csrf, 'GetCascadeTrajectorySteps', {
    cascadeId: chat.composerId,
  }, chat._https);
  if (resp && resp.steps && resp.steps.length > 0) return resp.steps;

  // Fallback to old method
  const resp2 = callRpc(chat._port, chat._csrf, 'GetCascadeTrajectory', {
    cascadeId: chat.composerId,
  }, chat._https);
  if (resp2 && resp2.trajectory && resp2.trajectory.steps) return resp2.trajectory.steps;

  return [];
}

/**
 * Get the tail messages beyond the step limit using generatorMetadata.
 * The last generatorMetadata entry with messagePrompts has the conversation context.
 * We find the overlap with step-based messages by matching the last user message content.
 */
function getTailMessages(chat, stepMessages) {
  const resp = callRpc(chat._port, chat._csrf, 'GetCascadeTrajectory', {
    cascadeId: chat.composerId,
  }, chat._https);
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
      return {
        role: 'assistant',
        content: parts.join('\n'),
        _model: meta.generatorModelUid,
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

  return messages;
}

function resetCache() { _lsCache = null; }

module.exports = { name, sources, getChats, getMessages, resetCache };
