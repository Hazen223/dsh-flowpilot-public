/* ===== 归属：update-ui · 版本检查与一键更新 =====
 * 两处 UI：
 *   1. 设置页「版本与更新」面板（FpUpdatePanel）：当前版本 / 最新 tag / 检查 / 一键更新 / 重启生效；
 *   2. 主面板顶栏更新提醒徽标（FpUpdateBadge）：发现新版本或待重启时出现，点击跳到设置页。
 * 自包含：自己请求 /flowpilot/api/update/*，不依赖 store；请求失败只就地报错。
 * 宿主契约见 docs/UPDATE.md。
 */

const FP_UPDATE_API = '/flowpilot/api/update';

function fpUpdateIsObj(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function fpUpdateStr(value, fallback) {
  if (typeof value === 'string' && value !== '') return value;
  return fallback === undefined ? '' : fallback;
}

function fpUpdateNormalizeStatus(raw) {
  if (!fpUpdateIsObj(raw)) return null;
  const errorSrc = fpUpdateIsObj(raw.error) ? raw.error : null;
  const buildSrc = fpUpdateIsObj(raw.build) ? raw.build : null;
  return {
    currentVersion: fpUpdateStr(raw.currentVersion),
    buildLabel: fpUpdateStr(raw.buildLabel) || fpUpdateStr(raw.currentVersion),
    build: buildSrc === null ? null : {
      sha: fpUpdateStr(buildSrc.sha),
      dirty: buildSrc.dirty === true,
      channel: fpUpdateStr(buildSrc.channel),
      builtAt: fpUpdateStr(buildSrc.builtAt),
    },
    latestVersion: fpUpdateStr(raw.latestVersion),
    updateAvailable: raw.updateAvailable === true,
    checkedAt: fpUpdateStr(raw.checkedAt),
    repo: fpUpdateStr(raw.repo),
    mode: raw.mode === 'profile' ? 'profile' : 'link',
    devBuild: raw.devBuild === true || raw.channel === 'dev',
    updateSuppressed: raw.updateSuppressed === true,
    canApply: raw.canApply === true,
    busy: fpUpdateStr(raw.busy),
    appliedVersion: fpUpdateStr(raw.appliedVersion),
    restartRequired: raw.restartRequired === true,
    error: errorSrc === null ? null : {
      code: fpUpdateStr(errorSrc.code),
      message: fpUpdateStr(errorSrc.message, '检查更新失败'),
    },
  };
}

function fpUpdateFmtWhen(value) {
  if (!value) return '';
  try {
    const text = fpFmtDateTime(value);
    return text === '—' ? '' : text;
  } catch (error) {
    return '';
  }
}

function fpUpdateVersion(value) {
  return value ? 'v' + value : '—';
}

function fpUpdateStateView(status, loading) {
  if (status === null) {
    return loading
      ? { tone: 'muted', label: '读取中…', hint: '' }
      : { tone: 'muted', label: '状态未知', hint: '点击「检查更新」读取远端版本。' };
  }
  if (status.devBuild) {
    return {
      tone: 'idle',
      label: '本地开发版',
      hint:
        '本地开发版 ' + (status.buildLabel || status.currentVersion) +
        '：不检查更新，改完代码 / git pull 后重启 DSH 即可生效。',
    };
  }
  if (status.restartRequired) {
    return {
      tone: 'warn',
      label: '已更新，待重启',
      hint: '新版本已安装，重启 DSH 后生效（点击下方「重启 DSH」）。',
    };
  }
  if (status.error !== null) {
    return { tone: 'error', label: '检查失败', hint: status.error.message };
  }
  if (status.updateAvailable) {
    return {
      tone: 'warn',
      label: '发现新版本 ' + fpUpdateVersion(status.latestVersion),
      hint: '点击「更新」重新安装最新版本，装完重启 DSH 生效。',
    };
  }
  if (status.latestVersion !== '') {
    return { tone: 'success', label: '已是最新', hint: '当前版本 ' + fpUpdateVersion(status.currentVersion) + '，无需更新。' };
  }
  return { tone: 'muted', label: '未检查', hint: '点击「检查更新」读取远端版本。' };
}

/* ------------------------------------------------------------------ */
/* 网络：统一 fetch 包装（永不 throw）                                  */
/* ------------------------------------------------------------------ */

async function fpUpdateRequest(path, body, signal) {
  const url = FP_UPDATE_API + path;
  if (typeof fetch !== 'function') {
    return { canceled: false, error: '当前环境不支持网络请求（宿主未就绪）', data: null, status: 0 };
  }
  const options = { method: body === undefined ? 'GET' : 'POST', headers: { accept: 'application/json' } };
  if (body !== undefined) {
    options.headers['content-type'] = 'application/json';
    options.body = JSON.stringify(body === null ? {} : body);
  }
  if (signal) options.signal = signal;
  try {
    const response = await fetch(url, options);
    const statusCode = response && typeof response.status === 'number' ? response.status : 0;
    let data = null;
    if (response && typeof response.json === 'function') {
      try {
        data = await response.json();
      } catch (error) {
        data = null;
      }
    }
    if (!fpUpdateIsObj(data)) {
      return { canceled: false, error: '宿主返回了无法识别的响应（HTTP ' + statusCode + '）', data: null, status: statusCode };
    }
    if ((response && response.ok === false) || data.ok === false) {
      return {
        canceled: false,
        error: fpUpdateStr(data.error, '更新请求失败（HTTP ' + statusCode + '）'),
        data: data,
        status: statusCode,
      };
    }
    return { canceled: false, error: null, data: data, status: statusCode };
  } catch (cause) {
    const canceled = !!(cause && (cause.name === 'AbortError' || cause.code === 'ABORT_ERR'));
    if (canceled) return { canceled: true, error: null, data: null, status: 0 };
    const message = cause && typeof cause.message === 'string' && cause.message !== '' ? cause.message : '未知错误';
    return { canceled: false, error: '网络请求失败：' + message, data: null, status: 0 };
  }
}

function fpUpdateNotify(tone, text) {
  try {
    if (typeof FpToast !== 'undefined' && FpToast && typeof FpToast.push === 'function') {
      FpToast.push({ tone: tone, text: text });
    }
  } catch (error) {
    /* toast 不可用不影响面板 */
  }
}

/* ------------------------------------------------------------------ */
/* 顶栏更新提醒徽标                                                     */
/* ------------------------------------------------------------------ */

function FpUpdateBadge(props) {
  const p = fpUpdateIsObj(props) ? props : {};
  const [status, setStatus] = React.useState(null);
  const mountedRef = React.useRef(true);

  React.useEffect(function () {
    mountedRef.current = true;
    const pending = fpUpdateRequest('/status', undefined, null);
    if (pending && typeof pending.then === 'function') {
      pending.then(function (result) {
        if (!mountedRef.current || result.canceled || result.error) return;
        const next = fpUpdateNormalizeStatus(result.data && result.data.status);
        if (next !== null) setStatus(next);
      }).catch(function () {
        /* 徽标读取失败保持隐藏 */
      });
    }
    return function () {
      mountedRef.current = false;
    };
  }, []);

  if (status === null) return null;
  // 本地开发版不显示任何更新提示（改代码重启即生效，避免被"可更新"打扰）
  if (status.devBuild === true) return null;
  const restart = status.restartRequired === true;
  const available = status.updateAvailable === true;
  if (!restart && !available) return null;
  const label = restart ? '重启生效' : '可更新 ' + fpUpdateVersion(status.latestVersion);
  const title = restart
    ? '新版本已安装，重启 DSH 后生效'
    : '发现新版本 ' + fpUpdateVersion(status.latestVersion) + '，点击查看并更新';
  return h(
    'button',
    {
      type: 'button',
      className: 'fp-update-badge',
      'data-tone': restart ? 'warn' : 'brand',
      title: title,
      onClick: typeof p.onOpen === 'function' ? p.onOpen : undefined,
    },
    h(FpIcon, { name: restart ? 'refresh' : 'download', size: 12 }),
    h('span', null, label),
  );
}

/* ------------------------------------------------------------------ */
/* 更新记录（changelog）                                               */
/* ------------------------------------------------------------------ */

const FP_UPDATE_SEEN_VERSION_KEY = 'flowpilot.update.seenVersion.v1';

function fpUpdateNormalizeChangelog(raw) {
  const list = raw && Array.isArray(raw.entries) ? raw.entries : Array.isArray(raw) ? raw : [];
  return list.map(function (entry) {
    const version = fpUpdateStr(entry && entry.version);
    if (version === '') return null;
    const items = Array.isArray(entry.items)
      ? entry.items.map(function (item) { return fpUpdateStr(item); }).filter(function (item) { return item !== ''; })
      : [];
    return { version: version, date: fpUpdateStr(entry.date), items: items };
  }).filter(function (entry) { return entry !== null; });
}

async function fpUpdateFetchChangelog() {
  try {
    const res = await fetch('/flowpilot/api/changelog', { cache: 'no-store' });
    const data = await res.json();
    return fpUpdateNormalizeChangelog(data);
  } catch (error) {
    return [];
  }
}

function fpUpdateMarkSeen(version) {
  try {
    if (typeof localStorage !== 'undefined' && version !== '') localStorage.setItem(FP_UPDATE_SEEN_VERSION_KEY, String(version));
  } catch (error) {
    /* 隐私模式忽略 */
  }
}

function FpUpdateChangelogDialog({ open, entries, highlightVersion, onClose }) {
  const list = Array.isArray(entries) ? entries : [];
  const highlight = fpUpdateStr(highlightVersion);
  if (open !== true) return null;
  return h(FpDialog, {
    open: true,
    title: '更新记录',
    description: highlight !== '' ? '当前版本 v' + highlight + ' 的更新内容与历史记录' : '历史更新记录',
    width: 560,
    onClose: onClose,
    actions: [h(FpButton, { key: 'ok', variant: 'primary', onClick: onClose }, '知道了')],
  },
  list.length === 0
    ? h('p', { className: 'fp-update-hint' }, '当前版本没有附带更新说明。')
    : h('div', { className: 'fp-update-log' }, list.map(function (entry) {
        const current = highlight !== '' && entry.version === highlight;
        return h('section', { key: entry.version, className: 'fp-update-log-entry' + (current ? ' fp-is-current' : '') },
          h('div', { className: 'fp-update-log-head' },
            h('span', { className: 'fp-update-log-version' }, 'v' + entry.version),
            entry.date !== '' ? h('span', { className: 'fp-update-log-date' }, entry.date) : null,
            current ? h(FpChip, { tone: 'brand' }, '当前') : null,
          ),
          entry.items.length > 0
            ? h('ul', { className: 'fp-update-log-items' }, entry.items.map(function (item, index) {
                return h('li', { key: index }, item);
              }))
            : h('p', { className: 'fp-update-hint' }, '（无详细说明）'),
        );
      })),
  );
}

/* 版本变化后自动弹一次「更新内容」（每台机器每个版本一次） */
function FpChangelogAuto() {
  const [entries, setEntries] = React.useState([]);
  const [open, setOpen] = React.useState(false);
  const [current, setCurrent] = React.useState('');

  React.useEffect(function () {
    let alive = true;
    (async function () {
      try {
        const statusRes = await fetch('/flowpilot/api/update/status', { cache: 'no-store' });
        const statusData = await statusRes.json();
        const status = statusData && statusData.status ? statusData.status : null;
        if (!status || status.devBuild === true) return;
        const version = fpUpdateStr(status.currentVersion);
        if (version === '') return;
        let seen = '';
        try {
          if (typeof localStorage !== 'undefined') seen = fpUpdateStr(localStorage.getItem(FP_UPDATE_SEEN_VERSION_KEY));
        } catch (error) {
          seen = '';
        }
        if (seen === version) return;
        const list = await fpUpdateFetchChangelog();
        if (!alive || list.length === 0) return;
        setEntries(list);
        setCurrent(version);
        setOpen(true);
      } catch (error) {
        /* 更新记录不可用不影响主功能 */
      }
    })();
    return function () { alive = false; };
  }, []);

  function close() {
    setOpen(false);
    fpUpdateMarkSeen(current);
  }
  if (!open) return null;
  return h(FpUpdateChangelogDialog, { open: true, entries: entries, highlightVersion: current, onClose: close });
}

/* ------------------------------------------------------------------ */
/* 设置页「版本与更新」面板                                             */
/* ------------------------------------------------------------------ */

function FpUpdatePanel(props) {
  const p = fpUpdateIsObj(props) ? props : {};
  const [status, setStatus] = React.useState(fpUpdateNormalizeStatus(p.initialStatus));
  const [loading, setLoading] = React.useState(status === null);
  const [busy, setBusy] = React.useState(null);
  const [error, setError] = React.useState('');
  const [restarting, setRestarting] = React.useState(false);
  const [changelogOpen, setChangelogOpen] = React.useState(false);
  const [changelogEntries, setChangelogEntries] = React.useState([]);
  const mountedRef = React.useRef(true);
  const busyRef = React.useRef(null);

  function alive() {
    return mountedRef.current === true;
  }

  function applyStatus(raw) {
    const next = fpUpdateNormalizeStatus(raw);
    if (next !== null) {
      setStatus(next);
      setLoading(false);
      return next;
    }
    return null;
  }

  async function loadStatus(signal) {
    const result = await fpUpdateRequest('/status', undefined, signal);
    if (!alive() || result.canceled) return;
    if (result.error) {
      setLoading(false);
      setError(result.error);
      return;
    }
    const next = fpUpdateNormalizeStatus(result.data && result.data.status);
    if (next === null) {
      setLoading(false);
      setError('宿主返回的更新状态无法识别');
      return;
    }
    setStatus(next);
    setLoading(false);
  }

  React.useEffect(function () {
    mountedRef.current = true;
    let controller = null;
    if (status === null) {
      controller = typeof AbortController === 'function' ? new AbortController() : null;
      const pending = loadStatus(controller ? controller.signal : null);
      if (pending && typeof pending.catch === 'function') {
        pending.catch(function () {
          /* 首次读取失败已就地展示错误 */
        });
      }
    }
    return function () {
      mountedRef.current = false;
      if (controller) {
        try {
          controller.abort();
        } catch (cause) {
          /* ignore */
        }
      }
    };
  }, []);

  async function runAction(kind, path, body, onSuccess) {
    if (busyRef.current !== null) return;
    busyRef.current = kind;
    setBusy(kind);
    setError('');
    try {
      const result = await fpUpdateRequest(path, body, null);
      if (!alive() || result.canceled) return;
      if (result.error) {
        setError(result.error);
        fpUpdateNotify('error', result.error);
        return;
      }
      if (typeof onSuccess === 'function') onSuccess(result.data);
    } catch (cause) {
      if (alive()) {
        const message = '操作失败：' + (cause && cause.message ? cause.message : '未知错误');
        setError(message);
        fpUpdateNotify('error', message);
      }
    } finally {
      busyRef.current = null;
      if (alive()) setBusy(null);
    }
  }

  function handleCheck() {
    runAction('check', '/check', {}, function (data) {
      const next = applyStatus(data && data.status);
      if (next === null) return;
      fpUpdateNotify(
        'success',
        next.updateAvailable
          ? '发现新版本 ' + fpUpdateVersion(next.latestVersion)
          : '已是最新版本',
      );
    });
  }

  function handleApply() {
    runAction('apply', '/apply', {}, function (data) {
      const next = applyStatus(data && data.status);
      if (next === null) return;
      fpUpdateNotify('success', '已更新到 ' + fpUpdateVersion(next.appliedVersion || next.latestVersion) + '，重启 DSH 后生效');
    });
  }

  async function openChangelog() {
    setChangelogOpen(true);
    try {
      const list = await fpUpdateFetchChangelog();
      if (alive()) setChangelogEntries(list);
    } catch (error) {
      if (alive()) setChangelogEntries([]);
    }
  }

  function handleRestart() {
    runAction('restart', '/restart', {}, function () {
      setRestarting(true);
      fpUpdateNotify('info', 'DSH 正在重启，页面稍后刷新即可');
    });
  }

  const view = fpUpdateStateView(status, loading);
  const chips = [];
  const devBuild = status !== null && status.devBuild === true;
  if (status !== null) {
    chips.push(
      h(FpChip, { key: 'mode', tone: devBuild ? 'idle' : status.mode === 'profile' ? 'brand' : 'idle' },
        devBuild ? '本地开发版' : status.mode === 'profile' ? 'git 安装' : '开发模式 link'),
    );
    chips.push(
      h(
        'button',
        {
          key: 'current',
          type: 'button',
          className: 'fp-update-version-btn',
          title: (status.build && status.build.sha ? '构建提交 ' + status.build.sha + '；' : '') + '点击查看更新记录',
          onClick: openChangelog,
        },
        '当前 ' + (status.buildLabel || fpUpdateVersion(status.currentVersion)),
      ),
    );
    if (!devBuild && status.latestVersion !== '' && status.latestVersion !== status.currentVersion) {
      chips.push(h(FpChip, { key: 'latest', tone: status.updateAvailable ? 'warn' : 'success' }, '最新 ' + fpUpdateVersion(status.latestVersion)));
    }
    if (status.restartRequired) chips.push(h(FpChip, { key: 'restart', tone: 'amber' }, '待重启生效'));
  }
  chips.push(h(FpChip, { key: 'state', tone: view.tone, dot: true }, view.label));

  const checkedText = status !== null && status.checkedAt !== '' ? fpUpdateFmtWhen(status.checkedAt) : '';
  const statusChildren = [
    h('div', { key: 'chips', className: 'fp-update-chips' }, chips),
  ];
  if (loading && status === null) {
    statusChildren.push(h('div', { key: 'loading', className: 'fp-update-line' }, h(FpSpinner, { label: '正在读取版本状态…' })));
  }
  if (checkedText !== '') {
    statusChildren.push(h('div', { key: 'checked', className: 'fp-update-line' }, '最近检查：' + checkedText));
  }
  if (status !== null && status.repo !== '') {
    statusChildren.push(
      h('div', { key: 'repo', className: 'fp-update-line fp-update-repo', title: status.repo }, '仓库：' + status.repo),
    );
  }
  if (view.hint !== '' && !(loading && status === null)) {
    statusChildren.push(h('div', { key: 'hint', className: 'fp-update-hint' }, view.hint));
  }

  const canApply = status !== null && status.canApply === true;
  const hasUpdate = status !== null && status.updateAvailable === true;
  const needsRestart = status !== null && status.restartRequired === true;
  const applyHint = devBuild
    ? '当前是本地开发版（源码直连）：不检查、不提示更新；改完代码后重启 DSH 即生效。'
    : canApply
      ? '点击「更新」会用 DSH 自带的 pnpm 重新安装远端最新 tag（等价插件页「移除 + 重装」），装完点「重启 DSH」生效；不会改动项目数据。'
      : '当前是开发模式（link 安装）：只检查远端版本，不会自动重装。更新请在本机 git pull 后重启 DSH；git 安装的机器可直接用「更新」。';

  const children = [
    h('div', { key: 'status', className: 'fp-update-status' }, statusChildren),
  ];
  if (error !== '') {
    children.push(
      h('div', { key: 'error', className: 'fp-update-error', role: 'alert' },
        h(FpIcon, { name: 'alert', size: 13 }),
        h('span', null, error),
      ),
    );
  }
  children.push(
    h('div', { key: 'hint2', className: 'fp-update-hint' }, applyHint),
  );
  children.push(
    h('div', { key: 'actions', className: 'fp-update-actions' },
      devBuild
        ? null
        : fpvBtn('check', busy === 'check' ? '检查中…' : '检查更新', handleCheck, {
            disabled: !!busy,
            title: '读取远端 tag（走本机 git 凭据）',
          }),
      devBuild
        ? null
        : fpvBtn('apply', busy === 'apply' ? '更新中…' : (hasUpdate ? '更新到 ' + fpUpdateVersion(status.latestVersion) : '更新'), handleApply, {
            variant: 'primary',
            disabled: !!busy || !canApply || !hasUpdate,
            title: canApply ? '重新安装远端最新版本' : '开发模式安装，不能自动更新',
          }),
      needsRestart
        ? fpvBtn('restart', restarting ? '重启中…' : '重启 DSH', handleRestart, {
            variant: 'primary',
            disabled: !!busy || restarting,
            title: '退出并重新打开 DSH NEXT，使新版本生效',
          })
        : null,
    ),
  );
  if (restarting) {
    children.push(
      h('div', { key: 'restarting', className: 'fp-update-hint' }, 'DSH 正在重启，约 3 秒后重新打开，刷新页面即可继续。'),
    );
  }
  children.push(
    h('p', { key: 'note', className: 'fp-update-note' },
      h(FpIcon, { name: 'flag', size: 12 }),
      h('span', null, '公共仓库通过本机 git 凭据（HTTPS）访问；更新只重装插件代码，不触碰 ~/.dsh/flowpilot/data.json，也不会上传任何数据。'),
    ),
  );

  return fpvSettingsGroup(
    '版本与更新',
    '检查 GitHub 发布 tag，一键更新并重启生效',
    h('div', { className: 'fp-update' }, children),
    changelogOpen
      ? h(FpUpdateChangelogDialog, {
          open: true,
          entries: changelogEntries,
          highlightVersion: status !== null ? fpUpdateStr(status.currentVersion) : '',
          onClose: function () { setChangelogOpen(false); },
        })
      : null,
  );
}

/* ------------------------------------------------------------------ */
/* 样式：面层级 + 设计系统 语义色，无描边；4 栅格间距                        */
/* ------------------------------------------------------------------ */

const CSS_UPDATE = String.raw`
/* ===== 版本与更新 · 面层级 + 设计系统 语义色，无描边 ===== */
.fp-update{
  display:flex;
  flex-direction:column;
  gap:12px;
  min-width:0;
  color:var(--fp-text);
}
.fp-update-status{
  display:flex;
  flex-direction:column;
  gap:8px;
  padding:12px;
  border-radius:var(--fp-radius-md);
  background:var(--fp-surface-2);
}
.fp-update-chips{display:flex;align-items:center;gap:8px;flex-wrap:wrap;}
.fp-update-line{font-size:var(--fp-font-xs);line-height:1.5;color:var(--fp-text-dim);overflow-wrap:anywhere;}
.fp-update-repo{font-family:var(--fp-mono, ui-monospace, SFMono-Regular, Menlo, monospace);color:var(--fp-text-tertiary);overflow-wrap:anywhere;word-break:break-word;}
.fp-update-hint{padding:0 4px;font-size:var(--fp-font-xs);line-height:1.55;color:var(--fp-text-tertiary);overflow-wrap:anywhere;}
.fp-update-error{
  display:flex;
  align-items:flex-start;
  gap:8px;
  padding:8px 12px;
  border-radius:var(--fp-radius-md);
  background:color-mix(in srgb, var(--fp-bad) 12%, transparent);
  color:var(--fp-bad);
  font-size:var(--fp-font-sm);
  line-height:1.5;
  overflow-wrap:anywhere;
}
.fp-update-error svg{flex:0 0 auto;margin-top:4px;}
.fp-update-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding-top:4px;}
.fp-update-note{
  margin:0;
  padding-top:4px;
  display:flex;
  align-items:flex-start;
  gap:8px;
  font-size:var(--fp-font-xs);
  line-height:1.55;
  color:var(--fp-text-tertiary);
  overflow-wrap:anywhere;
}
.fp-update-note svg{flex:0 0 auto;margin-top:4px;}
/* 顶栏更新提示：与同步/设置 icon 按钮同为 28px 药丸面，无描边（原生按钮边框会显示成"双圈"，必须清掉） */
.fp-update-badge{
  display:inline-flex;
  align-items:center;
  gap:var(--fp-sp-1);
  height:28px;
  padding:0 var(--fp-sp-2);
  border:0;
  border-radius:var(--fp-radius-pill);
  background:var(--fp-surface-2);
  color:var(--fp-text-dim);
  font:inherit;
  font-size:var(--fp-font-xs);
  line-height:1;
  white-space:nowrap;
  cursor:pointer;
  appearance:none;
  -webkit-appearance:none;
  transition:background-color 140ms ease, color 140ms ease;
}
.fp-update-badge svg{flex:0 0 auto;}
.fp-update-badge[data-tone="brand"]{
  background:color-mix(in srgb, var(--fp-accent) 14%, transparent);
  color:var(--fp-accent-strong);
}
.fp-update-badge:hover{background:var(--fp-pressed);color:var(--fp-text);}
.fp-update-badge[data-tone="brand"]:hover{background:color-mix(in srgb, var(--fp-accent) 22%, transparent);}
.fp-update-badge[data-tone="warn"]{
  background:color-mix(in srgb, var(--fp-warn) 16%, transparent);
  color:var(--fp-warn-strong);
}
.fp-update-badge[data-tone="warn"]:hover{background:color-mix(in srgb, var(--fp-warn) 24%, transparent);}
.fp-update-badge:focus-visible{
  outline:none;
  box-shadow:0 0 0 2px color-mix(in srgb, var(--fp-accent) 45%, transparent);
}

/* ===== 更新记录 ===== */
.fp-update-version-btn{
  display:inline-flex;align-items:center;height:28px;padding:0 12px;
  border:0;border-radius:var(--fp-radius-pill);
  background:var(--fp-surface-2);color:var(--fp-text-dim);
  font:inherit;font-size:var(--fp-font-sm);cursor:pointer;appearance:none;-webkit-appearance:none;
  transition:background-color 140ms ease,color 140ms ease;
}
.fp-update-version-btn:hover{background:var(--fp-pressed);color:var(--fp-text);}
.fp-update-log{display:flex;flex-direction:column;gap:var(--fp-sp-3);max-height:52vh;overflow:auto;padding-right:var(--fp-sp-1);}
.fp-update-log-entry{display:flex;flex-direction:column;gap:var(--fp-sp-2);padding:var(--fp-sp-3);border-radius:var(--fp-radius-md);background:var(--fp-surface-2);}
.fp-update-log-entry.fp-is-current{background:color-mix(in srgb,var(--fp-accent) 10%,var(--fp-surface-2));}
.fp-update-log-head{display:flex;align-items:baseline;gap:var(--fp-sp-2);min-width:0;flex-wrap:wrap;}
.fp-update-log-version{font-size:var(--fp-font-md);font-weight:650;color:var(--fp-text);}
.fp-update-log-date{font-size:var(--fp-font-xs);color:var(--fp-text-tertiary);}
.fp-update-log-items{margin:0;padding-left:20px;display:flex;flex-direction:column;gap:4px;font-size:var(--fp-font-md);color:var(--fp-text-dim);line-height:1.6;}
.fp-update-log-items li{overflow-wrap:anywhere;}
`;
