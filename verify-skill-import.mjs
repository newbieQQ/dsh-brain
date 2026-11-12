// Verification for 「从其他软件导入」 (import a skill from another tool).
//
// The promises asserted here are the ones the card makes: the source
// directory is never modified, a same-name skill in DSH (enabled or
// parked) is never overwritten, and the copy is as strict as a git
// install — symlinks and `.git` never travel.
import http from 'node:http'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'brain-import-'))

const results = []
function check(name, ok, detail) {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail === undefined ? '' : ` :: ${detail}`}`)
}

const writeSkill = (area, folder, files) => {
  for (const [rel, content] of Object.entries(files)) {
    const target = join(area, folder, ...rel.split('/'))
    mkdirSync(join(target, '..'), { recursive: true })
    writeFileSync(target, content)
  }
}

const root = join(process.env.DSH_HOME, 'skills')
const holding = join(process.env.DSH_HOME, 'skills-disabled')
const foreignRoot = join(tmpdir(), `foreign-codex-${Date.now()}`)
mkdirSync(root, { recursive: true })
mkdirSync(holding, { recursive: true })
mkdirSync(foreignRoot, { recursive: true })

writeSkill(foreignRoot, 'good-skill', {
  'SKILL.md': '---\nname: good-skill\ndescription: 好技能\n---\n\n# good-skill\n',
  'references/notes.md': 'notes',
})
writeSkill(foreignRoot, 'with-link', { 'SKILL.md': '# with-link\n' })
symlinkSync(join(foreignRoot, 'good-skill', 'SKILL.md'), join(foreignRoot, 'with-link', 'escape.md'))
writeSkill(foreignRoot, 'with-git', { 'SKILL.md': '# with-git\n', '.git/objects/pack': 'x' })
writeSkill(foreignRoot, 'no-marker', { 'README.md': 'no skill marker' })
writeSkill(foreignRoot, 'real-target', { 'SKILL.md': '# real\n' })
symlinkSync(join(foreignRoot, 'real-target'), join(foreignRoot, 'link-skill'))
writeSkill(holding, 'parked-one', { 'SKILL.md': '# parked\n' })
writeSkill(foreignRoot, 'parked-one', { 'SKILL.md': '# parked clone\n' })

const { SkillAdmin } = await import('./lib/skill-admin.js')
const { SkillGroupManager } = await import('./lib/skill-groups.js')
const { SettingsStore } = await import('./lib/store.js')
const { Reporter } = await import('./lib/reporter.js')
const { createRoutes } = await import('./lib/routes.js')

const admin = new SkillAdmin({
  skillsRoot: () => root,
  holdingDir: () => holding,
  syncStatePath: () => join(process.env.DSH_HOME, 'dsh-brain-skills.json'),
  syncRunning: () => false,
  log: () => {},
})
const sources = () => [
  { id: 'dsh', label: 'DSH', root, writable: true, manager: 'DSH' },
  { id: 'codex', label: 'Codex', root: foreignRoot, writable: false, manager: 'Codex' },
]
const manager = new SkillGroupManager({ sources, admin, storePath: () => join(process.env.DSH_HOME, 'dsh-brain-skill-groups.json'), log: () => {} })

const codeOf = async (promise) => {
  try {
    await promise
    return 'no-throw'
  } catch (error) {
    return error.code ?? error.message
  }
}

// ── happy path ────────────────────────────────────────────────────────
const imported = await manager.importSkill('codex', 'good-skill')
check('import returns the folder', imported.folder === 'good-skill')
check('the skill lands in the DSH root with its files',
  readFileSync(join(root, 'good-skill', 'references', 'notes.md'), 'utf8') === 'notes' &&
  readFileSync(join(root, 'good-skill', 'SKILL.md'), 'utf8').includes('good-skill'))
check('the source directory is untouched',
  existsSync(join(foreignRoot, 'good-skill', 'SKILL.md')) && !existsSync(join(foreignRoot, 'good-skill', 'references', 'moved')))
const listed = await admin.list()
check('the imported skill shows in the DSH inventory', listed.skills.some((skill) => skill.folder === 'good-skill'))

// ── refusals ──────────────────────────────────────────────────────────
check('a second import of the same skill is refused', await codeOf(manager.importSkill('codex', 'good-skill')) === 'already_exists')
check('importing over a parked same-name skill is refused', await codeOf(manager.importSkill('codex', 'parked-one')) === 'already_exists')
check('importing from the DSH source itself is refused', await codeOf(manager.importSkill('dsh', 'good-skill')) === 'import_from_self')
check('a traversal folder name is refused', await codeOf(manager.importSkill('codex', '../escape')) === 'invalid_name')
check('a skill without SKILL.md is refused', await codeOf(manager.importSkill('codex', 'no-marker')) === 'invalid_skill')
check('a symlinked skill directory is refused', await codeOf(manager.importSkill('codex', 'link-skill')) === 'invalid_skill')
check('an unknown source is refused', await codeOf(manager.importSkill('nope', 'good-skill')) === 'unknown_source')
check('a missing skill is a 404-style refusal', await codeOf(manager.importSkill('codex', 'ghost')) === 'not_found')

// ── copy hygiene ──────────────────────────────────────────────────────
await manager.importSkill('codex', 'with-link')
check('symlinks inside a skill are dropped, not copied',
  existsSync(join(root, 'with-link', 'SKILL.md')) && !existsSync(join(root, 'with-link', 'escape.md')))
await manager.importSkill('codex', 'with-git')
check('.git never travels with an import',
  existsSync(join(root, 'with-git', 'SKILL.md')) && !existsSync(join(root, 'with-git', '.git')))

// ── route surface ─────────────────────────────────────────────────────
const store = new SettingsStore({ baseUrl: 'https://memory.example.org/api/longmemory' }, join(process.env.DSH_HOME, 'dsh-brain.json'))
const reporter = new Reporter({
  client: () => ({ reportTurn: async () => ({ ok: true, status: 200, data: {} }) }),
  settings: () => ({ enabled: true, clientId: 'import' }),
  activityToken: () => '',
  summary: () => ({ enabled: false, maxChars: 1000 }),
  summaryToken: () => '',
  log: () => {},
})
const routes = createRoutes({ version: 'test', store, reporter, client: () => ({ reach: async () => ({ ok: false, status: 0, message: 'stub' }) }), admin, groups: manager })
const server = http.createServer((req, res) => {
  const path = (req.url ?? '/').split('?')[0]
  for (const route of routes) {
    if (route.kind === 'exact' && path === route.path) return route.handler(req, res)
    if (route.kind === 'prefix' && (path === route.path || path.startsWith(`${route.path}/`))) return route.handler(req, res)
  }
  res.writeHead(404, { 'content-type': 'application/json' })
  res.end('{"ok":false}')
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const origin = `http://127.0.0.1:${server.address().port}`
async function call(method, path, body) {
  const response = await fetch(`${origin}${path}`, {
    method,
    headers: { accept: 'application/json', ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  return { status: response.status, body: await response.json().catch(() => null) }
}
writeSkill(foreignRoot, 'route-skill', { 'SKILL.md': '# route\n' })
const viaRoute = await call('POST', '/dsh-brain/skills/import', { sourceId: 'codex', folder: 'route-skill' })
check('POST /skills/import imports through the real route', viaRoute.status === 200 && viaRoute.body?.ok === true && existsSync(join(root, 'route-skill', 'SKILL.md')))
const dupe = await call('POST', '/dsh-brain/skills/import', { sourceId: 'codex', folder: 'route-skill' })
check('the route maps a duplicate import to a client error', dupe.status >= 400 && dupe.body?.code === 'already_exists')
server.close()

const failed = results.filter((item) => !item.ok)
console.log(failed.length === 0 ? `ALL ${results.length} CHECKS PASSED` : `${failed.length}/${results.length} CHECKS FAILED`)
process.exit(failed.length === 0 ? 0 : 1)
