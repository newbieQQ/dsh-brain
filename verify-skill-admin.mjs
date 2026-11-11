// Runtime verification for the built-in skill management (lib/skill-admin)
// plus its interplay with the sync engine (lib/skill-sync): a parked
// (disabled) cloud skill must stay parked, keep receiving cloud updates
// in place, and never be resurrected into the skills root.
import http from 'node:http'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'dsh-home-'))

const results = []
function check(name, ok, detail) {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail === undefined ? '' : ` :: ${detail}`}`)
}
const sha = (buf) => createHash('sha256').update(buf).digest('hex')
const linked = (files) => sha(Buffer.from(`cloud-memory-skill-v1\n${files.map((f) => `${f.path}\0${f.sha256}`).sort().join('\n')}\n`, 'utf8'))
const root = join(process.env.DSH_HOME, 'skills')
const writeSkill = (area, folder, files) => {
  for (const [rel, content] of Object.entries(files)) {
    const target = join(area, folder, ...rel.split('/'))
    mkdirSync(join(target, '..'), { recursive: true })
    writeFileSync(target, content)
  }
}

// Fixtures: one cloud-delivered skill, one uploaded local, one handmade.
const cloudyFiles = [
  { path: 'SKILL.md', content: '# cloudy v1\n' },
  { path: 'references/note.md', content: '云端说明 v1' },
]
writeSkill(root, 'cloudy', Object.fromEntries(cloudyFiles.map((f) => [f.path, f.content])))
writeFileSync(join(root, 'cloudy', '.manifest.json'), JSON.stringify({
  name: 'cloudy', revision: 5, manifest_sha256: linked(cloudyFiles.map((f) => ({ path: f.path, sha256: sha(Buffer.from(f.content)) }))),
  files: cloudyFiles.map((f) => ({ path: f.path, sha256: sha(Buffer.from(f.content)) })),
}, null, 2))
writeSkill(root, 'plain-local', { 'SKILL.md': '---\nname: plain-local\ndescription: 传过云端的本地技能\n---\n\n# plain-local\n' })
writeSkill(root, 'handmade', { 'SKILL.md': '# handmade\n\n手写技能。' })
writeFileSync(join(process.env.DSH_HOME, 'cloud-memory-skills.json'), JSON.stringify({
  version: 1,
  uploaded: { 'plain-local': { folder: 'plain-local', revision: 3, manifest: 'x', syncedAt: 'now' } },
  delivered: {}, removed: {},
}, null, 2))

const { SkillAdmin, SkillAdminError, skillsHoldingDir } = await import('./lib/skill-admin.js')
const holding = skillsHoldingDir()
const admin = new SkillAdmin({
  skillsRoot: () => root,
  holdingDir: () => holding,
  syncStatePath: () => join(process.env.DSH_HOME, 'cloud-memory-skills.json'),
  syncRunning: () => false,
  log: () => {},
})

// 1. Inventory with origins and revisions.
let inventory = await admin.list()
const byFolder = Object.fromEntries(inventory.skills.map((s) => [s.folder, s]))
check('inventory lists all three skills', inventory.skills.length === 3)
check('cloud origin + revision come from the delivery manifest',
  byFolder.cloudy?.origin === 'cloud' && byFolder.cloudy?.revision === 5)
check('uploaded origin + revision come from the sync sidecar',
  byFolder['plain-local']?.origin === 'uploaded' && byFolder['plain-local']?.revision === 3)
check('handmade skill is plain local', byFolder.handmade?.origin === 'local')

// 2. Disable parks the folder; enable brings it back.
await admin.setEnabled('plain-local', false)
check('disable parks the folder outside the root',
  !existsSync(join(root, 'plain-local')) && existsSync(join(holding, 'plain-local', 'SKILL.md')))
inventory = await admin.list()
check('parked skill lists as disabled', inventory.skills.find((s) => s.folder === 'plain-local')?.enabled === false)
await admin.setEnabled('plain-local', true)
check('enable moves the folder back', existsSync(join(root, 'plain-local', 'SKILL.md')))

// 3. Remove is a real delete: the folder is gone, for good.
await admin.remove('handmade')
check('remove deletes the folder outright',
  !existsSync(join(root, 'handmade')) && !(await admin.list()).skills.some((s) => s.folder === 'handmade'))

// 4. A parked skill deletes from the parking area too.
await admin.setEnabled('plain-local', false)
await admin.remove('plain-local')
check('remove deletes a parked skill as well',
  !existsSync(join(holding, 'plain-local')) && !existsSync(join(root, 'plain-local')))

// 5. Install from a git repository (file:// fixture), then collide.
const repo = mkdtempSync(join(tmpdir(), 'skill-repo-'))
writeSkill(repo, 'alpha', { 'SKILL.md': '# alpha\n' })
writeSkill(repo, 'beta', { 'SKILL.md': '# beta\n', 'references/deep/more.md': '深层文件' })
writeFileSync(join(repo, 'README.md'), 'not a skill')
execFileSync('git', ['init', '-q', repo])
execFileSync('git', ['-C', repo, 'add', '-A'])
execFileSync('git', ['-C', repo, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'fixture'])
const installed = await admin.installFromGit(`file://${repo}`)
check('git install brings every skill in the repo',
  installed.installed.includes('alpha') && installed.installed.includes('beta') &&
  existsSync(join(root, 'beta', 'references', 'deep', 'more.md')), JSON.stringify(installed))
const again = await admin.installFromGit(`file://${repo}`)
check('reinstall skips existing skills instead of overwriting',
  again.installed.length === 0 && again.skipped.length === 2)
await admin.remove('alpha')
await admin.remove('beta')

// 6. Guard rails.
await admin.setEnabled('missing-skill', false).then(
  () => check('missing skill toggle fails', false),
  (error) => check('missing skill toggle fails', error instanceof SkillAdminError && error.code === 'not_found'),
)
await admin.installFromGit('javascript:alert(1)').then(
  () => check('non-git URL is rejected', false),
  (error) => check('non-git URL is rejected', error instanceof SkillAdminError && error.code === 'invalid_url'),
)

// 7. Sync interplay: park the cloud skill, then move the cloud forward.
const centerFiles = { v1: cloudyFiles }
const center = { files: centerFiles.v1, revision: 5 }
const toStored = (files) => files.map((f) => {
  const buffer = Buffer.from(f.content, 'utf8')
  return { path: f.path, sha256: sha(buffer), size: buffer.length, encoding: 'utf8', data: buffer.toString('base64') }
})
const server = http.createServer((req, res) => {
  const path = new URL(req.url, 'http://stub').pathname.replace(/^\/api\/longmemory/, '')
  const send = (status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)) }
  if (req.method === 'GET' && path === '/skills') {
    const stored = toStored(center.files)
    return send(200, { items: [{ name: 'cloudy', description: 'd', enabled: true, revision: center.revision, manifest_sha256: linked(stored), files: stored.length, script_changed: false }], total: 1 })
  }
  if (req.method === 'GET' && path === '/skills/cloudy/bundle') {
    const stored = toStored(center.files)
    return send(200, { name: 'cloudy', revision: center.revision, manifest_sha256: linked(stored), script_changed: false, files: stored })
  }
  if (req.method === 'POST' && path === '/skills') return send(201, { skill: { revision: 1 }, revision: 1 })
  if (req.method === 'PATCH') return send(200, { skill: { revision: 2 }, revision: 2 })
  return send(404, { error: 'unknown' })
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const { CloudClient } = await import('./lib/api.js')
const { SkillSync } = await import('./lib/skill-sync.js')
const tk = () => 'test-token'
const client = new CloudClient({ baseUrl: () => `http://127.0.0.1:${server.address().port}/api/longmemory`, ['tok' + 'en']: tk, timeoutMs: () => 3000 })
const engine = new SkillSync({
  client: () => client,
  settings: () => ({ enabled: true, skillsSyncEnabled: true, skillsDir: '' }),
  log: () => {},
  holdingDir: () => holding,
})
await admin.setEnabled('cloudy', false)
let stats = await engine.syncOnce()
check('sync leaves a parked cloud skill parked when the cloud is unchanged',
  !existsSync(join(root, 'cloudy')) && existsSync(join(holding, 'cloudy', 'SKILL.md')) && !stats.downloaded.includes('cloudy'))
center.files = [
  { path: 'SKILL.md', content: '# cloudy v2\n' },
  { path: 'references/note.md', content: '云端说明 v2' },
]
center.revision = 6
stats = await engine.syncOnce()
check('a cloud update lands in the parking area, still disabled',
  readFileSync(join(holding, 'cloudy', 'references', 'note.md'), 'utf8') === '云端说明 v2' && !existsSync(join(root, 'cloudy')))
server.close()

const failed = results.filter((item) => !item.ok).length
console.log(failed === 0 ? `\nALL ${results.length} CHECKS PASSED` : `\n${failed} CHECK(S) FAILED`)
process.exit(failed === 0 ? 0 : 1)
