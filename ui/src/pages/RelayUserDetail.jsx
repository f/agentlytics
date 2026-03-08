import { useState, useEffect, useCallback, useMemo } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { ArrowLeft, MessageSquare, FolderOpen, ChevronDown, ChevronRight, Hash } from 'lucide-react'
import { Chart as ChartJS, ArcElement, Tooltip, Legend, CategoryScale, LinearScale, BarElement } from 'chart.js'
import { Doughnut, Bar } from 'react-chartjs-2'
import KpiCard from '../components/KpiCard'
import EditorIcon from '../components/EditorIcon'
import SectionTitle from '../components/SectionTitle'
import ChatSidebar from '../components/ChatSidebar'
import LiveFeed from '../components/LiveFeed'
import { editorColor, editorLabel, formatNumber, formatDate } from '../lib/constants'
import { fetchRelayUserActivity, fetchRelaySession } from '../lib/api'
import { useTheme } from '../lib/theme'

ChartJS.register(ArcElement, Tooltip, Legend, CategoryScale, LinearScale, BarElement)

const MONO = 'JetBrains Mono, monospace'
const MODEL_COLORS = ['#6366f1', '#a78bfa', '#818cf8', '#c084fc', '#e879f9', '#f472b6', '#fb7185', '#f87171', '#fbbf24', '#34d399']

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

// Left sidebar: sessions grouped by project (folder-tree)
function SessionSidebar({ sessions, projects, selectedChat, onSelectChat }) {
  const [collapsed, setCollapsed] = useState(new Set())
  const toggle = (key) => {
    setCollapsed(prev => {
      const next = new Set(prev)
      next.has(key) ? next.delete(key) : next.add(key)
      return next
    })
  }

  // Group sessions by project
  const grouped = useMemo(() => {
    const map = {}
    const noProject = []
    for (const s of sessions) {
      if (s.folder) {
        if (!map[s.folder]) map[s.folder] = []
        map[s.folder].push(s)
      } else {
        noProject.push(s)
      }
    }
    const sorted = Object.entries(map).sort((a, b) => b[1].length - a[1].length)
    return { sorted, noProject }
  }, [sessions])

  const SessionItem = ({ s }) => (
    <div
      className="flex items-center gap-1.5 px-2 py-1.5 cursor-pointer transition rounded-sm"
      style={{ background: selectedChat === s.id ? 'rgba(99,102,241,0.12)' : 'transparent' }}
      onMouseEnter={e => { if (selectedChat !== s.id) e.currentTarget.style.background = 'var(--c-bg3)' }}
      onMouseLeave={e => { if (selectedChat !== s.id) e.currentTarget.style.background = 'transparent' }}
      onClick={() => onSelectChat(s.id)}
    >
      <EditorIcon source={s.source} size={10} />
      <div className="flex-1 min-w-0">
        <div className="text-[11px] font-medium truncate" style={{ color: 'var(--c-white)' }}>{s.name || 'Untitled'}</div>
        <div className="flex items-center gap-1 text-[8px]" style={{ color: 'var(--c-text3)' }}>
          {s.totalMessages > 0 && <span>{s.totalMessages}m</span>}
          {s.totalMessages > 0 && s.lastUpdatedAt && <span>·</span>}
          {s.lastUpdatedAt && <span>{formatDate(s.lastUpdatedAt)}</span>}
        </div>
      </div>
    </div>
  )

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-2 px-3 py-2.5 shrink-0" style={{ borderBottom: '1px solid var(--c-border)' }}>
        <Hash size={12} style={{ color: 'var(--c-accent)' }} />
        <span className="text-[12px] font-medium uppercase tracking-wider" style={{ color: 'var(--c-text2)' }}>Sessions</span>
        <span className="text-[10px] ml-auto" style={{ color: 'var(--c-text3)' }}>{sessions.length}</span>
      </div>

      <div className="flex-1 overflow-y-auto scrollbar-thin py-1">
        {grouped.sorted.map(([folder, list]) => {
          const isCollapsed = collapsed.has(folder)
          const folderName = folder.split('/').pop()
          return (
            <div key={folder}>
              <div
                className="flex items-center gap-1.5 px-2 py-1.5 cursor-pointer transition"
                onMouseEnter={e => e.currentTarget.style.background = 'var(--c-bg3)'}
                onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
                onClick={() => toggle(folder)}
              >
                {isCollapsed ? <ChevronRight size={10} style={{ color: 'var(--c-text3)' }} /> : <ChevronDown size={10} style={{ color: 'var(--c-text3)' }} />}
                <FolderOpen size={10} style={{ color: '#818cf8' }} />
                <span className="text-[11px] font-medium truncate flex-1" style={{ color: 'var(--c-text2)' }} title={folder}>{folderName}</span>
                <span className="text-[8px]" style={{ color: 'var(--c-text3)' }}>{list.length}</span>
              </div>
              {!isCollapsed && (
                <div className="pl-3">
                  {list.map(s => <SessionItem key={s.id} s={s} />)}
                </div>
              )}
            </div>
          )
        })}

        {grouped.noProject.length > 0 && (
          <div>
            {grouped.sorted.length > 0 && (
              <div className="px-2 py-1.5 text-[10px] uppercase tracking-wider" style={{ color: 'var(--c-text3)' }}>no project</div>
            )}
            <div className={grouped.sorted.length > 0 ? 'pl-1' : ''}>
              {grouped.noProject.map(s => <SessionItem key={s.id} s={s} />)}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

export default function RelayUserDetail() {
  const { username } = useParams()
  const navigate = useNavigate()
  const [sessions, setSessions] = useState(null)
  const [selectedChat, setSelectedChat] = useState(null)
  const { dark } = useTheme()

  const legendColor = dark ? '#888' : '#555'
  const gridColor = dark ? 'rgba(255,255,255,0.04)' : 'rgba(0,0,0,0.06)'
  const txtDim = dark ? '#555' : '#999'

  useEffect(() => {
    if (username) {
      fetchRelayUserActivity(username, { limit: 200 }).then(setSessions)
    }
  }, [username])

  const fetchFn = useCallback(
    (id) => fetchRelaySession(id, username),
    [username]
  )

  if (!sessions) return <div className="text-sm py-12 text-center" style={{ color: 'var(--c-text2)' }}>loading...</div>

  // Aggregate stats
  const totalSessions = sessions.length
  const totalMessages = sessions.reduce((s, c) => s + (c.totalMessages || 0), 0)
  const totalInputTokens = sessions.reduce((s, c) => s + (c.totalInputTokens || 0), 0)
  const totalOutputTokens = sessions.reduce((s, c) => s + (c.totalOutputTokens || 0), 0)
  const totalTokens = totalInputTokens + totalOutputTokens
  const msgsPerSession = totalSessions > 0 ? (totalMessages / totalSessions).toFixed(1) : 0
  const tokPerSession = totalSessions > 0 ? Math.round(totalTokens / totalSessions) : 0

  // Editor breakdown
  const editorMap = {}
  for (const s of sessions) {
    if (s.source) editorMap[s.source] = (editorMap[s.source] || 0) + 1
  }
  const editors = Object.entries(editorMap).sort((a, b) => b[1] - a[1])

  // Project breakdown
  const projectMap = {}
  for (const s of sessions) {
    if (s.folder) {
      if (!projectMap[s.folder]) projectMap[s.folder] = { count: 0, lastActive: 0, messages: 0, tokens: 0 }
      projectMap[s.folder].count++
      projectMap[s.folder].messages += s.totalMessages || 0
      projectMap[s.folder].tokens += (s.totalInputTokens || 0) + (s.totalOutputTokens || 0)
      if (s.lastUpdatedAt > projectMap[s.folder].lastActive) projectMap[s.folder].lastActive = s.lastUpdatedAt
    }
  }
  const projects = Object.entries(projectMap).sort((a, b) => b[1].count - a[1].count)
  const maxProjectSessions = projects.length > 0 ? Math.max(...projects.map(([, p]) => p.count)) : 1

  // Model breakdown
  const modelMap = {}
  for (const s of sessions) {
    if (s.models) {
      for (const m of s.models) modelMap[m] = (modelMap[m] || 0) + 1
    }
  }
  const models = Object.entries(modelMap).sort((a, b) => b[1] - a[1]).slice(0, 10)

  // Tool breakdown
  const toolMap = {}
  for (const s of sessions) {
    if (s.toolCalls) {
      for (const t of s.toolCalls) toolMap[t] = (toolMap[t] || 0) + 1
    }
  }
  const tools = Object.entries(toolMap).sort((a, b) => b[1] - a[1]).slice(0, 15)

  // Daily activity (sessions per day)
  const dayMap = {}
  for (const s of sessions) {
    const d = new Date(s.lastUpdatedAt || s.createdAt).toISOString().slice(0, 10)
    dayMap[d] = (dayMap[d] || 0) + 1
  }
  const days = Object.entries(dayMap).sort((a, b) => a[0].localeCompare(b[0])).slice(-14)

  const handleFeedClick = (chatId) => {
    setSelectedChat(chatId)
  }

  const sidebarH = 'calc(100vh - 42px)'

  return (
    <div className="fade-in flex" style={{ height: sidebarH }}>
      {/* ── Left sidebar: Sessions tree ── */}
      <div
        className="hidden lg:flex flex-col w-[250px] shrink-0 sticky top-[42px] self-start"
        style={{ height: sidebarH, borderRight: '1px solid var(--c-border)', background: 'var(--c-bg)' }}
      >
        <SessionSidebar sessions={sessions} projects={projects} selectedChat={selectedChat} onSelectChat={setSelectedChat} />
      </div>

      {/* ── Center: scrollable content ── */}
      <div className="flex-1 min-w-0 overflow-y-auto p-4 space-y-4">
        {/* Header */}
        <div className="flex items-center gap-3">
          <button
            onClick={() => navigate('/')}
            className="p-1.5 transition hover:bg-[var(--c-card)] rounded-sm"
            style={{ border: '1px solid var(--c-border)', color: 'var(--c-text2)' }}
          >
            <ArrowLeft size={14} />
          </button>
          <div className="flex items-center gap-2.5">
            <div className="w-9 h-9 flex items-center justify-center text-[14px] font-bold rounded-sm" style={{ background: 'rgba(99,102,241,0.15)', color: '#818cf8' }}>
              {username.charAt(0).toUpperCase()}
            </div>
            <div>
              <div className="text-[14px] font-bold" style={{ color: 'var(--c-white)' }}>{username}</div>
              <div className="flex items-center gap-2 mt-0.5">
                {editors.map(([src]) => (
                  <EditorIcon key={src} source={src} size={11} />
                ))}
              </div>
            </div>
          </div>
        </div>

        {/* KPIs */}
        <div className="grid gap-2" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(90px, 1fr))' }}>
          <KpiCard label="sessions" value={totalSessions} />
          <KpiCard label="messages" value={formatNumber(totalMessages)} sub={`${msgsPerSession}/session`} />
          <KpiCard label="editors" value={editors.length} />
          <KpiCard label="projects" value={projects.length} />
          <KpiCard label="tokens" value={formatNumber(totalTokens)} sub={`${formatNumber(tokPerSession)}/session`} />
          <KpiCard label="models" value={models.length} />
        </div>

        {/* Token overview */}
        {totalTokens > 0 && (
          <div className="card p-3">
            <div className="flex items-center justify-between mb-2">
              <SectionTitle>token usage</SectionTitle>
              <span className="text-[11px] font-bold" style={{ color: 'var(--c-white)' }}>{formatNumber(totalTokens)} total</span>
            </div>
            <ProportionBar height={10} segments={[
              { label: 'Input', value: totalInputTokens, color: '#6366f1' },
              { label: 'Output', value: totalOutputTokens, color: '#a78bfa' },
            ]} />
            <div className="flex items-center gap-4 mt-1.5 text-[10px]">
              <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-sm" style={{ background: '#6366f1' }} /> input {formatNumber(totalInputTokens)}</span>
              <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-sm" style={{ background: '#a78bfa' }} /> output {formatNumber(totalOutputTokens)}</span>
            </div>
          </div>
        )}

        {/* Charts: editors + models */}
        <div className="grid grid-cols-1 xl:grid-cols-2 gap-3">
          {editors.length > 0 && (
            <div className="card p-3">
              <SectionTitle>editors</SectionTitle>
              <div style={{ height: 160 }}>
                <Doughnut
                  data={{
                    labels: editors.map(([src]) => editorLabel(src)),
                    datasets: [{ data: editors.map(([, c]) => c), backgroundColor: editors.map(([src]) => editorColor(src)), borderWidth: 0 }],
                  }}
                  options={{
                    responsive: true, maintainAspectRatio: false, cutout: '60%',
                    plugins: {
                      legend: { position: 'right', labels: { color: legendColor, font: { size: 9, family: MONO }, usePointStyle: true, pointStyle: 'circle', padding: 6 } },
                      tooltip: { bodyFont: { family: MONO, size: 10 }, titleFont: { family: MONO, size: 10 } },
                    },
                  }}
                />
              </div>
            </div>
          )}
          {models.length > 0 && (
            <div className="card p-3">
              <SectionTitle>models</SectionTitle>
              <div style={{ height: 160 }}>
                <Doughnut
                  data={{
                    labels: models.map(([name]) => name),
                    datasets: [{ data: models.map(([, c]) => c), backgroundColor: MODEL_COLORS, borderWidth: 0 }],
                  }}
                  options={{
                    responsive: true, maintainAspectRatio: false, cutout: '60%',
                    plugins: {
                      legend: { position: 'right', labels: { color: legendColor, font: { size: 8, family: MONO }, usePointStyle: true, pointStyle: 'circle', padding: 6 } },
                      tooltip: { bodyFont: { family: MONO, size: 10 }, titleFont: { family: MONO, size: 10 } },
                    },
                  }}
                />
              </div>
            </div>
          )}
        </div>

        {/* Daily activity bar */}
        {days.length > 1 && (
          <div className="card p-3">
            <SectionTitle>daily activity (last 14 days)</SectionTitle>
            <div style={{ height: 120 }}>
              <Bar
                data={{
                  labels: days.map(([d]) => d.slice(5)),
                  datasets: [{
                    data: days.map(([, c]) => c),
                    backgroundColor: '#6366f1',
                    borderRadius: 2,
                  }],
                }}
                options={{
                  responsive: true, maintainAspectRatio: false,
                  plugins: { legend: { display: false }, tooltip: { bodyFont: { family: MONO, size: 10 }, titleFont: { family: MONO, size: 10 } } },
                  scales: {
                    x: { grid: { display: false }, ticks: { color: txtDim, font: { size: 8, family: MONO } } },
                    y: { grid: { color: gridColor }, ticks: { color: txtDim, font: { size: 8, family: MONO }, stepSize: 1 }, beginAtZero: true },
                  },
                }}
              />
            </div>
          </div>
        )}

        {/* Projects */}
        {projects.length > 0 && (
          <div>
            <SectionTitle>projects</SectionTitle>
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-2 mt-2">
              {projects.map(([folder, info]) => (
                <div key={folder} className="card px-3 py-2.5">
                  <div className="flex items-center gap-1.5 mb-1.5">
                    <FolderOpen size={11} style={{ color: '#818cf8' }} />
                    <span className="text-[12px] font-medium truncate" style={{ color: 'var(--c-white)' }}>{folder.split('/').pop()}</span>
                  </div>
                  <div className="text-[8px] truncate mb-2" style={{ color: 'var(--c-text3)' }}>{folder}</div>
                  <div className="grid grid-cols-3 gap-1 text-center mb-1.5">
                    <div className="p-1 rounded-sm" style={{ background: 'var(--c-code-bg)' }}>
                      <div className="text-[11px] font-bold" style={{ color: 'var(--c-white)' }}>{info.count}</div>
                      <div className="text-[7px]" style={{ color: 'var(--c-text3)' }}>sessions</div>
                    </div>
                    <div className="p-1 rounded-sm" style={{ background: 'var(--c-code-bg)' }}>
                      <div className="text-[11px] font-bold" style={{ color: 'var(--c-white)' }}>{formatNumber(info.messages)}</div>
                      <div className="text-[7px]" style={{ color: 'var(--c-text3)' }}>messages</div>
                    </div>
                    <div className="p-1 rounded-sm" style={{ background: 'var(--c-code-bg)' }}>
                      <div className="text-[11px] font-bold" style={{ color: 'var(--c-white)' }}>{formatNumber(info.tokens)}</div>
                      <div className="text-[7px]" style={{ color: 'var(--c-text3)' }}>tokens</div>
                    </div>
                  </div>
                  <div className="h-1.5 rounded-full overflow-hidden" style={{ background: 'var(--c-code-bg)' }}>
                    <div className="h-full rounded-full" style={{ width: `${(info.count / maxProjectSessions * 100).toFixed(0)}%`, background: '#6366f1' }} />
                  </div>
                  <div className="text-[8px] mt-1" style={{ color: 'var(--c-text3)' }}>{formatDate(info.lastActive)}</div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Top tools */}
        {tools.length > 0 && (
          <div className="card p-3">
            <SectionTitle>top tools</SectionTitle>
            <div className="flex flex-wrap gap-1.5 mt-1">
              {tools.map(([name, count]) => (
                <span key={name} className="text-[10px] px-2 py-1 rounded-sm" style={{ background: 'var(--c-code-bg)', color: 'var(--c-text2)' }}>
                  {name} <span style={{ color: 'var(--c-text3)' }}>×{count}</span>
                </span>
              ))}
            </div>
          </div>
        )}

        {/* Recent sessions table */}
        <div className="card p-3">
          <SectionTitle>recent sessions</SectionTitle>
          <div className="max-h-[400px] overflow-y-auto scrollbar-thin">
            <table className="w-full text-[12px]">
              <tbody>
                {sessions.slice(0, 50).map(s => (
                  <tr
                    key={s.id}
                    className="cursor-pointer transition"
                    style={{ borderBottom: '1px solid var(--c-border)' }}
                    onMouseEnter={e => e.currentTarget.style.background = 'var(--c-bg3)'}
                    onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
                    onClick={() => setSelectedChat(s.id)}
                  >
                    <td className="py-2 px-2 w-[24px]"><EditorIcon source={s.source} size={11} /></td>
                    <td className="py-2 px-2">
                      <div className="text-[11px] font-medium truncate" style={{ color: 'var(--c-white)' }}>{s.name || 'Untitled'}</div>
                      <div className="text-[10px] truncate" style={{ color: 'var(--c-text3)' }}>{s.folder ? s.folder.split('/').pop() : ''}</div>
                    </td>
                    <td className="py-2 px-2 text-[10px] whitespace-nowrap" style={{ color: 'var(--c-text3)' }}>
                      {s.totalMessages > 0 && <span>{s.totalMessages}m</span>}
                    </td>
                    <td className="py-2 px-2">
                      {s.mode && (
                        <span className="text-[8px] px-1.5 py-0.5 rounded-sm" style={{ background: 'rgba(168,85,247,0.1)', color: '#a855f7' }}>{s.mode}</span>
                      )}
                    </td>
                    <td className="py-2 px-2 text-[10px] whitespace-nowrap text-right" style={{ color: 'var(--c-text3)' }}>
                      {formatDate(s.lastUpdatedAt)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {/* ── Right sidebar: Live Feed ── */}
      <div
        className="hidden xl:flex flex-col w-[300px] shrink-0 sticky top-[42px] self-start"
        style={{ height: sidebarH, borderLeft: '1px solid var(--c-border)', background: 'var(--c-bg)' }}
      >
        <LiveFeed onSessionClick={handleFeedClick} />
      </div>

      {/* Session sidebar */}
      <ChatSidebar
        chatId={selectedChat}
        onClose={() => setSelectedChat(null)}
        fetchFn={fetchFn}
        username={username}
        extraHeader={
          <span className="text-[11px] font-medium px-1.5 py-0.5 shrink-0" style={{ background: 'rgba(99,102,241,0.15)', color: '#818cf8' }}>
            {username}
          </span>
        }
      />
    </div>
  )
}
