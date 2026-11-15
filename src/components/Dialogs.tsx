import { useEffect, useState } from 'react'
import { Dialog } from './ui'
import { PROJECT_COLORS, projectColor, type ConversationMeta, type Project } from '../lib/types'
import { projectOptions } from '../lib/projects'
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
  projects,
  initialParentId = null,
  onClose,
  onSubmit,
}: {
  open: boolean
  project: Project | null
  projects: Project[]
  initialParentId?: string | null
  onClose: () => void
  onSubmit: (value: { name: string; color: string; parentId: string | null }) => void
}) {
  const [name, setName] = useState('')
  const [color, setColor] = useState(PROJECT_COLORS[0].key)
  const [parentId, setParentId] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    setName(project?.name || '')
    setColor(project?.color || PROJECT_COLORS[0].key)
    setParentId(project ? project.parentId || null : initialParentId || null)
  }, [open, project, initialParentId])

  const submit = () => {
    if (!name.trim()) return
    onSubmit({ name: name.trim(), color, parentId })
  }

  const options = projectOptions(projects, project?.id || null)

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={project ? '编辑项目' : initialParentId ? '新建子项目' : '新建项目'}
      description={project ? undefined : '项目只是一层分组，不会发送任何提示词。'}
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
      <div className="field project-parent-field">
        <label htmlFor="project-parent">
          父项目
          <span className="opt">可选</span>
        </label>
        <select
          id="project-parent"
          value={parentId || ''}
          onChange={(e) => setParentId(e.target.value || null)}
        >
          <option value="">（顶层项目）</option>
          {options.map((option) => (
            <option key={option.id} value={option.id}>
              {'　'.repeat(option.depth)}
              {option.label}
            </option>
          ))}
        </select>
        <div className="hint">子项目显示在父项目下面；项目记忆默认不覆盖子项目。</div>
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
        {projectOptions(projects).map((option) => {
          const project = projects.find((item) => item.id === option.id)
          if (!project) return null
          return (
            <button
              key={project.id}
              type="button"
              className="menu-item"
              data-current={conversation?.projectId === project.id}
              onClick={() => onMove(project.id)}
            >
              <span className="dot" style={{ background: projectColor(project.color) }} />
              {'　'.repeat(option.depth)}
              {project.name}
            </button>
          )
        })}
        {!projects.length ? <div className="hint">还没有项目，先到左侧新建一个。</div> : null}
      </div>
    </Dialog>
  )
}
