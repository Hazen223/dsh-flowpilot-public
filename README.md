# FlowPilot · 流程驾驶舱（DSH Harness Web UI 插件）

> **关于本仓库**：这是 FlowPilot 的**脱敏公共版**。示例业务线/项目名（增长推广、会员中心、数据看板等）均为虚构；
> 内部工具名已统一改为「设计稿」（代码字段 `designLink` / `kind:'design'`），内部设计系统/品牌名也已替换为通用表述。
> 功能与私有仓库的 v1.5.1 一致。

按 PRD《FlowPilot｜基于流程节点的个人项目管理工具》实现的 **Web 面板插件**：把「业务线 → 项目 → 流程实例 → 节点」这套推进模型放进 DeepSeek Harness 的主面板，配合今日队列、日终交接与周报自动汇总。

> PRD 里的 macOS / SwiftUI / 菜单栏 / UserNotifications 表述在本插件里**按 Web 形态改写**：
> - 主窗口三栏 → Harness 主面板（`main`，key = `flowpilot`）
> - 菜单栏常驻 → 右下角常驻快捷浮层（`shell.overlay`）
> - 系统通知 + 工作时段提醒 → 面板内「节奏感知」提示（按工作时段/静默窗计算，不抢注意力）
> - SwiftData 本地存储 → 宿主 JSON 文件（`~/.dsh/flowpilot/data.json`，原子写 + 导出/导入）

## 能力对照 PRD

| PRD | 实现 |
|---|---|
| §3 流程模板 | 设计交付 D01–D07、验收 A01–A05；一个项目可同时挂两个流程，D07 完成自动解锁 A01 |
| §4 节点状态 | 未解锁/待开始/进行中/待确认/已阻塞/待修改/已完成/已跳过；状态变更全部落事件 |
| §4.3 双角色确认 | D04/D06 分别记录「设计」「产品」确认；需双方通过 **且** 有 设计稿链接才可完成；任一方退回 → 回到 D03/D05，轮次 +1，历史保留 |
| §5.1/5.2 界面 | 左侧业务线/项目导航（显示当前阶段）、中央纵向节点流（连线/返工标记）、右侧节点详情 |
| §5.3 今日工作 | 推荐处理（≤5）→ 等待跟进 → 近期截止；顶部显示上次交接上下文 |
| §5.4 菜单栏 | 右下角浮层：可推进/待跟进数、今日前三条（完成/等待一键）、最近截止、打开面板 |
| §6 节奏感知 | 按三个工作时段 + 静默窗计算当前阶段与提示，静默时段不显示提示 |
| §6.4 日终交接 | 勾选当日节点 + 下一步动作 + 备注；次日上午呈现；周五默认指向下周一 |
| §7 周报 | 按业务线/项目从节点事件生成（简洁/详细两档），可编辑、可复制 Markdown/纯文本；周五 12:05 后自动补生成草稿 |
| §8 事件模型 | 每个有实际影响的操作写 `WorkEvent`，周报/时间线/交接都消费它 |
| §9.4 隐私 | 全部数据只在本机 JSON 文件，无云同步、无外部 AI 调用 |
| §10 P0 | 项目/业务线管理、模板、节点可视化、推进、跟进时间、浮层、节奏、交接、周报、本地存储与导出 |
| P1 | 模板节点增删/排序、快速记录（浮层推迟）、事件时间线 |

明确不做（PRD §10.2）：团队协作、工时统计、活动监控、自动读取 设计稿/Figma 内容、AI 判定设计质量。

## 组成

```
dsh-flowpilot/
  index.js             宿主入口（export name / inject / apply）
  lib/templates.js     两套流程模板（含确认角色、退回关系）
  lib/store.js         JSON 持久化（原子写、迁移、备份）
  lib/domain.js        状态机、解锁、双角色确认、派生视图、周报、交接
  lib/http.js          /flowpilot/api/* 路由
  lib/tooldef.js       本地 defineTool 等价实现（不依赖宿主 npm 包）
  lib/ai.js            AI 建流程：LLM 调用、prompt、JSON 归一化、规则兜底（见 docs/AI-PRD-DIALOG.md）
  lib/sync.js          同步：GitHub / WebDAV、记录级三方合并（mode:'merge'）、0600 凭据、pre-merge / pre-sync 备份（见 docs/SYNC.md）
  lib/selftest.mjs     固定时钟自测
  client.js            浏览器半（由 build-client.mjs 拼装，勿手改）
  src/client/*.js      client 源码片段：util / store / primitives / shell / flow / ai / views / sync / quick / css / apply
  build-client.mjs     client 拼装 + 语法与禁用模式检查
  docs/CONTRACT.md     数据形状与组件接口契约（并行开发用）
  docs/AI-PRD-DIALOG.md  AI 解析 PRD 建流程的接口契约
  docs/SYNC.md         同步功能契约（通道/路由/冲突/备份）
  docs/UPDATE.md       版本检查与一键更新契约（tag 检查/重装/重启/错误码）
  docs/UI-DESIGN.md    UI 规范：设计系统 用色、4 栅格间距、去描边配方、令牌迁移表
  tools/audit-ui.mjs   UI 一致性审计（描边/间距/颜色/令牌迁移）
```

## HTTP API

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/flowpilot/api/state` | `{ok, revision, state, derived}` |
| POST | `/flowpilot/api/action` | `{action, payload}` → 同一形状 + `result` |
| GET | `/flowpilot/api/export` | 备份 JSON 下载 |
| POST | `/flowpilot/api/import` | 用备份整体替换 |
| GET | `/flowpilot/api/ai/status` | AI 可用性（provider/model/reason） |
| POST | `/flowpilot/api/ai/parse` | `{text, businessLineHint?, extraInstructions?}` → `{proposal, meta}`（只提案不落库） |
| POST | `/flowpilot/api/ai/apply` | `{proposal, businessLineId?}` → 建项目 + 自定义流程节点 |
| GET | `/flowpilot/api/sync/status` | 同步状态（provider/configured/本地 revision/上次同步/非敏感配置回显） |
| POST | `/flowpilot/api/sync/config` | 保存通道配置（深合并；`secrets` 留空不修改，空串=清除） |
| POST | `/flowpilot/api/sync/test` | 连通性测试（GitHub repo / WebDAV PROPFIND），返回远端是否有快照 |
| POST | `/flowpilot/api/sync/run` | 双向同步：默认三方合并（`mode:'merge'`，返回 `merged` 统计，永不 409）；`mode:'newest'` 整份最新覆盖；`mode:'three-way'` 旧比较（可能 409 `SYNC_CONFLICT`） |
| POST | `/flowpilot/api/sync/push` | 强制上传本地快照 |
| POST | `/flowpilot/api/sync/pull` | 强制下载远端快照（覆盖前自动备份） |

数据文件：`~/.dsh/flowpilot/data.json`（可用插件行 config 的 `dataDir` 覆盖）。

## Agent 工具

`flowpilot`（单一工具，`action` 参数）与 UI **共用同一份领域实现**：
`overview` / `today` / `listProjects` / `createLine` / `createProject` / `startNode` /
`completeNode` / `waitNode` / `blockNode` / `skipNode` / `reopenNode` / `approve` /
`addLink` / `setNodeSchedule` / `addNote` / `generateReport` / `saveHandoff` / `seedDemo` 等。

## 安装与生效

本目录已作为 bundle 安装进 desktop profile（`dsh.profile.bundles` 末位，
`pnpm` 以 `link:` 引用本目录，改动本目录即生效于下一次加载）。

**安装后必须重启 DSH 才会加载宿主行**（插件管理器返回 `restart-required`）。
重启后：

1. 左侧栏出现 **FlowPilot** 图标 → 点击进入三栏驾驶舱（`main` 面板，key = `flowpilot`）；
2. 右下角出现常驻快捷浮层（可推进/待跟进计数 + 今日前三条快捷完成/等待）；
3. 设置 → **FlowPilot** 一节可改工作时段、导出/导入数据；
4. agent 侧出现 `flowpilot` 工具（`overview` / `today` / `createProject` / `completeNode` / `approve` / `generateReport` / `saveHandoff` …）。

数据文件：`~/.dsh/flowpilot/data.json`（可用插件行 config 的 `dataDir` 覆盖）。
首次安装时预置了一份示例数据（3 条业务线 / 4 个项目，覆盖"设计交付进行中 / 等待产品确认 / 验收等研发 / 刚创建"四种状态）；
在「设置」里可以一键清空或重新载入。

## 从 GitHub 安装

发布仓库（公共）：`https://github.com/Hazen223/dsh-flowpilot-public`（发布标签 `v1.5.1`）。

前置条件：新电脑已安装 DSH NEXT 并完成初始化；公共仓库无需登录 GitHub。

1. DSH NEXT → 设置 → **插件** → **添加插件**；
2. 输入仓库地址 `https://github.com/Hazen223/dsh-flowpilot-public`（固定版本用 `...#v1.5.1`）；
3. 安装完成后按提示重启 DSH（宿主行需要重启才加载）；
4. 验证：左侧栏出现 FlowPilot、右下角浮层、设置里的 FlowPilot 一节、agent 侧 `flowpilot` 工具。

迁移数据（可选）：

- **直接拷贝**：把旧机器的 `~/.dsh/flowpilot/data.json` 放到新机器同一路径（首次启动前放置，或覆盖后重启）；
- **多机同步**：用 `flowpilot_sync` 工具配置 GitHub / WebDAV 通道，旧机器 push、新机器 pull
  （凭据只存本机，详见 `docs/SYNC.md`）。

更新：本机改完后 `git add -A && git commit -m "..." && git push`，再到新电脑「插件」页移除后重新安装
（或安装时指定新 tag / commit）。

## 版本历史

- **v1.5.1**（2026-11-04）：修复「点更新报错」——pnpm 解析 git 依赖时会另起 `git` 子进程，不继承更新检查的
  `-c credential.helper` 覆盖；macOS 上若 `gh auth setup-git` 的 `credential.https://github.com.helper`
  排在 generic `store` 之前，会拿到旧令牌 → 403 更新失败。现在通过 `GIT_CONFIG_*` 环境通道强制 pnpm 内部 git
  也只用 `~/.git-credentials`（store-only）并禁止交互式提问；失败信息附带 pnpm stderr 尾部。宿主自测 151/151。
- **v1.5.0**（2026-11-03）：同步改为**记录级三方合并**（默认 `mode:'merge'`，base 快照 `sync-base.json`，
  字段级三方 + lastTouch 决胜 + 删除/复活 + pre-merge 备份；`newest` / `three-way` 保留为显式模式）；
  新增**冲突审阅面板**（`sync-conflicts.json` 0600，逐条/批量采用本地或云端、全部已阅，三个新路由）；
  自测 **150/150**（118 基线 + 18 条 merge 用例 + 14 条冲突审阅用例）。
- **v1.4.0**（2026-11-03）：**写后自动同步**——任何客户端（界面 / agent 工具 / HTTP）写入成功后 3s 防抖触发一次同步
  （`behavior.autoPushAfterWrite` 默认开启，只读操作不触发，失败不阻断本地写）；
  顶栏响应式：宽度 <1120px 时同步/设置/节奏/汇总/时钟收进「⋯」下拉菜单，<860px 品牌只留图标；
  顶栏 FlowPilot 入口 chip 点击展开**快捷面板**（当前节奏、可推进/待跟进/逾期统计、三条可推进可直接完成/推迟、
  等待跟进、最近截止、底部打开工作台/今日/交接/同步）；自测 118/118、客户端交互 39/39、几何量测全绿。
- **v1.3.0**（2026-11-03）：同步改为默认「最新覆盖」（newest-wins，本地/云端取最新互相覆盖，不再产生 409 冲突）；
  顶栏「立即同步」+ 默认每 5 分钟自动同步（间隔 1~60 分钟可在设置调整）；
  顶栏重构（设置改为居中浮层弹窗、窄屏自适应不溢出、FlowPilot 入口 chip 自动隐藏）；
  主题色自定义（紫色/蓝色/品牌粉 + 色相滑杆，只旋转色相不改饱和度/明度）；右栏详情可收起；
  左栏底部改为「新建业务线 + AI 建流程」并修正左右间距；流程页视觉调整（信息卡/节点卡分离、进度条通栏、导轨同轴、当前节点高亮条）；
  宿主同步 newest 模式 + `syncIntervalMinutes` 设置；自测 112/112、客户端交互 31/31、几何量测全绿。
- **v1.2.1**（2026-11-03）：更新检查的凭据健壮性修复——存在 `~/.git-credentials` 时强制只用文件凭据
  （macOS 系统级 keychain 助手在无 GUI 会话时会卡住等待弹窗，iMac 实测复现），并禁止任何交互式提问；宿主自测 99/99。
- **v1.2.0**（2026-11-03）：**版本检查与一键更新**——设置页新增「版本与更新」面板、主面板顶栏更新提醒徽标；
  启动后自动检查 + 每 6h 检查远端 `vX.Y.Z` tag，发现新版本一键重装并重启生效；开发模式（link）只检查不重装；
  新增 `docs/UPDATE.md`；宿主自测 98/98。
- **v1.1.0**（2026-11-03）：UI 全面重设计（设计系统 2.0 配色、4 栅格间距、去描边，描边 172 → 1）；
  项目归档/删除（删除前自动备份 + 二次确认）；节点完成/跳过后自动跳转下一节点；设计稿链接自动继承；
  `deleteProject` / `addFlow` 等新 agent 动作；宿主自测 90/90、客户端冒烟、UI 审计全绿；
  新增 `docs/UI-DESIGN.md` 与 `tools/audit-ui.mjs` / `tools/verify-live.mjs`。
- **v1.0.0**（2026-11-03）：首个版本——业务线/项目/流程节点、今日队列、双角色确认与退回、日终交接、周报、
  AI 建流程（PRD → 流程）、GitHub/WebDAV 同步。

## 开发

```bash
node build-client.mjs        # src/client/*.js → client.js
node --check client.js && node --check index.js
node lib/selftest.mjs        # 领域规则自测
```

装进当前 profile：`plugin_manager` → `install_bundle`，target = 本目录绝对路径。

## 已知边界

- 单设备、单人、本地优先；多机数据同步走 `flowpilot_sync`（GitHub / WebDAV），不做账号体系与服务端后端。
- 通知由面板与浮层呈现，不申请系统通知权限（PRD 的低打扰原则在 Web 形态下的等价实现）。
- 设计稿 / Figma 只存链接，不读取内容（PRD §9.3）。

## 项目操作：归档 / 删除

左栏项目条目 **右键**（或行内悬停出现的「⋯」）打开上下文菜单：打开项目 / 归档或恢复 / **删除项目**。

- 删除是**物理删除且不可撤销**：级联清理该项目的流程、节点、链接、依赖、事件，以及交接记录里对这些节点的引用。
- 删除前自动把完整快照写入 `~/.dsh/flowpilot/backups/pre-delete-<时间>.json`（保留最近 10 份）。
- 二次确认弹窗会显示将删除的流程数与节点数，并提示「只想从列表收起请用归档」。
- agent 工具同款：`flowpilot` 的 `deleteProject`（必须显式传 `confirm: "DELETE"`）。

## 节点自动跳转

在当前节点点「标记完成」或「跳过」后，界面会**自动选中下一个节点**并同步右侧详情面板，
同时把下一张节点卡平滑滚到可视区中间，保持「一条流程往下走」的连续感：

- 下一个节点 = 同流程内 sortOrder 更大的第一个未完成节点；
- 若已到本流程末尾，则沿跨流程 handoff 跳到下一个流程（D07 → A01），或同项目后续流程的首个未完成节点；
- 重新打开已完成节点、或手动点选其它节点时不会触发跳转（只在「选中节点完成/跳过」的那一刻触发）。

## 设计稿链接继承

设计稿文件是项目级产物、链接通常不变，所以节点**完成**或**跳过**时，它上面的 设计稿链接会自动复制到
**后继节点**（同流程的下一个节点 + 跨流程 handoff 目标，例如 D07 → A01）：

- 复制出的链接带 `inheritedFrom`（源节点 id），节点详情的「关联链接」里会显示紫色「继承」小标，
  悬停提示「继承自 D03：…」；事件时间线也会记录「继承 设计稿链接」。
- 目标节点已有相同 URL 时去重；已完成/已跳过节点不接收；链式继承成立（D05→D06→D07→A01）。
- 可在设置里关闭：`updateSettings` 传 `{ patch: { inheritDesignLink: false } }`（默认开启）。

## AI 建流程（PRD → 流程节点）

主面板顶栏点 **「AI 建流程」**（或空数据引导）→ 粘贴 / 拖入 PRD（`.md/.txt`）→ 选填业务线与补充要求
→ 解析（默认走 DSH 当前会话模型，`deepseek-account / deepseek-flash`）→ 预览并微调提案
（标题、业务线、截止、每个节点的标题/说明/角色/双角色确认、增删排序）→ **生成项目**。

- **AI 只提案，不落库**：解析结果是一份可编辑 proposal，点「生成项目」才写入，并写 `projectCreated / flowAdded / nodeAdded` 事件。
- **规则兜底**：模型不可用 / 超时 / 输出不是合法 JSON 时退回规则解析（标题 + markdown 表格里的节点），并标注「规则解析」，不假装是模型结果。
- **能力两个入口**：UI 与 agent 工具共用同一实现——工具 action `parsePrd`（只解析）与 `createProjectFromPrd`（解析并建项目）。
- 路由：`GET /flowpilot/api/ai/status`、`POST /flowpilot/api/ai/parse`、`POST /flowpilot/api/ai/apply`。
- 可配置：插件行 config 里 `aiProvider / aiModel / aiTimeoutMs`（默认 90 秒）；不改配置就用会话默认模型。

> 新增客户端界面后需要**刷新页面**（DSH 窗口内 ⌘R）才能加载新的 client.js；宿主半已热更新生效。

## 同步（GitHub / WebDAV）

设置页「设置与备份」最下方新增 **同步** 卡片。两条通道二选一，**默认关闭**：

| 通道 | 需要填写 | 说明 |
|---|---|---|
| GitHub 仓库 | Owner、Repo、Branch（默认 main）、仓库内路径（默认 `flowpilot/data.json`）、PAT | 需要 contents 读写权限（经典 token 勾 `repo`，或 fine-grained 的 `Contents: Read and write`）；高级项可改 API 地址（GitHub Enterprise 可用） |
| WebDAV | 目录 URL（如 `https://dav.jianguoyun.com/dav/FlowPilot`）、用户名、密码、文件名 | 兼容 Nextcloud / 坚果云 / Synology 等标准 WebDAV；目录不存在时会逐级 MKCOL |

行为语义：

- **默认「三方合并」（three-way merge，`mode:'merge'`）**：以 `~/.dsh/flowpilot/sync-base.json`
  （上次同步的公共祖先）为基准，**按实体 id 做记录级合并**：
  - 可变集合（业务线/项目/流程/节点/依赖/链接）：逐字段三方判断——一边没改取另一边；
    两边都改 → 取「最后修改时间（lastTouch）」更新的一方，平局取本地，并记一条 conflict；
  - append-only（事件/交接/周报）：按 id 求并集去重再排序，两边记录都保留；
  - 删除与复活：只在一边消失且另一边没改 → 接受删除；另一边改过 → 复活（记 resurrected）；
  - settings 逐 key 三方，冲突本地优先，`dataFile` 强制本地值；
  - 合并结果 revision = `max(本地, 云端) + 1`，**随后上传覆盖云端**，所以云端始终是合并后的最新副本；
  - **永不返回 409**，返回可读统计：
    `result: { mode:'merge', direction:'merge', uploaded, localRevision, remoteRevision, mergedRevision, baseMissing,
    merged: { added, updated, deleted, pruned, conflicts, resurrected, baseMissing } }`。
  - base 缺失时降级：本地空 → 拉取云端；云端空 → 上传本地；两边都有数据 → 以空 base 做加法合并（绝不删除，标记 `baseMissing`）。
  - 需要旧行为时显式传 `mode:'newest'`（整份最新覆盖）或 `mode:'three-way'`（旧三路比较，可能 409）；
    `push` / `pull` 强制方向接口保留。
- **冲突审阅面板**：merge 遇到「两边改了同一字段」时按 lastTouch 自动决策，同时把三方候选值
  （base / 本地 / 云端）存到 `~/.dsh/flowpilot/sync-conflicts.json`（0600），并在 设置 › 同步 卡片里显示
  「冲突审阅」：逐条或批量选择「采用本地 / 采用云端」、或「全部标记已阅」；
  采用后写回本地 → revision+1 → 上传云端（base 同步刷新）。合并 toast 会提示「待审阅 N 条」。
- **主动同步 + 自动同步**：顶栏的 ⟳ 按钮即「立即同步」；客户端默认**每 5 分钟**自动同步一次，
  间隔可在「设置 › 同步节奏」里改成 1~60 分钟（`settings.syncIntervalMinutes`）。
- **写后自动同步**：任何一个客户端（界面 / agent 工具 / HTTP）成功写入后（新建项目、节点状态等），
  宿主会在 3s 防抖后**主动跑一次三方合并同步**（`behavior.autoPushAfterWrite` 默认 `true`，显式 `false` 才关闭）；
  并发写入合并成一次，同步进行中再次触发只补跑一次；失败只记 `lastError`，不阻断本地写。
- **覆盖本地前自动备份** 到 `~/.dsh/flowpilot/backups/pre-sync-<时间>.json`；
  三方合并前另写一份 `backups/pre-merge-<时间>.json`（含本地 / 云端 / base 三方原始数据），各自保留最近 10 份。
- **凭据只存本机** `~/.dsh/flowpilot/sync.json`（目录 0700 / 文件 0600），不进数据文件、不进导出备份、
  不上传远端；日志脱敏，`status` 只回显非敏感配置。
- 可选开关：`自动上传（保存后）`（3s 防抖，**默认开启**，写后跑一次三方合并）、`启动时自动拉取`（默认关）。
- agent 工具 `flowpilot_sync`：`status / configure / test / sync / push / pull`，与界面共用同一实现。

## 版本检查与一键更新

插件会自己检查 GitHub 上的新版本（只认 `vX.Y.Z` 发布 tag，不追 `main` 上的普通 commit）：

- **自动检查**：宿主启动 5 秒后静默检查一次，之后每 6 小时一次；结果缓存 30 分钟，失败只记状态不打扰。
- **更新提醒**：发现新版本时主面板顶栏出现「可更新 vX.Y.Z」徽标；已安装待重启时显示「重启生效」，点击跳到设置页。
- **设置页「版本与更新」**：当前版本 / 最新版本 / 最近检查时间 / 检查失败原因；按钮
  「检查更新」「更新到 vX.Y.Z」「重启 DSH」。
- **一键更新**（仅 git 安装的机器）：用 DSH 自带 pnpm 重新安装远端最新 tag，装完点「重启 DSH」生效；
  更新只替换插件代码，不会碰 `~/.dsh/flowpilot/data.json`，不上传任何数据。
- **开发模式（link 安装）**：只检查不自动重装，更新请在本机 `git pull` 后重启 DSH。
- 公共仓库无需凭据即可检查更新；检查失败只在面板显示错误，不影响插件其它功能。

接口形状、错误码与流程见 `docs/UPDATE.md`。

## 界面结构与偏好

- **顶栏**：品牌 + 4 个视图（流程/今日/周报/交接）+ 节奏/汇总 + **立即同步** + **设置 icon** + 时钟。
  **宽度不足（<1120px）时，同步 / 设置 / 节奏 / 汇总 / 时钟全部收进一个「⋯」入口**：
  点开后是下拉菜单（立即同步、设置、今日工作，以及当前节奏、待办统计、当前时间），点别处 / Esc / 滚动即关闭；
  再窄（<860px）品牌只留图标，视图按钮只留 icon。
  设置不再占一个 tab：点齿轮在界面正中弹出**浮层弹窗**（Esc / 点遮罩关闭），窄屏时视图按钮只留 icon、自动隐藏时钟与汇总，不再横向溢出。
- **左栏底部**：`新建业务线` + **AI 建流程**（原「新建项目」位置）；`新建项目` 入口只保留在业务线标题右侧的 `+`。
- **右栏**：节点详情卡片顶部有**收起按钮**（与收起态的展开按钮同一位置）；流程页标题里的「收起详情」已移除。
- **顶栏入口（FlowPilot chip）**：工作台未打开时显示在 harness 顶栏（FlowPilot + 可推进/待跟进计数）；
  点击后在按钮**下方展开「快捷面板」**（移植自旧版右下角浮层：当前节奏提示、可推进/待跟进/逾期统计、
  现在可推进的三条（可直接「完成 / 推迟」）、等待跟进、最近截止，底部是「打开工作台 / 今日 / 交接 / 同步」）；
  面板向下弹出、右缘与入口对齐、超出视口自动限高并可滚动，点别处 / Esc / 滚动即关闭；打开工作台后入口与面板一起隐藏。
- **主题色**：设置 › 外观 · 主题色，预设 紫色（默认）/ 蓝色 / 品牌粉，也可用滑杆自定义色相（0~360）。
  只旋转色相，每个令牌的饱和度/明度沿用原值（accent `S100 L66.3/68`、strong `S100/84 L61.6/63.1`），存在本机 `localStorage`。
- **流程页**：项目信息卡与项目节点卡是两张分开的白卡（间距 12）；节点导轨的实线/回退虚线共用同一条竖直轴并与节点圆点同心；
  当前节点左侧主题色高亮条贯穿整卡（被卡片圆角裁切）；信息卡底部的流程进度条通栏铺满卡片宽度。

## UI 设计规范（设计系统 用色 + 4 栅格 + 去描边）

界面按 `docs/UI-DESIGN.md` 执行，三条硬约束：

1. **用灰阶面分隔，不用描边**：容器/卡片/列表行/按钮/输入框都靠背景层级区分
   （应用底 `--fp-base` → 卡片 `--fp-surface` → 嵌块 `--fp-surface-2` → 悬停 `--fp-hover`），
   全量描边从 172 降到 ≤24。只有聚焦环（box-shadow/outline）和极淡分隔线保留。
2. **间距只用 4 栅格**：`padding`/`margin`/`gap` ∈ {0,4,8,12,16,20,24,32,40}；
   圆角 ∈ {4,8,12,16,999}。历史 352 处非栅格间距已清零。
3. **颜色走 设计系统 2.0 色板**：浅/深双模式用 `light-dark()` 承载
   （应用底、卡片、文字四级、业务强调色、成功/警告/错误/信息色），
   不再引用 `--dsw-alias-*` 颜色令牌，也不再出现调色板外的 HEX。

自检：`node tools/audit-ui.mjs --strict`（描边预算 / 非栅格间距 / 非法颜色 / 令牌残留）。

**实机自检**：`node tools/verify-live.mjs`（可加 `--port=61855`）——
探测正在运行的实例是否已加载新宿主（`inheritDesignLink` 设置项、`deleteProject` 动作、只读路由）。
宿主代码改动必须**退出 DSH NEXT 再打开**才生效（热重载会被 module-comparison 拒绝，刷新页面不够）。

> **本轮改动需要再重启一次 DSH**：宿主改了 `lib/sync.js`（三方合并 + 写后自动同步 merge + 默认开启）/ `http.js`（mode 白名单）/ `index.js`（agent 写操作也通知同步），
> 客户端改了界面（顶栏响应式「⋯」入口 / 顶栏入口的快捷面板 / 设置弹窗 / 主题色 / 流程页视觉），两者都随应用启动加载，热重载会被 `module-comparison` 拒绝。
> 重启后跑 `node tools/verify-live.mjs --port=<GUI 端口>` 自检应为 **7/7**；
> 想连真实同步一起验，加 `--exercise-autosync`（会做一次真实云同步），应为 **8/8**。

## 验证状态（本地实测，2026-11-03）

| 项目 | 结果 |
|---|---|
| 宿主自测 `node lib/selftest.mjs` | **151/151 通过**：存储原子写/revision/坏文件/导入导出、状态机（解锁·双角色门槛·退回轮次·跨流程 handoff·skip·reopen）、derived 形状、焦点静默、周报两档、HTTP 路由与错误码、apply 三种 ctx 降级路径、版本检查与更新、newest/merge、冲突审阅（conflictDetails 候选值 / resolve local·remote / 批量 / clear / 未配置 400 / HTTP 三路由） |
| 同步冲突审阅 | 14 例：merge 产出三方候选值（label/稳定 id/缺失标记）、dryRun 不写 `sync-conflicts.json`、真实 merge 写 0600 且与结果一致、无冲突清空旧列表、GET 只读（缺失→0 / 损坏按空）、resolve local（winner=remote 时恢复 localValue）、resolve remote（写回+revision+1+上传一次+再 merge 收敛）、批量 all、记录已删 skipped、clear 不改数据、newest/three-way/push/pull 不清空、未配置 400 |
| 客户端离线渲染 `node tests/client-smoke.mjs` | **通过**：真实 fixture 下 loading/ready/empty 三场景渲染 79 组件 469 元素无崩溃；FlowView 状态标签命中；NodeDetail 33 个状态变体；8 个弹窗 `open` 渲染；AI 对话框 3 个状态变体；同步面板 4 个状态变体、更新面板；点击处理器实际调用无异常；未知事件 kind 容错 |
| 构建产物 | `client.js` 633.4 KiB / 16 864 行；零 `#rrggbb`、零 `import/export`、零 Harness Client 包依赖 |
| UI 规范审计 `node tools/audit-ui.mjs --strict` | **达标**：描边 172 → **1**（仅 spinner 环）、非 4 栅格间距 352 → **0**、调色板外 HEX 33 → **0**、`--dsw-alias-*` 颜色令牌 314 → **0** |
| 界面几何量测（无头 Chrome 计算样式） | **顶栏宽度 1440/1280/1180/1024/900/768 六档零横向溢出**；项目行「⋯」与截止/状态零重叠；**设置弹窗 9/9**（fixed 遮罩、水平+垂直居中、≤880px、无描边、圆角 12、内容可滚动）；**流程视觉 6/6×2 主题**（进度条通栏、实线/回退虚线同轴并与圆点同心、当前节点高亮条贯穿整卡）；**井底铺满 10/10×2 主题** |
| 客户端交互测试（迷你 React 真实事件链路） | **39/39 通过**（1440/1120/1000/980/720/560 六档宽度各自全绿）：顶栏设置 icon → 居中弹窗（含主题色预设/自定义色相/自动同步间隔）、左栏底部「AI 建流程」、顶栏同步按钮 → `POST /sync/run {mode:'newest'}`、右栏顶部收起 → rail 展开、顶栏 chip、主题色只换色相（S/L 不变、越界取模）；右键菜单 20/20 仍通过 |
| UI 静态渲染目检 | 浅色/深色流程视图、设置弹窗、今日视图均已目检，灰阶分层/无描边/设计系统色板均符合规范 |
| 安装 | `plugin_manager install_bundle` → `application: restart-required`（新 bundle 行需重启加载） |
| 删除/继承端到端 | **22/22 通过**：真实模块 + 真实 HTTP 服务，覆盖继承（含 inheritedFrom/去重/事件）、删除级联、confirm 守卫、404、备份文件、revision、derived |
| 版本检查/更新 | **8/8 通过**：版本比较与 tag 解析、profile/link 安装识别、检查缓存与 force、git 失败错误码、apply 重装、restart、HTTP 四路由 |
| 同步 newest 模式 | `lib/selftest.mjs` 新增 13 例：无远端上传 / 云端更新拉取+回传+备份 / 本地更新上传 / 双改不冲突 / 空本地不覆盖云端 / dryRun / 未配置 400 / 连续两次不抖动 / HTTP 默认 newest + result 结构 + 非法 mode / `syncIntervalMinutes` 默认与校验 |
| 同步端到端（旧三路） | **41/41 通过**：真实模块 + 真实 `node:http` 服务 + 本地 GitHub Contents / WebDAV 协议桩，覆盖 配置→test→push→快进pull→双改409→force 解决→切通道→备份→0600 权限→导出不含凭据 |
| 实机目检 | 主面板内景仍未人工目检（本会话合成点击送不进该 Electron webview）；同步界面需重启后看一眼 |

主题适配说明：主按钮（`.fp-btn--primary`、快捷浮层 CTA）的填充与文字**成对钉死**为
`light-dark(#0f1115, #f9fafb)` / `light-dark(#fff, #0f1115)`，跟随宿主注入的 `color-scheme`，
不依赖任何令牌语义；深色主题自动反转为近白底 + 近黑字。这是有意的例外（其余颜色仍走令牌）。

已知取舍：
- 「添加自定义节点」弹窗（P1）组件已实现，但驾驶舱里暂无入口；该能力可通过 `flowpilot` 工具的 `addNode` 动作使用。
- Toast 宿主挂在主面板；仅停留在设置页或浮层时，提示会排队等主面板出现再显示。
- profile 里旧的 `dsh-mcp-flowpilot`（对接旧 macOS 版的 MCP）仍在，与新插件互不影响，可在插件管理里移除。

## 实机验收（2026-11-03 11:13 重启后）

| 检查项 | 结果 |
|---|---|
| `flowpilot` agent 工具 | ✅ 已注册；`overview`/`today`/`listProjects` 返回真实派生数据 |
| `/flowpilot/api/{state,action,export,import}` | ✅ `GET state` 200（35 KB）、`POST action` 200、`GET export` 200 |
| 客户端槽位 | ✅ `main`(key=flowpilot) / `sidebar.panellist`(id=flowpilot) / `shell.overlay`(id=flowpilot-quick) / `settings.section`(id=flowpilot) 全部 `active: true` |
| 左侧栏入口 | ✅ 截图确认出现 FlowPilot 图标行 |
| 右下角浮层 | ✅ 截图确认真实数据「2 可推进 · 2 待跟进 · 明天」 |
| 主面板内景 | ⚠️ 未做人工目检：本机 DSH 窗口无 AXWindow，合成点击无法送达 webview（非插件问题），需用户点一下侧栏确认 |

**首次重启后发现的真实缺陷（已修复并热更新）：**
插件行最初只 `inject: ['tools']`，cordis 在 `webServer` 就绪之前就 apply，
`ctx.get('webServer')` 取到 undefined → 4 条路由全部跳过注册，
浏览器侧 `fetch('/flowpilot/api/state')` 404，界面显示「FlowPilot 未连接」。
修复：`export const inject = ['tools', 'webServer']`（与 dsh-plugin-magi 同款），
selftest 增加对应断言；热重载后日志出现「HTTP 路由就绪」，浮层随即恢复真实计数。
