/**
 * Cursor cost/hygiene suggestion analyzer.
 *
 * Pure function: takes a config snapshot (from editors/cursor.getConfig)
 * and a usage snapshot (from analyzeUsage below) and returns an array of
 * actionable suggestions.
 *
 * Each Suggestion:
 *   { id, severity: 'low'|'medium'|'high', category, title, detail,
 *     scope: { type: 'global'|'project', folder? },
 *     impact: { tokensPerRequest?, requestsObserved?, monthlyTokens? },
 *     fix: { action, path?, hint } }
 */

// MCP tool calls are recorded in the cache under editor-specific prefixes:
//   - Cursor CLI / IDE: `mcp-<server>-user-<server>-<tool>` (dashes)
//   - Claude Code / Codex / others: `mcp__<server>__<tool>` (double underscore)
//   - Some variants: `mcp_<server>_<tool>` (single underscore)
// A tool name is MCP-originated iff it starts with any of these prefixes.
const path = require('path');
const { getModelPricing } = require('../pricing');

const MCP_PREFIXES = ['mcp-', 'mcp__', 'mcp_'];

// Cursor's adapters don't reliably record per-message model, so most rows
// come back with model=null. Fall back to Cursor Auto token rates (the
// default mode users are billed at when they don't pick a specific model).
// Source: cursor.com/docs/models-and-pricing (2026-04).
const FALLBACK_PRICING = getModelPricing('cursor-auto') || { input: 1.25, output: 6, cacheRead: 0.25 };
const FALLBACK_INPUT_PRICE = FALLBACK_PRICING.input; // USD per 1M input tokens

function isMcpTool(toolName) {
  if (!toolName) return false;
  return MCP_PREFIXES.some(p => toolName.startsWith(p));
}

function toolMatchesServer(toolName, serverName) {
  if (!toolName || !serverName) return false;
  if (!isMcpTool(toolName)) return false;
  const t = toolName.toLowerCase();
  const s = serverName.toLowerCase();
  // Match as a bounded token between any of the MCP separators (-, _, __).
  // e.g. "mcp-redash-tool", "mcp__redash__tool", "mcp_redash_tool".
  return (
    t.includes(`-${s}-`) ||
    t.includes(`__${s}__`) ||
    t.includes(`_${s}_`) ||
    // trailing: "mcp-redash" / "mcp__redash" / "mcp_redash"
    t.endsWith(`-${s}`) || t.endsWith(`__${s}`) || t.endsWith(`_${s}`)
  );
}

// Char-count thresholds (approx 4 chars/token).
const HEAVY_RULE_CHARS = 1000;      // ~250 tokens — rule is "heavy" above this when alwaysApply
const BLOAT_TOTAL_CHARS = 4000;     // ~1000 tokens of always-on rules across a project
const DEAD_SERVER_MIN_SESSIONS = 5; // need at least this many sessions before calling a server dead
// MCP server count thresholds. Each server contributes tool definitions
// that are loaded into every turn's context. Cursor's soft ceiling is
// ~40 active tools across all servers; crossing ~5 servers already costs
// thousands of tokens/turn and degrades tool-selection quality.
const MCP_SERVER_COUNT_WARN = 5;
const MCP_SERVER_COUNT_HIGH = 10;
const RETRY_LOOP_MIN_REPEATS = 3;
const HEAVY_TOOL_TOKENS = 300;      // tool schema above this is "heavy"
const HEAVY_SERVER_TOKENS = 2000;   // server whose combined tools cross this deserves a mention

// Models considered premium/expensive when set as default.
const PREMIUM_MODEL_PATTERNS = [/opus/i, /gpt-5/i, /gpt-4(\.|$|o|-turbo)/i, /claude-3\.7?-opus/i, /claude-4.*opus/i, /1m/i];

function isPremiumModel(modelId) {
  if (!modelId) return false;
  return PREMIUM_MODEL_PATTERNS.some(rx => rx.test(modelId));
}

/**
 * Build a usage snapshot from the cache DB. Pass the better-sqlite3 handle
 * (cache.getDb()). Returns:
 *   {
 *     cursorSessions: total rows in chats where source='cursor',
 *     cursorSessionsByFolder: Map<folder, count>,
 *     cursorToolNames: Set<string>                 // all distinct tool names seen across cursor sessions
 *     cursorToolNamesByFolder: Map<folder, Set>,
 *     cursorSessionsLast30d: number,
 *   }
 */
// Cursor + Cursor Agent (CLI) are the sources that share ~/.cursor/mcp.json.
// Note: cursor-agent's adapter does not populate the tool_calls table, so to
// detect MCP usage there we scan message content for "[tool-call: mcp-..." markers.
const CURSOR_SOURCES = ['cursor', 'cursor-agent'];

function analyzeUsage(db) {
  const out = {
    cursorSessions: 0,
    cursorSessionsByFolder: new Map(),
    cursorToolNames: new Set(),
    cursorToolNamesByFolder: new Map(),
    cursorSessionsLast30d: 0,
    // Tool-call-style markers discovered inside message bodies. Used to catch
    // MCP invocations from adapters (like cursor-agent) that don't populate
    // the tool_calls table.
    messageMcpMentions: new Set(),
    messageMcpMentionsByFolder: new Map(),
    // MCP-prefixed tool calls from non-Cursor sources. Same server used from
    // Claude Code still demonstrates the user relies on it — don't flag as dead.
    otherEditorMcpTools: new Map(), // Map<source, Set<toolName>>
  };
  if (!db) return out;
  try {
    const cursorPlaceholders = CURSOR_SOURCES.map(() => '?').join(',');
    const totalRow = db.prepare(
      `SELECT COUNT(*) as n FROM chats WHERE source IN (${cursorPlaceholders})`
    ).get(...CURSOR_SOURCES);
    out.cursorSessions = totalRow?.n || 0;

    const folderRows = db.prepare(`
      SELECT folder, COUNT(*) as n FROM chats
      WHERE source IN (${cursorPlaceholders}) AND folder IS NOT NULL
      GROUP BY folder
    `).all(...CURSOR_SOURCES);
    for (const r of folderRows) {
      out.cursorSessionsByFolder.set(
        r.folder,
        (out.cursorSessionsByFolder.get(r.folder) || 0) + r.n
      );
    }

    const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;
    const recentRow = db.prepare(`
      SELECT COUNT(*) as n FROM chats
      WHERE source IN (${cursorPlaceholders}) AND COALESCE(last_updated_at, created_at) >= ?
    `).get(...CURSOR_SOURCES, thirtyDaysAgo);
    out.cursorSessionsLast30d = recentRow?.n || 0;

    const toolRows = db.prepare(`
      SELECT tool_name, folder FROM tool_calls WHERE source IN (${cursorPlaceholders})
    `).all(...CURSOR_SOURCES);
    for (const r of toolRows) {
      if (r.tool_name) out.cursorToolNames.add(r.tool_name);
      if (r.folder) {
        if (!out.cursorToolNamesByFolder.has(r.folder)) {
          out.cursorToolNamesByFolder.set(r.folder, new Set());
        }
        out.cursorToolNamesByFolder.get(r.folder).add(r.tool_name);
      }
    }

    // Scan message content for [tool-call: mcp-...] markers so we pick up
    // invocations from adapters that don't populate tool_calls (cursor-agent).
    const msgRows = db.prepare(`
      SELECT c.folder, m.content FROM messages m
      JOIN chats c ON m.chat_id = c.id
      WHERE c.source IN (${cursorPlaceholders})
        AND m.content LIKE '%tool-call: mcp%'
    `).all(...CURSOR_SOURCES);
    const markerRx = /tool-call:\s*(mcp[-_][\w-]+)/gi;
    for (const r of msgRows) {
      if (!r.content) continue;
      let m;
      while ((m = markerRx.exec(r.content)) !== null) {
        const marker = m[1];
        out.messageMcpMentions.add(marker);
        if (r.folder) {
          if (!out.messageMcpMentionsByFolder.has(r.folder)) {
            out.messageMcpMentionsByFolder.set(r.folder, new Set());
          }
          out.messageMcpMentionsByFolder.get(r.folder).add(marker);
        }
      }
    }

    // Cross-editor MCP tool usage — captures Claude Code / Codex / etc.
    const crossRows = db.prepare(`
      SELECT DISTINCT source, tool_name FROM tool_calls
      WHERE source NOT IN (${cursorPlaceholders})
        AND (tool_name LIKE 'mcp-%' OR tool_name LIKE 'mcp_%')
    `).all(...CURSOR_SOURCES);
    for (const r of crossRows) {
      if (!out.otherEditorMcpTools.has(r.source)) out.otherEditorMcpTools.set(r.source, new Set());
      out.otherEditorMcpTools.get(r.source).add(r.tool_name);
    }

    // Per-folder inference count and weighted $/Mtok. Each LLM inference
    // carries the always-on rules in its input. Cursor splits one agent
    // conversation across many "assistant" bubbles (thinking, tool-call,
    // text, next tool-call, …) — those are NOT separate inferences.
    // Real inference count ≈ user_messages + tool_call_roundtrips.
    out.assistantTurnsByFolder = new Map();
    out.avgInputPriceByFolder = new Map();
    out.assistantTurnsTotal = 0;
    out.avgInputPriceGlobal = 0;

    // For pricing: model column is null in cursor messages, so we fall back
    // to a Sonnet-tier default later. Keep the model query so other editors
    // still benefit; but aggregate user+tool_calls as the inference proxy.
    const modelRows = db.prepare(`
      SELECT c.folder, m.model, COUNT(*) as n
      FROM messages m JOIN chats c ON m.chat_id = c.id
      WHERE c.source IN (${cursorPlaceholders})
        AND m.role = 'user'
        AND c.folder IS NOT NULL
      GROUP BY c.folder, m.model
    `).all(...CURSOR_SOURCES);

    // Add tool_calls as additional inference roundtrips (each tool result
    // triggers a follow-up LLM call that also carries the system prompt).
    const toolInferenceRows = db.prepare(`
      SELECT folder, COUNT(*) as n FROM tool_calls
      WHERE source IN (${cursorPlaceholders}) AND folder IS NOT NULL
      GROUP BY folder
    `).all(...CURSOR_SOURCES);
    const toolInferencesByFolder = new Map();
    for (const r of toolInferenceRows) toolInferencesByFolder.set(r.folder, r.n);
    const folderAcc = new Map(); // folder -> { n, priced }
    let globalN = 0, globalPriced = 0;
    for (const r of modelRows) {
      const pricing = r.model ? getModelPricing(r.model) : null;
      const price = pricing?.input ?? FALLBACK_INPUT_PRICE;
      let acc = folderAcc.get(r.folder);
      if (!acc) { acc = { n: 0, priced: 0 }; folderAcc.set(r.folder, acc); }
      acc.n += r.n;
      acc.priced += r.n * price;
      globalN += r.n;
      globalPriced += r.n * price;
    }
    for (const [folder, acc] of folderAcc) {
      const toolInfer = toolInferencesByFolder.get(folder) || 0;
      // user prompts + tool roundtrips = approximate LLM inference count
      out.assistantTurnsByFolder.set(folder, acc.n + toolInfer);
      out.avgInputPriceByFolder.set(folder, acc.n ? acc.priced / acc.n : 0);
    }
    // Also include folders that have tool_calls but no user messages recorded
    for (const [folder, n] of toolInferencesByFolder) {
      if (!out.assistantTurnsByFolder.has(folder)) {
        out.assistantTurnsByFolder.set(folder, n);
      }
    }
    let totalToolInfer = 0;
    for (const n of toolInferencesByFolder.values()) totalToolInfer += n;
    out.assistantTurnsTotal = globalN + totalToolInfer;
    out.avgInputPriceGlobal = globalN ? globalPriced / globalN : 0;

    // Real observed input tokens per folder (from chat_stats). Used to cap
    // waste estimates — we can't have wasted more input tokens than were
    // actually spent. Cursor messages don't carry model metadata, so $/Mtok
    // stays a fallback; but the token ceiling comes from real data.
    out.realInputTokensByFolder = new Map();
    out.realInputTokensTotal = 0;
    out.realOutputTokensTotal = 0;
    out.realCacheReadTotal = 0;
    try {
      const inputRows = db.prepare(`
        SELECT c.folder,
               SUM(cs.total_input_tokens) as in_tok,
               SUM(cs.total_output_tokens) as out_tok,
               SUM(cs.total_cache_read) as cache_r
        FROM chats c JOIN chat_stats cs ON cs.chat_id = c.id
        WHERE c.source IN (${cursorPlaceholders}) AND c.folder IS NOT NULL
        GROUP BY c.folder
      `).all(...CURSOR_SOURCES);
      for (const r of inputRows) {
        out.realInputTokensByFolder.set(r.folder, r.in_tok || 0);
        out.realInputTokensTotal += r.in_tok || 0;
        out.realOutputTokensTotal += r.out_tok || 0;
        out.realCacheReadTotal += r.cache_r || 0;
      }
    } catch { /* ignore */ }
    // Cursor never writes per-message model — waste $/Mtok always fallback.
    // Flag so findings can mark themselves estimated.
    out.pricingIsEstimated = true;

    // Cursor Agent (CLI) redacts tool-call metadata in its adapter output, so
    // we have no way to see which MCP servers it invoked. As a last-resort
    // safety net, record assistant-message content from cursor-agent sessions
    // so the analyzer can keyword-match server names and avoid false "unused"
    // flags when we literally cannot observe the tool invocations.
    const agentMsgRow = db.prepare(`
      SELECT GROUP_CONCAT(lower(substr(content, 1, 2000)), ' ') as blob
      FROM messages m JOIN chats c ON m.chat_id = c.id
      WHERE c.source = 'cursor-agent' AND role = 'assistant'
    `).get();
    out.cursorAgentContentBlob = (agentMsgRow && agentMsgRow.blob) || '';
    out.cursorAgentHasContent = out.cursorAgentContentBlob.length > 0;

    // Per-tool invocation count across all cursor sessions. Lets us tell
    // "which MCP tools are heavy but never actually called" — the big win
    // for context-token reduction.
    out.mcpToolInvocationCount = new Map();
    try {
      const callRows = db.prepare(`
        SELECT t.tool_name, COUNT(*) as n
        FROM tool_calls t JOIN chats c ON t.chat_id = c.id
        WHERE c.source IN (${cursorPlaceholders})
          AND (t.tool_name LIKE 'mcp-%' OR t.tool_name LIKE 'mcp__%' OR t.tool_name LIKE 'mcp_%')
        GROUP BY t.tool_name
      `).all(...CURSOR_SOURCES);
      for (const r of callRows) out.mcpToolInvocationCount.set(r.tool_name, r.n);
    } catch { /* tool_calls may not exist */ }

    // Retry loops — same MCP tool + same args called N+ times in one chat.
    // These are burning tokens without progress: the agent hits an error
    // or stale result and tries the same call again. RETRY_LOOP_MIN_REPEATS
    // trips the threshold; we report the worst offenders per tool.
    out.retryLoops = [];
    try {
      const loopRows = db.prepare(`
        SELECT c.folder, t.tool_name, t.args_json, t.chat_id, COUNT(*) as n
        FROM tool_calls t JOIN chats c ON t.chat_id = c.id
        WHERE c.source IN (${cursorPlaceholders})
          AND (t.tool_name LIKE 'mcp-%' OR t.tool_name LIKE 'mcp__%' OR t.tool_name LIKE 'mcp_%')
        GROUP BY t.chat_id, t.tool_name, t.args_json
        HAVING n >= ?
      `).all(...CURSOR_SOURCES, RETRY_LOOP_MIN_REPEATS);
      for (const r of loopRows) out.retryLoops.push(r);
    } catch { /* schema may not exist yet */ }
  } catch {
    // cache may be empty or uninitialized — return zero'd snapshot
  }
  // Unified surface consumed by suggestions/index.js. Keep cursor-specific
  // fields above for the analyzer; these are the orchestrator contract.
  out.sessions = out.cursorSessions;
  const realInput = out.realInputTokensTotal || 0;
  const realOutput = out.realOutputTokensTotal || 0;
  const realCacheRead = out.realCacheReadTotal || 0;
  const realCostCeiling =
    (realInput / 1_000_000) * FALLBACK_PRICING.input +
    (realOutput / 1_000_000) * (FALLBACK_PRICING.output || 0) +
    (realCacheRead / 1_000_000) * (FALLBACK_PRICING.cacheRead || 0);
  out.pricing = {
    estimated: !!out.pricingIsEstimated,
    fallbackTier: 'cursor-auto',
    fallbackRates: {
      input: FALLBACK_PRICING.input,
      output: FALLBACK_PRICING.output,
      cacheRead: FALLBACK_PRICING.cacheRead,
    },
    fallbackInputPriceUsdPerMtok: FALLBACK_INPUT_PRICE,
    note: out.pricingIsEstimated
      ? `Cursor does not record per-message model — $ figures use Cursor Auto token rates ($${FALLBACK_PRICING.input}/Mtok input, $${FALLBACK_PRICING.cacheRead}/Mtok cache, $${FALLBACK_PRICING.output}/Mtok output). Real $ depends on the actual model mix (Sonnet/Opus/GPT-5 cost more).`
      : null,
    realInputTokensObserved: realInput,
    realOutputTokensObserved: realOutput,
    realCacheReadObserved: realCacheRead,
    realCostCeiling,
    realInputCostAtFallback: (realInput / 1_000_000) * FALLBACK_INPUT_PRICE,
  };
  return out;
}

function mcpTools(toolSet) {
  const out = new Set();
  for (const t of toolSet) {
    if (isMcpTool(t)) out.add(t);
  }
  return out;
}

function wasteForFolders(usage, folders, tokensPerTurn) {
  let turns = 0, tokens = 0, usd = 0, estimated = false;
  for (const f of folders) {
    const w = wasteFor(usage, f, tokensPerTurn);
    turns += w.turns; tokens += w.tokens; usd += w.usd;
    if (w.estimated) estimated = true;
  }
  return { turns, tokens, usd, estimated };
}

function wasteFor(usage, folder, tokensPerTurn) {
  if (!tokensPerTurn) return { turns: 0, tokens: 0, usd: 0, estimated: false };
  const turns = folder
    ? (usage.assistantTurnsByFolder.get(folder) || 0)
    : usage.assistantTurnsTotal;
  const price = folder
    ? (usage.avgInputPriceByFolder.get(folder) || usage.avgInputPriceGlobal)
    : usage.avgInputPriceGlobal;
  const rawTokens = tokensPerTurn * turns;
  // Cursor caches the system prompt (rules + MCP tool schemas). Turn 1
  // is billed at full input rate; subsequent turns hit the cache-read
  // rate (Cursor Auto: $0.25/Mtok, ~20% of input). Model it honestly so
  // big turn counts don't inflate waste to absurd numbers.
  const cacheReadRate = (FALLBACK_PRICING.cacheRead || price * 0.2);
  const firstTurnUsd = turns >= 1 ? (tokensPerTurn * price) / 1_000_000 : 0;
  const cachedTurnsUsd = turns > 1 ? ((tokensPerTurn * (turns - 1)) * cacheReadRate) / 1_000_000 : 0;
  let usd = firstTurnUsd + cachedTurnsUsd;
  // Safety cap: even with caching, waste $ for a single suggestion cannot
  // exceed total input spend on the folder (we don't double-count cache).
  const realTokens = folder
    ? (usage.realInputTokensByFolder?.get(folder) || 0)
    : (usage.realInputTokensTotal || 0);
  const realCap = realTokens > 0 ? (realTokens / 1_000_000) * price : Infinity;
  if (usd > realCap) usd = realCap;
  const tokens = realTokens > 0 ? Math.min(rawTokens, realTokens) : rawTokens;
  const estimated = !!usage.pricingIsEstimated;
  return { turns, tokens, usd, estimated };
}

function fmtUsd(n) {
  if (!n || !isFinite(n)) return '$0';
  if (n < 0.01) return '<$0.01';
  if (n < 1) return `$${n.toFixed(2)}`;
  return `$${n.toFixed(2)}`;
}

function fmtTokens(n) {
  if (!n) return '0';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function wasteLine(d) {
  if (!d.tokens) return '';
  const tag = d.estimated ? ' (est., Sonnet-tier $3/Mtok — Cursor does not record per-message model)' : '';
  return `Est. waste so far: ${fmtTokens(d.tokens)} tokens over ${d.turns} turns ≈ ${fmtUsd(d.usd)}${tag}.`;
}

function deriveBundleHost(rulePaths) {
  if (!rulePaths || !rulePaths.length) return null;
  // Strip `/.cursor/rules/<file>` → host folder.
  const hosts = rulePaths.map(p => {
    const idx = p.lastIndexOf('/.cursor/rules/');
    return idx > 0 ? p.slice(0, idx) : p;
  });
  // If all rules share one host, use it. Otherwise pick the common prefix.
  const first = hosts[0];
  if (hosts.every(h => h === first)) return first;
  let i = 0;
  while (i < first.length && hosts.every(h => h[i] === first[i])) i++;
  const prefix = first.slice(0, i);
  const trimmed = prefix.replace(/\/$/, '');
  return trimmed || first;
}

function agentBlobMentionsServer(usage, serverName) {
  if (!usage.cursorAgentHasContent || !serverName) return false;
  const escaped = serverName.toLowerCase().replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&');
  return new RegExp(`\\b${escaped}\\b`).test(usage.cursorAgentContentBlob);
}

// Validate a skill against Cursor's discovery/loading rules.
// Emits zero or more findings per skill. Checks:
//  - name/folder mismatch    → invisible to discovery
//  - missing description     → never auto-triggers
//  - weak description        → rarely auto-triggers (too short)
//  - description without trigger phrases → weak matching
//  - SKILL.md body too long  → evicts context when loaded
//  - disable-model-invocation: true + no slash-use signal → dormant skill
const TRIGGER_PATTERNS = [/\buse when\b/i, /\bwhen (?:the )?user\b/i, /\bif (?:the )?user\b/i, /\bapply (?:when|if)\b/i];
const SKILL_BODY_LINE_LIMIT = 500;
const SKILL_DESC_MIN_CHARS = 30;

function skillChecks(skill) {
  const out = [];
  // 1. Folder/name mismatch — skill becomes invisible.
  if (skill.skillName && skill.skillName !== skill.name) {
    out.push({
      id: 'skill-name-mismatch',
      severity: 'high',
      title: `Skill "${skill.name}" has mismatched name in frontmatter`,
      detail: `Folder is \`${skill.name}\` but SKILL.md frontmatter declares \`name: ${skill.skillName}\`. Cursor requires these to match or the skill is not discovered at all — its tokens just sit on disk.`,
      action: 'fix-name',
      hint: `Set frontmatter name to "${skill.name}" or rename the folder to "${skill.skillName}"`,
    });
  }
  // 2. Missing description entirely.
  if (!skill.description) {
    out.push({
      id: 'skill-no-description',
      severity: 'medium',
      title: `Skill "${skill.name}" has no description`,
      detail: `The \`description\` frontmatter is how the agent decides when the skill applies. Without one the skill never auto-triggers; only explicit /${skill.name} invocation works.`,
      action: 'add-description',
      hint: 'Add a description: what the skill does + when to use it + natural trigger phrases',
    });
  } else {
    // 3. Description too short.
    if (skill.description.length < SKILL_DESC_MIN_CHARS) {
      out.push({
        id: 'skill-weak-description',
        severity: 'low',
        title: `Skill "${skill.name}" has a weak description (${skill.description.length} chars)`,
        detail: `Description is too short to distinguish this skill from others. The agent uses it to match user intent — vague or ultra-terse descriptions rarely auto-trigger.`,
        action: 'improve-description',
        hint: 'Expand to include what, when, and natural trigger phrases users actually say',
      });
    }
    // 4. No trigger phrases.
    else if (!TRIGGER_PATTERNS.some(re => re.test(skill.description))) {
      out.push({
        id: 'skill-no-triggers',
        severity: 'low',
        title: `Skill "${skill.name}" description lacks trigger phrases`,
        detail: `Effective skill descriptions name the user intent that should invoke them — phrases like "use when...", "when the user asks to...". Without them the agent is less likely to pick this skill over others.`,
        action: 'add-triggers',
        hint: 'Add a "Use when..." clause naming the user intent',
      });
    }
  }
  // 5. SKILL.md body too long — evicts context when loaded.
  if (skill.bodyLines > SKILL_BODY_LINE_LIMIT) {
    out.push({
      id: 'skill-too-long',
      severity: 'medium',
      title: `Skill "${skill.name}" SKILL.md is ${skill.bodyLines} lines (~${skill.bodyTokens} tokens)`,
      detail: `Cursor loads the full SKILL.md body when the skill matches. Anything over ~500 lines starts evicting conversation context. Move long-form docs, examples, or scripts into references/ — those load progressively only when the skill invokes them.`,
      action: 'split-skill',
      hint: 'Move long-form content into references/ subdirectory; keep SKILL.md to the essential instructions',
    });
  }
  // 6. disable-model-invocation + no clear reason. Downgrade to a slash-only
  // skill is a choice, but flag it as low-severity so the user knows it's
  // intentional dormant.
  if (skill.disableModelInvocation) {
    out.push({
      id: 'skill-manual-only',
      severity: 'low',
      title: `Skill "${skill.name}" is manual-only (disable-model-invocation: true)`,
      detail: `This skill will never auto-trigger. Only explicit /${skill.name} invocation works. If that's intentional (e.g. destructive workflow that must be user-initiated), ignore. If not, remove disable-model-invocation.`,
      action: 'review-manual',
      hint: 'Remove `disable-model-invocation: true` if you want auto-triggering',
    });
  }
  return out;
}

function analyze(config, usage) {
  const suggestions = [];

  // Pre-pass: group always-on rules by the folder that hosts their
  // `.cursor/rules/` dir. Inherited rules end up under the ancestor folder
  // exactly once, regardless of how many subfolders inherit them. This means
  // one bundle finding per physical host — no duplicate "6 rules = 5+1" cards.
  const rulesByHost = new Map(); // host → { rulesByPath, affected }
  for (const proj of config.projects || []) {
    for (const rule of proj.rules || []) {
      if (!rule.alwaysApply) continue;
      const host = rule.sourceFolder || proj.folder;
      if (!rulesByHost.has(host)) rulesByHost.set(host, { rulesByPath: new Map(), affected: new Set() });
      const entry = rulesByHost.get(host);
      entry.rulesByPath.set(rule.path, rule);
      entry.affected.add(proj.folder);
    }
  }
  const hostHasBloat = new Map();
  for (const [host, e] of rulesByHost) {
    let chars = 0;
    for (const r of e.rulesByPath.values()) chars += r.bodyChars;
    hostHasBloat.set(host, chars > BLOAT_TOTAL_CHARS);
  }

  // ---- Project-scope checks: rules ----
  for (const proj of config.projects || []) {
    const sessionsHere = usage.cursorSessionsByFolder.get(proj.folder) || 0;
    const toolsHere = usage.cursorToolNamesByFolder.get(proj.folder) || new Set();

    // S1: legacy .cursorrules present (always applied, no targeting)
    if (proj.legacyCursorrules) {
      const legacyWaste = wasteFor(usage, proj.folder, proj.legacyCursorrules.bodyTokens);
      const wasteStr = wasteLine(legacyWaste);
      suggestions.push({
        id: `legacy-cursorrules:${proj.folder}`,
        severity: 'medium',
        category: 'rules',
        title: 'Legacy .cursorrules file is always injected',
        detail: `The .cursorrules format is applied to every request in this project. Migrate its content into .cursor/rules/*.mdc with proper \`globs:\` or \`description:\` frontmatter so it loads only when relevant.`
          + (wasteStr ? `\n\n${wasteStr}` : ''),
        scope: { type: 'project', folder: proj.folder },
        impact: {
          tokensPerRequest: proj.legacyCursorrules.bodyTokens,
          requestsObserved: legacyWaste.turns,
          tokensWasted: legacyWaste.tokens,
          usdWasted: legacyWaste.usd,
          usdEstimated: legacyWaste.estimated,
        },
        fix: { action: 'migrate', path: proj.legacyCursorrules.path, hint: 'Move to .cursor/rules/<name>.mdc' },
      });
    }

    // Whether the bundle-level finding for any of this project's rule hosts
    // will fire. If yes, skip per-rule "heavy" to avoid double-reporting the
    // same cost. Contradictions/orphans are misconfigs, still emitted (with
    // zero waste if covered by a bundle).
    const ruleHostHasBloat = r => hostHasBloat.get(r.sourceFolder || proj.folder) === true;

    // Per-rule checks — one unified finding per rule with a list of issues.
    for (const rule of proj.rules) {
      // Rule may live in an ancestor .cursor/rules/ — show path relative to
      // its sourceFolder so the display is stable regardless of which
      // subfolder triggered the inspection.
      const base = rule.sourceFolder || proj.folder;
      const rel = rule.path.startsWith(base + '/')
        ? rule.path.slice(base.length + 1)
        : rule.path;

      const issues = [];
      const heavy = rule.alwaysApply && rule.bodyChars > HEAVY_RULE_CHARS;
      const contradiction = rule.alwaysApply && rule.globs;
      const orphan = !rule.alwaysApply && !rule.globs && !rule.description;

      // Only emit the heavy issue when it's not already covered by bloat.
      const thisHostHasBloat = ruleHostHasBloat(rule);
      if (heavy && !thisHostHasBloat) {
        issues.push({
          key: 'heavy',
          label: 'Heavy + alwaysApply',
          text: `Rule is ${rule.bodyChars} chars (~${rule.bodyTokens} tokens) and injected into every request.`,
        });
      }
      if (contradiction) {
        const globsStr = typeof rule.globs === 'string' ? rule.globs : JSON.stringify(rule.globs);
        issues.push({
          key: 'always-with-globs',
          label: 'alwaysApply overrides globs',
          text: `Declares \`globs: ${globsStr}\` but \`alwaysApply: true\` — globs are silently ignored.`,
        });
      }
      if (orphan) {
        issues.push({
          key: 'orphan',
          label: 'No attachment trigger',
          text: 'No `globs`, no `description`, and `alwaysApply: false` — will rarely (or never) load.',
        });
      }

      if (issues.length === 0) continue;

      // Contradictions (alwaysApply + globs) are silent misconfigs: the user
      // THOUGHT they scoped the rule but it loads everywhere. Real cost leak.
      // Escalate to high when heavy or when there's significant observed waste.
      const heavySeverity = heavy && rule.bodyChars > HEAVY_RULE_CHARS * 2 ? 'high' : 'medium';
      let severity;
      if (contradiction && heavy) severity = 'high';
      else if (contradiction) severity = 'high';
      else if (heavy) severity = heavySeverity;
      else severity = 'low';

      const projShort = (rule.sourceFolder || proj.folder).split('/').filter(Boolean).pop();
      const title = issues.length === 1
        ? `${issues[0].label} in ${projShort}: ${rel}`
        : `${issues.length} issues in ${projShort}: ${rel}`;

      const tokensPerTurn = rule.alwaysApply ? rule.bodyTokens : 0;
      // If the bundle finding already accounts for this rule's tokens, don't
      // re-charge the waste here — would double-count in totals.
      const waste = thisHostHasBloat
        ? { turns: wasteFor(usage, proj.folder, tokensPerTurn).turns, tokens: 0, usd: 0 }
        : wasteFor(usage, proj.folder, tokensPerTurn);
      const wasteStr = wasteLine(waste);
      const bloatNote = thisHostHasBloat
        ? '\n\nCost is counted in the always-on rules bundle finding for this host — this entry highlights the misconfiguration itself.'
        : '';

      const detail = issues.map(i => `• ${i.text}`).join('\n')
        + (wasteStr ? `\n\n${wasteStr}` : '')
        + bloatNote
        + '\n\nFix: add `globs:` to scope to specific files, `description:` so the model attaches it only when relevant, or drop `alwaysApply` if you have targeting. Delete the rule if it has no purpose.';

      suggestions.push({
        id: `rule-issues:${rule.path}`,
        severity,
        category: 'rules',
        title,
        detail,
        scope: { type: 'project', folder: proj.folder, folders: [proj.folder] },
        impact: {
          tokensPerRequest: tokensPerTurn,
          requestsObserved: waste.turns,
          tokensWasted: waste.tokens,
          usdWasted: waste.usd,
          usdEstimated: waste.estimated,
        },
        fix: { action: 'fix-rule', path: rule.path, hint: 'Edit frontmatter: set alwaysApply: false and add globs or description' },
      });
    }

    // S5a: per-project MCP server-count bloat (project config mirror of global check)
    const activeProj = (proj.mcpServers || []).filter(s => !s.disabled);
    if (activeProj.length >= MCP_SERVER_COUNT_WARN) {
      const projShort = proj.folder.split('/').filter(Boolean).pop();
      suggestions.push({
        id: `mcp-server-count-project:${proj.folder}`,
        severity: activeProj.length >= MCP_SERVER_COUNT_HIGH ? 'high' : 'medium',
        category: 'mcp',
        title: `${activeProj.length} MCP servers enabled in ${projShort}`,
        detail: `${proj.folder}/.cursor/mcp.json lists ${activeProj.length} active servers. Combined with global servers this stacks tool-definition overhead on every request. Disable or consolidate.`,
        scope: { type: 'project', folder: proj.folder, folders: [proj.folder] },
        impact: { requestsObserved: sessionsHere },
        fix: { action: 'trim-servers', hint: 'Disable unused project MCP servers; keep only what is actually invoked' },
      });
    }

    // S5: project-level MCP servers individually never invoked in this folder
    const markersHere = usage.messageMcpMentionsByFolder.get(proj.folder) || new Set();
    for (const server of proj.mcpServers) {
      if (server.disabled) continue;
      if (sessionsHere < DEAD_SERVER_MIN_SESSIONS) continue;
      const usedInTools = Array.from(toolsHere).some(t => toolMatchesServer(t, server.name));
      const usedInMarkers = Array.from(markersHere).some(m => toolMatchesServer(m, server.name));
      const usedInAgentBlob = agentBlobMentionsServer(usage, server.name);
      if (!usedInTools && !usedInMarkers && !usedInAgentBlob) {
        suggestions.push({
          id: `project-mcp-unused:${proj.folder}:${server.name}`,
          severity: 'medium',
          category: 'mcp',
          title: `Project MCP server "${server.name}" never invoked here`,
          detail: `Configured in ${proj.folder}/.cursor/mcp.json but not called once across ${sessionsHere} cursor sessions in this folder. Its tool schemas are still loaded into every request.`,
          scope: { type: 'project', folder: proj.folder },
          impact: { requestsObserved: sessionsHere },
          fix: { action: 'disable-project-mcp', path: server.configPath, hint: `Remove "${server.name}" from .cursor/mcp.json or set disabled: true` },
        });
      }
    }
  }

  // ---- Global checks: MCP servers ----
  const globalServers = config.global?.mcpServers || [];
  const totalCursorSessions = usage.cursorSessions;
  const allMcpTools = mcpTools(usage.cursorToolNames);

  // Too many MCP servers configured globally. Each server contributes tool
  // definitions to every request's system prompt. Past ~5 servers the overhead
  // is measurable (thousands of tokens/turn) and tool-selection quality
  // drops. Past ~10 you're likely hitting Cursor's ~40-tool ceiling.
  const activeGlobal = globalServers.filter(s => !s.disabled);
  if (activeGlobal.length >= MCP_SERVER_COUNT_WARN) {
    const severity = activeGlobal.length >= MCP_SERVER_COUNT_HIGH ? 'high' : 'medium';
    const serverList = activeGlobal.map(s => `  • ${s.name}`).join('\n');
    suggestions.push({
      id: 'mcp-server-count-global',
      severity,
      category: 'mcp',
      title: `${activeGlobal.length} MCP servers enabled globally — tool overhead per request`,
      detail: `~/.cursor/mcp.json lists ${activeGlobal.length} active servers:\n${serverList}\n\nEach server's tool definitions load into every request. Past ${MCP_SERVER_COUNT_WARN} servers overhead is measurable; past ${MCP_SERVER_COUNT_HIGH} you risk Cursor's ~40-tool ceiling (tools silently become unavailable). Move project-specific servers into .cursor/mcp.json so they only load where used, and disable ones you rarely invoke.`,
      scope: { type: 'global' },
      impact: { requestsObserved: totalCursorSessions },
      fix: { action: 'trim-servers', hint: `Move project-specific servers into per-project .cursor/mcp.json; disable unused servers` },
    });
  }

  // Retry loops — same MCP tool + same args called N+ times in one chat.
  // This is token waste without progress: agent hit an error or got stale
  // data and repeats itself. Per (server, tool) pair, report total repeats
  // across all chats.
  if (usage.retryLoops && usage.retryLoops.length) {
    const byTool = new Map();
    for (const r of usage.retryLoops) {
      const k = r.tool_name;
      if (!byTool.has(k)) byTool.set(k, { tool: k, loops: 0, repeats: 0, chats: new Set() });
      const e = byTool.get(k);
      e.loops += 1;
      e.repeats += r.n;
      e.chats.add(r.chat_id);
    }
    for (const e of byTool.values()) {
      suggestions.push({
        id: `mcp-retry-loop:${e.tool}`,
        severity: e.loops >= 3 ? 'medium' : 'low',
        category: 'mcp',
        title: `Retry loop on ${e.tool}: ${e.loops} loop${e.loops === 1 ? '' : 's'} across ${e.chats.size} chat${e.chats.size === 1 ? '' : 's'}`,
        detail: `This MCP tool was called ${e.repeats} times with identical args across ${e.loops} retry loop${e.loops === 1 ? '' : 's'} (same call repeated ${RETRY_LOOP_MIN_REPEATS}+ times in a single chat). Repeated identical calls usually mean the agent hit an error or stale response and kept retrying — burning input tokens per turn without progress. Check the tool's error responses and whether it returns structured failure info.`,
        scope: { type: 'global' },
        impact: { requestsObserved: e.repeats },
        fix: { action: 'inspect-tool', hint: 'Check if the MCP tool returns structured errors (agent can react) vs opaque failures (agent retries blindly)' },
      });
    }
  }

  for (const server of globalServers) {
    if (server.disabled) {
      suggestions.push({
        id: `disabled-mcp:${server.name}`,
        severity: 'low',
        category: 'mcp',
        title: `Disabled MCP server still in config: ${server.name}`,
        detail: `Server is marked disabled in ~/.cursor/mcp.json. Remove the entry to keep the config clean.`,
        scope: { type: 'global' },
        impact: {},
        fix: { action: 'remove-server', path: server.configPath, hint: `Delete "${server.name}" entry` },
      });
      continue;
    }

    if (totalCursorSessions < DEAD_SERVER_MIN_SESSIONS) continue;

    const usedInCursorTools   = Array.from(allMcpTools).some(t => toolMatchesServer(t, server.name));
    const usedInCursorMarkers = Array.from(usage.messageMcpMentions).some(m => toolMatchesServer(m, server.name));

    // Where else does the user invoke this server?
    const otherEditors = [];
    for (const [src, toolSet] of usage.otherEditorMcpTools.entries()) {
      const hit = Array.from(toolSet).some(t => toolMatchesServer(t, server.name));
      if (hit) otherEditors.push(src);
    }

    if (usedInCursorTools || usedInCursorMarkers) continue; // actively used in Cursor

    // Safety net: cursor-agent (CLI) redacts tool-call metadata. If the server
    // name appears as a word in cursor-agent assistant messages, assume the
    // user invoked it via the CLI and skip the unused flag.
    if (agentBlobMentionsServer(usage, server.name)) continue;

    if (otherEditors.length > 0) {
      // Used elsewhere — downgrade to low-severity advisory. Still costs tokens
      // per Cursor request even if the user only invokes it from another editor.
      suggestions.push({
        id: `global-mcp-cursor-unused:${server.name}`,
        severity: 'low',
        category: 'mcp',
        title: `MCP server "${server.name}" loaded by Cursor but only used in ${otherEditors.join(', ')}`,
        detail: `Configured in ~/.cursor/mcp.json, so its tool schemas load into every Cursor request (${totalCursorSessions} observed). But you only call it from ${otherEditors.join(', ')} — not from Cursor. Consider removing it from ~/.cursor/mcp.json since the other editor(s) have their own config.`,
        scope: { type: 'global' },
        impact: { requestsObserved: totalCursorSessions },
        fix: {
          action: 'scope-to-other-editor',
          path: server.configPath,
          hint: `Remove "${server.name}" from ~/.cursor/mcp.json — it's already configured in the editor you actually use it from`,
        },
      });
      continue;
    }

    // Truly unused anywhere
    suggestions.push({
      id: `global-mcp-unused:${server.name}`,
      severity: 'medium',
      category: 'mcp',
      title: `Global MCP server "${server.name}" never invoked`,
      detail: `Configured in ~/.cursor/mcp.json but not called once across ${totalCursorSessions} cursor sessions, and not used from any other tracked editor either. Its tool schemas are loaded into every request — disable it if unused.`,
      scope: { type: 'global' },
      impact: { requestsObserved: totalCursorSessions },
      fix: { action: 'disable-server', path: server.configPath, hint: `Remove "${server.name}" from ~/.cursor/mcp.json or set disabled: true` },
    });
  }

  // ---- Per-server MCP context cost rollup ----
  // For each enabled server: inspect cached tool schemas. Roll up unused and
  // rarely-used tools into ONE finding per server (instead of one per tool)
  // so the user sees "Atlassian: 30 uncalled tools = $X/turn" and can act
  // on disabledTools[] in one edit.
  const schemaCache = config.global?.mcpToolSchemas || new Map();
  const enabledServerNames = new Set((globalServers).filter(s => !s.disabled).map(s => s.name.toLowerCase()));
  for (const proj of config.projects || []) {
    for (const s of proj.mcpServers || []) if (!s.disabled) enabledServerNames.add(s.name.toLowerCase());
  }
  for (const [serverName, tools] of schemaCache) {
    if (!enabledServerNames.has(serverName)) continue;
    const toolArray = Array.from(tools.entries()); // [[toolName, {chars,tokens,description}], ...]
    const serverTokensTotal = toolArray.reduce((n, [, info]) => n + info.tokens, 0);
    if (serverTokensTotal === 0) continue;

    // Classify each tool: never-called, rarely-called, actively-used.
    const neverCalled = [];
    const rarelyCalled = []; // < 3 invocations
    let calledTokens = 0;
    for (const [toolName, info] of toolArray) {
      const invocations = Array.from(usage.mcpToolInvocationCount.entries())
        .filter(([tn]) => tn.toLowerCase().includes(toolName.toLowerCase()) && tn.toLowerCase().includes(serverName))
        .reduce((a, [, n]) => a + n, 0);
      if (invocations === 0) neverCalled.push({ name: toolName, tokens: info.tokens });
      else if (invocations < 3) rarelyCalled.push({ name: toolName, tokens: info.tokens, invocations });
      else calledTokens += info.tokens;
    }
    neverCalled.sort((a, b) => b.tokens - a.tokens);
    rarelyCalled.sort((a, b) => b.tokens - a.tokens);

    // One finding per server. Waste = uncalled + rarely-called tokens
    // (the actionable part). Actively-used tokens are genuine value, not waste.
    // Detail breaks down all three buckets so user sees the full picture.
    const uncalledTokens = neverCalled.reduce((n, t) => n + t.tokens, 0);
    const rareTokens = rarelyCalled.reduce((n, t) => n + t.tokens, 0);
    const wasteTokens = uncalledTokens + rareTokens;
    if (wasteTokens < HEAVY_TOOL_TOKENS) continue; // not worth surfacing
    const waste = wasteFor(usage, null, wasteTokens);
    const uncalledList = neverCalled.slice(0, 10).map(t => `  • ${t.name} (~${t.tokens} tok)`).join('\n');
    const uncalledMore = neverCalled.length > 10 ? `\n  … and ${neverCalled.length - 10} more` : '';
    const rareList = rarelyCalled.slice(0, 5).map(t => `  • ${t.name} (~${t.tokens} tok, used ${t.invocations}×)`).join('\n');
    const rareMore = rarelyCalled.length > 5 ? `\n  … and ${rarelyCalled.length - 5} more` : '';
    const sections = [
      `${toolArray.length} tools × avg ${Math.round(serverTokensTotal/toolArray.length)} tok = ~${serverTokensTotal} tok/turn total for this server.`,
    ];
    if (neverCalled.length) sections.push(`\nNever called (${neverCalled.length} tools, ~${uncalledTokens} tok/turn):\n${uncalledList}${uncalledMore}`);
    if (rarelyCalled.length) sections.push(`\nRarely used (${rarelyCalled.length} tools, <3× each, ~${rareTokens} tok/turn):\n${rareList}${rareMore}`);
    const activeCount = toolArray.length - neverCalled.length - rarelyCalled.length;
    if (activeCount) sections.push(`\nActively used: ${activeCount} tool${activeCount === 1 ? '' : 's'} (~${calledTokens} tok/turn) — genuine value.`);
    const wasteStr = wasteLine(waste);
    if (wasteStr) sections.push(`\n${wasteStr}`);
    const disabledArr = neverCalled.map(t => `"${t.name}"`).join(', ');
    const severity = uncalledTokens >= HEAVY_SERVER_TOKENS ? 'high' : uncalledTokens >= HEAVY_TOOL_TOKENS ? 'medium' : 'low';
    suggestions.push({
      id: `mcp-tools-weight:${serverName}`,
      severity,
      category: 'mcp',
      title: `${serverName}: ~${wasteTokens} tok/turn in uncalled/rare tools (of ${serverTokensTotal} total)`,
      detail: sections.join('\n') + (neverCalled.length ? `\n\nAdd never-called tools to \`disabledTools\` under "${serverName}" in ~/.cursor/mcp.json to reclaim the context without removing the server.` : ''),
      scope: { type: 'global' },
      impact: {
        tokensPerRequest: wasteTokens,
        requestsObserved: waste.turns,
        tokensWasted: waste.tokens,
        usdWasted: waste.usd,
        usdEstimated: waste.estimated,
      },
      fix: {
        action: 'disable-tools',
        serverName,
        disabledTools: neverCalled.map(t => t.name),
        hint: neverCalled.length
          ? `Set \`disabledTools: [${disabledArr}]\` on "${serverName}" in ~/.cursor/mcp.json`
          : `Review rarely-used tools under "${serverName}"`,
      },
    });
  }

  // ---- Global checks: CLI config model ----
  const cli = config.global?.cliConfig;
  if (cli && isPremiumModel(cli.modelId)) {
    suggestions.push({
      id: 'premium-cli-model',
      severity: 'low',
      category: 'model',
      title: `Cursor CLI default is a premium model: ${cli.displayName || cli.modelId}`,
      detail: `Premium/long-context models cost significantly more per token. If most of your tasks are routine edits, switch the default to a cheaper model and opt into the premium model only when needed.`,
      scope: { type: 'global' },
      impact: {},
      fix: { action: 'change-model', path: cli.path, hint: 'Update model.modelId in ~/.cursor/cli-config.json' },
    });
  }

  // ---- Rule bundles: one finding per host folder ----
  // Emits after per-project loop so ancestor rules stack into a single
  // bundle covering all inheriting subfolders. Damage = sum over affected
  // folders of (host tokens × turns × $/Mtok).
  for (const [host, entry] of rulesByHost) {
    if (!hostHasBloat.get(host)) continue;
    const rules = Array.from(entry.rulesByPath.values()).sort((a, b) => b.bodyTokens - a.bodyTokens);
    const alwaysOnTotal = rules.reduce((n, r) => n + r.bodyChars, 0);
    const bloatTokens = Math.ceil(alwaysOnTotal / 4);
    const affected = Array.from(entry.affected);
    const bundleWaste = wasteForFolders(usage, affected, bloatTokens);
    const bundleSig = rules.map(r => r.path).sort().join('|');
    const hostShort = host.split('/').filter(Boolean).pop() || host;
    const ruleList = rules
      .map(r => `  • ${r.path.startsWith(host + '/') ? r.path.slice(host.length + 1) : r.path} (~${r.bodyTokens} tok)`)
      .join('\n');
    const affectedBlock = affected.length > 1
      ? `\n\nApplies to ${affected.length} subfolders that inherit these rules:\n${affected.map(f => '  - ' + f).join('\n')}`
      : '';
    suggestions.push({
      id: `rules-bloat:${bundleSig}`,
      severity: 'high',
      category: 'rules',
      title: `${rules.length} always-on rules under ${hostShort} bloat every request`,
      detail: `${alwaysOnTotal} chars of always-on content across ${rules.length} files in ${host}/.cursor/rules/:\n${ruleList}${affectedBlock}\n\nConsolidate overlapping content or replace \`alwaysApply: true\` with \`globs:\` / \`description:\` so each rule only loads when relevant.`,
      scope: {
        type: affected.length > 1 ? 'multi' : 'project',
        folder: affected[0],
        folders: affected,
      },
      impact: {
        tokensPerRequest: bloatTokens,
        requestsObserved: bundleWaste.turns,
        tokensWasted: bundleWaste.tokens,
        usdWasted: bundleWaste.usd,
        usdEstimated: bundleWaste.estimated,
      },
      fix: { action: 'consolidate', hint: `Scope the ${rules.length} always-on rules so each loads only when needed` },
    });
  }

  // ---- Global checks: skills with no description (won't auto-trigger) ----
  // ---- Skills checks ----
  // Same rules apply to global and per-project skills. Skills load
  // progressively: only frontmatter is read at startup, full SKILL.md
  // only when the agent picks it. Description is the match-or-miss field.
  const allSkills = [
    ...(config.global?.skills || []).map(s => ({ ...s, _scope: 'global' })),
    ...((config.projects || []).flatMap(p => (p.skills || []).map(s => ({ ...s, _scope: 'project', _folder: p.folder })))),
  ];
  for (const skill of allSkills) {
    const checks = skillChecks(skill);
    for (const c of checks) {
      suggestions.push({
        id: `${c.id}:${skill.path}`,
        severity: c.severity,
        category: 'skills',
        title: c.title,
        detail: c.detail,
        scope: skill._scope === 'global'
          ? { type: 'global' }
          : { type: 'project', folder: skill._folder, folders: [skill._folder] },
        impact: {},
        fix: { action: c.action, path: skill.path, hint: c.hint },
      });
    }
  }

  // Dedupe: ancestor-level rules (and shared rule-bundles) appear in every
  // subfolder project that inherits them. Merge by id, summing waste and
  // collecting the list of affected folders into scope.folders.
  const byId = new Map();
  for (const s of suggestions) {
    const prev = byId.get(s.id);
    if (!prev) { byId.set(s.id, { ...s, scope: { ...s.scope, folders: [...(s.scope?.folders || [])] }, impact: { ...s.impact } }); continue; }
    const pImp = prev.impact;
    const cImp = s.impact || {};
    pImp.requestsObserved = (pImp.requestsObserved || 0) + (cImp.requestsObserved || 0);
    pImp.tokensWasted = (pImp.tokensWasted || 0) + (cImp.tokensWasted || 0);
    pImp.usdWasted = (pImp.usdWasted || 0) + (cImp.usdWasted || 0);
    if (cImp.usdEstimated) pImp.usdEstimated = true;
    // tokensPerRequest is per-turn cost; it's identical across duplicates.
    for (const f of s.scope?.folders || []) {
      if (!prev.scope.folders.includes(f)) prev.scope.folders.push(f);
    }
  }
  const deduped = Array.from(byId.values());

  // Annotate scope: if finding reaches multiple folders, mark scope.type
  // as 'multi' so the UI can render "Affects N projects" instead of one.
  for (const s of deduped) {
    const fs = s.scope?.folders || [];
    if (fs.length > 1) {
      s.scope = { ...s.scope, type: 'multi', folders: fs };
    }
  }

  // Sort: highest observed waste first. Fall back to severity, then id.
  const order = { high: 0, medium: 1, low: 2 };
  deduped.sort((a, b) => {
    const du = (b.impact?.usdWasted || 0) - (a.impact?.usdWasted || 0);
    if (du) return du;
    const dt = (b.impact?.tokensWasted || 0) - (a.impact?.tokensWasted || 0);
    if (dt) return dt;
    const ds = order[a.severity] - order[b.severity];
    if (ds) return ds;
    return a.id.localeCompare(b.id);
  });

  return deduped;
}

module.exports = { analyze, analyzeUsage, toolMatchesServer };
