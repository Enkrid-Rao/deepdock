// Builds the Windows desktop app into release/DeepDock-win32-x64/.
// Usage: npm run package

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execSync } from 'node:child_process'
import packager from '@electron/packager'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const RELEASE = path.join(ROOT, 'release')

console.log('› building renderer…')
execSync('npm run build', { cwd: ROOT, stdio: 'inherit' })

if (!fs.existsSync(path.join(ROOT, 'build', 'icon.ico'))) {
  console.log('› generating icon…')
  execSync(`"${process.execPath}" "${path.join(HERE, 'make-icon.mjs')}"`, {
    cwd: ROOT,
    stdio: 'inherit',
  })
}

console.log('› packaging…')
const electronVersion = JSON.parse(
  fs.readFileSync(path.join(ROOT, 'node_modules', 'electron', 'package.json'), 'utf8'),
).version

// Prefer the Electron zip already in @electron/get's cache. Windows machines
// often cannot reach github.com, and the cache is populated by npm install.
function cachedElectronZipDir() {
  const cache = path.join(process.env.LOCALAPPDATA || '', 'electron', 'Cache')
  if (!fs.existsSync(cache)) return undefined
  for (const entry of fs.readdirSync(cache)) {
    const zip = path.join(cache, entry, `electron-v${electronVersion}-win32-x64.zip`)
    if (fs.existsSync(zip)) return path.dirname(zip)
  }
  return undefined
}

const electronZipDir = cachedElectronZipDir()
if (electronZipDir) console.log(`  electron zip → ${electronZipDir}`)

const paths = await packager({
  dir: ROOT,
  out: RELEASE,
  name: 'DeepDock',
  executableName: 'DeepDock',
  platform: 'win32',
  arch: 'x64',
  icon: path.join(ROOT, 'build', 'icon.ico'),
  appVersion: '1.0.0',
  overwrite: true,
  prune: true,
  asar: false,
  ...(electronZipDir ? { electronZipDir } : {}),
  ignore: [
    /^\/src($|\/)/,
    /^\/docs($|\/)/,
    /^\/scripts($|\/)/,
    /^\/release($|\/)/,
    /^\/data($|\/)/,
    /^\/public($|\/)/,
    /^\/build($|\/)/,
    /^\/desktop-shot\.png$/,
    /^\/\.gitignore$/,
    /^\/README\.md$/,
    /^\/tsconfig\.json$/,
    /^\/vite\.config\.ts$/,
  ],
})

console.log('\n✔ packaged:')
for (const p of paths) console.log('  ' + p)
