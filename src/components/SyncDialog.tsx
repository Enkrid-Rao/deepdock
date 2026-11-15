import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Check, CloudDownload, Loader2, RotateCw, Search } from 'lucide-react'
import { Dialog } from './ui'
import { api, ApiError } from '../lib/api'
import { relativeTime } from '../lib/format'
import type { ConversationMeta, RemoteSession, SyncCursor, SyncImportResult } from '../lib/types'

const PAGE_SIZE = 40

function errorText(err: unknown): string {
  if (err instanceof ApiError) {
    const payload = err.payload as { message?: string; error?: string } | null
    if (payload?.error === 'SESSION_EXPIRED') return '登录已失效，请先在左下角重新连接账号。'
    return payload?.message || err.message
  }
  return '读取网页端对话失败，请稍后再试。'
}

export function SyncDialog({
  open,
  onClose,
  onImported,
}: {
  open: boolean
  onClose: () => void
  onImported: (result: SyncImportResult) => void
}) {
  const [sessions, setSessions] = useState<RemoteSession[]>([])
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [cursor, setCursor] = useState<SyncCursor | null>(null)
  const [hasMore, setHasMore] = useState(false)
  const [query, setQuery] = useState('')
  const [loading, setLoading] = useState(false)
  const [importing, setImporting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const requestSeq = useRef(0)

  const load = useCallback(
    async (nextCursor: SyncCursor | null = null, append = false) => {
      const seq = ++requestSeq.current
      setLoading(true)
      setError(null)
      try {
        const data = await api.syncSessions({
          limit: PAGE_SIZE,
          ...(nextCursor
            ? { cursorPinned: nextCursor.pinned, cursorUpdatedAt: nextCursor.updatedAt }
            : {}),
        })
        if (seq !== requestSeq.current) return
        setSessions((previous) => {
          const merged = append ? [...previous] : []
          const seen = new Set(merged.map((item) => item.id))
          for (const item of data.sessions) if (!seen.has(item.id)) merged.push(item)
          return merged
        })
        if (!append) {
          setSelected(new Set(data.sessions.filter((item) => !item.imported).map((item) => item.id)))
        }
        setHasMore(data.hasMore)
        setCursor(data.nextCursor)
      } catch (err) {
        if (seq === requestSeq.current) setError(errorText(err))
      } finally {
        if (seq === requestSeq.current) setLoading(false)
      }
    },
    [],
  )

  useEffect(() => {
    if (!open) return
    setSessions([])
    setSelected(new Set())
    setQuery('')
    setNotice(null)
    setHasMore(false)
    setCursor(null)
    void load()
  }, [open, load])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return sessions
    return sessions.filter((item) => item.title.toLowerCase().includes(q))
  }, [query, sessions])

  const pending = sessions.filter((item) => !item.imported)
  const selectedPending = [...selected].filter((id) => sessions.find((item) => item.id === id && !item.imported))

  const toggle = (session: RemoteSession) => {
    if (session.imported) return
    setSelected((previous) => {
      const next = new Set(previous)
      if (next.has(session.id)) next.delete(session.id)
      else next.add(session.id)
      return next
    })
  }

  const selectAll = (value: boolean) => {
    setSelected(value ? new Set(pending.map((item) => item.id)) : new Set())
  }

  const runImport = async () => {
    if (!selectedPending.length || importing) return
    setImporting(true)
    setError(null)
    setNotice(null)
    try {
      const result = await api.syncImport(selectedPending)
      onImported(result)
      const failedRows = result.results.filter((row) => row.status === 'failed')
      if (failedRows.length) {
        setNotice(`${result.imported} 个已导入，${failedRows.length} 个失败：${failedRows[0].message || '上游错误'}`)
        setSelected(new Set())
        void load()
      } else {
        onClose()
      }
    } catch (err) {
      setError(errorText(err))
    } finally {
      setImporting(false)
    }
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      width={620}
      className="dialog-sync"
      title="从网页同步对话"
      description="把 chat.deepseek.com 的会话拉进 DeepDock。导入后会保留网页端的会话链，之后在 DeepDock 继续提问，回复也会出现在网页端历史里。"
      footer={
        <>
          <span className="sync-foot-note">
            已选 {selectedPending.length} 个
            {pending.length ? ` · 共 ${pending.length} 个未导入` : ''}
          </span>
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            取消
          </button>
          <button
            type="button"
            className="btn btn-primary"
            style={{ width: 'auto' }}
            disabled={!selectedPending.length || importing}
            onClick={() => void runImport()}
          >
            {importing ? <Loader2 size={14} className="spin" /> : <CloudDownload size={14} />}
            {importing
              ? '正在导入…'
              : selectedPending.length
                ? `导入 ${selectedPending.length} 个对话`
                : '导入对话'}
          </button>
        </>
      }
    >
      <div className="sync-toolbar">
        <div className="sync-search">
          <Search size={13} />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索网页端的对话"
            aria-label="搜索网页端的对话"
          />
        </div>
        <button
          type="button"
          className="ghost-btn"
          onClick={() => selectAll(selectedPending.length !== pending.length)}
          disabled={!pending.length}
        >
          {selectedPending.length === pending.length && pending.length ? '取消全选' : '全选未导入'}
        </button>
        <button
          type="button"
          className="icon-btn"
          title="重新读取"
          onClick={() => void load()}
          disabled={loading || importing}
        >
          <RotateCw size={14} className={loading ? 'spin' : undefined} />
        </button>
      </div>

      {error ? (
        <div className="form-error" style={{ marginBottom: 12 }}>
          {error}
        </div>
      ) : null}
      {notice ? <div className="sync-notice">{notice}</div> : null}

      <div className="sync-list">
        {loading && !sessions.length ? (
          <div className="sync-loading">
            <Loader2 size={16} className="spin" />
            正在读取网页端的历史…
          </div>
        ) : null}

        {!loading && !sessions.length && !error ? (
          <div className="sync-empty">网页端还没有对话，先在 chat.deepseek.com 聊几句再来。</div>
        ) : null}

        {filtered.map((session) => {
          const checked = selected.has(session.id)
          return (
            <button
              key={session.id}
              type="button"
              className="sync-row"
              data-selected={checked}
              data-imported={session.imported}
              onClick={() => toggle(session)}
              title={session.imported ? '这个对话已经导入过了' : '点击选择/取消'}
            >
              <span className="sync-check">{session.imported ? <Check size={11} /> : checked ? <Check size={11} /> : null}</span>
              <span className="sync-main">
                <span className="sync-title">{session.title || '新对话'}</span>
                <span className="sync-meta">
                  {relativeTime(session.updatedAt)}
                  {session.pinned ? ' · 已置顶' : ''}
                  {session.imported ? ' · 已在本地' : ''}
                </span>
              </span>
              <span className="sync-badge" data-kind={session.imported ? 'done' : 'new'}>
                {session.imported ? '已导入' : '网页端'}
              </span>
            </button>
          )
        })}

        {!loading && sessions.length > 0 && !filtered.length ? (
          <div className="sync-empty">没有匹配「{query}」的对话。</div>
        ) : null}

        {hasMore ? (
          <button
            type="button"
            className="sync-more"
            onClick={() => void load(cursor, true)}
            disabled={loading}
          >
            {loading ? <Loader2 size={13} className="spin" /> : null}
            加载更早的对话
          </button>
        ) : null}
      </div>
    </Dialog>
  )
}
