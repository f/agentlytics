import { useState, useEffect, useRef, useCallback } from 'react'
import { Routes, Route, NavLink, useLocation } from 'react-router-dom'
import { Activity, BarChart3, GitCompare, MessageSquare, FolderOpen, DollarSign, CreditCard, Sun, Moon, RefreshCw, AlertTriangle, Github, Terminal, Database, Users, Plug, Copy, Check, Settings as SettingsIcon, Package, ChevronDown } from 'lucide-react'
import { fetchOverview, refetchAgents, fetchMode, fetchRelayConfig, getAuthToken, setOnAuthFailure } from './lib/api'
import { useTheme } from './lib/theme'
import AnimatedLogo from './components/AnimatedLogo'
import AnimatedLoader from './components/AnimatedLoader'
import LoginScreen from './components/LoginScreen'
import Dashboard from './pages/Dashboard'
import Sessions from './pages/Sessions'
import DeepAnalysis from './pages/DeepAnalysis'
import Compare from './pages/Compare'
import Projects from './pages/Projects'
import ProjectDetail from './pages/ProjectDetail'
import CostAnalysis from './pages/CostAnalysis'
import SqlViewer from './pages/SqlViewer'
import Artifacts from './pages/Artifacts'
import Settings from './pages/Settings'
import Subscriptions from './pages/Subscriptions'
import MCPs from './pages/MCPs'
import RelayDashboard from './pages/RelayDashboard'
import RelayUserDetail from './pages/RelayUserDetail'

function NavDropdown({ icon: Icon, label, items }) {
  const [open, setOpen] = useState(false)
  const location = useLocation()
  const isActive = items.some(i => i.to === location.pathname)
  const timeout = useRef(null)

  const enter = () => { clearTimeout(timeout.current); setOpen(true) }
  const leave = () => { timeout.current = setTimeout(() => setOpen(false), 150) }

  return (
    <div className="relative" onMouseEnter={enter} onMouseLeave={leave}>
      <button
        className={`flex items-center gap-1.5 px-2.5 py-1 text-[12px] rounded transition ${
          isActive ? 'bg-[var(--c-card)] text-[var(--c-white)]' : 'text-[var(--c-text2)] hover:text-[var(--c-white)]'
        }`}
      >
        <Icon size={12} />
        {label}
        <ChevronDown size={10} style={{ opacity: 0.5 }} />
      </button>
      {open && (
        <div
          className="absolute top-full left-0 mt-1 py-1 rounded shadow-lg min-w-[160px] z-[100]"
          style={{ background: 'var(--c-bg)', border: '1px solid var(--c-border)' }}
        >
          {items.map(({ to, icon: SubIcon, label: subLabel }) => (
            <NavLink
              key={to}
              to={to}
              onClick={() => setOpen(false)}
              className={({ isActive: a }) =>
                `flex items-center gap-2 px-3 py-1.5 text-[12px] transition ${
                  a ? 'bg-[var(--c-bg3)] text-[var(--c-white)]' : 'text-[var(--c-text2)] hover:text-[var(--c-white)] hover:bg-[var(--c-bg3)]'
                }`
              }
            >
              <SubIcon size={12} />
              {subLabel}
            </NavLink>
          ))}
        </div>
      )}
    </div>
  )
}

export default function App() {
  const [overview, setOverview] = useState(null)
  const [refetchState, setRefetchState] = useState(null) // null | { scanned, total }
  const [live, setLive] = useState(false)
  const [mode, setMode] = useState(null) // 'local' | 'relay'
  const [needsAuth, setNeedsAuth] = useState(false)
  const [authed, setAuthed] = useState(!!getAuthToken())
  const liveRef = useRef(null)
  const { dark, toggle } = useTheme()
  const [mcpOpen, setMcpOpen] = useState(false)
  const [mcpCopied, setMcpCopied] = useState(false)
  const [relayPassword, setRelayPassword] = useState('')

  useEffect(() => {
    setOnAuthFailure(() => setAuthed(false))
  }, [])

  useEffect(() => {
    fetchMode().then(data => {
      setMode(data.mode || 'local')
      setNeedsAuth(!!data.auth)
    })
  }, [])

  useEffect(() => {
    if (mode === 'relay' && authed) {
      fetchRelayConfig().then(c => setRelayPassword(c.relayPassword || '')).catch(() => {})
    }
  }, [mode, authed])

  const refreshOverview = useCallback(() => {
    fetchOverview().then(setOverview).catch(() => {})
  }, [])

  useEffect(() => {
    if (mode === 'local') refreshOverview()
  }, [mode])

  const rescanAndRefresh = useCallback(async (onProgress) => {
    await refetchAgents(onProgress)
    const data = await fetchOverview()
    setOverview(data)
  }, [])

  // Live mode: rescan & refresh every 60s
  useEffect(() => {
    if (live && mode === 'local') {
      liveRef.current = setInterval(() => {
        rescanAndRefresh().catch(() => {})
      }, 60000)
    } else {
      if (liveRef.current) clearInterval(liveRef.current)
      liveRef.current = null
    }
    return () => { if (liveRef.current) clearInterval(liveRef.current) }
  }, [live, rescanAndRefresh])

  const handleRefetch = async () => {
    setRefetchState({ scanned: 0, total: 0 })
    try {
      await rescanAndRefresh((p) => setRefetchState({ scanned: p.scanned, total: p.total }))
    } catch (e) { console.error(e) }
    setRefetchState(null)
  }

  const isRelay = mode === 'relay'
  const showLogin = isRelay && needsAuth && !authed

  const location = useLocation()
  const isFullWidth = location.pathname === '/artifacts'

  const nav = isRelay ? [
    { to: '/', icon: Users, label: 'Team' },
  ] : [
    { to: '/', icon: Activity, label: 'Dashboard' },
    { to: '/sessions', icon: MessageSquare, label: 'Sessions' },
    { to: '/projects', icon: FolderOpen, label: 'Projects' },
    { icon: DollarSign, label: 'Costs', children: [
      { to: '/costs', icon: DollarSign, label: 'Cost Analysis' },
      { to: '/subscriptions', icon: CreditCard, label: 'Subscriptions' },
    ]},
    { icon: BarChart3, label: 'Insights', children: [
      { to: '/analysis', icon: BarChart3, label: 'Deep Analysis' },
      { to: '/compare', icon: GitCompare, label: 'Compare' },
    ]},
    { to: '/artifacts', icon: Package, label: 'Artifacts' },
    { to: '/mcps', icon: Plug, label: 'MCPs' },
    { to: '/sql', icon: Database, label: 'SQL' },
  ]

  if (showLogin) {
    return <LoginScreen onSuccess={() => setAuthed(true)} />
  }

  return (
    <div className="min-h-screen">
      <header className="border-b px-4 py-1.5 flex items-center gap-3 sticky top-0 z-50 backdrop-blur-xl" style={{ borderColor: 'var(--c-border)', background: 'var(--c-header)' }}>
        <span className="flex items-center gap-1.5 text-xs font-bold tracking-tight" style={{ color: 'var(--c-white)' }}>
          <AnimatedLogo size={18} />
          Agentlytics{isRelay && <span className="ml-1.5 text-[10px] font-medium px-1.5 py-0.5" style={{ background: 'rgba(99,102,241,0.15)', color: '#818cf8' }}>relay</span>}
        </span>
        <nav className="flex gap-0.5 ml-2">
          {nav.map((item) => item.children ? (
            <NavDropdown key={item.label} icon={item.icon} label={item.label} items={item.children} />
          ) : (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.to === '/'}
              className={({ isActive }) =>
                `flex items-center gap-1.5 px-2.5 py-1 text-[12px] rounded transition ${
                  isActive ? 'bg-[var(--c-card)] text-[var(--c-white)]' : 'text-[var(--c-text2)] hover:text-[var(--c-white)]'
                }`
              }
            >
              <item.icon size={12} />
              {item.label}
            </NavLink>
          ))}
        </nav>
        <div className="ml-auto flex items-center gap-3">
          {!isRelay && (
            <>
              <button
                onClick={() => setLive(!live)}
                className="flex items-center gap-1.5 px-2 py-0.5 text-[11px] transition"
                style={{
                  color: live ? '#22c55e' : 'var(--c-text3)',
                  border: live ? '1px solid rgba(34,197,94,0.3)' : '1px solid var(--c-border)',
                  background: live ? 'rgba(34,197,94,0.08)' : 'transparent',
                }}
                title={live ? 'Disable live refresh' : 'Enable live refresh (every 60s)'}
              >
                <span
                  className={`inline-block w-1.5 h-1.5 rounded-full ${live ? 'pulse-dot' : ''}`}
                  style={{ background: live ? '#22c55e' : 'var(--c-text3)' }}
                />
                Live
              </button>
              <button
                onClick={handleRefetch}
                disabled={!!refetchState}
                className="flex items-center gap-1 px-2 py-0.5 text-[11px] rounded transition hover:bg-[var(--c-card)]"
                style={{ color: 'var(--c-text2)', border: '1px solid var(--c-border)' }}
                title="Clear cache and rescan all editors"
              >
                <RefreshCw size={10} className={refetchState ? 'animate-spin' : ''} />
                {refetchState
                  ? `Refetching (${refetchState.scanned}/${refetchState.total})...`
                  : 'Refetch'}
              </button>
              <span className="text-[11px]" style={{ color: 'var(--c-text2)' }}>
                {overview ? `${overview.totalChats} sessions` : '...'}
              </span>
            </>
          )}
          {isRelay && (
            <button
              onClick={() => { setMcpOpen(true); setMcpCopied(false) }}
              className="flex items-center gap-1.5 px-2 py-0.5 text-[11px] transition hover:bg-[var(--c-card)]"
              style={{ color: '#818cf8', border: '1px solid var(--c-border)' }}
              title="MCP Connection"
            >
              <Plug size={10} />
              Connect
            </button>
          )}
          <NavLink
            to="/settings"
            className="p-1 rounded transition hover:bg-[var(--c-card)]"
            style={({ isActive }) => ({ color: isActive ? '#6366f1' : 'var(--c-text2)' })}
            title="Settings"
          >
            <SettingsIcon size={13} />
          </NavLink>
          <button
            onClick={toggle}
            className="p-1 rounded transition hover:bg-[var(--c-card)]"
            style={{ color: 'var(--c-text2)' }}
            title={dark ? 'Light mode' : 'Dark mode'}
          >
            {dark ? <Sun size={13} /> : <Moon size={13} />}
          </button>
        </div>
      </header>

      {refetchState && (
        <div className="flex items-center gap-2 px-4 py-1.5 text-[12px]" style={{ background: 'rgba(234,179,8,0.08)', borderBottom: '1px solid rgba(234,179,8,0.15)', color: '#ca8a04' }}>
          <AlertTriangle size={12} />
          <span>Windsurf, Windsurf Next, and Antigravity require their app to be running during refetch — otherwise their sessions won't be detected.</span>
        </div>
      )}

      <main className={isRelay ? 'px-0' : isFullWidth ? 'p-0 overflow-hidden' : 'p-4 max-w-[1400px] mx-auto'}>
        {mode === null ? (
          <AnimatedLoader label="Loading..." />
        ) : isRelay ? (
          <Routes>
            <Route path="/" element={<RelayDashboard />} />
            <Route path="/relay" element={<RelayDashboard />} />
            <Route path="/relay/user/:username" element={<RelayUserDetail />} />
          </Routes>
        ) : (
          <Routes>
            <Route path="/" element={<Dashboard overview={overview} />} />
            <Route path="/projects" element={<Projects overview={overview} />} />
            <Route path="/projects/detail" element={<ProjectDetail />} />
            <Route path="/sessions" element={<Sessions overview={overview} />} />
            {/* ChatDetail is now a sidebar in Sessions */}
            <Route path="/costs" element={<CostAnalysis overview={overview} />} />
            <Route path="/analysis" element={<DeepAnalysis overview={overview} />} />
            <Route path="/compare" element={<Compare overview={overview} />} />
            <Route path="/subscriptions" element={<Subscriptions />} />
            <Route path="/artifacts" element={<Artifacts />} />
            <Route path="/mcps" element={<MCPs />} />
            <Route path="/sql" element={<SqlViewer />} />
            <Route path="/settings" element={<Settings />} />
          </Routes>
        )}
      </main>

      <footer className={`border-t mt-8 px-4 py-3 flex items-center justify-between text-[11px]${isFullWidth ? ' hidden' : ''}`} style={{ borderColor: 'var(--c-border)', color: 'var(--c-text3)' }}>
        <div className="flex items-center gap-3">
          <a href="https://github.com/f/agentlytics" target="_blank" rel="noopener noreferrer" className="flex items-center gap-1 hover:text-[var(--c-text)] transition">
            <Github size={11} />
            <span>GitHub</span>
          </a>
          <span className="flex items-center gap-1">
            <Terminal size={11} />
            <code style={{ fontFamily: 'JetBrains Mono, monospace' }}>npx agentlytics</code>
          </span>
        </div>
        <span>
          built by <a href="https://github.com/f" target="_blank" rel="noopener noreferrer" className="hover:text-[var(--c-text)] transition" style={{ color: 'var(--c-text2)' }}>fkadev</a>
        </span>
      </footer>

      {/* MCP Config Modal */}
      {mcpOpen && (
        <>
          <div className="fixed inset-0 z-[60]" style={{ background: 'rgba(0,0,0,0.5)' }} onClick={() => setMcpOpen(false)} />
          <div
            className="fixed z-[70] w-[440px] max-w-[90vw] p-5 rounded shadow-2xl"
            style={{ top: '50%', left: '50%', transform: 'translate(-50%, -50%)', background: 'var(--c-bg)', border: '1px solid var(--c-border)' }}
          >
            <div className="flex items-center justify-between mb-4">
              <div className="text-[13px] font-bold" style={{ color: 'var(--c-white)' }}>
                <Plug size={13} className="inline mr-1.5" style={{ color: '#818cf8' }} />
                Connection Config
              </div>
              <button onClick={() => setMcpOpen(false)} className="text-[18px] leading-none px-1 hover:opacity-70 transition" style={{ color: 'var(--c-text3)' }}>&times;</button>
            </div>

            <div className="text-[12px] font-medium mb-1.5" style={{ color: 'var(--c-white)' }}>MCP Config</div>
            <div className="flex items-center justify-between mb-1">
              <div className="text-[10px]" style={{ color: 'var(--c-text3)' }}>Add to your AI client's MCP settings</div>
              <button
                onClick={() => {
                  const json = JSON.stringify({ "mcpServers": { "agentlytics": { "url": `${window.location.origin}/mcp` } } }, null, 2)
                  navigator.clipboard.writeText(json)
                  setMcpCopied(true)
                  setTimeout(() => setMcpCopied(false), 2000)
                }}
                className="flex items-center gap-1 px-1.5 py-0.5 text-[10px] transition hover:bg-[var(--c-bg3)]"
                style={{ border: '1px solid var(--c-border)', color: mcpCopied ? '#22c55e' : 'var(--c-text2)' }}
              >
                {mcpCopied ? <><Check size={9} /> Copied</> : <><Copy size={9} /> Copy</>}
              </button>
            </div>
            <pre
              className="text-[11px] px-3 py-2 overflow-x-auto mb-4"
              style={{ background: 'var(--c-bg3)', border: '1px solid var(--c-border)', color: 'var(--c-text)', fontFamily: 'JetBrains Mono, monospace', lineHeight: 1.6 }}
            >{`{\n  "mcpServers": {\n    "agentlytics": {\n      "url": "${window.location.origin}/mcp"\n    }\n  }\n}`}</pre>

            <div className="text-[12px] font-medium mb-1.5" style={{ color: 'var(--c-white)' }}>Join Command</div>
            <div className="text-[10px] mb-1" style={{ color: 'var(--c-text3)' }}>Share with your team to start syncing sessions</div>
            <pre
              className="text-[11px] px-3 py-2 overflow-x-auto"
              style={{ background: 'var(--c-bg3)', border: '1px solid var(--c-border)', color: 'var(--c-text)', fontFamily: 'JetBrains Mono, monospace', lineHeight: 1.6 }}
            >{`cd /path/to/your-project\nRELAY_PASSWORD=${relayPassword || '<pass>'} npx agentlytics --join ${window.location.host}`}</pre>
          </div>
        </>
      )}
    </div>
  )
}
