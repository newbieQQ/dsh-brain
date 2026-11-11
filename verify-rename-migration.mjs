// v0.5.0 rename migration: legacy sidecars + env names carry over to dsh-brain.
import assert from 'node:assert'
import { mkdtempSync, writeFileSync, existsSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'dsh-brain-mig-'))
process.env.DSH_HOME = home
writeFileSync(join(home, 'cloud-memory.json'), JSON.stringify({
  version: 1, baseUrl: 'https://example.test/api/longmemory', clientId: 'mig-client',
  activityToken: 'cmt_act_mig', memoryToken: 'cmt_mem_mig', summaryToken: 'cmt_sum_mig',
}))
writeFileSync(join(home, 'cloud-memory-skills.json'), JSON.stringify({ uploaded: { demo: { revision: 3 } } }))
process.env.DSH_CLOUD_MEMORY_MEMORY_TOKEN = 'cmt_env_legacy'

const { SettingsStore } = await import('./lib/store.js')
const { skillsStatePath } = await import('./lib/skill-sync.js')

const store = new SettingsStore({})
assert.ok(store.path.endsWith('dsh-brain.json'), 'new settings path')
assert.equal(store.settings().baseUrl, 'https://example.test/api/longmemory')
assert.equal(store.settings().clientId, 'mig-client')
assert.equal(store.activityToken(), 'cmt_act_mig', 'token migrated from legacy file')
assert.ok(existsSync(join(home, 'dsh-brain.json')), 'new sidecar written')
assert.ok(existsSync(join(home, 'cloud-memory.json')), 'legacy sidecar preserved')

const p = skillsStatePath()
assert.ok(p.endsWith('dsh-brain-skills.json'))
assert.deepEqual(JSON.parse(readFileSync(p, 'utf8')), { uploaded: { demo: { revision: 3 } } })
assert.ok(existsSync(join(home, 'cloud-memory-skills.json')), 'legacy skills sidecar preserved')

// legacy env name still honored; new env name wins when both are set
const store2 = new SettingsStore({}, join(home, 'fresh.json'))
assert.equal(store2.memoryToken(), 'cmt_env_legacy')
process.env.DSH_BRAIN_MEMORY_TOKEN = 'cmt_env_new'
assert.equal(store2.memoryToken(), 'cmt_env_new')

rmSync(home, { recursive: true, force: true })
console.log('verify-rename-migration: all checks passed')
