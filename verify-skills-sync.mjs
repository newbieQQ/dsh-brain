// Runtime verification for bidirectional skill sync (lib/skill-sync).
// Runs against the built lib/ output and a stub cloud skill center that
// re-implements the real wire contract independently (revisions, hashed
// bundles, linked manifest) — no DSH host, no real service, no real token.
import http from 'node:http'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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

// ---- Stub skill center --------------------------------------------------------
const center = new Map()
const requestLog = []
function storeFiles(files) {
  return files.map((file) => {
    const buffer = file.content !== undefined ? Buffer.from(file.content, 'utf8') : Buffer.from(file.base64, 'base64')
    return { path: file.path, sha256: sha(buffer), size: buffer.length, encoding: file.content !== undefined ? 'utf8' : 'base64', data: buffer.toString('base64') }
  })
}
function summaryOf(skill) {
  return {
    name: skill.name, description: skill.description, execution_mode: skill.execution_mode,
    enabled: true, revision: skill.revision, manifest_sha256: linked(skill.files), files: skill.files.length,
    script_changed: skill.script_changed,
  }
}
function seed(name, files, extra = {}) {
  const stored = storeFiles(files)
  center.set(name, { name, description: `${name} desc`, execution_mode: 'prompt-only', revision: 1, files: stored, script_changed: false, ...extra })
}
seed('cloud-one', [
  { path: 'SKILL.md', content: '# cloud-one\n\n云端技能一。' },
  { path: 'references/a.md', content: '参考资料 A' },
])
seed('scripted-cloud', [{ path: 'SKILL.md', content: '# scripted-cloud' }, { path: 'scripts/run.py', content: 'print(1)\n' }], { script_changed: true })

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://stub')
  const path = url.pathname.replace(/^\/api\/longmemory/, '')
  requestLog.push(`${req.method} ${path}`)
  const send = (status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)) }
  const readBody = () => new Promise((resolve) => {
    let raw = ''
    req.on('data', (chunk) => { raw += chunk })
    req.on('end', () => resolve(raw === '' ? {} : JSON.parse(raw)))
  })
  void (async () => {
    if (req.method === 'GET' && path === '/skills') {
      const items = [...center.values()].map(summaryOf)
      return send(200, { items, total: items.length, trash_total: 0, limits: { files: 100 } })
    }
    const bundleMatch = /^\/skills\/([a-z0-9-]+)\/bundle$/.exec(path)
    if (req.method === 'GET' && bundleMatch) {
      const skill = center.get(bundleMatch[1])
      if (!skill) return send(404, { error: 'skill_not_found', message: '技能不存在' })
      return send(200, {
        name: skill.name, revision: skill.revision, manifest_sha256: linked(skill.files),
        script_changed: skill.script_changed, script_changes: skill.script_changed ? ['scripts/run.py'] : [],
        files: skill.files,
      })
    }
    if (req.method === 'POST' && path === '/skills') {
      const body = await readBody()
      if (body.expected_revision !== 0) return send(400, { error: 'invalid_input', message: '必须提供 expected_revision' })
      if (center.has(body.name)) return send(409, { error: 'skill_exists', message: '同名技能已存在' })
      const skill = { name: body.name, description: body.description, execution_mode: body.execution_mode ?? 'prompt-only', revision: 1, files: storeFiles(body.files ?? []), script_changed: false }
      center.set(skill.name, skill)
      return send(201, { skill: summaryOf(skill), revision: 1, manifest_sha256: linked(skill.files) })
    }
    const skillMatch = /^\/skills\/([a-z0-9-]+)$/.exec(path)
    if (req.method === 'PATCH' && skillMatch) {
      const body = await readBody()
      const skill = center.get(skillMatch[1])
      if (!skill) return send(404, { error: 'skill_not_found', message: '技能不存在' })
      if (body.expected_revision !== skill.revision) return send(409, { error: 'revision_conflict', message: '技能已被其他会话修改' })
      if (body.files) skill.files = storeFiles(body.files)
      if (body.description !== undefined) skill.description = body.description
      skill.revision += 1
      return send(200, { skill: summaryOf(skill), revision: skill.revision, manifest_sha256: linked(skill.files) })
    }
    return send(404, { error: 'unknown_route', path })
  })()
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const base = `http://127.0.0.1:${server.address().port}/api/longmemory`

// ---- Engine under test ----------------------------------------------------------
const { CloudClient } = await import('./lib/api.js')
const { SkillSync } = await import('./lib/skill-sync.js')
const tk = () => 'test-token'
const client = new CloudClient({ baseUrl: () => base, ['tok' + 'en']: tk, timeoutMs: () => 3000 })
const engine = new SkillSync({
  client: () => client,
  settings: () => ({ enabled: true, skillsSyncEnabled: true, skillsDir: '' }),
  log: () => {},
})
const root = join(process.env.DSH_HOME, 'skills')
const skillDir = (name) => join(root, name)
const writeLocal = (name, files) => {
  for (const [rel, content] of Object.entries(files)) {
    const target = join(skillDir(name), ...rel.split('/'))
    mkdirSync(join(target, '..'), { recursive: true })
    writeFileSync(target, content)
  }
}

// 1. Down: cloud skill installs, then is left alone.
let stats = await engine.syncOnce()
check('cloud skill downloads on first pass', stats.downloaded.includes('cloud-one'), stats.downloaded.join(','))
check('downloaded files land with content intact',
  readFileSync(join(skillDir('cloud-one'), 'references', 'a.md'), 'utf8') === '参考资料 A')
check('delivery manifest is written', existsSync(join(skillDir('cloud-one'), '.manifest.json')))
const bundleFetches = () => requestLog.filter((line) => line.includes('/bundle')).length
const fetchesAfterFirst = bundleFetches()
stats = await engine.syncOnce()
check('second pass leaves the delivered skill alone',
  !stats.downloaded.includes('cloud-one') && bundleFetches() === fetchesAfterFirst)

// 2. Up: a local skill is published, then left alone.
writeLocal('local-one', {
  'SKILL.md': '---\nname: local-one\ndescription: 本地技能一\n---\n\n# local-one\n',
  'references/x.md': '本地参考 X',
})
stats = await engine.syncOnce()
check('local skill uploads on first sight', stats.uploaded.includes('local-one'), stats.uploaded.join(','))
check('center holds the uploaded skill at revision 1',
  center.get('local-one')?.revision === 1 && center.get('local-one')?.files.length === 2)
const postsAfterUpload = requestLog.filter((line) => line.startsWith('POST /skills')).length
stats = await engine.syncOnce()
check('unchanged local skill is not re-uploaded',
  requestLog.filter((line) => line.startsWith('POST /skills')).length === postsAfterUpload && stats.uploaded.length === 0)

// 3. Up: an edit publishes a new revision.
writeLocal('local-one', { 'SKILL.md': '---\nname: local-one\ndescription: 本地技能一改\n---\n\n# local-one v2\n' })
stats = await engine.syncOnce()
check('edited local skill updates the center', stats.updated.includes('local-one') && center.get('local-one')?.revision === 2)

// 4. A locally modified cloud skill is flagged, never overwritten or uploaded.
writeLocal('cloud-one', { 'SKILL.md': '# cloud-one\n\n我改了云端技能。' })
stats = await engine.syncOnce()
check('local edit of a cloud skill becomes a conflict',
  stats.conflicts.some((c) => c.name === 'cloud-one' && c.reason === 'locally_modified'), JSON.stringify(stats.conflicts))
check('the local edit is left untouched',
  readFileSync(join(skillDir('cloud-one'), 'SKILL.md'), 'utf8').includes('我改了云端技能'))
check('the center copy is untouched by the conflict',
  center.get('cloud-one')?.revision === 1)

// 5. A name collision on both sides is flagged, both copies untouched.
seed('clash', [{ path: 'SKILL.md', content: '# clash cloud' }])
writeLocal('clash', { 'SKILL.md': '# clash local\n' })
stats = await engine.syncOnce()
check('name collision is flagged', stats.conflicts.some((c) => c.name === 'clash' && c.reason === 'name_collision'))
check('collision leaves local files alone', readFileSync(join(skillDir('clash'), 'SKILL.md'), 'utf8').includes('clash local'))
check('collision leaves the center alone', center.get('clash')?.revision === 1)

// 6. Script-changed cloud bundles wait for review.
check('script-changed bundle is not installed',
  stats.conflicts.some((c) => c.name === 'scripted-cloud' && c.reason === 'script_review_required') && !existsSync(skillDir('scripted-cloud')))

// 7. Unsupported local layout is reported, not trimmed.
writeLocal('bad-layout', { 'SKILL.md': '# bad\n', 'README.md': '根目录多余文件' })
stats = await engine.syncOnce()
check('unsupported layout is flagged', stats.conflicts.some((c) => c.name === 'bad-layout' && c.reason === 'unsupported_layout'))
check('unsupported skill never reaches the center', !center.has('bad-layout'))

// 8. Local deletion never propagates to the center.
rmSync(skillDir('local-one'), { recursive: true, force: true })
stats = await engine.syncOnce()
check('local deletion keeps the cloud copy', center.has('local-one') && !requestLog.some((line) => line.startsWith('DELETE')))
const sidecar = JSON.parse(readFileSync(join(process.env.DSH_HOME, 'dsh-brain-skills.json'), 'utf8'))
check('sidecar forgets the deleted local skill', !('local-one' in (sidecar.uploaded ?? {})))

server.close()
const failed = results.filter((item) => !item.ok).length
console.log(failed === 0 ? `\nALL ${results.length} CHECKS PASSED` : `\n${failed} CHECK(S) FAILED`)
process.exit(failed === 0 ? 0 : 1)
