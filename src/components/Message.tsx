import { memo, useEffect, useRef, useState } from 'react'
import { AlertCircle, Brain, RotateCw } from 'lucide-react'
import { Markdown } from './Markdown'
import { CopyButton } from './ui'
import type { Message } from '../lib/types'

function useStreamText(value: string, active: boolean, ms = 110) {
  const [shown, setShown] = useState(value)
  const latest = useRef(value)
  latest.current = value

  useEffect(() => {
    if (!active) return undefined
    const id = window.setInterval(() => setShown(latest.current), ms)
    return () => window.clearInterval(id)
  }, [active, ms])

  return active ? shown : value
}

function Reasoning({ text, streaming }: { text: string; streaming: boolean }) {
  const [open, setOpen] = useState(streaming)

  useEffect(() => {
    if (!streaming) {
      const id = window.setTimeout(() => setOpen(false), 600)
      return () => window.clearTimeout(id)
    }
    setOpen(true)
    return undefined
  }, [streaming])

  if (!text.trim()) return null
  const chars = text.trim().length

  return (
    <div className="reasoning" data-open={open}>
      <button type="button" className="reasoning-head" onClick={() => setOpen((v) => !v)}>
        <Brain size={13} className={streaming ? 'spin' : undefined} />
        <span>{streaming ? '正在思考…' : '思考过程'}</span>
        <span style={{ color: 'var(--faint)', fontSize: 11 }}>· {chars} 字</span>
        <svg
          width="12"
          height="12"
          viewBox="0 0 24 24"
          fill="none"
          style={{
            marginLeft: 'auto',
            transform: open ? 'rotate(180deg)' : 'none',
            transition: 'transform 200ms var(--ease)',
          }}
        >
          <path d="M6 9l6 6 6-6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      <div className="reasoning-body">
        <div>
          <div className="reasoning-text">{text}</div>
        </div>
      </div>
    </div>
  )
}

export const MessageView = memo(function MessageView({
  message,
  onRegenerate,
}: {
  message: Message
  onRegenerate?: () => void
}) {
  const streaming = Boolean(message.streaming)
  const shown = useStreamText(message.content, streaming)
  const reasoning = useStreamText(message.reasoning || '', streaming)

  if (message.role === 'user') {
    return (
      <div className="msg msg-user">
        <div className="bubble">{message.content}</div>
        <div className="msg-actions">
          <CopyButton text={message.content} title="复制" />
        </div>
      </div>
    )
  }

  const empty = !message.content.trim()

  return (
    <div className="msg msg-assistant" data-streaming={streaming}>
      <div className="msg-head">
        <span className="brand-dot" />
        <span>DeepSeek</span>
        {message.thinking ? <span style={{ letterSpacing: 0 }}>· 深度思考</span> : null}
        {message.search ? <span style={{ letterSpacing: 0 }}>· 联网</span> : null}
        <div className="msg-actions">
          <CopyButton text={message.content} title="复制回复" />
          {onRegenerate ? (
            <button type="button" className="action-btn" title="重新生成" onClick={onRegenerate}>
              <RotateCw size={13.5} />
            </button>
          ) : null}
        </div>
      </div>

      <Reasoning text={reasoning} streaming={streaming} />

      {empty && streaming ? (
        <div className="typing" aria-label="正在生成">
          <span />
          <span />
          <span />
        </div>
      ) : (
        <Markdown content={shown} />
      )}

      {message.error ? (
        <div className="notice">
          <AlertCircle size={14} style={{ flex: 'none', marginTop: 1.5 }} />
          <div>
            {message.error}
            {onRegenerate ? (
              <>
                {' '}
                <button type="button" onClick={onRegenerate}>
                  重试
                </button>
              </>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  )
})
