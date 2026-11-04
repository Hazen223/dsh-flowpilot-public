/**
 * FlowPilot 宿主半 · agent 工具定义
 *
 * 归属：host-core
 * 用途：
 * - 本地 `defineTool`：本机 desktop profile 的 `node_modules` 里没有 `@deepseek-ai/dsh-tools`
 *   （profile 是 `autoInstallPeers: false`），**裸 import 会让整条插件 failed to import**，
 *   所以这里自带等价实现：参数/输出 schema 直接写标准 JSON Schema，`defineTool` 只做轻量校验后
 *   原样返回普通对象，交给 `ctx.tools.register(def)`（与 dsh-bili-scroll 的做法一致）。
 * - `flowpilot` 工具的参数 schema 与「平铺参数 → payload」映射。
 * 约束：只 import `node:` 内置模块与包内相对模块。
 */

import { ACTION_NAMES, READONLY_ACTIONS } from './domain.js'

/** 工具层 action = engine action + AI 专用 action（AI 契约 §4）。 */
export const AI_TOOL_ACTIONS = Object.freeze(['parsePrd', 'createProjectFromPrd'])
export const TOOL_ACTION_NAMES = Object.freeze([...ACTION_NAMES, ...AI_TOOL_ACTIONS])

/** 轻量 defineTool：校验形状后原样返回（供 ctx.tools.register 使用）。 */
export function defineTool(definition) {
  if (typeof definition !== 'object' || definition === null) {
    throw new Error('defineTool 需要工具定义对象')
  }
  const { name, description } = definition
  if (typeof name !== 'string' || name.trim() === '') throw new Error('defineTool: name 必须是非空字符串')
  if (typeof description !== 'string' || description.trim() === '') {
    throw new Error(`defineTool(${name}): description 必须是非空字符串`)
  }
  const parameters = definition.parameters
  if (typeof parameters !== 'object' || parameters === null || parameters.type !== 'object'
    || typeof parameters.properties !== 'object' || parameters.properties === null) {
    throw new Error(`defineTool(${name}): parameters 必须是标准 JSON Schema（type:"object" + properties）`)
  }
  if (parameters.additionalProperties === undefined) {
    throw new Error(`defineTool(${name}): parameters 需要显式声明 additionalProperties`)
  }
  if (typeof definition.execute !== 'function') {
    throw new Error(`defineTool(${name}): execute 必须是函数`)
  }
  const output = definition.output
  if (typeof output !== 'object' || output === null || typeof output.schema !== 'object'
    || output.schema === null || typeof output.render !== 'function') {
    throw new Error(`defineTool(${name}): output 需要 { schema, render }`)
  }
  return definition
}

/** 平铺参数里可以直接落到 payload 的字段（契约 §5 + AI 契约 §4）。 */
export const FP_PAYLOAD_KEYS = Object.freeze([
  'projectId', 'lineId', 'flowId', 'nodeId', 'linkId', 'reportId',
  'businessLineId', 'title', 'name', 'templateId', 'templateIds',
  'dueAt', 'followUpAt', 'note', 'notes', 'reason', 'comment',
  'role', 'passed', 'url', 'kind', 'weekStart', 'mode', 'content',
  'text', 'date', 'nodeIds', 'nextActions', 'sortOrder', 'assigneeRole',
  'detail', 'afterNodeId', 'beforeNodeId', 'archived', 'overwrite',
  'confirm', 'key', 'patch', 'status',
  // 节点模型 v2：证据策略 / 解锁策略 / 显式节点编号 / 确认人
  'evidencePolicy', 'unlockPolicy', 'code', 'by',
  // 节点包模板追加（appendTemplate）/ 节点计划时间（plannedAt）
  'startAt', 'plannedAt',
  // AI 提案 → 项目（createProjectFromNodes / createProjectFromPrd）
  'businessLineName', 'flowName', 'nodes',
])

function isPlainRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 把 agent 的平铺参数转成 action payload（嵌套 payload 先铺底，平铺字段优先）。 */
export function toPayload(args = {}) {
  const payload = isPlainRecord(args?.payload) ? { ...args.payload } : {}
  for (const key of FP_PAYLOAD_KEYS) {
    const value = args?.[key]
    if (value === undefined || value === null) continue
    payload[key] = value
  }
  // 兼容模型把模板数组写成逗号字符串
  if (typeof payload.templateIds === 'string') {
    payload.templateIds = payload.templateIds.split(',').map((item) => item.trim()).filter(Boolean)
  }
  return payload
}

/** `flowpilot` 工具参数（标准 JSON Schema）。 */
export const FP_TOOL_PARAMETERS = Object.freeze({
  type: 'object',
  properties: {
    action: {
      type: 'string',
      enum: [...TOOL_ACTION_NAMES],
      description: '要执行的动作名。只读：overview / today / listProjects；其余见契约 §4.1。AI：parsePrd（只解析）/ createProjectFromPrd（解析并建项目）；createProjectFromNodes 为底层建项目动作。',
    },
    payload: {
      type: 'object',
      additionalProperties: true,
      description: '可选：直接把 payload 传成对象；与下面的平铺字段合并（平铺字段优先）。',
    },
    projectId: { type: 'string', description: '项目 id（pr_ 开头）。' },
    lineId: { type: 'string', description: '业务线 id（bl_ 开头）。' },
    flowId: { type: 'string', description: '流程 id（fl_ 开头）。' },
    nodeId: { type: 'string', description: '节点 id（nd_ 开头）。' },
    linkId: { type: 'string', description: '链接 id（lk_ 开头）。' },
    reportId: { type: 'string', description: '周报 id（rp_ 开头）。' },
    businessLineId: { type: 'string', description: '新建/移动项目时所属业务线 id。' },
    title: { type: 'string', description: '项目 / 节点 / 链接名称。' },
    status: {
      type: 'string',
      enum: ['locked', 'ready', 'active', 'waiting', 'blocked', 'revision', 'completed', 'skipped', 'archived'],
      description: '只读过滤：listProjects 按项目状态（active/archived）或节点状态筛选。',
    },
    name: { type: 'string', description: '业务线名称（createLine / renameLine）。' },
    templateId: {
      type: 'string',
      enum: ['delivery', 'acceptance', 'experiment'],
      description: '模板 id：addFlow 只接受流程模板 delivery / acceptance；appendTemplate 只接受节点包模板 experiment（实验推进 E01-E04，只能追加到已有流程，不能新建流程）。',
    },
    templateIds: { type: 'array', items: { type: 'string' }, description: '新建项目时的流程模板数组，如 ["delivery","acceptance"]；省略默认 delivery（不支持 experiment）。' },
    startAt: { type: 'string', description: 'appendTemplate：追加模板的起点时间（ISO 8601），默认现在；节点 plannedAt = startAt + 模板阶段偏移天数。' },
    plannedAt: { type: 'string', description: 'setNodeSchedule：节点计划时间（ISO 8601；传 null/空串清除）。appendTemplate 会自动写入。' },
    dueAt: { type: 'string', description: 'ISO 8601 时间或 null：项目交付日期 / 节点计划时间。' },
    followUpAt: { type: 'string', description: 'ISO 8601 时间或 null：等待/阻塞节点的跟进时间。' },
    note: { type: 'string', description: '完成 / 等待节点时的备注（会并入节点笔记）。' },
    notes: { type: 'string', description: '节点笔记全文（setNodeNotes）或交接备注（saveHandoff）。' },
    reason: { type: 'string', description: '阻塞 / 跳过 / 重新打开 / 退回的原因。' },
    comment: { type: 'string', description: '双角色确认的意见（approve 通过 / 退回都记录；退回时必填）。' },
    role: { type: 'string', enum: ['design', 'product'], description: 'approve 时确认方角色：design=设计，product=产品。' },
    passed: { type: 'boolean', description: 'approve 时 true=通过，false=退回。' },
    by: { type: 'string', description: 'approve / rejectApproval 的操作人（默认取宿主 actor；仅导入/测试时覆盖）。' },
    url: { type: 'string', description: '链接地址（addLink）。' },
    kind: { type: 'string', enum: ['design', 'figma', 'doc', 'other'], description: '链接类型（addLink）；也用于 evidencePolicy.kinds 过滤。' },
    evidencePolicy: {
      type: 'object',
      description: '完成证据策略（替代写死的 设计稿 门槛）：createProject / createProjectFromPrd / updateProject 传项目级策略，addNode 传节点级策略，updateSettings 的 patch 里传全局策略。省略 = 继承上层；updateProject 传 null = 清除回落到 settings。',
      properties: {
        kinds: {
          type: 'array',
          items: { type: 'string', enum: ['design', 'figma', 'doc', 'other'] },
          description: '计为证据的链接类型；空数组 = 任意类型。',
        },
        minLinks: { type: 'integer', minimum: 0, maximum: 10, description: '至少需要几条证据链接（0 = 不要求；默认 1）。' },
      },
      additionalProperties: false,
    },
    unlockPolicy: {
      type: 'string',
      enum: ['linear', 'parallel'],
      description: '节点解锁策略：linear=完成后只解锁下一个（默认）；parallel=完成/跳过后一次解锁同流程全部 locked 节点。createProject / updateProject 传项目级（null=继承 settings），updateSettings 的 patch 里传全局。',
    },
    code: { type: 'string', description: 'addNode：显式节点编号（字母 + 2~3 位数字，如 X08；同流程内唯一）；省略则取同流程 ^X(\\d+)$ 最大值 +1。' },
    weekStart: { type: 'string', description: '周报所属周的周一，YYYY-MM-DD；省略取本周。' },
    mode: { type: 'string', enum: ['concise', 'detailed'], description: '周报档位：简洁 / 详细。' },
    content: { type: 'string', description: '周报 Markdown 全文（updateReport）。' },
    text: { type: 'string', description: '补充记录内容（addNote）或节点笔记（setNodeNotes）；parsePrd / createProjectFromPrd 时是 PRD 原文（≥20 字）。' },
    date: { type: 'string', description: '日终交接日期 YYYY-MM-DD（saveHandoff）；省略为今天。' },
    nodeIds: { type: 'array', items: { type: 'string' }, description: '日终交接勾选的节点 id 数组。' },
    nextActions: { type: 'string', description: '日终交接的明日下一步（saveHandoff 必填）。' },
    sortOrder: { type: 'integer', description: '排序位置，0 = 最前（reorderLine / reorderNode）。' },
    assigneeRole: { type: 'string', enum: ['设计', '研发', '设计/产品'], description: '自定义节点的负责角色（addNode，默认设计）。' },
    detail: { type: 'string', description: '自定义节点说明（addNode / createProjectFromNodes 的节点说明）。' },
    // AI PRD 解析（AI 契约 §4）
    businessLineHint: { type: 'string', description: 'parsePrd / createProjectFromPrd：业务线提示（PRD 里没写业务线时可用）。' },
    extraInstructions: { type: 'string', description: 'parsePrd / createProjectFromPrd：补充要求，如「只要 5 个节点」「截止 11 月 20 日」。' },
    businessLineName: { type: 'string', description: 'createProjectFromNodes / createProjectFromPrd：业务线名称（已有则复用，没有则新建）。' },
    flowName: { type: 'string', description: 'createProjectFromNodes：流程名，默认「PRD 流程」。' },
    nodes: {
      type: 'array',
      description: 'createProjectFromNodes：按顺序的节点数组 [{title, detail?, assigneeRole?, approvalRoles?}]。',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          detail: { type: 'string' },
          assigneeRole: { type: 'string', enum: ['设计', '研发', '设计/产品'] },
          approvalRoles: { type: 'array', items: { type: 'string', enum: ['design', 'product'] } },
        },
        required: ['title'],
        additionalProperties: true,
      },
    },
    afterNodeId: { type: 'string', description: 'addNode：插在该节点之后。' },
    beforeNodeId: { type: 'string', description: 'addNode：插在该节点之前。' },
    archived: { type: 'boolean', description: 'archiveProject：true=归档，false=恢复；默认 true。' },
    overwrite: { type: 'boolean', description: 'generateReport：是否覆盖已存在的本周周报，默认 false。' },
    confirm: { type: 'string', description: '二次确认：resetData 传 "RESET"；deleteProject 传 "DELETE"。' },
    key: { type: 'string', description: 'dismissRhythm 的 key，形如 2026-11-03:afternoon。' },
    patch: {
      type: 'object',
      additionalProperties: true,
      description: 'updateSettings 的设置补丁，如 {"handoffTime":"20:45"}；dataFile 不可改。',
    },
  },
  required: ['action'],
  additionalProperties: false,
})

/** 工具描述（简洁：用途 + 只读动作 + 关键约束；细节在参数说明里）。 */
export const FP_TOOL_DESCRIPTION = [
  'FlowPilot 项目管理：按流程节点管理项目（设计交付 D01-D07 / 验收 A01-A05）。',
  '用 action 执行操作：只读 overview / today / listProjects 返回当前进度与今日待办；',
  '写操作包括业务线、项目、流程、节点状态（开始/完成/等待/阻塞/跳过/重新打开）、双角色确认、',
  '链接、日终交接、周报、设置与示例数据。',
  '追加节点模板：appendTemplate 把「实验推进」（E01 预跑观测 → E02 5% 白名单 → E03 50% 灰度 → E04 推全，逐个节点带 plannedAt）追加到已有流程末尾；',
  'experiment 不能用于 addFlow（它只能追加，不能新建流程），startAt 决定 plannedAt 起点（默认现在）。',
  'AI 建流程：parsePrd 只把 PRD 文本解析成可编辑提案（不落库）；createProjectFromPrd 解析并立即创建项目（写库，',
  '可带 businessLineId 或 businessLineName，节点由模型/规则提取，建立自定义流程）。',
  '约束：锁定节点默认不能操作，但 skipNode 允许跳过未解锁节点（范围裁剪）；双角色确认节点必须设计+产品都通过',
  '且满足证据策略（默认任意类型至少 1 条链接，可按 node/project/settings 三层覆盖 evidencePolicy.kinds 与 minLinks）；',
  '归档项目在恢复前不能被修改；退回会回到上一步（D04→D03、D06→D05）并轮次 +1。写操作会返回新的 revision 与 counts。',
  `只读动作：${READONLY_ACTIONS.join(' / ')}。`,
].join(' ')

/** 构造 flowpilot 工具定义（execute 由 index.js 提供）。 */
export function createFlowPilotTool({ execute }) {
  return defineTool({
    name: 'flowpilot',
    description: FP_TOOL_DESCRIPTION,
    parameters: FP_TOOL_PARAMETERS,
    output: {
      schema: { type: 'object', additionalProperties: true },
      render(_args, value) {
        return [{ type: 'text', text: JSON.stringify(value, null, 2) }]
      },
    },
    async execute(args, exec) {
      return execute(args, exec)
    },
  })
}

/* ------------------------------------------------------------------ *
 * 同步工具（SYNC.md §4）：flowpilot_sync
 * 与 flowpilot 工具分离，避免污染已有工具的参数语义；与 HTTP 路由共用同一 service。
 * ------------------------------------------------------------------ */

/** 同步工具 action（SYNC.md §4）。 */
export const FP_SYNC_ACTIONS = Object.freeze(['status', 'configure', 'test', 'sync', 'push', 'pull'])

/** `flowpilot_sync` 工具参数（标准 JSON Schema）。 */
export const FP_SYNC_PARAMETERS = Object.freeze({
  type: 'object',
  properties: {
    action: {
      type: 'string',
      enum: [...FP_SYNC_ACTIONS],
      description: 'status=查看同步状态；configure=保存通道与凭据（凭据只写本机 0600 文件）；test=测试连接；sync=双向同步（默认「三方合并」：合并云端与本地的改动并上传，冲突按最后修改时间解决；mode:"newest" 用最新覆盖旧、mode:"three-way" 用旧三路比较并可返回 409）；push=用本地覆盖远端；pull=用远端覆盖本地。',
    },
    provider: {
      type: 'string',
      enum: ['off', 'github', 'webdav'],
      description: '同步通道：off=关闭（默认）/ github=GitHub 仓库文件 / webdav=WebDAV 目录。',
    },
    owner: { type: 'string', description: 'GitHub 仓库 owner（用户或组织名）。' },
    repo: { type: 'string', description: 'GitHub 仓库名（不要带 owner/ 前缀）。' },
    branch: { type: 'string', description: 'GitHub 分支，默认 main。' },
    path: { type: 'string', description: '快照在仓库内的路径，默认 flowpilot/data.json。' },
    apiBase: { type: 'string', description: 'GitHub API 基地址，默认 https://api.github.com；GitHub Enterprise 或测试桩可改。' },
    token: { type: 'string', description: 'GitHub Token（只写入本机 sync.json，不回显；留空表示不修改）。' },
    url: { type: 'string', description: 'WebDAV 目录 URL，如 https://dav.example.com/dav/flowpilot（文件名另配）。' },
    username: { type: 'string', description: 'WebDAV 用户名（可留空表示匿名）。' },
    password: { type: 'string', description: 'WebDAV 密码（只写入本机 sync.json，不回显；留空表示不修改）。' },
    fileName: { type: 'string', description: 'WebDAV 快照文件名，默认 data.json。' },
    mode: {
      type: 'string',
      enum: ['merge', 'newest', 'three-way'],
      description: 'sync 的同步语义：merge（默认）=三方合并（以上次同步的公共祖先为基准，按记录 id 合并两边改动、冲突按最后修改时间解决，然后上传）；newest=整份取最新覆盖旧的；three-way=旧三路比较（两边都改过返回 409，人工选择方向）。',
    },
    force: {
      description: 'push / pull 时 true=忽略冲突保护（用本地覆盖远端 / 用远端覆盖本地）；sync 时可直接传方向字符串 "push" 或 "pull"。',
      oneOf: [
        { type: 'boolean' },
        { type: 'string', enum: ['push', 'pull'] },
      ],
    },
    direction: {
      type: 'string',
      enum: ['push', 'pull'],
      description: '仅 sync 动作：强制同步方向（冲突时用；等价于 force:"push"/"pull"）。',
    },
    dryRun: { type: 'boolean', description: '仅 sync 动作：只判断将要做什么，不读不写远端的写操作（不会覆盖本地/远端）。' },
  },
  required: ['action'],
  additionalProperties: false,
})

/** 工具描述（简洁：通道、凭据安全、冲突语义）。 */
export const FP_SYNC_TOOL_DESCRIPTION = [
  'FlowPilot 数据同步（GitHub 仓库文件 / WebDAV，两条通道二选一，默认关闭）。',
  '本地 data.json 仍是唯一事实来源，远端只存快照；默认「三方合并（merge）」：以上次同步的基准快照做记录级合并',
  '（两边新增都保留、字段冲突按最后修改时间解决、删除/复活按基准判断），合并结果会上传覆盖远端，永不 409；',
  'mode:"newest" 是整份最新覆盖，mode:"three-way" 是旧三路比较（可能 409）。',
  '凭据（GitHub token / WebDAV 密码）只存本机 ~/.dsh/flowpilot/sync.json（0600），不会进数据文件/导出/远端，status 只回 credentialsSet。',
  '覆盖本地前自动写 ~/.dsh/flowpilot/backups/pre-sync-<ISO>.json（保留 10 份）。',
  'configure 时凭据留空表示保持不变；force=true 仅在冲突时用于覆盖；sync 可传 direction:"push"|"pull" 强制方向。',
].join(' ')

/** 构造 flowpilot_sync 工具定义（execute 由 index.js 提供，与 HTTP 路由共用 service）。 */
export function createFlowPilotSyncTool({ execute }) {
  return defineTool({
    name: 'flowpilot_sync',
    description: FP_SYNC_TOOL_DESCRIPTION,
    parameters: FP_SYNC_PARAMETERS,
    output: {
      schema: { type: 'object', additionalProperties: true },
      render(_args, value) {
        return [{ type: 'text', text: JSON.stringify(value, null, 2) }]
      },
    },
    async execute(args, exec) {
      return execute(args, exec)
    },
  })
}
