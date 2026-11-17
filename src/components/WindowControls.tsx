import { useEffect, useState } from 'react'
import { Copy, Minus, Square, X } from 'lucide-react'

type WindowBridge = {
  platform: string
  windowControl?: (action: 'minimize' | 'maximize' | 'close') => Promise<{ maximized: boolean }>
  windowState?: () => Promise<{ maximized: boolean }>
  onWindowState?: (callback: (state: { maximized: boolean }) => void) => () => void
}

const bridge = (window as unknown as { deepdockDesktop?: WindowBridge }).deepdockDesktop

/**
 * Windows uses a frameless window, so DeepDock draws its own minimize /
 * maximize / close buttons. They sit above every screen (chat, settings,
 * connect) and follow the current theme.
 */
export function WindowControls() {
  const [maximized, setMaximized] = useState(false)

  useEffect(() => {
    if (!bridge?.onWindowState) return undefined
    const unsubscribe = bridge.onWindowState((state) => setMaximized(Boolean(state?.maximized)))
    bridge
      .windowState?.()
      .then((state) => setMaximized(Boolean(state?.maximized)))
      .catch(() => {})
    return unsubscribe
  }, [])

  if (bridge?.platform !== 'win32' || !bridge.windowControl) return null

  const run = (action: 'minimize' | 'maximize' | 'close') => {
    void bridge.windowControl?.(action).then((state) => {
      if (state) setMaximized(Boolean(state.maximized))
    })
  }

  return (
    <div className="window-controls" aria-label="窗口控制">
      <button type="button" className="window-btn" title="最小化" aria-label="最小化" onClick={() => run('minimize')}>
        <Minus size={13} strokeWidth={1.6} />
      </button>
      <button
        type="button"
        className="window-btn"
        title={maximized ? '还原' : '最大化'}
        aria-label={maximized ? '还原' : '最大化'}
        onClick={() => run('maximize')}
      >
        {maximized ? <Copy size={11} strokeWidth={1.6} /> : <Square size={11} strokeWidth={1.6} />}
      </button>
      <button
        type="button"
        className="window-btn window-btn-close"
        title="关闭"
        aria-label="关闭"
        onClick={() => run('close')}
      >
        <X size={14} strokeWidth={1.6} />
      </button>
    </div>
  )
}
