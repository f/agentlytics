import { useState, useEffect, useMemo, useCallback } from 'react'
import { Lightbulb, AlertTriangle, AlertCircle, Info, FileCode, Plug, Cpu, Sparkles, ChevronDown, ChevronRight, FolderOpen, ExternalLink, Copy, Check, ArrowDownUp, ChevronsDown, ChevronsUp, Wand2 } from 'lucide-react'
import { fetchSuggestions } from '../lib/api'
import AnimatedLoader from '../components/AnimatedLoader'
import PageHeader from '../components/PageHeader'
import KpiCard from '../components/KpiCard'
import EditorIcon from '../components/EditorIcon'
import { formatNumber, editorColor, editorLabel } from '../lib/constants'

const MONO = 'JetBrains Mono, monospace'

const SEVERITY_META = {
  high:   { label: 'HIGH',   color: '#ef4444', bg: 'rgba(239,68,68,0.12)',  icon: AlertCircle },
  medium: { label: 'MEDIUM', color: '#f59e0b', bg: 'rgba(245,158,11,0.12)', icon: AlertTriangle },
  low:    { label: 'LOW',    color: '#3b82f6', bg: 'rgba(59,130,246,0.12)', icon: Info },
}

const SEVERITY_WEIGHT = { high: 3, medium: 2, low: 1 }

const CATEGORY_META = {
  rules:  { label: 'Rules',  icon: FileCode },
  mcp:    { label: 'MCP',    icon: Plug },
  model:  { label: 'Model',  icon: Cpu },
  skills: { label: 'Skills', icon: Sparkles },
  agents: { label: 'Agents', icon: Sparkles },
  hooks:  { label: 'Hooks',  icon: Plug },
}

const SUPPORTED_EDITORS = ['cursor', 'claude-code']

const RESTART_TEXT = {
  cursor: 'Reload Cursor window (Cmd+Shift+P → "Developer: Reload Window") so MCP/rule changes take effect',
  'claude-code': 'Restart your Claude Code session (exit + rerun) to reload config',
}

function buildFixSteps(sugg) {
  const fix = sugg.fix
  if (!fix) return []
  const steps = []
  const action = fix.action
  const serverMatch = sugg.title.match(/^([\w-]+):/)
  const serverName = fix.serverName || (serverMatch ? serverMatch[1] : null)

  switch (action) {
    case 'disable-tools':
      {
        const tools = fix.disabledTools || []
        const disabledToolsCode = tools.length
          ? `"disabledTools": [\n${tools.map(tool => `  "${tool}"`).join(',\n')}\n]`
          : '"disabledTools": ["tool-a", "tool-b"]'
      steps.push({
        label: `Add \`disabledTools\` under "${serverName || 'server'}"`,
        detail: tools.length
          ? `Paste this exact property into the existing "${serverName}" entry. It disables ${tools.length} never-called tools and leaves rarely/actively used tools enabled.`
          : 'List never-called tools from "What\'s wrong" above.',
        code: disabledToolsCode,
      })
      }
      break
    case 'disable-server':
    case 'remove-server':
    case 'disable-project-mcp':
      steps.push({
        label: serverName ? `Remove "${serverName}" from \`mcpServers\`` : 'Remove the server entry',
        detail: 'Or mark disabled to keep the entry without loading it.',
        code: `"${serverName || 'server-name'}": {\n  "command": "...",\n  "disabled": true\n}`,
      })
      break
    case 'disable-plugin-server':
      steps.push({
        label: 'Disable the plugin that ships this server',
        detail: 'Or ask the plugin author to remove the server.',
        code: `{\n  "enabledPlugins": {\n    "<plugin-key>": false\n  }\n}`,
      })
      break
    case 'change-model':
      steps.push({
        label: 'Switch default model to Sonnet',
        detail: 'Opus still available per-session via `/model` or `--model`.',
        code: `{\n  "model": "sonnet"\n}`,
      })
      break
    case 'lower-effort':
      steps.push({
        label: 'Lower default effort level',
        detail: 'High/max spends the full thinking budget every turn.',
        code: `{\n  "effortLevel": "medium"\n}`,
      })
      break
    case 'fix-rule':
    case 'scope-rule':
      steps.push({
        label: 'Scope the rule via frontmatter',
        detail: 'Loads only when matching files are opened.',
        code: `---\ndescription: When working on X\nglobs: ["src/**/*.ts"]\nalwaysApply: false\n---`,
      })
      break
    case 'scope-rules':
      steps.push({
        label: 'Add `paths:` to each rule file',
        detail: 'Rule loads only when Claude reads a matching file.',
        code: `---\npaths: ["src/**/*.ts"]\ndescription: TypeScript conventions\n---`,
      })
      break
    case 'migrate':
      steps.push({
        label: 'Move `.cursorrules` → `.cursor/rules/<name>.mdc`',
        detail: 'Delete `.cursorrules` afterwards — Cursor ignores it once `.cursor/rules/` exists.',
        code: `.cursor/rules/conventions.mdc:\n---\ndescription: Project conventions\nglobs: ["**/*"]\nalwaysApply: false\n---\n\n<rule body>`,
      })
      break
    case 'split-claude-md':
      steps.push({
        label: 'Split into skills or scoped rules',
        detail: 'SKILL.md loads only on trigger; scoped rules load only on matching file open.',
        code: `.claude/skills/<name>/SKILL.md:\n---\nname: <name>\ndescription: What it does + when to use it\n---\n\n<content>`,
      })
      break
    case 'split-skill':
      steps.push({
        label: 'Move long content into `references/`',
        detail: 'SKILL.md stays short; reference material loads on demand.',
        code: `<skill>/\n├── SKILL.md       (behavior — short)\n└── references/\n    └── detail.md  (loaded on demand)`,
      })
      break
    case 'add-description':
    case 'improve-description':
      steps.push({
        label: 'Add/expand description frontmatter',
        detail: 'Description drives when the agent triggers this.',
        code: `---\nname: <name>\ndescription: <what it does>. Use when <trigger phrases>.\n---`,
      })
      break
    case 'trim-description':
      steps.push({
        label: 'Trim description to ~250 chars',
        detail: 'All subagent descriptions concatenate into parent startup context.',
        code: `---\nname: <name>\ndescription: <one sentence what>. <one sentence when>.\n---`,
      })
      break
    case 'fix-name':
      steps.push({
        label: 'Match frontmatter name to folder name',
        code: `---\nname: <folder-name>\n---`,
      })
      break
    case 'restrict-tools':
      steps.push({
        label: 'Restrict tool set in frontmatter',
        detail: 'Only grant tools this subagent actually needs.',
        code: `---\nname: <name>\ntools: Read, Grep, Glob\n---`,
      })
      break
    case 'trim-subagent':
      steps.push({
        label: 'Shrink subagent body',
        detail: 'Move reference material into skills the subagent loads on demand.',
      })
      break
    case 'disable-plugin':
    case 'disable-plugin-rules':
      steps.push({
        label: 'Disable the plugin in `~/.claude/settings.json`',
        code: `{\n  "enabledPlugins": {\n    "<plugin-key>": false\n  }\n}`,
      })
      break
    case 'review-statusline':
      steps.push({
        label: 'Bound the statusLine command',
        detail: 'Fast (<50ms), short output.',
        code: `"statusLine": {\n  "type": "command",\n  "command": "your-cmd | head -c 120"\n}`,
      })
      break
    case 'review-hook':
      steps.push({
        label: 'Bound, gate, or remove the hook',
        detail: 'Pipe output through `head -n 5`, add a condition, or delete it if unused.',
      })
      break
    case 'review-shell':
      steps.push({
        label: 'Keep `!`<cmd>`` output short — or call a script',
        detail: fix.hint,
      })
      break
    case 'trim-servers':
      steps.push({
        label: 'Move project servers into per-project config',
        detail: 'Keep global `~/.claude.json` / `~/.cursor/mcp.json` minimal. Project servers live in `.mcp.json` or `projects[<folder>].mcpServers`.',
      })
      break
    case 'trim-skills':
      steps.push({
        label: 'Delete unused skills, tighten descriptions',
        detail: 'Aim <200 chars each. Remove skills you never invoke.',
      })
      break
    case 'add-triggers':
      steps.push({
        label: 'Add trigger phrases to description',
        detail: 'Agent matches user intent to descriptions — be explicit.',
        code: `---\ndescription: <what>. Trigger on "<phrase-1>", "<phrase-2>".\n---`,
      })
      break
    case 'consolidate':
      steps.push({
        label: 'Scope the always-on rules',
        detail: 'Add `globs:` / `paths:` frontmatter so each loads only when needed.',
      })
      break
    default:
      steps.push({ label: fix.hint })
  }

  if (sugg._editor && RESTART_TEXT[sugg._editor]) {
    steps.push({ label: RESTART_TEXT[sugg._editor] })
  }

  return steps
}

function buildFixPrompt(sugg) {
  const cleanDetail = (sugg.detail || '').replace(/\n*(?:Damage|Est\. waste) so far:[^\n]*\n*/g, '\n').trim()
  const lines = []
  lines.push(`Please fix a ${sugg._editor || 'editor'} cost/hygiene issue in my config.`)
  lines.push('')
  lines.push(`## Problem`)
  lines.push(sugg.title)
  if (sugg.fix?.path) lines.push(`File: ${sugg.fix.path}`)
  if (sugg.scope?.type) lines.push(`Scope: ${sugg.scope.type}${sugg.scope.folder ? ` (${sugg.scope.folder})` : ''}`)
  lines.push('')
  lines.push(`## Details`)
  lines.push(cleanDetail)
  lines.push('')
  lines.push(`## Action`)
  lines.push(sugg.fix?.hint || 'Apply the recommended change above.')
  lines.push('')
  lines.push(`Read the file first, make the change, then show me the diff.`)
  return lines.join('\n')
}

function wastedUsdOf(s) {
  return s?.impact?.usdWasted || 0
}

function FixActionBar({ sugg, onCopyPath, pathCopied }) {
  const [promptCopied, setPromptCopied] = useState(false)
  const path = sugg.fix?.path
  const editor = sugg._editor
  const vscodeUrl = path ? `vscode://file${path}` : null
  const cursorUrl = path ? `cursor://file${path}` : null
  const showCursor = path && (editor === 'cursor' || editor == null)
  const showVscode = path

  const copyPrompt = (e) => {
    e.stopPropagation()
    try {
      navigator.clipboard.writeText(buildFixPrompt(sugg))
      setPromptCopied(true)
      setTimeout(() => setPromptCopied(false), 1500)
    } catch { /* clipboard denied */ }
  }

  const btnBase = 'min-h-8 text-[10px] inline-flex items-center gap-1 px-2 py-1 rounded transition-[background-color,border-color,color,opacity,transform] active:scale-[0.96]'
  const btnStyle = { background: 'var(--c-bg4,#272727)', color: 'var(--c-text)', border: '1px solid var(--c-border)' }

  return (
    <div className="flex items-center gap-1 flex-wrap">
      {showCursor && (
        <a
          href={cursorUrl}
          className={btnBase + ' hover:opacity-80'}
          style={btnStyle}
          title={`Open in Cursor: ${path}`}
        >
          <ExternalLink size={10} />
          Open in Cursor
        </a>
      )}
      {showVscode && (
        <a
          href={vscodeUrl}
          className={btnBase + ' hover:opacity-80'}
          style={btnStyle}
          title={`Open in VS Code: ${path}`}
        >
          <ExternalLink size={10} />
          Open in VS Code
        </a>
      )}
      {path && (
        <button
          onClick={onCopyPath}
          className={btnBase + ' hover:opacity-80'}
          style={{ ...btnStyle, color: pathCopied ? '#10b981' : 'var(--c-text)' }}
          title={pathCopied ? 'Copied!' : path}
        >
          {pathCopied ? <Check size={10} /> : <Copy size={10} />}
          {pathCopied ? 'Copied' : 'Copy path'}
        </button>
      )}
      <button
        onClick={copyPrompt}
        className={btnBase + ' hover:opacity-80'}
        style={{
          background: promptCopied ? 'rgba(16,185,129,0.15)' : 'rgba(129,140,248,0.15)',
          color: promptCopied ? '#10b981' : '#818cf8',
          border: `1px solid ${promptCopied ? 'rgba(16,185,129,0.4)' : 'rgba(129,140,248,0.4)'}`,
        }}
        title="Copy a ready-to-paste prompt for Claude Code / Cursor agent"
      >
        {promptCopied ? <Check size={10} /> : <Wand2 size={10} />}
        {promptCopied ? 'Prompt copied' : 'Ask agent to fix'}
      </button>
    </div>
  )
}

function FixSteps({ sugg, onCopyPath, pathCopied }) {
  const steps = buildFixSteps(sugg)
  const [copiedStep, setCopiedStep] = useState(-1)
  const copyCode = (code, idx) => {
    try {
      navigator.clipboard.writeText(code)
      setCopiedStep(idx)
      setTimeout(() => setCopiedStep(-1), 1500)
    } catch { /* clipboard denied */ }
  }
  const path = sugg.fix?.path
  return (
    <div
        className="text-[11px] p-2.5 rounded"
      style={{ background: 'var(--c-bg3)', border: '1px solid var(--c-border)' }}
    >
      <div className="flex items-start justify-between mb-2 gap-2 flex-wrap">
        <div className="text-[10px] uppercase tracking-wider" style={{ color: 'var(--c-text3)' }}>How to fix</div>
        <FixActionBar sugg={sugg} onCopyPath={onCopyPath} pathCopied={pathCopied} />
      </div>
      {path && (
        <div
          className="text-[10px] mb-2 px-2 py-1 rounded inline-flex items-center gap-1 max-w-full"
          style={{ background: 'var(--c-bg4,#272727)', color: 'var(--c-text2)', fontFamily: MONO }}
          title={path}
        >
          <FileCode size={10} className="shrink-0" style={{ color: 'var(--c-text3)' }} />
          <span className="truncate" style={{ maxWidth: 480 }}>{path}</span>
        </div>
      )}
      <ol className="space-y-2">
        {steps.map((step, i) => (
          <li key={i} className="flex gap-2">
            <span
              className="shrink-0 w-4 h-4 rounded-full inline-flex items-center justify-center text-[9px] font-bold"
              style={{ background: 'var(--c-bg4,#272727)', color: 'var(--c-text2)' }}
            >
              {i + 1}
            </span>
            <div className="flex-1 min-w-0 space-y-1">
              <div style={{ color: 'var(--c-white)' }}>{step.label}</div>
              {step.detail && (
                <div className="text-[10px]" style={{ color: 'var(--c-text2)' }}>
                  {step.detail}
                </div>
              )}
              {step.code && (
                <div className="relative">
                  <pre
                    className="text-[10px] p-2 rounded overflow-x-auto"
                    style={{ background: 'var(--c-code-bg, rgba(255,255,255,0.05))', color: 'var(--c-white)', fontFamily: MONO }}
                  >
                    {step.code}
                  </pre>
                  <button
                    onClick={() => copyCode(step.code, i)}
                    className="absolute top-1 right-1 min-w-8 min-h-8 inline-flex items-center justify-center rounded hover:bg-[var(--c-bg4,#222)] transition-[background-color,color,transform] active:scale-[0.96]"
                    style={{ color: copiedStep === i ? '#10b981' : 'var(--c-text3)' }}
                    title={copiedStep === i ? 'Copied!' : 'Copy snippet'}
                  >
                    {copiedStep === i ? <Check size={10} /> : <Copy size={10} />}
                  </button>
                </div>
              )}
            </div>
          </li>
        ))}
      </ol>
    </div>
  )
}

function FindingField({ label, value, mono, color, title }) {
  return (
    <div className="flex flex-col min-w-0">
      <span className="text-[9px] uppercase tracking-wider mb-0.5" style={{ color: 'var(--c-text3)' }}>{label}</span>
      <span
        className="text-[11px] font-medium truncate"
        style={{ color: color || 'var(--c-white)', fontFamily: mono ? MONO : undefined }}
        title={title}
      >
        {value}
      </span>
    </div>
  )
}

function SuggestionCard({ sugg, open, onToggle }) {
  const [copied, setCopied] = useState(false)
  const [pathCopied, setPathCopied] = useState(false)
  const sev = SEVERITY_META[sugg.severity] || SEVERITY_META.low
  const cat = CATEGORY_META[sugg.category] || { label: sugg.category, icon: Info }
  const edSource = sugg._editor || null
  const edColor = edSource ? editorColor(edSource) : null
  const SevIcon = sev.icon
  const CatIcon = cat.icon
  const imp = sugg.impact || {}
  const wastedTokens = imp.tokensWasted != null
    ? imp.tokensWasted
    : (imp.tokensPerRequest && imp.requestsObserved ? imp.tokensPerRequest * imp.requestsObserved : null)
  const wastedUsd = imp.usdWasted != null ? imp.usdWasted : null
  const usdEstimated = imp.usdEstimated === true
  const fmtUsd = n => n < 0.01 ? '<$0.01' : `${usdEstimated ? '~' : ''}$${n.toFixed(2)}`

  const cleanDetail = (sugg.detail || '').replace(/\n*(?:Damage|Est\. waste) so far:[^\n]*\n*/g, '\n').trim()
  const scopeType = sugg.scope?.type
  const isGlobal = scopeType === 'global'
  const isMulti = scopeType === 'multi'
  const folders = sugg.scope?.folders || (sugg.scope?.folder ? [sugg.scope.folder] : [])
  const folder = sugg.scope?.folder
  const projectName = folder ? folder.split('/').pop() : null
  const scopePillLabel = isGlobal ? 'Global' : isMulti ? `${folders.length} projects` : 'Project'
  const scopePillColor = isGlobal ? '#818cf8' : isMulti ? '#f59e0b' : '#10b981'
  const scopePillBg = isGlobal ? 'rgba(129,140,248,0.15)' : isMulti ? 'rgba(245,158,11,0.15)' : 'rgba(16,185,129,0.15)'
  const buildClipText = () => {
    const lines = []
    lines.push(`[${sugg.severity.toUpperCase()}] ${sugg.title}`)
    lines.push(`Scope: ${scopePillLabel}`)
    if (folders.length) lines.push(`Folders:\n${folders.map(f => '  - ' + f).join('\n')}`)
    if (imp.tokensPerRequest) lines.push(`Tokens per turn: ${imp.tokensPerRequest}`)
    if (imp.requestsObserved) lines.push(`Turns observed: ${imp.requestsObserved}`)
    if (imp.tokensWasted) lines.push(`Tokens wasted: ${imp.tokensWasted}`)
    if (imp.usdWasted) lines.push(`Est. waste: ${fmtUsd(imp.usdWasted)}`)
    lines.push('')
    lines.push(cleanDetail)
    if (sugg.fix) {
      lines.push('')
      lines.push(`Fix: ${sugg.fix.hint}`)
      if (sugg.fix.path) lines.push(`Path: ${sugg.fix.path}`)
    }
    return lines.join('\n')
  }

  const copy = (e) => {
    e.stopPropagation()
    try {
      navigator.clipboard.writeText(open ? buildClipText() : sugg.title)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch { /* clipboard denied */ }
  }

  const copyPath = (e) => {
    e.stopPropagation()
    try {
      navigator.clipboard.writeText(sugg.fix.path)
      setPathCopied(true)
      setTimeout(() => setPathCopied(false), 1500)
    } catch { /* clipboard denied */ }
  }

  const targetPath = sugg.fix?.path || null
  const targetRel = targetPath && folder && targetPath.startsWith(folder + '/')
    ? targetPath.slice(folder.length + 1)
    : (targetPath && targetPath.startsWith('/Users/') ? targetPath.replace(/^.*\/(\.cursor|\.claude)\//, '$1/') : targetPath)

  return (
    <div className="card overflow-hidden">
      <div className="flex items-stretch">
        <div className="shrink-0 w-1" style={{ background: sev.color }} />

        <button
          type="button"
          onClick={onToggle}
          aria-expanded={open}
          className="flex-1 min-w-0 min-h-12 px-3 py-2.5 flex items-center gap-3 text-left hover:bg-[var(--c-bg3)] transition-[background-color]"
        >
          <div className="flex items-center justify-center shrink-0 w-7 h-7 rounded" style={{ background: sev.bg }}>
            <SevIcon size={14} style={{ color: sev.color }} />
          </div>

          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-1.5 flex-wrap">
              <span className="text-[13px] font-semibold" style={{ color: 'var(--c-white)' }}>{sugg.title}</span>
              {edSource && (
                <span
                  className="text-[9px] font-bold px-1 py-px rounded uppercase tracking-wide inline-flex items-center gap-1"
                  style={{ background: edColor + '20', color: edColor }}
                >
                  <EditorIcon source={edSource} size={10} />
                  {editorLabel(edSource)}
                </span>
              )}
              <span className="text-[9px] font-bold px-1 py-px rounded" style={{ background: sev.bg, color: sev.color }}>{sev.label}</span>
              <span
                className="text-[9px] font-medium px-1 py-px rounded flex items-center gap-0.5"
                style={{ background: 'var(--c-bg3)', color: 'var(--c-text2)' }}
              >
                <CatIcon size={9} />
                {cat.label}
              </span>
              <span
                className="text-[9px] font-bold px-1.5 py-px rounded uppercase tracking-wide"
                style={{ background: scopePillBg, color: scopePillColor }}
              >
                {scopePillLabel}
              </span>
              {!isMulti && projectName && (
                <span className="text-[10px] truncate" style={{ color: 'var(--c-text2)', fontFamily: MONO, maxWidth: 320 }} title={folder}>
                  {projectName}
                </span>
              )}
              {isMulti && (
                <span className="text-[10px] truncate" style={{ color: 'var(--c-text2)', fontFamily: MONO, maxWidth: 420 }} title={folders.join('\n')}>
                  {folders.slice(0, 2).map(f => f.split('/').pop()).join(', ')}{folders.length > 2 ? ` +${folders.length - 2}` : ''}
                </span>
              )}
            </div>
          </div>

          {wastedUsd != null && wastedUsd > 0 && (
            <div className="shrink-0 text-right px-2.5 py-1 rounded" style={{ background: 'rgba(239,68,68,0.12)' }}>
              <div className="text-[14px] font-bold tabular-nums" style={{ color: '#ef4444', fontFamily: MONO }}>{fmtUsd(wastedUsd)}</div>
              <div className="text-[9px] uppercase tracking-wide" style={{ color: '#ef4444' }}>est. waste</div>
            </div>
          )}

          {open ? <ChevronDown size={14} className="shrink-0" style={{ color: 'var(--c-text3)' }} /> : <ChevronRight size={14} className="shrink-0" style={{ color: 'var(--c-text3)' }} />}
        </button>

        <button
            type="button"
            onClick={copy}
            className="shrink-0 min-w-10 min-h-10 self-center inline-flex items-center justify-center rounded hover:bg-[var(--c-bg4,#222)] transition-[background-color,color,transform] active:scale-[0.96]"
            title={copied ? 'Copied!' : (open ? 'Copy full alert' : 'Copy title')}
            style={{ color: copied ? '#10b981' : 'var(--c-text3)', cursor: 'pointer' }}
          >
            {copied ? <Check size={14} /> : <Copy size={14} />}
        </button>
      </div>

      {open && (
        <div className="px-4 pb-3 pt-3" style={{ borderTop: '1px solid var(--c-border)' }}>
          <div
            className="grid gap-3 mb-3 pb-3"
            style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))', borderBottom: '1px solid var(--c-border)' }}
          >
            <FindingField label="Scope" value={scopePillLabel} color={scopePillColor} />
            {!isGlobal && !isMulti && projectName && <FindingField label="Project" value={projectName} mono title={folder} />}
            {!isGlobal && !isMulti && folder && <FindingField label="Folder" value={folder} mono title={folder} />}
            {targetRel && <FindingField label="File" value={targetRel} mono title={targetPath} />}
            <FindingField label="Category" value={cat.label} />
            <FindingField label="Severity" value={sev.label} color={sev.color} />
            {imp.tokensPerRequest != null && imp.tokensPerRequest > 0 && (
              <FindingField label="Tok / turn" value={formatNumber(imp.tokensPerRequest)} mono />
            )}
            {imp.requestsObserved != null && imp.requestsObserved > 0 && (
              <FindingField label="Turns observed" value={formatNumber(imp.requestsObserved)} mono />
            )}
            {wastedTokens != null && wastedTokens > 0 && (
              <FindingField label="Tok wasted" value={formatNumber(wastedTokens)} color="#f59e0b" mono />
            )}
            {wastedUsd != null && wastedUsd > 0 && (
              <FindingField label="Est. waste" value={fmtUsd(wastedUsd)} color="#ef4444" mono />
            )}
          </div>

          {isMulti && folders.length > 0 && (
            <div className="mb-3">
              <div className="text-[10px] uppercase tracking-wider mb-1" style={{ color: 'var(--c-text3)' }}>Affected projects ({folders.length})</div>
              <div className="flex flex-col gap-0.5">
                {folders.map(f => (
                  <div key={f} className="text-[11px] flex items-center gap-1 truncate" style={{ color: 'var(--c-text2)', fontFamily: MONO }}>
                    <FolderOpen size={10} className="shrink-0" style={{ color: 'var(--c-text3)' }} />
                    <span className="truncate" title={f}>{f}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
          <div className="text-[10px] uppercase tracking-wider mb-1" style={{ color: 'var(--c-text3)' }}>What's wrong</div>
          <div className="text-[11px] mb-3 whitespace-pre-wrap" style={{ color: 'var(--c-text)', lineHeight: 1.55 }}>
            {cleanDetail}
          </div>

          {sugg.fix && (
            <FixSteps sugg={sugg} onCopyPath={copyPath} pathCopied={pathCopied} />
          )}
        </div>
      )}
    </div>
  )
}

function PricingNote({ pricing }) {
  const [open, setOpen] = useState(false)
  const tierLabel = pricing.fallbackTier === 'cursor-auto' ? 'Cursor Auto rates' : 'fallback rates'
  const ceiling = pricing.realCostCeiling != null ? pricing.realCostCeiling : pricing.realInputCostAtFallback
  const hasReal = (pricing.realInputTokensObserved || 0) > 0
  return (
    <div
      className="text-[11px] px-2.5 py-1 rounded inline-flex flex-wrap items-center gap-2"
      style={{
        background: 'rgba(245,158,11,0.08)',
        border: '1px solid rgba(245,158,11,0.25)',
        color: 'var(--c-text2)',
      }}
    >
      <Info size={11} style={{ color: '#f59e0b' }} />
      <span>$ figures estimated ({tierLabel})</span>
      {hasReal && ceiling != null && (
        <span style={{ color: 'var(--c-text3)', fontFamily: MONO }}>
          · ≈${ceiling.toFixed(2)} observed ceiling
        </span>
      )}
      <button
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        className="min-h-6 text-[10px] underline transition-[color,opacity] active:scale-[0.96]"
        style={{ color: '#f59e0b' }}
      >
        {open ? 'Hide' : 'Why?'}
      </button>
      {open && (
        <div className="basis-full pt-1 mt-1 space-y-1" style={{ borderTop: '1px solid rgba(245,158,11,0.2)', color: 'var(--c-text2)' }}>
          <div>{pricing.note}</div>
          {hasReal && (
            <div>
              Observed: <strong>{formatNumber(pricing.realInputTokensObserved)}</strong> input
              {pricing.realCacheReadObserved > 0 && <> + <strong>{formatNumber(pricing.realCacheReadObserved)}</strong> cache</>}
              {pricing.realOutputTokensObserved > 0 && <> + <strong>{formatNumber(pricing.realOutputTokensObserved)}</strong> output</>}
              {' '}≈ <strong>${ceiling.toFixed(2)}</strong> at {tierLabel}. Actual spend depends on model mix (Sonnet/Opus/GPT-5 cost more).
            </div>
          )}
        </div>
      )}
    </div>
  )
}

export default function Suggestions() {
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [severityFilter, setSeverityFilter] = useState('all')
  const [categoryFilter, setCategoryFilter] = useState(null)
  const [editor, setEditor] = useState(null)
  const [sortBy, setSortBy] = useState('severity')
  const [expandedIds, setExpandedIds] = useState(() => new Set())

  useEffect(() => {
    // Schedule the loading state so this effect only coordinates the async
    // request, rather than triggering a synchronous render cascade.
    queueMicrotask(() => setLoading(true))
    const editors = editor ? [editor] : SUPPORTED_EDITORS
    Promise.all(editors.map(ed => fetchSuggestions(ed).then(d => ({ ed, d }))))
      .then(results => {
        const mergedSuggestions = []
        let projectsInspected = 0
        let totalSessionsAnalyzed = 0
        let anyEstimated = false
        let pricingNote = null
        let realInputTokensObserved = 0
        let realInputCostAtFallback = 0
        for (const { ed, d } of results) {
          if (!d || d.error) continue
          projectsInspected += d.projectsInspected || 0
          totalSessionsAnalyzed += d.totalSessionsAnalyzed || 0
          if (d.pricing?.estimated) { anyEstimated = true; pricingNote = d.pricing.note }
          realInputTokensObserved += d.pricing?.realInputTokensObserved || 0
          realInputCostAtFallback += d.pricing?.realInputCostAtFallback || 0
          for (const s of (d.suggestions || [])) {
            mergedSuggestions.push({ ...s, _editor: ed, id: `${ed}:${s.id}` })
          }
        }
        setData({
          editor,
          projectsInspected,
          totalSessionsAnalyzed,
          suggestions: mergedSuggestions,
          pricing: {
            estimated: anyEstimated,
            note: pricingNote,
            realInputTokensObserved,
            realInputCostAtFallback,
          },
        })
      })
      .finally(() => setLoading(false))
  }, [editor])

  const filtered = useMemo(() => {
    if (!data?.suggestions) return []
    const out = data.suggestions.filter(s =>
      (severityFilter === 'all' || s.severity === severityFilter) &&
      (categoryFilter == null || s.category === categoryFilter)
    )
    const cmp = sortBy === 'waste'
      ? (a, b) => (wastedUsdOf(b) - wastedUsdOf(a)) || ((SEVERITY_WEIGHT[b.severity] || 0) - (SEVERITY_WEIGHT[a.severity] || 0))
      : (a, b) => ((SEVERITY_WEIGHT[b.severity] || 0) - (SEVERITY_WEIGHT[a.severity] || 0)) || (wastedUsdOf(b) - wastedUsdOf(a))
    return [...out].sort(cmp)
  }, [data, severityFilter, categoryFilter, sortBy])

  const counts = useMemo(() => {
    const c = { high: 0, medium: 0, low: 0, total: 0, tokensTotal: 0, usdTotal: 0, byCategory: {} }
    if (!data?.suggestions) return c
    for (const s of data.suggestions) {
      c[s.severity] = (c[s.severity] || 0) + 1
      c.total++
      c.byCategory[s.category] = (c.byCategory[s.category] || 0) + 1
      const imp = s.impact || {}
      if (imp.tokensWasted) c.tokensTotal += imp.tokensWasted
      else if (imp.tokensPerRequest && imp.requestsObserved) c.tokensTotal += imp.tokensPerRequest * imp.requestsObserved
      if (imp.usdWasted) c.usdTotal += imp.usdWasted
    }
    return c
  }, [data])

  const categories = useMemo(() => {
    if (!data?.suggestions) return []
    const set = new Set(data.suggestions.map(s => s.category))
    return Array.from(set)
  }, [data])

  const toggleOne = useCallback((id) => {
    setExpandedIds(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id); else next.add(id)
      return next
    })
  }, [])

  const expandAll = () => setExpandedIds(new Set(filtered.map(s => s.id)))
  const collapseAll = () => setExpandedIds(new Set())
  const allExpanded = filtered.length > 0 && filtered.every(s => expandedIds.has(s.id))

  if (loading) return <AnimatedLoader label={`Analyzing ${editor ? editorLabel(editor) : 'all editors'} config...`} />
  if (!data || data.error) {
    return (
      <div className="p-6 text-[12px]" style={{ color: 'var(--c-text2)' }}>
        {data?.error || 'No data available'}
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <PageHeader icon={Lightbulb} title="Cost & Hygiene Suggestions">
        <span className="text-[11px] ml-2" style={{ color: 'var(--c-text3)' }}>
          {editor ? editorLabel(editor) : 'All editors'} · <span className="tabular-nums">{data.projectsInspected}</span> projects, <span className="tabular-nums">{formatNumber(data.totalSessionsAnalyzed)}</span> sessions analyzed
        </span>
      </PageHeader>

      <div className="card p-3">
        <div className="flex items-center flex-wrap gap-1.5">
          {SUPPORTED_EDITORS.map(id => {
            const isSelected = editor === id
            return (
              <button
                key={id}
                onClick={() => setEditor(isSelected ? null : id)}
                className="min-h-10 inline-flex items-center gap-1.5 px-2.5 py-1.5 text-[12px] cursor-pointer transition-[background-color,border-color,color,opacity,transform] active:scale-[0.96] rounded-sm"
                style={{
                  border: isSelected ? `1.5px solid ${editorColor(id)}` : '1px solid var(--c-border)',
                  background: isSelected ? editorColor(id) + '15' : 'transparent',
                  opacity: editor && !isSelected ? 0.4 : 1,
                  color: 'var(--c-text)',
                }}
              >
                <EditorIcon source={id} size={14} />
                <span style={{ color: 'var(--c-text2)' }}>{editorLabel(id)}</span>
              </button>
            )
          })}
        </div>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
        <KpiCard label="Total" value={formatNumber(counts.total)} />
        <div className="card px-3 py-2">
          <div className="text-base font-bold tabular-nums" style={{ color: '#ef4444' }}>{formatNumber(counts.high)}</div>
          <div className="text-[11px]" style={{ color: 'var(--c-text2)' }}>High</div>
        </div>
        <div className="card px-3 py-2">
          <div className="text-base font-bold tabular-nums" style={{ color: '#f59e0b' }}>{formatNumber(counts.medium)}</div>
          <div className="text-[11px]" style={{ color: 'var(--c-text2)' }}>Medium</div>
        </div>
        <div className="card px-3 py-2">
          <div className="text-base font-bold tabular-nums" style={{ color: '#3b82f6' }}>{formatNumber(counts.low)}</div>
          <div className="text-[11px]" style={{ color: 'var(--c-text2)' }}>Low</div>
        </div>
        <div className="card px-3 py-2" title={data.pricing?.note || "Approximate input-token cost wasted on misconfigured always-on rules. Capped at real observed spend — per-suggestion $ may overlap."}>
          <div className="text-base font-bold tabular-nums" style={{ color: '#ef4444' }}>
            {(() => {
              const ceiling = data.pricing?.realCostCeiling
              const raw = counts.usdTotal
              const capped = ceiling != null && ceiling > 0 ? Math.min(raw, ceiling) : raw
              if (capped < 0.01) return '<$0.01'
              return `${capped < raw ? '≤' : '~'}$${capped.toFixed(2)}`
            })()}
          </div>
          <div className="text-[11px]" style={{ color: 'var(--c-text2)' }}>
            Est. waste so far{data.pricing?.estimated ? ' (est.)' : ''}
          </div>
        </div>
      </div>

      {data.pricing?.estimated && (
        <PricingNote pricing={data.pricing} />
      )}

      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-[10px] font-medium" style={{ color: 'var(--c-text3)' }}>Severity:</span>
        {['all', 'high', 'medium', 'low'].map(s => {
          const meta = SEVERITY_META[s]
          const SevIcon = meta?.icon
          const active = severityFilter === s
          const n = s === 'all' ? counts.total : (counts[s] || 0)
          return (
            <button
              key={s}
              onClick={() => setSeverityFilter(s)}
              className="min-h-7 text-[10px] px-2 py-0.5 rounded transition-[background-color,border-color,color,opacity,transform] active:scale-[0.96] inline-flex items-center gap-1"
              style={{
                background: active ? 'var(--c-card)' : 'transparent',
                color: active ? (meta?.color || 'var(--c-white)') : 'var(--c-text2)',
                border: '1px solid var(--c-border)',
              }}
            >
              {SevIcon && <SevIcon size={10} />}
              {s === 'all' ? 'All' : s.charAt(0).toUpperCase() + s.slice(1)}
              <span className="opacity-60">{n}</span>
            </button>
          )
        })}
        <span className="ml-3 text-[10px] font-medium" style={{ color: 'var(--c-text3)' }}>Category:</span>
        {categories.map(c => {
          const meta = CATEGORY_META[c] || { label: c, icon: Info }
          const CatIcon = meta.icon
          const active = categoryFilter === c
          const n = counts.byCategory[c] || 0
          return (
            <button
              key={c}
              onClick={() => setCategoryFilter(active ? null : c)}
              className="min-h-7 text-[10px] px-2 py-0.5 rounded transition-[background-color,border-color,color,opacity,transform] active:scale-[0.96] inline-flex items-center gap-1"
              style={{
                background: active ? 'var(--c-card)' : 'transparent',
                color: active ? 'var(--c-white)' : 'var(--c-text2)',
                border: '1px solid var(--c-border)',
                opacity: categoryFilter && !active ? 0.5 : 1,
              }}
            >
              <CatIcon size={10} />
              {meta.label}
              <span className="opacity-60">{n}</span>
            </button>
          )
        })}
      </div>

      {filtered.length === 0 ? (
        <div className="card p-6 text-center text-[12px]" style={{ color: 'var(--c-text2)' }}>
          {data.suggestions.length === 0
            ? 'No suggestions — your config looks good.'
            : 'No suggestions match the current filters.'}
        </div>
      ) : (
        <>
          <div className="flex items-center justify-between gap-2">
            <h3 className="text-[11px] font-medium uppercase tracking-wider inline-flex items-center gap-2" style={{ color: 'var(--c-text2)' }}>
              Findings
              <span style={{ color: 'var(--c-text3)' }}>
                {filtered.length === counts.total ? `${counts.total}` : `${filtered.length} of ${counts.total}`}
              </span>
            </h3>
            <div className="flex items-center gap-1.5">
              <button
                onClick={() => setSortBy(sortBy === 'severity' ? 'waste' : 'severity')}
                className="min-h-8 text-[10px] px-2 py-0.5 rounded transition-[background-color,border-color,color,opacity,transform] active:scale-[0.96] inline-flex items-center gap-1"
                style={{ background: 'transparent', color: 'var(--c-text2)', border: '1px solid var(--c-border)' }}
                title="Toggle sort order"
              >
                <ArrowDownUp size={10} />
                Sort: {sortBy === 'waste' ? 'Waste $' : 'Severity'}
              </button>
              <button
                onClick={allExpanded ? collapseAll : expandAll}
                className="min-h-8 text-[10px] px-2 py-0.5 rounded transition-[background-color,border-color,color,opacity,transform] active:scale-[0.96] inline-flex items-center gap-1"
                style={{ background: 'transparent', color: 'var(--c-text2)', border: '1px solid var(--c-border)' }}
              >
                {allExpanded ? <ChevronsUp size={10} /> : <ChevronsDown size={10} />}
                {allExpanded ? 'Collapse all' : 'Expand all'}
              </button>
            </div>
          </div>

          <div className="space-y-2">
            {filtered.map(s => (
              <SuggestionCard
                key={s.id}
                sugg={s}
                open={expandedIds.has(s.id)}
                onToggle={() => toggleOne(s.id)}
              />
            ))}
          </div>
        </>
      )}
    </div>
  )
}
