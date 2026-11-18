import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Sidebar } from './components/Sidebar'
import { ChatView } from './components/ChatView'
import { CommandPalette } from './components/CommandPalette'
import { Connect } from './components/Connect'
import { ConfirmDialog, MoveDialog, ProjectDialog, PromptDialog } from './components/Dialogs'
import { SyncDialog } from './components/SyncDialog'
import { SettingsPage } from './components/SettingsPage'
import { ProjectMemoryDialog } from './components/ProjectMemoryDialog'
import { Logo, Toaster, type ToastItem } from './components/ui'
import { api, ApiError, streamChat } from './lib/api'
import {
  applyAppearance,
  loadAppearance,
  resolveTheme,
  saveAppearance,
  type Appearance,
} from './lib/appearance'
import { resolveMemoryRefs } from './lib/projects'
import { useDraftAttachments } from './lib/attachments'
import type {
  Attachment,
  Bootstrap,
  Conversation,
  ConversationMeta,
  Message,
  MessageReference,
  Project,
  SyncImportResult,
  UpdateState,
  User,
} from './lib/types'

const uid = () =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(16).slice(2)}`

type AutoConnectResult = {
  ok: boolean
  reason?: string
  source?: string
  sources?: string[]
  user?: User | null
}

type DesktopBridge = {
  isDesktop: boolean
  platform: string
  setAppearance: (payload: { dark: boolean; background: string }) => void
  openDataFolder: () => Promise<{ ok: boolean; path?: string }>
  openExternal: (url: string) => Promise<void>
  info: () => Promise<{ version: string; dataDir: string; electron: string }>
  autoConnect?: () => Promise<AutoConnectResult>
  checkUpdates?: () => Promise<UpdateState>
  downloadUpdate?: () => Promise<UpdateState>
  installUpdate?: () => Promise<{ ok: boolean }>
  updateState?: () => Promise<UpdateState>
  onUpdateState?: (callback: (state: UpdateState) => void) => () => void
}

const desktop = (window as unknown as { deepdockDesktop?: DesktopBridge }).deepdockDesktop

if (desktop) {
  document.documentElement.dataset.desktop = 'true'
}

const THINKING_KEY = 'deepdock:thinking'
const SEARCH_KEY = 'deepdock:search'
const SIDEBAR_KEY = 'deepdock:sidebar'

function readBool(key: string, fallback = false): boolean {
  try {
    const raw = localStorage.getItem(key)
    if (raw === null) return fallback
    return raw === '1'
  } catch {
    return fallback
  }
}

function makeTitle(text: string): string {
  const clean = text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/[#>*_`]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  return clean.slice(0, 60) || '新对话'
}

function sortConversations(list: ConversationMeta[]): ConversationMeta[] {
  return [...list].sort((a, b) => {
    if (Boolean(a.pinned) !== Boolean(b.pinned)) return a.pinned ? -1 : 1
    return (b.updatedAt || 0) - (a.updatedAt || 0)
  })
}

export default function App() {
  const [boot, setBoot] = useState<Bootstrap | null>(null)
  const [fatal, setFatal] = useState<string | null>(null)
  const [projects, setProjects] = useState<Project[]>([])
  const [conversations, setConversations] = useState<ConversationMeta[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [activeConv, setActiveConv] = useState<Conversation | null>(null)
  const [streamingId, setStreamingId] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [thinking, setThinking] = useState(() => readBool(THINKING_KEY))
  const [search, setSearch] = useState(() => readBool(SEARCH_KEY))
  const [appearance, setAppearance] = useState<Appearance>(loadAppearance)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [pendingProjectId, setPendingProjectId] = useState<string | null>(null)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => {
    try {
      return localStorage.getItem(SIDEBAR_KEY) === 'collapsed'
    } catch {
      return false
    }
  })
  const [updateState, setUpdateState] = useState<UpdateState | null>(null)
  const [syncOpen, setSyncOpen] = useState(false)
  const [drawer, setDrawer] = useState(false)
  const [palette, setPalette] = useState(false)
  const [query, setQuery] = useState('')
  const [toasts, setToasts] = useState<ToastItem[]>([])
  const [reconnect, setReconnect] = useState(false)
  const [convSyncing, setConvSyncing] = useState(false)
  const [, setThemeTick] = useState(0)

  const [projectDialog, setProjectDialog] = useState<{
    project: Project | null
    parentId: string | null
  } | null>(null)
  const [memoryProject, setMemoryProject] = useState<Project | null>(null)
  const [promptDialog, setPromptDialog] = useState<{
    title: string
    description?: string
    initialValue?: string
    confirmLabel?: string
    onSubmit: (value: string) => void
  } | null>(null)
  const [confirmDialog, setConfirmDialog] = useState<{
    title: string
    description?: string
    confirmLabel?: string
    onConfirm: () => void
  } | null>(null)
  const [moveConv, setMoveConv] = useState<ConversationMeta | null>(null)

  const streamRef = useRef<{
    convId: string
    asstId: string
    content: string
    reasoning: string
    raf: number
  } | null>(null)
  const abortRef = useRef<AbortController | null>(null)
  const selectSeq = useRef(0)
  const recoveringRef = useRef(false)

  const toast = useCallback((text: string) => {
    const id = Date.now() + Math.random()
    setToasts((prev) => [...prev, { id, text }])
    window.setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), 2800)
  }, [])

  const {
    items: draftAttachments,
    ready: readyAttachments,
    addFiles,
    remove: removeAttachment,
    reset: resetDrafts,
  } = useDraftAttachments(toast)

  /* ------------------------------------------------------------ theme */

  const dark = resolveTheme(appearance) === 'dark'

  useEffect(() => {
    applyAppearance(appearance)
    saveAppearance(appearance)
  }, [appearance])

  useEffect(() => {
    document.documentElement.dataset.sidebar = sidebarCollapsed ? 'collapsed' : 'open'
    try {
      localStorage.setItem(SIDEBAR_KEY, sidebarCollapsed ? 'collapsed' : 'open')
    } catch {
      /* ignore */
    }
  }, [sidebarCollapsed])

  // Citation links added in a later version: fetch them once for old messages
  // that only contain [reference:N] text, then keep them in the local store.
  const citationBackfill = useRef(new Set<string>())
  useEffect(() => {
    const conv = activeConv
    if (!conv || citationBackfill.current.has(conv.id)) return undefined
    const pending = conv.messages.filter(
      (message) =>
        message.role === 'assistant' &&
        /\[reference:\d+\]/.test(message.content) &&
        (!message.references || !message.references.length),
    )
    if (!pending.length) return undefined
    citationBackfill.current.add(conv.id)
    let alive = true
    api
      .citations(conv.id)
      .then(({ references }) => {
        if (!alive || !references || !Object.keys(references).length) return
        setActiveConv((previous) => {
          if (!previous || previous.id !== conv.id) return previous
          return {
            ...previous,
            messages: previous.messages.map((message) =>
              references[message.id] ? { ...message, references: references[message.id] } : message,
            ),
          }
        })
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [activeConv?.id])

  useEffect(() => {
    if (appearance.mode !== 'system') return undefined
    const query = window.matchMedia?.('(prefers-color-scheme: dark)')
    if (!query) return undefined
    const onChange = () => {
      applyAppearance(appearance)
      setThemeTick((tick) => tick + 1)
    }
    query.addEventListener('change', onChange)
    return () => query.removeEventListener('change', onChange)
  }, [appearance])

  // Desktop updater: the main process owns the state machine and pushes every
  // change (checking / available / downloading / downloaded) here.
  useEffect(() => {
    if (!desktop?.onUpdateState) return undefined
    const unsubscribe = desktop.onUpdateState((state) => setUpdateState(state))
    desktop
      .updateState?.()
      .then((state) => setUpdateState(state))
      .catch(() => {})
    return unsubscribe
  }, [])

  useEffect(() => {
    try {
      localStorage.setItem(THINKING_KEY, thinking ? '1' : '0')
    } catch {
      /* ignore */
    }
  }, [thinking])

  useEffect(() => {
    try {
      localStorage.setItem(SEARCH_KEY, search ? '1' : '0')
    } catch {
      /* ignore */
    }
  }, [search])

  /* ---------------------------------------------------------- bootstrap */

  const openConversation = useCallback(
    async (id: string) => {
      const seq = ++selectSeq.current
      setActiveId(id)
      setPendingProjectId(null)
      setDrawer(false)
      setDraft('')
      resetDrafts()
      try {
        const conv = await api.getConversation(id)
        if (seq !== selectSeq.current) return
        setActiveConv({
          ...conv,
          messages: conv.messages.map((m) => ({ ...m, streaming: false })),
        })
      } catch {
        if (seq === selectSeq.current) toast('打开对话失败')
      }
    },
    [resetDrafts, toast],
  )

  const recoverAuth = useCallback(
    async (quiet = false) => {
      if (!desktop?.autoConnect || recoveringRef.current) return false
      recoveringRef.current = true
      try {
        const result = await desktop.autoConnect()
        if (result.ok) {
          const data = await api.bootstrap()
          setBoot({ ...data, user: result.user || data.user })
          setProjects(data.projects)
          setConversations(data.conversations)
          toast(`已从 ${result.source || '本机浏览器'} 续上登录`)
          return true
        }
        if (!quiet) toast('登录已失效，请重新连接账号')
        setBoot((previous) => (previous ? { ...previous, connected: false } : previous))
        return false
      } catch {
        if (!quiet) toast('自动恢复登录失败，请重新连接账号')
        return false
      } finally {
        recoveringRef.current = false
      }
    },
    [toast],
  )

  useEffect(() => {
    let alive = true
    api
      .bootstrap()
      .then((data) => {
        if (!alive) return
        setBoot(data)
        setProjects(data.projects)
        setConversations(data.conversations)
        if (data.mock) toast('演示模式：还没有连接真实账号')
        if (data.connected && data.conversations.length) {
          void openConversation(data.conversations[0].id)
        }
      })
      .catch(() => alive && setFatal('无法连接本地服务，请确认 DeepDock 正在运行。'))
    return () => {
      alive = false
    }
  }, [openConversation, toast])

  // Keep the long-lived login honest: if the stored token has quietly expired,
  // try to pick a live one back up from the local browser before bothering anyone.
  useEffect(() => {
    if (!boot?.connected || boot.mock) return undefined
    let alive = true
    api.account().catch((err) => {
      if (!alive) return
      if (err instanceof ApiError && err.status === 401) void recoverAuth(true)
    })
    return () => {
      alive = false
    }
  }, [boot?.connected, boot?.mock, recoverAuth])

  useEffect(() => {
    document.title = activeConv?.title ? `${activeConv.title} · DeepDock` : 'DeepDock'
  }, [activeConv?.title])

  /* ---------------------------------------------------------- shortcuts */

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey
      if (mod && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setPalette((v) => !v)
      } else if (mod && e.key.toLowerCase() === 'b') {
        e.preventDefault()
        setSidebarCollapsed((value) => !value)
      } else if (mod && e.key === ',') {
        e.preventDefault()
        setSettingsOpen(true)
      } else if (e.key === 'Escape') {
        setDrawer(false)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [resetDrafts])

  /* ------------------------------------------------------------ streaming */

  const flushStream = useCallback(() => {
    const s = streamRef.current
    if (!s) return
    s.raf = 0
    const { convId, asstId, content, reasoning } = s
    setActiveConv((prev) => {
      if (!prev || prev.id !== convId) return prev
      return {
        ...prev,
        messages: prev.messages.map((m) =>
          m.id === asstId ? { ...m, content, reasoning } : m,
        ),
      }
    })
  }, [])

  const pushDelta = useCallback(
    (key: 'content' | 'reasoning', delta: string) => {
      const s = streamRef.current
      if (!s || !delta) return
      s[key] += delta
      if (!s.raf) s.raf = requestAnimationFrame(flushStream)
    },
    [flushStream],
  )

  const stopStream = useCallback(async () => {
    if (!streamingId) return
    try {
      await api.stop(streamingId)
    } catch {
      /* ignore */
    }
  }, [streamingId])

  const runStream = useCallback(
    async (
      conv: Conversation,
      options: { regenerate?: boolean; text: string; attachments?: Attachment[] },
    ) => {
      const regenerate = Boolean(options.regenerate)
      const text = options.text.trim()
      const attachments = options.attachments || []
      const convId = conv.id

      let base = conv.messages.filter((m) => !m.streaming)
      if (regenerate) {
        while (base.length && base[base.length - 1].role === 'assistant') base = base.slice(0, -1)
      }

      const now = Date.now()
      const userMsg: Message = {
        id: uid(),
        role: 'user',
        content: text,
        createdAt: now,
        ...(attachments.length ? { attachments } : {}),
      }
      const asstMsg: Message = {
        id: uid(),
        role: 'assistant',
        content: '',
        reasoning: '',
        createdAt: now,
        streaming: true,
        thinking,
      }
      const title =
        !regenerate && (conv.title === '新对话' || conv.messages.length === 0)
          ? makeTitle(text || attachments[0]?.name || '')
          : conv.title

      setActiveConv({
        ...conv,
        title,
        messages: regenerate ? [...base, asstMsg] : [...base, userMsg, asstMsg],
      })
      setActiveId(convId)
      setDraft('')
      setStreamingId(convId)
      setConversations((prev) =>
        sortConversations(
          prev.map((c) => (c.id === convId ? { ...c, title, updatedAt: now } : c)),
        ),
      )
      streamRef.current = { convId, asstId: asstMsg.id, content: '', reasoning: '', raf: 0 }

      const controller = new AbortController()
      abortRef.current = controller

      const settle = (patch: {
        error?: string | null
        content?: string
        reasoning?: string
        references?: MessageReference[]
      }) => {
        const s = streamRef.current
        if (s?.raf) cancelAnimationFrame(s.raf)
        const content = patch.content ?? s?.content ?? ''
        const reasoning = patch.reasoning ?? s?.reasoning ?? ''
        setActiveConv((prev) => {
          if (!prev || prev.id !== convId) return prev
          return {
            ...prev,
            messages: prev.messages.map((m) =>
              m.id === asstMsg.id
                ? { ...m, content, reasoning, streaming: false, ...patch }
                : m,
            ),
          }
        })
        streamRef.current = null
        setStreamingId(null)
      }

      await streamChat(
        convId,
        {
          content: text,
          thinking,
          search,
          regenerate,
          attachments: attachments.map((item) => item.id),
        },
        {
          onStart: (data) => {
            if (regenerate || !data.userMessage) return
            const stored = data.userMessage
            setActiveConv((previous) => {
              if (!previous || previous.id !== convId) return previous
              return {
                ...previous,
                messages: previous.messages.map((message) =>
                  message.id === userMsg.id ? { ...stored, streaming: false } : message,
                ),
              }
            })
          },
          onDelta: (delta) => pushDelta('content', delta),
          onReasoning: (delta) => pushDelta('reasoning', delta),
          onReferences: (references) => {
            setActiveConv((previous) => {
              if (!previous || previous.id !== convId) return previous
              return {
                ...previous,
                messages: previous.messages.map((message) =>
                  message.id === asstMsg.id ? { ...message, references } : message,
                ),
              }
            })
          },
          onDone: (data) => {
            settle({
              error: null,
              content: data.content,
              reasoning: data.reasoning,
              references: data.references,
            })
            if (data.conversation) {
              setConversations((prev) =>
                sortConversations(
                  prev.map((c) => (c.id === convId ? { ...c, ...data.conversation } : c)),
                ),
              )
              setActiveConv((prev) =>
                prev && prev.id === convId ? { ...prev, ...data.conversation } : prev,
              )
            }
          },
          onError: (message, code) => {
            settle({ error: message })
            toast(message)
            if (code === 40003 || code === 40002 || code === 'unauthorized') {
              void recoverAuth(true)
            }
          },
          onAborted: () => settle({}),
        },
        controller.signal,
      )
    },
    [pushDelta, recoverAuth, search, thinking, toast],
  )

  const send = useCallback(async () => {
    if (streamingId) return
    const text = draft.trim()
    const files = readyAttachments
      .map((item) => item.attachment)
      .filter((item): item is Attachment => Boolean(item))
    if (!text && !files.length) return

    let conv = activeConv
    if (!conv) {
      try {
        const meta = await api.createConversation({ projectId: pendingProjectId })
        conv = { ...meta, messages: [] }
        setConversations((prev) =>
          sortConversations([meta, ...prev.filter((item) => item.id !== meta.id)]),
        )
        setActiveId(meta.id)
        setActiveConv(conv)
        setPendingProjectId(null)
      } catch {
        toast('创建对话失败')
        return
      }
    }
    resetDrafts()
    await runStream(conv, { text, attachments: files })
  }, [activeConv, draft, pendingProjectId, readyAttachments, resetDrafts, runStream, streamingId, toast])

  const regenerate = useCallback(async () => {
    if (streamingId || !activeConv) return
    const lastUser = [...activeConv.messages].reverse().find((m) => m.role === 'user')
    if (!lastUser) return
    await runStream(activeConv, { text: lastUser.content, regenerate: true })
  }, [activeConv, runStream, streamingId])

  /* ------------------------------------------------------------- actions */

  const newChat = useCallback(
    (projectId?: string | null) => {
      if (streamingId) {
        toast('等这次回复结束再开新对话')
        return
      }
      setDrawer(false)
      // Same as chat.deepseek.com: a new chat is just a blank view. Nothing is
      // written to history until the first message is sent.
      const target = projectId ?? activeConv?.projectId ?? pendingProjectId ?? null
      setActiveId(null)
      setActiveConv(null)
      setPendingProjectId(target)
      setDraft('')
      resetDrafts()
    },
    [activeConv, pendingProjectId, resetDrafts, streamingId, toast],
  )

  // Ctrl+N follows the same rule (and creates the conversation immediately), so
  // the shortcut cannot land the next message in 未分组 either.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const mod = event.metaKey || event.ctrlKey
      if (!mod || event.key.toLowerCase() !== 'n') return
      event.preventDefault()
      void newChat()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [newChat])

  const renameConversation = useCallback(
    (conv: ConversationMeta) => {
      setPromptDialog({
        title: '重命名对话',
        initialValue: conv.title,
        confirmLabel: '保存',
        onSubmit: async (value) => {
          setPromptDialog(null)
          try {
            const updated = await api.updateConversation(conv.id, { title: value })
            setConversations((prev) => prev.map((c) => (c.id === conv.id ? updated : c)))
            setActiveConv((prev) => (prev && prev.id === conv.id ? { ...prev, title: value } : prev))
          } catch {
            toast('重命名失败')
          }
        },
      })
    },
    [toast],
  )

  const pinConversation = useCallback(
    async (conv: ConversationMeta) => {
      try {
        const updated = await api.updateConversation(conv.id, { pinned: !conv.pinned })
        setConversations((prev) => sortConversations(prev.map((c) => (c.id === conv.id ? updated : c))))
        setActiveConv((prev) => (prev && prev.id === conv.id ? { ...prev, pinned: updated.pinned } : prev))
        toast(updated.pinned ? '已置顶' : '已取消置顶')
      } catch {
        toast('操作失败')
      }
    },
    [toast],
  )

  const moveConversation = useCallback(
    async (conv: ConversationMeta, projectId: string | null) => {
      setMoveConv(null)
      try {
        const updated = await api.updateConversation(conv.id, { projectId })
        setConversations((prev) => prev.map((c) => (c.id === conv.id ? updated : c)))
        setActiveConv((prev) => (prev && prev.id === conv.id ? { ...prev, projectId } : prev))
        const name = projects.find((p) => p.id === projectId)?.name
        toast(name ? `已移动到「${name}」` : '已移出项目')
      } catch {
        toast('移动失败')
      }
    },
    [projects, toast],
  )

  const deleteConversation = useCallback(
    (conv: ConversationMeta) => {
      setConfirmDialog({
        title: '删除这段对话？',
        description: `「${conv.title}」会从本地删除；DeepSeek 账号里的会话不受影响。`,
        confirmLabel: '删除',
        onConfirm: async () => {
          setConfirmDialog(null)
          try {
            await api.deleteConversation(conv.id)
            setConversations((prev) => prev.filter((c) => c.id !== conv.id))
            if (activeId === conv.id) {
              if (streamingId === conv.id) {
                await stopStream()
              }
              setActiveId(null)
              setActiveConv(null)
            }
          } catch {
            toast('删除失败')
          }
        },
      })
    },
    [activeId, stopStream, streamingId, toast],
  )

  const saveProject = useCallback(
    async (value: { name: string; color: string; parentId: string | null }) => {
      const editing = projectDialog?.project || null
      setProjectDialog(null)
      try {
        if (editing) {
          const updated = await api.updateProject(editing.id, value)
          setProjects((prev) => prev.map((p) => (p.id === editing.id ? updated : p)))
        } else {
          const created = await api.createProject(value)
          setProjects((prev) => [...prev, created])
          toast(`项目「${created.name}」已创建`)
        }
      } catch (err) {
        toast(err instanceof ApiError ? err.message : '保存项目失败')
      }
    },
    [projectDialog, toast],
  )

  const deleteProject = useCallback(
    (project: Project) => {
      setConfirmDialog({
        title: `删除项目「${project.name}」？`,
        description: '项目里的对话会回到「未分组」；子项目会向上移动一层，不会被一起删除。',
        confirmLabel: '删除项目',
        onConfirm: async () => {
          setConfirmDialog(null)
          try {
            const res = await api.deleteProject(project.id)
            setProjects(res.projects)
            setConversations(sortConversations(res.conversations))
            if (activeConv?.projectId === project.id) {
              setActiveConv((prev) => (prev ? { ...prev, projectId: null } : prev))
            }
          } catch {
            toast('删除项目失败')
          }
        },
      })
    },
    [activeConv?.projectId, toast],
  )

  const saveProjectMemory = useCallback(
    (project: Project) => {
      setProjects((prev) => prev.map((item) => (item.id === project.id ? project : item)))
      setMemoryProject((current) => (current && current.id === project.id ? project : current))
      toast('项目记忆已保存')
    },
    [toast],
  )

  const accountAction = useCallback(
    async (action: 'refresh' | 'reconnect' | 'disconnect' | 'dataFolder' | 'checkUpdates') => {
      if (action === 'dataFolder') {
        const result = await desktop?.openDataFolder()
        if (!result?.ok) toast('没能打开数据目录')
        return
      }
      if (action === 'checkUpdates') {
        if (!desktop?.checkUpdates) {
          toast('只有桌面版可以检查更新')
          return
        }
        toast('正在检查更新…')
        try {
          const result = await desktop.checkUpdates()
          setUpdateState(result)
          if (result.status === 'current') {
            toast(`已经是最新版本（v${result.current || result.version || ''}）`)
          } else if (result.status === 'available') {
            toast(`发现新版本 v${result.version}，可在「设置 → 应用 → 更新」里安装`)
          } else if (result.status === 'downloaded') {
            toast(`新版本 v${result.version} 已下载，重启即可安装`)
          } else if (result.status === 'dev') {
            toast('开发模式下不检查更新')
          } else if (result.status === 'error') {
            toast(result.message || '检查更新失败，请稍后再试')
          }
        } catch {
          toast('检查更新失败，请稍后再试')
        }
        return
      }
      if (action === 'refresh') {
        try {
          const res = await api.account()
          setBoot((prev) => (prev ? { ...prev, user: res.user } : prev))
          toast('账号信息已刷新')
        } catch (err) {
          if (err instanceof ApiError && err.status === 401) {
            const recovered = await recoverAuth()
            if (recovered) toast('已自动续用浏览器里的登录状态')
          } else {
            toast('刷新失败，可能需要重新连接')
          }
        }
        return
      }
      if (action === 'reconnect') {
        setReconnect(true)
        return
      }
      try {
        await api.disconnect()
        setReconnect(false)
        setBoot((prev) => (prev ? { ...prev, connected: false } : prev))
        setActiveConv(null)
        setActiveId(null)
      } catch {
        toast('断开失败')
      }
    },
    [recoverAuth, toast],
  )

  const onConnected = useCallback(
    async (user: User | null) => {
      setReconnect(false)
      try {
        const data = await api.bootstrap()
        setBoot({ ...data, user: user || data.user })
        setProjects(data.projects)
        setConversations(data.conversations)
        if (data.conversations.length) void openConversation(data.conversations[0].id)
        toast('已连接 DeepSeek')
      } catch {
        setBoot((prev) => (prev ? { ...prev, connected: true, user } : prev))
      }
    },
    [openConversation, toast],
  )

  const handleSynced = useCallback(
    (result: SyncImportResult) => {
      setConversations(sortConversations(result.conversations))
      const first = result.results.find((row) => row.status === 'imported' && row.conversationId)
      if (first?.conversationId) void openConversation(first.conversationId)
      if (result.imported) {
        toast(`已从网页导入 ${result.imported} 个对话`)
      } else if (result.skipped) {
        toast('选中的对话都已经在本地了')
      } else if (result.failed) {
        toast('导入没有成功，请稍后再试')
      }
    },
    [openConversation, toast],
  )

  const openSync = useCallback(() => {
    if (streamingId) {
      toast('等这次回复结束再同步')
      return
    }
    setSyncOpen(true)
  }, [streamingId, toast])

  const syncConversation = useCallback(async () => {
    if (!activeConv || streamingId || convSyncing) return
    if (!activeConv.dsSessionId) {
      toast('这段对话还没有对应的网页会话，先发一条消息')
      return
    }
    setConvSyncing(true)
    try {
      const res = await api.syncRefresh(activeConv.id)
      setConversations((previous) =>
        sortConversations(
          previous.map((conversation) =>
            conversation.id === res.conversation.id ? { ...conversation, ...res.conversation } : conversation,
          ),
        ),
      )
      if (res.added) {
        const fresh = await api.getConversation(activeConv.id)
        setActiveConv({ ...fresh, messages: fresh.messages.map((message) => ({ ...message, streaming: false })) })
        toast(`已从网页补上 ${res.added} 条消息`)
      } else {
        setActiveConv((previous) => (previous ? { ...previous, ...res.conversation } : previous))
        toast('这段对话已经和网页端一致')
      }
    } catch (err) {
      if (err instanceof ApiError) {
        toast(err.message)
        if (err.status === 401) void recoverAuth(true)
      } else {
        toast('同步失败，请稍后再试')
      }
    } finally {
      setConvSyncing(false)
    }
  }, [activeConv, convSyncing, recoverAuth, streamingId, toast])

  /* --------------------------------------------------------------- render */

  const memoryRefs = useMemo(() => {
    if (!activeConv || activeConv.messages.length > 0) return []
    return resolveMemoryRefs(projects, activeConv.projectId)
  }, [activeConv, projects])

  const openMemoryForProject = useCallback(
    (projectId: string) => {
      const project = projects.find((item) => item.id === projectId)
      if (project) setMemoryProject(project)
    },
    [projects],
  )

  const sidebarActions = useMemo(
    () => ({
      newChat,
      select: (id: string) => void openConversation(id),
      newProject: (parentId: string | null = null) =>
        setProjectDialog({ project: null, parentId }),
      newSubproject: (project: Project) =>
        setProjectDialog({ project: null, parentId: project.id }),
      editMemory: (project: Project) => setMemoryProject(project),
      renameProject: (project: Project) =>
        setProjectDialog({ project, parentId: project.parentId || null }),
      deleteProject,
      renameConversation,
      moveConversation: (conv: ConversationMeta) => setMoveConv(conv),
      deleteConversation,
      pinConversation,
      account: (action: 'refresh' | 'reconnect' | 'disconnect' | 'dataFolder' | 'checkUpdates') =>
        void accountAction(action),
      sync: () => openSync(),
      settings: () => setSettingsOpen(true),
    }),
    [
      accountAction,
      deleteConversation,
      deleteProject,
      moveConversation,
      newChat,
      openConversation,
      openSync,
      pinConversation,
      renameConversation,
    ],
  )

  if (fatal) {
    return (
      <div className="connect">
        <div className="connect-card" style={{ textAlign: 'center' }}>
          <div className="brand-mark" style={{ margin: '0 auto 14px' }}>
            <Logo size={28} />
          </div>
          <h1 style={{ fontSize: 24 }}>{fatal}</h1>
          <p className="lede">在项目目录里运行 <code>npm start</code> 后刷新页面即可。</p>
        </div>
      </div>
    )
  }

  if (!boot) {
    return (
      <div className="connect">
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, color: 'var(--muted)' }}>
          <span className="brand-mark">
            <Logo size={28} />
          </span>
          <span style={{ fontFamily: 'var(--font-serif)', fontSize: 20, color: 'var(--ink)' }}>deepdock</span>
        </div>
      </div>
    )
  }

  if (!boot.connected || reconnect) {
    return (
      <>
        <Connect
          mock={boot.mock}
          onConnected={onConnected}
          onClose={reconnect ? () => setReconnect(false) : undefined}
        />
        <Toaster toasts={toasts} />
      </>
    )
  }

  return (
    <>
      <div className="app" data-drawer={drawer}>
        <Sidebar
          projects={projects}
          conversations={conversations}
          activeId={activeId}
          activeProjectId={activeConv?.projectId || null}
          user={boot.user}
          dark={dark}
          savedAt={boot.savedAt ?? null}
          credentialSource={boot.credentialSource ?? null}
          query={query}
          onQuery={setQuery}
          onToggleTheme={() =>
            setAppearance((previous) => ({
              ...previous,
              mode: resolveTheme(previous) === 'dark' ? 'light' : 'dark',
            }))
          }
          onOpenPalette={() => setPalette(true)}
          desktop={Boolean(desktop)}
          actions={sidebarActions}
        />

        {drawer ? <div className="scrim" onClick={() => setDrawer(false)} /> : null}

        <ChatView
          conversation={activeConv}
          projects={projects}
          streaming={Boolean(streamingId)}
          draft={draft}
          onDraftChange={setDraft}
          onSend={() => void send()}
          onStop={() => void stopStream()}
          onRegenerate={() => void regenerate()}
          thinking={thinking}
          search={search}
          onToggleThinking={() => setThinking((v) => !v)}
          onToggleSearch={() => setSearch((v) => !v)}
          onRename={(title) => {
            if (!activeConv) return
            void api
              .updateConversation(activeConv.id, { title })
              .then((updated) => {
                setConversations((prev) => prev.map((c) => (c.id === updated.id ? updated : c)))
                setActiveConv((prev) => (prev ? { ...prev, title } : prev))
              })
              .catch(() => toast('重命名失败'))
          }}
          onMove={() => activeConv && setMoveConv(activeConv)}
          onPin={() => activeConv && void pinConversation(activeConv)}
          onDelete={() => activeConv && deleteConversation(activeConv)}
          onOpenDrawer={() => setDrawer(true)}
          sidebarCollapsed={sidebarCollapsed}
          onToggleSidebar={() => setSidebarCollapsed((value) => !value)}
          onSync={openSync}
          onSyncConversation={() => void syncConversation()}
          syncingConversation={convSyncing}
          memoryRefs={memoryRefs}
          onOpenMemory={openMemoryForProject}
          attachments={draftAttachments}
          onAddFiles={addFiles}
          onRemoveAttachment={removeAttachment}
          pendingProject={projects.find((project) => project.id === pendingProjectId) || null}
        />
      </div>

      <CommandPalette
        open={palette}
        onClose={() => setPalette(false)}
        conversations={conversations}
        projects={projects}
        onSelect={(id) => void openConversation(id)}
        onNewChat={() => void newChat()}
        onSync={() => {
          setPalette(false)
          openSync()
        }}
      />

      <PromptDialog
        open={Boolean(promptDialog)}
        title={promptDialog?.title || ''}
        description={promptDialog?.description}
        initialValue={promptDialog?.initialValue}
        confirmLabel={promptDialog?.confirmLabel}
        onClose={() => setPromptDialog(null)}
        onSubmit={(value) => promptDialog?.onSubmit(value)}
      />

      <ConfirmDialog
        open={Boolean(confirmDialog)}
        title={confirmDialog?.title || ''}
        description={confirmDialog?.description}
        confirmLabel={confirmDialog?.confirmLabel}
        onClose={() => setConfirmDialog(null)}
        onConfirm={() => confirmDialog?.onConfirm()}
      />

      <ProjectDialog
        open={Boolean(projectDialog)}
        project={projectDialog?.project || null}
        projects={projects}
        initialParentId={projectDialog?.parentId || null}
        onClose={() => setProjectDialog(null)}
        onSubmit={(value) => void saveProject(value)}
      />

      <ProjectMemoryDialog
        open={Boolean(memoryProject)}
        project={memoryProject}
        onClose={() => setMemoryProject(null)}
        onSaved={saveProjectMemory}
      />

      <MoveDialog
        open={Boolean(moveConv)}
        conversation={moveConv}
        projects={projects}
        onClose={() => setMoveConv(null)}
        onMove={(projectId) => moveConv && void moveConversation(moveConv, projectId)}
      />

      <SyncDialog open={syncOpen} onClose={() => setSyncOpen(false)} onImported={handleSynced} />

      <SettingsPage
        open={settingsOpen}
        appearance={appearance}
        onChange={setAppearance}
        onClose={() => setSettingsOpen(false)}
        onCheckUpdates={() => void accountAction('checkUpdates')}
        onDownloadUpdate={() => {
          void desktop?.downloadUpdate?.().then((state) => state && setUpdateState(state))
        }}
        onInstallUpdate={() => void desktop?.installUpdate?.()}
        onOpenDataFolder={() => void accountAction('dataFolder')}
        updateState={updateState}
      />

      <Toaster toasts={toasts} />
    </>
  )
}
