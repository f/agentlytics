import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { ArrowRight, X, Flame, Zap, MessageSquare, Wrench, Share2 } from 'lucide-react'
import { Chart as ChartJS, ArcElement, Tooltip, Legend, CategoryScale, LinearScale, BarElement, PointElement, LineElement, Filler } from 'chart.js'
import { Doughnut, Bar, Line } from 'react-chartjs-2'
import KpiCard from '../components/KpiCard'
import ActivityHeatmap from '../components/ActivityHeatmap'
import DateRangePicker from '../components/DateRangePicker'
import { editorColor, editorLabel, formatNumber, dateRangeToApiParams } from '../lib/constants'
import { fetchDailyActivity, fetchOverview as fetchOverviewApi, fetchDashboardStats, fetchShareImage } from '../lib/api'
import { useTheme } from '../lib/theme'

ChartJS.register(ArcElement, Tooltip, Legend, CategoryScale, LinearScale, BarElement, PointElement, LineElement, Filler)

const MONO = 'JetBrains Mono, monospace'
const WEEKDAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

const MODE_COLORS = {
  agent: '#a855f7', chat: '#3b82f6', cascade: '#06b6d4', edit: '#10b981',
  copilot: '#f59e0b', thread: '#ec4899', opencode: '#f43f5e', claude: '#f97316',
}

function SectionTitle({ children }) {
  return <h3 className="text-[10px] font-medium uppercase tracking-wider mb-2" style={{ color: 'var(--c-text2)' }}>{children}</h3>
}

export default function Dashboard({ overview }) {
  const navigate = useNavigate()
  const [dailyData, setDailyData] = useState(null)
  const [filteredData, setFilteredData] = useState(null)
  const [stats, setStats] = useState(null)
  const [selectedEditor, setSelectedEditor] = useState(null)
  const [dateRange, setDateRange] = useState(null)
  const { dark } = useTheme()
  const [sharing, setSharing] = useState(false)
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
    if (!selectedEditor) {
      setFilteredData(null)
      fetchDailyActivity(dateParams).then(setDailyData)
      fetchDashboardStats(dateParams).then(setStats)
      return
    }
    Promise.all([
      fetchOverviewApi({ editor: selectedEditor, ...dateParams }),
      fetchDailyActivity({ editor: selectedEditor, ...dateParams }),
      fetchDashboardStats({ editor: selectedEditor, ...dateParams }),
    ]).then(([ov, daily, st]) => {
      setFilteredData(ov)
      setDailyData(daily)
      setStats(st)
    })
  }, [selectedEditor, dateRange])

  if (!overview) return <div className="text-sm py-12 text-center" style={{ color: 'var(--c-text2)' }}>loading...</div>

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
  const cacheHitRate = tk && tk.input > 0 ? ((tk.cacheRead / tk.input) * 100).toFixed(1) : 0
  const outputInputRatio = tk && tk.input > 0 ? (tk.output / tk.input).toFixed(2) : 0
  const avgMsgsPerSession = tk && tk.sessions > 0 ? (depthData ? (Object.values(stats.depthBuckets).reduce((s, v, i) => {
    const labels = Object.keys(stats.depthBuckets)
    const midpoints = [1, 3.5, 8, 15.5, 35.5, 75.5, 150]
    return s + v * midpoints[i]
  }, 0) / tk.sessions).toFixed(1) : '—') : '—'

  const handleShare = async () => {
    setSharing(true)
    try {
      const svg = await fetchShareImage()
      if (!svg || svg.startsWith('{')) throw new Error('Failed to fetch image')

      // Try PNG conversion via canvas, fallback to SVG download
      let downloaded = false
      try {
        const canvas = document.createElement('canvas')
        canvas.width = 1600
        canvas.height = 880
        const ctx = canvas.getContext('2d')
        const img = new Image()
        const svgB64 = btoa(unescape(encodeURIComponent(svg)))
        const dataUrl = `data:image/svg+xml;base64,${svgB64}`
        await new Promise((resolve, reject) => {
          img.onload = resolve
          img.onerror = reject
          img.src = dataUrl
        })
        ctx.drawImage(img, 0, 0, 1600, 880)
        const pngUrl = canvas.toDataURL('image/png')
        const a = document.createElement('a')
        a.href = pngUrl
        a.download = 'agentlytics.png'
        a.click()
        downloaded = true
      } catch {
        // Fallback: download SVG directly
        const blob = new Blob([svg], { type: 'image/svg+xml' })
        const a = document.createElement('a')
        a.href = URL.createObjectURL(blob)
        a.download = 'agentlytics.svg'
        a.click()
        URL.revokeObjectURL(a.href)
        downloaded = true
      }

      if (downloaded) {
        const text = encodeURIComponent("Here's my agentic coding stats using github.com/f/agentlytics")
        window.open(`https://x.com/intent/post?text=${text}`, '_blank')
      }
    } catch (e) {
      console.error('Share failed:', e)
    }
    setSharing(false)
  }

  return (
    <div className="fade-in space-y-3">
      {/* Share button */}
      <div className="flex justify-end">
        <button
          onClick={handleShare}
          disabled={sharing}
          className="flex items-center gap-1.5 px-3 py-1 text-[11px] rounded-md transition hover:opacity-80"
          style={{ background: '#6366f1', color: '#fff', opacity: sharing ? 0.5 : 1 }}
        >
          <Share2 size={12} />
          {sharing ? 'Generating...' : 'Share Stats'}
        </button>
      </div>

      {/* Editor breakdown - top */}
      <div className="card p-3">
        <SectionTitle>editors</SectionTitle>
        <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-8 gap-2">
          {allEditors.map(e => {
            const isSelected = selectedEditor === e.id
            return (
              <div
                key={e.id}
                className="card px-3 py-3 text-center cursor-pointer transition"
                style={{
                  border: isSelected ? `1.5px solid ${editorColor(e.id)}` : '1px solid var(--c-border)',
                  opacity: selectedEditor && !isSelected ? 0.4 : 1,
                }}
                onClick={() => setSelectedEditor(isSelected ? null : e.id)}
              >
                <div className="w-2.5 h-2.5 rounded-full mx-auto mb-1.5" style={{ background: editorColor(e.id) }} />
                <div className="text-lg font-bold" style={{ color: 'var(--c-white)' }}>{e.count}</div>
                <div className="text-[10px]" style={{ color: 'var(--c-text2)' }}>{editorLabel(e.id)}</div>
              </div>
            )
          })}
        </div>
        {selectedEditor && sel && (
          <div className="mt-3 flex items-center gap-2">
            <button onClick={() => navigate(`/sessions?editor=${selectedEditor}`)} className="flex items-center gap-1 text-[11px] px-2.5 py-1 transition" style={{ color: 'var(--c-accent)', border: '1px solid var(--c-border)' }}>
              Show Sessions <ArrowRight size={11} />
            </button>
            <button onClick={() => setSelectedEditor(null)} className="flex items-center gap-1 text-[11px] px-2.5 py-1 transition" style={{ color: 'var(--c-text2)', border: '1px solid var(--c-border)' }}>
              <X size={9} /> Clear
            </button>
            <span className="text-[11px] ml-auto" style={{ color: 'var(--c-text)' }}>
              <span className="font-bold" style={{ color: editorColor(selectedEditor) }}>{editorLabel(selectedEditor)}</span>
              <span style={{ color: 'var(--c-text2)' }}> — {sel.count} sessions</span>
            </span>
          </div>
        )}
      </div>

      {/* Date range filter bar */}
      <div className="card px-3 py-2 flex items-center gap-2">
        <span className="text-[10px] uppercase tracking-wider mr-1" style={{ color: 'var(--c-text3)' }}>period</span>
        <DateRangePicker value={dateRange} onChange={setDateRange} />
      </div>

      {/* KPIs row 1: Core stats */}
      <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-8 gap-2">
        <KpiCard label="total sessions" value={formatNumber(d.totalChats)} sub={sel ? editorLabel(sel.id) : `${allEditors.length} editors`} />
        <KpiCard label="projects" value={d.topProjects.length} sub="unique folders" />
        <KpiCard label="time span" value={`${daysSpan}d`} sub={d.oldestChat ? `since ${new Date(d.oldestChat).toLocaleDateString()}` : ''} />
        <KpiCard label="this month" value={thisMonth ? thisMonth.count : 0} sub={thisMonth ? thisMonth.month : ''} />
        {stats && <>
          <KpiCard label="current streak" value={`${stats.streaks.current}d`} sub={<span className="flex items-center gap-0.5"><Flame size={8} className="text-orange-400" /> {stats.streaks.longest}d best</span>} />
          <KpiCard label="active days" value={stats.streaks.totalDays} sub={daysSpan > 0 ? `${((stats.streaks.totalDays / daysSpan) * 100).toFixed(0)}% of span` : ''} />
          <KpiCard label="avg msgs/session" value={avgMsgsPerSession} sub={<span className="flex items-center gap-0.5"><MessageSquare size={8} /> conversation depth</span>} />
          <KpiCard label="tool calls" value={formatNumber(stats.totalToolCalls)} sub={<span className="flex items-center gap-0.5"><Wrench size={8} /> total invocations</span>} />
        </>}
      </div>

      {/* Token economy KPIs */}
      {tk && tk.input > 0 && (
        <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-2">
          <KpiCard label="input tokens" value={formatNumber(tk.input)} sub="total prompt" />
          <KpiCard label="output tokens" value={formatNumber(tk.output)} sub="total completion" />
          <KpiCard label="cache read" value={formatNumber(tk.cacheRead)} sub={`${cacheHitRate}% hit rate`} />
          <KpiCard label="cache write" value={formatNumber(tk.cacheWrite)} />
          <KpiCard label="output/input" value={`${outputInputRatio}×`} sub={<span className="flex items-center gap-0.5"><Zap size={8} /> efficiency ratio</span>} />
          <KpiCard label="you wrote" value={formatNumber(tk.userChars)} sub={`AI wrote ${formatNumber(tk.assistantChars)}`} />
        </div>
      )}

      {/* Activity Heatmap */}
      <div className="card p-3">
        <SectionTitle>agentic coding activity</SectionTitle>
        {dailyData ? <ActivityHeatmap dailyData={dailyData} /> : <div className="text-[10px]" style={{ color: 'var(--c-text3)' }}>loading...</div>}
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
                <div className="text-[9px] w-6 text-right" style={{ color: 'var(--c-text2)' }}>{p.count}</div>
                <div className="flex-1 h-3 rounded-sm overflow-hidden" style={{ background: 'var(--c-code-bg)' }}>
                  <div className="h-full bg-accent/30 rounded-sm" style={{ width: `${(p.count / maxProject * 100).toFixed(1)}%` }} />
                </div>
                <div className="text-[9px] truncate max-w-[140px]" style={{ color: 'var(--c-text2)' }} title={p.fullPath}>{p.name}</div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Bottom row: Top models + Top tools */}
      {stats && (stats.topModels.length > 0 || stats.topTools.length > 0) && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-2">
          {/* Top models */}
          {stats.topModels.length > 0 && (
            <div className="card p-3">
              <SectionTitle>top models</SectionTitle>
              <div className="space-y-1">
                {stats.topModels.map((m, i) => {
                  const maxM = stats.topModels[0].count
                  return (
                    <div key={m.name} className="flex items-center gap-2">
                      <span className="text-[9px] w-3 text-right" style={{ color: 'var(--c-text3)' }}>{i + 1}</span>
                      <div className="flex-1 h-4 rounded-sm overflow-hidden" style={{ background: 'var(--c-code-bg)' }}>
                        <div className="h-full rounded-sm flex items-center px-1.5" style={{ width: `${(m.count / maxM * 100).toFixed(1)}%`, background: i === 0 ? '#6366f1' : i === 1 ? '#818cf8' : '#a5b4fc40' }}>
                          <span className="text-[8px] truncate" style={{ color: i < 2 ? '#fff' : 'var(--c-text2)' }}>{m.name}</span>
                        </div>
                      </div>
                      <span className="text-[9px] w-8 text-right" style={{ color: 'var(--c-text3)' }}>{m.count}</span>
                    </div>
                  )
                })}
              </div>
            </div>
          )}

          {/* Top tools */}
          {stats.topTools.length > 0 && (
            <div className="card p-3">
              <SectionTitle>top tools <span style={{ color: 'var(--c-text3)' }}>({formatNumber(stats.totalToolCalls)} total)</span></SectionTitle>
              <div className="space-y-1">
                {stats.topTools.map((t, i) => {
                  const maxT = stats.topTools[0].count
                  return (
                    <div key={t.name} className="flex items-center gap-2">
                      <span className="text-[9px] w-3 text-right" style={{ color: 'var(--c-text3)' }}>{i + 1}</span>
                      <div className="flex-1 h-4 rounded-sm overflow-hidden" style={{ background: 'var(--c-code-bg)' }}>
                        <div className="h-full rounded-sm flex items-center px-1.5" style={{ width: `${(t.count / maxT * 100).toFixed(1)}%`, background: i === 0 ? '#10b981' : i === 1 ? '#34d399' : '#6ee7b740' }}>
                          <span className="text-[8px] truncate font-mono" style={{ color: i < 2 ? '#fff' : 'var(--c-text2)' }}>{t.name}</span>
                        </div>
                      </div>
                      <span className="text-[9px] w-8 text-right" style={{ color: 'var(--c-text3)' }}>{formatNumber(t.count)}</span>
                    </div>
                  )
                })}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
