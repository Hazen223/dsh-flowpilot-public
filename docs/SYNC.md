# FlowPilot · 同步功能契约（GitHub / WebDAV）

给 FlowPilot 数据（`~/.dsh/flowpilot/data.json` 的 state）加**双向同步**，两条通道二选一：
**GitHub 仓库文件** 或 **WebDAV**。默认关闭，用户显式配置后才工作。

**同步语义（v1.5 起）：记录级三方合并（Three-way Merge）** —— 以 `sync-base.json`（上次同步的公共祖先）
为基准，按实体 id 把云端与本地改动做**记录级合并**（尽量两边都保留），真冲突按 **lastTouch**（最后修改）
决胜，合并结果写回本地并上传覆盖远端；默认模式**永不 409**。`mode:'newest'`（整份取最新覆盖旧的）与
legacy `mode:'three-way'`（旧三路比较，可能 409）保留为显式模式；写后自动同步同样走 `merge`（见 §5.1）。

## 0. 设计原则

1. **数据文件只有一个事实来源**：本地 `data.json` 仍是主库；远端只存「快照」。
2. **凭据只在本机**：存在 `~/.dsh/flowpilot/sync.json`（目录 0700、文件 0600），
   **不进 data.json、不进导出备份、不上传到远端、status 只回 `credentialsSet` 布尔**。
3. **默认记录级三方合并（merge）**：以 base 公共祖先为基准，按实体 id 合并两边改动（新增 / 修改 / 删除 /
   复活分别判定），冲突按 lastTouch 决胜（平局 local）；结果写回本地、上传覆盖远端、刷新 base。永不 409。
4. **合并/覆盖前先备份**：任何覆盖本地数据的动作先写
   `~/.dsh/flowpilot/backups/pre-sync-<ISO>.json`；三方合并前另写
   `~/.dsh/flowpilot/backups/pre-merge-<ISO>.json`（含 local / remote / base 三方原始 state）。
   两类备份各保留最近 10 份，前缀独立互不清理。
5. **空本地不覆盖云端**：只有一边有业务数据时，**有数据的一方赢**（新装 / 空数据设备不会把云端数据冲掉）；
   base 缺失时也按这条降级（见 §1.3）。
6. **写后自动同步也走 merge**：任何客户端写成功后（`POST /action`、`POST /ai/apply`、agent 工具写操作）
   `noteLocalWrite()` 在 `debounceMs`（默认 3s）后跑一次 `run({mode:'newest'})`；窗口内多次写合并一次、
   同步进行中再次触发只补跑一次；只读 action（overview/today/listProjects）不触发；失败只记 `lastError`，
   不阻断本地写。（写后自动同步与手动/定时同步同一语义：`mode:'merge'`，见 §5.1。）
7. **显式模式保留**：`mode:'newest'`（整份最新覆盖）与 `mode:'three-way'`（旧三路比较，deprecated，
   「本地与远端都改过」时 409 `SYNC_CONFLICT` 由用户选择方向）仍可用；`push`/`pull` 强制方向不变。
8. **无 npm 依赖**：宿主半只用 node: 内置模块 + 全局 `fetch`。
9. **一个实现两个调用者**：UI 走 HTTP 路由，agent 走 `flowpilot_sync` 工具，共用同一 service。

---

## 1. 模型

### 1.1 本地同步配置 `~/.dsh/flowpilot/sync.json`

```jsonc
{
  "version": 1,
  "provider": "off" | "github" | "webdav",
  "github": {
    "owner": "", "repo": "", "branch": "main",
    "path": "flowpilot/data.json",          // 仓库内路径，可带目录
    "apiBase": "https://api.github.com",    // 可换成 GitHub Enterprise / 自建网关
    "token": ""                              // secrets：只在本地
  },
  "webdav": {
    "url": "",                               // 目录 URL，如 https://dav.example.com/dav/flowpilot
    "username": "", "password": "",          // password 是 secrets
    "fileName": "data.json"
  },
  "behavior": {
    "autoPushAfterWrite": true,              // 任何写操作后 3s 防抖触发一次三方合并（默认开启；显式 false 关闭）
    "autoPullOnStart": false,                // 插件启动后异步拉取一次
    "debounceMs": 3000
  },
  "state": {                                  // 宿主内部，客户端只读 status
    "deviceId": "dev_xxx",
    "lastSyncedAt": null,
    "lastSyncedRevision": null,
    "lastRemoteRef": null,                    // GitHub: blob sha；WebDAV: ETag/LM
    "lastError": null, "lastErrorAt": null
  }
}
```

> 同步**间隔**不在这里：客户端定时同步间隔是数据设置 `data.json` 的
> `settings.syncIntervalMinutes`（整数 1~60，默认 5，用 `updateSettings` 修改），见 §5。

### 1.2 远端快照格式（上传/下载的 JSON）

```jsonc
{
  "formatVersion": 1,
  "app": "flowpilot",
  "kind": "sync-snapshot",
  "revision": 12,
  "savedAt": "ISO",
  "updatedAt": "ISO",
  "deviceId": "dev_xxx",
  "state": { /* 与 /state 返回的 state 完全同构 */ }
}
```
下载时校验：`state` 必须是对象且含数组集合、`revision` 必须是整数，否则
`SYNC_REMOTE_INVALID`（**绝不覆盖本地**）。

上传时 `savedAt` / `updatedAt` 取本地 `data.json` 的 `mtime`（毫秒精度）；newest 模式用它比较新旧，
merge 模式把它当快照元信息（真正的合并依据是 §1.3 的 base 快照 + state 内容）。

### 1.3 base 快照 `~/.dsh/flowpilot/sync-base.json`（三方合并的公共祖先）

与 `sync.json` 同目录（默认 `~/.dsh/flowpilot/sync-base.json`），记录**上一次同步成功后的 state**，
作为下一次合并的公共祖先（base）。原子写（同目录 tmp + rename），权限 **0600**（`0666 & ~0o022`）。

```jsonc
{
  "formatVersion": 1,
  "kind": "sync-base",      // 固定值，宿主用它区分 base 与普通备份
  "revision": 13,           // 写入时的 revision
  "savedAt": "ISO",
  "state": { /* 与 /state 的 state 同构 */ }
}
```

- **刷新时机**：每次成功上传（`push` / merge 上传）或成功拉取（`pull` / 降级 pull）后，用「本次同步的
  state + revision」覆盖 base；base 写失败只 warn，不影响同步结果。
- **缺失 / 损坏降级**（按顺序判断）：
  1. 远端还没有快照 → 直接 `push` 本地并写 base（`direction:'push'`，`baseMissing:true`）；
  2. base 缺失且本地为空数据（0 条 businessLines 且 0 个项目）→ 直接 `pull` 远端并写 base
     （`direction:'pull'`，`uploaded:false`）；
  3. base 缺失但两边都有数据 → **以空 base 做加法合并（union）**：所有记录只增不减，
     `baseMissing:true`、`merged.baseMissing:true`，不产生 deleted / pruned。

### 1.4 记录级三方合并规则（默认，`mode:'merge'`）

集合：`businessLines / projects / flows / nodes / dependencies / links / events / handoffs / reports`，
按记录 id 建 map（`dependencies` 没有 id，用 `fromNodeId→toNodeId#relation` 合成稳定 key）。

**可变集合**（businessLines / projects / flows / nodes / dependencies / links）逐记录三分：

| 本地 | 远端 | base | 行为 |
|---|---|---|---|
| 有 | 有 | 有 | 字段级三方（base∪local∪remote 的 key）：`lv===rv` 保留；`lv===bv` 取 remote；`rv===bv` 取 local；都改 → 冲突，lastTouch 新者赢（平局 local），记 conflict |
| 有 | 有 | 无 | 同上字段级规则（两边各自新增了同 id），冲突取 lastTouch 新者、平局 local |
| 有 | 无 | 有 | 远端删除：本地 lastTouch 比 base 更晚 → **复活**（记 resurrected），否则接受删除（记 deleted） |
| 无 | 有 | 有 | 本地删除：对称（远端更晚则复活） |
| 有 | 无 / 无 | 有 → 双方都删 | 记 deleted |
| 有/无 | 无/有 | 无 | 新增，直接采用（记 added） |

- **`lastTouch(record)`** = 记录自带 `updatedAt / createdAt / completedAt / confirmedAt / at` 的 ISO 最大值，
  再与**该侧** events 里引用它的最新时间取最大（node→`nodeId`、project→`projectId`、flow→`flowId`、
  businessLine→`businessLineId`；取不到就退回 projectId/flowId 反查）。都没有 → 0（旧数据）。
  注意按「各自一侧」的事件算：本地只看本地事件、远端只看远端事件，避免并集后永远平局。
- **追加型集合**（events / handoffs / reports）：按 id **求并集去重**（不删除已有记录）；events 按时间
  （`timestamp`，兼容 `at`）、handoffs 按 `date`、reports 按 `weekStart` 升序，同值再按 id 稳定排序。
- **引用完整性（合并后清理孤儿）**：删掉 `projectId` 不存在的 nodes / flows；删掉 `nodeId` 不存在的 links；
  删掉 from/to 节点不存在的 dependencies；events / handoffs 仅在「引用对象在 base 里存在、合并后消失」时
  一并清理（与 `deleteProject` 级联一致）；引用未知 id 的历史事件保留。
- **settings**：逐 key 三方（`lv===rv` 保留 / 一边等于 base 取另一边 / 都改 → **local 优先**并记 conflict）；
  `settings.dataFile` 强制用本地值（机器本地路径不能跨设备串）；其余 state 顶层标量沿用 local 后交给
  `normalizeState`。
- **revision**：合并结果 = `max(localRevision, remoteRevision) + 1`（保证单调），上传快照与写回本地都用它。
- **冲突候选值（conflictDetails）**：每个字段级冲突除旧结构 `{collection,id,field,winner}` 外，另记一条
  `{ id, collection, recordId, label, field, baseValue, localValue, remoteValue, winner,
  missingInBase, missingInLocal, missingInRemote }`：`id = ${collection}:${recordId}:${field}`（同一次合并内唯一）；
  `label` 取记录可读名（nodes=`code + title` / projects=title / businessLines=name / flows=name /
  links=title / settings=field）；三方原始值 JSON 可序列化，缺失用 `null` + `missingIn*` 标记。
  旧 `conflicts` 数组保留不动。冲突审阅（候选值持久化 + 人工确认）见 §1.7 / §2.5。
- **写盘顺序与失败语义**：① 先写 `backups/pre-merge-<ISO>.json`（含 local / remote / base）；
  ② `dataStore.save(mergedState, mergedRevision)`（本地写失败 → `SYNC_LOCAL_WRITE_FAILED`，不推进同步点）；
  ③ 上传合并结果覆盖远端（保证云端就是合并结果）；④ 写 base（失败只 warn，不影响本次同步）。
  全程不返回 409：传输层并发写（GitHub `409/412/422`、WebDAV `412`）内部重读远端重试一次，
  仍失败归一为 `SYNC_NETWORK`(502)。

### 1.5 最新覆盖判定（`mode:'newest'`，非默认）

显式 `mode:'newest'` 时：拉远端快照，按「谁更新用谁」决定方向：

- **本地时间戳**：本地 `data.json` 的 `mtime`（取整到毫秒；文件不存在则视为空）。
- **远端时间戳**：快照 `updatedAt`，缺失/非法时退 `savedAt`；两者都没有 → 视为本地较新。

| 情况 | 方向 |
|---|---|
| 远端还没有快照 | `push`（上传本地快照） |
| 只有远端有业务数据（本地为空数据） | `pull`（有数据的一方赢，空本地不覆盖云端） |
| 只有本地有业务数据 | `push` |
| 远端 `updatedAt` 比本地 mtime 新 | `pull`（先写 pre-sync 备份再覆盖本地），**然后回传** |
| 本地更新 / 远端时间戳缺失 / 两者都无 | `push` |
| 双端时间戳与 `revision` 完全一致 | `noop`（内容一致，不拉取，但仍会再上传一次） |

判定结束后都会用当前本地快照上传一次，保证云端拿到最新副本；newest 也永不 409。
（默认同步与写后自动同步都不走 newest，见 §1.4 / §5.1。）

### 1.6 三路比较（`mode:'three-way'`，deprecated 兼容保留）

记 `lastSyncedRevision`（上次成功同步时的 revision）；**仅**显式 `mode:'three-way'`
（HTTP body 或 service 调用传入）或带 `force:'push'|'pull'` 时使用：
- `remoteChanged = remote.revision !== lastSyncedRevision`
- `localChanged  = localRevision   !== lastSyncedRevision`

| remoteChanged | localChanged | 行为 |
|---|---|---|
| false | false | `noop` |
| true | false | `pull`（远端更新，本地干净 → 快进） |
| false | true | `push`（本地更新 → 上传） |
| true | true | 409 `SYNC_CONFLICT`，等用户选择方向 |

首次同步（`lastSyncedRevision === null`）：本地有数据且远端为空 → `push`；
远端有数据且本地为空数据（0 业务线 0 项目）→ `pull`；两边都有数据 → 409 冲突。
**注意：这是兼容路径，默认 merge 不会走到这里。**

### 1.7 待审阅冲突 `~/.dsh/flowpilot/sync-conflicts.json`

merge 会按 lastTouch 自动决胜，但「被自动覆盖掉的候选值」会持久化到本文件，供客户端「冲突审阅」
逐条确认（resolve / clear 见 §2.5）。与 `sync.json` 同目录，原子写 + **0600**；写失败只 warn，不影响同步。

```jsonc
{
  "formatVersion": 1,
  "kind": "sync-conflicts",
  "at": "ISO",                 // 本次 merge 时间
  "localRevision": 12,         // merge 前的本地 revision
  "remoteRevision": 13,        // merge 前的远端 revision
  "conflicts": [               // 没有冲突时是空数组（不是删文件）
    { "id": "nodes:nd_x:status", "collection": "nodes", "recordId": "nd_x",
      "label": "D04 交互稿", "field": "status",
      "baseValue": "ready", "localValue": "blocked", "remoteValue": "completed",
      "winner": "local", "at": "ISO" }
  ]
}
```

- **写入时机**：每次**真实**（非 dryRun）merge 成功后**整体替换**为本次的冲突详情（无冲突 → `[]`）。
- **非 merge 模式**（`newest` / `three-way` / `push` / `pull`）**不动**本文件（避免误清）。
- **resolve / clear** 成功后再更新：已解决项从列表移除；全部解决后保留空数组。
- 文件缺失 / 损坏 → 视为空列表（不报错）；`service.conflictsFile` 可读路径。


---

## 2. HTTP 路由（追加到 `API_PATHS`）

| 方法 | 路径 | 请求 | 成功响应 |
|---|---|---|---|
| GET | `/flowpilot/api/sync/status` | — | `{ok, status}` |
| POST | `/flowpilot/api/sync/config` | `{provider?, github?, webdav?, behavior?, secrets?:{githubToken?, webdavPassword?}}` | `{ok, status}` |
| POST | `/flowpilot/api/sync/test` | `{}` | `{ok, detail}` |
| POST | `/flowpilot/api/sync/run` | `{mode?: 'merge'\|'newest'\|'three-way', force?: 'push'\|'pull', dryRun?: bool}`（**默认 merge**） | 见 §2.3：顶层 `{ok, mode, direction, action, uploaded, *Revision, *UpdatedAt, merged, …}` + 嵌套 `result` |
| POST | `/flowpilot/api/sync/push` | `{force?: bool}` | `{ok, action:'push', revision, remote, bytes}` |
| POST | `/flowpilot/api/sync/pull` | `{force?: bool}` | `{ok, action:'pull'\|'noop', revision, applied, backupPath?}` |
| GET | `/flowpilot/api/sync/conflicts` | — | `{ok, count, conflicts, at, localRevision, remoteRevision}` |
| POST | `/flowpilot/api/sync/conflicts/resolve` | `{id?, choice:'local'\|'remote', all?}` | `{ok, applied, skipped, remaining, revision, uploaded}` |
| POST | `/flowpilot/api/sync/conflicts/clear` | `{}` | `{ok, cleared}` |

### 2.1 status

```jsonc
{ "ok": true, "status": {
  "provider": "github" | "webdav" | "off",
  "providerLabel": "GitHub 仓库" | "WebDAV" | "未启用",
  "configured": true,                    // provider 已选且必填字段齐、凭据已存
  "credentialsSet": true,
  "remoteTarget": "owner/repo@main:flowpilot/data.json" | "https://…/data.json" | null,
  "behavior": { "autoPushAfterWrite": true, "autoPullOnStart": false },
  "localRevision": 7,
  "localUpdatedAt": "ISO",
  "localCounts": { "businessLines": 3, "projects": 4, "nodes": 33, "events": 42 },
  "lastSyncedAt": "ISO" | null,
  "lastSyncedRevision": 7 | null,
  "hasPendingChanges": true,
  "lastError": null, "lastErrorAt": null,
  "deviceId": "dev_x",
  "dataFile": "/Users/x/.dsh/flowpilot/data.json"
} }
```

### 2.2 test → detail

```jsonc
{ "ok": true, "detail": {
  "provider": "github", "reachable": true, "remoteFound": true,
  "remoteRevision": 12, "remoteUpdatedAt": "ISO", "remoteBytes": 43209,
  "latencyMs": 320, "message": "已连接 owner/repo@main，远端存在快照（r12）"
} }
```

### 2.3 组合动作 run（默认 merge）

请求：

```jsonc
{ "mode": "merge" | "newest" | "three-way",   // 默认 merge（省略 mode 等价）
  "dryRun": true,                              // 可选：完整算一遍但不落盘（不写 backup/base/state/remote）
  "force": "push" | "pull" }                   // 可选：人工覆盖方向（走旧的强制路径，不做自动回传）
```
- 非法 `mode` / `force` → 400 `INVALID_INPUT`；
- `mode:'three-way'` 与 `force` 是 legacy 路径（可能 409），其余情况永不 409。

**成功响应（200，默认 merge）** —— 顶层与嵌套 `result` 都给同一组字段：

```jsonc
{ "ok": true, "mode": "merge",
  "direction": "merge", "action": "merge", "uploaded": true,
  "localRevision": 12,            // 同步前的本地 revision
  "remoteRevision": 13,           // 同步前的远端 revision（远端无快照 → null）
  "mergedRevision": 14,           // 合并结果 revision = max(local, remote) + 1
  "localUpdatedAt": "ISO", "remoteUpdatedAt": "ISO",
  "baseMissing": false,           // base 快照缺失（首次合并）时为 true
  "baseRevision": 14,             // 合并后写入 base 的 revision
  "basePath": "/Users/x/.dsh/flowpilot/sync-base.json",
  "backupPath": "…/backups/pre-merge-….json",   // 合并前的三方备份
  "bytes": 43209,
  "merged": {
    "added": { "projects": 2, "nodes": 6 },     // {集合: 计数}，只列非零集合
    "updated": { "nodes": 1 },
    "deleted": { "links": 1 },
    "pruned": { "events": 3 },                  // 合并后清理的孤儿 / 级联清理
    "conflicts": [ { "collection": "nodes", "id": "nd_x", "field": "status", "winner": "remote" } ],
    "resurrected": [ { "collection": "nodes", "id": "nd_y" } ],
    "baseMissing": false                        // 客户端用它在 toast 里提示「首次合并，无历史基准」
  },
  "conflictDetails": [                          // 可审阅冲突（候选值；与 merged.conflicts 一一对应）
    { "id": "nodes:nd_x:status", "collection": "nodes", "recordId": "nd_x",
      "label": "D04 交互稿", "field": "status",
      "baseValue": "ready", "localValue": "blocked", "remoteValue": "completed",
      "winner": "local", "missingInBase": false, "missingInLocal": false, "missingInRemote": false }
  ],
  "result": {  // 客户端读这个（fpSyncNow → result.direction / result.merged / result.conflictDetails）
    "mode": "merge", "direction": "merge", "action": "merge", "uploaded": true,
    "localRevision": 12, "remoteRevision": 13, "mergedRevision": 14,
    "localUpdatedAt": "ISO", "remoteUpdatedAt": "ISO",
    "baseMissing": false, "basePath": "…/sync-base.json", "backupPath": "…/pre-merge-….json",
    "merged": { /* 同上 */ }, "conflictDetails": [ /* 同上 */ ], "dryRun": false
  } }
```

**降级分支**（仍返回 `mode:'merge'` 与同一组字段，只是 `direction` / `action` 不同）：

| 情况 | direction / action | uploaded | mergedRevision | merged 统计 |
|---|---|---|---|---|
| 远端还没有快照 | `push` | true | 本地 revision | 空（`{}` / `[]`）；`baseMissing` 取决于 base 文件是否存在（缺失时 true） |
| base 缺失 + 本地为空数据 | `pull` | false | 远端 revision | 空，`baseMissing:true`（先写 pre-sync 备份） |
| base 缺失 + 两边都有数据 | `merge` | true | 空 base 加法 union 的 `max+1` | 只增不删，`baseMissing:true` |

`dryRun:true`：返回同样的字段 + `"dryRun": true`、`uploaded:false`；不写 pre-merge 备份、不写 base、
不写本地数据文件、不上传远端、也不更新 `sync-conflicts.json`（远端读请求照常发生）。

失败是可读错误（**不会 500 崩溃**）：
- 未配置通道 → 400 `SYNC_NOT_CONFIGURED`，如
  `{"ok":false,"code":"SYNC_NOT_CONFIGURED","error":"尚未启用同步通道，请先选择 GitHub 仓库或 WebDAV 并保存配置"}`；
- 非法 `mode` / `force` → 400 `INVALID_INPUT`；
- 远端快照损坏 → 422 `SYNC_REMOTE_INVALID`（绝不覆盖本地）；
- 本地写失败 → 500 `SYNC_LOCAL_WRITE_FAILED`；网络 / 5xx → 502 `SYNC_NETWORK`。

`mode:'newest'` 成功响应（显式模式）：`action/direction` 为 `push|pull|noop`，字段同上，
`localRevision/remoteRevision` 为同步后双端 revision，另带 `reason`（`no-remote` / `remote-newer` /
`local-newer` / `in-sync` …），`backupPath` 仅在覆盖过本地时出现。

`mode:'three-way'` 成功响应沿用旧结构：

```jsonc
{ "ok": true, "action": "push" | "pull" | "noop",
  "local": { "revision": 7, "updatedAt": "ISO", "counts": {...} },
  "remote": { "revision": 12, "updatedAt": "ISO" } | null,
  "appliedRevision": 12, "backupPath": "…/backups/pre-sync-…json" }
```
three-way 下「本地与远端都改过」返回 **409**（legacy 路径独有）：
```jsonc
{ "ok": false, "code": "SYNC_CONFLICT", "error": "本地与远端都改过，请选择覆盖方向",
  "conflict": { "local": {...}, "remote": {...}, "lastSyncedRevision": 7,
                "options": ["push", "pull"] } }
```

### 2.4 错误码

`SYNC_NOT_CONFIGURED`(400) / `SYNC_AUTH_FAILED`(401) / `SYNC_NETWORK`(502) /
`SYNC_REMOTE_INVALID`(422) / `SYNC_CONFLICT`(409) / `SYNC_LOCAL_WRITE_FAILED`(500) / `INVALID_INPUT`(400)。

默认 merge / newest 路径不会返回 409：传输层并发写（GitHub `409/412/422`、WebDAV `412`）由宿主内部
重读远端、重新判定后重试一次；merge 重试后仍撞并发写 → 归一为 `SYNC_NETWORK`(502)（保证「merge 绝不 409」）。
`SYNC_CONFLICT`(409) 只在 `mode:'three-way'` 或 `force` 强制路径出现。

### 2.5 冲突审阅（merge 后人工确认被覆盖的候选值）

merge 会按 lastTouch 自动决胜，但候选值会写进 §1.7 的 `sync-conflicts.json`；客户端通过下面三条接口
展示「待审阅冲突」并逐条 / 批量选择本地或云端值。

**GET `/flowpilot/api/sync/conflicts`**（未配置通道也能读，方便 UI 展示；文件不存在 → `count:0`）：
```jsonc
{ "ok": true, "count": 1,
  "conflicts": [ { "id": "nodes:nd_x:status", "collection": "nodes", "recordId": "nd_x",
                   "label": "D04 交互稿", "field": "status",
                   "baseValue": "ready", "localValue": "blocked", "remoteValue": "completed",
                   "winner": "local", "at": "ISO" } ],
  "at": "ISO", "localRevision": 12, "remoteRevision": 13 }
```

**POST `/flowpilot/api/sync/conflicts/resolve`** body `{ id?: string, choice: 'local'|'remote', all?: boolean }`：
- 校验：`choice` 必须是 `local` / `remote`；缺 `id` 且 `all !== true` → 400 `INVALID_INPUT`；
- 未配置通道 → 400 `SYNC_NOT_CONFIGURED`（不允许只改本地造成双端不一致）；
- 逐条处理：`choice:'remote'` → 把该条的 `remoteValue` 写回本地 state 对应位置
  （`state[collection]` 按 `recordId` 找；`collection==='settings'` 时写 `state.settings[field]`；
  `missingInRemote` 则删除该字段）；`choice:'local'` → 把该条的 `localValue` **写回**本地 state
  （`missingInLocal` 则删除字段），即恢复本地候选值（不再是仅标记已审阅）；
- 记录已被删除等找不到的情况 → 跳过并放进 `skipped`；
- 有实际应用时：`dataStore.save(state, revision+1)` → 上传（force push，云端=本地、刷新 base）→
  从待审阅列表移除；没有任何应用则不走写盘/上传。
```jsonc
{ "ok": true, "applied": 1,
  "skipped": [ { "id": "nodes:nd_gone:status", "reason": "记录已不存在（可能已被删除）" } ],
  "remaining": 0,          // 处理后在列表里剩余的条数
  "revision": 14,          // 写入后的本地 revision（未应用任何项时保持原值）
  "uploaded": true }       // 未应用任何项为 false
```

**POST `/flowpilot/api/sync/conflicts/clear`** body `{}`：仅清空待审阅列表（不改数据）：
```jsonc
{ "ok": true, "cleared": 3 }
```

---

## 3. 传输实现

### 3.1 GitHub（REST Contents API）

- 读：`GET {apiBase}/repos/{owner}/{repo}/contents/{path}?ref={branch}`
  header `Authorization: Bearer <token>`、`Accept: application/vnd.github+json`、`X-GitHub-Api-Version: 2022-11-28`
  → 200：`{content: base64, sha, size}`；404 → 远端不存在。
- 写：`PUT .../contents/{path}` body `{message, content: base64, branch, sha?}`
  （已有则带 `sha`；新建不带）。`409/412/422` → 视为并发冲突 → `SYNC_CONFLICT`
  （默认 merge / newest 下宿主会重读远端重试一次；merge 重试后仍失败归一为 `SYNC_NETWORK`）。
- 401/403 → `SYNC_AUTH_FAILED`；`apiBase` 可配置（GHE 或测试桩）。
- `remoteRef` = blob `sha`。

### 3.2 WebDAV

- 读：`GET {url}/{fileName}` → 200：body 文本 + `ETag`/`Last-Modified`；404 → 远端不存在。
- 写：`PUT {url}/{fileName}`，body 为快照 JSON，`Content-Type: application/json`；
  乐观并发：已知 ETag 时带 `If-Match: <etag>`，未知时带 `If-None-Match: *`；
  `412 Precondition Failed` → `SYNC_CONFLICT`（默认 merge / newest 下宿主会重读远端重试一次；
  merge 重试后仍失败归一为 `SYNC_NETWORK`）。
- 目录不存在（PUT 404/409）：逐级 `MKCOL`（最多 5 层）后重试一次。
- 测试连接：`PROPFIND {url}`（`Depth: 0`）→ 207/200；405/501 时退化为 `OPTIONS`。
- 401/403 → `SYNC_AUTH_FAILED`；`remoteRef` = ETag。

### 3.3 通用

- 超时 15s/请求；网络错误或 5xx 重试 2 次（指数退避 300/900ms）。
- 所有请求加 `User-Agent: dsh-flowpilot/<version>`。
- 日志里**绝不打印** token/password（脱敏为 `***`）。

---

## 4. 宿主改动

- `lib/sync.js`：`createSyncService({ engine, store, logger, config, version })`
  → `status()` / `configure(patch)` / `test()` /
    `run({ mode?: 'merge'|'newest'|'three-way', force?: 'push'|'pull', dryRun?: bool })`
    （**默认 merge**：记录级三方合并 + 上传合并结果 + 刷新 base，永不 409；`newest` 整份最新覆盖、
    `three-way`/`force` 旧行为保留）/
    `push({force})` / `pull({force})` / `noteLocalWrite()`（写后自动同步用：防抖后跑一次 **merge**）/
    `start()`（自动拉取用）/ `stop()`（清理定时器）/
    `conflicts()` / `resolveConflicts({ id?, choice:'local'|'remote', all? })` / `clearConflicts()`（冲突审阅）；
    只读 `syncFile / backupDir / dataFile / baseFile / conflictsFile`。
- 合并实现（同文件内）：`mergeThreeWay(baseState, localState, remoteState)` 纯函数（可变集合字段级三方 +
  lastTouch、append-only 并集、删除/复活、合并后孤儿清理、settings 三方、revision 由调用方算；
  冲突额外产出 `conflictDetails` 候选值）；base 快照读写（`sync-base.json`，原子写 / 0600 / 失败只 warn）；
  `pre-merge` 备份（保留 10 份）；待审阅冲突 `sync-conflicts.json`（0600 原子写，真实 merge 后整体替换，
  resolve/clear 维护）；`recordLabel()` 生成可读 label。
- `lib/http.js`：追加 **9 条**路由（6 条同步 + 3 条冲突审阅）；`POST /sync/run` **默认 `mode:'merge'`**、`mode` 白名单
  `merge|newest|three-way`，响应带嵌套 `result`（含 merge 的 `merged` 统计 / `conflictDetails` / `basePath` 等），
  未配置通道返回 400 可读错误；`GET /sync/conflicts` 未配置也可读；
  `POST /action`、`/ai/apply` 成功后调用 `sync.noteLocalWrite()`。
- `index.js`：建 service、传给路由与工具；activate 后 `sync.start()`；config 支持
  `syncFile`（默认 `~/.dsh/flowpilot/sync.json`）便于测试。
- `lib/tooldef.js` + `index.js`：工具 **`flowpilot_sync`**
  `action ∈ status|configure|test|sync|push|pull`；`action=sync` 默认 `mode:'merge'`
  （`mode:'newest'|'three-way'` 可显式指定），参数
  `provider, owner, repo, branch, path, token, url, username, password, fileName, mode, force, direction, dryRun`。
- `lib/domain.js`：新增设置 `settings.syncIntervalMinutes`（整数 1~60，默认 5；
  `updateSettings` 校验，非法值 `INVALID_INPUT`；旧数据缺字段/非法旧值自动回落 5）。
- `lib/selftest.mjs`：mock GitHub Contents / WebDAV（可注入 401/404/409/412/5xx），
  覆盖旧同步链路（未配置、配置保存与 0600、test、push/pull、三路比较 409、force、坏 JSON 拒绝覆盖、
  pre-sync 备份、写后自动同步（防抖/防重入/失败不阻断，走 merge）、`syncIntervalMinutes`）；
  **18 条 merge 用例**（两个模拟客户端对同一桩：base 缺失 union、两种降级、不同记录都保留、
  lastTouch 冲突、删除级联、复活、events 并集有序、settings 冲突、revision/上传一致、base 0600、
  dryRun 零写入、pre-merge 三方备份、二次收敛、newest/three-way 不回归、derived 可算）；
  **14 条冲突审阅用例**（conflictDetails 三方值/label/稳定 id + settings、dryRun 不写文件、
  真实 merge 写 0600 文件、无冲突清空旧列表、损坏文件按空、GET 路由、resolve remote/local、all 批量、
  不存在 id / 记录已删 skipped、clear 不改数据、非 merge 不清空、未配置 resolve 400、HTTP 三条路由 + 参数校验 + 405）。
- **兼容**：同步凭据/状态仍只写本地 `sync.json`；新增的唯一 state 字段是
  `settings.syncIntervalMinutes`（默认 5，旧数据自动补齐，导出/导入不受影响）。
  `sync-base.json`、`sync-conflicts.json` 与 `backups/pre-merge-*.json` 都是本机辅助文件：
  不进 data.json / 导出 / 远端。

---

## 5. 客户端：定时 / 手动同步 + 设置页面板

### 5.1 定时 / 手动同步（30-shell.js）

- **顶栏 ⟳ = 立即同步**：`fpSyncNow()` → `POST /flowpilot/api/sync/run` body `{mode:'merge'}`；
  完成后按 `result.direction` 提示：`merge`=展示 `result.merged` 统计（新增 / 更新 / 删除 /
  「冲突 N 处按最新时间解决」，`merged.baseMissing` 时提示「首次合并，无历史基准」）；
  `pull` / `push` / `noop`（降级或旧模式）用对应文案兜底。失败用 `error` 中文文案提示。
- **默认每 5 分钟自动同步一次**（静默，失败不打扰；页面 `visibilityState === 'hidden'` 时跳过）：
  间隔读 `state.settings.syncIntervalMinutes`，整数 1~60、默认 5；设置页的
  「同步节奏」用 `updateSettings { patch: { syncIntervalMinutes } }` 修改（非法值宿主返回 `INVALID_INPUT`）。
  定时同步与顶栏按钮一样走 `mode:'merge'`。
- **写后自动同步（走 `merge`）**：任何本地写成功后
  （`POST /action`、`POST /ai/apply`、agent 工具写操作）宿主调用 `noteLocalWrite()`，
  在 `behavior.debounceMs`（默认 3s）后执行一次 `run({mode:'merge'})` —— 与手动 / 定时同步同一语义
  （按 base 记录级三方合并，两边改动都保留）。窗口内多次写合并为一次、同步进行中再次触发只补跑一次（防重入）、
  只读 action（overview/today/listProjects）不触发；`behavior.autoPushAfterWrite` 显式 false 可关闭；
  失败只记 `lastError`，不阻断本地写。
- 未配置通道时 `run` 返回 400 `SYNC_NOT_CONFIGURED`（可读错误，不会 500）；
  手动同步显示该错误，静默同步不弹 toast（宿主把 `lastError` 记到 status）。

### 5.2 设置页面板（55-sync.js）

导出（函数声明）：
```js
function FpSyncPanel(props)   // 自包含：自己取 status、自己调路由；不读写 store
const CSS_SYNC = String.raw`...`
```
- 挂在「设置与备份」页（50-views.js 的 SettingsView 末尾，Lead 负责接线），
  用 `fpvSettingsGroup(title, hint, children)` 包一层以保持视觉一致。
- 内容：
  1. 通道选择：关闭 / GitHub / WebDAV（切到某通道才显示其字段）。
  2. GitHub：owner、repo、branch、path、Token（password 输入，占位提示「已保存，留空则不修改」）、
     高级：apiBase。
  3. WebDAV：目录 URL、用户名、密码（同占位规则）、文件名。
  4. 行为：`自动上传（保存后）`（语义 = 写后自动同步，默认开启、走三方合并 merge）、`启动时自动拉取` 两个开关。
  5. 按钮：保存配置 / 测试连接 / 立即同步（双向，默认三方合并 merge）/ 上传 / 下载。
  6. 状态条：已同步 / 待同步 / 有冲突 / 配置不完整 / 最近错误；显示
     `本地 r7 · 远端 r12 · 上次同步 11:20 · 设备 dev_x`。
  7. 冲突：仅在 `mode:'three-way'` 或 force 路径返回 409 时就地显示
     「本地 r9 与远端 r12 都改过」+ 两个按钮「用本地覆盖远端」「用远端覆盖本地」；
     默认 merge 同步不产生 409，字段级冲突按 lastTouch 自动解决并计入 `merged.conflicts` 统计，
     不会出现这一块。
  8. 说明文案：凭据仅存本机 0600 文件，不进数据文件/导出/远端；合并前写 pre-merge 备份、
     覆盖前写 pre-sync 备份；写后自动同步与手动同步一致（三方合并 merge）。
  9. 冲突审阅（后续新增面板，调 §2.5）：merge 后若 `result.conflictDetails` 非空，展示每条冲突的
     `label / field` 与 base / local / remote 三方候选值及当前 winner，支持逐条「用本地 / 用云端」、
     「全部用本地 / 全部用云端」与「忽略（clear）」；数据来自 `GET /sync/conflicts`，
     操作走 `POST /sync/conflicts/resolve`、`POST /sync/conflicts/clear`。
- 规则：不写全局 store、不修改数据；失败就地中文错误；加载中禁用按钮；`state`/`props` 缺失不崩。

---

## 6. 验收

- `node lib/selftest.mjs`：**150/150 全绿**（136 基线不回归 + **14 条冲突审阅用例**；
  基线含 18 条 merge 用例）。冲突审阅主要覆盖点：
  `conflictDetails` 三方原始值 / label / 稳定 id（settings 也覆盖）、dryRun 也返回候选值且**不写**
  `sync-conflicts.json`、真实 merge 写 0600 文件且内容与 result 一致、无冲突 merge 把旧列表写成空数组、
  损坏文件按空列表、`GET /sync/conflicts`（未配置可读、文件不存在 count:0）、
  `resolve` choice=remote 写回 remoteValue + revision+1 + 上传一次 + 列表移除（再 merge 收敛）、
  choice=local 写回 localValue（winner=remote 时恢复候选值；winner=local 时值不变但 applied 计 1）仍上传、
  `all:true` 批量、不存在 id / 记录已删 → skipped 且 remaining 不变、
  `clear` 只清列表不改数据、newest/three-way/push/pull **不清空**待审阅列表、未配置 resolve 400、
  三条 HTTP 路由 + 参数校验 + 405。
- `node tests/client-smoke.mjs`：`FpSyncPanel` 渲染（无配置 / 有配置 / 冲突 / 错误 四态）不崩。
- 实机（Lead）：本地起 GitHub 桩 + WebDAV 桩，通过真实 HTTP 路由完成
  「配置 → test → 立即同步（首次：base 缺失降级上传）→ B 端改项目并 push → A 端改另一条记录 →
  立即同步（merge：两边都保留、conflict 统计正确）→ 同一字段双改 → 立即同步（conflictDetails 出现）→
  GET /sync/conflicts 审阅 → resolve remote / local / all → 再合并收敛 → clear」
  全链路，并校验本地 `sync.json` / `sync-base.json` / `sync-conflicts.json` 权限 0600、
  数据文件未被破坏、`pre-merge` 三方备份生成、resolve 后云端=本地。
