/**
 * FlowPilot 宿主半 · 通用工具
 *
 * 归属：host-core
 * 用途：错误类型 / 错误码 / id / 时间与本地日期计算 / 入参校验。
 * 约束：只 import `node:` 内置模块；不依赖任何第三方包。
 */

/** 节点状态（顺序即语义，与契约 §6.1 的 FP_STATUS 顺序一致）。 */
export const STATUS_ORDER = Object.freeze([
  'locked', 'ready', 'active', 'waiting', 'blocked', 'revision', 'completed', 'skipped',
])

/** 契约 §4 错误码。 */
export const ERROR_CODES = Object.freeze([
  'NEED_APPROVALS', 'NEED_EVIDENCE', 'NEED_DESIGN_LINK', 'NOT_FOUND', 'INVALID_STATE', 'INVALID_INPUT', 'INTERNAL',
])

/** 宿主半的错误：带契约错误码，HTTP 层据此映射状态码。 */
export class FpError extends Error {
  /**
   * @param {string} code 契约错误码
   * @param {string} message 中文原因（直接给 UI / 模型看）
   */
  constructor(code, message) {
    super(message)
    this.name = 'FpError'
    this.code = ERROR_CODES.includes(code) ? code : 'INTERNAL'
  }
}

/** 抛一个带错误码的中文错误。 */
export function fail(code, message) {
  throw new FpError(code, message)
}

export function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 深拷贝（数据都是 JSON 结构，structuredClone 足够且不会丢 undefined）。 */
export function clone(value) {
  return structuredClone(value)
}

/** 生成带前缀的短 id，例如 nd_lq3f8x2k。 */
export function uid(prefix) {
  const stamp = Date.now().toString(36)
  const rand = Math.random().toString(36).slice(2, 8)
  return `${prefix}_${stamp}${rand}`
}

/** 数字钳制。 */
export function clamp(value, min, max) {
  const n = Number(value)
  if (!Number.isFinite(n)) return min
  return Math.min(max, Math.max(min, n))
}

/** 字符串去空白；非字符串返回 ''。 */
export function trimText(value) {
  return typeof value === 'string' ? value.trim() : ''
}

/** 取第一个不是 undefined / null 的值。 */
export function firstDefined(...values) {
  return values.find((value) => value !== undefined && value !== null)
}

/* ------------------------------------------------------------------ *
 * 时间与本地日期
 * ------------------------------------------------------------------ */

/** ISO 字符串 / Date / null → Date；不合法返回 null（不抛）。 */
export function toDate(value) {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : new Date(value.getTime())
  if (typeof value === 'number') {
    const date = new Date(value)
    return Number.isNaN(date.getTime()) ? null : date
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const date = new Date(value)
    return Number.isNaN(date.getTime()) ? null : date
  }
  return null
}

/** Date → ISO 字符串。 */
export function isoOf(value) {
  const date = toDate(value)
  return date ? date.toISOString() : null
}

/** 本地日期键 YYYY-MM-DD。 */
export function dateKey(value) {
  const date = toDate(value)
  if (!date) return null
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

/** 'YYYY-MM-DD' → 本地当天 00:00；不合法返回 null。 */
export function parseDateKey(value) {
  if (typeof value !== 'string') return null
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim())
  if (!match) return null
  const y = Number(match[1])
  const m = Number(match[2])
  const d = Number(match[3])
  const date = new Date(y, m - 1, d, 0, 0, 0, 0)
  if (date.getFullYear() !== y || date.getMonth() !== m - 1 || date.getDate() !== d) return null
  return date
}

export function startOfDay(value) {
  const date = toDate(value)
  if (!date) return null
  return new Date(date.getFullYear(), date.getMonth(), date.getDate(), 0, 0, 0, 0)
}

export function addDays(value, days) {
  const date = toDate(value)
  if (!date) return null
  const next = new Date(date.getTime())
  next.setDate(next.getDate() + days)
  return next
}

export function addMinutes(value, minutes) {
  const date = toDate(value)
  if (!date) return null
  return new Date(date.getTime() + minutes * 60_000)
}

/** ISO 周几：周一=1 … 周日=7。 */
export function isoWeekday(value) {
  const date = toDate(value)
  if (!date) return null
  const day = date.getDay()
  return day === 0 ? 7 : day
}

/** 'HH:MM' → 当天分钟数；不合法返回 null。 */
export function parseHHMM(value) {
  if (typeof value !== 'string') return null
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim())
  if (!match) return null
  const hours = Number(match[1])
  const minutes = Number(match[2])
  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return null
  return hours * 60 + minutes
}

/** 分钟数 → 'HH:MM'。 */
export function formatHHMM(totalMinutes) {
  const safe = ((Math.round(totalMinutes) % 1440) + 1440) % 1440
  return `${String(Math.floor(safe / 60)).padStart(2, '0')}:${String(safe % 60).padStart(2, '0')}`
}

/** 把某天的 'HH:MM' 变成 Date。 */
export function timeOnDay(day, hhmm) {
  const date = toDate(day)
  const minutes = parseHHMM(hhmm)
  if (!date || minutes === null) return null
  return new Date(date.getFullYear(), date.getMonth(), date.getDate(), Math.floor(minutes / 60), minutes % 60, 0, 0)
}

/** 本地周起始（默认周一 00:00）。 */
export function startOfWeek(value, weekStartsOn = 1) {
  const date = startOfDay(value)
  if (!date) return null
  const anchor = clamp(weekStartsOn, 1, 7)
  const current = isoWeekday(date)
  const diff = (current - anchor + 7) % 7
  return addDays(date, -diff)
}

/** 一周 7 天的 Date 列表（从 weekStart 起）。 */
export function daysOfWeek(weekStart) {
  const start = startOfDay(weekStart)
  if (!start) return []
  return Array.from({ length: 7 }, (_, index) => addDays(start, index))
}

/** 本周最后一个工作日（工作日的最大 ISO 周几；找不到退化为周日）。 */
export function lastWorkdayOfWeek(weekStart, workdays = [1, 2, 3, 4, 5]) {
  const start = startOfDay(weekStart)
  if (!start) return null
  const set = new Set((Array.isArray(workdays) ? workdays : []).map((n) => Number(n)))
  let last = addDays(start, 6)
  for (let offset = 6; offset >= 0; offset -= 1) {
    const day = addDays(start, offset)
    if (set.has(isoWeekday(day))) { last = day; break }
  }
  return last
}

/** 当前时刻在一天中的分钟数。 */
export function minutesSinceMidnight(value) {
  const date = toDate(value)
  if (!date) return 0
  return date.getHours() * 60 + date.getMinutes()
}

export function isWorkday(value, workdays = [1, 2, 3, 4, 5]) {
  const weekday = isoWeekday(value)
  if (weekday === null) return false
  return (Array.isArray(workdays) ? workdays : []).map(Number).includes(weekday)
}

/** 目标日期相对今天还有几天（可负，按本地零点差）。 */
export function daysLeft(value, now = new Date()) {
  const due = startOfDay(value)
  const base = startOfDay(now)
  if (!due || !base) return null
  return Math.round((due.getTime() - base.getTime()) / 86_400_000)
}

/** '11月3日'；年份与 now 不同时带年份（'2027年1月3日'）。 */
export function formatDay(value, now = new Date()) {
  const date = toDate(value)
  if (!date) return '—'
  const base = toDate(now) ?? new Date()
  const prefix = date.getFullYear() === base.getFullYear() ? '' : `${date.getFullYear()}年`
  return `${prefix}${date.getMonth() + 1}月${date.getDate()}日`
}

/** '11月3日 14:00'。 */
export function formatDateTime(value, now = new Date()) {
  const date = toDate(value)
  if (!date) return '—'
  return `${formatDay(date, now)} ${formatHHMM(date.getHours() * 60 + date.getMinutes())}`
}

/** '11月2日—11月6日'。 */
export function formatRange(start, end, now = new Date()) {
  return `${formatDay(start, now)}—${formatDay(end, now)}`
}

/* ------------------------------------------------------------------ *
 * 入参校验
 * ------------------------------------------------------------------ */

/** 必填字符串（去空白后非空）。 */
export function requireText(value, label) {
  const text = trimText(value)
  if (text === '') fail('INVALID_INPUT', `请填写${label}`)
  return text
}

/** 可选字符串 → 去空白字符串或 null。 */
export function optionalText(value) {
  if (value === undefined || value === null) return null
  const text = trimText(value)
  return text === '' ? null : text
}

/** 可选时间戳：undefined/null → null；非法 ISO → INVALID_INPUT。 */
export function optionalIso(value, label) {
  if (value === undefined || value === null || value === '') return null
  const date = toDate(value)
  if (!date) fail('INVALID_INPUT', `${label}不是合法时间（需要 ISO 8601 字符串）`)
  return date.toISOString()
}

/** 必填时间戳。 */
export function requireIso(value, label) {
  const iso = optionalIso(value, label)
  if (!iso) fail('INVALID_INPUT', `请填写${label}`)
  return iso
}

/** 可选布尔；非布尔 → INVALID_INPUT。 */
export function optionalBoolean(value, label) {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'boolean') fail('INVALID_INPUT', `${label}必须是布尔值`)
  return value
}

/** 可选数字；非法 → INVALID_INPUT。 */
export function optionalNumber(value, label) {
  if (value === undefined || value === null || value === '') return undefined
  const n = Number(value)
  if (!Number.isFinite(n)) fail('INVALID_INPUT', `${label}必须是数字`)
  return n
}

/** 字符串数组（去空白、去重、去空）；非数组 → INVALID_INPUT。 */
export function requireStringArray(value, label, { allowEmpty = false } = {}) {
  if (!Array.isArray(value)) fail('INVALID_INPUT', `${label}必须是字符串数组`)
  const out = []
  for (const item of value) {
    const text = trimText(item)
    if (text === '') continue
    if (!out.includes(text)) out.push(text)
  }
  if (!allowEmpty && out.length === 0) fail('INVALID_INPUT', `请至少提供一个${label}`)
  return out
}

/** 把值统一成数组（单值 → [单值]，null → []）。 */
export function asArray(value) {
  if (Array.isArray(value)) return value
  if (value === undefined || value === null || value === '') return []
  return [value]
}
