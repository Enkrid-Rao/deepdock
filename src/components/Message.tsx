import { memo, useEffect, useRef, useState } from 'react'
import { AlertCircle, Brain, FileText, RotateCw } from 'lucide-react'
import { Markdown } from './Markdown'
import { CopyButton } from './ui'
import { formatChars } from '../lib/projects'
import { attachmentUrl, formatBytes } from '../lib/attachments'
import type { Attachment, Message } from '../lib/types'

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

function AttachmentCard({ item }: { item: Attachment }) {
  const url = attachmentUrl(item)
  if (item.isImage) {
    return (
      <a
        className="attach-image"
        href={url || undefined}
        target="_blank"
        rel="noreferrer"
        title={item.name}
        data-missing={url ? undefined : 'true'}
      >
        {url ? <img src={url} alt={item.name} loading="lazy" /> : <FileText size={16} />}
        <span className="attach-caption">{item.name}</span>
      </a>
    )
  }

  const body = (
    <>
      <span className="attach-icon">
        <FileText size={16} />
      </span>
      <span className="attach-main">
        <span className="attach-name" title={item.name}>
          {item.name}
        </span>
        <span className="attach-meta">{formatBytes(item.size)}</span>
      </span>
    </>
  )

  return url ? (
    <a className="attach-file" href={url} target="_blank" rel="noreferrer" title={`打开 ${item.name}`}>
      {body}
    </a>
  ) : (
    <span className="attach-file" title={item.name}>
      {body}
    </span>
  )
}

function Attachments({ items }: { items: Attachment[] }) {
  if (!items.length) return null
  return (
    <div className="msg-attachments">
      {items.map((item) => (
        <AttachmentCard key={item.id} item={item} />
      ))}
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
        {message.memoryRefs?.length ? (
          <div className="msg-refs">
            {message.memoryRefs.map((ref) => (
              <span
                key={ref.projectId}
                className="ref-chip"
                title={`项目记忆 · ${ref.file || `${ref.name}.md`}`}
              >
                <FileText size={11} />
                <span>项目记忆 · {ref.name}</span>
                <em>{formatChars(ref.chars)}</em>
              </span>
            ))}
          </div>
        ) : null}
        <div className="bubble">
          {message.attachments?.length ? <Attachments items={message.attachments} /> : null}
          {message.content.trim() ? <Markdown content={message.content} variant="user" /> : null}
        </div>
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

      {message.attachments?.length ? <Attachments items={message.attachments} /> : null}

      {empty && streaming ? (
        <div className="typing" aria-label="正在生成">
          <span />
          <span />
          <span />
        </div>
      ) : (
        <Markdown content={shown} references={message.references} />
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
