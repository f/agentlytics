/**
 * Claude Code cost/hygiene suggestion analyzer.
 *
 * Mirrors the Cursor analyzer surface: takes a config snapshot from
 * editors/claude.getConfig() plus a usage snapshot from analyzeUsage() and
 * returns actionable findings. Unlike Cursor, Claude Code records per-message
 * model metadata, so $/Mtok waste numbers are NOT estimates — we derive real
 * blended prices from observed input tokens.
 */

const { getModelPricing } = require('../pricing');

const SOURCE = 'claude-code';

const CLAUDE_MD_WARN_LINES = 200;      // per Claude Code docs: target <200 lines
const CLAUDE_MD_HIGH_LINES = 500;
const RULES_BLOAT_CHARS = 4000;        // ~1000 tok of unconditional rules across a project
const HEAVY_RULE_CHARS = 1000;         // one heavy unconditional rule alone
const SKILL_DESC_BUDGET_CHARS = 8000;  // approx listing budget per Skills docs
const SKILL_DESC_MIN_CHARS = 30;
const SKILL_BODY_LINE_LIMIT = 500;
const SUBAGENT_DESC_MAX_CHARS = 500;   // descriptions sit in parent context at startup
const RETRY_LOOP_MIN_REPEATS = 3;
const DEAD_SERVER_MIN_SESSIONS = 5;
const MCP_SERVER_COUNT_WARN = 5;
const MCP_SERVER_COUNT_HIGH = 10;
const PREMIUM_MODELS = [/opus/i];      // opus as default = 2-3× sonnet cost
const HIGH_EFFORT_VALUES = new Set(['xhigh', 'max']);

// Claude Code MCP tool call name: `mcp__<server>__<tool>`.
const MCP_PREFIX = 'mcp__';
function isMcpTool(t) { return typeof t === 'string' && t.startsWith(MCP_PREFIX); }
function mcpServerOfTool(t) {
  if (!isMcpTool(t)) return null;
  // Some plugin tools come as `mcp__plugin_<plugin>_<server>__<tool>` — take
  // the last server segment before the double-underscore / tool boundary.
  const rest = t.slice(MCP_PREFIX.length);
  const idx = rest.indexOf('__');
  if (idx === -1) return null;
  return rest.slice(0, idx).toLowerCase();
}
function toolMatchesServer(t, serverName) {
  const s = mcpServerOfTool(t);
  if (!s || !serverName) return false;
  const sn = serverName.toLowerCase();
  return s === sn || s.endsWith(`_${sn}`) || s.includes(`_${sn}_`);
}

function analyzeUsage(db) {
  const out = {
    sessions: 0,
    sessionsByFolder: new Map(),
    toolNamesByFolder: new Map(),
    toolNames: new Set(),
    assistantTurnsByFolder: new Map(),
    assistantTurnsTotal: 0,
    avgInputPriceByFolder: new Map(),
    avgInputPriceGlobal: 0,
    realInputTokensByFolder: new Map(),
    realInputTokensTotal: 0,
    mcpToolInvocationCount: new Map(),
    retryLoops: [],
    pricingIsEstimated: false, // Claude Code records model per-message → real $
  };
  if (!db) return out;
  try {
    const totalRow = db.prepare('SELECT COUNT(*) as n FROM chats WHERE source = ?').get(SOURCE);
    out.sessions = totalRow?.n || 0;

    const folderRows = db.prepare(`
      SELECT folder, COUNT(*) as n FROM chats
      WHERE source = ? AND folder IS NOT NULL
      GROUP BY folder
    `).all(SOURCE);
    for (const r of folderRows) out.sessionsByFolder.set(r.folder, r.n);

    const toolRows = db.prepare(`
      SELECT tool_name, folder FROM tool_calls WHERE source = ?
    `).all(SOURCE);
    for (const r of toolRows) {
      if (r.tool_name) out.toolNames.add(r.tool_name);
      if (r.folder) {
        if (!out.toolNamesByFolder.has(r.folder)) out.toolNamesByFolder.set(r.folder, new Set());
        out.toolNamesByFolder.get(r.folder).add(r.tool_name);
      }
    }

    // Real per-folder input tokens observed.
    const inputRows = db.prepare(`
      SELECT c.folder, SUM(cs.total_input_tokens) as in_tok
      FROM chats c JOIN chat_stats cs ON cs.chat_id = c.id
      WHERE c.source = ? AND c.folder IS NOT NULL
      GROUP BY c.folder
    `).all(SOURCE);
    for (const r of inputRows) {
      out.realInputTokensByFolder.set(r.folder, r.in_tok || 0);
      out.realInputTokensTotal += r.in_tok || 0;
    }

    // Per-folder weighted $/Mtok for input, from real per-message models.
    const modelRows = db.prepare(`
      SELECT c.folder, m.model, COUNT(*) as n, SUM(COALESCE(m.input_tokens, 0)) as in_tok
      FROM messages m JOIN chats c ON m.chat_id = c.id
      WHERE c.source = ? AND c.folder IS NOT NULL AND m.role = 'user'
      GROUP BY c.folder, m.model
    `).all(SOURCE);
    const FALLBACK = 3; // only used if a folder has zero priced user messages
    const folderAcc = new Map();
    let gN = 0, gPriced = 0;
    for (const r of modelRows) {
      const pr = r.model ? getModelPricing(r.model) : null;
      const price = pr?.input ?? FALLBACK;
      let acc = folderAcc.get(r.folder);
      if (!acc) { acc = { n: 0, priced: 0 }; folderAcc.set(r.folder, acc); }
      acc.n += r.n;
      acc.priced += r.n * price;
      gN += r.n;
      gPriced += r.n * price;
    }
    for (const [folder, acc] of folderAcc) {
      out.assistantTurnsByFolder.set(folder, acc.n); // user prompts
      out.avgInputPriceByFolder.set(folder, acc.n ? acc.priced / acc.n : FALLBACK);
    }
    // Add tool roundtrips to turn count.
    const toolInfer = db.prepare(`
      SELECT folder, COUNT(*) as n FROM tool_calls
      WHERE source = ? AND folder IS NOT NULL
      GROUP BY folder
    `).all(SOURCE);
    let toolTotal = 0;
    for (const r of toolInfer) {
      out.assistantTurnsByFolder.set(
        r.folder,
        (out.assistantTurnsByFolder.get(r.folder) || 0) + r.n
      );
      toolTotal += r.n;
    }
    out.assistantTurnsTotal = gN + toolTotal;
    out.avgInputPriceGlobal = gN ? gPriced / gN : FALLBACK;

    // Per-tool MCP invocation counts across all claude-code chats.
    const callRows = db.prepare(`
      SELECT tool_name, COUNT(*) as n FROM tool_calls
      WHERE source = ? AND tool_name LIKE 'mcp__%'
      GROUP BY tool_name
    `).all(SOURCE);
    for (const r of callRows) out.mcpToolInvocationCount.set(r.tool_name, r.n);

    // Retry loops — same tool + same args ≥ N times in one chat.
    const loopRows = db.prepare(`
      SELECT c.folder, t.tool_name, t.args_json, t.chat_id, COUNT(*) as n
      FROM tool_calls t JOIN chats c ON t.chat_id = c.id
      WHERE c.source = ? AND t.tool_name LIKE 'mcp__%'
      GROUP BY t.chat_id, t.tool_name, t.args_json
      HAVING n >= ?
    `).all(SOURCE, RETRY_LOOP_MIN_REPEATS);
    for (const r of loopRows) out.retryLoops.push(r);
  } catch { /* zero snapshot */ }
  out.pricing = {
    estimated: false,
    note: null,
    realInputTokensObserved: out.realInputTokensTotal || 0,
    realInputCostAtFallback: 0,
  };
  return out;
}

function wasteFor(usage, folder, tokensPerTurn) {
  if (!tokensPerTurn) return { turns: 0, tokens: 0, usd: 0, estimated: false };
  const turns = folder
    ? (usage.assistantTurnsByFolder.get(folder) || 0)
    : usage.assistantTurnsTotal;
  const price = folder
    ? (usage.avgInputPriceByFolder.get(folder) || usage.avgInputPriceGlobal)
    : usage.avgInputPriceGlobal;
  const tokens = tokensPerTurn * turns;
  const usd = (tokens / 1_000_000) * price;
  return { turns, tokens, usd, estimated: !!usage.pricingIsEstimated };
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

function fmtTokens(n) {
  if (!n) return '0';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}
function fmtUsd(n) {
  if (!n || !isFinite(n)) return '$0';
  if (n < 0.01) return '<$0.01';
  return `$${n.toFixed(2)}`;
}
function wasteLine(d) {
  if (!d.tokens) return '';
  return `Est. waste so far: ${fmtTokens(d.tokens)} tokens over ${d.turns} turns ≈ ${fmtUsd(d.usd)}.`;
}

function isPremiumModel(m) {
  if (!m) return false;
  return PREMIUM_MODELS.some(rx => rx.test(m));
}

// Hooks that fire per turn or per tool call — their injected output
// inflates every request. SessionStart is once/session (lower severity).
const PER_TURN_HOOKS = new Set(['UserPromptSubmit']);
const PER_TOOL_HOOKS = new Set(['PreToolUse', 'PostToolUse']);
function hookRisk(eventName) {
  if (PER_TURN_HOOKS.has(eventName)) return 'high';
  if (PER_TOOL_HOOKS.has(eventName)) return 'high';
  if (eventName === 'SessionStart') return 'low';
  return null;
}

function analyzeHookBlock(hooksObj, sourceFolder, origin) {
  const findings = [];
  if (!hooksObj || typeof hooksObj !== 'object') return findings;
  for (const [event, entries] of Object.entries(hooksObj)) {
    const risk = hookRisk(event);
    if (!risk) continue;
    const arr = Array.isArray(entries) ? entries : [];
    for (const group of arr) {
      const inner = Array.isArray(group?.hooks) ? group.hooks : [];
      for (const h of inner) {
        if (!h || !h.type) continue;
        findings.push({
          event,
          risk,
          type: h.type,
          command: h.command || h.url || null,
          sourceFolder,
          origin: origin || null,   // e.g. 'plugin:caveman@caveman'
        });
      }
    }
  }
  return findings;
}

function skillChecks(skill) {
  const out = [];
  if (skill.skillName && skill.skillName !== skill.name) {
    out.push({
      id: 'skill-name-mismatch',
      severity: 'high',
      title: `Skill "${skill.name}" has mismatched name in frontmatter`,
      detail: `Folder is \`${skill.name}\` but SKILL.md declares \`name: ${skill.skillName}\`. Claude Code requires these to match — otherwise the skill is invisible to discovery.`,
      action: 'fix-name',
      hint: `Set frontmatter name to "${skill.name}" or rename the folder`,
    });
  }
  if (!skill.description) {
    out.push({
      id: 'skill-no-description',
      severity: 'medium',
      title: `Skill "${skill.name}" has no description`,
      detail: `Claude Code uses the description to decide when a skill applies and what to show in the listing. Without one the skill rarely auto-triggers and takes the first body paragraph into the listing — wasting description-budget.`,
      action: 'add-description',
      hint: 'Add a description: what the skill does + when to use it',
    });
  } else if (skill.description.length < SKILL_DESC_MIN_CHARS) {
    out.push({
      id: 'skill-weak-description',
      severity: 'low',
      title: `Skill "${skill.name}" has a weak description (${skill.description.length} chars)`,
      detail: `Too short for the agent to distinguish this skill from others. The description budget (~8K chars across all skills) is wasted when a skill occupies a slot but can't be matched.`,
      action: 'improve-description',
      hint: 'Expand to include what, when, and natural trigger phrases',
    });
  }
  if (skill.bodyLines > SKILL_BODY_LINE_LIMIT) {
    out.push({
      id: 'skill-too-long',
      severity: 'medium',
      title: `Skill "${skill.name}" SKILL.md is ${skill.bodyLines} lines (~${skill.bodyTokens} tokens)`,
      detail: `Claude Code loads the full SKILL.md body when the skill is invoked; auto-compaction keeps the first 5,000 tokens in context for the rest of the session. Over ${SKILL_BODY_LINE_LIMIT} lines starts evicting conversation context. Move long-form content into references/ or supporting scripts.`,
      action: 'split-skill',
      hint: 'Move long-form content into references/ subdirectory',
    });
  }
  if (skill.shellBlocks > 0) {
    out.push({
      id: 'skill-shell-blocks',
      severity: 'low',
      title: `Skill "${skill.name}" runs ${skill.shellBlocks} inline shell block(s) on invocation`,
      detail: `Inline \`!\`<cmd>\`\` blocks run every time the skill is invoked and the output is injected into context. Make sure the commands are cheap and their output is bounded.`,
      action: 'review-shell',
      hint: 'Keep !`<cmd>` output short, or move into a script the skill can call explicitly',
    });
  }
  return out;
}

function subagentChecks(agent) {
  const out = [];
  if (!agent.description) {
    out.push({
      id: 'subagent-no-description',
      severity: 'medium',
      title: `Subagent "${agent.name}" has no description`,
      detail: `Claude Code loads subagent descriptions into the parent session's context at startup so it knows when to delegate. Without one, the parent never delegates to this subagent — the definition just sits in context unused.`,
      action: 'add-description',
      hint: 'Add a description: when to delegate to this subagent',
    });
  } else if (agent.description.length > SUBAGENT_DESC_MAX_CHARS) {
    out.push({
      id: 'subagent-verbose-description',
      severity: 'low',
      title: `Subagent "${agent.name}" description is ${agent.description.length} chars`,
      detail: `All subagent descriptions concatenate into the parent's startup context. A ${agent.description.length}-char description is longer than needed for routing. Trim it.`,
      action: 'trim-description',
      hint: 'Keep to ~250 chars: one sentence on what + one on when',
    });
  }
  if (agent.bodyLines > 800) {
    out.push({
      id: 'subagent-huge-body',
      severity: 'low',
      title: `Subagent "${agent.name}" body is ${agent.bodyLines} lines (~${agent.bodyTokens} tokens)`,
      detail: `The subagent system prompt is injected into the subagent's context when spawned. A very large body inflates every subagent turn. Keep system prompts lean; move reference material into skills the subagent can load on demand.`,
      action: 'trim-subagent',
      hint: 'Move reference material out; keep the system prompt focused on behavior',
    });
  }
  if (agent.tools === '*' || (Array.isArray(agent.tools) && agent.tools.includes('*'))) {
    out.push({
      id: 'subagent-unrestricted-tools',
      severity: 'low',
      title: `Subagent "${agent.name}" grants all tools`,
      detail: `Defines no tool restriction. If the subagent is meant for a narrow task (e.g. read-only research), restrict its tool set so it can't invoke expensive or destructive tools.`,
      action: 'restrict-tools',
      hint: 'Set `tools: Read, Grep, Glob` (or similar) in frontmatter',
    });
  }
  return out;
}

function analyze(config, usage) {
  const suggestions = [];

  // ---- 1. CLAUDE.md bloat (project + user) ----
  // We emit per-CLAUDE.md findings. Because a CLAUDE.md at /foo applies to
  // every subfolder that inherits it, dedupe by md.path and accumulate all
  // affected folders.
  const claudeMdsByPath = new Map(); // path → { md, affected: Set<folder> }
  for (const proj of config.projects || []) {
    for (const md of proj.claudeMds || []) {
      if (!claudeMdsByPath.has(md.path)) claudeMdsByPath.set(md.path, { md, affected: new Set() });
      claudeMdsByPath.get(md.path).affected.add(proj.folder);
    }
  }
  if (config.global?.claudeMd) {
    claudeMdsByPath.set(
      config.global.claudeMd.path,
      { md: { ...config.global.claudeMd, sourceFolder: null, kind: 'user' }, affected: new Set() }
    );
  }
  // Plugin-shipped CLAUDE.md files are injected session-wide when the plugin
  // is enabled. They pay every turn just like user CLAUDE.md.
  for (const plug of config.global?.plugins || []) {
    if (!plug.claudeMd) continue;
    claudeMdsByPath.set(
      plug.claudeMd.path,
      { md: { ...plug.claudeMd, sourceFolder: null, kind: 'plugin', pluginKey: plug.key }, affected: new Set() }
    );
  }
  for (const [mdPath, entry] of claudeMdsByPath) {
    const { md, affected } = entry;
    const lines = md.bodyLines;
    if (lines < CLAUDE_MD_WARN_LINES) continue;
    const affectedArr = Array.from(affected);
    const waste = (md.kind === 'user' || md.kind === 'plugin')
      ? wasteFor(usage, null, md.bodyTokens)
      : wasteForFolders(usage, affectedArr, md.bodyTokens);
    const severity = lines >= CLAUDE_MD_HIGH_LINES ? 'high' : 'medium';
    const short = md.sourceFolder
      ? md.sourceFolder.split('/').filter(Boolean).pop()
      : (md.kind === 'plugin' ? `plugin:${md.pluginKey}` : '~/.claude');
    const importsNote = md.imports?.length ? ` Imports ${md.imports.length} file(s) via \`@path\`.` : '';
    const affectedBlock = affectedArr.length > 1
      ? `\n\nApplies to ${affectedArr.length} subfolders that inherit it:\n${affectedArr.map(f => '  - ' + f).join('\n')}`
      : '';
    suggestions.push({
      id: `claude-md-bloat:${mdPath}`,
      severity,
      category: 'rules',
      title: `CLAUDE.md in ${short} is ${lines} lines — loaded every request`,
      detail: `${mdPath}\n~${md.bodyTokens} tokens injected at session start and kept for every turn.${importsNote} Docs recommend <${CLAUDE_MD_WARN_LINES} lines per CLAUDE.md; over ${CLAUDE_MD_HIGH_LINES} measurably hurts adherence.${affectedBlock}\n\n${wasteLine(waste)}\n\nMove long-form procedures into .claude/skills/<name>/SKILL.md (progressively loaded), or split reference content into .claude/rules/*.md with \`paths:\` frontmatter so it only loads when matching files open.`,
      scope: md.kind === 'user'
        ? { type: 'global' }
        : { type: affectedArr.length > 1 ? 'multi' : 'project', folder: affectedArr[0], folders: affectedArr },
      impact: {
        tokensPerRequest: md.bodyTokens,
        requestsObserved: waste.turns,
        tokensWasted: waste.tokens,
        usdWasted: waste.usd,
        usdEstimated: waste.estimated,
      },
      fix: { action: 'split-claude-md', path: mdPath, hint: 'Split into .claude/skills/ or .claude/rules/ with `paths:` for conditional loading' },
    });
  }

  // ---- 2. Unconditional rules bloat in .claude/rules/ ----
  // Rules without `paths` are loaded unconditionally like CLAUDE.md.
  const rulesByHost = new Map(); // sourceFolder → { rules, affected }
  for (const proj of config.projects || []) {
    for (const r of proj.rules || []) {
      if (r.paths) continue; // scoped — loads only on matching file open
      const host = r.sourceFolder || proj.folder;
      if (!rulesByHost.has(host)) rulesByHost.set(host, { rules: new Map(), affected: new Set() });
      rulesByHost.get(host).rules.set(r.path, r);
      rulesByHost.get(host).affected.add(proj.folder);
    }
  }
  for (const [host, entry] of rulesByHost) {
    const rules = Array.from(entry.rules.values()).sort((a, b) => b.bodyTokens - a.bodyTokens);
    const totalChars = rules.reduce((n, r) => n + r.bodyChars, 0);
    if (totalChars < RULES_BLOAT_CHARS) continue;
    const affected = Array.from(entry.affected);
    const bloatTokens = Math.ceil(totalChars / 4);
    const waste = wasteForFolders(usage, affected, bloatTokens);
    const shortHost = host.split('/').filter(Boolean).pop() || host;
    const ruleList = rules.map(r => `  • ${r.path.startsWith(host + '/') ? r.path.slice(host.length + 1) : r.path} (~${r.bodyTokens} tok)`).join('\n');
    const affectedBlock = affected.length > 1
      ? `\n\nApplies to ${affected.length} subfolders that inherit these rules:\n${affected.map(f => '  - ' + f).join('\n')}`
      : '';
    suggestions.push({
      id: `rules-bloat:${rules.map(r => r.path).sort().join('|')}`,
      severity: 'high',
      category: 'rules',
      title: `${rules.length} unconditional rules under ${shortHost} bloat every request`,
      detail: `${totalChars} chars of always-on rules across ${rules.length} files in ${host}/.claude/rules/:\n${ruleList}${affectedBlock}\n\nAdd a \`paths:\` frontmatter field (e.g. \`paths: ["src/**/*.ts"]\`) so each rule loads only when Claude reads matching files. Unconditional rules behave like CLAUDE.md — they are in context for every turn.\n\n${wasteLine(waste)}`,
      scope: {
        type: affected.length > 1 ? 'multi' : 'project',
        folder: affected[0],
        folders: affected,
      },
      impact: {
        tokensPerRequest: bloatTokens,
        requestsObserved: waste.turns,
        tokensWasted: waste.tokens,
        usdWasted: waste.usd,
        usdEstimated: waste.estimated,
      },
      fix: { action: 'scope-rules', hint: 'Add `paths: [...]` frontmatter to each rule so it loads conditionally' },
    });
  }

  // Individual heavy unconditional rules (when bundle didn't fire)
  const hostFired = new Set([...rulesByHost.keys()].filter(h => {
    const entry = rulesByHost.get(h);
    return Array.from(entry.rules.values()).reduce((n, r) => n + r.bodyChars, 0) >= RULES_BLOAT_CHARS;
  }));
  for (const proj of config.projects || []) {
    for (const rule of proj.rules || []) {
      if (rule.paths) continue;
      if (rule.bodyChars < HEAVY_RULE_CHARS) continue;
      const host = rule.sourceFolder || proj.folder;
      if (hostFired.has(host)) continue; // covered by bundle
      const waste = wasteFor(usage, proj.folder, rule.bodyTokens);
      const rel = rule.path.startsWith(host + '/') ? rule.path.slice(host.length + 1) : rule.path;
      suggestions.push({
        id: `rule-heavy:${rule.path}`,
        severity: rule.bodyChars > HEAVY_RULE_CHARS * 2 ? 'high' : 'medium',
        category: 'rules',
        title: `Heavy unconditional rule: ${rel}`,
        detail: `${rule.bodyChars} chars (~${rule.bodyTokens} tokens) and no \`paths:\` frontmatter — loaded every request.\n\n${wasteLine(waste)}\n\nAdd \`paths: [...]\` so it only loads when Claude opens matching files.`,
        scope: { type: 'project', folder: proj.folder, folders: [proj.folder] },
        impact: {
          tokensPerRequest: rule.bodyTokens,
          requestsObserved: waste.turns,
          tokensWasted: waste.tokens,
          usdWasted: waste.usd,
          usdEstimated: waste.estimated,
        },
        fix: { action: 'scope-rule', path: rule.path, hint: 'Add `paths: [glob, ...]` frontmatter' },
      });
    }
  }

  // Plugin unconditional rules — applied session-wide whenever the plugin is
  // enabled. Use global-scope waste (every turn across all folders pays).
  for (const plug of config.global?.plugins || []) {
    const pRules = (plug.rules || []).filter(r => !r.paths);
    if (!pRules.length) continue;
    const totalChars = pRules.reduce((n, r) => n + r.bodyChars, 0);
    const bloatTokens = Math.ceil(totalChars / 4);
    if (totalChars >= RULES_BLOAT_CHARS) {
      const waste = wasteFor(usage, null, bloatTokens);
      const ruleList = pRules.map(r => `  • ${r.path.split('/').slice(-2).join('/')} (~${r.bodyTokens} tok)`).join('\n');
      suggestions.push({
        id: `plugin-rules-bloat:${plug.key}`,
        severity: 'high',
        category: 'rules',
        title: `${pRules.length} unconditional rules from plugin ${plug.key} bloat every request`,
        detail: `${totalChars} chars loaded session-wide whenever plugin \`${plug.key}\` is enabled:\n${ruleList}\n\nDisable the plugin in ~/.claude/settings.json → enabledPlugins, or ask the author to scope rules with \`paths:\` frontmatter.\n\n${wasteLine(waste)}`,
        scope: { type: 'global' },
        impact: {
          tokensPerRequest: bloatTokens,
          requestsObserved: waste.turns,
          tokensWasted: waste.tokens,
          usdWasted: waste.usd,
          usdEstimated: waste.estimated,
        },
        fix: { action: 'disable-plugin-rules', hint: `Disable plugin ${plug.key} or request scoped \`paths:\`` },
      });
    } else {
      for (const rule of pRules) {
        if (rule.bodyChars < HEAVY_RULE_CHARS) continue;
        const waste = wasteFor(usage, null, rule.bodyTokens);
        const leaf = rule.path.split('/').pop();
        suggestions.push({
          id: `plugin-rule-heavy:${rule.path}`,
          severity: rule.bodyChars > HEAVY_RULE_CHARS * 2 ? 'high' : 'medium',
          category: 'rules',
          title: `Heavy plugin rule: ${plug.key}/${leaf}`,
          detail: `${rule.bodyChars} chars (~${rule.bodyTokens} tokens) shipped by plugin \`${plug.key}\` with no \`paths:\` — loaded every request.\n\n${wasteLine(waste)}\n\nDisable the plugin or ask the author to add \`paths:\`.`,
          scope: { type: 'global' },
          impact: {
            tokensPerRequest: rule.bodyTokens,
            requestsObserved: waste.turns,
            tokensWasted: waste.tokens,
            usdWasted: waste.usd,
            usdEstimated: waste.estimated,
          },
          fix: { action: 'disable-plugin', path: rule.path, hint: `Disable plugin ${plug.key} or ask author to scope with \`paths:\`` },
        });
      }
    }
  }

  // ---- 3. Skills — listing-budget & per-skill checks ----
  const allSkills = [
    ...(config.global?.skills || []).map(s => ({ ...s, _scope: 'global' })),
    ...((config.projects || []).flatMap(p => (p.skills || []).map(s => ({ ...s, _scope: 'project', _folder: p.folder })))),
    ...((config.global?.plugins || []).flatMap(p => (p.skills || []).map(s => ({ ...s, _scope: 'plugin', _pluginKey: p.key })))),
  ];
  // Dedupe skills by path (ancestor skills repeat across subfolder projects).
  const skillsByPath = new Map();
  for (const s of allSkills) if (!skillsByPath.has(s.path)) skillsByPath.set(s.path, s);
  const uniqueSkills = Array.from(skillsByPath.values());

  // Listing-budget check: all skill descriptions concatenate into one budget.
  let descTotal = 0;
  for (const s of uniqueSkills) descTotal += (s.description || '').length;
  if (descTotal > SKILL_DESC_BUDGET_CHARS) {
    suggestions.push({
      id: 'skill-listing-budget',
      severity: 'high',
      category: 'skills',
      title: `Skill descriptions total ${descTotal} chars — over the ~${SKILL_DESC_BUDGET_CHARS} listing budget`,
      detail: `Claude Code concatenates every skill description into a listing (budget ~${SKILL_DESC_BUDGET_CHARS} chars) so the agent can match user intent. Over budget, descriptions get truncated and skills stop triggering reliably. You have ${uniqueSkills.length} skills totalling ${descTotal} chars.\n\nTrim long descriptions, delete unused skills, or move rarely-needed skills out of the default discovery path.`,
      scope: { type: 'global' },
      impact: {},
      fix: { action: 'trim-skills', hint: 'Delete unused skills, tighten descriptions to <200 chars each' },
    });
  }
  for (const s of uniqueSkills) {
    for (const c of skillChecks(s)) {
      suggestions.push({
        id: `${c.id}:${s.path}`,
        severity: c.severity,
        category: 'skills',
        title: c.title,
        detail: c.detail,
        scope: s._scope === 'project'
          ? { type: 'project', folder: s._folder, folders: [s._folder] }
          : { type: 'global' },
        impact: {},
        fix: { action: c.action, path: s.path, hint: s._scope === 'plugin' ? `${c.hint} (shipped by plugin ${s._pluginKey})` : c.hint },
      });
    }
  }

  // ---- 4. Subagents ----
  const allAgents = [
    ...(config.global?.agents || []).map(a => ({ ...a, _scope: 'global' })),
    ...((config.projects || []).flatMap(p => (p.agents || []).map(a => ({ ...a, _scope: 'project', _folder: p.folder })))),
    ...((config.global?.plugins || []).flatMap(p => (p.agents || []).map(a => ({ ...a, _scope: 'plugin', _pluginKey: p.key })))),
  ];
  const agentsByPath = new Map();
  for (const a of allAgents) if (!agentsByPath.has(a.path)) agentsByPath.set(a.path, a);
  for (const a of agentsByPath.values()) {
    for (const c of subagentChecks(a)) {
      suggestions.push({
        id: `${c.id}:${a.path}`,
        severity: c.severity,
        category: 'agents',
        title: c.title,
        detail: c.detail,
        scope: a._scope === 'project'
          ? { type: 'project', folder: a._folder, folders: [a._folder] }
          : { type: 'global' },
        impact: {},
        fix: { action: c.action, path: a.path, hint: a._scope === 'plugin' ? `${c.hint} (shipped by plugin ${a._pluginKey})` : c.hint },
      });
    }
  }

  // ---- 5. Hooks that inflate per-turn/per-tool context ----
  const hookFindings = [];
  if (config.global?.settings?.hooks) {
    hookFindings.push(...analyzeHookBlock(config.global.settings.hooks, null));
  }
  for (const proj of config.projects || []) {
    for (const s of proj.settings || []) {
      if (!s.hooks) continue;
      hookFindings.push(...analyzeHookBlock(s.hooks, proj.folder));
    }
  }
  for (const plug of config.global?.plugins || []) {
    if (!plug.hooks) continue;
    hookFindings.push(...analyzeHookBlock(plug.hooks, null, `plugin:${plug.key}`));
  }
  // Group by (event, type, command, origin) so plugin-origin hooks stay distinct.
  const hookBySig = new Map();
  for (const h of hookFindings) {
    const sig = `${h.event}::${h.type}::${h.command || ''}::${h.origin || ''}`;
    if (!hookBySig.has(sig)) hookBySig.set(sig, { ...h, folders: new Set() });
    if (h.sourceFolder) hookBySig.get(sig).folders.add(h.sourceFolder);
  }
  for (const [sig, h] of hookBySig) {
    const scopeFolders = Array.from(h.folders);
    const originTag = h.origin ? ` (${h.origin})` : '';
    const title = h.event === 'UserPromptSubmit'
      ? `UserPromptSubmit hook fires every turn${originTag}: ${h.command || h.type}`
      : h.event === 'PreToolUse' || h.event === 'PostToolUse'
        ? `${h.event} hook fires per tool call${originTag}: ${h.command || h.type}`
        : `${h.event} hook${originTag}: ${h.command || h.type}`;
    suggestions.push({
      id: `hook:${sig}`,
      severity: h.risk,
      category: 'hooks',
      title,
      detail: [
        h.origin ? `Shipped by ${h.origin} — active whenever the plugin is enabled.` : null,
        `${h.event} hooks inject their output into context every time they fire.`,
        h.event === 'UserPromptSubmit' ? 'This one fires on every user turn.' : null,
        (h.event === 'PreToolUse' || h.event === 'PostToolUse') ? 'This one fires on every tool call — many times per turn.' : null,
        h.event === 'SessionStart' ? 'Runs once per session; output persists for the whole session.' : null,
        h.command ? `Command/URL: \`${h.command}\`` : `Type: ${h.type}`,
        '',
        'If the command output is small and necessary, this is fine. If it prints logs, diffs, git status, or large files — every turn pays for it. Bound the output (e.g. `head -n 5`), make it conditional, or move the logic into a skill that loads only when needed.',
      ].filter(Boolean).join('\n'),
      scope: scopeFolders.length
        ? { type: scopeFolders.length > 1 ? 'multi' : 'project', folder: scopeFolders[0], folders: scopeFolders }
        : { type: 'global' },
      impact: {},
      fix: { action: 'review-hook', hint: 'Bound hook output, make it conditional, or remove if not needed' },
    });
  }

  // ---- 6. Settings: default model + effort + statusLine ----
  const userSettings = config.global?.settings;
  if (userSettings) {
    if (isPremiumModel(userSettings.model)) {
      suggestions.push({
        id: 'default-model-opus',
        severity: 'medium',
        category: 'model',
        title: `Default model is premium: ${userSettings.model}`,
        detail: `~/.claude/settings.json sets \`model: ${userSettings.model}\`. Opus costs ~2-3× Sonnet per token. If most work is routine, switch the default to Sonnet and opt into Opus only for harder tasks (via \`/model\` or \`--model\`).`,
        scope: { type: 'global' },
        impact: {},
        fix: { action: 'change-model', path: userSettings.path, hint: 'Set `model: sonnet` (or remove the field to use Sonnet by default)' },
      });
    }
    if (HIGH_EFFORT_VALUES.has((userSettings.effortLevel || '').toLowerCase())) {
      suggestions.push({
        id: 'high-effort-default',
        severity: 'low',
        category: 'model',
        title: `Default effort level is \`${userSettings.effortLevel}\``,
        detail: `~/.claude/settings.json sets \`effortLevel: ${userSettings.effortLevel}\`. This uses the full thinking budget on every turn. Drop to \`medium\` (or remove the field) unless you need extended reasoning by default.`,
        scope: { type: 'global' },
        impact: {},
        fix: { action: 'lower-effort', path: userSettings.path, hint: 'Set `effortLevel: medium` or remove the field' },
      });
    }
    if (userSettings.statusLine && userSettings.statusLine.type === 'command' && userSettings.statusLine.command) {
      suggestions.push({
        id: 'statusline-command',
        severity: 'low',
        category: 'model',
        title: 'statusLine runs a command on every session startup',
        detail: `\`statusLine.command\` = \`${userSettings.statusLine.command}\`\n\nThis runs at every session start. If it's slow, it delays startup. If its output is large, it gets persisted in the UI for the session. Keep the command fast (<50ms) and its output short.`,
        scope: { type: 'global' },
        impact: {},
        fix: { action: 'review-statusline', path: userSettings.path, hint: 'Ensure the command is cheap and its output is bounded' },
      });
    }
  }

  // ---- 7. MCP: server-count + unused + retry loops ----
  const pluginServers = (config.global?.plugins || []).flatMap(p =>
    (p.mcpServers || []).map(s => ({ ...s, _pluginKey: p.key }))
  );
  const globalServers = [...(config.global?.mcpServers || []), ...pluginServers];
  const activeGlobal = globalServers.filter(s => !s.disabled);
  if (activeGlobal.length >= MCP_SERVER_COUNT_WARN) {
    const list = activeGlobal.map(s => `  • ${s.name}${s._pluginKey ? ` (plugin:${s._pluginKey})` : ''}`).join('\n');
    suggestions.push({
      id: 'mcp-server-count-global',
      severity: activeGlobal.length >= MCP_SERVER_COUNT_HIGH ? 'high' : 'medium',
      category: 'mcp',
      title: `${activeGlobal.length} MCP servers enabled globally`,
      detail: `Top-level mcpServers in ~/.claude.json lists ${activeGlobal.length} active servers:\n${list}\n\nClaude Code defers full tool-schema loading until a tool search hits, but tool names still load up front and schemas are cached after first use. Past ${MCP_SERVER_COUNT_WARN} servers, overhead is measurable. Move project-specific servers into per-project .mcp.json or ~/.claude.json projects[<folder>].mcpServers so they only load where used.`,
      scope: { type: 'global' },
      impact: { requestsObserved: usage.sessions },
      fix: { action: 'trim-servers', hint: 'Move project-specific servers into per-project MCP config' },
    });
  }

  // Retry loops.
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
        detail: `This MCP tool was called ${e.repeats} times with identical args across ${e.loops} retry loop${e.loops === 1 ? '' : 's'} (same call ≥${RETRY_LOOP_MIN_REPEATS} times in a single chat). Repeated identical calls usually mean the agent hit an error or stale response and kept retrying — burning tokens per turn without progress.`,
        scope: { type: 'global' },
        impact: { requestsObserved: e.repeats },
        fix: { action: 'inspect-tool', hint: 'Check if the MCP tool returns structured errors (agent can react) vs opaque failures (agent retries blindly)' },
      });
    }
  }

  // Unused MCP servers (global scope).
  const allToolNames = Array.from(usage.toolNames);
  for (const server of globalServers) {
    if (server.disabled) continue;
    if (usage.sessions < DEAD_SERVER_MIN_SESSIONS) continue;
    const used = allToolNames.some(t => toolMatchesServer(t, server.name));
    if (used) continue;
    const originLabel = server._pluginKey ? `plugin:${server._pluginKey}` : '~/.claude.json';
    suggestions.push({
      id: `global-mcp-unused:${server._pluginKey || 'user'}:${server.name}`,
      severity: 'medium',
      category: 'mcp',
      title: `${server._pluginKey ? 'Plugin' : 'Global'} MCP server "${server.name}" never invoked`,
      detail: `Configured via ${originLabel} but not called once across ${usage.sessions} Claude Code sessions. Its tool definitions cost context as soon as the agent searches for matching tools. Remove or disable it.`,
      scope: { type: 'global' },
      impact: { requestsObserved: usage.sessions },
      fix: {
        action: server._pluginKey ? 'disable-plugin-server' : 'disable-server',
        path: server.configPath,
        hint: server._pluginKey
          ? `Disable plugin ${server._pluginKey} or request the author remove "${server.name}"`
          : `Remove "${server.name}" from ~/.claude.json or set \`disabled: true\``,
      },
    });
  }

  // Per-project unused MCP servers.
  for (const proj of config.projects || []) {
    const sessionsHere = usage.sessionsByFolder.get(proj.folder) || 0;
    const toolsHere = usage.toolNamesByFolder.get(proj.folder) || new Set();
    if (sessionsHere < DEAD_SERVER_MIN_SESSIONS) continue;
    for (const server of proj.mcpServers || []) {
      if (server.disabled) continue;
      const used = Array.from(toolsHere).some(t => toolMatchesServer(t, server.name));
      if (used) continue;
      suggestions.push({
        id: `project-mcp-unused:${proj.folder}:${server.name}`,
        severity: 'medium',
        category: 'mcp',
        title: `Project MCP server "${server.name}" never invoked here`,
        detail: `Configured for ${proj.folder} but not called once across ${sessionsHere} sessions in this folder. Its tool names load at startup and schemas cache after first use. Disable if unused.`,
        scope: { type: 'project', folder: proj.folder, folders: [proj.folder] },
        impact: { requestsObserved: sessionsHere },
        fix: { action: 'disable-project-mcp', path: server.configPath, hint: `Remove "${server.name}" from project MCP config` },
      });
    }
  }

  // ---- Dedupe (same findings may appear across inheriting subfolders) ----
  const byId = new Map();
  for (const s of suggestions) {
    const prev = byId.get(s.id);
    if (!prev) {
      byId.set(s.id, {
        ...s,
        scope: { ...s.scope, folders: [...(s.scope?.folders || [])] },
        impact: { ...s.impact },
      });
      continue;
    }
    const pImp = prev.impact;
    const cImp = s.impact || {};
    pImp.requestsObserved = (pImp.requestsObserved || 0) + (cImp.requestsObserved || 0);
    pImp.tokensWasted = (pImp.tokensWasted || 0) + (cImp.tokensWasted || 0);
    pImp.usdWasted = (pImp.usdWasted || 0) + (cImp.usdWasted || 0);
    if (cImp.usdEstimated) pImp.usdEstimated = true;
    for (const f of s.scope?.folders || []) {
      if (!prev.scope.folders.includes(f)) prev.scope.folders.push(f);
    }
  }
  const deduped = Array.from(byId.values());
  for (const s of deduped) {
    const fs = s.scope?.folders || [];
    if (fs.length > 1) s.scope = { ...s.scope, type: 'multi', folders: fs };
  }

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
