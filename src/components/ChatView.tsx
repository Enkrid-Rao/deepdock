import { useEffect, useRef, useState } from 'react'
import {
  ArrowDown,
  CloudDownload,
  FolderInput,
  Menu as MenuIcon,
  MoreHorizontal,
  PanelLeft,
  Pencil,
  Pin,
  PinOff,
  Sparkles,
  Trash2,
} from 'lucide-react'
import { Composer } from './Composer'
import { MessageView } from './Message'
import { Menu, WaveArt } from './ui'
import { projectColor, type Conversation, type MemoryRef, type Message, type Project } from '../lib/types'
import type { DraftAttachment } from '../lib/attachments'

const QUICK_PROMPTS = [
  { icon: 'spark', text: '把这段代码改得更干净' },
  { icon: 'spark', text: '用一句话解释量子纠缠' },
  { icon: 'spark', text: '帮我写一封得体的请假邮件' },
  { icon: 'spark', text: '把这篇文章提炼成五条要点' },
]

export function ChatView({
  conversation,
  projects,
  streaming,
  draft,
  onDraftChange,
  onSend,
  onStop,
  onRegenerate,
  thinking,
  search,
  onToggleThinking,
  onToggleSearch,
  onRename,
  onMove,
  onPin,
  onDelete,
  onOpenDrawer,
  sidebarCollapsed = false,
  onToggleSidebar,
  onSync,
  onSyncConversation,
  syncingConversation = false,
  memoryRefs = [],
  onOpenMemory,
  attachments = [],
  onAddFiles,
  onRemoveAttachment,
}: {
  conversation: Conversation | null
  projects: Project[]
  streaming: boolean
  draft: string
  onDraftChange: (value: string) => void
  onSend: () => void
  onStop: () => void
  onRegenerate: () => void
  thinking: boolean
  search: boolean
  onToggleThinking: () => void
  onToggleSearch: () => void
  onRename: (title: string) => void
  onMove: () => void
  onPin: () => void
  onDelete: () => void
  onOpenDrawer: () => void
  sidebarCollapsed?: boolean
  onToggleSidebar?: () => void
  onSync: () => void
  onSyncConversation?: () => void
  syncingConversation?: boolean
  memoryRefs?: MemoryRef[]
  onOpenMemory?: (projectId: string) => void
  attachments?: DraftAttachment[]
  onAddFiles: (files: FileList | File[] | null) => void
  onRemoveAttachment: (key: string) => void
}) {
  const scrollerRef = useRef<HTMLDivElement>(null)
  const stickRef = useRef(true)
  const [showJump, setShowJump] = useState(false)
  const [editing, setEditing] = useState(false)
  const [titleDraft, setTitleDraft] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  const messages: Message[] = conversation?.messages || []
  const project = projects.find((p) => p.id === conversation?.projectId) || null

  const measure = () => {
    const el = scrollerRef.current
    if (!el) return
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight
    stickRef.current = distance < 90
    setShowJump(distance > 260)
  }

  useEffect(() => {
    const el = scrollerRef.current
    if (!el) return
    stickRef.current = true
    setShowJump(false)
    el.scrollTop = el.scrollHeight
  }, [conversation?.id])

  useEffect(() => {
    const el = scrollerRef.current
    if (!el || !stickRef.current) return
    el.scrollTop = el.scrollHeight
  }, [messages])

  useEffect(() => {
    if (editing) inputRef.current?.select()
  }, [editing])

  const commitTitle = () => {
    const value = titleDraft.trim()
    setEditing(false)
    if (value && value !== conversation?.title) onRename(value)
  }

  const quickPrompt = (text: string) => {
    onDraftChange(text)
    requestAnimationFrame(() => {
      document.querySelector<HTMLTextAreaElement>('.composer textarea')?.focus()
    })
  }

  const empty = messages.length === 0

  return (
    <main className="main">
      <header className="topbar">
        <button type="button" className="icon-btn menu-toggle" onClick={onOpenDrawer} title="菜单">
          <MenuIcon size={17} />
        </button>
        <button
          type="button"
          className="icon-btn sidebar-toggle"
          onClick={onToggleSidebar}
          title={sidebarCollapsed ? '展开侧栏（Ctrl + B）' : '收起侧栏（Ctrl + B）'}
          aria-label={sidebarCollapsed ? '展开侧栏' : '收起侧栏'}
        >
          <PanelLeft size={17} />
        </button>

        <div className="title-area">
          {editing ? (
            <input
              ref={inputRef}
              className="chat-title-input"
              value={titleDraft}
              onChange={(e) => setTitleDraft(e.target.value)}
              onBlur={commitTitle}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commitTitle()
                if (e.key === 'Escape') setEditing(false)
              }}
            />
          ) : (
            <button
              type="button"
              className="chat-title"
              onClick={() => {
                if (!conversation) return
                setTitleDraft(conversation.title || '')
                setEditing(true)
              }}
              title={conversation ? '点击重命名' : 'DeepDock'}
            >
              {conversation?.title || 'DeepDock'}
            </button>
          )}
          {project ? (
            <span className="project-chip">
              <span className="dot" style={{ background: projectColor(project.color) }} />
              {project.name}
            </span>
          ) : null}
          {conversation?.pinned ? (
            <span className="project-chip" style={{ color: 'var(--accent)' }}>
              <Pin size={10} /> 已置顶
            </span>
          ) : null}
        </div>

        <div className="topbar-actions">
          <button
            type="button"
            className="icon-btn"
            onClick={onSync}
            title="从网页同步对话"
            aria-label="从网页同步对话"
          >
            <CloudDownload size={16} />
          </button>
          {conversation && messages.length ? (
            <Menu
              align="right"
              width={200}
              trigger={({ onClick, open }) => (
                <button
                  type="button"
                  className="icon-btn"
                  onClick={onClick}
                  data-open={open}
                  title="对话操作"
                >
                  <MoreHorizontal size={17} />
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
                      setTitleDraft(conversation.title || '')
                      setEditing(true)
                    }}
                  >
                    <Pencil size={14} /> 重命名
                  </button>
                  <button
                    type="button"
                    className="menu-item"
                    onClick={() => {
                      close()
                      onPin()
                    }}
                  >
                    {conversation.pinned ? <PinOff size={14} /> : <Pin size={14} />}
                    {conversation.pinned ? '取消置顶' : '置顶'}
                  </button>
                  <button
                    type="button"
                    className="menu-item"
                    onClick={() => {
                      close()
                      onMove()
                    }}
                  >
                    <FolderInput size={14} /> 移动到项目
                  </button>
                  {conversation.dsSessionId && onSyncConversation ? (
                    <button
                      type="button"
                      className="menu-item"
                      disabled={syncingConversation}
                      onClick={() => {
                        close()
                        onSyncConversation()
                      }}
                    >
                      <CloudDownload size={14} />
                      {syncingConversation ? '正在从网页同步…' : '从网页同步这段对话'}
                    </button>
                  ) : null}
                  <div className="menu-sep" />
                  <button
                    type="button"
                    className="menu-item danger"
                    onClick={() => {
                      close()
                      onDelete()
                    }}
                  >
                    <Trash2 size={14} /> 删除对话
                  </button>
                </>
              )}
            </Menu>
          ) : (
            <span className="ghost-btn" style={{ cursor: 'default' }}>
              <Sparkles size={13} />
              {streaming ? '生成中' : '就绪'}
            </span>
          )}
        </div>
      </header>

      <div className="scroller" ref={scrollerRef} onScroll={measure}>
        {empty ? (
          <div className="empty">
            <WaveArt className="empty-art" />
            <div className="empty-eyebrow">deepdock</div>
            <h1>
              A quiet place for
              <br />
              your <em>conversations</em>.
            </h1>
            <p>把散落在 DeepSeek 里的对话收进项目，下一次要找的时候，它就在原处。</p>
            <div className="prompt-grid">
              {QUICK_PROMPTS.map((p) => (
                <button key={p.text} type="button" className="prompt-chip" onClick={() => quickPrompt(p.text)}>
                  <Sparkles size={12.5} />
                  {p.text}
                </button>
              ))}
              <button type="button" className="prompt-chip prompt-chip-action" onClick={onSync}>
                <CloudDownload size={12.5} />
                从网页端导入历史对话
              </button>
            </div>
            <div className="empty-foot">
              <kbd>Enter</kbd> 发送 · <kbd>Ctrl</kbd> <kbd>K</kbd> 搜索 · 本地转发，不额外保存
            </div>
          </div>
        ) : (
          <div className="thread">
            {messages.map((message) => (
              <MessageView
                key={message.id}
                message={message}
                onRegenerate={
                  message.role === 'assistant' && !message.streaming ? onRegenerate : undefined
                }
              />
            ))}
            <div style={{ height: 6 }} />
          </div>
        )}
      </div>

      {showJump ? (
        <button
          type="button"
          className="jump"
          onClick={() => {
            const el = scrollerRef.current
            if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
          }}
        >
          <ArrowDown size={13} /> 回到最新
        </button>
      ) : null}

      <Composer
        draft={draft}
        onDraftChange={onDraftChange}
        onSend={onSend}
        onStop={onStop}
        streaming={streaming}
        thinking={thinking}
        search={search}
        onToggleThinking={onToggleThinking}
        onToggleSearch={onToggleSearch}
        memoryRefs={memoryRefs}
        onOpenMemory={onOpenMemory}
        attachments={attachments}
        onAddFiles={onAddFiles}
        onRemoveAttachment={onRemoveAttachment}
      />
    </main>
  )
}


