#!/usr/bin/env node
// DeepDock release helper.
//
// Usage:
//   npm run release -- 1.4.3 --notes notes/1.4.3.md
//   npm run release -- 1.4.3 --notes notes/1.4.3.md --dry-run
//   npm run release -- 1.4.3 --notes notes/1.4.3.md --skip-build
//
// What it does (in order):
//   1. checks main branch / clean worktree / version is newer than package.json
//   2. bumps package.json + package-lock.json (no tag yet)
//   3. builds the installer and the portable zip unless --skip-build
//   4. commits "chore: release X", tags vX, pushes main + tag (retries 3x)
//   5. creates the GitHub release (latest) with exe / blockmap / latest.yml / zip
//
// Commits the pending release notes? No: commit your code changes first, then
// run this; only the version files are committed here.
//
// Proxy: uses HTTPS_PROXY / DEEPDOCK_PROXY, otherwise Clash's default
// http://127.0.0.1:7898 (needed for git push / gh on this machine).

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const args = process.argv.slice(2)
const version = args.find((arg) => /^\d+\.\d+\.\d+$/.test(arg))
const notesIndex = args.indexOf('--notes')
const notesArg = notesIndex >= 0 ? args[notesIndex + 1] : ''
const dryRun = args.includes('--dry-run')
const skipBuild = args.includes('--skip-build')
const proxyIndex = args.indexOf('--proxy')
const proxy =
  proxyIndex >= 0
    ? args[proxyIndex + 1]
    : process.env.HTTPS_PROXY || process.env.DEEPDOCK_PROXY || 'http://127.0.0.1:7898'

const env = {
  ...process.env,
  HTTPS_PROXY: proxy,
  HTTP_PROXY: proxy,
  NO_PROXY: 'localhost,127.0.0.1,::1',
}

function fail(message) {
  console.error(`\n✖ ${message}`)
  process.exit(1)
}

function capture(command) {
  const result = spawnSync(command, { shell: true, encoding: 'utf8', env })
  if (result.status !== 0) fail(`命令失败: ${command}\n${result.stderr || ''}`)
  return result.stdout.trim()
}

function run(command) {
  console.log(`\n$ ${command}`)
  if (dryRun) return
  const result = spawnSync(command, { shell: true, stdio: 'inherit', env })
  if (result.status !== 0) fail(`命令失败（exit ${result.status}）: ${command}`)
}

function isNewer(next, current) {
  const a = next.split('.').map(Number)
  const b = current.split('.').map(Number)
  for (let i = 0; i < 3; i += 1) {
    if (a[i] !== b[i]) return a[i] > b[i]
  }
  return false
}

async function push(ref) {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    console.log(`\n$ git push origin ${ref}`)
    if (dryRun) return
    const result = spawnSync(`git push origin ${ref}`, { shell: true, stdio: 'inherit', env })
    if (result.status === 0) return
    if (attempt < 3) {
      console.log(`  push 失败，2 秒后重试（${attempt}/3）…`)
      await new Promise((resolve) => setTimeout(resolve, 2000))
    }
  }
  fail(`git push origin ${ref} 失败`)
}

async function main() {
  if (!version) fail('用法: npm run release -- <version> --notes <file.md> [--dry-run] [--skip-build]')
  if (!notesArg) fail('必须用 --notes 指定 Release 说明文件')
  const notesFile = path.resolve(notesArg)
  if (!fs.existsSync(notesFile)) fail(`找不到说明文件: ${notesFile}`)

  const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'))
  if (!isNewer(version, pkg.version)) {
    fail(`版本号必须大于当前版本（当前 ${pkg.version}，想发 ${version}）`)
  }

  const branch = capture('git rev-parse --abbrev-ref HEAD')
  if (branch !== 'main') fail(`请在 main 分支发布（当前 ${branch}）`)
  if (capture('git status --porcelain --untracked-files=no')) {
    fail('工作区有未提交的改动，请先 commit 代码，再运行发布脚本')
  }
  if (dryRun) {
    console.log(`dry run: 将发布 v${version}，说明文件 ${notesFile}`)
  } else if (spawnSync(`git rev-parse -q --verify refs/tags/v${version}`, { shell: true, stdio: 'ignore' }).status === 0) {
    fail(`tag v${version} 已存在`)
  }

  const setup = `release/builder/DeepDock-Setup-${version}.exe`
  const blockmap = `${setup}.blockmap`
  const zip = `release/builder/DeepDock-${version}-portable-win64.zip`
  const latest = 'release/builder/latest.yml'

  run(`npm version ${version} --no-git-tag-version`)
  if (!skipBuild) {
    run('npm run installer')
    run('npm run portable')
  }

  if (!dryRun) {
    for (const file of [setup, blockmap, zip, latest]) {
      if (!fs.existsSync(file)) fail(`构建产物缺失: ${file}`)
    }
    if (!fs.readFileSync(latest, 'utf8').includes(`version: ${version}`)) {
      fail('latest.yml 的版本号和本次发布不一致（是不是用了 --skip-build？）')
    }
  }

  run('git add package.json package-lock.json')
  run(`git commit -m "chore: release ${version}"`)
  run(`git tag v${version}`)
  await push('main')
  await push(`v${version}`)

  run(
    `gh release create v${version} --title "DeepDock ${version}" --notes-file "${notesFile}" --latest "${setup}" "${blockmap}" "${latest}" "${zip}"`,
  )

  console.log(
    `\n✔ 已发布 v${version}: https://github.com/Enkrid-Rao/deepdock/releases/tag/v${version}${dryRun ? '（dry run）' : ''}`,
  )
}

await main()
