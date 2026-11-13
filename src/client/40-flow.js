/* ===== 归属：ui-flow · 流程画布（FlowView）与节点详情（NodeDetail） =====
 * 产品核心：纵向节点流 + 右侧 344px 节点详情。
 * 这里只做「读 state/derived 的展示」与「把动作 dispatch 给宿主」两件事；
 * 解锁、完成门槛、双角色确认与退回等业务规则全部由宿主判定（见契约 §4）。
 */

const FP_FLOW_EVENT_LABELS = {
  nodeStatus: '状态变更',
  approvalPassed: '确认通过',
  approvalRejected: '确认退回',
  revision: '返工',
  unlocked: '解锁后继',
  projectCreated: '创建项目',
  projectUpdated: '更新项目',
  projectArchived: '归档变更',
  flowAdded: '新增流程',
  nodeAdded: '新增节点',
  nodeRemoved: '删除节点',
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

/* ------------------------------------------------------------------ *
 * 小工具（纯函数，前缀 fpFlow 避免与其它片段重名）
 * ------------------------------------------------------------------ */

function fpFlowClass() {
  let out = '';
  for (let index = 0; index < arguments.length; index += 1) {
    const part = arguments[index];
    if (typeof part === 'string' && part !== '') {
      out = out === '' ? part : out + ' ' + part;
    }
  }
  return out;
}

function fpFlowToast(text, tone) {
  try {
    FpToast.push({ tone: tone || 'success', text: text });
  } catch (error) {
    /* 控件层尚未就绪时静默 */
  }
}

/** 兼容 shell 传 selectedNodeId 字符串或 selection 对象。 */
function fpFlowSelectionNodeId(selection) {
  if (!selection) return null;
  if (typeof selection === 'string') return selection;
  return selection.nodeId || selection.selectedNodeId || selection.id || null;
}

function fpFlowStatusIcon(status) {
  switch (status) {
    case 'completed':
      return 'check';
    case 'skipped':
      return 'skip';
    case 'active':
      return 'play';
    case 'ready':
      return 'play';
    case 'waiting':
      return 'pause';
    case 'blocked':
      return 'block';
    case 'revision':
      return 'rotate';
    case 'locked':
    default:
      return 'dot';
  }
}

function fpFlowRoleLabel(role) {
  if (role === 'design') return '设计';
  if (role === 'product') return '产品';
  return role || '角色';
}

function fpFlowEventLabel(kind) {
  return FP_FLOW_EVENT_LABELS[kind] || kind || '事件';
}

function fpFlowLinkKindLabel(kind) {
  const list = Array.isArray(FP_LINK_KINDS) ? FP_LINK_KINDS : [];
  const hit = list.filter((item) => item.value === kind)[0];
  return hit ? hit.label : '其他';
}

function fpFlowLinkKindIcon(kind) {
  if (kind === 'design') return 'link';
  if (kind === 'figma') return 'spark';
  if (kind === 'doc') return 'report';
  if (kind === 'chat') return 'chat';
  if (kind === 'meeting') return 'note';
  if (kind === 'dev') return 'branch';
  if (kind === 'test') return 'test';
  if (kind === 'ref') return 'book';
  return 'external';
}

/** ISO → <input type="datetime-local"> 的本地值。 */
function fpFlowToLocalInput(value) {
  const date = fpParseDate(value);
  if (!date) return '';
  const pad = (n) => (n < 10 ? '0' + n : String(n));
  return (
    date.getFullYear() +
    '-' +
    pad(date.getMonth() + 1) +
    '-' +
    pad(date.getDate()) +
    'T' +
    pad(date.getHours()) +
    ':' +
    pad(date.getMinutes())
  );
}

/** datetime-local 值 → ISO（空值 = null，交给宿主清空）。 */
function fpFlowFromLocalInput(text) {
  if (!text) return null;
  const date = new Date(text);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

function fpFlowValidUrl(value) {
  if (typeof value !== 'string' || value === '') return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch (error) {
    return false;
  }
}

/** 计划/跟进时间的展示信息（逾期/临近用颜色区分）。 */
function fpFlowDueInfo(value, now, settled) {
  const date = fpParseDate(value);
  if (!date) return null;
  const days = fpDaysLeft(value, now);
  // 已结束（完成/跳过）的节点只展示日期本身：不再提示逾期/今天/明天，也不再用错误色
  if (settled === true) {
    return { text: fpFmtDay(value, now), days: days, overdue: false, soon: false, settled: true, full: fpFmtDateTime(value, now) };
  }
  const overdue = typeof days === 'number' && days < 0;
  const soon = typeof days === 'number' && !overdue && days <= 1;
  let text = fpFmtDay(value, now);
  if (overdue) text = text + ' · 逾期 ' + Math.abs(days) + ' 天';
  else if (days === 0) text = text + ' · 今天';
  else if (days === 1) text = text + ' · 明天';
  return { text: text, days: days, overdue: overdue, soon: soon, settled: false, full: fpFmtDateTime(value, now) };
}

function fpFlowEventTime(value, now) {
  const date = fpParseDate(value);
  if (!date) return '—';
  const base = fpParseDate(now) || new Date();
  const sameDay =
    date.getFullYear() === base.getFullYear() &&
    date.getMonth() === base.getMonth() &&
    date.getDate() === base.getDate();
  if (sameDay) return fpFmtTime(date);
  return fpFmtDay(date, now) + ' ' + fpFmtTime(date);
}

/** 项目内节点按 flow 分组（保持 flow.sortOrder + node.sortOrder）。 */
function fpFlowGroupNodes(state, projectId) {
  const groups = new Map();
  const scenes = [];
  const list = fpProjectNodes(state, projectId) || [];
  list.forEach((node) => {
    if (!groups.has(node.flowId)) {
      groups.set(node.flowId, []);
      scenes.push(node.flowId);
    }
    groups.get(node.flowId).push(node);
  });
  return { groups: groups, order: scenes };
}

/** 项目进度：优先读 derived.projects，缺失时本地兜底。 */
function fpFlowSummary(derived, project, flows, groups) {
  const raw = derived && derived.projects ? derived.projects[project.id] : null;
  const all = [];
  flows.forEach((flow) => {
    const list = groups.get(flow.id) || [];
    list.forEach((node) => all.push(node));
  });
  const completed = all.filter((node) => node.status === 'completed').length;
  const skipped = all.filter((node) => node.status === 'skipped').length;
  const total = all.length;
  const actionable = all.filter((node) => FP_STATUS[node.status] && FP_STATUS[node.status].actionable).length;
  const waiting = all.filter((node) => node.status === 'waiting' || node.status === 'blocked').length;
  let progress = total > 0 ? completed / total : 0;
  if (raw && typeof raw.progress === 'number') progress = raw.progress;
  return {
    total: total,
    completed: completed,
    skipped: skipped,
    progress: Math.max(0, Math.min(1, progress)),
    currentStage: raw && raw.currentStage ? raw.currentStage : '—',
    currentCode: raw && raw.currentCode ? raw.currentCode : null,
    activeNodeId: raw && raw.activeNodeId ? raw.activeNodeId : null,
    actionable: raw && typeof raw.actionable === 'number' ? raw.actionable : actionable,
    waiting: raw && typeof raw.waiting === 'number' ? raw.waiting : waiting,
    needsAttention: !!(raw && raw.needsAttention),
  };
}

/** 依赖索引：from → to 的关系、回流边、跨流程交接边。 */
function fpFlowDepIndex(state, projectId) {
  const deps = Array.isArray(state && state.dependencies) ? state.dependencies : [];
  const nodes = fpProjectNodes(state, projectId) || [];
  const nodeMap = new Map();
  nodes.forEach((node) => nodeMap.set(node.id, node));
  const relation = new Map();
  const returns = [];
  const handoffs = [];
  deps.forEach((dep) => {
    if (!dep || !nodeMap.has(dep.fromNodeId) || !nodeMap.has(dep.toNodeId)) return;
    const from = nodeMap.get(dep.fromNodeId);
    const to = nodeMap.get(dep.toNodeId);
    if (!relation.has(from.id)) relation.set(from.id, new Map());
    relation.get(from.id).set(to.id, dep.relation || 'sequence');
    if (dep.relation === 'return') returns.push({ from: from, to: to });
    if (dep.relation === 'handoff') handoffs.push({ from: from, to: to });
  });
  return { nodeMap: nodeMap, relation: relation, returns: returns, handoffs: handoffs };
}

function fpFlowRelation(depIndex, fromId, toId) {
  if (!depIndex || !depIndex.relation) return null;
  const map = depIndex.relation.get(fromId);
  if (!map) return null;
  return map.get(toId) || null;
}

/** 当前执行焦点：active > ready > revision。 */
function fpFlowFocusNodeId(nodes) {
  const list = Array.isArray(nodes) ? nodes : [];
  const byStatus = (status) => list.filter((node) => node.status === status)[0] || null;
  const active = byStatus('active');
  if (active) return active.id;
  const ready = byStatus('ready');
  if (ready) return ready.id;
  const revision = byStatus('revision');
  if (revision) return revision.id;
  return null;
}

/* ------------------------------------------------------------------ *
 * 复用小结构（普通函数，返回 h 元素；不是组件，不参与 hook 规则）
 * ------------------------------------------------------------------ */

function fpFlowSection(title, options, ...children) {
  const opts = options || {};
  return h(
    'section',
    { className: fpFlowClass('fp-detail-sec', opts.className) },
    h(
      'div',
      { className: 'fp-detail-sec-head' },
      h('span', { className: 'fp-detail-sec-title' }, title),
      opts.hint ? h('span', { className: 'fp-detail-sec-hint' }, opts.hint) : null,
      opts.actions ? h('span', { className: 'fp-detail-sec-actions' }, opts.actions) : null,
    ),
    ...children,
  );
}

function fpFlowField(label, control, hint) {
  return h(
    'label',
    { className: 'fp-detail-field' },
    h('span', { className: 'fp-detail-field-label' }, label),
    control,
    hint ? h('span', { className: 'fp-detail-field-hint' }, hint) : null,
  );
}

function fpFlowKv(label, value, options) {
  const opts = options || {};
  return h(
    'div',
    { className: 'fp-detail-kv' },
    h('span', { className: 'fp-detail-kv-label' }, label),
    h('span', { className: fpFlowClass('fp-detail-kv-value', opts.tone), title: opts.title || undefined }, value),
  );
}

/* ------------------------------------------------------------------ *
 * FlowNodeCard —— 纵向流里的单个节点卡（契约 §7.2）
 * ------------------------------------------------------------------ */

function FlowNodeCard({ node, links, selected, now, onClick, current, returnCodes, reworkTarget }) {
  if (!node) return null;
  const status = node.status || 'locked';
  const meta = FP_STATUS[status] || FP_STATUS.locked;
  const linkList = Array.isArray(links) ? links : [];
  const linkCount = linkList.length;
  const settled = status === 'completed' || status === 'skipped';
  const due = fpFlowDueInfo(node.dueAt, now, settled);
  const follow = node.followUpAt ? fpFlowDueInfo(node.followUpAt, now, settled) : null;
  const approval = fpIsApprovalNode(node) ? node.approvals || {} : null;
  const returns = Array.isArray(returnCodes) ? returnCodes.filter(Boolean) : [];
  const className = fpFlowClass(
    'fp-node-card',
    selected && 'fp-is-selected',
    current && 'fp-is-current',
    meta.done && 'fp-is-done',
    status === 'locked' && 'fp-is-locked',
  );

  function activate() {
    if (typeof onClick === 'function') onClick();
  }

  const children = [];
  children.push(
    h(
      'div',
      { className: 'fp-node-top' },
      h('span', { className: 'fp-node-code' }, node.code || ''),
      current ? h('span', { className: 'fp-node-flag fp-node-flag--current' }, h('span', { className: 'fp-node-flag-dot' }), '当前') : null,
      node.round > 1
        ? h(
            'span',
            {
              className: 'fp-node-flag fp-node-flag--round',
              title: reworkTarget
                ? '该节点是返工目标，已经进入第 ' + node.round + ' 轮'
                : '该节点已经进入第 ' + node.round + ' 轮',
            },
            h(FpIcon, { name: 'rotate', size: 10 }),
            reworkTarget ? '第 ' + node.round + ' 轮返工' : '第 ' + node.round + ' 轮',
          )
        : null,
      returns.length > 0
        ? h(
            'span',
            { className: 'fp-node-flag fp-node-flag--return', title: '确认未通过时会退回 ' + returns.join('、') },
            h(FpIcon, { name: 'rotate', size: 10 }),
            '可退回 ' + returns.join('/'),
          )
        : null,
      h('span', { className: 'fp-spacer' }),
      h(FpStatusChip, { status: status, size: 'sm' }),
    ),
  );
  children.push(h('div', { className: 'fp-node-title' }, node.title || '未命名节点'));
  children.push(
    h(
      'div',
      { className: 'fp-node-meta' },
      node.assigneeRole
        ? h(
            'span',
            { className: 'fp-node-meta-item fp-node-role' },
            h(FpIcon, { name: 'dot', size: 8 }),
            node.assigneeRole,
          )
        : null,
      due
        ? h(
            'span',
            {
              className: fpFlowClass('fp-node-meta-item', due.overdue && 'fp-is-overdue', due.soon && 'fp-is-soon'),
              title: '计划完成：' + due.full,
            },
            h(FpIcon, { name: 'calendar', size: 11 }),
            due.text,
          )
        : null,
      follow
        ? h(
            'span',
            { className: fpFlowClass('fp-node-meta-item', 'fp-is-follow'), title: '跟进时间：' + follow.full },
            h(FpIcon, { name: 'clock', size: 11 }),
            follow.text,
          )
        : null,
      node.plannedAt
        ? h(
            'span',
            { className: 'fp-node-meta-item fp-node-planned', title: '计划开始：' + String(node.plannedAt) },
            h(FpIcon, { name: 'flag', size: 11 }),
            fpFmtDay(node.plannedAt, now),
          )
        : null,
      h(
        'span',
        { className: fpFlowClass('fp-node-meta-item', 'fp-node-links', linkCount === 0 && 'fp-is-empty'), title: '关联链接 ' + linkCount + ' 条' },
        h(FpIcon, { name: 'link', size: 11 }),
        String(linkCount),
      ),
    ),
  );
  if (approval) {
    children.push(
      h(
        'div',
        { className: 'fp-node-approval' },
        h('span', { className: 'fp-node-approval-label' }, '双确认'),
        ['design', 'product'].map((role) =>
          h(
            'span',
            {
              key: role,
              className: fpFlowClass('fp-node-approval-item', approval[role] === true && 'fp-is-on'),
              title: fpFlowRoleLabel(role) + (approval[role] === true ? '：已通过' : '：待确认'),
            },
            h('span', { className: 'fp-node-approval-dot' }),
            fpFlowRoleLabel(role),
          ),
        ),
      ),
    );
  }

  return h(
    'div',
    {
      className: className,
      'data-node-id': node.id,
      role: 'button',
      tabIndex: 0,
      'aria-current': current ? 'step' : undefined,
      'aria-pressed': selected ? 'true' : 'false',
      'aria-label': (node.code ? node.code + ' ' : '') + (node.title || '节点') + '，' + meta.label,
      onClick: activate,
      onKeyDown: (event) => {
        if (event.key === 'Enter' || event.key === ' ' || event.key === 'Spacebar') {
          event.preventDefault();
          activate();
        }
      },
    },
    ...children,
  );
}

/* ------------------------------------------------------------------ *
 * FlowView —— 中央项目头 + 多流程分段纵向节点流（契约 §7.2）
 * ------------------------------------------------------------------ */

function FlowView({ state, derived, project, selection, onSelectNode, onSelectProjectInfo, onEditProject, onCollapseDetail, onCreateProject, onAddFlow }) {
  const now = useNow(30000);
  const selectedNodeId = fpFlowSelectionNodeId(selection);
  const [appendOpen, setAppendOpen] = useState(false);
  const [appendFlowId, setAppendFlowId] = useState('');
  const [appendTemplateId, setAppendTemplateId] = useState('experiment');
  const [appendStart, setAppendStart] = useState('');
  const [appendBusy, setAppendBusy] = useState(false);
  const [appendError, setAppendError] = useState('');
  const [fabOpen, setFabOpen] = useState(false);

  useEffect(function () {
    if (!fabOpen) return undefined;
    function onKeyDown(event) {
      if (event && event.key === 'Escape') setFabOpen(false);
    }
    if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
      document.addEventListener('keydown', onKeyDown);
      return function () { document.removeEventListener('keydown', onKeyDown); };
    }
    return undefined;
  }, [fabOpen]);

  const nodePackTemplates = typeof FP_NODE_PACK_TEMPLATES === 'undefined' ? [] : FP_NODE_PACK_TEMPLATES;

  function openAppendTemplate() {
    if (archived) return;
    const first = flows.length > 0 ? flows[0] : null;
    setAppendFlowId(first !== null && typeof first.id === 'string' ? first.id : '');
    setAppendTemplateId(nodePackTemplates.length > 0 ? nodePackTemplates[0].id : '');
    setAppendStart(fpDateOnly(new Date()));
    setAppendError('');
    setAppendOpen(true);
  }

  function submitAppendTemplate() {
    if (appendBusy) return;
    const template = fpNodePackTemplate(appendTemplateId);
    if (template === null) {
      setAppendError('请选择要追加的节点模板');
      return;
    }
    if (appendFlowId === '') {
      setAppendError('请选择要追加到的流程');
      return;
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(appendStart)) {
      setAppendError('请选择开始日期');
      return;
    }
    setAppendBusy(true);
    setAppendError('');
    const startAt = new Date(appendStart + 'T10:00:00');
    fpDispatch('appendTemplate', {
      flowId: appendFlowId,
      templateId: template.id,
      startAt: startAt.toISOString(),
    })
      .then(function (result) {
        setAppendBusy(false);
        if (!result || result.ok !== true) {
          setAppendError((result && result.error) || '追加模板失败');
          return;
        }
        setAppendOpen(false);
        try {
          FpToast.push({ tone: 'success', text: '已追加「' + template.title + '」' + template.nodes.length + ' 个节点' });
        } catch (error) {
          /* ignore */
        }
      })
      .catch(function (cause) {
        setAppendBusy(false);
        setAppendError(cause && cause.message ? cause.message : '追加模板失败');
      });
  }

  /* 流程看板右下角：圆形「+」按钮，展开选择「追加节点模板 / 添加验收流程」 */
  function renderFlowFab() {
    if (archived) return null;
    const items = [
      {
        key: 'append',
        label: '追加节点模板',
        disabled: flows.length === 0,
        hint: flows.length === 0 ? '先创建一个流程，再追加节点模板' : '把一套节点模板追加到已有流程',
        run: openAppendTemplate,
      },
      {
        key: 'acceptance',
        label: '添加验收流程',
        disabled: hasAcceptance,
        hint: hasAcceptance ? '项目已包含验收流程' : '为项目添加验收流程',
        run: requestAddFlow,
      },
    ];
    const children = [];
    if (fabOpen) {
      children.push(
        h('div', { key: 'backdrop', className: 'fp-flow-fab-backdrop', onClick: function () { setFabOpen(false); } }),
      );
      children.push(
        h(
          'div',
          { key: 'menu', className: 'fp-flow-fab-menu', role: 'menu' },
          items.map(function (item) {
            return h(
              'button',
              {
                key: item.key,
                type: 'button',
                className: 'fp-flow-fab-item',
                role: 'menuitem',
                disabled: item.disabled,
                title: item.hint,
                onClick: function () {
                  setFabOpen(false);
                  item.run();
                },
              },
              h(FpIcon, { name: 'plus', size: 13 }),
              h('span', {}, item.label),
            );
          }),
        ),
      );
    }
    children.push(
      h(
        'button',
        {
          key: 'fab',
          type: 'button',
          className: 'fp-flow-fab',
          /* 内联样式优先级高于任何选择器（除非宿主 !important）；正圆画在内层 disc 上 */
          style: { width: '40px', height: '40px', aspectRatio: '1 / 1', padding: '0', border: '0', background: 'transparent', borderRadius: '999px' },
          'aria-label': '添加节点或流程',
          'aria-haspopup': 'menu',
          'aria-expanded': fabOpen ? 'true' : 'false',
          'data-open': fabOpen ? 'true' : 'false',
          onClick: function () { setFabOpen(!fabOpen); },
        },
        h(
          'span',
          {
            className: 'fp-flow-fab-disc',
            style: { borderRadius: '999px', clipPath: 'circle(50% at 50% 50%)' },
          },
          h(FpIcon, { name: 'plus', size: 20 }),
        ),
      ),
    );
    return h('div', { className: 'fp-flow-fab-wrap' }, children);
  }

  function renderAppendDialog() {
    if (!appendOpen) return null;
    const template = fpNodePackTemplate(appendTemplateId);
    const preview = template === null ? [] : template.nodes.map(function (item, index) {
      const day = new Date(new Date(appendStart + 'T10:00:00').getTime() + item.offsetDays * 24 * 3600 * 1000);
      const iso = Number.isNaN(day.getTime()) ? null : day.toISOString();
      return h(
        'div',
        { key: 'p-' + index, className: 'fp-append-row' },
        h('span', { className: 'fp-append-code' }, 'E' + String(index + 1).padStart(2, '0')),
        h('span', { className: 'fp-append-title' }, item.title),
        h('span', { className: 'fp-append-meta' }, item.assigneeRole || ''),
        h('span', { className: 'fp-append-day' }, iso !== null ? fpFmtDay(iso, new Date()) : '—'),
      );
    });
    return h(
      FpDialog,
      {
        open: true,
        title: '追加节点模板',
        description: '把一套节点追加到已有流程末尾（不改动已有节点，编号自动接续）',
        onClose: function () { setAppendOpen(false); },
        actions: [
          h(FpButton, { key: 'cancel', variant: 'ghost', disabled: appendBusy, onClick: function () { setAppendOpen(false); } }, '取消'),
          h(FpButton, { key: 'submit', variant: 'primary', icon: 'plus', disabled: appendBusy, onClick: submitAppendTemplate },
            appendBusy ? '追加中…' : '追加'),
        ],
      },
      h('div', { className: 'fp-append-form' },
        fpFlowField('追加到流程', h(FpSelect, {
          value: appendFlowId,
          options: flows.map(function (flow) {
            const meta = FP_TEMPLATE_META[flow.templateId] || {};
            return { value: flow.id, label: flow.name || meta.title || '流程' };
          }),
          width: '100%',
          onChange: function (value) { setAppendFlowId(value); },
        })),
        fpFlowField('节点模板', h(FpSelect, {
          value: appendTemplateId,
          options: nodePackTemplates.map(function (item) { return { value: item.id, label: item.title }; }),
          width: '100%',
          onChange: function (value) { setAppendTemplateId(value); },
        }), template !== null ? template.hint : null),
        fpFlowField('开始日期', h('input', {
          type: 'date',
          className: 'fp-dt-input',
          value: appendStart,
          onChange: function (event) { setAppendStart(event.target.value); },
        }), '各阶段计划时间 = 开始日期 + 偏移天数（可在节点详情里单独调整）'),
        h('div', { className: 'fp-append-preview' }, preview),
        appendError !== '' ? h('p', { className: 'fp-append-error', role: 'alert' }, appendError) : null,
      ),
    );
  }

  if (!state) {
    return h('div', { className: 'fp-flow fp-flow--empty' }, h(FpSpinner, { label: '正在载入流程…' }));
  }

  if (!project) {
    return h(
      'div',
      { className: 'fp-flow fp-flow--empty' },
      h(
        'div',
        { className: 'fp-flow-empty' },
        h('div', { className: 'fp-flow-empty-icon' }, h(FpIcon, { name: 'flow', size: 24 })),
        h('div', { className: 'fp-flow-empty-title' }, '选择一个项目开始'),
        h('div', { className: 'fp-flow-empty-desc' }, '先新建项目，模板会展开节点。'),
        h(
          'div',
          { className: 'fp-flow-empty-actions' },
          h(FpButton, { variant: 'primary', icon: 'plus', onClick: () => onCreateProject && onCreateProject() }, '新建项目'),
        ),
      ),
    );
  }

  const flows = fpProjectFlows(state, project.id) || [];
  const grouped = fpFlowGroupNodes(state, project.id);
  const nodesByFlow = grouped.groups;
  const depIndex = fpFlowDepIndex(state, project.id);
  const summary = fpFlowSummary(derived, project, flows, nodesByFlow);
  const archived = project.status === 'archived';
  const hasAcceptance = flows.some((flow) => flow.templateId === 'acceptance');
  const focusNodeId = fpFlowFocusNodeId(fpProjectNodes(state, project.id) || []);
  const line = (state.businessLines || []).filter((item) => item.id === project.businessLineId)[0] || null;
  const lineName = line ? line.name : '未分组';
  const dueInfo = project.dueAt ? fpFlowDueInfo(project.dueAt, now) : null;
  // 头部「截止」优先显示当前聚焦节点的计划完成时间，项目截止放到项目信息面板里
  const focusNode = (fpProjectNodes(state, project.id) || []).filter((node) => node.id === focusNodeId)[0] || null;
  const focusDueInfo = focusNode && focusNode.dueAt ? fpFlowDueInfo(focusNode.dueAt, now) : null;
  const headerDueInfo = focusDueInfo || dueInfo;
  const headerDueLabel = focusDueInfo ? '节点截止 ' : dueInfo ? '项目截止 ' : '';
  const percent = Math.round(summary.progress * 100);
  const returnSources = new Map();
  const returnTargets = new Set();
  depIndex.returns.forEach((edge) => {
    if (!returnSources.has(edge.from.id)) returnSources.set(edge.from.id, []);
    returnSources.get(edge.from.id).push(edge.to.code || '');
    returnTargets.add(edge.to.id);
  });

  const requestAddFlow = () => {
    if (archived) return;
    if (typeof onAddFlow === 'function') onAddFlow(project.id);
  };

  const blocks = [];
  flows.forEach((flow, flowIndex) => {
    const meta = FP_TEMPLATE_META[flow.templateId] || {};
    const flowNodes = nodesByFlow.get(flow.id) || [];
    const flowCompleted = flowNodes.filter((node) => node.status === 'completed').length;
    const flowPercent = flowNodes.length > 0 ? Math.round((flowCompleted / flowNodes.length) * 100) : 0;

    const header = h(
      'div',
      { className: 'fp-flow-seg-head' },
      h('span', { className: 'fp-flow-seg-dot' }),
      h('span', { className: 'fp-flow-seg-name' }, flow.name || meta.title || '流程'),
      meta.short ? h('span', { className: 'fp-flow-seg-sub' }, meta.short) : null,
      h('span', { className: 'fp-spacer' }),
      h('span', { className: 'fp-flow-seg-count' }, flowCompleted + ' / ' + flowNodes.length),
      h('span', { className: 'fp-flow-seg-bar' }, h('span', { style: { width: flowPercent + '%' } })),
    );

    const trackChildren = [];
    if (flowNodes.length === 0) {
      trackChildren.push(
        h(
          'div',
          { className: 'fp-flow-item', key: 'empty-' + flow.id },
          h('div', { className: 'fp-flow-rail' }, h('span', { className: 'fp-flow-marker fp-flow-marker--locked' }, h(FpIcon, { name: 'dot', size: 11 }))),
          h('div', { className: 'fp-flow-placeholder' }, '这个流程还没有节点'),
        ),
      );
    }

    flowNodes.forEach((node, nodeIndex) => {
      const next = nodeIndex < flowNodes.length - 1 ? flowNodes[nodeIndex + 1] : null;
      const isLast = !next;
      const hasBridge = isLast && flowIndex < flows.length - 1;
      const relationToNext = next ? fpFlowRelation(depIndex, node.id, next.id) : null;
      const returnEdge = next ? fpFlowRelation(depIndex, next.id, node.id) === 'return' : false;
      const showLine = !!next || hasBridge;
      const lineClass = fpFlowClass(
        'fp-flow-line',
        (hasBridge || relationToNext === 'handoff') && 'fp-is-dashed',
      );
      const current = node.id === focusNodeId;
      const selected = node.id === selectedNodeId;

      trackChildren.push(
        h(
          'div',
          { className: 'fp-flow-item', key: node.id },
          h(
            'div',
            { className: 'fp-flow-rail' },
            h(
              'span',
              { className: fpFlowClass('fp-flow-marker', 'fp-flow-marker--' + node.status, current && 'fp-is-current') },
              h(FpIcon, { name: fpFlowStatusIcon(node.status), size: 12 }),
            ),
            showLine ? h('span', { className: lineClass, 'aria-hidden': 'true' }) : null,
            returnEdge
              ? h('span', {
                  className: 'fp-flow-return-line',
                  title: '回流：' + (next.code || '') + ' → ' + (node.code || ''),
                  'aria-hidden': 'true',
                })
              : null,
          ),
          h(FlowNodeCard, {
            node: node,
            links: fpNodeLinks(state, node.id),
            selected: selected,
            now: now,
            current: current,
            returnCodes: returnSources.get(node.id) || null,
            reworkTarget: returnTargets.has(node.id),
            onClick: () => {
              if (typeof onSelectNode === 'function') onSelectNode(node.id);
            },
          }),
        ),
      );
    });

    blocks.push(
      h(
        'section',
        {
          key: 'flow-' + flow.id,
          className: 'fp-flow-seg',
          style: { '--fp-seg-accent': flow.templateId === 'acceptance' ? 'var(--fp-accent)' : 'var(--fp-brand)' },
        },
        header,
        h('div', { className: 'fp-flow-track' }, ...trackChildren),
      ),
    );

    if (flowIndex < flows.length - 1) {
      const nextFlow = flows[flowIndex + 1];
      const crossings = depIndex.handoffs.filter(
        (edge) => edge.from.flowId === flow.id && edge.to.flowId === nextFlow.id,
      );
      const tags = crossings.map((edge) => (edge.from.code || '') + ' → ' + (edge.to.code || '')).join('，');
      blocks.push(
        h(
          'div',
          { className: 'fp-flow-bridge', key: 'bridge-' + flow.id },
          h(
            'div',
            { className: 'fp-flow-bridge-rail' },
            h('span', { className: 'fp-flow-bridge-line', 'aria-hidden': 'true' }),
            h('span', { className: 'fp-flow-bridge-node' }, h(FpIcon, { name: 'arrow-down', size: 11 })),
          ),
          h(
            'div',
            { className: 'fp-flow-bridge-body' },
            h(
              'span',
              { className: 'fp-flow-bridge-tag' },
              h(FpIcon, { name: 'handoff', size: 12 }),
              tags ? '交接 ' + tags : '流程衔接',
            ),
            h(
              'span',
              { className: 'fp-flow-bridge-desc' },
              tags ? '上一流程完成后自动解锁下一流程首节点' : '两个流程依次推进',
            ),
          ),
        ),
      );
    }
  });

  if (flows.length === 0) {
    blocks.push(
      h(
        'div',
        { className: 'fp-flow-item', key: 'no-flow' },
        h('div', { className: 'fp-flow-rail' }, h('span', { className: 'fp-flow-marker fp-flow-marker--locked' }, h(FpIcon, { name: 'flow', size: 12 }))),
        h(
          'div',
          { className: 'fp-flow-placeholder fp-flow-placeholder--lg' },
          h('div', { className: 'fp-flow-placeholder-title' }, '项目还没有流程'),
          archived
            ? null
            : h(FpButton, { size: 'sm', variant: 'primary', icon: 'plus', onClick: requestAddFlow }, '添加验收流程'),
        ),
      ),
    );
  }

  return h(
    'div',
    { className: 'fp-flow' },
    h(
      'header',
      { className: 'fp-flow-head' },
      summary.total > 0 && summary.completed === summary.total
        ? h(
            'span',
            { className: 'fp-flow-stamp', 'aria-hidden': 'true' },
            h(
              'svg',
              { viewBox: '0 0 120 120', fill: 'none', stroke: 'currentColor' },
              // 外圈粗环 + 内圈细环（虚线做旧一点点，接近真实印章的断墨感）
              h('circle', { cx: 60, cy: 60, r: 54, strokeWidth: 3 }),
              h('circle', { cx: 60, cy: 60, r: 45, strokeWidth: 1.1, strokeOpacity: 0.8, strokeDasharray: '7 3' }),
              // 小星：沿用参考盖章的分布（上 3 下 2）
              ['M60 9l2.1 5.2 5.4.5-4.1 3.7 1.3 5.4-4.7-3-4.7 3 1.3-5.4-4.1-3.7 5.4-.5z',
               'M24 24l1.8 4.4 4.6.4-3.5 3.2 1.1 4.6-4-2.6-4 2.6 1.1-4.6-3.5-3.2 4.6-.4z',
               'M96 24l1.8 4.4 4.6.4-3.5 3.2 1.1 4.6-4-2.6-4 2.6 1.1-4.6-3.5-3.2 4.6-.4z',
               'M36 88l1.8 4.4 4.6.4-3.5 3.2 1.1 4.6-4-2.6-4 2.6 1.1-4.6-3.5-3.2 4.6-.4z',
               'M84 88l1.8 4.4 4.6.4-3.5 3.2 1.1 4.6-4-2.6-4 2.6 1.1-4.6-3.5-3.2 4.6-.4z'].map((d, index) =>
                h('path', { key: 'star-' + index, d: d, fill: 'currentColor', stroke: 'none' }),
              ),
              // 中心的「已完成」字样（整枚印章在 CSS 里统一倾斜）
              h(
                'text',
                {
                  x: 60,
                  y: 60,
                  'text-anchor': 'middle',
                  'dominant-baseline': 'central',
                  fill: 'currentColor',
                  stroke: 'none',
                  fontSize: 28,
                  fontWeight: 900,
                  letterSpacing: 1,
                  fontFamily: '"PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif',
                },
                '已完成',
              ),
            ),
          )
        : null,
      h(
        'div',
        { className: 'fp-flow-head-main' },
        h(
          'div',
          { className: 'fp-flow-head-copy' },
          h(
            'div',
            { className: 'fp-flow-eyebrow' },
            h('span', { className: 'fp-flow-eyebrow-dot' }),
            h('span', { className: 'fp-flow-eyebrow-line' }, lineName),
            h('span', { className: 'fp-flow-eyebrow-sep' }, '/'),
            h('span', { className: 'fp-flow-eyebrow-mode' }, archived ? '已归档项目' : '流程驾驶舱'),
          ),
          h(
            'h1',
            {
              className: 'fp-flow-title fp-flow-title--link',
              role: 'button',
              tabIndex: 0,
              title: '查看项目信息',
              onClick: function () {
                if (typeof onSelectProjectInfo === 'function') onSelectProjectInfo();
              },
              onKeyDown: function (event) {
                if (event && (event.key === 'Enter' || event.key === ' ')) {
                  if (typeof event.preventDefault === 'function') event.preventDefault();
                  if (typeof onSelectProjectInfo === 'function') onSelectProjectInfo();
                }
              },
            },
            project.title || '未命名项目',
          ),
          h(
            'div',
            { className: 'fp-flow-sub' },
            h(
              'span',
              {
                className: fpFlowClass('fp-flow-sub-item', headerDueInfo && headerDueInfo.overdue && 'fp-is-overdue'),
                title: focusDueInfo
                  ? '当前节点计划完成：' + focusDueInfo.full + '（项目截止：' + (dueInfo ? dueInfo.full : '未设置') + '）'
                  : dueInfo ? '项目截止：' + dueInfo.full : '未设置截止时间',
              },
              h(FpIcon, { name: 'calendar', size: 12 }),
              headerDueInfo ? headerDueLabel + headerDueInfo.text : '未设截止',
            ),
            h(
              'span',
              { className: 'fp-flow-sub-item', title: '当前阶段' },
              h(FpIcon, { name: 'flag', size: 12 }),
              summary.currentCode ? summary.currentCode + ' · ' + summary.currentStage : summary.currentStage,
            ),
            h(
              'span',
              { className: 'fp-flow-sub-item', title: '项目研发负责人（右键项目可修改）' },
              h(FpIcon, { name: 'user', size: 12 }),
              project.devOwner ? '研发 ' + project.devOwner : '研发未指派',
            ),
            summary.actionable > 0 ? h(FpChip, { tone: 'brand', dot: true }, '可推进 ' + summary.actionable) : null,
            summary.waiting > 0 ? h(FpChip, { tone: 'warn', dot: true }, '等待 ' + summary.waiting) : null,
            summary.needsAttention ? h(FpChip, { tone: 'error', dot: true }, '需关注') : null,
          ),
        ),
        h(
          'div',
          { className: 'fp-flow-head-actions' },
          archived ? h(FpChip, { tone: 'warn', dot: true }, '已归档 · 只读') : null,
        ),
      ),
      h(
        'div',
        { className: 'fp-flow-progress' },
        h('span', { className: 'fp-flow-progress-label' }, '流程进度'),
        h(
          'div',
          { className: 'fp-flow-progress-track' },
          h('div', { className: 'fp-flow-progress-fill', style: { width: percent + '%' } }),
        ),
        h('span', { className: 'fp-flow-progress-num' }, summary.completed + ' / ' + summary.total),
        h('span', { className: 'fp-flow-progress-pct' }, percent + '%'),
      ),
      archived
        ? h(
            'div',
            { className: 'fp-flow-banner' },
            h(FpIcon, { name: 'archive', size: 13 }),
            '项目已归档：节点详情只读，恢复归档后才能继续推进。',
          )
        : null,
    ),
    h('div', { className: 'fp-flow-canvas' }, h('div', { className: 'fp-flow-inner' }, ...blocks)),
    renderFlowFab(),
    renderAppendDialog(),
  );
}

/* ------------------------------------------------------------------ *
 * NodeDetail —— 右侧 344px 节点详情（契约 §7.2）
 * ------------------------------------------------------------------ */

/* 右侧「项目信息」面板：点项目标题打开；字段直接在面板里编辑 + 保存 */
function fpProjectDraftOf(project) {
  return {
    title: project && typeof project.title === 'string' ? project.title : '',
    due: project && project.dueAt ? fpFlowToLocalInput(project.dueAt) : '',
    devOwner: project && typeof project.devOwner === 'string' ? project.devOwner : '',
    productOwner: project && typeof project.productOwner === 'string' ? project.productOwner : '',
    prdUrl: project && typeof project.prdUrl === 'string' ? project.prdUrl : '',
    summary: project && typeof project.summary === 'string' ? project.summary : '',
  };
}

function ProjectDetail({ state, derived, project, onClose }) {
  const now = useNow(30000);
  const [editing, setEditing] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState('');
  const [draft, setDraft] = React.useState(function () { return fpProjectDraftOf(project); });
  const projectId = project && project.id ? project.id : '';

  React.useEffect(function () {
    setEditing(false);
    setError('');
    setDraft(fpProjectDraftOf(project));
    /* 切换项目时重置草稿 */
  }, [projectId]);

  if (!project) return null;

  const safeState = state || {};
  const flows = fpProjectFlows(safeState, project.id) || [];
  const grouped = fpFlowGroupNodes(safeState, project.id);
  const summary = fpFlowSummary(derived, project, flows, grouped.groups);
  const line = (safeState.businessLines || []).filter((item) => item.id === project.businessLineId)[0] || null;
  const due = project.dueAt ? fpFlowDueInfo(project.dueAt, now) : null;
  const allNodes = fpProjectNodes(safeState, project.id) || [];
  const focusId = fpFlowFocusNodeId(allNodes);
  const focusNode = allNodes.filter((node) => node.id === focusId)[0] || null;
  const archived = project.status === 'archived';
  const percent = Math.round(summary.progress * 100);

  function beginEdit() {
    setDraft(fpProjectDraftOf(project));
    setError('');
    setEditing(true);
  }

  function cancelEdit() {
    setDraft(fpProjectDraftOf(project));
    setError('');
    setEditing(false);
  }

  function updateDraft(field, value) {
    setDraft(function (prev) {
      const next = Object.assign({}, prev);
      next[field] = value;
      return next;
    });
  }

  function save() {
    if (busy) return;
    const title = draft.title.trim();
    if (title === '') {
      setError('项目名称不能为空');
      return;
    }
    setBusy(true);
    setError('');
    fpDispatch('updateProject', {
      projectId: project.id,
      title: title,
      dueAt: fpFlowFromLocalInput(draft.due),
      devOwner: draft.devOwner.trim(),
      productOwner: draft.productOwner.trim(),
      prdUrl: draft.prdUrl.trim(),
      summary: draft.summary.trim(),
    })
      .catch(function (err) { return { ok: false, error: (err && err.message) || '保存失败' }; })
      .then(function (result) {
        setBusy(false);
        if (!result || result.ok !== true) {
          setError((result && result.error) || '保存失败');
          return;
        }
        setEditing(false);
        fpFlowToast('项目信息已保存', 'success');
      });
  }

  function row(label, value, extraClass) {
    return h(
      'div',
      { className: 'fp-detail-kv' },
      h('span', { className: 'fp-detail-kv-label' }, label),
      h('span', { className: 'fp-detail-kv-value' + (extraClass ? ' ' + extraClass : '') }, value),
    );
  }

  const infoBody = editing
    ? h(
        'div',
        { className: 'fp-project-edit' },
        fpFlowField('项目名称', h(FpInput, { value: draft.title, autoFocus: true, placeholder: '例如：小店助推', onChange: function (value) { updateDraft('title', value); } })),
        fpFlowField('交付日期', h('input', {
          type: 'datetime-local',
          className: 'fp-input fp-dt-input',
          value: draft.due,
          onChange: function (event) { updateDraft('due', event && event.target ? event.target.value : ''); },
        })),
        fpFlowField('研发负责人', h(FpInput, { value: draft.devOwner, placeholder: '例如：张伟', onChange: function (value) { updateDraft('devOwner', value); } })),
        fpFlowField('产品负责人', h(FpInput, { value: draft.productOwner, placeholder: '例如：李娜', onChange: function (value) { updateDraft('productOwner', value); } })),
        fpFlowField('PRD 链接', h(FpInput, { value: draft.prdUrl, type: 'url', placeholder: 'https://…', onChange: function (value) { updateDraft('prdUrl', value); } })),
        fpFlowField('需求背景', h(FpTextarea, { value: draft.summary, rows: 3, placeholder: '一句话说明这条 PRD 要做什么…', onChange: function (value) { updateDraft('summary', value); } })),
        error !== '' ? h('p', { className: 'fp-detail-form-error' }, error) : null,
      )
    : h(
        'div',
        { className: 'fp-detail-kv-list' },
        row('业务线', line ? line.name : '未分组'),
        row('交付日期', due ? due.full + (due.overdue ? '（逾期）' : '') : '未设置', due && due.overdue ? 'fp-is-overdue' : ''),
        row('研发', project.devOwner ? project.devOwner : '未指派'),
        row('产品', project.productOwner ? project.productOwner : '未指派'),
        row(
          'PRD',
          project.prdUrl
            ? h(
                'a',
                { className: 'fp-detail-link-title', href: project.prdUrl, target: '_blank', rel: 'noopener noreferrer', title: project.prdUrl },
                project.prdUrl,
              )
            : '未关联',
        ),
        row('需求背景', trimTextSafe(project.summary) !== '' ? project.summary : '（待补充）'),
      );

  const infoActions = editing
    ? h(
        'div',
        { className: 'fp-project-edit-actions' },
        h(FpButton, { size: 'sm', variant: 'ghost', disabled: busy, onClick: cancelEdit }, '取消'),
        h(FpButton, { size: 'sm', variant: 'primary', disabled: busy, onClick: save }, busy ? '保存中…' : '保存'),
      )
    : archived
      ? null
      : h(FpButton, { size: 'sm', variant: 'ghost', icon: 'edit', onClick: beginEdit }, '编辑');

  return h(
    'aside',
    { className: 'fp-detail fp-project-detail', 'aria-label': '项目信息' },
    h(
      'header',
      { className: 'fp-detail-head' },
      h(
        'div',
        { className: 'fp-detail-top' },
        h('span', { className: 'fp-detail-code' }, '项目信息'),
        h('span', { className: 'fp-spacer' }),
        archived ? h(FpChip, { tone: 'warn', dot: true }, '已归档') : null,
        typeof onClose === 'function'
          ? h(FpIconButton, { label: '关闭项目信息', title: '关闭项目信息', size: 26, onClick: onClose }, h(FpIcon, { name: 'x', size: 14 }))
          : null,
      ),
      h('h2', { className: 'fp-detail-title' }, project.title || '未命名项目'),
      h(
        'div',
        { className: 'fp-detail-sub' },
        h('span', { className: 'fp-detail-sub-item' }, h(FpIcon, { name: 'flow', size: 11 }), line ? line.name : '未分组'),
        h(
          'span',
          { className: 'fp-detail-sub-item' },
          h(FpIcon, { name: 'flag', size: 11 }),
          summary.currentCode ? summary.currentCode + ' · ' + summary.currentStage : summary.currentStage,
        ),
      ),
    ),
    h(
      'div',
      { className: 'fp-detail-scroll' },
      fpFlowSection('项目信息', { actions: infoActions }, infoBody),
      fpFlowSection(
        '进度',
        {},
        h(
          'div',
          { className: 'fp-detail-kv-list' },
          row('节点', summary.completed + ' / ' + summary.total + '（' + percent + '%）'),
          row('当前节点', focusNode ? (focusNode.code ? focusNode.code + ' ' : '') + (focusNode.title || '') : '全部完成'),
          row(
            '当前节点截止',
            focusNode && focusNode.dueAt
              ? fpFlowDueInfo(focusNode.dueAt, now).full + (fpFlowDueInfo(focusNode.dueAt, now).overdue ? '（逾期）' : '')
              : '未设置',
          ),
        ),
      ),
    ),
  );
}

/* 小工具：安全 trim（项目摘要可能为 undefined / 非字符串） */
function trimTextSafe(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function NodeDetail({ state, derived, project, node, onClose }) {
  const now = useNow(30000);
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);
  const [actionMode, setActionMode] = useState(null);
  const [note, setNote] = useState('');
  const [reason, setReason] = useState('');
  const [waitAt, setWaitAt] = useState('');
  const [scheduleEditing, setScheduleEditing] = useState(false);
  const [dueDraft, setDueDraft] = useState('');
  const [plannedDraft, setPlannedDraft] = useState('');
  const [followDraft, setFollowDraft] = useState('');
  const [linkForm, setLinkForm] = useState(false);
  const [linkTitle, setLinkTitle] = useState('');
  const [linkUrl, setLinkUrl] = useState('');
  const [linkKind, setLinkKind] = useState('design');
  const [linkError, setLinkError] = useState(null);
  const [rejectRole, setRejectRole] = useState(null);
  const [rejectComment, setRejectComment] = useState('');
  const [notesDraft, setNotesDraft] = useState(node && node.notes ? node.notes : '');
  const [notesState, setNotesState] = useState('idle');
  const savedNotesRef = useRef(node && node.notes ? node.notes : '');
  const busyRef = useRef(false);
  const nodeId = node ? node.id : null;

  useEffect(() => {
    setActionMode(null);
    setError(null);
    setNote('');
    setReason('');
    setWaitAt('');
    setScheduleEditing(false);
    setLinkForm(false);
    setLinkError(null);
    setRejectRole(null);
    setRejectComment('');
    const nextNotes = node && node.notes ? node.notes : '';
    setNotesDraft(nextNotes);
    savedNotesRef.current = nextNotes;
    setNotesState('idle');
    /* 只依赖 node.id：轮询回来的同 id 新对象不应重置正在编辑的草稿 */
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodeId]);

  if (!node) {
    return h(
      'aside',
      { className: 'fp-detail fp-detail--empty', 'aria-label': '节点详情' },
      h('div', { className: 'fp-detail-empty' }, h(FpIcon, { name: 'flow', size: 20 }), '选择一个节点查看详情'),
    );
  }

  const safeState = state || { nodes: [], links: [], events: [], flows: [] };
  const status = node.status || 'locked';
  const meta = FP_STATUS[status] || FP_STATUS.locked;
  const links = fpNodeLinks(safeState, node.id);
  const approvalNode = fpIsApprovalNode(node);
  const approvals = node.approvals || {};
  const settingsOfState = safeState && safeState.settings ? safeState.settings : {};
  const evidencePolicy = fpEvidencePolicy(node, project, settingsOfState);
  const gate = fpCanComplete(node, links, approvals, evidencePolicy);
  const archived = !!(project && project.status === 'archived');
  const flowOfNode = (safeState && Array.isArray(safeState.flows) ? safeState.flows : [])
    .filter((flow) => flow && flow.id === node.flowId)[0] || null;
  const isAcceptanceNode = !!(flowOfNode && flowOfNode.templateId === 'acceptance');
  const darkModeChecked = node.darkMode === true;
  const finished = status === 'completed' || status === 'skipped';
  const locked = status === 'locked';
  const flow = (safeState.flows || []).filter((item) => item.id === node.flowId)[0] || null;
  const flowName = flow ? flow.name : '';
  const projectTitle = project ? project.title : fpProjectById(safeState, node.projectId) ? fpProjectById(safeState, node.projectId).title : '项目';
  const events = fpEventsFor(safeState, { nodeId: node.id, limit: 20 });
  const canAct = !archived && !locked && !finished && !busy;
  const completeDisabled = !canAct || !gate.ok;

  function perform(action, payload, successText) {
    if (busyRef.current) return Promise.resolve(false);
    busyRef.current = true;
    setBusy(action);
    setError(null);
    return fpDispatch(action, payload)
      .catch((err) => ({ ok: false, error: (err && err.message) || '操作失败', code: 'NETWORK' }))
      .then((result) => {
        busyRef.current = false;
        setBusy(null);
        if (!result || !result.ok) {
          setError({ text: (result && result.error) || '操作失败', code: (result && result.code) || null });
          return false;
        }
        if (successText) fpFlowToast(successText, 'success');
        return true;
      });
  }

  function startNode() {
    perform('startNode', { nodeId: node.id }, '节点已开始').then((ok) => {
      if (ok) setActionMode(null);
    });
  }

  function completeNode() {
    if (!gate.ok) {
      setError({ text: gate.error, code: gate.code || null });
      return;
    }
    perform('completeNode', { nodeId: node.id, note: note.trim() }, '节点已完成').then((ok) => {
      if (ok) setNote('');
    });
  }

  function submitActionForm() {
    if (!actionMode) return;
    if (actionMode === 'wait') {
      perform('waitNode', { nodeId: node.id, followUpAt: fpFlowFromLocalInput(waitAt), note: note.trim() }, '节点已进入等待').then((ok) => {
        if (ok) {
          setActionMode(null);
          setNote('');
          setWaitAt('');
        }
      });
      return;
    }
    if (actionMode === 'block') {
      if (!reason.trim()) return;
      perform('blockNode', { nodeId: node.id, reason: reason.trim(), followUpAt: fpFlowFromLocalInput(waitAt) }, '节点已标记阻塞').then((ok) => {
        if (ok) {
          setActionMode(null);
          setReason('');
          setWaitAt('');
        }
      });
      return;
    }
    if (actionMode === 'skip') {
      if (!reason.trim()) return;
      perform('skipNode', { nodeId: node.id, reason: reason.trim() }, '节点已跳过').then((ok) => {
        if (ok) {
          setActionMode(null);
          setReason('');
        }
      });
      return;
    }
    if (actionMode === 'reopen') {
      if (!reason.trim()) return;
      perform('reopenNode', { nodeId: node.id, reason: reason.trim() }, '节点已重新打开').then((ok) => {
        if (ok) {
          setActionMode(null);
          setReason('');
        }
      });
    }
  }

  function submitApproval(role, passed) {
    if (passed) {
      perform('approve', { nodeId: node.id, role: role, passed: true, comment: '' }, '已记录' + fpFlowRoleLabel(role) + '确认通过');
      return;
    }
    const comment = rejectComment.trim();
    if (!comment) return;
    perform('approve', { nodeId: node.id, role: role, passed: false, comment: comment }, '已退回，进入返工').then((ok) => {
      if (ok) {
        setRejectRole(null);
        setRejectComment('');
      }
    });
  }

  function toggleDarkModeCheck() {
    if (archived) return;
    perform(
      'setNodeCheck',
      { nodeId: node.id, key: 'darkMode', value: !darkModeChecked },
      darkModeChecked ? '已取消深色模式验收' : '深色模式验收已勾选',
    );
  }

  function beginScheduleEdit() {
    setError(null);
    setDueDraft(fpFlowToLocalInput(node.dueAt));
    setFollowDraft(fpFlowToLocalInput(node.followUpAt));
    setPlannedDraft(fpFlowToLocalInput(node.plannedAt));
    setScheduleEditing(true);
  }

  function saveSchedule() {
    perform(
      'setNodeSchedule',
      {
        nodeId: node.id,
        dueAt: fpFlowFromLocalInput(dueDraft),
        followUpAt: fpFlowFromLocalInput(followDraft),
        plannedAt: fpFlowFromLocalInput(plannedDraft),
      },
      '计划时间已更新',
    ).then((ok) => {
      if (ok) setScheduleEditing(false);
    });
  }

  function openLinkForm(kind) {
    setLinkForm(true);
    setLinkError(null);
    setLinkKind(kind || 'design');
    setLinkTitle('');
    setLinkUrl('');
  }

  function submitLink() {
    const title = linkTitle.trim();
    const url = linkUrl.trim();
    if (!title) {
      setLinkError('请填写链接名称');
      return;
    }
    if (!fpFlowValidUrl(url)) {
      setLinkError('请填写以 http:// 或 https:// 开头的有效网址');
      return;
    }
    setLinkError(null);
    perform('addLink', { nodeId: node.id, title: title, url: url, kind: linkKind }, '链接已添加').then((ok) => {
      if (ok) {
        setLinkForm(false);
        setLinkTitle('');
        setLinkUrl('');
      }
    });
  }

  function removeLink(link) {
    if (archived) return;
    perform('removeLink', { linkId: link.id }, '链接已删除');
  }

  function saveNotes() {
    const value = notesDraft;
    if (value === savedNotesRef.current) return;
    setNotesState('saving');
    fpDispatch('setNodeNotes', { nodeId: node.id, notes: value })
      .then((result) => {
        if (result && result.ok) {
          savedNotesRef.current = value;
          setNotesState('saved');
        } else {
          setNotesState('error');
          setError({ text: (result && result.error) || '笔记保存失败', code: (result && result.code) || null });
        }
      })
      .catch(() => {
        setNotesState('error');
        setError({ text: '笔记保存失败：网络异常', code: 'NETWORK' });
      });
  }

  function handleNotesBlur(event) {
    const related = event && event.relatedTarget;
    if (related && event.currentTarget && event.currentTarget.contains(related)) return;
    saveNotes();
  }

  function approvalGateHintText() {
    if (gate.ok) return '可标记完成';
    if (gate.code === 'NEED_APPROVALS') return '需设计、产品均确认通过';
    if (gate.code === 'NEED_EVIDENCE') {
      const min = Math.max(0, Number(evidencePolicy.minLinks) || 0);
      return '证据 ' + fpEvidenceCount(links, evidencePolicy) + '/' + min;
    }
    return gate.error || '完成条件未满足';
  }

  /* 多角色确认融合成一块：每个角色一行（状态 + 最近确认信息 + 通过/退回），不再单列确认日志 */
  function renderApprovalBlock() {
    const log = fpArray(node.approvalLog);
    const reason = node.returnReason !== null && typeof node.returnReason === 'object' ? node.returnReason : null;
    const rows = ['design', 'product'].map((role) => {
      const passed = approvals[role] === true;
      const rejecting = rejectRole === role;
      const latest = log.filter((entry) => entry && entry.role === role).slice(-1)[0] || null;
      let meta = '';
      if (latest !== null) {
        const by = latest.by ? String(latest.by) : '';
        const at = latest.at ? fpFmtDateTime(latest.at, new Date()) : '';
        meta = [by, at].filter((item) => item !== '').join(' · ');
      }
      return h(
        React.Fragment,
        { key: role },
        h(
          'div',
          { className: 'fp-detail-approval-row' },
          h('span', { className: 'fp-detail-approval-role' }, fpFlowRoleLabel(role)),
          h(
            'span',
            { className: fpFlowClass('fp-detail-approval-state', passed ? 'fp-is-pass' : 'fp-is-wait') },
            passed ? '已通过' : '待确认',
          ),
          meta !== '' ? h('span', { className: 'fp-detail-approval-meta' }, meta) : null,
          h('span', { className: 'fp-spacer' }),
          passed
            ? null
            : h(
                FpButton,
                {
                  size: 'sm',
                  variant: 'default',
                  disabled: archived || !!busy || locked || finished || passed,
                  onClick: () => submitApproval(role, true),
                },
                '通过',
              ),
          h(
            FpButton,
            {
              size: 'sm',
              variant: 'ghost',
              disabled: archived || !!busy || locked || finished,
              onClick: () => {
                setRejectRole(rejecting ? null : role);
                setRejectComment('');
              },
            },
            rejecting ? '收起' : '退回',
          ),
        ),
        rejecting
          ? h(
              'div',
              { className: 'fp-detail-reject' },
              fpFlowField(
                '退回原因（必填）',
                h(FpTextarea, {
                  value: rejectComment,
                  rows: 2,
                  placeholder: '例如：交互细节与需求文档不一致',
                  onChange: setRejectComment,
                }),
              ),
              h(
                'div',
                { className: 'fp-detail-form-actions' },
                h(
                  FpButton,
                  {
                    size: 'sm',
                    variant: 'ghost',
                    onClick: () => {
                      setRejectRole(null);
                      setRejectComment('');
                    },
                  },
                  '取消',
                ),
                h(
                  FpButton,
                  {
                    size: 'sm',
                    variant: 'danger',
                    disabled: !rejectComment.trim() || !!busy,
                    onClick: () => submitApproval(role, false),
                  },
                  '确认退回',
                ),
              ),
              h('p', { className: 'fp-detail-hint' }, '退回后本节点回到未解锁，返工目标进入第 ' + ((node.round || 1) + 1) + ' 轮。'),
            )
          : null,
      );
    });
    const reasonRole = reason !== null
      ? (reason.fromRole === 'product' ? '产品' : reason.fromRole === 'design' ? '设计' : String(reason.by || ''))
      : '';
    const needsEvidence = !gate.ok && gate.code === 'NEED_EVIDENCE';
    const evidenceShortfall = Math.max(1, Math.max(0, Number(evidencePolicy.minLinks) || 0) - fpEvidenceCount(links, evidencePolicy));
    return h(
      React.Fragment,
      null,
      h('div', { className: 'fp-detail-approval-list' }, rows),
      reason !== null
        ? h(
            'p',
            { className: 'fp-detail-hint' },
            '退回：' + String(reason.comment || '') + '（' + reasonRole +
              (typeof reason.round === 'number' ? ' · 第 ' + reason.round + ' 轮' : '') + '）',
          )
        : null,
      needsEvidence
        ? h(
            'div',
            { className: 'fp-detail-approval-gate' },
            h('span', { className: 'fp-detail-hint' }, '双方已确认，还差 ' + evidenceShortfall + ' 条确认依据（链接）'),
            h(
              FpButton,
              {
                size: 'sm',
                variant: 'default',
                disabled: archived || !!busy,
                onClick: function () {
                  openLinkForm('design');
                  try {
                    setTimeout(function () {
                      const section = document.querySelector('.fp-detail-sec--links');
                      if (section && typeof section.scrollIntoView === 'function') section.scrollIntoView({ block: 'nearest' });
                    }, 80);
                  } catch (error) {
                    /* 滚动失败不影响展开表单 */
                  }
                },
              },
              '添加链接',
            ),
          )
        : null,
    );
  }

  function renderActionSection() {
    const children = [];
    if (locked) {
      return fpFlowSection(
        '推进节点',
        {},
        h('p', { className: 'fp-detail-hint' }, '前置节点完成后自动解锁。'),
      );
    }

    const actions = [];
    if (finished) {
      actions.push(
        h(
          FpButton,
          {
            key: 'reopen',
            fullWidth: true,
            variant: 'default',
            icon: 'rotate',
            disabled: archived || !!busy,
            onClick: () => {
              setActionMode('reopen');
              setReason('');
            },
          },
          '重新打开节点',
        ),
      );
    } else {
      if (status === 'ready' || status === 'revision') {
        actions.push(
          h(
            FpButton,
            {
              key: 'start',
              fullWidth: true,
              /* 只有「开始处理 / 继续修改」是主操作：用实心强调底，其余动作保持中性 */
              variant: 'primary',
              icon: 'play',
              disabled: archived || !!busy,
              onClick: startNode,
            },
            status === 'revision' ? '继续修改' : '开始处理',
          ),
        );
      }
      actions.push(
        h(
          FpButton,
          {
            key: 'complete',
            fullWidth: true,
            variant: 'default',
            icon: 'check',
            disabled: completeDisabled,
            title: gate.ok ? '完成节点' : '无法完成：' + gate.error,
            onClick: completeNode,
          },
          busy === 'completeNode' ? '提交中…' : '标记完成',
        ),
      );
      const secondary = [];
      if (status !== 'waiting') {
        secondary.push(
          h(
            FpButton,
            {
              key: 'wait',
              size: 'sm',
              variant: 'default',
              icon: 'pause',
              disabled: !canAct,
              onClick: () => {
                setActionMode('wait');
                setReason('');
                setWaitAt('');
              },
            },
            '等待',
          ),
        );
      }
      if (status !== 'blocked') {
        secondary.push(
          h(
            FpButton,
            {
              key: 'block',
              size: 'sm',
              variant: 'default',
              icon: 'block',
              disabled: !canAct,
              onClick: () => {
                setActionMode('block');
                setReason('');
                setWaitAt('');
              },
            },
            '阻塞',
          ),
        );
      }
      secondary.push(
        h(
          FpButton,
          {
            key: 'skip',
            size: 'sm',
            variant: 'default',
            icon: 'skip',
            // 未解锁节点也允许跳过（范围裁剪）：只有归档/已完成/忙碌时禁用
            disabled: archived || finished || !!busy,
            title: locked ? '跳过未解锁节点 = 本轮范围裁剪（编号保留）' : '跳过节点（不计入完成）',
            onClick: () => {
              setActionMode('skip');
              setReason('');
            },
          },
          '跳过',
        ),
      );
      actions.push(h('div', { key: 'secondary', className: 'fp-detail-action-row' }, ...secondary));
    }
    if (approvalNode && !locked) {
      children.push(h('div', { key: 'approval-title', className: 'fp-detail-approval-title' }, '双角色确认'));
      children.push(renderApprovalBlock());
    }
    children.push(h('div', { className: 'fp-detail-actions' }, ...actions));

    if (actionMode) {
      const actionTitles = {
        wait: '进入等待',
        block: '标记阻塞',
        skip: '跳过节点',
        reopen: '重新打开节点',
      };
      const confirmLabels = {
        wait: '确认等待',
        block: '确认阻塞',
        skip: '确认跳过',
        reopen: '确认重新打开',
      };
      const required = actionMode === 'block' || actionMode === 'skip' || actionMode === 'reopen';
      children.push(
        h(
          'div',
          { className: 'fp-detail-form fp-detail-form--inline' },
          h('div', { className: 'fp-detail-form-head' }, actionTitles[actionMode]),
          actionMode === 'wait'
            ? fpFlowField('说明（可选）', h(FpInput, { value: note, placeholder: '在等谁的什么反馈', onChange: setNote }))
            : null,
          required
            ? fpFlowField(
                '原因（必填）',
                h(FpTextarea, {
                  value: reason,
                  rows: 2,
                  placeholder: actionMode === 'skip' ? '例如：本次不涉及验收文件' : '例如：交互稿与需求不一致，需要调整',
                  onChange: setReason,
                }),
              )
            : null,
          actionMode === 'wait' || actionMode === 'block'
            ? fpFlowField(
                '跟进时间（可选）',
                h('input', {
                  type: 'datetime-local',
                  className: 'fp-dt-input',
                  value: waitAt,
                  onChange: (event) => setWaitAt(event.target.value),
                }),
              )
            : null,
          actionMode === 'skip'
            ? h('p', { className: 'fp-detail-hint' }, '不计入完成成果。')
            : null,
          h(
            'div',
            { className: 'fp-detail-form-actions' },
            h(
              FpButton,
              {
                size: 'sm',
                variant: 'ghost',
                disabled: !!busy,
                onClick: () => {
                  setActionMode(null);
                  setReason('');
                  setNote('');
                  setWaitAt('');
                },
              },
              '取消',
            ),
            h(
              FpButton,
              {
                size: 'sm',
                variant: actionMode === 'skip' ? 'danger' : 'primary',
                disabled: !!busy || (required && !reason.trim()),
                onClick: submitActionForm,
              },
              confirmLabels[actionMode],
            ),
          ),
        ),
      );
    }

    return fpFlowSection('推进节点', approvalNode && !locked ? { hint: approvalGateHintText() } : {}, ...children);
  }

  function renderAcceptanceSection() {
    if (!isAcceptanceNode) return null;
    return fpFlowSection(
      '验收检查',
      { hint: '完成验收前逐项确认' },
      h(
        'button',
        {
          type: 'button',
          role: 'checkbox',
          'aria-checked': darkModeChecked ? 'true' : 'false',
          className: 'fp-check' + (darkModeChecked ? ' fp-check--on' : ''),
          disabled: archived,
          title: archived ? '项目已归档，无法修改验收项' : '勾选表示深色模式验收通过',
          onClick: toggleDarkModeCheck,
        },
        h('span', { className: 'fp-check-box', 'aria-hidden': 'true' }, darkModeChecked ? h(FpIcon, { name: 'check', size: 11 }) : null),
        h('span', { className: 'fp-check-label' }, '深色模式验收通过'),
      ),
    );
  }

  function renderScheduleSection() {
    const settledSchedule = node.status === 'completed' || node.status === 'skipped';
    const dueInfo = node.dueAt ? fpFlowDueInfo(node.dueAt, now, settledSchedule) : null;
    const followInfo = node.followUpAt ? fpFlowDueInfo(node.followUpAt, now, settledSchedule) : null;
    const children = [];
    if (scheduleEditing) {
      children.push(
        h(
          'div',
          { className: 'fp-detail-form' },
          fpFlowField(
            '计划完成时间',
            h('input', {
              type: 'datetime-local',
              className: 'fp-dt-input',
              value: dueDraft,
              onChange: (event) => setDueDraft(event.target.value),
            }),
          ),
          fpFlowField(
            '计划开始时间',
            h('input', {
              type: 'datetime-local',
              className: 'fp-dt-input',
              value: plannedDraft,
              onChange: (event) => setPlannedDraft(event.target.value),
            }),
          ),
          fpFlowField(
            '下次跟进时间',
            h('input', {
              type: 'datetime-local',
              className: 'fp-dt-input',
              value: followDraft,
              onChange: (event) => setFollowDraft(event.target.value),
            }),
          ),
          h(
            'div',
            { className: 'fp-detail-form-actions' },
            h(
              FpButton,
              { size: 'sm', variant: 'ghost', disabled: !!busy, onClick: () => setScheduleEditing(false) },
              '取消',
            ),
            h(
              FpButton,
              { size: 'sm', variant: 'primary', disabled: !!busy, onClick: saveSchedule },
              busy === 'setNodeSchedule' ? '保存中…' : '保存时间',
            ),
          ),
        ),
      );
    } else {
      children.push(
        h(
          'div',
          { className: 'fp-detail-kv-list' },
          fpFlowKv('计划开始', node.plannedAt ? fpFmtDay(node.plannedAt, now) : '—', {
            title: node.plannedAt ? String(node.plannedAt) : undefined,
          }),
          fpFlowKv('计划完成', dueInfo ? dueInfo.text : '—', {
            tone: dueInfo && dueInfo.overdue ? 'fp-is-overdue' : dueInfo && dueInfo.soon ? 'fp-is-soon' : null,
            title: dueInfo ? dueInfo.full : undefined,
          }),
          fpFlowKv('下次跟进', followInfo ? followInfo.full : '—', {
            tone: followInfo && followInfo.overdue ? 'fp-is-overdue' : null,
          }),
        ),
      );
    }
    return fpFlowSection(
      '计划与跟进',
      {
        actions: scheduleEditing
          ? null
          : h(
              FpButton,
              { size: 'sm', variant: 'ghost', icon: 'edit', disabled: archived || !!busy, onClick: beginScheduleEdit },
              '编辑',
            ),
      },
      ...children,
    );
  }

  /** 取继承来源节点 id；无则 null。 */
  function inheritedFrom(link) {
    if (link === null || typeof link !== 'object') return null;
    const value = link.inheritedFrom;
    return typeof value === 'string' && value !== '' ? value : null;
  }

  /** 继承提示文案：继承自 D03：设计稿 搭建交互框架。 */
  function inheritedHint(link) {
    const sourceId = inheritedFrom(link);
    if (sourceId === null) return '继承自上游节点';
    const source = fpNodeById(state, sourceId);
    if (source === null) return '继承自上游节点';
    const code = typeof source.code === 'string' && source.code !== '' ? source.code : '上游节点';
    const title = typeof source.title === 'string' && source.title !== '' ? source.title : '';
    return '继承自 ' + code + (title !== '' ? '：' + title : '');
  }

  function renderLinksSection() {
    const children = [];
    if (links.length === 0 && !linkForm) {
      children.push(h('p', { className: 'fp-detail-hint' }, '还没有链接'));
    }
    if (links.length > 0) {
      children.push(
        h(
          'div',
          { className: 'fp-detail-links' },
          links.map((link, index) =>
            h(
              'div',
              { className: 'fp-detail-link', key: link.id || 'link-' + index },
              h('span', { className: 'fp-detail-link-icon' }, h(FpIcon, { name: fpFlowLinkKindIcon(link.kind), size: 13 })),
              h(
                'a',
                {
                  className: 'fp-detail-link-title',
                  href: link.url || '#',
                  target: '_blank',
                  rel: 'noopener noreferrer',
                  title: link.url || '',
                },
                link.title || link.url || '未命名链接',
              ),
              inheritedFrom(link) !== null
                ? h(
                    'span',
                    { className: 'fp-detail-link-inherit', title: inheritedHint(link) },
                    '继承',
                  )
                : null,
              h('span', { className: 'fp-detail-link-kind' }, fpFlowLinkKindLabel(link.kind)),
              archived
                ? null
                : h(
                    FpIconButton,
                    { label: '删除 ' + (link.title || '链接'), title: '删除链接', size: 22, onClick: () => removeLink(link) },
                    h(FpIcon, { name: 'trash', size: 12 }),
                  ),
            ),
          ),
        ),
      );
    }
    if (linkForm) {
      children.push(
        h(
          'div',
          { className: 'fp-detail-form' },
          fpFlowField('链接名称', h(FpInput, { value: linkTitle, placeholder: '例如：设计稿交互框架 v2', onChange: setLinkTitle })),
          fpFlowField('网址', h(FpInput, { value: linkUrl, placeholder: 'https://…', onChange: setLinkUrl })),
          fpFlowField(
            '类型',
            h(FpSelect, { value: linkKind, options: FP_LINK_KINDS, onChange: setLinkKind }),
          ),
          linkError ? h('p', { className: 'fp-detail-form-error' }, linkError) : null,
          h(
            'div',
            { className: 'fp-detail-form-actions' },
            h(
              FpButton,
              { size: 'sm', variant: 'ghost', disabled: !!busy, onClick: () => setLinkForm(false) },
              '取消',
            ),
            h(
              FpButton,
              { size: 'sm', variant: 'primary', disabled: !!busy, onClick: submitLink },
              busy === 'addLink' ? '添加中…' : '添加链接',
            ),
          ),
        ),
      );
    }
    return fpFlowSection(
      '关联链接',
      {
        className: 'fp-detail-sec--links',
        actions: h(
          FpButton,
          { size: 'sm', variant: 'ghost', icon: 'plus', disabled: archived || !!busy, onClick: () => openLinkForm('design') },
          '添加',
        ),
      },
      ...children,
    );
  }

  function notesHint() {
    if (notesState === 'saving') return '保存中…';
    if (notesState === 'saved') return '已保存';
    if (notesState === 'error') return '保存失败';
    if (notesState === 'dirty') return '未保存';
    return '';
  }

  function renderNotesSection() {
    const hint = notesHint();
    return fpFlowSection(
      '笔记',
      { hint: hint, className: 'fp-detail-sec--notes' + (notesState === 'saved' ? ' fp-is-saved' : notesState === 'error' ? ' fp-is-error' : '') },
      archived
        ? h('p', { className: 'fp-detail-notes-read' }, node.notes || '（无笔记）')
        : h(
            'div',
            { className: 'fp-detail-notes', onBlur: handleNotesBlur },
            h(FpTextarea, {
              value: notesDraft,
              rows: 4,
              placeholder: '记录判断与下一步…',
              onChange: (value) => {
                setNotesDraft(value);
                setNotesState(value !== savedNotesRef.current ? 'dirty' : 'idle');
              },
            }),
          ),
    );
  }

  function renderTimelineSection() {
    const items = events.map((event, index) =>
      h(
        'li',
        { className: 'fp-detail-event', key: event.id || 'event-' + index },
        h('span', { className: 'fp-detail-event-dot', 'aria-hidden': 'true' }),
        h(
          'div',
          { className: 'fp-detail-event-body' },
          h(
            'div',
            { className: 'fp-detail-event-top' },
            h('span', { className: 'fp-detail-event-kind' }, fpFlowEventLabel(event.kind)),
            event.actor && event.actor !== 'user'
              ? h('span', { className: 'fp-detail-event-actor', title: '操作者' }, event.actor === 'agent' ? 'AI' : String(event.actor))
              : null,
            typeof event.round === 'number' ? h('span', { className: 'fp-detail-event-round' }, '第 ' + event.round + ' 轮') : null,
            h(
              'time',
              {
                className: 'fp-detail-event-time',
                dateTime: event.timestamp || undefined,
                title: event.timestamp ? fpFmtDateTime(event.timestamp, now) : undefined,
              },
              fpFlowEventTime(event.timestamp, now),
            ),
          ),
          event.details ? h('div', { className: 'fp-detail-event-detail' }, event.details) : null,
        ),
      ),
    );
    return fpFlowSection(
      '事件时间线',
      {},
      events.length === 0
        ? h('p', { className: 'fp-detail-hint' }, '这个节点还没有事件记录。')
        : h('ol', { className: 'fp-detail-timeline' }, ...items),
    );
  }

  return h(
    'aside',
    { className: 'fp-detail', 'aria-label': '节点详情' },
    h(
      'header',
      { className: 'fp-detail-head' },
      h(
        'div',
        { className: 'fp-detail-top' },
        h('span', { className: 'fp-detail-code', title: flowName || '流程' }, (node.code || '') + (flowName ? ' · ' + flowName : '')),
        h('span', { className: 'fp-spacer' }),
        h(FpStatusChip, { status: status }),
        typeof onClose === 'function'
          ? h(FpIconButton, { label: '关闭节点详情', title: '关闭详情', size: 26, onClick: onClose }, h(FpIcon, { name: 'x', size: 14 }))
          : null,
      ),
      h('h2', { className: 'fp-detail-title' }, node.title || '未命名节点'),
      h(
        'div',
        { className: 'fp-detail-sub' },
        h('span', { className: 'fp-detail-sub-item', title: '所属项目' }, h(FpIcon, { name: 'flow', size: 11 }), projectTitle),
        h('span', { className: 'fp-detail-sub-item' }, h(FpIcon, { name: 'dot', size: 8 }), node.assigneeRole || '未指派'),
        node.round > 1 ? h(FpChip, { tone: 'amber' }, '第 ' + node.round + ' 轮') : null,
        archived ? h(FpChip, { tone: 'warn', dot: true }, '已归档') : null,
        status === 'waiting'
          ? h(
              FpChip,
              { tone: 'muted', title: '等待谁/等什么' },
              node.waitingKind === 'approval' ? '等对方确认' : node.waitingKind === 'external' ? '等外部跟进' : '等待中',
            )
          : null,
        fpIsApprovalNode(node)
          ? h(
              FpChip,
              { tone: 'muted', title: '完成证据条件：' + fpEvidenceText(evidencePolicy) },
              '证据 ' + fpEvidenceCount(links, evidencePolicy) + '/' + Math.max(0, Number(evidencePolicy.minLinks) || 0),
            )
          : null,
      ),
      node.detail ? h('p', { className: 'fp-detail-desc' }, node.detail) : null,
    ),
    h(
      'div',
      { className: 'fp-detail-scroll' },
      archived
        ? h(
            'div',
            { className: 'fp-detail-archived' },
            h(FpIcon, { name: 'archive', size: 12 }),
            '项目已归档：详情只读，恢复归档后可继续推进。',
          )
        : null,
      error
        ? h(
            'div',
            { className: 'fp-detail-error', role: 'alert' },
            h(FpIcon, { name: 'alert', size: 13 }),
            h(
              'div',
              { className: 'fp-detail-error-body' },
              h('div', { className: 'fp-detail-error-text' }, error.text || '操作失败'),
              error.code ? h('div', { className: 'fp-detail-error-code' }, error.code) : null,
            ),
            h(FpIconButton, { label: '关闭错误提示', size: 22, onClick: () => setError(null) }, h(FpIcon, { name: 'x', size: 12 })),
          )
        : null,
      renderAcceptanceSection(),
      renderActionSection(),
      renderScheduleSection(),
      renderLinksSection(),
      renderNotesSection(),
      renderTimelineSection(),
    ),
  );
}

/* ------------------------------------------------------------------ *
 * 样式：只在 fp- 命名空间内；颜色一律取自 CSS_BASE 的 --fp-* 令牌（设计系统 色表 + 4 栅格）
 * ------------------------------------------------------------------ */

const CSS_FLOW = String.raw`
/* ================================================================== *
 * FlowPilot 流程视图 + 节点详情
 * 视觉规范：docs/UI-DESIGN.md —— 灰阶面分层（不用描边）、4 栅格间距、
 * 颜色只走 CSS_BASE 的 --fp-* 令牌（light-dark 承载明暗双模式）。
 * ================================================================== */

.fp-flow,
.fp-detail {
  min-width: 0;
}
.fp-flow .fp-spacer,
.fp-detail .fp-spacer { flex: 1 1 auto; }
.fp-flow *,
.fp-flow *::before,
.fp-flow *::after,
.fp-detail *,
.fp-detail *::before,
.fp-detail *::after { box-sizing: border-box; }

/* ---------- FlowView 外框：--fp-base 打底 ---------- */
.fp-flow {
  display: flex;
  flex-direction: column;
  gap: var(--fp-sp-3);
  height: 100%;
  min-height: 0;
  min-width: 0;
  position: relative;
  /* 节点区的灰底从顶部开始：延伸到项目信息卡后面（只铺背景，不影响任何元素位置） */
  background: var(--fp-well);
  border-radius: var(--fp-radius-lg);
  overflow: hidden;
  color: var(--fp-text);
  font-size: var(--fp-font-md);
  line-height: 1.55;
}
.fp-flow--empty {
  align-items: center;
  justify-content: center;
  padding: var(--fp-sp-8) var(--fp-sp-6);
}
.fp-flow-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--fp-sp-3);
  max-width: 420px;
  text-align: center;
}
.fp-flow-empty-icon {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 56px;
  height: 56px;
  border-radius: var(--fp-radius-xl);
  background: var(--fp-accent-soft);
  color: var(--fp-accent-strong);
}
.fp-flow-empty-title {
  font-size: var(--fp-font-lg);
  font-weight: 650;
  color: var(--fp-text);
}
.fp-flow-empty-desc {
  font-size: var(--fp-font-sm);
  color: var(--fp-text-dim);
  line-height: 1.65;
}
.fp-flow-empty-actions { margin-top: var(--fp-sp-1); display: flex; gap: var(--fp-sp-2); }

/* ---------- 卡片 1：项目信息 ---------- */
.fp-flow-head {
  /* 头部左右内边距做成变量：底部流程进度条要用同值负 margin 通栏 */
  --fp-head-pad-x: var(--fp-sp-5);
  container-type: inline-size;
  container-name: flowhead;
  flex: 0 0 auto;
  margin: 0;
  padding: var(--fp-sp-4) var(--fp-head-pad-x);
  border-radius: var(--fp-radius-lg);
  background: var(--fp-surface);
  /* 已完成项目的「盖章」会伸出卡片右侧，靠 overflow 裁掉；进度条通栏也在此裁切 */
  position: relative;
  overflow: hidden;
}
/* 已完成需求：标题卡片右侧的倾斜浅绿印章（背景装饰，内容压在其上） */
.fp-flow-stamp {
  position: absolute;
  right: -18px;
  /* 略向左下，压在卡片内容边缘上；允许轻微压住一点内容 */
  top: calc(50% - 22px);
  width: 132px;
  height: 132px;
  transform: translateY(-50%) rotate(-14deg);
  color: color-mix(in srgb, var(--fp-ok) 62%, transparent);
  /* 叠加式油墨：印章和底下的卡片/文字混合，而不是盖一层实色 */
  mix-blend-mode: multiply;
  pointer-events: none;
  z-index: 0;
}
.fp-flow-stamp svg {
  display: block;
  width: 100%;
  height: 100%;
}
/* 深色主题：multiply 会把印章压成黑绿糊块、screen 又会发灰；
   这里回到普通混合，用更亮的半透明绿，保持「印章」的绿色饱和度 */
body[data-ds-dark-theme] .fp-flow-stamp {
  mix-blend-mode: normal;
  color: color-mix(in srgb, var(--fp-ok) 62%, transparent);
}
.fp-flow-head > *:not(.fp-flow-stamp) {
  position: relative;
  z-index: 1;
}
.fp-flow-head-main {
  display: flex;
  align-items: flex-start;
  gap: var(--fp-sp-4);
  flex-wrap: wrap;
}
.fp-flow-head-copy {
  flex: 1 1 340px;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: var(--fp-sp-1);
}
.fp-flow-eyebrow {
  display: flex;
  align-items: center;
  gap: var(--fp-sp-1);
  font-size: var(--fp-font-xs);
  color: var(--fp-text-tertiary);
  letter-spacing: 0.02em;
}
.fp-flow-eyebrow-dot {
  width: 6px;
  height: 6px;
  border-radius: var(--fp-radius-pill);
  background: var(--fp-accent);
}
.fp-flow-eyebrow-line { font-weight: 600; color: var(--fp-text-dim); }
.fp-flow-eyebrow-sep { color: var(--fp-text-quaternary); }
.fp-flow-eyebrow-mode { font-size: 10px; letter-spacing: 0.04em; }
.fp-flow-title--link {
  cursor: pointer;
}
.fp-flow-title--link:hover {
  color: var(--fp-accent-strong);
}
.fp-project-detail .fp-detail-kv-label {
  flex-basis: 76px;
}
.fp-project-edit {
  display: flex;
  flex-direction: column;
  gap: var(--fp-sp-3);
}
.fp-project-edit-actions {
  display: flex;
  align-items: center;
  gap: var(--fp-sp-2);
}
.fp-project-detail .fp-detail-kv-value {
  min-width: 0;
  overflow-wrap: anywhere;
}
.fp-project-detail .fp-detail-kv-value a {
  color: var(--fp-accent-strong);
  text-decoration: none;
  overflow-wrap: anywhere;
}
.fp-flow-title {
  margin: 0;
  font-size: 23px;
  font-weight: 650;
  letter-spacing: -0.012em;
  line-height: 1.25;
  color: var(--fp-text);
  overflow-wrap: anywhere;
}
.fp-flow-sub {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--fp-sp-1) var(--fp-sp-3);
  font-size: var(--fp-font-xs);
  color: var(--fp-text-dim);
}
.fp-flow-sub-item {
  display: inline-flex;
  align-items: center;
  gap: var(--fp-sp-1);
  min-width: 0;
}
.fp-flow-sub-item.fp-is-overdue { color: var(--fp-bad); font-weight: 600; }
.fp-flow-head-actions {
  display: flex;
  align-items: center;
  gap: var(--fp-sp-2);
  flex-wrap: nowrap;
  flex: 0 0 auto;
  /* 固定在信息卡右侧，不随标题换行漂移 */
  margin-left: auto;
}
/* ---- 流程看板右下角浮动「+」：圆形按钮 + 展开菜单（悬浮在节点卡片之上） ---- */
.fp-flow-fab-wrap {
  position: absolute;
  right: var(--fp-sp-4);
  bottom: var(--fp-sp-4);
  z-index: 30;
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: var(--fp-sp-2);
}
.fp-flow-fab-backdrop {
  position: fixed;
  inset: 0;
  z-index: 29;
}
.fp-flow-fab {
  position: relative;
  z-index: 30;
  flex: none;
  width: 40px;
  height: 40px;
  aspect-ratio: 1 / 1;
  padding: 0;
  border: 0;
  background: transparent;
  box-shadow: var(--fp-shadow-2);
  cursor: pointer;
  transition: transform 140ms ease, box-shadow 140ms ease;
}
/* 圆形本体画在内层：clip-path 强制正圆（宿主即便用 !important 改 button 半径也不受影响），
   阴影留在外层按钮上，不会被裁掉 */
.fp-flow-fab-disc {
  width: 100%;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  /* 中性配色：面底色 + 次级文字图标，不用强调色/主色 */
  background: var(--fp-surface);
  color: var(--fp-text-dim);
  border-radius: 999px;
  clip-path: circle(50% at 50% 50%);
}
.fp-flow-fab:hover .fp-flow-fab-disc {
  color: var(--fp-text);
}
.fp-flow-fab:hover {
  transform: scale(1.04);
  box-shadow: var(--fp-shadow-3);
}
.fp-flow-fab:active {
  transform: scale(0.96);
}
.fp-flow-fab[data-open="true"] {
  transform: rotate(45deg);
}
.fp-flow-fab:focus-visible {
  outline: none;
  box-shadow: var(--fp-shadow-3), 0 0 0 3px color-mix(in srgb, var(--fp-accent) 45%, transparent);
}
.fp-flow-fab-menu {
  position: relative;
  z-index: 30;
  display: flex;
  flex-direction: column;
  gap: var(--fp-sp-1);
  padding: var(--fp-sp-2);
  min-width: 176px;
  /* 悬浮卡片用更大圆角，和 FAB 的圆形更协调 */
  border-radius: var(--fp-radius-lg);
  background: var(--fp-overlay);
  box-shadow: var(--fp-shadow-3);
}
.fp-flow-fab-item {
  display: flex;
  align-items: center;
  gap: var(--fp-sp-2);
  height: 36px;
  padding: 0 var(--fp-sp-3);
  border: 0;
  border-radius: var(--fp-radius-sm);
  background: transparent;
  color: var(--fp-text);
  font: inherit;
  font-size: var(--fp-font-sm);
  text-align: left;
  cursor: pointer;
}
.fp-flow-fab-item:hover:not(:disabled) {
  background: var(--fp-hover);
}
.fp-flow-fab-item:disabled {
  opacity: 0.45;
  cursor: default;
}
.fp-flow-progress {
  display: flex;
  align-items: center;
  gap: var(--fp-sp-2);
  /* 与上面的标题/标签共用信息卡内边距：左右贴齐内容边，轨道自身仍撑满可用宽度 */
  margin: var(--fp-sp-4) 0 0;
  padding: 0;
  flex-wrap: wrap;
}
.fp-flow-progress-label { font-size: var(--fp-font-xs); color: var(--fp-text-tertiary); }
.fp-flow-progress-track {
  position: relative;
  flex: 1 1 auto;
  min-width: 0;
  height: 8px;
  border-radius: var(--fp-radius-pill);
  overflow: hidden;
  background: var(--fp-surface-2);
}
.fp-flow-progress-fill {
  height: 100%;
  border-radius: inherit;
  background: var(--fp-accent);
  transition: width 0.24s ease;
}
.fp-flow-progress-num {
  font-size: var(--fp-font-xs);
  font-weight: 650;
  font-variant-numeric: tabular-nums;
  color: var(--fp-text);
}
.fp-flow-progress-pct {
  font-size: 10px;
  font-variant-numeric: tabular-nums;
  color: var(--fp-text-tertiary);
}
.fp-flow-banner {
  display: flex;
  align-items: center;
  gap: var(--fp-sp-2);
  margin-top: var(--fp-sp-3);
  padding: var(--fp-sp-2) var(--fp-sp-3);
  border-radius: var(--fp-radius-md);
  background: color-mix(in srgb, var(--fp-warn) 14%, var(--fp-surface-2));
  color: var(--fp-text);
  font-size: var(--fp-font-xs);
  line-height: 1.5;
}

/* ---------- 卡片 2：项目节点 ---------- */
.fp-flow-canvas {
  display: flex;
  flex-direction: column;
  flex: 1 1 auto;
  min-height: 0;
  overflow: auto;
  padding: 0;
  border-radius: var(--fp-radius-lg);
  background: var(--fp-well);
  scrollbar-width: thin;
  /* 滚动边缘用「透明度渐变」淡出（不是毛玻璃）：内容滚出视口时 alpha 逐渐降到 0，避免硬截断 */
  mask-image: linear-gradient(
    to bottom,
    transparent 0,
    rgb(0 0 0) 32px,
    rgb(0 0 0) calc(100% - 32px),
    transparent 100%
  );
  -webkit-mask-image: linear-gradient(
    to bottom,
    transparent 0,
    rgb(0 0 0) 32px,
    rgb(0 0 0) calc(100% - 32px),
    transparent 100%
  );
}
.fp-flow-inner {
  /* 节点行距：竖线用同一个值做负方向延伸，保证相邻节点间连线无缝 */
  --fp-flow-row-gap: var(--fp-sp-2);
  flex: 1 0 auto;
  width: 100%;
  max-width: 920px;
  margin: 0 auto;
  padding: var(--fp-sp-4) var(--fp-sp-4) 96px;
}
/* 空态：中栏只有一张居中的信息卡 */
.fp-flow--empty {
  align-items: center;
  justify-content: center;
  padding: var(--fp-sp-6);
  background: var(--fp-surface);
  border-radius: var(--fp-radius-lg);
}
.fp-flow-seg { position: relative; }
.fp-flow-seg + .fp-flow-seg { margin-top: var(--fp-sp-1); }
.fp-flow-seg-head {
  display: flex;
  align-items: center;
  gap: var(--fp-sp-2);
  padding: 0 var(--fp-sp-1) var(--fp-sp-2) 44px;
}
.fp-flow-seg-dot {
  flex: 0 0 auto;
  width: 8px;
  height: 8px;
  border-radius: var(--fp-radius-sm);
  background: var(--fp-seg-accent, var(--fp-accent));
}
.fp-flow-seg-name {
  font-size: var(--fp-font-sm);
  font-weight: 650;
  color: var(--fp-text);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.fp-flow-seg-sub { font-size: 10px; color: var(--fp-text-quaternary); }
.fp-flow-seg-count {
  font-size: 10.5px;
  font-variant-numeric: tabular-nums;
  color: var(--fp-text-tertiary);
}
.fp-flow-seg-bar {
  width: 56px;
  height: 4px;
  border-radius: var(--fp-radius-pill);
  overflow: hidden;
  background: var(--fp-pressed);
}
.fp-flow-seg-bar > span {
  display: block;
  height: 100%;
  border-radius: inherit;
  background: var(--fp-seg-accent, var(--fp-accent));
  transition: width 0.24s ease;
}

/* ---------- 纵向流：行 / 轨道 / 连线（连线用 background，不用 border） ---------- */
.fp-flow-track { display: flex; flex-direction: column; }
.fp-flow-item {
  position: relative;
  display: flex;
  align-items: stretch;
  gap: var(--fp-sp-3);
  padding-bottom: var(--fp-flow-row-gap);
}
.fp-flow-item > .fp-node-card { flex: 1 1 auto; min-width: 0; }
.fp-flow-rail {
  position: relative;
  flex: 0 0 32px;
  width: 32px;
  display: flex;
  flex-direction: column;
  align-items: center;
}
.fp-flow-marker {
  position: relative;
  z-index: 1;
  flex: none;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  aspect-ratio: 1 / 1;
  /* 小圆形标记（不用圆角矩形） */
  border-radius: 999px;
  background: var(--fp-pressed);
  color: var(--fp-text-tertiary);
  transition: background-color 0.16s ease, color 0.16s ease, box-shadow 0.16s ease;
}
.fp-flow-marker--ready {
  background: var(--fp-pressed);
  color: var(--fp-text-dim);
}
.fp-flow-marker--active {
  background: color-mix(in srgb, var(--fp-accent) 14%, var(--fp-surface));
  color: var(--fp-accent-strong);
}
.fp-flow-marker--waiting {
  background: color-mix(in srgb, var(--fp-warn) 16%, var(--fp-surface));
  color: var(--fp-warn-strong);
}
.fp-flow-marker--blocked {
  background: color-mix(in srgb, var(--fp-bad) 14%, var(--fp-surface));
  color: var(--fp-bad);
}
.fp-flow-marker--revision {
  background: color-mix(in srgb, var(--fp-warn) 16%, var(--fp-surface));
  color: var(--fp-warn-strong);
}
.fp-flow-marker--completed {
  /* 绿色小圆：底色比之前略实一点，但仍是低对比的浅绿 */
  background: color-mix(in srgb, var(--fp-ok) 16%, var(--fp-surface));
  color: color-mix(in srgb, var(--fp-ok) 82%, var(--fp-text-dim));
}
.fp-flow-marker--skipped {
  background: var(--fp-pressed);
  color: var(--fp-text-quaternary);
}
.fp-flow-marker--locked {
  background: var(--fp-pressed);
  color: var(--fp-text-quaternary);
}
.fp-flow-marker.fp-is-current {
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--fp-accent) 14%, transparent);
}
/* 实线 / 回退虚线共用同一条竖直轴：水平中心 = 导轨中心 = marker 圆心（16px），
   竖直从 marker 圆心（20/2=10）起，并向下延伸过行距直抵下一行顶部，相邻节点间不漏线。
   线宽 1.5px、灰阶取「比背景略深一档」，可见但不抢节点卡的注意力。 */
.fp-flow-line,
.fp-flow-return-line {
  position: absolute;
  left: 50%;
  top: 10px;
  bottom: calc(-1 * var(--fp-flow-row-gap));
  width: 1.5px;
  transform: translateX(-50%);
  border-radius: var(--fp-radius-pill);
}
.fp-flow-line {
  background: color-mix(in srgb, var(--fp-border-strong) 55%, var(--fp-text-quaternary));
}
.fp-flow-line.fp-is-dashed {
  background: repeating-linear-gradient(
    to bottom,
    color-mix(in srgb, var(--fp-border-strong) 60%, var(--fp-text-quaternary)) 0 4px,
    transparent 4px 9px
  );
}
.fp-flow-return-line {
  /* 回退虚线：实色缺口盖住底层实线，读起来是一条居中的橙色虚线而非双线 */
  background: repeating-linear-gradient(
    to bottom,
    color-mix(in srgb, var(--fp-warn-strong) 62%, transparent) 0 3px,
    transparent 3px 8px
  );
}
.fp-flow-bridge {
  display: flex;
  align-items: stretch;
  gap: var(--fp-sp-3);
  padding-bottom: var(--fp-flow-row-gap);
}
.fp-flow-bridge-rail {
  position: relative;
  flex: 0 0 32px;
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 40px;
}
.fp-flow-bridge-line {
  position: absolute;
  left: 50%;
  top: 0;
  bottom: calc(-1 * var(--fp-flow-row-gap));
  width: 1.5px;
  transform: translateX(-50%);
  background: repeating-linear-gradient(
    to bottom,
    color-mix(in srgb, var(--fp-border-strong) 60%, var(--fp-text-quaternary)) 0 4px,
    transparent 4px 9px
  );
}
.fp-flow-bridge-node {
  position: relative;
  z-index: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  border-radius: var(--fp-radius-pill);
  background: var(--fp-surface);
  color: var(--fp-text-tertiary);
}
.fp-flow-bridge-body {
  flex: 1 1 auto;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: var(--fp-sp-1);
  justify-content: center;
  padding: var(--fp-sp-2) var(--fp-sp-3);
  border-radius: var(--fp-radius-md);
  background: var(--fp-surface);
}
.fp-flow-bridge-tag {
  display: inline-flex;
  align-items: center;
  gap: var(--fp-sp-1);
  font-size: var(--fp-font-xs);
  font-weight: 650;
  color: var(--fp-text);
}
.fp-flow-bridge-desc { font-size: 10px; color: var(--fp-text-dim); }
.fp-flow-placeholder {
  flex: 1 1 auto;
  min-width: 0;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: var(--fp-sp-2);
  padding: var(--fp-sp-4);
  border-radius: var(--fp-radius-md);
  background: var(--fp-surface);
  color: var(--fp-text-dim);
  font-size: var(--fp-font-xs);
  line-height: 1.6;
}
.fp-flow-placeholder--lg { gap: var(--fp-sp-2); padding: var(--fp-sp-5); }
.fp-flow-placeholder-title {
  font-size: var(--fp-font-md);
  font-weight: 650;
  color: var(--fp-text);
}
.fp-flow-placeholder-desc { font-size: var(--fp-font-xs); line-height: 1.6; }

/* ---------- 节点卡：面层级（不描边），当前节点左 3px 强调条 ---------- */
.fp-node-card {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: var(--fp-sp-2);
  padding: var(--fp-sp-3) var(--fp-sp-4);
  /* 裁掉贯穿全高的强调条上下角，让它贴着卡片圆角；自身 box-shadow 不受 overflow 裁切 */
  overflow: hidden;
  border-radius: var(--fp-radius-lg);
  background: var(--fp-surface);
  color: var(--fp-text);
  text-align: left;
  cursor: pointer;
  transition: background-color 0.14s ease, box-shadow 0.16s ease;
}
.fp-node-card::before {
  content: '';
  position: absolute;
  left: 0;
  top: 0;
  bottom: 0;
  width: 3px;
  background: var(--fp-accent);
  opacity: 0;
  transition: opacity 0.16s ease;
}
.fp-node-card:hover { background: var(--fp-pressed); }
.fp-node-card:active { background: color-mix(in srgb, var(--fp-pressed) 88%, var(--fp-text) 12%); }
.fp-node-card.fp-is-selected {
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--fp-accent) 26%, transparent);
}
.fp-node-card.fp-is-current {
  background: var(--fp-surface);
  box-shadow: var(--fp-shadow-1);
}
.fp-node-card.fp-is-current::before { opacity: 1; }
.fp-node-card.fp-is-current.fp-is-selected {
  box-shadow: var(--fp-shadow-1), 0 0 0 2px color-mix(in srgb, var(--fp-accent) 20%, transparent);
}
.fp-node-card.fp-is-done {
  /* 井色向文字色压一档：浅色更深、深色更亮，两种主题都能和井底分开 */
  background: color-mix(in srgb, var(--fp-well) 40%, var(--fp-surface) 60%);
}
.fp-node-card.fp-is-done:hover { background: var(--fp-pressed); }
.fp-node-card.fp-is-done .fp-node-title { color: var(--fp-text-dim); }
.fp-node-card.fp-is-done .fp-node-meta { color: var(--fp-text-tertiary); }
.fp-node-card.fp-is-locked {
  background: color-mix(in srgb, var(--fp-well) 40%, var(--fp-surface) 60%);
  box-shadow: none;
}
.fp-node-card.fp-is-locked:hover { background: var(--fp-hover); }
.fp-node-card.fp-is-locked .fp-node-title { color: var(--fp-text-quaternary); }
.fp-node-card.fp-is-locked .fp-node-meta,
.fp-node-card.fp-is-locked .fp-node-code,
.fp-node-card.fp-is-locked .fp-node-approval-item { color: var(--fp-text-quaternary); }
.fp-node-top {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--fp-sp-1);
  min-width: 0;
}
.fp-node-code {
  font-family: var(--fp-mono);
  font-size: 10.5px;
  font-weight: 650;
  letter-spacing: 0.05em;
  color: var(--fp-text-tertiary);
  white-space: nowrap;
}
.fp-node-flag {
  display: inline-flex;
  align-items: center;
  gap: var(--fp-sp-1);
  padding: 0 var(--fp-sp-2);
  border-radius: var(--fp-radius-pill);
  font-size: 10px;
  font-weight: 600;
  line-height: 1.6;
  white-space: nowrap;
}
.fp-node-flag--current {
  color: var(--fp-accent-strong);
  background: var(--fp-accent-soft);
}
.fp-node-flag-dot {
  width: 6px;
  height: 6px;
  border-radius: var(--fp-radius-pill);
  background: currentColor;
  animation: fp-flow-pulse 2.4s ease-in-out infinite;
}
.fp-node-flag--round {
  color: var(--fp-warn-strong);
  background: color-mix(in srgb, var(--fp-warn) 16%, transparent);
}
.fp-node-flag--return {
  color: var(--fp-warn-strong);
  background: color-mix(in srgb, var(--fp-warn) 12%, transparent);
}
.fp-node-title {
  font-size: 14px;
  font-weight: 600;
  line-height: 1.42;
  color: var(--fp-text);
  overflow-wrap: anywhere;
}
.fp-node-meta {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--fp-sp-1) var(--fp-sp-3);
  font-size: var(--fp-font-xs);
  color: var(--fp-text-dim);
}
.fp-node-meta-item {
  display: inline-flex;
  align-items: center;
  gap: var(--fp-sp-1);
  min-width: 0;
  white-space: nowrap;
}
.fp-node-meta-item.fp-is-overdue { color: var(--fp-bad); font-weight: 600; }
.fp-node-meta-item.fp-is-soon { color: var(--fp-warn-strong); font-weight: 600; }
.fp-node-meta-item.fp-is-follow { color: var(--fp-warn-strong); }
.fp-node-role { font-weight: 600; }
.fp-node-links.fp-is-empty { color: var(--fp-text-quaternary); }
.fp-node-approval {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--fp-sp-2);
}
.fp-node-approval-label { font-size: 10px; color: var(--fp-text-quaternary); }
.fp-node-approval-item {
  display: inline-flex;
  align-items: center;
  gap: var(--fp-sp-1);
  font-size: 10px;
  color: var(--fp-text-dim);
}
.fp-node-approval-item.fp-is-on { color: var(--fp-ok); }
.fp-node-approval-dot {
  width: 8px;
  height: 8px;
  border-radius: var(--fp-radius-pill);
  background: var(--fp-border-strong);
}
.fp-node-approval-item.fp-is-on .fp-node-approval-dot { background: var(--fp-ok); }

/* ---------- NodeDetail：surface 面板 + surface-2 嵌块 ---------- */
.fp-detail {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  min-width: 0;
  background: var(--fp-surface);
  color: var(--fp-text);
  font-size: var(--fp-font-md);
  line-height: 1.55;
}
.fp-detail--empty { align-items: center; justify-content: center; padding: var(--fp-sp-6); }
.fp-detail-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--fp-sp-2);
  font-size: var(--fp-font-sm);
  color: var(--fp-text-dim);
}
.fp-detail-head {
  flex: 0 0 auto;
  padding: var(--fp-sp-4) var(--fp-sp-4) var(--fp-sp-3);
  background: var(--fp-surface);
}
.fp-detail-top {
  display: flex;
  align-items: center;
  gap: var(--fp-sp-2);
  min-width: 0;
}
.fp-detail-code {
  font-family: var(--fp-mono);
  font-size: 10.5px;
  font-weight: 650;
  letter-spacing: 0.05em;
  color: var(--fp-text-tertiary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.fp-detail-title {
  margin: var(--fp-sp-1) 0 0;
  font-size: 16px;
  font-weight: 650;
  line-height: 1.35;
  color: var(--fp-text);
  overflow-wrap: anywhere;
}
.fp-detail-sub {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--fp-sp-1) var(--fp-sp-2);
  margin-top: var(--fp-sp-2);
  font-size: var(--fp-font-xs);
  color: var(--fp-text-dim);
}
.fp-detail-sub-item {
  display: inline-flex;
  align-items: center;
  gap: var(--fp-sp-1);
  min-width: 0;
}
.fp-detail-hint {
  margin: var(--fp-sp-2) 0 0;
  font-size: var(--fp-font-xs);
  line-height: 1.55;
  color: var(--fp-text-tertiary);
}
.fp-detail-desc {
  margin: var(--fp-sp-2) 0 0;
  font-size: var(--fp-font-xs);
  line-height: 1.6;
  color: var(--fp-text-dim);
}
.fp-detail-scroll {
  flex: 1 1 auto;
  min-height: 0;
  overflow-x: hidden;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: var(--fp-sp-2);
  padding: var(--fp-sp-2) var(--fp-sp-3) var(--fp-sp-6);
  scrollbar-width: thin;
}
.fp-detail-sec {
  display: flex;
  flex-direction: column;
  gap: var(--fp-sp-2);
  padding: var(--fp-sp-3);
  border-radius: var(--fp-radius-lg);
  background: var(--fp-surface-2);
}
.fp-detail-sec-head {
  display: flex;
  align-items: center;
  gap: var(--fp-sp-2);
  min-width: 0;
}
.fp-detail-sec-title {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  font-size: var(--fp-font-sm);
  font-weight: 650;
  color: var(--fp-text);
  white-space: nowrap;
}
.fp-detail-sec-hint {
  margin-left: auto;
  flex: 0 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  font-size: 10px;
  color: var(--fp-text-tertiary);
  white-space: nowrap;
}
/* 分组操作（编辑 / 添加 / 收起等）统一贴右，与标题分离 */
.fp-detail-sec-actions {
  display: inline-flex;
  align-items: center;
  gap: var(--fp-sp-1);
  margin-left: auto;
  flex: none;
}
.fp-detail-archived {
  display: flex;
  align-items: center;
  gap: var(--fp-sp-2);
  padding: var(--fp-sp-2) var(--fp-sp-3);
  border-radius: var(--fp-radius-md);
  background: color-mix(in srgb, var(--fp-warn) 14%, var(--fp-surface-2));
  color: var(--fp-warn-strong);
  font-size: var(--fp-font-xs);
}
.fp-detail-error {
  display: flex;
  align-items: flex-start;
  gap: var(--fp-sp-2);
  padding: var(--fp-sp-2) var(--fp-sp-3);
  border-radius: var(--fp-radius-md);
  background: color-mix(in srgb, var(--fp-bad) 12%, var(--fp-surface-2));
  color: var(--fp-text);
  font-size: var(--fp-font-xs);
  line-height: 1.5;
}
.fp-detail-error-body { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; gap: var(--fp-sp-1); }
.fp-detail-error-text { overflow-wrap: anywhere; }
.fp-detail-error-code {
  font-family: var(--fp-mono);
  font-size: 9.5px;
  letter-spacing: 0.04em;
  color: var(--fp-bad);
}
.fp-detail-gate.fp-is-warn {
  color: var(--fp-warn-strong);
  background: color-mix(in srgb, var(--fp-warn) 16%, transparent);
}
.fp-detail-gate.fp-is-ok {
  color: var(--fp-ok);
  background: color-mix(in srgb, var(--fp-ok) 12%, transparent);
}
/* 主操作与下方次要操作行：上下间距 12px；横向按钮之间仍为 8px */
.fp-check {
  display: flex;
  align-items: center;
  gap: var(--fp-sp-2);
  width: 100%;
  min-height: 36px;
  padding: var(--fp-sp-2) var(--fp-sp-3);
  border: 0;
  border-radius: var(--fp-radius-md);
  background: var(--fp-surface);
  color: var(--fp-text);
  font: inherit;
  font-size: var(--fp-font-md);
  text-align: left;
  cursor: pointer;
  transition: background-color 140ms ease, color 140ms ease;
}
.fp-check:hover:not(:disabled) { background: var(--fp-hover); }
.fp-check:disabled { opacity: 0.55; cursor: not-allowed; }
.fp-check-box {
  flex: none;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  border-radius: var(--fp-radius-sm);
  background: var(--fp-pressed);
  color: var(--fp-accent-strong);
}
.fp-check--on .fp-check-box { background: color-mix(in srgb, var(--fp-accent) 16%, transparent); }
.fp-check-label { flex: 1 1 auto; min-width: 0; }
.fp-detail-actions { display: flex; flex-direction: column; gap: var(--fp-sp-3); }
/* 详情分区底色是 surface-2；默认按钮若也用 surface-2 会完全糊在一起。
   这里把分区内的 default 按钮抬到 surface 一档（两套主题都有明确轮廓），不用强调色。 */
.fp-detail-sec .fp-btn--default {
  background: var(--fp-surface);
}
.fp-detail-sec .fp-btn--default:hover:not(:disabled) {
  /* 注意：light 主题的 --fp-hover 正好等于分区底色（surface-2），会把按钮"hover 没了" */
  background: var(--fp-pressed);
}
.fp-detail-sec .fp-btn--default:active:not(:disabled) {
  background: color-mix(in srgb, var(--fp-pressed) 85%, var(--fp-text) 6%);
}
.fp-detail-action-row { display: flex; gap: var(--fp-sp-2); }
.fp-detail-action-row > * { flex: 1 1 0; min-width: 0; }
.fp-detail-approval-list { display: flex; flex-direction: column; gap: var(--fp-sp-2); }
.fp-detail-approval-row {
  display: flex;
  align-items: center;
  gap: var(--fp-sp-2);
  padding: var(--fp-sp-2);
  border-radius: var(--fp-radius-md);
  background: var(--fp-surface);
}
.fp-detail-approval-role {
  font-size: var(--fp-font-xs);
  font-weight: 650;
  min-width: 32px;
  color: var(--fp-text);
}
.fp-detail-approval-gate {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--fp-sp-2);
  padding: var(--fp-sp-1) var(--fp-sp-1) 0;
}
.fp-detail-approval-gate .fp-detail-hint {
  min-width: 0;
}
.fp-detail-approval-title {
  font-size: var(--fp-font-xs);
  font-weight: 600;
  color: var(--fp-text-tertiary);
}
.fp-detail-approval-meta {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 10px;
  color: var(--fp-text-tertiary);
}
.fp-detail-approval-state { font-size: 10px; }
.fp-detail-approval-state.fp-is-pass { color: var(--fp-ok); }
.fp-detail-approval-state.fp-is-wait { color: var(--fp-text-tertiary); }
.fp-detail-reject {
  display: flex;
  flex-direction: column;
  gap: var(--fp-sp-2);
  padding: var(--fp-sp-2);
  border-radius: var(--fp-radius-md);
  background: var(--fp-surface);
}
.fp-detail-form { display: flex; flex-direction: column; gap: var(--fp-sp-2); }
.fp-detail-form--inline {
  padding: var(--fp-sp-3);
  border-radius: var(--fp-radius-md);
  background: var(--fp-surface);
}
.fp-detail-form-head {
  font-size: var(--fp-font-xs);
  font-weight: 650;
  color: var(--fp-text);
}
.fp-detail-form-actions {
  display: flex;
  justify-content: flex-end;
  gap: var(--fp-sp-2);
  flex-wrap: wrap;
}
.fp-detail-form-error {
  margin: 0;
  font-size: var(--fp-font-xs);
  color: var(--fp-bad);
}
.fp-detail-field { display: flex; flex-direction: column; gap: var(--fp-sp-1); }
.fp-detail-field-label { font-size: 10px; color: var(--fp-text-tertiary); }
.fp-detail-field-hint { font-size: 10px; color: var(--fp-text-tertiary); }
.fp-dt-input {
  width: 100%;
  height: 32px;
  padding: 0 var(--fp-sp-3);
  /* 原生 datetime-local/date 输入框：必须清掉 UA 的 2px 黑边与原生外观 */
  border: 0;
  appearance: none;
  -webkit-appearance: none;
  border-radius: var(--fp-radius-md);
  /* 分区底色是 surface-2，这里用 surface 让输入框浮起来（两套主题都是） */
  background: var(--fp-surface);
  color: var(--fp-text);
  font: inherit;
  font-size: var(--fp-font-md);
  font-variant-numeric: tabular-nums;
  /* 让日期选择器图标跟随浅/深主题（否则深色主题下是黑图标） */
  color-scheme: inherit;
  transition: background-color 140ms ease, box-shadow 140ms ease;
}
.fp-dt-input:hover:not(:disabled) {
  background: var(--fp-hover);
}
.fp-dt-input::-webkit-calendar-picker-indicator {
  opacity: 0.55;
  cursor: pointer;
}
.fp-dt-input::-webkit-calendar-picker-indicator:hover {
  opacity: 1;
}
.fp-dt-input:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.fp-dt-input:focus-visible {
  outline: none;
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--fp-accent) 45%, transparent);
}
.fp-detail-kv-list { display: flex; flex-direction: column; gap: var(--fp-sp-1); }
.fp-detail-kv {
  display: flex;
  align-items: baseline;
  gap: var(--fp-sp-2);
  font-size: var(--fp-font-xs);
}
.fp-detail-kv-label { flex: 0 0 60px; color: var(--fp-text-tertiary); }
.fp-detail-kv-value {
  min-width: 0;
  color: var(--fp-text);
  font-variant-numeric: tabular-nums;
  overflow-wrap: anywhere;
}
.fp-detail-kv-value.fp-is-overdue { color: var(--fp-bad); font-weight: 600; }
.fp-detail-kv-value.fp-is-soon { color: var(--fp-warn-strong); font-weight: 600; }
.fp-detail-links { display: flex; flex-direction: column; gap: var(--fp-sp-1); }
.fp-detail-link {
  display: flex;
  align-items: center;
  gap: var(--fp-sp-2);
  min-width: 0;
  padding: var(--fp-sp-1) var(--fp-sp-2);
  border-radius: var(--fp-radius-md);
}
.fp-detail-link:hover { background: var(--fp-surface); }
.fp-detail-link-icon {
  flex: 0 0 auto;
  display: flex;
  color: var(--fp-info);
}
.fp-detail-link-title {
  flex: 1 1 auto;
  min-width: 0;
  font-size: var(--fp-font-xs);
  color: var(--fp-info);
  text-decoration: none;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.fp-detail-link-title:hover { text-decoration: underline; }
.fp-detail-link-kind {
  flex: 0 0 auto;
  font-size: 9.5px;
  color: var(--fp-text-tertiary);
  background: var(--fp-surface);
  border-radius: var(--fp-radius-pill);
  padding: 0 var(--fp-sp-1);
  line-height: 1.6;
}
.fp-detail-link-inherit {
  flex: 0 0 auto;
  font-size: 9.5px;
  color: var(--fp-accent-strong);
  background: color-mix(in srgb, var(--fp-accent) 12%, transparent);
  border-radius: var(--fp-radius-pill);
  padding: 0 var(--fp-sp-1);
  line-height: 1.6;
  letter-spacing: 0.02em;
}
.fp-detail-notes { display: flex; flex-direction: column; gap: var(--fp-sp-1); }
.fp-detail-notes-read {
  margin: 0;
  font-size: var(--fp-font-xs);
  line-height: 1.6;
  color: var(--fp-text);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.fp-detail-sec--notes.fp-is-saved .fp-detail-sec-hint { color: var(--fp-ok); }
.fp-detail-sec--notes.fp-is-error .fp-detail-sec-hint { color: var(--fp-bad); }
.fp-detail-timeline {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
}
.fp-detail-event { position: relative; display: flex; gap: var(--fp-sp-2); }
.fp-detail-event + .fp-detail-event { margin-top: var(--fp-sp-3); }
.fp-detail-event:not(:last-child)::before {
  content: '';
  position: absolute;
  left: 2px;
  top: 14px;
  bottom: calc(-1 * var(--fp-sp-3));
  width: 2px;
  border-radius: var(--fp-radius-pill);
  background: var(--fp-border-strong);
}
.fp-detail-event-dot {
  position: relative;
  z-index: 1;
  flex: 0 0 6px;
  width: 6px;
  height: 6px;
  margin-top: var(--fp-sp-1);
  border-radius: var(--fp-radius-pill);
  background: var(--fp-text-quaternary);
}
.fp-detail-event-body { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; gap: var(--fp-sp-1); }
.fp-detail-event-top {
  display: flex;
  align-items: center;
  gap: var(--fp-sp-1);
  flex-wrap: wrap;
}
.fp-detail-event-kind {
  font-size: var(--fp-font-xs);
  font-weight: 600;
  color: var(--fp-text);
}
.fp-detail-event-round {
  font-size: 9.5px;
  color: var(--fp-text-tertiary);
  background: var(--fp-surface);
  border-radius: var(--fp-radius-pill);
  padding: 0 var(--fp-sp-1);
  line-height: 1.6;
}
.fp-detail-event-time {
  margin-left: auto;
  font-size: 10px;
  color: var(--fp-text-tertiary);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
.fp-detail-event-detail {
  font-size: var(--fp-font-xs);
  line-height: 1.5;
  color: var(--fp-text-dim);
  overflow-wrap: anywhere;
}

/* ---------- 动效 ---------- */
@keyframes fp-flow-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.32; }
}
@media (prefers-reduced-motion: reduce) {
  .fp-node-card,
  .fp-flow-progress-fill,
  .fp-flow-seg-bar > span,
  .fp-flow-marker { transition: none; }
  .fp-node-flag-dot { animation: none; }
}

/* ---------- 窄屏适配（右栏折叠由 shell 负责，这里保证节点卡不溢出） ---------- */
@media (max-width: 980px) {
  .fp-flow-head {
    --fp-head-pad-x: var(--fp-sp-4);
    margin: var(--fp-sp-3) var(--fp-sp-3) 0;
    padding: var(--fp-sp-3) var(--fp-head-pad-x);
  }
  .fp-flow-inner { padding: var(--fp-sp-3) var(--fp-sp-3) var(--fp-sp-10); }
  .fp-flow-title { font-size: 20px; }
}
@media (max-width: 720px) {
  .fp-flow-head {
    --fp-head-pad-x: var(--fp-sp-3);
    margin: var(--fp-sp-2) var(--fp-sp-2) 0;
    padding: var(--fp-sp-3) var(--fp-head-pad-x);
  }
  .fp-flow-inner { padding: var(--fp-sp-2) var(--fp-sp-2) var(--fp-sp-8); }
  .fp-flow-head-main { gap: var(--fp-sp-2); }
  .fp-flow-head-actions { width: 100%; }
  .fp-flow-title { font-size: 18px; }
  .fp-flow-item { gap: var(--fp-sp-2); }
  .fp-flow-seg-head { padding-left: 40px; }
  .fp-node-card { padding: var(--fp-sp-3); }
  .fp-node-meta { gap: var(--fp-sp-1) var(--fp-sp-2); }
  .fp-node-meta-item { white-space: normal; }
  .fp-flow-bridge-body { padding: var(--fp-sp-2); }
  .fp-detail-head { padding: var(--fp-sp-3) var(--fp-sp-3) var(--fp-sp-2); }
  .fp-detail-scroll { padding: var(--fp-sp-2) var(--fp-sp-2) var(--fp-sp-6); }
}

/* ---- 审批日志 / 退回原因 / 事件操作者 ---- */
.fp-detail-log-row{
  display:flex;align-items:flex-start;gap:8px;min-width:0;
  padding:var(--fp-sp-1) var(--fp-sp-2);border-radius:var(--fp-radius-sm);
  background:var(--fp-surface-2);font-size:var(--fp-font-xs);line-height:1.5;
}
.fp-detail-log-row--warn{
  background:color-mix(in srgb,var(--fp-bad) 10%,transparent);
}
.fp-detail-log-role{flex:none;font-weight:600;color:var(--fp-text-dim);}
/* 「通过 / 未通过」是短词：不压缩，长内容交给右侧 meta 换行 */
.fp-detail-log-text{flex:0 0 auto;white-space:nowrap;color:var(--fp-text);}
/* 评论/原因可能很长（用户会写整段说明）：允许换行并断词，绝不横向撑出面板 */
.fp-detail-log-meta{
  margin-left:auto;flex:1 1 auto;min-width:0;
  text-align:right;white-space:normal;overflow-wrap:anywhere;word-break:break-word;
  font-size:10px;line-height:1.5;color:var(--fp-text-tertiary);
}
.fp-detail-event-actor{
  padding:0 4px;height:16px;display:inline-flex;align-items:center;
  border-radius:var(--fp-radius-sm);
  background:color-mix(in srgb,var(--fp-accent) 12%,transparent);
  color:var(--fp-accent-strong);font-size:10px;font-weight:600;
}

/* ---- 追加节点模板弹窗 ---- */
.fp-append-form{display:flex;flex-direction:column;gap:12px;}
.fp-append-preview{
  display:flex;flex-direction:column;gap:4px;
  padding:8px;border-radius:var(--fp-radius-md);
  background:var(--fp-surface-2);
}
.fp-append-row{display:flex;align-items:center;gap:8px;min-width:0;font-size:var(--fp-font-xs);}
.fp-append-code{
  flex:none;min-width:28px;padding:0 4px;border-radius:var(--fp-radius-sm);
  background:var(--fp-surface);color:var(--fp-text-tertiary);
  font-family:var(--fp-mono);font-size:10px;text-align:center;
}
.fp-append-title{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--fp-text);}
.fp-append-meta{flex:none;font-size:10px;color:var(--fp-text-tertiary);}
.fp-append-day{margin-left:auto;flex:none;font-size:10px;color:var(--fp-text-dim);font-variant-numeric:tabular-nums;}
.fp-append-error{margin:0;font-size:var(--fp-font-xs);color:var(--fp-bad);}
.fp-node-planned{color:var(--fp-text-dim);}
`;
