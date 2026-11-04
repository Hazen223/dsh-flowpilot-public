#!/usr/bin/env node
/**
 * 实机自检：探测正在运行的 FlowPilot 插件是否已加载最新宿主/客户端能力。
 *
 * 用法：
 *   node tools/verify-live.mjs                 # 默认探测 127.0.0.1:61855
 *   node tools/verify-live.mjs --port=62000
 *   node tools/verify-live.mjs --verbose
 *
 * 检查项：
 *   1. /flowpilot/api/state 可访问、revision 与项目数正常
 *   2. settings.inheritDesignLink 已存在（设计稿链接继承契约 §4.2 B）
 *   3. deleteProject 动作已注册（用不存在的 projectId 探测：新宿主返回 NOT_FOUND，旧宿主返回「未知动作」）
 *   4. 只读页面路由可用（overview/today 不 500）
 *
 * 只探测不写数据：deleteProject 探测使用不存在的 projectId，命中有校验就不会落库。
 */
const args = process.argv.slice(2)
const portArg = (args.find((a) => a.startsWith('--port=')) || '').split('=')[1]
const PORT = Number(portArg || process.env.FLOWPILOT_PORT || 61855)
const BASE = `http://127.0.0.1:${PORT}`
const VERBOSE = args.includes('--verbose')
/* 可选：实际触发一次「写后自动同步」验证（会做一次真实云同步；默认不跑） */
const EXERCISE_AUTOSYNC = args.includes('--exercise-autosync')

const results = []
function record(name, ok, detail) {
  results.push({ name, ok, detail })
  const line = (ok ? '  ✓ ' : '  ✗ ') + name + (detail && VERBOSE ? ' — ' + detail : '')
  console.log(line)
}

async function getJson(path) {
  const res = await fetch(BASE + path, { signal: AbortSignal.timeout(5000) })
  const text = await res.text()
  let json = null
  try { json = JSON.parse(text) } catch { /* 非 JSON */ }
  return { status: res.status, json, text }
}

async function postJson(path, body) {
  const res = await fetch(BASE + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(5000),
  })
  const text = await res.text()
  let json = null
  try { json = JSON.parse(text) } catch { /* 非 JSON */ }
  return { status: res.status, json, text }
}

console.log(`\nFlowPilot 实机自检 · ${BASE}\n`)

let state = null
try {
  const out = await getJson('/flowpilot/api/state')
  const ok = out.status === 200 && out.json && out.json.ok === true && out.json.state
  record('宿主 API 可访问（/flowpilot/api/state）', ok, 'HTTP ' + out.status)
  state = ok ? out.json.state : null
  if (ok) {
    const revision = out.json.revision
    const projects = Array.isArray(state.projects) ? state.projects.length : -1
    record(`数据形状正常（revision=${revision}，项目 ${projects}）`, projects >= 0)
  }
} catch (error) {
  record('宿主 API 可访问（/flowpilot/api/state）', false, error.message)
}

record(
  '新宿主：settings.inheritDesignLink 已存在',
  state !== null && state.settings && typeof state.settings.inheritDesignLink === 'boolean',
  state === null ? '无数据' : 'inheritDesignLink=' + String(state.settings?.inheritDesignLink),
)

try {
  const out = await postJson('/flowpilot/api/action', {
    action: 'deleteProject',
    payload: { projectId: 'pr_verify_probe_not_exist', confirm: 'DELETE' },
  })
  const code = out.json && out.json.code
  const isUnknown = typeof (out.json && out.json.error) === 'string' && out.json.error.indexOf('未知动作') !== -1
  const ok = !isUnknown && (out.status === 404 || code === 'NOT_FOUND')
  record('新宿主：deleteProject 动作已注册', ok, 'HTTP ' + out.status + ' code=' + String(code))
  if (isUnknown) console.log('      → 当前运行的是旧宿主：请退出 DSH NEXT 再打开，然后重新运行本命令')
} catch (error) {
  record('新宿主：deleteProject 动作已注册', false, error.message)
}

try {
  const out = await getJson('/flowpilot/api/sync/status')
  record('只读路由可用（/flowpilot/api/sync/status）', out.status === 200 && out.json && out.json.ok === true, 'HTTP ' + out.status)
} catch (error) {
  record('只读路由可用（/flowpilot/api/sync/status）', false, error.message)
}

/* 冲突审阅接口：只读，安全 */
try {
  const out = await getJson('/flowpilot/api/sync/conflicts')
  const json = out.json || {}
  const okShape = out.status === 200 && json.ok === true && typeof json.count === 'number' && Array.isArray(json.conflicts)
  record('新宿主：冲突审阅接口可用（GET /sync/conflicts）', okShape,
    'HTTP ' + out.status + ' count=' + String(json.count))
} catch (error) {
  record('新宿主：冲突审阅接口可用（GET /sync/conflicts）', false, error.message)
}

record(
  '新宿主：节点模型 v2 已就绪（settings.evidencePolicy + unlockPolicy）',
  state !== null && state.settings
    && state.settings.evidencePolicy !== null && typeof state.settings.evidencePolicy === 'object'
    && Array.isArray(state.settings.evidencePolicy.kinds)
    && (state.settings.unlockPolicy === 'linear' || state.settings.unlockPolicy === 'parallel'),
  state === null ? '无数据' : 'evidencePolicy=' + JSON.stringify(state.settings?.evidencePolicy) + ' unlockPolicy=' + String(state.settings?.unlockPolicy),
)

record(
  '新宿主：settings.syncIntervalMinutes 已存在（1~60，默认 5）',
  state !== null && state.settings && Number.isInteger(state.settings.syncIntervalMinutes)
    && state.settings.syncIntervalMinutes >= 1 && state.settings.syncIntervalMinutes <= 60,
  state === null ? '无数据' : 'syncIntervalMinutes=' + String(state.settings?.syncIntervalMinutes),
)

/* 本地开发版：本地源码直连安装应被识别为 dev 并抑制更新提示 */
try {
  const out = await getJson('/flowpilot/api/update/status')
  const st = out.json && out.json.status ? out.json.status : (out.json || {})
  const dev = st.devBuild === true && st.channel === 'dev' && st.updateAvailable === false && st.updateSuppressed === true
  record('本地开发版：更新提示已抑制（devBuild=true / updateAvailable=false）', out.status === 200 && dev,
    'HTTP ' + out.status + ' devBuild=' + String(st.devBuild) + ' channel=' + String(st.channel) + ' updateAvailable=' + String(st.updateAvailable))
} catch (error) {
  record('本地开发版：更新提示已抑制', false, error.message)
}

/* 构建身份：/update/status 应暴露 buildLabel（版本+sha+dirty），用于排障时确认跑的是哪一版 */
try {
  const out = await getJson('/flowpilot/api/update/status')
  const st = out.json && out.json.status ? out.json.status : (out.json || {})
  const ok = typeof st.buildLabel === 'string' && st.buildLabel !== '' && st.build !== null && typeof st.build === 'object'
  record('构建身份可见（buildLabel / build.sha，区分本地改动）', out.status === 200 && ok,
    'buildLabel=' + String(st.buildLabel) + ' sha=' + String(st.build && st.build.sha) + ' dirty=' + String(st.build && st.build.dirty))
} catch (error) {
  record('构建身份可见（buildLabel / build.sha）', false, error.message)
}

/* appendTemplate：用空 payload 探测动作是否注册（新宿主返回 INVALID_INPUT，旧宿主返回「未知动作」） */
try {
  const out = await postJson('/flowpilot/api/action', { action: 'appendTemplate', payload: {} })
  const json = out.json || {}
  const unknown = typeof json.error === 'string' && json.error.indexOf('未知动作') !== -1
  const plannedAtReady = state !== null && Array.isArray(state.nodes)
    ? state.nodes.every((node) => Object.prototype.hasOwnProperty.call(node || {}, 'plannedAt'))
    : false
  record('新宿主：appendTemplate（追加节点模板）已注册且节点带 plannedAt',
    !unknown && out.status === 400 && json.code === 'INVALID_INPUT' && plannedAtReady,
    'HTTP ' + out.status + ' code=' + String(json.code) + ' plannedAtReady=' + String(plannedAtReady))
} catch (error) {
  record('新宿主：appendTemplate（追加节点模板）已注册且节点带 plannedAt', false, error.message)
}

/* dryRun：完整算一遍合并但不写本地/远端/备份，可安全地验证三方合并是否已上线 */
try {
  const out = await postJson('/flowpilot/api/sync/run', { mode: 'merge', dryRun: true })
  const json = out.json || {}
  const legacy = json.code === 'NOT_FOUND' || out.status === 404
  const merged = out.status === 200 && json.ok === true && json.result && json.result.mode === 'merge'
    && json.result.merged !== null && typeof json.result.merged === 'object'
  // 只有「确实没配云通道」才算通过（INVALID_INPUT 说明宿主还不认识 merge 模式，按失败处理）
  const notConfigured = out.status === 400 && json.code === 'SYNC_NOT_CONFIGURED'
  record('新宿主：/sync/run 支持三方合并（dryRun 验证 merge 结果结构）', !legacy && (merged || notConfigured),
    'HTTP ' + out.status + ' code=' + String(json.code) + ' error=' + String(json.error || '').slice(0, 60)
      + ' mode=' + String(json.result && json.result.mode))
} catch (error) {
  record('新宿主：/sync/run 支持三方合并（dryRun）', false, error.message)
}

if (EXERCISE_AUTOSYNC) {
  console.log('\n· 实测「写后自动同步」：发一个无副作用写入，等 4s 看 lastSyncedAt 是否前进')
  try {
    const before = await getJson('/flowpilot/api/sync/status')
    const beforeAt = before.json?.status?.lastSyncedAt ?? null
    await postJson('/flowpilot/api/action', { action: 'updateSettings', payload: { patch: {} } })
    await new Promise((resolve) => setTimeout(resolve, 5000))
    const after = await getJson('/flowpilot/api/sync/status')
    const afterAt = after.json?.status?.lastSyncedAt ?? null
    const changed = afterAt !== null && afterAt !== beforeAt
    record('写后自动同步：写入后 lastSyncedAt 前进', changed, 'before=' + String(beforeAt) + ' after=' + String(afterAt))
  } catch (error) {
    record('写后自动同步', false, error.message)
  }
}

const failed = results.filter((item) => !item.ok)
console.log(`\n${results.length - failed.length}/${results.length} 通过`)
if (failed.length > 0) {
  console.log('\n未通过项说明：')
  if (failed.some((item) => item.name.indexOf('deleteProject') !== -1 || item.name.indexOf('inheritDesignLink') !== -1 || item.name.indexOf('syncIntervalMinutes') !== -1 || item.name.indexOf('自动同步') !== -1)) {
    console.log('  · 宿主代码已更新但未加载：退出 DSH NEXT 后重新打开（刷新页面不够，热重载会被 module-comparison 拒绝）。')
  } else {
    console.log('  · 检查 FlowPilot 插件是否启用、GUI 端口是否正确（--port=）。')
  }
  process.exitCode = 1
} else {
  console.log('实机自检通过：新版宿主已生效 ✓')
}
