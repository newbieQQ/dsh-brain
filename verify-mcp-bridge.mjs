// Live probe of the host dsh-mcp-connector public bridge (P4 evidence).
//
// Not a unit test: it talks to a running DSH web server. If the server or the
// connector plugin is absent it prints SKIP and exits 0 so it never blocks CI.
// Usage: node verify-mcp-bridge.mjs [http://127.0.0.1:4503]
const base = process.argv[2] ?? process.env.DSH_WEB_URL ?? 'http://127.0.0.1:4503'

async function call(method, params) {
  const response = await fetch(`${base}/mcp-connector/api`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ method, params: params ?? {} }),
  })
  return { status: response.status, body: await response.json().catch(() => null) }
}

let reachable = true
try {
  const probe = await call('status', {})
  if (probe.status === 404) reachable = false
} catch {
  reachable = false
}
if (!reachable) {
  console.log(`SKIP no dsh-mcp-connector bridge at ${base}`)
  process.exit(0)
}

const results = []
function check(name, ok, detail) {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail === undefined ? '' : ` :: ${detail}`}`)
}

const version = await call('versionStatus', {})
check('versionStatus answers', version.body?.ok === true)
const catalog = await call('catalog', { keyword: '' })
const items = Array.isArray(catalog.body?.detail?.items) ? catalog.body.detail.items : []
check('catalog lists published connectors', catalog.body?.ok === true && items.length > 0, `${items.length} items`)
check('catalog entries carry authMode + connection state', items.length > 0 && typeof items[0].authMode === 'string' && typeof items[0].connectionState === 'string')
const gov = await call('governance', {})
check('governance returns a revision + rules', gov.body?.ok === true && gov.body?.detail?.revision !== undefined && Array.isArray(gov.body?.detail?.rules))
const scope = await call('scopeContext', {})
check('scopeContext returns the scope document', scope.body?.ok === true && scope.body?.detail?.revision !== undefined)
const status = await call('status', {})
check('status returns connections + scope', status.body?.ok === true && Array.isArray(status.body?.detail?.items))
const stats = await call('connectionStatistics', {})
check('connectionStatistics answers', stats.body?.ok === true)
const snapshots = await call('listSnapshots', {})
check('snapshots list answers', snapshots.body?.ok === true)

const passed = results.filter((r) => r.ok).length
console.log(`\n${passed}/${results.length} live bridge checks passed`)
process.exit(passed === results.length ? 0 : 1)
