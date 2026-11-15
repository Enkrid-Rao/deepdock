// Smoke test for the desktop shell (dev or packaged).
//   npx electron . --remote-debugging-port=9222        (or DeepDock.exe …)
//   node scripts/desktop-smoke.mjs
// env: CDP=http://127.0.0.1:9222  SMOKE_SHELL_ONLY=1

import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright-core'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const OUT = path.join(ROOT, 'docs')
const SHELL_ONLY = process.env.SMOKE_SHELL_ONLY === '1'
let failed = 0

const browser = await chromium.connectOverCDP(process.env.CDP || 'http://127.0.0.1:9222')
const context = browser.contexts()[0]
const page = context.pages()[0] || (await context.waitForEvent('page'))

const errors = []
page.on('pageerror', (e) => errors.push(e.message.slice(0, 200)))
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text().slice(0, 200))
})

const check = (name, ok, extra = '') => {
  if (!ok) failed += 1
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? ' — ' + extra : ''}`)
}

console.log('url:', page.url())
check('桌面桥接可用', await page.evaluate(() => Boolean(window.deepdockDesktop)))
check('data-desktop 标记', (await page.evaluate(() => document.documentElement.dataset.desktop)) === 'true')

await page.waitForTimeout(700)
const hasConnect = (await page.locator('.connect-card').count()) > 0

if (SHELL_ONLY) {
  check('连接页已渲染', hasConnect)
  await page.screenshot({ path: path.join(OUT, 'shot-desktop-connect.png') })
  console.log('JS ERRORS:', errors.length ? errors : 'none')
  await browser.close()
  process.exit(failed ? 1 : 0)
}

if (hasConnect) {
  await page.fill('#token', '{"value":"mock","__version":"0"}')
  await page.getByRole('button', { name: '连接 DeepSeek' }).click()
  await page.waitForTimeout(1000)
}

check('进入主界面', await page.locator('.sidebar').isVisible())

if (!(await page.locator('.project-row').count())) {
  await page.getByTitle('新建项目').click()
  await page.waitForTimeout(250)
  await page.fill('.dialog input', '论文')
  await page.locator('.swatch').nth(1).click()
  await page.getByRole('button', { name: '创建' }).click()
  await page.waitForTimeout(450)
}

check('项目已建立', (await page.locator('.project-row').count()) >= 1)

if (!(await page.locator('.conv-row').count())) {
  await page.locator('.project-row').first().locator('.row-more').click({ force: true })
  await page.waitForTimeout(300)
  await page.getByRole('button', { name: '在此项目新建对话' }).click()
  await page.waitForTimeout(450)
}

await page.fill('.composer textarea', '帮我把「项目分组」这件事讲清楚，顺便给一个 markdown 示例。')
await page.keyboard.press('Enter')
await page.waitForTimeout(1200)
await page.screenshot({ path: path.join(OUT, 'shot-desktop-streaming.png') })
await page.waitForTimeout(3200)
await page.screenshot({ path: path.join(OUT, 'shot-desktop.png') })

check('助手回复已渲染', (await page.locator('.msg-assistant .prose').count()) >= 1)
check('侧栏有对话', (await page.locator('.conv-row').count()) >= 1)

console.log('shell info:', await page.evaluate(() => window.deepdockDesktop?.info()))
console.log('JS ERRORS:', errors.length ? errors : 'none')
await browser.close()
process.exit(failed ? 1 : 0)
