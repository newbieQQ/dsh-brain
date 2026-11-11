// Verification for P3 skill update/rollback.
//
// Uses a real throwaway git repository and the real install pipeline, so the
// `.skill-source.json` provenance, the diff, the pre-update backup and the
// rollback restore are all exercised end to end.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'brain-update-'))

const results = []
function check(name, ok, detail) {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail === undefined ? '' : ` :: ${detail}`}`)
}

const { SkillAdmin } = await import('./lib/skill-admin.js')
const { SkillUpdater } = await import('./lib/skill-update.js')

const root = join(process.env.DSH_HOME, 'skills')
const holding = join(process.env.DSH_HOME, 'skills-disabled')
const repoDir = join(process.env.DSH_HOME, 'repo')
mkdirSync(join(repoDir, 'alpha'), { recursive: true })
writeFileSync(join(repoDir, 'alpha', 'SKILL.md'), '---\nname: alpha\ndescription: v1\n---\n# alpha v1\n')
execFileSync('git', ['init', '-b', 'main'], { cwd: repoDir })
execFileSync('git', ['-C', repoDir, 'add', '-A'])
execFileSync('git', ['-C', repoDir, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-m', 'v1'])
const c1 = execFileSync('git', ['-C', repoDir, 'rev-parse', 'HEAD']).toString().trim()
const repoUrl = 'file://' + repoDir.replace(/\\/g, '/')

const admin = new SkillAdmin({ skillsRoot: () => root, holdingDir: () => holding, syncStatePath: () => join(process.env.DSH_HOME, 'cloud-memory-skills.json'), syncRunning: () => false, log: () => {} })
const updater = new SkillUpdater({ admin, skillsRoot: () => root, holdingDir: () => holding, syncRunning: () => false, log: () => {} })

// Install alpha from the repo.
const plan = await admin.prepareInstall(repoUrl)
await admin.commitInstall({ planId: plan.planId, folders: ['alpha'] })
check('installed alpha with provenance', existsSync(join(root, 'alpha', '.skill-source.json')))
check('installed content is v1', readFileSync(join(root, 'alpha', 'SKILL.md'), 'utf8').includes('v1'))

// A skill without a source record cannot be updated.
mkdirSync(join(root, 'plain'), { recursive: true })
writeFileSync(join(root, 'plain', 'SKILL.md'), '# plain\n')
const plain = await updater.checkUpdate('plain')
check('no source record → updatable:false', plain.updatable === false && plain.reason === 'no_source')

// Publish v2 upstream.
writeFileSync(join(repoDir, 'alpha', 'SKILL.md'), '---\nname: alpha\ndescription: v2\n---\n# alpha v2\n')
writeFileSync(join(repoDir, 'alpha', 'extra.md'), 'new file')
execFileSync('git', ['-C', repoDir, 'add', '-A'])
execFileSync('git', ['-C', repoDir, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-m', 'v2'])
const c2 = execFileSync('git', ['-C', repoDir, 'rev-parse', 'HEAD']).toString().trim()

const check1 = await updater.checkUpdate('alpha')
check('checkUpdate sees a new commit', check1.available === true && check1.currentCommit === c1 && check1.remoteCommit === c2, JSON.stringify(check1))
check('checkUpdate lists the changed SKILL.md', Array.isArray(check1.changed) && check1.changed.includes('SKILL.md'), JSON.stringify(check1.changed))
check('checkUpdate lists the added file', Array.isArray(check1.added) && check1.added.includes('extra.md'), JSON.stringify(check1.added))

const applied = await updater.applyUpdate('alpha', c2)
check('applyUpdate moves the folder to v2', readFileSync(join(root, 'alpha', 'SKILL.md'), 'utf8').includes('v2'), JSON.stringify(applied))
check('applyUpdate adds the new file', existsSync(join(root, 'alpha', 'extra.md')))
check('applyUpdate took a backup', existsSync(applied.backup) && existsSync(join(applied.backup, 'SKILL.md')))
check('provenance now records the new commit', JSON.parse(readFileSync(join(root, 'alpha', '.skill-source.json'), 'utf8')).commit === c2)
const after = await updater.checkUpdate('alpha')
check('after update, no further change is pending', after.available === false)

const rolled = await updater.rollback('alpha')
check('rollback restores v1', readFileSync(join(root, 'alpha', 'SKILL.md'), 'utf8').includes('v1'), JSON.stringify(rolled))
check('rollback removes the file that v2 added', !existsSync(join(root, 'alpha', 'extra.md')))
check('rollback provenance points back to c1', JSON.parse(readFileSync(join(root, 'alpha', '.skill-source.json'), 'utf8')).commit === c1)

let stale = false
try { await updater.applyUpdate('alpha', 'deadbeef') } catch (error) { stale = error.code === 'stale_plan' }
check('applyUpdate refuses a stale expected commit', stale)

const passed = results.filter((r) => r.ok).length
console.log(`\n${passed}/${results.length} passed`)
process.exit(passed === results.length ? 0 : 1)
