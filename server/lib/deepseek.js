// A very small client for chat.deepseek.com's internal API.
// Only the handful of endpoints DeepDock needs are implemented.

import * as pow from './pow.js'

const BASE = 'https://chat.deepseek.com/api/v0'
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
    const res = await fetch(BASE + targetPath, {
      method: 'POST',
      headers: this.headers({ extra: { 'x-ds-pow-response': powHeader } }),
      body: JSON.stringify(payload),
      signal,
    })

    const ctype = res.headers.get('content-type') || ''
    if (!ctype.includes('text/event-stream')) {
      const text = await res.text()
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
 */
export async function* readCompletionStream(response, signal) {
  const decoder = new TextDecoder('utf-8')
  let buffer = ''
  let messageId = null

  for await (const chunk of response.body) {
    if (signal?.aborted) break
    buffer += decoder.decode(chunk, { stream: true })

    let nl
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).replace(/\r$/, '')
      buffer = buffer.slice(nl + 1)
      if (!line || line.startsWith(':')) continue
      if (!line.startsWith('data:')) continue
      const payload = line.slice(5).trim()
      if (!payload || payload === '[DONE]') continue
      let evt
      try {
        evt = JSON.parse(payload)
      } catch {
        continue
      }
      for (const out of interpretEvent(evt, (id) => (messageId = id))) {
        if (out.type === 'meta' && out.messageId) messageId = out.messageId
        yield out
      }
    }
  }
  if (messageId) yield { type: 'meta', messageId, late: true }
}

function* interpretEvent(evt, rememberId) {
  if (!evt || typeof evt !== 'object') return

  if (evt.type === 'error') {
    yield { type: 'error', message: evt.content || evt.message || 'DeepSeek 返回错误' }
    return
  }

  // Token-usage heartbeat.
  if (evt.o === 'BATCH') return
  if (evt.o === 'SET' && evt.v === 'FINISHED') {
    yield { type: 'finish' }
    return
  }
  if (evt.p === 'status' && evt.v === 'FINISHED') {
    yield { type: 'finish' }
    return
  }

  const v = evt.v
  if (typeof v === 'string') {
    if (!v) return
    if (typeof evt.p === 'string' && /think/i.test(evt.p)) {
      yield { type: 'reasoning', delta: v }
    } else {
      yield { type: 'content', delta: v }
    }
    return
  }

  if (v && typeof v === 'object') {
    const response = v.response || v
    const id = response?.message_id || v.message_id
    if (id) {
      rememberId(id)
      yield { type: 'meta', messageId: id }
    }
    const thinking = response?.thinking_content
    if (typeof thinking === 'string' && thinking) {
      yield { type: 'reasoning', delta: thinking }
    }
    const fragments = response?.fragments
    if (Array.isArray(fragments)) {
      for (const fragment of fragments) {
        const text = fragment?.content
        if (typeof text !== 'string' || !text) continue
        const kind = String(fragment.type || '').toUpperCase()
        if (kind.includes('THINK') || kind.includes('REASON')) {
          yield { type: 'reasoning', delta: text }
        } else if (!fragment.hidden) {
          yield { type: 'content', delta: text }
        }
      }
    }
    return
  }

  if (typeof evt.content === 'string' && evt.content) {
    yield { type: 'content', delta: evt.content }
  }
}
