import { useState, useEffect, useMemo } from 'react'
import { useSearchParams, useNavigate } from 'react-router-dom'
import { ArrowLeft, Search, FolderOpen, Calendar, MessageSquare, Wrench, Cpu, Zap, AlertTriangle, ShieldCheck } from 'lucide-react'
import { Chart as ChartJS, ArcElement, Tooltip, Legend, CategoryScale, LinearScale, BarElement } from 'chart.js'
import { Doughnut, Bar } from 'react-chartjs-2'
import { fetchProjects, fetchChats, fetchCosts } from '../lib/api'
import { editorColor, editorLabel, formatNumber, formatDate, formatCost } from '../lib/constants'
import { useTheme } from '../lib/theme'
import KpiCard from '../components/KpiCard'
import EditorIcon from '../components/EditorIcon'
import SectionTitle from '../components/SectionTitle'
import ChatSidebar from '../components/ChatSidebar'
import AiAuditCard from '../components/AiAuditCard'

ChartJS.register(ArcElement, Tooltip, Legend, CategoryScale, LinearScale, BarElement)

const MONO = 'JetBrains Mono, monospace'
const MODEL_COLORS = ['#6366f1', '#a78bfa', '#818cf8', '#c084fc', '#e879f9', '#f472b6', '#fb7185', '#f87171', '#fbbf24', '#34d399']
const TOOL_COLORS = ['#10b981', '#34d399', '#6ee7b7', '#a7f3d0', '#d1fae5', '#ecfdf5', '#b8f0d8', '#7ce0b8', '#4ade80', '#22c55e']

export default function ProjectDetail() {
  const [searchParams] = useSearchParams()
  const navigate = useNavigate()
  const folder = searchParams.get('folder')
  const { dark } = useTheme()
  const txtColor = dark ? '#888' : '#555'
  const txtDim = dark ? '#555' : '#999'
  const gridColor = dark ? 'rgba(255,255,255,0.03)' : 'rgba(0,0,0,0.06)'

  const [project, setProject] = useState(null)
  const [chats, setChats] = useState([])
  const [loading, setLoading] = useState(true)
  const [chatSearch, setChatSearch] = useState('')
  const [selectedChatId, setSelectedChatId] = useState(null)
  const [costs, setCosts] = useState(null)
  const [enabledEditors, setEnabledEditors] = useState(null)

  useEffect(() => {
    if (!folder) return
    setLoading(true)
    Promise.all([
      fetchProjects(),
      fetchChats({ folder, limit: 1000 }),
      fetchCosts({ folder }),
    ]).then(([projects, chatData, costData]) => {
      const match = projects.find(p => p.folder === folder)
      setProject(match || null)
      setChats(chatData.chats || [])
      setCosts(costData)
      if (match) setEnabledEditors(new Set(Object.keys(match.editors)))
      setLoading(false)
    })
  }, [folder])

  const editorFilteredChats = useMemo(() => {
    if (!enabledEditors) return chats
    return chats.filter(c => enabledEditors.has(c.source))
  }, [chats, enabledEditors])

  const filteredChats = useMemo(() => {
    if (!chatSearch) return editorFilteredChats
    const q = chatSearch.toLowerCase()
    return editorFilteredChats.filter(c =>
      (c.name && c.name.toLowerCase().includes(q)) ||
      (c.topModel && c.topModel.toLowerCase().includes(q)) ||
      (c.source && c.source.toLowerCase().includes(q))
    )
  }, [editorFilteredChats, chatSearch])

  const toggleEditor = (editorId) => {
    setEnabledEditors(prev => {
      const next = new Set(prev)
      if (next.has(editorId)) next.delete(editorId)
      else next.add(editorId)
      return next
    })
  }

  if (!folder) return <div className="text-sm py-12 text-center" style={{ color: 'var(--c-text3)' }}>no project specified</div>
  if (loading) return <div className="text-sm py-12 text-center" style={{ color: 'var(--c-text2)' }}>loading project...</div>
  if (!project) return <div className="text-sm py-12 text-center" style={{ color: 'var(--c-text3)' }}>project not found</div>

  const editorEntries = Object.entries(project.editors).sort((a, b) => b[1] - a[1])
  const allEnabled = !enabledEditors || enabledEditors.size === editorEntries.length

  // Derive stats from editor-filtered chats
  const fSessionCount = editorFilteredChats.length
  const fEditorCounts = {}
  const fModelCounts = {}
  for (const c of editorFilteredChats) {
    fEditorCounts[c.source] = (fEditorCounts[c.source] || 0) + 1
    if (c.topModel) fModelCounts[c.topModel] = (fModelCounts[c.topModel] || 0) + 1
  }
  const fTopModels = Object.entries(fModelCounts).sort((a, b) => b[1] - a[1]).slice(0, 10)
  const fMaxEditorCount = Math.max(...Object.values(fEditorCounts), 1)

  // Use project-level stats when all editors enabled, otherwise show filtered session count
  const totalTok = project.totalInputTokens + project.totalOutputTokens
  const outputRatio = project.totalInputTokens > 0 ? (project.totalOutputTokens / project.totalInputTokens).toFixed(1) : '0'
  const displaySessions = allEnabled ? project.totalSessions : fSessionCount
  const avgMsgs = allEnabled && project.totalSessions > 0 ? (project.totalMessages / project.totalSessions).toFixed(1) : 0

  return (
    <div className="fade-in space-y-4">
      {/* Header card */}
      <div className="card p-4">
        <div className="flex items-start gap-3">
          <button
            onClick={() => navigate('/projects')}
            className="flex items-center gap-1 text-[12px] transition mt-0.5 flex-shrink-0"
            style={{ color: 'var(--c-text3)' }}
          >
            <ArrowLeft size={12} />
          </button>
          <FolderOpen size={18} className="flex-shrink-0 mt-0.5" style={{ color: 'var(--c-accent)' }} />
          <div className="flex-1 min-w-0">
            <h1 className="text-sm font-bold truncate" style={{ color: 'var(--c-white)' }}>{project.name}</h1>
            <div className="text-[11px] truncate" style={{ color: 'var(--c-text3)' }}>{project.folder}</div>
          </div>
          <div className="flex items-center gap-1.5 flex-shrink-0">
            {editorEntries.map(([e]) => (
              <EditorIcon key={e} source={e} size={14} />
            ))}
          </div>
        </div>
        <div className="flex items-center gap-4 mt-3 pt-3 text-[11px]" style={{ borderTop: '1px solid var(--c-border)' }}>
          <div className="flex items-center gap-1" style={{ color: 'var(--c-text3)' }}>
            <Calendar size={9} />
            <span>{formatDate(project.firstSeen)}</span>
            <span>→</span>
            <span>{formatDate(project.lastSeen)}</span>
          </div>
          <div className="flex items-center gap-1.5 ml-auto">
            {editorEntries.map(([e, c]) => (
              <span key={e} className="inline-flex items-center gap-0.5">
                <span className="w-1.5 h-1.5 rounded-full" style={{ background: editorColor(e) }} />
                <span style={{ color: 'var(--c-text3)' }}>{editorLabel(e)}</span>
                <span className="font-bold" style={{ color: 'var(--c-text2)' }}>{c}</span>
              </span>
            ))}
          </div>
        </div>
      </div>

      {/* KPIs */}
      <div className="grid gap-2" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(90px, 1fr))' }}>
        <KpiCard label="sessions" value={displaySessions} sub={!allEnabled ? 'filtered' : ''} />
        <KpiCard label="messages" value={formatNumber(project.totalMessages)} sub={`${avgMsgs} avg/session`} />
        <KpiCard label="tool calls" value={formatNumber(project.totalToolCalls)} sub={<span className="flex items-center gap-0.5"><Wrench size={8} /> invocations</span>} />
        <KpiCard label="tokens" value={formatNumber(totalTok)} sub={`${outputRatio}\u00d7 out/in`} />
        {project.totalCacheRead > 0 && (
          <KpiCard label="cache read" value={formatNumber(project.totalCacheRead)} sub={`write: ${formatNumber(project.totalCacheWrite)}`} />
        )}
        <KpiCard label="you wrote" value={formatNumber(project.totalUserChars)} sub={`AI: ${formatNumber(project.totalAssistantChars)}`} />
        <KpiCard label="est. cost" value={costs && costs.totalCost > 0 ? formatCost(costs.totalCost) : '\u2014'} sub={costs && costs.byModel.length > 0 ? `${costs.byModel.length} model${costs.byModel.length !== 1 ? 's' : ''}` : undefined} />
      </div>

      {/* Charts row */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
        {/* Editors bar with checkboxes */}
        <div className="card p-3">
          <SectionTitle>editors</SectionTitle>
          <div className="space-y-1.5 mt-1">
            {editorEntries.map(([e, c]) => {
              const checked = enabledEditors ? enabledEditors.has(e) : true
              const count = fEditorCounts[e] || 0
              return (
                <div key={e} className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => toggleEditor(e)}
                    className="accent-[var(--c-accent)] w-3 h-3 flex-shrink-0 cursor-pointer"
                  />
                  <EditorIcon source={e} size={11} />
                  <span className="text-[11px] truncate flex-1 cursor-pointer select-none" onClick={() => toggleEditor(e)} style={{ color: checked ? 'var(--c-text2)' : 'var(--c-text3)', opacity: checked ? 1 : 0.4 }}>{editorLabel(e)}</span>
                  <div className="w-16 h-3 rounded-sm overflow-hidden" style={{ background: 'var(--c-code-bg)' }}>
                    <div className="h-full rounded-sm transition-all" style={{ width: `${(count / fMaxEditorCount * 100).toFixed(0)}%`, background: checked ? editorColor(e) : 'var(--c-text3)', opacity: checked ? 1 : 0.2 }} />
                  </div>
                  <span className="text-[11px] w-6 text-right font-bold" style={{ color: checked ? 'var(--c-white)' : 'var(--c-text3)', opacity: checked ? 1 : 0.4 }}>{count}</span>
                </div>
              )
            })}
          </div>
        </div>

        {/* Models doughnut */}
        <div className="card p-3">
          <SectionTitle>models</SectionTitle>
          {fTopModels.length > 0 ? (
            <div style={{ height: 160 }}>
              <Doughnut
                data={{
                  labels: fTopModels.map(m => m[0]),
                  datasets: [{ data: fTopModels.map(m => m[1]), backgroundColor: MODEL_COLORS, borderWidth: 0 }],
                }}
                options={{
                  responsive: true, maintainAspectRatio: false, cutout: '60%',
                  plugins: {
                    legend: { position: 'right', labels: { color: txtColor, font: { size: 8, family: MONO }, usePointStyle: true, pointStyle: 'circle', padding: 6 } },
                    tooltip: { bodyFont: { family: MONO, size: 10 }, titleFont: { family: MONO, size: 10 } },
                  },
                }}
              />
            </div>
          ) : <div className="text-[11px] py-8 text-center" style={{ color: 'var(--c-text3)' }}>no model data</div>}
        </div>

        {/* Top tools horizontal bar */}
        <div className="card p-3">
          <SectionTitle>top tools <span style={{ color: 'var(--c-text3)' }}>({formatNumber(project.totalToolCalls)})</span></SectionTitle>
          {project.topTools.length > 0 ? (
            <div style={{ height: 160 }}>
              <Bar
                data={{
                  labels: project.topTools.map(t => t.name),
                  datasets: [{
                    data: project.topTools.map(t => t.count),
                    backgroundColor: TOOL_COLORS.slice(0, project.topTools.length),
                    borderRadius: 2,
                  }],
                }}
                options={{
                  responsive: true, maintainAspectRatio: false, indexAxis: 'y',
                  scales: {
                    x: { grid: { color: gridColor }, ticks: { color: txtDim, font: { size: 8, family: MONO } } },
                    y: { grid: { display: false }, ticks: { color: txtColor, font: { size: 8, family: MONO } } },
                  },
                  plugins: { legend: { display: false }, tooltip: { bodyFont: { family: MONO, size: 10 }, titleFont: { family: MONO, size: 10 } } },
                }}
              />
            </div>
          ) : <div className="text-[11px] py-8 text-center" style={{ color: 'var(--c-text3)' }}>no tool data</div>}
        </div>
      </div>

      {/* AI Readiness Audit */}
      {console.log('Rendering AiAuditCard, folder:', folder)}
      <AiAuditCard folder={folder} />

      {/* Sessions */}
      <div>
        <div className="flex items-center gap-3 mb-2">
          <SectionTitle>sessions <span style={{ color: 'var(--c-text3)' }}>({filteredChats.length}{!allEnabled ? ` of ${chats.length}` : ''})</span></SectionTitle>
          <div className="relative max-w-xs flex-1">
            <Search size={11} className="absolute left-2.5 top-1/2 -translate-y-1/2" style={{ color: 'var(--c-text3)' }} />
            <input
              type="text"
              placeholder="filter sessions..."
              value={chatSearch}
              onChange={e => setChatSearch(e.target.value)}
              className="w-full pl-7 pr-3 py-1 text-[12px] outline-none rounded-sm"
              style={{ background: 'var(--c-bg3)', color: 'var(--c-text)', border: '1px solid var(--c-border)' }}
            />
          </div>
        </div>

        <div className="card overflow-hidden">
          <table className="w-full text-[12px]">
            <thead>
              <tr className="text-[10px] uppercase tracking-wider" style={{ borderBottom: '1px solid var(--c-border)', color: 'var(--c-text3)' }}>
                <th className="text-left py-2 px-3 font-medium">editor</th>
                <th className="text-left py-2 px-3 font-medium">name</th>
                <th className="text-left py-2 px-3 font-medium">mode</th>
                <th className="text-left py-2 px-3 font-medium">model</th>
                <th className="text-left py-2 px-3 font-medium">context</th>
                <th className="text-right py-2 px-3 font-medium">est. cost</th>
                <th className="text-left py-2 px-3 font-medium">updated</th>
              </tr>
            </thead>
            <tbody>
              {filteredChats.map(c => (
                <tr
                  key={c.id}
                  className="cursor-pointer transition"
                  style={{ borderBottom: '1px solid var(--c-border)' }}
                  onMouseEnter={e => e.currentTarget.style.background = 'var(--c-bg3)'}
                  onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
                  onClick={() => setSelectedChatId(c.id)}
                >
                  <td className="py-2 px-3">
                    <span className="inline-flex items-center gap-1.5">
                      <EditorIcon source={c.source} size={12} />
                      <span style={{ color: 'var(--c-text2)' }}>{editorLabel(c.source)}</span>
                    </span>
                  </td>
                  <td className="py-2 px-3 font-medium truncate max-w-[280px]" style={{ color: 'var(--c-white)' }}>
                    {c.name || <span style={{ color: 'var(--c-text3)' }}>Untitled</span>}
                    {c.encrypted && <span className="ml-1.5 text-[10px] text-yellow-500/60">locked</span>}
                  </td>
                  <td className="py-2 px-3" style={{ color: 'var(--c-text2)' }}>{c.mode || ''}</td>
                  <td className="py-2 px-3 font-mono truncate max-w-[150px]" style={{ color: 'var(--c-text2)' }} title={c.topModel || ''}>{c.topModel || ''}</td>
                  <td className="py-2 px-3">
                    {c.bubbleCount >= 500 ? (
                      <span className="inline-flex items-center gap-0.5 font-bold" style={{ color: '#ef4444' }}>
                        <AlertTriangle size={9} />{c.bubbleCount} msgs
                      </span>
                    ) : c.bubbleCount >= 100 ? (
                      <span className="inline-flex items-center gap-0.5 font-bold" style={{ color: '#f59e0b' }}>
                        <AlertTriangle size={9} />{c.bubbleCount} msgs
                      </span>
                    ) : (
                      <span style={{ color: 'var(--c-text3)' }}>{c.bubbleCount || 0} msgs</span>
                    )}
                  </td>
                  <td className="py-2 px-3 font-mono text-right" style={{ color: c.cost > 0 ? 'var(--c-text2)' : 'var(--c-text3)' }}>
                    {c.cost > 0 ? formatCost(c.cost) : ''}
                  </td>
                  <td className="py-2 px-3 whitespace-nowrap" style={{ color: 'var(--c-text3)' }}>{formatDate(c.lastUpdatedAt || c.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {filteredChats.length === 0 && (
            <div className="text-center py-8 text-sm" style={{ color: 'var(--c-text3)' }}>no sessions found</div>
          )}
        </div>
      </div>

      {/* Chat sidebar */}
      <ChatSidebar chatId={selectedChatId} onClose={() => setSelectedChatId(null)} />
    </div>
  )
}
