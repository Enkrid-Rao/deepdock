import { useEffect, useMemo, useRef, useState } from 'react'
import {
  ChevronDown,
  CloudDownload,
  Download,
  FileText,
  FolderPlus,
  Moon,
  MoreHorizontal,
  Settings,
  Pencil,
  Pin,
  PinOff,
  Plus,
  Search,
  Sun,
  Trash2,
  FolderInput,
  X,
  LogOut,
  RefreshCw,
  PlugZap,
} from 'lucide-react'
import { Menu } from './ui'
import { Logo } from './ui'
import { displayName, initials } from '../lib/format'
import { projectColor, type ConversationMeta, type Project, type User } from '../lib/types'

const UNGROUPED = '__ungrouped__'
const COLLAPSE_KEY = 'deepdock:collapsed'

function loadCollapsed(): Set<string> {
  try {
    const raw = localStorage.getItem(COLLAPSE_KEY)
    if (raw) return new Set(JSON.parse(raw))
  } catch {
    /* ignore */
  }
  return new Set()
}

type Actions = {
  newChat: (projectId?: string | null) => void
  select: (id: string) => void
  newProject: (parentId?: string | null) => void
  newSubproject: (project: Project) => void
  editMemory: (project: Project) => void
  renameProject: (project: Project) => void
  deleteProject: (project: Project) => void
  renameConversation: (conv: ConversationMeta) => void
  moveConversation: (conv: ConversationMeta) => void
  deleteConversation: (conv: ConversationMeta) => void
  pinConversation: (conv: ConversationMeta) => void
  account: (action: 'refresh' | 'reconnect' | 'disconnect' | 'dataFolder' | 'checkUpdates') => void
  sync: () => void
  settings: () => void
}

export function Sidebar({
  projects,
  conversations,
  activeId,
  activeProjectId,
  user,
  dark,
  savedAt,
  credentialSource,
  query,
  onQuery,
  onToggleTheme,
  onOpenPalette,
  desktop = false,
  actions,
}: {
  projects: Project[]
  conversations: ConversationMeta[]
  activeId: string | null
  activeProjectId?: string | null
  user: User | null
  dark: boolean
  savedAt?: number | null
  credentialSource?: string | null
  query: string
  onQuery: (value: string) => void
  onToggleTheme: () => void
  onOpenPalette: () => void
  desktop?: boolean
  actions: Actions
}) {  const [collapsed, setCollapsed] = useState<Set<string>>(loadCollapsed)

  const toggle = (id: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      try {
        localStorage.setItem(COLLAPSE_KEY, JSON.stringify([...next]))
      } catch {
        /* ignore */
      }
      return next
    })
  }

  const expand = (id: string) => {
    expandAll([id])
  }

  const projectsRef = useRef(projects)
  projectsRef.current = projects

  const expandAll = (ids: string[]) => {
    setCollapsed((prev) => {
      const next = new Set(prev)
      let changed = false
      for (const id of ids) {
        if (next.delete(id)) changed = true
      }
      if (!changed) return prev
      try {
        localStorage.setItem(COLLAPSE_KEY, JSON.stringify([...next]))
      } catch {
        /* ignore */
      }
      return next
    })
  }

  // Reveal the active conversation when selection changes, but never re-open a
  // group the user has just collapsed (the active id stays the same then).
  useEffect(() => {
    if (!activeId) return
    const keys = new Set<string>([activeProjectId || UNGROUPED])
    let current = activeProjectId
      ? projectsRef.current.find((project) => project.id === activeProjectId)
      : undefined
    while (current) {
      keys.add(current.id)
      current = current.parentId
        ? projectsRef.current.find((project) => project.id === current?.parentId)
        : undefined
    }
    expandAll([...keys])
  }, [activeId, activeProjectId])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return conversations
    return conversations.filter(
      (c) => c.title.toLowerCase().includes(q) || (c.preview || '').toLowerCase().includes(q),
    )
  }, [conversations, query])

  const byProject = useMemo(() => {
    const map = new Map<string, ConversationMeta[]>()
    for (const conv of filtered) {
      const key = conv.projectId || UNGROUPED
      const list = map.get(key)
      if (list) list.push(conv)
      else map.set(key, [conv])
    }
    return map
  }, [filtered])

  const ungrouped = byProject.get(UNGROUPED) || []
  const searching = query.trim().length > 0
  const loginAge = savedAt ? Math.max(0, Math.floor((Date.now() - savedAt) / 86_400_000)) : null

  const projectChildren = useMemo(() => {
    const map = new Map<string | null, Project[]>()
    const ids = new Set(projects.map((project) => project.id))
    for (const project of projects) {
      const parentId = project.parentId && ids.has(project.parentId) ? project.parentId : null
      const list = map.get(parentId)
      if (list) list.push(project)
      else map.set(parentId, [project])
    }
    return map
  }, [projects])

  const roots = projectChildren.get(null) || []

  const convRow = (conv: ConversationMeta, showProject: boolean) => {
    const project = showProject ? projects.find((p) => p.id === conv.projectId) : null
    return (
      <div
        key={conv.id}
        className="conv-row"
        role="button"
        tabIndex={0}
        aria-current={conv.id === activeId}
        onClick={() => actions.select(conv.id)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            actions.select(conv.id)
          }
        }}
      >
        {conv.pinned ? <Pin size={11} style={{ flex: 'none', color: 'var(--accent)' }} /> : null}
        <span className="conv-title">{conv.title || '新对话'}</span>
        {project ? (
          <span
            className="count"
            style={{ fontSize: 10, color: 'var(--faint)', flex: 'none', maxWidth: 70, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
          >
            {project.name}
          </span>
        ) : null}
        <Menu
          align="right"
          width={196}
          trigger={({ onClick, open }) => (
            <button
              type="button"
              className="icon-btn row-more"
              data-open={open}
              onClick={onClick}
              title="更多"
            >
              <MoreHorizontal size={14} />
            </button>
          )}
        >
          {(close) => (
            <>
              <button
                type="button"
                className="menu-item"
                onClick={() => {
                  close()
                  actions.renameConversation(conv)
                }}
              >
                <Pencil size={14} /> 重命名
              </button>
              <button
                type="button"
                className="menu-item"
                onClick={() => {
                  close()
                  actions.pinConversation(conv)
                }}
              >
                {conv.pinned ? <PinOff size={14} /> : <Pin size={14} />}
                {conv.pinned ? '取消置顶' : '置顶'}
              </button>
              <button
                type="button"
                className="menu-item"
                onClick={() => {
                  close()
                  actions.moveConversation(conv)
                }}
              >
                <FolderInput size={14} /> 移动到项目
              </button>
              <div className="menu-sep" />
              <button
                type="button"
                className="menu-item danger"
                onClick={() => {
                  close()
                  actions.deleteConversation(conv)
                }}
              >
                <Trash2 size={14} /> 删除对话
              </button>
            </>
          )}
        </Menu>
      </div>
    )
  }

  const convList = (items: ConversationMeta[], depth: number) => (
    <div className="conv-inner" style={{ marginLeft: 14 + depth * 16 }}>
      {items.length ? (
        items.map((conv) => convRow(conv, searching))
      ) : (
        <div className="conv-empty">还没有对话</div>
      )}
    </div>
  )

  const renderProject = (project: Project, depth: number) => {
    const key = project.id
    const items = byProject.get(key) || []
    const children = projectChildren.get(key) || []
    const open = searching || !collapsed.has(key)

    return (
      <div className="project-group" key={key} data-depth={depth}>
        <div
          className="project-row"
          data-open={open}
          role="button"
          tabIndex={0}
          style={{ paddingLeft: 7 + depth * 16 }}
          onClick={() => {
            if (searching) return
            toggle(key)
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault()
              if (!searching) toggle(key)
            }
          }}
          title={project.name}
        >
          <ChevronDown size={13} className="caret" />
          <span
            className="dot"
            style={{ background: projectColor(project.color), color: projectColor(project.color) }}
          />
          <span className="name">{project.name}</span>
          {project.memoryEnabled && project.memoryChars > 0 ? (
            <button
              type="button"
              className="memory-mark"
              title="查看 / 编辑项目记忆"
              onClick={(event) => {
                event.stopPropagation()
                actions.editMemory(project)
              }}
            >
              <FileText size={11} />
            </button>
          ) : null}
          {items.length ? <span className="count">{items.length}</span> : null}
          <Menu
            align="right"
            width={208}
            trigger={({ onClick, open: isOpen }) => (
              <button
                type="button"
                className="icon-btn row-more"
                data-open={isOpen}
                onClick={onClick}
                title="项目操作"
              >
                <MoreHorizontal size={14} />
              </button>
            )}
          >
            {(close) => (
              <>
                <button
                  type="button"
                  className="menu-item"
                  onClick={() => {
                    close()
                    actions.newChat(project.id)
                  }}
                >
                  <Plus size={14} /> 在此项目新建对话
                </button>
                <button
                  type="button"
                  className="menu-item"
                  onClick={() => {
                    close()
                    expand(project.id)
                    actions.newSubproject(project)
                  }}
                >
                  <FolderPlus size={14} /> 新建子项目
                </button>
                <button
                  type="button"
                  className="menu-item"
                  onClick={() => {
                    close()
                    actions.editMemory(project)
                  }}
                >
                  <FileText size={14} /> 项目记忆…
                  {project.memoryEnabled ? (
                    <span className="menu-trailing">{project.memoryChars ? '已启用' : '空'}</span>
                  ) : null}
                </button>
                <div className="menu-sep" />
                <button
                  type="button"
                  className="menu-item"
                  onClick={() => {
                    close()
                    actions.renameProject(project)
                  }}
                >
                  <Pencil size={14} /> 重命名 / 移动
                </button>
                <button
                  type="button"
                  className="menu-item danger"
                  onClick={() => {
                    close()
                    actions.deleteProject(project)
                  }}
                >
                  <Trash2 size={14} /> 删除项目
                </button>
              </>
            )}
          </Menu>
        </div>
        <div className="conv-list" data-open={open}>
          <div>
            {items.length ? convList(items, depth) : children.length ? null : convList([], depth)}
            {children.length ? (
              <div className="project-children">
                {children.map((child) => renderProject(child, depth + 1))}
              </div>
            ) : null}
          </div>
        </div>
      </div>
    )
  }

  const renderUngrouped = () => {
    const open = searching || !collapsed.has(UNGROUPED)
    return (
      <div className="project-group" key={UNGROUPED}>
        <div
          className="project-row"
          data-open={open}
          role="button"
          tabIndex={0}
          onClick={() => {
            if (searching) return
            toggle(UNGROUPED)
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault()
              if (!searching) toggle(UNGROUPED)
            }
          }}
          title="未分组"
        >
          <ChevronDown size={13} className="caret" />
          <span
            className="dot"
            style={{ background: 'var(--line-strong)', color: 'var(--line-strong)' }}
          />
          <span className="name">未分组</span>
          <span className="count">{ungrouped.length}</span>
        </div>
        <div className="conv-list" data-open={open}>
          <div>{convList(ungrouped, 0)}</div>
        </div>
      </div>
    )
  }

  return (
    <aside className="sidebar">
      <div className="brand">
        <div className="brand-mark">
          <Logo size={28} />
        </div>
        <div className="brand-text">
          <span className="brand-name">deepdock</span>
          <span className="brand-sub">深坞 · DeepSeek</span>
        </div>
      </div>

      <button type="button" className="new-chat" onClick={() => actions.newChat(null)}>
        <Plus size={15} />
        <span className="new-chat-label">新对话</span>
        <kbd>Ctrl N</kbd>
      </button>

      <div className="search-box">
        <Search size={13} />
        <input
          value={query}
          onChange={(e) => onQuery(e.target.value)}
          placeholder="搜索对话"
          aria-label="搜索对话"
        />
        {query ? (
          <button type="button" className="icon-btn tiny" onClick={() => onQuery('')} title="清空">
            <X size={12} />
          </button>
        ) : (
          <span className="search-kbd" onClick={onOpenPalette} title="打开全局搜索">
            Ctrl K
          </span>
        )}
      </div>

      <div className="nav">
        <div className="section-head">
          <span>项目</span>
          <span className="section-count">{projects.length || ''}</span>
          <button
            type="button"
            className="icon-btn tiny"
            onClick={() => actions.newProject(null)}
            title="新建项目"
            style={{ marginLeft: 2 }}
          >
            <FolderPlus size={14} />
          </button>
        </div>

        {searching ? (
          <div className="project-group">
            <div className="conv-inner" style={{ margin: '2px 0 6px', borderLeft: 0, paddingLeft: 0 }}>
              {filtered.length ? (
                filtered.map((conv) => convRow(conv, true))
              ) : (
                <div className="conv-empty">没有找到「{query}」</div>
              )}
            </div>
          </div>
        ) : (
          <>
            {roots.map((project) => renderProject(project, 0))}
            {ungrouped.length ? renderUngrouped() : null}
            {!projects.length && !conversations.length ? (
              <div className="conv-empty" style={{ padding: '10px 8px', lineHeight: 1.6 }}>
                先建一个项目，把对话分门别类收好。
              </div>
            ) : null}
          </>
        )}
      </div>

      <div className="sidebar-foot">
        <Menu
          align="left"
          width={224}
          trigger={({ onClick, open }) => (
            <button type="button" className="account" onClick={onClick} data-open={open}>
              <span className="avatar">{initials(user)}</span>
              <span className="account-name">{displayName(user)}</span>
              <span className="status-dot" />
            </button>
          )}
        >
          {(close) => (
            <>
              <div className="menu-label account-name-label">{displayName(user)}</div>
              <button
                type="button"
                className="menu-item"
                onClick={() => {
                  close()
                  actions.sync()
                }}
              >
                <CloudDownload size={14} /> 从网页同步对话
              </button>
              <button
                type="button"
                className="menu-item"
                onClick={() => {
                  close()
                  actions.settings()
                }}
              >
                <Settings size={14} /> 设置
              </button>
              <div className="menu-sep" />
              <button
                type="button"
                className="menu-item"
                onClick={() => {
                  close()
                  actions.account('refresh')
                }}
              >
                <RefreshCw size={14} /> 刷新账号信息
              </button>
              <button
                type="button"
                className="menu-item"
                onClick={() => {
                  close()
                  actions.account('reconnect')
                }}
              >
                <PlugZap size={14} /> 重新连接
              </button>
              <div className="menu-sep" />
              {desktop ? (
                <>
                  <button
                    type="button"
                    className="menu-item"
                    onClick={() => {
                      close()
                      actions.account('dataFolder')
                    }}
                  >
                    <FolderInput size={14} /> 打开数据目录
                  </button>
                  <button
                    type="button"
                    className="menu-item"
                    onClick={() => {
                      close()
                      actions.account('checkUpdates')
                    }}
                  >
                    <Download size={14} /> 检查更新
                  </button>
                </>
              ) : null}
              <button
                type="button"
                className="menu-item danger"
                onClick={() => {
                  close()
                  actions.account('disconnect')
                }}
              >
                <LogOut size={14} /> 断开连接
              </button>
              <div className="menu-label account-status">
                {loginAge === null
                  ? '登录会自动保持'
                  : loginAge === 0
                    ? '今天已自动登录'
                    : `已保持登录 ${loginAge} 天`}
                {credentialSource ? <span>{credentialSource}</span> : null}
              </div>
            </>
          )}
        </Menu>
        <button
          type="button"
          className="icon-btn"
          onClick={actions.settings}
          title="设置"
        >
          <Settings size={15} />
        </button>
        <button
          type="button"
          className="icon-btn"
          onClick={onToggleTheme}
          title={dark ? '切换到浅色' : '切换到深色'}
        >
          {dark ? <Sun size={15} /> : <Moon size={15} />}
        </button>
      </div>
    </aside>
  )
}

export { UNGROUPED }
