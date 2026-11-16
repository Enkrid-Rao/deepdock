import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Check, ChevronsDown, CloudDownload, Loader2, RotateCw, Search } from 'lucide-react'
import { Dialog } from './ui'
import { api, ApiError } from '../lib/api'
import { relativeTime } from '../lib/format'
import type {
  ConversationMeta,
  RemoteSession,
  SyncCursor,
  SyncImportResult,
  SyncImportRow,
  SyncSessions,
} from '../lib/types'

const PAGE_SIZE = 40
/** Safety valve for 「加载全部」: 60 pages × 40 ≈ 2400 remote conversations. */
const MAX_PAGES = 60
/** The import endpoint accepts at most 40 ids per call. */
const IMPORT_BATCH = 40

function errorText(err: unknown): string {
  if (err instanceof ApiError) {
    const payload = err.payload as { message?: string; error?: string } | null
    if (payload?.error === 'SESSION_EXPIRED') return '登录已失效，请先在左下角重新连接账号。'
    return payload?.message || err.message
  }
  return '读取网页端对话失败，请稍后再试。'
}

function mergeSessions(previous: RemoteSession[], incoming: RemoteSession[]): RemoteSession[] {
  const merged = previous.slice()
  const seen = new Set(merged.map((item) => item.id))
  for (const item of incoming) {
    if (seen.has(item.id)) continue
    seen.add(item.id)
    merged.push(item)
  }
  return merged
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
  const [loadingAll, setLoadingAll] = useState(false)
  const [importing, setImporting] = useState(false)
  const [importProgress, setImportProgress] = useState<{ done: number; total: number } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const requestSeq = useRef(0)
  const busy = useRef(false)
  const listRef = useRef<HTMLDivElement | null>(null)
  const moreRef = useRef<HTMLButtonElement | null>(null)
  const openRef = useRef(open)
  openRef.current = open

  const fetchPage = useCallback(
    (from: SyncCursor | null) =>
      api.syncSessions({
        limit: PAGE_SIZE,
        ...(from ? { cursorPinned: from.pinned, cursorUpdatedAt: from.updatedAt } : {}),
      }),
    [],
  )

  const commit = useCallback((data: SyncSessions, append: boolean) => {
    setSessions((previous) => (append ? mergeSessions(previous, data.sessions) : data.sessions))
    setCursor(data.nextCursor)
    // `nextCursor` is what actually drives the next request, so treat a page
    // without one as the end even if the server still claims has_more.
    setHasMore(Boolean(data.hasMore && data.nextCursor && data.sessions.length))
    return data.sessions
  }, [])

  const load = useCallback(
    async (from: SyncCursor | null = null, append = false) => {
      const seq = ++requestSeq.current
      busy.current = true
      setLoading(true)
      setError(null)
      try {
        const data = await fetchPage(from)
        if (seq !== requestSeq.current) return
        commit(data, append)
        if (!append) {
          setSelected(new Set(data.sessions.filter((item) => !item.imported).map((item) => item.id)))
        }
      } catch (err) {
        if (seq === requestSeq.current) setError(errorText(err))
      } finally {
        if (seq === requestSeq.current) {
          busy.current = false
          setLoading(false)
        }
      }
    },
    [commit, fetchPage],
  )

  const loadMore = useCallback(async () => {
    if (busy.current || loading || loadingAll || !hasMore) return
    const seq = ++requestSeq.current
    busy.current = true
    setLoading(true)
    setError(null)
    try {
      const data = await fetchPage(cursor)
      if (seq !== requestSeq.current) return
      commit(data, true)
    } catch (err) {
      if (seq === requestSeq.current) setError(errorText(err))
    } finally {
      if (seq === requestSeq.current) {
        busy.current = false
        setLoading(false)
      }
    }
  }, [commit, cursor, fetchPage, hasMore, loading, loadingAll])

  const loadAll = useCallback(async () => {
    if (busy.current || loading || loadingAll || !hasMore) return
    const seq = ++requestSeq.current
    busy.current = true
    setLoadingAll(true)
    setError(null)
    setNotice(null)
    let from = cursor
    let more: boolean = hasMore
    let pages = 0
    let total = sessions.length
    try {
      while (more && pages < MAX_PAGES) {
        // Closing the dialog stops the bulk read; whatever arrived is still
        // committed, and the next open starts from the first page again.
        if (!openRef.current) return
        const data = await fetchPage(from)
        if (seq !== requestSeq.current) return
        const added = commit(data, true)
        total += added.length
        from = data.nextCursor
        more = Boolean(data.hasMore && data.nextCursor && data.sessions.length)
        pages += 1
      }
      if (!openRef.current) return
      if (more) {
        // Hit the page cap: say so and keep the button, the user can repeat it.
        setNotice(`已加载 ${total} 个对话，网页端还有更早的；可以再点一次「加载全部」继续。`)
      }
    } catch (err) {
      if (seq === requestSeq.current) setError(errorText(err))
    } finally {
      if (seq === requestSeq.current) {
        busy.current = false
        setLoadingAll(false)
      }
    }
  }, [commit, cursor, fetchPage, hasMore, loading, loadingAll, sessions.length])

  useEffect(() => {
    if (!open) return
    setSessions([])
    setSelected(new Set())
    setQuery('')
    setNotice(null)
    setError(null)
    setHasMore(false)
    setCursor(null)
    void load()
  }, [open, load])

  // Load the next page by itself when the user scrolls the list to its end.
  // The button at the bottom doubles as the sentinel, so it still works with
  // a mouse or the keyboard; while searching we keep the requests manual.
  const searching = Boolean(query.trim())
  useEffect(() => {
    if (!open || !hasMore || searching) return undefined
    const root = listRef.current
    const target = moreRef.current
    if (!root || !target || typeof IntersectionObserver === 'undefined') return undefined

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) void loadMore()
      },
      { root, rootMargin: '140px 0px' },
    )
    observer.observe(target)
    return () => observer.disconnect()
  }, [open, hasMore, searching, loading, loadingAll, loadMore])

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
    const ids = selectedPending
    setImporting(true)
    setImportProgress({ done: 0, total: ids.length })
    setError(null)
    setNotice(null)

    const results: SyncImportRow[] = []
    let conversations: ConversationMeta[] | null = null
    let failure: unknown = null

    // The API takes at most 40 ids per call, and after 「加载全部」 the user can
    // easily have hundreds selected, so walk the list in batches.
    for (let index = 0; index < ids.length; index += IMPORT_BATCH) {
      if (!openRef.current) break
      const chunk = ids.slice(index, index + IMPORT_BATCH)
      try {
        const res = await api.syncImport(chunk)
        results.push(...res.results)
        if (res.conversations?.length) conversations = res.conversations
      } catch (err) {
        failure = err
        break
      }
      setImportProgress({ done: index + chunk.length, total: ids.length })
    }

    setImporting(false)
    setImportProgress(null)

    if (conversations) {
      onImported({
        results,
        imported: results.filter((row) => row.status === 'imported').length,
        skipped: results.filter((row) => row.status === 'exists').length,
        failed: results.filter((row) => row.status === 'failed').length,
        conversations,
      })
    }

    const failedRows = results.filter((row) => row.status === 'failed')
    if (failure) {
      setError(errorText(failure))
      setSelected(new Set())
      void load()
      return
    }
    if (failedRows.length) {
      const imported = results.filter((row) => row.status === 'imported').length
      setNotice(`${imported} 个已导入，${failedRows.length} 个失败：${failedRows[0].message || '上游错误'}`)
      setSelected(new Set())
      void load()
      return
    }
    onClose()
  }

  const footerNote = (
    <>
      已选 {selectedPending.length} 个
      {sessions.length ? ` · 已加载 ${sessions.length} 个` : ''}
      {hasMore ? ' · 还有更早的' : ''}
    </>
  )

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
          <span className="sync-foot-note">{footerNote}</span>
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
              ? importProgress && importProgress.total > IMPORT_BATCH
                ? `正在导入 ${importProgress.done}/${importProgress.total}…`
                : '正在导入…'
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
        {hasMore || loadingAll ? (
          <button
            type="button"
            className="ghost-btn"
            title="把网页端剩下的历史一次读完"
            onClick={() => void loadAll()}
            disabled={loading || loadingAll || !hasMore}
          >
            {loadingAll ? <Loader2 size={13} className="spin" /> : <ChevronsDown size={13} />}
            {loadingAll ? `已加载 ${sessions.length}` : '加载全部'}
          </button>
        ) : null}
        <button
          type="button"
          className="icon-btn"
          title="重新读取"
          onClick={() => void load()}
          disabled={loading || loadingAll || importing}
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

      <div className="sync-list" ref={listRef}>
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
          <div className="sync-empty">
            没有匹配「{query}」的对话。
            {hasMore ? <span className="sync-empty-hint">更早的对话还没加载，可以点上面的「加载全部」再搜。</span> : null}
          </div>
        ) : null}

        {hasMore ? (
          <button
            ref={moreRef}
            type="button"
            className="sync-more"
            onClick={() => void loadMore()}
            disabled={loading || loadingAll}
          >
            {loading || loadingAll ? <Loader2 size={13} className="spin" /> : null}
            {loadingAll
              ? `正在读完剩下的历史…（已加载 ${sessions.length}）`
              : loading
                ? '正在加载更早的对话…'
                : '加载更早的对话'}
          </button>
        ) : sessions.length ? (
          <div className="sync-end">已经读到网页端的全部 {sessions.length} 个对话</div>
        ) : null}
      </div>
    </Dialog>
  )
}
