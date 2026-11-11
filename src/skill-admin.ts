/**
 * Local skill management, built into the plugin: list, enable/disable,
 * real delete, and install from a git repository.
 *
 * This covers the everyday subset of a full skills manager. It manages
 * only the DSH skills root (plus its own parking and trash areas) — the
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
 * Delete is a real delete: the folder is removed recursively. The
 * cloud copy is unaffected — local deletion never propagates to the
 * center (the sync engine remembers the removal, so the same cloud
 * version is not pulled back down either).
 */
import { execFile } from 'node:child_process'
import { cp, mkdir, readFile, readdir, rename, rm, stat } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { parseSkillFrontmatter } from './skill-sync.ts'
import { dshHome } from './store.ts'

/** The parking area for disabled skills. */
export function skillsHoldingDir(): string {
  return join(dshHome(), 'skills-disabled')
}

/** A management failure with a stable machine-readable code. */
export class SkillAdminError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = 'SkillAdminError'
  }
}

function fail(code: string, message: string): never {
  throw new SkillAdminError(code, message)
}

/** One skill as the management page shows it. */
export interface AdminSkill {
  folder: string
  name: string
  description: string
  enabled: boolean
  origin: 'cloud' | 'uploaded' | 'local'
  revision?: number
  files: number
}

/** Dependencies of one admin instance. */
export interface SkillAdminDeps {
  skillsRoot: () => string
  holdingDir: () => string
  /** The sync sidecar (read-only here) for origin and revision facts. */
  syncStatePath: () => string
  /** True while a sync pass is running; mutations refuse meanwhile. */
  syncRunning: () => boolean
  log: (message: string) => void
}

async function isDirectory(path: string): Promise<boolean> {
  return stat(path).then((s) => s.isDirectory()).catch(() => false)
}

/** Count files below a directory, capped so a stray tree cannot hang us. */
async function countFiles(dir: string, cap = 2000): Promise<number> {
  let count = 0
  const walk = async (sub: string): Promise<void> => {
    if (count > cap) return
    for (const entry of await readdir(join(dir, sub), { withFileTypes: true }).catch(() => [])) {
      if (entry.name === '.git') continue
      const rel = sub === '' ? entry.name : `${sub}/${entry.name}`
      if (entry.isDirectory()) await walk(rel)
      else if (entry.isFile()) count += 1
    }
  }
  await walk('')
  return count
}

/** A folder name we are willing to move around: one path segment, no tricks. */
function checkFolder(folder: unknown): string {
  if (
    typeof folder !== 'string' || folder === '' || folder.length > 128 ||
    folder.startsWith('.') || folder.includes('/') || folder.includes('\\') || folder.includes('\0')
  ) {
    fail('invalid_name', `技能目录名无效：${String(folder)}`)
  }
  return folder
}

export class SkillAdmin {
  constructor(private readonly deps: SkillAdminDeps) {}

  private guardSync(): void {
    if (this.deps.syncRunning()) fail('sync_running', '技能同步正在进行，请稍候再试。')
  }

  private async syncUploaded(): Promise<Record<string, { folder?: string; revision?: number }>> {
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

  private async describe(folder: string, dir: string, enabled: boolean, uploaded: Record<string, { folder?: string; revision?: number }>): Promise<AdminSkill | undefined> {
    const markdown = await readFile(join(dir, 'SKILL.md'), 'utf8').catch(() => undefined)
    if (markdown === undefined) return undefined
    const frontmatter = parseSkillFrontmatter(markdown)
    let origin: AdminSkill['origin'] = 'local'
    let revision: number | undefined
    const delivery = await readFile(join(dir, '.manifest.json'), 'utf8').catch(() => undefined)
    if (delivery !== undefined) {
      origin = 'cloud'
      try {
        const parsed: unknown = JSON.parse(delivery)
        const value = (parsed as { revision?: unknown }).revision
        if (typeof value === 'number') revision = value
      } catch { /* a corrupt manifest still marks cloud origin */ }
    } else {
      for (const record of Object.values(uploaded)) {
        if (record.folder === folder) {
          origin = 'uploaded'
          revision = record.revision
          break
        }
      }
    }
    return {
      folder,
      name: frontmatter.name ?? folder,
      description: (frontmatter.description ?? '').slice(0, 300),
      enabled,
      origin,
      ...(revision === undefined ? {} : { revision }),
      files: await countFiles(dir),
    }
  }

  /** Inventory of the skills root and the parking area. */
  async list(): Promise<{ skills: AdminSkill[] }> {
    const uploaded = await this.syncUploaded()
    const skills: AdminSkill[] = []
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
    return { skills }
  }

  /** Locate a skill folder across the root and the parking area. */
  private async locate(folder: string): Promise<{ area: 'root' | 'holding'; dir: string } | undefined> {
    const rootDir = join(this.deps.skillsRoot(), folder)
    if (await isDirectory(rootDir)) return { area: 'root', dir: rootDir }
    const parkedDir = join(this.deps.holdingDir(), folder)
    if (await isDirectory(parkedDir)) return { area: 'holding', dir: parkedDir }
    return undefined
  }

  /** Enable (move back into the root) or disable (park) one skill. */
  async setEnabled(folderInput: unknown, enabled: boolean): Promise<{ folder: string; enabled: boolean }> {
    this.guardSync()
    const folder = checkFolder(folderInput)
    const found = await this.locate(folder)
    if (found === undefined) fail('not_found', `没有找到技能：${folder}`)
    const targetArea = enabled ? 'root' : 'holding'
    if (found.area === targetArea) return { folder, enabled }
    const targetRoot = enabled ? this.deps.skillsRoot() : this.deps.holdingDir()
    await mkdir(targetRoot, { recursive: true })
    const target = join(targetRoot, folder)
    if (await isDirectory(target)) fail('collision', `目标位置已存在同名技能：${folder}`)
    await rename(found.dir, target)
    this.deps.log(`skill ${enabled ? 'enabled' : 'disabled'}: ${folder}`)
    return { folder, enabled }
  }

  /** Delete one skill for real: its folder is removed recursively. */
  async remove(folderInput: unknown): Promise<{ folder: string }> {
    this.guardSync()
    const folder = checkFolder(folderInput)
    const found = await this.locate(folder)
    if (found === undefined) fail('not_found', `没有找到技能：${folder}`)
    await rm(found.dir, { recursive: true, force: true })
    this.deps.log(`skill deleted: ${folder}`)
    return { folder }
  }

  /**
   * Install every skill found in a git repository (https:// or file://).
   * The clone is shallow and never executes repository code; folders
   * that collide with existing skills are skipped, never overwritten.
   */
  async installFromGit(urlInput: unknown): Promise<{ installed: string[]; skipped: { name: string; reason: string }[] }> {
    this.guardSync()
    if (typeof urlInput !== 'string') fail('invalid_url', '请提供仓库地址。')
    const url = urlInput.trim()
    if (!/^(https:\/\/|file:\/\/)/.test(url) || /[\s"'`]/.test(url) || url.length > 512) {
      fail('invalid_url', '只接受 https:// 或 file:// 的 git 仓库地址。')
    }
    const scratch = join(dshHome(), `.cloud-memory-clone-${process.pid}-${Date.now().toString(36)}`)
    try {
      await new Promise<void>((resolvePromise, rejectPromise) => {
        execFile(
          'git',
          ['clone', '--depth', '1', '--no-tags', '--', url, scratch],
          { timeout: 120_000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }, maxBuffer: 4 * 1024 * 1024 },
          (error) => (error ? rejectPromise(error) : resolvePromise()),
        )
      })
    } catch {
      await rm(scratch, { recursive: true, force: true }).catch(() => {})
      fail('git_failed', '仓库克隆失败（地址不可达、需要登录，或本机没有 git）。')
    }
    try {
      const repoName = basename(url.replace(/\/$/, '').replace(/\.git$/, '')) || 'skill'
      const candidates: { folder: string; dir: string }[] = []
      const collect = async (dir: string, depth: number): Promise<void> => {
        if (await readFile(join(dir, 'SKILL.md'), 'utf8').catch(() => undefined) !== undefined) {
          candidates.push({ folder: dir === scratch ? repoName : basename(dir), dir })
          return
        }
        if (depth >= 3) return
        for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
          if (entry.isDirectory() && entry.name !== '.git') await collect(join(dir, entry.name), depth + 1)
        }
      }
      await collect(scratch, 0)
      if (candidates.length === 0) fail('no_skills_found', '仓库里没有找到技能（包含 SKILL.md 的文件夹）。')
      const installed: string[] = []
      const skipped: { name: string; reason: string }[] = []
      await mkdir(this.deps.skillsRoot(), { recursive: true })
      for (const candidate of candidates) {
        let folder = candidate.folder
        try {
          folder = checkFolder(folder)
        } catch {
          skipped.push({ name: candidate.folder, reason: 'invalid_name' })
          continue
        }
        if ((await this.locate(folder)) !== undefined) {
          skipped.push({ name: folder, reason: 'already_exists' })
          continue
        }
        await cp(candidate.dir, join(this.deps.skillsRoot(), folder), {
          recursive: true,
          filter: (source) => !source.split(/[\\/]/).includes('.git'),
        })
        installed.push(folder)
        this.deps.log(`skill installed from git: ${folder}`)
      }
      return { installed, skipped }
    } finally {
      await rm(scratch, { recursive: true, force: true }).catch(() => {})
    }
  }
}
