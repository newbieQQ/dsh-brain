// Verification for the multi-source skill tree (sources → categories → skills).
//
// The two things that must not regress are stated in the UI copy, so they are
// asserted here: a category is metadata only (creating, renaming, deleting one
// never moves a file), and only the DSH source switch really parks skills —
// another software's directory is never touched.
import http from 'node:http'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'brain-tree-'))

const results = []
function check(name, ok, detail) {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail === undefined ? '' : ` :: ${detail}`}`)
}

const writeSkill = (area, folder, files = { 'SKILL.md': `# ${folder}\n` }) => {
  for (const [rel, content] of Object.entries(files)) {
    const target = join(area, folder, ...rel.split('/'))
    mkdirSync(join(target, '..'), { recursive: true })
    writeFileSync(target, content)
  }
}

const root = join(process.env.DSH_HOME, 'skills')
const holding = join(process.env.DSH_HOME, 'skills-disabled')
const foreignRoot = join(tmpdir(), `foreign-agents-${Date.now()}`)

const { SkillAdmin } = await import('./lib/skill-admin.js')
const { SkillGroupManager, SkillGroupError, detectSources } = await import('./lib/skill-groups.js')
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

writeSkill(root, 'qqcites', { 'SKILL.md': '---\nname: qqcites\ndescription: 引用\ndescription: 引用候选\n---\n\n# qqcites\n', 'a.md': 'x' })
writeSkill(root, 'qqnote', { 'SKILL.md': '---\nname: qqnote\n---\n\n# qqnote\n' })
writeSkill(root, 'blender', { 'SKILL.md': '---\nname: blender\ndescription: 建模\n---\n\n# blender\n' })
writeSkill(foreignRoot, 'codex-one', { 'SKILL.md': '---\nname: codex-one\n---\n\n# codex-one\n' })
writeSkill(foreignRoot, 'codex-two', { 'SKILL.md': '---\nname: codex-two\n---\n\n# codex-two\n' })

const sources = () => [
  { id: 'dsh', label: 'DSH', root, writable: true, manager: 'DSH' },
  {
    id: 'codex',
    label: 'Codex',
    root: foreignRoot,
    writable: false,
    manager: 'Codex',
    note: '由 Codex 自行加载，本卡不修改它的目录',
  },
]
const storePath = join(process.env.DSH_HOME, 'dsh-brain-skill-groups.json')
const manager = new SkillGroupManager({ sources, admin, storePath: () => storePath })

// ── A. overview ─────────────────────────────────────────────────────────
const overview = await manager.overview()
check('the overview carries the metadata-only promise', String(overview.note).includes('不移动文件'))
check('the note says only DSH switches are real', String(overview.note).includes('只有 DSH 来源的开关会真实启停'))
const dsh = overview.sources.find((source) => source.id === 'dsh')
check('the DSH source lists its three skills', dsh?.total === 3 && dsh?.enabledCount === 3)
check('every skill starts in 未分类', dsh?.groups.length === 1 && dsh?.groups[0].id === 'unassigned' && dsh?.groups[0].total === 3)
check('the DSH switch is editable and real', dsh?.enabledEditable === true && dsh?.cardOnly === false)
const codex = overview.sources.find((source) => source.id === 'codex')
check('a foreign source is read-only and says so', codex?.writable === false && codex?.cardOnly === true && String(codex?.note).includes('不修改'))
check('a foreign source lists its skills', codex?.total === 2)

const detected = detectSources()
check('the detector knows the six software roots',
  ['dsh', 'agents', 'codex', 'workbuddy', 'claude', 'opencode'].every((id) => detected.some((source) => source.id === id)))

// ── B. categories are metadata ──────────────────────────────────────────
const created = await manager.createGroup('dsh', 'QQ-Skill')
check('a category can be created', typeof created.groupId === 'string' && created.name === 'QQ-Skill')
await manager.createGroup('dsh', 'QQ-Skill').then(
  () => check('a duplicate name is refused', false),
  (error) => check('a duplicate name is refused', error instanceof SkillGroupError && error.code === 'duplicate'),
)
await manager.createGroup('dsh', '').then(
  () => check('an empty name is refused', false),
  (error) => check('an empty name is refused', error instanceof SkillGroupError && error.code === 'invalid_name'),
)
await manager.createGroup('nope', 'x').then(
  () => check('an unknown source is refused', false),
  (error) => check('an unknown source is refused', error instanceof SkillGroupError && error.code === 'unknown_source'),
)

await manager.assign('dsh', created.groupId, ['qqcites', 'qqnote'])
let view = await manager.overview()
let dshView = view.sources.find((source) => source.id === 'dsh')
let group = dshView.groups.find((item) => item.id === created.groupId)
check('assigning moves skills out of 未分类', group?.total === 2 && dshView.groups.find((item) => item.id === 'unassigned')?.total === 1)
check('the group shows "2 项 · 2/2 启用" numbers', group?.total === 2 && group?.enabledCount === 2)
check('assigning does not move a single file', existsSync(join(root, 'qqcites', 'SKILL.md')) && existsSync(join(root, 'qqnote', 'SKILL.md')))

const second = await manager.createGroup('dsh', '建模')
await manager.assign('dsh', second.groupId, ['blender', 'qqnote'])
view = await manager.overview()
dshView = view.sources.find((source) => source.id === 'dsh')
check('a skill belongs to at most one category',
  dshView.groups.find((item) => item.id === second.groupId)?.total === 2 &&
  dshView.groups.find((item) => item.id === created.groupId)?.total === 1)

// ── C. real switches for DSH, card-only for others ──────────────────────
const off = await manager.toggleGroup('dsh', second.groupId, false)
check('switching a DSH category off really parks its skills',
  off.cardOnly === false && off.applied.length === 2 && existsSync(join(holding, 'blender')) && !existsSync(join(root, 'blender')))
view = await manager.overview()
dshView = view.sources.find((source) => source.id === 'dsh')
check('the parked skill is reported as disabled', dshView.groups.find((item) => item.id === second.groupId)?.enabledCount === 0)
const on = await manager.toggleGroup('dsh', second.groupId, true)
check('switching it back restores the folders',
  on.applied.length === 2 && existsSync(join(root, 'blender')) && !existsSync(join(holding, 'blender')))

const codexGroup = await manager.createGroup('codex', '外部组')
await manager.assign('codex', codexGroup.groupId, ['codex-one'])
const before = readFileSync(join(foreignRoot, 'codex-one', 'SKILL.md'), 'utf8')
const codexOff = await manager.toggleGroup('codex', codexGroup.groupId, false)
check('a foreign category switch is card-only', codexOff.cardOnly === true && codexOff.applied.length === 0)
check('a foreign directory is left byte-identical',
  existsSync(join(foreignRoot, 'codex-one', 'SKILL.md')) && readFileSync(join(foreignRoot, 'codex-one', 'SKILL.md'), 'utf8') === before)
view = await manager.overview()
const codexView = view.sources.find((source) => source.id === 'codex')
check('the card-only switch is visible as in-card disabled',
  codexView.groups.find((item) => item.id === codexGroup.groupId)?.skills[0]?.inCardDisabled === true)
const codexSourceOff = await manager.toggleSource('codex', false)
check('a foreign source switch is card-only too', codexSourceOff.cardOnly === true)
const codexSourceOn = await manager.toggleSource('codex', true)
check('the foreign source switch restores in-card visibility', codexSourceOn.enabled === true)

// ── D. rename / delete ──────────────────────────────────────────────────
const renamed = await manager.renameGroup('dsh', created.groupId, 'QQ 技能')
check('a category can be renamed', renamed.name === 'QQ 技能')
const deleted = await manager.deleteGroup('dsh', created.groupId)
check('deleting a category releases its skills', deleted.released === 1)
view = await manager.overview()
dshView = view.sources.find((source) => source.id === 'dsh')
check('released skills are back in 未分类', dshView.groups.find((item) => item.id === 'unassigned')?.total === 1)
check('deleting a category never deletes a file', existsSync(join(root, 'qqcites', 'SKILL.md')))

// The 未分类 bucket switch parks exactly the skills no category claims.
const bucketOff = await manager.toggleGroup('dsh', 'unassigned', false)
check('the 未分类 switch parks only the unclaimed skills',
  bucketOff.cardOnly === false && bucketOff.applied.join(',') === 'qqcites' && existsSync(join(holding, 'qqcites')))
const bucketOn = await manager.toggleGroup('dsh', 'unassigned', true)
check('the 未分类 switch restores them',
  bucketOn.applied.join(',') === 'qqcites' && existsSync(join(root, 'qqcites')))

check('the remaining category is untouched', dshView.groups.find((item) => item.id === second.groupId)?.total === 2)

// ── E. persistence and route surface ────────────────────────────────────
const reopened = new SkillGroupManager({ sources, admin, storePath: () => storePath })
const afterReload = await reopened.overview()
check('categories survive a manager restart',
  afterReload.sources.find((source) => source.id === 'dsh')?.groups.some((item) => item.name === '建模'))
check('the sidecar holds metadata only, never a file path',
  !readFileSync(storePath, 'utf8').includes('SKILL.md'))

const store = new SettingsStore({ baseUrl: 'https://memory.example.org/api/longmemory' }, join(process.env.DSH_HOME, 'dsh-brain.json'))
const reporter = new Reporter({
  client: () => ({ reportTurn: async () => ({ ok: true, status: 200, data: {} }) }),
  settings: () => ({ enabled: true, clientId: 'tree' }),
  activityToken: () => '',
  summary: () => ({ enabled: false, maxChars: 1000 }),
  summaryToken: () => '',
  log: () => {},
})
const routes = createRoutes({
  version: '0.5.0-test',
  store,
  reporter,
  client: () => ({ reach: async () => ({ ok: false, status: 0, message: 'stub' }) }),
  admin,
  groups: reopened,
})
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
  const headers = { accept: 'application/json' }
  let payload
  if (body !== undefined) {
    headers['content-type'] = 'application/json'
    payload = JSON.stringify(body)
  }
  const response = await fetch(`${origin}${path}`, { method, headers, body: payload })
  const text = await response.text()
  let parsed = null
  try {
    parsed = JSON.parse(text)
  } catch {
    parsed = null
  }
  return { status: response.status, body: parsed }
}

const sourcesResponse = await call('GET', '/dsh-brain/skills/sources')
check('the sources route answers with the tree', sourcesResponse.status === 200 && Array.isArray(sourcesResponse.body?.sources))
check('the tree carries the metadata-only note', String(sourcesResponse.body?.note).includes('不移动文件'))
check('POST on the sources route is refused', (await call('POST', '/dsh-brain/skills/sources', {}))?.status === 405)

const viaRoute = await call('POST', '/dsh-brain/skills/groups/create', { sourceId: 'dsh', name: '路由组' })
check('a category can be created over HTTP', viaRoute.status === 200 && typeof viaRoute.body?.groupId === 'string')
const dupViaRoute = await call('POST', '/dsh-brain/skills/groups/create', { sourceId: 'dsh', name: '路由组' })
check('a duplicate over HTTP is a 400', dupViaRoute.status === 400 && dupViaRoute.body?.code === 'duplicate')
const missingGroup = await call('POST', '/dsh-brain/skills/groups/delete', { sourceId: 'dsh', groupId: 'g_missing' })
check('an unknown category is a 404', missingGroup.status === 404)
const revealMissing = await call('POST', '/dsh-brain/skills/source/reveal', { sourceId: 'agents' })
check('revealing a missing directory reports not_found instead of failing silently', revealMissing.status === 404 || revealMissing.status === 200)

server.close()

const failed = results.filter((item) => !item.ok).length
console.log(failed === 0 ? `\nALL ${results.length} CHECKS PASSED` : `\n${failed} CHECK(S) FAILED`)
process.exit(failed === 0 ? 0 : 1)
