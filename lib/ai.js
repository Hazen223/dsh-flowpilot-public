/**
 * FlowPilot 宿主半 · AI PRD 解析服务
 *
 * 归属：host-core
 * 用途（docs/AI-PRD-DIALOG.md §1）：
 * - `createAiService({ ctx, engine, logger, config })` → { status, parsePrd, applyProposal, ... }
 * - 把用户粘贴的 PRD 交给 DSH 的 LLM，解析成「项目 + 流程节点」提案（proposal）；
 * - 模型不可用 / 超时 / 坏 JSON 一律退回规则解析（fallbackParse），并标 meta.source='heuristic'，
 *   绝不把未捕获异常抛给调用方；只有入参 text 非法才抛 INVALID_INPUT。
 * - 提案仅「建议」，落库要等用户确认后走 applyProposal → engine action createProjectFromNodes。
 *
 * LLM 调用（本机已核实，与 dsh-plugin-magi 的 llm-bridge 一致）：
 *   ctx.llm.stream({ provider, model, system, messages:[{role:'user',content:[{type:'text',text}]}],
 *                    maxTokens, signal, purpose })
 *   正文累积 chunk.type==='text-delta' 的 chunk.text；finish.reason.kind∈error|aborted 视为失败。
 *   provider/model 来源：config.aiProvider+aiModel → ctx.get('agentDefaultModel').currentSelection()。
 *
 * 约束：只 import `node:` 内置模块与包内相对模块（desktop profile 没有 @deepseek-ai/*）。
 *       不要在 index.js 的 inject 里声明 llm / agentDefaultModel，一律运行时懒取 + try/catch。
 */

import { FpError, fail, isPlainObject, isoOf, toDate, trimText } from './util.js'
import { DELIVERY_TEMPLATE } from './templates.js'

/* ------------------------------------------------------------------ *
 * 常量
 * ------------------------------------------------------------------ */

/** 提案模板徽标取值（AI 契约 §1.3）。 */
export const PROPOSAL_TEMPLATE_IDS = Object.freeze(['delivery', 'acceptance', 'custom'])

const ASSIGNEE_ROLES = Object.freeze(['设计', '研发', '设计/产品'])
const APPROVER_ROLES = Object.freeze(['design', 'product'])
const NODE_LIMIT = 20
const TITLE_LIMIT = 120
const NODE_TITLE_LIMIT = 80
const DETAIL_LIMIT = 200
const SUMMARY_LIMIT = 200
const NOTES_LIMIT = 500
const LINE_NAME_LIMIT = 60
const MIN_TEXT_CHARS = 20
const MAX_TEXT_CHARS = 60_000
const DEFAULT_TIMEOUT_MS = 90_000
const DEFAULT_MAX_TOKENS = 4096

/** 模型可能输出英文/别名角色，统一映射到契约里的中文枚举。 */
const ASSIGNEE_ALIASES = Object.freeze({
  设计: '设计',
  design: '设计',
  设计师: '设计',
  研发: '研发',
  开发: '研发',
  dev: '研发',
  developer: '研发',
  rd: '研发',
  'r&d': '研发',
  产品: '设计/产品',
  product: '设计/产品',
  '设计/产品': '设计/产品',
  '设计&产品': '设计/产品',
  '设计+产品': '设计/产品',
  '设计 产品': '设计/产品',
  '设计 / 产品': '设计/产品',
})

const APPROVER_ALIASES = Object.freeze({
  design: 'design',
  设计: 'design',
  product: 'product',
  产品: 'product',
})

/* ------------------------------------------------------------------ *
 * 小工具
 * ------------------------------------------------------------------ */

function errorMessage(error) {
  if (error instanceof Error) return error.message || String(error)
  return String(error)
}

/**
 * AI 专用错误：util.js 的 FpError 只认识契约 §4 的基础错误码，AI_* 会被归一成 INTERNAL。
 * 这里先构造 FpError（保留 instanceof，HTTP 层据此取 code 映射状态码），再显式覆盖 code，
 * 让调用方/日志能拿到 AI_NO_MODEL / AI_CALL_FAILED / AI_BAD_OUTPUT。
 */
function aiError(code, message) {
  const error = new FpError('INTERNAL', message)
  error.code = code
  return error
}

function aiFail(code, message) {
  throw aiError(code, message)
}

/** 文本清洗：去首尾空白、压缩连续空白；max>0 时截断。 */
function cleanText(value, max = 0) {
  if (value === undefined || value === null) return ''
  const text = trimText(String(value)).replace(/\s+/g, ' ').trim()
  return max > 0 ? text.slice(0, max) : text
}

function asArray(value) {
  if (Array.isArray(value)) return value
  if (value === undefined || value === null || value === '') return []
  return [value]
}

/** 任意时间值 → 可解析 ISO 或 null（模型输出不可信，不抛错）。 */
function normalizeIso(value) {
  const date = toDate(value)
  return date ? isoOf(date) : null
}

/* ------------------------------------------------------------------ *
 * Prompt 拼装（中文；system 里写清 FlowPilot 场景 + 只输出 JSON）
 * ------------------------------------------------------------------ */

export const AI_SYSTEM_PROMPT = [
  '你是 FlowPilot 项目管理工具的 PRD 解析助手。FlowPilot 按「流程节点」管理项目：',
  '- 项目包含若干流程：设计交付流程固定为 D01-D07（需求接收 / 交付评估 / 设计稿 搭建交互框架 / 交互确认（设计 & 产品）/ Figma 细化设计 / 最终设计确认（设计 & 产品）/ 研发交付）；验收流程为 A01-A05（验收计划 / 研发提交 / 创建验收文件 / 设计调整 / 研发同步）。',
  '- 节点负责角色 assigneeRole 只能是「设计」「研发」「设计/产品」；',
  '- 「设计/产品」节点可以设置双角色确认 approvalRoles（["design"] / ["product"] / ["design","product"]），只有需要设计与产品共同确认的节点才设置，其余节点必须是 []；',
  '- 返工语义：双角色确认节点任一方退回会回到上一个节点（如 D04→D03、D06→D05），所以这类节点通常紧跟被退回的目标节点。',
  '任务：阅读用户粘贴的 PRD，把需求拆成 3-12 个按顺序可直接执行的流程节点，输出一个项目提案 JSON。',
  '硬性要求：',
  '1. 只输出一个 JSON 对象：不要 markdown 代码围栏，不要解释、注释或任何前后缀文字；',
  '2. 除 approvalRoles 用英文枚举值外，其余文字一律用中文；',
  '3. nodes 为 1-20 个，按执行顺序排列；标题简短（≤20 字），detail 一句话说明做什么（≤80 字）；',
  '4. approvalRoles 只能出现在 assigneeRole 为「设计/产品」的节点上；',
  '5. dueAt 只在 PRD 明确给出截止日期时填写，格式 ISO 8601（如 "2026-11-20T10:00:00.000Z"），否则为 null；',
  '6. templateId 只能是 delivery / acceptance / custom：标准设计交付流程填 delivery，验收流程填 acceptance，其他填 custom；',
  '7. businessLineName：PRD 里提到的业务线/产品线名称，没有就填 null；',
  '8. 不要编造 PRD 里没有的事实；拿不准的风险写进 notes。',
  '输出 JSON 形状（字段名不能改）：',
  '{"title":"项目标题","businessLineName":"业务线名或 null","dueAt":"ISO 或 null","templateId":"delivery|acceptance|custom",',
  '"summary":"一句话说明这条 PRD 要做什么","nodes":[{"title":"节点标题","detail":"节点说明","assigneeRole":"设计|研发|设计/产品","approvalRoles":[]}],"notes":"解析依据 / 风险提示"}',
].join('\n')

/** 拼用户消息：PRD 正文 + 可选业务线提示 / 补充要求。 */
export function buildUserPrompt({ text, businessLineHint = '', extraInstructions = '' } = {}) {
  const lines = ['【PRD 文本】', cleanText(text) === '' ? '(空)' : trimText(text), '']
  const hint = cleanText(businessLineHint, LINE_NAME_LIMIT)
  const extra = cleanText(extraInstructions, 500)
  if (hint !== '') lines.push(`【业务线提示】${hint}`)
  if (extra !== '') lines.push(`【补充要求】${extra}`)
  lines.push('请解析上面的 PRD，只输出提案 JSON。')
  return lines.join('\n')
}

/** 完整 prompt（system + user），便于自测与排查。 */
export function buildPrompt(input = {}) {
  return { system: AI_SYSTEM_PROMPT, user: buildUserPrompt(input) }
}

/* ------------------------------------------------------------------ *
 * 输出解析 / 归一化（模型输出不可信，全部走这里）
 * ------------------------------------------------------------------ */

/**
 * 从模型正文里抠出第一个平衡的 JSON 对象。
 * 容忍 ```json 围栏、前后解释文字；拿不到返回 null。
 */
export function extractJsonText(raw) {
  const text = typeof raw === 'string' ? raw : ''
  const source = text.replace(/```(?:json)?/gi, '')
  const trimmed = source.trim()
  if (trimmed === '') return null
  // 1) 纯 JSON 最快路径
  try {
    JSON.parse(trimmed)
    return trimmed
  } catch {
    // 继续按括号配对找
  }
  const start = source.indexOf('{')
  if (start < 0) return null
  let depth = 0
  let inString = false
  let escaped = false
  for (let index = start; index < source.length; index += 1) {
    const char = source[index]
    if (inString) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') inString = true
    else if (char === '{') depth += 1
    else if (char === '}') {
      depth -= 1
      if (depth === 0) return source.slice(start, index + 1)
    }
  }
  // 没配平（可能被 maxTokens 截断）：把剩下的交给 JSON.parse 报明确错误
  return source.slice(start)
}

/** 解析模型正文 → 对象；失败抛 AI_BAD_OUTPUT（带正文前 500 字方便排查）。 */
export function parseModelJson(raw) {
  const text = typeof raw === 'string' ? raw : ''
  if (text.trim() === '') aiFail('AI_BAD_OUTPUT', '模型没有返回内容')
  const jsonText = extractJsonText(text)
  if (jsonText === null) aiFail('AI_BAD_OUTPUT', `模型输出里没有 JSON 对象：${text.slice(0, 500)}`)
  try {
    const parsed = JSON.parse(jsonText)
    if (!isPlainObject(parsed)) aiFail('AI_BAD_OUTPUT', `模型输出的 JSON 不是对象：${text.slice(0, 500)}`)
    return parsed
  } catch (error) {
    if (error instanceof FpError) throw error
    aiFail('AI_BAD_OUTPUT', `模型输出不是合法 JSON（${errorMessage(error)}）：${text.slice(0, 500)}`)
  }
}

function normalizeAssigneeRole(raw) {
  const text = cleanText(raw)
  if (text === '') return null
  const alias = ASSIGNEE_ALIASES[text.toLowerCase()] ?? ASSIGNEE_ALIASES[text]
  if (alias) return alias
  return ASSIGNEE_ROLES.includes(text) ? text : null
}

function normalizeApprovalRoles(raw) {
  const out = []
  for (const item of asArray(raw)) {
    const text = cleanText(item)
    if (text === '') continue
    const role = APPROVER_ALIASES[text.toLowerCase()] ?? APPROVER_ALIASES[text]
    if (!role) continue
    if (!out.includes(role)) out.push(role)
  }
  // 输出顺序固定（design → product），便于客户端/测试稳定
  out.sort((a, b) => APPROVER_ROLES.indexOf(a) - APPROVER_ROLES.indexOf(b))
  return out
}

function normalizeTemplateId(raw) {
  const text = cleanText(raw).toLowerCase()
  return PROPOSAL_TEMPLATE_IDS.includes(text) ? text : 'custom'
}

/** 节点列表归一化：title 必填、detail ≤200、角色白名单、approvalRoles 白名单、去重、≤20。 */
export function normalizeProposalNodes(rawNodes) {
  if (!Array.isArray(rawNodes)) return []
  const nodes = []
  const seen = new Set()
  for (const raw of rawNodes) {
    if (nodes.length >= NODE_LIMIT) break
    let item = null
    if (isPlainObject(raw)) item = raw
    else if (typeof raw === 'string') item = { title: raw }
    if (!item) continue
    const title = cleanText(item.title ?? item.name ?? item.node, NODE_TITLE_LIMIT)
    if (title === '') continue
    // 去重：同名节点（忽略空白与大小写）只保留第一个
    const key = title.replace(/\s+/g, '').toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    const detail = cleanText(item.detail ?? item.description ?? item.note, DETAIL_LIMIT)
    const explicitRole = normalizeAssigneeRole(item.assigneeRole ?? item.role ?? item.assignee)
    const approvalRoles = normalizeApprovalRoles(item.approvalRoles ?? item.approvers)
    let assigneeRole = explicitRole
    if (assigneeRole === null) {
      // 角色缺失：有双角色确认就按「设计/产品」，否则默认「设计」
      assigneeRole = approvalRoles.length > 0 ? '设计/产品' : '设计'
    } else if (assigneeRole !== '设计/产品') {
      // 契约：approvalRoles 只有「设计/产品」节点才允许；其他角色一律清空
      approvalRoles.length = 0
    }
    nodes.push({ title, detail, assigneeRole, approvalRoles })
  }
  return nodes
}

/**
 * 提案归一化（AI 契约 §1.3）：字段名固定，缺字段补默认值，坏值一律降级而不是抛错。
 * 兼容模型把 proposal 包一层 { proposal: {...} } 或写近似字段名。
 */
export function normalizeProposal(raw, { fallbackTitle = '' } = {}) {
  const wrapper = isPlainObject(raw) ? raw : {}
  const source = isPlainObject(wrapper.proposal) && !Array.isArray(wrapper.nodes)
    ? wrapper.proposal
    : wrapper
  const record = isPlainObject(source) ? source : {}
  let title = cleanText(record.title ?? record.name ?? record.projectTitle, TITLE_LIMIT)
  if (title === '') title = cleanText(fallbackTitle, TITLE_LIMIT)
  if (title === '') title = '未命名 PRD 项目'
  const businessLineName = cleanText(
    record.businessLineName ?? record.businessLine ?? record.lineName,
    LINE_NAME_LIMIT,
  ) || null
  return {
    title,
    businessLineName,
    dueAt: normalizeIso(record.dueAt ?? record.dueDate ?? record.deadline),
    templateId: normalizeTemplateId(record.templateId ?? record.template),
    summary: cleanText(record.summary ?? record.description, SUMMARY_LIMIT),
    nodes: normalizeProposalNodes(record.nodes ?? record.nodeList ?? record.steps),
    notes: cleanText(record.notes ?? record.note, NOTES_LIMIT),
  }
}

/* ------------------------------------------------------------------ *
 * 规则兜底解析（LLM 不可用 / 超时 / 坏 JSON 时使用）
 * ------------------------------------------------------------------ */

/** 从 PRD 里取标题：一级/二级标题优先，否则第一行非空文本。 */
function extractTitle(text) {
  const lines = String(text ?? '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
  for (const line of lines) {
    const match = /^#{1,2}\s+(.+)$/.exec(line)
    if (match) return cleanText(match[1].replace(/[*_`]/g, ''), TITLE_LIMIT)
  }
  const first = lines[0] ?? ''
  return cleanText(first.replace(/^#+\s*/, '').replace(/[*_`]/g, ''), TITLE_LIMIT)
}

const TABLE_HEADER_PATTERN = /^(节点|阶段|步骤|流程|环节|里程碑|node|stage|step)s?$/i
const TABLE_SEPARATOR_PATTERN = /^\|?\s*:?-{2,}/

/** 按标题推断负责角色（只用于规则兜底，不追求准确）。 */
function inferAssigneeRole(title) {
  if (/研发|开发|联调|提测|代码|发布|上线/.test(title)) return '研发'
  if (/确认|评审|审核|验收/.test(title)) return '设计/产品'
  return '设计'
}

/** 表格首列是「节点/阶段」时，按行提取节点（AI 契约 §1.2 的规则兜底）。 */
function extractTableNodes(text) {
  const lines = String(text ?? '').split(/\r?\n/)
  const nodes = []
  let inTable = false
  for (const line of lines) {
    const cells = line.trim().startsWith('|')
      ? line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((cell) => cleanText(cell))
      : null
    if (!cells) {
      // 表格结束后继续找下一张表（PRD 里可能有多个表格）
      inTable = false
      continue
    }
    if (!inTable) {
      if (TABLE_HEADER_PATTERN.test(cells[0] ?? '')) inTable = true
      continue
    }
    if (cells.every((cell) => cell === '' || TABLE_SEPARATOR_PATTERN.test(`|${cell}`))) continue
    const title = cleanText(cells[0]?.replace(/[*_`]/g, ''), NODE_TITLE_LIMIT)
    if (title === '') continue
    const detail = cleanText((cells[1] ?? '').replace(/[*_`]/g, ''), DETAIL_LIMIT)
    const role = inferAssigneeRole(title)
    const approvalRoles = role === '设计/产品' ? ['design', 'product'] : []
    nodes.push({ title, detail, assigneeRole: role, approvalRoles })
    if (nodes.length >= NODE_LIMIT) break
  }
  return nodes
}

/** 默认 delivery 模板 7 节点（规则兜底用）。 */
function defaultDeliveryNodes() {
  return DELIVERY_TEMPLATE.nodes.map((spec) => ({
    title: spec.title,
    detail: spec.detail ?? '',
    assigneeRole: spec.assigneeRole ?? '设计',
    approvalRoles: Array.isArray(spec.approvalRoles) ? [...spec.approvalRoles] : [],
  }))
}

/**
 * 规则解析：标题（# 一级标题 / 第一行）+ 表格节点（「节点/阶段」首列）或默认 delivery 7 节点。
 * meta.source='heuristic' 由调用方标注。
 */
export function fallbackParse(input = {}) {
  const text = typeof input?.text === 'string' ? input.text : ''
  const businessLineHint = cleanText(input?.businessLineHint, LINE_NAME_LIMIT)
  const tableNodes = extractTableNodes(text)
  const title = extractTitle(text) || businessLineHint || '未命名 PRD 项目'
  return {
    title: cleanText(title, TITLE_LIMIT),
    businessLineName: businessLineHint === '' ? null : businessLineHint,
    dueAt: null,
    templateId: tableNodes.length > 0 ? 'custom' : 'delivery',
    summary: `按结构提取：${cleanText(title, 60)}`,
    nodes: (tableNodes.length > 0 ? tableNodes : defaultDeliveryNodes()).slice(0, NODE_LIMIT),
    notes: '规则解析：未使用模型，仅按 PRD 标题与结构（表格 / 默认模板）提取节点，请人工核对后再生成项目。',
  }
}

/* ------------------------------------------------------------------ *
 * 服务
 * ------------------------------------------------------------------ */

/** 空 usage（契约 meta.usage 固定形状）。 */
function emptyUsage() {
  return { inputTokens: 0, outputTokens: 0 }
}

/**
 * 创建 AI 服务（UI 路由与 agent 工具共用同一份实现，AI 契约 §1）。
 *
 * @param {{ ctx?: any, engine: any, logger?: any, config?: any }} options
 *   config: { aiProvider?, aiModel?, aiTimeoutMs?, aiMaxTokens? }
 */
export function createAiService({ ctx, engine, logger, config } = {}) {
  if (!engine || typeof engine.dispatch !== 'function') {
    throw new Error('createAiService 需要 engine（createEngine 的返回值）')
  }
  const aiConfig = config && typeof config === 'object' ? config : {}

  /**
   * 懒取 cordis 服务：llm / agentDefaultModel 不在 inject 里，
   * 未注入时直接读属性会抛，所以 try/catch + ctx.get；测试里也允许普通对象属性。
   */
  function resolveService(name) {
    if (!ctx || typeof ctx !== 'object') return null
    if (typeof ctx.get === 'function') {
      try {
        const viaGet = ctx.get(name)
        if (viaGet) return viaGet
      } catch {
        // 未 inject：忽略，继续尝试普通属性
      }
    }
    try {
      const direct = ctx[name]
      if (direct) return direct
    } catch {
      // 未 inject：忽略
    }
    return null
  }

  /** provider/model 解析：config 覆盖 → agentDefaultModel.currentSelection() → 无。 */
  function resolveRoute() {
    const configProvider = trimText(aiConfig.aiProvider)
    const configModel = trimText(aiConfig.aiModel)
    if (configProvider !== '' && configModel !== '') {
      return { provider: configProvider, model: configModel, modelSource: 'config' }
    }
    const defaultModel = resolveService('agentDefaultModel')
    if (defaultModel && typeof defaultModel.currentSelection === 'function') {
      try {
        const selection = defaultModel.currentSelection()
        const provider = trimText(selection?.provider)
        const model = trimText(selection?.model)
        if (provider !== '' && model !== '') {
          return { provider, model, modelSource: 'session-default' }
        }
      } catch (error) {
        logger?.warn?.(`[flowpilot] 读取默认模型失败：${errorMessage(error)}`)
      }
    }
    return { provider: null, model: null, modelSource: 'none' }
  }

  function resolveTimeoutMs() {
    const raw = Number(aiConfig.aiTimeoutMs)
    return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_TIMEOUT_MS
  }

  function resolveMaxTokens() {
    const raw = Number(aiConfig.aiMaxTokens)
    return Number.isFinite(raw) && raw > 0 ? Math.round(raw) : DEFAULT_MAX_TOKENS
  }

  /** AI 可用性（客户端顶部提示 / 规则解析入口）。 */
  function status() {
    const llm = resolveService('llm')
    const route = resolveRoute()
    const llmReady = Boolean(llm && typeof llm.stream === 'function')
    const available = Boolean(llmReady && route.provider && route.model)
    let reason = null
    if (!llmReady) reason = '宿主未提供 LLM 服务（ctx.get("llm") 为空），可改用规则解析'
    else if (route.provider === null || route.model === null) {
      reason = '未找到可用模型：请先在 DSH 设置里选择默认模型，或给插件配置 aiProvider / aiModel'
    }
    return {
      available,
      provider: route.provider,
      model: route.model,
      reason,
      modelSource: route.modelSource,
    }
  }

  /**
   * 调一次模型流，返回 { text, usage }；失败抛 FpError（AI_CALL_FAILED / AI_BAD_OUTPUT）。
   * 超时默认 90s（AbortController + 定时器）；caller signal 也会合并进来。
   */
  async function callModel({ llm, route, prdText, businessLineHint, extraInstructions, signal }) {
    const controller = new AbortController()
    let timedOut = false
    let callerAborted = false
    const timer = setTimeout(() => {
      timedOut = true
      try { controller.abort() } catch { /* 忽略 */ }
    }, resolveTimeoutMs())
    const onCallerAbort = () => {
      callerAborted = true
      try { controller.abort() } catch { /* 忽略 */ }
    }
    if (signal) {
      if (signal.aborted) {
        clearTimeout(timer)
        throw aiError('AI_CALL_FAILED', 'AI 调用已取消')
      }
      try { signal.addEventListener?.('abort', onCallerAbort, { once: true }) } catch { /* 忽略 */ }
    }
    let textOut = ''
    let blockFallback = ''
    const usage = emptyUsage()
    try {
      const stream = llm.stream({
        provider: route.provider,
        model: route.model,
        system: AI_SYSTEM_PROMPT,
        messages: [{ role: 'user', content: [{ type: 'text', text: buildUserPrompt({ text: prdText, businessLineHint, extraInstructions }) }] }],
        maxTokens: resolveMaxTokens(),
        signal: controller.signal,
        purpose: 'flowpilot-prd-parse',
      })
      if (!stream || typeof stream[Symbol.asyncIterator] !== 'function') {
        throw aiError('AI_CALL_FAILED', 'LLM 服务未返回 AsyncIterable（ctx.llm.stream 不可用）')
      }
      for await (const chunk of stream) {
        const type = chunk?.type
        if (type === 'text-delta' && typeof chunk.text === 'string') {
          textOut += chunk.text
        } else if (type === 'block-end' && chunk?.block?.type === 'text'
          && typeof chunk.block.text === 'string') {
          // 兜底：只给完整块、不给增量的适配器
          blockFallback += chunk.block.text
        } else if (type === 'finish') {
          const kind = chunk?.reason?.kind
          if (kind === 'error' || kind === 'aborted') {
            const failure = chunk?.reason?.failure
            const message = typeof failure === 'string' ? failure : failure?.message
            throw aiError('AI_CALL_FAILED', `模型调用失败：${message || kind}`)
          }
          if (kind === 'max-tokens') {
            throw aiError('AI_BAD_OUTPUT', '模型输出达到长度上限（maxTokens），JSON 可能被截断')
          }
        }
        const chunkUsage = chunk?.usage
        if (isPlainObject(chunkUsage)) {
          if (typeof chunkUsage.inputTokens === 'number') usage.inputTokens += chunkUsage.inputTokens
          if (typeof chunkUsage.outputTokens === 'number') usage.outputTokens += chunkUsage.outputTokens
        }
      }
      if (timedOut) {
        throw aiError('AI_CALL_FAILED', `AI 调用超时（${Math.round(resolveTimeoutMs() / 1000)} 秒）`)
      }
      const text = textOut.trim() === '' ? blockFallback : textOut
      if (text.trim() === '') throw aiError('AI_CALL_FAILED', '模型返回空内容')
      return { text, usage }
    } catch (error) {
      if (timedOut) {
        throw aiError('AI_CALL_FAILED', `AI 调用超时（${Math.round(resolveTimeoutMs() / 1000)} 秒）`)
      }
      if (callerAborted) throw aiError('AI_CALL_FAILED', 'AI 调用已取消')
      if (error instanceof FpError) throw error
      throw aiError('AI_CALL_FAILED', `AI 调用失败：${errorMessage(error)}`)
    } finally {
      clearTimeout(timer)
      try { signal?.removeEventListener?.('abort', onCallerAbort) } catch { /* 忽略 */ }
    }
  }

  /** 规则兜底结果（meta.source='heuristic'，附原因）。 */
  function heuristicResult({ prdText, businessLineHint, extraInstructions, truncated, warning, startedAt }) {
    const proposal = fallbackParse({ text: prdText, businessLineHint, extraInstructions })
    const warnings = []
    if (warning) warnings.push(warning)
    warnings.push('未使用模型，仅按结构提取（规则解析）')
    if (truncated) warnings.push('PRD 文本超过 60000 字，已截断后解析')
    return {
      ok: true,
      proposal,
      meta: {
        source: 'heuristic',
        provider: null,
        model: null,
        ms: Date.now() - startedAt,
        truncated,
        warnings,
        usage: emptyUsage(),
      },
    }
  }

  /**
   * 解析 PRD → proposal（AI 契约 §1.2）。
   * 只有 text 非法才抛 INVALID_INPUT；模型/网络/JSON 问题一律走启发式兜底。
   */
  async function parsePrd(input = {}) {
    const startedAt = Date.now()
    const rawText = typeof input?.text === 'string' ? input.text : ''
    const text = trimText(rawText)
    if (text.length < MIN_TEXT_CHARS) {
      fail('INVALID_INPUT', `PRD 文本太短（至少 ${MIN_TEXT_CHARS} 字），请粘贴完整需求`)
    }
    const truncated = text.length > MAX_TEXT_CHARS
    const prdText = truncated ? text.slice(0, MAX_TEXT_CHARS) : text
    const businessLineHint = trimText(input?.businessLineHint)
    const extraInstructions = trimText(input?.extraInstructions)

    const llm = resolveService('llm')
    const route = resolveRoute()
    if (!llm || typeof llm.stream !== 'function' || route.provider === null || route.model === null) {
      const reason = !llm || typeof llm.stream !== 'function'
        ? '宿主未提供 LLM 服务（AI_NO_MODEL）'
        : '未找到可用模型（AI_NO_MODEL）'
      return heuristicResult({
        prdText, businessLineHint, extraInstructions, truncated,
        warning: `${reason}，已改用规则解析`, startedAt,
      })
    }

    let modelText = ''
    let usage = emptyUsage()
    try {
      const outcome = await callModel({
        llm,
        route,
        prdText,
        businessLineHint,
        extraInstructions,
        signal: input?.signal,
      })
      modelText = outcome.text
      usage = outcome.usage
    } catch (error) {
      logger?.warn?.(`[flowpilot] AI 解析失败，退回规则解析：${errorMessage(error)}`)
      return heuristicResult({
        prdText, businessLineHint, extraInstructions, truncated,
        warning: `${errorMessage(error)}，已改用规则解析`, startedAt,
      })
    }

    let parsed = null
    try {
      parsed = parseModelJson(modelText)
    } catch (error) {
      logger?.warn?.(`[flowpilot] AI 输出不可用，退回规则解析：${errorMessage(error)}`)
      return heuristicResult({
        prdText, businessLineHint, extraInstructions, truncated,
        warning: '模型输出不是合法 JSON（AI_BAD_OUTPUT），已改用规则解析', startedAt,
      })
    }

    const fallbackTitle = extractTitle(prdText)
    const proposal = normalizeProposal(parsed, { fallbackTitle })
    if (proposal.nodes.length === 0) {
      return heuristicResult({
        prdText, businessLineHint, extraInstructions, truncated,
        warning: '模型输出没有可用节点，已改用规则解析', startedAt,
      })
    }

    const warnings = []
    if (truncated) warnings.push('PRD 文本超过 60000 字，已截断后解析')
    if (proposal.templateId === 'custom' && parsed?.templateId !== undefined) {
      // 模型给了不认识/小写的 templateId：归一化已兜底，这里只提示
      const rawTemplate = cleanText(parsed?.templateId).toLowerCase()
      if (!PROPOSAL_TEMPLATE_IDS.includes(rawTemplate)) warnings.push(`模型给出的 templateId「${cleanText(parsed?.templateId, 30)}」不可用，已按 custom 处理`)
    }
    return {
      ok: true,
      proposal,
      meta: {
        source: 'llm',
        provider: route.provider,
        model: route.model,
        ms: Date.now() - startedAt,
        truncated,
        warnings,
        usage,
      },
    }
  }

  /**
   * 用户确认后落库（AI 契约 §1.4）：校验 proposal → engine action createProjectFromNodes。
   * businessLineId 为空时用 proposal.businessLineName（按名字复用/新建）。
   */
  async function applyProposal(input = {}) {
    const proposal = normalizeProposal(input?.proposal)
    if (proposal.nodes.length === 0) {
      fail('INVALID_INPUT', '提案至少需要 1 个节点，请先解析 PRD 并确认节点')
    }
    const businessLineId = trimText(input?.businessLineId)
    const payload = {
      title: proposal.title,
      dueAt: proposal.dueAt,
      nodes: proposal.nodes,
    }
    if (businessLineId !== '') payload.businessLineId = businessLineId
    else if (proposal.businessLineName) payload.businessLineName = proposal.businessLineName
    else fail('INVALID_INPUT', '请选择已有业务线，或填写新的业务线名称')

    const out = engine.dispatch('createProjectFromNodes', payload)
    const result = out?.result ?? {}
    const nodeCount = Number.isFinite(result.nodeCount)
      ? result.nodeCount
      : (Array.isArray(result.nodeIds) ? result.nodeIds.length : proposal.nodes.length)
    return {
      ok: true,
      projectId: result.projectId ?? null,
      lineId: result.lineId ?? null,
      flowId: result.flowId ?? null,
      nodeCount,
      revision: out.revision,
      state: out.state,
      derived: out.derived,
      result,
    }
  }

  return {
    status,
    parsePrd,
    applyProposal,
    fallbackParse,
    normalizeProposal,
    buildPrompt,
    /** 内部用（自测/排查）：当前解析出的路由。 */
    resolveRoute,
  }
}
