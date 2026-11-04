## 本地开发版（beta）：不检查更新

安装形态为 **本地源码直连**（`~/.dsh/profiles/<profile>/node_modules/dsh-flowpilot` 是指向仓库工作树的软链，
或插件目录里带 `.git`，或设置 `FLOWPILOT_CHANNEL=dev`）时，更新服务会把它识别为**本地开发版**：

- `/update/status` 返回 `devBuild: true`、`channel: "dev"`、`updateAvailable: false`、`updateSuppressed: true`；
- `/update/check` **不联网**（不调 git、不读远端 tag），直接返回状态；
- 顶栏**不显示**「可更新」徽标；设置 › 版本与更新 里显示「本地开发版」并隐藏「检查更新 / 更新」按钮；
- 更新方式：改动代码后**重启 DSH** 即生效（或 `git pull` 后重启）；`apply` 仍会返回 `UPDATE_DEV_MODE`。

# FlowPilot · 版本检查与一键更新契约

给 FlowPilot 插件加「发现新版本 → 提醒 → 一键更新 → 重启生效」的闭环。
更新对象是**插件自身**（`dsh-flowpilot` 这个 npm/git 包），不是 `data.json` 里的项目数据。

## 0. 设计原则

1. **只信远端 tag**：只认 `git ls-remote --tags --refs` 返回的 `vX.Y.Z` 语义化版本 tag；
   `main` 上的普通 commit 不触发更新提示（发布以 tag 为准，避免半成品）。
2. **安装形态决定能力**：profile 里以 git 依赖安装（`<profile>/node_modules/dsh-flowpilot`）→ 可一键更新；
   `link:` 指向开发目录 → 识别为开发模式（`mode:'link'`），只检查不重装，避免开发时被远端覆盖。
3. **检查不扰民**：启动后 5s 静默检查一次，之后每 6h 一次；结果缓存 30 分钟；失败只记状态，不弹错、不阻塞。
4. **更新要显式**：只有用户点「更新」才执行重装；更新完成后标记 `restartRequired`，
   由用户点「重启 DSH」或手动重启，宿主半新代码才会加载。
5. **不动数据**：重装只替换插件代码，不碰 `~/.dsh/flowpilot/data.json`；不上传任何本地数据。
6. **无 npm 依赖**：宿主半只用 `node:` 内置模块 + 子进程调用系统 `git` 与 DSH 自带 `pnpm`。

## 1. 安装形态识别

`lib/update.js` 从插件自身模块路径推断：

| 插件根目录 | 形态 | 能力 |
|---|---|---|
| `<profile>/node_modules/dsh-flowpilot`（且 profile package.json 有 `dsh` 字段） | `mode:'profile'` | 检查 + 一键更新 + 重启 |
| 其它路径（`link:` 开发目录） | `mode:'link'` | 仅检查，`apply()` 抛 `UPDATE_DEV_MODE` |

## 2. HTTP 路由

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/flowpilot/api/update/status` | 返回缓存的更新状态（不触发检查） |
| POST | `/flowpilot/api/update/check` | 强制检查远端 tag（刷新缓存），返回最新状态 |
| POST | `/flowpilot/api/update/apply` | 重新安装「最新 tag」并标记待重启（仅 profile 形态） |
| POST | `/flowpilot/api/update/restart` | 退出并重新打开 DSH NEXT（detached shell，2s 后 open） |

### 2.1 status 数据形状

```jsonc
{
  "ok": true,
  "status": {
    "currentVersion": "1.1.0",       // 当前已加载插件版本（package.json）
    "buildLabel": "1.1.0-dev+abc1234.dirty", // 构建身份：版本±通道+提交号[.dirty]（缺 build-info.json 时回退版本号）
    "build": {                       // 构建元数据（build-client.mjs 生成 build-info.json）
      "version": "1.1.0", "label": "1.1.0-dev+abc1234.dirty",
      "channel": "dev",              // dev | beta | release（FLOWPILOT_CHANNEL 可覆盖）
      "sha": "abc1234", "dirty": true, "builtAt": "ISO"
    },
    "devBuild": true,                // link 安装 / 带 .git / build.dirty=true / channel=dev
    "channel": "dev",                // 运行通道：dev | release
    "updateSuppressed": true,        // 开发版抑制更新提示
    "updateSuppressedReason": "dev-build",
    "latestVersion": "1.2.0",        // 最近一次检查到的最新 tag（未检查为 null）
    "updateAvailable": true,         // latest > current 且尚未安装
    "checkedAt": "ISO",              // 最近检查时间
    "repo": "https://github.com/Hazen223/dsh-flowpilot-public",
    "mode": "profile",               // profile | link
    "profileDir": "~/.dsh/profiles/desktop",  // link 时为 null
    "canApply": true,                // mode=profile 且找到 DSH 自带 pnpm
    "busy": null,                    // null | 'check' | 'apply'
    "appliedVersion": null,          // 本次进程内已安装的版本
    "restartRequired": false,        // 装完待重启
    "lastApplyLog": "",              // 最近一次 pnpm 输出尾部（诊断用）
    "error": null                    // 或 {code, message, at}
  }
}
```

`error` 只保留最近一次检查错误；`status()` 永远返回 200 形状（除服务未注入 → 503）。

### 2.2 错误码 → HTTP

| 错误码 | HTTP | 触发场景 |
|---|---|---|
| `UPDATE_CHECK_FAILED` | 502 | `git ls-remote` 失败（凭据/网络/仓库不可达） |
| `UPDATE_NO_TAGS` | 502 | 远端没有 `vX.Y.Z` tag |
| `UPDATE_BUSY` | 409 | 已有 check/apply 在跑 |
| `UPDATE_NOT_AVAILABLE` | 409 | 无新版本，或已经安装过、待重启 |
| `UPDATE_DEV_MODE` | 409 | `link:` 开发模式下请求 apply |
| `UPDATE_PNPM_MISSING` | 500 | 找不到 DSH 自带 pnpm（`app.asar.unpacked/node_modules/pnpm/bin`） |
| `UPDATE_APPLY_FAILED` | 500 | pnpm 安装失败（透出 stdout 尾部） |
| `UPDATE_UNSUPPORTED` | 500 | 非 macOS 桌面端请求重启 |

## 2.5 发布与通道（release 产物）

```bash
npm run release:check      # 本地门禁：build + selftest + smoke + UI audit
git tag v1.6.0 && git push origin v1.6.0   # CI：.github/workflows/release.yml → GitHub Release + changelog
```

- CI（`.github/workflows/ci.yml`）：push/PR 跑 build、语法检查、selftest、client smoke、UI 审计，并校验**提交进仓库的 `client.js` 与源码一致**；
- Release（`.github/workflows/release.yml`）：打 `v*` tag 触发，跑同一套门禁后创建 Release，附 `client.js` 与 `build-info.json`（安装来源仍是 git tag）；
- 通道：`FLOWPILOT_CHANNEL=release|beta|dev` 可强制构建通道；本地有未提交改动默认 `dev`（`label` 带 `.dirty`）；
- 开发机：`npm run dev:link` 把 profile 指向本仓库源码；`npm run dev:check` 检查是否仍直连（被 `pnpm install` 冲掉时退出码 1）。

## 3. 更新流程

```
用户点「更新」→ POST /apply
  → git ls-remote 已缓存到的 latestTag（vX.Y.Z）
  → <DSH 自带 pnpm> add "<repo>#vX.Y.Z"（cwd = profile 目录，ELECTRON_RUN_AS_NODE=1 调 Electron）
  → 成功：appliedVersion=latest，restartRequired=true
用户点「重启 DSH」→ POST /restart
  → detached: sleep 1; osascript quit / pkill; sleep 2; open -a "<DSH NEXT.app>"
  → 新进程加载新宿主代码；浏览器刷新后加载新 client.js
```

更新走本机 git 凭据（HTTPS）：机器上需要已配置 `~/.git-credentials` 或 `gh auth setup-git`；
公共仓库不配置凭据时检查会报 `UPDATE_CHECK_FAILED`，不影响插件其它功能。

**凭据健壮性**：macOS 上 Xcode 的 system gitconfig 会注册 `credential.helper=osxkeychain`，
无 GUI 会话时会卡住等待钥匙串弹窗（iMac 实测）。因此更新器在检测到 `~/.git-credentials` 时，
给 git 追加 `-c credential.helper= -c credential.helper=store`（强制文件凭据），
并设置 `GIT_TERMINAL_PROMPT=0` 等环境变量，任何交互式提问都直接失败而不是挂起。

**pnpm 内部 git**：`pnpm add <repo>#<tag>` 会自己 spawn `git` 解析依赖，不继承上面的 `-c` 覆盖。
如果本机 `gh auth setup-git` 写过 `credential.https://github.com.helper` 且排在 generic `store` 之前，
可能拿到过期令牌 → 403，更新失败（v1.5.0 及以前 MacBook 实测复现）。v1.5.1 起给 pnpm 子进程注入
`GIT_CONFIG_COUNT/GIT_CONFIG_KEY_*/GIT_CONFIG_VALUE_*`（等效 `credential.helper=store`）、
`GIT_TERMINAL_PROMPT=0`、`GIT_ASKPASS=/usr/bin/true`，强制其内部 git 也只用 `~/.git-credentials`；
更新失败的错误信息额外附带 pnpm stderr 尾部，便于定位。

## 4. 界面

- **设置 → 版本与更新**（`FpUpdatePanel`）：当前/最新版本、检查时间、仓库地址、
  状态徽标（读取中/已是最新/发现新版本/检查失败/待重启）、按钮「检查更新」「更新到 vX」「重启 DSH」。
- **主面板顶栏徽标**（`FpUpdateBadge`）：有新版或待重启时出现，点击跳到设置页；无更新时永不出现。
- 开发模式（`mode:'link'`）下「更新」按钮禁用，提示改用 `git pull`。

## 5. 验证

```bash
node lib/selftest.mjs          # 含 update 服务与路由 8 个用例（版本比较/缓存/错误码/apply/restart）
node build-client.mjs && node tests/client-smoke.mjs
node tools/audit-ui.mjs --strict
```

实机验证（本机 profile 为 git 安装时）：

```bash
curl -s http://127.0.0.1:<port>/flowpilot/api/update/status
# → {"ok":true,"status":{...,"mode":"profile","updateAvailable":false}}
```
