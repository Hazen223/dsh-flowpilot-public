/* ===== 归属：Lead · 快捷浮层 / 设置页 / 布局服务桥 =====
 * PRD §5.4 的「常驻菜单栏」在 Web 里落到 shell.overlay 的右下角浮层：
 * 折叠态只显示 可推进 / 待跟进 / 最近截止，展开后是今日前三条 + 跟进清单
 * + 两个跳转（打开驾驶舱 / 日终交接）。所有数据来自同一份 derived，与主面板一致。
 */

/* ------------------------------ 布局服务 ------------------------------ */

let FP_CTX = null;
let FP_LAYOUT = null;

/** 惰性解析 layout 服务；不存在时返回 null，永不抛错。 */
function fpLayout() {
  if (FP_LAYOUT !== null && typeof FP_LAYOUT.selectPanel === 'function') return FP_LAYOUT;
  try {
    const candidate = FP_CTX === null || FP_CTX === undefined ? undefined : FP_CTX.layout;
    if (candidate !== null && candidate !== undefined && typeof candidate.selectPanel === 'function') {
      FP_LAYOUT = candidate;
      return FP_LAYOUT;
    }
  } catch (error) {
    /* 宿主未提供 layout 服务：跳转按钮降级为不可用 */
  }
  return null;
}

function fpOpenPanel() {
  const layout = fpLayout();
  if (!layout) return false;
  try {
    layout.selectPanel('flowpilot');
    return true;
  } catch (error) {
    try {
      console.warn('[flowpilot] 打开主面板失败：', error);
    } catch (ignored) {
      /* ignore */
    }
    return false;
  }
}

/** 把「明天上午 11:00」这类跟进时间算成 ISO；用于快捷推迟。 */
function fpFollowUpIso(now, workdays, dayOffset) {
  const offset = typeof dayOffset === 'number' ? dayOffset : 1;
  const anchor = new Date((fpParseDate(now) || new Date()).getTime() + offset * FP_MS_DAY);
  const target = fpNextWorkday(anchor, workdays, true);
  target.setHours(11, 0, 0, 0);
  return target.toISOString();
}

/** 侧栏图标缺失时的兜底（正常由 ui-shell 提供 FpSidebarGlyph）。 */
function FpGlyphFallback(props) {
  const size = props && typeof props.size === 'number' ? props.size : 18;
  const active = props && props.active === true;
  const dots = [
    { cx: 9, cy: 4, r: 2.1 },
    { cx: 9, cy: 9, r: 2.1 },
    { cx: 9, cy: 14, r: 2.1 },
  ];
  return h('svg', {
    width: size,
    height: size,
    viewBox: '0 0 18 18',
    'aria-hidden': 'true',
    focusable: 'false',
    style: { display: 'block', color: active ? 'var(--fp-brand)' : 'currentColor' },
  }, [
    h('path', { key: 'line', d: 'M9 6.2v0.6M9 11.2v0.6', stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round' }),
    ...dots.map((dot, index) => h('circle', { key: 'd' + index, cx: dot.cx, cy: dot.cy, r: dot.r, fill: 'currentColor' })),
    h('path', { key: 'tail', d: 'M12.4 9h2.6M13.6 7.4 15.6 9l-2 1.6', fill: 'none', stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round', strokeLinejoin: 'round' }),
  ]);
}

function fpSidebarGlyph(props) {
  return typeof FpSidebarGlyph === 'function' ? h(FpSidebarGlyph, props) : h(FpGlyphFallback, props);
}

/* ------------------------------ 快捷浮层 ------------------------------ */

function FpQuickRow(props) {
  const card = props.card;
  const now = props.now;
  const busy = props.busy;
  const onAction = props.onAction;
  return h('div', { className: 'fp-quick-row' }, [
    h('div', { key: 'main', className: 'fp-quick-row-main' }, [
      h('div', { key: 'title', className: 'fp-quick-row-title' }, [
        h('span', { key: 'code', className: 'fp-quick-code' }, card.code || '·'),
        h('span', { key: 'text', className: 'fp-truncate' }, card.title || '未命名节点'),
      ]),
      h('div', { key: 'meta', className: 'fp-quick-row-meta' }, [
        h('span', { key: 'project', className: 'fp-truncate' }, card.projectTitle || ''),
        card.dueAt
          ? h('span', { key: 'due', className: 'fp-quick-due' }, fpRelativeDay(card.dueAt, now))
          : card.followUpAt
            ? h('span', { key: 'follow', className: 'fp-quick-follow' }, '跟进 ' + fpRelativeDay(card.followUpAt, now))
            : null,
      ]),
    ]),
    h('div', { key: 'actions', className: 'fp-quick-row-actions' }, [
      props.canComplete
        ? h('button', {
            key: 'done',
            type: 'button',
            className: 'fp-quick-mini fp-quick-mini-primary',
            disabled: busy,
            title: '标记完成',
            onClick: () => onAction('complete', card),
          }, '完成')
        : null,
      h('button', {
        key: 'wait',
        type: 'button',
        className: 'fp-quick-mini',
        disabled: busy,
        title: '设为等待并推迟到明天 11:00',
        onClick: () => onAction('wait', card),
      }, '等待'),
    ]),
  ]);
}

/**
 * 快捷面板主体：从旧版右下角浮层移植过来的「页面」——信息 + 快速操作。
 * 与旧浮层共用同一批 .fp-quick-* 样式（行、按钮），外层换成可放在顶栏下方的卡片容器。
 */
function FpQuickCard(props) {
  const p = props !== null && typeof props === 'object' ? props : {};
  const snap = useFp();
  const now = useNow(30000);
  const [busy, run] = useFpAction();
  const state = snap.state;
  const derived = snap.derived;
  const settings = (state && state.settings) || {};
  const workdays = Array.isArray(settings.workdays) && settings.workdays.length > 0 ? settings.workdays : [1, 2, 3, 4, 5];
  const counts = (derived && derived.counts) || {};
  const focus = (derived && derived.focus) || null;
  const today = (derived && derived.today) || {};
  const recommended = fpArray(today.recommended).slice(0, 3);
  const followUps = fpArray(today.followUps).slice(0, 3);
  const nearestDue = fpArray(today.upcoming)[0] || null;
  const actionable = typeof counts.actionable === 'number' ? counts.actionable : 0;
  const followTotal = (typeof counts.waiting === 'number' ? counts.waiting : 0) + (typeof counts.blocked === 'number' ? counts.blocked : 0);
  const overdue = typeof counts.overdue === 'number' ? counts.overdue : 0;
  const [syncing, setSyncing] = React.useState(false);

  const close = typeof p.onClose === 'function' ? p.onClose : null;
  const openPanel = typeof p.onOpenPanel === 'function' ? p.onOpenPanel : fpOpenPanel;

  function goView(view) {
    try {
      const prefs = typeof fpShellReadPrefs === 'function' ? fpShellReadPrefs() || {} : {};
      if (typeof fpShellWritePrefs === 'function') fpShellWritePrefs(Object.assign({}, prefs, { view: view }));
    } catch (error) {
      /* 偏好写入失败不影响打开面板 */
    }
    // 已挂载的 Shell 不会重读 localStorage：必须通过事件通知它切视图
    if (typeof fpRequestView === 'function') fpRequestView(view);
    openPanel();
    if (close !== null) close();
  }

  async function handleAction(kind, card) {
    if (!card || !card.nodeId) return;
    if (kind === 'complete') {
      const result = await run('completeNode', { nodeId: card.nodeId });
      if (result.ok) {
        try {
          FpToast.push({ tone: 'success', text: '已完成「' + (card.title || '节点') + '」' });
        } catch (error) {
          /* ignore */
        }
      } else {
        fpToastError(result);
      }
      return;
    }
    const result = await run('waitNode', {
      nodeId: card.nodeId,
      followUpAt: fpFollowUpIso(now, workdays, 1),
      note: '从快捷面板推迟到明天上午',
    });
    if (!result.ok) fpToastError(result);
  }

  function handleSync() {
    if (syncing) return;
    setSyncing(true);
    Promise.resolve(typeof fpSyncNow === 'function' ? fpSyncNow() : null)
      .then(function (result) {
        setSyncing(false);
        if (!result) return;
        if (result.ok !== true) {
          FpToast.push({ tone: 'error', text: result.error || '同步失败' });
          return;
        }
        const info = result.result !== null && typeof result.result === 'object' ? result.result : {};
        FpToast.push({
          tone: 'success',
          text:
            info.direction === 'merge'
              ? '已三方合并完成'
              : info.direction === 'pull'
                ? '同步完成：云端较新，已拉取'
                : info.direction === 'push'
                  ? '同步完成：已上传云端'
                  : '同步完成：两端一致',
        });
      })
      .catch(function (error) {
        setSyncing(false);
        FpToast.push({ tone: 'error', text: error && error.message ? error.message : '同步失败' });
      });
  }

  const periodLabel = focus !== null && typeof focus.label === 'string' && focus.label !== '' ? focus.label : '';
  const prompt = focus !== null && focus.prompt !== null && typeof focus.prompt === 'object' ? focus.prompt : null;
  const silent = focus !== null && focus.silent === true;

  const children = [];

  children.push(
    h('div', { key: 'head', className: 'fp-qpanel-head' },
      h('div', { key: 'title', className: 'fp-qpanel-title' },
        h('span', { key: 'name', className: 'fp-qpanel-name' }, 'FlowPilot'),
        periodLabel !== '' ? h('span', { key: 'period', className: 'fp-qpanel-period' }, periodLabel) : null,
        silent ? h('span', { key: 'silent', className: 'fp-qpanel-period', title: '当前处于静默时段，不主动打扰' }, '静默') : null
      ),
      close !== null
        ? h('button', { key: 'close', type: 'button', className: 'fp-qpanel-close', 'aria-label': '关闭快捷面板', onClick: close }, h(FpIcon, { name: 'x', size: 12 }))
        : null
    )
  );

  children.push(
    h('div', { key: 'stats', className: 'fp-qpanel-stats' },
      h('button', { key: 'a', type: 'button', className: 'fp-qpanel-stat', onClick: function () { goView('today'); } },
        h('b', { className: 'fp-qpanel-stat-num' }, String(actionable)), h('span', { className: 'fp-qpanel-stat-label' }, '可推进')),
      h('button', { key: 'f', type: 'button', className: 'fp-qpanel-stat', onClick: function () { goView('today'); } },
        h('b', { className: 'fp-qpanel-stat-num' }, String(followTotal)), h('span', { className: 'fp-qpanel-stat-label' }, '待跟进')),
      h('button', { key: 'o', type: 'button', className: 'fp-qpanel-stat', 'data-tone': overdue > 0 ? 'error' : undefined, onClick: function () { goView('today'); } },
        h('b', { className: 'fp-qpanel-stat-num' }, String(overdue)), h('span', { className: 'fp-qpanel-stat-label' }, '逾期'))
    )
  );

  if (prompt !== null && !silent) {
    children.push(
      h('div', { key: 'prompt', className: 'fp-qpanel-prompt' },
        h('strong', { key: 't' }, typeof prompt.title === 'string' ? prompt.title : ''),
        typeof prompt.body === 'string' && prompt.body !== '' ? h('span', { key: 'b' }, prompt.body) : null)
    );
  }

  const body = [];

  body.push(
    h('div', { key: 'sec1', className: 'fp-qpanel-sec' },
      h('div', { key: 'label', className: 'fp-qpanel-label' }, '现在可推进'),
      recommended.length === 0
        ? h('div', { key: 'empty', className: 'fp-qpanel-empty' }, actionable > 0 ? '暂无高优先节点，去今日视图看看' : '没有待推进的节点')
        : recommended.map(function (card) {
            return h(FpQuickRow, {
              key: card.nodeId,
              card: card,
              now: now,
              busy: busy,
              canComplete: card.status !== 'waiting' && card.status !== 'blocked',
              onAction: handleAction,
            });
          })
    )
  );

  if (followUps.length > 0) {
    body.push(
      h('div', { key: 'sec2', className: 'fp-qpanel-sec' },
        h('div', { key: 'label', className: 'fp-qpanel-label' }, '等待跟进'),
        followUps.map(function (card) {
          return h('button', {
            key: card.nodeId,
            type: 'button',
            className: 'fp-qpanel-row',
            title: '在驾驶舱中查看',
            onClick: function () { goView('today'); },
          },
            h('span', { key: 'code', className: 'fp-quick-code' }, card.code || '·'),
            h('span', { key: 'title', className: 'fp-truncate' }, card.title || ''),
            h('span', { key: 'when', className: 'fp-qpanel-when' }, card.followUpAt ? fpRelativeDay(card.followUpAt, now) : '未设跟进')
          );
        })
      )
    );
  }

  if (nearestDue !== null) {
    body.push(
      h('div', { key: 'sec3', className: 'fp-qpanel-sec' },
        h('div', { key: 'label', className: 'fp-qpanel-label' }, '最近截止'),
        h('div', { key: 'row', className: 'fp-qpanel-row' },
          h('span', { key: 'p', className: 'fp-truncate' }, nearestDue.projectTitle || ''),
          h('span', { key: 'd', className: 'fp-qpanel-when' }, fpRelativeDay(nearestDue.dueAt, now)))
      )
    );
  }

  children.push(h('div', { key: 'body', className: 'fp-qpanel-body fp-scroll' }, body));

  children.push(
    h('div', { key: 'foot', className: 'fp-qpanel-foot' },
      h('button', { key: 'open', type: 'button', className: 'fp-qpanel-cta', onClick: function () { openPanel(); if (close !== null) close(); } }, '打开工作台'),
      h('button', { key: 'today', type: 'button', className: 'fp-qpanel-ghost', onClick: function () { goView('today'); } }, '今日'),
      h('button', { key: 'handoff', type: 'button', className: 'fp-qpanel-ghost', onClick: function () { goView('handoff'); } }, '交接'),
      h('span', { key: 'spacer', className: 'fp-spacer' }),
      h('button', {
        key: 'sync',
        type: 'button',
        className: 'fp-qpanel-ghost',
        disabled: syncing === true,
        title: '立即同步（云端 ↔ 本地，最新覆盖旧的）',
        onClick: handleSync,
      }, syncing === true ? '同步中…' : '同步')
    )
  );

  return h('div', { className: 'fp-qpanel-card', role: 'dialog', 'aria-label': 'FlowPilot 快捷面板' }, children);
}

/** 顶栏锚定的浮层：从顶栏入口向下展开（旧版是右下角向上展开）。 */
function FpQuickPopover(props) {
  const p = props !== null && typeof props === 'object' ? props : {};
  const anchor = p.anchor !== null && typeof p.anchor === 'object' ? p.anchor : null;
  const onClose = typeof p.onClose === 'function' ? p.onClose : null;
  const rootRef = useRef(null);

  useEffect(function () {
    const onPointer = function (event) {
      const node = rootRef.current;
      if (node === null || node === undefined || typeof node.contains !== 'function') return;
      if (event && event.target && node.contains(event.target)) return;
      if (onClose !== null) onClose();
    };
    const onKey = function (event) {
      if (event && event.key === 'Escape' && onClose !== null) onClose();
    };
    const onMove = function () {
      if (onClose !== null) onClose();
    };
    if (typeof document !== 'undefined') {
      document.addEventListener('mousedown', onPointer, true);
      document.addEventListener('keydown', onKey, true);
    }
    if (typeof window !== 'undefined') {
      window.addEventListener('resize', onMove);
      window.addEventListener('scroll', onMove, true);
    }
    return function () {
      if (typeof document !== 'undefined') {
        document.removeEventListener('mousedown', onPointer, true);
        document.removeEventListener('keydown', onKey, true);
      }
      if (typeof window !== 'undefined') {
        window.removeEventListener('resize', onMove);
        window.removeEventListener('scroll', onMove, true);
      }
    };
  }, [onClose]);

  const width = 372;
  const vw = typeof window !== 'undefined' && typeof window.innerWidth === 'number' ? window.innerWidth : 1440;
  const vh = typeof window !== 'undefined' && typeof window.innerHeight === 'number' ? window.innerHeight : 900;
  const anchorBottom = anchor !== null && typeof anchor.bottom === 'number' ? anchor.bottom : 56;
  const anchorRight = anchor !== null && typeof anchor.right === 'number' ? anchor.right : vw - 16;
  const top = Math.max(8, Math.round(anchorBottom + 8));
  const left = Math.min(Math.max(8, Math.round(anchorRight - width)), Math.max(8, vw - width - 8));
  const maxHeight = Math.max(240, vh - top - 12);

  return h(
    'div',
    {
      className: 'fp-qpanel',
      ref: rootRef,
      style: { position: 'fixed', top: top + 'px', left: left + 'px', width: width + 'px', maxHeight: maxHeight + 'px' },
    },
    h(FpQuickCard, { onClose: onClose, onOpenPanel: fpOpenPanel })
  );
}

/**
 * 顶栏入口：FlowPilot 工作台未打开时显示在 harness 顶栏；
 * 点击后在按钮下方展开「快捷面板」（移植自旧版右下角浮层的信息 + 快速操作页）。
 */
function FpHeaderChip() {
  const snap = useFp();
  const [panelOpen, setPanelOpen] = useState(function () {
    try {
      return typeof document !== 'undefined' && typeof document.querySelector === 'function' && document.querySelector('.fp-root') !== null;
    } catch (error) {
      return false;
    }
  });
  const [anchor, setAnchor] = useState(null);

  useEffect(function () {
    let observer = null;
    const read = function () {
      try {
        return typeof document !== 'undefined' && typeof document.querySelector === 'function' && document.querySelector('.fp-root') !== null;
      } catch (error) {
        return false;
      }
    };
    const sync = function () {
      const next = read();
      setPanelOpen(function (previous) {
        return previous === next ? previous : next;
      });
    };
    sync();
    if (typeof MutationObserver === 'function' && typeof document !== 'undefined' && document.body) {
      observer = new MutationObserver(sync);
      try {
        observer.observe(document.body, { childList: true, subtree: true });
      } catch (error) {
        observer = null;
      }
    }
    return function () {
      if (observer !== null) {
        try {
          observer.disconnect();
        } catch (error) {
          /* ignore */
        }
      }
    };
  }, []);

  if (panelOpen) return null;
  if (snap.status !== 'ready' || snap.state === null) return null;

  const derived = snap.derived !== null && typeof snap.derived === 'object' ? snap.derived : {};
  const counts = derived.counts !== null && typeof derived.counts === 'object' ? derived.counts : {};
  const actionable = typeof counts.actionable === 'number' ? counts.actionable : 0;
  const follow = (typeof counts.waiting === 'number' ? counts.waiting : 0) + (typeof counts.blocked === 'number' ? counts.blocked : 0);
  const open = anchor !== null;

  return h(
    'div',
    { className: 'fp-headchip-wrap' },
    h(
      'button',
      {
        type: 'button',
        className: 'fp-headchip' + (open ? ' fp-headchip--open' : ''),
        title: 'FlowPilot 快捷面板',
        'aria-haspopup': 'dialog',
        'aria-expanded': open ? 'true' : 'false',
        'aria-label': '打开 FlowPilot 快捷面板',
        onClick: function (event) {
          if (open) {
            setAnchor(null);
            return;
          }
          const target = event && event.currentTarget ? event.currentTarget : null;
          const rect = target !== null && typeof target.getBoundingClientRect === 'function' ? target.getBoundingClientRect() : null;
          setAnchor(rect !== null ? { bottom: rect.bottom, right: rect.right } : { bottom: 56, right: 0 });
        },
      },
      h('span', { className: 'fp-headchip__mark' }, h(FpSidebarGlyph, { size: 13, active: true })),
      h('span', { className: 'fp-headchip__name' }, 'FlowPilot'),
      actionable > 0 ? h('span', { className: 'fp-headchip__count', 'data-tone': 'brand' }, '可推进 ' + actionable) : null,
      follow > 0 ? h('span', { className: 'fp-headchip__count', 'data-tone': 'warn' }, '待跟进 ' + follow) : null,
    ),
    open ? h(FpQuickPopover, { anchor: anchor, onClose: function () { setAnchor(null); } }) : null,
  );
}

function QuickDock() {
  const snap = useFp();
  const now = useNow(30000);
  const [busy, run] = useFpAction();
  const [open, setOpen] = useState(false);
  const rootRef = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const onPointer = (event) => {
      const node = rootRef.current;
      if (node && event.target instanceof Node && !node.contains(event.target)) setOpen(false);
    };
    const onKey = (event) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onPointer, true);
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('mousedown', onPointer, true);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [open]);

  const state = snap.state;
  const derived = snap.derived;
  const settings = (state && state.settings) || {};
  const workdays = settings.workdays || [1, 2, 3, 4, 5];
  const counts = (derived && derived.counts) || {};
  const focus = (derived && derived.focus) || null;
  const today = (derived && derived.today) || {};
  const recommended = fpArray(today.recommended).slice(0, 3);
  const followUps = fpArray(today.followUps).slice(0, 3);
  const ready = snap.status === 'ready' && state && derived;

  async function handleAction(kind, card) {
    if (!card || !card.nodeId) return;
    if (kind === 'complete') {
      const result = await run('completeNode', { nodeId: card.nodeId });
      if (result.ok) {
        try {
          FpToast.push({ tone: 'success', text: '已完成「' + (card.title || '节点') + '」' });
        } catch (error) {
          /* ignore */
        }
      } else {
        fpToastError(result);
      }
      return;
    }
    const result = await run('waitNode', {
      nodeId: card.nodeId,
      followUpAt: fpFollowUpIso(now, workdays, 1),
      note: '从快捷面板推迟到明天上午',
    });
    if (!result.ok) fpToastError(result);
  }

  if (snap.status === 'loading' && !ready) {
    return h('div', { className: 'fp-quick fp-quick-quiet' },
      h('div', { className: 'fp-quick-pill fp-quick-pill-idle' },
        h('span', { className: 'fp-quick-dot' }),
        h('span', null, 'FlowPilot')));
  }

  if (snap.status === 'error' && !ready) {
    return h('div', { className: 'fp-quick fp-quick-quiet' },
      h('button', {
        type: 'button',
        className: 'fp-quick-pill fp-quick-pill-error',
        title: snap.error || 'FlowPilot 宿主未就绪',
        onClick: () => fpRefresh(),
      }, h('span', { className: 'fp-quick-dot' }), 'FlowPilot 未连接'));
  }

  const nearestDue = fpArray(today.upcoming)[0] || null;
  const pillSummary = [
    { key: 'active', value: counts.actionable || 0, label: '可推进' },
    { key: 'follow', value: (counts.waiting || 0) + (counts.blocked || 0), label: '待跟进' },
  ];

  return h('div', { className: 'fp-quick', ref: rootRef }, [
    open
      ? h('div', { key: 'card', className: 'fp-quick-card fp-fade-in', role: 'dialog', 'aria-label': 'FlowPilot 快捷面板' }, [
          h('div', { key: 'head', className: 'fp-quick-head' }, [
            h('div', { key: 'title', className: 'fp-quick-title' }, [
              h('span', { key: 'name', className: 'fp-quick-name' }, 'FlowPilot'),
              focus
                ? h('span', { key: 'period', className: 'fp-quick-period' }, focus.label || FP_PERIOD_LABELS[focus.period] || '')
                : null,
              focus && focus.silent ? h('span', { key: 'silent', className: 'fp-quick-silent', title: '当前处于静默时段，不主动打扰' }, '静默') : null,
            ]),
            h('button', {
              key: 'close',
              type: 'button',
              className: 'fp-quick-close',
              'aria-label': '收起',
              onClick: () => setOpen(false),
            }, '×'),
          ]),
          focus && focus.prompt && !focus.silent
            ? h('div', { key: 'prompt', className: 'fp-quick-prompt' }, [
                h('strong', { key: 't' }, focus.prompt.title || ''),
                h('span', { key: 'b', className: 'fp-muted' }, focus.prompt.body || ''),
              ])
            : null,
          h('div', { key: 'body', className: 'fp-quick-body fp-scroll' }, [
            h('div', { key: 'sec1', className: 'fp-quick-sec' }, [
              h('div', { key: 'label', className: 'fp-quick-sec-label' }, '现在可推进'),
              recommended.length === 0
                ? h('div', { key: 'empty', className: 'fp-quick-empty' }, counts.actionable ? '暂无高优先节点，去今日视图看看' : '没有待推进的节点，很好')
                : recommended.map((card) => h(FpQuickRow, {
                    key: card.nodeId,
                    card: card,
                    now: now,
                    busy: busy,
                    canComplete: card.status !== 'waiting' && card.status !== 'blocked',
                    onAction: handleAction,
                  })),
            ]),
            followUps.length > 0
              ? h('div', { key: 'sec2', className: 'fp-quick-sec' }, [
                  h('div', { key: 'label', className: 'fp-quick-sec-label' }, '等待跟进'),
                  ...followUps.map((card) => h('button', {
                    key: card.nodeId,
                    type: 'button',
                    className: 'fp-quick-follow-row',
                    title: '在驾驶舱中查看',
                    onClick: () => {
                      fpOpenPanel();
                      setOpen(false);
                    },
                  }, [
                    h('span', { key: 'code', className: 'fp-quick-code' }, card.code || '·'),
                    h('span', { key: 'title', className: 'fp-truncate' }, card.title || ''),
                    h('span', { key: 'when', className: 'fp-quick-when' },
                      card.followUpAt ? '跟进 ' + fpRelativeDay(card.followUpAt, now) : '未设跟进'),
                  ])),
                ])
              : null,
            nearestDue
              ? h('div', { key: 'sec3', className: 'fp-quick-sec' }, [
                  h('div', { key: 'label', className: 'fp-quick-sec-label' }, '最近截止'),
                  h('div', { key: 'row', className: 'fp-quick-due-row' }, [
                    h('span', { key: 'p', className: 'fp-truncate' }, nearestDue.projectTitle || ''),
                    h('span', { key: 'd', className: 'fp-quick-due' }, fpFmtDay(nearestDue.dueAt, now) + ' · ' + fpRelativeDay(nearestDue.dueAt, now)),
                  ]),
                ])
              : null,
          ]),
          h('div', { key: 'foot', className: 'fp-quick-foot' }, [
            h('button', {
              key: 'open',
              type: 'button',
              className: 'fp-quick-cta',
              onClick: () => {
                fpOpenPanel();
                setOpen(false);
              },
            }, '打开驾驶舱'),
            h('button', {
              key: 'handoff',
              type: 'button',
              className: 'fp-quick-ghost',
              onClick: () => {
                fpOpenPanel();
                setOpen(false);
              },
            }, '日终交接'),
            h('span', { key: 'spacer', className: 'fp-spacer' }),
            h('button', {
              key: 'refresh',
              type: 'button',
              className: 'fp-quick-ghost',
              title: '刷新',
              onClick: () => fpRefresh(),
            }, '刷新'),
          ]),
        ])
      : null,
    h('button', {
      key: 'pill',
      type: 'button',
      className: 'fp-quick-pill' + (open ? ' fp-quick-pill-open' : ''),
      'aria-expanded': open ? 'true' : 'false',
      'aria-label': open ? '收起 FlowPilot 快捷面板' : '展开 FlowPilot 快捷面板',
      onClick: () => setOpen((value) => !value),
    }, [
      h('span', { key: 'g', className: 'fp-quick-glyph' }, fpSidebarGlyph({ size: 15, active: open })),
      ...pillSummary.map((item, index) => h('span', { key: item.key, className: 'fp-quick-stat' }, [
        index > 0 ? h('span', { key: 'sep', className: 'fp-quick-sep' }, '·') : null,
        h('b', { key: 'v', className: item.value > 0 ? 'fp-quick-stat-hot' : 'fp-quick-stat-zero' }, String(item.value)),
        h('span', { key: 'l' }, item.label),
      ])),
      nearestDue
        ? h('span', { key: 'due', className: 'fp-quick-stat fp-quick-stat-dim' }, [
            h('span', { key: 'sep', className: 'fp-quick-sep' }, '·'),
            h('span', { key: 't' }, fpRelativeDay(nearestDue.dueAt, now)),
          ])
        : null,
    ]),
  ]);
}

/* ------------------------------ 设置页 ------------------------------ */

function FpSettingsPage() {
  const snap = useFp();
  const body = snap.state && snap.derived
    ? h(SettingsView, { state: snap.state, derived: snap.derived, compact: true })
    : h(FpEmptyState, {
        title: '正在读取 FlowPilot 数据',
        description: snap.error || '如果长时间没有数据，请确认插件宿主半已加载。',
        actions: h(FpButton, { variant: 'primary', onClick: () => fpRefresh() }, '重试'),
      });
  return h('div', { className: 'fp-settings-page' }, body);
}

/* ------------------------------ 样式 ------------------------------ */

const CSS_QUICK = String.raw`
/* 快捷浮层：用面层级替代描边（浅色：白卡片 + 浅灰嵌块；深色：抬起面 + 下沉面） */
.fp-quick{position:fixed;right:16px;bottom:16px;z-index:60;display:flex;flex-direction:column;align-items:flex-end;gap:8px;pointer-events:none;font-size:var(--fp-font-sm)}
.fp-quick>*{pointer-events:auto}
.fp-quick-quiet{opacity:.88}
.fp-quick-pill{display:inline-flex;align-items:center;gap:8px;height:36px;padding:0 12px;border:0;border-radius:var(--fp-radius-pill);background:var(--fp-surface);box-shadow:var(--fp-shadow-1);color:var(--fp-text);cursor:pointer;font:inherit;font-size:var(--fp-font-sm);appearance:none;-webkit-appearance:none;transition:background-color 140ms ease,box-shadow 140ms ease}
.fp-quick-pill:hover{background:var(--fp-surface);box-shadow:var(--fp-shadow-2)}
.fp-quick-pill-open{box-shadow:var(--fp-shadow-2)}
.fp-quick-pill-idle{color:var(--fp-text-dim)}
.fp-quick-pill-error{color:var(--fp-bad);background:color-mix(in srgb,var(--fp-bad) 10%,var(--fp-surface))}
.fp-quick-glyph{display:inline-flex;align-items:center;color:var(--fp-accent)}
.fp-quick-dot{width:8px;height:8px;border-radius:50%;background:currentColor;animation:fp-pulse 2.4s ease-in-out infinite}
.fp-quick-stat{display:inline-flex;align-items:center;gap:4px;color:var(--fp-text-dim);font-size:11px;white-space:nowrap}
.fp-quick-stat-hot{color:var(--fp-accent-strong);font-weight:650;font-variant-numeric:tabular-nums}
.fp-quick-stat-zero{color:var(--fp-text-tertiary);font-variant-numeric:tabular-nums}
.fp-quick-stat-dim{opacity:.9}
.fp-quick-sep{opacity:.4}
.fp-quick-card{width:352px;max-height:min(560px,72vh);display:flex;flex-direction:column;border-radius:var(--fp-radius-xl);background:var(--fp-overlay);box-shadow:var(--fp-shadow-3);overflow:hidden}
.fp-quick-head{display:flex;align-items:flex-start;justify-content:space-between;gap:8px;padding:12px 16px 8px}
.fp-quick-title{display:flex;align-items:center;gap:8px;flex-wrap:wrap;min-width:0}
.fp-quick-name{font-size:var(--fp-font-md);font-weight:680;letter-spacing:.01em}
.fp-quick-period{font-size:11px;color:var(--fp-accent-strong);background:color-mix(in srgb,var(--fp-accent) 10%,transparent);padding:0 8px;border-radius:var(--fp-radius-pill);line-height:20px}
.fp-quick-silent{font-size:11px;color:var(--fp-text-tertiary);background:var(--fp-surface-2);padding:0 8px;border-radius:var(--fp-radius-pill);line-height:20px}
.fp-quick-close{width:24px;height:24px;flex:none;border:none;background:transparent;color:var(--fp-text-tertiary);border-radius:var(--fp-radius-md);cursor:pointer;font-size:16px;line-height:1;padding:0}
.fp-quick-close:hover{background:var(--fp-hover);color:var(--fp-text)}
.fp-quick-prompt{margin:0 16px 8px;padding:8px 12px;border-radius:var(--fp-radius-md);background:var(--fp-surface-2);display:flex;flex-direction:column;gap:4px;font-size:var(--fp-font-sm)}
.fp-quick-prompt strong{font-weight:640;font-size:12px;color:var(--fp-text)}
.fp-quick-body{padding:4px 8px 8px;display:flex;flex-direction:column;gap:4px}
.fp-quick-sec{display:flex;flex-direction:column;gap:4px;padding:4px 0}
.fp-quick-sec-label{font-size:11px;letter-spacing:.06em;color:var(--fp-text-tertiary);padding:4px 8px}
.fp-quick-empty{padding:8px;color:var(--fp-text-tertiary);font-size:12px}
.fp-quick-row{display:flex;align-items:center;gap:8px;padding:8px;border-radius:var(--fp-radius-md);background:transparent;transition:background-color 140ms ease}
.fp-quick-row:hover{background:var(--fp-hover)}
.fp-quick-row-main{display:flex;flex-direction:column;gap:4px;min-width:0;flex:1 1 auto}
.fp-quick-row-title{display:flex;align-items:center;gap:8px;font-size:12px;min-width:0}
.fp-quick-row-meta{display:flex;align-items:center;gap:8px;font-size:11px;color:var(--fp-text-tertiary);min-width:0}
.fp-quick-code{font-family:var(--fp-mono);font-size:10px;letter-spacing:.03em;color:var(--fp-text-dim);background:var(--fp-surface-2);border-radius:var(--fp-radius-sm);padding:0 4px;flex:none;line-height:16px}
.fp-quick-due{color:var(--fp-warn-strong);white-space:nowrap}
.fp-quick-follow{color:var(--fp-text-tertiary);white-space:nowrap}
.fp-quick-row-actions{display:flex;align-items:center;gap:4px;flex:none}
.fp-quick-mini{height:24px;padding:0 8px;border-radius:var(--fp-radius-md);border:none;background:var(--fp-surface-2);color:var(--fp-text-dim);cursor:pointer;font-size:11px;white-space:nowrap;transition:background-color 140ms ease,color 140ms ease}
.fp-quick-mini:hover:not(:disabled){background:var(--fp-hover);color:var(--fp-text)}
.fp-quick-mini-primary{color:#ffffff;color:light-dark(#ffffff,#0d0e10);background:#0d0e10;background:light-dark(#0d0e10,#f0f1f2)}
.fp-quick-mini-primary:hover:not(:disabled){background:#17181a;background:light-dark(#17181a,#e3e5e7);color:#ffffff;color:light-dark(#ffffff,#0d0e10)}
.fp-quick-mini:disabled{opacity:.5;cursor:default}
.fp-quick-follow-row{display:flex;align-items:center;gap:8px;padding:8px;background:transparent;border-radius:var(--fp-radius-md);cursor:pointer;text-align:left;font-size:12px;min-width:0;border:none}
.fp-quick-follow-row:hover{background:var(--fp-hover)}
.fp-quick-when{margin-left:auto;color:var(--fp-text-tertiary);font-size:11px;white-space:nowrap}
.fp-quick-due-row{display:flex;align-items:center;gap:8px;padding:4px 8px 8px;font-size:12px;color:var(--fp-text-dim)}
.fp-quick-foot{display:flex;align-items:center;gap:4px;padding:8px 12px;background:var(--fp-surface-2)}
.fp-quick-cta{height:28px;padding:0 12px;border-radius:var(--fp-radius-md);border:none;background:#0d0e10;background:light-dark(#0d0e10,#f0f1f2);color:#ffffff;color:light-dark(#ffffff,#0d0e10);font-size:12px;cursor:pointer;transition:background-color 140ms ease}
.fp-quick-cta:hover{background:#17181a;background:light-dark(#17181a,#e3e5e7)}
.fp-quick-ghost{height:28px;padding:0 8px;border-radius:var(--fp-radius-md);border:none;background:transparent;color:var(--fp-text-dim);font-size:12px;cursor:pointer}
.fp-quick-ghost:hover{background:var(--fp-hover);color:var(--fp-text)}
.fp-settings-page{padding:0}

/* ---- 深色实心控件文字色兜底（本文件最后聚合，防止宿主或更高优先级规则把文字刷成深色）---- */
.fp-btn--primary,
.fp-btn--primary .fp-btn__label,
.fp-btn--primary .fp-btn__icon {
  color: #ffffff !important;
  color: light-dark(#ffffff, #0d0e10) !important;
}
.fp-btn--primary:hover:not(:disabled),
.fp-btn--primary:hover:not(:disabled) .fp-btn__label {
  color: #ffffff !important;
  color: light-dark(#ffffff, #0d0e10) !important;
}
.fp-btn--primary {
  background: #0d0e10 !important;
  background: light-dark(#0d0e10, #f0f1f2) !important;
}
.fp-btn--primary:hover:not(:disabled) {
  background: #17181a !important;
  background: light-dark(#17181a, #e3e5e7) !important;
}
.fp-quick-cta,
.fp-quick-mini-primary {
  color: #ffffff !important;
  color: light-dark(#ffffff, #0d0e10) !important;
}

/* ---- 顶栏入口 chip（工作台未打开时显示） ---- */
.fp-headchip {
  display: inline-flex;
  align-items: center;
  gap: var(--fp-sp-1);
  height: 28px;
  padding: 0 var(--fp-sp-2);
  border: 0;
  border-radius: var(--fp-radius-pill);
  background: var(--fp-surface-2);
  color: var(--fp-text-dim);
  font: inherit;
  font-size: var(--fp-font-sm);
  white-space: nowrap;
  cursor: pointer;
  transition: background-color 140ms ease, color 140ms ease;
}
.fp-headchip:hover {
  background: var(--fp-pressed);
  color: var(--fp-text);
}
.fp-headchip__mark {
  display: inline-flex;
  align-items: center;
  color: var(--fp-accent);
}
.fp-headchip__name {
  font-weight: 600;
}
.fp-headchip__count {
  display: inline-flex;
  align-items: center;
  height: 20px;
  padding: 0 var(--fp-sp-1);
  border-radius: var(--fp-radius-pill);
  font-size: 10.5px;
  font-variant-numeric: tabular-nums;
}
.fp-headchip__count[data-tone="brand"] {
  background: color-mix(in srgb, var(--fp-accent) 14%, transparent);
  color: var(--fp-accent-strong);
}
.fp-headchip__count[data-tone="warn"] {
  background: color-mix(in srgb, var(--fp-warn) 16%, transparent);
  color: var(--fp-warn-strong);
}

/* ---- 顶栏入口 + 快捷面板（从旧版右下角浮层移植，改为顶栏向下展开） ---- */
.fp-headchip-wrap {
  position: relative;
  display: inline-flex;
  min-width: 0;
}
.fp-headchip--open {
  background: var(--fp-pressed);
  color: var(--fp-text);
}
.fp-qpanel {
  z-index: 9999;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  border-radius: var(--fp-radius-lg);
  background: var(--fp-surface);
  box-shadow: var(--fp-shadow-3);
  animation: fp-qpanel-in 140ms ease;
}
@keyframes fp-qpanel-in {
  from { opacity: 0; transform: translateY(-4px); }
  to { opacity: 1; transform: none; }
}
.fp-qpanel-card {
  display: flex;
  flex-direction: column;
  min-height: 0;
  max-height: inherit;
}
.fp-qpanel-head {
  display: flex;
  align-items: center;
  gap: var(--fp-sp-2);
  flex: none;
  padding: var(--fp-sp-3) var(--fp-sp-2) 0 var(--fp-sp-4);
}
.fp-qpanel-title {
  display: flex;
  align-items: center;
  gap: var(--fp-sp-2);
  min-width: 0;
  flex: 1 1 auto;
}
.fp-qpanel-name {
  font-size: var(--fp-font-md);
  font-weight: 650;
  line-height: 1.2;
  color: var(--fp-text);
}
.fp-qpanel-period {
  padding: 0 var(--fp-sp-1);
  height: 20px;
  line-height: 1;
  display: inline-flex;
  align-items: center;
  border-radius: var(--fp-radius-pill);
  background: color-mix(in srgb, var(--fp-accent) 12%, transparent);
  color: var(--fp-accent-strong);
  font-size: 10.5px;
  white-space: nowrap;
}
.fp-qpanel-close {
  flex: none;
  width: 24px;
  height: 24px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: 0;
  border-radius: var(--fp-radius-sm);
  background: transparent;
  color: var(--fp-text-tertiary);
  cursor: pointer;
}
.fp-qpanel-close:hover {
  background: var(--fp-hover);
  color: var(--fp-text);
}
.fp-qpanel-stats {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: var(--fp-sp-1);
  flex: none;
  padding: var(--fp-sp-2) var(--fp-sp-3) 0;
}
.fp-qpanel-stat {
  display: flex;
  align-items: center;          /* 之前是 baseline：文字会顶在胶囊上沿，显不出居中 */
  justify-content: center;
  gap: var(--fp-sp-1);
  height: 40px;
  border: 0;
  border-radius: var(--fp-radius-md);
  background: var(--fp-surface-2);
  color: var(--fp-text-dim);
  font: inherit;
  font-size: var(--fp-font-xs);
  cursor: pointer;
  transition: background-color 140ms ease, color 140ms ease;
}
.fp-qpanel-stat:hover {
  background: var(--fp-pressed);
  color: var(--fp-text);
}
.fp-qpanel-stat-num {
  font-size: var(--fp-font-md);
  line-height: 1;               /* 数字与标签各自 line-height 不同会让整体重心偏上 */
  font-variant-numeric: tabular-nums;
  color: var(--fp-text);
}
.fp-qpanel-stat-label {
  line-height: 1;
}
.fp-qpanel-stat[data-tone="error"] .fp-qpanel-stat-num {
  color: var(--fp-bad);
}
.fp-qpanel-prompt {
  display: flex;
  flex-direction: column;
  gap: var(--fp-sp-1);
  margin: var(--fp-sp-2) var(--fp-sp-3) 0;
  padding: var(--fp-sp-2) var(--fp-sp-3);
  border-radius: var(--fp-radius-md);
  background: color-mix(in srgb, var(--fp-accent) 8%, var(--fp-surface-2));
  color: var(--fp-text-dim);
  font-size: var(--fp-font-xs);
}
.fp-qpanel-prompt strong {
  font-size: var(--fp-font-sm);
  font-weight: 600;
  color: var(--fp-text);
}
.fp-qpanel-body {
  display: flex;
  flex-direction: column;
  gap: var(--fp-sp-2);
  flex: 1 1 auto;
  min-height: 0;
  overflow: auto;
  padding: var(--fp-sp-2) var(--fp-sp-3) var(--fp-sp-3);
}
.fp-qpanel-sec {
  display: flex;
  flex-direction: column;
  gap: var(--fp-sp-1);
}
.fp-qpanel-label {
  font-size: 10.5px;
  font-weight: 600;
  letter-spacing: 0.02em;
  color: var(--fp-text-tertiary);
}
.fp-qpanel-empty {
  padding: var(--fp-sp-2) 0;
  font-size: var(--fp-font-xs);
  color: var(--fp-text-tertiary);
}
.fp-qpanel-row {
  display: flex;
  align-items: center;
  gap: var(--fp-sp-2);
  width: 100%;
  min-width: 0;
  padding: var(--fp-sp-2);
  border: 0;
  border-radius: var(--fp-radius-md);
  background: var(--fp-surface-2);
  color: var(--fp-text-dim);
  font: inherit;
  font-size: var(--fp-font-xs);
  text-align: left;
  cursor: pointer;
}
.fp-qpanel-row:hover {
  background: var(--fp-pressed);
  color: var(--fp-text);
}
.fp-qpanel-when {
  margin-left: auto;
  flex: none;
  font-size: 10.5px;
  color: var(--fp-text-tertiary);
  font-variant-numeric: tabular-nums;
}
.fp-qpanel-foot {
  display: flex;
  align-items: center;
  gap: var(--fp-sp-1);
  flex: none;
  padding: var(--fp-sp-2) var(--fp-sp-3) var(--fp-sp-3);
}
.fp-qpanel-cta {
  height: 30px;
  padding: 0 var(--fp-sp-3);
  border: 0;
  border-radius: var(--fp-radius-md);
  background: var(--fp-accent);
  color: var(--fp-on-brand);
  font: inherit;
  font-size: var(--fp-font-xs);
  font-weight: 600;
  cursor: pointer;
}
.fp-qpanel-cta:hover {
  background: var(--fp-accent-strong);
}
.fp-qpanel-ghost {
  height: 30px;
  padding: 0 var(--fp-sp-2);
  border: 0;
  border-radius: var(--fp-radius-md);
  background: transparent;
  color: var(--fp-text-dim);
  font: inherit;
  font-size: var(--fp-font-xs);
  cursor: pointer;
}
.fp-qpanel-ghost:hover {
  background: var(--fp-hover);
  color: var(--fp-text);
}
.fp-qpanel-ghost:disabled {
  opacity: .6;
  cursor: default;
}
`;
