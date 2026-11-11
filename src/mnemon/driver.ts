/**
 * LongMemory driver for Mnemon's Memory Spaces.
 *
 * Design rule (the whole point of this bridge): the cloud service is the
 * source of truth. Every search/list/read/write is a live call to the
 * user's own LongMemory endpoint — this driver keeps NO local replica of
 * long-term memory, so anything another tool (Claude Code, Codex, the
 * dashboard) wrote into LongMemory is visible inside DSH immediately.
 *
 * Connection resolution, per call:
 *   1. the Mnemon connection for the space (service fields configured on
 *      the Mnemon page, plus the space's own `projectId`),
 *   2. this package's own settings sidecar (`$DSH_HOME/dsh-brain.json`)
 *      for any of endpoint/token the Mnemon side left empty — so a user
 *      who already configured dsh-brain configures nothing twice.
 *
 * A Memory Space maps to one LongMemory project; the empty project is the
 * account-wide default scope.
 */
import { randomUUID } from 'node:crypto'
import type {
  Insight,
  JsonValue,
  MemoryGraphSnapshot,
  MemoryListRequest,
  MemoryProviderAdapter,
  MemoryProviderConnection,
  MemorySpace,
  MemorySpaceAuthority,
  ProviderMemorySpace,
  ProviderSearchResult,
  ProviderSpaceStatus,
  RememberRequest,
  SearchRequest,
} from 'dsh-mnemon-source-memory-spaces/provider-sdk'
import { CloudClient, type MemoryHit } from '../api.ts'
import { SettingsStore } from '../store.ts'
import { descriptor } from './descriptor.ts'

/** Options handed over by the provider factory. */
export interface LongMemoryProviderOptions {
  /** Per-request timeout from the Memory Spaces host config. */
  requestTimeoutMs?: number
}

/** One fully-resolved connection: everything a call needs. */
interface ResolvedConnection {
  endpoint: string
  header: string
  project?: string
}

/** Epoch (ms, or seconds on older payloads) → ISO string, when plausible. */
function toIso(value: unknown): string | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return undefined
  const ms = value < 1e12 ? value * 1000 : value
  const date = new Date(ms)
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString()
}

/** Map one LongMemory hit onto a Mnemon Insight; unusable hits drop out. */
export function insightFromHit(hit: MemoryHit): Insight | undefined {
  if (typeof hit.id !== 'string' || hit.id === '') return undefined
  if (typeof hit.content !== 'string') return undefined
  const insight: Insight = { id: hit.id, content: hit.content, source: 'external' }
  if (typeof hit.primary_sector === 'string' && hit.primary_sector !== '') {
    insight.category = hit.primary_sector
  }
  if (Array.isArray(hit.tags)) {
    const tags = hit.tags.filter((tag): tag is string => typeof tag === 'string')
    if (tags.length > 0) insight.tags = tags
  }
  const createdAt = toIso(hit.created_at)
  if (createdAt !== undefined) insight.createdAt = createdAt
  const score = (hit as Record<string, unknown>).score
  if (typeof score === 'number' && Number.isFinite(score)) insight.score = score
  return insight
}

export class LongMemoryProvider implements MemoryProviderAdapter {
  readonly id = descriptor.id
  /** LongMemory scores are its own scale; the host may only order by them. */
  readonly scoreSemantics = { kind: 'provider-native' } as const

  private store: SettingsStore | undefined

  constructor(
    private readonly authority: MemorySpaceAuthority | undefined,
    private readonly options: LongMemoryProviderOptions = {},
  ) {}

  /** This package's settings sidecar, read lazily so edits apply live. */
  private settings(): SettingsStore {
    this.store ??= new SettingsStore({})
    return this.store
  }

  /**
   * Merge the space's Mnemon connection over the package settings.
   * The authority is the source of merged service+space values; the space
   * record itself is the fallback for older hosts.
   */
  private resolve(body?: MemorySpace, direct?: MemoryProviderConnection): ResolvedConnection {
    let connection: MemoryProviderConnection = { ...(direct ?? {}) }
    if (body !== undefined) {
      if (this.authority !== undefined) {
        try {
          connection = { ...this.authority.providerConnection(body.id, descriptor.id), ...connection }
        } catch {
          // Host could not resolve it; fall through to the space record.
        }
      }
      const own = (body as { connection?: unknown }).connection
      if (own !== null && typeof own === 'object' && !Array.isArray(own)) {
        connection = { ...(own as MemoryProviderConnection), ...connection }
      }
    }
    const settings = this.settings().settings()
    const endpointRaw = typeof connection.endpoint === 'string' && connection.endpoint !== ''
      ? connection.endpoint
      : settings.baseUrl
    const token = typeof connection.token === 'string' && connection.token !== ''
      ? connection.token
      : this.settings().memoryToken()
    const project = typeof connection.projectId === 'string' && connection.projectId !== ''
      ? connection.projectId
      : undefined
    return { endpoint: endpointRaw.replace(/\/+$/, ''), header: token, ...(project === undefined ? {} : { project }) }
  }

  /** A client bound to one resolved connection (clients here are cheap). */
  private client(resolved: ResolvedConnection): CloudClient {
    return new CloudClient({
      baseUrl: () => resolved.endpoint,
      token: () => resolved.header,
      timeoutMs: () => this.options.requestTimeoutMs ?? this.settings().settings().requestTimeoutMs,
    })
  }

  /** Enumerate the account's projects as Memory Spaces, plus the default scope. */
  async discover(connection: MemoryProviderConnection, signal?: AbortSignal): Promise<ProviderMemorySpace[]> {
    signal?.throwIfAborted()
    const resolved = this.resolve(undefined, connection)
    const result = await this.client(resolved).projects()
    if (!result.ok) {
      throw new Error(`LongMemory project discovery failed: ${result.error.message}`)
    }
    const spaces: ProviderMemorySpace[] = [{
      externalId: 'default',
      name: 'LongMemory · 全部',
      description: 'Account-wide default scope (no project filter).',
      connection: {},
    }]
    for (const project of result.data.projects ?? []) {
      if (typeof project.id !== 'string' || project.id === '') continue
      spaces.push({
        externalId: `project:${project.id}`,
        name: typeof project.name === 'string' && project.name !== '' ? project.name : project.id,
        description: 'LongMemory project',
        connection: { projectId: project.id },
      })
    }
    return spaces
  }

  /** Health = the service answers its storage status endpoint. */
  async status(body: MemorySpace, signal?: AbortSignal): Promise<ProviderSpaceStatus> {
    signal?.throwIfAborted()
    const resolved = this.resolve(body)
    if (resolved.header === '') {
      return { healthy: false, error: 'LongMemory memory token is not configured' }
    }
    const result = await this.client(resolved).storageStatus()
    return result.ok
      ? { healthy: true }
      : { healthy: false, error: result.error.message }
  }

  /** Live pass-through search — this is the recall path for every turn. */
  async search(body: MemorySpace, request: SearchRequest, signal?: AbortSignal): Promise<ProviderSearchResult> {
    signal?.throwIfAborted()
    const resolved = this.resolve(body)
    const limit = Math.min(Math.max(request.limit ?? 10, 1), 100)
    const result = await this.client(resolved).search(request.query, limit, resolved.project)
    if (!result.ok) {
      throw new Error(`LongMemory search failed: ${result.error.message}`)
    }
    return {
      results: (result.data.matches ?? [])
        .map(insightFromHit)
        .filter((item): item is Insight => item !== undefined),
    }
  }

  /** Browse the space; a query, when given, defers to live search. */
  async list(body: MemorySpace, request: MemoryListRequest, signal?: AbortSignal): Promise<Insight[]> {
    signal?.throwIfAborted()
    if (request.query !== undefined && request.query !== '') {
      const found = await this.search(body, { query: request.query, limit: request.limit ?? 100 }, signal)
      return found.results
    }
    const resolved = this.resolve(body)
    const limit = Math.min(Math.max(request.limit ?? 100, 1), 200)
    const result = await this.client(resolved).list({ limit, project: resolved.project })
    if (!result.ok) {
      throw new Error(`LongMemory list failed: ${result.error.message}`)
    }
    return (result.data.items ?? [])
      .map(insightFromHit)
      .filter((item): item is Insight => item !== undefined)
  }

  /** Store one memory straight into the cloud store — no local staging. */
  async remember(body: MemorySpace, request: RememberRequest, signal?: AbortSignal): Promise<JsonValue> {
    signal?.throwIfAborted()
    const resolved = this.resolve(body)
    const result = await this.client(resolved).add({
      content: request.content,
      ...(request.tags === undefined ? {} : { tags: request.tags }),
      ...(resolved.project === undefined ? {} : { project: resolved.project }),
      ...(request.category === undefined ? {} : { sector: request.category }),
      operationId: `mnemon-${randomUUID()}`,
    })
    if (!result.ok) {
      throw new Error(`LongMemory remember failed: ${result.error.message}`)
    }
    return {
      action: 'stored',
      provider: this.id,
      summary: 'Stored in LongMemory (live).',
      ...(result.data.id === undefined ? {} : { id: result.data.id }),
      ...(result.data.revision === undefined ? {} : { revision: result.data.revision }),
    }
  }

  /** Exact read of one memory by id. */
  async get(body: MemorySpace, id: string, signal?: AbortSignal): Promise<Insight | undefined> {
    signal?.throwIfAborted()
    const resolved = this.resolve(body)
    const result = await this.client(resolved).read(id)
    if (!result.ok) return undefined
    return insightFromHit(result.data)
  }

  /**
   * LongMemory's associations live server-side and this API exposes no
   * graph read, so the honest v1 answer is an empty snapshot; the
   * descriptor declares the graph capability off to match.
   */
  async graph(body: MemorySpace, signal?: AbortSignal): Promise<MemoryGraphSnapshot> {
    signal?.throwIfAborted()
    void body
    return { nodes: [], edges: [], generatedAt: new Date().toISOString() }
  }
}
