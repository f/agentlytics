import { useState, useEffect, useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { Users, Search, Merge, MessageSquare, FolderOpen, ChevronDown, ChevronRight } from 'lucide-react'
import { Chart as ChartJS, ArcElement, Tooltip, Legend, CategoryScale, LinearScale, BarElement } from 'chart.js'
import { Doughnut, Bar } from 'react-chartjs-2'
import KpiCard from '../components/KpiCard'
import EditorIcon from '../components/EditorIcon'
import SectionTitle from '../components/SectionTitle'
import ChatSidebar from '../components/ChatSidebar'
import LiveFeed from '../components/LiveFeed'
import { editorColor, editorLabel, formatNumber, formatDate } from '../lib/constants'
import { fetchRelayTeamStats, fetchRelaySearch, fetchRelaySession, mergeRelayUsers } from '../lib/api'
import { useTheme } from '../lib/theme'

ChartJS.register(ArcElement, Tooltip, Legend, CategoryScale, LinearScale, BarElement)

const MONO = 'JetBrains Mono, monospace'
const MODEL_COLORS = ['#6366f1', '#a78bfa', '#818cf8', '#c084fc', '#e879f9', '#f472b6', '#fb7185', '#f87171', '#fbbf24', '#34d399']
const USER_COLORS = ['#6366f1', '#8b5cf6', '#a855f7', '#c084fc', '#d8b4fe', '#e879f9', '#f472b6', '#fb7185']

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

// Left sidebar: team members grouped by project (folder-tree view)
function TeamSidebar({ userList, userColorMap, selectedUser }) {
  const [collapsed, setCollapsed] = useState(new Set())
  const navigate = useNavigate()

  // Build project → users mapping
  const { projectGroups, ungrouped } = useMemo(() => {
    const projMap = {}
    const seen = new Set()
    for (const u of userList) {
      const projects = u.sharedProjects || []
      if (projects.length === 0) {
        seen.add(u.username)
        continue
      }
      for (const p of projects) {
        const name = typeof p === 'string' ? p : (p.name || p)
        if (!projMap[name]) projMap[name] = []
        projMap[name].push(u)
        seen.add(u.username)
      }
    }
    const ungrouped = userList.filter(u => !(u.sharedProjects?.length > 0))
    const projectGroups = Object.entries(projMap).sort((a, b) => b[1].length - a[1].length)
    return { projectGroups, ungrouped }
  }, [userList])

  const toggle = (key) => {
    setCollapsed(prev => {
      const next = new Set(prev)
      next.has(key) ? next.delete(key) : next.add(key)
      return next
    })
  }

  const UserItem = ({ u }) => {
    const idx = userList.indexOf(u)
    const color = userColorMap[u.username] || '#6366f1'
    const editorEntries = Object.entries(u.editors || {}).sort((a, b) => b[1] - a[1])
    return (
      <div
        className="flex items-center gap-1.5 px-2 py-1.5 cursor-pointer transition rounded-sm"
        style={{
          background: selectedUser === u.username ? 'rgba(99,102,241,0.12)' : 'transparent',
        }}
        onMouseEnter={e => { if (selectedUser !== u.username) e.currentTarget.style.background = 'var(--c-bg3)' }}
        onMouseLeave={e => { if (selectedUser !== u.username) e.currentTarget.style.background = 'transparent' }}
        onClick={() => navigate(`/relay/user/${u.username}`)}
      >
        <div className="w-5 h-5 flex items-center justify-center text-[8px] font-bold rounded-sm flex-shrink-0" style={{ background: `${color}20`, color }}>
          {u.username.charAt(0).toUpperCase()}
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-[11px] font-medium truncate" style={{ color: 'var(--c-white)' }}>{u.username}</div>
          <div className="flex items-center gap-1 text-[8px]" style={{ color: 'var(--c-text3)' }}>
            <span>{u.sessions}s</span>
            <span>·</span>
            <span>{formatNumber(u.totalMessages)}m</span>
          </div>
          {editorEntries.length > 0 && (
            <div className="flex items-center gap-1 mt-0.5">
              {editorEntries.slice(0, 4).map(([src]) => (
                <EditorIcon key={src} source={src} size={9} />
              ))}
            </div>
          )}
        </div>
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-2 px-3 py-2.5 shrink-0" style={{ borderBottom: '1px solid var(--c-border)' }}>
        <Users size={12} style={{ color: 'var(--c-accent)' }} />
        <span className="text-[12px] font-medium uppercase tracking-wider" style={{ color: 'var(--c-text2)' }}>Team</span>
        <span className="text-[10px] ml-auto" style={{ color: 'var(--c-text3)' }}>{userList.length}</span>
      </div>

      <div className="flex-1 overflow-y-auto scrollbar-thin py-1">
        {/* Project groups */}
        {projectGroups.map(([proj, users]) => {
          const isCollapsed = collapsed.has(proj)
          const projName = proj.split('/').pop()
          return (
            <div key={proj}>
              <div
                className="flex items-center gap-1.5 px-2 py-1.5 cursor-pointer transition"
                onMouseEnter={e => e.currentTarget.style.background = 'var(--c-bg3)'}
                onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
                onClick={() => toggle(proj)}
              >
                {isCollapsed ? <ChevronRight size={10} style={{ color: 'var(--c-text3)' }} /> : <ChevronDown size={10} style={{ color: 'var(--c-text3)' }} />}
                <FolderOpen size={10} style={{ color: '#818cf8' }} />
                <span className="text-[11px] font-medium truncate flex-1" style={{ color: 'var(--c-text2)' }} title={proj}>{projName}</span>
                <span className="text-[8px]" style={{ color: 'var(--c-text3)' }}>{users.length}</span>
              </div>
              {!isCollapsed && (
                <div className="pl-3">
                  {users.map(u => <UserItem key={`${proj}-${u.username}`} u={u} />)}
                </div>
              )}
            </div>
          )
        })}

        {/* Ungrouped users */}
        {ungrouped.length > 0 && (
          <div>
            {projectGroups.length > 0 && (
              <div className="px-2 py-1.5 text-[10px] uppercase tracking-wider" style={{ color: 'var(--c-text3)' }}>
                unassigned
              </div>
            )}
            <div className={projectGroups.length > 0 ? 'pl-1' : ''}>
              {ungrouped.map(u => <UserItem key={u.username} u={u} />)}
            </div>
          </div>
        )}

        {userList.length === 0 && (
          <div className="text-[11px] py-6 text-center" style={{ color: 'var(--c-text3)' }}>
            No team members yet
          </div>
        )}
      </div>

      {/* Merge section at bottom */}
      {userList.length >= 2 && (
        <MergeSection userList={userList} />
      )}
    </div>
  )
}

function MergeSection({ userList }) {
  const [mergeFrom, setMergeFrom] = useState('')
  const [mergeTo, setMergeTo] = useState('')
  const [merging, setMerging] = useState(false)
  const [mergeResult, setMergeResult] = useState(null)
  const [open, setOpen] = useState(false)

  return (
    <div className="shrink-0 px-2 py-2" style={{ borderTop: '1px solid var(--c-border)' }}>
      <div
        className="flex items-center gap-1.5 cursor-pointer text-[10px] uppercase tracking-wider"
        style={{ color: 'var(--c-text3)' }}
        onClick={() => setOpen(!open)}
      >
        {open ? <ChevronDown size={9} /> : <ChevronRight size={9} />}
        <Merge size={9} />
        <span>merge users</span>
      </div>
      {open && (
        <div className="mt-2 space-y-1.5">
          <select
            value={mergeFrom}
            onChange={e => setMergeFrom(e.target.value)}
            className="w-full text-[11px] px-1.5 py-1 outline-none rounded-sm"
            style={{ background: 'var(--c-bg3)', color: 'var(--c-text)', border: '1px solid var(--c-border)' }}
          >
            <option value="">from...</option>
            {userList.filter(u => u.username !== mergeTo).map(u => (
              <option key={u.username} value={u.username}>{u.username}</option>
            ))}
          </select>
          <select
            value={mergeTo}
            onChange={e => setMergeTo(e.target.value)}
            className="w-full text-[11px] px-1.5 py-1 outline-none rounded-sm"
            style={{ background: 'var(--c-bg3)', color: 'var(--c-text)', border: '1px solid var(--c-border)' }}
          >
            <option value="">into...</option>
            {userList.filter(u => u.username !== mergeFrom).map(u => (
              <option key={u.username} value={u.username}>{u.username}</option>
            ))}
          </select>
          <button
            disabled={!mergeFrom || !mergeTo || merging}
            onClick={async () => {
              if (!confirm(`Merge "${mergeFrom}" → "${mergeTo}"? Cannot undo.`)) return
              setMerging(true)
              setMergeResult(null)
              try {
                const r = await mergeRelayUsers(mergeFrom, mergeTo)
                setMergeResult(r)
                setMergeFrom('')
                setMergeTo('')
              } catch (err) {
                setMergeResult({ error: err.message })
              }
              setMerging(false)
            }}
            className="w-full text-[11px] px-2 py-1 font-medium transition rounded-sm"
            style={{
              background: mergeFrom && mergeTo ? 'rgba(239,68,68,0.15)' : 'var(--c-bg3)',
              color: mergeFrom && mergeTo ? '#ef4444' : 'var(--c-text3)',
              border: '1px solid var(--c-border)',
              cursor: !mergeFrom || !mergeTo || merging ? 'not-allowed' : 'pointer',
              opacity: !mergeFrom || !mergeTo || merging ? 0.5 : 1,
            }}
          >
            {merging ? 'Merging...' : 'Merge'}
          </button>
          {mergeResult && (
            <div className="text-[10px]" style={{ color: mergeResult.error ? '#ef4444' : '#22c55e' }}>
              {mergeResult.error ? `Error: ${mergeResult.error}` : 'Merged!'}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

export default function RelayDashboard() {
  const navigate = useNavigate()
  const [stats, setStats] = useState(null)
  const [search, setSearch] = useState('')
  const [searchResults, setSearchResults] = useState(null)
  const [searching, setSearching] = useState(false)
  const [selectedChat, setSelectedChat] = useState(null)
  const [selectedUsername, setSelectedUsername] = useState(null)
  const { dark } = useTheme()

  const legendColor = dark ? '#888' : '#555'
  const gridColor = dark ? 'rgba(255,255,255,0.04)' : 'rgba(0,0,0,0.06)'
  const txtDim = dark ? '#555' : '#999'
  const txtColor = dark ? '#888' : '#555'

  useEffect(() => {
    fetchRelayTeamStats().then(setStats)
    const iv = setInterval(() => fetchRelayTeamStats().then(setStats), 15000)
    return () => clearInterval(iv)
  }, [])

  const handleSearch = async (e) => {
    e.preventDefault()
    if (!search.trim()) return
    setSearching(true)
    try {
      const results = await fetchRelaySearch(search.trim(), { limit: 30 })
      setSearchResults(results)
    } catch { setSearchResults([]) }
    setSearching(false)
  }

  const userList = stats?.users || []

  // Stable color map for users (must be before early return to keep hooks order)
  const userColorMap = useMemo(() => {
    const map = {}
    userList.forEach((u, i) => { map[u.username] = USER_COLORS[i % USER_COLORS.length] })
    return map
  }, [userList])

  if (!stats) return <div className="text-sm py-12 text-center" style={{ color: 'var(--c-text2)' }}>loading relay data...</div>

  const editorData = stats.editors || []
  const models = stats.topModels || []
  const totalTok = (stats.totalInputTokens || 0) + (stats.totalOutputTokens || 0)
  const msgsPerSession = stats.totalSessions > 0 ? (stats.totalMessages / stats.totalSessions).toFixed(1) : 0
  const tokPerSession = stats.totalSessions > 0 ? Math.round(totalTok / stats.totalSessions) : 0
  const maxUserSessions = userList.length > 0 ? Math.max(...userList.map(u => u.sessions)) : 1

  const handleFeedClick = (chatId, username) => {
    setSelectedChat(chatId)
    setSelectedUsername(username)
  }

  const sidebarH = 'calc(100vh - 42px)'

  return (
    <div className="fade-in flex" style={{ height: sidebarH }}>
      {/* ── Left sidebar: Team tree ── */}
      <div
        className="hidden lg:flex flex-col w-[250px] shrink-0 sticky top-[42px] self-start"
        style={{ height: sidebarH, borderRight: '1px solid var(--c-border)', background: 'var(--c-bg)' }}
      >
        <TeamSidebar userList={userList} userColorMap={userColorMap} selectedUser={selectedUsername} />
      </div>

      {/* ── Center: scrollable content ── */}
      <div className="flex-1 min-w-0 overflow-y-auto p-4 space-y-4">
        {/* KPIs */}
        <div className="grid gap-2" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(90px, 1fr))' }}>
          <KpiCard label="team members" value={stats.totalUsers} />
          <KpiCard label="sessions" value={formatNumber(stats.totalSessions)} sub={`${msgsPerSession} msgs/session`} />
          <KpiCard label="active users" value={stats.activeUsers} />
          <KpiCard label="projects" value={stats.totalProjects} />
          <KpiCard label="messages" value={formatNumber(stats.totalMessages)} />
          <KpiCard label="tokens" value={formatNumber(totalTok)} sub={`${formatNumber(tokPerSession)}/session`} />
        </div>

        {/* Token overview */}
        {totalTok > 0 && (
          <div className="card p-3">
            <div className="flex items-center justify-between mb-2">
              <SectionTitle>team token usage</SectionTitle>
              <span className="text-[11px] font-bold" style={{ color: 'var(--c-white)' }}>{formatNumber(totalTok)} total</span>
            </div>
            <ProportionBar height={10} segments={[
              { label: 'Input', value: stats.totalInputTokens, color: '#6366f1' },
              { label: 'Output', value: stats.totalOutputTokens, color: '#a78bfa' },
            ]} />
            <div className="flex items-center gap-4 mt-1.5 text-[10px]">
              <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-sm" style={{ background: '#6366f1' }} /> input {formatNumber(stats.totalInputTokens)}</span>
              <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-sm" style={{ background: '#a78bfa' }} /> output {formatNumber(stats.totalOutputTokens)}</span>
            </div>
            {userList.length > 1 && (
              <div className="mt-3 pt-2" style={{ borderTop: '1px solid var(--c-border)' }}>
                <div className="text-[10px] mb-1.5" style={{ color: 'var(--c-text3)' }}>per-user contribution</div>
                <ProportionBar height={8} segments={userList.map(u => ({
                  label: u.username,
                  value: u.totalInputTokens + u.totalOutputTokens,
                  color: userColorMap[u.username],
                }))} />
                <div className="flex flex-wrap gap-3 mt-1 text-[10px]">
                  {userList.map(u => (
                    <span key={u.username} className="flex items-center gap-1" style={{ color: 'var(--c-text3)' }}>
                      <span className="w-2 h-2 rounded-sm" style={{ background: userColorMap[u.username] }} />
                      {u.username}
                    </span>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {/* Charts: editors + models + sessions per user */}
        <div className="grid grid-cols-1 xl:grid-cols-3 gap-3">
          {editorData.length > 0 && (
            <div className="card p-3">
              <SectionTitle>editors</SectionTitle>
              <div style={{ height: 160 }}>
                <Doughnut
                  data={{
                    labels: editorData.map(e => editorLabel(e.source)),
                    datasets: [{ data: editorData.map(e => e.count), backgroundColor: editorData.map(e => editorColor(e.source)), borderWidth: 0 }],
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
                    labels: models.slice(0, 10).map(m => m.name),
                    datasets: [{ data: models.slice(0, 10).map(m => m.count), backgroundColor: MODEL_COLORS, borderWidth: 0 }],
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
          {userList.length > 0 && (
            <div className="card p-3">
              <SectionTitle>sessions per user</SectionTitle>
              <div style={{ height: Math.max(120, userList.length * 28) }}>
                <Bar
                  data={{
                    labels: userList.map(u => u.username),
                    datasets: [{
                      data: userList.map(u => u.sessions),
                      backgroundColor: userList.map(u => userColorMap[u.username]),
                      borderRadius: 2,
                    }],
                  }}
                  options={{
                    responsive: true, maintainAspectRatio: false, indexAxis: 'y',
                    plugins: { legend: { display: false }, tooltip: { bodyFont: { family: MONO, size: 10 }, titleFont: { family: MONO, size: 10 } } },
                    scales: {
                      x: { grid: { color: gridColor }, ticks: { color: txtDim, font: { size: 8, family: MONO } }, beginAtZero: true },
                      y: { grid: { display: false }, ticks: { color: txtColor, font: { size: 9, family: MONO } } },
                    },
                  }}
                />
              </div>
            </div>
          )}
        </div>

        {/* Search */}
        <div className="card p-3">
          <SectionTitle>search across team</SectionTitle>
          <form onSubmit={handleSearch} className="flex gap-2 mt-1">
            <div className="relative flex-1">
              <Search size={11} className="absolute left-2.5 top-1/2 -translate-y-1/2" style={{ color: 'var(--c-text3)' }} />
              <input
                type="text"
                value={search}
                onChange={e => setSearch(e.target.value)}
                placeholder="Search messages, files, topics across all users..."
                className="w-full pl-7 pr-3 py-1.5 text-[12px] outline-none rounded-sm"
                style={{ background: 'var(--c-bg3)', color: 'var(--c-white)', border: '1px solid var(--c-border)' }}
              />
            </div>
            <button
              type="submit"
              disabled={searching}
              className="px-3 py-1.5 text-[11px] font-medium transition rounded-sm"
              style={{ background: 'var(--c-card)', border: '1px solid var(--c-border)', color: 'var(--c-white)' }}
            >
              {searching ? 'Searching...' : 'Search'}
            </button>
          </form>
          {searchResults && (
            <div className="mt-3 max-h-[300px] overflow-y-auto scrollbar-thin">
              {searchResults.length === 0 ? (
                <div className="text-[12px] py-2" style={{ color: 'var(--c-text3)' }}>No results found</div>
              ) : (
                <table className="w-full text-[12px]">
                  <tbody>
                    {searchResults.map((r, i) => (
                      <tr
                        key={i}
                        className="cursor-pointer transition"
                        style={{ borderBottom: '1px solid var(--c-border)' }}
                        onMouseEnter={e => e.currentTarget.style.background = 'var(--c-bg3)'}
                        onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
                        onClick={() => { setSelectedChat(r.chatId); setSelectedUsername(r.username) }}
                      >
                        <td className="py-2 px-2 w-[80px]">
                          <span className="text-[10px] font-medium px-1.5 py-0.5" style={{ background: 'rgba(99,102,241,0.15)', color: '#818cf8' }}>{r.username}</span>
                        </td>
                        <td className="py-2 px-2 w-[24px]"><EditorIcon source={r.source} size={11} /></td>
                        <td className="py-2 px-2">
                          <div className="text-[11px] truncate" style={{ color: 'var(--c-text3)' }}>{r.chatName}</div>
                          <div className="text-[11px] line-clamp-1 mt-0.5" style={{ color: 'var(--c-text)' }}>{r.content}</div>
                        </td>
                        <td className="py-2 px-2 text-[10px] whitespace-nowrap" style={{ color: 'var(--c-text3)' }}>{r.role}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          )}
        </div>

        {/* Team member cards (for detail view) */}
        <SectionTitle>team overview</SectionTitle>
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
          {userList.map((u) => {
            const uTok = u.totalInputTokens + u.totalOutputTokens
            const color = userColorMap[u.username]
            const editorEntries = Object.entries(u.editors || {}).sort((a, b) => b[1] - a[1])
            return (
              <div
                key={u.username}
                className="card p-3 cursor-pointer transition hover:opacity-90"
                onClick={() => navigate(`/relay/user/${u.username}`)}
              >
                <div className="flex items-center gap-2 mb-2">
                  <div className="w-7 h-7 flex items-center justify-center text-[12px] font-bold rounded-sm flex-shrink-0" style={{ background: `${color}20`, color }}>
                    {u.username.charAt(0).toUpperCase()}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="text-[12px] font-bold truncate" style={{ color: 'var(--c-white)' }}>{u.username}</div>
                    <div className="text-[10px]" style={{ color: 'var(--c-text3)' }}>
                      {u.lastActive ? formatDate(u.lastActive) : 'No activity'}
                    </div>
                  </div>
                  <div className="flex items-center gap-0.5 flex-shrink-0">
                    {editorEntries.slice(0, 3).map(([src]) => (
                      <EditorIcon key={src} source={src} size={11} />
                    ))}
                  </div>
                </div>
                <div className="grid grid-cols-4 gap-1 text-center mb-2">
                  {[
                    [u.sessions, 'sessions'],
                    [formatNumber(u.totalMessages), 'messages'],
                    [u.projects, 'projects'],
                    [formatNumber(uTok), 'tokens'],
                  ].map(([v, l]) => (
                    <div key={l} className="p-1 rounded-sm" style={{ background: 'var(--c-code-bg)' }}>
                      <div className="text-[11px] font-bold" style={{ color: 'var(--c-white)' }}>{v}</div>
                      <div className="text-[7px]" style={{ color: 'var(--c-text3)' }}>{l}</div>
                    </div>
                  ))}
                </div>
                {/* Activity bar */}
                <div className="h-1.5 rounded-full overflow-hidden" style={{ background: 'var(--c-code-bg)' }}>
                  <div className="h-full rounded-full" style={{ width: `${(u.sessions / maxUserSessions * 100).toFixed(0)}%`, background: color }} />
                </div>
                {u.topModels && u.topModels.length > 0 && (
                  <div className="flex flex-wrap gap-1 mt-1.5">
                    {u.topModels.slice(0, 2).map(m => (
                      <span key={m.name} className="text-[8px] px-1.5 py-0.5 rounded-sm" style={{ background: 'rgba(99,102,241,0.08)', color: '#818cf8' }}>{m.name}</span>
                    ))}
                  </div>
                )}
              </div>
            )
          })}
        </div>

        {userList.length === 0 && (
          <div className="card p-8 text-center">
            <Users size={32} className="mx-auto mb-3" style={{ color: 'var(--c-text3)' }} />
            <div className="text-[12px] font-medium mb-1" style={{ color: 'var(--c-white)' }}>No team members yet</div>
            <div className="text-[11px]" style={{ color: 'var(--c-text3)' }}>Share the join command with your team to start collecting data</div>
          </div>
        )}
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
        onClose={() => { setSelectedChat(null); setSelectedUsername(null) }}
        fetchFn={selectedUsername ? (id) => fetchRelaySession(id, selectedUsername) : undefined}
        username={selectedUsername}
        extraHeader={
          selectedUsername ? (
            <span className="text-[11px] font-medium px-1.5 py-0.5 shrink-0" style={{ background: 'rgba(99,102,241,0.15)', color: '#818cf8' }}>
              {selectedUsername}
            </span>
          ) : null
        }
      />
    </div>
  )
}
