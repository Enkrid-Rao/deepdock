// Tiny JSON store. Everything is plain files on disk so the data stays
// readable, greppable and easy to back up.
//
//   data/index.json            projects + conversation metadata
//   data/conversations/<id>.json   full message history

import fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

const EMPTY_INDEX = { version: 1, projects: [], conversations: [] }
const MAX_PROJECT_DEPTH = 8

function invalidParent(message = 'INVALID_PARENT') {
  const err = new Error(message)
  err.code = 'INVALID_PARENT'
  return err
}

async function readJson(file, fallback) {
  try {
    const raw = await fs.readFile(file, 'utf8')
    return JSON.parse(raw)
  } catch (err) {
    if (err.code === 'ENOENT') return fallback
    if (err instanceof SyntaxError) {
      console.warn(`[store] ${file} is corrupt, starting from a clean slate`)
      return fallback
    }
    throw err
  }
}

async function writeJsonAtomic(file, value) {
  const tmp = `${file}.${process.pid}.tmp`
  await fs.writeFile(tmp, JSON.stringify(value, null, 2), 'utf8')
  await fs.rename(tmp, file)
}

export class Store {
  constructor(dir) {
    this.dir = dir
    this.convDir = path.join(dir, 'conversations')
    this.memoryDir = path.join(dir, 'project-memory')
    this.indexFile = path.join(dir, 'index.json')
    this.index = structuredClone(EMPTY_INDEX)
    this.queue = Promise.resolve()
    this.cache = new Map()
  }

  async init() {
    await fs.mkdir(this.convDir, { recursive: true })
    await fs.mkdir(this.memoryDir, { recursive: true })
    this.index = await readJson(this.indexFile, structuredClone(EMPTY_INDEX))
    this.index.projects ||= []
    this.index.conversations ||= []
    this.normalizeProjects()
    return this
  }

  /** Migrate old indexes and make sure the project tree has no cycles. */
  normalizeProjects() {
    const byId = new Map(this.index.projects.map((project) => [project.id, project]))
    for (const project of this.index.projects) {
      if (project.parentId && !byId.has(project.parentId)) project.parentId = null
      project.parentId ||= null
      project.memoryEnabled = Boolean(project.memoryEnabled)
      project.includeSubprojects = Boolean(project.includeSubprojects)
      project.memoryChars = Number(project.memoryChars) || 0
      project.memoryUpdatedAt = Number(project.memoryUpdatedAt) || null
    }
    for (const project of this.index.projects) {
      const seen = new Set([project.id])
      let current = project.parentId ? byId.get(project.parentId) : null
      while (current) {
        if (seen.has(current.id)) {
          project.parentId = null
          break
        }
        seen.add(current.id)
        current = current.parentId ? byId.get(current.parentId) : null
      }
    }
  }

  /** Serialise all writes so concurrent requests can never interleave. */
  write(fn) {
    const next = this.queue.then(fn, fn)
    this.queue = next.catch(() => {})
    return next
  }

  saveIndex() {
    return this.write(() => writeJsonAtomic(this.indexFile, this.index))
  }

  convFile(id) {
    return path.join(this.convDir, `${id}.json`)
  }

  // ---------------------------------------------------------------- projects

  listProjects() {
    return this.index.projects
  }

  getProject(id) {
    return this.index.projects.find((project) => project.id === id) || null
  }

  projectDepth(id) {
    let depth = 0
    let current = this.getProject(id)
    let guard = 0
    while (current?.parentId && guard < MAX_PROJECT_DEPTH + 2) {
      depth += 1
      current = this.getProject(current.parentId)
      guard += 1
    }
    return depth
  }

  assertValidParent(id, parentId) {
    if (!parentId) return
    if (parentId === id) throw invalidParent('A project cannot be its own parent')
    if (!this.getProject(parentId)) throw invalidParent('Parent project does not exist')
    if (this.projectDepth(parentId) + 1 > MAX_PROJECT_DEPTH) {
      throw invalidParent(`Project nesting is limited to ${MAX_PROJECT_DEPTH} levels`)
    }
    let current = this.getProject(parentId)
    let guard = 0
    while (current && guard < MAX_PROJECT_DEPTH + 2) {
      if (current.id === id) throw invalidParent('A project cannot be moved into its own child')
      current = current.parentId ? this.getProject(current.parentId) : null
      guard += 1
    }
  }

  async createProject({ name, color, parentId = null }) {
    const parent = parentId ? this.getProject(parentId) : null
    this.assertValidParent(null, parent ? parent.id : null)
    const project = {
      id: randomUUID(),
      name: (name || '未命名项目').trim(),
      color: color || 'sage',
      createdAt: Date.now(),
      parentId: parent ? parent.id : null,
      memoryEnabled: false,
      includeSubprojects: false,
      memoryChars: 0,
      memoryUpdatedAt: null,
    }
    this.index.projects.push(project)
    await this.saveIndex()
    return project
  }

  async updateProject(id, patch) {
    const project = this.getProject(id)
    if (!project) return null
    if (typeof patch.name === 'string' && patch.name.trim()) project.name = patch.name.trim()
    if (typeof patch.color === 'string') project.color = patch.color
    if ('parentId' in patch) {
      const parentId = patch.parentId ? String(patch.parentId) : null
      this.assertValidParent(id, parentId)
      project.parentId = parentId
    }
    if (typeof patch.includeSubprojects === 'boolean') {
      project.includeSubprojects = patch.includeSubprojects
    }
    await this.saveIndex()
    return project
  }

  async deleteProject(id) {
    const project = this.getProject(id)
    if (!project) return false
    this.index.projects = this.index.projects.filter((p) => p.id !== id)
    // Children are promoted one level instead of being deleted with the parent.
    for (const child of this.index.projects) {
      if (child.parentId === id) child.parentId = project.parentId || null
    }
    for (const conv of this.index.conversations) {
      if (conv.projectId === id) conv.projectId = null
    }
    await fs.rm(this.memoryFile(id), { force: true }).catch(() => {})
    await this.saveIndex()
    return true
  }

  // ---------------------------------------------------------- project memory

  memoryFile(id) {
    return path.join(this.memoryDir, `${id}.md`)
  }

  async readProjectMemory(id) {
    const file = this.memoryFile(id)
    try {
      const [content, stat] = await Promise.all([fs.readFile(file, 'utf8'), fs.stat(file)])
      return { exists: true, content, chars: content.length, file, updatedAt: stat.mtimeMs }
    } catch (err) {
      if (err.code === 'ENOENT') {
        return { exists: false, content: '', chars: 0, file, updatedAt: null }
      }
      throw err
    }
  }

  async saveProjectMemory(id, { content = '', enabled = false, includeSubprojects = false } = {}) {
    const project = this.getProject(id)
    if (!project) return null
    const text = String(content ?? '')
    const file = this.memoryFile(id)
    await fs.mkdir(this.memoryDir, { recursive: true })
    if (text.length) await fs.writeFile(file, text, 'utf8')
    else await fs.rm(file, { force: true })
    project.memoryEnabled = Boolean(enabled)
    project.includeSubprojects = Boolean(includeSubprojects)
    project.memoryChars = text.length
    project.memoryUpdatedAt = Date.now()
    await this.saveIndex()
    return {
      project,
      memory: {
        projectId: id,
        content: text,
        chars: text.length,
        enabled: project.memoryEnabled,
        includeSubprojects: project.includeSubprojects,
        file: `project-memory/${id}.md`,
        updatedAt: project.memoryUpdatedAt,
      },
    }
  }

  async deleteProjectMemory(id) {
    const project = this.getProject(id)
    if (!project) return null
    await fs.rm(this.memoryFile(id), { force: true }).catch(() => {})
    project.memoryEnabled = false
    project.memoryChars = 0
    project.memoryUpdatedAt = Date.now()
    await this.saveIndex()
    return project
  }

  /**
   * The memory files that apply to a conversation in `projectId`, ordered from
   * the root project down to the conversation's own project.
   *
   * - the conversation's own project always applies;
   * - an ancestor applies only when its `includeSubprojects` is on.
   */
  async resolveProjectMemory(projectId) {
    if (!projectId) return []
    let current = this.getProject(projectId)
    if (!current) return []
    const chain = []
    let isSelf = true
    let guard = 0
    let metaChanged = false

    while (current && guard < MAX_PROJECT_DEPTH + 2) {
      if (current.memoryEnabled && (isSelf || current.includeSubprojects)) {
        const memory = await this.readProjectMemory(current.id)
        if (memory.chars !== current.memoryChars) {
          current.memoryChars = memory.chars
          metaChanged = true
        }
        if (memory.chars) {
          chain.push({
            project: current,
            content: memory.content,
            chars: memory.chars,
            file: `project-memory/${current.id}.md`,
          })
        }
      }
      current = current.parentId ? this.getProject(current.parentId) : null
      isSelf = false
      guard += 1
    }

    if (metaChanged) await this.saveIndex()
    return chain.reverse()
  }

  /** Pick up memory files edited outside the app. */
  async refreshMemoryMeta() {
    let changed = false
    for (const project of this.index.projects) {
      if (!project.memoryEnabled) {
        if (project.memoryChars) {
          project.memoryChars = 0
          changed = true
        }
        continue
      }
      const memory = await this.readProjectMemory(project.id)
      if (memory.chars !== project.memoryChars) {
        project.memoryChars = memory.chars
        changed = true
      }
      if (memory.updatedAt && memory.updatedAt !== project.memoryUpdatedAt) {
        project.memoryUpdatedAt = memory.updatedAt
        changed = true
      }
    }
    if (changed) await this.saveIndex()
  }

  // ----------------------------------------------------------- conversations

  listConversations() {
    return this.index.conversations
  }

  getMeta(id) {
    return this.index.conversations.find((c) => c.id === id) || null
  }

  findByDsSessionId(dsSessionId) {
    if (!dsSessionId) return null
    return this.index.conversations.find((c) => c.dsSessionId === dsSessionId) || null
  }

  /** Import a conversation that was created on the DeepSeek website. */
  async importConversation({
    dsSessionId,
    title = '新对话',
    pinned = false,
    createdAt,
    updatedAt,
    parentMessageId = null,
    messages = [],
  }) {
    if (!dsSessionId) throw new Error('importConversation: dsSessionId is required')
    const existing = this.findByDsSessionId(dsSessionId)
    if (existing) return { created: false, meta: existing }

    const now = Date.now()
    const meta = {
      id: randomUUID(),
      title: String(title || '新对话').slice(0, 200),
      projectId: null,
      dsSessionId,
      parentMessageId: parentMessageId || null,
      pinned: Boolean(pinned),
      createdAt: Number(createdAt) || now,
      updatedAt: Number(updatedAt) || now,
      messageCount: messages.length,
      preview: previewOf(messages),
      source: 'web-import',
    }
    const stored = messages.map((message) => ({
      id: randomUUID(),
      createdAt: Number(message.createdAt) || now,
      role: message.role === 'user' ? 'user' : 'assistant',
      content: String(message.content || ''),
      ...(Array.isArray(message.attachments) && message.attachments.length
        ? { attachments: message.attachments }
        : {}),
      ...(message.reasoning ? { reasoning: String(message.reasoning) } : {}),
      ...(message.dsMessageId ? { dsMessageId: String(message.dsMessageId) } : {}),
      ...(message.thinking ? { thinking: true } : {}),
      ...(message.search ? { search: true } : {}),
      imported: true,
    }))

    this.index.conversations.unshift(meta)
    this.cache.set(meta.id, { id: meta.id, messages: stored })
    await this.saveIndex()
    await this.saveConversation(meta.id)
    return { created: true, meta }
  }

  async createConversation({ projectId = null, title = '新对话' } = {}) {
    const now = Date.now()
    const meta = {
      id: randomUUID(),
      title,
      projectId,
      dsSessionId: null,
      parentMessageId: null,
      pinned: false,
      createdAt: now,
      updatedAt: now,
      messageCount: 0,
      preview: '',
    }
    this.index.conversations.unshift(meta)
    this.cache.set(meta.id, { id: meta.id, messages: [] })
    await this.saveIndex()
    await this.saveConversation(meta.id)
    return meta
  }

  async getConversation(id) {
    if (this.cache.has(id)) return this.cache.get(id)
    const data = await readJson(this.convFile(id), { id, messages: [] })
    data.messages ||= []
    let repaired = false
    for (const message of data.messages) {
      if (stripThinkingLeak(message)) repaired = true
    }
    this.cache.set(id, data)
    if (repaired) await this.saveConversation(id)
    return data
  }

  async saveConversation(id) {
    const data = this.cache.get(id)
    if (!data) return
    await this.write(() => writeJsonAtomic(this.convFile(id), data))
  }

  async updateConversation(id, patch) {
    const meta = this.getMeta(id)
    if (!meta) return null
    if (typeof patch.title === 'string') meta.title = patch.title.slice(0, 200)
    if ('projectId' in patch) meta.projectId = patch.projectId || null
    if ('pinned' in patch) meta.pinned = Boolean(patch.pinned)
    if ('dsSessionId' in patch) meta.dsSessionId = patch.dsSessionId || null
    if ('parentMessageId' in patch) meta.parentMessageId = patch.parentMessageId || null
    meta.updatedAt = Date.now()
    await this.saveIndex()
    return meta
  }

  async touchConversation(id) {
    const meta = this.getMeta(id)
    if (!meta) return
    meta.updatedAt = Date.now()
    await this.saveIndex()
  }

  async deleteConversation(id) {
    const idx = this.index.conversations.findIndex((c) => c.id === id)
    if (idx === -1) return false
    this.index.conversations.splice(idx, 1)
    this.cache.delete(id)
    await this.saveIndex()
    await fs.rm(this.convFile(id), { force: true })
    return true
  }

  // ---------------------------------------------------------------- messages

  async addMessage(convId, message) {
    const conv = await this.getConversation(convId)
    const msg = {
      id: randomUUID(),
      createdAt: Date.now(),
      ...message,
    }
    conv.messages.push(msg)
    const meta = this.getMeta(convId)
    if (meta) {
      meta.messageCount = conv.messages.length
      meta.preview = previewOf(conv.messages)
      meta.updatedAt = msg.createdAt
    }
    await this.saveConversation(convId)
    await this.saveIndex()
    return msg
  }

  async updateMessage(convId, messageId, patch) {
    const conv = await this.getConversation(convId)
    const msg = conv.messages.find((m) => m.id === messageId)
    if (!msg) return null
    Object.assign(msg, patch)
    const meta = this.getMeta(convId)
    if (meta) {
      meta.preview = previewOf(conv.messages)
      meta.updatedAt = Date.now()
    }
    await this.saveConversation(convId)
    await this.saveIndex()
    return msg
  }

  async removeMessage(convId, messageId) {
    const conv = await this.getConversation(convId)
    const before = conv.messages.length
    conv.messages = conv.messages.filter((m) => m.id !== messageId)
    if (conv.messages.length === before) return false
    const meta = this.getMeta(convId)
    if (meta) {
      meta.messageCount = conv.messages.length
      meta.preview = previewOf(conv.messages)
      meta.updatedAt = Date.now()
    }
    await this.saveConversation(convId)
    await this.saveIndex()
    return true
  }

  /**
   * Append messages pulled from the web session. Messages that already exist
   * locally (matched by their upstream `dsMessageId`) are skipped.
   */
  async appendMessages(convId, messages = []) {
    const conv = await this.getConversation(convId)
    const seen = new Set(conv.messages.map((m) => m.dsMessageId).filter(Boolean))
    const appended = []
    for (const message of messages) {
      if (message.dsMessageId && seen.has(message.dsMessageId)) continue
      const stored = {
        id: randomUUID(),
        createdAt: Number(message.createdAt) || Date.now(),
        role: message.role === 'user' ? 'user' : 'assistant',
        content: String(message.content || ''),
        ...(Array.isArray(message.attachments) && message.attachments.length
          ? { attachments: message.attachments }
          : {}),
        ...(message.reasoning ? { reasoning: String(message.reasoning) } : {}),
        ...(message.dsMessageId ? { dsMessageId: String(message.dsMessageId) } : {}),
        ...(message.thinking ? { thinking: true } : {}),
        ...(message.search ? { search: true } : {}),
        imported: true,
      }
      conv.messages.push(stored)
      appended.push(stored)
      if (stored.dsMessageId) seen.add(stored.dsMessageId)
    }
    if (!appended.length) return []
    const meta = this.getMeta(convId)
    if (meta) {
      meta.messageCount = conv.messages.length
      meta.preview = previewOf(conv.messages)
      meta.updatedAt = Date.now()
    }
    await this.saveConversation(convId)
    await this.saveIndex()
    return appended
  }
}

/**
 * Older builds could replay the tail of the thinking block into the answer when
 * a fragment snapshot arrived mid-stream (and sometimes dropped a few words or
 * leaked a status token like FINISHED into it). The answer therefore starts
 * with a mangled copy of a suffix of `reasoning`; walk that copy chunk by chunk
 * and cut it off. Returns true when the message was repaired.
 */
function stripThinkingLeak(message) {
  if (!message || message.role !== 'assistant') return false
  const reasoning = String(message.reasoning || '')
  const content = String(message.content || '')
  if (reasoning.length < 200 || content.length < 120) return false

  const start = reasoning.indexOf(content.slice(0, 36))
  if (start < 0) return false
  const tail = reasoning.slice(start)
  if (tail.length < 100) return false

  const SIZE = 32
  let cursor = 0
  let matched = 0
  let misses = 0
  let reachedEnd = false

  for (let i = 0; i < tail.length; i += SIZE) {
    const chunk = tail.slice(i, i + SIZE)
    const at = content.indexOf(chunk, cursor)
    if (at < 0 || at > cursor + 48) {
      misses += 1
      if (misses > 2) break
      continue
    }
    cursor = at + chunk.length
    matched += chunk.length
    misses = 0
    if (i + SIZE >= tail.length) reachedEnd = true
  }

  if (!reachedEnd || matched < 120 || matched < tail.length * 0.6) return false

  const rest = content.slice(cursor).replace(/^\s+/, '')
  if (rest.length < 20) return false
  message.content = rest
  return true
}

function previewOf(messages) {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const text = (messages[i].content || '').replace(/\s+/g, ' ').trim()
    if (text) return text.slice(0, 120)
  }
  return ''
}
