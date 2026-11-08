import { describeError, isSecureLoginTarget } from "./api.js";
import { renderConfigPage } from "./page.js";
/** Route constants — kept in one place so the client half can reuse them. */
export const ROUTES = {
    page: '/cloud-memory',
    status: '/cloud-memory/status',
    config: '/cloud-memory/config',
    login: '/cloud-memory/login',
    test: '/cloud-memory/test',
    flush: '/cloud-memory/flush',
};
/** Largest request body we accept (a settings patch is tiny). */
const MAX_BODY_BYTES = 64 * 1024;
/** Collect a request body as UTF-8 text. */
async function readBody(req, maxBytes = MAX_BODY_BYTES) {
    const chunks = [];
    let bytes = 0;
    for await (const chunk of req) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        bytes += buffer.byteLength;
        if (bytes > maxBytes)
            throw new Error('request-too-large');
        chunks.push(buffer);
    }
    return Buffer.concat(chunks).toString('utf8');
}
/** Reject cross-origin browser writes. */
function sameOrigin(req) {
    const origin = req.headers.origin;
    const host = req.headers.host;
    if (origin === undefined || host === undefined)
        return true;
    return origin === `http://${host}` || origin === `https://${host}`;
}
/** Emit one JSON response with no caching. */
function json(res, status, body) {
    const text = JSON.stringify(body);
    res.writeHead(status, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
        'content-length': Buffer.byteLength(text),
    });
    res.end(text);
}
/** Emit a plain-text error (page route) or JSON error (API routes). */
function fail(res, status, message, asHtml = false) {
    const text = asHtml
        ? `<!doctype html><meta charset="utf-8"><title>云端记忆</title><body style="font:14px system-ui;padding:32px">${message}</body>`
        : JSON.stringify({ ok: false, error: message });
    res.writeHead(status, {
        'content-type': asHtml ? 'text/html; charset=utf-8' : 'application/json; charset=utf-8',
        'cache-control': 'no-store',
    });
    res.end(text);
}
/** The payload the page and the client card both consume. */
function statusPayload(deps) {
    const view = deps.store.describe();
    const tokens = {
        activity: view.activityToken,
        memory: view.memoryToken,
        summary: view.summaryToken,
    };
    const settings = {
        enabled: view.enabled,
        baseUrl: view.baseUrl,
        clientId: view.clientId,
        requestTimeoutMs: view.requestTimeoutMs,
        defaultK: view.defaultK,
        summaryEnabled: view.summaryEnabled,
        summaryMaxChars: view.summaryMaxChars,
    };
    return { ok: true, settings, tokens, settingsPath: view.statePath, reporter: deps.reporter.snapshot() };
}
/** Serve the configuration page. */
function servePage(deps, req, res) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
        fail(res, 405, 'method-not-allowed', true);
        return;
    }
    const html = renderConfigPage({ version: deps.version, settingsPath: deps.store.path });
    res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
        'content-length': Buffer.byteLength(html),
    });
    if (req.method === 'HEAD')
        res.end();
    else
        res.end(html);
}
/** `GET /cloud-memory/status`. */
function serveStatus(deps, req, res) {
    if (req.method !== 'GET') {
        fail(res, 405, 'method-not-allowed');
        return;
    }
    json(res, 200, statusPayload(deps));
}
/** `PUT /cloud-memory/config`. */
async function serveConfig(deps, req, res) {
    if (req.method !== 'PUT' && req.method !== 'POST') {
        fail(res, 405, 'method-not-allowed');
        return;
    }
    if (!sameOrigin(req)) {
        fail(res, 403, 'origin-rejected');
        return;
    }
    const type = (req.headers['content-type'] ?? '').toLowerCase();
    if (!type.startsWith('application/json')) {
        fail(res, 415, 'json-required');
        return;
    }
    let patch;
    try {
        patch = JSON.parse(await readBody(req));
    }
    catch (error) {
        fail(res, 400, error instanceof Error && error.message === 'request-too-large' ? 'request-too-large' : 'invalid-json');
        return;
    }
    if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) {
        fail(res, 400, 'invalid-patch');
        return;
    }
    const result = deps.store.patch(patch);
    if (!result.ok) {
        fail(res, 400, result.error ?? 'invalid-patch');
        return;
    }
    json(res, 200, statusPayload(deps));
}
/** `POST /cloud-memory/test` — validate both tokens without recording anything. */
async function serveTest(deps, req, res) {
    if (req.method !== 'POST') {
        fail(res, 405, 'method-not-allowed');
        return;
    }
    if (!sameOrigin(req)) {
        fail(res, 403, 'origin-rejected');
        return;
    }
    const client = deps.client();
    const activityToken = deps.store.activityToken();
    const memoryToken = deps.store.memoryToken();
    const activity = activityToken === ''
        ? { ok: false, message: '还没填令牌：把 activity:write 密钥粘到下面「活动上报令牌」再点保存' }
        : await (async () => {
            const probe = await client.probeActivity(activityToken);
            return probe.ok
                ? { ok: true, message: '令牌有效（鉴权通过）' }
                : { ok: false, message: describeError(probe.error) };
        })();
    const memory = memoryToken === ''
        ? { ok: false, message: '还没填令牌：把 memory:write 密钥粘到下面「记忆读写令牌」再点保存' }
        : await (async () => {
            const probe = await client.projects();
            return probe.ok
                ? { ok: true, message: `令牌有效（${(probe.data.projects ?? []).length} 个项目）` }
                : { ok: false, message: describeError(probe.error) };
        })();
    const summaryToken = deps.store.summaryToken();
    const summary = !deps.store.settings().summaryEnabled
        ? { ok: false, message: '自动摘要已关闭（可在下方勾选开启）' }
        : summaryToken === ''
            ? { ok: false, message: '未配置摘要令牌：留空则不做自动摘要' }
            : await (async () => {
                const probe = await client.probeSummary(summaryToken);
                return probe.ok
                    ? { ok: true, message: '摘要令牌有效（只进待确认队列）' }
                    : { ok: false, message: describeError(probe.error) };
            })();
    json(res, 200, { ok: true, activity, memory, summary });
}
/** `POST /cloud-memory/flush`. */
async function serveFlush(deps, req, res) {
    if (req.method !== 'POST') {
        fail(res, 405, 'method-not-allowed');
        return;
    }
    if (!sameOrigin(req)) {
        fail(res, 403, 'origin-rejected');
        return;
    }
    const result = await deps.reporter.flush();
    json(res, 200, { ok: true, ...result });
}
/** Labels attached to the two tokens this plugin asks the dashboard to mint. */
const TOKEN_LABELS = {
    activity: 'DSH desktop 活动上报',
    memory: 'DSH desktop 记忆读写',
    summary: 'DSH desktop 对话摘要',
};
/**
 * `POST /cloud-memory/login` — sign in with the cloud account and exchange it
 * for the two scoped tokens.
 *
 * The password is used once, in memory, and never written anywhere: the flow is
 * password → short-lived session cookie → two `cmt_…` tokens → cookie dropped.
 * Only the tokens are persisted, so a later password change does not break the
 * plugin and revoking a token does not reveal the password.
 */
async function serveLogin(deps, req, res) {
    if (req.method !== 'POST') {
        fail(res, 405, 'method-not-allowed');
        return;
    }
    if (!sameOrigin(req)) {
        fail(res, 403, 'origin-rejected');
        return;
    }
    const target = deps.store.settings().baseUrl;
    if (!isSecureLoginTarget(target)) {
        // Refuse to put a password on a plaintext channel that is not loopback.
        json(res, 400, { ok: false, error: '服务地址不是 HTTPS，拒绝在上面发送密码，请先把服务地址改成 https://' });
        return;
    }
    let raw;
    try {
        raw = await readBody(req);
    }
    catch {
        fail(res, 413, 'request-too-large');
        return;
    }
    let body;
    try {
        const parsed = JSON.parse(raw);
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed))
            throw new Error('object required');
        body = parsed;
    }
    catch {
        fail(res, 400, 'invalid-json');
        return;
    }
    const username = typeof body.username === 'string' ? body.username.trim() : '';
    const password = typeof body.password === 'string' ? body.password : '';
    if (username === '' || password === '') {
        json(res, 400, { ok: false, error: '请填写用户名和密码' });
        return;
    }
    if (username.length > 64 || password.length > 256) {
        json(res, 400, { ok: false, error: '用户名或密码过长' });
        return;
    }
    const client = deps.client();
    const session = await client.login(username, password);
    if (!session.ok) {
        const status = session.error.status === 429 ? 429 : 401;
        json(res, status, { ok: false, error: describeError(session.error) });
        return;
    }
    const activity = await client.mintToken(session.data.sessionCookie, 'activity:write', TOKEN_LABELS.activity);
    const memory = await client.mintToken(session.data.sessionCookie, 'memory:write', TOKEN_LABELS.memory);
    const summary = await client.mintToken(session.data.sessionCookie, 'summary:write', TOKEN_LABELS.summary);
    if (!activity.ok && !memory.ok) {
        const first = activity.ok ? memory : activity;
        const reason = first.ok ? '无法创建令牌' : describeError(first.error);
        json(res, 400, { ok: false, error: `登录成功，但创建令牌失败：${reason}` });
        return;
    }
    const patch = {};
    if (activity.ok && typeof activity.data.token === 'string')
        patch.activityToken = activity.data.token;
    if (memory.ok && typeof memory.data.token === 'string')
        patch.memoryToken = memory.data.token;
    if (summary.ok && typeof summary.data.token === 'string')
        patch.summaryToken = summary.data.token;
    const applied = deps.store.patch(patch);
    if (!applied.ok) {
        json(res, 500, { ok: false, error: applied.error });
        return;
    }
    const failed = activity.ok ? memory : activity;
    const partial = !activity.ok || !memory.ok;
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
    });
}
/** Build the exact-route table registered with the host web server. */
export function createRoutes(deps) {
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
    ];
}
