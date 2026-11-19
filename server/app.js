// The DeepDock HTTP layer, as a reusable factory.
// `server/index.js` runs it standalone; the desktop shell embeds it in-process.

import express from 'express'
import fs from 'node:fs'
import path from 'node:path'

import { Store } from './lib/store.js'
import { Credentials, normalizeCookie, normalizeToken } from './lib/credentials.js'
import { DeepSeek, DeepSeekError, readCompletionStream } from './lib/deepseek.js'
import { convertRemoteHistory, convertSessionPage } from './lib/remote-history.js'
import { buildProjectMemoryPrompt } from './lib/project-memory.js'
import { collectReferences } from './lib/references.js'
import * as pow from './lib/pow.js'

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next)

export async function createDeepDockServer({ dataDir, distDir = null, mock = false } = {}) {
  if (!dataDir) throw new Error('createDeepDockServer: dataDir is required')

  const store = await new Store(dataDir).init()
  const credentials = await new Credentials(dataDir).init()
  const deepseek = new DeepSeek(credentials)

  await pow.loadWasm().catch((err) => {
    console.error('[deepdock] PoW module failed to load:', err.message)
  })

  const app = express()
  app.disable('x-powered-by')
  app.use(express.json({ limit: '4mb' }))

  // --------------------------------------------------------------- helpers

  function publicUser(user) {
    if (!user) return null
    return {
      id: user.id || null,
      email: user.email || null,
      mobile: user.mobile_number || user.mobile || null,
      name: user.name || user.nickname || null,
    }
  }

  function sortedConversations() {
    return [...store.listConversations()].sort((a, b) => {
      if (Boolean(a.pinned) !== Boolean(b.pinned)) return a.pinned ? -1 : 1
      return (b.updatedAt || 0) - (a.updatedAt || 0)
    })
  }

  function titleFrom(text) {
    const clean = String(text || '')
      .replace(/```[\s\S]*?```/g, ' ')
      .replace(/[#>*_`]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
    return clean.slice(0, 60) || '新对话'
  }

  function friendlyError(err) {
    if (err?.code === 'NOT_CONNECTED') return '请先连接 DeepSeek 账号。'
    if (err?.code === 40003 || err?.code === 'unauthorized') return '登录已失效，请重新粘贴 userToken。'
    if (err?.message) return err.message
    return '生成失败，请稍后重试。'
  }

  // ---------------------------------------------------------------- status

  app.get(
    '/api/bootstrap',
    wrap(async (req, res) => {
      await store.refreshMemoryMeta()
      res.json({
        connected: credentials.connected,
        user: publicUser(credentials.user),
        projects: store.listProjects(),
        conversations: sortedConversations(),
        mock,
        savedAt: credentials.value.savedAt || null,
        credentialSource: credentials.value.source || null,
      })
    }),
  )

  app.get('/api/health', (req, res) =>
    res.json({ ok: true, mock, connected: credentials.connected }),
  )

  // --------------------------------------------------------------- account

  app.post(
    '/api/connect',
    wrap(async (req, res) => {
      const cookie = normalizeCookie(req.body?.cookie)
      const token = normalizeToken(req.body?.token)

      if (!token) {
        return res.status(400).json({
          error: 'NEED_TOKEN',
          message:
            'DeepSeek 的接口只认 localStorage 里的 userToken（Cookie 单独无法通过鉴权）。请在浏览器控制台执行 localStorage.getItem("userToken") 并粘贴到这里。',
        })
      }

      if (mock) {
        await credentials.save({ token: 'mock-token', cookie, user: { id: 'mock', name: '本地预览' } })
        return res.json({ connected: true, user: publicUser(credentials.user) })
      }

      try {
        const data = await deepseek.currentUser({ token, cookie })
        const user = data?.user || data
        await credentials.save({ token, cookie, user, source: null })
        return res.json({ connected: true, user: publicUser(user) })
      } catch (err) {
        const status = err.code === 'network' ? 502 : 401
        return res.status(status).json({
          error: 'INVALID_TOKEN',
          message:
            err.code === 'network'
              ? '连接 DeepSeek 失败，请检查网络后重试。'
              : '这个 userToken 无效或已过期，请在已登录的浏览器里重新复制一份。',
          detail: err.message,
        })
      }
    }),
  )

  /**
   * Auto-connect: the desktop shell reads userToken candidates out of the local
   * Chromium profiles, and this endpoint validates them in order. Only the
   * first live token is stored; the browser-side token never travels further.
   */
  app.post(
    '/api/connect/auto',
    wrap(async (req, res) => {
      const input = Array.isArray(req.body?.candidates) ? req.body.candidates : []
      const seen = new Set()
      const candidates = []
      for (const item of input.slice(0, 12)) {
        const token = normalizeToken(item?.token)
        if (!token || seen.has(token)) continue
        seen.add(token)
        candidates.push({ token, source: String(item?.source || '').slice(0, 120) })
      }

      if (!candidates.length) {
        return res.status(400).json({ error: 'NO_CANDIDATES', message: '没有可用的登录凭证。' })
      }

      if (mock) {
        await credentials.save({
          token: 'mock-token',
          user: { id: 'mock', name: '本地预览' },
          source: candidates[0].source || null,
        })
        return res.json({
          connected: true,
          user: publicUser(credentials.user),
          source: candidates[0].source || null,
          tried: 1,
        })
      }

      const tried = []
      for (const item of candidates) {
        try {
          const data = await deepseek.currentUser({ token: item.token })
          const user = data?.user || data
          await credentials.save({ token: item.token, user, source: item.source || null })
          return res.json({
            connected: true,
            user: publicUser(user),
            source: item.source || null,
            tried: tried.length + 1,
          })
        } catch (err) {
          if (err.code === 'network') {
            return res.status(502).json({
              error: 'NETWORK',
              message: '读取到了浏览器里的凭证，但连接 DeepSeek 失败，请检查网络后重试。',
              tried,
            })
          }
          tried.push(item.source || null)
        }
      }

      return res.status(401).json({
        error: 'INVALID_TOKEN',
        message:
          '在浏览器里找到了登录记录，但都已经失效。请先在浏览器打开 chat.deepseek.com 确认仍是登录状态（刷新一次页面），再重试。',
        tried,
      })
    }),
  )

  app.get(
    '/api/account',
    wrap(async (req, res) => {
      if (!credentials.connected) return res.status(401).json({ error: 'NOT_CONNECTED' })
      if (mock) return res.json({ user: publicUser(credentials.user) })
      try {
        const data = await deepseek.currentUser()
        const user = data?.user || data
        await credentials.save({ user })
        res.json({ user: publicUser(user) })
      } catch (err) {
        if (err.code === 40003 || err.code === 'unauthorized') {
          return res
            .status(401)
            .json({ error: 'SESSION_EXPIRED', message: '登录已失效，请重新连接账号。' })
        }
        res.status(502).json({ error: 'UPSTREAM', message: err.message })
      }
    }),
  )

  app.post('/api/disconnect', async (req, res) => {
    await credentials.clear()
    res.json({ connected: false })
  })

  // -------------------------------------------------------------- projects

  app.post(
    '/api/projects',
    wrap(async (req, res) => {
      try {
        const project = await store.createProject({
          name: req.body?.name,
          color: req.body?.color,
          parentId: req.body?.parentId || null,
        })
        res.json(project)
      } catch (err) {
        if (err.code === 'INVALID_PARENT') {
          return res.status(400).json({ error: 'INVALID_PARENT', message: err.message })
        }
        throw err
      }
    }),
  )

  app.patch(
    '/api/projects/:id',
    wrap(async (req, res) => {
      try {
        const project = await store.updateProject(req.params.id, req.body || {})
        if (!project) return res.status(404).json({ error: 'NOT_FOUND' })
        res.json(project)
      } catch (err) {
        if (err.code === 'INVALID_PARENT') {
          return res.status(400).json({ error: 'INVALID_PARENT', message: err.message })
        }
        throw err
      }
    }),
  )

  app.delete(
    '/api/projects/:id',
    wrap(async (req, res) => {
      const ok = await store.deleteProject(req.params.id)
      if (!ok) return res.status(404).json({ error: 'NOT_FOUND' })
      res.json({ ok: true, projects: store.listProjects(), conversations: sortedConversations() })
    }),
  )

  app.get(
    '/api/projects/:id/memory',
    wrap(async (req, res) => {
      const project = store.getProject(req.params.id)
      if (!project) return res.status(404).json({ error: 'NOT_FOUND' })
      const memory = await store.readProjectMemory(project.id)
      if (
        project.memoryEnabled &&
        (memory.chars !== project.memoryChars ||
          (memory.updatedAt || null) !== project.memoryUpdatedAt)
      ) {
        project.memoryChars = memory.chars
        project.memoryUpdatedAt = memory.updatedAt || null
        await store.saveIndex()
      }
      res.json({
        projectId: project.id,
        enabled: project.memoryEnabled,
        includeSubprojects: project.includeSubprojects,
        content: memory.content,
        chars: memory.chars,
        exists: memory.exists,
        file: `project-memory/${project.id}.md`,
        updatedAt: project.memoryUpdatedAt,
      })
    }),
  )

  app.put(
    '/api/projects/:id/memory',
    wrap(async (req, res) => {
      const body = req.body || {}
      const result = await store.saveProjectMemory(req.params.id, {
        content: typeof body.content === 'string' ? body.content : '',
        enabled: Boolean(body.enabled),
        includeSubprojects: Boolean(body.includeSubprojects),
      })
      if (!result) return res.status(404).json({ error: 'NOT_FOUND' })
      res.json({ project: result.project, memory: result.memory })
    }),
  )

  // --------------------------------------------------------- conversations

  app.get('/api/conversations', (req, res) => {
    res.json(sortedConversations())
  })

  app.post(
    '/api/conversations',
    wrap(async (req, res) => {
      const conv = await store.createConversation({
        projectId: req.body?.projectId || null,
        title: req.body?.title || '新对话',
      })
      res.json(conv)
    }),
  )

  app.get(
    '/api/conversations/:id',
    wrap(async (req, res) => {
      const meta = store.getMeta(req.params.id)
      if (!meta) return res.status(404).json({ error: 'NOT_FOUND' })
      const conv = await store.getConversation(req.params.id)
      res.json({ ...meta, messages: conv.messages })
    }),
  )

  // Older imports / streams did not store citation links. Fetch them once from
  // the web history for messages that still only have [reference:N] text.
  app.get(
    '/api/conversations/:id/citations',
    wrap(async (req, res) => {
      const meta = store.getMeta(req.params.id)
      if (!meta) return res.status(404).json({ error: 'NOT_FOUND' })
      const conv = await store.getConversation(req.params.id)
      const targets = conv.messages.filter(
        (message) =>
          message.role === 'assistant' &&
          /\[reference:\d+\]/.test(message.content || '') &&
          (!Array.isArray(message.references) || !message.references.length) &&
          message.dsMessageId,
      )
      if (!targets.length || !meta.dsSessionId || mock || !credentials.connected) {
        return res.json({ references: {} })
      }
      try {
        const history = await deepseek.historyMessages(meta.dsSessionId)
        const root = history?.data ?? history
        const raw = Array.isArray(root?.chat_messages) ? root.chat_messages : []
        const byDsId = new Map()
        for (const message of raw) {
          byDsId.set(String(message?.message_id ?? ''), collectReferences(message?.fragments))
        }
        const references = {}
        for (const message of targets) {
          const list = byDsId.get(String(message.dsMessageId))
          if (!Array.isArray(list) || !list.length) continue
          await store.updateMessage(meta.id, message.id, { references: list })
          references[message.id] = list
        }
        res.json({ references })
      } catch {
        res.json({ references: {} })
      }
    }),
  )

  app.patch(
    '/api/conversations/:id',
    wrap(async (req, res) => {
      const meta = await store.updateConversation(req.params.id, req.body || {})
      if (!meta) return res.status(404).json({ error: 'NOT_FOUND' })
      res.json(meta)
    }),
  )

  app.delete(
    '/api/conversations/:id',
    wrap(async (req, res) => {
      const ok = await store.deleteConversation(req.params.id)
      if (!ok) return res.status(404).json({ error: 'NOT_FOUND' })
      res.json({ ok: true })
    }),
  )

  // ----------------------------------------------------------- attachments

  const ATTACHMENTS_DIR = path.join(dataDir, 'attachments')
  await fs.promises.mkdir(ATTACHMENTS_DIR, { recursive: true })

  const MAX_ATTACHMENT_BYTES = 100 * 1024 * 1024
  const MAX_ATTACHMENTS = 50
  const UPLOAD_READY_TIMEOUT = 90_000
  const FILES_ORIGIN = 'https://files.deepseeksvc.com'
  const uploadedAttachments = new Map()

  function sanitizeFileName(input) {
    const base = path.basename(String(input || 'file')).replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
    const trimmed = base.trim().slice(0, 160)
    return trimmed || 'file'
  }

  function fileParseError(file) {
    const status = String(file?.status || '').toUpperCase()
    if (file?.audit_result === 'reject') return '这个文件没有通过内容审核。'
    if (status === 'CONTENT_EMPTY') return '文件里没有可读取的内容，换一个试试。'
    if (status === 'CONTENT_TOO_LONG') return '文件太长了，超出了模型的上下文。'
    if (status === 'FAILED' || status === 'CANCELLED') return '文件解析失败，换一个试试。'
    return '文件处理失败，换一个试试。'
  }

  function sizeOrNull(value) {
    if (value === null || value === undefined || value === '') return null
    return Number.isFinite(Number(value)) ? Number(value) : null
  }

  function attachmentFromFile(info, fallback = {}) {
    const name = String(info?.file_name || fallback.name || '附件')
    const size = Number(info?.file_size) || Number(fallback.size) || 0
    return {
      id: String(info.id),
      name,
      size,
      isImage: Boolean(info.is_image),
      width: sizeOrNull(info.width),
      height: sizeOrNull(info.height),
      remotePath: info.signed_path || null,
      audit: info.audit_result || null,
    }
  }

  /** Block until DeepSeek finishes parsing the uploaded file. */
  async function waitForAttachment(id) {
    const started = Date.now()
    while (Date.now() - started < UPLOAD_READY_TIMEOUT) {
      const data = await deepseek.fileInfo([id]).catch(() => null)
      const file = data?.files?.find((item) => String(item.id) === String(id))
      if (file) {
        const status = String(file.status || '').toUpperCase()
        if (status === 'SUCCESS') return file
        if (status && !['PENDING', 'PARSING', 'WIP', ''].includes(status)) {
          throw new DeepSeekError(fileParseError(file), { code: 'FILE_PARSE_FAILED', status })
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 800))
    }
    throw new DeepSeekError('文件解析超时，请稍后再试。', { code: 'FILE_TIMEOUT' })
  }

  app.post(
    '/api/attachments',
    express.raw({ type: () => true, limit: MAX_ATTACHMENT_BYTES }),
    wrap(async (req, res) => {
      if (!credentials.connected && !mock) {
        return res.status(401).json({ error: 'NOT_CONNECTED', message: '请先连接 DeepSeek 账号。' })
      }
      const data = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0)
      if (!data.length) return res.status(400).json({ error: 'EMPTY', message: '文件是空的。' })

      let name = 'file'
      try {
        name = sanitizeFileName(decodeURIComponent(String(req.get('x-file-name') || 'file')))
      } catch {
        name = sanitizeFileName(req.get('x-file-name'))
      }
      const mime = String(req.get('x-file-type') || 'application/octet-stream')
      const thinking = req.get('x-thinking') === '1'

      try {
        let info
        if (mock) {
          info = {
            id: `mock-file-${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 8)}`,
            file_name: name,
            file_size: data.length,
            status: 'SUCCESS',
            is_image: mime.startsWith('image/'),
            width: null,
            height: null,
            audit_result: 'pass',
          }
          await new Promise((resolve) => setTimeout(resolve, 350))
        } else {
          info = await uploadRemoteFile({ data, name, mime, thinking })
        }

        const ext = path.extname(name).slice(1).toLowerCase().replace(/[^a-z0-9]/g, '') || 'bin'
        const localFile = `${info.id}.${ext}`
        await fs.promises.writeFile(path.join(ATTACHMENTS_DIR, localFile), data)

        const attachment = { ...attachmentFromFile(info, { name, size: data.length }), localFile }
        uploadedAttachments.set(attachment.id, attachment)
        res.json(attachment)
      } catch (err) {
        if (err.code === 40003 || err.code === 'unauthorized' || err.code === 40002) {
          return res.status(401).json({ error: 'SESSION_EXPIRED', message: '登录已失效，请重新连接账号。' })
        }
        res.status(502).json({ error: 'UPLOAD_FAILED', message: err.message || '上传失败，请稍后再试。' })
      }
    }),
  )

  async function uploadRemoteFile({ data, name, mime, thinking }) {
    const info = await deepseek.uploadFile({ data, filename: name, mime, thinking })
    if (String(info?.status || '').toUpperCase() === 'SUCCESS') return info
    return waitForAttachment(info.id)
  }

  /** Proxy an image that only exists on the web account's file CDN. */
  app.get(
    '/api/attachments/remote',
    wrap(async (req, res) => {
      const signed = String(req.query.path || '')
      if (!signed.startsWith('/file?') || signed.includes('://') || signed.length > 4000) {
        return res.status(400).end()
      }
      try {
        const upstream = await fetch(`${FILES_ORIGIN}/api${signed}&ty=p`, {
          headers: {
            'user-agent':
              'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
            referer: 'https://chat.deepseek.com/',
          },
        })
        if (!upstream.ok || !upstream.body) return res.status(502).end()
        res.setHeader('content-type', upstream.headers.get('content-type') || 'application/octet-stream')
        res.setHeader('cache-control', 'private, max-age=86400')
        res.end(Buffer.from(await upstream.arrayBuffer()))
      } catch {
        res.status(502).end()
      }
    }),
  )

  app.get(
    '/api/attachments/:file',
    wrap(async (req, res) => {
      const name = path.basename(String(req.params.file))
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) return res.status(400).end()
      const full = path.join(ATTACHMENTS_DIR, name)
      if (!full.startsWith(`${ATTACHMENTS_DIR}${path.sep}`)) return res.status(400).end()
      try {
        await fs.promises.access(full)
      } catch {
        return res.status(404).end()
      }
      res.sendFile(full)
    }),
  )

  // ----------------------------------------------------------------- chat

  const activeStreams = new Map()

  app.post(
    '/api/conversations/:id/stop',
    wrap(async (req, res) => {
      const controller = activeStreams.get(req.params.id)
      if (controller) controller.abort()
      res.json({ ok: true })
    }),
  )

  app.post(
    '/api/conversations/:id/chat',
    wrap(async (req, res) => {
      const convId = req.params.id
      const meta = store.getMeta(convId)
      if (!meta) return res.status(404).json({ error: 'NOT_FOUND' })
      if (activeStreams.has(convId)) {
        return res.status(409).json({ error: 'BUSY', message: '这个对话还在生成中。' })
      }

      const body = req.body || {}
      const thinking = Boolean(body.thinking)
      const search = Boolean(body.search)
      const regenerate = Boolean(body.regenerate)

      let prompt = String(body.content || '').trim()
      let userMessage = null
      let parentOverride = null
      let memory = null

      // Attachments arrive as ids of files uploaded through /api/attachments.
      const requestedIds = Array.isArray(body.attachments)
        ? [...new Set(body.attachments.map((id) => String(id || '')).filter(Boolean))]
        : []
      if (requestedIds.length > MAX_ATTACHMENTS) {
        return res.status(400).json({ error: 'TOO_MANY_FILES', message: `一次最多带 ${MAX_ATTACHMENTS} 个文件。` })
      }
      let attachments = requestedIds.map((id) => uploadedAttachments.get(id)).filter(Boolean)
      if (attachments.length !== requestedIds.length) {
        return res.status(400).json({
          error: 'ATTACHMENT_EXPIRED',
          message: '有附件已经失效，请重新添加一次。',
        })
      }

      const existing = await store.getConversation(convId)

      if (regenerate) {
        // Drop the trailing assistant reply and replay the last user prompt.
        while (
          existing.messages.length &&
          existing.messages[existing.messages.length - 1].role === 'assistant'
        ) {
          const last = existing.messages[existing.messages.length - 1]
          await store.removeMessage(convId, last.id)
        }
        const lastUser = [...existing.messages].reverse().find((m) => m.role === 'user')
        if (!lastUser) return res.status(400).json({ error: 'NOTHING_TO_REGENERATE' })
        prompt = lastUser.content
        userMessage = lastUser
        // Re-use the files that the user message was originally sent with.
        attachments = Array.isArray(lastUser.attachments) ? lastUser.attachments : []
        // The new reply must hang off the message *before* the one we removed.
        const previousAssistant = [...existing.messages].reverse().find((m) => m.role === 'assistant')
        parentOverride = previousAssistant?.dsMessageId || null
      } else {
        if (!prompt && !attachments.length) return res.status(400).json({ error: 'EMPTY_PROMPT' })
        // Project memory is a first-message prompt prefix, never part of the
        // typed content. The UI only renders a reference chip.
        if (!existing.messages.length) {
          try {
            memory = await buildProjectMemoryPrompt(store, meta.projectId)
          } catch (err) {
            console.warn('[deepdock] project memory unavailable:', err.message)
          }
        }
        userMessage = await store.addMessage(convId, {
          role: 'user',
          content: prompt,
          ...(attachments.length ? { attachments } : {}),
          ...(memory?.refs?.length ? { memoryRefs: memory.refs } : {}),
        })
        if (meta.messageCount <= 1 && (!meta.title || meta.title === '新对话')) {
          await store.updateConversation(convId, {
            title: titleFrom(prompt || attachments[0]?.name || ''),
          })
        }
        if (!meta.parentMessageId) {
          const previousAssistant = [...existing.messages].reverse().find((m) => m.role === 'assistant')
          parentOverride = previousAssistant?.dsMessageId || null
        }
      }

      const refFileIds = attachments.map((item) => item.id).filter(Boolean)
      const upstreamPrompt = memory ? `${memory.text}${prompt}` : prompt || '请看附件'

      const assistant = await store.addMessage(convId, {
        role: 'assistant',
        content: '',
        reasoning: '',
        streaming: true,
        thinking,
      })

      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      })
      if (res.flushHeaders) res.flushHeaders()

      const send = (event, data) => {
        if (res.writableEnded) return
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
      }

      const heartbeat = setInterval(() => {
        if (!res.writableEnded) res.write(': ping\n\n')
      }, 15000)

      const controller = new AbortController()
      activeStreams.set(convId, controller)

      const cleanup = () => {
        clearInterval(heartbeat)
        activeStreams.delete(convId)
      }

      res.on('close', () => {
        if (!res.writableEnded) controller.abort()
      })

      send('start', { userMessage, assistantId: assistant.id })

      let content = ''
      let reasoning = ''
      let references = []
      let upstreamMessageId = null
      let finished = false

      try {
        if (mock) {
          upstreamMessageId = `mock-${assistant.id}`
          await mockStream({ send, thinking, prompt, signal: controller.signal })
          content = mockContent(prompt)
          reasoning = thinking ? mockReasoning() : ''
          references = mockReferences()
          finished = true
        } else {
          if (!credentials.connected) {
            throw new DeepSeekError('还没有连接 DeepSeek 账号', { code: 'NOT_CONNECTED' })
          }

          if (!meta.dsSessionId) {
            const sessionId = await deepseek.createSession()
            await store.updateConversation(convId, { dsSessionId: sessionId })
            meta.dsSessionId = sessionId
          }

          const response = await deepseek.completion({
            sessionId: meta.dsSessionId,
            parentMessageId: parentOverride ?? meta.parentMessageId,
            prompt: upstreamPrompt,
            thinking,
            search,
            refFileIds,
            signal: controller.signal,
          })

          for await (const evt of readCompletionStream(response, controller.signal)) {
            if (evt.type === 'content') {
              content += evt.delta
              send('delta', { delta: evt.delta })
            } else if (evt.type === 'reasoning') {
              reasoning += evt.delta
              send('reasoning', { delta: evt.delta })
            } else if (evt.type === 'meta') {
              upstreamMessageId = evt.messageId
            } else if (evt.type === 'finish') {
              finished = true
            } else if (evt.type === 'final') {
              // Authoritative text read from the patched fragments; the streamed
              // deltas might have been rewritten upstream along the way.
              if (typeof evt.content === 'string') content = evt.content
              if (typeof evt.reasoning === 'string') reasoning = evt.reasoning
              if (Array.isArray(evt.references)) references = evt.references
            } else if (evt.type === 'error') {
              throw new DeepSeekError(evt.message, { code: 'UPSTREAM' })
            }
          }
          finished = true
        }
      } catch (err) {
        const aborted = controller.signal.aborted || err.name === 'AbortError'
        // Aborted before the upstream "meta" event? Look up the assistant
        // message id in history so 「继续生成」 can still work.
        if (!upstreamMessageId && !mock && meta.dsSessionId) {
          try {
            const history = await deepseek.historyMessages(meta.dsSessionId)
            const root = history?.data ?? history
            const raw = Array.isArray(root?.chat_messages) ? root.chat_messages : []
            const last = [...raw]
              .reverse()
              .find((item) => String(item?.role || '').toUpperCase() !== 'USER')
            if (last?.message_id != null) upstreamMessageId = String(last.message_id)
          } catch {
            /* ignore */
          }
        }
        await store.updateMessage(convId, assistant.id, {
          content,
          reasoning,
          ...(references.length ? { references } : {}),
          ...(upstreamMessageId ? { dsMessageId: upstreamMessageId } : {}),
          streaming: false,
          aborted,
          error: aborted ? null : err.message || '生成失败',
        })
        cleanup()
        if (!aborted) {
          send('error', {
            message: friendlyError(err),
            code: err.code || null,
            dsMessageId: upstreamMessageId || null,
          })
        } else {
          send('aborted', { dsMessageId: upstreamMessageId || null })
        }
        if (!res.writableEnded) res.end()
        return
      }

      await store.updateMessage(convId, assistant.id, {
        content,
        reasoning,
        ...(references.length ? { references } : {}),
        streaming: false,
        error: finished ? null : '连接中断',
        ...(upstreamMessageId ? { dsMessageId: upstreamMessageId } : {}),
      })
      if (upstreamMessageId) {
        await store.updateConversation(convId, { parentMessageId: upstreamMessageId })
      } else {
        await store.touchConversation(convId)
      }

      cleanup()
      if (references.length) send('references', { references })
      send('done', {
        assistantId: assistant.id,
        conversation: store.getMeta(convId),
        content,
        reasoning,
        references,
        dsMessageId: upstreamMessageId || null,
      })
      if (!res.writableEnded) res.end()
    }),
  )

  // Continue an interrupted / incomplete assistant message (the web's
  // 「继续生成」 button). The upstream message id is the assistant's dsMessageId.
  app.post(
    '/api/conversations/:id/continue',
    wrap(async (req, res) => {
      const convId = req.params.id
      const meta = store.getMeta(convId)
      if (!meta) return res.status(404).json({ error: 'NOT_FOUND' })
      if (activeStreams.has(convId)) {
        return res.status(409).json({ error: 'BUSY', message: '这个对话还在生成中。' })
      }

      const conv = await store.getConversation(convId)
      const messageId = String(req.body?.messageId || '')
      const message = conv.messages.find(
        (item) => item.id === messageId && item.role === 'assistant',
      )
      if (!message) return res.status(404).json({ error: 'NOT_FOUND' })
      if (!mock && (!message.dsMessageId || !meta.dsSessionId || !credentials.connected)) {
        return res.status(400).json({
          error: 'NOT_CONTINUABLE',
          message: '这条回复没有可继续的消息 id，请重新生成。',
        })
      }

      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      })
      if (res.flushHeaders) res.flushHeaders()

      const send = (event, data) => {
        if (res.writableEnded) return
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
      }

      const controller = new AbortController()
      activeStreams.set(convId, controller)
      const cleanup = () => activeStreams.delete(convId)
      res.on('close', () => {
        if (!res.writableEnded) controller.abort()
      })

      const providedContent = typeof req.body?.content === 'string' ? req.body.content : ''
      const providedReasoning = typeof req.body?.reasoning === 'string' ? req.body.reasoning : ''
      const storedContent = String(message.content || '')
      const storedReasoning = String(message.reasoning || '')
      // Keep the partial text the client already rendered when the server had
      // not persisted it yet (e.g. abort during the first delta).
      const originalContent =
        providedContent.length > storedContent.length && providedContent.startsWith(storedContent)
          ? providedContent
          : storedContent
      const originalReasoning =
        providedReasoning.length > storedReasoning.length &&
        providedReasoning.startsWith(storedReasoning)
          ? providedReasoning
          : storedReasoning
      let content = originalContent
      let reasoning = originalReasoning
      let references = Array.isArray(message.references) ? [...message.references] : []
      let finalContent = null
      let finalReasoning = null

      send('start', { messageId })

      try {
        if (mock) {
          const suffix = '（继续生成：这是演示模式下接上的内容。）'
          for (const chunk of suffix.match(/.{1,4}/gs) || []) {
            content += chunk
            send('delta', { delta: chunk })
            await new Promise((resolve) => setTimeout(resolve, 45))
          }
        } else {
          const upstream = await deepseek.continueCompletion({
            sessionId: meta.dsSessionId,
            messageId: message.dsMessageId,
            fallbackToResume: true,
            signal: controller.signal,
          })
          for await (const evt of readCompletionStream(upstream, controller.signal)) {
            if (evt.type === 'content') {
              content += evt.delta
              send('delta', { delta: evt.delta })
            } else if (evt.type === 'reasoning') {
              reasoning += evt.delta
              send('reasoning', { delta: evt.delta })
            } else if (evt.type === 'references') {
              if (Array.isArray(evt.references) && evt.references.length) {
                references = evt.references
                send('references', { references })
              }
            } else if (evt.type === 'final') {
              if (typeof evt.content === 'string') finalContent = evt.content
              if (typeof evt.reasoning === 'string') finalReasoning = evt.reasoning
              if (Array.isArray(evt.references) && evt.references.length) {
                references = evt.references
              }
            } else if (evt.type === 'error') {
              throw new DeepSeekError(evt.message, { code: 'UPSTREAM' })
            }
          }

          // The continue stream only carries the appended part; history is the
          // authoritative full message (and also covers the resume fallback).
          const history = await deepseek
            .historyMessages(meta.dsSessionId)
            .catch(() => null)
          const root = history?.data ?? history
          const raw = Array.isArray(root?.chat_messages) ? root.chat_messages : []
          const remote = raw.find(
            (item) => String(item?.message_id) === String(message.dsMessageId),
          )
          if (remote) {
            const fragments = Array.isArray(remote.fragments) ? remote.fragments : []
            const readFragments = (types) =>
              fragments
                .filter(
                  (fragment) =>
                    fragment &&
                    types.includes(String(fragment.type || '').toUpperCase()) &&
                    typeof fragment.content === 'string',
                )
                .map((fragment) => fragment.content)
                .join('')
            const remoteContent = readFragments(['RESPONSE', 'TEXT', 'ANSWER']).trim()
            const remoteReasoning = readFragments(['THINK', 'REASON', 'REASONING']).trim()
            if (remoteContent) content = remoteContent
            if (remoteReasoning) reasoning = remoteReasoning
            const remoteRefs = collectReferences(fragments)
            if (remoteRefs.length) references = remoteRefs
          } else {
            // Streamed deltas were already appended; if the upstream sent the
            // whole message again, replace instead of duplicating.
            if (finalContent) {
              if (finalContent.startsWith(originalContent)) content = finalContent
              else if (!content.endsWith(finalContent)) content += finalContent
            }
            if (finalReasoning) {
              if (finalReasoning.startsWith(originalReasoning)) reasoning = finalReasoning
              else if (!reasoning.endsWith(finalReasoning)) reasoning += finalReasoning
            }
          }
        }

        await store.updateMessage(convId, messageId, {
          content,
          reasoning,
          ...(references.length ? { references } : {}),
          streaming: false,
          aborted: false,
          error: null,
        })
        if (references.length) send('references', { references })
        send('done', { messageId, content, reasoning, references })
      } catch (err) {
        const aborted = controller.signal.aborted || err.name === 'AbortError'
        await store.updateMessage(convId, messageId, {
          content,
          reasoning,
          ...(references.length ? { references } : {}),
          streaming: false,
          aborted,
          error: aborted ? null : err.message || '继续生成失败',
        })
        if (aborted) send('aborted', {})
        else send('error', { message: friendlyError(err), code: err.code || null })
      } finally {
        cleanup()
        if (!res.writableEnded) res.end()
      }
    }),
  )

  // ------------------------------------------------------------ web sync

  const REMOTE_SYNC_LIMIT = 50

  async function fetchRemoteSessions({ limit = 40, cursor = null } = {}) {
    const sessions = []
    let nextCursor = cursor
    let hasMore = true
    while (sessions.length < limit && hasMore) {
      const page = convertSessionPage(
        await deepseek.listSessions({
          count: Math.min(50, limit - sessions.length),
          cursor: nextCursor,
        }),
      )
      sessions.push(...page.sessions)
      hasMore = page.hasMore && page.sessions.length > 0
      const last = page.sessions[page.sessions.length - 1]
      nextCursor = last ? { pinned: last.pinned, updatedAt: last.updatedAtRaw } : null
      if (!last) break
      // Guard against the server returning the same page twice.
      if (page.sessions.length < 50 && !page.hasMore) break
    }
    return { sessions: sessions.slice(0, limit), hasMore, nextCursor }
  }

  function localImportMap() {
    const map = new Map()
    for (const conv of store.listConversations()) {
      if (conv.dsSessionId) map.set(conv.dsSessionId, conv)
    }
    return map
  }

  app.get(
    '/api/sync/sessions',
    wrap(async (req, res) => {
      if (!credentials.connected) {
        return res.status(401).json({ error: 'NOT_CONNECTED', message: '请先连接 DeepSeek 账号。' })
      }
      const limit = Math.min(Math.max(Number(req.query.limit) || 40, 1), REMOTE_SYNC_LIMIT)
      const cursorUpdatedAt = Number(req.query.cursorUpdatedAt)
      const cursor =
        req.query.cursorUpdatedAt !== undefined && Number.isFinite(cursorUpdatedAt)
          ? {
              pinned: req.query.cursorPinned === '1' || req.query.cursorPinned === 'true',
              updatedAt: cursorUpdatedAt,
            }
          : null

      if (mock) {
        const data = mockRemoteSessions()
        const local = localImportMap()
        return res.json({
          ...data,
          sessions: data.sessions.map((session) => {
            const conv = local.get(session.id)
            return { ...session, imported: Boolean(conv), conversationId: conv?.id || null }
          }),
        })
      }

      try {
        const { sessions, hasMore, nextCursor } = await fetchRemoteSessions({ limit, cursor })
        const local = localImportMap()
        res.json({
          sessions: sessions.map((session) => {
            const conv = local.get(session.id)
            return {
              id: session.id,
              title: session.title,
              updatedAt: session.updatedAt,
              pinned: session.pinned,
              imported: Boolean(conv),
              conversationId: conv?.id || null,
            }
          }),
          hasMore,
          nextCursor,
        })
      } catch (err) {
        if (err.code === 40003 || err.code === 'unauthorized' || err.code === 40002) {
          return res.status(401).json({ error: 'SESSION_EXPIRED', message: '登录已失效，请重新连接账号。' })
        }
        res.status(502).json({ error: 'UPSTREAM', message: friendlyError(err) })
      }
    }),
  )

  app.post(
    '/api/sync/import',
    wrap(async (req, res) => {
      if (!credentials.connected) {
        return res.status(401).json({ error: 'NOT_CONNECTED', message: '请先连接 DeepSeek 账号。' })
      }
      const ids = [...new Set((Array.isArray(req.body?.ids) ? req.body.ids : []).map(String))]
        .filter(Boolean)
        .slice(0, 40)
      if (!ids.length) {
        return res.status(400).json({ error: 'EMPTY', message: '没有选择要导入的对话。' })
      }

      const results = []
      for (const id of ids) {
        const existing = store.findByDsSessionId(id)
        if (existing) {
          results.push({ id, status: 'exists', conversationId: existing.id, title: existing.title })
          continue
        }
        try {
          const history = mock ? mockRemoteHistory(id) : await deepseek.historyMessages(id)
          const converted = convertRemoteHistory(history)
          if (!converted.messages.length) {
            results.push({ id, status: 'empty' })
            continue
          }
          const { meta } = await store.importConversation({ dsSessionId: id, ...converted })
          results.push({
            id,
            status: 'imported',
            conversationId: meta.id,
            title: meta.title,
            messages: meta.messageCount,
          })
        } catch (err) {
          if (err.code === 40003 || err.code === 'unauthorized' || err.code === 40002) {
            return res
              .status(401)
              .json({ error: 'SESSION_EXPIRED', message: '登录已失效，请重新连接账号。' })
          }
          results.push({ id, status: 'failed', message: friendlyError(err) })
        }
      }

      res.json({
        results,
        imported: results.filter((item) => item.status === 'imported').length,
        skipped: results.filter((item) => item.status === 'exists').length,
        failed: results.filter((item) => item.status === 'failed').length,
        conversations: sortedConversations(),
      })
    }),
  )

  // Background friendly: import the newest few web sessions that are not in
  // the local store yet. Capped so it never floods the sidebar in one go.
  app.post(
    '/api/sync/auto',
    wrap(async (req, res) => {
      if (!credentials.connected) {
        return res.status(401).json({ error: 'NOT_CONNECTED', message: '请先连接 DeepSeek 账号。' })
      }
      try {
        const sessions = mock
          ? mockRemoteSessions().sessions
          : (await fetchRemoteSessions({ limit: 20 })).sessions
        const pending = sessions
          .filter((session) => !store.findByDsSessionId(session.id))
          .slice(0, 5)
        const imported = []
        for (const session of pending) {
          try {
            const history = mock ? mockRemoteHistory(session.id) : await deepseek.historyMessages(session.id)
            const converted = convertRemoteHistory(history, {
              title: session.title,
              pinned: session.pinned,
              updatedAt: session.updatedAt,
            })
            if (!converted.messages.length) continue
            const { meta } = await store.importConversation({ dsSessionId: session.id, ...converted })
            imported.push({
              id: session.id,
              conversationId: meta.id,
              title: meta.title,
              messages: meta.messageCount,
            })
          } catch (err) {
            if (err.code === 40003 || err.code === 'unauthorized' || err.code === 40002) {
              return res
                .status(401)
                .json({ error: 'SESSION_EXPIRED', message: '登录已失效，请重新连接账号。' })
            }
          }
        }
        res.json({
          checked: sessions.length,
          imported: imported.length,
          conversations: imported,
          all: sortedConversations(),
        })
      } catch (err) {
        res.status(502).json({ error: 'UPSTREAM', message: friendlyError(err) })
      }
    }),
  )

  app.post(
    '/api/sync/refresh',
    wrap(async (req, res) => {
      if (!credentials.connected) {
        return res.status(401).json({ error: 'NOT_CONNECTED', message: '请先连接 DeepSeek 账号。' })
      }
      const conversationId = String(req.body?.conversationId || '')
      const meta = store.getMeta(conversationId)
      if (!meta) return res.status(404).json({ error: 'NOT_FOUND' })
      if (!meta.dsSessionId) {
        return res.status(400).json({
          error: 'NO_REMOTE_SESSION',
          message: '这段对话还没有在网页端建立会话，先发一条消息再同步。',
        })
      }

      try {
        const history = mock
          ? mockRemoteHistory(meta.dsSessionId, { followup: true })
          : await deepseek.historyMessages(meta.dsSessionId)
        const converted = convertRemoteHistory(history)
        const local = await store.getConversation(conversationId)
        const existing = new Set(local.messages.map((message) => message.dsMessageId).filter(Boolean))

        // Find the newest message both sides agree on, then append everything
        // that came after it on the web. This keeps local-only messages intact.
        let anchor = -1
        for (let i = converted.messages.length - 1; i >= 0; i -= 1) {
          const id = converted.messages[i].dsMessageId
          if (id && existing.has(id)) {
            anchor = i
            break
          }
        }
        if (anchor < 0 && local.messages.length) {
          return res.status(409).json({
            error: 'DIVERGED',
            message: '本地对话和网页端对不上，无法自动合并。',
          })
        }

        const appended = await store.appendMessages(conversationId, converted.messages.slice(anchor + 1))
        if (appended.length && converted.parentMessageId) {
          await store.updateConversation(conversationId, { parentMessageId: converted.parentMessageId })
        }
        res.json({ added: appended.length, conversation: store.getMeta(conversationId) })
      } catch (err) {
        if (err.code === 40003 || err.code === 'unauthorized' || err.code === 40002) {
          return res.status(401).json({ error: 'SESSION_EXPIRED', message: '登录已失效，请重新连接账号。' })
        }
        res.status(502).json({ error: 'UPSTREAM', message: friendlyError(err) })
      }
    }),
  )

  // ------------------------------------------------------------- overview

  app.get(
    '/api/overview',
    wrap(async (req, res) => {
      const conversations = store.listConversations()
      const messages = conversations.reduce((sum, c) => sum + (c.messageCount || 0), 0)
      let bytes = 0
      try {
        const dir = path.join(dataDir, 'conversations')
        for (const file of await fs.promises.readdir(dir)) {
          bytes += (await fs.promises.stat(path.join(dir, file))).size
        }
      } catch {
        /* ignore */
      }
      res.json({
        dataDir,
        conversations: conversations.length,
        projects: store.listProjects().length,
        messages,
        bytes,
      })
    }),
  )

  // --------------------------------------------------------------- static

  if (distDir && fs.existsSync(distDir)) {
    app.use(
      express.static(distDir, {
        index: false,
        setHeaders(res, filePath) {
          if (filePath.includes(`${path.sep}assets${path.sep}`)) {
            res.setHeader('cache-control', 'public, max-age=31536000, immutable')
          }
        },
      }),
    )
    app.get('*', (req, res, next) => {
      if (req.path.startsWith('/api/')) return next()
      res.sendFile(path.join(distDir, 'index.html'))
    })
  } else {
    app.get('*', (req, res, next) => {
      if (req.path.startsWith('/api/')) return next()
      res.type('html').send(`<!doctype html><meta charset="utf-8">
        <body style="font:15px/1.7 system-ui;background:#f5f2ea;color:#14130e;padding:12vh 8vw">
        <h1 style="font-size:22px;margin:0 0 8px">DeepDock 还没有构建前端</h1>
        <p style="color:#6d695e">在项目目录里执行：</p>
        <pre style="background:#fffdf8;border:1px solid #e2dccd;border-radius:10px;padding:12px 16px">npm run build
npm start</pre>
        <p style="color:#6d695e">API 已经在运行：<a href="/api/health">/api/health</a></p>
        </body>`)
    })
  }

  app.use((req, res) => {
    if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'NOT_FOUND' })
    res.status(404).send('Not found')
  })

  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err)
    if (err?.type === 'entity.too.large') {
      return res.status(413).json({ error: 'TOO_LARGE', message: '文件太大了（上限 100 MB）。' })
    }
    console.error('[deepdock]', err)
    res.status(500).json({ error: 'INTERNAL', message: err.message })
  })

  return { app, store, credentials, deepseek, closeStreams: () => activeStreams.forEach((c) => c.abort()) }
}

// ------------------------------------------------------------- mock mode

const MOCK_REMOTE = [
  { id: 'web-demo-1', title: '把网页端的对话搬进 DeepDock', minutesAgo: 16, pinned: true },
  { id: 'web-demo-2', title: '中心极限定理条件', minutesAgo: 140, pinned: false },
  { id: 'web-demo-3', title: '复刻 DeepSeek 网页端 App', minutesAgo: 1530, pinned: false },
  { id: 'web-demo-4', title: '德比含义详解', minutesAgo: 2880, pinned: false },
  { id: 'web-demo-5', title: '化简逻辑函数第二问', minutesAgo: 4320, pinned: false },
]

function mockRemoteSessions() {
  const now = Date.now()
  return {
    sessions: MOCK_REMOTE.map((item) => ({
      id: item.id,
      title: item.title,
      updatedAt: now - item.minutesAgo * 60_000,
      pinned: item.pinned,
      imported: false,
      conversationId: null,
    })),
    hasMore: false,
    nextCursor: null,
  }
}

function mockRemoteHistory(id, { followup = false } = {}) {
  const item = MOCK_REMOTE.find((entry) => entry.id === id) || {
    id,
    title: '网页端对话',
    minutesAgo: 30,
  }
  const endedAt = (Date.now() - item.minutesAgo * 60_000) / 1000
  const messages = [
    {
      message_id: '101',
      role: 'USER',
      inserted_at: endedAt - 60,
      thinking_enabled: true,
      fragments: [
        {
          type: 'REQUEST',
          content: '导入网页端的对话之后，我还能在 DeepDock 里接着问吗？',
        },
      ],
    },
    {
      message_id: '102',
      role: 'ASSISTANT',
      inserted_at: endedAt - 59,
      thinking_enabled: true,
      fragments: [
        {
          type: 'THINK',
          content:
            '用户关心导入后的连续性问题。导入时保存 chat_session_id 和最后一条 assistant 的 message_id，下一次发送就能挂到同一条会话链上。',
        },
        {
          type: 'RESPONSE',
          content:
            '可以。导入时会一并保存网页端的 `chat_session_id` 和最后一条回复的 `message_id`，所以下一次提问会继续挂在同一个网页会话后面。\n\n反过来说，在 DeepDock 里新开的对话也会出现在网页端的历史里。',
        },
      ],
    },
  ]

  if (followup) {
    messages.push(
      {
        message_id: '103',
        role: 'USER',
        inserted_at: endedAt - 40,
        thinking_enabled: false,
        fragments: [{ type: 'REQUEST', content: '那我在网页端补了一句话，这边能同步过来吗？' }],
      },
      {
        message_id: '104',
        role: 'ASSISTANT',
        inserted_at: endedAt - 39,
        thinking_enabled: false,
        fragments: [
          {
            type: 'RESPONSE',
            content:
              '可以。顶栏的对话菜单里有「从网页同步这段对话」，它会以双方都认识的消息为锚点，把网页端多出来的回复补到本地。',
          },
        ],
      },
    )
  }

  return {
    chat_session: { id, title: item.title, pinned: item.pinned, updated_at: endedAt },
    chat_messages: messages,
  }
}

function mockReasoning() {
  return '用户想要一个演示回复。先确认一下 dock 的布局，再给出一段简洁的中文示例，保持语气自然。'
}

function mockReferences() {
  return [
    {
      index: 0,
      id: 1,
      type: 'TOOL_OPEN',
      url: 'https://api-docs.deepseek.com/zh-cn/',
      title: 'DeepSeek API 文档',
      site: 'DeepSeek',
      snippet: '',
    },
    {
      index: 1,
      id: 2,
      type: 'TOOL_OPEN',
      url: 'https://www.deepseek.com/',
      title: 'DeepSeek',
      site: 'DeepSeek',
      snippet: '',
    },
    {
      index: 2,
      id: 3,
      type: 'TOOL_OPEN',
      url: 'https://github.com/Enkrid-Rao/deepdock',
      title: 'Enkrid-Rao/deepdock',
      site: 'GitHub',
      snippet: '',
    },
  ]
}

function mockContent(prompt) {
  // Echo the first line only: slicing raw input mid-formula makes the demo
  // reply look broken, and the quote is just there to prove the round-trip.
  const firstLine = String(prompt).trim().split('\n')[0].trim()
  const quoted = firstLine.slice(0, 60)
  return `这是 **DeepDock** 的本地演示回复（没有连接真实账号）。

你刚才说：「${quoted}${firstLine.length > 60 ? '…' : ''}」

连接真实账号之后，这里会显示 DeepSeek 的原文流式输出，支持 Markdown：

- 列表、\`行内代码\`、表格
- 代码块高亮
- 数学公式：\\(E = mc^2\\)、\\(\\nabla \\cdot \\mathbf{E} = \\frac{\\rho}{\\varepsilon_0}\\)

\\[
\\int_0^1 x^2 \\, dx = \\frac{1}{3}
\\]

联网搜索的引用会显示成可点的小角标[reference:0][reference:1]，写成代码时保持原样：\`[reference:3]\`

\`\`\`ts
// 一个很小的例子
export function dock(name: string) {
  return \`hello, \${name}\`
}
\`\`\`
`
}

async function mockStream({ send, thinking, prompt, signal }) {
  const abort = () => {
    const err = new Error('aborted')
    err.name = 'AbortError'
    return err
  }
  const reasoning = thinking ? mockReasoning() : ''
  for (const ch of chunk(reasoning, 6)) {
    if (signal?.aborted) throw abort()
    send('reasoning', { delta: ch })
    await sleep(18)
  }
  for (const ch of chunk(mockContent(prompt), 4)) {
    if (signal?.aborted) throw abort()
    send('delta', { delta: ch })
    await sleep(16)
  }
}

function chunk(text, size) {
  const out = []
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size))
  return out
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
