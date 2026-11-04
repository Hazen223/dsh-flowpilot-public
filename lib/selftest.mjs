#!/usr/bin/env node
/**
 * FlowPilot 宿主半 · 自检（`node lib/selftest.mjs`）
 *
 * 归属：host-core
 * 覆盖：存储原子写 / revision / 坏文件报错 / 状态机（解锁·门槛·退回·跨流程）/ 周报文本 /
 *       derived 形状 / 示例数据 / 周五自动草稿 / HTTP 路由 / apply 降级 / 工具定义。
 * 约束：只用 node: 内置模块；固定时钟 + 临时 dataDir，不碰真实 `~/.dsh`。
 */

import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  ACTION_NAMES, DEFAULT_SYNC_INTERVAL_MINUTES, READONLY_ACTIONS, SYNC_INTERVAL_MINUTES_MAX,
  SYNC_INTERVAL_MINUTES_MIN, buildReportContent, computeDerived, computeFocus, computeWeekly,
  createDemoState, createEngine, normalizeSyncIntervalMinutes,
} from './domain.js'
import {
  buildPrompt, createAiService, fallbackParse, normalizeProposal, parseModelJson,
} from './ai.js'
import { API_PATHS, createRoutes } from './http.js'
import { defaultSettings, createEmptyState, normalizeState } from './store.js'
import { createSyncService, mergeThreeWay, normalizeSyncConfig } from './sync.js'
import {
  compareVersions, createUpdateService, credentialHelperArgs, detectProfileDir, extractTags, normalizeRepoUrl, parseVersion, pnpmGitEnv,
} from './update.js'
import { FP_SYNC_ACTIONS, FP_SYNC_PARAMETERS, FP_TOOL_PARAMETERS, TOOL_ACTION_NAMES, defineTool, toPayload } from './tooldef.js'
import { addDays, dateKey, isoOf, lastWorkdayOfWeek, startOfWeek, timeOnDay } from './util.js'
import * as host from '../index.js'

/* ------------------------------------------------------------------ *
 * 测试脚手架
 * ------------------------------------------------------------------ */

const quietLogger = { info() {}, warn() {}, error() {}, debug() {} }
const tempDirs = []
function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), 'flowpilot-selftest-'))
  tempDirs.push(dir)
  return dir
}

/** 固定时钟（本地时间，避免依赖时区）：2026-11-02 是周一。 */
const NOW_WED = new Date(2026, 10, 4, 15, 0, 0)       // 周三 15:00（下午工作时段）
const NOW_WED_NOON = new Date(2026, 10, 4, 12, 30, 0) // 周三午间静默
const NOW_FRI_EARLY = new Date(2026, 10, 6, 11, 0, 0) // 周五 11:00（草稿时点前）
const NOW_FRI_DRAFT = new Date(2026, 10, 6, 12, 6, 0) // 周五 12:06（草稿时点后）
const NOW_SAT = new Date(2026, 10, 7, 10, 0, 0)       // 周六

function engineAt(now, dataDir) {
  return createEngine({ dataDir, now: () => now, logger: quietLogger })
}

let passed = 0
const failures = []
const tests = []
function test(name, fn) { tests.push({ name, fn }) }
function group(name) { console.log(`\n${name}`) }

function dispatchOk(engine, action, payload = {}) {
  const out = engine.dispatch(action, payload)
  assert.equal(out.ok, true, `action ${action} 应成功`)
  return out
}

function expectCode(fn, code) {
  try {
    fn()
  } catch (error) {
    assert.equal(error?.code, code, `期望错误码 ${code}，实际 ${error?.code}：${error?.message}`)
    return error
  }
  assert.fail(`期望抛出 ${code}，但没有抛错`)
}

function nodeByCode(engine, code) {
  const found = engine.snapshot().state.nodes.find((node) => node.code === code)
  assert.ok(found, `节点 ${code} 不存在`)
  return found
}

function assertShape(object, keys, label) {
  assert.ok(object && typeof object === 'object', `${label} 必须是对象`)
  for (const key of keys) {
    assert.ok(Object.hasOwn(object, key), `${label} 缺字段 ${key}`)
  }
}

function assertJsonSerializable(value, label) {
  assert.doesNotThrow(() => JSON.stringify(value), `${label} 必须可 JSON 序列化`)
  assert.equal(typeof value, 'object')
}

/* ------------------------------------------------------------------ *
 * 1. 存储 / 示例数据 / revision
 * ------------------------------------------------------------------ */

group('存储 · 示例数据 · revision')

test('空 store：首次读取不落盘、revision=0、settings.dataFile 指向配置目录', () => {
  const dir = tempDir()
  const engine = engineAt(NOW_WED, dir)
  const snap = engine.snapshot()
  assert.equal(snap.revision, 0)
  assert.deepEqual(snap.state.projects, [])
  assert.equal(snap.state.settings.dataFile, join(dir, 'data.json'))
  assert.equal(existsSync(join(dir, 'data.json')), false, '只读不应创建数据文件')
  assert.equal(snap.derived.todayKey, '2026-11-04')
  assert.equal(snap.derived.counts.actionable, 0)
})

test('seedDemo：3 条业务线 / 4 个项目，事件落在本周内，有已过期 followUpAt', () => {
  const dir = tempDir()
  const engine = engineAt(NOW_WED, dir)
  const out = dispatchOk(engine, 'seedDemo')
  assert.equal(out.state.businessLines.length, 3)
  assert.deepEqual(out.state.businessLines.map((line) => line.name), ['增长推广', '会员中心', '数据看板'])
  assert.equal(out.state.projects.length, 4)
  assert.ok(out.state.events.length >= 20, `示例事件太少：${out.state.events.length}`)
  assert.ok(existsSync(join(dir, 'data.json')), '写入后应创建 data.json')
  const weekStart = startOfWeek(NOW_WED, 1)
  for (const event of out.state.events) {
    const time = Date.parse(event.timestamp)
    assert.ok(time >= weekStart.getTime(), `事件早于本周：${event.timestamp} ${event.kind}`)
    assert.ok(time <= NOW_WED.getTime() + 1000, `事件晚于 now：${event.timestamp} ${event.kind}`)
    assertShape(event, ['id', 'projectId', 'flowId', 'nodeId', 'kind', 'timestamp', 'details', 'round'], 'event')
  }
  assert.ok(out.state.events.some((event) => event.kind === 'seeded'))
  // 有一个 followUpAt 已过期，今日待跟进里能看到
  const expired = out.state.nodes.find((node) => node.followUpAt && Date.parse(node.followUpAt) < NOW_WED.getTime())
  assert.ok(expired, '示例数据应有一个已过期的 followUpAt')
  const followUpIds = out.derived.today.followUps.map((card) => card.nodeId)
  assert.ok(followUpIds.includes(expired.id), '过期跟进节点应出现在今日待跟进')
  assert.ok(out.derived.today.followUps.some((card) => card.nodeId === expired.id && card.reason === 'overdue'))
  // 三类项目覆盖
  const titles = out.state.projects.map((project) => project.title)
  assert.ok(titles.includes('活动管理改版'))
  assert.ok(titles.includes('权益页改版'))
  assert.ok(titles.includes('数据看板重构'))
  const activeNode = out.state.nodes.find((node) => node.status === 'active')
  assert.ok(activeNode, '示例数据应有一个进行中的节点')
  const waitingDev = out.state.nodes.find((node) => node.status === 'waiting' && node.assigneeRole === '研发')
  assert.ok(waitingDev, '示例数据应有一个等待研发的节点')
})

test('seedDemo 幂等：已有数据时拒绝（INVALID_STATE）', () => {
  const engine = engineAt(NOW_WED, tempDir())
  dispatchOk(engine, 'seedDemo')
  expectCode(() => engine.dispatch('seedDemo'), 'INVALID_STATE')
})

test('写入原子且 revision 每次 +1；只读动作不写盘', () => {
  const dir = tempDir()
  const engine = engineAt(NOW_WED, dir)
  const first = dispatchOk(engine, 'createLine', { name: '业务线 A' })
  assert.equal(first.revision, 1)
  const second = dispatchOk(engine, 'createLine', { name: '业务线 B' })
  assert.equal(second.revision, 2)
  const before = readFileSync(join(dir, 'data.json'), 'utf8')
  const readonly = engine.dispatch('listProjects')
  assert.equal(readonly.revision, 2, '只读动作不应 +revision')
  assert.equal(readFileSync(join(dir, 'data.json'), 'utf8'), before, '只读动作不应改文件')
  // 文件里 revision 与响应一致
  const onDisk = JSON.parse(readFileSync(join(dir, 'data.json'), 'utf8'))
  assert.equal(onDisk.revision, 2)
  assert.equal(onDisk.formatVersion, 1)
  assert.equal(onDisk.state.businessLines.length, 2)
})

test('数据文件损坏：报 INTERNAL 且不覆盖原文件', () => {
  const dir = tempDir()
  const file = join(dir, 'data.json')
  writeFileSync(file, '{ this is not json', 'utf8')
  const engine = engineAt(NOW_WED, dir)
  expectCode(() => engine.snapshot(), 'INTERNAL')
  expectCode(() => engine.dispatch('createLine', { name: 'X' }), 'INTERNAL')
  assert.equal(readFileSync(file, 'utf8'), '{ this is not json', '坏文件不能被静默覆盖')
})

test('导出 / 导入备份：整体替换并 revision 递增', () => {
  const engine = engineAt(NOW_WED, tempDir())
  dispatchOk(engine, 'seedDemo')
  const backup = engine.exportBackup()
  assert.equal(backup.kind, 'backup')
  assert.equal(backup.state.projects.length, 4)
  assertJsonSerializable(backup, 'backup')

  const targetDir = tempDir()
  const target = engineAt(NOW_WED, targetDir)
  const imported = target.importBackup(JSON.parse(JSON.stringify(backup)))
  assert.equal(imported.state.projects.length, 4)
  assert.ok(imported.revision >= 1)
  assert.ok(existsSync(join(targetDir, 'data.json')))
  assert.equal(imported.derived.today.followUps.length > 0, true)
})

test('resetData 必须二次确认（confirm="RESET"）', () => {
  const engine = engineAt(NOW_WED, tempDir())
  dispatchOk(engine, 'seedDemo')
  expectCode(() => engine.dispatch('resetData', { confirm: 'no' }), 'INVALID_INPUT')
  const out = dispatchOk(engine, 'resetData', { confirm: 'RESET' })
  assert.equal(out.state.projects.length, 0)
  assert.equal(out.state.businessLines.length, 0)
  assert.ok(out.revision >= 2)
})

test('normalizeState / 默认设置与契约一致', () => {
  const state = createEmptyState('/tmp/fp.json')
  assert.equal(state.formatVersion, 1)
  assert.deepEqual(state.settings.workSlots.map((slot) => slot.key), ['morning', 'afternoon', 'evening'])
  assert.deepEqual(state.settings.silentWindows, [['12:00', '14:00'], ['18:00', '19:00']])
  assert.equal(state.settings.handoffTime, '20:45')
  assert.equal(state.settings.weeklyDraftTime, '12:05')
  assert.equal(state.settings.weekStartsOn, 1)
  assert.deepEqual(state.settings.workdays, [1, 2, 3, 4, 5])
  assert.equal(normalizeState({ formatVersion: 1, projects: [] }, { dataFile: '/tmp/fp.json' }).settings.dataFile, '/tmp/fp.json')
  assert.equal(defaultSettings().weeklyDraftTime, '12:05')
})

/* ------------------------------------------------------------------ *
 * 2. 状态机
 * ------------------------------------------------------------------ */

group('状态机 · 解锁 / 门槛 / 退回 / 跨流程 handoff')

function makeProject(engine, { title = '测试项目', templates = ['delivery', 'acceptance'] } = {}) {
  const lineId = dispatchOk(engine, 'createLine', { name: `业务线-${title}` }).result.lineId
  const out = dispatchOk(engine, 'createProject', {
    businessLineId: lineId,
    title,
    templateIds: templates,
    dueAt: isoOf(addDays(NOW_WED, 3)),
  })
  return {
    projectId: out.result.projectId,
    flowIds: out.result.flowIds,
    deliveryFlowId: out.result.flowIds[templates.indexOf('delivery')] ?? out.result.flowIds[0],
    acceptanceFlowId: out.result.flowIds[templates.indexOf('acceptance')] ?? null,
  }
}

test('createProject：首节点 ready、验收首节点 locked；依赖含 sequence/return/handoff', () => {
  const engine = engineAt(NOW_WED, tempDir())
  const info = makeProject(engine)
  const { state } = engine.snapshot()
  const d01 = state.nodes.find((node) => node.code === 'D01')
  const a01 = state.nodes.find((node) => node.code === 'A01')
  assert.equal(d01.status, 'ready', '设计交付首节点应 ready')
  assert.equal(a01.status, 'locked', '验收首节点应等 D07 handoff')
  assert.deepEqual(d01.approvalRoles, [])
  const d04 = state.nodes.find((node) => node.code === 'D04')
  assert.deepEqual(d04.approvalRoles, ['design', 'product'])
  assert.deepEqual(d04.approvals, { design: false, product: false })
  assert.equal(d04.assigneeRole, '设计/产品')
  const deps = state.dependencies
  assert.equal(deps.filter((dep) => dep.relation === 'sequence').length, 6 + 4)
  assert.equal(deps.filter((dep) => dep.relation === 'return').length, 2)
  const handoff = deps.filter((dep) => dep.relation === 'handoff')
  assert.equal(handoff.length, 1)
  assert.equal(handoff[0].fromNodeId, state.nodes.find((node) => node.code === 'D07').id)
  assert.equal(handoff[0].toNodeId, a01.id)
  assert.equal(info.projectId, state.projects[0].id)
})

test('完成 D01 解锁 D02（ready）；事件记 nodeStatus/unlocked', () => {
  const engine = engineAt(NOW_WED, tempDir())
  makeProject(engine)
  dispatchOk(engine, 'startNode', { nodeId: nodeByCode(engine, 'D01').id })
  assert.equal(nodeByCode(engine, 'D01').status, 'active')
  dispatchOk(engine, 'completeNode', { nodeId: nodeByCode(engine, 'D01').id })
  assert.equal(nodeByCode(engine, 'D01').status, 'completed')
  assert.equal(nodeByCode(engine, 'D02').status, 'ready')
  assert.ok(nodeByCode(engine, 'D01').completedAt)
  const kinds = new Set(engine.snapshot().state.events.map((event) => event.kind))
  assert.ok(kinds.has('nodeStatus'))
  assert.ok(kinds.has('unlocked'))
})

test('完成门槛：缺确认 → NEED_APPROVALS；缺 设计稿 → NEED_DESIGN_LINK；补齐后自动完成', () => {
  const engine = engineAt(NOW_WED, tempDir())
  makeProject(engine)
  // 连过 D01-D03
  for (const code of ['D01', 'D02', 'D03']) {
    const node = nodeByCode(engine, code)
    dispatchOk(engine, 'startNode', { nodeId: node.id })
    dispatchOk(engine, 'completeNode', { nodeId: node.id })
  }
  const d04 = nodeByCode(engine, 'D04')
  assert.equal(d04.status, 'ready')
  dispatchOk(engine, 'startNode', { nodeId: d04.id })
  expectCode(() => engine.dispatch('completeNode', { nodeId: d04.id }), 'NEED_APPROVALS')

  const design = dispatchOk(engine, 'approve', { nodeId: d04.id, role: 'design', passed: true })
  assert.equal(design.result.completed, false)
  assert.equal(design.result.missingRoles.length, 1)
  expectCode(() => engine.dispatch('completeNode', { nodeId: d04.id }), 'NEED_APPROVALS')

  const product = dispatchOk(engine, 'approve', { nodeId: d04.id, role: 'product', passed: true })
  assert.equal(product.result.completed, false)
  assert.equal(product.result.needDesignLink, true)
  assert.equal(nodeByCode(engine, 'D04').status, 'waiting')
  expectCode(() => engine.dispatch('completeNode', { nodeId: d04.id }), 'NEED_DESIGN_LINK')

  const link = dispatchOk(engine, 'addLink', {
    nodeId: d04.id, title: '设计稿交互框架', url: 'https://design.example.com/x', kind: 'design',
  })
  assert.equal(link.result.completed, true, '补齐 设计稿链接后应自动完成')
  assert.equal(nodeByCode(engine, 'D04').status, 'completed')
  assert.equal(nodeByCode(engine, 'D05').status, 'ready')
  assert.ok(engine.dispatch('overview').derived.counts.completedThisWeek >= 4)
})

test('双角色退回：D06→D05 revision（round+1、清 completedAt、保留历史事件），随后可重新推进', () => {
  const engine = engineAt(NOW_WED, tempDir())
  makeProject(engine)
  for (const code of ['D01', 'D02', 'D03']) {
    const node = nodeByCode(engine, code)
    dispatchOk(engine, 'startNode', { nodeId: node.id })
    dispatchOk(engine, 'completeNode', { nodeId: node.id })
  }
  const d04 = nodeByCode(engine, 'D04')
  dispatchOk(engine, 'startNode', { nodeId: d04.id })
  dispatchOk(engine, 'addLink', { nodeId: d04.id, title: '设计稿 D04', url: 'https://design.example.com/d4', kind: 'design' })
  dispatchOk(engine, 'approve', { nodeId: d04.id, role: 'design', passed: true })
  dispatchOk(engine, 'approve', { nodeId: d04.id, role: 'product', passed: true })
  assert.equal(nodeByCode(engine, 'D04').status, 'completed')

  const d05 = nodeByCode(engine, 'D05')
  dispatchOk(engine, 'startNode', { nodeId: d05.id })
  dispatchOk(engine, 'completeNode', { nodeId: d05.id })
  const d06 = nodeByCode(engine, 'D06')
  assert.equal(d06.status, 'ready')
  dispatchOk(engine, 'startNode', { nodeId: d06.id })
  dispatchOk(engine, 'approve', { nodeId: d06.id, role: 'design', passed: true })

  const rejected = dispatchOk(engine, 'approve', {
    nodeId: d06.id, role: 'product', passed: false, comment: '实现效果不一致',
  })
  assert.equal(rejected.result.passed, false)
  assert.equal(rejected.result.returnedNodeIds.length, 1)
  const after06 = nodeByCode(engine, 'D06')
  const after05 = nodeByCode(engine, 'D05')
  assert.equal(after06.status, 'locked')
  assert.equal(after06.round, 2)
  assert.deepEqual(after06.approvals, { design: false, product: false })
  assert.equal(after05.status, 'revision')
  assert.equal(after05.round, 2)
  assert.equal(after05.completedAt, null)
  const events = engine.snapshot().state.events
  assert.ok(events.some((event) => event.kind === 'approvalRejected' && event.nodeId === after06.id))
  assert.ok(events.some((event) => event.kind === 'revision' && event.nodeId === after05.id))
  expectCode(() => engine.dispatch('completeNode', { nodeId: after06.id }), 'INVALID_STATE')

  // D05 重新推进（revision → active → completed），再解锁 D06
  dispatchOk(engine, 'startNode', { nodeId: after05.id })
  dispatchOk(engine, 'completeNode', { nodeId: after05.id })
  assert.equal(nodeByCode(engine, 'D05').round, 2)
  assert.equal(nodeByCode(engine, 'D06').status, 'ready')

  // 第二轮 D06 补齐链接并双确认 → 自动完成
  const d06b = nodeByCode(engine, 'D06')
  dispatchOk(engine, 'startNode', { nodeId: d06b.id })
  dispatchOk(engine, 'addLink', { nodeId: d06b.id, title: '设计稿 D06', url: 'https://design.example.com/d6', kind: 'design' })
  dispatchOk(engine, 'approve', { nodeId: d06b.id, role: 'design', passed: true })
  const final = dispatchOk(engine, 'approve', { nodeId: d06b.id, role: 'product', passed: true })
  assert.equal(final.result.completed, true)
  assert.equal(nodeByCode(engine, 'D06').status, 'completed')
  assert.equal(nodeByCode(engine, 'D07').status, 'ready')
})

test('跨流程 handoff：D07 完成解锁 A01；A01 完成解锁 A02（研发 → waiting）', () => {
  const engine = engineAt(NOW_WED, tempDir())
  makeProject(engine)
  const complete = (code) => {
    const node = nodeByCode(engine, code)
    dispatchOk(engine, 'startNode', { nodeId: node.id })
    dispatchOk(engine, 'completeNode', { nodeId: node.id })
  }
  complete('D01'); complete('D02'); complete('D03')
  const d04 = nodeByCode(engine, 'D04')
  dispatchOk(engine, 'startNode', { nodeId: d04.id })
  dispatchOk(engine, 'addLink', { nodeId: d04.id, title: '设计稿', url: 'https://design.example.com/1', kind: 'design' })
  dispatchOk(engine, 'approve', { nodeId: d04.id, role: 'design', passed: true })
  dispatchOk(engine, 'approve', { nodeId: d04.id, role: 'product', passed: true })
  assert.equal(nodeByCode(engine, 'D04').status, 'completed')
  complete('D05')
  const d06 = nodeByCode(engine, 'D06')
  dispatchOk(engine, 'startNode', { nodeId: d06.id })
  dispatchOk(engine, 'addLink', { nodeId: d06.id, title: '设计稿2', url: 'https://design.example.com/2', kind: 'design' })
  dispatchOk(engine, 'approve', { nodeId: d06.id, role: 'design', passed: true })
  dispatchOk(engine, 'approve', { nodeId: d06.id, role: 'product', passed: true })
  assert.equal(nodeByCode(engine, 'D06').status, 'completed')
  complete('D07')
  assert.equal(nodeByCode(engine, 'A01').status, 'ready', 'D07 完成后验收首节点应解锁')
  complete('A01')
  assert.equal(nodeByCode(engine, 'A02').status, 'waiting', '研发节点解锁后应是 waiting')
  const started = dispatchOk(engine, 'startNode', { nodeId: nodeByCode(engine, 'A02').id })
  assert.equal(started.result.status, 'active')
})

test('skip：解锁下一节点但不计入完成成果；block/wait/schedule/notes 正常', () => {
  const engine = engineAt(NOW_WED, tempDir())
  makeProject(engine, { templates: ['delivery'] })
  dispatchOk(engine, 'skipNode', { nodeId: nodeByCode(engine, 'D01').id, reason: '本期不做' })
  assert.equal(nodeByCode(engine, 'D01').status, 'skipped')
  assert.equal(nodeByCode(engine, 'D02').status, 'ready')
  const before = engine.dispatch('overview').derived.counts.completedThisWeek
  dispatchOk(engine, 'skipNode', { nodeId: nodeByCode(engine, 'D02').id, reason: '合并到后续迭代' })
  dispatchOk(engine, 'skipNode', { nodeId: nodeByCode(engine, 'D03').id, reason: '模板自带，跳过' })
  assert.equal(engine.dispatch('overview').derived.counts.completedThisWeek, before, 'skipped 不计入完成成果')

  const d04 = nodeByCode(engine, 'D04')
  assert.equal(d04.status, 'ready')
  dispatchOk(engine, 'setNodeSchedule', { nodeId: d04.id, dueAt: isoOf(addDays(NOW_WED, 1)), followUpAt: null })
  assert.ok(nodeByCode(engine, 'D04').dueAt)
  dispatchOk(engine, 'setNodeNotes', { nodeId: d04.id, notes: '第一行\n第二行' })
  assert.equal(nodeByCode(engine, 'D04').notes, '第一行\n第二行')

  dispatchOk(engine, 'blockNode', { nodeId: d04.id, reason: '等设计资源', followUpAt: isoOf(addDays(NOW_WED, 1)) })
  assert.equal(nodeByCode(engine, 'D04').status, 'blocked')
  expectCode(() => engine.dispatch('blockNode', { nodeId: d04.id, reason: '' }), 'INVALID_INPUT')
  dispatchOk(engine, 'waitNode', { nodeId: d04.id, followUpAt: isoOf(addDays(NOW_WED, 2)), note: '约了评审' })
  assert.equal(nodeByCode(engine, 'D04').status, 'waiting')
  assert.ok(nodeByCode(engine, 'D04').followUpAt)
})

test('reopen：completed → revision（round+1），只有 completed 可以 reopen', () => {
  const engine = engineAt(NOW_WED, tempDir())
  makeProject(engine, { templates: ['delivery'] })
  const d01 = nodeByCode(engine, 'D01')
  dispatchOk(engine, 'completeNode', { nodeId: d01.id })
  assert.equal(nodeByCode(engine, 'D01').status, 'completed')
  expectCode(() => engine.dispatch('reopenNode', { nodeId: nodeByCode(engine, 'D02').id, reason: 'x' }), 'INVALID_STATE')
  const out = dispatchOk(engine, 'reopenNode', { nodeId: d01.id, reason: '需求有补充' })
  assert.equal(out.result.status, 'revision')
  assert.equal(out.result.round, 2)
  assert.equal(nodeByCode(engine, 'D01').completedAt, null)
})

test('approve 参数校验：非确认节点 / 非法角色 / 非布尔 passed', () => {
  const engine = engineAt(NOW_WED, tempDir())
  makeProject(engine, { templates: ['delivery'] })
  expectCode(() => engine.dispatch('approve', { nodeId: nodeByCode(engine, 'D01').id, role: 'design', passed: true }), 'INVALID_INPUT')
  expectCode(() => engine.dispatch('approve', { nodeId: nodeByCode(engine, 'D04').id, role: 'boss', passed: true }), 'INVALID_INPUT')
  expectCode(() => engine.dispatch('approve', { nodeId: nodeByCode(engine, 'D04').id, role: 'design', passed: 'yes' }), 'INVALID_INPUT')
})

test('addNode / removeNode / reorderNode：自定义节点插入并重建依赖', () => {
  const engine = engineAt(NOW_WED, tempDir())
  makeProject(engine, { templates: ['delivery'] })
  const flowId = engine.snapshot().state.flows[0].id
  const d02 = nodeByCode(engine, 'D02')
  const added = dispatchOk(engine, 'addNode', {
    flowId, title: '法务合规检查', detail: '上线前合规确认', assigneeRole: '设计', afterNodeId: d02.id,
  })
  assert.equal(added.result.code, 'X01')
  assert.equal(nodeByCode(engine, 'X01').sortOrder, 2)
  const seq = engine.snapshot().state.dependencies.filter((dep) => dep.relation === 'sequence')
  assert.equal(seq.length, 6 + 1, '新增节点后 sequence 依赖 +1')
  dispatchOk(engine, 'startNode', { nodeId: nodeByCode(engine, 'D01').id })
  expectCode(() => engine.dispatch('removeNode', { nodeId: nodeByCode(engine, 'D01').id }), 'INVALID_STATE')
  dispatchOk(engine, 'completeNode', { nodeId: nodeByCode(engine, 'D01').id })
  dispatchOk(engine, 'removeNode', { nodeId: added.result.nodeId })
  assert.equal(engine.snapshot().state.nodes.some((node) => node.code === 'X01'), false)
  dispatchOk(engine, 'reorderNode', { nodeId: nodeByCode(engine, 'D03').id, sortOrder: 1 })
  assert.equal(nodeByCode(engine, 'D04').sortOrder, 3)
})

/* ------------------------------------------------------------------ *
 * 3. derived 形状 + focus + 周报
 * ------------------------------------------------------------------ */

group('派生视图 derived · 工作节奏 · 周报')

test('derived 形状与契约 §3 一致（含 counts/focus/today/weekly/projects 与 NodeCard 字段）', () => {
  const engine = engineAt(NOW_WED, tempDir())
  const seeded = dispatchOk(engine, 'seedDemo')
  const derived = seeded.derived
  assertShape(derived, ['now', 'todayKey', 'counts', 'focus', 'today', 'weekly', 'projects'], 'derived')
  assert.equal(derived.todayKey, '2026-11-04')
  assert.equal(derived.now, isoOf(NOW_WED))
  assertShape(derived.counts, ['actionable', 'waiting', 'blocked', 'revision', 'overdue', 'activeProjects', 'completedThisWeek'], 'derived.counts')
  assert.ok(derived.counts.activeProjects === 4)
  assert.ok(derived.counts.actionable >= 2)
  assert.ok(derived.counts.waiting >= 2)
  assert.ok(derived.counts.overdue >= 1)
  assert.ok(derived.counts.completedThisWeek >= 10)

  assertShape(derived.focus, ['period', 'label', 'silent', 'inWorkHours', 'prompt'], 'derived.focus')
  assert.equal(derived.focus.period, 'afternoon')
  assert.equal(derived.focus.label, '主要工作输出')
  assert.equal(derived.focus.silent, false)
  assert.equal(derived.focus.inWorkHours, true)
  assert.ok(derived.focus.prompt)
  assert.equal(typeof derived.focus.prompt.body, 'string')
  assert.ok(derived.focus.prompt.body.includes('可推进节点'))
  assert.equal(derived.focus.prompt.cta, '打开今日')

  assertShape(derived.today, ['recommended', 'followUps', 'upcoming', 'handoffContext'], 'derived.today')
  assert.ok(Array.isArray(derived.today.recommended))
  assert.ok(derived.today.recommended.length <= 5)
  assert.ok(Array.isArray(derived.today.followUps))
  assert.ok(Array.isArray(derived.today.upcoming))
  assert.ok(derived.today.upcoming.length >= 1, '示例数据应有 7 天内截止的节点')
  assert.ok(derived.today.handoffContext, '示例数据应带上次交接上下文')
  assertShape(derived.today.handoffContext, ['date', 'nextActions', 'notes', 'nodes', 'confirmedAt'], 'handoffContext')

  assertShape(derived.weekly, ['weekStart', 'weekEnd', 'reportId', 'exists', 'shouldGenerate', 'nextGenerateAt'], 'derived.weekly')
  assert.equal(derived.weekly.weekStart, '2026-11-02')
  assert.equal(derived.weekly.weekEnd, '2026-11-06')
  assert.equal(derived.weekly.exists, false)
  assert.equal(derived.weekly.shouldGenerate, false)
  assert.equal(derived.weekly.nextGenerateAt, isoOf(new Date(2026, 10, 6, 12, 5, 0)))

  const cards = [...derived.today.recommended, ...derived.today.followUps, ...derived.today.upcoming,
    ...(derived.today.handoffContext?.nodes ?? [])]
  assert.ok(cards.length > 0)
  for (const card of cards) {
    assertShape(card, ['nodeId', 'code', 'title', 'status', 'projectId', 'projectTitle',
      'businessLineId', 'businessLineName', 'flowId', 'flowName', 'dueAt', 'followUpAt',
      'completedAt', 'round', 'assigneeRole', 'daysLeft', 'approvals', 'linkCount', 'hasDesignLink'], 'NodeCard')
    assert.equal(typeof card.linkCount, 'number')
    assert.equal(typeof card.hasDesignLink, 'boolean')
    assert.ok(card.daysLeft === null || typeof card.daysLeft === 'number')
  }
  for (const card of [...derived.today.recommended, ...derived.today.followUps]) {
    assert.ok(['overdue', 'dueSoon', 'active', 'revision', 'ready', 'followUp'].includes(card.reason), `非法 reason：${card.reason}`)
  }
  for (const [projectId, info] of Object.entries(derived.projects)) {
    assertShape(info, ['currentStage', 'currentCode', 'activeNodeId', 'actionable', 'waiting',
      'total', 'completed', 'progress', 'needsAttention', 'nextDueAt'], `derived.projects.${projectId}`)
    assert.ok(info.progress >= 0 && info.progress <= 1)
  }
  const p1 = seeded.state.projects.find((project) => project.title === '活动管理改版')
  const p1Info = derived.projects[p1.id]
  assert.equal(p1Info.currentCode, 'D04')
  assert.equal(p1Info.needsAttention, true)
})

test('focus：午间静默无 prompt；周末为 weekend；dismissRhythm 后当天不再提示', () => {
  const engine = engineAt(NOW_WED, tempDir())
  const seeded = dispatchOk(engine, 'seedDemo')
  const state = seeded.state
  const noon = computeFocus(state, NOW_WED_NOON, seeded.derived.counts)
  assert.equal(noon.period, 'noonBreak')
  assert.equal(noon.silent, true)
  assert.equal(noon.inWorkHours, false)
  assert.equal(noon.prompt, null)
  const weekend = computeFocus(state, NOW_SAT, seeded.derived.counts)
  assert.equal(weekend.period, 'weekend')
  assert.equal(weekend.prompt, null)
  const morning = computeFocus(state, new Date(2026, 10, 4, 11, 30, 0), seeded.derived.counts)
  assert.equal(morning.period, 'morning')
  assert.equal(morning.inWorkHours, true)

  const key = `${dateKey(NOW_WED)}:afternoon`
  dispatchOk(engine, 'dismissRhythm', { key })
  assert.equal(engine.snapshot().derived.focus.prompt, null)
})

test('周报（简洁）：业务线 → 项目 → 完成/修改/推进中/待跟进/补充记录；未完成不写成完成', () => {
  const engine = engineAt(NOW_WED, tempDir())
  dispatchOk(engine, 'seedDemo')
  const out = dispatchOk(engine, 'generateReport', { mode: 'concise' })
  const content = out.result.content
  assert.ok(content.startsWith('# 本周工作（11月2日—11月6日）'), `周报标题不对：${content.slice(0, 60)}`)
  assert.ok(content.includes('\n## 增长推广'))
  assert.ok(content.includes('\n## 会员中心'))
  assert.ok(content.includes('\n## 数据看板'))
  assert.ok(content.includes('- **活动管理改版**：'))
  assert.ok(content.includes('完成：'))
  assert.ok(content.includes('修改：'))
  assert.ok(content.includes('推进中：'))
  assert.ok(content.includes('待跟进：'))
  assert.ok(content.includes('补充记录：'))
  const report = out.state.reports[0]
  assert.equal(report.weekStart, '2026-11-02')
  assert.equal(report.mode, 'concise')
  assert.equal(report.lastEditedAt, null)
  assertJsonSerializable(report, 'report')

  // 抽一条项目行，按「；」切段检查：当前 waiting 的节点只能出现在「待跟进」
  const d04 = out.state.nodes.find((node) => node.code === 'D04' && node.status === 'waiting')
  assert.ok(d04, '示例数据里 D04 应为 waiting')
  const line = content.split('\n').find((item) => item.includes('- **活动管理改版**：'))
  assert.ok(line)
  const segments = line.split('：').slice(1).join('：').split('；')
  const doneSeg = segments.find((segment) => segment.startsWith('完成：'))
  const waitingSeg = segments.find((segment) => segment.startsWith('待跟进：'))
  assert.ok(doneSeg, '周报缺完成段')
  assert.ok(waitingSeg, '周报缺待跟进段')
  assert.equal(doneSeg.includes(d04.title), false, `未完成节点被写成完成：${d04.title}`)
  assert.ok(waitingSeg.includes(d04.title), '待跟进段应包含 waiting 节点')

  // 第二条：验收里等待研发的节点也不能出现在「完成」里
  const a02 = out.state.nodes.find((node) => node.code === 'A02' && node.status === 'waiting')
  const line2 = content.split('\n').find((item) => item.includes('- **权益页改版**：'))
  assert.ok(line2)
  const segments2 = line2.split('：').slice(1).join('：').split('；')
  const doneSeg2 = segments2.find((segment) => segment.startsWith('完成：'))
  const waitingSeg2 = segments2.find((segment) => segment.startsWith('待跟进：'))
  assert.equal(doneSeg2.includes(a02.title), false)
  assert.ok(waitingSeg2.includes(a02.title))
})

test('周报（详细）：项目用 ### 分块，含轮次 / 计划跟进；updateReport 记录 lastEditedAt', () => {
  const engine = engineAt(NOW_WED, tempDir())
  dispatchOk(engine, 'seedDemo')
  const out = dispatchOk(engine, 'generateReport', { mode: 'detailed' })
  const content = out.result.content
  assert.ok(content.includes('### 活动管理改版'), '详细档应有项目分块')
  assert.ok(content.includes('（第 2 轮）'), '详细档应带轮次')
  assert.ok(content.includes('计划跟进：'), '详细档待跟进应带计划跟进时间')
  assert.ok(content.includes('- 修改：'))
  assert.ok(content.includes('- 推进中：'))

  const reportId = out.result.reportId
  const updated = dispatchOk(engine, 'updateReport', { reportId, content: '# 我自己写的周报\n\n- 手改内容', mode: 'concise' })
  assert.equal(updated.result.mode, 'concise')
  const report = engine.snapshot().state.reports.find((item) => item.id === reportId)
  assert.equal(report.content, '# 我自己写的周报\n\n- 手改内容')
  assert.ok(report.lastEditedAt)
  assert.ok(engine.snapshot().state.events.some((event) => event.kind === 'reportEdited'))

  // 非 overwrite 再生成：复用已有周报，不覆盖手改内容
  const reused = dispatchOk(engine, 'generateReport', { mode: 'concise' })
  assert.equal(reused.result.reused, true)
  assert.equal(reused.result.content, report.content)
})

test('周报（空数据）：给出明确占位文本', () => {
  const state = createEmptyState('/tmp/fp.json')
  const content = buildReportContent(state, '2026-11-02', 'concise', NOW_WED)
  assert.ok(content.includes('# 本周工作（11月2日—11月6日）'))
  assert.ok(content.includes('本周尚无可生成周报的节点事件'))
})

test('周五 12:05 之后读 state 自动补齐周报草稿（只补一次、revision +1）', () => {
  const dir = tempDir()
  const wed = engineAt(NOW_WED, dir)
  dispatchOk(wed, 'seedDemo')
  assert.equal(wed.snapshot().state.reports.length, 0)
  const revAfterSeed = wed.snapshot().revision
  assert.ok(revAfterSeed >= 1)

  // 周五上午 11:00：不补
  const early = engineAt(NOW_FRI_EARLY, dir)
  const earlySnap = early.snapshot()
  assert.equal(earlySnap.state.reports.length, 0)
  assert.equal(earlySnap.derived.weekly.shouldGenerate, false)
  assert.equal(earlySnap.derived.weekly.nextGenerateAt, isoOf(new Date(2026, 10, 6, 12, 5, 0)))

  // 周五 12:06：自动生成草稿
  const friday = engineAt(NOW_FRI_DRAFT, dir)
  const snap = friday.snapshot()
  assert.equal(snap.state.reports.length, 1)
  assert.equal(snap.state.reports[0].weekStart, '2026-11-02')
  assert.equal(snap.state.reports[0].mode, 'concise')
  assert.equal(snap.state.reports[0].generatedAt, isoOf(NOW_FRI_DRAFT))
  assert.ok(snap.state.reports[0].content.includes('## 增长推广'))
  assert.equal(snap.derived.weekly.exists, true)
  assert.equal(snap.derived.weekly.reportId, snap.state.reports[0].id)
  assert.equal(snap.derived.weekly.shouldGenerate, false)
  assert.equal(snap.revision, revAfterSeed + 1, '补草稿应 rev +1')
  assert.ok(snap.state.events.some((event) => event.kind === 'reportGenerated' && event.details.includes('自动补齐')))

  // 再次读取不应重复生成 / 不重复 +revision
  const again = friday.snapshot()
  assert.equal(again.state.reports.length, 1)
  assert.equal(again.revision, snap.revision)
  assert.ok(existsSync(join(dir, 'data.json')))
})

test('周六读 state：本周草稿仍会补齐', () => {
  const dir = tempDir()
  dispatchOk(engineAt(NOW_WED, dir), 'seedDemo')
  const sat = engineAt(NOW_SAT, dir)
  const snap = sat.snapshot()
  assert.equal(snap.state.reports.length, 1)
  assert.equal(snap.derived.weekly.exists, true)
})

test('computeWeekly：草稿时点前 shouldGenerate=false、时点后=true', () => {
  const state = createEmptyState('/tmp/fp.json')
  const before = computeWeekly(state, NOW_FRI_EARLY)
  assert.equal(before.shouldGenerate, false)
  assert.equal(before.nextGenerateAt, isoOf(new Date(2026, 10, 6, 12, 5, 0)))
  const after = computeWeekly(state, NOW_FRI_DRAFT)
  assert.equal(after.shouldGenerate, true)
})

/* ------------------------------------------------------------------ *
 * 4. 设置 / 业务线 / 项目
 * ------------------------------------------------------------------ */

group('业务线 · 项目 · 设置')

test('业务线 CRUD：重名拒绝、有项目时删除拒绝、排序生效', () => {
  const engine = engineAt(NOW_WED, tempDir())
  const a = dispatchOk(engine, 'createLine', { name: 'A 线' }).result.lineId
  dispatchOk(engine, 'createLine', { name: 'B 线' })
  expectCode(() => engine.dispatch('createLine', { name: 'A 线' }), 'INVALID_INPUT')
  dispatchOk(engine, 'renameLine', { lineId: a, name: 'A 线改名' })
  const project = dispatchOk(engine, 'createProject', { businessLineId: a, title: '项目 X' })
  expectCode(() => engine.dispatch('deleteLine', { lineId: a }), 'INVALID_STATE')
  dispatchOk(engine, 'archiveProject', { projectId: project.result.projectId, archived: true })
  expectCode(() => engine.dispatch('deleteLine', { lineId: a }), 'INVALID_STATE')
  const moved = dispatchOk(engine, 'reorderLine', { lineId: a, sortOrder: 1 })
  assert.equal(moved.result.sortOrder, 1)
  assert.equal(engine.snapshot().state.businessLines[1].id, a)
})

test('项目：updateProject / archiveProject / addFlow（重复流程拒绝、补流程后 handoff 解锁）', () => {
  const engine = engineAt(NOW_WED, tempDir())
  const lineId = dispatchOk(engine, 'createLine', { name: '线' }).result.lineId
  const created = dispatchOk(engine, 'createProject', { businessLineId: lineId, title: '项目 Y', templateIds: ['delivery'] })
  const projectId = created.result.projectId
  dispatchOk(engine, 'updateProject', { projectId, title: '项目 Y2', dueAt: isoOf(addDays(NOW_WED, 5)) })
  assert.equal(engine.snapshot().state.projects[0].title, '项目 Y2')
  const added = dispatchOk(engine, 'addFlow', { projectId, templateId: 'acceptance' })
  assert.equal(added.result.flowIds ? 0 : 1, 1)
  assert.equal(engine.snapshot().state.nodes.filter((node) => node.code === 'A01').length, 1)
  expectCode(() => engine.dispatch('addFlow', { projectId, templateId: 'acceptance' }), 'INVALID_STATE')
  expectCode(() => engine.dispatch('addFlow', { projectId, templateId: 'nope' }), 'INVALID_INPUT')
  const arch = dispatchOk(engine, 'archiveProject', { projectId })
  assert.equal(arch.result.status, 'archived')
  assert.equal(engine.dispatch('overview').derived.projects[projectId].total >= 12, true)
  const restored = dispatchOk(engine, 'archiveProject', { projectId, archived: false })
  assert.equal(restored.result.status, 'active')
})

test('updateSettings：校验时段 / 静默窗 / 时间格式，并拒绝 dataFile', () => {
  const engine = engineAt(NOW_WED, tempDir())
  const out = dispatchOk(engine, 'updateSettings', {
    patch: { handoffTime: '21:00', weeklyDraftTime: '12:30', workdays: [1, 2, 3, 4, 5, 6] },
  })
  assert.equal(out.result.changed, true)
  const settings = engine.snapshot().state.settings
  assert.equal(settings.handoffTime, '21:00')
  assert.equal(settings.weeklyDraftTime, '12:30')
  assert.deepEqual(settings.workdays, [1, 2, 3, 4, 5, 6])
  expectCode(() => engine.dispatch('updateSettings', { patch: { handoffTime: '25:00' } }), 'INVALID_INPUT')
  expectCode(() => engine.dispatch('updateSettings', { patch: { workSlots: [] } }), 'INVALID_INPUT')
  expectCode(() => engine.dispatch('updateSettings', { patch: { dataFile: '/tmp/x.json' } }), 'INVALID_INPUT')
  expectCode(() => engine.dispatch('updateSettings', { patch: { unknownKey: 1 } }), 'INVALID_INPUT')
  expectCode(() => engine.dispatch('updateSettings', { patch: { silentWindows: [['14:00', '12:00']] } }), 'INVALID_INPUT')
  const slots = [
    { key: 'morning', label: '启动', start: '10:00', end: '12:00' },
    { key: 'afternoon', label: '输出', start: '13:30', end: '18:30' },
    { key: 'evening', label: '收尾', start: '19:00', end: '21:00' },
  ]
  dispatchOk(engine, 'updateSettings', { patch: { workSlots: slots } })
  assert.equal(engine.snapshot().state.settings.workSlots[0].start, '10:00')
})

test('交接：saveHandoff 新增/更新，derived.handoffContext 取最近一次', () => {
  const engine = engineAt(NOW_WED, tempDir())
  const seeded = dispatchOk(engine, 'seedDemo')
  const nodeId = seeded.state.nodes.find((node) => node.status === 'active').id
  const out = dispatchOk(engine, 'saveHandoff', {
    date: '2026-11-04', nodeIds: [nodeId], nextActions: '明天先把 Figma 收尾', notes: '评审约在 15:00',
  })
  assert.equal(out.result.date, '2026-11-04')
  const updated = dispatchOk(engine, 'saveHandoff', {
    nodeIds: [nodeId], nextActions: '改为先做 D05', notes: '',
  })
  assert.equal(updated.result.date, '2026-11-04')
  const state = engine.snapshot().state
  assert.equal(state.handoffs.filter((handoff) => handoff.date === '2026-11-04').length, 1, '同一天只保留一条交接')
  const context = engine.snapshot().derived.today.handoffContext
  assert.equal(context.date, '2026-11-04')
  assert.equal(context.nextActions, '改为先做 D05')
  assert.equal(context.nodes.length, 1)
  expectCode(() => engine.dispatch('saveHandoff', { nextActions: '' }), 'INVALID_INPUT')
  expectCode(() => engine.dispatch('saveHandoff', { nextActions: 'x', nodeIds: ['nd_missing'] }), 'NOT_FOUND')
})

test('addNote：manualNote 事件进入周报补充记录', () => {
  const engine = engineAt(NOW_WED, tempDir())
  const seeded = dispatchOk(engine, 'seedDemo')
  const projectId = seeded.state.projects[0].id
  dispatchOk(engine, 'addNote', { projectId, text: '补充：本周与运营对齐了投放素材清单' })
  const report = dispatchOk(engine, 'generateReport', { mode: 'concise' }).result.content
  assert.ok(report.includes('补充：本周与运营对齐了投放素材清单'))
})

test('listProjects 支持 status 过滤；locked 节点不可 skip（契约 §4「locked 不可 action」）', () => {
  const engine = engineAt(NOW_WED, tempDir())
  dispatchOk(engine, 'seedDemo')
  assert.equal(engine.dispatch('listProjects').result.projects.length, 4)
  assert.equal(engine.dispatch('listProjects', { status: 'archived' }).result.projects.length, 0)
  const waiting = engine.dispatch('listProjects', { status: 'waiting' }).result.projects
  assert.ok(waiting.length >= 2, '至少两个项目有 waiting 节点')
  assert.ok(waiting.every((project) => project.waiting >= 1))
  expectCode(() => engine.dispatch('listProjects', { status: 'nope' }), 'INVALID_INPUT')
  const locked = engine.snapshot().state.nodes.find((node) => node.status === 'locked')
  expectCode(() => engine.dispatch('skipNode', { nodeId: locked.id, reason: 'x' }), 'INVALID_STATE')
})

/* ------------------------------------------------------------------ *
 * 5. HTTP API
 * ------------------------------------------------------------------ */

group('HTTP API · 路由 / 错误码 / 跨站校验')

function fakeRequest({ method = 'GET', url = '/flowpilot/api/state', headers = {}, body } = {}) {
  const chunks = body === undefined ? [] : [Buffer.from(String(body), 'utf8')]
  return {
    method,
    url,
    headers,
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk
    },
  }
}

function fakeResponse() {
  const state = { statusCode: 0, headers: {}, body: '' }
  return {
    state,
    writeHead(statusCode, headers) { state.statusCode = statusCode; state.headers = { ...headers } },
    end(body) { state.body = body ?? '' },
  }
}

async function callRoute(handler, init) {
  const req = fakeRequest(init)
  const res = fakeResponse()
  await handler(req, res)
  let json = null
  try { json = res.state.body ? JSON.parse(res.state.body) : null } catch { /* 非 JSON */ }
  return { status: res.state.statusCode, headers: res.state.headers, body: res.state.body, json }
}

function routeMap(engine) {
  const routes = createRoutes({ engine, logger: quietLogger })
  return new Map(routes.map(({ path, handler }) => [path, handler]))
}

test('GET /state：200 + {ok, revision, state, derived}', async () => {
  const engine = engineAt(NOW_WED, tempDir())
  dispatchOk(engine, 'seedDemo')
  const routes = routeMap(engine)
  assert.deepEqual([...routes.keys()].sort(), Object.values(API_PATHS).sort())
  const out = await callRoute(routes.get(API_PATHS.state), { method: 'GET', headers: { host: '127.0.0.1:51895' } })
  assert.equal(out.status, 200)
  assert.equal(out.json.ok, true)
  assert.equal(out.json.state.projects.length, 4)
  assert.equal(out.json.derived.counts.activeProjects, 4)
  assert.equal(typeof out.json.revision, 'number')
  assert.ok(out.headers['content-type'].includes('application/json'))
})

test('POST /action：成功；门槛失败返回 409 + NEED_APPROVALS；未知 action 400', async () => {
  const engine = engineAt(NOW_WED, tempDir())
  const seeded = dispatchOk(engine, 'seedDemo')
  const routes = routeMap(engine)
  const action = routes.get(API_PATHS.action)
  const readyNode = seeded.state.nodes.find((node) => node.status === 'ready')
  const okOut = await callRoute(action, {
    method: 'POST', headers: { host: 'h' },
    body: JSON.stringify({ action: 'startNode', payload: { nodeId: readyNode.id } }),
  })
  assert.equal(okOut.status, 200)
  assert.equal(okOut.json.ok, true)
  assert.equal(okOut.json.result.status, 'active')

  const waitingApproval = seeded.state.nodes.find((node) => node.approvalRoles.length > 0 && node.status === 'waiting')
  assert.ok(waitingApproval, '示例数据应有等待确认的节点')
  const failOut = await callRoute(action, {
    method: 'POST', headers: { host: 'h' },
    body: JSON.stringify({ action: 'completeNode', payload: { nodeId: waitingApproval.id } }),
  })
  assert.equal(failOut.status, 409)
  assert.equal(failOut.json.ok, false)
  assert.equal(failOut.json.code, 'NEED_APPROVALS')
  assert.ok(failOut.json.error.length > 0)
  assert.ok(failOut.json.state, '失败响应应带 state')

  const unknown = await callRoute(action, {
    method: 'POST', headers: { host: 'h' },
    body: JSON.stringify({ action: 'notAnAction', payload: {} }),
  })
  assert.equal(unknown.status, 400)
  assert.equal(unknown.json.code, 'INVALID_INPUT')

  const badJson = await callRoute(action, { method: 'POST', headers: { host: 'h' }, body: '{oops' })
  assert.equal(badJson.status, 400)
  assert.equal(badJson.json.code, 'INVALID_INPUT')
})

test('跨站校验：Origin host 与 Host 不一致 → 403', async () => {
  const engine = engineAt(NOW_WED, tempDir())
  const routes = routeMap(engine)
  const out = await callRoute(routes.get(API_PATHS.state), {
    method: 'GET', headers: { host: '127.0.0.1:51895', origin: 'https://evil.example.com' },
  })
  assert.equal(out.status, 403)
  assert.equal(out.json.ok, false)
  const sameOrigin = await callRoute(routes.get(API_PATHS.state), {
    method: 'GET', headers: { host: '127.0.0.1:51895', origin: 'http://127.0.0.1:51895' },
  })
  assert.equal(sameOrigin.status, 200)
})

test('GET /export 带 attachment；POST /import 整体替换', async () => {
  const engine = engineAt(NOW_WED, tempDir())
  dispatchOk(engine, 'seedDemo')
  const routes = routeMap(engine)
  const exported = await callRoute(routes.get(API_PATHS.export), { method: 'GET', headers: { host: 'h' } })
  assert.equal(exported.status, 200)
  assert.ok(exported.headers['content-disposition'].startsWith('attachment;'))
  assert.ok(exported.headers['content-disposition'].includes('.json'))
  const backup = JSON.parse(exported.body)
  assert.equal(backup.kind, 'backup')

  const targetEngine = engineAt(NOW_WED, tempDir())
  const targetRoutes = routeMap(targetEngine)
  const imported = await callRoute(targetRoutes.get(API_PATHS.import), {
    method: 'POST', headers: { host: 'h' }, body: JSON.stringify(backup),
  })
  assert.equal(imported.status, 200)
  assert.equal(imported.json.ok, true)
  assert.equal(imported.json.result.imported, true)
  assert.equal(imported.json.state.projects.length, 4)
})

/* ------------------------------------------------------------------ *
 * 6. 工具定义 / apply 降级
 * ------------------------------------------------------------------ */

group('agent tool · apply')

test('本地 defineTool 轻量校验；参数是标准 JSON Schema', () => {
  assert.throws(() => defineTool({}), /name/)
  assert.throws(() => defineTool({ name: 'x', description: 'd' }), /parameters/)
  assert.throws(() => defineTool({
    name: 'x', description: 'd',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    execute() {},
  }), /output/)
  assert.throws(() => defineTool({
    name: 'x', description: 'd',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: { schema: { type: 'object', additionalProperties: true }, render() { return [] } },
  }), /execute/)
  assert.equal(FP_TOOL_PARAMETERS.type, 'object')
  assert.equal(FP_TOOL_PARAMETERS.additionalProperties, false)
  assert.deepEqual(FP_TOOL_PARAMETERS.required, ['action'])
  assert.ok(FP_TOOL_PARAMETERS.properties.action.enum.includes('completeNode'))
  assert.ok(FP_TOOL_PARAMETERS.properties.action.enum.includes('overview'))
  for (const action of ACTION_NAMES) assert.ok(FP_TOOL_PARAMETERS.properties.action.enum.includes(action), `工具缺 action：${action}`)
  for (const action of ['parsePrd', 'createProjectFromPrd']) {
    assert.ok(TOOL_ACTION_NAMES.includes(action))
    assert.ok(FP_TOOL_PARAMETERS.properties.action.enum.includes(action), `工具缺 AI action：${action}`)
  }
  assert.ok(READONLY_ACTIONS.every((action) => ACTION_NAMES.includes(action)))
  assert.deepEqual(toPayload({ action: 'createProject', title: 'x', templateIds: 'delivery, acceptance' }).templateIds, ['delivery', 'acceptance'])
  assert.equal(toPayload({ action: 'x', passed: false }).passed, false, 'false 不能被丢掉')
  assert.deepEqual(toPayload({ action: 'x', payload: { nodeId: 'nd_1' }, notes: 'n' }), { nodeId: 'nd_1', notes: 'n' })
})

function makeFakeCtx({ withWebServer = true, llmStream, selection } = {}) {
  const tools = []
  const routes = []
  const ctx = {
    logger: quietLogger,
    tools: { register(definition) { tools.push(definition) } },
    effect(fn) {
      const dispose = fn()
      return () => { if (typeof dispose === 'function') dispose() }
    },
    get(name) {
      if (name === 'webServer') return withWebServer ? ctx.webServer : undefined
      if (name === 'llm') return llmStream ? { stream: llmStream } : undefined
      if (name === 'agentDefaultModel') return selection ? { currentSelection: () => selection } : undefined
      return undefined
    },
  }
  if (withWebServer) {
    ctx.webServer = {
      register(spec) {
        routes.push(spec)
        return () => {}
      },
    }
  }
  return { ctx, tools, routes }
}

test('模块出口：name/inject/apply 形状符合要求（inject 含 tools + webServer）', () => {
  assert.equal(host.name, 'flowpilot')
  assert.deepEqual(host.inject, ['tools', 'webServer'], 'webServer 必须 inject：否则 apply 早于 webServer 就绪，HTTP 路由不会注册')
  assert.equal(typeof host.apply, 'function')
})

test('apply + fake ctx：注册 2 个工具（flowpilot / flowpilot_sync）+ 全部路由，工具可执行 overview', async () => {
  const dir = tempDir()
  const { ctx, tools, routes } = makeFakeCtx({ withWebServer: true })
  host.apply(ctx, { dataDir: dir })
  assert.equal(tools.length, 2, 'flowpilot + flowpilot_sync')
  const tool = tools[0]
  assert.equal(tool.name, 'flowpilot')
  const syncTool = tools[1]
  assert.equal(syncTool.name, 'flowpilot_sync')
  assert.equal(syncTool.parameters.type, 'object')
  assert.equal(syncTool.parameters.additionalProperties, false)
  assert.ok(syncTool.parameters.properties.action.enum.includes('status'))
  assert.equal(typeof syncTool.execute, 'function')
  assert.equal(tool.parameters.type, 'object')
  assert.equal(tool.parameters.additionalProperties, false)
  assert.equal(typeof tool.execute, 'function')
  assert.equal(routes.length, Object.values(API_PATHS).length)
  assert.deepEqual(routes.map((route) => route.path).sort(), Object.values(API_PATHS).sort())
  assert.ok(routes.every((route) => route.kind === 'exact' && typeof route.handler === 'function'))

  const overview = await tool.execute({ action: 'overview' }, {})
  assert.equal(overview.ok, true)
  assert.equal(typeof overview.summary, 'string')
  assert.ok(overview.counts)
  assertJsonSerializable(overview, 'tool result')

  const created = await tool.execute({ action: 'createLine', name: 'Agent 线' }, {})
  assert.equal(created.ok, true)
  assert.equal(created.result.line.name, 'Agent 线')
  assert.equal(typeof created.summary, 'string')
  assert.equal(typeof created.revision, 'number')

  const failed = await tool.execute({ action: 'startNode', nodeId: 'nd_missing' }, {})
  assert.equal(failed.ok, false)
  assert.equal(failed.code, 'NOT_FOUND')
  assert.ok(failed.summary.startsWith('失败：'))
})

test('apply 无 webServer：不抛错、只注册工具（降级）', () => {
  const dir = tempDir()
  const { ctx, tools, routes } = makeFakeCtx({ withWebServer: false })
  assert.doesNotThrow(() => host.apply(ctx, { dataDir: dir }))
  assert.equal(tools.length, 2)
  assert.equal(routes.length, 0)
})

test('apply 的 ctx.get("webServer") 路径（cordis 真实形状）可用', () => {
  const dir = tempDir()
  const registered = []
  const webServer = { register(spec) { registered.push(spec); return () => {} } }
  const tools = []
  const ctx = {
    logger: quietLogger,
    tools: { register(definition) { tools.push(definition) } },
    effect(fn) { const dispose = fn(); return () => { if (typeof dispose === 'function') dispose() } },
    get(name) { return name === 'webServer' ? webServer : undefined },
  }
  host.apply(ctx, { dataDir: dir })
  assert.equal(tools.length, 2)
  assert.equal(registered.length, Object.values(API_PATHS).length)
})

/* ------------------------------------------------------------------ *
 * 7. AI PRD 解析（fake LLM：不调用真实模型）
 * ------------------------------------------------------------------ */

group('AI PRD · 解析 / 归一化 / 建项目 / 路由 / 工具')

const PRD_TEXT = [
  '# 活动管理改版',
  '',
  '背景：增长推广的投放管理页需要改版，支持批量创建计划。',
  '需求：',
  '| 阶段 | 说明 |',
  '| --- | --- |',
  '| 需求接收 | 与运营确认范围 |',
  '| 交互稿 | 设计稿 搭建交互框架 |',
  '| 研发实现 | 前端完成页面开发 |',
  '| 验收 | 设计与产品共同确认 |',
].join('\n')

const SAMPLE_PROPOSAL = {
  title: '活动管理改版',
  businessLineName: '增长推广',
  dueAt: '2026-11-20T10:00:00.000Z',
  templateId: 'delivery',
  summary: '支持批量创建投放计划',
  nodes: [
    { title: '需求接收', detail: '确认需求范围', assigneeRole: '设计', approvalRoles: [] },
    { title: '交互确认', detail: '设计稿链接，双方确认', assigneeRole: '设计/产品', approvalRoles: ['design', 'product'] },
    { title: '研发实现', detail: '前端实现', assigneeRole: '研发', approvalRoles: [] },
  ],
  notes: '按 PRD 结构拆解',
}

function sleep(ms) {
  return new Promise((resolve) => { setTimeout(resolve, ms) })
}

/** 假 LLM：按顺序吐出固定 chunk（返回 AsyncIterable，形状与 ctx.llm.stream 一致）。 */
function fakeLlm(chunks) {
  return function stream() {
    return (async function* generate() {
      for (const chunk of chunks) yield chunk
    })()
  }
}

/** 假 LLM：一次吐出完整 JSON（可带 markdown 围栏），用于成功路径。 */
function fakeLlmJson(object, { fenced = false } = {}) {
  const json = JSON.stringify(object)
  const text = fenced ? `\`\`\`json\n${json}\n\`\`\`` : json
  return fakeLlm([
    { type: 'block-start' },
    { type: 'text-delta', text: text.slice(0, 10) },
    { type: 'text-delta', text: text.slice(10) },
    { type: 'usage', usage: { inputTokens: 120, outputTokens: 80 } },
    { type: 'finish', reason: { kind: 'stop' } },
  ])
}

/** 建一个带 fake LLM 的 AI 服务 + 独立临时数据目录。 */
function makeAiService({ now = NOW_WED, dataDir = tempDir(), stream, selection, config } = {}) {
  const engine = engineAt(now, dataDir)
  const { ctx } = makeFakeCtx({ llmStream: stream, selection })
  const ai = createAiService({ ctx, engine, logger: quietLogger, config })
  return { engine, ai, ctx }
}

const MODEL_SELECTION = { provider: 'deepseek-account', model: 'deepseek-flash', reasoningEffort: 'max' }

test('AI status：无 LLM 不可用；session-default / config 两条路由', () => {
  const noLlm = makeAiService({}).ai.status()
  assert.equal(noLlm.available, false)
  assert.equal(noLlm.provider, null)
  assert.equal(noLlm.model, null)
  assert.equal(noLlm.modelSource, 'none')
  assert.ok(typeof noLlm.reason === 'string' && noLlm.reason.length > 0)

  const session = makeAiService({ stream: fakeLlmJson(SAMPLE_PROPOSAL), selection: MODEL_SELECTION }).ai.status()
  assert.equal(session.available, true)
  assert.equal(session.provider, 'deepseek-account')
  assert.equal(session.model, 'deepseek-flash')
  assert.equal(session.modelSource, 'session-default')
  assert.equal(session.reason, null)

  const configured = makeAiService({
    stream: fakeLlmJson(SAMPLE_PROPOSAL), config: { aiProvider: 'cfg-provider', aiModel: 'cfg-model' },
  }).ai.status()
  assert.equal(configured.available, true)
  assert.equal(configured.provider, 'cfg-provider')
  assert.equal(configured.model, 'cfg-model')
  assert.equal(configured.modelSource, 'config')
})

test('AI prompt：中文 system / 用户消息含 PRD、业务线提示与补充要求，并要求只输出 JSON', () => {
  const prompt = buildPrompt({ text: PRD_TEXT, businessLineHint: '增长推广', extraInstructions: '只要 5 个节点' })
  assert.ok(prompt.system.includes('FlowPilot'))
  assert.ok(prompt.system.includes('只输出'))
  assert.ok(prompt.system.includes('JSON'))
  assert.ok(prompt.system.includes('approvalRoles'))
  assert.ok(prompt.system.includes('设计/产品'))
  assert.ok(prompt.user.includes(PRD_TEXT))
  assert.ok(prompt.user.includes('增长推广'))
  assert.ok(prompt.user.includes('只要 5 个节点'))
})

test('parsePrd：fake LLM 成功 → 归一化为契约 §1.3 proposal（字段名/白名单/去重/截断）', async () => {
  const messy = {
    title: '  活动管理改版 ',
    businessLineName: '  ',
    dueAt: '2026-11-20',
    templateId: 'DELIVERY',
    summary: '支持批量创建',
    nodes: [
      { title: '需求接收', detail: 'x'.repeat(300), assigneeRole: 'Design', approvalRoles: ['设计'] },
      { title: ' 需求接收 ', detail: '重复节点', assigneeRole: '研发' },
      { title: '联合确认', assigneeRole: '设计/产品', approvalRoles: ['product', 'design', 'bogus'] },
      { title: '研发实现', assigneeRole: '研发', approvalRoles: ['design'] },
      { title: '', detail: '没有标题' },
    ],
  }
  const { ai } = makeAiService({ stream: fakeLlmJson(messy), selection: MODEL_SELECTION })
  const out = await ai.parsePrd({ text: PRD_TEXT })
  assert.equal(out.ok, true)
  const proposal = out.proposal
  assertShape(proposal, ['title', 'businessLineName', 'dueAt', 'templateId', 'summary', 'nodes', 'notes'], 'proposal')
  assert.equal(proposal.title, '活动管理改版')
  assert.equal(proposal.businessLineName, null, '空白业务线名 → null')
  assert.equal(proposal.dueAt, '2026-11-20T00:00:00.000Z', '日期归一化为 ISO')
  assert.equal(proposal.templateId, 'delivery', 'templateId 小写归一')
  assert.equal(proposal.summary, '支持批量创建')
  assert.equal(proposal.nodes.length, 3, '同名去重 + 空标题丢弃')
  assert.equal(proposal.nodes[0].title, '需求接收')
  assert.equal(proposal.nodes[0].assigneeRole, '设计', 'Design 别名归一')
  assert.equal(proposal.nodes[0].detail.length, 200, 'detail 截 200 字')
  assert.deepEqual(proposal.nodes[0].approvalRoles, [], '非 设计/产品 节点清空 approvalRoles')
  assert.deepEqual(proposal.nodes[1], { title: '联合确认', detail: '', assigneeRole: '设计/产品', approvalRoles: ['design', 'product'] })
  assert.deepEqual(proposal.nodes[2].approvalRoles, [], '显式 研发 节点清空 approvalRoles')
  assert.equal(out.meta.source, 'llm')
  assert.equal(out.meta.provider, 'deepseek-account')
  assert.equal(out.meta.model, 'deepseek-flash')
  assert.equal(out.meta.truncated, false)
  assert.deepEqual(out.meta.usage, { inputTokens: 120, outputTokens: 80 })
  assert.ok(Array.isArray(out.meta.warnings))
  assert.ok(out.meta.ms >= 0)
  assertJsonSerializable(out, 'parsePrd 输出')
})

test('parseModelJson：容忍 ```json 围栏与前后文字；坏 JSON → AI_BAD_OUTPUT', () => {
  assert.equal(parseModelJson('解释\n```json\n{"title":"x","nodes":[]}\n```\n结束').title, 'x')
  assert.equal(parseModelJson('前缀 {"a":{"b":1}} 后缀').a.b, 1)
  expectCode(() => parseModelJson('完全不是 JSON'), 'AI_BAD_OUTPUT')
  expectCode(() => parseModelJson(''), 'AI_BAD_OUTPUT')
  expectCode(() => parseModelJson('[1,2,3]'), 'AI_BAD_OUTPUT')
})

test('parsePrd：坏 JSON → heuristic 兜底（不抛错，meta.source=heuristic）', async () => {
  const { ai } = makeAiService({
    stream: fakeLlm([
      { type: 'text-delta', text: '抱歉，这不是 JSON：{oops' },
      { type: 'finish', reason: { kind: 'stop' } },
    ]),
    selection: MODEL_SELECTION,
  })
  const out = await ai.parsePrd({ text: PRD_TEXT })
  assert.equal(out.ok, true)
  assert.equal(out.meta.source, 'heuristic')
  assert.equal(out.meta.provider, null)
  assert.equal(out.proposal.title, '活动管理改版', '# 一级标题兜底')
  assert.ok(out.proposal.nodes.length >= 1)
  assert.ok(out.meta.warnings.some((warning) => warning.includes('JSON') || warning.includes('规则')))
  assertJsonSerializable(out, 'heuristic 输出')
})

test('parsePrd：模型报错 / 超时 / 无模型 → heuristic 兜底并标注原因', async () => {
  // 1) finish.reason.kind='error'
  const errored = await makeAiService({
    stream: fakeLlm([
      { type: 'text-delta', text: '半截正文' },
      { type: 'finish', reason: { kind: 'error', failure: { message: 'boom' } } },
    ]),
    selection: MODEL_SELECTION,
  }).ai.parsePrd({ text: PRD_TEXT })
  assert.equal(errored.meta.source, 'heuristic')
  assert.ok(errored.meta.warnings.some((warning) => warning.includes('boom')))

  // 2) 超时（aiTimeoutMs=30，模型 300ms 才回）
  const slowStream = function stream() {
    return (async function* generate() {
      await sleep(300)
      throw new Error('aborted')
    })()
  }
  const timedOut = await makeAiService({
    stream: slowStream, selection: MODEL_SELECTION, config: { aiTimeoutMs: 30 },
  }).ai.parsePrd({ text: PRD_TEXT })
  assert.equal(timedOut.meta.source, 'heuristic')
  assert.ok(timedOut.meta.warnings.some((warning) => warning.includes('超时')))

  // 3) 无模型（有 llm 但解析不到 provider/model）
  const noModel = await makeAiService({ stream: fakeLlmJson(SAMPLE_PROPOSAL) }).ai.parsePrd({ text: PRD_TEXT })
  assert.equal(noModel.meta.source, 'heuristic')
  assert.ok(noModel.meta.warnings.some((warning) => warning.includes('模型')))
  assert.equal(noModel.proposal.nodes.length >= 1, true)
})

test('parsePrd：只有 text 非法才抛 INVALID_INPUT；超长文本截断并标 meta.truncated', async () => {
  const { ai } = makeAiService({ stream: fakeLlmJson(SAMPLE_PROPOSAL), selection: MODEL_SELECTION })
  await assert.rejects(() => ai.parsePrd({ text: '太短' }), (error) => error?.code === 'INVALID_INPUT')
  await assert.rejects(() => ai.parsePrd({}), (error) => error?.code === 'INVALID_INPUT')
  const longText = `# 超长 PRD\n${'需求描述。'.repeat(13_000)}`
  assert.ok(longText.length > 60_000)
  const out = await ai.parsePrd({ text: longText })
  assert.equal(out.meta.truncated, true)
  assert.equal(out.meta.source, 'llm')
  assert.ok(out.meta.warnings.some((warning) => warning.includes('截断')))
})

test('normalizeProposal / fallbackParse：字段兜底、包装兼容、表格与默认模板', () => {
  const proposal = normalizeProposal(
    { nodes: [{ title: 'A' }], dueAt: 'not-a-date', templateId: 'nope' },
    { fallbackTitle: 'PRD 标题' },
  )
  assert.equal(proposal.title, 'PRD 标题')
  assert.equal(proposal.businessLineName, null)
  assert.equal(proposal.dueAt, null)
  assert.equal(proposal.templateId, 'custom')
  assert.equal(proposal.summary, '')
  assert.equal(proposal.notes, '')
  assert.deepEqual(proposal.nodes[0], { title: 'A', detail: '', assigneeRole: '设计', approvalRoles: [] })
  const wrapped = normalizeProposal({ proposal: { title: '包一层', nodes: [{ title: 'N1' }] } })
  assert.equal(wrapped.title, '包一层')
  assert.equal(wrapped.nodes.length, 1)

  const fallback = fallbackParse({ text: PRD_TEXT })
  assert.equal(fallback.title, '活动管理改版')
  assert.equal(fallback.templateId, 'custom')
  assert.equal(fallback.nodes.length, 4, '表格「阶段」首列 4 行')
  assert.equal(fallback.nodes[3].title, '验收')
  assert.equal(fallback.nodes[3].assigneeRole, '设计/产品')
  assert.deepEqual(fallback.nodes[3].approvalRoles, ['design', 'product'])

  const delivery = fallbackParse({ text: '没有标题也没有表格的 PRD 文本。' })
  assert.equal(delivery.templateId, 'delivery')
  assert.equal(delivery.nodes.length, 7, '默认 delivery 7 节点')
})

test('createProjectFromNodes：新建业务线 + 项目 + custom 流程 + 节点 + 依赖 + 事件', () => {
  const engine = engineAt(NOW_WED, tempDir())
  const out = dispatchOk(engine, 'createProjectFromNodes', {
    businessLineName: '增长推广',
    title: '活动管理改版',
    dueAt: '2026-11-20T10:00:00.000Z',
    nodes: [
      { title: '需求接收', detail: '记录需求', assigneeRole: '设计' },
      { title: '交互确认', detail: '双方确认', assigneeRole: '设计/产品', approvalRoles: ['design', 'product'] },
      { title: '研发实现', detail: '前端实现', assigneeRole: '研发' },
    ],
  })
  const result = out.result
  assert.equal(result.nodes, 3)
  assert.equal(result.nodeCount, 3)
  assert.equal(result.createdLine, true)
  assertJsonSerializable(result, 'createProjectFromNodes result')

  const state = out.state
  assert.equal(state.businessLines.length, 1)
  assert.equal(state.businessLines[0].name, '增长推广')
  assert.equal(state.projects.length, 1)
  const project = state.projects[0]
  assert.equal(project.title, '活动管理改版')
  assert.equal(project.status, 'active')
  assert.equal(project.dueAt, '2026-11-20T10:00:00.000Z')
  assert.equal(project.businessLineId, result.lineId)
  assert.equal(state.flows.length, 1)
  const flow = state.flows[0]
  assert.equal(flow.templateId, 'custom')
  assert.equal(flow.templateVersion, 1)
  assert.equal(flow.name, 'PRD 流程')
  assert.equal(flow.projectId, project.id)

  const nodes = state.nodes
  assert.deepEqual(nodes.map((node) => node.code), ['X01', 'X02', 'X03'])
  assert.deepEqual(nodes.map((node) => node.status), ['ready', 'locked', 'locked'])
  assert.deepEqual(nodes.map((node) => node.sortOrder), [0, 1, 2])
  assert.deepEqual(nodes[1].approvalRoles, ['design', 'product'])
  assert.deepEqual(nodes[1].approvals, { design: false, product: false })

  const sequence = state.dependencies.filter((dep) => dep.relation === 'sequence')
  assert.equal(sequence.length, 2)
  assert.deepEqual(sequence.map((dep) => [dep.fromNodeId, dep.toNodeId]), [[nodes[0].id, nodes[1].id], [nodes[1].id, nodes[2].id]])
  const returnDep = state.dependencies.find((dep) => dep.relation === 'return')
  assert.ok(returnDep, '双角色确认节点应有 return 边')
  assert.equal(returnDep.fromNodeId, nodes[1].id)
  assert.equal(returnDep.toNodeId, nodes[0].id)

  assert.ok(state.events.some((event) => event.kind === 'projectCreated' && event.projectId === project.id))
  assert.ok(state.events.some((event) => event.kind === 'flowAdded' && event.flowId === flow.id))
  assert.equal(state.events.filter((event) => event.kind === 'nodeAdded').length, 3)
  assert.ok(out.revision >= 1)
  assert.ok(out.derived)

  // 之后 addNode 会触发 rebuildDependencies：custom 流程的 return 边必须仍在
  const added = dispatchOk(engine, 'addNode', { flowId: flow.id, title: '上线复盘', detail: '', assigneeRole: '设计' })
  assert.ok(added.result.nodeId)
  const rebuilt = added.state.dependencies.find((dep) => dep.relation === 'return')
  assert.ok(rebuilt, 'rebuild 后 return 边不能丢')
  assert.equal(rebuilt.fromNodeId, nodes[1].id)
  assert.equal(rebuilt.toNodeId, nodes[0].id)
})

test('createProjectFromNodes：businessLineId 复用已有业务线；非法入参报 INVALID_INPUT', () => {
  const engine = engineAt(NOW_WED, tempDir())
  const line = dispatchOk(engine, 'createLine', { name: '复用线' }).result.line
  const out = dispatchOk(engine, 'createProjectFromNodes', {
    businessLineId: line.id,
    title: '复用项目',
    nodes: [{ title: '只有一个节点', assigneeRole: '设计' }],
  })
  assert.equal(out.result.createdLine, false)
  assert.equal(out.state.businessLines.length, 1)
  assert.equal(out.state.projects[0].businessLineId, line.id)
  assert.equal(out.state.nodes.length, 1)
  assert.equal(out.state.nodes[0].status, 'ready')
  assert.equal(out.state.dependencies.length, 0, '单节点没有依赖')

  expectCode(() => engine.dispatch('createProjectFromNodes', { title: 'x', nodes: [{ title: 'n' }] }), 'INVALID_INPUT')
  expectCode(() => engine.dispatch('createProjectFromNodes', { businessLineId: line.id, title: 'x', nodes: [] }), 'INVALID_INPUT')
  expectCode(() => engine.dispatch('createProjectFromNodes', { businessLineId: line.id, title: 'x', nodes: [{ title: 'n', assigneeRole: '产品' }] }), 'INVALID_INPUT')
  expectCode(() => engine.dispatch('createProjectFromNodes', {
    businessLineId: line.id, title: 'x', nodes: [{ title: 'n', assigneeRole: '设计', approvalRoles: ['design'] }],
  }), 'INVALID_INPUT')
  expectCode(() => engine.dispatch('createProjectFromNodes', { businessLineId: 'bl_missing', title: 'x', nodes: [{ title: 'n' }] }), 'NOT_FOUND')
})

test('createProjectFromNodes：首节点始终 ready（即使负责角色是研发），其余 locked', () => {
  const engine = engineAt(NOW_WED, tempDir())
  const out = dispatchOk(engine, 'createProjectFromNodes', {
    businessLineName: '研发线',
    title: '研发先行',
    nodes: [
      { title: '研发提交', assigneeRole: '研发' },
      { title: '设计验收', assigneeRole: '设计' },
    ],
  })
  assert.deepEqual(out.state.nodes.map((node) => node.status), ['ready', 'locked'])
})

test('applyProposal：复用已有业务线 / 新建业务线两条路径；空节点与无业务线报 INVALID_INPUT', async () => {
  const { engine, ai } = makeAiService({ stream: fakeLlmJson(SAMPLE_PROPOSAL), selection: MODEL_SELECTION })
  dispatchOk(engine, 'createLine', { name: '增长推广' })
  const parsed = await ai.parsePrd({ text: PRD_TEXT })
  assert.equal(parsed.meta.source, 'llm')
  const proposal = parsed.proposal

  const reused = await ai.applyProposal({ proposal })
  assert.equal(reused.ok, true)
  assert.ok(reused.projectId)
  assert.equal(reused.nodeCount, 3)
  assert.equal(typeof reused.revision, 'number')
  assert.ok(reused.state)
  assert.ok(reused.derived)
  assert.equal(reused.result.createdLine, false, '已有同名业务线应复用')
  assert.equal(reused.state.businessLines.length, 1)
  assert.equal(reused.state.projects.length, 1)
  assert.equal(reused.state.projects[0].title, '活动管理改版')

  const newLine = await ai.applyProposal({ proposal: { ...proposal, title: '第二条 PRD', businessLineName: '新业务线' } })
  assert.equal(newLine.result.createdLine, true)
  assert.equal(newLine.state.businessLines.length, 2)
  assert.equal(newLine.state.projects.length, 2)
  assert.equal(newLine.state.projects[1].businessLineId, newLine.lineId)
  assert.ok(newLine.revision > reused.revision, '写库后 revision 递增')

  // businessLineId 显式指定优先于 proposal.businessLineName
  const existingLine = newLine.state.businessLines.find((line) => line.name === '增长推广')
  const explicit = await ai.applyProposal({ proposal: { ...proposal, title: '指定业务线项目' }, businessLineId: existingLine.id })
  assert.equal(explicit.result.createdLine, false)
  assert.equal(explicit.result.lineId, existingLine.id)

  await assert.rejects(
    () => ai.applyProposal({ proposal: { ...proposal, nodes: [] } }),
    (error) => error?.code === 'INVALID_INPUT',
  )
  await assert.rejects(
    () => ai.applyProposal({ proposal: { ...proposal, businessLineName: null } }),
    (error) => error?.code === 'INVALID_INPUT',
  )
})

function aiRouteMap(engine, aiService) {
  const routes = createRoutes({ engine, aiService, logger: quietLogger })
  return new Map(routes.map(({ path, handler }) => [path, handler]))
}

test('AI 路由：GET status / POST parse / POST apply 正常 + 400/403/405', async () => {
  const { engine, ai } = makeAiService({ stream: fakeLlmJson(SAMPLE_PROPOSAL), selection: MODEL_SELECTION })
  const routes = aiRouteMap(engine, ai)

  const status = await callRoute(routes.get(API_PATHS.aiStatus), { method: 'GET', headers: { host: 'h' } })
  assert.equal(status.status, 200)
  assert.deepEqual(
    Object.keys(status.json).sort(),
    ['available', 'model', 'modelSource', 'ok', 'provider', 'reason'].sort(),
  )
  assert.equal(status.json.ok, true)
  assert.equal(status.json.available, true)
  assert.equal(status.json.provider, 'deepseek-account')
  assert.equal(status.json.model, 'deepseek-flash')
  assert.equal(status.json.modelSource, 'session-default')

  const badMethod = await callRoute(routes.get(API_PATHS.aiStatus), { method: 'POST', headers: { host: 'h' } })
  assert.equal(badMethod.status, 405)
  const crossSite = await callRoute(routes.get(API_PATHS.aiParse), {
    method: 'POST', headers: { host: 'h', origin: 'https://evil.example.com' }, body: '{}',
  })
  assert.equal(crossSite.status, 403)

  const parse = await callRoute(routes.get(API_PATHS.aiParse), {
    method: 'POST', headers: { host: 'h' }, body: JSON.stringify({ text: PRD_TEXT }),
  })
  assert.equal(parse.status, 200)
  assert.equal(parse.json.ok, true)
  assert.equal(parse.json.proposal.title, '活动管理改版')
  assert.equal(parse.json.meta.source, 'llm')

  const shortParse = await callRoute(routes.get(API_PATHS.aiParse), {
    method: 'POST', headers: { host: 'h' }, body: JSON.stringify({ text: '短' }),
  })
  assert.equal(shortParse.status, 400)
  assert.equal(shortParse.json.code, 'INVALID_INPUT')

  const apply = await callRoute(routes.get(API_PATHS.aiApply), {
    method: 'POST', headers: { host: 'h' }, body: JSON.stringify({ proposal: parse.json.proposal }),
  })
  assert.equal(apply.status, 200)
  assert.equal(apply.json.ok, true)
  assert.ok(apply.json.projectId)
  assert.equal(apply.json.nodeCount, 3)
  assert.equal(typeof apply.json.revision, 'number')
  assert.ok(apply.json.state && apply.json.derived && apply.json.result)
  assert.equal(apply.json.state.projects.length, 1)
  assert.equal(apply.json.result.createdLine, true, '提案里的业务线名不存在 → 新建')

  const badApply = await callRoute(routes.get(API_PATHS.aiApply), {
    method: 'POST', headers: { host: 'h' }, body: JSON.stringify({ proposal: { ...parse.json.proposal, nodes: [] } }),
  })
  assert.equal(badApply.status, 400)
  assert.equal(badApply.json.code, 'INVALID_INPUT')
})

test('AI 路由在未传 aiService 时降级（status 报不可用，parse/apply 503）', async () => {
  const engine = engineAt(NOW_WED, tempDir())
  const routes = aiRouteMap(engine, undefined)
  const status = await callRoute(routes.get(API_PATHS.aiStatus), { method: 'GET', headers: { host: 'h' } })
  assert.equal(status.status, 200)
  assert.equal(status.json.ok, true)
  assert.equal(status.json.available, false)
  assert.equal(status.json.modelSource, 'none')
  const parse = await callRoute(routes.get(API_PATHS.aiParse), {
    method: 'POST', headers: { host: 'h' }, body: JSON.stringify({ text: PRD_TEXT }),
  })
  assert.equal(parse.status, 503)
  assert.equal(parse.json.ok, false)
  const apply = await callRoute(routes.get(API_PATHS.aiApply), {
    method: 'POST', headers: { host: 'h' }, body: JSON.stringify({ proposal: SAMPLE_PROPOSAL }),
  })
  assert.equal(apply.status, 503)
})

test('AI 工具 action：parsePrd 只解析不落库；createProjectFromPrd 解析并建项目', async () => {
  const { ctx, tools } = makeFakeCtx({
    llmStream: fakeLlmJson(SAMPLE_PROPOSAL),
    selection: MODEL_SELECTION,
  })
  host.apply(ctx, { dataDir: tempDir() })
  const tool = tools[0]

  const parsed = await tool.execute({ action: 'parsePrd', text: PRD_TEXT, businessLineHint: '增长推广' }, {})
  assert.equal(parsed.ok, true)
  assert.equal(parsed.action, 'parsePrd')
  assert.equal(parsed.result.meta.source, 'llm')
  assert.equal(parsed.result.proposal.nodes.length, 3)
  assert.ok(parsed.summary.includes('节点'))
  assertJsonSerializable(parsed, 'parsePrd tool result')
  const before = await tool.execute({ action: 'overview' }, {})
  assert.equal(before.result.projects.length, 0, 'parsePrd 不能落库')

  const invalid = await tool.execute({ action: 'parsePrd', text: '短' }, {})
  assert.equal(invalid.ok, false)
  assert.equal(invalid.code, 'INVALID_INPUT')

  const created = await tool.execute({ action: 'createProjectFromPrd', text: PRD_TEXT, businessLineName: 'PRD 业务线' }, {})
  assert.equal(created.ok, true)
  assert.equal(created.action, 'createProjectFromPrd')
  assert.ok(created.result.projectId)
  assert.equal(created.result.title, '活动管理改版')
  assert.equal(created.result.lineName, 'PRD 业务线')
  assert.equal(created.result.nodeCount, 3)
  assert.equal(typeof created.revision, 'number')
  assert.equal(typeof created.summary, 'string')
  assertJsonSerializable(created, 'createProjectFromPrd tool result')
  const after = await tool.execute({ action: 'overview' }, {})
  assert.equal(after.result.projects.length, 1)
  assert.equal(after.result.projects[0].title, '活动管理改版')
  assert.equal(after.result.projects[0].businessLineName, 'PRD 业务线')
})

test('AI 工具 createProjectFromPrd：无模型时走规则解析也能建项目', async () => {
  const { ctx, tools } = makeFakeCtx({})
  host.apply(ctx, { dataDir: tempDir() })
  const created = await tools[0].execute({ action: 'createProjectFromPrd', text: PRD_TEXT, businessLineName: '规则线' }, {})
  assert.equal(created.ok, true)
  assert.ok(created.result.projectId)
  assert.equal(created.result.nodeCount, 4, '表格 4 行')
  assert.ok(created.summary.includes('规则解析'))
})

/* ------------------------------------------------------------------ *
 * 8. 双向同步（SYNC.md）：本地 node:http mock（GitHub Contents / WebDAV）
 *    全部用临时 dataDir + 临时 syncFile（mkdtemp），不碰真实 ~/.dsh。
 * ------------------------------------------------------------------ */

group('同步 · GitHub / WebDAV（mock HTTP）')

const mockServers = []

/**
 * 起一个本地 mock HTTP 服务，记录每个请求；返回 {server, url, requests, concurrency, close()}。
 * options.delayMs() 可给每个响应加延迟（防重入测试用，模拟慢同步）；
 * concurrency.max 记录同时在飞请求数的峰值，用来断言「同步不会并发跑两次」。
 */
function startMockServer(handler, options = {}) {
  return new Promise((resolve, reject) => {
    const requests = []
    const delayOf = typeof options.delayMs === 'function' ? options.delayMs : null
    let active = 0
    let maxActive = 0
    const server = createServer((req, res) => {
      active += 1
      if (active > maxActive) maxActive = active
      res.on('close', () => { active = Math.max(0, active - 1) })
      const chunks = []
      req.on('data', (chunk) => { chunks.push(chunk) })
      req.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8')
        requests.push({ method: req.method, url: req.url, headers: req.headers, body })
        const respond = () => {
          try {
            handler(req, res, body)
          } catch (error) {
            try {
              res.writeHead(500, { 'content-type': 'text/plain' })
              res.end(`mock error: ${error?.message ?? error}`)
            } catch { /* 忽略 */ }
          }
        }
        const delay = delayOf === null ? 0 : Number(delayOf())
        if (Number.isFinite(delay) && delay > 0) {
          const timer = setTimeout(respond, delay)
          try { timer.unref?.() } catch { /* 忽略 */ }
        } else {
          respond()
        }
      })
    })
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const mock = {
        server,
        requests,
        url: `http://127.0.0.1:${server.address().port}`,
        concurrency: {
          get active() { return active },
          get max() { return maxActive },
          reset() { maxActive = active },
        },
        close() {
          try { server.closeAllConnections?.() } catch { /* 忽略 */ }
          try { server.close() } catch { /* 忽略 */ }
        },
      }
      mockServers.push(mock)
      resolve(mock)
    })
  })
}

function sendMock(res, status, payload, headers = {}) {
  const body = typeof payload === 'string' ? payload : JSON.stringify(payload)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body), ...headers })
  res.end(body)
}

/** GitHub Contents API mock（可注入 401/404/409/422/5xx；delayMs 可模拟慢响应，用于防重入测试）。 */
async function githubMock({ token = 'test-token', owner = 'acme', repo = 'flowpilot', delayMs = 0 } = {}) {
  const state = { token, files: new Map(), shaSeq: 0, puts: 0, gets: 0, forceStatus: null, failNext: 0, delayMs }
  const mock = await startMockServer((req, res, body) => {
    if (state.forceStatus) { sendMock(res, state.forceStatus, { message: 'forced failure' }); return }
    if (state.failNext > 0) { state.failNext -= 1; sendMock(res, 500, { message: 'boom' }); return }
    if ((req.headers.authorization ?? '') !== `Bearer ${state.token}`) {
      sendMock(res, 401, { message: 'Bad credentials' })
      return
    }
    const url = new URL(req.url, 'http://mock.local')
    const prefix = `/repos/${owner}/${repo}/contents/`
    if (!url.pathname.startsWith(prefix)) { sendMock(res, 404, { message: 'Not Found' }); return }
    const filePath = decodeURIComponent(url.pathname.slice(prefix.length))
    if (req.method === 'GET') {
      state.gets += 1
      const entry = state.files.get(filePath)
      if (!entry) { sendMock(res, 404, { message: 'Not Found' }); return }
      sendMock(res, 200, {
        content: Buffer.from(entry.text, 'utf8').toString('base64'),
        sha: entry.sha,
        size: Buffer.byteLength(entry.text),
        encoding: 'base64',
      })
      return
    }
    if (req.method === 'PUT') {
      let payload
      try { payload = JSON.parse(body) } catch { sendMock(res, 400, { message: 'bad json' }); return }
      const entry = state.files.get(filePath)
      if (payload.sha && (!entry || entry.sha !== payload.sha)) { sendMock(res, 409, { message: 'sha mismatch' }); return }
      if (!payload.sha && entry) { sendMock(res, 422, { message: 'sha required' }); return }
      const textBody = Buffer.from(String(payload.content ?? ''), 'base64').toString('utf8')
      const sha = `sha_${++state.shaSeq}`
      state.files.set(filePath, { text: textBody, sha })
      state.puts += 1
      sendMock(res, 200, { content: { sha }, commit: { sha: `commit_${state.shaSeq}` } })
      return
    }
    sendMock(res, 405, { message: 'method not allowed' })
  }, { delayMs: () => state.delayMs })
  return {
    ...mock,
    state,
    readSnapshot: (filePath) => {
      const entry = state.files.get(filePath)
      return entry ? JSON.parse(entry.text) : null
    },
    writeRemote: (filePath, object) => {
      const sha = `sha_${++state.shaSeq}`
      state.files.set(filePath, { text: JSON.stringify(object), sha })
      return sha
    },
    setRaw: (filePath, raw) => {
      const sha = `sha_${++state.shaSeq}`
      state.files.set(filePath, { text: raw, sha })
      return sha
    },
  }
}

/** WebDAV mock（PROPFIND / MKCOL / GET / PUT；可注入 401/405/412/404/5xx）。 */
async function davMock({ username = 'davuser', password = 'davpass', propfindStatus = null } = {}) {
  const state = {
    username, password, propfindStatus,
    files: new Map(), dirs: new Set(), etagSeq: 0,
    puts: 0, mkcols: 0, forceStatus: null, putPrecondition: null,
  }
  const mock = await startMockServer((req, res, body) => {
    if (state.forceStatus) { sendMock(res, state.forceStatus, 'forced failure'); return }
    const expectedAuth = `Basic ${Buffer.from(`${state.username}:${state.password}`).toString('base64')}`
    if ((req.headers.authorization ?? '') !== expectedAuth) { sendMock(res, 401, 'unauthorized'); return }
    const url = new URL(req.url, 'http://mock.local')
    const pathname = decodeURIComponent(url.pathname)
    if (req.method === 'PROPFIND') {
      if (state.propfindStatus) { res.writeHead(state.propfindStatus); res.end(''); return }
      if (!state.dirs.has(pathname)) { sendMock(res, 404, 'not found'); return }
      res.writeHead(207, { 'content-type': 'application/xml; charset=utf-8' })
      res.end('<?xml version="1.0" encoding="utf-8"?><d:multistatus xmlns:d="DAV:"/>')
      return
    }
    if (req.method === 'OPTIONS') {
      res.writeHead(200, { allow: 'OPTIONS, GET, PUT, PROPFIND, MKCOL' })
      res.end()
      return
    }
    if (req.method === 'MKCOL') {
      state.mkcols += 1
      const parent = pathname.slice(0, pathname.lastIndexOf('/')) || '/'
      if (state.dirs.has(pathname)) { res.writeHead(405); res.end(); return }
      if (parent !== '/' && !state.dirs.has(parent)) { res.writeHead(409); res.end(); return }
      state.dirs.add(pathname)
      res.writeHead(201)
      res.end()
      return
    }
    if (req.method === 'GET') {
      const entry = state.files.get(pathname)
      if (!entry) { sendMock(res, 404, 'not found'); return }
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', etag: entry.etag, 'last-modified': entry.lastModified })
      res.end(entry.text)
      return
    }
    if (req.method === 'PUT') {
      if (state.putPrecondition === 'stale') { sendMock(res, 412, 'precondition failed'); return }
      const entry = state.files.get(pathname)
      const ifNoneMatch = req.headers['if-none-match']
      const ifMatch = req.headers['if-match']
      if (ifNoneMatch === '*' && entry) { sendMock(res, 412, 'precondition failed'); return }
      if (ifMatch && (!entry || entry.etag !== ifMatch)) { sendMock(res, 412, 'precondition failed'); return }
      const parent = pathname.slice(0, pathname.lastIndexOf('/')) || '/'
      if (parent !== '/' && !state.dirs.has(parent)) { sendMock(res, 404, 'parent missing'); return }
      const etag = `"etag-${++state.etagSeq}"`
      state.files.set(pathname, { text: body, etag, lastModified: new Date().toISOString() })
      state.puts += 1
      res.writeHead(201, { etag })
      res.end()
      return
    }
    sendMock(res, 405, 'method not allowed')
  })
  return {
    ...mock,
    state,
    ensureDir: (pathname) => { state.dirs.add(pathname) },
    readSnapshot: (pathname) => {
      const entry = state.files.get(pathname)
      return entry ? JSON.parse(entry.text) : null
    },
    writeRemote: (pathname, object) => {
      const etag = `"etag-${++state.etagSeq}"`
      state.files.set(pathname, { text: JSON.stringify(object), etag, lastModified: new Date().toISOString() })
      return etag
    },
    setRaw: (pathname, raw) => {
      const etag = `"etag-${++state.etagSeq}"`
      state.files.set(pathname, { text: raw, etag, lastModified: new Date().toISOString() })
      return etag
    },
  }
}

function makeSyncFixture(options = {}) {
  const dataDir = options.dataDir ?? tempDir()
  const engine = engineAt(options.now ?? NOW_WED, dataDir)
  const syncFile = options.syncFile ?? join(dataDir, 'sync.json')
  const service = createSyncService({ engine, store: engine.store, logger: quietLogger, config: { syncFile } })
  return { dataDir, engine, service, syncFile }
}

/** 远端快照（SYNC.md §1.2）。 */
function syncSnapshot(revision, state, extra = {}) {
  const at = isoOf(NOW_WED)
  return {
    formatVersion: 1,
    app: 'flowpilot',
    kind: 'sync-snapshot',
    revision,
    savedAt: at,
    updatedAt: at,
    deviceId: extra.deviceId ?? 'dev_remote',
    state,
  }
}

/** 一份形状完整的示例 state（createDemoState 是纯函数，不落盘）。 */
function demoState() {
  return createDemoState(NOW_WED)
}

function configureGithub(service, mock, options = {}) {
  const github = {
    owner: 'acme',
    repo: 'flowpilot',
    branch: 'main',
    path: 'flowpilot/data.json',
    apiBase: mock.url,
    ...(options.github ?? {}),
  }
  return service.configure({ provider: 'github', github, secrets: { githubToken: options.token ?? 'test-token' } })
}

async function expectRejectCode(fn, code) {
  try {
    await fn()
  } catch (error) {
    assert.equal(error?.code, code, `期望错误码 ${code}，实际 ${error?.code}：${error?.message}`)
    return error
  }
  assert.fail(`期望抛出 ${code}，但没有抛错`)
}

function backupFiles(dataDir) {
  const dir = join(dataDir, 'backups')
  if (!existsSync(dir)) return []
  return readdirSync(dir).filter((name) => name.startsWith('pre-sync-') && name.endsWith('.json'))
}

test('sync status：未配置时默认关闭、字段完整、不落盘', () => {
  const { service, dataDir, syncFile } = makeSyncFixture()
  assert.equal(existsSync(syncFile), false)
  const status = service.status()
  assert.equal(status.provider, 'off')
  assert.equal(status.providerLabel, '未启用')
  assert.equal(status.configured, false)
  assert.equal(status.credentialsSet, false)
  assert.equal(status.remoteTarget, null)
  assert.deepEqual(status.behavior, { autoPushAfterWrite: true, autoPullOnStart: false })
  assert.equal(status.localRevision, 0)
  assert.equal(status.localUpdatedAt, null)
  assert.deepEqual(status.localCounts, { businessLines: 0, projects: 0, nodes: 0, events: 0 })
  assert.equal(status.lastSyncedAt, null)
  assert.equal(status.lastSyncedRevision, null)
  assert.equal(status.hasPendingChanges, false)
  assert.equal(status.lastError, null)
  assert.equal(status.lastErrorAt, null)
  assert.ok(String(status.deviceId).startsWith('dev_'))
  assert.equal(service.status().deviceId, status.deviceId, '未落盘前多次 status 的 deviceId 也应稳定')
  assert.equal(status.dataFile, join(dataDir, 'data.json'))
  assert.equal(status.githubCredentialsSet, false)
  assert.equal(status.webdavCredentialsSet, false)
  assert.deepEqual(status.config, {
    provider: 'off',
    github: {
      owner: '', repo: '', branch: 'main', path: 'flowpilot/data.json', apiBase: 'https://api.github.com',
    },
    webdav: { url: '', username: '', fileName: 'data.json' },
    // 写后自动同步默认开启（undefined 视为 true）
    behavior: { autoPushAfterWrite: true, autoPullOnStart: false },
  }, 'status.config 是非敏感配置回显（供设置面板回填表单），不含 token/password')
  assert.deepEqual(
    Object.keys(status).sort(),
    ['behavior', 'config', 'configured', 'credentialsSet', 'dataFile', 'deviceId', 'githubCredentialsSet',
      'hasPendingChanges', 'lastError', 'lastErrorAt', 'lastSyncedAt', 'lastSyncedRevision', 'localCounts',
      'localRevision', 'localUpdatedAt', 'provider', 'providerLabel', 'remoteTarget', 'webdavCredentialsSet'].sort(),
    'status 字段必须与 SYNC.md §2.1 + config 回显一致',
  )
  assert.equal(existsSync(syncFile), false, 'status 只读，不应创建 sync.json')
})

test('sync configure：配置/凭据写本机 sync.json（目录 0700 / 文件 0600），status 不回显密钥', async () => {
  const mock = await githubMock()
  const dataDir = tempDir()
  const syncFile = join(dataDir, 'config', 'sync.json')
  const { service } = makeSyncFixture({ dataDir, syncFile })
  const status = configureGithub(service, mock)
  assert.equal(status.provider, 'github')
  assert.equal(status.providerLabel, 'GitHub 仓库')
  assert.equal(status.configured, true)
  assert.equal(status.credentialsSet, true)
  assert.equal(status.remoteTarget, 'acme/flowpilot@main:flowpilot/data.json')
  assert.equal(status.githubCredentialsSet, true)
  assert.equal(status.webdavCredentialsSet, false)
  assert.equal(status.config.provider, 'github')
  assert.deepEqual(status.config.github, {
    owner: 'acme', repo: 'flowpilot', branch: 'main', path: 'flowpilot/data.json', apiBase: mock.url,
  }, 'config.github 回显非敏感字段（供表单回填）')
  assert.deepEqual(status.config.webdav, { url: '', username: '', fileName: 'data.json' })
  assert.deepEqual(status.config.behavior, { autoPushAfterWrite: true, autoPullOnStart: false })
  assert.ok(!JSON.stringify(status.config).includes('token'), 'status.config 不能含凭据')
  assert.equal(statSync(join(dataDir, 'config')).mode & 0o777, 0o700, '配置目录必须是 0700')
  assert.equal(statSync(syncFile).mode & 0o777, 0o600, '配置文件必须是 0600')
  const saved = JSON.parse(readFileSync(syncFile, 'utf8'))
  assert.equal(saved.version, 1)
  assert.equal(saved.github.token, 'test-token', '凭据只在本地 sync.json')
  assert.ok(!JSON.stringify(status).includes('test-token'), 'status 绝不能回显 token')
  assert.equal(existsSync(join(dataDir, 'data.json')), false, '保存配置不应写 data.json')
  // 凭据留空 = 保持不变（UI 占位「已保存，留空则不修改」）
  const again = service.configure({ provider: 'github', github: { owner: 'acme-2' } })
  assert.equal(again.credentialsSet, true)
  assert.equal(again.configured, true)
  assert.equal(JSON.parse(readFileSync(syncFile, 'utf8')).github.token, 'test-token')
  assert.equal(again.remoteTarget, 'acme-2/flowpilot@main:flowpilot/data.json')
})

test('sync configure：非法 provider / URL / owner 报 INVALID_INPUT；缺字段时 configured=false', () => {
  const { service } = makeSyncFixture()
  expectCode(() => service.configure({ provider: 'dropbox' }), 'INVALID_INPUT')
  expectCode(() => service.configure({ webdav: { url: 'ftp://dav.example.com' } }), 'INVALID_INPUT')
  expectCode(() => service.configure({ github: { apiBase: 'not-a-url' } }), 'INVALID_INPUT')
  expectCode(() => service.configure({ github: { owner: 'a/b' } }), 'INVALID_INPUT')
  expectCode(() => service.configure({ behavior: { debounceMs: -1 } }), 'INVALID_INPUT')
  const status = service.configure({ provider: 'github', github: { owner: 'acme', repo: 'flowpilot' } })
  assert.equal(status.provider, 'github')
  assert.equal(status.configured, false, '缺 token → configured=false')
  assert.equal(status.credentialsSet, false)
})

test('sync configure 深合并：切通道不清另一通道配置；undefined 保值、secrets 空串清除、status 回显可回填', () => {
  const { service } = makeSyncFixture()
  service.configure({
    provider: 'github',
    github: {
      owner: 'acme', repo: 'flowpilot', branch: 'main', path: 'flowpilot/data.json',
      apiBase: 'https://ghe.example.com/api/v3',
    },
    behavior: { autoPushAfterWrite: true },
    secrets: { githubToken: 'tok-a', webdavPassword: 'dav-a' },
  })
  // 切到 WebDAV：只传 provider + webdav，不应清掉已保存的 github 配置 / 凭据 / behavior
  const switched = service.configure({
    provider: 'webdav',
    webdav: { url: 'https://dav.example.com/dav/flowpilot', username: 'dav-user', fileName: 'fp.json' },
  })
  assert.equal(switched.provider, 'webdav')
  assert.equal(switched.config.github.owner, 'acme', '切通道不能清掉另一通道配置')
  assert.equal(switched.config.github.apiBase, 'https://ghe.example.com/api/v3')
  assert.equal(switched.githubCredentialsSet, true, 'github token 应保留')
  assert.equal(switched.webdavCredentialsSet, true, 'webdav password 应保留')
  assert.equal(switched.behavior.autoPushAfterWrite, true, '未传的 behavior 应保留')
  assert.equal(switched.config.webdav.username, 'dav-user')
  assert.equal(switched.config.webdav.fileName, 'fp.json')
  // undefined / 缺省字段不覆盖
  const kept = service.configure({ github: { repo: 'flowpilot-2' } })
  assert.equal(kept.config.github.owner, 'acme')
  assert.equal(kept.config.github.repo, 'flowpilot-2')
  assert.equal(kept.githubCredentialsSet, true)
  // 显式空串 = 清除该凭据（不清非敏感配置）
  const clearedGithub = service.configure({ secrets: { githubToken: '' } })
  assert.equal(clearedGithub.githubCredentialsSet, false)
  assert.equal(clearedGithub.config.github.owner, 'acme')
  const clearedDav = service.configure({ secrets: { webdavPassword: '' } })
  assert.equal(clearedDav.webdavCredentialsSet, false)
  assert.equal(clearedDav.config.webdav.username, 'dav-user')
  // status 任何位置都不能出现凭据明文
  const serialized = JSON.stringify(service.status())
  assert.ok(!serialized.includes('tok-a'))
  assert.ok(!serialized.includes('dav-a'))
})

test('sync test（GitHub）：远端无快照 → remoteFound=false；有快照 → revision/bytes/latency', async () => {
  const mock = await githubMock()
  const { service } = makeSyncFixture()
  configureGithub(service, mock)
  const empty = await service.test()
  assert.equal(empty.provider, 'github')
  assert.equal(empty.reachable, true)
  assert.equal(empty.remoteFound, false)
  assert.equal(empty.remoteRevision, null)
  assert.ok(empty.message.includes('还没有快照'))
  mock.writeRemote('flowpilot/data.json', syncSnapshot(12, demoState()))
  const detail = await service.test()
  assert.equal(detail.remoteFound, true)
  assert.equal(detail.remoteRevision, 12)
  assert.ok(detail.remoteBytes > 0)
  assert.ok(Number.isInteger(detail.latencyMs) && detail.latencyMs >= 0)
  assert.ok(detail.message.includes('acme/flowpilot@main'))
  assert.ok(detail.message.includes('r12'))
  assert.equal(service.status().lastError, null)
})

test('sync test 失败：未配置 → SYNC_NOT_CONFIGURED；401 → SYNC_AUTH_FAILED 且 status.lastError 有值', async () => {
  const mock = await githubMock()
  const { service } = makeSyncFixture()
  await expectRejectCode(() => service.test(), 'SYNC_NOT_CONFIGURED')
  configureGithub(service, mock, { token: 'wrong-token' })
  const error = await expectRejectCode(() => service.test(), 'SYNC_AUTH_FAILED')
  assert.ok(error.message.includes('401'))
  const status = service.status()
  assert.ok(status.lastError.includes('401'))
  assert.ok(!Number.isNaN(Date.parse(status.lastErrorAt)))
  // 改回正确凭据并测试成功 → lastError 清空
  configureGithub(service, mock)
  await service.test()
  assert.equal(service.status().lastError, null)
  assert.equal(service.status().lastErrorAt, null)
})

test('sync test（WebDAV）：PROPFIND 成功 / 405 退化 OPTIONS / 目录缺失也可达', async () => {
  const mock = await davMock()
  const { service } = makeSyncFixture()
  service.configure({
    provider: 'webdav',
    webdav: { url: `${mock.url}/dav/flowpilot`, username: 'davuser', password: 'davpass', fileName: 'data.json' },
  })
  assert.equal(service.status().configured, true)
  assert.equal(service.status().credentialsSet, true)
  assert.equal(service.status().remoteTarget, `${mock.url}/dav/flowpilot/data.json`)
  const missing = await service.test()
  assert.equal(missing.reachable, true)
  assert.equal(missing.remoteFound, false)
  mock.ensureDir('/dav')
  mock.ensureDir('/dav/flowpilot')
  mock.writeRemote('/dav/flowpilot/data.json', syncSnapshot(7, demoState()))
  const detail = await service.test()
  assert.equal(detail.provider, 'webdav')
  assert.equal(detail.remoteFound, true)
  assert.equal(detail.remoteRevision, 7)
  // PROPFIND 405 → 退化为 OPTIONS
  const optionsMock = await davMock({ propfindStatus: 405 })
  const fixture = makeSyncFixture()
  fixture.service.configure({
    provider: 'webdav',
    webdav: { url: `${optionsMock.url}/dav`, username: 'davuser', password: 'davpass' },
  })
  const viaOptions = await fixture.service.test()
  assert.equal(viaOptions.reachable, true)
  assert.ok(optionsMock.requests.some((request) => request.method === 'OPTIONS'), '应退化为 OPTIONS')
})

test('sync 首次 push（GitHub）：远端为空 → 上传快照、记录 lastSyncedRevision / lastRemoteRef，再 run 为 noop', async () => {
  const mock = await githubMock()
  const { engine, service } = makeSyncFixture()
  const seeded = dispatchOk(engine, 'seedDemo')
  configureGithub(service, mock)
  const out = await service.push({})
  assert.equal(out.action, 'push')
  assert.equal(out.revision, seeded.revision)
  assert.ok(out.bytes > 0)
  assert.equal(typeof out.remote.ref, 'string')
  const remote = mock.readSnapshot('flowpilot/data.json')
  assert.equal(remote.kind, 'sync-snapshot')
  assert.equal(remote.revision, seeded.revision)
  assert.equal(remote.state.projects.length, 4)
  const status = service.status()
  assert.equal(status.lastSyncedRevision, seeded.revision)
  assert.equal(status.hasPendingChanges, false)
  assert.ok(!Number.isNaN(Date.parse(status.lastSyncedAt)))
  const saved = JSON.parse(readFileSync(service.syncFile, 'utf8'))
  assert.ok(String(saved.state.lastRemoteRef).startsWith('sha_'))
  // 默认模式已改为 merge；这里显式回旧三路比较（本用例断言 noop 语义）
  const noop = await service.run({ mode: 'three-way' })
  assert.equal(noop.action, 'noop')
  assert.equal(noop.local.revision, seeded.revision)
  assert.equal(noop.remote.revision, seeded.revision)
})

test('sync 首次 pull（GitHub）：本地空 + 远端有快照 → 覆盖本地、写 data.json、生成 pre-sync 备份', async () => {
  const mock = await githubMock()
  const { engine, service, dataDir } = makeSyncFixture()
  mock.writeRemote('flowpilot/data.json', syncSnapshot(12, demoState()))
  configureGithub(service, mock)
  const out = await service.pull({})
  assert.equal(out.action, 'pull')
  assert.equal(out.revision, 12)
  assert.equal(out.applied, true)
  assert.ok(existsSync(out.backupPath), '覆盖本地前必须生成备份')
  const backup = JSON.parse(readFileSync(out.backupPath, 'utf8'))
  assert.equal(backup.kind, 'backup')
  assert.ok(Array.isArray(backup.state.projects))
  const local = engine.snapshot()
  assert.equal(local.revision, 12)
  assert.equal(local.state.projects.length, 4)
  const savedData = JSON.parse(readFileSync(join(dataDir, 'data.json'), 'utf8'))
  assert.equal(savedData.revision, 12)
  assert.equal(savedData.state.projects.length, 4)
  assert.equal(service.status().lastSyncedRevision, 12)
  assert.equal(backupFiles(dataDir).length, 1)
})

test('sync 快进 pull：远端 revision 变化、本地未改 → run 自动 pull 并备份', async () => {
  const mock = await githubMock()
  const { engine, service } = makeSyncFixture()
  dispatchOk(engine, 'seedDemo')
  configureGithub(service, mock)
  const pushed = await service.push({})
  const remoteState = demoState()
  remoteState.businessLines.push({ id: 'bl_remote', name: '远端新增线', sortOrder: 9 })
  mock.writeRemote('flowpilot/data.json', syncSnapshot(pushed.revision + 20, remoteState))
  const out = await service.run({ mode: 'three-way' })
  assert.equal(out.action, 'pull')
  assert.equal(out.applied, true)
  assert.ok(existsSync(out.backupPath))
  assert.equal(out.local.revision, pushed.revision, 'run 响应应带同步前的 local 摘要（SYNC.md §2.3）')
  assert.equal(engine.snapshot().revision, pushed.revision + 20)
  assert.ok(engine.snapshot().state.businessLines.some((line) => line.id === 'bl_remote'))
  assert.equal(service.status().hasPendingChanges, false)
})

test('sync 快进 push：本地 revision 变化、远端未改 → run 自动 push', async () => {
  const mock = await githubMock()
  const { engine, service } = makeSyncFixture()
  dispatchOk(engine, 'seedDemo')
  configureGithub(service, mock)
  await service.push({})
  const local = dispatchOk(engine, 'createLine', { name: '本地新增线' })
  const out = await service.run({ mode: 'three-way' })
  assert.equal(out.action, 'push')
  assert.equal(out.revision, local.revision)
  assert.equal(mock.readSnapshot('flowpilot/data.json').revision, local.revision)
  assert.equal(service.status().lastSyncedRevision, local.revision)
  assert.equal(service.status().hasPendingChanges, false)
})

test('sync 双向冲突：本地与远端都改过 → 409 SYNC_CONFLICT（conflict.options），本地不被写', async () => {
  const mock = await githubMock()
  const { engine, service } = makeSyncFixture()
  dispatchOk(engine, 'seedDemo')
  configureGithub(service, mock)
  const pushed = await service.push({})
  const localAfter = dispatchOk(engine, 'createLine', { name: '本地冲突线' })
  const remoteState = demoState()
  remoteState.projects[0].title = '远端改名的项目'
  mock.writeRemote('flowpilot/data.json', syncSnapshot(pushed.revision + 30, remoteState))
  const error = await expectRejectCode(() => service.run({ mode: 'three-way' }), 'SYNC_CONFLICT')
  assert.ok(error.conflict, '409 必须带 conflict 结构')
  assert.deepEqual(error.conflict.options, ['push', 'pull'])
  assert.equal(error.conflict.lastSyncedRevision, pushed.revision)
  assert.equal(error.conflict.local.revision, localAfter.revision)
  assert.equal(error.conflict.remote.revision, pushed.revision + 30)
  assert.equal(error.conflict.local.counts.businessLines, localAfter.state.businessLines.length)
  // 本地数据没被覆盖
  assert.equal(engine.snapshot().revision, localAfter.revision)
  assert.ok(engine.snapshot().state.businessLines.some((line) => line.name === '本地冲突线'))
  assert.equal(service.status().lastSyncedRevision, pushed.revision, '冲突不应推进同步点')
})

test('sync force push：run({force:"push"}) 用本地覆盖远端、解除冲突', async () => {
  const mock = await githubMock()
  const { engine, service } = makeSyncFixture()
  dispatchOk(engine, 'seedDemo')
  configureGithub(service, mock)
  const pushed = await service.push({})
  const localAfter = dispatchOk(engine, 'createLine', { name: '本地覆盖线' })
  mock.writeRemote('flowpilot/data.json', syncSnapshot(pushed.revision + 30, demoState()))
  await expectRejectCode(() => service.run({ mode: 'three-way' }), 'SYNC_CONFLICT')
  const out = await service.run({ force: 'push' })
  assert.equal(out.action, 'push')
  assert.equal(out.revision, localAfter.revision)
  assert.equal(mock.readSnapshot('flowpilot/data.json').revision, localAfter.revision)
  assert.equal(service.status().lastSyncedRevision, localAfter.revision)
  assert.equal((await service.run({ mode: 'three-way' })).action, 'noop', 'force 解决后应回到 noop')
})

test('sync force pull：run({force:"pull"}) 用远端覆盖本地并备份', async () => {
  const mock = await githubMock()
  const { engine, service } = makeSyncFixture()
  dispatchOk(engine, 'seedDemo')
  configureGithub(service, mock)
  const pushed = await service.push({})
  dispatchOk(engine, 'createLine', { name: '将被远端覆盖的线' })
  const remoteState = demoState()
  remoteState.projects[0].title = '远端正式版项目'
  mock.writeRemote('flowpilot/data.json', syncSnapshot(pushed.revision + 30, remoteState))
  await expectRejectCode(() => service.run({ mode: 'three-way' }), 'SYNC_CONFLICT')
  const out = await service.run({ force: 'pull' })
  assert.equal(out.action, 'pull')
  assert.equal(out.revision, pushed.revision + 30)
  assert.ok(existsSync(out.backupPath))
  assert.equal(engine.snapshot().revision, pushed.revision + 30)
  assert.equal(engine.snapshot().state.projects[0].title, '远端正式版项目')
  assert.equal(service.status().lastSyncedRevision, pushed.revision + 30)
})

test('sync 远端坏 JSON / 缺 state / revision 非整数 → SYNC_REMOTE_INVALID，绝不覆盖本地、不生成备份', async () => {
  const mock = await githubMock()
  const { engine, service, dataDir } = makeSyncFixture()
  const seeded = dispatchOk(engine, 'seedDemo')
  configureGithub(service, mock)
  const valid = syncSnapshot(5, demoState())
  mock.setRaw('flowpilot/data.json', '{ 不是 JSON')
  await expectRejectCode(() => service.pull({ force: true }), 'SYNC_REMOTE_INVALID')
  mock.setRaw('flowpilot/data.json', JSON.stringify({ revision: 5 }))
  await expectRejectCode(() => service.pull({ force: true }), 'SYNC_REMOTE_INVALID')
  mock.setRaw('flowpilot/data.json', JSON.stringify({ ...valid, revision: '5' }))
  await expectRejectCode(() => service.pull({ force: true }), 'SYNC_REMOTE_INVALID')
  mock.setRaw('flowpilot/data.json', JSON.stringify({ ...valid, state: { projects: [] } }))
  await expectRejectCode(() => service.pull({ force: true }), 'SYNC_REMOTE_INVALID')
  assert.equal(engine.snapshot().revision, seeded.revision)
  assert.equal(engine.snapshot().state.projects.length, 4)
  assert.deepEqual(backupFiles(dataDir), [], '校验失败不应覆盖本地（也不该生成备份）')
})

test('sync 备份保留：连续覆盖本地前备份，只保留最近 10 份 pre-sync 文件', async () => {
  const mock = await githubMock()
  const { engine, service, dataDir } = makeSyncFixture()
  dispatchOk(engine, 'seedDemo')
  configureGithub(service, mock)
  await service.push({})
  const base = demoState()
  let lastBackup = null
  for (let index = 1; index <= 11; index += 1) {
    const remoteState = JSON.parse(JSON.stringify(base))
    remoteState.businessLines.push({ id: `bl_${index}`, name: `远端线 ${index}`, sortOrder: index })
    mock.writeRemote('flowpilot/data.json', syncSnapshot(100 + index, remoteState))
    const out = await service.pull({ force: true })
    lastBackup = out.backupPath
  }
  const backups = backupFiles(dataDir)
  assert.equal(backups.length, 10, `应只保留 10 份，实际 ${backups.length}`)
  const parsed = JSON.parse(readFileSync(lastBackup, 'utf8'))
  assert.equal(parsed.kind, 'backup')
  assert.ok(Array.isArray(parsed.state.projects))
  assert.ok(existsSync(lastBackup))
})

/* ------------------------------------------------------------------ *
 * 写后自动同步（默认开启：newest 语义 + 防抖 + 防重入）
 * ------------------------------------------------------------------ */

test('sync 配置默认值：behavior.autoPushAfterWrite 缺省为 true，显式 false 才关闭', () => {
  assert.equal(normalizeSyncConfig({}).behavior.autoPushAfterWrite, true, '全新配置应默认开启')
  assert.equal(normalizeSyncConfig({ behavior: {} }).behavior.autoPushAfterWrite, true, '旧 sync.json 缺字段应视为开启')
  assert.equal(normalizeSyncConfig({ behavior: { debounceMs: 100 } }).behavior.autoPushAfterWrite, true)
  assert.equal(normalizeSyncConfig({ behavior: { autoPushAfterWrite: null } }).behavior.autoPushAfterWrite, true)
  assert.equal(normalizeSyncConfig({ behavior: { autoPushAfterWrite: true } }).behavior.autoPushAfterWrite, true)
  assert.equal(normalizeSyncConfig({ behavior: { autoPushAfterWrite: false } }).behavior.autoPushAfterWrite, false, '显式 false 保留')
})

test('sync 写后自动同步：默认开启，防抖到期跑一次 newest 同步；窗口内多次写合并', async () => {
  const mock = await githubMock()
  const { engine, service } = makeSyncFixture()
  dispatchOk(engine, 'seedDemo')
  // 只传 debounceMs（便于测试），不传 autoPushAfterWrite → 缺省应为开启
  const configured = service.configure({
    provider: 'github',
    github: { owner: 'acme', repo: 'flowpilot', branch: 'main', path: 'flowpilot/data.json', apiBase: mock.url },
    secrets: { githubToken: 'test-token' },
    behavior: { debounceMs: 40 },
  })
  assert.equal(configured.behavior.autoPushAfterWrite, true, 'autoPushAfterWrite 缺省应视为开启')
  assert.equal(configured.config.behavior.autoPushAfterWrite, true, 'status.config 回显也应为 true')
  await service.push({}) // 先建立同步点
  const getsBefore = mock.state.gets
  const putsBefore = mock.state.puts
  dispatchOk(engine, 'createLine', { name: '防抖 1' })
  service.noteLocalWrite()
  dispatchOk(engine, 'createLine', { name: '防抖 2' })
  service.noteLocalWrite()
  dispatchOk(engine, 'createLine', { name: '防抖 3' })
  service.noteLocalWrite()
  await sleep(250)
  service.stop()
  // 三次写合并为一次 newest 同步：1 次读远端 + 1 次上传
  assert.equal(mock.state.gets, getsBefore + 1, '防抖窗口内多次写只同步一次（1 次读远端）')
  assert.equal(mock.state.puts, putsBefore + 1, '防抖窗口内多次写只上传一次')
  const local = engine.snapshot()
  const remote = mock.readSnapshot('flowpilot/data.json')
  assert.equal(remote.revision, local.revision, '远端已被写后自动同步更新')
  assert.equal(remote.state.businessLines.filter((line) => line.name.startsWith('防抖 ')).length, 3)
  const status = service.status()
  assert.equal(status.lastSyncedRevision, local.revision, 'lastSyncedRevision 前进')
  assert.ok(!Number.isNaN(Date.parse(status.lastSyncedAt)), 'lastSyncedAt 应已更新')
  assert.equal(status.hasPendingChanges, false)
  assert.equal(status.lastError, null)
})

test('sync 写后自动同步：走三方合并（两边改动都保留，合并结果上传，不覆盖任何一侧）', async () => {
  const mock = await githubMock()
  const { engine, service, dataDir } = makeSyncFixture()
  dispatchOk(engine, 'seedDemo')
  service.configure({
    provider: 'github',
    github: { owner: 'acme', repo: 'flowpilot', branch: 'main', path: 'flowpilot/data.json', apiBase: mock.url },
    secrets: { githubToken: 'test-token' },
    behavior: { debounceMs: 30 },
  })
  const pushed = await service.push({})
  const remoteState = demoState()
  remoteState.projects[0].title = '云端写后覆盖版'
  const futureAt = new Date(Date.now() + 60_000).toISOString()
  mock.writeRemote('flowpilot/data.json', { ...syncSnapshot(pushed.revision + 4, remoteState), savedAt: futureAt, updatedAt: futureAt })
  const putsBefore = mock.state.puts
  dispatchOk(engine, 'createLine', { name: '本地写后（应被合并保留）' })
  service.noteLocalWrite()
  await sleep(250)
  service.stop()
  const merged = engine.snapshot()
  assert.equal(merged.revision, pushed.revision + 5, '合并 revision = max(本地 +1, 云端 +4) + 1')
  assert.equal(merged.state.projects[0].title, '云端写后覆盖版', '云端的重命名被保留')
  assert.ok(
    merged.state.businessLines.some((line) => line.name === '本地写后（应被合并保留）'),
    '本地的写后新增也被保留（三方合并，不是整份覆盖）',
  )
  assert.equal(mock.state.puts, putsBefore + 1, '合并后上传一次')
  const preMerge = readdirSync(join(dataDir, 'backups')).filter((name) => name.startsWith('pre-merge-'))
  assert.ok(preMerge.length >= 1, '合并前必须有 pre-merge 备份（含三方原始数据）')
  const status = service.status()
  assert.equal(status.lastSyncedRevision, merged.revision)
  assert.equal(status.hasPendingChanges, false)
  assert.equal(status.lastError, null)
})

test('sync 写后自动同步（HTTP /action 链路）：默认开启时写成功即安排一次 newest 同步', async () => {
  const mock = await githubMock()
  const { engine, service } = makeSyncFixture()
  const routes = new Map(createRoutes({ engine, syncService: service, logger: quietLogger })
    .map(({ path, handler }) => [path, handler]))
  dispatchOk(engine, 'seedDemo')
  service.configure({
    provider: 'github',
    github: { owner: 'acme', repo: 'flowpilot', branch: 'main', path: 'flowpilot/data.json', apiBase: mock.url },
    secrets: { githubToken: 'test-token' },
    behavior: { debounceMs: 30 },
  })
  await service.push({})
  const putsBefore = mock.state.puts
  const actionOut = await callRoute(routes.get(API_PATHS.action), {
    method: 'POST',
    headers: { host: 'h' },
    body: JSON.stringify({ action: 'createLine', payload: { name: 'HTTP 写后同步' } }),
  })
  assert.equal(actionOut.status, 200)
  await sleep(250)
  service.stop()
  assert.equal(mock.state.puts, putsBefore + 1, 'POST /action 成功后应自动同步一次（上传）')
  assert.equal(mock.readSnapshot('flowpilot/data.json').revision, engine.snapshot().revision)
  assert.equal(service.status().hasPendingChanges, false)
})

test('sync 写后自动同步失败：本地写不受影响，只记录 lastError（不抛）', async () => {
  const mock = await githubMock()
  const { engine, service } = makeSyncFixture()
  dispatchOk(engine, 'seedDemo')
  service.configure({
    provider: 'github',
    github: { owner: 'acme', repo: 'flowpilot', branch: 'main', path: 'flowpilot/data.json', apiBase: mock.url },
    secrets: { githubToken: 'test-token' },
    behavior: { debounceMs: 20 },
  })
  await service.push({})
  mock.state.forceStatus = 500
  const written = dispatchOk(engine, 'createLine', { name: '同步失败也不回滚' })
  const putsBefore = mock.state.puts
  assert.doesNotThrow(() => service.noteLocalWrite())
  let status = service.status()
  for (let i = 0; i < 80 && status.lastError === null; i += 1) {
    await sleep(50)
    status = service.status()
  }
  service.stop()
  mock.state.forceStatus = null
  assert.equal(engine.snapshot().revision, written.revision, '同步失败不影响本地写')
  assert.ok(engine.snapshot().state.businessLines.some((line) => line.name === '同步失败也不回滚'))
  assert.equal(mock.state.puts, putsBefore, '失败时不应上传')
  assert.ok(status.lastError && status.lastError.includes('500'), `lastError 应记录 500：${status.lastError}`)
  assert.equal(status.hasPendingChanges, true, '失败后本地仍待同步')
})

test('sync 写后自动同步防重入：同步进行中再次触发不并发，结束后补跑一次', async () => {
  const mock = await githubMock({ delayMs: 100 }) // 慢响应，让「同步进行中」可稳定观测
  const { engine, service } = makeSyncFixture()
  dispatchOk(engine, 'seedDemo')
  service.configure({
    provider: 'github',
    github: { owner: 'acme', repo: 'flowpilot', branch: 'main', path: 'flowpilot/data.json', apiBase: mock.url },
    secrets: { githubToken: 'test-token' },
    behavior: { debounceMs: 15 },
  })
  await service.push({})
  mock.concurrency.reset()
  const requestsBefore = mock.requests.length
  const putsBefore = mock.state.puts
  dispatchOk(engine, 'createLine', { name: '防重入 1' })
  service.noteLocalWrite()
  // 等第一次自动同步真正开始（已向桩发出请求 = 已进入 in-flight）
  for (let i = 0; i < 100 && mock.requests.length === requestsBefore; i += 1) await sleep(10)
  assert.ok(mock.requests.length > requestsBefore, '首次自动同步应已开始')
  dispatchOk(engine, 'createLine', { name: '防重入 2' })
  service.noteLocalWrite() // 同步进行中 → 合并为「结束后补跑一次」
  await sleep(900)
  service.stop()
  assert.ok(mock.concurrency.max <= 1, `不应并发跑两次同步（峰值并发请求 ${mock.concurrency.max}）`)
  assert.equal(mock.requests.length - requestsBefore, 4, '应为两次串行同步（2 次读远端 + 2 次上传），不并发')
  assert.equal(mock.state.puts, putsBefore + 2)
  const local = engine.snapshot()
  const status = service.status()
  assert.equal(status.lastSyncedRevision, local.revision, '补跑一次后覆盖第二次写入')
  assert.equal(status.hasPendingChanges, false)
})

test('sync 写后自动同步：显式 false 关闭；未配置通道直接跳过（无请求）', async () => {
  const mock = await githubMock()
  const { engine, service } = makeSyncFixture()
  // 未配置通道：noteLocalWrite 直接返回 false，不安排任何同步
  assert.equal(service.noteLocalWrite(), false, '未配置时不应安排自动同步')
  dispatchOk(engine, 'seedDemo')
  const configured = service.configure({
    provider: 'github',
    github: { owner: 'acme', repo: 'flowpilot', branch: 'main', path: 'flowpilot/data.json', apiBase: mock.url },
    secrets: { githubToken: 'test-token' },
    behavior: { autoPushAfterWrite: false, debounceMs: 20 },
  })
  assert.equal(configured.behavior.autoPushAfterWrite, false, '显式 false 应保留关闭')
  await service.push({})
  const requestsBefore = mock.requests.length
  dispatchOk(engine, 'createLine', { name: '关闭自动同步' })
  assert.equal(service.noteLocalWrite(), false, '关闭时 noteLocalWrite 返回 false')
  await sleep(150)
  service.stop()
  assert.equal(mock.requests.length, requestsBefore, '关闭时不应发起同步请求')
  assert.equal(service.status().hasPendingChanges, true, '写入保持待同步')
})

test('sync HTTP 路由：6 条路由 + 400/401/403/405/409 错误码映射', async () => {
  const mock = await githubMock()
  const { engine, service } = makeSyncFixture()
  const routes = new Map(createRoutes({ engine, syncService: service, logger: quietLogger })
    .map(({ path, handler }) => [path, handler]))
  for (const key of ['syncStatus', 'syncConfig', 'syncTest', 'syncRun', 'syncPush', 'syncPull']) {
    assert.ok(routes.has(API_PATHS[key]), `缺路由 ${API_PATHS[key]}`)
  }
  const notConfigured = await callRoute(routes.get(API_PATHS.syncRun), { method: 'POST', headers: { host: 'h' }, body: '{}' })
  assert.equal(notConfigured.status, 400)
  assert.equal(notConfigured.json.code, 'SYNC_NOT_CONFIGURED')
  const statusOut = await callRoute(routes.get(API_PATHS.syncStatus), { method: 'GET', headers: { host: 'h' } })
  assert.equal(statusOut.status, 200)
  assert.equal(statusOut.json.ok, true)
  assert.equal(statusOut.json.status.provider, 'off')
  assert.deepEqual(statusOut.json.status.config, {
    provider: 'off',
    github: { owner: '', repo: '', branch: 'main', path: 'flowpilot/data.json', apiBase: 'https://api.github.com' },
    webdav: { url: '', username: '', fileName: 'data.json' },
    behavior: { autoPushAfterWrite: true, autoPullOnStart: false },
  }, 'HTTP status 必须带非敏感 config 回显')
  const configOut = await callRoute(routes.get(API_PATHS.syncConfig), {
    method: 'POST',
    headers: { host: 'h' },
    body: JSON.stringify({
      provider: 'github',
      github: { owner: 'acme', repo: 'flowpilot', branch: 'main', path: 'flowpilot/data.json', apiBase: mock.url },
      secrets: { githubToken: 'test-token' },
    }),
  })
  assert.equal(configOut.status, 200)
  assert.equal(configOut.json.status.configured, true)
  const testOut = await callRoute(routes.get(API_PATHS.syncTest), { method: 'POST', headers: { host: 'h' }, body: '{}' })
  assert.equal(testOut.status, 200)
  assert.equal(testOut.json.detail.remoteFound, false)
  // 注：/sync/run 的默认 mode 是 newest（见下方 newest 分组）；本用例验证旧三路比较语义，显式传 three-way
  const runOut = await callRoute(routes.get(API_PATHS.syncRun), {
    method: 'POST', headers: { host: 'h' }, body: JSON.stringify({ mode: 'three-way' }),
  })
  assert.equal(runOut.status, 200)
  assert.equal(runOut.json.action, 'noop')
  dispatchOk(engine, 'seedDemo')
  const pushOut = await callRoute(routes.get(API_PATHS.syncPush), { method: 'POST', headers: { host: 'h' }, body: '{}' })
  assert.equal(pushOut.status, 200)
  assert.equal(pushOut.json.action, 'push')
  assert.ok(pushOut.json.bytes > 0)
  const pullOut = await callRoute(routes.get(API_PATHS.syncPull), {
    method: 'POST', headers: { host: 'h' }, body: JSON.stringify({ force: true }),
  })
  assert.equal(pullOut.status, 200)
  assert.equal(pullOut.json.action, 'pull')
  assert.ok(pullOut.json.backupPath)
  // 双改冲突 → 409 + conflict
  dispatchOk(engine, 'createLine', { name: '路由冲突线' })
  mock.writeRemote('flowpilot/data.json', syncSnapshot(pushOut.json.revision + 9, demoState()))
  const conflictOut = await callRoute(routes.get(API_PATHS.syncRun), {
    method: 'POST', headers: { host: 'h' }, body: JSON.stringify({ mode: 'three-way' }),
  })
  assert.equal(conflictOut.status, 409)
  assert.equal(conflictOut.json.ok, false)
  assert.equal(conflictOut.json.code, 'SYNC_CONFLICT')
  assert.deepEqual(conflictOut.json.conflict.options, ['push', 'pull'])
  // 方法 / 跨站 / 鉴权
  const badMethod = await callRoute(routes.get(API_PATHS.syncPush), { method: 'GET', headers: { host: 'h' } })
  assert.equal(badMethod.status, 405)
  const crossSite = await callRoute(routes.get(API_PATHS.syncStatus), {
    method: 'GET', headers: { host: '127.0.0.1:51895', origin: 'https://evil.example.com' },
  })
  assert.equal(crossSite.status, 403)
  mock.state.token = 'rotated-token'
  const authOut = await callRoute(routes.get(API_PATHS.syncTest), { method: 'POST', headers: { host: 'h' }, body: '{}' })
  assert.equal(authOut.status, 401)
  assert.equal(authOut.json.code, 'SYNC_AUTH_FAILED')
})

test('sync WebDAV 全链路：目录不存在 → 逐级 MKCOL 后重试 PUT；ETag 并发 412 → SYNC_CONFLICT', async () => {
  const mock = await davMock()
  const { engine, service } = makeSyncFixture()
  dispatchOk(engine, 'seedDemo')
  service.configure({
    provider: 'webdav',
    webdav: { url: `${mock.url}/dav/flowpilot`, username: 'davuser', password: 'davpass', fileName: 'data.json' },
  })
  const pushed = await service.push({})
  assert.equal(pushed.action, 'push')
  assert.ok(mock.state.mkcols >= 2, `应逐级 MKCOL，实际 ${mock.state.mkcols}`)
  assert.ok(mock.state.dirs.has('/dav') && mock.state.dirs.has('/dav/flowpilot'))
  assert.ok(mock.requests.some((request) => request.method === 'MKCOL'))
  assert.ok(mock.requests.some((request) => request.method === 'PUT' && request.url.endsWith('/dav/flowpilot/data.json')))
  assert.equal(mock.state.puts, 1, 'MKCOL 后重试只应写入一次')
  const remote = mock.readSnapshot('/dav/flowpilot/data.json')
  assert.equal(remote.revision, pushed.revision)
  // 远端 ETag 被别处改掉 → If-Match 412 → 冲突
  mock.state.putPrecondition = 'stale'
  dispatchOk(engine, 'createLine', { name: 'WebDAV 本地线' })
  await expectRejectCode(() => service.push({}), 'SYNC_CONFLICT')
  mock.state.putPrecondition = null
  // force pull 走 WebDAV 也能覆盖本地并备份
  mock.writeRemote('/dav/flowpilot/data.json', syncSnapshot(40, demoState()))
  const pulled = await service.pull({ force: true })
  assert.equal(pulled.action, 'pull')
  assert.equal(pulled.revision, 40)
  assert.ok(existsSync(pulled.backupPath))
})

test('flowpilot_sync 工具：status/configure/test/push/sync/pull 全流程；冲突返回 conflict 结构', async () => {
  const mock = await githubMock()
  const dataDir = tempDir()
  const syncFile = join(dataDir, 'config', 'sync.json')
  const { ctx, tools } = makeFakeCtx({ withWebServer: true })
  host.apply(ctx, { dataDir, syncFile })
  assert.equal(tools.length, 2)
  const syncTool = tools.find((tool) => tool.name === 'flowpilot_sync')
  assert.ok(syncTool, '应注册 flowpilot_sync 工具')
  assert.equal(syncTool.parameters.type, 'object')
  assert.equal(syncTool.parameters.additionalProperties, false)
  assert.deepEqual([...FP_SYNC_ACTIONS], ['status', 'configure', 'test', 'sync', 'push', 'pull'])
  assert.deepEqual(syncTool.parameters.properties.action.enum, [...FP_SYNC_ACTIONS])
  assert.deepEqual(FP_SYNC_PARAMETERS.required, ['action'])

  const status0 = await syncTool.execute({ action: 'status' }, {})
  assert.equal(status0.ok, true)
  assert.equal(status0.status.provider, 'off')
  assertJsonSerializable(status0, 'flowpilot_sync status 结果')

  const configured = await syncTool.execute({
    action: 'configure',
    provider: 'github',
    owner: 'acme',
    repo: 'flowpilot',
    branch: 'main',
    path: 'flowpilot/data.json',
    apiBase: mock.url,
    token: 'test-token',
  }, {})
  assert.equal(configured.ok, true)
  assert.equal(configured.status.configured, true)
  assert.equal(configured.status.credentialsSet, true)
  assert.ok(!JSON.stringify(configured).includes('test-token'), '工具结果不能回显 token')

  const tested = await syncTool.execute({ action: 'test' }, {})
  assert.equal(tested.ok, true)
  assert.equal(tested.detail.remoteFound, false)

  const flowpilotTool = tools.find((tool) => tool.name === 'flowpilot')
  const seeded = await flowpilotTool.execute({ action: 'seedDemo' }, {})
  assert.equal(seeded.ok, true)
  const pushed = await syncTool.execute({ action: 'push' }, {})
  assert.equal(pushed.ok, true)
  assert.equal(pushed.action, 'push')
  // 工具 sync 默认走「记录级三方合并」（与 host 默认一致）；这里显式 newest 验证旧模式仍可用
  const noop = await syncTool.execute({ action: 'sync', mode: 'newest' }, {})
  assert.equal(noop.ok, true)
  assert.equal(noop.action, 'noop')
  assert.equal(noop.direction, 'noop')
  assert.equal(noop.uploaded, true)
  // 双向改 → 显式 mode:'three-way' 时才走旧三路比较并返回冲突（工具不抛，ok:false + conflict）
  await flowpilotTool.execute({ action: 'createLine', name: '工具本地线' }, {})
  mock.writeRemote('flowpilot/data.json', syncSnapshot(pushed.revision + 5, demoState()))
  const conflict = await syncTool.execute({ action: 'sync', mode: 'three-way' }, {})
  assert.equal(conflict.ok, false)
  assert.equal(conflict.code, 'SYNC_CONFLICT')
  assert.ok(conflict.conflict)
  assert.deepEqual(conflict.conflict.options, ['push', 'pull'])
  assertJsonSerializable(conflict, 'flowpilot_sync 冲突结果')
  // force pull 解决冲突
  const pulled = await syncTool.execute({ action: 'pull', force: true }, {})
  assert.equal(pulled.ok, true)
  assert.equal(pulled.action, 'pull')
  assert.ok(pulled.backupPath)
  // 非法 action / 未配置 push 的降级
  const unknown = await syncTool.execute({ action: 'nope' }, {})
  assert.equal(unknown.ok, false)
  assert.equal(unknown.code, 'INVALID_INPUT')
})

test('sync dryRun：只判断方向，不写远端 / 不覆盖本地 / 不生成备份', async () => {
  const mock = await githubMock()
  const { engine, service, dataDir } = makeSyncFixture()
  dispatchOk(engine, 'seedDemo')
  configureGithub(service, mock)
  const putsBefore = mock.state.puts
  const out = await service.run({ mode: 'three-way', dryRun: true })
  assert.equal(out.action, 'push')
  assert.equal(out.dryRun, true)
  assert.equal(out.local.revision, engine.snapshot().revision)
  assert.equal(mock.state.puts, putsBefore)
  assert.equal(mock.readSnapshot('flowpilot/data.json'), null, 'dryRun 不应创建远端文件')
  assert.deepEqual(backupFiles(dataDir), [])
  assert.equal(service.status().lastSyncedRevision, null)
})

test('sync 网络错误：HTTP 500 重试 2 次（300/900ms）后 → SYNC_NETWORK', async () => {
  const mock = await githubMock()
  const { service } = makeSyncFixture()
  configureGithub(service, mock)
  mock.state.forceStatus = 500
  const startedAt = Date.now()
  const error = await expectRejectCode(() => service.test(), 'SYNC_NETWORK')
  const elapsed = Date.now() - startedAt
  assert.ok(error.message.includes('500'), `错误信息应含状态码：${error.message}`)
  assert.ok(elapsed >= 1000, `应重试 2 次（300+900ms），实际 ${elapsed}ms`)
  mock.state.forceStatus = null
})

test('sync 路由降级与 apply 兼容：无 syncService 时 503；有/无 webServer 的 fake ctx 都不抛错', async () => {
  const engine = engineAt(NOW_WED, tempDir())
  const routes = new Map(createRoutes({ engine, logger: quietLogger }).map(({ path, handler }) => [path, handler]))
  const degraded = await callRoute(routes.get(API_PATHS.syncStatus), { method: 'GET', headers: { host: 'h' } })
  assert.equal(degraded.status, 503)
  assert.equal(degraded.json.ok, false)
  // 无 webServer：只注册工具，syncFile 落在临时目录（绝不碰真实 ~/.dsh）
  const dir = tempDir()
  const noWebServer = makeFakeCtx({ withWebServer: false })
  assert.doesNotThrow(() => host.apply(noWebServer.ctx, { dataDir: dir, syncFile: join(dir, 'sync.json') }))
  assert.equal(noWebServer.tools.length, 2)
  assert.equal(noWebServer.routes.length, 0)
  // 有 webServer：路由数与 API_PATHS 一致，sync 状态可读
  const withWebServer = makeFakeCtx({ withWebServer: true })
  assert.doesNotThrow(() => host.apply(withWebServer.ctx, { dataDir: tempDir(), syncFile: join(tempDir(), 'sync.json') }))
  assert.equal(withWebServer.routes.length, Object.values(API_PATHS).length)
})

test('sync 本地写失败：sync.json 目录不可创建 → SYNC_LOCAL_WRITE_FAILED（HTTP 500）', async () => {
  const dataDir = tempDir()
  const blocker = join(dataDir, 'blocker')
  writeFileSync(blocker, 'not a directory')
  const { service } = makeSyncFixture({ dataDir, syncFile: join(blocker, 'sync.json') })
  expectCode(() => service.configure({ provider: 'off' }), 'SYNC_LOCAL_WRITE_FAILED')
  const engine = engineAt(NOW_WED, dataDir)
  const routes = new Map(createRoutes({ engine, syncService: service, logger: quietLogger })
    .map(({ path, handler }) => [path, handler]))
  const out = await callRoute(routes.get(API_PATHS.syncConfig), {
    method: 'POST', headers: { host: 'h' }, body: JSON.stringify({ provider: 'off' }),
  })
  assert.equal(out.status, 500)
  assert.equal(out.json.ok, false)
  assert.equal(out.json.code, 'SYNC_LOCAL_WRITE_FAILED')
})

/* ------------------------------------------------------------------ *
 * 契约 §4.2：删除项目 + 设计稿链接继承
 * ------------------------------------------------------------------ */

group('契约 §4.2：设计稿链接继承')

function findProjectByTitle(state, title) {
  const project = state.projects.find((item) => item.title === title)
  assert.ok(project, `示例项目应存在：${title}`)
  return project
}
function flowOf(state, projectId, templateId) {
  const flow = state.flows.find((item) => item.projectId === projectId && item.templateId === templateId)
  assert.ok(flow, `项目应含 ${templateId} 流程`)
  return flow
}
function nodesOfFlow(state, flowId) {
  return state.nodes.filter((node) => node.flowId === flowId).sort((a, b) => a.sortOrder - b.sortOrder)
}
function fp42NodeByCode(state, projectId, code) {
  const node = state.nodes.find((item) => item.projectId === projectId && item.code === code)
  assert.ok(node, `应存在节点 ${code}`)
  return node
}

test('完成节点时把 设计稿链接继承到下一个节点（带 inheritedFrom）', () => {
  const engine = engineAt(NOW_WED, tempDir())
  dispatchOk(engine, 'seedDemo', {})
  const snapshot = engine.snapshot()
  const project = findProjectByTitle(snapshot.state, '会员中心二期素材库')
  const flow = flowOf(snapshot.state, project.id, 'delivery')
  const d05 = fp42NodeByCode(snapshot.state, project.id, 'D05')
  const d06 = fp42NodeByCode(snapshot.state, project.id, 'D06')
  const url = 'https://design.example.com/project/abc/file-1'
  dispatchOk(engine, 'addLink', { nodeId: d05.id, title: '设计稿文件', url, kind: 'design' })
  dispatchOk(engine, 'completeNode', { nodeId: d05.id })
  const after = engine.snapshot().state
  const inherited = after.links.filter((link) => link.nodeId === d06.id && link.kind === 'design')
  assert.equal(inherited.length, 1, 'D06 应继承 1 条 设计稿链接')
  assert.equal(inherited[0].url, url)
  assert.equal(inherited[0].inheritedFrom, d05.id)
  assert.ok(after.events.some((event) => event.kind === 'linkAdded' && event.nodeId === d06.id && /继承 设计稿链接/.test(event.details)))
})

test('同一目标已存在相同 URL 时不重复继承', () => {
  const engine = engineAt(NOW_WED, tempDir())
  dispatchOk(engine, 'seedDemo', {})
  const snapshot = engine.snapshot()
  const project = findProjectByTitle(snapshot.state, '会员中心二期素材库')
  const d05 = fp42NodeByCode(snapshot.state, project.id, 'D05')
  const d06 = fp42NodeByCode(snapshot.state, project.id, 'D06')
  const url = 'https://design.example.com/project/abc/dedupe'
  dispatchOk(engine, 'addLink', { nodeId: d06.id, title: '已有 设计稿', url, kind: 'design' })
  dispatchOk(engine, 'addLink', { nodeId: d05.id, title: '设计稿文件', url, kind: 'design' })
  dispatchOk(engine, 'completeNode', { nodeId: d05.id })
  const after = engine.snapshot().state
  assert.equal(after.links.filter((link) => link.nodeId === d06.id && link.url === url).length, 1)
})

test('跳过节点时同样继承 设计稿链接', () => {
  const engine = engineAt(NOW_WED, tempDir())
  dispatchOk(engine, 'seedDemo', {})
  const snapshot = engine.snapshot()
  const project = findProjectByTitle(snapshot.state, '数据看板重构')
  const d01 = fp42NodeByCode(snapshot.state, project.id, 'D01')
  const d02 = fp42NodeByCode(snapshot.state, project.id, 'D02')
  const url = 'https://design.example.com/project/xyz/file-9'
  dispatchOk(engine, 'addLink', { nodeId: d01.id, title: '设计稿文件', url, kind: 'design' })
  dispatchOk(engine, 'skipNode', { nodeId: d01.id, reason: '需求取消，直接进入评估' })
  const after = engine.snapshot().state
  const inherited = after.links.filter((link) => link.nodeId === d02.id && link.kind === 'design')
  assert.equal(inherited.length, 1)
  assert.equal(inherited[0].url, url)
})

test('settings.inheritDesignLink=false 时不再继承；非法值被拒绝', () => {
  const engine = engineAt(NOW_WED, tempDir())
  dispatchOk(engine, 'seedDemo', {})
  dispatchOk(engine, 'updateSettings', { patch: { inheritDesignLink: false } })
  expectCode(() => engine.dispatch('updateSettings', { patch: { inheritDesignLink: 'yes' } }), 'INVALID_INPUT')
  const snapshot = engine.snapshot()
  const project = findProjectByTitle(snapshot.state, '数据看板重构')
  const d01 = fp42NodeByCode(snapshot.state, project.id, 'D01')
  const d02 = fp42NodeByCode(snapshot.state, project.id, 'D02')
  dispatchOk(engine, 'addLink', { nodeId: d01.id, title: '设计稿文件', url: 'https://design.example.com/off', kind: 'design' })
  dispatchOk(engine, 'completeNode', { nodeId: d01.id })
  const after = engine.snapshot().state
  assert.equal(after.links.filter((link) => link.nodeId === d02.id && link.kind === 'design').length, 0)
})

test('链式继承：D06 靠继承来的 设计稿链接满足门槛并自动完成，D07 继续继承', () => {
  const engine = engineAt(NOW_WED, tempDir())
  dispatchOk(engine, 'seedDemo', {})
  const snapshot = engine.snapshot()
  const project = findProjectByTitle(snapshot.state, '会员中心二期素材库')
  const d05 = fp42NodeByCode(snapshot.state, project.id, 'D05')
  const d06 = fp42NodeByCode(snapshot.state, project.id, 'D06')
  const d07 = fp42NodeByCode(snapshot.state, project.id, 'D07')
  dispatchOk(engine, 'addLink', { nodeId: d05.id, title: '设计稿文件', url: 'https://design.example.com/chain', kind: 'design' })
  dispatchOk(engine, 'completeNode', { nodeId: d05.id })
  dispatchOk(engine, 'approve', { nodeId: d06.id, role: 'design', passed: true })
  const approved = dispatchOk(engine, 'approve', { nodeId: d06.id, role: 'product', passed: true })
  assert.equal(approved.result.completed, true, 'D06 应在双方通过并已有 设计稿链接时自动完成')
  const after = engine.snapshot().state
  const d07Links = after.links.filter((link) => link.nodeId === d07.id && link.kind === 'design')
  assert.equal(d07Links.length, 1)
  assert.equal(d07Links[0].inheritedFrom, d06.id)
})

test('跨流程 handoff：D07 完成后 设计稿链接继承到验收流程 A01', () => {
  const engine = engineAt(NOW_WED, tempDir())
  const lineId = dispatchOk(engine, 'createLine', { name: '继承验收线' }).result.lineId
  const created = dispatchOk(engine, 'createProject', {
    businessLineId: lineId, title: '继承与交接测试', templateIds: ['delivery', 'acceptance'],
  }).result
  const snapshot = engine.snapshot()
  const flowDelivery = flowOf(snapshot.state, created.projectId, 'delivery')
  const flowAcceptance = flowOf(snapshot.state, created.projectId, 'acceptance')
  const d = nodesOfFlow(snapshot.state, flowDelivery.id)
  const a = nodesOfFlow(snapshot.state, flowAcceptance.id)
  const designUrl = 'https://design.example.com/handoff-project'
  const byCode = (code) => d.find((node) => node.code === code) ?? a.find((node) => node.code === code)

  dispatchOk(engine, 'addLink', { nodeId: byCode('D01').id, title: '设计稿 项目', url: designUrl, kind: 'design' })
  dispatchOk(engine, 'completeNode', { nodeId: byCode('D01').id })
  dispatchOk(engine, 'completeNode', { nodeId: byCode('D02').id })
  dispatchOk(engine, 'completeNode', { nodeId: byCode('D03').id })
  dispatchOk(engine, 'approve', { nodeId: byCode('D04').id, role: 'design', passed: true })
  const d04 = dispatchOk(engine, 'approve', { nodeId: byCode('D04').id, role: 'product', passed: true })
  assert.equal(d04.result.completed, true)
  dispatchOk(engine, 'completeNode', { nodeId: byCode('D05').id })
  dispatchOk(engine, 'approve', { nodeId: byCode('D06').id, role: 'design', passed: true })
  dispatchOk(engine, 'approve', { nodeId: byCode('D06').id, role: 'product', passed: true })
  dispatchOk(engine, 'completeNode', { nodeId: byCode('D07').id })

  const after = engine.snapshot()
  const a01 = after.state.nodes.find((node) => node.code === 'A01' && node.projectId === created.projectId)
  assert.ok(a01, '验收流程应存在 A01')
  const inherited = after.state.links.filter((link) => link.nodeId === a01.id && link.kind === 'design')
  assert.equal(inherited.length, 1, 'A01 应继承 D07 的 设计稿链接')
  assert.equal(inherited[0].url, designUrl)
  assert.equal(inherited[0].inheritedFrom, after.state.nodes.find((node) => node.code === 'D07' && node.projectId === created.projectId).id)
  assert.equal(a01.status === 'locked' || a01.status === 'ready' || a01.status === 'waiting', true)
})

group('契约 §4.2：删除项目')

function makeDeletableProject(engine) {
  const lineId = dispatchOk(engine, 'createLine', { name: '删除测试线' }).result.lineId
  const created = dispatchOk(engine, 'createProject', {
    businessLineId: lineId, title: '待删除项目', templateIds: ['delivery'],
  }).result
  const snapshot = engine.snapshot()
  const nodes = nodesOfFlow(snapshot.state, created.flowId ?? flowOf(snapshot.state, created.projectId, 'delivery').id)
  const first = nodes[0]
  dispatchOk(engine, 'addLink', { nodeId: first.id, title: '设计稿文件', url: 'https://design.example.com/delete-me', kind: 'design' })
  dispatchOk(engine, 'setNodeNotes', { nodeId: first.id, notes: '一些笔记' })
  return { lineId, projectId: created.projectId, flowId: created.flowId ?? flowOf(snapshot.state, created.projectId, 'delivery').id, nodes }
}

test('缺少 confirm="DELETE" 时拒绝删除', () => {
  const engine = engineAt(NOW_WED, tempDir())
  const { projectId } = makeDeletableProject(engine)
  expectCode(() => engine.dispatch('deleteProject', { projectId }), 'INVALID_INPUT')
  expectCode(() => engine.dispatch('deleteProject', { projectId, confirm: 'delete' }), 'INVALID_INPUT')
  expectCode(() => engine.dispatch('deleteProject', { projectId: 'pr_not_exist', confirm: 'DELETE' }), 'NOT_FOUND')
  assert.ok(engine.snapshot().state.projects.some((project) => project.id === projectId), '拒绝时不得删除')
})

test('删除项目：级联清理项目/流程/节点/链接/事件，并生成 pre-delete 备份', () => {
  const dataDir = tempDir()
  const engine = engineAt(NOW_WED, dataDir)
  dispatchOk(engine, 'seedDemo', {})
  const before = engine.snapshot().state
  const { projectId, nodes } = makeDeletableProject(engine)
  const mid = engine.snapshot()
  const revisionBefore = mid.revision
  const nodeIds = new Set(nodes.map((node) => node.id))
  const linksBefore = mid.state.links.filter((link) => nodeIds.has(link.nodeId)).length
  assert.ok(linksBefore >= 1)

  const out = dispatchOk(engine, 'deleteProject', { projectId, confirm: 'DELETE' })
  assert.equal(out.result.deleted.nodes, nodes.length)
  assert.ok(out.result.deleted.links >= 1)
  assert.ok(typeof out.result.backupPath === 'string' && out.result.backupPath.includes('pre-delete-'))
  assert.ok(existsSync(out.result.backupPath), '备份文件应真实存在')
  assert.equal(out.revision, revisionBefore + 1)

  const after = engine.snapshot().state
  assert.equal(after.projects.some((project) => project.id === projectId), false)
  assert.equal(after.flows.some((flow) => flow.projectId === projectId), false)
  assert.equal(after.nodes.some((node) => node.projectId === projectId), false)
  assert.equal(after.links.some((link) => nodeIds.has(link.nodeId)), false)
  assert.equal(after.events.some((event) => event.projectId === projectId), false)
  assert.equal(after.dependencies.some((dep) => nodeIds.has(dep.fromNodeId) || nodeIds.has(dep.toNodeId)), false)
  // 其它项目不受影响：示例项目全在，且总数恰好少一个
  assert.equal(after.projects.length, mid.state.projects.length - 1)
  for (const project of before.projects) {
    assert.ok(after.projects.some((item) => item.id === project.id), `原有项目应保留：${project.title}`)
  }

  const backup = JSON.parse(readFileSync(out.result.backupPath, 'utf8'))
  assert.ok(backup.state && Array.isArray(backup.state.projects), '备份应包含完整 state')
  assert.ok(backup.state.projects.some((project) => project.id === projectId), '备份应保留被删项目')
})

test('删除项目时清理 handoff 里对被删节点的引用', () => {
  const engine = engineAt(NOW_WED, tempDir())
  dispatchOk(engine, 'seedDemo', {})
  dispatchOk(engine, 'createLine', { name: '交接清理线' })
  const lineId = engine.snapshot().state.businessLines.find((line) => line.name === '交接清理线').id
  const created = dispatchOk(engine, 'createProject', {
    businessLineId: lineId, title: '交接清理项目', templateIds: ['delivery'],
  }).result
  const snapshot = engine.snapshot()
  const delivery = flowOf(snapshot.state, created.projectId, 'delivery')
  const firstNode = nodesOfFlow(snapshot.state, delivery.id)[0]
  dispatchOk(engine, 'saveHandoff', {
    date: '2026-11-04', nodeIds: [firstNode.id], nextActions: '继续推进', notes: '',
  })
  assert.equal(engine.snapshot().state.handoffs.some((handoff) => handoff.nodeIds.includes(firstNode.id)), true)
  dispatchOk(engine, 'deleteProject', { projectId: created.projectId, confirm: 'DELETE' })
  const after = engine.snapshot().state
  assert.equal(after.handoffs.some((handoff) => handoff.nodeIds.includes(firstNode.id)), false, '交接里不应再引用被删节点')
})

test('删除项目后 derived/周报仍可正常计算', () => {
  const engine = engineAt(NOW_WED, tempDir())
  dispatchOk(engine, 'seedDemo', {})
  const { projectId } = makeDeletableProject(engine)
  dispatchOk(engine, 'deleteProject', { projectId, confirm: 'DELETE' })
  const snapshot = engine.snapshot()
  assert.ok(snapshot.derived && snapshot.derived.counts)
  assert.ok(Number.isInteger(snapshot.derived.counts.activeProjects))
  assert.equal(snapshot.derived.projects[projectId], undefined)
  const report = dispatchOk(engine, 'generateReport', { mode: 'concise' })
  assert.ok(typeof report.result.content === 'string' && report.result.content.length > 0)
})

/* ------------------------------------------------------------------ *
 * 版本检查与一键更新（docs/UPDATE.md）
 * ------------------------------------------------------------------ */

function makeUpdateService(overrides = {}) {
  return createUpdateService(Object.assign({
    logger: quietLogger,
    pluginRoot: tempDir(),
    version: '1.1.0',
    repo: 'https://github.com/example/flowpilot',
    profileDir: '/tmp/flowpilot-fake-profile',
    mode: 'profile',
    pnpmPath: '/tmp/fake-pnpm/pnpm.cjs',
    execPath: '/tmp/fake/DSH NEXT.app/Contents/MacOS/DSH NEXT',
    runGit: async () => ({ ok: true, stdout: 'sha\trefs/tags/v1.2.0\n', stderr: '' }),
    runPnpm: async () => ({ ok: true, stdout: '+ dsh-flowpilot 1.2.0\n', stderr: '' }),
    restartApp: () => ({ ok: true, app: '/tmp/fake/DSH NEXT.app' }),
    auto: false,
    now: () => 1_000,
  }, overrides))
}

test('update：版本比较 / tag 解析 / 仓库地址归一化', () => {
  assert.equal(compareVersions('1.2.0', '1.1.9'), 1)
  assert.equal(compareVersions('v1.2.0', '1.2.0'), 0)
  assert.equal(compareVersions('1.2.0-beta.1', '1.2.0'), -1)
  assert.equal(compareVersions('1.2.0-alpha', '1.2.0-beta'), -1)
  assert.equal(compareVersions('bad', '1.0.0'), -1)
  assert.deepEqual(parseVersion('v1.2.3'), { major: 1, minor: 2, patch: 3, pre: '' })
  assert.equal(parseVersion('nope'), null)
  const tags = extractTags([
    'aaa\trefs/tags/v1.0.0',
    'bbb\trefs/tags/v1.2.0',
    'ccc\trefs/tags/v1.1.5',
    'ddd\trefs/tags/not-semver',
    'eee\trefs/tags/v1.2.0^{}',
  ].join('\n'))
  assert.deepEqual(tags.map((item) => item.version), ['1.2.0', '1.1.5', '1.0.0'])
  assert.equal(tags[0].tag, 'v1.2.0')
  assert.equal(normalizeRepoUrl('git+https://github.com/Hazen223/dsh-flowpilot-public.git'), 'https://github.com/Hazen223/dsh-flowpilot-public')
  assert.equal(normalizeRepoUrl('git@github.com:Hazen223/dsh-flowpilot-public.git'), 'https://github.com/Hazen223/dsh-flowpilot-public')
})

test('update：git 凭据助手参数（有 ~/.git-credentials 时强制 store-only，避开钥匙串弹窗）', () => {
  assert.deepEqual(credentialHelperArgs(true), ['-c', 'credential.helper=', '-c', 'credential.helper=store'])
  assert.deepEqual(credentialHelperArgs(false), [])
})

test('update：pnpm 内部 git 凭据环境（强制 store-only，避免 gh 助手旧令牌导致更新失败）', () => {
  const withFile = pnpmGitEnv(true)
  assert.equal(withFile.GIT_TERMINAL_PROMPT, '0')
  assert.equal(withFile.GIT_ASKPASS, '/usr/bin/true')
  assert.equal(withFile.GIT_CONFIG_COUNT, '2')
  assert.equal(withFile.GIT_CONFIG_KEY_0, 'credential.helper')
  assert.equal(withFile.GIT_CONFIG_VALUE_0, '')
  assert.equal(withFile.GIT_CONFIG_KEY_1, 'credential.helper')
  assert.equal(withFile.GIT_CONFIG_VALUE_1, 'store')
  const withoutFile = pnpmGitEnv(false)
  assert.equal(withoutFile.GIT_TERMINAL_PROMPT, '0')
  assert.equal(withoutFile.GIT_CONFIG_COUNT, undefined)
})

test('update：profile 安装形态识别（node_modules 路径 → profile，开发目录 → link）', () => {
  const profile = join(tempDir(), 'profile')
  const pluginRoot = join(profile, 'node_modules', 'dsh-flowpilot')
  mkdirSync(join(pluginRoot, 'lib'), { recursive: true })
  writeFileSync(join(profile, 'package.json'), JSON.stringify({ name: 'dsh-profile-desktop', dsh: { profile: { bundles: ['dsh-flowpilot'] } } }))
  writeFileSync(join(pluginRoot, 'package.json'), JSON.stringify({ name: 'dsh-flowpilot', version: '1.2.0' }))
  assert.equal(detectProfileDir(pluginRoot), profile)
  assert.equal(detectProfileDir('/Users/someone/dev/flowpilot'), null)
  assert.equal(detectProfileDir(join(tempDir(), 'not-a-profile', 'node_modules', 'dsh-flowpilot')), null)
})

test('update：check 读取最新 tag、30 分钟内复用缓存、force 重新检查', async () => {
  let calls = 0
  const service = makeUpdateService({
    runGit: async () => {
      calls += 1
      return { ok: true, stdout: 'sha\trefs/tags/v1.2.0\n', stderr: '' }
    },
  })
  const first = await service.check()
  assert.equal(first.updateAvailable, true)
  assert.equal(first.latestVersion, '1.2.0')
  assert.equal(first.checkedAt, new Date(1_000).toISOString())
  assert.equal(first.mode, 'profile')
  await service.check()
  assert.equal(calls, 1, '缓存期内不应再调用 git')
  await service.check({ force: true })
  assert.equal(calls, 2)
})

test('update：git 失败 → UPDATE_CHECK_FAILED 且 status 记录 lastError，不抛到插件外', async () => {
  const service = makeUpdateService({
    runGit: async () => ({ ok: false, code: 128, stdout: '', stderr: '', message: 'fatal: could not read Username' }),
  })
  await assert.rejects(() => service.check(), (error) => error.code === 'UPDATE_CHECK_FAILED')
  const status = service.status()
  assert.equal(status.updateAvailable, false)
  assert.equal(status.latestVersion, null)
  assert.equal(status.error.code, 'UPDATE_CHECK_FAILED')
  assert.ok(status.error.message.includes('读取远端 tag 失败'))
})

test('update：apply 用最新 tag 重装并标记 restartRequired；再点 apply 不再可用', async () => {
  const specs = []
  const service = makeUpdateService({
    runPnpm: async (spec) => {
      specs.push(spec)
      return { ok: true, stdout: '+ dsh-flowpilot 1.2.0\n', stderr: '' }
    },
  })
  await service.check()
  const status = await service.apply()
  assert.deepEqual(specs, ['https://github.com/example/flowpilot#v1.2.0'])
  assert.equal(status.appliedVersion, '1.2.0')
  assert.equal(status.restartRequired, true)
  assert.equal(status.updateAvailable, false)
  await assert.rejects(() => service.apply(), (error) => error.code === 'UPDATE_NOT_AVAILABLE')
})

test('update：link 开发模式 / 缺 pnpm / 安装失败的错误码', async () => {
  const devMode = makeUpdateService({ mode: 'link', profileDir: null })
  await devMode.check()
  await assert.rejects(() => devMode.apply(), (error) => error.code === 'UPDATE_DEV_MODE')

  const noPnpm = makeUpdateService({ pnpmPath: null })
  await noPnpm.check()
  await assert.rejects(() => noPnpm.apply(), (error) => error.code === 'UPDATE_PNPM_MISSING')

  const failing = makeUpdateService({
    runPnpm: async () => ({ ok: false, code: 1, stdout: 'ERR_PNPM', stderr: 'network unreachable', message: 'Command failed' }),
  })
  await failing.check()
  await assert.rejects(() => failing.apply(), (error) => error.code === 'UPDATE_APPLY_FAILED' && error.message.includes('安装新版本失败'))
  assert.equal(failing.status().restartRequired, false)
})

test('update：restart 走注入的重启器；未就绪时状态默认值正确', () => {
  let restarted = 0
  const service = makeUpdateService({
    restartApp: () => {
      restarted += 1
      return { ok: true, app: '/tmp/fake/DSH NEXT.app' }
    },
  })
  const out = service.restart()
  assert.equal(restarted, 1)
  assert.equal(out.restarting, true)
  const fresh = service.status()
  assert.equal(fresh.latestVersion, null)
  assert.equal(fresh.checkedAt, null)
  assert.equal(fresh.busy, null)
  assert.equal(fresh.canApply, true)
})

test('update 路由：status/check/apply/restart 正常；缺服务时 503', async () => {
  const engine = engineAt(NOW_WED, tempDir())
  let applied = 0
  const service = makeUpdateService({
    runGit: async () => ({ ok: true, stdout: 'sha\trefs/tags/v1.2.0\n', stderr: '' }),
    runPnpm: async () => {
      applied += 1
      return { ok: true, stdout: '+ dsh-flowpilot 1.2.0\n', stderr: '' }
    },
  })
  const routes = new Map(createRoutes({ engine, updateService: service, logger: quietLogger }).map(({ path, handler }) => [path, handler]))

  const statusOut = await callRoute(routes.get(API_PATHS.updateStatus), { method: 'GET', headers: { host: '127.0.0.1:51895' } })
  assert.equal(statusOut.status, 200)
  assert.equal(statusOut.json.ok, true)
  assert.equal(statusOut.json.status.currentVersion, '1.1.0')

  const checkOut = await callRoute(routes.get(API_PATHS.updateCheck), { method: 'POST', headers: { host: '127.0.0.1:51895' }, body: '{}' })
  assert.equal(checkOut.status, 200)
  assert.equal(checkOut.json.status.updateAvailable, true)

  const applyOut = await callRoute(routes.get(API_PATHS.updateApply), { method: 'POST', headers: { host: '127.0.0.1:51895' }, body: '{}' })
  assert.equal(applyOut.status, 200)
  assert.equal(applyOut.json.status.appliedVersion, '1.2.0')
  assert.equal(applied, 1)

  const restartOut = await callRoute(routes.get(API_PATHS.updateRestart), { method: 'POST', headers: { host: '127.0.0.1:51895' }, body: '{}' })
  assert.equal(restartOut.status, 200)
  assert.equal(restartOut.json.restarting, true)

  // 未注入 updateService 时降级 503，不影响其它路由
  const plain = new Map(createRoutes({ engine, logger: quietLogger }).map(({ path, handler }) => [path, handler]))
  const missing = await callRoute(plain.get(API_PATHS.updateStatus), { method: 'GET', headers: { host: '127.0.0.1:51895' } })
  assert.equal(missing.status, 503)
  assert.equal(missing.json.ok, false)
})

/* ------------------------------------------------------------------ *
 * 9. 最新覆盖（newest-wins）：云端与本地双向检查，用最新的覆盖旧的，且每次都上传
 *    全部走 githubMock + 临时 dataDir（mkdtemp），不碰真实 ~/.dsh。
 * ------------------------------------------------------------------ */

group('同步 newest 模式（最新覆盖 + 每次都上传）')

/** 远端快照（可指定 updatedAt / savedAt，用来构造「云端比本地新」）。 */
function newestRemoteSnapshot(revision, state, updatedAt) {
  const at = updatedAt ?? isoOf(NOW_WED)
  return { ...syncSnapshot(revision, state), savedAt: at, updatedAt: at }
}

test('newest：无远端 → 上传本地快照，返回 direction / uploaded / 时间戳 / 双端 revision', async () => {
  const mock = await githubMock()
  const { engine, service } = makeSyncFixture()
  const seeded = dispatchOk(engine, 'seedDemo')
  configureGithub(service, mock)
  const out = await service.run({ mode: 'newest' })
  assert.equal(out.mode, 'newest')
  assert.equal(out.action, 'push')
  assert.equal(out.direction, 'push')
  assert.equal(out.uploaded, true)
  assert.equal(out.localRevision, seeded.revision)
  assert.equal(out.remoteRevision, seeded.revision)
  assert.equal(typeof out.localUpdatedAt, 'string')
  assert.equal(typeof out.remoteUpdatedAt, 'string')
  assert.ok(!Number.isNaN(Date.parse(out.localUpdatedAt)), 'localUpdatedAt 必须可解析')
  assert.ok(!Number.isNaN(Date.parse(out.remoteUpdatedAt)), 'remoteUpdatedAt 必须可解析')
  assert.equal(out.remote.revision, seeded.revision, 'remote 摘要是同步后的远端状态（与旧三路 run 一致）')
  assert.equal(typeof out.remote.ref, 'string')
  const remote = mock.readSnapshot('flowpilot/data.json')
  assert.equal(remote.kind, 'sync-snapshot')
  assert.equal(remote.revision, seeded.revision)
  assert.equal(remote.state.projects.length, 4)
  assert.equal(service.status().lastSyncedRevision, seeded.revision)
  assert.equal(service.status().hasPendingChanges, false)
})

test('newest：云端更新 → 拉取覆盖本地（先备份），并把结果回传云端', async () => {
  const mock = await githubMock()
  const { engine, service } = makeSyncFixture()
  dispatchOk(engine, 'seedDemo')
  configureGithub(service, mock)
  const pushed = await service.push({})
  const remoteState = demoState()
  remoteState.projects[0].title = '云端最新版项目'
  const futureAt = new Date(Date.now() + 60_000).toISOString()
  mock.writeRemote('flowpilot/data.json', newestRemoteSnapshot(pushed.revision + 5, remoteState, futureAt))
  const out = await service.run({ mode: 'newest' })
  assert.equal(out.direction, 'pull')
  assert.equal(out.uploaded, true, '拉取后必须再回传一次')
  assert.equal(out.localRevision, pushed.revision + 5)
  assert.equal(out.remoteRevision, pushed.revision + 5)
  assert.ok(out.backupPath && existsSync(out.backupPath), '覆盖本地前必须有 pre-sync 备份')
  assert.equal(engine.snapshot().revision, pushed.revision + 5)
  assert.equal(engine.snapshot().state.projects[0].title, '云端最新版项目')
  const remoteAfter = mock.readSnapshot('flowpilot/data.json')
  assert.equal(remoteAfter.revision, pushed.revision + 5, '回传后云端 revision 与本地一致')
  assert.equal(remoteAfter.state.projects[0].title, '云端最新版项目')
  assert.equal(typeof remoteAfter.updatedAt, 'string')
  assert.equal(service.status().lastSyncedRevision, pushed.revision + 5)
})

test('newest：本地更新 → 不改本地，直接上传覆盖云端', async () => {
  const mock = await githubMock()
  const { engine, service } = makeSyncFixture()
  dispatchOk(engine, 'seedDemo')
  configureGithub(service, mock)
  await service.push({})
  const localAfter = dispatchOk(engine, 'createLine', { name: '本地最新业务线' })
  const putsBefore = mock.state.puts
  const out = await service.run({ mode: 'newest' })
  assert.equal(out.direction, 'push')
  assert.equal(out.uploaded, true)
  assert.equal(out.localRevision, localAfter.revision)
  assert.equal(mock.state.puts, putsBefore + 1)
  assert.equal(engine.snapshot().revision, localAfter.revision, '本地不被远端覆盖')
  const remote = mock.readSnapshot('flowpilot/data.json')
  assert.equal(remote.revision, localAfter.revision)
  assert.ok(remote.state.businessLines.some((line) => line.name === '本地最新业务线'))
  assert.equal(service.status().lastSyncedRevision, localAfter.revision)
})

test('newest：双方都改过也不报冲突（新者覆盖旧者），且每次同步都上传', async () => {
  const mock = await githubMock()
  const { engine, service } = makeSyncFixture()
  dispatchOk(engine, 'seedDemo')
  configureGithub(service, mock)
  const pushed = await service.push({})
  const localAfter = dispatchOk(engine, 'createLine', { name: '本地冲突线' })
  const remoteState = demoState()
  remoteState.projects[0].title = '云端覆盖版'
  const futureAt = new Date(Date.now() + 120_000).toISOString()
  mock.writeRemote('flowpilot/data.json', newestRemoteSnapshot(pushed.revision + 9, remoteState, futureAt))
  const putsBefore = mock.state.puts
  const out = await service.run({ mode: 'newest' }) // 不抛 SYNC_CONFLICT
  assert.equal(out.direction, 'pull')
  assert.equal(engine.snapshot().revision, pushed.revision + 9)
  assert.notEqual(engine.snapshot().revision, localAfter.revision, '本地改动被云端覆盖（最新覆盖旧的）')
  assert.equal(engine.snapshot().state.projects[0].title, '云端覆盖版')
  assert.equal(mock.state.puts, putsBefore + 1)
  // 再同步一次：即便双端一致也要再上传一次（每一次同步都上传）
  const again = await service.run({ mode: 'newest' })
  assert.equal(again.mode, 'newest')
  assert.equal(again.uploaded, true)
  assert.equal(mock.state.puts, putsBefore + 2)
  assert.equal(mock.readSnapshot('flowpilot/data.json').revision, engine.snapshot().revision)
})

test('newest：新装本地为空 + 云端有数据 → 以云端为准（空本地不会覆盖云端）', async () => {
  const mock = await githubMock()
  const { engine, service } = makeSyncFixture()
  mock.writeRemote('flowpilot/data.json', newestRemoteSnapshot(12, demoState(), isoOf(NOW_WED)))
  configureGithub(service, mock)
  const out = await service.run({ mode: 'newest' })
  assert.equal(out.direction, 'pull')
  assert.equal(out.uploaded, true)
  assert.equal(engine.snapshot().revision, 12)
  assert.equal(engine.snapshot().state.projects.length, 4)
  assert.equal(mock.readSnapshot('flowpilot/data.json').revision, 12)
  assert.equal(service.status().lastSyncedRevision, 12)
})

test('newest（WebDAV）：云端更新 → 拉取覆盖本地并回传，通道无关', async () => {
  const mock = await davMock()
  const { engine, service } = makeSyncFixture()
  dispatchOk(engine, 'seedDemo')
  service.configure({
    provider: 'webdav',
    webdav: { url: `${mock.url}/dav/flowpilot`, username: 'davuser', password: 'davpass', fileName: 'data.json' },
  })
  const pushed = await service.push({})
  const remoteState = demoState()
  remoteState.businessLines.push({ id: 'bl_webdav', name: 'WebDAV 云端线', sortOrder: 9 })
  const futureAt = new Date(Date.now() + 60_000).toISOString()
  mock.writeRemote('/dav/flowpilot/data.json', newestRemoteSnapshot(pushed.revision + 3, remoteState, futureAt))
  const out = await service.run({ mode: 'newest' })
  assert.equal(out.direction, 'pull')
  assert.equal(out.uploaded, true)
  assert.equal(engine.snapshot().revision, pushed.revision + 3)
  assert.ok(engine.snapshot().state.businessLines.some((line) => line.name === 'WebDAV 云端线'))
  const remoteAfter = mock.readSnapshot('/dav/flowpilot/data.json')
  assert.equal(remoteAfter.revision, pushed.revision + 3, 'WebDAV 通道同样要回传')
  assert.equal(service.status().lastSyncedRevision, pushed.revision + 3)
})

test('newest dryRun：只判断方向，不写远端 / 不覆盖本地 / 不生成备份', async () => {
  const mock = await githubMock()
  const { engine, service, dataDir } = makeSyncFixture()
  dispatchOk(engine, 'seedDemo')
  configureGithub(service, mock)
  const localRevision = engine.snapshot().revision
  const putsBefore = mock.state.puts
  const out = await service.run({ mode: 'newest', dryRun: true })
  assert.equal(out.mode, 'newest')
  assert.equal(out.direction, 'push')
  assert.equal(out.uploaded, false)
  assert.equal(out.dryRun, true)
  assert.equal(mock.state.puts, putsBefore)
  assert.equal(mock.readSnapshot('flowpilot/data.json'), null, 'dryRun 不应创建远端文件')
  assert.deepEqual(backupFiles(dataDir), [])
  assert.equal(engine.snapshot().revision, localRevision)
  assert.equal(service.status().lastSyncedRevision, null)
})

test('newest：未配置云通道 → SYNC_NOT_CONFIGURED（可读中文错误，不崩）', async () => {
  const { service } = makeSyncFixture()
  const error = await expectRejectCode(() => service.run({ mode: 'newest' }), 'SYNC_NOT_CONFIGURED')
  assert.ok(error.message.includes('尚未启用同步通道'), `错误信息应可读：${error.message}`)
})

test('newest：连续两次同步不抖动（第二次双端一致 → noop，但仍上传、不反复拉取）', async () => {
  const mock = await githubMock()
  const { engine, service, dataDir } = makeSyncFixture()
  dispatchOk(engine, 'seedDemo')
  configureGithub(service, mock)
  const first = await service.run({ mode: 'newest' })
  assert.equal(first.direction, 'push')
  assert.equal(first.uploaded, true)
  assert.deepEqual(backupFiles(dataDir), [])
  const putsBefore = mock.state.puts
  const second = await service.run({ mode: 'newest' })
  assert.equal(second.direction, 'noop', '双端时间戳/revision 一致 → 无需拉取')
  assert.equal(second.uploaded, true, '即便一致也要再上传一次')
  assert.equal(mock.state.puts, putsBefore + 1)
  assert.deepEqual(backupFiles(dataDir), [], '不应因为 mtime / updatedAt 精度差反复拉取（每次拉取会写备份）')
  assert.equal(engine.snapshot().revision, first.localRevision)
})

test('HTTP /sync/run：默认 merge + result 结构；非法 mode 400；newest / three-way 仍可用', async () => {
  const mock = await githubMock()
  const { engine, service } = makeSyncFixture()
  const routes = new Map(createRoutes({ engine, syncService: service, logger: quietLogger })
    .map(({ path, handler }) => [path, handler]))
  const runRoute = routes.get(API_PATHS.syncRun)
  // 未配置云通道：可读的 400（不是 500 崩溃）
  const notConfigured = await callRoute(runRoute, { method: 'POST', headers: { host: 'h' }, body: '{}' })
  assert.equal(notConfigured.status, 400)
  assert.equal(notConfigured.json.ok, false)
  assert.equal(notConfigured.json.code, 'SYNC_NOT_CONFIGURED')
  assert.ok(typeof notConfigured.json.error === 'string' && notConfigured.json.error.length > 0, '必须有可读错误信息')
  // 配置 + 播种；body 不传 mode → 默认三方合并（首次无 base，远端为空 → 降级 push）
  configureGithub(service, mock)
  dispatchOk(engine, 'seedDemo')
  const out = await callRoute(runRoute, { method: 'POST', headers: { host: 'h' }, body: '{}' })
  assert.equal(out.status, 200)
  assert.equal(out.json.ok, true)
  assert.equal(out.json.mode, 'merge')
  const result = out.json.result
  assert.ok(result !== null && typeof result === 'object', '响应必须带 result 结构')
  assert.equal(result.mode, 'merge')
  assert.equal(result.direction, 'push')
  assert.equal(result.uploaded, true)
  assert.equal(result.localRevision, engine.snapshot().revision)
  // 首次合并时远端还没有快照：remoteRevision 为 null，合并（其实是一次上传）的 revision = 本地 revision
  assert.equal(result.remoteRevision, null)
  assert.equal(result.mergedRevision, engine.snapshot().revision)
  assert.ok(Number.isInteger(result.localRevision))
  // 时间戳：本地数据文件存在时是 ISO，远端没有快照时为 null（先 push 后才有）
  assert.ok(result.localUpdatedAt === null || typeof result.localUpdatedAt === 'string')
  assert.ok(result.remoteUpdatedAt === null || typeof result.remoteUpdatedAt === 'string')
  assert.equal(mock.readSnapshot('flowpilot/data.json').revision, result.mergedRevision)
  assert.ok(out.json.local === null || typeof out.json.local === 'object', '顶层 local 摘要（旧字段兼容）')
  assert.equal(out.json.action, 'push', '顶层 action 旧字段仍保留')
  // 再同步一次：双端一致 → direction=noop，但仍然要上传一次（每一次同步都上传）
  const putsBefore = mock.state.puts
  const explicit = await callRoute(runRoute, {
    method: 'POST', headers: { host: 'h' }, body: JSON.stringify({ mode: 'newest' }),
  })
  assert.equal(explicit.status, 200)
  assert.equal(explicit.json.result.direction, 'noop')
  assert.equal(explicit.json.result.uploaded, true)
  assert.equal(mock.state.puts, putsBefore + 1, '每次同步都要上传')
  // 非法 mode → 400 INVALID_INPUT
  const badMode = await callRoute(runRoute, {
    method: 'POST', headers: { host: 'h' }, body: JSON.stringify({ mode: 'latest' }),
  })
  assert.equal(badMode.status, 400)
  assert.equal(badMode.json.code, 'INVALID_INPUT')
  // 显式 three-way：此刻本地/远端一致 → 旧三路比较为 noop
  const threeWay = await callRoute(runRoute, {
    method: 'POST', headers: { host: 'h' }, body: JSON.stringify({ mode: 'three-way' }),
  })
  assert.equal(threeWay.status, 200)
  assert.equal(threeWay.json.action, 'noop')
  assert.equal(threeWay.json.result.mode, 'three-way')
  assert.equal(threeWay.json.result.direction, 'noop')
  assert.equal(threeWay.json.result.uploaded, false)
})

group('同步 · settings.syncIntervalMinutes（默认 5 / 范围 1~60）')

/** 写一份「旧版」data.json（可指定 settings），模拟老数据。 */
function writeStateFile(dir, settings) {
  const dataFile = join(dir, 'data.json')
  const state = {
    formatVersion: 1,
    settings: { dataFile, ...settings },
    businessLines: [], projects: [], flows: [], nodes: [], dependencies: [], links: [],
    events: [], handoffs: [], reports: [],
  }
  writeFileSync(dataFile, JSON.stringify({ formatVersion: 1, revision: 3, state }, null, 2))
}

test('settings.syncIntervalMinutes：默认 5，updateSettings 可改，非法值 INVALID_INPUT', () => {
  const dir = tempDir()
  const engine = engineAt(NOW_WED, dir)
  assert.equal(DEFAULT_SYNC_INTERVAL_MINUTES, 5)
  assert.equal(SYNC_INTERVAL_MINUTES_MIN, 1)
  assert.equal(SYNC_INTERVAL_MINUTES_MAX, 60)
  assert.equal(engine.snapshot().state.settings.syncIntervalMinutes, 5)
  const updated = dispatchOk(engine, 'updateSettings', { patch: { syncIntervalMinutes: 12 } })
  assert.equal(updated.state.settings.syncIntervalMinutes, 12)
  assert.ok(updated.result.keys.includes('同步间隔'))
  const saved = JSON.parse(readFileSync(join(dir, 'data.json'), 'utf8'))
  assert.equal(saved.state.settings.syncIntervalMinutes, 12, '设置要落盘（客户端刷新后仍生效）')
  assert.equal(dispatchOk(engine, 'updateSettings', { patch: { syncIntervalMinutes: '7' } }).state.settings.syncIntervalMinutes, 7)
  assert.equal(dispatchOk(engine, 'updateSettings', { patch: { syncIntervalMinutes: 1 } }).state.settings.syncIntervalMinutes, 1)
  assert.equal(dispatchOk(engine, 'updateSettings', { patch: { syncIntervalMinutes: 60 } }).state.settings.syncIntervalMinutes, 60)
  for (const bad of [0, 61, -5, 5.5, 1.5, '', ' ', 'abc', '5.5', '61', null, undefined, true, [], {}, NaN, Infinity]) {
    expectCode(() => engine.dispatch('updateSettings', { patch: { syncIntervalMinutes: bad } }), 'INVALID_INPUT')
  }
  assert.equal(engine.snapshot().state.settings.syncIntervalMinutes, 60, '非法值不应改动原有设置')
})

test('GET /state 暴露 settings.syncIntervalMinutes（客户端按它定时刷新同步）', async () => {
  const engine = engineAt(NOW_WED, tempDir())
  const routes = new Map(createRoutes({ engine, logger: quietLogger }).map(({ path, handler }) => [path, handler]))
  const stateOut = await callRoute(routes.get(API_PATHS.state), { method: 'GET', headers: { host: 'h' } })
  assert.equal(stateOut.status, 200)
  assert.equal(stateOut.json.state.settings.syncIntervalMinutes, 5, '默认 5 分钟必须出现在 GET /state')
  const actionOut = await callRoute(routes.get(API_PATHS.action), {
    method: 'POST',
    headers: { host: 'h' },
    body: JSON.stringify({ action: 'updateSettings', payload: { patch: { syncIntervalMinutes: 15 } } }),
  })
  assert.equal(actionOut.status, 200)
  assert.equal(actionOut.json.state.settings.syncIntervalMinutes, 15)
})

test('settings.syncIntervalMinutes：旧数据缺字段补 5；非法旧值回落 5；示例数据带默认值', () => {
  const legacyDir = tempDir()
  writeStateFile(legacyDir, { handoffTime: '20:45' })
  const legacy = engineAt(NOW_WED, legacyDir)
  assert.equal(legacy.snapshot().state.settings.syncIntervalMinutes, 5, '老数据缺字段时补默认 5')
  dispatchOk(legacy, 'updateSettings', { patch: { handoffTime: '21:00' } })
  const saved = JSON.parse(readFileSync(join(legacyDir, 'data.json'), 'utf8'))
  assert.equal(saved.state.settings.syncIntervalMinutes, 5, '写回时把默认值落盘')
  const invalidDir = tempDir()
  writeStateFile(invalidDir, { syncIntervalMinutes: 999 })
  assert.equal(engineAt(NOW_WED, invalidDir).snapshot().state.settings.syncIntervalMinutes, 5, '非法旧值回落默认值')
  assert.equal(createDemoState(NOW_WED).settings.syncIntervalMinutes, 5)
  assert.equal(normalizeSyncIntervalMinutes(5), 5)
  assert.equal(normalizeSyncIntervalMinutes('60'), 60)
  assert.equal(normalizeSyncIntervalMinutes('0'), null)
  assert.equal(normalizeSyncIntervalMinutes(null), null)
  assert.equal(normalizeSyncIntervalMinutes(true), null)
})

/* ------------------------------------------------------------------ *
 * 10. Three-way Merge（merge 模式）：base 快照 + 记录级三方合并
 *     两个模拟客户端（两个 engine + 两个 dataStore）对着同一个 GitHub 桩；
 *     全部 mkdtemp，不碰真实 ~/.dsh。
 * ------------------------------------------------------------------ */

group('同步 merge 模式（记录级三方合并）')

const NOW_WED_LATER = new Date(2026, 10, 4, 17, 0, 0)

/** 一个模拟「客户端」：独立 dataDir + syncFile，连同一个 GitHub 桩。 */
function mergeFixture(now, mock) {
  const fixture = makeSyncFixture({ now })
  configureGithub(fixture.service, mock)
  return fixture
}

/** 直接改本地 state（模拟客户端本地改动），并落盘让 revision +1。 */
function saveState(engine, mutate) {
  const snapshot = engine.snapshot()
  const state = JSON.parse(JSON.stringify(snapshot.state))
  mutate(state)
  return engine.store.save(state, snapshot.revision + 1)
}

function preMergeBackupFiles(dataDir) {
  const dir = join(dataDir, 'backups')
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((name) => name.startsWith('pre-merge-') && name.endsWith('.json'))
    .map((name) => join(dir, name))
}

function readyNodeOf(state) {
  const node = state.nodes.find((item) => item.status === 'ready')
  assert.ok(node, '示例数据里应有 ready 节点')
  return node
}

/** B 首次 merge（本地空 + base 缺失）→ 从云端拉取并建立自己的 base。 */
async function bootstrapClientB(mock, now = NOW_WED_LATER) {
  const client = mergeFixture(now, mock)
  const pulled = await client.service.run({ mode: 'merge' })
  assert.equal(pulled.direction, 'pull', 'B 首次同步应直接拉取云端')
  assert.equal(pulled.baseMissing, true)
  return client
}

/* ---------------- 纯函数级单测（mergeThreeWay） ---------------- */

test('mergeThreeWay（纯函数）：字段级三方 —— 一边改取另一边，同一字段双改平局取 local', () => {
  const base = { projects: [{ id: 'p1', title: '原名', dueAt: '2026-01-01' }], nodes: [], events: [] }
  const local = { projects: [{ id: 'p1', title: '本地名', dueAt: '2026-01-01' }], nodes: [], events: [] }
  const remote = { projects: [{ id: 'p1', title: '远端名', dueAt: '2026-01-02' }], nodes: [], events: [] }
  const { state, stats } = mergeThreeWay(base, local, remote)
  assert.equal(state.projects[0].dueAt, '2026-01-02', '只有远端改的字段取远端')
  assert.equal(state.projects[0].title, '本地名', '双改且 lastTouch 平局 → local')
  assert.equal(stats.conflicts.length, 1)
  assert.deepEqual(stats.conflicts[0], { collection: 'projects', id: 'p1', field: 'title', winner: 'local' })
})

test('mergeThreeWay（纯函数）：删除 / 复活', () => {
  const base = {
    nodes: [{ id: 'n1', projectId: 'p1', title: 'n1' }],
    projects: [{ id: 'p1', title: 'p' }], events: [],
  }
  const localDeleted = { nodes: [], projects: [{ id: 'p1', title: 'p' }], events: [] }
  const remoteUnchanged = {
    nodes: [{ id: 'n1', projectId: 'p1', title: 'n1' }],
    projects: [{ id: 'p1', title: 'p' }], events: [],
  }
  const deleted = mergeThreeWay(base, localDeleted, remoteUnchanged)
  assert.equal(deleted.state.nodes.length, 0, '远端没动 → 接受本地删除')
  assert.equal(deleted.stats.deleted.nodes, 1)
  const remoteLater = {
    nodes: [{ id: 'n1', projectId: 'p1', title: '远端后改' }],
    projects: [{ id: 'p1', title: 'p' }],
    events: [{ id: 'ev1', projectId: 'p1', nodeId: 'n1', timestamp: '2026-01-05T00:00:00.000Z' }],
  }
  const resurrected = mergeThreeWay(base, localDeleted, remoteLater)
  assert.equal(resurrected.state.nodes.length, 1, '远端在删除后改过 → 复活')
  assert.equal(resurrected.state.nodes[0].title, '远端后改')
  assert.deepEqual(resurrected.stats.resurrected, [{ collection: 'nodes', id: 'n1' }])
})

test('mergeThreeWay（纯函数）：lastTouch 取自引用事件（事件更晚的一方胜）', () => {
  const base = {
    nodes: [{ id: 'n1', projectId: 'p1', status: 'ready' }], projects: [{ id: 'p1' }],
    events: [{ id: 'e1', projectId: 'p1', nodeId: 'n1', timestamp: '2026-01-01T00:00:00.000Z' }],
  }
  const local = {
    nodes: [{ id: 'n1', projectId: 'p1', status: 'blocked' }], projects: [{ id: 'p1' }],
    events: [{ id: 'e2', projectId: 'p1', nodeId: 'n1', timestamp: '2026-01-02T00:00:00.000Z' }],
  }
  const remote = {
    nodes: [{ id: 'n1', projectId: 'p1', status: 'completed' }], projects: [{ id: 'p1' }],
    events: [{ id: 'e3', projectId: 'p1', nodeId: 'n1', timestamp: '2026-01-03T00:00:00.000Z' }],
  }
  const { state, stats } = mergeThreeWay(base, local, remote)
  assert.equal(state.nodes[0].status, 'completed', '引用事件更晚的一方胜')
  assert.equal(stats.conflicts[0].winner, 'remote')
})

/* ---------------- 集成用例（两个客户端 + mock GitHub） ---------------- */

test('merge：base 缺失 + 两边都有数据 → 加法合并（union，绝不删除），baseMissing=true', async () => {
  const mock = await githubMock()
  const A = mergeFixture(NOW_WED, mock)
  dispatchOk(A.engine, 'seedDemo')
  const localRevBefore = A.engine.snapshot().revision
  const remoteState = demoState() // 与本地 id 全不同
  mock.writeRemote('flowpilot/data.json', syncSnapshot(9, remoteState))
  const out = await A.service.run({ mode: 'merge' })
  assert.equal(out.mode, 'merge')
  assert.equal(out.direction, 'merge')
  assert.equal(out.action, 'merge')
  assert.equal(out.uploaded, true)
  assert.equal(out.baseMissing, true, 'base 缺失要标出来')
  assert.equal(out.merged.baseMissing, true, 'merged.baseMissing 供客户端提示「首次合并」')
  assert.equal(Object.keys(out.merged.deleted).length, 0, '空 base 加法合并绝不删除')
  assert.equal(Object.keys(out.merged.pruned).length, 0, '空 base 加法合并不清理任何记录')
  assert.equal(out.merged.added.projects, 8, '本地 4 + 远端 4 个项目全部保留')
  assert.equal(out.merged.added.businessLines, 3 + remoteState.businessLines.length)
  assert.equal(out.mergedRevision, Math.max(localRevBefore, 9) + 1, 'revision = max(local, remote) + 1')
  const local = A.engine.snapshot().state
  assert.equal(local.projects.length, 8)
  assert.ok(remoteState.projects.every((project) => local.projects.some((item) => item.id === project.id)))
  assert.equal(mock.readSnapshot('flowpilot/data.json').revision, out.mergedRevision)
})

test('merge：base 缺失降级 —— 本地空 → 拉取云端并写 base；远端空 → 上传本地并写 base', async () => {
  const mock = await githubMock()
  // 场景 1：本地空 + 远端有数据
  const A = mergeFixture(NOW_WED, mock)
  mock.writeRemote('flowpilot/data.json', syncSnapshot(12, demoState()))
  const pulled = await A.service.run({ mode: 'merge' })
  assert.equal(pulled.direction, 'pull')
  assert.equal(pulled.uploaded, false, '降级 pull 不需要回传（云端已是最新）')
  assert.equal(pulled.mergedRevision, 12)
  assert.ok(existsSync(A.service.baseFile), '降级 pull 也要写 base')
  assert.equal(JSON.parse(readFileSync(A.service.baseFile, 'utf8')).revision, 12)
  assert.equal(A.engine.snapshot().state.projects.length, 4)
  // 场景 2：base 缺失 + 远端无快照 → 上传本地
  const B = mergeFixture(NOW_WED, mock)
  mock.state.files.clear()
  dispatchOk(B.engine, 'seedDemo')
  const localRev = B.engine.snapshot().revision
  const pushed = await B.service.run({ mode: 'merge' })
  assert.equal(pushed.direction, 'push')
  assert.equal(pushed.uploaded, true)
  assert.equal(pushed.mergedRevision, localRev)
  assert.ok(existsSync(B.service.baseFile))
  assert.equal(mock.readSnapshot('flowpilot/data.json').revision, localRev)
})

test('merge：两边改不同记录 → 两边的改动都保留', async () => {
  const mock = await githubMock()
  const A = mergeFixture(NOW_WED, mock)
  dispatchOk(A.engine, 'seedDemo')
  await A.service.push({})
  const B = await bootstrapClientB(mock)
  const projectId = B.engine.snapshot().state.projects[0].id
  dispatchOk(B.engine, 'updateProject', { projectId, title: '云端改名的项目' })
  await B.service.push({})
  dispatchOk(A.engine, 'createLine', { name: '本地新增线' })
  const out = await A.service.run({ mode: 'merge' })
  const merged = A.engine.snapshot().state
  assert.equal(merged.projects.find((project) => project.id === projectId).title, '云端改名的项目', '远端改名保留')
  assert.ok(merged.businessLines.some((line) => line.name === '本地新增线'), '本地新增保留')
  assert.equal(out.direction, 'merge')
  assert.equal(out.merged.conflicts.length, 0, '改的是不同记录，不应有冲突')
  const cloud = mock.readSnapshot('flowpilot/data.json')
  assert.equal(cloud.revision, out.mergedRevision)
  assert.ok(cloud.state.businessLines.some((line) => line.name === '本地新增线'))
})

test('merge：同一节点两边改状态 → lastTouch 更晚者胜且记录冲突', async () => {
  const mock = await githubMock()
  const A = mergeFixture(NOW_WED, mock)
  dispatchOk(A.engine, 'seedDemo')
  await A.service.push({})
  const B = await bootstrapClientB(mock)
  const node = readyNodeOf(A.engine.snapshot().state)
  // A（本地，15:30 事件）改成 blocked
  saveState(A.engine, (state) => {
    const target = state.nodes.find((item) => item.id === node.id)
    target.status = 'blocked'
    state.events.push({
      id: 'ev_merge_local', projectId: target.projectId, flowId: target.flowId, nodeId: target.id,
      kind: 'nodeStatus', timestamp: isoOf(new Date(2026, 10, 4, 15, 30, 0)), details: '本地 block', round: target.round,
    })
  })
  // B（远端，18:00 事件 + completedAt）改成 completed → 更新的一方
  saveState(B.engine, (state) => {
    const target = state.nodes.find((item) => item.id === node.id)
    target.status = 'completed'
    target.completedAt = isoOf(new Date(2026, 10, 4, 18, 0, 0))
    state.events.push({
      id: 'ev_merge_remote', projectId: target.projectId, flowId: target.flowId, nodeId: target.id,
      kind: 'nodeStatus', timestamp: isoOf(new Date(2026, 10, 4, 18, 0, 0)), details: '远端完成', round: target.round,
    })
  })
  await B.service.push({})
  const out = await A.service.run({ mode: 'merge' })
  const merged = A.engine.snapshot().state
  assert.equal(merged.nodes.find((item) => item.id === node.id).status, 'completed', 'lastTouch 更晚的远端胜')
  const conflict = out.merged.conflicts.find((item) => item.collection === 'nodes' && item.id === node.id && item.field === 'status')
  assert.ok(conflict, '冲突要记录到 merged.conflicts')
  assert.equal(conflict.winner, 'remote')
})

test('merge：本地删项目、远端没动 → 删除生效并级联清理节点/流程/链接/事件', async () => {
  const mock = await githubMock()
  const A = mergeFixture(NOW_WED, mock)
  dispatchOk(A.engine, 'seedDemo')
  await A.service.push({})
  const base = A.engine.snapshot().state
  const project = base.projects[0]
  dispatchOk(A.engine, 'deleteProject', { projectId: project.id, confirm: 'DELETE' })
  const out = await A.service.run({ mode: 'merge' })
  const merged = A.engine.snapshot().state
  assert.ok(!merged.projects.some((item) => item.id === project.id), '本地删除生效')
  assert.ok(!merged.flows.some((flow) => flow.projectId === project.id), '流程被级联清理')
  assert.ok(!merged.nodes.some((node) => node.projectId === project.id), '节点被级联清理')
  assert.ok(merged.links.every((link) => merged.nodes.some((node) => node.id === link.nodeId)), '链接无孤儿')
  assert.ok(merged.dependencies.every((dep) => merged.nodes.some((node) => node.id === dep.fromNodeId) && merged.nodes.some((node) => node.id === dep.toNodeId)), '依赖无孤儿')
  assert.equal(out.merged.deleted.projects, 1)
  assert.ok((out.merged.deleted.nodes ?? 0) > 0)
  assert.ok((out.merged.pruned.events ?? 0) > 0, '项目相关历史事件按 deleteProject 级联清理')
  const cloud = mock.readSnapshot('flowpilot/data.json')
  assert.ok(!cloud.state.projects.some((item) => item.id === project.id))
})

test('merge：本地删、远端后改 → 复活并记 resurrected', async () => {
  const mock = await githubMock()
  const A = mergeFixture(NOW_WED, mock)
  dispatchOk(A.engine, 'seedDemo')
  await A.service.push({})
  const B = await bootstrapClientB(mock)
  const node = readyNodeOf(A.engine.snapshot().state)
  // A 本地删除节点（及其链接 / 依赖引用）
  saveState(A.engine, (state) => {
    state.nodes = state.nodes.filter((item) => item.id !== node.id)
    state.links = state.links.filter((link) => link.nodeId !== node.id)
    state.dependencies = state.dependencies.filter((dep) => dep.fromNodeId !== node.id && dep.toNodeId !== node.id)
  })
  // B 远端在删除之后又改了该节点标题（18:00 事件）
  saveState(B.engine, (state) => {
    const target = state.nodes.find((item) => item.id === node.id)
    target.title = '远端后改的节点标题'
    state.events.push({
      id: 'ev_merge_resurrect', projectId: target.projectId, flowId: target.flowId, nodeId: target.id,
      kind: 'nodeStatus', timestamp: isoOf(new Date(2026, 10, 4, 18, 0, 0)), details: '远端后改', round: target.round,
    })
  })
  await B.service.push({})
  const out = await A.service.run({ mode: 'merge' })
  const merged = A.engine.snapshot().state
  const revived = merged.nodes.find((item) => item.id === node.id)
  assert.ok(revived, '远端在删除后改过 → 节点复活')
  assert.equal(revived.title, '远端后改的节点标题')
  assert.ok(out.merged.resurrected.some((item) => item.collection === 'nodes' && item.id === node.id))
})

test('merge：events 并集去重且按时间稳定有序', async () => {
  const mock = await githubMock()
  const A = mergeFixture(NOW_WED, mock)
  dispatchOk(A.engine, 'seedDemo')
  await A.service.push({})
  const B = await bootstrapClientB(mock)
  const projectId = A.engine.snapshot().state.projects[0].id
  const baseEvents = A.engine.snapshot().state.events.length
  dispatchOk(A.engine, 'addNote', { projectId, text: '本地新增备注' })
  dispatchOk(B.engine, 'addNote', { projectId, text: '远端新增备注' })
  await B.service.push({})
  const out = await A.service.run({ mode: 'merge' })
  const events = A.engine.snapshot().state.events
  assert.equal(events.length, baseEvents + 2, '并集 = base + 两边各 1 条')
  assert.equal(new Set(events.map((event) => event.id)).size, events.length, '事件按 id 去重')
  const times = events.map((event) => Date.parse(event.timestamp))
  assert.deepEqual(times.slice().sort((a, b) => a - b), times, '事件按时间升序（同值按 id）')
  assert.equal(out.merged.added.events, 2)
})

test('merge：settings 冲突 → local 优先且 dataFile 保留本地路径', async () => {
  const mock = await githubMock()
  const A = mergeFixture(NOW_WED, mock)
  dispatchOk(A.engine, 'seedDemo')
  await A.service.push({})
  const B = await bootstrapClientB(mock)
  dispatchOk(A.engine, 'updateSettings', { patch: { handoffTime: '21:00' } })
  dispatchOk(B.engine, 'updateSettings', { patch: { handoffTime: '22:00' } })
  await B.service.push({})
  const out = await A.service.run({ mode: 'merge' })
  const merged = A.engine.snapshot().state
  assert.equal(merged.settings.handoffTime, '21:00', 'settings 双改 → local 优先')
  assert.ok(out.merged.conflicts.some((item) => item.collection === 'settings' && item.field === 'handoffTime' && item.winner === 'local'))
  assert.equal(merged.settings.dataFile, join(A.dataDir, 'data.json'), 'dataFile 强制本地（机器路径不能串）')
})

test('merge：revision = max(local, remote)+1，上传内容 = 合并结果（含嵌套 result）', async () => {
  const mock = await githubMock()
  const A = mergeFixture(NOW_WED, mock)
  dispatchOk(A.engine, 'seedDemo')
  await A.service.push({})
  const localRevBefore = A.engine.snapshot().revision
  const remoteRevBefore = mock.readSnapshot('flowpilot/data.json').revision
  dispatchOk(A.engine, 'createLine', { name: 'revision 测试线' })
  const out = await A.service.run({ mode: 'merge' })
  assert.equal(out.mergedRevision, Math.max(localRevBefore + 1, remoteRevBefore) + 1)
  assert.equal(A.engine.snapshot().revision, out.mergedRevision)
  const cloud = mock.readSnapshot('flowpilot/data.json')
  assert.equal(cloud.revision, out.mergedRevision, '云端 revision = 合并 revision')
  assert.equal(cloud.state.businessLines.length, A.engine.snapshot().state.businessLines.length)
  assert.deepEqual(cloud.state.projects.map((project) => project.id), A.engine.snapshot().state.projects.map((project) => project.id))
  // 嵌套 result（客户端读 result.merged / result.mergedRevision）
  const result = out.result
  assert.ok(result && typeof result === 'object', 'merge 结果同时给嵌套 result')
  assert.equal(result.mode, 'merge')
  assert.equal(result.direction, 'merge')
  assert.equal(result.uploaded, true)
  assert.equal(result.mergedRevision, out.mergedRevision)
  assert.equal(result.basePath, A.service.baseFile)
  assert.ok(result.merged && Array.isArray(result.merged.conflicts))
  const baseAfter = JSON.parse(readFileSync(A.service.baseFile, 'utf8'))
  assert.equal(baseAfter.revision, out.mergedRevision, 'merge 成功后 base = 合并结果（revision 同步）')
})

test('merge：base 快照写入 sync-base.json 且权限 0600', async () => {
  const mock = await githubMock()
  const A = mergeFixture(NOW_WED, mock)
  dispatchOk(A.engine, 'seedDemo')
  await A.service.push({})
  assert.ok(existsSync(A.service.baseFile), 'base 文件应落在 sync.json 同目录')
  assert.equal(A.service.baseFile, join(A.dataDir, 'sync-base.json'))
  const base = JSON.parse(readFileSync(A.service.baseFile, 'utf8'))
  assert.equal(base.kind, 'sync-base')
  assert.equal(base.revision, A.engine.snapshot().revision)
  assert.equal(base.state.projects.length, 4)
  assert.equal(statSync(A.service.baseFile).mode & 0o777, 0o600, 'base 必须是 0600')
})

test('merge dryRun：完整算一遍但不写 backup/base/本地/远端', async () => {
  const mock = await githubMock()
  const A = mergeFixture(NOW_WED, mock)
  dispatchOk(A.engine, 'seedDemo')
  await A.service.push({})
  const B = await bootstrapClientB(mock)
  const projectId = B.engine.snapshot().state.projects[0].id
  dispatchOk(B.engine, 'updateProject', { projectId, title: 'dryRun 远端改动' })
  await B.service.push({})
  const revBefore = A.engine.snapshot().revision
  const putsBefore = mock.state.puts
  const backupsBefore = preMergeBackupFiles(A.dataDir).length
  const baseMtimeBefore = statSync(A.service.baseFile).mtimeMs
  const dataMtimeBefore = statSync(join(A.dataDir, 'data.json')).mtimeMs
  const out = await A.service.run({ mode: 'merge', dryRun: true })
  assert.equal(out.dryRun, true)
  assert.equal(out.mode, 'merge')
  assert.equal(out.direction, 'merge')
  assert.equal(out.uploaded, false)
  assert.ok(out.merged && typeof out.merged === 'object', 'dryRun 也要返回合并统计')
  assert.ok(Array.isArray(out.merged.conflicts))
  assert.ok(Array.isArray(out.merged.resurrected))
  assert.equal(A.engine.snapshot().revision, revBefore, 'dryRun 不写本地')
  assert.equal(mock.state.puts, putsBefore, 'dryRun 不写远端')
  assert.equal(preMergeBackupFiles(A.dataDir).length, backupsBefore, 'dryRun 不生成 pre-merge 备份')
  assert.equal(statSync(A.service.baseFile).mtimeMs, baseMtimeBefore, 'dryRun 不写 base')
  assert.equal(statSync(join(A.dataDir, 'data.json')).mtimeMs, dataMtimeBefore, 'dryRun 不写数据文件')
})

test('merge：pre-merge 备份包含三方原始 state', async () => {
  const mock = await githubMock()
  const A = mergeFixture(NOW_WED, mock)
  dispatchOk(A.engine, 'seedDemo')
  await A.service.push({})
  const B = await bootstrapClientB(mock)
  const projectId = B.engine.snapshot().state.projects[0].id
  dispatchOk(B.engine, 'updateProject', { projectId, title: '备份用远端改动' })
  await B.service.push({})
  dispatchOk(A.engine, 'createLine', { name: '备份用本地改动' })
  const out = await A.service.run({ mode: 'merge' })
  const files = preMergeBackupFiles(A.dataDir)
  assert.equal(files.length, 1)
  assert.ok(out.backupPath && existsSync(out.backupPath))
  const backup = JSON.parse(readFileSync(files[0], 'utf8'))
  assert.equal(backup.kind, 'pre-merge')
  assert.equal(backup.baseMissing, false)
  assert.ok(Array.isArray(backup.local.projects) && backup.local.projects.length >= 4)
  assert.ok(Array.isArray(backup.remote.projects) && backup.remote.projects.length >= 4)
  assert.ok(Array.isArray(backup.base.projects) && backup.base.projects.length >= 4)
  assert.ok(Number.isInteger(backup.localRevision))
  assert.ok(Number.isInteger(backup.remoteRevision))
  assert.ok(Number.isInteger(backup.baseRevision))
})

test('merge：第二次同步收敛（无增删改冲突，revision 仍单调 +1 并上传）', async () => {
  const mock = await githubMock()
  const A = mergeFixture(NOW_WED, mock)
  dispatchOk(A.engine, 'seedDemo')
  await A.service.push({})
  const B = await bootstrapClientB(mock)
  const projectId = B.engine.snapshot().state.projects[0].id
  dispatchOk(B.engine, 'updateProject', { projectId, title: '收敛测试远端改动' })
  await B.service.push({})
  dispatchOk(A.engine, 'createLine', { name: '收敛测试本地改动' })
  const first = await A.service.run({ mode: 'merge' })
  const again = await A.service.run({ mode: 'merge' })
  assert.equal(again.uploaded, true, '即便无变更也要上传合并结果')
  assert.equal(again.mode, 'merge')
  assert.deepEqual(again.merged.added, {})
  assert.deepEqual(again.merged.updated, {})
  assert.deepEqual(again.merged.deleted, {})
  assert.deepEqual(again.merged.pruned, {})
  assert.deepEqual(again.merged.conflicts, [])
  assert.deepEqual(again.merged.resurrected, [])
  assert.equal(again.mergedRevision, first.mergedRevision + 1, 'revision 单调 +1')
  assert.equal(mock.readSnapshot('flowpilot/data.json').revision, again.mergedRevision)
  assert.equal(A.engine.snapshot().revision, again.mergedRevision)
})

test('merge：默认 run() 即 merge；newest / three-way 旧模式不回归', async () => {
  const mock = await githubMock()
  const A = mergeFixture(NOW_WED, mock)
  dispatchOk(A.engine, 'seedDemo')
  await A.service.push({})
  const defaultRun = await A.service.run({})
  assert.equal(defaultRun.mode, 'merge', '不传 mode 默认 merge')
  assert.equal(defaultRun.action, 'merge')
  assert.equal(defaultRun.uploaded, true)
  const newest = await A.service.run({ mode: 'newest' })
  assert.equal(newest.mode, 'newest')
  assert.equal(newest.uploaded, true)
  assert.ok(['push', 'pull', 'noop'].includes(newest.direction))
  const threeWay = await A.service.run({ mode: 'three-way' })
  assert.equal(threeWay.action, 'noop', '两端一致时旧三路比较为 noop')
})

test('merge：合并后 derived 可正常计算（snapshot / 只读 action 不抛）', async () => {
  const mock = await githubMock()
  const A = mergeFixture(NOW_WED, mock)
  dispatchOk(A.engine, 'seedDemo')
  await A.service.push({})
  const B = await bootstrapClientB(mock)
  const projectId = B.engine.snapshot().state.projects[0].id
  dispatchOk(B.engine, 'updateProject', { projectId, title: 'derived 测试远端改动' })
  await B.service.push({})
  dispatchOk(A.engine, 'createLine', { name: 'derived 测试本地改动' })
  await A.service.run({ mode: 'merge' })
  const snapshot = A.engine.snapshot()
  assert.ok(snapshot.derived && typeof snapshot.derived === 'object')
  assert.doesNotThrow(() => dispatchOk(A.engine, 'overview'))
  assert.doesNotThrow(() => dispatchOk(A.engine, 'today'))
})

/* ------------------------------------------------------------------ *
 * 11. 冲突审阅：merge conflictDetails + sync-conflicts.json + resolve/clear
 * ------------------------------------------------------------------ */

group('同步 · 冲突审阅（conflictDetails + resolve / clear）')

/**
 * 构造 n 个「同一节点 status 双改」的冲突：本地（A，19:00 事件）后改 → winner=local；
 * 远端（B，17:00 事件）先改。返回时 A 已跑过 merge（除非 options.dryRun）。
 */
async function makeConflictFixture(count = 1, options = {}) {
  const mock = await githubMock()
  const A = mergeFixture(NOW_WED, mock)
  dispatchOk(A.engine, 'seedDemo')
  await A.service.push({})
  const B = await bootstrapClientB(mock)
  // 任取非 completed 的节点（base 状态与两边新值都不同才会构成 status 冲突）
  const nodes = A.engine.snapshot().state.nodes.filter((node) => node.status !== 'completed').slice(0, count)
  assert.equal(nodes.length, count, `示例数据里应有 ${count} 个非 completed 节点`)
  const nodeIds = nodes.map((node) => node.id)
  const baseStatuses = nodes.map((node) => node.status)
  // 默认 winner=local（本地事件更晚）；options.winner='remote' 时反转时间让远端胜
  const localWins = options.winner !== 'remote'
  const stampLocal = isoOf(new Date(2026, 10, 4, localWins ? 19 : 15, 0, 0))
  const stampRemote = isoOf(new Date(2026, 10, 4, localWins ? 17 : 19, 0, 0))
  saveState(A.engine, (state) => {
    nodeIds.forEach((id, index) => {
      const target = state.nodes.find((item) => item.id === id)
      target.status = 'blocked'
      state.events.push({
        id: `ev_conf_local_${index}`, projectId: target.projectId, flowId: target.flowId, nodeId: id,
        kind: 'nodeStatus', timestamp: stampLocal, details: '本地改', round: target.round,
      })
    })
  })
  saveState(B.engine, (state) => {
    nodeIds.forEach((id, index) => {
      const target = state.nodes.find((item) => item.id === id)
      target.status = 'completed'
      target.completedAt = stampRemote
      state.events.push({
        id: `ev_conf_remote_${index}`, projectId: target.projectId, flowId: target.flowId, nodeId: id,
        kind: 'nodeStatus', timestamp: stampRemote, details: '远端改', round: target.round,
      })
    })
  })
  await B.service.push({})
  const out = await A.service.run({ mode: 'merge', dryRun: options.dryRun === true })
  return { mock, A, B, nodeIds, baseStatuses, out }
}

test('mergeThreeWay：conflictDetails 带三方原始值 / label / 稳定 id（settings 也覆盖）', () => {
  const base = {
    nodes: [{ id: 'n1', projectId: 'p1', code: 'D04', title: '交互稿', status: 'ready' }],
    projects: [{ id: 'p1', title: '项目A' }],
    settings: { handoffTime: '20:45', dataFile: '/old/data.json' },
    events: [],
  }
  const local = {
    nodes: [{ id: 'n1', projectId: 'p1', code: 'D04', title: '交互稿', status: 'blocked' }],
    projects: [{ id: 'p1', title: '项目A' }],
    settings: { handoffTime: '21:00', dataFile: '/local/data.json' },
    events: [{ id: 'e1', projectId: 'p1', nodeId: 'n1', timestamp: '2026-01-02T00:00:00.000Z' }],
  }
  const remote = {
    nodes: [{ id: 'n1', projectId: 'p1', code: 'D04', title: '交互稿', status: 'completed' }],
    projects: [{ id: 'p1', title: '项目A' }],
    settings: { handoffTime: '22:00', dataFile: '/remote/data.json' },
    events: [{ id: 'e2', projectId: 'p1', nodeId: 'n1', timestamp: '2026-01-03T00:00:00.000Z' }],
  }
  const { stats } = mergeThreeWay(base, local, remote)
  assert.equal(stats.conflictDetails.length, stats.conflicts.length, 'details 与 conflicts 一一对应')
  const nodeDetail = stats.conflictDetails.find((item) => item.collection === 'nodes' && item.field === 'status')
  assert.ok(nodeDetail, '节点 status 冲突要有详情')
  assert.equal(nodeDetail.id, 'nodes:n1:status')
  assert.equal(nodeDetail.recordId, 'n1')
  assert.equal(nodeDetail.label, 'D04 交互稿')
  assert.equal(nodeDetail.baseValue, 'ready')
  assert.equal(nodeDetail.localValue, 'blocked')
  assert.equal(nodeDetail.remoteValue, 'completed')
  assert.equal(nodeDetail.winner, 'remote', '远端事件更晚')
  const settingsDetail = stats.conflictDetails.find((item) => item.collection === 'settings' && item.field === 'handoffTime')
  assert.ok(settingsDetail, 'settings 冲突也要有详情')
  assert.equal(settingsDetail.label, 'handoffTime')
  assert.equal(settingsDetail.winner, 'local')
  assert.equal(settingsDetail.baseValue, '20:45')
})

test('conflictDetails：dryRun 也返回候选值，且不写 sync-conflicts.json', async () => {
  const { A, nodeIds, baseStatuses, out } = await makeConflictFixture(1, { dryRun: true })
  assert.equal(out.dryRun, true)
  assert.equal(out.conflictDetails.length, 1)
  assert.equal(out.result.conflictDetails.length, 1, '嵌套 result 也要有')
  assert.equal(out.merged.conflictDetails.length, 1, 'merged 统计里也保留')
  const detail = out.conflictDetails[0]
  assert.equal(detail.collection, 'nodes')
  assert.equal(detail.recordId, nodeIds[0])
  assert.equal(detail.field, 'status')
  assert.equal(detail.baseValue, baseStatuses[0])
  assert.equal(detail.localValue, 'blocked')
  assert.equal(detail.remoteValue, 'completed')
  assert.equal(detail.winner, 'local')
  assert.ok(typeof detail.label === 'string' && detail.label !== '', 'label 必须可读')
  assert.equal(existsSync(A.service.conflictsFile), false, 'dryRun 不写冲突文件')
  assert.equal(A.service.conflicts().count, 0)
})

test('真实 merge 有冲突 → 写 sync-conflicts.json（0600，内容与 result 一致）', async () => {
  const { A, baseStatuses, out } = await makeConflictFixture(1)
  assert.equal(out.conflictDetails.length, 1)
  assert.ok(existsSync(A.service.conflictsFile), '真实 merge 应写待审阅冲突文件')
  assert.equal(A.service.conflictsFile, join(A.dataDir, 'sync-conflicts.json'))
  assert.equal(statSync(A.service.conflictsFile).mode & 0o777, 0o600, '冲突文件必须是 0600')
  const saved = JSON.parse(readFileSync(A.service.conflictsFile, 'utf8'))
  assert.equal(saved.kind, 'sync-conflicts')
  assert.equal(saved.formatVersion, 1)
  assert.ok(!Number.isNaN(Date.parse(saved.at)))
  assert.equal(saved.conflicts.length, 1)
  const stored = saved.conflicts[0]
  assert.equal(stored.id, out.conflictDetails[0].id)
  assert.equal(stored.collection, 'nodes')
  assert.equal(stored.recordId, out.conflictDetails[0].recordId)
  assert.equal(stored.label, out.conflictDetails[0].label)
  assert.equal(stored.field, 'status')
  assert.equal(stored.baseValue, baseStatuses[0])
  assert.equal(stored.localValue, 'blocked')
  assert.equal(stored.remoteValue, 'completed')
  assert.equal(stored.winner, 'local')
  assert.ok(!Number.isNaN(Date.parse(stored.at)), '每条冲突带 at')
  assert.ok(Number.isInteger(saved.localRevision) && Number.isInteger(saved.remoteRevision))
  assert.equal(A.service.conflicts().count, 1)
})

test('无冲突的 merge → sync-conflicts.json 被写成空数组（清掉旧冲突）', async () => {
  const { mock, A } = await makeConflictFixture(1)
  assert.equal(A.service.conflicts().count, 1, '前置：先有 1 条待审阅冲突')
  // 直接改云端快照：把节点 status 改成与本地相同的 blocked → 下一次 merge 无冲突
  const cloud = mock.readSnapshot('flowpilot/data.json')
  const localState = A.engine.snapshot().state
  const target = localState.nodes.find((node) => node.status === 'blocked')
  assert.ok(target, '本地应有 blocked 节点')
  cloud.state.nodes = cloud.state.nodes.map((node) => (node.id === target.id ? { ...node, status: 'blocked' } : node))
  mock.writeRemote('flowpilot/data.json', cloud)
  const out = await A.service.run({ mode: 'merge' })
  assert.equal(out.conflictDetails.length, 0, '两边一致后不再有冲突')
  assert.equal(A.service.conflicts().count, 0, '无冲突 merge 应清空旧列表')
  const saved = JSON.parse(readFileSync(A.service.conflictsFile, 'utf8'))
  assert.equal(saved.kind, 'sync-conflicts')
  assert.deepEqual(saved.conflicts, [], '列表写成空数组（不是删文件）')
})

test('GET /sync/conflicts：文件不存在 → count 0；有冲突返回完整字段（未配置也能读）', async () => {
  // 未配置通道 + 无文件
  const bare = makeSyncFixture()
  const bareRoutes = new Map(createRoutes({ engine: bare.engine, syncService: bare.service, logger: quietLogger })
    .map(({ path, handler }) => [path, handler]))
  const emptyOut = await callRoute(bareRoutes.get(API_PATHS.syncConflicts), { method: 'GET', headers: { host: 'h' } })
  assert.equal(emptyOut.status, 200)
  assert.equal(emptyOut.json.ok, true)
  assert.equal(emptyOut.json.count, 0)
  assert.deepEqual(emptyOut.json.conflicts, [])
  // 文件损坏 → 按空列表处理（不抛）
  writeFileSync(bare.service.conflictsFile, '{ 不是 JSON')
  const brokenOut = await callRoute(bareRoutes.get(API_PATHS.syncConflicts), { method: 'GET', headers: { host: 'h' } })
  assert.equal(brokenOut.status, 200)
  assert.equal(brokenOut.json.count, 0, '损坏文件按空列表处理')
  // 有冲突（用另一个桩的 fixture）
  const { A, baseStatuses, out } = await makeConflictFixture(1)
  const routes = new Map(createRoutes({ engine: A.engine, syncService: A.service, logger: quietLogger })
    .map(({ path, handler }) => [path, handler]))
  const out2 = await callRoute(routes.get(API_PATHS.syncConflicts), { method: 'GET', headers: { host: 'h' } })
  assert.equal(out2.status, 200)
  assert.equal(out2.json.count, 1)
  const item = out2.json.conflicts[0]
  assert.equal(item.id, out.conflictDetails[0].id)
  assert.equal(item.collection, 'nodes')
  assert.equal(item.recordId, out.conflictDetails[0].recordId)
  assert.equal(item.label, out.conflictDetails[0].label)
  assert.equal(item.field, 'status')
  assert.equal(item.baseValue, baseStatuses[0])
  assert.equal(item.localValue, 'blocked')
  assert.equal(item.remoteValue, 'completed')
  assert.equal(item.winner, 'local')
  assert.ok(typeof out2.json.at === 'string')
  assert.ok(Number.isInteger(out2.json.localRevision) && Number.isInteger(out2.json.remoteRevision))
})

test('resolve choice=remote：写回 remoteValue、revision+1、上传一次、列表移除并可再 merge 收敛', async () => {
  const { mock, A, nodeIds, out } = await makeConflictFixture(1)
  const detail = out.conflictDetails[0]
  const revBefore = A.engine.snapshot().revision
  const putsBefore = mock.state.puts
  const result = await A.service.resolveConflicts({ id: detail.id, choice: 'remote' })
  assert.equal(result.applied, 1)
  assert.deepEqual(result.skipped, [])
  assert.equal(result.remaining, 0)
  assert.equal(result.uploaded, true)
  assert.equal(result.revision, revBefore + 1, '本地 revision +1')
  assert.equal(A.engine.snapshot().revision, revBefore + 1)
  const node = A.engine.snapshot().state.nodes.find((item) => item.id === nodeIds[0])
  assert.equal(node.status, 'completed', '写回 remoteValue')
  assert.equal(mock.state.puts, putsBefore + 1, 'resolve 后上传一次')
  assert.equal(mock.readSnapshot('flowpilot/data.json').state.nodes.find((item) => item.id === nodeIds[0]).status, 'completed')
  assert.equal(A.service.conflicts().count, 0, '已解决项从列表移除')
  const again = await A.service.run({ mode: 'merge' })
  assert.equal(again.conflictDetails.length, 0, 'resolve 后再 merge 应无冲突（收敛）')
})

test('resolve choice=local（winner=local）：值不变、applied 计 1、仍上传、列表移除', async () => {
  const { mock, A, nodeIds, out } = await makeConflictFixture(1)
  const detail = out.conflictDetails[0]
  assert.equal(detail.winner, 'local')
  const revBefore = A.engine.snapshot().revision
  const putsBefore = mock.state.puts
  const nodeBefore = A.engine.snapshot().state.nodes.find((item) => item.id === nodeIds[0]).status
  const result = await A.service.resolveConflicts({ id: detail.id, choice: 'local' })
  assert.equal(result.applied, 1, '即便值不变也算已审阅（applied 1）')
  assert.equal(result.uploaded, true)
  assert.equal(result.revision, revBefore + 1)
  assert.equal(mock.state.puts, putsBefore + 1)
  const node = A.engine.snapshot().state.nodes.find((item) => item.id === nodeIds[0])
  assert.equal(node.status, nodeBefore, 'winner=local 时当前值本来就等于 localValue → 写回后不变')
  assert.equal(node.status, detail.localValue)
  assert.equal(A.service.conflicts().count, 0)
})

test('resolve choice=local（winner=remote）：恢复 localValue 候选值并上传一次', async () => {
  const { mock, A, nodeIds, out } = await makeConflictFixture(1, { winner: 'remote' })
  const detail = out.conflictDetails[0]
  assert.equal(detail.winner, 'remote', '前置：远端 lastTouch 更晚')
  assert.equal(detail.localValue, 'blocked')
  assert.equal(detail.remoteValue, 'completed')
  // merge 已把远端值写回本地 → 本地当前是 completed
  assert.equal(A.engine.snapshot().state.nodes.find((item) => item.id === nodeIds[0]).status, 'completed')
  const revBefore = A.engine.snapshot().revision
  const putsBefore = mock.state.puts
  const result = await A.service.resolveConflicts({ id: detail.id, choice: 'local' })
  assert.equal(result.applied, 1)
  assert.equal(result.uploaded, true)
  assert.equal(result.revision, revBefore + 1)
  assert.equal(mock.state.puts, putsBefore + 1, '恢复候选值后仍上传一次')
  const node = A.engine.snapshot().state.nodes.find((item) => item.id === nodeIds[0])
  assert.equal(node.status, 'blocked', 'choice=local 把 localValue 写回本地（恢复候选值）')
  assert.equal(mock.readSnapshot('flowpilot/data.json').state.nodes.find((item) => item.id === nodeIds[0]).status, 'blocked')
  assert.equal(A.service.conflicts().count, 0)
})

test('resolve all:true 批量 + 不存在的 id → skipped 且 remaining 不变', async () => {
  const { A, nodeIds, out } = await makeConflictFixture(2)
  assert.equal(out.conflictDetails.length, 2)
  const revBefore = A.engine.snapshot().revision
  const missing = await A.service.resolveConflicts({ id: 'nodes:nope:status', choice: 'remote' })
  assert.equal(missing.applied, 0)
  assert.equal(missing.skipped.length, 1)
  assert.equal(missing.skipped[0].id, 'nodes:nope:status')
  assert.equal(missing.remaining, 2)
  assert.equal(missing.uploaded, false)
  assert.equal(missing.revision, revBefore, '没有应用任何项时不动 revision')
  const all = await A.service.resolveConflicts({ all: true, choice: 'remote' })
  assert.equal(all.applied, 2)
  assert.equal(all.remaining, 0)
  assert.equal(all.uploaded, true)
  for (const id of nodeIds) {
    assert.equal(A.engine.snapshot().state.nodes.find((item) => item.id === id).status, 'completed')
  }
  assert.equal(A.service.conflicts().count, 0)
})

test('resolve：记录已被删除 → skipped，remaining 不变、不上传', async () => {
  const { A, nodeIds, out } = await makeConflictFixture(1)
  const detail = out.conflictDetails[0]
  // 模拟审阅前记录被删除
  saveState(A.engine, (state) => {
    state.nodes = state.nodes.filter((item) => item.id !== nodeIds[0])
    state.links = state.links.filter((link) => link.nodeId !== nodeIds[0])
    state.dependencies = state.dependencies.filter((dep) => dep.fromNodeId !== nodeIds[0] && dep.toNodeId !== nodeIds[0])
  })
  const revBefore = A.engine.snapshot().revision
  const result = await A.service.resolveConflicts({ id: detail.id, choice: 'remote' })
  assert.equal(result.applied, 0)
  assert.equal(result.uploaded, false)
  assert.equal(result.remaining, 1)
  assert.equal(result.revision, revBefore)
  assert.equal(result.skipped.length, 1)
  assert.ok(String(result.skipped[0].reason).includes('不存在'), `skipped 原因要可读：${result.skipped[0].reason}`)
  assert.equal(A.service.conflicts().count, 1, '跳过项保留在待审阅列表')
})

test('clear：清空待审阅列表且不改数据', async () => {
  const { A, nodeIds } = await makeConflictFixture(1)
  const revBefore = A.engine.snapshot().revision
  const statusBefore = A.engine.snapshot().state.nodes.find((item) => item.id === nodeIds[0]).status
  const result = A.service.clearConflicts()
  assert.equal(result.cleared, 1)
  assert.equal(A.service.conflicts().count, 0)
  assert.equal(A.engine.snapshot().revision, revBefore, 'clear 不改数据（revision 不变）')
  assert.equal(A.engine.snapshot().state.nodes.find((item) => item.id === nodeIds[0]).status, statusBefore)
})

test('非 merge 模式（newest / three-way / push / pull）不清空待审阅列表', async () => {
  const { A, out } = await makeConflictFixture(1)
  assert.equal(A.service.conflicts().count, 1)
  await A.service.run({ mode: 'newest' })
  assert.equal(A.service.conflicts().count, 1, 'newest 不应清空')
  await A.service.run({ mode: 'three-way' })
  assert.equal(A.service.conflicts().count, 1, 'three-way 不应清空')
  await A.service.push({ force: true })
  assert.equal(A.service.conflicts().count, 1, 'push 不应清空')
  await A.service.pull({ force: true })
  assert.equal(A.service.conflicts().count, 1, 'pull 不应清空')
  assert.ok(out.backupPath)
})

test('HTTP：未配置通道 resolve → 400 SYNC_NOT_CONFIGURED；GET 仍可读', async () => {
  const bare = makeSyncFixture()
  const routes = new Map(createRoutes({ engine: bare.engine, syncService: bare.service, logger: quietLogger })
    .map(({ path, handler }) => [path, handler]))
  const readOut = await callRoute(routes.get(API_PATHS.syncConflicts), { method: 'GET', headers: { host: 'h' } })
  assert.equal(readOut.status, 200)
  assert.equal(readOut.json.count, 0)
  const resolveOut = await callRoute(routes.get(API_PATHS.syncConflictsResolve), {
    method: 'POST', headers: { host: 'h' }, body: JSON.stringify({ id: 'x', choice: 'remote' }),
  })
  assert.equal(resolveOut.status, 400)
  assert.equal(resolveOut.json.ok, false)
  assert.equal(resolveOut.json.code, 'SYNC_NOT_CONFIGURED')
  assert.ok(typeof resolveOut.json.error === 'string' && resolveOut.json.error !== '')
})

test('HTTP：冲突审阅三条路由（GET / resolve / clear）+ 参数校验 + 405', async () => {
  const { A, out } = await makeConflictFixture(2)
  for (const key of ['syncConflicts', 'syncConflictsResolve', 'syncConflictsClear']) {
    assert.ok(API_PATHS[key], `API_PATHS 缺 ${key}`)
  }
  const routes = new Map(createRoutes({ engine: A.engine, syncService: A.service, logger: quietLogger })
    .map(({ path, handler }) => [path, handler]))
  const post = (key, body) => callRoute(routes.get(API_PATHS[key]), {
    method: 'POST', headers: { host: 'h' }, body: JSON.stringify(body),
  })
  const listOut = await callRoute(routes.get(API_PATHS.syncConflicts), { method: 'GET', headers: { host: 'h' } })
  assert.equal(listOut.json.count, 2)
  // 参数校验
  const noId = await post('syncConflictsResolve', { choice: 'remote' })
  assert.equal(noId.status, 400)
  assert.equal(noId.json.code, 'INVALID_INPUT')
  const badChoice = await post('syncConflictsResolve', { id: out.conflictDetails[0].id, choice: 'both' })
  assert.equal(badChoice.status, 400)
  assert.equal(badChoice.json.code, 'INVALID_INPUT')
  // 逐条 resolve
  const resolved = await post('syncConflictsResolve', { id: out.conflictDetails[0].id, choice: 'remote' })
  assert.equal(resolved.status, 200)
  assert.equal(resolved.json.ok, true)
  assert.equal(resolved.json.applied, 1)
  assert.equal(resolved.json.remaining, 1)
  assert.equal(resolved.json.uploaded, true)
  assert.ok(Number.isInteger(resolved.json.revision))
  assert.deepEqual(resolved.json.skipped, [])
  // 批量 resolve 剩余
  const all = await post('syncConflictsResolve', { all: true, choice: 'remote' })
  assert.equal(all.status, 200)
  assert.equal(all.json.applied, 1)
  assert.equal(all.json.remaining, 0)
  // clear（已空 → cleared 0）
  const cleared = await post('syncConflictsClear', {})
  assert.equal(cleared.status, 200)
  assert.equal(cleared.json.cleared, 0)
  // 方法校验
  const badMethod = await callRoute(routes.get(API_PATHS.syncConflictsResolve), {
    method: 'GET', headers: { host: 'h' },
  })
  assert.equal(badMethod.status, 405)
})

/* ------------------------------------------------------------------ *
 * 执行
 * ------------------------------------------------------------------ */

for (const item of tests) {
  try {
    await item.fn()
    passed += 1
    console.log(`  ✓ ${item.name}`)
  } catch (error) {
    failures.push(item)
    console.error(`  ✗ ${item.name}`)
    const stack = String(error?.stack ?? error)
    console.error(stack.split('\n').slice(0, 8).map((line) => `      ${line}`).join('\n'))
  }
}

for (const mock of mockServers) {
  try { mock.close() } catch { /* 忽略 */ }
}

for (const dir of tempDirs) {
  try { rmSync(dir, { recursive: true, force: true }) } catch { /* 忽略 */ }
}

console.log(`\n${passed}/${tests.length} 通过`)
if (failures.length > 0) {
  console.error(`\n失败 ${failures.length} 项：`)
  for (const failure of failures) console.error(`  - ${failure.name}`)
  process.exitCode = 1
} else {
  console.log('FlowPilot host selftest：全绿 ✓')
}
