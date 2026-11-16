import type {
  Attachment,
  Bootstrap,
  Conversation,
  ConversationMeta,
  Message,
  Project,
  ProjectMemory,
  SyncImportResult,
  SyncRefreshResult,
  SyncSessions,
  User,
} from './types'

export class ApiError extends Error {
  status: number
  payload: unknown

  constructor(message: string, status: number, payload: unknown) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.payload = payload
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: {
      ...(init?.body ? { 'content-type': 'application/json' } : {}),
      ...(init?.headers || {}),
    },
  })

  if (!res.ok) {
    let payload: any = null
    try {
      payload = await res.json()
    } catch {
      /* ignore */
    }
    throw new ApiError(payload?.message || `请求失败（${res.status}）`, res.status, payload)
  }
  if (res.status === 204) return undefined as T
  return (await res.json()) as T
}

export const api = {
  bootstrap: () => request<Bootstrap>('/api/bootstrap'),

  connect: (body: { token?: string; cookie?: string }) =>
    request<{ connected: boolean; user: User | null }>('/api/connect', {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  account: () => request<{ user: User }>('/api/account'),
  disconnect: () => request<{ connected: boolean }>('/api/disconnect', { method: 'POST' }),

  createProject: (body: { name: string; color: string; parentId?: string | null }) =>
    request<Project>('/api/projects', { method: 'POST', body: JSON.stringify(body) }),

  updateProject: (
    id: string,
    body: {
      name?: string
      color?: string
      parentId?: string | null
      includeSubprojects?: boolean
    },
  ) => request<Project>(`/api/projects/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),

  deleteProject: (id: string) =>
    request<{ ok: boolean; projects: Project[]; conversations: ConversationMeta[] }>(
      `/api/projects/${id}`,
      { method: 'DELETE' },
    ),

  getProjectMemory: (id: string) =>
    request<ProjectMemory>(`/api/projects/${id}/memory`),

  saveProjectMemory: (
    id: string,
    body: { content: string; enabled: boolean; includeSubprojects: boolean },
  ) =>
    request<{ project: Project; memory: ProjectMemory }>(`/api/projects/${id}/memory`, {
      method: 'PUT',
      body: JSON.stringify(body),
    }),

  listConversations: () => request<ConversationMeta[]>('/api/conversations'),

  createConversation: (body: { projectId?: string | null; title?: string } = {}) =>
    request<ConversationMeta>('/api/conversations', { method: 'POST', body: JSON.stringify(body) }),

  getConversation: (id: string) => request<Conversation>(`/api/conversations/${id}`),

  updateConversation: (
    id: string,
    body: { title?: string; projectId?: string | null; pinned?: boolean },
  ) => request<ConversationMeta>(`/api/conversations/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),

  deleteConversation: (id: string) =>
    request<{ ok: boolean }>(`/api/conversations/${id}`, { method: 'DELETE' }),

  stop: (id: string) =>
    request<{ ok: boolean }>(`/api/conversations/${id}/stop`, { method: 'POST' }),

  syncSessions: (params: { limit?: number; cursorPinned?: boolean; cursorUpdatedAt?: number } = {}) => {
    const query = new URLSearchParams()
    if (params.limit) query.set('limit', String(params.limit))
    if (typeof params.cursorUpdatedAt === 'number') {
      query.set('cursorPinned', params.cursorPinned ? '1' : '0')
      query.set('cursorUpdatedAt', String(params.cursorUpdatedAt))
    }
    const suffix = query.toString()
    return request<SyncSessions>(`/api/sync/sessions${suffix ? `?${suffix}` : ''}`)
  },

  syncImport: (ids: string[]) =>
    request<SyncImportResult>('/api/sync/import', {
      method: 'POST',
      body: JSON.stringify({ ids }),
    }),

  syncRefresh: (conversationId: string) =>
    request<SyncRefreshResult>('/api/sync/refresh', {
      method: 'POST',
      body: JSON.stringify({ conversationId }),
    }),

  /** Send the raw file to the local API, which uploads it to the web account. */
  uploadAttachment: async (file: File): Promise<Attachment> => {
    const res = await fetch('/api/attachments', {
      method: 'POST',
      headers: {
        'content-type': 'application/octet-stream',
        'x-file-name': encodeURIComponent(file.name || 'file'),
        'x-file-type': file.type || 'application/octet-stream',
      },
      body: file,
    })
    if (!res.ok) {
      let payload: any = null
      try {
        payload = await res.json()
      } catch {
        /* ignore */
      }
      throw new ApiError(payload?.message || `上传失败（${res.status}）`, res.status, payload)
    }
    return (await res.json()) as Attachment
  },
}

export type StreamHandlers = {
  onStart?: (data: { userMessage: Message | null; assistantId: string }) => void
  onDelta?: (text: string) => void
  onReasoning?: (text: string) => void
  onDone?: (data: {
    assistantId: string
    conversation: ConversationMeta
    content?: string
    reasoning?: string
  }) => void
  onError?: (message: string, code?: number | string | null) => void
  onAborted?: () => void
}

export async function streamChat(
  conversationId: string,
  body: {
    content?: string
    thinking: boolean
    search: boolean
    regenerate?: boolean
    attachments?: string[]
  },
  handlers: StreamHandlers,
  signal: AbortSignal,
): Promise<void> {
  let res: Response
  try {
    res = await fetch(`/api/conversations/${conversationId}/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    })
  } catch (err) {
    if (signal.aborted) handlers.onAborted?.()
    else handlers.onError?.('无法连接到本地服务，请确认 DeepDock 服务仍在运行。')
    return
  }

  if (!res.ok || !res.body) {
    let message = `生成失败（${res.status}）`
    try {
      const payload = await res.json()
      if (payload?.message) message = payload.message
    } catch {
      /* ignore */
    }
    handlers.onError?.(message)
    return
  }

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  const dispatch = (event: string, raw: string) => {
    let payload: any
    try {
      payload = JSON.parse(raw)
    } catch {
      return
    }
    switch (event) {
      case 'start':
        handlers.onStart?.(payload)
        break
      case 'delta':
        handlers.onDelta?.(payload.delta || '')
        break
      case 'reasoning':
        handlers.onReasoning?.(payload.delta || '')
        break
      case 'done':
        handlers.onDone?.(payload)
        break
      case 'error':
        handlers.onError?.(payload.message || '生成失败', payload.code ?? null)
        break
      case 'aborted':
        handlers.onAborted?.()
        break
      default:
        break
    }
  }

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let boundary = buffer.indexOf('\n\n')
      while (boundary >= 0) {
        const frame = buffer.slice(0, boundary)
        buffer = buffer.slice(boundary + 2)
        let event = 'message'
        const dataLines: string[] = []
        for (const line of frame.split('\n')) {
          if (line.startsWith('event:')) event = line.slice(6).trim()
          else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim())
        }
        if (dataLines.length) dispatch(event, dataLines.join('\n'))
        boundary = buffer.indexOf('\n\n')
      }
    }
  } catch (err) {
    if (signal.aborted) handlers.onAborted?.()
    else handlers.onError?.('连接中断了，回复可能不完整。')
  }
}
