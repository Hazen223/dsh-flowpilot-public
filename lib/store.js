/**
 * FlowPilot 宿主半 · 本地数据存储
 *
 * 归属：host-core
 * 用途：
 * - `~/.dsh/flowpilot/data.json`（可用 config.dataDir / config.dataFile 覆盖）的读写；
 * - 首次写入自建目录；写入原子（同目录 tmp 文件 + fsync + rename）；
 * - 文件损坏时**报错而不是静默清空**，绝不覆盖历史数据；
 * - `revision` 每次写入 +1；导出 / 导入备份；重置。
 * 约束：只 import `node:` 内置模块。
 */

import {
  closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync,
  unlinkSync, writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

import { FpError, clone, fail, isPlainObject, isoOf } from './util.js'

/** 数据格式版本（契约 §2.1 formatVersion）。 */
export const FORMAT_VERSION = 1

/** 默认工作时段（PRD §6.1 / 契约 §2.1）。 */
export function defaultWorkSlots() {
  return [
    { key: 'morning', label: '启动与预热', start: '11:00', end: '12:00' },
    { key: 'afternoon', label: '主要工作输出', start: '14:00', end: '18:00' },
    { key: 'evening', label: '持续交付与收尾', start: '19:00', end: '21:00' },
  ]
}

/** 默认设置。`dataFile` 是只读展示字段，由 store 在加载时回填真实路径。 */
export function defaultSettings(dataFile = '') {
  return {
    workSlots: defaultWorkSlots(),
    silentWindows: [['12:00', '14:00'], ['18:00', '19:00']],
    handoffTime: '20:45',
    weeklyDraftTime: '12:05',
    weeklyMeetingTime: '17:00',
    weekStartsOn: 1,
    workdays: [1, 2, 3, 4, 5],
    dataFile,
    // 契约 §4.2 B：设计稿链接完成/跳过时是否继承到后继节点（默认开）。
    inheritDesignLink: true,
    // 周报里的「参与人」署名（例如：硫磺皂(liuhuaize)），空串 = 不写。
    reportOwner: '',
    // 契约外的宿主内部字段：节奏提示 dismiss 记录（client 不需要读）。
    dismissedRhythms: {},
  }
}

/** 空状态。 */
export function createEmptyState(dataFile = '') {
  return {
    formatVersion: FORMAT_VERSION,
    settings: defaultSettings(dataFile),
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
}

/** 备份里必须存在的集合字段。 */
const COLLECTIONS = ['businessLines', 'projects', 'flows', 'nodes', 'dependencies', 'links', 'events', 'handoffs', 'reports']

/**
 * 把任意来源的状态补齐成契约形状（用于旧数据迁移 / 导入备份）。
 * 只补缺省值、不猜业务数据；坏到无法识别时抛 INTERNAL。
 */
export function normalizeState(raw, { dataFile = '' } = {}) {
  if (!isPlainObject(raw)) fail('INTERNAL', '数据文件结构无法识别：根节点不是对象')
  const version = raw.formatVersion === undefined ? FORMAT_VERSION : Number(raw.formatVersion)
  if (!Number.isFinite(version) || version < 1) fail('INTERNAL', '数据文件 formatVersion 非法')
  if (version > FORMAT_VERSION) {
    fail('INTERNAL', `数据文件版本（v${version}）高于插件支持的版本（v${FORMAT_VERSION}），请升级插件或使用旧备份`)
  }
  const state = createEmptyState(dataFile)
  state.formatVersion = FORMAT_VERSION
  if (isPlainObject(raw.settings)) {
    const settings = { ...defaultSettings(dataFile), ...clone(raw.settings), dataFile }
    // 关键字段兜底，避免坏设置让派生视图崩溃
    if (!Array.isArray(settings.workSlots) || settings.workSlots.length === 0) settings.workSlots = defaultWorkSlots()
    if (!Array.isArray(settings.silentWindows)) settings.silentWindows = defaultSettings(dataFile).silentWindows
    if (!Array.isArray(settings.workdays) || settings.workdays.length === 0) settings.workdays = [1, 2, 3, 4, 5]
    if (!Number.isInteger(settings.weekStartsOn) || settings.weekStartsOn < 1 || settings.weekStartsOn > 7) settings.weekStartsOn = 1
    if (!isPlainObject(settings.dismissedRhythms)) settings.dismissedRhythms = {}
    state.settings = settings
  }
  for (const key of COLLECTIONS) {
    if (Array.isArray(raw[key])) state[key] = clone(raw[key])
  }
  return state
}

/** 展开 `~` 并转绝对路径。 */
export function expandPath(input) {
  const text = String(input ?? '').trim()
  if (text === '') return ''
  if (text === '~') return homedir()
  if (text.startsWith('~/') || text.startsWith('~\\')) return join(homedir(), text.slice(2))
  return resolve(text)
}

/** 默认数据目录：`~/.dsh/flowpilot`。 */
export function defaultDataDir() {
  return join(homedir(), '.dsh', 'flowpilot')
}

/** 解析 config 里的数据位置（dataFile 优先，其次 dataDir，最后默认目录）。 */
export function resolveDataPaths(config = {}) {
  const rawFile = expandPath(config?.dataFile)
  if (rawFile !== '') return { dataFile: rawFile, dataDir: dirname(rawFile) }
  const rawDir = expandPath(config?.dataDir)
  const dataDir = rawDir !== '' ? rawDir : defaultDataDir()
  return { dataFile: join(dataDir, 'data.json'), dataDir }
}

/** 读文件：不存在返回 null；其它 IO 错误转 INTERNAL。 */
function readTextIfExists(filePath) {
  try {
    return readFileSync(filePath, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return null
    fail('INTERNAL', `读取数据文件失败：${filePath}（${error?.message ?? error}）`)
  }
}

/**
 * 创建 store（同步 API，dispatch 全程同步 → 天然串行，不会被并发请求交错）。
 * @param {{ dataDir?: string, dataFile?: string, now?: () => Date, logger?: any }} options
 */
export function createStore(options = {}) {
  const paths = resolveDataPaths(options)
  const dataFile = paths.dataFile
  const dataDir = paths.dataDir
  const now = typeof options.now === 'function' ? options.now : () => new Date()
  const logger = options.logger

  /** @type {{ state: any, revision: number } | null} */
  let cache = null

  function fsyncWriteAtomic(payload) {
    mkdirSync(dataDir, { recursive: true })
    const tmp = `${dataFile}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`
    const body = JSON.stringify(payload, null, 2)
    let fd = null
    try {
      fd = openSync(tmp, 'w')
      writeFileSync(fd, body, 'utf8')
      fsyncSync(fd)
      closeSync(fd)
      fd = null
      renameSync(tmp, dataFile)
    } catch (error) {
      if (fd !== null) { try { closeSync(fd) } catch { /* 忽略 */ } }
      try { if (existsSync(tmp)) unlinkSync(tmp) } catch { /* 忽略 */ }
      fail('INTERNAL', `保存数据文件失败：${dataFile}（${error?.message ?? error}）`)
    }
  }

  function load() {
    if (cache) return cache
    const text = readTextIfExists(dataFile)
    if (text === null) {
      cache = { state: createEmptyState(dataFile), revision: 0 }
      return cache
    }
    let parsed
    try {
      parsed = JSON.parse(text)
    } catch (error) {
      fail(
        'INTERNAL',
        `数据文件不是合法 JSON：${dataFile}（${error?.message ?? error}）。` +
        '为避免覆盖历史数据，本次没有做任何写入；请修复文件后重试，或从备份导入。',
      )
    }
    // 兼容两种形态：{formatVersion, revision, state} 包装；或直接是 state 对象（早期实现/手工备份）。
    let rawState
    let revision = 0
    if (isPlainObject(parsed) && isPlainObject(parsed.state)) {
      rawState = parsed.state
      const parsedRevision = Number(parsed.revision)
      revision = Number.isInteger(parsedRevision) && parsedRevision >= 0 ? parsedRevision : 0
    } else if (isPlainObject(parsed) && COLLECTIONS.some((key) => Array.isArray(parsed[key]))) {
      rawState = parsed
    } else {
      fail('INTERNAL', `数据文件结构无法识别：${dataFile}。为避免覆盖历史数据，本次没有做任何写入；请修复或从备份导入。`)
    }
    cache = { state: normalizeState(rawState, { dataFile }), revision }
    return cache
  }

  function save(state, revision) {
    const payload = {
      formatVersion: FORMAT_VERSION,
      revision,
      savedAt: isoOf(now()),
      state: normalizeState(state, { dataFile }),
    }
    fsyncWriteAtomic(payload)
    cache = { state: clone(payload.state), revision }
    return cache
  }

  return {
    get dataDir() { return dataDir },
    get dataFile() { return dataFile },

    /** 读取缓存（首次读盘；坏文件抛 INTERNAL，绝不静默清空）。 */
    load,

    /** 当前快照（只读，不要直接改）。 */
    snapshot() {
      const { state, revision } = load()
      return { state, revision }
    },

    /** 整体覆盖保存（revision 由调用方决定；内部会克隆缓存）。 */
    save,
    /** 兼容别名。 */
    write: save,

    /** 导出备份（契约 §4 GET /export 的 body 形状）。 */
    exportPayload() {
      const { state, revision } = load()
      return {
        formatVersion: FORMAT_VERSION,
        app: 'flowpilot',
        kind: 'backup',
        exportedAt: isoOf(now()),
        revision,
        state: clone(state),
      }
    },

    /** 整体替换（契约 §4 POST /import）。返回新的 revision。 */
    importPayload(payload) {
      const incoming = isPlainObject(payload) && isPlainObject(payload.state) ? payload.state : payload
      if (!isPlainObject(incoming)) fail('INVALID_INPUT', '导入内容必须是 FlowPilot 备份 JSON（或 state 对象）')
      const nextState = normalizeState(incoming, { dataFile })
      const current = load()
      const incomingRevision = Number(payload?.revision)
      const base = Math.max(current.revision, Number.isInteger(incomingRevision) && incomingRevision >= 0 ? incomingRevision : 0)
      return save(nextState, base + 1)
    },

    /** 重置为空数据（保留设置）。 */
    reset() {
      const current = load()
      const settings = clone(current.state.settings ?? defaultSettings(dataFile))
      const empty = createEmptyState(dataFile)
      empty.settings = { ...defaultSettings(dataFile), ...settings, dataFile }
      return save(empty, current.revision + 1)
    },

    /** 数据文件是否存在（只用于展示/自检）。 */
    exists() {
      return existsSync(dataFile)
    },

    logger,
  }
}
