const { execSync, execFileSync } = require('child_process');
const path = require('path');
const os = require('os');
const fs = require('fs');

// Windsurf variants: Windsurf, Windsurf Next
const VARIANTS = [
  { id: 'windsurf', matchKey: 'ide', matchVal: 'windsurf', https: false, appName: 'Windsurf', needsMetadata: true },
  { id: 'windsurf-next', matchKey: 'ide', matchVal: 'windsurf-next', https: false, appName: 'Windsurf - Next', needsMetadata: true },
];

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
      // ps aux on Unix-like systems
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
        // Match: 127.0.0.1:PORT ... LISTENING PID
        // Check if line ends with the PID we're looking for
        if (!line.trim().endsWith(pid)) continue;
        const match = line.match(/127\.0\.0\.1:(\d+).*LISTENING/);
        if (match) {
          ports.push(parseInt(match[1]));
        }
      }
      return ports;
    } else {
      // lsof on Unix-like systems
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
// Find running Windsurf language server (port + CSRF token)
// ============================================================

let _lsCache = null;

function findLanguageServers() {
  if (_lsCache) return _lsCache;
  _lsCache = [];

  // Language server executable name varies by platform
  const serverProcessName = IS_WINDOWS
    ? 'language_server_windows'
    : process.platform === 'darwin'
      ? 'language_server_macos'
      : 'language_server_linux';

  // On macOS/Linux, also check env vars for WINDSURF_CSRF_TOKEN (newer Windsurf Next passes CSRF via env, not CLI arg)
  const envCsrfByPid = {};
  if (!IS_WINDOWS) {
    try {
      const psEnv = execSync('ps eww -A', { encoding: 'utf-8', maxBuffer: 2 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'] });
      for (const envLine of psEnv.split('\n')) {
        const envCsrf = envLine.match(/WINDSURF_CSRF_TOKEN=(\S+)/);
        if (envCsrf) {
          const envPid = envLine.match(/^\s*(\d+)/);
          if (envPid) envCsrfByPid[envPid[1]] = envCsrf[1];
        }
      }
    } catch {}
  }

  for (const proc of getProcessList()) {
    const { commandLine, pid } = proc;
    if (!commandLine.includes(serverProcessName)) continue;

    const csrfMatch = commandLine.match(/--csrf_token\s+(\S+)/);
    const ideMatch = commandLine.match(/--ide_name\s+(\S+)/);
    const appDirMatch = commandLine.match(/--app_data_dir\s+(\S+)/);

    // Try CLI arg first, then env var fallback
    const csrf = csrfMatch ? csrfMatch[1] : envCsrfByPid[pid] || null;
    if (!csrf) continue;

    const ide = ideMatch ? ideMatch[1] : null;
    const appDataDir = appDirMatch ? appDirMatch[1] : null;

    const extCsrfMatch = commandLine.match(/--extension_server_csrf_token\s+(\S+)/);

    // Check for explicit server port (Antigravity uses --server_port)
    const serverPortMatch = commandLine.match(/--server_port\s+(\d+)/);

    // Find actual listening ports for this process
    const ports = getListeningPorts(pid);
    if (ports.length === 0) continue;

    // Use explicit server_port if available, otherwise use lowest port
    let port;
    if (serverPortMatch) {
      port = parseInt(serverPortMatch[1], 10);
      if (!ports.includes(port)) {
        port = Math.min(...ports);
      }
    } else {
      port = Math.min(...ports);
    }

    if (ide) {
      _lsCache.push({ ide, appDataDir, port, csrf, pid, extCsrf: extCsrfMatch ? extCsrfMatch[1] : null, isHttps: false });
    }
  }

  return _lsCache;
}

function getLsForVariant(variant) {
  const servers = findLanguageServers();
  let matches;
  if (variant.matchKey === 'appDataDir') {
    matches = servers.filter(s => s.appDataDir?.includes(variant.matchVal));
  } else {
    matches = servers.filter(s => s.ide === variant.matchVal);
  }
  return matches.length > 0 ? matches[0] : null;
}

// ============================================================
// Connect protocol HTTP client for language server RPC
// ============================================================

function callRpc(port, csrf, method, body, extCsrf = null) {
  const data = JSON.stringify(body || {});
  const url = `http://127.0.0.1:${port}/exa.language_server_pb.LanguageServerService/${method}`;

  const actualCsrf = extCsrf || csrf;

  try {
    const result = execSync(
      `curl -s -X POST ${JSON.stringify(url)} ` +
      `-H "Content-Type: application/json" ` +
      `-H "x-codeium-csrf-token: ${actualCsrf}" ` +
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
const sources = ['windsurf', 'windsurf-next'];

function getChats() {
  const chats = [];

  for (const variant of VARIANTS) {
    const ls = getLsForVariant(variant);
    if (!ls) continue;

    const resp = callRpc(ls.port, ls.csrf, 'GetAllCascadeTrajectories', {}, ls.extCsrf);
    if (!resp || !resp.trajectorySummaries) continue;

    for (const [cascadeId, summary] of Object.entries(resp.trajectorySummaries)) {
      const ws = (summary.workspaces || [])[0];
      const folder = ws?.workspaceFolderAbsoluteUri?.replace('file://', '') || null;
      const rawModel = summary.lastGeneratorModelUid;
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
        _extCsrf: ls.extCsrf,
        _stepCount: summary.stepCount,
        _model: rawModel,
        _rawModel: rawModel,
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
  }, chat._extCsrf);
  if (resp && resp.steps && resp.steps.length > 0) return resp.steps;

  // Fallback to old method
  const resp2 = callRpc(chat._port, chat._csrf, 'GetCascadeTrajectory', {
    cascadeId: chat.composerId,
  }, chat._extCsrf);
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
  }, chat._extCsrf);
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
      const model = meta.generatorModelUid;
      return {
        role: 'assistant',
        content: parts.join('\n'),
        _model: model,
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

// ============================================================
// Usage / quota data from language server RPC
// ============================================================

function getWindsurfApiKey(appName) {
  if (!appName) return null;
  try {
    const HOME = os.homedir();
    let dbPath;
    switch (process.platform) {
      case 'darwin':
        dbPath = path.join(HOME, 'Library', 'Application Support', appName, 'User', 'globalStorage', 'state.vscdb');
        break;
      case 'win32':
        dbPath = path.join(HOME, 'AppData', 'Roaming', appName, 'User', 'globalStorage', 'state.vscdb');
        break;
      default:
        dbPath = path.join(HOME, '.config', appName, 'User', 'globalStorage', 'state.vscdb');
    }
    if (!fs.existsSync(dbPath)) return null;
    const Database = require('better-sqlite3');
    const db = new Database(dbPath, { readonly: true });
    const row = db.prepare("SELECT value FROM ItemTable WHERE key = 'windsurfAuthStatus'").get();
    db.close();
    if (!row) return null;
    const parsed = JSON.parse(row.value);
    return parsed.apiKey || null;
  } catch { return null; }
}

function getUsage() {
  const results = [];

  for (const variant of VARIANTS) {
    const ls = getLsForVariant(variant);
    if (!ls) continue;

    const apiKey = getWindsurfApiKey(variant.appName);
    if (!apiKey) continue;
    const body = {
      metadata: {
        api_key: apiKey,
        ide_name: variant.id,
        ide_version: '1.0.0',
        extension_version: '1.0.0',
        locale: 'en',
      },
    };

    const resp = callRpc(ls.port, ls.csrf, 'GetUserStatus', body, ls.extCsrf);
    if (!resp || !resp.userStatus) continue;

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

    // Raw values are in internal units (÷100 for display credits)
    const promptAlloc = (ps.availablePromptCredits || 0) / 100;
    const promptUsed = (ps.usedPromptCredits || 0) / 100;
    const flexAlloc = (ps.availableFlexCredits || 0) / 100;
    const flexUsed = (ps.usedFlexCredits || 0) / 100;
    const flowAlloc = (ps.availableFlowCredits || 0) / 100;
    const monthlyDisplay = (pi.monthlyPromptCredits || 0) / 100;

    const remainingPrompt = Math.max(0, promptAlloc - promptUsed);
    const remainingFlex = Math.max(0, flexAlloc - flexUsed);
    const totalRemaining = remainingPrompt + remainingFlex;

    // Credit multipliers per model
    const creditMultipliers = (pi.creditMultiplierOverrides || []).reduce((acc, entry) => {
      const model = entry.modelOrAlias?.model;
      if (model && entry.creditMultiplier != null) acc[model] = entry.creditMultiplier;
      return acc;
    }, {});

    results.push({
      source: variant.id,
      plan: {
        name: pi.planName || null,
        tier: pi.teamsTier || null,
        monthlyPromptCredits: monthlyDisplay,
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
      topUp: ps.topUpStatus ? {
        monthlyAmount: ps.topUpStatus.monthlyTopUpAmount || null,
        increment: ps.topUpStatus.topUpIncrement || null,
      } : null,
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
    });
  }

  return results.length > 0 ? results : null;
}

function resetCache() { _lsCache = null; }

const labels = { 'windsurf': 'Windsurf', 'windsurf-next': 'Windsurf Next' };

module.exports = { name, sources, labels, getChats, getMessages, resetCache, getUsage };
