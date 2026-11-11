// P5 concurrency / mutex verification.
//
// Every mutating skill path must refuse to run while a sync pass is running:
// install staging, install commit, toggle, remove, update apply and rollback.
// The refusal is a typed 409 at the route layer, never a silent partial write.
import http from 'node:http'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'brain-conc-'))

const results = []
function check(name, ok, detail) {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail === undefined ? '' : ` :: ${detail}`}`)
}

const { SkillAdmin } = await import('./lib/skill-admin.js')
const { SkillUpdater } = await import('./lib/skill-update.js')
const { SettingsStore } = await import('./lib/store.js')
const { Reporter } = await import('./lib/reporter.js')
const { createRoutes } = await import('./lib/routes.js')

const root = join(process.env.DSH_HOME, 'skills')
const holding = join(process.env.DSH_HOME, 'skills-disabled')
mkdirSync(join(root, 'alpha'), { recursive: true })
writeFileSync(join(root, 'alpha', 'SKILL.md'), '# alpha\n')

let running = true
const admin = new SkillAdmin({ skillsRoot: () => root, holdingDir: () => holding, syncStatePath: () => join(process.env.DSH_HOME, 'dsh-brain-skills.json'), syncRunning: () => running, log: () => {} })
const updater = new SkillUpdater({ admin, skillsRoot: () => root, holdingDir: () => holding, syncRunning: () => running, log: () => {} })

async function expectCode(fn, code) {
  try { await fn(); return false } catch (error) { return error.code === code || error.message === code }
}
check('prepareInstall refuses while sync runs', await expectCode(() => admin.prepareInstall('https://example.org/x.git'), 'sync_running'))
check('commitInstall refuses while sync runs', await expectCode(() => admin.commitInstall({ planId: 'x', folders: [] }), 'sync_running'))
check('setEnabled refuses while sync runs', await expectCode(() => admin.setEnabled('alpha', false), 'sync_running'))
check('remove refuses while sync runs', await expectCode(() => admin.remove('alpha'), 'sync_running'))
check('applyUpdate refuses while sync runs', await expectCode(() => updater.applyUpdate('alpha', 'deadbeef'), 'sync_running'))
check('rollback refuses while sync runs', await expectCode(() => updater.rollback('alpha'), 'sync_running'))

// Route layer maps the refusal to 409.
const store = new SettingsStore({ clientId: 't' }, join(process.env.DSH_HOME, 'c.json'))
const reporter = new Reporter({ client: () => ({ reportTurn: async () => ({ ok: true, status: 200, data: {} }), submitSummary: async () => ({ ok: true, status: 200, data: {} }) }), settings: () => ({ enabled: true, clientId: 't' }), activityToken: () => '', summary: () => ({ enabled: false, maxChars: 1 }), summaryToken: () => '', log: () => {} })
const routes = createRoutes({ version: '0.6.0', store, reporter, client: () => ({ reach: async () => ({ ok: false, status: 0, message: 'x' }), listSkills: async () => ({ ok: true, status: 200, data: { items: [] } }) }), admin, updates: updater })
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
const response = await fetch(`${origin}/dsh-brain/skills/toggle`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ folder: 'alpha', enabled: false }) })
const body = await response.json()
check('route answers 409 sync_running during a sync', response.status === 409 && body.code === 'sync_running', JSON.stringify(body))
await new Promise((resolve) => server.close(resolve))

// After the sync ends, the same toggle succeeds.
running = false
const enabled = await admin.setEnabled('alpha', false)
check('after the sync ends the mutation is allowed', enabled.folder === 'alpha' && enabled.enabled === false)

const passed = results.filter((r) => r.ok).length
console.log(`\n${passed}/${results.length} passed`)
process.exit(passed === results.length ? 0 : 1)
