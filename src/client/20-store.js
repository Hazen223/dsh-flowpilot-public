/* ===== 归属：Lead · 客户端 store（/flowpilot/api 的唯一通道） =====
 * 宿主是唯一事实来源：任何写操作都 dispatch 到宿主，宿主回传整份
 * state + derived，这里整体替换并通知订阅者。重试/轮询都集中在模块级，
 * 多个组件共享同一条连接，不会各自打请求。
 */

const FP_API_BASE = '/flowpilot/api';
const FP_POLL_MS = 60000;
const FP_DISPATCH_TIMEOUT_MS = 30000;

const fpStore = (function createFpStore() {
  let snapshot = {
    status: 'loading',
    revision: 0,
    state: null,
    derived: null,
    error: null,
    lastLoadedAt: null,
  };
  const listeners = new Set();
  const pending = new Set();
  let bootRequested = false;

  function emit() {
    listeners.forEach((listener) => {
      try {
        listener(snapshot);
      } catch (error) {
        /* 单个订阅者异常不能影响其它订阅者 */
      }
    });
  }

  function patch(next) {
    snapshot = Object.assign({}, snapshot, next);
    emit();
  }

  function subscribe(listener) {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }

  function get() {
    return snapshot;
  }

  async function request(path, options) {
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), FP_DISPATCH_TIMEOUT_MS) : null;
    let response;
    try {
      response = await fetch(FP_API_BASE + path, Object.assign({
        headers: { 'content-type': 'application/json' },
        signal: controller ? controller.signal : undefined,
      }, options));
    } finally {
      if (timer) clearTimeout(timer);
    }
    let data = null;
    try {
      data = await response.json();
    } catch (error) {
      data = null;
    }
    if (data === null) {
      if (response.status === 404) throw new Error('宿主路由未就绪：未找到 ' + FP_API_BASE + path);
      throw new Error('FlowPilot 宿主返回了非 JSON 响应（HTTP ' + response.status + '）');
    }
    return { response, data };
  }

  function applyPayload(data) {
    patch({
      status: 'ready',
      revision: typeof data.revision === 'number' ? data.revision : snapshot.revision,
      state: data.state || snapshot.state,
      derived: data.derived || snapshot.derived,
      error: null,
      lastLoadedAt: Date.now(),
    });
    return data;
  }

  async function refresh(options) {
    const opts = options || {};
    if (!bootRequested) bootRequested = true;
    if (pending.has('refresh')) return null;
    pending.add('refresh');
    if (!opts.silent && snapshot.state === null) patch({ status: 'loading' });
    try {
      const { data } = await request('/state', { method: 'GET' });
      if (!data.ok) throw new Error(data.error || '读取 FlowPilot 数据失败');
      return applyPayload(data);
    } catch (error) {
      const message = error && error.name === 'AbortError' ? '连接 FlowPilot 宿主超时' : (error && error.message) || '未知错误';
      patch({ status: snapshot.state ? 'ready' : 'error', error: message });
      return null;
    } finally {
      pending.delete('refresh');
    }
  }

  async function dispatch(action, payload) {
    if (typeof action !== 'string' || action === '') {
      return { ok: false, error: '缺少 action', code: 'INVALID_INPUT' };
    }
    if (!pending.has('action')) pending.add('action');
    try {
      const { data } = await request('/action', {
        method: 'POST',
        body: JSON.stringify({ action: action, payload: payload || {} }),
      });
      if (data.state && data.derived) applyPayload(data);
      if (!data.ok) {
        return { ok: false, error: data.error || '操作失败', code: data.code || 'INTERNAL', result: data.result };
      }
      return { ok: true, result: data.result, revision: data.revision };
    } catch (error) {
      const message = error && error.name === 'AbortError' ? '操作超时' : (error && error.message) || '未知错误';
      return { ok: false, error: message, code: 'NETWORK' };
    } finally {
      pending.delete('action');
    }
  }

  async function exportBackup() {
    const response = await fetch(FP_API_BASE + '/export', { method: 'GET' });
    if (!response.ok) throw new Error('导出备份失败（HTTP ' + response.status + '）');
    return await response.text();
  }

  /** 仅供离线冒烟测试使用：直接把一份 state/derived 塞进快照。 */
  function __seed(payload) {
    patch({
      status: 'ready',
      revision: typeof payload.revision === 'number' ? payload.revision : 1,
      state: payload.state,
      derived: payload.derived,
      error: null,
      lastLoadedAt: Date.now(),
    });
  }

  return { get, subscribe, refresh, dispatch, exportBackup, subscribeCount: () => listeners.size, __seed };
})();

/* --------------------------- 订阅与轮询 --------------------------- */

let fpPollerRefs = 0;
let fpPollerTimer = null;
let fpPollerFocus = null;
let fpPollerVisibility = null;

function fpRetainPoller(intervalMs) {
  const period = typeof intervalMs === 'number' && intervalMs > 0 ? intervalMs : FP_POLL_MS;
  fpPollerRefs += 1;
  if (fpPollerRefs === 1) {
    fpPollerTimer = setInterval(() => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
      fpStore.refresh({ silent: true });
    }, period);
    fpPollerFocus = () => fpStore.refresh({ silent: true });
    fpPollerVisibility = () => {
      if (typeof document !== 'undefined' && document.visibilityState === 'visible') fpStore.refresh({ silent: true });
    };
    try {
      window.addEventListener('focus', fpPollerFocus);
      document.addEventListener('visibilitychange', fpPollerVisibility);
    } catch (error) {
      /* 无 window（理论上不会发生）时忽略 */
    }
    if (!fpStore.get().state) fpStore.refresh({ silent: true });
  }
  return () => {
    fpPollerRefs = Math.max(0, fpPollerRefs - 1);
    if (fpPollerRefs === 0) {
      if (fpPollerTimer) clearInterval(fpPollerTimer);
      fpPollerTimer = null;
      try {
        if (fpPollerFocus) window.removeEventListener('focus', fpPollerFocus);
        if (fpPollerVisibility && typeof document !== 'undefined') {
          document.removeEventListener('visibilitychange', fpPollerVisibility);
        }
      } catch (error) {
        /* ignore */
      }
      fpPollerFocus = null;
      fpPollerVisibility = null;
    }
  };
}

/* ------------------------------ hooks ------------------------------ */

function useFp() {
  const [snap, setSnap] = useState(fpStore.get());
  useEffect(() => {
    if (!fpStore.get().state) fpStore.refresh({ silent: true });
    const dispose = fpStore.subscribe(setSnap);
    const release = fpRetainPoller(FP_POLL_MS);
    return () => {
      dispose();
      release();
    };
  }, []);
  return snap;
}

/** 定时刷新的「现在」，让相对时间/节奏提示自动往前走。 */
function useNow(intervalMs) {
  const period = typeof intervalMs === 'number' && intervalMs > 0 ? intervalMs : 30000;
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), period);
    return () => clearInterval(timer);
  }, [period]);
  return now;
}

/**
 * 动作执行器：自动维护 busy 计数，并把宿主返回的中文错误交给调用方。
 * const [busy, run] = useFpAction(); const result = await run('completeNode', {nodeId});
 */
function useFpAction() {
  const [count, setCount] = useState(0);
  const run = useCallback(async (action, payload) => {
    setCount((value) => value + 1);
    try {
      return await fpStore.dispatch(action, payload);
    } finally {
      setCount((value) => Math.max(0, value - 1));
    }
  }, []);
  return [count > 0, run];
}

function fpDispatch(action, payload) {
  return fpStore.dispatch(action, payload);
}

function fpRefresh() {
  return fpStore.refresh();
}

/** 统一地把失败结果变成一条 toast（视图里非阻断失败用）。 */
function fpToastError(result) {
  const message = result && result.error ? result.error : '操作失败';
  try {
    FpToast.push({ tone: 'error', text: message });
  } catch (error) {
    /* 控件层未就绪时忽略 */
  }
  return false;
}

/** 读取导出的备份文本并触发浏览器下载。 */
async function fpExportBackupToFile() {
  const stamp = fpDateOnly(new Date());
  try {
    const text = await fpStore.exportBackup();
    const ok = fpDownload('FlowPilot-backup-' + stamp + '.json', text, 'application/json;charset=utf-8');
    if (ok) {
      try {
        FpToast.push({ tone: 'success', text: '备份已下载' });
      } catch (error) {
        /* ignore */
      }
    }
    return ok;
  } catch (error) {
    try {
      FpToast.push({ tone: 'error', text: (error && error.message) || '导出失败' });
    } catch (ignored) {
      /* ignore */
    }
    return false;
  }
}
