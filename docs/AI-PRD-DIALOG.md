# FlowPilot · AI 建流程（PRD 解析）功能契约

在 FlowPilot 主面板里新增一个 **AI 对话框**：粘贴/拖入 PRD 文本 → 宿主调用 DSH 的 LLM
解析成「项目 + 流程节点」草稿 → 用户确认/微调 → 一键生成项目。

设计原则：
1. **AI 只提案，不落库**。解析结果是一份可编辑的 proposal，用户点「生成项目」才写入，
   并走既有 `events` 记录（可追溯）；解析本身不产生业务数据。
2. **规则兜底**。LLM 不可用 / 输出不是合法 JSON 时，退回规则解析（标题 + 表格里的节点），
   并明确标注 `source: 'heuristic'`，不假装是模型结果。
3. **一个实现两个调用者**：UI 与 agent 工具共用宿主同一份 `createAiService` 方法。

---

## 1. 宿主：`lib/ai.js`

```js
export function createAiService({ ctx, engine, logger, config }) → {
  status(): { available, provider, model, reason?, modelSource }
  async parsePrd(input): Promise<{ ok, proposal, meta }>
  async applyProposal(input): Promise<{ ok, projectId, lineId, flowId, nodeCount, revision, state, derived, result }>
}
```

### 1.1 `status()`
- 懒取服务：`ctx.get('llm')`（**不要**写进 `inject`，避免无 LLM profile 整插件不激活）、
  `ctx.get('agentDefaultModel')`。
- 路由解析顺序：`config.aiProvider + config.aiModel` → `agentDefaultModel.currentSelection()`
  → 报错 `AI_NO_MODEL`。`available=false` 时带 `reason`。

### 1.2 `parsePrd({ text, businessLineHint, extraInstructions, signal })`
- 校验：`text` 去空白后 ≥ 20 字，≤ 60000 字（超出截断并在 `meta.truncated=true`）。
- 调用：`ctx.llm.stream({ provider, model, system, messages: [{ role:'user', content:[{type:'text',text:<拼装内容>}] }], maxTokens, signal })`。
  以 `text-delta` 累积正文，`finish` 终止；失败/超时（默认 90s）→ 抛 `AI_CALL_FAILED`。
- 解析：从正文里取第一个 `{` 到最后一个 `}`，`JSON.parse`；失败时尝试去 ```json 围栏；
  仍失败 → 抛 `AI_BAD_OUTPUT` 并带正文前 500 字方便排查。
- 归一化（必须做，模型输出不可信）：
  - `title` 必填非空（否则取 PRD 首个标题/首行）；
  - `businessLineName` 非空，否则 `null`（客户端要求用户选/填）；
  - `nodes` 1..20 条，每条 `title` 非空、`detail` 截 200 字、`assigneeRole ∈ 设计|研发|设计/产品`、
    `approvalRoles ⊆ [design, product]`（只有 `设计/产品` 节点才允许）；
  - `templateId ∈ delivery|acceptance|custom`（默认 `custom`）；
  - `dueAt` 必须是可解析 ISO 或 null；
  - 输出去重（同日同名节点）。
- LLM 失败/不可用 → `fallbackParse()`（规则）：
  - 标题：`# ` 一级标题或第一行非空；
  - 节点：markdown 表格中「节点/阶段」首列的行（最多 20），否则默认 `delivery` 模板 7 节点；
  - `meta.source = 'heuristic'`，`meta.warnings` 说明「未使用模型，仅按结构提取」。

`meta` 形如：
```json
{ "source": "llm"|"heuristic", "provider": "deepseek-account", "model": "deepseek-flash",
  "ms": 3120, "truncated": false, "warnings": [], "usage": { "inputTokens": 0, "outputTokens": 0 } }
```

### 1.3 proposal 形状（客户端可编辑，apply 时重新校验）

```jsonc
{
  "title": "活动管理改版",
  "businessLineName": "增长推广" | null,
  "dueAt": "2026-11-20T10:00:00.000Z" | null,
  "templateId": "delivery" | "acceptance" | "custom",
  "summary": "一句话说明这条 PRD 要做什么",
  "nodes": [
    { "title": "需求接收", "detail": "记录需求名称与来源", "assigneeRole": "设计", "approvalRoles": [] },
    { "title": "交互确认（设计 & 产品）", "detail": "…", "assigneeRole": "设计/产品", "approvalRoles": ["design","product"] }
  ],
  "notes": "解析依据 / 风险提示（可空）"
}
```

### 1.4 `applyProposal({ proposal, businessLineId })`
- 校验 proposal（同 1.2 归一化，节点 ≥1）。
- 调用新 engine action `createProjectFromNodes`（见 §2），返回新项目。
- 若 `businessLineId` 为空但有 `businessLineName`：按名字找已有业务线，没有则创建。

---

## 2. 新 engine action：`createProjectFromNodes`

```jsonc
{ "action": "createProjectFromNodes", "payload": {
    "businessLineId": "bl_1",              // 或 businessLineName
    "title": "活动管理改版",
    "dueAt": "ISO" | null,
    "flowName": "PRD 流程",                 // 可选
    "nodes": [{ "title", "detail", "assigneeRole", "approvalRoles" }]
} }
```
行为：创建 project（status active）+ 1 个 flow（`templateId: 'custom'`，`templateVersion: 1`）+
按顺序建节点（第一个 `ready`，其余 `locked`）；依赖 `sequence` 链；带 `approvalRoles` 的节点
额外加一条 `return` 指向前一节点（模拟 D04→D03 的返工语义）；写 `projectCreated` + 每个节点
`nodeAdded` 事件。返回 `{ projectId, flowId, lineId, nodes: n, createdLine: bool }`。
**不允许**借它绕过模板校验去改已有项目。

---

## 3. HTTP 路由（追加到 `API_PATHS`）

| 方法 | 路径 | 请求 | 响应 |
|---|---|---|---|
| GET | `/flowpilot/api/ai/status` | — | `{ ok, available, provider, model, reason, modelSource }` |
| POST | `/flowpilot/api/ai/parse` | `{ text, businessLineHint?, extraInstructions? }` | `{ ok, proposal, meta }` |
| POST | `/flowpilot/api/ai/apply` | `{ proposal, businessLineId? }` | `{ ok, projectId, lineId, flowId, nodeCount, revision, state, derived, result }` |

错误码：`AI_NO_MODEL` / `AI_CALL_FAILED` / `AI_BAD_OUTPUT` / `INVALID_INPUT` / `INTERNAL`，
沿用 `STATUS_BY_CODE` 映射（AI_* → 502/422 合理即可）。

---

## 4. agent 工具（`flowpilot` 追加 action）

- `parsePrd`：参数 `text`（必填）、`businessLineHint` → 返回 proposal + meta；
- `createProjectFromPrd`：参数 `text`（必填）、`businessLineId?`、`businessLineName?`
  → 内部 parse + apply，返回 `{ projectId, nodeCount, title, lineName }`。
只读语义：两者都不算只读（第二个写库），在工具描述里写清。

---

## 5. 客户端：`src/client/45-ai.js`

导出（函数声明）：
```js
function AiPrdDialog({ open, onClose, state, derived, onApplied })   // 全流程弹窗
const CSS_AI = String.raw`...`
```
（shell 负责按钮与开合；对话框不读写全局，`onApplied(projectId)` 回调后由 shell 选中项目。）

对话框三态：
1. **输入**：PRD 文本域（≥20 字才能解析）、可选业务线名、可选补充要求、
   文件选择/拖拽（`.md/.txt`，FileReader 读入文本，纯前端，不上传）；
   顶部显示 AI 可用性（GET `/flowpilot/api/ai/status`）：不可用时提示原因，仍允许「规则解析」。
2. **解析中**：阶段提示（读取 PRD → 请求模型 → 校验结构），可取消（AbortController）。
3. **提案**：项目标题、业务线（下拉可选已有 / 输入新名）、截止日期、模板徽标、
   summary/notes/warnings、节点列表（可编辑标题/说明/角色、上下移、删除、末尾新增）；
   底部：重新解析（可带补充要求）、取消、`生成项目`（POST apply）。
   成功后 `FpToast` + `onApplied(projectId)`。
失败：就地中文错误 + 保留输入（可重试）。

样式规则同主契约：只用 `--dsw-*` 令牌 + 自有 `--fp-*`，类名 `fp-ai-` 前缀，明暗主题可读，
弹窗内滚动区 `overflow:auto`，窄屏单列。

---

## 6. 验收

- `node lib/selftest.mjs`：新增用例覆盖 proposal 归一化/坏 JSON/截断/兜底、
  `createProjectFromNodes` 建线与节点、`applyProposal` 走业务线复用与新建。
- `node tests/client-smoke.mjs`：`AiPrdDialog` 以 `open:true` 渲染三态（输入态必测，
  提案态用 fixture proposal 测）无异常。
- 实机：`curl /flowpilot/api/ai/status` 显示模型可用；`POST /ai/parse` 用真实 PRD 文本
  返回合法 proposal；`POST /ai/apply` 生成项目后 `overview` 能看到新项目与节点。
