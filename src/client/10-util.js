/* ===== 归属：Lead · 共享常量、日期工具、查询辅助、文案桥 =====
 * 这一层是所有 client 片段共用的地基：状态语义、模板元信息、日期格式化、
 * state 查询辅助。它只做「读」，不含任何业务写规则（写规则在宿主半）。
 */

const FP_MS_DAY = 86400000;

/* ------------------------------------------------------------------ *
 * 状态语义：顺序即流程推进顺序（契约 §6.1）
 * ------------------------------------------------------------------ */
const FP_STATUS = {
  locked: { label: '未解锁', tone: 'idle', actionable: false, done: false, follow: false, hint: '前置节点未完成，仅可预览' },
  ready: { label: '待开始', tone: 'brand', actionable: true, done: false, follow: false, hint: '已满足执行条件，可以开始' },
  active: { label: '进行中', tone: 'accent', actionable: true, done: false, follow: false, hint: '你正在处理这个节点' },
  waiting: { label: '待确认', tone: 'warn', actionable: false, done: false, follow: true, hint: '等待产品/设计/研发反馈' },
  blocked: { label: '已阻塞', tone: 'error', actionable: false, done: false, follow: true, hint: '有依赖或问题无法推进' },
  revision: { label: '待修改', tone: 'amber', actionable: true, done: false, follow: false, hint: '确认未通过，需要返工' },
  completed: { label: '已完成', tone: 'success', actionable: false, done: true, follow: false, hint: '已满足完成条件' },
  skipped: { label: '已跳过', tone: 'muted', actionable: false, done: true, follow: false, hint: '经人工判断不适用，不计入成果' },
};

const FP_STATUS_ORDER = ['locked', 'ready', 'active', 'waiting', 'blocked', 'revision', 'completed', 'skipped'];

const FP_TEMPLATE_META = {
  delivery: {
    title: '设计交付流程',
    short: '设计交付',
    accent: 'var(--fp-accent)',
    desc: '设计稿交互框架 → 交互确认 → Figma 细化 → 最终确认 → 研发交付',
  },
  acceptance: {
    title: '验收流程',
    short: '验收',
    accent: 'color-mix(in srgb, var(--fp-accent) 52%, var(--fp-text-dim))',
    desc: '验收计划 → 研发提交 → 验收文件 → 设计调整 → 研发同步',
  },
};

const FP_LINK_KINDS = [
  { value: 'design', label: '设计稿' },
  { value: 'figma', label: 'Figma' },
  { value: 'doc', label: '需求文档' },
  { value: 'other', label: '其他' },
];

const FP_VIEWS = [
  { id: 'flow', label: '流程', icon: 'flow' },
  { id: 'today', label: '今日', icon: 'today' },
  { id: 'weekly', label: '周报', icon: 'report' },
  { id: 'handoff', label: '交接', icon: 'handoff' },
];

/* ------------------------------ 主题色 ------------------------------
 * 只换色相，保持每个令牌自己的饱和度/明度（用户要求「保持明度等，只能换色调」）。
 * 令牌原值：accent #b753ff(h275 s100 l66.3) / #bb5cff(h275 s100 l68)
 *           strong #ad3bff(h275 s100 l61.6) / #ae52f0(h275 s84  l63.1)
 */
const FP_ACCENT_STORE_KEY = 'flowpilot.accentHue';
const FP_ACCENT_DEFAULT_HUE = 275;
const FP_ACCENT_PRESETS = [
  { id: 'purple', label: '紫色', hue: 275 },
  { id: 'blue', label: '蓝色', hue: 216 },
  { id: 'pink', label: '品牌粉', hue: 343 },
];

function fpClampHue(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return FP_ACCENT_DEFAULT_HUE;
  const wrapped = ((num % 360) + 360) % 360;
  return Math.round(wrapped * 10) / 10;
}

function fpAccentHueRead() {
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(FP_ACCENT_STORE_KEY) : null;
    if (raw === null || raw === undefined || raw === '') return FP_ACCENT_DEFAULT_HUE;
    return fpClampHue(raw);
  } catch (error) {
    return FP_ACCENT_DEFAULT_HUE;
  }
}

function fpAccentCss(hue) {
  const h = fpClampHue(hue);
  return {
    accent: 'light-dark(hsl(' + h + ' 100% 66.3%), hsl(' + h + ' 100% 68%))',
    strong: 'light-dark(hsl(' + h + ' 100% 61.6%), hsl(' + h + ' 84% 63.1%))',
  };
}

/** 应用主题色（纯客户端偏好，立即生效，不写宿主数据）。 */
function fpApplyAccentHue(hue, persist) {
  const h = fpClampHue(hue);
  const css = fpAccentCss(h);
  try {
    if (typeof document !== 'undefined' && document.documentElement) {
      document.documentElement.style.setProperty('--fp-accent', css.accent);
      document.documentElement.style.setProperty('--fp-accent-strong', css.strong);
    }
  } catch (error) {
    /* 无 DOM 时静默 */
  }
  if (persist !== false) {
    try {
      if (typeof localStorage !== 'undefined') localStorage.setItem(FP_ACCENT_STORE_KEY, String(h));
    } catch (error) {
      /* 隐私模式下忽略 */
    }
  }
  return h;
}

/* 节点包模板（只能「追加」进已有流程，不能当流程模板用）：与宿主 appendTemplate 的模板表一一对应。 */
const FP_NODE_PACK_TEMPLATES = [
  {
    id: 'experiment',
    title: '实验推进',
    short: '实验',
    prefix: 'E',
    hint: '预跑 → 5% 白名单 → 50% 灰度 → 推全，每阶段一个节点，自动带 plannedAt（按开始时间 + 天数偏移）',
    nodes: [
      { title: '预跑观测', offsetDays: 0, assigneeRole: '研发', detail: '小流量预跑，观察 7 天核心指标与异常' },
      { title: '5% 白名单', offsetDays: 7, assigneeRole: '研发', detail: '5% 白名单放量，核对实验组/对照组指标' },
      { title: '50% 灰度', offsetDays: 14, assigneeRole: '研发', detail: '50% 灰度放量，观察稳定性与收益' },
      { title: '推全', offsetDays: 21, assigneeRole: '研发', detail: '全量推送，回收实验结论' },
    ],
  },
];

function fpNodePackTemplate(id) {
  const key = typeof id === 'string' ? id : '';
  return FP_NODE_PACK_TEMPLATES.filter(function (item) { return item.id === key; })[0] || null;
}

/* 事件类型 → 中文标签（时间线、周报辅助都用它） */
const FP_EVENT_LABELS = {
  projectCreated: '创建项目',
  projectUpdated: '更新项目',
  projectArchived: '归档变更',
  flowAdded: '新增流程',
  nodeAdded: '新增节点',
  nodeRemoved: '删除节点',
  nodeStatus: '状态变更',
  unlocked: '解锁后继',
  approvalPassed: '确认通过',
  approvalRejected: '确认退回',
  revision: '返工',
  linkAdded: '添加链接',
  linkRemoved: '删除链接',
  scheduleChanged: '调整时间',
  notesChanged: '更新笔记',
  handoffSaved: '日终交接',
  reportGenerated: '生成周报',
  reportEdited: '编辑周报',
  settingsChanged: '更新设置',
  manualNote: '补充记录',
  seeded: '载入示例',
};

const FP_REASON_LABELS = {
  overdue: '已逾期',
  dueSoon: '临近截止',
  active: '进行中',
  revision: '待修改',
  ready: '待开始',
  followUp: '等待跟进',
};

const FP_PERIOD_LABELS = {
  morning: '启动与预热',
  afternoon: '主要工作输出',
  evening: '持续交付与收尾',
  noonBreak: '午间间隔',
  eveningGap: '晚间间隔',
  offHours: '非工作时段',
  weekend: '休息日',
};

/* 文案桥：80-apply.js 会把 ctx.locale 绑定结果塞进 FP_UI.t；
 * 组件统一用 FP_T('key', '中文兜底')，没有 locale 服务时也能正常显示。 */
const FP_UI = { t: null, locale: 'zh' };

function FP_T(key, fallback) {
  const bound = FP_UI.t;
  if (typeof bound === 'function') {
    try {
      const value = bound(key);
      if (typeof value === 'string' && value !== '' && value !== key) return value;
    } catch (error) {
      /* locale 服务异常时退回中文 */
    }
  }
  return fallback;
}

/* ------------------------------------------------------------------ *
 * 日期 / 数字小工具（纯函数）
 * ------------------------------------------------------------------ */
function fpPad(n) {
  return n < 10 ? '0' + n : String(n);
}

function fpParseDate(value) {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'string') {
    const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
    if (dateOnly) return new Date(Number(dateOnly[1]), Number(dateOnly[2]) - 1, Number(dateOnly[3]));
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function fpDateOnly(value) {
  const date = fpParseDate(value) || new Date();
  return date.getFullYear() + '-' + fpPad(date.getMonth() + 1) + '-' + fpPad(date.getDate());
}

function fpStartOfDay(date) {
  const d = fpParseDate(date) || new Date();
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

function fpFmtDay(value, now) {
  const date = fpParseDate(value);
  if (!date) return '—';
  const base = fpParseDate(now) || new Date();
  const prefix = date.getFullYear() === base.getFullYear() ? '' : date.getFullYear() + '年';
  return prefix + (date.getMonth() + 1) + '月' + date.getDate() + '日';
}

function fpFmtTime(value) {
  const date = fpParseDate(value);
  if (!date) return '—';
  return fpPad(date.getHours()) + ':' + fpPad(date.getMinutes());
}

function fpFmtDateTime(value, now) {
  const date = fpParseDate(value);
  if (!date) return '—';
  return fpFmtDay(date, now) + ' ' + fpFmtTime(date);
}

function fpFmtRange(startValue, endValue) {
  const start = fpParseDate(startValue);
  const end = fpParseDate(endValue);
  if (!start || !end) return '—';
  return fpFmtDay(start) + '—' + fpFmtDay(end);
}

function fpDaysLeft(value, now) {
  const date = fpParseDate(value);
  if (!date) return null;
  const base = fpParseDate(now) || new Date();
  const diff = fpStartOfDay(date).getTime() - fpStartOfDay(base).getTime();
  return Math.round(diff / FP_MS_DAY);
}

function fpRelativeDay(value, now) {
  const days = fpDaysLeft(value, now);
  if (days === null) return '—';
  if (days === 0) return '今天';
  if (days === 1) return '明天';
  if (days === -1) return '昨天';
  if (days > 1) return days + ' 天后';
  return '逾期 ' + Math.abs(days) + ' 天';
}

function fpMinutesOfDay(hhmm) {
  if (typeof hhmm !== 'string') return null;
  const match = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

function fpHHMM(date) {
  const d = fpParseDate(date) || new Date();
  return fpPad(d.getHours()) + ':' + fpPad(d.getMinutes());
}

function fpIsWorkday(date, workdays) {
  const days = Array.isArray(workdays) && workdays.length > 0 ? workdays : [1, 2, 3, 4, 5];
  const d = fpParseDate(date) || new Date();
  const isoDay = d.getDay() === 0 ? 7 : d.getDay();
  return days.indexOf(isoDay) !== -1;
}

function fpWeekStart(value, weekStartsOn) {
  const startOn = typeof weekStartsOn === 'number' ? weekStartsOn : 1;
  const date = fpStartOfDay(value);
  const isoDay = date.getDay() === 0 ? 7 : date.getDay();
  const delta = (isoDay - startOn + 7) % 7;
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() - delta);
}

function fpNextWorkday(value, workdays, includeSelf) {
  let date = fpStartOfDay(value);
  if (!includeSelf) date = new Date(date.getTime() + FP_MS_DAY);
  for (let i = 0; i < 14; i += 1) {
    if (fpIsWorkday(date, workdays)) return date;
    date = new Date(date.getTime() + FP_MS_DAY);
  }
  return date;
}

function fpPrevWorkday(value, workdays, includeSelf) {
  let date = fpStartOfDay(value);
  if (!includeSelf) date = new Date(date.getTime() - FP_MS_DAY);
  for (let i = 0; i < 14; i += 1) {
    if (fpIsWorkday(date, workdays)) return date;
    date = new Date(date.getTime() - FP_MS_DAY);
  }
  return date;
}

function fpClamp(value, min, max) {
  if (typeof value !== 'number' || Number.isNaN(value)) return min;
  return Math.min(max, Math.max(min, value));
}

function fpUid(prefix) {
  return (prefix || 'id') + '_' + Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-4);
}

function fpGroupBy(list, pickKey) {
  const groups = new Map();
  (Array.isArray(list) ? list : []).forEach((item) => {
    const key = pickKey(item);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  });
  return groups;
}

function fpSortBy(list, pick, direction) {
  const dir = direction === 'desc' ? -1 : 1;
  return (Array.isArray(list) ? list.slice() : []).sort((a, b) => {
    const left = pick(a);
    const right = pick(b);
    if (left === right) return 0;
    if (left === null || left === undefined) return 1;
    if (right === null || right === undefined) return -1;
    return left > right ? dir : -dir;
  });
}

/** 把周报 markdown 降级成纯文本（复制用，PRD §7.3）。 */
function fpPlainText(markdown) {
  if (typeof markdown !== 'string') return '';
  return markdown
    .split('\n')
    .map((line) =>
      line
        .replace(/^#{1,6}\s*/, '')
        .replace(/\*\*(.+?)\*\*/g, '$1')
        .replace(/^\s*[-*]\s+/, '· '),
    )
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/* ------------------------------------------------------------------ *
 * 浏览器能力
 * ------------------------------------------------------------------ */
function fpHostRoot() {
  try {
    return document.querySelector('.fp-root') || document.querySelector('.fp-quick') || null;
  } catch (error) {
    return null;
  }
}

async function fpCopyText(text) {
  const value = typeof text === 'string' ? text : String(text || '');
  try {
    if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      await navigator.clipboard.writeText(value);
      return true;
    }
  } catch (error) {
    /* 落到 execCommand 兜底 */
  }
  try {
    const anchor = fpHostRoot();
    const area = document.createElement('textarea');
    area.value = value;
    area.setAttribute('readonly', 'readonly');
    area.style.position = 'fixed';
    area.style.top = '-1000px';
    area.style.opacity = '0';
    (anchor || document.documentElement).appendChild(area);
    area.select();
    const ok = document.execCommand('copy');
    area.remove();
    return ok;
  } catch (error) {
    return false;
  }
}

function fpDownload(filename, text, mime) {
  try {
    const blob = new Blob([text], { type: mime || 'application/json;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    anchor.rel = 'noopener';
    (fpHostRoot() || document.documentElement).appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
    return true;
  } catch (error) {
    return false;
  }
}

/* ------------------------------------------------------------------ *
 * state 查询辅助（只读）
 * ------------------------------------------------------------------ */
function fpArray(value) {
  return Array.isArray(value) ? value : [];
}

function fpProjectById(state, projectId) {
  return fpArray(state && state.projects).find((project) => project.id === projectId);
}

function fpNodeById(state, nodeId) {
  return fpArray(state && state.nodes).find((node) => node.id === nodeId);
}

function fpFlowById(state, flowId) {
  return fpArray(state && state.flows).find((flow) => flow.id === flowId);
}

function fpLineById(state, lineId) {
  return fpArray(state && state.businessLines).find((line) => line.id === lineId);
}

function fpProjectFlows(state, projectId) {
  return fpSortBy(
    fpArray(state && state.flows).filter((flow) => flow.projectId === projectId),
    (flow) => flow.sortOrder,
  );
}

function fpFlowNodes(state, flowId) {
  return fpSortBy(
    fpArray(state && state.nodes).filter((node) => node.flowId === flowId),
    (node) => node.sortOrder,
  );
}

function fpProjectNodes(state, projectId) {
  const flows = fpProjectFlows(state, projectId);
  const collected = [];
  flows.forEach((flow) => {
    fpFlowNodes(state, flow.id).forEach((node) => collected.push(node));
  });
  return collected;
}

function fpNodeLinks(state, nodeId) {
  return fpSortBy(
    fpArray(state && state.links).filter((link) => link.nodeId === nodeId),
    (link) => link.createdAt,
  );
}

function fpLineProjects(state, lineId, options) {
  const opts = options || {};
  const list = fpArray(state && state.projects).filter((project) => {
    if (project.businessLineId !== lineId) return false;
    if (opts.includeArchived) return true;
    return project.status !== 'archived';
  });
  return fpSortBy(list, (project) => project.createdAt, 'desc');
}

function fpActiveProjects(state) {
  return fpArray(state && state.projects).filter((project) => project.status !== 'archived');
}

function fpIsApprovalNode(node) {
  return !!(node && Array.isArray(node.approvalRoles) && node.approvalRoles.length > 0);
}

function fpHasDesignLink(links) {
  return fpArray(links).some((link) => link && link.kind === 'design');
}

/**
 * 本地预检（展示用；最终判定在宿主）。返回 {ok, code, error}。
 */
/** 证据策略默认值（与宿主一致）：至少 1 条任意类型链接。 */
const FP_EVIDENCE_DEFAULT = { kinds: [], minLinks: 1 };
const FP_EVIDENCE_KIND_LABELS = { design: '设计稿', figma: 'Figma', doc: '需求文档', other: '其他' };

/** 解析节点实际生效的证据策略：node → project → settings → 默认。 */
function fpEvidencePolicy(node, project, settings) {
  const candidates = [
    node !== null && node !== undefined ? node.evidencePolicy : null,
    project !== null && project !== undefined ? project.evidencePolicy : null,
    settings !== null && settings !== undefined ? settings.evidencePolicy : null,
  ];
  for (const candidate of candidates) {
    if (candidate !== null && candidate !== undefined && typeof candidate === 'object' && !Array.isArray(candidate)) {
      const kinds = fpArray(candidate.kinds).filter(function (kind) { return typeof kind === 'string' && kind !== ''; });
      const rawMin = Number(candidate.minLinks);
      const minLinks = Number.isFinite(rawMin) ? Math.max(0, Math.round(rawMin)) : 1;
      return { kinds: kinds, minLinks: minLinks };
    }
  }
  return { kinds: FP_EVIDENCE_DEFAULT.kinds.slice(), minLinks: FP_EVIDENCE_DEFAULT.minLinks };
}

/** 证据策略的人读文案（"需要至少 1 条 设计稿链接" / "至少 1 条任意类型链接"）。 */
function fpEvidenceText(policy) {
  const p = policy !== null && typeof policy === 'object' ? policy : FP_EVIDENCE_DEFAULT;
  const minLinks = Number.isFinite(Number(p.minLinks)) ? Math.max(0, Math.round(Number(p.minLinks))) : 1;
  if (minLinks === 0) return '不需要证据链接';
  const kinds = fpArray(p.kinds).map(function (kind) { return FP_EVIDENCE_KIND_LABELS[kind] || kind; });
  const kindText = kinds.length === 0 ? '任意类型' : kinds.join(' / ');
  return '至少 ' + minLinks + ' 条 ' + kindText + ' 链接';
}

/** 按策略统计可作为证据的链接数。 */
function fpEvidenceCount(links, policy) {
  const p = policy !== null && typeof policy === 'object' ? policy : FP_EVIDENCE_DEFAULT;
  const kinds = fpArray(p.kinds);
  return fpArray(links).filter(function (link) {
    if (link === null || typeof link !== 'object') return false;
    if (kinds.length === 0) return true;
    return kinds.indexOf(link.kind) !== -1;
  }).length;
}

function fpCanComplete(node, links, approvals, policy) {
  if (!node) return { ok: false, code: 'NOT_FOUND', error: '节点不存在' };
  const status = node.status;
  if (status === 'locked') return { ok: false, code: 'INVALID_STATE', error: '节点尚未解锁' };
  if (status === 'completed') return { ok: false, code: 'INVALID_STATE', error: '节点已完成' };
  if (status === 'skipped') return { ok: false, code: 'INVALID_STATE', error: '节点已跳过' };
  if (fpIsApprovalNode(node)) {
    const record = approvals || node.approvals || {};
    const missing = fpArray(node.approvalRoles).filter((role) => record[role] !== true);
    if (missing.length > 0) {
      return {
        ok: false,
        code: 'NEED_APPROVALS',
        error: '还需要' + missing.map((role) => (role === 'design' ? '设计' : '产品')).join('与') + '确认通过',
      };
    }
    const evidence = fpEvidencePolicy(node, null, null);
    const resolved = policy !== null && typeof policy === 'object' ? policy : evidence;
    const minLinks = Number.isFinite(Number(resolved.minLinks)) ? Math.max(0, Math.round(Number(resolved.minLinks))) : 1;
    if (minLinks > 0 && fpEvidenceCount(links, resolved) < minLinks) {
      return {
        ok: false,
        code: 'NEED_EVIDENCE',
        error: '请先补充确认依据：' + fpEvidenceText(resolved),
      };
    }
  }
  return { ok: true };
}

/**
 * 「下一个节点」导航用：同流程内 sortOrder 更大的第一个未完成节点 →
 * 否则该节点的跨流程 handoff 目标 → 否则同项目后续流程的首个未完成节点。
 * 只读，不改变任何状态。
 */
function fpNextNode(state, node) {
  if (state === null || state === undefined || node === null || node === undefined) return null;
  const isDone = (item) => item === null || item === undefined || item.status === 'completed' || item.status === 'skipped';
  const orderOf = (item) => (typeof item.sortOrder === 'number' ? item.sortOrder : Number(item.sortOrder) || 0);
  const sameFlow = fpSortBy(
    fpArray(state.nodes).filter((item) => item.flowId === node.flowId),
    orderOf,
  );
  const after = sameFlow.find((item) => orderOf(item) > orderOf(node) && !isDone(item));
  if (after) return after;
  const handoff = fpArray(state.dependencies)
    .filter((dep) => dep.relation === 'handoff' && dep.fromNodeId === node.id)
    .map((dep) => fpNodeById(state, dep.toNodeId))
    .find((item) => item !== null && item !== undefined && !isDone(item));
  if (handoff) return handoff;
  const flows = fpProjectFlows(state, node.projectId);
  const current = flows.find((flow) => flow.id === node.flowId) || null;
  const currentOrder = current === null ? -1 : orderOf(current);
  for (let index = 0; index < flows.length; index += 1) {
    const flow = flows[index];
    if (orderOf(flow) <= currentOrder) continue;
    const candidate = fpSortBy(
      fpArray(state.nodes).filter((item) => item.flowId === flow.id),
      orderOf,
    ).find((item) => !isDone(item));
    if (candidate) return candidate;
  }
  return null;
}

function fpEventsFor(state, options) {
  const opts = options || {};
  let list = fpArray(state && state.events);
  if (opts.projectId) list = list.filter((event) => event.projectId === opts.projectId);
  if (opts.nodeId) list = list.filter((event) => event.nodeId === opts.nodeId);
  if (opts.flowId) list = list.filter((event) => event.flowId === opts.flowId);
  const sorted = fpSortBy(list, (event) => event.timestamp, 'desc');
  const limit = typeof opts.limit === 'number' ? opts.limit : sorted.length;
  return sorted.slice(0, limit);
}

function fpProjectProgress(state, derived, projectId) {
  const summary = derived && derived.projects ? derived.projects[projectId] : null;
  if (summary) return summary;
  const nodes = fpProjectNodes(state, projectId);
  const completed = nodes.filter((node) => node.status === 'completed').length;
  const activeNode = nodes.find((node) => node.status === 'active') || nodes.find((node) => node.status === 'ready') || null;
  return {
    currentStage: activeNode ? activeNode.title : '—',
    currentCode: activeNode ? activeNode.code : null,
    activeNodeId: activeNode ? activeNode.id : null,
    actionable: nodes.filter((node) => FP_STATUS[node.status] && FP_STATUS[node.status].actionable).length,
    waiting: nodes.filter((node) => node.status === 'waiting' || node.status === 'blocked').length,
    total: nodes.length,
    completed,
    progress: nodes.length > 0 ? completed / nodes.length : 0,
    needsAttention: false,
    nextDueAt: null,
  };
}

function fpProjectTitle(state, projectId) {
  const project = fpProjectById(state, projectId);
  return project ? project.title : '未命名项目';
}

function fpLineName(state, lineId) {
  const line = fpLineById(state, lineId);
  return line ? line.name : '未分组';
}

/* ------------------------------------------------------------------ *
 * 基础样式：只在 fp- 命名空间内，颜色一律来自 --dsw-* 令牌
 * ------------------------------------------------------------------ */
const CSS_BASE = String.raw`
:root,
.fp-root,
.fp-quick,
.fp-settings-page {
  /* ===== 间距：4 栅格（4/8/12/16/20/24/32/40），所有 padding/margin/gap 只能用这些值 ===== */
  --fp-sp-1: 4px;
  --fp-sp-2: 8px;
  --fp-sp-3: 12px;
  --fp-sp-4: 16px;
  --fp-sp-5: 20px;
  --fp-sp-6: 24px;
  --fp-sp-8: 32px;
  --fp-sp-10: 40px;
  /* 代号别名（兼容既有写法） */
  --fp-gap-1: var(--fp-sp-1);
  --fp-gap-2: var(--fp-sp-2);
  --fp-gap-3: var(--fp-sp-3);
  --fp-gap-4: var(--fp-sp-4);
  --fp-gap-5: var(--fp-sp-6);

  /* ===== 圆角：4 栅格 ===== */
  --fp-radius-sm: 4px;
  --fp-radius-md: 8px;
  --fp-radius-lg: 12px;
  --fp-radius-xl: 16px;
  --fp-radius-pill: 999px;

  /* ===== 字号 ===== */
  --fp-font-xs: 11px;
  --fp-font-sm: 12px;
  --fp-font-md: 13px;
  --fp-font-lg: 15px;
  --fp-font-xl: 19px;

  /* ===== 表面层级（设计系统 背景色/浮层色，浅深成对）===== */
  --fp-base: light-dark(#f6f7f8, #17181a);        /* bg-primary：应用底 */
  --fp-surface: light-dark(#ffffff, #1d1f23);     /* bg-white：卡片/抬高面 */
  --fp-surface-2: light-dark(#f1f2f3, #0d0e10);   /* bg-secondary：下沉面/嵌块 */
  --fp-overlay: light-dark(#ffffff, #1d1f23);     /* float-white：浮层 */
  --fp-hover: light-dark(#f1f2f3, #24262b);       /* 悬停底色（用面，不用描边） */
  --fp-pressed: light-dark(#e8eaec, #2a2c32);     /* 按下底色 */
  /* 内容井：流程节点卡直接铺这个底色（不再套白边）。要整体加深/变浅只改这一行 */
  --fp-well: var(--fp-surface-2);
  --fp-mask: light-dark(rgba(13, 14, 16, 0.44), rgba(0, 0, 0, 0.62));

  /* ===== 文本色（设计系统 文本色）===== */
  --fp-text: light-dark(#0d0e10, #f0f1f2);          /* text-dark / text-primary */
  --fp-text-dim: light-dark(#61666d, rgba(240, 241, 242, 0.62));   /* text-primary */
  --fp-text-tertiary: light-dark(#9499a0, rgba(240, 241, 242, 0.45)); /* text-secondary */
  --fp-text-quaternary: light-dark(#b4b8bd, rgba(240, 241, 242, 0.3)); /* text-tertiary */

  /* ===== 描边：只用于极少数例外（见 docs/UI-DESIGN.md），容器一律靠面层级分隔 ===== */
  --fp-border: light-dark(#f1f2f3, rgba(241, 242, 243, 0.06));
  --fp-border-strong: light-dark(#e3e5e7, rgba(227, 229, 231, 0.1));
  --fp-line: var(--fp-border);

  /* ===== 主色/强调/功能色（设计系统 功能色与业务主题色）===== */
  --fp-brand: light-dark(#0d0e10, #f0f1f2);         /* 主按钮填充（深色一 / 深色主题取反） */
  --fp-on-brand: light-dark(#ffffff, #0d0e10);      /* 深底字色 */
  /* 主题色：紫色（设计系统 business-pink 同饱和度/明度的紫色变体，色相 275°） */
  --fp-accent: light-dark(#b753ff, #bb5cff);        /* 业务主题色 */
  --fp-accent-strong: light-dark(#ad3bff, #ae52f0); /* 强调字 */
  --fp-accent-soft: color-mix(in srgb, var(--fp-accent) 10%, transparent);
  --fp-ok: light-dark(#2ac864, #47cf79);            /* 绿色 */
  --fp-warn: #ffb027;                                /* 黄色 */
  --fp-warn-strong: #ff7f24;                         /* 橘色 */
  --fp-bad: #f85a54;                                 /* 红色 */
  --fp-idle: light-dark(#9499a0, rgba(240, 241, 242, 0.45));
  --fp-info: #008ac5;                                /* 链接字 */

  /* ===== 阴影（浮层/卡片，克制的两级）===== */
  --fp-shadow-1: 0 1px 2px light-dark(rgba(13, 14, 16, 0.06), rgba(0, 0, 0, 0.36));
  --fp-shadow-2: 0 4px 16px light-dark(rgba(13, 14, 16, 0.1), rgba(0, 0, 0, 0.46));
  --fp-shadow-3: 0 16px 48px light-dark(rgba(13, 14, 16, 0.16), rgba(0, 0, 0, 0.56));

  --fp-mono: var(--ds-font-family-code, ui-monospace, SFMono-Regular, Menlo, monospace);
  color: var(--fp-text);
  font-size: var(--fp-font-md);
  line-height: 1.55;
  -webkit-font-smoothing: antialiased;
}
.fp-root *,
.fp-root *::before,
.fp-root *::after,
.fp-quick *,
.fp-quick *::before,
.fp-quick *::after,
.fp-settings-page *,
.fp-settings-page *::before,
.fp-settings-page *::after {
  box-sizing: border-box;
}
/* 用 :where() 把权重降到 0，避免压过各面板单类名控件规则（(0,1,1) 曾把主按钮压成黑底黑字） */
:where(.fp-root, .fp-quick, .fp-settings-page) button {
  font: inherit;
  color: inherit;
}
.fp-root :focus-visible,
.fp-quick :focus-visible,
.fp-settings-page :focus-visible {
  outline: 2px solid color-mix(in srgb, var(--fp-accent) 55%, transparent);
  outline-offset: 1px;
}
.fp-scroll {
  overflow: auto;
  min-height: 0;
  scrollbar-width: thin;
  scrollbar-color: color-mix(in srgb, var(--fp-text-dim) 32%, transparent) transparent;
}
.fp-scroll::-webkit-scrollbar { width: 8px; height: 8px; }
.fp-scroll::-webkit-scrollbar-thumb {
  background: color-mix(in srgb, var(--fp-text-dim) 28%, transparent);
  border-radius: 8px;
}
.fp-scroll::-webkit-scrollbar-track { background: transparent; }
.fp-row { display: flex; align-items: center; gap: var(--fp-gap-2); min-width: 0; }
.fp-row-tight { display: flex; align-items: center; gap: var(--fp-gap-1); min-width: 0; }
.fp-col { display: flex; flex-direction: column; gap: var(--fp-gap-2); min-width: 0; }
.fp-spacer { flex: 1 1 auto; }
.fp-truncate { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
.fp-muted { color: var(--fp-text-dim); }
.fp-dim { opacity: 0.62; }
.fp-mono { font-family: var(--fp-mono); font-variant-numeric: tabular-nums; }
.fp-hint { font-size: var(--fp-font-xs); color: var(--fp-text-dim); line-height: 1.5; }
.fp-kbd {
  font-family: var(--fp-mono);
  font-size: 10px;
  padding: 0 4px;
  min-width: 16px;
  line-height: 16px;
  text-align: center;
  display: inline-block;
  border-radius: var(--fp-radius-sm);
  background: var(--fp-surface-2);
  color: var(--fp-text-dim);
}
/* ---- 面层级工具类：用灰阶面/悬停色替代描边 ---- */
.fp-card { background: var(--fp-surface); border-radius: var(--fp-radius-lg); }
.fp-card-inset { background: var(--fp-surface-2); border-radius: var(--fp-radius-md); }
.fp-hoverable { transition: background-color 140ms ease; }
.fp-hoverable:hover { background: var(--fp-hover); }
.fp-hoverable:active { background: var(--fp-pressed); }
.fp-divider { height: 1px; background: var(--fp-border); border: 0; margin: 0; }
.fp-fade-in { animation: fp-fade-in 160ms ease-out both; }
.fp-spin { animation: fp-spin 900ms linear infinite; }
@keyframes fp-fade-in { from { opacity: 0; transform: translateY(2px); } to { opacity: 1; transform: none; } }
@keyframes fp-spin { to { transform: rotate(360deg); } }
@keyframes fp-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.35; } }
`;
