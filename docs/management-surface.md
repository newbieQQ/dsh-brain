# 统一管理卡接口与契约（0.5.0）

本文件记录 0.5.0 交付的「连接与上报 / 技能管理 / MCP 管理」三页签所依赖的真实接口、约束与验证结果。凡是未实现的能力都在这里写明，不在界面上假装可用。

## 1. 路由

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/cloud-memory` | 自带配置页（旧入口，保留） |
| GET | `/cloud-memory/status` | 设置 + 令牌掩码 + 上报计数 + `lastCheck` + `capabilities` |
| GET | `/cloud-memory/capabilities` | 能力清单与缺口说明 |
| PUT | `/cloud-memory/config` | 写配置；换 origin 时返回 `credentialsCleared` |
| POST | `/cloud-memory/login` | 账号一次性换取令牌 |
| POST | `/cloud-memory/test` | 只读分项检查：`network` / `activity` / `memory` / `summary` |
| POST | `/cloud-memory/flush` | 重试上报队列 |
| GET | `/cloud-memory/skills/api` | 技能清单 + `plans`（未完成安装计划） |
| POST | `/cloud-memory/skills/detail` | `{folder}` → SKILL.md、文件清单、哈希 |
| POST | `/cloud-memory/skills/toggle` | `{folder, enabled}` → 目录移动 + 生效范围说明 |
| POST | `/cloud-memory/skills/install/plan` | `{url}` → 暂存克隆 + 候选描述 |
| POST | `/cloud-memory/skills/install/commit` | `{planId, folders}` → 只装选中项 |
| POST | `/cloud-memory/skills/install/cancel` | `{planId}` → 丢弃暂存 |
| POST | `/cloud-memory/skills/install` | 旧页面用的一次性安装（等于 plan + 全部非冲突项） |
| POST | `/cloud-memory/skills/uninstall/plan` | `{folder}` → 影响预览 + 一次性 token |
| POST | `/cloud-memory/skills/remove` | `{folder, token, confirmed:true}` → 真实删除 |

## 2. 契约要点

### 2.1 服务地址与凭据

- `settings.baseUrlConfigured=false` 表示地址仍是打包占位符，界面必须显示「未配置服务」。
- 写入配置时若 `new origin != old origin`：本次请求没有显式提供新值的令牌全部删除，响应带 `credentialsCleared: ['activity','memory','summary']`。旧服务的 bearer token 绝不会被发往新 origin。
- 令牌只以掩码形式出现在 `status`；清除是独立动作（`clear*Token`）。

### 2.2 检查状态

`POST /test` 返回 `checks[]`，每项 `{id,label,state,message}`，`state ∈ ok | unconfigured | invalid | forbidden | unreachable | error`。鉴权通过与「已写入一条上报」分开显示；`:reach()` 只证明服务可达。

### 2.3 技能安装

1. `plan`：只接受 `https://` / `file://`；`git clone --depth 1` 到 `$DSH_HOME/.cloud-memory-staging/<planId>`；候选深度 ≤ 3、≤ 60 个；描述含 `files`、`bytes`、`scripts`、`conflict`、`problem`。
2. 计划记录只保存 `planId / url / createdAt / expiresAt / stagingDir / candidates` 元数据，TTL 30 分钟；过期计划连暂存目录一起清理。
3. `commit`：只安装 `folders` 里且计划中存在的候选；`conflict`/`problem` 一律跳过；`.git` 与符号链接在 `cp` filter 中被剔除；源与目标都校验在各自根目录内（`path_escape`）。
4. 不执行仓库里的任何脚本、钩子或依赖命令；需要执行时由用户另行决定。

### 2.4 技能卸载

`uninstall/plan` 返回真实目录、文件数、字节数、含脚本列表、`recoverable:false` 与提示，并签发绑定该目录的一次性 token（10 分钟）；`remove` 必须同时满足 `confirmed:true` + 该 folder 的 token，token 用后即废，换目录无效。没有回收站，删除即不可恢复，界面必须原样说明。

### 2.5 启停

启停仍是把目录移进/移出 `$DSH_HOME/skills-disabled/`，属于**新会话生效**；已加载会话不受影响。接口在响应里带这条说明，界面不得宣称立即生效。

### 2.6 MCP 桥接

MCP 页签不新建凭据库，读取宿主 `dsh-mcp-connector`（0.2.88）同源公开接口：

```
POST /mcp-connector/api   { "method": "status" | "healthCheck" | "toolsList" | "setEnabled" | "reconnect" | "disconnect" | ..., "params": {...} }
```

- 探测失败（404/超时/非 200）→ 界面显示能力缺口，并指向「设置 → 插件配置 → MCP 服务器配置」这一权威入口。
- 只展示 `name / transport / authMode / enabled / connectionState / injectionLabel / scope / healthCheckedAt / lastError`；不回显 stdio 启动命令、env、token 或敏感 header。
- 工具缓存与连接状态分开显示：工具可见 ≠ 业务可调用。
- 市场条目与远端文本视为不可信内容，不内嵌执行。

## 3. 已执行验证（Windows，本机 Node v24.21.0）

- `verify-brain-panel.mjs`：53 项全过（status/capabilities、config 换 origin 清凭据、方法/Origin/Content-Type 闸门、技能清单与详情、安装计划与选择、冲突跳过、计划过期、暂存清理、卸载预览与一次性 token、路径穿越拒绝）。
- `verify-skill-admin.mjs`：15 项全过（含与同步引擎的联动：已停用技能不被云端更新重新启用）。
- `tsc -p tsconfig.build.json` 与 `tsc -p tsconfig.json --noEmit`：无错误。

## 4. 明确未完成

- 技能市场：无经验证来源，`features.skillsMarketplace=false`。
- 云端同步冲突的交互式处理（保留本地/采用云端/手动合并）：仍由现有引擎按原策略暂停冲突项，界面只读展示。
- 自动更新与版本回退：未实现（无来源清单与制品基线）。
- MCP 市场的内嵌浏览与安装：未实现，只给宿主面板位置。
- 跨软件（Codex / Claude Code / OpenCode）适配与工作区级作用域：未实现，仍在方案 P0/P4 调研项。
- 浏览器端实机验收（375/574/1280 宽、深色模式、真实上报）：需要重启 DSH 后由用户在界面确认。

## 5. 技能来源树（0.5.0 增补）

「技能管理」页签按软件来源组织，来源→分类→技能三层，与工作方式一致：DSH 来源是真的，其他软件目录只读。

### 5.1 来源检测

| id | 标签 | 目录 | 本卡权限 |
|---|---|---|---|
| `dsh` | DSH | `$DSH_HOME/skills`（停用区 `$DSH_HOME/skills-disabled`） | 真实启停 |
| `agents` | 公共 Agent | `~/.agents/skills` | 只读 |
| `codex` | Codex | `~/.codex/skills` | 只读 |
| `workbuddy` | WorkBuddy | `~/.workbuddy/skills` | 只读 |
| `claude` | Claude Code | `~/.claude/skills` | 只读 |
| `opencode` | OpenCode | `~/.config/opencode/skills` | 只读 |

目录不存在也照实显示 0 个（标注「目录还不存在」），不猜、不造。检测每次刷新时重算。

### 5.2 分类是纯元数据

`$DSH_HOME/cloud-memory-skill-groups.json` 只存 `{sourceId: {enabled, groups: [{id,name,enabled,skills:[folder]}]}}`。

- 新建 / 改名 / 删除分类都不移动任何文件；删除分类只是把成员释放回「未分类」，接口返回 `released` 数量。
- 一个技能最多属于一个分类：加入新分类会先从旧分类移除。
- 未分类是合成分组（`id: 'unassigned'`），它的开关对该来源里所有未被分类的技能逐个生效。

### 5.3 开关的真实边界

| 位置 | DSH 来源 | 其他来源 |
|---|---|---|
| 来源开关 | 真实：全部技能移入/移出 `skills-disabled` | `cardOnly: true`，只记在本卡，不动它们的目录 |
| 分类开关 | 真实：该分类成员逐个启停，返回 `applied` / `failed` | `cardOnly: true` |
| 技能开关 | 真实（目录移动） | 不提供（行内标「只读」） |

任何真实启停都是目录移动，属于**新会话生效**；已在运行的会话保留旧状态。失败项逐条返回，不整批回滚成谎报成功。

### 5.4 接口

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/cloud-memory/skills/sources` | 整棵树 + `note`（分类不移动文件、只有 DSH 真实启停） |
| POST | `/cloud-memory/skills/groups/create` | `{sourceId, name}` |
| POST | `/cloud-memory/skills/groups/rename` | `{sourceId, groupId, name}` |
| POST | `/cloud-memory/skills/groups/delete` | `{sourceId, groupId}` → `{released}` |
| POST | `/cloud-memory/skills/groups/assign` | `{sourceId, groupId, folders[]}`；`groupId:'unassigned'` 或空数组=移出分类 |
| POST | `/cloud-memory/skills/groups/toggle` | `{sourceId, groupId, enabled}` → `{cardOnly, applied[], failed[]}` |
| POST | `/cloud-memory/skills/source/toggle` | `{sourceId, enabled}` → `{cardOnly, applied, failed[]}` |
| POST | `/cloud-memory/skills/source/reveal` | `{sourceId}` → 在系统文件管理器打开该来源根目录（仅已登记的源） |

错误码：`unknown_source` / `not_found` → 404，`invalid_name` / `duplicate` / `too_many` → 400。

### 5.5 验证

`verify-skill-tree.mjs`：40 项通过——来源与计数、分类增删改、成员唯一性、DSH 真实 park/unpark、「未分类」开关只作用于未分类技能、外来源 `cardOnly` 且目录字节不变、持久化重开、路由闸门与错误码。

## 6. P3：技能市场 / 同步冲突 / 更新回退（0.6.0）

### 6.1 市场来源

首个经验证来源是 Anthropic 公开的 Claude 技能市场清单
`https://raw.githubusercontent.com/anthropics/skills/main/.claude-plugin/marketplace.json`。
客户端只传 `provider` 与条目 `id`，**从不传仓库地址**，因此宿主不会去拉取任意 URL。

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/cloud-memory/market/providers` | 已配置来源（id/标签/仓库） |
| GET | `/cloud-memory/market/search` | `?provider=&q=&cursor=` → 条目分页 |
| POST | `/cloud-memory/market/detail` | `{provider,id}` → 逐技能 SKILL.md 元数据 |
| POST | `/cloud-memory/market/plan` | `{provider,id}` → 解析提交 + 克隆暂存计划（只列该条目技能） |
| POST | `/cloud-memory/market/commit` | `{planId,folders}` → 只装勾选项 |
| POST | `/cloud-memory/market/cancel` | `{planId}` → 丢弃暂存 |

`resolveArtifact` 通过 GitHub API 解析固定提交；克隆后以 `git rev-parse HEAD` 记录**实际**提交，安装失败不会留下半装目录。

### 6.2 来源记录与更新/回退

安装（Git 或市场）会在技能目录写入 `.skill-source.json`：`provider / repoUrl / ref / commit / sourcePath / entryId / installedAt`，不含任何凭据。

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/cloud-memory/skills/update/check` | `{folder}` → 与来源最新提交比较，返回 added/removed/changed |
| POST | `/cloud-memory/skills/update/apply` | `{folder,expectedCommit}` → 更新前整目录备份，再切换并重写记录 |
| POST | `/cloud-memory/skills/rollback` | `{folder}` → 恢复最近一次更新前备份 |

安全点：只信任来源记录里的仓库地址；新克隆在 `$DSH_HOME/.cloud-memory-staging`，复制时剔除 `.git` 与符号链接；`expectedCommit` 过期返回 `stale_plan`，绝不覆盖；同步进行中拒绝写。

### 6.3 同步冲突交互

`SkillSync` 仍然只按原策略暂停冲突项，但会暴露两侧信息并允许人工处置：

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/cloud-memory/sync/status` | 最近统计 + 每个冲突的本地/云端两侧 |
| POST | `/cloud-memory/sync/run` | 立即执行一次同步 |
| POST | `/cloud-memory/sync/resolve` | `{name,action}`：`keep_local` / `take_cloud` / `manual` |

- `keep_local`：用本地文件按当前云端 revision 上传为新版本；revision 过期返回 `stale_revision`。
- `take_cloud`：先把本地目录备份到 `$DSH_HOME/.cloud-memory-backups/sync/<name>/<时间>`，再写入云端 bundle。
- `manual`：只返回两侧信息，不改任何文件。

### 6.4 验证

- `verify-market.mjs`：19 项通过（清单解析、search/detail、未知来源 400、plan 固定提交、只装勾选项、来源记录）。
- `verify-skill-update.mjs`：15 项通过（真实 git 仓库的 check/apply/rollback、无来源拒绝、过期提交拒绝、备份存在）。
- `verify-sync-resolve.mjs`：12 项通过（一次真实 pass 产生 4 个冲突、take_cloud 备份并覆盖、keep_local 上传、manual 只读、stale 拒绝）。

## 7. P4：MCP 管理与市场（0.6.0）

MCP 页签不新建凭据库，全部读写都走宿主 **dsh-mcp-connector 0.2.88** 的同源公开接口
`POST /mcp-connector/api`。该接口是**方法白名单**（不是任意反射调用），已实测可用方法包括：

`versionStatus, governance, previewPolicy, applyPolicy, rollbackPolicy, scopeContext,
previewConnectionScope, applyConnectionScope, previewConnectionScopeRollback, rollbackConnectionScope,
connectionStatistics, catalog, status, healthCheck, connect, configure, importJson, exportConfig,
listSnapshots, createSnapshot, previewSnapshot, restoreSnapshot, installFromUrl, renameConnection,
editableConnectionConfig, reconfigureConnection, disconnect, setEnabled, reconnect, setInjectionMode,
refreshCatalog, toolsList, toolSearch, toolExplorer, toolDetail`

### 7.1 本卡实现

| 区块 | 能力 |
|---|---|
| 我的连接 | 读取连接（名称/传输/鉴权/启用/状态/注入方式/范围/健康时间/最近错误）、健康检查、工具缓存、启停、重连、两段式移除 |
| MCP 市场 | `catalog` 目录浏览与搜索；无认证直接 `connect`；OAuth 走浏览器授权 `connect`；bearer / api-key 通过 `configure` 填凭据（只写宿主，不回显） |
| 新增 / 导入 | 自定义 Streamable HTTP 与 stdio 连接（显示实际启动命令，云端不执行）、`importJson` 批量导入 |
| 配置编辑 | `editableConnectionConfig` 读取（敏感值以 `<KEEP_EXISTING>` 保留标记返回），`reconfigureConnection` 保存；空输入不清除已有密钥 |
| 范围 | `previewConnectionScope` → `applyConnectionScope`，带 `expectedRevision`，`mode=move`，凭据不复制 |
| 治理 | `governance` 读取 revision/规则/优先级；connection 级 `previewPolicy` → `applyPolicy`（allow / deny / inherit），同样带 `expectedRevision` |

### 7.2 明确的边界

- 本卡不保存、不回显 MCP 凭据与 stdio 环境变量；一切都写宿主。
- 目录条目、工具描述、示例与远端文本一律视为**不可信内容**，只展示、不执行。
- Host 不支持 `tools.guard` 时，`deny` 策略会被宿主拒绝并如实显示，不会假装已生效。
- 自定义 MCP Server 的权威位置仍是「设置 → 插件配置 → MCP 服务器配置」；本卡通过同一公开接口管理，不手改托管配置区块。
- 工具可见性 ≠ 会话级可调用：本卡展示连接与工具缓存，**按会话选择精确工具后激活**由宿主 `session-tools`/agent 工具负责（其不在 `/mcp-connector/api` 白名单内），本卡不伪造激活。

### 7.3 验证

- `verify-mcp-bridge.mjs`（连运行中的 DSH）实测 **8/8** 通过：versionStatus、catalog（116 个已上架连接器）、governance、scopeContext、status、connectionStatistics、listSnapshots 全部 `ok:true`。
- `verify-card-render.mjs` 覆盖 MCP 页签在无桥接时的能力缺口文案，以及存在桥接时的分区渲染。

## 8. P5：集成发布（0.6.0）

### 8.1 暗色 / 窄屏

- 卡片全部使用主题相对色（`rgba(127,127,127,…)` 中性色 + `rgba(37,99,235,…)` 蓝色强调），不硬编码浅色专用颜色；切换开关的白色圆点用 `rgba(255,255,255,0.96)`。
- 长行、页签与操作区声明 `flexWrap: 'wrap'`，窄设置面板不会出现横向滚动；不固定 375px 专用宽度。
- `verify-theme.mjs`：6 项通过（无纯白/纯黑硬编码、中性/强调 token 使用次数、换行行数、页签换行、无固定窄宽）。

### 8.2 并发保护

所有会改文件的入口在同步进行中一律拒绝，绝不半写：

| 入口 | 行为 |
|---|---|
| `skills/install/plan` `install/commit` | `sync_running` |
| `skills/toggle` `skills/remove` | `sync_running` |
| `skills/update/apply` `skills/rollback` | `sync_running` |
| `sync/resolve` | `sync_running` |

HTTP 层统一映射为 **409 `sync_running`**。`verify-concurrency.mjs`：8 项通过（六个入口 + 路由 409 + 同步结束后放行）。

### 8.3 升级迁移（UPGRADE-01）

- 配置 sidecar 仍是 `version:1`；0.4.1 写入的 `baseUrl / clientId / requestTimeoutMs / defaultK / 三个 token / summary` 全部按原值读回，未知的未来字段被忽略而不是致命。
- **默认地址改为中性占位符** `https://your-memory-host/api/longmemory`：新装显示「未配置服务」，已配置用户由 sidecar 中的真实地址覆盖，不受影响。个人域名不再随包外发。
- 二次构造 `SettingsStore` 模拟重启，读到相同值；损坏文件降级为默认值，不阻断激活。
- `verify-upgrade.mjs`：11 项通过。

### 8.4 制品校验与回退

- `node scripts/pack-guard.mjs`：按 `files` 白名单展开真实入包文件，文件名黑名单（笔记/工程文件/`*.mjs`/`tsconfig*`/锁文件）与内容黑名单（个人域名、`C:\Users\…`、`cmt_…` 令牌原文）全部通过。
- 回退：代码层用 Git 提交与分支回退；本机配置由 sidecar 原子写（tmp + rename）保护；MCP 连接由宿主快照（`listSnapshots/restoreSnapshot`）保护；技能更新前自动备份到 `$DSH_HOME/.cloud-memory-backups`，可 `skills/rollback` 恢复。

## 9. v1.1：跨软件与工作区分层（0.7.0）

### 9.1 ClientAdapter 与清单

`src/clients.ts` 为六个软件实例提供统一的只读清单：`dsh / agents / codex / workbuddy / claude / opencode`。
每个适配器声明 `installed / configRoot / globalSkillsRoot / writable / workspaceSupported`；能力契约另给出
`readGlobal / writeGlobal / workspaceRead / workspaceWrite / hotReload / verify`。

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/cloud-memory/clients/overview` | 适配器、能力、每个软件的工作区、Brain 命名信息 |
| GET | `/cloud-memory/clients/inventory` | `?software=&scope=global|workspace&workspaceId=` |
| POST | `/cloud-memory/clients/workspaces/add` | `{software,path,name}` 登记工作区（只存元数据） |
| POST | `/cloud-memory/clients/workspaces/remove` | `{software,id}` |

### 9.2 工作区发现与有效配置

- DSH 工作区来自宿主自己的 `workspace-groups.folders.json`（成员路径）与 `workspace-groups.manual.json`（分类），**不执行全盘扫描、不读会话库**。
- 其他软件的工作区只来自用户显式登记；路径失效会如实报告，不静默删除登记。
- 工作区技能目录按该软件自己的约定探测：`<ws>/.dsh/skills`、`<ws>/.codex/skills`、`<ws>/.claude/skills`、`<ws>/.opencode/skills|skill`。找不到就是空，**绝不写通用目录冒充工作区配置**。

### 9.3 写入边界（能力与缺口）

- **DSH 用户级与 DSH 工作区级技能目录均可写**：工作区写使用工作区专属 `SkillAdmin`（根为 `<ws>/.dsh/skills`，停用区为 `$DSH_HOME/skills-workspace-disabled/<workspaceId>`，一个项目不会解停另一个项目的技能）。
- **其他软件一律只读**（`workspaceWrite=false`、item `writable=false`）；不支持的组合显式标注，绝不写通用目录冒充。
- 工作区写路由：`GET /cloud-memory/clients/workspace/inventory`、`POST .../workspace/{detail,toggle,remove,install/plan,install/commit}`；非 DSH 返回 501。

### 9.4 dsh-brain 数据迁移（RENAME-01 数据半区）

- `GET /dsh-brain/migrate/brain` 报告旧文件与目标文件状态、`packageRename: done`（0.8.0 起包改名已完成；旧 `/cloud-memory/*` 路由保留为别名）。
- `POST /dsh-brain/migrate/brain` 把 `cloud-memory.json / -skills.json / -skill-groups.json / -workspaces.json / .cloud-memory-plans.json` 复制为 `dsh-brain*` 对应名，**保留旧文件、不覆盖已存在目标、幂等**；各加载路径首次使用时也会自动做同样的复制迁移。
- 实际包名、客户端模块 id 与 profile 加载入口的切换已在 **0.8.0 统一版**完成（部署步骤，切换后需完全重启 DSH）。

### 9.5 验证

- `verify-clients.mjs`：19 项通过（六适配器、安装检测、只读边界、DSH 注册工作区+分类、工作区专属技能、手动登记/去重/未知工作区、路由、能力位、迁移幂等与原文件保留）。
- `verify-workspace-write.mjs`：14 项通过（DSH 工作区可写、只读判定、停用/启用/删除/安装的跨工作区与全局隔离、非 DSH 拒绝 501、路由）。
- `verify-full-load.mjs`：12 项通过——用真实 `apply()` 在宿主形状上下文加载 0.7.0，起真实 HTTP 服务后逐一查询 capabilities（0.7.0 + P3/P4/P5/v1.1 能力位）、market/providers、sync/status、clients/overview（6 适配器）、clients/inventory、migrate/brain、skills/api、status，全部返回正常。





