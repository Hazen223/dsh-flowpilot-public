/* FlowPilot 宿主半 · 网页模板（只读看板 / 远程工作台 / 登录页）
 *
 * 独立 HTML/CSS/JS，不依赖 DSH 前端；通过宿主提供的 /api/summary 或 /api/state 取数。
 * 所有页面都跟随系统浅/深色（prefers-color-scheme）。
 */

export function buildReadOnlyPage() {
  return String.raw`<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>FlowPilot · 只读看板</title>
<style>
:root{color-scheme:light dark;--bg:#f6f7f8;--surface:#fff;--surface2:#f1f2f3;--text:#0d0e10;--dim:#61666d;--ter:#9499a0;--accent:#b753ff;--warn:#ff7f24;--bad:#f85a54;--ok:#07aa43}
@media (prefers-color-scheme:dark){:root{--bg:#17181a;--surface:#1d1f23;--surface2:#0d0e10;--text:#f0f1f2;--dim:#a9adb3;--ter:#9499a0;--accent:#bb5cff}}
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

export function buildLoginPage() {
  return String.raw`<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>FlowPilot · 远程工作台</title>
<style>
:root{color-scheme:light dark;--bg:#f6f7f8;--surface:#fff;--surface2:#f1f2f3;--text:#0d0e10;--dim:#61666d;--ter:#9499a0;--accent:#b753ff;--bad:#f85a54}
@media (prefers-color-scheme:dark){:root{--bg:#17181a;--surface:#1d1f23;--surface2:#0d0e10;--text:#f0f1f2;--dim:#a9adb3;--ter:#9499a0;--accent:#bb5cff}}
*{box-sizing:border-box}
html,body{height:100%}
body{margin:0;background:var(--bg);color:var(--text);font:14px/1.55 -apple-system,BlinkMacSystemFont,"PingFang SC","Segoe UI",sans-serif}
.wrap{min-height:100%;display:flex;align-items:center;justify-content:center;padding:24px}
.card{width:100%;max-width:380px;background:var(--surface);border-radius:16px;padding:24px;box-shadow:0 16px 48px rgba(0,0,0,.16);display:flex;flex-direction:column;gap:12px}
h1{margin:0;font-size:17px}
.sub{margin:0;font-size:12px;color:var(--dim)}
label{font-size:12px;color:var(--dim)}
input{width:100%;height:34px;border:0;border-radius:8px;background:var(--surface2);color:var(--text);font:inherit;font-size:13px;padding:0 12px;outline:none;color-scheme:inherit}
input:focus{box-shadow:0 0 0 2px color-mix(in srgb,var(--accent) 45%,transparent)}
button{height:34px;border:0;border-radius:8px;background:var(--text);color:var(--bg);font:inherit;font-size:13px;font-weight:600;cursor:pointer}
button:hover{opacity:.88}
.err{font-size:12px;color:var(--bad)}
.hint{font-size:11px;color:var(--ter);line-height:1.6}
</style></head>
<body><div class="wrap"><div class="card">
<h1>FlowPilot 远程工作台</h1>
<p class="sub">完整读写版本：可查看今日/项目/节点，并直接推进、审批、改计划、写备注。</p>
<p class="err">{{ERROR}}</p>
<form method="post" action="/login">
<label for="token">访问口令</label>
<input id="token" name="token" type="password" autocomplete="current-password" placeholder="粘贴设置里的访问口令" autofocus>
<button type="submit">进入</button>
</form>
<p class="hint">口令在 DSH → 设置 → 网页访问 → 远程工作台 中查看/复制。仅绑定本机 127.0.0.1，请勿把链接发给他人。</p>
</div></div></body></html>`
}

export function buildFullPage() {
  return String.raw`<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>FlowPilot · 远程工作台</title>
<style>
:root{color-scheme:light dark;--bg:#f6f7f8;--surface:#fff;--surface2:#f1f2f3;--well:#f1f2f3;--text:#0d0e10;--dim:#61666d;--ter:#9499a0;--quat:#b4b8bd;--accent:#b753ff;--accent-strong:#ad3bff;--warn:#ff7f24;--warn-strong:#ff7f24;--bad:#f85a54;--ok:#07aa43;--radius:8px;--radius-lg:12px;--shadow:0 4px 16px rgba(13,14,16,.1)}
@media (prefers-color-scheme:dark){:root{--bg:#17181a;--surface:#1d1f23;--surface2:#0d0e10;--well:#0d0e10;--text:#f0f1f2;--dim:rgba(240,241,242,.62);--ter:rgba(240,241,242,.45);--quat:rgba(240,241,242,.3);--accent:#bb5cff;--accent-strong:#ae52f0;--shadow:0 4px 16px rgba(0,0,0,.46)}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font:14px/1.55 -apple-system,BlinkMacSystemFont,"PingFang SC","Segoe UI",sans-serif}
button{font:inherit;cursor:pointer}
.topbar{display:flex;align-items:center;gap:12px;flex-wrap:wrap;padding:12px 16px}
.brand{display:flex;align-items:center;gap:8px;font-weight:650;font-size:15px}
.badge{font-size:10px;color:var(--ter);background:var(--surface2);border-radius:999px;padding:2px 8px}
.stats{display:flex;align-items:center;gap:8px;margin-left:auto;flex-wrap:wrap}
.stat{font-size:12px;color:var(--dim);background:var(--surface2);border-radius:999px;padding:4px 10px;font-variant-numeric:tabular-nums}
.stat b{color:var(--text);font-weight:600}
.stat[data-tone="bad"] b{color:var(--bad)}
.top-btn{height:28px;border:0;border-radius:999px;background:var(--surface2);color:var(--dim);padding:0 12px;font-size:12px}
.top-btn:hover{background:var(--pressed,#e8eaec);color:var(--text)}
main{max-width:860px;margin:0 auto;padding:0 16px 48px;display:flex;flex-direction:column;gap:12px}
.tabs{display:flex;gap:8px;max-width:860px;margin:0 auto;padding:0 16px 8px}
.tab{height:30px;border:0;border-radius:999px;background:transparent;color:var(--dim);padding:0 14px;font-size:13px}
.tab:hover{background:var(--surface2);color:var(--text)}
.tab.on{background:var(--surface);color:var(--text);font-weight:600;box-shadow:0 1px 2px rgba(13,14,16,.06)}
.card{background:var(--surface);border-radius:var(--radius-lg);padding:16px;display:flex;flex-direction:column;gap:12px}
.sec-title{font-size:12px;color:var(--dim);font-weight:600;margin:0}
.row{display:flex;align-items:center;gap:10px;padding:8px 10px;border-radius:10px;background:var(--surface2);min-width:0;cursor:pointer}
.row:hover{background:color-mix(in srgb,var(--surface2) 60%,var(--surface))}
.code{font:600 10px/1 "SF Mono",Menlo,monospace;color:var(--dim);background:var(--surface);border-radius:4px;padding:4px 5px;min-width:36px;text-align:center;flex:none}
.title{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1}
.sub{font-size:11px;color:var(--ter);min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.due{font-size:11px;color:var(--warn);white-space:nowrap;flex:none}
.due.bad{color:var(--bad)}
.chip{font-size:10px;border-radius:999px;padding:2px 8px;background:var(--surface2);color:var(--dim);white-space:nowrap;flex:none}
.chip[data-tone="ok"]{background:color-mix(in srgb,var(--ok) 16%,transparent);color:var(--ok)}
.chip[data-tone="warn"]{background:color-mix(in srgb,var(--warn) 16%,transparent);color:var(--warn-strong)}
.chip[data-tone="bad"]{background:color-mix(in srgb,var(--bad) 14%,transparent);color:var(--bad)}
.chip[data-tone="accent"]{background:color-mix(in srgb,var(--accent) 14%,transparent);color:var(--accent-strong)}
.empty{color:var(--ter);font-size:12px;padding:8px 4px}
.proj{display:flex;flex-direction:column;gap:8px;padding:12px;border-radius:10px;background:var(--surface2);cursor:pointer;min-width:0}
.proj:hover{background:color-mix(in srgb,var(--surface2) 60%,var(--surface))}
.proj .top{display:flex;align-items:center;gap:8px}
.bar{height:3px;background:color-mix(in srgb,var(--text) 10%,transparent);border-radius:999px;overflow:hidden}
.bar i{display:block;height:100%;background:color-mix(in srgb,var(--accent) 72%,transparent);border-radius:999px}
.hero{display:flex;flex-direction:column;gap:6px}
.hero h1{margin:0;font-size:16px}
.meta{font-size:12px;color:var(--dim);display:flex;flex-wrap:wrap;gap:8px;align-items:center}
.btn{height:30px;border:0;border-radius:8px;background:var(--surface2);color:var(--text);padding:0 12px;font-size:13px}
.btn:hover{background:color-mix(in srgb,var(--text) 8%,transparent)}
.btn.primary{background:var(--text);color:var(--bg);font-weight:600}
.btn.primary:hover{opacity:.88}
.btn.danger{background:color-mix(in srgb,var(--bad) 12%,transparent);color:var(--bad)}
.btn.sm{height:26px;font-size:12px;padding:0 10px}
.btn:disabled{opacity:.45;cursor:not-allowed}
.actions{display:flex;gap:8px;flex-wrap:wrap}
.field{display:flex;flex-direction:column;gap:6px;min-width:0}
.field label{font-size:11px;color:var(--ter)}
.field input,.field textarea,.field select{width:100%;border:0;border-radius:8px;background:var(--surface2);color:var(--text);font:inherit;font-size:13px;padding:0 10px;height:32px;outline:none;color-scheme:inherit}
.field textarea{height:auto;min-height:88px;padding:8px 10px;line-height:1.55;resize:vertical}
.field input:focus,.field textarea:focus,.field select:focus{box-shadow:0 0 0 2px color-mix(in srgb,var(--accent) 45%,transparent)}
.grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px}
@media (max-width:640px){.grid{grid-template-columns:1fr}}
.list{display:flex;flex-direction:column;gap:6px}
.link{display:flex;align-items:center;gap:8px;padding:8px 10px;border-radius:8px;background:var(--surface2);min-width:0}
.link a{color:var(--accent-strong);text-decoration:none;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;font-size:12px}
.node-row{display:flex;align-items:center;gap:10px;padding:10px 12px;border-radius:10px;background:var(--surface2);cursor:pointer;min-width:0}
.node-row:hover{background:color-mix(in srgb,var(--surface2) 60%,var(--surface))}
.node-row .title{font-size:13px}
.flow-name{font-size:11px;color:var(--ter);padding:4px 2px}
.back{border:0;background:transparent;color:var(--dim);padding:0;font-size:12px;align-self:flex-start}
.back:hover{color:var(--text)}
.toast{position:fixed;left:50%;bottom:24px;transform:translateX(-50%);background:var(--text);color:var(--bg);border-radius:999px;padding:8px 16px;font-size:13px;opacity:0;transition:opacity .14s ease;pointer-events:none;z-index:9;max-width:88vw;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.toast.on{opacity:1}
.stamp{font-size:11px;color:var(--ter);text-align:center;padding-top:8px}
</style></head>
<body>
<div class="topbar">
<div class="brand">FlowPilot<span class="badge">远程工作台</span></div>
<div class="stats" id="stats"></div>
<button class="top-btn" data-refresh>刷新</button>
<button class="top-btn" data-logout>退出</button>
</div>
<div class="tabs">
<button class="tab" data-tab="today">今日</button>
<button class="tab" data-tab="projects">项目</button>
</div>
<main id="main"><div class="card"><div class="empty">加载中…</div></div></main>
<div class="stamp" id="stamp"></div>
<div class="toast" id="toast"></div>
<script>
var S=null,D=null,VIEW='today',PROJECT=null,NODE=null,TOAST=null;
function $(id){return document.getElementById(id)}
function esc(s){return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;')}
function isoDay(s){if(!s)return '';var d=new Date(s);if(!isFinite(d.getTime()))return '';return (d.getMonth()+1)+'月'+d.getDate()+'日'}
function isoDateTime(s){if(!s)return '';var d=new Date(s);if(!isFinite(d.getTime()))return '';return isoDay(s)+' '+String(d.getHours()).padStart(2,'0')+':'+String(d.getMinutes()).padStart(2,'0')}
function dueInfo(s){if(!s)return null;var d=new Date(s);if(!isFinite(d.getTime()))return null;var now=new Date();var a=new Date(now.getFullYear(),now.getMonth(),now.getDate());var b=new Date(d.getFullYear(),d.getMonth(),d.getDate());var days=Math.round((b-a)/86400000);if(days<0)return{text:'逾期 '+Math.abs(days)+' 天',bad:true};if(days===0)return{text:'今天',bad:false};if(days===1)return{text:'明天',bad:false};return{text:isoDay(s),bad:false}}
function statusLabel(s){return ({locked:'未解锁',ready:'待开始',active:'进行中',waiting:'等待',blocked:'阻塞',revision:'待修改',completed:'已完成',skipped:'已跳过'})[s]||s}
function statusTone(s){return ({ready:'accent',active:'accent',waiting:'warn',blocked:'bad',revision:'warn',completed:'ok',skipped:''})[s]||''}
function toast(text){var el=$('toast');el.textContent=text;el.classList.add('on');clearTimeout(TOAST);TOAST=setTimeout(function(){el.classList.remove('on')},2600)}
function apiGet(path){return fetch(path,{cache:'no-store',credentials:'same-origin'}).then(function(r){return r.json().then(function(j){if(!r.ok||j.ok===false)throw new Error(j.error||('HTTP '+r.status));return j})})}
function apiAction(action,payload){return fetch('/api/action',{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json'},body:JSON.stringify({action:action,payload:payload||{}})}).then(function(r){return r.json().then(function(j){if(!r.ok||j.ok===false){var e=new Error(j.error||('HTTP '+r.status));e.code=j.code||'';throw e}return j})})}
function applyState(out){if(out&&out.state){S=out.state;D=out.derived||{}}render()}
function refresh(){return apiGet('/api/state').then(function(out){S=out.state;D=out.derived||{};$('stamp').textContent='更新于 '+new Date().toLocaleTimeString();applyHash();render()}).catch(function(e){toast('读取失败：'+e.message)})}
function applyHash(){var m=/^#node=(.+)$/.exec(location.hash||'');if(m){var n=findNode(decodeURIComponent(m[1]));if(n){PROJECT=n.projectId;NODE=n.id;VIEW='projects'}}var p=/^#project=(.+)$/.exec(location.hash||'');if(p){var pr=findProject(decodeURIComponent(p[1]));if(pr){PROJECT=pr.id;NODE=null;VIEW='projects'}}}
function runAction(action,payload){return apiAction(action,payload).then(function(out){applyState(out);toast('已更新');return out}).catch(function(e){toast(e.message);throw e})}
function bizLines(){return (S&&S.businessLines)||[]}
function findLine(id){var ls=bizLines();for(var i=0;i<ls.length;i++){if(ls[i].id===id)return ls[i]}return null}
function findProject(id){var ps=(S&&S.projects)||[];for(var i=0;i<ps.length;i++){if(ps[i].id===id)return ps[i]}return null}
function projectNodes(pid){var ns=((S&&S.nodes)||[]).filter(function(n){return n.projectId===pid});var flows=((S&&S.flows)||[]).filter(function(f){return f.projectId===pid});var out=[];flows.sort(function(a,b){return (a.sortOrder||0)-(b.sortOrder||0)}).forEach(function(f){var list=ns.filter(function(n){return n.flowId===f.id}).sort(function(a,b){return (a.sortOrder||0)-(b.sortOrder||0)});out.push({flow:f,nodes:list})});return out}
function findNode(id){var ns=(S&&S.nodes)||[];for(var i=0;i<ns.length;i++){if(ns[i].id===id)return ns[i]}return null}
function lineNameOfProject(p){var l=p?findLine(p.businessLineId):null;return l&&l.name?l.name:''}
function cardRow(card,attr){var due=dueInfo(card.dueAt);return '<div class="row" '+attr+'><span class="code">'+esc(card.code||'·')+'</span><div style="min-width:0;flex:1"><div class="title">'+esc(card.title||'')+'</div><div class="sub">'+esc(card.projectTitle||'')+(card.followUpAt?' · 跟进 '+esc(isoDateTime(card.followUpAt)):'')+'</div></div>'+(due?'<span class="due'+(due.bad?' bad':'')+'">'+esc(due.text)+'</span>':'')+'</div>'}
function viewToday(){
  var t=(D&&D.today)||{};var rec=t.recommended||[];var fu=t.followUps||[];var up=t.upcoming||[];
  var h='';
  h+='<div class="card"><p class="sec-title">现在可推进（'+rec.length+'）</p><div class="list">'+(rec.length?rec.map(function(c){return cardRow(c,'data-open-node="'+esc(c.nodeId)+'"')}).join(''):'<div class="empty">当前没有需要优先处理的节点</div>')+'</div></div>';
  h+='<div class="card"><p class="sec-title">等待跟进（'+fu.length+'）</p><div class="list">'+(fu.length?fu.map(function(c){return cardRow(c,'data-open-node="'+esc(c.nodeId)+'"')}).join(''):'<div class="empty">没有等待跟进的节点</div>')+'</div></div>';
  h+='<div class="card"><p class="sec-title">近期截止（'+up.length+'）</p><div class="list">'+(up.length?up.map(function(c){return cardRow(c,'data-open-node="'+esc(c.nodeId)+'"')}).join(''):'<div class="empty">近 7 天没有截止节点</div>')+'</div></div>';
  return h;
}
function viewProjects(){
  var ps=((S&&S.projects)||[]).filter(function(p){return p.status!=='archived'});
  if(NODE!==null)return viewNode();
  if(PROJECT!==null)return viewProject();
  if(ps.length===0)return '<div class="card"><div class="empty">还没有项目</div></div>';
  var h='';
  ps.forEach(function(p){
    var info=(D&&D.projects&&D.projects[p.id])||{};
    var pct=Math.round((Number(info.progress)||0)*100);
    var nextDue=dueInfo(info.nextDueAt);
    h+='<div class="card"><div class="proj" data-open-project="'+esc(p.id)+'"><div class="top"><span class="title">'+esc(p.title||'未命名项目')+'</span><span class="chip">'+esc(lineNameOfProject(p)||'业务线')+'</span>'+(nextDue?'<span class="due'+(nextDue.bad?' bad':'')+'">'+esc(nextDue.text)+'</span>':'')+'</div>';
    h+='<div class="sub">'+esc(info.currentCode?info.currentCode+' · '+(info.currentStage||''):(info.currentStage||'尚未开始'))+' · '+(Number(info.completed)||0)+'/'+(Number(info.total)||0)+'</div><div class="bar"><i style="width:'+pct+'%"></i></div></div></div>';
  });
  return h;
}
function viewProject(){
  var p=findProject(PROJECT);
  if(!p){PROJECT=null;return viewProjects()}
  var info=(D&&D.projects&&D.projects[p.id])||{};
  var h='<button class="back" data-back>← 返回项目</button>';
  h+='<div class="card"><div class="hero"><h1>'+esc(p.title||'未命名项目')+'</h1><div class="meta"><span class="chip">'+esc(lineNameOfProject(p)||'业务线')+'</span><span>'+esc(info.currentCode?info.currentCode+' · '+(info.currentStage||''):(info.currentStage||'尚未开始'))+'</span>'+(p.dueAt?'<span>截止 '+esc(isoDateTime(p.dueAt))+'</span>':'')+'<span>'+(Number(info.completed)||0)+'/'+(Number(info.total)||0)+'</span></div></div></div>';
  var groups=projectNodes(p.id);
  groups.forEach(function(group){
    h+='<div class="card"><p class="sec-title">'+esc(group.flow.name||'流程')+'</p><div class="list">';
    if(group.nodes.length===0)h+='<div class="empty">该流程还没有节点</div>';
    group.nodes.forEach(function(n){
      var due=dueInfo(n.dueAt);
      h+='<div class="node-row" data-open-node="'+esc(n.id)+'"><span class="code">'+esc(n.code||'·')+'</span><div style="min-width:0;flex:1"><div class="title">'+esc(n.title||'')+'</div><div class="sub">'+esc(statusLabel(n.status))+(n.followUpAt?' · 跟进 '+esc(isoDateTime(n.followUpAt)):'')+'</div></div><span class="chip" data-tone="'+statusTone(n.status)+'">'+esc(statusLabel(n.status))+'</span>'+(due?'<span class="due'+(due.bad?' bad':'')+'">'+esc(due.text)+'</span>':'')+'</div>';
    });
    h+='</div></div>';
  });
  return h;
}
function viewNode(){
  var n=findNode(NODE);if(!n){NODE=null;return viewProject()}
  var p=findProject(n.projectId);var due=dueInfo(n.dueAt);
  var h='<button class="back" data-back-node>← 返回节点列表</button>';
  h+='<div class="card"><div class="hero"><h1><span class="code">'+esc(n.code||'·')+'</span> '+esc(n.title||'')+'</h1><div class="meta"><span class="chip" data-tone="'+statusTone(n.status)+'">'+esc(statusLabel(n.status))+'</span><span>'+esc(p?p.title:'')+'</span>'+(due?'<span class="due'+(due.bad?' bad':'')+'">'+esc(due.text)+'</span>':'')+'<span>第 '+(Number(n.round)||1)+' 轮</span></div></div>';
  var actions='';
  if(n.status==='ready'||n.status==='revision')actions+='<button class="btn primary" data-act="startNode">'+(n.status==='revision'?'继续修改':'开始处理')+'</button>';
  if(n.status==='active'||n.status==='waiting'||n.status==='blocked')actions+='<button class="btn primary" data-act="completeNode">标记完成</button>';
  if(n.status==='active')actions+='<button class="btn" data-act="waitNode">等待</button>';
  if(n.status==='active'||n.status==='waiting')actions+='<button class="btn" data-act="blockNode">阻塞</button>';
  if(n.status==='completed'||n.status==='skipped')actions+='<button class="btn" data-act="reopenNode">重新打开</button>';
  if(n.status!=='completed'&&n.status!=='skipped')actions+='<button class="btn" data-act="skipNode">跳过</button>';
  if(actions!=='')h+='<div class="actions">'+actions+'</div>';
  h+='</div>';
  var roles=Array.isArray(n.approvalRoles)?n.approvalRoles:[];
  if(roles.length>0){var apps=n.approvals||{};var ap='';roles.forEach(function(role){var name=role==='design'?'设计':'产品';if(apps[role]===true){ap+='<span class="chip" data-tone="ok">'+name+'已通过</span>'}else{ap+='<button class="btn sm" data-approve="'+esc(role)+'">'+name+'通过</button><button class="btn sm danger" data-reject="'+esc(role)+'">'+name+'退回</button>'}});h+='<div class="card"><p class="sec-title">双角色确认</p><div class="actions">'+ap+'</div></div>'}
  h+='<div class="card"><p class="sec-title">计划与跟进</p><div class="grid"><div class="field"><label>计划开始</label><input type="datetime-local" id="f-planned" value="'+esc(toLocalInput(n.plannedAt))+'"></div><div class="field"><label>计划完成</label><input type="datetime-local" id="f-due" value="'+esc(toLocalInput(n.dueAt))+'"></div><div class="field"><label>下次跟进</label><input type="datetime-local" id="f-follow" value="'+esc(toLocalInput(n.followUpAt))+'"></div></div><div class="actions"><button class="btn" data-save-schedule>保存时间</button></div></div>';
  h+='<div class="card"><p class="sec-title">备注</p><div class="field"><textarea id="f-notes" placeholder="记录进展/风险…">'+esc(n.notes||'')+'</textarea></div><div class="actions"><button class="btn" data-save-notes>保存备注</button></div></div>';
  var links=((S&&S.links)||[]).filter(function(l){return l.nodeId===n.id});
  h+='<div class="card"><p class="sec-title">关联链接（'+links.length+'）</p><div class="list">';
  links.forEach(function(l){h+='<div class="link"><span class="chip">'+esc(l.kind||'other')+'</span><a href="'+esc(l.url)+'" target="_blank" rel="noreferrer">'+esc(l.url)+'</a><button class="btn sm danger" data-remove-link="'+esc(l.id)+'">删除</button></div>'});
  if(links.length===0)h+='<div class="empty">还没有链接</div>';
  h+='</div><div class="grid" style="grid-template-columns:1fr 2fr auto;align-items:end"><div class="field"><label>类型</label><select id="f-link-kind"><option value="design">设计稿</option><option value="figma">Figma</option><option value="doc">文档</option><option value="dev">开发</option><option value="test">测试</option><option value="ref">参考</option><option value="other">其他</option></select></div><div class="field"><label>链接</label><input id="f-link-url" placeholder="https://…"></div><button class="btn" data-add-link>添加</button></div></div>';
  return h;
}
function toLocalInput(iso){if(!iso)return '';var d=new Date(iso);if(!isFinite(d.getTime()))return '';var pad=function(x){return String(x).padStart(2,'0')};return d.getFullYear()+'-'+pad(d.getMonth()+1)+'-'+pad(d.getDate())+'T'+pad(d.getHours())+':'+pad(d.getMinutes())}
function fromLocalInput(id){var el=$(id);var v=el?el.value:'';if(!v)return null;var d=new Date(v);return isFinite(d.getTime())?d.toISOString():null}
function render(){
  var tabs=[].slice.call(document.querySelectorAll('[data-tab]'));
  tabs.forEach(function(b){b.classList.toggle('on',b.getAttribute('data-tab')===VIEW)});
  var counts=(D&&D.counts)||{};
  $('stats').innerHTML='<span class="stat"><b>'+esc(counts.actionable||0)+'</b> 可推进</span><span class="stat"><b>'+esc(counts.waiting||0)+'</b> 待跟进</span><span class="stat"'+(counts.overdue?' data-tone="bad"':'')+'><b>'+esc(counts.overdue||0)+'</b> 逾期</span>';
  $('main').innerHTML=VIEW==='today'?viewToday():viewProjects();
}
function openNode(nodeId){var n=findNode(nodeId);if(!n)return;PROJECT=n.projectId;NODE=nodeId;VIEW='projects';try{history.replaceState(null,'','#node='+encodeURIComponent(nodeId))}catch(e){}render()}
function openProject(pid){PROJECT=pid;NODE=null;VIEW='projects';try{history.replaceState(null,'','#project='+encodeURIComponent(pid))}catch(e){}render()}
document.addEventListener('click',function(event){
  var el=event.target&&event.target.closest?event.target.closest('[data-open-node],[data-open-project],[data-act],[data-approve],[data-reject],[data-save-schedule],[data-save-notes],[data-add-link],[data-remove-link],[data-tab],[data-refresh],[data-logout],[data-back],[data-back-node]'):null;
  if(!el)return;
  var act=el.getAttribute('data-act');
  if(el.hasAttribute('data-tab')){VIEW=el.getAttribute('data-tab');if(VIEW==='today'){PROJECT=null;NODE=null;try{history.replaceState(null,'','#')}catch(e){}}render();return}
  if(el.hasAttribute('data-open-node')){openNode(el.getAttribute('data-open-node'));return}
  if(el.hasAttribute('data-open-project')){openProject(el.getAttribute('data-open-project'));return}
  if(el.hasAttribute('data-refresh')){refresh();return}
  if(el.hasAttribute('data-logout')){fetch('/logout',{method:'POST'}).then(function(){location.href='/login'}).catch(function(){location.href='/login'});return}
  if(el.hasAttribute('data-back')){PROJECT=null;NODE=null;try{history.replaceState(null,'','#')}catch(e){}render();return}
  if(el.hasAttribute('data-back-node')){NODE=null;try{history.replaceState(null,'','#project='+encodeURIComponent(PROJECT||''))}catch(e){}render();return}
  if(el.hasAttribute('data-approve')){var role=el.getAttribute('data-approve');var comment=window.prompt('通过意见（可留空）')||'';runAction('approve',{nodeId:NODE,role:role,passed:true,comment:comment}).catch(function(){});return}
  if(el.hasAttribute('data-reject')){var role2=el.getAttribute('data-reject');var reason=window.prompt('退回原因（必填）');if(!reason)return;runAction('rejectApproval',{nodeId:NODE,role:role2,comment:reason}).catch(function(){});return}
  if(el.hasAttribute('data-save-schedule')){runAction('setNodeSchedule',{nodeId:NODE,plannedAt:fromLocalInput('f-planned'),dueAt:fromLocalInput('f-due'),followUpAt:fromLocalInput('f-follow')}).catch(function(){});return}
  if(el.hasAttribute('data-save-notes')){var ta=$('f-notes');runAction('setNodeNotes',{nodeId:NODE,notes:ta?ta.value:''}).catch(function(){});return}
  if(el.hasAttribute('data-add-link')){var kindEl=$('f-link-kind');var urlEl=$('f-link-url');var url=urlEl?String(urlEl.value||'').trim():'';if(!url){toast('请先填链接');return}var title=window.prompt('链接名称（可留空，默认用链接地址）','')||'';runAction('addLink',{nodeId:NODE,kind:kindEl?kindEl.value:'other',url:url,title:title||url}).catch(function(){});return}
  if(el.hasAttribute('data-remove-link')){if(!window.confirm('删除这条链接？'))return;runAction('removeLink',{linkId:el.getAttribute('data-remove-link')}).catch(function(){});return}
  if(act==='startNode')runAction('startNode',{nodeId:NODE}).catch(function(){});
  else if(act==='completeNode')runAction('completeNode',{nodeId:NODE}).catch(function(){});
  else if(act==='waitNode'){var at=window.prompt('跟进时间（YYYY-MM-DDTHH:mm，可留空）','')||'';var iso=null;if(at){var d=new Date(at);if(isFinite(d.getTime()))iso=d.toISOString()}runAction('waitNode',{nodeId:NODE,note:'远程工作台标记等待',followUpAt:iso}).catch(function(){})}
  else if(act==='blockNode'){var reason2=window.prompt('阻塞原因（必填）');if(!reason2)return;runAction('blockNode',{nodeId:NODE,reason:reason2}).catch(function(){})}
  else if(act==='skipNode'){var reason3=window.prompt('跳过原因（必填）');if(!reason3)return;runAction('skipNode',{nodeId:NODE,reason:reason3}).catch(function(){})}
  else if(act==='reopenNode'){var r=window.prompt('重新打开原因（必填）');if(!r)return;runAction('reopenNode',{nodeId:NODE,reason:r}).catch(function(){})}
});
window.addEventListener('hashchange',function(){applyHash();render()});
refresh();setInterval(function(){if(NODE===null)refresh()},15000);
</script>
</body></html>`
}
