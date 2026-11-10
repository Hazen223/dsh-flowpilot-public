# FlowPilot 插件 · 开发契约（唯一事实来源）

本文件是并行开发的接口契约。**任何跨文件调用只能使用本文件列出的名字与形状**；
需要新增跨文件依赖时，先在本文件追加，再改代码。

产品依据：PRD《FlowPilot｜基于流程节点的个人项目管理工具》。
交付形态：DSH Harness **Web UI 插件**（Cordis bundle，profile = `desktop`）。
所有 macOS / SwiftUI 相关表述**忽略**，改为浏览器内 React 面板。

包目录：`/Users/x`
包名：`dsh-flowpilot`

---

## 0. 目录与文件归属（写作用域，勿越界）

```
flowpilot/
  package.json              Lead
  cordis.patch.yml          Lead
  locale/{zh,en}.json       Lead
  icon.svg                  Lead
  README.md                 Lead
  build-client.mjs          Lead     把 src/client/*.js 拼成 client.js
  client.js                 生成物     勿手改（由 build-client.mjs 生成）
  index.js                  host-core 宿主入口（apply/inject；被 Harness 直接 import，不打包）
  lib/templates.js          host-core 流程模板
  lib/store.js              host-core 持久化（~/.dsh/flowpilot/data.json）
  lib/domain.js             host-core 领域规则 + 派生
  lib/http.js               host-core webServer 路由
  lib/selftest.mjs          host-core 固定时钟自测
  docs/CONTRACT.md          Lead
  src/client/10-util.js     Lead
  src/client/20-store.js    Lead
  src/client/25-primitives.js  ui-shell
  src/client/30-shell.js       ui-shell
  src/client/40-flow.js        ui-flow
  src/client/50-views.js       ui-views
  src/client/60-quick.js       Lead（快捷浮层 / 侧栏图标 / 设置页）
  src/client/70-css.js      Lead（聚合各模块 CSS 常量）
  src/client/80-apply.js    Lead（槽位注册）
```

**Host 打包方式**：`src/host/*.js` 用 ESM 写（`import`/`export`），Lead 用 `build-host.mjs`
把 `src/host/main.js` 及其依赖内联成单文件 `index.js`（无外部依赖，只允许 `node:` 内置模块）。
因此 host-core 的代码**不允许 import 任何 npm 包**（`@deepseek-ai/dsh-tools` 除外，它是
`defineTool`，会被 build 脚本原样保留为 import）。实际做法：`src/host/*.js` 之间用相对
`import`；build 脚本做拓扑内联。

---

## 1. Client 拼接规则（非常重要）

`client.js` = 固定头部 + 按上面顺序拼接的 `src/client/*.js` 内容 + 固定尾部。
每个 client 源文件是**同一个函数作用域内的普通语句**（不是模块，不要写 `import`/`export`）。

- 跨文件可用的组件/函数必须是 **`function Name(props) {}` 声明**（会提升，顺序无关）。
- 跨文件共享的常量必须命名为 `const CSS_XXX`（样式）或 `const FP_XXX`（数据），
  并且**只在函数体内被读取**（加载期不互相引用，避免 TDZ）。
- 每个文件顶部写一行注释：`/* ===== 归属：<owner> · <用途> ===== */`。
- 可用全局：`React`、`h`（已绑定）、`require`（仅 `react`）。
- **禁止**：访问 `document.body` 之外的宿主 DOM、读写别的插件 DOM、写全局 `--dsw-*` 变量、
  `require` 任何 Harness Client 包。样式只允许 `--dsw-alias-*` / `--dsw-specific-*` 令牌 +
  `color-mix(in oklab, var(--dsw-...) x%, transparent)`。

---

## 2. 数据形状（Host 生成，Client 只读）

`GET /flowpilot/api/state` 与每个 action 的响应都返回同一结构：

```jsonc
{
  "ok": true,
  "revision": 12,              // 每次写入 +1；client 用它对账
  "state": { ...不透明，见下... },
  "derived": { ...见 §3... },
  "result": {}                // 仅 action 响应有，动作自身返回值
}
```

### 2.1 state

```jsonc
{
  "formatVersion": 1,
  "settings": {
    "workSlots": [                         // 可配置；默认值见 PRD §6.1
      { "key": "morning",   "label": "启动与预热", "start": "11:00", "end": "12:00" },
      { "key": "afternoon", "label": "主要工作输出", "start": "14:00", "end": "18:00" },
      { "key": "evening",   "label": "持续交付与收尾", "start": "19:00", "end": "21:00" }
    ],
    "silentWindows": [["12:00","14:00"], ["18:00","19:00"]],  // 普通提醒静默
    "handoffTime": "20:45",         // 日终交接推荐时点
    "weeklyDraftTime": "12:05",     // 周五周报草稿生成时点
    "weeklyMeetingTime": "17:00",
    "weekStartsOn": 1,              // 周一
    "workdays": [1,2,3,4,5],        // ISO 1-7
    "dataFile": "/Users/x/.dsh/flowpilot/data.json"   // 只读展示
  },
  "businessLines": [ { "id": "bl_1", "name": "增长推广", "sortOrder": 0 } ],
  "projects": [{
    "id": "pr_1", "businessLineId": "bl_1", "title": "活动管理改版",
    "status": "active" | "archived",
    "dueAt": "2026-11-06T10:00:00.000Z" | null,
    "createdAt": "ISO", "archivedAt": "ISO" | null
  }],
  "flows": [{                       // 一个项目可有多个流程实例（设计交付 + 验收）
    "id": "fl_1", "projectId": "pr_1", "templateId": "delivery" | "acceptance",
    "templateVersion": 1, "name": "设计交付流程", "sortOrder": 0
  }],
  "nodes": [{
    "id": "nd_1", "flowId": "fl_1", "projectId": "pr_1",
    "code": "D01", "title": "需求接收", "detail": "记录需求名称与来源",
    "status": "locked|ready|active|waiting|blocked|revision|completed|skipped",
    "sortOrder": 0,
    "assigneeRole": "设计" | "研发" | "设计/产品",
    "approvalRoles": ["design","product"],      // 非确认节点为 []
    "approvals": { "design": false, "product": false },  // approvalRoles 为空时 {}
    "dueAt": null, "followUpAt": null, "completedAt": null,
    "notes": "", "round": 1
  }],
  "dependencies": [{ "fromNodeId": "nd_1", "toNodeId": "nd_2", "relation": "sequence|return|handoff" }],
  "links": [{ "id": "lk_1", "nodeId": "nd_1", "title": "设计稿交互框架", "url": "https://...", "kind": "design|figma|doc|chat|meeting|dev|test|ref|other", "createdAt": "ISO" }],
  "events": [{ "id": "ev_1", "projectId": "pr_1", "flowId": "fl_1", "nodeId": "nd_1|null",
               "kind": "nodeStatus|approvalPassed|approvalRejected|revision|unlocked|projectCreated|flowAdded|linkAdded|scheduleChanged|handoffSaved|reportGenerated|reportEdited|projectUpdated|projectArchived|nodeAdded|nodeRemoved|settingsChanged|manualNote|seeded",
               "timestamp": "ISO", "details": "中文描述", "round": 1 }],
  "handoffs": [{ "id": "ho_1", "date": "2026-11-02",       // 本地日期 YYYY-MM-DD
                 "nodeIds": ["nd_1"], "nextActions": "…", "notes": "…",
                 "confirmedAt": "ISO", "createdAt": "ISO", "source": "user" }],
  "reports": [{ "id": "rp_1", "weekStart": "2026-11-02",   // 本地日期（周一）
                "generatedAt": "ISO", "content": "markdown 文本",
                "lastEditedAt": null, "mode": "concise|detailed" }]
}
```

### 2.2 日期约定
- 时间戳：ISO 8601 字符串（带 Z）。
- 日期键：本地日期 `YYYY-MM-DD`（`handoff.date`、`report.weekStart`）。
- 周起始默认周一。周五的交接默认指向下周一（PRD §6.4）。

### 2.3 实现说明（与 §3 的差异，以本文件版本为准）
- `derived.today` 是**今日对象**（含 `recommended/followUps/upcoming/handoffContext`）；
  今天的日期键用 `derived.todayKey`（`YYYY-MM-DD`）或 `fpDateOnly(derived.now)`，
  **不要**把 `derived.today` 当字符串用。
- `state.settings.dismissedRhythms` 是宿主内部字段，客户端不必读取。
- 事件 `kind` 为兼容旧客户端做了近似映射（`removeLink→linkAdded`、`setNodeNotes→manualNote`、
  `reorderNode/reorderLine→settingsChanged`、`reopenNode→revision`），
  客户端渲染时间线时**必须对未知 kind 兜底**（退回显示原始 kind 字符串）。
- `approve` 通过但缺少 设计稿链接时返回 `ok:true` 且 `result.needDesignLink=true`（不是错误）；
  之后 `addLink(kind:'design')` 会自动补完成。
- `derived.today.upcoming` 只与 `recommended` 去重，可能与 `followUps` 重叠。
- 周五 12:05 之后首次读 `/state` 会自动补生成本周周报草稿（revision 会 +1，只补一次）。
- 周报正文首段是「需求概述」：每个进行中/本周交付的项目给出 PRD 摘要（`project.summary`，缺失时用剩余节点拼）、
  当前聚焦节点与说明、设计进度（设计中 / 设计完成 / 开发中 / 验收中 / 验收完成 / 验收完成（二次验收）/ 已交付）、
  下一节点的计划时间（取 `plannedAt` → `dueAt` → `followUpAt`）。

---

## 3. derived（Host 计算的派生视图，Client 直接渲染）

```jsonc
{
  "now": "ISO", "today": "2026-11-03",
  "counts": { "actionable": 3, "waiting": 2, "blocked": 1, "revision": 1,
              "overdue": 0, "activeProjects": 3, "completedThisWeek": 4 },
  "focus": {                              // 工作节奏感知（PRD §6）
    "period": "morning|afternoon|evening|noonBreak|eveningGap|offHours|weekend",
    "label": "启动与预热", "silent": false, "inWorkHours": true,
    "prompt": { "title": "下午优先任务", "body": "3 个可推进节点，2 个待跟进", "cta": "打开今日" } | null
  },
  "today": {
    "recommended": [ NodeCard ],          // ≤5，按优先级：逾期/截止近/进行中/待修改/待开始
    "followUps": [ NodeCard ],            // waiting/blocked，含 followUpAt
    "upcoming": [ NodeCard ],             // 7 天内截止
    "handoffContext": { "date": "2026-11-02", "nextActions": "…", "notes": "…",
                        "nodes": [NodeCard], "confirmedAt": "ISO" } | null
  },
  "weekly": { "weekStart": "2026-11-02", "weekEnd": "2026-11-06",
              "reportId": "rp_1"|null, "exists": true, "shouldGenerate": false,
              "nextGenerateAt": "ISO" },
  "projects": {                          // key = projectId
    "pr_1": { "currentStage": "交互确认（设计 & 产品）", "currentCode": "D04",
              "activeNodeId": "nd_4", "actionable": 1, "waiting": 1,
              "total": 7, "completed": 3, "progress": 0.43,
              "needsAttention": true, "nextDueAt": "ISO"|null }
  }
}
```

`NodeCard`（derived 内的节点卡片，永远是扁平可渲染的）：

```jsonc
{ "nodeId": "nd_4", "code": "D04", "title": "交互确认（设计 & 产品）",
  "status": "waiting", "projectId": "pr_1", "projectTitle": "活动管理改版",
  "businessLineId": "bl_1", "businessLineName": "增长推广",
  "flowId": "fl_1", "flowName": "设计交付流程",
  "dueAt": "ISO"|null, "followUpAt": "ISO"|null, "completedAt": "ISO"|null,
  "round": 2, "assigneeRole": "设计/产品",
  "reason": "overdue|dueSoon|active|revision|ready|followUp",   // 仅 recommended/followUps 有
  "daysLeft": -2,                                              // 可为负
  "approvals": { "design": true, "product": false },
  "linkCount": 1, "hasDesignLink": true }
```

---

## 4. Host HTTP API

基路径 `/flowpilot/api`（`webServer.register({kind:'exact', path})`；跨站校验：Origin 的 host
与 Host 头不一致时 403）。

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/flowpilot/api/state` | `{ok, revision, state, derived}` |
| POST | `/flowpilot/api/action` | body `{action, payload}` → `{ok, revision, state, derived, result}`；失败 `4xx/200 {ok:false, error, state?, derived?}` |
| GET | `/flowpilot/api/webaccess` | 本地只读网页状态：`{ok, status:{enabled, running, host, port, url, startedAt, error}}`（见 `docs/WEB-ACCESS.md`） |
| POST | `/flowpilot/api/webaccess` | body `{enabled?, port?}` → 开关/改端口，返回 `{ok, status}` |
| GET | `/flowpilot/api/export` | 备份 JSON（`content-disposition: attachment`） |
| POST | `/flowpilot/api/import` | body = 备份 JSON，整体替换 |

错误码约定：`{ok:false, error:"中文原因", code:"NEED_APPROVALS|NEED_DESIGN_LINK|NOT_FOUND|INVALID_STATE|INVALID_INPUT|INTERNAL"}`。

### 4.1 action 清单（Client 与 agent tool 共用同一实现）

```jsonc
// 业务线
{ "action": "createLine",        "payload": { "name": "增长推广" } }
{ "action": "renameLine",        "payload": { "lineId": "bl_1", "name": "…" } }
{ "action": "deleteLine",        "payload": { "lineId": "bl_1" } }          // 仍有项目时拒绝
{ "action": "reorderLine",       "payload": { "lineId": "bl_1", "sortOrder": 2 } }

// 项目
{ "action": "createProject",     "payload": { "businessLineId": "bl_1", "title": "…",
                                              "templateIds": ["delivery","acceptance"],  // 或 "templateId"
                                              "dueAt": "ISO"|null } }
{ "action": "updateProject",     "payload": { "projectId": "pr_1", "title?":"…", "dueAt?":"ISO"|null, "businessLineId?" } }
{ "action": "archiveProject",    "payload": { "projectId": "pr_1", "archived": true } }
{ "action": "addFlow",           "payload": { "projectId": "pr_1", "templateId": "acceptance" } }

// 节点
{ "action": "startNode",         "payload": { "nodeId": "nd_1" } }                    // → active
{ "action": "completeNode",      "payload": { "nodeId": "nd_1", "note": "" } }        // → completed（含确认门槛校验）
{ "action": "waitNode",          "payload": { "nodeId": "nd_1", "followUpAt": "ISO"|null, "note": "" } }
{ "action": "blockNode",         "payload": { "nodeId": "nd_1", "reason": "…", "followUpAt": "ISO"|null } }
{ "action": "skipNode",          "payload": { "nodeId": "nd_1", "reason": "…" } }
{ "action": "reopenNode",        "payload": { "nodeId": "nd_1", "reason": "…" } }      // → revision，round+1
{ "action": "rejectApproval",    "payload": { "nodeId": "nd_4", "comment": "…" } }     // = 双角色确认退回
{ "action": "approve",           "payload": { "nodeId": "nd_4", "role": "design"|"product",
                                               "passed": true, "comment": "" } }
{ "action": "setNodeSchedule",   "payload": { "nodeId": "nd_1", "dueAt": "ISO"|null, "followUpAt": "ISO"|null } }
{ "action": "setNodeNotes",      "payload": { "nodeId": "nd_1", "notes": "…" } }
{ "action": "addNote",           "payload": { "projectId": "pr_1", "nodeId?": "nd_1", "text": "…" } } // 事件 manualNote
{ "action": "addNode",           "payload": { "flowId": "fl_1", "afterNodeId?"|"beforeNodeId?": null,
                                               "title": "…", "detail": "", "assigneeRole": "设计" } }
{ "action": "removeNode",        "payload": { "nodeId": "nd_1" } }                    // 只允许未开始/已跳过
{ "action": "reorderNode",       "payload": { "nodeId": "nd_1", "sortOrder": 2 } }

// 链接
{ "action": "addLink",           "payload": { "nodeId": "nd_1", "title": "…", "url": "https://…", "kind": "design" } }
{ "action": "removeLink",        "payload": { "linkId": "lk_1" } }

// 交接 / 周报 / 设置 / 维护
{ "action": "saveHandoff",       "payload": { "date": "2026-11-02", "nodeIds": ["nd_1"],
                                               "nextActions": "…", "notes": "…" } }
{ "action": "generateReport",    "payload": { "weekStart?": "2026-11-02", "mode": "concise"|"detailed",
                                               "overwrite": false } }
{ "action": "updateReport",      "payload": { "reportId": "rp_1", "content": "…", "mode": "concise" } }
{ "action": "dismissRhythm",     "payload": { "key": "2026-11-03:afternoon" } }        // 当天不再提示
{ "action": "updateSettings",    "payload": { "patch": { "handoffTime": "20:45", … } } }
{ "action": "seedDemo",          "payload": {} }                                        // 首次示例数据（幂等：已有数据则拒绝）
{ "action": "resetData",         "payload": { "confirm": "RESET" } }                    // 危险，需二次确认
```

**状态机规则（host 唯一实现，client 不做业务判断）**
- 解锁：`completed|skipped` → 同 flow 下一节点（`sortOrder` 最小且 `locked`）变为
  `assigneeRole==='研发' ? 'waiting' : 'ready'`；若该节点是跨 flow `handoff` 目标（D07→A01），
  同时解锁目标 flow 的首节点。
- 完成门槛：`approvalRoles.length > 0` 的节点要求全部角色 `approvals[role]=true`
  **且** 至少一条 `kind==='design'` 链接；否则 `NEED_APPROVALS` / `NEED_DESIGN_LINK`。
- 双角色确认：任一角色 `passed` → 记 `approvalPassed`；两角色都通过且满足门槛 → 自动 `completed`。
  任一方 `passed:false` → `approvalRejected`，沿 `relation:'return'` 依赖回退目标节点
  （D04→D03、D06→D05）置 `revision`（round+1、清 completedAt），本节点置 `locked`、清空 approvals、round+1。
- `locked` 不可 action；`completed` 只能 reopen；`skipped` 不计入完成成果。
- 所有变更写 `events`（可追溯），不要只存最终状态（PRD §8.2）。

---

## 4.2 新增：删除项目 + 设计稿链接继承

### A. `deleteProject`（永久删除，非归档）

```jsonc
{ "action": "deleteProject", "payload": { "projectId": "pr_1", "confirm": "DELETE" } }
```
- `confirm` 必须是字符串 `"DELETE"`，否则 400 `INVALID_INPUT`（防止误调用）。
- 级联删除：该项目自身、它的全部 flows、这些 flow 的 nodes、这些 nodes 的 links、
  引用这些 nodes 的 dependencies、`projectId` 匹配的 events、handoffs 中该项目的 nodeIds
  （nodeIds 删空则整条 handoff 移除）。
- **删除前自动备份**：把删除前的完整快照写到 `~/.dsh/flowpilot/backups/pre-delete-<ISO>.json`
  （保留最近 10 份，按文件名排序裁掉更旧的）。
- 返回：`{ projectId, title, backupPath, deleted: { flows, nodes, links, events, handoffs } }`。
- 与 `archiveProject` 的区别：归档可恢复、数据保留；删除是物理删除且不可撤销。

### B. 设计稿链接继承（`settings.inheritDesignLink`，默认 `true`）

节点**完成**（`completeNode` / `approve` 双角色自动完成 / `addLink` 满足门槛自动完成）或
**跳过**（`skipNode`）时，把该节点上 `kind === 'design'` 的链接**复制到后继节点**：

- 后继节点 = 同 flow 中 `sortOrder` 更大的第一个节点 + 所有 `relation === 'handoff'` 的依赖目标；
- 目标节点若为 `completed` / `skipped` 则跳过；同一目标已存在相同 `url` 时跳过（去重）；
- 复制出的链接新增可选字段 `inheritedFrom: <源节点 id>`，并写事件
  `linkAdded`，details 形如 `继承 设计稿链接「xxx」（← D03）`；
- 链式继承成立（后继节点完成时，它上面的 design 链接继续向后继承）；
- `settings.inheritDesignLink === false` 时不继承（仍可手动添加）。

`state.links` 元素新增**可选**字段（向后兼容，旧数据无此字段）：

```jsonc
{ "id": "lk_1", "nodeId": "nd_2", "title": "设计稿 文件", "url": "https://…",
  "kind": "design", "createdAt": "ISO", "inheritedFrom": "nd_1" }
```

### C. 客户端

- 左栏项目条目：**右键**弹出上下文菜单（打开 / 归档或恢复 / 删除项目…），
  并在行悬停时提供一个「⋯」按钮作为可发现入口；菜单关闭时机：点击别处、Esc、滚动、窗口尺寸变化。
- 删除项目需二次确认（展示项目名与将删除的节点数、说明「删除前自动备份、不可撤销」），
  成功后刷新数据；若删除的是当前选中项目则清空选中。
- 节点详情的「关联链接」中，带 `inheritedFrom` 的链接显示「继承」小标（title 提示继承来源节点 code）。

## 4.2.1 链接类型（kind）

| kind | 标签 | 典型用途 |
|---|---|---|
| `design` | 设计稿 | 交互稿 / 设计产物 |
| `figma` | Figma | Figma 文件 |
| `doc` | 需求文档 | PRD、需求说明 |
| `chat` | AI 讨论 | 和 GPT / Claude 等的讨论记录、会话分享 |
| `meeting` | 会议纪要 | 评审会、对齐会记录 |
| `dev` | 开发实现 | PR / 分支 / 代码仓库 |
| `test` | 测试验收 | 用例、验收记录 |
| `ref` | 参考资料 | 竞品、行业资料、外部参考 |
| `other` | 其他 | 兜底 |

- 新增类型只做**追加**，历史数据里的旧 `kind` 继续合法（向后兼容）；
- `evidencePolicy.kinds` 可取上述任意组合（例如只认「AI 讨论」或「测试验收」）。

## 4.3 同步：最新覆盖（newest-wins）+ 自动同步间隔

接口：`POST /flowpilot/api/sync/run`，body `{ mode?: 'merge' | 'newest' | 'three-way', dryRun?: boolean, force?: 'push'|'pull' }`，
**默认 `merge`（记录级三方合并）**。

- `merge` 语义（默认，记录级三方合并）：
  1. base = `~/.dsh/flowpilot/sync-base.json`（上次同步的公共祖先；0600 原子写，上传/拉取/合并成功后刷新）；
  2. 可变集合（businessLines / projects / flows / nodes / dependencies / links）字段级三方：
     一边未改取另一边，两边都改按 lastTouch 决胜（记录时间戳 + 各自一侧引用事件时间的最大值，平局 local）；
  3. append-only（events / handoffs / reports）按 id 求并集去重并稳定排序；
  4. 删除/复活：只在一边消失且另一边未改 → 删除；另一边改过 → 复活并记 `resurrected`；
  5. 合并后清理孤儿并级联清理事件/交接；settings 逐 key 三方（dataFile 强制本地）；
  6. 写盘顺序：`backups/pre-merge-<ISO>.json`（含三方）→ 本地 → 上传 → base；revision = max(local,remote)+1；
  7. 永不 409（传输层并发写内部重试一次，仍冲突归一 `SYNC_NETWORK` 502）。
  - 结果（顶层 + 嵌套 `result`）：`{ mode:'merge', direction:'merge', action:'merge', uploaded, localRevision,
    remoteRevision, mergedRevision, localUpdatedAt, remoteUpdatedAt, baseMissing, baseRevision, basePath, backupPath,
    merged: { added, updated, deleted, pruned, conflicts:[{collection,id,field,winner}], resurrected, baseMissing } }`。
  - 降级：远端无快照 → push；base 缺失 + 本地空 → pull；两边都有数据 → 空 base 加法合并（`baseMissing:true`，绝不删）。
- `newest` 语义（整份最新覆盖，显式 `mode:'newest'`）：
  1. 读远端快照，比较本地 `data.json` mtime 与远端 `updatedAt`（缺失回落 `savedAt`）；
  2. 远端更新 → 覆盖本地（沿用 pull：先写 `~/.dsh/flowpilot/backups/pre-sync-<ISO>.json`，再做快照校验）；
  3. 本地更新 / 相同 / 无远端 → 不动本地；
  4. **随后无条件上传**当前本地快照（云端始终最新，`uploaded: true`）；
  5. 永不返回 409 冲突。
- 响应：`{ ok: true, result: { mode: 'newest', direction: 'push'|'pull'|'noop', reason, uploaded, localRevision, remoteRevision,
  localUpdatedAt, remoteUpdatedAt, local, remote, bytes, backupPath? } }`。
- `three-way` 保留旧行为（三路比较 + `SYNC_CONFLICT` 409），`/sync/push`、`/sync/pull` 仍可强制方向。
- **冲突审阅**（merge 模式的复核入口）：
  - merge 结果除 `merged.conflicts:[{collection,id,field,winner}]` 外，还给 `conflictDetails:[{id,collection,recordId,label,field,baseValue,localValue,remoteValue,winner}]`；
  - 真实 merge 结束后把本次冲突详情整体写入 `~/.dsh/flowpilot/sync-conflicts.json`（0600 原子写，无冲突写空数组；newest/three-way/push/pull 不动它）；
  - `GET /flowpilot/api/sync/conflicts` → `{ok, count, conflicts:[...], at, localRevision, remoteRevision}`（文件缺失 → count 0）；
  - `POST /flowpilot/api/sync/conflicts/resolve` `{id?, choice:'local'|'remote', all?:bool}` →
    choice=remote 时把 `remoteValue` 写回本地记录字段（settings 写 `state.settings[field]`），save(revision+1) → `push({force:true})`
    上传并刷新 base → 从待审阅列表移除；返回 `{ok, applied, skipped, remaining, revision, uploaded}`；未配置通道 400 `SYNC_NOT_CONFIGURED`；
  - `POST /flowpilot/api/sync/conflicts/clear` → 清空列表不改数据 `{ok, cleared}`。
  - 客户端在设置 › 同步卡片内渲染「冲突审阅」面板（逐条采用本地/云端、批量、全部标记已阅）。
- 设置：`settings.syncIntervalMinutes`（整数 1~60，默认 **5**，旧数据由 `ensureSettingsDefaults` 补齐），
  `updateSettings` 可改，非法值 `INVALID_INPUT`。
- **写后自动同步**：`behavior.autoPushAfterWrite` 默认 **true**（旧 `sync.json` 缺字段视为开启，显式 `false` 关闭）。
  `POST /action`、`POST /ai/apply` 成功以及 agent 工具写操作成功后都会调用 `syncService.noteLocalWrite()`，
  宿主在 `debounceMs`（默认 3s）后执行一次 `run({ mode: 'merge' })`（与手动/定时同步同一语义）；
  并发写入合并，同步进行中再次触发只补跑一次；
  失败只写 `lastError`，不阻断本地写。只读 action（overview/today/listProjects 等）不触发。

客户端要求：

- 顶栏 ⟳ 即「立即同步」（调用 `/sync/run`，成功 toast 提示 direction，随后刷新 store）；
- 客户端按 `settings.syncIntervalMinutes` 定时自动同步（页面隐藏时跳过），设置弹窗「同步节奏」可改间隔；
- 同步面板仍复用原有 GitHub / WebDAV 配置界面与凭据存储（只存本机 0600 文件）。

## 4.4 节点模型 v2：证据策略 / 并行解锁 / 归档保护 / 审批详情

### A. 完成证据策略（替代写死的 设计稿 门槛）

`evidencePolicy = { kinds: LinkKind[]（空=任意类型）, minLinks: 0~10 }`

- 解析优先级：`node.evidencePolicy` → `project.evidencePolicy` → `settings.evidencePolicy` → 默认 `{ kinds: [], minLinks: 1 }`。
- 完成门槛 = 双角色全部通过 **且** 满足证据策略（按 kinds 过滤后的链接数 ≥ minLinks）。
- 不满足 → `NEED_EVIDENCE`（409），文案形如「请先补充确认依据：至少 1 条 任意类型 链接」。
- 写接口：`updateSettings {patch:{evidencePolicy}}`、`updateProject {evidencePolicy|null}`（null=清除回落 settings）、`createProject`/`addProject` 可选传。
- `NEED_DESIGN_LINK` 仅保留错误码常量，不再抛出。

### B. 解锁策略与跳过未解锁节点

- `settings.unlockPolicy: 'linear' | 'parallel'`（默认 linear），`project.unlockPolicy` 可覆盖。
- `parallel`：完成/跳过节点时把**同流程所有仍 locked 的节点**一次性解锁（handoff 依赖逻辑不变）。
- `skipNode` 允许对 `locked` 节点跳过（范围裁剪，原因必填，事件标注「范围裁剪」）；linear 下解锁其后的下一个 locked 节点，保证链条不断。

### C. 归档项目写保护

`startNode / completeNode / waitNode / blockNode / skipNode / reopenNode / approve / rejectApproval / setNodeSchedule / setNodeNotes / addNote / addLink / removeLink / addNode / removeNode / reorderNode / addFlow`
在改动前统一 `assertProjectWritable`：归档项目 → `INVALID_STATE`（409）「项目「X」已归档，恢复后才能修改」。
允许：`archiveProject`、`updateProject`（含 `archived:false`）、只读动作。

### D. 审批详情与 waiting 细分

- `node.approvalLog: [{ role, passed, by, at, comment, round }]`（approve/reject 都追加；`by` = actor，默认 `user`）。
- `node.returnReason: { by, at, comment, round, fromRole }`（reject 时写入）。
- `approve` 支持可选 `comment` / `by`。
- `node.waitingKind: 'approval' | 'external' | 'queued'`：部分审批通过 → `approval`；`waitNode` → `external`；完成/跳过/重开/解锁后清空。
- `derived.counts` 增加 `waitingApproval` / `waitingExternal`（`waiting` 总数语义不变）。

### E. 编号与 actor

- `addNode` 的 code = 同流程 `^X(\d+)$` 最大值 + 1（杜绝删节点后重复编号）；`reorderNode` 不改 code（code=身份，sortOrder=顺序）；支持显式 `code`（唯一性校验）。
- `engine.dispatch(action, payload, { actor })`；事件对象带 `actor`（HTTP 默认 `'ui'`，agent 工具 `'agent'`），老事件读取时 fallback `'user'`。

### F. 客户端

- 设置 › 完成与解锁：证据类型多选 chip（不选=任意类型）、最少证据数、解锁方式（线性/并行）。
- 节点详情：证据计数 chip（`证据 x/y`）、waiting 语义 chip（等对方确认 / 等外部跟进）、审批日志与退回原因、时间线显示非 user 操作者（AI）。
- 未解锁节点也显示「跳过」（带范围裁剪提示）；归档项目详情只读。

## 4.5 追加节点模板（appendTemplate）与 plannedAt

### A. 模板分层

- **流程模板**（`addFlow` 用）：`delivery`（设计交付 D01…）/ `acceptance`（验收 A01…）。
- **节点包模板**（只能追加，不能开流程）：`experiment`（实验推进）：E01 预跑观测(+0d) → E02 5% 白名单(+7d) → E03 50% 灰度(+14d) → E04 推全(+21d)。
  `addFlow({templateId:'experiment'})` → `INVALID_INPUT`。

### B. `appendTemplate`

`{ flowId, templateId: 'experiment', startAt?: ISO }`

- 在流程末尾按 `sortOrder` 追加整套节点；code 用模板前缀 + 同流程同前缀最大数字 +1（连续追加不会撞号）。
- 每个节点 `plannedAt = startAt（默认 ctx.now）+ offsetDays 天`。
- 解锁：流里已有 ready/active/waiting/blocked 节点 → 追加节点全部 locked；否则首个 ready（parallel 策略下可全部 ready）。
- 返回 `{ flowId, templateId, nodeIds, codes, plannedAt, appended }`；每节点写 `nodeAdded` 事件（含模板名与 code）。
- 归档项目 → 409；未知 flow → 404；非节点包模板 → 400。

### C. `plannedAt`

- `node.plannedAt: ISO | null`（老数据补 null）；`setNodeSchedule` 支持设置/清除（非法 ISO → 400）。
- 展示：节点卡「计划 X/X」chip；详情「计划与跟进 › 计划开始」。`code` 表示身份、`sortOrder` 表示顺序、`plannedAt` 表示计划时间，三者互不影响。

### D. 客户端

- 流程页头卡「追加节点模板」→ 弹窗（选流程 / 选模板 / 开始日期 / 阶段预览 E01–E04 与计划日）→ 提交 `appendTemplate`。
- 节点卡与详情展示 plannedAt；详情「计划与跟进」可直接编辑。

## 5. Agent tool

`flowpilot`（单个工具，`action` 参数）：参数是上面 action 名 + 常用字段的平铺集合
（`projectId/nodeId/lineId/title/templateIds/dueAt/followUpAt/status/role/passed/comment/url/kind/weekStart/mode/text/notes`），
执行后把 `{ok, result, summary, counts}` 返回给模型。只读动作：`overview`（= state+derived 摘要）、
`today`、`listProjects`。

---

## 6. Client 共享 API（Lead 提供，10-util.js / 20-store.js）

### 6.1 常量
```js
const FP_STATUS = {         // 顺序即语义
  locked:    { label:'未解锁', tone:'idle',    actionable:false, done:false, follow:false },
  ready:     { label:'待开始', tone:'brand',   actionable:true,  done:false, follow:false },
  active:    { label:'进行中', tone:'accent',  actionable:true,  done:false, follow:false },
  waiting:   { label:'待确认', tone:'warn',    actionable:false, done:false, follow:true  },
  blocked:   { label:'已阻塞', tone:'error',   actionable:false, done:false, follow:true  },
  revision:  { label:'待修改', tone:'amber',   actionable:true,  done:false, follow:false },
  completed: { label:'已完成', tone:'success', actionable:false, done:true,  follow:false },
  skipped:   { label:'已跳过', tone:'muted',   actionable:false, done:true,  follow:false },
};
const FP_STATUS_ORDER = ['locked','ready','active','waiting','blocked','revision','completed','skipped'];
const FP_TEMPLATE_META = {
  delivery:   { title:'设计交付流程', short:'设计交付', accent:'#2f6df6' },
  acceptance: { title:'验收流程',     short:'验收',     accent:'#7a5af8' },
};
const FP_LINK_KINDS = [{value:'design',label:'设计稿'},{value:'figma',label:'Figma'},{value:'doc',label:'文档'},{value:'other',label:'其他'}];
const FP_UI = { strings: {} };   // 见 6.5
```

### 6.2 日期/文本工具（全部纯函数）
```js
fpDateOnly(isoOrDate): 'YYYY-MM-DD'          // 本地
fpParseDate(s): Date
fpFmtDay(iso): '11月3日'                      // 含年时 '2026年11月3日'（跨年才带）
fpFmtDateTime(iso): '11月3日 14:00'
fpFmtTime(iso): '14:00'
fpFmtRange(startIso, endIso): '11月2日—11月6日'
fpRelativeDay(iso, now): '今天'|'明天'|'昨天'|'3 天后'|'逾期 2 天'|'—'
fpDaysLeft(iso, now): number|null
fpMinutesOfDay(hhmm): number
fpHHMM(date): 'HH:MM'
fpIsWorkday(date, workdays): boolean
fpWeekStart(date, weekStartsOn): Date        // 本地周一 00:00
fpNextWorkday(date, workdays): Date
fpPrevWorkday(date, workdays): Date
fpClamp(n, min, max)
fpUid(prefix): string
fpDownload(filename, text, mime)              // 触发浏览器下载
fpCopyText(text): Promise<boolean>            // clipboard + 兜底
fpSortBy(list, fn) / fpGroupBy(list, fn)      // 小工具
```

### 6.3 状态/Store（React hooks）
```js
function useFp(): { status:'loading'|'ready'|'error', revision, state, derived, error }
function fpDispatch(action, payload): Promise<{ok, error?, code?, result?, state?, derived?}>
function fpRefresh(): Promise<void>
function fpStore: { get(), subscribe(fn), dispatch, refresh }   // 非 React 场景
function useNow(intervalMs): Date                                 // 定时重渲染（默认 30s）
```

### 6.4 查询辅助（纯函数，client 侧）
```js
fpProjectNodes(state, projectId): Node[]                        // 按 flow.sortOrder, node.sortOrder
fpProjectFlows(state, projectId): Flow[]
fpNodeLinks(state, nodeId): Link[]
fpLineProjects(state, lineId, opts?): Project[]
fpProjectById(state, id): Project|undefined
fpNodeById(state, id): Node|undefined
fpEventsFor(state, {projectId?, nodeId?, limit?}): Event[]      // 新→旧
fpActiveProjects(state): Project[]
fpIsApprovalNode(node): boolean
fpCanComplete(node, links, approvals): {ok, code?, error?}      // 本地预检（最终以 host 为准）
```

### 6.5 文案（locale）
Lead 在 `80-apply.js` 里向 `ctx.locale` 注册 `flowpilot` 命名空间（zh/en），并把 `FP_T(key, fallbackZh)`
绑定到 `FP_UI.t`。组件主文案用 `FP_T('view.today','今日')`；长说明可直接写中文。
**所有 status/view/action 的标签都必须走 `FP_STATUS[x].label` 或 `FP_T`，不要在组件里重复硬编码。**

---

## 7. Client UI 组件契约

按 view 切换：`shell` 持有 `view ∈ 'flow' | 'today' | 'weekly' | 'handoff' | 'settings'`，
以及 `selectedProjectId / selectedNodeId`。子组件全部**受控**，不要在子组件里存业务状态
（弹窗开合、输入草稿等纯视图状态可本地 `useState`）。

### 7.1 ui-shell 提供（25-primitives.js / 30-shell.js）

```js
// 基础控件（受控、无副作用）
function FpButton({ children, variant='default'|'primary'|'ghost'|'quiet'|'danger', size='md'|'sm',
                    onClick, disabled, title, ariaLabel, icon, iconRight, fullWidth })
function FpIconButton({ label, title, onClick, active, size=28, children })   // children = svg 图标
function FpChip({ tone='muted'|'idle'|'brand'|'accent'|'success'|'warn'|'error'|'amber', children, dot, title, onClick })
function FpStatusChip({ status, size='sm' })            // 用 FP_STATUS[status]
function FpInput({ value, onChange, placeholder, type='text', autoFocus, onEnter, disabled, width })
function FpTextarea({ value, onChange, rows=3, placeholder, autoFocus, onKeyDown })
function FpSelect({ value, onChange, options:[{value,label}], disabled, width })
function FpSwitch({ checked, onChange, label, description })
function FpField({ label, hint, children, required })
function FpSection({ title, hint, actions, children })
function FpDialog({ open, title, description, children, actions, onClose, width=480, danger })
function FpConfirm(props)                                // {open,title,message,confirmLabel='确认',danger,onConfirm,onCancel}
function FpEmptyState({ title, description, actions, icon })
function FpSpinner({ label })
function FpDivider()
function FpToastHost()                                   // 根节点渲染一次
const FpToast = { push({ tone='info'|'success'|'error', text, timeout=3200 }) }
function FpIcon({ name, size=16, className })            // name ∈ §7.4 图标名

// 图标（唯一来源）
function FpSidebarGlyph({ size=18, active=false })       // 侧栏图标：流程节点连线

// Shell 根
function FpRoot()                                        // main 面板根组件
```

`FpRoot` 布局：顶部窄工具条（视图分段控件 + 刷新 + 节奏提示）→ 三栏
（左 264px 导航 / 中自适应 / 右 344px 详情，可折叠）。背景用 `--dsw-alias-bg-base`，
卡片 `--dsw-alias-bg-layer-1`，边框 `--dsw-alias-border-l1`。

### 7.2 ui-flow 提供（40-flow.js）

```js
function FlowView({ state, derived, project, selection, onSelectNode, onCollapseDetail,
                    onCreateProject, onAddFlow })     // 中央：项目标题区 + 纵向节点流（可多 flow）
function NodeDetail({ state, derived, project, node, onClose })  // 右侧：节点详情
function FlowNodeCard({ node, links, selected, now, onClick })   // 单个节点卡片（供 FlowView 内部用）
```
要求：
- 纵向节点流，节点之间连线；`revision` / 退回关系画回流线或轮次标记（PRD §5.2）。
- 当前执行节点明显但克制的强调；已完成节点降低视觉权重。
- 节点卡显示：code + 标题 + 状态 chip + 计划时间/跟进时间 + 角色 + 链接数 + 轮次。
- 节点详情操作：开始 / 完成 / 等待 / 阻塞 / 退回 / 重新打开 / 跳过 / 双角色确认（设计·产品各自通过/退回）/
  编辑计划与跟进时间 / 笔记 / 链接增删 / 事件时间线（读 `fpEventsFor`）。
- 完成门槛失败时展示 host 返回的中文原因（`fpDispatch` 的 `error`）。

### 7.3 ui-views 提供（50-views.js）

```js
function TodayView({ state, derived, onSelectNode, onOpenProject })      // 今日工作（PRD §5.3）
function WeeklyView({ state, derived })                                  // 周报（PRD §7）
function HandoffView({ state, derived, onOpenProject })                  // 日终交接（PRD §6.4）
function SettingsView({ state, derived, compact=false })                 // 设置与备份（工作时段/数据）
function ProjectCreateDialog({ open, onClose, state, defaultLineId })    // 新建项目（模板 + 交付日期）
function LineEditDialog({ open, line, onClose })                         // 业务线新增/重命名
function LinkDialog({ open, node, onClose })                             // 添加链接
function ScheduleDialog({ open, node, onClose })                         // 计划/跟进时间
function ReasonDialog({ open, mode='block'|'revision'|'skip', node, onClose })  // 阻塞/退回/跳过原因
function NodeAddDialog({ open, flow, onClose })                          // 自定义节点
function ProjectOverview({ state, derived, project })                    // 中央：未选节点时的项目概览（可选）
```
要求：
- Today：推荐 ≤5（来自 `derived.today.recommended`）→ 待跟进 → 近期截止；跨天节点显示
  `derived.today.handoffContext` 的上次上下文（PRD §5.3/§6.4）。
- Weekly：显示 `derived.weekly` 周区间、可编辑 textarea（action `updateReport`）、
  简洁/详细切换（`generateReport` mode）、复制 Markdown/纯文本（`fpCopyText`）、刷新。
  文案不得把未完成计划写成已完成。
- Handoff：列出当日 `active/revision/ready` 节点供勾选，填 nextActions/notes，保存后展示"次日 11:00
  恢复"说明；周五默认指向下周一。
- Settings：三个工作时段 + 静默窗 + 交接/周报时点编辑（`updateSettings`）、数据文件路径、
  导出备份（`/flowpilot/api/export`）、载入示例数据、清空数据（二次确认）。

### 7.4 图标名（FpIcon 支持，ui-shell 实现）
`plus, check, x, clock, calendar, alert, block, arrow-left, arrow-right, arrow-down, link, copy,
external, more, chevron-down, chevron-right, play, pause, rotate, skip, edit, archive, unarchive,
trash, today, flow, report, handoff, settings, filter, search, refresh, dot, flag, upload, download,
spark, moon, sun`

### 7.5 通用交互约束
- 主要动作（完成/等待/跟进）在节点详情或快捷浮层里 ≤2 次操作（PRD §11.2）。
- 危险动作（跳过/清空/归档）必须二次确认，并在事件里留痕。
- 所有异步动作期间按钮 disabled + 失败 toast；成功用 quiet toast（不要弹窗打断）。
- 键盘：`Esc` 关闭弹窗；节点详情支持 `⌘/Ctrl+Enter` = 完成、`W` = 等待（输入框内不触发）。
- 无障碍：`role="button"`/`aria-label`/焦点可见；弹窗用 `role="dialog"` + `aria-modal` + Esc。
- 窄窗口（<980px）自动折叠右栏；<720px 左栏折叠。
- 明暗主题都要能读：只用令牌色，不要写死颜色（图表/状态色可用 `color-mix`）。

---

## 8. 快捷浮层与侧栏（60-quick.js，Lead）

- `QuickDock`：`shell.overlay` 右下角悬浮胶囊（"菜单栏"替代，PRD §5.4）。折叠态只显示
  `active 数 / 待跟进数 / 最近截止`；点击展开卡片：今日前 3 个可推进节点（完成/等待）、
  待跟进清单、`打开 FlowPilot`、`日终交接`。不抢占键盘焦点，`Esc` 关闭。
- `FpSidebarGlyph`：`sidebar.panellist`，点击由宿主调用 `layout.selectPanel('flowpilot')`。
- `FpSettingsPage`：`settings.section`，渲染 `<SettingsView compact />`。

---

## 9. 完成标准（自检清单）

1. `node build-client.mjs && node build-host.mjs && node --check client.js && node --check index.js` 通过。
2. `client.js` 内不出现 `import`/`export`/`require('@deepseek-ai/...')`。
3. 所有 CSS 只用 `--dsw-*` 令牌或自有 `--fp-*` 变量；无写死十六进制（图标/图表除外）。
4. 组件在 `state`/`derived` 为 `null`（loading）和 `status==='error'` 时都不崩。
5. 无 `console.error` 未捕获；每个 `ctx.slots.register` 都有 `ctx.slots.inject` 包裹。
6. 中文界面，术语与 PRD 一致（未解锁/待开始/进行中/待确认/已阻塞/待修改/已完成/已跳过）。
