/* ===== 归属：Lead · 槽位注册与客户端入口 =====
 * 注册四件事：
 *   1. main（key=flowpilot）       —— 三栏工作台主面板
 *   2. sidebar.panellist            —— 左侧栏入口（宿主点击时调用 layout.selectPanel('flowpilot')）
 *   3. shell.overlay                —— 右下角快捷浮层（PRD §5.4 的常驻菜单栏替代）
 *   4. settings.section             —— 设置页里的 FlowPilot 一节
 * 另外注册 locale 词典并注入样式表。所有注册互相隔离，单点失败不影响其它入口。
 */

const FP_CLIENT_INJECT = ['slots'];

/* 词典：组件用 FP_T('key', '中文兜底') 读取；locale 服务缺失时自动退回中文。 */
const FP_LOCALE_ZH = {
  'view.flow': '流程',
  'view.today': '今日',
  'view.weekly': '周报',
  'view.handoff': '交接',
  'view.settings': '设置',
  'common.retry': '重试',
  'common.refresh': '刷新',
  'common.cancel': '取消',
  'common.save': '保存',
  'common.close': '关闭',
  'common.create': '创建',
  'common.edit': '编辑',
  'common.delete': '删除',
  'common.confirm': '确认',
  'common.loading': '读取中…',
  'common.empty': '暂无数据',
  'common.all': '全部',
  'quick.open': '打开驾驶舱',
  'quick.handoff': '日终交接',
  'quick.actionable': '可推进',
  'quick.following': '待跟进',
  'quick.now': '现在可推进',
  'quick.waiting': '等待跟进',
  'quick.upcoming': '最近截止',
  'today.title': '今日工作',
  'today.recommended': '推荐处理',
  'today.followUps': '等待跟进',
  'today.upcoming': '近期截止',
  'today.context': '上次留下的上下文',
  'weekly.title': '本周工作',
  'weekly.generate': '生成草稿',
  'weekly.regenerate': '重新生成',
  'weekly.copy': '复制 Markdown',
  'weekly.concise': '简洁',
  'weekly.detailed': '详细',
  'handoff.title': '日终交接',
  'handoff.nextActions': '下一步动作',
  'handoff.notes': '备注',
  'flow.noProject': '选择左侧项目查看流程',
  'flow.addFlow': '添加验收流程',
  'node.start': '开始',
  'node.complete': '完成',
  'node.wait': '等待',
  'node.block': '阻塞',
  'node.skip': '跳过',
  'node.reopen': '重新打开',
  'node.detail': '节点详情',
  'node.links': '关联链接',
  'node.notes': '备注',
  'node.timeline': '事件时间线',
  'settings.title': 'FlowPilot 设置',
  'settings.workSlots': '工作时段',
  'settings.rhythm': '节奏与提醒',
  'settings.data': '数据与备份',
};

const FP_LOCALE_EN = {
  'view.flow': 'Flow',
  'view.today': 'Today',
  'view.weekly': 'Weekly',
  'view.handoff': 'Handoff',
  'view.settings': 'Settings',
  'common.retry': 'Retry',
  'common.refresh': 'Refresh',
  'common.cancel': 'Cancel',
  'common.save': 'Save',
  'common.close': 'Close',
  'common.create': 'Create',
  'common.edit': 'Edit',
  'common.delete': 'Delete',
  'common.confirm': 'Confirm',
  'common.loading': 'Loading…',
  'common.empty': 'Nothing here',
  'common.all': 'All',
  'quick.open': 'Open cockpit',
  'quick.handoff': 'Evening handoff',
  'quick.actionable': 'actionable',
  'quick.following': 'follow-ups',
  'quick.now': 'Ready now',
  'quick.waiting': 'Waiting on others',
  'quick.upcoming': 'Nearest due',
  'today.title': 'Today',
  'today.recommended': 'Recommended',
  'today.followUps': 'Follow-ups',
  'today.upcoming': 'Upcoming',
  'today.context': 'Last context',
  'weekly.title': 'This week',
  'weekly.generate': 'Generate draft',
  'weekly.regenerate': 'Regenerate',
  'weekly.copy': 'Copy markdown',
  'weekly.concise': 'Concise',
  'weekly.detailed': 'Detailed',
  'handoff.title': 'Evening handoff',
  'handoff.nextActions': 'Next actions',
  'handoff.notes': 'Notes',
  'flow.noProject': 'Pick a project to see its flow',
  'flow.addFlow': 'Add acceptance flow',
  'node.start': 'Start',
  'node.complete': 'Complete',
  'node.wait': 'Wait',
  'node.block': 'Block',
  'node.skip': 'Skip',
  'node.reopen': 'Reopen',
  'node.detail': 'Node detail',
  'node.links': 'Links',
  'node.notes': 'Notes',
  'node.timeline': 'Timeline',
  'settings.title': 'FlowPilot settings',
  'settings.workSlots': 'Work slots',
  'settings.rhythm': 'Rhythm',
  'settings.data': 'Data & backup',
};

/* ------------------------------ 小工具 ------------------------------ */

function fpService(ctx, key) {
  try {
    const direct = ctx[key];
    if (direct !== undefined && direct !== null) return direct;
  } catch (error) {
    /* 未注入的服务读取会抛错，落到 ctx.get */
  }
  try {
    if (typeof ctx.get === 'function') {
      const fetched = ctx.get(key);
      if (fetched !== undefined && fetched !== null) return fetched;
    }
  } catch (error) {
    /* ignore */
  }
  return null;
}

function fpRegisterLocale(ctx) {
  const locale = fpService(ctx, 'locale');
  if (!locale || typeof locale.register !== 'function') return;
  const disposers = [];
  try {
    const disposeZh = locale.register('flowpilot', 'zh', FP_LOCALE_ZH);
    if (typeof disposeZh === 'function') disposers.push(disposeZh);
  } catch (error) {
    /* 词典注册失败不影响功能 */
  }
  try {
    const disposeEn = locale.register('flowpilot', 'en', FP_LOCALE_EN);
    if (typeof disposeEn === 'function') disposers.push(disposeEn);
  } catch (error) {
    /* ignore */
  }
  try {
    if (typeof locale.bind === 'function') {
      const bound = locale.bind('flowpilot');
      if (typeof bound === 'function') FP_UI.t = (key, vars) => bound(key, vars);
    }
  } catch (error) {
    /* ignore */
  }
  try {
    if (typeof locale.getLocale === 'function') {
      const snap = locale.getLocale();
      if (snap && typeof snap.id === 'string') FP_UI.locale = snap.id;
    }
  } catch (error) {
    /* ignore */
  }
  if (disposers.length > 0) {
    try {
      ctx.effect(() => () => {
        disposers.forEach((dispose) => {
          try {
            dispose();
          } catch (error) {
            /* ignore */
          }
        });
      }, 'flowpilot: locale');
    } catch (error) {
      /* effect 不可用时词典常驻，无害 */
    }
  }
}

function fpInjectStyles(ctx) {
  const install = () => {
    const element = document.createElement('style');
    element.setAttribute('data-plugin-css', 'flowpilot');
    element.textContent = fpStyleSheet();
    document.head.appendChild(element);
    return () => {
      try {
        element.remove();
      } catch (error) {
        /* ignore */
      }
    };
  };
  try {
    ctx.effect(install, 'flowpilot: styles');
  } catch (error) {
    try {
      install();
    } catch (ignored) {
      /* 无 document 时静默 */
    }
  }
}

function fpRegisterSlots(ctx) {
  const slots = fpService(ctx, 'slots');
  if (!slots || typeof slots.inject !== 'function' || typeof slots.register !== 'function') {
    try {
      console.warn('[flowpilot] 未找到 slots 服务，客户端 UI 未注册');
    } catch (error) {
      /* ignore */
    }
    return;
  }

  const safe = (label, fn) => {
    try {
      fn();
    } catch (error) {
      try {
        console.warn('[flowpilot] 槽位注册失败（' + label + '）：', error);
      } catch (ignored) {
        /* ignore */
      }
    }
  };

  // 1) 主面板：key 与 sidebar.panellist 的 id 一致，宿主 selectPanel('flowpilot') 才能命中。
  safe('main', () => slots.inject('main', () => slots.register({ name: 'main', key: 'flowpilot' }, FpRoot)));

  // 2) 左侧栏面板入口
  safe('sidebar.panellist', () => slots.inject('sidebar.panellist', () => slots.register({
    name: 'sidebar.panellist',
    id: 'flowpilot',
    order: 90,
    label: 'FlowPilot',
  }, fpSidebarGlyph)));

  // 3) 顶栏入口：未打开工作台时显示（打开后组件自身返回 null）
  try {
    slots.inject('conversation.session.header.utilities', () => slots.register({
      name: 'conversation.session.header.utilities',
      id: 'flowpilot-quick',
      order: 40,
      label: 'FlowPilot',
    }, FpHeaderChip));
  } catch (error) {
    /* 宿主没有该插槽时退回右下角浮层，保证入口不丢 */
    safe('shell.overlay', () => slots.inject('shell.overlay', () => slots.register({
      name: 'shell.overlay',
      id: 'flowpilot-quick',
      order: 60,
    }, QuickDock)));
  }

  // 4) 设置页
  safe('settings.section', () => slots.inject('settings.section', () => slots.register({
    name: 'settings.section',
    id: 'flowpilot',
    order: 60,
    label: 'FlowPilot',
  }, FpSettingsPage)));
}

/* ------------------------------ 入口 ------------------------------ */

function FP_CLIENT_APPLY(ctx) {
  FP_CTX = ctx;
  /* 主题色：读取本机保存的色相并立即应用（只换色调，S/L 沿用令牌） */
  try {
    if (typeof fpApplyAccentHue === 'function' && typeof fpAccentHueRead === 'function') {
      fpApplyAccentHue(fpAccentHueRead(), false);
    }
  } catch (error) {
    /* 无 DOM 时静默 */
  }
  try {
    fpLayout();
  } catch (error) {
    /* ignore */
  }
  fpRegisterLocale(ctx);
  fpInjectStyles(ctx);
  fpRegisterSlots(ctx);
}
