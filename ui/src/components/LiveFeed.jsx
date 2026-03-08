import { useState, useEffect, useRef } from 'react'
import { Radio, MessageSquare, FolderOpen, Cpu } from 'lucide-react'
import EditorDot from './EditorDot'
import { editorLabel, formatNumber } from '../lib/constants'
import { fetchRelayFeed } from '../lib/api'

function timeLabel(ts) {
  if (!ts) return ''
  const d = new Date(ts)
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

export default function LiveFeed({ onSessionClick }) {
  const [items, setItems] = useState([])
  const scrollRef = useRef(null)

  useEffect(() => {
    const load = () => {
      fetchRelayFeed({ limit: 80 })
        .then(data => {
          if (Array.isArray(data)) setItems(data)
        })
        .catch(() => {})
    }
    load()
    const iv = setInterval(load, 10000)
    return () => clearInterval(iv)
  }, [])

  // Group items by relative time buckets
  const now = Date.now()
  const buckets = []
  let currentBucket = null

  for (const item of items) {
    const diff = now - item.lastUpdatedAt
    let label
    if (diff < 300000) label = 'Just now'
    else if (diff < 3600000) label = `${Math.floor(diff / 60000)} min ago`
    else if (diff < 86400000) label = `${Math.floor(diff / 3600000)}h ago`
    else label = new Date(item.lastUpdatedAt).toLocaleDateString()

    if (!currentBucket || currentBucket.label !== label) {
      currentBucket = { label, items: [] }
      buckets.push(currentBucket)
    }
    currentBucket.items.push(item)
  }

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center gap-2 px-3 py-2.5 shrink-0" style={{ borderBottom: '1px solid var(--c-border)' }}>
        <Radio size={12} style={{ color: '#22c55e' }} />
        <span className="text-[12px] font-medium uppercase tracking-wider" style={{ color: 'var(--c-text2)' }}>Live Feed</span>
        <span className="inline-block w-1.5 h-1.5 rounded-full pulse-dot ml-auto" style={{ background: '#22c55e' }} />
      </div>

      {/* Feed */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto scrollbar-thin">
        {items.length === 0 && (
          <div className="text-[12px] py-8 text-center" style={{ color: 'var(--c-text3)' }}>
            No recent activity
          </div>
        )}

        {buckets.map((bucket, bi) => (
          <div key={bi}>
            {/* Time separator */}
            <div className="sticky top-0 px-3 py-1.5 text-[10px] font-medium uppercase tracking-wider" style={{ background: 'var(--c-bg)', color: 'var(--c-text3)', borderBottom: '1px solid var(--c-border)' }}>
              {bucket.label}
            </div>

            {bucket.items.map((item) => (
              <div
                key={`${item.id}-${item.username}`}
                className="px-3 py-2.5 cursor-pointer transition hover:bg-[var(--c-card)]"
                style={{ borderBottom: '1px solid var(--c-border)' }}
                onClick={() => onSessionClick && onSessionClick(item.id, item.username)}
              >
                {/* Session name */}
                <div className="text-[12px] font-medium truncate mb-1" style={{ color: 'var(--c-white)' }}>
                  {item.name || 'Untitled'}
                </div>

                {/* User + editor row */}
                <div className="flex items-center gap-1.5 mb-1">
                  <span
                    className="text-[10px] font-medium px-1 py-0.5 shrink-0 truncate max-w-[120px]"
                    style={{ background: 'rgba(99,102,241,0.12)', color: '#818cf8' }}
                    title={item.username}
                  >
                    {item.username}
                  </span>
                  <EditorDot source={item.source} size={6} />
                  <span className="text-[10px] truncate" style={{ color: 'var(--c-text2)' }}>{editorLabel(item.source)}</span>
                  <span className="text-[10px] ml-auto shrink-0" style={{ color: 'var(--c-text3)' }}>{timeLabel(item.lastUpdatedAt)}</span>
                </div>

                {/* Meta row */}
                <div className="flex items-center gap-2 text-[10px]" style={{ color: 'var(--c-text3)' }}>
                  {item.totalMessages > 0 && (
                    <span className="flex items-center gap-0.5">
                      <MessageSquare size={8} /> {item.totalMessages}
                    </span>
                  )}
                  {item.folder && (
                    <span className="flex items-center gap-0.5 truncate">
                      <FolderOpen size={8} /> {item.folder.split('/').pop()}
                    </span>
                  )}
                  {item.mode && (
                    <span className="px-1 py-0" style={{ background: 'rgba(168,85,247,0.1)', color: '#a855f7' }}>{item.mode}</span>
                  )}
                  {item.models?.[0] && (
                    <span className="flex items-center gap-0.5 ml-auto truncate" style={{ color: '#818cf8' }}>
                      <Cpu size={8} /> {item.models[0]}
                    </span>
                  )}
                </div>
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  )
}
