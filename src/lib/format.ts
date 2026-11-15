const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

export function relativeTime(ts: number): string {
  if (!ts) return ''
  const diff = Date.now() - ts
  if (diff < MINUTE) return '刚刚'
  if (diff < HOUR) return `${Math.floor(diff / MINUTE)} 分钟前`
  if (diff < DAY) return `${Math.floor(diff / HOUR)} 小时前`
  if (diff < 7 * DAY) return `${Math.floor(diff / DAY)} 天前`
  const d = new Date(ts)
  const now = new Date()
  if (d.getFullYear() === now.getFullYear()) return `${d.getMonth() + 1} 月 ${d.getDate()} 日`
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`
}

export function dayLabel(ts: number): string {
  const d = new Date(ts)
  const now = new Date()
  const sameDay = d.toDateString() === now.toDateString()
  if (sameDay) return '今天'
  const yesterday = new Date(now.getTime() - DAY)
  if (d.toDateString() === yesterday.toDateString()) return '昨天'
  return `${d.getMonth() + 1} 月 ${d.getDate()} 日`
}

export function initials(user: { name?: string | null; email?: string | null; mobile?: string | null } | null): string {
  if (!user) return 'D'
  const source = user.name || user.email || user.mobile || 'D'
  return source.trim().slice(0, 1).toUpperCase()
}

export function displayName(
  user: { name?: string | null; email?: string | null; mobile?: string | null } | null,
): string {
  if (!user) return '未连接'
  if (user.name) return user.name
  if (user.email) return user.email.replace(/@.*/, '')
  if (user.mobile) return user.mobile.replace(/^(\d{3})\d+(\d{4})$/, '$1****$2')
  return 'DeepSeek 用户'
}

export function clampText(text: string, max = 60): string {
  const clean = text.replace(/\s+/g, ' ').trim()
  return clean.length > max ? `${clean.slice(0, max)}…` : clean
}
