// v1.1 verification: cross-software / workspace inventory + dsh-brain migration.
import http from 'node:http'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HOME = mkdtempSync(join(tmpdir(), 'brain-homev11-'))
process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'brain-v11-'))
const DSH = process.env.DSH_HOME

const results = []
function check(name, ok, detail) {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail === undefined ? '' : ` :: ${detail}`}`)
}
function writeSkill(dir, folder, md) {
  mkdirSync(join(dir, folder), { recursive: true })
  writeFileSync(join(dir, folder, 'SKILL.md'), md)
}

// Global skills for DSH + Codex.
writeSkill(join(DSH, 'skills'), 'dsh-one', '---\nname: dsh-one\ndescription: dsh\n---\n# dsh-one\n')
writeSkill(join(HOME, '.codex', 'skills'), 'cx-one', '---\nname: cx-one\ndescription: codex skill\n---\n# cx-one\n')

// A DSH registry workspace with a workspace-local DSH skills folder.
const wsPath = join(HOME, 'proj-a')
writeSkill(join(wsPath, '.dsh', 'skills'), 'ws-skill', '---\nname: ws-skill\n---\n# ws\n')
writeFileSync(join(DSH, 'workspace-groups.folders.json'), JSON.stringify({ version: 1, workspaces: { group1: { folders: [], members: [{ path: wsPath, workspaceId: 'ws-a', kind: 'local' }] } } }))
writeFileSync(join(DSH, 'workspace-groups.manual.json'), JSON.stringify({ assignments: { 'ws-a': '开发' } }))

const { ClientRegistry } = await import('./lib/clients.js')
const registry = new ClientRegistry({
  home: () => HOME,
  manualPath: () => join(DSH, 'dsh-brain-workspaces.json'),
  dshRegistryPath: () => join(DSH, 'workspace-groups.folders.json'),
  dshManualPath: () => join(DSH, 'workspace-groups.manual.json'),
})

const adapters = registry.adapters()
check('six software adapters are reported', adapters.length === 6)
check('installed flags follow the config roots', adapters.find((a) => a.id === 'codex')?.installed === true && adapters.find((a) => a.id === 'opencode')?.installed === false)
check('only DSH is writable', adapters.filter((a) => a.writable).map((a) => a.id).join(',') === 'dsh')

const codexGlobal = await registry.inventory('codex', 'global')
check('codex global inventory is read-only', codexGlobal.items.length === 1 && codexGlobal.items[0].writable === false && codexGlobal.items[0].name === 'cx-one')

const dshWorkspaces = await registry.workspaces('dsh')
check('DSH registry workspace is discovered with its category', dshWorkspaces.some((w) => w.path === wsPath && w.category === '开发'), JSON.stringify(dshWorkspaces))
const wsInv = await registry.inventory('dsh', 'workspace', 'ws-a')
check('DSH workspace inventory finds the workspace-only skill', wsInv.items.length === 1 && wsInv.items[0].folder === 'ws-skill', JSON.stringify(wsInv))

// Manual workspace for Claude Code.
const claudeWs = join(HOME, 'proj-claude')
writeSkill(join(claudeWs, '.claude', 'skills'), 'cl-one', '---\nname: cl-one\n---\n# cl\n')
const added = await registry.addWorkspace('claude', claudeWs, 'ProjC')
check('manual workspace is registered', added.path === claudeWs && added.source === 'manual')
const clInv = await registry.inventory('claude', 'workspace', added.id)
check('manual workspace inventory finds its skill', clInv.items.length === 1 && clInv.items[0].folder === 'cl-one')
check('workspace writes stay read-only for claude', clInv.items[0].writable === false)
let dup = false
try { await registry.addWorkspace('claude', claudeWs, 'again') } catch (e) { dup = e.message === 'duplicate' }
check('duplicate workspace is refused', dup)
let unknown = false
try { await registry.inventory('dsh', 'workspace', 'nope') } catch (e) { unknown = e.message === 'unknown_workspace' }
check('unknown workspace is refused', unknown)

// Routes expose the same data.
const { createRoutes } = await import('./lib/routes.js')
const { SettingsStore } = await import('./lib/store.js')
const { Reporter } = await import('./lib/reporter.js')
const store = new SettingsStore({ clientId: 't' }, join(DSH, 'c.json'))
const reporter = new Reporter({ client: () => ({ reportTurn: async () => ({ ok: true, status: 200, data: {} }), submitSummary: async () => ({ ok: true, status: 200, data: {} }) }), settings: () => ({ enabled: true, clientId: 't' }), activityToken: () => '', summary: () => ({ enabled: false, maxChars: 1 }), summaryToken: () => '', log: () => {} })
const routes = createRoutes({ version: '0.8.0', store, reporter, client: () => ({ reach: async () => ({ ok: false, status: 0, message: 'x' }), listSkills: async () => ({ ok: true, status: 200, data: { items: [] } }) }), clients: registry })
const server = http.createServer((req, res) => {
  const path = (req.url ?? '/').split('?')[0]
  for (const route of routes) {
    if (route.kind === 'exact' && path === route.path) return route.handler(req, res)
    if (route.kind === 'prefix' && (path === route.path || path.startsWith(`${route.path}/`))) return route.handler(req, res)
  }
  res.writeHead(404); res.end('{"ok":false}')
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const origin = `http://127.0.0.1:${server.address().port}`
const capsRes = await fetch(`${origin}/dsh-brain/capabilities`).then((r) => r.json())
check('capabilities advertise multiClient', capsRes.features?.multiClient === true && capsRes.features?.brainMigration === 'pending-deploy')
const overview = await fetch(`${origin}/dsh-brain/clients/overview`).then((r) => r.json())
check('overview route lists adapters and workspaces', overview.ok === true && overview.adapters.length === 6 && Array.isArray(overview.workspaces.dsh))
const invRoute = await fetch(`${origin}/dsh-brain/clients/inventory?software=codex&scope=global`).then((r) => r.json())
check('inventory route returns codex skills', invRoute.ok === true && invRoute.items.length === 1)
await new Promise((resolve) => server.close(resolve))

// dsh-brain migration.
const { brainStatus, migrateLegacyFiles } = await import('./lib/brain-migration.js')
writeFileSync(join(DSH, 'cloud-memory.json'), JSON.stringify({ version: 1, baseUrl: 'https://x/api/longmemory', activityToken: 'cmt_aaaaaaaaaaaaaaaaaaaa' }))
const st = await brainStatus()
check('migration is needed when only legacy files exist', st.migrationNeeded === true && st.packageRename === 'done')
const onceRun = await migrateLegacyFiles()
check('legacy config is copied to dsh-brain.json', onceRun.copied.includes('dsh-brain.json') && existsSync(join(DSH, 'dsh-brain.json')))
check('legacy file is retained', existsSync(join(DSH, 'cloud-memory.json')))
const target = JSON.parse(readFileSync(join(DSH, 'dsh-brain.json'), 'utf8'))
check('migrated data matches the legacy token', target.activityToken === 'cmt_aaaaaaaaaaaaaaaaaaaa')
const twiceRun = await migrateLegacyFiles()
check('migration is idempotent', twiceRun.copied.length === 0 && twiceRun.skipped.includes('dsh-brain.json'))

const passed = results.filter((r) => r.ok).length
console.log(`\n${passed}/${results.length} passed`)
process.exit(passed === results.length ? 0 : 1)
