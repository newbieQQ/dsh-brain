/**
 * HTTP surface served by the host web server.
 *
 * All routes live under `/cloud-memory`:
 * - `GET  /cloud-memory`         configuration page (HTML)
 * - `GET  /cloud-memory/status`  settings + reporter counters (JSON)
 * - `PUT  /cloud-memory/config`  apply a settings patch (JSON)
 * - `POST /cloud-memory/login`   password sign-in, mints both tokens (JSON)
 * - `POST /cloud-memory/test`    validate both tokens (JSON)
 * - `POST /cloud-memory/flush`   retry the queued reports (JSON)
 *
 * Every JSON route is same-origin only: the tokens are read from the local file
 * and never echoed back, but a cross-site `PUT` could still be used to redirect
 * reports to an attacker's base URL, so the origin check stays on.
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { CloudClient } from './api.ts'
import { describeError, isSecureLoginTarget } from './api.ts'
import type { SettingsView, SettingsStore, TokenView } from './store.ts'
import type { Reporter } from './reporter.ts'
import { renderConfigPage } from './page.ts'
import type { CloudMemoryWebRoute } from './context-types.ts'

/** Route constants — kept in one place so the client half can reuse them. */
export const ROUTES = {
  page: '/cloud-memory',
  status: '/cloud-memory/status',
  config: '/cloud-memory/config',
  login: '/cloud-memory/login',
  test: '/cloud-memory/test',
  flush: '/cloud-memory/flush',
} as const

/** Largest request body we accept (a settings patch is tiny). */
const MAX_BODY_BYTES = 64 * 1024

/** Everything the routes need from the plugin core. */
export interface RouteDeps {
  version: string
  store: SettingsStore
  reporter: Reporter
  client: () => CloudClient
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

/** The payload the page and the client card both consume. */
function statusPayload(deps: RouteDeps): Record<string, unknown> {
  const view = deps.store.describe()
  const tokens: Record<'activity' | 'memory', TokenView> = {
    activity: view.activityToken,
    memory: view.memoryToken,
  }
  const settings = {
    enabled: view.enabled,
    baseUrl: view.baseUrl,
    clientId: view.clientId,
    requestTimeoutMs: view.requestTimeoutMs,
    defaultK: view.defaultK,
  }
  return { ok: true, settings, tokens, settingsPath: view.statePath, reporter: deps.reporter.snapshot() }
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

/** `GET /cloud-memory/status`. */
function serveStatus(deps: RouteDeps, req: IncomingMessage, res: ServerResponse): void {
  if (req.method !== 'GET') {
    fail(res, 405, 'method-not-allowed')
    return
  }
  json(res, 200, statusPayload(deps))
}

/** `PUT /cloud-memory/config`. */
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
  json(res, 200, statusPayload(deps))
}

/** `POST /cloud-memory/test` — validate both tokens without recording anything. */
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
  const activityToken = deps.store.activityToken()
  const memoryToken = deps.store.memoryToken()

  const activity: { ok: boolean; message: string } = activityToken === ''
    ? { ok: false, message: '还没填令牌：把 activity:write 密钥粘到下面「活动上报令牌」再点保存' }
    : await (async () => {
      const probe = await client.probeActivity(activityToken)
      return probe.ok
        ? { ok: true, message: '令牌有效（鉴权通过）' }
        : { ok: false, message: describeError(probe.error) }
    })()

  const memory: { ok: boolean; message: string } = memoryToken === ''
    ? { ok: false, message: '还没填令牌：把 memory:write 密钥粘到下面「记忆读写令牌」再点保存' }
    : await (async () => {
      const probe = await client.projects()
      return probe.ok
        ? { ok: true, message: `令牌有效（${(probe.data.projects ?? []).length} 个项目）` }
        : { ok: false, message: describeError(probe.error) }
    })()

  json(res, 200, { ok: true, activity, memory })
}

/** `POST /cloud-memory/flush`. */
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

/** Labels attached to the two tokens this plugin asks the dashboard to mint. */
const TOKEN_LABELS = {
  activity: 'DSH desktop 活动上报',
  memory: 'DSH desktop 记忆读写',
} as const

/**
 * `POST /cloud-memory/login` — sign in with the cloud account and exchange it
 * for the two scoped tokens.
 *
 * The password is used once, in memory, and never written anywhere: the flow is
 * password → short-lived session cookie → two `cmt_…` tokens → cookie dropped.
 * Only the tokens are persisted, so a later password change does not break the
 * plugin and revoking a token does not reveal the password.
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
  if (!activity.ok && !memory.ok) {
    const first = activity.ok ? memory : activity
    const reason = first.ok ? '无法创建令牌' : describeError(first.error)
    json(res, 400, { ok: false, error: `登录成功，但创建令牌失败：${reason}` })
    return
  }

  const patch: Parameters<SettingsStore['patch']>[0] = {}
  if (activity.ok && typeof activity.data.token === 'string') patch.activityToken = activity.data.token
  if (memory.ok && typeof memory.data.token === 'string') patch.memoryToken = memory.data.token
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
      warning: failed.ok ? undefined : `部分令牌没有创建成功：${describeError(failed.error)}`,
    },
  })
}

/** Build the exact-route table registered with the host web server. */
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
  ]
}
