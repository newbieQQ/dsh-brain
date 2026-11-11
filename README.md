# dsh-brain

> **0.8.0 统一版（2026-11-11）**：本地开发线（0.7.0，含技能市场 / MCP 市场 /
> 多来源技能树 / 跨软件工作区清单 / 工作区级技能写）与云端线（0.5.1，完成
> dsh-brain 改名的部署半区）在此合流。插件现以 **dsh-brain** 发布：
> 包名、页面路由（`/dsh-brain/*`，旧 `/cloud-memory/*` 保留为别名）、
> 客户端模块 id、设置侧车（`dsh-brain.json` 等）全部切换；旧侧车在首次
> 加载时自动复制迁移、原文件保留；令牌环境变量 `DSH_BRAIN_*` 优先、
> 旧名继续有效。Mnemon provider 引用改为 `dsh-brain/mnemon-provider`。

把 DeepSeek Harness 接到 LongMemory 云端记忆服务：**每轮对话结束自动上报一条活动记录**（只上传元数据），并把云端记忆库变成 agent 可用的工具。

当前版本 **0.8.0**，含宿主端与浏览器端两部分：host 半负责活动上报与工具注册，`client/index.js` 提供「设置 → 插件 → 云端记忆」配置卡片。

## 它做什么

| 能力 | 说明 |
| --- | --- |
| 活动上报 | 监听 `session/event` 的 `turn/start`、`turn/end`，每个结束的回合调用一次 `POST /activity/turn`。上报字段只有 6 个：`client_id`、`conversation_id`、`turn_id`、`status`、`started_at`、`completed_at`。 |
| 幂等 | `turn_id` 为 `<sessionId>:<turn>`，服务端按 `turn_id` 去重，重试不会重复计数。 |
| 失败重试 | 网络错误与 5xx 进入待重试队列（上限 200 条），每 30 秒补发一次；4xx 不重试（说明载荷或令牌有问题）。 |
| 记忆工具 | `memory_search`、`memory_read`、`memory_add`、`memory_list`、`memory_projects` 五个工具直接读写云端记忆库。 |
| 配置页 | `GET /dsh-brain` 提供完整配置界面（本 profile 关闭了原生设置页，所以自带页面）。 |

**绝不上传**：提示词正文、工具输出、文件内容、本地路径、令牌。上报载荷在类型层面就只有六个字段，构造它的函数拿不到正文。

## 安装

```powershell
# 装进当前 profile（默认 desktop）
dsh plugin --profile desktop add dsh-brain
```

装好后确认 profile 的 `package.json` 里有两处：

```jsonc
{
  "dependencies": { "dsh-brain": "^0.8.0" },
  "dsh": { "profile": { "bundles": [ /* ..., */ "dsh-cloud-memory" ] } }
}
```

重启 DSH，在「设置 → 插件 → 云端记忆」里配置（备用入口：`http://127.0.0.1:<当次端口>/cloud-memory`）。

> `baseUrl` 默认是占位符 `https://your-memory-host/api/longmemory`。**首次使用必须先把它改成你自己的 LongMemory 服务地址**（配置页里填，或写进 `$DSH_HOME/cloud-memory.json`），否则上报与工具都会连接失败。

## 登录（推荐）

在设置卡里填云端面板的**普通用户**账号和密码，点「登录并获取令牌」：

```
密码 → POST /api/auth/login（一次性会话 cookie）
     → POST /api/auth/tokens ×2（activity:write、memory:write）
     → 只把两个 cmt_… 令牌写进 $DSH_HOME/cloud-memory.json
     → 密码与会话 cookie 立即丢弃
```

- 密码只在这一串请求里存在：不落盘、不写日志、不随 `/cloud-memory/status` 回显。
- 服务端只保存令牌哈希，令牌可单独撤销；改密码不影响已签发令牌。
- 服务地址不是 HTTPS（且不是 loopback）时插件拒绝发送密码。
- 管理员账号不能签发个人令牌（服务端 `403 management_only`），请用普通用户。
- 也可跳过登录，直接手填两个令牌（见下）。

## 配置

配置文件 `$DSH_HOME/cloud-memory.json`（默认 `%USERPROFILE%\.dsh\cloud-memory.json`），字段：

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 关闭后不上报、工具直接报错。 |
| `baseUrl` | `https://your-memory-host/api/longmemory` | 服务基址，自动去掉结尾斜杠。 |
| `clientId` | `dsh-desktop` | 上报时的 `client_id`。 |
| `requestTimeoutMs` | `8000` | 单次请求超时，1000–60000。 |
| `defaultK` | `10` | `memory_search` 未指定 `k` 时的条数。 |
| `activityToken` | — | `activity:write` 令牌，形如 `cmt_…`。 |
| `memoryToken` | — | `memory:read` / `memory:write` 令牌，形如 `cmt_…`。 |
| `skillsSyncEnabled` | `true` | 云端技能中心与本机技能目录的双向同步开关。 |
| `skillsDir` | 空 | 本机技能目录覆盖；为空时用 `$DSH_HOME/skills`。 |

两个令牌也可以用环境变量 `DSH_CLOUD_MEMORY_ACTIVITY_TOKEN`、`DSH_CLOUD_MEMORY_MEMORY_TOKEN` 覆盖。

> 一个 key 只有一种 scope，所以需要两个令牌：只做上报就只填活动令牌，只做检索就只填记忆令牌。

## Mnemon 集成（记忆空间 Provider）

自 0.2.0 起，本包同时是一个 Mnemon 记忆空间 Provider：Mnemon 管本地在场
（运行时记忆每轮注入），长期记忆的每一次读、写都实时穿透到 LongMemory——
云端是真源，本地不留长期副本。因此其他工具（Claude Code、Codex、看板）
刚写进 LongMemory 的记忆，DSH 里立刻能召回。

启用方式：在 Mnemon 的记忆空间来源配置里给 providers 列表加一行
（profile 覆盖或 bundle 配置均可），然后重启 DSH：

```yaml
providers:
  - use: dsh-cloud-memory/mnemon-provider
    instanceId: longmemory
```

之后在 Mnemon 的插件页会出现 LongMemory 的服务字段（Endpoint / Memory
token），留空即复用本插件已有的 `cloud-memory.json` 配置，一处配置两处生效。
每个记忆空间映射一个 LongMemory 项目：发现流程会自动列出账号下的全部
项目，外加一个不分项目的「全部」空间；也可以在空间上手动填 Project ID。

v1 范围：支持 发现 / 状态 / 搜索 / 浏览 / 写入 / 按 id 读取；暂不支持
删除（LongMemory 客户端接口没有删除操作）与图谱读取（接口未暴露，
返回空图谱且能力声明为关）。离线时长期记忆不可用，Mnemon 的本地
运行时记忆不受影响。

验证：`node verify-mnemon-provider.mjs`（对本地 stub 服务跑通
发现→写入→召回→项目隔离全流程）。

## 技能同步

自 0.3.0 起，插件在记忆之外还双向同步技能：云端技能中心是总汇，本机
技能目录（默认 `$DSH_HOME/skills`）是工作副本，本地的浏览、启停、分类
仍归 DSH 技能管理器。插件启动 5 秒后首跑，之后每 15 分钟对账一次；
结果与冲突列表见 `GET /cloud-memory/status` 的 `skills` 字段，聊天里
也可以用 `skill_list` 工具查看云端清单。

- **下行**：云端技能按平台自己的规矩落地——先验整包清单哈希、再逐
  文件验 sha256，原子写入，并留下 `.manifest.json` 交付记录；云端标
  记了「脚本已变更待确认」的包不会自动安装，先在看板里确认。
- **上行**：本地原创技能（管理器安装、导入或手写的）自动发布到云
  端；之后的修改以新修订发布，带 `expected_revision` 守卫，云端被
  别人先改过就报冲突、不强行覆盖。

防事故的规矩：云端交付的技能从不回传，本地改动它只报
`locally_modified` 冲突、原样不动；本地删除不删云端，且同版本不会
被重新拉回（云端出了新版才会再下来）；同名技能两边都有时互不抢占，
报 `name_collision`。云端只接受固定布局（根目录只有 `SKILL.md`，
其余文件进 `references/`、`scripts/`、`assets/`，扩展名有白名单，
单文件 ≤512 KiB、整包 ≤2 MiB、≤100 个文件），不符合的本地技能报
`unsupported_layout`，不会为了迁就而裁剪文件。

验证：`node verify-skills-sync.mjs`（对本地 stub 技能中心跑通
下行安装、上行发布与修订、改云端技能报冲突、同名冲突、脚本待审、
布局拒绝、删除不传播全流程）。

## 技能管理（内置）

自 0.4.0 起，常用的本地管理也长在插件里，页面在 `/cloud-memory/skills`
（配置页有链接进入）：

- **列表**：本机全部技能，标注来源（云端交付 / 本地已传云端 / 本地）
  与云端修订号；
- **启停**：停用是把技能文件夹挪到 `$DSH_HOME/skills-disabled/` 暂存
  ——DSH 看不见它，自然不会加载；启用再挪回来。不碰 DSH 内部机制，
  可靠且可逆。同步引擎认识暂存区：停用的云端技能不会被拉回技能目
  录，云端出了新版会在暂存区里原地更新；
- **删除**：真删，文件夹直接删除、不可恢复（页面上会先弹确认）。
  只删本地：云端副本不动，删掉的同版本也不会被同步重新拉回来；
- **从 git 安装**：粘贴 https:// 或 file:// 仓库地址，浅克隆后把仓
  库里所有带 `SKILL.md` 的文件夹装进技能目录；不执行仓库里的任何
  代码，同名技能跳过不覆盖。

范围就到 DSH 技能目录这一处：技能市场的发现中心、扫描其它工具
（Codex、Cursor 等）的技能目录不在内置范围——还需要那些的话继续
留着第三方管理器，两边不冲突；不需要的话现在可以卸掉它了。

验证：`node verify-skill-admin.mjs`（列表与来源判定、启停、真删、
git 安装与同名跳过、以及停用技能与同步引擎的配合共 15 项）。

## HTTP 接口

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| GET | `/cloud-memory` | 配置页面 |
| GET | `/cloud-memory/status` | 设置 + 上报计数 + 最近 50 条记录（令牌只返回掩码） |
| PUT | `/cloud-memory/config` | 应用设置补丁（令牌留空表示不修改） |
| POST | `/cloud-memory/login` | 账号密码登录，换取两个令牌并保存（密码不落盘） |
| POST | `/cloud-memory/test` | 分别校验两个令牌（活动令牌用空载荷探测，鉴权先于载荷校验，返回 400 即代表令牌有效，不会写入记录） |
| POST | `/cloud-memory/flush` | 立即补发待重试队列 |

写接口会校验同源 `Origin`，跨站请求返回 403。

## 状态语义

`TurnEndReason.kind` → 上报状态：

| kind | status | 说明 |
| --- | --- | --- |
| `completed` | `completed` | 正常结束；只有它计入热力图 |
| `aborted` / `interrupted` / `blocked` | `cancelled` | 用户中断或被阻止 |
| `error` / `max-tokens` | `failed` | 出错或超长截断 |
| `forked` | 不上报 | fork 不算用户跑完的一轮，计入会让热力图虚高 |

## 故障排查

- **热力图不涨**：看 `/cloud-memory/status` 的 `reporter.skipped` 与 `lastError`；常见原因是没配 `activityToken`、插件被 `enabled:false` 关掉，或令牌缺 `activity:write` scope。
- **工具报“未配置记忆令牌”**：填 `memoryToken`；写入还需要云端已配置 WebDAV 主存储（否则服务端 409 `storage_not_configured`）。
- **网络不可用**：上报会进队列，恢复后 30 秒内自动补发；也可以在配置页点“重试上报队列”。
- **令牌泄漏风险**：令牌只存在本机 JSON 文件里，页面只回显掩码（`cmt_act…0001`）。文件权限依赖用户目录 ACL（Windows 无 POSIX 位）。

## 开发与发布

```powershell
pnpm install                              # 首次
pnpm run build                            # tsc -p tsconfig.build.json → lib/
pnpm run typecheck

node scripts/release-prep.mjs --dry-run    # 先看会改什么
node scripts/release-prep.mjs              # 原地整备：脱敏 + 元数据 + LICENSE（幂等）
node scripts/pack-guard.mjs                # 白名单与脱敏闸门，不通过直接 exit 1
pnpm publish --access public --no-git-checks
```

`prepack` 会先重建 `lib/`，`prepublishOnly` 会先跑 `pack-guard`：包里一旦出现 `AGENTS.md`、`TODO.md`、`*.mjs` 探测脚本、`tsconfig*.json`、本机路径、个人域名或令牌原文，发布立刻中止。

> lifecycle 脚本要求 `node` 在 `PATH` 里。若报 `'node' is not recognized`，先把 DSH 运行时自带 node 的 `bin` 目录加进 `$env:Path` 再发布。

## 统一管理卡（0.7.0）

「设置 → 云端记忆」现在是三个页签：**连接与上报 / 技能管理 / MCP 管理**。

- 身份验证卡内切换「账号登录 / 手动令牌」，切换不清凭据、不发请求。
- 服务地址换 origin 时，旧令牌一律清除（`credentialsCleared`），要求重新认证。
- 技能安装是两步：`install/plan` 把仓库克隆到隔离暂存目录并列出候选（含冲突、脚本、体积），`install/commit` 只写入选中的目录；`.git` 与符号链接不复制，仓库脚本不执行。
- 卸载同样是两步：`uninstall/plan` 给出真实目录、文件数与不可恢复提示并签发一次性 token，`remove` 必须带 `confirmed: true` 与匹配 token。
- **技能市场（P3）**：接入经验证来源 `anthropics/skills` 的 `.claude-plugin/marketplace.json`；搜索→详情→`market/plan`（固定提交）→勾选安装。客户端只传 provider/id，从不传 URL。
- **更新/回退（P3）**：安装写 `.skill-source.json`；`skills/update/check|apply` 与 `skills/rollback` 更新前整目录备份，过期提交拒绝。
- **同步冲突（P3）**：`sync/status|run|resolve` 提供两侧信息，逐项「保留本地 / 采用云端 / 手动合并」。
- **MCP 管理（P4）**：读取宿主 `dsh-mcp-connector` 的同源公开接口 `/mcp-connector/api`；覆盖连接、健康检查、工具、启停、重连、两段式移除、目录市场连接、自定义 HTTP/stdio、JSON 导入、配置编辑、作用域与治理策略。

接口清单见 `docs/management-surface.md`；验收脚本见 `verify-*.mjs`（含 `verify-market` / `verify-skill-update` / `verify-sync-resolve` / `verify-mcp-bridge` / `verify-upgrade` / `verify-concurrency` / `verify-theme`）。

### 技能来源树

「技能管理」按软件来源分组（DSH / 公共 Agent / Codex / WorkBuddy / Claude Code / OpenCode），
每个来源下是分类，分类下是技能：

- 分类只记在 `$DSH_HOME/cloud-memory-skill-groups.json` 里，**不移动文件**；删除分类只是把技能放回「未分类」。
- 只有 DSH 来源的开关是真的（目录移入/移出 `skills-disabled`，新会话生效）；其他软件的目录本卡只读，开关标记为「仅本卡」。
- 来源行提供「＋ 新建分类」「打开目录」「来源开关」；分类行提供「＋ 加入技能 / 改名 / 删除 / 分类开关」；技能行提供详情、启停、卸载。
- 预览（真实数据、光照/暗色）：`node preview-card.mjs` 生成 `_preview/skill-tree*.png`。
