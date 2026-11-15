// DeepSeek proof-of-work solver.
//
// DeepSeek's web client solves a SHA3 based proof-of-work before every chat
// completion. The heavy lifting happens inside a tiny (26 KB) WASM module that
// the site itself ships. We vendor that module and drive it directly, which
// keeps this implementation fast and byte-for-byte compatible.

import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const LOCAL_WASM = path.join(HERE, 'sha3.wasm')

let instance = null

export function isReady() {
  return instance !== null
}

export async function loadWasm(file = LOCAL_WASM) {
  const bytes = await fsp.readFile(file)
  const { instance: inst } = await WebAssembly.instantiate(bytes, {})
  instance = inst
  return inst
}

function writeString(str) {
  const bytes = new TextEncoder().encode(str)
  const ptr = instance.exports.__wbindgen_export_0(bytes.length, 1)
  new Uint8Array(instance.exports.memory.buffer, ptr, bytes.length).set(bytes)
  return { ptr, len: bytes.length }
}

/** Solve a challenge. Returns the integer answer, or null if it failed. */
export function solve(challenge, salt, expireAt, difficulty) {
  if (!instance) throw new Error('pow: wasm module is not loaded')
  const prefix = `${salt}_${expireAt}_`
  const retptr = instance.exports.__wbindgen_add_to_stack_pointer(-16)
  try {
    const c = writeString(String(challenge))
    const p = writeString(prefix)
    instance.exports.wasm_solve(
      retptr,
      c.ptr,
      c.len,
      p.ptr,
      p.len,
      Number(difficulty),
    )
    const view = new DataView(instance.exports.memory.buffer)
    const status = view.getInt32(retptr, true)
    if (status === 0) return null
    const value = view.getFloat64(retptr + 8, true)
    if (!Number.isFinite(value)) return null
    return Math.floor(value)
  } finally {
    instance.exports.__wbindgen_add_to_stack_pointer(16)
  }
}

/**
 * Try to repair a stale solver by pulling the current wasm file from
 * chat.deepseek.com. The module filename contains a content hash, so we read
 * the site's entry bundle and look for `sha3_wasm_bg.<hash>.wasm`.
 */
export async function refreshWasmFromRemote(log = () => {}) {
  const indexRes = await fetch('https://chat.deepseek.com/', {
    headers: { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36' },
  })
  const html = await indexRes.text()
  const scripts = [...html.matchAll(/src="([^"]+main\.[0-9a-f]+\.js)"/g)].map((m) => m[1])
  for (const src of scripts) {
    const res = await fetch(new URL(src, 'https://chat.deepseek.com/'))
    const js = await res.text()
    const hit = js.match(/(?:static\/)?sha3_wasm_bg\.[0-9a-f]+\.wasm/)
    if (!hit) continue
    const url = new URL(hit[0], 'https://fe-static.deepseek.com/chat/')
    log(`pow: refreshing wasm from ${url.href}`)
    const wasm = await fetch(url.href)
    const buf = Buffer.from(await wasm.arrayBuffer())
    await fsp.writeFile(LOCAL_WASM, buf)
    await loadWasm(LOCAL_WASM)
    return true
  }
  return false
}

/** Build the `x-ds-pow-response` header value. */
export function buildPowHeader(challenge, answer, targetPath) {
  const payload = {
    algorithm: challenge.algorithm,
    challenge: challenge.challenge,
    salt: challenge.salt,
    answer,
    signature: challenge.signature,
    target_path: challenge.target_path || targetPath,
  }
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64')
}

export { LOCAL_WASM }
