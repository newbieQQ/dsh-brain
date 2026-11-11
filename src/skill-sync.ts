/**
 * Bidirectional skill sync between the cloud skill center and the local
 * DSH skills directory (`$DSH_HOME/skills` by default).
 *
 * The cloud center is the hub, the local directory is a working copy, and
 * the DSH skills manager keeps owning local management — this module only
 * moves files, in both directions:
 *
 * - DOWN: cloud skills are installed exactly like the platform's own
 *   `skills-sync` tool does it — bundle hash and per-file checksums are
 *   verified before anything lands, writes are atomic per file, and a
 *   per-skill `.manifest.json` records what the cloud delivered.
 * - UP: skills that originated locally (installed by the skills manager,
 *   imported, or written by hand) are published to the center as new
 *   revisions, guarded by the center's `expected_revision` check.
 *
 * Safety rules (deliberate, in order):
 * 1. A cloud-delivered skill is never re-uploaded. If its local files no
 *    longer match the delivery manifest, the skill is flagged as a
 *    conflict and left completely alone.
 * 2. A local deletion never deletes the cloud copy.
 * 3. A name that already exists on the other side is never hijacked;
 *    it is reported as a conflict for a human to resolve.
 * 4. Bundles whose scripts changed on the cloud side are not installed
 *    until the change is acknowledged in the dashboard, mirroring the
 *    center's own review flag.
 * 5. Only the center's file layout is uploadable (SKILL.md at the root,
 *    everything else under references/, scripts/ or assets/, with the
 *    center's extension allowlist). Anything else is reported, never
 *    silently trimmed.
 */
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, cp, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import type { CloudClient, SkillBundle, SkillSummary, SkillUploadFile } from './api.ts'
import { describeError } from './api.ts'
import { dshHome, migrateLegacyFile } from './store.ts'

/** Cloud skill names: lowercase kebab, at most 64 characters. */
export const CLOUD_SKILL_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/

/** Layout contract of the cloud skill center (mirrors its store rules). */
const TEXT_EXT = new Set(['.md', '.txt', '.json', '.yaml', '.yml', '.py', '.sh', '.ps1', '.mjs', '.js', '.ts', '.tsx', '.css', '.html', '.csv'])
const BINARY_EXT = new Set(['.docx', '.xlsx', '.pptx', '.pdf', '.png', '.jpg', '.jpeg', '.gif', '.svg', '.zip'])
const SCRIPT_EXT = new Set(['.py', '.sh', '.ps1', '.mjs'])
const SKILL_DIRS = new Set(['references', 'scripts', 'assets'])
const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
const MAX_FILES = 100
const MAX_FILE_BYTES = 512 * 1024
const MAX_SKILL_BYTES = 2 * 1024 * 1024
const MAX_DEPTH = 3

/** SHA-256 of a buffer or UTF-8 string, hex-encoded. */
export function sha256Hex(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex')
}

/**
 * The center's linked bundle manifest: one `path\0sha256` line per file,
 * sorted, under a version header. Byte-identical to the platform's own
 * computation, so locally computed manifests compare directly.
 */
export function linkedSkillManifest(files: readonly { path: string; sha256: string }[]): string {
  const lines = files.map((file) => `${file.path}\0${file.sha256}`).sort()
  return sha256Hex(Buffer.from(`cloud-memory-skill-v1\n${lines.join('\n')}\n`, 'utf8'))
}

/** True when the cloud center would accept this relative file path. */
export function isCloudSkillPath(rel: string): boolean {
  if (rel === '' || rel.length > 200 || rel.startsWith('/') || rel.includes('\\') || rel.includes('//')) return false
  const segments = rel.split('/')
  if (segments.length > MAX_DEPTH) return false
  for (const segment of segments) {
    if (!SEGMENT.test(segment) || segment === '.' || segment === '..') return false
  }
  const dot = rel.lastIndexOf('.')
  const ext = dot === -1 ? '' : rel.slice(dot).toLowerCase()
  if (!TEXT_EXT.has(ext) && !BINARY_EXT.has(ext)) return false
  const first = segments[0]
  if (segments.length === 1) return rel === 'SKILL.md'
  if (first === undefined || !SKILL_DIRS.has(first)) return false
  if (first === 'scripts' && !SCRIPT_EXT.has(ext)) return false
  return true
}

/** Minimal frontmatter reader for `name` / `description` (plain scalars). */
export function parseSkillFrontmatter(markdown: string): { name?: string; description?: string } {
  if (!markdown.startsWith('---')) return {}
  const end = markdown.indexOf('\n---', 3)
  if (end === -1) return {}
  const out: { name?: string; description?: string } = {}
  for (const line of markdown.slice(3, end).split('\n')) {
    const match = /^\s*(name|description)\s*:\s*(.+?)\s*$/.exec(line)
    if (match === null) continue
    const value = (match[2] ?? '').replace(/^["']|["']$/g, '')
    if (match[1] === 'name' && value !== '') out.name = value
    if (match[1] === 'description' && value !== '') out.description = value
  }
  return out
}

/** One sync conflict a human should look at; sync never forces these. */
export interface SkillSyncConflict {
  name: string
  reason: string
}

/** Outcome of the most recent (or running) sync pass. */
export interface SkillSyncStats {
  running: boolean
  lastRunAt?: string
  lastError?: string
  downloaded: string[]
  uploaded: string[]
  updated: string[]
  conflicts: SkillSyncConflict[]
  skipped: number
}

/** What the sidecar remembers about one locally-originated upload. */
interface UploadRecord {
  folder: string
  revision: number
  manifest: string
  syncedAt: string
}

/** Sidecar state: `$DSH_HOME/dsh-brain-skills.json` (legacy `cloud-memory-skills.json` migrates on first use). */

/** Absolute sidecar path, carrying the pre-rename file over on first use. */
export function skillsStatePath(): string {
  const target = join(dshHome(), 'dsh-brain-skills.json')
  migrateLegacyFile(target, join(dshHome(), 'cloud-memory-skills.json'))
  return target
}
interface SyncState {
  version: 1
  uploaded: Record<string, UploadRecord>
  /** Cloud skills currently delivered locally, by delivered manifest. */
  delivered: Record<string, { manifest: string }>
  /**
   * Skills the user deleted locally, by the cloud manifest at deletion
   * time. A deleted skill stays deleted until the cloud publishes a
   * different manifest; the cloud copy itself is never removed.
   */
  removed: Record<string, { manifest: string }>
}

/** One local file read from disk. */
interface LocalFile {
  rel: string
  buffer: Buffer
}

/** Dependencies of one sync engine instance. */
export interface SkillSyncDeps {
  client: () => CloudClient
  settings: () => { enabled: boolean; skillsSyncEnabled: boolean; skillsDir: string }
  log: (message: string) => void
  /** Parking area for disabled skills; parked skills are synced in place. */
  holdingDir?: () => string
}

async function isDirectory(path: string): Promise<boolean> {
  return stat(path).then((value) => value.isDirectory()).catch(() => false)
}

/** The per-skill delivery record the platform's own tooling writes. */
interface DeliveryManifest {
  name?: string
  revision?: number
  manifest_sha256?: string
  files?: { path: string; sha256: string }[]
}

export class SkillSync {
  private running = false
  private current: SkillSyncStats = {
    running: false, downloaded: [], uploaded: [], updated: [], conflicts: [], skipped: 0,
  }

  constructor(private readonly deps: SkillSyncDeps) {}

  /** Stats of the latest pass, for the status endpoint. */
  stats(): SkillSyncStats {
    return this.current
  }

  /** The local skills root this engine syncs. */
  skillsRoot(): string {
    const dir = this.deps.settings().skillsDir
    return dir !== '' ? resolve(dir) : join(dshHome(), 'skills')
  }

  /** The parking area where disabled skills wait, outside the root. */
  holdingRoot(): string {
    return this.deps.holdingDir?.() ?? join(dshHome(), 'skills-disabled')
  }

  private statePath(): string {
    return skillsStatePath()
  }

  private async loadState(): Promise<SyncState> {
    const clean = { version: 1 as const, uploaded: {}, delivered: {}, removed: {} }
    try {
      const parsed: unknown = JSON.parse(await readFile(this.statePath(), 'utf8'))
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const raw = parsed as { uploaded?: unknown; delivered?: unknown; removed?: unknown }
        const map = (value: unknown): Record<string, never> =>
          value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, never>) : {}
        return {
          version: 1,
          uploaded: map(raw.uploaded) as Record<string, UploadRecord>,
          delivered: map(raw.delivered) as Record<string, { manifest: string }>,
          removed: map(raw.removed) as Record<string, { manifest: string }>,
        }
      }
    } catch {
      // Missing or corrupt sidecar: start clean; the cloud is the truth.
    }
    return clean
  }

  private async saveState(state: SyncState): Promise<void> {
    const path = this.statePath()
    await mkdir(dirname(path), { recursive: true })
    const temporary = `${path}.tmp-${process.pid}`
    await writeFile(temporary, JSON.stringify(state, null, 2))
    await rename(temporary, path)
  }

  /** Read every syncable file of one skill directory (unsorted walk). */
  private async readSkillFiles(dir: string): Promise<LocalFile[]> {
    const out: LocalFile[] = []
    const walk = async (sub: string): Promise<void> => {
      const entries = await readdir(join(dir, sub), { withFileTypes: true })
      for (const entry of entries) {
        const rel = sub === '' ? entry.name : `${sub}/${entry.name}`
        if (entry.name.startsWith('.')) continue
        if (entry.isDirectory()) {
          await walk(rel)
        } else if (entry.isFile()) {
          out.push({ rel, buffer: await readFile(join(dir, rel)) })
        }
      }
    }
    await walk('')
    return out.sort((a, b) => (a.rel < b.rel ? -1 : 1))
  }

  /** True when a cloud-delivered directory still matches its manifest. */
  private async deliveredIntact(dir: string, delivery: DeliveryManifest): Promise<boolean> {
    const recorded = delivery.files ?? []
    let files: LocalFile[]
    try {
      files = await this.readSkillFiles(dir)
    } catch {
      return false
    }
    const current = files.filter((file) => file.rel !== '.manifest.json')
    if (current.length !== recorded.length) return false
    const byPath = new Map(current.map((file) => [file.rel, sha256Hex(file.buffer)]))
    return recorded.every((file) => byPath.get(file.path) === file.sha256)
  }

  /** Install or update one cloud skill into the local directory. */
  private async install(item: SkillSummary, bundle: SkillBundle, root: string): Promise<void> {
    const dir = join(root, item.name)
    const previous = await this.readDelivery(dir)
    const keep = new Set(bundle.files.map((file) => file.path))
    await mkdir(dir, { recursive: true })
    const written: { path: string; sha256: string; size: number }[] = []
    for (const file of bundle.files) {
      const buffer = Buffer.from(file.data, 'base64')
      if (sha256Hex(buffer) !== file.sha256) throw new Error(`checksum mismatch for ${file.path}`)
      const target = join(dir, ...file.path.split('/'))
      await mkdir(dirname(target), { recursive: true })
      const temporary = `${target}.tmp-${process.pid}`
      await writeFile(temporary, buffer)
      await rename(temporary, target)
      written.push({ path: file.path, sha256: file.sha256, size: buffer.length })
    }
    for (const file of previous?.files ?? []) {
      if (!keep.has(file.path)) await rm(join(dir, ...file.path.split('/')), { force: true })
    }
    const delivery: DeliveryManifest & { synced_at: string } = {
      name: item.name,
      revision: bundle.revision,
      manifest_sha256: bundle.manifest_sha256,
      files: written,
      synced_at: new Date().toISOString(),
    }
    await writeFile(join(dir, '.manifest.json'), JSON.stringify(delivery, null, 2))
  }

  private async readDelivery(dir: string): Promise<DeliveryManifest | undefined> {
    try {
      const parsed: unknown = JSON.parse(await readFile(join(dir, '.manifest.json'), 'utf8'))
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as DeliveryManifest
      }
    } catch {
      // Not a cloud-delivered skill.
    }
    return undefined
  }

  /** One full pass; never throws — outcomes land in the stats. */
  async syncOnce(): Promise<SkillSyncStats> {
    if (this.running) return this.current
    const settings = this.deps.settings()
    if (!settings.enabled || !settings.skillsSyncEnabled) return this.current
    this.running = true
    const stats: SkillSyncStats = {
      running: true, downloaded: [], uploaded: [], updated: [], conflicts: [], skipped: 0,
    }
    this.current = stats
    try {
      await this.pass(stats)
      stats.lastRunAt = new Date().toISOString()
    } catch (error) {
      stats.lastError = error instanceof Error ? error.message : String(error)
      this.deps.log(`skill sync failed: ${stats.lastError}`)
    } finally {
      stats.running = false
      this.running = false
      this.current = stats
    }
    return this.current
  }

  /** Record a conflict once per pass, however many rules trip over it. */
  private conflict(stats: SkillSyncStats, name: string, reason: string): void {
    if (!stats.conflicts.some((item) => item.name === name && item.reason === reason)) {
      stats.conflicts.push({ name, reason })
    }
  }

  private async pass(stats: SkillSyncStats): Promise<void> {
    const client = this.deps.client()
    const listing = await client.listSkills()
    if (!listing.ok) throw new Error(`skill listing failed: ${describeError(listing.error)}`)
    const items = (listing.data.items ?? []).filter(
      (item): item is SkillSummary & { name: string } => typeof item.name === 'string' && CLOUD_SKILL_NAME.test(item.name),
    )
    const cloudByName = new Map(items.map((item) => [item.name, item]))
    const root = this.skillsRoot()
    const state = await this.loadState()
    let stateDirty = false

    // ---- DOWN: cloud center -> local directory -------------------------
    for (const item of items) {
      if (item.enabled === false) { stats.skipped += 1; continue }
      // Locally-originated skills belong to the UP pass, even though the
      // center lists them too once they are published.
      if (state.uploaded[item.name] !== undefined) { stats.skipped += 1; continue }
      const dir = join(root, item.name)
      const parkedDir = join(this.holdingRoot(), item.name)
      const inRoot = await isDirectory(dir)
      const parked = !inRoot && (await isDirectory(parkedDir))
      const home = parked ? parkedDir : dir
      const exists = inRoot || parked
      const removed = state.removed[item.name]
      if (removed !== undefined && exists) {
        // The user put it back by hand; the removal is over.
        delete state.removed[item.name]
        stateDirty = true
      } else if (removed !== undefined && item.manifest_sha256 === removed.manifest) {
        // Deleted locally at this exact cloud version: keep it deleted.
        stats.skipped += 1
        continue
      } else if (removed !== undefined) {
        // The cloud published a different version since the deletion.
        delete state.removed[item.name]
        stateDirty = true
      }
      const delivery = await this.readDelivery(home)
      if (exists && delivery !== undefined) {
        // Delivered before: local integrity is judged before any download.
        if (!(await this.deliveredIntact(home, delivery))) {
          this.conflict(stats, item.name, 'locally_modified')
          continue
        }
        if (delivery.manifest_sha256 === item.manifest_sha256) {
          if (state.delivered[item.name]?.manifest !== item.manifest_sha256) {
            state.delivered[item.name] = { manifest: item.manifest_sha256 ?? '' }
            stateDirty = true
          }
          stats.skipped += 1
          continue
        }
        // Intact but the cloud moved on: fall through and install the update.
      }
      if (exists && delivery === undefined) {
        this.conflict(stats, item.name, 'name_collision')
        continue
      }
      if (item.script_changed === true) {
        // The listing already carries the review flag; don't even fetch.
        this.conflict(stats, item.name, 'script_review_required')
        continue
      }
      const bundle = await client.skillBundle(item.name)
      if (!bundle.ok) {
        this.conflict(stats, item.name, `bundle_failed: ${describeError(bundle.error)}`)
        continue
      }
      if (linkedSkillManifest(bundle.data.files) !== bundle.data.manifest_sha256) {
        this.conflict(stats, item.name, 'manifest_mismatch')
        continue
      }
      if (bundle.data.script_changed === true) {
        this.conflict(stats, item.name, 'script_review_required')
        continue
      }
      await this.install(item, bundle.data, parked ? this.holdingRoot() : root)
      state.delivered[item.name] = { manifest: bundle.data.manifest_sha256 }
      stateDirty = true
      ;(exists ? stats.updated : stats.downloaded).push(item.name)
    }

    // ---- UP: local originals -> cloud center ---------------------------
    const folders = await readdir(root, { withFileTypes: true }).catch(() => [])
    const seenFolders = new Set<string>()
    for (const entry of folders) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue
      seenFolders.add(entry.name)
      const dir = join(root, entry.name)
      if ((await this.readDelivery(dir)) !== undefined) continue // cloud-origin: down pass owns it
      const skill = await this.readLocalSkill(dir, entry.name)
      if (skill === undefined) continue
      if (typeof skill === 'string') {
        this.conflict(stats, entry.name, skill)
        continue
      }
      const record = state.uploaded[skill.name]
      const cloud = cloudByName.get(skill.name)
      if (cloud !== undefined && record === undefined) {
        this.conflict(stats, skill.name, 'name_collision')
        continue
      }
      if (record !== undefined && record.manifest === skill.manifest) { stats.skipped += 1; continue }
      const files: SkillUploadFile[] = skill.files.map((file) => {
        const ext = file.rel.slice(file.rel.lastIndexOf('.')).toLowerCase()
        return TEXT_EXT.has(ext)
          ? { path: file.rel, content: file.buffer.toString('utf8') }
          : { path: file.rel, base64: file.buffer.toString('base64') }
      })
      const operationId = `dsh-skill-${randomUUID()}`
      if (record === undefined || cloud === undefined) {
        const created = await client.createSkill({
          name: skill.name,
          description: skill.description,
          execution_mode: skill.hasScripts ? 'local-bundle' : 'prompt-only',
          files,
          expected_revision: 0,
          operation_id: operationId,
        })
        if (!created.ok) {
          this.conflict(stats, skill.name, `upload_failed: ${describeError(created.error)}`)
          continue
        }
        state.uploaded[skill.name] = {
          folder: entry.name,
          revision: created.data.skill?.revision ?? created.data.revision ?? 1,
          manifest: skill.manifest,
          syncedAt: new Date().toISOString(),
        }
        stateDirty = true
        stats.uploaded.push(skill.name)
      } else {
        if (cloud.revision !== undefined && cloud.revision !== record.revision) {
          this.conflict(stats, skill.name, 'cloud_newer')
          continue
        }
        const updated = await client.updateSkill(skill.name, {
          description: skill.description,
          files,
          expected_revision: record.revision,
          operation_id: operationId,
        })
        if (!updated.ok) {
          const reason = updated.error.code === 'revision_conflict' ? 'cloud_newer' : `upload_failed: ${describeError(updated.error)}`
          this.conflict(stats, skill.name, reason)
          continue
        }
        state.uploaded[skill.name] = {
          folder: entry.name,
          revision: updated.data.skill?.revision ?? updated.data.revision ?? record.revision + 1,
          manifest: skill.manifest,
          syncedAt: new Date().toISOString(),
        }
        stateDirty = true
        stats.updated.push(skill.name)
      }
    }

    // Presence counts the parking area too: a parked skill is disabled,
    // not deleted. Anything missing from both is a deliberate removal
    // (remembered, so it is not resurrected); the cloud copy stays.
    const presentFolders = new Set(seenFolders)
    for (const entry of await readdir(this.holdingRoot(), { withFileTypes: true }).catch(() => [])) {
      if (entry.isDirectory()) presentFolders.add(entry.name)
    }
    for (const [name, record] of Object.entries(state.uploaded)) {
      if (!presentFolders.has(record.folder)) {
        state.removed[name] = { manifest: cloudByName.get(name)?.manifest_sha256 ?? record.manifest }
        delete state.uploaded[name]
        stateDirty = true
      }
    }
    for (const [name, record] of Object.entries(state.delivered)) {
      if (!presentFolders.has(name)) {
        state.removed[name] = { manifest: record.manifest }
        delete state.delivered[name]
        stateDirty = true
      }
    }
    if (stateDirty) await this.saveState(state)
    const changed = stats.downloaded.length + stats.uploaded.length + stats.updated.length
    if (changed > 0 || stats.conflicts.length > 0) {
      this.deps.log(
        `skill sync: ${stats.downloaded.length} downloaded, ${stats.uploaded.length} uploaded, ` +
        `${stats.updated.length} updated, ${stats.conflicts.length} conflict(s)`,
      )
    }
  }

  /**
   * Read one locally-originated skill for upload. Returns the skill, a
   * conflict reason string, or undefined when the folder is not a skill.
   */
  private async readLocalSkill(
    dir: string,
    folder: string,
  ): Promise<{ name: string; description: string; files: LocalFile[]; manifest: string; hasScripts: boolean } | string | undefined> {
    let files: LocalFile[]
    try {
      files = await this.readSkillFiles(dir)
    } catch {
      return undefined
    }
    const markdown = files.find((file) => file.rel === 'SKILL.md')
    if (markdown === undefined) return undefined
    if (files.length > MAX_FILES) return 'too_many_files'
    let total = 0
    for (const file of files) {
      if (file.buffer.length > MAX_FILE_BYTES) return 'file_too_large'
      total += file.buffer.length
      if (!isCloudSkillPath(file.rel)) return 'unsupported_layout'
    }
    if (total > MAX_SKILL_BYTES) return 'skill_too_large'
    const frontmatter = parseSkillFrontmatter(markdown.buffer.toString('utf8'))
    const name = frontmatter.name !== undefined && CLOUD_SKILL_NAME.test(frontmatter.name)
      ? frontmatter.name
      : CLOUD_SKILL_NAME.test(folder)
        ? folder
        : undefined
    if (name === undefined) return 'invalid_name'
    const heading = /^#\s+(.+)$/m.exec(markdown.buffer.toString('utf8'))?.[1]?.trim()
    const description = (frontmatter.description ?? heading ?? name).slice(0, 500)
    const manifest = linkedSkillManifest(files.map((file) => ({ path: file.rel, sha256: sha256Hex(file.buffer) })))
    return {
      name,
      description,
      files,
      manifest,
      hasScripts: files.some((file) => file.rel.startsWith('scripts/')),
    }
  }

  /** Encode local files exactly the way the upload path does. */
  private toUploadFiles(files: LocalFile[]): SkillUploadFile[] {
    return files.map((file) => {
      const ext = file.rel.slice(file.rel.lastIndexOf('.')).toLowerCase()
      return TEXT_EXT.has(ext)
        ? { path: file.rel, content: file.buffer.toString('utf8') }
        : { path: file.rel, base64: file.buffer.toString('base64') }
    })
  }

  /** Drop one name from the in-memory conflict list after it is resolved. */
  private dropConflict(name: string): void {
    this.current = { ...this.current, conflicts: this.current.conflicts.filter((conflict) => conflict.name !== name) }
  }

  /**
   * Both sides of every conflict from the last pass, so a human can decide.
   * Read-only: it never changes a file or uploads anything.
   */
  async conflictDetails(): Promise<SyncConflictDetail[]> {
    const conflicts = this.current.conflicts
    if (conflicts.length === 0) return []
    let cloudItems: (SkillSummary & { name: string })[] = []
    try {
      const listing = await this.deps.client().listSkills()
      if (listing.ok) {
        cloudItems = (listing.data.items ?? []).filter(
          (item): item is SkillSummary & { name: string } => typeof item.name === 'string',
        )
      }
    } catch {
      // Listing failed: still show the local side with a null cloud side.
    }
    const byName = new Map(cloudItems.map((item) => [item.name, item]))
    const out: SyncConflictDetail[] = []
    for (const conflict of conflicts) {
      const rootDir = join(this.skillsRoot(), conflict.name)
      const parkedDir = join(this.holdingRoot(), conflict.name)
      let location: 'root' | 'holding' | 'none' = 'none'
      let dir = ''
      if (await isDirectory(rootDir)) { location = 'root'; dir = rootDir }
      else if (await isDirectory(parkedDir)) { location = 'holding'; dir = parkedDir }
      let files = 0
      let bytes = 0
      let modified = false
      if (dir !== '') {
        try {
          const local = await this.readSkillFiles(dir)
          files = local.length
          bytes = local.reduce((sum, file) => sum + file.buffer.length, 0)
          const delivery = await this.readDelivery(dir)
          modified = delivery === undefined ? true : !(await this.deliveredIntact(dir, delivery))
        } catch {
          // Unreadable folder: report zeroed counts, never throw the list away.
        }
      }
      const cloudItem = byName.get(conflict.name)
      out.push({
        name: conflict.name,
        reason: conflict.reason,
        local: { exists: location !== 'none', location, files, bytes, modified },
        cloud: cloudItem === undefined
          ? null
          : {
              ...(cloudItem.revision === undefined ? {} : { revision: cloudItem.revision }),
              ...(cloudItem.manifest_sha256 === undefined ? {} : { manifest: cloudItem.manifest_sha256 }),
              ...(cloudItem.files === undefined ? {} : { files: cloudItem.files }),
              ...(cloudItem.bytes === undefined ? {} : { bytes: cloudItem.bytes }),
              ...(cloudItem.enabled === undefined ? {} : { enabled: cloudItem.enabled }),
            },
        canKeepLocal: location !== 'none',
        canTakeCloud: cloudItem !== undefined,
        note: '“保留本地”把本地版本上传成新的云端版本；“采用云端”先备份本地再覆盖；“手动合并”只返回两侧信息，不改文件。',
      })
    }
    return out
  }

  /** Resolve one conflict: keep local / take cloud / manual (no write). */
  async resolveConflict(nameInput: unknown, actionInput: unknown): Promise<SyncResolveResult> {
    const name = typeof nameInput === 'string' ? nameInput : ''
    if (name === '' || !CLOUD_SKILL_NAME.test(name)) throw new Error('invalid_name')
    const action = actionInput === 'keep_local' || actionInput === 'take_cloud' || actionInput === 'manual' ? actionInput : ''
    if (action === '') throw new Error('invalid_action')
    if (this.running) throw new Error('sync_running')
    const root = this.skillsRoot()
    const rootDir = join(root, name)
    const parkedDir = join(this.holdingRoot(), name)
    const inRoot = await isDirectory(rootDir)
    const parked = !inRoot && (await isDirectory(parkedDir))
    const dir = inRoot ? rootDir : parked ? parkedDir : ''
    const client = this.deps.client()
    const listing = await client.listSkills()
    if (!listing.ok) throw new Error(`skill listing failed: ${describeError(listing.error)}`)
    const cloud = (listing.data.items ?? []).find((item) => item.name === name)
    const state = await this.loadState()

    if (action === 'manual') {
      return {
        name,
        action,
        applied: false,
        note: '已返回两侧信息，未改动任何文件；手工编辑后在下次同步前保存即可。',
        ...(cloud?.revision === undefined ? {} : { revision: cloud.revision }),
      }
    }

    if (action === 'keep_local') {
      if (dir === '') throw new Error('no_local_copy')
      const skill = await this.readLocalSkill(dir, name)
      if (skill === undefined) throw new Error('not_a_skill')
      if (typeof skill === 'string') throw new Error(skill)
      const files = this.toUploadFiles(skill.files)
      const operationId = `dsh-skill-${randomUUID()}`
      if (cloud === undefined) {
        const created = await client.createSkill({
          name: skill.name,
          description: skill.description,
          execution_mode: skill.hasScripts ? 'local-bundle' : 'prompt-only',
          files,
          expected_revision: 0,
          operation_id: operationId,
        })
        if (!created.ok) throw new Error(`upload_failed: ${describeError(created.error)}`)
        const revision = created.data.skill?.revision ?? created.data.revision ?? 1
        state.uploaded[name] = { folder: name, revision, manifest: skill.manifest, syncedAt: new Date().toISOString() }
        delete state.removed[name]
        await this.saveState(state)
        this.dropConflict(name)
        return { name, action, applied: true, revision, note: '已把本地版本新建到云端。' }
      }
      const updated = await client.updateSkill(name, {
        description: skill.description,
        files,
        expected_revision: cloud.revision ?? 0,
        operation_id: operationId,
      })
      if (!updated.ok) {
        if (updated.error.code === 'revision_conflict') throw new Error('stale_revision')
        throw new Error(`upload_failed: ${describeError(updated.error)}`)
      }
      const revision = updated.data.skill?.revision ?? updated.data.revision ?? (cloud.revision ?? 0) + 1
      state.uploaded[name] = { folder: name, revision, manifest: skill.manifest, syncedAt: new Date().toISOString() }
      delete state.removed[name]
      await this.saveState(state)
      this.dropConflict(name)
      return { name, action, applied: true, revision, note: '已用本地版本覆盖云端（revision 已更新）。' }
    }

    // take_cloud
    if (cloud === undefined) throw new Error('no_cloud_copy')
    const bundle = await client.skillBundle(name)
    if (!bundle.ok) throw new Error(`bundle_failed: ${describeError(bundle.error)}`)
    if (linkedSkillManifest(bundle.data.files) !== bundle.data.manifest_sha256) throw new Error('manifest_mismatch')
    let backup = ''
    if (dir !== '') {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-')
      backup = join(dshHome(), '.dsh-brain-backups', 'sync', name, stamp)
      await mkdir(join(backup, '..'), { recursive: true })
      await cp(dir, backup, { recursive: true, filter: (p) => !p.split(/[\\/]/).includes('.git') })
    }
    await this.install(cloud, bundle.data, parked ? this.holdingRoot() : root)
    state.delivered[name] = { manifest: bundle.data.manifest_sha256 }
    delete state.removed[name]
    await this.saveState(state)
    this.dropConflict(name)
    return {
      name,
      action,
      applied: true,
      revision: bundle.data.revision,
      ...(backup === '' ? {} : { backup }),
      note: '已采用云端版本覆盖本地（本地已备份）。',
    }
  }
}

/** One conflict with both sides, for the resolve UI. */
export interface SyncConflictDetail {
  name: string
  reason: string
  local: { exists: boolean; location: 'root' | 'holding' | 'none'; files: number; bytes: number; modified: boolean }
  cloud: { revision?: number; manifest?: string; files?: number; bytes?: number; enabled?: boolean } | null
  canKeepLocal: boolean
  canTakeCloud: boolean
  note: string
}

/** Outcome of one conflict resolution. */
export interface SyncResolveResult {
  name: string
  action: 'keep_local' | 'take_cloud' | 'manual'
  applied: boolean
  revision?: number
  backup?: string
  note: string
}
