// Electron shell for DeepDock.
// Runs the DeepDock API in-process on a random loopback port, then opens a
// window on it. No Node integration in the renderer, no remote content.

const { app, BrowserWindow, ipcMain, shell, dialog, nativeTheme } = require('electron')
const { autoUpdater } = require('electron-updater')
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

function readAppearance() {
  try {
    const value = JSON.parse(fs.readFileSync(appearanceFile(), 'utf8'))
    const color = (input) =>
      typeof input === 'string' && /^#[0-9a-f]{6}$/i.test(input) ? input : null
    return {
      background: color(value?.background),
      ink: color(value?.ink),
      dark: Boolean(value?.dark),
    }
  } catch {
    /* ignore */
  }
  return { background: null, ink: null, dark: false }
}

/** Windows builds are frameless; the renderer draws its own window buttons. */
function windowChromeOptions() {
  return process.platform === 'win32' ? { frame: false, thickFrame: true } : {}
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
  const appearance = readAppearance()
  const background =
    appearance.background || (nativeTheme.shouldUseDarkColors ? '#0b0c0e' : '#f5f2ea')
  const win = new BrowserWindow({
    width: Math.max(state.width || 1240, 900),
    height: Math.max(state.height || 860, 620),
    x: state.x,
    y: state.y,
    minWidth: 900,
    minHeight: 620,
    show: false,
    title: 'DeepDock',
    backgroundColor: background,
    ...(fs.existsSync(iconPath) ? { icon: iconPath } : {}),
    autoHideMenuBar: true,
    ...windowChromeOptions(),
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

  const sendWindowState = () => {
    if (!win.isDestroyed()) {
      win.webContents.send('deepdock:window-state', { maximized: win.isMaximized() })
    }
  }
  win.on('maximize', sendWindowState)
  win.on('unmaximize', sendWindowState)

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
  const symbolColor =
    typeof payload?.ink === 'string' && /^#[0-9a-f]{6}$/i.test(payload.ink)
      ? payload.ink
      : payload?.dark
        ? '#f0f2f6'
        : '#14130e'
  try {
    fs.mkdirSync(path.dirname(appearanceFile()), { recursive: true })
    fs.writeFileSync(
      appearanceFile(),
      JSON.stringify({ background, dark: Boolean(payload?.dark), ink: symbolColor }, null, 2),
    )
  } catch {
    /* ignore */
  }
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue
    win.setBackgroundColor(background)
  }
})

ipcMain.handle('deepdock:window-state', (event) => {
  const win = BrowserWindow.fromWebContents(event.sender) || mainWindow
  return { maximized: Boolean(win && !win.isDestroyed() && win.isMaximized()) }
})

ipcMain.handle('deepdock:window-control', (event, action) => {
  const win = BrowserWindow.fromWebContents(event.sender) || mainWindow
  if (!win || win.isDestroyed()) return { maximized: false }
  if (action === 'minimize') win.minimize()
  else if (action === 'maximize') {
    if (win.isMaximized()) win.unmaximize()
    else win.maximize()
  } else if (action === 'close') win.close()
  return { maximized: win.isMaximized() }
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

/* ------------------------------------------------------------ auto update */

// electron-builder embeds an `app-update.yml` pointing at GitHub Releases.
// The renderer can ask for a check (and choose whether to download); the
// background timer only checks, never downloads, so nothing happens without
// the user's consent. State is mirrored to the renderer for the settings page.

const updateState = {
  status: 'idle', // idle | checking | available | downloading | downloaded | current | error | dev
  version: '',
  current: '',
  percent: 0,
  message: '',
}

let updatePromptOpen = false

function updateSnapshot() {
  return { ...updateState, current: app.getVersion() }
}

function pushUpdateState(patch) {
  Object.assign(updateState, patch)
  const snapshot = updateSnapshot()
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send('deepdock:update-state', snapshot)
  }
  return snapshot
}

function friendlyUpdateError(err) {
  const message = String(err?.message || err || '')
  if (/net::|network|timed?\s?out|ECONN|ENOTFOUND|ERR_/i.test(message)) {
    return '连不上 GitHub，检查更新需要能访问 GitHub（可开启系统代理）'
  }
  return message || '检查更新失败'
}

async function downloadUpdate() {
  if (IS_DEV) return updateSnapshot()
  if (updateState.status === 'downloading') return updateSnapshot()
  try {
    pushUpdateState({ status: 'downloading', percent: 0, message: '' })
    await autoUpdater.downloadUpdate()
  } catch (err) {
    pushUpdateState({ status: 'error', message: friendlyUpdateError(err) })
  }
  return updateSnapshot()
}

async function promptDownload(version) {
  if (updatePromptOpen) return
  updatePromptOpen = true
  try {
    const { response } = await dialog.showMessageBox(mainWindow, {
      type: 'question',
      buttons: ['下载并安装', '稍后'],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
      title: 'DeepDock 有新版本',
      message: `发现新版本 ${version}`,
      detail: `当前版本 v${app.getVersion()}。现在下载，下载完成后会再问你是否重启安装；选择「稍后」可以之后在「设置 → 应用 → 更新」里操作。`,
    })
    if (response === 0) await downloadUpdate()
  } finally {
    updatePromptOpen = false
  }
}

async function promptInstall(version) {
  if (updatePromptOpen) return
  updatePromptOpen = true
  try {
    const { response } = await dialog.showMessageBox(mainWindow, {
      type: 'info',
      buttons: ['立即重启安装', '退出时安装'],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
      title: 'DeepDock 更新已下载',
      message: `新版本 ${version || updateState.version} 已经下载好`,
      detail: '现在重启会立即安装；选择「退出时安装」则在下次退出 DeepDock 时自动安装。',
    })
    if (response === 0) setImmediate(() => autoUpdater.quitAndInstall(true, true))
  } finally {
    updatePromptOpen = false
  }
}

function setupAutoUpdater() {
  if (IS_DEV) {
    updateState.status = 'dev'
    return
  }

  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = true
  autoUpdater.on('error', (err) => {
    console.warn('[deepdock] updater:', err?.message || err)
    pushUpdateState({ status: 'error', message: friendlyUpdateError(err) })
  })
  autoUpdater.on('checking-for-update', () => {
    pushUpdateState({ status: 'checking', message: '' })
  })
  autoUpdater.on('update-available', (info) => {
    pushUpdateState({ status: 'available', version: info?.version || '', percent: 0, message: '' })
  })
  autoUpdater.on('update-not-available', () => {
    pushUpdateState({ status: 'current', version: app.getVersion(), percent: 0, message: '' })
  })
  autoUpdater.on('download-progress', (progress) => {
    pushUpdateState({ status: 'downloading', percent: Math.round(progress?.percent || 0) })
  })
  autoUpdater.on('update-downloaded', (info) => {
    pushUpdateState({
      status: 'downloaded',
      version: info?.version || updateState.version,
      percent: 100,
      message: '',
    })
    void promptInstall(info?.version)
  })

  // Background checks only look for updates; installing always needs a click.
  const backgroundCheck = () => {
    autoUpdater.checkForUpdates().catch(() => {})
  }
  setTimeout(backgroundCheck, 15000)
  const timer = setInterval(backgroundCheck, 6 * 60 * 60 * 1000)
  if (timer.unref) timer.unref()
}

ipcMain.handle('deepdock:check-updates', async () => {
  if (IS_DEV) return { ...updateSnapshot(), status: 'dev' }
  try {
    pushUpdateState({ status: 'checking', message: '' })
    const result = await autoUpdater.checkForUpdates()
    const latest = result?.updateInfo?.version || ''
    const newer = Boolean(latest) && latest !== app.getVersion()
    if (newer) {
      const alreadyDownloaded = updateState.status === 'downloaded'
      pushUpdateState({
        status: alreadyDownloaded ? 'downloaded' : 'available',
        version: latest,
        percent: alreadyDownloaded ? 100 : 0,
        message: '',
      })
      if (!alreadyDownloaded) await promptDownload(latest)
    } else {
      pushUpdateState({ status: 'current', version: app.getVersion(), percent: 0, message: '' })
    }
    return updateSnapshot()
  } catch (err) {
    pushUpdateState({ status: 'error', message: friendlyUpdateError(err) })
    return updateSnapshot()
  }
})

ipcMain.handle('deepdock:download-update', () => downloadUpdate())
ipcMain.handle('deepdock:update-state', () => updateSnapshot())
ipcMain.handle('deepdock:install-update', () => {
  if (!IS_DEV && updateState.status === 'downloaded') {
    setImmediate(() => autoUpdater.quitAndInstall(true, true))
    return { ok: true }
  }
  return { ok: false }
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
      setupAutoUpdater()
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
