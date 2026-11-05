/* ===== 归属：ui-shell · 基础控件、图标、Toast（契约 §7.1 / §7.4） =====
 * 纯受控控件：不持有业务状态、不直接请求宿主。
 * 视觉按 docs/UI-DESIGN.md：灰阶面分层替代描边、间距 4 栅格、颜色只走 CSS_BASE 的 --fp-* 令牌；
 * 本文件不新增全局变量、不改宿主样式，类名统一 fp- 前缀。
 */

const CSS_PRIMITIVES = String.raw`
/* ---------------------------------------------------------------- *
 * 基础控件：设计系统 2.0 视觉层（灰阶面替代描边）+ 4 栅格间距。
 * 颜色/圆角/字号一律来自 10-util.js CSS_BASE 的 --fp-* 令牌；
 * 不再引用宿主旧颜色令牌，不新增 HEX（主按钮按 UI-DESIGN §4 钉死的 设计系统 值除外）。
 * 唯一保留的 border 是 loading spinner 的环形描边（视觉必需，见 UI-DESIGN §4 例外）。
 * ---------------------------------------------------------------- */

/* 按钮：默认 = 下沉面，hover/active 只换底色，不加描边 */
.fp-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  height: 30px;
  padding: 0 12px;
  border: 0;
  border-radius: var(--fp-radius-md);
  background: var(--fp-surface-2);
  color: var(--fp-text);
  font: inherit;
  font-size: var(--fp-font-md);
  font-weight: 500;
  line-height: 1;
  white-space: nowrap;
  cursor: pointer;
  user-select: none;
  transition: background-color 140ms ease, color 140ms ease, box-shadow 140ms ease;
}
.fp-btn:hover:not(:disabled) {
  background: var(--fp-hover);
}
.fp-btn:active:not(:disabled) {
  background: var(--fp-pressed);
}
.fp-btn:disabled {
  opacity: 0.46;
  cursor: not-allowed;
}
.fp-btn--sm {
  height: 26px;
  padding: 0 8px;
  gap: 4px;
  font-size: var(--fp-font-sm);
}
.fp-btn--full {
  display: flex;
  width: 100%;
}
.fp-btn__icon {
  display: inline-flex;
  flex: none;
}
.fp-btn__label {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}
.fp-btn--primary {
  /* 填充与文字成对钉死（UI-DESIGN §4）：设计系统 值 + light-dark 双模式，不依赖令牌链 */
  background: light-dark(#0d0e10, #f0f1f2);
  color: light-dark(#ffffff, #0d0e10);
  font-weight: 600;
}
.fp-btn--primary:hover:not(:disabled) {
  background: light-dark(#17181a, #e3e5e7);
}
.fp-btn--primary:active:not(:disabled) {
  background: light-dark(#0d0e10, #f0f1f2);
}
.fp-btn--ghost {
  background: transparent;
  color: var(--fp-text-dim);
}
.fp-btn--ghost:hover:not(:disabled) {
  background: var(--fp-hover);
  color: var(--fp-text);
}
.fp-btn--quiet {
  background: transparent;
  color: var(--fp-text-tertiary);
  padding: 0 8px;
}
.fp-btn--quiet:hover:not(:disabled) {
  background: var(--fp-hover);
  color: var(--fp-text);
}
.fp-btn--danger {
  background: color-mix(in srgb, var(--fp-bad) 12%, transparent);
  color: var(--fp-bad);
  font-weight: 600;
}
.fp-btn--danger:hover:not(:disabled) {
  background: color-mix(in srgb, var(--fp-bad) 20%, transparent);
}
.fp-btn--danger:active:not(:disabled) {
  background: color-mix(in srgb, var(--fp-bad) 26%, transparent);
}

/* 图标按钮：无底色，hover/active 走灰阶面；选中态用下沉面 + 阴影-1 */
.fp-icon-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
  padding: 0;
  border: 0;
  border-radius: var(--fp-radius-md);
  background: transparent;
  color: var(--fp-text-tertiary);
  cursor: pointer;
  transition: background-color 140ms ease, color 140ms ease, box-shadow 140ms ease;
}
.fp-icon-btn:hover:not(:disabled) {
  background: var(--fp-hover);
  color: var(--fp-text);
}
.fp-icon-btn:active:not(:disabled) {
  background: var(--fp-pressed);
}
.fp-icon-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
.fp-icon-btn--active {
  background: var(--fp-surface-2);
  color: var(--fp-text);
  box-shadow: var(--fp-shadow-1);
}

/* Chip / 状态 chip：语义色 12% 透底 + 语义文字，无描边 */
.fp-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 20px;
  max-width: 100%;
  padding: 0 8px;
  border: 0;
  border-radius: var(--fp-radius-sm);
  background: var(--fp-surface-2);
  color: var(--fp-text-dim);
  font-size: var(--fp-font-xs);
  font-weight: 500;
  line-height: 1;
  white-space: nowrap;
  vertical-align: middle;
}
.fp-chip--md {
  height: 24px;
  padding: 0 12px;
  font-size: var(--fp-font-sm);
}
.fp-chip--clickable {
  cursor: pointer;
  font: inherit;
  font-size: var(--fp-font-xs);
  transition: background-color 140ms ease, color 140ms ease;
}
.fp-chip--clickable:hover {
  background: color-mix(in srgb, currentColor 16%, transparent);
  color: var(--fp-text);
}
.fp-chip__dot {
  width: 6px;
  height: 6px;
  flex: none;
  border-radius: var(--fp-radius-pill);
  background: currentColor;
  opacity: 0.92;
}
.fp-chip__text {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}
.fp-chip--idle {
  color: var(--fp-idle);
  background: transparent;
}
.fp-chip--brand {
  color: var(--fp-text);
  background: color-mix(in srgb, var(--fp-brand) 10%, transparent);
}
.fp-chip--accent {
  color: var(--fp-accent);
  background: color-mix(in srgb, var(--fp-accent) 12%, transparent);
}
.fp-chip--success {
  color: var(--fp-ok);
  background: color-mix(in srgb, var(--fp-ok) 12%, transparent);
}
.fp-chip--warn {
  color: var(--fp-warn-strong);
  background: color-mix(in srgb, var(--fp-warn) 14%, transparent);
}
.fp-chip--error {
  color: var(--fp-bad);
  background: color-mix(in srgb, var(--fp-bad) 12%, transparent);
}
.fp-chip--amber {
  color: color-mix(in srgb, var(--fp-warn-strong) 72%, var(--fp-bad));
  background: color-mix(in srgb, var(--fp-warn) 14%, var(--fp-bad) 4%);
}
.fp-chip--muted {
  color: var(--fp-text-tertiary);
  background: transparent;
}

/* 输入类控件：下沉面 + 圆角 md，聚焦只用 accent 环，无描边 */
.fp-input,
.fp-textarea {
  display: block;
  width: 100%;
  min-width: 0;
  border: 0;
  border-radius: var(--fp-radius-md);
  background: var(--fp-surface-2);
  color: var(--fp-text);
  font: inherit;
  font-size: var(--fp-font-md);
  outline: none;
  transition: background-color 140ms ease, box-shadow 140ms ease;
}
.fp-input {
  height: 30px;
  padding: 0 8px;
}
.fp-textarea {
  min-height: 62px;
  padding: 8px;
  line-height: 1.6;
  resize: vertical;
}
.fp-input::placeholder,
.fp-textarea::placeholder {
  color: var(--fp-text-quaternary);
}
.fp-input:hover:not(:disabled),
.fp-textarea:hover:not(:disabled) {
  background: var(--fp-hover);
}
.fp-input:focus,
.fp-textarea:focus {
  background: var(--fp-surface-2);
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--fp-accent) 45%, transparent);
}
.fp-input:disabled,
.fp-textarea:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.fp-select-wrap {
  position: relative;
  display: inline-flex;
  align-items: center;
  width: 100%;
  min-width: 0;
}
.fp-select {
  appearance: none;
  -webkit-appearance: none;
  width: 100%;
  height: 30px;
  min-width: 0;
  padding: 0 32px 0 8px;
  border: 0;
  border-radius: var(--fp-radius-md);
  background: var(--fp-surface-2);
  color: var(--fp-text);
  font: inherit;
  font-size: var(--fp-font-md);
  cursor: pointer;
  outline: none;
  transition: background-color 140ms ease, box-shadow 140ms ease;
}
.fp-select:hover:not(:disabled) {
  background: var(--fp-hover);
}
.fp-select:focus {
  background: var(--fp-surface-2);
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--fp-accent) 45%, transparent);
}
.fp-select:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.fp-select__icon {
  position: absolute;
  right: 8px;
  color: var(--fp-text-tertiary);
  pointer-events: none;
}

/* Switch：轨道用面/强调色，节流改底色，无描边 */
.fp-switch {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  width: 100%;
  padding: 4px 8px;
  border: 0;
  border-radius: var(--fp-radius-md);
  background: transparent;
  color: var(--fp-text);
  font: inherit;
  text-align: left;
  cursor: pointer;
  transition: background-color 140ms ease;
}
.fp-switch:hover:not(:disabled) {
  background: var(--fp-hover);
}
.fp-switch:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.fp-switch__track {
  position: relative;
  flex: none;
  width: 34px;
  height: 20px;
  margin-top: 0;
  border-radius: var(--fp-radius-pill);
  background: color-mix(in srgb, var(--fp-text) 14%, transparent);
  transition: background-color 150ms ease;
}
.fp-switch__thumb {
  position: absolute;
  top: 2px;
  left: 2px;
  width: 14px;
  height: 14px;
  border-radius: 50%;
  background: var(--fp-surface);
  box-shadow: var(--fp-shadow-1);
  transition: transform 150ms ease, background-color 150ms ease;
}
.fp-switch[aria-checked="true"] .fp-switch__track {
  background: var(--fp-accent);
}
.fp-switch[aria-checked="true"] .fp-switch__thumb {
  transform: translateX(14px);
  background: var(--fp-on-brand);
}
.fp-switch__text {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}
.fp-switch__label {
  font-size: var(--fp-font-md);
  line-height: 1.45;
}
.fp-switch__desc {
  font-size: var(--fp-font-xs);
  line-height: 1.55;
  color: var(--fp-text-dim);
}

/* Field / Section：纯排版容器，靠间距分层 */
.fp-field {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 0;
}
.fp-field__label {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: var(--fp-font-sm);
  font-weight: 600;
  color: var(--fp-text-dim);
  letter-spacing: 0.01em;
}
.fp-field__req {
  font-style: normal;
  font-weight: 600;
  color: var(--fp-bad);
}
.fp-field__hint {
  margin: 0;
  font-size: var(--fp-font-xs);
  line-height: 1.55;
  color: var(--fp-text-tertiary);
}
.fp-section {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 0;
}
.fp-section__head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
}
.fp-section__titles {
  min-width: 0;
}
.fp-section__title {
  margin: 0;
  font-size: var(--fp-font-sm);
  font-weight: 700;
  letter-spacing: 0.02em;
  color: var(--fp-text-dim);
}
.fp-section__hint {
  margin: 4px 0 0;
  font-size: var(--fp-font-xs);
  line-height: 1.55;
  color: var(--fp-text-tertiary);
}
.fp-section__actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.fp-section__body {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

/* Dialog：浮层 + 圆角 xl + 阴影-3；页脚用下沉面分隔，不用描边 */
.fp-dialog-layer {
  position: fixed;
  inset: 0;
  z-index: 900;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  box-sizing: border-box;
}
.fp-dialog__backdrop {
  position: absolute;
  inset: 0;
  border: 0;
  padding: 0;
  margin: 0;
  background: var(--fp-mask);
  backdrop-filter: blur(2px);
  cursor: default;
}
.fp-dialog {
  position: relative;
  display: flex;
  flex-direction: column;
  width: min(480px, 100%);
  max-width: min(calc(100vw - 48px), 720px);
  max-height: calc(100vh - 64px);
  border-radius: var(--fp-radius-xl);
  background: var(--fp-overlay);
  color: var(--fp-text);
  box-shadow: var(--fp-shadow-3);
  outline: none;
  animation: fp-dialog-in 150ms ease-out;
  overflow: hidden;
}
@keyframes fp-dialog-in {
  from { opacity: 0; transform: translateY(6px) scale(0.995); }
  to { opacity: 1; transform: none; }
}
.fp-dialog__head {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  flex: none;
  padding: 16px 16px 8px;
}
.fp-dialog__titles {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
  flex: 1 1 auto;
}
.fp-dialog__title {
  margin: 0;
  font-size: var(--fp-font-lg);
  font-weight: 650;
  letter-spacing: 0.01em;
  color: var(--fp-text);
  overflow-wrap: anywhere;
}
.fp-dialog__desc {
  margin: 0;
  font-size: var(--fp-font-sm);
  line-height: 1.6;
  color: var(--fp-text-tertiary);
  overflow-wrap: anywhere;
}
.fp-dialog__body {
  flex: 1 1 auto;
  min-height: 0;
  overflow: auto;
  padding: 8px 16px 16px;
  display: flex;
  flex-direction: column;
  gap: 12px;
  scrollbar-width: thin;
}
.fp-dialog__foot {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
  flex: none;
  flex-wrap: wrap;
  padding: 12px 16px 16px;
  background: var(--fp-surface-2);
}
.fp-dialog--danger .fp-dialog__title {
  color: var(--fp-bad);
}
.fp-confirm-message {
  margin: 0;
  font-size: var(--fp-font-sm);
  line-height: 1.7;
  color: var(--fp-text-dim);
  overflow-wrap: anywhere;
}

/* Empty / Spinner / Divider */
.fp-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  min-height: 0;
  padding: 24px 16px;
  text-align: center;
  color: var(--fp-text-tertiary);
}
.fp-empty__icon {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 36px;
  height: 36px;
  flex: none;
  border-radius: 50%;
  background: var(--fp-surface-2);
  color: var(--fp-text-tertiary);
}
.fp-empty__title {
  margin: 0;
  font-size: var(--fp-font-md);
  font-weight: 600;
  color: var(--fp-text-dim);
}
.fp-empty__desc {
  margin: 0;
  max-width: 36em;
  font-size: var(--fp-font-sm);
  line-height: 1.65;
  color: var(--fp-text-tertiary);
  overflow-wrap: anywhere;
}
.fp-empty__actions {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  flex-wrap: wrap;
  margin-top: 4px;
}
.fp-spinner-wrap {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  font-size: var(--fp-font-sm);
  color: var(--fp-text-tertiary);
}
/* loading 环形进度：保留描边是视觉必需（UI-DESIGN §4 例外） */
.fp-spinner {
  width: 14px;
  height: 14px;
  flex: none;
  border-radius: 50%;
  border: 2px solid color-mix(in srgb, currentColor 22%, transparent);
  border-top-color: currentColor;
  animation: fp-prim-spin 720ms linear infinite;
}
@keyframes fp-prim-spin {
  to { transform: rotate(360deg); }
}
.fp-spinner-label {
  min-width: 0;
}
.fp-divider {
  flex: none;
  height: 1px;
  margin: 0;
  border: 0;
  background: var(--fp-border);
}

/* Toast：设计系统 反向浮层（brand 底 + on-brand 字），状态只染色图标 */
.fp-toast-host {
  position: fixed;
  left: 50%;
  bottom: 24px;
  z-index: 960;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  width: max-content;
  max-width: min(420px, calc(100vw - 32px));
  transform: translateX(-50%);
  pointer-events: none;
}
.fp-toast {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  pointer-events: auto;
  padding: 8px 12px;
  border-radius: var(--fp-radius-md);
  background: var(--fp-brand);
  color: var(--fp-on-brand);
  font-size: var(--fp-font-sm);
  line-height: 1.55;
  box-shadow: var(--fp-shadow-2);
  cursor: pointer;
  animation: fp-toast-in 160ms ease-out;
}
@keyframes fp-toast-in {
  from { opacity: 0; transform: translateY(8px); }
  to { opacity: 1; transform: none; }
}
.fp-toast__icon {
  flex: none;
  margin-top: 0;
}
.fp-toast--info .fp-toast__icon {
  color: color-mix(in srgb, var(--fp-info) 72%, var(--fp-on-brand));
}
.fp-toast--success .fp-toast__icon {
  color: color-mix(in srgb, var(--fp-ok) 72%, var(--fp-on-brand));
}
.fp-toast--error .fp-toast__icon {
  color: color-mix(in srgb, var(--fp-bad) 72%, var(--fp-on-brand));
}
.fp-toast__text {
  min-width: 0;
  overflow-wrap: anywhere;
}

/* 图标 */
.fp-icon {
  display: block;
  flex: none;
  overflow: visible;
}


/* ---------------------------------------------------------------- *
 * 宿主兜底：CSS_BASE 的 .fp-root button { font: inherit; color: inherit; }
 * 选择器权重 (0,1,1) 高于单类名控件，会把字号/语义色盖回继承值。
 * 这里统一用双类名 (0,2,0) 把控件自身的字号与文字色钉回（含主按钮钉死色）。
 * ---------------------------------------------------------------- */
.fp-btn.fp-btn {
  font-size: var(--fp-font-md);
  font-weight: 500;
  line-height: 1;
  color: var(--fp-text);
}
.fp-btn.fp-btn--sm {
  font-size: var(--fp-font-sm);
}
.fp-btn.fp-btn--primary {
  font-weight: 600;
  color: light-dark(#ffffff, #0d0e10);
}
.fp-btn.fp-btn--ghost {
  color: var(--fp-text-dim);
}
.fp-btn.fp-btn--quiet {
  color: var(--fp-text-tertiary);
}
.fp-btn.fp-btn--danger {
  font-weight: 600;
  color: var(--fp-bad);
}
.fp-icon-btn.fp-icon-btn {
  color: var(--fp-text-tertiary);
}
.fp-icon-btn.fp-icon-btn--active {
  color: var(--fp-text);
}
.fp-chip.fp-chip {
  font-size: var(--fp-font-xs);
  font-weight: 500;
  line-height: 1;
  color: var(--fp-text-dim);
}
.fp-chip.fp-chip--md {
  font-size: var(--fp-font-sm);
}
.fp-chip.fp-chip--muted {
  color: var(--fp-text-tertiary);
}
.fp-chip.fp-chip--idle {
  color: var(--fp-idle);
}
.fp-chip.fp-chip--brand {
  color: var(--fp-text);
}
.fp-chip.fp-chip--accent {
  color: var(--fp-accent);
}
.fp-chip.fp-chip--success {
  color: var(--fp-ok);
}
.fp-chip.fp-chip--warn {
  color: var(--fp-warn-strong);
}
.fp-chip.fp-chip--error {
  color: var(--fp-bad);
}
.fp-chip.fp-chip--amber {
  color: color-mix(in srgb, var(--fp-warn-strong) 72%, var(--fp-bad));
}
.fp-switch.fp-switch {
  color: var(--fp-text);
}

@media (prefers-reduced-motion: reduce) {
  .fp-dialog,
  .fp-toast {
    animation: none;
  }
  .fp-spinner {
    animation-duration: 1.6s;
  }
}
`;

/* ------------------------------------------------------------------ *
 * 图标：唯一来源（契约 §7.4 全部 39 个名字）
 * 统一 16×16 线性图标，stroke=currentColor，无第三方图标库。
 * ------------------------------------------------------------------ */
const FP_ICON_DEFS = {
  plus: ['M8 3.2v9.6', 'M3.2 8h9.6'],
  check: ['M3.4 8.5 6.6 11.7 12.6 4.7'],
  x: ['M4.2 4.2 11.8 11.8', 'M11.8 4.2 4.2 11.8'],
  clock: ['M8 2.4a5.6 5.6 0 1 0 0 11.2a5.6 5.6 0 1 0 0-11.2', 'M8 5.2v3.2l2.2 1.4'],
  calendar: [
    'M3.9 3.4h8.2a1 1 0 0 1 1 1v8.2a1 1 0 0 1-1 1H3.9a1 1 0 0 1-1-1V4.4a1 1 0 0 1 1-1z',
    'M2.9 7.1h10.2',
    'M5.6 2.2v2.4',
    'M10.4 2.2v2.4',
  ],
  alert: ['M8 2.6 14 13.1H2z', 'M8 6.5v3.3', 'M8 11.6h.01'],
  block: ['M8 2.4a5.6 5.6 0 1 0 0 11.2a5.6 5.6 0 1 0 0-11.2', 'M4.1 4.1 11.9 11.9'],
  'arrow-left': ['M13 8H3.2', 'M6.4 4.6 3 8l3.4 3.4'],
  'arrow-right': ['M3 8h9.8', 'M9.6 4.6 13 8l-3.4 3.4'],
  'arrow-down': ['M8 3v9.8', 'M4.6 9.4 8 12.8l3.4-3.4'],
  link: [
    'M6.7 9.3a2.7 2.7 0 0 1 0-3.8l1.9-1.9a2.7 2.7 0 0 1 3.8 3.8l-1 1',
    'M9.3 6.7a2.7 2.7 0 0 1 0 3.8l-1.9 1.9a2.7 2.7 0 0 1-3.8-3.8l1-1',
  ],
  copy: [
    'M5.9 5.9h6.6a1 1 0 0 1 1 1v6.6a1 1 0 0 1-1 1H5.9a1 1 0 0 1-1-1V6.9a1 1 0 0 1 1-1z',
    'M3.5 10.6h-.6a1 1 0 0 1-1-1V3.5a1 1 0 0 1 1-1h6.1a1 1 0 0 1 1 1v.6',
  ],
  external: [
    'M9.6 2.6h3.8v3.8',
    'M13.4 2.6 7.4 8.6',
    'M12.2 9.4v3.1a1.1 1.1 0 0 1-1.1 1.1H3.3a1.1 1.1 0 0 1-1.1-1.1V4.7a1.1 1.1 0 0 1 1.1-1.1H6.4',
  ],
  more: { weight: 2.6, paths: ['M3.9 8h.01', 'M8 8h.01', 'M12.1 8h.01'] },
  'chevron-down': ['M4.2 6.4 8 10.2l3.8-3.8'],
  'chevron-right': ['M6.4 4.2 10.2 8l-3.8 3.8'],
  play: ['M5.4 3.4 12.4 8 5.4 12.6z'],
  pause: ['M6 3.4v9.2', 'M10 3.4v9.2'],
  rotate: ['M13.1 8a5.1 5.1 0 1 1-1.6-3.7', 'M13.2 2.6v3.3h-3.3'],
  skip: ['M4.2 4.2 9.8 8 4.2 11.8z', 'M11.6 4.2v7.6'],
  edit: ['M10.4 3.1 12.9 5.6 5.6 12.9 2.6 13.4l.5-3z', 'M9.1 4.4 11.6 6.9'],
  archive: [
    'M2.8 4.6h10.4v2.5H2.8z',
    'M3.9 7.1v5.3a1 1 0 0 0 1 1h6.2a1 1 0 0 0 1-1V7.1',
    'M6.3 9.7h3.4',
  ],
  unarchive: [
    'M2.8 4.6h10.4v2.5H2.8z',
    'M3.9 7.1v5.3a1 1 0 0 0 1 1h6.2a1 1 0 0 0 1-1V7.1',
    'M6.3 10.2h3.4',
    'M8 9.6V6.7',
    'M6.5 8.2 8 6.7l1.5 1.5',
  ],
  trash: [
    'M2.9 4.9h10.2',
    'M6.4 4.9V2.9h3.2v2',
    'M4.5 4.9l.6 8.1a1 1 0 0 0 1 .9h3.8a1 1 0 0 0 1-.9l.6-8.1',
    'M6.7 7.4v3.6',
    'M9.3 7.4v3.6',
  ],
  today: [
    'M3.9 3.4h8.2a1 1 0 0 1 1 1v8.2a1 1 0 0 1-1 1H3.9a1 1 0 0 1-1-1V4.4a1 1 0 0 1 1-1z',
    'M2.9 7.1h10.2',
    'M5.6 2.2v2.4',
    'M10.4 2.2v2.4',
    'M8 9.4a1 1 0 1 0 0 2a1 1 0 1 0 0-2',
  ],
  flow: [
    'M4.7 5.1 6.9 7.3',
    'M9.1 8.7 11.3 10.9',
    'M3.6 2.5a1.5 1.5 0 1 0 0 3a1.5 1.5 0 1 0 0-3',
    'M8 6.5a1.5 1.5 0 1 0 0 3a1.5 1.5 0 1 0 0-3',
    'M12.4 10.5a1.5 1.5 0 1 0 0 3a1.5 1.5 0 1 0 0-3',
  ],
  chat: [
    'M3.2 4.6a1.2 1.2 0 0 1 1.2-1.2h7.2a1.2 1.2 0 0 1 1.2 1.2v5a1.2 1.2 0 0 1-1.2 1.2H7.4L4.3 13v-2.2a1.2 1.2 0 0 1-1.1-1.2z',
  ],
  note: [
    'M4.4 2.6h7.2a1 1 0 0 1 1 1v8.8a1 1 0 0 1-1 1H4.4a1 1 0 0 1-1-1V3.6a1 1 0 0 1 1-1z',
    'M5.8 6.1h4.4',
    'M5.8 8.7h4.4',
    'M5.8 11.3h2.6',
  ],
  branch: [
    'M5.2 3.4a1.3 1.3 0 1 0 0 2.6a1.3 1.3 0 0 0 0-2.6z',
    'M10.8 10a1.3 1.3 0 1 0 0 2.6a1.3 1.3 0 0 0 0-2.6z',
    'M5.2 6v2.2a2 2 0 0 0 2 2h2.3',
  ],
  test: [
    'M4.2 3.2h7.6a1 1 0 0 1 1 1v7.6a1 1 0 0 1-1 1H4.2a1 1 0 0 1-1-1V4.2a1 1 0 0 1 1-1z',
    'M5.6 7.4 7 8.8l3.2-3.2',
  ],
  book: [
    'M3.4 3.6a1 1 0 0 1 1-1h3.2a1.6 1.6 0 0 1 1.6 1.6v8.4a1.2 1.2 0 0 0-1.2-1.2H3.4z',
    'M12.6 3.6a1 1 0 0 0-1-1H8.4a1.6 1.6 0 0 0-1.6 1.6v8.4a1.2 1.2 0 0 1 1.2-1.2h4.6z',
  ],
  report: [
    'M4.4 2.5h4.6L12.6 6v7.5a1 1 0 0 1-1 1H4.4a1 1 0 0 1-1-1V3.5a1 1 0 0 1 1-1z',
    'M9 2.5V6h3.6',
    'M5.9 8.4h4.4',
    'M5.9 10.9h3.2',
  ],
  handoff: [
    'M3.2 5.4h7.4',
    'M8.5 3.4 10.6 5.4 8.5 7.4',
    'M12.8 10.6H5.4',
    'M7.5 8.6 5.4 10.6 7.5 12.6',
  ],
  settings: [
    'M2.8 5.5h3.4',
    'M9.4 5.5h3.8',
    'M2.8 10.5h4.4',
    'M10.4 10.5h2.8',
    'M7.6 4.1a1.4 1.4 0 1 0 0 2.8a1.4 1.4 0 1 0 0-2.8',
    'M8.6 9.1a1.4 1.4 0 1 0 0 2.8a1.4 1.4 0 1 0 0-2.8',
  ],
  filter: ['M2.6 3.6h10.8L9.2 8.6v4.3l-2.4 1.2V8.6z'],
  search: ['M7 3.2a3.8 3.8 0 1 0 0 7.6a3.8 3.8 0 1 0 0-7.6', 'M9.8 9.8 13 13'],
  refresh: ['M13 8a5 5 0 1 1-1.5-3.5', 'M13.1 2.8v3.2h-3.2'],
  dot: { weight: 3.4, paths: ['M8 8h.01'] },
  flag: ['M4 2.8v10.4', 'M4.4 3.4h7.2l-1.4 2.8 1.4 2.8H4.4z'],
  upload: ['M8 10.8V3.2', 'M4.8 6.4 8 3.2l3.2 3.2', 'M3 11.4v1.2a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1v-1.2'],
  download: ['M8 3.2v7.6', 'M4.8 7.6 8 10.8l3.2-3.2', 'M3 11.4v1.2a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1v-1.2'],
  spark: ['M8 2.2 9.3 6.1 13.2 7.4 9.3 8.7 8 12.6 6.7 8.7 2.8 7.4 6.7 6.1z'],
  moon: ['M13 9.6A5.7 5.7 0 0 1 6.4 3a5.7 5.7 0 1 0 6.6 6.6z'],
  sun: [
    'M8 5.3a2.7 2.7 0 1 0 0 5.4a2.7 2.7 0 1 0 0-5.4',
    'M8 1.9v1.5',
    'M8 12.6v1.5',
    'M1.9 8h1.5',
    'M12.6 8h1.5',
    'M3.7 3.7l1.1 1.1',
    'M11.2 11.2l1.1 1.1',
    'M3.7 12.3l1.1-1.1',
    'M11.2 4.8l1.1-1.1',
  ],
};

const FP_ICON_FALLBACK = ['M8 8h.01'];

/** 唯一图标入口：name 必须来自契约 §7.4；未知名字退化成一个圆点。 */
function FpIcon(props) {
  const p = props || {};
  const name = typeof p.name === 'string' ? p.name : '';
  const def = Object.prototype.hasOwnProperty.call(FP_ICON_DEFS, name) ? FP_ICON_DEFS[name] : null;
  const paths = def === null ? FP_ICON_FALLBACK : Array.isArray(def) ? def : def.paths;
  const weight = def !== null && !Array.isArray(def) && typeof def.weight === 'number' ? def.weight : 1.5;
  const size = typeof p.size === 'number' && p.size > 0 ? p.size : 16;
  const className = typeof p.className === 'string' && p.className !== '' ? 'fp-icon ' + p.className : 'fp-icon';
  const children = [];
  for (let index = 0; index < paths.length; index += 1) {
    children.push(h('path', { key: 'p' + index, d: paths[index] }));
  }
  return h(
    'svg',
    {
      className: className,
      width: size,
      height: size,
      viewBox: '0 0 16 16',
      fill: 'none',
      stroke: 'currentColor',
      strokeWidth: weight,
      strokeLinecap: 'round',
      strokeLinejoin: 'round',
      'aria-hidden': 'true',
      focusable: 'false',
    },
    children,
  );
}

/**
 * 侧栏图标（契约 §7.1 / §8）：流程节点连线。
 * 颜色跟随宿主 currentColor；active 时节点实心、连线加粗，不写死颜色。
 */
function FpSidebarGlyph(props) {
  const p = props || {};
  const size = typeof p.size === 'number' && p.size > 0 ? p.size : 18;
  const active = p.active === true;
  const lineWidth = active ? 1.8 : 1.4;
  const nodeWidth = active ? 1.9 : 1.4;
  const nodes = [
    { cx: 5.2, cy: 4.2 },
    { cx: 5.2, cy: 13.8 },
    { cx: 12.9, cy: 9 },
  ];
  return h(
    'svg',
    {
      className: 'fp-icon',
      width: size,
      height: size,
      viewBox: '0 0 18 18',
      fill: 'none',
      'aria-hidden': 'true',
      focusable: 'false',
      style: { display: 'block', color: 'currentColor', opacity: active ? 1 : 0.86 },
    },
    [
      h('path', {
        key: 'stem',
        d: 'M5.2 6.4v5.2',
        stroke: 'currentColor',
        strokeWidth: lineWidth,
        strokeLinecap: 'round',
        opacity: 0.55,
      }),
      h('path', {
        key: 'fork-a',
        d: 'M6.9 5.3 11.1 7.9',
        stroke: 'currentColor',
        strokeWidth: lineWidth,
        strokeLinecap: 'round',
        opacity: 0.55,
      }),
      h('path', {
        key: 'fork-b',
        d: 'M6.9 12.7 11.1 10.1',
        stroke: 'currentColor',
        strokeWidth: lineWidth,
        strokeLinecap: 'round',
        opacity: 0.55,
      }),
    ].concat(
      nodes.map(function (node, index) {
        return h('circle', {
          key: 'node' + index,
          cx: node.cx,
          cy: node.cy,
          r: active ? 1.9 : 1.7,
          fill: active ? 'currentColor' : 'none',
          stroke: 'currentColor',
          strokeWidth: nodeWidth,
        });
      }),
    ),
  );
}

/* ------------------------------------------------------------------ *
 * 内部小工具
 * ------------------------------------------------------------------ */

/** icon prop 允许写图标名，也允许直接传 React 元素。 */
function fpPrimIconNode(value) {
  if (value === null || value === undefined || value === false) return null;
  if (typeof value === 'string') return h(FpIcon, { name: value });
  return value;
}

/** actions 允许传单个节点或节点数组，统一渲染。 */
function fpPrimNodeList(value) {
  if (value === null || value === undefined || value === false || value === true) return null;
  if (!Array.isArray(value)) return value;
  const nodes = [];
  for (let index = 0; index < value.length; index += 1) {
    const item = value[index];
    if (item === null || item === undefined || item === false || item === true) continue;
    const key = item && item.key !== undefined && item.key !== null ? item.key : 'fp-prim-' + index;
    nodes.push(h(React.Fragment, { key: key }, item));
  }
  return nodes.length > 0 ? nodes : null;
}

/** 取容器内可聚焦元素（供 FpDialog 焦点陷阱用）。 */
function fpPrimFocusables(container) {
  if (!container || typeof container.querySelectorAll !== 'function') return [];
  const selector =
    'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';
  let list = [];
  try {
    list = Array.prototype.slice.call(container.querySelectorAll(selector));
  } catch (error) {
    return [];
  }
  return list.filter(function (element) {
    if (!element || typeof element.focus !== 'function') return false;
    if (element.getAttribute && element.getAttribute('aria-hidden') === 'true') return false;
    return element.offsetParent !== null || (typeof document !== 'undefined' && element === document.activeElement);
  });
}

/** Tab / Shift+Tab 在弹窗内循环。 */
function fpPrimTrapTab(event, container) {
  if (!container || !event || event.key !== 'Tab') return;
  const list = fpPrimFocusables(container);
  if (list.length === 0) return;
  const first = list[0];
  const last = list[list.length - 1];
  const active = typeof document !== 'undefined' ? document.activeElement : null;
  const inside = active !== null && typeof container.contains === 'function' && container.contains(active);
  if (event.shiftKey === true) {
    if (!inside || active === first) {
      event.preventDefault();
      last.focus();
    }
    return;
  }
  if (!inside || active === last) {
    event.preventDefault();
    first.focus();
  }
}

/* ------------------------------------------------------------------ *
 * Toast：模块级队列 + 订阅；FpToast.push 可在任何文件里调用
 * ------------------------------------------------------------------ */

const FP_TOAST_QUEUE = { items: [], listeners: [], seq: 0 };
let FP_DIALOG_SEQ = 0;
const FP_TOAST_ICON = { info: 'spark', success: 'check', error: 'alert' };

function fpPrimToastEmit() {
  const snapshot = FP_TOAST_QUEUE.items.slice();
  const listeners = FP_TOAST_QUEUE.listeners.slice();
  for (let index = 0; index < listeners.length; index += 1) {
    try {
      listeners[index](snapshot);
    } catch (error) {
      /* 单个订阅者异常不影响其它订阅者 */
    }
  }
}

function fpPrimToastDrop(id) {
  const next = [];
  for (let index = 0; index < FP_TOAST_QUEUE.items.length; index += 1) {
    if (FP_TOAST_QUEUE.items[index].id !== id) next.push(FP_TOAST_QUEUE.items[index]);
  }
  if (next.length === FP_TOAST_QUEUE.items.length) return;
  FP_TOAST_QUEUE.items = next;
  fpPrimToastEmit();
}

function FpToastPush(options) {
  const opts = options !== null && typeof options === 'object' ? options : {};
  const text = typeof opts.text === 'string' && opts.text !== '' ? opts.text : typeof opts.title === 'string' ? opts.title : '';
  if (text === '') return null;
  const tone = opts.tone === 'success' || opts.tone === 'error' ? opts.tone : 'info';
  const timeout = typeof opts.timeout === 'number' && opts.timeout >= 0 ? opts.timeout : 3200;
  FP_TOAST_QUEUE.seq += 1;
  const item = { id: FP_TOAST_QUEUE.seq, tone: tone, text: text };
  FP_TOAST_QUEUE.items = FP_TOAST_QUEUE.items.concat([item]).slice(-4);
  fpPrimToastEmit();
  if (timeout > 0) {
    const timer = setTimeout(function () {
      fpPrimToastDrop(item.id);
    }, timeout);
    if (timer && typeof timer.unref === 'function') timer.unref();
  }
  return item.id;
}

/** 全局单例：FpToast.push({ tone:'success'|'error'|'info', text, timeout? }) */
const FpToast = { push: FpToastPush };

function FpToastHost() {
  const [items, setItems] = useState(function () {
    return FP_TOAST_QUEUE.items.slice();
  });
  useEffect(function () {
    const listener = function (snapshot) {
      setItems(snapshot);
    };
    FP_TOAST_QUEUE.listeners.push(listener);
    // 订阅时补一次：在 Host 挂载前 push 的消息不应丢失
    setItems(FP_TOAST_QUEUE.items.slice());
    return function () {
      const index = FP_TOAST_QUEUE.listeners.indexOf(listener);
      if (index !== -1) FP_TOAST_QUEUE.listeners.splice(index, 1);
    };
  }, []);
  if (!Array.isArray(items) || items.length === 0) return null;
  return h(
    'div',
    { className: 'fp-toast-host', role: 'status', 'aria-live': 'polite', 'aria-atomic': 'false' },
    items.map(function (item) {
      return h(
        'div',
        {
          key: item.id,
          className: 'fp-toast fp-toast--' + item.tone,
          role: item.tone === 'error' ? 'alert' : 'status',
          title: '点击关闭',
          onClick: function () {
            fpPrimToastDrop(item.id);
          },
        },
        h('span', { className: 'fp-toast__icon' }, h(FpIcon, { name: FP_TOAST_ICON[item.tone] || 'spark', size: 13 })),
        h('span', { className: 'fp-toast__text' }, item.text),
      );
    }),
  );
}

/* ------------------------------------------------------------------ *
 * 基础控件（契约 §7.1，全部受控、无业务副作用）
 * ------------------------------------------------------------------ */

function FpButton(props) {
  const p = props || {};
  const variant =
    p.variant === 'primary' || p.variant === 'ghost' || p.variant === 'quiet' || p.variant === 'danger'
      ? p.variant
      : 'default';
  const size = p.size === 'sm' ? 'sm' : 'md';
  const disabled = p.disabled === true;
  const children = p.children;
  const hasLabel = children !== undefined && children !== null && children !== false && children !== true && children !== '';
  const classes = ['fp-btn', 'fp-btn--' + variant];
  if (size === 'sm') classes.push('fp-btn--sm');
  if (p.fullWidth === true) classes.push('fp-btn--full');
  if (typeof p.className === 'string' && p.className !== '') classes.push(p.className);
  const iconNode = fpPrimIconNode(p.icon);
  const iconRightNode = fpPrimIconNode(p.iconRight);
  return h(
    'button',
    {
      type: 'button',
      className: classes.join(' '),
      disabled: disabled,
      title: typeof p.title === 'string' ? p.title : undefined,
      'aria-label':
        typeof p.ariaLabel === 'string' && p.ariaLabel !== '' ? p.ariaLabel : hasLabel ? undefined : typeof p.title === 'string' ? p.title : undefined,
      onClick: disabled ? undefined : p.onClick,
    },
    iconNode === null ? null : h('span', { className: 'fp-btn__icon' }, iconNode),
    hasLabel ? h('span', { className: 'fp-btn__label' }, children) : null,
    iconRightNode === null ? null : h('span', { className: 'fp-btn__icon' }, iconRightNode),
  );
}

function FpIconButton(props) {
  const p = props || {};
  const size = typeof p.size === 'number' && p.size > 0 ? p.size : 28;
  const disabled = p.disabled === true;
  const classes = ['fp-icon-btn'];
  if (p.active === true) classes.push('fp-icon-btn--active');
  if (typeof p.className === 'string' && p.className !== '') classes.push(p.className);
  const label = typeof p.label === 'string' && p.label !== '' ? p.label : typeof p.title === 'string' ? p.title : '按钮';
  return h(
    'button',
    {
      type: 'button',
      className: classes.join(' '),
      style: { width: size + 'px', height: size + 'px' },
      title: typeof p.title === 'string' ? p.title : label,
      'aria-label': label,
      'aria-pressed': p.active === true ? 'true' : undefined,
      disabled: disabled,
      onClick: disabled ? undefined : p.onClick,
    },
    p.children === undefined || p.children === null ? null : p.children,
  );
}

const FP_CHIP_TONES = ['muted', 'idle', 'brand', 'accent', 'success', 'warn', 'error', 'amber'];

function FpChip(props) {
  const p = props || {};
  const tone = FP_CHIP_TONES.indexOf(p.tone) !== -1 ? p.tone : 'muted';
  const size = p.size === 'md' ? 'md' : 'sm';
  const clickable = typeof p.onClick === 'function';
  const classes = ['fp-chip', 'fp-chip--' + tone];
  if (size === 'md') classes.push('fp-chip--md');
  if (clickable) classes.push('fp-chip--clickable');
  if (typeof p.className === 'string' && p.className !== '') classes.push(p.className);
  const children = [
    p.dot === true ? h('span', { key: 'dot', className: 'fp-chip__dot', 'aria-hidden': 'true' }) : null,
    h('span', { key: 'text', className: 'fp-chip__text' }, p.children),
  ];
  const shared = {
    className: classes.join(' '),
    title: typeof p.title === 'string' ? p.title : undefined,
  };
  if (!clickable) return h('span', shared, children);
  return h('button', Object.assign({ type: 'button', onClick: p.onClick }, shared), children);
}

function FpStatusChip(props) {
  const p = props || {};
  const status = typeof p.status === 'string' ? p.status : '';
  const meta = FP_STATUS[status] || null;
  const tone = meta !== null ? meta.tone : 'muted';
  const label = meta !== null ? meta.label : status !== '' ? status : '未知';
  return h(FpChip, {
    tone: tone,
    size: p.size === 'md' ? 'md' : 'sm',
    dot: true,
    title: meta !== null && typeof meta.hint === 'string' ? meta.hint : label,
  }, label);
}

function FpInput(props) {
  const p = props || {};
  const style = {};
  if (p.width !== undefined && p.width !== null) {
    style.width = typeof p.width === 'number' ? p.width + 'px' : String(p.width);
  }
  const value = p.value === undefined || p.value === null ? '' : p.value;
  return h('input', {
    className: 'fp-input',
    type: typeof p.type === 'string' && p.type !== '' ? p.type : 'text',
    value: value,
    placeholder: typeof p.placeholder === 'string' ? p.placeholder : undefined,
    disabled: p.disabled === true,
    autoFocus: p.autoFocus === true,
    style: style,
    'aria-label': typeof p.ariaLabel === 'string' ? p.ariaLabel : undefined,
    onChange: function (event) {
      if (typeof p.onChange === 'function') p.onChange(event && event.target ? event.target.value : '');
    },
    onKeyDown: function (event) {
      if (typeof p.onKeyDown === 'function') p.onKeyDown(event);
      if (event && event.key === 'Enter' && typeof p.onEnter === 'function') p.onEnter(event);
    },
  });
}

function FpTextarea(props) {
  const p = props || {};
  const rows = typeof p.rows === 'number' && p.rows > 0 ? p.rows : 3;
  const value = p.value === undefined || p.value === null ? '' : p.value;
  return h('textarea', {
    className: 'fp-textarea',
    rows: rows,
    value: value,
    placeholder: typeof p.placeholder === 'string' ? p.placeholder : undefined,
    disabled: p.disabled === true,
    autoFocus: p.autoFocus === true,
    'aria-label': typeof p.ariaLabel === 'string' ? p.ariaLabel : undefined,
    onChange: function (event) {
      if (typeof p.onChange === 'function') p.onChange(event && event.target ? event.target.value : '');
    },
    onKeyDown: typeof p.onKeyDown === 'function' ? p.onKeyDown : undefined,
  });
}

function FpSelect(props) {
  const p = props || {};
  const options = Array.isArray(p.options) ? p.options : [];
  const style = {};
  if (p.width !== undefined && p.width !== null) {
    style.width = typeof p.width === 'number' ? p.width + 'px' : String(p.width);
  }
  const current = p.value === undefined || p.value === null ? '' : String(p.value);
  const items = options.map(function (option, index) {
    const opt = option !== null && typeof option === 'object' ? option : { value: option, label: String(option) };
    const optValue = opt.value === undefined || opt.value === null ? '' : String(opt.value);
    return h('option', { key: 'opt-' + index + '-' + optValue, value: optValue }, opt.label === undefined ? optValue : String(opt.label));
  });
  return h(
    'span',
    { className: 'fp-select-wrap', style: style },
    h(
      'select',
      {
        className: 'fp-select',
        value: current,
        disabled: p.disabled === true,
        'aria-label': typeof p.ariaLabel === 'string' ? p.ariaLabel : undefined,
        onChange: function (event) {
          if (typeof p.onChange === 'function') p.onChange(event && event.target ? event.target.value : '');
        },
      },
      items,
    ),
    h(FpIcon, { name: 'chevron-down', size: 12, className: 'fp-select__icon' }),
  );
}

function FpSwitch(props) {
  const p = props || {};
  const checked = p.checked === true;
  const disabled = p.disabled === true;
  return h(
    'button',
    {
      type: 'button',
      className: 'fp-switch',
      role: 'switch',
      'aria-checked': checked ? 'true' : 'false',
      disabled: disabled,
      onClick: disabled
        ? undefined
        : function () {
            if (typeof p.onChange === 'function') p.onChange(!checked);
          },
    },
    h('span', { className: 'fp-switch__track', 'aria-hidden': 'true' }, h('span', { className: 'fp-switch__thumb' })),
    p.label !== undefined || p.description !== undefined
      ? h(
          'span',
          { className: 'fp-switch__text' },
          p.label !== undefined && p.label !== null ? h('span', { className: 'fp-switch__label' }, p.label) : null,
          p.description !== undefined && p.description !== null
            ? h('span', { className: 'fp-switch__desc' }, p.description)
            : null,
        )
      : null,
  );
}

function FpField(props) {
  const p = props || {};
  return h(
    'div',
    { className: 'fp-field' },
    p.label !== undefined && p.label !== null && p.label !== ''
      ? h(
          'span',
          { className: 'fp-field__label' },
          p.label,
          p.required === true ? h('em', { className: 'fp-field__req', 'aria-hidden': 'true' }, '*') : null,
        )
      : null,
    p.children === undefined ? null : p.children,
    p.hint !== undefined && p.hint !== null && p.hint !== '' ? h('p', { className: 'fp-field__hint' }, p.hint) : null,
  );
}

function FpSection(props) {
  const p = props || {};
  const hasHead =
    (p.title !== undefined && p.title !== null && p.title !== '') ||
    (p.hint !== undefined && p.hint !== null && p.hint !== '') ||
    (p.actions !== undefined && p.actions !== null);
  return h(
    'section',
    { className: 'fp-section' },
    hasHead
      ? h(
          'header',
          { className: 'fp-section__head' },
          h(
            'div',
            { className: 'fp-section__titles' },
            p.title !== undefined && p.title !== null && p.title !== ''
              ? h('h3', { className: 'fp-section__title' }, p.title)
              : null,
            p.hint !== undefined && p.hint !== null && p.hint !== ''
              ? h('p', { className: 'fp-section__hint' }, p.hint)
              : null,
          ),
          p.actions === undefined || p.actions === null
            ? null
            : h('div', { className: 'fp-section__actions' }, fpPrimNodeList(p.actions)),
        )
      : null,
    h('div', { className: 'fp-section__body' }, p.children),
  );
}

function FpDialog(props) {
  const p = props || {};
  const open = p.open === true;
  const dialogRef = useRef(null);
  const restoreRef = useRef(null);
  const closeRef = useRef(p.onClose);
  closeRef.current = p.onClose;
  const openRef = useRef(open);
  openRef.current = open;

  useEffect(
    function () {
      if (!open) return undefined;
      if (typeof document !== 'undefined') restoreRef.current = document.activeElement;
      const timer = setTimeout(function () {
        const node = dialogRef.current;
        if (!node || typeof node.querySelector !== 'function') return;
        let target = null;
        try {
          target = node.querySelector('[data-fp-autofocus="true"]');
          if (!target) {
            target = node.querySelector('input:not([type="hidden"]), textarea, select, button');
          }
        } catch (error) {
          target = null;
        }
        if (target && typeof target.focus === 'function') {
          target.focus();
        } else if (typeof node.focus === 'function') {
          try {
            node.setAttribute('tabindex', '-1');
          } catch (error) {
            /* 无 setAttribute 时忽略 */
          }
          node.focus();
        }
      }, 0);
      return function () {
        clearTimeout(timer);
        const previous = restoreRef.current;
        restoreRef.current = null;
        if (previous && typeof previous.focus === 'function') {
          try {
            previous.focus();
          } catch (error) {
            /* 元素可能已卸载 */
          }
        }
      };
    },
    [open],
  );

  if (!open) return null;

  const width = typeof p.width === 'number' && p.width > 0 ? p.width : 480;
  const classes = ['fp-dialog'];
  if (p.danger === true) classes.push('fp-dialog--danger');
  const titleIdRef = useRef(null);
  if (titleIdRef.current === null) {
    FP_DIALOG_SEQ += 1;
    titleIdRef.current = 'fp-dialog-title-' + FP_DIALOG_SEQ;
  }
  const titleId = titleIdRef.current;
  const handleKeyDown = function (event) {
    if (!event) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      if (typeof closeRef.current === 'function') closeRef.current();
      return;
    }
    if (event.key === 'Tab') fpPrimTrapTab(event, dialogRef.current);
  };
  return h(
    'div',
    { className: 'fp-dialog-layer' },
    h('button', {
      type: 'button',
      className: 'fp-dialog__backdrop',
      'aria-label': '关闭对话框',
      tabIndex: -1,
      onClick: function () {
        if (p.closeOnBackdrop !== false && typeof closeRef.current === 'function') closeRef.current();
      },
    }),
    h(
      'div',
      {
        ref: dialogRef,
        className: classes.join(' '),
        role: 'dialog',
        'aria-modal': 'true',
        'aria-labelledby': p.title !== undefined && p.title !== null && p.title !== '' ? titleId : undefined,
        'aria-label':
          p.title !== undefined && p.title !== null && p.title !== ''
            ? undefined
            : typeof p.ariaLabel === 'string'
              ? p.ariaLabel
              : '对话框',
        style: { width: width + 'px' },
        onKeyDown: handleKeyDown,
      },
      h(
        'header',
        { className: 'fp-dialog__head' },
        h(
          'div',
          { className: 'fp-dialog__titles' },
          p.title !== undefined && p.title !== null && p.title !== ''
            ? h('h2', { className: 'fp-dialog__title', id: titleId }, p.title)
            : null,
          p.description !== undefined && p.description !== null && p.description !== ''
            ? h('p', { className: 'fp-dialog__desc' }, p.description)
            : null,
        ),
        typeof closeRef.current === 'function'
          ? h(
              FpIconButton,
              { label: '关闭', title: '关闭', size: 24, onClick: closeRef.current },
              h(FpIcon, { name: 'x', size: 13 }),
            )
          : null,
      ),
      h('div', { className: 'fp-dialog__body' }, p.children),
      p.actions !== undefined && p.actions !== null
        ? h('footer', { className: 'fp-dialog__foot' }, fpPrimNodeList(p.actions))
        : null,
    ),
  );
}

function FpConfirm(props) {
  const p = props || {};
  const cancel = typeof p.onCancel === 'function' ? p.onCancel : p.onClose;
  const actions = [
    h(
      FpButton,
      {
        key: 'cancel',
        variant: 'ghost',
        onClick: function () {
          if (typeof cancel === 'function') cancel();
        },
      },
      typeof p.cancelLabel === 'string' && p.cancelLabel !== '' ? p.cancelLabel : '取消',
    ),
    h(
      FpButton,
      {
        key: 'confirm',
        variant: p.danger === true ? 'danger' : 'primary',
        onClick: function () {
          if (typeof p.onConfirm === 'function') p.onConfirm();
        },
      },
      typeof p.confirmLabel === 'string' && p.confirmLabel !== '' ? p.confirmLabel : '确认',
    ),
  ];
  return h(
    FpDialog,
    {
      open: p.open === true,
      title: p.title,
      width: 420,
      danger: p.danger === true,
      onClose: function () {
        if (typeof cancel === 'function') cancel();
      },
      actions: actions,
    },
    typeof p.message === 'string' && p.message !== ''
      ? h('p', { className: 'fp-confirm-message' }, p.message)
      : p.message !== undefined
        ? p.message
        : null,
  );
}

function FpEmptyState(props) {
  const p = props || {};
  const iconNode = p.icon === undefined || p.icon === null ? h(FpIcon, { name: 'flow', size: 18 }) : fpPrimIconNode(p.icon);
  return h(
    'div',
    { className: 'fp-empty' },
    h('div', { className: 'fp-empty__icon' }, iconNode),
    p.title !== undefined && p.title !== null && p.title !== ''
      ? h('p', { className: 'fp-empty__title' }, p.title)
      : null,
    p.description !== undefined && p.description !== null && p.description !== ''
      ? h('p', { className: 'fp-empty__desc' }, p.description)
      : null,
    p.actions === undefined || p.actions === null
      ? null
      : h('div', { className: 'fp-empty__actions' }, fpPrimNodeList(p.actions)),
  );
}

function FpSpinner(props) {
  const p = props || {};
  return h(
    'span',
    { className: 'fp-spinner-wrap', role: 'status', 'aria-live': 'polite' },
    h('span', { className: 'fp-spinner', 'aria-hidden': 'true' }),
    p.label !== undefined && p.label !== null && p.label !== ''
      ? h('span', { className: 'fp-spinner-label' }, p.label)
      : null,
  );
}

function FpDivider() {
  return h('div', { className: 'fp-divider', role: 'separator', 'aria-orientation': 'horizontal' });
}
