/**
 * Cross-software / workspace skill inventory (v1.1 §15).
 *
 * One adapter per client. It only reads directories the client itself publishes
 * (user-level skill roots and, when a workspace is known, that workspace's own
 * client folder). Nothing here writes another client's directory: DSH is the
 * only writable adapter in this build, and every other source is reported as
 * read-only instead of pretending a toggle works.
 *
 * Workspaces come from two bounded sources:
 *  - the DSH workspace-group registry the host already keeps (member paths);
 *  - directories the user explicitly adds here (persisted metadata only).
 * No full-disk scan, no chat history, no credential read.
 */
import { existsSync } from 'node:fs'
import { readFile, readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { dshHome, migrateLegacyFile } from './store.ts'
import { parseSkillFrontmatter } from './skill-sync.ts'
import { SkillAdmin } from './skill-admin.ts'

export type SoftwareId = 'dsh' | 'agents' | 'codex' | 'workbuddy' | 'claude' | 'opencode'

export interface SoftwareAdapterInfo {
  id: SoftwareId
  label: string
  installed: boolean
  configRoot: string
  globalSkillsRoot: string
  writable: boolean
  workspaceSupported: boolean
  notes: string[]
}

export interface WorkspaceRecord {
  id: string
  name: string
  path: string
  source: 'dsh-registry' | 'manual'
  category?: string
}

export interface ClientInventoryItem {
  folder: string
  name: string
  description: string
  path: string
  softwareId: SoftwareId
  scope: 'global' | 'workspace'
  workspaceId?: string
  writable: boolean
  enabled?: boolean
}

export interface ClientCapabilityView {
  id: SoftwareId
  label: string
  readGlobal: boolean
  writeGlobal: boolean
  workspaceRead: boolean
  workspaceWrite: boolean
  hotReload: boolean
  verify: boolean
  notes: string[]
}

interface Roots {
  configRoot: string
  globalSkillsRoot: string
  /** Workspace-relative skill directories, first existing wins. */
  workspaceSubdirs: string[]
}

/** Manual workspace additions live in the plugin's own metadata file. */
export function manualWorkspacesPath(): string {
  const target = join(dshHome(), 'dsh-brain-workspaces.json')
  migrateLegacyFile(target, join(dshHome(), 'cloud-memory-workspaces.json'))
  return target
}

interface ManualFile {
  version: 1
  items: { softwareId: SoftwareId; id: string; name: string; path: string }[]
}

function rootsOf(home: string): Record<SoftwareId, Roots> {
  return {
    dsh: { configRoot: dshHome(), globalSkillsRoot: join(dshHome(), 'skills'), workspaceSubdirs: [join('.dsh', 'skills')] },
    agents: { configRoot: join(home, '.agents'), globalSkillsRoot: join(home, '.agents', 'skills'), workspaceSubdirs: [] },
    codex: { configRoot: join(home, '.codex'), globalSkillsRoot: join(home, '.codex', 'skills'), workspaceSubdirs: [join('.codex', 'skills')] },
    workbuddy: { configRoot: join(home, '.workbuddy'), globalSkillsRoot: join(home, '.workbuddy', 'skills'), workspaceSubdirs: [] },
    claude: { configRoot: join(home, '.claude'), globalSkillsRoot: join(home, '.claude', 'skills'), workspaceSubdirs: [join('.claude', 'skills')] },
    opencode: { configRoot: join(home, '.config', 'opencode'), globalSkillsRoot: join(home, '.config', 'opencode', 'skills'), workspaceSubdirs: [join('.opencode', 'skills'), join('.opencode', 'skill')] },
  }
}

const LABELS: Record<SoftwareId, string> = {
  dsh: 'DSH',
  agents: '公共 Agent',
  codex: 'Codex',
  workbuddy: 'WorkBuddy',
  claude: 'Claude Code',
  opencode: 'OpenCode',
}

const SOFTWARE: SoftwareId[] = ['dsh', 'agents', 'codex', 'workbuddy', 'claude', 'opencode']

export interface ClientRegistryDeps {
  home?: () => string
  manualPath?: () => string
  dshRegistryPath?: () => string
  dshManualPath?: () => string
}

export class ClientRegistry {
  private readonly deps: ClientRegistryDeps
  constructor(deps: ClientRegistryDeps = {}) {
    this.deps = deps
  }

  private home(): string {
    return this.deps.home?.() ?? homedir()
  }

  private roots(): Record<SoftwareId, Roots> {
    return rootsOf(this.home())
  }

  adapters(): SoftwareAdapterInfo[] {
    const roots = this.roots()
    return SOFTWARE.map((id) => {
      const root = roots[id]
      const installed = existsSync(root.configRoot)
      const notes: string[] = []
      if (!installed) notes.push('未检测到安装目录')
      const writable = id === 'dsh'
      if (!writable) notes.push('本卡只读，不修改该软件的技能目录')
      return {
        id,
        label: LABELS[id],
        installed,
        configRoot: root.configRoot,
        globalSkillsRoot: root.globalSkillsRoot,
        writable,
        workspaceSupported: root.workspaceSubdirs.length > 0,
        notes,
      }
    })
  }

  capabilities(): ClientCapabilityView[] {
    return this.adapters().map((adapter) => ({
      id: adapter.id,
      label: adapter.label,
      readGlobal: true,
      writeGlobal: adapter.writable,
      workspaceRead: adapter.workspaceSupported,
      // Workspace-level writes are implemented for DSH only; every other client
      // stays read-only so nothing is written into a format we cannot verify.
      workspaceWrite: adapter.id === 'dsh' && adapter.workspaceSupported,
      hotReload: adapter.id === 'dsh',
      verify: true,
      notes: adapter.notes,
    }))
  }

  /**
   * A workspace-scoped SkillAdmin for the DSH adapter. The skills root is the
   * workspace's own `.dsh/skills`; parked skills go to a per-workspace holding
   * area so one project can never unpark another's skill. Only DSH is allowed.
   */
  async workspaceSkillAdmin(softwareInput: unknown, workspaceIdInput: unknown): Promise<{ admin: SkillAdmin; workspace: WorkspaceRecord }> {
    const software = SOFTWARE.includes(softwareInput as SoftwareId) ? softwareInput as SoftwareId : undefined
    if (software !== 'dsh') throw new Error('unsupported_workspace_write')
    const workspaceId = typeof workspaceIdInput === 'string' ? workspaceIdInput : ''
    const workspace = (await this.workspaces('dsh')).find((item) => item.id === workspaceId)
    if (workspace === undefined) throw new Error('unknown_workspace')
    const skillsRoot = resolve(workspace.path, '.dsh', 'skills')
    const holdingDir = join(dshHome(), 'skills-workspace-disabled', workspace.id)
    const stateName = `${workspace.id.replace(/[^A-Za-z0-9_-]/g, '_')}.json`
    const statePath = join(dshHome(), `dsh-brain-workspace-${stateName}`)
    migrateLegacyFile(statePath, join(dshHome(), `cloud-memory-workspace-${stateName}`))
    const admin = new SkillAdmin({
      skillsRoot: () => skillsRoot,
      holdingDir: () => holdingDir,
      syncStatePath: () => statePath,
      syncRunning: () => false,
      log: () => {},
    })
    return { admin, workspace }
  }

  private async readManual(): Promise<ManualFile> {
    const path = this.deps.manualPath?.() ?? manualWorkspacesPath()
    try {
      const parsed: unknown = JSON.parse(await readFile(path, 'utf8'))
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const raw = parsed as { items?: unknown }
        const items = Array.isArray(raw.items)
          ? raw.items.filter((item): item is ManualFile['items'][number] => (
              item !== null && typeof item === 'object'
              && typeof (item as ManualFile['items'][number]).softwareId === 'string'
              && typeof (item as ManualFile['items'][number]).path === 'string'
            ))
          : []
        return { version: 1, items }
      }
    } catch {
      // Missing sidecar: no manual workspaces yet.
    }
    return { version: 1, items: [] }
  }

  private async writeManual(file: ManualFile): Promise<void> {
    const path = this.deps.manualPath?.() ?? manualWorkspacesPath()
    const { mkdir, writeFile } = await import('node:fs/promises')
    await mkdir(join(path, '..'), { recursive: true })
    await writeFile(path, `${JSON.stringify(file, null, 2)}\n`, 'utf8')
  }

  /** DSH workspaces come from the host's own workspace-group registry. */
  private async dshRegistryWorkspaces(): Promise<WorkspaceRecord[]> {
    const path = this.deps.dshRegistryPath?.() ?? join(dshHome(), 'workspace-groups.folders.json')
    const categoriesPath = this.deps.dshManualPath?.() ?? join(dshHome(), 'workspace-groups.manual.json')
    let categories = new Map<string, string>()
    try {
      const raw = JSON.parse(await readFile(categoriesPath, 'utf8')) as { assignments?: Record<string, string> }
      if (raw.assignments !== null && typeof raw.assignments === 'object') {
        categories = new Map(Object.entries(raw.assignments))
      }
    } catch {
      // No category mapping: names fall back to the folder name.
    }
    try {
      const raw = JSON.parse(await readFile(path, 'utf8')) as { workspaces?: Record<string, { members?: { path?: unknown; workspaceId?: unknown }[] }> }
      const out: WorkspaceRecord[] = []
      const seen = new Set<string>()
      for (const [groupId, group] of Object.entries(raw.workspaces ?? {})) {
        for (const member of group.members ?? []) {
          if (typeof member.path !== 'string' || member.path === '' || seen.has(member.path)) continue
          seen.add(member.path)
          const id = typeof member.workspaceId === 'string' && member.workspaceId !== '' ? member.workspaceId : groupId
          const parts = member.path.split(/[\\/]/).filter((part) => part !== '')
          const category = categories.get(id)
          out.push({ id, name: parts[parts.length - 1] ?? member.path, path: member.path, source: 'dsh-registry', ...(category === undefined ? {} : { category }) })
        }
      }
      return out
    } catch {
      return []
    }
  }

  async workspaces(software: SoftwareId): Promise<WorkspaceRecord[]> {
    const manual = (await this.readManual()).items.filter((item) => item.softwareId === software)
    const fromManual: WorkspaceRecord[] = manual.map((item) => ({ id: item.id, name: item.name, path: item.path, source: 'manual' }))
    if (software === 'dsh') {
      const registry = await this.dshRegistryWorkspaces()
      const byPath = new Set(registry.map((item) => item.path))
      return [...registry, ...fromManual.filter((item) => !byPath.has(item.path))]
    }
    return fromManual
  }

  async addWorkspace(softwareInput: unknown, pathInput: unknown, nameInput: unknown): Promise<WorkspaceRecord> {
    const software = SOFTWARE.includes(softwareInput as SoftwareId) ? softwareInput as SoftwareId : undefined
    if (software === undefined) throw new Error('invalid_software')
    const path = typeof pathInput === 'string' ? pathInput.trim() : ''
    if (path === '' || !existsSync(path)) throw new Error('invalid_path')
    const stats = await stat(path).catch(() => undefined)
    if (stats === undefined || !stats.isDirectory()) throw new Error('invalid_path')
    const resolved = resolve(path)
    const file = await this.readManual()
    if (file.items.some((item) => item.softwareId === software && resolve(item.path) === resolved)) throw new Error('duplicate')
    const name = typeof nameInput === 'string' && nameInput.trim() !== '' ? nameInput.trim() : resolved.split(sep).filter((part) => part !== '').pop() ?? resolved
    const record: WorkspaceRecord = { id: `ws_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`, name, path: resolved, source: 'manual' }
    file.items.push({ softwareId: software, id: record.id, name: record.name, path: record.path })
    await this.writeManual(file)
    return record
  }

  async removeWorkspace(softwareInput: unknown, idInput: unknown): Promise<{ removed: string }> {
    const software = SOFTWARE.includes(softwareInput as SoftwareId) ? softwareInput as SoftwareId : undefined
    const id = typeof idInput === 'string' ? idInput : ''
    const file = await this.readManual()
    const before = file.items.length
    file.items = file.items.filter((item) => !(item.softwareId === software && item.id === id))
    if (file.items.length === before) throw new Error('not_found')
    await this.writeManual(file)
    return { removed: id }
  }

  private async inventoryOf(dir: string, software: SoftwareId, scope: 'global' | 'workspace', workspaceId?: string): Promise<ClientInventoryItem[]> {
    const out: ClientInventoryItem[] = []
    // DSH global and DSH workspace roots are writable by this build; every
    // other client (and every non-DSH workspace) is read-only.
    const writable = software === 'dsh'
    for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue
      const skillDir = join(dir, entry.name)
      const markdown = await readFile(join(skillDir, 'SKILL.md'), 'utf8').catch(() => undefined)
      if (markdown === undefined) continue
      const frontmatter = parseSkillFrontmatter(markdown)
      out.push({
        folder: entry.name,
        name: typeof frontmatter.name === 'string' && frontmatter.name !== '' ? frontmatter.name : entry.name,
        description: String(frontmatter.description ?? '').slice(0, 300),
        path: skillDir,
        softwareId: software,
        scope,
        ...(workspaceId === undefined ? {} : { workspaceId }),
        writable,
      })
    }
    out.sort((a, b) => (a.folder < b.folder ? -1 : 1))
    return out
  }

  async inventory(softwareInput: unknown, scopeInput: unknown, workspaceIdInput?: unknown): Promise<{ softwareId: SoftwareId; scope: 'global' | 'workspace'; workspace?: WorkspaceRecord; items: ClientInventoryItem[]; note: string }> {
    const software = SOFTWARE.includes(softwareInput as SoftwareId) ? softwareInput as SoftwareId : undefined
    if (software === undefined) throw new Error('invalid_software')
    const scope = scopeInput === 'workspace' ? 'workspace' : 'global'
    const roots = this.roots()[software]
    if (scope === 'global') {
      return { softwareId: software, scope, items: await this.inventoryOf(roots.globalSkillsRoot, software, 'global'), note: software === 'dsh' ? 'DSH 全局技能目录。' : '该软件的用户级技能目录，本卡只读。' }
    }
    const workspaceId = typeof workspaceIdInput === 'string' ? workspaceIdInput : ''
    const workspace = (await this.workspaces(software)).find((item) => item.id === workspaceId)
    if (workspace === undefined) throw new Error('unknown_workspace')
    // DSH workspace skills are enumerated through a workspace-scoped SkillAdmin
    // so the list, the enabled flag and the inventory agree with the write path.
    if (software === 'dsh') {
      const { admin } = await this.workspaceSkillAdmin('dsh', workspace.id)
      const listed = await admin.list()
      const items: ClientInventoryItem[] = listed.skills.map((skill) => ({
        folder: skill.folder,
        name: skill.name,
        description: skill.description,
        path: join(skill.enabled ? listed.root : listed.holding, skill.folder),
        softwareId: 'dsh',
        scope: 'workspace',
        workspaceId: workspace.id,
        writable: true,
        enabled: skill.enabled,
      }))
      return { softwareId: 'dsh', scope, workspace, items, note: `DSH 工作区技能目录：${join(workspace.path, '.dsh', 'skills')}` }
    }
    for (const sub of roots.workspaceSubdirs) {
      const dir = resolve(workspace.path, sub)
      if (existsSync(dir)) {
        return { softwareId: software, scope, workspace, items: await this.inventoryOf(dir, software, 'workspace', workspace.id), note: `工作区专属目录：${dir}` }
      }
    }
    return { softwareId: software, scope, workspace, items: [], note: `该工作区没有 ${LABELS[software]} 的专属技能目录；不会写通用配置替代。` }
  }

  async overview(): Promise<{ adapters: SoftwareAdapterInfo[]; capabilities: ClientCapabilityView[]; workspaces: Record<string, WorkspaceRecord[]>; brain: { product: string; targetPackage: string; legacyPackage: string } }> {
    const workspaces: Record<string, WorkspaceRecord[]> = {}
    for (const id of SOFTWARE) workspaces[id] = await this.workspaces(id)
    return {
      adapters: this.adapters(),
      capabilities: this.capabilities(),
      workspaces,
      brain: { product: 'DSH Brain', targetPackage: 'dsh-brain', legacyPackage: 'dsh-cloud-memory' },
    }
  }
}
