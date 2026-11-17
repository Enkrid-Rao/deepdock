import { useCallback, useEffect, useRef, useState } from 'react'
import {
  ArrowRight,
  Check,
  Copy,
  ExternalLink,
  KeyRound,
  Laptop,
  Loader2,
  ShieldCheck,
  Sparkles,
} from 'lucide-react'
import { api, ApiError } from '../lib/api'
import { Logo, copyText } from './ui'
import type { User } from '../lib/types'

const SNIPPET = "localStorage.getItem('userToken')"

type AutoConnectResult = {
  ok: boolean
  reason?: string
  message?: string
  found?: number
  source?: string
  sources?: string[]
  user?: User | null
  scanned?: { browser: string; profile: string; tokens: number }[]
}

type DesktopBridge = {
  isDesktop: boolean
  autoConnect?: () => Promise<AutoConnectResult>
  scanInfo?: () => Promise<{
    found: number
    sources: string[]
    scanned: { browser: string; profile: string; tokens: number }[]
    errors: { message?: string }[]
  }>
  openExternal?: (url: string) => Promise<void>
}

const bridge = (window as unknown as { deepdockDesktop?: DesktopBridge }).deepdockDesktop

export function Connect({
  mock,
  onConnected,
  onClose,
}: {
  mock: boolean
  onConnected: (user: User | null) => void
  onClose?: () => void
}) {
  const [token, setToken] = useState('')
  const [cookie, setCookie] = useState('')
  const [showCookie, setShowCookie] = useState(false)
  const [busy, setBusy] = useState(false)
  const [scanning, setScanning] = useState(false)
  const [scanNote, setScanNote] = useState<string | null>(null)
  const [scanSources, setScanSources] = useState<string[]>([])
  const [scannedBrowsers, setScannedBrowsers] = useState<string[]>([])
  const [error, setError] = useState<string | null>(null)
  const [detail, setDetail] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const tokenRef = useRef<HTMLTextAreaElement>(null)
  const autoRan = useRef(false)

  const canScan = Boolean(bridge?.autoConnect)

  useEffect(() => {
    tokenRef.current?.focus()
  }, [])

  const scan = useCallback(
    async (manual = false) => {
      if (!bridge?.autoConnect || scanning) return
      setScanning(true)
      setError(null)
      setDetail(null)
      setScanNote(null)
      setScanSources([])
      try {
        const result = await bridge.autoConnect()
        const sources = result.sources || []
        setScanSources(sources)
        if (result.scanned) {
          setScannedBrowsers(
            result.scanned.map((item) => `${item.browser} · ${item.profile}${item.tokens ? ' ✓' : ''}`),
          )
        }
        if (result.ok) {
          setScanNote(`已从 ${result.source || '本机浏览器'} 读取并验证登录，正在进入…`)
          onConnected(result.user || null)
          return
        }
        if (result.reason === 'not_found' || !result.found) {
          setError('本机浏览器里没有找到 chat.deepseek.com 的登录记录。')
          setDetail(
            manual
              ? '请确认 Chrome / Edge 里确实登录了 chat.deepseek.com（无痕窗口不会被读到），然后点「重新读取」。'
              : '下面可以用手动方式粘贴一次 userToken。',
          )
          return
        }
        setError(
          result.reason === 'network'
            ? result.message || '读取到了凭证，但连接 DeepSeek 失败，请检查网络后重试。'
            : '找到了登录记录，但都已经失效。',
        )
        setDetail(
          result.reason === 'network'
            ? sources.join(' · ')
            : '在浏览器里打开 chat.deepseek.com 刷新一次，确认还是登录状态，然后再点「重新读取」。',
        )
      } catch (err) {
        setError('读取浏览器数据失败，请改用手动方式。')
        setDetail(err instanceof Error ? err.message : null)
      } finally {
        setScanning(false)
      }
    },
    [onConnected, scanning],
  )

  // The desktop shell tries the browser first, so most launches need no input.
  useEffect(() => {
    if (!canScan || autoRan.current) return
    autoRan.current = true
    void scan()
  }, [canScan, scan])

  const submit = async () => {
    if (!token.trim()) {
      setError('请先粘贴 userToken')
      return
    }
    setBusy(true)
    setError(null)
    setDetail(null)
    try {
      const res = await api.connect({ token: token.trim(), cookie: cookie.trim() })
      onConnected(res.user)
    } catch (err) {
      if (err instanceof ApiError) {
        setError(err.message)
        const payload = err.payload as { detail?: string; error?: string } | null
        setDetail(payload?.detail || null)
      } else {
        setError('连接失败，请稍后再试')
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="connect">
      <div className="connect-card">
        <div className="connect-brand">
          <div className="brand-mark">
            <Logo size={28} />
          </div>
          <div className="brand-text">
            <span className="brand-name">deepdock</span>
            <span className="brand-sub">深坞 · DeepSeek</span>
          </div>
          {onClose ? (
            <button type="button" className="btn btn-ghost" style={{ marginLeft: 'auto' }} onClick={onClose}>
              取消
            </button>
          ) : null}
        </div>

        <h1>
          Connect your
          <br />
          DeepSeek <em style={{ color: 'var(--accent)' }}>account</em>
        </h1>
        <p className="lede">
          网页端的登录凭证在浏览器的 <code style={{ fontFamily: 'var(--font-mono)', fontSize: 12 }}>localStorage</code>
          {' '}里，而不是 Cookie。DeepDock 会先尝试直接读取本机 Chrome / Edge 已经登录的那一份；读不到时，再手动粘贴一次。
        </p>

        {canScan ? (
          <>
            <button
              type="button"
              className="btn scan-btn"
              onClick={() => void scan(true)}
              disabled={scanning || busy}
            >
              {scanning ? <Loader2 size={15} className="spin" /> : <Laptop size={15} />}
              {scanning ? '正在读取本机浏览器…' : '从本机 Chrome / Edge 读取并登录'}
            </button>

            {scanNote ? (
              <div className="scan-success">
                <Sparkles size={14} /> {scanNote}
              </div>
            ) : null}

            {!scanNote && (scannedBrowsers.length || scanSources.length) ? (
              <div className="hint" style={{ marginTop: 8, textAlign: 'center' }}>
                {scanSources.length ? `找到：${scanSources.join(' · ')}` : scannedBrowsers.join(' · ')}
              </div>
            ) : null}

            <details className="connect-explain">
              <summary>不用装扩展，它是怎么读到浏览器登录态的？</summary>
              <p>
                Chromium 系浏览器把 localStorage 明文保存在用户目录下的
                {' '}<code>Local Storage/leveldb</code>{' '}里。DeepDock 只读这一份本地数据库，
                解出 <code>chat.deepseek.com</code> 的 <code>userToken</code>：
                不解密密码、不读 Cookie、不连远程调试端口，也不会上传。
                读到的凭证只写进本机的数据目录，之后一直复用。
              </p>
            </details>

            <div className="or-divider">
              <span>或者手动粘贴</span>
            </div>
          </>
        ) : null}

        {error ? (
          <div className="form-error">
            <KeyRound size={14} style={{ flex: 'none', marginTop: 2 }} />
            <div>
              {error}
              {detail ? <div style={{ opacity: 0.75, marginTop: 4 }}>{detail}</div> : null}
            </div>
          </div>
        ) : null}

        <div className="steps">
          <div className="step">
            <span className="step-num">1</span>
            在已登录的浏览器里打开 <strong>chat.deepseek.com</strong>，按 <kbd>F12</kbd> 打开控制台
          </div>
          <div className="step">
            <span className="step-num">2</span>
            切到 <strong>Console</strong>，粘贴下面这行并回车，它会输出一段 JSON
            <div className="snippet">
              {SNIPPET}
              <button
                type="button"
                className="icon-btn copy"
                title="复制这行命令"
                onClick={async () => {
                  const ok = await copyText(SNIPPET)
                  if (ok) {
                    setCopied(true)
                    window.setTimeout(() => setCopied(false), 1500)
                  }
                }}
              >
                {copied ? <Check size={13} /> : <Copy size={13} />}
              </button>
            </div>
          </div>
          <div className="step">
            <span className="step-num">3</span>
            把复制到的内容粘贴到下面
            <span style={{ color: 'var(--faint)' }}>（形如 {'{"value":"…"}'}）</span>
          </div>
        </div>

        <div className="field">
          <label htmlFor="token">
            userToken
            <span className="opt">必填</span>
          </label>
          <textarea
            id="token"
            ref={tokenRef}
            rows={3}
            value={token}
            spellCheck={false}
            placeholder='{"value":"eyJhbGciOi…","__version":"0"}'
            onChange={(e) => setToken(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void submit()
            }}
          />
        </div>

        <button
          type="button"
          className="link"
          style={{ fontSize: 12, marginBottom: 14 }}
          onClick={() => setShowCookie((v) => !v)}
        >
          {showCookie ? '收起' : '高级：同时粘贴 Cookie（可选）'}
        </button>

        {showCookie ? (
          <div className="field">
            <label htmlFor="cookie">
              Cookie
              <span className="opt">可选</span>
            </label>
            <textarea
              id="cookie"
              rows={2}
              value={cookie}
              spellCheck={false}
              placeholder="ds_session_id=…; HWWAFSESID=…"
              onChange={(e) => setCookie(e.target.value)}
            />
            <div className="hint">粘贴请求头里完整的 Cookie 值即可，让请求更接近浏览器发出的。</div>
          </div>
        ) : null}

        <button type="button" className="btn btn-primary" onClick={submit} disabled={busy}>
          {busy ? <Loader2 size={15} className="spin" /> : <ArrowRight size={15} />}
          {busy ? '正在连接…' : '连接 DeepSeek'}
        </button>

        <div className="connect-foot">
          <ShieldCheck size={13} />
          <span>凭证仅存本地 · 对话内容直连 DeepSeek</span>
          <span className="spacer" />
          <a className="link" href="https://chat.deepseek.com" target="_blank" rel="noreferrer">
            chat.deepseek.com <ExternalLink size={10} style={{ verticalAlign: -1 }} />
          </a>
        </div>

        {mock ? (
          <div className="hint" style={{ marginTop: 10, color: 'var(--faint)' }}>
            当前是演示模式（DEEPDOCK_MOCK=1），随便填一个值即可进入。
          </div>
        ) : null}
      </div>
    </div>
  )
}
