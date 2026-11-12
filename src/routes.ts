/**
 * HTTP surface served by the host web server.
 *
 * All routes live under `/dsh-brain`:
 * - `GET  /dsh-brain`              configuration page (HTML)
 * - `GET  /dsh-brain/status`       settings + reporter counters + capabilities
 * - `GET  /dsh-brain/capabilities` what this build can and cannot do
 * - `PUT  /dsh-brain/config`       apply a settings patch
 * - `POST /dsh-brain/login`        password sign-in, mints the tokens
 * - `POST /dsh-brain/test`         read-only checks, per credential
 * - `POST /dsh-brain/flush`        retry the queued reports
 * - `GET  /dsh-brain/skills/api`   skill inventory + pending plans
 * - `POST /dsh-brain/skills/*`     detail / toggle / install plan / commit / uninstall
 *
 * Every JSON route is same-origin only: the tokens are read from the local file
 * and never echoed back, but a cross-site `PUT` could still be used to redirect
 * reports to an attacker's base URL, so the origin check stays on.
 *
 * Skill writes follow a plan → commit contract: a destructive operation is
 * never reachable in one request, and a client-supplied path is never trusted.
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { CloudClient } from './api.ts'
import { describeError, isSecureLoginTarget } from './api.ts'
import type { SettingsView, SettingsStore, TokenView } from './store.ts'
import type { Reporter } from './reporter.ts'
import { renderConfigPage } from './page.ts'
import type { CloudMemoryWebRoute } from './context-types.ts'
import type { SkillSync, SkillSyncStats } from './skill-sync.ts'
import { SkillAdminError } from './skill-admin.ts'
import type { SkillAdmin } from './skill-admin.ts'
import { MarketError } from './market.ts'
import type { MarketService } from './market.ts'
import type { SkillUpdater } from './skill-update.ts'
import type { ClientRegistry } from './clients.ts'
import { brainStatus, migrateLegacyFiles } from './brain-migration.ts'
import { SkillGroupError } from './skill-groups.ts'
import type { SkillGroupManager } from './skill-groups.ts'
import { renderSkillsPage } from './skill-page.ts'
import { randomUUID } from 'node:crypto'

/** Route constants — kept in one place so the client half can reuse them. */
export const ROUTES = {
  page: '/dsh-brain',
  status: '/dsh-brain/status',
  capabilities: '/dsh-brain/capabilities',
  config: '/dsh-brain/config',
  login: '/dsh-brain/login',
  test: '/dsh-brain/test',
  flush: '/dsh-brain/flush',
  skills: '/dsh-brain/skills',
  market: '/dsh-brain/market',
  sync: '/dsh-brain/sync',
  clients: '/dsh-brain/clients',
  migrate: '/dsh-brain/migrate',
} as const

/** Largest request body we accept (a settings patch is tiny). */
const MAX_BODY_BYTES = 64 * 1024

/** Everything the routes need from the plugin core. */
export interface RouteDeps {
  version: string
  store: SettingsStore
  reporter: Reporter
  client: () => CloudClient
  /** Latest skill-sync stats, when the engine is wired in. */
  skills?: () => SkillSyncStats
  /** Local skill management (list / toggle / install / uninstall), when wired in. */
  admin?: SkillAdmin
  /** Multi-source skill tree (sources, categories, per-group switches). */
  groups?: SkillGroupManager
  /** Skill market providers (search / detail / resolve artifact). */
  market?: MarketService
  /** The sync engine itself, for conflict details and interactive resolution. */
  sync?: SkillSync
  /** Update / rollback over a recorded git or market source. */
  updates?: SkillUpdater
  /** Cross-software / workspace inventory (v1.1 §15). */
  clients?: ClientRegistry
}

/** One feature flag the card reads before it renders a control. */
export interface CapabilityReport {
  version: string
  features: {
    connection: boolean
    identitySwitch: boolean
    skills: boolean
    skillInstallPlans: boolean
    skillUninstallPlan: boolean
    skillsSync: boolean
    skillsMarketplace: boolean
    /** Market search/detail/install is wired to a real provider. */
    marketProviders?: number
    /** Update/rollback is available for skills with a source record. */
    skillUpdate?: boolean
    /** Interactive sync conflict resolution is available. */
    syncResolve?: boolean
    /** Cross-software and workspace skill inventory is available. */
    multiClient?: boolean
    /** dsh-brain data migration status (package rename stays a deploy step). */
    brainMigration?: 'ready' | 'pending-deploy'
    mcpBridge: 'host-plugin' | 'unavailable'
  }
  notes: string[]
}

/** What this build actually implements, stated per feature. */
function capabilities(deps: RouteDeps): CapabilityReport {
  const marketProviders = deps.market?.list().length ?? 0
  return {
    version: deps.version,
    features: {
      connection: true,
      identitySwitch: true,
      skills: deps.admin !== undefined,
      skillInstallPlans: deps.admin !== undefined,
      skillUninstallPlan: deps.admin !== undefined,
      skillsSync: deps.skills !== undefined,
      skillsMarketplace: deps.market !== undefined,
      marketProviders,
      skillUpdate: deps.updates !== undefined,
      syncResolve: deps.sync !== undefined,
      multiClient: deps.clients !== undefined,
      brainMigration: 'ready',
      // The MCP bridge is provided by the host `dsh-mcp-connector` plugin over
      // the same origin; the browser half probes it at runtime.
      mcpBridge: 'host-plugin',
    },
    notes: [
      ...(deps.market === undefined
        ? ['技能市场未启用：没有配置市场来源。']
        : [`技能市场已接入 ${marketProviders} 个来源；安装走暂存计划并固定提交。`]),
      ...(deps.updates === undefined
        ? ['技能更新/回退未启用。']
        : ['更新/回退仅对带来源记录（.skill-source.json）的技能生效，更新前自动备份。']),
      ...(deps.sync === undefined ? [] : ['同步冲突可在技能页签逐项“保留本地 / 采用云端 / 手动合并”。']),
      ...(deps.clients === undefined ? [] : ['跨软件与工作区技能清单为只读（DSH 之外不写目录）；dsh-brain 数据迁移已就绪，实际改名需部署重启。']),
      'MCP 管理由宿主 dsh-mcp-connector 插件提供，本卡通过其公开接口读写，不另建凭据库。',
      'MCP 工具可见性与会话级激活分属两层：本卡展示连接与工具缓存，会话级“选择精确工具后激活”由宿主 session-tools 负责，本卡不伪造激活。',
    ],
  }
}

/** Collect a request body as UTF-8 text. */
async function readBody(req: IncomingMessage, maxBytes = MAX_BODY_BYTES): Promise<string> {
  const chunks: Buffer[] = []
  let bytes = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array)
    bytes += buffer.byteLength
    if (bytes > maxBytes) throw new Error('request-too-large')
    chunks.push(buffer)
  }
  return Buffer.concat(chunks).toString('utf8')
}

/** Reject cross-origin browser writes. */
function sameOrigin(req: IncomingMessage): boolean {
  const origin = req.headers.origin
  const host = req.headers.host
  if (origin === undefined || host === undefined) return true
  return origin === `http://${host}` || origin === `https://${host}`
}

/** Emit one JSON response with no caching. */
function json(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(text),
  })
  res.end(text)
}

/** Emit a plain-text error (page route) or JSON error (API routes). */
function fail(res: ServerResponse, status: number, message: string, asHtml = false): void {
  const text = asHtml
    ? `<!doctype html><meta charset="utf-8"><title>云端记忆</title><body style="font:14px system-ui;padding:32px">${message}</body>`
    : JSON.stringify({ ok: false, error: message })
  res.writeHead(status, {
    'content-type': asHtml ? 'text/html; charset=utf-8' : 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(text)
}

/**
 * Read one JSON object body, or answer the request and return undefined.
 *
 * The method, origin and content-type gates live here so every write route
 * cannot forget one of them.
 */
async function jsonBody(req: IncomingMessage, res: ServerResponse): Promise<Record<string, unknown> | undefined> {
  if (req.method !== 'POST' && req.method !== 'PUT') {
    fail(res, 405, 'method-not-allowed')
    return undefined
  }
  if (!sameOrigin(req)) {
    fail(res, 403, 'origin-rejected')
    return undefined
  }
  const type = (req.headers['content-type'] ?? '').toLowerCase()
  if (!type.startsWith('application/json')) {
    fail(res, 415, 'json-required')
    return undefined
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(await readBody(req))
  } catch (error) {
    fail(res, 400, error instanceof Error && error.message === 'request-too-large' ? 'request-too-large' : 'invalid-json')
    return undefined
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    fail(res, 400, 'invalid-body')
    return undefined
  }
  return parsed as Record<string, unknown>
}

/** One credential check as the card renders it. */
type CheckState = 'ok' | 'unconfigured' | 'invalid' | 'forbidden' | 'unreachable' | 'error'

interface CheckItem {
  id: string
  label: string
  state: CheckState
  message: string
}

/** Last test run, kept in memory so the card can show "最后检查". */
let lastCheck: { at: number; checks: CheckItem[] } | null = null

/**
 * Uninstall confirmations.
 *
 * A preview issues a single-use token bound to one folder; the delete route
 * refuses without it, so a stray click cannot remove a skill.
 */
const uninstallTokens = new Map<string, { token: string; expiresAt: number }>()
const UNINSTALL_TOKEN_TTL_MS = 10 * 60_000

/** The payload the page and the client card both consume. */
function statusPayload(deps: RouteDeps): Record<string, unknown> {
  const view: SettingsView = deps.store.describe()
  const tokens = {
    activity: view.activityToken as TokenView,
    memory: view.memoryToken as TokenView,
    summary: view.summaryToken as TokenView,
  }
  const settings = {
    enabled: view.enabled,
    baseUrl: view.baseUrl,
    baseUrlConfigured: view.baseUrlConfigured,
    baseUrlOrigin: view.baseUrlOrigin,
    clientId: view.clientId,
    requestTimeoutMs: view.requestTimeoutMs,
    defaultK: view.defaultK,
    summaryEnabled: view.summaryEnabled,
    summaryMaxChars: view.summaryMaxChars,
    skillsSyncEnabled: view.skillsSyncEnabled,
    skillsDir: view.skillsDir,
  }
  return {
    ok: true,
    settings,
    tokens,
    settingsPath: view.statePath,
    reporter: deps.reporter.snapshot(),
    lastCheck,
    capabilities: capabilities(deps),
    ...(deps.skills === undefined ? {} : { skills: deps.skills() }),
  }
}

/** Serve the configuration page. */
function servePage(deps: RouteDeps, req: IncomingMessage, res: ServerResponse): void {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    fail(res, 405, 'method-not-allowed', true)
    return
  }
  const html = renderConfigPage({ version: deps.version, settingsPath: deps.store.path })
  res.writeHead(200, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(html),
  })
  if (req.method === 'HEAD') res.end()
  else res.end(html)
}

/** `GET /dsh-brain/status`. */
function serveStatus(deps: RouteDeps, req: IncomingMessage, res: ServerResponse): void {
  if (req.method !== 'GET') {
    fail(res, 405, 'method-not-allowed')
    return
  }
  json(res, 200, statusPayload(deps))
}

/** `GET /dsh-brain/capabilities`. */
function serveCapabilities(deps: RouteDeps, req: IncomingMessage, res: ServerResponse): void {
  if (req.method !== 'GET') {
    fail(res, 405, 'method-not-allowed')
    return
  }
  json(res, 200, { ok: true, ...capabilities(deps) })
}

/** `PUT /dsh-brain/config`. */
async function serveConfig(deps: RouteDeps, req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== 'PUT' && req.method !== 'POST') {
    fail(res, 405, 'method-not-allowed')
    return
  }
  if (!sameOrigin(req)) {
    fail(res, 403, 'origin-rejected')
    return
  }
  const type = (req.headers['content-type'] ?? '').toLowerCase()
  if (!type.startsWith('application/json')) {
    fail(res, 415, 'json-required')
    return
  }
  let patch: unknown
  try {
    patch = JSON.parse(await readBody(req))
  } catch (error) {
    fail(res, 400, error instanceof Error && error.message === 'request-too-large' ? 'request-too-large' : 'invalid-json')
    return
  }
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) {
    fail(res, 400, 'invalid-patch')
    return
  }
  const result = deps.store.patch(patch as Record<string, unknown>)
  if (!result.ok) {
    fail(res, 400, result.error ?? 'invalid-patch')
    return
  }
  json(res, 200, {
    ...statusPayload(deps),
    ...(result.clearedTokens === undefined ? {} : { credentialsCleared: result.clearedTokens }),
  })
}

/** Map one failed credential probe onto a check state. */
function checkState(error: { status: number; code: string }): CheckState {
  if (error.status === 0) return 'unreachable'
  if (error.status === 401) return 'invalid'
  if (error.status === 403) return 'forbidden'
  return 'error'
}

/** `POST /dsh-brain/test` — read-only checks, one per credential. */
async function serveTest(deps: RouteDeps, req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== 'POST') {
    fail(res, 405, 'method-not-allowed')
    return
  }
  if (!sameOrigin(req)) {
    fail(res, 403, 'origin-rejected')
    return
  }
  const client = deps.client()
  const checks: CheckItem[] = []
  const settings = deps.store.settings()

  const reach = await client.reach()
  checks.push({
    id: 'network',
    label: '服务地址',
    state: reach.ok ? 'ok' : 'unreachable',
    message: deps.store.describe().baseUrlConfigured === false ? '服务地址还是打包默认值，请先填写真实地址。' : reach.message,
  })

  const activityToken = deps.store.activityToken()
  if (activityToken === '') {
    checks.push({ id: 'activity', label: '活动上报权限（activity:write）', state: 'unconfigured', message: '未配置令牌' })
  } else {
    const probe = await client.probeActivity(activityToken)
    checks.push({
      id: 'activity',
      label: '活动上报权限（activity:write）',
      state: probe.ok ? 'ok' : checkState(probe.error),
      message: probe.ok ? '鉴权通过（只验证权限，不代表已写入一条上报）' : describeError(probe.error),
    })
  }

  const memoryToken = deps.store.memoryToken()
  if (memoryToken === '') {
    checks.push({ id: 'memory', label: '记忆读写权限（memory:write）', state: 'unconfigured', message: '未配置令牌' })
  } else {
    const probe = await client.projects()
    checks.push({
      id: 'memory',
      label: '记忆读写权限（memory:write）',
      state: probe.ok ? 'ok' : checkState(probe.error),
      message: probe.ok ? `鉴权通过（${(probe.data.projects ?? []).length} 个项目）` : describeError(probe.error),
    })
  }

  const summaryToken = deps.store.summaryToken()
  if (!settings.summaryEnabled) {
    checks.push({ id: 'summary', label: '摘要权限（summary:write）', state: 'unconfigured', message: '自动摘要已关闭' })
  } else if (summaryToken === '') {
    checks.push({ id: 'summary', label: '摘要权限（summary:write）', state: 'unconfigured', message: '未配置摘要令牌（可选）' })
  } else {
    const probe = await client.probeSummary(summaryToken)
    checks.push({
      id: 'summary',
      label: '摘要权限（summary:write）',
      state: probe.ok ? 'ok' : checkState(probe.error),
      message: probe.ok ? '鉴权通过（只进待确认队列）' : describeError(probe.error),
    })
  }

  lastCheck = { at: Date.now(), checks }
  json(res, 200, {
    ok: true,
    checkedAt: lastCheck.at,
    checks,
    // Kept for the older card/page shape; both views read the same probes.
    activity: { ok: checks[1]?.state === 'ok', message: checks[1]?.message ?? '' },
    memory: { ok: checks[2]?.state === 'ok', message: checks[2]?.message ?? '' },
    summary: { ok: checks[3]?.state === 'ok', message: checks[3]?.message ?? '' },
  })
}

/** `POST /dsh-brain/flush`. */
async function serveFlush(deps: RouteDeps, req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== 'POST') {
    fail(res, 405, 'method-not-allowed')
    return
  }
  if (!sameOrigin(req)) {
    fail(res, 403, 'origin-rejected')
    return
  }
  const result = await deps.reporter.flush()
  json(res, 200, { ok: true, ...result })
}

/** Labels attached to the tokens this plugin asks the dashboard to mint. */
const TOKEN_LABELS = {
  activity: 'DSH desktop 活动上报',
  memory: 'DSH desktop 记忆读写',
  summary: 'DSH desktop 对话摘要',
}

/**
 * `POST /dsh-brain/login` — sign in with the cloud account and exchange it
 * for the scoped tokens.
 *
 * The password is used once, in memory, and never written anywhere: the flow is
 * password → short-lived session cookie → tokens → cookie dropped. Only the
 * tokens are persisted, so a later password change does not break the plugin
 * and revoking a token does not reveal the password.
 */
async function serveLogin(deps: RouteDeps, req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== 'POST') {
    fail(res, 405, 'method-not-allowed')
    return
  }
  if (!sameOrigin(req)) {
    fail(res, 403, 'origin-rejected')
    return
  }
  const target = deps.store.settings().baseUrl
  if (!isSecureLoginTarget(target)) {
    // Refuse to put a password on a plaintext channel that is not loopback.
    json(res, 400, { ok: false, error: '服务地址不是 HTTPS，拒绝在上面发送密码，请先把服务地址改成 https://' })
    return
  }
  let raw: string
  try {
    raw = await readBody(req)
  } catch {
    fail(res, 413, 'request-too-large')
    return
  }
  let body: Record<string, unknown>
  try {
    const parsed: unknown = JSON.parse(raw)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('object required')
    body = parsed as Record<string, unknown>
  } catch {
    fail(res, 400, 'invalid-json')
    return
  }
  const username = typeof body.username === 'string' ? body.username.trim() : ''
  const password = typeof body.password === 'string' ? body.password : ''
  if (username === '' || password === '') {
    json(res, 400, { ok: false, error: '请填写用户名和密码' })
    return
  }
  if (username.length > 64 || password.length > 256) {
    json(res, 400, { ok: false, error: '用户名或密码过长' })
    return
  }
  const client = deps.client()
  const session = await client.login(username, password)
  if (!session.ok) {
    const status = session.error.status === 429 ? 429 : 401
    json(res, status, { ok: false, error: describeError(session.error) })
    return
  }
  const activity = await client.mintToken(session.data.sessionCookie, 'activity:write', TOKEN_LABELS.activity)
  const memory = await client.mintToken(session.data.sessionCookie, 'memory:write', TOKEN_LABELS.memory)
  const summary = await client.mintToken(session.data.sessionCookie, 'summary:write', TOKEN_LABELS.summary)
  if (!activity.ok && !memory.ok) {
    const first = activity.ok ? memory : activity
    const reason = first.ok ? '无法创建令牌' : describeError(first.error)
    json(res, 400, { ok: false, error: `登录成功，但创建令牌失败：${reason}` })
    return
  }
  const patch: Record<string, unknown> = {}
  if (activity.ok && typeof activity.data.token === 'string') patch.activityToken = activity.data.token
  if (memory.ok && typeof memory.data.token === 'string') patch.memoryToken = memory.data.token
  if (summary.ok && typeof summary.data.token === 'string') patch.summaryToken = summary.data.token
  const applied = deps.store.patch(patch)
  if (!applied.ok) {
    json(res, 500, { ok: false, error: applied.error })
    return
  }
  const failed = activity.ok ? memory : activity
  const partial = !activity.ok || !memory.ok
  json(res, 200, {
    ...statusPayload(deps),
    login: {
      ok: true,
      partial,
      user: {
        username: typeof session.data.user.username === 'string' ? session.data.user.username : username,
        role: session.data.user.role,
      },
      activity: activity.ok,
      memory: memory.ok,
      summary: summary.ok,
      warning: failed.ok ? undefined : `部分令牌没有创建成功：${describeError(failed.error)}`,
    },
  })
}

/** HTTP status for one skill-admin failure code. */
function adminStatus(code: string): number {
  switch (code) {
    case 'not_found': return 404
    case 'invalid_name':
    case 'invalid_url':
    case 'invalid_plan': return 400
    case 'collision':
    case 'sync_running':
    case 'plan_expired':
    case 'confirmation_required':
    case 'no_source':
    case 'up_to_date':
    case 'stale_plan':
    case 'unsupported': return 409
    case 'no_backup': return 404
    case 'no_skills_found': return 422
    case 'git_failed': return 502
    default: return 500
  }
}

/** Issue the single-use token a delete needs. */
function issueUninstallToken(folder: string): string {
  const token = `uninstall_${randomUUID()}`
  uninstallTokens.set(folder, { token, expiresAt: Date.now() + UNINSTALL_TOKEN_TTL_MS })
  return token
}

/** Consume one uninstall token; false when it is missing, stale or foreign. */
function useUninstallToken(folder: string, token: unknown): boolean {
  const record = uninstallTokens.get(folder)
  if (record === undefined) return false
  if (typeof token !== 'string' || token !== record.token) return false
  if (record.expiresAt < Date.now()) {
    uninstallTokens.delete(folder)
    return false
  }
  uninstallTokens.delete(folder)
  return true
}

/**
 * The skill management surface, one prefix route:
 * `GET  /dsh-brain/skills`              the management page
 * `GET  /dsh-brain/skills/api`          inventory JSON (skills + plans)
 * `POST /dsh-brain/skills/detail`       { folder } — one skill with SKILL.md
 * `POST /dsh-brain/skills/toggle`       { folder, enabled }
 * `POST /dsh-brain/skills/install/plan` { url } — stage the repository
 * `POST /dsh-brain/skills/install/commit` { planId, folders }
 * `POST /dsh-brain/skills/install/cancel` { planId }
 * `POST /dsh-brain/skills/uninstall/plan` { folder } — impact preview
 * `POST /dsh-brain/skills/remove`       { folder, token, confirmed: true }
 */
async function serveSkills(deps: RouteDeps, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const admin = deps.admin
  if (admin === undefined) {
    fail(res, 404, 'skills-admin-unavailable')
    return
  }
  const suffix = (req.url ?? '').split('?')[0]?.slice(ROUTES.skills.length) ?? ''
  if (suffix === '' || suffix === '/') {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      fail(res, 405, 'method-not-allowed', true)
      return
    }
    const html = renderSkillsPage({ version: deps.version })
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'content-length': Buffer.byteLength(html),
    })
    if (req.method === 'HEAD') res.end()
    else res.end(html)
    return
  }
  if (suffix === '/api') {
    if (req.method !== 'GET') {
      fail(res, 405, 'method-not-allowed')
      return
    }
    const inventory = await admin.list()
    json(res, 200, { ok: true, ...inventory, ...(await admin.listPlans()) })
    return
  }
  if (suffix === '/sources') {
    if (req.method !== 'GET') {
      fail(res, 405, 'method-not-allowed')
      return
    }
    const groups = deps.groups
    if (groups === undefined) {
      fail(res, 404, 'skill-groups-unavailable')
      return
    }
    json(res, 200, { ok: true, ...(await groups.overview()) })
    return
  }

  type Handler = (body: Record<string, unknown>) => Promise<Record<string, unknown>>
  const actions: Record<string, Handler> = {
    '/detail': async (body) => ({ ...(await admin.detail(body.folder)) }),
    '/toggle': async (body) => ({ ...(await admin.setEnabled(body.folder, body.enabled === true)) }),
    // One-shot install kept for the standalone page; the card uses plan/commit.
    '/install': async (body) => ({ ...(await admin.installFromGit(body.url)) }),
    '/install/plan': async (body) => ({ ...(await admin.prepareInstall(body.url)) }),
    '/install/commit': async (body) => ({ ...(await admin.commitInstall({ planId: body.planId, folders: body.folders })) }),
    '/install/cancel': async (body) => ({ ...(await admin.cancelInstall({ planId: body.planId })) }),
    '/uninstall/plan': async (body) => {
      const plan = await admin.uninstallPlan(body.folder)
      return { ...plan, token: issueUninstallToken(plan.folder) }
    },
    '/remove': async (body) => {
      if (body.confirmed !== true) {
        throw new SkillAdminError('confirmation_required', '删除必须显式确认：先预览影响，再传 confirmed=true。')
      }
      const folder = typeof body.folder === 'string' ? body.folder : ''
      if (!useUninstallToken(folder, body.token)) {
        throw new SkillAdminError('confirmation_required', '卸载确认已过期或与该技能不匹配，请重新预览。')
      }
      return { ...(await admin.remove(folder)) }
    },
  }
  // Update/rollback operate on skills with a `.skill-source.json` record. They
  // are optional: without the updater wired in the routes answer 404.
  const updateActions: Record<string, Handler> = {
    '/update/check': async (body) => ({ ...(await requireUpdates(deps).checkUpdate(body.folder)) }),
    '/update/apply': async (body) => ({ ...(await requireUpdates(deps).applyUpdate(body.folder, body.expectedCommit)) }),
    '/rollback': async (body) => ({ ...(await requireUpdates(deps).rollback(body.folder)) }),
  }
  // Category and source switches live in the same prefix so the card has one
  // base URL; they are grouped here because they never touch a skill folder
  // directly (except the DSH park/unpark the group manager delegates).
  const groupActions: Record<string, Handler> = {
    '/import': async (body) => ({ ...(await requireGroups(deps).importSkill(body.sourceId, body.folder)) }),
    '/groups/create': async (body) => ({ ...(await requireGroups(deps).createGroup(body.sourceId, body.name)) }),
    '/groups/rename': async (body) => ({ ...(await requireGroups(deps).renameGroup(body.sourceId, body.groupId, body.name)) }),
    '/groups/delete': async (body) => ({ ...(await requireGroups(deps).deleteGroup(body.sourceId, body.groupId)) }),
    '/groups/assign': async (body) => ({ ...(await requireGroups(deps).assign(body.sourceId, body.groupId, body.folders)) }),
    '/groups/toggle': async (body) => ({ ...(await requireGroups(deps).toggleGroup(body.sourceId, body.groupId, body.enabled === true)) }),
    '/source/toggle': async (body) => ({ ...(await requireGroups(deps).toggleSource(body.sourceId, body.enabled === true)) }),
    '/source/reveal': async (body) => ({ ...(await requireGroups(deps).reveal(body.sourceId)) }),
  }
  const action = actions[suffix] ?? groupActions[suffix] ?? updateActions[suffix]
  if (action === undefined) {
    fail(res, 404, 'unknown-skill-route')
    return
  }
  const body = await jsonBody(req, res)
  if (body === undefined) return
  try {
    json(res, 200, { ok: true, ...(await action(body)) })
  } catch (error) {
    if (error instanceof SkillAdminError) {
      json(res, adminStatus(error.code), { ok: false, code: error.code, error: error.message })
      return
    }
    if (error instanceof SkillGroupError) {
      json(res, groupStatus(error.code), { ok: false, code: error.code, error: error.message })
      return
    }
    json(res, 500, { ok: false, code: 'internal', error: error instanceof Error ? error.message : String(error) })
  }
}

/** The group manager is optional; the routes answer 404 when it is absent. */
function requireGroups(deps: RouteDeps): SkillGroupManager {
  if (deps.groups === undefined) throw new SkillGroupError('unavailable', '技能分组功能未启用。')
  return deps.groups
}

/** HTTP status for one group failure code. */
function groupStatus(code: string): number {
  switch (code) {
    case 'not_found':
    case 'unknown_source': return 404
    case 'invalid_name':
    case 'duplicate':
    case 'import_from_self':
    case 'invalid_skill':
    case 'too_many': return 400
    case 'unavailable': return 503
    default: return 500
  }
}

/** The updater is optional; its routes answer 404 when it is absent. */
function requireUpdates(deps: RouteDeps): SkillUpdater {
  if (deps.updates === undefined) throw new SkillAdminError('unsupported', '技能更新/回退未启用。')
  return deps.updates
}

/** HTTP status for one market failure code. */
function marketStatus(code: string): number {
  switch (code) {
    case 'unknown_provider':
    case 'invalid_manifest': return 400
    case 'not_found': return 404
    case 'unreachable':
    case 'unavailable': return 502
    default:
      return code.startsWith('http_') ? 502 : 500
  }
}

/**
 * Market surface, one prefix route:
 * `GET  /dsh-brain/market/providers`  configured sources
 * `GET  /dsh-brain/market/search`     ?provider=&q=&cursor=
 * `POST /dsh-brain/market/detail`     { provider, id }
 * `POST /dsh-brain/market/plan`       { provider, id } — pin commit + stage a plan
 * `POST /dsh-brain/market/commit`     { planId, folders }
 * `POST /dsh-brain/market/cancel`     { planId }
 */
async function serveMarket(deps: RouteDeps, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const market = deps.market
  if (market === undefined) {
    fail(res, 404, 'market-unavailable')
    return
  }
  const url = new URL(req.url ?? '/', 'http://localhost')
  const suffix = url.pathname.slice(ROUTES.market.length)
  try {
    if (suffix === '' || suffix === '/' || suffix === '/providers') {
      if (req.method !== 'GET') { fail(res, 405, 'method-not-allowed'); return }
      json(res, 200, { ok: true, providers: market.list() })
      return
    }
    if (suffix === '/search') {
      if (req.method !== 'GET') { fail(res, 405, 'method-not-allowed'); return }
      const providerId = url.searchParams.get('provider') ?? market.list()[0]?.id ?? ''
      const query = url.searchParams.get('q') ?? ''
      const cursorRaw = Number(url.searchParams.get('cursor') ?? '0')
      const cursor = Number.isFinite(cursorRaw) && cursorRaw > 0 ? cursorRaw : 0
      const result = await market.search(providerId, query, cursor)
      json(res, 200, { ok: true, provider: market.get(providerId).info(), ...result })
      return
    }
    type Handler = (body: Record<string, unknown>) => Promise<Record<string, unknown>>
    const admin = deps.admin
    const requireAdmin = (): SkillAdmin => {
      if (admin === undefined) throw new MarketError('unavailable', '技能管理未启用，无法安装。')
      return admin
    }
    const actions: Record<string, Handler> = {
      '/detail': async (body) => ({ ...(await market.detail(String(body.provider ?? ''), String(body.id ?? ''))) }),
      '/plan': async (body) => {
        const providerId = String(body.provider ?? '')
        const id = String(body.id ?? '')
        const artifact = await market.resolve(providerId, id, typeof body.version === 'string' ? body.version : undefined)
        const plan = await requireAdmin().prepareInstall(artifact.repoUrl, {
          ref: artifact.ref,
          source: {
            provider: providerId,
            entryId: id,
            ...(artifact.version === undefined ? {} : { version: artifact.version }),
          },
        })
        const wanted = new Set(artifact.folders)
        return {
          planId: plan.planId,
          ...(plan.commit === undefined ? {} : { commit: plan.commit }),
          artifact,
          candidates: plan.candidates.filter((candidate) => wanted.has(candidate.folder)),
          totalInRepo: plan.candidates.length,
        }
      },
      '/commit': async (body) => ({ ...(await requireAdmin().commitInstall({ planId: body.planId, folders: body.folders })) }),
      '/cancel': async (body) => ({ ...(await requireAdmin().cancelInstall({ planId: body.planId })) }),
    }
    const action = actions[suffix]
    if (action === undefined) { fail(res, 404, 'unknown-market-route'); return }
    const body = await jsonBody(req, res)
    if (body === undefined) return
    json(res, 200, { ok: true, ...(await action(body)) })
  } catch (error) {
    if (error instanceof MarketError) {
      json(res, marketStatus(error.code), { ok: false, code: error.code, error: error.message })
      return
    }
    if (error instanceof SkillAdminError) {
      json(res, adminStatus(error.code), { ok: false, code: error.code, error: error.message })
      return
    }
    json(res, 500, { ok: false, code: 'internal', error: error instanceof Error ? error.message : String(error) })
  }
}

/**
 * Sync surface:
 * `GET  /dsh-brain/sync/status`   latest stats + both sides of each conflict
 * `POST /dsh-brain/sync/run`      trigger one pass now
 * `POST /dsh-brain/sync/resolve`  { name, action: keep_local | take_cloud | manual }
 */
async function serveSync(deps: RouteDeps, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const sync = deps.sync
  if (sync === undefined) {
    fail(res, 404, 'sync-unavailable')
    return
  }
  const url = new URL(req.url ?? '/', 'http://localhost')
  const suffix = url.pathname.slice(ROUTES.sync.length)
  try {
    if (suffix === '' || suffix === '/' || suffix === '/status') {
      if (req.method !== 'GET') { fail(res, 405, 'method-not-allowed'); return }
      json(res, 200, { ok: true, stats: sync.stats(), conflicts: await sync.conflictDetails() })
      return
    }
    if (suffix === '/run') {
      if (req.method !== 'POST') { fail(res, 405, 'method-not-allowed'); return }
      const stats = await sync.syncOnce()
      json(res, 200, { ok: true, stats, conflicts: await sync.conflictDetails() })
      return
    }
    if (suffix === '/resolve') {
      if (req.method !== 'POST') { fail(res, 405, 'method-not-allowed'); return }
      const body = await jsonBody(req, res)
      if (body === undefined) return
      const result = await sync.resolveConflict(body.name, body.action)
      json(res, 200, { ok: true, ...result, conflicts: await sync.conflictDetails() })
      return
    }
    fail(res, 404, 'unknown-sync-route')
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const known = ['invalid_name', 'invalid_action', 'no_local_copy', 'no_cloud_copy', 'stale_revision', 'sync_running', 'manifest_mismatch']
    const code = known.includes(message) ? message : 'internal'
    const status = code === 'internal' ? 500
      : code === 'invalid_name' || code === 'invalid_action' ? 400
        : 409
    json(res, status, { ok: false, code, error: message })
  }
}

/** Cross-software / workspace inventory routes. */
async function serveClients(deps: RouteDeps, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const registry = deps.clients
  if (registry === undefined) {
    fail(res, 404, 'clients-unavailable')
    return
  }
  const url = new URL(req.url ?? '/', 'http://localhost')
  const suffix = url.pathname.slice(ROUTES.clients.length)
  try {
    if (suffix === '' || suffix === '/' || suffix === '/overview') {
      if (req.method !== 'GET') { fail(res, 405, 'method-not-allowed'); return }
      json(res, 200, { ok: true, ...(await registry.overview()) })
      return
    }
    if (suffix === '/inventory') {
      if (req.method !== 'GET') { fail(res, 405, 'method-not-allowed'); return }
      const result = await registry.inventory(
        url.searchParams.get('software'),
        url.searchParams.get('scope'),
        url.searchParams.get('workspaceId') ?? undefined,
      )
      json(res, 200, { ok: true, ...result })
      return
    }
    if (suffix === '/workspaces/add') {
      if (req.method !== 'POST') { fail(res, 405, 'method-not-allowed'); return }
      const body = await jsonBody(req, res)
      if (body === undefined) return
      const workspace = await registry.addWorkspace(body.software, body.path, body.name)
      json(res, 200, { ok: true, workspace })
      return
    }
    if (suffix === '/workspaces/remove') {
      if (req.method !== 'POST') { fail(res, 405, 'method-not-allowed'); return }
      const body = await jsonBody(req, res)
      if (body === undefined) return
      json(res, 200, { ok: true, ...(await registry.removeWorkspace(body.software, body.id)) })
      return
    }
    if (suffix === '/workspace/inventory') {
      if (req.method !== 'GET') { fail(res, 405, 'method-not-allowed'); return }
      const { admin, workspace } = await registry.workspaceSkillAdmin(url.searchParams.get('software'), url.searchParams.get('workspaceId'))
      json(res, 200, { ok: true, workspace, ...(await admin.list()) })
      return
    }
    if (suffix === '/workspace/detail') {
      if (req.method !== 'POST') { fail(res, 405, 'method-not-allowed'); return }
      const body = await jsonBody(req, res)
      if (body === undefined) return
      const { admin } = await registry.workspaceSkillAdmin(body.software, body.workspaceId)
      json(res, 200, { ok: true, ...(await admin.detail(body.folder)) })
      return
    }
    if (suffix === '/workspace/toggle') {
      if (req.method !== 'POST') { fail(res, 405, 'method-not-allowed'); return }
      const body = await jsonBody(req, res)
      if (body === undefined) return
      const { admin } = await registry.workspaceSkillAdmin(body.software, body.workspaceId)
      json(res, 200, { ok: true, ...(await admin.setEnabled(body.folder, body.enabled === true)) })
      return
    }
    if (suffix === '/workspace/remove') {
      if (req.method !== 'POST') { fail(res, 405, 'method-not-allowed'); return }
      const body = await jsonBody(req, res)
      if (body === undefined) return
      if (body.confirmed !== true) throw new SkillAdminError('confirmation_required', '工作区技能删除必须显式 confirmed:true。')
      const { admin } = await registry.workspaceSkillAdmin(body.software, body.workspaceId)
      json(res, 200, { ok: true, ...(await admin.remove(body.folder)) })
      return
    }
    if (suffix === '/workspace/install/plan') {
      if (req.method !== 'POST') { fail(res, 405, 'method-not-allowed'); return }
      const body = await jsonBody(req, res)
      if (body === undefined) return
      const { admin } = await registry.workspaceSkillAdmin(body.software, body.workspaceId)
      json(res, 200, { ok: true, ...(await admin.prepareInstall(body.url)) })
      return
    }
    if (suffix === '/workspace/install/commit') {
      if (req.method !== 'POST') { fail(res, 405, 'method-not-allowed'); return }
      const body = await jsonBody(req, res)
      if (body === undefined) return
      const { admin } = await registry.workspaceSkillAdmin(body.software, body.workspaceId)
      json(res, 200, { ok: true, ...(await admin.commitInstall({ planId: body.planId, folders: body.folders })) })
      return
    }
    fail(res, 404, 'unknown-clients-route')
  } catch (error) {
    if (error instanceof SkillAdminError) {
      json(res, adminStatus(error.code), { ok: false, code: error.code, error: error.message })
      return
    }
    const message = error instanceof Error ? error.message : String(error)
    const known = ['invalid_software', 'invalid_path', 'duplicate', 'not_found', 'unknown_workspace', 'unsupported_workspace_write']
    const code = known.includes(message) ? message : 'internal'
    const status = code === 'internal' ? 500
      : code === 'not_found' || code === 'unknown_workspace' ? 404
        : code === 'duplicate' ? 409
          : code === 'unsupported_workspace_write' ? 501 : 400
    json(res, status, { ok: false, code, error: message })
  }
}

/** dsh-brain data migration: GET status, POST run. */
async function serveMigrate(_deps: RouteDeps, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost')
  const suffix = url.pathname.slice(ROUTES.migrate.length)
  if (suffix === '' || suffix === '/' || suffix === '/brain') {
    if (req.method === 'GET') { const status = await brainStatus(); json(res, 200, { ok: true, ...status }); return }
    if (req.method === 'POST') { const result = await migrateLegacyFiles(); json(res, 200, { ok: true, ...result }); return }
    fail(res, 405, 'method-not-allowed')
    return
  }
  fail(res, 404, 'unknown-migrate-route')
}

/** Build the exact-route table registered with the host web server. */
/** Pre-rename aliases (0.8.0): the same handlers under the old `/cloud-memory` prefix. */
export function createLegacyRoutes(deps: RouteDeps): CloudMemoryWebRoute[] {
  return createRoutes(deps).map((route) => ({ ...route, path: route.path.replace('/dsh-brain', '/cloud-memory') }))
}

export function createRoutes(deps: RouteDeps): CloudMemoryWebRoute[] {
  return [
    {
      kind: 'exact',
      path: ROUTES.page,
      handler: (req, res) => servePage(deps, req, res),
    },
    {
      kind: 'exact',
      path: ROUTES.status,
      handler: (req, res) => serveStatus(deps, req, res),
    },
    {
      kind: 'exact',
      path: ROUTES.capabilities,
      handler: (req, res) => serveCapabilities(deps, req, res),
    },
    {
      kind: 'exact',
      path: ROUTES.config,
      handler: (req, res) => serveConfig(deps, req, res),
    },
    {
      kind: 'exact',
      path: ROUTES.login,
      handler: (req, res) => serveLogin(deps, req, res),
    },
    {
      kind: 'exact',
      path: ROUTES.test,
      handler: (req, res) => serveTest(deps, req, res),
    },
    {
      kind: 'exact',
      path: ROUTES.flush,
      handler: (req, res) => serveFlush(deps, req, res),
    },
    {
      kind: 'prefix',
      path: ROUTES.skills,
      handler: (req, res) => serveSkills(deps, req, res),
    },
    {
      kind: 'prefix',
      path: ROUTES.market,
      handler: (req, res) => serveMarket(deps, req, res),
    },
    {
      kind: 'prefix',
      path: ROUTES.sync,
      handler: (req, res) => serveSync(deps, req, res),
    },
    {
      kind: 'prefix',
      path: ROUTES.clients,
      handler: (req, res) => serveClients(deps, req, res),
    },
    {
      kind: 'prefix',
      path: ROUTES.migrate,
      handler: (req, res) => serveMigrate(deps, req, res),
    },
  ]
}
