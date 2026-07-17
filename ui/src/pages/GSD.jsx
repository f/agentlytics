import { useState, useEffect, useRef } from 'react'
import { Chart as ChartJS, ArcElement, Tooltip, Legend, CategoryScale, LinearScale, BarElement } from 'chart.js'
import { Doughnut, Bar } from 'react-chartjs-2'
import { Target, FileText, BookOpen, ShieldCheck, ChevronDown, ChevronRight, ListTodo, StickyNote, X, CheckCircle2, Circle, Loader2, HelpCircle, Layers } from 'lucide-react'
import { fetchGSDProjects, fetchGSDPhases, fetchGSDPlan, fetchGSDOverview, fetchGSDConfig, fetchGSDFile, fetchGSDPhaseTokens } from '../lib/api'
import { formatCost } from '../lib/constants'
import AnimatedLoader from '../components/AnimatedLoader'
import KpiCard from '../components/KpiCard'
import SectionTitle from '../components/SectionTitle'
import PageHeader from '../components/PageHeader'
import { useTheme } from '../lib/theme'

ChartJS.register(ArcElement, Tooltip, Legend, CategoryScale, LinearScale, BarElement)

const MONO = 'JetBrains Mono, monospace'

function formatRelativeTime(ms) {
  if (!ms) return '—'
  const diff = Date.now() - ms
  const m = Math.floor(diff / 60000)
  if (m < 1) return 'just now'
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  const d = Math.floor(h / 24)
  return `${d}d ago`
}

function statusColor(status) {
  if (status === 'completed') return '#22c55e'
  if (status === 'executing') return '#f59e0b'
  return 'var(--c-text3)'
}

function ProgressBar({ value, total, color = '#6366f1' }) {
  const pct = total > 0 ? Math.round((value / total) * 100) : 0
  return (
    <div className="flex items-center gap-2">
      <div className="flex-1 h-1 rounded-full overflow-hidden" style={{ background: 'var(--c-bg3)' }}>
        <div className="h-full rounded-full transition-all" style={{ width: `${pct}%`, background: color }} />
      </div>
      <span className="text-[10px] tabular-nums" style={{ color: 'var(--c-text3)', fontFamily: MONO, minWidth: 36 }}>
        {value}/{total}
      </span>
    </div>
  )
}

// ============================================================
// File sidebar (slide from right — generic markdown viewer)
// ============================================================

function FileSidebar({ title, subtitle, content, loading, onClose }) {
  const scrollRef = useRef(null)

  return (
    <>
      <div
        className="fixed inset-0 z-40 transition-opacity"
        style={{ background: 'rgba(0,0,0,0.3)' }}
        onClick={onClose}
      />
      <div
        className="fixed top-0 right-0 bottom-0 z-50 flex flex-col shadow-2xl sidebar-slide-in cursor-default"
        style={{ width: 'min(620px, 92vw)', background: 'var(--c-bg)', borderLeft: '1px solid var(--c-border)' }}
      >
        {/* Header */}
        <div className="flex items-center gap-3 px-4 py-3 shrink-0" style={{ borderBottom: '1px solid var(--c-border)' }}>
          <button onClick={onClose} className="p-1 rounded transition hover:bg-[var(--c-bg3)]" style={{ color: 'var(--c-text2)' }}>
            <X size={14} />
          </button>
          <div className="flex-1 min-w-0">
            <div className="text-[13px] font-semibold" style={{ color: 'var(--c-white)' }}>{title}</div>
            {subtitle && (
              <div className="text-[11px] capitalize" style={{ color: 'var(--c-text2)', fontFamily: MONO }}>{subtitle}</div>
            )}
          </div>
        </div>

        {/* Content */}
        <div ref={scrollRef} className="flex-1 overflow-y-auto scrollbar-thin px-4 py-3">
          {loading && (
            <div className="text-[12px] py-12 text-center" style={{ color: 'var(--c-text3)' }}>Loading…</div>
          )}
          {!loading && content === null && (
            <div className="text-[12px] py-12 text-center" style={{ color: 'var(--c-text3)' }}>File not found.</div>
          )}
          {!loading && content !== null && (
            <pre
              className="text-[11px] leading-relaxed whitespace-pre-wrap break-words"
              style={{ color: 'var(--c-text)', fontFamily: MONO }}
            >
              {content}
            </pre>
          )}
        </div>
      </div>
    </>
  )
}

// ============================================================
// Config popover
// ============================================================

const CONFIG_LABELS = {
  mode: 'Mode',
  model_profile: 'Model profile',
  granularity: 'Granularity',
  parallelization: 'Parallelization',
  commit_docs: 'Commit docs',
}

const WORKFLOW_LABELS = {
  research: 'Research',
  plan_check: 'Plan check',
  verifier: 'Verifier',
  nyquist_validation: 'Nyquist',
  auto_advance: 'Auto advance',
  ui_phase: 'UI phase',
  skip_discuss: 'Skip discuss',
}

function ConfigPopover({ folder, anchor, onClose }) {
  const [config, setConfig] = useState(undefined)
  const ref = useRef(null)

  useEffect(() => {
    fetchGSDConfig(folder).then(setConfig).catch(() => setConfig(null))
  }, [folder])

  useEffect(() => {
    function handleClick(e) {
      if (ref.current && !ref.current.contains(e.target)) onClose()
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [onClose])

  // Position fixed relative to the anchor button rect
  const top = anchor ? anchor.bottom + 6 : 0
  const right = anchor ? window.innerWidth - anchor.right : 0

  function val(v) {
    if (v === true) return <span style={{ color: '#22c55e' }}>on</span>
    if (v === false) return <span style={{ color: 'var(--c-text3)' }}>off</span>
    return <span style={{ color: 'var(--c-white)' }}>{String(v)}</span>
  }

  return (
    <div
      ref={ref}
      className="p-3 shadow-xl text-[11px]"
      style={{
        position: 'fixed',
        top,
        right,
        zIndex: 9999,
        width: 240,
        background: 'var(--c-bg)',
        border: '1px solid var(--c-border)',
        boxShadow: '0 8px 32px rgba(0,0,0,0.4)',
      }}
      onClick={e => e.stopPropagation()}
    >
      {config === undefined && (
        <div style={{ color: 'var(--c-text3)' }}>Loading…</div>
      )}
      {config === null && (
        <div style={{ color: 'var(--c-text3)' }}>No config.json found.</div>
      )}
      {config && (
        <div className="space-y-2">
          {/* Top-level settings */}
          <div className="space-y-1">
            {Object.entries(CONFIG_LABELS).map(([k, label]) => {
              if (!(k in config)) return null
              return (
                <div key={k} className="flex items-center justify-between gap-2">
                  <span style={{ color: 'var(--c-text2)' }}>{label}</span>
                  {val(config[k])}
                </div>
              )
            })}
          </div>
          {/* Workflow toggles */}
          {config.workflow && (
            <>
              <div className="border-t pt-2" style={{ borderColor: 'var(--c-border)', color: 'var(--c-text3)' }}>workflow</div>
              <div className="grid grid-cols-2 gap-x-3 gap-y-1">
                {Object.entries(WORKFLOW_LABELS).map(([k, label]) => {
                  if (!(k in config.workflow)) return null
                  return (
                    <div key={k} className="flex items-center justify-between gap-1">
                      <span style={{ color: 'var(--c-text2)' }}>{label}</span>
                      {val(config.workflow[k])}
                    </div>
                  )
                })}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  )
}

// ============================================================
// Phase row
// ============================================================

function PhaseRow({ phase, tokenData, onOpenFile }) {
  // Phase comes from SQLite cache — flat fields (total_tasks, completed_tasks, has_plan, etc.)
  const totalTasks = phase.total_tasks ?? 0
  const completedTasks = phase.completed_tasks ?? 0
  const hasPlan = !!phase.has_plan
  const hasResearch = !!phase.has_research
  const hasVerification = !!phase.has_verification
  const status = phase.status ?? 'planned'

  const StatusIcon = status === 'completed'
    ? CheckCircle2
    : status === 'executing'
      ? Loader2
      : Circle

  return (
    <div
      className="flex items-center px-3 py-2 border-b text-[12px] hover:bg-[var(--c-bg3)] transition"
      style={{ borderColor: 'var(--c-border)', gap: 0 }}
    >
      {/* Status icon — 28px */}
      <div style={{ width: 28, flexShrink: 0 }}>
        <StatusIcon
          size={12}
          style={{ color: statusColor(status) }}
          className={status === 'executing' ? 'animate-spin' : ''}
        />
      </div>

      {/* Phase number — 32px */}
      <div style={{ width: 32, flexShrink: 0 }}>
        <span className="text-[10px] font-bold tabular-nums" style={{ color: 'var(--c-text3)', fontFamily: MONO }}>
          {phase.phase_number ?? '?'}
        </span>
      </div>

      {/* Phase name — flex-1 */}
      <div className="flex-1 min-w-0 pr-3">
        <span className="block truncate capitalize text-[12px]" style={{ color: 'var(--c-white)' }}>
          {phase.phase_name}
        </span>
      </div>

      {/* Progress bar — always 100px */}
      <div style={{ width: 100, flexShrink: 0, paddingRight: 12 }}>
        {totalTasks > 0
          ? <ProgressBar value={completedTasks} total={totalTasks} color={statusColor(status)} />
          : null}
      </div>

      {/* Artifacts — always 88px */}
      <div style={{ width: 88, flexShrink: 0 }} className="flex items-center gap-1">
        {hasPlan && (
          <button
            onClick={() => onOpenFile(phase, 'plan')}
            className="flex items-center gap-1 px-1.5 py-px text-[10px] transition hover:opacity-80 cursor-pointer"
            style={{ background: 'rgba(99,102,241,0.12)', color: '#818cf8' }}
            title="View PLAN.md"
          >
            <FileText size={9} />
            plan
          </button>
        )}
        {hasResearch && (
          <button
            onClick={() => onOpenFile(phase, 'research')}
            className="px-1 py-px transition hover:opacity-80 cursor-pointer"
            style={{ background: 'rgba(245,158,11,0.1)', color: '#f59e0b' }}
            title="View RESEARCH.md"
          >
            <BookOpen size={9} />
          </button>
        )}
        {hasVerification && (
          <button
            onClick={() => onOpenFile(phase, 'verification')}
            className="px-1 py-px transition hover:opacity-80 cursor-pointer"
            style={{ background: 'rgba(34,197,94,0.1)', color: '#22c55e' }}
            title="View VERIFICATION.md"
          >
            <ShieldCheck size={9} />
          </button>
        )}
      </div>

      {/* Est. cost — always 64px */}
      <div style={{ width: 64, flexShrink: 0, textAlign: 'right' }}>
        {tokenData && tokenData.cost > 0 ? (
          <span className="text-[10px] tabular-nums" style={{ color: 'var(--c-text2)', fontFamily: MONO }}>
            {formatCost(tokenData.cost)}
          </span>
        ) : null}
      </div>

      {/* Time — always 56px */}
      <div style={{ width: 56, flexShrink: 0, textAlign: 'right' }}>
        <span className="text-[10px]" style={{ color: 'var(--c-text3)' }}>
          {formatRelativeTime(phase.last_modified)}
        </span>
      </div>
    </div>
  )
}

// ============================================================
// Project card
// ============================================================

function projectBorderColor(project) {
  if (project.total_phases === 0) return 'var(--c-border)'
  if (project.completed_phases === project.total_phases) return '#22c55e'
  if (project.completed_phases > 0) return '#f59e0b'
  return 'var(--c-border)'
}

function ProjectCard({ project, isExpanded, onToggle, onOpenFile, onOpenConfig, onOpenState }) {
  const [phases, setPhases] = useState(null)
  const [tokenMap, setTokenMap] = useState(null) // phase id → token data
  const configBtnRef = useRef(null)
  const stateBtnRef = useRef(null)
  const pct = project.total_phases > 0
    ? Math.round((project.completed_phases / project.total_phases) * 100)
    : 0
  const remaining = project.total_phases - project.completed_phases

  useEffect(() => {
    if (isExpanded && phases === null) {
      fetchGSDPhases(project.folder).then(setPhases)
      fetchGSDPhaseTokens(project.folder).then(rows => {
        const map = {}
        for (const r of rows) map[r.id] = r
        setTokenMap(map)
      }).catch(() => setTokenMap({}))
    }
  }, [isExpanded, phases, project.folder])

  return (
    <div
      className="card overflow-hidden"
      style={{ borderLeft: `2px solid ${projectBorderColor(project)}` }}
    >
      <div className="flex items-center w-full px-3 py-3" style={{ gap: 0 }}>
        {/* Chevron — 24px */}
        <button
          onClick={onToggle}
          className="flex items-center justify-center hover:bg-[var(--c-bg3)] transition rounded cursor-pointer"
          style={{ width: 24, height: 24, flexShrink: 0, color: 'var(--c-text3)' }}
        >
          {isExpanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        </button>

        {/* Name — flex-1, clickable */}
        <button
          onClick={onToggle}
          className="flex-1 min-w-0 text-left px-2 cursor-pointer"
        >
          <div className="flex items-center gap-2">
            <span className="text-[13px] font-semibold truncate" style={{ color: 'var(--c-white)' }}>
              {project.name}
            </span>
            {project.milestone && (
              <span className="text-[10px] px-1.5 py-px shrink-0" style={{ background: 'rgba(99,102,241,0.12)', color: '#818cf8' }}>
                {project.milestone}
              </span>
            )}
          </div>
          <div className="text-[10px] truncate mt-0.5" style={{ color: 'var(--c-text3)', fontFamily: MONO }}>
            {project.folder}
          </div>
        </button>

        {/* % — 36px */}
        <div style={{ width: 36, flexShrink: 0, textAlign: 'right' }}>
          <span
            className="text-[11px] font-bold tabular-nums"
            style={{ color: pct === 100 ? '#22c55e' : pct > 0 ? '#f59e0b' : 'var(--c-text3)', fontFamily: MONO }}
          >
            {pct}%
          </span>
        </div>

        {/* Progress bar — 112px */}
        <div style={{ width: 112, flexShrink: 0, padding: '0 10px' }}>
          <ProgressBar
            value={project.completed_phases}
            total={project.total_phases}
            color={pct === 100 ? '#22c55e' : '#6366f1'}
          />
        </div>

        {/* Status pills — 80px */}
        <div style={{ width: 80, flexShrink: 0 }} className="flex items-center gap-1">
          {project.completed_phases > 0 && (
            <span className="flex items-center gap-1 text-[10px] px-1.5 py-px" style={{ background: 'rgba(34,197,94,0.08)', color: '#22c55e' }}>
              <CheckCircle2 size={9} /> {project.completed_phases}
            </span>
          )}
          {remaining > 0 && (
            <span className="flex items-center gap-1 text-[10px] px-1.5 py-px" style={{ background: 'rgba(255,255,255,0.04)', color: 'var(--c-text3)' }}>
              <Circle size={9} /> {remaining}
            </span>
          )}
        </div>

        {/* Counters — 52px */}
        <div style={{ width: 52, flexShrink: 0 }} className="flex items-center gap-2">
          {project.todos > 0 && (
            <span className="flex items-center gap-1 text-[10px]" style={{ color: 'var(--c-text3)' }} title="Todos / Seeds">
              <ListTodo size={10} /> {project.todos}
            </span>
          )}
          {project.notes > 0 && (
            <span className="flex items-center gap-1 text-[10px]" style={{ color: 'var(--c-text3)' }} title="Quick tasks">
              <StickyNote size={10} /> {project.notes}
            </span>
          )}
        </div>

        {/* Est. cost — 60px */}
        <div style={{ width: 60, flexShrink: 0, textAlign: 'right' }}>
          <span className="text-[11px] tabular-nums" style={{ color: project.total_cost > 0 ? '#a78bfa' : 'var(--c-text3)', fontFamily: MONO }}>
            {project.total_cost > 0 ? formatCost(project.total_cost) : '—'}
          </span>
        </div>

        {/* Updated — 56px */}
        <div style={{ width: 56, flexShrink: 0, textAlign: 'right' }}>
          <span className="text-[10px]" style={{ color: 'var(--c-text3)' }}>
            {formatRelativeTime(project.last_modified)}
          </span>
        </div>

        {/* State + Config buttons — 52px */}
        <div style={{ width: 52, flexShrink: 0 }} className="flex items-center justify-end gap-0.5" onClick={e => e.stopPropagation()}>
          <button
            ref={stateBtnRef}
            onClick={() => onOpenState(project.folder, project.name)}
            className="p-1 rounded transition hover:bg-[var(--c-bg3)] cursor-pointer"
            style={{ color: 'var(--c-text3)' }}
            title="View STATE.md"
          >
            <Layers size={13} />
          </button>
          <button
            ref={configBtnRef}
            onClick={() => onOpenConfig(project.folder, configBtnRef.current?.getBoundingClientRect())}
            className="p-1 rounded transition hover:bg-[var(--c-bg3)] cursor-pointer"
            style={{ color: 'var(--c-text3)' }}
            title="GSD config"
          >
            <HelpCircle size={13} />
          </button>
        </div>
      </div>

      {isExpanded && (
        <div className="border-t" style={{ borderColor: 'var(--c-border)' }}>
          <div
            className="flex items-center px-3 py-1 text-[10px]"
            style={{ background: 'var(--c-bg2)', color: 'var(--c-text3)', gap: 0 }}
          >
            <div style={{ width: 28, flexShrink: 0 }} />
            <div style={{ width: 32, flexShrink: 0 }}>#</div>
            <div className="flex-1 pr-3">phase</div>
            <div style={{ width: 100, flexShrink: 0, paddingRight: 12 }}>plans</div>
            <div style={{ width: 88, flexShrink: 0 }}>artifacts</div>
            <div style={{ width: 64, flexShrink: 0, textAlign: 'right' }}>est. cost</div>
            <div style={{ width: 56, flexShrink: 0, textAlign: 'right' }}>updated</div>
          </div>

          {phases === null
            ? <div className="px-4 py-3 text-[12px]" style={{ color: 'var(--c-text3)' }}>Loading phases…</div>
            : phases.length === 0
              ? <div className="px-4 py-3 text-[12px]" style={{ color: 'var(--c-text3)' }}>No phases found.</div>
              : phases.map(phase => (
                <PhaseRow
                  key={phase.id}
                  phase={phase}
                  tokenData={tokenMap?.[phase.id] ?? null}
                  onOpenFile={(ph, type) => onOpenFile(ph, project.folder, type)}
                />
              ))
          }
        </div>
      )}
    </div>
  )
}

// ============================================================
// Main page
// ============================================================

export default function GSD() {
  const { dark } = useTheme()
  const [projects, setProjects] = useState(null)
  const [overview, setOverview] = useState(null)
  const [allTokens, setAllTokens] = useState(null) // { totalCost }
  const [expandedFolder, setExpandedFolder] = useState(null)
  const [fileSidebar, setFileSidebar] = useState(null) // { title, subtitle, content, loading }
  const [configPopover, setConfigPopover] = useState(null) // { folder, anchor }
  const [loading, setLoading] = useState(true)

  const txtColor = dark ? '#888' : '#555'
  const txtDim = dark ? '#555' : '#999'
  const gridColor = dark ? 'rgba(255,255,255,0.03)' : 'rgba(0,0,0,0.06)'

  useEffect(() => {
    Promise.all([fetchGSDProjects(), fetchGSDOverview()])
      .then(([p, o]) => {
        setProjects(p)
        setOverview(o)
        setLoading(false)
        // total_cost is already computed server-side per project
        const totalCost = (p || []).reduce((s, proj) => s + (proj.total_cost || 0), 0)
        setAllTokens({ totalCost })
      })
      .catch(() => setLoading(false))
  }, [])

  function handleOpenConfig(folder, anchor) {
    setConfigPopover(prev => prev?.folder === folder ? null : { folder, anchor })
  }

  function handleOpenFile(phase, folder, type) {
    const phaseDir = phase.id?.split('::')?.[1] || ''
    const phaseName = phase.phase_name ?? phase.name ?? ''
    const titles = { plan: 'PLAN.md', research: 'RESEARCH.md', verification: 'VERIFICATION.md', summary: 'SUMMARY.md' }
    const title = titles[type] ?? type.toUpperCase() + '.md'

    setFileSidebar({ title, subtitle: phaseName, content: null, loading: true })

    if (type === 'plan') {
      fetchGSDPlan(folder, phaseDir)
        .then(d => setFileSidebar(prev => prev ? { ...prev, content: d?.content ?? null, loading: false } : null))
        .catch(() => setFileSidebar(prev => prev ? { ...prev, loading: false } : null))
    } else {
      fetchGSDFile(folder, type, phaseDir)
        .then(d => setFileSidebar(prev => prev ? { ...prev, content: d?.content ?? null, loading: false } : null))
        .catch(() => setFileSidebar(prev => prev ? { ...prev, loading: false } : null))
    }
  }

  function handleOpenState(folder, projectName) {
    setFileSidebar({ title: 'STATE.md', subtitle: projectName, content: null, loading: true })
    fetchGSDFile(folder, 'state')
      .then(d => setFileSidebar(prev => prev ? { ...prev, content: d?.content ?? null, loading: false } : null))
      .catch(() => setFileSidebar(prev => prev ? { ...prev, loading: false } : null))
  }

  if (loading) return <AnimatedLoader label="Loading GSD projects..." />

  if (!projects || projects.length === 0) {
    return (
      <div className="fade-in space-y-3">
        <PageHeader icon={Target} title="GSD Workflow" />
        <div className="card p-8 text-center space-y-3">
          <Target size={32} style={{ color: 'var(--c-text3)', margin: '0 auto' }} />
          <div className="text-[14px] font-semibold" style={{ color: 'var(--c-white)' }}>No GSD projects found</div>
          <div className="text-[12px] max-w-sm mx-auto" style={{ color: 'var(--c-text2)' }}>
            GSD (Get Shit Done) is a structured AI workflow system that stores project plans and phases
            inside a <code style={{ fontFamily: MONO }}>.planning/</code> directory. Run a data scan after
            initializing a GSD project and it will appear here.
          </div>
        </div>
      </div>
    )
  }

  const completionRate = overview && overview.totalPhases > 0
    ? Math.round((overview.completedPhases / overview.totalPhases) * 100)
    : 0

  const phaseStatuses = {
    completed: overview?.completedPhases ?? 0,
    executing: overview?.executingPhases ?? 0,
    planned: overview?.plannedPhases ?? 0,
  }

  const statusDonutData = {
    labels: ['Completed', 'Executing', 'Planned'],
    datasets: [{
      data: [phaseStatuses.completed, phaseStatuses.executing, phaseStatuses.planned],
      backgroundColor: ['#22c55e', '#f59e0b', 'rgba(255,255,255,0.08)'],
      borderWidth: 0,
    }],
  }

  const topProjects = [...projects].sort((a, b) => b.total_phases - a.total_phases).slice(0, 8)
  const projectBarData = {
    labels: topProjects.map(p => p.name.length > 16 ? p.name.slice(0, 15) + '…' : p.name),
    datasets: [
      {
        label: 'Completed',
        data: topProjects.map(p => p.completed_phases),
        backgroundColor: '#22c55e',
        borderRadius: 2,
      },
      {
        label: 'Remaining',
        data: topProjects.map(p => p.total_phases - p.completed_phases),
        backgroundColor: 'rgba(99,102,241,0.3)',
        borderRadius: 2,
      },
    ],
  }

  const donutOpts = {
    responsive: true, maintainAspectRatio: false, cutout: '72%',
    plugins: {
      legend: { display: false },
      tooltip: { bodyFont: { family: MONO, size: 10 }, titleFont: { family: MONO, size: 10 } },
    },
  }

  const barOpts = {
    responsive: true, maintainAspectRatio: false, indexAxis: 'y',
    scales: {
      x: { stacked: true, grid: { color: gridColor }, ticks: { color: txtDim, font: { size: 8, family: MONO } } },
      y: { stacked: true, grid: { display: false }, ticks: { color: txtColor, font: { size: 8, family: MONO } } },
    },
    plugins: {
      legend: { display: false },
      tooltip: { bodyFont: { family: MONO, size: 10 }, titleFont: { family: MONO, size: 10 } },
    },
  }

  return (
    <div className="fade-in space-y-3">
      <PageHeader icon={Target} title="GSD Workflow" />

      {/* KPIs */}
      <div className="grid gap-2" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(90px, 1fr))' }}>
        <KpiCard label="projects" value={overview?.totalProjects ?? projects.length} />
        <KpiCard label="total phases" value={overview?.totalPhases ?? '—'} />
        <KpiCard label="completed" value={overview?.completedPhases ?? '—'} />
        <KpiCard label="completion" value={overview?.totalPhases > 0 ? `${completionRate}%` : '—'} />
        <KpiCard label="total cost" value={allTokens ? formatCost(allTokens.totalCost) : '—'} />
      </div>

      {/* Charts */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
        <div className="card p-3">
          <SectionTitle>phase status</SectionTitle>
          <div className="flex items-center gap-4">
            <div style={{ height: 110, width: 110, flexShrink: 0 }}>
              <Doughnut data={statusDonutData} options={donutOpts} />
            </div>
            <div className="space-y-2 text-[11px]">
              {[
                { label: 'Completed', count: phaseStatuses.completed, color: '#22c55e' },
                { label: 'Executing', count: phaseStatuses.executing, color: '#f59e0b' },
                { label: 'Planned', count: phaseStatuses.planned, color: 'var(--c-text3)' },
              ].map(({ label, count, color }) => (
                <div key={label} className="flex items-center gap-2">
                  <span className="w-2 h-2 rounded-full shrink-0" style={{ background: color }} />
                  <span style={{ color: 'var(--c-text2)' }}>{label}</span>
                  <span className="ml-auto font-bold tabular-nums" style={{ color, fontFamily: MONO }}>{count}</span>
                </div>
              ))}
            </div>
          </div>
        </div>

        <div className="card p-3 lg:col-span-2">
          <SectionTitle>projects <span style={{ color: 'var(--c-text3)' }}>by phases</span></SectionTitle>
          <div style={{ height: 130 }}>
            <Bar data={projectBarData} options={barOpts} />
          </div>
          <div className="flex items-center gap-4 mt-2 text-[10px]" style={{ color: 'var(--c-text3)' }}>
            <span className="flex items-center gap-1.5"><span className="inline-block w-2 h-2 rounded-sm" style={{ background: '#22c55e' }} /> Completed</span>
            <span className="flex items-center gap-1.5"><span className="inline-block w-2 h-2 rounded-sm" style={{ background: 'rgba(99,102,241,0.3)' }} /> Remaining</span>
          </div>
        </div>
      </div>

      {/* Project cards */}
      <div className="space-y-2">
        <SectionTitle>projects</SectionTitle>
        {projects.map(project => (
          <ProjectCard
            key={project.folder}
            project={project}
            isExpanded={expandedFolder === project.folder}
            onToggle={() => setExpandedFolder(prev => prev === project.folder ? null : project.folder)}
            onOpenFile={handleOpenFile}
            onOpenConfig={handleOpenConfig}
            onOpenState={handleOpenState}
          />
        ))}
      </div>

      {/* Config popover — rendered at page level to escape overflow-hidden */}
      {configPopover && (
        <ConfigPopover
          folder={configPopover.folder}
          anchor={configPopover.anchor}
          onClose={() => setConfigPopover(null)}
        />
      )}

      {/* File sidebar */}
      {fileSidebar && (
        <FileSidebar
          title={fileSidebar.title}
          subtitle={fileSidebar.subtitle}
          content={fileSidebar.content}
          loading={fileSidebar.loading}
          onClose={() => setFileSidebar(null)}
        />
      )}
    </div>
  )
}
