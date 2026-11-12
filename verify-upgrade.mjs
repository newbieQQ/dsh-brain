// P5 upgrade / migration verification.
//
// A 0.4.1 sidecar must survive an in-place upgrade: the schema is unchanged, so
// base URL, tokens, client id and numeric overrides are read back verbatim and
// survive a second "restart". Unknown keys are ignored rather than fatal. The
// packaged default must be a neutral placeholder, and no personal domain may
// remain in the shipped lib/.
import { mkdtempSync, readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'brain-upgrade-'))

const results = []
function check(name, ok, detail) {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail === undefined ? '' : ` :: ${detail}`}`)
}

const { SettingsStore } = await import('./lib/store.js')
const { DEFAULT_SETTINGS } = await import('./lib/config.js')

// ── 1. A 0.4.1-shaped sidecar survives the upgrade ──────────────────────
const file = join(process.env.DSH_HOME, 'dsh-brain.json')
const old = {
  version: 1,
  enabled: true,
  baseUrl: 'https://memory.example.org/api/longmemory',
  clientId: 'dsh-desktop',
  requestTimeoutMs: 5000,
  defaultK: 12,
  activityToken: 'cmt_old_activity_0123456789abcdef',
  memoryToken: 'cmt_old_memory_0123456789abcdef',
  summaryEnabled: true,
  summaryMaxChars: 6000,
  summaryToken: 'cmt_old_summary_0123456789abcdef',
  someFutureField: 'ignore-me',
}
writeFileSync(file, JSON.stringify(old, null, 2))

const store = new SettingsStore(null, file)
const s = store.settings()
check('base URL survives the upgrade', s.baseUrl === old.baseUrl, s.baseUrl)
check('client id survives the upgrade', s.clientId === 'dsh-desktop')
check('numeric overrides survive', s.requestTimeoutMs === 5000 && s.defaultK === 12)
check('all three tokens survive', store.activityToken() === old.activityToken && store.memoryToken() === old.memoryToken && store.summaryToken() === old.summaryToken)
check('an unknown future key is ignored, not fatal', store.describe().baseUrlConfigured === true)

// A second construction models a restart over the same file.
const reopened = new SettingsStore(null, file)
check('a restart reads the same values back', reopened.settings().baseUrl === old.baseUrl && reopened.activityToken() === old.activityToken)

// ── 2. Fresh installs default to a neutral placeholder ──────────────────
const emptyFile = join(process.env.DSH_HOME, 'empty.json')
const fresh = new SettingsStore(null, emptyFile)
check('fresh install uses the packaged placeholder', DEFAULT_SETTINGS.baseUrl === 'https://your-memory-host/api/longmemory', DEFAULT_SETTINGS.baseUrl)
check('a placeholder is reported as unconfigured', fresh.describe().baseUrlConfigured === false)

// ── 3. A corrupt file degrades to defaults instead of breaking boot ─────
const corrupt = join(process.env.DSH_HOME, 'corrupt.json')
writeFileSync(corrupt, '{not json')
let survived = true
try { new SettingsStore(null, corrupt) } catch { survived = false }
check('a torn sidecar does not break activation', survived)

// ── 4. Artifact hygiene: no personal domain in shipped lib/ ─────────────
const libDir = join(process.cwd(), 'lib')
let leaked = []
for (const name of readdirSync(libDir)) {
  const full = join(libDir, name)
  if (!statSync(full).isFile() || !name.endsWith('.js')) continue
  const text = readFileSync(full, 'utf8')
  if (/qyhhh/i.test(text)) leaked.push(name)
}
check('no personal domain remains in shipped lib/', leaked.length === 0, leaked.join(','))
const pkg = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8'))
check('package version is the delivery version', pkg.version === '0.9.0', pkg.version)

const passed = results.filter((r) => r.ok).length
console.log(`\n${passed}/${results.length} passed`)
process.exit(passed === results.length ? 0 : 1)
