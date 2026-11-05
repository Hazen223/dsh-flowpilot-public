/* ===== 归属：ui-shell · 三栏工作台外壳（契约 §7.1 FpRoot） =====
 * 顶栏（标识 / 视图分段 / 节奏提示 / 摘要 / 刷新 / 时间）
 *   → 左栏 264px 业务线·项目导航（可抽屉化）
 *   → 中栏按 view 渲染 FlowView / TodayView / WeeklyView / HandoffView / SettingsView
 *   → 右栏 344px NodeDetail（可折叠，<980px 覆盖式）
 * 弹窗宿主统一在这里渲染；业务写操作一律 dispatch 给宿主，客户端不推导状态机。
 */

const CSS_SHELL = String.raw`/* ===== 分层：--fp-base 打底；左栏平铺；中/右栏 --fp-surface 卡片；卡内分组 --fp-surface-2 ===== */
.fp-root {
  --fp-shell-nav-w: 264px;
  --fp-shell-side-w: 344px;
  position: relative;
  display: flex;
  flex-direction: column;
  flex: 1 1 auto;
  width: 100%;
  height: 100%;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  background: var(--fp-base);
  color: var(--fp-text);
  font-size: var(--fp-font-md);
  line-height: 1.5;
  box-sizing: border-box;
  isolation: isolate;
}

/* ---------------- 顶栏：平铺在底色上，分隔靠间距与灰阶面 ---------------- */
.fp-topbar {
  position: relative;
  z-index: 30;
  display: flex;
  align-items: center;
  gap: 8px;
  flex: none;
  height: 48px;
  min-width: 0;
  padding: 0 16px;
  background: transparent;
}
.fp-brand {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: none;
  min-width: 0;
}
.fp-brand__mark {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  flex: none;
  border-radius: var(--fp-radius-md);
  background: color-mix(in srgb, var(--fp-accent) 12%, transparent);
  color: var(--fp-accent);
}
.fp-brand__text {
  display: flex;
  flex-direction: column;
  min-width: 0;
}
.fp-brand__name {
  font-size: 13.5px;
  font-weight: 700;
  line-height: 1.15;
  letter-spacing: 0.015em;
  color: var(--fp-text);
  white-space: nowrap;
}
.fp-brand__sub {
  font-size: 10.5px;
  line-height: 1.2;
  letter-spacing: 0.06em;
  color: var(--fp-text-tertiary);
  white-space: nowrap;
}

/* 视图分段：pill 容器 + 选中面（无外框/内框描边） */
.fp-views {
  display: flex;
  align-items: center;
  gap: 0;
  flex: none;
  padding: 4px;
  border-radius: var(--fp-radius-pill);
  background: var(--fp-surface-2);
}
.fp-view-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 28px;
  padding: 0 12px;
  border: 0;
  border-radius: var(--fp-radius-pill);
  background: transparent;
  color: var(--fp-text-dim);
  font: inherit;
  font-size: var(--fp-font-sm);
  font-weight: 500;
  line-height: 1;
  white-space: nowrap;
  cursor: pointer;
  transition: background-color 140ms ease, color 140ms ease, box-shadow 140ms ease;
}
.fp-view-btn:hover:not(:disabled) {
  background: color-mix(in srgb, var(--fp-surface) 60%, transparent);
  color: var(--fp-text);
}
.fp-view-btn[data-active="true"] {
  background: var(--fp-surface);
  color: var(--fp-text);
  box-shadow: var(--fp-shadow-1);
  font-weight: 600;
}
.fp-view-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
.fp-topbar__spacer {
  flex: 1 1 auto;
  min-width: 8px;
}
.fp-clock {
  display: flex;
  align-items: baseline;
  gap: 4px;
  flex: none;
  padding: 0 4px;
  font-variant-numeric: tabular-nums;
}
.fp-clock__day {
  font-size: var(--fp-font-xs);
  color: var(--fp-text-tertiary);
}
.fp-clock__time {
  font-family: var(--fp-mono);
  font-size: var(--fp-font-md);
  font-weight: 600;
  color: var(--fp-text);
}

/* 节奏提示：业务强调色淡染浮片 */
.fp-rhythm {
  display: flex;
  align-items: center;
  gap: 4px;
  flex: none;
  max-width: 380px;
  height: 28px;
  padding: 0 4px 0 12px;
  border-radius: var(--fp-radius-pill);
  background: color-mix(in srgb, var(--fp-accent) 8%, var(--fp-surface));
  box-shadow: var(--fp-shadow-1);
  color: var(--fp-text-dim);
}
.fp-rhythm__main {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  height: 100%;
  padding: 0;
  border: 0;
  background: transparent;
  color: inherit;
  font: inherit;
  font-size: var(--fp-font-sm);
  cursor: pointer;
}
.fp-rhythm__dot {
  width: 8px;
  height: 8px;
  flex: none;
  border-radius: var(--fp-radius-pill);
  background: var(--fp-accent);
  box-shadow: 0 0 0 4px color-mix(in srgb, var(--fp-accent) 14%, transparent);
}
.fp-rhythm__title {
  color: var(--fp-text);
  font-weight: 600;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.fp-rhythm__body {
  max-width: 160px;
  color: var(--fp-text-dim);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.fp-rhythm__cta {
  color: var(--fp-accent-strong);
  font-size: var(--fp-font-xs);
  font-weight: 600;
  white-space: nowrap;
}
.fp-rhythm__close {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  flex: none;
  padding: 0;
  border: 0;
  border-radius: var(--fp-radius-pill);
  background: transparent;
  color: var(--fp-text-tertiary);
  cursor: pointer;
  transition: background-color 140ms ease, color 140ms ease;
}
.fp-rhythm__close:hover {
  background: var(--fp-hover);
  color: var(--fp-text);
}

/* 摘要：抬高一层的 pill */
.fp-summ {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  flex: none;
  height: 28px;
  padding: 0 4px;
  border: 0;
  border-radius: var(--fp-radius-pill);
  background: var(--fp-surface);
  box-shadow: var(--fp-shadow-1);
  color: var(--fp-text-dim);
  font: inherit;
  cursor: pointer;
  transition: background-color 140ms ease;
}
.fp-summ:hover {
  background: var(--fp-hover);
}
.fp-summ__item {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 0 8px;
  font-size: var(--fp-font-xs);
  white-space: nowrap;
}
.fp-summ__dot {
  width: 8px;
  height: 8px;
  flex: none;
  border-radius: var(--fp-radius-pill);
  background: currentColor;
  opacity: 0.9;
}
.fp-summ__item[data-tone="brand"] .fp-summ__dot {
  background: var(--fp-accent);
}
.fp-summ__item[data-tone="warn"] .fp-summ__dot {
  background: var(--fp-warn);
}
.fp-summ__item[data-tone="error"] .fp-summ__dot {
  background: var(--fp-bad);
}
.fp-summ__item[data-tone="error"] {
  color: var(--fp-bad);
}
.fp-summ__num {
  color: var(--fp-text);
  font-weight: 650;
  font-variant-numeric: tabular-nums;
}
.fp-summ__item[data-tone="error"] .fp-summ__num {
  color: var(--fp-bad);
}
.fp-summ__label {
  color: var(--fp-text-tertiary);
}

/* ---------------- 三栏：12px 槽间距分隔，不用描边 ---------------- */
.fp-shell {
  position: relative;
  display: flex;
  flex: 1 1 auto;
  gap: 12px;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  padding: 0 16px 16px;
}

/* 左栏：平铺在底色上，不做整块卡片 */
.fp-nav {
  position: relative;
  z-index: 20;
  display: flex;
  flex-direction: column;
  flex: 0 0 var(--fp-shell-nav-w);
  width: var(--fp-shell-nav-w);
  min-width: 0;
  min-height: 0;
  /* 与右侧详情卡一致：白色大卡片作为底，行级 hover/选中用灰面区分 */
  background: var(--fp-surface);
  border-radius: var(--fp-radius-lg);
  overflow: hidden;
}
.fp-nav[data-drawer="true"] {
  --fp-surface: var(--fp-base);
  position: absolute;
  left: 16px;
  top: 0;
  bottom: 16px;
  z-index: 25;
  width: 288px;
  flex-basis: 288px;
  padding: 8px;
  background: var(--fp-overlay);
  border-radius: var(--fp-radius-lg);
  box-shadow: var(--fp-shadow-3);
}
.fp-nav__head {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: none;
  padding: 12px 8px 8px;
}
.fp-nav__title {
  font-size: 10.5px;
  font-weight: 700;
  letter-spacing: 0.09em;
  text-transform: uppercase;
  color: var(--fp-text-tertiary);
}
.fp-nav__count {
  margin-left: auto;
  font-size: 10.5px;
  color: var(--fp-text-quaternary);
  font-variant-numeric: tabular-nums;
}
.fp-nav__scroll {
  flex: 1 1 auto;
  min-height: 0;
  overflow: auto;
  padding: 0 0 8px;
  scrollbar-width: thin;
}
.fp-nav__empty {
  margin: 8px;
  font-size: var(--fp-font-xs);
  line-height: 1.65;
  color: var(--fp-text-tertiary);
}
.fp-nav__foot {
  display: flex;
  flex-direction: column;
  gap: 8px;
  flex: none;
  padding: 8px;
}
.fp-nav__foot::before {
  content: "";
  height: 1px;
  background: var(--fp-border);
}
.fp-nav__actions {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
}
/* 左栏底部两个按钮：尺寸/字重统一，图标固定在左侧、文字真正居中 */
.fp-nav__actions > .fp-btn {
  position: relative;
  justify-content: center;
  height: 32px;
  padding: 0 var(--fp-sp-6);
  font-size: var(--fp-font-sm);
  font-weight: 500;
}
.fp-nav__actions > .fp-btn--primary {
  font-weight: 500;
}
.fp-nav__actions > .fp-btn > .fp-btn__icon {
  position: absolute;
  left: var(--fp-sp-2);
  top: 50%;
  transform: translateY(-50%);
  margin: 0;
}
.fp-nav__actions > .fp-btn > .fp-btn__label {
  text-align: center;
}
.fp-nav__status {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  padding: 0;
  font-size: 10.5px;
  color: var(--fp-text-tertiary);
  font-variant-numeric: tabular-nums;
}
.fp-nav__status-dot {
  width: 8px;
  height: 8px;
  flex: none;
  border-radius: var(--fp-radius-pill);
  background: var(--fp-ok);
}
.fp-nav__status-dot[data-error="true"] {
  background: var(--fp-bad);
}
.fp-nav__status-text {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 业务线 / 项目行：灰阶面表示悬停与选中 */
.fp-line {
  min-width: 0;
}
.fp-line__head {
  display: flex;
  align-items: center;
  gap: 4px;
  min-width: 0;
  padding: 8px 12px 4px;
}
.fp-line__name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.03em;
  color: var(--fp-text-tertiary);
}
.fp-line__count {
  font-size: 10px;
  color: var(--fp-text-quaternary);
  font-variant-numeric: tabular-nums;
}
.fp-line__actions {
  display: flex;
  align-items: center;
  gap: 0;
  margin-left: auto;
  opacity: 0;
  transition: opacity 140ms ease;
}
.fp-line:hover .fp-line__actions,
.fp-line:focus-within .fp-line__actions {
  opacity: 1;
}
.fp-line__act {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  padding: 0;
  border: 0;
  border-radius: var(--fp-radius-sm);
  background: transparent;
  color: var(--fp-text-tertiary);
  cursor: pointer;
  transition: background-color 140ms ease, color 140ms ease;
}
.fp-line__act:hover {
  background: var(--fp-hover);
  color: var(--fp-text);
}
.fp-line__empty {
  margin: 0 12px 8px;
  font-size: var(--fp-font-xs);
  color: var(--fp-text-quaternary);
}
.fp-project {
  position: relative;
  display: flex;
  align-items: center;
  gap: var(--fp-sp-2);
  /* button 的 auto 宽度是 shrink-to-fit：长标题会把整行撑出侧栏，必须显式占满（减去左右外边距） */
  width: calc(100% - var(--fp-sp-3) * 2);
  min-width: 0;
  /* 卡片上下间距 8px */
  margin: 0 var(--fp-sp-3) var(--fp-sp-2);
  padding: var(--fp-sp-2);
  overflow: hidden;
  border: 0;
  border-radius: var(--fp-radius-md);
  background: transparent;
  color: var(--fp-text-dim);
  font: inherit;
  text-align: left;
  cursor: pointer;
  transition: background-color 140ms ease, box-shadow 140ms ease, color 140ms ease;
}
.fp-project:hover {
  background: var(--fp-hover);
  color: var(--fp-text);
}
.fp-project[data-active="true"] {
  background: var(--fp-surface-2);
  color: var(--fp-text);
  box-shadow: var(--fp-shadow-1);
}
.fp-project[data-archived="true"] {
  opacity: 0.72;
}
.fp-project__main {
  display: flex;
  flex-direction: column;
  gap: var(--fp-sp-1);
  flex: 1 1 0%;
  min-width: 0;
  overflow: hidden;
}
/* 与悬浮弹窗的 .fp-quick-row 排版保持一致：标题行 12px + 10px 等宽编号 chip */
.fp-project__head {
  display: flex;
  align-items: center;
  gap: var(--fp-sp-2);
  min-width: 0;
  overflow: hidden;
  font-size: var(--fp-font-sm);
}
.fp-project__code {
  flex: none;
  height: 16px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 0 4px;
  border: 0;
  border-radius: var(--fp-radius-sm);
  background: var(--fp-surface-2);
  color: var(--fp-text-dim);
  font-family: var(--fp-mono);
  font-size: 10px;
  letter-spacing: .03em;
  line-height: 16px;
  text-align: center;
}
.fp-project[data-active="true"] .fp-project__code {
  background: color-mix(in srgb, var(--fp-accent) 12%, transparent);
  color: var(--fp-accent);
}
.fp-project__title {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--fp-font-sm);
  font-weight: 500;
  line-height: 1.3;
  color: inherit;
}
.fp-project[data-active="true"] .fp-project__title {
  font-weight: 600;
}
/* 第二行：业务线 · 阶段 + 内联截止日（同悬浮弹窗 meta 行） */
.fp-project__sub {
  margin: 0;
  min-width: 0;
  flex: 1 1 auto;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--fp-font-xs);
  line-height: 1.3;
  color: var(--fp-text-tertiary);
}
.fp-project__meta {
  display: flex;
  align-items: center;
  gap: var(--fp-sp-2);
  min-width: 0;
  overflow: hidden;
  font-size: var(--fp-font-xs);
  color: var(--fp-text-tertiary);
}
.fp-project__dot {
  width: 8px;
  height: 8px;
  flex: none;
  border-radius: var(--fp-radius-pill);
}
.fp-project__dot[data-tone="brand"] {
  background: var(--fp-accent);
}
.fp-project__dot[data-tone="warn"] {
  background: var(--fp-warn);
}
.fp-project__dot[data-tone="error"] {
  background: var(--fp-bad);
}
.fp-project__due {
  flex: none;
  font-size: var(--fp-font-xs);
  font-weight: 500;
  color: var(--fp-warn-strong);
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
}
.fp-project__due[data-overdue="true"] {
  color: var(--fp-bad);
}
.fp-project__due[data-tone="today"] {
  color: var(--fp-warn-strong);
}
.fp-project__due[data-tone="soon"] {
  color: var(--fp-warn-strong);
}
/* 进度条绝对定位：不再作为 flex 子项占位（否则会挤压右侧截止日，且不再是整行宽度） */
.fp-project__progress {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  height: 3px;
  border-radius: 0 0 var(--fp-radius-md) var(--fp-radius-md);
  overflow: hidden;
  border-radius: var(--fp-radius-pill);
  background: var(--fp-surface-2);
  opacity: 1;
  transition: background-color 140ms ease;
}
.fp-project__progress > span {
  display: block;
  height: 100%;
  border-radius: var(--fp-radius-pill);
  background: color-mix(in srgb, var(--fp-accent) 72%, transparent);
}
.fp-archived {
  position: relative;
  margin: 8px 12px 0;
  padding-top: 8px;
}
.fp-archived::before {
  content: "";
  position: absolute;
  left: 0;
  right: 0;
  top: 0;
  height: 1px;
  background: var(--fp-border);
}
.fp-archived__toggle {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 8px;
  border: 0;
  border-radius: var(--fp-radius-md);
  background: transparent;
  color: var(--fp-text-tertiary);
  font: inherit;
  font-size: 11px;
  font-weight: 600;
  cursor: pointer;
  transition: background-color 140ms ease, color 140ms ease;
}
.fp-archived__toggle:hover {
  background: var(--fp-hover);
  color: var(--fp-text-dim);
}

/* 中栏 / 右栏：surface 卡片，子画布同步为 surface（内容组件自带 --fp-base 画布） */
.fp-main {
  /* 中栏本身透明：内部按「项目信息卡 + 项目节点卡」两张独立卡片排布 */
  position: relative;
  display: flex;
  flex-direction: column;
  flex: 1 1 auto;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
}
.fp-main__view {
  display: flex;
  flex-direction: column;
  flex: 1 1 auto;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
}
.fp-side {
  --fp-base: var(--fp-surface);
  position: relative;
  z-index: 18;
  display: flex;
  flex-direction: column;
  flex: 0 0 var(--fp-shell-side-w);
  width: var(--fp-shell-side-w);
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  background: var(--fp-surface);
  border-radius: var(--fp-radius-lg);
  /* 收起/展开：宽度走 expo-out 缓动（非线性），内容再做一次轻微位移淡入 */
  transition:
    flex-basis 320ms cubic-bezier(0.16, 1, 0.3, 1),
    width 320ms cubic-bezier(0.16, 1, 0.3, 1),
    box-shadow 200ms ease;
  will-change: flex-basis, width;
}
.fp-side__panel {
  display: flex;
  flex-direction: column;
  flex: 1 1 auto;
  min-width: 0;
  min-height: 0;
  animation: fp-side-panel-in 240ms cubic-bezier(0.16, 1, 0.3, 1);
}
.fp-side__rail-inner {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--fp-sp-2);
  width: 100%;
  height: 100%;
  padding: var(--fp-sp-2) 0;
  animation: fp-side-rail-in 260ms cubic-bezier(0.16, 1, 0.3, 1);
}
@keyframes fp-side-panel-in {
  from { opacity: 0; transform: translateX(12px); }
  to { opacity: 1; transform: none; }
}
@keyframes fp-side-rail-in {
  from { opacity: 0; transform: translateX(8px); }
  to { opacity: 1; transform: none; }
}
@media (prefers-reduced-motion: reduce) {
  .fp-side { transition: none; }
  .fp-side__panel, .fp-side__rail-inner { animation: none; }
}
.fp-side--overlay {
  position: absolute;
  right: 16px;
  top: 0;
  bottom: 16px;
  z-index: 26;
  box-shadow: var(--fp-shadow-3);
}
.fp-side--rail {
  flex: 0 0 44px;
  width: 44px;
  box-shadow: var(--fp-shadow-1);
}
.fp-side__rail-label {
  font-size: 10.5px;
  letter-spacing: 0.16em;
  color: var(--fp-text-tertiary);
  writing-mode: vertical-rl;
  user-select: none;
}
.fp-side__empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  flex: 1 1 auto;
  min-height: 0;
  padding: 24px;
  text-align: center;
}
.fp-side__empty-icon {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 40px;
  height: 40px;
  border-radius: var(--fp-radius-pill);
  background: var(--fp-surface-2);
  color: var(--fp-text-tertiary);
}
.fp-side__empty-title {
  margin: 0;
  font-size: var(--fp-font-md);
  font-weight: 600;
  color: var(--fp-text-dim);
}
.fp-side__empty-desc {
  margin: 0;
  max-width: 24em;
  font-size: var(--fp-font-sm);
  line-height: 1.65;
  color: var(--fp-text-tertiary);
}
.fp-scrim {
  position: absolute;
  inset: 0;
  z-index: 24;
  padding: 0;
  margin: 0;
  border: 0;
  background: var(--fp-mask);
  cursor: default;
}

/* ---------------- 引导 / 错误 / 骨架 ---------------- */
.fp-guide {
  display: flex;
  align-items: center;
  justify-content: center;
  flex: 1 1 auto;
  min-height: 0;
  overflow: auto;
  padding: 32px 24px;
}
.fp-guide__card {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 12px;
  width: 100%;
  max-width: 520px;
  padding: 24px;
  background: var(--fp-surface-2);
  border-radius: var(--fp-radius-lg);
}
.fp-guide__icon {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 48px;
  height: 48px;
  border-radius: var(--fp-radius-lg);
  background: color-mix(in srgb, var(--fp-accent) 12%, transparent);
  color: var(--fp-accent);
}
.fp-guide__title {
  margin: 0;
  font-size: 17px;
  font-weight: 650;
  letter-spacing: 0.005em;
  color: var(--fp-text);
}
.fp-guide__desc {
  margin: 0;
  font-size: var(--fp-font-sm);
  line-height: 1.75;
  color: var(--fp-text-dim);
}
.fp-guide__actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  margin-top: 4px;
}
.fp-guide__hint {
  width: 100%;
  margin: 0;
  padding-top: 4px;
  font-size: var(--fp-font-xs);
  line-height: 1.65;
  color: var(--fp-text-tertiary);
}
.fp-error {
  display: flex;
  align-items: center;
  justify-content: center;
  flex: 1 1 auto;
  min-height: 0;
  overflow: auto;
  padding: 32px 24px;
}
.fp-error__card {
  display: flex;
  flex-direction: column;
  gap: 8px;
  width: 100%;
  max-width: 480px;
  padding: 24px;
  background: color-mix(in srgb, var(--fp-bad) 6%, var(--fp-surface-2));
  border-radius: var(--fp-radius-lg);
}
.fp-error__icon {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 40px;
  height: 40px;
  border-radius: var(--fp-radius-pill);
  background: color-mix(in srgb, var(--fp-bad) 12%, transparent);
  color: var(--fp-bad);
}
.fp-error__title {
  margin: 0;
  font-size: 16px;
  font-weight: 650;
  color: var(--fp-text);
}
.fp-error__text {
  margin: 0;
  font-size: var(--fp-font-sm);
  line-height: 1.7;
  color: var(--fp-text-dim);
  overflow-wrap: anywhere;
}
.fp-error__list {
  margin: 0;
  padding-left: 16px;
  font-size: var(--fp-font-xs);
  line-height: 1.8;
  color: var(--fp-text-tertiary);
}
.fp-error__actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  margin-top: 4px;
}
.fp-skel {
  display: flex;
  flex: 1 1 auto;
  gap: 12px;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
}
.fp-skel__nav {
  display: flex;
  flex-direction: column;
  gap: 8px;
  flex: 0 0 var(--fp-shell-nav-w);
  width: var(--fp-shell-nav-w);
  padding: 8px 4px;
}
.fp-skel__main {
  display: flex;
  flex-direction: column;
  gap: 12px;
  flex: 1 1 auto;
  min-width: 0;
  padding: 16px;
  background: var(--fp-surface);
  border-radius: var(--fp-radius-lg);
}
.fp-skel__side {
  display: flex;
  flex-direction: column;
  gap: 12px;
  flex: 0 0 var(--fp-shell-side-w);
  width: var(--fp-shell-side-w);
  padding: 16px;
  background: var(--fp-surface);
  border-radius: var(--fp-radius-lg);
}
.fp-skel-block {
  border-radius: var(--fp-radius-md);
  background: var(--fp-surface-2);
  animation: fp-skel-pulse 1500ms ease-in-out infinite;
}
.fp-skel__nav .fp-skel-block {
  background: var(--fp-surface);
}
@keyframes fp-skel-pulse {
  0%, 100% { opacity: 0.55; }
  50% { opacity: 1; }
}
.fp-icon--flip {
  transform: rotate(180deg);
}

/* ---------------- 响应式：保持 <980 折右栏 / <720 左栏抽屉 ---------------- */
@media (max-width: 1180px) {
  .fp-view__label {
    display: none;
  }
  .fp-view-btn {
    padding: 0 8px;
  }
}
@media (max-width: 1080px) {
  .fp-brand__sub {
    display: none;
  }
  .fp-rhythm__body {
    display: none;
  }
}
@media (max-width: 960px) {
  .fp-rhythm {
    max-width: 240px;
  }
  .fp-skel__side {
    display: none;
  }
}
@media (max-width: 880px) {
  .fp-rhythm {
    display: none;
  }
  .fp-summ__label {
    display: none;
  }
  .fp-root {
    --fp-shell-nav-w: 240px;
  }
}
@media (max-width: 720px) {
  .fp-brand__text {
    display: none;
  }
  .fp-nav {
    display: none;
  }
  .fp-nav[data-drawer="true"] {
    display: flex;
  }
  .fp-clock__day {
    display: none;
  }
  .fp-skel__nav {
    display: none;
  }
  .fp-summ {
    display: none;
  }
}
@media (max-width: 600px) {
  .fp-topbar {
    gap: 4px;
    padding: 0 12px;
  }
  .fp-views {
    gap: 0;
  }
  .fp-view-btn {
    padding: 0 8px;
  }
}
@media (hover: none) {
  .fp-line__actions {
    opacity: 1;
  }
}
@media (prefers-reduced-motion: reduce) {
  .fp-skel-block {
    animation: none;
  }
  .fp-view-btn,
  .fp-summ,
  .fp-project,
  .fp-rhythm__close,
  .fp-project__progress,
  .fp-line__act,
  .fp-archived__toggle {
    transition: none;
  }
}

/* ---- 右键菜单（无描边，面层级 + 阴影） ---- */
.fp-ctxmenu {
  position: fixed;
  z-index: 90;
  min-width: 192px;
  padding: var(--fp-sp-1);
  background: var(--fp-overlay);
  border-radius: var(--fp-radius-md);
  box-shadow: var(--fp-shadow-3);
}
.fp-ctxmenu__item {
  display: flex;
  align-items: center;
  width: 100%;
  min-height: 32px;
  padding: 0 var(--fp-sp-3);
  border: none;
  border-radius: var(--fp-radius-sm);
  background: transparent;
  color: var(--fp-text);
  font: inherit;
  font-size: var(--fp-font-sm);
  text-align: left;
  cursor: pointer;
}
.fp-ctxmenu__item:hover {
  background: var(--fp-hover);
}
.fp-ctxmenu__item--danger {
  color: var(--fp-bad);
}
.fp-ctxmenu__item--danger:hover {
  background: color-mix(in srgb, var(--fp-bad) 12%, transparent);
}
.fp-ctxmenu__sep {
  height: 1px;
  background: var(--fp-border);
  margin: var(--fp-sp-1) 0;
}

/* ---- 右栏：收起按钮整合到边栏顶部（与收起态 rail 的展开按钮同一位置） ---- */
.fp-side__bar {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  flex: none;
  padding: var(--fp-sp-1) var(--fp-sp-2) 0;
}

/* ---- 设置弹窗（居中浮层） ---- */
.fp-modal-layer {
  position: fixed;
  inset: 0;
  z-index: 70;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: var(--fp-sp-6) var(--fp-sp-4);
  background: var(--fp-mask);
  animation: fp-modal-in 160ms ease;
}
.fp-modal {
  display: flex;
  flex-direction: column;
  width: min(880px, 100%);
  max-height: min(860px, 88vh);
  min-height: 0;
  overflow: hidden;
  border-radius: var(--fp-radius-lg);
  background: var(--fp-surface);
  box-shadow: var(--fp-shadow-3);
}
.fp-modal__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--fp-sp-2);
  flex: none;
  padding: var(--fp-sp-3) var(--fp-sp-3) var(--fp-sp-2) var(--fp-sp-5);
}
.fp-modal__title {
  font-size: var(--fp-font-lg);
  font-weight: 650;
  color: var(--fp-text);
}
.fp-modal__body {
  flex: 1 1 auto;
  min-height: 0;
  overflow: auto;
  padding: 0 var(--fp-sp-3) var(--fp-sp-4) var(--fp-sp-3);
}
@keyframes fp-modal-in {
  from { opacity: 0; transform: translateY(6px); }
  to { opacity: 1; transform: none; }
}

/* ---- 窄屏顶栏：隐藏文字标签与次要信息，只留 icon，避免溢出 ---- */
@media (max-width: 1180px) {
  .fp-view__label { display: none; }
  .fp-view-btn { padding: 0 var(--fp-sp-2); }
  .fp-brand__sub { display: none; }
}
@media (max-width: 1024px) {
  .fp-clock { display: none; }
  .fp-topbar { gap: var(--fp-sp-1); padding: 0 var(--fp-sp-3); }
}
@media (max-width: 900px) {
  .fp-summary { display: none; }
  .fp-rhythm { display: none; }
}

/* ---- 顶栏「⋯」：窄宽度把同步 / 设置 / 节奏 / 汇总 / 时间全部收进来 ---- */
.fp-topmore-wrap {
  display: inline-flex;
  flex: none;
}
.fp-topmore {
  padding: var(--fp-sp-1);
}
.fp-topmore__info {
  display: flex;
  flex-direction: column;
  gap: var(--fp-sp-1);
  padding: var(--fp-sp-2);
  border-radius: var(--fp-radius-sm);
}
.fp-topmore__label {
  font-size: 10.5px;
  font-weight: 600;
  letter-spacing: 0.02em;
  color: var(--fp-text-tertiary);
}
.fp-topmore__value {
  font-size: var(--fp-font-sm);
  color: var(--fp-text);
}
.fp-topmore__hint {
  font-size: 10.5px;
  line-height: 1.45;
  color: var(--fp-text-tertiary);
}
.fp-topmore__stats {
  display: flex;
  flex-wrap: wrap;
  gap: var(--fp-sp-1);
}
.fp-topmore__stat {
  display: inline-flex;
  align-items: center;
  height: 22px;
  padding: 0 var(--fp-sp-1);
  border-radius: var(--fp-radius-pill);
  background: var(--fp-surface-2);
  font-size: 10.5px;
  color: var(--fp-text-dim);
  font-variant-numeric: tabular-nums;
}
.fp-topmore__stat--error {
  background: color-mix(in srgb, var(--fp-bad) 12%, transparent);
  color: var(--fp-bad);
}
`;

/* ------------------------------------------------------------------ *
 * 外壳内部常量 / 小工具（仅本文件使用）
 * ------------------------------------------------------------------ */

const FP_SHELL_VIEW_IDS = ['flow', 'today', 'weekly', 'handoff'];
const FP_SHELL_PREFS_KEY = 'flowpilot.shell.prefs.v1';
const FP_SHELL_DIALOG_EMPTY = { kind: null, line: null, node: null, flow: null, mode: null, lineId: null };
const FP_SHELL_WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

function fpShellReadPrefs() {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return null;
    const raw = window.localStorage.getItem(FP_SHELL_PREFS_KEY);
    if (typeof raw !== 'string' || raw === '') return null;
    const parsed = JSON.parse(raw);
    return parsed !== null && typeof parsed === 'object' ? parsed : null;
  } catch (error) {
    return null;
  }
}

function fpShellWritePrefs(prefs) {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return;
    window.localStorage.setItem(FP_SHELL_PREFS_KEY, JSON.stringify(prefs || {}));
  } catch (error) {
    /* 隐私模式/配额满时静默降级为不记忆 */
  }
}

function fpShellPad2(value) {
  return value < 10 ? '0' + value : String(value);
}

function fpShellHHMM(date) {
  const d = fpParseDate(date) || new Date();
  return fpShellPad2(d.getHours()) + ':' + fpShellPad2(d.getMinutes());
}

function fpShellWeekday(date) {
  const d = fpParseDate(date) || new Date();
  return FP_SHELL_WEEKDAYS[d.getDay()] || '';
}

function fpShellNowDate(now) {
  return fpParseDate(now) || new Date();
}

function fpShellIsEditable(target) {
  if (!target || typeof target !== 'object') return false;
  const tag = typeof target.tagName === 'string' ? target.tagName.toLowerCase() : '';
  if (tag === 'input' || tag === 'textarea' || tag === 'select') return true;
  return target.isContentEditable === true;
}

function fpShellErrorText(error) {
  if (error === null || error === undefined) return '';
  if (typeof error === 'string') return error;
  if (typeof error === 'object' && typeof error.message === 'string' && error.message !== '') return error.message;
  try {
    return String(error);
  } catch (cause) {
    return '未知错误';
  }
}

function fpShellMenuGlyph() {
  return h(
    'svg',
    {
      width: 15,
      height: 15,
      viewBox: '0 0 16 16',
      fill: 'none',
      stroke: 'currentColor',
      strokeWidth: 1.5,
      strokeLinecap: 'round',
      'aria-hidden': 'true',
      focusable: 'false',
      style: { display: 'block' },
    },
    [h('path', { key: 'l1', d: 'M2.5 4.4h11' }), h('path', { key: 'l2', d: 'M2.5 8h11' }), h('path', { key: 'l3', d: 'M2.5 11.6h11' })],
  );
}

/** 视口宽度：只在浏览器里监听 resize；SSR/测试环境给一个安全默认值。 */
function fpShellUseViewportWidth() {
  const [width, setWidth] = useState(function () {
    if (typeof window === 'undefined' || typeof window.innerWidth !== 'number') return 1280;
    return window.innerWidth;
  });
  useEffect(function () {
    if (typeof window === 'undefined') return undefined;
    const onResize = function () {
      if (typeof window.innerWidth === 'number') setWidth(window.innerWidth);
    };
    window.addEventListener('resize', onResize);
    return function () {
      window.removeEventListener('resize', onResize);
    };
  }, []);
  return width;
}

function fpShellGuideCard(options) {
  const opts = options || {};
  return h(
    'div',
    { className: 'fp-guide' },
    h(
      'div',
      { className: 'fp-guide__card' },
      h('div', { className: 'fp-guide__icon' }, opts.icon === undefined || opts.icon === null ? h(FpIcon, { name: 'flow', size: 22 }) : opts.icon),
      opts.title !== undefined && opts.title !== null ? h('h2', { className: 'fp-guide__title' }, opts.title) : null,
      opts.description !== undefined && opts.description !== null
        ? h('p', { className: 'fp-guide__desc' }, opts.description)
        : null,
      opts.actions !== undefined && opts.actions !== null
        ? h('div', { className: 'fp-guide__actions' }, opts.actions)
        : null,
      opts.hint !== undefined && opts.hint !== null ? h('p', { className: 'fp-guide__hint' }, opts.hint) : null,
    ),
  );
}

function fpShellSkeleton() {
  const block = function (key, height, width) {
    return h('div', { key: key, className: 'fp-skel-block', style: { height: height + 'px', width: width } });
  };
  return h(
    'div',
    { className: 'fp-skel', 'aria-busy': 'true', 'aria-label': '正在载入 FlowPilot' },
    h('div', { className: 'fp-skel__nav' }, [
      block('n1', 11, '52%'),
      block('n2', 30, '100%'),
      block('n3', 30, '100%'),
      block('n4', 30, '92%'),
      block('n5', 18, '100%'),
      block('n6', 11, '44%'),
      block('n7', 30, '100%'),
      block('n8', 30, '86%'),
    ]),
    h('div', { className: 'fp-skel__main' }, [
      block('m1', 22, '38%'),
      block('m2', 13, '62%'),
      block('m3', 14, '100%'),
      block('m4', 66, '100%'),
      block('m5', 66, '100%'),
      block('m6', 66, '84%'),
    ]),
    h('div', { className: 'fp-skel__side' }, [
      block('s1', 14, '70%'),
      block('s2', 20, '92%'),
      block('s3', 13, '60%'),
      block('s4', 14, '100%'),
      block('s5', 40, '100%'),
      block('s6', 40, '100%'),
      block('s7', 40, '82%'),
    ]),
  );
}

/* ------------------------------------------------------------------ *
 * FpRoot —— main 面板根组件
 * ------------------------------------------------------------------ */

function FpRoot() {
  const snapshot = useFp();
  const status = snapshot !== null && typeof snapshot === 'object' && typeof snapshot.status === 'string' ? snapshot.status : 'loading';
  const revision = snapshot !== null && typeof snapshot === 'object' && typeof snapshot.revision === 'number' ? snapshot.revision : 0;
  const state = snapshot !== null && typeof snapshot === 'object' ? snapshot.state || null : null;
  const derived = snapshot !== null && typeof snapshot === 'object' ? snapshot.derived || null : null;
  const error = snapshot !== null && typeof snapshot === 'object' ? snapshot.error : null;

  const now = useNow(30000);
  const nowDate = fpShellNowDate(now);
  const width = fpShellUseViewportWidth();
  const narrow = width < 720;
  const mid = width < 980;
  /* 顶栏：宽度不够时把「同步 / 设置 / 节奏 / 汇总 / 时钟」全部收进一个「⋯」入口 */
  const topbarTight = width < 1120;
  const brandCompact = width < 860;

  const prefsRef = useRef(null);
  if (prefsRef.current === null) prefsRef.current = fpShellReadPrefs() || {};
  const prefs = prefsRef.current !== null && typeof prefsRef.current === 'object' ? prefsRef.current : {};

  const [view, setView] = useState(function () {
    return FP_SHELL_VIEW_IDS.indexOf(prefs.view) !== -1 ? prefs.view : 'flow';
  });
  const [selectedProjectId, setSelectedProjectId] = useState(function () {
    return typeof prefs.projectId === 'string' && prefs.projectId !== '' ? prefs.projectId : null;
  });
  const [selectedNodeId, setSelectedNodeId] = useState(null);
  const [detailCollapsed, setDetailCollapsed] = useState(function () {
    if (typeof window !== 'undefined' && typeof window.innerWidth === 'number' && window.innerWidth < 980) return true;
    return prefs.detailCollapsed === true;
  });
  const [navOpen, setNavOpen] = useState(false);
  const [archivedOpen, setArchivedOpen] = useState(false);
  const [dialog, setDialog] = useState(FP_SHELL_DIALOG_EMPTY);
  const [aiOpen, setAiOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(prefs.view === 'settings');
  const [syncBusy, setSyncBusy] = useState(false);
  const [syncAt, setSyncAt] = useState(null);
  const [moreOpen, setMoreOpen] = useState(false);
  const [moreAnchor, setMoreAnchor] = useState(null);
  const [ctxMenu, setCtxMenu] = useState(null);
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [seedBusy, setSeedBusy] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [rhythmDismissedKey, setRhythmDismissedKey] = useState(null);

  const lastDefaultProjectRef = useRef(null);
  const ctxMenuRef = useRef(null);
  const prevSelectedNodeRef = useRef(null);
  const prevMidRef = useRef(mid);
  const syncBusyRef = useRef(false);
  const moreMenuRef = useRef(null);

  const hasData = status === 'ready' && state !== null;

  /* ---------------- 数据切片（只读，全部来自 state/derived） ---------------- */
  const s = state;
  const d = derived !== null && typeof derived === 'object' ? derived : {};
  const counts = d.counts !== null && typeof d.counts === 'object' ? d.counts : {};
  const focus = d.focus !== null && typeof d.focus === 'object' ? d.focus : null;
  const todayKey = typeof d.today === 'string' ? d.today : '';
  const projectInfo = d.projects !== null && typeof d.projects === 'object' ? d.projects : {};
  const lines = s !== null && Array.isArray(s.businessLines) ? s.businessLines : [];
  const projects = s !== null && Array.isArray(s.projects) ? s.projects : [];
  const selectedProject = s !== null && selectedProjectId !== null ? fpProjectById(s, selectedProjectId) || null : null;
  const selectedNode = s !== null && selectedNodeId !== null ? fpNodeById(s, selectedNodeId) || null : null;
  const detailProject =
    selectedNode !== null && typeof selectedNode.projectId === 'string'
      ? fpProjectById(s, selectedNode.projectId) || selectedProject
      : selectedProject;
  const activeProjects = projects.filter(function (project) {
    return project !== null && typeof project === 'object' && project.status !== 'archived';
  });
  const archivedProjects = projects.filter(function (project) {
    return project !== null && typeof project === 'object' && project.status === 'archived';
  });
  const linesSorted = lines
    .filter(function (line) {
      return line !== null && typeof line === 'object' && typeof line.id === 'string';
    })
    .slice()
    .sort(function (a, b) {
      return (Number(a.sortOrder) || 0) - (Number(b.sortOrder) || 0);
    });
  const countsActionable = typeof counts.actionable === 'number' ? counts.actionable : 0;
  const countsWaiting = typeof counts.waiting === 'number' ? counts.waiting : 0;
  const countsBlocked = typeof counts.blocked === 'number' ? counts.blocked : 0;
  const countsOverdue = typeof counts.overdue === 'number' ? counts.overdue : 0;
  const followCount = countsWaiting + countsBlocked;

  /* 顶栏「⋯」菜单：点击别处 / Esc / 滚动 / 尺寸变化时关闭 */
  useEffect(
    function () {
      if (!moreOpen) return undefined;
      const close = function () {
        setMoreOpen(false);
      };
      const onPointer = function (event) {
        const node = moreMenuRef.current;
        if (node !== null && node !== undefined && typeof node.contains === 'function' && event && event.target && node.contains(event.target)) return;
        close();
      };
      const onKey = function (event) {
        if (event && event.key === 'Escape') close();
      };
      document.addEventListener('mousedown', onPointer, true);
      document.addEventListener('keydown', onKey, true);
      window.addEventListener('resize', close);
      window.addEventListener('scroll', close, true);
      return function () {
        document.removeEventListener('mousedown', onPointer, true);
        document.removeEventListener('keydown', onKey, true);
        window.removeEventListener('resize', close);
        window.removeEventListener('scroll', close, true);
      };
    },
    [moreOpen],
  );

  /* ---------------- 自动同步（默认 5 分钟，可在设置里改） ---------------- */
  const syncIntervalMinutes = (function () {
    const raw = s !== null && s.settings !== null && typeof s.settings === 'object' ? Number(s.settings.syncIntervalMinutes) : NaN;
    if (!Number.isFinite(raw)) return 5;
    return Math.max(1, Math.min(60, Math.round(raw)));
  })();
  useEffect(
    function () {
      if (typeof setInterval !== 'function') return undefined;
      const timer = setInterval(
        function () {
          if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
          handleSyncNow(true);
        },
        syncIntervalMinutes * 60000,
      );
      return function () {
        if (typeof clearInterval === 'function') clearInterval(timer);
      };
    },
    [syncIntervalMinutes],
  );

  /* ---------------- 视图偏好持久化 ---------------- */
  useEffect(
    function () {
      fpShellWritePrefs({ view: view, projectId: selectedProjectId, detailCollapsed: detailCollapsed });
    },
    [view, selectedProjectId, detailCollapsed],
  );

  /* ---------------- 选中项校正（数据刷新后仍成立） ---------------- */
  useEffect(
    function () {
      if (s === null) return;
      if (selectedProjectId !== null && fpProjectById(s, selectedProjectId)) return;
      const active = fpActiveProjects(s);
      const fallback = active.length > 0 ? active[0] : Array.isArray(s.projects) && s.projects.length > 0 ? s.projects[0] : null;
      setSelectedProjectId(fallback !== null && typeof fallback === 'object' && typeof fallback.id === 'string' ? fallback.id : null);
      setSelectedNodeId(null);
      lastDefaultProjectRef.current = null;
    },
    [s, selectedProjectId],
  );

  useEffect(
    function () {
      if (s === null || selectedProjectId === null) return;
      if (lastDefaultProjectRef.current === selectedProjectId) return;
      lastDefaultProjectRef.current = selectedProjectId;
      const info = projectInfo[selectedProjectId] !== null && typeof projectInfo[selectedProjectId] === 'object' ? projectInfo[selectedProjectId] : null;
      const activeNodeId = info !== null && typeof info.activeNodeId === 'string' && info.activeNodeId !== '' ? info.activeNodeId : null;
      if (activeNodeId === null) return;
      setSelectedNodeId(function (previous) {
        if (typeof previous === 'string' && previous !== '' && fpNodeById(s, previous)) return previous;
        return activeNodeId;
      });
    },
    [s, selectedProjectId, projectInfo],
  );

  useEffect(
    function () {
      if (s === null || selectedNodeId === null) return;
      if (!fpNodeById(s, selectedNodeId)) setSelectedNodeId(null);
    },
    [s, selectedNodeId],
  );

  /* 从宽到窄时自动折叠右栏（<980px），避免窄屏被详情挤占。 */
  useEffect(
    function () {
      if (mid && !prevMidRef.current) setDetailCollapsed(true);
      prevMidRef.current = mid;
    },
    [mid],
  );

  /* ---------------- 弹窗控制 ---------------- */
  function openDialog(patch) {
    setDialog(Object.assign({}, FP_SHELL_DIALOG_EMPTY, patch || {}));
  }

  function closeDialog() {
    setDialog(FP_SHELL_DIALOG_EMPTY);
  }

  function openCreateLine() {
    openDialog({ kind: 'lineEdit', line: null });
  }

  function openLineEdit(line) {
    openDialog({ kind: 'lineEdit', line: line || null });
  }

  function openProjectCreate(lineId) {
    const fallback =
      lineId ||
      (selectedProject !== null && typeof selectedProject.businessLineId === 'string' ? selectedProject.businessLineId : null) ||
      (linesSorted.length > 0 ? linesSorted[0].id : null);
    openDialog({ kind: 'projectCreate', lineId: fallback });
  }

  /* ---------------- 数据动作 ---------------- */
  /* 主动同步（云端 ↔ 本地，最新覆盖旧的，且每次都上传）；silent=true 用于自动同步 */
  function handleSyncNow(silent) {
    if (syncBusyRef.current) return;
    syncBusyRef.current = true;
    setSyncBusy(true);
    const task = typeof fpSyncNow === 'function' ? fpSyncNow() : Promise.resolve(null);
    Promise.resolve(task)
      .then(function (result) {
        syncBusyRef.current = false;
        setSyncBusy(false);
        if (!result) return;
        if (result.ok !== true) {
          if (silent !== true) FpToast.push({ tone: 'error', text: result.error || '同步失败' });
          return;
        }
        setSyncAt(Date.now());
        if (silent === true) return;
        const info = result.result !== null && typeof result.result === 'object' ? result.result : {};
        const direction = info.direction;
        let text = '同步完成：本地与云端已一致，已上传';
        if (direction === 'merge') {
          const merged = info.merged !== null && typeof info.merged === 'object' ? info.merged : null;
          const sumOf = function (map) {
            if (map === null || typeof map !== 'object') return 0;
            return Object.keys(map).reduce(function (total, key) {
              const value = Number(map[key]);
              return total + (Number.isFinite(value) ? value : 0);
            }, 0);
          };
          const parts = [];
          if (merged !== null) {
            const added = sumOf(merged.added);
            const updated = sumOf(merged.updated);
            const deleted = sumOf(merged.deleted);
            const conflicts = Array.isArray(merged.conflicts) ? merged.conflicts.length : 0;
            if (added > 0) parts.push('新增 ' + added);
            if (updated > 0) parts.push('更新 ' + updated);
            if (deleted > 0) parts.push('删除 ' + deleted);
            if (conflicts > 0) parts.push('冲突 ' + conflicts + ' 处按最新时间解决');
          }
          const pending = Array.isArray(info.conflictDetails) ? info.conflictDetails.length : 0;
          text =
            '已三方合并' +
            (parts.length > 0 ? '：' + parts.join('、') : '') +
            (merged !== null && merged.baseMissing === true ? '（首次合并，无历史基准）' : '') +
            (pending > 0 ? '，有待审阅冲突 ' + pending + ' 条' : '');
        } else if (direction === 'pull') {
          text = '同步完成：云端较新，已拉取';
        } else if (direction === 'push') {
          text = '同步完成：本地较新，已上传云端';
        }
        FpToast.push({ tone: 'success', text: text });
        try {
          fpRefresh();
        } catch (error) {
          /* 刷新失败不覆盖同步结果 */
        }
      })
      .catch(function (error) {
        syncBusyRef.current = false;
        setSyncBusy(false);
        if (silent !== true) {
          FpToast.push({ tone: 'error', text: error && error.message ? error.message : '同步失败' });
        }
      });
  }

  function handleRefresh() {
    if (refreshing) return;
    setRefreshing(true);
    let task = null;
    try {
      task = fpRefresh();
    } catch (cause) {
      task = Promise.reject(cause);
    }
    Promise.resolve(task).then(
      function () {
        setRefreshing(false);
      },
      function () {
        setRefreshing(false);
      },
    );
  }

  function handleSeedDemo() {
    if (seedBusy) return;
    setSeedBusy(true);
    let task = null;
    try {
      task = fpDispatch('seedDemo', {});
    } catch (cause) {
      task = Promise.reject(cause);
    }
    Promise.resolve(task).then(
      function (result) {
        setSeedBusy(false);
        if (!result || result.ok !== true) {
          FpToast.push({ tone: 'error', text: (result && result.error) || '载入示例数据失败' });
          return;
        }
        FpToast.push({ tone: 'success', text: '示例数据已载入' });
      },
      function (cause) {
        setSeedBusy(false);
        FpToast.push({ tone: 'error', text: '载入示例数据失败：' + fpShellErrorText(cause) });
      },
    );
  }

  function handleDismissRhythm() {
    if (focus === null) return;
    const key = (todayKey || '') + ':' + (typeof focus.period === 'string' ? focus.period : '');
    setRhythmDismissedKey(key);
    let task = null;
    try {
      task = fpDispatch('dismissRhythm', { key: key });
    } catch (cause) {
      task = Promise.reject(cause);
    }
    Promise.resolve(task).then(
      function (result) {
        if (!result || result.ok !== true) setRhythmDismissedKey(null);
      },
      function () {
        setRhythmDismissedKey(null);
      },
    );
  }

  function handleAddFlow(projectId) {
    const id = typeof projectId === 'string' && projectId !== '' ? projectId : selectedProjectId;
    if (s === null || id === null) return;
    const existing = fpProjectFlows(s, id).map(function (flow) {
      return flow.templateId;
    });
    if (existing.indexOf('acceptance') !== -1) {
      FpToast.push({ tone: 'info', text: '这个项目已经有验收流程了' });
      return;
    }
    let task = null;
    try {
      task = fpDispatch('addFlow', { projectId: id, templateId: 'acceptance' });
    } catch (cause) {
      task = Promise.reject(cause);
    }
    Promise.resolve(task).then(
      function (result) {
        if (!result || result.ok !== true) {
          FpToast.push({ tone: 'error', text: (result && result.error) || '添加流程失败' });
          return;
        }
        FpToast.push({ tone: 'success', text: '已添加验收流程' });
      },
      function (cause) {
        FpToast.push({ tone: 'error', text: '添加流程失败：' + fpShellErrorText(cause) });
      },
    );
  }

  function handleProjectCreated(result) {
    closeDialog();
    const created = result !== null && typeof result === 'object' ? result : {};
    let id = null;
    if (typeof created.projectId === 'string') id = created.projectId;
    else if (created.project !== null && typeof created.project === 'object' && typeof created.project.id === 'string') id = created.project.id;
    else if (typeof created.id === 'string') id = created.id;
    if (id === null) return;
    lastDefaultProjectRef.current = null;
    setSelectedProjectId(id);
    setSelectedNodeId(null);
    setView('flow');
  }

  /* AI 从 PRD 生成项目：先刷新宿主数据再选中新项目，
     否则新 id 还不存在于旧 state，会被“失效选中自动校正”清掉。 */
  async function handleAiApplied(projectId) {
    setAiOpen(false);
    if (typeof fpRefresh === 'function') {
      try {
        await fpRefresh();
      } catch (error) {
        // 刷新失败也继续尝试选中：宿主大概率已经落库
      }
    }
    if (typeof projectId === 'string' && projectId !== '') {
      lastDefaultProjectRef.current = null;
      setSelectedProjectId(projectId);
      setSelectedNodeId(null);
      setView('flow');
    }
  }

  /* ---------------- 完成当前节点后自动跳到下一个节点 ---------------- */
  useEffect(
    function () {
      const previous = prevSelectedNodeRef.current;
      if (!hasData || selectedNode === null || selectedNode === undefined) {
        prevSelectedNodeRef.current = null;
        return;
      }
      prevSelectedNodeRef.current = { id: selectedNode.id, status: selectedNode.status };
      if (previous === null || previous.id !== selectedNode.id || previous.status === selectedNode.status) return;
      const finished = selectedNode.status === 'completed' || selectedNode.status === 'skipped';
      if (!finished) return;
      const next = fpNextNode(s, selectedNode);
      if (next === null || next === undefined || next.id === selectedNode.id) return;
      setSelectedNodeId(next.id);
      setDetailCollapsed(false);
      // 把下一张节点卡滚到可视区中间（仅限本插件面板内的元素）
      if (typeof document === 'undefined') return;
      const root = document.querySelector('.fp-root');
      const target = root !== null && typeof root.querySelector === 'function'
        ? root.querySelector('[data-node-id="' + next.id + '"]')
        : null;
      if (target === null || typeof target.scrollIntoView !== 'function') return;
      try {
        target.scrollIntoView({ block: 'center', behavior: 'smooth' });
      } catch (error) {
        target.scrollIntoView();
      }
    },
    [hasData, s, selectedNode === null ? null : selectedNode.id, selectedNode === null ? null : selectedNode.status],
  );

  /* ---------------- 项目右键菜单 / 归档 / 删除 ---------------- */
  const menuOpen = ctxMenu !== null && typeof ctxMenu === 'object' && typeof ctxMenu.projectId === 'string';

  function openProjectMenu(projectId, clientX, clientY) {
    if (typeof projectId !== 'string' || projectId === '') return;
    const width = 208;
    const height = 176;
    const vw = typeof window !== 'undefined' && typeof window.innerWidth === 'number' ? window.innerWidth : 1440;
    const vh = typeof window !== 'undefined' && typeof window.innerHeight === 'number' ? window.innerHeight : 900;
    const rawX = typeof clientX === 'number' && isFinite(clientX) ? clientX : 0;
    const rawY = typeof clientY === 'number' && isFinite(clientY) ? clientY : 0;
    setCtxMenu({
      projectId: projectId,
      x: Math.max(8, Math.min(rawX, vw - width - 8)),
      y: Math.max(8, Math.min(rawY, vh - height - 8)),
    });
  }

  function closeProjectMenu() {
    setCtxMenu(null);
  }

  function menuProject() {
    if (!menuOpen || s === null) return null;
    return fpProjectById(s, ctxMenu.projectId) || null;
  }

  useEffect(
    function () {
      if (!menuOpen) return undefined;
      const onPointerDown = function (event) {
        const node = ctxMenuRef.current;
        if (node && typeof node.contains === 'function' && event && event.target && node.contains(event.target)) return;
        setCtxMenu(null);
      };
      const onKeyDown = function (event) {
        if (event && (event.key === 'Escape' || event.key === 'Esc')) setCtxMenu(null);
      };
      const onViewportChange = function () {
        setCtxMenu(null);
      };
      document.addEventListener('mousedown', onPointerDown, true);
      document.addEventListener('keydown', onKeyDown, true);
      window.addEventListener('scroll', onViewportChange, true);
      window.addEventListener('resize', onViewportChange);
      return function () {
        document.removeEventListener('mousedown', onPointerDown, true);
        document.removeEventListener('keydown', onKeyDown, true);
        window.removeEventListener('scroll', onViewportChange, true);
        window.removeEventListener('resize', onViewportChange);
      };
    },
    [menuOpen],
  );

  async function handleArchiveToggle(project) {
    closeProjectMenu();
    if (!project) return;
    const archived = project.status !== 'archived';
    const result = await fpDispatch('archiveProject', { projectId: project.id, archived: archived });
    if (!result || result.ok !== true) {
      FpToast.push({ tone: 'error', text: (result && result.error) || '操作失败' });
      return;
    }
    await fpRefresh();
    FpToast.push({
      tone: 'success',
      text: (archived ? '已归档「' : '已恢复「') + (project.title || '项目') + '」',
    });
  }

  async function confirmDeleteProject() {
    const id = deleteTarget;
    setDeleteTarget(null);
    if (typeof id !== 'string' || id === '') return;
    const target = s !== null ? fpProjectById(s, id) : null;
    const result = await fpDispatch('deleteProject', { projectId: id, confirm: 'DELETE' });
    if (!result || result.ok !== true) {
      const message = (result && result.error) || '删除项目失败';
      // 宿主还是旧版本时会返回「未知动作：deleteProject」——直接告诉用户怎么启用
      const needsRestart = typeof message === 'string' && message.indexOf('未知动作') !== -1;
      FpToast.push({
        tone: 'error',
        text: needsRestart ? '删除项目需要重启 DSH 后生效（当前宿主是旧版本）' : message,
      });
      return;
    }
    if (selectedProjectId === id) {
      setSelectedProjectId(null);
      setSelectedNodeId(null);
    }
    await fpRefresh();
    FpToast.push({ tone: 'success', text: '已删除项目「' + ((target && target.title) || '') + '」' });
  }

  /* ---------------- 选择 ---------------- */
  function handleSelectProject(projectId) {
    if (typeof projectId !== 'string' || projectId === '') return;
    setSelectedProjectId(projectId);
    const info = projectInfo[projectId] !== null && typeof projectInfo[projectId] === 'object' ? projectInfo[projectId] : null;
    setSelectedNodeId(info !== null && typeof info.activeNodeId === 'string' && info.activeNodeId !== '' ? info.activeNodeId : null);
    setView('flow');
    if (narrow) setNavOpen(false);
  }

  function handleOpenProject(projectId) {
    handleSelectProject(projectId);
  }

  function handleSelectNode(nodeId) {
    if (s === null || typeof nodeId !== 'string' || nodeId === '') {
      setSelectedNodeId(null);
      return;
    }
    const node = fpNodeById(s, nodeId) || null;
    if (node === null) {
      setSelectedNodeId(null);
      return;
    }
    setSelectedNodeId(node.id);
    if (typeof node.projectId === 'string' && node.projectId !== selectedProjectId) setSelectedProjectId(node.projectId);
    setDetailCollapsed(false);
  }

  function handleCloseDetail() {
    setSelectedNodeId(null);
    if (mid) setDetailCollapsed(true);
  }

  function handleToggleDetail() {
    setDetailCollapsed(function (previous) {
      return !previous;
    });
  }

  function handleCollapseDetail(value) {
    setDetailCollapsed(typeof value === 'boolean' ? value : true);
  }

  function handleCreateProjectFromFlow() {
    openProjectCreate(null);
  }

  function handleNodeDialogRequest(kind, payload) {
    const request = payload !== null && typeof payload === 'object' ? payload : {};
    const node =
      (typeof request.nodeId === 'string' && s !== null ? fpNodeById(s, request.nodeId) || null : null) || selectedNode;
    if (kind === 'link') {
      openDialog({ kind: 'link', node: node || null });
      return;
    }
    if (kind === 'schedule') {
      openDialog({ kind: 'schedule', node: node || null });
      return;
    }
    if (kind === 'reason') {
      openDialog({
        kind: 'reason',
        mode: request.mode === 'revision' || request.mode === 'skip' ? request.mode : 'block',
        node: node || null,
      });
      return;
    }
    if (kind === 'nodeAdd') {
      let flow = typeof request.flowId === 'string' && s !== null ? fpFlowById(s, request.flowId) || null : null;
      if (flow === null && s !== null && selectedProject !== null) {
        const flows = fpProjectFlows(s, selectedProject.id);
        flow = flows.length > 0 ? flows[0] : null;
      }
      openDialog({ kind: 'nodeAdd', flow: flow });
    }
  }

  /* ---------------- 键盘：Esc / ⌘-Ctrl+Enter / W（契约 §7.5） ---------------- */
  function handleCompleteSelected() {
    if (s === null || selectedNode === null) {
      FpToast.push({ tone: 'error', text: '先选择一个节点' });
      return;
    }
    const node = selectedNode;
    const meta = FP_STATUS[node.status] || null;
    if (meta === null || meta.done === true) {
      FpToast.push({ tone: 'error', text: '节点已完成或已跳过' });
      return;
    }
    if (node.status === 'locked') {
      FpToast.push({ tone: 'error', text: '节点尚未解锁' });
      return;
    }
    const gate = fpCanComplete(node, fpNodeLinks(s, node.id), node.approvals || {});
    if (gate && gate.ok === false) {
      FpToast.push({ tone: 'error', text: gate.error || '当前节点还不能完成' });
      return;
    }
    let task = null;
    try {
      task = fpDispatch('completeNode', { nodeId: node.id, note: '' });
    } catch (cause) {
      task = Promise.reject(cause);
    }
    Promise.resolve(task).then(
      function (result) {
        if (!result || result.ok !== true) {
          FpToast.push({ tone: 'error', text: (result && result.error) || '完成节点失败' });
          return;
        }
        FpToast.push({
          tone: 'success',
          text: '已完成 ' + (node.code ? node.code + ' ' : '') + (node.title || '节点'),
        });
      },
      function (cause) {
        FpToast.push({ tone: 'error', text: '完成节点失败：' + fpShellErrorText(cause) });
      },
    );
  }

  function handleWaitSelected() {
    if (s === null || selectedNode === null) {
      FpToast.push({ tone: 'error', text: '先选择一个节点' });
      return;
    }
    const node = selectedNode;
    const meta = FP_STATUS[node.status] || null;
    if (meta === null || meta.done === true) {
      FpToast.push({ tone: 'error', text: '节点已完成或已跳过' });
      return;
    }
    if (node.status === 'locked') {
      FpToast.push({ tone: 'error', text: '节点尚未解锁' });
      return;
    }
    let task = null;
    try {
      task = fpDispatch('waitNode', { nodeId: node.id, followUpAt: null, note: '' });
    } catch (cause) {
      task = Promise.reject(cause);
    }
    Promise.resolve(task).then(
      function (result) {
        if (!result || result.ok !== true) {
          FpToast.push({ tone: 'error', text: (result && result.error) || '进入等待失败' });
          return;
        }
        FpToast.push({ tone: 'info', text: '已标记为待确认' });
      },
      function (cause) {
        FpToast.push({ tone: 'error', text: '进入等待失败：' + fpShellErrorText(cause) });
      },
    );
  }

  useEffect(function () {
    if (typeof window === 'undefined') return undefined;
    function onKeyDown(event) {
      if (!event || event.defaultPrevented === true) return;
      const dialogOpen = dialog !== null && dialog.kind !== null;
      if (event.key === 'Escape') {
        if (dialogOpen) {
          closeDialog();
          return;
        }
        if (narrow && navOpen) {
          setNavOpen(false);
          return;
        }
        if (mid && !detailCollapsed && selectedNodeId !== null) {
          setDetailCollapsed(true);
        }
        return;
      }
      if (dialogOpen) return;
      const editable = fpShellIsEditable(event.target);
      const mod = event.metaKey === true || event.ctrlKey === true;
      if (mod && (event.key === 'Enter' || event.key === 'NumpadEnter')) {
        if (editable) return;
        event.preventDefault();
        handleCompleteSelected();
        return;
      }
      if (!mod && event.altKey !== true && event.shiftKey !== true && (event.key === 'w' || event.key === 'W')) {
        if (editable) return;
        event.preventDefault();
        handleWaitSelected();
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return function () {
      window.removeEventListener('keydown', onKeyDown);
    };
  });

  /* ---------------- 渲染：顶栏 ---------------- */
  function renderRhythm() {
    if (focus === null) return null;
    if (focus.silent === true) return null;
    const prompt = focus.prompt !== null && typeof focus.prompt === 'object' ? focus.prompt : null;
    if (prompt === null) return null;
    const key = (todayKey || '') + ':' + (typeof focus.period === 'string' ? focus.period : '');
    if (rhythmDismissedKey !== null && rhythmDismissedKey === key) return null;
    const title = typeof prompt.title === 'string' && prompt.title !== '' ? prompt.title : typeof focus.label === 'string' && focus.label !== '' ? focus.label : '当前节奏';
    const body = typeof prompt.body === 'string' ? prompt.body : '';
    const cta = typeof prompt.cta === 'string' ? prompt.cta : '';
    return h(
      'div',
      { className: 'fp-rhythm', title: [typeof focus.label === 'string' ? focus.label : '', body].filter(Boolean).join(' · ') },
      h(
        'button',
        {
          type: 'button',
          className: 'fp-rhythm__main',
          onClick: function () {
            setView('today');
          },
        },
        h('span', { className: 'fp-rhythm__dot', 'aria-hidden': 'true' }),
        h('span', { className: 'fp-rhythm__title' }, title),
        body !== '' ? h('span', { className: 'fp-rhythm__body' }, body) : null,
        cta !== '' ? h('span', { className: 'fp-rhythm__cta' }, cta) : null,
      ),
      h(
        'button',
        {
          type: 'button',
          className: 'fp-rhythm__close',
          title: '今天不再提示',
          'aria-label': '今天不再提示这条节奏提示',
          onClick: handleDismissRhythm,
        },
        h(FpIcon, { name: 'x', size: 11 }),
      ),
    );
  }

  function renderSummary() {
    if (!hasData) return null;
    return h(
      'button',
      {
        type: 'button',
        className: 'fp-summ',
        title: '打开今日工作',
        onClick: function () {
          setView('today');
        },
      },
      h(
        'span',
        { className: 'fp-summ__item', 'data-tone': 'brand' },
        h('span', { className: 'fp-summ__dot', 'aria-hidden': 'true' }),
        h('span', { className: 'fp-summ__num' }, String(countsActionable)),
        h('span', { className: 'fp-summ__label' }, '可推进'),
      ),
      h(
        'span',
        { className: 'fp-summ__item', 'data-tone': 'warn' },
        h('span', { className: 'fp-summ__dot', 'aria-hidden': 'true' }),
        h('span', { className: 'fp-summ__num' }, String(followCount)),
        h('span', { className: 'fp-summ__label' }, '待跟进'),
      ),
      countsOverdue > 0
        ? h(
            'span',
            { className: 'fp-summ__item', 'data-tone': 'error' },
            h('span', { className: 'fp-summ__dot', 'aria-hidden': 'true' }),
            h('span', { className: 'fp-summ__num' }, String(countsOverdue)),
            h('span', { className: 'fp-summ__label' }, '逾期'),
          )
        : null,
    );
  }

  function renderTopbar() {
    return h(
      'header',
      { className: 'fp-topbar' },
      narrow
        ? h(
            FpIconButton,
            {
              label: navOpen ? '收起项目导航' : '打开项目导航',
              title: '项目导航',
              active: navOpen,
              size: 26,
              onClick: function () {
                setNavOpen(function (previous) {
                  return !previous;
                });
              },
            },
            fpShellMenuGlyph(),
          )
        : null,
      h(
        'div',
        { className: 'fp-brand', title: 'FlowPilot · 流程节点驱动的个人项目管理' },
        h('span', { className: 'fp-brand__mark' }, h(FpSidebarGlyph, { size: 15, active: true })),
        brandCompact
          ? null
          : h(
              'span',
              { className: 'fp-brand__text' },
              h('span', { className: 'fp-brand__name' }, 'FlowPilot'),
              h('span', { className: 'fp-brand__sub' }, '流程工作台'),
            ),
      ),
      h(
        'nav',
        { className: 'fp-views', 'aria-label': '主视图切换' },
        FP_VIEWS.map(function (item) {
          const id = item.id;
          const label = FP_T('view.' + id, item.label);
          const active = view === id;
          return h(
            'button',
            {
              key: id,
              type: 'button',
              className: 'fp-view-btn',
              'data-active': active ? 'true' : 'false',
              'aria-pressed': active ? 'true' : 'false',
              title: label,
              disabled: !hasData,
              onClick: function () {
                setView(id);
                if (narrow) setNavOpen(false);
              },
            },
            h(FpIcon, { name: item.icon, size: 14 }),
            h('span', { className: 'fp-view__label' }, label),
          );
        }),
      ),
      h('span', { className: 'fp-topbar__spacer' }),
      topbarTight
        ? h(
            'div',
            { className: 'fp-topmore-wrap' },
            h(
              FpIconButton,
              {
                label: '更多操作',
                title: '更多：同步 / 设置 / 节奏 / 汇总 / 时间',
                size: 28,
                active: moreOpen === true,
                'aria-haspopup': 'menu',
                'aria-expanded': moreOpen === true ? 'true' : 'false',
                onClick: function (event) {
                  if (moreOpen === true) {
                    setMoreOpen(false);
                    return;
                  }
                  const target = event && event.currentTarget ? event.currentTarget : null;
                  const rect = target !== null && typeof target.getBoundingClientRect === 'function' ? target.getBoundingClientRect() : null;
                  setMoreAnchor(rect !== null ? { bottom: rect.bottom, right: rect.right } : null);
                  setMoreOpen(true);
                },
              },
              h(FpIcon, { name: 'more', size: 15 }),
            ),
          )
        : [
            h(FpUpdateBadge, {
              key: 'update-badge',
              onOpen: function () {
                setSettingsOpen(true);
              },
            }),
            renderRhythm(),
            renderSummary(),
            h(
              FpIconButton,
              {
                key: 'sync',
                label: '立即同步',
                title:
                  syncBusy === true
                    ? '正在同步…'
                    : syncAt !== null
                      ? '立即同步（上次 ' + fpShellHHMM(new Date(syncAt)) + '）'
                      : '立即同步（云端 ↔ 本地，最新覆盖旧的）',
                size: 28,
                disabled: syncBusy === true,
                onClick: function () {
                  handleSyncNow(false);
                },
              },
              h(FpIcon, { name: 'refresh', size: 14, className: syncBusy === true ? 'fp-spin' : undefined }),
            ),
            h(
              FpIconButton,
              {
                key: 'settings',
                label: '设置',
                title: '设置',
                size: 28,
                active: settingsOpen === true,
                onClick: function () {
                  setSettingsOpen(!settingsOpen);
                },
              },
              h(FpIcon, { name: 'settings', size: 14 }),
            ),
            h(
              'div',
              { key: 'clock', className: 'fp-clock', title: fpShellWeekday(nowDate) + ' ' + fpShellHHMM(nowDate) },
              h('span', { className: 'fp-clock__day' }, fpShellWeekday(nowDate)),
              h('span', { className: 'fp-clock__time' }, fpShellHHMM(nowDate)),
            ),
          ],
      topbarTight ? renderTopMoreMenu() : null,
    );
  }

  /* 顶栏「⋯」菜单：同步 / 设置 / 节奏 / 汇总 / 时间全部收在这里 */
  function renderTopMoreMenu() {
    if (!moreOpen) return null;
    const anchor = moreAnchor !== null && typeof moreAnchor === 'object' ? moreAnchor : null;
    const width = 268;
    const vw = typeof window !== 'undefined' && typeof window.innerWidth === 'number' ? window.innerWidth : 1440;
    const vh = typeof window !== 'undefined' && typeof window.innerHeight === 'number' ? window.innerHeight : 900;
    const top = anchor !== null && typeof anchor.bottom === 'number' ? Math.round(anchor.bottom + 8) : 56;
    const left = Math.min(
      Math.max(8, anchor !== null && typeof anchor.right === 'number' ? Math.round(anchor.right - width) : vw - width - 8),
      Math.max(8, vw - width - 8),
    );
    const maxHeight = Math.max(200, vh - top - 12);
    const items = [];
    items.push(
      h(
        'button',
        {
          key: 'sync',
          type: 'button',
          role: 'menuitem',
          className: 'fp-ctxmenu__item',
          disabled: syncBusy === true,
          onClick: function () {
            setMoreOpen(false);
            handleSyncNow(false);
          },
        },
        syncBusy === true ? '正在同步…' : '立即同步',
      ),
      h(
        'button',
        {
          key: 'settings',
          type: 'button',
          role: 'menuitem',
          className: 'fp-ctxmenu__item',
          onClick: function () {
            setMoreOpen(false);
            setSettingsOpen(true);
          },
        },
        '设置',
      ),
      h(
        'button',
        {
          key: 'today',
          type: 'button',
          role: 'menuitem',
          className: 'fp-ctxmenu__item',
          onClick: function () {
            setMoreOpen(false);
            setView('today');
          },
        },
        '今日工作',
      ),
      h('div', { key: 'sep', className: 'fp-ctxmenu__sep', role: 'separator' }),
    );
    if (focus !== null && typeof focus === 'object') {
      const label = typeof focus.label === 'string' && focus.label !== '' ? focus.label : '';
      const prompt = focus.prompt !== null && typeof focus.prompt === 'object' ? focus.prompt : null;
      items.push(
        h(
          'div',
          { key: 'rhythm', className: 'fp-topmore__info' },
          h('span', { key: 'l', className: 'fp-topmore__label' }, '当前节奏'),
          h('span', { key: 'v', className: 'fp-topmore__value' }, label !== '' ? label : '—'),
          prompt !== null && typeof prompt.body === 'string' && prompt.body !== ''
            ? h('span', { key: 'b', className: 'fp-topmore__hint' }, prompt.body)
            : null,
          prompt !== null && typeof prompt.title === 'string' && prompt.title !== ''
            ? h('span', { key: 't', className: 'fp-topmore__hint' }, prompt.title)
            : null,
        ),
      );
    }
    if (hasData) {
      items.push(
        h(
          'div',
          { key: 'summary', className: 'fp-topmore__info' },
          h('span', { key: 'l', className: 'fp-topmore__label' }, '待办'),
          h(
            'span',
            { key: 'v', className: 'fp-topmore__stats' },
            h('span', { key: 'a', className: 'fp-topmore__stat' }, String(countsActionable) + ' 可推进'),
            h('span', { key: 'f', className: 'fp-topmore__stat' }, String(followCount) + ' 待跟进'),
            countsOverdue > 0
              ? h('span', { key: 'o', className: 'fp-topmore__stat fp-topmore__stat--error' }, String(countsOverdue) + ' 逾期')
              : null,
          ),
        ),
      );
    }
    items.push(
      h(
        'div',
        { key: 'clock', className: 'fp-topmore__info' },
        h('span', { key: 'l', className: 'fp-topmore__label' }, '现在'),
        h('span', { key: 'v', className: 'fp-topmore__value' }, fpShellWeekday(nowDate) + ' ' + fpShellHHMM(nowDate)),
      ),
    );
    return h(
      'div',
      {
        className: 'fp-ctxmenu fp-topmore',
        role: 'menu',
        ref: moreMenuRef,
        style: { position: 'fixed', top: top + 'px', left: left + 'px', width: width + 'px', maxHeight: maxHeight + 'px', overflowY: 'auto' },
        onMouseDown: function (event) {
          if (event && typeof event.stopPropagation === 'function') event.stopPropagation();
        },
      },
      items,
    );
  }

  /* ---------------- 渲染：左栏 ---------------- */
  function renderProjectRow(project) {
    const info = projectInfo[project.id] !== null && typeof projectInfo[project.id] === 'object' ? projectInfo[project.id] : null;
    const code = info !== null && typeof info.currentCode === 'string' && info.currentCode !== '' ? info.currentCode : '—';
    const stage = info !== null && typeof info.currentStage === 'string' && info.currentStage !== '' ? info.currentStage : '尚未开始';
    const dueAt = info !== null && typeof info.nextDueAt === 'string' && info.nextDueAt !== '' ? info.nextDueAt : typeof project.dueAt === 'string' && project.dueAt !== '' ? project.dueAt : null;
    const dueText = dueAt !== null ? fpRelativeDay(dueAt, nowDate) : '';
    const daysLeft = dueAt !== null ? fpDaysLeft(dueAt, nowDate) : null;
    const overdue = typeof daysLeft === 'number' && daysLeft < 0;
    let dotTone = '';
    if (info !== null) {
      if (typeof info.waiting === 'number' && info.waiting > 0) dotTone = 'warn';
      else if (info.needsAttention === true) dotTone = 'warn';
      else if (typeof info.actionable === 'number' && info.actionable > 0) dotTone = 'brand';
    }
    if (overdue) dotTone = 'error';
    const archived = project.status === 'archived';
    const active = project.id === selectedProjectId;
    const progress = info !== null && typeof info.progress === 'number' ? fpClamp(info.progress, 0, 1) : null;
    const ownerLine = lines.filter(function (item) { return item !== null && item !== undefined && item.id === project.businessLineId; })[0];
    const lineName = ownerLine !== null && ownerLine !== undefined && typeof ownerLine.name === 'string' ? ownerLine.name : '';
    const subText = (lineName !== '' ? lineName + ' · ' : '') + stage;
    const dueTone = overdue ? 'error' : daysLeft === 0 ? 'today' : daysLeft === 1 ? 'soon' : '';
    const title = (project.title || '未命名项目') + ' · ' + stage + (dueText !== '' && dueText !== '—' ? ' · ' + dueText : '');
    const row = h(
      'button',
      {
        key: project.id,
        type: 'button',
        className: 'fp-project',
        onContextMenu: function (event) {
          if (event && typeof event.preventDefault === 'function') event.preventDefault();
          if (event && typeof event.stopPropagation === 'function') event.stopPropagation();
          openProjectMenu(project.id, event && event.clientX, event && event.clientY);
        },
        'data-active': active ? 'true' : 'false',
        'data-archived': archived ? 'true' : 'false',
        title: title,
        'aria-current': active ? 'true' : undefined,
        onClick: function () {
          handleSelectProject(project.id);
        },
        onKeyDown: function (event) {
          if (!event) return;
          const isMenuKey = event.key === 'ContextMenu';
          const isShiftF10 = event.shiftKey === true && event.key === 'F10';
          if (!isMenuKey && !isShiftF10) return;
          if (typeof event.preventDefault === 'function') event.preventDefault();
          const target = event.currentTarget !== null && event.currentTarget !== undefined
            ? event.currentTarget
            : null;
          const rect = target !== null && typeof target.getBoundingClientRect === 'function'
            ? target.getBoundingClientRect()
            : null;
          openProjectMenu(project.id, rect !== null ? rect.left + 16 : 0, rect !== null ? rect.bottom : 0);
        },
      },
      h(
        'span',
        { className: 'fp-project__main' },
        h(
          'span',
          { className: 'fp-project__head' },
          h('span', { className: 'fp-project__code' }, code),
          h('span', { className: 'fp-project__title' }, project.title || '未命名项目'),
        ),
        h(
          'span',
          { className: 'fp-project__meta' },
          h('span', { className: 'fp-project__sub', title: subText }, subText),
          dueText !== '' && dueText !== '—'
            ? h('span', { className: 'fp-project__due', 'data-overdue': overdue ? 'true' : 'false', 'data-tone': dueTone }, dueText)
            : null,
        ),
      ),
      progress !== null
        ? h(
            'span',
            { className: 'fp-project__progress', 'aria-hidden': 'true' },
            h('span', { style: { width: Math.round(progress * 100) + '%' } }),
          )
        : null,
    );
    return row;
  }

  function renderLine(line) {
    const lineProjects = fpLineProjects(s, line.id);
    return h(
      'div',
      { className: 'fp-line', key: line.id },
      h(
        'div',
        { className: 'fp-line__head' },
        h('span', { className: 'fp-line__name', title: line.name }, line.name || '未命名业务线'),
        h('span', { className: 'fp-line__count' }, String(lineProjects.length)),
        h(
          'span',
          { className: 'fp-line__actions' },
          h(
            'button',
            {
              type: 'button',
              className: 'fp-line__act',
              title: '在「' + (line.name || '业务线') + '」下新建项目',
              'aria-label': '在' + (line.name || '业务线') + '下新建项目',
              onClick: function () {
                openProjectCreate(line.id);
              },
            },
            h(FpIcon, { name: 'plus', size: 13 }),
          ),
          h(
            'button',
            {
              type: 'button',
              className: 'fp-line__act',
              title: '重命名业务线',
              'aria-label': '重命名业务线',
              onClick: function () {
                openLineEdit(line);
              },
            },
            h(FpIcon, { name: 'edit', size: 12 }),
          ),
        ),
      ),
      lineProjects.length === 0
        ? h('p', { className: 'fp-line__empty' }, '暂无项目')
        : lineProjects.map(renderProjectRow),
    );
  }

  function renderArchived() {
    const sorted = archivedProjects.slice().sort(function (a, b) {
      return String(b.archivedAt || '').localeCompare(String(a.archivedAt || ''));
    });
    return h(
      'div',
      { className: 'fp-archived', key: 'archived' },
      h(
        'button',
        {
          type: 'button',
          className: 'fp-archived__toggle',
          'aria-expanded': archivedOpen ? 'true' : 'false',
          onClick: function () {
            setArchivedOpen(function (previous) {
              return !previous;
            });
          },
        },
        h(FpIcon, { name: archivedOpen ? 'chevron-down' : 'chevron-right', size: 12 }),
        h('span', null, '已归档'),
        h('span', { className: 'fp-line__count' }, String(sorted.length)),
      ),
      archivedOpen ? sorted.map(renderProjectRow) : null,
    );
  }

  function renderNav() {
    const drawer = narrow;
    return h(
      'aside',
      { className: 'fp-nav', key: 'nav', 'data-drawer': drawer ? 'true' : 'false', 'aria-label': '业务线与项目导航' },
      h(
        'div',
        { className: 'fp-nav__head' },
        h('span', { className: 'fp-nav__title' }, '业务线'),
        h('span', { className: 'fp-nav__count' }, String(lines.length)),
        narrow
          ? h(
              FpIconButton,
              {
                label: '收起导航',
                title: '收起导航',
                size: 24,
                onClick: function () {
                  setNavOpen(false);
                },
              },
              h(FpIcon, { name: 'x', size: 13 }),
            )
          : null,
      ),
      h(
        'div',
        { className: 'fp-nav__scroll fp-scroll' },
        linesSorted.length === 0
          ? h('p', { className: 'fp-nav__empty' }, '还没有业务线。先新建一条，再在它下面添加项目。')
          : linesSorted.map(renderLine),
        archivedProjects.length > 0 ? renderArchived() : null,
      ),
      h(
        'div',
        { className: 'fp-nav__foot' },
        h(
          'div',
          { className: 'fp-nav__actions' },
          h(FpButton, { variant: 'default', size: 'sm', fullWidth: true, icon: 'plus', onClick: openCreateLine }, '新建业务线'),
          h(
            FpButton,
            {
              variant: 'primary',
              size: 'sm',
              fullWidth: true,
              icon: 'spark',
              title: '粘贴 PRD，让 AI 解析成项目与流程节点',
              disabled: s === null,
              onClick: function () {
                setAiOpen(true);
              },
            },
            'AI 建流程',
          ),
        ),
        h(
          'div',
          { className: 'fp-nav__status' },
          h('span', { className: 'fp-nav__status-dot', 'data-error': status === 'error' ? 'true' : 'false' }),
          h(
            'span',
            { className: 'fp-nav__status-text' },
            status === 'error' ? '连接异常，稍后自动重试' : '已同步 · r' + String(revision),
          ),
        ),
      ),
    );
  }

  /* ---------------- 渲染：中栏 ---------------- */
  function renderOnboarding() {
    return fpShellGuideCard({
      icon: h(FpSidebarGlyph, { size: 24, active: true }),
      title: '开始搭建你的项目流程',
      description:
        '先建一条业务线（例如「增长推广」），再在业务线下新建项目并选择「设计交付 / 验收」模板；FlowPilot 会按模板自动展开整套流程节点。',
      actions: [
        h(FpButton, { key: 'create-line', variant: 'primary', icon: 'plus', onClick: openCreateLine }, '新建业务线'),
        h(
          FpButton,
          { key: 'seed', variant: 'default', icon: 'spark', disabled: seedBusy, onClick: handleSeedDemo },
          seedBusy ? '载入中…' : '载入示例数据',
        ),
      ],
      hint: '示例数据包含 2 条业务线、4 个在建项目与完整节点、事件与周报；数据保存在本机，可随时在设置里清空。',
    });
  }

  function renderNoProjectGuide() {
    return fpShellGuideCard({
      icon: h(FpIcon, { name: 'flow', size: 22 }),
      title: '选择一个项目开始',
      description: '左侧业务线下的每个项目都会展开成纵向节点流；也可以先新建一个项目，模板会自动生成全部节点。',
      actions: [
        h(
          FpButton,
          {
            key: 'create-project',
            variant: 'primary',
            icon: 'plus',
            onClick: function () {
              openProjectCreate(null);
            },
          },
          '新建项目',
        ),
      ],
    });
  }

  function renderMain() {
    let content = null;
    const noData = lines.length === 0 && projects.length === 0;
    if (view !== 'settings' && noData) {
      content = renderOnboarding();
    } else if (view === 'today') {
      content = h(TodayView, { state: s, derived: d, onSelectNode: handleSelectNode, onOpenProject: handleOpenProject });
    } else if (view === 'weekly') {
      content = h(WeeklyView, { state: s, derived: d });
    } else if (view === 'handoff') {
      content = h(HandoffView, { state: s, derived: d, onOpenProject: handleOpenProject });
    } else if (view === 'settings') {
      content = h(SettingsView, { state: s, derived: d });
    } else if (selectedProject === null) {
      content = renderNoProjectGuide();
    } else {
      content = h(FlowView, {
        state: s,
        derived: d,
        project: selectedProject,
        selection: { projectId: selectedProjectId, nodeId: selectedNodeId },
        selectedNodeId: selectedNodeId,
        onSelectNode: handleSelectNode,
        onCollapseDetail: handleCollapseDetail,
        onCreateProject: handleCreateProjectFromFlow,
        onAddFlow: handleAddFlow,
      });
    }
    return h(
      'main',
      { className: 'fp-main', key: 'main', 'aria-label': '主内容' },
      h('div', { className: 'fp-main__view' }, content),
    );
  }

  /* ---------------- 渲染：右栏 ---------------- */
  function renderSidePlaceholder() {
    return h(
      'div',
      { className: 'fp-side__empty' },
      h('div', { className: 'fp-side__empty-icon' }, h(FpIcon, { name: 'flow', size: 20 })),
      h('p', { className: 'fp-side__empty-title' }, '节点详情'),
      h(
        'p',
        { className: 'fp-side__empty-desc' },
        selectedProject !== null
          ? '在中间的节点流里点击任意节点，这里会显示操作、计划、链接与事件。'
          : '先从左侧选择一个项目。',
      ),
      selectedProject !== null
        ? h(
            FpButton,
            {
              variant: 'quiet',
              size: 'sm',
              iconRight: 'chevron-right',
              onClick: function () {
                setDetailCollapsed(true);
              },
            },
            '收起侧栏',
          )
        : null,
    );
  }

  function renderSide() {
    const collapsed = detailCollapsed === true;
    // 窄屏/中屏保持原行为：收起时直接不占位（浮层模式下也不做折叠动画）
    if (collapsed && (narrow || mid)) return null;
    if (!collapsed && selectedNode === null && mid) return null;
    // 没有选中任何节点时也保持不渲染（避免空 rail）
    if (selectedNode === null && collapsed) return null;

    const classes = ['fp-side'];
    if (mid) classes.push('fp-side--overlay');
    if (collapsed) classes.push('fp-side--rail');

    return h(
      'aside',
      {
        className: classes.join(' '),
        key: 'side',
        'data-collapsed': collapsed ? 'true' : 'false',
        'aria-label': collapsed ? '节点详情（已收起）' : '节点详情',
      },
      collapsed
        ? h(
            'div',
            { className: 'fp-side__rail-inner' },
            h(
              FpIconButton,
              {
                label: '展开节点详情',
                title: '展开节点详情',
                size: 24,
                onClick: function () {
                  setDetailCollapsed(false);
                },
              },
              h(FpIcon, { name: 'chevron-right', size: 13, className: 'fp-icon--flip' }),
            ),
            h('span', { className: 'fp-side__rail-label' }, selectedNode.code || '详情'),
          )
        : h(
            'div',
            { className: 'fp-side__panel' },
            h(
              'div',
              { className: 'fp-side__bar' },
              h(
                FpIconButton,
                {
                  label: '收起节点详情',
                  title: '收起节点详情',
                  size: 24,
                  onClick: function () {
                    setDetailCollapsed(true);
                  },
                },
                h(FpIcon, { name: 'chevron-right', size: 13 }),
              ),
            ),
            selectedNode !== null && detailProject !== null
              ? h(NodeDetail, {
                  state: s,
                  derived: d,
                  project: detailProject,
                  node: selectedNode,
                  onClose: handleCloseDetail,
                  onRequestDialog: handleNodeDialogRequest,
                })
              : renderSidePlaceholder(),
          ),
    );
  }

  function renderShellBody() {
    const children = [];
    if (narrow && navOpen) {
      children.push(
        h('button', {
          key: 'nav-scrim',
          type: 'button',
          className: 'fp-scrim',
          'aria-label': '关闭项目导航',
          onClick: function () {
            setNavOpen(false);
          },
        }),
      );
    }
    if (!narrow || navOpen) children.push(renderNav());
    children.push(renderMain());
    const side = renderSide();
    if (side !== null) {
      if (mid && !detailCollapsed && selectedNode !== null) {
        children.push(
          h('button', {
            key: 'side-scrim',
            type: 'button',
            className: 'fp-scrim',
            'aria-label': '收起节点详情',
            onClick: function () {
              setDetailCollapsed(true);
            },
          }),
        );
      }
      children.push(side);
    }
    return children;
  }

  function renderErrorPane() {
    return h(
      'div',
      { className: 'fp-error', key: 'error' },
      h(
        'div',
        { className: 'fp-error__card' },
        h('div', { className: 'fp-error__icon' }, h(FpIcon, { name: 'alert', size: 20 })),
        h('h2', { className: 'fp-error__title' }, 'FlowPilot 宿主未就绪'),
        h('p', { className: 'fp-error__text' }, fpShellErrorText(error) || '暂时读不到 FlowPilot 数据。'),
        h(
          'ul',
          { className: 'fp-error__list' },
          h('li', null, '确认 DSH 已重启、FlowPilot 插件处于启用状态'),
          h('li', null, '刚安装或更新插件时，刷新页面后重试'),
          h('li', null, '数据文件异常时，可在设置页导入备份'),
        ),
        h(
          'div',
          { className: 'fp-error__actions' },
          h(
            FpButton,
            { variant: 'primary', icon: 'refresh', disabled: refreshing, onClick: handleRefresh },
            refreshing ? '重试中…' : '重试',
          ),
        ),
      ),
    );
  }

  /* ---------------- 渲染：弹窗宿主 ---------------- */
  /* Esc 关闭设置弹窗 */
  useEffect(
    function () {
      if (settingsOpen !== true) return undefined;
      const onKey = function (event) {
        if (event && event.key === 'Escape') setSettingsOpen(false);
      };
      if (typeof document !== 'undefined') document.addEventListener('keydown', onKey, true);
      return function () {
        if (typeof document !== 'undefined') document.removeEventListener('keydown', onKey, true);
      };
    },
    [settingsOpen],
  );

  /* ---------------- 设置弹窗（居中浮层，替代原「设置」tab） ---------------- */
  function renderSettingsModal() {
    if (settingsOpen !== true) return null;
    return h(
      'div',
      {
        className: 'fp-modal-layer',
        key: 'settings-modal',
        role: 'presentation',
        onMouseDown: function (event) {
          if (event && event.target === event.currentTarget) setSettingsOpen(false);
        },
      },
      h(
        'div',
        { className: 'fp-modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': '设置' },
        h(
          'div',
          { className: 'fp-modal__head' },
          h('span', { className: 'fp-modal__title' }, '设置'),
          h(
            FpIconButton,
            {
              label: '关闭设置',
              title: '关闭（Esc）',
              size: 28,
              onClick: function () {
                setSettingsOpen(false);
              },
            },
            h(FpIcon, { name: 'x', size: 14 }),
          ),
        ),
        h('div', { className: 'fp-modal__body fp-scroll' }, h(SettingsView, { state: s, derived: d, compact: true })),
      ),
    );
  }

  function renderDialogs() {
    if (s === null) return null;
    const defaultLineId =
      dialog.lineId !== null
        ? dialog.lineId
        : selectedProject !== null && typeof selectedProject.businessLineId === 'string'
          ? selectedProject.businessLineId
          : null;
    return [
      h(ProjectCreateDialog, {
        key: 'dlg-project',
        open: dialog.kind === 'projectCreate',
        onClose: closeDialog,
        state: s,
        defaultLineId: defaultLineId,
        onCreated: handleProjectCreated,
      }),
      h(LineEditDialog, {
        key: 'dlg-line',
        open: dialog.kind === 'lineEdit',
        line: dialog.line,
        onClose: closeDialog,
      }),
      h(LinkDialog, {
        key: 'dlg-link',
        open: dialog.kind === 'link',
        node: dialog.node,
        onClose: closeDialog,
      }),
      h(ScheduleDialog, {
        key: 'dlg-schedule',
        open: dialog.kind === 'schedule',
        node: dialog.node,
        onClose: closeDialog,
      }),
      h(ReasonDialog, {
        key: 'dlg-reason',
        open: dialog.kind === 'reason',
        mode: dialog.mode || 'block',
        node: dialog.node,
        onClose: closeDialog,
      }),
      h(NodeAddDialog, {
        key: 'dlg-node-add',
        open: dialog.kind === 'nodeAdd',
        flow: dialog.flow,
        onClose: closeDialog,
      }),
      h(AiPrdDialog, {
        key: 'dlg-ai',
        open: aiOpen,
        onClose: function () {
          setAiOpen(false);
        },
        state: s,
        derived: derived,
        onApplied: handleAiApplied,
      }),
    ];
  }

  /* ---------------- 渲染：项目右键菜单 / 删除确认 ---------------- */
  function renderProjectMenu() {
    if (!menuOpen) return null;
    const project = menuProject();
    if (project === null) return null;
    const archived = project.status === 'archived';
    const items = [
      h(
        'button',
        {
          key: 'open',
          type: 'button',
          role: 'menuitem',
          className: 'fp-ctxmenu__item',
          onClick: function () {
            closeProjectMenu();
            handleSelectProject(project.id);
          },
        },
        '打开项目',
      ),
      h(
        'button',
        {
          key: 'archive',
          type: 'button',
          role: 'menuitem',
          className: 'fp-ctxmenu__item',
          onClick: function () {
            handleArchiveToggle(project);
          },
        },
        archived ? '恢复项目' : '归档项目',
      ),
      h('div', { key: 'sep', className: 'fp-ctxmenu__sep', role: 'separator' }),
      h(
        'button',
        {
          key: 'delete',
          type: 'button',
          role: 'menuitem',
          className: 'fp-ctxmenu__item fp-ctxmenu__item--danger',
          onClick: function () {
            closeProjectMenu();
            setDeleteTarget(project.id);
          },
        },
        '删除项目…',
      ),
    ];
    return h(
      'div',
      {
        className: 'fp-ctxmenu',
        role: 'menu',
        'aria-label': '项目操作',
        ref: ctxMenuRef,
        style: { left: ctxMenu.x + 'px', top: ctxMenu.y + 'px' },
        onMouseDown: function (event) {
          if (event && typeof event.stopPropagation === 'function') event.stopPropagation();
        },
      },
      items,
    );
  }

  function renderDeleteConfirm() {
    if (typeof deleteTarget !== 'string' || deleteTarget === '' || s === null) return null;
    const project = fpProjectById(s, deleteTarget);
    if (project === null || project === undefined) return null;
    const projectFlows = (Array.isArray(s.flows) ? s.flows : []).filter(function (flow) {
      return flow.projectId === project.id;
    });
    const projectNodes = (Array.isArray(s.nodes) ? s.nodes : []).filter(function (node) {
      return node.projectId === project.id;
    });
    return h(FpConfirm, {
      key: 'confirm-delete-project',
      open: true,
      danger: true,
      title: '删除项目「' + (project.title || '未命名项目') + '」？',
      message:
        '将永久删除 ' +
        projectFlows.length +
        ' 个流程、' +
        projectNodes.length +
        ' 个节点，以及它们的链接与事件记录。删除前会自动备份到本地 backups 目录，但删除后无法在应用内撤销。只是想从列表里收起的话，请改用「归档项目」。',
      confirmLabel: '确认删除',
      onConfirm: confirmDeleteProject,
      onCancel: function () {
        setDeleteTarget(null);
      },
    });
  }

  /* ---------------- 组装 ---------------- */
  let shellChildren;
  if (status === 'loading' && s === null) shellChildren = fpShellSkeleton();
  else if (status === 'error' && s === null) shellChildren = renderErrorPane();
  else if (hasData) shellChildren = renderShellBody();
  else shellChildren = fpShellSkeleton();

  return h(
    'div',
    { className: 'fp-root', 'data-view': view },
    renderTopbar(),
    h('div', { className: 'fp-shell' }, shellChildren),
    renderSettingsModal(),
    renderDialogs(),
    renderProjectMenu(),
    renderDeleteConfirm(),
    h(FpToastHost),
  );
}
