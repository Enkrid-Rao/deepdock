// Read the DeepSeek web session token straight out of a Chromium-based browser
// profile on disk.
//
// How it works, in one paragraph: `localStorage` is not a cookie and not a file
// per origin. Chromium keeps it in a LevelDB database at
// `<profile>/Local Storage/leveldb`. The values live in two kinds of files:
//
//   *.ldb / *.sst  sorted tables — blocks are often Snappy-compressed
//   *.log          write-ahead log — uncompressed records of recent writes
//
// We parse both (LevelDB's table footer + block format, and the WAL record
// format), decompress Snappy blocks, and keep the newest version of the record
// whose key is `_https://chat.deepseek.com\0\1userToken`. Nothing is decrypted:
// the token is stored in the clear by Chromium. No extension, no DevTools
// protocol, no cookie-jar access, no network call.

import fs from 'node:fs'
import path from 'node:path'

const TABLE_MAGIC = Buffer.from('57fb808b247547db', 'hex')
const LOG_BLOCK = 32768
const LOG_HEADER = 7
const USER_TOKEN_KEY = 'userToken'

/** Chromium-based browsers, in the order we prefer to report them. */
const BROWSERS = [
  { id: 'chrome', name: 'Chrome', root: () => underLocal('Google', 'Chrome', 'User Data') },
  { id: 'edge', name: 'Edge', root: () => underLocal('Microsoft', 'Edge', 'User Data') },
  { id: 'brave', name: 'Brave', root: () => underLocal('BraveSoftware', 'Brave-Browser', 'User Data') },
  { id: 'vivaldi', name: 'Vivaldi', root: () => underLocal('Vivaldi', 'User Data') },
  { id: 'chromium', name: 'Chromium', root: () => underLocal('Chromium', 'User Data') },
  { id: 'opera', name: 'Opera', root: () => underRoaming('Opera Software', 'Opera Stable') },
]

function underLocal(...parts) {
  const base = process.env.LOCALAPPDATA
  return base ? path.join(base, ...parts) : ''
}

function underRoaming(...parts) {
  const base = process.env.APPDATA
  return base ? path.join(base, ...parts) : ''
}

/* ----------------------------------------------------------------- snappy */

/**
 * Decompress a raw Snappy block (the format LevelDB uses for table blocks).
 * Literals and the three copy encodings are all implemented; copies may
 * overlap, which is how Snappy encodes runs.
 */
export function snappyDecompress(input) {
  let pos = 0
  let length = 0
  let shift = 0
  let byte
  do {
    if (pos >= input.length) throw new Error('snappy: truncated length')
    byte = input[pos++]
    length += (byte & 0x7f) * 2 ** shift
    shift += 7
  } while (byte & 0x80)

  if (length > 256 * 1024 * 1024) throw new Error('snappy: block too large')
  const out = Buffer.allocUnsafe(length)
  let written = 0

  while (pos < input.length && written < length) {
    const tag = input[pos++]
    const kind = tag & 0x03
    if (kind === 0) {
      let literal = (tag >> 2) + 1
      if (literal > 60) {
        const extra = literal - 60
        literal = 0
        for (let i = 0; i < extra; i += 1) literal += input[pos++] * 2 ** (8 * i)
        literal += 1
      }
      if (pos + literal > input.length || written + literal > length) {
        throw new Error('snappy: literal out of range')
      }
      input.copy(out, written, pos, pos + literal)
      pos += literal
      written += literal
      continue
    }

    let count
    let offset
    if (kind === 1) {
      count = ((tag >> 2) & 0x07) + 4
      offset = ((tag >> 5) << 8) | input[pos++]
    } else if (kind === 2) {
      count = (tag >> 2) + 1
      offset = input.readUInt16LE(pos)
      pos += 2
    } else {
      count = (tag >> 2) + 1
      offset = input.readUInt32LE(pos)
      pos += 4
    }
    if (!offset || offset > written || written + count > length) {
      throw new Error('snappy: bad copy')
    }
    for (let i = 0; i < count; i += 1) out[written + i] = out[written - offset + i]
    written += count
  }

  if (written !== length) throw new Error('snappy: length mismatch')
  return out
}

/* ------------------------------------------------------------- leveldb io */

function readVarint(buf, state) {
  let result = 0
  let shift = 0
  let byte
  do {
    if (state.pos >= buf.length) throw new Error('varint: truncated')
    byte = buf[state.pos++]
    result += (byte & 0x7f) * 2 ** shift
    shift += 7
    if (shift > 42) throw new Error('varint: too long')
  } while (byte & 0x80)
  return result
}

function readBlockHandle(buf, state) {
  return { offset: readVarint(buf, state), size: readVarint(buf, state) }
}

function readBlock(file, handle) {
  const end = handle.offset + handle.size
  if (end + 5 > file.length) throw new Error('block out of range')
  const raw = file.subarray(handle.offset, end)
  const compression = file[end]
  if (compression === 0) return raw
  if (compression === 1) return snappyDecompress(raw)
  throw new Error(`unsupported block compression: ${compression}`)
}

function* blockEntries(block) {
  if (block.length < 4) return
  const restarts = block.readUInt32LE(block.length - 4)
  const restartBytes = restarts * 4
  if (restartBytes + 4 > block.length) throw new Error('bad restart array')
  const limit = block.length - 4 - restartBytes
  const state = { pos: 0 }
  let lastKey = Buffer.alloc(0)

  while (state.pos < limit) {
    const shared = readVarint(block, state)
    const nonShared = readVarint(block, state)
    const valueLength = readVarint(block, state)
    if (shared > lastKey.length || state.pos + nonShared + valueLength > block.length) break
    const key = Buffer.concat([
      lastKey.subarray(0, shared),
      block.subarray(state.pos, state.pos + nonShared),
    ])
    state.pos += nonShared
    const value = block.subarray(state.pos, state.pos + valueLength)
    state.pos += valueLength
    lastKey = key
    yield { key, value }
  }
}

/**
 * Walk a LevelDB sorted table and yield `{ key, value, seq, deleted }` where
 * `key` is the *user* key (the 8-byte internal tag is stripped).
 */
function* tableRecords(file) {
  if (file.length < 48) return
  if (!file.subarray(file.length - 8).equals(TABLE_MAGIC)) return

  const footer = file.subarray(file.length - 48, file.length - 8)
  const state = { pos: 0 }
  readBlockHandle(footer, state) // metaindex (not needed)
  const indexHandle = readBlockHandle(footer, state)
  const index = readBlock(file, indexHandle)

  for (const entry of blockEntries(index)) {
    const handleState = { pos: 0 }
    let dataHandle
    try {
      dataHandle = readBlockHandle(entry.value, handleState)
    } catch {
      continue
    }
    let data
    try {
      data = readBlock(file, dataHandle)
    } catch {
      continue
    }
    for (const item of blockEntries(data)) {
      if (item.key.length < 8) continue
      const tag = item.key.readBigUInt64LE(item.key.length - 8)
      const seq = Number(tag >> 8n)
      const type = Number(tag & 0xffn)
      const userKey = item.key.subarray(0, item.key.length - 8)
      yield { key: userKey, value: type === 1 ? item.value : null, seq, deleted: type !== 1 }
    }
  }
}

/** Parse LevelDB write-ahead-log records into write-batch operations. */
function* logRecords(file) {
  let pos = 0
  let fragments = []

  while (pos + LOG_HEADER <= file.length) {
    const blockOffset = pos % LOG_BLOCK
    if (blockOffset > LOG_BLOCK - LOG_HEADER) {
      pos += LOG_BLOCK - blockOffset
      continue
    }
    const length = file.readUInt16LE(pos + 4)
    const type = file[pos + 6]
    const start = pos + LOG_HEADER

    if (type === 0 && length === 0) {
      pos = start
      continue
    }
    if (start + length > file.length) break
    const payload = file.subarray(start, start + length)
    pos = start + length

    if (type === 1) {
      fragments = [payload]
    } else if (type === 2) {
      fragments = [payload]
      continue
    } else if (type === 3) {
      fragments.push(payload)
      continue
    } else if (type === 4) {
      fragments.push(payload)
      yield* parseWriteBatch(Buffer.concat(fragments))
      fragments = []
      continue
    } else {
      fragments = []
      continue
    }
    yield* parseWriteBatch(payload)
  }
}

function* parseWriteBatch(batch) {
  if (batch.length < 12) return
  const sequence = Number(batch.readBigUInt64LE(0))
  const count = batch.readUInt32LE(8)
  const state = { pos: 12 }
  for (let i = 0; i < count; i += 1) {
    if (state.pos >= batch.length) return
    const type = batch[state.pos++]
    let key
    try {
      const keyLength = readVarint(batch, state)
      key = batch.subarray(state.pos, state.pos + keyLength)
      state.pos += keyLength
    } catch {
      return
    }
    if (type === 1) {
      let value
      try {
        const valueLength = readVarint(batch, state)
        value = batch.subarray(state.pos, state.pos + valueLength)
        state.pos += valueLength
      } catch {
        return
      }
      yield { key, value, seq: sequence + i, deleted: false }
    } else {
      yield { key, value: null, seq: sequence + i, deleted: true }
    }
  }
}

/* --------------------------------------------------------- localstorage */

function originOf(userTokenKey) {
  if (!userTokenKey.startsWith('_http')) return null
  const nul = userTokenKey.indexOf('\u0000')
  if (nul < 4) return null
  const origin = userTokenKey.slice(1, nul)
  let rest = userTokenKey.slice(nul + 1)
  if (rest.startsWith('\u0001')) rest = rest.slice(1)
  if (rest !== USER_TOKEN_KEY) return null
  try {
    const url = new URL(origin)
    if (url.hostname !== 'chat.deepseek.com') return null
    return url.origin
  } catch {
    return null
  }
}

/** Chromium prefixes each localStorage value with its encoding. */
export function decodeStorageValue(value) {
  if (!value || value.length === 0) return ''
  const prefix = value[0]
  const body = value.subarray(1)
  if (prefix === 0) {
    let text = body.toString('utf16le')
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)
    return text
  }
  if (prefix === 1) return body.toString('utf8')
  return value.toString('utf8')
}

const TOKEN_RE = /^[A-Za-z0-9+/=_.~-]{20,400}$/

/**
 * DeepSeek stores `{"value":"<token>","__version":"0"}`. Older/odd builds used
 * a JSON array; raw strings show up too. Return the token, or ''.
 */
export function tokenFromStorageValue(raw) {
  const text = decodeStorageValue(raw).replace(/\u0000+$/g, '').trim()
  if (!text) return ''
  const clean = (value) => {
    const token = String(value).trim().replace(/^Bearer\s+/i, '').replace(/^["']|["']$/g, '')
    return TOKEN_RE.test(token) ? token : ''
  }
  try {
    const parsed = JSON.parse(text)
    if (typeof parsed === 'string') return clean(parsed)
    if (Array.isArray(parsed)) {
      for (const item of parsed) {
        const token = typeof item === 'string' ? clean(item) : ''
        if (token) return token
      }
      return ''
    }
    if (parsed && typeof parsed === 'object') {
      return clean(parsed.value ?? parsed.token ?? parsed.userToken ?? '')
    }
  } catch {
    /* not JSON — fall through */
  }
  if (text.startsWith('{') || text.startsWith('[')) return ''
  return clean(text)
}

/* --------------------------------------------------------------- scanning */

function profileDirs(userDataDir) {
  const out = []
  let entries = []
  try {
    entries = fs.readdirSync(userDataDir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    if (!(entry.name === 'Default' || /^Profile \d+$/.test(entry.name) || entry.name === 'Guest Profile')) {
      continue
    }
    const dir = path.join(userDataDir, entry.name, 'Local Storage', 'leveldb')
    if (fs.existsSync(dir)) out.push({ profile: entry.name, dir })
  }
  // Fallback: the root itself can be a Chromium profile (custom user-data-dir).
  const rootStore = path.join(userDataDir, 'Local Storage', 'leveldb')
  if (!out.length && fs.existsSync(rootStore)) out.push({ profile: 'Default', dir: rootStore })
  return out
}

function scanProfile(dir) {
  const latest = new Map() // user key -> { seq, value, deleted, file, mtime }
  const stats = { files: 0, records: 0, tables: 0, logs: 0 }
  let names = []
  try {
    names = fs.readdirSync(dir)
  } catch {
    return { latest, stats }
  }

  for (const name of names) {
    if (!/\.(ldb|sst|log)$/i.test(name)) continue
    const file = path.join(dir, name)
    let buffer
    let mtime = 0
    try {
      buffer = fs.readFileSync(file)
      mtime = fs.statSync(file).mtimeMs
    } catch {
      continue // locked or vanished between readdir and read
    }
    if (!buffer.length) continue
    stats.files += 1
    const isLog = /\.log$/i.test(name)
    if (isLog) stats.logs += 1
    else stats.tables += 1

    let iterator
    try {
      iterator = isLog ? logRecords(buffer) : tableRecords(buffer)
      for (const record of iterator) {
        stats.records += 1
        const userKey = record.key.toString('latin1')
        if (!originOf(userKey)) continue
        const previous = latest.get(userKey)
        if (previous && previous.seq > record.seq) continue
        latest.set(userKey, {
          seq: record.seq,
          value: record.deleted ? null : record.value,
          deleted: record.deleted,
          file: name,
          mtime,
        })
      }
    } catch {
      /* corrupt table/log: keep whatever we already parsed */
    }
  }
  return { latest, stats }
}

/**
 * Scan every Chromium profile we know about and return DeepSeek `userToken`
 * candidates, newest first. No token is ever written to disk or logged.
 */
export function scanBrowserTokens({ browsers = BROWSERS } = {}) {
  const candidates = []
  const scanned = []
  const errors = []
  const seen = new Set()

  for (const browser of browsers) {
    let root = ''
    try {
      root = typeof browser.root === 'function' ? browser.root() : browser.root
    } catch {
      continue
    }
    if (!root || !fs.existsSync(root)) continue

    const profiles = profileDirs(root)
    for (const { profile, dir } of profiles) {
      let result
      try {
        result = scanProfile(dir)
      } catch (err) {
        errors.push({ browser: browser.name, profile, message: err.message })
        continue
      }
      const source = `${browser.name} · ${profile}`
      let tokens = 0
      for (const [userKey, record] of result.latest) {
        if (!record.value) continue
        const token = tokenFromStorageValue(record.value)
        if (!token) continue
        tokens += 1
        const origin = originOf(userKey) || 'https://chat.deepseek.com'
        const key = `${token}`
        const item = {
          token,
          source,
          browser: browser.name,
          profile,
          origin,
          file: record.file,
          updatedAt: Math.round(record.mtime),
        }
        const previous = seen.has(key) ? candidates.find((c) => c.token === key) : null
        if (previous) {
          if (!previous.sources.includes(source)) previous.sources.push(source)
          continue
        }
        seen.add(key)
        item.sources = [source]
        candidates.push(item)
      }
      scanned.push({
        browser: browser.name,
        profile,
        dir,
        files: result.stats.files,
        records: result.stats.records,
        tokens,
      })
    }
  }

  // Chrome/Edge first, then the freshest profile within the same browser.
  const order = new Map(BROWSERS.map((b, i) => [b.name, i]))
  candidates.sort((a, b) => {
    const byBrowser = (order.get(a.browser) ?? 99) - (order.get(b.browser) ?? 99)
    if (byBrowser) return byBrowser
    return (b.updatedAt || 0) - (a.updatedAt || 0)
  })

  return { candidates, scanned, errors }
}

/** Convenience wrapper used by the Electron IPC layer. */
export function findChatTokens() {
  const { candidates, scanned, errors } = scanBrowserTokens()
  return {
    found: candidates.length,
    candidates,
    scanned,
    errors,
  }
}
