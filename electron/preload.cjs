// Minimal, explicit bridge between the desktop shell and the web UI.
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('deepdockDesktop', {
  isDesktop: true,
  platform: process.platform,
  // Appearance: the renderer owns the theme; main only repaints the window
  // chrome so there is no white flash around the edges.
  setAppearance: (payload) => ipcRenderer.send('deepdock:appearance', payload),
  openDataFolder: () => ipcRenderer.invoke('deepdock:open-data'),
  openExternal: (url) => ipcRenderer.invoke('deepdock:open-external', url),
  info: () => ipcRenderer.invoke('deepdock:info'),
  confirm: (options) => ipcRenderer.invoke('deepdock:confirm', options),
  // Reads localStorage of locally installed Chromium browsers, validates every
  // candidate against DeepSeek, and only reports whether it worked. Tokens are
  // never handed to the renderer.
  autoConnect: () => ipcRenderer.invoke('deepdock:auto-connect'),
  scanInfo: () => ipcRenderer.invoke('deepdock:scan-info'),
  // Packaged builds check GitHub Releases for a newer version.
  checkUpdates: () => ipcRenderer.invoke('deepdock:check-updates'),
})
