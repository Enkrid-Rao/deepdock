// Renders build/icon.ico (multi-size) and build/icon.png from the DeepDock mark.
// Uses the local Chromium that ships with the dev dependencies.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright-core'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const BUILD = path.join(ROOT, 'build')

const SIZES = [16, 24, 32, 48, 64, 128, 256]

const SVG = `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="100%" height="100%">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#18806c"/>
      <stop offset="1" stop-color="#0b4a3f"/>
    </linearGradient>
  </defs>
  <rect width="64" height="64" rx="15" fill="url(#g)"/>
  <g stroke="#f7fdfa" stroke-width="3.4" stroke-linecap="round" fill="none">
    <path d="M13 24c4 0 4-4.4 8-4.4s4 4.4 8 4.4 4-4.4 8-4.4 4 4.4 8 4.4"/>
    <path d="M13 34c4 0 4-4.4 8-4.4s4 4.4 8 4.4 4-4.4 8-4.4 4 4.4 8 4.4" opacity=".78"/>
    <path d="M13 44c4 0 4-4.4 8-4.4s4 4.4 8 4.4 4-4.4 8-4.4 4 4.4 8 4.4" opacity=".5"/>
  </g>
</svg>`

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

fs.mkdirSync(BUILD, { recursive: true })

const executablePath = chromiumPath()
const browser = await chromium.launch({ executablePath, headless: true })
const page = await browser.newPage({ deviceScaleFactor: 1 })

const images = []
for (const size of SIZES) {
  await page.setViewportSize({ width: size, height: size })
  await page.setContent(
    `<html><body style="margin:0;background:transparent">${SVG.replace('width="100%" height="100%"', `width="${size}" height="${size}"`)}</body></html>`,
  )
  const buffer = await page.screenshot({ omitBackground: true, type: 'png' })
  images.push({ size, png: buffer })
}

await browser.close()

fs.writeFileSync(path.join(BUILD, 'icon.ico'), buildIco(images))
const png512 = images[images.length - 1].png
fs.writeFileSync(path.join(BUILD, 'icon.png'), png512)
fs.writeFileSync(path.join(ROOT, 'public', 'favicon.svg'), `${SVG.trim()}\n`)
console.log(`icon.ico (${SIZES.join('/')}) + icon.png written`)
