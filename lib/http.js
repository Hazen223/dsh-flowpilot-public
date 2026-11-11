/**
 * FlowPilot 宿主半 · HTTP API
 *
 * 归属：host-core
 * 用途：`/flowpilot/api/*` 路由（契约 §4 + docs/AI-PRD-DIALOG.md §3）：
 *   GET  /flowpilot/api/state   → {ok, revision, state, derived}
 *   POST /flowpilot/api/action  → {ok, revision, state, derived, result}；失败 {ok:false, error, code, state?, derived?}
 *   GET  /flowpilot/api/export  → 备份 JSON（content-disposition: attachment）
 *   POST /flowpilot/api/import  → 整体替换
 *   GET  /flowpilot/api/ai/status → {ok, available, provider, model, reason, modelSource}
 *   POST /flowpilot/api/ai/parse  → {ok, proposal, meta}
 *   POST /flowpilot/api/ai/apply  → {ok, projectId, lineId, flowId, nodeCount, revision, state, derived, result}
 * 安全：Origin 的 host 与 Host 头不一致 → 403（跨站校验）；请求体上限 1MB（导入 8MB）。
 * 约束：只 import `node:` 内置模块与包内相对模块；与框架无关（便于自测）。
 */

import { SYNC_ERROR_STATUS } from './sync.js'
import { UPDATE_ERROR_STATUS } from './update.js'
import { READONLY_ACTIONS } from './domain.js'
import { FpError, dateKey, isPlainObject } from './util.js'

const MAX_JSON_BODY_BYTES = 1_000_000
const MAX_IMPORT_BODY_BYTES = 8_000_000

/** 路由路径（index.js 用 kind:'exact' 注册；contract §4 / AI 契约 §3）。 */
export const API_PATHS = Object.freeze({
  state: '/flowpilot/api/state',
  action: '/flowpilot/api/action',
  export: '/flowpilot/api/export',
  import: '/flowpilot/api/import',
  aiStatus: '/flowpilot/api/ai/status',
  aiParse: '/flowpilot/api/ai/parse',
  aiApply: '/flowpilot/api/ai/apply',
  // 同步（SYNC.md §2）：默认关闭，配置后启用；凭据只在本地 sync.json，响应不回密钥
  syncStatus: '/flowpilot/api/sync/status',
  syncConfig: '/flowpilot/api/sync/config',
  syncTest: '/flowpilot/api/sync/test',
  syncRun: '/flowpilot/api/sync/run',
  syncPush: '/flowpilot/api/sync/push',
  syncPull: '/flowpilot/api/sync/pull',
  // 冲突审阅（SYNC.md §2.5）：merge 自动解决后的候选值，供 UI 逐条确认
  syncConflicts: '/flowpilot/api/sync/conflicts',
  syncConflictsResolve: '/flowpilot/api/sync/conflicts/resolve',
  syncConflictsClear: '/flowpilot/api/sync/conflicts/clear',
  // 版本检查与一键更新（UPDATE.md §2）：检查远端 tag；profile 安装形态下可重装并重启生效
  updateStatus: '/flowpilot/api/update/status',
  updateCheck: '/flowpilot/api/update/check',
  updateApply: '/flowpilot/api/update/apply',
  updateRestart: '/flowpilot/api/update/restart',
  // 本地只读网页（WEB-ACCESS.md）：GET 状态；POST {enabled, port} 开关/改端口
  webaccess: '/flowpilot/api/webaccess',
})

/** 错误码 → HTTP 状态码（AI_* 按 AI 契约 §3 映射到 502 / 422）。 */
const STATUS_BY_CODE = Object.freeze({
  INVALID_INPUT: 400,
  NOT_FOUND: 404,
  NEED_APPROVALS: 409,
  // 节点模型 v2：完成证据门槛（证据策略）取代 NEED_DESIGN_LINK；旧码保留映射，兼容老客户端。
  NEED_EVIDENCE: 409,
  NEED_DESIGN_LINK: 409,
  INVALID_STATE: 409,
  AI_NO_MODEL: 502,
  AI_CALL_FAILED: 502,
  AI_BAD_OUTPUT: 422,
  INTERNAL: 500,
})

/**
 * 本次请求的操作人来源：写进事件的 actor。
 * 默认 'ui'（浏览器客户端）；请求头 x-flowpilot-actor 有值时用它（agent 工具回落 'agent' 由 index.js 传）。
 */
function actorOf(req) {
  const header = req?.headers?.['x-flowpilot-actor']
  const value = typeof header === 'string' ? header.trim() : ''
  return value !== '' ? value : 'ui'
}

function errorMessage(error) {
  if (error instanceof Error) return error.message || String(error)
  return String(error)
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload)
  try {
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'content-length': Buffer.byteLength(body),
    })
    res.end(body)
  } catch (error) {
    // 响应可能已经发出（连接断开），这里只记录不抛
    throw error
  }
}

function sendAttachment(res, filename, text) {
  const body = String(text)
  res.writeHead(200, {
    'content-type': 'application/json; charset=utf-8',
    'content-disposition': `attachment; filename="${filename}"`,
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

/**
 * 跨站保护：只在浏览器带了 Origin 且其 host 与 Host 头不一致时拒绝。
 * 同源请求（无论是否带 Origin）一律放行，避免误伤 DSH 自己的页面。
 */
export function isCrossSite(req) {
  const origin = req?.headers?.origin
  if (typeof origin !== 'string' || origin === '' || origin === 'null') return false
  const host = req?.headers?.host
  if (typeof host !== 'string' || host === '') return false
  try {
    return new URL(origin).host !== host
  } catch {
    return true
  }
}

/** 读取并解析 JSON 请求体。 */
export async function readJsonBody(req, maxBytes = MAX_JSON_BODY_BYTES) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > maxBytes) throw new FpError('INVALID_INPUT', '请求体过大')
    chunks.push(chunk)
  }
  if (size === 0) return {}
  const text = Buffer.concat(chunks).toString('utf8')
  try {
    return JSON.parse(text)
  } catch {
    throw new FpError('INVALID_INPUT', '请求体不是合法 JSON')
  }
}

/**
 * 浏览器中途取消解析（AbortController / 关闭页面）→ 尽力中止上游 LLM 流。
 * 请求体读完后 req.complete 已为 true，所以主要看 res 是否在正常结束前被关闭。
 * 测试里的 fake req/res 没有 on()，直接返回一个未触发的 signal。
 */
function requestAbortSignal(req, res) {
  const controller = new AbortController()
  const abort = () => {
    try { controller.abort() } catch { /* 忽略 */ }
  }
  try {
    req?.on?.('close', () => {
      if (!req.complete) abort()
    })
  } catch {
    // 忽略：拿不到请求事件也不影响解析
  }
  try {
    res?.on?.('close', () => {
      if (!res.writableEnded) abort()
    })
  } catch {
    // 忽略
  }
  return controller.signal
}

/* ------------------------------------------------------------------ *
 * 同步 · 最新覆盖（newest-wins）
 * ------------------------------------------------------------------ */

/** POST /sync/run 支持的 mode：merge = 记录级三方合并（默认）；newest = 整份最新覆盖；three-way = 旧三路比较（deprecated）。 */
export const SYNC_RUN_MODES = Object.freeze(['merge', 'newest', 'three-way'])

/** 客户端（定时同步 / 顶栏同步按钮 / 写后自动同步）不传 mode 时按「三方合并」执行。 */
export const DEFAULT_SYNC_RUN_MODE = 'merge'

function pickInteger(...values) {
  for (const value of values) {
    if (Number.isInteger(value)) return value
  }
  return null
}

function pickText(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value !== '') return value
  }
  return null
}

/**
 * 把 syncService.run() 的返回值归一化成客户端消费的 `result` 结构：
 * { direction, uploaded, localRevision, remoteRevision, localUpdatedAt, remoteUpdatedAt, ... }。
 * 三路比较（旧行为）也能得到同样的形状（direction 回退到 action）。
 */
/** @param {any} out  service.run() 返回值
 *  @param {'merge'|'newest'|'three-way'|null} [requestedMode] 本次请求显式指定的模式（service 未回 mode 时用它兜底） */
export function syncRunResultOf(out, requestedMode) {
  const payload = isPlainObject(out) ? out : {}
  const local = isPlainObject(payload.local) ? payload.local : {}
  const remote = isPlainObject(payload.remote) ? payload.remote : {}
  const ACTIONS = ['push', 'pull', 'noop', 'merge']
  const action = ACTIONS.includes(payload.action) ? payload.action : ''
  const direction = ACTIONS.includes(payload.direction) ? payload.direction : (action === '' ? 'noop' : action)
  const modes = ['merge', 'newest', 'three-way']
  const result = {
    mode: modes.includes(payload.mode)
      ? payload.mode
      : modes.includes(requestedMode)
        ? requestedMode
        : DEFAULT_SYNC_RUN_MODE,
    direction,
    action: action === '' ? direction : action,
    // newest 模式总会回传；旧的自动 push 也算已上传，pull / noop 不算
    uploaded: payload.uploaded === true || action === 'push',
    localRevision: pickInteger(payload.localRevision, local.revision),
    remoteRevision: pickInteger(payload.remoteRevision, remote.revision),
    localUpdatedAt: pickText(payload.localUpdatedAt, local.updatedAt),
    remoteUpdatedAt: pickText(payload.remoteUpdatedAt, remote.updatedAt),
    dryRun: payload.dryRun === true,
  }
  const bytes = pickInteger(payload.bytes)
  if (bytes !== null) result.bytes = bytes
  if (typeof payload.backupPath === 'string' && payload.backupPath !== '') result.backupPath = payload.backupPath
  if (typeof payload.reason === 'string' && payload.reason !== '') result.reason = payload.reason
  // merge 模式的额外字段（合并统计 / base 信息），透传给客户端
  const mergedRevision = pickInteger(payload.mergedRevision)
  if (mergedRevision !== null) result.mergedRevision = mergedRevision
  if (typeof payload.basePath === 'string' && payload.basePath !== '') result.basePath = payload.basePath
  if (payload.baseMissing === true) result.baseMissing = true
  const baseRevision = pickInteger(payload.baseRevision)
  if (baseRevision !== null) result.baseRevision = baseRevision
  if (isPlainObject(payload.merged)) result.merged = payload.merged
  return result
}

/**
 * 创建路由处理器列表（供 index.js 逐一注册到 webServer）。
 * @param {{ engine: any, aiService?: any, logger?: any, syncService?: any, updateService?: any }} options
 *   aiService = createAiService(...) 的返回值；缺省时 AI 路由降级（status 报不可用、parse/apply 503）。
 *   syncService = createSyncService(...) 的返回值；缺省时同步路由降级为 503（不影响其它路由）。
 *   updateService = createUpdateService(...) 的返回值；缺省时更新路由降级为 503（不影响其它路由）。
 * @returns {{ path: string, handler: (req: any, res: any) => void }[]}
 */
export function createRoutes({ engine, aiService, logger, syncService, updateService, webAccessService } = {}) {
  if (!engine || typeof engine.dispatch !== 'function') {
    throw new Error('createRoutes 需要 engine（createEngine 的返回值）')
  }

  /** 只读 action 集合：这些不触发「写后自动同步」，避免查询也跑一次网络同步。 */
  const READONLY_SET = new Set(READONLY_ACTIONS)

  /** 本地写成功后通知同步服务（自动同步 newest，宿主侧防抖；绝不抛）。 */
  const notifyLocalWrite = () => {
    try {
      syncService?.noteLocalWrite?.()
    } catch (error) {
      logger?.warn?.(`[flowpilot] 通知同步服务失败（忽略）：${errorMessage(error)}`)
    }
  }

  const claim = (label, handler) => (req, res) => Promise.resolve()
    .then(() => handler(req, res))
    .catch((error) => {
      logger?.warn?.(`[flowpilot] ${label} 路由出错：${errorMessage(error)}`)
      try {
        const code = error instanceof FpError ? error.code : 'INTERNAL'
        sendJson(res, STATUS_BY_CODE[code] ?? 500, { ok: false, code, error: errorMessage(error) })
      } catch {
        // 响应头已经发出，忽略
      }
    })

  const stateHandler = claim('state', async (req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return sendJson(res, 405, { ok: false, code: 'INVALID_INPUT', error: '只接受 GET' })
    }
    if (isCrossSite(req)) return sendJson(res, 403, { ok: false, code: 'INVALID_INPUT', error: '跨站请求被拒绝' })
    const snapshot = engine.snapshot()
    return sendJson(res, 200, {
      ok: true,
      revision: snapshot.revision,
      state: snapshot.state,
      derived: snapshot.derived,
    })
  })

  const actionHandler = claim('action', async (req, res) => {
    if (req.method !== 'POST') return sendJson(res, 405, { ok: false, code: 'INVALID_INPUT', error: '只接受 POST' })
    if (isCrossSite(req)) return sendJson(res, 403, { ok: false, code: 'INVALID_INPUT', error: '跨站请求被拒绝' })
    let body
    try {
      body = await readJsonBody(req)
    } catch (error) {
      const code = error instanceof FpError ? error.code : 'INVALID_INPUT'
      return sendJson(res, STATUS_BY_CODE[code] ?? 400, { ok: false, code, error: errorMessage(error) })
    }
    const action = typeof body?.action === 'string' ? body.action.trim() : ''
    if (action === '') {
      return sendJson(res, 400, { ok: false, code: 'INVALID_INPUT', error: '缺少 action 参数' })
    }
    const payload = body?.payload === undefined || body?.payload === null ? {} : body.payload
    if (!isPlainObject(payload)) {
      return sendJson(res, 400, { ok: false, code: 'INVALID_INPUT', error: 'payload 必须是对象' })
    }
    try {
      // HTTP 路由是浏览器客户端发起 → actor 默认 'ui'（可被 x-flowpilot-actor 覆盖）。
      const out = engine.dispatch(action, payload, { actor: actorOf(req) })
      // 本地写成功 → 通知同步服务（写后自动同步 merge，宿主侧防抖；只读 action 跳过）
      if (!READONLY_SET.has(action)) notifyLocalWrite()
      return sendJson(res, 200, {
        ok: true,
        revision: out.revision,
        state: out.state,
        derived: out.derived,
        result: out.result,
      })
    } catch (error) {
      const code = error instanceof FpError ? error.code : 'INTERNAL'
      const bodyOut = { ok: false, code, error: errorMessage(error) }
      // 失败时也带上最新 state/derived，客户端可以恢复一致视图
      try {
        const snapshot = engine.snapshot()
        bodyOut.revision = snapshot.revision
        bodyOut.state = snapshot.state
        bodyOut.derived = snapshot.derived
      } catch {
        // 数据文件本身坏了，只返回错误
      }
      if (!(error instanceof FpError)) logger?.warn?.(`[flowpilot] action ${action} 失败：${errorMessage(error)}`)
      return sendJson(res, STATUS_BY_CODE[code] ?? 500, bodyOut)
    }
  })

  const exportHandler = claim('export', async (req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return sendJson(res, 405, { ok: false, code: 'INVALID_INPUT', error: '只接受 GET' })
    }
    if (isCrossSite(req)) return sendJson(res, 403, { ok: false, code: 'INVALID_INPUT', error: '跨站请求被拒绝' })
    const payload = engine.exportBackup()
    const filename = `FlowPilot-backup-${dateKey(new Date())}.json`
    return sendAttachment(res, filename, JSON.stringify(payload, null, 2))
  })

  const importHandler = claim('import', async (req, res) => {
    if (req.method !== 'POST') return sendJson(res, 405, { ok: false, code: 'INVALID_INPUT', error: '只接受 POST' })
    if (isCrossSite(req)) return sendJson(res, 403, { ok: false, code: 'INVALID_INPUT', error: '跨站请求被拒绝' })
    let body
    try {
      body = await readJsonBody(req, MAX_IMPORT_BODY_BYTES)
    } catch (error) {
      const code = error instanceof FpError ? error.code : 'INVALID_INPUT'
      return sendJson(res, STATUS_BY_CODE[code] ?? 400, { ok: false, code, error: errorMessage(error) })
    }
    try {
      const out = engine.importBackup(body)
      return sendJson(res, 200, {
        ok: true,
        revision: out.revision,
        state: out.state,
        derived: out.derived,
        result: { imported: true },
      })
    } catch (error) {
      const code = error instanceof FpError ? error.code : 'INTERNAL'
      return sendJson(res, STATUS_BY_CODE[code] ?? 500, { ok: false, code, error: errorMessage(error) })
    }
  })

  /* ---------------- AI PRD 解析（AI 契约 §3） ---------------- */

  const aiReady = () => Boolean(aiService && typeof aiService === 'object')
  const aiServiceMissing = (res) => sendJson(res, 503, {
    ok: false, code: 'INTERNAL', error: 'AI 服务未初始化（宿主未创建 createAiService）',
  })
  const notPost = (res) => sendJson(res, 405, { ok: false, code: 'INVALID_INPUT', error: '只接受 POST' })
  const notGet = (res) => sendJson(res, 405, { ok: false, code: 'INVALID_INPUT', error: '只接受 GET' })
  const crossSite = (res) => sendJson(res, 403, { ok: false, code: 'INVALID_INPUT', error: '跨站请求被拒绝' })

  const aiStatusHandler = claim('aiStatus', async (req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return notGet(res)
    if (isCrossSite(req)) return crossSite(res)
    if (!aiReady() || typeof aiService.status !== 'function') {
      return sendJson(res, 200, {
        ok: true, available: false, provider: null, model: null,
        reason: 'AI 服务未初始化，可改用规则解析', modelSource: 'none',
      })
    }
    const status = await aiService.status()
    return sendJson(res, 200, {
      ok: true,
      available: Boolean(status?.available),
      provider: status?.provider ?? null,
      model: status?.model ?? null,
      reason: status?.reason ?? null,
      modelSource: status?.modelSource ?? 'none',
    })
  })

  const aiParseHandler = claim('aiParse', async (req, res) => {
    if (req.method !== 'POST') return notPost(res)
    if (isCrossSite(req)) return crossSite(res)
    if (!aiReady() || typeof aiService.parsePrd !== 'function') return aiServiceMissing(res)
    let body
    try {
      body = await readJsonBody(req)
    } catch (error) {
      const code = error instanceof FpError ? error.code : 'INVALID_INPUT'
      return sendJson(res, STATUS_BY_CODE[code] ?? 400, { ok: false, code, error: errorMessage(error) })
    }
    const out = await aiService.parsePrd({
      text: typeof body?.text === 'string' ? body.text : '',
      businessLineHint: typeof body?.businessLineHint === 'string' ? body.businessLineHint : '',
      extraInstructions: typeof body?.extraInstructions === 'string' ? body.extraInstructions : '',
      signal: requestAbortSignal(req, res),
    })
    return sendJson(res, 200, {
      ok: true,
      proposal: out?.proposal ?? null,
      meta: out?.meta ?? null,
    })
  })

  const aiApplyHandler = claim('aiApply', async (req, res) => {
    if (req.method !== 'POST') return notPost(res)
    if (isCrossSite(req)) return crossSite(res)
    if (!aiReady() || typeof aiService.applyProposal !== 'function') return aiServiceMissing(res)
    let body
    try {
      body = await readJsonBody(req)
    } catch (error) {
      const code = error instanceof FpError ? error.code : 'INVALID_INPUT'
      return sendJson(res, STATUS_BY_CODE[code] ?? 400, { ok: false, code, error: errorMessage(error) })
    }
    if (!isPlainObject(body)) return sendJson(res, 400, { ok: false, code: 'INVALID_INPUT', error: '请求体必须是对象' })
    const out = await aiService.applyProposal({
      proposal: body?.proposal,
      businessLineId: typeof body?.businessLineId === 'string' ? body.businessLineId : '',
    })
    // AI 建项目也是一次本地写 → 通知同步服务（自动推送防抖）
    notifyLocalWrite()
    return sendJson(res, 200, {
      ok: true,
      projectId: out?.projectId ?? null,
      lineId: out?.lineId ?? null,
      flowId: out?.flowId ?? null,
      nodeCount: out?.nodeCount ?? 0,
      revision: out?.revision ?? null,
      state: out?.state ?? null,
      derived: out?.derived ?? null,
      result: out?.result ?? null,
    })
  })

  /* ---------------- 双向同步（SYNC.md §2） ---------------- */

  const syncReady = () => Boolean(syncService && typeof syncService === 'object')
  const syncServiceMissing = (res) => sendJson(res, 503, {
    ok: false, code: 'INTERNAL', error: '同步服务未初始化（宿主未创建 createSyncService）',
  })

  /**
   * 同步路由的错误处理：SyncError 的 SYNC_* 错误码映射到 SYNC.md §2.4 状态码；
   * 冲突（409）额外透出 conflict 结构（含 options），供客户端就地选择方向。
   */
  const syncClaim = (label, handler) => (req, res) => Promise.resolve()
    .then(() => handler(req, res))
    .catch((error) => {
      logger?.warn?.(`[flowpilot] ${label} 路由出错：${errorMessage(error)}`)
      try {
        const rawCode = typeof error?.code === 'string' ? error.code : ''
        const known = rawCode !== '' && (SYNC_ERROR_STATUS[rawCode] !== undefined || STATUS_BY_CODE[rawCode] !== undefined)
        const code = known ? rawCode : 'INTERNAL'
        const status = SYNC_ERROR_STATUS[code] ?? STATUS_BY_CODE[code] ?? 500
        const bodyOut = { ok: false, code, error: errorMessage(error) }
        if (error && error.conflict !== undefined) bodyOut.conflict = error.conflict
        sendJson(res, status, bodyOut)
      } catch {
        // 响应头已经发出，忽略
      }
    })

  const syncStatusHandler = syncClaim('syncStatus', async (req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return notGet(res)
    if (isCrossSite(req)) return crossSite(res)
    if (!syncReady() || typeof syncService.status !== 'function') return syncServiceMissing(res)
    return sendJson(res, 200, { ok: true, status: syncService.status() })
  })

  const syncConfigHandler = syncClaim('syncConfig', async (req, res) => {
    if (req.method !== 'POST') return notPost(res)
    if (isCrossSite(req)) return crossSite(res)
    if (!syncReady() || typeof syncService.configure !== 'function') return syncServiceMissing(res)
    let body
    try {
      body = await readJsonBody(req)
    } catch (error) {
      const code = error instanceof FpError ? error.code : 'INVALID_INPUT'
      return sendJson(res, STATUS_BY_CODE[code] ?? 400, { ok: false, code, error: errorMessage(error) })
    }
    if (!isPlainObject(body)) return sendJson(res, 400, { ok: false, code: 'INVALID_INPUT', error: '配置必须是对象' })
    const status = await syncService.configure(body)
    return sendJson(res, 200, { ok: true, status })
  })

  const syncTestHandler = syncClaim('syncTest', async (req, res) => {
    if (req.method !== 'POST') return notPost(res)
    if (isCrossSite(req)) return crossSite(res)
    if (!syncReady() || typeof syncService.test !== 'function') return syncServiceMissing(res)
    await readJsonBody(req).catch(() => ({}))
    const detail = await syncService.test()
    return sendJson(res, 200, { ok: true, detail })
  })

  const syncRunHandler = syncClaim('syncRun', async (req, res) => {
    if (req.method !== 'POST') return notPost(res)
    if (isCrossSite(req)) return crossSite(res)
    if (!syncReady() || typeof syncService.run !== 'function') return syncServiceMissing(res)
    let body
    try {
      body = await readJsonBody(req)
    } catch (error) {
      const code = error instanceof FpError ? error.code : 'INVALID_INPUT'
      return sendJson(res, STATUS_BY_CODE[code] ?? 400, { ok: false, code, error: errorMessage(error) })
    }
    const force = body?.force
    if (force !== undefined && force !== null && force !== 'push' && force !== 'pull') {
      return sendJson(res, 400, { ok: false, code: 'INVALID_INPUT', error: 'force 只能是 push 或 pull' })
    }
    const rawMode = body?.mode
    if (rawMode !== undefined && rawMode !== null && !SYNC_RUN_MODES.includes(rawMode)) {
      return sendJson(res, 400, {
        ok: false, code: 'INVALID_INPUT', error: `mode 只能是 ${SYNC_RUN_MODES.join(' 或 ')}`,
      })
    }
    const resolvedMode = SYNC_RUN_MODES.includes(rawMode) ? rawMode : DEFAULT_SYNC_RUN_MODE
    const out = await syncService.run({
      // 不传 mode → 默认三方合并；显式 newest / three-way 走整份覆盖 / 旧三路比较。
      mode: resolvedMode,
      force: force === 'push' || force === 'pull' ? force : undefined,
      dryRun: body?.dryRun === true,
    })
    // 顶层保留旧字段（action / local / remote / revision 等，老客户端兼容），
    // 另加 result 结构给新客户端：result.direction / uploaded / localRevision / remoteRevision / ...
    // service 自己给的嵌套 result（merge 模式的 merged/base 等字段更完整）优先，归一化结构兜底
    const nested = isPlainObject(out.result) ? out.result : {}
    return sendJson(res, 200, { ok: true, ...out, result: { ...syncRunResultOf(out, resolvedMode), ...nested } })
  })

  const syncPushHandler = syncClaim('syncPush', async (req, res) => {
    if (req.method !== 'POST') return notPost(res)
    if (isCrossSite(req)) return crossSite(res)
    if (!syncReady() || typeof syncService.push !== 'function') return syncServiceMissing(res)
    let body
    try {
      body = await readJsonBody(req)
    } catch (error) {
      const code = error instanceof FpError ? error.code : 'INVALID_INPUT'
      return sendJson(res, STATUS_BY_CODE[code] ?? 400, { ok: false, code, error: errorMessage(error) })
    }
    const out = await syncService.push({ force: body?.force === true })
    return sendJson(res, 200, { ok: true, ...out })
  })

  const syncPullHandler = syncClaim('syncPull', async (req, res) => {
    if (req.method !== 'POST') return notPost(res)
    if (isCrossSite(req)) return crossSite(res)
    if (!syncReady() || typeof syncService.pull !== 'function') return syncServiceMissing(res)
    let body
    try {
      body = await readJsonBody(req)
    } catch (error) {
      const code = error instanceof FpError ? error.code : 'INVALID_INPUT'
      return sendJson(res, STATUS_BY_CODE[code] ?? 400, { ok: false, code, error: errorMessage(error) })
    }
    const out = await syncService.pull({ force: body?.force === true })
    return sendJson(res, 200, { ok: true, ...out })
  })

  /* ---------------- 冲突审阅（SYNC.md §2.5） ---------------- */

  const syncConflictsHandler = syncClaim('syncConflicts', async (req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return notGet(res)
    if (isCrossSite(req)) return crossSite(res)
    if (!syncReady() || typeof syncService.conflicts !== 'function') return syncServiceMissing(res)
    // 未配置通道也能读（UI 展示 + 文件不存在时 count:0）
    return sendJson(res, 200, { ok: true, ...syncService.conflicts() })
  })

  const syncConflictsResolveHandler = syncClaim('syncConflictsResolve', async (req, res) => {
    if (req.method !== 'POST') return notPost(res)
    if (isCrossSite(req)) return crossSite(res)
    if (!syncReady() || typeof syncService.resolveConflicts !== 'function') return syncServiceMissing(res)
    let body
    try {
      body = await readJsonBody(req)
    } catch (error) {
      const code = error instanceof FpError ? error.code : 'INVALID_INPUT'
      return sendJson(res, STATUS_BY_CODE[code] ?? 400, { ok: false, code, error: errorMessage(error) })
    }
    const choice = body?.choice
    if (choice !== 'local' && choice !== 'remote') {
      return sendJson(res, 400, { ok: false, code: 'INVALID_INPUT', error: 'choice 只能是 local 或 remote' })
    }
    const all = body?.all === true
    const id = typeof body?.id === 'string' ? body.id.trim() : ''
    if (!all && id === '') {
      return sendJson(res, 400, { ok: false, code: 'INVALID_INPUT', error: '缺少 id（或用 all:true 批量处理）' })
    }
    const out = await syncService.resolveConflicts({ id, choice, all })
    return sendJson(res, 200, { ok: true, ...out })
  })

  const syncConflictsClearHandler = syncClaim('syncConflictsClear', async (req, res) => {
    if (req.method !== 'POST') return notPost(res)
    if (isCrossSite(req)) return crossSite(res)
    if (!syncReady() || typeof syncService.clearConflicts !== 'function') return syncServiceMissing(res)
    await readJsonBody(req).catch(() => ({}))
    return sendJson(res, 200, { ok: true, ...syncService.clearConflicts() })
  })

  /* ---------------- 版本检查与一键更新（UPDATE.md §2） ---------------- */

  const updateReady = () => Boolean(updateService && typeof updateService === 'object')
  const updateServiceMissing = (res) => sendJson(res, 503, {
    ok: false, code: 'INTERNAL', error: '更新服务未初始化（宿主未创建 createUpdateService）',
  })

  /** UpdateError 的 UPDATE_* 错误码 → UPDATE.md §2.4 状态码；其它按 INTERNAL 处理。 */
  const updateClaim = (label, handler) => (req, res) => Promise.resolve()
    .then(() => handler(req, res))
    .catch((error) => {
      logger?.warn?.(`[flowpilot] ${label} 路由出错：${errorMessage(error)}`)
      try {
        const rawCode = typeof error?.code === 'string' ? error.code : ''
        const known = rawCode !== '' && (UPDATE_ERROR_STATUS[rawCode] !== undefined || STATUS_BY_CODE[rawCode] !== undefined)
        const code = known ? rawCode : 'INTERNAL'
        const status = UPDATE_ERROR_STATUS[code] ?? STATUS_BY_CODE[code] ?? 500
        sendJson(res, status, { ok: false, code, error: errorMessage(error) })
      } catch {
        // 响应头已经发出，忽略
      }
    })

  const updateStatusHandler = updateClaim('updateStatus', async (req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return notGet(res)
    if (isCrossSite(req)) return crossSite(res)
    if (!updateReady() || typeof updateService.status !== 'function') return updateServiceMissing(res)
    return sendJson(res, 200, { ok: true, status: updateService.status() })
  })

  const updateCheckHandler = updateClaim('updateCheck', async (req, res) => {
    if (req.method !== 'POST') return notPost(res)
    if (isCrossSite(req)) return crossSite(res)
    if (!updateReady() || typeof updateService.check !== 'function') return updateServiceMissing(res)
    await readJsonBody(req).catch(() => ({}))
    const status = await updateService.check({ force: true })
    return sendJson(res, 200, { ok: true, status })
  })

  const updateApplyHandler = updateClaim('updateApply', async (req, res) => {
    if (req.method !== 'POST') return notPost(res)
    if (isCrossSite(req)) return crossSite(res)
    if (!updateReady() || typeof updateService.apply !== 'function') return updateServiceMissing(res)
    await readJsonBody(req).catch(() => ({}))
    const status = await updateService.apply()
    return sendJson(res, 200, { ok: true, status })
  })

  const updateRestartHandler = updateClaim('updateRestart', async (req, res) => {
    if (req.method !== 'POST') return notPost(res)
    if (isCrossSite(req)) return crossSite(res)
    if (!updateReady() || typeof updateService.restart !== 'function') return updateServiceMissing(res)
    await readJsonBody(req).catch(() => ({}))
    const out = updateService.restart()
    return sendJson(res, 200, { ok: true, ...out })
  })

  const webAccessHandler = claim('webaccess', async (req, res) => {
    if (isCrossSite(req)) return crossSite(res)
    if (!webAccessService || typeof webAccessService.status !== 'function') {
      return sendJson(res, 503, { ok: false, code: 'INTERNAL', error: '网页访问服务未启动' })
    }
    if (req.method === 'GET' || req.method === 'HEAD') {
      return sendJson(res, 200, { ok: true, status: webAccessService.status() })
    }
    if (req.method !== 'POST') return notPost(res)
    let body
    try {
      body = await readJsonBody(req)
    } catch (error) {
      const code = error instanceof FpError ? error.code : 'INVALID_INPUT'
      return sendJson(res, STATUS_BY_CODE[code] ?? 400, { ok: false, code, error: errorMessage(error) })
    }
    const patch = {
      // mode: 'readOnly'（只读看板）| 'full'（远程工作台）；省略兼容旧版 = readOnly
      mode: body?.mode === undefined ? undefined : body.mode,
      enabled: body?.enabled === undefined ? undefined : body.enabled,
      port: body?.port === undefined ? undefined : body.port,
      token: body?.token === undefined ? undefined : body.token,
      regenerateToken: body?.regenerateToken === true ? true : undefined,
    }
    const status = await webAccessService.configure(patch)
    return sendJson(res, 200, { ok: true, status })
  })

  return [
    { path: API_PATHS.state, handler: stateHandler },
    { path: API_PATHS.action, handler: actionHandler },
    { path: API_PATHS.export, handler: exportHandler },
    { path: API_PATHS.import, handler: importHandler },
    { path: API_PATHS.aiStatus, handler: aiStatusHandler },
    { path: API_PATHS.aiParse, handler: aiParseHandler },
    { path: API_PATHS.aiApply, handler: aiApplyHandler },
    { path: API_PATHS.syncStatus, handler: syncStatusHandler },
    { path: API_PATHS.syncConfig, handler: syncConfigHandler },
    { path: API_PATHS.syncTest, handler: syncTestHandler },
    { path: API_PATHS.syncRun, handler: syncRunHandler },
    { path: API_PATHS.syncPush, handler: syncPushHandler },
    { path: API_PATHS.syncPull, handler: syncPullHandler },
    { path: API_PATHS.syncConflicts, handler: syncConflictsHandler },
    { path: API_PATHS.syncConflictsResolve, handler: syncConflictsResolveHandler },
    { path: API_PATHS.syncConflictsClear, handler: syncConflictsClearHandler },
    { path: API_PATHS.updateStatus, handler: updateStatusHandler },
    { path: API_PATHS.updateCheck, handler: updateCheckHandler },
    { path: API_PATHS.updateApply, handler: updateApplyHandler },
    { path: API_PATHS.updateRestart, handler: updateRestartHandler },
    { path: API_PATHS.webaccess, handler: webAccessHandler },
  ]
}
