// Conversion helpers for pulling chat.deepseek.com history into the local store.
//
// The web API returns a message store with fragments:
//   USER       REQUEST (text), FILE (attachment)
//   ASSISTANT  THINK (reasoning), RESPONSE (answer), TOOL_* (search steps), TIP
// DeepDock only models user/assistant text plus an optional reasoning block, so
// everything else is folded down or skipped.

const ATTACHMENT_PLACEHOLDER = '（附件消息，DeepDock 暂不支持显示附件）'

function fragmentText(fragments, types) {
  return fragments
    .filter((fragment) => fragment && types.includes(String(fragment.type || '').toUpperCase()))
    .map((fragment) => (typeof fragment.content === 'string' ? fragment.content : ''))
    .filter(Boolean)
    .join('')
}

function numericId(message) {
  const value = Number(message?.message_id)
  return Number.isFinite(value) ? value : 0
}

/**
 * @param {{ chat_session?: object, chat_messages?: object[] }} history
 * @param {{ updatedAt?: number }} [session]
 */
export function convertRemoteHistory(history, session = {}) {
  const raw = Array.isArray(history?.chat_messages) ? history.chat_messages : []
  const ordered = [...raw].sort((a, b) => numericId(a) - numericId(b))
  const messages = []
  let hasAttachment = false

  for (const message of ordered) {
    const role = String(message?.role || '').toUpperCase() === 'USER' ? 'user' : 'assistant'
    const fragments = Array.isArray(message?.fragments) ? message.fragments : []
    const types = fragments.map((fragment) => String(fragment?.type || '').toUpperCase())
    const attachment = types.includes('FILE')
    if (attachment) hasAttachment = true

    if (role === 'user') {
      const text = fragmentText(fragments, ['REQUEST']).trim()
      const content = text || (attachment ? ATTACHMENT_PLACEHOLDER : '')
      if (!content) continue
      messages.push({
        role,
        content,
        createdAt: Math.round(Number(message.inserted_at || 0) * 1000) || Date.now(),
        dsMessageId: String(message.message_id ?? '') || null,
        thinking: Boolean(message.thinking_enabled),
        search: Boolean(message.search_enabled),
      })
      continue
    }

    const content = fragmentText(fragments, ['RESPONSE']).trim()
    const reasoning = fragmentText(fragments, ['THINK']).trim()
    if (!content && !reasoning) continue
    messages.push({
      role,
      content,
      reasoning,
      createdAt: Math.round(Number(message.inserted_at || 0) * 1000) || Date.now(),
      dsMessageId: String(message.message_id ?? '') || null,
      thinking: Boolean(message.thinking_enabled),
      search: Boolean(message.search_enabled),
    })
  }

  const lastAssistant = [...messages].reverse().find((message) => message.role === 'assistant')
  const remoteSession = history?.chat_session || {}
  const updatedAt =
    Number(session.updatedAt) ||
    Math.round(Number(remoteSession.updated_at || 0) * 1000) ||
    messages[messages.length - 1]?.createdAt ||
    Date.now()
  const createdAt = messages[0]?.createdAt || updatedAt

  return {
    title: String(remoteSession.title || session.title || '').trim() || '新对话',
    pinned: Boolean(session.pinned ?? remoteSession.pinned),
    createdAt,
    updatedAt,
    parentMessageId: lastAssistant?.dsMessageId || null,
    messages,
    hasAttachment,
  }
}

/** Normalise the `chat_session/fetch_page` payload into plain objects. */
export function convertSessionPage(bizData) {
  const sessions = Array.isArray(bizData?.chat_sessions) ? bizData.chat_sessions : []
  return {
    hasMore: Boolean(bizData?.has_more),
    sessions: sessions.map((session) => ({
      id: String(session.id),
      title: String(session.title || '').trim() || '新对话',
      updatedAt: Math.round(Number(session.updated_at || 0) * 1000),
      updatedAtRaw: Number(session.updated_at || 0),
      pinned: Boolean(session.pinned),
      titleType: session.title_type || null,
      modelType: session.model_type || null,
    })),
  }
}
