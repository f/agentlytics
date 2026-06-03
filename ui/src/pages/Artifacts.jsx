import { useState, useEffect } from 'react'
import { FolderOpen, FileText, ChevronRight, ChevronDown, Search, Package, Clock, Hash, X, Code, Eye, DollarSign, Type } from 'lucide-react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { fetchArtifacts, fetchArtifactContent } from '../lib/api'
import { editorColor, editorLabel } from '../lib/constants'
import EditorIcon from '../components/EditorIcon'
import AnimatedLoader from '../components/AnimatedLoader'
import PageHeader from '../components/PageHeader'

const MONO = 'JetBrains Mono, monospace'

function formatSize(bytes) {
  if (bytes < 1024) return bytes + ' B'
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB'
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB'
}

function formatDate(ts) {
  if (!ts) return ''
  return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' })
}

function estimateTokens(text) {
  if (!text) return 0
  // ~4 chars per token is a reasonable approximation
  return Math.round(text.length / 4)
}

function formatTokens(n) {
  if (n < 1000) return String(n)
  if (n < 1000000) return (n / 1000).toFixed(1) + 'k'
  return (n / 1000000).toFixed(2) + 'M'
}

// Rough est. based on average input token pricing (~$3/1M tokens)
function estimateCost(tokens) {
  const cost = (tokens / 1000000) * 3
  if (cost < 0.001) return '<$0.001'
  if (cost < 0.01) return '$' + cost.toFixed(4)
  return '$' + cost.toFixed(3)
}

function getFileType(fileName) {
  if (!fileName) return 'text'
  const lower = fileName.toLowerCase()
  if (lower.endsWith('.json')) return 'json'
  if (lower.endsWith('.md') || lower.endsWith('.mdc')) return 'markdown'
  if (lower.endsWith('.yaml') || lower.endsWith('.yml')) return 'yaml'
  return 'text'
}

function JsonViewer({ content }) {
  let parsed
  try {
    parsed = JSON.parse(content)
  } catch {
    return <pre className="text-[12px] whitespace-pre-wrap break-words leading-relaxed" style={{ color: '#ef4444', fontFamily: MONO }}>Invalid JSON</pre>
  }

  const formatted = JSON.stringify(parsed, null, 2)

  return (
    <pre className="text-[12px] whitespace-pre-wrap break-words leading-relaxed" style={{ fontFamily: MONO }}>
      {formatted.split('\n').map((line, i) => {
        const parts = []
        let remaining = line

        // Highlight JSON keys
        const keyMatch = remaining.match(/^(\s*)"([^"]+)"(:)/)
        if (keyMatch) {
          parts.push(<span key={`i${i}`} style={{ color: 'var(--c-text3)' }}>{keyMatch[1]}</span>)
          parts.push(<span key={`k${i}`} style={{ color: '#818cf8' }}>"{keyMatch[2]}"</span>)
          parts.push(<span key={`c${i}`} style={{ color: 'var(--c-text3)' }}>:</span>)
          remaining = remaining.slice(keyMatch[0].length)
        }

        // Highlight values
        const strMatch = remaining.match(/^(\s*)"([^"]*)"(.*)/)
        if (strMatch) {
          parts.push(<span key={`sp${i}`}>{strMatch[1]}</span>)
          parts.push(<span key={`v${i}`} style={{ color: '#22c55e' }}>"{strMatch[2]}"</span>)
          parts.push(<span key={`r${i}`} style={{ color: 'var(--c-text3)' }}>{strMatch[3]}</span>)
        } else {
          // Numbers, booleans, null
          const valMatch = remaining.match(/^(\s*)(true|false|null|-?\d+\.?\d*)(.*)?/)
          if (valMatch) {
            parts.push(<span key={`sp${i}`}>{valMatch[1]}</span>)
            parts.push(<span key={`v${i}`} style={{ color: valMatch[2] === 'null' ? '#ef4444' : valMatch[2] === 'true' || valMatch[2] === 'false' ? '#f59e0b' : '#22d3ee' }}>{valMatch[2]}</span>)
            parts.push(<span key={`r${i}`} style={{ color: 'var(--c-text3)' }}>{valMatch[3] || ''}</span>)
          } else {
            parts.push(<span key={`x${i}`} style={{ color: 'var(--c-text3)' }}>{remaining}</span>)
          }
        }

        return <span key={i}>{parts}{'\n'}</span>
      })}
    </pre>
  )
}

function parseFrontmatter(raw) {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/)
  if (!match) return { frontmatter: null, body: raw }
  const entries = []
  const lines = match[1].split('\n')
  for (let i = 0; i < lines.length; i++) {
    const kv = lines[i].match(/^(\w[\w\-]*):\s*(.*)/)
    if (kv) {
      const key = kv[1]
      const inlineVal = kv[2].replace(/^["']|["']$/g, '').trim()
      if (inlineVal) {
        entries.push([key, inlineVal])
      } else {
        // Collect list items (could be simple strings, checkboxes, or YAML objects)
        const items = []
        while (i + 1 < lines.length && /^\s+-\s/.test(lines[i + 1])) {
          i++
          const item = lines[i].replace(/^\s+-\s*/, '')
          const checkMatch = item.match(/^\[([ xX])\]\s*(.*)/)
          if (checkMatch) {
            items.push({ type: 'checkbox', checked: checkMatch[1] !== ' ', text: checkMatch[2] })
          } else {
            // Could be start of a YAML object (e.g. "id: scaffold-core")
            const objKv = item.match(/^(\w[\w\-]*):\s*(.*)/)
            if (objKv) {
              const obj = { [objKv[1]]: objKv[2].replace(/^["']|["']$/g, '') }
              // Collect remaining properties of this object
              while (i + 1 < lines.length && /^\s{4,}\w/.test(lines[i + 1]) && !/^\s+-/.test(lines[i + 1])) {
                i++
                const propMatch = lines[i].trim().match(/^(\w[\w\-]*):\s*(.*)/)
                if (propMatch) obj[propMatch[1]] = propMatch[2].replace(/^["']|["']$/g, '')
              }
              items.push({ type: 'object', data: obj })
            } else {
              items.push({ type: 'text', text: item })
            }
          }
        }
        entries.push([key, items.length ? items : ''])
      }
    }
  }
  return { frontmatter: entries.length ? entries : null, body: match[2] }
}

const STATUS_STYLES = {
  completed: { bg: 'rgba(34,197,94,0.12)', color: '#22c55e', icon: '✓' },
  in_progress: { bg: 'rgba(99,102,241,0.12)', color: '#818cf8', icon: '◐' },
  pending: { bg: 'rgba(250,204,21,0.12)', color: '#facc15', icon: '○' },
  blocked: { bg: 'rgba(239,68,68,0.12)', color: '#ef4444', icon: '✕' },
}

function FrontmatterValue({ val }) {
  if (typeof val === 'string') return <span style={{ color: 'var(--c-text2)' }}>{val}</span>
  if (!Array.isArray(val)) return null

  // Check if items are YAML objects (e.g. todos with id/content/status)
  const hasObjects = val.some(item => item.type === 'object')
  if (hasObjects) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4, width: '100%' }}>
        {val.map((item, i) => {
          if (item.type !== 'object') return <span key={i} style={{ color: 'var(--c-text2)' }}>{item.text || ''}</span>
          const d = item.data
          const status = (d.status || '').toLowerCase().replace(/\s+/g, '_')
          const st = STATUS_STYLES[status] || STATUS_STYLES.pending
          const isComplete = status === 'completed'
          return (
            <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '3px 0' }}>
              <span style={{
                display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                width: 16, height: 16, borderRadius: 3, flexShrink: 0,
                background: st.bg, color: st.color, fontSize: 10, fontWeight: 700,
              }}>{st.icon}</span>
              <span style={{ color: 'var(--c-text2)', opacity: isComplete ? 0.55 : 1, textDecoration: isComplete ? 'line-through' : 'none', flex: 1 }}>
                {d.content || d.title || d.name || d.id || JSON.stringify(d)}
              </span>
              {d.status && (
                <span style={{ fontSize: 10, padding: '1px 6px', borderRadius: 3, background: st.bg, color: st.color, flexShrink: 0 }}>
                  {d.status}
                </span>
              )}
            </div>
          )
        })}
      </div>
    )
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      {val.map((item, i) => (
        <label key={i} style={{ display: 'flex', alignItems: 'center', gap: 6, color: 'var(--c-text2)', cursor: 'default' }}>
          {item.type === 'checkbox' ? (
            <span style={{
              display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
              width: 14, height: 14, borderRadius: 3, flexShrink: 0,
              border: item.checked ? 'none' : '1.5px solid var(--c-text3)',
              background: item.checked ? '#6366f1' : 'transparent',
              color: '#fff', fontSize: 10, lineHeight: 1,
            }}>
              {item.checked ? '✓' : ''}
            </span>
          ) : (
            <span style={{ color: 'var(--c-text3)' }}>•</span>
          )}
          <span style={{ textDecoration: item.checked ? 'line-through' : 'none', opacity: item.checked ? 0.5 : 1 }}>{item.text}</span>
        </label>
      ))}
    </div>
  )
}

function MarkdownViewer({ content }) {
  const { frontmatter, body } = parseFrontmatter(content)
  return (
    <div className="artifact-markdown" style={{ color: 'var(--c-text)', fontSize: 14, lineHeight: 1.7, maxWidth: 720, margin: '0 auto' }}>
      {frontmatter && (
        <div style={{ background: 'var(--c-bg)', border: '1px solid var(--c-border)', borderRadius: 6, padding: '10px 14px', marginBottom: 16, fontSize: 12, fontFamily: MONO }}>
          {frontmatter.map(([key, val], i) => (
            <div key={i} style={{ display: 'flex', gap: 8, padding: '3px 0', alignItems: Array.isArray(val) ? 'flex-start' : 'center' }}>
              <span style={{ color: '#818cf8', minWidth: 100, flexShrink: 0, paddingTop: Array.isArray(val) ? 1 : 0 }}>{key}</span>
              <FrontmatterValue val={val} />
            </div>
          ))}
        </div>
      )}
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          h1: ({ children }) => <h1 style={{ fontSize: 22, fontWeight: 700, margin: '0 0 12px 0', paddingBottom: 8, borderBottom: '1px solid var(--c-border)', color: 'var(--c-white)' }}>{children}</h1>,
          h2: ({ children }) => <h2 style={{ fontSize: 18, fontWeight: 600, margin: '20px 0 8px 0', paddingBottom: 6, borderBottom: '1px solid var(--c-border)', color: 'var(--c-white)' }}>{children}</h2>,
          h3: ({ children }) => <h3 style={{ fontSize: 15, fontWeight: 600, margin: '16px 0 6px 0', color: 'var(--c-white)' }}>{children}</h3>,
          h4: ({ children }) => <h4 style={{ fontSize: 14, fontWeight: 600, margin: '12px 0 4px 0', color: 'var(--c-white)' }}>{children}</h4>,
          p: ({ children }) => <p style={{ margin: '0 0 10px 0' }}>{children}</p>,
          ul: ({ children }) => <ul style={{ margin: '0 0 10px 0', paddingLeft: 24, listStyleType: 'disc' }}>{children}</ul>,
          ol: ({ children }) => <ol style={{ margin: '0 0 10px 0', paddingLeft: 24, listStyleType: 'decimal' }}>{children}</ol>,
          li: ({ children, className }) => {
            const isTask = className === 'task-list-item'
            return <li style={{ margin: '2px 0', listStyleType: isTask ? 'none' : undefined, marginLeft: isTask ? -20 : 0 }}>{children}</li>
          },
          input: ({ type, checked }) => {
            if (type === 'checkbox') {
              return (
                <span style={{
                  display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                  width: 15, height: 15, borderRadius: 3, marginRight: 6, verticalAlign: -2, flexShrink: 0,
                  border: checked ? 'none' : '1.5px solid var(--c-text3)',
                  background: checked ? '#6366f1' : 'transparent',
                  color: '#fff', fontSize: 10,
                }}>{checked ? '✓' : ''}</span>
              )
            }
            return null
          },
          pre: ({ children }) => (
            <pre style={{ background: 'var(--c-bg)', border: '1px solid var(--c-border)', borderRadius: 6, padding: 12, margin: '8px 0 12px 0', overflow: 'auto', fontFamily: MONO, fontSize: 12, color: 'var(--c-text)', lineHeight: 1.6 }}>
              {children}
            </pre>
          ),
          code: ({ node, children }) => {
            const isBlock = node?.position && node.position.start.line !== node.position.end.line
            if (isBlock) return <code>{children}</code>
            return <code style={{ background: 'var(--c-bg3)', padding: '1px 5px', borderRadius: 4, fontFamily: MONO, fontSize: 12, color: '#818cf8' }}>{children}</code>
          },
          blockquote: ({ children }) => (
            <blockquote style={{ borderLeft: '3px solid #6366f1', paddingLeft: 12, margin: '8px 0', color: 'var(--c-text2)', fontStyle: 'italic' }}>{children}</blockquote>
          ),
          table: ({ children }) => (
            <div style={{ overflow: 'auto', margin: '8px 0 12px 0' }}>
              <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: 13 }}>{children}</table>
            </div>
          ),
          thead: ({ children }) => <thead style={{ borderBottom: '2px solid var(--c-border)' }}>{children}</thead>,
          th: ({ children }) => <th style={{ textAlign: 'left', padding: '6px 12px', fontWeight: 600, color: 'var(--c-white)' }}>{children}</th>,
          td: ({ children }) => <td style={{ padding: '5px 12px', borderBottom: '1px solid var(--c-border)' }}>{children}</td>,
          a: ({ href, children }) => <a href={href} target="_blank" rel="noopener noreferrer" style={{ color: '#818cf8', textDecoration: 'underline', textUnderlineOffset: 2 }}>{children}</a>,
          hr: () => <hr style={{ border: 'none', borderTop: '1px solid var(--c-border)', margin: '16px 0' }} />,
          strong: ({ children }) => <strong style={{ color: 'var(--c-white)', fontWeight: 600 }}>{children}</strong>,
          img: ({ src, alt }) => <img src={src} alt={alt} style={{ maxWidth: '100%', borderRadius: 6, margin: '8px 0' }} />,
        }}
      >
        {body}
      </ReactMarkdown>
    </div>
  )
}

function ArtifactContent({ content, fileName, viewRaw }) {
  if (viewRaw) {
    return (
      <pre
        className="text-[12px] whitespace-pre-wrap break-words leading-relaxed"
        style={{ color: 'var(--c-text)', fontFamily: MONO }}
      >{content}</pre>
    )
  }

  const fileType = getFileType(fileName)

  if (fileType === 'json') return <JsonViewer content={content} />
  if (fileType === 'markdown') return <MarkdownViewer content={content} />

  // yaml and other text files — show as raw
  return (
    <pre
      className="text-[12px] whitespace-pre-wrap break-words leading-relaxed"
      style={{ color: 'var(--c-text)', fontFamily: MONO }}
    >{content}</pre>
  )
}

export default function Artifacts() {
  const [data, setData] = useState(null)
  const [search, setSearch] = useState('')
  const [expandedProjects, setExpandedProjects] = useState(new Set())
  const [expandedEditors, setExpandedEditors] = useState(new Set())
  const [selectedFile, setSelectedFile] = useState(null)
  const [fileContent, setFileContent] = useState(null)
  const [loadingContent, setLoadingContent] = useState(false)
  const [viewRaw, setViewRaw] = useState(false)

  useEffect(() => {
    fetchArtifacts().then(d => {
      setData(d)
      // Auto-expand first project
      if (d && d.length > 0) {
        setExpandedProjects(new Set([d[0].folder]))
        if (d[0].editors.length > 0) {
          setExpandedEditors(new Set([d[0].folder + '::' + d[0].editors[0].editor]))
        }
      }
    })
  }, [])

  const handleFileClick = async (file) => {
    setSelectedFile(file)
    setViewRaw(false)
    setLoadingContent(true)
    try {
      const content = await fetchArtifactContent(file.path)
      setFileContent(content)
    } catch {
      setFileContent({ error: 'Failed to load file content' })
    }
    setLoadingContent(false)
  }

  const toggleProject = (folder) => {
    setExpandedProjects(prev => {
      const next = new Set(prev)
      if (next.has(folder)) next.delete(folder)
      else next.add(folder)
      return next
    })
  }

  const toggleEditor = (key) => {
    setExpandedEditors(prev => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  if (!data) return <AnimatedLoader label="Scanning project artifacts..." />

  const filtered = data.filter(p => {
    if (!search) return true
    const q = search.toLowerCase()
    if (p.name.toLowerCase().includes(q) || p.folder.toLowerCase().includes(q)) return true
    return p.editors.some(e =>
      e.label.toLowerCase().includes(q) ||
      e.files.some(f => f.name.toLowerCase().includes(q))
    )
  })

  const totalArtifacts = data.reduce((s, p) => s + p.totalArtifacts, 0)
  const totalProjects = data.length
  const allEditors = new Set()
  for (const p of data) for (const e of p.editors) allEditors.add(e.editor)

  return (
    <div className="h-full">
      {/* Header */}
      <div className="px-4 py-3" style={{ borderBottom: '1px solid var(--c-border)' }}>
        <PageHeader icon={Package} title="Artifacts">
          <span className="text-[11px]" style={{ color: 'var(--c-text3)' }}>{totalArtifacts} artifacts · {totalProjects} projects · {allEditors.size} editors</span>
          <div className="ml-auto relative">
            <Search size={12} className="absolute left-2.5 top-1/2 -translate-y-1/2" style={{ color: 'var(--c-text3)' }} />
            <input
              type="text"
              placeholder="Search artifacts..."
              value={search}
              onChange={e => setSearch(e.target.value)}
              className="pl-7 pr-3 py-1 text-[12px] outline-none w-[200px]"
              style={{ background: 'var(--c-bg3)', border: '1px solid var(--c-border)', color: 'var(--c-text)' }}
            />
          </div>
        </PageHeader>
      </div>

      {filtered.length === 0 ? (
        <div className="text-sm py-12 text-center" style={{ color: 'var(--c-text3)' }}>
          {search ? 'No artifacts match your search' : 'No AI artifacts found in any project folders'}
        </div>
      ) : null}

      <div className="flex" style={{ height: 'calc(100vh - 130px)' }}>
        {/* Sidebar: project > editor tree */}
        <div className="w-[340px] shrink-0 flex flex-col" style={{ background: 'var(--c-card)', borderRight: '1px solid var(--c-border)' }}>
          <div className="px-3 py-2 text-[11px] font-semibold uppercase tracking-wider" style={{ color: 'var(--c-text3)', borderBottom: '1px solid var(--c-border)' }}>
            Project Tree
          </div>
          <div className="overflow-y-auto flex-1">
            {filtered.map(project => {
              const isExpanded = expandedProjects.has(project.folder)
              return (
                <div key={project.folder}>
                  {/* Project row */}
                  <button
                    onClick={() => toggleProject(project.folder)}
                    className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-[var(--c-bg3)] transition"
                    style={{ borderBottom: '1px solid var(--c-border)' }}
                  >
                    {isExpanded ? <ChevronDown size={12} style={{ color: 'var(--c-text3)' }} /> : <ChevronRight size={12} style={{ color: 'var(--c-text3)' }} />}
                    <FolderOpen size={13} style={{ color: '#6366f1' }} />
                    <div className="min-w-0 flex-1">
                      <div className="text-[12px] font-medium truncate" style={{ color: 'var(--c-white)' }}>{project.name}</div>
                      <div className="text-[10px] truncate" style={{ color: 'var(--c-text3)', fontFamily: MONO }}>{project.folder}</div>
                    </div>
                    <span className="text-[10px] px-1.5 py-0.5 rounded" style={{ background: 'rgba(99,102,241,0.12)', color: '#818cf8' }}>
                      {project.totalArtifacts}
                    </span>
                  </button>

                  {/* Editor groups */}
                  {isExpanded && project.editors.map(editorGroup => {
                    const editorKey = project.folder + '::' + editorGroup.editor
                    const isEditorExpanded = expandedEditors.has(editorKey)
                    return (
                      <div key={editorKey}>
                        <button
                          onClick={() => toggleEditor(editorKey)}
                          className="w-full flex items-center gap-2 pl-7 pr-3 py-1.5 text-left hover:bg-[var(--c-bg3)] transition"
                        >
                          {isEditorExpanded ? <ChevronDown size={10} style={{ color: 'var(--c-text3)' }} /> : <ChevronRight size={10} style={{ color: 'var(--c-text3)' }} />}
                          {editorGroup.editor !== '_general' ? (
                            <EditorIcon source={editorGroup.editor} size={12} />
                          ) : (
                            <FileText size={12} style={{ color: 'var(--c-text2)' }} />
                          )}
                          <span className="text-[11px] font-medium" style={{ color: editorGroup.editor !== '_general' ? editorColor(editorGroup.editor) : 'var(--c-text2)' }}>
                            {editorGroup.editor !== '_general' ? editorLabel(editorGroup.editor) : editorGroup.label}
                          </span>
                          <span className="text-[10px] ml-auto" style={{ color: 'var(--c-text3)' }}>
                            {editorGroup.files.length}
                          </span>
                        </button>

                        {/* File list */}
                        {isEditorExpanded && editorGroup.files.map(file => (
                          <button
                            key={file.path}
                            onClick={() => handleFileClick(file)}
                            className="w-full flex items-center gap-2 pl-12 pr-3 py-1.5 text-left hover:bg-[var(--c-bg3)] transition"
                            style={{
                              background: selectedFile?.path === file.path ? 'var(--c-bg3)' : 'transparent',
                              borderLeft: selectedFile?.path === file.path ? '2px solid #6366f1' : '2px solid transparent',
                            }}
                          >
                            <FileText size={11} style={{ color: 'var(--c-text3)' }} />
                            <div className="min-w-0 flex-1">
                              <div className="text-[11px] truncate" style={{ color: 'var(--c-text)', fontFamily: MONO }}>{file.relativePath}</div>
                              <div className="text-[10px]" style={{ color: 'var(--c-text3)' }}>
                                {formatSize(file.size)} · {file.lines} lines
                              </div>
                            </div>
                          </button>
                        ))}
                      </div>
                    )
                  })}
                </div>
              )
            })}
          </div>
        </div>

        {/* Content panel — scrolls internally */}
        <div className="flex-1 flex flex-col min-w-0 overflow-hidden" style={{ background: 'var(--c-card)' }}>
          {!selectedFile ? (
            <div className="flex items-center justify-center flex-1 text-[13px]" style={{ color: 'var(--c-text3)' }}>
              <div className="text-center">
                <Package size={32} className="mx-auto mb-3 opacity-30" />
                <div>Select an artifact to view its contents</div>
                <div className="text-[11px] mt-1 opacity-60">Click any file in the sidebar tree</div>
              </div>
            </div>
          ) : (
            <div className="flex flex-col h-full">
              {/* File header */}
              <div className="flex items-center gap-3 px-4 py-2.5" style={{ borderBottom: '1px solid var(--c-border)' }}>
                <FileText size={14} style={{ color: '#6366f1' }} />
                <div className="flex-1 min-w-0">
                  <div className="text-[12px] font-medium" style={{ color: 'var(--c-white)', fontFamily: MONO }}>{selectedFile.relativePath}</div>
                  <div className="flex items-center gap-3 text-[10px]" style={{ color: 'var(--c-text3)' }}>
                    <span>{formatSize(selectedFile.size)}</span>
                    <span>{selectedFile.lines} lines</span>
                    <span className="flex items-center gap-1">
                      <Clock size={9} />
                      {formatDate(selectedFile.modifiedAt)}
                    </span>
                  </div>
                </div>
                {fileContent?.content && (() => {
                  const tokens = estimateTokens(fileContent.content)
                  return (
                    <div className="flex items-center gap-2">
                      <span className="flex items-center gap-1 text-[10px] px-2 py-0.5 rounded" style={{ background: 'rgba(99,102,241,0.08)', border: '1px solid rgba(99,102,241,0.15)', color: '#818cf8' }}>
                        <Type size={9} />
                        {formatTokens(tokens)} tokens
                      </span>
                      <span className="flex items-center gap-1 text-[10px] px-2 py-0.5 rounded" style={{ background: 'rgba(34,197,94,0.08)', border: '1px solid rgba(34,197,94,0.15)', color: '#22c55e' }}>
                        <DollarSign size={9} />
                        {estimateCost(tokens)}
                      </span>
                    </div>
                  )
                })()}
                <span className="flex items-center gap-1.5 text-[10px] px-2 py-0.5 rounded" style={{ background: `${editorColor(selectedFile.editor)}15`, color: editorColor(selectedFile.editor) }}>
                  {selectedFile.editor !== '_general' && <EditorIcon source={selectedFile.editor} size={11} />}
                  {selectedFile.editorLabel}
                </span>
                <button
                  onClick={() => setViewRaw(v => !v)}
                  className="flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-medium transition"
                  style={{
                    background: viewRaw ? 'rgba(99,102,241,0.15)' : 'var(--c-bg3)',
                    color: viewRaw ? '#818cf8' : 'var(--c-text2)',
                    border: '1px solid ' + (viewRaw ? 'rgba(99,102,241,0.3)' : 'var(--c-border)'),
                  }}
                  title={viewRaw ? 'Switch to rendered view' : 'Switch to raw view'}
                >
                  {viewRaw ? <Eye size={12} /> : <Code size={12} />}
                  {viewRaw ? 'Rendered' : 'Raw'}
                </button>
                <button
                  onClick={() => { setSelectedFile(null); setFileContent(null) }}
                  className="p-1 rounded hover:bg-[var(--c-bg3)] transition"
                  style={{ color: 'var(--c-text3)' }}
                >
                  <X size={14} />
                </button>
              </div>

              {/* File content — internal scroll */}
              <div className="flex-1 overflow-y-auto p-4">
                {loadingContent ? (
                  <div className="text-[12px] py-8 text-center" style={{ color: 'var(--c-text3)' }}>Loading...</div>
                ) : fileContent?.error ? (
                  <div className="text-[12px] py-8 text-center" style={{ color: '#ef4444' }}>{fileContent.error}</div>
                ) : fileContent?.content ? (
                  <ArtifactContent content={fileContent.content} fileName={selectedFile.name} viewRaw={viewRaw} />
                ) : null}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
