import { useEffect, useMemo, useRef, useState, type RefObject } from 'react'
import type { Message } from '../lib/types'

function preview(content: string): string {
  const text = content
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/[`*_>#~|-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return text || '（空白消息）'
}

/**
 * Turn navigator on the right of the thread, like chat.deepseek.com: one bar per
 * user turn; hovering a bar reveals the question text, clicking jumps there.
 */
export function TurnNav({
  messages,
  scrollerRef,
}: {
  messages: Message[]
  scrollerRef: RefObject<HTMLDivElement | null>
}) {
  const turns = useMemo(
    () => messages.filter((message) => message.role === 'user').map((message) => message),
    [messages],
  )
  const [active, setActive] = useState(0)
  const frameRef = useRef(0)
  const signature = turns.map((turn) => turn.id).join(',')

  useEffect(() => {
    const scroller = scrollerRef.current
    if (!scroller || turns.length < 2) return undefined

    const update = () => {
      const threshold = scroller.getBoundingClientRect().top + 90
      let next = 0
      turns.forEach((turn, index) => {
        const node = scroller.querySelector<HTMLElement>(`[data-message-id="${turn.id}"]`)
        if (node && node.getBoundingClientRect().top <= threshold) next = index
      })
      setActive(next)
    }
    const onScroll = () => {
      if (frameRef.current) return
      frameRef.current = requestAnimationFrame(() => {
        frameRef.current = 0
        update()
      })
    }

    update()
    scroller.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      scroller.removeEventListener('scroll', onScroll)
      if (frameRef.current) cancelAnimationFrame(frameRef.current)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scrollerRef, signature])

  if (turns.length < 2) return null

  const jump = (id: string, index: number) => {
    const node = scrollerRef.current?.querySelector<HTMLElement>(`[data-message-id="${id}"]`)
    node?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    setActive(index)
  }

  return (
    <nav className="turn-nav" aria-label="对话轮次">
      {turns.map((turn, index) => {
        const label = preview(turn.content)
        return (
          <button
            key={turn.id}
            type="button"
            className="turn-nav-row"
            data-active={index === active}
            onClick={() => jump(turn.id, index)}
            aria-label={`跳转到第 ${index + 1} 轮：${label.slice(0, 60)}`}
          >
            <span className="turn-nav-label">{label}</span>
            <span className="turn-nav-hit">
              <span className="turn-nav-bar" />
            </span>
          </button>
        )
      })}
    </nav>
  )
}
