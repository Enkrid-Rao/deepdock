// Tiny JSON store. Everything is plain files on disk so the data stays
// readable, greppable and easy to back up.
//
//   data/index.json            projects + conversation metadata
//   data/conversations/<id>.json   full message history

import fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

const EMPTY_INDEX = { version: 1, projects: [], conversations: [] }

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
    this.indexFile = path.join(dir, 'index.json')
    this.index = structuredClone(EMPTY_INDEX)
    this.queue = Promise.resolve()
    this.cache = new Map()
  }

  async init() {
    await fs.mkdir(this.convDir, { recursive: true })
    this.index = await readJson(this.indexFile, structuredClone(EMPTY_INDEX))
    this.index.projects ||= []
    this.index.conversations ||= []
    return this
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

  async createProject({ name, color }) {
    const project = {
      id: randomUUID(),
      name: (name || '未命名项目').trim(),
      color: color || 'sage',
      createdAt: Date.now(),
    }
    this.index.projects.push(project)
    await this.saveIndex()
    return project
  }

  async updateProject(id, patch) {
    const project = this.index.projects.find((p) => p.id === id)
    if (!project) return null
    if (typeof patch.name === 'string' && patch.name.trim()) project.name = patch.name.trim()
    if (typeof patch.color === 'string') project.color = patch.color
    await this.saveIndex()
    return project
  }

  async deleteProject(id) {
    const before = this.index.projects.length
    this.index.projects = this.index.projects.filter((p) => p.id !== id)
    if (this.index.projects.length === before) return false
    for (const conv of this.index.conversations) {
      if (conv.projectId === id) conv.projectId = null
    }
    await this.saveIndex()
    return true
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
    this.cache.set(id, data)
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

function previewOf(messages) {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const text = (messages[i].content || '').replace(/\s+/g, ' ').trim()
    if (text) return text.slice(0, 120)
  }
  return ''
}
