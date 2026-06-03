import { useState, useEffect } from 'react'
import { CreditCard, RefreshCw, Clock, Zap, Shield, ChevronDown, ChevronUp } from 'lucide-react'
import { fetchUsage } from '../lib/api'
import { editorLabel, editorColor } from '../lib/constants'
import EditorIcon from '../components/EditorIcon'
import AnimatedLoader from '../components/AnimatedLoader'
import PageHeader from '../components/PageHeader'

function UsageBar({ value, max = 100, color, label }) {
  const pct = max > 0 ? Math.min((value / max) * 100, 100) : 0
  return (
    <div>
      {label && <div className="flex items-center justify-between mb-1">
        <span className="text-[10px]" style={{ color: 'var(--c-text2)' }}>{label}</span>
        <span className="text-[10px] font-mono" style={{ color: 'var(--c-white)' }}>{typeof value === 'number' ? value.toFixed(1) : value}%</span>
      </div>}
      <div className="h-1.5 w-full" style={{ background: 'var(--c-bg3)' }}>
        <div className="h-full transition-all duration-500" style={{ width: `${pct}%`, background: color || '#6366f1' }} />
      </div>
    </div>
  )
}

function TimeUntil({ date }) {
  if (!date) return null
  const d = new Date(date)
  const now = new Date()
  const diff = d - now
  if (diff <= 0) return <span className="text-[10px]" style={{ color: 'var(--c-text3)' }}>expired</span>
  const hours = Math.floor(diff / 3600000)
  const mins = Math.floor((diff % 3600000) / 60000)
  if (hours > 24) {
    const days = Math.floor(hours / 24)
    return <span className="text-[10px]" style={{ color: 'var(--c-text3)' }}>resets in {days}d {hours % 24}h</span>
  }
  return <span className="text-[10px]" style={{ color: 'var(--c-text3)' }}>resets in {hours}h {mins}m</span>
}

function PlanBadge({ name }) {
  if (!name) return null
  const n = (name || '').toLowerCase()
  let bg = 'rgba(99,102,241,0.12)'
  let fg = '#818cf8'
  if (n.includes('pro')) { bg = 'rgba(168,85,247,0.12)'; fg = '#a855f7' }
  if (n.includes('max') || n.includes('ultra')) { bg = 'rgba(234,179,8,0.12)'; fg = '#eab308' }
  if (n.includes('plus')) { bg = 'rgba(34,197,94,0.12)'; fg = '#22c55e' }
  if (n.includes('free')) { bg = 'rgba(107,114,128,0.12)'; fg = '#6b7280' }
  return (
    <span className="text-[10px] font-bold uppercase tracking-wider px-2 py-0.5" style={{ background: bg, color: fg }}>
      {name}
    </span>
  )
}

function FeaturePill({ label, enabled }) {
  return (
    <span
      className="text-[10px] px-1.5 py-0.5"
      style={{
        background: enabled ? 'rgba(34,197,94,0.08)' : 'rgba(107,114,128,0.06)',
        color: enabled ? '#22c55e' : 'var(--c-text3)',
        border: `1px solid ${enabled ? 'rgba(34,197,94,0.15)' : 'var(--c-border)'}`,
      }}
    >
      {label}
    </span>
  )
}

// ── Card renderers per source type ──

function CursorCard({ data }) {
  const usage = data.usage || {}
  const models = Object.keys(usage)
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 flex-wrap">
        <PlanBadge name={data.plan?.name} />
        {data.plan?.status && <span className="text-[10px]" style={{ color: data.plan.status === 'active' ? '#22c55e' : 'var(--c-text3)' }}>● {data.plan.status}</span>}
        {data.plan?.isYearlyPlan && <span className="text-[10px]" style={{ color: 'var(--c-text3)' }}>yearly</span>}
      </div>
      {data.startOfMonth && (
        <div className="text-[10px]" style={{ color: 'var(--c-text3)' }}>
          <Clock size={9} className="inline mr-1" />
          billing started {new Date(data.startOfMonth).toLocaleDateString()}
        </div>
      )}
      {models.length > 0 && (
        <div className="space-y-1.5">
          <div className="text-[10px] font-medium" style={{ color: 'var(--c-text2)' }}>model usage</div>
          {models.map(m => {
            const u = usage[m]
            const pct = u.maxRequestUsage ? Math.round((u.numRequests / u.maxRequestUsage) * 100) : null
            return (
              <div key={m} className="flex items-center justify-between text-[11px]">
                <span className="font-mono" style={{ color: 'var(--c-white)' }}>{m}</span>
                <span style={{ color: 'var(--c-text2)' }}>
                  {u.numRequests}{u.maxRequestUsage ? ` / ${u.maxRequestUsage}` : ''} requests
                </span>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

function DevinCard({ data }) {
  const u = data.usage || {}
  const billing = data.billingCycle || {}
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 flex-wrap">
        <PlanBadge name={data.plan?.name} />
        {data.user?.name && <span className="text-[10px]" style={{ color: 'var(--c-text3)' }}>{data.user.name}</span>}
      </div>

      {/* Credits */}
      <div className="space-y-2">
        {u.promptCredits && (
          <div>
            <div className="flex justify-between text-[10px] mb-0.5">
              <span style={{ color: 'var(--c-text2)' }}>prompt credits</span>
              <span className="font-mono" style={{ color: 'var(--c-white)' }}>{u.promptCredits.remaining} / {u.promptCredits.allocated}</span>
            </div>
            <UsageBar value={u.promptCredits.allocated > 0 ? ((u.promptCredits.remaining / u.promptCredits.allocated) * 100) : 0} color="#06b6d4" />
          </div>
        )}
        {u.flexCredits && u.flexCredits.allocated > 0 && (
          <div>
            <div className="flex justify-between text-[10px] mb-0.5">
              <span style={{ color: 'var(--c-text2)' }}>flex credits</span>
              <span className="font-mono" style={{ color: 'var(--c-white)' }}>{u.flexCredits.remaining} / {u.flexCredits.allocated}</span>
            </div>
            <UsageBar value={u.flexCredits.allocated > 0 ? ((u.flexCredits.remaining / u.flexCredits.allocated) * 100) : 0} color="#a78bfa" />
          </div>
        )}
        {u.totalRemainingCredits != null && (
          <div className="flex items-center justify-between pt-1" style={{ borderTop: '1px solid var(--c-border)' }}>
            <span className="text-[10px] font-medium" style={{ color: 'var(--c-text2)' }}>total remaining</span>
            <span className="text-[13px] font-bold font-mono" style={{ color: 'var(--c-white)' }}>{u.totalRemainingCredits}</span>
          </div>
        )}
      </div>

      {/* Billing */}
      {(billing.start || billing.end) && (
        <div className="text-[10px]" style={{ color: 'var(--c-text3)' }}>
          <Clock size={9} className="inline mr-1" />
          {billing.start && new Date(billing.start).toLocaleDateString()} → {billing.end && new Date(billing.end).toLocaleDateString()}
        </div>
      )}

      {/* Features */}
      {data.features && (
        <div className="flex flex-wrap gap-1">
          {Object.entries(data.features).map(([k, v]) => (
            <FeaturePill key={k} label={k.replace(/([A-Z])/g, ' $1').trim()} enabled={v} />
          ))}
        </div>
      )}
    </div>
  )
}

function ClaudeCodeCard({ data }) {
  const u = data.usage || {}
  return (
    <div className="space-y-3">
      <PlanBadge name={data.plan?.name} />

      <div className="space-y-2">
        {u.fiveHour && (
          <div>
            <UsageBar value={u.fiveHour.utilization} color={u.fiveHour.utilization > 80 ? '#ef4444' : '#f97316'} label="5-hour limit" />
            <TimeUntil date={u.fiveHour.resetsAt} />
          </div>
        )}
        {u.sevenDay && (
          <div>
            <UsageBar value={u.sevenDay.utilization} color={u.sevenDay.utilization > 80 ? '#ef4444' : '#f97316'} label="7-day limit" />
            <TimeUntil date={u.sevenDay.resetsAt} />
          </div>
        )}
        {u.sevenDaySonnet && (
          <div>
            <UsageBar value={u.sevenDaySonnet.utilization} color="#a78bfa" label="7-day Sonnet" />
            <TimeUntil date={u.sevenDaySonnet.resetsAt} />
          </div>
        )}
        {u.sevenDayOpus && (
          <div>
            <UsageBar value={u.sevenDayOpus.utilization} color="#c084fc" label="7-day Opus" />
            <TimeUntil date={u.sevenDayOpus.resetsAt} />
          </div>
        )}
      </div>

      {data.extraUsage && (
        <div className="text-[10px] flex items-center gap-1.5" style={{ color: 'var(--c-text3)' }}>
          <Zap size={9} />
          extra usage: {data.extraUsage.isEnabled ? (
            <span style={{ color: '#22c55e' }}>enabled{data.extraUsage.utilization != null ? ` (${data.extraUsage.utilization}% used)` : ''}</span>
          ) : (
            <span>disabled</span>
          )}
        </div>
      )}
    </div>
  )
}

function CopilotCard({ data }) {
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 flex-wrap">
        <PlanBadge name={data.plan?.name} />
        {data.plan?.individual && <span className="text-[10px]" style={{ color: 'var(--c-text3)' }}>individual</span>}
      </div>

      {data.user?.login && (
        <div className="text-[10px]" style={{ color: 'var(--c-text3)' }}>
          @{data.user.login}
        </div>
      )}

      {data.features && (
        <div className="flex flex-wrap gap-1">
          {Object.entries(data.features).map(([k, v]) => (
            <FeaturePill key={k} label={k.replace(/([A-Z])/g, ' $1').trim()} enabled={v} />
          ))}
        </div>
      )}

      {data.limits?.quotas && (
        <div className="text-[10px]" style={{ color: 'var(--c-text2)' }}>
          <Shield size={9} className="inline mr-1" />
          quotas: {JSON.stringify(data.limits.quotas)}
          {data.limits.resetDate && <span> (resets {new Date(data.limits.resetDate).toLocaleDateString()})</span>}
        </div>
      )}
    </div>
  )
}

function CodexCard({ data }) {
  const sub = data.plan || {}
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 flex-wrap">
        <PlanBadge name={sub.name} />
        {data.authMode && <span className="text-[10px]" style={{ color: 'var(--c-text3)' }}>via {data.authMode}</span>}
      </div>

      {data.user?.email && (
        <div className="text-[10px]" style={{ color: 'var(--c-text3)' }}>
          {data.user.email}
        </div>
      )}

      {(sub.subscriptionStart || sub.subscriptionEnd) && (
        <div className="text-[10px]" style={{ color: 'var(--c-text3)' }}>
          <Clock size={9} className="inline mr-1" />
          {sub.subscriptionStart && new Date(sub.subscriptionStart).toLocaleDateString()} → {sub.subscriptionEnd && new Date(sub.subscriptionEnd).toLocaleDateString()}
        </div>
      )}
    </div>
  )
}

function GenericCard({ data }) {
  return (
    <div className="space-y-2">
      {data.plan?.name && <PlanBadge name={data.plan.name} />}
      {data.user && (
        <div className="text-[10px]" style={{ color: 'var(--c-text3)' }}>
          {data.user.email || data.user.login || data.user.name || data.user.id || ''}
        </div>
      )}
      <pre className="text-[10px] overflow-auto p-2" style={{ background: 'var(--c-bg3)', color: 'var(--c-text2)', maxHeight: 120 }}>
        {JSON.stringify(data, null, 2)}
      </pre>
    </div>
  )
}

function EditorCard({ data }) {
  const [expanded, setExpanded] = useState(false)
  const source = data.source
  const color = editorColor(source)
  const label = editorLabel(source)

  const cardRenderer = () => {
    switch (source) {
      case 'cursor': return <CursorCard data={data} />
      case 'devin': case 'devin-next': case 'antigravity': return <DevinCard data={data} />
      case 'claude-code': return <ClaudeCodeCard data={data} />
      case 'vscode': case 'vscode-insiders': return <CopilotCard data={data} />
      case 'copilot-cli': return <CopilotCard data={data} />
      case 'codex': return <CodexCard data={data} />
      default: return <GenericCard data={data} />
    }
  }

  // Models list (Devin variants)
  const models = data.models || []

  return (
    <div className="card p-4 space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <EditorIcon source={source} size={20} />
          <span className="text-[13px] font-bold" style={{ color: 'var(--c-white)' }}>{label}</span>
        </div>
        <div className="w-1.5 h-1.5 rounded-full" style={{ background: color }} />
      </div>

      {cardRenderer()}

      {/* Expandable models list */}
      {models.length > 0 && (
        <div>
          <button
            onClick={() => setExpanded(!expanded)}
            className="flex items-center gap-1 text-[10px] transition hover:opacity-80"
            style={{ color: 'var(--c-text2)' }}
          >
            {expanded ? <ChevronUp size={10} /> : <ChevronDown size={10} />}
            {models.length} models
          </button>
          {expanded && (
            <div className="mt-2 space-y-1">
              {models.map((m, i) => (
                <div key={i} className="flex items-center justify-between text-[10px] py-0.5" style={{ borderBottom: '1px solid var(--c-border)' }}>
                  <span style={{ color: 'var(--c-white)' }}>{m.label || m.model}</span>
                  {m.remainingFraction != null && (
                    <span className="font-mono" style={{ color: m.remainingFraction > 0.5 ? '#22c55e' : m.remainingFraction > 0.2 ? '#eab308' : '#ef4444' }}>
                      {(m.remainingFraction * 100).toFixed(0)}%
                    </span>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

export default function Subscriptions() {
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  const load = () => {
    setLoading(true)
    setError(null)
    fetchUsage()
      .then(d => { setData(d); setLoading(false) })
      .catch(e => { setError(e.message); setLoading(false) })
  }

  useEffect(() => { load() }, [])

  return (
    <div className="fade-in space-y-3">
      <PageHeader icon={CreditCard} title="Subscriptions">
        <button
          onClick={load}
          disabled={loading}
          className="flex items-center gap-1 px-2 py-0.5 text-[11px] transition hover:bg-[var(--c-card)]"
          style={{ color: 'var(--c-text2)', border: '1px solid var(--c-border)' }}
        >
          <RefreshCw size={10} className={loading ? 'animate-spin' : ''} />
          Refresh
        </button>
        {data && (
          <span className="text-[11px] ml-auto" style={{ color: 'var(--c-text3)' }}>
            {data.length} subscription{data.length !== 1 ? 's' : ''} detected
          </span>
        )}
      </PageHeader>

      {loading && !data && (
        <AnimatedLoader label="Loading subscriptions..." />
      )}

      {error && (
        <div className="text-[12px] px-3 py-2" style={{ background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.15)', color: '#ef4444' }}>
          {error}
        </div>
      )}

      {data && data.length === 0 && (
        <div className="text-sm py-12 text-center" style={{ color: 'var(--c-text3)' }}>
          No subscriptions detected. Make sure your editors are installed and logged in.
        </div>
      )}

      {data && data.length > 0 && (
        <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(340px, 1fr))' }}>
          {data.map((item, i) => (
            <EditorCard key={item.source + '-' + i} data={item} />
          ))}
        </div>
      )}
    </div>
  )
}
