import { useState, useRef, useCallback, useMemo } from 'react'
import { Activity, ChevronDown, ChevronUp, Clock } from 'lucide-react'
import { formatNumber } from '../lib/constants'

const CHART_H = 56
const POINT_STEP = 52
const PAD_X = 20
const PAD_Y = 6
const BUCKET_MINUTES = 5
const BUCKET_MSG_COUNT = 8

const AVG_TOKEN_SPEED = 80

function formatDuration(ms) {
  if (ms < 60000) return `${Math.round(ms / 1000)}s`
  const mins = Math.floor(ms / 60000)
  if (mins < 60) return `${mins}m`
  const hrs = Math.floor(mins / 60)
  const rem = mins % 60
  return rem > 0 ? `${hrs}h ${rem}m` : `${hrs}h`
}

function lerp(a, b, t) {
  return a + (b - a) * Math.max(0, Math.min(1, t))
}

function tokenColor(ratio) {
  const r = Math.round(lerp(52, 239, ratio))
  const g = Math.round(lerp(211, 68, ratio))
  const b = Math.round(lerp(153, 68, ratio))
  return `rgb(${r},${g},${b})`
}

function buildTimeBuckets(messages, createdAt, lastUpdatedAt) {
  const start = new Date(createdAt).getTime()
  const end = new Date(lastUpdatedAt).getTime()
  const duration = Math.max(end - start, 1)
  const bucketMs = BUCKET_MINUTES * 60 * 1000
  const bucketCount = Math.max(1, Math.ceil(duration / bucketMs))

  const buckets = Array.from({ length: bucketCount }, (_, i) => ({
    label: `${i * BUCKET_MINUTES}m`,
    tokens: 0,
    messageIndices: [],
  }))

  messages.forEach((msg, idx) => {
    const totalTokens = (msg.inputTokens || 0) + (msg.outputTokens || 0)
    const msgTime = start + (idx / Math.max(messages.length - 1, 1)) * duration
    const bucketIdx = Math.min(Math.floor((msgTime - start) / bucketMs), bucketCount - 1)
    buckets[bucketIdx].tokens += totalTokens
    buckets[bucketIdx].messageIndices.push(idx)
  })

  return buckets
}

function buildSeqBuckets(messages) {
  const bucketCount = Math.max(1, Math.ceil(messages.length / BUCKET_MSG_COUNT))

  const buckets = Array.from({ length: bucketCount }, () => ({
    label: '',
    tokens: 0,
    messageIndices: [],
  }))

  messages.forEach((msg, idx) => {
    const chars = typeof msg.content === 'string' ? msg.content.length : 0
    const totalTokens = Math.round(chars / 4)
    const bucketIdx = Math.min(Math.floor(idx / BUCKET_MSG_COUNT), bucketCount - 1)
    buckets[bucketIdx].tokens += totalTokens
    buckets[bucketIdx].messageIndices.push(idx)
  })

  return buckets
}

export default function TokenTimeline({ messages, createdAt, lastUpdatedAt, onScrollToMessage }) {
  const [open, setOpen] = useState(true)
  const [hoveredIdx, setHoveredIdx] = useState(null)
  const scrollContainerRef = useRef(null)

  const hasRealTokens = useMemo(() => {
    if (!messages) return false
    return messages.some(m => (m.inputTokens || 0) + (m.outputTokens || 0) > 0)
  }, [messages])

  const buckets = useMemo(() => {
    if (!messages || messages.length === 0) return []
    if (hasRealTokens) return buildTimeBuckets(messages, createdAt, lastUpdatedAt)
    return buildSeqBuckets(messages)
  }, [messages, createdAt, lastUpdatedAt, hasRealTokens])

  const maxTokens = useMemo(() => Math.max(...buckets.map(b => b.tokens), 1), [buckets])

  const totalTokens = useMemo(() => buckets.reduce((s, b) => s + b.tokens, 0), [buckets])

  const durationLabel = useMemo(() => {
    if (hasRealTokens && createdAt && lastUpdatedAt) {
      const ms = new Date(lastUpdatedAt).getTime() - new Date(createdAt).getTime()
      if (ms > 0) return formatDuration(ms)
    }
    if (totalTokens > 0) {
      const estSeconds = totalTokens / AVG_TOKEN_SPEED
      return '~' + formatDuration(estSeconds * 1000)
    }
    return null
  }, [hasRealTokens, createdAt, lastUpdatedAt, totalTokens])

  const handlePointClick = useCallback((bucket) => {
    if (bucket.messageIndices.length > 0 && onScrollToMessage) {
      onScrollToMessage(bucket.messageIndices[0])
    }
  }, [onScrollToMessage])

  if (!messages || messages.length === 0 || totalTokens === 0) return null

  const svgW = PAD_X * 2 + Math.max((buckets.length - 1) * POINT_STEP, 0)
  const svgH = CHART_H + PAD_Y * 2 + (hasRealTokens ? 16 : 4)

  const points = buckets.map((b, i) => {
    const x = PAD_X + i * POINT_STEP
    const ratio = b.tokens / maxTokens
    const y = PAD_Y + CHART_H - ratio * CHART_H
    return { x, y, ratio, bucket: b }
  })

  const linePath = points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x} ${p.y}`).join(' ')

  const areaPath = points.length > 0
    ? `${linePath} L ${points[points.length - 1].x} ${PAD_Y + CHART_H} L ${points[0].x} ${PAD_Y + CHART_H} Z`
    : ''

  return (
    <div className="shrink-0" style={{ borderBottom: '1px solid var(--c-border)' }}>
      {/* Toggle button */}
      <button
        onClick={() => setOpen(o => !o)}
        className="flex items-center gap-2 w-full px-4 py-1.5 text-[11px] transition hover:bg-[var(--c-bg3)]"
        style={{ color: 'var(--c-text2)' }}
      >
        <Activity size={12} style={{ color: 'var(--c-accent)' }} />
        <span className="font-medium">Token Timeline</span>
        <span style={{ color: 'var(--c-text3)' }}>
          ({formatNumber(totalTokens)} tokens{!hasRealTokens ? ', est.' : ''})
        </span>
        {durationLabel && (
          <span className="inline-flex items-center gap-1" style={{ color: 'var(--c-text3)' }}>
            <Clock size={10} /> {durationLabel}
          </span>
        )}
        <span className="ml-auto">
          {open ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
        </span>
      </button>

      {/* Collapsible chart area */}
      {open && (
        <div className="px-2 pb-2 pt-0">
          <div
            ref={scrollContainerRef}
            className="overflow-x-auto scrollbar-thin"
            style={{ scrollBehavior: 'smooth' }}
          >
            <svg
              width={svgW}
              height={svgH}
              style={{ display: 'block', minWidth: svgW }}
            >
              <defs>
                <linearGradient id="tokenAreaGrad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="var(--c-accent)" stopOpacity="0.15" />
                  <stop offset="100%" stopColor="var(--c-accent)" stopOpacity="0.02" />
                </linearGradient>
              </defs>

              {/* Baseline */}
              <line
                x1={PAD_X} y1={PAD_Y + CHART_H}
                x2={PAD_X + (buckets.length - 1) * POINT_STEP} y2={PAD_Y + CHART_H}
                stroke="var(--c-border)" strokeWidth="1"
              />

              {/* Area fill */}
              {areaPath && <path d={areaPath} fill="url(#tokenAreaGrad)" />}

              {/* Line */}
              {points.length > 1 && (
                <path d={linePath} fill="none" stroke="var(--c-accent)" strokeWidth="1.5" strokeLinejoin="round" />
              )}

              {/* Data points + labels */}
              {points.map((p, i) => {
                const isHovered = hoveredIdx === i
                const color = tokenColor(p.ratio)
                return (
                  <g
                    key={i}
                    style={{ cursor: p.bucket.tokens > 0 ? 'pointer' : 'default' }}
                    onMouseEnter={() => setHoveredIdx(i)}
                    onMouseLeave={() => setHoveredIdx(null)}
                    onClick={() => handlePointClick(p.bucket)}
                  >
                    <circle cx={p.x} cy={p.y} r={12} fill="transparent" />

                    <circle
                      cx={p.x} cy={p.y}
                      r={isHovered ? 5 : 3}
                      fill={p.bucket.tokens > 0 ? color : 'var(--c-border)'}
                      stroke={isHovered ? 'var(--c-white)' : 'none'}
                      strokeWidth={1.5}
                      style={{ transition: 'r 0.15s' }}
                    />

                    {isHovered && (
                      <line
                        x1={p.x} y1={p.y} x2={p.x} y2={PAD_Y + CHART_H}
                        stroke="var(--c-text3)" strokeWidth="0.5" strokeDasharray="2,2"
                      />
                    )}

                    {isHovered && p.bucket.tokens > 0 && (
                      <g>
                        <rect
                          x={p.x - 32} y={p.y - 22}
                          width={64} height={16} rx={3}
                          fill="var(--c-bg)" stroke="var(--c-border)" strokeWidth="0.5"
                        />
                        <text
                          x={p.x} y={p.y - 11}
                          textAnchor="middle" fontSize="9" fontFamily="monospace"
                          fill="var(--c-white)"
                        >
                          {formatNumber(p.bucket.tokens)} tok
                        </text>
                      </g>
                    )}

                    {/* X label — only for time-based buckets */}
                    {hasRealTokens && p.bucket.label && (
                      <text
                        x={p.x} y={PAD_Y + CHART_H + 12}
                        textAnchor="middle" fontSize="9" fontFamily="monospace"
                        fill="var(--c-text3)"
                      >
                        {p.bucket.label}
                      </text>
                    )}
                  </g>
                )
              })}
            </svg>
          </div>
        </div>
      )}
    </div>
  )
}
