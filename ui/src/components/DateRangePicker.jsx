import { useState, useEffect, useRef } from 'react'
import { Calendar, ChevronDown, X } from 'lucide-react'
import { useTheme } from '../lib/theme'
import { toLocalDateString } from '../lib/constants'

const PRESETS = [
  { label: '7d',  days: 7 },
  { label: '30d', days: 30 },
  { label: '90d', days: 90 },
  { label: '1y',  days: 365 },
]

// Short ranges shown in the quick-range dropdown; like PRESETS they end today
const QUICK_PRESETS = [
  { label: 'today',     days: 0 },
  { label: 'yesterday', days: 1 },
]

function quickRanges(now = new Date()) {
  return QUICK_PRESETS.map(q => ({
    label: q.label,
    from: toLocalDateString(new Date(now.getFullYear(), now.getMonth(), now.getDate() - q.days)),
    to: toLocalDateString(now),
  }))
}

// value: { from: 'YYYY-MM-DD', to: 'YYYY-MM-DD' } | null
// onChange: called with same shape, or null to clear
export default function DateRangePicker({ value, onChange }) {
  const { dark } = useTheme()
  const today = toLocalDateString()
  const active = !!value
  const [menuOpen, setMenuOpen] = useState(false)
  const menuRef = useRef(null)
  const quick = quickRanges()
  const activeQuick = active ? quick.find(q => q.from === value.from && q.to === value.to) : null

  useEffect(() => {
    if (!menuOpen) return
    const close = e => { if (!menuRef.current?.contains(e.target)) setMenuOpen(false) }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [menuOpen])

  function applyPreset(days) {
    const to = new Date()
    const from = new Date(to.getFullYear(), to.getMonth(), to.getDate() - days)
    onChange({
      from: toLocalDateString(from),
      to: toLocalDateString(to),
    })
  }

  function setFrom(from) {
    onChange({ from, to: value?.to || today })
  }

  function setTo(to) {
    onChange({ from: value?.from || today, to })
  }

  return (
    <div className="flex items-center gap-1.5 flex-wrap">
      <Calendar size={12} style={{ color: active ? 'var(--c-accent)' : 'var(--c-text3)', flexShrink: 0 }} />

      {/* Quick-range dropdown */}
      <div ref={menuRef} className="relative">
        <button
          onClick={() => setMenuOpen(o => !o)}
          className="flex items-center gap-1 px-2 py-0.5 text-[11px] transition"
          style={{
            border: activeQuick ? '1px solid var(--c-accent)' : '1px solid var(--c-border)',
            color: activeQuick ? 'var(--c-accent)' : 'var(--c-text2)',
            background: activeQuick ? 'rgba(99,102,241,0.1)' : 'transparent',
          }}
        >
          {activeQuick ? activeQuick.label : 'today'} <ChevronDown size={10} />
        </button>
        {menuOpen && (
          <div
            className="absolute left-0 top-full mt-1 z-20 py-1 min-w-[110px]"
            style={{ background: 'var(--c-bg2)', border: '1px solid var(--c-border)' }}
          >
            {quick.map(q => (
              <button
                key={q.label}
                onClick={() => { onChange({ from: q.from, to: q.to }); setMenuOpen(false) }}
                className="block w-full text-left px-2.5 py-1 text-[11px] transition hover:opacity-80"
                style={{ color: activeQuick?.label === q.label ? 'var(--c-accent)' : 'var(--c-text2)' }}
              >
                {q.label}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Preset buttons */}
      {PRESETS.map(p => {
        const isActive = active && value.to === today && (() => {
          const diff = Math.round((Date.now() - new Date(value.from).getTime()) / 86400000)
          return diff >= p.days - 1 && diff <= p.days + 1
        })()
        return (
          <button
            key={p.label}
            onClick={() => applyPreset(p.days)}
            className="px-2 py-0.5 text-[11px] transition"
            style={{
              border: isActive ? '1px solid var(--c-accent)' : '1px solid var(--c-border)',
              color: isActive ? 'var(--c-accent)' : 'var(--c-text2)',
              background: isActive ? 'rgba(99,102,241,0.1)' : 'transparent',
            }}
          >
            {p.label}
          </button>
        )
      })}

      {/* Custom date inputs */}
      <input
        type="date"
        value={value?.from || ''}
        max={value?.to || today}
        onChange={e => setFrom(e.target.value)}
        className="px-1.5 py-0.5 text-[11px] outline-none cursor-pointer"
        style={{
          background: 'var(--c-bg3)',
          color: 'var(--c-text)',
          border: '1px solid var(--c-border)',
          colorScheme: dark ? 'dark' : 'light',
        }}
      />
      <span className="text-[11px]" style={{ color: 'var(--c-text3)' }}>—</span>
      <input
        type="date"
        value={value?.to || ''}
        min={value?.from || ''}
        max={today}
        onChange={e => setTo(e.target.value)}
        className="px-1.5 py-0.5 text-[11px] outline-none cursor-pointer"
        style={{
          background: 'var(--c-bg3)',
          color: 'var(--c-text)',
          border: '1px solid var(--c-border)',
          colorScheme: dark ? 'dark' : 'light',
        }}
      />

      {/* Clear button */}
      {active && (
        <button
          onClick={() => onChange(null)}
          className="flex items-center gap-0.5 px-2 py-0.5 text-[11px] transition"
          style={{ border: '1px solid var(--c-accent)', color: 'var(--c-accent)' }}
        >
          <X size={9} /> clear
        </button>
      )}
    </div>
  )
}

