/**
 * FlowPilot 宿主半 · 本地网页访问（只读）
 *
 * 用途：设置里打开「本地网页访问」后，在 127.0.0.1:<port> 起一个只读小服务，
 * 用户可以用任意浏览器（甚至手机，如果将来放开绑定）直接查看今日待办与项目进度，
 * 不依赖 DSH 的 Web UI。默认只绑定 127.0.0.1，只读，没有任何写入口。
 *
 * 配置落盘：<dataDir>/web-access.json（机器本地偏好，不进 data.json / 同步 / 导出）。
 *
 * 约束：只 import `node:` 内置模块；与框架无关，便于自测。
 */
import { createServer } from 'node:http'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { FpError } from './util.js'

const DEFAULT_PORT = 4173
const MIN_PORT = 1024
const MAX_PORT = 65535
const BIND_HOST = '127.0.0.1'

function readConfigFile(file) {
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8'))
    return raw !== null && typeof raw === 'object' ? raw : {}
  } catch {
    return {}
  }
}

function writeConfigFile(file, value) {
  mkdirSync(dirname(file), { recursive: true })
  const tmp = file + '.tmp'
  writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', 'utf8')
  renameSync(tmp, file)
}

function normalizePort(value) {
  if (value === undefined || value === null || value === '') return null
  const port = Number(value)
  if (!Number.isInteger(port) || port < MIN_PORT || port > MAX_PORT) {
    throw new FpError('INVALID_INPUT', `端口必须是 ${MIN_PORT}–${MAX_PORT} 之间的整数`)
  }
  return port
}

function esc(value) {
  return String(value === null || value === undefined ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/** 把 engine.snapshot() 收敛成只读页面需要的轻量结构。 */
function buildSummary(engine) {
  const snap = engine.snapshot()
  const state = snap.state || {}
  const derived = snap.derived || {}
  const lines = Array.isArray(state.businessLines) ? state.businessLines : []
  const projects = Array.isArray(state.projects) ? state.projects : []
  const lineName = (id) => {
    const hit = lines.filter((line) => line && line.id === id)[0]
    return hit && typeof hit.name === 'string' ? hit.name : ''
  }
  const today = derived.today || {}
  const card = (item) => ({
    code: typeof item.code === 'string' ? item.code : '',
    title: typeof item.title === 'string' ? item.title : '',
    projectTitle: typeof item.projectTitle === 'string' ? item.projectTitle : '',
    status: typeof item.status === 'string' ? item.status : '',
    dueAt: typeof item.dueAt === 'string' ? item.dueAt : null,
  })
  const activeProjects = projects
    .filter((project) => project && project.status !== 'archived')
    .map((project) => {
      const info = derived.projects && derived.projects[project.id] ? derived.projects[project.id] : {}
      return {
        title: typeof project.title === 'string' ? project.title : '未命名项目',
        line: lineName(project.businessLineId),
        progress: typeof info.progress === 'number' ? Math.round(info.progress * 100) : 0,
        currentCode: typeof info.currentCode === 'string' ? info.currentCode : '',
        currentStage: typeof info.currentStage === 'string' ? info.currentStage : '',
        nextDueAt: typeof info.nextDueAt === 'string' ? info.nextDueAt : null,
        total: Number(info.total) || 0,
        completed: Number(info.completed) || 0,
      }
    })
  return {
    generatedAt: new Date().toISOString(),
    revision: snap.revision,
    counts: {
      actionable: Number(derived.counts && derived.counts.actionable) || 0,
      waiting: Number(derived.counts && derived.counts.waiting) || 0,
      overdue: Number(derived.counts && derived.counts.overdue) || 0,
    },
    today: {
      recommended: (today.recommended || []).map(card),
      followUps: (today.followUps || []).map(card),
      upcoming: (today.upcoming || []).map(card),
    },
    lines: lines.map((line) => ({
      name: typeof line.name === 'string' ? line.name : '',
      projectCount: activeProjects.filter((project) => project.line === line.name).length,
    })),
    projects: activeProjects,
  }
}

/** 只读页面（无外部依赖、无内联外部资源；深色随系统）。 */
function buildPage() {
  return String.raw`<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>FlowPilot · 只读看板</title>
<style>
:root{color-scheme:light dark;--bg:#f6f7f8;--surface:#fff;--surface2:#f1f2f3;--text:#0d0e10;--dim:#61666d;--ter:#9499a0;--accent:#b753ff;--warn:#ff7f24;--bad:#f85a54;--ok:#07aa43}
@media (prefers-color-scheme:dark){:root{--bg:#17181a;--surface:#1d1f23;--surface2:#0d0e10;--text:#f0f1f2;--dim:#a9adb3;--ter:#9499a0}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font:14px/1.55 -apple-system,BlinkMacSystemFont,"PingFang SC","Segoe UI",sans-serif;padding:20px}
.wrap{max-width:760px;margin:0 auto;display:flex;flex-direction:column;gap:12px}
header{display:flex;align-items:baseline;gap:8px}
h1{font-size:17px;margin:0}
.badge{font-size:11px;color:var(--ter);border-radius:999px;background:var(--surface2);padding:2px 8px}
.stamp{margin-left:auto;font-size:11px;color:var(--ter)}
.stats{display:grid;grid-template-columns:repeat(3,1fr);gap:8px}
.stat{background:var(--surface2);border-radius:12px;padding:12px}
.stat b{display:block;font-size:20px;font-variant-numeric:tabular-nums}
.stat span{font-size:11px;color:var(--dim)}
.card{background:var(--surface);border-radius:14px;padding:12px}
.card h2{font-size:12px;color:var(--dim);margin:0 0 8px;font-weight:600}
.row{display:flex;align-items:center;gap:8px;padding:8px 4px;border-radius:8px}
.row:hover{background:var(--surface2)}
.code{font:600 10px/1 "SF Mono",Menlo,monospace;color:var(--dim);background:var(--surface2);border-radius:4px;padding:4px 5px;min-width:34px;text-align:center}
.title{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1}
.sub{font-size:11px;color:var(--ter);min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.due{font-size:11px;color:var(--warn);white-space:nowrap}
.due.bad{color:var(--bad)}
.bar{height:3px;background:var(--surface2);border-radius:999px;overflow:hidden;margin-top:6px}
.bar i{display:block;height:100%;background:color-mix(in srgb,var(--accent) 72%,transparent);border-radius:999px}
.proj{padding:10px 4px}
.proj .top{display:flex;align-items:center;gap:8px}
.tag{font-size:10px;color:var(--ter);background:var(--surface2);border-radius:999px;padding:2px 8px;white-space:nowrap}
.empty{color:var(--ter);font-size:12px;padding:4px}
footer{color:var(--ter);font-size:11px;text-align:center;padding:8px 0 16px}
</style></head>
<body><div class="wrap">
<header><h1>FlowPilot</h1><span class="badge">只读</span><span class="stamp" id="stamp">加载中…</span></header>
<div class="stats">
<div class="stat"><b id="n-actionable">-</b><span>可推进</span></div>
<div class="stat"><b id="n-waiting">-</b><span>待跟进</span></div>
<div class="stat"><b id="n-overdue">-</b><span>逾期</span></div>
</div>
<div class="card"><h2>今日推荐</h2><div id="today"></div></div>
<div class="card"><h2>项目进度</h2><div id="projects"></div></div>
<footer>本页面只读；数据来自本机 FlowPilot，刷新间隔 10 秒。</footer>
</div>
<script>
function esc(s){return String(s==null?"":s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");}
function day(s){ if(!s) return ""; var d=parseDate(s); if(!d) return ""; return (d.getMonth()+1)+"月"+d.getDate()+"日"; }
function parseDate(s){ var t=Date.parse(s); if(!isFinite(t)) return null; return new Date(t); }
function dueText(s){ var d=parseDate(s); if(!d) return ""; var now=new Date(); var a=new Date(now.getFullYear(),now.getMonth(),now.getDate()); var b=new Date(d.getFullYear(),d.getMonth(),d.getDate()); var days=Math.round((b-a)/86400000); if(days<0) return {t:"逾期 "+Math.abs(days)+" 天",bad:true}; if(days===0) return {t:"今天",bad:false}; if(days===1) return {t:"明天",bad:false}; return {t:day(s),bad:false}; }
function row(item){
  var due=dueText(item.dueAt);
  var line='<div class="row"><span class="code">'+esc(item.code||"·")+'</span><div style="min-width:0;flex:1"><div class="title">'+esc(item.title)+'</div>'+(item.projectTitle?'<div class="sub">'+esc(item.projectTitle)+'</div>':'')+'</div>';
  if(due) line+='<span class="due'+(due.bad?' bad':'')+'">'+esc(due.t)+'</span>';
  return line+'</div>';
}
function render(data){
  document.getElementById("n-actionable").textContent=data.counts.actionable;
  document.getElementById("n-waiting").textContent=data.counts.waiting;
  document.getElementById("n-overdue").textContent=data.counts.overdue;
  var rec=data.today.recommended;
  document.getElementById("today").innerHTML=rec.length?rec.map(row).join(""):'<div class="empty">当前没有需要优先处理的节点</div>';
  var ps=data.projects;
  document.getElementById("projects").innerHTML=ps.length?ps.map(function(p){
    var due=dueText(p.nextDueAt);
    return '<div class="proj"><div class="top"><span class="title">'+esc(p.title)+'</span>'+(p.line?'<span class="tag">'+esc(p.line)+'</span>':'')+(due?'<span class="due'+(due.bad?' bad':'')+'">'+esc(due.t)+'</span>':'')+'</div>'
      +'<div class="sub">'+esc(p.currentCode?p.currentCode+" · "+p.currentStage:p.currentStage||"尚未开始")+' · '+p.completed+'/'+p.total+'</div>'
      +'<div class="bar"><i style="width:'+p.progress+'%"></i></div></div>';
  }).join(""):'<div class="empty">还没有项目</div>';
  document.getElementById("stamp").textContent="更新于 "+new Date().toLocaleTimeString();
}
function load(){
  fetch("/api/summary",{cache:"no-store"}).then(function(r){return r.json()}).then(render).catch(function(e){
    document.getElementById("stamp").textContent="读取失败："+e.message;
  });
}
load(); setInterval(load,10000);
</script>
</body></html>`
}

export function createWebAccessService({ engine, logger, configFile } = {}) {
  if (!engine || typeof engine.snapshot !== 'function') throw new Error('createWebAccessService 需要 engine')
  const resolvedFile = typeof configFile === 'string' && configFile !== ''
    ? configFile
    : join(dirname(engine.dataFile), 'web-access.json')
  const saved = readConfigFile(resolvedFile)
  let enabled = saved.enabled === true
  let port = Number.isInteger(saved.port) && saved.port >= MIN_PORT && saved.port <= MAX_PORT ? saved.port : DEFAULT_PORT
  let server = null
  let actualPort = null
  let startedAt = null
  let lastError = null

  function persist() {
    try {
      writeConfigFile(resolvedFile, { enabled, port })
    } catch (error) {
      logger?.warn?.(`[flowpilot:web] 保存网页访问配置失败：${error?.message ?? error}`)
    }
  }

  function status() {
    return {
      enabled,
      running: server !== null,
      host: BIND_HOST,
      port: actualPort !== null ? actualPort : port,
      url: server !== null && actualPort !== null ? `http://${BIND_HOST}:${actualPort}/` : null,
      startedAt,
      configFile: resolvedFile,
      error: lastError,
    }
  }

  function handle(req, res) {
    const url = new URL(req.url || '/', `http://${BIND_HOST}`)
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ ok: false, code: 'INVALID_INPUT', error: '只读页面只接受 GET' }))
      return
    }
    try {
      if (url.pathname === '/' || url.pathname === '/index.html') {
        const body = buildPage()
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
        res.end(req.method === 'HEAD' ? undefined : body)
        return
      }
      if (url.pathname === '/api/summary') {
        const body = JSON.stringify(buildSummary(engine))
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
        res.end(req.method === 'HEAD' ? undefined : body)
        return
      }
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('not found')
    } catch (error) {
      logger?.warn?.(`[flowpilot:web] 处理请求失败：${error?.message ?? error}`)
      res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ ok: false, error: '只读页面渲染失败' }))
    }
  }

  function start() {
    if (server !== null) return Promise.resolve(status())
    lastError = null
    return new Promise((resolve, reject) => {
      const next = createServer(handle)
      next.on('error', (error) => {
        lastError = error?.message ?? String(error)
        try {
          next.close()
        } catch {
          /* ignore */
        }
        if (server === next) server = null
        reject(new FpError('INVALID_INPUT', `本地网页启动失败：${lastError}`))
      })
      next.listen(port, BIND_HOST, () => {
        server = next
        const address = next.address()
        actualPort = address && typeof address === 'object' ? address.port : port
        startedAt = new Date().toISOString()
        // 不阻止宿主进程退出；DSH 本身还有其它常驻句柄
        try {
          if (typeof next.unref === 'function') next.unref()
        } catch {
          // 忽略
        }
        logger?.info?.(`[flowpilot:web] 只读网页已启动：http://${BIND_HOST}:${actualPort}/`)
        resolve(status())
      })
    })
  }

  function stop() {
    if (server === null) return Promise.resolve(status())
    const current = server
    server = null
    actualPort = null
    startedAt = null
    return new Promise((resolve) => {
      current.close(() => resolve(status()))
      // 浏览器/fetch 会保持 keep-alive 连接，不主动断开的话 close 回调永远不触发
      try {
        if (typeof current.closeAllConnections === 'function') current.closeAllConnections()
        else if (typeof current.closeIdleConnections === 'function') current.closeIdleConnections()
      } catch {
        // 忽略
      }
    })
  }

  function configure(patch) {
    return Promise.resolve()
      .then(() => {
        if (patch !== null && patch !== undefined && typeof patch !== 'object') {
          throw new FpError('INVALID_INPUT', '配置必须是对象')
        }
        const input = patch !== null && typeof patch === 'object' ? patch : {}
        if (input.enabled !== undefined && typeof input.enabled !== 'boolean') {
          throw new FpError('INVALID_INPUT', 'enabled 必须是布尔值')
        }
        const requestedPort = input.port === undefined ? null : normalizePort(input.port)
        const previousPort = port
        if (requestedPort !== null) port = requestedPort
        if (input.enabled !== undefined) enabled = input.enabled
        persist()
        const portChanged = port !== previousPort
        if (!enabled) return stop()
        if (server !== null && !portChanged) return status()
        return stop().then(() => start())
      })
      .then(() => status())
  }

  function startup() {
    if (!enabled) return Promise.resolve(status())
    return start().catch((error) => {
      lastError = error?.message ?? String(error)
      return status()
    })
  }

  function dispose() {
    return stop()
  }

  return { status, start, stop, configure, startup, dispose, configFile: resolvedFile }
}
