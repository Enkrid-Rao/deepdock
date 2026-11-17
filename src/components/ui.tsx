import { createPortal } from 'react-dom'
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react'
import { Check, Copy } from 'lucide-react'

/** Product icon inside the rounded brand tile (same art as the app icon). */
export function Logo({ size = 28 }: { size?: number }) {
  return (
    <img
      className="brand-logo"
      src="/logo.png"
      width={size}
      height={size}
      alt=""
      draggable={false}
    />
  )
}

export function WaveArt({ className }: { className?: string }) {
  const rows = [0, 1, 2, 3, 4, 5, 6]
  return (
    <svg className={className} viewBox="0 0 640 420" fill="none" aria-hidden="true">
      {rows.map((i) => {
        const y = 150 + i * 26
        return (
          <path
            key={i}
            d={`M-30 ${y} C 90 ${y - 26}, 170 ${y + 26}, 320 ${y} S 550 ${y - 26}, 670 ${y}`}
            stroke="currentColor"
            strokeWidth={i === 0 ? 1.3 : 0.9}
            opacity={Math.max(0.08, 0.85 - i * 0.12)}
          />
        )
      })}
      <circle cx="320" cy="146" r="3.4" fill="currentColor" opacity="0.55" />
    </svg>
  )
}

/* ---------------------------------------------------------------- copy ---- */

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    try {
      const el = document.createElement('textarea')
      el.value = text
      el.style.position = 'fixed'
      el.style.opacity = '0'
      document.body.appendChild(el)
      el.select()
      const ok = document.execCommand('copy')
      document.body.removeChild(el)
      return ok
    } catch {
      return false
    }
  }
}

export function CopyButton({
  text,
  className = 'action-btn',
  title = '复制',
  children,
}: {
  text: string
  className?: string
  title?: string
  children?: ReactNode
}) {
  const [done, setDone] = useState(false)
  const timer = useRef<number | undefined>(undefined)

  useEffect(() => () => window.clearTimeout(timer.current), [])

  return (
    <button
      type="button"
      className={className}
      title={done ? '已复制' : title}
      aria-label={title}
      onClick={async (e) => {
        e.stopPropagation()
        const ok = await copyText(text)
        if (!ok) return
        setDone(true)
        window.clearTimeout(timer.current)
        timer.current = window.setTimeout(() => setDone(false), 1500)
      }}
    >
      {done ? <Check size={14} /> : children || <Copy size={14} />}
    </button>
  )
}

/* ---------------------------------------------------------------- menu ---- */

type MenuProps = {
  trigger: (p: { onClick: (e: React.MouseEvent) => void; open: boolean }) => ReactNode
  children: ReactNode | ((close: () => void) => ReactNode)
  align?: 'left' | 'right'
  width?: number
}

export function Menu({ trigger, children, align = 'left', width = 196 }: MenuProps) {
  const [open, setOpen] = useState(false)
  const [style, setStyle] = useState<CSSProperties>({ opacity: 0, left: -9999, top: -9999 })
  const panelRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLElement | null>(null)
  const rectRef = useRef<DOMRect | null>(null)

  useLayoutEffect(() => {
    if (!open) return
    const panel = panelRef.current
    const rect = rectRef.current
    if (!panel || !rect) return
    const w = panel.offsetWidth || width
    const h = panel.offsetHeight
    let left = align === 'right' ? rect.right - w : rect.left
    left = Math.max(8, Math.min(left, window.innerWidth - w - 8))
    let top = rect.bottom + 6
    if (top + h > window.innerHeight - 8) top = Math.max(8, rect.top - h - 6)
    setStyle({ left, top })

    const onDown = (e: MouseEvent) => {
      const target = e.target as Node
      if (panelRef.current?.contains(target)) return
      if (triggerRef.current?.contains(target)) return
      setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    const onScroll = () => setOpen(false)
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    window.addEventListener('resize', onScroll)
    document.addEventListener('scroll', onScroll, true)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
      window.removeEventListener('resize', onScroll)
      document.removeEventListener('scroll', onScroll, true)
    }
  }, [open, align, width])

  return (
    <>
      {trigger({
        open,
        onClick: (e) => {
          e.preventDefault()
          e.stopPropagation()
          const element = e.currentTarget as HTMLElement
          triggerRef.current = element
          if (open) {
            setOpen(false)
            return
          }
          rectRef.current = element.getBoundingClientRect()
          setStyle({ opacity: 0, left: -9999, top: -9999 })
          setOpen(true)
        },
      })}
      {open &&
        createPortal(
          <div
            ref={panelRef}
            className="popover"
            style={style}
            role="menu"
            onMouseDown={(e) => e.stopPropagation()}
            onClick={(e) => e.stopPropagation()}
          >
            {typeof children === 'function' ? children(() => setOpen(false)) : children}
          </div>,
          document.body,
        )}
    </>
  )
}

/* -------------------------------------------------------------- dialog ---- */

export function Dialog({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  width = 430,
  className = '',
}: {
  open: boolean
  onClose: () => void
  title: string
  description?: string
  children?: ReactNode
  footer?: ReactNode
  width?: number
  className?: string
}) {
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null
  return createPortal(
    <div
      className="overlay"
      style={{ alignItems: 'center', padding: 20 }}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div
        className={`dialog ${className}`.trim()}
        style={{ width }}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(e) => e.stopPropagation()}
      >
        <h2>{title}</h2>
        {description ? <p>{description}</p> : null}
        {children}
        {footer ? <div className="dialog-actions">{footer}</div> : null}
      </div>
    </div>,
    document.body,
  )
}

/* --------------------------------------------------------------- toast ---- */

export type ToastItem = { id: number; text: string }

export function Toaster({ toasts }: { toasts: ToastItem[] }) {
  if (!toasts.length) return null
  return createPortal(
    <div className="toaster">
      {toasts.map((t) => (
        <div key={t.id} className="toast">
          <span className="status-dot" />
          {t.text}
        </div>
      ))}
    </div>,
    document.body,
  )
}
