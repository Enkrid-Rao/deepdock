export type Project = {
  id: string
  name: string
  color: string
  createdAt: number
  parentId: string | null
  memoryEnabled: boolean
  includeSubprojects: boolean
  memoryChars: number
  memoryUpdatedAt: number | null
}

export type ProjectMemory = {
  projectId: string
  enabled: boolean
  includeSubprojects: boolean
  content: string
  chars: number
  exists: boolean
  file: string
  updatedAt: number | null
}

export type ConversationMeta = {
  id: string
  title: string
  projectId: string | null
  pinned: boolean
  createdAt: number
  updatedAt: number
  messageCount: number
  preview: string
  dsSessionId: string | null
  parentMessageId: string | null
}

export type Role = 'user' | 'assistant'

export type MemoryRef = {
  projectId: string
  name: string
  chars: number
  file?: string
}

export type Message = {
  id: string
  role: Role
  content: string
  reasoning?: string
  createdAt: number
  streaming?: boolean
  error?: string | null
  aborted?: boolean
  thinking?: boolean
  search?: boolean
  imported?: boolean
  memoryRefs?: MemoryRef[]
  dsMessageId?: string | null
}

export type Conversation = ConversationMeta & { messages: Message[] }

export type User = {
  id: string | null
  email: string | null
  mobile: string | null
  name: string | null
}

export type Bootstrap = {
  connected: boolean
  user: User | null
  projects: Project[]
  conversations: ConversationMeta[]
  mock: boolean
  savedAt?: number | null
  credentialSource?: string | null
}

export type RemoteSession = {
  id: string
  title: string
  updatedAt: number
  pinned: boolean
  imported: boolean
  conversationId: string | null
}

export type SyncCursor = { pinned: boolean; updatedAt: number }

export type SyncSessions = {
  sessions: RemoteSession[]
  hasMore: boolean
  nextCursor: SyncCursor | null
}

export type SyncImportRow = {
  id: string
  status: 'imported' | 'exists' | 'empty' | 'failed'
  conversationId?: string
  title?: string
  messages?: number
  message?: string
}

export type SyncImportResult = {
  results: SyncImportRow[]
  imported: number
  skipped: number
  failed: number
  conversations: ConversationMeta[]
}

export type SyncRefreshResult = {
  added: number
  conversation: ConversationMeta
}

export const PROJECT_COLORS: { key: string; value: string; label: string }[] = [
  { key: 'sage', value: '#6f8f7d', label: '苔绿' },
  { key: 'sea', value: '#4f7f92', label: '海蓝' },
  { key: 'clay', value: '#b07a58', label: '陶土' },
  { key: 'plum', value: '#8a6b86', label: '梅紫' },
  { key: 'sand', value: '#a68d55', label: '沙金' },
  { key: 'slate', value: '#6c7280', label: '石墨' },
]

export function projectColor(key: string | undefined): string {
  return PROJECT_COLORS.find((c) => c.key === key)?.value || PROJECT_COLORS[0].value
}
