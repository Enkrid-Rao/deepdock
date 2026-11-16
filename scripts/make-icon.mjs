// Renders build/icon.ico (multi-size) + build/icon.png + public/favicon.png
// from build/icon-source.png, using the local Chromium that ships with the
// dev dependencies (no native image libraries required).
//
// Replace build/icon-source.png (512×512 PNG with transparency) and re-run
// `npm run icon` to change the app icon.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright-core'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const BUILD = path.join(ROOT, 'build')
const SOURCE = path.join(BUILD, 'icon-source.png')

const SIZES = [16, 24, 32, 48, 64, 128, 256]

function chromiumPath() {
  const base = path.join(process.env.LOCALAPPDATA || '', 'ms-playwright')
  if (fs.existsSync(base)) {
    for (const dir of fs.readdirSync(base)) {
      if (!dir.startsWith('chromium-')) continue
      for (const candidate of ['chrome-win64/chrome.exe', 'chrome-win/chrome.exe']) {
        const full = path.join(base, dir, candidate)
        if (fs.existsSync(full)) return full
      }
    }
  }
  return undefined
}

function buildIco(images) {
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0)
  header.writeUInt16LE(1, 2)
  header.writeUInt16LE(images.length, 4)

  const entries = []
  let offset = 6 + 16 * images.length
  for (const image of images) {
    const entry = Buffer.alloc(16)
    entry.writeUInt8(image.size >= 256 ? 0 : image.size, 0)
    entry.writeUInt8(image.size >= 256 ? 0 : image.size, 1)
    entry.writeUInt8(0, 2)
    entry.writeUInt8(0, 3)
    entry.writeUInt16LE(1, 4)
    entry.writeUInt16LE(32, 6)
    entry.writeUInt32LE(image.png.length, 8)
    entry.writeUInt32LE(offset, 12)
    offset += image.png.length
    entries.push(entry)
  }

  return Buffer.concat([header, ...entries, ...images.map((i) => i.png)])
}

if (!fs.existsSync(SOURCE)) {
  console.error(`missing ${SOURCE} — put a 512×512 PNG there first`)
  process.exit(1)
}

const dataUrl = `data:image/png;base64,${fs.readFileSync(SOURCE).toString('base64')}`

const browser = await chromium.launch({ executablePath: chromiumPath(), headless: true })
const page = await browser.newPage({ deviceScaleFactor: 1 })

async function render(size) {
  await page.setViewportSize({ width: size, height: size })
  await page.setContent(
    `<html><body style="margin:0;background:transparent;overflow:hidden">
       <img src="${dataUrl}" width="${size}" height="${size}"
            style="display:block;width:${size}px;height:${size}px" />
     </body></html>`,
  )
  await page.waitForFunction(() => {
    const img = document.querySelector('img')
    return img && img.complete && img.naturalWidth > 0
  })
  return page.screenshot({ omitBackground: true, type: 'png' })
}

const images = []
for (const size of SIZES) images.push({ size, png: await render(size) })

const favicon = await render(64)

await browser.close()

fs.mkdirSync(BUILD, { recursive: true })
fs.mkdirSync(path.join(ROOT, 'public'), { recursive: true })
fs.writeFileSync(path.join(BUILD, 'icon.ico'), buildIco(images))
fs.writeFileSync(path.join(BUILD, 'icon.png'), images[images.length - 1].png)
fs.writeFileSync(path.join(ROOT, 'public', 'favicon.png'), favicon)
console.log(`icon.ico (${SIZES.join('/')}) + icon.png + favicon.png written`)
