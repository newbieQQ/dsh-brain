// Runtime verification for the Mnemon provider bridge (lib/mnemon).
// Runs against the built lib/ output and a stub LongMemory HTTP service;
// no DSH host, no Mnemon host, no real service, no real credentials.
import http from 'node:http'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'dsh-home-'))

const results = []
function check(name, ok, detail) {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail === undefined ? '' : ` :: ${detail}`}`)
}

// ---- Stub LongMemory service -------------------------------------------------
const store = []
let seq = 0
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://stub')
  const path = url.pathname.replace(/^\/api\/longmemory/, '')
  const send = (status, body) => {
    res.writeHead(status, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(body))
  }
  const readBody = () => new Promise((resolve) => {
    let raw = ''
    req.on('data', (chunk) => { raw += chunk })
    req.on('end', () => resolve(raw === '' ? {} : JSON.parse(raw)))
  })
  void (async () => {
    if (req.method === 'GET' && path === '/dashboard/projects') {
      return send(200, { projects: [{ id: 'p1', name: '项目一' }] })
    }
    if (req.method === 'GET' && path === '/storage/status') {
      return send(200, { ok: true })
    }
    if (req.method === 'POST' && path === '/memory/query') {
      const body = await readBody()
      const project = body.filters?.project_id
      const matches = store.filter((hit) =>
        hit.content.includes(body.query) && (project === undefined || hit.project_id === project))
      return send(200, { matches: matches.slice(0, body.k ?? 10), total: matches.length, search_mode: 'keyword' })
    }
    if (req.method === 'GET' && path === '/memory/all') {
      const project = url.searchParams.get('project_id')
      const limit = Number(url.searchParams.get('limit') ?? 100)
      const items = store.filter((hit) => project === null || hit.project_id === project)
      return send(200, { items: items.slice(0, limit), total: items.length })
    }
    if (req.method === 'POST' && path === '/memory/add') {
      const body = await readBody()
      seq += 1
      const hit = {
        id: `m${seq}`,
        content: body.content,
        tags: body.tags ?? [],
        project_id: body.project_id ?? null,
        primary_sector: body.metadata?.primary_sector ?? 'general',
        created_at: Date.now(),
        updated_at: Date.now(),
      }
      store.push(hit)
      return send(200, { id: hit.id, revision: 1, memory: hit })
    }
    const byId = path.match(/^\/memory\/(.+)$/)
    if (req.method === 'GET' && byId !== null) {
      const hit = store.find((item) => item.id === decodeURIComponent(byId[1]))
      return hit === undefined ? send(404, { error: 'not_found' }) : send(200, hit)
    }
    return send(404, { error: 'unknown_route', path })
  })()
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const endpoint = `http://127.0.0.1:${server.address().port}/api/longmemory`
const token = '<redacted>'

// ---- Provider under test ------------------------------------------------------
const mod = await import('./lib/mnemon/index.js')
const pkg = JSON.parse(readFileSync('./package.json', 'utf8'))

check('default export is the longmemory provider module',
  mod.default?.id === 'longmemory' && typeof mod.default?.apply === 'function')
check('manifest version matches package version',
  mod.definition?.manifest?.version === pkg.version,
  `${mod.definition?.manifest?.version} vs ${pkg.version}`)
check('manifest declares pass-through capabilities',
  mod.definition?.manifest?.capabilities?.search === true &&
  mod.definition?.manifest?.capabilities?.remember === true &&
  mod.definition?.manifest?.capabilities?.writeMode === 'exact')

let installed
mod.default.apply({}, { install: (ctx, def) => { installed = def } })
check('apply installs the definition with the host', installed === mod.definition)

let activeProject = ''
const authority = {
  list: () => [],
  runner: { effectiveDataDir: () => process.env.DSH_HOME },
  providerConnection: () => ({ endpoint, token, ...(activeProject === '' ? {} : { projectId: activeProject }) }),
}
const provider = mod.definition.create({ memorySpaces: authority, memoryBodies: authority, config: { timeoutMs: 3000 } })
const body = { id: 'space-1', provider: { id: 'longmemory' }, connection: {} }

const spaces = await provider.discover({ endpoint, token })
check('discover returns the default scope plus projects',
  spaces.length === 2 && spaces[0].externalId === 'default' && spaces[1].connection.projectId === 'p1',
  spaces.map((space) => space.externalId).join(','))

const status = await provider.status(body)
check('status is healthy against the stub', status.healthy === true)

const stored = await provider.remember(body, { content: '桥测试记忆 alpha', tags: ['test'], category: 'general' })
check('remember stores live and returns the cloud id',
  stored?.action === 'stored' && typeof stored?.id === 'string', JSON.stringify(stored))

const found = await provider.search(body, { query: 'alpha' })
check('search recalls the memory in real time',
  found.results.length === 1 && found.results[0].content.includes('alpha'))
check('search maps sector back to category',
  found.results[0]?.category === 'general', found.results[0]?.category)

const listed = await provider.list(body, {})
check('list browses the space', listed.some((item) => item.id === stored.id))

const got = await provider.get(body, stored.id)
check('get reads one memory by id', got?.content === '桥测试记忆 alpha')

activeProject = 'p1'
const storedP1 = await provider.remember(body, { content: '项目专属记忆 beta' })
activeProject = 'other'
const otherList = await provider.list(body, {})
check('project scoping keeps other projects out',
  !otherList.some((item) => item.id === storedP1.id))
activeProject = 'p1'
const p1List = await provider.list(body, {})
check('project scoping finds its own memories',
  p1List.some((item) => item.id === storedP1.id))
activeProject = ''

const graph = await provider.graph(body)
check('graph is an honest empty snapshot in v1',
  Array.isArray(graph.nodes) && graph.nodes.length === 0 && Array.isArray(graph.edges))

server.close()
const failed = results.filter((item) => !item.ok).length
console.log(failed === 0 ? `\nALL ${results.length} CHECKS PASSED` : `\n${failed} CHECK(S) FAILED`)
process.exit(failed === 0 ? 0 : 1)
