import { useEffect, useMemo, useRef, useState } from 'react'
import { CloudDownload, CornerDownLeft, Plus, Search } from 'lucide-react'
import { relativeTime } from '../lib/format'
import { projectColor, type ConversationMeta, type Project } from '../lib/types'

export function CommandPalette({
  open,
  onClose,
  conversations,
  projects,
  onSelect,
  onNewChat,
  onSync,
}: {
  open: boolean
  onClose: () => void
  conversations: ConversationMeta[]
  projects: Project[]
  onSelect: (id: string) => void
  onNewChat: () => void
  onSync: () => void
}) {
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    setQuery('')
    setActive(0)
    const id = window.setTimeout(() => inputRef.current?.focus(), 30)
    return () => window.clearTimeout(id)
  }, [open])

  const results = useMemo(() => {
    const q = query.trim().toLowerCase()
    const list = q
      ? conversations.filter(
          (c) => c.title.toLowerCase().includes(q) || (c.preview || '').toLowerCase().includes(q),
        )
      : conversations
    return list.slice(0, 40)
  }, [conversations, query])

  useEffect(() => {
    setActive(0)
  }, [query])

  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)
    el?.scrollIntoView({ block: 'nearest' })
  }, [active])

  if (!open) return null

  const choose = (id: string) => {
    onSelect(id)
    onClose()
  }

  return (
    <div
      className="overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div
        className="palette"
        role="dialog"
        aria-modal="true"
        aria-label="搜索对话"
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') {
            e.preventDefault()
            setActive((i) => Math.min(i + 1, results.length - 1))
          } else if (e.key === 'ArrowUp') {
            e.preventDefault()
            setActive((i) => Math.max(i - 1, 0))
          } else if (e.key === 'Enter') {
            e.preventDefault()
            if (results[active]) choose(results[active].id)
          } else if (e.key === 'Escape') {
            onClose()
          }
        }}
      >
        <div className="palette-input">
          <Search size={16} />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索对话…"
            aria-label="搜索对话"
          />
          <kbd>Esc</kbd>
        </div>

        <div className="palette-list" ref={listRef}>
          {!query ? (
            <>
              <button type="button" className="palette-row" data-active={active === -1} onClick={() => { onNewChat(); onClose() }}>
                <Plus size={15} style={{ color: 'var(--accent)' }} />
                <span className="p-title">新建对话</span>
                <span className="p-meta">
                  <CornerDownLeft size={11} />
                </span>
              </button>
              <button type="button" className="palette-row" onClick={() => onSync()}>
                <CloudDownload size={15} style={{ color: 'var(--accent)' }} />
                <span className="p-title">从网页同步对话</span>
                <span className="p-meta">chat.deepseek.com</span>
              </button>
            </>
          ) : null}

          {results.length ? (
            <>
              <div className="palette-group">{query ? `找到 ${results.length} 条` : '最近对话'}</div>
              {results.map((conv, index) => {
                const project = projects.find((p) => p.id === conv.projectId)
                return (
                  <button
                    key={conv.id}
                    type="button"
                    className="palette-row"
                    data-active={index === active}
                    data-index={index}
                    onMouseEnter={() => setActive(index)}
                    onClick={() => choose(conv.id)}
                  >
                    {project ? (
                      <span
                        className="dot"
                        style={{
                          background: projectColor(project.color),
                          width: 7,
                          height: 7,
                          borderRadius: 99,
                          flex: 'none',
                        }}
                      />
                    ) : (
                      <span
                        style={{
                          width: 7,
                          height: 7,
                          borderRadius: 99,
                          background: 'var(--line-strong)',
                          flex: 'none',
                        }}
                      />
                    )}
                    <span className="p-title">{conv.title || '新对话'}</span>
                    <span className="p-meta">{project ? project.name : relativeTime(conv.updatedAt)}</span>
                  </button>
                )
              })}
            </>
          ) : (
            <div className="palette-empty">没有找到「{query}」</div>
          )}
        </div>
      </div>
    </div>
  )
}
