// Standalone server: `npm start`.
// The desktop shell uses `server/app.js` directly instead.

import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { createDeepDockServer } from './app.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const DATA_DIR = process.env.DEEPDOCK_DATA || path.join(ROOT, 'data')
const DIST_DIR = path.join(ROOT, 'dist')
const PORT = Number(process.env.PORT || 5180)
const MOCK = process.env.DEEPDOCK_MOCK === '1'

const { app, credentials } = await createDeepDockServer({
  dataDir: DATA_DIR,
  distDir: DIST_DIR,
  mock: MOCK,
})

const server = app.listen(PORT, '127.0.0.1', () => {
  console.log(`\n  DeepDock  →  http://127.0.0.1:${PORT}`)
  console.log(`  data      →  ${DATA_DIR}`)
  console.log(`  account   →  ${credentials.connected ? 'connected' : 'not connected'}`)
  console.log(`  mode      →  ${MOCK ? 'MOCK' : 'live'}\n`)
})

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    server.close(() => process.exit(0))
    setTimeout(() => process.exit(0), 1500)
  })
}
