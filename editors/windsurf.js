const { execSync } = require('child_process');

// Windsurf-family variants: Windsurf, Antigravity
const VARIANTS = [
  { id: 'windsurf', matchKey: 'ide', matchVal: 'windsurf', https: false },
  { id: 'antigravity', matchKey: 'appDataDir', matchVal: 'antigravity', https: true },
];

// Antigravity model ID to friendly name mapping
const ANTIGRAVITY_MODEL_MAP = {
  'MODEL_PLACEHOLDER_M1': 'claude-3-5-sonnet-20241022',
  'MODEL_PLACEHOLDER_M2': 'claude-3-5-sonnet-20241022',
  'MODEL_PLACEHOLDER_M3': 'claude-3-5-sonnet-20241022',
  'MODEL_PLACEHOLDER_M4': 'claude-3-5-haiku-20241022',
  'MODEL_PLACEHOLDER_M5': 'claude-3-5-haiku-20241022',
  'MODEL_PLACEHOLDER_M6': 'claude-3-5-haiku-20241022',
  'MODEL_PLACEHOLDER_M7': 'claude-3-5-sonnet-20241022',
  'MODEL_PLACEHOLDER_M8': 'claude-3.5-sonnet',
  'MODEL_PLACEHOLDER_M9': 'claude-3.5-sonnet',
  'MODEL_PLACEHOLDER_M10': 'claude-3.5-sonnet',
  'MODEL_CLAUDE_4_5_SONNET': 'claude-4.5-sonnet',
};

function normalizeAntigravityModel(modelId) {
  if (!modelId) return null;
  return ANTIGRAVITY_MODEL_MAP[modelId] || modelId;
}

// ============================================================
// Cross-platform process utilities
// ============================================================

const IS_WINDOWS = process.platform === 'win32';

function getProcessList() {
  try {
    if (IS_WINDOWS) {
      // wmic provides CSV-formatted process data
      const output = execSync('wmic process get CommandLine,ProcessId /format:csv', {
        encoding: 'utf-8',
        maxBuffer: 10 * 1024 * 1024,
      });
      // Parse CSV: skip header, split by comma
      const lines = output.split('\n').slice(1);
      return lines.map(line => {
        const parts = line.split(',');
        if (parts.length < 2) return null;
        const commandLine = parts.slice(0, -1).join(',').trim().replace(/^"|"$/g, '');
        const pid = parts[parts.length - 1].trim();
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
      // netstat -ano shows PID in the last column
      const output = execSync(`netstat -ano | findstr ${pid}`, {
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
// Find running Windsurf/Antigravity language server (port + CSRF token)
// ============================================================

let _lsCache = null;

function findLanguageServers() {
  if (_lsCache) return _lsCache;
  _lsCache = [];

  // Language server executable name varies by platform
  // Windows: language_server_windows_x64.exe, language_server_windows_x.exe, etc.
  const serverProcessName = IS_WINDOWS
    ? 'language_server_windows'
    : process.platform === 'darwin'
      ? 'language_server_macos'
      : 'language_server_linux';

  for (const proc of getProcessList()) {
    const { commandLine, pid } = proc;
    if (!commandLine.includes(serverProcessName) || !commandLine.includes('--csrf_token')) continue;

    const csrfMatch = commandLine.match(/--csrf_token\s+(\S+)/);
    const ideMatch = commandLine.match(/--ide_name\s+(\S+)/);
    const appDirMatch = commandLine.match(/--app_data_dir\s+(\S+)/);
    if (!csrfMatch) continue;

    const csrf = csrfMatch[1];
    const ide = ideMatch ? ideMatch[1] : null;
    const appDataDir = appDirMatch ? appDirMatch[1] : null;

    // Antigravity has a separate extension server CSRF token
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
      // Verify the port is actually listening
      if (!ports.includes(port)) {
        port = Math.min(...ports);
      }
    } else {
      port = Math.min(...ports);
    }

    if (ide || appDataDir) {
      // Antigravity uses HTTPS on --server_port, Windsurf uses HTTP
      const isHttps = appDataDir?.includes('antigravity');
      _lsCache.push({ ide, appDataDir, port, csrf, pid, extCsrf: extCsrfMatch ? extCsrfMatch[1] : null, isHttps });
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

function callRpc(port, csrf, method, body, isHttps = false, extCsrf = null, useMainCsrf = false) {
  const data = JSON.stringify(body || {});
  const scheme = isHttps ? 'https' : 'http';
  const url = `${scheme}://127.0.0.1:${port}/exa.language_server_pb.LanguageServerService/${method}`;
  const insecure = isHttps ? '-k ' : '';

  // For Antigravity, use main CSRF. For Windsurf, use extension CSRF if available.
  const actualCsrf = useMainCsrf ? csrf : (extCsrf || csrf);

  try {
    const result = execSync(
      `curl -s ${insecure}-X POST ${JSON.stringify(url)} ` +
      `-H "Content-Type: application/json" ` +
      `-H "x-codeium-csrf-token: ${actualCsrf}" ` +
      `-d ${JSON.stringify(data)} ` +
      `--max-time 10`,
      { encoding: 'utf-8', maxBuffer: 50 * 1024 * 1024 }
    );
    return JSON.parse(result);
  } catch { return null; }
}

// ============================================================
// Adapter interface
// ============================================================

const name = 'windsurf';
const sources = ['windsurf', 'antigravity'];

function getChats() {
  const chats = [];

  for (const variant of VARIANTS) {
    const ls = getLsForVariant(variant);
    if (!ls) continue;

    // Antigravity uses main CSRF, Windsurf uses extension CSRF
    const useMainCsrf = variant.id === 'antigravity';
    const resp = callRpc(ls.port, ls.csrf, 'GetAllCascadeTrajectories', {}, ls.isHttps, ls.extCsrf, useMainCsrf);
    if (!resp || !resp.trajectorySummaries) continue;

    for (const [cascadeId, summary] of Object.entries(resp.trajectorySummaries)) {
      const ws = (summary.workspaces || [])[0];
      const folder = ws?.workspaceFolderAbsoluteUri?.replace('file://', '') || null;
      const rawModel = summary.lastGeneratorModelUid;
      // Normalize Antigravity models so they show correctly in dashboard
      const normalizedModel = variant.id === 'antigravity' && rawModel ? normalizeAntigravityModel(rawModel) : rawModel;
      chats.push({
        source: variant.id,
        composerId: cascadeId,
        name: summary.summary || null,
        createdAt: summary.createdTime ? new Date(summary.createdTime).getTime() : null,
        lastUpdatedAt: summary.lastModifiedTime ? new Date(summary.lastModifiedTime).getTime() : null,
        mode: 'cascade',
        folder,
        encrypted: false,
        _port: ls.port,
        _csrf: ls.csrf,
        _extCsrf: ls.extCsrf,
        _isHttps: ls.isHttps,
        _stepCount: summary.stepCount,
        _model: normalizedModel,
        _rawModel: rawModel,
      });
    }
  }

  return chats;
}

function getMessages(chat) {
  if (!chat._port || !chat._csrf) return [];

  // Determine if this is Antigravity based on source
  const isAntigravity = chat.source === 'antigravity';
  const resp = callRpc(chat._port, chat._csrf, 'GetCascadeTrajectory', {
    cascadeId: chat.composerId,
  }, chat._isHttps, chat._extCsrf, isAntigravity);
  if (!resp || !resp.trajectory || !resp.trajectory.steps) return [];

  const messages = [];

  for (const step of resp.trajectory.steps) {
    const type = step.type || '';
    const meta = step.metadata || {};

    if (type === 'CORTEX_STEP_TYPE_USER_INPUT' && step.userInput) {
      messages.push({
        role: 'user',
        content: step.userInput.userResponse || step.userInput.items?.map(i => i.text).join('') || '',
      });
    } else if (type === 'CORTEX_STEP_TYPE_PLANNER_RESPONSE' && step.plannerResponse) {
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
        // Try both generatorModel (Antigravity) and generatorModelUid (Windsurf)
        const model = meta.generatorModel || meta.generatorModelUid;
        messages.push({
          role: 'assistant',
          content: parts.join('\n'),
          _model: isAntigravity && model ? normalizeAntigravityModel(model) : model,
          _toolCalls,
        });
      }
    } else if (type === 'CORTEX_STEP_TYPE_TOOL_EXECUTION' && step.toolExecution) {
      const te = step.toolExecution;
      const toolName = te.toolName || te.name || 'tool';
      const result = te.output || te.result || '';
      const preview = typeof result === 'string' ? result.substring(0, 500) : JSON.stringify(result).substring(0, 500);
      messages.push({
        role: 'tool',
        content: `[${toolName}] ${preview}`,
      });
    }
  }
  return messages;
}

module.exports = { name, sources, getChats, getMessages };
