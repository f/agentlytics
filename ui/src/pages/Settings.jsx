import { useState, useEffect } from 'react'
import { Settings as SettingsIcon, EyeOff, Eye, FolderOpen, Search, ShieldCheck, ShieldOff, AlertTriangle, X } from 'lucide-react'
import { fetchConfig, updateConfig, fetchAllProjects } from '../lib/api'
import { editorLabel, formatNumber, formatDate } from '../lib/constants'
import EditorIcon from '../components/EditorIcon'
import SectionTitle from '../components/SectionTitle'
import AnimatedLoader from '../components/AnimatedLoader'
import PageHeader from '../components/PageHeader'

export default function Settings() {
  const [config, setConfig] = useState(null)
  const [projects, setProjects] = useState([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [search, setSearch] = useState('')
  const [showConfirm, setShowConfirm] = useState(false)

  useEffect(() => {
    Promise.all([fetchConfig(), fetchAllProjects()]).then(([cfg, projs]) => {
      setConfig(cfg)
      setProjects(projs)
      setLoading(false)
    }).catch(() => setLoading(false))
  }, [])

  if (loading || !config) {
    return <AnimatedLoader label="Loading settings..." />
  }

  const hiddenProjects = config.hiddenProjects || []

  const toggleProject = async (folder) => {
    setSaving(true)
    const isHidden = hiddenProjects.includes(folder)
    const updated = isHidden
      ? hiddenProjects.filter(f => f !== folder)
      : [...hiddenProjects, folder]
    const newConfig = await updateConfig({ hiddenProjects: updated })
    setConfig(newConfig)
    setSaving(false)
  }

  const filtered = projects.filter(p => {
    if (!search) return true
    const q = search.toLowerCase()
    return p.folder.toLowerCase().includes(q) || p.name.toLowerCase().includes(q)
  })

  const sorted = [...filtered].sort((a, b) => a.name.localeCompare(b.name))

  const subscriptionAccess = !!config.allowSubscriptionAccess

  const toggleSubscriptionAccess = async () => {
    setSaving(true)
    const newConfig = await updateConfig({ allowSubscriptionAccess: !subscriptionAccess })
    setConfig(newConfig)
    setSaving(false)
    setShowConfirm(false)
  }

  return (
    <div className="fade-in space-y-3">
      <PageHeader icon={SettingsIcon} title="Settings" />

      <div className="card overflow-hidden">
        <div className="px-3 py-2 flex items-center justify-between" style={{ borderBottom: '1px solid var(--c-border)' }}>
          <SectionTitle>
            {subscriptionAccess ? <ShieldCheck size={11} className="inline mr-1" /> : <ShieldOff size={11} className="inline mr-1" />}
            subscription access
          </SectionTitle>
          <button
            onClick={() => setShowConfirm(true)}
            disabled={saving}
            className="text-[11px] px-2 py-0.5 rounded transition"
            style={{
              background: subscriptionAccess ? 'rgba(34,197,94,0.08)' : 'rgba(239,68,68,0.08)',
              color: subscriptionAccess ? '#22c55e' : '#ef4444',
              border: `1px solid ${subscriptionAccess ? 'rgba(34,197,94,0.15)' : 'rgba(239,68,68,0.15)'}`,
            }}
          >
            {subscriptionAccess ? 'Enabled' : 'Disabled'}
          </button>
        </div>
        <div className="text-[11px] px-3 py-2" style={{ color: 'var(--c-text3)' }}>
          When enabled, Agentlytics reads locally stored auth tokens (Keychain, SQLite, config files) to show your plan and usage info for each editor.
          Tokens are kept in-memory only and <span style={{ color: 'var(--c-text2)' }}>never sent to any third-party service</span>.
        </div>
      </div>

      <div className="card overflow-hidden">
        <div className="px-3 py-2 flex items-center justify-between" style={{ borderBottom: '1px solid var(--c-border)' }}>
          <SectionTitle>
            <FolderOpen size={11} className="inline mr-1" />
            projects ({projects.length})
          </SectionTitle>
          <div className="flex items-center gap-2">
            {hiddenProjects.length > 0 && (
              <span className="text-[10px] px-1.5 py-0.5" style={{ background: 'rgba(239,68,68,0.08)', color: '#ef4444', border: '1px solid rgba(239,68,68,0.15)' }}>
                {hiddenProjects.length} hidden
              </span>
            )}
            <div className="relative">
              <Search size={11} className="absolute left-2 top-1/2 -translate-y-1/2" style={{ color: 'var(--c-text3)' }} />
              <input
                type="text"
                value={search}
                onChange={e => setSearch(e.target.value)}
                placeholder="Filter projects..."
                className="pl-6 pr-2 py-1 text-[11px] outline-none w-[180px]"
                style={{ background: 'var(--c-bg3)', color: 'var(--c-text)', border: '1px solid var(--c-border)' }}
              />
            </div>
          </div>
        </div>
        <div className="text-[11px] px-3 py-1.5" style={{ color: 'var(--c-text3)', borderBottom: '1px solid var(--c-border)', background: 'var(--c-bg3)' }}>
          Hidden projects are excluded from all dashboard stats, sessions, costs, and analytics.
        </div>

        {sorted.map(p => (
          <ProjectRow key={p.folder} project={p} hidden={hiddenProjects.includes(p.folder)} onToggle={toggleProject} saving={saving} />
        ))}

        {sorted.length === 0 && (
          <div className="text-center py-6 text-[12px]" style={{ color: 'var(--c-text3)' }}>no projects match filter</div>
        )}
      </div>
      {showConfirm && (
        <ConfirmModal
          enabling={!subscriptionAccess}
          saving={saving}
          onConfirm={toggleSubscriptionAccess}
          onCancel={() => setShowConfirm(false)}
        />
      )}
    </div>
  )
}

function ConfirmModal({ enabling, saving, onConfirm, onCancel }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center" style={{ background: 'rgba(0,0,0,0.6)' }} onClick={onCancel}>
      <div className="card w-[420px] mx-4" onClick={e => e.stopPropagation()} style={{ background: 'var(--c-bg2)', border: '1px solid var(--c-border)' }}>
        <div className="flex items-center justify-between px-4 py-3" style={{ borderBottom: '1px solid var(--c-border)' }}>
          <div className="flex items-center gap-2 text-[13px] font-medium" style={{ color: 'var(--c-white)' }}>
            <AlertTriangle size={14} style={{ color: enabling ? '#fbbf24' : '#ef4444' }} />
            {enabling ? 'Enable' : 'Disable'} Subscription Access
          </div>
          <button onClick={onCancel} className="p-1 rounded hover:bg-[var(--c-bg3)]" style={{ color: 'var(--c-text3)' }}>
            <X size={14} />
          </button>
        </div>
        <div className="px-4 py-3 text-[11px] space-y-2" style={{ color: 'var(--c-text2)' }}>
          {enabling ? (
            <>
              <p>This will allow Agentlytics to read locally stored auth tokens from:</p>
              <ul className="space-y-1 pl-3" style={{ color: 'var(--c-text3)' }}>
                <li>Claude Code &ndash; macOS Keychain / Linux secret-tool</li>
                <li>Cursor &ndash; local SQLite (state.vscdb)</li>
                <li>Copilot / VS Code &ndash; ~/.config/github-copilot/apps.json</li>
                <li>Codex &ndash; local auth.json (JWT decode only)</li>
                <li>Devin &ndash; local SQLite (state.vscdb)</li>
              </ul>
              <p style={{ color: 'var(--c-text2)' }}>Tokens are kept <strong>in-memory only</strong> and never sent to any third-party service.</p>
            </>
          ) : (
            <p>This will stop Agentlytics from reading any local auth tokens. Subscription and plan details will no longer be collected.</p>
          )}
        </div>
        <div className="flex justify-end gap-2 px-4 py-3" style={{ borderTop: '1px solid var(--c-border)' }}>
          <button
            onClick={onCancel}
            className="text-[11px] px-3 py-1 rounded transition"
            style={{ color: 'var(--c-text3)', border: '1px solid var(--c-border)' }}
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            disabled={saving}
            className="text-[11px] px-3 py-1 rounded transition font-medium"
            style={{
              background: enabling ? 'rgba(34,197,94,0.12)' : 'rgba(239,68,68,0.12)',
              color: enabling ? '#22c55e' : '#ef4444',
              border: `1px solid ${enabling ? 'rgba(34,197,94,0.2)' : 'rgba(239,68,68,0.2)'}`,
            }}
          >
            {saving ? 'Saving...' : enabling ? 'Yes, enable' : 'Yes, disable'}
          </button>
        </div>
      </div>
    </div>
  )
}

function ProjectRow({ project: p, hidden, onToggle, saving }) {
  const editors = Object.entries(p.editors || {}).sort((a, b) => b[1] - a[1])

  return (
    <div
      className="flex items-center gap-3 px-3 py-2 transition"
      style={{
        borderBottom: '1px solid var(--c-border)',
        opacity: hidden ? 0.5 : 1,
      }}
      onMouseEnter={e => e.currentTarget.style.background = 'var(--c-bg3)'}
      onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
    >
      <button
        onClick={() => onToggle(p.folder)}
        disabled={saving}
        className="shrink-0 p-1 rounded transition hover:bg-[var(--c-bg)]"
        style={{ color: hidden ? '#ef4444' : 'var(--c-text3)', border: '1px solid var(--c-border)' }}
        title={hidden ? 'Show this project' : 'Hide this project'}
      >
        {hidden ? <EyeOff size={12} /> : <Eye size={12} />}
      </button>
      <div className="min-w-0 flex-1">
        <div className="text-[12px] font-medium truncate" style={{ color: hidden ? 'var(--c-text3)' : 'var(--c-white)' }}>
          {p.name}
        </div>
        <div className="text-[10px] truncate" style={{ color: 'var(--c-text3)' }} title={p.folder}>
          {p.folder}
        </div>
      </div>
      <div className="flex items-center gap-2 shrink-0">
        {editors.slice(0, 3).map(([src, count]) => (
          <span key={src} className="flex items-center gap-1 text-[10px]" style={{ color: 'var(--c-text3)' }}>
            <EditorIcon source={src} size={10} />
            {count}
          </span>
        ))}
      </div>
      <div className="text-[11px] font-mono shrink-0" style={{ color: 'var(--c-text2)' }}>
        {formatNumber(p.totalSessions)}
      </div>
      <div className="text-[10px] shrink-0 w-[80px] text-right" style={{ color: 'var(--c-text3)' }}>
        {formatDate(p.lastSeen)}
      </div>
    </div>
  )
}
