import { useEffect, useRef, type KeyboardEvent } from 'react'
import { ArrowUp, Brain, Globe, Square } from 'lucide-react'

export function Composer({
  draft,
  onDraftChange,
  onSend,
  onStop,
  streaming,
  thinking,
  search,
  onToggleThinking,
  onToggleSearch,
}: {
  draft: string
  onDraftChange: (value: string) => void
  onSend: () => void
  onStop: () => void
  streaming: boolean
  thinking: boolean
  search: boolean
  onToggleThinking: () => void
  onToggleSearch: () => void
}) {
  const ref = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 260)}px`
  }, [draft])

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key !== 'Enter') return
    if (e.nativeEvent.isComposing) return
    if (e.shiftKey || e.altKey) return
    e.preventDefault()
    if (!streaming) onSend()
  }

  const canSend = draft.trim().length > 0 && !streaming

  return (
    <div className="composer-wrap">
      <div className="composer">
        <textarea
          ref={ref}
          rows={1}
          value={draft}
          placeholder="给 DeepSeek 发消息…"
          onChange={(e) => onDraftChange(e.target.value)}
          onKeyDown={handleKeyDown}
          spellCheck={false}
        />
        <div className="composer-bar">
          <button
            type="button"
            className="chip"
            data-on={thinking}
            onClick={onToggleThinking}
            disabled={streaming}
            title="让 DeepSeek 先思考再回答"
          >
            <Brain size={13} />
            深度思考
          </button>
          <button
            type="button"
            className="chip"
            data-on={search}
            onClick={onToggleSearch}
            disabled={streaming}
            title="联网搜索后再回答"
          >
            <Globe size={13} />
            联网搜索
          </button>
          <span className="composer-hint">
            <kbd>Enter</kbd> 发送
            <span style={{ opacity: 0.5 }}>·</span>
            <kbd>Shift</kbd>+<kbd>Enter</kbd> 换行
          </span>
          {streaming ? (
            <button type="button" className="send stop" onClick={onStop} title="停止生成">
              <Square size={12} fill="currentColor" strokeWidth={0} />
            </button>
          ) : (
            <button type="button" className="send" onClick={onSend} disabled={!canSend} title="发送">
              <ArrowUp size={17} strokeWidth={2.2} />
            </button>
          )}
        </div>
      </div>
      <div className="composer-foot">DeepDock 只做转发 · 内容由 DeepSeek 生成</div>
    </div>
  )
}
