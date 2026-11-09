# FlowPilot UI 设计规范（设计系统 用色 + 4 栅格间距 + 去描边）

依据：《设计系统 2.0 用色规范》（B 站商业化组件库色表，浅/深双模式）。
本文件是 FlowPilot 面板的**视觉硬约束**。改任何 UI 样式前先读这里，改完用 `node tools/audit-ui.mjs --strict` 自检。

---

## 1. 三条核心原则

1. **不用描边分隔，用灰阶面分隔。** 容器、卡片、列表行、按钮、输入框一律靠「背景色层级 + 间距」区分，
   不写 `border: 1px solid …`。全量描边预算 24（现状 172 → 目标 ≤24），逐文件预算见 §7。
2. **间距只用 4 栅格。** `padding` / `margin` / `gap` 的 px 值只能是 `0/4/8/12/16/20/24/32/40`。
   不允许 5/6/7/9/10/11/13/14/15/18/22/26 这类数值。字号、行高、圆角不受此限（圆角用 §3 的取值）。
3. **颜色只走 `--fp-*` 令牌，不直接写 HEX、不再引用 `--dsw-alias-*` 颜色令牌。**
   所有令牌都写在 `10-util.js` 的 `CSS_BASE` 里，用 `light-dark(浅, 深)` 承载 设计系统 的浅/深双模式。

---

## 1.1 文案原则

> **Avoid unnecessary secondary labels and descriptions. Let the layout do the explaining.**

- **能用布局/图标/状态 chip 表达的，不写第二个标签。** 节点卡上的「计划 / 跟进 / 计划开始」前缀已删除：日历 = 计划完成、时钟 = 跟进、旗帜 = 计划开始，完整语义保留在 `title`（悬停）里。
- **同一信息只写一次。** 状态 chip 已经表达状态，就不再附一段状态说明；完成门槛在 gate 里说明后，不再重复一行「需双方确认 + 设计稿链接」。
- **小节说明只在规则不直观时保留一条**（证据门槛、归档只读、跳过不计入成果）；能由按钮/表单 label 说明的 hint 一律删。
- **空态只回答「这里是什么」**，操作交给旁边的按钮：`还没有链接`、`还没有业务线`、`选择一个项目`。
- **表单 hint 只写约束/默认值**，不写「留空表示不设置」这类复述；**超过 30 个汉字的 hint 视为过度解释**。
- **校验**：`tools/audit-ui.mjs` 的 `auditCopy()` 拦截黑名单复述文案与超长 hint（`--strict` 下计入未达标）。

## 2. 颜色层级（设计系统 色表 → 令牌）

| 用途 | 令牌 | 浅色（增长/常规） | 深色（增长/深色） |
|---|---|---|---|
| 应用底 | `--fp-base` | `#F6F7F8` (bg-primary) | `#17181A` |
| 卡片 / 抬高面 | `--fp-surface` | `#FFFFFF` (bg-white) | `#1D1F23` |
| 下沉面 / 嵌块 / 输入框 | `--fp-surface-2` | `#F1F2F3` (bg-secondary) | `#0D0E10` |
| 浮层 / 弹窗 | `--fp-overlay` | `#FFFFFF` (float-white) | `#1D1F23` |
| 悬停底 | `--fp-hover` | `#F1F2F3` | `#24262B` |
| 按下底 | `--fp-pressed` | `#E8EAEC` | `#2A2C32` |
| 遮罩 | `--fp-mask` | `rgba(13,14,16,.44)` | `rgba(0,0,0,.62)` |
| 一级文本 | `--fp-text` | `#0D0E10` (text-dark) | `#F0F1F2` |
| 二级文本 | `--fp-text-dim` | `#61666D` (text-primary) | `rgba(240,241,242,.62)` |
| 三级文本 | `--fp-text-tertiary` | `#9499A0` (text-secondary) | `rgba(240,241,242,.45)` |
| 四级/占位 | `--fp-text-quaternary` | `#B4B8BD` (text-tertiary) | `rgba(240,241,242,.30)` |
| 描边（仅例外） | `--fp-border` / `--fp-border-strong` | `#F1F2F3` / `#E3E5E7` | `rgba(241,242,243,.06)` / `rgba(227,229,231,.10)` |
| 主按钮填充 | `--fp-brand` | `#0D0E10` | `#F0F1F2` |
| 主按钮文字 | `--fp-on-brand` | `#FFFFFF` | `#0D0E10` |
| 业务主题色 | `--fp-accent` | `#B753FF` | `#BB5CFF` |
| 强调字 | `--fp-accent-strong` | `#AD3BFF` | `#AE52F0` |
| 成功 | `--fp-ok` | `#2AC864` | `#47CF79` |
| 警告（黄/橘） | `--fp-warn` / `--fp-warn-strong` | `#FFB027` / `#FF7F24` | 同值 |
| 错误 | `--fp-bad` | `#F85A54` | `#F85A54` |
| 链接/信息 | `--fp-info` | `#008AC5` | `#008AC5` |
| 阴影 | `--fp-shadow-1/2/3` | 黑 6%/10%/16% | 黑 36%/46%/56% |

> 主题色说明：设计系统 原始业务主题色是粉色 `business-pink`；FlowPilot 采用其**同饱和度/明度**的
> 紫色变体（色相 341°→275°，S/L 不变：浅色 `#B753FF`、深色 `#BB5CFF`，强调字 `#AD3BFF`/`#AE52F0`）。
> 如需还原粉色，仅改 `10-util.js` 里 `--fp-accent` / `--fp-accent-strong` 两个令牌即可。

**语义状态映射**（节点状态色 / 徽标）：成功=绿、待确认=黄、已阻塞/错误=红、进行中/当前=业务强调色
`--fp-accent`、待修改=`--fp-warn-strong`、已完成=绿（低饱和背景）、未解锁=四级文本/下沉面。

---

## 3. 间距 / 圆角 / 字号

- 间距：`--fp-sp-1..--fp-sp-10` = 4/8/12/16/20/24/32/40（也允许直接写这些 px）。
- 圆角：`--fp-radius-sm:4` / `md:8` / `lg:12` / `xl:16` / `pill:999`。卡片用 `lg`，嵌块/输入/按钮用 `md`，
  小徽标用 `sm`，胶囊用 `pill`。禁止 6/10/14 这类旧值。
- 字号：`--fp-font-xs:11` / `sm:12` / `md:13` / `lg:15` / `xl:19`。

---

## 4. 去描边配方（改样式照抄）

| 元素 | 旧写法（禁止） | 新写法（必须） |
|---|---|---|
| 卡片 / 面板 | `border: 1px solid var(--fp-border); background: var(--fp-surface)` | `background: var(--fp-surface); border-radius: var(--fp-radius-lg)`（父层 `--fp-base` 打底） |
| 卡片内的嵌块 / 次级分区 | `border: 1px solid …; background: transparent` | `background: var(--fp-surface-2); border-radius: var(--fp-radius-md)` |
| 列表行 / 可点区域 | `border-bottom: 1px solid …` | 去掉边框；行间用 `gap: 4px` 或行内 `padding: 8px 12px`，hover 时 `background: var(--fp-hover)` |
| 需要极淡分隔线（密集列表） | `border-bottom: 1px solid …` | `<div class="fp-divider">`（1px，`background: var(--fp-border)`），或直接不加 |
| 输入框 / 选择器 | `border: 1px solid …` | `background: var(--fp-surface-2); border-radius: var(--fp-radius-md)`；聚焦：`box-shadow: 0 0 0 2px color-mix(in srgb, var(--fp-accent) 45%, transparent)`；错误同款用 `--fp-bad` |
| 默认按钮 | `border: 1px solid …` | `background: var(--fp-surface-2)`；hover `--fp-hover`；ghost/quiet 直接透明 |
| 主按钮 | — | 已钉死：填充 `light-dark(#0d0e10,#f0f1f2)`、文字 `light-dark(#fff,#0d0e10)`，hover `light-dark(#17181a,#e3e5e7)`（不要改回令牌链） |
| 危险按钮 | `border: 1px solid red` | `background: color-mix(in srgb, var(--fp-bad) 12%, transparent); color: var(--fp-bad)` |
| 徽标 / 状态 chip | `border: 1px solid …` | 背景 `color-mix(in srgb, <语义色> 12%, transparent)`，文字 = 语义色；无描边 |
| 弹窗 / 浮层 | `border: 1px solid …` | `background: var(--fp-overlay); border-radius: var(--fp-radius-xl); box-shadow: var(--fp-shadow-3)`；遮罩用 `--fp-mask` |
| 分段控件 / Tab | 外框 + 内框描边 | 外层 `background: var(--fp-surface-2); border-radius: pill; padding: 4px`；选中项 `background: var(--fp-surface) + var(--fp-shadow-1)`，无描边 |
| 时间线 / 节点连线 | `border-left: …` | 用 `::before/::after` 的 `background` 条（不影响描边预算），色用 `--fp-border-strong` |

**唯一允许保留的描边**（仍计入预算但数量很少）：
1. 极淡分隔线（优先 `.fp-divider`，不算 border）；
2. 表格/极密集数据行的横向分隔（可改 `.fp-divider`）；
3. 焦点态请用 `outline` / `box-shadow`，**不要**用 border。

---

## 5. 布局与层次

- 面板底：`--fp-base`（浅灰 / 深色 #17181A）。
- **布局：白卡直接浮在 `--fp-base` 灰底上**，卡片之间只留 12px 间隙，不画描边、不叠双层边框。
- 左栏项目导航 = 一张白色卡片（`--fp-surface` + `--fp-radius-lg`）；
  行级状态：hover `--fp-hover`、选中 `--fp-surface-2` + `--fp-shadow-1`。
- 左栏底部操作（`.fp-nav__actions`）：两个按钮统一 32px 高 / 12px / 字重 500 / 左右内边距 24px；
  图标绝对定位在左侧 8px，**文字相对按钮真正居中**（不是「图标 + 文字」整体居中），避免两个按钮看起来一大一小。
- **项目条目卡片排版**（左栏，对齐悬浮弹窗 `fp-quick-row` 的排版语言）：左右外边距 12、卡片上下间距 8、内边距 8、圆角 8；
  结构为 `main` 两行——`head`（10px 等宽编号 chip（surface-2 / 16px 行高）· 8px · 12px 标题）→ `meta`（11px 三级灰的「业务线 · 阶段」+ 内联截止日，橙色 `--fp-warn-strong`、逾期转红，间距 8）；
  底部 `进度条` absolute 贴卡底（left/right 0 / bottom 0 / 3px 高 / 下圆角与卡片一致，常显）；行 `overflow: hidden` + 标题省略号，长标题不会撑破侧栏；
  不设右侧「⋯」按钮（更多操作走右键菜单 / `Shift+F10`）。
- 流程信息卡的操作区（`.fp-flow-head-actions`）**固定贴右**（`margin-left:auto`，不换行）；
  主操作「追加节点模板」用 `default` 实心按钮，次操作「添加验收流程」用 `quiet` 文字按钮（两者不同色）；
  信息卡是容器查询容器（`container-type: inline-size`），`@container (max-width: 560px)` 时两个按钮**竖排一上一下**，仍贴右边。
- 中栏流程页 = **两张独立卡片**（`.fp-flow` 用 `gap: 12px` 分隔）：
  1. **项目信息卡** `.fp-flow-head`：业务线 / 项目名 / 截止 / 阶段 chip / 操作按钮 / 流程进度条（左右与内容对齐，轨道撑满可用宽度）/ 归档提示；
  2. **项目节点卡** `.fp-flow-canvas`：**灰井铺满整卡，不再套白边**（`padding: 0`，`background: var(--fp-well)`，圆角 12 靠 `overflow: auto` 裁切）。
     井内元素层级：普通/当前节点卡 = `--fp-surface`（白/深面）浮起；已完成/锁定 = `color-mix(井色 40%, 卡片色 60%)` 退后一档；
     进度轨道与节点圆点 = `--fp-pressed`；桥接块/占位提示 = `--fp-surface`。
     `--fp-well` 默认等于 `--fp-surface-2`，要整体加深/变浅只改 10-util 里这一行。
- 其它视图（今日/周报/交接/设置）= 各自内容卡片直接排在 `--fp-base` 灰底上（`.fp-v-root` 透明，自带 16/20/32 内边距）。
- 节点详情各分组的操作（编辑 / 添加 / 收起等）统一**贴内容右缘**（`.fp-detail-sec-actions { margin-left: auto }`），不跟标题挤在一起。
- 节点详情「推进节点」区（`.fp-detail-actions`）：主操作与下方次要操作行之间 **gap 12px**，同一行内的次要按钮横向 gap 8px。
- 右栏节点详情 = 一张白卡，卡内用 `--fp-surface-2` 灰面分组（双角色确认 / 推进节点 / 计划与跟进 / 关联链接 / 笔记）。
- 顶栏本身透明、不画卡片；只放按钮与 chip。顶栏入口 chip = `--fp-surface-2` 药丸（高 28，圆角 pill），hover 用 `--fp-pressed`。
- 顶栏响应式：<1120px 时同步/设置/节奏/汇总/时钟收进一个「⋯」入口（下拉菜单用 `.fp-ctxmenu` 样式 + `.fp-topmore__info` 信息行）；
  <860px 品牌只留图标。下拉菜单固定定位在入口下方右对齐，`max-height` 限高可滚动，`--shadow-3`、无描边。
- 顶栏入口的快捷面板 `.fp-qpanel`：固定定位在入口下方（右对齐、宽 372、限高可滚动），
  卡片 `--fp-surface` + `--radius-lg` + `--shadow-3`，内部分组用 `--fp-surface-2`，动效 `fp-qpanel-in`（140ms、位移 4px）。
- 设置是**居中浮层**（`.fp-modal-layer` 用 `--fp-mask` 遮罩 + `.fp-modal` 白卡 `--radius-lg` + `--shadow-3`，
  `width: min(880px, 100%)`、`max-height: min(860px, 88vh)`，内容区 `overflow:auto`）。弹窗不画描边。
- **主题色只旋转色相**：`--fp-accent` = `light-dark(hsl(H 100% 66.3%), hsl(H 100% 68%))`、
  `--fp-accent-strong` = `light-dark(hsl(H 100% 61.6%), hsl(H 84% 63.1%))`；预设 H=275（紫）/216（蓝）/343（品牌粉），
  自定义滑杆写 `localStorage['flowpilot.accentHue']`，启动时由 `fpApplyAccentHue` 注入 `documentElement`。
  新增的强调色一律走 `--fp-accent*`，不要写死 hex。
- 弹窗、浮层、快捷面板：`--fp-overlay` + `--fp-shadow-3`（下拉 `--fp-shadow-2`）。
- 悬停优先改底色（`--fp-hover`），不要加描边或位移。

---

## 6. 自检

```bash
node tools/audit-ui.mjs             # 表格：描边/预算、非 4 栅格间距、非法颜色、--dsw-alias 残留
node tools/audit-ui.mjs --detail    # 附带明细
node tools/audit-ui.mjs --strict    # 未达标退出码 1（含文案原则：复述型文案 / 超长 hint）
node build-client.mjs && node --check client.js && node tests/client-smoke.mjs
```

---

## 7. 逐文件描边预算（当前基线 → 目标）

| 文件 | 基线 | 预算 |
|---|---|---|
| 10-util.js | 2 | 0 |
| 25-primitives.js | 39 | 6 |
| 30-shell.js | 26 | 2 |
| 40-flow.js | 37 | 6 |
| 45-ai.js | 28 | 2 |
| 50-views.js | 18 | 2 |
| 55-sync.js | 4 | 2 |
| 57-update.js | 0 | 0 |
| 60-quick.js | 18 | 2 |
| **合计** | **172** | **≤24** |

非 4 栅格间距基线 352 处 → 目标 **0**。
`--dsw-alias-*` 颜色令牌 → 目标 **0**（字号/字体族等非颜色令牌允许保留，如 `--ds-font-family-code`）。
HEX 只允许 §2 表里的 设计系统 值（`10-util.js` 令牌块内），其它文件出现 HEX 即失败。

---

## 9. `--dsw-*` → `--fp-*` 迁移映射表（机械替换用）

| 旧令牌 | 新令牌 |
|---|---|
| `--dsw-alias-bg-base` | `--fp-base` |
| `--dsw-alias-bg-layer-1` / `-3` | `--fp-surface` |
| `--dsw-alias-bg-layer-2` | `--fp-surface-2` |
| `--dsw-alias-bg-overlay` | `--fp-overlay` |
| `--dsw-alias-bg-mask-1` | `--fp-mask` |
| `--dsw-alias-bg-skeleton` / `-module-platform` | `--fp-surface-2` |
| `--dsw-alias-label-primary` | `--fp-text` |
| `--dsw-alias-label-secondary` | `--fp-text-dim` |
| `--dsw-alias-label-tertiary` | `--fp-text-tertiary` |
| `--dsw-alias-label-quaternary` / `-dimmed` | `--fp-text-quaternary` |
| `--dsw-alias-label-primary-foreground` / `-inverted` | `--fp-on-brand` |
| `--dsw-alias-brand-primary` / `-brand-text` | `--fp-brand`（主按钮保持 §4 的钉死值，不要改回令牌） |
| `--dsw-alias-border-l1` | `--fp-border` |
| `--dsw-alias-border-l2` | `--fp-border-strong` |
| `--dsw-alias-border-l3` / `-l4` / `-inverted` | 删除该描边（改面层级）；确需分隔用 `.fp-divider` |
| `--dsw-alias-state-success-primary` | `--fp-ok` |
| `--dsw-alias-state-warn-primary` / `-warn-label` / `-warn-tertiary` | `--fp-warn` |
| `--dsw-alias-state-error-primary` | `--fp-bad` |
| `--dsw-alias-state-idle-primary` | `--fp-idle` |
| `--dsw-alias-state-business-primary` | `--fp-accent` |
| `--dsw-alias-interactive-bg-hover` | `--fp-hover` |
| `--dsw-alias-interactive-bg-active` | `--fp-pressed` |
| `--dsw-alias-button-primary-fill` | `--fp-brand`（主按钮保持钉死值） |
| `--dsw-alias-button-ghost-active-fill` | `--fp-hover` |
| `--dsw-alias-button-ghost-active-border` | 删除（不再用描边表示激活） |
| `--dsw-alias-toast-bg` / `-toast-label` | `--fp-brand` / `--fp-on-brand` |
| `--dsw-shadow-lv1/2/3` | `--fp-shadow-1/2/3` |
| `--dsw-elevation-panel` / `-prominent` | `--fp-shadow-2` / `--fp-shadow-3` |
| `--dsw-radius-sm/md/lg/xl` | `--fp-radius-sm/md/lg/xl` |
| `--ds-font-family-code` | 保留（字体族，不属于颜色） |

- **原生控件必须清零默认样式**：所有 `<button>` 都要显式 `border: 0; appearance: none;`。
  否则浏览器会画 `2px outset` 原生边框，在深色主题下看起来像一圈怪异的「双圈高亮」
  （`FpUpdateBadge` 踩过这个坑）。`node tools/audit-ui.mjs --strict` 会跨文件扫描「用在 button 上但没清边框」的类名并直接报错。

## 8. 禁止事项

- ❌ 新增 `border` 用于容器/按钮/输入框分隔
- ❌ 5/6/7/9/10/11/13/14/15/18/22/26 px 等非 4 栅格间距
- ❌ 直接写 HEX 颜色、或引用 `--dsw-alias-*` 颜色令牌（明暗会失控）
- ❌ 修改主按钮的钉死色（见 §4）
- ❌ 引入渐变、投影叠层超过 `--fp-shadow-3`、圆角 4 栅格以外的值
