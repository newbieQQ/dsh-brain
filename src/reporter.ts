/**
 * Turn reporter: one activity record per finished conversation round.
 *
 * Contract with the cloud service (`POST /activity/turn`):
 * - exactly six fields; any extra key is rejected with 400,
 * - `started_at` / `completed_at` are epoch-millisecond integers,
 *   `completed_at >= started_at` and not more than 5 minutes in the future,
 * - `turn_id` is idempotent, so retries never double-count a round.
 *
 * Only metadata leaves the process. Prompt text and tool output are never part
 * of a report — the payload builder cannot see them.
 */
import type { CloudClient, SummaryMessage, SummaryPayload, TurnPayload } from './api.ts'
import { describeError } from './api.ts'
import type { SessionEventLike, SessionLike } from './context-types.ts'

/** The three statuses the service accepts; only `completed` feeds the heatmap. */
export type TurnStatus = 'completed' | 'failed' | 'cancelled'

/** One finished report, kept for the status card. */
export interface ReportRecord {
  turnId: string
  conversationId: string
  status: TurnStatus
  startedAt: number
  completedAt: number
  at: number
  /** `recorded` (201), `duplicate` (200), `failed`, or `queued` (waiting for retry). */
  outcome: 'recorded' | 'duplicate' | 'failed' | 'queued' | 'skipped'
  httpStatus?: number
  error?: string
}

/** Counters + recent history exposed by `GET /cloud-memory/status`. */
export interface ReporterSnapshot {
  attempted: number
  recorded: number
  duplicate: number
  failed: number
  skipped: number
  queued: number
  summaryAttempted?: number
  summaryStaged?: number
  summaryFailed?: number
  lastSummaryError?: string
  lastSentAt?: number
  lastError?: string
  recent: ReportRecord[]
}

/** Collaborators the reporter needs. */
export interface ReporterOptions {
  client: CloudClient
  /** Effective settings (never a token). */
  settings: () => { enabled: boolean; clientId: string }
  /** Activity token, or empty when unconfigured. */
  activityToken: () => string
  /** Effective summary settings (never a token). */
  summary: () => { enabled: boolean; maxChars: number }
  /** summary:write token, or empty when summaries are not configured. */
  summaryToken: () => string
  /** Log sink for operator-visible diagnostics. */
  log: (message: string) => void
}

/** Normalize an event timestamp (ms epoch or ISO string) into epoch ms. */
export function toEpochMs(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    // Accept seconds as well: anything below ~2001 in ms is almost certainly seconds.
    return value < 1e11 ? Math.round(value * 1000) : Math.round(value)
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Date.parse(value)
    return Number.isNaN(parsed) ? undefined : parsed
  }
  return undefined
}

/**
 * Map a DSH `TurnEndReason` onto a reportable status.
 *
 * `forked` is not a real completion: the child session starts a fresh turn, and
 * counting the fork would inflate the heatmap with rounds the user never ran.
 */
export function statusForReason(reason: unknown): TurnStatus | null {
  const kind = typeof reason === 'string'
    ? reason
    : reason !== null && typeof reason === 'object'
      ? (reason as { kind?: unknown }).kind
      : undefined
  if (typeof kind !== 'string') return 'completed'
  switch (kind) {
    case 'completed':
      return 'completed'
    case 'aborted':
    case 'interrupted':
    case 'blocked':
      return 'cancelled'
    case 'error':
    case 'max-tokens':
      return 'failed'
    case 'forked':
      return null
    default:
      return 'completed'
  }
}

/** Extract the numeric turn id from a `turn/start` or `turn/end` payload. */
function turnOf(data: Record<string, unknown> | undefined): number | undefined {
  if (data === undefined) return undefined
  const value = data.turn
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) return Number(value)
  return undefined
}

/** Conversation (session) id, tolerating both `id` and `sessionId` shapes. */
export function conversationIdOf(session: SessionLike | undefined): string | undefined {
  if (session === undefined) return undefined
  const value = session.id ?? session.sessionId
  return typeof value === 'string' && value !== '' ? value : undefined
}


/** Text pulled out of one `user/message` or `assistant/message` payload. */
export function textOf(value: unknown, depth = 0): string | undefined {
  if (depth > 5) return undefined
  if (typeof value === 'string') return value.trim() === '' ? undefined : value
  if (Array.isArray(value)) {
    const parts: string[] = []
    for (const item of value) {
      if (item !== null && typeof item === 'object') {
        const part = item as Record<string, unknown>
        // Tool calls/results are never summarized: they can carry files and secrets.
        if (part.type === 'tool_use' || part.type === 'tool_result' || part.type === 'image') continue
        if (part.type === 'text' && typeof part.text === 'string') {
          parts.push(part.text)
          continue
        }
      }
      const nested = textOf(item, depth + 1)
      if (nested !== undefined) parts.push(nested)
    }
    return parts.length === 0 ? undefined : parts.join('\n')
  }
  if (value === null || typeof value !== 'object') return undefined
  const record = value as Record<string, unknown>
  for (const key of ['text', 'message', 'content', 'body']) {
    const nested = textOf(record[key], depth + 1)
    if (nested !== undefined) return nested
  }
  return undefined
}

/** Local redaction: a summary must not carry credentials to the cloud. */
const REDACTIONS: [RegExp, string][] = [
  [/-----BEGIN [A-Z ]+-----[\s\S]*?-----END [A-Z ]+-----/g, '[已脱敏：私钥]'],
  [/\b(sk|ghp|gho|ghs|xox[abprs]|cmt|cmr)_[A-Za-z0-9_-]{12,}/g, '[已脱敏：令牌]'],
  [/\bBearer\s+[A-Za-z0-9._-]{16,}/gi, 'Bearer [已脱敏]'],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, '[已脱敏：JWT]'],
  [/((?:password|passwd|pwd|secret|api[_-]?key|access[_-]?token)\s*[:=]\s*)[^\s,;]{6,}/gi, '$1[已脱敏]'],
]

export function redactSecrets(text: string): string {
  let out = text
  for (const [pattern, replacement] of REDACTIONS) out = out.replace(pattern, replacement)
  return out
}

/** One buffered message, tagged with the turn it belongs to when known. */
interface BufferedMessage extends SummaryMessage {
  turn?: number
}

/**
 * Tracks open turns and reports each finished one.
 *
 * Reporting never blocks the agent loop: a failed POST is queued and retried by
 * {@link flush}, and a service outage only shows up in the status card.
 */
/** A queued report is retried at most this many times before being dropped. */
const MAX_RETRY_ATTEMPTS = 5

export class Reporter {
  private readonly startedAt = new Map<string, number>()
  private readonly queue: TurnPayload[] = []
  private readonly retries = new Map<string, number>()
  private readonly recent: ReportRecord[] = []
  private attempted = 0
  private recorded = 0
  private duplicate = 0
  private failed = 0
  private skipped = 0
  private lastSentAt: number | undefined
  private lastError: string | undefined
  private draining = false
  /** Redacted message text per conversation, consumed at turn/end. */
  private readonly transcripts = new Map<string, BufferedMessage[]>()
  private summaryAttempted = 0
  private summaryStaged = 0
  private summaryFailed = 0
  private lastSummaryError: string | undefined

  constructor(private readonly options: ReporterOptions) {}

  /** Record a turn start so its duration can be reported later. */
  handleStart(session: SessionLike | undefined, event: SessionEventLike): void {
    const conversationId = conversationIdOf(session)
    const turn = turnOf(event.data)
    if (conversationId === undefined || turn === undefined) return
    const at = toEpochMs(event.time) ?? Date.now()
    this.startedAt.set(`${conversationId}:${turn}`, at)
    // Bound the map: a session that never ends must not leak forever.
    if (this.startedAt.size > 500) {
      const oldest = this.startedAt.keys().next()
      if (oldest.done !== true) this.startedAt.delete(oldest.value)
    }
  }

  /** Handle any `session/event`; only `turn/start` and `turn/end` matter here. */
  handleEvent(session: SessionLike | undefined, event: SessionEventLike): void {
    if (event === null || typeof event !== 'object') return
    if (event.type === 'user/message' || event.type === 'assistant/message') {
      this.collect(session, event)
      return
    }
    if (event.type === 'turn/start') {
      this.handleStart(session, event)
      return
    }
    if (event.type !== 'turn/end') return
    this.handleEnd(session, event)
  }

  private handleEnd(session: SessionLike | undefined, event: SessionEventLike): void {
    const settings = this.options.settings()
    const conversationId = conversationIdOf(session)
    const turn = turnOf(event.data)
    if (conversationId === undefined || turn === undefined) return
    const key = `${conversationId}:${turn}`
    const completedAt = toEpochMs(event.time) ?? Date.now()
    const startedAt = this.startedAt.get(key) ?? completedAt
    this.startedAt.delete(key)
    const reason = event.data?.reason
    const status = statusForReason(reason)
    if (status === null) {
      this.push({ turnId: key, conversationId, status: 'cancelled', startedAt, completedAt, at: Date.now(), outcome: 'skipped', error: 'forked turn is not reported' })
      this.skipped += 1
      return
    }
    if (!settings.enabled) {
      this.push({ turnId: key, conversationId, status, startedAt, completedAt, at: Date.now(), outcome: 'skipped', error: 'reporting disabled' })
      this.skipped += 1
      return
    }
    const token = this.options.activityToken()
    if (token === '') {
      this.push({ turnId: key, conversationId, status, startedAt, completedAt, at: Date.now(), outcome: 'skipped', error: 'activity token not configured' })
      this.skipped += 1
      return
    }
    const payload: TurnPayload = {
      client_id: settings.clientId,
      conversation_id: conversationId,
      turn_id: key,
      status,
      started_at: Math.min(startedAt, completedAt),
      completed_at: completedAt,
    }
    void this.send(payload)
    void this.sendSummary(conversationId, key, status)
  }

  /** Buffer one redacted message for the turn that is still open. */
  private collect(session: SessionLike | undefined, event: SessionEventLike): void {
    const conversationId = conversationIdOf(session)
    if (conversationId === undefined) return
    const raw = textOf(event.data)
    if (raw === undefined) return
    const value = redactSecrets(raw).slice(0, 4000)
    const buffer = this.transcripts.get(conversationId) ?? []
    buffer.push({ role: event.type === 'user/message' ? 'user' : 'assistant', text: value, turn: turnOf(event.data) })
    if (buffer.length > 120) buffer.splice(0, buffer.length - 120)
    this.transcripts.set(conversationId, buffer)
  }

  /** Take this turn's messages out of the buffer, capped by the char budget. */
  private takeTranscript(conversationId: string, turnKey: string): SummaryMessage[] {
    const buffer = this.transcripts.get(conversationId) ?? []
    const turn = Number(turnKey.slice(turnKey.lastIndexOf(':') + 1))
    const picked: SummaryMessage[] = []
    const rest: BufferedMessage[] = []
    for (const item of buffer) {
      const matches = Number.isFinite(turn) && (item.turn === undefined || item.turn === turn)
      if (matches) picked.push({ role: item.role, text: item.text })
      else rest.push(item)
    }
    this.transcripts.set(conversationId, rest)
    const maxChars = Math.max(1000, this.options.summary().maxChars)
    let total = 0
    const kept: SummaryMessage[] = []
    for (const message of picked) {
      if (total + message.text.length > maxChars) break
      kept.push(message)
      total += message.text.length
    }
    return kept
  }

  /** Stage one summary; failures only surface in the status card. */
  private async sendSummary(conversationId: string, turnKey: string, status: TurnStatus): Promise<void> {
    const summary = this.options.summary()
    const token = this.options.summaryToken()
    if (!summary.enabled || token === '' || status !== 'completed') return
    const messages = this.takeTranscript(conversationId, turnKey)
    if (messages.length === 0) return
    const payload: SummaryPayload = { conversation_id: conversationId, turn_id: turnKey, messages }
    this.summaryAttempted += 1
    const result = await this.options.client.submitSummary(payload, token)
    if (result.ok) {
      this.summaryStaged += typeof result.data.staged === 'number' ? result.data.staged : 0
      return
    }
    if (result.error.status === 0 || result.error.status >= 500) {
      const retry = await this.options.client.submitSummary(payload, token)
      if (retry.ok) {
        this.summaryStaged += typeof retry.data.staged === 'number' ? retry.data.staged : 0
        return
      }
    }
    this.summaryFailed += 1
    this.lastSummaryError = describeError(result.error)
    this.options.log(`cloud-memory: turn summary failed: ${this.lastSummaryError}`)
  }

  private push(record: ReportRecord): void {
    this.recent.unshift(record)
    if (this.recent.length > 50) this.recent.length = 50
  }

  /** Send one payload, queueing it when the failure looks transient. */
  private async send(payload: TurnPayload): Promise<void> {
    this.attempted += 1
    const token = this.options.activityToken()
    const result = await this.options.client.reportTurn(payload, token)
    const now = Date.now()
    if (result.ok) {
      const duplicate = result.data.duplicate === true || result.status === 200
      if (duplicate) this.duplicate += 1
      else this.recorded += 1
      this.retries.delete(payload.turn_id)
      this.lastSentAt = now
      this.push({
        turnId: payload.turn_id,
        conversationId: payload.conversation_id,
        status: payload.status,
        startedAt: payload.started_at,
        completedAt: payload.completed_at,
        at: now,
        outcome: duplicate ? 'duplicate' : 'recorded',
        httpStatus: result.status,
      })
      return
    }
    this.lastError = describeError(result.error)
    this.failed += 1
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
    })
    // 4xx (other than 429) means the payload or token is wrong: retrying cannot help.
    if (result.error.status === 0 || result.error.status >= 500) {
      this.queue.push(payload)
      if (this.queue.length > 200) this.queue.shift()
    }
    this.options.log(`cloud-memory: turn report failed: ${this.lastError}`)
  }

  /** Retry queued reports; safe to call at any time. */
  async flush(): Promise<{ sent: number; remaining: number }> {
    if (this.draining) return { sent: 0, remaining: this.queue.length }
    this.draining = true
    let sent = 0
    try {
      while (this.queue.length > 0) {
        const payload = this.queue[0]
        if (payload === undefined) break
        this.attempted += 1
        const result = await this.options.client.reportTurn(payload, this.options.activityToken())
        if (!result.ok) {
          this.lastError = describeError(result.error)
          this.failed += 1
          const attempt = (this.retries.get(payload.turn_id) ?? 0) + 1
          if (attempt >= MAX_RETRY_ATTEMPTS) {
            // Give up on this turn: a permanently failing endpoint must not keep
            // an unbounded queue of metadata forever.
            this.queue.shift()
            this.retries.delete(payload.turn_id)
            this.options.log(`cloud-memory: dropping turn report after ${attempt} attempts: ${this.lastError}`)
            continue
          }
          this.retries.set(payload.turn_id, attempt)
          break
        }
        this.queue.shift()
        this.retries.delete(payload.turn_id)
        sent += 1
        if (result.data.duplicate === true || result.status === 200) this.duplicate += 1
        else this.recorded += 1
        this.lastSentAt = Date.now()
      }
    } finally {
      this.draining = false
    }
    return { sent, remaining: this.queue.length }
  }

  /** Counters + recent history. */
  snapshot(): ReporterSnapshot {
    return {
      attempted: this.attempted,
      recorded: this.recorded,
      duplicate: this.duplicate,
      failed: this.failed,
      skipped: this.skipped,
      queued: this.queue.length,
      summaryAttempted: this.summaryAttempted,
      summaryStaged: this.summaryStaged,
      summaryFailed: this.summaryFailed,
      ...(this.lastSummaryError === undefined ? {} : { lastSummaryError: this.lastSummaryError }),
      ...(this.lastSentAt === undefined ? {} : { lastSentAt: this.lastSentAt }),
      ...(this.lastError === undefined ? {} : { lastError: this.lastError }),
      recent: [...this.recent],
    }
  }
}
