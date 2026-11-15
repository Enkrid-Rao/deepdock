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
    { sessionId, parentMessageId, prompt, thinking = false, search = false, signal },
    { retry = true } = {},
  ) {
    const targetPath = '/api/v0/chat/completion'
    const powHeader = await this.solveChallenge(targetPath)
    const payload = {
      chat_session_id: sessionId,
      parent_message_id: parentMessageId || null,
      model_type: null,
      prompt,
      ref_file_ids: [],
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
 *
 * DeepSeek streams both incremental appends (which omit the fragment type) and
 * periodic full `fragments` snapshots. We keep a small fragment state so the
 * THINK / RESPONSE classification stays correct and snapshots never duplicate
 * text that was already emitted.
 */
export async function* readCompletionStream(response, signal) {
  const decoder = new TextDecoder('utf-8')
  let buffer = ''
  const state = { messageId: null, fragments: new Map(), currentId: null, currentKind: null }

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
      yield* interpretEvent(evt, state, eventName)
    }
  }
  if (state.messageId) yield { type: 'meta', messageId: state.messageId, late: true }
}

function fragmentKind(type) {
  const kind = String(type || '').toUpperCase()
  if (kind.includes('THINK') || kind.includes('REASON')) return 'reasoning'
  if (!kind || kind === 'TEXT' || kind === 'ANSWER' || kind.includes('RESPONSE')) return 'content'
  return null
}

function* applySnapshot(fragments, state) {
  let lastId = null
  let lastKind = null
  for (const fragment of fragments) {
    if (!fragment) continue
    const id = fragment.id ?? `fragment-${lastId ?? fragments.length}`
    const kind = fragmentKind(fragment.type)
    lastId = id
    lastKind = kind

    if (!kind || fragment.hidden) continue
    const text = typeof fragment.content === 'string' ? fragment.content : ''
    const previous = state.fragments.get(id)?.content || ''
    let delta = ''
    if (text.startsWith(previous)) delta = text.slice(previous.length)
    // A final snapshot may be a cleaned-up rewrite of what was streamed
    // (e.g. "1+1 等于 2。" → "1加1等于2"). Keep the streamed text rather than
    // appending the rewrite a second time.
    state.fragments.set(id, { kind, content: text })
    if (delta) yield { type: kind, delta }
  }
  if (lastId !== null) {
    state.currentId = lastId
    state.currentKind = lastKind
  }
}

function* interpretEvent(evt, state, eventName = 'message') {
  if (!evt || typeof evt !== 'object') return

  // The title event carries a generated conversation title, not answer text.
  if (eventName === 'title') return
  if (eventName === 'ready' || eventName === 'update_session' || eventName === 'close') return

  if (eventName === 'error' || evt.type === 'error') {
    yield { type: 'error', message: evt.content || evt.message || 'DeepSeek 返回错误' }
    return
  }

  // Token-usage heartbeat / finish markers.
  if (evt.o === 'BATCH') return
  if ((evt.o === 'SET' && evt.v === 'FINISHED') || (evt.p === 'status' && evt.v === 'FINISHED')) {
    yield { type: 'finish' }
    return
  }

  const v = evt.v
  const path = typeof evt.p === 'string' ? evt.p : ''

  if (Array.isArray(v)) {
    // Full fragment list for the current response.
    yield* applySnapshot(v, state)
    return
  }

  if (v && typeof v === 'object') {
    const response = v.response || v
    const id = response?.message_id || v.message_id
    if (id && id !== state.messageId) {
      state.messageId = id
      yield { type: 'meta', messageId: id }
    }
    if (Array.isArray(response?.fragments)) {
      yield* applySnapshot(response.fragments, state)
    } else if (typeof response?.thinking_content === 'string' && response.thinking_content) {
      yield { type: 'reasoning', delta: response.thinking_content }
    }
    return
  }

  if (typeof v === 'string' && v) {
    const fragmentMatch = path.match(/^response\/fragments\/([^/]+)\/content$/)
    if (fragmentMatch) {
      const id = fragmentMatch[1] === '-1' ? state.currentId : fragmentMatch[1]
      if (id == null) return
      const current = state.fragments.get(id) || { kind: state.currentKind, content: '' }
      if (evt.o === 'SET') {
        const previous = current.content
        current.content = v
        state.fragments.set(id, current)
        const delta = v.startsWith(previous) ? v.slice(previous.length) : v
        if (delta && (current.kind === 'reasoning' || current.kind === 'content')) {
          yield { type: current.kind, delta }
        }
      } else {
        current.content += v
        state.fragments.set(id, current)
        if (current.kind === 'reasoning' || current.kind === 'content') {
          yield { type: current.kind, delta: v }
        }
      }
      return
    }

    if (/think|reason/i.test(path)) {
      yield { type: 'reasoning', delta: v }
      return
    }

    // Appends without a path belong to the fragment that was last announced.
    if (state.currentId != null) {
      const current = state.fragments.get(state.currentId) || { kind: state.currentKind, content: '' }
      current.content += v
      state.fragments.set(state.currentId, current)
      if (current.kind === 'reasoning' || current.kind === 'content') {
        yield { type: current.kind, delta: v }
      }
      return
    }

    yield { type: 'content', delta: v }
    return
  }
}
