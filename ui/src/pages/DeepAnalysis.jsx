import { useState, useEffect, useRef, useMemo } from 'react'
import { Chart as ChartJS, ArcElement, Tooltip, Legend, CategoryScale, LinearScale, BarElement } from 'chart.js'
import { Doughnut, Bar } from 'react-chartjs-2'
import { Loader2, X, Zap, MessageSquare, Wrench, Cpu, TrendingUp } from 'lucide-react'
import { fetchDeepAnalytics, fetchToolCalls } from '../lib/api'
import { editorLabel, editorColor, formatNumber, dateRangeToApiParams } from '../lib/constants'
import { useTheme } from '../lib/theme'
import KpiCard from '../components/KpiCard'
import EditorIcon from '../components/EditorIcon'
import SectionTitle from '../components/SectionTitle'
import DateRangePicker from '../components/DateRangePicker'

ChartJS.register(ArcElement, Tooltip, Legend, CategoryScale, LinearScale, BarElement)

const MODEL_COLORS = ['#6366f1', '#a78bfa', '#818cf8', '#c084fc', '#e879f9', '#f472b6', '#fb7185', '#f87171', '#fbbf24', '#34d399']
const TOOL_COLORS = ['#10b981', '#34d399', '#6ee7b7', '#a7f3d0', '#d1fae5', '#ecfdf5', '#b8f0d8', '#7ce0b8', '#4ade80', '#22c55e']
const MONO = 'JetBrains Mono, monospace'

// Categorize tools into groups
const TOOL_CATEGORIES = {
  'File Operations': ['read_file', 'write_to_file', 'edit', 'multi_edit', 'Read', 'Write', 'EditFile', 'edit_file', 'create_file', 'read_notebook', 'edit_notebook'],
  'Search': ['grep_search', 'find_by_name', 'code_search', 'search', 'list_dir', 'Grep', 'Find', 'SearchFiles', 'ListDir'],
  'Terminal': ['run_command', 'command_status', 'RunCommand', 'execute_command', 'Bash', 'bash'],
  'Browser': ['browser_preview', 'read_url_content', 'view_content_chunk'],
  'AI Tools': ['mcp0_', 'mcp1_', 'mcp5_', 'mcp6_', 'skill', 'trajectory_search'],
}

function categorizeTools(tools) {
  const cats = {}
  for (const t of tools) {
    let found = false
    for (const [cat, patterns] of Object.entries(TOOL_CATEGORIES)) {
      if (patterns.some(p => t.name.startsWith(p) || t.name === p || t.name.toLowerCase().includes(p.toLowerCase()))) {
        if (!cats[cat]) cats[cat] = { tools: [], total: 0 }
        cats[cat].tools.push(t)
        cats[cat].total += t.count
        found = true
        break
      }
    }
    if (!found) {
      if (!cats['Other']) cats['Other'] = { tools: [], total: 0 }
      cats['Other'].tools.push(t)
      cats['Other'].total += t.count
    }
  }
  return Object.entries(cats).sort((a, b) => b[1].total - a[1].total)
}

// Summarize args for display
function summarizeArgs(toolName, args) {
  if (!args || typeof args !== 'object') return null
  if (args.CommandLine || args.command) return args.CommandLine || args.command
  if (args.file_path) return args.file_path
  if (args.TargetFile) return args.TargetFile
  if (args.SearchPath || args.search_path) return `${args.Query || args.query || ''} in ${args.SearchPath || args.search_path || ''}`
  if (args.Pattern) return `${args.Pattern} in ${args.SearchDirectory || ''}`
  if (args.Url || args.url) return args.Url || args.url
  if (args.query) return args.query
  const vals = Object.values(args).filter(v => typeof v === 'string' && v.length > 0)
  return vals.length > 0 ? vals[0].substring(0, 120) : null
}

function getDiff(args) {
  if (!args || typeof args !== 'object') return null
  const old = args.old_string || args.old_text || args.oldText || args.search || null
  const nw = args.new_string || args.new_text || args.newText || args.replace || null
  const file = args.file_path || args.TargetFile || args.filePath || args.path || null
  if (old != null || nw != null) return { old, new: nw, file }
  return null
}

function DiffBlock({ diff }) {
  const maxLines = 8
  const oldLines = (diff.old || '').split('\n').slice(0, maxLines)
  const newLines = (diff.new || '').split('\n').slice(0, maxLines)
  return (
    <div className="mt-1 text-[10px] font-mono overflow-x-auto" style={{ border: '1px solid var(--c-border)' }}>
      {diff.file && (
        <div className="px-2 py-0.5" style={{ background: 'var(--c-code-bg)', color: 'var(--c-text2)' }}>{diff.file}</div>
      )}
      {diff.old && oldLines.map((line, i) => (
        <div key={'o' + i} className="px-2" style={{ background: 'rgba(248,113,113,0.07)', color: '#f87171' }}>
          <span style={{ color: 'var(--c-text3)', userSelect: 'none' }}>- </span>{line}
        </div>
      ))}
      {diff.old && oldLines.length < (diff.old || '').split('\n').length && (
        <div className="px-2" style={{ color: 'var(--c-text3)' }}>  ... {(diff.old || '').split('\n').length - maxLines} more lines</div>
      )}
      {diff.new && newLines.map((line, i) => (
        <div key={'n' + i} className="px-2" style={{ background: 'rgba(52,211,153,0.07)', color: '#34d399' }}>
          <span style={{ color: 'var(--c-text3)', userSelect: 'none' }}>+ </span>{line}
        </div>
      ))}
      {diff.new && newLines.length < (diff.new || '').split('\n').length && (
        <div className="px-2" style={{ color: 'var(--c-text3)' }}>  ... {(diff.new || '').split('\n').length - maxLines} more lines</div>
      )}
    </div>
  )
}

function ToolCallRow({ call, toolName, index }) {
  const [expanded, setExpanded] = useState(false)
  const summary = summarizeArgs(toolName, call.args)
  const diff = getDiff(call.args)
  const project = call.folder ? call.folder.split('/').pop() : null
  const hasDetail = diff || (call.args && Object.keys(call.args).length > 0)

  return (
    <div className="px-2 py-1 text-[11px]" style={{ background: index % 2 === 0 ? 'var(--c-code-bg)' : 'transparent' }}>
      <div className="flex items-start gap-2 cursor-pointer" onClick={() => hasDetail && setExpanded(!expanded)}>
        <EditorIcon source={call.source} size={10} />
        <div className="flex-1 min-w-0">
          {summary && (
            <div className="font-mono truncate" style={{ color: 'var(--c-white)' }} title={summary}>{summary}</div>
          )}
          <div className="flex items-center gap-2" style={{ color: 'var(--c-text3)' }}>
            <span>{editorLabel(call.source)}</span>
            {project && <span>· {project}</span>}
            {call.timestamp && <span>· {new Date(call.timestamp).toLocaleDateString()}</span>}
            {hasDetail && <span>{expanded ? '▾' : '▸'}</span>}
          </div>
        </div>
      </div>
      {expanded && diff && <DiffBlock diff={diff} />}
      {expanded && !diff && call.args && Object.keys(call.args).length > 0 && (
        <pre className="mt-1 px-2 py-1 text-[10px] overflow-x-auto whitespace-pre-wrap break-all" style={{ background: 'var(--c-code-bg)', color: 'var(--c-text2)' }}>
          {JSON.stringify(call.args, null, 2)}
        </pre>
      )}
    </div>
  )
}

function ToolDrillDown({ toolName, folder, onClose }) {
  const [calls, setCalls] = useState(null)
  const [loading, setLoading] = useState(true)
  const projectName = folder ? folder.split('/').pop() : null

  useEffect(() => {
    setLoading(true)
    fetchToolCalls(toolName, { folder: folder || undefined }).then(data => { setCalls(data); setLoading(false) })
  }, [toolName, folder])

  return (
    <div className="card p-3 fade-in" style={{ borderColor: 'rgba(99,102,241,0.3)' }}>
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <Wrench size={12} style={{ color: 'var(--c-accent)' }} />
          <span className="text-xs font-bold" style={{ color: 'var(--c-white)' }}>{toolName}</span>
          <span className="text-[11px]" style={{ color: 'var(--c-text2)' }}>
            {calls ? `${calls.length} calls` : '...'}
            {calls && projectName ? ` in ${projectName}` : ''}
          </span>
        </div>
        <button onClick={onClose} className="p-0.5" style={{ color: 'var(--c-text2)' }}><X size={12} /></button>
      </div>
      {loading ? (
        <div className="text-[11px] py-4 text-center" style={{ color: 'var(--c-text3)' }}>loading...</div>
      ) : calls && calls.length > 0 ? (
        <div className="max-h-[500px] overflow-y-auto scrollbar-thin space-y-0.5">
          {calls.map((c, i) => (
            <ToolCallRow key={i} call={c} toolName={toolName} index={i} />
          ))}
        </div>
      ) : (
        <div className="text-[11px] py-4 text-center" style={{ color: 'var(--c-text3)' }}>no calls found</div>
      )}
    </div>
  )
}

// Proportional bar component
function ProportionBar({ segments, height = 6 }) {
  const total = segments.reduce((s, seg) => s + seg.value, 0)
  if (total === 0) return null
  return (
    <div className="flex w-full rounded-full overflow-hidden" style={{ height }}>
      {segments.filter(s => s.value > 0).map((seg, i) => (
        <div
          key={i}
          title={`${seg.label}: ${formatNumber(seg.value)}`}
          className="h-full transition-all"
          style={{ width: `${(seg.value / total * 100).toFixed(1)}%`, background: seg.color }}
        />
      ))}
    </div>
  )
}

export default function DeepAnalysis({ overview }) {
  const [editor, setEditor] = useState('')
  const [folder, setFolder] = useState('')
  const [dateRange, setDateRange] = useState(null)
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(false)
  const [selectedTool, setSelectedTool] = useState(null)
  const chartRef = useRef(null)
  const { dark } = useTheme()
  const txtColor = dark ? '#a0a0a0' : '#444'
  const txtDim = dark ? '#555' : '#999'
  const gridColor = dark ? 'rgba(255,255,255,0.03)' : 'rgba(0,0,0,0.06)'
  const legendColor = dark ? '#9ca3af' : '#555'

  const editors = overview?.editors || []
  const projects = overview?.topProjects || []

  async function analyze() {
    setLoading(true)
    const result = await fetchDeepAnalytics({ editor, folder: folder || undefined, limit: 500, ...dateRangeToApiParams(dateRange) })
    setData(result)
    setLoading(false)
  }

  useEffect(() => { analyze() }, [editor, folder, dateRange])

  const tools = data?.topTools?.slice(0, 15) || []
  const models = data?.topModels?.slice(0, 10) || []

  // Computed insights
  const insights = useMemo(() => {
    if (!data) return null
    const totalTok = data.totalInputTokens + data.totalOutputTokens
    const msgsPerSession = data.analyzedChats > 0 ? (data.totalMessages / data.analyzedChats).toFixed(1) : 0
    const toolsPerSession = data.analyzedChats > 0 ? (data.totalToolCalls / data.analyzedChats).toFixed(1) : 0
    const tokPerMsg = data.totalMessages > 0 ? Math.round(totalTok / data.totalMessages) : 0
    const cacheHitRate = data.totalInputTokens > 0 ? ((data.totalCacheRead / data.totalInputTokens) * 100).toFixed(1) : 0
    const outputRatio = data.totalInputTokens > 0 ? (data.totalOutputTokens / data.totalInputTokens).toFixed(2) : 0
    const aiVsHuman = data.totalUserChars > 0 ? (data.totalAssistantChars / data.totalUserChars).toFixed(1) : 0
    return { totalTok, msgsPerSession, toolsPerSession, tokPerMsg, cacheHitRate, outputRatio, aiVsHuman }
  }, [data])

  const toolCategories = useMemo(() => tools.length > 0 ? categorizeTools(tools) : [], [tools])

  function handleToolClick(evt, elements) {
    if (elements.length > 0) {
      const idx = elements[0].index
      const toolName = tools[idx]?.name
      if (toolName) setSelectedTool(toolName)
    }
  }

  return (
    <div className="fade-in space-y-4">
      {/* Filters */}
      <div className="flex items-center gap-2">
        <select
          value={editor}
          onChange={e => setEditor(e.target.value)}
          className="px-2 py-1.5 text-[12px] outline-none rounded-sm"
          style={{ background: 'var(--c-bg3)', color: 'var(--c-text)', border: '1px solid var(--c-border)' }}
        >
          <option value="">All Editors</option>
          {editors.map(e => (
            <option key={e.id} value={e.id}>{editorLabel(e.id)}</option>
          ))}
        </select>
        <select
          value={folder}
          onChange={e => setFolder(e.target.value)}
          className="px-2 py-1.5 text-[12px] outline-none max-w-[200px] truncate rounded-sm"
          style={{ background: 'var(--c-bg3)', color: 'var(--c-text)', border: '1px solid var(--c-border)' }}
        >
          <option value="">All Projects</option>
          {projects.map(p => (
            <option key={p.fullPath || p.name} value={p.fullPath}>{p.name}</option>
          ))}
        </select>
        {loading && <Loader2 size={11} className="animate-spin" style={{ color: 'var(--c-text3)' }} />}
        {data && <span className="text-[11px]" style={{ color: 'var(--c-text2)' }}>{data.analyzedChats} sessions analyzed</span>}
        <div className="ml-auto"><DateRangePicker value={dateRange} onChange={setDateRange} /></div>
      </div>

      {data && insights && (
        <>
          {/* KPIs */}
          <div className="grid gap-2" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(90px, 1fr))' }}>
            <KpiCard label="sessions" value={data.analyzedChats} />
            <KpiCard label="messages" value={formatNumber(data.totalMessages)} sub={`${insights.msgsPerSession}/session`} />
            <KpiCard label="tool calls" value={formatNumber(data.totalToolCalls)} sub={`${insights.toolsPerSession}/session`} />
            <KpiCard label="total tokens" value={formatNumber(insights.totalTok)} sub={`${formatNumber(insights.tokPerMsg)}/msg`} />
            <KpiCard label="you wrote" value={formatNumber(data.totalUserChars)} sub={`AI: ${insights.aiVsHuman}× more`} />
          </div>

          {/* Token flow + Insights row */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
            {/* Token flow visualization */}
            <div className="card p-3">
              <SectionTitle>token flow</SectionTitle>
              <div className="space-y-3 mt-2">
                {/* Input tokens breakdown */}
                <div>
                  <div className="flex items-center justify-between text-[11px] mb-1">
                    <span style={{ color: 'var(--c-text2)' }}>input tokens</span>
                    <span className="font-bold" style={{ color: 'var(--c-white)' }}>{formatNumber(data.totalInputTokens)}</span>
                  </div>
                  <ProportionBar segments={[
                    { label: 'Fresh input', value: data.totalInputTokens - data.totalCacheRead, color: '#6366f1' },
                    { label: 'Cache read', value: data.totalCacheRead, color: '#34d399' },
                  ]} />
                  <div className="flex items-center gap-3 mt-1 text-[10px]">
                    <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-sm" style={{ background: '#6366f1' }} /> fresh {formatNumber(data.totalInputTokens - data.totalCacheRead)}</span>
                    <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-sm" style={{ background: '#34d399' }} /> cached {formatNumber(data.totalCacheRead)}</span>
                  </div>
                </div>
                {/* Output tokens */}
                <div>
                  <div className="flex items-center justify-between text-[11px] mb-1">
                    <span style={{ color: 'var(--c-text2)' }}>output tokens</span>
                    <span className="font-bold" style={{ color: 'var(--c-white)' }}>{formatNumber(data.totalOutputTokens)}</span>
                  </div>
                  <ProportionBar segments={[
                    { label: 'Output', value: data.totalOutputTokens, color: '#a78bfa' },
                  ]} />
                </div>
                {/* Cache write */}
                {data.totalCacheWrite > 0 && (
                  <div>
                    <div className="flex items-center justify-between text-[11px] mb-1">
                      <span style={{ color: 'var(--c-text2)' }}>cache write</span>
                      <span className="font-bold" style={{ color: 'var(--c-white)' }}>{formatNumber(data.totalCacheWrite)}</span>
                    </div>
                    <ProportionBar segments={[
                      { label: 'Cache write', value: data.totalCacheWrite, color: '#fbbf24' },
                    ]} />
                  </div>
                )}
                {/* Overall ratio bar */}
                <div className="pt-2" style={{ borderTop: '1px solid var(--c-border)' }}>
                  <div className="text-[10px] mb-1" style={{ color: 'var(--c-text3)' }}>overall token distribution</div>
                  <ProportionBar height={10} segments={[
                    { label: 'Input', value: data.totalInputTokens, color: '#6366f1' },
                    { label: 'Output', value: data.totalOutputTokens, color: '#a78bfa' },
                    { label: 'Cache Read', value: data.totalCacheRead, color: '#34d399' },
                    { label: 'Cache Write', value: data.totalCacheWrite, color: '#fbbf24' },
                  ]} />
                  <div className="flex items-center gap-3 mt-1 text-[10px]" style={{ color: 'var(--c-text3)' }}>
                    <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-sm" style={{ background: '#6366f1' }} /> in</span>
                    <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-sm" style={{ background: '#a78bfa' }} /> out</span>
                    <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-sm" style={{ background: '#34d399' }} /> cache read</span>
                    <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-sm" style={{ background: '#fbbf24' }} /> cache write</span>
                  </div>
                </div>
              </div>
            </div>

            {/* Efficiency insights */}
            <div className="card p-3">
              <SectionTitle>efficiency insights</SectionTitle>
              <div className="space-y-3 mt-2">
                {/* Human vs AI chars */}
                <div>
                  <div className="text-[11px] mb-1" style={{ color: 'var(--c-text2)' }}>you vs AI (characters)</div>
                  <ProportionBar height={8} segments={[
                    { label: 'You', value: data.totalUserChars, color: '#6366f1' },
                    { label: 'AI', value: data.totalAssistantChars, color: '#34d399' },
                  ]} />
                  <div className="flex items-center justify-between mt-1 text-[10px]">
                    <span style={{ color: '#6366f1' }}>You: {formatNumber(data.totalUserChars)}</span>
                    <span style={{ color: '#34d399' }}>AI: {formatNumber(data.totalAssistantChars)}</span>
                  </div>
                </div>

                {/* Metric cards */}
                <div className="grid grid-cols-2 gap-2">
                  <div className="p-2 rounded-sm" style={{ background: 'var(--c-code-bg)' }}>
                    <div className="flex items-center gap-1 text-[10px]" style={{ color: 'var(--c-text3)' }}>
                      <TrendingUp size={9} /> output/input ratio
                    </div>
                    <div className="text-sm font-bold mt-0.5" style={{ color: 'var(--c-white)' }}>{insights.outputRatio}×</div>
                  </div>
                  <div className="p-2 rounded-sm" style={{ background: 'var(--c-code-bg)' }}>
                    <div className="flex items-center gap-1 text-[10px]" style={{ color: 'var(--c-text3)' }}>
                      <Zap size={9} /> cache hit rate
                    </div>
                    <div className="text-sm font-bold mt-0.5" style={{ color: parseFloat(insights.cacheHitRate) > 50 ? '#34d399' : parseFloat(insights.cacheHitRate) > 20 ? '#fbbf24' : 'var(--c-white)' }}>{insights.cacheHitRate}%</div>
                  </div>
                  <div className="p-2 rounded-sm" style={{ background: 'var(--c-code-bg)' }}>
                    <div className="flex items-center gap-1 text-[10px]" style={{ color: 'var(--c-text3)' }}>
                      <MessageSquare size={9} /> tokens per message
                    </div>
                    <div className="text-sm font-bold mt-0.5" style={{ color: 'var(--c-white)' }}>{formatNumber(insights.tokPerMsg)}</div>
                  </div>
                  <div className="p-2 rounded-sm" style={{ background: 'var(--c-code-bg)' }}>
                    <div className="flex items-center gap-1 text-[10px]" style={{ color: 'var(--c-text3)' }}>
                      <Wrench size={9} /> tools per session
                    </div>
                    <div className="text-sm font-bold mt-0.5" style={{ color: 'var(--c-white)' }}>{insights.toolsPerSession}</div>
                  </div>
                </div>

                {/* AI amplification */}
                <div className="p-2 rounded-sm text-center" style={{ background: 'var(--c-code-bg)' }}>
                  <div className="text-[10px]" style={{ color: 'var(--c-text3)' }}>AI amplification factor</div>
                  <div className="text-lg font-bold" style={{ color: 'var(--c-accent)' }}>{insights.aiVsHuman}×</div>
                  <div className="text-[10px]" style={{ color: 'var(--c-text3)' }}>AI writes {insights.aiVsHuman}× more than you type</div>
                </div>
              </div>
            </div>
          </div>

          {/* Charts row: Tools + Models + Tool Categories */}
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
            {/* Tools bar */}
            <div className="card p-3 lg:col-span-2">
              <SectionTitle>most used tools <span style={{ color: 'var(--c-text3)' }}>(click to drill down)</span></SectionTitle>
              <div style={{ height: Math.max(tools.length * 20 + 10, 120) }}>
                {tools.length > 0 ? (
                  <Bar
                    ref={chartRef}
                    data={{
                      labels: tools.map(t => t.name),
                      datasets: [{ data: tools.map(t => t.count), backgroundColor: TOOL_COLORS.concat(MODEL_COLORS).slice(0, tools.length), borderRadius: 2 }],
                    }}
                    options={{
                      indexAxis: 'y',
                      responsive: true,
                      maintainAspectRatio: false,
                      onClick: handleToolClick,
                      scales: {
                        x: { grid: { color: gridColor }, ticks: { color: txtDim, font: { size: 8, family: MONO } } },
                        y: { grid: { display: false }, ticks: { color: txtColor, font: { size: 8, family: MONO } } },
                      },
                      plugins: { legend: { display: false }, tooltip: { bodyFont: { family: MONO, size: 10 }, titleFont: { family: MONO, size: 10 } } },
                    }}
                  />
                ) : <div className="text-[11px] text-center py-8" style={{ color: 'var(--c-text3)' }}>no tool calls found</div>}
              </div>
            </div>

            {/* Models doughnut */}
            <div className="card p-3">
              <SectionTitle>models</SectionTitle>
              <div style={{ height: 160 }}>
                {models.length > 0 ? (
                  <Doughnut
                    data={{
                      labels: models.map(m => m.name),
                      datasets: [{ data: models.map(m => m.count), backgroundColor: MODEL_COLORS, borderWidth: 0 }],
                    }}
                    options={{
                      responsive: true, maintainAspectRatio: false, cutout: '60%',
                      plugins: {
                        legend: { position: 'right', labels: { color: legendColor, font: { size: 8, family: MONO }, usePointStyle: true, pointStyle: 'circle', padding: 6 } },
                        tooltip: { bodyFont: { family: MONO, size: 10 }, titleFont: { family: MONO, size: 10 } },
                      },
                    }}
                  />
                ) : <div className="text-[11px] text-center py-8" style={{ color: 'var(--c-text3)' }}>no model data</div>}
              </div>

              {/* Tool categories below models */}
              {toolCategories.length > 0 && (
                <div className="mt-3 pt-3" style={{ borderTop: '1px solid var(--c-border)' }}>
                  <div className="text-[10px] uppercase tracking-wider mb-2" style={{ color: 'var(--c-text3)' }}>tool categories</div>
                  <div className="space-y-1.5">
                    {toolCategories.map(([cat, { tools: catTools, total }]) => (
                      <div key={cat} className="flex items-center gap-2 text-[11px]">
                        <span className="truncate flex-1" style={{ color: 'var(--c-text2)' }}>{cat}</span>
                        <span className="font-bold" style={{ color: 'var(--c-white)' }}>{total}</span>
                        <span style={{ color: 'var(--c-text3)' }}>({catTools.length})</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* Tool drill-down */}
          {selectedTool && (
            <ToolDrillDown toolName={selectedTool} folder={folder} onClose={() => setSelectedTool(null)} />
          )}
        </>
      )}
    </div>
  )
}
