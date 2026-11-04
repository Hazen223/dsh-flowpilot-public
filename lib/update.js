/**
 * FlowPilot 宿主半 · 版本检查与一键更新
 *
 * 归属：host-core
 * 用途：docs/UPDATE.md 的宿主实现：
 * - `status()`：当前版本 / 最新 tag / 是否有更新 / 安装形态（profile 还是 link 开发模式）/
 *   上次检查时间 / 上次错误；供设置页与顶栏提醒消费。
 * - `check()`：`git ls-remote --tags --refs <repo>` 读取远端 tag（走本机 git 凭据），
 *   30 分钟缓存 + 并发去重；失败记 lastError，不拖垮插件。
 * - `apply()`：仅在 profile（git 安装）形态下用 DSH 内置 pnpm 重新安装 `repo#vX.Y.Z`
 *   （等价插件页「移除 + 重装」）；装完标记 restartRequired，由 `restart()` 重启 DSH 生效。
 * - `restart()`：用 detached 的 sh 脚本「quit DSH NEXT → 2s 后 open」重启桌面端，
 *   保证宿主半新代码被加载。
 *
 * 依赖策略：只 import `node:` 内置模块；子进程只用 `node:child_process`。
 * 开发机（profile 以 `link:` 引用本目录）会被识别为 mode='link'，只检查不自动安装，
 * 避免开发时被远端版本覆盖。
 */

import { execFile, spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

/* ------------------------------------------------------------------ *
 * 常量
 * ------------------------------------------------------------------ */

/** 更新错误码（UPDATE.md §2.4）。 */
export const UPDATE_ERROR_CODES = Object.freeze([
  'UPDATE_CHECK_FAILED',
  'UPDATE_NO_TAGS',
  'UPDATE_BUSY',
  'UPDATE_NOT_AVAILABLE',
  'UPDATE_DEV_MODE',
  'UPDATE_PNPM_MISSING',
  'UPDATE_APPLY_FAILED',
  'UPDATE_UNSUPPORTED',
  'INVALID_INPUT',
])

/** 更新错误码 → HTTP 状态码。 */
export const UPDATE_ERROR_STATUS = Object.freeze({
  UPDATE_CHECK_FAILED: 502,
  UPDATE_NO_TAGS: 502,
  UPDATE_BUSY: 409,
  UPDATE_NOT_AVAILABLE: 409,
  UPDATE_DEV_MODE: 409,
  UPDATE_PNPM_MISSING: 500,
  UPDATE_APPLY_FAILED: 500,
  UPDATE_UNSUPPORTED: 500,
  INVALID_INPUT: 400,
})

export const UPDATE_CACHE_TTL_MS = 30 * 60 * 1000
export const UPDATE_AUTO_INTERVAL_MS = 6 * 60 * 60 * 1000
const GIT_TIMEOUT_MS = 15_000
const PNPM_TIMEOUT_MS = 180_000

export class UpdateError extends Error {
  constructor(code, message, options = {}) {
    super(message)
    this.name = 'UpdateError'
    this.code = code
    if (options.cause !== undefined) this.cause = options.cause
  }
}

/* ------------------------------------------------------------------ *
 * 纯函数（测试可直接断言）
 * ------------------------------------------------------------------ */

/** 去掉 `git+` / `git@` 形式与尾部 `.git`，得到 pnpm / git 都能用的 https 地址。 */
export function normalizeRepoUrl(value) {
  if (typeof value !== 'string') return ''
  let text = value.trim()
  if (text === '') return ''
  if (text.startsWith('git+')) text = text.slice(4)
  if (text.startsWith('git@github.com:')) text = `https://github.com/${text.slice('git@github.com:'.length)}`
  if (text.endsWith('.git')) text = text.slice(0, -4)
  return text
}

/** `v1.2.0` / `1.2.0` / `1.2.0-beta.1` → { major, minor, patch, pre }；非法返回 null。 */
export function parseVersion(value) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(String(value === undefined || value === null ? '' : value).trim())
  if (!match) return null
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]), pre: match[4] || '' }
}

/** 语义化版本比较：a>b → 1，a<b → -1，相等 → 0；无法解析的版本排在最后。 */
export function compareVersions(a, b) {
  const left = parseVersion(a)
  const right = parseVersion(b)
  if (left === null && right === null) return 0
  if (left === null) return -1
  if (right === null) return 1
  for (const key of ['major', 'minor', 'patch']) {
    if (left[key] !== right[key]) return left[key] > right[key] ? 1 : -1
  }
  if (left.pre === right.pre) return 0
  if (left.pre === '') return 1
  if (right.pre === '') return -1
  return left.pre > right.pre ? 1 : -1
}

/** `git ls-remote --tags --refs` 输出 → 按版本倒序的 [{ version, tag }]。 */
export function extractTags(stdout) {
  const found = new Map()
  const lines = String(stdout || '').split('\n')
  for (const line of lines) {
    const match = /refs\/tags\/(v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/.exec(line.trim())
    if (!match) continue
    const tag = match[1]
    const version = tag.replace(/^v/, '')
    const parsed = parseVersion(version)
    if (parsed === null) continue
    found.set(version, { version, tag })
  }
  return [...found.values()].sort((left, right) => compareVersions(right.version, left.version))
}

/* ------------------------------------------------------------------ *
 * 默认环境探测
 * ------------------------------------------------------------------ */

function readJsonFile(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
}

function defaultPluginRoot() {
  return dirname(fileURLToPath(new URL('../package.json', import.meta.url)))
}

/** 从安装路径推断 profile 目录：`<profile>/node_modules/dsh-flowpilot` → `<profile>`；link 开发模式 → null。 */
export function detectProfileDir(pluginRoot) {
  const marker = `${sep}node_modules${sep}dsh-flowpilot`
  if (typeof pluginRoot !== 'string' || !pluginRoot.endsWith(marker)) return null
  const profileDir = pluginRoot.slice(0, pluginRoot.length - marker.length)
  const manifest = readJsonFile(join(profileDir, 'package.json'))
  if (manifest === null || typeof manifest !== 'object' || manifest.dsh === undefined) return null
  return profileDir
}

function defaultPnpmPath() {
  const resources = process.resourcesPath
  if (typeof resources !== 'string' || resources === '') return null
  for (const name of ['pnpm.cjs', 'pnpm.mjs']) {
    const candidate = join(resources, 'app.asar.unpacked', 'node_modules', 'pnpm', 'bin', name)
    if (existsSync(candidate)) return candidate
  }
  return null
}

function defaultGitPath() {
  return existsSync('/usr/bin/git') ? '/usr/bin/git' : 'git'
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`
}

function tail(text, limit = 600) {
  const value = String(text || '').trim()
  return value.length <= limit ? value : value.slice(value.length - limit)
}

/* ------------------------------------------------------------------ *
 * 子进程执行器（默认实现，测试可注入）
 * ------------------------------------------------------------------ */

function execFileAsync(file, args, options) {
  return new Promise((resolve) => {
    try {
      execFile(file, args, options, (error, stdout, stderr) => {
        resolve({
          ok: !error,
          code: error && typeof error.code === 'number' ? error.code : error ? 1 : 0,
          stdout: String(stdout || ''),
          stderr: String(stderr || ''),
          message: error ? String(error.message || error) : '',
        })
      })
    } catch (error) {
      resolve({ ok: false, code: 1, stdout: '', stderr: '', message: String(error && error.message ? error.message : error) })
    }
  })
}

/**
 * git credential 参数：若本机有 `~/.git-credentials`，强制只用文件凭据。
 *
 * 背景：macOS 上 Xcode 的 system gitconfig 会注册 `credential.helper=osxkeychain`，
 * 在无人值守/无 GUI 会话时它可能卡住等待钥匙串弹窗（iMac 实测：git ls-remote 挂 60s+）。
 * `-c credential.helper=`（空值）先清空助手列表，再 `-c credential.helper=store` 只用文件；
 * 没有文件时退回默认（让系统钥匙串照常工作）。
 * @param {boolean} hasCredentialsFile
 * @returns {string[]}
 */
export function credentialHelperArgs(hasCredentialsFile) {
  return hasCredentialsFile ? ['-c', 'credential.helper=', '-c', 'credential.helper=store'] : []
}

function defaultHasCredentialsFile() {
  try {
    return existsSync(join(homedir(), '.git-credentials'))
  } catch {
    return false
  }
}

/**
 * pnpm 会自己 spawn `git` 去解析 git 依赖，它不继承我们给更新检查加的 `-c credential.helper` 参数。
 * 因此这里用 git 的 env 配置通道（`GIT_CONFIG_*`）强制它的子进程只用 `~/.git-credentials`：
 * 否则 macOS 上 `gh auth setup-git` 写入的 `credential.https://github.com.helper`
 * 可能排在 generic `store` 前面，拿到过期令牌后 git 不会回退 → 更新失败（实测 403）。
 * @param {boolean} hasCredentialsFile
 * @returns {Record<string, string>}
 */
export function pnpmGitEnv(hasCredentialsFile) {
  const env = {
    // 永不等待终端 / 钥匙串交互
    GIT_TERMINAL_PROMPT: '0',
    GIT_ASKPASS: '/usr/bin/true',
    GCM_INTERACTIVE: 'never',
  }
  if (hasCredentialsFile) {
    env.GIT_CONFIG_COUNT = '2'
    env.GIT_CONFIG_KEY_0 = 'credential.helper'
    env.GIT_CONFIG_VALUE_0 = ''
    env.GIT_CONFIG_KEY_1 = 'credential.helper'
    env.GIT_CONFIG_VALUE_1 = 'store'
  }
  return env
}

function defaultRunGit(gitPath, args, options = {}) {
  return execFileAsync(gitPath, [...credentialHelperArgs(options.useStoreCredentials ?? defaultHasCredentialsFile()), ...args], {
    timeout: options.timeoutMs || GIT_TIMEOUT_MS,
    maxBuffer: 2 * 1024 * 1024,
    cwd: options.cwd,
    // 永不等待终端/钥匙串交互：失败就返回错误（上层映射为 UPDATE_CHECK_FAILED）
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never', GIT_ASKPASS: '/usr/bin/true' },
  })
}

function defaultRunPnpm(execPath, pnpmPath, spec, options = {}) {
  const hasCredentialsFile = options.useStoreCredentials ?? defaultHasCredentialsFile()
  return execFileAsync(execPath, [pnpmPath, 'add', spec], {
    timeout: options.timeoutMs || PNPM_TIMEOUT_MS,
    maxBuffer: 4 * 1024 * 1024,
    cwd: options.cwd,
    // 同时覆盖 pnpm 内部 git 子进程的凭据链（见 pnpmGitEnv 注释）
    env: { ...process.env, ...pnpmGitEnv(hasCredentialsFile), ELECTRON_RUN_AS_NODE: '1' },
  })
}

/** 确认 DSH 桌面端路径：`<x>.app/Contents/MacOS/DSH NEXT` → `<x>.app`。 */
function appBundleOf(execPath) {
  const match = /^(.*\.app)\/Contents\/MacOS\/[^/]+$/.exec(String(execPath || ''))
  return match ? match[1] : null
}

function defaultRestartApp(execPath) {
  const appBundle = appBundleOf(execPath)
  if (appBundle === null) {
    throw new UpdateError('UPDATE_UNSUPPORTED', '当前运行环境不是 macOS 桌面端，无法自动重启')
  }
  const quit = `osascript -e 'tell application "DSH NEXT" to quit' >/dev/null 2>&1 || pkill -TERM -f ${shellQuote(`${appBundle}/Contents/MacOS/`)} >/dev/null 2>&1 || true`
  const script = `sleep 1; ${quit}; sleep 2; open -a ${shellQuote(appBundle)}`
  const child = spawn('/bin/sh', ['-c', script], { detached: true, stdio: 'ignore' })
  child.unref()
  return { ok: true, restarting: true, app: appBundle, pid: child.pid }
}

/* ------------------------------------------------------------------ *
 * 服务
 * ------------------------------------------------------------------ */

/**
 * 创建更新服务。
 * @param {object} [options]
 * @param {any} [options.logger] 日志器（默认 console）
 * @param {string} [options.pluginRoot] 插件根目录（默认本文件上一级）
 * @param {string} [options.version] 当前版本（默认读 pluginRoot/package.json）
 * @param {string} [options.repo] 远端仓库 https 地址（默认读 package.json repository.url）
 * @param {string} [options.profileDir] 覆盖 profile 目录
 * @param {'profile'|'link'} [options.mode] 覆盖安装形态
 * @param {string|null} [options.pnpmPath] 覆盖内置 pnpm 路径
 * @param {string} [options.execPath] 覆盖 Electron/node 可执行文件
 * @param {Function} [options.runGit] 注入 git 执行器 (args, opts) => Promise<{ok,stdout,...}>
 * @param {Function} [options.runPnpm] 注入 pnpm 执行器 (spec, opts) => Promise<{ok,stdout,...}>
 * @param {Function} [options.restartApp] 注入重启器 (execPath) => object
 * @param {Function} [options.now] 注入时钟
 * @param {number} [options.cacheTtlMs] 检查结果缓存时长
 * @param {boolean} [options.auto] 是否启动定时检查（默认 true）
 * @returns {{ status: Function, check: Function, apply: Function, restart: Function, start: Function }}
 */
export function createUpdateService(options = {}) {
  const logger = options.logger || console
  const pluginRoot = options.pluginRoot || defaultPluginRoot()
  const manifest = readJsonFile(join(pluginRoot, 'package.json')) || {}
  const version = options.version || manifest.version || '0.0.0'
  const repo = options.repo !== undefined
    ? normalizeRepoUrl(options.repo)
    : normalizeRepoUrl(manifest.repository?.url || manifest.repository || '')
  const profileDir = options.profileDir !== undefined ? options.profileDir : detectProfileDir(pluginRoot)
  const mode = options.mode || (profileDir === null ? 'link' : 'profile')
  const pnpmPath = options.pnpmPath !== undefined ? options.pnpmPath : defaultPnpmPath()
  const execPath = options.execPath || process.execPath
  const gitPath = options.gitPath || defaultGitPath()
  const now = options.now || (() => Date.now())
  const cacheTtlMs = Number(options.cacheTtlMs) > 0 ? Number(options.cacheTtlMs) : UPDATE_CACHE_TTL_MS
  const platform = options.platform || process.platform

  const runGit = options.runGit || ((args, runOptions) => defaultRunGit(gitPath, args, runOptions))
  const runPnpm = options.runPnpm || ((spec, runOptions) => defaultRunPnpm(execPath, pnpmPath, spec, runOptions))
  const restartApp = options.restartApp || defaultRestartApp

  let cache = null // { checkedAt, latestVersion, rawTag, error }
  let busy = null // 'check' | 'apply'
  let appliedVersion = null
  let restartRequired = false
  let lastAppliedLog = ''

  function isoOf(millis) {
    return millis === null || millis === undefined ? null : new Date(millis).toISOString()
  }

  function status() {
    const latestVersion = cache ? cache.latestVersion : null
    return {
      ok: true,
      currentVersion: version,
      latestVersion,
      updateAvailable: latestVersion !== null && latestVersion !== undefined
        ? (compareVersions(latestVersion, version) > 0 && appliedVersion !== latestVersion)
        : false,
      checkedAt: cache ? isoOf(cache.checkedAt) : null,
      repo,
      mode,
      profileDir: mode === 'profile' ? profileDir : null,
      canApply: mode === 'profile' && typeof pnpmPath === 'string' && pnpmPath !== '',
      busy,
      appliedVersion,
      restartRequired,
      lastApplyLog: lastAppliedLog,
      error: cache ? cache.error : null,
    }
  }

  function recordError(error) {
    cache = {
      checkedAt: now(),
      latestVersion: null,
      rawTag: null,
      error: {
        code: error instanceof UpdateError ? error.code : 'UPDATE_CHECK_FAILED',
        message: String(error && error.message ? error.message : error),
        at: isoOf(now()),
      },
    }
  }

  async function check(options2 = {}) {
    const force = options2.force === true
    if (busy !== null) {
      throw new UpdateError('UPDATE_BUSY', `更新服务正忙（${busy}），请稍后再试`)
    }
    if (cache !== null && !force && now() - cache.checkedAt < cacheTtlMs) return status()
    if (repo === '') {
      const error = new UpdateError('UPDATE_CHECK_FAILED', '插件 package.json 未声明 repository 地址，无法检查更新')
      recordError(error)
      throw error
    }
    busy = 'check'
    try {
      const result = await runGit(['ls-remote', '--tags', '--refs', repo], { cwd: pluginRoot })
      if (!result || result.ok !== true) {
        throw new UpdateError(
          'UPDATE_CHECK_FAILED',
          `读取远端 tag 失败：${(result && (result.message || result.stderr)) || 'git ls-remote 执行失败'}`,
        )
      }
      const tags = extractTags(result.stdout)
      if (tags.length === 0) {
        throw new UpdateError('UPDATE_NO_TAGS', '远端仓库没有找到 vX.Y.Z 形式的发布 tag')
      }
      cache = { checkedAt: now(), latestVersion: tags[0].version, rawTag: tags[0].tag, error: null }
      return status()
    } catch (error) {
      const wrapped = error instanceof UpdateError
        ? error
        : new UpdateError('UPDATE_CHECK_FAILED', String(error && error.message ? error.message : error))
      recordError(wrapped)
      throw wrapped
    } finally {
      busy = null
    }
  }

  async function apply() {
    if (busy !== null) {
      throw new UpdateError('UPDATE_BUSY', `更新服务正忙（${busy}），请稍后再试`)
    }
    if (mode !== 'profile') {
      throw new UpdateError('UPDATE_DEV_MODE', '当前是开发模式安装（link），请直接 git pull 更新，或在 git 安装的机器上使用一键更新')
    }
    if (typeof pnpmPath !== 'string' || pnpmPath === '') {
      throw new UpdateError('UPDATE_PNPM_MISSING', '找不到 DSH 自带 pnpm，无法自动更新')
    }
    const latest = cache ? cache.latestVersion : null
    if (latest === null || latest === appliedVersion || compareVersions(latest, version) <= 0) {
      throw new UpdateError('UPDATE_NOT_AVAILABLE', '当前已是最新版本，或尚未检查到新版本')
    }
    busy = 'apply'
    try {
      const rawTag = cache && cache.rawTag ? cache.rawTag : `v${latest}`
      const spec = `${repo}#${rawTag}`
      const result = await runPnpm(spec, { cwd: profileDir })
      if (!result || result.ok !== true) {
        const detail = [
          result && result.message ? String(result.message) : '',
          result && result.stderr ? `stderr:\n${tail(result.stderr, 800)}` : '',
          result && result.stdout ? `stdout:\n${tail(result.stdout, 400)}` : '',
        ].filter((part) => part !== '').join('\n')
        throw new UpdateError('UPDATE_APPLY_FAILED', `安装新版本失败：${detail || 'pnpm add 执行失败'}`)
      }
      appliedVersion = latest
      restartRequired = true
      lastAppliedLog = tail(result.stdout, 400)
      cache = { checkedAt: now(), latestVersion: latest, rawTag, error: null }
      logger?.info?.(`[flowpilot] 已安装新版本 v${latest}，重启 DSH 后生效`)
      return status()
    } catch (error) {
      const wrapped = error instanceof UpdateError
        ? error
        : new UpdateError('UPDATE_APPLY_FAILED', String(error && error.message ? error.message : error))
      logger?.warn?.(`[flowpilot] 更新失败：${wrapped.message}`)
      throw wrapped
    } finally {
      busy = null
    }
  }

  function restart() {
    if (platform !== 'darwin') {
      throw new UpdateError('UPDATE_UNSUPPORTED', '当前运行环境不是 macOS，无法自动重启')
    }
    const out = restartApp(execPath)
    logger?.info?.(`[flowpilot] 正在重启 DSH（${out && out.app ? out.app : 'desktop'}）`)
    return { ok: true, restarting: true, app: out && out.app ? out.app : null }
  }

  /** 启动后 5s 静默检查一次，之后每 6h 检查一次；返回 dispose 函数。 */
  function start() {
    if (options.auto === false) return () => {}
    const startupDelayMs = Number(options.startupDelayMs) >= 0 ? Number(options.startupDelayMs) : 5000
    const intervalMs = Number(options.autoIntervalMs) > 0 ? Number(options.autoIntervalMs) : UPDATE_AUTO_INTERVAL_MS
    const quietCheck = () => {
      check().catch((error) => {
        logger?.warn?.(`[flowpilot] 自动检查更新失败（忽略）：${error && error.message ? error.message : error}`)
      })
    }
    const startupTimer = setTimeout(quietCheck, startupDelayMs)
    const intervalTimer = setInterval(quietCheck, intervalMs)
    if (typeof startupTimer.unref === 'function') startupTimer.unref()
    if (typeof intervalTimer.unref === 'function') intervalTimer.unref()
    return () => {
      clearTimeout(startupTimer)
      clearInterval(intervalTimer)
    }
  }

  return { status, check, apply, restart, start }
}
