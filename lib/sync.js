/**
 * FlowPilot 宿主半 · 双向同步（GitHub 仓库文件 / WebDAV）
 *
 * 归属：host-core
 * 用途：docs/SYNC.md 的宿主实现（§1 模型 / §2 路由数据 / §3 传输 / §4 宿主改动）：
 * - 配置与凭据只存本机 `~/.dsh/flowpilot/sync.json`（目录 0700、文件 0600），
 *   不进 data.json / 导出备份 / 远端；status 只回 credentialsSet 布尔。
 * - 远端只存「快照」（kind:'sync-snapshot'），本地 data.json 仍是唯一主库。
 * - 冲突判定严格按 §1.3（lastSyncedRevision 三路比较 + 首次同步规则），
 *   冲突 → SYNC_CONFLICT（HTTP 409，带 conflict 结构）。该三路比较仍可用
 *   `run({ mode: 'three-way' })` / force push|pull 触发（agent 工具与旧调用方依赖它）。
 * - 默认同步语义：**记录级三方合并（three-way merge）**——以 `sync-base.json`（公共祖先）为基准，
 *   按集合 / 记录 id / 字段做三方合并（两边改动都保留），真冲突按 lastTouch 决胜（平局 local）；
 *   events/handoffs/reports 求并集；合并后清理孤儿；先写 pre-merge 备份 → 本地 → 上传 → 更新 base。
 *   绝不 409。`mode:'newest'`（整份最新覆盖）与 `mode:'three-way'`（旧三路比较，deprecated）仍可用。
 * - 写后自动同步：`behavior.autoPushAfterWrite` 默认 **true**（旧 sync.json 缺该字段视为开启，
 *   显式 false 才关闭）。任何本地写（`POST /action`、`POST /ai/apply`、agent 工具）成功后，
 *   按 `behavior.debounceMs`（默认 3s）防抖触发一次 **newest 同步**（上传 + 必要时先拉取覆盖本地）；
 *   未配置通道 / provider=off 直接跳过；同步进行中再次触发只合并、结束后补跑一次；
 *   失败绝不抛给本地写，只记 lastError + warn 日志。
 * - 覆盖本地前先写 `~/.dsh/flowpilot/backups/pre-sync-<ISO>.json`（保留 10 份）。
 * - 传输：GitHub REST Contents API（base64 + sha 乐观并发）/ WebDAV（GET/PUT + If-Match，
 *   目录缺失时逐级 MKCOL 后重试一次；测试连接 PROPFIND，405/501 退化 OPTIONS）。
 * - 超时 15s / 请求；网络错误或 5xx 重试 2 次（300/900ms）。
 * - 错误码：SYNC_NOT_CONFIGURED / SYNC_AUTH_FAILED / SYNC_NETWORK / SYNC_REMOTE_INVALID /
 *   SYNC_CONFLICT / SYNC_LOCAL_WRITE_FAILED / INVALID_INPUT。
 *
 * 依赖策略（重要）：只 import `node:` 内置模块；HTTP 用全局 fetch；base64 用 Buffer。
 * 绝不 import 任何 npm 包（desktop profile 的 node_modules 里没有 @deepseek-ai/*）。
 * 本文件不 import util.js 的 FpError：FpError 会把未知错误码压成 INTERNAL，
 * 这里用自带的 SyncError 保留 SYNC_* 错误码（HTTP 层据此映射状态码）。
 */

import {
  chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync,
  unlinkSync, writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/* ------------------------------------------------------------------ *
 * 常量
 * ------------------------------------------------------------------ */

/** 同步快照格式版本（SYNC.md §1.2）。 */
export const SYNC_FORMAT_VERSION = 1

/** 支持的通道。 */
export const SYNC_PROVIDERS = Object.freeze(['off', 'github', 'webdav'])

/** 同步错误码（SYNC.md §2.4）。 */
export const SYNC_ERROR_CODES = Object.freeze([
  'SYNC_NOT_CONFIGURED',
  'SYNC_AUTH_FAILED',
  'SYNC_NETWORK',
  'SYNC_REMOTE_INVALID',
  'SYNC_CONFLICT',
  'SYNC_LOCAL_WRITE_FAILED',
  'INVALID_INPUT',
])

/** 同步错误码 → HTTP 状态码（SYNC.md §2.4）。 */
export const SYNC_ERROR_STATUS = Object.freeze({
  SYNC_NOT_CONFIGURED: 400,
  SYNC_AUTH_FAILED: 401,
  SYNC_NETWORK: 502,
  SYNC_REMOTE_INVALID: 422,
  SYNC_CONFLICT: 409,
  SYNC_LOCAL_WRITE_FAILED: 500,
  INVALID_INPUT: 400,
})

const PROVIDER_LABELS = Object.freeze({
  off: '未启用',
  github: 'GitHub 仓库',
  webdav: 'WebDAV',
})

/** 远端快照 state 必须包含的数组集合（SYNC.md §1.2 校验）。 */
const SYNC_COLLECTIONS = Object.freeze([
  'businessLines', 'projects', 'flows', 'nodes', 'dependencies', 'links', 'events', 'handoffs', 'reports',
])

const REQUEST_TIMEOUT_MS = 15_000
const RETRY_DELAYS_MS = Object.freeze([300, 900])
const MAX_BACKUPS = 10
const MAX_MKCOL_DEPTH = 5
const DEFAULT_DEBOUNCE_MS = 3000
const DEFAULT_API_BASE = 'https://api.github.com'
const DEFAULT_GITHUB_BRANCH = 'main'
const DEFAULT_GITHUB_PATH = 'flowpilot/data.json'
const DEFAULT_DAV_FILE = 'data.json'
const FALLBACK_VERSION = '1.0.0'

/* ------------------------------------------------------------------ *
 * 错误类型
 * ------------------------------------------------------------------ */

/**
 * 同步错误：带 SYNC.md §2.4 的错误码，HTTP 层用 SYNC_ERROR_STATUS 映射状态码。
 * 冲突错误额外带 `conflict`（本地/远端摘要 + options），供 HTTP 409 与工具返回。
 */
export class SyncError extends Error {
  /**
   * @param {string} code SYNC_* / INVALID_INPUT
   * @param {string} message 中文原因（直接给 UI / 模型看）
   * @param {{ conflict?: any }} [extra]
   */
  constructor(code, message, extra) {
    super(message)
    this.name = 'SyncError'
    this.code = SYNC_ERROR_CODES.includes(code) ? code : 'INTERNAL'
    if (extra && typeof extra === 'object' && extra.conflict !== undefined) this.conflict = extra.conflict
  }
}

export function isSyncError(error) {
  return error instanceof SyncError
}

/* ------------------------------------------------------------------ *
 * 小工具
 * ------------------------------------------------------------------ */

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function text(value) {
  return typeof value === 'string' ? value.trim() : ''
}

function errorText(error) {
  if (error instanceof Error) return error.message || String(error)
  return String(error)
}

function isoNow(clock) {
  const date = typeof clock === 'function' ? clock() : new Date()
  return (date instanceof Date && !Number.isNaN(date.getTime()) ? date : new Date()).toISOString()
}

function isoOrNull(value) {
  const textValue = text(value)
  if (textValue === '') return null
  const time = Date.parse(textValue)
  return Number.isNaN(time) ? null : textValue
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value))
}

function sleep(ms) {
  return new Promise((resolve) => { setTimeout(resolve, ms) })
}

function stripTrailingSlash(value) {
  return text(value).replace(/\/+$/, '')
}

function expandHome(value) {
  const raw = text(value)
  if (raw === '') return ''
  if (raw === '~') return homedir()
  if (raw.startsWith('~/') || raw.startsWith('~\\')) return join(homedir(), raw.slice(2))
  return raw
}

/** 日志脱敏：去掉 URL 里的 userinfo（token / password 只可能出现在 header，仍兜底一次）。 */
function sanitizeUrl(value) {
  try {
    const url = new URL(String(value))
    url.username = url.username ? '***' : ''
    url.password = url.password ? '***' : ''
    return url.toString()
  } catch {
    return String(value)
  }
}

function isHttpUrl(value) {
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}

function newDeviceId() {
  return `dev_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
}

function defaultSyncFile() {
  return join(homedir(), '.dsh', 'flowpilot', 'sync.json')
}

/** 默认配置（SYNC.md §1.1）。 */
function defaultConfig() {
  return {
    version: 1,
    provider: 'off',
    github: {
      owner: '',
      repo: '',
      branch: DEFAULT_GITHUB_BRANCH,
      path: DEFAULT_GITHUB_PATH,
      apiBase: DEFAULT_API_BASE,
      token: '',
    },
    webdav: { url: '', username: '', password: '', fileName: DEFAULT_DAV_FILE },
    // autoPushAfterWrite 默认开启（语义 = 写后自动同步 newest）；显式 false 才关闭。
    behavior: { autoPushAfterWrite: true, autoPullOnStart: false, debounceMs: DEFAULT_DEBOUNCE_MS },
    state: {
      deviceId: '',
      lastSyncedAt: null,
      lastSyncedRevision: null,
      lastRemoteRef: null,
      lastError: null,
      lastErrorAt: null,
    },
  }
}

function normalizeGithubPath(value) {
  return text(value).replace(/^\/+/, '') || DEFAULT_GITHUB_PATH
}

/** 把 sync.json 的任意形状补齐成契约形状（容忍旧文件 / 手改）。 */
export function normalizeSyncConfig(raw) {
  const base = defaultConfig()
  if (!isRecord(raw)) return base
  base.provider = SYNC_PROVIDERS.includes(raw.provider) ? raw.provider : 'off'

  const gh = isRecord(raw.github) ? raw.github : {}
  base.github = {
    owner: text(gh.owner),
    repo: text(gh.repo),
    branch: text(gh.branch) || DEFAULT_GITHUB_BRANCH,
    path: normalizeGithubPath(gh.path),
    apiBase: stripTrailingSlash(text(gh.apiBase) || DEFAULT_API_BASE),
    token: text(gh.token),
  }

  const dav = isRecord(raw.webdav) ? raw.webdav : {}
  base.webdav = {
    url: stripTrailingSlash(text(dav.url)),
    username: text(dav.username),
    password: text(dav.password),
    fileName: text(dav.fileName) || DEFAULT_DAV_FILE,
  }

  const behavior = isRecord(raw.behavior) ? raw.behavior : {}
  const debounceMs = Number(behavior.debounceMs)
  base.behavior = {
    // 默认开启：缺字段 / null 一律视为 true；只有显式 false 才关闭（兼容旧 sync.json 手动关闭）
    autoPushAfterWrite: behavior.autoPushAfterWrite !== false,
    autoPullOnStart: behavior.autoPullOnStart === true,
    debounceMs: Number.isFinite(debounceMs) && debounceMs >= 0 ? Math.min(debounceMs, 600_000) : DEFAULT_DEBOUNCE_MS,
  }

  const state = isRecord(raw.state) ? raw.state : {}
  // 注意：不能 Number(null)（=0），否则首次同步点 null 会被读回 0，破坏三路比较
  const lastSyncedRevision = Number.isInteger(state.lastSyncedRevision) && state.lastSyncedRevision >= 0
    ? state.lastSyncedRevision
    : null
  base.state = {
    deviceId: text(state.deviceId),
    lastSyncedAt: isoOrNull(state.lastSyncedAt),
    lastSyncedRevision,
    lastRemoteRef: text(state.lastRemoteRef) || null,
    lastError: text(state.lastError) || null,
    lastErrorAt: isoOrNull(state.lastErrorAt),
  }
  return base
}

/* ------------------------------------------------------------------ *
 * 远端快照
 * ------------------------------------------------------------------ */

function hasLocalData(state) {
  const businessLines = Array.isArray(state?.businessLines) ? state.businessLines.length : 0
  const projects = Array.isArray(state?.projects) ? state.projects.length : 0
  return businessLines > 0 || projects > 0
}

function countsOf(state) {
  const count = (key) => (Array.isArray(state?.[key]) ? state[key].length : 0)
  return {
    businessLines: count('businessLines'),
    projects: count('projects'),
    nodes: count('nodes'),
    events: count('events'),
  }
}

function buildSnapshot(local, deviceId, updatedAt) {
  const at = updatedAt ?? new Date().toISOString()
  return {
    formatVersion: SYNC_FORMAT_VERSION,
    app: 'flowpilot',
    kind: 'sync-snapshot',
    revision: local.revision,
    savedAt: at,
    updatedAt: at,
    deviceId: deviceId || null,
    state: local.state,
  }
}

/**
 * 校验远端快照（SYNC.md §1.2）：坏 JSON / 缺 state / revision 非整数 → SYNC_REMOTE_INVALID。
 * 返回可安全写入本地的 { revision, state, updatedAt, ... }。
 */
function parseRemoteSnapshot(info, options = {}) {
  const source = typeof options.source === 'string' && options.source !== '' ? options.source : '远端'
  if (!info || info.exists !== true) throw new SyncError('SYNC_REMOTE_INVALID', `${source}还没有同步快照`)
  let parsed
  try {
    parsed = JSON.parse(info.text)
  } catch {
    throw new SyncError('SYNC_REMOTE_INVALID', `${source}快照不是合法 JSON，已拒绝覆盖本地`)
  }
  if (!isRecord(parsed)) throw new SyncError('SYNC_REMOTE_INVALID', `${source}快照根节点不是对象，已拒绝覆盖本地`)
  const snapshotVersion = Number(parsed.formatVersion)
  if (parsed.formatVersion !== undefined && (!Number.isInteger(snapshotVersion) || snapshotVersion > SYNC_FORMAT_VERSION)) {
    throw new SyncError('SYNC_REMOTE_INVALID', `${source}快照版本不受支持（formatVersion=${String(parsed.formatVersion)}），已拒绝覆盖本地`)
  }
  if (!isRecord(parsed.state)) {
    throw new SyncError('SYNC_REMOTE_INVALID', `${source}快照缺少 state 对象，已拒绝覆盖本地`)
  }
  const stateVersion = Number(parsed.state.formatVersion)
  if (parsed.state.formatVersion !== undefined && (!Number.isInteger(stateVersion) || stateVersion > SYNC_FORMAT_VERSION)) {
    throw new SyncError('SYNC_REMOTE_INVALID', `${source}快照 state 版本不受支持，已拒绝覆盖本地`)
  }
  if (!Number.isInteger(parsed.revision) || parsed.revision < 0) {
    throw new SyncError('SYNC_REMOTE_INVALID', `${source}快照 revision 不是非负整数，已拒绝覆盖本地`)
  }
  for (const key of SYNC_COLLECTIONS) {
    if (!Array.isArray(parsed.state[key])) {
      throw new SyncError('SYNC_REMOTE_INVALID', `${source}快照 state.${key} 不是数组，已拒绝覆盖本地`)
    }
  }
  return {
    revision: parsed.revision,
    updatedAt: isoOrNull(parsed.updatedAt),
    savedAt: isoOrNull(parsed.savedAt),
    deviceId: text(parsed.deviceId) || null,
    state: parsed.state,
    bytes: Number.isInteger(info.bytes) ? info.bytes : Buffer.byteLength(info.text ?? ''),
    ref: info.ref ?? null,
  }
}

/* ------------------------------------------------------------------ *
 * 传输层：通用 HTTP
 * ------------------------------------------------------------------ */

/**
 * 带超时 / 重试的 fetch。网络错误或 5xx 重试 2 次（300/900ms）。
 * @returns {Promise<{status:number, headers:Record<string,string>, text:string}>}
 */
async function httpRequest(url, options = {}) {
  const method = options.method ?? 'GET'
  const headers = options.headers ?? {}
  const body = options.body
  const retries = Number.isInteger(options.retries) ? Math.max(0, options.retries) : RETRY_DELAYS_MS.length
  const attempts = retries + 1
  let lastError = null
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (attempt > 0) await sleep(RETRY_DELAYS_MS[Math.min(attempt - 1, RETRY_DELAYS_MS.length - 1)])
    const controller = new AbortController()
    const timer = setTimeout(() => { try { controller.abort() } catch { /* 忽略 */ } }, REQUEST_TIMEOUT_MS)
    try { timer.unref?.() } catch { /* 忽略 */ }
    try {
      const response = await fetch(url, { method, headers: { 'user-agent': syncUserAgent(), ...headers }, body, signal: controller.signal })
      const textBody = await response.text()
      if (response.status >= 500 && attempt < attempts - 1) {
        lastError = new SyncError('SYNC_NETWORK', `远端服务暂时不可用（HTTP ${response.status}）`)
        continue
      }
      const headerMap = {}
      try {
        response.headers.forEach((value, key) => { headerMap[String(key).toLowerCase()] = value })
      } catch { /* 忽略：headers 形状异常 */ }
      return { status: response.status, headers: headerMap, text: textBody }
    } catch (error) {
      const name = error?.name
      lastError = name === 'AbortError' || name === 'TimeoutError'
        ? new SyncError('SYNC_NETWORK', `请求超时（${Math.round(REQUEST_TIMEOUT_MS / 1000)}s）：${sanitizeUrl(url)}`)
        : new SyncError('SYNC_NETWORK', `网络请求失败：${sanitizeUrl(url)}（${errorText(error)}）`)
    } finally {
      clearTimeout(timer)
    }
  }
  throw lastError ?? new SyncError('SYNC_NETWORK', '网络请求失败')
}

let syncUserAgentVersion = FALLBACK_VERSION
function syncUserAgent() {
  return `dsh-flowpilot/${syncUserAgentVersion}`
}

/* ------------------------------------------------------------------ *
 * GitHub（REST Contents API，SYNC.md §3.1）
 * ------------------------------------------------------------------ */

function githubHeaders(cfg) {
  const headers = {
    accept: 'application/vnd.github+json',
    'x-github-api-version': '2022-11-28',
    'content-type': 'application/json',
  }
  if (cfg.github.token !== '') headers.authorization = `Bearer ${cfg.github.token}`
  return headers
}

function encodeGithubPath(path) {
  return text(path).split('/').filter((part) => part !== '').map((part) => encodeURIComponent(part)).join('/')
}

function githubContentUrl(cfg, { withRef = false } = {}) {
  const apiBase = stripTrailingSlash(cfg.github.apiBase) || DEFAULT_API_BASE
  const base = `${apiBase}/repos/${encodeURIComponent(cfg.github.owner)}/${encodeURIComponent(cfg.github.repo)}/contents/${encodeGithubPath(cfg.github.path)}`
  return withRef ? `${base}?ref=${encodeURIComponent(cfg.github.branch)}` : base
}

function authFailedError(action) {
  return new SyncError('SYNC_AUTH_FAILED', `${action}失败：凭据无效或没有权限（HTTP 401/403），请检查 Token`)
}

function remoteHttpError(action, res) {
  return new SyncError('SYNC_NETWORK', `${action}失败：远端返回 HTTP ${res?.status ?? '未知'}`)
}

function githubConflictError() {
  return new SyncError('SYNC_CONFLICT', '远端文件已被其他设备修改（并发写冲突），请重新同步后再试')
}

/** 读 GitHub 文件。返回 { exists, text, bytes, ref }；404 → {exists:false}。 */
async function githubRead(cfg) {
  const res = await httpRequest(githubContentUrl(cfg, { withRef: true }), { headers: githubHeaders(cfg) })
  if (res.status === 200) {
    let envelope
    try {
      envelope = JSON.parse(res.text)
    } catch {
      throw new SyncError('SYNC_REMOTE_INVALID', 'GitHub 返回的内容不是 JSON 响应')
    }
    if (!isRecord(envelope) || typeof envelope.content !== 'string') {
      throw new SyncError('SYNC_REMOTE_INVALID', 'GitHub 响应缺少 base64 content 字段')
    }
    const decoded = Buffer.from(envelope.content, 'base64').toString('utf8')
    return {
      exists: true,
      text: decoded,
      bytes: Buffer.byteLength(decoded),
      ref: text(envelope.sha) || null,
    }
  }
  if (res.status === 404) return { exists: false, text: '', bytes: 0, ref: null }
  if (res.status === 401 || res.status === 403) throw authFailedError('GitHub 读取')
  throw remoteHttpError('GitHub 读取', res)
}

/** 写 GitHub 文件（已有则带 sha 做乐观并发）。返回 { ref, bytes }。 */
async function githubWrite(cfg, fileText, { sha, message } = {}) {
  const payload = {
    message: text(message) || `FlowPilot 同步 r? (${cfg.state.deviceId || 'unknown'})`,
    content: Buffer.from(fileText, 'utf8').toString('base64'),
    branch: cfg.github.branch,
  }
  if (sha) payload.sha = sha
  const res = await httpRequest(githubContentUrl(cfg), {
    method: 'PUT',
    headers: githubHeaders(cfg),
    body: JSON.stringify(payload),
  })
  if (res.status === 200 || res.status === 201) {
    let envelope = null
    try { envelope = JSON.parse(res.text) } catch { /* 部分网关不回 JSON，按成功处理 */ }
    return {
      ref: text(envelope?.content?.sha) || text(envelope?.commit?.sha) || null,
      bytes: Buffer.byteLength(fileText),
    }
  }
  if (res.status === 409 || res.status === 412 || res.status === 422) throw githubConflictError()
  if (res.status === 401 || res.status === 403) throw authFailedError('GitHub 写入')
  throw remoteHttpError('GitHub 写入', res)
}

/* ------------------------------------------------------------------ *
 * WebDAV（SYNC.md §3.2）
 * ------------------------------------------------------------------ */

function davHeaders(cfg) {
  const headers = {}
  if (cfg.webdav.username !== '' || cfg.webdav.password !== '') {
    headers.authorization = `Basic ${Buffer.from(`${cfg.webdav.username}:${cfg.webdav.password}`).toString('base64')}`
  }
  return headers
}

function davDirUrl(cfg) {
  return stripTrailingSlash(cfg.webdav.url)
}

function davFileUrl(cfg) {
  return `${davDirUrl(cfg)}/${encodeURIComponent(cfg.webdav.fileName)}`
}

/** 目录 URL 的逐级祖先（浅 → 深，最多 MAX_MKCOL_DEPTH 层），用于 MKCOL 兜底。 */
function davParentDirs(cfg) {
  let url
  try {
    url = new URL(davDirUrl(cfg))
  } catch {
    return []
  }
  const segments = url.pathname.split('/').filter((part) => part !== '')
  const dirs = []
  for (let depth = 1; depth <= segments.length && dirs.length < MAX_MKCOL_DEPTH; depth += 1) {
    dirs.push(`${url.origin}/${segments.slice(0, depth).join('/')}`)
  }
  return dirs
}

/** 逐级 MKCOL（已存在返回 405 等一律忽略）；失败不阻断，随后重试一次 PUT。 */
async function davEnsureDirs(cfg) {
  const dirs = davParentDirs(cfg)
  if (dirs.length === 0) return
  const headers = davHeaders(cfg)
  for (const dir of dirs) {
    try {
      const res = await httpRequest(dir, { method: 'MKCOL', headers, retries: 0 })
      loggerDebug(`MKCOL ${sanitizeUrl(dir)} → HTTP ${res.status}`)
    } catch (error) {
      loggerDebug(`MKCOL ${sanitizeUrl(dir)} 失败（忽略并重试 PUT）：${errorText(error)}`)
    }
  }
}

/** WebDAV 连接测试：PROPFIND Depth:0；405/501 退化 OPTIONS。404 视为「服务器可达但目录缺失」。 */
async function davProbe(cfg) {
  const dirUrl = davDirUrl(cfg)
  const body = '<?xml version="1.0" encoding="utf-8"?><d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/></d:prop></d:propfind>'
  const res = await httpRequest(dirUrl, {
    method: 'PROPFIND',
    headers: { ...davHeaders(cfg), depth: '0', 'content-type': 'application/xml; charset=utf-8' },
    body,
  })
  if (res.status === 207 || res.status === 200) return { reachable: true, dirExists: true, via: 'propfind' }
  if (res.status === 404) return { reachable: true, dirExists: false, via: 'propfind' }
  if (res.status === 405 || res.status === 501) {
    const options = await httpRequest(dirUrl, { method: 'OPTIONS', headers: davHeaders(cfg) })
    if (options.status >= 200 && options.status < 400) return { reachable: true, dirExists: null, via: 'options' }
    if (options.status === 401 || options.status === 403) throw authFailedError('WebDAV 连接测试')
    throw remoteHttpError('WebDAV 连接测试', options)
  }
  if (res.status === 401 || res.status === 403) throw authFailedError('WebDAV 连接测试')
  throw remoteHttpError('WebDAV 连接测试', res)
}

/** 读 WebDAV 文件。返回 { exists, text, bytes, ref }；404 → {exists:false}。 */
async function davRead(cfg) {
  const res = await httpRequest(davFileUrl(cfg), { headers: davHeaders(cfg) })
  if (res.status === 200) {
    return {
      exists: true,
      text: res.text,
      bytes: Buffer.byteLength(res.text),
      ref: text(res.headers.etag) || text(res.headers['last-modified']) || null,
    }
  }
  if (res.status === 404) return { exists: false, text: '', bytes: 0, ref: null }
  if (res.status === 401 || res.status === 403) throw authFailedError('WebDAV 读取')
  if (res.status === 412) throw new SyncError('SYNC_CONFLICT', '远端文件已被修改（ETag 不匹配），请重新同步后再试')
  throw remoteHttpError('WebDAV 读取', res)
}

/** 写 WebDAV 文件：已知 ETag 用 If-Match，未知用 If-None-Match:*；404/409 时 MKCOL 后重试一次。 */
async function davWrite(cfg, fileText, { ref } = {}) {
  const url = davFileUrl(cfg)
  const headers = { ...davHeaders(cfg), 'content-type': 'application/json; charset=utf-8' }
  if (ref) headers['if-match'] = ref
  else headers['if-none-match'] = '*'
  const writeOnce = () => httpRequest(url, { method: 'PUT', headers, body: fileText })
  let res = await writeOnce()
  const okStatus = (status) => status === 200 || status === 201 || status === 204
  if (okStatus(res.status)) return { ref: text(res.headers.etag) || null, bytes: Buffer.byteLength(fileText) }
  if (res.status === 412) throw new SyncError('SYNC_CONFLICT', '远端文件已被修改（ETag 不匹配），请重新同步后再试')
  if (res.status === 404 || res.status === 409) {
    await davEnsureDirs(cfg)
    res = await writeOnce()
    if (okStatus(res.status)) return { ref: text(res.headers.etag) || null, bytes: Buffer.byteLength(fileText) }
    if (res.status === 412) throw new SyncError('SYNC_CONFLICT', '远端文件已被修改（ETag 不匹配），请重新同步后再试')
    if (res.status === 401 || res.status === 403) throw authFailedError('WebDAV 写入')
    if (res.status === 404 || res.status === 409) {
      throw new SyncError('SYNC_NETWORK', `WebDAV 写入失败：目录无法创建（HTTP ${res.status}），请检查目录 URL 与权限`)
    }
    throw remoteHttpError('WebDAV 写入', res)
  }
  if (res.status === 401 || res.status === 403) throw authFailedError('WebDAV 写入')
  throw remoteHttpError('WebDAV 写入', res)
}

let loggerRef = null
function loggerDebug(message) {
  try { loggerRef?.debug?.(`[flowpilot:sync] ${message}`) } catch { /* 忽略 */ }
}

/* ------------------------------------------------------------------ *
 * 冲突判定（SYNC.md §1.3）
 * ------------------------------------------------------------------ */

function summarizeLocal(local, updatedAt) {
  return {
    revision: local.revision,
    updatedAt: updatedAt ?? null,
    counts: countsOf(local.state),
  }
}

function summarizeRemote(remote) {
  if (!remote) return null
  return { revision: remote.revision, updatedAt: remote.updatedAt ?? null }
}

function makeConflict(local, remote, lastSyncedRevision, updatedAt) {
  return {
    local: summarizeLocal(local, updatedAt),
    remote: summarizeRemote(remote),
    lastSyncedRevision: lastSyncedRevision ?? null,
    options: ['push', 'pull'],
  }
}

function conflictError(conflict) {
  return new SyncError('SYNC_CONFLICT', '本地与远端都改过，请选择覆盖方向（用本地覆盖远端 / 用远端覆盖本地）', { conflict })
}

/**
 * 三路比较决定方向。返回 'push' | 'pull' | 'noop' | 'conflict'。
 * 首次同步（lastSyncedRevision === null）按 §1.3 末尾规则。
 */
function decideDirection(local, remote, lastSyncedRevision) {
  const localHas = hasLocalData(local.state)
  if (lastSyncedRevision === null) {
    if (!remote) return localHas ? 'push' : 'noop'
    const remoteHas = hasLocalData(remote.state)
    if (localHas && remoteHas) return 'conflict'
    if (remoteHas) return 'pull'
    if (localHas) return 'push'
    return 'noop'
  }
  if (!remote) {
    // 远端文件被删了：本地有数据就恢复上传；本地也空则无事可做
    return localHas ? 'push' : 'noop'
  }
  const remoteChanged = remote.revision !== lastSyncedRevision
  const localChanged = local.revision !== lastSyncedRevision
  if (remoteChanged && localChanged) return 'conflict'
  if (remoteChanged) return 'pull'
  if (localChanged) return 'push'
  return 'noop'
}

/* ------------------------------------------------------------------ *
 * 最新覆盖（newest-wins）判定
 * ------------------------------------------------------------------ */

/**
 * 远端快照的「更新时间」毫秒值：优先 updatedAt，缺失 / 非法时退回 savedAt。
 * 都没有 → null（调用方按「本地较新」处理）。
 */
function remoteSnapshotUpdatedAtMs(snapshot) {
  if (!snapshot) return null
  for (const candidate of [snapshot.updatedAt, snapshot.savedAt]) {
    const raw = text(candidate)
    if (raw === '') continue
    const ms = Date.parse(raw)
    if (Number.isFinite(ms)) return ms
  }
  return null
}

/**
 * 「云端和客户端双向检查，用最新的覆盖旧的」：
 * - 没有远端 → 上传（push）；
 * - 只有一边有业务数据 → 有数据的一方赢（避免新装空本地把云端数据覆盖掉）；
 * - 两边都有数据 → 比较时间戳：远端更新 → pull；双端时间戳 + revision 完全一致 → noop
 *   （本地与云端已一致，但仍会再上传一次）；否则（本地更新 / 任意一边无时间戳）→ push；
 * - 两者都无时间戳 → 视为本地较新 → push。
 * 返回 { direction: 'push' | 'pull' | 'noop', reason }，newest 模式永不返回冲突。
 */
function decideNewestDirection(local, remote, localMs, remoteMs) {
  const localHas = hasLocalData(local.state)
  if (!remote) return { direction: 'push', reason: 'no-remote' }
  const remoteHas = hasLocalData(remote.state)
  if (remoteHas && !localHas) return { direction: 'pull', reason: 'remote-has-data' }
  if (localHas && !remoteHas) return { direction: 'push', reason: 'local-has-data' }
  if (remoteMs === null) return { direction: 'push', reason: 'remote-timestamp-missing' }
  if (localMs === null) return { direction: 'pull', reason: 'local-timestamp-missing' }
  if (remoteMs > localMs) return { direction: 'pull', reason: 'remote-newer' }
  if (remoteMs === localMs && remote.revision === local.revision) {
    // 同一个快照（上传时 updatedAt 就取自本地 mtime）：内容一致，无需拉取，仍然回传一次
    return { direction: 'noop', reason: 'in-sync' }
  }
  return { direction: 'push', reason: 'local-newer' }
}

/* ------------------------------------------------------------------ *
 * 三方合并（three-way merge，记录级）
 * ------------------------------------------------------------------ */

/** 同步模式：merge=记录级三方合并（默认）；newest=整份「最新覆盖」；three-way=旧三路比较（deprecated）。 */
export const SYNC_RUN_MODES = Object.freeze(['merge', 'newest', 'three-way'])
export const DEFAULT_SYNC_RUN_MODE = 'merge'

/** 可变集合（逐记录 / 逐字段三方合并）。 */
const MUTABLE_COLLECTIONS = Object.freeze(['businessLines', 'projects', 'flows', 'nodes', 'dependencies', 'links'])
/** 追加型集合（求并集去重，不删除已有记录）。 */
const APPEND_ONLY_COLLECTIONS = Object.freeze(['events', 'handoffs', 'reports'])
/** 三方合并覆盖的全部集合（与快照校验用的 SYNC_COLLECTIONS 同一组）。 */
const MERGE_COLLECTIONS = SYNC_COLLECTIONS

/** 单值 ISO 时间 → 毫秒；非法 / 缺失 → 0。 */
function isoMillisOf(value) {
  if (typeof value !== 'string' || value.trim() === '') return 0
  const ms = Date.parse(value)
  return Number.isFinite(ms) ? ms : 0
}

/** 深比较（字段级三方判定用；对象 / 数组按内容比较）。 */
function equalValues(a, b) {
  if (a === b) return true
  if (a === null || b === null || a === undefined || b === undefined) return false
  if (typeof a !== typeof b) return false
  if (typeof a !== 'object') return false
  const aIsArray = Array.isArray(a)
  if (aIsArray !== Array.isArray(b)) return false
  if (aIsArray) {
    if (a.length !== b.length) return false
    for (let index = 0; index < a.length; index += 1) {
      if (!equalValues(a[index], b[index])) return false
    }
    return true
  }
  const aKeys = Object.keys(a)
  const bKeys = Object.keys(b)
  if (aKeys.length !== bKeys.length) return false
  for (const key of aKeys) {
    if (!Object.hasOwn(b, key)) return false
    if (!equalValues(a[key], b[key])) return false
  }
  return true
}

/**
 * 记录主键：优先 id；dependencies 没有 id，用 fromNodeId→toNodeId#relation 稳定合成；
 * 其它没有 id 的脏数据用 JSON 内容兜底（不丢记录）。
 */
function recordKeyOf(collection, record) {
  if (!isRecord(record)) return ''
  if (collection === 'dependencies') {
    return `${text(record.fromNodeId)}->${text(record.toNodeId)}#${text(record.relation) || 'sequence'}`
  }
  const id = typeof record.id === 'string' ? record.id.trim() : ''
  if (id !== '') return id
  try { return `anon:${JSON.stringify(record)}` } catch { return '' }
}

function indexRecordsById(collection, records) {
  const map = new Map()
  for (const record of Array.isArray(records) ? records : []) {
    const key = recordKeyOf(collection, record)
    if (key === '' || map.has(key)) continue
    map.set(key, record)
  }
  return map
}

/** 事件时间：优先 at，其次 timestamp（现有 state 的事件字段是 timestamp）。 */
function eventTouchMs(event) {
  if (!isRecord(event)) return 0
  return Math.max(isoMillisOf(event.at), isoMillisOf(event.timestamp))
}

/** 从 base/local/remote 的事件里建「被引用对象 → 最新事件时间」索引，供 lastTouch 使用。 */
function buildMergeTouchIndex(states) {
  const byNode = new Map()
  const byProject = new Map()
  const byFlow = new Map()
  const byLine = new Map()
  const projectLines = new Map()
  const bump = (map, key, ms) => {
    if (typeof key !== 'string' || key === '') return
    const current = map.get(key)
    if (!Number.isFinite(current) || ms > current) map.set(key, ms)
  }
  for (const state of states) {
    if (!isRecord(state)) continue
    for (const project of Array.isArray(state.projects) ? state.projects : []) {
      if (isRecord(project) && typeof project.id === 'string' && project.id !== ''
        && typeof project.businessLineId === 'string' && project.businessLineId !== '') {
        projectLines.set(project.id, project.businessLineId)
      }
    }
  }
  for (const state of states) {
    if (!isRecord(state)) continue
    for (const event of Array.isArray(state.events) ? state.events : []) {
      const ms = eventTouchMs(event)
      if (ms <= 0) continue
      bump(byNode, event.nodeId, ms)
      bump(byProject, event.projectId, ms)
      bump(byFlow, event.flowId, ms)
      bump(byLine, event.businessLineId, ms)
    }
  }
  return { byNode, byProject, byFlow, byLine, projectLines }
}

/**
 * 记录最后触碰时间：记录自带 updatedAt / createdAt / completedAt / confirmedAt / at 的最大值，
 * 再与引用它的事件时间取最大；都没有 → 0（旧数据）。
 */
function recordLastTouch(collection, record, touch) {
  if (!isRecord(record)) return 0
  let best = 0
  for (const key of ['updatedAt', 'createdAt', 'completedAt', 'confirmedAt', 'at']) {
    const ms = isoMillisOf(record[key])
    if (ms > best) best = ms
  }
  const bump = (map, key) => {
    if (typeof key !== 'string' || key === '') return
    const ms = map.get(key)
    if (Number.isFinite(ms) && ms > best) best = ms
  }
  if (collection === 'nodes') {
    bump(touch.byNode, record.id)
    bump(touch.byFlow, record.flowId)
    bump(touch.byProject, record.projectId)
  } else if (collection === 'projects') {
    bump(touch.byProject, record.id)
  } else if (collection === 'flows') {
    bump(touch.byFlow, record.id)
    bump(touch.byProject, record.projectId)
  } else if (collection === 'businessLines') {
    bump(touch.byLine, record.id)
    for (const [projectId, lineId] of touch.projectLines) {
      if (lineId === record.id) bump(touch.byProject, projectId)
    }
  } else if (collection === 'links') {
    bump(touch.byNode, record.nodeId)
  }
  // dependencies 没有自身时间戳，按 0 处理
  return best
}

function bumpCount(target, key) {
  target[key] = (target[key] ?? 0) + 1
}

/** 合并统计的空结构（added/updated/deleted/pruned 是 {集合: 计数}）。 */
function emptyMergeStats() {
  return { added: {}, updated: {}, deleted: {}, pruned: {}, conflicts: [], conflictDetails: [], resurrected: [] }
}

/** 人读的记录名称（冲突审阅面板展示用）：nodes=code+title / projects=title / businessLines=name / … */
function recordLabel(collection, record) {
  const str = (value) => (typeof value === 'string' && value.trim() !== '' ? value.trim() : '')
  if (!isRecord(record)) return collection
  if (collection === 'nodes') {
    const code = str(record.code)
    const title = str(record.title)
    if (code !== '' && title !== '') return `${code} ${title}`
    return code || title || str(record.id) || '节点'
  }
  if (collection === 'projects') return str(record.title) || str(record.id) || '项目'
  if (collection === 'businessLines') return str(record.name) || str(record.id) || '业务线'
  if (collection === 'flows') return str(record.name) || str(record.id) || '流程'
  if (collection === 'links') return str(record.title) || str(record.url) || str(record.id) || '链接'
  if (collection === 'dependencies') {
    return `${str(record.fromNodeId)} → ${str(record.toNodeId)}`
  }
  return str(record.title) || str(record.name) || str(record.id) || collection
}

/** 冲突审阅详情：与 conflicts 一一对应，额外带 label + 三方原始值（客户端逐条审阅用）。 */
function makeConflictDetail(collection, recordId, field, baseValue, localValue, remoteValue, winner, label) {
  const jsonValue = (value) => (value === undefined ? null : cloneJson(value))
  return {
    id: `${collection}:${recordId}:${field}`,
    collection,
    recordId,
    label: label === undefined ? collection : label,
    field,
    baseValue: jsonValue(baseValue),
    localValue: jsonValue(localValue),
    remoteValue: jsonValue(remoteValue),
    winner,
    missingInBase: baseValue === undefined,
    missingInLocal: localValue === undefined,
    missingInRemote: remoteValue === undefined,
  }
}

/** 给客户端看的合并统计视图：补上 merged.baseMissing（UI 用「首次合并，无历史基准」提示）。 */
function mergedStatsView(stats, baseMissing) {
  return { ...stats, baseMissing: baseMissing === true }
}

/** 字段级三方合并；真正「双改」的字段按 lastTouch 决胜并把冲突记进 stats.conflicts。 */
function mergeRecordFields(collection, id, baseRecord, localRecord, remoteRecord, localWins, stats) {
  const out = {}
  const keys = new Set()
  for (const record of [baseRecord, localRecord, remoteRecord]) {
    if (isRecord(record)) for (const key of Object.keys(record)) keys.add(key)
  }
  for (const key of keys) {
    const baseValue = baseRecord ? baseRecord[key] : undefined
    const localValue = localRecord ? localRecord[key] : undefined
    const remoteValue = remoteRecord ? remoteRecord[key] : undefined
    let value
    if (equalValues(localValue, remoteValue)) {
      value = localValue
    } else if (equalValues(localValue, baseValue)) {
      value = remoteValue
    } else if (equalValues(remoteValue, baseValue)) {
      value = localValue
    } else {
      value = localWins ? localValue : remoteValue
      const winner = localWins ? 'local' : 'remote'
      stats.conflicts.push({ collection, id, field: key, winner })
      stats.conflictDetails.push(makeConflictDetail(
        collection, id, key, baseValue, localValue, remoteValue, winner,
        recordLabel(collection, localRecord || remoteRecord || baseRecord),
      ))
    }
    if (value !== undefined) out[key] = cloneJson(value)
  }
  return out
}

/** settings 逐 key 三方；dataFile 强制用本地（机器本地路径）；真冲突 local 优先并记 conflict。 */
function mergeSettingsThreeWay(baseSettings, localSettings, remoteSettings, stats) {
  const out = {}
  const keys = new Set([...Object.keys(baseSettings), ...Object.keys(localSettings), ...Object.keys(remoteSettings)])
  for (const key of keys) {
    const baseValue = baseSettings[key]
    const localValue = localSettings[key]
    const remoteValue = remoteSettings[key]
    if (key === 'dataFile') {
      const value = localValue !== undefined ? localValue : remoteValue
      if (value !== undefined) out[key] = cloneJson(value)
      continue
    }
    let value
    if (equalValues(localValue, remoteValue)) {
      value = localValue
    } else if (equalValues(localValue, baseValue)) {
      value = remoteValue
    } else if (equalValues(remoteValue, baseValue)) {
      value = localValue
    } else {
      value = localValue
      stats.conflicts.push({ collection: 'settings', id: 'settings', field: key, winner: 'local' })
      stats.conflictDetails.push(makeConflictDetail(
        'settings', 'settings', key, baseValue, localValue, remoteValue, 'local', key,
      ))
    }
    if (value !== undefined) out[key] = cloneJson(value)
  }
  return out
}

function compareAppendOnly(collection, a, b) {
  if (collection === 'events') {
    const diff = eventTouchMs(a) - eventTouchMs(b)
    if (diff !== 0) return diff
  } else if (collection === 'handoffs') {
    const da = text(a.date)
    const db = text(b.date)
    if (da !== db) return da < db ? -1 : 1
  } else if (collection === 'reports') {
    const wa = text(a.weekStart)
    const wb = text(b.weekStart)
    if (wa !== wb) return wa < wb ? -1 : 1
  }
  const ia = text(a.id)
  const ib = text(b.id)
  return ia < ib ? -1 : ia > ib ? 1 : 0
}

/** 合并后清理孤儿：nodes/flows 无项目、links 无节点、dependencies 端点缺失；事件/handoff 按 base 引用级联。 */
function pruneMergedOrphans(merged, baseState, stats) {
  const baseCollections = {}
  for (const collection of MERGE_COLLECTIONS) {
    baseCollections[collection] = Array.isArray(baseState?.[collection]) ? baseState[collection] : []
  }
  const idSet = (collection, records) => {
    const set = new Set()
    for (const record of records) {
      const key = recordKeyOf(collection, record)
      if (key !== '') set.add(key)
    }
    return set
  }
  const baseProjectIds = idSet('projects', baseCollections.projects)
  const baseFlowIds = idSet('flows', baseCollections.flows)
  const baseNodeIds = idSet('nodes', baseCollections.nodes)

  const projectIds = idSet('projects', merged.projects)
  merged.nodes = merged.nodes.filter((node) => {
    if (projectIds.has(text(node.projectId))) return true
    bumpCount(stats.pruned, 'nodes')
    return false
  })
  merged.flows = merged.flows.filter((flow) => {
    if (projectIds.has(text(flow.projectId))) return true
    bumpCount(stats.pruned, 'flows')
    return false
  })
  const nodeIds = idSet('nodes', merged.nodes)
  const flowIds = idSet('flows', merged.flows)
  merged.links = merged.links.filter((link) => {
    if (nodeIds.has(text(link.nodeId))) return true
    bumpCount(stats.pruned, 'links')
    return false
  })
  merged.dependencies = merged.dependencies.filter((dep) => {
    if (nodeIds.has(text(dep.fromNodeId)) && nodeIds.has(text(dep.toNodeId))) return true
    bumpCount(stats.pruned, 'dependencies')
    return false
  })
  merged.events = merged.events.filter((event) => {
    if (isRecord(event)) {
      if (text(event.projectId) !== '' && baseProjectIds.has(event.projectId) && !projectIds.has(event.projectId)) {
        bumpCount(stats.pruned, 'events')
        return false
      }
      if (text(event.flowId) !== '' && baseFlowIds.has(event.flowId) && !flowIds.has(event.flowId)) {
        bumpCount(stats.pruned, 'events')
        return false
      }
      if (text(event.nodeId) !== '' && baseNodeIds.has(event.nodeId) && !nodeIds.has(event.nodeId)) {
        bumpCount(stats.pruned, 'events')
        return false
      }
    }
    return true
  })
  const keptHandoffs = []
  for (const handoff of merged.handoffs) {
    const ids = Array.isArray(handoff.nodeIds) ? handoff.nodeIds : null
    if (ids === null) { keptHandoffs.push(handoff); continue }
    const remaining = ids.filter((nodeId) => !(baseNodeIds.has(text(nodeId)) && !nodeIds.has(text(nodeId))))
    if (remaining.length === ids.length) { keptHandoffs.push(handoff); continue }
    if (remaining.length === 0 && ids.length > 0) { bumpCount(stats.pruned, 'handoffs'); continue }
    keptHandoffs.push({ ...handoff, nodeIds: remaining })
  }
  merged.handoffs = keptHandoffs
}

/**
 * 记录级三方合并（纯函数）：以 base 为公共祖先，合并 local / remote 两份 state。
 * - 可变集合：字段级三方；真冲突按 lastTouch 决胜（平局 local）；删除 / 复活规则见任务书。
 * - 追加型集合：并集去重（events 按时间、handoffs 按 date、reports 按 weekStart 稳定排序）。
 * - settings：逐 key 三方，dataFile 强制本地，真冲突 local 优先。
 * - 合并后清理孤儿（nodes/flows/links/dependencies；events/handoffs 按 base 引用级联）。
 * @returns {{ state: any, stats: { added: Record<string, number>, updated: Record<string, number>,
 *   deleted: Record<string, number>, pruned: Record<string, number>,
 *   conflicts: {collection:string,id:string,field:string,winner:'local'|'remote'}[],
 *   resurrected: {collection:string,id:string}[] } }}
 */
export function mergeThreeWay(baseState, localState, remoteState) {
  const base = isRecord(baseState) ? baseState : {}
  const local = isRecord(localState) ? localState : {}
  const remote = isRecord(remoteState) ? remoteState : {}
  const stats = emptyMergeStats()
  // lastTouch 按「各自一侧」的事件索引计算：本地只看本地事件、远端只看远端事件、base 只看 base 事件，
  // 否则 union 之后两边拿到的引用时间相同，冲突永远平局。
  const baseTouch = buildMergeTouchIndex([base])
  const localTouch = buildMergeTouchIndex([local])
  const remoteTouch = buildMergeTouchIndex([remote])
  const merged = {}

  for (const collection of MUTABLE_COLLECTIONS) {
    const baseMap = indexRecordsById(collection, base[collection])
    const localMap = indexRecordsById(collection, local[collection])
    const remoteMap = indexRecordsById(collection, remote[collection])
    const keys = new Set([...baseMap.keys(), ...localMap.keys(), ...remoteMap.keys()])
    const records = []
    for (const id of keys) {
      const baseRecord = baseMap.get(id) ?? null
      const localRecord = localMap.get(id) ?? null
      const remoteRecord = remoteMap.get(id) ?? null
      if (localRecord && remoteRecord) {
        const localWins = recordLastTouch(collection, localRecord, localTouch)
          >= recordLastTouch(collection, remoteRecord, remoteTouch)
        const mergedRecord = mergeRecordFields(collection, id, baseRecord, localRecord, remoteRecord, localWins, stats)
        records.push(mergedRecord)
        if (!baseRecord) bumpCount(stats.added, collection)
        else if (!equalValues(baseRecord, mergedRecord)) bumpCount(stats.updated, collection)
        continue
      }
      if (localRecord || remoteRecord) {
        const side = localRecord || remoteRecord
        const sideTouch = recordLastTouch(collection, side, localRecord ? localTouch : remoteTouch)
        if (!baseRecord) {
          records.push(cloneJson(side))
          bumpCount(stats.added, collection)
          continue
        }
        const baseRecordTouch = recordLastTouch(collection, baseRecord, baseTouch)
        if (sideTouch > baseRecordTouch) {
          // 一边删、另一边在删除之后还改过 → 复活（不被误删）
          records.push(cloneJson(side))
          stats.resurrected.push({ collection, id })
        } else {
          bumpCount(stats.deleted, collection)
        }
        continue
      }
      // 两侧都没有：双方都删除（或本来就只在 base 里后被两边删掉）
      if (baseRecord) bumpCount(stats.deleted, collection)
    }
    merged[collection] = records
  }

  for (const collection of APPEND_ONLY_COLLECTIONS) {
    const baseMap = indexRecordsById(collection, base[collection])
    const localMap = indexRecordsById(collection, local[collection])
    const remoteMap = indexRecordsById(collection, remote[collection])
    const union = new Map(baseMap)
    for (const [id, record] of remoteMap) union.set(id, record)
    for (const [id, record] of localMap) union.set(id, record) // 本地优先
    for (const id of union.keys()) if (!baseMap.has(id)) bumpCount(stats.added, collection)
    merged[collection] = [...union.values()]
      .sort((a, b) => compareAppendOnly(collection, a, b))
      .map((record) => cloneJson(record))
  }

  pruneMergedOrphans(merged, base, stats)

  const settings = mergeSettingsThreeWay(
    isRecord(base.settings) ? base.settings : {},
    isRecord(local.settings) ? local.settings : {},
    isRecord(remote.settings) ? remote.settings : {},
    stats,
  )
  const state = { ...cloneJson(local), settings }
  for (const collection of MERGE_COLLECTIONS) state[collection] = merged[collection]
  return { state, stats }
}

/** merge 模式的嵌套 result 视图（客户端读 result.merged / result.mergedRevision 等）。 */
function mergeResultView(out) {
  return {
    mode: 'merge',
    direction: out.direction,
    action: out.action,
    uploaded: out.uploaded === true,
    localRevision: out.localRevision ?? null,
    remoteRevision: out.remoteRevision ?? null,
    mergedRevision: out.mergedRevision ?? null,
    localUpdatedAt: out.localUpdatedAt ?? null,
    remoteUpdatedAt: out.remoteUpdatedAt ?? null,
    baseMissing: out.baseMissing === true,
    merged: out.merged ?? emptyMergeStats(),
    conflictDetails: Array.isArray(out.conflictDetails) ? out.conflictDetails : [],
    backupPath: out.backupPath ?? null,
    basePath: out.basePath ?? null,
    dryRun: out.dryRun === true,
  }
}

/* ------------------------------------------------------------------ *
 * 服务
 * ------------------------------------------------------------------ */

/**
 * 创建同步 service（HTTP 路由与 agent 工具共用，SYNC.md §4）。
 * @param {{
 *   engine: any,
 *   store?: any,
 *   logger?: any,
 *   config?: { syncFile?: string, version?: string, now?: () => Date },
 * }} options
 */
export function createSyncService(options = {}) {
  const engine = options.engine
  if (!engine || typeof engine.snapshot !== 'function') {
    throw new Error('createSyncService 需要 engine（createEngine 的返回值）')
  }
  const logger = options.logger
  const clock = typeof options.config?.now === 'function' ? options.config.now : null
  const dataStore = options.store && typeof options.store.save === 'function' ? options.store : engine.store
  const dataFile = dataStore?.dataFile ?? ''
  const dataDir = dataStore?.dataDir ?? (dataFile ? dirname(dataFile) : dirname(defaultSyncFile()))
  const syncFilePath = expandHome(options.config?.syncFile) || join(dataDir, 'sync.json')
  const backupDirPath = join(dataDir, 'backups')
  // 三方合并的公共祖先快照：与 sync.json 同目录（默认 ~/.dsh/flowpilot/sync-base.json）
  const baseFilePath = join(dirname(syncFilePath), 'sync-base.json')
  // 待审阅冲突（merge 自动解决后的候选值）：与 sync.json 同目录（默认 sync-conflicts.json）
  const conflictsFilePath = join(dirname(syncFilePath), 'sync-conflicts.json')
  syncUserAgentVersion = text(options.config?.version) || FALLBACK_VERSION
  loggerRef = logger ?? null

  /* ---------- 配置读写（目录 0700 / 文件 0600） ---------- */

  // sync.json 尚未创建时，status() 多次调用也要给出同一个 deviceId（首次 persist 后以文件为准）
  let deviceIdCache = ''

  function loadConfig() {
    let raw = null
    try {
      if (existsSync(syncFilePath)) raw = JSON.parse(readFileSync(syncFilePath, 'utf8'))
    } catch (error) {
      logger?.warn?.(`[flowpilot:sync] 读取同步配置失败（按未配置处理）：${errorText(error)}`)
      raw = null
    }
    const cfg = normalizeSyncConfig(raw)
    if (cfg.state.deviceId === '') {
      if (deviceIdCache === '') deviceIdCache = newDeviceId()
      cfg.state.deviceId = deviceIdCache
    } else {
      deviceIdCache = cfg.state.deviceId
    }
    return cfg
  }

  function persistConfig(cfg) {
    const dir = dirname(syncFilePath)
    const tmp = `${syncFilePath}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`
    try {
      mkdirSync(dir, { recursive: true, mode: 0o700 })
      try { chmodSync(dir, 0o700) } catch { /* 目录权限失败不阻断（如 Windows） */ }
      const body = JSON.stringify(cfg, null, 2)
      writeFileSync(tmp, body, { encoding: 'utf8', mode: 0o600 })
      try { chmodSync(tmp, 0o600) } catch { /* 同上 */ }
      renameSync(tmp, syncFilePath)
      try { chmodSync(syncFilePath, 0o600) } catch { /* 同上 */ }
    } catch (error) {
      try { if (existsSync(tmp)) unlinkSync(tmp) } catch { /* 忽略 */ }
      throw new SyncError('SYNC_LOCAL_WRITE_FAILED', `保存同步配置失败：${syncFilePath}（${errorText(error)}）`)
    }
  }

  /* ---------- 本地数据读取 ---------- */

  function readLocal() {
    const snapshot = engine.snapshot()
    return { revision: snapshot.revision, state: snapshot.state }
  }

  function localUpdatedAt() {
    if (dataFile === '') return null
    try { return statSync(dataFile).mtime.toISOString() } catch { return null }
  }

  /**
   * 本地数据文件 mtime（毫秒）；文件不存在 / 不可读 → null（newest 模式按本地较新处理或走数据量兜底）。
   * 注意取整到毫秒：上传快照的 updatedAt 来自 `mtime.toISOString()`（毫秒精度），
   * 这里必须同精度比较，否则「刚上传完」会被算成云端新 1ms，导致每次同步都白拉一次。
   */
  function localUpdatedAtMs() {
    if (dataFile === '') return null
    try {
      const stats = statSync(dataFile)
      if (Number.isFinite(stats.mtimeMs)) return Math.round(stats.mtimeMs)
      const ms = stats.mtime instanceof Date ? stats.mtime.getTime() : NaN
      return Number.isFinite(ms) ? ms : null
    } catch { return null }
  }

  /* ---------- 配置状态判断 ---------- */

  function isConfigured(cfg) {
    if (cfg.provider === 'github') {
      return Boolean(cfg.github.owner && cfg.github.repo && cfg.github.branch && cfg.github.path && cfg.github.token)
    }
    if (cfg.provider === 'webdav') return Boolean(cfg.webdav.url && cfg.webdav.fileName)
    return false
  }

  function credentialsSet(cfg) {
    if (cfg.provider === 'github') return cfg.github.token !== ''
    // WebDAV 允许匿名（无需凭据），「已存凭据」以是否保存了密码为准
    if (cfg.provider === 'webdav') return cfg.webdav.password !== ''
    return false
  }

  function remoteTargetOf(cfg) {
    if (cfg.provider === 'github') {
      if (cfg.github.owner === '' || cfg.github.repo === '') return null
      return `${cfg.github.owner}/${cfg.github.repo}@${cfg.github.branch}:${cfg.github.path}`
    }
    if (cfg.provider === 'webdav') {
      if (cfg.webdav.url === '') return null
      return `${davDirUrl(cfg)}/${cfg.webdav.fileName}`
    }
    return null
  }

  /**
   * status.config 的非敏感回显（供设置面板回填表单）。
   * 绝不包含 token / password；凭据是否已存只看 credentialsSet / githubCredentialsSet / webdavCredentialsSet。
   */
  function publicConfigOf(cfg) {
    return {
      provider: cfg.provider,
      github: {
        owner: cfg.github.owner,
        repo: cfg.github.repo,
        branch: cfg.github.branch,
        path: cfg.github.path,
        apiBase: cfg.github.apiBase,
      },
      webdav: {
        url: cfg.webdav.url,
        username: cfg.webdav.username,
        fileName: cfg.webdav.fileName,
      },
      behavior: {
        autoPushAfterWrite: cfg.behavior.autoPushAfterWrite,
        autoPullOnStart: cfg.behavior.autoPullOnStart,
      },
    }
  }

  function requireConfigured() {
    const cfg = loadConfig()
    if (isConfigured(cfg)) return cfg
    const message = cfg.provider === 'off'
      ? '尚未启用同步通道，请先选择 GitHub 仓库或 WebDAV 并保存配置'
      : '同步配置不完整（缺必填字段或凭据），请补全后再试'
    throw new SyncError('SYNC_NOT_CONFIGURED', message)
  }

  /* ---------- 错误记账 ---------- */

  function recordError(error) {
    try {
      const cfg = loadConfig()
      cfg.state.lastError = errorText(error)
      cfg.state.lastErrorAt = isoNow(clock)
      persistConfig(cfg)
    } catch { /* 记账失败不影响主流程 */ }
    logger?.warn?.(`[flowpilot:sync] ${errorText(error)}`)
  }

  function clearError() {
    try {
      const cfg = loadConfig()
      if (cfg.state.lastError === null && cfg.state.lastErrorAt === null) return
      cfg.state.lastError = null
      cfg.state.lastErrorAt = null
      persistConfig(cfg)
    } catch { /* 忽略 */ }
  }

  /* ---------- 备份（覆盖本地前） ---------- */

  function writeBackup() {
    try {
      mkdirSync(backupDirPath, { recursive: true, mode: 0o700 })
      const stamp = new Date().toISOString().replace(/[:.]/g, '-')
      let file = join(backupDirPath, `pre-sync-${stamp}.json`)
      let seq = 1
      while (existsSync(file) && seq < 100) {
        file = join(backupDirPath, `pre-sync-${stamp}-${seq}.json`)
        seq += 1
      }
      let payload
      if (typeof dataStore.exportPayload === 'function') {
        payload = dataStore.exportPayload()
      } else {
        const local = readLocal()
        payload = {
          formatVersion: SYNC_FORMAT_VERSION,
          app: 'flowpilot',
          kind: 'backup',
          exportedAt: isoNow(clock),
          revision: local.revision,
          state: local.state,
        }
      }
      writeFileSync(file, JSON.stringify(payload, null, 2), { encoding: 'utf8', mode: 0o600 })
      try { chmodSync(file, 0o600) } catch { /* 忽略 */ }
      pruneBackups()
      return file
    } catch (error) {
      throw new SyncError('SYNC_LOCAL_WRITE_FAILED', `写入同步前备份失败：${errorText(error)}`)
    }
  }

  /** 只保留最近 MAX_BACKUPS 份 pre-sync 备份。 */
  function pruneBackups() {
    try {
      const names = readdirSync(backupDirPath).filter((name) => name.startsWith('pre-sync-') && name.endsWith('.json'))
      if (names.length <= MAX_BACKUPS) return
      const entries = names.map((name) => {
        const full = join(backupDirPath, name)
        let mtime = 0
        try { mtime = statSync(full).mtimeMs } catch { /* 忽略 */ }
        return { name, mtime }
      })
      entries.sort((a, b) => a.mtime - b.mtime)
      for (const entry of entries.slice(0, entries.length - MAX_BACKUPS)) {
        try { unlinkSync(join(backupDirPath, entry.name)) } catch { /* 忽略 */ }
      }
    } catch { /* 忽略：备份目录不可读时不影响主流程 */ }
  }

  /* ---------- base 快照（三方合并的公共祖先） ---------- */

  /** 读 base：缺失 / 损坏 / 形状不认识 → null（调用方走降级逻辑）；读取失败只 warn。 */
  function readBase() {
    try {
      if (!existsSync(baseFilePath)) return null
      const parsed = JSON.parse(readFileSync(baseFilePath, 'utf8'))
      if (!isRecord(parsed) || parsed.kind !== 'sync-base' || !isRecord(parsed.state)) {
        logger?.warn?.(`[flowpilot:sync] ${baseFilePath} 形状不认识，按缺失处理`)
        return null
      }
      return {
        revision: Number.isInteger(parsed.revision) && parsed.revision >= 0 ? parsed.revision : null,
        savedAt: isoOrNull(parsed.savedAt),
        state: parsed.state,
      }
    } catch (error) {
      logger?.warn?.(`[flowpilot:sync] 读取 base 快照失败（按缺失处理）：${errorText(error)}`)
      return null
    }
  }

  /** 写 base：原子写 + 0600；失败只 warn，不影响同步结果。 */
  function writeBase(state, revision) {
    try {
      mkdirSync(dirname(baseFilePath), { recursive: true, mode: 0o700 })
      const payload = {
        formatVersion: SYNC_FORMAT_VERSION,
        kind: 'sync-base',
        revision: Number.isInteger(revision) && revision >= 0 ? revision : 0,
        savedAt: isoNow(clock),
        state,
      }
      const tmp = `${baseFilePath}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`
      writeFileSync(tmp, JSON.stringify(payload, null, 2), { encoding: 'utf8', mode: 0o600 })
      try { chmodSync(tmp, 0o600) } catch { /* 忽略 */ }
      renameSync(tmp, baseFilePath)
      try { chmodSync(baseFilePath, 0o600) } catch { /* 忽略 */ }
    } catch (error) {
      logger?.warn?.(`[flowpilot:sync] 写入 base 快照失败（不影响同步）：${errorText(error)}`)
    }
  }

  /** 合并前备份（三方原始 state）；失败 → SYNC_LOCAL_WRITE_FAILED。保留最近 10 份 pre-merge。 */
  function writeMergeBackup(info) {
    try {
      mkdirSync(backupDirPath, { recursive: true, mode: 0o700 })
      const stamp = new Date().toISOString().replace(/[:.]/g, '-')
      let file = join(backupDirPath, `pre-merge-${stamp}.json`)
      let seq = 1
      while (existsSync(file) && seq < 100) {
        file = join(backupDirPath, `pre-merge-${stamp}-${seq}.json`)
        seq += 1
      }
      const payload = {
        formatVersion: SYNC_FORMAT_VERSION,
        app: 'flowpilot',
        kind: 'pre-merge',
        savedAt: isoNow(clock),
        localRevision: info.localRevision ?? null,
        remoteRevision: info.remoteRevision ?? null,
        baseRevision: info.baseRevision ?? null,
        baseMissing: info.baseMissing === true,
        local: cloneJson(info.local ?? null),
        remote: cloneJson(info.remote ?? null),
        base: info.base ? cloneJson(info.base) : null,
      }
      writeFileSync(file, JSON.stringify(payload, null, 2), { encoding: 'utf8', mode: 0o600 })
      try { chmodSync(file, 0o600) } catch { /* 忽略 */ }
      pruneMergeBackups()
      return file
    } catch (error) {
      throw new SyncError('SYNC_LOCAL_WRITE_FAILED', `写入合并前备份失败：${errorText(error)}`)
    }
  }

  /** 只保留最近 MAX_BACKUPS 份 pre-merge 备份（前缀独立，与 pre-sync 互不影响）。 */
  function pruneMergeBackups() {
    try {
      const names = readdirSync(backupDirPath).filter((name) => name.startsWith('pre-merge-') && name.endsWith('.json'))
      if (names.length <= MAX_BACKUPS) return
      const entries = names.map((name) => {
        const full = join(backupDirPath, name)
        let mtime = 0
        try { mtime = statSync(full).mtimeMs } catch { /* 忽略 */ }
        return { name, mtime }
      })
      entries.sort((a, b) => a.mtime - b.mtime)
      for (const entry of entries.slice(0, entries.length - MAX_BACKUPS)) {
        try { unlinkSync(join(backupDirPath, entry.name)) } catch { /* 忽略 */ }
      }
    } catch { /* 忽略：备份目录不可读时不影响主流程 */ }
  }

  /* ---------- 远端读写 ---------- */

  async function readRemote(cfg) {
    return cfg.provider === 'github' ? githubRead(cfg) : davRead(cfg)
  }

  async function readRemoteSnapshot(cfg) {
    const info = await readRemote(cfg)
    if (!info.exists) return { info, snapshot: null }
    const source = cfg.provider === 'github' ? 'GitHub 远端' : 'WebDAV 远端'
    return { info, snapshot: parseRemoteSnapshot(info, { source }) }
  }

  async function writeRemote(cfg, fileText, remoteSnapshot, revision) {
    if (cfg.provider === 'github') {
      return githubWrite(cfg, fileText, {
        sha: remoteSnapshot?.ref ?? null,
        message: `FlowPilot 同步 r${revision}（${cfg.state.deviceId}）`,
      })
    }
    return davWrite(cfg, fileText, { ref: remoteSnapshot?.ref ?? null })
  }

  /* ---------- 执行 push / pull ---------- */

  async function executePush(cfg, local, remoteSnapshot) {
    const updatedAt = localUpdatedAt()
    const snapshot = buildSnapshot(local, cfg.state.deviceId, updatedAt)
    const fileText = JSON.stringify(snapshot)
    const written = await writeRemote(cfg, fileText, remoteSnapshot, local.revision)
    const next = loadConfig()
    next.state.lastSyncedRevision = local.revision
    next.state.lastSyncedAt = isoNow(clock)
    next.state.lastRemoteRef = written?.ref ?? null
    next.state.lastError = null
    next.state.lastErrorAt = null
    persistConfig(next)
    // 每次成功上传后刷新 base（三方合并的公共祖先 = 刚上传的 state）
    writeBase(local.state, local.revision)
    return {
      action: 'push',
      revision: local.revision,
      remote: {
        revision: local.revision,
        updatedAt: snapshot.updatedAt,
        ref: written?.ref ?? null,
        bytes: written?.bytes ?? Buffer.byteLength(fileText),
      },
      bytes: written?.bytes ?? Buffer.byteLength(fileText),
    }
  }

  async function executePull(cfg, local, remoteSnapshot) {
    const backupPath = writeBackup()
    try {
      dataStore.save(cloneJson(remoteSnapshot.state), remoteSnapshot.revision)
    } catch (error) {
      throw new SyncError('SYNC_LOCAL_WRITE_FAILED', `覆盖本地数据失败：${errorText(error)}`)
    }
    const next = loadConfig()
    next.state.lastSyncedRevision = remoteSnapshot.revision
    next.state.lastSyncedAt = isoNow(clock)
    next.state.lastRemoteRef = remoteSnapshot.ref ?? null
    next.state.lastError = null
    next.state.lastErrorAt = null
    persistConfig(next)
    // 拉取成功后 base = 远端快照（下一次三方合并的公共祖先）
    writeBase(remoteSnapshot.state, remoteSnapshot.revision)
    return {
      action: 'pull',
      revision: remoteSnapshot.revision,
      applied: true,
      backupPath,
      appliedRevision: remoteSnapshot.revision,
      remote: summarizeRemote(remoteSnapshot),
    }
  }

  /* ---------- 执行 newest（最新覆盖 + 每次都上传） ---------- */

  /**
   * 最新覆盖同步：拉远端 → 比较本地 mtime / 远端 updatedAt → 远端更新则覆盖本地
   * （备份 + 快照校验沿用 executePull）→ **随后无条件上传当前本地快照**。
   * @returns {Promise<{
   *   mode: 'newest', action: 'push'|'pull', direction: 'push'|'pull',
   *   uploaded: boolean, localRevision: number, remoteRevision: number|null,
   *   localUpdatedAt: string|null, remoteUpdatedAt: string|null,
   *   local: any, remote: any, bytes?: number|null, backupPath?: string, dryRun?: true
   * }>}
   */
  async function executeNewestRun(cfg, options = {}) {
    const dryRun = options.dryRun === true
    const local = readLocal()
    const localAt = localUpdatedAt()
    const localMs = localUpdatedAtMs()
    const { snapshot: remote } = await readRemoteSnapshot(cfg)
    const remoteMs = remoteSnapshotUpdatedAtMs(remote)
    const decision = decideNewestDirection(local, remote, localMs, remoteMs)
    const localSummary = summarizeLocal(local, localAt)
    const remoteSummary = summarizeRemote(remote)
    const base = {
      mode: 'newest',
      action: decision.direction,
      direction: decision.direction,
      reason: decision.reason,
      uploaded: false,
      localRevision: local.revision,
      remoteRevision: remote ? remote.revision : null,
      localUpdatedAt: localAt,
      remoteUpdatedAt: remote ? (remote.updatedAt ?? remote.savedAt ?? null) : null,
      local: localSummary,
      remote: remoteSummary,
    }
    if (dryRun) return { ...base, dryRun: true }

    let backupPath = null
    let sourceLocal = local
    if (decision.direction === 'pull') {
      const pulled = await executePull(cfg, local, remote)
      backupPath = pulled.backupPath ?? null
      sourceLocal = readLocal()
    }
    // 每一次同步都上传：本地较新时上传本地快照；刚拉取时把拉取结果再回传一次，云端始终是最新副本。
    const pushed = await executePush(cfg, sourceLocal, remote)
    const result = {
      ...base,
      uploaded: true,
      localRevision: sourceLocal.revision,
      remoteRevision: pushed.remote?.revision ?? sourceLocal.revision,
      // remote 与旧三路 run 的语义保持一致：同步完成后的远端状态（不是同步前摘要）
      remote: {
        revision: pushed.remote?.revision ?? sourceLocal.revision,
        updatedAt: pushed.remote?.updatedAt ?? null,
        ref: pushed.remote?.ref ?? null,
        bytes: pushed.remote?.bytes ?? null,
      },
      localUpdatedAt: localUpdatedAt(),
      remoteUpdatedAt: pushed.remote?.updatedAt ?? null,
      bytes: pushed.bytes ?? null,
    }
    if (backupPath !== null) result.backupPath = backupPath
    return result
  }

  /* ---------- 执行 merge（记录级三方合并 + 每次上传合并结果） ---------- */

  /**
   * 记录级三方合并同步（默认模式）：
   * 读 base（缺失走降级）→ mergeThreeWay(base, local, remote) → pre-merge 备份 →
   * 写本地 → 上传合并结果 → 写 base。绝不 409；失败抛 SyncError（run 会记 lastError）。
   * @returns {Promise<object>} 见任务书第四节：mode/direction/action/uploaded/*Revision/*UpdatedAt/
   *   baseMissing/merged/backupPath/basePath（+ dryRun）
   */
  async function executeMergeRun(cfg, options = {}) {
    const dryRun = options.dryRun === true
    const local = readLocal()
    const localAt = localUpdatedAt()
    const { snapshot: remote } = await readRemoteSnapshot(cfg)
    const baseInfo = readBase()
    const baseMissing = baseInfo === null
    const baseState = baseInfo?.state ?? null
    const remoteRevision = remote ? remote.revision : null
    const remoteUpdatedAt = remote ? (remote.updatedAt ?? remote.savedAt ?? null) : null
    const localSummary = summarizeLocal(local, localAt)
    const remoteSummary = summarizeRemote(remote)
    const common = {
      mode: 'merge',
      baseMissing,
      localRevision: local.revision,
      remoteRevision,
      localUpdatedAt: localAt,
      remoteUpdatedAt,
      local: localSummary,
      remote: remoteSummary,
      basePath: baseFilePath,
      baseRevision: baseInfo?.revision ?? null,
    }

    // 降级 1：远端还没有快照 → 直接上传本地并写 base
    if (!remote) {
      const merged = mergedStatsView(emptyMergeStats(), baseMissing)
      if (dryRun) {
        return { ...common, action: 'push', direction: 'push', uploaded: false, mergedRevision: local.revision, merged, dryRun: true }
      }
      const pushed = await executePush(cfg, local, null) // 内部会写 base
      return {
        ...common,
        action: 'push',
        direction: 'push',
        uploaded: true,
        mergedRevision: local.revision,
        baseRevision: local.revision,
        merged,
        conflictDetails: [],
        bytes: pushed.bytes ?? null,
      }
    }

    // 降级 2：base 缺失 + 本地是空的（新装 / 未同步）→ 直接拉取远端覆盖本地，避免空本地把云端冲掉
    if (baseMissing && !hasLocalData(local.state)) {
      const merged = mergedStatsView(emptyMergeStats(), baseMissing)
      if (dryRun) {
        return { ...common, action: 'pull', direction: 'pull', uploaded: false, mergedRevision: remote.revision, merged, dryRun: true }
      }
      const pulled = await executePull(cfg, local, remote) // 内部会写 base
      return {
        ...common,
        action: 'pull',
        direction: 'pull',
        uploaded: false,
        mergedRevision: remote.revision,
        baseRevision: remote.revision,
        merged,
        conflictDetails: [],
        backupPath: pulled.backupPath,
      }
    }

    // 正常/降级三方合并：base 缺失但两边都有数据 → 以空 base 做加法合并（union，绝不删除）
    const { state: mergedState, stats } = mergeThreeWay(baseState, local.state, remote.state)
    const mergedRevision = Math.max(local.revision, remote.revision) + 1
    const mergedResult = {
      ...common,
      mergedRevision,
      merged: mergedStatsView(stats, baseMissing),
      conflictDetails: Array.isArray(stats.conflictDetails) ? stats.conflictDetails : [],
    }
    if (dryRun) {
      return { ...mergedResult, action: 'merge', direction: 'merge', uploaded: false, dryRun: true }
    }

    // 写盘顺序：pre-merge 备份 → 本地 → 上传 → base（executePush 内写 base）
    const backupPath = writeMergeBackup({
      local: local.state,
      remote: remote.state,
      base: baseState,
      baseMissing,
      localRevision: local.revision,
      remoteRevision: remote.revision,
      baseRevision: baseInfo?.revision ?? null,
    })
    let saved
    try {
      saved = dataStore.save(cloneJson(mergedState), mergedRevision)
    } catch (error) {
      throw new SyncError('SYNC_LOCAL_WRITE_FAILED', `写入合并结果失败：${errorText(error)}`)
    }
    const pushed = await executePush(cfg, { state: saved.state, revision: saved.revision }, remote)
    // 真实 merge 成功后整体替换待审阅冲突列表（无冲突写空数组）；dryRun / 其他模式不写
    writeConflictsFile({
      localRevision: local.revision,
      remoteRevision: remote.revision,
      conflicts: (Array.isArray(stats.conflictDetails) ? stats.conflictDetails : [])
        .map((item) => ({ ...item, at: isoNow(clock) })),
    })
    return {
      ...mergedResult,
      action: 'merge',
      direction: 'merge',
      uploaded: true,
      mergedRevision: saved.revision,
      baseRevision: saved.revision,
      backupPath,
      bytes: pushed.bytes ?? null,
    }
  }

  /* ---------- 待审阅冲突 sync-conflicts.json（0600 原子写；读失败按空列表） ---------- */

  function emptyConflictsFile() {
    return { at: null, localRevision: null, remoteRevision: null, conflicts: [] }
  }

  function readConflictsFile() {
    try {
      if (!existsSync(conflictsFilePath)) return emptyConflictsFile()
      const parsed = JSON.parse(readFileSync(conflictsFilePath, 'utf8'))
      if (!isRecord(parsed) || parsed.kind !== 'sync-conflicts' || !Array.isArray(parsed.conflicts)) {
        logger?.warn?.(`[flowpilot:sync] ${conflictsFilePath} 形状不认识，按空列表处理`)
        return emptyConflictsFile()
      }
      return {
        at: isoOrNull(parsed.at),
        localRevision: Number.isInteger(parsed.localRevision) ? parsed.localRevision : null,
        remoteRevision: Number.isInteger(parsed.remoteRevision) ? parsed.remoteRevision : null,
        conflicts: parsed.conflicts.filter((item) => isRecord(item)),
      }
    } catch (error) {
      logger?.warn?.(`[flowpilot:sync] 读取待审阅冲突失败（按空列表处理）：${errorText(error)}`)
      return emptyConflictsFile()
    }
  }

  function writeConflictsFile(info) {
    try {
      mkdirSync(dirname(conflictsFilePath), { recursive: true, mode: 0o700 })
      const payload = {
        formatVersion: SYNC_FORMAT_VERSION,
        kind: 'sync-conflicts',
        at: isoNow(clock),
        localRevision: Number.isInteger(info?.localRevision) ? info.localRevision : null,
        remoteRevision: Number.isInteger(info?.remoteRevision) ? info.remoteRevision : null,
        conflicts: Array.isArray(info?.conflicts) ? info.conflicts : [],
      }
      const tmp = `${conflictsFilePath}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`
      writeFileSync(tmp, JSON.stringify(payload, null, 2), { encoding: 'utf8', mode: 0o600 })
      try { chmodSync(tmp, 0o600) } catch { /* 忽略 */ }
      renameSync(tmp, conflictsFilePath)
      try { chmodSync(conflictsFilePath, 0o600) } catch { /* 忽略 */ }
      return payload
    } catch (error) {
      logger?.warn?.(`[flowpilot:sync] 写入待审阅冲突失败（不影响同步）：${errorText(error)}`)
      return null
    }
  }

  /** 读待审阅冲突列表（GET /sync/conflicts；未配置通道也能读）。 */
  function conflicts() {
    const file = readConflictsFile()
    return {
      count: file.conflicts.length,
      conflicts: file.conflicts,
      at: file.at,
      localRevision: file.localRevision,
      remoteRevision: file.remoteRevision,
    }
  }

  /** 清空待审阅列表（不改数据）。 */
  function clearConflicts() {
    const file = readConflictsFile()
    writeConflictsFile({ localRevision: file.localRevision, remoteRevision: file.remoteRevision, conflicts: [] })
    return { cleared: file.conflicts.length }
  }

  /** 按 id 找 state 里的记录（settings 特判：返回 settings 对象本身）。 */
  function findConflictRecord(state, collection, recordId) {
    if (collection === 'settings') {
      if (!isRecord(state.settings)) state.settings = {}
      return state.settings
    }
    const records = Array.isArray(state?.[collection]) ? state[collection] : null
    if (records === null) return null
    return records.find((record) => recordKeyOf(collection, record) === recordId) ?? null
  }

  /**
   * 审阅冲突：choice='remote' 把 remoteValue 写回本地（missingInRemote → 删字段）；
   * choice='local' 把 localValue 写回本地（恢复本地候选值；missingInLocal → 删字段）。
   * 应用后 save(revision+1) → push(force) 上传 → 从列表移除。
   * @returns {Promise<{applied:number, skipped:{id:string,reason:string}[], remaining:number,
   *   revision:number, uploaded:boolean, bytes?:number|null}>}
   */
  async function resolveConflicts(options = {}) {
    const choice = options.choice === 'remote' ? 'remote' : options.choice === 'local' ? 'local' : null
    if (choice === null) throw new SyncError('INVALID_INPUT', 'choice 只能是 local 或 remote')
    const all = options.all === true
    const id = text(options.id)
    if (!all && id === '') throw new SyncError('INVALID_INPUT', '缺少 id（或用 all:true 批量处理）')
    return withBusy(async () => {
      const cfg = requireConfigured()
      const file = readConflictsFile()
      const list = file.conflicts
      const targets = all ? list : list.filter((item) => text(item.id) === id)
      if (targets.length === 0) {
        return {
          applied: 0,
          skipped: all ? [] : [{ id, reason: '未找到该冲突（可能已被处理）' }],
          remaining: list.length,
          revision: readLocal().revision,
          uploaded: false,
        }
      }
      const local = readLocal()
      const state = cloneJson(local.state)
      const appliedIds = []
      const skipped = []
      for (const item of targets) {
        const collection = text(item.collection)
        const recordId = text(item.recordId)
        const field = text(item.field)
        const itemId = text(item.id)
        if (collection === '' || field === '' || (collection !== 'settings' && !MERGE_COLLECTIONS.includes(collection))) {
          skipped.push({ id: itemId, reason: '冲突数据不完整，已跳过' })
          continue
        }
        const record = findConflictRecord(state, collection, recordId)
        if (!isRecord(record)) {
          skipped.push({ id: itemId, reason: '记录已不存在（可能已被删除）' })
          continue
        }
        // 采用候选值：remote → remoteValue，local → localValue（恢复本地候选值）；缺失则删字段
        const chosenMissing = choice === 'remote' ? item.missingInRemote === true : item.missingInLocal === true
        const chosenValue = choice === 'remote' ? item.remoteValue : item.localValue
        if (chosenMissing) delete record[field]
        else record[field] = cloneJson(chosenValue === undefined ? null : chosenValue)
        appliedIds.push(itemId)
      }
      if (appliedIds.length === 0) {
        return { applied: 0, skipped, remaining: list.length, revision: local.revision, uploaded: false }
      }
      let saved
      try {
        saved = dataStore.save(state, local.revision + 1)
      } catch (error) {
        throw new SyncError('SYNC_LOCAL_WRITE_FAILED', `写入冲突审阅结果失败：${errorText(error)}`)
      }
      let pushed
      try {
        const { snapshot: remote } = await readRemoteSnapshot(cfg)
        pushed = await executePush(cfg, { state: saved.state, revision: saved.revision }, remote)
      } catch (error) {
        recordError(error)
        throw error
      }
      const appliedSet = new Set(appliedIds)
      const remaining = list.filter((item) => !appliedSet.has(text(item.id)))
      writeConflictsFile({ localRevision: local.revision, remoteRevision: file.remoteRevision, conflicts: remaining })
      return {
        applied: appliedIds.length,
        skipped,
        remaining: remaining.length,
        revision: saved.revision,
        uploaded: true,
        bytes: pushed.bytes ?? null,
      }
    })
  }

  /* ---------- 并发保护 ---------- */

  let busy = false
  async function withBusy(fn) {
    if (busy) throw new SyncError('INVALID_INPUT', '同步正在进行中，请稍后再试')
    busy = true
    try {
      return await fn()
    } finally {
      busy = false
    }
  }

  /* ---------- 公开 API ---------- */

  /** 同步状态（SYNC.md §2.1）；只回 credentialsSet，绝不回 token/password。 */
  function status() {
    const cfg = loadConfig()
    const local = readLocal()
    const lastSyncedRevision = cfg.state.lastSyncedRevision
    const configured = isConfigured(cfg)
    const hasPendingChanges = lastSyncedRevision === null
      ? hasLocalData(local.state)
      : local.revision !== lastSyncedRevision
    return {
      provider: cfg.provider,
      providerLabel: PROVIDER_LABELS[cfg.provider] ?? PROVIDER_LABELS.off,
      configured,
      credentialsSet: credentialsSet(cfg),
      // 更精确的按通道凭据状态（客户端回填「Token 已保存 / 未保存」用）
      githubCredentialsSet: cfg.github.token !== '',
      webdavCredentialsSet: cfg.webdav.password !== '',
      remoteTarget: remoteTargetOf(cfg),
      // 非敏感配置回显：供设置面板回填表单；绝不包含 token / password
      config: publicConfigOf(cfg),
      behavior: {
        autoPushAfterWrite: cfg.behavior.autoPushAfterWrite,
        autoPullOnStart: cfg.behavior.autoPullOnStart,
      },
      localRevision: local.revision,
      localUpdatedAt: localUpdatedAt(),
      localCounts: countsOf(local.state),
      lastSyncedAt: cfg.state.lastSyncedAt,
      lastSyncedRevision,
      hasPendingChanges,
      lastError: cfg.state.lastError,
      lastErrorAt: cfg.state.lastErrorAt,
      deviceId: cfg.state.deviceId,
      dataFile,
    }
  }

  /**
   * 凭据合并语义（/config 深合并的一部分，与 LEAD/客户端约定一致）：
   * - undefined / null → 不修改（保留已保存凭据）
   * - '' 或纯空白 → 清除（credentialsSet 变为 false）
   * - 其他字符串 → 设置
   * 注意：设置面板「密码框留空」必须传 undefined 或省略该键；传 '' 视为清除。
   */
  function applySecret(current, value, label) {
    if (value === undefined || value === null) return current
    if (typeof value !== 'string') throw new SyncError('INVALID_INPUT', `${label} 必须是字符串`)
    const trimmed = value.trim()
    return trimmed === '' ? '' : trimmed
  }

  /**
   * 保存配置（SYNC.md §2 的 POST /sync/config）。
   * patch = { provider?, github?, webdav?, behavior?, secrets?: { githubToken?, webdavPassword? } }
   * 语义：按 patch 深度合并（未出现的键 / undefined 不覆盖；切通道不会清掉另一通道的配置）；
   *       凭据：undefined/null 不修改，'' 清除，非空设置。
   */
  function configure(patch) {
    if (!isRecord(patch)) throw new SyncError('INVALID_INPUT', '配置必须是对象')
    const cfg = loadConfig()

    if (patch.provider !== undefined) {
      const provider = text(patch.provider).toLowerCase()
      if (!SYNC_PROVIDERS.includes(provider)) {
        throw new SyncError('INVALID_INPUT', 'provider 只能是 off / github / webdav')
      }
      cfg.provider = provider
    }

    if (patch.github !== undefined) {
      if (!isRecord(patch.github)) throw new SyncError('INVALID_INPUT', 'github 配置必须是对象')
      const gh = patch.github
      if (gh.owner !== undefined) cfg.github.owner = text(gh.owner)
      if (gh.repo !== undefined) cfg.github.repo = text(gh.repo)
      if (gh.branch !== undefined) cfg.github.branch = text(gh.branch) || DEFAULT_GITHUB_BRANCH
      if (gh.path !== undefined) cfg.github.path = normalizeGithubPath(gh.path)
      if (gh.apiBase !== undefined) cfg.github.apiBase = stripTrailingSlash(text(gh.apiBase) || DEFAULT_API_BASE)
      if (gh.token !== undefined) cfg.github.token = applySecret(cfg.github.token, gh.token, 'github.token')
    }

    if (patch.webdav !== undefined) {
      if (!isRecord(patch.webdav)) throw new SyncError('INVALID_INPUT', 'webdav 配置必须是对象')
      const dav = patch.webdav
      if (dav.url !== undefined) cfg.webdav.url = stripTrailingSlash(text(dav.url))
      if (dav.username !== undefined) cfg.webdav.username = text(dav.username)
      if (dav.fileName !== undefined) cfg.webdav.fileName = text(dav.fileName) || DEFAULT_DAV_FILE
      if (dav.password !== undefined) cfg.webdav.password = applySecret(cfg.webdav.password, dav.password, 'webdav.password')
    }

    if (patch.behavior !== undefined) {
      if (!isRecord(patch.behavior)) throw new SyncError('INVALID_INPUT', 'behavior 配置必须是对象')
      if (patch.behavior.autoPushAfterWrite !== undefined) cfg.behavior.autoPushAfterWrite = patch.behavior.autoPushAfterWrite === true
      if (patch.behavior.autoPullOnStart !== undefined) cfg.behavior.autoPullOnStart = patch.behavior.autoPullOnStart === true
      if (patch.behavior.debounceMs !== undefined) {
        const debounceMs = Number(patch.behavior.debounceMs)
        if (!Number.isFinite(debounceMs) || debounceMs < 0) {
          throw new SyncError('INVALID_INPUT', 'behavior.debounceMs 必须是非负数字')
        }
        cfg.behavior.debounceMs = Math.min(debounceMs, 600_000)
      }
    }

    if (patch.secrets !== undefined) {
      if (!isRecord(patch.secrets)) throw new SyncError('INVALID_INPUT', 'secrets 必须是对象')
      if (patch.secrets.githubToken !== undefined) {
        cfg.github.token = applySecret(cfg.github.token, patch.secrets.githubToken, 'secrets.githubToken')
      }
      if (patch.secrets.webdavPassword !== undefined) {
        cfg.webdav.password = applySecret(cfg.webdav.password, patch.secrets.webdavPassword, 'secrets.webdavPassword')
      }
    }
    // 工具平铺参数别名：token / password（undefined 不修改，'' 清除，非空设置）
    if (patch.token !== undefined) cfg.github.token = applySecret(cfg.github.token, patch.token, 'token')
    if (patch.password !== undefined) cfg.webdav.password = applySecret(cfg.webdav.password, patch.password, 'password')

    if (cfg.github.owner.includes('/') || cfg.github.repo.includes('/')) {
      throw new SyncError('INVALID_INPUT', 'GitHub owner / repo 不能包含 “/”（owner 与 repo 分开填）')
    }
    if (!isHttpUrl(cfg.github.apiBase)) throw new SyncError('INVALID_INPUT', 'GitHub apiBase 必须是 http(s) URL')
    if (cfg.webdav.url !== '' && !isHttpUrl(cfg.webdav.url)) {
      throw new SyncError('INVALID_INPUT', 'WebDAV 目录 URL 必须是 http(s) URL')
    }

    cfg.version = 1
    persistConfig(cfg)
    logger?.info?.(`[flowpilot:sync] 配置已保存（provider=${cfg.provider}，configured=${isConfigured(cfg)}）`)
    return status()
  }

  /** 测试连接（SYNC.md §2.2）。失败抛 SyncError（401 / 502 / 422）。 */
  async function test() {
    const cfg = requireConfigured()
    const startedAt = Date.now()
    try {
      let detail
      if (cfg.provider === 'github') {
        const info = await githubRead(cfg)
        const latencyMs = Date.now() - startedAt
        const target = `${cfg.github.owner}/${cfg.github.repo}@${cfg.github.branch}`
        if (!info.exists) {
          detail = {
            provider: 'github',
            reachable: true,
            remoteFound: false,
            remoteRevision: null,
            remoteUpdatedAt: null,
            remoteBytes: null,
            latencyMs,
            message: `已连接 ${target}，远端还没有快照（首次上传会创建）`,
          }
        } else {
          const snapshot = parseRemoteSnapshot(info, { source: 'GitHub 远端' })
          detail = {
            provider: 'github',
            reachable: true,
            remoteFound: true,
            remoteRevision: snapshot.revision,
            remoteUpdatedAt: snapshot.updatedAt,
            remoteBytes: info.bytes,
            latencyMs,
            message: `已连接 ${target}，远端存在快照（r${snapshot.revision}）`,
          }
        }
      } else {
        await davProbe(cfg)
        const info = await davRead(cfg)
        const latencyMs = Date.now() - startedAt
        if (!info.exists) {
          detail = {
            provider: 'webdav',
            reachable: true,
            remoteFound: false,
            remoteRevision: null,
            remoteUpdatedAt: null,
            remoteBytes: null,
            latencyMs,
            message: `已连接 ${davDirUrl(cfg)}，远端还没有 ${cfg.webdav.fileName}（首次上传会自动创建）`,
          }
        } else {
          const snapshot = parseRemoteSnapshot(info, { source: 'WebDAV 远端' })
          detail = {
            provider: 'webdav',
            reachable: true,
            remoteFound: true,
            remoteRevision: snapshot.revision,
            remoteUpdatedAt: snapshot.updatedAt,
            remoteBytes: info.bytes,
            latencyMs,
            message: `已连接 ${davDirUrl(cfg)}，远端存在快照（r${snapshot.revision}）`,
          }
        }
      }
      clearError()
      return detail
    } catch (error) {
      recordError(error)
      throw error
    }
  }

  /**
   * 组合动作（默认记录级三方合并）：
   * - mode:'merge'（默认）→ 以 base 为基准合并本地/云端（两边改动都保留），冲突按 lastTouch 决胜，
   *   每次都会上传合并结果并刷新 base；永不 409；
   * - mode:'newest' → 整份「最新覆盖」+ 每次都上传，永不冲突；
   * - mode:'three-way'（deprecated）或带 force → 旧三路比较，冲突抛 409。
   * @param {{ mode?: 'merge'|'newest'|'three-way', force?: 'push'|'pull', dryRun?: boolean }} options
   */
  async function run(options = {}) {
    const mode = options.mode === 'newest'
      ? 'newest'
      : options.mode === 'three-way' ? 'three-way' : DEFAULT_SYNC_RUN_MODE
    const force = options.force === 'push' || options.force === 'pull' ? options.force : null
    const dryRun = options.dryRun === true
    return withBusy(async () => {
      const cfg = requireConfigured()
      try {
        // force 是人工指定的覆盖方向：始终走旧的强制路径（force pull 不会自动回传）
        if (force !== null) return await executeThreeWayRun(cfg, { force, dryRun })
        if (mode === 'merge') {
          try {
            const out = await executeMergeRun(cfg, { dryRun })
            return { ...out, result: mergeResultView(out) }
          } catch (error) {
            // 上传撞上别的设备并发写（GitHub 409 / WebDAV 412）：重读远端与 base 再合并一次
            if (isSyncError(error) && error.code === 'SYNC_CONFLICT' && dryRun !== true) {
              logger?.info?.('[flowpilot:sync] 合并上传撞上并发写冲突，重读远端后重试一次')
              try {
                const out = await executeMergeRun(cfg, { dryRun })
                return { ...out, result: mergeResultView(out) }
              } catch (retryError) {
                // merge 模式承诺「永不 409」：重试后仍撞并发写 → 归一成可重试的网络错误（502）
                if (isSyncError(retryError) && retryError.code === 'SYNC_CONFLICT') {
                  throw new SyncError('SYNC_NETWORK', '云端快照在合并期间被其他设备修改，请稍后重试')
                }
                throw retryError
              }
            }
            throw error
          }
        }
        if (mode === 'newest') {
          try {
            return await executeNewestRun(cfg, { dryRun })
          } catch (error) {
            // 上传时撞上别的设备并发写（GitHub 409 / WebDAV 412）：重读远端、重新判新旧后再来一次，
            // 尽量避免把传输层乐观锁冲突抛给客户端（newest 语义下不该出现「冲突」）。
            if (isSyncError(error) && error.code === 'SYNC_CONFLICT' && dryRun !== true) {
              logger?.info?.('[flowpilot:sync] 上传撞上并发写冲突，重读远端后重试一次')
              return await executeNewestRun(cfg, { dryRun })
            }
            throw error
          }
        }
        return await executeThreeWayRun(cfg, { force, dryRun })
      } catch (error) {
        recordError(error)
        throw error
      }
    })
  }

  /** 旧的三路比较组合动作（run 的旧行为：自动 push / pull / noop，冲突 409）。 */
  async function executeThreeWayRun(cfg, options = {}) {
    const force = options.force === 'push' || options.force === 'pull' ? options.force : null
    const dryRun = options.dryRun === true
    const local = readLocal()
    const { snapshot: remote } = await readRemoteSnapshot(cfg)
    const localSummary = summarizeLocal(local, localUpdatedAt())
    if (force === 'push') {
      if (dryRun) return { action: 'push', local: localSummary, remote: summarizeRemote(remote), dryRun: true }
      return { local: localSummary, ...(await executePush(cfg, local, remote)) }
    }
    if (force === 'pull') {
      if (!remote) throw new SyncError('SYNC_REMOTE_INVALID', '远端还没有同步快照，无法下载')
      if (dryRun) {
        return {
          action: 'pull',
          local: localSummary,
          remote: summarizeRemote(remote),
          appliedRevision: remote.revision,
          dryRun: true,
        }
      }
      return { local: localSummary, ...(await executePull(cfg, local, remote)) }
    }
    const lastSyncedRevision = cfg.state.lastSyncedRevision
    const action = decideDirection(local, remote, lastSyncedRevision)
    if (action === 'conflict') throw conflictError(makeConflict(local, remote, lastSyncedRevision, localUpdatedAt()))
    if (dryRun) {
      return {
        action,
        local: localSummary,
        remote: summarizeRemote(remote),
        ...(action === 'pull' && remote ? { appliedRevision: remote.revision } : {}),
        dryRun: true,
      }
    }
    if (action === 'push') return { local: localSummary, ...(await executePush(cfg, local, remote)) }
    if (action === 'pull') return { local: localSummary, ...(await executePull(cfg, local, remote)) }
    return { action: 'noop', local: localSummary, remote: summarizeRemote(remote) }
  }

  /** 上传本地快照（SYNC.md §2 POST /sync/push）。force=true 时忽略远端已变更保护。 */
  async function push(options = {}) {
    const force = options.force === true
    return withBusy(async () => {
      const cfg = requireConfigured()
      try {
        const local = readLocal()
        const { snapshot: remote } = await readRemoteSnapshot(cfg)
        const lastSyncedRevision = cfg.state.lastSyncedRevision
        if (!force && remote) {
          const remoteChanged = remote.revision !== lastSyncedRevision
          const localChanged = local.revision !== lastSyncedRevision
          const firstSyncConflict = lastSyncedRevision === null && hasLocalData(remote.state)
          if (firstSyncConflict || (lastSyncedRevision !== null && remoteChanged && localChanged)) {
            throw conflictError(makeConflict(local, remote, lastSyncedRevision, localUpdatedAt()))
          }
          if (lastSyncedRevision !== null && remoteChanged && !localChanged) {
            // 远端有新数据而本地没改：直接上传会覆盖远端更新，交给用户确认
            throw conflictError(makeConflict(local, remote, lastSyncedRevision, localUpdatedAt()))
          }
        }
        return await executePush(cfg, local, remote)
      } catch (error) {
        recordError(error)
        throw error
      }
    })
  }

  /** 下载远端快照覆盖本地（覆盖前备份）。force=true 时忽略双改冲突。 */
  async function pull(options = {}) {
    const force = options.force === true
    return withBusy(async () => {
      const cfg = requireConfigured()
      try {
        const local = readLocal()
        const { snapshot: remote } = await readRemoteSnapshot(cfg)
        if (!remote) throw new SyncError('SYNC_REMOTE_INVALID', '远端还没有同步快照，无法下载')
        if (!force) {
          const lastSyncedRevision = cfg.state.lastSyncedRevision
          const bothChanged = lastSyncedRevision !== null
            && local.revision !== lastSyncedRevision
            && remote.revision !== lastSyncedRevision
          const firstSyncConflict = lastSyncedRevision === null && hasLocalData(local.state) && hasLocalData(remote.state)
          if (bothChanged || firstSyncConflict) {
            throw conflictError(makeConflict(local, remote, lastSyncedRevision, localUpdatedAt()))
          }
        }
        return await executePull(cfg, local, remote)
      } catch (error) {
        recordError(error)
        throw error
      }
    })
  }

  /* ---------- 写后自动同步（newest，默认开启，防抖） / 自动拉取（启动后异步） ---------- */

  let debounceTimer = null
  /** 自动同步是否正在执行（防重入：同一时刻只跑一次 run）。 */
  let autoSyncInFlight = false
  /** 同步进行中又有写入 → 合并为「结束后补跑一次」。 */
  let autoSyncRerun = false

  /** 按 behavior.debounceMs 重新安排一次防抖（窗口内多次写只在末尾跑一次）。 */
  function armAutoSync() {
    const cfg = loadConfig()
    const delay = Math.max(0, Number(cfg.behavior.debounceMs) || 0)
    if (debounceTimer) clearTimeout(debounceTimer)
    debounceTimer = setTimeout(() => {
      debounceTimer = null
      void runAutoSync()
    }, delay)
    try { debounceTimer.unref?.() } catch { /* 忽略 */ }
  }

  /**
   * 防抖到期执行体：跑一次 **三方合并** 同步（run({mode:'merge'})），
   * 与手动同步/定时同步语义一致：两边改动都保留，合并结果上传，永不 409。
   * 防重入：正在同步时再次到期只标记 rerun，当前这次结束后按防抖再补跑一次，绝不并发。
   * 绝不抛：失败时 run 内部已记 lastError，这里只补 warn 日志。
   */
  async function runAutoSync() {
    if (autoSyncInFlight) {
      autoSyncRerun = true
      return
    }
    autoSyncInFlight = true
    try {
      const cfg = loadConfig()
      // 未配置通道 / provider=off：直接跳过，不做无谓请求
      if (!cfg.behavior.autoPushAfterWrite || !isConfigured(cfg)) return
      await run({ mode: 'merge' })
      logger?.info?.('[flowpilot:sync] 写后自动同步完成（merge）')
    } catch (error) {
      // run 内部已记录 lastError；这里只补日志，绝不把错误抛给本地写操作
      logger?.warn?.(`[flowpilot:sync] 写后自动同步失败（不阻断本地操作）：${errorText(error)}`)
    } finally {
      autoSyncInFlight = false
      if (autoSyncRerun) {
        autoSyncRerun = false
        // 同步期间又有写入：按防抖窗口再合并一次（不会立刻并发第二次）
        try { armAutoSync() } catch (error) { logger?.warn?.(`[flowpilot:sync] 补跑自动同步安排失败：${errorText(error)}`) }
      }
    }
  }

  /**
   * 本地写的通知钩子（POST /action、POST /ai/apply 成功后、agent 工具写操作后调用）。
   * behavior.autoPushAfterWrite 默认开启（旧 sync.json 缺字段视为开启，显式 false 才关闭）；
   * 防抖到期后执行一次 **三方合并（merge）**（云端与本地改动都保留，合并结果上传）。
   * 绝不抛错；失败只记 lastError + warn 日志，不阻断本地写。
   * @returns {boolean} 是否安排了自动同步（未开启 / 未配置通道时为 false）
   */
  function noteLocalWrite() {
    try {
      const cfg = loadConfig()
      if (!cfg.behavior.autoPushAfterWrite || !isConfigured(cfg)) return false
      armAutoSync()
      return true
    } catch (error) {
      logger?.warn?.(`[flowpilot:sync] 自动同步安排失败（不影响本地写操作）：${errorText(error)}`)
      return false
    }
  }

  /** 插件启动时自动拉取一次（异步、非阻塞；失败只记录 lastError）。 */
  function start() {
    try {
      const cfg = loadConfig()
      if (!cfg.behavior.autoPullOnStart || !isConfigured(cfg)) return false
      void (async () => {
        try {
          await pull({ force: false })
          logger?.info?.('[flowpilot:sync] 启动自动拉取完成')
        } catch (error) {
          logger?.warn?.(`[flowpilot:sync] 启动自动拉取失败（不阻断插件启动）：${errorText(error)}`)
        }
      })()
      return true
    } catch (error) {
      logger?.warn?.(`[flowpilot:sync] 启动自动拉取失败（不阻断插件启动）：${errorText(error)}`)
      return false
    }
  }

  /** 清理防抖定时器与待补跑的标记（插件卸载 / 自测收尾）；已在飞的同步无法中断。 */
  function stop() {
    if (debounceTimer) {
      clearTimeout(debounceTimer)
      debounceTimer = null
    }
    autoSyncRerun = false
  }

  return {
    // 契约方法（SYNC.md §4）
    status,
    configure,
    test,
    run,
    push,
    pull,
    noteLocalWrite,
    start,
    // 冲突审阅（merge 自动解决后再人工确认）
    conflicts,
    resolveConflicts,
    clearConflicts,
    // 额外：清理定时器（插件卸载/测试用）
    stop,
    // 只读路径（排障/测试用）
    get syncFile() { return syncFilePath },
    get backupDir() { return backupDirPath },
    get dataFile() { return dataFile },
    get baseFile() { return baseFilePath },
    get conflictsFile() { return conflictsFilePath },
  }
}
