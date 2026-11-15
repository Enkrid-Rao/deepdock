// Diagnose "从浏览器读取登录凭证" without exposing the token.
//
//   node scripts/check-auth.mjs             # scan only
//   node scripts/check-auth.mjs --validate  # also ask DeepSeek whether each token is alive
//
// Prints which Chromium profile was read, how many LevelDB records were parsed,
// and a short fingerprint for each candidate token (never the token itself).

import crypto from 'node:crypto'
import { scanBrowserTokens } from '../server/lib/browser-tokens.js'

const validate = process.argv.includes('--validate')
const json = process.argv.includes('--json')
const started = Date.now()
const scan = scanBrowserTokens()
const elapsed = Date.now() - started

const fingerprint = (token) => crypto.createHash('sha256').update(token).digest('hex').slice(0, 10)

async function probe(token) {
  try {
    const res = await fetch('https://chat.deepseek.com/api/v0/users/current', {
      method: 'GET',
      headers: {
        authorization: `Bearer ${token}`,
        accept: '*/*',
        origin: 'https://chat.deepseek.com',
        referer: 'https://chat.deepseek.com/',
        'user-agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
        'x-client-platform': 'web',
        'x-client-version': '1.0.0',
        'x-client-locale': 'zh_CN',
        'x-client-bundle-id': 'com.deepseek.chat',
      },
    })
    const payload = await res.json().catch(() => null)
    return {
      http: res.status,
      ok: payload?.code === 0,
      message: payload?.code === 0 ? 'valid' : payload?.msg || `code ${payload?.code ?? '?'}`,
    }
  } catch (err) {
    return { http: 0, ok: false, message: err.message }
  }
}

const candidates = []
for (const item of scan.candidates) {
  const row = {
    source: item.source,
    sources: item.sources,
    foundIn: item.file,
    updatedAt: new Date(item.updatedAt).toISOString(),
    length: item.token.length,
    fingerprint: fingerprint(item.token),
  }
  if (validate) row.validation = await probe(item.token)
  candidates.push(row)
}

const report = {
  elapsedMs: elapsed,
  profiles: scan.scanned.map((item) => ({
    browser: item.browser,
    profile: item.profile,
    files: item.files,
    records: item.records,
    tokens: item.tokens,
  })),
  candidates,
  errors: scan.errors,
}

if (json) {
  console.log(JSON.stringify(report, null, 2))
} else {
  console.log(`\n扫描完成，用时 ${elapsed} ms`)
  console.log(`读取了 ${report.profiles.length} 个浏览器配置：`)
  for (const item of report.profiles) {
    console.log(
      `  ${item.browser} · ${item.profile}  files=${item.files} records=${item.records} userToken=${item.tokens}`,
    )
  }
  if (!candidates.length) {
    console.log('\n没有找到 chat.deepseek.com 的 userToken。')
    console.log('请确认：浏览器里确实登录了 chat.deepseek.com（不是无痕窗口），并至少刷新一次页面。')
  } else {
    console.log(`\n找到 ${candidates.length} 份 userToken：`)
    for (const item of candidates) {
      const verdict = item.validation
        ? item.validation.ok
          ? '✓ 有效'
          : `✗ ${item.validation.message}`
        : '（未校验）'
      console.log(
        `  ${item.source.padEnd(20)} sha256:${item.fingerprint}  ${new Date(item.updatedAt).toLocaleString()}  ${verdict}`,
      )
    }
    if (!validate) console.log('\n加 --validate 可以顺便确认 token 是否还有效。')
  }
  if (report.errors.length) {
    console.log('\n读取出错的文件：')
    for (const item of report.errors) console.log(`  ${item.browser} · ${item.profile}: ${item.message}`)
  }
  console.log('')
}
