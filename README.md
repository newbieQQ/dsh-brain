# dsh-cloud-memory

把 DeepSeek Harness 接到 LongMemory 云端记忆服务：**每轮对话结束自动上报一条活动记录**（只上传元数据），并把云端记忆库变成 agent 可用的工具。

当前版本 **0.1.1**，含宿主端与浏览器端两部分：host 半负责活动上报与工具注册，`client/index.js` 提供「设置 → 插件 → 云端记忆」配置卡片。

## 它做什么

| 能力 | 说明 |
| --- | --- |
| 活动上报 | 监听 `session/event` 的 `turn/start`、`turn/end`，每个结束的回合调用一次 `POST /activity/turn`。上报字段只有 6 个：`client_id`、`conversation_id`、`turn_id`、`status`、`started_at`、`completed_at`。 |
| 幂等 | `turn_id` 为 `<sessionId>:<turn>`，服务端按 `turn_id` 去重，重试不会重复计数。 |
| 失败重试 | 网络错误与 5xx 进入待重试队列（上限 200 条），每 30 秒补发一次；4xx 不重试（说明载荷或令牌有问题）。 |
| 记忆工具 | `memory_search`、`memory_read`、`memory_add`、`memory_list`、`memory_projects` 五个工具直接读写云端记忆库。 |
| 配置页 | `GET /cloud-memory` 提供完整配置界面（本 profile 关闭了原生设置页，所以自带页面）。 |

**绝不上传**：提示词正文、工具输出、文件内容、本地路径、令牌。上报载荷在类型层面就只有六个字段，构造它的函数拿不到正文。

## 安装

```powershell
# 装进当前 profile（默认 desktop）
dsh plugin --profile desktop add dsh-cloud-memory
```

装好后确认 profile 的 `package.json` 里有两处：

```jsonc
{
  "dependencies": { "dsh-cloud-memory": "^0.1.0" },
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

两个令牌也可以用环境变量 `DSH_CLOUD_MEMORY_ACTIVITY_TOKEN`、`DSH_CLOUD_MEMORY_MEMORY_TOKEN` 覆盖。

> 一个 key 只有一种 scope，所以需要两个令牌：只做上报就只填活动令牌，只做检索就只填记忆令牌。

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
