// A very small client for chat.deepseek.com's internal API.
// Only the handful of endpoints DeepDock needs are implemented.

import * as pow from './pow.js'

const ORIGIN = 'https://chat.deepseek.com'
const BASE = `${ORIGIN}/api/v0`
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36'

export class DeepSeekError extends Error {
  constructor(message, extra = {}) {
    super(message)
    this.name = 'DeepSeekError'
    Object.assign(this, extra)
  }
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms))

export class DeepSeek {
  constructor(credentials) {
    this.credentials = credentials
  }

  headers({ token, cookie, extra } = {}) {
    const t = token ?? this.credentials.token
    const c = cookie ?? this.credentials.cookie
    const h = {
      accept: '*/*',
      'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
      'content-type': 'application/json',
      origin: 'https://chat.deepseek.com',
      referer: 'https://chat.deepseek.com/',
      'user-agent': UA,
      'x-client-platform': 'web',
      'x-client-version': '1.0.0',
      'x-client-locale': 'zh_CN',
      'x-client-timezone-offset': String(-new Date().getTimezoneOffset() * 60),
      'x-client-bundle-id': 'com.deepseek.chat',
    }
    if (c) h.cookie = c
    if (t) h.authorization = `Bearer ${t}`
    return { ...h, ...(extra || {}) }
  }

  async request(pathname, { method = 'POST', body, signal, extraHeaders, token, cookie } = {}) {
    let res
    try {
      res = await fetch(BASE + pathname, {
        method,
        headers: this.headers({ extra: extraHeaders, token, cookie }),
        body: body === undefined ? undefined : JSON.stringify(body),
        signal,
      })
    } catch (err) {
      if (err.name === 'AbortError') throw err
      throw new DeepSeekError(`无法连接 DeepSeek：${err.message}`, { code: 'network' })
    }
    const text = await res.text()
    let json = null
    try {
      json = JSON.parse(text)
    } catch {
      /* not json */
    }
    if (res.status === 401 || res.status === 403) {
      throw new DeepSeekError('登录状态已失效，请重新连接账号', {
        code: 'unauthorized',
        status: res.status,
      })
    }
    if (!json) {
      throw new DeepSeekError(`DeepSeek 返回了无法解析的响应（HTTP ${res.status}）`, {
        code: 'bad_response',
        status: res.status,
        raw: text.slice(0, 300),
      })
    }
    if (json.code !== 0) {
      const bizMsg = json.data?.biz_msg
      throw new DeepSeekError(mapCodeMessage(json.code, json.msg, bizMsg), {
        code: json.code,
        status: res.status,
        bizCode: json.data?.biz_code,
        raw: json,
      })
    }
    const data = json.data || {}
    if (data.biz_code !== 0) {
      throw new DeepSeekError(mapBizMessage(data.biz_code, data.biz_msg), {
        code: data.biz_code,
        bizCode: data.biz_code,
        raw: json,
      })
    }
    return data.biz_data
  }

  async currentUser({ token, cookie } = {}) {
    return this.request('/users/current', { method: 'GET', token, cookie })
  }

  async createSession() {
    const data = await this.request('/chat_session/create', { body: { character_id: null } })
    const id = data?.id || data?.chat_session?.id
    if (!id) throw new DeepSeekError('创建会话失败：响应里没有会话 id', { code: 'no_session' })
    return id
  }

  async createChallenge(targetPath) {
    const data = await this.request('/chat/create_pow_challenge', {
      body: { target_path: targetPath },
    })
    const challenge = data?.challenge
    if (!challenge) throw new DeepSeekError('获取 PoW 挑战失败', { code: 'no_challenge' })
    return challenge
  }

  /**
   * One page of the account's chat history, newest first.
   * `cursor` is `{ pinned, updatedAt }` from the previous page's last item.
   */
  async listSessions({ count = 30, cursor = null } = {}) {
    const query = new URLSearchParams({ count: String(count) })
    if (cursor && Number.isFinite(cursor.updatedAt)) {
      query.set('lte_cursor.pinned', cursor.pinned ? 'true' : 'false')
      query.set('lte_cursor.updated_at', String(cursor.updatedAt))
    }
    return this.request(`/chat_session/fetch_page?${query.toString()}`, { method: 'GET' })
  }

  /** Every message inside one web chat session (including thinking fragments). */
  async historyMessages(sessionId) {
    const query = new URLSearchParams({ chat_session_id: sessionId })
    return this.request(`/chat/history_messages?${query.toString()}`, { method: 'GET' })
  }

  /** Returns the base64 `x-ds-pow-response` header value. */
  async solveChallenge(targetPath = '/api/v0/chat/completion') {
    const challenge = await this.createChallenge(targetPath)
    const expireAt = challenge.expire_at ?? challenge.expireAt
    let answer = pow.solve(challenge.challenge, challenge.salt, expireAt, challenge.difficulty)
    if (answer == null) {
      // The vendored wasm may be stale — try to pull a fresh one once.
      const refreshed = await pow.refreshWasmFromRemote().catch(() => false)
      if (refreshed) {
        answer = pow.solve(challenge.challenge, challenge.salt, expireAt, challenge.difficulty)
      }
    }
    if (answer == null) throw new DeepSeekError('PoW 计算失败', { code: 'pow_failed' })
    return pow.buildPowHeader(challenge, answer, targetPath)
  }

  /** Opens the SSE stream for a completion. Returns the raw fetch Response. */
  async completion(
    { sessionId, parentMessageId, prompt, thinking = false, search = false, refFileIds = [], signal },
    { retry = true } = {},
  ) {
    const targetPath = '/api/v0/chat/completion'
    const powHeader = await this.solveChallenge(targetPath)
    const payload = {
      chat_session_id: sessionId,
      parent_message_id: parentMessageId || null,
      model_type: null,
      prompt,
      ref_file_ids: Array.isArray(refFileIds) ? refFileIds : [],
      thinking_enabled: Boolean(thinking),
      search_enabled: Boolean(search),
      action: null,
      preempt: false,
    }
    // `targetPath` already includes `/api/v0`, so this must hit the origin
    // directly — BASE + targetPath would double the prefix and get the SPA HTML.
    const res = await fetch(ORIGIN + targetPath, {
      method: 'POST',
      headers: this.headers({ extra: { 'x-ds-pow-response': powHeader } }),
      body: JSON.stringify(payload),
      signal,
    })

    const ctype = res.headers.get('content-type') || ''
    if (!ctype.includes('text/event-stream')) {
      const text = await res.text()
      console.warn(
        `[deepseek] completion rejected status=${res.status} content-type=${ctype || '(none)'}`,
      )
      let json = null
      try {
        json = JSON.parse(text)
      } catch {
        /* ignore */
      }
      const code = json?.code
      const bizCode = json?.data?.biz_code
      const powFailed = json?.data?.biz_msg?.includes?.('POW') || code === 40301
      if (retry && powFailed) {
        await wait(400)
        return this.completion(
          { sessionId, parentMessageId, prompt, thinking, search, signal },
          { retry: false },
        )
      }
      if (!json) {
        throw new DeepSeekError(
          `DeepSeek 返回了网页而不是对话流（HTTP ${res.status}），可能是接口变更或临时风控，请稍后再试。`,
          { code: 'bad_response', status: res.status, raw: text.slice(0, 300) },
        )
      }
      throw new DeepSeekError(
        mapCodeMessage(code, json?.msg, json?.data?.biz_msg) ||
          `DeepSeek 拒绝了这次请求（HTTP ${res.status}）`,
        { code: code || res.status, bizCode, raw: text.slice(0, 400) },
      )
    }
    return res
  }

  /**
   * Upload one attachment to the web account.
   *
   * The browser posts multipart/form-data to `/file/upload_file` with a PoW
   * header for that target path plus `x-thinking-enabled` / `x-file-size`
   * hints. Returns the file object (`id`, `status`, `file_name`, ...).
   */
  async uploadFile({ data, filename, mime = 'application/octet-stream', thinking = false, signal } = {}) {
    if (!data || !data.length) throw new DeepSeekError('文件是空的', { code: 'EMPTY_FILE' })
    const targetPath = '/api/v0/file/upload_file'
    const powHeader = await this.solveChallenge(targetPath)

    const form = new FormData()
    form.append('file', new Blob([data], { type: mime }), filename)
    const headers = this.headers({
      extra: {
        'x-ds-pow-response': powHeader,
        'x-thinking-enabled': thinking ? '1' : '0',
        'x-file-size': String(data.length),
      },
    })
    // fetch() sets the multipart boundary itself; the JSON header would win.
    delete headers['content-type']

    let res
    try {
      res = await fetch(ORIGIN + targetPath, { method: 'POST', headers, body: form, signal })
    } catch (err) {
      if (err.name === 'AbortError') throw err
      throw new DeepSeekError(`上传失败：${err.message}`, { code: 'network' })
    }

    const text = await res.text()
    let json = null
    try {
      json = JSON.parse(text)
    } catch {
      /* not json */
    }
    if (res.status === 401 || res.status === 403) {
      throw new DeepSeekError('登录状态已失效，请重新连接账号', {
        code: 'unauthorized',
        status: res.status,
      })
    }
    if (!json) {
      throw new DeepSeekError(`上传失败（HTTP ${res.status}）`, {
        code: 'bad_response',
        status: res.status,
        raw: text.slice(0, 300),
      })
    }
    if (json.code !== 0) {
      throw new DeepSeekError(mapCodeMessage(json.code, json.msg, json.data?.biz_msg), {
        code: json.code,
        status: res.status,
        bizCode: json.data?.biz_code,
      })
    }
    if (json.data?.biz_code !== 0) {
      throw new DeepSeekError(mapBizMessage(json.data?.biz_code, json.data?.biz_msg), {
        code: json.data?.biz_code,
        bizCode: json.data?.biz_code,
        raw: json,
      })
    }
    const info = json.data.biz_data
    if (!info?.id) throw new DeepSeekError('上传失败：响应里没有文件 id', { code: 'no_file_id' })
    return info
  }

  /** Metadata (status, signed_path, width/height, ...) for uploaded file ids. */
  async fileInfo(ids = []) {
    const clean = (Array.isArray(ids) ? ids : []).map(String).filter(Boolean)
    if (!clean.length) return { files: [] }
    const query = new URLSearchParams({ file_ids: clean.join(',') })
    return this.request(`/file/fetch_files?${query.toString()}`, { method: 'GET' })
  }
}

function mapCodeMessage(code, msg, bizMsg) {
  if (code === 40002) return '缺少 token：请重新连接账号'
  if (code === 40003) return 'token 无效或已过期：请重新连接账号'
  if (code === 40001) return '请求参数不被接受'
  if (bizMsg) return bizMsg
  return msg || `DeepSeek 错误 ${code}`
}

function mapBizMessage(bizCode, bizMsg) {
  if (bizMsg === 'INVALID_TARGET_PATH') return 'PoW 目标路径无效'
  return bizMsg || `DeepSeek 业务错误 ${bizCode}`
}

/**
 * Turn the upstream SSE byte stream into a tidy sequence of events:
 *   { type: 'meta', messageId }
 *   { type: 'reasoning', delta }
 *   { type: 'content', delta }
 *   { type: 'finish' }
 *   { type: 'final', content, reasoning }
 *
 * DeepSeek streams JSON patches shaped `{ p, o, v }` (path / operation /
 * value). Both fields are sticky: an event without `p` reuses the previous
 * path, and an event without `o` reuses the previous operation; `BATCH`
 * expands into a list of patches whose paths are prefixed with the batch path.
 *
 * Earlier versions guessed "this string is probably answer text" and appended
 * everything to the current fragment. That leaks tool fragments ("搜索到 13 个
 * 网页"), status writes ("FINISHED") and, when the current fragment is the
 * RESPONSE one, the tail of the thinking block into the answer. Applying the
 * patches to a local copy of the response object and reading only THINK /
 * RESPONSE fragments keeps the two streams apart.
 */
export async function* readCompletionStream(response, signal) {
  const decoder = new TextDecoder('utf-8')
  let buffer = ''
  const state = {
    data: {},
    sticky: { op: 'SET', path: '' },
    emitted: new Map(),
    messageId: null,
    finished: false,
  }

  for await (const chunk of response.body) {
    if (signal?.aborted) break
    buffer += decoder.decode(chunk, { stream: true })

    let nl
    let eventName = 'message'
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).replace(/\r$/, '')
      buffer = buffer.slice(nl + 1)
      if (!line) {
        eventName = 'message'
        continue
      }
      if (line.startsWith(':')) continue
      if (line.startsWith('event:')) {
        eventName = line.slice(6).trim() || 'message'
        continue
      }
      if (!line.startsWith('data:')) continue
      const payload = line.slice(5).trim()
      if (!payload || payload === '[DONE]') continue
      let evt
      try {
        evt = JSON.parse(payload)
      } catch {
        continue
      }
      yield* handleStreamEvent(evt, state, eventName)
    }
  }

  yield* flushFragments(state)
  if (state.messageId) yield { type: 'meta', messageId: state.messageId, late: true }
  if (!state.finished) yield { type: 'finish' }
  yield {
    type: 'final',
    content: collectText(state, 'content'),
    reasoning: collectText(state, 'reasoning'),
  }
}

function fragmentKind(type) {
  const kind = String(type || '').toUpperCase()
  if (kind === 'THINK' || kind === 'REASON' || kind === 'REASONING') return 'reasoning'
  if (kind === 'RESPONSE' || kind === 'TEXT' || kind === 'ANSWER') return 'content'
  return null
}

function* handleStreamEvent(evt, state, eventName) {
  if (!evt || typeof evt !== 'object') return

  // Title / lifecycle frames are not part of the response patch stream.
  if (eventName === 'title' || eventName === 'ready' || eventName === 'close') return
  if (eventName === 'update_session') return

  if (eventName === 'error' || evt.type === 'error') {
    yield { type: 'error', message: evt.content || evt.message || 'DeepSeek 返回错误' }
    return
  }

  if (!('v' in evt)) return

  for (const patch of expandDelta(evt, state.sticky)) {
    if (!patch.path) {
      if (patch.op === 'SET' && patch.value && typeof patch.value === 'object') {
        Object.assign(state.data, patch.value)
      }
    } else {
      applyPatch(state.data, patch.path, patch.op, patch.value)
    }

    const id = state.data?.response?.message_id
    if (id && id !== state.messageId) {
      state.messageId = id
      yield { type: 'meta', messageId: id }
    }

    yield* flushFragments(state)

    if (state.data?.response?.status === 'FINISHED' && !state.finished) {
      state.finished = true
      yield { type: 'finish' }
    }
  }
}

/** Expand one SSE frame into flat `{ path, op, value }` patches. */
function expandDelta(evt, sticky) {
  const op = evt.o ?? sticky.op
  const path = evt.p ?? sticky.path
  sticky.op = op
  sticky.path = path

  if (op !== 'BATCH') return [{ path, op, value: evt.v }]

  const sub = { op: 'SET', path: '' }
  const patches = []
  for (const item of Array.isArray(evt.v) ? evt.v : []) {
    for (const patch of expandDelta(item, sub)) {
      patches.push({ ...patch, path: path ? `${path}/${patch.path}` : patch.path })
    }
  }
  return patches
}

const INDEX = /^-?\d+$/

function applyPatch(root, path, op, value) {
  const segments = path.split('/').filter(Boolean)
  if (!segments.length) return

  let node = root
  for (let i = 0; i < segments.length - 1; i += 1) {
    node = stepInto(node, segments[i], INDEX.test(segments[i + 1]))
    if (node === undefined) return
  }

  const last = segments[segments.length - 1]
  if (Array.isArray(node)) {
    const index = last === '-1' ? node.length - 1 : Number(last)
    if (!Number.isInteger(index) || index < 0) return
    node[index] = op === 'APPEND' ? appendValue(node[index], value) : value
    return
  }

  if (!node || typeof node !== 'object') return
  node[last] = op === 'APPEND' ? appendValue(node[last], value) : value
}

function stepInto(node, segment, nextIsIndex) {
  const empty = nextIsIndex ? [] : {}
  if (Array.isArray(node)) {
    const index = segment === '-1' ? node.length - 1 : Number(segment)
    if (!Number.isInteger(index) || index < 0) return undefined
    if (node[index] == null) node[index] = empty
    return node[index]
  }
  if (node && typeof node === 'object') {
    if (node[segment] == null) node[segment] = empty
    return node[segment]
  }
  return undefined
}

function appendValue(current, value) {
  if (typeof current === 'string') return current + String(value ?? '')
  if (Array.isArray(current)) return Array.isArray(value) ? current.concat(value) : [...current, value]
  return current == null ? value : current
}

/** Emit the not-yet-streamed part of every THINK / RESPONSE fragment. */
function* flushFragments(state) {
  const response = state.data?.response
  if (!response) return
  const fragments = Array.isArray(response.fragments) ? response.fragments : []

  let index = 0
  let hasThinkingFragment = false
  for (const fragment of fragments) {
    const key = fragment?.id != null ? `id:${fragment.id}` : `at:${index}`
    index += 1
    if (!fragment || fragment.hidden) continue

    const kind = fragmentKind(fragment.type)
    if (kind === 'reasoning') hasThinkingFragment = true
    if (!kind) continue

    const text = typeof fragment.content === 'string' ? fragment.content : ''
    const previous = state.emitted.get(key)
    if (previous === undefined) {
      state.emitted.set(key, text)
      if (text) yield { type: kind, delta: text }
      continue
    }
    if (text === previous) continue
    if (text.startsWith(previous)) {
      state.emitted.set(key, text)
      const delta = text.slice(previous.length)
      if (delta) yield { type: kind, delta }
    }
    // A non-prefix rewrite (the server sometimes cleans up a fragment at the
    // end) is ignored here; `final` carries the authoritative text.
  }

  // Non-thinking payloads can carry the whole reasoning block as one field.
  if (!hasThinkingFragment && typeof response.thinking_content === 'string' && response.thinking_content) {
    const text = response.thinking_content
    const previous = state.emitted.get('thinking_content') || ''
    if (text !== previous && text.startsWith(previous)) {
      state.emitted.set('thinking_content', text)
      const delta = text.slice(previous.length)
      if (delta) yield { type: 'reasoning', delta }
    }
  }
}

function collectText(state, kind) {
  const fragments = state.data?.response?.fragments
  if (!Array.isArray(fragments)) return ''
  return fragments
    .filter((fragment) => fragment && !fragment.hidden && fragmentKind(fragment.type) === kind)
    .map((fragment) => (typeof fragment.content === 'string' ? fragment.content : ''))
    .join('')
}
