/* ===== 归属：ai-ui · AI 建流程（PRD 解析）对话框（AI-PRD-DIALOG §5） =====
 * 三态：输入 → 解析中 → 提案；用户点「生成项目」后通过 onApplied(projectId) 交还 shell。
 * 纯客户端：不读写全局 store，只调用 /flowpilot/api/ai/{status,parse,apply}。
 * 样式只用 CSS_BASE 的 --fp-* 令牌（设计系统 色表 + 4 栅格 + 去描边）；类名统一 fp-ai- 前缀。
 * 被 build-client.mjs 拼进同一 factory 作用域：无 import / export / require。
 */

const FP_AI_API = '/flowpilot/api';
const FP_AI_MIN_CHARS = 20;
const FP_AI_MAX_CHARS = 60000;
const FP_AI_MAX_NODES = 20;
const FP_AI_NEW_LINE = '__new__';
const FP_AI_PHASES = ['读取 PRD', '请求模型解析', '校验节点结构'];
const FP_AI_ROLES = ['设计', '研发', '设计/产品'];
const FP_AI_ROLE_OPTIONS = [
  { value: '设计', label: '设计' },
  { value: '研发', label: '研发' },
  { value: '设计/产品', label: '设计/产品' },
];
const FP_AI_TEMPLATE_IDS = ['delivery', 'acceptance', 'custom'];

/* ------------------------------------------------------------------ *
 * 纯函数小工具（全部 fpAi 前缀，只在本文件内使用）
 * ------------------------------------------------------------------ */

function fpAiIsObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function fpAiStr(value) {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' && isFinite(value)) return String(value);
  return '';
}

function fpAiTrim(value) {
  return fpAiStr(value).replace(/^\s+|\s+$/g, '');
}

/** 兼容两种取值：Fp 控件回调直接给字符串，原生事件给 event.target.value。 */
function fpAiRead(input, fallback) {
  let value = input;
  if (input !== null && typeof input === 'object' && !Array.isArray(input)) {
    const target = input.target;
    if (target !== null && typeof target === 'object' && 'value' in target) value = target.value;
  }
  if (value === undefined || value === null) return typeof fallback === 'string' ? fallback : '';
  return typeof value === 'string' ? value : String(value);
}

function fpAiTry(read, fallback) {
  try {
    const value = typeof read === 'function' ? read() : null;
    if (value === undefined || value === null) return fallback;
    return value;
  } catch (error) {
    return fallback;
  }
}

function fpAiRole(value) {
  const role = fpAiTrim(value);
  return FP_AI_ROLES.indexOf(role) >= 0 ? role : '设计';
}

function fpAiTemplateId(value) {
  const templateId = fpAiTrim(value);
  return FP_AI_TEMPLATE_IDS.indexOf(templateId) >= 0 ? templateId : 'custom';
}

function fpAiApprovalRoles(value) {
  const list = Array.isArray(value) ? value : [];
  const out = [];
  if (list.indexOf('design') >= 0) out.push('design');
  if (list.indexOf('product') >= 0) out.push('product');
  return out;
}

/** 只读 state.businessLines，产出扁平可渲染的列表；state 为 null 时返回空数组。 */
function fpAiLines(state) {
  const raw = state !== null && typeof state === 'object' && Array.isArray(state.businessLines) ? state.businessLines : [];
  const out = [];
  raw.forEach(function (line) {
    if (!fpAiIsObject(line)) return;
    const id = fpAiStr(line.id);
    if (id === '') return;
    out.push({
      id: id,
      name: fpAiStr(line.name) !== '' ? fpAiStr(line.name) : id,
      sortOrder: typeof line.sortOrder === 'number' ? line.sortOrder : 0,
    });
  });
  out.sort(function (a, b) {
    return a.sortOrder - b.sortOrder;
  });
  return out;
}

/** 按名字匹配已有业务线；匹配不到则落到「新建业务线」并回填名字。 */
function fpAiPickLine(lines, businessLineName) {
  const list = Array.isArray(lines) ? lines : [];
  const wanted = fpAiTrim(businessLineName);
  if (wanted !== '') {
    for (let index = 0; index < list.length; index += 1) {
      if (list[index].name.toLowerCase() === wanted.toLowerCase()) {
        return { lineId: list[index].id, newLineName: '' };
      }
    }
    return { lineId: FP_AI_NEW_LINE, newLineName: wanted };
  }
  if (list.length > 0) return { lineId: list[0].id, newLineName: '' };
  return { lineId: FP_AI_NEW_LINE, newLineName: '' };
}

function fpAiTemplateInfo(templateId) {
  const id = fpAiTemplateId(templateId);
  const registry = typeof FP_TEMPLATE_META === 'object' && FP_TEMPLATE_META !== null ? FP_TEMPLATE_META : {};
  if (id === 'custom') {
    return { id: id, label: '自定义流程', tone: 'muted', desc: '按提案里的节点顺序生成一条自定义流程。' };
  }
  const meta = fpAiIsObject(registry[id]) ? registry[id] : null;
  return {
    id: id,
    label: meta !== null && fpAiStr(meta.short) !== '' ? fpAiStr(meta.short) : meta !== null && fpAiStr(meta.title) !== '' ? fpAiStr(meta.title) : id,
    tone: id === 'delivery' ? 'brand' : 'accent',
    desc: meta !== null ? fpAiStr(meta.desc) : '',
  };
}

function fpAiDateInput(iso) {
  if (iso === null || iso === undefined || iso === '') return '';
  const date = fpAiTry(function () {
    return fpParseDate(iso);
  }, null);
  if (!date) return '';
  return fpAiTry(function () {
    return fpDateOnly(date);
  }, '');
}

/** 日期输入框 → ISO；日期没改动时保留原始时间点，避免悄悄改掉截止时刻。 */
function fpAiDueIso(dateText, baseIso) {
  const value = fpAiTrim(dateText);
  if (value === '') return null;
  if (baseIso !== null && baseIso !== undefined && baseIso !== '') {
    const base = fpAiTry(function () {
      return fpParseDate(baseIso);
    }, null);
    if (base && fpAiDateInput(baseIso) === value) return base.toISOString();
  }
  const date = fpAiTry(function () {
    return fpParseDate(value + 'T23:59:00');
  }, null);
  return date ? date.toISOString() : null;
}

function fpAiIsoOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const date = fpAiTry(function () {
    return fpParseDate(value);
  }, null);
  return date ? date.toISOString() : null;
}

function fpAiNodeIsApproval(node) {
  if (!fpAiIsObject(node)) return false;
  if (fpAiRole(node.assigneeRole) !== '设计/产品') return false;
  return fpAiApprovalRoles(node.approvalRoles).length > 0;
}

function fpAiNewNode() {
  return {
    uid: fpAiTry(function () {
      return fpUid('fpai-n');
    }, 'fpai-n'),
    title: '',
    detail: '',
    assigneeRole: '设计',
    approvalRoles: [],
    fresh: true,
  };
}

function fpAiNormalizeNodes(raw) {
  const list = Array.isArray(raw) ? raw : [];
  const out = [];
  for (let index = 0; index < list.length && out.length < FP_AI_MAX_NODES; index += 1) {
    const item = list[index];
    if (!fpAiIsObject(item)) continue;
    const role = fpAiRole(item.assigneeRole);
    out.push({
      uid: fpAiTry(function () {
        return fpUid('fpai-n');
      }, 'fpai-n'),
      title: fpAiStr(item.title),
      detail: fpAiStr(item.detail).slice(0, 200),
      assigneeRole: role,
      approvalRoles: role === '设计/产品' ? fpAiApprovalRoles(item.approvalRoles) : [],
      fresh: false,
    });
  }
  return out;
}

/** 提案归一化：模型 / 规则 / 测试 fixture 的输出都不可信。 */
function fpAiParseProposal(raw) {
  if (!fpAiIsObject(raw)) return null;
  return {
    title: fpAiStr(raw.title),
    businessLineName: fpAiTrim(raw.businessLineName) !== '' ? fpAiTrim(raw.businessLineName) : null,
    dueAt: fpAiIsoOrNull(raw.dueAt),
    templateId: fpAiTemplateId(raw.templateId),
    summary: fpAiStr(raw.summary),
    notes: fpAiStr(raw.notes),
    nodes: fpAiNormalizeNodes(raw.nodes),
  };
}

function fpAiNormalizeMeta(raw) {
  if (!fpAiIsObject(raw)) {
    return { source: '', provider: '', model: '', ms: null, truncated: false, warnings: [] };
  }
  const warnings = [];
  if (Array.isArray(raw.warnings)) {
    raw.warnings.forEach(function (item) {
      const text = fpAiTrim(item);
      if (text !== '') warnings.push(text);
    });
  }
  return {
    source: fpAiStr(raw.source),
    provider: fpAiStr(raw.provider),
    model: fpAiStr(raw.model),
    ms: typeof raw.ms === 'number' && isFinite(raw.ms) ? raw.ms : null,
    truncated: raw.truncated === true,
    warnings: warnings,
  };
}

function fpAiNormalizeStatus(raw) {
  if (!fpAiIsObject(raw)) return null;
  return {
    available: raw.available === true,
    provider: fpAiStr(raw.provider),
    model: fpAiStr(raw.model),
    reason: fpAiStr(raw.reason) !== '' ? fpAiStr(raw.reason) : fpAiStr(raw.error),
    modelSource: fpAiStr(raw.modelSource),
  };
}

function fpAiProjectId(data) {
  if (!fpAiIsObject(data)) return '';
  if (fpAiStr(data.projectId) !== '') return fpAiStr(data.projectId);
  const result = fpAiIsObject(data.result) ? data.result : null;
  if (result === null) return '';
  if (fpAiStr(result.projectId) !== '') return fpAiStr(result.projectId);
  if (fpAiIsObject(result.project) && fpAiStr(result.project.id) !== '') return fpAiStr(result.project.id);
  return '';
}

function fpAiIsTextFile(file) {
  if (!fpAiIsObject(file)) return false;
  const name = fpAiStr(file.name).toLowerCase();
  if (/\.(md|markdown|txt)$/.test(name)) return true;
  const type = fpAiStr(file.type).toLowerCase();
  return type === 'text/plain' || type === 'text/markdown';
}

/**
 * 统一 fetch 包装：永不 throw；非 200 / 非 JSON / 缺字段 / Abort 都转成结构化结果。
 * 返回 { canceled, error, data, status }。
 */
async function fpAiFetchJson(url, options) {
  if (typeof fetch !== 'function') {
    return { canceled: false, error: '当前环境不支持网络请求（宿主未就绪）', data: null, status: 0 };
  }
  try {
    const response = await fetch(url, options || {});
    const statusCode = response && typeof response.status === 'number' ? response.status : 0;
    let data = null;
    try {
      data = response && typeof response.json === 'function' ? await response.json() : null;
    } catch (error) {
      data = null;
    }
    if (data === null || data === undefined || typeof data !== 'object') {
      return { canceled: false, error: '宿主返回了无法识别的响应（HTTP ' + statusCode + '）', data: null, status: statusCode };
    }
    if (response && response.ok === false) {
      const message = fpAiStr(data.error) !== '' ? fpAiStr(data.error) : '宿主请求失败（HTTP ' + statusCode + '）';
      return { canceled: false, error: message, data: data, status: statusCode, code: fpAiStr(data.code) };
    }
    if (data.ok === false) {
      const message = fpAiStr(data.error) !== '' ? fpAiStr(data.error) : '操作失败，请稍后重试';
      return { canceled: false, error: message, data: data, status: statusCode, code: fpAiStr(data.code) };
    }
    return { canceled: false, error: null, data: data, status: statusCode };
  } catch (cause) {
    const canceled = !!(cause && (cause.name === 'AbortError' || cause.code === 'ABORT_ERR'));
    if (canceled) return { canceled: true, error: null, data: null, status: 0 };
    const message = cause && fpAiStr(cause.message) !== '' ? fpAiStr(cause.message) : '未知错误';
    return { canceled: false, error: '网络请求失败：' + message, data: null, status: 0 };
  }
}

/**
 * 可选的测试播种参数（shell 不传，仅离线冒烟测试使用）：
 * initialStage / initialText / initialProposal(或 proposal) / initialMeta(或 meta) / initialStatus。
 */
function fpAiSeed(props, lines) {
  const p = fpAiIsObject(props) ? props : {};
  const rawProposal = p.initialProposal !== undefined ? p.initialProposal : p.proposal;
  const parsed = fpAiParseProposal(rawProposal);
  const status = fpAiNormalizeStatus(p.initialStatus);
  const pick = fpAiPickLine(lines, parsed !== null ? parsed.businessLineName : '');
  let stage = 'input';
  if (parsed !== null) stage = 'proposal';
  else if (p.initialStage === 'parsing') stage = 'parsing';
  const metaRaw = p.initialMeta !== undefined && p.initialMeta !== null ? p.initialMeta : p.meta;
  return {
    stage: stage,
    hasProposal: parsed !== null,
    text: typeof p.initialText === 'string' ? p.initialText : '',
    lineId: pick.lineId,
    newLineName: pick.newLineName,
    status: status,
    title: parsed !== null ? parsed.title : '',
    templateId: parsed !== null ? parsed.templateId : 'custom',
    dueDate: parsed !== null ? fpAiDateInput(parsed.dueAt) : '',
    dueAt: parsed !== null ? parsed.dueAt : null,
    summary: parsed !== null ? parsed.summary : '',
    notes: parsed !== null ? parsed.notes : '',
    nodes: parsed !== null ? parsed.nodes : [],
    meta: parsed !== null ? fpAiNormalizeMeta(metaRaw) : null,
  };
}

/* ------------------------------------------------------------------ *
 * 全流程弹窗：AiPrdDialog（契约 AI-PRD-DIALOG §5）
 * ------------------------------------------------------------------ */

function AiPrdDialog(props) {
  const p = fpAiIsObject(props) ? props : {};
  const open = p.open === true;
  const lines = fpAiLines(p.state);
  const seed = fpAiSeed(p, lines);

  const cardRef = useRef(null);
  const prevFocusRef = useRef(null);
  const fileInputRef = useRef(null);
  const abortRef = useRef(null);
  const requestSeqRef = useRef(0);
  const aliveRef = useRef(true);
  const applyLockRef = useRef(false);
  const onCloseRef = useRef(typeof p.onClose === 'function' ? p.onClose : null);
  const closeHandlerRef = useRef(null);
  onCloseRef.current = typeof p.onClose === 'function' ? p.onClose : null;

  const [stage, setStage] = useState(seed.stage);
  const [text, setText] = useState(seed.text);
  const [lineId, setLineId] = useState(seed.lineId);
  const [newLineName, setNewLineName] = useState(seed.newLineName);
  const [extra, setExtra] = useState('');
  const [status, setStatus] = useState(seed.status);
  const [statusState, setStatusState] = useState(seed.status !== null ? 'ready' : 'loading');
  const [hasProposal, setHasProposal] = useState(seed.hasProposal);
  const [pTitle, setPTitle] = useState(seed.title);
  const [pTemplateId, setPTemplateId] = useState(seed.templateId);
  const [pDueDate, setPDueDate] = useState(seed.dueDate);
  const [dueBase, setDueBase] = useState(seed.dueAt);
  const [pSummary, setPSummary] = useState(seed.summary);
  const [pNotes, setPNotes] = useState(seed.notes);
  const [pNodes, setPNodes] = useState(seed.nodes);
  const [meta, setMeta] = useState(seed.meta);
  const [phase, setPhase] = useState(0);
  const [parseError, setParseError] = useState(null);
  const [applyError, setApplyError] = useState(null);
  const [applying, setApplying] = useState(false);
  const [dragActive, setDragActive] = useState(false);
  const [reading, setReading] = useState(false);

  /* ---------------- 请求与状态工具 ---------------- */

  function abortParsing() {
    requestSeqRef.current += 1;
    const controller = abortRef.current;
    abortRef.current = null;
    if (controller && typeof controller.abort === 'function') {
      try {
        controller.abort();
      } catch (error) {
        /* 已经结束的请求直接忽略 */
      }
    }
  }

  function requestClose() {
    if (applying === true) return;
    abortParsing();
    const close = onCloseRef.current;
    if (typeof close === 'function') {
      try {
        close();
      } catch (error) {
        /* 调用方回调异常不能影响弹窗自身 */
      }
    }
  }

  function currentLineName() {
    if (lineId === '' || lineId === FP_AI_NEW_LINE) return fpAiTrim(newLineName);
    for (let index = 0; index < lines.length; index += 1) {
      if (lines[index].id === lineId) return lines[index].name;
    }
    return fpAiTrim(newLineName);
  }

  function handleTextChange(value) {
    setText(fpAiRead(value, ''));
    if (parseError !== null) setParseError(null);
  }

  function handleExtraChange(value) {
    setExtra(fpAiRead(value, ''));
  }

  function handleTitleChange(value) {
    setPTitle(fpAiRead(value, ''));
    if (applyError !== null) setApplyError(null);
  }

  function handleDueChange(value) {
    setPDueDate(fpAiRead(value, ''));
    if (applyError !== null) setApplyError(null);
  }

  function clearDue() {
    setPDueDate('');
    setDueBase(null);
  }

  function handleLineChange(value) {
    const next = fpAiRead(value, '');
    if (next === '') return;
    setLineId(next);
    if (next !== FP_AI_NEW_LINE) setNewLineName('');
    if (applyError !== null) setApplyError(null);
  }

  function handleNewLineChange(value) {
    setNewLineName(fpAiRead(value, ''));
    if (applyError !== null) setApplyError(null);
  }

  function handleTextareaKeyDown(event) {
    if (!event || typeof event !== 'object') return;
    if (event.key !== 'Enter') return;
    if (event.metaKey !== true && event.ctrlKey !== true) return;
    if (typeof event.preventDefault === 'function') event.preventDefault();
    beginParse(false);
  }

  /* ---------------- 文件读取（纯前端，不上传） ---------------- */

  function pickFile() {
    const input = fileInputRef.current;
    if (!input || typeof input.click !== 'function') {
      setParseError('当前环境无法打开文件选择器，请直接把 PRD 粘贴到文本框');
      return;
    }
    try {
      input.click();
    } catch (error) {
      setParseError('无法打开文件选择器，请直接把 PRD 粘贴到文本框');
    }
  }

  function handleFileChange(event) {
    const input = event && event.target ? event.target : null;
    const file = input && input.files && input.files.length > 0 ? input.files[0] : null;
    if (input) {
      try {
        input.value = '';
      } catch (error) {
        /* 忽略：某些环境禁止重置 file input */
      }
    }
    if (file) readTextFile(file);
  }

  function readTextFile(file) {
    if (reading === true) return;
    if (!fpAiIsTextFile(file)) {
      setParseError('只支持 .md / .txt 文本文件，请换一个文件或直接粘贴');
      return;
    }
    if (typeof FileReader !== 'function') {
      setParseError('当前环境不支持读取本地文件，请直接粘贴文本');
      return;
    }
    let reader = null;
    try {
      reader = new FileReader();
    } catch (error) {
      setReading(false);
      setParseError('无法读取该文件，请直接粘贴文本');
      return;
    }
    setReading(true);
    setParseError(null);
    const fileName = fpAiStr(file.name) !== '' ? fpAiStr(file.name) : '文件';
    reader.onload = function () {
      if (aliveRef.current !== true) return;
      setReading(false);
      const raw = reader.result;
      if (typeof raw !== 'string') {
        setParseError('文件内容不是文本，无法读入');
        return;
      }
      let content = raw.replace(/^\uFEFF/, '');
      let clipped = false;
      if (content.length > FP_AI_MAX_CHARS) {
        content = content.slice(0, FP_AI_MAX_CHARS);
        clipped = true;
      }
      setText(content);
      try {
        FpToast.push({ tone: clipped ? 'info' : 'success', text: clipped ? '文件较长，已截取前 ' + FP_AI_MAX_CHARS + ' 字' : '已读入「' + fileName + '」' });
      } catch (error) {
        /* toast 不可用不影响读入 */
      }
    };
    reader.onerror = function () {
      if (aliveRef.current !== true) return;
      setReading(false);
      setParseError('读取文件失败，请重试或直接粘贴文本');
    };
    try {
      reader.readAsText(file);
    } catch (error) {
      setReading(false);
      setParseError('读取文件失败，请重试或直接粘贴文本');
    }
  }

  function handleDragOver(event) {
    if (!event || typeof event !== 'object') return;
    if (typeof event.preventDefault === 'function') event.preventDefault();
    setDragActive(true);
  }

  function handleDragLeave(event) {
    if (!event || typeof event !== 'object') return;
    if (typeof event.preventDefault === 'function') event.preventDefault();
    setDragActive(false);
  }

  function handleDrop(event) {
    if (!event || typeof event !== 'object') return;
    if (typeof event.preventDefault === 'function') event.preventDefault();
    setDragActive(false);
    const transfer = event.dataTransfer;
    const files = transfer && transfer.files ? transfer.files : null;
    const file = files && files.length > 0 ? files[0] : null;
    if (file) readTextFile(file);
  }

  /* ---------------- 解析 ---------------- */

  async function beginParse(fromProposal) {
    if (stage === 'parsing') return;
    const source = typeof text === 'string' ? text : '';
    if (source.replace(/^\s+|\s+$/g, '').length < FP_AI_MIN_CHARS) {
      setParseError('PRD 至少需要 ' + FP_AI_MIN_CHARS + ' 个字才能解析');
      if (hasProposal !== true) setStage('input');
      return;
    }
    abortParsing();
    const seq = requestSeqRef.current;
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    abortRef.current = controller;
    setStage('parsing');
    setPhase(0);
    setParseError(null);
    setApplyError(null);
    if (hasProposal !== true) setMeta(null);
    try {
      const body = { text: source };
      const hint = currentLineName();
      if (hint !== '') body.businessLineHint = hint;
      const extraText = fpAiTrim(extra);
      if (extraText !== '') body.extraInstructions = extraText;
      const result = await fpAiFetchJson(FP_AI_API + '/ai/parse', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller ? controller.signal : undefined,
      });
      if (aliveRef.current !== true) return;
      if (seq !== requestSeqRef.current) return;
      abortRef.current = null;
      const back = fromProposal === true && hasProposal === true ? 'proposal' : 'input';
      if (result.error) {
        setStage(back);
        setParseError(result.error);
        return;
      }
      if (result.canceled === true) {
        setStage(back);
        return;
      }
      const data = result.data;
      const parsed = fpAiParseProposal(data ? data.proposal : null);
      if (parsed === null) {
        setStage(back);
        setParseError('宿主没有返回有效的提案数据，请重试（或检查 PRD 内容）');
        return;
      }
      const nextMeta = fpAiNormalizeMeta(data ? data.meta : null);
      setHasProposal(true);
      setStage('proposal');
      setPTitle(parsed.title);
      setPTemplateId(parsed.templateId);
      setPDueDate(fpAiDateInput(parsed.dueAt));
      setDueBase(parsed.dueAt);
      setPSummary(parsed.summary);
      setPNotes(parsed.notes);
      setPNodes(parsed.nodes);
      setMeta(nextMeta);
      if (parsed.businessLineName !== null) {
        const pick = fpAiPickLine(lines, parsed.businessLineName);
        setLineId(pick.lineId);
        setNewLineName(pick.newLineName);
      } else if (lineId === '') {
        const pick = fpAiPickLine(lines, '');
        setLineId(pick.lineId);
        setNewLineName(pick.newLineName);
      }
      setApplyError(null);
      if (nextMeta.source === 'heuristic') {
        try {
          FpToast.push({ tone: 'info', text: '未使用模型，已按文档结构规则解析' });
        } catch (error) {
          /* toast 不可用不影响解析结果 */
        }
      }
    } catch (error) {
      if (aliveRef.current !== true) return;
      abortRef.current = null;
      setStage(fromProposal === true && hasProposal === true ? 'proposal' : 'input');
      setParseError('解析失败：' + (error && typeof error.message === 'string' && error.message !== '' ? error.message : '未知错误'));
    }
  }

  function cancelParsing() {
    if (stage !== 'parsing') return;
    abortParsing();
    setPhase(0);
    setStage(hasProposal === true ? 'proposal' : 'input');
    try {
      FpToast.push({ tone: 'info', text: '已取消解析' });
    } catch (error) {
      /* 忽略 */
    }
  }

  /* ---------------- 节点编辑 ---------------- */

  function updateNode(uid, patch) {
    setPNodes(function (prev) {
      const list = Array.isArray(prev) ? prev : [];
      return list.map(function (node) {
        if (!fpAiIsObject(node) || node.uid !== uid) return node;
        return Object.assign({}, node, patch);
      });
    });
  }

  function changeRole(uid, role) {
    const nextRole = fpAiRole(fpAiRead(role, ''));
    updateNode(uid, {
      assigneeRole: nextRole,
      approvalRoles: nextRole === '设计/产品' ? ['design', 'product'] : [],
    });
    if (applyError !== null) setApplyError(null);
  }

  function moveNode(uid, delta) {
    setPNodes(function (prev) {
      const list = Array.isArray(prev) ? prev.slice() : [];
      let index = -1;
      for (let scan = 0; scan < list.length; scan += 1) {
        if (fpAiIsObject(list[scan]) && list[scan].uid === uid) {
          index = scan;
          break;
        }
      }
      const target = index + delta;
      if (index < 0 || target < 0 || target >= list.length) return list;
      const swap = list[index];
      list[index] = list[target];
      list[target] = swap;
      return list;
    });
  }

  function removeNode(uid) {
    setPNodes(function (prev) {
      const list = Array.isArray(prev) ? prev : [];
      return list.filter(function (node) {
        return !fpAiIsObject(node) || node.uid !== uid;
      });
    });
    if (applyError !== null) setApplyError(null);
  }

  function addNode() {
    setPNodes(function (prev) {
      const list = Array.isArray(prev) ? prev.slice() : [];
      if (list.length >= FP_AI_MAX_NODES) return list;
      list.push(fpAiNewNode());
      return list;
    });
    if (applyError !== null) setApplyError(null);
  }

  /* ---------------- 生成项目 ---------------- */

  function buildPayload() {
    const nodes = Array.isArray(pNodes) ? pNodes : [];
    return {
      title: fpAiTrim(pTitle),
      businessLineName: currentLineName() !== '' ? currentLineName() : null,
      dueAt: fpAiDueIso(pDueDate, dueBase),
      templateId: fpAiTemplateId(pTemplateId),
      summary: fpAiStr(pSummary),
      nodes: nodes.map(function (node) {
        const item = fpAiIsObject(node) ? node : {};
        const role = fpAiRole(item.assigneeRole);
        return {
          title: fpAiTrim(item.title),
          detail: fpAiTrim(item.detail).slice(0, 200),
          assigneeRole: role,
          approvalRoles: role === '设计/产品' ? fpAiApprovalRoles(item.approvalRoles) : [],
        };
      }),
      notes: fpAiStr(pNotes),
    };
  }

  function validateBeforeApply() {
    if (fpAiTrim(pTitle) === '') return '请填写项目标题';
    const nodes = Array.isArray(pNodes) ? pNodes : [];
    if (nodes.length === 0) return '至少需要一个流程节点，请在节点列表里新增';
    for (let index = 0; index < nodes.length; index += 1) {
      const node = fpAiIsObject(nodes[index]) ? nodes[index] : {};
      if (fpAiTrim(node.title) === '') return '第 ' + (index + 1) + ' 个节点还没有标题';
    }
    if (lineId === '' || lineId === FP_AI_NEW_LINE) {
      if (fpAiTrim(newLineName) === '') return '请填写业务线名称（或选择已有业务线）';
    }
    return null;
  }

  async function applyProposal() {
    if (applying === true || applyLockRef.current === true) return;
    const problem = validateBeforeApply();
    if (problem !== null) {
      setApplyError(problem);
      return;
    }
    let payload = null;
    try {
      payload = buildPayload();
    } catch (error) {
      setApplyError('提案数据异常，无法生成项目，请重新解析');
      return;
    }
    applyLockRef.current = true;
    setApplying(true);
    setApplyError(null);
    setParseError(null);
    try {
      const body = { proposal: payload };
      if (lineId !== '' && lineId !== FP_AI_NEW_LINE) body.businessLineId = lineId;
      const result = await fpAiFetchJson(FP_AI_API + '/ai/apply', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      applyLockRef.current = false;
      if (aliveRef.current !== true) return;
      setApplying(false);
      if (result.canceled === true) return;
      if (result.error) {
        setApplyError(result.error);
        return;
      }
      const data = result.data;
      const projectId = fpAiProjectId(data);
      const title = fpAiTrim(payload.title) !== '' ? fpAiTrim(payload.title) : '新项目';
      try {
        FpToast.push({ tone: 'success', text: '已生成项目「' + title + '」' });
      } catch (error) {
        /* toast 不可用不影响生成流程 */
      }
      if (typeof p.onApplied === 'function') {
        try {
          p.onApplied(projectId);
        } catch (error) {
          /* 调用方的回调异常不能影响弹窗收尾 */
        }
      }
      const close = onCloseRef.current;
      if (typeof close === 'function') {
        try {
          close();
        } catch (error) {
          /* 忽略 */
        }
      }
    } catch (error) {
      applyLockRef.current = false;
      if (aliveRef.current !== true) return;
      setApplying(false);
      setApplyError('生成项目失败：' + (error && typeof error.message === 'string' && error.message !== '' ? error.message : '未知错误'));
    }
  }

  /* ---------------- 生命周期 ---------------- */

  useEffect(function () {
    aliveRef.current = true;
    return function () {
      aliveRef.current = false;
      abortParsing();
    };
  }, []);

  useEffect(function () {
    if (open !== true) return undefined;
    const nextSeed = fpAiSeed(p, lines);
    setStage(nextSeed.stage);
    setText(nextSeed.text);
    setLineId(nextSeed.lineId);
    setNewLineName(nextSeed.newLineName);
    setExtra('');
    setStatus(nextSeed.status);
    setStatusState(nextSeed.status !== null ? 'ready' : 'loading');
    setHasProposal(nextSeed.hasProposal);
    setPTitle(nextSeed.title);
    setPTemplateId(nextSeed.templateId);
    setPDueDate(nextSeed.dueDate);
    setDueBase(nextSeed.dueAt);
    setPSummary(nextSeed.summary);
    setPNotes(nextSeed.notes);
    setPNodes(nextSeed.nodes);
    setMeta(nextSeed.meta);
    setPhase(0);
    setParseError(null);
    setApplyError(null);
    setApplying(false);
    setDragActive(false);
    setReading(false);
    applyLockRef.current = false;
    if (typeof document !== 'undefined') prevFocusRef.current = document.activeElement || null;
    const focusTimer = setTimeout(function () {
      const node = cardRef.current;
      if (!node || typeof node !== 'object') return;
      let target = null;
      try {
        target = typeof node.querySelector === 'function' ? node.querySelector('textarea, input:not([type="file"]):not([type="hidden"]), select, button') : null;
      } catch (error) {
        target = null;
      }
      if (target && typeof target.focus === 'function') {
        target.focus();
      } else if (typeof node.focus === 'function') {
        try {
          node.setAttribute('tabindex', '-1');
        } catch (error) {
          /* 忽略 */
        }
        node.focus();
      }
    }, 30);
    let alive = true;
    const statusController = typeof AbortController === 'function' ? new AbortController() : null;
    fpAiFetchJson(FP_AI_API + '/ai/status', {
      method: 'GET',
      headers: { accept: 'application/json' },
      signal: statusController ? statusController.signal : undefined,
    }).then(function (result) {
      if (alive !== true || aliveRef.current !== true) return;
      if (result.error) {
        setStatus({ available: false, provider: '', model: '', reason: result.error, modelSource: '' });
        setStatusState('error');
        return;
      }
      const normalized = fpAiNormalizeStatus(result.data);
      if (normalized === null) {
        setStatus({ available: false, provider: '', model: '', reason: '宿主返回的 AI 状态无法识别', modelSource: '' });
        setStatusState('error');
        return;
      }
      setStatus(normalized);
      setStatusState('ready');
    }).catch(function () {
      if (alive !== true || aliveRef.current !== true) return;
      setStatus({ available: false, provider: '', model: '', reason: '读取 AI 状态失败', modelSource: '' });
      setStatusState('error');
    });
    return function () {
      alive = false;
      if (statusController && typeof statusController.abort === 'function') {
        try {
          statusController.abort();
        } catch (error) {
          /* 忽略 */
        }
      }
      abortParsing();
      clearTimeout(focusTimer);
      const previous = prevFocusRef.current;
      prevFocusRef.current = null;
      if (previous && typeof previous.focus === 'function') {
        try {
          previous.focus();
        } catch (error) {
          /* 焦点元素可能已经卸载 */
        }
      }
    };
  }, [open]);

  useEffect(function () {
    if (open !== true) return undefined;
    if (typeof document === 'undefined' || typeof document.addEventListener !== 'function') return undefined;
    function onDocumentKeyDown(event) {
      if (!event || event.key !== 'Escape') return;
      if (event.defaultPrevented === true) return;
      if (typeof event.preventDefault === 'function') event.preventDefault();
      if (typeof event.stopPropagation === 'function') event.stopPropagation();
      const close = closeHandlerRef.current;
      if (typeof close === 'function') close();
    }
    document.addEventListener('keydown', onDocumentKeyDown);
    return function () {
      document.removeEventListener('keydown', onDocumentKeyDown);
    };
  }, [open]);

  useEffect(function () {
    if (open !== true || stage !== 'parsing') return undefined;
    setPhase(0);
    const timer = setInterval(function () {
      setPhase(function (value) {
        const current = typeof value === 'number' && isFinite(value) ? value : 0;
        return fpClamp(current + 1, 0, FP_AI_PHASES.length - 1);
      });
    }, 2200);
    return function () {
      clearInterval(timer);
    };
  }, [open, stage]);

  closeHandlerRef.current = requestClose;

  if (open !== true) return null;

  /* ---------------- 渲染片段 ---------------- */

  function renderStatusBanner() {
    if (statusState === 'loading') {
      return h(
        'div',
        { className: 'fp-ai-notice fp-ai-notice--info', role: 'status', 'aria-live': 'polite' },
        h('span', { className: 'fp-ai-notice-icon', 'aria-hidden': 'true' }, h(FpIcon, { name: 'spark', size: 14 })),
        h(
          'div',
          { className: 'fp-ai-notice-body' },
          h('div', { className: 'fp-ai-notice-title' }, '正在检测 AI 服务…'),
          h('p', { className: 'fp-ai-notice-desc' }, '检测结果只影响解析方式，不会阻塞输入 PRD。'),
        ),
      );
    }
    if (statusState === 'error' || status === null) {
      const reason = status !== null && fpAiStr(status.reason) !== '' ? fpAiStr(status.reason) : '无法连接宿主 AI 状态接口';
      return h(
        'div',
        { className: 'fp-ai-notice fp-ai-notice--error', role: 'status', 'aria-live': 'polite' },
        h('span', { className: 'fp-ai-notice-icon', 'aria-hidden': 'true' }, h(FpIcon, { name: 'alert', size: 14 })),
        h(
          'div',
          { className: 'fp-ai-notice-body' },
          h('div', { className: 'fp-ai-notice-title' }, '无法检测 AI 可用性'),
          h('p', { className: 'fp-ai-notice-desc' }, reason + '。仍可尝试解析：模型不可用时会自动退回规则解析。'),
        ),
      );
    }
    if (status.available === true) {
      const model = fpAiStr(status.model);
      const provider = fpAiStr(status.provider);
      let detail = '模型已就绪，解析结果只是提案，确认后才会写入数据。';
      if (model !== '') {
        detail = '模型：' + (provider !== '' ? provider + ' · ' : '') + model + '。解析结果只是提案，确认后才会写入数据。';
      }
      return h(
        'div',
        { className: 'fp-ai-notice fp-ai-notice--ok', role: 'status', 'aria-live': 'polite' },
        h('span', { className: 'fp-ai-notice-icon', 'aria-hidden': 'true' }, h(FpIcon, { name: 'spark', size: 14 })),
        h(
          'div',
          { className: 'fp-ai-notice-body' },
          h('div', { className: 'fp-ai-notice-title' }, h(FpChip, { tone: 'success', dot: true }, 'AI 可用'), h('span', {}, '由模型解析 PRD')),
          h('p', { className: 'fp-ai-notice-desc' }, detail),
        ),
      );
    }
    const reason = fpAiStr(status.reason) !== '' ? fpAiStr(status.reason) : '未配置可用模型';
    return h(
      'div',
      { className: 'fp-ai-notice fp-ai-notice--warn', role: 'status', 'aria-live': 'polite' },
      h('span', { className: 'fp-ai-notice-icon', 'aria-hidden': 'true' }, h(FpIcon, { name: 'alert', size: 14 })),
      h(
        'div',
        { className: 'fp-ai-notice-body' },
        h('div', { className: 'fp-ai-notice-title' }, h(FpChip, { tone: 'warn', dot: true }, 'AI 不可用'), h('span', {}, '将使用规则解析')),
        h('p', { className: 'fp-ai-notice-desc' }, reason + '。规则解析只按标题与表格结构提取节点，结果会明确标注「规则解析」。'),
      ),
    );
  }

  function renderLinePicker() {
    const options = lines.map(function (line) {
      return { value: line.id, label: line.name };
    });
    options.push({ value: FP_AI_NEW_LINE, label: '＋ 新建业务线…' });
    const current = lineId !== '' ? lineId : FP_AI_NEW_LINE;
    const children = [
      h(FpSelect, { key: 'sel', value: current, options: options, ariaLabel: '业务线', onChange: handleLineChange }),
    ];
    if (current === FP_AI_NEW_LINE) {
      children.push(
        h(FpInput, {
          key: 'name',
          value: newLineName,
          placeholder: '输入业务线名称',
          ariaLabel: '新业务线名称',
          onChange: handleNewLineChange,
        }),
      );
    }
    return h('div', { className: 'fp-ai-line-row' }, children);
  }

  function renderInputStage() {
    const source = typeof text === 'string' ? text : '';
    const trimmed = source.replace(/^\s+|\s+$/g, '');
    const charCount = source.length;
    const tooLong = charCount > FP_AI_MAX_CHARS;
    const canParse = trimmed.length >= FP_AI_MIN_CHARS && reading !== true;
    const dropClassName = 'fp-ai-drop' + (dragActive === true ? ' fp-ai-drop--on' : '');
    const children = [
      renderStatusBanner(),
      h(
        FpField,
        {
          key: 'prd',
          label: 'PRD 文本',
          required: true,
          hint: '至少 ' + FP_AI_MIN_CHARS + ' 字；可粘贴或拖入 .md / .txt 文件（仅前端读取，不上传）。',
        },
        h(
          'div',
          { className: dropClassName, onDragOver: handleDragOver, onDragLeave: handleDragLeave, onDrop: handleDrop },
          h(FpTextarea, {
            value: source,
            rows: 9,
            autoFocus: true,
            placeholder: '粘贴 PRD / 需求说明，或把 .md / .txt 文件拖到这里…',
            ariaLabel: 'PRD 文本',
            onChange: handleTextChange,
            onKeyDown: handleTextareaKeyDown,
          }),
          dragActive === true ? h('div', { className: 'fp-ai-drop-hint' }, '松开即可读入文件') : null,
        ),
        h(
          'div',
          { className: 'fp-ai-file-row' },
          h(FpButton, { variant: 'ghost', size: 'sm', icon: 'upload', disabled: reading === true, onClick: pickFile }, reading === true ? '读取中…' : '选择 .md / .txt 文件'),
          h(
            'span',
            { className: 'fp-ai-count' + (tooLong ? ' fp-ai-count--warn' : '') },
            charCount + ' 字' + (tooLong ? '（超过 ' + FP_AI_MAX_CHARS + ' 字，解析时会截断）' : canParse ? '' : '（至少 ' + FP_AI_MIN_CHARS + ' 字）'),
          ),
          h('input', {
            type: 'file',
            ref: fileInputRef,
            className: 'fp-ai-file-input',
            accept: '.md,.markdown,.txt,text/plain,text/markdown',
            tabIndex: -1,
            'aria-hidden': 'true',
            onChange: handleFileChange,
          }),
        ),
      ),
      h(
        'div',
        { key: 'fields', className: 'fp-ai-grid' },
        h(FpField, { key: 'line', label: '业务线（可选）', hint: '可选择已有业务线，或直接填写新名字。' }, renderLinePicker()),
        h(
          FpField,
          { key: 'extra', label: '补充要求（可选）', hint: '例如：节点不超过 8 个、侧重投放流程。' },
          h(FpTextarea, { value: extra, rows: 2, placeholder: '告诉解析器额外约束…', ariaLabel: '补充要求', onChange: handleExtraChange }),
        ),
      ),
    ];
    if (parseError !== null) children.push(renderErrorBlock('input-parse-error', parseError));
    children.push(
      h('p', { key: 'tip', className: 'fp-ai-hint' }, '解析只生成可编辑的提案，不会写入数据；点击「生成项目」后才会创建项目与节点。'),
    );
    return h('div', { className: 'fp-ai-stage fp-ai-stage--input' }, children);
  }

  function renderParsingStage() {
    const source = typeof text === 'string' ? text.replace(/^\s+|\s+$/g, '') : '';
    const preview = source.length > 60 ? source.slice(0, 60) + '…' : source;
    const activePhase = fpClamp(typeof phase === 'number' ? phase : 0, 0, FP_AI_PHASES.length - 1);
    const phaseItems = FP_AI_PHASES.map(function (label, index) {
      let stepClass = 'fp-ai-phase';
      if (index < activePhase) stepClass += ' is-done';
      else if (index === activePhase) stepClass += ' is-active';
      return h(
        'li',
        { key: label, className: stepClass },
        h('span', { className: 'fp-ai-phase-icon', 'aria-hidden': 'true' }, h(FpIcon, { name: index < activePhase ? 'check' : 'dot', size: 12 })),
        h('span', { className: 'fp-ai-phase-label' }, label + (index === activePhase ? '…' : '')),
      );
    });
    return h(
      'div',
      { className: 'fp-ai-stage fp-ai-stage--parsing', role: 'status', 'aria-live': 'polite' },
      h(
        'div',
        { className: 'fp-ai-parsing-head' },
        h('span', { className: 'fp-ai-parsing-spinner' }, h(FpSpinner)),
        h(
          'div',
          { className: 'fp-ai-parsing-titles' },
          h('p', { className: 'fp-ai-parsing-title' }, hasProposal === true ? '正在重新解析 PRD…' : '正在解析 PRD…'),
          h('p', { className: 'fp-ai-parsing-desc' }, '通常几秒到一分钟；模型不可用时会自动退回规则解析。'),
        ),
      ),
      h('ol', { className: 'fp-ai-phases' }, phaseItems),
      h('p', { className: 'fp-ai-hint' }, 'PRD：' + (preview !== '' ? preview : '—')),
    );
  }

  function renderErrorBlock(key, message) {
    return h(
      'div',
      { key: key, className: 'fp-ai-error', role: 'alert' },
      h('span', { className: 'fp-ai-error-icon', 'aria-hidden': 'true' }, h(FpIcon, { name: 'alert', size: 13 })),
      h('span', { className: 'fp-ai-error-text' }, message),
    );
  }

  function renderMetaBar() {
    const template = fpAiTemplateInfo(pTemplateId);
    const sourceRaw = meta !== null && fpAiIsObject(meta) ? fpAiStr(meta.source) : '';
    const sourceLabel = sourceRaw === 'llm' ? 'AI 解析' : sourceRaw === 'heuristic' ? '规则解析' : '来源未知';
    const sourceTone = sourceRaw === 'llm' ? 'brand' : sourceRaw === 'heuristic' ? 'warn' : 'muted';
    const model = meta !== null && fpAiIsObject(meta) ? fpAiStr(meta.model) : '';
    const provider = meta !== null && fpAiIsObject(meta) ? fpAiStr(meta.provider) : '';
    const ms = meta !== null && fpAiIsObject(meta) && typeof meta.ms === 'number' && isFinite(meta.ms) ? Math.max(0, Math.round(meta.ms)) : null;
    const truncated = meta !== null && fpAiIsObject(meta) && meta.truncated === true;
    const chips = [
      h(FpChip, { key: 'source', tone: sourceTone, dot: true, title: sourceRaw !== '' ? 'meta.source = ' + sourceRaw : '解析来源未知' }, sourceLabel),
      h(FpChip, { key: 'template', tone: template.tone, dot: true, title: 'templateId = ' + template.id }, template.label),
      h('span', { key: 'template-id', className: 'fp-ai-meta-code' }, 'templateId: ' + template.id),
    ];
    if (model !== '') {
      chips.push(h(FpChip, { key: 'model', tone: 'muted', title: provider !== '' ? 'provider = ' + provider : 'model' }, model));
    }
    if (truncated) chips.push(h(FpChip, { key: 'truncated', tone: 'warn' }, 'PRD 已截断'));
    if (ms !== null) {
      const seconds = ms < 1000 ? ms + ' 毫秒' : (ms / 1000).toFixed(1) + ' 秒';
      chips.push(h('span', { key: 'ms', className: 'fp-ai-meta-text' }, '用时 ' + seconds));
    }
    return h('div', { className: 'fp-ai-meta' }, chips);
  }

  function renderNodeRow(node, index) {
    const fallbackUid = 'fpai-row-' + index;
    const item = fpAiIsObject(node) ? node : {};
    const uid = fpAiStr(item.uid) !== '' ? fpAiStr(item.uid) : fallbackUid;
    const role = fpAiRole(item.assigneeRole);
    const isApproval = fpAiNodeIsApproval(item);
    const list = Array.isArray(pNodes) ? pNodes : [];
    const isLast = index >= list.length - 1;
    const rowClass = 'fp-ai-node' + (isApproval === true ? ' fp-ai-node--approval' : '');
    return h(
      'li',
      { key: uid, className: rowClass },
      h(
        'div',
        { className: 'fp-ai-node-head' },
        h('span', { className: 'fp-ai-node-index', title: '第 ' + (index + 1) + ' 个节点' }, String(index + 1)),
        h(FpInput, {
          value: fpAiStr(item.title),
          placeholder: '节点标题（必填）',
          ariaLabel: '第 ' + (index + 1) + ' 个节点标题',
          autoFocus: item.fresh === true,
          onChange: function (value) {
            updateNode(uid, { title: fpAiRead(value, ''), fresh: false });
          },
        }),
        isApproval === true ? h(FpChip, { tone: 'warn', dot: true, title: '生成后需要设计与产品双角色确认' }, '双角色') : null,
        h(
          'div',
          { className: 'fp-ai-node-tools' },
          h(
            FpIconButton,
            {
              label: '上移',
              title: '上移节点',
              size: 24,
              disabled: index === 0,
              onClick: function () {
                moveNode(uid, -1);
              },
            },
            h(FpIcon, { name: 'arrow-down', size: 12, className: 'fp-ai-flip' }),
          ),
          h(
            FpIconButton,
            {
              label: '下移',
              title: '下移节点',
              size: 24,
              disabled: isLast === true,
              onClick: function () {
                moveNode(uid, 1);
              },
            },
            h(FpIcon, { name: 'arrow-down', size: 12 }),
          ),
          h(
            FpIconButton,
            {
              label: '删除节点',
              title: '删除节点',
              size: 24,
              onClick: function () {
                removeNode(uid);
              },
            },
            h(FpIcon, { name: 'trash', size: 12 }),
          ),
        ),
      ),
      h(
        'div',
        { className: 'fp-ai-node-body' },
        h(FpTextarea, {
          value: fpAiStr(item.detail),
          rows: 2,
          placeholder: '节点说明（可选，最多 200 字）',
          ariaLabel: '第 ' + (index + 1) + ' 个节点说明',
          onChange: function (value) {
            updateNode(uid, { detail: fpAiStr(value).slice(0, 200) });
          },
        }),
        h(
          'div',
          { className: 'fp-ai-node-foot' },
          h('span', { className: 'fp-ai-node-label' }, '负责角色'),
          h(FpSelect, {
            value: role,
            options: FP_AI_ROLE_OPTIONS,
            ariaLabel: '第 ' + (index + 1) + ' 个节点负责角色',
            onChange: function (value) {
              changeRole(uid, value);
            },
          }),
          isApproval === true
            ? h('span', { className: 'fp-ai-hint' }, '生成后需设计 + 产品双角色确认')
            : h('span', { className: 'fp-ai-hint' }, role === '研发' ? '完成后进入待确认' : '完成后解锁下一节点'),
        ),
      ),
    );
  }

  function renderProposalStage() {
    const nodes = Array.isArray(pNodes) ? pNodes : [];
    const warnings = meta !== null && fpAiIsObject(meta) && Array.isArray(meta.warnings) ? meta.warnings : [];
    const template = fpAiTemplateInfo(pTemplateId);
    const children = [renderMetaBar()];
    children.push(
      h(
        'div',
        { key: 'fields', className: 'fp-ai-grid' },
        h(
          FpField,
          { key: 'title', label: '项目标题', required: true },
          h(FpInput, { value: pTitle, placeholder: '例如：活动管理改版', ariaLabel: '项目标题', onChange: handleTitleChange }),
        ),
        h(FpField, { key: 'line', label: '业务线', required: true, hint: '可选择已有业务线，或新建一个名字。' }, renderLinePicker()),
        h(
          FpField,
          { key: 'due', label: '截止日期', hint: '可留空；生成后仍可在项目里修改。' },
          h(
            'div',
            { className: 'fp-ai-line-row' },
            h(FpInput, { type: 'date', value: pDueDate, ariaLabel: '截止日期', onChange: handleDueChange }),
            pDueDate !== ''
              ? h(
                  FpButton,
                  {
                    variant: 'quiet',
                    size: 'sm',
                    onClick: clearDue,
                    title: '清除截止日期',
                  },
                  '清除',
                )
              : null,
            pDueDate !== ''
              ? h('span', { className: 'fp-ai-hint' }, fpAiTry(function () { return fpFmtDay(pDueDate) + ' · ' + fpRelativeDay(pDueDate); }, ''))
              : null,
          ),
        ),
        h(
          FpField,
          { key: 'template', label: '流程模板' },
          h(
            'div',
            { className: 'fp-ai-chip-row' },
            h(FpChip, { tone: template.tone, dot: true, title: 'templateId = ' + template.id }, template.label),
            h('span', { className: 'fp-ai-hint' }, template.desc),
          ),
        ),
      ),
    );
    if (fpAiStr(pSummary) !== '') {
      children.push(
        h(
          'div',
          { key: 'summary', className: 'fp-ai-quote' },
          h('span', { className: 'fp-ai-quote-label' }, '摘要'),
          h('p', { className: 'fp-ai-quote-text' }, fpAiStr(pSummary)),
        ),
      );
    }
    if (fpAiStr(pNotes) !== '') {
      children.push(
        h(
          'div',
          { key: 'notes', className: 'fp-ai-quote fp-ai-quote--muted' },
          h('span', { className: 'fp-ai-quote-label' }, '解析说明'),
          h('p', { className: 'fp-ai-quote-text' }, fpAiStr(pNotes)),
        ),
      );
    }
    if (warnings.length > 0) {
      children.push(
        h(
          'div',
          { key: 'warnings', className: 'fp-ai-warn' },
          h('div', { className: 'fp-ai-warn-head' }, h(FpIcon, { name: 'alert', size: 13 }), h('span', {}, '解析提示')),
          h(
            'ul',
            { className: 'fp-ai-warn-list' },
            warnings.map(function (item, index) {
              return h('li', { key: 'warn-' + index }, item);
            }),
          ),
        ),
      );
    }
    const nodeChildren = [
      h(
        'div',
        { key: 'head', className: 'fp-ai-nodes-head' },
        h('h3', { className: 'fp-ai-nodes-title' }, '流程节点', h('span', { className: 'fp-ai-count' }, nodes.length + ' 个')),
        h('span', { className: 'fp-ai-hint' }, nodes.length >= FP_AI_MAX_NODES ? '最多 ' + FP_AI_MAX_NODES + ' 个节点' : '按执行顺序排列，可上下调整'),
      ),
    ];
    if (nodes.length === 0) {
      nodeChildren.push(
        h(
          'div',
          { key: 'empty', className: 'fp-ai-empty' },
          h('span', { className: 'fp-ai-empty-icon', 'aria-hidden': 'true' }, h(FpIcon, { name: 'flow', size: 18 })),
          h('p', { className: 'fp-ai-empty-text' }, '提案里还没有节点。可以新增一个，或返回修改 PRD 后重新解析。'),
          h(FpButton, { size: 'sm', icon: 'plus', onClick: addNode }, '新增第一个节点'),
        ),
      );
    } else {
      nodeChildren.push(
        h(
          'ul',
          { key: 'list', className: 'fp-ai-node-list' },
          nodes.map(function (node, index) {
            return renderNodeRow(node, index);
          }),
        ),
      );
      if (nodes.length < FP_AI_MAX_NODES) {
        nodeChildren.push(
          h('div', { key: 'add', className: 'fp-ai-node-add' }, h(FpButton, { variant: 'ghost', size: 'sm', icon: 'plus', onClick: addNode }, '在末尾新增节点')),
        );
      }
    }
    children.push(h('section', { key: 'nodes', className: 'fp-ai-nodes' }, nodeChildren));
    children.push(
      h(
        'div',
        { key: 'extras', className: 'fp-ai-details' },
        h(
          'div',
          { className: 'fp-ai-extra-row' },
          h('span', { className: 'fp-ai-extra-label' }, '补充要求'),
          h(FpInput, {
            value: extra,
            placeholder: '重新解析时一起发送（可选）',
            ariaLabel: '补充要求',
            onChange: handleExtraChange,
          }),
        ),
        h(
          'details',
          { className: 'fp-ai-src' },
          h('summary', { className: 'fp-ai-src-summary' }, '查看 / 编辑 PRD 原文'),
          h(FpTextarea, {
            value: typeof text === 'string' ? text : '',
            rows: 6,
            ariaLabel: 'PRD 原文',
            onChange: handleTextChange,
          }),
        ),
      ),
    );
    if (parseError !== null) children.push(renderErrorBlock('proposal-parse-error', parseError));
    if (applyError !== null) children.push(renderErrorBlock('proposal-apply-error', applyError));
    return h('div', { className: 'fp-ai-stage fp-ai-stage--proposal' }, children);
  }

  function renderParseButtonLabel() {
    if (statusState === 'loading') return '解析 PRD';
    if (status !== null && fpAiIsObject(status) && status.available === false) return '规则解析';
    if (statusState === 'error') return '尝试解析';
    return '解析 PRD';
  }

  function renderFooter() {
    const actions = [];
    let hint = '';
    if (stage === 'parsing') {
      hint = '解析进行中，可随时取消；已输入的内容不会丢失。';
      actions.push(h(FpButton, { key: 'cancel-parse', variant: 'ghost', onClick: cancelParsing }, '取消解析'));
    } else if (stage === 'proposal' && hasProposal === true) {
      hint = '确认后创建项目、流程与 ' + (Array.isArray(pNodes) ? pNodes.length : 0) + ' 个节点。';
      actions.push(
        h(
          FpButton,
          {
            key: 'reparse',
            variant: 'ghost',
            size: 'sm',
            icon: 'refresh',
            disabled: applying === true,
            onClick: function () {
              beginParse(true);
            },
          },
          '重新解析',
        ),
      );
      actions.push(h(FpButton, { key: 'cancel', variant: 'ghost', disabled: applying === true, onClick: requestClose }, FP_T('common.cancel', '取消')));
      actions.push(
        h(
          FpButton,
          { key: 'apply', variant: 'primary', icon: 'check', disabled: applying === true, onClick: applyProposal },
          applying === true ? '生成中…' : '生成项目',
        ),
      );
    } else {
      const source = typeof text === 'string' ? text : '';
      const canParse = source.replace(/^\s+|\s+$/g, '').length >= FP_AI_MIN_CHARS && reading !== true;
      hint = canParse ? '解析只生成提案，不写入数据。' : '至少输入 ' + FP_AI_MIN_CHARS + ' 个字才能解析。';
      actions.push(h(FpButton, { key: 'cancel', variant: 'ghost', onClick: requestClose }, FP_T('common.cancel', '取消')));
      actions.push(
        h(
          FpButton,
          { key: 'parse', variant: 'primary', icon: 'spark', disabled: canParse !== true, onClick: function () { beginParse(false); } },
          renderParseButtonLabel(),
        ),
      );
    }
    return h(
      'footer',
      { className: 'fp-ai-foot' },
      h('div', { className: 'fp-ai-foot-hint' }, hint),
      h('div', { className: 'fp-ai-foot-actions' }, actions),
    );
  }

  let body = null;
  if (stage === 'parsing') body = renderParsingStage();
  else if (stage === 'proposal' && hasProposal === true) body = renderProposalStage();
  else body = renderInputStage();

  return h(
    'div',
    { className: 'fp-ai-layer' },
    h('button', {
      type: 'button',
      className: 'fp-ai-backdrop',
      'aria-label': '关闭 AI 建流程对话框',
      tabIndex: -1,
      onClick: requestClose,
    }),
    h(
      'div',
      {
        ref: cardRef,
        className: 'fp-ai-card',
        role: 'dialog',
        'aria-modal': 'true',
        'aria-labelledby': 'fp-ai-dialog-title',
        'aria-busy': applying === true || stage === 'parsing' ? 'true' : undefined,
        tabIndex: -1,
      },
      h(
        'header',
        { className: 'fp-ai-head' },
        h(
          'div',
          { className: 'fp-ai-head-main' },
          h('span', { className: 'fp-ai-head-icon', 'aria-hidden': 'true' }, h(FpIcon, { name: 'spark', size: 16 })),
          h(
            'div',
            { className: 'fp-ai-head-titles' },
            h('h2', { className: 'fp-ai-title', id: 'fp-ai-dialog-title' }, 'AI 建流程'),
            h('p', { className: 'fp-ai-subtitle' }, '粘贴 PRD，解析成项目与流程节点；确认后才会写入。'),
          ),
        ),
        h(
          FpIconButton,
          { label: '关闭', title: '关闭（Esc）', size: 26, disabled: applying === true, onClick: requestClose },
          h(FpIcon, { name: 'x', size: 13 }),
        ),
      ),
      h('div', { className: 'fp-ai-body' }, body),
      renderFooter(),
    ),
  );
}

/* ------------------------------------------------------------------ *
 * 样式：遮罩 + 居中卡片（宽 min(760px, 92vw)，内容独立滚动，<720px 全屏）
 * 只使用 CSS_BASE 的 --fp-* 令牌：灰阶面分层、4 栅格间距、无描边、无写死颜色。
 * ------------------------------------------------------------------ */

const CSS_AI = String.raw`
/* ================================================================== *
 * AI 建流程对话框（AI-PRD-DIALOG §5）
 * 视觉规范：docs/UI-DESIGN.md —— 浮层 = --fp-overlay + radius-xl +
 * --fp-shadow-3，无描边；内容用灰阶面（surface / surface-2）分层。
 * ================================================================== */

.fp-ai-layer {
  position: fixed;
  inset: 0;
  z-index: 930;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: var(--fp-sp-6);
  box-sizing: border-box;
  font-size: var(--fp-font-md);
  line-height: 1.55;
  color: var(--fp-text);
  -webkit-font-smoothing: antialiased;
}
.fp-ai-layer *,
.fp-ai-layer *::before,
.fp-ai-layer *::after {
  box-sizing: border-box;
}
.fp-ai-backdrop {
  position: absolute;
  inset: 0;
  padding: 0;
  margin: 0;
  border: 0;
  background: var(--fp-mask);
  backdrop-filter: blur(2px);
  cursor: default;
}
.fp-ai-backdrop:focus-visible {
  outline: none;
}
.fp-ai-card {
  position: relative;
  z-index: 1;
  display: flex;
  flex-direction: column;
  width: min(760px, 92vw);
  max-width: min(calc(100vw - 48px), 920px);
  max-height: calc(100vh - 48px);
  border-radius: var(--fp-radius-xl);
  background: var(--fp-overlay);
  color: var(--fp-text);
  box-shadow: var(--fp-shadow-3);
  overflow: hidden;
  outline: none;
  animation: fp-ai-in 160ms ease-out;
}
@keyframes fp-ai-in {
  from { opacity: 0; transform: translateY(8px) scale(0.995); }
  to { opacity: 1; transform: none; }
}
.fp-ai-card :focus-visible {
  outline: 2px solid color-mix(in srgb, var(--fp-accent) 55%, transparent);
  outline-offset: 1px;
}
.fp-ai-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--fp-sp-3);
  flex: none;
  padding: var(--fp-sp-4) var(--fp-sp-5) var(--fp-sp-3);
  background: var(--fp-surface-2);
  border-radius: var(--fp-radius-xl) var(--fp-radius-xl) 0 0;
}
.fp-ai-head-main {
  display: flex;
  align-items: flex-start;
  gap: var(--fp-sp-3);
  min-width: 0;
}
.fp-ai-head-icon {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  border-radius: var(--fp-radius-md);
  background: var(--fp-accent-soft);
  color: var(--fp-accent-strong);
}
.fp-ai-head-titles {
  min-width: 0;
}
.fp-ai-title {
  margin: 0;
  font-size: var(--fp-font-lg);
  font-weight: 650;
  line-height: 1.4;
  color: var(--fp-text);
}
.fp-ai-subtitle {
  margin: var(--fp-sp-1) 0 0;
  font-size: var(--fp-font-sm);
  line-height: 1.5;
  color: var(--fp-text-tertiary);
}
.fp-ai-body {
  display: flex;
  flex-direction: column;
  gap: var(--fp-sp-3);
  flex: 1 1 auto;
  min-height: 0;
  max-height: 78vh;
  overflow: auto;
  padding: var(--fp-sp-4) var(--fp-sp-5);
  scrollbar-width: thin;
  scrollbar-color: color-mix(in srgb, var(--fp-text-tertiary) 34%, transparent) transparent;
}
.fp-ai-body::-webkit-scrollbar {
  width: 8px;
  height: 8px;
}
.fp-ai-body::-webkit-scrollbar-thumb {
  background: color-mix(in srgb, var(--fp-text-tertiary) 30%, transparent);
  border-radius: var(--fp-radius-pill);
}
.fp-ai-body::-webkit-scrollbar-track {
  background: transparent;
}
.fp-ai-stage {
  display: flex;
  flex-direction: column;
  gap: var(--fp-sp-3);
  min-width: 0;
}
.fp-ai-notice {
  display: flex;
  align-items: flex-start;
  gap: var(--fp-sp-3);
  padding: var(--fp-sp-3);
  border-radius: var(--fp-radius-md);
  background: var(--fp-surface-2);
  min-width: 0;
}
.fp-ai-notice--info {
  background: color-mix(in srgb, var(--fp-info) 10%, var(--fp-surface-2));
}
.fp-ai-notice--ok {
  background: color-mix(in srgb, var(--fp-ok) 12%, var(--fp-surface-2));
}
.fp-ai-notice--warn {
  background: color-mix(in srgb, var(--fp-warn) 16%, var(--fp-surface-2));
}
.fp-ai-notice--error {
  background: color-mix(in srgb, var(--fp-bad) 12%, var(--fp-surface-2));
}
.fp-ai-notice-icon {
  flex: none;
  display: inline-flex;
  margin-top: 0;
  color: var(--fp-text-tertiary);
}
.fp-ai-notice--info .fp-ai-notice-icon {
  color: var(--fp-info);
}
.fp-ai-notice--ok .fp-ai-notice-icon {
  color: var(--fp-ok);
}
.fp-ai-notice--warn .fp-ai-notice-icon {
  color: var(--fp-warn-strong);
}
.fp-ai-notice--error .fp-ai-notice-icon {
  color: var(--fp-bad);
}
.fp-ai-notice-body {
  min-width: 0;
  flex: 1 1 auto;
}
.fp-ai-notice-title {
  display: flex;
  align-items: center;
  gap: var(--fp-sp-1);
  flex-wrap: wrap;
  font-size: var(--fp-font-sm);
  font-weight: 600;
  color: var(--fp-text);
}
.fp-ai-notice-desc {
  margin: var(--fp-sp-1) 0 0;
  font-size: var(--fp-font-sm);
  line-height: 1.55;
  color: var(--fp-text-dim);
  overflow-wrap: anywhere;
}
.fp-ai-hint {
  margin: 0;
  font-size: var(--fp-font-sm);
  line-height: 1.55;
  color: var(--fp-text-tertiary);
  overflow-wrap: anywhere;
}
.fp-ai-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: var(--fp-sp-3) var(--fp-sp-4);
  align-items: start;
  min-width: 0;
}
.fp-ai-chip-row {
  display: flex;
  align-items: center;
  gap: var(--fp-sp-2);
  flex-wrap: wrap;
  min-width: 0;
}
.fp-ai-drop {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: var(--fp-sp-2);
  min-width: 0;
}
.fp-ai-drop .fp-textarea {
  min-height: 160px;
  resize: vertical;
}
.fp-ai-drop--on {
  outline: 2px dashed color-mix(in srgb, var(--fp-accent) 55%, transparent);
  outline-offset: var(--fp-sp-1);
  border-radius: var(--fp-radius-md);
}
.fp-ai-drop-hint {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: var(--fp-radius-md);
  background: color-mix(in srgb, var(--fp-accent) 12%, var(--fp-surface));
  color: var(--fp-accent-strong);
  font-size: var(--fp-font-md);
  font-weight: 600;
  pointer-events: none;
  outline: 2px dashed color-mix(in srgb, var(--fp-accent) 45%, transparent);
  outline-offset: -2px;
}
.fp-ai-file-row {
  display: flex;
  align-items: center;
  gap: var(--fp-sp-3);
  flex-wrap: wrap;
  min-width: 0;
}
.fp-ai-file-input {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: 0;
  overflow: hidden;
  clip-path: inset(50%);
  border: 0;
}
.fp-ai-count {
  font-size: var(--fp-font-xs);
  color: var(--fp-text-tertiary);
  font-variant-numeric: tabular-nums;
}
.fp-ai-count--warn {
  color: var(--fp-warn-strong);
}
.fp-ai-line-row {
  display: flex;
  align-items: center;
  gap: var(--fp-sp-2);
  flex-wrap: wrap;
  min-width: 0;
}
.fp-ai-line-row > .fp-select-wrap {
  flex: 1 1 172px;
  min-width: 0;
}
.fp-ai-line-row > .fp-input {
  flex: 1 1 152px;
  min-width: 0;
}
.fp-ai-line-row > .fp-input[type="date"] {
  flex: 0 0 auto;
  width: 156px;
}
.fp-ai-error {
  display: flex;
  align-items: flex-start;
  gap: var(--fp-sp-2);
  padding: var(--fp-sp-2) var(--fp-sp-3);
  border-radius: var(--fp-radius-md);
  background: color-mix(in srgb, var(--fp-bad) 12%, transparent);
  color: var(--fp-bad);
  font-size: var(--fp-font-sm);
  line-height: 1.55;
  overflow-wrap: anywhere;
}
.fp-ai-error-icon {
  flex: none;
  display: inline-flex;
  margin-top: 0;
}
.fp-ai-error-text {
  min-width: 0;
}
.fp-ai-meta {
  display: flex;
  align-items: center;
  gap: var(--fp-sp-1) var(--fp-sp-2);
  flex-wrap: wrap;
  min-width: 0;
}
.fp-ai-meta-text {
  font-size: var(--fp-font-sm);
  color: var(--fp-text-tertiary);
  font-variant-numeric: tabular-nums;
}
.fp-ai-meta-code {
  font-family: var(--fp-mono);
  font-size: 10.5px;
  color: var(--fp-text-tertiary);
  overflow-wrap: anywhere;
}
.fp-ai-quote {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: var(--fp-sp-1);
  padding: var(--fp-sp-3) var(--fp-sp-3) var(--fp-sp-3) var(--fp-sp-4);
  border-radius: var(--fp-radius-md);
  background: var(--fp-surface-2);
  min-width: 0;
}
.fp-ai-quote::before {
  content: '';
  position: absolute;
  left: 0;
  top: var(--fp-sp-3);
  bottom: var(--fp-sp-3);
  width: 3px;
  border-radius: var(--fp-radius-pill);
  background: var(--fp-accent);
}
.fp-ai-quote--muted::before {
  background: var(--fp-text-quaternary);
}
.fp-ai-quote-label {
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.05em;
  text-transform: uppercase;
  color: var(--fp-text-tertiary);
}
.fp-ai-quote-text {
  margin: 0;
  font-size: var(--fp-font-sm);
  line-height: 1.6;
  color: var(--fp-text-dim);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.fp-ai-warn {
  display: flex;
  flex-direction: column;
  gap: var(--fp-sp-2);
  padding: var(--fp-sp-3);
  border-radius: var(--fp-radius-md);
  background: color-mix(in srgb, var(--fp-warn) 14%, var(--fp-surface-2));
  min-width: 0;
}
.fp-ai-warn-head {
  display: flex;
  align-items: center;
  gap: var(--fp-sp-1);
  font-size: var(--fp-font-sm);
  font-weight: 600;
  color: var(--fp-warn-strong);
}
.fp-ai-warn-list {
  margin: 0;
  padding: 0 0 0 var(--fp-sp-5);
  display: flex;
  flex-direction: column;
  gap: var(--fp-sp-1);
  font-size: var(--fp-font-sm);
  line-height: 1.55;
  color: var(--fp-text-dim);
  overflow-wrap: anywhere;
}
.fp-ai-nodes {
  display: flex;
  flex-direction: column;
  gap: var(--fp-sp-3);
  min-width: 0;
}
.fp-ai-nodes-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: var(--fp-sp-2);
  flex-wrap: wrap;
}
.fp-ai-nodes-title {
  display: flex;
  align-items: center;
  gap: var(--fp-sp-2);
  margin: 0;
  font-size: var(--fp-font-md);
  font-weight: 650;
  color: var(--fp-text);
}
.fp-ai-node-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: var(--fp-sp-2);
}
.fp-ai-node {
  display: flex;
  flex-direction: column;
  gap: var(--fp-sp-2);
  padding: var(--fp-sp-3);
  border-radius: var(--fp-radius-md);
  background: var(--fp-surface-2);
  min-width: 0;
}
.fp-ai-node--approval {
  background: color-mix(in srgb, var(--fp-warn) 12%, var(--fp-surface-2));
}
.fp-ai-node-head {
  display: flex;
  align-items: center;
  gap: var(--fp-sp-2);
  min-width: 0;
}
.fp-ai-node-index {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  border-radius: var(--fp-radius-pill);
  background: var(--fp-surface);
  color: var(--fp-text-dim);
  font-size: 10.5px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}
.fp-ai-node-head > .fp-input {
  flex: 1 1 auto;
  min-width: 0;
}
.fp-ai-node-tools {
  display: flex;
  align-items: center;
  gap: var(--fp-sp-1);
  flex: none;
}
.fp-ai-flip {
  transform: rotate(180deg);
}
.fp-ai-node-body {
  display: flex;
  flex-direction: column;
  gap: var(--fp-sp-2);
  min-width: 0;
}
.fp-ai-node-body .fp-textarea {
  min-height: 48px;
  resize: vertical;
}
.fp-ai-node-foot {
  display: flex;
  align-items: center;
  gap: var(--fp-sp-2);
  flex-wrap: wrap;
  min-width: 0;
}
.fp-ai-node-label {
  font-size: var(--fp-font-sm);
  color: var(--fp-text-tertiary);
}
.fp-ai-node-foot .fp-select-wrap {
  width: 132px;
  flex: none;
}
.fp-ai-node-add {
  display: flex;
}
.fp-ai-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--fp-sp-2);
  padding: var(--fp-sp-6) var(--fp-sp-3);
  border-radius: var(--fp-radius-lg);
  background: var(--fp-surface-2);
  color: var(--fp-text-dim);
  text-align: center;
}
.fp-ai-empty-icon {
  display: inline-flex;
  color: var(--fp-text-tertiary);
}
.fp-ai-empty-text {
  margin: 0;
  font-size: var(--fp-font-sm);
  line-height: 1.6;
}
.fp-ai-details {
  display: flex;
  flex-direction: column;
  gap: var(--fp-sp-3);
  padding-top: var(--fp-sp-3);
  min-width: 0;
}
.fp-ai-extra-row {
  display: flex;
  align-items: center;
  gap: var(--fp-sp-2);
  min-width: 0;
}
.fp-ai-extra-label {
  flex: none;
  font-size: var(--fp-font-sm);
  color: var(--fp-text-tertiary);
}
.fp-ai-extra-row > .fp-input {
  flex: 1 1 auto;
  min-width: 0;
}
.fp-ai-src {
  padding: 0 var(--fp-sp-3);
  border-radius: var(--fp-radius-md);
  background: var(--fp-surface-2);
  min-width: 0;
}
.fp-ai-src[open] {
  padding-bottom: var(--fp-sp-3);
}
.fp-ai-src-summary {
  display: flex;
  align-items: center;
  gap: var(--fp-sp-1);
  padding: var(--fp-sp-2) 0;
  list-style: none;
  font-size: var(--fp-font-sm);
  color: var(--fp-text-dim);
  cursor: pointer;
}
.fp-ai-src-summary::-webkit-details-marker {
  display: none;
}
.fp-ai-src .fp-textarea {
  min-height: 120px;
}
.fp-ai-parsing-head {
  display: flex;
  align-items: center;
  gap: var(--fp-sp-3);
  padding: var(--fp-sp-4);
  border-radius: var(--fp-radius-lg);
  background: var(--fp-surface-2);
  min-width: 0;
}
.fp-ai-parsing-spinner {
  display: inline-flex;
  flex: none;
  color: var(--fp-accent);
}
.fp-ai-parsing-titles {
  min-width: 0;
}
.fp-ai-parsing-title {
  margin: 0;
  font-size: var(--fp-font-lg);
  font-weight: 650;
  color: var(--fp-text);
}
.fp-ai-parsing-desc {
  margin: var(--fp-sp-1) 0 0;
  font-size: var(--fp-font-sm);
  line-height: 1.55;
  color: var(--fp-text-dim);
}
.fp-ai-stage--parsing {
  justify-content: center;
  padding: var(--fp-sp-2) 0;
}
.fp-ai-phases {
  list-style: none;
  margin: 0;
  padding: 0 var(--fp-sp-1);
  display: flex;
  flex-direction: column;
  gap: var(--fp-sp-2);
}
.fp-ai-phase {
  display: flex;
  align-items: center;
  gap: var(--fp-sp-2);
  font-size: var(--fp-font-sm);
  color: var(--fp-text-tertiary);
}
.fp-ai-phase-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
  width: 20px;
  height: 20px;
  border-radius: var(--fp-radius-pill);
  background: var(--fp-surface-2);
  color: var(--fp-text-tertiary);
}
.fp-ai-phase.fp-is-done {
  color: var(--fp-text-dim);
}
.fp-ai-phase.fp-is-done .fp-ai-phase-icon {
  background: color-mix(in srgb, var(--fp-ok) 14%, transparent);
  color: var(--fp-ok);
}
.fp-ai-phase.fp-is-active {
  color: var(--fp-text);
  font-weight: 600;
}
.fp-ai-phase.fp-is-active .fp-ai-phase-icon {
  background: var(--fp-accent-soft);
  color: var(--fp-accent-strong);
  animation: fp-ai-pulse 1.6s ease-in-out infinite;
}
@keyframes fp-ai-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.45; }
}
.fp-ai-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--fp-sp-3);
  flex: none;
  flex-wrap: wrap;
  padding: var(--fp-sp-3) var(--fp-sp-5);
  background: var(--fp-surface-2);
  border-radius: 0 0 var(--fp-radius-xl) var(--fp-radius-xl);
}
.fp-ai-foot-hint {
  flex: 1 1 180px;
  min-width: 0;
  font-size: var(--fp-font-sm);
  line-height: 1.5;
  color: var(--fp-text-tertiary);
  overflow-wrap: anywhere;
}
.fp-ai-foot-actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: var(--fp-sp-2);
  flex-wrap: wrap;
}
@media (max-width: 719px) {
  .fp-ai-layer {
    padding: 0;
  }
  .fp-ai-card {
    width: 100vw;
    max-width: 100vw;
    height: 100vh;
    height: 100dvh;
    max-height: 100vh;
    max-height: 100dvh;
    border: 0;
    border-radius: 0;
  }
  .fp-ai-head {
    padding: var(--fp-sp-4);
    border-radius: 0;
  }
  .fp-ai-body {
    max-height: none;
    padding: var(--fp-sp-4) var(--fp-sp-4) var(--fp-sp-6);
  }
  .fp-ai-foot {
    padding: var(--fp-sp-3) var(--fp-sp-4);
    border-radius: 0;
  }
  .fp-ai-grid {
    grid-template-columns: minmax(0, 1fr);
  }
  .fp-ai-node-head {
    flex-wrap: wrap;
  }
  .fp-ai-node-head > .fp-input {
    flex: 1 1 calc(100% - 28px);
  }
  .fp-ai-node-tools {
    margin-left: var(--fp-sp-8);
  }
  .fp-ai-foot-actions {
    width: 100%;
  }
  .fp-ai-foot-actions .fp-btn--primary {
    flex: 1 1 auto;
  }
}
@media (prefers-reduced-motion: reduce) {
  .fp-ai-card {
    animation: none;
  }
  .fp-ai-phase.fp-is-active .fp-ai-phase-icon {
    animation: none;
  }
}
`;
