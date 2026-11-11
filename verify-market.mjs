// Verification for P3 market: provider parsing + the market plan/commit routes.
//
// Two layers:
//   1. the Claude plugin marketplace provider is exercised with a stubbed
//      fetch, so the manifest/search/detail/resolve contract is deterministic;
//   2. the routes are exercised against a real HTTP server, a real SkillAdmin
//      and a real throwaway git repository (file://), so an install genuinely
//      clones, pins the commit and writes `.skill-source.json`.
import http from 'node:http'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'brain-market-'))

const results = []
function check(name, ok, detail) {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail === undefined ? '' : ` :: ${detail}`}`)
}

// ── 1. Provider parsing with a stubbed fetch ────────────────────────────
const { ClaudePluginMarketplaceProvider, MarketService, MarketError } = await import('./lib/market.js')

const manifest = {
  name: 'anthropic-agent-skills',
  owner: { name: 'Anthropic' },
  metadata: { version: '1.0.0' },
  plugins: [
    { name: 'document-skills', description: 'Excel/Word/PPT/PDF', source: './', skills: ['./skills/xlsx', './skills/docx'] },
    { name: 'example-skills', description: 'creative examples', source: './', skills: ['./skills/algorithmic-art'] },
  ],
}
const skillMd = {
  'skills/xlsx/SKILL.md': '---\nname: xlsx\ndescription: Spreadsheet skill\n---\n# xlsx\n',
  'skills/docx/SKILL.md': '---\nname: docx\ndescription: Word skill\n---\n# docx\n',
  'skills/algorithmic-art/SKILL.md': '---\nname: algorithmic-art\ndescription: art\n---\n# art\n',
}
const stubFetch = async (url) => {
  const path = String(url)
  if (path.includes('/.claude-plugin/marketplace.json')) return { ok: true, status: 200, text: async () => JSON.stringify(manifest) }
  if (path.includes('/commits/')) return { ok: true, status: 200, text: async () => JSON.stringify({ sha: 'f00dbabe1234567890abcdef1234567890abcdef' }) }
  for (const [rel, body] of Object.entries(skillMd)) {
    if (path.includes(`/${rel}`)) return { ok: true, status: 200, text: async () => body }
  }
  return { ok: false, status: 404, text: async () => 'not found' }
}

const provider = new ClaudePluginMarketplaceProvider({
  id: 'anthropic-skills', label: 'Anthropic', description: 'test', repo: 'anthropics/skills', ref: 'main', fetchImpl: stubFetch,
})
const all = await provider.search('', 0)
check('provider lists all manifest plugins', all.entries.length === 2, String(all.entries.length))
check('entries carry normalized skill folder names', all.entries[0].skills.join(',') === 'xlsx,docx', all.entries[0].skills.join(','))
const filtered = await provider.search('word', 0)
check('search filters by description/skill text', filtered.entries.length === 1 && filtered.entries[0].id === 'document-skills')
const detail = await provider.getDetail('document-skills')
check('detail reads SKILL.md frontmatter per skill', detail.skillDetails.length === 2 && detail.skillDetails[0].name === 'xlsx', JSON.stringify(detail.skillDetails.map((s) => s.name)))
const artifact = await provider.resolveArtifact('example-skills')
check('resolveArtifact pins the resolved commit', artifact.commit === 'f00dbabe1234567890abcdef1234567890abcdef', String(artifact.commit))
check('resolveArtifact returns the entry folders', artifact.folders.join(',') === 'algorithmic-art')

// A provider that fails must surface a typed MarketError, not a raw throw.
let typed = false
try { await new MarketService([]).search('nope', '', 0) } catch (error) { typed = error instanceof MarketError && error.code === 'unknown_provider' }
check('unknown provider raises a typed MarketError', typed)

// ── 2. Routes against a real git repo ───────────────────────────────────
const root = join(process.env.DSH_HOME, 'skills')
const holding = join(process.env.DSH_HOME, 'skills-disabled')
const repoDir = join(process.env.DSH_HOME, 'src-repo')
mkdirSync(join(repoDir, 'skills', 'alpha'), { recursive: true })
mkdirSync(join(repoDir, 'skills', 'beta'), { recursive: true })
writeFileSync(join(repoDir, 'skills', 'alpha', 'SKILL.md'), '---\nname: alpha\ndescription: alpha skill\n---\n# alpha\n')
mkdirSync(join(repoDir, 'skills', 'alpha', 'references'), { recursive: true })
writeFileSync(join(repoDir, 'skills', 'alpha', 'references', 'a.md'), 'note')
writeFileSync(join(repoDir, 'skills', 'beta', 'SKILL.md'), '---\nname: beta\n---\n# beta\n')
execFileSync('git', ['init', '-b', 'main'], { cwd: repoDir })
execFileSync('git', ['-C', repoDir, 'add', '-A'])
execFileSync('git', ['-C', repoDir, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-m', 'init'])
const commit = execFileSync('git', ['-C', repoDir, 'rev-parse', 'HEAD']).toString().trim()
const repoUrl = 'file://' + repoDir.replace(/\\/g, '/')

const { SettingsStore } = await import('./lib/store.js')
const { Reporter } = await import('./lib/reporter.js')
const { SkillAdmin } = await import('./lib/skill-admin.js')
const { createRoutes } = await import('./lib/routes.js')

const store = new SettingsStore({ clientId: 'test', requestTimeoutMs: 2000, defaultK: 10 }, join(process.env.DSH_HOME, 'dsh-brain.json'))
const reporter = new Reporter({
  client: () => ({ reportTurn: async () => ({ ok: true, status: 200, data: {} }), submitSummary: async () => ({ ok: true, status: 200, data: {} }) }),
  settings: () => ({ enabled: true, clientId: 'test' }), activityToken: () => '', summary: () => ({ enabled: false, maxChars: 1 }), summaryToken: () => '', log: () => {},
})
const admin = new SkillAdmin({ skillsRoot: () => root, holdingDir: () => holding, syncStatePath: () => join(process.env.DSH_HOME, 'dsh-brain-skills.json'), syncRunning: () => false, log: () => {} })
const entry = { id: 'alpha', providerId: 'fake', name: 'alpha', description: 'fake alpha', skills: ['alpha'], skillPaths: ['./skills/alpha'], sourceRepo: 'local/repo', sourceUrl: 'file://x' }
const fakeProvider = {
  info: () => ({ id: 'fake', label: 'Fake', description: 'local', source: 'local/repo', homepage: 'https://example' }),
  search: async () => ({ entries: [entry] }),
  getDetail: async () => ({ ...entry, skillDetails: [{ folder: 'alpha', path: './skills/alpha', name: 'alpha', ok: true }], fetchedAt: Date.now() }),
  resolveArtifact: async () => ({ repoUrl, ref: 'main', commit, folders: ['alpha'] }),
}
const market = new MarketService([fakeProvider])
const routes = createRoutes({
  version: '0.6.0-test', store, reporter,
  client: () => ({ reach: async () => ({ ok: false, status: 0, message: 'stub' }), listSkills: async () => ({ ok: true, status: 200, data: { items: [] } }), skillBundle: async () => ({ ok: false, error: { status: 404, code: 'x', message: 'x' } }) }),
  admin, market,
})
const server = http.createServer((req, res) => {
  const path = (req.url ?? '/').split('?')[0]
  for (const route of routes) {
    if (route.kind === 'exact' && path === route.path) return route.handler(req, res)
    if (route.kind === 'prefix' && (path === route.path || path.startsWith(`${route.path}/`))) return route.handler(req, res)
  }
  res.writeHead(404); res.end('{"ok":false}')
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const origin = `http://127.0.0.1:${server.address().port}`
async function call(method, path, body) {
  const headers = { accept: 'application/json' }
  let payload
  if (body !== undefined) { headers['content-type'] = 'application/json'; payload = JSON.stringify(body) }
  const response = await fetch(`${origin}${path}`, { method, headers, body: payload })
  return { status: response.status, body: await response.json().catch(() => null) }
}

const caps = await call('GET', '/dsh-brain/capabilities')
check('capabilities advertise the wired market', caps.body?.features?.skillsMarketplace === true && caps.body?.features?.marketProviders === 1)
const providers = await call('GET', '/dsh-brain/market/providers')
check('providers route lists the provider', providers.body?.providers?.[0]?.id === 'fake')
const search = await call('GET', '/dsh-brain/market/search?provider=fake&q=alp')
check('search route returns entries', search.status === 200 && search.body?.entries?.length === 1)
const unknown = await call('GET', '/dsh-brain/market/search?provider=nope&q=')
check('unknown provider is a 400', unknown.status === 400 && unknown.body?.code === 'unknown_provider')
const det = await call('POST', '/dsh-brain/market/detail', { provider: 'fake', id: 'alpha' })
check('detail route returns skill metadata', det.status === 200 && det.body?.skillDetails?.[0]?.name === 'alpha')

const plan = await call('POST', '/dsh-brain/market/plan', { provider: 'fake', id: 'alpha' })
check('plan route returns a staged plan', plan.status === 200 && typeof plan.body?.planId === 'string', JSON.stringify(plan.body).slice(0, 120))
check('plan pins the resolved commit', plan.body?.commit === commit)
check('plan only exposes the entry folders (beta excluded)', Array.isArray(plan.body?.candidates) && plan.body.candidates.length === 1 && plan.body.candidates[0].folder === 'alpha')
const commitRes = await call('POST', '/dsh-brain/market/commit', { planId: plan.body?.planId, folders: ['alpha'] })
check('commit installs the selected skill', commitRes.status === 200 && commitRes.body?.installed?.includes('alpha'), JSON.stringify(commitRes.body))
check('installed skill has a SKILL.md', existsSync(join(root, 'alpha', 'SKILL.md')))
check('beta was never installed', !existsSync(join(root, 'beta')))
const source = JSON.parse(readFileSync(join(root, 'alpha', '.skill-source.json'), 'utf8'))
check('provenance records provider/commit/sourcePath', source.provider === 'fake' && source.commit === commit && source.sourcePath.includes('alpha'), JSON.stringify(source))

await new Promise((resolve) => server.close(resolve))

const passed = results.filter((r) => r.ok).length
console.log(`\n${passed}/${results.length} passed`)
process.exit(passed === results.length ? 0 : 1)
