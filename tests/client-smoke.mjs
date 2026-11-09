/**
 * Offline client smoke test.
 *
 * 目的：在没有浏览器控制的情况下，尽可能真实地把 client.js 跑起来——
 *   1) 用 vm 沙箱 + 假 window/document 执行生成的 client.js；
 *   2) 用最小 React 替身执行 factory，拿到真正的槽位组件；
 *   3) 用「渲染树走查」递归调用每个组件（hooks 用替身），
 *      在 loading / 真实 fixture / 空数据三种状态下渲染全部面板；
 *   4) 再遍历渲染结果里的 onClick 处理器并调用它们（fetch 被打桩），
 *      捕获事件处理路径上的崩溃。
 *
 * 它不能替代视觉验收（没有截图能力），但能可靠地抓出：未定义标识符、
 * 跨文件拼装错误、props 形状不符、事件处理器崩溃。
 */
import { readFile, stat } from 'node:fs/promises'
import { readFileSync, existsSync } from 'node:fs'
import { createContext, runInContext } from 'node:vm'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const failures = []
const notes = []

function fail(message) {
  failures.push(message)
}

/* ------------------------------ 假 React ------------------------------ */
function makeReact() {
  const Fragment = Symbol.for('react.fragment')
  const React = { Fragment, version: '18.3.0-stub' }
  React.createElement = (type, props, ...children) => {
    const nextProps = Object.assign({}, props)
    if (children.length === 1) nextProps.children = children[0]
    else if (children.length > 1) nextProps.children = children
    return { type, props: nextProps, key: nextProps.key }
  }
  React.cloneElement = (element, extra) => ({ type: element.type, props: Object.assign({}, element.props, extra), key: element.key })
  React.useState = (init) => [typeof init === 'function' ? init() : init, () => {}]
  React.useEffect = () => {}
  React.useLayoutEffect = () => {}
  React.useRef = (init) => ({ current: init === undefined ? null : init })
  React.useMemo = (fn) => fn()
  React.useCallback = (fn) => fn
  React.useReducer = (reducer, init, initializer) => [typeof initializer === 'function' ? initializer(init) : init, () => {}]
  React.useSyncExternalStore = (subscribe, getSnapshot) => getSnapshot()
  React.useId = () => 'fp-test'
  React.Children = {
    toArray: (children) => (children == null ? [] : Array.isArray(children) ? children.flat(Infinity) : [children]),
    map: (children, fn) => React.Children.toArray(children).map(fn),
    forEach: (children, fn) => React.Children.toArray(children).forEach(fn),
    only: (children) => children,
    count: (children) => React.Children.toArray(children).length,
  }
  React.Fragment = Fragment
  React.StrictMode = Fragment
  return React
}

/* ------------------------------ 假 DOM ------------------------------ */
function fakeNode(tag) {
  const node = {
    tagName: String(tag || 'div').toUpperCase(),
    nodeType: 1,
    style: {},
    dataset: {},
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    childNodes: [],
    children: [],
    attributes: {},
    appendChild(child) { this.childNodes.push(child); this.children.push(child); return child },
    insertBefore(child) { this.childNodes.push(child); return child },
    removeChild(child) { return child },
    remove() {},
    setAttribute(name, value) { this.attributes[name] = String(value) },
    getAttribute(name) { return this.attributes[name] ?? null },
    removeAttribute(name) { delete this.attributes[name] },
    addEventListener() {},
    removeEventListener() {},
    querySelector() { return null },
    querySelectorAll() { return [] },
    contains() { return false },
    focus() {},
    blur() {},
    click() {},
    select() {},
    scrollIntoView() {},
    getBoundingClientRect() { return { top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0 } },
    get firstChild() { return this.childNodes[0] || null },
  }
  return node
}

function makeDocument() {
  const head = fakeNode('head')
  const body = fakeNode('body')
  const documentElement = fakeNode('html')
  return {
    head,
    body,
    documentElement,
    visibilityState: 'visible',
    activeElement: null,
    createElement: (tag) => fakeNode(tag),
    createTextNode: (text) => ({ nodeType: 3, textContent: String(text) }),
    createDocumentFragment: () => fakeNode('fragment'),
    querySelector: () => null,
    querySelectorAll: () => [],
    getElementById: () => null,
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent: () => true,
  }
}

/* ------------------------------ 加载 client.js ------------------------------ */
async function loadClient() {
  const file = join(root, 'client.js')
  if (!existsSync(file)) throw new Error('client.js 不存在：先运行 node build-client.mjs')
  const code = await readFile(file, 'utf8')
  const { size } = await stat(file)
  notes.push('client.js ' + (size / 1024).toFixed(1) + ' KiB')

  const document = makeDocument()
  const windowObject = {
    document,
    addEventListener() {},
    removeEventListener() {},
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    requestAnimationFrame: (fn) => { if (typeof fn === 'function') fn(0); return 0 },
    cancelAnimationFrame() {},
    getComputedStyle: () => ({ getPropertyValue: () => '' }),
    innerWidth: 1440,
    innerHeight: 900,
    devicePixelRatio: 2,
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
  }
  const loads = []
  windowObject.__ModuleLoader__ = { load: (spec) => loads.push(spec) }

  const navigatorObject = { clipboard: { writeText: async () => {} }, userAgent: 'node-smoke' }

  const fetchCalls = []
  let respondWith = null
  const fetchStub = async (url, options) => {
    fetchCalls.push({ url: String(url), options: options || {} })
    const payload = typeof respondWith === 'function' ? respondWith(url, options) : { ok: true, revision: 1 }
    return {
      ok: true,
      status: 200,
      async json() { return payload },
      async text() { return JSON.stringify(payload) },
    }
  }

  const sandbox = {
    window: windowObject,
    document,
    navigator: navigatorObject,
    fetch: fetchStub,
    console: { log() {}, warn() {}, error() {}, info() {}, debug() {} },
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    queueMicrotask,
    URL,
    Blob,
    AbortController,
    AbortSignal,
    TextEncoder,
    TextDecoder,
    performance,
    structuredClone,
    Node: class Node {},
    requestAnimationFrame: windowObject.requestAnimationFrame,
    cancelAnimationFrame: windowObject.cancelAnimationFrame,
  }
  const context = createContext(sandbox)
  runInContext(code, context, { filename: 'client.js' })

  if (loads.length !== 1) throw new Error('期望 __ModuleLoader__.load 被调用一次，实际 ' + loads.length + ' 次')
  const spec = loads[0]
  if (typeof spec.id !== 'string' || spec.id === '') throw new Error('模块缺少 id')
  notes.push('module id = ' + spec.id)
  const React = makeReact()
  const requireStub = (name) => {
    if (name === 'react') return React
    throw new Error('client 不允许 require 其它模块：' + name)
  }
  const mod = spec.factory(requireStub)
  if (!mod || typeof mod.apply !== 'function') throw new Error('factory 未返回 apply')
  notes.push('inject = ' + JSON.stringify(mod.inject))
  return { mod, React, fetchStub, setResponder: (fn) => { respondWith = fn }, fetchCalls, sandbox, context }
}

/* ------------------------------ 渲染树走查 ------------------------------ */
function renderPass(React, element, label, clickCollector) {
  const stats = { components: 0, hosts: 0, clicks: 0 }
  const seen = new Set()

  function walk(node, path, depth) {
    if (node === null || node === undefined || node === false || node === true) return
    if (depth > 80) throw new Error(path + ': 渲染超过 80 层，疑似无限递归')
    if (Array.isArray(node)) {
      node.forEach((child, index) => walk(child, path + '[' + index + ']', depth + 1))
      return
    }
    if (typeof node === 'string' || typeof node === 'number') return
    if (typeof node !== 'object') return
    const { type } = node
    const props = node.props || {}
    if (typeof type === 'function') {
      const name = type.name || 'Anonymous'
      stats.components += 1
      let out
      try {
        out = type(props)
      } catch (error) {
        throw new Error(path + ' > <' + name + '> 渲染抛错：' + (error && error.stack ? error.stack.split('\n').slice(0, 4).join(' | ') : error))
      }
      walk(out, path + '>' + name, depth + 1)
      return
    }
    if (typeof type === 'symbol') {
      walk(props.children, path + '#fragment', depth + 1)
      return
    }
    if (typeof type === 'string') {
      stats.hosts += 1
      if (typeof props.onClick === 'function' && clickCollector) {
        stats.clicks += 1
        clickCollector.push({ path: path + '/' + type, handler: props.onClick, label })
      }
      walk(props.children, path + '/' + type, depth + 1)
      return
    }
    // 未知类型（例如被当作组件的对象）——记录但不中断
    fail(label + ': 出现不可渲染的节点类型 ' + String(type))
  }

  walk(element, label, 0)
  return stats
}

function collectTexts(node, out, depth) {
  if (depth > 80 || node === null || node === undefined) return
  if (typeof node === 'string') { if (node.trim() !== '') out.push(node); return }
  if (typeof node === 'number') return
  if (Array.isArray(node)) { node.forEach((child) => collectTexts(child, out, depth + 1)); return }
  if (typeof node !== 'object') return
  const type = node.type
  const props = node.props || {}
  if (typeof type === 'function') {
    let produced = null
    try { produced = type(props) } catch (error) { return }
    collectTexts(produced, out, depth + 1)
    return
  }
  if (typeof type === 'symbol') { collectTexts(props.children, out, depth + 1); return }
  collectTexts(props.children, out, depth + 1)
}

function collectClassNames(node, out, depth) {
  if (depth > 80 || node === null || node === undefined) return
  if (typeof node !== 'object' || Array.isArray(node)) {
    if (Array.isArray(node)) node.forEach((child) => collectClassNames(child, out, depth + 1))
    return
  }
  const type = node.type
  const props = node.props || {}
  if (typeof props.className === 'string') out.push(props.className)
  if (typeof type === 'function') {
    let produced = null
    try { produced = type(props) } catch (error) { return }
    collectClassNames(produced, out, depth + 1)
    return
  }
  collectClassNames(props.children, out, depth + 1)
}

const fakeEvent = () => ({
  preventDefault() {}, stopPropagation() {}, persist() {},
  key: 'Enter', code: 'Enter', which: 13,
  target: { value: '', checked: false, dataset: {} },
  currentTarget: { value: '', checked: false, dataset: {} },
  nativeEvent: { isComposing: false },
  clientX: 0, clientY: 0,
  button: 0,
})

async function flush() {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

/* ------------------------------ 主流程 ------------------------------ */
async function main() {
  const { mod, React, fetchStub, setResponder, fetchCalls } = await loadClient()

  const registrations = []
  const applies = []
  const fakeCtx = {
    slots: {
      inject: (key, callback) => {
        applies.push(key)
        const dispose = callback()
        return typeof dispose === 'function' ? dispose : () => {}
      },
      register: (options, component) => {
        registrations.push({ options, component })
        return () => {}
      },
    },
    layout: { selectPanel() {}, toggleSidebar() {}, openRightbar() {}, closeRightbar() {} },
    locale: {
      register: () => () => {},
      bind: () => (key) => key,
      getLocale: () => ({ id: 'zh' }),
    },
    effect: (setup) => {
      const dispose = typeof setup === 'function' ? setup() : setup
      return () => { if (typeof dispose === 'function') dispose() }
    },
    get: () => null,
    logger: { info() {}, warn() {}, error() {} },
  }

  try {
    mod.apply(fakeCtx)
  } catch (error) {
    fail('apply() 抛错：' + (error && error.stack ? error.stack.split('\n').slice(0, 5).join(' | ') : error))
  }

  const expectedSlots = ['main', 'sidebar.panellist', 'conversation.session.header.utilities', 'settings.section']
  for (const slot of expectedSlots) {
    if (!applies.includes(slot) && !registrations.some((entry) => entry.options.name === slot)) {
      fail('未注册槽位：' + slot)
    }
  }
  if (registrations.length < expectedSlots.length) {
    fail('槽位注册数量不足：' + registrations.length + ' < ' + expectedSlots.length)
  }
  notes.push('槽位注册：' + registrations.map((entry) => (entry.options.key || entry.options.id) + '@' + entry.options.name).join(', '))

  const byName = new Map()
  for (const entry of registrations) {
    if (typeof entry.component !== 'function') {
      fail('槽位 ' + entry.options.name + ' 的组件不是函数')
      continue
    }
    byName.set(entry.options.name + ':' + (entry.options.key || entry.options.id), entry)
  }

  /* -------- fixture -------- */
  let fixture = null
  const fixturePath = join(root, 'tests', 'fixture.json')
  if (existsSync(fixturePath)) {
    fixture = JSON.parse(await readFile(fixturePath, 'utf8'))
    notes.push('fixture: ' + (fixture.state.projects || []).length + ' 项目 / ' + (fixture.state.nodes || []).length + ' 节点')
  } else {
    notes.push('未找到 tests/fixture.json —— 只跑 loading 与空数据场景')
  }

  const grab = (name) => {
    for (const [key, entry] of byName) {
      if (entry.options.name === name) return entry
    }
    return null
  }

  const renderRegistrations = (labelPrefix) => {
    const clicks = []
    let total = { components: 0, hosts: 0, clicks: 0 }
    for (const [key, entry] of byName) {
      const stats = renderPass(React, React.createElement(entry.component, {}), labelPrefix + ':' + key, clicks)
      total = { components: total.components + stats.components, hosts: total.hosts + stats.hosts, clicks: total.clicks + stats.clicks }
    }
    return { total, clicks }
  }

  /* 1) loading 场景（store 未 seed） */
  try {
    const { total } = renderRegistrations('loading')
    notes.push('loading 场景渲染：' + total.components + ' 组件 / ' + total.hosts + ' 元素')
  } catch (error) {
    fail('loading 场景：' + error.message)
  }

  /* 2) 真实数据场景 */
  const seed = (payload) => {
    if (!mod.__test || typeof mod.__test.seed !== 'function') {
      fail('client 未导出 __test 入口，无法注入 fixture')
      return false
    }
    mod.__test.seed(payload)
    return true
  }

  if (fixture) {
    setResponder(() => Object.assign({ ok: true, revision: 7 }, fixture))
    seed({ revision: 7, state: fixture.state, derived: fixture.derived })
    try {
      const { total, clicks } = renderRegistrations('ready')
      notes.push('ready 场景渲染：' + total.components + ' 组件 / ' + total.hosts + ' 元素 / ' + clicks.length + ' 个可点击元素')
      await clickThrough(clicks)
    } catch (error) {
      fail('ready 场景：' + error.message)
    }
  }

  /* 3) 空数据场景 */
  if (fixture) {
    const emptyState = {
      formatVersion: 1,
      settings: fixture.state.settings,
      businessLines: [],
      projects: [],
      flows: [],
      nodes: [],
      dependencies: [],
      links: [],
      events: [],
      handoffs: [],
      reports: [],
    }
    const emptyDerived = {
      now: new Date().toISOString(),
      today: new Date().toISOString().slice(0, 10),
      counts: { actionable: 0, waiting: 0, blocked: 0, revision: 0, overdue: 0, activeProjects: 0, completedThisWeek: 0 },
      focus: { period: 'afternoon', label: '主要工作输出', silent: false, inWorkHours: true, prompt: null },
      today: { recommended: [], followUps: [], upcoming: [], handoffContext: null },
      weekly: { weekStart: '2026-11-02', weekEnd: '2026-11-06', reportId: null, exists: false, shouldGenerate: false, nextGenerateAt: null },
      projects: {},
    }
    seed({ revision: 8, state: emptyState, derived: emptyDerived })
    try {
      const { total, clicks } = renderRegistrations('empty')
      notes.push('empty 场景渲染：' + total.components + ' 组件 / ' + total.hosts + ' 元素')
      await clickThrough(clicks)
    } catch (error) {
      fail('empty 场景：' + error.message)
    }
  }

  /* 4) 逐节点详情 / 弹窗变体 */
  if (fixture) {
    const components = (mod.__test && mod.__test.components) || {}
    const nodeDetail = components.NodeDetail || null
    if (!nodeDetail) {
      fail('未找到 NodeDetail 组件（40-flow.js 必须导出 function NodeDetail）')
    } else {
      const clicks = []
      for (const node of fixture.state.nodes || []) {
        const project = (fixture.state.projects || []).find((item) => item.id === node.projectId)
        try {
          renderPass(React, React.createElement(nodeDetail, {
            state: fixture.state,
            derived: fixture.derived,
            project,
            node,
            onClose: () => {},
          }), 'node-detail:' + node.code, clicks)
        } catch (error) {
          fail('NodeDetail(' + node.code + '/' + node.status + ')：' + error.message)
        }
      }
      notes.push('NodeDetail 渲染了 ' + (fixture.state.nodes || []).length + ' 个状态变体')
      await clickThrough(clicks)
    }

    const dialogNames = ['ProjectCreateDialog', 'LineEditDialog', 'LinkDialog', 'ScheduleDialog', 'ReasonDialog', 'NodeAddDialog', 'AiPrdDialog']
    for (const name of dialogNames) {
      const component = components[name] || null
      if (!component) {
        fail('未找到弹窗组件：' + name + '（50-views.js 必须导出）')
        continue
      }
      const node = (fixture.state.nodes || []).find((item) => item.status === 'ready') || (fixture.state.nodes || [])[0] || null
      const project = node ? (fixture.state.projects || []).find((item) => item.id === node.projectId) : (fixture.state.projects || [])[0]
      const flow = project ? (fixture.state.flows || []).find((item) => item.projectId === project.id) : null
      const props = {
        open: true,
        state: fixture.state,
        derived: fixture.derived,
        onClose: () => {},
        node,
        project,
        flow,
        line: fixture.state.businessLines[0],
        onApplied: () => {},
        onCreated: () => {},
        defaultLineId: fixture.state.businessLines[0] && fixture.state.businessLines[0].id,
        mode: name === 'ReasonDialog' ? 'block' : undefined,
      }
      const clicks = []
      try {
        renderPass(React, React.createElement(component, props), 'dialog:' + name, clicks)
      } catch (error) {
        fail(name + ' 渲染失败：' + error.message)
      }
      await clickThrough(clicks)
    }
  }

  /* 5) 内容断言：真实数据必须真的渲染出可见文本 */
  if (fixture) {
    const texts = []
    collectTexts(React.createElement(byName.get('main:flowpilot').component, {}), texts, 0)
    const joined = texts.join(' ')
    const mustHave = [
      ['FlowPilot', '品牌名'],
      ['流程', '视图分段'],
      ['今日', '视图分段'],
    ]
    for (const [needle, why] of mustHave) {
      if (joined.indexOf(needle) === -1) fail('ready 场景主面板缺少文本「' + needle + '」（' + why + '）')
    }

    // 流程画布单独断言：必须真的画出项目标题、节点标题与状态标签
    const components = mod.__test.components
    const firstProject = fixture.state.projects[0]
    const flowTexts = []
    renderPass(React, React.createElement(components.FlowView, {
      state: fixture.state,
      derived: fixture.derived,
      project: firstProject,
      selection: {},
      onSelectNode: () => {},
      onCollapseDetail: () => {},
      onCreateProject: () => {},
      onAddFlow: () => {},
    }, null), 'flow-view-text', [], flowTexts)
    // renderPass 的第四个参数是点击收集器；文本需要单独收集
    const canvasTexts = []
    collectTexts(React.createElement(components.FlowView, {
      state: fixture.state,
      derived: fixture.derived,
      project: firstProject,
      selection: {},
      onSelectNode: () => {},
      onCollapseDetail: () => {},
      onCreateProject: () => {},
      onAddFlow: () => {},
    }, null), canvasTexts, 0)
    const canvasJoined = canvasTexts.join(' ')
    if (canvasJoined.indexOf(firstProject.title) === -1) fail('流程画布没有渲染项目标题：' + firstProject.title)
    const statusWords = ['未解锁', '待开始', '进行中', '待确认', '已阻塞', '待修改', '已完成', '已跳过']
    const hit = statusWords.filter((word) => canvasJoined.indexOf(word) !== -1)
    if (hit.length < 3) fail('流程画布的状态标签不足（命中 ' + hit.length + '：' + hit.join('、') + '）')
    notes.push('流程画布文本 ' + canvasTexts.length + ' 段，状态标签命中：' + hit.join('、'))
    notes.push('主面板可见文本 ' + texts.length + ' 段，前 12 段：' + texts.slice(0, 12).join(' / '))
  }

  /* 6) 完成/跳过节点不再显示逾期（只保留计划日期） */
  if (fixture) {
    const components6 = mod.__test.components
    const now6 = new Date()
    const pastDue = new Date(now6.getTime() - 5 * 24 * 60 * 60 * 1000).toISOString()
    const flowId = fixture.state.flows && fixture.state.flows[0] ? fixture.state.flows[0].id : null
    const baseNode = {
      id: 'nd_overdue_check', code: 'X01', title: '需求接收与目标对齐', status: 'completed',
      assigneeRole: '设计', dueAt: pastDue, followUpAt: null, plannedAt: null, round: 1,
      approvals: {}, approvalRoles: [], flowId: flowId, projectId: fixture.state.projects[0].id, sortOrder: 0, notes: '',
    }
    const renderCard = (node) => {
      const element = React.createElement(components6.FlowNodeCard, {
        node: node, links: [], selected: false, now: now6, onClick: () => {}, current: false, returnCodes: [], reworkTarget: null,
      })
      const texts = []
      const classes = []
      collectTexts(element, texts, 0)
      collectClassNames(element, classes, 0)
      return { text: texts.join(' '), classes: classes }
    }
    const doneCard = renderCard(baseNode)
    if (doneCard.text.indexOf('逾期') !== -1) fail('已完成节点仍然显示逾期：' + doneCard.text.slice(0, 140))
    if (doneCard.classes.some((name) => name.indexOf('fp-is-overdue') !== -1)) fail('已完成节点仍使用逾期错误色')
    if (!/\d+月\d+日/.test(doneCard.text)) fail('已完成节点应保留计划日期（当前：' + doneCard.text.slice(0, 80) + '）')
    const skippedCard = renderCard(Object.assign({}, baseNode, { status: 'skipped' }))
    if (skippedCard.text.indexOf('逾期') !== -1) fail('已跳过节点仍然显示逾期：' + skippedCard.text.slice(0, 140))
    const liveCard = renderCard(Object.assign({}, baseNode, { status: 'active' }))
    if (liveCard.text.indexOf('逾期') === -1) fail('未完成节点的逾期提示不应被误删')
    if (!liveCard.classes.some((name) => name.indexOf('fp-is-overdue') !== -1)) fail('未完成节点的逾期错误色不应被误删')
    // 详情「计划与跟进」同样不应给已完成节点标逾期
    const detailState = JSON.parse(JSON.stringify(fixture.state))
    const doneNode = (detailState.nodes || []).find((node) => node.status === 'completed')
    if (doneNode) {
      doneNode.dueAt = pastDue
      const detailTexts = []
      collectTexts(React.createElement(components6.NodeDetail, {
        state: detailState,
        derived: fixture.derived,
        project: (detailState.projects || []).find((item) => item.id === doneNode.projectId),
        node: doneNode,
        onClose: () => {},
      }), detailTexts, 0)
      const detailJoined = detailTexts.join(' ')
      if (detailJoined.indexOf('计划完成') === -1) {
        notes.push('提示：节点详情的计划区未渲染，跳过「详情不显示逾期」断言')
      } else if (detailJoined.indexOf('逾期') !== -1) {
        fail('已完成节点详情仍显示逾期：' + detailJoined.slice(0, 160))
      }
    }
    notes.push('完成/跳过节点逾期显示回归：通过')
  }

  /* 7) 未知事件 kind 不得让时间线崩溃（宿主会做近似映射，未来可能新增） */
  if (fixture) {
    const unknownState = JSON.parse(JSON.stringify(fixture.state))
    const target = (unknownState.nodes || []).find((node) => node.status === 'active') || (unknownState.nodes || [])[0]
    if (target) {
      unknownState.events.push({
        id: 'ev_future', projectId: target.projectId, flowId: target.flowId, nodeId: target.id,
        kind: 'somethingNewInFuture', timestamp: new Date().toISOString(), details: '未来事件', round: 1,
      })
    }
    try {
      const nodeDetailComponent = mod.__test.components.NodeDetail
      renderPass(React, React.createElement(nodeDetailComponent, {
        state: unknownState,
        derived: fixture.derived,
        project: (unknownState.projects || []).find((item) => target && item.id === target.projectId),
        node: target,
        onClose: () => {},
      }), 'unknown-event-kind', [])
    } catch (error) {
      fail('未知事件 kind 让节点详情崩溃：' + error.message)
    }
  }

  /* 7) AI 对话框：提案态 / 解析态（seed props 仅在测试里传） */
  if (fixture) {
    const components = mod.__test.components
    const aiDialog = components.AiPrdDialog
    if (typeof aiDialog !== 'function') {
      fail('未找到 AiPrdDialog 组件（45-ai.js 必须导出 function AiPrdDialog）')
    } else {
      const baseProject = fixture.state.projects[0]
      const proposalFixture = {
        title: '（测试）AI 提案项目',
        businessLineName: baseProject ? fixture.state.businessLines[0].name : null,
        dueAt: null,
        templateId: 'custom',
        summary: '来自冒烟测试的提案',
        notes: 'notes',
        nodes: [
          { title: '需求接收', detail: '记录需求', assigneeRole: '设计', approvalRoles: [] },
          { title: '交互确认', detail: '双方确认', assigneeRole: '设计/产品', approvalRoles: ['design', 'product'] },
          { title: '研发交付', detail: '提交代码', assigneeRole: '研发', approvalRoles: [] },
        ],
      }
      const scenarios = [
        { label: 'proposal', props: { initialStage: 'proposal', initialProposal: proposalFixture, initialText: '一段足够长的 PRD 文本用于测试输入状态展示……', initialMeta: { source: 'llm', provider: 'deepseek-account', model: 'deepseek-flash', ms: 1200, truncated: false, warnings: [], usage: { inputTokens: 10, outputTokens: 20 } }, initialStatus: { ok: true, available: true, provider: 'deepseek-account', model: 'deepseek-flash', reason: null, modelSource: 'session-default' } } },
        { label: 'parsing', props: { initialStage: 'parsing', initialText: '一段足够长的 PRD 文本用于解析中状态……' } },
        { label: 'empty-proposal', props: { initialStage: 'proposal', initialProposal: { title: '', nodes: [] }, initialStatus: { available: false, reason: '没有可用模型' } } },
      ]
      for (const scenario of scenarios) {
        const clicks = []
        try {
          renderPass(React, React.createElement(aiDialog, Object.assign({
            open: true,
            onClose: () => {},
            onApplied: () => {},
            state: fixture.state,
            derived: fixture.derived,
          }, scenario.props)), 'dialog:AiPrdDialog:' + scenario.label, clicks)
        } catch (error) {
          fail('AiPrdDialog(' + scenario.label + ') 渲染失败：' + error.message)
        }
        try {
          await clickThrough(clicks)
        } catch (error) {
          fail('AiPrdDialog(' + scenario.label + ') 交互失败：' + error.message)
        }
      }
      notes.push('AI 对话框渲染了 ' + scenarios.length + ' 个状态变体')
    }
  }

  /* 8) 同步面板：无配置 / 有配置 / 冲突 / 错误 四态 */
  {
    const syncPanel = mod.__test && mod.__test.components ? mod.__test.components.FpSyncPanel : null
    if (typeof syncPanel !== 'function') {
      fail('未找到 FpSyncPanel 组件（55-sync.js 必须导出 function FpSyncPanel）')
    } else {
      const statusOk = {
        provider: 'github', providerLabel: 'GitHub 仓库', configured: true, credentialsSet: true,
        githubCredentialsSet: true, webdavCredentialsSet: false,
        config: {
          provider: 'github',
          github: { owner: 'someone', repo: 'flowpilot', branch: 'main', path: 'flowpilot/data.json', apiBase: 'https://api.github.com' },
          webdav: { url: '', username: '', fileName: 'data.json' },
          behavior: { autoPushAfterWrite: false, autoPullOnStart: true },
        },
        remoteTarget: 'someone/flowpilot@main:flowpilot/data.json',
        behavior: { autoPushAfterWrite: false, autoPullOnStart: true },
        localRevision: 7, localUpdatedAt: new Date().toISOString(),
        localCounts: { businessLines: 3, projects: 4, nodes: 33, events: 42 },
        lastSyncedAt: new Date().toISOString(), lastSyncedRevision: 6,
        hasPendingChanges: true, lastError: null, lastErrorAt: null,
        deviceId: 'dev_test', dataFile: '/tmp/x/data.json',
      }
      const scenarios = [
        { label: 'empty', props: {} },
        { label: 'configured', props: { initialStatus: statusOk } },
        { label: 'conflict', props: { initialStatus: statusOk, initialConflict: { local: { revision: 9, updatedAt: new Date().toISOString() }, remote: { revision: 12, updatedAt: new Date().toISOString() }, lastSyncedRevision: 6, options: ['push', 'pull'] } } },
        { label: 'error', props: { initialStatus: Object.assign({}, statusOk, { lastError: 'SYNC_AUTH_FAILED：token 无效' }), initialError: 'SYNC_AUTH_FAILED：token 无效' } },
      ]
      for (const scenario of scenarios) {
        const clicks = []
        try {
          renderPass(React, React.createElement(syncPanel, scenario.props), 'sync-panel:' + scenario.label, clicks)
        } catch (error) {
          fail('FpSyncPanel(' + scenario.label + ') 渲染失败：' + error.message)
        }
        try {
          await clickThrough(clicks)
        } catch (error) {
          fail('FpSyncPanel(' + scenario.label + ') 交互失败：' + error.message)
        }
      }
      notes.push('同步面板渲染了 ' + scenarios.length + ' 个状态变体')
    }
  }

  /* 9) 完成节点后的自动跳转助手 fpNextNode */
  {
    const utils = mod.__test && mod.__test.utils ? mod.__test.utils : null;
    if (!utils || typeof utils.fpNextNode !== 'function') {
      fail('client 未暴露 fpNextNode（自动跳转依赖它）');
    } else if (fixture) {
      const project = (fixture.state.projects || []).find((item) => item.title === '活动管理改版') || (fixture.state.projects || [])[0];
      const nodes = (fixture.state.nodes || [])
        .filter((node) => node.projectId === project.id)
        .sort((a, b) => Number(a.sortOrder) - Number(b.sortOrder));
      const completed = nodes.find((node) => node.status === 'completed');
      if (completed) {
        const next = utils.fpNextNode(fixture.state, completed);
        if (!next) fail('fpNextNode 应能找到「' + completed.code + '」的下一个节点');
        else if (next.id === completed.id) fail('fpNextNode 不应返回自身');
        else {
          const sameFlow = next.flowId === completed.flowId;
          const forward = sameFlow ? Number(next.sortOrder) > Number(completed.sortOrder) : true;
          if (!forward) fail('fpNextNode 返回了方向错误的节点：' + completed.code + ' → ' + next.code);
          notes.push('fpNextNode(' + completed.code + ') → ' + next.code + (sameFlow ? '' : '（跨流程）'));
        }
      }
      const last = nodes[nodes.length - 1];
      if (last) {
        const nextOfLast = utils.fpNextNode(fixture.state, last);
        notes.push('fpNextNode(' + last.code + ') → ' + (nextOfLast ? nextOfLast.code : 'null'));
      }
    }
  }

  /* -------- 结果 -------- */
  notes.push('离线 fetch 调用 ' + fetchCalls.length + ' 次')
  const failedFetches = fetchCalls.filter((call) => /undefined|null/.test(call.url))
  if (failedFetches.length > 0) fail('存在非法 fetch URL：' + failedFetches[0].url)

  console.log('\n--- notes ---')
  for (const note of notes) console.log('  · ' + note)
  if (failures.length > 0) {
    console.error('\n--- FAIL (' + failures.length + ') ---')
    for (const message of failures) console.error('  ✗ ' + message)
    process.exit(1)
  }
  console.log('\nclient smoke: OK')

  async function clickThrough(clicks) {
    const limit = Math.min(clicks.length, 40)
    for (let index = 0; index < limit; index += 1) {
      const { handler, path } = clicks[index]
      try {
        const outcome = handler(fakeEvent())
        if (outcome && typeof outcome.then === 'function') await outcome
        await flush()
      } catch (error) {
        fail('点击处理器抛错 ' + path + '：' + (error && error.message ? error.message : error))
      }
    }
  }
}

main().catch((error) => {
  console.error('client smoke 崩溃：', error)
  process.exit(1)
})
