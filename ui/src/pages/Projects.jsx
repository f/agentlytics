import { useState, useEffect } from 'react'
import { Chart as ChartJS, ArcElement, Tooltip, Legend, CategoryScale, LinearScale, BarElement } from 'chart.js'
import { Doughnut, Bar } from 'react-chartjs-2'
import { Search, MessageSquare, Wrench, Cpu, FolderOpen, Calendar } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import { fetchProjects } from '../lib/api'
import { editorColor, editorLabel, formatNumber, formatDate, dateRangeToApiParams } from '../lib/constants'
import { useTheme } from '../lib/theme'
import KpiCard from '../components/KpiCard'
import EditorIcon from '../components/EditorIcon'
import DateRangePicker from '../components/DateRangePicker'
import SectionTitle from '../components/SectionTitle'

ChartJS.register(ArcElement, Tooltip, Legend, CategoryScale, LinearScale, BarElement)

const MONO = 'JetBrains Mono, monospace'
const MODEL_COLORS = ['#6366f1', '#a78bfa', '#818cf8', '#c084fc', '#e879f9', '#f472b6', '#fb7185', '#f87171', '#fbbf24', '#34d399']

export default function Projects({ overview }) {
  const { dark } = useTheme()
  const txtColor = dark ? '#888' : '#555'
  const txtDim = dark ? '#555' : '#999'
  const gridColor = dark ? 'rgba(255,255,255,0.03)' : 'rgba(0,0,0,0.06)'
  const [projects, setProjects] = useState(null)
  const [search, setSearch] = useState('')
  const [editorFilter, setEditorFilter] = useState('')
  const [dateRange, setDateRange] = useState(null)
  const navigate = useNavigate()
  const editors = overview?.editors || []

  useEffect(() => {
    fetchProjects(dateRangeToApiParams(dateRange)).then(setProjects)
  }, [dateRange])

  if (!projects) return <div className="text-sm py-12 text-center" style={{ color: 'var(--c-text2)' }}>loading projects...</div>

  const filtered = projects.filter(p => {
    if (editorFilter && !p.editors[editorFilter]) return false
    if (search && !p.folder.toLowerCase().includes(search.toLowerCase()) && !p.name.toLowerCase().includes(search.toLowerCase())) return false
    return true
  })

  const totalSessions = projects.reduce((s, p) => s + p.totalSessions, 0)
  const totalMessages = projects.reduce((s, p) => s + p.totalMessages, 0)
  const totalTokens = projects.reduce((s, p) => s + p.totalInputTokens + p.totalOutputTokens, 0)
  const maxSessions = Math.max(...projects.map(p => p.totalSessions), 1)

  // Aggregate for charts
  const globalModels = {}
  const globalEditors = {}
  for (const p of projects) {
    for (const m of p.topModels) globalModels[m.name] = (globalModels[m.name] || 0) + m.count
    for (const [e, c] of Object.entries(p.editors)) globalEditors[e] = (globalEditors[e] || 0) + c
  }
  const topGlobalModels = Object.entries(globalModels).sort((a, b) => b[1] - a[1]).slice(0, 8)
  const topGlobalEditors = Object.entries(globalEditors).sort((a, b) => b[1] - a[1])
  const top10 = projects.slice(0, 10)

  return (
    <div className="fade-in space-y-4">
      {/* KPIs */}
      <div className="grid gap-2" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(90px, 1fr))' }}>
        <KpiCard label="projects" value={projects.length} />
        <KpiCard label="sessions" value={formatNumber(totalSessions)} onClick={() => navigate('/sessions')} />
        <KpiCard label="messages" value={formatNumber(totalMessages)} />
        <KpiCard label="tokens" value={formatNumber(totalTokens)} />
      </div>

      {/* Charts row */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
        <div className="card p-3">
          <SectionTitle>top projects <span style={{ color: 'var(--c-text3)' }}>by sessions</span></SectionTitle>
          <div style={{ height: 160 }}>
            <Bar
              data={{
                labels: top10.map(p => p.name),
                datasets: [{
                  data: top10.map(p => p.totalSessions),
                  backgroundColor: '#6366f1',
                  borderRadius: 3,
                }],
              }}
              options={{
                responsive: true, maintainAspectRatio: false, indexAxis: 'y',
                scales: {
                  x: { grid: { color: gridColor }, ticks: { color: txtDim, font: { size: 8, family: MONO } } },
                  y: { grid: { display: false }, ticks: { color: txtColor, font: { size: 8, family: MONO }, callback: (v, i) => top10[i]?.name?.length > 16 ? top10[i].name.slice(0, 15) + '…' : top10[i]?.name } },
                },
                plugins: { legend: { display: false }, tooltip: { bodyFont: { family: MONO, size: 10 }, titleFont: { family: MONO, size: 10 } } },
              }}
            />
          </div>
        </div>
        <div className="card p-3">
          <SectionTitle>editors</SectionTitle>
          <div style={{ height: 160 }}>
            <Doughnut
              data={{
                labels: topGlobalEditors.map(e => editorLabel(e[0])),
                datasets: [{ data: topGlobalEditors.map(e => e[1]), backgroundColor: topGlobalEditors.map(e => editorColor(e[0])), borderWidth: 0 }],
              }}
              options={{
                responsive: true, maintainAspectRatio: false, cutout: '60%',
                plugins: {
                  legend: { position: 'right', labels: { color: txtColor, font: { size: 9, family: MONO }, usePointStyle: true, pointStyle: 'circle', padding: 6 } },
                  tooltip: { bodyFont: { family: MONO, size: 10 }, titleFont: { family: MONO, size: 10 } },
                },
              }}
            />
          </div>
        </div>
        <div className="card p-3">
          <SectionTitle>models</SectionTitle>
          <div style={{ height: 160 }}>
            {topGlobalModels.length > 0 ? (
              <Doughnut
                data={{
                  labels: topGlobalModels.map(m => m[0]),
                  datasets: [{ data: topGlobalModels.map(m => m[1]), backgroundColor: MODEL_COLORS, borderWidth: 0 }],
                }}
                options={{
                  responsive: true, maintainAspectRatio: false, cutout: '60%',
                  plugins: {
                    legend: { position: 'right', labels: { color: txtColor, font: { size: 9, family: MONO }, usePointStyle: true, pointStyle: 'circle', padding: 6 } },
                    tooltip: { bodyFont: { family: MONO, size: 10 }, titleFont: { family: MONO, size: 10 } },
                  },
                }}
              />
            ) : <div className="text-xs text-center py-12" style={{ color: 'var(--c-text3)' }}>no model data</div>}
          </div>
        </div>
      </div>

      {/* Filters */}
      <div className="flex items-center gap-2">
        <select
          value={editorFilter}
          onChange={e => setEditorFilter(e.target.value)}
          className="px-2 py-1.5 text-[12px] outline-none rounded-sm"
          style={{ background: 'var(--c-bg3)', color: 'var(--c-text)', border: '1px solid var(--c-border)' }}
        >
          <option value="">All Editors</option>
          {editors.map(e => (
            <option key={e.id} value={e.id}>{editorLabel(e.id)}</option>
          ))}
        </select>
        <div className="relative max-w-sm flex-1">
          <Search size={13} className="absolute left-3 top-1/2 -translate-y-1/2" style={{ color: 'var(--c-text3)' }} />
          <input
            type="text"
            placeholder="search projects..."
            value={search}
            onChange={e => setSearch(e.target.value)}
            className="w-full pl-8 pr-3 py-1.5 text-[12px] outline-none rounded-sm"
            style={{ background: 'var(--c-bg3)', color: 'var(--c-text)', border: '1px solid var(--c-border)' }}
          />
        </div>
        <div className="ml-auto"><DateRangePicker value={dateRange} onChange={setDateRange} /></div>
      </div>

      {/* Project cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
        {filtered.map(p => {
          const editorEntries = Object.entries(p.editors).sort((a, b) => b[1] - a[1])
          const totalTok = p.totalInputTokens + p.totalOutputTokens
          const topModel = p.topModels[0]

          return (
            <div
              key={p.folder}
              className="card p-3 cursor-pointer transition hover:opacity-90 flex flex-col gap-2.5"
              onClick={() => navigate(`/projects/detail?folder=${encodeURIComponent(p.folder)}`)}
            >
              {/* Header: name + editors */}
              <div className="flex items-start gap-2 min-w-0">
                <FolderOpen size={14} className="flex-shrink-0 mt-0.5" style={{ color: 'var(--c-accent)' }} />
                <div className="flex-1 min-w-0">
                  <div className="text-[12px] font-bold truncate" style={{ color: 'var(--c-white)' }}>{p.name}</div>
                  <div className="text-[10px] truncate" style={{ color: 'var(--c-text3)' }}>{p.folder}</div>
                </div>
                <div className="flex items-center gap-1 flex-shrink-0">
                  {editorEntries.slice(0, 4).map(([e]) => (
                    <EditorIcon key={e} source={e} size={12} />
                  ))}
                </div>
              </div>

              {/* Activity bar */}
              <div className="w-full h-1 rounded-full overflow-hidden" style={{ background: 'var(--c-code-bg)' }}>
                <div className="h-full rounded-full" style={{ width: `${(p.totalSessions / maxSessions * 100).toFixed(1)}%`, background: 'var(--c-accent)' }} />
              </div>

              {/* Stats grid */}
              <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-[11px]">
                <div className="flex items-center gap-1">
                  <MessageSquare size={9} style={{ color: 'var(--c-text3)' }} />
                  <span style={{ color: 'var(--c-text2)' }}>{p.totalSessions} sessions</span>
                  <span className="ml-auto font-bold" style={{ color: 'var(--c-white)' }}>{formatNumber(p.totalMessages)} msgs</span>
                </div>
                <div className="flex items-center gap-1">
                  <Wrench size={9} style={{ color: 'var(--c-text3)' }} />
                  <span style={{ color: 'var(--c-text2)' }}>tools</span>
                  <span className="ml-auto font-bold" style={{ color: 'var(--c-white)' }}>{formatNumber(p.totalToolCalls)}</span>
                </div>
                <div className="flex items-center gap-1">
                  <Cpu size={9} style={{ color: 'var(--c-text3)' }} />
                  <span className="truncate" style={{ color: 'var(--c-text2)' }}>{topModel ? topModel.name : '—'}</span>
                </div>
                <div className="flex items-center gap-1">
                  <span style={{ color: 'var(--c-text3)' }}>tok</span>
                  <span className="ml-auto font-bold" style={{ color: totalTok > 0 ? 'var(--c-white)' : 'var(--c-text3)' }}>{totalTok > 0 ? formatNumber(totalTok) : '—'}</span>
                </div>
              </div>

              {/* Footer: editors breakdown + date */}
              <div className="flex items-center gap-2 pt-1 text-[10px]" style={{ borderTop: '1px solid var(--c-border)' }}>
                <div className="flex items-center gap-1.5 flex-1 min-w-0">
                  {editorEntries.map(([e, c]) => (
                    <span key={e} className="inline-flex items-center gap-0.5 truncate">
                      <span className="w-1.5 h-1.5 rounded-full flex-shrink-0" style={{ background: editorColor(e) }} />
                      <span style={{ color: 'var(--c-text3)' }}>{editorLabel(e)}</span>
                      <span className="font-bold" style={{ color: 'var(--c-text2)' }}>{c}</span>
                    </span>
                  ))}
                </div>
                <div className="flex items-center gap-1 flex-shrink-0" style={{ color: 'var(--c-text3)' }}>
                  <Calendar size={8} />
                  <span>{formatDate(p.lastSeen)}</span>
                </div>
              </div>
            </div>
          )
        })}
      </div>

      {filtered.length === 0 && <div className="text-center py-12 text-sm" style={{ color: 'var(--c-text3)' }}>no projects found</div>}
    </div>
  )
}
