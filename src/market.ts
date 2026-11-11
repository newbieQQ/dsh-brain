/**
 * Skill market providers (P3).
 *
 * A provider answers `search` / `getDetail` / `resolveArtifact` for ONE
 * configured, verified source. The browser half never passes a repository URL:
 * it only names a provider id and an entry id, so no request can make the host
 * fetch an arbitrary address or clone an arbitrary repository.
 *
 * First provider: the Claude Code plugin marketplace manifest that lives at
 * `.claude-plugin/marketplace.json` in a public GitHub repository. That format
 * lists plugins, each with a description and the relative folders of the skills
 * it ships. Installing an entry reuses the same staged plan/commit pipeline as
 * a manual git install, pinned to the commit resolved here.
 */
import { parseSkillFrontmatter } from './skill-sync.ts'

/** One provider as the card lists it (no credentials, no local paths). */
export interface MarketProviderInfo {
  id: string
  label: string
  description: string
  /** `owner/repo` the manifest is read from. */
  source: string
  homepage: string
}

/** One normalized marketplace entry. */
export interface MarketEntry {
  id: string
  providerId: string
  name: string
  description: string
  version?: string
  author?: string
  /** Skill folder names (basename of each skill path). */
  skills: string[]
  /** Relative paths as written in the manifest, e.g. `./skills/xlsx`. */
  skillPaths: string[]
  sourceRepo: string
  sourceUrl: string
}

/** Detail adds per-skill metadata read from each SKILL.md (best effort). */
export interface MarketDetail extends MarketEntry {
  skillDetails: { folder: string; path: string; name?: string; description?: string; ok: boolean }[]
  fetchedAt: number
}

/** What an install plan needs to clone a pinned artifact. */
export interface MarketArtifact {
  repoUrl: string
  /** A ref git can fetch (branch, tag or commit SHA). */
  ref: string
  /** Resolved commit SHA when the host could look it up. */
  commit?: string
  version?: string
  folders: string[]
}

export interface MarketProvider {
  info(): MarketProviderInfo
  search(query: string, cursor: number): Promise<{ entries: MarketEntry[]; nextCursor?: number }>
  getDetail(entryId: string): Promise<MarketDetail>
  resolveArtifact(entryId: string, version?: string): Promise<MarketArtifact>
}

/** Typed failure so routes can map it to a status code. */
export class MarketError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message)
    this.name = 'MarketError'
  }
}

/** Row shape of `.claude-plugin/marketplace.json`. */
interface MarketplaceManifest {
  name?: string
  owner?: { name?: string }
  metadata?: { version?: string; description?: string }
  plugins?: {
    name?: string
    description?: string
    source?: string
    skills?: string[]
  }[]
}

/** Normalize a manifest skill path to a folder name (its basename). */
function folderOf(skillPath: string): string {
  const trimmed = skillPath.replace(/^\.\//, '').replace(/\/+$/, '')
  const parts = trimmed.split('/')
  return parts[parts.length - 1] ?? trimmed
}

/** Small TTL cache so one search + one detail does not refetch the manifest. */
interface CacheEntry {
  at: number
  value: unknown
}

/** Provider over a Claude Code plugin marketplace manifest on GitHub. */
export class ClaudePluginMarketplaceProvider implements MarketProvider {
  private readonly cache = new Map<string, CacheEntry>()
  private readonly fetchImpl: typeof fetch

  constructor(
    private readonly options: {
      id: string
      label: string
      description: string
      repo: string
      ref?: string
      homepage?: string
      timeoutMs?: number
      fetchImpl?: typeof fetch
    },
  ) {
    this.fetchImpl = options.fetchImpl ?? fetch
  }

  info(): MarketProviderInfo {
    return {
      id: this.options.id,
      label: this.options.label,
      description: this.options.description,
      source: this.options.repo,
      homepage: this.options.homepage ?? `https://github.com/${this.options.repo}`,
    }
  }

  private ref(): string {
    return this.options.ref ?? 'main'
  }

  private timeoutMs(): number {
    return this.options.timeoutMs ?? 8000
  }

  private rawUrl(path: string): string {
    const clean = path.replace(/^\.\//, '')
    return `https://raw.githubusercontent.com/${this.options.repo}/${encodeURIComponent(this.ref())}/${clean}`
  }

  private async fetchText(url: string): Promise<string> {
    let response: Response
    try {
      response = await this.fetchImpl(url, {
        headers: { accept: 'application/json, text/plain, */*', 'user-agent': 'dsh-brain-market' },
        signal: AbortSignal.timeout(this.timeoutMs()),
      })
    } catch (error) {
      throw new MarketError('unreachable', `市场来源不可达：${error instanceof Error ? error.message : String(error)}`)
    }
    if (!response.ok) {
      throw new MarketError('http_' + String(response.status), `市场来源返回 HTTP ${response.status}`)
    }
    return response.text()
  }

  private async fetchJson<T>(url: string, ttlMs = 60_000): Promise<T> {
    const hit = this.cache.get(url)
    if (hit !== undefined && Date.now() - hit.at < ttlMs) return hit.value as T
    const text = await this.fetchText(url)
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      throw new MarketError('invalid_manifest', '市场清单不是合法 JSON。')
    }
    this.cache.set(url, { at: Date.now(), value: parsed })
    return parsed as T
  }

  private async manifest(): Promise<MarketplaceManifest> {
    const parsed = await this.fetchJson<unknown>(this.rawUrl('.claude-plugin/marketplace.json'))
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new MarketError('invalid_manifest', '市场清单结构不正确。')
    }
    return parsed as MarketplaceManifest
  }

  private entriesOf(manifest: MarketplaceManifest): MarketEntry[] {
    const list = Array.isArray(manifest.plugins) ? manifest.plugins : []
    const version = manifest.metadata?.version
    const author = manifest.owner?.name
    const entries: MarketEntry[] = []
    for (const plugin of list) {
      const name = typeof plugin.name === 'string' ? plugin.name : ''
      if (name === '') continue
      const paths = Array.isArray(plugin.skills) ? plugin.skills.filter((p): p is string => typeof p === 'string') : []
      const entry: MarketEntry = {
        id: name,
        providerId: this.options.id,
        name,
        description: typeof plugin.description === 'string' ? plugin.description : '',
        skills: paths.map(folderOf),
        skillPaths: paths,
        sourceRepo: this.options.repo,
        sourceUrl: `https://github.com/${this.options.repo}`,
      }
      if (typeof version === 'string') entry.version = version
      if (typeof author === 'string') entry.author = author
      entries.push(entry)
    }
    return entries
  }

  async search(query: string, cursor: number): Promise<{ entries: MarketEntry[]; nextCursor?: number }> {
    const entries = this.entriesOf(await this.manifest())
    const needle = query.trim().toLowerCase()
    const filtered = needle === ''
      ? entries
      : entries.filter((entry) =>
          `${entry.name}\n${entry.description}\n${entry.skills.join(' ')}`.toLowerCase().includes(needle),
        )
    const pageSize = 10
    const start = Number.isFinite(cursor) && cursor > 0 ? Math.floor(cursor) : 0
    const page = filtered.slice(start, start + pageSize)
    const next = start + pageSize < filtered.length ? start + pageSize : undefined
    return next === undefined ? { entries: page } : { entries: page, nextCursor: next }
  }

  private findEntry(manifest: MarketplaceManifest, entryId: string): MarketEntry {
    const entry = this.entriesOf(manifest).find((item) => item.id === entryId)
    if (entry === undefined) throw new MarketError('not_found', `市场里没有条目：${entryId}`)
    return entry
  }

  async getDetail(entryId: string): Promise<MarketDetail> {
    const entry = this.findEntry(await this.manifest(), entryId)
    const skillDetails: MarketDetail['skillDetails'] = []
    // Bound the fan-out: a manifest can list dozens of skills.
    for (const path of entry.skillPaths.slice(0, 24)) {
      const folder = folderOf(path)
      try {
        const markdown = await this.fetchText(this.rawUrl(`${path.replace(/^\.\//, '')}/SKILL.md`))
        const frontmatter = parseSkillFrontmatter(markdown)
        const detail: MarketDetail['skillDetails'][number] = { folder, path, ok: true }
        if (typeof frontmatter.name === 'string') detail.name = frontmatter.name
        if (typeof frontmatter.description === 'string') detail.description = frontmatter.description.slice(0, 300)
        skillDetails.push(detail)
      } catch {
        skillDetails.push({ folder, path, ok: false })
      }
    }
    return { ...entry, skillDetails, fetchedAt: Date.now() }
  }

  async resolveArtifact(entryId: string, _version?: string): Promise<MarketArtifact> {
    const entry = this.findEntry(await this.manifest(), entryId)
    let commit: string | undefined
    try {
      const payload = await this.fetchJson<{ sha?: unknown }>(
        `https://api.github.com/repos/${this.options.repo}/commits/${encodeURIComponent(this.ref())}`,
        30_000,
      )
      if (typeof payload.sha === 'string' && /^[0-9a-f]{7,40}$/i.test(payload.sha)) commit = payload.sha
    } catch {
      // Rate-limited or offline: fall back to the branch ref; git checkout pins
      // the actual commit at clone time and the install records it.
    }
    const artifact: MarketArtifact = {
      repoUrl: `https://github.com/${this.options.repo}.git`,
      ref: commit ?? this.ref(),
      folders: entry.skills,
    }
    if (commit !== undefined) artifact.commit = commit
    if (entry.version !== undefined) artifact.version = entry.version
    return artifact
  }
}

/** A small registry of providers; the browser can only ask for one by id. */
export class MarketService {
  private readonly byId = new Map<string, MarketProvider>()

  constructor(providers: MarketProvider[]) {
    for (const provider of providers) this.byId.set(provider.info().id, provider)
  }

  list(): MarketProviderInfo[] {
    return [...this.byId.values()].map((provider) => provider.info())
  }

  has(providerId: string): boolean {
    return this.byId.has(providerId)
  }

  get(providerId: string): MarketProvider {
    const provider = this.byId.get(providerId)
    if (provider === undefined) throw new MarketError('unknown_provider', `未知的市场来源：${providerId}`)
    return provider
  }

  search(providerId: string, query: string, cursor: number): ReturnType<MarketProvider['search']> {
    return this.get(providerId).search(query, cursor)
  }

  detail(providerId: string, entryId: string): ReturnType<MarketProvider['getDetail']> {
    return this.get(providerId).getDetail(entryId)
  }

  resolve(providerId: string, entryId: string, version?: string): ReturnType<MarketProvider['resolveArtifact']> {
    return this.get(providerId).resolveArtifact(entryId, version)
  }
}
