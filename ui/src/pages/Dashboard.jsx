import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { ArrowRight, X, Flame, Zap, MessageSquare, Wrench, Share2, AlertTriangle } from 'lucide-react'
import { Chart as ChartJS, ArcElement, Tooltip, Legend, CategoryScale, LinearScale, BarElement, PointElement, LineElement, Filler } from 'chart.js'
import { Doughnut, Bar, Line } from 'react-chartjs-2'
import KpiCard from '../components/KpiCard'
import ActivityHeatmap from '../components/ActivityHeatmap'
import DateRangePicker from '../components/DateRangePicker'
import { editorColor, editorLabel, formatNumber, formatCost, dateRangeToApiParams } from '../lib/constants'
import EditorIcon from '../components/EditorIcon'
import { fetchDailyActivity, fetchOverview as fetchOverviewApi, fetchDashboardStats, fetchChats, fetchCosts } from '../lib/api'
import ChatSidebar from '../components/ChatSidebar'
import AnimatedLoader from '../components/AnimatedLoader'
import ShareModal from '../components/ShareModal'
import { useTheme } from '../lib/theme'
import SectionTitle from '../components/SectionTitle'

ChartJS.register(ArcElement, Tooltip, Legend, CategoryScale, LinearScale, BarElement, PointElement, LineElement, Filler)

const MONO = 'JetBrains Mono, monospace'
const WEEKDAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

const MODE_COLORS = {
  agent: '#a855f7', chat: '#3b82f6', cascade: '#06b6d4', edit: '#10b981',
  copilot: '#f59e0b', thread: '#ec4899', opencode: '#f43f5e', claude: '#f97316',
}

export default function Dashboard({ overview }) {
  const navigate = useNavigate()
  const [dailyData, setDailyData] = useState(null)
  const [filteredData, setFilteredData] = useState(null)
  const [stats, setStats] = useState(null)
  const [selectedEditor, setSelectedEditor] = useState(null)
  const [dateRange, setDateRange] = useState(null)
  const { dark } = useTheme()
  const [costs, setCosts] = useState(null)
  const [shareOpen, setShareOpen] = useState(false)
  const [largeContextChats, setLargeContextChats] = useState(null)
  const [selectedChatId, setSelectedChatId] = useState(null)
  const txtColor = dark ? '#888' : '#555'
  const txtDim = dark ? '#555' : '#999'
  const gridColor = dark ? 'rgba(255,255,255,0.04)' : 'rgba(0,0,0,0.06)'
  const legendColor = dark ? '#888' : '#555'

  const chartOpts = {
    responsive: true, maintainAspectRatio: false,
    plugins: {
      legend: { position: 'right', labels: { color: legendColor, font: { size: 10, family: MONO }, padding: 12, usePointStyle: true, pointStyle: 'circle' } },
      tooltip: { bodyFont: { family: MONO, size: 11 }, titleFont: { family: MONO, size: 11 } },
    },
  }
  const barScales = {
    x: { grid: { display: false }, ticks: { color: txtDim, font: { size: 8, family: MONO } } },
    y: { grid: { color: gridColor }, ticks: { color: txtDim, font: { size: 8, family: MONO } }, beginAtZero: true },
  }
  const noLegend = { legend: { display: false }, tooltip: { bodyFont: { family: MONO, size: 10 }, titleFont: { family: MONO, size: 10 } } }

  useEffect(() => {
    const dateParams = dateRangeToApiParams(dateRange)
    const chatParams = { limit: 500, named: false, ...dateParams }
    if (selectedEditor) chatParams.editor = selectedEditor

    fetchChats(chatParams).then(r => {
      const big = (r.chats || []).filter(c => c.bubbleCount >= 100).sort((a, b) => b.bubbleCount - a.bubbleCount)
      setLargeContextChats(big)
    })

    if (!selectedEditor) {
      setFilteredData(null)
      fetchDailyActivity(dateParams).then(setDailyData)
      fetchDashboardStats(dateParams).then(setStats)
      fetchCosts(dateParams).then(setCosts)
      return
    }
    Promise.all([
      fetchOverviewApi({ editor: selectedEditor, ...dateParams }),
      fetchDailyActivity({ editor: selectedEditor, ...dateParams }),
      fetchDashboardStats({ editor: selectedEditor, ...dateParams }),
      fetchCosts({ editor: selectedEditor, ...dateParams }),
    ]).then(([ov, daily, st, c]) => {
      setFilteredData(ov)
      setDailyData(daily)
      setStats(st)
      setCosts(c)
    })
  }, [selectedEditor, dateRange])

  if (!overview) return <AnimatedLoader label="Loading dashboard..." />

  const d = filteredData || overview
  const allEditors = overview.editors.sort((a, b) => b.count - a.count)
  const daysSpan = d.oldestChat && d.newestChat ? Math.max(1, Math.round((d.newestChat - d.oldestChat) / 86400000)) : 0
  const thisMonth = d.byMonth.length > 0 ? d.byMonth[d.byMonth.length - 1] : null
  const modes = Object.entries(d.byMode).sort((a, b) => b[1] - a[1])
  const sel = selectedEditor ? allEditors.find(e => e.id === selectedEditor) : null

  const editorChartData = {
    labels: allEditors.map(e => editorLabel(e.id)),
    datasets: [{ data: allEditors.map(e => e.count), backgroundColor: allEditors.map(e => editorColor(e.id)), borderWidth: 0, spacing: 2 }],
  }
  const modeChartData = {
    labels: modes.map(e => e[0]),
    datasets: [{ data: modes.map(e => e[1]), backgroundColor: modes.map(e => MODE_COLORS[e[0]] || '#6b7280'), borderWidth: 0 }],
  }
  const maxProject = d.topProjects.length > 0 ? d.topProjects[0].count : 1

  // ── Stats-derived charts ──
  const mt = stats?.monthlyTrend
  const monthlyTrendData = mt && mt.months.length > 0 ? {
    labels: mt.months.map(m => m.substring(2)), // "25-01" etc
    datasets: mt.sources.map(src => ({
      label: editorLabel(src),
      data: mt.months.map(m => mt.data[m]?.[src] || 0),
      backgroundColor: editorColor(src) + 'CC',
      borderRadius: 2,
    })),
  } : null

  const hourlyData = stats ? {
    labels: stats.hourly.map((_, i) => `${String(i).padStart(2, '0')}`),
    datasets: [{
      data: stats.hourly,
      backgroundColor: stats.hourly.map((v, i) => {
        const peak = Math.max(...stats.hourly)
        const ratio = peak > 0 ? v / peak : 0
        return ratio > 0.75 ? '#6366f1' : ratio > 0.5 ? '#818cf8' : ratio > 0.25 ? '#a5b4fc' : '#c7d2fe50'
      }),
      borderRadius: 2,
    }],
  } : null

  const weekdayData = stats ? {
    labels: WEEKDAY_LABELS,
    datasets: [{
      data: stats.weekdays,
      backgroundColor: stats.weekdays.map((_, i) => i === 0 || i === 6 ? '#f59e0b80' : '#6366f1'),
      borderRadius: 3,
    }],
  } : null

  const depthData = stats ? {
    labels: Object.keys(stats.depthBuckets),
    datasets: [{
      data: Object.values(stats.depthBuckets),
      backgroundColor: ['#ef444460', '#f97316', '#f59e0b', '#10b981', '#06b6d4', '#6366f1', '#a855f7'],
      borderRadius: 3,
    }],
  } : null

  const velocityData = stats?.velocity?.length > 1 ? {
    labels: stats.velocity.map(v => v.month.substring(2)),
    datasets: [{
      label: 'Avg msgs/session',
      data: stats.velocity.map(v => v.avgMsgs),
      borderColor: '#6366f1',
      backgroundColor: '#6366f120',
      borderWidth: 2,
      tension: 0.3,
      pointRadius: 2,
      pointHoverRadius: 4,
      fill: true,
    }],
  } : null

  const tk = stats?.tokens
  const totalInputAll = tk ? tk.input + tk.cacheRead + (tk.cacheWrite || 0) : 0
  const cacheHitRate = totalInputAll > 0 ? ((tk.cacheRead / totalInputAll) * 100).toFixed(1) : 0
  const outputInputRatio = totalInputAll > 0 ? (tk.output / totalInputAll).toFixed(3) : 0
  const avgMsgsPerSession = tk && tk.sessions > 0 ? (depthData ? (Object.values(stats.depthBuckets).reduce((s, v, i) => {
    const labels = Object.keys(stats.depthBuckets)
    const midpoints = [1, 3.5, 8, 15.5, 35.5, 75.5, 150]
    return s + v * midpoints[i]
  }, 0) / tk.sessions).toFixed(1) : '—') : '—'


  return (
    <div className="fade-in space-y-3">
      {/* Top bar */}
      <div className="flex items-center justify-end gap-3">
        <DateRangePicker value={dateRange} onChange={setDateRange} />
        <button
          onClick={() => setShareOpen(true)}
          className="flex items-center gap-1.5 px-3 py-1 text-[12px] rounded-md transition hover:opacity-80"
          style={{ background: '#6366f1', color: '#fff' }}
        >
          <Share2 size={12} />
          Share Stats
        </button>
      </div>

      {/* Editor breakdown - compact row */}
      <div className="card p-3">
        <div className="flex items-center flex-wrap gap-1.5">
          {allEditors.map(e => {
            const isSelected = selectedEditor === e.id
            return (
              <button
                key={e.id}
                className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-[12px] cursor-pointer transition rounded-sm"
                style={{
                  border: isSelected ? `1.5px solid ${editorColor(e.id)}` : '1px solid var(--c-border)',
                  background: isSelected ? editorColor(e.id) + '15' : 'transparent',
                  opacity: selectedEditor && !isSelected ? 0.4 : 1,
                  color: 'var(--c-text)',
                }}
                onClick={() => setSelectedEditor(isSelected ? null : e.id)}
              >
                <EditorIcon source={e.id} size={14} />
                <span style={{ color: 'var(--c-text2)' }}>{editorLabel(e.id)}</span>
                <span className="font-bold" style={{ color: 'var(--c-white)' }}>{e.count}</span>
              </button>
            )
          })}
        </div>
        {selectedEditor && sel && (
          <div className="mt-2 flex items-center gap-2">
            <button onClick={() => navigate(`/sessions?editor=${selectedEditor}`)} className="flex items-center gap-1 text-[12px] px-2.5 py-1 transition" style={{ color: 'var(--c-accent)', border: '1px solid var(--c-border)' }}>
              Show Sessions <ArrowRight size={11} />
            </button>
            <button onClick={() => setSelectedEditor(null)} className="flex items-center gap-1 text-[12px] px-2.5 py-1 transition" style={{ color: 'var(--c-text2)', border: '1px solid var(--c-border)' }}>
              <X size={9} /> Clear
            </button>
          </div>
        )}
      </div>


      {/* KPIs — compact single row */}
      <div className="grid gap-2" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(90px, 1fr))' }}>
        <KpiCard label="sessions" value={formatNumber(d.totalChats)} sub={sel ? editorLabel(sel.id) : `${allEditors.length} editors`} onClick={() => navigate(selectedEditor ? `/sessions?editor=${selectedEditor}` : '/sessions')} />
        <KpiCard label="projects" value={d.topProjects.length} sub={`${daysSpan}d span`} onClick={() => navigate('/projects')} />
        <KpiCard label="this month" value={thisMonth ? thisMonth.count : 0} sub={thisMonth ? thisMonth.month : ''} onClick={() => navigate('/sessions')} />
        {stats && <>
          <KpiCard label="avg depth" value={avgMsgsPerSession} sub={<span className="flex items-center gap-0.5"><MessageSquare size={8} /> msgs/session</span>} />
          <KpiCard label="tool calls" value={formatNumber(stats.totalToolCalls)} sub={<span className="flex items-center gap-0.5"><Wrench size={8} /> total</span>} />
        </>}
        {tk && tk.input > 0 && <>
          <KpiCard label="tokens in" value={formatNumber(tk.input)} sub="prompt" />
          <KpiCard label="tokens out" value={formatNumber(tk.output)} sub={`${outputInputRatio}× ratio`} />
          <KpiCard label="cache hit" value={`${cacheHitRate}%`} sub={formatNumber(tk.cacheRead)} />
          <KpiCard label="you wrote" value={formatNumber(tk.userChars)} sub={`AI: ${formatNumber(tk.assistantChars)}`} />
        </>}
      </div>

      {/* Token economy KPIs */}
      {tk && tk.input > 0 && (
        <div className="grid gap-2" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(90px, 1fr))' }}>
          <KpiCard label="in tokens" value={formatNumber(tk.input)} sub="total prompt" />
          <KpiCard label="out tokens" value={formatNumber(tk.output)} sub="total completion" />
          <KpiCard label="cache read" value={formatNumber(tk.cacheRead)} sub={`${cacheHitRate}% hit rate`} />
          <KpiCard label="cache write" value={formatNumber(tk.cacheWrite)} />
          <KpiCard label="out/in ratio" value={`${outputInputRatio}×`} sub={<span className="flex items-center gap-0.5"><Zap size={8} /> efficiency</span>} />
          <KpiCard label="you wrote" value={formatNumber(tk.userChars)} sub={`AI wrote ${formatNumber(tk.assistantChars)}`} />
          <KpiCard label="est. cost" value={costs && costs.totalCost > 0 ? formatCost(costs.totalCost) : '—'} sub={costs && costs.byModel.length > 0 ? `${costs.byModel.length} model${costs.byModel.length !== 1 ? 's' : ''}` : undefined} />
        </div>
      )}

      {/* Activity Heatmap | Col 1 | Col 2 | Col 3 */}
      <div className="card p-3">
        <SectionTitle>agentic coding activity</SectionTitle>
        <div className="flex gap-4">
          <div className="min-w-0 flex-shrink-0">
            {dailyData ? <ActivityHeatmap dailyData={dailyData} /> : <div className="text-[11px]" style={{ color: 'var(--c-text3)' }}>loading...</div>}
          </div>
          {stats && dailyData && (() => {
            const activeDays = dailyData.filter(d => d.total > 0)
            const busiest = activeDays.length > 0 ? activeDays.reduce((a, b) => a.total > b.total ? a : b) : null
            const totalSessions = activeDays.reduce((s, d) => s + d.total, 0)
            const avgPerDay = activeDays.length > 0 ? (totalSessions / activeDays.length).toFixed(1) : 0
            return (
              <div className="flex-1 grid grid-cols-3 gap-3 text-[11px] min-w-0" style={{ borderLeft: '1px solid var(--c-border)', paddingLeft: 16 }}>
                <div className="space-y-2 min-w-0">
                  <div>
                    <div style={{ color: 'var(--c-text3)' }} className="uppercase tracking-wider mb-1">streaks</div>
                    <div className="flex items-center gap-1">
                      <Flame size={10} className="text-orange-400 flex-shrink-0" />
                      <span style={{ color: 'var(--c-white)' }} className="font-bold">{stats.streaks.current}d</span>
                      <span style={{ color: 'var(--c-text3)' }}>now</span>
                    </div>
                    <div className="flex items-center gap-1 mt-0.5">
                      <Zap size={10} className="text-yellow-400 flex-shrink-0" />
                      <span style={{ color: 'var(--c-white)' }} className="font-bold">{stats.streaks.longest}d</span>
                      <span style={{ color: 'var(--c-text3)' }}>best</span>
                    </div>
                  </div>
                  <div>
                    <div style={{ color: 'var(--c-text3)' }} className="uppercase tracking-wider mb-1">active days</div>
                    <span style={{ color: 'var(--c-white)' }} className="font-bold">{stats.streaks.totalDays}</span>
                    <span className="ml-1" style={{ color: 'var(--c-text3)' }}>{avgPerDay}/day</span>
                  </div>
                </div>
                <div className="space-y-2 min-w-0">
                  {busiest && (
                    <div>
                      <div style={{ color: 'var(--c-text3)' }} className="uppercase tracking-wider mb-1">busiest day</div>
                      <div style={{ color: 'var(--c-white)' }} className="font-bold">{busiest.day}</div>
                      <div style={{ color: 'var(--c-text3)' }}>{busiest.total} sessions</div>
                    </div>
                  )}
                  <div>
                    <div style={{ color: 'var(--c-text3)' }} className="uppercase tracking-wider mb-1">peak hour</div>
                    <div style={{ color: 'var(--c-white)' }} className="font-bold">{String(stats.hourly.indexOf(Math.max(...stats.hourly))).padStart(2, '0')}:00</div>
                    <div style={{ color: 'var(--c-text3)' }}>{Math.max(...stats.hourly)} sessions</div>
                  </div>
                </div>
                <div className="min-w-0">
                  <div style={{ color: 'var(--c-text3)' }} className="uppercase tracking-wider mb-1">top modes</div>
                  <div className="space-y-1">
                    {modes.slice(0, 5).map(([mode, count]) => (
                      <div key={mode} className="flex items-center gap-1">
                        <div className="w-1.5 h-1.5 rounded-full flex-shrink-0" style={{ background: MODE_COLORS[mode] || '#6b7280' }} />
                        <span className="truncate" style={{ color: 'var(--c-text)' }}>{mode}</span>
                        <span className="ml-auto font-bold flex-shrink-0" style={{ color: 'var(--c-white)' }}>{formatNumber(count)}</span>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            )
          })()}
        </div>
      </div>

      {/* Monthly trend (stacked bar by editor) */}
      {monthlyTrendData && (
        <div className="card p-3">
          <SectionTitle>monthly trend <span style={{ color: 'var(--c-text3)' }}>(sessions by editor)</span></SectionTitle>
          <div style={{ height: 200 }}>
            <Bar data={monthlyTrendData} options={{
              responsive: true, maintainAspectRatio: false,
              scales: {
                x: { stacked: true, grid: { display: false }, ticks: { color: txtDim, font: { size: 8, family: MONO }, maxRotation: 0 } },
                y: { stacked: true, grid: { color: gridColor }, ticks: { color: txtDim, font: { size: 8, family: MONO } }, beginAtZero: true },
              },
              plugins: {
                legend: { position: 'top', labels: { color: legendColor, font: { size: 9, family: MONO }, usePointStyle: true, pointStyle: 'circle', padding: 8 } },
                tooltip: { mode: 'index', bodyFont: { family: MONO, size: 10 }, titleFont: { family: MONO, size: 10 } },
              },
            }} />
          </div>
        </div>
      )}

      {/* Behavior row: hourly, weekday, depth */}
      {stats && (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-2">
          {/* Peak hours */}
          <div className="card p-3">
            <SectionTitle>peak hours <span style={{ color: 'var(--c-text3)' }}>(when you code with AI)</span></SectionTitle>
            <div style={{ height: 160 }}>
              {hourlyData && <Bar data={hourlyData} options={{
                responsive: true, maintainAspectRatio: false,
                scales: {
                  x: { grid: { display: false }, ticks: { color: txtDim, font: { size: 7, family: MONO }, maxRotation: 0, callback: (v, i) => i % 3 === 0 ? `${String(i).padStart(2, '0')}` : '' } },
                  y: { grid: { color: gridColor }, ticks: { color: txtDim, font: { size: 8, family: MONO } }, beginAtZero: true },
                },
                plugins: noLegend,
              }} />}
            </div>
          </div>

          {/* Weekday pattern */}
          <div className="card p-3">
            <SectionTitle>weekday pattern <span style={{ color: 'var(--c-text3)' }}>(weekends highlighted)</span></SectionTitle>
            <div style={{ height: 160 }}>
              {weekdayData && <Bar data={weekdayData} options={{
                responsive: true, maintainAspectRatio: false,
                scales: barScales,
                plugins: noLegend,
              }} />}
            </div>
          </div>

          {/* Session depth */}
          <div className="card p-3">
            <SectionTitle>session depth <span style={{ color: 'var(--c-text3)' }}>(messages per session)</span></SectionTitle>
            <div style={{ height: 160 }}>
              {depthData && <Bar data={depthData} options={{
                responsive: true, maintainAspectRatio: false,
                scales: barScales,
                plugins: noLegend,
              }} />}
            </div>
          </div>
        </div>
      )}

      {/* Velocity + Editors/Modes + Projects */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-2">
        {/* Conversation velocity trend */}
        {velocityData ? (
          <div className="card p-3">
            <SectionTitle>conversation velocity <span style={{ color: 'var(--c-text3)' }}>(avg msgs/session)</span></SectionTitle>
            <div style={{ height: 180 }}>
              <Line data={velocityData} options={{
                responsive: true, maintainAspectRatio: false,
                scales: {
                  x: { grid: { display: false }, ticks: { color: txtDim, font: { size: 8, family: MONO }, maxRotation: 0 } },
                  y: { grid: { color: gridColor }, ticks: { color: txtDim, font: { size: 8, family: MONO } }, beginAtZero: true },
                },
                plugins: noLegend,
              }} />
            </div>
          </div>
        ) : (
          <div className="card p-3">
            <SectionTitle>editors</SectionTitle>
            <div style={{ height: 180 }}>
              <Doughnut data={editorChartData} options={{ ...chartOpts, cutout: '65%' }} />
            </div>
          </div>
        )}

        {/* Modes */}
        <div className="card p-3">
          <SectionTitle>modes</SectionTitle>
          <div style={{ height: 180 }}>
            <Doughnut data={modeChartData} options={{ ...chartOpts, cutout: '60%' }} />
          </div>
        </div>

        {/* Top projects */}
        <div className="card p-3">
          <SectionTitle>top projects</SectionTitle>
          <div className="space-y-1 max-h-[180px] overflow-y-auto scrollbar-thin">
            {d.topProjects.slice(0, 12).map(p => (
              <div key={p.name} className="flex items-center gap-1.5">
                <div className="text-[10px] w-6 text-right" style={{ color: 'var(--c-text2)' }}>{p.count}</div>
                <div className="flex-1 h-3 rounded-sm overflow-hidden" style={{ background: 'var(--c-code-bg)' }}>
                  <div className="h-full bg-accent/30 rounded-sm" style={{ width: `${(p.count / maxProject * 100).toFixed(1)}%` }} />
                </div>
                <div className="text-[10px] truncate max-w-[140px]" style={{ color: 'var(--c-text2)' }} title={p.fullPath}>{p.name}</div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Bottom row: Top models + Top tools + Large context */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-2">
        {stats && stats.topModels.length > 0 && (
          <div className="card p-3">
            <SectionTitle>top models {costs && costs.totalCost > 0 && <span style={{ color: 'var(--c-text3)' }}>({formatCost(costs.totalCost)} est.)</span>}</SectionTitle>
            <div className="space-y-1">
              {stats.topModels.map((m, i) => {
                const maxM = stats.topModels[0].count
                const modelCost = costs?.byModel?.find(c => c.model === m.name)
                return (
                  <div key={m.name} className="flex items-center gap-2">
                    <span className="text-[10px] w-3 text-right" style={{ color: 'var(--c-text3)' }}>{i + 1}</span>
                    <span className="text-[9px] truncate w-28" style={{ color: 'var(--c-text2)' }} title={m.name}>{m.name}</span>
                    <div className="flex-1 h-4 rounded-sm overflow-hidden" style={{ background: 'var(--c-code-bg)' }}>
                      <div className="h-full rounded-sm" style={{ width: `${(m.count / maxM * 100).toFixed(1)}%`, background: i === 0 ? '#6366f1' : i === 1 ? '#818cf8' : '#a5b4fc40' }} />
                    </div>
                    {modelCost ? <span className="text-[9px] w-12 text-right" style={{ color: '#10b981' }}>{formatCost(modelCost.cost)}</span> : null}
                    <span className="text-[10px] w-8 text-right" style={{ color: 'var(--c-text3)' }}>{m.count}</span>
                  </div>
                )
              })}
            </div>
          </div>
        )}

        {stats && stats.topTools.length > 0 && (
          <div className="card p-3">
            <SectionTitle>top tools <span style={{ color: 'var(--c-text3)' }}>({formatNumber(stats.totalToolCalls)} total)</span></SectionTitle>
            <div className="space-y-1">
              {stats.topTools.map((t, i) => {
                const maxT = stats.topTools[0].count
                return (
                  <div key={t.name} className="flex items-center gap-2">
                    <span className="text-[10px] w-3 text-right" style={{ color: 'var(--c-text3)' }}>{i + 1}</span>
                    <div className="flex-1 h-4 rounded-sm overflow-hidden" style={{ background: 'var(--c-code-bg)' }}>
                      <div className="h-full rounded-sm flex items-center px-1.5" style={{ width: `${(t.count / maxT * 100).toFixed(1)}%`, background: i === 0 ? '#10b981' : i === 1 ? '#34d399' : '#6ee7b740' }}>
                        <span className="text-[8px] truncate font-mono" style={{ color: i < 2 ? '#fff' : 'var(--c-text2)' }}>{t.name}</span>
                      </div>
                    </div>
                    <span className="text-[10px] w-8 text-right" style={{ color: 'var(--c-text3)' }}>{formatNumber(t.count)}</span>
                  </div>
                )
              })}
            </div>
          </div>
        )}

        {largeContextChats && largeContextChats.length > 0 && (
          <div className="card p-3">
            <SectionTitle>
              <span className="inline-flex items-center gap-1">
                <AlertTriangle size={10} className="text-amber-400" />
                large context
                <span style={{ color: 'var(--c-text3)' }}>({largeContextChats.length})</span>
              </span>
            </SectionTitle>
            <div className="space-y-1">
              {largeContextChats.slice(0, 10).map(c => (
                <div
                  key={c.id}
                  className="flex items-center gap-1.5 px-1.5 py-1 rounded-sm cursor-pointer transition hover:opacity-80"
                  style={{ background: c.bubbleCount >= 500 ? 'rgba(239,68,68,0.06)' : 'rgba(245,158,11,0.06)' }}
                  onClick={() => setSelectedChatId(c.id)}
                >
                  <EditorIcon source={c.source} size={10} />
                  <span className="text-[10px] truncate flex-1" style={{ color: 'var(--c-text)' }}>{c.name || 'Untitled'}</span>
                  <span
                    className="text-[10px] font-bold flex-shrink-0"
                    style={{ color: c.bubbleCount >= 500 ? '#ef4444' : '#f59e0b' }}
                  >
                    {c.bubbleCount}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
      <ChatSidebar chatId={selectedChatId} onClose={() => setSelectedChatId(null)} />
      <ShareModal open={shareOpen} onClose={() => setShareOpen(false)} />
    </div>
  )
}
