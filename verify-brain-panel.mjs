// Runtime verification for the v0.5 management surface (P1 + P2):
//   * status / capabilities payloads the card renders
//   * config writes: origin change must not hand old tokens to a new service
//   * skill inventory / detail / toggle
//   * staged install: preview, explicit selection, conflict skip, plan expiry
//   * uninstall: impact preview + single-use confirmation token
//   * route gates: method, origin, content-type, path traversal
//
// Everything runs against the real route table wired to a real HTTP server and
// a throwaway $DSH_HOME; nothing touches the user's skills or config.
import http from 'node:http'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'brain-home-'))

const results = []
function check(name, ok, detail) {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail === undefined ? '' : ` :: ${detail}`}`)
}

const root = join(process.env.DSH_HOME, 'skills')
const holding = join(process.env.DSH_HOME, 'skills-disabled')
const writeSkill = (area, folder, files) => {
  for (const [rel, content] of Object.entries(files)) {
    const target = join(area, folder, ...rel.split('/'))
    mkdirSync(join(target, '..'), { recursive: true })
    writeFileSync(target, content)
  }
}

const { SettingsStore } = await import('./lib/store.js')
const { Reporter } = await import('./lib/reporter.js')
const { SkillAdmin } = await import('./lib/skill-admin.js')
const { createRoutes } = await import('./lib/routes.js')

// A placeholder address the packaged patch ships: the card must call it
// "未配置服务", never a healthy connection.
const store = new SettingsStore(
  { baseUrl: 'https://your-memory-host/api/longmemory', clientId: 'test-client', requestTimeoutMs: 2000, defaultK: 7 },
  join(process.env.DSH_HOME, 'dsh-brain.json'),
)
const reporter = new Reporter({
  client: () => ({
    reportTurn: async () => ({ ok: true, status: 200, data: {} }),
    submitSummary: async () => ({ ok: true, status: 200, data: {} }),
  }),
  settings: () => ({ enabled: true, clientId: 'test-client' }),
  activityToken: () => '',
  summary: () => ({ enabled: false, maxChars: 1000 }),
  summaryToken: () => '',
  log: () => {},
})
const admin = new SkillAdmin({
  skillsRoot: () => root,
  holdingDir: () => holding,
  syncStatePath: () => join(process.env.DSH_HOME, 'dsh-brain-skills.json'),
  syncRunning: () => false,
  log: () => {},
})
const routes = createRoutes({
  version: '0.5.0-test',
  store,
  reporter,
  client: () => ({
    reach: async () => ({ ok: false, status: 0, message: 'stub' }),
    probeActivity: async () => ({ ok: false, error: { status: 0, code: 'network_error', message: 'stub' } }),
    projects: async () => ({ ok: false, error: { status: 0, code: 'network_error', message: 'stub' } }),
    probeSummary: async () => ({ ok: false, error: { status: 0, code: 'network_error', message: 'stub' } }),
    login: async () => ({ ok: false, error: { status: 401, code: 'unauthorized', message: 'stub' } }),
  }),
  skills: () => ({ running: false, downloaded: [], uploaded: [], updated: [], conflicts: [], skipped: 0 }),
  admin,
})

const server = http.createServer((req, res) => {
  const path = (req.url ?? '/').split('?')[0]
  for (const route of routes) {
    if (route.kind === 'exact' && path === route.path) return route.handler(req, res)
    if (route.kind === 'prefix' && (path === route.path || path.startsWith(`${route.path}/`))) return route.handler(req, res)
  }
  res.writeHead(404, { 'content-type': 'application/json' })
  res.end('{"ok":false,"error":"no-route"}')
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const origin = `http://127.0.0.1:${server.address().port}`

async function call(method, path, body, extraHeaders) {
  const headers = { accept: 'application/json', ...(extraHeaders ?? {}) }
  let payload
  if (body !== undefined) {
    headers['content-type'] = headers['content-type'] ?? 'application/json'
    payload = typeof body === 'string' ? body : JSON.stringify(body)
  }
  const response = await fetch(`${origin}${path}`, { method, headers, body: payload })
  const text = await response.text()
  let parsed = null
  try {
    parsed = JSON.parse(text)
  } catch {
    parsed = null
  }
  return { status: response.status, body: parsed, text }
}

// ── A. status / capabilities ────────────────────────────────────────────
let status = await call('GET', '/dsh-brain/status')
check('status is 200 with ok:true', status.status === 200 && status.body?.ok === true)
check('a placeholder address is reported as unconfigured', status.body?.settings?.baseUrlConfigured === false, String(status.body?.settings?.baseUrlConfigured))
check('the effective origin is exposed for the change warning', status.body?.settings?.baseUrlOrigin === 'https://your-memory-host')
check('capabilities carry the plugin version', status.body?.capabilities?.version === '0.5.0-test')
check('the market is reported unavailable instead of faked off', status.body?.capabilities?.features?.skillsMarketplace === false)
check('the MCP bridge is declared as a host-plugin surface', status.body?.capabilities?.features?.mcpBridge === 'host-plugin')
check('no check has run yet', status.body?.lastCheck === null)

const caps = await call('GET', '/dsh-brain/capabilities')
check('capabilities route answers on its own', caps.status === 200 && caps.body?.features?.skills === true)
check('capabilities notes state the gaps', Array.isArray(caps.body?.notes) && caps.body.notes.length >= 2)

// ── B. config writes ────────────────────────────────────────────────────
check('GET on the config route is refused', (await call('GET', '/dsh-brain/config')).status === 405)
const evil = await call('PUT', '/dsh-brain/config', { clientId: 'x' }, { origin: 'https://evil.example' })
check('a foreign Origin is rejected', evil.status === 403 && evil.body?.error === 'origin-rejected')
const plain = await call('PUT', '/dsh-brain/config', 'clientId=x', { 'content-type': 'text/plain' })
check('a non-JSON body is refused', plain.status === 415)

store.patch({ activityToken: 'cmt_activity_token_1', memoryToken: 'cmt_memory_token_1', summaryToken: 'cmt_summary_token_1' })
const switched = await call('PUT', '/dsh-brain/config', { baseUrl: 'https://memory.example.org/api/longmemory' }, { origin })
check('changing the service origin is accepted', switched.status === 200 && switched.body?.ok === true)
check('the old origin tokens are cleared on a service switch',
  Array.isArray(switched.body?.credentialsCleared) && switched.body.credentialsCleared.sort().join(',') === 'activity,memory,summary',
  JSON.stringify(switched.body?.credentialsCleared))
check('the cleared tokens are really gone from the store',
  store.activityToken() === '' && store.memoryToken() === '' && store.summaryToken() === '')
const sameOriginSave = await call('PUT', '/dsh-brain/config', { activityToken: 'cmt_new_activity' }, { origin })
check('a token supplied with the new origin is kept', sameOriginSave.status === 200 && store.activityToken() === 'cmt_new_activity')
const noChange = await call('PUT', '/dsh-brain/config', { defaultK: 25 }, { origin })
check('an ordinary save does not touch credentials', noChange.body?.credentialsCleared === undefined && store.activityToken() === 'cmt_new_activity')
check('defaultK is renamed in the payload but still bounded', store.settings().defaultK === 25)

// ── C. skill inventory / detail / toggle ────────────────────────────────
writeSkill(root, 'gamma', { 'SKILL.md': '---\nname: gamma\ndescription: 演示技能\n---\n\n# gamma\n', 'references/a.md': '说明' })
writeSkill(holding, 'parked-one', { 'SKILL.md': '# parked-one\n' })
let inventory = await call('GET', '/dsh-brain/skills/api')
check('inventory lists root and parked skills', inventory.body?.skills?.length === 2)
const gamma = inventory.body?.skills?.find((skill) => skill.folder === 'gamma')
check('inventory carries owner, hash and install time',
  gamma?.ownerManager === 'dsh-brain' && typeof gamma?.skillSha256 === 'string' && typeof gamma?.installedAt === 'string')
check('inventory carries a byte size and file count', gamma?.files === 2 && gamma?.bytes > 0)
check('parked skills are marked disabled', inventory.body?.skills?.find((skill) => skill.folder === 'parked-one')?.enabled === false)
check('pending plans come with the inventory', Array.isArray(inventory.body?.plans))

const detail = await call('POST', '/dsh-brain/skills/detail', { folder: 'gamma' })
check('detail returns the SKILL.md text', detail.status === 200 && String(detail.body?.skillMd).includes('# gamma'))
check('detail returns the file list', Array.isArray(detail.body?.files) && detail.body.files.length === 2)
const traversal = await call('POST', '/dsh-brain/skills/toggle', { folder: '../escape', enabled: false })
check('a traversal folder name is refused', traversal.status === 400 && traversal.body?.code === 'invalid_name')

const toggled = await call('POST', '/dsh-brain/skills/toggle', { folder: 'gamma', enabled: false })
check('disable parks the folder', toggled.status === 200 && existsSync(join(holding, 'gamma')) && !existsSync(join(root, 'gamma')))
check('the toggle answer explains the effect scope', String(toggled.body?.note).includes('新会话'))
const enabled = await call('POST', '/dsh-brain/skills/toggle', { folder: 'gamma', enabled: true })
check('enable brings it back', enabled.status === 200 && existsSync(join(root, 'gamma')))

// ── D. staged install ───────────────────────────────────────────────────
const repo = mkdtempSync(join(tmpdir(), 'brain-repo-'))
writeSkill(repo, 'alpha', { 'SKILL.md': '# alpha\n', 'run.mjs': 'console.log(1)' })
writeSkill(repo, 'beta', { 'SKILL.md': '# beta\n' })
writeSkill(repo, 'gamma', { 'SKILL.md': '# gamma from repo\n' })
execFileSync('git', ['init', '-q', repo])
execFileSync('git', ['-C', repo, 'add', '-A'])
execFileSync('git', ['-C', repo, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'fixture'])

const badPlan = await call('POST', '/dsh-brain/skills/install/plan', { url: 'javascript:alert(1)' })
check('a non-git URL never reaches the stager', badPlan.status === 400 && badPlan.body?.code === 'invalid_url')

const plan = await call('POST', '/dsh-brain/skills/install/plan', { url: `file://${repo}` })
check('staging a repository answers with a plan', plan.status === 200 && typeof plan.body?.planId === 'string')
const candidates = Array.isArray(plan.body?.candidates) ? plan.body.candidates : []
check('every candidate is described before it is installed',
  candidates.length === 3 && candidates.every((item) => typeof item.files === 'number' && typeof item.id === 'string'))
check('an existing skill shows up as a conflict',
  candidates.find((item) => item.folder === 'gamma')?.conflict === true)
check('candidates list the scripts they carry',
  Array.isArray(candidates.find((item) => item.folder === 'alpha')?.scripts) &&
  candidates.find((item) => item.folder === 'alpha').scripts.includes('run.mjs'))
check('staging does not write into the skills root yet',
  !existsSync(join(root, 'alpha')) && !existsSync(join(root, 'beta')))

const committed = await call('POST', '/dsh-brain/skills/install/commit', { planId: plan.body.planId, folders: ['alpha'] })
check('only the selected folder is installed',
  committed.status === 200 && committed.body?.installed?.join(',') === 'alpha' && !existsSync(join(root, 'beta')))
check('the unselected candidate stays pending', committed.body?.remaining?.includes('beta'))
check('the staged clone is removed after the commit',
  readdirSync(join(process.env.DSH_HOME, '.dsh-brain-staging')).length === 0)
const again = await call('POST', '/dsh-brain/skills/install/plan', { url: `file://${repo}` })
const collide = await call('POST', '/dsh-brain/skills/install/commit', { planId: again.body.planId, folders: ['alpha'] })
check('a second install of the same folder is skipped, never overwritten',
  collide.body?.installed?.length === 0 && collide.body?.skipped?.[0]?.reason === 'already_exists')
const expired = await call('POST', '/dsh-brain/skills/install/commit', { planId: 'plan_missing', folders: ['alpha'] })
check('an unknown plan id is refused with plan_expired', expired.status === 409 && expired.body?.code === 'plan_expired')
check('the second plan was cleaned up as well',
  readdirSync(join(process.env.DSH_HOME, '.dsh-brain-staging')).length === 0)

// ── E. uninstall: preview then single-use token ─────────────────────────
const noConfirm = await call('POST', '/dsh-brain/skills/remove', { folder: 'alpha' })
check('remove without confirmation is refused', noConfirm.status === 409 && noConfirm.body?.code === 'confirmation_required')
const noToken = await call('POST', '/dsh-brain/skills/remove', { folder: 'alpha', confirmed: true })
check('remove without a preview token is refused', noToken.status === 409 && noToken.body?.code === 'confirmation_required')
const impact = await call('POST', '/dsh-brain/skills/uninstall/plan', { folder: 'alpha' })
check('the impact preview names the real directory and files',
  impact.status === 200 && impact.body.dir === join(root, 'alpha') && impact.body.files >= 2)
check('the preview states that deletion is irreversible', impact.body.recoverable === false && String(impact.body.note).includes('不可恢复'))
check('the preview names the scripts that would be deleted', impact.body.scripts.includes('run.mjs'))
const wrongFolder = await call('POST', '/dsh-brain/skills/remove', { folder: 'beta', token: impact.body.token, confirmed: true })
check('a token issued for one skill cannot delete another', wrongFolder.status === 409)
const removed = await call('POST', '/dsh-brain/skills/remove', { folder: 'alpha', token: impact.body.token, confirmed: true })
check('a confirmed remove with the right token deletes the folder', removed.status === 200 && !existsSync(join(root, 'alpha')))
const reused = await call('POST', '/dsh-brain/skills/remove', { folder: 'gamma', token: impact.body.token, confirmed: true })
check('the confirmation token is single-use', reused.status === 409)
check('deleting one skill leaves the others alone', existsSync(join(root, 'gamma')) && existsSync(join(holding, 'parked-one')))

// ── F. route gates on the skills prefix ─────────────────────────────────
const wrongMethod = await call('GET', '/dsh-brain/skills/toggle')
check('a GET on a write action is refused', wrongMethod.status === 405)
const wrongType = await call('POST', '/dsh-brain/skills/detail', 'folder=gamma', { 'content-type': 'text/plain' })
check('a form-encoded write is refused', wrongType.status === 415)
const unknown = await call('POST', '/dsh-brain/skills/nope', {})
check('an unknown skill subroute is a 404', unknown.status === 404)

server.close()

const failed = results.filter((item) => !item.ok).length
console.log(failed === 0 ? `\nALL ${results.length} CHECKS PASSED` : `\n${failed} CHECK(S) FAILED`)
process.exit(failed === 0 ? 0 : 1)
