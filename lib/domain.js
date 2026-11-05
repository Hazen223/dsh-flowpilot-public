/**
 * FlowPilot 宿主半 · 领域规则
 *
 * 归属：host-core
 * 用途：
 * - 状态机（解锁 / 完成门槛 / 双角色确认 / 退回 / 跨流程 handoff / 跳过 / 重新打开）；
 * - 派生视图 derived（严格按契约 §3 形状，client 直接渲染）；
 * - 周报生成（PRD §7.3：业务线 → 项目 → 完成 / 修改 / 推进中 / 待跟进 / 补充记录）；
 * - 工作节奏 focus（PRD §6，含静默窗与 dismiss）；
 * - 示例数据 seedDemo（周五补生成草稿逻辑也在读 state 时自动补齐）。
 * 约束：只 import node: 内置模块与包内相对模块；所有变更写 events。
 */

import { existsSync, mkdirSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import {
  addDays, addMinutes, clamp, clone, dateKey, daysLeft, daysOfWeek, fail, formatDateTime,
  formatDay, formatRange, firstDefined, isoOf, isoWeekday, lastWorkdayOfWeek, minutesSinceMidnight,
  optionalBoolean, optionalIso, optionalNumber, parseDateKey, parseHHMM,
  requireStringArray, requireText, startOfDay, startOfWeek, timeOnDay, toDate, trimText, uid,
} from './util.js'
import {
  ACCEPTANCE_TEMPLATE, DELIVERY_TEMPLATE, HANDOFF_LINKS, TEMPLATE_IDS, getTemplate, templateNode,
} from './templates.js'
import { FORMAT_VERSION, createEmptyState, createStore, defaultSettings } from './store.js'

/* ------------------------------------------------------------------ *
 * 常量
 * ------------------------------------------------------------------ */

/** 只读动作（agent tool 专用；不写 events、不 +revision）。 */
export const READONLY_ACTIONS = Object.freeze(['overview', 'today', 'listProjects'])

/** 全部合法 action（client 与 agent tool 共用）。 */
export const ACTION_NAMES = Object.freeze([
  // 业务线
  'createLine', 'renameLine', 'deleteLine', 'reorderLine',
  // 项目 / 流程
  'createProject', 'updateProject', 'archiveProject', 'deleteProject', 'addFlow', 'appendTemplate',
  // AI 提案 → 项目（AI-PRD-DIALOG §2；只用于新建，不允许改已有项目）
  'createProjectFromNodes',
  // 节点
  'startNode', 'completeNode', 'waitNode', 'blockNode', 'skipNode', 'reopenNode',
  'rejectApproval', 'approve', 'setNodeSchedule', 'setNodeNotes', 'addNote',
  'addNode', 'removeNode', 'reorderNode',
  // 链接
  'addLink', 'removeLink',
  // 交接 / 周报 / 设置 / 维护
  'saveHandoff', 'generateReport', 'updateReport', 'dismissRhythm', 'updateSettings',
  'seedDemo', 'resetData',
  // 只读
  ...READONLY_ACTIONS,
])

/** 状态中文（事件文案用）。 */
export const STATUS_LABEL = Object.freeze({
  locked: '未解锁', ready: '待开始', active: '进行中', waiting: '待确认',
  blocked: '已阻塞', revision: '待修改', completed: '已完成', skipped: '已跳过',
})

const ROLE_LABEL = Object.freeze({ design: '设计', product: '产品' })
const LINK_KIND_LABEL = Object.freeze({
  design: '设计稿',
  figma: 'Figma',
  doc: '需求文档',
  chat: 'AI 讨论',
  meeting: '会议纪要',
  dev: '开发实现',
  test: '测试验收',
  ref: '参考资料',
  other: '其他',
})
const APPROVER_ROLES = Object.freeze(['design', 'product'])
const ASSIGNEE_ROLES = Object.freeze(['设计', '研发', '设计/产品'])
/** 链接类型（证据链接按它过滤；客户端 addLink 的可选值与之保持一致）。 */
export const LINK_KINDS = Object.freeze(['design', 'figma', 'doc', 'chat', 'meeting', 'dev', 'test', 'ref', 'other'])
const ACTIONABLE_STATUS = new Set(['ready', 'active', 'revision'])
const FOLLOW_STATUS = new Set(['waiting', 'blocked'])
const PRIORITY_SCORE = Object.freeze({ overdue: 0, dueSoon: 1, active: 2, revision: 3, ready: 4 })
const MODE_LABEL = Object.freeze({ concise: '简洁', detailed: '详细' })

/* -------------------- 节点模型 v2：证据 / 解锁 / 等待细分 -------------------- */

/** 完成证据策略默认值：至少要一条任意类型的证据链接（替代写死的 设计稿 门槛）。 */
export const DEFAULT_EVIDENCE_POLICY = Object.freeze({ kinds: Object.freeze([]), minLinks: 1 })
/** evidencePolicy.minLinks 上限（防止误配成离谱的硬门槛）。 */
export const EVIDENCE_MIN_LINKS_MAX = 10
/** 解锁策略：linear = 完成后只解锁下一个节点（默认，兼容旧行为）；parallel = 一次解锁同流程全部。 */
export const UNLOCK_POLICIES = Object.freeze(['linear', 'parallel'])
export const DEFAULT_UNLOCK_POLICY = 'linear'
/** 等待细分：approval = 等待双角色确认；external = 等外部依赖；queued 保留常量（当前不产生）。 */
export const WAITING_KINDS = Object.freeze(['approval', 'external', 'queued'])

/* ------------------------------------------------------------------ *
 * 节点包模板（appendTemplate）：只能追加到已有流程，不能用来新建流程
 * ------------------------------------------------------------------ */

/**
 * 实验推进：预跑观测 → 5% 白名单 → 50% 灰度 → 推全。
 * 每个阶段一个节点，`plannedOffsetDays` 是相对追加起点（startAt）的天数偏移。
 */
export const EXPERIMENT_TEMPLATE = Object.freeze({
  id: 'experiment',
  version: 1,
  title: '实验推进',
  short: '实验',
  nodes: Object.freeze([
    Object.freeze({
      code: 'E01', title: '预跑观测', detail: '小流量预跑，观察 7 天核心指标与异常',
      assigneeRole: '研发', plannedOffsetDays: 0,
    }),
    Object.freeze({
      code: 'E02', title: '5% 白名单', detail: '5% 白名单放量，核对实验组/对照组指标',
      assigneeRole: '研发', plannedOffsetDays: 7,
    }),
    Object.freeze({
      code: 'E03', title: '50% 灰度', detail: '50% 灰度放量，观察异常与核心指标波动',
      assigneeRole: '研发', plannedOffsetDays: 14,
    }),
    Object.freeze({
      code: 'E04', title: '推全', detail: '全量推全，确认指标稳定并归档实验结论',
      assigneeRole: '研发', plannedOffsetDays: 21,
    }),
  ]),
})

/** 可追加的节点包模板集合（与「流程模板」区分）。 */
export const NODE_PACK_TEMPLATES = Object.freeze({ experiment: EXPERIMENT_TEMPLATE })
export const NODE_PACK_TEMPLATE_IDS = Object.freeze(Object.keys(NODE_PACK_TEMPLATES))

/** 全部模板（流程模板 delivery/acceptance + 节点包模板 experiment），供客户端/工具读 meta。 */
export const FP_TEMPLATES = Object.freeze({
  delivery: DELIVERY_TEMPLATE,
  acceptance: ACCEPTANCE_TEMPLATE,
  experiment: EXPERIMENT_TEMPLATE,
})

/**
 * 只读模板列表：每次返回全新对象，调用方可随意改；`kind` 区分用途
 * （flow = 可建流程；node-pack = 只能用 appendTemplate 追加到已有流程）。
 */
export function listTemplates() {
  return [DELIVERY_TEMPLATE, ACCEPTANCE_TEMPLATE, EXPERIMENT_TEMPLATE].map((template) => ({
    id: template.id,
    version: template.version ?? 1,
    title: template.title,
    short: template.short ?? '',
    kind: NODE_PACK_TEMPLATES[template.id] ? 'node-pack' : 'flow',
    nodeCount: template.nodes.length,
    nodes: template.nodes.map((node) => ({ ...node })),
  }))
}

/* ------------------------------------------------------------------ *
 * 契约 §4.2 相关常量
 * ------------------------------------------------------------------ */

/** 删除项目前的自动备份（契约 §4.2 A）：文件名前缀 / 保留份数。 */
const PRE_DELETE_BACKUP_PREFIX = 'pre-delete-'
const PRE_DELETE_BACKUP_KEEP = 10
// 同一进程内连续删除时也保证备份文件名严格递增（按文件名排序 == 时间顺序）
let lastPreDeleteStampMs = 0

/* ------------------------------------------------------------------ *
 * 查询小工具
 * ------------------------------------------------------------------ */

function findLine(state, lineId) {
  return state.businessLines.find((line) => line.id === lineId) ?? null
}
function lineById(state, lineId) {
  const line = findLine(state, lineId)
  if (!line) fail('NOT_FOUND', `业务线不存在：${lineId ?? '(空)'}`)
  return line
}
function findProject(state, projectId) {
  return state.projects.find((project) => project.id === projectId) ?? null
}
function projectById(state, projectId) {
  const project = findProject(state, projectId)
  if (!project) fail('NOT_FOUND', `项目不存在：${projectId ?? '(空)'}`)
  return project
}
function findFlow(state, flowId) {
  return state.flows.find((flow) => flow.id === flowId) ?? null
}
function flowById(state, flowId) {
  const flow = findFlow(state, flowId)
  if (!flow) fail('NOT_FOUND', `流程不存在：${flowId ?? '(空)'}`)
  return flow
}
function findNode(state, nodeId) {
  return state.nodes.find((node) => node.id === nodeId) ?? null
}
function nodeById(state, nodeId) {
  const node = findNode(state, nodeId)
  if (!node) fail('NOT_FOUND', `节点不存在：${nodeId ?? '(空)'}`)
  return node
}
function linkById(state, linkId) {
  const link = state.links.find((item) => item.id === linkId)
  if (!link) fail('NOT_FOUND', `链接不存在：${linkId ?? '(空)'}`)
  return link
}
function reportById(state, reportId) {
  const report = state.reports.find((item) => item.id === reportId)
  if (!report) fail('NOT_FOUND', `周报不存在：${reportId ?? '(空)'}`)
  return report
}
function approvalRolesOf(node) {
  return Array.isArray(node.approvalRoles) ? node.approvalRoles : []
}
function designLinkCount(state, nodeId) {
  return state.links.filter((link) => link.nodeId === nodeId && link.kind === 'design').length
}

/** 流程内节点（按 sortOrder）。 */
function flowNodes(state, flowId) {
  return state.nodes
    .filter((node) => node.flowId === flowId)
    .sort((a, b) => (Number(a.sortOrder) || 0) - (Number(b.sortOrder) || 0))
}

/** 项目内节点（先按 flow.sortOrder，再按 node.sortOrder）。 */
function projectNodes(state, projectId) {
  const flows = state.flows
    .filter((flow) => flow.projectId === projectId)
    .sort((a, b) => (Number(a.sortOrder) || 0) - (Number(b.sortOrder) || 0))
  const rank = new Map(flows.map((flow, index) => [flow.id, index]))
  return state.nodes
    .filter((node) => node.projectId === projectId)
    .sort((a, b) => (rank.get(a.flowId) ?? 0) - (rank.get(b.flowId) ?? 0)
      || (Number(a.sortOrder) || 0) - (Number(b.sortOrder) || 0))
}

/** 全局节点排序索引（派生视图稳定排序用）。 */
function nodeOrderIndex(state) {
  const map = new Map()
  state.projects.forEach((project, projectIndex) => {
    const flows = state.flows
      .filter((flow) => flow.projectId === project.id)
      .sort((a, b) => (Number(a.sortOrder) || 0) - (Number(b.sortOrder) || 0))
    const flowRank = new Map(flows.map((flow, index) => [flow.id, index]))
    state.nodes
      .filter((node) => node.projectId === project.id)
      .sort((a, b) => (flowRank.get(a.flowId) ?? 0) - (flowRank.get(b.flowId) ?? 0)
        || (Number(a.sortOrder) || 0) - (Number(b.sortOrder) || 0))
      .forEach((node, nodeIndex) => map.set(node.id, projectIndex * 1000 + nodeIndex))
  })
  return map
}

/* ------------------------------------------------------------------ *
 * 事件 / 上下文
 * ------------------------------------------------------------------ */

/** 写一条事件（所有变更都必须留痕，PRD §8.2）。 */
function pushEvent(state, now, partial = {}) {
  const timestamp = partial.timestamp ?? isoOf(now)
  const event = {
    id: uid('ev'),
    projectId: partial.projectId ?? null,
    flowId: partial.flowId ?? null,
    nodeId: partial.nodeId ?? null,
    kind: partial.kind ?? 'nodeStatus',
    timestamp,
    details: partial.details ?? '',
    round: Number.isInteger(partial.round) ? partial.round : 1,
    // 节点模型 v2：事件记录操作来源（user=默认 / ui=HTTP 客户端 / agent=工具调用）。
    // 老事件没有该字段时不做全量重写，读取方用 `event.actor ?? 'user'` 兜底即可。
    actor: trimText(partial.actor) || 'user',
  }
  state.events.push(event)
  return event
}

function makeContext(state, now, extra = {}) {
  const ctx = {
    now,
    touched: false,
    actor: 'user',
    ...extra,
    touch() { ctx.touched = true },
    event(partial) {
      ctx.touched = true
      return pushEvent(state, now, { actor: ctx.actor, ...(partial ?? {}) })
    },
  }
  return ctx
}

/** 同步间隔（分钟）默认值与允许范围（settings.syncIntervalMinutes，客户端定时同步用）。 */
export const DEFAULT_SYNC_INTERVAL_MINUTES = 5
export const SYNC_INTERVAL_MINUTES_MIN = 1
export const SYNC_INTERVAL_MINUTES_MAX = 60

/**
 * 归一化同步间隔：只接受 1~60 的整数（数字，或客户端输入框给的纯数字字符串）；
 * 其它（0 / 61 / 小数 / 空 / null / 布尔 / 数组…）一律返回 null，由调用方决定报错还是回落默认值。
 */
export function normalizeSyncIntervalMinutes(value) {
  if (typeof value === 'number') {
    return Number.isInteger(value) && value >= SYNC_INTERVAL_MINUTES_MIN && value <= SYNC_INTERVAL_MINUTES_MAX
      ? value
      : null
  }
  if (typeof value === 'string') {
    const raw = value.trim()
    if (raw === '' || !/^\d+$/.test(raw)) return null
    const parsed = Number(raw)
    return parsed >= SYNC_INTERVAL_MINUTES_MIN && parsed <= SYNC_INTERVAL_MINUTES_MAX ? parsed : null
  }
  return null
}

/**
 * 契约 §4.2 B：settings.inheritDesignLink 默认 true（旧数据没有该字段时补在内存里）；
 * settings.syncIntervalMinutes 默认 5、范围 1~60（旧数据 / 非法旧值都回落到默认值）；
 * settings.evidencePolicy / settings.unlockPolicy 为节点模型 v2 新增（旧数据补默认值）；
 * 同时给老节点补 approvalLog / returnReason / waitingKind，老数据不需要迁移脚本也能正常读写。
 */
function ensureSettingsDefaults(state) {
  if (!state || typeof state !== 'object') return state
  if (!state.settings || typeof state.settings !== 'object' || Array.isArray(state.settings)) {
    state.settings = defaultSettings(state?.settings?.dataFile ?? '')
  }
  if (typeof state.settings.inheritDesignLink !== 'boolean') state.settings.inheritDesignLink = true
  const interval = normalizeSyncIntervalMinutes(state.settings.syncIntervalMinutes)
  state.settings.syncIntervalMinutes = interval === null ? DEFAULT_SYNC_INTERVAL_MINUTES : interval
  // 证据策略：非法旧值按默认处理（写入接口会严格报 INVALID_INPUT）。
  state.settings.evidencePolicy = readEvidencePolicy(state.settings.evidencePolicy)
    ?? { kinds: [], minLinks: DEFAULT_EVIDENCE_POLICY.minLinks }
  state.settings.unlockPolicy = readUnlockPolicy(state.settings.unlockPolicy) ?? DEFAULT_UNLOCK_POLICY
  if (Array.isArray(state.nodes)) state.nodes.forEach((node) => ensureNodeDefaults(node))
  return state
}

/** 老节点补新字段（只补缺省值，不改历史语义）。 */
function ensureNodeDefaults(node) {
  if (!node || typeof node !== 'object') return node
  if (!Array.isArray(node.approvalLog)) node.approvalLog = []
  if (!Object.hasOwn(node, 'returnReason')) node.returnReason = null
  if (!WAITING_KINDS.includes(node.waitingKind)) node.waitingKind = null
  // plannedAt：旧节点缺失/非法值 → null（ISO 字符串合法值原样归一）
  node.plannedAt = isoOf(node.plannedAt)
  return node
}

/* ------------------------------------------------------------------ *
 * 节点模型 v2：完成证据策略（替代写死的 设计稿 门槛）
 *
 * 结构 evidencePolicy = { kinds: string[]（空数组 = 不限类型）, minLinks: 0~10 }
 * 解析优先级：node.evidencePolicy → project.evidencePolicy → settings.evidencePolicy → 默认
 *             { kinds: [], minLinks: 1 }（「至少一条任意类型证据」）。
 * 门槛只约束「本来就需要门槛」的节点：双角色确认节点（与旧 设计稿 门槛作用域一致），
 * 或显式配置了节点级策略的节点（project / settings 的策略作用于该范围内需要门槛的节点，
 * 不会给 D01-D03 这类无确认节点突然加上留证要求）。
 * `NEED_DESIGN_LINK` 错误码保留在常量表里（老客户端可能判断它），但 2.0 起不再抛出。
 * ------------------------------------------------------------------ */

function isPolicyRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * 校验并归一化证据策略；非法入参抛 INVALID_INPUT。
 * kinds 必须是 LINK_KINDS 子集（自动去重、保持声明顺序）；minLinks 是 0~10 的整数。
 */
export function normalizeEvidencePolicy(value) {
  if (!isPolicyRecord(value)) {
    fail('INVALID_INPUT', 'evidencePolicy 必须是对象：{ kinds: [...], minLinks: 1 }')
  }
  if (Object.hasOwn(value, 'kinds') && value.kinds !== null && !Array.isArray(value.kinds)) {
    fail('INVALID_INPUT', 'evidencePolicy.kinds 必须是数组（空数组表示不限类型）')
  }
  const kinds = []
  for (const raw of Array.isArray(value.kinds) ? value.kinds : []) {
    const kind = trimText(raw)
    if (!LINK_KINDS.includes(kind)) {
      fail('INVALID_INPUT', `evidencePolicy.kinds 只能包含 ${LINK_KINDS.join(' / ')}`)
    }
    if (!kinds.includes(kind)) kinds.push(kind)
  }
  let minLinks = value.minLinks
  if (minLinks === undefined || minLinks === null) minLinks = 1
  if (typeof minLinks === 'string' && /^\d+$/.test(minLinks.trim())) minLinks = Number(minLinks.trim())
  if (!Number.isInteger(minLinks) || minLinks < 0 || minLinks > EVIDENCE_MIN_LINKS_MAX) {
    fail('INVALID_INPUT', `evidencePolicy.minLinks 必须是 0-${EVIDENCE_MIN_LINKS_MAX} 的整数`)
  }
  return { kinds, minLinks }
}

/** 读侧宽松版：非法 / 缺失返回 null（老数据、手改数据不因此崩溃）。 */
function readEvidencePolicy(value) {
  if (value === undefined || value === null) return null
  try {
    return normalizeEvidencePolicy(value)
  } catch {
    return null
  }
}

/** 校验解锁策略；非法入参抛 INVALID_INPUT。 */
export function normalizeUnlockPolicy(value) {
  const text = trimText(value)
  if (!UNLOCK_POLICIES.includes(text)) {
    fail('INVALID_INPUT', `unlockPolicy 必须是 ${UNLOCK_POLICIES.join(' / ')}`)
  }
  return text
}

function readUnlockPolicy(value) {
  const text = trimText(value)
  return UNLOCK_POLICIES.includes(text) ? text : null
}

/** 证据策略三层解析（node → project → settings → 默认）。 */
function resolveEvidencePolicy(state, project, node) {
  const own = readEvidencePolicy(node?.evidencePolicy)
  if (own) return { ...own, source: 'node' }
  const projectPolicy = readEvidencePolicy(project?.evidencePolicy)
  if (projectPolicy) return { ...projectPolicy, source: 'project' }
  const settingsPolicy = readEvidencePolicy(state?.settings?.evidencePolicy)
  if (settingsPolicy) return { ...settingsPolicy, source: 'settings' }
  return { kinds: [], minLinks: DEFAULT_EVIDENCE_POLICY.minLinks, source: 'default' }
}

/**
 * 是否需要跑证据门槛：双角色节点一定跑；显式配置了节点级策略的节点也跑。
 * 项目级 / 全局策略的作用域仍是「需要门槛的节点」（与旧 设计稿 门槛一致），
 * 避免给 D01-D03 这类无确认节点突然加上留证要求。
 */
function evidenceGateApplies(node) {
  if (approvalRolesOf(node).length > 0) return true
  return Boolean(readEvidencePolicy(node?.evidencePolicy))
}

/** 计算某节点当前证据满足情况（供门槛校验与 approve/addLink 的返回字段复用）。 */
function evaluateEvidenceGate(state, node) {
  const project = findProject(state, node.projectId)
  const policy = resolveEvidencePolicy(state, project, node)
  const links = state.links.filter((link) => link.nodeId === node.id)
  const matched = policy.kinds.length === 0
    ? links
    : links.filter((link) => policy.kinds.includes(link.kind))
  return {
    applies: evidenceGateApplies(node),
    policy,
    linkCount: links.length,
    count: matched.length,
    required: policy.minLinks,
    satisfied: matched.length >= policy.minLinks,
  }
}

/** 证据策略的中文说明（错误提示 / 客户端提示共用）。 */
function evidencePolicyText(policy) {
  const kindsText = policy.kinds.length === 0
    ? '任意类型'
    : policy.kinds.map((kind) => LINK_KIND_LABEL[kind] ?? kind).join(' / ')
  return `至少 ${policy.minLinks} 条（类型：${kindsText}）证据链接`
}

/**
 * NEED_EVIDENCE 错误：`ERROR_CODES` 已收录该码，直接抛 FpError（HTTP 409 由 http.js 映射）。
 */
function failEvidence(message) {
  fail('NEED_EVIDENCE', message)
}

/** 统一取操作人：payload.by（导入/测试覆盖）→ ctx.actor → 'user'。 */
function resolveActor(ctx, payload = {}) {
  const explicit = trimText(payload?.by)
  if (explicit !== '') return explicit
  const fromCtx = trimText(ctx?.actor)
  return fromCtx !== '' ? fromCtx : 'user'
}

/** 追加一条审批记录（approve / reject 都记录，passed 区分）。 */
function appendApprovalLog(node, { role = null, passed, by, at, comment, round } = {}) {
  if (!Array.isArray(node.approvalLog)) node.approvalLog = []
  node.approvalLog.push({
    role: role ?? null,
    passed: passed === true,
    by: trimText(by) || 'user',
    at: at ?? null,
    comment: trimText(comment),
    round: Number.isInteger(round) ? round : (Number(node.round) || 1),
  })
}

/** 归档项目写保护：所有会改数据/状态的 action 在改动前统一走这里。 */
function assertProjectWritable(state, project) {
  if (project && project.status === 'archived') {
    fail('INVALID_STATE', `项目「${project.title}」已归档，恢复后才能修改`)
  }
}

/** 设计稿链接继承是否开启（默认 true；只有显式 false 才关闭）。 */
function inheritDesignLinkEnabled(state) {
  return state?.settings?.inheritDesignLink !== false
}

function appendNote(node, text) {
  const clean = trimText(text)
  if (clean === '') return
  node.notes = node.notes ? `${node.notes}\n${clean}` : clean
}

/* ------------------------------------------------------------------ *
 * 流程 / 依赖 构造
 * ------------------------------------------------------------------ */

/** 为项目实例化一个模板流程与节点（不写项目级事件，由调用方补）。 */
function createFlowWithNodes(state, project, template, sortOrder) {
  const flow = {
    id: uid('fl'),
    projectId: project.id,
    templateId: template.id,
    templateVersion: template.version,
    name: template.title,
    sortOrder,
  }
  state.flows.push(flow)
  // 只有项目里 sortOrder=0 的主流程首节点直接可用；其余流程首节点等 handoff 解锁
  const activateFirst = sortOrder === 0
  template.nodes.forEach((spec, index) => {
    const roles = Array.isArray(spec.approvalRoles) ? [...spec.approvalRoles] : []
    const approvals = {}
    for (const role of roles) approvals[role] = false
    let status = 'locked'
    if (index === 0 && activateFirst) status = spec.assigneeRole === '研发' ? 'waiting' : 'ready'
    state.nodes.push({
      id: uid('nd'),
      flowId: flow.id,
      projectId: project.id,
      code: spec.code,
      title: spec.title,
      detail: spec.detail ?? '',
      status,
      sortOrder: index,
      assigneeRole: spec.assigneeRole ?? '设计',
      approvalRoles: roles,
      approvals,
      approvalLog: [],
      returnReason: null,
      waitingKind: null,
      evidencePolicy: null,
      plannedAt: null,
      dueAt: null,
      followUpAt: null,
      completedAt: null,
      notes: '',
      round: 1,
    })
  })
  return flow
}

/** 重建项目内依赖：flow 内 sequence、approval 节点 return、跨 flow handoff。 */
function rebuildDependencies(state, projectId) {
  const projectNodeIds = new Set(state.nodes.filter((node) => node.projectId === projectId).map((node) => node.id))
  // 项目自己的旧依赖（含已删除节点残留）全部丢弃后重建
  state.dependencies = state.dependencies.filter((dep) => {
    if (projectNodeIds.has(dep.fromNodeId) || projectNodeIds.has(dep.toNodeId)) return false
    return true
  })
  const flows = state.flows
    .filter((flow) => flow.projectId === projectId)
    .sort((a, b) => (Number(a.sortOrder) || 0) - (Number(b.sortOrder) || 0))
  const fresh = []
  for (const flow of flows) {
    const nodes = flowNodes(state, flow.id)
    for (let index = 0; index < nodes.length - 1; index += 1) {
      fresh.push({ fromNodeId: nodes[index].id, toNodeId: nodes[index + 1].id, relation: 'sequence' })
    }
    for (const node of nodes) {
      const spec = templateNode(flow.templateId, node.code)
      if (!spec?.returnToCode) continue
      const target = nodes.find((item) => item.code === spec.returnToCode)
      if (target) fresh.push({ fromNodeId: node.id, toNodeId: target.id, relation: 'return' })
    }
    // 自定义流程（createProjectFromNodes / addNode 产生）没有模板定义：
    // 带 approvalRoles 的节点固定回退到前一节点，与建边规则一致。
    // 这样后续 addNode / reorderNode / removeNode 触发 rebuild 时 return 边不会丢；
    // 既有 delivery / acceptance 流程完全不受影响。
    if (flow.templateId === 'custom') {
      for (let index = 1; index < nodes.length; index += 1) {
        if (approvalRolesOf(nodes[index]).length === 0) continue
        fresh.push({ fromNodeId: nodes[index].id, toNodeId: nodes[index - 1].id, relation: 'return' })
      }
    }
  }
  for (const link of HANDOFF_LINKS) {
    const fromFlow = flows.find((flow) => flow.templateId === link.fromTemplate)
    const toFlow = flows.find((flow) => flow.templateId === link.toTemplate)
    if (!fromFlow || !toFlow) continue
    const fromNode = state.nodes.find((node) => node.flowId === fromFlow.id && node.code === link.fromCode)
    const toNode = state.nodes.find((node) => node.flowId === toFlow.id && node.code === link.toCode)
    if (fromNode && toNode) fresh.push({ fromNodeId: fromNode.id, toNodeId: toNode.id, relation: 'handoff' })
  }
  state.dependencies.push(...fresh)
}

/** 解锁一个 locked 节点（研发节点进入 waiting，其余 ready）；解锁时清空 waitingKind。 */
function unlockNode(state, node, ctx) {
  if (!node || node.status !== 'locked') return false
  node.status = node.assigneeRole === '研发' ? 'waiting' : 'ready'
  node.waitingKind = null
  ctx.event({
    projectId: node.projectId, flowId: node.flowId, nodeId: node.id,
    kind: 'unlocked', details: `「${node.title}」已解锁`, round: node.round,
  })
  return true
}

/** 解锁策略解析：project.unlockPolicy → settings.unlockPolicy → 默认 linear。 */
function resolveUnlockPolicy(state, project) {
  const own = readUnlockPolicy(project?.unlockPolicy)
  if (own) return own
  return readUnlockPolicy(state?.settings?.unlockPolicy) ?? DEFAULT_UNLOCK_POLICY
}

/** parallel：同流程仍 locked 的节点一次性解锁，事件合并成一条（列出节点编号）。 */
function unlockFlowParallel(state, node, ctx) {
  const targets = flowNodes(state, node.flowId).filter((item) => item.status === 'locked')
  if (targets.length === 0) return []
  for (const item of targets) {
    item.status = item.assigneeRole === '研发' ? 'waiting' : 'ready'
    item.waitingKind = null
  }
  ctx.event({
    projectId: node.projectId, flowId: node.flowId, nodeId: null,
    kind: 'unlocked',
    details: `并行解锁 ${targets.map((item) => item.code || item.title).join('、')}`,
    round: Number(node.round) || 1,
  })
  return targets
}

/** 完成后：解锁同流程节点（按 unlockPolicy）+ 跨流程 handoff 目标。 */
function unlockAfter(state, node, ctx) {
  const project = findProject(state, node.projectId)
  if (resolveUnlockPolicy(state, project) === 'parallel') {
    unlockFlowParallel(state, node, ctx)
  } else {
    const siblings = flowNodes(state, node.flowId)
    const next = siblings.find((item) => (Number(item.sortOrder) || 0) > (Number(node.sortOrder) || 0) && item.status === 'locked')
    if (next) unlockNode(state, next, ctx)
  }
  for (const dep of state.dependencies) {
    if (dep.relation !== 'handoff' || dep.fromNodeId !== node.id) continue
    unlockNode(state, findNode(state, dep.toNodeId), ctx)
  }
}

/** 补解锁：源节点早已完成（例如后续才添加验收流程）时，让 handoff 目标立刻可用。 */
function unlockCompletedHandoffs(state, projectId, ctx) {
  for (const dep of state.dependencies) {
    if (dep.relation !== 'handoff') continue
    const from = findNode(state, dep.fromNodeId)
    const to = findNode(state, dep.toNodeId)
    if (!from || !to) continue
    if (from.projectId !== projectId) continue
    if (from.status === 'completed' && to.status === 'locked') unlockNode(state, to, ctx)
  }
}

/* ------------------------------------------------------------------ *
 * 设计稿链接继承（契约 §4.2 B）
 * ------------------------------------------------------------------ */

/** 继承目标：同 flow 中 sortOrder 更大的第一个节点 + 所有 relation='handoff' 依赖目标。 */
function designInheritTargets(state, fromNode) {
  const targets = []
  const siblings = flowNodes(state, fromNode.flowId)
  const next = siblings.find((item) => (Number(item.sortOrder) || 0) > (Number(fromNode.sortOrder) || 0))
  if (next) targets.push(next)
  for (const dep of state.dependencies) {
    if (dep.relation !== 'handoff' || dep.fromNodeId !== fromNode.id) continue
    const target = findNode(state, dep.toNodeId)
    if (target) targets.push(target)
  }
  return targets
}

/**
 * 把 fromNode 上的 设计稿链接复制到后继节点（完成 / 跳过时调用）：
 * - completed / skipped 目标跳过；同一目标已存在相同 url 时去重；
 * - 复制出的链接带 `inheritedFrom: <源节点 id>`，并写 `linkAdded` 事件；
 * - settings.inheritDesignLink === false 时整体关闭。
 * @returns {number} 实际新增的链接数
 */
function inheritDesignLinks(state, fromNode, ctx) {
  if (!fromNode || !inheritDesignLinkEnabled(state)) return 0
  const designLinks = state.links.filter((link) => link.nodeId === fromNode.id && link.kind === 'design')
  if (designLinks.length === 0) return 0
  const seenTargets = new Set()
  let inherited = 0
  for (const target of designInheritTargets(state, fromNode)) {
    if (!target || target.id === fromNode.id || seenTargets.has(target.id)) continue
    seenTargets.add(target.id)
    if (target.status === 'completed' || target.status === 'skipped') continue
    for (const link of designLinks) {
      if (state.links.some((item) => item.nodeId === target.id && item.url === link.url)) continue
      state.links.push({
        id: uid('lk'),
        nodeId: target.id,
        title: link.title,
        url: link.url,
        kind: 'design',
        createdAt: isoOf(ctx.now),
        inheritedFrom: fromNode.id,
      })
      ctx.event({
        projectId: target.projectId,
        flowId: target.flowId,
        nodeId: target.id,
        kind: 'linkAdded',
        details: `继承 设计稿链接「${link.title}」（← ${fromNode.code}）`,
        round: target.round,
      })
      inherited += 1
    }
  }
  return inherited
}

/* ------------------------------------------------------------------ *
 * 状态机动作辅助
 * ------------------------------------------------------------------ */

/**
 * 完成门槛：approvalRoles 全通过 + 满足证据策略（默认 1 条任意类型链接）。
 * 旧版写死的「至少一条 设计稿链接」被证据策略取代；NEED_DESIGN_LINK 保留但不再抛出。
 */
function assertCompletionGate(state, node) {
  const roles = approvalRolesOf(node)
  if (roles.length > 0) {
    const missing = roles.filter((role) => node.approvals?.[role] !== true)
    if (missing.length > 0) {
      fail('NEED_APPROVALS', `「${node.title}」还需要${missing.map((role) => ROLE_LABEL[role] ?? role).join('、')}确认`)
    }
  }
  if (!evidenceGateApplies(node)) return
  const gate = evaluateEvidenceGate(state, node)
  if (gate.satisfied) return
  failEvidence(
    `「${node.title}」完成前请先补充确认依据：需要${evidencePolicyText(gate.policy)}，当前 ${gate.count} 条`,
  )
}

function completeNodeInternal(state, node, ctx, { note = '', details } = {}) {
  const previous = node.status
  node.status = 'completed'
  node.completedAt = isoOf(ctx.now)
  node.followUpAt = null
  node.waitingKind = null
  appendNote(node, note)
  ctx.event({
    projectId: node.projectId, flowId: node.flowId, nodeId: node.id, kind: 'nodeStatus',
    details: details ?? `完成「${node.title}」（${STATUS_LABEL[previous] ?? previous} → 已完成）`,
    round: node.round,
  })
  unlockAfter(state, node, ctx)
  inheritDesignLinks(state, node, ctx)
  ctx.touch()
  return node
}

/** 双角色退回：本节点重新锁定（round+1、清空 approvals），return 目标进入 revision。 */
function rejectNodeInternal(state, node, ctx, { role = null, comment = '', by = '' } = {}) {
  const who = role ? (ROLE_LABEL[role] ?? role) : '确认方'
  const text = trimText(comment)
  const at = isoOf(ctx.now)
  const round = Number(node.round) || 1
  const actor = trimText(by) || resolveActor(ctx)
  // 节点模型 v2：退回也进 approvalLog，并把结构化原因写进 returnReason。
  appendApprovalLog(node, { role, passed: false, by: actor, at, comment: text, round })
  node.returnReason = { by: actor, at, comment: text, round, fromRole: role ?? null }
  ctx.event({
    projectId: node.projectId, flowId: node.flowId, nodeId: node.id, kind: 'approvalRejected',
    details: `${who}退回「${node.title}」${text ? `：${text}` : ''}`, round,
  })
  const targets = state.dependencies
    .filter((dep) => dep.relation === 'return' && dep.fromNodeId === node.id)
    .map((dep) => findNode(state, dep.toNodeId))
    .filter(Boolean)
  for (const target of targets) {
    target.round = (Number(target.round) || 1) + 1
    target.status = 'revision'
    target.completedAt = null
    target.followUpAt = null
    target.waitingKind = null
    ctx.event({
      projectId: target.projectId, flowId: target.flowId, nodeId: target.id, kind: 'revision',
      details: `由「${node.title}」退回：「${target.title}」需要修改${text ? `（${text}）` : ''}`,
      round: target.round,
    })
  }
  node.round = (Number(node.round) || 1) + 1
  node.status = 'locked'
  node.completedAt = null
  node.followUpAt = null
  node.waitingKind = null
  node.approvals = node.approvals ?? {}
  for (const key of Object.keys(node.approvals)) node.approvals[key] = false
  ctx.event({
    projectId: node.projectId, flowId: node.flowId, nodeId: node.id, kind: 'nodeStatus',
    details: `「${node.title}」退回后重新锁定（第 ${node.round} 轮）`, round: node.round,
  })
  ctx.touch()
  return { returnedNodeIds: targets.map((target) => target.id), nodeRound: node.round }
}

/* ------------------------------------------------------------------ *
 * 业务线 action
 * ------------------------------------------------------------------ */

function actionCreateLine(state, payload, ctx) {
  const name = requireText(firstDefined(payload.name, payload.title), '业务线名称')
  if (state.businessLines.some((line) => line.name === name)) fail('INVALID_INPUT', `业务线「${name}」已存在`)
  const sortOrder = state.businessLines.length === 0
    ? 0
    : Math.max(...state.businessLines.map((line) => Number(line.sortOrder) || 0)) + 1
  const line = { id: uid('bl'), name, sortOrder }
  state.businessLines.push(line)
  ctx.event({ kind: 'settingsChanged', details: `新增业务线「${name}」` })
  return { lineId: line.id, line }
}

function actionRenameLine(state, payload, ctx) {
  const line = lineById(state, payload.lineId)
  const name = requireText(payload.name, '业务线名称')
  if (state.businessLines.some((item) => item.id !== line.id && item.name === name)) {
    fail('INVALID_INPUT', `业务线「${name}」已存在`)
  }
  const before = line.name
  line.name = name
  ctx.event({ kind: 'settingsChanged', details: `重命名业务线「${before}」→「${name}」` })
  return { lineId: line.id, name }
}

function actionDeleteLine(state, payload, ctx) {
  const line = lineById(state, payload.lineId)
  if (state.projects.some((project) => project.businessLineId === line.id)) {
    fail('INVALID_STATE', `业务线「${line.name}」下仍有项目，无法删除（请先移动或归档项目）`)
  }
  state.businessLines = state.businessLines.filter((item) => item.id !== line.id)
  state.businessLines
    .sort((a, b) => (Number(a.sortOrder) || 0) - (Number(b.sortOrder) || 0))
    .forEach((item, index) => { item.sortOrder = index })
  ctx.event({ kind: 'settingsChanged', details: `删除业务线「${line.name}」` })
  return { lineId: line.id, deleted: true }
}

function actionReorderLine(state, payload, ctx) {
  const line = lineById(state, payload.lineId)
  const sortOrder = optionalNumber(payload.sortOrder, '顺序')
  if (sortOrder === undefined) fail('INVALID_INPUT', '请提供 sortOrder（0 表示最前）')
  const rest = state.businessLines.filter((item) => item.id !== line.id)
  const index = clamp(Math.round(sortOrder), 0, rest.length)
  rest.splice(index, 0, line)
  rest.forEach((item, order) => { item.sortOrder = order })
  state.businessLines = rest
  ctx.event({ kind: 'settingsChanged', details: `调整业务线「${line.name}」到第 ${index + 1} 位` })
  return { lineId: line.id, sortOrder: index }
}

/* ------------------------------------------------------------------ *
 * 项目 action
 * ------------------------------------------------------------------ */

function resolveTemplateIds(payload) {
  let templateIds = []
  if (payload.templateIds !== undefined && payload.templateIds !== null && payload.templateIds !== '') {
    // 兼容直接传字符串（"delivery,acceptance" 或单个 "delivery"）
    const raw = typeof payload.templateIds === 'string'
      ? payload.templateIds.split(',').map((item) => trimText(item)).filter(Boolean)
      : payload.templateIds
    templateIds = requireStringArray(raw, '流程模板')
  }
  const single = trimText(payload.templateId)
  if (single !== '' && !templateIds.includes(single)) templateIds.push(single)
  if (templateIds.length === 0) templateIds = ['delivery']
  const unknown = templateIds.filter((id) => !getTemplate(id))
  if (unknown.length > 0) {
    fail('INVALID_INPUT', `未知流程模板：${unknown.join('、')}（可用：${TEMPLATE_IDS.join(' / ')}）`)
  }
  // 设计交付永远作为主流程排最前（验收流程由 D07 handoff 解锁，避免首节点就绪顺序错乱）
  if (templateIds.includes('delivery') && templateIds.includes('acceptance')) {
    templateIds = ['delivery', ...templateIds.filter((id) => id !== 'delivery')]
  }
  return templateIds
}

/** 读可选的证据 / 解锁策略（省略或 null 表示继承上层；非法值抛 INVALID_INPUT）。 */
function optionalEvidencePolicy(payload) {
  if (!Object.hasOwn(payload, 'evidencePolicy')) return null
  const value = payload.evidencePolicy
  return value === null || value === undefined ? null : normalizeEvidencePolicy(value)
}
function optionalUnlockPolicy(payload) {
  if (!Object.hasOwn(payload, 'unlockPolicy')) return null
  const value = payload.unlockPolicy
  return value === null || value === undefined ? null : normalizeUnlockPolicy(value)
}

function actionCreateProject(state, payload, ctx) {
  const line = lineById(state, payload.businessLineId)
  const title = requireText(payload.title, '项目名称')
  const dueAt = optionalIso(payload.dueAt, '交付日期')
  const templateIds = resolveTemplateIds(payload)
  const project = {
    id: uid('pr'),
    businessLineId: line.id,
    title,
    status: 'active',
    dueAt,
    createdAt: isoOf(ctx.now),
    archivedAt: null,
    // 节点模型 v2：null 表示继承 settings（项目级策略可覆盖证据门槛 / 解锁方式）
    evidencePolicy: optionalEvidencePolicy(payload),
    unlockPolicy: optionalUnlockPolicy(payload),
  }
  state.projects.push(project)
  ctx.event({
    projectId: project.id, kind: 'projectCreated',
    details: `创建项目「${title}」${dueAt ? `，交付日期 ${formatDay(dueAt, ctx.now)}` : ''}`, round: 1,
  })
  const flows = []
  templateIds.forEach((templateId, index) => {
    const template = getTemplate(templateId)
    const flow = createFlowWithNodes(state, project, template, index)
    flows.push(flow)
    ctx.event({
      projectId: project.id, flowId: flow.id, kind: 'flowAdded',
      details: `添加流程「${template.title}」`, round: 1,
    })
  })
  rebuildDependencies(state, project.id)
  ctx.touch()
  return {
    projectId: project.id,
    flowIds: flows.map((flow) => flow.id),
    nodeIds: state.nodes.filter((node) => node.projectId === project.id).map((node) => node.id),
  }
}

function actionUpdateProject(state, payload, ctx) {
  const project = projectById(state, payload.projectId)
  const changes = []
  if (Object.hasOwn(payload, 'title')) {
    const title = requireText(payload.title, '项目名称')
    if (title !== project.title) { changes.push(`名称「${project.title}」→「${title}」`); project.title = title }
  }
  if (Object.hasOwn(payload, 'dueAt')) {
    const dueAt = optionalIso(payload.dueAt, '交付日期')
    changes.push(`交付日期：${project.dueAt ? formatDay(project.dueAt, ctx.now) : '无'} → ${dueAt ? formatDay(dueAt, ctx.now) : '无'}`)
    project.dueAt = dueAt
  }
  if (Object.hasOwn(payload, 'businessLineId') && payload.businessLineId !== undefined && payload.businessLineId !== null) {
    const line = lineById(state, payload.businessLineId)
    if (line.id !== project.businessLineId) {
      const before = findLine(state, project.businessLineId)?.name ?? '(未知)'
      changes.push(`业务线「${before}」→「${line.name}」`)
      project.businessLineId = line.id
    }
  }
  if (Object.hasOwn(payload, 'evidencePolicy')) {
    const policy = payload.evidencePolicy === null || payload.evidencePolicy === undefined
      ? null
      : normalizeEvidencePolicy(payload.evidencePolicy)
    project.evidencePolicy = policy
    changes.push(policy ? `证据策略：${evidencePolicyText(policy)}` : '证据策略：改为继承设置')
  }
  if (Object.hasOwn(payload, 'unlockPolicy')) {
    const policy = payload.unlockPolicy === null || payload.unlockPolicy === undefined
      ? null
      : normalizeUnlockPolicy(payload.unlockPolicy)
    project.unlockPolicy = policy
    changes.push(policy ? `解锁策略：${policy === 'parallel' ? '并行' : '线性'}` : '解锁策略：改为继承设置')
  }
  if (changes.length === 0) return { projectId: project.id, changed: false }
  ctx.event({ projectId: project.id, kind: 'projectUpdated', details: `更新项目：${changes.join('；')}` })
  return { projectId: project.id, changed: true }
}

function actionArchiveProject(state, payload, ctx) {
  const project = projectById(state, payload.projectId)
  const archived = optionalBoolean(payload.archived, 'archived') ?? true
  if (!archived && project.status === 'active') return { projectId: project.id, status: 'active', changed: false }
  if (archived && project.status === 'archived') return { projectId: project.id, status: 'archived', changed: false }
  project.status = archived ? 'archived' : 'active'
  project.archivedAt = archived ? isoOf(ctx.now) : null
  ctx.event({
    projectId: project.id, kind: 'projectArchived',
    details: archived ? `归档项目「${project.title}」` : `恢复项目「${project.title}」`,
  })
  return { projectId: project.id, status: project.status, changed: true }
}

/** 删除前把完整快照写到 <dataDir>/backups/pre-delete-<ISO>.json（保留最近 10 份）。 */
function writePreDeleteBackup(state, ctx) {
  const dataFile = ctx?.dataFile || state?.settings?.dataFile || ''
  if (typeof dataFile !== 'string' || dataFile === '') return null
  const backupDir = join(dirname(dataFile), 'backups')
  try {
    mkdirSync(backupDir, { recursive: true })
    const stampMs = Math.max(Date.now(), lastPreDeleteStampMs + 1)
    lastPreDeleteStampMs = stampMs
    const stamp = new Date(stampMs).toISOString().replace(/[:.]/g, '-')
    const file = join(backupDir, `${PRE_DELETE_BACKUP_PREFIX}${stamp}.json`)
    const payload = {
      formatVersion: FORMAT_VERSION,
      revision: typeof ctx?.revision === 'number' ? ctx.revision : null,
      savedAt: isoOf(ctx.now),
      state: clone(state),
    }
    writeFileSync(file, JSON.stringify(payload, null, 2), 'utf8')
    const names = readdirSync(backupDir)
      .filter((name) => name.startsWith(PRE_DELETE_BACKUP_PREFIX) && name.endsWith('.json'))
      .sort()
    while (names.length > PRE_DELETE_BACKUP_KEEP) {
      const oldest = names.shift()
      try { unlinkSync(join(backupDir, oldest)) } catch { /* 忽略 */ }
    }
    return file
  } catch (error) {
    // 备份失败不阻断删除，但事件里会记录（见调用处）
    return null
  }
}

/**
 * 契约 §4.2 A：永久删除项目（级联删干净，删除前自动备份）。
 * 与 archiveProject 的区别：归档可恢复；删除不可撤销。
 */
function actionDeleteProject(state, payload, ctx) {
  const confirm = trimText(payload.confirm)
  if (confirm !== 'DELETE') {
    fail('INVALID_INPUT', '删除项目需要 confirm="DELETE"（防止误调用；不可撤销）')
  }
  const project = projectById(state, payload.projectId)
  const flows = state.flows.filter((flow) => flow.projectId === project.id)
  const flowIds = new Set(flows.map((flow) => flow.id))
  const nodes = state.nodes.filter((node) => node.projectId === project.id || flowIds.has(node.flowId))
  const nodeIds = new Set(nodes.map((node) => node.id))
  const links = state.links.filter((link) => nodeIds.has(link.nodeId))
  const eventIds = new Set(
    state.events
      .filter((event) => event.projectId === project.id || (event.nodeId && nodeIds.has(event.nodeId)))
      .map((event) => event.id),
  )
  const handoffsBefore = state.handoffs.length
  const keptHandoffs = []
  for (const handoff of state.handoffs) {
    const ids = Array.isArray(handoff.nodeIds) ? handoff.nodeIds : []
    const remaining = ids.filter((id) => !nodeIds.has(id))
    if (remaining.length === ids.length) {
      keptHandoffs.push(handoff)
      continue
    }
    if (remaining.length === 0) continue
    keptHandoffs.push({ ...handoff, nodeIds: remaining })
  }

  // 先备份（在 mutate 之前）
  const backupPath = writePreDeleteBackup(state, ctx)

  state.projects = state.projects.filter((item) => item.id !== project.id)
  state.flows = state.flows.filter((flow) => flow.projectId !== project.id)
  state.nodes = state.nodes.filter((node) => !nodeIds.has(node.id))
  state.links = state.links.filter((link) => !nodeIds.has(link.nodeId))
  state.dependencies = state.dependencies
    .filter((dep) => !nodeIds.has(dep.fromNodeId) && !nodeIds.has(dep.toNodeId))
  state.events = state.events.filter((event) => !eventIds.has(event.id))
  state.handoffs = keptHandoffs
  ctx.touch()

  return {
    projectId: project.id,
    title: project.title,
    backupPath,
    deleted: {
      flows: flows.length,
      nodes: nodes.length,
      links: links.length,
      events: eventIds.size,
      handoffs: handoffsBefore - keptHandoffs.length,
    },
  }
}

function actionAddFlow(state, payload, ctx) {
  const project = projectById(state, payload.projectId)
  assertProjectWritable(state, project)
  const templateId = requireText(payload.templateId, '流程模板')
  // 节点包模板（experiment）只能 appendTemplate 追加到已有流程，不能新建流程。
  if (NODE_PACK_TEMPLATES[templateId]) {
    fail(
      'INVALID_INPUT',
      `「${NODE_PACK_TEMPLATES[templateId].title}」是节点包模板，只能用 appendTemplate 追加到已有流程，不能新建流程`,
    )
  }
  const template = getTemplate(templateId)
  if (!template) fail('INVALID_INPUT', `未知流程模板：${templateId}（可用：${TEMPLATE_IDS.join(' / ')}）`)
  if (state.flows.some((flow) => flow.projectId === project.id && flow.templateId === templateId)) {
    fail('INVALID_STATE', `项目「${project.title}」已有「${template.title}」流程`)
  }
  const sortOrder = state.flows.filter((flow) => flow.projectId === project.id).length === 0
    ? 0
    : Math.max(...state.flows.filter((flow) => flow.projectId === project.id).map((flow) => Number(flow.sortOrder) || 0)) + 1
  const flow = createFlowWithNodes(state, project, template, sortOrder)
  ctx.event({ projectId: project.id, flowId: flow.id, kind: 'flowAdded', details: `添加流程「${template.title}」` })
  rebuildDependencies(state, project.id)
  unlockCompletedHandoffs(state, project.id, ctx)
  // 兜底：首节点没有任何入边依赖（例如给只有验收流程的项目补设计交付流程）时直接解锁
  const firstNode = state.nodes
    .filter((node) => node.flowId === flow.id)
    .sort((a, b) => (Number(a.sortOrder) || 0) - (Number(b.sortOrder) || 0))[0]
  if (firstNode && firstNode.status === 'locked'
    && !state.dependencies.some((dep) => dep.toNodeId === firstNode.id)) {
    unlockNode(state, firstNode, ctx)
  }
  ctx.touch()
  return { projectId: project.id, flowId: flow.id, nodeIds: state.nodes.filter((node) => node.flowId === flow.id).map((node) => node.id) }
}

/** 追加模板时判定「流程还有活动节点」：ready/active/revision/waiting/blocked 都算（完成/跳过/锁定不算）。 */
const ACTIVE_FLOW_STATUS = new Set(['ready', 'active', 'revision', 'waiting', 'blocked'])

/**
 * 在已有流程末尾追加一套节点包模板（当前只有 experiment）。
 * - code：模板前缀 + 同流程已有同前缀最大数字 +1（一遍追加内递增）；
 * - plannedAt：startAt + 模板节点的 plannedOffsetDays 天（保留 startAt 的时分秒）；
 * - 状态：流程没有活动节点时首个 ready（parallel 策略全部 ready），否则全部 locked。
 */
function actionAppendTemplate(state, payload, ctx) {
  const flowId = trimText(payload.flowId)
  if (flowId === '') fail('INVALID_INPUT', '请提供 flowId（appendTemplate 只能追加到已有流程）')
  const flow = flowById(state, flowId)
  const project = projectById(state, flow.projectId)
  assertProjectWritable(state, project)
  const templateId = trimText(payload.templateId)
  if (templateId === '') {
    fail('INVALID_INPUT', `请提供 templateId（可追加的节点包模板：${NODE_PACK_TEMPLATE_IDS.join(' / ')}）`)
  }
  const template = NODE_PACK_TEMPLATES[templateId]
  if (!template) fail('INVALID_INPUT', `只能追加节点包模板：${NODE_PACK_TEMPLATE_IDS.join(' / ')}`)
  const startAt = optionalIso(payload.startAt, 'startAt') ?? isoOf(ctx.now)
  const startDate = toDate(startAt)
  const siblings = flowNodes(state, flow.id)
  const hadActive = siblings.some((node) => ACTIVE_FLOW_STATUS.has(node.status))
  // 流程没有活动节点时才需要「有人能开始」：linear 给首个，parallel 全部。
  const allowReady = !hadActive
  const allReady = allowReady && resolveUnlockPolicy(state, project) === 'parallel'
  let nextOrder = siblings.length === 0
    ? 0
    : Math.max(...siblings.map((node) => Number(node.sortOrder) || 0)) + 1
  const seqByPrefix = new Map()
  const created = []
  for (const spec of template.nodes) {
    const match = /^([A-Za-z]+)\d+$/.exec(String(spec.code ?? ''))
    const prefix = match ? match[1] : 'E'
    if (!seqByPrefix.has(prefix)) seqByPrefix.set(prefix, maxNodeCodeNumber(state, flow.id, prefix))
    const seq = seqByPrefix.get(prefix) + 1
    seqByPrefix.set(prefix, seq)
    const code = `${prefix}${String(seq).padStart(2, '0')}`
    const plannedAt = isoOf(addDays(startDate, Number(spec.plannedOffsetDays) || 0))
    const node = {
      id: uid('nd'),
      flowId: flow.id,
      projectId: project.id,
      code,
      title: spec.title,
      detail: spec.detail ?? '',
      status: allowReady && (created.length === 0 || allReady) ? 'ready' : 'locked',
      sortOrder: nextOrder,
      assigneeRole: spec.assigneeRole ?? '设计',
      approvalRoles: [],
      approvals: {},
      approvalLog: [],
      returnReason: null,
      waitingKind: null,
      evidencePolicy: null,
      plannedAt,
      dueAt: null,
      followUpAt: null,
      completedAt: null,
      notes: '',
      round: 1,
    }
    nextOrder += 1
    state.nodes.push(node)
    created.push(node)
    ctx.event({
      projectId: project.id, flowId: flow.id, nodeId: node.id, kind: 'nodeAdded',
      details: `追加模板『${template.title}』：${node.code} ${node.title}`, round: 1,
    })
  }
  rebuildDependencies(state, project.id)
  ctx.touch()
  return {
    flowId: flow.id,
    templateId: template.id,
    templateTitle: template.title,
    nodeIds: created.map((node) => node.id),
    codes: created.map((node) => node.code),
    plannedAt: created.map((node) => node.plannedAt),
    appended: created.length,
    startAt,
    unlockPolicy: resolveUnlockPolicy(state, project),
    allReady: created.length > 0 && created.every((node) => node.status === 'ready'),
  }
}

/* ------------------------------------------------------------------ *
 * AI 提案 → 项目 action（docs/AI-PRD-DIALOG.md §2）
 *
 * 只做「新建项目」，不允许改已有项目（不接收 projectId）；节点顺序完全由
 * payload.nodes 决定，节点 code 用自定义节点约定 X01..Xnn，流程 templateId='custom'。
 * ------------------------------------------------------------------ */

const CUSTOM_FLOW_NAME = 'PRD 流程'
const CUSTOM_NODE_LIMIT = 100

/** 校验并归一化提案节点（模型输出不可信，引擎侧再兜一次底）。 */
function normalizeProposalNodeSpecs(rawNodes) {
  if (!Array.isArray(rawNodes)) fail('INVALID_INPUT', 'nodes 必须是节点数组')
  if (rawNodes.length === 0) fail('INVALID_INPUT', '至少需要 1 个节点')
  if (rawNodes.length > CUSTOM_NODE_LIMIT) fail('INVALID_INPUT', `节点过多（最多 ${CUSTOM_NODE_LIMIT} 个）`)
  return rawNodes.map((raw, index) => {
    const item = isPlainRecord(raw) ? raw : {}
    const title = requireText(firstDefined(item.title, item.name), `第 ${index + 1} 个节点的标题`)
    if (title.length > 120) fail('INVALID_INPUT', `第 ${index + 1} 个节点标题过长（最多 120 字）`)
    const detail = trimText(item.detail).slice(0, 200)
    const roleText = trimText(item.assigneeRole) || '设计'
    if (!ASSIGNEE_ROLES.includes(roleText)) {
      fail('INVALID_INPUT', `第 ${index + 1} 个节点的 assigneeRole 必须是 ${ASSIGNEE_ROLES.join(' / ')}`)
    }
    const approvalRoles = []
    const rawRoles = Array.isArray(item.approvalRoles) ? item.approvalRoles : []
    for (const rawRole of rawRoles) {
      const role = trimText(rawRole)
      if (!APPROVER_ROLES.includes(role)) {
        fail('INVALID_INPUT', `第 ${index + 1} 个节点的 approvalRoles 只能包含 design / product`)
      }
      if (!approvalRoles.includes(role)) approvalRoles.push(role)
    }
    if (approvalRoles.length > 0 && roleText !== '设计/产品') {
      fail('INVALID_INPUT', `节点「${title}」只有 assigneeRole 为「设计/产品」时才能设置双角色确认`)
    }
    return { title, detail, assigneeRole: roleText, approvalRoles }
  })
}

/**
 * 按 AI 提案新建项目（项目 + 自定义流程 + 节点 + 依赖 + 事件）。
 * payload：{ businessLineId | businessLineName, title, dueAt?, flowName?, nodes[] }
 */
function actionCreateProjectFromNodes(state, payload, ctx) {
  // 业务线：优先 id；否则按名字复用已有，找不到就新建（AI 契约 §1.4）
  const lineIdText = trimText(payload.businessLineId)
  const lineNameText = trimText(payload.businessLineName)
  let line = null
  let createdLine = false
  if (lineIdText !== '') {
    line = lineById(state, lineIdText)
  } else if (lineNameText !== '') {
    line = state.businessLines.find((item) => item.name === lineNameText) ?? null
    if (!line) {
      const sortOrder = state.businessLines.length === 0
        ? 0
        : Math.max(...state.businessLines.map((item) => Number(item.sortOrder) || 0)) + 1
      line = { id: uid('bl'), name: lineNameText, sortOrder }
      state.businessLines.push(line)
      createdLine = true
      ctx.event({ kind: 'settingsChanged', details: `新增业务线「${lineNameText}」（来自 PRD 解析）` })
    }
  } else {
    fail('INVALID_INPUT', '请提供 businessLineId 或 businessLineName')
  }

  const title = requireText(payload.title, '项目名称')
  const dueAt = optionalIso(payload.dueAt, '交付日期')
  const specs = normalizeProposalNodeSpecs(payload.nodes)
  const flowName = trimText(payload.flowName) || CUSTOM_FLOW_NAME

  const project = {
    id: uid('pr'),
    businessLineId: line.id,
    title,
    status: 'active',
    dueAt,
    createdAt: isoOf(ctx.now),
    archivedAt: null,
    evidencePolicy: optionalEvidencePolicy(payload),
    unlockPolicy: optionalUnlockPolicy(payload),
  }
  state.projects.push(project)
  ctx.event({
    projectId: project.id, kind: 'projectCreated',
    details: `创建项目「${title}」（来自 PRD 解析）${dueAt ? `，交付日期 ${formatDay(dueAt, ctx.now)}` : ''}`, round: 1,
  })

  const flow = {
    id: uid('fl'),
    projectId: project.id,
    templateId: 'custom',
    templateVersion: 1,
    name: flowName,
    sortOrder: 0,
  }
  state.flows.push(flow)
  ctx.event({
    projectId: project.id, flowId: flow.id, kind: 'flowAdded',
    details: `添加流程「${flowName}」`, round: 1,
  })

  const nodeIds = []
  specs.forEach((spec, index) => {
    const approvals = {}
    for (const role of spec.approvalRoles) approvals[role] = false
    const node = {
      id: uid('nd'),
      flowId: flow.id,
      projectId: project.id,
      code: `X${String(index + 1).padStart(2, '0')}`,
      title: spec.title,
      detail: spec.detail,
      // AI 契约 §2：第一个节点 ready，其余 locked
      status: index === 0 ? 'ready' : 'locked',
      sortOrder: index,
      assigneeRole: spec.assigneeRole,
      approvalRoles: spec.approvalRoles,
      approvals,
      approvalLog: [],
      returnReason: null,
      waitingKind: null,
      evidencePolicy: null,
      plannedAt: null,
      dueAt: null,
      followUpAt: null,
      completedAt: null,
      notes: '',
      round: 1,
    }
    state.nodes.push(node)
    nodeIds.push(node.id)
    ctx.event({
      projectId: project.id, flowId: flow.id, nodeId: node.id, kind: 'nodeAdded',
      details: `新增节点「${spec.title}」（${spec.assigneeRole}）`, round: 1,
    })
  })

  // 依赖：顺序链 + 带 approvalRoles 的节点指向前一节点（模拟 D04→D03 的返工语义）
  for (let index = 0; index < nodeIds.length - 1; index += 1) {
    state.dependencies.push({ fromNodeId: nodeIds[index], toNodeId: nodeIds[index + 1], relation: 'sequence' })
  }
  specs.forEach((spec, index) => {
    if (index === 0 || spec.approvalRoles.length === 0) return
    state.dependencies.push({ fromNodeId: nodeIds[index], toNodeId: nodeIds[index - 1], relation: 'return' })
  })

  ctx.touch()
  return {
    projectId: project.id,
    lineId: line.id,
    flowId: flow.id,
    nodeIds,
    nodes: nodeIds.length,
    nodeCount: nodeIds.length,
    createdLine,
    title,
  }
}

/* ------------------------------------------------------------------ *
 * 节点 action
 * ------------------------------------------------------------------ */

function actionStartNode(state, payload, ctx) {
  const node = nodeById(state, payload.nodeId)
  assertProjectWritable(state, findProject(state, node.projectId))
  if (node.status === 'locked') fail('INVALID_STATE', `「${node.title}」尚未解锁，不能开始`)
  if (node.status === 'completed') fail('INVALID_STATE', `「${node.title}」已完成，如需继续请先重新打开`)
  if (node.status === 'skipped') fail('INVALID_STATE', `「${node.title}」已跳过，不能开始`)
  if (node.status === 'active') return { nodeId: node.id, nodeCode: node.code, status: 'active', changed: false }
  const previous = node.status
  node.status = 'active'
  node.waitingKind = null
  if (previous === 'waiting' || previous === 'blocked') node.followUpAt = null
  ctx.event({
    projectId: node.projectId, flowId: node.flowId, nodeId: node.id, kind: 'nodeStatus',
    details: `开始「${node.title}」（${STATUS_LABEL[previous] ?? previous} → 进行中）`, round: node.round,
  })
  return { nodeId: node.id, nodeCode: node.code, status: 'active', changed: true }
}

function actionCompleteNode(state, payload, ctx) {
  const node = nodeById(state, payload.nodeId)
  assertProjectWritable(state, findProject(state, node.projectId))
  if (node.status === 'locked') fail('INVALID_STATE', `「${node.title}」尚未解锁，不能完成`)
  if (node.status === 'completed') return { nodeId: node.id, nodeCode: node.code, status: 'completed', completed: true, changed: false }
  if (node.status === 'skipped') fail('INVALID_STATE', `「${node.title}」已跳过，不能完成`)
  if (node.status === 'blocked') fail('INVALID_STATE', `「${node.title}」已阻塞，请先开始或解除阻塞再完成`)
  assertCompletionGate(state, node)
  completeNodeInternal(state, node, ctx, { note: trimText(payload.note) })
  return {
    nodeId: node.id, nodeCode: node.code, status: 'completed', completed: true,
    completedAt: node.completedAt, round: node.round, changed: true,
  }
}

function actionWaitNode(state, payload, ctx) {
  const node = nodeById(state, payload.nodeId)
  assertProjectWritable(state, findProject(state, node.projectId))
  if (!['ready', 'active', 'revision', 'waiting', 'blocked'].includes(node.status)) {
    fail('INVALID_STATE', `「${node.title}」当前状态（${STATUS_LABEL[node.status] ?? node.status}）不能标记待确认`)
  }
  const followUpAt = optionalIso(payload.followUpAt, '跟进时间')
  const note = trimText(payload.note)
  const previous = node.status
  node.status = 'waiting'
  // 节点模型 v2：waitNode 是「等外部依赖」，不是「等双角色确认」。
  node.waitingKind = 'external'
  node.followUpAt = followUpAt
  appendNote(node, note)
  ctx.event({
    projectId: node.projectId, flowId: node.flowId, nodeId: node.id, kind: 'nodeStatus',
    details: `「${node.title}」进入待确认（${STATUS_LABEL[previous] ?? previous} → 待确认）${note ? `：${note}` : ''}`,
    round: node.round,
  })
  if (followUpAt) {
    ctx.event({
      projectId: node.projectId, flowId: node.flowId, nodeId: node.id, kind: 'scheduleChanged',
      details: `「${node.title}」计划跟进：${formatDateTime(followUpAt, ctx.now)}`, round: node.round,
    })
  }
  return { nodeId: node.id, nodeCode: node.code, status: 'waiting', waitingKind: node.waitingKind, followUpAt, changed: true }
}

function actionBlockNode(state, payload, ctx) {
  const node = nodeById(state, payload.nodeId)
  assertProjectWritable(state, findProject(state, node.projectId))
  const reason = requireText(firstDefined(payload.reason, payload.comment), '阻塞原因')
  if (['completed', 'skipped', 'locked'].includes(node.status)) {
    fail('INVALID_STATE', `「${node.title}」当前状态（${STATUS_LABEL[node.status]}）不能阻塞`)
  }
  const followUpAt = optionalIso(payload.followUpAt, '跟进时间')
  node.status = 'blocked'
  node.waitingKind = null
  node.followUpAt = followUpAt
  ctx.event({
    projectId: node.projectId, flowId: node.flowId, nodeId: node.id, kind: 'nodeStatus',
    details: `阻塞「${node.title}」：${reason}`, round: node.round,
  })
  if (followUpAt) {
    ctx.event({
      projectId: node.projectId, flowId: node.flowId, nodeId: node.id, kind: 'scheduleChanged',
      details: `「${node.title}」计划跟进：${formatDateTime(followUpAt, ctx.now)}`, round: node.round,
    })
  }
  return { nodeId: node.id, nodeCode: node.code, status: 'blocked', reason, followUpAt, changed: true }
}

function actionSkipNode(state, payload, ctx) {
  const node = nodeById(state, payload.nodeId)
  assertProjectWritable(state, findProject(state, node.projectId))
  if (node.status === 'completed') fail('INVALID_STATE', `「${node.title}」已完成，如需重做请先重新打开`)
  if (node.status === 'skipped') return { nodeId: node.id, nodeCode: node.code, status: 'skipped', changed: false }
  // 节点模型 v2：允许跳过未解锁节点（范围裁剪），原因仍然必填。
  const wasLocked = node.status === 'locked'
  const reason = requireText(firstDefined(payload.reason, payload.comment), '跳过原因')
  node.status = 'skipped'
  node.completedAt = null
  node.followUpAt = null
  node.waitingKind = null
  ctx.event({
    projectId: node.projectId, flowId: node.flowId, nodeId: node.id, kind: 'nodeStatus',
    details: wasLocked
      ? `跳过未解锁节点（范围裁剪）「${node.title}」：${reason}`
      : `跳过「${node.title}」：${reason}`,
    round: node.round,
  })
  unlockAfter(state, node, ctx)
  inheritDesignLinks(state, node, ctx)
  ctx.touch()
  return {
    nodeId: node.id, nodeCode: node.code, status: 'skipped', reason,
    rangeTrimmed: wasLocked, changed: true,
  }
}

function actionReopenNode(state, payload, ctx) {
  const node = nodeById(state, payload.nodeId)
  assertProjectWritable(state, findProject(state, node.projectId))
  if (node.status !== 'completed') {
    fail('INVALID_STATE', `只有已完成节点可以重新打开（「${node.title}」当前：${STATUS_LABEL[node.status] ?? node.status}）`)
  }
  const reason = requireText(firstDefined(payload.reason, payload.comment), '重新打开原因')
  node.status = 'revision'
  node.round = (Number(node.round) || 1) + 1
  node.completedAt = null
  node.followUpAt = null
  node.waitingKind = null
  ctx.event({
    projectId: node.projectId, flowId: node.flowId, nodeId: node.id, kind: 'revision',
    details: `重新打开「${node.title}」：${reason}（第 ${node.round} 轮）`, round: node.round,
  })
  return { nodeId: node.id, nodeCode: node.code, status: 'revision', round: node.round, changed: true }
}

function actionRejectApproval(state, payload, ctx) {
  const node = nodeById(state, payload.nodeId)
  assertProjectWritable(state, findProject(state, node.projectId))
  if (approvalRolesOf(node).length === 0) fail('INVALID_INPUT', `「${node.title}」不是双角色确认节点`)
  if (node.status === 'locked') fail('INVALID_STATE', `「${node.title}」尚未解锁，无法退回`)
  if (node.status === 'completed') fail('INVALID_STATE', `「${node.title}」已完成，如需重做请先重新打开`)
  if (node.status === 'skipped') fail('INVALID_STATE', `「${node.title}」已跳过`)
  const comment = requireText(firstDefined(payload.comment, payload.reason), '退回原因')
  const out = rejectNodeInternal(state, node, ctx, { comment, by: resolveActor(ctx, payload) })
  return {
    nodeId: node.id, nodeCode: node.code, status: 'locked', round: out.nodeRound,
    returnedNodeIds: out.returnedNodeIds, changed: true,
  }
}

function actionApprove(state, payload, ctx) {
  const node = nodeById(state, payload.nodeId)
  assertProjectWritable(state, findProject(state, node.projectId))
  const role = trimText(payload.role)
  if (!APPROVER_ROLES.includes(role)) fail('INVALID_INPUT', 'role 必须是 design 或 product')
  const roles = approvalRolesOf(node)
  if (!roles.includes(role)) fail('INVALID_INPUT', `「${node.title}」不是双角色确认节点`)
  if (typeof payload.passed !== 'boolean') fail('INVALID_INPUT', 'passed 必须是布尔值（true=通过，false=退回）')
  if (['locked', 'completed', 'skipped'].includes(node.status)) {
    fail('INVALID_STATE', `「${node.title}」当前状态（${STATUS_LABEL[node.status]}）不能确认`)
  }
  const actor = resolveActor(ctx, payload)
  const comment = trimText(payload.comment)
  if (payload.passed === false) {
    const reason = requireText(firstDefined(payload.comment, payload.reason), '退回原因')
    const out = rejectNodeInternal(state, node, ctx, { role, comment: reason, by: actor })
    return {
      nodeId: node.id, nodeCode: node.code, role, passed: false, status: 'locked',
      round: out.nodeRound, returnedNodeIds: out.returnedNodeIds, changed: true,
    }
  }
  if (node.approvals?.[role] === true) {
    return { nodeId: node.id, nodeCode: node.code, role, passed: true, status: node.status, already: true, changed: false }
  }
  node.approvals = node.approvals ?? {}
  node.approvals[role] = true
  // 节点模型 v2：通过也记录 approvalLog（含 by / at / comment / round）。
  appendApprovalLog(node, {
    role, passed: true, by: actor, at: isoOf(ctx.now), comment, round: Number(node.round) || 1,
  })
  ctx.event({
    projectId: node.projectId, flowId: node.flowId, nodeId: node.id, kind: 'approvalPassed',
    details: `${ROLE_LABEL[role] ?? role}确认通过「${node.title}」${comment ? `：${comment}` : ''}`, round: node.round,
  })
  const missing = roles.filter((item) => node.approvals[item] !== true)
  const gate = evaluateEvidenceGate(state, node)
  let completed = false
  if (missing.length === 0 && gate.satisfied) {
    completeNodeInternal(state, node, ctx)
    completed = true
  } else {
    if (node.status !== 'waiting') node.status = 'waiting'
    // 部分通过（或证据未齐）→ 等待确认；且这里只可能是 approval 语义。
    node.waitingKind = 'approval'
  }
  ctx.touch()
  return {
    nodeId: node.id, nodeCode: node.code, role, passed: true, status: node.status, completed,
    missingRoles: missing.map((item) => ROLE_LABEL[item] ?? item),
    // 兼容旧字段名（老客户端判断 needDesignLink）；语义升级为「证据门槛未满足」。
    needDesignLink: missing.length === 0 && !gate.satisfied,
    needEvidence: missing.length === 0 && !gate.satisfied,
    evidencePolicy: gate.policy,
    evidenceCount: gate.count,
    requiredEvidence: gate.required,
    needEvidenceCount: Math.max(0, gate.required - gate.count),
    designLinkCount: designLinkCount(state, node.id),
    changed: true,
  }
}

function actionSetNodeSchedule(state, payload, ctx) {
  const node = nodeById(state, payload.nodeId)
  assertProjectWritable(state, findProject(state, node.projectId))
  const dueAt = Object.hasOwn(payload, 'dueAt') ? optionalIso(payload.dueAt, '计划时间') : node.dueAt ?? null
  const followUpAt = Object.hasOwn(payload, 'followUpAt') ? optionalIso(payload.followUpAt, '跟进时间') : node.followUpAt ?? null
  // plannedAt：节点计划时间（追加模板会按 startAt 自动填；也可手动改/清空）
  const plannedAt = Object.hasOwn(payload, 'plannedAt') ? optionalIso(payload.plannedAt, '节点计划时间') : node.plannedAt ?? null
  node.dueAt = dueAt
  node.followUpAt = followUpAt
  node.plannedAt = plannedAt
  ctx.event({
    projectId: node.projectId, flowId: node.flowId, nodeId: node.id, kind: 'scheduleChanged',
    details: `「${node.title}」计划时间：${dueAt ? formatDateTime(dueAt, ctx.now) : '无'}；跟进时间：${followUpAt ? formatDateTime(followUpAt, ctx.now) : '无'}；plannedAt：${plannedAt ? formatDateTime(plannedAt, ctx.now) : '无'}`,
    round: node.round,
  })
  return { nodeId: node.id, nodeCode: node.code, dueAt, followUpAt, plannedAt, changed: true }
}

function actionSetNodeNotes(state, payload, ctx) {
  const node = nodeById(state, payload.nodeId)
  assertProjectWritable(state, findProject(state, node.projectId))
  const notes = typeof payload.notes === 'string' ? payload.notes : (typeof payload.text === 'string' ? payload.text : null)
  if (notes === null) fail('INVALID_INPUT', 'notes 必须是字符串（传空字符串表示清空）')
  node.notes = notes
  const brief = trimText(notes).replace(/\s+/g, ' ').slice(0, 60)
  ctx.event({
    projectId: node.projectId, flowId: node.flowId, nodeId: node.id, kind: 'manualNote',
    details: `${brief === '' ? `清空「${node.title}」笔记` : `更新「${node.title}」笔记：${brief}`}`, round: node.round,
  })
  return { nodeId: node.id, nodeCode: node.code, notes, changed: true }
}

function actionAddNote(state, payload, ctx) {
  const project = projectById(state, payload.projectId)
  assertProjectWritable(state, project)
  const text = requireText(firstDefined(payload.text, payload.note, payload.notes), '记录内容')
  let node = null
  if (payload.nodeId !== undefined && payload.nodeId !== null && trimText(payload.nodeId) !== '') {
    node = nodeById(state, payload.nodeId)
    if (node.projectId !== project.id) fail('INVALID_INPUT', '节点不属于该项目')
  }
  const event = ctx.event({
    projectId: project.id, flowId: node?.flowId ?? null, nodeId: node?.id ?? null,
    kind: 'manualNote', details: text, round: node?.round ?? 1,
  })
  return { eventId: event.id, projectId: project.id, nodeId: node?.id ?? null, changed: true }
}

/** 同流程内指定前缀（如 X / E）的最大编号数字；没有同类 code 返回 0。 */
function maxNodeCodeNumber(state, flowId, prefix) {
  const pattern = new RegExp(`^${prefix}(\\d+)$`)
  let max = 0
  for (const node of state.nodes) {
    if (node.flowId !== flowId) continue
    const match = pattern.exec(String(node.code ?? ''))
    if (match) max = Math.max(max, Number(match[1]))
  }
  return max
}

/** 同流程内下一个可用节点编号：取所有 ^X(\d+)$ 的最大值 +1（删除中间节点后也不重复）。 */
function nextNodeCode(state, flowId) {
  return `X${String(maxNodeCodeNumber(state, flowId, 'X') + 1).padStart(2, '0')}`
}

function actionAddNode(state, payload, ctx) {
  const flow = flowById(state, payload.flowId)
  const project = projectById(state, flow.projectId)
  assertProjectWritable(state, project)
  const title = requireText(payload.title, '节点标题')
  const detail = trimText(payload.detail)
  const assigneeRole = trimText(payload.assigneeRole) || '设计'
  if (!ASSIGNEE_ROLES.includes(assigneeRole)) fail('INVALID_INPUT', `assigneeRole 必须是 ${ASSIGNEE_ROLES.join(' / ')}`)
  const siblings = flowNodes(state, flow.id)
  let index = siblings.length
  if (payload.beforeNodeId !== undefined && payload.beforeNodeId !== null && trimText(payload.beforeNodeId) !== '') {
    const target = siblings.find((node) => node.id === payload.beforeNodeId)
    if (!target) fail('NOT_FOUND', `参照节点不存在于该流程：${payload.beforeNodeId}`)
    index = siblings.indexOf(target)
  } else if (payload.afterNodeId !== undefined && payload.afterNodeId !== null && trimText(payload.afterNodeId) !== '') {
    const target = siblings.find((node) => node.id === payload.afterNodeId)
    if (!target) fail('NOT_FOUND', `参照节点不存在于该流程：${payload.afterNodeId}`)
    index = siblings.indexOf(target) + 1
  }
  // code 表示节点身份（可显式传入，同流程内唯一）；sortOrder 表示顺序，reorderNode 不会改 code。
  let code = ''
  const explicitCode = trimText(payload.code)
  if (explicitCode !== '') {
    if (!/^[A-Za-z]\d{2,3}$/.test(explicitCode)) {
      fail('INVALID_INPUT', '节点编号 code 需要形如 X01（字母 + 2~3 位数字）')
    }
    if (state.nodes.some((node) => node.flowId === flow.id && String(node.code) === explicitCode)) {
      fail('INVALID_INPUT', `流程内已存在节点编号 ${explicitCode}`)
    }
    code = explicitCode
  } else {
    code = nextNodeCode(state, flow.id)
  }
  const node = {
    id: uid('nd'),
    flowId: flow.id,
    projectId: project.id,
    code,
    title,
    detail,
    status: 'locked',
    sortOrder: index,
    assigneeRole,
    approvalRoles: [],
    approvals: {},
    approvalLog: [],
    returnReason: null,
    waitingKind: null,
    evidencePolicy: optionalEvidencePolicy(payload),
    plannedAt: null,
    dueAt: null,
    followUpAt: null,
    completedAt: null,
    notes: '',
    round: 1,
  }
  state.nodes.push(node)
  const ordered = flowNodes(state, flow.id).filter((item) => item.id !== node.id)
  ordered.splice(index, 0, node)
  ordered.forEach((item, order) => { item.sortOrder = order })
  if (index === 0) {
    node.status = assigneeRole === '研发' ? 'waiting' : 'ready'
    const previousFirst = ordered[1]
    if (previousFirst && (previousFirst.status === 'ready' || previousFirst.status === 'waiting')) {
      previousFirst.status = 'locked'
      previousFirst.waitingKind = null
    }
  }
  rebuildDependencies(state, project.id)
  ctx.event({
    projectId: project.id, flowId: flow.id, nodeId: node.id, kind: 'nodeAdded',
    details: `新增节点「${title}」（${assigneeRole}）`, round: 1,
  })
  return { nodeId: node.id, nodeCode: node.code, code: node.code, flowId: flow.id, sortOrder: index, changed: true }
}

function actionRemoveNode(state, payload, ctx) {
  const node = nodeById(state, payload.nodeId)
  assertProjectWritable(state, findProject(state, node.projectId))
  if (!['locked', 'ready', 'skipped'].includes(node.status)) {
    fail('INVALID_STATE', `只能删除未开始或已跳过的节点（「${node.title}」当前：${STATUS_LABEL[node.status] ?? node.status}）`)
  }
  const flow = flowById(state, node.flowId)
  const projectId = node.projectId
  const wasReady = node.status === 'ready'
  state.nodes = state.nodes.filter((item) => item.id !== node.id)
  state.links = state.links.filter((link) => link.nodeId !== node.id)
  state.dependencies = state.dependencies.filter((dep) => dep.fromNodeId !== node.id && dep.toNodeId !== node.id)
  const list = flowNodes(state, flow.id)
  list.forEach((item, index) => { item.sortOrder = index })
  if (wasReady && list[0] && list[0].status === 'locked') unlockNode(state, list[0], ctx)
  rebuildDependencies(state, projectId)
  ctx.event({
    projectId, flowId: flow.id, nodeId: node.id, kind: 'nodeRemoved',
    details: `删除节点「${node.title}」`, round: node.round,
  })
  ctx.touch()
  return { nodeId: node.id, nodeCode: node.code, removed: true, changed: true }
}

function actionReorderNode(state, payload, ctx) {
  const node = nodeById(state, payload.nodeId)
  assertProjectWritable(state, findProject(state, node.projectId))
  const sortOrder = optionalNumber(payload.sortOrder, '顺序')
  if (sortOrder === undefined) fail('INVALID_INPUT', '请提供 sortOrder（0 表示流程最前）')
  const flow = flowById(state, node.flowId)
  const rest = flowNodes(state, flow.id).filter((item) => item.id !== node.id)
  const index = clamp(Math.round(sortOrder), 0, rest.length)
  rest.splice(index, 0, node)
  rest.forEach((item, order) => { item.sortOrder = order })
  rebuildDependencies(state, node.projectId)
  ctx.event({
    projectId: node.projectId, flowId: flow.id, nodeId: node.id, kind: 'settingsChanged',
    details: `调整节点「${node.title}」到第 ${index + 1} 位`, round: node.round,
  })
  // code 表示节点身份，调整顺序不修改 code（客户端展示时以 sortOrder 排序）。
  return { nodeId: node.id, nodeCode: node.code, sortOrder: index, changed: true }
}

/* ------------------------------------------------------------------ *
 * 链接 action
 * ------------------------------------------------------------------ */

function actionAddLink(state, payload, ctx) {
  const node = nodeById(state, payload.nodeId)
  assertProjectWritable(state, findProject(state, node.projectId))
  const title = requireText(payload.title, '链接名称')
  const url = requireText(payload.url, '链接地址')
  const kind = trimText(payload.kind) || 'other'
  if (!LINK_KINDS.includes(kind)) fail('INVALID_INPUT', `链接类型必须是 ${LINK_KINDS.join(' / ')}`)
  if (!/^https?:\/\//i.test(url) && !/^[a-z][a-z0-9+.-]*:/i.test(url)) {
    fail('INVALID_INPUT', '链接地址需要是 http(s) 或其它带协议的 URL')
  }
  const link = { id: uid('lk'), nodeId: node.id, title, url, kind, createdAt: isoOf(ctx.now) }
  state.links.push(link)
  ctx.event({
    projectId: node.projectId, flowId: node.flowId, nodeId: node.id, kind: 'linkAdded',
    details: `添加${LINK_KIND_LABEL[kind] ?? kind}链接「${title}」`, round: node.round,
  })
  // 门槛补齐：双角色已通过、后补证据链接时也应自动完成（与 approve 的顺序无关）；
  // 证据是否足够由 evidencePolicy 决定（默认任意类型 ≥1 条，不再是写死的 设计稿）。
  let completed = false
  const roles = approvalRolesOf(node)
  if (roles.length > 0 && !['completed', 'locked', 'skipped'].includes(node.status)
    && roles.every((role) => node.approvals?.[role] === true) && evaluateEvidenceGate(state, node).satisfied) {
    completeNodeInternal(state, node, ctx)
    completed = true
  }
  ctx.touch()
  return { linkId: link.id, nodeId: node.id, nodeCode: node.code, completed, changed: true }
}

function actionRemoveLink(state, payload, ctx) {
  const link = linkById(state, payload.linkId)
  const node = findNode(state, link.nodeId)
  if (node) assertProjectWritable(state, findProject(state, node.projectId))
  state.links = state.links.filter((item) => item.id !== link.id)
  ctx.event({
    projectId: node?.projectId ?? null, flowId: node?.flowId ?? null, nodeId: node?.id ?? null,
    kind: 'linkAdded', details: `移除链接「${link.title}」`, round: node?.round ?? 1,
  })
  return { linkId: link.id, removed: true, changed: true }
}

/* ------------------------------------------------------------------ *
 * 交接 / 周报 / 设置 / 维护 action
 * ------------------------------------------------------------------ */

function actionSaveHandoff(state, payload, ctx) {
  let date = dateKey(ctx.now)
  if (payload.date !== undefined && payload.date !== null && trimText(payload.date) !== '') {
    const parsed = parseDateKey(trimText(payload.date))
    if (!parsed) fail('INVALID_INPUT', 'date 必须是本地日期 YYYY-MM-DD')
    date = dateKey(parsed)
  }
  const nodeIds = payload.nodeIds === undefined || payload.nodeIds === null
    ? []
    : requireStringArray(payload.nodeIds, '节点', { allowEmpty: true })
  for (const nodeId of nodeIds) nodeById(state, nodeId)
  const nextActions = requireText(payload.nextActions, '明日下一步')
  const notes = trimText(payload.notes)
  let handoff = state.handoffs.find((item) => item.date === date) ?? null
  const nowIso = isoOf(ctx.now)
  if (handoff) {
    handoff.nodeIds = nodeIds
    handoff.nextActions = nextActions
    handoff.notes = notes
    handoff.confirmedAt = nowIso
    handoff.source = 'user'
  } else {
    handoff = {
      id: uid('ho'), date, nodeIds, nextActions, notes,
      confirmedAt: nowIso, createdAt: nowIso, source: 'user',
    }
    state.handoffs.push(handoff)
  }
  ctx.event({ kind: 'handoffSaved', details: `保存 ${formatDay(date, ctx.now)} 日终交接（${nodeIds.length} 个节点）` })
  return { handoffId: handoff.id, date, nodeIds, changed: true }
}

function resolveWeekStartKey(state, payload, nowDate) {
  const settings = state.settings
  const weekStartsOn = Number(settings?.weekStartsOn) || 1
  if (payload.weekStart !== undefined && payload.weekStart !== null && trimText(payload.weekStart) !== '') {
    const parsed = parseDateKey(trimText(payload.weekStart))
    if (!parsed) fail('INVALID_INPUT', 'weekStart 必须是本地日期 YYYY-MM-DD（周一）')
    if (isoWeekday(parsed) !== weekStartsOn) fail('INVALID_INPUT', 'weekStart 必须是本周起始日（默认周一）')
    return dateKey(parsed)
  }
  return dateKey(startOfWeek(nowDate, weekStartsOn))
}

function resolveReportMode(payload, fallback = null) {
  const mode = trimText(payload.mode)
  if (mode === '') {
    if (fallback) return fallback
    fail('INVALID_INPUT', 'mode 必须是 concise 或 detailed')
  }
  if (!['concise', 'detailed'].includes(mode)) fail('INVALID_INPUT', 'mode 必须是 concise 或 detailed')
  return mode
}

function actionGenerateReport(state, payload, ctx) {
  const weekStart = resolveWeekStartKey(state, payload, ctx.now)
  const mode = resolveReportMode(payload, 'concise')
  const existing = state.reports.find((report) => report.weekStart === weekStart) ?? null
  const overwrite = payload.overwrite === true
  const content = buildReportContent(state, weekStart, mode, ctx.now)
  const weekStartDate = parseDateKey(weekStart)
  const weekEnd = lastWorkdayOfWeek(weekStartDate, state.settings?.workdays)
  if (existing && !overwrite) {
    return {
      reportId: existing.id, weekStart, mode: existing.mode, content: existing.content,
      exists: true, reused: true, changed: false,
    }
  }
  if (existing) {
    existing.content = content
    existing.generatedAt = isoOf(ctx.now)
    existing.mode = mode
    existing.lastEditedAt = null
    ctx.event({ kind: 'reportGenerated', details: `重新生成 ${formatRange(weekStartDate, weekEnd, ctx.now)} 周报（${MODE_LABEL[mode]}）` })
    return { reportId: existing.id, weekStart, mode, content, exists: true, reused: false, changed: true }
  }
  const report = {
    id: uid('rp'), weekStart, generatedAt: isoOf(ctx.now), content, lastEditedAt: null, mode,
  }
  state.reports.push(report)
  ctx.event({ kind: 'reportGenerated', details: `生成 ${formatRange(weekStartDate, weekEnd, ctx.now)} 周报（${MODE_LABEL[mode]}）` })
  return { reportId: report.id, weekStart, mode, content, exists: true, reused: false, changed: true }
}

function actionUpdateReport(state, payload, ctx) {
  const report = reportById(state, payload.reportId)
  if (typeof payload.content !== 'string') fail('INVALID_INPUT', 'content 必须是字符串')
  const mode = payload.mode === undefined || payload.mode === null || trimText(payload.mode) === ''
    ? report.mode
    : resolveReportMode(payload)
  report.content = payload.content
  report.mode = mode
  report.lastEditedAt = isoOf(ctx.now)
  ctx.event({ kind: 'reportEdited', details: `编辑 ${formatDay(parseDateKey(report.weekStart), ctx.now)} 周报（${MODE_LABEL[mode]}）` })
  return { reportId: report.id, mode, changed: true }
}

function actionDismissRhythm(state, payload, ctx) {
  const key = requireText(payload.key, 'dismiss key（形如 2026-11-03:afternoon）')
  if (!key.includes(':')) fail('INVALID_INPUT', 'dismiss key 需要形如 2026-11-03:afternoon')
  const today = dateKey(ctx.now)
  const map = state.settings.dismissedRhythms && typeof state.settings.dismissedRhythms === 'object'
    ? state.settings.dismissedRhythms
    : (state.settings.dismissedRhythms = {})
  for (const [entryKey, value] of Object.entries(map)) {
    if (value !== today) delete map[entryKey]
  }
  map[key] = today
  ctx.event({ kind: 'settingsChanged', details: `今日不再提示：${key}` })
  return { key, date: today, dismissed: true, changed: true }
}

const DEFAULT_SILENT_WINDOWS = Object.freeze([Object.freeze(['12:00', '14:00']), Object.freeze(['18:00', '19:00'])])

function validateWorkSlots(value) {
  if (!Array.isArray(value) || value.length === 0) fail('INVALID_INPUT', 'workSlots 至少需要一个工作时段')
  const seen = new Set()
  return value.map((slot, index) => {
    if (typeof slot !== 'object' || slot === null) fail('INVALID_INPUT', `workSlots[${index}] 必须是对象`)
    const key = requireText(slot.key, `workSlots[${index}].key`)
    if (!/^[a-z][a-z0-9_]*$/i.test(key)) fail('INVALID_INPUT', `workSlots[${index}].key 只能包含字母数字下划线`)
    if (seen.has(key)) fail('INVALID_INPUT', `workSlots 的 key 重复：${key}`)
    seen.add(key)
    const label = requireText(slot.label, `workSlots[${index}].label`)
    const start = parseHHMM(slot.start)
    const end = parseHHMM(slot.end)
    if (start === null || end === null) fail('INVALID_INPUT', `workSlots[${index}] 的 start/end 必须是 HH:MM`)
    if (start >= end) fail('INVALID_INPUT', `workSlots[${index}] 的 start 必须早于 end`)
    return { key, label, start: trimText(slot.start), end: trimText(slot.end) }
  })
}

function validateSilentWindows(value) {
  if (!Array.isArray(value)) fail('INVALID_INPUT', 'silentWindows 必须是数组')
  return value.map((window, index) => {
    if (!Array.isArray(window) || window.length !== 2) fail('INVALID_INPUT', `silentWindows[${index}] 必须是 [start, end]`)
    const start = parseHHMM(window[0])
    const end = parseHHMM(window[1])
    if (start === null || end === null) fail('INVALID_INPUT', `silentWindows[${index}] 必须是 HH:MM`)
    if (start >= end) fail('INVALID_INPUT', `silentWindows[${index}] 的 start 必须早于 end`)
    return [trimText(window[0]), trimText(window[1])]
  })
}

function validateHHMMSetting(value, label) {
  if (parseHHMM(value) === null) fail('INVALID_INPUT', `${label} 必须是 HH:MM`)
  return trimText(value)
}

function actionUpdateSettings(state, payload, ctx) {
  const patch = payload.patch
  if (typeof patch !== 'object' || patch === null || Array.isArray(patch)) {
    fail('INVALID_INPUT', 'patch 必须是对象')
  }
  const settings = state.settings
  const changed = []
  for (const key of Object.keys(patch)) {
    const value = patch[key]
    switch (key) {
      case 'workSlots':
        settings.workSlots = validateWorkSlots(value)
        changed.push('工作时段')
        break
      case 'silentWindows':
        settings.silentWindows = validateSilentWindows(value)
        changed.push('静默窗')
        break
      case 'handoffTime':
        settings.handoffTime = validateHHMMSetting(value, 'handoffTime')
        changed.push('日终交接时间')
        break
      case 'weeklyDraftTime':
        settings.weeklyDraftTime = validateHHMMSetting(value, 'weeklyDraftTime')
        changed.push('周报草稿时间')
        break
      case 'weeklyMeetingTime':
        settings.weeklyMeetingTime = validateHHMMSetting(value, 'weeklyMeetingTime')
        changed.push('周会时间')
        break
      case 'inheritDesignLink': {
        if (typeof value !== 'boolean') fail('INVALID_INPUT', 'inheritDesignLink 必须是布尔')
        settings.inheritDesignLink = value
        changed.push(value ? '设计稿链接继承（开）' : '设计稿链接继承（关）')
        break
      }
      case 'syncIntervalMinutes': {
        const minutes = normalizeSyncIntervalMinutes(value)
        if (minutes === null) {
          fail('INVALID_INPUT', `syncIntervalMinutes 必须是 ${SYNC_INTERVAL_MINUTES_MIN}-${SYNC_INTERVAL_MINUTES_MAX} 的整数（分钟）`)
        }
        settings.syncIntervalMinutes = minutes
        changed.push('同步间隔')
        break
      }
      case 'evidencePolicy': {
        const policy = normalizeEvidencePolicy(value)
        settings.evidencePolicy = policy
        changed.push(`证据策略（${evidencePolicyText(policy)}）`)
        break
      }
      case 'unlockPolicy': {
        settings.unlockPolicy = normalizeUnlockPolicy(value)
        changed.push(`解锁策略（${settings.unlockPolicy === 'parallel' ? '并行' : '线性'}）`)
        break
      }
      case 'weekStartsOn': {
        const day = Number(value)
        if (!Number.isInteger(day) || day < 1 || day > 7) fail('INVALID_INPUT', 'weekStartsOn 必须是 1-7（ISO 周几）')
        settings.weekStartsOn = day
        changed.push('周起始日')
        break
      }
      case 'workdays': {
        if (!Array.isArray(value) || value.length === 0) fail('INVALID_INPUT', 'workdays 至少需要一个工作日')
        const days = [...new Set(value.map((item) => Number(item)))].sort((a, b) => a - b)
        if (days.some((day) => !Number.isInteger(day) || day < 1 || day > 7)) {
          fail('INVALID_INPUT', 'workdays 必须是 1-7（ISO 周几）')
        }
        settings.workdays = days
        changed.push('工作日')
        break
      }
      case 'dataFile':
        fail('INVALID_INPUT', 'dataFile 由宿主决定（config.dataDir），不能通过设置修改')
        break
      case 'dismissedRhythms':
        fail('INVALID_INPUT', 'dismissedRhythms 请通过 dismissRhythm 动作维护')
        break
      default:
        fail('INVALID_INPUT', `不支持的设置项：${key}`)
    }
  }
  if (changed.length === 0) return { changed: false, keys: [] }
  ctx.event({ kind: 'settingsChanged', details: `更新设置：${changed.join('、')}` })
  return { changed: true, keys: changed }
}

function actionSeedDemo(state, payload, ctx) {
  if (state.businessLines.length > 0 || state.projects.length > 0 || state.nodes.length > 0) {
    fail('INVALID_STATE', '已有数据，不能载入示例数据；请先清空数据或导入备份')
  }
  const demo = createDemoState(ctx.now, state.settings?.dataFile ?? '')
  const userSettings = clone(state.settings ?? {})
  state.settings = { ...demo.settings, ...userSettings, dataFile: state.settings?.dataFile ?? demo.settings.dataFile }
  state.businessLines = demo.businessLines
  state.projects = demo.projects
  state.flows = demo.flows
  state.nodes = demo.nodes
  state.dependencies = demo.dependencies
  state.links = demo.links
  state.events = demo.events
  state.handoffs = demo.handoffs
  state.reports = demo.reports
  ctx.touch()
  return {
    businessLines: demo.businessLines.length,
    projects: demo.projects.length,
    flows: demo.flows.length,
    nodes: demo.nodes.length,
    events: demo.events.length,
    changed: true,
  }
}

function actionResetData(state, payload, ctx) {
  if (payload.confirm !== 'RESET') fail('INVALID_INPUT', '危险操作需要二次确认：confirm 必须为 "RESET"')
  const dataFile = state.settings?.dataFile ?? ''
  const empty = createEmptyState(dataFile)
  empty.settings = { ...defaultSettings(dataFile), ...clone(state.settings ?? {}), dataFile, dismissedRhythms: {} }
  state.settings = empty.settings
  state.businessLines = empty.businessLines
  state.projects = empty.projects
  state.flows = empty.flows
  state.nodes = empty.nodes
  state.dependencies = empty.dependencies
  state.links = empty.links
  state.events = empty.events
  state.handoffs = empty.handoffs
  state.reports = empty.reports
  ctx.touch()
  return { reset: true, changed: true }
}

/* ------------------------------------------------------------------ *
 * 只读 action（agent tool 用）
 * ------------------------------------------------------------------ */

function actionOverview(state, payload, ctx) {
  const derived = computeDerived(state, ctx.now)
  const projects = state.projects.map((project) => {
    const info = derived.projects[project.id] ?? {}
    const line = findLine(state, project.businessLineId)
    return {
      id: project.id,
      title: project.title,
      status: project.status,
      businessLineId: project.businessLineId,
      businessLineName: line?.name ?? '',
      currentCode: info.currentCode ?? '',
      currentStage: info.currentStage ?? '',
      activeNodeId: info.activeNodeId ?? null,
      actionable: info.actionable ?? 0,
      waiting: info.waiting ?? 0,
      completed: info.completed ?? 0,
      total: info.total ?? 0,
      progress: info.progress ?? 0,
      needsAttention: info.needsAttention ?? false,
      dueAt: project.dueAt ?? null,
    }
  })
  return {
    now: derived.now,
    today: derived.todayKey,
    counts: derived.counts,
    focus: derived.focus,
    weekly: derived.weekly,
    todayView: derived.today,
    projects,
  }
}

function actionToday(state, payload, ctx) {
  const derived = computeDerived(state, ctx.now)
  return {
    now: derived.now,
    date: derived.todayKey,
    focus: derived.focus,
    counts: derived.counts,
    recommended: derived.today.recommended,
    followUps: derived.today.followUps,
    upcoming: derived.today.upcoming,
    handoffContext: derived.today.handoffContext,
  }
}

function actionListProjects(state, payload, ctx) {
  const derived = computeDerived(state, ctx.now)
  const statusFilter = trimText(payload.status)
  const nodeStatuses = new Set(Object.keys(STATUS_LABEL))
  if (statusFilter !== '' && statusFilter !== 'active' && statusFilter !== 'archived' && !nodeStatuses.has(statusFilter)) {
    fail('INVALID_INPUT', `未知 status 过滤值：${statusFilter}（可用：active / archived / ${[...nodeStatuses].join(' / ')}）`)
  }
  const matchedProjects = statusFilter === ''
    ? state.projects
    : state.projects.filter((project) => {
      if (statusFilter === 'active' || statusFilter === 'archived') return project.status === statusFilter
      return state.nodes.some((node) => node.projectId === project.id && node.status === statusFilter)
    })
  return {
    projects: matchedProjects.map((project) => {
      const line = findLine(state, project.businessLineId)
      const info = derived.projects[project.id] ?? {}
      return {
        projectId: project.id,
        title: project.title,
        status: project.status,
        businessLineId: project.businessLineId,
        businessLineName: line?.name ?? '',
        dueAt: project.dueAt ?? null,
        createdAt: project.createdAt ?? null,
        currentCode: info.currentCode ?? '',
        currentStage: info.currentStage ?? '',
        activeNodeId: info.activeNodeId ?? null,
        actionable: info.actionable ?? 0,
        waiting: info.waiting ?? 0,
        completed: info.completed ?? 0,
        total: info.total ?? 0,
        progress: info.progress ?? 0,
        needsAttention: info.needsAttention ?? false,
        nextDueAt: info.nextDueAt ?? null,
      }
    }),
  }
}

/* ------------------------------------------------------------------ *
 * Action 注册表
 * ------------------------------------------------------------------ */

const ACTIONS = new Map([
  // 业务线
  ['createLine', actionCreateLine], ['renameLine', actionRenameLine],
  ['deleteLine', actionDeleteLine], ['reorderLine', actionReorderLine],
  // 项目
  ['createProject', actionCreateProject], ['updateProject', actionUpdateProject],
  ['archiveProject', actionArchiveProject], ['deleteProject', actionDeleteProject],
  ['addFlow', actionAddFlow], ['appendTemplate', actionAppendTemplate],
  ['createProjectFromNodes', actionCreateProjectFromNodes],
  // 节点
  ['startNode', actionStartNode], ['completeNode', actionCompleteNode],
  ['waitNode', actionWaitNode], ['blockNode', actionBlockNode],
  ['skipNode', actionSkipNode], ['reopenNode', actionReopenNode],
  ['rejectApproval', actionRejectApproval], ['approve', actionApprove],
  ['setNodeSchedule', actionSetNodeSchedule], ['setNodeNotes', actionSetNodeNotes],
  ['addNote', actionAddNote], ['addNode', actionAddNode],
  ['removeNode', actionRemoveNode], ['reorderNode', actionReorderNode],
  // 链接
  ['addLink', actionAddLink], ['removeLink', actionRemoveLink],
  // 交接 / 周报 / 设置 / 维护
  ['saveHandoff', actionSaveHandoff], ['generateReport', actionGenerateReport],
  ['updateReport', actionUpdateReport], ['dismissRhythm', actionDismissRhythm],
  ['updateSettings', actionUpdateSettings], ['seedDemo', actionSeedDemo],
  ['resetData', actionResetData],
  // 只读
  ['overview', actionOverview], ['today', actionToday], ['listProjects', actionListProjects],
])

/* ------------------------------------------------------------------ *
 * 派生视图（契约 §3）
 * ------------------------------------------------------------------ */

/** 节点卡片（扁平可渲染，字段名不能改，client 直接渲染）。 */
function makeNodeCard(state, node, nowDate, reason = null) {
  const project = findProject(state, node.projectId)
  const flow = findFlow(state, node.flowId)
  const line = project ? findLine(state, project.businessLineId) : null
  const links = state.links.filter((link) => link.nodeId === node.id)
  const card = {
    nodeId: node.id,
    code: node.code,
    title: node.title,
    status: node.status,
    projectId: node.projectId,
    projectTitle: project?.title ?? '',
    businessLineId: project?.businessLineId ?? null,
    businessLineName: line?.name ?? '',
    flowId: node.flowId,
    flowName: flow?.name ?? '',
    dueAt: node.dueAt ?? null,
    followUpAt: node.followUpAt ?? null,
    // 计划时间（追加模板按 startAt + 阶段偏移自动填；客户端用于时间线/甘特展示）
    plannedAt: node.plannedAt ?? null,
    completedAt: node.completedAt ?? null,
    round: node.round ?? 1,
    assigneeRole: node.assigneeRole ?? '',
    daysLeft: node.dueAt ? daysLeft(node.dueAt, nowDate) : null,
    approvals: { ...(node.approvals ?? {}) },
    // 节点模型 v2：客户端可直接按 waitingKind 区分「等确认 / 等外部」；老节点为 null。
    waitingKind: node.waitingKind ?? null,
    linkCount: links.length,
    hasDesignLink: links.some((link) => link.kind === 'design'),
  }
  if (reason) card.reason = reason
  return card
}

function priorityReason(node, nowDate) {
  if (node.dueAt) {
    const dueTime = Date.parse(node.dueAt)
    if (Number.isFinite(dueTime) && dueTime < nowDate.getTime()) return 'overdue'
    const left = daysLeft(node.dueAt, nowDate)
    if (left !== null && left <= 2) return 'dueSoon'
  }
  if (node.status === 'active') return 'active'
  if (node.status === 'revision') return 'revision'
  return 'ready'
}

function compareNullableTime(a, b) {
  const ta = a ? Date.parse(a) : Number.POSITIVE_INFINITY
  const tb = b ? Date.parse(b) : Number.POSITIVE_INFINITY
  return (Number.isFinite(ta) ? ta : Number.POSITIVE_INFINITY) - (Number.isFinite(tb) ? tb : Number.POSITIVE_INFINITY)
}

/** 工作节奏（PRD §6）：period / label / silent / inWorkHours / prompt。 */
export function computeFocus(state, nowDate, counts, todayKey = dateKey(nowDate)) {
  const settings = state.settings ?? defaultSettings()
  const workdays = (Array.isArray(settings.workdays) ? settings.workdays : [1, 2, 3, 4, 5]).map(Number)
  const weekday = isoWeekday(nowDate)
  const minutes = minutesSinceMidnight(nowDate)
  let period = 'offHours'
  let label = '非工作时段'
  let inWorkHours = false
  let silent = false
  if (!workdays.includes(weekday)) {
    period = 'weekend'
    label = '周末'
    silent = true
  } else {
    const slots = Array.isArray(settings.workSlots) ? settings.workSlots : []
    const slot = slots.find((item) => {
      const start = parseHHMM(item.start)
      const end = parseHHMM(item.end)
      return start !== null && end !== null && minutes >= start && minutes < end
    })
    if (slot) {
      period = slot.key
      label = slot.label
      inWorkHours = true
      silent = false
    } else {
      const windows = Array.isArray(settings.silentWindows) ? settings.silentWindows : DEFAULT_SILENT_WINDOWS
      const index = windows.findIndex((window) => {
        if (!Array.isArray(window) || window.length < 2) return false
        const start = parseHHMM(window[0])
        const end = parseHHMM(window[1])
        return start !== null && end !== null && minutes >= start && minutes < end
      })
      if (index >= 0) {
        period = index === 0 ? 'noonBreak' : 'eveningGap'
        label = index === 0 ? '午间静默' : '傍晚静默'
        silent = true
      } else {
        period = 'offHours'
        label = '非工作时段'
        silent = true
      }
    }
  }
  const dismissed = settings.dismissedRhythms?.[`${todayKey}:${period}`] === todayKey
  const actionable = counts?.actionable ?? 0
  const follow = (counts?.waiting ?? 0) + (counts?.blocked ?? 0)
  let prompt = null
  if (inWorkHours && !silent && !dismissed && actionable + follow > 0) {
    const titles = { morning: '上午优先任务', afternoon: '下午优先任务', evening: '晚间收尾任务' }
    prompt = {
      title: titles[period] ?? '今日优先任务',
      body: `${actionable} 个可推进节点，${follow} 个待跟进`,
      cta: '打开今日',
    }
  }
  return { period, label, silent, inWorkHours, prompt }
}

/** 周信息（契约 §3 weekly）。 */
export function computeWeekly(state, nowDate) {
  const settings = state.settings ?? defaultSettings()
  const weekStartsOn = Number(settings.weekStartsOn) || 1
  const weekStart = startOfWeek(nowDate, weekStartsOn)
  const weekEnd = lastWorkdayOfWeek(weekStart, settings.workdays) ?? addDays(weekStart, 4)
  const weekStartKey = dateKey(weekStart)
  const report = state.reports.find((item) => item.weekStart === weekStartKey) ?? null
  const days = daysOfWeek(weekStart)
  const friday = days.find((day) => isoWeekday(day) === 5) ?? weekEnd
  const draftAt = timeOnDay(friday, settings.weeklyDraftTime ?? '12:05') ?? timeOnDay(friday, '12:05')
  const due = Boolean(draftAt && nowDate.getTime() >= draftAt.getTime())
  let next = draftAt
  while (next && next.getTime() <= nowDate.getTime()) next = addDays(next, 7)
  return {
    weekStart: weekStartKey,
    weekEnd: dateKey(weekEnd),
    reportId: report?.id ?? null,
    exists: Boolean(report),
    shouldGenerate: Boolean(due && !report),
    nextGenerateAt: isoOf(next),
  }
}

/**
 * 计算 derived（契约 §3）。注意：契约 §3 里 `today` 出现两次（日期字符串 + 今日对象），
 * 这里按 §7.3 的用法把它做成对象；日期键放在 `todayKey`（客户端也可从 `now` 推导）。
 */
export function computeDerived(state, now) {
  const nowDate = toDate(now) ?? new Date()
  const settings = state.settings ?? defaultSettings()
  const todayKey = dateKey(nowDate)
  const weekStart = startOfWeek(nowDate, Number(settings.weekStartsOn) || 1)
  const weekStartKey = dateKey(weekStart)
  const activeProjectIds = new Set(state.projects.filter((project) => project.status !== 'archived').map((project) => project.id))
  const activeNodes = state.nodes.filter((node) => activeProjectIds.has(node.projectId))
  const orderIndex = nodeOrderIndex(state)

  const counts = {
    actionable: 0, waiting: 0, blocked: 0, revision: 0,
    overdue: 0, activeProjects: 0, completedThisWeek: 0,
    // 节点模型 v2：等待细分（waiting + blocked 里按 waitingKind 计数；waiting 总数语义不变）
    waitingApproval: 0, waitingExternal: 0,
  }
  for (const node of activeNodes) {
    if (ACTIONABLE_STATUS.has(node.status)) counts.actionable += 1
    if (node.status === 'waiting') counts.waiting += 1
    if (node.status === 'blocked') counts.blocked += 1
    if (node.status === 'revision') counts.revision += 1
    if (FOLLOW_STATUS.has(node.status)) {
      if (node.waitingKind === 'approval') counts.waitingApproval += 1
      else if (node.waitingKind === 'external') counts.waitingExternal += 1
    }
    if (node.dueAt && !['completed', 'skipped', 'locked'].includes(node.status)) {
      const dueTime = Date.parse(node.dueAt)
      if (Number.isFinite(dueTime) && dueTime < nowDate.getTime()) counts.overdue += 1
    }
    if (node.status === 'completed' && node.completedAt) {
      const doneTime = Date.parse(node.completedAt)
      const startTime = weekStart.getTime()
      const endTime = addDays(weekStart, 7).getTime()
      if (Number.isFinite(doneTime) && doneTime >= startTime && doneTime < endTime) counts.completedThisWeek += 1
    }
  }
  counts.activeProjects = state.projects.filter((project) => project.status === 'active').length

  // 今日推荐：逾期 / 截止近 / 进行中 / 待修改 / 待开始，最多 5 个
  const recommendedRanked = []
  const followUpsRanked = []
  for (const node of activeNodes) {
    if (ACTIONABLE_STATUS.has(node.status)) {
      const reason = priorityReason(node, nowDate)
      recommendedRanked.push({
        node, reason,
        score: PRIORITY_SCORE[reason] ?? 9,
        dueTime: node.dueAt ? Date.parse(node.dueAt) : Number.POSITIVE_INFINITY,
        order: orderIndex.get(node.id) ?? 999_999,
      })
    }
    if (FOLLOW_STATUS.has(node.status)) {
      const expired = Boolean(node.followUpAt && Date.parse(node.followUpAt) < nowDate.getTime())
      followUpsRanked.push({
        node,
        reason: expired ? 'overdue' : 'followUp',
        expired,
        followTime: node.followUpAt ? Date.parse(node.followUpAt) : Number.POSITIVE_INFINITY,
        order: orderIndex.get(node.id) ?? 999_999,
      })
    }
  }
  recommendedRanked.sort((a, b) => a.score - b.score
    || (a.dueTime || Number.POSITIVE_INFINITY) - (b.dueTime || Number.POSITIVE_INFINITY)
    || a.order - b.order)
  followUpsRanked.sort((a, b) => Number(b.expired) - Number(a.expired)
    || (a.followTime || Number.POSITIVE_INFINITY) - (b.followTime || Number.POSITIVE_INFINITY)
    || a.order - b.order)
  const recommended = recommendedRanked.slice(0, 5).map((item) => makeNodeCard(state, item.node, nowDate, item.reason))
  const followUps = followUpsRanked.map((item) => makeNodeCard(state, item.node, nowDate, item.reason))
  // 只与「今日推荐」去重：waiting/blocked 节点同时出现在「待跟进」和「近期截止」是合理的两个视角
  const usedIds = new Set(recommended.map((card) => card.nodeId))

  // 近期截止：7 天内（不含已被推荐 / 待跟进覆盖的节点）
  const nowStart = startOfDay(nowDate)
  const horizon = addDays(nowStart, 7)
  const upcoming = activeNodes
    .filter((node) => !usedIds.has(node.id))
    .filter((node) => node.status !== 'completed' && node.status !== 'skipped' && node.status !== 'locked')
    .filter((node) => {
      if (!node.dueAt) return false
      const dueTime = Date.parse(node.dueAt)
      return Number.isFinite(dueTime) && dueTime >= nowDate.getTime() && dueTime <= horizon.getTime()
    })
    .sort((a, b) => compareNullableTime(a.dueAt, b.dueAt))
    .map((node) => makeNodeCard(state, node, nowDate))

  // 上次交接上下文
  const latestHandoff = state.handoffs
    .filter((handoff) => typeof handoff.date === 'string' && handoff.date <= todayKey)
    .sort((a, b) => String(b.date).localeCompare(String(a.date))
      || String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? '')))[0] ?? null
  const handoffContext = latestHandoff
    ? {
      date: latestHandoff.date,
      nextActions: latestHandoff.nextActions ?? '',
      notes: latestHandoff.notes ?? '',
      nodes: (Array.isArray(latestHandoff.nodeIds) ? latestHandoff.nodeIds : [])
        .map((nodeId) => findNode(state, nodeId))
        .filter((node) => node && activeProjectIds.has(node.projectId))
        .map((node) => makeNodeCard(state, node, nowDate)),
      confirmedAt: latestHandoff.confirmedAt ?? null,
    }
    : null

  const focus = computeFocus(state, nowDate, counts, todayKey)
  const weekly = computeWeekly(state, nowDate)

  // 项目派生
  const projects = {}
  for (const project of state.projects) {
    const nodes = projectNodes(state, project.id)
    const total = nodes.length
    const completed = nodes.filter((node) => node.status === 'completed').length
    const actionable = nodes.filter((node) => ACTIONABLE_STATUS.has(node.status)).length
    const waiting = nodes.filter((node) => node.status === 'waiting').length
    const current = nodes.find((node) => !['locked', 'completed', 'skipped'].includes(node.status)) ?? null
    const overdue = nodes.some((node) => {
      if (!node.dueAt || ['completed', 'skipped', 'locked'].includes(node.status)) return false
      const dueTime = Date.parse(node.dueAt)
      return Number.isFinite(dueTime) && dueTime < nowDate.getTime()
    })
    const blockedCount = nodes.filter((node) => node.status === 'blocked').length
    const followDue = nodes.some((node) => FOLLOW_STATUS.has(node.status)
      && node.followUpAt && Date.parse(node.followUpAt) <= nowDate.getTime())
    const nextDueAt = nodes
      .filter((node) => node.dueAt && !['completed', 'skipped'].includes(node.status))
      .map((node) => node.dueAt)
      .sort((a, b) => compareNullableTime(a, b))[0] ?? null
    let currentStage = '尚未开始'
    let currentCode = ''
    if (current) {
      currentStage = current.title
      currentCode = current.code
    } else if (total > 0 && completed === total) {
      currentStage = '全部完成'
    }
    projects[project.id] = {
      currentStage,
      currentCode,
      activeNodeId: current?.id ?? null,
      actionable,
      waiting,
      total,
      completed,
      progress: total > 0 ? Math.round((completed / total) * 100) / 100 : 0,
      needsAttention: blockedCount > 0 || overdue || followDue,
      nextDueAt,
    }
  }

  return {
    now: isoOf(nowDate),
    todayKey,
    counts,
    focus,
    today: { recommended, followUps, upcoming, handoffContext },
    weekly,
    projects,
  }
}

/* ------------------------------------------------------------------ *
 * 周报文本（PRD §7.3）
 * ------------------------------------------------------------------ */

function withinWeek(isoValue, weekStart, nowDate) {
  const time = Date.parse(isoValue ?? '')
  if (!Number.isFinite(time)) return false
  return time >= weekStart.getTime() && time < addDays(weekStart, 7).getTime() && time <= nowDate.getTime()
}

/**
 * 生成周报 Markdown。
 * 结构：`# 本周工作（11月2日—11月6日）` → 每个业务线 `##` → 每个项目 `**项目**`
 * → 完成 / 修改 / 推进中 / 待跟进 / 补充记录。
 * 「完成」只认 completedAt 落在本周且当前状态仍是 completed 的节点，绝不把未完成写成已完成。
 */
export function buildReportContent(state, weekStartKey, mode = 'concise', now = new Date()) {
  const nowDate = toDate(now) ?? new Date()
  const weekStart = parseDateKey(weekStartKey)
  const settings = state.settings ?? defaultSettings()
  const weekEnd = lastWorkdayOfWeek(weekStart, settings.workdays) ?? addDays(weekStart, 4)
  const detailed = mode === 'detailed'
  const lines = []
  lines.push(`# 本周工作（${formatRange(weekStart, weekEnd, nowDate)}）`)

  const events = state.events.filter((event) => withinWeek(event.timestamp, weekStart, nowDate))
  const businessLines = [...state.businessLines].sort((a, b) => (Number(a.sortOrder) || 0) - (Number(b.sortOrder) || 0))
  const projects = [...state.projects].sort((a, b) => String(a.createdAt ?? '').localeCompare(String(b.createdAt ?? '')))
  let sectionCount = 0

  for (const line of businessLines) {
    const projectBlocks = []
    const lineProjects = projects.filter((project) => project.businessLineId === line.id)
    for (const project of lineProjects) {
      const nodes = projectNodes(state, project.id)
      const projectEvents = events.filter((event) => event.projectId === project.id)
      const done = nodes.filter((node) => node.status === 'completed' && node.completedAt
        && withinWeek(node.completedAt, weekStart, nowDate))
      const revised = [...new Set(projectEvents
        .filter((event) => event.kind === 'revision' || event.kind === 'approvalRejected')
        .map((event) => event.details))]
      const current = nodes.filter((node) => node.status === 'active' || node.status === 'revision')
      const waiting = nodes.filter((node) => node.status === 'waiting' || node.status === 'blocked')
      const manual = projectEvents.filter((event) => event.kind === 'manualNote').map((event) => event.details)
      if (done.length === 0 && revised.length === 0 && current.length === 0
        && waiting.length === 0 && manual.length === 0) continue

      if (!detailed) {
        const facts = []
        if (done.length > 0) facts.push(`完成：${done.map((node) => node.title).join('、')}`)
        if (revised.length > 0) facts.push(`修改：${revised.join('；')}`)
        if (current.length > 0) facts.push(`推进中：${current.map((node) => node.title).join('、')}`)
        if (waiting.length > 0) facts.push(`待跟进：${waiting.map((node) => node.title).join('、')}`)
        if (manual.length > 0) facts.push(`补充记录：${manual.join('；')}`)
        projectBlocks.push(`- **${project.title}**：${facts.join('；')}`)
      } else {
        const blocks = [`### ${project.title}`]
        if (done.length > 0) {
          blocks.push(`- 完成：${done.map((node) => `${node.code} ${node.title}（第 ${node.round ?? 1} 轮）`).join('、')}`)
        }
        if (revised.length > 0) blocks.push(`- 修改：${revised.join('；')}`)
        if (current.length > 0) {
          blocks.push(`- 推进中：${current.map((node) => `${node.code} ${node.title}（${STATUS_LABEL[node.status] ?? node.status}）`).join('、')}`)
        }
        if (waiting.length > 0) {
          blocks.push(`- 待跟进：${waiting.map((node) => `${node.code} ${node.title}${node.followUpAt ? `（计划跟进：${formatDateTime(node.followUpAt, nowDate)}）` : ''}`).join('、')}`)
        }
        if (manual.length > 0) blocks.push(`- 补充记录：${manual.join('；')}`)
        projectBlocks.push(blocks.join('\n'))
      }
    }
    if (projectBlocks.length > 0) {
      sectionCount += 1
      lines.push(`\n## ${line.name}`)
      lines.push(projectBlocks.join('\n'))
    }
  }

  if (sectionCount === 0) lines.push('\n本周尚无可生成周报的节点事件。')
  return lines.join('\n')
}

/* ------------------------------------------------------------------ *
 * 示例数据（seedDemo）
 * ------------------------------------------------------------------ */

/**
 * 构造示例数据：3 条业务线 / 4 个项目，覆盖
 * 「设计交付进行中 / 验收等待研发 / 刚创建待评估」；事件全部落在本周内；
 * 有一个节点 followUpAt 已过期（今日跟进可见）。
 */
export function createDemoState(now = new Date(), dataFile = '') {
  const nowDate = toDate(now) ?? new Date()
  const state = createEmptyState(dataFile)
  // 示例数据也显式带上设置默认值（旧数据由 ensureSettingsDefaults 兜底补 5）
  state.settings.syncIntervalMinutes = DEFAULT_SYNC_INTERVAL_MINUTES
  state.settings.evidencePolicy = { kinds: [], minLinks: DEFAULT_EVIDENCE_POLICY.minLinks }
  state.settings.unlockPolicy = DEFAULT_UNLOCK_POLICY
  const weekStart = startOfWeek(nowDate, 1)
  const endTs = nowDate.getTime() - 60_000
  const desired = addMinutes(weekStart, 9 * 60).getTime()
  const startTs = Math.min(
    Math.max(weekStart.getTime() + 60_000, desired),
    Math.max(endTs - 60_000, weekStart.getTime() + 1000),
  )
  const span = Math.max(endTs - startTs, 60_000)
  const TOTAL = 64
  let tickIndex = 0
  function tick() {
    tickIndex += 1
    const ratio = Math.min(tickIndex, TOTAL) / TOTAL
    const raw = startTs + Math.floor(span * ratio)
    // 兜底：示例事件必须落在「本周开始 ~ 现在」之间
    return new Date(Math.max(weekStart.getTime(), Math.min(raw, nowDate.getTime() - 1000)))
  }
  function ev(kind, { projectId = null, flowId = null, nodeId = null, details = '', round = 1, at = null } = {}) {
    const timestamp = isoOf(at ?? tick())
    const event = { id: uid('ev'), projectId, flowId, nodeId, kind, timestamp, details, round }
    state.events.push(event)
    return event
  }
  function complete(node, { at = null, details = null, round = node.round } = {}) {
    const timestamp = at ?? tick()
    node.status = 'completed'
    node.completedAt = isoOf(timestamp)
    node.round = round
    ev('nodeStatus', {
      projectId: node.projectId, flowId: node.flowId, nodeId: node.id,
      details: details ?? `完成「${node.title}」`, round, at: timestamp,
    })
  }
  function addLink(node, title, url, kind = 'design') {
    const timestamp = tick()
    state.links.push({ id: uid('lk'), nodeId: node.id, title, url, kind, createdAt: isoOf(timestamp) })
    ev('linkAdded', {
      projectId: node.projectId, flowId: node.flowId, nodeId: node.id,
      details: `添加${LINK_KIND_LABEL[kind] ?? kind}链接「${title}」`, round: node.round, at: timestamp,
    })
  }
  function project(line, title, dueOffsetDays) {
    const dueDay = addDays(startOfDay(nowDate), dueOffsetDays)
    const dueAt = timeOnDay(dueDay, '18:00')
    const createdAt = tick()
    const item = {
      id: uid('pr'),
      businessLineId: line.id,
      title,
      status: 'active',
      dueAt: isoOf(dueAt),
      createdAt: isoOf(createdAt),
      archivedAt: null,
    }
    state.projects.push(item)
    ev('projectCreated', { projectId: item.id, details: `创建项目「${title}」`, at: createdAt })
    return item
  }
  function addFlow(item, templateId, sortOrder) {
    const template = getTemplate(templateId)
    const flow = {
      id: uid('fl'),
      projectId: item.id,
      templateId: template.id,
      templateVersion: template.version,
      name: template.title,
      sortOrder,
    }
    state.flows.push(flow)
    for (const spec of template.nodes) {
      const roles = Array.isArray(spec.approvalRoles) ? [...spec.approvalRoles] : []
      const approvals = {}
      for (const role of roles) approvals[role] = false
      state.nodes.push({
        id: uid('nd'),
        flowId: flow.id,
        projectId: item.id,
        code: spec.code,
        title: spec.title,
        detail: spec.detail ?? '',
        status: 'locked',
        sortOrder: template.nodes.indexOf(spec),
        assigneeRole: spec.assigneeRole ?? '设计',
        approvalRoles: roles,
        approvals,
        approvalLog: [],
        returnReason: null,
        waitingKind: null,
        evidencePolicy: null,
        plannedAt: null,
        dueAt: null,
        followUpAt: null,
        completedAt: null,
        notes: '',
        round: 1,
      })
    }
    return flow
  }
  const nodeOf = (flow, code) => state.nodes.find((node) => node.flowId === flow.id && node.code === code)

  // 业务线
  const bl1 = { id: uid('bl'), name: '增长推广', sortOrder: 0 }
  const bl2 = { id: uid('bl'), name: '会员中心', sortOrder: 1 }
  const bl3 = { id: uid('bl'), name: '数据看板', sortOrder: 2 }
  state.businessLines = [bl1, bl2, bl3]

  /* ------ 项目 1：活动管理改版（双角色确认第二次退回后重新推进，当前等待产品确认） ------ */
  const p1 = project(bl1, '活动管理改版', 2)
  const p1Flow = addFlow(p1, 'delivery', 0)
  const d1 = (code) => nodeOf(p1Flow, code)
  complete(d1('D01'))
  complete(d1('D02'))
  complete(d1('D03'))
  // 第 1 轮：D04 产品退回，D03 进入 revision
  d1('D04').round = 1
  ev('approvalPassed', {
    projectId: p1.id, flowId: p1Flow.id, nodeId: d1('D04').id,
    details: '设计确认通过「交互确认（设计 & 产品）」', round: 1,
  })
  ev('approvalRejected', {
    projectId: p1.id, flowId: p1Flow.id, nodeId: d1('D04').id,
    details: '产品退回「交互确认（设计 & 产品）」：设计稿 里异常状态没有兜底', round: 1,
  })
  d1('D04').round = 2
  d1('D04').status = 'locked'
  d1('D04').approvals = { design: false, product: false }
  d1('D03').round = 2
  d1('D03').status = 'revision'
  d1('D03').completedAt = null
  ev('revision', {
    projectId: p1.id, flowId: p1Flow.id, nodeId: d1('D03').id, round: 2,
    details: '由「交互确认（设计 & 产品）」退回：「设计稿 搭建交互框架」需要修改（设计稿 里异常状态没有兜底）',
  })
  complete(d1('D03'), { round: 2 })
  addLink(d1('D04'), '设计稿交互框架', 'https://design.example.com/interaction/p1', 'design')
  d1('D04').status = 'waiting'
  d1('D04').waitingKind = 'approval'
  d1('D04').round = 2
  d1('D04').approvals = { design: true, product: false }
  d1('D04').followUpAt = isoOf(addMinutes(nowDate, -180)); // 已过期：今日跟进里能看到
  d1('D04').dueAt = isoOf(addMinutes(nowDate, -180))
  d1('D04').plannedAt = d1('D04').dueAt
  ev('approvalPassed', {
    projectId: p1.id, flowId: p1Flow.id, nodeId: d1('D04').id, round: 2,
    details: '设计确认通过「交互确认（设计 & 产品）」（第 2 轮）',
  })

  /* ------ 项目 2：权益页改版（设计交付完成，验收等待研发提交） ------ */
  const p2 = project(bl2, '权益页改版', 5)
  const p2Delivery = addFlow(p2, 'delivery', 0)
  const p2Acceptance = addFlow(p2, 'acceptance', 1)
  ev('flowAdded', { projectId: p2.id, flowId: p2Acceptance.id, details: '添加流程「验收流程」' })
  const dd = (code) => nodeOf(p2Delivery, code)
  complete(dd('D01'))
  complete(dd('D02'))
  complete(dd('D03'))
  addLink(dd('D04'), '设计稿交互框架', 'https://design.example.com/interaction/p2', 'design')
  dd('D04').approvals = { design: true, product: true }
  ev('approvalPassed', { projectId: p2.id, flowId: p2Delivery.id, nodeId: dd('D04').id, details: '设计确认通过「交互确认（设计 & 产品）」' })
  ev('approvalPassed', { projectId: p2.id, flowId: p2Delivery.id, nodeId: dd('D04').id, details: '产品确认通过「交互确认（设计 & 产品）」' })
  complete(dd('D04'))
  complete(dd('D05'))
  addLink(dd('D06'), '设计稿 最终确认稿', 'https://design.example.com/interaction/p2-final', 'design')
  dd('D06').approvals = { design: true, product: true }
  ev('approvalPassed', { projectId: p2.id, flowId: p2Delivery.id, nodeId: dd('D06').id, details: '设计确认通过「最终设计确认（设计 & 产品）」' })
  ev('approvalPassed', { projectId: p2.id, flowId: p2Delivery.id, nodeId: dd('D06').id, details: '产品确认通过「最终设计确认（设计 & 产品）」' })
  complete(dd('D06'))
  addLink(dd('D07'), '设计稿 代码分支', 'https://design.example.com/branch/p2', 'design')
  complete(dd('D07'))
  const aa = (code) => nodeOf(p2Acceptance, code)
  aa('A01').status = 'ready'
  aa('A01').round = 1
  complete(aa('A01'))
  aa('A02').status = 'waiting'
  aa('A02').waitingKind = 'external'
  aa('A02').followUpAt = isoOf(timeOnDay(addDays(startOfDay(nowDate), 1), '15:00'))
  aa('A02').dueAt = isoOf(timeOnDay(addDays(startOfDay(nowDate), 1), '18:00'))
  aa('A02').plannedAt = aa('A02').dueAt
  ev('unlocked', { projectId: p2.id, flowId: p2Acceptance.id, nodeId: aa('A02').id, details: '「研发提交」已解锁' })

  /* ------ 项目 3：数据看板重构（刚创建，D01 待评估） ------ */
  const p3 = project(bl3, '数据看板重构', 7)
  const p3Flow = addFlow(p3, 'delivery', 0)
  const p3d01 = nodeOf(p3Flow, 'D01')
  p3d01.status = 'ready'
  ev('manualNote', {
    projectId: p3.id, flowId: p3Flow.id, nodeId: p3d01.id,
    details: '刚创建，等产品排期做需求评估', round: 1,
  })

  /* ------ 项目 4：会员中心二期素材库（设计交付进行中：D05 细化设计） ------ */
  const p4 = project(bl2, '会员中心二期素材库', 1)
  const p4Flow = addFlow(p4, 'delivery', 0)
  const e4 = (code) => nodeOf(p4Flow, code)
  complete(e4('D01'), { details: '完成「需求接收」（与运营对齐二期素材范围）' })
  complete(e4('D02'))
  complete(e4('D03'))
  addLink(e4('D04'), '设计稿交互框架', 'https://design.example.com/interaction/p4', 'design')
  e4('D04').approvals = { design: true, product: true }
  ev('approvalPassed', { projectId: p4.id, flowId: p4Flow.id, nodeId: e4('D04').id, details: '设计确认通过「交互确认（设计 & 产品）」' })
  ev('approvalPassed', { projectId: p4.id, flowId: p4Flow.id, nodeId: e4('D04').id, details: '产品确认通过「交互确认（设计 & 产品）」' })
  complete(e4('D04'))
  e4('D05').status = 'active'
  e4('D05').round = 1
  e4('D05').plannedAt = isoOf(timeOnDay(addDays(startOfDay(nowDate), 2), '18:00'))
  ev('nodeStatus', { projectId: p4.id, flowId: p4Flow.id, nodeId: e4('D05').id, details: '开始「Figma 细化设计」' })
  ev('manualNote', {
    projectId: p4.id, flowId: p4Flow.id, nodeId: e4('D05').id,
    details: '与运营确认二期素材清单，新增 2 个激励位', round: 1,
  })
  addLink(e4('D05'), 'Figma 设计稿', 'https://figma.example.com/file/p4', 'figma')

  // 依赖
  for (const item of state.projects) rebuildDependencies(state, item.id)

  // 昨天的日终交接（今日视图展示上次上下文）
  state.handoffs.push({
    id: uid('ho'),
    date: dateKey(addDays(nowDate, -1)),
    nodeIds: [d1('D04').id, e4('D05').id],
    nextActions: '先确认 D04 交互细节，再继续 D05 的 Figma 细化',
    notes: '产品对异常状态还有两个疑问，设计稿 需要补状态页',
    confirmedAt: isoOf(addMinutes(nowDate, -11 * 60)),
    createdAt: isoOf(addMinutes(nowDate, -12 * 60)),
    source: 'user',
  })

  ev('seeded', { details: '载入示例数据（3 条业务线 / 4 个项目）' })
  return state
}

/* ------------------------------------------------------------------ *
 * 自动周报草稿（周五 12:05 之后读 state 补齐）
 * ------------------------------------------------------------------ */

function ensureWeeklyDraft(state, nowDate) {
  const weekly = computeWeekly(state, nowDate)
  if (!weekly.shouldGenerate) return false
  const weekStartDate = parseDateKey(weekly.weekStart)
  const weekEndDate = parseDateKey(weekly.weekEnd)
  const content = buildReportContent(state, weekly.weekStart, 'concise', nowDate)
  state.reports.push({
    id: uid('rp'),
    weekStart: weekly.weekStart,
    generatedAt: isoOf(nowDate),
    content,
    lastEditedAt: null,
    mode: 'concise',
  })
  pushEvent(state, nowDate, {
    kind: 'reportGenerated',
    details: `自动补齐 ${formatRange(weekStartDate, weekEndDate, nowDate)} 周报草稿（简洁）`,
  })
  return true
}

/* ------------------------------------------------------------------ *
 * 引擎
 * ------------------------------------------------------------------ */

/**
 * 创建引擎（状态机 + 派生 + 周报 + 持久化）。
 * @param {{ dataDir?: string, dataFile?: string, now?: () => Date, logger?: any }} options
 */
export function createEngine(options = {}) {
  const clock = typeof options.now === 'function' ? options.now : () => new Date()
  const logger = options.logger
  const store = createStore({
    dataDir: options.dataDir,
    dataFile: options.dataFile,
    logger,
    now: clock,
  })

  function currentTime() {
    const date = clock()
    return toDate(date) ?? new Date()
  }

  /** 读 + 自动补周报草稿；有写入时 revision +1。 */
  function snapshot() {
    const { state: cached, revision } = store.load()
    const state = ensureSettingsDefaults(clone(cached))
    const nowDate = currentTime()
    const auto = ensureWeeklyDraft(state, nowDate)
    let nextRevision = revision
    let nextState = state
    if (auto) {
      const saved = store.save(state, revision + 1)
      nextRevision = saved.revision
      nextState = saved.state
    }
    return { revision: nextRevision, state: nextState, derived: computeDerived(nextState, nowDate) }
  }

  /**
   * 执行 action（client 与 agent tool 共用）。
   * @param {string} action
   * @param {object} payload
   * @param {{ actor?: 'user'|'ui'|'agent'|string }} [options] 操作人来源（写进事件的 actor；
   *   HTTP 路由默认 'ui'，agent 工具传 'agent'，缺省 'user'）。
   * @returns {{ ok: boolean, revision: number, state: any, derived: any, result: any }}
   */
  function dispatch(action, payload, options = {}) {
    const name = trimText(action)
    const handler = ACTIONS.get(name)
    if (!handler) fail('INVALID_INPUT', `未知动作：${name || '(空)'}`)
    const { state: cached, revision } = store.load()
    const state = ensureSettingsDefaults(clone(cached))
    const nowDate = currentTime()
    const auto = ensureWeeklyDraft(state, nowDate)
    const actor = trimText(options?.actor) || 'user'
    const ctx = makeContext(state, nowDate, { dataFile: store.dataFile, revision, actor })
    const result = handler(state, isPlainRecord(payload) ? payload : {}, ctx)
    const mutated = ctx.touched || auto
    if (!mutated) {
      return { ok: true, revision, state, derived: computeDerived(state, nowDate), result }
    }
    const saved = store.save(state, revision + 1)
    return { ok: true, revision: saved.revision, state: saved.state, derived: computeDerived(saved.state, nowDate), result }
  }

  function exportBackup() {
    snapshot() // 确保周报草稿已补齐（导出与 state 一致）
    return store.exportPayload()
  }

  function importBackup(payload) {
    const saved = store.importPayload(payload)
    const nowDate = currentTime()
    // 导入的备份可能是旧版本：读出来先补齐 settings / 节点新字段默认值（不改历史事件）。
    const state = ensureSettingsDefaults(clone(saved.state))
    // 导入后如已到周五补草稿时点，仍会补一份草稿（并落盘）
    if (ensureWeeklyDraft(state, nowDate)) {
      const persisted = store.save(state, saved.revision + 1)
      return { revision: persisted.revision, state: persisted.state, derived: computeDerived(persisted.state, nowDate) }
    }
    return { revision: saved.revision, state, derived: computeDerived(state, nowDate) }
  }

  return {
    get store() { return store },
    get dataDir() { return store.dataDir },
    get dataFile() { return store.dataFile },
    now: currentTime,
    dispatch,
    snapshot,
    exportBackup,
    importBackup,
    /** 只读概览（agent tool 的 overview）。 */
    overview() {
      const { state, revision, derived } = snapshot()
      return { revision, state, derived }
    },
  }
}

function isPlainRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/* ------------------------------------------------------------------ *
 * agent tool 摘要
 * ------------------------------------------------------------------ */

/** 给 agent tool 的中文摘要（result 的人类可读版）。 */
export function summarizeResult(action, payload = {}, result = {}) {
  if (!result || typeof result !== 'object') return `已执行 ${action}`
  switch (action) {
    case 'createLine': return `已创建业务线「${result.line?.name ?? ''}」`
    case 'renameLine': return `已重命名业务线为「${result.name ?? ''}」`
    case 'deleteLine': return '业务线已删除'
    case 'reorderLine': return '业务线顺序已调整'
    case 'createProject': return `已创建项目，含 ${result.flowIds?.length ?? 0} 个流程 / ${result.nodeIds?.length ?? 0} 个节点`
    case 'updateProject': return result.changed ? '项目已更新' : '项目无变化'
    case 'archiveProject': return result.status === 'archived' ? '项目已归档' : '项目已恢复'
    case 'deleteProject': {
      const deleted = result.deleted ?? {}
      return `已删除项目「${result.title ?? ''}」（${deleted.flows ?? 0} 个流程 / ${deleted.nodes ?? 0} 个节点），备份：${result.backupPath ? '已生成' : '未生成'}`
    }
    case 'addFlow': return '流程已添加'
    case 'appendTemplate':
      return `已追加模板「${result.templateTitle ?? result.templateId ?? ''}」（${result.appended ?? 0} 个节点：${(result.codes ?? []).join('、')}）`
    case 'createProjectFromNodes': {
      const count = result.nodes ?? result.nodeIds?.length ?? 0
      return `已根据提案创建项目「${result.title ?? ''}」，含 ${count} 个节点${result.createdLine ? `（新建业务线）` : ''}`
    }
    case 'startNode': return result.changed === false ? '节点已在进行中' : '节点已开始'
    case 'completeNode': return result.changed === false ? '节点已完成' : '节点已完成'
    case 'waitNode': return result.followUpAt ? `节点进入待确认，计划跟进 ${formatDateTime(result.followUpAt)}` : '节点进入待确认'
    case 'blockNode': return `节点已阻塞：${result.reason ?? ''}`
    case 'skipNode':
      return result.rangeTrimmed ? '节点已跳过（未解锁范围裁剪，不计入完成成果）' : '节点已跳过（不计入完成成果）'
    case 'reopenNode': return `节点已重新打开（第 ${result.round ?? ''} 轮）`
    case 'rejectApproval': return `已退回，目标节点进入待修改（轮次 ${result.round ?? ''}）`
    case 'approve':
      if (result.passed === false) return '确认被退回'
      if (result.completed) return '确认通过，节点已自动完成'
      if (result.already) return '该角色已经确认过'
      if (result.needEvidence || result.needDesignLink) {
        return `确认通过；还差 ${result.needEvidenceCount ?? 1} 条证据链接才能完成`
      }
      return `确认通过；还差${(result.missingRoles ?? []).join('、')}确认`
    case 'setNodeSchedule': return '节点计划时间已更新'
    case 'setNodeNotes': return '节点笔记已保存'
    case 'addNote': return '记录已补充'
    case 'addNode': return `已新增节点（${result.nodeCode ?? result.code ?? ''}）`
    case 'removeNode': return '节点已删除'
    case 'reorderNode': return '节点顺序已调整'
    case 'addLink': return result.completed ? '链接已添加，节点已满足门槛并自动完成' : '链接已添加'
    case 'removeLink': return '链接已移除'
    case 'saveHandoff': return `已保存 ${result.date ?? ''} 的日终交接`
    case 'generateReport': return result.reused ? '该周周报已存在（未覆盖）' : `周报已生成（${MODE_LABEL[result.mode] ?? result.mode}）`
    case 'updateReport': return '周报已保存'
    case 'dismissRhythm': return '今天不再提示该节奏提醒'
    case 'updateSettings': return `设置已更新：${(result.keys ?? []).join('、') || '无变化'}`
    case 'seedDemo': return `已载入示例数据（${result.businessLines} 条业务线 / ${result.projects} 个项目）`
    case 'resetData': return '数据已清空'
    case 'overview': return `当前 ${result.counts?.actionable ?? 0} 个可推进、${(result.counts?.waiting ?? 0) + (result.counts?.blocked ?? 0)} 个待跟进、${result.counts?.activeProjects ?? 0} 个进行中项目`
    case 'today': return `今日推荐 ${result.recommended?.length ?? 0} 个节点，待跟进 ${result.followUps?.length ?? 0} 个`
    case 'listProjects': return `共 ${result.projects?.length ?? 0} 个项目`
    default: return `已执行 ${action}`
  }
}
