import { describeError } from "./api.js";
/** Normalize an event timestamp (ms epoch or ISO string) into epoch ms. */
export function toEpochMs(value) {
    if (typeof value === 'number' && Number.isFinite(value)) {
        // Accept seconds as well: anything below ~2001 in ms is almost certainly seconds.
        return value < 1e11 ? Math.round(value * 1000) : Math.round(value);
    }
    if (typeof value === 'string' && value.trim() !== '') {
        const parsed = Date.parse(value);
        return Number.isNaN(parsed) ? undefined : parsed;
    }
    return undefined;
}
/**
 * Map a DSH `TurnEndReason` onto a reportable status.
 *
 * `forked` is not a real completion: the child session starts a fresh turn, and
 * counting the fork would inflate the heatmap with rounds the user never ran.
 */
export function statusForReason(reason) {
    const kind = typeof reason === 'string'
        ? reason
        : reason !== null && typeof reason === 'object'
            ? reason.kind
            : undefined;
    if (typeof kind !== 'string')
        return 'completed';
    switch (kind) {
        case 'completed':
            return 'completed';
        case 'aborted':
        case 'interrupted':
        case 'blocked':
            return 'cancelled';
        case 'error':
        case 'max-tokens':
            return 'failed';
        case 'forked':
            return null;
        default:
            return 'completed';
    }
}
/** Extract the numeric turn id from a `turn/start` or `turn/end` payload. */
function turnOf(data) {
    if (data === undefined)
        return undefined;
    const value = data.turn;
    if (typeof value === 'number' && Number.isFinite(value))
        return value;
    if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value)))
        return Number(value);
    return undefined;
}
/** Conversation (session) id, tolerating both `id` and `sessionId` shapes. */
export function conversationIdOf(session) {
    if (session === undefined)
        return undefined;
    const value = session.id ?? session.sessionId;
    return typeof value === 'string' && value !== '' ? value : undefined;
}
/**
 * Tracks open turns and reports each finished one.
 *
 * Reporting never blocks the agent loop: a failed POST is queued and retried by
 * {@link flush}, and a service outage only shows up in the status card.
 */
export class Reporter {
    options;
    startedAt = new Map();
    queue = [];
    recent = [];
    attempted = 0;
    recorded = 0;
    duplicate = 0;
    failed = 0;
    skipped = 0;
    lastSentAt;
    lastError;
    draining = false;
    constructor(options) {
        this.options = options;
    }
    /** Record a turn start so its duration can be reported later. */
    handleStart(session, event) {
        const conversationId = conversationIdOf(session);
        const turn = turnOf(event.data);
        if (conversationId === undefined || turn === undefined)
            return;
        const at = toEpochMs(event.time) ?? Date.now();
        this.startedAt.set(`${conversationId}:${turn}`, at);
        // Bound the map: a session that never ends must not leak forever.
        if (this.startedAt.size > 500) {
            const oldest = this.startedAt.keys().next();
            if (oldest.done !== true)
                this.startedAt.delete(oldest.value);
        }
    }
    /** Handle any `session/event`; only `turn/start` and `turn/end` matter here. */
    handleEvent(session, event) {
        if (event === null || typeof event !== 'object')
            return;
        if (event.type === 'turn/start') {
            this.handleStart(session, event);
            return;
        }
        if (event.type !== 'turn/end')
            return;
        this.handleEnd(session, event);
    }
    handleEnd(session, event) {
        const settings = this.options.settings();
        const conversationId = conversationIdOf(session);
        const turn = turnOf(event.data);
        if (conversationId === undefined || turn === undefined)
            return;
        const key = `${conversationId}:${turn}`;
        const completedAt = toEpochMs(event.time) ?? Date.now();
        const startedAt = this.startedAt.get(key) ?? completedAt;
        this.startedAt.delete(key);
        const reason = event.data?.reason;
        const status = statusForReason(reason);
        if (status === null) {
            this.push({ turnId: key, conversationId, status: 'cancelled', startedAt, completedAt, at: Date.now(), outcome: 'skipped', error: 'forked turn is not reported' });
            this.skipped += 1;
            return;
        }
        if (!settings.enabled) {
            this.push({ turnId: key, conversationId, status, startedAt, completedAt, at: Date.now(), outcome: 'skipped', error: 'reporting disabled' });
            this.skipped += 1;
            return;
        }
        const token = this.options.activityToken();
        if (token === '') {
            this.push({ turnId: key, conversationId, status, startedAt, completedAt, at: Date.now(), outcome: 'skipped', error: 'activity token not configured' });
            this.skipped += 1;
            return;
        }
        const payload = {
            client_id: settings.clientId,
            conversation_id: conversationId,
            turn_id: key,
            status,
            started_at: Math.min(startedAt, completedAt),
            completed_at: completedAt,
        };
        void this.send(payload);
    }
    push(record) {
        this.recent.unshift(record);
        if (this.recent.length > 50)
            this.recent.length = 50;
    }
    /** Send one payload, queueing it when the failure looks transient. */
    async send(payload) {
        this.attempted += 1;
        const token = this.options.activityToken();
        const result = await this.options.client.reportTurn(payload, token);
        const now = Date.now();
        if (result.ok) {
            const duplicate = result.data.duplicate === true || result.status === 200;
            if (duplicate)
                this.duplicate += 1;
            else
                this.recorded += 1;
            this.lastSentAt = now;
            this.push({
                turnId: payload.turn_id,
                conversationId: payload.conversation_id,
                status: payload.status,
                startedAt: payload.started_at,
                completedAt: payload.completed_at,
                at: now,
                outcome: duplicate ? 'duplicate' : 'recorded',
                httpStatus: result.status,
            });
            return;
        }
        this.lastError = describeError(result.error);
        this.failed += 1;
        this.push({
            turnId: payload.turn_id,
            conversationId: payload.conversation_id,
            status: payload.status,
            startedAt: payload.started_at,
            completedAt: payload.completed_at,
            at: now,
            outcome: 'queued',
            httpStatus: result.error.status,
            error: this.lastError,
        });
        // 4xx (other than 429) means the payload or token is wrong: retrying cannot help.
        if (result.error.status === 0 || result.error.status >= 500) {
            this.queue.push(payload);
            if (this.queue.length > 200)
                this.queue.shift();
        }
        this.options.log(`cloud-memory: turn report failed: ${this.lastError}`);
    }
    /** Retry queued reports; safe to call at any time. */
    async flush() {
        if (this.draining)
            return { sent: 0, remaining: this.queue.length };
        this.draining = true;
        let sent = 0;
        try {
            while (this.queue.length > 0) {
                const payload = this.queue[0];
                if (payload === undefined)
                    break;
                this.attempted += 1;
                const result = await this.options.client.reportTurn(payload, this.options.activityToken());
                if (!result.ok) {
                    this.lastError = describeError(result.error);
                    this.failed += 1;
                    break;
                }
                this.queue.shift();
                sent += 1;
                if (result.data.duplicate === true || result.status === 200)
                    this.duplicate += 1;
                else
                    this.recorded += 1;
                this.lastSentAt = Date.now();
            }
        }
        finally {
            this.draining = false;
        }
        return { sent, remaining: this.queue.length };
    }
    /** Counters + recent history. */
    snapshot() {
        return {
            attempted: this.attempted,
            recorded: this.recorded,
            duplicate: this.duplicate,
            failed: this.failed,
            skipped: this.skipped,
            queued: this.queue.length,
            ...(this.lastSentAt === undefined ? {} : { lastSentAt: this.lastSentAt }),
            ...(this.lastError === undefined ? {} : { lastError: this.lastError }),
            recent: [...this.recent],
        };
    }
}
