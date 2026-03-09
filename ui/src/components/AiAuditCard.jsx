import { useState, useEffect, useRef } from 'react'
import { ShieldCheck, Loader2, CheckCircle2, AlertTriangle, RefreshCw, Info, ChevronRight, ChevronDown, Brush, FileText, FlaskConical, Bot, Lock, Puzzle, Plug, Package } from 'lucide-react'
import { fetchCheckAi } from '../lib/api'
import SectionTitle from './SectionTitle'

const GRADE_COLORS = {
  'A+': '#22c55e', A: '#22c55e',
  'B+': '#4ade80', B: '#4ade80',
  'C+': '#facc15', C: '#facc15',
  'D+': '#f97316', D: '#f97316',
  F: '#ef4444',
}

const SECTION_ICONS = {
  'Repo Hygiene': Brush,
  'Grounding Docs': FileText,
  'Testing': FlaskConical,
  'Agent Configs': Bot,
  'AI Context': Lock,
  'Prompts & Skills': Puzzle,
  'MCP': Plug,
  'AI Dependencies': Package,
  'AI Deps': Package,
}

function Tip({ missing }) {
  const [open, setOpen] = useState(false)
  const ref = useRef(null)

  useEffect(() => {
    if (!open) return
    const handler = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false) }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  const weighted = missing.filter(f => f.weight > 0)
  const items = weighted.length > 0 ? weighted : missing.slice(0, 5)
  if (items.length === 0) return null

  return (
    <span ref={ref} className="relative flex-shrink-0">
      <button
        onClick={(e) => { e.stopPropagation(); setOpen(!open) }}
        className="flex items-center justify-center w-4 h-4 rounded-full transition hover:opacity-80"
        style={{ color: 'var(--c-text3)', background: 'var(--c-bg3)' }}
      >
        <Info size={10} />
      </button>
      {open && (
        <div
          className="absolute right-0 top-6 z-50 w-64 p-2.5 rounded shadow-lg"
          style={{ background: 'var(--c-bg)', border: '1px solid var(--c-border)', boxShadow: '0 4px 24px rgba(0,0,0,0.3)' }}
        >
          <div className="text-[11px] font-medium mb-1.5" style={{ color: 'var(--c-white)' }}>How to improve</div>
          <div className="space-y-1">
            {items.map(f => (
              <div key={f.id} className="text-[11px]" style={{ color: 'var(--c-text2)' }}>
                <span style={{ color: 'var(--c-text)' }}>+ {f.label}</span>
                {f.weight > 0 && <span style={{ color: 'var(--c-text3)' }}> ({f.weight}pt)</span>}
              </div>
            ))}
          </div>
        </div>
      )}
    </span>
  )
}

export default function AiAuditCard({ folder }) {
  console.log('AiAuditCard rendering, folder:', folder)
  const [audit, setAudit] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [expanded, setExpanded] = useState(new Set())

  const runAudit = async () => {
    if (!folder) return
    setLoading(true)
    setError(null)
    try {
      const result = await fetchCheckAi(folder)
      if (result.error) throw new Error(result.error)
      setAudit(result)
    } catch (e) {
      setError(e.message)
    }
    setLoading(false)
  }

  useEffect(() => {
    console.log('AiAuditCard useEffect triggered, folder:', folder)
    runAudit()
  }, [folder])

  if (loading) {
    return (
      <div className="card p-4">
        <div className="flex items-center gap-2">
          <Loader2 size={14} className="animate-spin" style={{ color: 'var(--c-accent)' }} />
          <span className="text-[12px]" style={{ color: 'var(--c-text2)' }}>Running AI readiness audit...</span>
        </div>
      </div>
    )
  }

  if (error) {
    return (
      <div className="card p-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <AlertTriangle size={14} style={{ color: '#ef4444' }} />
            <span className="text-[12px]" style={{ color: 'var(--c-text2)' }}>Audit failed: {error}</span>
          </div>
          <button
            onClick={runAudit}
            className="flex items-center gap-1.5 px-2.5 py-1 text-[11px] rounded transition hover:opacity-80"
            style={{ color: 'var(--c-text2)', border: '1px solid var(--c-border)' }}
          >
            <RefreshCw size={10} />
            Retry
          </button>
        </div>
      </div>
    )
  }

  if (!audit) return null

  const gradeColor = GRADE_COLORS[audit.grade] || 'var(--c-text2)'
  const sections = audit.sections || {}
  const findings = audit.findings || []

  const findingsBySection = {}
  for (const f of findings) {
    const sec = f.section || 'Other'
    if (!findingsBySection[sec]) findingsBySection[sec] = []
    findingsBySection[sec].push(f)
  }

  return (
    <div className="card p-4 space-y-3">
      {/* Header row */}
      <div className="flex items-center gap-3">
        <ShieldCheck size={16} style={{ color: gradeColor }} />
        <div>
          <SectionTitle>ai readiness audit</SectionTitle>
          <div className="text-[10px] -mt-1.5" style={{ color: 'var(--c-text3)' }}>powered by <code style={{ fontFamily: 'JetBrains Mono, monospace' }}>npx check-ai</code></div>
        </div>
        <div className="flex items-center gap-2 ml-auto">
          <span className="text-[11px]" style={{ color: 'var(--c-text3)' }}>
            {audit.checks?.passed || 0}/{audit.checks?.total || 0} checks
            &middot; {audit.points?.earned || 0}/{audit.points?.max || 0} pts
          </span>
          <button
            onClick={runAudit}
            className="flex items-center gap-1 px-2 py-1 text-[11px] rounded transition hover:opacity-80"
            style={{ color: 'var(--c-text2)', border: '1px solid var(--c-border)' }}
          >
            <RefreshCw size={10} />
          </button>
        </div>
      </div>

      {/* Score row */}
      <div className="flex items-center gap-3">
        <div
          className="w-11 h-11 rounded-lg flex items-center justify-center text-base font-black flex-shrink-0"
          style={{ background: `${gradeColor}15`, color: gradeColor, border: `1.5px solid ${gradeColor}30` }}
        >
          {audit.grade}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-baseline gap-1.5">
            <span className="text-base font-bold" style={{ color: 'var(--c-white)' }}>{audit.score}</span>
            <span className="text-[11px]" style={{ color: 'var(--c-text3)' }}>/10</span>
            <span className="text-[11px] ml-1" style={{ color: 'var(--c-text2)' }}>{audit.label}</span>
          </div>
          <div className="w-full h-2 rounded-full overflow-hidden mt-1" style={{ background: 'var(--c-code-bg)' }}>
            <div className="h-full rounded-full" style={{ width: `${((audit.score || 0) / 10 * 100).toFixed(1)}%`, background: gradeColor }} />
          </div>
        </div>
      </div>

      {/* Section rows */}
      <div>
        {Object.entries(sections).map(([name, sec]) => {
          const Icon = SECTION_ICONS[name] || FileText
          const sectionFindings = findingsBySection[name] || []
          const passed = sectionFindings.filter(f => f.found)
          const missing = sectionFindings.filter(f => !f.found)
          const pct = sec.pct || 0
          const barColor = pct >= 70 ? '#22c55e' : pct >= 40 ? '#facc15' : pct > 0 ? '#f97316' : 'var(--c-text3)'

          // Build description from found findings
          const details = []
          for (const f of passed) {
            if (f.detail) details.push(f.detail)
            else if (f.matchedPath) details.push(f.matchedPath)
            else if (f.matches && f.matches.length > 0) details.push(f.matches.join(', '))
            else details.push(f.label)
          }
          const desc = details.length > 0
            ? details.slice(0, 3).join(' · ') + (details.length > 3 ? ' …' : '')
            : 'none detected'

          const isOpen = expanded.has(name)
          const toggle = () => setExpanded(prev => {
            const next = new Set(prev)
            if (next.has(name)) next.delete(name)
            else next.add(name)
            return next
          })

          return (
            <div key={name} style={{ borderBottom: '1px solid var(--c-border)' }}>
              {/* Main row — clickable */}
              <div className="flex items-center gap-2.5 py-2 cursor-pointer transition hover:bg-[var(--c-bg3)]" onClick={toggle}>
                {isOpen
                  ? <ChevronDown size={12} style={{ color: 'var(--c-text3)', flexShrink: 0 }} />
                  : <ChevronRight size={12} style={{ color: 'var(--c-text3)', flexShrink: 0 }} />
                }
                <Icon size={14} style={{ color: 'var(--c-text3)', flexShrink: 0 }} />
                <span className="text-[12px] font-medium w-32 flex-shrink-0" style={{ color: 'var(--c-white)' }}>{name}</span>
                <span className="text-[11px] flex-1 truncate" style={{ color: passed.length > 0 ? 'var(--c-text2)' : 'var(--c-text3)' }}>
                  {desc}
                </span>
                <span className="text-[11px] flex-shrink-0" style={{ color: 'var(--c-text3)' }}>{passed.length}/{sectionFindings.length}</span>
                <div className="w-20 h-2 rounded-full overflow-hidden flex-shrink-0" style={{ background: 'var(--c-code-bg)' }}>
                  <div className="h-full rounded-full" style={{ width: `${pct}%`, background: barColor }} />
                </div>
                <span className="text-[11px] w-9 text-right font-bold flex-shrink-0" style={{ color: barColor }}>{pct}%</span>
                {missing.length > 0 && <Tip missing={missing} />}
              </div>
              {/* Expanded: found findings */}
              {isOpen && passed.length > 0 && (
                <div className="flex flex-wrap gap-x-4 gap-y-0.5 pb-2 pl-12">
                  {passed.map(f => (
                    <span key={f.id} className="inline-flex items-center gap-1.5 text-[11px] py-0.5">
                      <CheckCircle2 size={10} style={{ color: '#22c55e', flexShrink: 0 }} />
                      <span style={{ color: 'var(--c-text)' }}>{f.label}</span>
                      {f.matchedPath && <span style={{ color: 'var(--c-text3)' }}>{f.matchedPath}</span>}
                      {f.detail && <span style={{ color: 'var(--c-text2)' }}>— {f.detail}</span>}
                    </span>
                  ))}
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
