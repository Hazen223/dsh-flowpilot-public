/**
 * FlowPilot 宿主半 · 流程模板
 *
 * 归属：host-core
 * 用途：设计交付（D01-D07）/ 验收（A01-A05）模板定义，含双角色确认（approvalRoles）、
 *       退回目标（returnToCode）与跨流程交接（HANDOFF_LINKS，D07→A01）。
 * 约束：只 import `node:` 内置模块；模板改动需同步 docs/CONTRACT.md 与客户端文案。
 */

/**
 * 设计交付流程。review 节点为双角色确认节点：
 * - D04 / D06 需要「设计」「产品」都通过并且至少一条 设计稿链接才算完成；
 * - 任一方退回时沿 returnToCode 回退（D04→D03、D06→D05），目标节点进入 revision（轮次 +1）。
 */
export const DELIVERY_TEMPLATE = Object.freeze({
  id: 'delivery',
  version: 1,
  title: '设计交付流程',
  nodes: Object.freeze([
    Object.freeze({ code: 'D01', title: '需求接收', detail: '记录需求名称与来源', assigneeRole: '设计' }),
    Object.freeze({ code: 'D02', title: '交付评估', detail: '评估工作量，确认交付周期', assigneeRole: '设计' }),
    Object.freeze({ code: 'D03', title: '设计稿 搭建交互框架', detail: '页面、跳转与异常状态兜底', assigneeRole: '设计' }),
    Object.freeze({
      code: 'D04', title: '交互确认（设计 & 产品）', detail: '提供 设计稿链接，分别记录双方确认',
      assigneeRole: '设计/产品', approvalRoles: Object.freeze(['design', 'product']), returnToCode: 'D03',
    }),
    Object.freeze({ code: 'D05', title: 'Figma 细化设计', detail: '细化设计稿并调整 设计稿 细节', assigneeRole: '设计' }),
    Object.freeze({
      code: 'D06', title: '最终设计确认（设计 & 产品）', detail: '提供 设计稿链接，分别记录双方确认',
      assigneeRole: '设计/产品', approvalRoles: Object.freeze(['design', 'product']), returnToCode: 'D05',
    }),
    Object.freeze({ code: 'D07', title: '研发交付', detail: '提交 设计稿 代码，记录研发交接', assigneeRole: '设计' }),
  ]),
})

/** 验收流程。A02 由研发负责，解锁后直接进入 waiting（等研发提交），不占「可推进」。 */
export const ACCEPTANCE_TEMPLATE = Object.freeze({
  id: 'acceptance',
  version: 1,
  title: '验收流程',
  nodes: Object.freeze([
    Object.freeze({ code: 'A01', title: '验收计划', detail: '跟进并明确验收安排', assigneeRole: '设计' }),
    Object.freeze({ code: 'A02', title: '研发提交', detail: '等待研发提供 设计稿 验收分支', assigneeRole: '研发' }),
    Object.freeze({ code: 'A03', title: '创建验收文件', detail: '在 设计稿 中新建验收文件', assigneeRole: '设计' }),
    Object.freeze({ code: 'A04', title: '设计调整', detail: '检查实现效果并记录无法实现的问题', assigneeRole: '设计' }),
    Object.freeze({ code: 'A05', title: '研发同步', detail: '提交代码并同步研发', assigneeRole: '设计' }),
  ]),
})

/** id → 模板。 */
export const TEMPLATES = Object.freeze({
  delivery: DELIVERY_TEMPLATE,
  acceptance: ACCEPTANCE_TEMPLATE,
})

/** 合法模板 id（顺序即新建项目时的默认顺序）。 */
export const TEMPLATE_IDS = Object.freeze(Object.keys(TEMPLATES))

/**
 * 跨流程交接依赖：from 节点完成后解锁 to 节点（D07→A01）。
 * 只在同一项目同时存在源流程与目标流程时建立。
 */
export const HANDOFF_LINKS = Object.freeze([
  Object.freeze({ fromTemplate: 'delivery', fromCode: 'D07', toTemplate: 'acceptance', toCode: 'A01' }),
])

/** 取模板；找不到返回 null。 */
export function getTemplate(templateId) {
  return TEMPLATES[templateId] ?? null
}

/** 模板标题；找不到返回 ''。 */
export function templateTitle(templateId) {
  return getTemplate(templateId)?.title ?? ''
}

/** 模板内节点规格；找不到返回 null。 */
export function templateNode(templateId, code) {
  return getTemplate(templateId)?.nodes.find((node) => node.code === code) ?? null
}
