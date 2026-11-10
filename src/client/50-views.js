/* ===== 归属：ui-views · 今日 / 周报 / 交接 / 设置视图 + 全部弹窗 ===== */

const FP_VIEW_REASONS = {
  overdue: { label: '逾期', tone: 'error' },
  dueSoon: { label: '临近截止', tone: 'warn' },
  active: { label: '进行中', tone: 'accent' },
  revision: { label: '待修改', tone: 'amber' },
  ready: { label: '待开始', tone: 'brand' },
  followUp: { label: '待跟进', tone: 'warn' },
};

const FP_VIEW_EVENT_LABELS = {
  nodeStatus: '节点状态',
  approvalPassed: '确认通过',
  approvalRejected: '确认退回',
  revision: '进入待修改',
  unlocked: '解锁下一步',
  projectCreated: '创建项目',
  flowAdded: '添加流程',
  linkAdded: '添加链接',
  scheduleChanged: '调整计划',
  handoffSaved: '保存交接',
  reportGenerated: '生成周报',
  reportEdited: '编辑周报',
  projectUpdated: '更新项目',
  projectArchived: '归档项目',
  nodeAdded: '新增节点',
  nodeRemoved: '移除节点',
  settingsChanged: '修改设置',
  manualNote: '补充记录',
  seeded: '载入示例数据',
};

const FP_VIEW_DEFAULT_SLOTS = [
  { key: 'morning', label: '启动与预热', start: '11:00', end: '12:00' },
  { key: 'afternoon', label: '主要工作输出', start: '14:00', end: '18:00' },
  { key: 'evening', label: '持续交付与收尾', start: '19:00', end: '21:00' },
];

const FP_VIEW_DEFAULT_SILENTS = [['12:00', '14:00'], ['18:00', '19:00']];

const FP_VIEW_WEEKDAYS = [
  { value: '1', label: '周一' },
  { value: '2', label: '周二' },
  { value: '3', label: '周三' },
  { value: '4', label: '周四' },
  { value: '5', label: '周五' },
  { value: '6', label: '周六' },
  { value: '7', label: '周日' },
];

const FP_VIEW_ROLE_OPTIONS = [
  { value: '设计', label: '设计' },
  { value: '研发', label: '研发' },
  { value: '设计/产品', label: '设计/产品' },
];

/* ------------------------------------------------------------------ */
/* 本文件内部小工具（全部 fpv 前缀，避免与其它文件的跨文件共享名冲突）  */
/* ------------------------------------------------------------------ */

function fpvT(key, fallback) {
  try {
    if (typeof FP_T === 'function') {
      const value = FP_T(key, fallback);
      if (value) return value;
    }
  } catch (err) {
    /* 宿主 locale 未就绪时使用中文兜底 */
  }
  return fallback;
}

function fpvTry(fn, fallback) {
  try {
    const value = fn();
    return value === undefined || value === null ? fallback : value;
  } catch (err) {
    return fallback;
  }
}

/* FpInput / FpSelect / FpTextarea 的 onChange 可能回传原生事件，也可能回传值 */
function fpvRead(event, fallback) {
  if (event && typeof event === 'object' && 'target' in event) {
    const target = event.target;
    if (target && typeof target === 'object' && 'value' in target) return target.value;
  }
  return event === undefined || event === null ? fallback : event;
}

function fpvDateInput(iso) {
  if (!iso) return '';
  return fpvTry(function () { return fpDateOnly(iso); }, '');
}

function fpvTimeInput(iso) {
  if (!iso) return '';
  return fpvTry(function () { return fpFmtTime(iso); }, '');
}

/* 本地日期 + HH:MM → ISO；缺时间时用 fallbackTime */
function fpvToIso(dateStr, timeStr, fallbackTime) {
  if (!dateStr) return null;
  const time = (timeStr && /^\d{2}:\d{2}$/.test(timeStr)) ? timeStr : (fallbackTime || '18:00');
  const date = new Date(dateStr + 'T' + time + ':00');
  return isNaN(date.getTime()) ? null : date.toISOString();
}

function fpvWeekRange(weekly) {
  const start = weekly && weekly.weekStart;
  const end = weekly && weekly.weekEnd;
  if (!start) return '本周';
  return fpvTry(function () {
    if (end) return fpFmtRange(start, end);
    const startDate = fpParseDate(start);
    const endDate = new Date(startDate.getTime() + 4 * 86400000);
    return fpFmtRange(start, fpDateOnly(endDate));
  }, String(start));
}

function fpvDueMeta(card) {
  if (!card || !card.dueAt) return null;
  const daysLeft = typeof card.daysLeft === 'number' ? card.daysLeft : null;
  let label;
  let tone;
  if (daysLeft === null) {
    label = '截止 ' + fpvTry(function () { return fpFmtDay(card.dueAt); }, '');
    tone = 'muted';
  } else if (daysLeft < 0) {
    label = '逾期 ' + Math.abs(daysLeft) + ' 天';
    tone = 'error';
  } else if (daysLeft === 0) {
    label = '今天到期';
    tone = 'warn';
  } else if (daysLeft === 1) {
    label = '明天到期';
    tone = 'warn';
  } else {
    label = '剩 ' + daysLeft + ' 天';
    tone = 'muted';
  }
  return {
    label: label,
    tone: tone,
    day: fpvTry(function () { return fpFmtDay(card.dueAt); }, ''),
  };
}

/* 把原始 node 适配成契约 §3 的 NodeCard 形状（供概览等场景复用渲染） */
function fpvNodeCard(node, state, project) {
  if (!node) return null;
  const st = state || {};
  const flow = (st.flows || []).filter(function (f) { return f && f.id === node.flowId; })[0] || null;
  const lineId = project ? project.businessLineId : null;
  const line = (st.businessLines || []).filter(function (l) { return l && l.id === lineId; })[0] || null;
  const links = (st.links || []).filter(function (l) { return l && l.nodeId === node.id; });
  return {
    nodeId: node.id,
    code: node.code,
    title: node.title,
    status: node.status,
    projectId: node.projectId,
    projectTitle: project ? project.title : '',
    businessLineId: lineId,
    businessLineName: line ? line.name : '',
    flowId: node.flowId,
    flowName: flow ? flow.name : '',
    dueAt: node.dueAt || null,
    followUpAt: node.followUpAt || null,
    completedAt: node.completedAt || null,
    round: node.round || 1,
    assigneeRole: node.assigneeRole || '',
    reason: '',
    daysLeft: null,
    approvals: node.approvals || {},
    linkCount: links.length,
    hasDesignLink: links.some(function (l) { return l && l.kind === 'design'; }),
  };
}

/* 单行节点卡（今日三列表、概览摘要共用） */
function fpvNodeRow(card, opts) {
  const options = opts || {};
  if (!card) return null;
  const reason = card.reason && FP_VIEW_REASONS[card.reason] ? FP_VIEW_REASONS[card.reason] : null;
  const due = (options.showDue !== false && card.dueAt) ? fpvDueMeta(card) : null;
  const selectable = typeof options.onSelectNode === 'function';
  const clock = options.now instanceof Date ? options.now : new Date();
  const chips = [];
  const extras = [];

  if (options.showStatus !== false && card.status && FP_STATUS[card.status]) {
    chips.push(h(FpStatusChip, { key: 'status', status: card.status }));
  }
  if (options.showReason !== false && reason) {
    chips.push(h(FpChip, {
      key: 'reason',
      tone: reason.tone,
      title: '推荐原因：' + reason.label,
      children: reason.label,
    }));
  }
  if (due) {
    chips.push(h(FpChip, {
      key: 'due',
      tone: due.tone,
      title: '计划：' + due.day,
      children: due.label,
    }));
  }
  if (options.showFollow !== false && card.followUpAt) {
    const rel = fpvTry(function () { return fpRelativeDay(card.followUpAt, clock); }, '');
    chips.push(h(FpChip, {
      key: 'followRel',
      tone: /逾期/.test(String(rel)) ? 'error' : 'warn',
      title: '跟进时间：' + fpvTry(function () { return fpFmtDateTime(card.followUpAt); }, ''),
      children: rel || '待跟进',
    }));
    extras.push(h('span', {
      key: 'followAt',
      className: 'fp-v-row-subtext',
      children: '跟进 ' + fpvTry(function () { return fpFmtDateTime(card.followUpAt); }, ''),
    }));
  }
  if (options.extraText) {
    extras.push(h('span', { key: 'extra', className: 'fp-v-row-subtext', children: options.extraText }));
  }

  const metaChildren = [];
  if (card.businessLineName) metaChildren.push(h('span', { key: 'line', children: card.businessLineName }));
  if (card.projectTitle) {
    if (typeof options.onOpenProject === 'function' && card.projectId) {
      metaChildren.push(h('button', {
        key: 'project',
        type: 'button',
        className: 'fp-v-row-link',
        title: '打开项目',
        onClick: function (event) {
          event.stopPropagation();
          options.onOpenProject(card.projectId);
        },
        children: card.projectTitle,
      }));
    } else {
      metaChildren.push(h('span', { key: 'project', children: card.projectTitle }));
    }
  }
  if (card.flowName) metaChildren.push(h('span', { key: 'flow', children: card.flowName }));

  const metaRow = [];
  metaChildren.forEach(function (child, index) {
    if (index > 0) metaRow.push(h('span', { key: 'sep' + index, className: 'fp-v-dot', children: '·' }));
    metaRow.push(child);
  });

  return h('div', {
    key: options.key || card.nodeId,
    className: 'fp-v-row' + (options.className ? ' ' + options.className : ''),
    role: selectable ? 'button' : undefined,
    tabIndex: selectable ? 0 : undefined,
    onClick: selectable ? function () { options.onSelectNode(card.nodeId); } : undefined,
    onKeyDown: selectable ? function (event) {
      if (event.key === 'Enter' || event.key === ' ' || event.key === 'Spacebar') {
        event.preventDefault();
        options.onSelectNode(card.nodeId);
      }
    } : undefined,
    'aria-label': (card.code ? card.code + ' ' : '') + (card.title || '未命名节点') +
      (card.status && FP_STATUS[card.status] ? '，' + FP_STATUS[card.status].label : ''),
  },
  h('span', { className: 'fp-v-row-code' }, card.code || '—'),
  h('div', { className: 'fp-v-row-main' },
    h('div', { className: 'fp-v-row-title' }, card.title || '未命名节点'),
    metaRow.length ? h('div', { className: 'fp-v-row-meta' }, metaRow) : null,
    extras.length ? h('div', { className: 'fp-v-row-extras' }, extras) : null
  ),
  h('div', { className: 'fp-v-row-side' },
    chips.length ? h('div', { className: 'fp-v-chip-row fp-v-chip-row-end' }, chips) : null
  ));
}

function fpvSectionHead(title, hint, icon, count) {
  return h('div', { className: 'fp-v-section-head' },
    h('div', { className: 'fp-v-section-title' },
      icon ? h(FpIcon, { name: icon, size: 13 }) : null,
      h('span', { className: 'fp-v-section-label' }, title),
      typeof count === 'number' ? h('span', { className: 'fp-v-section-count' }, String(count)) : null
    ),
    hint ? h('div', { className: 'fp-v-section-hint' }, hint) : null
  );
}

function fpvLoading(icon, title) {
  return h('div', { className: 'fp-v-root fp-v-narrow' },
    h(FpEmptyState, {
      icon: icon || 'flow',
      title: title || '正在载入数据',
      description: '等待宿主返回数据',
    }));
}

function fpvBtn(key, label, onClick, extra) {
  const props = Object.assign({
    key: key,
    onClick: onClick,
    children: label,
  }, extra || {});
  return h(FpButton, props);
}

function fpvDialogActions(onClose, submitLabel, busy, submit, canSubmit) {
  return [
    fpvBtn('cancel', fpvT('common.cancel', '取消'), function () {
      if (!busy && typeof onClose === 'function') onClose();
    }, { variant: 'ghost', disabled: !!busy }),
    fpvBtn('submit', busy ? '提交中…' : submitLabel, submit, {
      variant: 'primary',
      disabled: !!busy || canSubmit === false,
    }),
  ];
}

function fpvTimeField(key, value, onChange, opts) {
  const options = opts || {};
  return h('input', {
    key: key,
    type: 'time',
    step: 300,
    className: 'fp-v-time',
    value: value || '',
    disabled: !!options.disabled,
    'aria-label': options.label || '时间',
    onChange: function (event) { onChange(fpvRead(event, '')); },
  });
}

function fpvDateField(key, value, onChange, opts) {
  const options = opts || {};
  return h('input', {
    key: key,
    type: 'date',
    className: 'fp-v-date',
    value: value || '',
    disabled: !!options.disabled,
    'aria-label': options.label || '日期',
    onChange: function (event) { onChange(fpvRead(event, '')); },
  });
}

function fpvDateTimeRow(opts) {
  const options = opts || {};
  return h('div', { key: options.key, className: 'fp-v-input-line' },
    h('span', { className: 'fp-v-label' }, options.label),
    fpvDateField('d', options.date, options.onDate, { disabled: options.disabled, label: options.label + '日期' }),
    fpvTimeField('t', options.time, options.onTime, { disabled: options.disabled, label: options.label + '时间' }),
    options.onClear ? fpvBtn('clear', '清除', options.onClear, {
      variant: 'quiet',
      size: 'sm',
      disabled: !!options.disabled,
      title: '清除时间',
    }) : null
  );
}

function fpvMarkdownPlain(markdown) {
  let text = String(markdown === undefined || markdown === null ? '' : markdown);
  text = text.replace(/\r\n/g, '\n');
  text = text.replace(/```[^\n]*\n/g, '').replace(/```/g, '');
  text = text.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1');
  text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1（$2）');
  text = text.replace(/^#{1,6}\s+/gm, '');
  text = text.replace(/^\s*[-*+]\s+/gm, '· ');
  text = text.replace(/^\s*>\s?/gm, '');
  text = text.replace(/(\*\*|__)(.*?)\1/g, '$2');
  text = text.replace(/(\*|_)(.*?)\1/g, '$2');
  text = text.replace(/`([^`]+)`/g, '$1');
  text = text.replace(/^\s*(?:[-*_]\s*){3,}$/gm, '----------');
  return text.replace(/\n{3,}/g, '\n\n').trim();
}

function fpvHostOf(url) {
  return fpvTry(function () {
    return new URL(url).hostname.replace(/^www\./, '');
  }, '链接');
}

function fpvSettingsDraft(settings) {
  const src = settings || {};
  const srcSlots = Array.isArray(src.workSlots) ? src.workSlots : [];
  const slots = FP_VIEW_DEFAULT_SLOTS.map(function (fallback, index) {
    let found = srcSlots[index] || null;
    if (!found) {
      found = srcSlots.filter(function (slot) { return slot && slot.key === fallback.key; })[0] || null;
    }
    return {
      key: (found && found.key) || fallback.key,
      label: (found && found.label) || fallback.label,
      start: (found && found.start) || fallback.start,
      end: (found && found.end) || fallback.end,
    };
  });
  const srcSilents = Array.isArray(src.silentWindows) ? src.silentWindows : [];
  const silents = [0, 1].map(function (index) {
    const pair = Array.isArray(srcSilents[index]) ? srcSilents[index] : FP_VIEW_DEFAULT_SILENTS[index];
    return {
      start: (pair && pair[0]) || FP_VIEW_DEFAULT_SILENTS[index][0],
      end: (pair && pair[1]) || FP_VIEW_DEFAULT_SILENTS[index][1],
    };
  });
  return {
    slots: slots,
    silents: silents,
    handoffTime: src.handoffTime || '20:45',
    weeklyDraftTime: src.weeklyDraftTime || '12:05',
    weeklyMeetingTime: src.weeklyMeetingTime || '17:00',
    weekStartsOn: String(typeof src.weekStartsOn === 'number' ? src.weekStartsOn : 1),
    evidenceKinds: (function () {
      const policy = src.evidencePolicy !== null && typeof src.evidencePolicy === 'object' ? src.evidencePolicy : {};
      return Array.isArray(policy.kinds) ? policy.kinds.slice() : [];
    })(),
    evidenceMin: String((function () {
      const policy = src.evidencePolicy !== null && typeof src.evidencePolicy === 'object' ? src.evidencePolicy : {};
      const value = Number(policy.minLinks);
      return Number.isFinite(value) ? Math.max(0, Math.round(value)) : 1;
    })()),
    unlockPolicy: src.unlockPolicy === 'parallel' ? 'parallel' : 'linear',
  };
}

function fpvSettingsSig(draft) {
  return JSON.stringify(draft);
}

function fpvSettingsGroup(title, hint, children) {
  return h('div', { className: 'fp-v-group' },
    h('div', { className: 'fp-v-group-head' },
      h('span', { className: 'fp-v-group-title' }, title),
      hint ? h('span', { className: 'fp-v-group-hint' }, hint) : null
    ),
    h('div', { className: 'fp-v-group-body' }, children)
  );
}

/* ------------------------------------------------------------------ */
/* 今日工作（PRD §5.3）                                                */
/* ------------------------------------------------------------------ */

function TodayView({ state, derived, onSelectNode, onOpenProject }) {
  const clock = useNow(60000);
  const st = state || {};
  const dv = derived || {};
  const today = dv.today || null;
  const counts = dv.counts || null;
  const focus = dv.focus || null;
  const nowDate = clock instanceof Date ? clock : new Date();

  if (!state || !derived) return fpvLoading('today', '正在载入今日视图');
  if (!today) return fpvLoading('today', '今日数据尚未就绪');

  const recommended = (Array.isArray(today.recommended) ? today.recommended : []).slice(0, 5);
  const followUps = Array.isArray(today.followUps) ? today.followUps : [];
  const upcoming = Array.isArray(today.upcoming) ? today.upcoming : [];
  const handoffContext = today.handoffContext || null;
  const todayText = fpvTry(function () { return fpFmtDay(dv.now || nowDate.toISOString()); }, '');
  const subtitleParts = [todayText];
  if (focus && focus.label) subtitleParts.push(focus.label);
  if (focus && focus.silent) subtitleParts.push('静默提醒中');

  const countChips = [];
  if (counts) {
    countChips.push(h(FpChip, {
      key: 'actionable',
      tone: counts.actionable > 0 ? 'brand' : 'muted',
      children: '可推进 ' + (counts.actionable || 0),
    }));
    countChips.push(h(FpChip, {
      key: 'waiting',
      tone: counts.waiting > 0 ? 'warn' : 'muted',
      children: '待跟进 ' + (counts.waiting || 0),
    }));
    if (counts.overdue > 0) {
      countChips.push(h(FpChip, {
        key: 'overdue',
        tone: 'error',
        children: '逾期 ' + counts.overdue,
      }));
    }
    if (counts.blocked > 0) {
      countChips.push(h(FpChip, {
        key: 'blocked',
        tone: 'error',
        children: '已阻塞 ' + counts.blocked,
      }));
    }
  }

  const handoffNodes = handoffContext && Array.isArray(handoffContext.nodes) ? handoffContext.nodes : [];
  const handoffChipRow = handoffNodes.length ? h('div', { className: 'fp-v-chip-row' },
    handoffNodes.map(function (card) {
      return h(FpChip, {
        key: card.nodeId,
        tone: 'muted',
        title: '打开节点',
        onClick: typeof onSelectNode === 'function' ? function () { onSelectNode(card.nodeId); } : undefined,
        children: (card.code ? card.code + ' ' : '') + (card.title || ''),
      });
    })) : null;

  const banner = handoffContext ? h('div', { className: 'fp-v-banner' },
    h('div', { className: 'fp-v-banner-head' },
      h(FpIcon, { name: 'handoff', size: 14 }),
      h('div', { className: 'fp-v-banner-title' }, '上一次交接 · ' + fpvTry(function () { return fpFmtDay(handoffContext.date); }, '')),
      h('div', { className: 'fp-v-banner-time' },
        handoffContext.confirmedAt ? '保存于 ' + fpvTry(function () { return fpFmtDateTime(handoffContext.confirmedAt); }, '') : '')
    ),
    handoffContext.nextActions ? h('div', { className: 'fp-v-banner-block' },
      h('span', { className: 'fp-v-k' }, '下一步'),
      h('p', { className: 'fp-v-pre' }, handoffContext.nextActions)
    ) : null,
    handoffContext.notes ? h('div', { className: 'fp-v-banner-block' },
      h('span', { className: 'fp-v-k' }, '备注'),
      h('p', { className: 'fp-v-pre' }, handoffContext.notes)
    ) : null,
    handoffChipRow
  ) : null;

  const recommendedSection = h('div', { className: 'fp-v-section' },
    fpvSectionHead(
      fpvT('today.recommended', '推荐处理'),
      null,
      'spark',
      recommended.length
    ),
    recommended.length
      ? h('div', { className: 'fp-v-list' }, recommended.map(function (card) {
        return fpvNodeRow(card, {
          onSelectNode: onSelectNode,
          onOpenProject: onOpenProject,
          now: nowDate,
          showReason: true,
          showDue: true,
        });
      }))
      : h('div', { className: 'fp-v-soft' }, '当前没有需要优先处理的节点')
  );

  const followSection = h('div', { className: 'fp-v-section' },
    fpvSectionHead(
      fpvT('today.followUps', '等待跟进'),
      null,
      'clock',
      followUps.length
    ),
    followUps.length
      ? h('div', { className: 'fp-v-list' }, followUps.map(function (card) {
        return fpvNodeRow(card, {
          onSelectNode: onSelectNode,
          onOpenProject: onOpenProject,
          now: nowDate,
          showReason: false,
          showDue: true,
          showFollow: true,
        });
      }))
      : h('div', { className: 'fp-v-soft' }, '没有等待跟进的节点。')
  );

  const upcomingSection = h('div', { className: 'fp-v-section' },
    fpvSectionHead(
      fpvT('today.upcoming', '近期截止'),
      null,
      'calendar',
      upcoming.length
    ),
    upcoming.length
      ? h('div', { className: 'fp-v-list' }, upcoming.map(function (card) {
        return fpvNodeRow(card, {
          onSelectNode: onSelectNode,
          onOpenProject: onOpenProject,
          now: nowDate,
          showReason: false,
          showDue: true,
        });
      }))
      : h('div', { className: 'fp-v-soft' }, '未来 7 天没有到期节点。')
  );

  return h('div', { className: 'fp-v-root' },
    h('div', { className: 'fp-v-narrow' },
      h('div', { className: 'fp-v-head' },
        h('div', { className: 'fp-v-head-main' },
          h('div', { className: 'fp-v-eyebrow' }, 'TODAY'),
          h('h2', { className: 'fp-v-title' }, fpvT('today.title', '今日工作')),
          h('div', { className: 'fp-v-sub' }, subtitleParts.filter(Boolean).join(' · '))
        ),
        countChips.length ? h('div', { className: 'fp-v-chip-row fp-v-chip-row-end' }, countChips) : null
      ),
      banner,
      recommendedSection,
      followSection,
      upcomingSection
    )
  );
}

/* ------------------------------------------------------------------ */
/* 周报（PRD §7）                                                      */
/* ------------------------------------------------------------------ */

function WeeklyView({ state, derived }) {
  const st = state || {};
  const dv = derived || {};
  const weekly = dv.weekly || null;
  const settings = st.settings || {};
  const reports = Array.isArray(st.reports) ? st.reports : [];

  const [draft, setDraft] = React.useState('');
  const [mode, setMode] = React.useState('concise');
  const [busy, setBusy] = React.useState(null);
  const [error, setError] = React.useState(null);
  const [confirmRegen, setConfirmRegen] = React.useState(false);

  let report = null;
  if (weekly) {
    report = reports.filter(function (r) { return r && r.id === weekly.reportId; })[0] || null;
    if (!report) {
      report = reports
        .filter(function (r) { return r && r.weekStart === weekly.weekStart; })
        .sort(function (a, b) { return String(b.generatedAt || '').localeCompare(String(a.generatedAt || '')); })[0] || null;
    }
  }

  const reportId = report ? report.id : '';
  const reportContent = report ? (report.content || '') : '';
  const reportMode = report ? (report.mode || '') : '';

  React.useEffect(function () {
    if (report) {
      setDraft(report.content || '');
      setMode(report.mode === 'detailed' ? 'detailed' : 'concise');
    } else {
      setDraft('');
    }
    setError(null);
  }, [reportId, reportContent, reportMode]);

  if (!state || !derived) return fpvLoading('report', '正在载入周报');
  if (!weekly) return fpvLoading('report', '周报数据尚未就绪');

  const rangeText = fpvWeekRange(weekly);
  const dirty = report ? draft !== (report.content || '') : draft !== '';
  const busyGenerate = busy === 'generate';
  const busySave = busy === 'save';
  const canSave = !!report && dirty && !busy;

  async function doGenerate(overwrite) {
    if (busy) return;
    setBusy('generate');
    setError(null);
    try {
      const response = await fpDispatch('generateReport', {
        weekStart: weekly.weekStart,
        mode: mode,
        overwrite: !!overwrite,
      });
      if (!response || response.ok === false) {
        setError((response && response.error) || '生成周报失败');
        return;
      }
      FpToast.push({ tone: 'success', text: overwrite ? '周报草稿已更新' : '周报草稿已生成' });
    } catch (err) {
      setError((err && err.message) || '生成周报失败');
    } finally {
      setBusy(null);
    }
  }

  function onGenerateClick() {
    if (busy) return;
    if (report && report.lastEditedAt) {
      setConfirmRegen(true);
      return;
    }
    doGenerate(!!report);
  }

  async function saveDraft() {
    if (!report || !dirty || busy) return;
    setBusy('save');
    setError(null);
    try {
      const response = await fpDispatch('updateReport', {
        reportId: report.id,
        content: draft,
        mode: mode,
      });
      if (!response || response.ok === false) {
        setError((response && response.error) || '保存周报失败');
        return;
      }
      FpToast.push({ tone: 'success', text: '周报草稿已保存' });
    } catch (err) {
      setError((err && err.message) || '保存周报失败');
    } finally {
      setBusy(null);
    }
  }

  async function copyMarkdown() {
    let ok = false;
    try { ok = await fpCopyText(draft); } catch (err) { ok = false; }
    FpToast.push({ tone: ok ? 'success' : 'error', text: ok ? 'Markdown 已复制' : '复制失败，请手动选择文本复制' });
  }

  async function copyPlain() {
    let ok = false;
    try { ok = await fpCopyText(fpvMarkdownPlain(draft)); } catch (err) { ok = false; }
    FpToast.push({ tone: ok ? 'success' : 'error', text: ok ? '纯文本已复制' : '复制失败，请手动选择文本复制' });
  }

  const modeButtons = [
    fpvBtn('concise', fpvT('weekly.concise', '简洁'), function () { setMode('concise'); }, {
      size: 'sm',
      variant: mode === 'concise' ? 'primary' : 'quiet',
      title: '只汇总完成、变更与等待',
    }),
    fpvBtn('detailed', fpvT('weekly.detailed', '详细'), function () { setMode('detailed'); }, {
      size: 'sm',
      variant: mode === 'detailed' ? 'primary' : 'quiet',
      title: '包含每条事件明细与轮次',
    }),
  ];

  const genLabel = report ? fpvT('weekly.regenerate', '重新生成') : fpvT('weekly.generate', '生成草稿');

  const metaParts = [];
  if (report && report.generatedAt) {
    metaParts.push('自动生成于 ' + fpvTry(function () { return fpFmtDateTime(report.generatedAt); }, ''));
  }
  if (report && report.lastEditedAt) {
    metaParts.push('最后编辑于 ' + fpvTry(function () { return fpFmtDateTime(report.lastEditedAt); }, ''));
  }
  if (weekly.nextGenerateAt) {
    metaParts.push('下次自动生成 ' + fpvTry(function () { return fpFmtDateTime(weekly.nextGenerateAt); }, ''));
  }

  const stateChips = [];
  if (report) {
    stateChips.push(report.lastEditedAt
      ? h(FpChip, { key: 'edited', tone: 'amber', children: '已编辑' })
      : h(FpChip, { key: 'auto', tone: 'muted', children: '自动草稿' }));
    if (dirty) stateChips.push(h(FpChip, { key: 'dirty', tone: 'warn', children: '有未保存修改' }));
  }
  if (weekly.shouldGenerate) {
    stateChips.push(h(FpChip, { key: 'should', tone: 'brand', children: '本周草稿待生成' }));
  }

  const editor = report ? h('div', { className: 'fp-v-card fp-v-editor-card' },
    h('div', { className: 'fp-v-editor-head' },
      h('div', { className: 'fp-v-section-title' },
        h(FpIcon, { name: 'report', size: 14 }),
        h('span', { className: 'fp-v-section-label' }, '周报草稿')
      ),
      stateChips.length ? h('div', { className: 'fp-v-chip-row fp-v-chip-row-end' }, stateChips) : null
    ),
    metaParts.length ? h('div', { className: 'fp-v-editor-meta' }, metaParts.join(' · ')) : null,
    h('div', { className: 'fp-v-editor' },
      h(FpTextarea, {
        value: draft,
        rows: 16,
        placeholder: '周报草稿内容为空。可以先点击“生成草稿”，也可以直接手动记录。',
        onChange: function (event) { setDraft(fpvRead(event, '')); },
        onKeyDown: function (event) {
          if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
            event.preventDefault();
            saveDraft();
          }
        },
      })
    ),
    h('div', { className: 'fp-v-editor-foot' },
      h('span', { className: 'fp-v-editor-state' + (dirty ? ' fp-v-editor-state-dirty' : '') },
        dirty ? '有未保存修改（⌘/Ctrl+Enter 保存）' : '草稿已与宿主一致'),
      h('div', { className: 'fp-v-actions-row' },
        fpvBtn('copyPlain', '复制纯文本', copyPlain, { size: 'sm', variant: 'quiet', disabled: !draft }),
        fpvBtn('copyMd', fpvT('weekly.copy', '复制 Markdown'), copyMarkdown, { size: 'sm', disabled: !draft }),
        fpvBtn('save', busySave ? '保存中…' : '保存草稿', saveDraft, {
          size: 'sm',
          variant: 'primary',
          disabled: !canSave,
        })
      )
    )
  ) : h('div', { className: 'fp-v-card fp-v-empty-card' },
    h(FpEmptyState, {
      icon: 'report',
      title: '本周还没有可生成周报的事件',
      description: '只整理已记录的事件；可先生成草稿或手动补充。',
      actions: fpvBtn('gen', busyGenerate ? '生成中…' : fpvT('weekly.generate', '生成草稿'), onGenerateClick, {
        variant: 'primary',
        disabled: busyGenerate,
      }),
    })
  );

  return h('div', { className: 'fp-v-root' },
    h('div', { className: 'fp-v-narrow' },
      h('div', { className: 'fp-v-head' },
        h('div', { className: 'fp-v-head-main' },
          h('div', { className: 'fp-v-eyebrow' }, 'WEEKLY REVIEW'),
          h('h2', { className: 'fp-v-title' }, rangeText + ' 周报'),
          h('div', { className: 'fp-v-sub' }, '编辑草稿不会改动项目进度')
        ),
        h('div', { className: 'fp-v-head-actions' },
          h('div', { className: 'fp-v-seg' }, modeButtons),
          fpvBtn('generate', busyGenerate ? '生成中…' : genLabel, onGenerateClick, {
            variant: 'primary',
            disabled: !!busy,
          })
        )
      ),
      h('div', { className: 'fp-v-note' },
        h(FpIcon, { name: 'report', size: 13 }),
        h('span', {},
          '简洁：只列事实；详细：附事件明细与轮次。' +
          (settings.weeklyDraftTime ? ' 每周五 ' + settings.weeklyDraftTime + ' 自动生成草稿。' : '') +
          (settings.weeklyMeetingTime ? ' 周会 ' + settings.weeklyMeetingTime + '。' : ''))
      ),
      error ? h('div', { className: 'fp-v-form-error', role: 'alert' }, error) : null,
      editor,
      h(FpConfirm, {
        open: confirmRegen,
        title: '重新生成周报草稿？',
        message: '重新生成会覆盖当前草稿内容，包括你已经手动编辑的部分。此操作不会改变项目进度。',
        confirmLabel: '重新生成',
        danger: true,
        onConfirm: function () { setConfirmRegen(false); doGenerate(true); },
        onCancel: function () { setConfirmRegen(false); },
      })
    )
  );
}

/* ------------------------------------------------------------------ */
/* 日终交接（PRD §6.4）                                                */
/* ------------------------------------------------------------------ */

function HandoffView({ state, derived, onOpenProject }) {
  const clock = useNow(60000);
  const st = state || {};
  const dv = derived || {};
  const settings = st.settings || {};
  const workdays = (Array.isArray(settings.workdays) && settings.workdays.length) ? settings.workdays : [1, 2, 3, 4, 5];
  const now = clock instanceof Date ? clock : new Date();
  const nowIso = dv.now || now.toISOString();
  const nowDate = fpvTry(function () { return fpParseDate(nowIso); }, now);
  const todayKey = fpvTry(function () { return fpDateOnly(nowDate); }, '');
  const isFriday = nowDate.getDay() === 5;
  const nextWorkday = fpvTry(function () { return fpNextWorkday(nowDate, workdays); }, null);
  const nextWorkdayLabel = nextWorkday
    ? fpvTry(function () { return fpFmtDay(nextWorkday.toISOString()); }, '下一个工作日')
    : '下一个工作日';

  const [selected, setSelected] = React.useState([]);
  const [nextActions, setNextActions] = React.useState('');
  const [notes, setNotes] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState(null);

  const todayHandoff = (Array.isArray(st.handoffs) ? st.handoffs : [])
    .filter(function (item) { return item && item.date === todayKey; })
    .sort(function (a, b) { return String(b.createdAt || '').localeCompare(String(a.createdAt || '')); })[0] || null;
  const todayHandoffId = todayHandoff ? todayHandoff.id : '';
  const todayHandoffConfirmed = todayHandoff ? (todayHandoff.confirmedAt || '') : '';
  const todayHandoffNext = todayHandoff ? (todayHandoff.nextActions || '') : '';
  const todayHandoffNotes = todayHandoff ? (todayHandoff.notes || '') : '';

  const activeProjects = (Array.isArray(st.projects) ? st.projects : []).filter(function (project) {
    return project && project.status === 'active';
  });
  const projectIds = activeProjects.map(function (project) { return project.id; });
  const statusRank = { active: 0, revision: 1, ready: 2 };
  const candidates = (Array.isArray(st.nodes) ? st.nodes : []).filter(function (node) {
    return node && projectIds.indexOf(node.projectId) >= 0 &&
      (node.status === 'active' || node.status === 'revision' || node.status === 'ready');
  }).sort(function (a, b) {
    const rankDiff = (statusRank[a.status] === undefined ? 9 : statusRank[a.status]) -
      (statusRank[b.status] === undefined ? 9 : statusRank[b.status]);
    if (rankDiff !== 0) return rankDiff;
    const flowDiff = String(a.flowId || '').localeCompare(String(b.flowId || ''));
    if (flowDiff !== 0) return flowDiff;
    return (a.sortOrder || 0) - (b.sortOrder || 0);
  });
  const candidateIds = candidates.map(function (node) { return node.id; });

  /* 预填：已有今日交接则回填；否则默认勾选“进行中”的节点 */
  React.useEffect(function () {
    if (todayHandoff) {
      const saved = Array.isArray(todayHandoff.nodeIds) ? todayHandoff.nodeIds : [];
      setSelected(saved.filter(function (id) { return candidateIds.indexOf(id) >= 0; }));
      setNextActions(todayHandoff.nextActions || '');
      setNotes(todayHandoff.notes || '');
    } else {
      const defaults = candidates
        .filter(function (node) { return node.status === 'active'; })
        .map(function (node) { return node.id; });
      setSelected(defaults);
      setNextActions('');
      setNotes('');
    }
    setError(null);
    /* candidateIds 每次渲染都是新数组，这里只依赖交接记录标识与日期键 */
  }, [todayKey, todayHandoffId, todayHandoffConfirmed, todayHandoffNext, todayHandoffNotes]);

  if (!state || !derived) return fpvLoading('handoff', '正在载入日终交接');

  function toggleNode(nodeId) {
    setSelected(function (prev) {
      if (prev.indexOf(nodeId) >= 0) {
        return prev.filter(function (id) { return id !== nodeId; });
      }
      return prev.concat([nodeId]);
    });
  }

  function selectActive() {
    setSelected(candidates.filter(function (node) { return node.status === 'active'; })
      .map(function (node) { return node.id; }));
  }

  async function submitHandoff() {
    if (busy) return;
    if (!nextActions.trim()) {
      setError('请填写明天的下一步动作；节点勾选可以留空，但宿主需要下一步动作来生成次日的交接上下文。');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const response = await fpDispatch('saveHandoff', {
        date: todayKey,
        nodeIds: selected.slice(),
        nextActions: nextActions.trim(),
        notes: notes.trim(),
      });
      if (!response || response.ok === false) {
        setError((response && response.error) || '保存交接失败');
        return;
      }
      FpToast.push({ tone: 'success', text: '日终交接已保存' });
    } catch (err) {
      setError((err && err.message) || '保存交接失败');
    } finally {
      setBusy(false);
    }
  }

  const resumeText = isFriday
    ? '下周一（' + nextWorkdayLabel + '）上午 11:00 优先呈现'
    : '明天上午 11:00 优先呈现';

  const head = h('div', { className: 'fp-v-head' },
    h('div', { className: 'fp-v-head-main' },
      h('div', { className: 'fp-v-eyebrow' }, 'DAILY HANDOFF'),
      h('h2', { className: 'fp-v-title' }, fpvT('handoff.title', '日终交接')),
      null
    ),
    h('div', { className: 'fp-v-chip-row fp-v-chip-row-end' },
      h(FpChip, { key: 'date', tone: 'muted', children: todayKey ? fpvTry(function () { return fpFmtDay(todayKey); }, todayKey) : '' }),
      isFriday ? h(FpChip, { key: 'fri', tone: 'brand', title: '周五交接默认指向下周一', children: '周五 · 指向下周一' }) : null
    )
  );

  const fridayNote = isFriday ? h('div', { className: 'fp-v-note' },
    h(FpIcon, { name: 'calendar', size: 13 }),
    h('span', {}, '今天是周五，本次交接默认指向下周一（' + nextWorkdayLabel + '）。')
  ) : null;

  const savedNote = todayHandoff ? h('div', { className: 'fp-v-note fp-v-note-ok' },
    h(FpIcon, { name: 'check', size: 13 }),
    h('span', {}, '今天已保存' +
      (todayHandoff.confirmedAt ? '（' + fpvTry(function () { return fpFmtTime(todayHandoff.confirmedAt); }, '') + '）' : '') +
      ' · ' + resumeText)
  ) : null;

  const candidateRows = candidates.length ? candidates.map(function (node) {
    const checked = selected.indexOf(node.id) >= 0;
    const project = activeProjects.filter(function (item) { return item.id === node.projectId; })[0] || null;
    const line = project ? (st.businessLines || []).filter(function (item) { return item.id === project.businessLineId; })[0] : null;
    const metaParts = [];
    if (line && line.name) metaParts.push(line.name);
    if (project && project.title) metaParts.push(project.title);
    const flow = (st.flows || []).filter(function (item) { return item.id === node.flowId; })[0];
    if (flow && flow.name) metaParts.push(flow.name);

    return h('div', { key: node.id, className: 'fp-v-check' + (checked ? ' fp-v-check-on' : '') },
      h('label', { className: 'fp-v-check-main' },
        h('input', {
          type: 'checkbox',
          className: 'fp-v-check-box',
          checked: checked,
          onChange: function () { toggleNode(node.id); },
          'aria-label': '选择节点 ' + (node.code ? node.code + ' ' : '') + (node.title || ''),
        }),
        h('span', { className: 'fp-v-row-code' }, node.code || '—'),
        h('span', { className: 'fp-v-check-body' },
          h('span', { className: 'fp-v-check-title' }, node.title || '未命名节点'),
          metaParts.length ? h('span', { className: 'fp-v-check-meta' }, metaParts.join(' · ')) : null
        )
      ),
      h('span', { className: 'fp-v-check-side' },
        h(FpStatusChip, { status: node.status }),
        typeof onOpenProject === 'function' ? h('button', {
          type: 'button',
          className: 'fp-v-row-link',
          title: '打开所属项目',
          onClick: function (event) { event.preventDefault(); event.stopPropagation(); onOpenProject(node.projectId); },
          children: '打开项目',
        }) : null
      )
    );
  }) : [h('div', { key: 'empty', className: 'fp-v-soft' }, '当前没有可交接的节点')];

  const candidateCard = h('div', { className: 'fp-v-card' },
    h('div', { className: 'fp-v-card-head' },
      fpvSectionHead('继续推进的节点', candidates.length ? selected.length + ' / ' + candidates.length + ' 已选' : null, 'flow'),
      h('div', { className: 'fp-v-actions-row' },
        fpvBtn('allActive', '选中进行中', selectActive, { size: 'sm', variant: 'quiet', disabled: busy }),
        fpvBtn('clear', '清空', function () { setSelected([]); }, { size: 'sm', variant: 'quiet', disabled: busy })
      )
    ),
    h('div', { className: 'fp-v-list' }, candidateRows)
  );

  const formCard = h('div', { className: 'fp-v-card' },
    h('div', { className: 'fp-v-field-block' },
      h('div', { className: 'fp-v-label' }, '明天的下一步'),
      h(FpTextarea, {
        value: nextActions,
        rows: 3,
        placeholder: '例如：上午先确认 D04 交互稿，再等产品反馈；下午推进 A02 验收材料。',
        onChange: function (event) { setNextActions(fpvRead(event, '')); },
      })
    ),
    h('div', { className: 'fp-v-field-block' },
      h('div', { className: 'fp-v-label' }, '问题与备注'),
      h(FpTextarea, {
        value: notes,
        rows: 2,
        placeholder: '例如：设计稿链接还没拿到，明天先找设计要。',
        onChange: function (event) { setNotes(fpvRead(event, '')); },
      })
    ),
    error ? h('div', { className: 'fp-v-form-error', role: 'alert' }, error) : null,
    h('div', { className: 'fp-v-actions-row fp-v-actions-row-end' },
      fpvBtn('save', busy ? '保存中…' : '保存交接', submitHandoff, {
        variant: 'primary',
        disabled: busy,
      })
    )
  );

  const historyList = (Array.isArray(st.handoffs) ? st.handoffs.slice() : [])
    .sort(function (a, b) {
      const dateDiff = String(b.date || '').localeCompare(String(a.date || ''));
      if (dateDiff !== 0) return dateDiff;
      return String(b.createdAt || '').localeCompare(String(a.createdAt || ''));
    })
    .slice(0, 7);

  const historyRows = historyList.map(function (item) {
    const nodeCards = (Array.isArray(item.nodeIds) ? item.nodeIds : []).map(function (id) {
      return fpvTry(function () { return fpNodeById(st, id); }, null);
    }).filter(Boolean);
    return h('div', { key: item.id, className: 'fp-v-history-item' },
      h('div', { className: 'fp-v-history-head' },
        h('span', { className: 'fp-v-history-date' }, fpvTry(function () { return fpFmtDay(item.date); }, item.date)),
        h(FpChip, {
          key: 'count',
          tone: 'muted',
          children: nodeCards.length ? nodeCards.length + ' 个节点' : '未选节点',
        }),
        item.confirmedAt ? h('span', { className: 'fp-v-history-time' },
          '保存于 ' + fpvTry(function () { return fpFmtTime(item.confirmedAt); }, '')) : null
      ),
      nodeCards.length ? h('div', { className: 'fp-v-chip-row' }, nodeCards.map(function (node) {
        return h(FpChip, {
          key: node.id,
          tone: 'muted',
          title: '打开所属项目',
          onClick: typeof onOpenProject === 'function' ? function () { onOpenProject(node.projectId); } : undefined,
          children: (node.code ? node.code + ' ' : '') + (node.title || ''),
        });
      })) : null,
      item.nextActions ? h('p', { className: 'fp-v-pre fp-v-history-text' }, item.nextActions) : null,
      item.notes ? h('p', { className: 'fp-v-pre fp-v-history-note' }, item.notes) : null
    );
  });

  const historySection = h('div', { className: 'fp-v-section' },
    fpvSectionHead('历史交接', null, 'clock', historyList.length),
    historyRows.length
      ? h('div', { className: 'fp-v-list' }, historyRows)
      : h('div', { className: 'fp-v-soft' }, '还没有交接记录')
  );

  return h('div', { className: 'fp-v-root' },
    h('div', { className: 'fp-v-narrow' },
      head,
      fridayNote,
      savedNote,
      candidateCard,
      formCard,
      historySection
    )
  );
}

/* ------------------------------------------------------------------ */
/* 设置与备份（PRD §4 / §6 / §9.4）                                    */
/* ------------------------------------------------------------------ */

/* 网页访问：本地只读网页的开关 / 端口 / 链接（宿主侧 /flowpilot/api/webaccess） */
function FpWebAccessGroup() {
  const [status, setStatus] = React.useState(null);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState('');
  const [portText, setPortText] = React.useState('4173');
  const [copied, setCopied] = React.useState(false);

  React.useEffect(function () {
    let alive = true;
    fetch('/flowpilot/api/webaccess', { cache: 'no-store' })
      .then(function (res) { return res.json(); })
      .then(function (out) {
        if (!alive) return;
        if (out && out.ok && out.status) {
          setStatus(out.status);
          setPortText(String(out.status.port));
        }
      })
      .catch(function () { if (alive) setError('读取网页访问状态失败'); });
    return function () { alive = false; };
  }, []);

  function save(patch) {
    if (busy) return;
    setBusy(true);
    setError('');
    fetch('/flowpilot/api/webaccess', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(patch),
    })
      .then(function (res) { return res.json().then(function (out) { return { ok: res.ok && out && out.ok === true, out: out || {} }; }); })
      .then(function (result) {
        if (!result.ok) throw new Error(result.out.error || '保存失败');
        setStatus(result.out.status);
        setPortText(String(result.out.status.port));
        setCopied(false);
      })
      .catch(function (err) { setError(err && err.message ? err.message : '保存失败'); })
      .finally(function () { setBusy(false); });
  }

  function copyUrl() {
    const url = status && status.url ? status.url : '';
    if (url === '' || typeof navigator === 'undefined' || !navigator.clipboard) return;
    navigator.clipboard.writeText(url).then(function () { setCopied(true); }).catch(function () {});
  }

  const enabled = status !== null && status.enabled === true;
  const running = status !== null && status.running === true;
  const url = status !== null && status.url ? status.url : '';
  const children = [];
  children.push(
    h(FpSwitch, {
      key: 'switch',
      checked: enabled,
      disabled: busy || status === null,
      label: '本地只读网页',
      description: running && url !== '' ? url : '在本机浏览器直接查看今日待办与项目进度',
      onChange: function (value) { save({ enabled: value }); },
    }),
  );
  children.push(
    h(FpField, { key: 'port', label: '端口', hint: '1024–65535' },
      h('div', { className: 'fp-v-webaccess-row' },
        h(FpInput, {
          type: 'number',
          value: portText,
          width: 112,
          disabled: busy,
          onChange: function (value) { setPortText(value); },
          onEnter: function () { save({ port: Number(portText) }); },
        }),
        h(FpButton, {
          size: 'sm',
          variant: 'default',
          disabled: busy,
          onClick: function () { save({ port: Number(portText) }); },
        }, busy ? '保存中…' : '应用'),
      ),
    ),
  );
  if (running && url !== '') {
    children.push(
      h('div', { key: 'url', className: 'fp-v-webaccess-url' },
        h('span', { className: 'fp-v-webaccess-link', title: url }, url),
        h(FpButton, { size: 'sm', variant: 'quiet', onClick: copyUrl }, copied ? '已复制' : '复制链接'),
      ),
    );
  }
  if (error !== '') children.push(h('div', { key: 'err', className: 'fp-v-form-error', role: 'alert' }, error));
  return fpvSettingsGroup('网页访问', null, children);
}

function SettingsView({ state, derived, compact }) {
  const isCompact = compact === true;
  const st = state || {};
  const dv = derived || {};
  const settings = st.settings || {};
  const base = fpvSettingsDraft(settings);
  const baseSig = fpvSettingsSig(base);
  const [draft, setDraft] = React.useState(base);
  const [busy, setBusy] = React.useState(null);
  const [error, setError] = React.useState(null);
  const [confirmReset, setConfirmReset] = React.useState(false);

  /* 外观 · 主题色（纯客户端偏好，只换色相） */
  const [accentHue, setAccentHue] = React.useState(function () {
    return typeof fpAccentHueRead === 'function' ? fpAccentHueRead() : 275;
  });
  /* 同步节奏：自动同步间隔（分钟） */
  const syncIntervalSaved = (function () {
    const raw = Number((st.settings || {}).syncIntervalMinutes);
    if (!Number.isFinite(raw)) return 5;
    return Math.max(1, Math.min(60, Math.round(raw)));
  })();
  const [intervalText, setIntervalText] = React.useState(String(syncIntervalSaved));
  const [intervalBusy, setIntervalBusy] = React.useState(false);

  React.useEffect(function () {
    setIntervalText(String(syncIntervalSaved));
  }, [syncIntervalSaved]);

  function applyAccentHue(hue) {
    const applied = typeof fpApplyAccentHue === 'function' ? fpApplyAccentHue(hue, true) : hue;
    setAccentHue(applied);
  }

  function saveSyncInterval() {
    const num = Number(intervalText);
    if (!Number.isFinite(num) || Math.round(num) !== num || num < 1 || num > 60) {
      setError('自动同步间隔需为 1~60 的整数分钟');
      return;
    }
    setIntervalBusy(true);
    setError(null);
    Promise.resolve(fpDispatch('updateSettings', { patch: { syncIntervalMinutes: num } }))
      .then(function (result) {
        setIntervalBusy(false);
        if (!result || result.ok !== true) {
          setError((result && result.error) || '保存自动同步间隔失败');
          return;
        }
        FpToast.push({ tone: 'success', text: '已改为每 ' + num + ' 分钟自动同步' });
      })
      .catch(function (cause) {
        setIntervalBusy(false);
        setError(cause && cause.message ? cause.message : '保存自动同步间隔失败');
      });
  }

  React.useEffect(function () {
    setDraft(fpvSettingsDraft(settings));
    /* 只在宿主设置变化（baseSig 改变）时同步，避免覆盖正在编辑的草稿 */
  }, [baseSig]);

  if (!state) return fpvLoading('settings', '正在载入设置');

  const dirty = baseSig !== fpvSettingsSig(draft);
  const dataFile = settings.dataFile || '';
  const workdays = Array.isArray(settings.workdays) && settings.workdays.length ? settings.workdays : [1, 2, 3, 4, 5];
  const workdayText = workdays.map(function (day) {
    const found = FP_VIEW_WEEKDAYS.filter(function (item) { return Number(item.value) === day; })[0];
    return found ? found.label : String(day);
  }).join('、');

  function updateDraft(producer) {
    setDraft(function (prev) {
      const next = JSON.parse(JSON.stringify(prev));
      producer(next);
      return next;
    });
    setError(null);
  }

  function updateSlot(index, patch) {
    updateDraft(function (next) {
      if (next.slots[index]) Object.assign(next.slots[index], patch);
    });
  }

  function updateSilent(index, patch) {
    updateDraft(function (next) {
      if (next.silents[index]) Object.assign(next.silents[index], patch);
    });
  }

  function validateDraft(value) {
    const times = [];
    value.slots.forEach(function (slot, index) {
      times.push({ label: '工作时段 ' + (index + 1) + ' 开始', value: slot.start });
      times.push({ label: '工作时段 ' + (index + 1) + ' 结束', value: slot.end });
    });
    value.silents.forEach(function (silent, index) {
      times.push({ label: '静默窗 ' + (index + 1) + ' 开始', value: silent.start });
      times.push({ label: '静默窗 ' + (index + 1) + ' 结束', value: silent.end });
    });
    times.push({ label: '交接时间', value: value.handoffTime });
    times.push({ label: '周报草稿时间', value: value.weeklyDraftTime });
    times.push({ label: '周会时间', value: value.weeklyMeetingTime });
    const missing = times.filter(function (item) {
      return !/^\d{2}:\d{2}$/.test(String(item.value || ''));
    });
    if (missing.length) return '请填写完整的时间（HH:MM）：' + missing.map(function (item) { return item.label; }).join('、');
    const min = Number(value.evidenceMin);
    if (!Number.isFinite(min) || Math.round(min) !== min || min < 0 || min > 10) {
      return '完成证据数需为 0~10 的整数';
    }
    return null;
  }

  async function saveSettings() {
    if (busy) return;
    const validation = validateDraft(draft);
    if (validation) {
      setError(validation);
      return;
    }
    setBusy('settings');
    setError(null);
    try {
      const response = await fpDispatch('updateSettings', {
        patch: {
          workSlots: draft.slots.map(function (slot) {
            return {
              key: slot.key,
              label: String(slot.label || '').trim() || slot.key,
              start: slot.start,
              end: slot.end,
            };
          }),
          silentWindows: draft.silents.map(function (silent) { return [silent.start, silent.end]; }),
          handoffTime: draft.handoffTime,
          weeklyDraftTime: draft.weeklyDraftTime,
          weeklyMeetingTime: draft.weeklyMeetingTime,
          weekStartsOn: Number(draft.weekStartsOn),
          evidencePolicy: {
            kinds: draft.evidenceKinds.slice(),
            minLinks: Number(draft.evidenceMin),
          },
          unlockPolicy: draft.unlockPolicy === 'parallel' ? 'parallel' : 'linear',
        },
      });
      if (!response || response.ok === false) {
        setError((response && response.error) || '保存设置失败');
        return;
      }
      FpToast.push({ tone: 'success', text: '设置已保存' });
    } catch (err) {
      setError((err && err.message) || '保存设置失败');
    } finally {
      setBusy(null);
    }
  }

  async function exportBackup() {
    if (busy) return;
    setBusy('export');
    setError(null);
    try {
      const response = await fetch('/flowpilot/api/export', {
        method: 'GET',
        headers: { accept: 'application/json' },
      });
      if (!response || !response.ok) {
        throw new Error('导出失败（HTTP ' + (response ? response.status : '?') + '）');
      }
      const text = await response.text();
      let filename = 'flowpilot-backup-' + fpvTry(function () { return fpDateOnly(new Date()); }, 'data') + '.json';
      const disposition = (response.headers && response.headers.get('content-disposition')) || '';
      const match = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(disposition);
      if (match && match[1]) {
        const decoded = fpvTry(function () { return decodeURIComponent(match[1]); }, match[1]);
        if (decoded) filename = decoded;
      }
      fpDownload(filename, text, 'application/json');
      FpToast.push({ tone: 'success', text: '备份已导出' });
    } catch (err) {
      const message = (err && err.message) || '导出备份失败';
      setError(message);
      FpToast.push({ tone: 'error', text: message });
    } finally {
      setBusy(null);
    }
  }

  async function seedDemo() {
    if (busy) return;
    setBusy('seed');
    setError(null);
    try {
      const response = await fpDispatch('seedDemo', {});
      if (!response || response.ok === false) {
        const message = (response && response.error) || '载入示例数据失败';
        setError(message);
        FpToast.push({ tone: 'error', text: message });
        return;
      }
      FpToast.push({ tone: 'success', text: '示例数据已载入' });
    } catch (err) {
      const message = (err && err.message) || '载入示例数据失败';
      setError(message);
      FpToast.push({ tone: 'error', text: message });
    } finally {
      setBusy(null);
    }
  }

  async function doReset() {
    setConfirmReset(false);
    if (busy) return;
    setBusy('reset');
    setError(null);
    try {
      const response = await fpDispatch('resetData', { confirm: 'RESET' });
      if (!response || response.ok === false) {
        const message = (response && response.error) || '清空数据失败';
        setError(message);
        FpToast.push({ tone: 'error', text: message });
        return;
      }
      FpToast.push({ tone: 'success', text: '本地数据已清空' });
    } catch (err) {
      const message = (err && err.message) || '清空数据失败';
      setError(message);
      FpToast.push({ tone: 'error', text: message });
    } finally {
      setBusy(null);
    }
  }

  async function copyDataPath() {
    let ok = false;
    try { ok = await fpCopyText(dataFile); } catch (err) { ok = false; }
    FpToast.push({ tone: ok ? 'success' : 'error', text: ok ? '数据文件路径已复制' : '复制失败' });
  }

  const slotsChildren = draft.slots.map(function (slot, index) {
    return h('div', { key: slot.key || index, className: 'fp-v-slot-row' },
      h('input', {
        className: 'fp-v-text-inline',
        type: 'text',
        value: slot.label || '',
        'aria-label': '时段名称 ' + (index + 1),
        onChange: function (event) { updateSlot(index, { label: fpvRead(event, '') }); },
      }),
      h('span', { className: 'fp-v-time-pair' },
        fpvTimeField('start', slot.start, function (value) { updateSlot(index, { start: value }); }, { label: '时段开始' }),
        h('span', { className: 'fp-v-sep' }, '至'),
        fpvTimeField('end', slot.end, function (value) { updateSlot(index, { end: value }); }, { label: '时段结束' })
      )
    );
  });

  const silentChildren = draft.silents.map(function (silent, index) {
    return h('div', { key: 'silent' + index, className: 'fp-v-slot-row' },
      h('span', { className: 'fp-v-label fp-v-label-inline' }, '静默窗 ' + (index + 1)),
      h('span', { className: 'fp-v-time-pair' },
        fpvTimeField('start', silent.start, function (value) { updateSilent(index, { start: value }); }, { label: '静默开始' }),
        h('span', { className: 'fp-v-sep' }, '至'),
        fpvTimeField('end', silent.end, function (value) { updateSilent(index, { end: value }); }, { label: '静默结束' })
      )
    );
  });

  const rhythmChildren = [
    h('div', { key: 'handoff', className: 'fp-v-setting-row' },
      h('span', { className: 'fp-v-label' }, '日终交接'),
      fpvTimeField('handoffTime', draft.handoffTime, function (value) {
        updateDraft(function (next) { next.handoffTime = value; });
      }, { label: '日终交接时间' }),
      h('span', { className: 'fp-v-setting-hint' }, '每天推荐做交接的时点')
    ),
    h('div', { key: 'weekly', className: 'fp-v-setting-row' },
      h('span', { className: 'fp-v-label' }, '周报草稿'),
      fpvTimeField('weeklyDraftTime', draft.weeklyDraftTime, function (value) {
        updateDraft(function (next) { next.weeklyDraftTime = value; });
      }, { label: '周报草稿生成时间' }),
      h('span', { className: 'fp-v-setting-hint' }, '周五自动生成草稿的时点')
    ),
    h('div', { key: 'meeting', className: 'fp-v-setting-row' },
      h('span', { className: 'fp-v-label' }, '周会'),
      fpvTimeField('weeklyMeetingTime', draft.weeklyMeetingTime, function (value) {
        updateDraft(function (next) { next.weeklyMeetingTime = value; });
      }, { label: '周会时间' }),
      h('span', { className: 'fp-v-setting-hint' }, '周会开始的时点')
    ),
  ];

  const weekChildren = [
    h('div', { key: 'weekStartsOn', className: 'fp-v-setting-row' },
      h('span', { className: 'fp-v-label' }, '工作日起始'),
      h('span', { className: 'fp-v-select-wrap' },
        h(FpSelect, {
          value: draft.weekStartsOn,
          options: FP_VIEW_WEEKDAYS,
          width: 120,
          onChange: function (event) {
            updateDraft(function (next) { next.weekStartsOn = String(fpvRead(event, '1')); });
          },
        })),
      h('span', { className: 'fp-v-setting-hint' }, '决定周报统计的起始日')
    ),
    h('div', { key: 'workdays', className: 'fp-v-setting-row' },
      h('span', { className: 'fp-v-label' }, '工作日'),
      h('span', { className: 'fp-v-setting-value' }, workdayText),
      h('span', { className: 'fp-v-setting-hint' }, '静默窗与非工作时段提醒生效范围')
    ),
  ];

  const dataChildren = [
    h('div', { key: 'file', className: 'fp-v-setting-row fp-v-setting-row-top' },
      h('span', { className: 'fp-v-label' }, '数据文件'),
      h('span', { className: 'fp-v-data-path' },
        h('code', { className: 'fp-v-mono' }, dataFile || '（尚未初始化）'),
        dataFile ? h(FpIconButton, {
          label: '复制数据文件路径',
          title: '复制路径',
          onClick: copyDataPath,
          children: h(FpIcon, { name: 'copy', size: 13 }),
        }) : null
      ),
      h('span', { className: 'fp-v-setting-hint' }, '所有项目、节点、事件、交接与周报都保存在这个 JSON 文件里')
    ),
    h('div', { key: 'actions', className: 'fp-v-data-actions' },
      fpvBtn('export', busy === 'export' ? '导出中…' : '导出备份', exportBackup, {
        disabled: !!busy,
      }),
      fpvBtn('seed', busy === 'seed' ? '载入中…' : '载入示例数据', seedDemo, {
        variant: 'ghost',
        disabled: !!busy,
      }),
      fpvBtn('reset', busy === 'reset' ? '清空中…' : '清空数据', function () { setConfirmReset(true); }, {
        variant: 'danger',
        disabled: !!busy,
      })
    ),
    h('p', { key: 'warn', className: 'fp-v-setting-warn' },
      '导出会包含全部项目与事件，可作为完整备份；清空数据不可撤销，请先导出备份。')
  ];

  const head = isCompact ? null : h('div', { className: 'fp-v-head' },
    h('div', { className: 'fp-v-head-main' },
      h('div', { className: 'fp-v-eyebrow' }, 'PREFERENCES'),
      h('h2', { className: 'fp-v-title' }, fpvT('settings.title', '设置与备份')),
      h('div', { className: 'fp-v-sub' }, '调整工作节奏，管理本地数据。' +
        (dv.focus && dv.focus.label ? ' 当前节奏：' + dv.focus.label + '。' : ''))
    )
  );

  return h('div', { className: 'fp-v-root' + (isCompact ? ' fp-v-compact' : '') },
    h('div', { className: 'fp-v-narrow fp-v-settings' },
      head,
      fpvSettingsGroup('外观 · 主题色', '只换色相，仅保存在本机',
        h('div', { className: 'fp-v-theme' },
          h('div', { className: 'fp-v-theme-row' },
            FP_ACCENT_PRESETS.map(function (preset) {
              const on = Math.abs(accentHue - preset.hue) < 0.6;
              return h('button', {
                key: preset.id,
                type: 'button',
                className: 'fp-v-theme-chip' + (on ? ' fp-v-theme-chip--on' : ''),
                'aria-pressed': on ? 'true' : 'false',
                onClick: function () { applyAccentHue(preset.hue); },
              },
                h('span', { className: 'fp-v-theme-dot', style: { background: 'hsl(' + preset.hue + ' 100% 62%)' } }),
                h('span', null, preset.label));
            })
          ),
          h('label', { className: 'fp-v-theme-custom' },
            h('span', { className: 'fp-v-theme-custom-label' }, '自定义色相 ' + Math.round(accentHue) + '°'),
            h('input', {
              className: 'fp-v-theme-range',
              type: 'range',
              min: 0,
              max: 360,
              step: 1,
              value: Math.round(accentHue),
              'aria-label': '自定义主题色相',
              onChange: function (event) { applyAccentHue(Number(event && event.target ? event.target.value : accentHue)); },
            })
          ),
          h('div', { className: 'fp-v-theme-preview' },
            h('span', { className: 'fp-v-theme-preview-bar' }),
            h('span', { className: 'fp-v-theme-preview-chip' }, '示例标签'),
            h('span', { className: 'fp-v-theme-preview-text' }, '主题色预览')
          )
        )
      ),
      fpvSettingsGroup('同步节奏', null,
        h('div', { className: 'fp-v-sync-interval' },
          h(FpField, { label: '自动同步间隔（分钟）', hint: '1~60 分钟' },
            h('div', { className: 'fp-v-sync-interval-row' },
              h(FpInput, {
                type: 'number',
                value: intervalText,
                width: 96,
                disabled: intervalBusy === true,
                onChange: function (value) { setIntervalText(value); },
                onEnter: saveSyncInterval,
              }),
              h(FpButton, { size: 'sm', variant: 'default', disabled: intervalBusy === true, onClick: saveSyncInterval },
                intervalBusy === true ? '保存中…' : '保存')
            )
          )
        )
      ),
      h(FpWebAccessGroup, { key: 'webaccess' }),
      fpvSettingsGroup(fpvT('settings.workSlots', '工作时段'), null, slotsChildren),
      fpvSettingsGroup('静默窗', null, silentChildren),
      fpvSettingsGroup(fpvT('settings.rhythm', '节奏与提醒'), null, rhythmChildren),
      fpvSettingsGroup('完成与解锁', null, [
        h(FpField, {
          key: 'evidenceKinds',
          label: '完成证据类型',
          hint: '不选 = 任意类型',
        },
          h('div', { className: 'fp-v-chip-row' },
            FP_EVIDENCE_KIND_LABELS && Object.keys(FP_EVIDENCE_KIND_LABELS).length > 0
              ? Object.keys(FP_EVIDENCE_KIND_LABELS).map(function (kind) {
                  const on = draft.evidenceKinds.indexOf(kind) !== -1;
                  return h('button', {
                    key: kind,
                    type: 'button',
                    className: 'fp-v-chip' + (on ? ' fp-v-chip--on' : ''),
                    'aria-pressed': on ? 'true' : 'false',
                    onClick: function () {
                      updateDraft(function (next) {
                        const index = next.evidenceKinds.indexOf(kind);
                        if (index === -1) next.evidenceKinds.push(kind);
                        else next.evidenceKinds.splice(index, 1);
                      });
                    },
                  }, FP_EVIDENCE_KIND_LABELS[kind]);
                })
              : null
          )
        ),
        h(FpField, { key: 'evidenceMin', label: '最少证据链接数', hint: '0 = 不需要证据' },
          h(FpInput, {
            type: 'number',
            width: 96,
            value: draft.evidenceMin,
            onChange: function (value) { updateDraft(function (next) { next.evidenceMin = value; }); },
          })
        ),
        h(FpField, { key: 'unlockPolicy', label: '节点解锁方式', hint: '并行：完成一个后其余一起解锁' },
          h(FpSelect, {
            value: draft.unlockPolicy,
            width: 220,
            options: [
              { value: 'linear', label: '线性：一次解锁下一个' },
              { value: 'parallel', label: '并行：解锁整条流程' },
            ],
            onChange: function (value) { updateDraft(function (next) { next.unlockPolicy = value; }); },
          })
        ),
      ]),
      fpvSettingsGroup('工作周', null, weekChildren),
      fpvSettingsGroup(fpvT('settings.data', '数据与备份'), null, dataChildren),
      h(FpSyncPanel, { key: 'sync-panel' }),
      h(FpUpdatePanel, { key: 'update-panel' }),
      error ? h('div', { className: 'fp-v-form-error', role: 'alert' }, error) : null,
      h('div', { className: 'fp-v-savebar' },
        h('span', { className: 'fp-v-dirty' + (dirty ? ' fp-v-dirty-on' : '') },
          dirty ? '有未保存的设置修改' : '设置已与宿主一致'),
        h('div', { className: 'fp-v-actions-row' },
          fpvBtn('resetDraft', '还原修改', function () {
            setDraft(fpvSettingsDraft(settings));
            setError(null);
          }, { size: 'sm', variant: 'quiet', disabled: !dirty || !!busy }),
          fpvBtn('saveSettings', busy === 'settings' ? '保存中…' : '保存设置', saveSettings, {
            variant: 'primary',
            disabled: !dirty || !!busy,
          })
        )
      ),
      h(FpConfirm, {
        open: confirmReset,
        title: '清空 FlowPilot 全部数据？',
        message: '所有业务线、项目、流程节点、事件、交接与周报都会被删除，且无法撤销。建议先导出备份。',
        confirmLabel: '确认清空',
        danger: true,
        onConfirm: doReset,
        onCancel: function () { setConfirmReset(false); },
      })
    )
  );
}

/* ------------------------------------------------------------------ */
/* 项目概览（未选节点时的中央面板）                                    */
/* ------------------------------------------------------------------ */

function ProjectOverview({ state, derived, project, onSelectNode, onCreateProject, onAddFlow }) {
  const st = state || {};
  const dv = derived || {};

  if (!state || !derived) return fpvLoading('flow', '正在载入项目');

  if (!project) {
    return h('div', { className: 'fp-v-root' },
      h('div', { className: 'fp-v-narrow' },
        h(FpEmptyState, {
          icon: 'flow',
          title: '还没有选中的项目',
          description: '选择一个项目',
          actions: typeof onCreateProject === 'function'
            ? fpvBtn('create', '新建项目', onCreateProject, { variant: 'primary' })
            : null,
        })));
  }

  const line = (Array.isArray(st.businessLines) ? st.businessLines : []).filter(function (item) {
    return item && item.id === project.businessLineId;
  })[0] || null;
  const info = (dv.projects && dv.projects[project.id]) || {};
  const nodes = fpvTry(function () { return fpProjectNodes(st, project.id); }, []);
  const currentNode = info.activeNodeId
    ? fpvTry(function () { return fpNodeById(st, info.activeNodeId); }, null)
    : nodes.filter(function (node) {
      return node.status === 'active' || node.status === 'revision' || node.status === 'ready';
    })[0] || null;
  const followNodes = nodes.filter(function (node) {
    return node.status === 'waiting' || node.status === 'blocked';
  }).slice(0, 3);
  const events = fpvTry(function () { return fpEventsFor(st, { projectId: project.id, limit: 5 }); }, []);
  const progress = typeof info.progress === 'number' ? Math.max(0, Math.min(1, info.progress)) : null;
  const percent = progress === null ? null : Math.round(progress * 100);
  const currentCard = fpvNodeCard(currentNode, st, project);
  const isArchived = project.status === 'archived';

  const statusChips = [
    h(FpChip, {
      key: 'status',
      tone: isArchived ? 'muted' : 'success',
      children: isArchived ? '已归档' : '进行中',
    }),
  ];
  if (project.dueAt) {
    statusChips.push(h(FpChip, {
      key: 'due',
      tone: 'muted',
      children: '截止 ' + fpvTry(function () { return fpFmtDay(project.dueAt); }, ''),
    }));
  }
  if (info.nextDueAt) {
    statusChips.push(h(FpChip, {
      key: 'nextDue',
      tone: 'warn',
      children: '最近截止 ' + fpvTry(function () { return fpFmtDay(info.nextDueAt); }, ''),
    }));
  }

  const head = h('div', { className: 'fp-v-head' },
    h('div', { className: 'fp-v-head-main' },
      h('div', { className: 'fp-v-eyebrow' }, line ? line.name : 'PROJECT'),
      h('h2', { className: 'fp-v-title' }, project.title || '未命名项目'),
      h('div', { className: 'fp-v-chip-row' }, statusChips)
    ),
    h('div', { className: 'fp-v-head-actions' },
      typeof onAddFlow === 'function' ? fpvBtn('addFlow', '添加流程', function () { onAddFlow(project.id); }, {
        size: 'sm',
        variant: 'ghost',
      }) : null
    )
  );

  const archivedNote = isArchived ? h('div', { className: 'fp-v-note' },
    h(FpIcon, { name: 'archive', size: 13 }),
    h('span', {}, '该项目已归档，只读查看历史上下文。')
  ) : null;

  const stageCard = h('div', { className: 'fp-v-card fp-v-stage-card' },
    h('div', { className: 'fp-v-stage-top' },
      h('div', { className: 'fp-v-stage-main' },
        h('div', { className: 'fp-v-eyebrow' }, '当前阶段'),
        h('div', { className: 'fp-v-stage-title' },
          info.currentCode ? h('span', { className: 'fp-v-row-code' }, info.currentCode) : null,
          h('span', {}, info.currentStage || (currentNode ? currentNode.title : '尚未开始'))
        )
      ),
      percent !== null ? h('div', { className: 'fp-v-stage-percent' }, percent + '%') : null
    ),
    percent !== null ? h('div', { className: 'fp-v-progress', role: 'progressbar', 'aria-valuenow': percent, 'aria-valuemin': 0, 'aria-valuemax': 100 },
      h('span', { className: 'fp-v-progress-fill', style: { width: percent + '%' } })) : null,
    h('div', { className: 'fp-v-stage-meta' },
      h('span', {}, '完成 ' + (info.completed || 0) + ' / ' + (info.total || nodes.length || 0) + ' 个节点'),
      h('span', { className: 'fp-v-dot' }, '·'),
      h('span', {}, '可推进 ' + (info.actionable || 0)),
      h('span', { className: 'fp-v-dot' }, '·'),
      h('span', {}, '待跟进 ' + (info.waiting || 0))
    )
  );

  const currentSection = h('div', { className: 'fp-v-section' },
    fpvSectionHead('当前节点', currentCard ? '点击卡片进入节点详情' : null, 'play'),
    currentCard
      ? h('div', { className: 'fp-v-list' }, fpvNodeRow(currentCard, {
        onSelectNode: onSelectNode,
        showReason: false,
        showDue: true,
      }))
      : h('div', { className: 'fp-v-soft' }, info.currentStage ? '当前阶段：' + info.currentStage : '还没有可推进的节点。')
  );

  const followSection = followNodes.length ? h('div', { className: 'fp-v-section' },
    fpvSectionHead('等待跟进', '这些节点需要确认或解除阻塞', 'clock', followNodes.length),
    h('div', { className: 'fp-v-list' }, followNodes.map(function (node) {
      return fpvNodeRow(fpvNodeCard(node, st, project), {
        onSelectNode: onSelectNode,
        showReason: false,
        showDue: true,
        showFollow: true,
      });
    }))
  ) : null;

  const eventRows = (Array.isArray(events) ? events : []).map(function (event, index) {
    return h('div', { key: event.id || 'ev' + index, className: 'fp-v-event' },
      h('span', { className: 'fp-v-event-kind' }, FP_VIEW_EVENT_LABELS[event.kind] || '记录'),
      h('span', { className: 'fp-v-event-detail' }, event.details || ''),
      h('span', { className: 'fp-v-event-time' },
        fpvTry(function () { return fpFmtDateTime(event.timestamp); }, '') +
        (event.round > 1 ? ' · 第 ' + event.round + ' 轮' : ''))
    );
  });

  const eventsSection = h('div', { className: 'fp-v-section' },
    fpvSectionHead('最近事件', null, 'clock', eventRows.length),
    eventRows.length
      ? h('div', { className: 'fp-v-card fp-v-event-card' }, eventRows)
      : h('div', { className: 'fp-v-soft' }, '还没有事件记录。')
  );

  const guideLines = [];
  if (currentNode) {
    guideLines.push('完成一个节点会自动解锁下一步。');
  } else if (info.actionable > 0) {
    guideLines.push('当前有 ' + info.actionable + ' 个节点可推进，选择任意节点在右侧继续。');
  } else {
    guideLines.push('当前没有可推进节点，等待跟进中的节点到时间后再处理。');
  }
  guideLines.push('键盘 ⌘/Ctrl+Enter 完成当前节点，W 键等待；跳过的节点不计入完成成果。');

  const guide = h('div', { className: 'fp-v-card fp-v-guide' },
    h('div', { className: 'fp-v-section-title' },
      h(FpIcon, { name: 'spark', size: 13 }),
      h('span', { className: 'fp-v-section-label' }, '下一步操作')
    ),
    guideLines.map(function (lineText, index) {
      return h('p', { key: 'g' + index, className: 'fp-v-guide-line' }, lineText);
    })
  );

  const noFlowNote = !nodes.length ? h('div', { className: 'fp-v-note' },
    h(FpIcon, { name: 'alert', size: 13 }),
    h('span', {}, '该项目还没有流程节点。' + (typeof onAddFlow === 'function' ? '可以先添加一个流程模板。' : ''))
  ) : null;

  return h('div', { className: 'fp-v-root' },
    h('div', { className: 'fp-v-narrow' },
      head,
      archivedNote,
      noFlowNote,
      stageCard,
      currentSection,
      followSection,
      eventsSection,
      guide
    )
  );
}

/* ------------------------------------------------------------------ */
/* 弹窗：新建项目                                                      */
/* ------------------------------------------------------------------ */

function ProjectCreateDialog({ open, onClose, state, defaultLineId, onCreated }) {
  const st = state || {};
  const lines = (Array.isArray(st.businessLines) ? st.businessLines.slice() : [])
    .filter(function (line) { return line && line.id; })
    .sort(function (a, b) { return (a.sortOrder || 0) - (b.sortOrder || 0); });
  const lineOptions = lines.map(function (line) { return { value: line.id, label: line.name || line.id }; });
  const [lineId, setLineId] = React.useState('');
  const [title, setTitle] = React.useState('');
  const [templates, setTemplates] = React.useState(['delivery']);
  const [dueDate, setDueDate] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState(null);

  React.useEffect(function () {
    if (!open) return;
    setLineId(defaultLineId || (lineOptions[0] && lineOptions[0].value) || '');
    setTitle('');
    setTemplates(['delivery']);
    setDueDate('');
    setError(null);
    setBusy(false);
    /* 打开时重置表单；业务线列表变化时仅补齐默认值 */
  }, [open, defaultLineId, lines.length]);

  if (!open) return null;

  function toggleTemplate(templateId) {
    setTemplates(function (prev) {
      if (prev.indexOf(templateId) >= 0) {
        return prev.filter(function (item) { return item !== templateId; });
      }
      return prev.concat([templateId]);
    });
  }

  async function submit() {
    if (busy) return;
    if (!lineId) {
      setError('请选择业务线（还没有业务线时请先在左侧新建）');
      return;
    }
    if (!title.trim()) {
      setError('请填写项目标题');
      return;
    }
    if (!templates.length) {
      setError('请至少选择一个流程模板');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const response = await fpDispatch('createProject', {
        businessLineId: lineId,
        title: title.trim(),
        templateIds: templates.slice(),
        dueAt: fpvToIso(dueDate, '', '23:59'),
      });
      if (!response || response.ok === false) {
        setError((response && response.error) || '创建项目失败');
        return;
      }
      FpToast.push({ tone: 'success', text: '项目已创建' });
      if (typeof onCreated === 'function') {
        try { onCreated(response.result); } catch (callbackError) { /* 忽略调用方回调异常 */ }
      }
      if (typeof onClose === 'function') onClose();
    } catch (err) {
      setError((err && err.message) || '创建项目失败');
    } finally {
      setBusy(false);
    }
  }

  const canSubmit = !!lineId && !!title.trim() && templates.length > 0;

  return h(FpDialog, {
    open: true,
    title: '新建项目',
    description: null,
    width: 540,
    onClose: function () { if (!busy && typeof onClose === 'function') onClose(); },
    actions: fpvDialogActions(onClose, '创建项目', busy, submit, canSubmit),
  },
  h('form', {
    className: 'fp-v-form',
    onSubmit: function (event) { event.preventDefault(); submit(); },
  },
  h(FpField, { label: '业务线', required: true },
    lineOptions.length
      ? h(FpSelect, {
        value: lineId,
        options: lineOptions,
        onChange: function (event) { setLineId(fpvRead(event, '')); },
      })
      : h('div', { className: 'fp-v-hint-warn' }, '还没有业务线，请先在左侧新建一条业务线。')),
  h(FpField, { label: '项目标题', required: true },
    h(FpInput, {
      value: title,
      placeholder: '例如：活动管理改版',
      autoFocus: true,
      onEnter: submit,
      onChange: function (event) { setTitle(fpvRead(event, '')); },
    })),
  h(FpField, { label: '流程模板', hint: '可多选' },
    h('div', { className: 'fp-v-choice-row' },
      Object.keys(FP_TEMPLATE_META).map(function (templateId) {
        const meta = FP_TEMPLATE_META[templateId] || {};
        const active = templates.indexOf(templateId) >= 0;
        return h(FpChip, {
          key: templateId,
          tone: active ? 'brand' : 'muted',
          dot: active,
          title: meta.title || templateId,
          onClick: function () { toggleTemplate(templateId); },
          children: meta.short || meta.title || templateId,
        });
      }))),
  h(FpField, { label: '交付日期', hint: '可留空' },
    fpvDateField('due', dueDate, setDueDate, { label: '交付日期' })),
  error ? h('div', { className: 'fp-v-form-error', role: 'alert' }, error) : null,
  h('button', { type: 'submit', className: 'fp-v-submit-proxy', tabIndex: -1, 'aria-hidden': 'true' })
  ));
}

/* ------------------------------------------------------------------ */
/* 弹窗：业务线新增 / 重命名                                           */
/* ------------------------------------------------------------------ */

function LineEditDialog({ open, line, onClose }) {
  const isEdit = !!(line && line.id);
  const [name, setName] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState(null);
  const lineId = line ? line.id : '';

  React.useEffect(function () {
    if (!open) return;
    setName(line ? (line.name || '') : '');
    setError(null);
    setBusy(false);
  }, [open, lineId]);

  if (!open) return null;

  async function submit() {
    if (busy) return;
    const value = name.trim();
    if (!value) {
      setError(isEdit ? '请填写新的业务线名称' : '请填写业务线名称');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const response = isEdit
        ? await fpDispatch('renameLine', { lineId: line.id, name: value })
        : await fpDispatch('createLine', { name: value });
      if (!response || response.ok === false) {
        setError((response && response.error) || (isEdit ? '重命名失败' : '新建业务线失败'));
        return;
      }
      FpToast.push({ tone: 'success', text: isEdit ? '业务线已重命名' : '业务线已创建' });
      if (typeof onClose === 'function') onClose();
    } catch (err) {
      setError((err && err.message) || (isEdit ? '重命名失败' : '新建业务线失败'));
    } finally {
      setBusy(false);
    }
  }

  return h(FpDialog, {
    open: true,
    title: isEdit ? '重命名业务线' : '新建业务线',
    description: null,
    width: 420,
    onClose: function () { if (!busy && typeof onClose === 'function') onClose(); },
    actions: fpvDialogActions(onClose, isEdit ? '保存名称' : '创建业务线', busy, submit, !!name.trim()),
  },
  h('form', {
    className: 'fp-v-form',
    onSubmit: function (event) { event.preventDefault(); submit(); },
  },
  h(FpField, { label: '业务线名称', required: true },
    h(FpInput, {
      value: name,
      placeholder: '例如：增长推广',
      autoFocus: true,
      onEnter: submit,
      onChange: function (event) { setName(fpvRead(event, '')); },
    })),
  error ? h('div', { className: 'fp-v-form-error', role: 'alert' }, error) : null,
  h('button', { type: 'submit', className: 'fp-v-submit-proxy', tabIndex: -1, 'aria-hidden': 'true' })
  ));
}

/* ------------------------------------------------------------------ */
/* 弹窗：添加链接                                                      */
/* ------------------------------------------------------------------ */

function LinkDialog({ open, node, onClose }) {
  const [title, setTitle] = React.useState('');
  const [url, setUrl] = React.useState('');
  const [kind, setKind] = React.useState('design');
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState(null);
  const nodeId = node ? node.id : '';

  React.useEffect(function () {
    if (!open) return;
    setTitle('');
    setUrl('');
    setKind('design');
    setError(null);
    setBusy(false);
  }, [open, nodeId]);

  if (!open) return null;

  async function submit() {
    if (busy) return;
    if (!node) {
      setError('请先选择一个节点');
      return;
    }
    let normalized = String(url || '').trim();
    if (!normalized) {
      setError('请填写链接地址');
      return;
    }
    if (!/^https?:\/\//i.test(normalized)) normalized = 'https://' + normalized;
    if (!/^https?:\/\/[^\s]+$/i.test(normalized)) {
      setError('链接地址格式不正确，请填写 http(s) 开头的地址');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const response = await fpDispatch('addLink', {
        nodeId: node.id,
        title: String(title || '').trim() || fpvHostOf(normalized),
        url: normalized,
        kind: kind,
      });
      if (!response || response.ok === false) {
        setError((response && response.error) || '添加链接失败');
        return;
      }
      FpToast.push({ tone: 'success', text: '链接已添加' });
      if (typeof onClose === 'function') onClose();
    } catch (err) {
      setError((err && err.message) || '添加链接失败');
    } finally {
      setBusy(false);
    }
  }

  return h(FpDialog, {
    open: true,
    title: '添加链接',
    description: node ? ('节点：' + (node.code ? node.code + ' ' : '') + (node.title || '')) : '请先选择一个节点。',
    width: 460,
    onClose: function () { if (!busy && typeof onClose === 'function') onClose(); },
    actions: fpvDialogActions(onClose, '添加链接', busy, submit, !!url.trim() && !!node),
  },
  h('form', {
    className: 'fp-v-form',
    onSubmit: function (event) { event.preventDefault(); submit(); },
  },
  h(FpField, { label: '链接类型' },
    h(FpSelect, {
      value: kind,
      options: FP_LINK_KINDS,
      onChange: function (event) { setKind(fpvRead(event, 'design')); },
    })),
  h(FpField, { label: '标题', hint: '默认用域名' },
    h(FpInput, {
      value: title,
      placeholder: '例如：设计稿交互框架',
      onChange: function (event) { setTitle(fpvRead(event, '')); },
    })),
  h(FpField, { label: '链接地址', required: true },
    h(FpInput, {
      value: url,
      placeholder: 'https://…',
      autoFocus: true,
      onEnter: submit,
      onChange: function (event) { setUrl(fpvRead(event, '')); },
    })),
  error ? h('div', { className: 'fp-v-form-error', role: 'alert' }, error) : null,
  h('button', { type: 'submit', className: 'fp-v-submit-proxy', tabIndex: -1, 'aria-hidden': 'true' })
  ));
}

/* ------------------------------------------------------------------ */
/* 弹窗：计划与跟进时间                                                */
/* ------------------------------------------------------------------ */

function ScheduleDialog({ open, node, onClose }) {
  const [dueDate, setDueDate] = React.useState('');
  const [dueTime, setDueTime] = React.useState('');
  const [followDate, setFollowDate] = React.useState('');
  const [followTime, setFollowTime] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState(null);
  const nodeId = node ? node.id : '';
  const nodeDueAt = node ? (node.dueAt || '') : '';
  const nodeFollowUpAt = node ? (node.followUpAt || '') : '';

  React.useEffect(function () {
    if (!open) return;
    setDueDate(fpvDateInput(nodeDueAt));
    setDueTime(fpvTimeInput(nodeDueAt));
    setFollowDate(fpvDateInput(nodeFollowUpAt));
    setFollowTime(fpvTimeInput(nodeFollowUpAt));
    setError(null);
    setBusy(false);
  }, [open, nodeId, nodeDueAt, nodeFollowUpAt]);

  if (!open) return null;

  async function submit() {
    if (busy) return;
    if (!node) {
      setError('请先选择一个节点');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const response = await fpDispatch('setNodeSchedule', {
        nodeId: node.id,
        dueAt: fpvToIso(dueDate, dueTime, '18:00'),
        followUpAt: fpvToIso(followDate, followTime, '11:00'),
      });
      if (!response || response.ok === false) {
        setError((response && response.error) || '保存计划失败');
        return;
      }
      FpToast.push({ tone: 'success', text: '计划已更新' });
      if (typeof onClose === 'function') onClose();
    } catch (err) {
      setError((err && err.message) || '保存计划失败');
    } finally {
      setBusy(false);
    }
  }

  return h(FpDialog, {
    open: true,
    title: '计划与跟进时间',
    description: node ? ('节点：' + (node.code ? node.code + ' ' : '') + (node.title || '')) : '请先选择一个节点。',
    width: 500,
    onClose: function () { if (!busy && typeof onClose === 'function') onClose(); },
    actions: fpvDialogActions(onClose, '保存时间', busy, submit, !!node),
  },
  h('form', {
    className: 'fp-v-form',
    onSubmit: function (event) { event.preventDefault(); submit(); },
  },
  h(FpField, { label: '计划时间', hint: '留空不设定' },
    fpvDateTimeRow({
      key: 'due',
      label: '计划',
      date: dueDate,
      time: dueTime,
      onDate: setDueDate,
      onTime: setDueTime,
      onClear: function () { setDueDate(''); setDueTime(''); },
      disabled: busy,
    })),
  h(FpField, { label: '跟进时间', hint: '留空不提醒' },
    fpvDateTimeRow({
      key: 'follow',
      label: '跟进',
      date: followDate,
      time: followTime,
      onDate: setFollowDate,
      onTime: setFollowTime,
      onClear: function () { setFollowDate(''); setFollowTime(''); },
      disabled: busy,
    })),
  error ? h('div', { className: 'fp-v-form-error', role: 'alert' }, error) : null,
  h('button', { type: 'submit', className: 'fp-v-submit-proxy', tabIndex: -1, 'aria-hidden': 'true' })
  ));
}

/* ------------------------------------------------------------------ */
/* 弹窗：阻塞 / 退回 / 跳过原因                                        */
/* ------------------------------------------------------------------ */

function ReasonDialog({ open, mode, node, onClose }) {
  const currentMode = mode === 'revision' || mode === 'skip' ? mode : 'block';
  const meta = currentMode === 'revision'
    ? {
      title: '退回修改',
      reasonLabel: '退回原因',
      hint: '轮次 +1，请说明需要改什么',
      placeholder: '例如：交互稿缺少空状态说明，需要补充后重新确认。',
      submitLabel: '确认退回',
      toast: '已退回，进入待修改',
      danger: true,
    }
    : currentMode === 'skip'
      ? {
        title: '跳过节点',
        reasonLabel: '跳过原因',
        hint: '不计入完成成果',
        placeholder: '例如：本次范围不含该节点，经确认跳过。',
        submitLabel: '确认跳过',
        toast: '节点已跳过',
        danger: true,
      }
      : {
        title: '标记阻塞',
        reasonLabel: '阻塞原因',
        hint: '说明卡在哪、在等谁',
        placeholder: '例如：等待产品确认交互稿，周三前给反馈。',
        submitLabel: '标记阻塞',
        toast: '已标记为阻塞',
        danger: false,
      };

  const [reason, setReason] = React.useState('');
  const [followDate, setFollowDate] = React.useState('');
  const [followTime, setFollowTime] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState(null);
  const nodeId = node ? node.id : '';

  React.useEffect(function () {
    if (!open) return;
    setReason('');
    setFollowDate('');
    setFollowTime('');
    setError(null);
    setBusy(false);
  }, [open, currentMode, nodeId]);

  if (!open) return null;

  async function submit() {
    if (busy) return;
    if (!node) {
      setError('请先选择一个节点');
      return;
    }
    const value = reason.trim();
    if (!value) {
      setError('请填写' + meta.reasonLabel);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      let response;
      if (currentMode === 'block') {
        response = await fpDispatch('blockNode', {
          nodeId: node.id,
          reason: value,
          followUpAt: fpvToIso(followDate, followTime, '11:00'),
        });
      } else if (currentMode === 'revision') {
        response = await fpDispatch('reopenNode', { nodeId: node.id, reason: value });
      } else {
        response = await fpDispatch('skipNode', { nodeId: node.id, reason: value });
      }
      if (!response || response.ok === false) {
        setError((response && response.error) || (meta.title + '失败'));
        return;
      }
      FpToast.push({ tone: 'success', text: meta.toast });
      if (typeof onClose === 'function') onClose();
    } catch (err) {
      setError((err && err.message) || (meta.title + '失败'));
    } finally {
      setBusy(false);
    }
  }

  return h(FpDialog, {
    open: true,
    title: meta.title,
    description: node ? ('节点：' + (node.code ? node.code + ' ' : '') + (node.title || '')) : '请先选择一个节点。',
    width: 480,
    danger: meta.danger,
    onClose: function () { if (!busy && typeof onClose === 'function') onClose(); },
    actions: fpvDialogActions(onClose, meta.submitLabel, busy, submit, !!node && !!reason.trim()),
  },
  h('form', {
    className: 'fp-v-form',
    onSubmit: function (event) { event.preventDefault(); submit(); },
  },
  h(FpField, { label: meta.reasonLabel, hint: meta.hint, required: true },
    h(FpTextarea, {
      value: reason,
      rows: 3,
      autoFocus: true,
      placeholder: meta.placeholder,
      onChange: function (event) { setReason(fpvRead(event, '')); },
      onKeyDown: function (event) {
        if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
          event.preventDefault();
          submit();
        }
      },
    })),
  currentMode === 'block' ? h(FpField, { label: '跟进时间', hint: '可选' },
    fpvDateTimeRow({
      key: 'follow',
      label: '跟进',
      date: followDate,
      time: followTime,
      onDate: setFollowDate,
      onTime: setFollowTime,
      onClear: function () { setFollowDate(''); setFollowTime(''); },
      disabled: busy,
    })) : null,
  error ? h('div', { className: 'fp-v-form-error', role: 'alert' }, error) : null,
  h('button', { type: 'submit', className: 'fp-v-submit-proxy', tabIndex: -1, 'aria-hidden': 'true' })
  ));
}

/* ------------------------------------------------------------------ */
/* 弹窗：加自定义节点                                                  */
/* ------------------------------------------------------------------ */

function NodeAddDialog({ open, flow, onClose }) {
  const [title, setTitle] = React.useState('');
  const [detail, setDetail] = React.useState('');
  const [role, setRole] = React.useState('设计');
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState(null);
  const flowId = flow ? flow.id : '';

  React.useEffect(function () {
    if (!open) return;
    setTitle('');
    setDetail('');
    setRole('设计');
    setError(null);
    setBusy(false);
  }, [open, flowId]);

  if (!open) return null;

  async function submit() {
    if (busy) return;
    if (!flow) {
      setError('请先选择一个流程');
      return;
    }
    if (!title.trim()) {
      setError('请填写节点标题');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const response = await fpDispatch('addNode', {
        flowId: flow.id,
        title: title.trim(),
        detail: detail.trim(),
        assigneeRole: role,
      });
      if (!response || response.ok === false) {
        setError((response && response.error) || '添加节点失败');
        return;
      }
      FpToast.push({ tone: 'success', text: '节点已添加' });
      if (typeof onClose === 'function') onClose();
    } catch (err) {
      setError((err && err.message) || '添加节点失败');
    } finally {
      setBusy(false);
    }
  }

  return h(FpDialog, {
    open: true,
    title: '添加自定义节点',
    description: flow ? ('流程：' + (flow.name || flow.templateId || '未命名流程') + '（追加到流程末尾）') : '请先选择一个流程。',
    width: 500,
    onClose: function () { if (!busy && typeof onClose === 'function') onClose(); },
    actions: fpvDialogActions(onClose, '添加节点', busy, submit, !!flow && !!title.trim()),
  },
  h('form', {
    className: 'fp-v-form',
    onSubmit: function (event) { event.preventDefault(); submit(); },
  },
  h(FpField, { label: '节点标题', required: true },
    h(FpInput, {
      value: title,
      placeholder: '例如：补充数据埋点方案',
      autoFocus: true,
      onEnter: submit,
      onChange: function (event) { setTitle(fpvRead(event, '')); },
    })),
  h(FpField, { label: '节点说明' },
    h(FpTextarea, {
      value: detail,
      rows: 2,
      placeholder: '补充这个节点要做什么、产出是什么。',
      onChange: function (event) { setDetail(fpvRead(event, '')); },
    })),
  h(FpField, { label: '负责角色', hint: '负责研发的节点解锁后会进入「待确认」而不是「待开始」。' },
    h(FpSelect, {
      value: role,
      options: FP_VIEW_ROLE_OPTIONS,
      onChange: function (event) { setRole(fpvRead(event, '设计')); },
    })),
  error ? h('div', { className: 'fp-v-form-error', role: 'alert' }, error) : null,
  h('button', { type: 'submit', className: 'fp-v-submit-proxy', tabIndex: -1, 'aria-hidden': 'true' })
  ));
}

/* ------------------------------------------------------------------ */
/* 样式                                                                */
/* ------------------------------------------------------------------ */

const CSS_VIEWS = String.raw`
/* ===== ui-views · 设计系统 令牌别名（只做别名，颜色全部来自 --fp-*；4 栅格 / 无描边） ===== */
.fp-v-root,
.fp-v-form{
  --fp-v-gap:16px;
  --fp-v-radius:var(--fp-radius-lg);
  --fp-v-radius-sm:var(--fp-radius-md);
  --fp-v-text:var(--fp-text);
  --fp-v-text-2:var(--fp-text-dim);
  --fp-v-text-3:var(--fp-text-tertiary);
  --fp-v-text-4:var(--fp-text-quaternary);
  --fp-v-line:var(--fp-border);
  --fp-v-line-2:var(--fp-border-strong);
  --fp-v-canvas:var(--fp-surface-2);
  --fp-v-card:var(--fp-surface);
  --fp-v-hover:var(--fp-hover);
  --fp-v-pressed:var(--fp-pressed);
  --fp-v-brand:var(--fp-accent);
  --fp-v-brand-soft:color-mix(in srgb, var(--fp-accent) 12%, transparent);
  --fp-v-ok:var(--fp-ok);
  --fp-v-warn:var(--fp-warn-strong);
  --fp-v-bad:var(--fp-bad);
  --fp-v-info:var(--fp-info);
  --fp-v-mono:var(--fp-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
}

/* ===== 页面骨架 ===== */
.fp-v-root{
  display:flex;
  flex:1 1 auto;
  flex-direction:column;
  gap:var(--fp-v-gap);
  height:100%;
  min-height:0;
  overflow-y:auto;
  padding:16px 20px 32px;
  box-sizing:border-box;
  color:var(--fp-v-text);
  font-size:var(--fp-font-md);
  line-height:1.55;
}
.fp-v-root.fp-v-compact{height:auto;overflow:visible;padding:0;gap:16px;}
.fp-v-narrow{width:100%;max-width:940px;margin:0 auto;display:flex;flex-direction:column;gap:var(--fp-v-gap);min-width:0;}
.fp-v-title{margin:0;font-size:var(--fp-font-xl);font-weight:650;letter-spacing:-0.01em;line-height:1.35;color:var(--fp-v-text);overflow-wrap:anywhere;}
.fp-v-eyebrow{font-size:var(--fp-font-xs);font-weight:600;letter-spacing:0.08em;text-transform:uppercase;color:var(--fp-v-text-4);}
.fp-v-sub{font-size:var(--fp-font-sm);color:var(--fp-v-text-2);overflow-wrap:anywhere;}
.fp-v-head{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;flex-wrap:wrap;}
.fp-v-head-main{display:flex;flex-direction:column;gap:4px;min-width:0;flex:1 1 320px;}
.fp-v-head-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap;justify-content:flex-end;}
.fp-v-actions-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap;}
.fp-v-actions-row-end{justify-content:flex-end;}
.fp-v-seg{display:inline-flex;align-items:center;gap:4px;padding:4px;border-radius:var(--fp-radius-pill);background:var(--fp-surface-2);}
.fp-v-seg .fp-btn{border-radius:var(--fp-radius-pill);}

/* ===== 面层级卡片 ===== */
.fp-v-card{background:var(--fp-surface);border-radius:var(--fp-radius-lg);padding:16px;display:flex;flex-direction:column;gap:12px;min-width:0;}
.fp-v-card-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;flex-wrap:wrap;}
.fp-v-section{display:flex;flex-direction:column;gap:8px;min-width:0;}
.fp-v-section-head{display:flex;align-items:baseline;justify-content:space-between;gap:12px;flex-wrap:wrap;padding:0 4px;}
.fp-v-section-title{display:flex;align-items:center;gap:8px;font-size:var(--fp-font-md);font-weight:650;color:var(--fp-v-text);min-width:0;}
.fp-v-section-title svg{color:var(--fp-v-text-4);flex:0 0 auto;}
.fp-v-section-label{overflow-wrap:anywhere;}
.fp-v-section-hint{font-size:var(--fp-font-xs);color:var(--fp-v-text-4);text-align:right;overflow-wrap:anywhere;}
.fp-v-section-count{display:inline-flex;align-items:center;justify-content:center;min-width:20px;height:20px;padding:0 4px;border-radius:var(--fp-radius-sm);background:var(--fp-surface-2);color:var(--fp-v-text-3);font-size:10px;font-weight:700;}
.fp-v-list{display:flex;flex-direction:column;gap:4px;min-width:0;background:var(--fp-surface);border-radius:var(--fp-radius-lg);padding:8px;}
.fp-v-card .fp-v-list{background:transparent;padding:0;}
.fp-v-soft{font-size:var(--fp-font-sm);color:var(--fp-v-text-4);padding:12px 8px;overflow-wrap:anywhere;}
.fp-v-hint-warn{font-size:var(--fp-font-sm);color:var(--fp-v-warn);}
.fp-v-k{display:block;font-size:var(--fp-font-xs);font-weight:600;letter-spacing:0.06em;text-transform:uppercase;color:var(--fp-v-text-4);margin-bottom:4px;}
.fp-v-pre{margin:0;white-space:pre-wrap;overflow-wrap:anywhere;font-size:var(--fp-font-sm);line-height:1.6;color:var(--fp-v-text-2);}
.fp-v-dot{color:var(--fp-v-text-4);}
.fp-v-mono{font-family:var(--fp-v-mono);font-size:var(--fp-font-xs);color:var(--fp-v-text-2);overflow-wrap:anywhere;word-break:break-all;}
.fp-v-chip-row{display:flex;align-items:center;gap:4px;flex-wrap:wrap;min-width:0;}
.fp-v-chip-row-end{justify-content:flex-end;}

/* ===== 上一次交接上下文：业务强调色 12% 面色，无描边 ===== */
.fp-v-banner{display:flex;flex-direction:column;gap:12px;padding:16px;border-radius:var(--fp-radius-lg);background:color-mix(in srgb, var(--fp-accent) 12%, transparent);min-width:0;}
.fp-v-banner-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap;}
.fp-v-banner-head svg{color:var(--fp-accent-strong);flex:0 0 auto;}
.fp-v-banner-title{font-size:var(--fp-font-sm);font-weight:650;color:var(--fp-v-text);}
.fp-v-banner-time{font-size:var(--fp-font-xs);color:var(--fp-v-text-3);}
.fp-v-banner-block{display:flex;flex-direction:column;gap:4px;min-width:0;}

/* ===== 列表行：无卡无边，靠 hover 面与文本色阶 ===== */
.fp-v-row{display:flex;align-items:flex-start;gap:12px;padding:8px 12px;border-radius:var(--fp-radius-md);background:transparent;min-width:0;text-align:left;color:inherit;font:inherit;}
.fp-v-row[role="button"]{cursor:pointer;transition:background-color 140ms ease;}
.fp-v-row[role="button"]:hover{background:var(--fp-hover);}
.fp-v-row[role="button"]:active{background:var(--fp-pressed);}
.fp-v-row[role="button"]:focus-visible{outline:2px solid color-mix(in srgb, var(--fp-accent) 55%, transparent);outline-offset:-2px;border-radius:var(--fp-radius-md);}
.fp-v-row-code{flex:0 0 auto;display:inline-block;padding:0 4px;border-radius:var(--fp-radius-sm);background:color-mix(in srgb, var(--fp-accent) 12%, transparent);color:var(--fp-accent-strong);font-family:var(--fp-v-mono);font-size:10px;font-weight:700;line-height:16px;}
.fp-v-row-main{display:flex;flex-direction:column;gap:4px;min-width:0;flex:1 1 auto;}
.fp-v-row-title{font-size:var(--fp-font-md);font-weight:600;color:var(--fp-v-text);overflow-wrap:anywhere;line-height:1.45;}
.fp-v-row-meta{display:flex;align-items:center;gap:4px;flex-wrap:wrap;font-size:var(--fp-font-xs);color:var(--fp-v-text-3);min-width:0;}
.fp-v-row-link{border:none;background:none;padding:0;color:var(--fp-info);font:inherit;font-size:var(--fp-font-xs);cursor:pointer;text-decoration:none;overflow-wrap:anywhere;text-align:left;}
.fp-v-row-link:hover{text-decoration:underline;}
.fp-v-row-link:focus-visible{outline:2px solid color-mix(in srgb, var(--fp-accent) 55%, transparent);outline-offset:2px;border-radius:var(--fp-radius-sm);}
.fp-v-row-side{flex:0 0 auto;display:flex;flex-direction:column;align-items:flex-end;gap:4px;max-width:52%;}
.fp-v-row-extras{display:flex;flex-wrap:wrap;gap:4px;font-size:var(--fp-font-xs);color:var(--fp-v-text-3);}
.fp-v-row-subtext{overflow-wrap:anywhere;color:var(--fp-v-text-3);}

/* ===== 提示条 ===== */
.fp-v-note{display:flex;align-items:flex-start;gap:8px;padding:12px 16px;border-radius:var(--fp-radius-md);background:var(--fp-surface-2);color:var(--fp-v-text-2);font-size:var(--fp-font-sm);line-height:1.5;overflow-wrap:anywhere;}
.fp-v-note svg{flex:0 0 auto;color:var(--fp-v-text-4);}
.fp-v-note-ok{background:color-mix(in srgb, var(--fp-ok) 12%, transparent);color:var(--fp-v-text);}
.fp-v-note-ok svg{color:var(--fp-ok);}

/* ===== 周报：编辑区 = 下沉嵌块 + 聚焦环 ===== */
.fp-v-editor-head{display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap;}
.fp-v-editor-meta{font-size:var(--fp-font-xs);color:var(--fp-v-text-3);overflow-wrap:anywhere;}
.fp-v-editor{min-width:0;background:var(--fp-surface-2);border-radius:var(--fp-radius-md);padding:12px;transition:box-shadow 140ms ease;}
.fp-v-editor:focus-within{box-shadow:0 0 0 2px color-mix(in srgb, var(--fp-accent) 45%, transparent);}
.fp-v-editor textarea{width:100%;min-height:320px;background:transparent;color:var(--fp-v-text);border:none;outline:none;padding:0;font-family:var(--fp-v-mono);font-size:var(--fp-font-sm);line-height:1.7;resize:vertical;tab-size:2;}
.fp-v-editor textarea::placeholder{color:var(--fp-v-text-4);}
.fp-v-editor-foot{display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap;padding-top:4px;}
.fp-v-editor-state{font-size:var(--fp-font-xs);color:var(--fp-v-text-3);}
.fp-v-editor-state-dirty{color:var(--fp-v-warn);}
.fp-v-empty-card{padding:8px 16px;}
.fp-v-form-error{display:flex;align-items:flex-start;gap:8px;padding:8px 12px;border-radius:var(--fp-radius-md);background:color-mix(in srgb, var(--fp-bad) 12%, transparent);color:var(--fp-bad);font-size:var(--fp-font-sm);line-height:1.5;overflow-wrap:anywhere;}

/* ===== 交接：勾选行 + 历史嵌块 ===== */
.fp-v-check{display:flex;align-items:center;gap:8px;padding:8px 12px;border-radius:var(--fp-radius-md);background:transparent;min-width:0;transition:background-color 140ms ease;}
.fp-v-check:hover{background:var(--fp-hover);}
.fp-v-check-on{background:color-mix(in srgb, var(--fp-accent) 10%, transparent);}
.fp-v-check-on:hover{background:color-mix(in srgb, var(--fp-accent) 16%, transparent);}
.fp-v-check-main{display:flex;align-items:center;gap:8px;min-width:0;flex:1 1 auto;cursor:pointer;}
.fp-v-check-box{flex:0 0 auto;width:16px;height:16px;accent-color:var(--fp-accent);cursor:pointer;margin:0;}
.fp-v-check-body{display:flex;flex-direction:column;gap:4px;min-width:0;}
.fp-v-check-title{font-size:var(--fp-font-md);font-weight:600;color:var(--fp-v-text);overflow-wrap:anywhere;line-height:1.4;}
.fp-v-check-meta{font-size:var(--fp-font-xs);color:var(--fp-v-text-3);overflow-wrap:anywhere;}
.fp-v-check-side{display:flex;align-items:center;gap:8px;flex-wrap:wrap;justify-content:flex-end;flex:0 0 auto;}
.fp-v-field-block{display:flex;flex-direction:column;gap:8px;min-width:0;}
.fp-v-label{font-size:var(--fp-font-sm);font-weight:600;color:var(--fp-v-text-2);}
.fp-v-label-inline{font-weight:500;}
.fp-v-history-item{display:flex;flex-direction:column;gap:8px;padding:12px 16px;border-radius:var(--fp-radius-md);background:var(--fp-surface-2);min-width:0;}
.fp-v-history-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap;}
.fp-v-history-date{font-size:var(--fp-font-md);font-weight:650;color:var(--fp-v-text);}
.fp-v-history-time{font-size:var(--fp-font-xs);color:var(--fp-v-text-4);}
.fp-v-history-text{margin:0;font-size:var(--fp-font-sm);color:var(--fp-v-text-2);white-space:pre-wrap;overflow-wrap:anywhere;}
.fp-v-history-note{margin:0;font-size:var(--fp-font-xs);color:var(--fp-v-text-3);white-space:pre-wrap;overflow-wrap:anywhere;padding-left:12px;box-shadow:inset 2px 0 0 var(--fp-border-strong);}

/* ===== 设置：外层 surface 卡 + 行内表单，输入 = 下沉面无描边 ===== */
.fp-v-settings{max-width:760px;}
/* 同步 / 版本更新面板也作为「功能卡片」承接：卡片底 surface，内部小卡 surface-2 */
.fp-v-settings > .fp-sync,
.fp-v-settings > .fp-update {
  background: var(--fp-surface);
  border-radius: var(--fp-radius-lg);
  padding: var(--fp-sp-4);
}
.fp-v-group{display:flex;flex-direction:column;gap:12px;padding:16px;border-radius:var(--fp-radius-lg);background:var(--fp-surface);min-width:0;}
.fp-v-group-head{display:flex;align-items:baseline;justify-content:space-between;gap:12px;flex-wrap:wrap;}
.fp-v-group-title{font-size:var(--fp-font-md);font-weight:650;color:var(--fp-v-text);}
.fp-v-group-hint{font-size:var(--fp-font-xs);color:var(--fp-v-text-4);text-align:right;overflow-wrap:anywhere;}
.fp-v-group-body{display:flex;flex-direction:column;gap:12px;min-width:0;}
.fp-v-slot-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap;min-width:0;padding:8px 12px;border-radius:var(--fp-radius-md);}
.fp-v-text-inline{flex:1 1 150px;min-width:120px;height:32px;padding:0 12px;border-radius:var(--fp-radius-md);border:none;background:var(--fp-surface-2);color:var(--fp-v-text);font:inherit;font-size:var(--fp-font-sm);}
.fp-v-text-inline::placeholder{color:var(--fp-v-text-4);}
.fp-v-text-inline:focus-visible{outline:none;box-shadow:0 0 0 2px color-mix(in srgb, var(--fp-accent) 45%, transparent);}
.fp-v-time-pair{display:inline-flex;align-items:center;gap:4px;flex:0 0 auto;}
.fp-v-sep{font-size:var(--fp-font-xs);color:var(--fp-v-text-4);}
.fp-v-time,.fp-v-date{height:32px;padding:0 8px;border-radius:var(--fp-radius-md);border:none;background:var(--fp-surface-2);color:var(--fp-v-text);font:inherit;font-size:var(--fp-font-sm);}
.fp-v-time{width:96px;}
.fp-v-date{width:144px;}
.fp-v-time:focus-visible,.fp-v-date:focus-visible{outline:none;box-shadow:0 0 0 2px color-mix(in srgb, var(--fp-accent) 45%, transparent);}
.fp-v-time:disabled,.fp-v-date:disabled,.fp-v-text-inline:disabled{opacity:0.55;cursor:not-allowed;}
.fp-v-setting-row{display:flex;align-items:center;gap:12px;flex-wrap:wrap;min-width:0;padding:8px 12px;border-radius:var(--fp-radius-md);}
.fp-v-setting-row-top{align-items:flex-start;}
.fp-v-setting-row .fp-v-label{flex:0 0 96px;}
.fp-v-setting-hint{font-size:var(--fp-font-xs);color:var(--fp-v-text-4);overflow-wrap:anywhere;flex:1 1 160px;}
.fp-v-setting-value{font-size:var(--fp-font-sm);color:var(--fp-v-text-2);}
.fp-v-select-wrap{display:inline-flex;align-items:center;}
.fp-v-data-path{display:flex;align-items:center;gap:8px;flex:1 1 240px;min-width:0;padding:8px 12px;border-radius:var(--fp-radius-md);background:var(--fp-surface-2);}
.fp-v-data-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:4px 12px;}
.fp-v-setting-warn{margin:0;font-size:var(--fp-font-xs);color:var(--fp-v-text-4);line-height:1.5;overflow-wrap:anywhere;padding:0 12px;}
.fp-v-savebar{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;padding:12px 16px;border-radius:var(--fp-radius-lg);background:var(--fp-surface);}
.fp-v-dirty{font-size:var(--fp-font-sm);color:var(--fp-v-text-3);}
.fp-v-dirty-on{color:var(--fp-v-warn);}

/* ===== 项目概览 ===== */
.fp-v-stage-card{gap:12px;}
.fp-v-stage-top{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;}
.fp-v-stage-main{display:flex;flex-direction:column;gap:4px;min-width:0;}
.fp-v-stage-title{display:flex;align-items:center;gap:8px;font-size:var(--fp-font-lg);font-weight:650;color:var(--fp-v-text);overflow-wrap:anywhere;}
.fp-v-stage-percent{font-size:var(--fp-font-xl);font-weight:700;color:var(--fp-accent);line-height:1;flex:0 0 auto;}
.fp-v-progress{height:8px;border-radius:var(--fp-radius-pill);background:var(--fp-surface-2);overflow:hidden;}
.fp-v-progress-fill{display:block;height:100%;border-radius:var(--fp-radius-pill);background:var(--fp-accent);transition:width 200ms ease;}
.fp-v-stage-meta{display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:var(--fp-font-xs);color:var(--fp-v-text-3);}
.fp-v-event-card{gap:0;padding:4px 16px;}
.fp-v-event{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap;padding:8px 0;font-size:var(--fp-font-sm);min-width:0;box-shadow:inset 0 -1px 0 var(--fp-border);}
.fp-v-event:last-child{box-shadow:none;}
.fp-v-event-kind{flex:0 0 auto;padding:0 4px;border-radius:var(--fp-radius-sm);background:var(--fp-surface-2);color:var(--fp-v-text-3);font-size:10px;font-weight:600;}
.fp-v-event-detail{flex:1 1 160px;min-width:0;color:var(--fp-v-text-2);overflow-wrap:anywhere;}
.fp-v-event-time{flex:0 0 auto;font-size:var(--fp-font-xs);color:var(--fp-v-text-4);}
.fp-v-guide{gap:8px;}
.fp-v-guide-line{margin:0;font-size:var(--fp-font-sm);color:var(--fp-v-text-2);line-height:1.6;overflow-wrap:anywhere;}

/* ===== 弹窗表单（FpDialog 传送门内同样使用 --fp-v-* 别名） ===== */
.fp-v-form{display:flex;flex-direction:column;gap:16px;min-width:0;}
.fp-v-choice-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap;}
.fp-v-input-line{display:flex;align-items:center;gap:8px;flex-wrap:wrap;min-width:0;}
.fp-v-submit-proxy{position:absolute;width:0;height:0;padding:0;margin:0;border:0;opacity:0;pointer-events:none;overflow:hidden;}

/* ===== 窄屏 ===== */
@media (max-width:720px){
  .fp-v-root{padding:16px 16px 24px;}
  .fp-v-row{flex-wrap:wrap;}
  .fp-v-row-side{max-width:100%;width:100%;align-items:flex-start;}
  .fp-v-chip-row-end{justify-content:flex-start;}
  .fp-v-check{flex-wrap:wrap;}
  .fp-v-check-side{width:100%;justify-content:flex-start;}
  .fp-v-setting-row .fp-v-label{flex-basis:100%;}
  .fp-v-data-path{flex-basis:100%;}
  .fp-v-section-hint{text-align:left;}
}

/* ---- 外观 · 主题色 ---- */
.fp-v-theme {
  display: flex;
  flex-direction: column;
  gap: var(--fp-sp-3);
}
.fp-v-theme-row {
  display: flex;
  flex-wrap: wrap;
  gap: var(--fp-sp-2);
}
.fp-v-theme-chip {
  display: inline-flex;
  align-items: center;
  gap: var(--fp-sp-2);
  height: 32px;
  padding: 0 var(--fp-sp-3);
  border: 0;
  border-radius: var(--fp-radius-pill);
  background: var(--fp-surface-2);
  color: var(--fp-text-dim);
  font: inherit;
  font-size: var(--fp-font-sm);
  cursor: pointer;
  transition: background-color 140ms ease, color 140ms ease;
}
.fp-v-theme-chip:hover { background: var(--fp-pressed); color: var(--fp-text); }
.fp-v-theme-chip--on {
  background: color-mix(in srgb, var(--fp-accent) 14%, transparent);
  color: var(--fp-accent-strong);
  font-weight: 600;
}
.fp-v-theme-dot {
  width: 12px;
  height: 12px;
  flex: none;
  border-radius: var(--fp-radius-pill);
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--fp-text) 8%, transparent);
}
.fp-v-theme-custom {
  display: flex;
  flex-direction: column;
  gap: var(--fp-sp-2);
}
.fp-v-theme-custom-label {
  font-size: var(--fp-font-xs);
  color: var(--fp-text-tertiary);
}
.fp-v-theme-range {
  width: 100%;
  height: 20px;
  margin: 0;
  accent-color: var(--fp-accent);
  cursor: pointer;
}
.fp-v-theme-preview {
  display: flex;
  align-items: center;
  gap: var(--fp-sp-2);
  padding: var(--fp-sp-2) var(--fp-sp-3);
  border-radius: var(--fp-radius-md);
  background: var(--fp-surface-2);
}
.fp-v-theme-preview-bar {
  width: 3px;
  height: 24px;
  flex: none;
  border-radius: var(--fp-radius-pill);
  background: var(--fp-accent);
}
.fp-v-theme-preview-chip {
  padding: 0 var(--fp-sp-2);
  height: 22px;
  display: inline-flex;
  align-items: center;
  border-radius: var(--fp-radius-pill);
  background: color-mix(in srgb, var(--fp-accent) 14%, transparent);
  color: var(--fp-accent-strong);
  font-size: var(--fp-font-xs);
  font-weight: 600;
}
.fp-v-theme-preview-text {
  font-size: var(--fp-font-xs);
  color: var(--fp-text-dim);
}

/* ---- 同步节奏 ---- */
.fp-v-webaccess-row {
  display: flex;
  align-items: center;
  gap: var(--fp-sp-2);
}
.fp-v-webaccess-url {
  display: flex;
  align-items: center;
  gap: var(--fp-sp-2);
  padding: var(--fp-sp-2) var(--fp-sp-3);
  border-radius: var(--fp-radius-md);
  background: var(--fp-surface-2);
}
.fp-v-webaccess-link {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: var(--fp-mono);
  font-size: var(--fp-font-xs);
  color: var(--fp-text-dim);
}
.fp-v-sync-interval-row {
  display: flex;
  align-items: center;
  gap: var(--fp-sp-2);
}

/* ---- 设置：证据类型多选 chip ---- */
.fp-v-chip{
  height:28px;padding:0 12px;border:0;border-radius:var(--fp-radius-pill);
  background:var(--fp-surface-2);color:var(--fp-text-dim);
  font:inherit;font-size:var(--fp-font-xs);cursor:pointer;
  transition:background-color 140ms ease,color 140ms ease;
}
.fp-v-chip:hover{background:var(--fp-pressed);color:var(--fp-text);}
.fp-v-chip--on{
  background:color-mix(in srgb,var(--fp-accent) 14%,transparent);
  color:var(--fp-accent-strong);font-weight:600;
}
`;
