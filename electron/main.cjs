// Electron shell for DeepDock.
// Runs the DeepDock API in-process on a random loopback port, then opens a
// window on it. No Node integration in the renderer, no remote content.

const { app, BrowserWindow, ipcMain, shell, dialog, nativeTheme } = require('electron')
const path = require('node:path')
const fs = require('node:fs')
const { pathToFileURL } = require('node:url')

const ROOT = path.resolve(__dirname, '..')
const IS_DEV = !app.isPackaged

let mainWindow = null
let httpServer = null
let dataDir = null
let serverPort = null

app.setName('DeepDock')
app.setPath(
  'userData',
  process.env.DEEPDOCK_USER_DATA || path.join(app.getPath('appData'), 'DeepDock'),
)
app.setAppUserModelId('com.deepdock.app')

/* ------------------------------------------------------------------ state */

function stateFile() {
  return path.join(app.getPath('userData'), 'window-state.json')
}

function readWindowState() {
  try {
    return JSON.parse(fs.readFileSync(stateFile(), 'utf8'))
  } catch {
    return null
  }
}

function saveWindowState(win) {
  if (!win || win.isDestroyed()) return
  try {
    const bounds = win.getNormalBounds ? win.getNormalBounds() : win.getBounds()
    fs.mkdirSync(path.dirname(stateFile()), { recursive: true })
    fs.writeFileSync(
      stateFile(),
      JSON.stringify({ ...bounds, maximized: win.isMaximized() }, null, 2),
    )
  } catch {
    /* ignore */
  }
}

function appearanceFile() {
  return path.join(app.getPath('userData'), 'appearance.json')
}

function readAppearanceBackground() {
  try {
    const value = JSON.parse(fs.readFileSync(appearanceFile(), 'utf8'))
    if (typeof value?.background === 'string' && /^#[0-9a-f]{6}$/i.test(value.background)) {
      return value.background
    }
  } catch {
    /* ignore */
  }
  return null
}

/* ----------------------------------------------------------------- server */

async function startServer() {
  const entry = pathToFileURL(path.join(ROOT, 'server', 'app.js')).href
  const { createDeepDockServer } = await import(entry)

  dataDir = path.join(app.getPath('userData'), 'data')
  const { app: expressApp } = await createDeepDockServer({
    dataDir,
    distDir: path.join(ROOT, 'dist'),
    mock: process.env.DEEPDOCK_MOCK === '1',
  })

  // A stable port keeps localStorage (theme, density, collapse state) alive
  // between launches. If it is taken, fall back to any free port.
  const listen = (port) =>
    new Promise((resolve, reject) => {
      const server = expressApp.listen(port, '127.0.0.1', () => {
        httpServer = server
        resolve(server.address().port)
      })
      server.once('error', reject)
    })

  try {
    serverPort = await listen(5199)
  } catch {
    serverPort = await listen(0)
  }
  return serverPort
}

/* ----------------------------------------------------------------- window */

function createWindow(port) {
  const state = readWindowState() || {}
  const iconPath = path.join(ROOT, 'build', 'icon.ico')
  const win = new BrowserWindow({
    width: Math.max(state.width || 1240, 900),
    height: Math.max(state.height || 860, 620),
    x: state.x,
    y: state.y,
    minWidth: 900,
    minHeight: 620,
    show: false,
    title: 'DeepDock',
    backgroundColor:
      readAppearanceBackground() || (nativeTheme.shouldUseDarkColors ? '#0b0c0e' : '#f5f2ea'),
    ...(fs.existsSync(iconPath) ? { icon: iconPath } : {}),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      zoomFactor: 1,
    },
  })

  win.setMenuBarVisibility(false)
  if (state.maximized) win.maximize()

  const origin = `http://127.0.0.1:${port}`
  win.loadURL(`${origin}/`)

  win.once('ready-to-show', () => win.show())

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url)
    return { action: 'deny' }
  })

  win.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith(origin)) {
      event.preventDefault()
      if (/^https?:/i.test(url)) shell.openExternal(url)
    }
  })

  win.on('close', () => saveWindowState(win))
  win.on('closed', () => {
    mainWindow = null
  })

  // Screenshot hook, used by the build scripts to smoke-test the shell.
  if (process.env.DEEPDOCK_SHOT) {
    win.webContents.once('did-finish-load', () => {
      setTimeout(async () => {
        try {
          const image = await win.webContents.capturePage()
          fs.writeFileSync(process.env.DEEPDOCK_SHOT, image.toPNG())
        } catch (err) {
          console.error('[deepdock] capture failed', err)
        }
        if (process.env.DEEPDOCK_SHOT_QUIT !== '0') app.quit()
      }, Number(process.env.DEEPDOCK_SHOT_DELAY || 1600))
    })
  }

  return win
}

/* -------------------------------------------------------------------- ipc */

/**
 * The browser-localStorage reader lives in `server/lib/browser-tokens.js` so it
 * can also be exercised from Node (`scripts/check-auth.mjs`).
 */
let tokenModulePromise = null
function tokenModule() {
  if (!tokenModulePromise) {
    const entry = pathToFileURL(path.join(ROOT, 'server', 'lib', 'browser-tokens.js')).href
    tokenModulePromise = import(entry)
  }
  return tokenModulePromise
}

/**
 * Look for a live chat.deepseek.com session in the browsers already installed
 * on this machine, then hand the candidates to the local API for validation.
 *
 * The token itself never crosses the IPC boundary: the renderer only learns
 * whether the login worked and which browser it came from.
 */
async function autoConnect() {
  if (!serverPort) return { ok: false, reason: 'server' }

  let scan
  try {
    const { scanBrowserTokens } = await tokenModule()
    scan = scanBrowserTokens()
  } catch (err) {
    return { ok: false, reason: 'scan', message: err?.message || String(err) }
  }

  const candidates = scan.candidates.slice(0, 8)
  const sources = [...new Set(candidates.flatMap((item) => item.sources || [item.source]))]
  const scanned = scan.scanned.map((item) => ({
    browser: item.browser,
    profile: item.profile,
    tokens: item.tokens,
  }))

  if (!candidates.length) {
    return { ok: false, reason: 'not_found', found: 0, sources: [], scanned }
  }

  try {
    const res = await fetch(`http://127.0.0.1:${serverPort}/api/connect/auto`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        candidates: candidates.map((item) => ({ source: item.source, token: item.token })),
      }),
    })
    const payload = await res.json().catch(() => null)
    if (res.ok && payload?.connected) {
      return {
        ok: true,
        found: candidates.length,
        source: payload.source || candidates[0].source,
        sources,
        user: payload.user || null,
        scanned,
      }
    }
    return {
      ok: false,
      reason: payload?.error || (res.status === 502 ? 'network' : 'invalid'),
      message: payload?.message || '',
      found: candidates.length,
      sources,
      scanned,
    }
  } catch (err) {
    return {
      ok: false,
      reason: 'network',
      message: err?.message || String(err),
      found: candidates.length,
      sources,
      scanned,
    }
  }
}

ipcMain.handle('deepdock:auto-connect', () => autoConnect())

ipcMain.handle('deepdock:scan-info', async () => {
  try {
    const { scanBrowserTokens } = await tokenModule()
    const scan = scanBrowserTokens()
    return {
      found: scan.candidates.length,
      sources: [...new Set(scan.candidates.flatMap((item) => item.sources || [item.source]))],
      scanned: scan.scanned.map((item) => ({
        browser: item.browser,
        profile: item.profile,
        tokens: item.tokens,
      })),
      errors: scan.errors,
    }
  } catch (err) {
    return { found: 0, sources: [], scanned: [], errors: [{ message: String(err?.message || err) }] }
  }
})

ipcMain.on('deepdock:appearance', (event, payload) => {
  const background =
    typeof payload?.background === 'string' && /^#[0-9a-f]{6}$/i.test(payload.background)
      ? payload.background
      : nativeTheme.shouldUseDarkColors
        ? '#0b0c0e'
        : '#f5f2ea'
  try {
    fs.mkdirSync(path.dirname(appearanceFile()), { recursive: true })
    fs.writeFileSync(
      appearanceFile(),
      JSON.stringify({ background, dark: Boolean(payload?.dark) }, null, 2),
    )
  } catch {
    /* ignore */
  }
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.setBackgroundColor(background)
  }
})

ipcMain.handle('deepdock:open-data', async () => {
  if (!dataDir) return { ok: false }
  const err = await shell.openPath(dataDir)
  return { ok: !err, path: dataDir, error: err || null }
})

ipcMain.handle('deepdock:open-external', async (event, url) => {
  if (typeof url === 'string' && /^https?:/i.test(url)) await shell.openExternal(url)
})

ipcMain.handle('deepdock:info', () => ({
  version: app.getVersion(),
  dataDir,
  platform: process.platform,
  electron: process.versions.electron,
}))

ipcMain.handle('deepdock:confirm', async (event, options) => {
  const win = BrowserWindow.fromWebContents(event.sender) || mainWindow
  const result = await dialog.showMessageBox(win, {
    type: 'question',
    buttons: [options?.confirmLabel || '确定', options?.cancelLabel || '取消'],
    defaultId: 0,
    cancelId: 1,
    message: options?.message || '',
    detail: options?.detail || '',
    noLink: true,
  })
  return result.response === 0
})

/* -------------------------------------------------------------- lifecycle */

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.show()
      mainWindow.focus()
    }
  })

  app.whenReady().then(async () => {
    try {
      const port = await startServer()
      mainWindow = createWindow(port)
    } catch (err) {
      console.error('[deepdock] failed to start', err)
      dialog.showErrorBox(
        'DeepDock 启动失败',
        `${err?.stack || err}\n\n若界面空白，请先执行 npm run build 生成前端资源。`,
      )
      app.quit()
    }

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        startServer().then((port) => {
          mainWindow = createWindow(port)
        })
      }
    })
  })

  app.on('window-all-closed', () => {
    app.quit()
  })

  app.on('before-quit', () => {
    if (httpServer) {
      try {
        httpServer.close()
      } catch {
        /* ignore */
      }
    }
  })
}

if (IS_DEV) {
  // Surface renderer crashes during development instead of failing silently.
  app.on('render-process-gone', (event, webContents, details) => {
    console.error('[deepdock] renderer gone', details)
  })
}
