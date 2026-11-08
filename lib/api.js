/**
 * Derive the dashboard auth root (`/api/auth`) from the memory base URL
 * (`.../api/longmemory`): login and token minting live one segment over.
 */
function authBase(baseUrl) {
    try {
        const url = new URL(baseUrl);
        const prefix = url.pathname.replace(/\/longmemory\/?$/i, '');
        return `${url.origin}${prefix}/auth`;
    }
    catch {
        return '';
    }
}
/** True when sending a password to this URL is safe (TLS, or loopback). */
export function isSecureLoginTarget(baseUrl) {
    try {
        const url = new URL(baseUrl);
        if (url.protocol === 'https:')
            return true;
        return url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
    }
    catch {
        return false;
    }
}
/** Pull the first cookie pair out of one or more Set-Cookie headers. */
function sessionCookieOf(headers) {
    // `getSetCookie` exists on undici/Node 18.14+ but is not in every Headers type.
    const withCookies = headers;
    const list = typeof withCookies.getSetCookie === 'function' ? withCookies.getSetCookie() : [headers.get('set-cookie') ?? ''];
    for (const entry of list) {
        if (entry === '')
            continue;
        const pair = entry.split(';', 1)[0];
        if (pair !== undefined && pair.includes('=') && !pair.startsWith('='))
            return pair.trim();
    }
    return '';
}
/** Map one HTTP error body onto a {@link CloudError}. */
function errorFromBody(status, raw, retryAfterHeader) {
    let code = `http_${status}`;
    let message = raw.slice(0, 300);
    try {
        const parsed = JSON.parse(raw);
        if (parsed !== null && typeof parsed === 'object') {
            const body = parsed;
            if (typeof body.error === 'string')
                code = body.error;
            else if (body.error !== null && typeof body.error === 'object') {
                const nested = body.error;
                if (typeof nested.code === 'string')
                    code = nested.code;
                if (typeof nested.message === 'string')
                    message = nested.message;
            }
            if (typeof body.message === 'string')
                message = body.message;
        }
    }
    catch {
        // Non-JSON error (proxy HTML page, empty body): keep the text snippet.
    }
    const error = { status, code, message: message === '' ? code : message };
    if (status === 429) {
        const header = retryAfterHeader === null ? Number.NaN : Number(retryAfterHeader);
        error.retryAfterMs = Number.isFinite(header) && header > 0 ? header * 1000 : 900_000;
    }
    return error;
}
/**
 * One cloud endpoint handle. Instances are cheap: construct per call site and
 * keep the live settings behind closures so a settings edit applies at once.
 */
export class CloudClient {
    options;
    constructor(options) {
        this.options = options;
    }
    async request(method, path, body, tokenOverride) {
        const token = tokenOverride ?? this.options.token();
        const base = this.options.baseUrl();
        const url = `${base}${path}`;
        const headers = { Accept: 'application/json' };
        if (token !== '')
            headers.Authorization = `Bearer ${token}`;
        const init = { method, headers, signal: AbortSignal.timeout(this.options.timeoutMs()) };
        if (body !== undefined) {
            headers['Content-Type'] = 'application/json';
            init.body = JSON.stringify(body);
        }
        let response;
        try {
            response = await fetch(url, init);
        }
        catch (error) {
            const reason = error instanceof Error ? error.message : String(error);
            return { ok: false, error: { status: 0, code: 'network_error', message: `${method} ${path}: ${reason}` } };
        }
        const text = await response.text().catch(() => '');
        if (!response.ok) {
            return { ok: false, error: errorFromBody(response.status, text, response.headers.get('retry-after')) };
        }
        if (text.trim() === '')
            return { ok: true, status: response.status, data: {} };
        try {
            return { ok: true, status: response.status, data: JSON.parse(text) };
        }
        catch {
            return { ok: false, error: { status: response.status, code: 'invalid_json', message: 'response was not JSON' } };
        }
    }
    /** Report one conversation turn (activity:write token). */
    reportTurn(payload, token) {
        return this.request('POST', '/activity/turn', payload, token);
    }
    /** Stage one turn summary as pending proposals (summary:write token). */
    submitSummary(payload, token) {
        return this.request('POST', '/activity/summary', payload, token);
    }
    /**
     * Verify a summary token without staging anything.
     *
     * The endpoint authenticates before it validates the body, so an empty
     * object coming back `400 invalid_input` proves the scope is right.
     */
    async probeSummary(token) {
        const result = await this.request('POST', '/activity/summary', {}, token);
        if (result.ok)
            return { ok: true, status: result.status, data: { authenticated: true } };
        if (result.error.status === 400)
            return { ok: true, status: 400, data: { authenticated: true } };
        return { ok: false, error: result.error };
    }
    /**
     * Verify an activity token without recording anything.
     *
     * `/activity/turn` validates auth before the payload, so an empty body that
     * comes back `400 invalid_event` proves the token carries `activity:write`.
     * A 401/403 is a token problem; anything else is reported verbatim.
     */
    async probeActivity(token) {
        const result = await this.request('POST', '/activity/turn', {}, token);
        if (result.ok)
            return { ok: true, status: result.status, data: { authenticated: true } };
        // 400 means the credentials were accepted and only the body was rejected.
        if (result.error.status === 400) {
            return { ok: true, status: 400, data: { authenticated: true } };
        }
        return { ok: false, error: result.error };
    }
    /** Keyword search over stored memories (memory token). */
    async search(query, k, project) {
        const body = { query, k };
        if (project !== undefined && project !== '')
            body.filters = { project_id: project };
        return this.request('POST', '/memory/query', body);
    }
    /** Read one memory by id (memory token). */
    read(id) {
        return this.request('GET', `/memory/${encodeURIComponent(id)}`);
    }
    /** List memories with optional paging filters (memory token). */
    list(options = {}) {
        const params = new URLSearchParams();
        if (options.limit !== undefined)
            params.set('limit', String(options.limit));
        if (options.offset !== undefined)
            params.set('offset', String(options.offset));
        if (options.project !== undefined && options.project !== '')
            params.set('project_id', options.project);
        const suffix = params.toString() === '' ? '' : `?${params.toString()}`;
        return this.request('GET', `/memory/all${suffix}`);
    }
    /** Store one memory; `operationId` makes the write idempotent (memory token). */
    add(input) {
        const body = {
            operation_id: input.operationId,
            content: input.content,
        };
        if (input.tags !== undefined && input.tags.length > 0)
            body.tags = input.tags;
        if (input.project !== undefined && input.project !== '')
            body.project_id = input.project;
        if (input.sector !== undefined && input.sector !== '')
            body.metadata = { primary_sector: input.sector };
        return this.request('POST', '/memory/add', body);
    }
    /** List the account's projects (memory token). */
    projects() {
        return this.request('GET', '/dashboard/projects');
    }
    /** Storage configuration state (memory token). */
    storageStatus() {
        return this.request('GET', '/storage/status');
    }
    /**
     * One call against the dashboard auth surface (`/api/auth/*`).
     *
     * These endpoints authorize by session cookie, not by Bearer token, and they
     * reject any non-GET without a matching `Origin` (the server's CSRF gate), so
     * the origin of the configured base URL is sent explicitly — that is a header
     * only a non-browser client can set, which is exactly what this is.
     */
    async authFetch(method, path, body, cookie) {
        const baseUrl = this.options.baseUrl();
        const base = authBase(baseUrl);
        if (base === '')
            return { ok: false, error: { status: 0, code: 'invalid_base_url', message: '服务地址无效，无法登录' } };
        const headers = { Accept: 'application/json' };
        try {
            headers.Origin = new URL(baseUrl).origin;
        }
        catch {
            return { ok: false, error: { status: 0, code: 'invalid_base_url', message: '服务地址无效，无法登录' } };
        }
        if (cookie !== undefined && cookie !== '')
            headers.Cookie = cookie;
        const init = { method, headers, signal: AbortSignal.timeout(this.options.timeoutMs()) };
        if (body !== undefined) {
            headers['Content-Type'] = 'application/json';
            init.body = JSON.stringify(body);
        }
        let response;
        try {
            response = await fetch(`${base}${path}`, init);
        }
        catch (error) {
            const reason = error instanceof Error ? error.message : String(error);
            return { ok: false, error: { status: 0, code: 'network_error', message: `${method} /auth${path}: ${reason}` } };
        }
        const text = await response.text().catch(() => '');
        if (!response.ok) {
            return { ok: false, error: errorFromBody(response.status, text, response.headers.get('retry-after')) };
        }
        let parsed = {};
        if (text.trim() !== '') {
            try {
                parsed = JSON.parse(text);
            }
            catch {
                parsed = {};
            }
        }
        return { ok: true, status: response.status, body: parsed, headers: response.headers };
    }
    /**
     * Password login against the dashboard.
     *
     * The password is used once, in this call, and never stored: what comes back
     * is a short-lived session cookie that the caller immediately spends on
     * {@link CloudClient.mintToken} and then drops.
     */
    async login(username, password) {
        const sent = await this.authFetch('POST', '/login', { username, password });
        if (!sent.ok)
            return sent;
        const cookie = sessionCookieOf(sent.headers);
        if (cookie === '') {
            return { ok: false, error: { status: sent.status, code: 'no_session', message: '登录成功，但服务端没有下发会话' } };
        }
        const body = sent.body;
        return { ok: true, status: sent.status, data: { user: body.user ?? {}, sessionCookie: cookie } };
    }
    /** Mint one scoped API token using a live session cookie. */
    async mintToken(sessionCookie, scope, label) {
        const sent = await this.authFetch('POST', '/tokens', { scope, label }, sessionCookie);
        if (!sent.ok)
            return sent;
        const body = sent.body;
        const issued = body.token;
        if (issued === undefined || typeof issued.token !== 'string' || issued.token === '') {
            return { ok: false, error: { status: sent.status, code: 'no_token', message: '服务端没有返回令牌' } };
        }
        return { ok: true, status: sent.status, data: issued };
    }
}
/** Render a {@link CloudError} as one display line. */
export function describeError(error) {
    if (error.status === 0)
        return `网络不可用：${error.message}`;
    return `HTTP ${error.status} ${error.code}：${error.message}`;
}
