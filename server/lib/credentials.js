// Account credentials — the one file in `data/` that holds secrets.
// It is written with 0600 permissions and never leaves the machine.

import fs from 'node:fs/promises'
import path from 'node:path'

const DEFAULTS = { cookie: '', token: '', user: null, source: '', savedAt: null }

export function normalizeCookie(input) {
  if (!input) return ''
  let raw = String(input).trim()
  if (!raw) return ''

  // A pasted `curl` snippet or "Cookie:" header line is common enough.
  const headerMatch = raw.match(/cookie\s*:\s*([^\n\r]+)/i)
  if (headerMatch) raw = headerMatch[1]
  if (raw.startsWith('{')) {
    try {
      const parsed = JSON.parse(raw)
      if (typeof parsed.cookie === 'string') raw = parsed.cookie
      else if (Array.isArray(parsed)) {
        raw = parsed.map((c) => `${c.name}=${c.value}`).join('; ')
      }
    } catch {
      /* keep as-is */
    }
  }
  return raw
    .split(/;\s*/)
    .map((part) => part.trim())
    .filter((part) => part && part.includes('='))
    .join('; ')
}

export function normalizeToken(input) {
  if (!input) return ''
  let raw = String(input).trim()
  if (!raw) return ''
  if (raw.startsWith('{')) {
    try {
      const parsed = JSON.parse(raw)
      raw = String(parsed.value ?? parsed.token ?? parsed.userToken ?? '')
    } catch {
      /* keep as-is */
    }
  }
  raw = raw.replace(/^Bearer\s+/i, '').replace(/^["']|["']$/g, '').trim()
  if (raw.includes('userToken=') || raw.includes(';')) {
    const m = raw.match(/userToken[=:]\s*["']?([A-Za-z0-9._~-]+)/)
    if (m) raw = m[1]
  }
  return raw
}

export class Credentials {
  constructor(dataDir) {
    this.file = path.join(dataDir, 'credentials.json')
    this.value = { ...DEFAULTS }
  }

  async init() {
    try {
      const raw = await fs.readFile(this.file, 'utf8')
      this.value = { ...DEFAULTS, ...JSON.parse(raw) }
    } catch (err) {
      if (err.code !== 'ENOENT') console.warn('[credentials] could not read file:', err.message)
    }
    return this
  }

  get cookie() {
    return this.value.cookie || ''
  }

  get token() {
    return this.value.token || ''
  }

  get user() {
    return this.value.user || null
  }

  get connected() {
    return Boolean(this.value.token)
  }

  async save(patch) {
    this.value = { ...this.value, ...patch, savedAt: this.value.savedAt || Date.now() }
    await fs.mkdir(path.dirname(this.file), { recursive: true })
    await fs.writeFile(this.file, JSON.stringify(this.value, null, 2), { mode: 0o600 })
    return this.value
  }

  async clear() {
    this.value = { ...DEFAULTS }
    await fs.rm(this.file, { force: true })
  }
}
