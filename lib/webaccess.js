/**
 * FlowPilot 宿主半 · 本地网页访问（双模式）
 *
 * 两种独立的本地网页，各有开关 / 端口 / 链接：
 *  - readOnly：只读看板（GET only，无鉴权），给「只想看」的场景；
 *  - full：远程工作台（读写，必须带访问口令），能在任意浏览器里推进节点、审批、改计划、写备注。
 *
 * 都只绑定 127.0.0.1；配置落盘 <dataDir>/web-access.json（机器本地，不进 data.json / 同步 / 导出）。
 * 兼容旧配置 { enabled, port } → 迁移为 readOnly。
 *
 * 约束：只 import `node:` 内置模块与包内相对模块；与框架无关，便于自测。
 */
import { createServer } from 'node:http'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { FpError } from './util.js'
import { ACTION_NAMES } from './domain.js'
import { buildFullPage, buildLoginPage, buildReadOnlyPage } from './webui.js'

export const WEB_ACCESS_MODES = Object.freeze(['readOnly', 'full'])

const BIND_HOST = '127.0.0.1'
const MIN_PORT = 1024
const MAX_PORT = 65535
const DEFAULT_READONLY_PORT = 4173
const DEFAULT_FULL_PORT = 4174
const TOKEN_HEADER = 'x-flowpilot-token'
const COOKIE_NAME = 'fp_web_token'
const COOKIE_MAX_AGE = 60 * 60 * 24 * 30
const TOKEN_MIN = 8
const TOKEN_MAX = 128
const BODY_LIMIT = 1024 * 1024

function readConfigFile(file) {
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8'))
    return raw !== null && typeof raw === 'object' ? raw : {}
  } catch {
    return {}
  }
}

function writeConfigFile(file, value) {
  mkdirSync(dirname(file), { recursive: true })
  const tmp = file + '.tmp'
  writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', 'utf8')
  renameSync(tmp, file)
}

function normalizePort(value) {
  if (value === undefined || value === null || value === '') return null
  const port = Number(value)
  if (!Number.isInteger(port) || port < MIN_PORT || port > MAX_PORT) {
    throw new FpError('INVALID_INPUT', `端口必须是 ${MIN_PORT}–${MAX_PORT} 之间的整数`)
  }
  return port
}

function validPortOrNull(value) {
  try {
    return normalizePort(value)
  } catch {
    return null
  }
}

function esc(value) {
  return String(value === null || value === undefined ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function generateToken() {
  return randomBytes(18).toString('base64url')
}

function defaultConfig() {
  return {
    readOnly: { enabled: false, port: DEFAULT_READONLY_PORT },
    full: { enabled: false, port: DEFAULT_FULL_PORT, token: '' },
  }
}

/** 读文件 → 规范化；旧版 { enabled, port } 视为只读模式的配置。 */
function normalizeConfig(raw) {
  const config = defaultConfig()
  if (!raw || typeof raw !== 'object') return config
  const legacy = raw.readOnly === undefined && raw.full === undefined
  if (legacy) {
    if (raw.enabled === true) config.readOnly.enabled = true
    const legacyPort = validPortOrNull(raw.port)
    if (legacyPort !== null) config.readOnly.port = legacyPort
    return config
  }
  const readOnly = raw.readOnly && typeof raw.readOnly === 'object' ? raw.readOnly : {}
  if (typeof readOnly.enabled === 'boolean') config.readOnly.enabled = readOnly.enabled
  const readOnlyPort = validPortOrNull(readOnly.port)
  if (readOnlyPort !== null) config.readOnly.port = readOnlyPort
  const full = raw.full && typeof raw.full === 'object' ? raw.full : {}
  if (typeof full.enabled === 'boolean') config.full.enabled = full.enabled
  const fullPort = validPortOrNull(full.port)
  if (fullPort !== null) config.full.port = fullPort
  if (typeof full.token === 'string') config.full.token = full.token.trim().slice(0, TOKEN_MAX)
  return config
}

function parseCookies(header) {
  const out = {}
  if (typeof header !== 'string' || header === '') return out
  for (const part of header.split(';')) {
    const index = part.indexOf('=')
    if (index === -1) continue
    const key = part.slice(0, index).trim()
    if (key === '') continue
    out[key] = decodeURIComponent(part.slice(index + 1).trim())
  }
  return out
}

function cookieHeader(value, maxAge) {
  return `${COOKIE_NAME}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}`
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > BODY_LIMIT) {
        reject(new FpError('INVALID_INPUT', '请求体过大'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', (error) => reject(error))
  })
}

async function readJsonBody(req) {
  const text = await readBody(req)
  if (text.trim() === '') return {}
  try {
    const parsed = JSON.parse(text)
    return parsed !== null && typeof parsed === 'object' ? parsed : {}
  } catch {
    throw new FpError('INVALID_INPUT', '请求体不是合法 JSON')
  }
}

/** 把 engine.snapshot() 收敛成只读页面需要的轻量结构。 */
function buildSummary(engine) {
  const snap = engine.snapshot()
  const state = snap.state || {}
  const derived = snap.derived || {}
  const lines = Array.isArray(state.businessLines) ? state.businessLines : []
  const projects = Array.isArray(state.projects) ? state.projects : []
  const lineName = (id) => {
    const hit = lines.filter((line) => line && line.id === id)[0]
    return hit && typeof hit.name === 'string' ? hit.name : ''
  }
  const today = derived.today || {}
  const card = (item) => ({
    code: typeof item.code === 'string' ? item.code : '',
    title: typeof item.title === 'string' ? item.title : '',
    projectTitle: typeof item.projectTitle === 'string' ? item.projectTitle : '',
    status: typeof item.status === 'string' ? item.status : '',
    dueAt: typeof item.dueAt === 'string' ? item.dueAt : null,
  })
  const activeProjects = projects
    .filter((project) => project && project.status !== 'archived')
    .map((project) => {
      const info = derived.projects && derived.projects[project.id] ? derived.projects[project.id] : {}
      return {
        title: typeof project.title === 'string' ? project.title : '未命名项目',
        line: lineName(project.businessLineId),
        progress: typeof info.progress === 'number' ? Math.round(info.progress * 100) : 0,
        currentCode: typeof info.currentCode === 'string' ? info.currentCode : '',
        currentStage: typeof info.currentStage === 'string' ? info.currentStage : '',
        nextDueAt: typeof info.nextDueAt === 'string' ? info.nextDueAt : null,
        total: Number(info.total) || 0,
        completed: Number(info.completed) || 0,
      }
    })
  return {
    generatedAt: new Date().toISOString(),
    revision: snap.revision,
    counts: {
      actionable: Number(derived.counts && derived.counts.actionable) || 0,
      waiting: Number(derived.counts && derived.counts.waiting) || 0,
      overdue: Number(derived.counts && derived.counts.overdue) || 0,
    },
    today: {
      recommended: (today.recommended || []).map(card),
      followUps: (today.followUps || []).map(card),
      upcoming: (today.upcoming || []).map(card),
    },
    lines: lines.map((line) => ({
      name: typeof line.name === 'string' ? line.name : '',
      projectCount: activeProjects.filter((project) => project.line === line.name).length,
    })),
    projects: activeProjects,
  }
}

export function createWebAccessService({ engine, logger, configFile } = {}) {
  if (!engine || typeof engine.snapshot !== 'function') throw new Error('createWebAccessService 需要 engine')
  if (typeof engine.dispatch !== 'function') throw new Error('createWebAccessService 需要 engine.dispatch')
  const resolvedFile = typeof configFile === 'string' && configFile !== ''
    ? configFile
    : join(dirname(engine.dataFile), 'web-access.json')
  const config = normalizeConfig(readConfigFile(resolvedFile))
  const servers = { readOnly: null, full: null }
  const runtime = {
    readOnly: { port: null, startedAt: null, error: null },
    full: { port: null, startedAt: null, error: null },
  }

  function persist() {
    try {
      writeConfigFile(resolvedFile, {
        readOnly: { enabled: config.readOnly.enabled, port: config.readOnly.port },
        full: { enabled: config.full.enabled, port: config.full.port, token: config.full.token },
      })
    } catch (error) {
      logger?.warn?.(`[flowpilot:web] 保存网页访问配置失败：${error?.message ?? error}`)
    }
  }

  function readOnlyStatus() {
    const running = servers.readOnly !== null
    const port = running ? runtime.readOnly.port : config.readOnly.port
    return {
      enabled: config.readOnly.enabled,
      running,
      host: BIND_HOST,
      port,
      url: running ? `http://${BIND_HOST}:${port}/` : null,
      startedAt: runtime.readOnly.startedAt,
      error: runtime.readOnly.error,
    }
  }

  function fullStatus() {
    const running = servers.full !== null
    const port = running ? runtime.full.port : config.full.port
    const token = config.full.token
    const url = running ? `http://${BIND_HOST}:${port}/` : null
    return {
      enabled: config.full.enabled,
      running,
      host: BIND_HOST,
      port,
      url,
      loginUrl: running && token !== '' ? `http://${BIND_HOST}:${port}/?token=${encodeURIComponent(token)}` : null,
      hasToken: token !== '',
      token,
      startedAt: runtime.full.startedAt,
      error: runtime.full.error,
    }
  }

  function status() {
    return { readOnly: readOnlyStatus(), full: fullStatus(), configFile: resolvedFile }
  }

  /* ---------------- 只读模式 ---------------- */

  function handleReadOnly(req, res) {
    const url = new URL(req.url || '/', `http://${BIND_HOST}`)
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ ok: false, code: 'INVALID_INPUT', error: '只读页面只接受 GET' }))
      return
    }
    try {
      if (url.pathname === '/' || url.pathname === '/index.html') {
        const body = buildReadOnlyPage()
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
        res.end(req.method === 'HEAD' ? undefined : body)
        return
      }
      if (url.pathname === '/api/summary') {
        const body = JSON.stringify(buildSummary(engine))
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
        res.end(req.method === 'HEAD' ? undefined : body)
        return
      }
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('not found')
    } catch (error) {
      logger?.warn?.(`[flowpilot:web] 只读页处理请求失败：${error?.message ?? error}`)
      res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ ok: false, error: '只读页面渲染失败' }))
    }
  }

  /* ---------------- 读写模式（远程工作台） ---------------- */

  function tokenFrom(req, url) {
    const header = req.headers[TOKEN_HEADER]
    if (typeof header === 'string' && header !== '') return header
    const cookie = parseCookies(req.headers.cookie)[COOKIE_NAME]
    if (typeof cookie === 'string' && cookie !== '') return cookie
    const query = url.searchParams.get('token')
    return typeof query === 'string' ? query : ''
  }

  function tokenValid(candidate) {
    const expected = config.full.token
    if (typeof candidate !== 'string' || candidate === '' || expected === '') return false
    const a = Buffer.from(candidate)
    const b = Buffer.from(expected)
    if (a.length !== b.length) return false
    return timingSafeEqual(a, b)
  }

  function sameOrigin(req) {
    const origin = req.headers.origin
    if (typeof origin !== 'string' || origin === '') return true
    const host = req.headers.host
    if (typeof host !== 'string' || host === '') return false
    try {
      return new URL(origin).host === host
    } catch {
      return false
    }
  }

  function sendJson(res, statusCode, body, extraHeaders = {}) {
    res.writeHead(statusCode, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
      ...extraHeaders,
    })
    res.end(JSON.stringify(body))
  }

  function sendLogin(res, statusCode, message = '') {
    const html = buildLoginPage().replace('{{ERROR}}', esc(message))
    res.writeHead(statusCode, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
    })
    res.end(html)
  }

  function redirect(res, location, extraHeaders = {}) {
    res.writeHead(303, { location, 'cache-control': 'no-store', ...extraHeaders })
    res.end()
  }

  async function handleFull(req, res) {
    const url = new URL(req.url || '/', `http://${BIND_HOST}`)
    const path = url.pathname
    if (req.method !== 'GET' && req.method !== 'HEAD' && req.method !== 'POST') {
      sendJson(res, 405, { ok: false, code: 'INVALID_INPUT', error: 'method not allowed' })
      return
    }

    // 登录 / 退出
    if (path === '/login') {
      if (req.method === 'GET' || req.method === 'HEAD') {
        if (tokenValid(tokenFrom(req, url))) {
          redirect(res, '/')
          return
        }
        sendLogin(res, 200)
        return
      }
      try {
        const raw = await readBody(req)
        let token = ''
        const contentType = String(req.headers['content-type'] || '')
        if (contentType.includes('application/json')) {
          try {
            const parsed = JSON.parse(raw)
            token = parsed && typeof parsed.token === 'string' ? parsed.token : ''
          } catch {
            token = ''
          }
        } else {
          const params = new URLSearchParams(raw)
          token = params.get('token') || ''
        }
        if (!tokenValid(token)) {
          sendLogin(res, 401, '口令不正确')
          return
        }
        redirect(res, '/', { 'set-cookie': cookieHeader(token, COOKIE_MAX_AGE) })
      } catch (error) {
        sendLogin(res, 400, error?.message ?? '登录失败')
      }
      return
    }
    if (path === '/logout') {
      redirect(res, '/login', { 'set-cookie': cookieHeader('', 0) })
      return
    }

    const authed = tokenValid(tokenFrom(req, url))
    if (!authed) {
      if (path === '/' || path === '/index.html') {
        sendLogin(res, 200)
        return
      }
      sendJson(res, 401, { ok: false, code: 'UNAUTHORIZED', error: '需要访问口令' })
      return
    }

    // 通过 query 带口令访问时，顺手种 cookie，后续请求无需再带 token
    const cookieFix = url.searchParams.has('token') && tokenValid(url.searchParams.get('token') || '')
      ? { 'set-cookie': cookieHeader(config.full.token, COOKIE_MAX_AGE) }
      : {}

    if (path === '/api/state' && (req.method === 'GET' || req.method === 'HEAD')) {
      try {
        const snap = engine.snapshot()
        sendJson(res, 200, {
          ok: true,
          revision: snap.revision,
          state: snap.state,
          derived: snap.derived,
        }, cookieFix)
      } catch (error) {
        sendJson(res, 500, { ok: false, code: 'INTERNAL', error: error?.message ?? '读取状态失败' })
      }
      return
    }

    if (path === '/api/action' && req.method === 'POST') {
      if (!sameOrigin(req)) {
        sendJson(res, 403, { ok: false, code: 'FORBIDDEN', error: '跨站请求被拒绝' })
        return
      }
      const contentType = String(req.headers['content-type'] || '')
      if (!contentType.includes('application/json')) {
        sendJson(res, 415, { ok: false, code: 'INVALID_INPUT', error: '需要 application/json' })
        return
      }
      let body
      try {
        body = await readJsonBody(req)
      } catch (error) {
        sendJson(res, 400, { ok: false, code: 'INVALID_INPUT', error: error?.message ?? '请求体无效' })
        return
      }
      const action = body && typeof body.action === 'string' ? body.action : ''
      const payload = body && body.payload !== undefined && body.payload !== null ? body.payload : {}
      if (!ACTION_NAMES.includes(action)) {
        sendJson(res, 200, { ok: false, code: 'INVALID_INPUT', error: `未知动作：${action}` }, cookieFix)
        return
      }
      try {
        const out = engine.dispatch(action, payload, { actor: 'web' })
        logger?.info?.(`[flowpilot:web] 远程工作台执行 ${action}`)
        sendJson(res, 200, {
          ok: true,
          revision: out.revision,
          state: out.state,
          derived: out.derived,
          result: out.result,
        }, cookieFix)
      } catch (error) {
        const code = error instanceof FpError ? error.code : 'INTERNAL'
        sendJson(res, 200, { ok: false, code, error: error?.message ?? '操作失败' }, cookieFix)
      }
      return
    }

    if (path === '/' || path === '/index.html') {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        sendJson(res, 405, { ok: false, code: 'INVALID_INPUT', error: 'method not allowed' })
        return
      }
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
        'referrer-policy': 'no-referrer',
        ...cookieFix,
      })
      res.end(req.method === 'HEAD' ? undefined : buildFullPage())
      return
    }

    sendJson(res, 404, { ok: false, code: 'NOT_FOUND', error: 'not found' })
  }

  /* ---------------- 生命周期 ---------------- */

  function handleFor(mode) {
    return mode === 'readOnly' ? handleReadOnly : handleFull
  }

  function start(mode) {
    if (servers[mode] !== null) return Promise.resolve(status())
    const port = config[mode].port
    runtime[mode].error = null
    return new Promise((resolve, reject) => {
      const next = createServer((req, res) => {
        const handler = handleFor(mode)
        Promise.resolve(handler(req, res)).catch((error) => {
          logger?.warn?.(`[flowpilot:web] ${mode} 请求处理失败：${error?.message ?? error}`)
          try {
            sendJson(res, 500, { ok: false, code: 'INTERNAL', error: '处理失败' })
          } catch {
            /* 响应可能已结束 */
          }
        })
      })
      next.on('error', (error) => {
        runtime[mode].error = error?.message ?? String(error)
        try {
          next.close()
        } catch {
          /* ignore */
        }
        if (servers[mode] === next) servers[mode] = null
        reject(new FpError('INVALID_INPUT', `${mode === 'readOnly' ? '只读网页' : '远程工作台'}启动失败：${runtime[mode].error}`))
      })
      next.listen(port, BIND_HOST, () => {
        servers[mode] = next
        const address = next.address()
        runtime[mode].port = address && typeof address === 'object' ? address.port : port
        runtime[mode].startedAt = new Date().toISOString()
        try {
          if (typeof next.unref === 'function') next.unref()
        } catch {
          /* 不阻止宿主进程退出 */
        }
        logger?.info?.(`[flowpilot:web] ${mode === 'readOnly' ? '只读看板' : '远程工作台'}已启动：http://${BIND_HOST}:${runtime[mode].port}/`)
        resolve(status())
      })
    })
  }

  function stop(mode) {
    const current = servers[mode]
    if (current === null) return Promise.resolve(status())
    servers[mode] = null
    runtime[mode].port = null
    runtime[mode].startedAt = null
    return new Promise((resolve) => {
      current.close(() => resolve(status()))
      // 浏览器/fetch 会保持 keep-alive 连接，不主动断开的话 close 回调永远不触发
      try {
        if (typeof current.closeAllConnections === 'function') current.closeAllConnections()
        else if (typeof current.closeIdleConnections === 'function') current.closeIdleConnections()
      } catch {
        /* ignore */
      }
    })
  }

  /** 让某个模式的服务状态与配置一致（负责 start/stop）。 */
  async function reconcile(mode) {
    const wanted = config[mode].enabled
    const running = servers[mode] !== null
    const portChanged = running && runtime[mode].port !== config[mode].port
    if (!wanted) {
      if (running) await stop(mode)
      return
    }
    if (running && !portChanged) return
    if (running) await stop(mode)
    try {
      await start(mode)
    } catch (error) {
      runtime[mode].error = error?.message ?? String(error)
    }
  }

  function configure(patch) {
    return Promise.resolve()
      .then(async () => {
        if (patch !== null && patch !== undefined && typeof patch !== 'object') {
          throw new FpError('INVALID_INPUT', '配置必须是对象')
        }
        const input = patch !== null && typeof patch === 'object' ? patch : {}
        // 兼容旧调用 {enabled, port} → 只读模式
        const mode = input.mode === undefined ? 'readOnly' : input.mode
        if (!WEB_ACCESS_MODES.includes(mode)) {
          throw new FpError('INVALID_INPUT', 'mode 必须是 readOnly 或 full')
        }
        if (input.enabled !== undefined && typeof input.enabled !== 'boolean') {
          throw new FpError('INVALID_INPUT', 'enabled 必须是布尔值')
        }
        const requestedPort = input.port === undefined ? null : normalizePort(input.port)

        const next = {
          enabled: input.enabled === undefined ? config[mode].enabled : input.enabled,
          port: requestedPort === null ? config[mode].port : requestedPort,
          token: config.full.token,
        }
        if (mode === 'full') {
          if (input.token !== undefined) {
            if (typeof input.token !== 'string') throw new FpError('INVALID_INPUT', 'token 必须是字符串')
            const trimmed = input.token.trim()
            if (trimmed !== '' && (trimmed.length < TOKEN_MIN || trimmed.length > TOKEN_MAX)) {
              throw new FpError('INVALID_INPUT', `口令长度需在 ${TOKEN_MIN}–${TOKEN_MAX} 之间`)
            }
            if (trimmed !== '') next.token = trimmed
          }
          if (input.regenerateToken === true) next.token = generateToken()
          if (next.enabled && next.token === '') next.token = generateToken()
        }

        if (mode === 'readOnly') {
          if (next.enabled && config.full.enabled && next.port === config.full.port) {
            throw new FpError('INVALID_INPUT', '只读网页与远程工作台不能使用同一端口')
          }
        } else if (next.enabled && config.readOnly.enabled && next.port === config.readOnly.port) {
          throw new FpError('INVALID_INPUT', '只读网页与远程工作台不能使用同一端口')
        }

        config[mode].enabled = next.enabled
        config[mode].port = next.port
        if (mode === 'full') config.full.token = next.token
        persist()
        await reconcile('readOnly')
        await reconcile('full')
        return status()
      })
  }

  async function startup() {
    if (config.full.enabled && config.full.token === '') {
      config.full.token = generateToken()
      persist()
    }
    if (config.readOnly.enabled) {
      await start('readOnly').catch(() => {})
    }
    if (config.full.enabled) {
      await start('full').catch(() => {})
    }
    return status()
  }

  async function dispose() {
    await stop('readOnly')
    await stop('full')
    return status()
  }

  return { status, configure, start, stop, startup, dispose, configFile: resolvedFile }
}
