#!/usr/bin/env -S deno run --allow-read --allow-env
// ============================================================
// Agentlytics — Deno Sandboxed Edition
// Lightweight CLI analytics for AI coding agents
//
// Usage:
//   deno run --allow-read --allow-env https://raw.githubusercontent.com/f/agentlytics/master/mod.ts
//   deno run --allow-read --allow-env mod.ts
//   deno run --allow-read --allow-env mod.ts --json
// ============================================================

// ── ANSI helpers (zero dependencies) ─────────────────────────

const noColor = Deno.env.get("NO_COLOR") !== undefined;
const bold = (s: string) => noColor ? s : `\x1b[1m${s}\x1b[0m`;
const dim = (s: string) => noColor ? s : `\x1b[2m${s}\x1b[0m`;
const green = (s: string) => noColor ? s : `\x1b[32m${s}\x1b[0m`;
const yellow = (s: string) => noColor ? s : `\x1b[33m${s}\x1b[0m`;
const cyan = (s: string) => noColor ? s : `\x1b[36m${s}\x1b[0m`;
const red = (s: string) => noColor ? s : `\x1b[31m${s}\x1b[0m`;
const hex = (color: string) => {
  if (noColor) return (s: string) => s;
  const r = parseInt(color.slice(1, 3), 16);
  const g = parseInt(color.slice(3, 5), 16);
  const b = parseInt(color.slice(5, 7), 16);
  return (s: string) => `\x1b[38;2;${r};${g};${b}m${s}\x1b[0m`;
};

// ── Platform detection ───────────────────────────────────────

const HOME = Deno.env.get("HOME") || Deno.env.get("USERPROFILE") || "";
const PLATFORM = Deno.build.os; // "darwin", "windows", "linux"

function join(...parts: string[]): string {
  const sep = PLATFORM === "windows" ? "\\" : "/";
  return parts.join(sep).replace(/[/\\]+/g, sep);
}

function basename(p: string): string {
  const parts = p.replace(/\\/g, "/").split("/");
  return parts[parts.length - 1] || "";
}

// ── File system helpers ──────────────────────────────────────

function existsSync(path: string): boolean {
  try { Deno.statSync(path); return true; } catch { return false; }
}

function readTextSync(path: string): string {
  return Deno.readTextFileSync(path);
}

function readDirNames(path: string): string[] {
  try {
    return [...Deno.readDirSync(path)].map((e) => e.name);
  } catch {
    return [];
  }
}

function readDirEntries(path: string): Deno.DirEntry[] {
  try {
    return [...Deno.readDirSync(path)];
  } catch {
    return [];
  }
}

function fileMtime(path: string): number | null {
  try {
    const info = Deno.statSync(path);
    return info.mtime ? info.mtime.getTime() : null;
  } catch {
    return null;
  }
}

function fileBirthtime(path: string): number | null {
  try {
    const info = Deno.statSync(path);
    return info.birthtime ? info.birthtime.getTime() : null;
  } catch {
    return null;
  }
}

function isDirectory(path: string): boolean {
  try {
    return Deno.statSync(path).isDirectory;
  } catch {
    return false;
  }
}

function getAppDataPath(appName: string): string {
  switch (PLATFORM) {
    case "darwin":
      return join(HOME, "Library", "Application Support", appName);
    case "windows":
      return join(HOME, "AppData", "Roaming", appName);
    default:
      return join(HOME, ".config", appName);
  }
}

// ── Types ────────────────────────────────────────────────────

interface Chat {
  source: string;
  composerId: string;
  name: string | null;
  createdAt: number | null;
  lastUpdatedAt: number | null;
  mode: string;
  folder: string | null;
  bubbleCount: number;
  messageCount?: number;
}

interface EditorResult {
  name: string;
  label: string;
  detected: boolean;
  sessions: Chat[];
  note?: string;
}

// ── Editor: Claude Code ──────────────────────────────────────

function scanClaude(): EditorResult {
  const claudeDir = join(HOME, ".claude");
  const projectsDir = join(claudeDir, "projects");
  const result: EditorResult = { name: "claude-code", label: "Claude Code", detected: false, sessions: [] };

  if (!existsSync(projectsDir)) return result;
  result.detected = true;

  for (const projDir of readDirNames(projectsDir)) {
    const dir = join(projectsDir, projDir);
    if (!isDirectory(dir)) continue;

    const decodedFolder = projDir.replace(/-/g, "/");

    // Read sessions-index.json for metadata
    const indexPath = join(dir, "sessions-index.json");
    const indexed = new Map<string, Record<string, unknown>>();
    try {
      const index = JSON.parse(readTextSync(indexPath));
      for (const entry of index.entries || []) {
        indexed.set(entry.sessionId, entry);
      }
    } catch { /* no index */ }

    const files = readDirNames(dir).filter((f) => f.endsWith(".jsonl"));
    for (const file of files) {
      const sessionId = file.replace(".jsonl", "");
      const fullPath = join(dir, file);
      const entry = indexed.get(sessionId);

      let msgCount = 0;
      try {
        const content = readTextSync(fullPath);
        const lines = content.split("\n").filter(Boolean);
        for (const line of lines) {
          try {
            const obj = JSON.parse(line);
            if (obj.type === "user" || obj.type === "assistant") msgCount++;
          } catch { /* skip */ }
        }
      } catch { /* skip */ }

      if (entry) {
        const e = entry as Record<string, unknown>;
        result.sessions.push({
          source: "claude-code",
          composerId: sessionId,
          name: cleanPrompt(e.firstPrompt as string),
          createdAt: e.created ? new Date(e.created as string).getTime() : null,
          lastUpdatedAt: e.modified ? new Date(e.modified as string).getTime() : fileMtime(fullPath),
          mode: "claude",
          folder: (e.projectPath as string) || decodedFolder,
          bubbleCount: (e.messageCount as number) || msgCount,
          messageCount: msgCount,
        });
      } else {
        const meta = peekClaudeMeta(fullPath);
        result.sessions.push({
          source: "claude-code",
          composerId: sessionId,
          name: meta.firstPrompt ? cleanPrompt(meta.firstPrompt) : null,
          createdAt: meta.timestamp || fileBirthtime(fullPath),
          lastUpdatedAt: fileMtime(fullPath),
          mode: "claude",
          folder: meta.cwd || decodedFolder,
          bubbleCount: msgCount,
          messageCount: msgCount,
        });
      }
    }
  }
  return result;
}

function peekClaudeMeta(filePath: string): { firstPrompt: string | null; cwd: string | null; timestamp: number | null } {
  const meta = { firstPrompt: null as string | null, cwd: null as string | null, timestamp: null as number | null };
  try {
    const buf = readTextSync(filePath);
    for (const line of buf.split("\n")) {
      if (!line) continue;
      const obj = JSON.parse(line);
      if (!meta.cwd && obj.cwd) meta.cwd = obj.cwd;
      if (!meta.timestamp && obj.timestamp) {
        meta.timestamp = typeof obj.timestamp === "string" ? new Date(obj.timestamp).getTime() : obj.timestamp;
      }
      if (!meta.firstPrompt && obj.type === "user" && obj.message?.content) {
        const text = typeof obj.message.content === "string"
          ? obj.message.content
          : obj.message.content.filter((c: Record<string, unknown>) => c.type === "text").map((c: Record<string, unknown>) => c.text).join(" ");
        meta.firstPrompt = text.substring(0, 200);
      }
      if (meta.cwd && meta.firstPrompt) break;
    }
  } catch { /* skip */ }
  return meta;
}

function cleanPrompt(prompt: string | null | undefined): string | null {
  if (!prompt || prompt === "No prompt") return null;
  const clean = prompt
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "")
    .replace(/<[^>]+>/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .substring(0, 120);
  return clean || null;
}

// ── Editor: VS Code / Copilot Chat ──────────────────────────

function scanVSCode(): EditorResult[] {
  const variants = [
    { id: "vscode", label: "VS Code", appSupport: getAppDataPath("Code") },
    { id: "vscode-insiders", label: "VS Code Insiders", appSupport: getAppDataPath("Code - Insiders") },
  ];

  const results: EditorResult[] = [];

  for (const variant of variants) {
    const result: EditorResult = { name: variant.id, label: variant.label, detected: false, sessions: [] };
    if (!existsSync(variant.appSupport)) { results.push(result); continue; }
    result.detected = true;

    // Global (empty window) chat sessions
    const globalDir = join(variant.appSupport, "User", "globalStorage", "emptyWindowChatSessions");
    if (existsSync(globalDir)) {
      collectVSCodeSessions(globalDir, null, variant.id, result.sessions);
    }

    // Workspace chat sessions
    const wsRoot = join(variant.appSupport, "User", "workspaceStorage");
    if (existsSync(wsRoot)) {
      for (const wsHash of readDirNames(wsRoot)) {
        const wsDir = join(wsRoot, wsHash);
        if (!isDirectory(wsDir)) continue;
        const chatDir = join(wsDir, "chatSessions");
        if (!existsSync(chatDir)) continue;
        const folder = getVSCodeWorkspaceFolder(wsDir);
        collectVSCodeSessions(chatDir, folder, variant.id, result.sessions);
      }
    }

    results.push(result);
  }

  return results;
}

function getVSCodeWorkspaceFolder(wsDir: string): string | null {
  const wsJson = join(wsDir, "workspace.json");
  if (!existsSync(wsJson)) return null;
  try {
    const data = JSON.parse(readTextSync(wsJson));
    const uri = data.folder || data.workspace;
    if (uri) return decodeURIComponent(uri.replace("file://", ""));
  } catch { /* skip */ }
  return null;
}

function collectVSCodeSessions(dir: string, folder: string | null, source: string, chats: Chat[]) {
  const files = readDirNames(dir).filter((f) => f.endsWith(".jsonl") || f.endsWith(".json"));
  for (const file of files) {
    const filePath = join(dir, file);
    try {
      const meta = peekVSCodeMeta(filePath);
      chats.push({
        source,
        composerId: meta.sessionId || file.replace(/\.(jsonl|json)$/, ""),
        name: meta.title || meta.firstUserText || null,
        createdAt: meta.createdAt || fileBirthtime(filePath),
        lastUpdatedAt: fileMtime(filePath),
        mode: "copilot",
        folder,
        bubbleCount: meta.requestCount || 0,
      });
    } catch { /* skip */ }
  }
}

function peekVSCodeMeta(filePath: string): {
  sessionId: string | null;
  title: string | null;
  createdAt: number | null;
  requestCount: number;
  firstUserText: string | null;
} {
  if (filePath.endsWith(".json")) {
    try {
      const data = JSON.parse(readTextSync(filePath));
      return {
        sessionId: data.sessionId || null,
        title: data.customTitle || null,
        createdAt: data.creationDate || data.lastMessageDate || null,
        requestCount: data.requests?.length || 0,
        firstUserText: (data.requests?.[0]?.message?.text || "").substring(0, 120) || null,
      };
    } catch { return { sessionId: null, title: null, createdAt: null, requestCount: 0, firstUserText: null }; }
  }
  // JSONL
  try {
    const content = readTextSync(filePath);
    const firstNewline = content.indexOf("\n");
    const firstLine = firstNewline > 0 ? content.substring(0, firstNewline) : content;
    const init = JSON.parse(firstLine);
    const state = init.v || {};
    let title = state.customTitle || null;
    if (!title) {
      const titleIdx = content.indexOf('"customTitle"');
      if (titleIdx !== -1) {
        const lineStart = content.lastIndexOf("\n", titleIdx) + 1;
        const lineEnd = content.indexOf("\n", titleIdx);
        const patchLine = content.substring(lineStart, lineEnd > 0 ? lineEnd : undefined);
        try {
          const patch = JSON.parse(patchLine);
          if (patch.kind === 1 && patch.k[0] === "customTitle") title = patch.v;
        } catch { /* skip */ }
      }
    }
    return {
      sessionId: state.sessionId || null,
      title,
      createdAt: state.creationDate || null,
      requestCount: state.requests?.length || 0,
      firstUserText: null,
    };
  } catch { return { sessionId: null, title: null, createdAt: null, requestCount: 0, firstUserText: null }; }
}

// ── Editor: Cursor (file-based chats only, no SQLite) ────────

function scanCursor(): EditorResult {
  const cursorChatsDir = join(HOME, ".cursor", "chats");
  const result: EditorResult = { name: "cursor", label: "Cursor", detected: false, sessions: [] };

  // Check if Cursor app data exists
  const cursorApp = getAppDataPath("Cursor");
  if (!existsSync(cursorChatsDir) && !existsSync(cursorApp)) return result;
  result.detected = true;

  // Scan ~/.cursor/chats/<workspace>/<chatId>/ for agent-mode sessions
  if (existsSync(cursorChatsDir)) {
    for (const workspace of readDirNames(cursorChatsDir)) {
      const wsDir = join(cursorChatsDir, workspace);
      if (!isDirectory(wsDir)) continue;
      for (const chatId of readDirNames(wsDir)) {
        const chatDir = join(wsDir, chatId);
        if (!isDirectory(chatDir)) continue;

        // Try to read composer_data or similar JSON
        const files = readDirNames(chatDir);
        const jsonFile = files.find((f) => f.endsWith(".json"));
        if (jsonFile) {
          const filePath = join(chatDir, jsonFile);
          try {
            const data = JSON.parse(readTextSync(filePath));
            result.sessions.push({
              source: "cursor",
              composerId: chatId,
              name: data.name || data.title || null,
              createdAt: data.createdAt || fileBirthtime(filePath),
              lastUpdatedAt: fileMtime(filePath),
              mode: "agent",
              folder: data.folder || data.workspacePath || null,
              bubbleCount: data.bubbleCount || 0,
            });
          } catch { /* skip */ }
        }
      }
    }
  }

  // Note: state.vscdb (SQLite) sessions require --allow-ffi
  if (existsSync(join(cursorApp, "User", "globalStorage", "state.vscdb"))) {
    result.note = "SQLite sessions available (run full version for complete data)";
  }

  return result;
}

// ── Editor: Codex CLI ────────────────────────────────────────

function scanCodex(): EditorResult {
  const codexHome = Deno.env.get("CODEX_HOME") || join(HOME, ".codex");
  const result: EditorResult = { name: "codex", label: "Codex CLI", detected: false, sessions: [] };

  const sessionDirs = [join(codexHome, "sessions"), join(codexHome, "archived_sessions")];
  let found = false;
  for (const dir of sessionDirs) {
    if (!existsSync(dir)) continue;
    found = true;
    walkJsonlFiles(dir, (filePath) => {
      try {
        const content = readTextSync(filePath);
        const lines = content.split("\n").filter(Boolean);
        if (lines.length === 0) return;

        const first = JSON.parse(lines[0]);
        let msgCount = 0;
        let model: string | null = null;
        for (const line of lines) {
          try {
            const obj = JSON.parse(line);
            if (obj.type === "message" || obj.role) msgCount++;
            if (!model && obj.model) model = obj.model;
          } catch { /* skip */ }
        }

        result.sessions.push({
          source: "codex",
          composerId: first.id || basename(filePath).replace(".jsonl", ""),
          name: first.instructions?.substring(0, 120) || null,
          createdAt: first.created_at ? first.created_at * 1000 : fileBirthtime(filePath),
          lastUpdatedAt: fileMtime(filePath),
          mode: "codex",
          folder: first.cwd || null,
          bubbleCount: msgCount,
          messageCount: msgCount,
        });
      } catch { /* skip */ }
    });
  }

  result.detected = found;
  return result;
}

function walkJsonlFiles(dir: string, cb: (path: string) => void) {
  for (const entry of readDirEntries(dir)) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory) {
      walkJsonlFiles(fullPath, cb);
    } else if (entry.isFile && entry.name.endsWith(".jsonl")) {
      cb(fullPath);
    }
  }
}

// ── Editor: Gemini CLI ───────────────────────────────────────

function scanGemini(): EditorResult {
  const geminiDir = join(HOME, ".gemini");
  const tmpDir = join(geminiDir, "tmp");
  const result: EditorResult = { name: "gemini-cli", label: "Gemini CLI", detected: false, sessions: [] };

  if (!existsSync(tmpDir)) return result;
  result.detected = true;

  // Load project map
  const projectMap = new Map<string, string>();
  try {
    const data = JSON.parse(readTextSync(join(geminiDir, "projects.json")));
    if (data.projects) {
      for (const [folderPath, projName] of Object.entries(data.projects)) {
        projectMap.set(projName as string, folderPath);
      }
    }
  } catch { /* skip */ }

  for (const projName of readDirNames(tmpDir)) {
    const projDir = join(tmpDir, projName);
    if (!isDirectory(projDir)) continue;
    const folder = projectMap.get(projName) || null;

    for (const file of readDirNames(projDir).filter((f) => f.endsWith(".jsonl"))) {
      const filePath = join(projDir, file);
      try {
        const content = readTextSync(filePath);
        const lines = content.split("\n").filter(Boolean);
        let msgCount = 0;
        let firstUserText: string | null = null;
        for (const line of lines) {
          try {
            const obj = JSON.parse(line);
            if (obj.role === "user" || obj.role === "model") msgCount++;
            if (!firstUserText && obj.role === "user") {
              const text = obj.parts?.[0]?.text || "";
              firstUserText = text.substring(0, 120) || null;
            }
          } catch { /* skip */ }
        }

        result.sessions.push({
          source: "gemini-cli",
          composerId: file.replace(".jsonl", ""),
          name: firstUserText,
          createdAt: fileBirthtime(filePath),
          lastUpdatedAt: fileMtime(filePath),
          mode: "gemini",
          folder,
          bubbleCount: msgCount,
          messageCount: msgCount,
        });
      } catch { /* skip */ }
    }
  }

  return result;
}

// ── Editor: Command Code ─────────────────────────────────────

function scanCommandCode(): EditorResult {
  const projectsDir = join(HOME, ".commandcode", "projects");
  const result: EditorResult = { name: "commandcode", label: "Command Code", detected: false, sessions: [] };

  if (!existsSync(projectsDir)) return result;
  result.detected = true;

  for (const projDir of readDirNames(projectsDir)) {
    const dir = join(projectsDir, projDir);
    if (!isDirectory(dir)) continue;
    const decodedFolder = "/" + projDir.replace(/-/g, "/");

    const files = readDirNames(dir).filter((f) => f.endsWith(".jsonl") && !f.includes(".checkpoints."));
    for (const file of files) {
      const sessionId = file.replace(".jsonl", "");
      const fullPath = join(dir, file);
      const metaPath = join(dir, `${sessionId}.meta.json`);

      let title: string | null = null;
      try {
        const meta = JSON.parse(readTextSync(metaPath));
        title = meta.title || null;
      } catch { /* skip */ }

      let msgCount = 0;
      try {
        const content = readTextSync(fullPath);
        for (const line of content.split("\n")) {
          if (!line) continue;
          try {
            const obj = JSON.parse(line);
            if (obj.type === "user" || obj.type === "assistant") msgCount++;
          } catch { /* skip */ }
        }
      } catch { /* skip */ }

      result.sessions.push({
        source: "commandcode",
        composerId: sessionId,
        name: title,
        createdAt: fileBirthtime(fullPath),
        lastUpdatedAt: fileMtime(fullPath),
        mode: "commandcode",
        folder: decodedFolder,
        bubbleCount: msgCount,
        messageCount: msgCount,
      });
    }
  }

  return result;
}

// ── Editor: Copilot CLI ──────────────────────────────────────

function scanCopilot(): EditorResult {
  const sessionStateDir = join(HOME, ".copilot", "session-state");
  const result: EditorResult = { name: "copilot-cli", label: "Copilot CLI", detected: false, sessions: [] };

  if (!existsSync(sessionStateDir)) return result;
  result.detected = true;

  for (const sessionDir of readDirNames(sessionStateDir)) {
    const dir = join(sessionStateDir, sessionDir);
    if (!isDirectory(dir)) continue;

    // Parse workspace.yaml
    const yamlPath = join(dir, "workspace.yaml");
    let folder: string | null = null;
    let summary: string | null = null;
    let createdAt: string | null = null;
    let updatedAt: string | null = null;
    if (existsSync(yamlPath)) {
      try {
        const raw = readTextSync(yamlPath);
        for (const line of raw.split("\n")) {
          const match = line.match(/^(\w+):\s*(.*)$/);
          if (!match) continue;
          if (match[1] === "cwd" || match[1] === "git_root") folder = folder || match[2].trim();
          if (match[1] === "summary") summary = match[2].trim();
          if (match[1] === "created_at") createdAt = match[2].trim();
          if (match[1] === "updated_at") updatedAt = match[2].trim();
        }
      } catch { /* skip */ }
    }

    // Count events
    const eventsPath = join(dir, "events.jsonl");
    let msgCount = 0;
    if (existsSync(eventsPath)) {
      try {
        const content = readTextSync(eventsPath);
        for (const line of content.split("\n")) {
          if (!line) continue;
          try {
            const obj = JSON.parse(line);
            if (obj.type === "user.message" || obj.type === "assistant.message") msgCount++;
          } catch { /* skip */ }
        }
      } catch { /* skip */ }
    }

    result.sessions.push({
      source: "copilot-cli",
      composerId: sessionDir,
      name: summary,
      createdAt: createdAt ? new Date(createdAt).getTime() : fileBirthtime(dir),
      lastUpdatedAt: updatedAt ? new Date(updatedAt).getTime() : fileMtime(dir),
      mode: "copilot",
      folder,
      bubbleCount: msgCount,
      messageCount: msgCount,
    });
  }

  return result;
}

// ── Editor: Kiro ─────────────────────────────────────────────

function scanKiro(): EditorResult {
  const kiroAgentDir = join(getAppDataPath("Kiro"), "User", "globalStorage", "kiro.kiroagent");
  const wsSessionsDir = join(kiroAgentDir, "workspace-sessions");
  const result: EditorResult = { name: "kiro", label: "Kiro", detected: false, sessions: [] };

  if (!existsSync(kiroAgentDir)) return result;
  result.detected = true;

  if (existsSync(wsSessionsDir)) {
    for (const folder of readDirNames(wsSessionsDir)) {
      const wsDir = join(wsSessionsDir, folder);
      if (!isDirectory(wsDir)) continue;

      // Decode base64 folder name
      let workspacePath: string | null = null;
      try { workspacePath = atob(folder); } catch { /* skip */ }

      const indexPath = join(wsDir, "sessions.json");
      let sessions: Record<string, unknown>[] = [];
      try { sessions = JSON.parse(readTextSync(indexPath)); } catch { continue; }

      for (const session of sessions) {
        const sessionFile = join(wsDir, `${session.sessionId}.json`);
        const exists = existsSync(sessionFile);

        result.sessions.push({
          source: "kiro",
          composerId: session.sessionId as string,
          name: (session.title as string) || null,
          createdAt: parseInt(session.dateCreated as string) || null,
          lastUpdatedAt: exists ? fileMtime(sessionFile) : parseInt(session.dateCreated as string) || null,
          mode: "kiro",
          folder: workspacePath,
          bubbleCount: (session.messageCount as number) || 0,
        });
      }
    }
  }

  return result;
}

// ── Editor: Goose (file-based sessions) ──────────────────────

function scanGoose(): EditorResult {
  const gooseDir = join(HOME, ".local", "share", "goose", "sessions");
  const result: EditorResult = { name: "goose", label: "Goose", detected: false, sessions: [] };

  if (!existsSync(gooseDir)) return result;
  result.detected = true;

  // Scan JSONL session files
  for (const file of readDirNames(gooseDir).filter((f) => f.endsWith(".jsonl"))) {
    const filePath = join(gooseDir, file);
    try {
      const content = readTextSync(filePath);
      const lines = content.split("\n").filter(Boolean);
      let msgCount = 0;
      let firstUserText: string | null = null;

      for (const line of lines) {
        try {
          const obj = JSON.parse(line);
          if (obj.role === "user" || obj.role === "assistant") msgCount++;
          if (!firstUserText && obj.role === "user") {
            const text = typeof obj.content === "string" ? obj.content : "";
            firstUserText = text.substring(0, 120) || null;
          }
        } catch { /* skip */ }
      }

      result.sessions.push({
        source: "goose",
        composerId: file.replace(".jsonl", ""),
        name: firstUserText,
        createdAt: fileBirthtime(filePath),
        lastUpdatedAt: fileMtime(filePath),
        mode: "goose",
        folder: null,
        bubbleCount: msgCount,
        messageCount: msgCount,
      });
    } catch { /* skip */ }
  }

  // Note about SQLite sessions
  const dbPath = join(gooseDir, "sessions.db");
  if (existsSync(dbPath)) {
    result.note = "SQLite sessions available (run full version for complete data)";
  }

  return result;
}

// ── Editor: OpenCode (file-based sessions) ───────────────────

function scanOpenCode(): EditorResult {
  const storageDir = join(HOME, ".local", "share", "opencode", "storage");
  const sessionDir = join(storageDir, "session");
  const result: EditorResult = { name: "opencode", label: "OpenCode", detected: false, sessions: [] };

  if (!existsSync(sessionDir)) return result;
  result.detected = true;

  for (const file of readDirNames(sessionDir).filter((f) => f.endsWith(".json"))) {
    const filePath = join(sessionDir, file);
    try {
      const data = JSON.parse(readTextSync(filePath));
      result.sessions.push({
        source: "opencode",
        composerId: data.id || file.replace(".json", ""),
        name: data.title || null,
        createdAt: data.time_created ? new Date(data.time_created).getTime() : fileBirthtime(filePath),
        lastUpdatedAt: data.time_updated ? new Date(data.time_updated).getTime() : fileMtime(filePath),
        mode: "opencode",
        folder: data.directory || null,
        bubbleCount: 0,
      });
    } catch { /* skip */ }
  }

  return result;
}

// ── Editor: Windsurf / Antigravity (detection only) ──────────

function scanWindsurf(): EditorResult[] {
  const variants = [
    { id: "windsurf", label: "Windsurf", dataDir: join(HOME, ".codeium", "windsurf") },
    { id: "windsurf-next", label: "Windsurf Next", dataDir: join(HOME, ".codeium", "windsurf-next") },
    { id: "antigravity", label: "Antigravity", dataDir: join(HOME, ".codeium", "antigravity") },
  ];

  return variants.map((v) => {
    const detected = existsSync(v.dataDir);
    return {
      name: v.id,
      label: v.label,
      detected,
      sessions: [],
      note: detected ? "Requires running editor + full version for session data" : undefined,
    };
  });
}

// ── Editor: Zed (detection only) ─────────────────────────────

function scanZed(): EditorResult {
  let zedPath: string;
  switch (PLATFORM) {
    case "darwin":
      zedPath = join(HOME, "Library", "Application Support", "Zed");
      break;
    case "windows":
      zedPath = join(HOME, "AppData", "Local", "Zed");
      break;
    default:
      zedPath = join(HOME, ".config", "Zed");
  }

  const threadsDb = join(zedPath, "threads", "threads.db");
  const detected = existsSync(zedPath);

  return {
    name: "zed",
    label: "Zed",
    detected,
    sessions: [],
    note: detected && existsSync(threadsDb) ? "SQLite sessions available (run full version for complete data)" : undefined,
  };
}

// ── Aggregation & Display ────────────────────────────────────

function formatDate(ts: number | null): string {
  if (!ts) return "unknown";
  const d = new Date(ts);
  return d.toISOString().split("T")[0];
}

// ── Editor: Codebuff ────────────────────────────────────────

function scanCodebuff(): EditorResult {
  const result: EditorResult = { name: "codebuff", label: "Codebuff", detected: false, sessions: [] };
  const variants = ["manicode", "manicode-dev", "manicode-staging"];

  for (const variant of variants) {
    const projectsDir = join(HOME, ".config", variant, "projects");
    if (!existsSync(projectsDir)) continue;
    result.detected = true;
    const variantPrefix = variant === "manicode" ? "" : `${variant}::`;

    for (const projectBase of readDirNames(projectsDir)) {
      const projectDir = join(projectsDir, projectBase);
      if (!isDirectory(projectDir)) continue;

      const chatsDir = join(projectDir, "chats");
      if (!existsSync(chatsDir)) continue;

      for (const chatId of readDirNames(chatsDir)) {
        const chatDir = join(chatsDir, chatId);
        if (!isDirectory(chatDir)) continue;

        const messagesPath = join(chatDir, "chat-messages.json");
        if (!existsSync(messagesPath)) continue;

        let messages: any[] = [];
        try {
          const parsedMessages = JSON.parse(readTextSync(messagesPath));
          if (Array.isArray(parsedMessages)) messages = parsedMessages;
        } catch { /* skip */ }
        if (messages.length === 0) continue;

        let firstUser: string | null = null;
        for (const m of messages) {
          if (m && m.variant === "user" && typeof m.content === "string") {
            firstUser = m.content.substring(0, 120);
            break;
          }
        }

        // Try to recover the real cwd from run-state.json
        let folder: string | null = null;
        const runStatePath = join(chatDir, "run-state.json");
        if (existsSync(runStatePath)) {
          try {
            const rs = JSON.parse(readTextSync(runStatePath));
            folder = rs?.sessionState?.projectContext?.cwd
              || rs?.sessionState?.fileContext?.cwd
              || rs?.sessionState?.cwd
              || rs?.cwd
              || null;
          } catch { /* skip */ }
        }

        // chatId is an ISO timestamp with ':' replaced by '-'; reverse it.
        let createdAt: number | null = null;
        const isoFixed = chatId.replace(/(\d{4}-\d{2}-\d{2}T\d{2})-(\d{2})-(\d{2})/, "$1:$2:$3");
        const parsedTs = Date.parse(isoFixed);
        if (Number.isFinite(parsedTs)) createdAt = parsedTs;

        result.sessions.push({
          source: "codebuff",
          composerId: `${variantPrefix}${projectBase}::${chatId}`,
          name: firstUser,
          createdAt,
          lastUpdatedAt: fileMtime(chatDir),
          mode: "codebuff",
          folder,
          bubbleCount: messages.length,
          messageCount: messages.length,
        });
      }
    }
  }

  return result;
}

function formatRelative(ts: number | null): string {
  if (!ts) return "";
  const diff = Date.now() - ts;
  const mins = Math.floor(diff / 60000);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  return `${months}mo ago`;
}

function main() {
  const args = Deno.args;
  const jsonOutput = args.includes("--json");
  const showHelp = args.includes("--help") || args.includes("-h");

  if (showHelp) {
    console.log(`
${bold("Agentlytics")} — Deno Sandboxed Edition
Lightweight CLI analytics for your AI coding agents.

${bold("Usage:")}
  deno run --allow-read --allow-env mod.ts [options]
  deno run --allow-read --allow-env https://raw.githubusercontent.com/f/agentlytics/master/mod.ts

${bold("Options:")}
  --json      Output results as JSON
  --help, -h  Show this help message

${bold("Permissions:")}
  --allow-read   Read local editor data files (required)
  --allow-env    Access HOME directory path (required)

${bold("Full version:")}
  For the complete dashboard with SQLite support, cost analytics,
  and web UI, install the full version:
    npx agentlytics
    deno task start  ${dim("(from cloned repo)")}
`);
    Deno.exit(0);
  }

  // Collect from all editors
  const allResults: EditorResult[] = [];

  allResults.push(scanClaude());
  allResults.push(...scanVSCode());
  allResults.push(scanCursor());
  allResults.push(scanCodex());
  allResults.push(scanGemini());
  allResults.push(scanCopilot());
  allResults.push(scanCommandCode());
  allResults.push(scanKiro());
  allResults.push(scanGoose());
  allResults.push(scanOpenCode());
  allResults.push(...scanWindsurf());
  allResults.push(scanZed());
  allResults.push(scanCodebuff());

  // Gather all sessions
  const allSessions = allResults.flatMap((r) => r.sessions);
  allSessions.sort((a, b) => (b.lastUpdatedAt || b.createdAt || 0) - (a.lastUpdatedAt || a.createdAt || 0));

  // Unique projects
  const projects = new Set(allSessions.map((s) => s.folder).filter(Boolean));

  // Date range
  const timestamps = allSessions.map((s) => s.createdAt || s.lastUpdatedAt || 0).filter((t) => t > 0);
  const oldest = timestamps.length > 0 ? Math.min(...timestamps) : null;
  const newest = timestamps.length > 0 ? Math.max(...timestamps) : null;

  // Total messages
  const totalMessages = allSessions.reduce((sum, s) => sum + (s.messageCount || s.bubbleCount || 0), 0);

  if (jsonOutput) {
    const output = {
      timestamp: new Date().toISOString(),
      platform: PLATFORM,
      editors: allResults.map((r) => ({
        name: r.name,
        label: r.label,
        detected: r.detected,
        sessionCount: r.sessions.length,
        note: r.note || null,
      })),
      summary: {
        totalSessions: allSessions.length,
        totalMessages,
        totalProjects: projects.size,
        dateRange: {
          oldest: oldest ? new Date(oldest).toISOString() : null,
          newest: newest ? new Date(newest).toISOString() : null,
        },
      },
      sessions: allSessions,
    };
    console.log(JSON.stringify(output, null, 2));
    return;
  }

  // ── Pretty CLI output ────────────────────────────────────

  const c1 = hex("#818cf8"), c2 = hex("#f472b6"), c3 = hex("#34d399"), c4 = hex("#fbbf24");

  console.log("");
  console.log(`  ${c1("(● ●)")} ${c2("[● ●]")}   ${bold("Agentlytics")} ${dim("— Deno Sandboxed Edition")}`);
  console.log(`  ${c3("{● ●}")} ${c4("<● ●>")}   ${dim("Lightweight CLI analytics for AI coding agents")}`);
  console.log("");

  // Editor detection table
  const detected = allResults.filter((r) => r.detected);
  const notDetected = allResults.filter((r) => !r.detected);

  for (const r of allResults) {
    if (r.detected && r.sessions.length > 0) {
      const count = r.sessions.length;
      console.log(`  ${green("✓")} ${bold(r.label.padEnd(22))} ${dim(`${count} session${count === 1 ? "" : "s"}`)}`);
    } else if (r.detected) {
      const note = r.note ? dim(` (${r.note})`) : "";
      console.log(`  ${yellow("●")} ${bold(r.label.padEnd(22))} ${dim("detected")}${note}`);
    } else {
      console.log(`  ${dim("–")} ${dim(r.label.padEnd(22) + "–")}`);
    }
  }

  console.log("");

  if (allSessions.length === 0) {
    console.log(dim("  No sessions found. Make sure your editors have been used."));
    console.log("");
    return;
  }

  // Summary stats
  console.log(`  ${bold("Summary")}`);
  console.log(`  ${"Sessions".padEnd(18)} ${bold(String(allSessions.length))}`);
  if (totalMessages > 0) {
    console.log(`  ${"Messages".padEnd(18)} ${bold(String(totalMessages))}`);
  }
  console.log(`  ${"Projects".padEnd(18)} ${bold(String(projects.size))}`);
  console.log(`  ${"Editors".padEnd(18)} ${bold(String(detected.filter((r) => r.sessions.length > 0).length))} ${dim(`of ${allResults.length} checked`)}`);
  if (oldest && newest) {
    console.log(`  ${"Date range".padEnd(18)} ${dim(`${formatDate(oldest)} → ${formatDate(newest)}`)}`);
  }
  console.log("");

  // Top 5 recent sessions
  const recent = allSessions.slice(0, 5);
  if (recent.length > 0) {
    console.log(`  ${bold("Recent Sessions")}`);
    for (const s of recent) {
      const name = (s.name || "Untitled").substring(0, 50);
      const editor = allResults.find((r) => r.name === s.source)?.label || s.source;
      const time = formatRelative(s.lastUpdatedAt || s.createdAt);
      console.log(`  ${dim("•")} ${name}`);
      console.log(`    ${dim(`${editor} · ${time}${s.folder ? ` · ${basename(s.folder)}` : ""}`)}`);
    }
    console.log("");
  }

  // Top projects
  if (projects.size > 0) {
    const projectCounts = new Map<string, number>();
    for (const s of allSessions) {
      if (s.folder) {
        projectCounts.set(s.folder, (projectCounts.get(s.folder) || 0) + 1);
      }
    }
    const topProjects = [...projectCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5);

    if (topProjects.length > 0) {
      console.log(`  ${bold("Top Projects")}`);
      for (const [folder, count] of topProjects) {
        console.log(`  ${dim("•")} ${basename(folder).padEnd(30)} ${dim(`${count} session${count === 1 ? "" : "s"}`)}`);
      }
      console.log("");
    }
  }

  // Footer
  console.log(dim("  For the full dashboard with cost analytics and web UI:"));
  console.log(cyan("    npx agentlytics"));
  console.log("");
}

main();
