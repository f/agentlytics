import { useState, useEffect, useRef, useCallback } from 'react'
import { X, Download, Send, Search } from 'lucide-react'
import { fetchChat, BASE } from '../lib/api'
import { editorColor, editorLabel, formatDateTime, formatNumber } from '../lib/constants'
import MessageContent, { ROLE_CONFIG } from './MessageRenderer'
import TokenTimeline from './TokenTimeline'

export default function ChatSidebar({ chatId, onClose, fetchFn, extraHeader, username }) {
  const [chat, setChat] = useState(null)
  const [loading, setLoading] = useState(true)
  const [msgFilter, setMsgFilter] = useState('')
  const scrollRef = useRef(null)
  const msgCountRef = useRef(0)

  useEffect(() => {
    if (!chatId) return
    setLoading(true)
    setChat(null)
    msgCountRef.current = 0
    const doFetch = fetchFn || fetchChat
    doFetch(chatId).then(data => {
      setChat(data)
      msgCountRef.current = data?.messages?.length || 0
      setLoading(false)
    })

    // Poll for new messages while sidebar is open
    const iv = setInterval(() => {
      doFetch(chatId).then(data => {
        if (data?.messages?.length !== msgCountRef.current) {
          msgCountRef.current = data?.messages?.length || 0
          setChat(data)
        }
      }).catch(() => {})
    }, 10000)
    return () => clearInterval(iv)
  }, [chatId, fetchFn])

  // Scroll to bottom when chat loads or new messages arrive
  useEffect(() => {
    if (!loading && chat && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [loading, chat])

  // Reset filter when chat changes
  useEffect(() => {
    setMsgFilter('')
  }, [chatId])

  const handleScrollToMessage = useCallback((msgIndex) => {
    if (!scrollRef.current) return
    const el = scrollRef.current.querySelector(`[data-msg-index="${msgIndex}"]`)
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' })
      el.style.outline = '1.5px solid var(--c-accent)'
      el.style.outlineOffset = '2px'
      setTimeout(() => { el.style.outline = 'none' }, 1500)
    }
  }, [])

  if (!chatId) return null

  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 z-40 transition-opacity"
        style={{ background: 'rgba(0,0,0,0.3)' }}
        onClick={onClose}
      />

      {/* Sidebar */}
      <div
        className="fixed top-0 right-0 bottom-0 z-50 flex flex-col shadow-2xl sidebar-slide-in"
        style={{
          width: 'min(580px, 90vw)',
          background: 'var(--c-bg)',
          borderLeft: '1px solid var(--c-border)',
        }}
      >
        {/* Header */}
        <div className="flex items-center gap-3 px-4 py-3 shrink-0" style={{ borderBottom: '1px solid var(--c-border)' }}>
          <button onClick={onClose} className="p-1 rounded transition hover:bg-[var(--c-bg3)]" style={{ color: 'var(--c-text2)' }}>
            <X size={14} />
          </button>
          {chat && (
            <div className="flex-1 min-w-0">
              <div className="text-sm font-medium truncate" style={{ color: 'var(--c-white)' }}>
                {chat.name || '(untitled)'}
              </div>
              <div className="flex items-center gap-2 text-[11px]" style={{ color: 'var(--c-text2)' }}>
                <span className="inline-flex items-center gap-1">
                  <span className="w-1.5 h-1.5 rounded-full" style={{ background: editorColor(chat.source) }} />
                  {editorLabel(chat.source)}
                </span>
                {chat.mode && <span>· {chat.mode}</span>}
                <span>{formatDateTime(chat.createdAt)}</span>
              </div>
            </div>
          )}
          {chat && !fetchFn && (
            <a
              href={`${BASE}/api/chats/${chat.id}/markdown`}
              download
              className="flex items-center gap-1 px-2 py-1 text-[11px] transition shrink-0"
              style={{ background: 'var(--c-bg3)', color: 'var(--c-text)', border: '1px solid var(--c-border)' }}
            >
              <Download size={11} /> .md
            </a>
          )}
          {extraHeader}
        </div>

        {/* Stats row */}
        {chat?.stats && (
          <div className="flex items-center gap-3 px-4 py-2 text-[11px] shrink-0" style={{ borderBottom: '1px solid var(--c-border)', color: 'var(--c-text2)' }}>
            <span>{chat.stats.totalMessages} msgs</span>
            {chat.stats.toolCalls?.length > 0 && <span>{chat.stats.toolCalls.length} tools</span>}
            {chat.stats.totalInputTokens > 0 && <span>{formatNumber(chat.stats.totalInputTokens)} in</span>}
            {chat.stats.totalOutputTokens > 0 && <span>{formatNumber(chat.stats.totalOutputTokens)} out</span>}
            {chat.createdAt && chat.lastUpdatedAt && (() => {
              const ms = new Date(chat.lastUpdatedAt).getTime() - new Date(chat.createdAt).getTime()
              if (ms <= 0) return null
              const mins = Math.floor(ms / 60000)
              const label = mins < 60 ? `${mins}m` : `${Math.floor(mins / 60)}h ${mins % 60}m`
              return <span>{label}</span>
            })()}
            {chat.stats.models?.length > 0 && (
              <span className="ml-auto font-mono truncate" style={{ color: 'var(--c-accent)', opacity: 0.7 }}>
                {[...new Set(chat.stats.models)].join(', ')}
              </span>
            )}
          </div>
        )}

        {/* Token Timeline */}
        {chat && chat.messages.length > 0 && (
          <TokenTimeline
            messages={chat.messages}
            createdAt={chat.createdAt}
            lastUpdatedAt={chat.lastUpdatedAt}
            onScrollToMessage={handleScrollToMessage}
          />
        )}

        {/* Search bar */}
        {chat && chat.messages.length > 0 && (
          <div className="shrink-0 px-4 py-2" style={{ borderBottom: '1px solid var(--c-border)' }}>
            <div className="relative">
              <Search size={11} className="absolute left-2.5 top-1/2 -translate-y-1/2" style={{ color: 'var(--c-text3)' }} />
              <input
                type="text"
                placeholder="Filter messages..."
                value={msgFilter}
                onChange={e => setMsgFilter(e.target.value)}
                className="w-full pl-7 pr-3 py-1 text-[12px] outline-none"
                style={{ background: 'var(--c-bg3)', color: 'var(--c-text)', border: '1px solid var(--c-border)' }}
              />
            </div>
          </div>
        )}

        {/* Messages */}
        <div ref={scrollRef} className="flex-1 overflow-y-auto scrollbar-thin px-4 py-3 space-y-2">
          {loading && (
            <div className="text-[12px] py-12 text-center" style={{ color: 'var(--c-text3)' }}>Loading conversation...</div>
          )}
          {!loading && chat && chat.messages.length === 0 && (
            <div className="text-[12px] py-12 text-center" style={{ color: 'var(--c-text3)' }}>
              {chat.encrypted ? '🔒 This conversation is encrypted.' : 'No messages found.'}
            </div>
          )}
          {!loading && chat && chat.messages
            .filter(msg => !msgFilter || msg.content.toLowerCase().includes(msgFilter.toLowerCase()))
            .map((msg, i) => {
              const cfg = ROLE_CONFIG[msg.role] || ROLE_CONFIG.system
              const Icon = cfg.icon
              return (
                <div key={i} data-msg-index={i} className="rounded-r px-3 py-2" style={{ borderLeft: `2px solid ${cfg.borderColor}`, background: cfg.bg, transition: 'outline 0.3s' }}>
                  <div className="flex items-center gap-1.5 text-[11px] mb-1" style={{ color: 'var(--c-text2)' }}>
                    <Icon size={11} />
                    <span className="font-medium">{msg.role === 'user' && (username || chat?.username) ? (username || chat.username) : cfg.label}</span>
                    {msg.model && <span className="font-mono" style={{ color: 'var(--c-accent)', opacity: 0.6 }}>· {msg.model}</span>}
                  </div>
                  <div className="text-[12px]" style={{ color: 'var(--c-text)' }}>
                    <MessageContent content={msg.content} toolCallDetails={chat.toolCallDetails || []} />
                  </div>
                </div>
              )
            })}
        </div>

        {/* Fake disabled chat input */}
        <div className="shrink-0 px-4 py-3" style={{ borderTop: '1px solid var(--c-border)' }}>
          <div
            className="flex items-center gap-2 px-3 py-2.5 rounded-lg"
            style={{
              background: 'var(--c-bg3)',
              border: '1px solid var(--c-border)',
              opacity: 0.5,
              cursor: 'not-allowed',
            }}
          >
            <span className="flex-1 text-[12px]" style={{ color: 'var(--c-text3)' }}>
              Message is read-only...
            </span>
            <Send size={13} style={{ color: 'var(--c-text3)' }} />
          </div>
        </div>
      </div>
    </>
  )
}
