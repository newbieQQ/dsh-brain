// Entry-point smoke test: a plugin that throws from `apply` takes the whole web
// boot down, so the cheapest insurance is to activate the real entry against a
// fake host context and check the route table it registers.
//
// Deliberately not a unit test of every timer: it proves `apply` runs, wires the
// expected routes, and tears everything down through the disposers it returned.
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'brain-entry-'))

const results = []
function check(name, ok, detail) {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail === undefined ? '' : ` :: ${detail}`}`)
}

const { apply } = await import('./lib/index.js')

const routes = []
const disposers = []
const tools = []
const ctx = {
  logger: () => ({ info: () => {}, warn: () => {} }),
  effect: (fn) => {
    const result = fn()
    if (typeof result === 'function') disposers.push(result)
    return () => {}
  },
  on: () => () => {},
  inject: (deps, fn) => {
    fn({
      tools: {
        register: (tool) => {
          tools.push(tool)
          return () => {}
        },
      },
      effect: (inner) => {
        inner()
        return () => {}
      },
    })
  },
  webServer: {
    register: (route) => {
      routes.push(route)
      return () => {}
    },
  },
}

let applied = true
try {
  apply(ctx, { baseUrl: 'https://your-memory-host/api/longmemory', clientId: 'smoke' })
} catch (failure) {
  applied = false
  console.log('apply threw:', failure)
}
check('apply() completes against a host-shaped context', applied)

const expected = [
  'exact:/cloud-memory',
  'exact:/cloud-memory/status',
  'exact:/cloud-memory/capabilities',
  'exact:/cloud-memory/config',
  'exact:/cloud-memory/login',
  'exact:/cloud-memory/test',
  'exact:/cloud-memory/flush',
  'prefix:/cloud-memory/skills',
  'prefix:/cloud-memory/market',
  'prefix:/cloud-memory/sync',
  'prefix:/cloud-memory/clients',
  'prefix:/cloud-memory/migrate',
]
const actual = routes.map((route) => `${route.kind}:${route.path}`)
check('every route the card depends on is registered', expected.every((item) => actual.includes(item)), actual.join(' | '))
check('the memory tools are still registered', tools.length >= 3, `${tools.length} tools`)

let disposed = true
try {
  for (const dispose of disposers) dispose()
} catch (failure) {
  disposed = false
  console.log('dispose threw:', failure)
}
check('every registered effect is disposable', disposed)

const failed = results.filter((item) => !item.ok).length
console.log(failed === 0 ? `\nALL ${results.length} CHECKS PASSED` : `\n${failed} CHECK(S) FAILED`)
process.exit(failed === 0 ? 0 : 1)
