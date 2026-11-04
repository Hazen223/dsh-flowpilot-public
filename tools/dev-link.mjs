#!/usr/bin/env node
/**
 * 把 DSH profile 里安装的 dsh-flowpilot 换成指向本仓库的软链（「本地开发版」直连源码）。
 *
 * 背景：profile 用 pnpm 从 git tag 安装插件时，node_modules/dsh-flowpilot 是安装副本，
 * 改仓库源码不会生效；手搓软链又会被下一次 pnpm install 覆盖、且没人记得做过什么。
 * 这个脚本把这件事变成幂等、可检查、可重复的一条命令。
 *
 * 用法：
 *   node tools/dev-link.mjs                 # 给 desktop profile 建链
 *   node tools/dev-link.mjs --profile=web   # 指定 profile
 *   node tools/dev-link.mjs --all           # 所有声明了 dsh-flowpilot 依赖的 profile
 *   node tools/dev-link.mjs --check         # 只检查（存在未链接 → 退出码 1）
 *   node tools/dev-link.mjs --json          # 机器可读
 *
 * 行为：已链接 → 跳过；安装副本 → 先重命名为 dsh-flowpilot.installed-<时间戳> 再建软链（不删用户文件）；
 * 软链指向别处 → 改指向本仓库；profile 未声明该依赖 → 跳过。建链后重启 DSH 生效。
 */
import {
  readdirSync, readFileSync, lstatSync, symlinkSync, renameSync, unlinkSync,
  existsSync, realpathSync, mkdirSync, statSync,
} from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const jsonMode = args.includes('--json')
const checkOnly = args.includes('--check')
const allProfiles = args.includes('--all')
const profileArg = (args.find((item) => item.startsWith('--profile=')) || '').split('=')[1]
const profilesRoot = process.env.DSH_PROFILES_ROOT || join(process.env.HOME || '~', '.dsh', 'profiles')
const stamp = () => new Date().toISOString().replace(/[:.]/g, '-')

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

function profileNames() {
  if (profileArg) return [profileArg]
  let names = []
  try {
    names = readdirSync(profilesRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name !== 'node_modules' && !entry.name.startsWith('.'))
      .map((entry) => entry.name)
  } catch {
    return []
  }
  if (!allProfiles) return names.includes('desktop') ? ['desktop'] : names.slice(0, 1)
  return names.filter((name) => {
    const pkg = readJson(join(profilesRoot, name, 'package.json'))
    const deps = (pkg && pkg.dependencies) || {}
    return typeof deps['dsh-flowpilot'] === 'string'
  })
}

function inspect(profile) {
  const profileDir = join(profilesRoot, profile)
  const manifest = readJson(join(profileDir, 'package.json'))
  if (manifest === null) return { profile, status: 'missing-profile' }
  const spec = (manifest.dependencies || {})['dsh-flowpilot']
  if (typeof spec !== 'string') return { profile, status: 'not-declared' }
  const targetPath = join(profileDir, 'node_modules', 'dsh-flowpilot')
  let stat = null
  try {
    stat = lstatSync(targetPath)
  } catch {
    stat = null
  }
  if (stat === null) return { profile, status: 'not-installed', spec }
  if (stat.isSymbolicLink()) {
    let real = null
    try {
      real = realpathSync(targetPath)
    } catch {
      real = null
    }
    return { profile, status: real === repoRoot ? 'linked' : 'linked-elsewhere', spec, linkTarget: real }
  }
  return { profile, status: 'installed-copy', spec }
}

/** 把 profile 的插件目录换成指向本仓库的软链（幂等）。返回 { before, after, backup }。 */
function ensureLinked(profile) {
  const before = inspect(profile)
  if (before.status === 'not-installed') {
    mkdirSync(join(profilesRoot, profile, 'node_modules'), { recursive: true })
    symlinkSync(repoRoot, join(profilesRoot, profile, 'node_modules', 'dsh-flowpilot'))
    return { before: before.status, after: inspect(profile).status, backup: null }
  }
  if (before.status === 'linked') return { before: before.status, after: 'linked', backup: null }
  if (before.status !== 'installed-copy' && before.status !== 'linked-elsewhere') {
    return { before: before.status, after: before.status, backup: null }
  }
  const nodeModules = join(profilesRoot, profile, 'node_modules')
  const targetPath = join(nodeModules, 'dsh-flowpilot')
  mkdirSync(nodeModules, { recursive: true })
  let backup = null
  if (before.status === 'installed-copy') {
    backup = `${targetPath}.installed-${stamp()}`
    renameSync(targetPath, backup)
  } else {
    unlinkSync(targetPath) // 只删软链本身，不碰它指向的目录
  }
  symlinkSync(repoRoot, targetPath)
  return { before: before.status, after: inspect(profile).status, backup }
}

const results = profileNames().map((profile) => {
  const result = checkOnly ? inspect(profile) : ensureLinked(profile)
  return {
    profile,
    before: checkOnly ? result.status : result.before,
    after: checkOnly ? result.status : result.after,
    backup: checkOnly ? null : result.backup,
  }
})

const buildInfo = readJson(join(repoRoot, 'build-info.json'))
const clientStat = existsSync(join(repoRoot, 'client.js')) ? statSync(join(repoRoot, 'client.js')) : null
const summary = {
  repo: repoRoot,
  profilesRoot,
  checkOnly,
  build: buildInfo,
  client: clientStat === null ? null : { bytes: clientStat.size, modifiedAt: clientStat.mtime.toISOString() },
  results,
}

if (jsonMode) {
  console.log(JSON.stringify(summary, null, 2))
} else {
  console.log(`仓库：${repoRoot}`)
  console.log(`profile 根目录：${profilesRoot}`)
  if (buildInfo) console.log(`当前构建：${buildInfo.label}（channel=${buildInfo.channel}）`)
  console.log('')
  for (const item of results) {
    const label = item.after === 'linked' ? '✓ 已链接到本仓库源码' : `✗ ${item.after}`
    console.log(`  ${item.profile.padEnd(10)} ${item.before.padEnd(16)} → ${label}`)
    if (item.backup) console.log(`             原安装副本已重命名为：${item.backup}`)
  }
  const broken = results.filter((item) => item.after !== 'linked' && item.before !== 'not-declared' && item.before !== 'missing-profile')
  if (broken.length > 0) {
    console.log(checkOnly ? '\n未链接：运行 `node tools/dev-link.mjs` 修复（之后重启 DSH 生效）' : '\n有 profile 未能链接，见上方状态。')
  } else if (results.length > 0) {
    console.log('\n全部目标 profile 已直连本仓库源码；改动代码后重启 DSH 生效。')
  }
}

if (checkOnly) {
  const broken = results.filter((item) => item.after !== 'linked' && item.before !== 'not-declared' && item.before !== 'missing-profile')
  process.exitCode = broken.length > 0 ? 1 : 0
}
