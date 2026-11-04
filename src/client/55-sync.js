/* ===== 归属：sync-ui · 设置页同步面板（GitHub / WebDAV） =====
 * 自包含面板：自己请求 /flowpilot/api/sync/status，自己调用
 * config / test / run / push / pull 五条路由；不读写全局 store、不修改数据。
 *
 * 契约：docs/SYNC.md §2（路由与 status/conflict 形状）、§5（客户端要求）。
 * 挂载：SettingsView 内以 h(FpSyncPanel, {}) 使用；props 缺失也必须能渲染。
 * 可选测试入口（离线冒烟 tests/client-smoke.mjs 使用，正常运行不传）：
 *   initialStatus / initialConflict / initialError —— 直接当作已加载状态/冲突/错误。
 * 离线冒烟里 hooks 是替身、useEffect 不执行，因此首个 fetch 会跳过。
 */

const FP_SYNC_API = '/flowpilot/api/sync';

const FP_SYNC_PROVIDER_OPTIONS = [
  { value: 'off', label: '关闭' },
  { value: 'github', label: 'GitHub' },
  { value: 'webdav', label: 'WebDAV' },
];

/* ------------------------------------------------------------------ */
/* 小工具（全部纯函数、防御式取值，任何字段缺失都不抛错）              */
/* ------------------------------------------------------------------ */

function fpSyncIsObj(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function fpSyncTrim(value) {
  return typeof value === 'string' ? value.replace(/^\s+|\s+$/g, '') : '';
}

function fpSyncStr(value, fallback) {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' && isFinite(value)) return String(value);
  return fallback;
}

function fpSyncNullableStr(value) {
  const text = fpSyncStr(value, '');
  return text === '' ? null : text;
}

function fpSyncInt(value, fallback) {
  if (typeof value === 'number' && isFinite(value)) return Math.trunc(value);
  if (typeof value === 'string' && /^-?\d+$/.test(value)) return Math.trunc(Number(value));
  return fallback;
}

function fpSyncClone(value) {
  try {
    return JSON.parse(JSON.stringify(value));
  } catch (error) {
    return fpSyncBlankDraft();
  }
}

function fpSyncT(key, fallback) {
  if (typeof FP_T === 'function') {
    try {
      const text = FP_T(key, fallback);
      if (typeof text === 'string' && text !== '') return text;
    } catch (error) {
      /* locale 服务不可用时退回中文 */
    }
  }
  return fallback;
}

function fpSyncFmtWhen(value) {
  if (value === null || value === undefined || value === '') return '';
  try {
    if (typeof fpFmtDateTime === 'function') {
      const text = fpFmtDateTime(value);
      if (typeof text === 'string' && text !== '' && text !== '—') return text;
    }
  } catch (error) {
    /* 时间格式化失败时省略该片段 */
  }
  return '';
}

/* ------------------------------------------------------------------ */
/* 形状归一化：status / test detail / conflict                          */
/* ------------------------------------------------------------------ */

function fpSyncNormalizeStatus(raw) {
  if (!fpSyncIsObj(raw)) return null;
  let src = fpSyncIsObj(raw.status) ? raw.status : null;
  if (src === null) {
    const looksLikeStatus =
      raw.provider !== undefined ||
      raw.configured !== undefined ||
      raw.localRevision !== undefined ||
      raw.lastSyncedAt !== undefined ||
      raw.deviceId !== undefined ||
      fpSyncIsObj(raw.behavior);
    if (!looksLikeStatus) return null;
    src = raw;
  }
  const behavior = fpSyncIsObj(src.behavior) ? src.behavior : {};
  const counts = fpSyncIsObj(src.localCounts) ? src.localCounts : {};
  const cfg = fpSyncIsObj(src.config) ? src.config : {};
  const cfgGithub = fpSyncIsObj(cfg.github) ? cfg.github : {};
  const cfgWebdav = fpSyncIsObj(cfg.webdav) ? cfg.webdav : {};
  const provider = src.provider === 'github' || src.provider === 'webdav' ? src.provider : 'off';
  const fallbackLabel = provider === 'github' ? 'GitHub 仓库' : provider === 'webdav' ? 'WebDAV' : '未启用';
  return {
    provider: provider,
    providerLabel: fpSyncStr(src.providerLabel, fallbackLabel),
    configured: src.configured === true,
    credentialsSet: src.credentialsSet === true,
    githubCredentialsSet: src.githubCredentialsSet === true,
    webdavCredentialsSet: src.webdavCredentialsSet === true,
    config: {
      github: {
        owner: fpSyncStr(cfgGithub.owner, ''),
        repo: fpSyncStr(cfgGithub.repo, ''),
        branch: fpSyncStr(cfgGithub.branch, ''),
        path: fpSyncStr(cfgGithub.path, ''),
        apiBase: fpSyncStr(cfgGithub.apiBase, ''),
      },
      webdav: {
        url: fpSyncStr(cfgWebdav.url, ''),
        username: fpSyncStr(cfgWebdav.username, ''),
        fileName: fpSyncStr(cfgWebdav.fileName, ''),
      },
    },
    remoteTarget: fpSyncNullableStr(src.remoteTarget),
    behavior: {
      autoPushAfterWrite: behavior.autoPushAfterWrite === true,
      autoPullOnStart: behavior.autoPullOnStart === true,
    },
    localRevision: fpSyncInt(src.localRevision, 0),
    localUpdatedAt: fpSyncNullableStr(src.localUpdatedAt),
    localCounts: {
      businessLines: fpSyncInt(counts.businessLines, 0),
      projects: fpSyncInt(counts.projects, 0),
      nodes: fpSyncInt(counts.nodes, 0),
      events: fpSyncInt(counts.events, 0),
    },
    lastSyncedAt: fpSyncNullableStr(src.lastSyncedAt),
    lastSyncedRevision: fpSyncInt(src.lastSyncedRevision, null),
    hasPendingChanges: src.hasPendingChanges === true,
    lastError: fpSyncNullableStr(src.lastError),
    lastErrorAt: fpSyncNullableStr(src.lastErrorAt),
    deviceId: fpSyncStr(src.deviceId, ''),
    dataFile: fpSyncStr(src.dataFile, ''),
  };
}

function fpSyncNormalizeSide(raw) {
  if (!fpSyncIsObj(raw)) return null;
  return {
    revision: fpSyncInt(raw.revision, null),
    updatedAt: fpSyncNullableStr(raw.updatedAt),
  };
}

function fpSyncNormalizeConflict(raw) {
  if (!fpSyncIsObj(raw)) return null;
  const local = fpSyncNormalizeSide(raw.local);
  const remote = fpSyncNormalizeSide(raw.remote);
  if (local === null && remote === null) return null;
  const options = Array.isArray(raw.options)
    ? raw.options.filter(function (item) {
        return item === 'push' || item === 'pull';
      })
    : [];
  return {
    local: local,
    remote: remote,
    lastSyncedRevision: fpSyncInt(raw.lastSyncedRevision, null),
    options: options.length > 0 ? options : ['push', 'pull'],
  };
}

function fpSyncNormalizeTestDetail(raw) {
  if (!fpSyncIsObj(raw)) return null;
  const src = fpSyncIsObj(raw.detail) ? raw.detail : raw;
  const hasSignal =
    src.message !== undefined ||
    src.reachable !== undefined ||
    src.remoteFound !== undefined ||
    src.remoteRevision !== undefined ||
    src.latencyMs !== undefined;
  if (!hasSignal) return null;
  return {
    provider: fpSyncStr(src.provider, ''),
    reachable: src.reachable !== false,
    remoteFound: src.remoteFound === true,
    remoteRevision: fpSyncInt(src.remoteRevision, null),
    remoteUpdatedAt: fpSyncNullableStr(src.remoteUpdatedAt),
    remoteBytes: fpSyncInt(src.remoteBytes, null),
    latencyMs: fpSyncInt(src.latencyMs, null),
    message: fpSyncStr(src.message, ''),
  };
}

function fpSyncExtractRemoteRevision(data) {
  if (!fpSyncIsObj(data)) return null;
  const action = fpSyncStr(data.action, '');
  if (fpSyncIsObj(data.remote) && Number.isInteger(data.remote.revision)) return data.remote.revision;
  if (action === 'push' && Number.isInteger(data.revision)) return data.revision;
  if (action === 'pull' && Number.isInteger(data.revision)) return data.revision;
  if (Number.isInteger(data.appliedRevision)) return data.appliedRevision;
  if (Number.isInteger(data.remoteRevision)) return data.remoteRevision;
  return null;
}

/* ------------------------------------------------------------------ */
/* 表单草稿（status 不含明文凭据，也不回显 Config 全量字段）            */
/* ------------------------------------------------------------------ */

function fpSyncBlankDraft() {
  return {
    provider: 'off',
    github: {
      owner: '',
      repo: '',
      branch: 'main',
      path: 'flowpilot/data.json',
      apiBase: '',
      token: '',
    },
    webdav: {
      url: '',
      username: '',
      password: '',
      fileName: 'data.json',
    },
    behavior: {
      autoPushAfterWrite: false,
      autoPullOnStart: false,
    },
  };
}

function fpSyncParseGithubTarget(target) {
  const text = fpSyncTrim(target);
  const match = /^([^/\s]+)\/([^@\s]+)@([^:]+):(.+)$/.exec(text);
  if (!match) return null;
  return { owner: match[1], repo: match[2], branch: match[3], path: match[4] };
}

function fpSyncParseWebdavTarget(target) {
  const text = fpSyncTrim(target);
  if (text === '') return null;
  const clean = text.split('?')[0].split('#')[0].replace(/\/+$/, '');
  const index = clean.lastIndexOf('/');
  if (index <= 0) return { url: clean, fileName: '' };
  const fileName = clean.slice(index + 1);
  return {
    url: clean.slice(0, index),
    fileName: /\.json$/i.test(fileName) ? fileName : '',
  };
}

function fpSyncDraftFromStatus(status) {
  const draft = fpSyncBlankDraft();
  if (!status) return draft;
  draft.provider = status.provider;
  draft.behavior.autoPushAfterWrite = status.behavior.autoPushAfterWrite === true;
  draft.behavior.autoPullOnStart = status.behavior.autoPullOnStart === true;
  const cfg = status.config !== null && typeof status.config === 'object' ? status.config : null;
  if (status.provider === 'github') {
    const configured = cfg !== null && cfg.github !== null && typeof cfg.github === 'object' ? cfg.github : null;
    const parsed = fpSyncParseGithubTarget(status.remoteTarget);
    const source =
      configured !== null && (fpSyncTrim(configured.owner) !== '' || fpSyncTrim(configured.repo) !== '')
        ? configured
        : parsed;
    if (source) {
      draft.github.owner = fpSyncStr(source.owner, '');
      draft.github.repo = fpSyncStr(source.repo, '');
      const branch = fpSyncStr(source.branch, '');
      if (branch !== '') draft.github.branch = branch;
      const path = fpSyncStr(source.path, '');
      if (path !== '') draft.github.path = path;
    }
    if (configured !== null && fpSyncTrim(configured.apiBase) !== '') draft.github.apiBase = configured.apiBase;
  } else if (status.provider === 'webdav') {
    const configured = cfg !== null && cfg.webdav !== null && typeof cfg.webdav === 'object' ? cfg.webdav : null;
    const parsed = fpSyncParseWebdavTarget(status.remoteTarget);
    const source = configured !== null && fpSyncTrim(configured.url) !== '' ? configured : parsed;
    if (source) {
      draft.webdav.url = fpSyncStr(source.url, '');
      const fileName = fpSyncStr(source.fileName, '');
      if (fileName !== '') draft.webdav.fileName = fileName;
    }
    if (configured !== null && fpSyncTrim(configured.username) !== '') draft.webdav.username = configured.username;
  }
  return draft;
}

/** 该通道是否已存凭据：优先按通道标记，旧 status 回退到全局 credentialsSet。 */
function fpSyncCredentialsKnown(status, channel) {
  if (!status) return false;
  const flag = channel === 'github' ? status.githubCredentialsSet : status.webdavCredentialsSet;
  if (flag === true) return true;
  if (flag === false) return false;
  return status.provider === channel && status.credentialsSet === true;
}

function fpSyncValidateDraft(draft, status) {
  if (draft.provider === 'github') {
    const owner = fpSyncTrim(draft.github.owner);
    const repo = fpSyncTrim(draft.github.repo);
    const apiBase = fpSyncTrim(draft.github.apiBase);
    if (owner === '') return '请填写 GitHub Owner（仓库所有者或组织）';
    if (repo === '') return '请填写 GitHub 仓库名';
    if (apiBase !== '' && !/^https?:\/\//i.test(apiBase)) return 'API 地址需以 http:// 或 https:// 开头';
    const credentialsKnown = fpSyncCredentialsKnown(status, 'github');
    if (!credentialsKnown && fpSyncTrim(draft.github.token) === '') return '请填写 GitHub Token（首次配置必填）';
    return null;
  }
  if (draft.provider === 'webdav') {
    const url = fpSyncTrim(draft.webdav.url);
    if (url === '') return '请填写 WebDAV 目录 URL';
    if (!/^https?:\/\//i.test(url)) return '目录 URL 需以 http:// 或 https:// 开头';
    const credentialsKnown = fpSyncCredentialsKnown(status, 'webdav');
    if (!credentialsKnown && fpSyncTrim(draft.webdav.password) === '') return '请填写 WebDAV 密码（首次配置必填）';
    return null;
  }
  return null;
}

function fpSyncBuildConfigBody(draft) {
  const body = {
    provider: draft.provider,
    behavior: {
      autoPushAfterWrite: draft.behavior.autoPushAfterWrite === true,
      autoPullOnStart: draft.behavior.autoPullOnStart === true,
    },
  };
  const secrets = {};
  if (draft.provider === 'github') {
    const github = {
      owner: fpSyncTrim(draft.github.owner),
      repo: fpSyncTrim(draft.github.repo),
      branch: fpSyncTrim(draft.github.branch) || 'main',
      path: fpSyncTrim(draft.github.path) || 'flowpilot/data.json',
    };
    const apiBase = fpSyncTrim(draft.github.apiBase);
    if (apiBase !== '') github.apiBase = apiBase;
    body.github = github;
    const token = fpSyncTrim(draft.github.token);
    if (token !== '') secrets.githubToken = token;
  } else if (draft.provider === 'webdav') {
    body.webdav = {
      url: fpSyncTrim(draft.webdav.url),
      username: fpSyncTrim(draft.webdav.username),
      fileName: fpSyncTrim(draft.webdav.fileName) || 'data.json',
    };
    const password = fpSyncTrim(draft.webdav.password);
    if (password !== '') secrets.webdavPassword = password;
  }
  if (Object.keys(secrets).length > 0) body.secrets = secrets;
  return body;
}

/* ------------------------------------------------------------------ */
/* 文案小工具                                                          */
/* ------------------------------------------------------------------ */

function fpSyncStateView(status, conflict, loading) {
  if (conflict) {
    return { kind: 'conflict', tone: 'error', label: fpSyncT('sync.state.conflict', '有冲突'), hint: '本地与远端都改过，请选择覆盖方向后再同步。' };
  }
  if (!status) {
    if (loading) return { kind: 'loading', tone: 'idle', label: fpSyncT('sync.state.loading', '读取中'), hint: '正在读取同步状态…' };
    return { kind: 'unknown', tone: 'muted', label: fpSyncT('sync.state.unknown', '状态未知'), hint: '尚未读取到同步状态，可重新打开设置页重试。' };
  }
  if (status.provider === 'off') {
    return { kind: 'off', tone: 'idle', label: fpSyncT('sync.state.off', '未启用'), hint: '同步默认关闭。选择 GitHub 或 WebDAV 并保存配置后才会连接远端。' };
  }
  if (!status.configured) {
    return { kind: 'incomplete', tone: 'warn', label: fpSyncT('sync.state.incomplete', '配置不完整'), hint: '请补齐必填字段与凭据后保存配置。' };
  }
  if (status.lastError) {
    return { kind: 'error', tone: 'error', label: fpSyncT('sync.state.error', '最近错误'), hint: '上次同步失败，请检查通道配置或凭据后重试。' };
  }
  if (status.hasPendingChanges) {
    return { kind: 'pending', tone: 'warn', label: fpSyncT('sync.state.pending', '待同步'), hint: '本地有改动尚未同步到远端。' };
  }
  return { kind: 'synced', tone: 'success', label: fpSyncT('sync.state.synced', '已同步'), hint: '本地与远端一致。' };
}

function fpSyncStatusParts(status, remoteRevision) {
  const parts = [];
  if (!status) return parts;
  parts.push('本地 r' + status.localRevision);
  if (remoteRevision !== null && remoteRevision !== undefined) parts.push('远端 r' + remoteRevision);
  const synced = fpSyncFmtWhen(status.lastSyncedAt);
  if (synced !== '') parts.push('上次同步 ' + synced);
  if (status.deviceId !== '') parts.push('设备 ' + status.deviceId);
  return parts;
}

function fpSyncCountsTitle(status) {
  if (!status) return '';
  const counts = status.localCounts;
  return '业务线 ' + counts.businessLines + ' · 项目 ' + counts.projects + ' · 节点 ' + counts.nodes + ' · 事件 ' + counts.events;
}

function fpSyncConflictText(conflict) {
  const localRev = conflict.local && conflict.local.revision !== null ? conflict.local.revision : null;
  const remoteRev = conflict.remote && conflict.remote.revision !== null ? conflict.remote.revision : null;
  const lastRev = conflict.lastSyncedRevision;
  let head = '本地与远端都改过';
  if (localRev !== null && remoteRev !== null) head = '本地 r' + localRev + ' 与远端 r' + remoteRev + ' 都改过';
  else if (localRev !== null) head = '本地（r' + localRev + '）与远端都改过';
  else if (remoteRev !== null) head = '本地与远端（r' + remoteRev + '）都改过';
  const tail = lastRev !== null && lastRev !== undefined ? '（上次同步 r' + lastRev + '）' : '';
  return head + tail + '，请选择覆盖方向。覆盖前会自动备份。';
}

function fpSyncConflictMeta(conflict) {
  const parts = [];
  const localAt = fpSyncFmtWhen(conflict.local ? conflict.local.updatedAt : null);
  const remoteAt = fpSyncFmtWhen(conflict.remote ? conflict.remote.updatedAt : null);
  if (localAt !== '') parts.push('本地更新 ' + localAt);
  if (remoteAt !== '') parts.push('远端更新 ' + remoteAt);
  return parts.join(' · ');
}

function fpSyncMergedCounts(merged) {
  if (!fpSyncIsObj(merged)) return null;
  function sum(map) {
    if (!fpSyncIsObj(map)) return 0;
    return Object.keys(map).reduce(function (total, key) {
      const value = Number(map[key]);
      return total + (Number.isFinite(value) ? value : 0);
    }, 0);
  }
  return {
    added: sum(merged.added),
    updated: sum(merged.updated),
    deleted: sum(merged.deleted),
    conflicts: Array.isArray(merged.conflicts) ? merged.conflicts.length : 0,
    resurrected: Array.isArray(merged.resurrected) ? merged.resurrected.length : 0,
  };
}

function fpSyncRunText(data) {
  const action = fpSyncStr(data && data.action, '');
  const direction = fpSyncStr(data && data.direction, '');
  if (action === 'merge' || direction === 'merge') {
    const counts = fpSyncMergedCounts(data && data.merged);
    if (counts === null) return '已按三方合并完成同步';
    const parts = [];
    if (counts.added > 0) parts.push('新增 ' + counts.added);
    if (counts.updated > 0) parts.push('更新 ' + counts.updated);
    if (counts.deleted > 0) parts.push('删除 ' + counts.deleted);
    if (counts.resurrected > 0) parts.push('复活 ' + counts.resurrected);
    if (parts.length === 0) parts.push('两边改动已合并');
    const pending = Array.isArray(data && data.conflictDetails) ? data.conflictDetails.length : 0;
    return (
      '已三方合并：' +
      parts.join('、') +
      (counts.conflicts > 0 ? '（冲突 ' + counts.conflicts + ' 处按最新时间解决' : '') +
      (pending > 0 ? '，可在「冲突审阅」里复核 ' + pending + ' 条' : '') +
      (counts.conflicts > 0 || pending > 0 ? '）' : '')
    );
  }
  if (action === 'push') return '已上传本地数据到远端';
  if (action === 'pull') return '已从远端更新本地数据';
  if (action === 'noop') return '本地与远端已一致，无需同步';
  return '同步完成';
}

function fpSyncPushText(data) {
  const bytes = fpSyncInt(data && data.bytes, null);
  return bytes !== null && bytes > 0 ? '已上传本地数据到远端（' + bytes + ' 字节）' : '已上传本地数据到远端';
}

function fpSyncPullText(data) {
  const action = fpSyncStr(data && data.action, '');
  if (action === 'noop') return '远端没有更新，本地数据未变';
  return '已从远端更新本地数据';
}

function fpSyncForceText(direction) {
  return direction === 'pull' ? '已用远端覆盖本地' : '已用本地覆盖远端';
}

function fpSyncCanOperate(status) {
  if (!status) return true; /* 状态未知时不预判，交给宿主返回中文错误 */
  return status.provider !== 'off' && status.configured === true;
}

/**
 * 主动同步（顶栏按钮 / 自动定时器共用）：
 * 云端与本地双向检查、最新覆盖旧的，宿主随后总会把本地快照上传。
 * 返回 { ok, result, error }，永不 throw。
 */
async function fpSyncNow() {
  const response = await fpSyncRequest('/run', { mode: 'merge' });
  if (response.error !== null && response.error !== undefined && response.error !== '') {
    return { ok: false, result: null, error: response.error };
  }
  const data = fpSyncIsObj(response.data) ? response.data : {};
  return { ok: true, result: fpSyncIsObj(data.result) ? data.result : {}, error: null };
}

/* ------------------------------------------------------------------ */
/* 网络：统一 fetch 包装（永不 throw）                                  */
/* ------------------------------------------------------------------ */

async function fpSyncRequest(path, body, signal) {
  const url = FP_SYNC_API + path;
  if (typeof fetch !== 'function') {
    return { canceled: false, error: '当前环境不支持网络请求（宿主未就绪）', data: null, status: 0, code: '' };
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
    if (!fpSyncIsObj(data)) {
      return { canceled: false, error: '宿主返回了无法识别的响应（HTTP ' + statusCode + '）', data: null, status: statusCode, code: '' };
    }
    const failed = (response && response.ok === false) || data.ok === false;
    if (failed) {
      const code = fpSyncStr(data.code, '');
      return {
        canceled: false,
        error: fpSyncStr(data.error, '同步请求失败（HTTP ' + statusCode + '）'),
        data: data,
        status: statusCode,
        code: code,
        conflict: code === 'SYNC_CONFLICT' || data.code === 'SYNC_CONFLICT' ? fpSyncNormalizeConflict(data.conflict) : null,
      };
    }
    return { canceled: false, error: null, data: data, status: statusCode, code: '' };
  } catch (cause) {
    const canceled = !!(cause && (cause.name === 'AbortError' || cause.code === 'ABORT_ERR'));
    if (canceled) return { canceled: true, error: null, data: null, status: 0, code: '' };
    const message = cause && typeof cause.message === 'string' && cause.message !== '' ? cause.message : '未知错误';
    return { canceled: false, error: '网络请求失败：' + message, data: null, status: 0, code: '' };
  }
}

/* ------------------------------------------------------------------ */
/* 小组件                                                              */
/* ------------------------------------------------------------------ */

function fpSyncTextField(key, label, value, placeholder, onChange, opts) {
  const options = opts || {};
  return h(
    FpField,
    {
      key: key,
      label: label,
      hint: options.hint,
      required: options.required === true,
    },
    h(FpInput, {
      value: value === undefined || value === null ? '' : value,
      placeholder: placeholder,
      type: options.type === 'password' ? 'password' : 'text',
      disabled: options.disabled === true,
      ariaLabel: label,
      onChange: onChange,
    }),
  );
}

/* ------------------------------------------------------------------ */
/* 面板                                                                */
/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */
/* 冲突审阅（三方合并时两边改了同一字段：自动按最新时间解决，这里留待复核） */
/* ------------------------------------------------------------------ */

function fpSyncConflictItems(data) {
  const payload = fpSyncIsObj(data) ? data : {};
  const list = Array.isArray(payload.conflicts) ? payload.conflicts : [];
  return list.filter(fpSyncIsObj).map(function (item) {
    return {
      id: fpSyncStr(item.id, ''),
      collection: fpSyncStr(item.collection, ''),
      recordId: fpSyncStr(item.recordId, ''),
      label: fpSyncStr(item.label, '') !== '' ? fpSyncStr(item.label, '') : (fpSyncStr(item.recordId, '') || '记录'),
      field: fpSyncStr(item.field, ''),
      baseValue: item.baseValue,
      localValue: item.localValue,
      remoteValue: item.remoteValue,
      winner: item.winner === 'remote' ? 'remote' : 'local',
    };
  }).filter(function (item) {
    return item.id !== '';
  });
}

/** 把冲突值渲染成可读文本（字符串直接显示，对象截断 JSON）。 */
function fpSyncValueText(value) {
  if (value === undefined) return '（无）';
  if (value === null) return 'null';
  if (typeof value === 'string') return value === '' ? '（空字符串）' : value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try {
    const text = JSON.stringify(value);
    if (typeof text !== 'string') return String(value);
    return text.length > 140 ? text.slice(0, 137) + '…' : text;
  } catch (error) {
    return '（无法显示）';
  }
}

const FP_SYNC_CONFLICT_FIELD_LABEL = {
  status: '状态',
  title: '标题',
  name: '名称',
  dueAt: '截止时间',
  followUpAt: '跟进时间',
  notes: '备注',
  round: '轮次',
  approvals: '双角色确认',
  assigneeRole: '负责角色',
  sortOrder: '排序',
  activeNodeId: '当前节点',
  currentCode: '当前节点编号',
  currentStage: '当前阶段',
  progress: '进度',
  url: '链接地址',
  kind: '链接类型',
};

function FpSyncConflicts(props) {
  const p = fpSyncIsObj(props) ? props : {};
  const refreshKey = typeof p.refreshKey === 'number' ? p.refreshKey : 0;
  const [items, setItems] = React.useState([]);
  const [loaded, setLoaded] = React.useState(false);
  const [busy, setBusy] = React.useState('');
  const [error, setError] = React.useState('');
  const aliveRef = React.useRef(true);

  React.useEffect(function () {
    aliveRef.current = true;
    return function () {
      aliveRef.current = false;
    };
  }, []);

  function load() {
    return fpSyncRequest('/conflicts', undefined).then(function (result) {
      if (!aliveRef.current || result.canceled) return;
      setLoaded(true);
      if (result.error) {
        setError(result.error);
        return;
      }
      setError('');
      setItems(fpSyncConflictItems(result.data));
    });
  }

  React.useEffect(function () {
    const pending = load();
    if (pending && typeof pending.catch === 'function') {
      pending.catch(function () {
        /* 首次读取失败已就地展示 */
      });
    }
  }, [refreshKey]);

  function runResolve(path, body, label) {
    if (busy !== '') return;
    setBusy(label);
    setError('');
    fpSyncRequest(path, body).then(function (result) {
      if (!aliveRef.current || result.canceled) return;
      setBusy('');
      if (result.error) {
        setError(result.error);
        FpToast.push({ tone: 'error', text: result.error });
        return;
      }
      const data = fpSyncIsObj(result.data) ? result.data : {};
      const applied = typeof data.applied === 'number' ? data.applied : 0;
      const cleared = typeof data.cleared === 'number' ? data.cleared : 0;
      const remaining = typeof data.remaining === 'number' ? data.remaining : 0;
      const verb = path.indexOf('/clear') !== -1 ? '已标记审阅 ' + cleared + ' 条' : '已处理 ' + applied + ' 条冲突';
      FpToast.push({ tone: 'success', text: verb + (path.indexOf('/clear') !== -1 ? '' : '（剩余 ' + remaining + ' 条）') });
      refreshStore();
      load();
    });
  }

  function refreshStore() {
    try {
      if (typeof fpRefresh === 'function') fpRefresh();
    } catch (error) {
      /* 刷新失败不阻断审阅 */
    }
  }

  function resolveOne(item, choice) {
    runResolve('/conflicts/resolve', { id: item.id, choice: choice }, item.id + ':' + choice);
  }

  function resolveAll(choice) {
    runResolve('/conflicts/resolve', { all: true, choice: choice }, 'all:' + choice);
  }

  function clearAll() {
    runResolve('/conflicts/clear', {}, 'clear');
  }

  const count = items.length;
  const children = [];

  children.push(
    h(
      'div',
      { key: 'head', className: 'fp-sync-conflicts-head' },
      h('span', { className: 'fp-sync-conflicts-title' }, '冲突审阅'),
      h('span', { className: 'fp-sync-conflicts-count' + (count > 0 ? ' fp-sync-conflicts-count--on' : '') }, String(count)),
      h('span', { className: 'fp-spacer' }),
      h(
        'button',
        {
          key: 'reload',
          type: 'button',
          className: 'fp-sync-conflicts-link',
          disabled: busy !== '',
          onClick: function () {
            load();
          },
        },
        loaded === true && busy === '' ? '重新读取' : '读取中…',
      ),
    ),
  );

  if (error !== '') {
    children.push(
      h('div', { key: 'error', className: 'fp-sync-error', role: 'alert' },
        h(FpIcon, { name: 'alert', size: 13 }),
        h('span', null, error)),
    );
  }

  if (!loaded) {
    children.push(h('div', { key: 'loading', className: 'fp-sync-conflicts-empty' }, '正在读取待审阅冲突…'));
  } else if (count === 0) {
    children.push(
      h('div', { key: 'empty', className: 'fp-sync-conflicts-empty' },
        '没有待审阅的冲突。合并时如果两边改了同一字段，会自动按最新修改时间解决，并在这里留给你复核。'),
    );
  } else {
    children.push(
      h('div', { key: 'list', className: 'fp-sync-conflicts-list' },
        items.map(function (item) {
          const busyThis = busy === item.id + ':local' || busy === item.id + ':remote';
          return h(
            'div',
            { key: item.id, className: 'fp-sync-conflict-item' },
            h(
              'div',
              { key: 'head', className: 'fp-sync-conflict-item-head' },
              h('span', { key: 'label', className: 'fp-sync-conflict-item-label', title: item.recordId }, item.label),
              h('span', { key: 'field', className: 'fp-sync-conflict-item-field' },
                FP_SYNC_CONFLICT_FIELD_LABEL[item.field] || item.field || '字段'),
              h('span', {
                key: 'winner',
                className: 'fp-sync-conflict-item-winner',
                title: '合并时已自动采用的值（按最后修改时间）',
              }, '已采用' + (item.winner === 'remote' ? '云端' : '本地')),
            ),
            h(
              'div',
              { key: 'values', className: 'fp-sync-conflict-values' },
              h('div', { key: 'local', className: 'fp-sync-conflict-value' },
                h('span', { key: 'l', className: 'fp-sync-conflict-value-label' }, '本地'),
                h('span', { key: 'v', className: 'fp-sync-conflict-value-text' }, fpSyncValueText(item.localValue))),
              h('div', { key: 'remote', className: 'fp-sync-conflict-value' },
                h('span', { key: 'l', className: 'fp-sync-conflict-value-label' }, '云端'),
                h('span', { key: 'v', className: 'fp-sync-conflict-value-text' }, fpSyncValueText(item.remoteValue))),
            ),
            h(
              'div',
              { key: 'actions', className: 'fp-sync-conflict-actions' },
              h(
                'button',
                {
                  key: 'local',
                  type: 'button',
                  className: 'fp-sync-conflicts-btn',
                  disabled: busy !== '' || item.winner === 'local',
                  onClick: function () {
                    resolveOne(item, 'local');
                  },
                },
                busyThis && busy === item.id + ':local' ? '应用中…' : '采用本地',
              ),
              h(
                'button',
                {
                  key: 'remote',
                  type: 'button',
                  className: 'fp-sync-conflicts-btn fp-sync-conflicts-btn--primary',
                  disabled: busy !== '' || item.winner === 'remote',
                  onClick: function () {
                    resolveOne(item, 'remote');
                  },
                },
                busyThis && busy === item.id + ':remote' ? '应用中…' : '采用云端',
              ),
            ),
          );
        }),
      ),
    );
    children.push(
      h('div', { key: 'bulk', className: 'fp-sync-conflicts-bulk' },
        h('button', {
          key: 'all-local', type: 'button', className: 'fp-sync-conflicts-btn',
          disabled: busy !== '',
          onClick: function () { resolveAll('local'); },
        }, '全部用本地'),
        h('button', {
          key: 'all-remote', type: 'button', className: 'fp-sync-conflicts-btn',
          disabled: busy !== '',
          onClick: function () { resolveAll('remote'); },
        }, '全部用云端'),
        h('span', { key: 'spacer', className: 'fp-spacer' }),
        h('button', {
          key: 'clear', type: 'button', className: 'fp-sync-conflicts-link',
          disabled: busy !== '',
          title: '不改变数据，只把列表标记为已审阅',
          onClick: clearAll,
        }, '全部标记已阅'),
      ),
    );
  }

  return h('div', { className: 'fp-sync-conflicts' }, children);
}

function FpSyncPanel(props) {
  const p = fpSyncIsObj(props) ? props : {};
  const seedStatus = fpSyncNormalizeStatus(p.initialStatus);
  const seedConflict = fpSyncNormalizeConflict(p.initialConflict);
  const seedError = fpSyncStr(p.initialError, '');

  const [status, setStatus] = React.useState(seedStatus);
  const [draft, setDraft] = React.useState(function () {
    return fpSyncDraftFromStatus(seedStatus);
  });
  const [remoteRevision, setRemoteRevision] = React.useState(null);
  const [conflict, setConflict] = React.useState(null);
  const [conflictDismissed, setConflictDismissed] = React.useState(false);
  const [error, setError] = React.useState('');
  const [busy, setBusy] = React.useState(null);
  const [loading, setLoading] = React.useState(seedStatus === null);
  const [dirty, setDirty] = React.useState(false);
  const [conflictTick, setConflictTick] = React.useState(0);

  const mountedRef = React.useRef(true);
  const busyRef = React.useRef(null);
  const dirtyRef = React.useRef(false);
  const prefilledRef = React.useRef(seedStatus !== null);

  function alive() {
    return mountedRef.current === true;
  }

  function notify(tone, text) {
    try {
      if (typeof FpToast !== 'undefined' && FpToast && typeof FpToast.push === 'function') {
        FpToast.push({ tone: tone, text: text });
      }
    } catch (error) {
      /* toast 不可用不影响面板 */
    }
  }

  function markDirty() {
    dirtyRef.current = true;
    setDirty(true);
  }

  function updateDraft(mutator) {
    setDraft(function (prev) {
      const next = fpSyncClone(prev);
      try {
        mutator(next);
      } catch (error) {
        return fpSyncClone(prev);
      }
      return next;
    });
    markDirty();
    setError('');
  }

  function updateProvider(nextProvider) {
    if (nextProvider !== 'off' && nextProvider !== 'github' && nextProvider !== 'webdav') return;
    updateDraft(function (next) {
      next.provider = nextProvider;
    });
  }

  function updateGithub(patch) {
    updateDraft(function (next) {
      Object.assign(next.github, patch);
    });
  }

  function updateWebdav(patch) {
    updateDraft(function (next) {
      Object.assign(next.webdav, patch);
    });
  }

  function updateBehavior(patch) {
    updateDraft(function (next) {
      Object.assign(next.behavior, patch);
    });
  }

  function applyStatusSnapshot(next) {
    setStatus(next);
    if (!prefilledRef.current && !dirtyRef.current) {
      prefilledRef.current = true;
      setDraft(fpSyncDraftFromStatus(next));
    }
  }

  async function loadStatus(signal) {
    const result = await fpSyncRequest('/status', undefined, signal);
    if (!alive() || result.canceled) return;
    setLoading(false);
    if (result.error) {
      setError(result.error);
      return;
    }
    const next = fpSyncNormalizeStatus(result.data);
    if (next === null) {
      setError('宿主返回的同步状态无法识别');
      return;
    }
    applyStatusSnapshot(next);
  }

  async function refreshStatus() {
    try {
      const result = await fpSyncRequest('/status', undefined, null);
      if (!alive() || result.canceled || result.error) return;
      const next = fpSyncNormalizeStatus(result.data);
      if (next !== null) applyStatusSnapshot(next);
    } catch (error) {
      /* 刷新失败时保留当前状态 */
    }
  }

  React.useEffect(function () {
    mountedRef.current = true;
    let controller = null;
    if (seedStatus === null) {
      controller = typeof AbortController === 'function' ? new AbortController() : null;
      const pending = loadStatus(controller ? controller.signal : null);
      if (pending && typeof pending.catch === 'function') {
        pending.catch(function () {
          /* 首次读取失败已就地展示中文错误，这里只吞掉未处理的 rejection */
        });
      }
    }
    return function () {
      mountedRef.current = false;
      if (controller) {
        try {
          controller.abort();
        } catch (error) {
          /* ignore */
        }
      }
    };
  }, []);

  async function runSyncAction(kind, path, body, onSuccess) {
    if (busyRef.current) return;
    busyRef.current = kind;
    setBusy(kind);
    setError('');
    try {
      const result = await fpSyncRequest(path, body, null);
      if (!alive() || result.canceled) return;
      if (result.conflict) {
        setConflict(result.conflict);
        setConflictDismissed(false);
        notify('info', '检测到同步冲突，请选择覆盖方向');
        return;
      }
      if (result.error) {
        setError(result.error);
        notify('error', result.error);
        return;
      }
      if (typeof onSuccess === 'function') onSuccess(result.data);
    } catch (cause) {
      if (alive()) {
        const message = '同步操作失败：' + (cause && cause.message ? cause.message : '未知错误');
        setError(message);
        notify('error', message);
      }
    } finally {
      busyRef.current = null;
      if (alive()) setBusy(null);
    }
  }

  function handleSave() {
    if (busyRef.current) return;
    const validation = fpSyncValidateDraft(draft, status);
    if (validation) {
      setError(validation);
      return;
    }
    runSyncAction('config', '/config', fpSyncBuildConfigBody(draft), function (data) {
      dirtyRef.current = false;
      setDirty(false);
      prefilledRef.current = true;
      setDraft(function (prev) {
        const next = fpSyncClone(prev);
        next.github.token = '';
        next.webdav.password = '';
        return next;
      });
      const next = fpSyncNormalizeStatus(data);
      if (next !== null) {
        if (!status || status.provider !== next.provider || status.remoteTarget !== next.remoteTarget) {
          setRemoteRevision(null);
        }
        setStatus(next);
      } else {
        refreshStatus();
      }
      notify('success', '同步配置已保存');
    });
  }

  function handleTest() {
    runSyncAction('test', '/test', {}, function (data) {
      const detail = fpSyncNormalizeTestDetail(data);
      const message = detail && detail.message !== '' ? detail.message : '连接成功';
      if (detail && detail.reachable === false) {
        setError(message);
        notify('error', message);
        return;
      }
      if (detail && detail.remoteRevision !== null) setRemoteRevision(detail.remoteRevision);
      notify('success', message);
      refreshStatus();
    });
  }

  function handleRun(force) {
    const direction = force === 'push' || force === 'pull' ? force : null;
    const kind = direction === 'push' ? 'forcePush' : direction === 'pull' ? 'forcePull' : 'run';
    runSyncAction(kind, '/run', direction === null ? { mode: 'merge' } : { force: direction }, function (data) {
      setConflict(null);
      setConflictDismissed(true);
      const nextRemote = fpSyncExtractRemoteRevision(data);
      if (nextRemote !== null) setRemoteRevision(nextRemote);
      notify('success', direction === null ? fpSyncRunText(data) : fpSyncForceText(direction));
      setConflictTick(function (previous) { return previous + 1; });
      refreshStatus();
    });
  }

  function handlePush() {
    runSyncAction('push', '/push', {}, function (data) {
      setConflict(null);
      setConflictDismissed(true);
      const nextRemote = fpSyncExtractRemoteRevision(data);
      if (nextRemote !== null) setRemoteRevision(nextRemote);
      notify('success', fpSyncPushText(data));
      refreshStatus();
    });
  }

  function handlePull() {
    runSyncAction('pull', '/pull', {}, function (data) {
      setConflict(null);
      setConflictDismissed(true);
      const nextRemote = fpSyncExtractRemoteRevision(data);
      if (nextRemote !== null) setRemoteRevision(nextRemote);
      notify('success', fpSyncPullText(data));
      refreshStatus();
    });
  }

  /* ---------------- 渲染 ---------------- */

  const shownConflict = conflict || (conflictDismissed ? null : seedConflict);
  const shownError = error !== '' ? error : seedError;
  const stateView = fpSyncStateView(status, shownConflict, loading);
  const errorBlockText = shownError !== '' && (!status || shownError !== status.lastError) ? shownError : '';
  const statusParts = fpSyncStatusParts(status, remoteRevision);
  const detailText = statusParts.join(' · ');
  const countsTitle = fpSyncCountsTitle(status);
  const tokenSaved = fpSyncCredentialsKnown(status, 'github');
  const passwordSaved = fpSyncCredentialsKnown(status, 'webdav');
  const canOperate = fpSyncCanOperate(status);
  const operationsDisabled = !!busy || !canOperate;
  const operationsTitle = canOperate
    ? undefined
    : status && status.provider === 'off'
      ? '请先选择并保存同步通道'
      : '请先补齐并保存同步配置';

  const chips = [
    h(FpChip, { key: 'state', tone: stateView.tone, dot: true }, stateView.label),
  ];
  if (status && status.provider !== 'off') {
    chips.push(h(FpChip, { key: 'provider', tone: 'idle' }, status.providerLabel));
  }
  if (shownConflict) chips.push(h(FpChip, { key: 'conflict', tone: 'error' }, '冲突未解决'));
  if (status && status.hasPendingChanges && stateView.kind !== 'pending') {
    chips.push(h(FpChip, { key: 'pending', tone: 'amber' }, '待同步'));
  }
  if (dirty) chips.push(h(FpChip, { key: 'dirty', tone: 'brand' }, '有未保存修改'));

  const statusChildren = [
    h('div', { key: 'head', className: 'fp-sync-status-head' }, chips),
  ];
  if (status && status.remoteTarget) {
    statusChildren.push(
      h(
        'div',
        { key: 'target', className: 'fp-sync-target' },
        h('span', { className: 'fp-sync-target-label' }, '远端'),
        h('code', { className: 'fp-sync-target-code fp-sync-mono', title: status.remoteTarget }, status.remoteTarget),
      ),
    );
  }
  if (loading && !status) {
    statusChildren.push(h('div', { key: 'loading', className: 'fp-sync-loading' }, h(FpSpinner, { label: '正在读取同步状态…' })));
  }
  if (detailText !== '') {
    statusChildren.push(
      h('div', { key: 'detail', className: 'fp-sync-status-line fp-sync-mono', title: countsTitle || undefined }, detailText),
    );
  }
  if (stateView.hint && !(loading && !status)) {
    statusChildren.push(h('div', { key: 'hint', className: 'fp-sync-status-hint' }, stateView.hint));
  }
  if (status && status.lastError) {
    const errorAt = fpSyncFmtWhen(status.lastErrorAt);
    statusChildren.push(
      h(
        'div',
        { key: 'lastError', className: 'fp-sync-error', role: 'alert' },
        h(FpIcon, { name: 'alert', size: 13 }),
        h('span', null, '最近错误：' + status.lastError + (errorAt !== '' ? '（' + errorAt + '）' : '')),
      ),
    );
  }

  const children = [
    h('div', { key: 'status', className: 'fp-sync-status' }, statusChildren),
  ];

  if (shownConflict) {
    const conflictMeta = fpSyncConflictMeta(shownConflict);
    children.push(
      h(
        'div',
        { key: 'conflict', className: 'fp-sync-conflict', role: 'alert' },
        h(
          'div',
          { className: 'fp-sync-conflict-head' },
          h(FpIcon, { name: 'alert', size: 14 }),
          h('span', { className: 'fp-sync-conflict-title' }, '同步冲突'),
        ),
        h('p', { className: 'fp-sync-conflict-text' }, fpSyncConflictText(shownConflict)),
        conflictMeta !== '' ? h('div', { className: 'fp-sync-conflict-meta fp-sync-mono' }, conflictMeta) : null,
        h(
          'div',
          { className: 'fp-sync-actions' },
          fpvBtn(
            'forcePush',
            busy === 'forcePush' ? '覆盖中…' : fpSyncT('sync.forcePush', '用本地覆盖远端'),
            function () {
              handleRun('push');
            },
            {
              variant: 'primary',
              size: 'sm',
              disabled: !!busy,
              title: '先备份远端目标，再用本地数据覆盖远端快照',
            },
          ),
          fpvBtn(
            'forcePull',
            busy === 'forcePull' ? '覆盖中…' : fpSyncT('sync.forcePull', '用远端覆盖本地'),
            function () {
              handleRun('pull');
            },
            {
              variant: 'default',
              size: 'sm',
              disabled: !!busy,
              title: '先自动备份本地数据，再用远端快照覆盖本地',
            },
          ),
        ),
      ),
    );
  }

  if (errorBlockText !== '') {
    children.push(
      h(
        'div',
        { key: 'error', className: 'fp-sync-error', role: 'alert' },
        h(FpIcon, { name: 'alert', size: 13 }),
        h('span', null, errorBlockText),
      ),
    );
  }

  children.push(
    h(
      'div',
      { key: 'channel', className: 'fp-sync-row' },
      h(
        FpField,
        {
          label: fpSyncT('sync.channel', '同步通道'),
          hint: draft.provider === 'off'
            ? '同步默认关闭；选择 GitHub 或 WebDAV 后填写凭据并保存。'
            : '切换通道后需要重新保存配置才会生效。',
        },
        h(FpSelect, {
          value: draft.provider,
          options: FP_SYNC_PROVIDER_OPTIONS,
          width: 200,
          disabled: !!busy,
          onChange: updateProvider,
        }),
      ),
    ),
  );

  if (draft.provider === 'github') {
    children.push(
      h(
        'div',
        { key: 'github', className: 'fp-sync-grid' },
        fpSyncTextField(
          'owner',
          'Owner',
          draft.github.owner,
          '例如 octocat',
          function (value) {
            updateGithub({ owner: value });
          },
          { required: true, disabled: !!busy, hint: '仓库所有者或组织' },
        ),
        fpSyncTextField(
          'repo',
          '仓库',
          draft.github.repo,
          '例如 flowpilot-data',
          function (value) {
            updateGithub({ repo: value });
          },
          { required: true, disabled: !!busy, hint: '仓库名，不含 owner' },
        ),
        fpSyncTextField(
          'branch',
          '分支',
          draft.github.branch,
          'main',
          function (value) {
            updateGithub({ branch: value });
          },
          { disabled: !!busy, hint: '默认 main' },
        ),
        fpSyncTextField(
          'path',
          '文件路径',
          draft.github.path,
          'flowpilot/data.json',
          function (value) {
            updateGithub({ path: value });
          },
          { disabled: !!busy, hint: '仓库内路径，可带目录' },
        ),
        fpSyncTextField(
          'token',
          'Token',
          draft.github.token,
          tokenSaved ? '已保存，留空则保持不变' : 'ghp_…（需 contents 读写权限）',
          function (value) {
            updateGithub({ token: value });
          },
          {
            type: 'password',
            required: !tokenSaved,
            disabled: !!busy,
            hint: '只存本机，不进数据文件 / 导出 / 远端',
          },
        ),
      ),
    );
    children.push(
      h(
        'details',
        { key: 'advanced', className: 'fp-sync-advanced' },
        h('summary', { className: 'fp-sync-advanced-summary' }, '高级：API 地址（GitHub Enterprise / 自建网关）'),
        h(
          'div',
          { className: 'fp-sync-advanced-body' },
          fpSyncTextField(
            'apiBase',
            'API 地址',
            draft.github.apiBase,
            'https://api.github.com',
            function (value) {
              updateGithub({ apiBase: value });
            },
            { disabled: !!busy, hint: '留空使用默认 https://api.github.com' },
          ),
        ),
      ),
    );
  } else if (draft.provider === 'webdav') {
    children.push(
      h(
        'div',
        { key: 'webdav', className: 'fp-sync-grid' },
        fpSyncTextField(
          'url',
          '目录 URL',
          draft.webdav.url,
          'https://dav.example.com/dav/flowpilot',
          function (value) {
            updateWebdav({ url: value });
          },
          { required: true, disabled: !!busy, hint: 'WebDAV 目录地址，不含文件名' },
        ),
        fpSyncTextField(
          'username',
          '用户名',
          draft.webdav.username,
          '可选',
          function (value) {
            updateWebdav({ username: value });
          },
          { disabled: !!busy, hint: 'Basic Auth 用户名' },
        ),
        fpSyncTextField(
          'password',
          '密码',
          draft.webdav.password,
          passwordSaved ? '已保存，留空则保持不变' : 'WebDAV 密码',
          function (value) {
            updateWebdav({ password: value });
          },
          {
            type: 'password',
            required: !passwordSaved,
            disabled: !!busy,
            hint: '只存本机 0600 文件',
          },
        ),
        fpSyncTextField(
          'fileName',
          '文件名',
          draft.webdav.fileName,
          'data.json',
          function (value) {
            updateWebdav({ fileName: value });
          },
          { disabled: !!busy, hint: '默认 data.json' },
        ),
      ),
    );
  } else {
    children.push(
      h('div', { key: 'off-hint', className: 'fp-sync-status-hint' }, '同步已关闭。选择 GitHub 或 WebDAV 后填写凭据并保存配置即可启用。'),
    );
  }

  children.push(
    h(
      'div',
      { key: 'behavior', className: 'fp-sync-switches' },
      h(FpSwitch, {
        checked: draft.behavior.autoPushAfterWrite === true,
        label: fpSyncT('sync.autoPush', '写后自动同步（默认开启）'),
        description: '任何写操作后约 3 秒防抖，做一次三方合并并上传远端',
        disabled: !!busy,
        onChange: function (next) {
          updateBehavior({ autoPushAfterWrite: next === true });
        },
      }),
      h(FpSwitch, {
        checked: draft.behavior.autoPullOnStart === true,
        label: fpSyncT('sync.autoPull', '启动时自动拉取'),
        description: '插件启动后异步从远端拉取一次',
        disabled: !!busy,
        onChange: function (next) {
          updateBehavior({ autoPullOnStart: next === true });
        },
      }),
    ),
  );

  children.push(
    h(
      'div',
      { key: 'actions', className: 'fp-sync-actions' },
      fpvBtn('save', busy === 'config' ? '保存中…' : fpSyncT('sync.save', '保存配置'), handleSave, {
        variant: 'primary',
        disabled: !!busy,
        title: '保存通道、凭据与行为开关',
      }),
      fpvBtn('test', busy === 'test' ? '测试中…' : fpSyncT('sync.test', '测试连接'), handleTest, {
        disabled: operationsDisabled,
        title: operationsTitle,
      }),
      fpvBtn('run', busy === 'run' ? '同步中…' : fpSyncT('sync.run', '立即同步（双向）'), function () {
        handleRun(null);
      }, {
        disabled: operationsDisabled,
        title: operationsTitle,
      }),
      fpvBtn('push', busy === 'push' ? '上传中…' : fpSyncT('sync.push', '上传'), handlePush, {
        icon: 'upload',
        disabled: operationsDisabled,
        title: operationsTitle,
      }),
      fpvBtn('pull', busy === 'pull' ? '下载中…' : fpSyncT('sync.pull', '下载'), handlePull, {
        icon: 'download',
        disabled: operationsDisabled,
        title: operationsTitle,
      }),
    ),
  );

  children.push(h(FpSyncConflicts, { key: 'conflicts', refreshKey: conflictTick }));

  children.push(
    h(
      'p',
      { key: 'note', className: 'fp-sync-note' },
      h(FpIcon, { name: 'flag', size: 12 }),
      h('span', null, '凭据仅存本机 0600 文件（sync.json），不进数据文件 / 导出 / 远端；任何覆盖本地数据的动作都会先自动备份（保留最近 10 份）。'),
    ),
  );

  return fpvSettingsGroup(
    fpSyncT('sync.title', '同步'),
    fpSyncT('sync.hint', 'GitHub / WebDAV 两条通道，默认关闭'),
    h('div', { className: 'fp-sync' }, children),
  );
}

/* ------------------------------------------------------------------ */
/* 样式：仅 --dsw-* 令牌 + 自有 --fp-sync-*；明暗主题自动适配           */
/* ------------------------------------------------------------------ */

const CSS_SYNC = String.raw`
/* ===== 同步面板 · 面层级 + 设计系统 语义色（12% 背景 / 语义色文字），无描边 ===== */
.fp-sync{
  --fp-sync-text:var(--fp-text);
  --fp-sync-text-2:var(--fp-text-dim);
  --fp-sync-text-3:var(--fp-text-tertiary);
  --fp-sync-card-2:var(--fp-surface-2);
  --fp-sync-mono:var(--fp-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
  display:flex;
  flex-direction:column;
  gap:12px;
  min-width:0;
  color:var(--fp-sync-text);
}
.fp-sync .fp-sync-mono{font-family:var(--fp-sync-mono);font-variant-numeric:tabular-nums;}
.fp-sync-status{display:flex;flex-direction:column;gap:8px;padding:12px;border-radius:var(--fp-radius-md);background:var(--fp-surface-2);}
.fp-sync-status-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap;}
.fp-sync-status-line{font-size:var(--fp-font-xs);line-height:1.5;color:var(--fp-sync-text-2);overflow-wrap:anywhere;word-break:break-word;}
.fp-sync-status-hint{font-size:var(--fp-font-xs);line-height:1.55;color:var(--fp-sync-text-3);overflow-wrap:anywhere;padding:0 4px;}
.fp-sync-target{display:flex;align-items:baseline;gap:8px;min-width:0;font-size:var(--fp-font-xs);color:var(--fp-sync-text-2);}
.fp-sync-target-label{flex:0 0 auto;color:var(--fp-sync-text-3);}
.fp-sync-target-code{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--fp-sync-text-2);}
.fp-sync-loading{display:flex;align-items:center;gap:8px;}
.fp-sync-conflict{display:flex;flex-direction:column;gap:8px;padding:12px;border-radius:var(--fp-radius-md);background:color-mix(in srgb, var(--fp-bad) 12%, transparent);}
.fp-sync-conflict-head{display:flex;align-items:center;gap:8px;color:var(--fp-bad);font-size:var(--fp-font-sm);font-weight:650;}
.fp-sync-conflict-title{line-height:1.4;}
.fp-sync-conflict-text{margin:0;font-size:var(--fp-font-sm);line-height:1.6;color:var(--fp-sync-text);overflow-wrap:anywhere;}
.fp-sync-conflict-meta{font-size:var(--fp-font-xs);line-height:1.5;color:var(--fp-sync-text-3);overflow-wrap:anywhere;}
.fp-sync-error{display:flex;align-items:flex-start;gap:8px;padding:8px 12px;border-radius:var(--fp-radius-md);background:color-mix(in srgb, var(--fp-bad) 12%, transparent);color:var(--fp-bad);font-size:var(--fp-font-sm);line-height:1.5;overflow-wrap:anywhere;}
.fp-sync-error svg{flex:0 0 auto;margin-top:4px;}
.fp-sync-row{display:flex;align-items:flex-start;gap:12px;flex-wrap:wrap;min-width:0;}
.fp-sync-grid{display:grid;grid-template-columns:repeat(auto-fit, minmax(180px, 1fr));gap:12px;min-width:0;}
.fp-sync-advanced{border-radius:var(--fp-radius-md);background:var(--fp-surface-2);}
.fp-sync-advanced>summary{cursor:pointer;padding:8px 12px;font-size:var(--fp-font-xs);line-height:1.5;color:var(--fp-sync-text-2);list-style:none;}
.fp-sync-advanced>summary::-webkit-details-marker{display:none;}
.fp-sync-advanced>summary::before{content:'▸';display:inline-block;width:16px;color:var(--fp-sync-text-3);}
.fp-sync-advanced[open]>summary::before{content:'▾';}
.fp-sync-advanced-body{padding:0 12px 12px;}
.fp-sync-switches{display:flex;flex-direction:column;gap:4px;padding:4px 0;}
.fp-sync-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding-top:4px;}
.fp-sync-note{margin:0;padding-top:4px;display:flex;align-items:flex-start;gap:8px;font-size:var(--fp-font-xs);line-height:1.55;color:var(--fp-sync-text-3);overflow-wrap:anywhere;}
.fp-sync-note svg{flex:0 0 auto;margin-top:4px;}
@media (max-width: 640px){
  .fp-sync-grid{grid-template-columns:1fr;}
}

/* ---- 冲突审阅 ---- */
.fp-sync-conflicts{
  display:flex;flex-direction:column;gap:8px;
  padding:12px;border-radius:var(--fp-radius-md);
  background:var(--fp-surface-2);
}
.fp-sync-conflicts-head{
  display:flex;align-items:center;gap:8px;
}
.fp-sync-conflicts-title{
  font-size:var(--fp-font-sm);font-weight:600;color:var(--fp-text);
}
.fp-sync-conflicts-count{
  display:inline-flex;align-items:center;justify-content:center;
  min-width:20px;height:20px;padding:0 var(--fp-sp-1);
  border-radius:var(--fp-radius-pill);
  background:var(--fp-pressed);color:var(--fp-text-tertiary);
  font-size:10.5px;font-variant-numeric:tabular-nums;
}
.fp-sync-conflicts-count--on{
  background:color-mix(in srgb,var(--fp-warn) 18%,transparent);
  color:var(--fp-warn-strong);
  font-weight:600;
}
.fp-sync-conflicts-link{
  border:0;background:transparent;color:var(--fp-text-tertiary);
  font:inherit;font-size:var(--fp-font-xs);cursor:pointer;padding:0 4px;
  border-radius:var(--fp-radius-sm);
}
.fp-sync-conflicts-link:hover{background:var(--fp-hover);color:var(--fp-text);}
.fp-sync-conflicts-link:disabled{opacity:.6;cursor:default;}
.fp-sync-conflicts-empty{
  padding:8px;font-size:var(--fp-font-xs);line-height:1.6;color:var(--fp-text-tertiary);
}
.fp-sync-conflicts-list{display:flex;flex-direction:column;gap:8px;}
.fp-sync-conflict-item{
  display:flex;flex-direction:column;gap:8px;
  padding:8px;border-radius:var(--fp-radius-md);
  background:var(--fp-surface);
}
.fp-sync-conflict-item-head{display:flex;align-items:center;gap:8px;min-width:0;}
.fp-sync-conflict-item-label{
  font-size:var(--fp-font-xs);font-weight:600;color:var(--fp-text);
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0;
}
.fp-sync-conflict-item-field{
  flex:none;padding:0 4px;height:18px;display:inline-flex;align-items:center;
  border-radius:var(--fp-radius-sm);background:var(--fp-surface-2);
  font-size:10px;color:var(--fp-text-tertiary);
}
.fp-sync-conflict-item-winner{
  margin-left:auto;flex:none;font-size:10px;color:var(--fp-text-tertiary);
  white-space:nowrap;
}
.fp-sync-conflict-values{display:flex;flex-direction:column;gap:4px;}
.fp-sync-conflict-value{display:flex;align-items:flex-start;gap:8px;min-width:0;}
.fp-sync-conflict-value-label{
  flex:none;width:28px;font-size:10px;color:var(--fp-text-tertiary);line-height:1.6;
}
.fp-sync-conflict-value-text{
  flex:1 1 auto;min-width:0;font-size:var(--fp-font-xs);line-height:1.6;
  color:var(--fp-text-dim);word-break:break-all;
}
.fp-sync-conflict-actions{display:flex;gap:8px;justify-content:flex-end;}
.fp-sync-conflicts-btn{
  height:28px;padding:0 var(--fp-sp-2);border:0;border-radius:var(--fp-radius-sm);
  background:var(--fp-surface-2);color:var(--fp-text-dim);
  font:inherit;font-size:var(--fp-font-xs);cursor:pointer;
}
.fp-sync-conflicts-btn:hover{background:var(--fp-pressed);color:var(--fp-text);}
.fp-sync-conflicts-btn--primary{
  background:color-mix(in srgb,var(--fp-accent) 14%,transparent);
  color:var(--fp-accent-strong);font-weight:600;
}
.fp-sync-conflicts-btn--primary:hover{background:color-mix(in srgb,var(--fp-accent) 22%,transparent);}
.fp-sync-conflicts-btn:disabled{opacity:.5;cursor:default;}
.fp-sync-conflicts-bulk{display:flex;align-items:center;gap:8px;}
`;
