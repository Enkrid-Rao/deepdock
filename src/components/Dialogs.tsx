import { useEffect, useState } from 'react'
import { Dialog } from './ui'
import { PROJECT_COLORS, projectColor, type ConversationMeta, type Project } from '../lib/types'

export function PromptDialog({
  open,
  title,
  description,
  initialValue = '',
  placeholder,
  confirmLabel = '保存',
  onClose,
  onSubmit,
}: {
  open: boolean
  title: string
  description?: string
  initialValue?: string
  placeholder?: string
  confirmLabel?: string
  onClose: () => void
  onSubmit: (value: string) => void
}) {
  const [value, setValue] = useState(initialValue)

  useEffect(() => {
    if (open) setValue(initialValue)
  }, [open, initialValue])

  const submit = () => {
    const next = value.trim()
    if (!next) return
    onSubmit(next)
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={title}
      description={description}
      footer={
        <>
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            取消
          </button>
          <button
            type="button"
            className="btn btn-primary"
            style={{ width: 'auto' }}
            disabled={!value.trim()}
            onClick={submit}
          >
            {confirmLabel}
          </button>
        </>
      }
    >
      <input
        autoFocus
        value={value}
        placeholder={placeholder}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') submit()
        }}
      />
    </Dialog>
  )
}

export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel = '删除',
  onClose,
  onConfirm,
}: {
  open: boolean
  title: string
  description?: string
  confirmLabel?: string
  onClose: () => void
  onConfirm: () => void
}) {
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={title}
      description={description}
      footer={
        <>
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            取消
          </button>
          <button
            type="button"
            className="btn btn-primary"
            style={{ width: 'auto', background: 'var(--danger)', color: '#fff' }}
            onClick={onConfirm}
          >
            {confirmLabel}
          </button>
        </>
      }
    />
  )
}

export function ProjectDialog({
  open,
  project,
  onClose,
  onSubmit,
}: {
  open: boolean
  project: Project | null
  onClose: () => void
  onSubmit: (value: { name: string; color: string }) => void
}) {
  const [name, setName] = useState('')
  const [color, setColor] = useState(PROJECT_COLORS[0].key)

  useEffect(() => {
    if (!open) return
    setName(project?.name || '')
    setColor(project?.color || PROJECT_COLORS[0].key)
  }, [open, project])

  const submit = () => {
    if (!name.trim()) return
    onSubmit({ name: name.trim(), color })
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={project ? '重命名项目' : '新建项目'}
      description={project ? undefined : '项目只是一层分组，不会发送任何提示词给模型。'}
      footer={
        <>
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            取消
          </button>
          <button
            type="button"
            className="btn btn-primary"
            style={{ width: 'auto' }}
            disabled={!name.trim()}
            onClick={submit}
          >
            {project ? '保存' : '创建'}
          </button>
        </>
      }
    >
      <input
        autoFocus
        value={name}
        placeholder="例如：论文 / 工作 / 灵感"
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') submit()
        }}
      />
      <div className="swatches">
        {PROJECT_COLORS.map((c) => (
          <button
            key={c.key}
            type="button"
            className="swatch"
            style={{ background: c.value }}
            data-active={color === c.key}
            title={c.label}
            onClick={() => setColor(c.key)}
          />
        ))}
      </div>
    </Dialog>
  )
}

export function MoveDialog({
  open,
  conversation,
  projects,
  onClose,
  onMove,
}: {
  open: boolean
  conversation: ConversationMeta | null
  projects: Project[]
  onClose: () => void
  onMove: (projectId: string | null) => void
}) {
  return (
    <Dialog open={open} onClose={onClose} title="移动到项目" description="把这段对话收进一个项目里。">
      <div className="move-list">
        <button
          type="button"
          className="menu-item"
          data-current={!conversation?.projectId}
          onClick={() => onMove(null)}
        >
          <span className="dot" style={{ background: 'var(--line-strong)' }} />
          未分组
        </button>
        {projects.map((p) => (
          <button
            key={p.id}
            type="button"
            className="menu-item"
            data-current={conversation?.projectId === p.id}
            onClick={() => onMove(p.id)}
          >
            <span className="dot" style={{ background: projectColor(p.color) }} />
            {p.name}
          </button>
        ))}
        {!projects.length ? <div className="hint">还没有项目，先到左侧新建一个。</div> : null}
      </div>
    </Dialog>
  )
}
