// Verification for P3 interactive sync conflict resolution.
//
// One real SkillSync pass against a stub cloud client produces four conflicts;
// then each resolution action is exercised: take_cloud (backup + overwrite),
// keep_local (upload), manual (read-only) and a stale-revision refusal.
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'brain-sync-'))

const results = []
function check(name, ok, detail) {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail === undefined ? '' : ` :: ${detail}`}`)
}

const { SkillSync, linkedSkillManifest, sha256Hex } = await import('./lib/skill-sync.js')

const root = join(process.env.DSH_HOME, 'skills')
mkdirSync(root, { recursive: true })

function makeLocal(folder, markdown) {
  mkdirSync(join(root, folder), { recursive: true })
  writeFileSync(join(root, folder, 'SKILL.md'), markdown)
  // A delivery manifest whose recorded hash does not match → "locally_modified".
  writeFileSync(join(root, folder, '.manifest.json'), JSON.stringify({
    name: folder, revision: 1, manifest_sha256: 'old', files: [{ path: 'SKILL.md', sha256: 'deadbeef' }],
  }))
}
for (const folder of ['demo', 'demo2', 'demo3', 'demo4']) {
  makeLocal(folder, `---\nname: ${folder}\n---\n# ${folder} local\n`)
}

const cloudBody = '---\nname: demo\n---\n# demo CLOUD\n'
const cloudFiles = [{ path: 'SKILL.md', sha256: sha256Hex(cloudBody), data: Buffer.from(cloudBody).toString('base64') }]
const cloudManifest = linkedSkillManifest(cloudFiles)
const items = [
  { name: 'demo', enabled: true, revision: 3, manifest_sha256: cloudManifest, files: 1, bytes: cloudBody.length },
  { name: 'demo2', enabled: true, revision: 5, manifest_sha256: 'm2', files: 1, bytes: 10 },
  { name: 'demo3', enabled: true, revision: 4, manifest_sha256: 'm3', files: 1, bytes: 10 },
  { name: 'demo4', enabled: true, revision: 7, manifest_sha256: 'm4', files: 1, bytes: 10 },
]
let updateCalls = []
const client = {
  listSkills: async () => ({ ok: true, status: 200, data: { items } }),
  skillBundle: async (name) => name === 'demo'
    ? { ok: true, status: 200, data: { name, revision: 3, manifest_sha256: cloudManifest, files: cloudFiles } }
    : { ok: false, error: { status: 404, code: 'not_found', message: 'no bundle' } },
  createSkill: async () => ({ ok: true, status: 200, data: { skill: { revision: 1 } } }),
  updateSkill: async (name, body) => {
    updateCalls.push({ name, expected: body.expected_revision })
    if (name === 'demo4') return { ok: false, error: { status: 409, code: 'revision_conflict', message: 'stale' } }
    return { ok: true, status: 200, data: { skill: { revision: 6 } } }
  },
}

const sync = new SkillSync({
  client: () => client,
  settings: () => ({ enabled: true, skillsSyncEnabled: true, skillsDir: '' }),
  log: () => {},
})
const stats = await sync.syncOnce()
check('one pass reports four conflicts', stats.conflicts.length === 4, JSON.stringify(stats.conflicts))

const details = await sync.conflictDetails()
check('conflictDetails returns both sides', details.length === 4)
const demoDetail = details.find((d) => d.name === 'demo')
check('detail exposes local files and cloud revision', demoDetail?.local?.exists === true && demoDetail?.cloud?.revision === 3, JSON.stringify(demoDetail))

// take_cloud
const take = await sync.resolveConflict('demo', 'take_cloud')
check('take_cloud applies and backs up', take.applied === true && typeof take.backup === 'string' && existsSync(take.backup), JSON.stringify(take))
check('take_cloud overwrote SKILL.md with the cloud copy', readFileSync(join(root, 'demo', 'SKILL.md'), 'utf8').includes('CLOUD'))
check('take_cloud backup holds the old file', readFileSync(join(take.backup, 'SKILL.md'), 'utf8').includes('local'))

// keep_local
const keep = await sync.resolveConflict('demo2', 'keep_local')
check('keep_local uploads and bumps revision', keep.applied === true && keep.revision === 6, JSON.stringify(keep))
check('keep_local used the cloud revision as expected_revision', updateCalls.some((c) => c.name === 'demo2' && c.expected === 5), JSON.stringify(updateCalls))
const state = JSON.parse(readFileSync(join(process.env.DSH_HOME, 'dsh-brain-skills.json'), 'utf8'))
check('keep_local recorded the upload in the sidecar', state.uploaded?.demo2?.revision === 6)

// manual
const manual = await sync.resolveConflict('demo3', 'manual')
check('manual reports both sides without writing', manual.applied === false && manual.action === 'manual')

// stale revision
let stale = false
try { await sync.resolveConflict('demo4', 'keep_local') } catch (error) { stale = error.message === 'stale_revision' }
check('keep_local refuses a stale cloud revision', stale)

const remaining = await sync.conflictDetails()
check('resolved conflicts drop out of the list', remaining.some((d) => d.name === 'demo') === false && remaining.some((d) => d.name === 'demo2') === false)

const passed = results.filter((r) => r.ok).length
console.log(`\n${passed}/${results.length} passed`)
process.exit(passed === results.length ? 0 : 1)
