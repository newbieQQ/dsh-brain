/**
 * Local skill management, built into the plugin: list, inspect, enable/disable,
 * previewed install, previewed uninstall.
 *
 * This covers the everyday subset of a full skills manager. It manages
 * only the DSH skills root (plus its own parking and staging areas) — the
 * cloud sync engine keeps owning everything beyond the local disk.
 *
 * Enable/disable is deliberately mechanical: a disabled skill's folder
 * is parked in `$DSH_HOME/skills-disabled/`, outside the skills root, so
 * DSH simply does not see it. No host internals are involved, which
 * keeps the operation reversible and predictable. The sync engine knows
 * about the parking area: parked skills are neither resurrected nor
 * mistaken for deletions, and a parked cloud skill still receives its
 * cloud updates in place.
 *
 * Delete is a real delete: the folder is removed recursively. It is only
 * reachable through a two-step contract (plan → confirm) because there is no
 * trash area and nothing can be restored. The cloud copy is unaffected —
 * local deletion never propagates to the center.
 *
 * Installation is staged: the repository is cloned into an isolated scratch
 * directory, candidates are enumerated and described, and nothing enters the
 * skills root until the caller commits an explicit selection. Repository code
 * is never executed (no hooks, no install scripts), symlinks are never
 * followed, and a colliding folder is always skipped instead of overwritten.
 */
import { lstatSync } from 'node:fs'
import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { cp, lstat, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import { parseSkillFrontmatter } from './skill-sync.ts'
import { dshHome, migrateLegacyFile } from './store.ts'

/** The parking area for disabled skills. */
export function skillsHoldingDir(): string {
  return join(dshHome(), 'skills-disabled')
}

/** Isolated scratch space for staged installs; never inside the skills root. */
export function skillsStagingDir(): string {
  return join(dshHome(), '.dsh-brain-staging')
}

/** Persisted plan records (metadata only: ids, counts, timestamps). */

/** Plans sidecar path, carrying the pre-rename file over on first use. */
export function plansPath(): string {
  const target = join(dshHome(), '.dsh-brain-plans.json')
  migrateLegacyFile(target, join(dshHome(), '.cloud-memory-plans.json'))
  return target
}

function skillPlansPath(): string {
  return plansPath()
}

/** A management failure with a stable machine-readable code. */
export class SkillAdminError extends Error {
  code: string
  constructor(code: string, message: string) {
    super(message)
    this.code = code
    this.name = 'SkillAdminError'
  }
}

/** Run git and return stdout (used for resolving the checked-out commit). */
function execFileText(file: string, args: string[], timeoutMs = 120_000): Promise<string> {
  return new Promise<string>((resolvePromise, rejectPromise) => {
    execFile(
      file,
      args,
      { timeout: timeoutMs, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }, maxBuffer: 4 * 1024 * 1024 },
      (error, stdout) => (error ? rejectPromise(error) : resolvePromise(String(stdout))),
    )
  })
}

function fail(code: string, message: string): never {
  throw new SkillAdminError(code, message)
}

/** Hard caps so one hostile repository cannot exhaust the disk. */
const MAX_SKILL_FILES = 1500
const MAX_SKILL_BYTES = 4 * 1024 * 1024
const MAX_CANDIDATES = 60
const MAX_SKILL_MD_BYTES = 256 * 1024
const PLAN_TTL_MS = 30 * 60_000

async function isDirectory(path: string): Promise<boolean> {
  return stat(path).then((s) => s.isDirectory()).catch(() => false)
}

async function isSymlink(path: string): Promise<boolean> {
  return lstat(path).then((s) => s.isSymbolicLink()).catch(() => false)
}

/** Synchronous variant, used inside `cp` filters where no await is possible. */
function isSymlinkSync(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink()
  } catch {
    return true
  }
}

/** Read a skill's `.skill-source.json`, or undefined when absent/corrupt. */
export async function readSkillSourceRecord(dir: string): Promise<SkillSourceRecord | undefined> {
  const raw = await readFile(join(dir, '.skill-source.json'), 'utf8').catch(() => undefined)
  if (raw === undefined) return undefined
  try {
    const parsed: unknown = JSON.parse(raw)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined
    const record = parsed as Partial<SkillSourceRecord>
    if (typeof record.repoUrl !== 'string' || typeof record.commit !== 'string') return undefined
    return {
      version: 1,
      provider: typeof record.provider === 'string' ? record.provider : 'git',
      repoUrl: record.repoUrl,
      ref: typeof record.ref === 'string' ? record.ref : record.commit,
      commit: record.commit,
      sourcePath: typeof record.sourcePath === 'string' ? record.sourcePath : '',
      installedAt: typeof record.installedAt === 'string' ? record.installedAt : new Date(0).toISOString(),
      ...(typeof record.entryId === 'string' ? { entryId: record.entryId } : {}),
      ...(typeof record.marketVersion === 'string' ? { marketVersion: record.marketVersion } : {}),
    }
  } catch {
    return undefined
  }
}

/** Files under one skill folder, skipping `.git` and never following links. */
async function walkFiles(dir: string, cap = MAX_SKILL_FILES + 1): Promise<{ path: string; bytes: number; script: boolean }[]> {
  const out: { path: string; bytes: number; script: boolean }[] = []
  const walk = async (sub: string): Promise<void> => {
    if (out.length > cap) return
    for (const entry of await readdir(join(dir, sub), { withFileTypes: true }).catch(() => [])) {
      if (entry.name === '.git') continue
      const rel = sub === '' ? entry.name : `${sub}/${entry.name}`
      const abs = join(dir, rel)
      if (entry.isSymbolicLink()) {
        out.push({ path: rel, bytes: 0, script: false })
        continue
      }
      if (entry.isDirectory()) {
        await walk(rel)
        continue
      }
      if (!entry.isFile()) continue
      const size = await stat(abs).then((s) => s.size).catch(() => 0)
      out.push({ path: rel, bytes: size, script: /\.(mjs|cjs|js|ts|ps1|sh|bat|cmd|py|rb|exe|dll)$/i.test(entry.name) })
    }
  }
  await walk('')
  out.sort((a, b) => (a.path < b.path ? -1 : 1))
  return out
}

/** A folder name we are willing to move around: one path segment, no tricks. */
function checkFolder(folder: unknown): string {
  if (typeof folder !== 'string' || folder === '' || folder.length > 128 ||
    folder.startsWith('.') || folder.includes('/') || folder.includes('\\') || folder.includes('\0')) {
    fail('invalid_name', `技能目录名无效：${String(folder)}`)
  }
  return folder
}

/** Where a skill came from, recorded next to it so it can be updated/rolled back. */
export interface SkillInstallSource {
  /** `git` for a manual repository install, or a market provider id. */
  provider: string
  /** Market entry id, when the install came from a marketplace. */
  entryId?: string
  version?: string
}

/** On-disk record written into an installed skill as `.skill-source.json`. */
export interface SkillSourceRecord {
  version: 1
  provider: string
  repoUrl: string
  ref: string
  commit: string
  /** Path inside the repository the folder was copied from. */
  sourcePath: string
  entryId?: string
  marketVersion?: string
  installedAt: string
}

/** One planned install candidate (metadata only). */
interface InstallPlanCandidate {
  folder: string
  name: string
  description: string
  files: number
  bytes: number
  scripts: string[]
  conflict: boolean
  conflictLocation?: 'root' | 'holding'
  problem?: string
  /** Path of the candidate relative to the staging clone root. */
  rel?: string
}

interface InstallPlan {
  id: string
  kind: 'install'
  url: string
  createdAt: number
  expiresAt: number
  stagingDir: string
  candidates: InstallPlanCandidate[]
  /** Commit the clone was pinned to (recorded for update/rollback). */
  commit?: string
  ref?: string
  source?: SkillInstallSource
}

interface PlansFile {
  version: 1
  plans: InstallPlan[]
}

/** The inventory row the card renders. */
export interface SkillEntry {
  folder: string
  name: string
  description: string
  enabled: boolean
  origin: 'cloud' | 'uploaded' | 'local'
  revision?: number
  files: number
  bytes: number
  installedAt?: string
  skillSha256?: string
  location: 'root' | 'holding'
  ownerManager: string
  writable: boolean
  /** Present when the folder carries a `.skill-source.json` record. */
  source?: {
    provider: string
    repoUrl: string
    ref: string
    commit: string
    entryId?: string
  }
  /** True when a source record exists, so update/rollback can be offered. */
  updatable?: boolean
}

export interface SkillAdminDeps {
  skillsRoot: () => string
  holdingDir: () => string
  syncStatePath: () => string
  syncRunning: () => boolean
  log: (message: string) => void
  /** Where plan metadata is persisted; defaults to `$DSH_HOME/.dsh-brain-plans.json`. */
  plansPath?: () => string
  /** Where staged clones live; defaults to `$DSH_HOME/.dsh-brain-staging`. */
  stagingRoot?: () => string
}

export class SkillAdmin {
  private readonly deps: SkillAdminDeps
  constructor(deps: SkillAdminDeps) {
    this.deps = deps
  }

  private plansFile(): string {
    return this.deps.plansPath?.() ?? skillPlansPath()
  }

  private stagingRoot(): string {
    return this.deps.stagingRoot?.() ?? skillsStagingDir()
  }

  private guardSync(): void {
    if (this.deps.syncRunning()) fail('sync_running', '技能同步正在进行，请稍候再试。')
  }

  private async uploaded(): Promise<Record<string, { folder?: string; revision?: number }>> {
    try {
      const parsed: unknown = JSON.parse(await readFile(this.deps.syncStatePath(), 'utf8'))
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const uploaded = (parsed as { uploaded?: unknown }).uploaded
        if (uploaded !== null && typeof uploaded === 'object' && !Array.isArray(uploaded)) {
          return uploaded as Record<string, { folder?: string; revision?: number }>
        }
      }
    } catch {
      // No sidecar yet: nothing has been uploaded.
    }
    return {}
  }

  private async describe(
    folder: string,
    dir: string,
    enabled: boolean,
    uploaded: Record<string, { folder?: string; revision?: number }>,
  ): Promise<SkillEntry | undefined> {
    const markdown = await readFile(join(dir, 'SKILL.md'), 'utf8').catch(() => undefined)
    if (markdown === undefined) return undefined
    const frontmatter = parseSkillFrontmatter(markdown)
    let origin: SkillEntry['origin'] = 'local'
    let revision: number | undefined
    const delivery = await readFile(join(dir, '.manifest.json'), 'utf8').catch(() => undefined)
    if (delivery !== undefined) {
      origin = 'cloud'
      try {
        const parsed: unknown = JSON.parse(delivery)
        const value = (parsed as { revision?: unknown } | null)?.revision
        if (typeof value === 'number') revision = value
      } catch {
        // A corrupt manifest still marks cloud origin.
      }
    } else {
      for (const record of Object.values(uploaded)) {
        if (record.folder === folder) {
          origin = 'uploaded'
          if (typeof record.revision === 'number') revision = record.revision
          break
        }
      }
    }
    const files = await walkFiles(dir)
    const bytes = files.reduce((sum, file) => sum + file.bytes, 0)
    const installedAt = await stat(join(dir, 'SKILL.md')).then((s) => new Date(s.mtimeMs).toISOString()).catch(() => undefined)
    const name = frontmatter.name
    const source = await readSkillSourceRecord(dir)
    return {
      folder,
      name: typeof name === 'string' && name !== '' ? name : folder,
      description: String(frontmatter.description ?? '').slice(0, 300),
      enabled,
      origin,
      ...(revision === undefined ? {} : { revision }),
      files: files.length,
      bytes,
      ...(installedAt === undefined ? {} : { installedAt }),
      skillSha256: createHash('sha256').update(markdown).digest('hex'),
      location: enabled ? 'root' : 'holding',
      ownerManager: 'dsh-brain',
      writable: true,
      ...(source === undefined
        ? {}
        : {
            source: {
              provider: source.provider,
              repoUrl: source.repoUrl,
              ref: source.ref,
              commit: source.commit,
              ...(source.entryId === undefined ? {} : { entryId: source.entryId }),
            },
          }),
      updatable: source !== undefined,
    }
  }

  /** Inventory of the skills root and the parking area. */
  async list(): Promise<{ skills: SkillEntry[]; root: string; holding: string; staging: string }> {
    const uploaded = await this.uploaded()
    const skills: SkillEntry[] = []
    const scan = async (area: string, enabled: boolean): Promise<void> => {
      for (const entry of await readdir(area, { withFileTypes: true }).catch(() => [])) {
        if (!entry.isDirectory() || entry.name.startsWith('.')) continue
        const described = await this.describe(entry.name, join(area, entry.name), enabled, uploaded)
        if (described !== undefined) skills.push(described)
      }
    }
    await scan(this.deps.skillsRoot(), true)
    await scan(this.deps.holdingDir(), false)
    skills.sort((a, b) => (a.folder < b.folder ? -1 : 1))
    return { skills, root: this.deps.skillsRoot(), holding: this.deps.holdingDir(), staging: this.stagingRoot() }
  }

  /** Locate a skill folder across the root and the parking area. */
  async locate(folder: string): Promise<{ area: 'root' | 'holding'; dir: string } | undefined> {
    const rootDir = join(this.deps.skillsRoot(), folder)
    if (await isDirectory(rootDir)) return { area: 'root', dir: rootDir }
    const parkedDir = join(this.deps.holdingDir(), folder)
    if (await isDirectory(parkedDir)) return { area: 'holding', dir: parkedDir }
    return undefined
  }

  /** Everything one skill panel needs, including its SKILL.md text. */
  async detail(folderInput: unknown): Promise<{
    skill: SkillEntry
    dir: string
    files: { path: string; bytes: number; script: boolean }[]
    totalBytes: number
    truncated: boolean
    skillMd: string
  }> {
    const folder = checkFolder(folderInput)
    const found = await this.locate(folder)
    if (found === undefined) fail('not_found', `没有找到技能：${folder}`)
    if (await isSymlink(found.dir)) fail('unsupported', `技能目录是链接，不在这里管理：${folder}`)
    const entry = await this.describe(folder, found.dir, found.area === 'root', await this.uploaded())
    if (entry === undefined) fail('not_found', `技能缺少 SKILL.md：${folder}`)
    const files = await walkFiles(found.dir)
    const raw = await readFile(join(found.dir, 'SKILL.md'), 'utf8').catch(() => '')
    const truncated = Buffer.byteLength(raw) > MAX_SKILL_MD_BYTES
    return {
      skill: entry,
      dir: found.dir,
      files,
      totalBytes: files.reduce((sum, file) => sum + file.bytes, 0),
      truncated,
      skillMd: truncated ? Buffer.from(raw).subarray(0, MAX_SKILL_MD_BYTES).toString('utf8') : raw,
    }
  }

  /** Enable (move back into the root) or disable (park) one skill. */
  async setEnabled(folderInput: unknown, enabled: boolean): Promise<{ folder: string; enabled: boolean; note: string }> {
    this.guardSync()
    const folder = checkFolder(folderInput)
    const found = await this.locate(folder)
    if (found === undefined) fail('not_found', `没有找到技能：${folder}`)
    const targetArea: 'root' | 'holding' = enabled ? 'root' : 'holding'
    if (found.area === targetArea) return { folder, enabled, note: this.effectNote(enabled) }
    const targetRoot = enabled ? this.deps.skillsRoot() : this.deps.holdingDir()
    await mkdir(targetRoot, { recursive: true })
    const target = join(targetRoot, folder)
    if (await isDirectory(target)) fail('collision', `目标位置已存在同名技能：${folder}`)
    try {
      await rename(found.dir, target)
    } catch (error) {
      // A cross-device move must not leave the skill half-copied: fall back to a
      // plain copy only for EXDEV, and only then remove the source.
      if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error
      await cp(found.dir, target, { recursive: true, filter: (source) => !source.split(/[\\/]/).includes('.git') })
      await rm(found.dir, { recursive: true, force: true })
    }
    this.deps.log(`skill ${enabled ? 'enabled' : 'disabled'}: ${folder}`)
    return { folder, enabled, note: this.effectNote(enabled) }
  }

  /** The enable/disable mechanism is a directory move, not a live switch. */
  private effectNote(enabled: boolean): string {
    return enabled
      ? '已放回技能目录：新会话可见；已在运行的会话可能仍保留旧状态。'
      : '已移出技能目录：新会话不再加载；已经加载的会话不受影响。'
  }

  /** Preview of what an uninstall would remove. Nothing is deleted yet. */
  async uninstallPlan(folderInput: unknown): Promise<{
    folder: string
    dir: string
    area: 'root' | 'holding'
    files: number
    bytes: number
    scripts: string[]
    origin: SkillEntry['origin'] | 'unknown'
    cloudRevision?: number
    recoverable: false
    note: string
  }> {
    const folder = checkFolder(folderInput)
    const found = await this.locate(folder)
    if (found === undefined) fail('not_found', `没有找到技能：${folder}`)
    if (await isSymlink(found.dir)) fail('unsupported', `技能目录是链接，不在这里删除：${folder}`)
    const entry = await this.describe(folder, found.dir, found.area === 'root', await this.uploaded())
    const files = await walkFiles(found.dir)
    return {
      folder,
      dir: found.dir,
      area: found.area,
      files: files.length,
      bytes: files.reduce((sum, file) => sum + file.bytes, 0),
      scripts: files.filter((file) => file.script).map((file) => file.path).slice(0, 20),
      origin: entry?.origin ?? 'unknown',
      ...(entry?.revision === undefined ? {} : { cloudRevision: entry.revision }),
      recoverable: false,
      note: '本机删除不可恢复（没有回收站）。云端副本不受影响，同步引擎也不会把同一版本再次拉回。',
    }
  }

  /**
   * Delete one skill for real: its folder is removed recursively.
   *
   * The route layer requires a plan token plus `confirmed: true`; this method
   * itself stays usable by the verification harness and by trusted callers.
   */
  async remove(folderInput: unknown): Promise<{ folder: string; dir: string; files: number; bytes: number }> {
    this.guardSync()
    const folder = checkFolder(folderInput)
    const found = await this.locate(folder)
    if (found === undefined) fail('not_found', `没有找到技能：${folder}`)
    const files = await walkFiles(found.dir)
    const bytes = files.reduce((sum, file) => sum + file.bytes, 0)
    await rm(found.dir, { recursive: true, force: true })
    this.deps.log(`skill deleted: ${folder}`)
    return { folder, dir: found.dir, files: files.length, bytes }
  }

  private async readPlans(): Promise<PlansFile> {
    try {
      const parsed: unknown = JSON.parse(await readFile(this.plansFile(), 'utf8'))
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const plans = (parsed as { plans?: unknown }).plans
        if (Array.isArray(plans)) return { version: 1, plans: plans as InstallPlan[] }
      }
    } catch {
      // Missing or torn file: no plans.
    }
    return { version: 1, plans: [] }
  }

  private async writePlans(file: PlansFile): Promise<void> {
    const path = this.plansFile()
    await mkdir(dirname(path), { recursive: true })
    const temporary = `${path}.tmp`
    await writeFile(temporary, `${JSON.stringify(file, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
    await rename(temporary, path)
  }

  /** Drop expired plans and their staging trees. */
  private async sweepPlans(file: PlansFile): Promise<PlansFile> {
    const now = Date.now()
    const live: InstallPlan[] = []
    for (const plan of file.plans) {
      if (plan.expiresAt > now) {
        live.push(plan)
        continue
      }
      await rm(plan.stagingDir, { recursive: true, force: true }).catch(() => {})
    }
    return { version: 1, plans: live }
  }

  /**
   * Stage a git repository and describe its skills. Nothing enters the skills
   * root here; the caller picks folders and commits.
   */
  async prepareInstall(urlInput: unknown, options: { ref?: string; source?: SkillInstallSource } = {}): Promise<{
    planId: string
    url: string
    expiresAt: number
    commit?: string
    candidates: (InstallPlanCandidate & { id: string })[]
  }> {
    this.guardSync()
    if (typeof urlInput !== 'string') fail('invalid_url', '请提供仓库地址。')
    const url = urlInput.trim()
    if (!/^(https:\/\/|file:\/\/)/.test(url) || /[\s"'`]/.test(url) || url.length > 512) {
      fail('invalid_url', '只接受 https:// 或 file:// 的 git 仓库地址。')
    }
    const stagingRoot = this.stagingRoot()
    await mkdir(stagingRoot, { recursive: true })
    const planId = `plan_${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`
    const stagingDir = join(stagingRoot, planId)
    try {
      await execFileText('git', ['clone', '--depth', '1', '--no-tags', '--', url, stagingDir])
      if (typeof options.ref === 'string' && options.ref !== '') {
        try {
          await execFileText('git', ['-C', stagingDir, 'fetch', '--depth', '1', 'origin', options.ref])
          await execFileText('git', ['-C', stagingDir, 'checkout', '--detach', 'FETCH_HEAD'])
        } catch {
          // The default-branch clone is still usable; the recorded commit below
          // is whatever was actually checked out, so an install stays auditable.
        }
      }
    } catch (error) {
      await rm(stagingDir, { recursive: true, force: true }).catch(() => {})
      const code = (error as NodeJS.ErrnoException).code
      fail('git_failed', code === 'ENOENT'
        ? '本机没有 git 命令，无法从仓库安装技能。'
        : '仓库克隆失败（地址不可达、需要登录，或不是 git 仓库）。')
    }
    let commit = ''
    try {
      commit = (await execFileText('git', ['-C', stagingDir, 'rev-parse', 'HEAD'], 20_000)).trim()
    } catch {
      commit = ''
    }
    const repoName = basename(url.replace(/\/$/, '').replace(/\.git$/, '')) || 'skill'
    const found: { folder: string; dir: string }[] = []
    const collect = async (dir: string, depth: number): Promise<void> => {
      if (found.length >= MAX_CANDIDATES) return
      const markdown = await readFile(join(dir, 'SKILL.md'), 'utf8').catch(() => undefined)
      if (markdown !== undefined) {
        found.push({ folder: dir === stagingDir ? repoName : basename(dir), dir })
        return
      }
      if (depth >= 3) return
      for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
        if (entry.isDirectory() && entry.name !== '.git' && !entry.isSymbolicLink()) {
          await collect(join(dir, entry.name), depth + 1)
        }
      }
    }
    await collect(stagingDir, 0)
    if (found.length === 0) {
      await rm(stagingDir, { recursive: true, force: true }).catch(() => {})
      fail('no_skills_found', '仓库里没有找到技能（包含 SKILL.md 的文件夹）。')
    }
    const candidates: InstallPlanCandidate[] = []
    for (const candidate of found) {
      const markdown = await readFile(join(candidate.dir, 'SKILL.md'), 'utf8').catch(() => '')
      const frontmatter = parseSkillFrontmatter(markdown)
      const files = await walkFiles(candidate.dir)
      const bytes = files.reduce((sum, file) => sum + file.bytes, 0)
      const existing = await this.locate(candidate.folder)
      let problem: string | undefined
      try {
        checkFolder(candidate.folder)
      } catch {
        problem = '目录名不合法，不能作为技能目录'
      }
      if (problem === undefined && files.length > MAX_SKILL_FILES) problem = `文件过多（>${MAX_SKILL_FILES}）`
      if (problem === undefined && bytes > MAX_SKILL_BYTES) problem = `体积过大（>${MAX_SKILL_BYTES} 字节）`
      const name = frontmatter.name
      candidates.push({
        folder: candidate.folder,
        name: typeof name === 'string' && name !== '' ? name : candidate.folder,
        description: String(frontmatter.description ?? '').slice(0, 300),
        files: files.length,
        bytes,
        scripts: files.filter((file) => file.script).map((file) => file.path).slice(0, 20),
        conflict: existing !== undefined,
        ...(existing === undefined ? {} : { conflictLocation: existing.area }),
        ...(problem === undefined ? {} : { problem }),
        rel: relative(stagingDir, candidate.dir),
      })
    }
    const plan: InstallPlan = {
      id: planId,
      kind: 'install',
      url,
      createdAt: Date.now(),
      expiresAt: Date.now() + PLAN_TTL_MS,
      stagingDir,
      candidates,
      ...(commit === '' ? {} : { commit }),
      ...(typeof options.ref === 'string' && options.ref !== '' ? { ref: options.ref } : {}),
      ...(options.source === undefined ? {} : { source: options.source }),
    }
    const file = await this.sweepPlans(await this.readPlans())
    file.plans.push(plan)
    await this.writePlans(file)
    this.deps.log(`skill install staged: ${url} -> ${planId} (${candidates.length} candidates)`)
    return {
      planId,
      url,
      expiresAt: plan.expiresAt,
      ...(commit === '' ? {} : { commit }),
      candidates: candidates.map((candidate) => ({ ...candidate, id: candidate.folder })) as (InstallPlanCandidate & { id: string })[],
    }
  }

  /** Install the folders the user picked from a staged plan. */
  async commitInstall(planInput: { planId?: unknown; folders?: unknown }): Promise<{
    installed: string[]
    skipped: { folder: string; reason: string }[]
    remaining: string[]
  }> {
    this.guardSync()
    const planId = typeof planInput.planId === 'string' ? planInput.planId : ''
    if (planId === '') fail('invalid_plan', '缺少安装计划 id。')
    const selection = Array.isArray(planInput.folders) ? planInput.folders : []
    const file = await this.sweepPlans(await this.readPlans())
    const plan = file.plans.find((item) => item.id === planId)
    if (plan === undefined) {
      await this.writePlans(file)
      fail('plan_expired', '安装计划已过期或不存在，请重新拉取仓库。')
    }
    const wanted = selection.map((value) => checkFolder(value))
    const installed: string[] = []
    const skipped: { folder: string; reason: string }[] = []
    const skillsRoot = resolve(this.deps.skillsRoot())
    await mkdir(skillsRoot, { recursive: true })
    for (const candidate of plan.candidates) {
      if (!wanted.includes(candidate.folder)) continue
      if (candidate.problem !== undefined) {
        skipped.push({ folder: candidate.folder, reason: candidate.problem })
        continue
      }
      const existing = await this.locate(candidate.folder)
      if (existing !== undefined) {
        skipped.push({ folder: candidate.folder, reason: existing.area === 'holding' ? 'already_exists_disabled' : 'already_exists' })
        continue
      }
      const stagingRoot = resolve(plan.stagingDir)
      const source = candidate.rel !== undefined && candidate.rel !== ''
        ? resolve(stagingRoot, candidate.rel)
        : candidate.folder === basename(plan.stagingDir) ? stagingRoot : resolve(stagingRoot, candidate.folder)
      const target = resolve(skillsRoot, candidate.folder)
      // Both sides must stay inside their own root: a crafted plan file cannot
      // make this write outside the skills directory.
      if (!source.startsWith(stagingRoot) || !target.startsWith(`${skillsRoot}${sep}`)) {
        skipped.push({ folder: candidate.folder, reason: 'path_escape' })
        continue
      }
      await cp(source, target, {
        recursive: true,
        // `.git` never travels with a skill, and a link could point outside the
        // repository: both are dropped rather than copied.
        filter: (sourcePath) => !sourcePath.split(/[\\/]/).includes('.git') && !isSymlinkSync(sourcePath),
      })
      // Record provenance so the skill can later be diffed, updated and rolled
      // back without the cloud center. The file holds no credentials.
      if (plan.commit !== undefined && plan.commit !== '') {
        const record: SkillSourceRecord = {
          version: 1,
          provider: plan.source?.provider ?? 'git',
          repoUrl: plan.url,
          ref: plan.ref ?? plan.commit,
          commit: plan.commit,
          sourcePath: candidate.rel ?? candidate.folder,
          installedAt: new Date().toISOString(),
          ...(plan.source?.entryId === undefined ? {} : { entryId: plan.source.entryId }),
          ...(plan.source?.version === undefined ? {} : { marketVersion: plan.source.version }),
        }
        await writeFile(join(target, '.skill-source.json'), `${JSON.stringify(record, null, 2)}\n`, 'utf8').catch(() => {})
      }
      installed.push(candidate.folder)
      this.deps.log(`skill installed from git: ${candidate.folder}`)
    }
    const remaining = plan.candidates
      .filter((candidate) => !installed.includes(candidate.folder))
      .map((candidate) => candidate.folder)
    file.plans = file.plans.filter((item) => item.id !== planId)
    await this.writePlans(file)
    await rm(plan.stagingDir, { recursive: true, force: true }).catch(() => {})
    return { installed, skipped, remaining }
  }

  /** Throw away a staged plan and its clone. */
  async cancelInstall(planInput: { planId?: unknown }): Promise<{ cancelled: string }> {
    const planId = typeof planInput.planId === 'string' ? planInput.planId : ''
    if (planId === '') fail('invalid_plan', '缺少安装计划 id。')
    const file = await this.sweepPlans(await this.readPlans())
    const plan = file.plans.find((item) => item.id === planId)
    file.plans = file.plans.filter((item) => item.id !== planId)
    await this.writePlans(file)
    if (plan !== undefined) await rm(plan.stagingDir, { recursive: true, force: true }).catch(() => {})
    return { cancelled: planId }
  }

  /**
   * Legacy one-shot install, kept for the standalone `/dsh-brain/skills`
   * page: stage the repository, then install every candidate that neither
   * collides with an existing skill nor trips a limit. It still never
   * overwrites and never executes repository content.
   */
  async installFromGit(urlInput: unknown): Promise<{ installed: string[]; skipped: { name: string; reason: string }[] }> {
    const plan = await this.prepareInstall(urlInput)
    const folders = plan.candidates
      .filter((candidate) => candidate.conflict !== true && candidate.problem === undefined)
      .map((candidate) => candidate.folder)
    const result = await this.commitInstall({ planId: plan.planId, folders })
    const skipped = plan.candidates
      .filter((candidate) => !result.installed.includes(candidate.folder))
      .map((candidate) => ({
        name: candidate.folder,
        reason: candidate.conflict === true
          ? (candidate.conflictLocation === 'holding' ? 'already_exists_disabled' : 'already_exists')
          : candidate.problem ?? 'skipped',
      }))
    return { installed: result.installed, skipped }
  }

  /** Pending plans, so a reloaded page can resume a staged install. */
  async listPlans(): Promise<{ plans: { planId: string; url: string; expiresAt: number; folders: string[] }[] }> {    const file = await this.sweepPlans(await this.readPlans())
    await this.writePlans(file)
    return {
      plans: file.plans.map((plan) => ({
        planId: plan.id,
        url: plan.url,
        expiresAt: plan.expiresAt,
        folders: plan.candidates.map((candidate) => candidate.folder),
      })),
    }
  }
}
