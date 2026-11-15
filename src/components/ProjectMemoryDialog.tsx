import { useEffect, useMemo, useState } from 'react'
import { AlertTriangle, Check, Copy, FileText, Loader2 } from 'lucide-react'
import { Dialog, copyText } from './ui'
import { api, ApiError } from '../lib/api'
import { formatChars } from '../lib/projects'
import type { Project, ProjectMemory } from '../lib/types'

const MEMORY_LIMIT = 24_000

export function ProjectMemoryDialog({
  open,
  project,
  onClose,
  onSaved,
}: {
  open: boolean
  project: Project | null
  onClose: () => void
  onSaved: (project: Project, memory: ProjectMemory) => void
}) {
  const [content, setContent] = useState('')
  const [enabled, setEnabled] = useState(false)
  const [includeSubprojects, setIncludeSubprojects] = useState(false)
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    if (!open || !project) return
    let alive = true
    setLoading(true)
    setError(null)
    api
      .getProjectMemory(project.id)
      .then((data) => {
        if (!alive) return
        setContent(data.content)
        setEnabled(data.enabled)
        setIncludeSubprojects(data.includeSubprojects)
      })
      .catch((err) => {
        if (!alive) return
        setError(err instanceof ApiError ? err.message : '读取项目记忆失败')
      })
      .finally(() => alive && setLoading(false))
    return () => {
      alive = false
    }
  }, [open, project])

  const chars = content.length
  const overLimit = chars > MEMORY_LIMIT
  const pathLabel = useMemo(
    () => (project ? `data/project-memory/${project.id}.md` : ''),
    [project],
  )

  const save = async () => {
    if (!project || saving) return
    setSaving(true)
    setError(null)
    try {
      const result = await api.saveProjectMemory(project.id, {
        content,
        enabled,
        includeSubprojects,
      })
      onSaved(result.project, result.memory)
      onClose()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '保存项目记忆失败')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      width={660}
      className="dialog-memory"
      title={project ? `项目记忆 · ${project.name}` : '项目记忆'}
      description="项目内新建对话的第一条消息会把这段 Markdown 作为背景发给 DeepSeek；输入框里只显示一个引用标签，不会塞进你打的字里。"
      footer={
        <>
          <span className="memory-save-hint">
            {enabled && chars > 0 ? '保存后，这个项目的第一条消息会引用它' : '未启用或内容为空时不会引用'}
          </span>
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            取消
          </button>
          <button
            type="button"
            className="btn btn-primary"
            style={{ width: 'auto' }}
            disabled={loading || saving}
            onClick={() => void save()}
          >
            {saving ? <Loader2 size={14} className="spin" /> : null}
            {saving ? '保存中…' : '保存'}
          </button>
        </>
      }
    >
      {loading ? (
        <div className="memory-loading">
          <Loader2 size={16} className="spin" /> 正在读取…
        </div>
      ) : (
        <>
          <div className="memory-toggles">
            <button
              type="button"
              className="memory-toggle"
              data-on={enabled}
              onClick={() => setEnabled((value) => !value)}
            >
              <span className="toggle-track">
                <span className="toggle-thumb" />
              </span>
              <span className="memory-toggle-text">
                <span>启用项目记忆</span>
                <em>新对话的第一条消息自动引用</em>
              </span>
            </button>
            <button
              type="button"
              className="memory-toggle"
              data-on={includeSubprojects}
              disabled={!enabled}
              onClick={() => setIncludeSubprojects((value) => !value)}
            >
              <span className="toggle-track">
                <span className="toggle-thumb" />
              </span>
              <span className="memory-toggle-text">
                <span>同时应用到子项目</span>
                <em>所有下层项目都生效；不影响并列项目</em>
              </span>
            </button>
          </div>

          <div className="memory-note">
            网页端的聊天记录里，这段内容会出现在第一条消息里；DeepDock 界面只显示引用标签。
          </div>

          <div className="memory-editor-head">
            <span className="memory-file">
              <FileText size={13} /> {pathLabel}
            </span>
            <button
              type="button"
              className="icon-btn tiny"
              title="复制文件路径"
              onClick={async () => {
                const ok = await copyText(pathLabel)
                if (ok) {
                  setCopied(true)
                  window.setTimeout(() => setCopied(false), 1500)
                }
              }}
            >
              {copied ? <Check size={12} /> : <Copy size={12} />}
            </button>
          </div>

          <textarea
            className="memory-textarea"
            value={content}
            rows={14}
            spellCheck={false}
            placeholder={
              '# 项目约定\n\n- 回答尽量简洁\n- 代码用 TypeScript\n- 不要使用表情符号'
            }
            onChange={(event) => setContent(event.target.value)}
          />

          <div className="memory-foot">
            <span data-over={overLimit}>
              {formatChars(chars)}
              {overLimit ? ` · 超过 ${formatChars(MEMORY_LIMIT)} 的部分会被截断` : ''}
            </span>
            <span>也可以在数据目录里直接编辑这个 .md 文件</span>
          </div>

          {overLimit ? (
            <div className="memory-warning">
              <AlertTriangle size={14} />
              内容较长，发送时只会取前面的 {formatChars(MEMORY_LIMIT)}。
            </div>
          ) : null}

          {error ? <div className="form-error">{error}</div> : null}
        </>
      )}
    </Dialog>
  )
}
