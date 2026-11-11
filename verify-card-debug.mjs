// Render-level smoke test for the hand-written client bundle.
//
// The client half has no bundler and no typecheck, so this harness supplies a
// minimal React-shaped runtime (createElement + useState/useEffect/useCallback +
// a class error boundary), a stubbed fetch, and renders the card once per tab
// with realistic payloads. It catches the failure modes a restart would
// otherwise surface as a blank panel: an undefined identifier, a broken hook
// order, a component that throws while rendering real data.
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(join(here, 'client', 'index.js'), 'utf8')

const results = []
function check(name, ok, detail) {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail === undefined ? '' : ` :: ${detail}`}`)
}

// ── a very small React ──────────────────────────────────────────────────
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
    return { type, props: props ?? {}, children: flat }
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

function render(node) {
  if (node === null || node === undefined || node === false || node === true) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(render).join('')
  const { type, props, children } = node
  if (typeof type === 'function') {
    if (type.prototype && typeof type.prototype.render === 'function') {
      const instance = new type(props)
      instance.props = props
      if (instance.state === undefined) instance.state = {}
      instance.setState = function setState(patch) {
        instance.state = { ...instance.state, ...patch }
        scheduled = true
      }
      try {
        return render(instance.render())
      } catch (failure) {
        if (typeof type.getDerivedStateFromError === 'function') {
          instance.state = { ...instance.state, ...type.getDerivedStateFromError(failure) }
          return render(instance.render())
        }
        throw failure
      }
    }
    const savedCursor = cursor
    const savedHooks = hooks
    const out = render(type({ ...props, children }))
    cursor = savedCursor
    hooks = savedHooks
    return out
  }
  return children.map(render).join('')
}

// ── payloads ────────────────────────────────────────────────────────────
const statusBody = {
  ok: true,
  settings: {
    enabled: true,
    baseUrl: 'https://your-memory-host/api/longmemory',
    baseUrlConfigured: false,
    baseUrlOrigin: 'https://your-memory-host',
    clientId: 'dsh-desktop',
    requestTimeoutMs: 5000,
    defaultK: 10,
    summaryEnabled: true,
    summaryMaxChars: 6000,
    skillsSyncEnabled: true,
    skillsDir: '',
  },
  tokens: {
    activity: { configured: false, masked: '' },
    memory: { configured: true, masked: 'cmt_abc…9f2c' },
    summary: { configured: false, masked: '' },
  },
  settingsPath: 'C:/Users/test/.dsh/dsh-brain.json',
  reporter: {
    attempted: 3,
    recorded: 2,
    duplicate: 0,
    failed: 1,
    skipped: 0,
    queued: 1,
    recent: [{ turnId: 'turn-1', outcome: 'recorded', status: 'completed', at: Date.now() }],
  },
  lastCheck: {
    at: Date.now(),
    checks: [
      { id: 'network', label: '服务地址', state: 'ok', message: '服务可达（HTTP 401）' },
      { id: 'activity', label: '活动上报权限（activity:write）', state: 'unconfigured', message: '未配置令牌' },
      { id: 'memory', label: '记忆读写权限（memory:write）', state: 'ok', message: '鉴权通过（2 个项目）' },
      { id: 'summary', label: '摘要权限（summary:write）', state: 'unconfigured', message: '未配置摘要令牌（可选）' },
    ],
  },
  capabilities: { version: '0.5.0', features: { skills: true, skillsMarketplace: false, mcpBridge: 'host-plugin' }, notes: [] },
  skills: { running: false, downloaded: [], uploaded: [], conflicts: [], skipped: 0 },
}

const skillsBody = {
  ok: true,
  skills: [
    {
      folder: 'gamma',
      name: 'gamma',
      description: '演示技能',
      enabled: true,
      origin: 'cloud',
      revision: 5,
      files: 2,
      bytes: 2048,
      installedAt: new Date().toISOString(),
      skillSha256: 'abcdef0123456789',
      location: 'root',
      ownerManager: 'dsh-brain',
      writable: true,
    },
    {
      folder: 'parked-one',
      name: 'parked-one',
      description: '',
      enabled: false,
      origin: 'local',
      files: 1,
      bytes: 32,
      installedAt: new Date().toISOString(),
      skillSha256: 'ffeedd00112233',
      location: 'holding',
      ownerManager: 'dsh-brain',
      writable: true,
    },
  ],
  root: 'C:/Users/test/.dsh/skills',
  holding: 'C:/Users/test/.dsh/skills-disabled',
  staging: 'C:/Users/test/.dsh/.dsh-brain-staging',
  plans: [],
}

const mcpBody = {
  ok: true,
  detail: {
    items: [
      {
        key: 'mcp-key-1',
        name: 'demo-mcp',
        connectorId: 'demo',
        transport: 'http',
        authMode: 'bearer',
        enabled: true,
        connectionState: 'connected',
        injectionLabel: '始终注入',
        scope: { visibility: 'global' },
        healthCheckedAt: Date.now(),
        lastError: null,
      },
    ],
  },
}

// ── host shims ──────────────────────────────────────────────────────────
let mcpAvailable = true
let activeTab = 'connection'

async function fakeFetch(url, init) {
  const path = String(url).split('?')[0]
  let body = { ok: false, error: 'not-found' }
  let status = 404
  if (path === '/dsh-brain/status') {
    body = statusBody
    status = 200
  } else if (path.startsWith('/dsh-brain/skills/api')) {
    body = skillsBody
    status = 200
  } else if (path === '/mcp-connector/api') {
    if (mcpAvailable) {
      body = mcpBody
      status = 200
    } else {
      body = { ok: false, message: 'no bridge' }
      status = 404
    }
  }
  void init
  return { status, json: async () => body, text: async () => JSON.stringify(body) }
}

const localStorageStub = {
  getItem: (key) => (String(key).endsWith(':tab') ? activeTab : null),
  setItem: () => {},
}

let registered = null
globalThis.window = {
  localStorage: localStorageStub,
  addEventListener: () => {},
  removeEventListener: () => {},
  __ModuleLoader__: {
    load(spec) {
      if (spec.id !== 'dsh-brain') throw new Error(`unexpected module id ${spec.id}`)
      const exportsObject = spec.factory(requireShim)
      const captured = []
      exportsObject.apply({
        slots: {
          inject(_seat, fn) {
            return fn()
          },
          register(_options, component) {
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

// Evaluate the bundle once; it self-registers through window.__ModuleLoader__.
function loadBundle() {
  registered = null
  const factory = new Function(
    'window',
    'require',
    'document',
    'localStorage',
    'fetch',
    'console',
    'setInterval',
    'clearInterval',
    'setTimeout',
    'clearTimeout',
    'AbortController',
    source,
  )
  factory(
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
    typeof AbortController === 'function' ? AbortController : undefined,
  )
  if (registered === null) throw new Error('the bundle did not register a card')
  return registered
}

async function drive(tab, bridgeAvailable) {
  activeTab = tab
  mcpAvailable = bridgeAvailable
  hooks = []
  cursor = 0
  const card = loadBundle()
  let text = ''
  for (let pass = 0; pass < 6; pass += 1) {
    cursor = 0
    pendingEffects = []
    scheduled = false
    text = render(React.createElement(card, null))
    const effects = pendingEffects
    pendingEffects = []
    for (const effect of effects) {
      const cleanup = effect()
      if (typeof cleanup === 'function') cleanup()
    }
    await new Promise((resolve) => setTimeout(resolve, 0))
    if (!scheduled) break
  }
  return text
}

// ── assertions ──────────────────────────────────────────────────────────
const dbgCard = loadBundle(); console.log("DBG", typeof dbgCard, dbgCard.length, dbgCard.toString().slice(0,80)); const el = React.createElement(dbgCard, null); console.log("DBG_EL", typeof el, JSON.stringify(Object.keys(el))); console.log("DBG_RENDER", JSON.stringify(render(el).slice(0,200)));
const connection = await drive('connection', true)
check('the connection tab renders its sections', ['连接与上报', '身份验证', '服务地址', '连接与权限检查', '最近上报'].every((label) => connection.includes(label)))
check('a placeholder address shows as unconfigured', connection.includes('未配置服务'))
check('check results are rendered per credential', connection.includes('活动上报权限') && connection.includes('记忆读写权限'))
check('the reporter row survives a real payload', connection.includes('turn-1'))
check('the search limit is renamed and reachable', connection.includes('单次搜索返回上限') || connection.includes('高级设置'))
check('no render boundary error on the connection tab', !connection.includes('渲染失败'))

const skillsText = await drive('skills', true)
check('the skills tab renders its sections', ['本机技能', '从 Git 仓库安装', '技能市场', '云端同步状态'].every((label) => skillsText.includes(label)))
check('real skill rows carry origin and size', skillsText.includes('gamma') && skillsText.includes('云端下发') && skillsText.includes('2.0 KB'))
check('a parked skill is rendered as disabled', skillsText.includes('已停用'))
check('the market gap is stated instead of simulated', skillsText.includes('能力缺口') || skillsText.includes('没有接入经验证的市场来源'))
check('no render boundary error on the skills tab', !skillsText.includes('渲染失败'))

const mcpText = await drive('mcp', true)
check('the MCP tab renders the host connection', mcpText.includes('我的连接') && mcpText.includes('demo-mcp'))
check('MCP state, transport and auth are shown', mcpText.includes('已连接') && mcpText.includes('http') && mcpText.includes('bearer'))
check('MCP actions are offered', mcpText.includes('健康检查') && mcpText.includes('工具列表') && mcpText.includes('移除连接'))
check('the injected tools cache starts empty', mcpText.includes('工具可见不等于业务可调用'))

const missing = await drive('mcp', false)
check('a missing bridge becomes a stated capability gap', missing.includes('MCP 管理当前不可用') && missing.includes('MCP 服务器配置'))
check('no render boundary error without the bridge', !missing.includes('渲染失败'))

const failed = results.filter((item) => !item.ok).length
console.log(failed === 0 ? `\nALL ${results.length} CHECKS PASSED` : `\n${failed} CHECK(S) FAILED`)
process.exit(failed === 0 ? 0 : 1)
