import { useState, useEffect, useRef, useCallback } from 'react'
import { Routes, Route, NavLink, useLocation } from 'react-router-dom'
import { Activity, BarChart3, GitCompare, MessageSquare, FolderOpen, DollarSign, CreditCard, Sun, Moon, RefreshCw, AlertTriangle, Github, Terminal, Database, Settings as SettingsIcon, Package, ChevronDown } from 'lucide-react'
import { fetchOverview, refetchAgents } from './lib/api'
import { useTheme } from './lib/theme'
import AnimatedLogo from './components/AnimatedLogo'
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
  const liveRef = useRef(null)
  const { dark, toggle } = useTheme()

  const refreshOverview = useCallback(() => {
    fetchOverview().then(setOverview).catch(() => {})
  }, [])

  useEffect(() => {
    refreshOverview()
  }, [])

  // Live mode: refetch overview every 60s
  useEffect(() => {
    if (live) {
      liveRef.current = setInterval(() => {
        refreshOverview()
      }, 60000)
    } else {
      if (liveRef.current) clearInterval(liveRef.current)
      liveRef.current = null
    }
    return () => { if (liveRef.current) clearInterval(liveRef.current) }
  }, [live, refreshOverview])

  const handleRefetch = async () => {
    setRefetchState({ scanned: 0, total: 0 })
    try {
      await refetchAgents((p) => setRefetchState({ scanned: p.scanned, total: p.total }))
      const data = await fetchOverview()
      setOverview(data)
    } catch (e) { console.error(e) }
    setRefetchState(null)
  }

  const location = useLocation()
  const isFullWidth = location.pathname === '/artifacts'

  const nav = [
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
    { to: '/sql', icon: Database, label: 'SQL' },
  ]

  return (
    <div className="min-h-screen">
      <header data-tauri-drag-region className="border-b pl-20 pr-4 py-1.5 flex items-center gap-3 sticky top-0 z-50 backdrop-blur-xl" style={{ borderColor: 'var(--c-border)', background: 'var(--c-header)' }}>
        <span className="flex items-center gap-1.5 text-xs font-bold tracking-tight pointer-events-none select-none" style={{ color: 'var(--c-white)' }}>
          <AnimatedLogo size={18} />
          Agentlytics
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

      <main className={isFullWidth ? 'p-0 overflow-hidden' : 'p-4 max-w-[1400px] mx-auto'}>
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
            <Route path="/sql" element={<SqlViewer />} />
            <Route path="/settings" element={<Settings />} />
          </Routes>
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

    </div>
  )
}
