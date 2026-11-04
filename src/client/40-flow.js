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
function fpFlowDueInfo(value, now) {
  const date = fpParseDate(value);
  if (!date) return null;
  const days = fpDaysLeft(value, now);
  const overdue = typeof days === 'number' && days < 0;
  const soon = typeof days === 'number' && !overdue && days <= 1;
  let text = fpFmtDay(value, now);
  if (overdue) text = text + ' · 逾期 ' + Math.abs(days) + ' 天';
  else if (days === 0) text = text + ' · 今天';
  else if (days === 1) text = text + ' · 明天';
  return { text: text, days: days, overdue: overdue, soon: soon, full: fpFmtDateTime(value, now) };
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
      opts.actions || null,
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
  const due = fpFlowDueInfo(node.dueAt, now);
  const follow = node.followUpAt ? fpFlowDueInfo(node.followUpAt, now) : null;
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
            '计划 ' + due.text,
          )
        : null,
      follow
        ? h(
            'span',
            { className: fpFlowClass('fp-node-meta-item', 'fp-is-follow'), title: '跟进时间：' + follow.full },
            h(FpIcon, { name: 'clock', size: 11 }),
            '跟进 ' + follow.text,
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

function FlowView({ state, derived, project, selection, onSelectNode, onCollapseDetail, onCreateProject, onAddFlow }) {
  const now = useNow(30000);
  const selectedNodeId = fpFlowSelectionNodeId(selection);

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
        h('div', { className: 'fp-flow-empty-desc' }, '左侧业务线下的每个项目都会展开成纵向节点流。也可以先创建项目，模板会自动生成整套节点。'),
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
          h('div', { className: 'fp-flow-placeholder' }, '这个流程还没有节点：创建项目时由模板自动生成。'),
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
              h(FpIcon, { name: fpFlowStatusIcon(node.status), size: 13 }),
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
          h('div', { className: 'fp-flow-placeholder-desc' }, '用「设计交付」或「验收」模板创建流程后，节点会按顺序展开。'),
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
          h('h1', { className: 'fp-flow-title' }, project.title || '未命名项目'),
          h(
            'div',
            { className: 'fp-flow-sub' },
            h(
              'span',
              {
                className: fpFlowClass('fp-flow-sub-item', dueInfo && dueInfo.overdue && 'fp-is-overdue'),
                title: dueInfo ? '截止：' + dueInfo.full : '未设置截止时间',
              },
              h(FpIcon, { name: 'calendar', size: 12 }),
              dueInfo ? '截止 ' + dueInfo.text : '未设截止',
            ),
            h(
              'span',
              { className: 'fp-flow-sub-item', title: '当前阶段' },
              h(FpIcon, { name: 'flag', size: 12 }),
              summary.currentCode ? summary.currentCode + ' · ' + summary.currentStage : summary.currentStage,
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
          !archived
            ? h(
                FpButton,
                {
                  size: 'sm',
                  variant: 'default',
                  icon: 'plus',
                  disabled: hasAcceptance,
                  title: hasAcceptance ? '项目已包含验收流程' : '为项目添加验收流程（A 系列节点）',
                  onClick: requestAddFlow,
                },
                '添加验收流程',
              )
            : null,
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
  );
}

/* ------------------------------------------------------------------ *
 * NodeDetail —— 右侧 344px 节点详情（契约 §7.2）
 * ------------------------------------------------------------------ */

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
  const gate = fpCanComplete(node, links, approvals);
  const archived = !!(project && project.status === 'archived');
  const finished = status === 'completed' || status === 'skipped';
  const locked = status === 'locked';
  const flow = (safeState.flows || []).filter((item) => item.id === node.flowId)[0] || null;
  const flowName = flow ? flow.name : '';
  const projectTitle = project ? project.title : fpProjectById(safeState, node.projectId) ? fpProjectById(safeState, node.projectId).title : '项目';
  const events = fpEventsFor(safeState, { nodeId: node.id, limit: 20 });
  const designCount = links.filter((link) => link && link.kind === 'design').length;
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

  function beginScheduleEdit() {
    setError(null);
    setDueDraft(fpFlowToLocalInput(node.dueAt));
    setFollowDraft(fpFlowToLocalInput(node.followUpAt));
    setScheduleEditing(true);
  }

  function saveSchedule() {
    perform(
      'setNodeSchedule',
      { nodeId: node.id, dueAt: fpFlowFromLocalInput(dueDraft), followUpAt: fpFlowFromLocalInput(followDraft) },
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

  function renderApprovalSection() {
    const gateTone = gate.ok ? 'fp-is-ok' : 'fp-is-warn';
    return fpFlowSection(
      '双角色确认',
      { hint: '双方通过 + 设计稿链接', className: 'fp-detail-sec--approval' },
      h(
        'div',
        { className: 'fp-detail-gate ' + gateTone },
        h(FpIcon, { name: gate.ok ? 'check' : 'alert', size: 12 }),
        h('span', {}, gate.ok ? '完成门槛已满足，可以完成节点' : '完成门槛：设计、产品均确认通过，且至少 1 条 设计稿链接'),
      ),
      h(
        'div',
        { className: 'fp-detail-approval-list' },
        ['design', 'product'].map((role) => {
          const passed = approvals[role] === true;
          const rejecting = rejectRole === role;
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
              h('span', { className: 'fp-spacer' }),
              h(
                FpButton,
                {
                  size: 'sm',
                  variant: passed ? 'quiet' : 'default',
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
        }),
      ),
      h(
        'div',
        { className: fpFlowClass('fp-detail-design', designCount > 0 ? 'fp-is-ok' : 'fp-is-warn') },
        h(FpIcon, { name: 'link', size: 12 }),
        h('span', { className: 'fp-detail-design-text' }, designCount > 0 ? '已关联 ' + designCount + ' 条 设计稿链接' : '缺少 设计稿链接，暂不能完成'),
        h('span', { className: 'fp-spacer' }),
        h(
          FpButton,
          { size: 'sm', variant: 'ghost', disabled: archived || !!busy, onClick: () => openLinkForm('design') },
          designCount > 0 ? '补充' : '添加链接',
        ),
      ),
      h('p', { className: 'fp-detail-hint' }, '需设计与产品双方确认，并添加 设计稿链接后才能完成；条件满足时宿主会自动完成节点。'),
    );
  }

  function renderActionSection() {
    const children = [];
    if (locked) {
      return fpFlowSection(
        '推进节点',
        { hint: meta.label },
        h('p', { className: 'fp-detail-hint' }, '前置节点完成后会自动解锁，当前只能预览与补全链接/笔记。'),
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
            variant: gate.ok && (status === 'active' || status === 'waiting' || status === 'blocked') ? 'primary' : 'default',
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
            variant: 'ghost',
            icon: 'skip',
            disabled: !canAct,
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
    children.push(h('div', { className: 'fp-detail-actions' }, ...actions));

    if (!gate.ok && !locked && !finished) {
      children.push(
        h(
          'div',
          { className: 'fp-detail-gate fp-is-warn' },
          h(FpIcon, { name: 'alert', size: 12 }),
          h('span', {}, gate.error),
        ),
      );
    }

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
            ? h('p', { className: 'fp-detail-hint' }, '跳过不计入完成成果，但会保留在事件时间线里。')
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

    return fpFlowSection('推进节点', { hint: meta.label }, ...children);
  }

  function renderScheduleSection() {
    const dueInfo = node.dueAt ? fpFlowDueInfo(node.dueAt, now) : null;
    const followInfo = node.followUpAt ? fpFlowDueInfo(node.followUpAt, now) : null;
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
          h('p', { className: 'fp-detail-hint' }, '留空表示不设置；逾期会在节点卡上用错误色提示。'),
        ),
      );
    } else {
      children.push(
        h(
          'div',
          { className: 'fp-detail-kv-list' },
          fpFlowKv('计划完成', dueInfo ? dueInfo.text : '未设置', {
            tone: dueInfo && dueInfo.overdue ? 'fp-is-overdue' : dueInfo && dueInfo.soon ? 'fp-is-soon' : null,
            title: dueInfo ? dueInfo.full : undefined,
          }),
          fpFlowKv('下次跟进', followInfo ? followInfo.full : '未设置', {
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
      children.push(h('p', { className: 'fp-detail-hint' }, '还没有链接。设计稿 交互稿、Figma 文件、需求文档都可以挂在这里。'));
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
    return '失焦自动保存';
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
              placeholder: '记录判断、反馈要点、下次继续的入口…',
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
      { hint: events.length > 0 ? '最近 ' + events.length + ' 条' : null },
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
      ),
      meta.hint ? h('p', { className: 'fp-detail-hint' }, meta.hint) : null,
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
      approvalNode ? renderApprovalSection() : null,
      renderActionSection(),
      renderScheduleSection(),
      renderLinksSection(),
      renderNotesSection(),
      renderTimelineSection(),
    ),
  );
}

/* ------------------------------------------------------------------ *
 * 样式：只在 fp- 命名空间内；颜色一律取自 CSS_BASE 的 --fp-* 令牌（设计色表 + 4 栅格）
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
  background: transparent;
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
  flex: 0 0 auto;
  margin: 0;
  padding: var(--fp-sp-4) var(--fp-head-pad-x);
  border-radius: var(--fp-radius-lg);
  background: var(--fp-surface);
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
  flex-wrap: wrap;
  flex: 0 0 auto;
}
.fp-flow-progress {
  display: flex;
  align-items: center;
  gap: var(--fp-sp-2);
  /* 抵消 .fp-flow-head 的左右内边距：进度条通栏铺满信息卡 */
  margin: var(--fp-sp-4) calc(-1 * var(--fp-head-pad-x)) 0;
  padding: 0 var(--fp-sp-2);
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
}
.fp-flow-inner {
  /* 节点行距：竖线用同一个值做负方向延伸，保证相邻节点间连线无缝 */
  --fp-flow-row-gap: var(--fp-sp-2);
  flex: 1 0 auto;
  width: 100%;
  max-width: 920px;
  margin: 0 auto;
  padding: var(--fp-sp-4) var(--fp-sp-4) var(--fp-sp-10);
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
  display: flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border-radius: var(--fp-radius-pill);
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
  background: color-mix(in srgb, var(--fp-ok) 14%, var(--fp-surface));
  color: var(--fp-ok);
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
  box-shadow: 0 0 0 4px color-mix(in srgb, var(--fp-accent) 16%, transparent);
}
/* 实线 / 回退虚线共用同一条竖直轴：水平中心 = 导轨中心 = marker 圆心（16px），
   竖直从 marker 圆心（28/2=14）起，并向下延伸过行距直抵下一行顶部，相邻节点间不漏线。 */
.fp-flow-line,
.fp-flow-return-line {
  position: absolute;
  left: 50%;
  top: 14px;
  bottom: calc(-1 * var(--fp-flow-row-gap));
  width: 2px;
  transform: translateX(-50%);
  border-radius: var(--fp-radius-pill);
}
.fp-flow-line {
  background: var(--fp-border-strong);
}
.fp-flow-line.fp-is-dashed {
  background: repeating-linear-gradient(
    to bottom,
    var(--fp-border-strong) 0 6px,
    transparent 6px 12px
  );
}
.fp-flow-return-line {
  /* 回退虚线：实色缺口盖住底层实线，读起来是一条居中的橙色虚线而非双线 */
  background: repeating-linear-gradient(
    to bottom,
    color-mix(in srgb, var(--fp-warn-strong) 72%, var(--fp-well)) 0 4px,
    var(--fp-well) 4px 10px
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
  width: 2px;
  transform: translateX(-50%);
  background: repeating-linear-gradient(
    to bottom,
    var(--fp-border-strong) 0 6px,
    transparent 6px 12px
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
  overflow: auto;
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
  font-size: var(--fp-font-sm);
  font-weight: 650;
  color: var(--fp-text);
  white-space: nowrap;
}
.fp-detail-sec-hint {
  margin-left: auto;
  font-size: 10px;
  color: var(--fp-text-tertiary);
  white-space: nowrap;
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
.fp-detail-gate {
  display: flex;
  align-items: flex-start;
  gap: var(--fp-sp-2);
  padding: var(--fp-sp-2) var(--fp-sp-3);
  border-radius: var(--fp-radius-md);
  font-size: var(--fp-font-xs);
  line-height: 1.5;
}
.fp-detail-gate.fp-is-warn {
  color: var(--fp-warn-strong);
  background: color-mix(in srgb, var(--fp-warn) 16%, transparent);
}
.fp-detail-gate.fp-is-ok {
  color: var(--fp-ok);
  background: color-mix(in srgb, var(--fp-ok) 12%, transparent);
}
.fp-detail-actions { display: flex; flex-direction: column; gap: var(--fp-sp-2); }
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
.fp-detail-design {
  display: flex;
  align-items: center;
  gap: var(--fp-sp-2);
  padding: var(--fp-sp-2) var(--fp-sp-3);
  border-radius: var(--fp-radius-md);
  font-size: var(--fp-font-xs);
}
.fp-detail-design.fp-is-ok {
  color: var(--fp-ok);
  background: color-mix(in srgb, var(--fp-ok) 12%, transparent);
}
.fp-detail-design.fp-is-warn {
  color: var(--fp-warn-strong);
  background: color-mix(in srgb, var(--fp-warn) 14%, transparent);
}
.fp-detail-design-text { min-width: 0; overflow-wrap: anywhere; }
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
  padding: 0 var(--fp-sp-2);
  border-radius: var(--fp-radius-md);
  background: var(--fp-base);
  color: var(--fp-text);
  font: inherit;
  font-size: var(--fp-font-xs);
  font-variant-numeric: tabular-nums;
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
`;
