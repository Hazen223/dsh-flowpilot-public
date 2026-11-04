/**
 * UI 一致性审计（docs/UI-DESIGN.md 的自动检查）。
 *
 * 检查三类问题：
 *  1. 描边：容器/按钮/输入框上的 border（border-radius 除外）——目标：全量 ≤ 24，且逐文件达标
 *  2. 间距：padding/margin/gap 的 px 值必须落在 4 栅格（4/8/12/16/20/24/32/40，0 允许）
 *  3. 颜色：CSS 里出现的 #hex 必须属于 设计系统 调色板；--dsw-alias-* 颜色令牌必须已迁移到 --fp-*
 *
 * 用法：
 *   node tools/audit-ui.mjs              # 全量报告（表格 + violation 明细）
 *   node tools/audit-ui.mjs --file=25-primitives.js
 *   node tools/audit-ui.mjs --strict     # 超标时退出码 1（用于收尾验收）
 *   node tools/audit-ui.mjs --json       # 机器可读
 */
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const SRC = join(root, 'src', 'client')

/** 设计系统 2.0 调色板（含浅/深两种模式用到的全部 HEX）。 */
const PALETTE = new Set([
  '#ffffff', '#f6f7f8', '#f1f2f3', '#e8eaec', '#e3e5e7', '#c9ccd0', '#b4b8bd', '#9499a0', '#61666d',
  '#0d0e10', '#17181a', '#1d1f23', '#24262b', '#2a2c32',
  '#f0f1f2', '#c8ccd0',
  '#b753ff', '#bb5cff', '#ad3bff', '#ae52f0',
  '#2ac864', '#47cf79', '#ffb027', '#ff7f24', '#f85a54', '#e84943', '#07aa43', '#008ac5',
])

/** 逐文件预算（描边数上限） */
const BORDER_BUDGET = {
  '10-util.js': 0,
  '20-store.js': 0,
  '25-primitives.js': 6,
  '30-shell.js': 2,
  '40-flow.js': 6,
  '45-ai.js': 2,
  '50-views.js': 2,
  '55-sync.js': 2,
  '57-update.js': 0,
  '60-quick.js': 2,
  '70-css.js': 0,
  '80-apply.js': 0,
}
const TOTAL_BORDER_BUDGET = 24

const args = process.argv.slice(2)
const jsonMode = args.includes('--json')
const strict = args.includes('--strict')
const fileFilter = (args.find((a) => a.startsWith('--file=')) || '').split('=')[1] || ''

function extractCss(text) {
  const chunks = []
  // String.raw`...` 片段（所有 CSS 常量都这么写）
  const re = /String\.raw`([\s\S]*?)`/g
  let m
  while ((m = re.exec(text))) chunks.push(m[1])
  return chunks
    .map((chunk) => ({ css: chunk }))
    .map((entry, index) => ({ css: entry.css, index }))
    .map((entry) => entry.css)
}

function lineOf(text, index) {
  return text.slice(0, index).split('\n').length
}

/** 收集声明：返回 { prop, value, index } */
function collectDeclarations(css) {
  const out = []
  const re = /([a-zA-Z-]+)\s*:\s*([^;{}]+);?/g
  let m
  while ((m = re.exec(css))) out.push({ prop: m[1].toLowerCase(), value: m[2].trim(), index: m.index })
  return out
}

const SPACING_PROPS = /^(padding|margin)(-(top|right|bottom|left|inline|block)(-(start|end))?)?$|^(gap|row-gap|column-gap|row-gap|padding-inline|padding-block|margin-inline|margin-block)$/
const BORDER_PROPS = /^border(-(top|right|bottom|left|inline|block))?(-(width|style|color))?$/

function isOnGrid(value) {
  const px = [...value.matchAll(/(-?\d+(?:\.\d+)?)px/g)].map((x) => Number(x[1]))
  if (px.length === 0) return true // 0 / auto / var() / calc() 不判
  return px.every((n) => n === 0 || Math.abs(n % 4) < 1e-9)
}

function auditFile(file) {
  const text = readFileSync(join(SRC, file), 'utf8')
  const cssChunks = extractCss(text)
  const css = cssChunks.join('\n')
  const decls = collectDeclarations(css)

  const borders = []
  const spacingBad = []
  const hexBad = []
  const dswTokens = []

  for (const decl of decls) {
    if (BORDER_PROPS.test(decl.prop)) {
      const value = decl.value
      if (/(?:none|0(?![.\d])|0px)/.test(value) && !/\d+px\s+(solid|dashed|dotted)/.test(value)) {
        // border: 0 / none
      } else if (/^(solid|dashed|dotted|double)/.test(value) || /\d/.test(value)) {
        borders.push({ prop: decl.prop, value })
      }
    }
    if (SPACING_PROPS.test(decl.prop) && !isOnGrid(decl.value)) {
      spacingBad.push({ prop: decl.prop, value: decl.value })
    }
  }

  for (const m of css.matchAll(/#[0-9a-fA-F]{3,8}\b/g)) {
    const lower = m[0].toLowerCase()
    if (!PALETTE.has(lower)) hexBad.push({ hex: lower, line: lineOf(css, m.index) })
  }
  for (const m of css.matchAll(/--dsw-alias-[a-z0-9-]+/g)) dswTokens.push({ token: m[0] })

  return {
    file,
    borders: borders.length,
    borderList: borders.slice(0, 8),
    spacingBad: spacingBad.length,
    spacingList: spacingBad.slice(0, 10),
    hexBad: hexBad.length,
    hexList: hexBad.slice(0, 8),
    dswTokens: dswTokens.length,
    dswList: dswTokens.slice(0, 6),
    budget: BORDER_BUDGET[file] ?? 0,
  }
}

const files = readdirSync(SRC)
  .filter((f) => f.endsWith('.js'))
  .sort()
  .filter((f) => (fileFilter ? f === fileFilter : true))

const rows = files.map(auditFile)
const totals = rows.reduce(
  (acc, row) => ({
    borders: acc.borders + row.borders,
    spacingBad: acc.spacingBad + row.spacingBad,
    hexBad: acc.hexBad + row.hexBad,
    dswTokens: acc.dswTokens + row.dswTokens,
  }),
  { borders: 0, spacingBad: 0, hexBad: 0, dswTokens: 0 },
)

const violations = []
for (const row of rows) {
  if (row.borders > row.budget) violations.push(`${row.file}: 描边 ${row.borders} 超过预算 ${row.budget}`)
  if (row.spacingBad > 0) violations.push(`${row.file}: ${row.spacingBad} 处间距不在 4 栅格`)
  if (row.hexBad > 0) violations.push(`${row.file}: ${row.hexBad} 处颜色不在 设计系统 调色板`)
  if (row.dswTokens > 0) violations.push(`${row.file}: ${row.dswTokens} 处仍引用 --dsw-alias-* 颜色令牌`)
}
if (totals.borders > TOTAL_BORDER_BUDGET) violations.push(`全量描边 ${totals.borders} 超过总预算 ${TOTAL_BORDER_BUDGET}`)

if (jsonMode) {
  console.log(JSON.stringify({ rows, totals, violations }, null, 2))
} else {
  console.log('file                 borders/budget   offGrid4   badHex   dswTokens')
  console.log('-'.repeat(72))
  for (const row of rows) {
    const flag = row.borders > row.budget ? ' ✗' : ''
    console.log(
      `${row.file.padEnd(20)} ${String(row.borders).padStart(4)}/${String(row.budget).padEnd(4)}      ` +
        `${String(row.spacingBad).padStart(6)}  ${String(row.hexBad).padStart(7)}  ${String(row.dswTokens).padStart(9)}${flag}`,
    )
  }
  console.log('-'.repeat(72))
  console.log(
    `TOTAL                ${String(totals.borders).padStart(4)}/${String(TOTAL_BORDER_BUDGET).padEnd(4)}      ` +
      `${String(totals.spacingBad).padStart(6)}  ${String(totals.hexBad).padStart(7)}  ${String(totals.dswTokens).padStart(9)}`,
  )
  if (process.argv.includes('--detail')) {
    for (const row of rows) {
      if (row.borderList.length) console.log(`\n[${row.file}] borders:`, row.borderList.map((b) => `${b.prop}: ${b.value}`))
      if (row.spacingList.length) console.log(`[${row.file}] off-grid:`, row.spacingList.map((s) => `${s.prop}: ${s.value}`))
      if (row.hexList.length) console.log(`[${row.file}] hex:`, row.hexList.map((h) => h.hex))
      if (row.dswList.length) console.log(`[${row.file}] dsw:`, row.dswList.map((d) => d.token))
    }
  }
  if (violations.length) {
    console.log('\n未达标项：')
    for (const v of violations) console.log('  ✗ ' + v)
  } else {
    console.log('\nUI 规范达标 ✓')
  }
}

if (strict && violations.length) process.exit(1)
