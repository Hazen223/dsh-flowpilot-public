/**
 * FlowPilot —— DSH Harness Web UI 插件 · 宿主半（Node ESM，无构建步骤）
 *
 * 做什么：
 * - 工具 `flowpilot`：agent 通过一个 action 参数读写项目 / 流程节点 / 周报 / 交接；
 *   另有 AI 建流程 action：`parsePrd`（只解析）/ `createProjectFromPrd`（解析并建项目）；
 * - HTTP 路由 `/flowpilot/api/{state,action,export,import}` + `/flowpilot/api/ai/{status,parse,apply}`；
 * - 数据存放在 `~/.dsh/flowpilot/data.json`（`config.dataDir` 可覆盖，原子写 + revision 对账）。
 *
 * 依赖策略（重要）：
 * - 本机 desktop profile 是 `autoInstallPeers: false`，`node_modules` 里没有
 *   `@deepseek-ai/dsh-tools`；顶层裸 import 会让整条插件 `failed to import`、完全不激活。
 *   因此工具定义用 `lib/tooldef.js` 的本地 `defineTool`（标准 JSON Schema + 普通对象），
 *   `ctx.tools.register(def)` 直接接受它。
 * - `webServer` 属于可选能力：`inject` 只声明 `['tools']`（未 inject 的 cordis 服务直接读属性会抛），
 *   运行时用 `ctx.get('webServer')` 探测；拿不到就只注册工具、不注册路由，插件照常激活。
 * - `llm` / `agentDefaultModel` **不写进 inject**：无 LLM 的 profile 也要能激活插件；
 *   `lib/ai.js` 运行时 `ctx.get(...)` 懒取 + try/catch，拿不到就退回规则解析。
 */

import { createAiService } from './lib/ai.js'
import { createEngine, summarizeResult } from './lib/domain.js'
import { API_PATHS, createRoutes } from './lib/http.js'
import { createSyncService } from './lib/sync.js'
import { createUpdateService } from './lib/update.js'
import { AI_TOOL_ACTIONS, FP_SYNC_ACTIONS, createFlowPilotSyncTool, createFlowPilotTool, toPayload } from './lib/tooldef.js'
import { FpError } from './lib/util.js'

export const name = 'flowpilot'

/**
 * 必需注入：tools（注册 agent 工具）+ webServer（注册 /flowpilot/api/* 路由）。
 * webServer 必须显式 inject —— 本机实测（2026-11-03 11:13 重启日志）插件行若只注入 tools，
 * cordis 会在 webServer 就绪之前就 apply，`ctx.get('webServer')` 取到 undefined，
 * 面板侧 fetch('/flowpilot/api/state') 全部 404（界面显示「FlowPilot 未连接」）。
 * inject 会让 cordis 等到 webServer 就绪后再 apply（与 dsh-plugin-magi 相同做法）。
 */
export const inject = ['tools', 'webServer']

/** 把 loader 行里的 config 规整成宿主需要的形状（容忍 undefined / 空串）。 */
function normalizeConfig(rawConfig) {
  const raw = rawConfig && typeof rawConfig === 'object' ? rawConfig : {}
  const dataDir = typeof raw.dataDir === 'string' && raw.dataDir.trim() !== '' ? raw.dataDir.trim() : undefined
  const dataFile = typeof raw.dataFile === 'string' && raw.dataFile.trim() !== '' ? raw.dataFile.trim() : undefined
  const aiProvider = typeof raw.aiProvider === 'string' && raw.aiProvider.trim() !== '' ? raw.aiProvider.trim() : undefined
  const aiModel = typeof raw.aiModel === 'string' && raw.aiModel.trim() !== '' ? raw.aiModel.trim() : undefined
  const aiTimeoutMs = Number(raw.aiTimeoutMs) > 0 ? Number(raw.aiTimeoutMs) : undefined
  // 同步配置文件位置（默认 <dataDir>/sync.json，即 ~/.dsh/flowpilot/sync.json；测试可覆盖）
  const syncFile = typeof raw.syncFile === 'string' && raw.syncFile.trim() !== '' ? raw.syncFile.trim() : undefined
  return { dataDir, dataFile, aiProvider, aiModel, aiTimeoutMs, syncFile }
}

function errorText(error) {
  if (error instanceof Error) return error.message || String(error)
  return String(error)
}

/** 尝试拿 webServer 服务：cordis 用 ctx.get；测试/降级场景允许普通对象属性。 */
function resolveWebServer(ctx, logger) {
  if (typeof ctx?.get === 'function') {
    try {
      const service = ctx.get('webServer')
      return service && typeof service.register === 'function' ? service : null
    } catch (error) {
      logger?.warn?.(`[flowpilot] 获取 webServer 失败（继续只注册工具）：${errorText(error)}`)
      return null
    }
  }
  const direct = ctx?.webServer
  return direct && typeof direct.register === 'function' ? direct : null
}

/** 确保返回值是 JSON 可序列化对象（工具返回值要求）。 */
function toJsonValue(value) {
  if (value === undefined) return null
  try {
    const serialized = JSON.stringify(value)
    return serialized === undefined ? null : JSON.parse(serialized)
  } catch {
    return { unserializable: true }
  }
}

/**
 * AI 专用工具 action（不走 engine.dispatch）：
 * - parsePrd({ text, businessLineHint?, extraInstructions? }) → { proposal, meta }（只解析，不落库）
 * - createProjectFromPrd({ text, businessLineId?, businessLineName? }) → 解析 + applyProposal（写库）
 */
async function executeAiTool(action, aiService, logger, args) {
  if (!aiService || typeof aiService.parsePrd !== 'function') {
    return { ok: false, action, code: 'AI_NO_MODEL', error: 'AI 服务未初始化', summary: '失败：AI 服务未初始化' }
  }
  try {
    const text = typeof args?.text === 'string' ? args.text : ''
    const businessLineHint = typeof args?.businessLineHint === 'string' ? args.businessLineHint : ''
    const extraInstructions = typeof args?.extraInstructions === 'string' ? args.extraInstructions : ''
    const parsed = await aiService.parsePrd({ text, businessLineHint, extraInstructions })
    const source = parsed?.meta?.source === 'llm' ? '模型解析' : '规则解析'
    if (action === 'parsePrd') {
      return {
        ok: true,
        action,
        result: toJsonValue({ proposal: parsed.proposal, meta: parsed.meta }),
        summary: `已解析 PRD（${source}）：${parsed.proposal?.nodes?.length ?? 0} 个节点，项目标题「${parsed.proposal?.title ?? ''}」`,
        counts: null,
      }
    }
    // createProjectFromPrd：解析 → 允许工具覆盖业务线名 → 落库
    const proposal = { ...(parsed.proposal ?? {}) }
    const explicitLineName = typeof args?.businessLineName === 'string' ? args.businessLineName.trim() : ''
    if (explicitLineName !== '') proposal.businessLineName = explicitLineName
    const applied = await aiService.applyProposal({
      proposal,
      businessLineId: typeof args?.businessLineId === 'string' ? args.businessLineId : '',
    })
    const lineName = applied.state?.businessLines?.find((line) => line.id === applied.lineId)?.name ?? null
    const result = {
      projectId: applied.projectId,
      lineId: applied.lineId,
      flowId: applied.flowId,
      title: proposal.title ?? '',
      nodeCount: applied.nodeCount,
      lineName,
    }
    return {
      ok: true,
      action,
      revision: applied.revision,
      result: toJsonValue(result),
      summary: `已创建项目「${proposal.title ?? ''}」，${applied.nodeCount} 个节点（${source}；业务线：${lineName ?? '未知'}）`,
      counts: applied.derived?.counts ?? null,
    }
  } catch (error) {
    const code = error instanceof FpError ? error.code : 'INTERNAL'
    if (!(error instanceof FpError)) logger?.warn?.(`[flowpilot] AI 工具动作 ${action} 异常：${errorText(error)}`)
    return { ok: false, action, code, error: errorText(error), summary: `失败：${errorText(error)}` }
  }
}

/** agent 工具执行体：action + 平铺参数 → engine.dispatch → {ok, result, summary, counts}。 */
/** 只读 action：不触发「写后自动同步」，避免每次查询都跑一次网络同步。 */
const READONLY_TOOL_ACTIONS = new Set(['overview', 'today', 'listProjects'])

async function executeTool(engine, aiService, logger, args, notifyWrite) {
  const action = typeof args?.action === 'string' ? args.action.trim() : ''
  if (action === '') {
    return { ok: false, code: 'INVALID_INPUT', error: '缺少 action 参数', summary: '未执行：缺少 action' }
  }
  if (AI_TOOL_ACTIONS.includes(action)) return executeAiTool(action, aiService, logger, args)
  const payload = toPayload(args ?? {})
  try {
    const out = engine.dispatch(action, payload, { actor: 'agent' })
    // 写成功后主动触发一次同步（宿主侧防抖；失败不影响工具结果）
    if (!READONLY_TOOL_ACTIONS.has(action) && typeof notifyWrite === 'function') {
      try {
        notifyWrite()
      } catch (error) {
        logger?.warn?.(`[flowpilot] 通知同步服务失败（忽略）：${errorText(error)}`)
      }
    }
    return {
      ok: true,
      action,
      revision: out.revision,
      result: toJsonValue(out.result),
      summary: summarizeResult(action, payload, out.result),
      counts: out.derived?.counts ?? null,
    }
  } catch (error) {
    const code = error instanceof FpError ? error.code : 'INTERNAL'
    if (!(error instanceof FpError)) logger?.warn?.(`[flowpilot] 工具动作 ${action} 异常：${errorText(error)}`)
    return {
      ok: false,
      action,
      code,
      error: errorText(error),
      summary: `失败：${errorText(error)}`,
    }
  }
}

/** 合并计数（{collection: n}）求和；模型工具结果里给一句可读摘要用。 */
function countMap(map) {
  if (map === null || typeof map !== 'object') return 0
  return Object.keys(map).reduce((total, key) => {
    const value = Number(map[key])
    return total + (Number.isFinite(value) ? value : 0)
  }, 0)
}

/** 同步工具平铺参数 → createSyncService().configure(patch) 的形状（不落 data.json）。 */
function toSyncPatch(args) {
  const patch = {}
  const provider = typeof args?.provider === 'string' ? args.provider.trim() : ''
  if (provider !== '') patch.provider = provider
  const github = {}
  for (const key of ['owner', 'repo', 'branch', 'path', 'apiBase']) {
    const value = typeof args?.[key] === 'string' ? args[key].trim() : ''
    if (value !== '') github[key] = value
  }
  if (Object.keys(github).length > 0) patch.github = github
  const webdav = {}
  for (const key of ['url', 'username', 'fileName']) {
    const value = typeof args?.[key] === 'string' ? args[key].trim() : ''
    if (value !== '') webdav[key] = value
  }
  if (Object.keys(webdav).length > 0) patch.webdav = webdav
  const secrets = {}
  if (typeof args?.token === 'string' && args.token.trim() !== '') secrets.githubToken = args.token.trim()
  if (typeof args?.password === 'string' && args.password.trim() !== '') secrets.webdavPassword = args.password.trim()
  if (Object.keys(secrets).length > 0) patch.secrets = secrets
  return patch
}

/**
 * 同步工具执行体（SYNC.md §4）：action ∈ status|configure|test|sync|push|pull。
 * 与 HTTP 路由共用同一 createSyncService()，返回 JSON 可序列化对象。
 */
async function executeSyncTool(action, syncService, logger, args) {
  const name = typeof action === 'string' ? action.trim() : ''
  if (name === '') {
    return { ok: false, action: name, code: 'INVALID_INPUT', error: '缺少 action 参数', summary: '未执行：缺少 action' }
  }
  if (!FP_SYNC_ACTIONS.includes(name)) {
    return { ok: false, action: name, code: 'INVALID_INPUT', error: `未知同步动作：${name}`, summary: `未执行：未知同步动作 ${name}` }
  }
  if (!syncService || typeof syncService.status !== 'function') {
    return { ok: false, action: name, code: 'INTERNAL', error: '同步服务未初始化', summary: '失败：同步服务未初始化' }
  }
  try {
    if (name === 'status') {
      const status = syncService.status()
      return {
        ok: true,
        action: name,
        status,
        summary: `同步通道：${status.providerLabel}${status.configured ? '（已配置）' : '（未配置）'}，本地 r${status.localRevision}${status.hasPendingChanges ? '，有未同步修改' : ''}`,
      }
    }
    if (name === 'configure') {
      const status = syncService.configure(toSyncPatch(args))
      return {
        ok: true,
        action: name,
        status,
        summary: `同步配置已保存：${status.providerLabel}${status.configured ? '' : '（配置不完整，补齐后才会同步）'}`,
      }
    }
    if (name === 'test') {
      const detail = await syncService.test()
      return { ok: true, action: name, detail, summary: detail?.message ?? '连接测试完成' }
    }
    if (name === 'sync') {
      const direction = args?.force === 'push' || args?.force === 'pull'
        ? args.force
        : (args?.direction === 'push' || args?.direction === 'pull' ? args.direction : undefined)
      // 与界面按钮 / 定时同步一致：默认「三方合并」（three-way merge），每次都会上传；
      // 传 mode:'newest' 才回整份最新覆盖、mode:'three-way' 回旧三路比较。
      const mode = args?.mode === 'newest' || args?.mode === 'three-way' ? args.mode : 'merge'
      const out = await syncService.run({ mode, force: direction, dryRun: args?.dryRun === true })
      const label =
        out.direction === 'merge' || out.action === 'merge'
          ? `已三方合并（新增 ${countMap(out.merged && out.merged.added)} / 更新 ${countMap(out.merged && out.merged.updated)} / 删除 ${countMap(out.merged && out.merged.deleted)}）`
          : out.direction === 'push' || out.action === 'push'
          ? '已上传本地快照'
          : out.direction === 'pull' || out.action === 'pull'
            ? `已下载远端快照并覆盖本地（r${out.revision ?? out.localRevision}）`
            : out.uploaded === true
              ? '两端一致，已上传最新快照'
              : '本地与远端一致，无需同步'
      return { ok: true, action: name, ...out, summary: label }
    }
    if (name === 'push') {
      const out = await syncService.push({ force: args?.force === true })
      return { ok: true, action: name, ...out, summary: `已上传快照 r${out.revision}` }
    }
    // pull
    const out = await syncService.pull({ force: args?.force === true })
    return {
      ok: true,
      action: name,
      ...out,
      summary: out.applied ? `已下载快照 r${out.revision}（覆盖前已备份本地数据）` : `远端 r${out.revision} 与本地一致`,
    }
  } catch (error) {
    const code = typeof error?.code === 'string' ? error.code : 'INTERNAL'
    if (!(error instanceof FpError)) logger?.warn?.(`[flowpilot] 同步工具动作 ${name} 失败：${errorText(error)}`)
    return {
      ok: false,
      action: name,
      code,
      error: errorText(error),
      ...(error?.conflict !== undefined ? { conflict: error.conflict } : {}),
      summary: `失败：${errorText(error)}`,
    }
  }
}

function registerTool(ctx, engine, aiService, syncService, logger) {
  const tools = ctx?.tools
  if (!tools || typeof tools.register !== 'function') {
    logger?.warn?.('[flowpilot] 宿主没有 tools 服务，跳过 flowpilot 工具注册')
    return
  }
  const notifyWrite = () => {
    try {
      syncService?.noteLocalWrite?.()
    } catch (error) {
      logger?.warn?.(`[flowpilot] 通知同步服务失败（忽略）：${errorText(error)}`)
    }
  }
  const tool = createFlowPilotTool({ execute: (args) => executeTool(engine, aiService, logger, args, notifyWrite) })
  try {
    tools.register(tool)
  } catch (error) {
    // 工具注册失败不拖垮插件激活：HTTP 路由仍可工作
    logger?.warn?.(`[flowpilot] 注册 flowpilot 工具失败：${errorText(error)}`)
  }
  const syncTool = createFlowPilotSyncTool({
    execute: (args) => executeSyncTool(args?.action, syncService, logger, args),
  })
  try {
    tools.register(syncTool)
  } catch (error) {
    logger?.warn?.(`[flowpilot] 注册 flowpilot_sync 工具失败：${errorText(error)}`)
  }
}

function registerRoutes(ctx, engine, aiService, syncService, updateService, logger) {
  const webServer = resolveWebServer(ctx, logger)
  if (!webServer) {
    logger?.info?.('[flowpilot] webServer 不可用，跳过 HTTP 路由注册（工具仍可正常使用）')
    return
  }
  let routes
  try {
    routes = createRoutes({ engine, aiService, syncService, updateService, logger })
  } catch (error) {
    logger?.warn?.(`[flowpilot] 创建 HTTP 路由失败：${errorText(error)}`)
    return
  }
  for (const { path, handler } of routes) {
    const label = `flowpilot: ${path}`
    const registerOnce = () => {
      const dispose = webServer.register({ kind: 'exact', path, handler })
      return () => {
        try {
          if (typeof dispose === 'function') dispose()
        } catch {
          // 释放失败不影响插件卸载
        }
      }
    }
    try {
      if (typeof ctx?.effect === 'function') {
        ctx.effect(registerOnce, label)
      } else {
        registerOnce()
      }
    } catch (error) {
      logger?.warn?.(`[flowpilot] 注册路由 ${path} 失败：${errorText(error)}`)
    }
  }
  logger?.info?.(`[flowpilot] HTTP 路由就绪：${Object.values(API_PATHS).join(' , ')}`)
}

/**
 * Cordis 插件出口。
 * @param {any} ctx cordis 上下文（只需 tools；webServer 可选）
 * @param {any} rawConfig loader 行 config：{ dataDir?, dataFile?, aiProvider?, aiModel?, aiTimeoutMs? }
 */
export function apply(ctx, rawConfig) {
  const logger = ctx?.logger ?? console
  const config = normalizeConfig(rawConfig)
  const engine = createEngine({
    dataDir: config.dataDir,
    dataFile: config.dataFile,
    logger,
  })
  const aiService = createAiService({
    ctx,
    engine,
    logger,
    config: { aiProvider: config.aiProvider, aiModel: config.aiModel, aiTimeoutMs: config.aiTimeoutMs },
  })
  // 同步服务：默认关闭（provider='off'），用户配置后才工作；创建失败不拖垮插件激活
  let syncService = null
  try {
    syncService = createSyncService({
      engine,
      store: engine.store,
      logger,
      config: { syncFile: config.syncFile },
    })
  } catch (error) {
    logger?.warn?.(`[flowpilot] 创建同步服务失败（同步功能暂不可用，其余功能不受影响）：${errorText(error)}`)
  }
  // 更新服务：检查远端 tag；profile（git）安装形态下可一键重装并重启生效；创建失败不拖垮插件激活
  let updateService = null
  try {
    updateService = createUpdateService({ logger })
  } catch (error) {
    logger?.warn?.(`[flowpilot] 创建更新服务失败（版本检查暂不可用，其余功能不受影响）：${errorText(error)}`)
  }
  registerTool(ctx, engine, aiService, syncService, logger)
  registerRoutes(ctx, engine, aiService, syncService, updateService, logger)
  // 启动后异步拉取一次（仅 behavior.autoPullOnStart 且已配置；非阻塞、失败只记 lastError）
  try {
    syncService?.start?.()
  } catch (error) {
    logger?.warn?.(`[flowpilot] 启动同步自动拉取失败（忽略）：${errorText(error)}`)
  }
  // 启动后静默检查一次新版本，之后每 6h 一次（不阻塞启动；失败只记状态）
  try {
    updateService?.start?.()
  } catch (error) {
    logger?.warn?.(`[flowpilot] 启动版本自动检查失败（忽略）：${errorText(error)}`)
  }
  logger?.info?.(`[flowpilot] 已就绪 · 数据文件=${engine.dataFile}`)
}
