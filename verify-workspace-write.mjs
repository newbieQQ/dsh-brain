// v1.1 workspace-write verification (MULTI-04 / MULTI-07).
//
// DSH workspace skills are writable through a workspace-scoped SkillAdmin. The
// test proves isolation: changing one workspace never touches the global DSH
// root or another workspace, and non-DSH workspace writes are refused.
import http from 'node:http'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HOME = mkdtempSync(join(tmpdir(), 'brain-wswrite-home-'))
process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'brain-wswrite-'))
const DSH = process.env.DSH_HOME

const results = []
function check(name, ok, detail) {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail === undefined ? '' : ` :: ${detail}`}`)
}
function writeSkill(root, folder) {
  mkdirSync(join(root, folder), { recursive: true })
  writeFileSync(join(root, folder, 'SKILL.md'), `---\nname: ${folder}\n---\n# ${folder}\n`)
}

const wsA = join(HOME, 'proj-a')
const wsB = join(HOME, 'proj-b')
writeSkill(join(wsA, '.dsh', 'skills'), 'a-skill')
writeSkill(join(wsA, '.dsh', 'skills'), 'a-extra')
writeSkill(join(wsB, '.dsh', 'skills'), 'b-skill')
writeSkill(join(DSH, 'skills'), 'g-skill')
writeFileSync(join(DSH, 'workspace-groups.folders.json'), JSON.stringify({
  version: 1,
  workspaces: {
    g: { folders: [], members: [{ path: wsA, workspaceId: 'ws-a' }, { path: wsB, workspaceId: 'ws-b' }] },
  },
}))
writeFileSync(join(DSH, 'workspace-groups.manual.json'), JSON.stringify({ assignments: {} }))

const { ClientRegistry } = await import('./lib/clients.js')
const registry = new ClientRegistry({
  home: () => HOME,
  manualPath: () => join(DSH, 'dsh-brain-workspaces.json'),
  dshRegistryPath: () => join(DSH, 'workspace-groups.folders.json'),
  dshManualPath: () => join(DSH, 'workspace-groups.manual.json'),
})

const caps = registry.capabilities()
check('workspace write is enabled for DSH only', caps.find((c) => c.id === 'dsh')?.workspaceWrite === true && caps.find((c) => c.id === 'codex')?.workspaceWrite === false)

const invA0 = await registry.inventory('dsh', 'workspace', 'ws-a')
check('workspace inventory lists its skills as writable', invA0.items.length === 2 && invA0.items.every((item) => item.writable === true), JSON.stringify(invA0.items.map((i) => [i.folder, i.writable])))

const { admin } = await registry.workspaceSkillAdmin('dsh', 'ws-a')
const off = await admin.setEnabled('a-skill', false)
check('disabling a workspace skill parks it', off.enabled === false && !existsSync(join(wsA, '.dsh', 'skills', 'a-skill')))
check('parking keeps the global root and project B untouched', existsSync(join(DSH, 'skills', 'g-skill')) && existsSync(join(wsB, '.dsh', 'skills', 'b-skill')) && !existsSync(join(DSH, 'skills', 'a-skill')))
const invA1 = await registry.inventory('dsh', 'workspace', 'ws-a')
check('inventory reflects the disabled state', invA1.items.find((i) => i.folder === 'a-skill')?.enabled === false)
await admin.setEnabled('a-skill', true)
check('re-enabling restores the workspace skill', existsSync(join(wsA, '.dsh', 'skills', 'a-skill')))

await admin.remove('a-extra')
check('removing one workspace skill leaves the others', !existsSync(join(wsA, '.dsh', 'skills', 'a-extra')) && existsSync(join(wsA, '.dsh', 'skills', 'a-skill')))
check('removal never touched project B', existsSync(join(wsB, '.dsh', 'skills', 'b-skill')))

// Install from a git repo into the workspace root.
const repoDir = join(HOME, 'repo')
writeSkill(repoDir, 'new-skill')
execFileSync('git', ['init', '-b', 'main'], { cwd: repoDir })
execFileSync('git', ['-C', repoDir, 'add', '-A'])
execFileSync('git', ['-C', repoDir, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-m', 'init'])
const plan = await admin.prepareInstall('file://' + repoDir.replace(/\\/g, '/'))
const committed = await admin.commitInstall({ planId: plan.planId, folders: ['new-skill'] })
check('workspace install commits into the workspace root', committed.installed.includes('new-skill') && existsSync(join(wsA, '.dsh', 'skills', 'new-skill', 'SKILL.md')))
check('workspace install leaves global and B unchanged', !existsSync(join(DSH, 'skills', 'new-skill')) && !existsSync(join(wsB, '.dsh', 'skills', 'new-skill')))

let refused = false
try { await registry.workspaceSkillAdmin('codex', 'ws-a') } catch (e) { refused = e.message === 'unsupported_workspace_write' }
check('non-DSH workspace writes are refused', refused)

// Route layer.
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
const invRoute = await fetch(`${origin}/dsh-brain/clients/workspace/inventory?software=dsh&workspaceId=ws-a`).then((r) => r.json())
check('workspace inventory route answers', invRoute.ok === true && Array.isArray(invRoute.skills))
const toggle = await fetch(`${origin}/dsh-brain/clients/workspace/toggle`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ software: 'dsh', workspaceId: 'ws-a', folder: 'a-skill', enabled: false }) }).then((r) => r.json())
check('workspace toggle route applies', toggle.ok === true && toggle.enabled === false)
const cross = await fetch(`${origin}/dsh-brain/clients/workspace/toggle`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ software: 'codex', workspaceId: 'ws-a', folder: 'x', enabled: false }) })
check('workspace write route rejects non-DSH with 501', cross.status === 501)
await new Promise((resolve) => server.close(resolve))

const passed = results.filter((r) => r.ok).length
console.log(`\n${passed}/${results.length} passed`)
process.exit(passed === results.length ? 0 : 1)
