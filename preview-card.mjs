// Renders the real 技能管理 tab to a static PNG so the layout can be reviewed
// before DSH is restarted. It reads the *live* skill sources through the built
// plugin (read-only) and draws them with the bundle's own render tree, then
// screenshots the result with headless Chrome.
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(join(here, 'client', 'index.js'), 'utf8')

// ── real data ───────────────────────────────────────────────────────────
const { SkillAdmin, skillsHoldingDir } = await import('./lib/skill-admin.js')
const { SkillGroupManager, detectSources } = await import('./lib/skill-groups.js')
const { SettingsStore } = await import('./lib/store.js')

const store = new SettingsStore({})
const admin = new SkillAdmin({
  skillsRoot: () => join(store.path, '..', 'skills'),
  holdingDir: () => skillsHoldingDir(),
  syncStatePath: () => join(store.path, '..', 'dsh-brain-skills.json'),
  syncRunning: () => false,
  log: () => {},
})
const groups = new SkillGroupManager({ sources: () => detectSources(), admin, log: () => {} })
const overview = await groups.overview()

const statusBody = {
  ok: true,
  settings: {
    enabled: true,
    baseUrl: 'https://mem.qyhhh.top/api/longmemory',
    baseUrlConfigured: true,
    baseUrlOrigin: 'https://mem.qyhhh.top',
    clientId: 'dsh-desktop',
    requestTimeoutMs: 5000,
    defaultK: 10,
    summaryEnabled: true,
    summaryMaxChars: 6000,
    skillsSyncEnabled: true,
    skillsDir: '',
  },
  tokens: {
    activity: { configured: true, masked: 'cmt_9f2c1a…7d4e' },
    memory: { configured: true, masked: 'cmt_3b81cc…22a9' },
    summary: { configured: true, masked: 'cmt_71ad02…9f10' },
  },
  settingsPath: 'C:/Users/qyh15/.dsh/dsh-brain.json',
  reporter: { attempted: 12, recorded: 11, duplicate: 1, failed: 0, skipped: 0, queued: 0, recent: [] },
  lastCheck: {
    at: Date.now(),
    checks: [
      { id: 'network', label: '服务地址', state: 'ok', message: '服务可达（HTTP 200）' },
      { id: 'activity', label: '活动上报权限（activity:write）', state: 'ok', message: '鉴权通过' },
      { id: 'memory', label: '记忆读写权限（memory:write）', state: 'ok', message: '鉴权通过（3 个项目）' },
      { id: 'summary', label: '摘要权限（summary:write）', state: 'ok', message: '鉴权通过' },
    ],
  },
  capabilities: { version: '0.5.0', features: { skills: true, skillsMarketplace: false, mcpBridge: 'host-plugin' }, notes: [] },
  skills: { running: false, downloaded: [], uploaded: [], updated: [], conflicts: [], skipped: 0 },
}

// ── minimal React + HTML serializer ─────────────────────────────────────
let hooks = []
let cursor = 0
let pendingEffects = []
let scheduled = false

const React = {
  createElement(type, props, ...children) {
    const flat = []
    const push = (value) => {
      if (Array.isArray(value)) value.forEach(push)
      else if (value !== null && value !== undefined && value !== false && value !== true) flat.push(value)
    }
    push(children)
    return { type, props: { ...(props ?? {}), children: flat.length === 1 ? flat[0] : flat }, children: flat }
  },
  useState(initial) {
    const index = cursor++
    if (!(index in hooks)) hooks[index] = typeof initial === 'function' ? initial() : initial
    const setter = (next) => {
      const value = typeof next === 'function' ? next(hooks[index]) : next
      if (value !== hooks[index]) {
        hooks[index] = value
        scheduled = true
      }
    }
    return [hooks[index], setter]
  },
  useEffect(fn) {
    pendingEffects.push(fn)
  },
  useCallback(fn) {
    return fn
  },
  Component: function Component(props) {
    this.props = props
  },
}
React.Component.prototype.setState = function setState(patch) {
  this.state = { ...this.state, ...patch }
  scheduled = true
}

function walk(node, visit) {
  if (node === null || node === undefined || node === false || node === true) return
  if (typeof node === 'string' || typeof node === 'number') return
  if (Array.isArray(node)) {
    node.forEach((child) => walk(child, visit))
    return
  }
  if (typeof node.type === 'function') {
    if (node.type.prototype && typeof node.type.prototype.render === 'function') {
      const instance = new node.type(node.props)
      instance.props = node.props
      if (instance.state === undefined) instance.state = {}
      instance.setState = function setState(patch) {
        instance.state = { ...instance.state, ...patch }
        scheduled = true
      }
      walk(instance.render(), visit)
      return
    }
    walk(node.type({ ...node.props, children: node.children }), visit)
    return
  }
  visit(node)
  node.children.forEach((child) => walk(child, visit))
}

const UNITLESS = new Set(['fontWeight', 'opacity', 'lineHeight', 'flex', 'zIndex', 'flexGrow', 'flexShrink'])

function styleOf(style) {
  const parts = []
  for (const [key, value] of Object.entries(style ?? {})) {
    if (value === null || value === undefined) continue
    const name = key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)
    parts.push(`${name}:${typeof value === 'number' && !UNITLESS.has(key) ? `${value}px` : String(value)}`)
  }
  return parts.join(';')
}

function escapeHtml(text) {
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function toHtml(node) {
  if (node === null || node === undefined || node === false || node === true) return ''
  if (typeof node === 'string' || typeof node === 'number') return escapeHtml(node)
  if (Array.isArray(node)) return node.map(toHtml).join('')
  const { type, props, children } = node
  if (typeof type === 'function') {
    if (type.prototype && typeof type.prototype.render === 'function') {
      const instance = new type(props)
      instance.props = props
      if (instance.state === undefined) instance.state = {}
      return toHtml(instance.render())
    }
    return toHtml(type({ ...props, children }))
  }
  const attrs = []
  const style = styleOf(props.style)
  if (style !== '') attrs.push(`style="${style}"`)
  if (props.id !== undefined) attrs.push(`id="${escapeHtml(props.id)}"`)
  if (props.role !== undefined) attrs.push(`role="${escapeHtml(props.role)}"`)
  if (props.title !== undefined) attrs.push(`title="${escapeHtml(props.title)}"`)
  if (props.disabled === true) attrs.push('disabled')
  if (props.type === 'checkbox') attrs.push(props.checked === true ? 'checked' : '')
  for (const [key, value] of Object.entries(props)) {
    if (key.startsWith('aria-')) attrs.push(`${key}="${escapeHtml(value)}"`)
  }
  if (type === 'input') {
    attrs.push(`value="${escapeHtml(props.value === undefined ? '' : props.value)}"`)
    attrs.push(`placeholder="${escapeHtml(props.placeholder === undefined ? '' : props.placeholder)}"`)
    attrs.push(`type="${escapeHtml(props.type === undefined ? 'text' : props.type)}"`)
    return `<input ${attrs.filter(Boolean).join(' ')}>`
  }
  return `<${type} ${attrs.filter(Boolean).join(' ')}>${children.map(toHtml).join('')}</${type}>`
}

// ── drive the real bundle ───────────────────────────────────────────────
const localStorageStub = {
  getItem: (key) => (String(key).endsWith(':tab') ? 'skills' : null),
  setItem: () => {},
}
let registered = null
globalThis.window = {
  localStorage: localStorageStub,
  addEventListener: () => {},
  removeEventListener: () => {},
  __ModuleLoader__: {
    load(spec) {
      const exportsObject = spec.factory(requireShim)
      const captured = []
      exportsObject.apply({
        slots: {
          inject: (_seat, fn) => fn(),
          register: (_options, component) => {
            captured.push(component)
            return () => {}
          },
        },
      })
      registered = captured[0]
    },
  },
}
function requireShim(id) {
  if (id === 'react') return React
  throw new Error(`unexpected require: ${id}`)
}

async function fakeFetch(url) {
  const path = String(url).split('?')[0]
  let body = { ok: false }
  if (path === '/dsh-brain/status') body = statusBody
  else if (path === '/dsh-brain/skills/sources') body = { ok: true, ...overview }
  else if (path.startsWith('/dsh-brain/skills/api')) body = { ok: true, skills: overview.sources[0]?.groups.flatMap((group) => group.skills) ?? [], plans: [] }
  return { status: body.ok === false ? 404 : 200, json: async () => body, text: async () => JSON.stringify(body) }
}

function loadCard() {
  registered = null
  new Function('window', 'require', 'document', 'localStorage', 'fetch', 'console', 'setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'AbortController', source)(
    globalThis.window,
    requireShim,
    { visibilityState: 'visible' },
    localStorageStub,
    fakeFetch,
    { warn: () => {}, log: () => {} },
    () => 0,
    () => {},
    () => 0,
    () => {},
    AbortController,
  )
  return registered
}

const card = loadCard()
let treeEl = null
for (let pass = 0; pass < 6; pass += 1) {
  cursor = 0
  pendingEffects = []
  scheduled = false
  treeEl = React.createElement(card, null)
  // Rendering is what runs the hooks (and therefore queues the effects).
  void toHtml(treeEl)
  const effects = pendingEffects
  pendingEffects = []
  for (const effect of effects) {
    const cleanup = effect()
    if (typeof cleanup === 'function') cleanup()
  }
  await new Promise((resolve) => setTimeout(resolve, 0))
  if (!scheduled) break
}

// Click one control by its aria-label, so the preview can show an expanded
// category without a real browser event.
function clickLabel(root, prefix, occurrence) {
  let index = 0
  let clicked = false
  walk(root, (node) => {
    if (clicked) return
    const props = node.props ?? {}
    const label = props['aria-label']
    if (typeof label === 'string' && label.startsWith(prefix)) {
      if (index === occurrence) {
        if (typeof props.onClick === 'function') props.onClick()
        clicked = true
      }
      index += 1
    }
  })
  return clicked
}

cursor = 0
pendingEffects = []
const expanded = clickLabel(treeEl, '展开或收起 未分类', 0)
if (expanded) {
  for (let pass = 0; pass < 3; pass += 1) {
    cursor = 0
    pendingEffects = []
    scheduled = false
    void toHtml(treeEl)
    const effects = pendingEffects
    pendingEffects = []
    for (const effect of effects) effect()
    await new Promise((resolve) => setTimeout(resolve, 0))
    if (!scheduled) break
  }
} else {
  console.warn('preview: could not find the 未分类 category to expand')
}

// The final render must start from the first hook slot again, otherwise the
// component would read fresh initial values instead of the loaded state.
cursor = 0
pendingEffects = []
const body = toHtml(treeEl)

// Second pass with every category collapsed: that is the default view a user
// sees first, and it puts the sections below the tree into the screenshot.
hooks = []
cursor = 0
const compactCard = loadCard()
let compactEl = null
for (let pass = 0; pass < 6; pass += 1) {
  cursor = 0
  pendingEffects = []
  scheduled = false
  compactEl = React.createElement(compactCard, null)
  void toHtml(compactEl)
  const effects = pendingEffects
  pendingEffects = []
  for (const effect of effects) {
    const cleanup = effect()
    if (typeof cleanup === 'function') cleanup()
  }
  await new Promise((resolve) => setTimeout(resolve, 0))
  if (!scheduled) break
}
cursor = 0
pendingEffects = []
const compactBody = toHtml(compactEl)
if (body.includes('渲染失败')) {
  console.error('the card rendered its error boundary instead of the tree')
  process.exit(1)
}

const page = (theme) => `<!doctype html><html><head><meta charset="utf-8">
<style>
  html,body{margin:0;padding:0}
  body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",system-ui,sans-serif;
       background:${theme === 'dark' ? '#101216' : '#f3f5f9'};color:${theme === 'dark' ? '#e8eaee' : '#1a1d21'}}
  .frame{width:600px;margin:0 auto;padding:18px 20px 24px}
  .panel{border-radius:14px;padding:16px;
         background:${theme === 'dark' ? '#191c22' : '#ffffff'};
         box-shadow:0 10px 30px rgba(0,0,0,${theme === 'dark' ? '0.45' : '0.10'})}
  button{font-family:inherit}
  input{font-family:inherit;color:inherit}
</style></head><body><div class="frame"><div class="panel">${body}</div></div></body></html>`

const outDir = join(here, '_preview')
mkdirSync(outDir, { recursive: true })
const htmlPath = join(outDir, 'skill-tree.html')
writeFileSync(htmlPath, page('light'), 'utf8')
const darkPath = join(outDir, 'skill-tree-dark.html')
writeFileSync(darkPath, page('dark'), 'utf8')
const compactPath = join(outDir, 'skill-tree-compact.html')
writeFileSync(compactPath, page('light').replace(body, compactBody), 'utf8')

const chrome = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
for (const [input, output] of [
  [htmlPath, join(outDir, 'skill-tree.png')],
  [darkPath, join(outDir, 'skill-tree-dark.png')],
  [compactPath, join(outDir, 'skill-tree-compact.png')],
]) {
  execFileSync(chrome, [
    '--headless=new',
    '--disable-gpu',
    '--hide-scrollbars',
    '--force-device-scale-factor=2',
    '--window-size=640,2000',
    `--screenshot=${output}`,
    `file:///${input.replace(/\\/g, '/')}`,
  ], { stdio: 'ignore' })
  console.log(`wrote ${output}`)
}
console.log('sources:', overview.sources.map((item) => `${item.label}=${item.total}`).join(', '))
