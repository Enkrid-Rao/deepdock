// Builds the green (portable) ZIP from the packaged folder.
//
// Input : release/builder/win-unpacked (produced by `npm run installer`)
// Output: release/builder/DeepDock-<version>-portable-win64.zip
//         └─ DeepDock/               ← 顶层目录，解压不会散落一地
//            ├─ DeepDock.exe
//            ├─ portable.flag        ← main.cjs 靠它把数据写到 DeepDock-data
//            ├─ README.txt
//            └─ resources/app/...
//
// 和安装包的区别：删掉 resources/app-update.yml，绿色版没有可执行的更新链路。
// 想换输出目录（例如只验证不覆盖已发布产物）：设 DEEPDOCK_BUILD_DIR。

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
const version = pkg.version

const BUILD_DIR = process.env.DEEPDOCK_BUILD_DIR
  ? path.resolve(process.env.DEEPDOCK_BUILD_DIR)
  : path.join(ROOT, 'release', 'builder')
const unpacked = path.join(BUILD_DIR, 'win-unpacked')

if (!fs.existsSync(path.join(unpacked, 'DeepDock.exe'))) {
  console.error(`找不到 ${path.join(unpacked, 'DeepDock.exe')}；先运行 npm run installer`)
  process.exit(1)
}

const stage = path.join(os.tmpdir(), `deepdock-portable-${version}`)
const appDir = path.join(stage, 'DeepDock')
fs.rmSync(stage, { recursive: true, force: true })
fs.mkdirSync(appDir, { recursive: true })

console.log(`› staging ${appDir}`)
fs.cpSync(unpacked, appDir, { recursive: true })

// 更新配置只对 NSIS 安装版有意义；绿色版留着它反而可能被 electron-updater 拿起来跑安装器
fs.rmSync(path.join(appDir, 'resources', 'app-update.yml'), { force: true })
// 别把上一次运行留下的数据打进包里
fs.rmSync(path.join(appDir, 'DeepDock-data'), { recursive: true, force: true })

fs.writeFileSync(path.join(appDir, 'portable.flag'), 'DeepDock portable build\n')

const readme = [
  `DeepDock ${version} 绿色版（免安装）`,
  '================================',
  '',
  '1. 把整个 DeepDock 文件夹解压到任意可写目录（不要放 Program Files 或只读 U 盘）。',
  '2. 双击 DeepDock.exe 运行，不需要安装，也不需要管理员权限。',
  '3. 对话、项目、登录凭证、窗口位置都在同目录的 DeepDock-data 里。',
  '   把整个文件夹拷到别的电脑或 U 盘，数据和登录态会一起带走。',
  '4. 升级：下载新版压缩包，解压后把旧的 DeepDock-data 目录放到新文件夹里即可。',
  '5. 卸载：退出 DeepDock，删掉整个文件夹。不写注册表，不在系统目录留任何东西。',
  '',
  '注意：程序未签名，Windows SmartScreen 首次可能提示，选择「更多信息 → 仍要运行」。',
  '绿色版不参与自动更新，新版本请到 Releases 手动下载。',
  '',
].join('\r\n')
// 带 BOM 的 UTF-8，老版本记事本打开不会乱码
fs.writeFileSync(path.join(appDir, 'README.txt'), `\ufeff${readme}`, 'utf8')

const out = path.join(BUILD_DIR, `DeepDock-${version}-portable-win64.zip`)
fs.rmSync(out, { force: true })

/** electron-builder 的缓存里有现成的 7za，比 Compress-Archive 快很多 */
function find7za() {
  const base = path.join(process.env.LOCALAPPDATA || '', 'electron-builder', 'Cache', '7zip@1.0.0')
  if (!fs.existsSync(base)) return null
  for (const entry of fs.readdirSync(base)) {
    const candidate = path.join(base, entry, 'bin', '7za.exe')
    if (fs.existsSync(candidate)) return candidate
  }
  return null
}

const sevenZip = find7za()
if (sevenZip) {
  console.log(`› zip with 7za: ${sevenZip}`)
  execFileSync(sevenZip, ['a', '-tzip', '-mx=5', '-y', '-bso0', '-bsp0', out, 'DeepDock'], {
    cwd: stage,
    stdio: 'inherit',
  })
} else {
  console.log('› zip with PowerShell Compress-Archive')
  const quote = (value) => value.replace(/'/g, "''")
  execFileSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-Command',
      `Compress-Archive -LiteralPath '${quote(appDir)}' -DestinationPath '${quote(out)}' -CompressionLevel Optimal -Force`,
    ],
    { stdio: 'inherit' },
  )
}

const size = fs.statSync(out).size
console.log(`\n✔ portable zip: ${out}`)
console.log(`  size: ${(size / 1024 / 1024).toFixed(1)} MB`)
console.log(`  stage: ${stage}`)
