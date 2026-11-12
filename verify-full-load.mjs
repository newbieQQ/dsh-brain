// Whole-plugin load test: activate the real `apply()` against a host-shaped
// context, then serve the exact routes it registered over a real HTTP server and
// query them. This proves the 0.9.0 build loads and serves every surface a DSH
// restart will expose, without needing to restart the desktop app.
import http from 'node:http'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'brain-load-'))

const results = []
function check(name, ok, detail) {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail === undefined ? '' : ` :: ${detail}`}`)
}

const { apply } = await import('./lib/index.js')

const routes = []
const disposers = []
const ctx = {
  logger: () => ({ info: () => {}, warn: () => {} }),
  effect: (fn) => { const result = fn(); if (typeof result === 'function') disposers.push(result); return () => {} },
  on: () => () => {},
  inject: (_deps, fn) => fn({ tools: { register: () => () => {} }, effect: (inner) => { inner(); return () => {} } }),
  webServer: { register: (route) => { routes.push(route); return () => {} } },
}

let applied = true
try {
  apply(ctx, { baseUrl: 'https://your-memory-host/api/longmemory', clientId: 'load-test' })
} catch (failure) {
  applied = false
  console.log('apply threw:', failure)
}
check('apply() loads against a host-shaped context', applied)

const server = http.createServer((req, res) => {
  const path = (req.url ?? '/').split('?')[0]
  for (const route of routes) {
    if (route.kind === 'exact' && path === route.path) return route.handler(req, res)
    if (route.kind === 'prefix' && (path === route.path || path.startsWith(`${route.path}/`))) return route.handler(req, res)
  }
  res.writeHead(404, { 'content-type': 'application/json' })
  res.end('{"ok":false,"error":"no-route"}')
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const origin = `http://127.0.0.1:${server.address().port}`
async function get(path) {
  const response = await fetch(`${origin}${path}`)
  return { status: response.status, body: await response.json().catch(() => null) }
}
async function post(path, body) {
  const response = await fetch(`${origin}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) })
  return { status: response.status, body: await response.json().catch(() => null) }
}

const caps = await get('/dsh-brain/capabilities')
check('capabilities answers with 0.8.0', caps.body?.version === '0.9.0', String(caps.body?.version))
check('P3 market is advertised with one provider', caps.body?.features?.skillsMarketplace === true && caps.body?.features?.marketProviders === 1)
check('P3 update and sync-resolve are advertised', caps.body?.features?.skillUpdate === true && caps.body?.features?.syncResolve === true)
check('P4/P5/v1.1 flags are advertised', caps.body?.features?.multiClient === true && caps.body?.features?.brainMigration === 'ready')

const providers = await get('/dsh-brain/market/providers')
check('market providers route lists the verified source', providers.body?.providers?.[0]?.id === 'anthropic-skills', JSON.stringify(providers.body?.providers))
const sync = await get('/dsh-brain/sync/status')
check('sync status route answers', sync.body?.ok === true && Array.isArray(sync.body?.conflicts))
const clients = await get('/dsh-brain/clients/overview')
check('clients overview lists six adapters', clients.body?.ok === true && clients.body?.adapters?.length === 6)
const brain = await get('/dsh-brain/migrate/brain')
check('brain migration status answers', brain.body?.ok === true && brain.body?.product === 'DSH Brain' && brain.body?.packageRename === 'done')
const inv = await get('/dsh-brain/clients/inventory?software=dsh&scope=global')
check('inventory route answers for DSH', inv.body?.ok === true && Array.isArray(inv.body?.items))
const skills = await get('/dsh-brain/skills/api')
check('skill inventory route answers', skills.body?.ok === true && Array.isArray(skills.body?.skills))
const status = await get('/dsh-brain/status')
check('status route answers', status.body?.ok === true && status.body?.settings?.baseUrlConfigured === false)

await new Promise((resolve) => server.close(resolve))
for (const dispose of disposers) { try { dispose() } catch { /* teardown noise */ } }

const failed = results.filter((item) => !item.ok).length
console.log(failed === 0 ? `\nALL ${results.length} CHECKS PASSED` : `\n${failed} CHECK(S) FAILED`)
process.exit(failed === 0 ? 0 : 1)
