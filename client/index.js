// dsh-brain client bundle.
//
// Hand-written on purpose: the host loads this file through `require` shims it
// provides itself (react / react/jsx-runtime), so no bundler is involved. The
// module wrapper below is the contract the web loader expects — `id` has to
// match the package name, otherwise the module graph registers a second copy.
//
// Three tabs: 连接与上报 / 技能管理 / MCP 管理. Nothing here invents data: every
// number and state comes from the plugin's own routes or, for MCP, from the
// host `dsh-mcp-connector` plugin's public bridge on the same origin.
window.__ModuleLoader__.load({
  id: 'dsh-brain',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports

    'use strict'

    var React = require('react')
    var h = React.createElement

    var API = {
      status: '/dsh-brain/status',
      capabilities: '/dsh-brain/capabilities',
      config: '/dsh-brain/config',
      login: '/dsh-brain/login',
      test: '/dsh-brain/test',
      flush: '/dsh-brain/flush',
      skills: '/dsh-brain/skills',
      market: '/dsh-brain/market',
      sync: '/dsh-brain/sync',
      clients: '/dsh-brain/clients',
      migrate: '/dsh-brain/migrate',
    }

    // The MCP bridge is another plugin's public surface, not ours: it is probed
    // at runtime and the tab reports a capability gap when it is missing.
    var MCP_BRIDGE = '/mcp-connector/api'
    var MCP_PANEL = '/mcp-connector/ui'
    var POLL_MS = 10000
    var PROBE_TIMEOUT_MS = 5000

    var inject = ['slots']

    function request(url, init) {
      var options = init || {}
      options.cache = 'no-store'
      options.headers = options.body === undefined
        ? { accept: 'application/json' }
        : { accept: 'application/json', 'content-type': 'application/json' }
      return fetch(url, options).then(function (response) {
        return response.json().then(
          function (body) {
            return { status: response.status, body: body }
          },
          function () {
            return { status: response.status, body: null }
          },
        )
      })
    }

    function postJson(url, payload) {
      return request(url, { method: 'POST', body: JSON.stringify(payload === undefined ? {} : payload) })
    }

    function messageOf(error) {
      if (error === null || error === undefined) return '未知错误'
      if (typeof error === 'string') return error
      return typeof error.message === 'string' ? error.message : String(error)
    }

    // One POST to the host MCP bridge. Used by the self-contained MCP panels
    // below; the dispatcher whitelist lives in dsh-mcp-connector.
    function bridgeCall(method, params) {
      var controller = typeof AbortController === 'function' ? new AbortController() : null
      var timer = controller === null ? null : setTimeout(function () { controller.abort() }, 20000)
      return fetch(MCP_BRIDGE, {
        method: 'POST',
        cache: 'no-store',
        headers: { accept: 'application/json', 'content-type': 'application/json' },
        body: JSON.stringify({ method: method, params: params === undefined ? {} : params }),
        signal: controller === null ? undefined : controller.signal,
      }).then(function (response) {
        if (timer !== null) clearTimeout(timer)
        return response.json().then(
          function (body) { return { status: response.status, body: body } },
          function () { return { status: response.status, body: null } },
        )
      }, function (failure) {
        if (timer !== null) clearTimeout(timer)
        return { status: 0, body: null, error: messageOf(failure) }
      })
    }

    function bridgeMessage(result) {
      if (result.body !== null && typeof result.body.message === 'string' && result.body.message !== '') return result.body.message
      return 'HTTP ' + String(result.status) + (result.error === undefined ? '' : '：' + result.error)
    }

    // A 404/405 here means the host half on disk is newer than the one this
    // window is talking to: the module is loaded into the running process and
    // does not hot-reload, so the answer is a restart, not a retry.
    function statusText(status) {
      if (status === 404 || status === 405) {
        return '插件后端还没加载这个接口（HTTP ' + String(status) + '）：请完全退出并重启 DSH 后再试。'
      }
      return 'HTTP ' + String(status)
    }

    function bodyError(result, fallback) {
      if (result.body !== null && result.body !== undefined && typeof result.body.error === 'string' && result.body.error !== '') {
        return result.body.error
      }
      return fallback === undefined ? statusText(result.status) : fallback
    }

    function pickSettings(settings) {
      var source = settings === undefined || settings === null ? {} : settings
      return {
        enabled: source.enabled === true,
        baseUrl: String(source.baseUrl === undefined ? '' : source.baseUrl),
        baseUrlConfigured: source.baseUrlConfigured !== false,
        baseUrlOrigin: String(source.baseUrlOrigin === undefined ? '' : source.baseUrlOrigin),
        clientId: String(source.clientId === undefined ? '' : source.clientId),
        requestTimeoutMs: String(source.requestTimeoutMs === undefined ? 8000 : source.requestTimeoutMs),
        defaultK: String(source.defaultK === undefined ? 10 : source.defaultK),
        summaryEnabled: source.summaryEnabled === true,
        skillsSyncEnabled: source.skillsSyncEnabled === true,
      }
    }

    function emptyTokens() {
      return { activity: '', memory: '', summary: '' }
    }

    function formatTime(value) {
      if (typeof value !== 'number' || value <= 0) return '—'
      var date = new Date(value)
      var pad = function (n) {
        return n < 10 ? '0' + String(n) : String(n)
      }
      return pad(date.getMonth() + 1) + '-' + pad(date.getDate()) + ' ' + pad(date.getHours()) + ':' + pad(date.getMinutes()) + ':' + pad(date.getSeconds())
    }

    function formatIso(value) {
      if (typeof value !== 'string' || value === '') return '—'
      var stamp = Date.parse(value)
      if (!Number.isFinite(stamp)) return value
      return formatTime(stamp)
    }

    function formatBytes(value) {
      if (typeof value !== 'number' || value < 0) return '—'
      if (value < 1024) return String(value) + ' B'
      if (value < 1024 * 1024) return (value / 1024).toFixed(1) + ' KB'
      return (value / (1024 * 1024)).toFixed(2) + ' MB'
    }

    function shortHash(value) {
      if (typeof value !== 'string' || value === '') return '—'
      return value.slice(0, 12)
    }

    function readStored(key, fallback) {
      try {
        var raw = window.localStorage.getItem('dsh-brain:' + key)
        if (raw === null || raw === '') raw = window.localStorage.getItem('dsh-cloud-memory:' + key)
        return raw === null || raw === '' ? fallback : raw
      } catch {
        return fallback
      }
    }

    function store(key, value) {
      try {
        window.localStorage.setItem('dsh-brain:' + key, String(value))
      } catch {
        /* a locked-down window keeps the value in memory only */
      }
    }

    var OUTCOME_LABELS = {
      recorded: '已上报',
      duplicate: '重复忽略',
      failed: '失败',
      queued: '待重试',
      skipped: '已跳过',
    }

    var OUTCOME_TONES = {
      recorded: 'ok',
      duplicate: 'muted',
      failed: 'bad',
      queued: 'warn',
      skipped: 'muted',
    }

    var ORIGIN_LABELS = {
      cloud: '云端下发',
      uploaded: '本地已上传',
      local: '本机安装',
      unknown: '来源未知',
    }

    var CHECK_TONES = {
      ok: 'ok',
      unconfigured: 'muted',
      invalid: 'bad',
      forbidden: 'bad',
      unreachable: 'bad',
      error: 'bad',
    }

    var CHECK_LABELS = {
      ok: '可用',
      unconfigured: '未配置',
      invalid: '令牌失效',
      forbidden: '权限不足',
      unreachable: '不可达',
      error: '出错',
    }

    var MCP_STATE_LABELS = {
      connected: '已连接',
      connecting: '连接中',
      disabled: '已停用',
      error: '异常',
      expired: '授权过期',
      unknown: '未知',
      needs_auth: '待授权',
    }

    var styles = {
      root: {
        display: 'flex',
        flexDirection: 'column',
        gap: '18px',
        padding: '4px 2px 20px',
        fontSize: '13px',
        lineHeight: 1.55,
        minWidth: 0,
      },
      tabs: {
        display: 'flex',
        gap: '4px',
        padding: '3px',
        borderRadius: '13px',
        border: '1px solid rgba(127,127,127,0.22)',
        background: 'rgba(127,127,127,0.06)',
        flexWrap: 'wrap',
      },
      tab: {
        flex: '1 1 auto',
        minWidth: '88px',
        font: 'inherit',
        fontSize: '12.5px',
        padding: '7px 12px',
        borderRadius: '10px',
        border: '1px solid transparent',
        background: 'transparent',
        color: 'inherit',
        cursor: 'pointer',
        whiteSpace: 'nowrap',
      },
      tabActive: {
        border: '1px solid rgba(127,127,127,0.30)',
        background: 'rgba(127,127,127,0.14)',
        boxShadow: '0 1px 3px rgba(0,0,0,0.10)',
        fontWeight: 600,
      },
      section: {
        display: 'flex',
        flexDirection: 'column',
        gap: '12px',
        border: '1px solid rgba(127,127,127,0.22)',
        borderRadius: '16px',
        padding: '18px 20px',
        minWidth: 0,
      },
      sectionHead: {
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: '10px',
        flexWrap: 'wrap',
      },
      sectionTitle: {
        margin: 0,
        fontSize: '13.5px',
        fontWeight: 650,
        letterSpacing: '0.02em',
      },
      hint: {
        margin: 0,
        fontSize: '11.5px',
        opacity: 0.58,
      },
      grid: {
        display: 'flex',
        flexWrap: 'wrap',
        gap: '12px 18px',
      },
      field: {
        display: 'flex',
        flexDirection: 'column',
        gap: '4px',
        flex: '1 1 220px',
        minWidth: 0,
      },
      label: {
        fontSize: '12px',
        opacity: 0.75,
      },
      input: {
        font: 'inherit',
        fontSize: '13px',
        padding: '8px 11px',
        borderRadius: '10px',
        border: '1px solid rgba(127,127,127,0.35)',
        background: 'rgba(127,127,127,0.05)',
        color: 'inherit',
        minWidth: 0,
        width: '100%',
        boxSizing: 'border-box',
      },
      checkboxRow: {
        display: 'flex',
        alignItems: 'flex-start',
        gap: '8px',
      },
      actions: {
        display: 'flex',
        gap: '10px',
        flexWrap: 'wrap',
        alignItems: 'center',
      },
      button: {
        font: 'inherit',
        fontSize: '13px',
        padding: '7px 16px',
        borderRadius: '10px',
        border: '1px solid rgba(127,127,127,0.4)',
        background: 'transparent',
        color: 'inherit',
        cursor: 'pointer',
      },
      buttonPrimary: {
        font: 'inherit',
        fontSize: '13px',
        padding: '7px 18px',
        borderRadius: '10px',
        border: '1px solid transparent',
        background: '#3f3f46',
        boxShadow: '0 2px 6px -2px rgba(0,0,0,0.35)',
        color: '#ffffff',
        cursor: 'pointer',
        fontWeight: 600,
      },
      buttonDanger: {
        font: 'inherit',
        fontSize: '13px',
        padding: '7px 16px',
        borderRadius: '10px',
        border: '1px solid rgba(220,38,38,0.5)',
        background: 'rgba(220,38,38,0.14)',
        color: 'inherit',
        cursor: 'pointer',
      },
      buttonSmall: {
        font: 'inherit',
        fontSize: '12px',
        padding: '3px 8px',
        borderRadius: '8px',
        border: '1px solid transparent',
        background: 'transparent',
        opacity: 0.85,
        color: 'inherit',
        cursor: 'pointer',
      },
      pills: {
        display: 'flex',
        flexWrap: 'wrap',
        gap: '8px',
      },
      pill: {
        display: 'inline-flex',
        alignItems: 'center',
        gap: '6px',
        padding: '3px 10px',
        borderRadius: '999px',
        border: '1px solid rgba(127,127,127,0.35)',
        fontSize: '12px',
        maxWidth: '100%',
      },
      table: {
        width: '100%',
        borderCollapse: 'collapse',
        fontSize: '12px',
        tableLayout: 'fixed',
      },
      th: {
        textAlign: 'left',
        fontWeight: 600,
        padding: '4px 8px 4px 0',
        borderBottom: '1px solid rgba(127,127,127,0.28)',
        whiteSpace: 'nowrap',
      },
      td: {
        padding: '4px 8px 4px 0',
        borderBottom: '1px solid rgba(127,127,127,0.14)',
        verticalAlign: 'top',
        overflowWrap: 'anywhere',
      },
      mono: {
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
        fontSize: '11px',
        opacity: 0.72,
        wordBreak: 'break-all',
      },
      ok: { borderColor: 'rgba(22,163,74,0.55)', background: 'rgba(22,163,74,0.12)' },
      bad: { borderColor: 'rgba(220,38,38,0.55)', background: 'rgba(220,38,38,0.12)' },
      warn: { borderColor: 'rgba(217,119,6,0.55)', background: 'rgba(217,119,6,0.12)' },
      muted: {},
      iconBtn: {
        width: '28px',
        height: '28px',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontSize: '13px',
        lineHeight: 1,
        padding: 0,
        borderRadius: '8px',
        border: '1px solid rgba(127,127,127,0.25)',
        background: 'rgba(127,127,127,0.05)',
        color: 'inherit',
        cursor: 'pointer',
        flex: '0 0 auto',
      },
      iconBtnDanger: {
        border: '1px solid rgba(220,38,38,0.40)',
        background: 'rgba(220,38,38,0.08)',
      },
      statsBar: {
        display: 'flex',
        alignItems: 'center',
        flexWrap: 'wrap',
      },
      stat: {
        display: 'inline-flex',
        alignItems: 'baseline',
        gap: '6px',
        paddingRight: '18px',
        marginRight: '18px',
        borderRight: '1px solid rgba(127,127,127,0.20)',
      },
      statLast: {
        display: 'inline-flex',
        alignItems: 'baseline',
        gap: '6px',
      },
      statNum: {
        fontSize: '17px',
        fontWeight: 700,
      },
      banner: {
        padding: '10px 13px',
        borderRadius: '11px',
        border: '1px solid transparent',
        fontSize: '12.5px',
      },
      row: {
        display: 'flex',
        flexDirection: 'column',
        gap: '6px',
        border: '1px solid rgba(127,127,127,0.15)',
        borderRadius: '11px',
        padding: '10px 12px',
        minWidth: 0,
      },
      rowHead: {
        display: 'flex',
        alignItems: 'baseline',
        justifyContent: 'space-between',
        gap: '8px',
        flexWrap: 'wrap',
      },
      rowTitle: {
        fontWeight: 600,
        overflowWrap: 'anywhere',
      },
      code: {
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
        fontSize: '11.5px',
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
        maxHeight: '260px',
        overflow: 'auto',
        margin: 0,
        padding: '10px',
        borderRadius: '8px',
        background: 'rgba(127,127,127,0.1)',
      },
      chips: {
        display: 'flex',
        gap: '6px',
        flexWrap: 'wrap',
      },
      chip: {
        font: 'inherit',
        fontSize: '12px',
        padding: '2px 10px',
        borderRadius: '999px',
        border: '1px solid rgba(127,127,127,0.35)',
        background: 'transparent',
        color: 'inherit',
        cursor: 'pointer',
      },
      chipActive: {
        border: '1px solid rgba(99,102,241,0.6)',
        background: 'rgba(99,102,241,0.16)',
      },
      nested: {
        display: 'flex',
        flexDirection: 'column',
        gap: '6px',
        paddingLeft: '10px',
        borderLeft: '2px solid rgba(127,127,127,0.18)',
        minWidth: 0,
      },
      sourceCard: {
        display: 'flex',
        flexDirection: 'column',
        gap: '6px',
        border: '1px solid rgba(127,127,127,0.17)',
        borderRadius: '14px',
        padding: '12px 14px',
        minWidth: 0,
      },
      groupRow: {
        display: 'flex',
        flexDirection: 'column',
        gap: '6px',
        border: '1px solid transparent',
        borderRadius: '11px',
        padding: '7px 9px',
        background: 'transparent',
        minWidth: 0,
      },
      skillRow: {
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: '8px',
        padding: '5px 8px',
        borderRadius: '8px',
        border: '1px solid transparent',
        minWidth: 0,
        flexWrap: 'nowrap',
      },
      clamp1: {
        display: '-webkit-box',
        WebkitLineClamp: '1',
        WebkitBoxOrient: 'vertical',
        overflow: 'hidden',
      },
      clamp2: {
        display: '-webkit-box',
        WebkitLineClamp: '2',
        WebkitBoxOrient: 'vertical',
        overflow: 'hidden',
      },
      sourceGlyph: {
        width: '20px',
        height: '20px',
        borderRadius: '6px',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontSize: '11px',
        fontWeight: 700,
        border: '1px solid rgba(127,127,127,0.22)',
        background: 'rgba(127,127,127,0.10)',
        flex: '0 0 auto',
      },
      folderGlyph: {
        fontSize: '12px',
        opacity: 0.85,
        flex: '0 0 auto',
      },
      sourceTitle: {
        fontWeight: 600,
        fontSize: '13px',
        overflowWrap: 'anywhere',
      },
    }

    function Pill(props) {
      var tone = styles[props.tone] === undefined ? styles.muted : styles[props.tone]
      return h(
        'span',
        { style: Object.assign({}, styles.pill, tone) },
        h('span', { style: { opacity: 0.75 } }, props.label),
        h('span', { style: { fontWeight: 600 } }, String(props.value)),
      )
    }

    function Banner(props) {
      var tone = styles[props.tone] === undefined ? styles.muted : styles[props.tone]
      return h('div', { style: Object.assign({}, styles.banner, tone), role: props.role }, props.children)
    }

    function Field(props) {
      return h(
        'label',
        { style: styles.field },
        h('span', { style: styles.label }, props.label),
        h('input', {
          style: styles.input,
          type: props.type === undefined ? 'text' : props.type,
          value: props.value,
          placeholder: props.placeholder === undefined ? '' : props.placeholder,
          spellCheck: false,
          autoComplete: 'off',
          disabled: props.disabled === true,
          onChange: function (event) {
            props.onChange(event.target.value)
          },
        }),
        props.hint === undefined ? null : h('span', { style: styles.hint }, props.hint),
      )
    }

    function Btn(props) {
      var base = props.variant === 'primary' ? styles.buttonPrimary : props.variant === 'danger' ? styles.buttonDanger : props.variant === 'small' ? styles.buttonSmall : styles.button
      var style = props.disabled === true ? Object.assign({}, base, { opacity: 0.45, cursor: 'not-allowed' }) : base
      return h(
        'button',
        {
          type: 'button',
          style: style,
          disabled: props.disabled === true,
          onClick: props.onClick,
          'aria-label': props.ariaLabel,
        },
        props.label,
      )
    }

    function IconBtn(props) {
      var style = Object.assign({}, styles.iconBtn, props.danger === true ? styles.iconBtnDanger : null, props.disabled === true ? { opacity: 0.45, cursor: 'not-allowed' } : null)
      return h(
        'button',
        {
          type: 'button',
          style: style,
          disabled: props.disabled === true,
          onClick: props.disabled === true ? undefined : props.onClick,
          'aria-label': props.ariaLabel,
          title: props.ariaLabel,
        },
        props.glyph,
      )
    }

    function Switch(props) {      return h(
        'div',
        { style: styles.tabs, role: 'tablist', 'aria-label': props.ariaLabel },
        props.options.map(function (option) {
          var active = option.value === props.value
          return h(
            'button',
            {
              key: option.value,
              type: 'button',
              role: 'tab',
              'aria-selected': active,
              style: Object.assign({}, styles.tab, active ? styles.tabActive : null),
              onClick: function () {
                props.onChange(option.value)
              },
            },
            option.label,
          )
        }),
      )
    }

    // A real switch, not a checkbox: the tree rows are dense and the state has
    // to be readable at a glance in both themes.
    function Toggle(props) {
      var on = props.checked === true
      var disabled = props.disabled === true
      return h(
        'button',
        {
          type: 'button',
          role: 'switch',
          'aria-checked': on,
          'aria-label': props.label,
          title: props.label,
          disabled: disabled,
          style: {
            width: '38px',
            height: '22px',
            flex: '0 0 auto',
            padding: '2px',
            borderRadius: '999px',
            border: '1px solid ' + (on ? 'rgba(0,0,0,0.25)' : 'rgba(127,127,127,0.45)'),
            background: on ? '#3f3f46' : 'rgba(127,127,127,0.28)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: on ? 'flex-end' : 'flex-start',
            cursor: disabled ? 'not-allowed' : 'pointer',
            opacity: disabled ? 0.45 : 1,
            transition: 'background 120ms ease',
          },
          onClick: disabled ? undefined : props.onChange,
        },
        h('span', {
          style: {
            width: '16px',
            height: '16px',
            borderRadius: '999px',
            background: 'rgba(255,255,255,0.96)',
            boxShadow: '0 1px 2px rgba(0,0,0,0.25)',
            flex: '0 0 auto',
          },
        }),
      )
    }

    function Section(props) {
      return h(
        'div',
        { style: styles.section },
        h(
          'div',
          { style: styles.sectionHead },
          h('h4', { style: styles.sectionTitle }, props.title),
          props.aside === undefined ? null : h('div', { style: styles.actions }, props.aside),
        ),
        props.hint === undefined ? null : h('p', { style: styles.hint }, props.hint),
        props.children,
      )
    }

    function findCheck(source, id) {
      if (source === null || source === undefined || !Array.isArray(source.checks)) return undefined
      for (var index = 0; index < source.checks.length; index += 1) {
        if (source.checks[index] !== null && typeof source.checks[index] === 'object' && source.checks[index].id === id) {
          return source.checks[index]
        }
      }
      return undefined
    }

    // ---- P3: skill market -------------------------------------------------
    function MarketSection(props) {
      var capabilities = props.capabilities || {}
      var tuple = React.useState({
        providers: null, provider: '', query: '', entries: [], nextCursor: null, cursor: 0,
        status: 'idle', error: null, detail: null, plan: null, selected: {}, busy: '', notice: null,
      })
      var state = tuple[0]
      var setState = tuple[1]
      function patch(next) { setState(function (prev) { return Object.assign({}, prev, next) }) }
      var available = capabilities.features !== undefined && capabilities.features.skillsMarketplace === true

      React.useEffect(function () {
        if (available) loadProviders()
      }, [])

      function loadProviders() {
        request(API.market + '/providers', { method: 'GET' }).then(function (res) {
          if (res.body !== null && res.body !== undefined && res.body.ok === true) {
            var list = Array.isArray(res.body.providers) ? res.body.providers : []
            patch({ providers: list, provider: state.provider !== '' ? state.provider : (list.length > 0 ? list[0].id : '') })
          } else {
            patch({ error: bodyError(res, '读取市场来源失败') })
          }
        }, function (error) { patch({ error: messageOf(error) }) })
      }
      function search(append) {
        if (state.provider === '') return
        var cursor = append === true ? state.cursor : 0
        patch({ busy: 'search', error: null, status: 'loading' })
        var url = API.market + '/search?provider=' + encodeURIComponent(state.provider) + '&q=' + encodeURIComponent(state.query) + '&cursor=' + String(cursor)
        request(url, { method: 'GET' }).then(function (res) {
          if (res.body !== null && res.body !== undefined && res.body.ok === true) {
            var entries = append === true ? state.entries.concat(res.body.entries || []) : (res.body.entries || [])
            patch({ entries: entries, nextCursor: res.body.nextCursor === undefined ? null : res.body.nextCursor, cursor: res.body.nextCursor === undefined ? cursor : res.body.nextCursor, status: 'ready', busy: '', detail: null, plan: null })
          } else {
            patch({ status: 'error', busy: '', error: bodyError(res, '市场搜索失败') })
          }
        }, function (error) { patch({ status: 'error', busy: '', error: messageOf(error) }) })
      }
      function openDetail(entry) {
        patch({ busy: 'detail', detail: null, plan: null, notice: null })
        postJson(API.market + '/detail', { provider: state.provider, id: entry.id }).then(function (res) {
          if (res.body !== null && res.body !== undefined && res.body.ok === true) patch({ detail: res.body, busy: '' })
          else patch({ busy: '', error: bodyError(res, '读取条目详情失败') })
        }, function (error) { patch({ busy: '', error: messageOf(error) }) })
      }
      function makePlan() {
        if (state.detail === null) return
        patch({ busy: 'plan', plan: null, notice: null })
        postJson(API.market + '/plan', { provider: state.provider, id: state.detail.id }).then(function (res) {
          if (res.body !== null && res.body !== undefined && res.body.ok === true) {
            var selected = {}
            ;(res.body.candidates || []).forEach(function (candidate) {
              if (candidate.conflict !== true && candidate.problem === undefined) selected[candidate.folder] = true
            })
            patch({ plan: res.body, selected: selected, busy: '' })
          } else patch({ busy: '', error: bodyError(res, '无法生成安装计划') })
        }, function (error) { patch({ busy: '', error: messageOf(error) }) })
      }
      function toggleFolder(folder) {
        var next = Object.assign({}, state.selected)
        next[folder] = next[folder] !== true
        patch({ selected: next })
      }
      function commitPlan() {
        if (state.plan === null) return
        var folders = Object.keys(state.selected).filter(function (folder) { return state.selected[folder] === true })
        if (folders.length === 0) { patch({ notice: { tone: 'warn', text: '请至少选中一个技能。' } }); return }
        patch({ busy: 'commit' })
        postJson(API.market + '/commit', { planId: state.plan.planId, folders: folders }).then(function (res) {
          if (res.body !== null && res.body !== undefined && res.body.ok === true) {
            var skipped = Array.isArray(res.body.skipped) ? res.body.skipped.length : 0
            patch({ busy: '', plan: null, detail: null, notice: { tone: 'ok', text: '已安装：' + ((res.body.installed || []).join('、') || '无') + (skipped > 0 ? '；跳过 ' + skipped + ' 项' : '') } })
            if (typeof props.onInstalled === 'function') props.onInstalled()
          } else patch({ busy: '', notice: { tone: 'bad', text: bodyError(res, '安装失败') } })
        }, function (error) { patch({ busy: '', notice: { tone: 'bad', text: messageOf(error) } }) })
      }

      if (!available) {
        return h(Section, { title: '技能市场', hint: '本版没有配置经验证的市场来源。' },
          h('p', { style: styles.hint }, '能力缺口：capabilities.features.skillsMarketplace = false，因此不显示任何搜索框或示例条目。'))
      }
      var providerLabel = state.provider
      if (state.providers !== null) {
        state.providers.forEach(function (provider) { if (provider.id === state.provider) providerLabel = provider.label })
      }
      var resultRows = state.entries.map(function (entry) {
        return h('div', { key: entry.id, style: styles.row },
          h('div', { style: styles.rowHead },
            h('span', { style: styles.rowTitle }, entry.name),
            h('div', { style: styles.pills },
              entry.version === undefined ? null : h(Pill, { label: '版本', value: String(entry.version), tone: 'muted' }),
              h(Pill, { label: '技能', value: (entry.skills || []).length, tone: 'muted' }),
              entry.author === undefined ? null : h(Pill, { label: '作者', value: String(entry.author), tone: 'muted' }),
            ),
          ),
          h('p', { style: styles.hint }, entry.description === '' ? '（无描述）' : entry.description),
          h('div', { style: styles.actions }, h(Btn, { label: '查看详情', variant: 'small', disabled: state.busy !== '', onClick: function () { openDetail(entry) } })),
        )
      })
      var detailBox = null
      if (state.detail !== null) {
        var details = Array.isArray(state.detail.skillDetails) ? state.detail.skillDetails : []
        detailBox = h('div', { style: styles.nested },
          h('p', { style: styles.hint }, '来源：' + String(state.detail.sourceRepo) + ' · ' + (state.detail.description || '')),
          h('div', { style: { display: 'flex', flexDirection: 'column', gap: '4px' } },
            details.map(function (skill) {
              return h('div', { key: skill.folder, style: styles.rowHead },
                h('span', { style: styles.rowTitle }, skill.name === undefined ? skill.folder : skill.name),
                h('span', { style: styles.hint }, skill.ok === false ? '（无法读取 SKILL.md）' : String(skill.description || '')),
              )
            }),
          ),
          h('div', { style: styles.actions }, h(Btn, { variant: 'primary', label: state.busy === 'plan' ? '拉取中…' : '拉取安装计划', disabled: state.busy !== '', onClick: makePlan })),
        )
      }
      var planBox = null
      if (state.plan !== null) {
        var candidates = Array.isArray(state.plan.candidates) ? state.plan.candidates : []
        planBox = h('div', { style: styles.nested },
          h('p', { style: styles.hint }, '已固定提交：' + (state.plan.commit === undefined ? '克隆时记录实际提交' : String(state.plan.commit).slice(0, 12)) + '；只安装勾选项，冲突项默认不勾，不执行仓库脚本。'),
          candidates.length === 0 ? h('p', { style: styles.hint }, '该条目没有可安装的技能。') : null,
          h('div', { style: { display: 'flex', flexDirection: 'column', gap: '6px' } },
            candidates.map(function (candidate) {
              return h('label', { key: candidate.folder, style: styles.checkboxRow },
                h('input', { type: 'checkbox', checked: state.selected[candidate.folder] === true, disabled: candidate.conflict === true || candidate.problem !== undefined, onChange: function () { toggleFolder(candidate.folder) } }),
                h('span', null, candidate.folder + ' · ' + String(candidate.files) + ' 个文件 · ' + formatBytes(candidate.bytes) + (candidate.conflict === true ? ' · 已存在，跳过' : '') + (candidate.problem === undefined ? '' : ' · ' + candidate.problem)),
              )
            }),
          ),
          h('div', { style: styles.actions }, h(Btn, { variant: 'primary', label: state.busy === 'commit' ? '安装中…' : '安装选中', disabled: state.busy !== '', onClick: commitPlan })),
        )
      }
      return h(Section, { title: '技能市场', hint: '来自经验证的公开市场清单；安装走暂存计划、只装勾选项并固定提交。' },
        h('div', { style: { display: 'flex', flexDirection: 'column', gap: '10px' } },
          h('div', { style: styles.pills },
            h(Pill, { label: '来源', value: String(providerLabel || '未配置'), tone: 'muted' }),
            state.providers === null ? null : h(Pill, { label: '已接入', value: state.providers.length, tone: 'ok' }),
          ),
          h('div', { style: { display: 'flex', gap: '8px', alignItems: 'flex-end', flexWrap: 'wrap' } },
            h('div', { style: { flex: '1 1 220px', minWidth: 0 } }, h(Field, { label: '搜索市场', value: state.query, placeholder: '例如 xlsx / pdf / design', onChange: function (value) { patch({ query: value }) } })),
            h(Btn, { variant: 'primary', label: state.busy === 'search' ? '搜索中…' : '搜索', disabled: state.busy !== '', onClick: function () { search(false) } }),
          ),
          state.error === null ? null : h(Banner, { tone: 'bad' }, state.error),
          state.notice === null ? null : h(Banner, { tone: state.notice.tone }, state.notice.text),
          state.status === 'ready' && state.entries.length === 0 ? h('p', { style: styles.hint }, '没有匹配的市场条目。') : null,
          h('div', { style: { display: 'flex', flexDirection: 'column', gap: '8px' } }, resultRows),
          state.nextCursor === null ? null : h('div', { style: styles.actions }, h(Btn, { label: '加载更多', variant: 'small', disabled: state.busy !== '', onClick: function () { search(true) } })),
          detailBox,
          planBox,
        ),
      )
    }

    // ---- P3: interactive sync conflict resolution -------------------------
    function SyncResolveSection(props) {
      var tuple = React.useState({ status: 'idle', data: null, busy: '', error: null, notice: null })
      var state = tuple[0]
      var setState = tuple[1]
      function patch(next) { setState(function (prev) { return Object.assign({}, prev, next) }) }
      React.useEffect(function () { load() }, [])
      function load() {
        patch({ status: 'loading', error: null })
        request(API.sync + '/status', { method: 'GET' }).then(function (res) {
          if (res.body !== null && res.body !== undefined && res.body.ok === true) patch({ status: 'ready', data: res.body })
          else patch({ status: 'error', error: bodyError(res, '读取同步状态失败') })
        }, function (error) { patch({ status: 'error', error: messageOf(error) }) })
      }
      function resolve(name, action) {
        patch({ busy: name + ':' + action, notice: null })
        postJson(API.sync + '/resolve', { name: name, action: action }).then(function (res) {
          if (res.body !== null && res.body !== undefined && res.body.ok === true) {
            var stats = state.data === null ? null : state.data.stats
            patch({ busy: '', data: { stats: stats, conflicts: res.body.conflicts || [] }, notice: { tone: 'ok', text: name + '：' + (res.body.note || '已处理') } })
            if (typeof props.onResolved === 'function') props.onResolved()
          } else patch({ busy: '', notice: { tone: 'bad', text: bodyError(res, '处理冲突失败') } })
        }, function (error) { patch({ busy: '', notice: { tone: 'bad', text: messageOf(error) } }) })
      }
      function runNow() {
        patch({ busy: 'run' })
        postJson(API.sync + '/run', {}).then(function (res) {
          if (res.body !== null && res.body !== undefined && res.body.ok === true) patch({ busy: '', data: { stats: res.body.stats, conflicts: res.body.conflicts || [] }, notice: { tone: 'ok', text: '已执行一次同步。' } })
          else patch({ busy: '', notice: { tone: 'bad', text: bodyError(res, '同步失败') } })
        }, function (error) { patch({ busy: '', notice: { tone: 'bad', text: messageOf(error) } }) })
      }
      var data = state.data
      var stats = data === null || data === undefined ? null : data.stats
      var conflicts = data === null || data === undefined || !Array.isArray(data.conflicts) ? [] : data.conflicts
      var statPills = stats === null ? h('p', { style: styles.hint }, '同步引擎未启用或尚未运行。') : h('div', { style: styles.pills },
        h(Pill, { label: '运行中', value: stats.running === true ? '是' : '否', tone: stats.running === true ? 'warn' : 'muted' }),
        h(Pill, { label: '上次运行', value: formatIso(stats.lastRunAt), tone: 'muted' }),
        h(Pill, { label: '上传', value: (stats.uploaded || []).length, tone: 'muted' }),
        h(Pill, { label: '下载', value: (stats.downloaded || []).length, tone: 'muted' }),
        h(Pill, { label: '冲突', value: conflicts.length, tone: conflicts.length > 0 ? 'warn' : 'muted' }),
      )
      var conflictRows = conflicts.map(function (conflict) {
        var local = conflict.local || {}
        var cloud = conflict.cloud
        return h('div', { key: conflict.name, style: styles.row },
          h('div', { style: styles.rowHead },
            h('span', { style: styles.rowTitle }, conflict.name),
            h('div', { style: styles.pills },
              h(Pill, { label: '原因', value: String(conflict.reason), tone: 'warn' }),
              h(Pill, { label: '本地', value: local.exists === true ? (local.files + ' 文件') : '缺失', tone: local.exists === true ? 'muted' : 'bad' }),
              h(Pill, { label: '云端', value: cloud === null ? '无' : ('rev ' + String(cloud.revision === undefined ? '?' : cloud.revision)), tone: cloud === null ? 'muted' : 'ok' }),
            ),
          ),
          h('p', { style: styles.hint }, conflict.note),
          h('div', { style: styles.actions },
            h(Btn, { label: '保留本地', variant: 'small', disabled: state.busy !== '' || conflict.canKeepLocal !== true, onClick: function () { resolve(conflict.name, 'keep_local') } }),
            h(Btn, { label: '采用云端', variant: 'small', disabled: state.busy !== '' || conflict.canTakeCloud !== true, onClick: function () { resolve(conflict.name, 'take_cloud') } }),
            h(Btn, { label: '手动合并', variant: 'small', disabled: state.busy !== '', onClick: function () { resolve(conflict.name, 'manual') } }),
          ),
        )
      })
      return h(Section, { title: '云端同步与冲突', hint: '同步冲突不会被静默覆盖；逐项选择保留本地（上传为新版本）、采用云端（先备份本地）或手动合并。', aside: h(Btn, { label: state.busy === 'run' ? '同步中…' : '立即同步', variant: 'small', disabled: state.busy !== '', onClick: runNow }) },
        h('div', { style: { display: 'flex', flexDirection: 'column', gap: '10px' } },
          state.error === null ? null : h(Banner, { tone: 'bad' }, state.error),
          state.notice === null ? null : h(Banner, { tone: state.notice.tone }, state.notice.text),
          statPills,
          conflicts.length === 0 ? h('p', { style: styles.hint }, '当前没有待处理冲突。') : h('div', { style: { display: 'flex', flexDirection: 'column', gap: '8px' } }, conflictRows),
        ),
      )
    }

    // ---- P4: MCP market / custom connection / edit / scope / policy -------
    function McpMarketSection(props) {
      var tuple = React.useState({ status: 'loading', items: [], keyword: '', busy: '', notice: null, credValue: '' })
      var s = tuple[0]
      var set = tuple[1]
      function patch(next) { set(function (prev) { return Object.assign({}, prev, next) }) }
      React.useEffect(function () { load() }, [])
      function load() {
        patch({ status: 'loading' })
        bridgeCall('catalog', { keyword: s.keyword }).then(function (res) {
          if (res.status === 200 && res.body !== null && res.body.ok === true) {
            var items = res.body.detail !== undefined && Array.isArray(res.body.detail.items) ? res.body.detail.items : []
            patch({ status: 'ready', items: items })
          } else {
            patch({ status: 'error', notice: { tone: 'bad', text: '读取 MCP 市场失败：' + bridgeMessage(res) } })
          }
        })
      }
      function connect(item) {
        var credential = item.authMode === 'bearer' || item.authMode === 'api-key'
        var method = credential ? 'configure' : 'connect'
        var params = { connectorId: item.id }
        if (credential) {
          if (String(s.credValue).trim() === '') { patch({ notice: { tone: 'warn', text: '请先填写凭据。' } }); return }
          if (item.authMode === 'api-key') params.apiKeyValue = String(s.credValue).trim()
          else params.bearerToken = String(s.credValue).trim()
        }
        patch({ busy: item.id, notice: null })
        bridgeCall(method, params).then(function (res) {
          var ok = res.status === 200 && res.body !== null && res.body.ok === true
          patch({ busy: '', notice: ok ? { tone: 'ok', text: (item.name || item.id) + '：' + bridgeMessage(res) } : { tone: 'bad', text: (item.name || item.id) + '：' + bridgeMessage(res) } })
          if (typeof props.onChanged === 'function') props.onChanged()
        })
      }
      var rows = s.items.map(function (item) {
        var connected = Array.isArray(item.connected) ? item.connected.length : 0
        var credential = item.authMode === 'bearer' || item.authMode === 'api-key'
        return h('div', { key: item.id, style: styles.row },
          h('div', { style: styles.rowHead },
            h('span', { style: styles.rowTitle }, String(item.name || item.id)),
            h('div', { style: styles.pills },
              h(Pill, { label: '分类', value: String(item.category || '—'), tone: 'muted' }),
              h(Pill, { label: '鉴权', value: String(item.authMode || 'none'), tone: 'muted' }),
              connected > 0 ? h(Pill, { label: '已连接', value: connected, tone: 'ok' }) : null,
              h(Pill, { label: '状态', value: String(item.connectionLabel || item.connectionState || '未连接'), tone: connected > 0 ? 'ok' : 'muted' }),
            ),
          ),
          h('p', { style: styles.hint }, String(item.summary || item.description || '')),
          credential
            ? h('div', { style: { display: 'flex', gap: '8px', alignItems: 'flex-end', flexWrap: 'wrap', marginTop: '6px' } },
                h('div', { style: { flex: '1 1 200px', minWidth: 0 } }, h(Field, { label: '凭据（' + String(item.authMode) + '，只保存到宿主）', type: 'password', value: s.credValue, placeholder: String(item.credentialPlaceholder || '填入 ' + String(item.authMode) + ' 凭据'), onChange: function (value) { patch({ credValue: value }) } })),
                h(Btn, { variant: 'primary', label: s.busy === item.id ? '连接中…' : '配置并连接', disabled: s.busy !== '', onClick: function () { connect(item) } }),
              )
            : h('div', { style: styles.actions }, h(Btn, { variant: 'primary', label: s.busy === item.id ? '连接中…' : (String(item.authMode) === 'oauth2-pkce' ? '授权并连接（浏览器）' : '连接'), disabled: s.busy !== '', onClick: function () { connect(item) } })),
        )
      })
      return h(Section, {
        title: 'MCP 市场',
        hint: '目录来自宿主 dsh-mcp-connector 的公开接口；条目、示例与远端文本均为不可信内容。凭据只写宿主，本卡不回显。',
        aside: h(Btn, { label: '刷新目录', variant: 'small', disabled: s.busy !== '', onClick: load }),
      },
        h('div', { style: { display: 'flex', gap: '8px', alignItems: 'flex-end', flexWrap: 'wrap' } },
          h('div', { style: { flex: '1 1 220px', minWidth: 0 } }, h(Field, { label: '搜索目录', value: s.keyword, placeholder: '关键词 / 分类', onChange: function (value) { patch({ keyword: value }) } })),
          h(Btn, { label: '搜索', disabled: s.status === 'loading', onClick: load }),
        ),
        s.notice === null ? null : h(Banner, { tone: s.notice.tone }, s.notice.text),
        s.status === 'loading' ? h('p', { style: styles.hint }, '正在读取目录…') : null,
        s.status === 'ready' && s.items.length === 0 ? h('p', { style: styles.hint }, '目录没有匹配条目。') : null,
        h('div', { style: { display: 'flex', flexDirection: 'column', gap: '10px' } }, rows),
      )
    }

    function McpCustomSection(props) {
      var tuple = React.useState({ transport: 'streamable-http', name: '', serverName: '', url: '', command: '', args: '', cwd: '', authMode: 'none', bearerToken: '', apiKeyHeader: 'X-Api-Key', apiKeyValue: '', importJson: '', busy: '', notice: null })
      var s = tuple[0]
      var set = tuple[1]
      function patch(next) { set(function (prev) { return Object.assign({}, prev, next) }) }
      function submit() {
        if (String(s.name).trim() === '') { patch({ notice: { tone: 'warn', text: '请填写连接名称。' } }); return }
        var params = { name: String(s.name).trim(), serverName: String(s.serverName).trim() || undefined, transport: s.transport, authMode: s.authMode }
        if (s.transport === 'stdio') {
          if (String(s.command).trim() === '') { patch({ notice: { tone: 'warn', text: 'stdio 连接需要启动命令。' } }); return }
          params.command = String(s.command).trim()
          params.args = String(s.args).split(/\s+/).filter(function (x) { return x !== '' })
          if (String(s.cwd).trim() !== '') params.cwd = String(s.cwd).trim()
        } else {
          if (String(s.url).trim() === '') { patch({ notice: { tone: 'warn', text: 'HTTP 连接需要 URL。' } }); return }
          params.url = String(s.url).trim()
          if (s.authMode === 'bearer') params.bearerToken = String(s.bearerToken)
          if (s.authMode === 'api-key') { params.apiKeyHeader = String(s.apiKeyHeader); params.apiKeyValue = String(s.apiKeyValue) }
        }
        patch({ busy: 'configure', notice: null })
        bridgeCall('configure', params).then(function (res) {
          var ok = res.status === 200 && res.body !== null && res.body.ok === true
          patch({ busy: '', notice: ok ? { tone: 'ok', text: bridgeMessage(res) } : { tone: 'bad', text: '新增失败：' + bridgeMessage(res) } })
          if (ok && typeof props.onChanged === 'function') props.onChanged()
        })
      }
      function importJson() {
        if (String(s.importJson).trim() === '') { patch({ notice: { tone: 'warn', text: '请粘贴 mcpServers JSON。' } }); return }
        patch({ busy: 'import', notice: null })
        bridgeCall('importJson', { json: s.importJson }).then(function (res) {
          var ok = res.status === 200 && res.body !== null && res.body.ok === true
          patch({ busy: '', notice: ok ? { tone: 'ok', text: bridgeMessage(res) } : { tone: 'bad', text: '导入失败：' + bridgeMessage(res) } })
          if (ok && typeof props.onChanged === 'function') props.onChanged()
        })
      }
      return h(Section, { title: '新增 / 导入连接', hint: 'HTTP 与 stdio 都由宿主校验并保存凭据；本卡不回显已有密钥。stdio 的启动命令由你显式填写，云端不会执行任何本机命令。' },
        h('div', { style: { display: 'flex', flexDirection: 'column', gap: '10px' } },
          h('div', { style: styles.grid },
            h(Field, { label: '名称', value: s.name, onChange: function (v) { patch({ name: v }) } }),
            h(Field, { label: 'Server 名（可选）', value: s.serverName, onChange: function (v) { patch({ serverName: v }) } }),
            h('div', { style: styles.field },
              h('span', { style: styles.label }, '传输方式'),
              h('select', { value: s.transport, style: styles.input, onChange: function (e) { patch({ transport: e.target.value }) } },
                h('option', { value: 'streamable-http' }, 'Streamable HTTP'),
                h('option', { value: 'stdio' }, 'stdio（本机进程）'),
              ),
            ),
          ),
          s.transport === 'stdio'
            ? h('div', { style: styles.grid },
                h(Field, { label: '启动命令', value: s.command, placeholder: 'npx / uvx / 本机可执行文件', onChange: function (v) { patch({ command: v }) } }),
                h(Field, { label: '参数（空格分隔）', value: s.args, onChange: function (v) { patch({ args: v }) } }),
                h(Field, { label: '工作目录（可选）', value: s.cwd, onChange: function (v) { patch({ cwd: v }) } }),
              )
            : h('div', { style: { display: 'flex', flexDirection: 'column', gap: '10px' } },
                h(Field, { label: 'URL', value: s.url, placeholder: 'https://…', onChange: function (v) { patch({ url: v }) } }),
                h('div', { style: styles.grid },
                  h('div', { style: styles.field },
                    h('span', { style: styles.label }, '鉴权'),
                    h('select', { value: s.authMode, style: styles.input, onChange: function (e) { patch({ authMode: e.target.value }) } },
                      h('option', { value: 'none' }, '无'),
                      h('option', { value: 'bearer' }, 'Bearer Token'),
                      h('option', { value: 'api-key' }, 'API Key'),
                    ),
                  ),
                  s.authMode === 'bearer' ? h(Field, { label: 'Bearer Token', type: 'password', value: s.bearerToken, onChange: function (v) { patch({ bearerToken: v }) } }) : null,
                  s.authMode === 'api-key' ? h(Field, { label: 'API Key 头', value: s.apiKeyHeader, onChange: function (v) { patch({ apiKeyHeader: v }) } }) : null,
                  s.authMode === 'api-key' ? h(Field, { label: 'API Key 值', type: 'password', value: s.apiKeyValue, onChange: function (v) { patch({ apiKeyValue: v }) } }) : null,
                ),
              ),
          h('div', { style: styles.actions }, h(Btn, { variant: 'primary', label: s.busy === 'configure' ? '保存中…' : '校验并保存连接', disabled: s.busy !== '', onClick: submit })),
          h('p', { style: styles.hint }, '或粘贴 mcpServers JSON 批量导入：'),
          h('textarea', { value: s.importJson, rows: 5, style: Object.assign({}, styles.input, { fontFamily: 'monospace', resize: 'vertical' }), placeholder: '{"mcpServers":{"name":{"url":"…"}}}', onChange: function (e) { patch({ importJson: e.target.value }) } }),
          h('div', { style: styles.actions }, h(Btn, { label: s.busy === 'import' ? '导入中…' : '导入 JSON', disabled: s.busy !== '', onClick: importJson })),
          s.notice === null ? null : h(Banner, { tone: s.notice.tone }, s.notice.text),
        ),
      )
    }

    function McpConfigSection(props) {
      var items = Array.isArray(props.items) ? props.items : []
      var tuple = React.useState({ key: '', json: '', busy: '', notice: null, scopePreview: null, targetScope: 'global', workspaceId: '', gov: null, policyPreview: null })
      var s = tuple[0]
      var set = tuple[1]
      function patch(next) { set(function (prev) { return Object.assign({}, prev, next) }) }
      var selected = null
      for (var i = 0; i < items.length; i += 1) if (items[i].key === s.key) selected = items[i]
      React.useEffect(function () {
        bridgeCall('governance', {}).then(function (res) {
          if (res.body !== null && res.body.ok === true) patch({ gov: res.body.detail })
        })
      }, [])
      function choose(key) {
        patch({ key: key, json: '', scopePreview: null, policyPreview: null, notice: null })
        if (key === '') return
        bridgeCall('editableConnectionConfig', { key: key }).then(function (res) {
          if (res.body !== null && res.body.ok === true && res.body.detail !== undefined) patch({ json: String(res.body.detail.json === undefined ? '' : res.body.detail.json) })
          else patch({ json: '', notice: { tone: 'warn', text: bridgeMessage(res) } })
        })
      }
      function save() {
        if (s.key === '') return
        patch({ busy: 'save' })
        bridgeCall('reconfigureConnection', { key: s.key, json: s.json }).then(function (res) {
          var ok = res.body !== null && res.body.ok === true
          patch({ busy: '', notice: ok ? { tone: 'ok', text: bridgeMessage(res) } : { tone: 'bad', text: '保存失败：' + bridgeMessage(res) } })
          if (ok && typeof props.onChanged === 'function') props.onChanged()
        })
      }
      function previewScope() {
        if (s.key === '') return
        patch({ busy: 'scope-preview' })
        var params = { key: s.key, targetScope: s.targetScope, mode: 'move' }
        if (s.targetScope === 'project') params.workspaceId = s.workspaceId
        bridgeCall('previewConnectionScope', params).then(function (res) {
          var ok = res.body !== null && res.body.ok === true
          patch({ busy: '', scopePreview: ok ? res.body.detail : null, notice: ok ? null : { tone: 'bad', text: bridgeMessage(res) } })
          if (ok && res.body.detail.canApply !== true) patch({ notice: { tone: 'warn', text: bridgeMessage(res) } })
        })
      }
      function applyScope() {
        if (s.key === '' || s.scopePreview === null) return
        patch({ busy: 'scope-apply' })
        var params = { key: s.key, targetScope: s.targetScope, mode: 'move', expectedRevision: s.scopePreview.baseRevision }
        if (s.targetScope === 'project') params.workspaceId = s.workspaceId
        bridgeCall('applyConnectionScope', params).then(function (res) {
          var ok = res.body !== null && res.body.ok === true
          patch({ busy: '', notice: ok ? { tone: 'ok', text: bridgeMessage(res) } : { tone: 'bad', text: '作用域应用失败：' + bridgeMessage(res) }, scopePreview: null })
          if (ok && typeof props.onChanged === 'function') props.onChanged()
        })
      }
      function previewPolicy(effect) {
        if (selected === null) return
        patch({ busy: 'policy-preview' })
        bridgeCall('previewPolicy', { scope: 'connection', effect: effect, connectorId: selected.connectorId }).then(function (res) {
          var ok = res.body !== null && res.body.ok === true
          patch({ busy: '', policyPreview: ok ? res.body.detail : null, notice: ok ? { tone: 'ok', text: bridgeMessage(res) } : { tone: 'bad', text: '策略预览失败：' + bridgeMessage(res) } })
        })
      }
      function applyPolicy() {
        if (selected === null || s.policyPreview === null) return
        patch({ busy: 'policy-apply' })
        bridgeCall('applyPolicy', { scope: 'connection', effect: s.policyPreview.mutation.effect, connectorId: selected.connectorId, expectedRevision: s.policyPreview.baseRevision }).then(function (res) {
          var ok = res.body !== null && res.body.ok === true
          patch({ busy: '', policyPreview: null, notice: ok ? { tone: 'ok', text: bridgeMessage(res) } : { tone: 'bad', text: '策略应用失败：' + bridgeMessage(res) } })
          if (ok) bridgeCall('governance', {}).then(function (g) { if (g.body !== null && g.body.ok === true) patch({ gov: g.body.detail }) })
        })
      }
      var gov = s.gov
      return h(Section, { title: '连接配置、范围与治理', hint: '配置编辑使用宿主的保留标记合并，空输入不会清空已有密钥；作用域与策略都带 revision 预览后再提交。' },
        h('div', { style: { display: 'flex', flexDirection: 'column', gap: '12px' } },
          itemSelect(items, s.key, choose),
          s.key === '' ? h('p', { style: styles.hint }, '选择一条连接后可编辑配置、调整范围或设置治理策略。') : h('div', { style: styles.nested },
            h('p', { style: styles.hint }, '可编辑配置（保留标记 <KEEP_EXISTING> 表示保留原密钥）：'),
            h('textarea', { value: s.json, rows: 8, style: Object.assign({}, styles.input, { fontFamily: 'monospace', resize: 'vertical' }), onChange: function (e) { patch({ json: e.target.value }) } }),
            h('div', { style: styles.actions }, h(Btn, { variant: 'primary', label: s.busy === 'save' ? '保存中…' : '保存配置', disabled: s.busy !== '' || s.json === '', onClick: save })),
            h('p', { style: styles.hint }, '作用域（目标范围 + mode=move，凭据不复制）：'),
            h('div', { style: styles.grid },
              h('div', { style: styles.field },
                h('span', { style: styles.label }, '目标范围'),
                h('select', { value: s.targetScope, style: styles.input, onChange: function (e) { patch({ targetScope: e.target.value }) } },
                  h('option', { value: 'global' }, '全局'),
                  h('option', { value: 'project' }, '指定工作区'),
                ),
              ),
              s.targetScope === 'project' ? h(Field, { label: '工作区 id', value: s.workspaceId, onChange: function (v) { patch({ workspaceId: v }) } }) : null,
            ),
            h('div', { style: styles.actions },
              h(Btn, { label: s.busy === 'scope-preview' ? '预览中…' : '预览作用域', disabled: s.busy !== '', onClick: previewScope }),
              s.scopePreview === null ? null : h(Btn, { variant: 'primary', label: s.busy === 'scope-apply' ? '应用中…' : '应用作用域（rev ' + String(s.scopePreview.baseRevision) + '）', disabled: s.busy !== '' || s.scopePreview.canApply !== true, onClick: applyScope }),
            ),
            s.scopePreview === null ? null : h('p', { style: styles.hint }, '影响：' + String(s.scopePreview.impact === undefined ? '' : JSON.stringify(s.scopePreview.impact)) + '；可应用：' + (s.scopePreview.canApply === true ? '是' : '否') + '；凭据复制：否'),
            h('p', { style: styles.hint }, '治理（当前 connection 级）：'),
            gov === null ? h('p', { style: styles.hint }, '治理文档未读取。') : h('div', { style: styles.pills },
              h(Pill, { label: 'revision', value: gov.revision, tone: 'muted' }),
              h(Pill, { label: '规则', value: (gov.rules || []).length, tone: 'muted' }),
              h(Pill, { label: '优先级', value: String(gov.precedenceLabel || '—'), tone: 'muted' }),
            ),
            h('div', { style: styles.actions },
              h(Btn, { label: '预览 allow', variant: 'small', disabled: s.busy !== '' || selected === null, onClick: function () { previewPolicy('allow') } }),
              h(Btn, { label: '预览 deny', variant: 'small', disabled: s.busy !== '' || selected === null, onClick: function () { previewPolicy('deny') } }),
              h(Btn, { label: '预览 inherit', variant: 'small', disabled: s.busy !== '' || selected === null, onClick: function () { previewPolicy('inherit') } }),
              s.policyPreview === null ? null : h(Btn, { variant: 'primary', label: s.busy === 'policy-apply' ? '应用中…' : '应用策略（rev ' + String(s.policyPreview.baseRevision) + '）', disabled: s.busy !== '', onClick: applyPolicy }),
            ),
          ),
          s.notice === null ? null : h(Banner, { tone: s.notice.tone }, s.notice.text),
        ),
      )
    }

    function itemSelect(items, value, onChange) {
      return h('div', { style: styles.field },
        h('span', { style: styles.label }, '连接'),
        h('select', { value: value, style: styles.input, onChange: function (e) { onChange(e.target.value) } },
          h('option', { value: '' }, '选择连接…'),
          items.map(function (item) { return h('option', { key: item.key, value: item.key }, String(item.name || item.key) + '（' + String(item.transport || '') + '）') }),
        ),
      )
    }

    // ---- import skills from other tools -------------------------------
    function ImportSection() {
      var tuple = React.useState({ status: 'loading', sources: [], open: {}, busy: '', notice: null, imported: {} })
      var s = tuple[0]
      var set = tuple[1]
      function patch(next) { set(function (prev) { return Object.assign({}, prev, next) }) }
      React.useEffect(function () { load() }, [])
      function load() {
        patch({ status: 'loading', notice: null })
        request(API.skills + '/sources', { method: 'GET' }).then(function (res) {
          if (res.body !== null && res.body !== undefined && res.body.ok === true) {
            patch({ status: 'ready', sources: Array.isArray(res.body.sources) ? res.body.sources : [] })
          } else patch({ status: 'error', notice: { tone: 'bad', text: bodyError(res, '读取来源失败') } })
        }, function (error) { patch({ status: 'error', notice: { tone: 'bad', text: messageOf(error) } }) })
      }
      function dshFolders() {
        var found = {}
        s.sources.forEach(function (source) {
          if (!source.writable) return
          var groups = source.groups || []
          groups.forEach(function (group) {
            var skills = group.skills || []
            skills.forEach(function (skill) { found[skill.folder] = true })
          })
        })
        return found
      }
      function toggleSource(sourceId) {
        var next = Object.assign({}, s.open)
        next[sourceId] = next[sourceId] !== true
        patch({ open: next })
      }
      function doImport(source, skill) {
        patch({ busy: source.id + ':' + skill.folder })
        postJson(API.skills + '/import', { sourceId: source.id, folder: skill.folder }).then(function (res) {
          if (res.body !== null && res.body !== undefined && res.body.ok === true) {
            var imported = Object.assign({}, s.imported)
            imported[skill.folder] = true
            patch({ busy: '', imported: imported, notice: { tone: 'ok', text: '已导入「' + skill.name + '」到 DSH，技能文件夹里就能看到。' } })
          } else patch({ busy: '', notice: { tone: 'bad', text: bodyError(res, '导入失败') } })
        }, function (error) { patch({ busy: '', notice: { tone: 'bad', text: messageOf(error) } }) })
      }
      var mine = dshFolders()
      var others = s.sources.filter(function (source) { return !source.writable })
      var rows = others.map(function (source) {
        var skills = []
        var groups = source.groups || []
        groups.forEach(function (group) {
          var list = group.skills || []
          list.forEach(function (skill) { skills.push(skill) })
        })
        var open = s.open[source.id] === true
        return h('div', { key: source.id, style: styles.row },
          h('div', { style: styles.rowHead },
            h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: '8px', minWidth: 0 } },
              h('span', { style: styles.sourceGlyph }, source.label.slice(0, 1)),
              h('span', { style: styles.sourceTitle }, source.label),
              h('span', { style: styles.hint }, source.exists ? skills.length + ' 个技能' : '未安装'),
            ),
            source.exists ? h(Btn, { label: open ? '收起' : '展开', variant: 'small', onClick: function () { toggleSource(source.id) } }) : null,
          ),
          h('span', { style: styles.mono }, source.root),
          !source.exists || !open ? null : skills.length === 0
            ? h('p', { style: styles.hint }, '这个来源里还没有技能。')
            : h('div', { style: { display: 'flex', flexDirection: 'column', gap: '2px' } }, skills.map(function (skill) {
                var has = mine[skill.folder] === true || s.imported[skill.folder] === true
                return h('div', { key: skill.folder, style: styles.skillRow },
                  h('span', { style: { minWidth: 0 } },
                    h('span', { style: styles.rowTitle }, skill.name),
                    skill.description ? h('span', { style: Object.assign({}, styles.hint, { display: 'block' }) }, skill.description) : null,
                  ),
                  has
                    ? h(Pill, { label: 'DSH', value: '已导入', tone: 'muted' })
                    : h(Btn, { label: s.busy === source.id + ':' + skill.folder ? '导入中…' : '导入', variant: 'small', disabled: s.busy !== '', onClick: function () { doImport(source, skill) } }),
                )
              })),
        )
      })
      return h(Section, { title: '从其他软件导入', hint: '把其他软件技能目录里的技能复制一份到 DSH，原目录不动；同名技能不能重复导入。', aside: h(Btn, { label: '刷新', variant: 'small', onClick: load }) },
        s.status === 'loading' ? h('p', { style: styles.hint }, '正在读取来源…')
          : others.length === 0 ? h('p', { style: styles.hint }, '没有检测到其他软件的技能目录。')
          : h('div', { style: { display: 'flex', flexDirection: 'column', gap: '10px' } }, rows),
        s.notice === null ? null : h(Banner, { tone: s.notice.tone }, s.notice.text),
      )
    }

    function SettingsCard() {
      var snapshotState = React.useState(null)
      var snapshot = snapshotState[0]
      var setSnapshot = snapshotState[1]

      var draftState = React.useState(null)
      var draft = draftState[0]
      var setDraft = draftState[1]

      var tokenState = React.useState(emptyTokens())
      var tokenDraft = tokenState[0]
      var setTokenDraft = tokenState[1]

      var identityState = React.useState(readStored('identity', 'account'))
      var identity = identityState[0]
      var setIdentity = identityState[1]

      var loginState = React.useState({ username: '', password: '' })
      var loginDraft = loginState[0]
      var setLoginDraft = loginState[1]

      var loginResultState = React.useState(null)
      var loginResult = loginResultState[0]
      var setLoginResult = loginResultState[1]

      var errorState = React.useState(null)
      var error = errorState[0]
      var setError = errorState[1]

      var noticeState = React.useState(null)
      var notice = noticeState[0]
      var setNotice = noticeState[1]

      var testState = React.useState(null)
      var testResult = testState[0]
      var setTestResult = testState[1]

      var busyState = React.useState('')
      var busy = busyState[0]
      var setBusy = busyState[1]

      var tabState = React.useState(readStored('tab', 'connection'))
      var tab = tabState[0]
      var setTab = tabState[1]

      var advancedState = React.useState(readStored('advanced', 'closed') === 'open')
      var advanced = advancedState[0]
      var setAdvanced = advancedState[1]

      var skillsState = React.useState({ status: 'idle', data: null, error: null, detail: null, uninstall: null, plan: null, selection: [], installUrl: '', search: '', filter: 'all', busy: '' })
      var skills = skillsState[0]
      var setSkills = skillsState[1]

      var mcpState = React.useState({ status: 'idle', items: [], error: null, tools: {}, busy: '', confirm: null })
      var mcp = mcpState[0]
      var setMcp = mcpState[1]

      var treeState = React.useState({ status: 'idle', data: null, error: null, busy: '', expanded: {}, openGroups: {}, edit: null, confirm: null, assign: null })
      var tree = treeState[0]
      var setTree = treeState[1]

      function patchSkills(patch) {
        setSkills(function (previous) {
          return Object.assign({}, previous, patch)
        })
      }

      function patchMcp(patch) {
        setMcp(function (previous) {
          return Object.assign({}, previous, patch)
        })
      }

      function patchTree(patch) {
        setTree(function (previous) {
          return Object.assign({}, previous, patch)
        })
      }

      var load = React.useCallback(
        function (keepDraft) {
          return request(API.status)
            .then(function (result) {
              if (result.status !== 200 || result.body === null || result.body.ok !== true) {
                setError('读取插件状态失败（HTTP ' + String(result.status) + '），请重启 DSH 后再试。')
                return
              }
              setError(null)
              setSnapshot(result.body)
              if (keepDraft !== true) setDraft(pickSettings(result.body.settings))
            })
            .catch(function (failure) {
              setError('无法连接插件：' + messageOf(failure))
            })
        },
        [],
      )

      React.useEffect(
        function () {
          load(false)
          var timer = setInterval(function () {
            if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
            load(true)
          }, POLL_MS)
          return function () {
            clearInterval(timer)
          }
        },
        [load],
      )

      var dirty = snapshot !== null && draft !== null && JSON.stringify(draft) !== JSON.stringify(pickSettings(snapshot.settings))

      React.useEffect(
        function () {
          if (!dirty) return undefined
          var guard = function (event) {
            event.preventDefault()
            event.returnValue = '有未保存的改动'
            return event.returnValue
          }
          window.addEventListener('beforeunload', guard)
          return function () {
            window.removeEventListener('beforeunload', guard)
          }
        },
        [dirty],
      )

      function patchDraft(patch) {
        setDraft(function (previous) {
          return Object.assign({}, previous, patch)
        })
      }

      function patchTokens(patch) {
        setTokenDraft(function (previous) {
          return Object.assign({}, previous, patch)
        })
      }

      function run(label, task) {
        setBusy(label)
        setNotice(null)
        return Promise.resolve()
          .then(task)
          .catch(function (failure) {
            setNotice({ tone: 'bad', text: messageOf(failure) })
          })
          .then(function () {
            setBusy('')
          })
      }

      function save() {
        return run('save', function () {
          var payload = {
            enabled: draft.enabled,
            baseUrl: draft.baseUrl,
            clientId: draft.clientId,
            requestTimeoutMs: Number(draft.requestTimeoutMs),
            defaultK: Number(draft.defaultK),
            summaryEnabled: draft.summaryEnabled,
          }
          if (tokenDraft.activity.trim() !== '') payload.activityToken = tokenDraft.activity.trim()
          if (tokenDraft.memory.trim() !== '') payload.memoryToken = tokenDraft.memory.trim()
          if (tokenDraft.summary.trim() !== '') payload.summaryToken = tokenDraft.summary.trim()
          return request(API.config, { method: 'PUT', body: JSON.stringify(payload) }).then(function (result) {
            if (result.status !== 200 || result.body === null || result.body.ok !== true) {
              throw new Error('保存失败：' + bodyError(result))
            }
            setTokenDraft(emptyTokens())
            var cleared = Array.isArray(result.body.credentialsCleared) ? result.body.credentialsCleared : []
            setNotice(
              cleared.length === 0
                ? { tone: 'ok', text: '已保存到本机配置文件。' }
                : { tone: 'warn', text: '服务地址的 origin 已变更，旧地址的令牌已清除（' + cleared.join('、') + '），请重新登录或填写新令牌。' },
            )
            setSnapshot(result.body)
            setDraft(pickSettings(result.body.settings))
          })
        })
      }

      function clearToken(which) {
        return run('clear-' + which, function () {
          var payload = which === 'activity' ? { clearActivityToken: true } : which === 'memory' ? { clearMemoryToken: true } : { clearSummaryToken: true }
          return request(API.config, { method: 'PUT', body: JSON.stringify(payload) }).then(function (result) {
            if (result.status !== 200 || result.body === null || result.body.ok !== true) {
              throw new Error('清除令牌失败：' + bodyError(result))
            }
            setNotice({ tone: 'ok', text: '令牌已清除。' })
            setSnapshot(result.body)
            setDraft(pickSettings(result.body.settings))
          })
        })
      }

      function test() {
        return run('test', function () {
          setTestResult(null)
          return request(API.test, { method: 'POST', body: '{}' }).then(function (result) {
            if (result.status !== 200 || result.body === null || result.body.ok !== true) {
              throw new Error('测试失败（HTTP ' + String(result.status) + '）')
            }
            setTestResult(result.body)
            load(true)
          })
        })
      }

      function flush() {
        return run('flush', function () {
          return request(API.flush, { method: 'POST', body: '{}' }).then(function (result) {
            if (result.status !== 200 || result.body === null || result.body.ok !== true) {
              throw new Error('重试失败（HTTP ' + String(result.status) + '）')
            }
            setNotice({ tone: 'ok', text: '已重试 ' + String(result.body.sent) + ' 条，剩余 ' + String(result.body.remaining) + ' 条。' })
            load(true)
          })
        })
      }

      function login() {
        return run('login', function () {
          setLoginResult(null)
          var payload = { username: loginDraft.username.trim(), password: loginDraft.password }
          if (payload.username === '' || payload.password === '') {
            throw new Error('请填写用户名和密码')
          }
          return request(API.login, { method: 'POST', body: JSON.stringify(payload) }).then(function (result) {
            if (result.status !== 200 || result.body === null || result.body.ok !== true) {
              throw new Error('登录失败：' + bodyError(result))
            }
            // Drop the password the moment the exchange succeeded.
            setLoginDraft({ username: payload.username, password: '' })
            setLoginResult(result.body.login || null)
            setNotice({
              tone: result.body.login !== null && result.body.login !== undefined && result.body.login.partial === true ? 'warn' : 'ok',
              text: '登录成功，已写入可用的令牌。',
            })
            setSnapshot(result.body)
            setDraft(pickSettings(result.body.settings))
          })
        })
      }

      function switchIdentity(next) {
        setIdentity(next)
        store('identity', next)
        setLoginResult(null)
        setNotice(null)
      }

      function switchTab(next) {
        setTab(next)
        store('tab', next)
        if (next === 'skills' && skills.status === 'idle') loadSkills()
        if (next === 'skills' && tree.status === 'idle') loadTree()
        if (next === 'mcp' && mcp.status === 'idle') probeMcp()
      }

      function toggleAdvanced() {
        setAdvanced(function (previous) {
          store('advanced', previous ? 'closed' : 'open')
          return !previous
        })
      }

      // A panel that opens (or reopens) on the skills/MCP tab must fetch on its
      // own: relying on the click handler alone would leave a stale empty view
      // after a reload, when the tab is restored from local storage.
      React.useEffect(
        function () {
          if (tab === 'skills' && skills.status === 'idle') void loadSkills()
          if (tab === 'skills' && tree.status === 'idle') void loadTree()
          if (tab === 'mcp' && mcp.status === 'idle') void probeMcp()
        },
        [tab, skills.status, mcp.status, tree.status],
      )

      // ---- skills -------------------------------------------------------

      function loadSkills() {
        patchSkills({ status: 'loading', error: null })
        return request(API.skills + '/api')
          .then(function (result) {
            if (result.status !== 200 || result.body === null || result.body.ok !== true) {
              patchSkills({ status: 'error', error: '读取技能列表失败：' + statusText(result.status) })
              return
            }
            patchSkills({ status: 'ready', data: result.body, error: null })
          })
          .catch(function (failure) {
            patchSkills({ status: 'error', error: '无法读取技能列表：' + messageOf(failure) })
          })
      }

      function skillAction(path, payload, label) {
        patchSkills({ busy: label })
        return postJson(API.skills + path, payload)
          .then(function (result) {
            patchSkills({ busy: '' })
            if (result.status !== 200 || result.body === null || result.body.ok !== true) {
              throw new Error(bodyError(result, statusText(result.status)))
            }
            return result.body
          })
          .catch(function (failure) {
            patchSkills({ busy: '' })
            patchSkills({ error: messageOf(failure) })
            setNotice({ tone: 'bad', text: messageOf(failure) })
            throw failure
          })
      }

      // ---- skill tree (sources → categories → skills) --------------------

      function loadTree() {
        patchTree({ status: 'loading', error: null })
        return request(API.skills + '/sources')
          .then(function (result) {
            if (result.status !== 200 || result.body === null || result.body.ok !== true) {
              patchTree({ status: 'error', error: '读取技能来源失败：' + statusText(result.status) })
              return
            }
            patchTree({ status: 'ready', data: result.body, error: null })
          })
          .catch(function (failure) {
            patchTree({ status: 'error', error: '无法读取技能来源：' + messageOf(failure) })
          })
      }

      function treeAction(path, payload, label) {
        patchTree({ busy: label })
        return postJson(API.skills + path, payload)
          .then(function (result) {
            patchTree({ busy: '' })
            if (result.status !== 200 || result.body === null || result.body.ok !== true) {
              throw new Error(bodyError(result, statusText(result.status)))
            }
            return result.body
          })
          .catch(function (failure) {
            patchTree({ busy: '' })
            setNotice({ tone: 'bad', text: messageOf(failure) })
            return null
          })
      }

      function createGroup() {
        if (tree.edit === null) return Promise.resolve()
        var name = String(tree.edit.value === undefined ? '' : tree.edit.value).trim()
        if (name === '') {
          setNotice({ tone: 'bad', text: '请填写分类名。' })
          return Promise.resolve()
        }
        return treeAction('/groups/create', { sourceId: tree.edit.sourceId, name: name }, 'create').then(function (body) {
          if (body === null) return
          patchTree({ edit: null })
          setNotice({ tone: 'ok', text: '已创建分类「' + String(body.name) + '」。' })
          return loadTree()
        })
      }

      function saveRename() {
        if (tree.edit === null) return Promise.resolve()
        return treeAction('/groups/rename', { sourceId: tree.edit.sourceId, groupId: tree.edit.groupId, name: String(tree.edit.value).trim() }, 'rename').then(function (body) {
          if (body === null) return
          patchTree({ edit: null })
          return loadTree()
        })
      }

      function deleteGroup(sourceId, groupId) {
        return treeAction('/groups/delete', { sourceId: sourceId, groupId: groupId }, 'delete').then(function (body) {
          if (body === null) return
          patchTree({ confirm: null })
          setNotice({ tone: 'ok', text: '分类已删除，' + String(body.released) + ' 个技能回到「未分类」；没有删除任何文件。' })
          return loadTree()
        })
      }

      function openAssign(source, group) {
        patchTree({
          assign: {
            sourceId: source.id,
            groupId: group.id,
            selection: (Array.isArray(group.skills) ? group.skills : []).map(function (skill) {
              return skill.folder
            }),
          },
        })
      }

      function saveAssign() {
        if (tree.assign === null) return Promise.resolve()
        return treeAction('/groups/assign', { sourceId: tree.assign.sourceId, groupId: tree.assign.groupId, folders: tree.assign.selection }, 'assign').then(function (body) {
          if (body === null) return
          patchTree({ assign: null })
          return loadTree()
        })
      }

      function toggleGroup(sourceId, groupId, enabled) {
        return treeAction('/groups/toggle', { sourceId: sourceId, groupId: groupId, enabled: enabled }, 'toggle-group').then(function (body) {
          if (body === null) return
          if (body.cardOnly === true) {
            setNotice({ tone: 'warn', text: '这个来源由对应软件自行加载：开关只记录在本卡，不影响它自己的加载。' })
          } else {
            var failed = Array.isArray(body.failed) ? body.failed : []
            setNotice({
              tone: failed.length === 0 ? 'ok' : 'warn',
              text: '已' + (enabled ? '启用' : '停用') + ' ' + String(Array.isArray(body.applied) ? body.applied.length : 0) + ' 项' + (failed.length === 0 ? '（新会话生效）。' : '，' + String(failed.length) + ' 项失败：' + failed.map(function (item) { return String(item.folder) + '(' + String(item.reason) + ')' }).join('、')),
            })
          }
          return loadTree()
        })
      }

      function toggleSource(sourceId, enabled) {
        return treeAction('/source/toggle', { sourceId: sourceId, enabled: enabled }, 'toggle-source').then(function (body) {
          if (body === null) return
          setNotice(
            body.cardOnly === true
              ? { tone: 'warn', text: '这个来源由对应软件自行加载：开关只记录在本卡。' }
              : { tone: 'ok', text: '已' + (enabled ? '启用' : '停用') + ' ' + String(body.applied) + ' 个技能（新会话生效）。' },
          )
          return loadTree()
        })
      }

      function revealSource(sourceId) {
        return treeAction('/source/reveal', { sourceId: sourceId }, 'reveal')
      }

      function openDetail(folder) {
        patchSkills({ detail: { folder: folder, data: null, error: null } })
        return skillAction('/detail', { folder: folder }, 'detail').then(
          function (body) {
            patchSkills({ detail: { folder: folder, data: body, error: null } })
          },
          function () {
            patchSkills({ detail: { folder: folder, data: null, error: '无法读取详情' } })
          },
        )
      }

      function toggleSkill(folder, enabled) {
        return skillAction('/toggle', { folder: folder, enabled: enabled }, 'toggle').then(function (body) {
          setNotice({ tone: 'ok', text: body.note === undefined ? '已更新。' : String(body.note) })
          return loadSkills()
        }, function () {})
      }

      function planUninstall(folder) {
        return skillAction('/uninstall/plan', { folder: folder }, 'uninstall').then(function (body) {
          patchSkills({ uninstall: body })
        }, function () {})
      }

      function confirmUninstall() {
        if (skills.uninstall === null) return Promise.resolve()
        return skillAction('/remove', { folder: skills.uninstall.folder, token: skills.uninstall.token, confirmed: true }, 'remove').then(function (body) {
          patchSkills({ uninstall: null })
          setNotice({ tone: 'ok', text: '已删除本机技能 ' + String(body.folder) + '（' + String(body.files) + ' 个文件）。' })
          return loadSkills()
        }, function () {})
      }

      function prepareInstall() {
        var url = String(skills.installUrl).trim()
        if (url === '') {
          setNotice({ tone: 'bad', text: '请填写 git 仓库地址。' })
          return Promise.resolve()
        }
        return skillAction('/install/plan', { url: url }, 'plan').then(function (body) {
          var selection = (body.candidates || [])
            .filter(function (candidate) {
              return candidate.conflict !== true && candidate.problem === undefined
            })
            .map(function (candidate) {
              return candidate.folder
            })
          patchSkills({ plan: body, selection: selection })
        }, function () {})
      }

      function commitInstall() {
        if (skills.plan === null) return Promise.resolve()
        return skillAction('/install/commit', { planId: skills.plan.planId, folders: skills.selection }, 'commit').then(function (body) {
          var installed = Array.isArray(body.installed) ? body.installed : []
          var skipped = Array.isArray(body.skipped) ? body.skipped : []
          patchSkills({ plan: null, selection: [] })
          setNotice({
            tone: skipped.length === 0 ? 'ok' : 'warn',
            text: '已安装 ' + String(installed.length) + ' 个技能' + (skipped.length === 0 ? '。' : '，跳过 ' + String(skipped.length) + ' 个：' + skipped.map(function (item) { return String(item.folder) + '(' + String(item.reason) + ')' }).join('、')),
          })
          return loadSkills()
        }, function () {})
      }

      function cancelInstall() {
        if (skills.plan === null) return Promise.resolve()
        return skillAction('/install/cancel', { planId: skills.plan.planId }, 'cancel').then(function () {
          patchSkills({ plan: null, selection: [] })
        }, function () {})
      }

      // ---- mcp ----------------------------------------------------------

      function mcpCall(method, params) {
        var controller = typeof AbortController === 'function' ? new AbortController() : null
        var timer = controller === null ? null : setTimeout(function () {
          controller.abort()
        }, PROBE_TIMEOUT_MS)
        return fetch(MCP_BRIDGE, {
          method: 'POST',
          cache: 'no-store',
          headers: { accept: 'application/json', 'content-type': 'application/json' },
          body: JSON.stringify({ method: method, params: params === undefined ? {} : params }),
          signal: controller === null ? undefined : controller.signal,
        })
          .then(function (response) {
            if (timer !== null) clearTimeout(timer)
            return response.json().then(
              function (body) {
                return { status: response.status, body: body }
              },
              function () {
                return { status: response.status, body: null }
              },
            )
          })
          .catch(function (failure) {
            if (timer !== null) clearTimeout(timer)
            return { status: 0, body: null, error: messageOf(failure) }
          })
      }

      function probeMcp() {
        patchMcp({ status: 'probe', error: null })
        return mcpCall('status', {}).then(function (result) {
          if (result.status === 200 && result.body !== null && result.body.ok === true && result.body.detail !== undefined) {
            patchMcp({ status: 'ok', items: Array.isArray(result.body.detail.items) ? result.body.detail.items : [], error: null })
            return
          }
          patchMcp({
            status: 'missing',
            items: [],
            error: result.status === 0 ? '探测超时或连接被拒绝' : '接口返回 HTTP ' + String(result.status) + (result.body !== null && typeof result.body.message === 'string' ? '：' + result.body.message : ''),
          })
        })
      }

      function mcpAction(label, method, params) {
        patchMcp({ busy: label })
        return mcpCall(method, params).then(function (result) {
          patchMcp({ busy: '' })
          if (result.status !== 200 || result.body === null || result.body.ok !== true) {
            var reason = result.body !== null && typeof result.body.message === 'string' ? result.body.message : 'HTTP ' + String(result.status)
            setNotice({ tone: 'bad', text: 'MCP 操作失败：' + reason })
            return null
          }
          setNotice({ tone: 'ok', text: 'MCP 操作已完成：' + label })
          return result.body
        })
      }

      function loadTools(item) {
        return mcpAction('读取工具列表', 'toolsList', { connectorId: item.connectorId, connectionKey: item.key, cachedOnly: true }).then(function (body) {
          if (body === null) return
          var list = body.detail !== undefined && Array.isArray(body.detail.tools) ? body.detail.tools : Array.isArray(body.tools) ? body.tools : []
          patchMcp(function (previous) {
            var tools = Object.assign({}, previous.tools)
            tools[item.key] = { items: list, at: Date.now() }
            return Object.assign({}, previous, { tools: tools })
          })
        })
      }

      // ---- render -------------------------------------------------------

      if (error !== null && snapshot === null) {
        return h(
          'div',
          { style: styles.root },
          h(Banner, { tone: 'bad' }, error),
          h(
            'div',
            { style: styles.actions },
            h(Btn, {
              label: '重新加载',
              onClick: function () {
                load(false)
              },
            }),
          ),
        )
      }

      if (snapshot === null || draft === null) {
        return h('div', { style: styles.root }, h('p', { style: styles.hint }, '正在读取云端记忆插件状态…'))
      }

      var reporter = snapshot.reporter === undefined || snapshot.reporter === null ? {} : snapshot.reporter
      var tokens = snapshot.tokens === undefined || snapshot.tokens === null ? { activity: {}, memory: {}, summary: {} } : snapshot.tokens
      var caps = snapshot.capabilities === undefined || snapshot.capabilities === null ? { features: {} } : snapshot.capabilities
      var features = caps.features === undefined ? {} : caps.features
      var checkSource = testResult !== null ? testResult : snapshot.lastCheck === null || snapshot.lastCheck === undefined ? null : snapshot.lastCheck
      var recent = Array.isArray(reporter.recent) ? reporter.recent.slice(0, 8) : []
      var activityToken = tokens.activity === undefined ? {} : tokens.activity
      var memoryToken = tokens.memory === undefined ? {} : tokens.memory
      var summaryToken = tokens.summary === undefined ? {} : tokens.summary
      var checkedAt = checkSource === null ? '—' : formatTime(checkSource.at === undefined ? checkSource.checkedAt : checkSource.at)

      var connectivity = !draft.baseUrlConfigured
        ? { tone: 'warn', text: '未配置服务' }
        : checkSource === null
          ? { tone: 'muted', text: '未测试' }
          : findCheck(checkSource, 'network') === undefined
            ? { tone: 'muted', text: '未测试' }
            : findCheck(checkSource, 'network').state === 'ok'
              ? { tone: 'ok', text: '可达' }
              : { tone: 'bad', text: '不可达' }

      var header = h(
        'div',
        { style: styles.section, key: 'header' },
        h(
          'div',
          { style: styles.sectionHead },
          h('h4', { style: styles.sectionTitle }, h('span', { style: { display: 'inline-block', width: '9px', height: '9px', borderRadius: '3px', background: 'linear-gradient(135deg, #6366f1, #8b5cf6)', marginRight: '8px', verticalAlign: '1px' } }), '云端记忆 · v' + String(caps.version === undefined ? '—' : caps.version)),
          h(
            'div',
            { style: styles.pills },
            h(Pill, { label: '连接', value: connectivity.text, tone: connectivity.tone }),
            h(Pill, { label: '最后检查', value: checkedAt, tone: 'muted' }),
            dirty ? h(Pill, { label: '草稿', value: '未保存', tone: 'warn' }) : null,
          ),
        ),
        h(
          'div',
          { style: styles.pills },
          h(Pill, { label: '已上报', value: reporter.recorded === undefined ? 0 : reporter.recorded, tone: 'ok' }),
          h(Pill, { label: '待重试', value: reporter.queued === undefined ? 0 : reporter.queued, tone: reporter.queued > 0 ? 'warn' : 'muted' }),
          h(Pill, { label: '失败', value: reporter.failed === undefined ? 0 : reporter.failed, tone: reporter.failed > 0 ? 'bad' : 'muted' }),
        ),
      )

      var tabBar = h(Switch, {
        key: 'tabs',
        ariaLabel: '云端记忆管理页签',
        value: tab,
        onChange: switchTab,
        options: [
          { value: 'connection', label: '连接与上报' },
          { value: 'skills', label: '技能管理' },
          { value: 'mcp', label: 'MCP 管理' },
        ],
      })

      var noticeBox = notice === null ? null : h(Banner, { tone: notice.tone, role: 'status', key: 'notice' }, notice.text)

      var connectionTab = null
      if (tab === 'connection') {
        var changedOrigin = draft.baseUrlConfigured && draft.baseUrlOrigin !== '' && String(draft.baseUrl) !== '' && String(draft.baseUrl).indexOf(draft.baseUrlOrigin) !== 0
        connectionTab = h(
          'div',
          { style: styles.root, key: 'connection' },

          h(
            Section,
            {
              title: '身份验证',
              hint: '两种方式最终更新同一组配置；切换不会清除任何一种方式已保存的凭据，也不会自动发起请求。',
              aside: h(Switch, {
                ariaLabel: '身份验证方式',
                value: identity,
                onChange: switchIdentity,
                options: [
                  { value: 'account', label: '账号登录' },
                  { value: 'token', label: '手动令牌' },
                ],
              }),
            },

            identity === 'account'
              ? h(
                  'div',
                  { style: styles.nested },
                  h(
                    'p',
                    { style: styles.hint },
                    '用云端面板的普通用户账号登录，插件会用一次性会话换取活动与记忆令牌并写入本机。密码只在这一次请求里使用：不保存、不写日志、不回显。',
                  ),
                  h(
                    'div',
                    { style: styles.grid },
                    h(Field, {
                      label: '用户名',
                      value: loginDraft.username,
                      placeholder: '云端面板的账号',
                      onChange: function (value) {
                        setLoginDraft(function (previous) {
                          return Object.assign({}, previous, { username: value })
                        })
                      },
                    }),
                    h(Field, {
                      label: '密码',
                      type: 'password',
                      value: loginDraft.password,
                      placeholder: '只用于本次换取令牌',
                      hint: '成功后自动清空',
                      onChange: function (value) {
                        setLoginDraft(function (previous) {
                          return Object.assign({}, previous, { password: value })
                        })
                      },
                    }),
                  ),
                  h(
                    'div',
                    { style: styles.actions },
                    h(Btn, {
                      variant: 'primary',
                      label: busy === 'login' ? '登录中…' : '登录并获取令牌',
                      disabled: busy !== '',
                      onClick: login,
                    }),
                    loginResult === null
                      ? null
                      : h(
                          'span',
                          { style: styles.hint },
                          '当前账号：' + String(loginResult.user !== undefined && loginResult.user !== null && loginResult.user.username !== undefined ? loginResult.user.username : '未知') + (loginResult.warning === undefined ? '' : '（' + String(loginResult.warning) + '）'),
                        ),
                  ),
                )
              : h(
                  'div',
                  { style: styles.nested },
                  h(
                    'p',
                    { style: styles.hint },
                    '三个令牌各有独立权限：activity:write 只用于上报，memory:write 同时允许检索与写入，summary:write 用于自动摘要（可选）。空值表示不修改；清除是独立动作。',
                  ),
                  h(
                    'div',
                    { style: styles.grid },
                    h(Field, {
                      label: '活动上报令牌（activity:write）',
                      type: 'password',
                      value: tokenDraft.activity,
                      placeholder: activityToken.configured === true ? '已配置 ' + String(activityToken.masked) + '，留空表示不修改' : '未配置',
                      hint: activityToken.configured === true ? '当前：' + String(activityToken.masked) : undefined,
                      onChange: function (value) {
                        patchTokens({ activity: value })
                      },
                    }),
                    h(Field, {
                      label: '记忆读写令牌（memory:write）',
                      type: 'password',
                      value: tokenDraft.memory,
                      placeholder: memoryToken.configured === true ? '已配置 ' + String(memoryToken.masked) + '，留空表示不修改' : '未配置',
                      hint: memoryToken.configured === true ? '当前：' + String(memoryToken.masked) : undefined,
                      onChange: function (value) {
                        patchTokens({ memory: value })
                      },
                    }),
                    h(Field, {
                      label: '摘要令牌（summary:write，可选）',
                      type: 'password',
                      value: tokenDraft.summary,
                      placeholder: summaryToken.configured === true ? '已配置 ' + String(summaryToken.masked) + '，留空表示不修改' : '未配置',
                      hint: summaryToken.configured === true ? '当前：' + String(summaryToken.masked) : undefined,
                      onChange: function (value) {
                        patchTokens({ summary: value })
                      },
                    }),
                  ),
                  h(
                    'div',
                    { style: styles.actions },
                    h(Btn, {
                      label: '清除上报令牌',
                      variant: 'small',
                      disabled: activityToken.configured !== true || busy !== '',
                      onClick: function () {
                        clearToken('activity')
                      },
                    }),
                    h(Btn, {
                      label: '清除记忆令牌',
                      variant: 'small',
                      disabled: memoryToken.configured !== true || busy !== '',
                      onClick: function () {
                        clearToken('memory')
                      },
                    }),
                    h(Btn, {
                      label: '清除摘要令牌',
                      variant: 'small',
                      disabled: summaryToken.configured !== true || busy !== '',
                      onClick: function () {
                        clearToken('summary')
                      },
                    }),
                  ),
                ),
          ),

          h(
            Section,
            {
              title: '服务地址',
              hint: '账号登录会把密码发到该地址：仅接受 HTTPS（本机回环除外）。不同 origin 不会复用旧令牌。',
            },
            h(Field, {
              label: '服务地址（baseUrl）',
              value: draft.baseUrl,
              placeholder: 'https://<你的域名>/api/longmemory',
              hint: changedOrigin ? '地址已改成另一个 origin（当前 ' + draft.baseUrlOrigin + '）：保存后旧令牌会被清除，需要重新认证。' : '当前 origin：' + (draft.baseUrlOrigin === '' ? '未配置' : draft.baseUrlOrigin),
              onChange: function (value) {
                patchDraft({ baseUrl: value })
              },
            }),
            advanced
              ? h(
                  'div',
                  { style: styles.nested },
                  h(
                    'div',
                    { style: styles.grid },
                    h(Field, {
                      label: '客户端标识（client_id）',
                      value: draft.clientId,
                      onChange: function (value) {
                        patchDraft({ clientId: value })
                      },
                    }),
                    h(Field, {
                      label: '请求超时（毫秒）',
                      type: 'number',
                      value: draft.requestTimeoutMs,
                      onChange: function (value) {
                        patchDraft({ requestTimeoutMs: value })
                      },
                    }),
                    h(Field, {
                      label: '单次搜索返回上限',
                      type: 'number',
                      value: draft.defaultK,
                      hint: '只限制一次搜索返回多少条，不限制可搜索的历史范围。默认 10。',
                      onChange: function (value) {
                        patchDraft({ defaultK: value })
                      },
                    }),
                  ),
                  h(
                    'div',
                    { style: styles.checkboxRow },
                    h('input', {
                      type: 'checkbox',
                      checked: draft.enabled,
                      id: 'dsh-brain-enabled',
                      onChange: function (event) {
                        patchDraft({ enabled: event.target.checked })
                      },
                    }),
                    h('label', { htmlFor: 'dsh-brain-enabled', style: styles.label }, '启用每轮活动上报（只上报时间戳、会话 id 与状态，不上传对话内容）'),
                  ),
                  h(
                    'div',
                    { style: styles.checkboxRow },
                    h('input', {
                      type: 'checkbox',
                      checked: draft.summaryEnabled,
                      id: 'dsh-brain-summary',
                      onChange: function (event) {
                        patchDraft({ summaryEnabled: event.target.checked })
                      },
                    }),
                    h('label', { htmlFor: 'dsh-brain-summary', style: styles.label }, '启用自动摘要（会把该轮对话文本上传为待确认提案；与上面的元数据上报是两件事）'),
                  ),
                )
              : h(
                  'div',
                  { style: styles.actions },
                  h(Btn, { label: '高级设置', variant: 'small', onClick: toggleAdvanced }),
                ),
          ),

          h(
            Section,
            {
              title: '连接与权限检查',
              aside: h(
                'div',
                { style: styles.actions },
                h(Btn, { variant: 'primary', label: busy === 'save' ? '保存中…' : '保存', disabled: busy !== '', onClick: save }),
                h(Btn, { label: busy === 'test' ? '测试中…' : '测试连接', disabled: busy !== '', onClick: test }),
                h(Btn, {
                  label: '重试上报队列',
                  disabled: busy !== '' || reporter.queued === undefined || reporter.queued === 0,
                  onClick: flush,
                }),
              ),
            },
            checkSource === null
              ? h('p', { style: styles.hint }, '还没有检查记录。点「测试连接」做一次只读检查：网络 → 活动权限 → 记忆权限 → 摘要权限。')
              : h(
                  'div',
                  { style: styles.pills },
                  (checkSource.checks || []).map(function (check) {
                    return h(Pill, {
                      key: String(check.id),
                      label: String(check.label === undefined ? check.id : check.label),
                      value: CHECK_LABELS[check.state] === undefined ? String(check.state) : CHECK_LABELS[check.state],
                      tone: CHECK_TONES[check.state] === undefined ? 'muted' : CHECK_TONES[check.state],
                    })
                  }),
                ),
            checkSource === null
              ? null
              : h(
                  'div',
                  { style: { display: 'flex', flexDirection: 'column', gap: '6px' } },
                  (checkSource.checks || []).map(function (check) {
                    return h(
                      'div',
                      {
                        key: 'detail-' + String(check.id),
                        style: Object.assign({}, styles.banner, styles[CHECK_TONES[check.state]] === undefined ? styles.muted : styles[CHECK_TONES[check.state]]),
                      },
                      String(check.label === undefined ? check.id : check.label) + '：' + String(check.message),
                    )
                  }),
                ),
            h('p', { style: styles.hint }, '鉴权通过只代表令牌有效，不代表已经成功写入一条上报；两者在下面分开显示。'),
          ),

          h(
            Section,
            { title: '最近上报' },
            recent.length === 0
              ? h('p', { style: styles.hint }, '还没有记录。发一条消息让它跑完一轮，这里就会出现一条。')
              : h(
                  'table',
                  { style: styles.table },
                  h('thead', null, h('tr', null, h('th', { style: styles.th }, '时间'), h('th', { style: styles.th }, '结果'), h('th', { style: styles.th }, 'turn_id'))),
                  h(
                    'tbody',
                    null,
                    recent.map(function (row, index) {
                      var outcome = String(row.outcome === undefined ? '' : row.outcome)
                      return h(
                        'tr',
                        { key: String(row.turnId) + ':' + String(index) },
                        h('td', { style: styles.td }, formatTime(row.at)),
                        h(
                          'td',
                          { style: styles.td },
                          h(
                            'span',
                            { style: Object.assign({}, styles.pill, styles[OUTCOME_TONES[outcome]] === undefined ? styles.muted : styles[OUTCOME_TONES[outcome]]) },
                            OUTCOME_LABELS[outcome] === undefined ? outcome : OUTCOME_LABELS[outcome],
                          ),
                        ),
                        h('td', { style: Object.assign({}, styles.td, styles.mono) }, String(row.turnId === undefined ? '' : row.turnId)),
                      )
                    }),
                  ),
                ),
            reporter.lastError === undefined ? null : h('p', { style: styles.hint }, '最近一次错误：' + String(reporter.lastError)),
          ),

          h(
            'p',
            { style: styles.hint },
            '配置保存在 ' + String(snapshot.settingsPath === undefined ? '本机配置文件' : snapshot.settingsPath) + '。页面地址 /dsh-brain 仍然可用。',
          ),
        )
      }

      var skillsTab = null
      if (tab === 'skills') {
        var treeSources = tree.data !== null && Array.isArray(tree.data.sources) ? tree.data.sources : []
        var keyword = String(skills.search).trim().toLowerCase()

        var matchesSkill = function (skill) {
          if (keyword === '') return true
          return (String(skill.folder) + ' ' + String(skill.name) + ' ' + String(skill.description)).toLowerCase().indexOf(keyword) >= 0
        }

        var visibleGroupsOf = function (source) {
          return (Array.isArray(source.groups) ? source.groups : [])
            .map(function (group) {
              var visible = (Array.isArray(group.skills) ? group.skills : []).filter(matchesSkill)
              return Object.assign({}, group, { visible: visible })
            })
            .filter(function (group) {
              return group.visible.length > 0 || keyword === ''
            })
        }

        var detailBox = null
        if (skills.detail !== null) {
          var detail = skills.detail.data
          detailBox = h(
            'div',
            { style: styles.row },
            h(
              'div',
              { style: styles.rowHead },
              h('span', { style: styles.rowTitle }, '详情：' + String(skills.detail.folder)),
              h(Btn, {
                label: '关闭',
                variant: 'small',
                onClick: function () {
                  patchSkills({ detail: null })
                },
              }),
            ),
            detail === null
              ? h('p', { style: styles.hint }, skills.detail.error === null ? '正在读取…' : String(skills.detail.error))
              : h(
                  'div',
                  { style: styles.nested },
                  h(
                    'div',
                    { style: styles.grid },
                    h(Field, { label: '目录', value: String(detail.dir), onChange: function () {} }),
                    h(Field, { label: 'SKILL.md 哈希', value: String(detail.skill !== undefined ? detail.skill.skillSha256 : ''), onChange: function () {} }),
                  ),
                  h('p', { style: styles.hint }, '文件：' + String(Array.isArray(detail.files) ? detail.files.length : 0) + ' 个，共 ' + formatBytes(detail.totalBytes) + (detail.truncated ? '（SKILL.md 过长，已截断显示）' : '')),
                  h('pre', { style: styles.code }, String(detail.skillMd === undefined ? '' : detail.skillMd)),
                  h(
                    'p',
                    { style: styles.hint },
                    '文件清单：' + (Array.isArray(detail.files) ? detail.files.map(function (file) { return String(file.path) + (file.script ? '(脚本)' : '') }).join('、') : ''),
                  ),
                ),
          )
        }

        var uninstallBox = null
        if (skills.uninstall !== null) {
          uninstallBox = h(
            'div',
            { style: Object.assign({}, styles.row, styles.warn) },
            h('div', { style: styles.rowHead }, h('span', { style: styles.rowTitle }, '卸载确认：' + String(skills.uninstall.folder))),
            h(
              'p',
              { style: styles.hint },
              '将实际删除：' + String(skills.uninstall.dir) + '；影响：' + String(skills.uninstall.files) + ' 个文件 / ' + formatBytes(skills.uninstall.bytes) + (Array.isArray(skills.uninstall.scripts) && skills.uninstall.scripts.length > 0 ? '；含脚本：' + skills.uninstall.scripts.join('、') : ''),
            ),
            h('p', { style: styles.hint }, String(skills.uninstall.note)),
            h(
              'div',
              { style: styles.actions },
              h(Btn, { variant: 'danger', label: tree.busy === 'uninstall' ? '删除中…' : '确认删除（不可恢复）', disabled: tree.busy !== '', onClick: confirmUninstall }),
              h(Btn, {
                label: '取消',
                disabled: tree.busy !== '',
                onClick: function () {
                  patchSkills({ uninstall: null })
                },
              }),
            ),
          )
        }

        var planBox = null
        if (skills.plan !== null) {
          var candidates = Array.isArray(skills.plan.candidates) ? skills.plan.candidates : []
          planBox = h(
            'div',
            { style: styles.row },
            h('div', { style: styles.rowHead }, h('span', { style: styles.rowTitle }, '安装预览：' + String(skills.plan.url))),
            h(
              'p',
              { style: styles.hint },
              '计划 ' + String(skills.plan.planId) + ' 有效到 ' + formatTime(skills.plan.expiresAt) + '。默认不勾选冲突项；只安装勾选的技能，来源中的安装脚本不会执行。',
            ),
            h(
              'div',
              { style: { display: 'flex', flexDirection: 'column', gap: '6px' } },
              candidates.map(function (candidate) {
                var selected = skills.selection.indexOf(candidate.folder) >= 0
                var blocked = candidate.conflict === true || candidate.problem !== undefined
                return h(
                  'label',
                  { key: String(candidate.id), style: styles.checkboxRow },
                  h('input', {
                    type: 'checkbox',
                    checked: selected,
                    disabled: blocked,
                    onChange: function (event) {
                      var next = skills.selection.slice()
                      var at = next.indexOf(candidate.folder)
                      if (event.target.checked && at < 0) next.push(candidate.folder)
                      if (!event.target.checked && at >= 0) next.splice(at, 1)
                      patchSkills({ selection: next })
                    },
                  }),
                  h(
                    'span',
                    { style: { minWidth: 0 } },
                    h('span', { style: { fontWeight: 600 } }, String(candidate.name)),
                    h('span', { style: styles.hint }, ' · ' + String(candidate.folder) + ' · ' + String(candidate.files) + ' 个文件 · ' + formatBytes(candidate.bytes) + (candidate.conflict === true ? ' · 已存在（' + String(candidate.conflictLocation === 'holding' ? '已停用目录' : '技能目录') + '），不覆盖' : '') + (candidate.problem === undefined ? '' : ' · ' + String(candidate.problem)) + (Array.isArray(candidate.scripts) && candidate.scripts.length > 0 ? ' · 含脚本：' + candidate.scripts.join('、') : '')),
                  ),
                )
              }),
            ),
            h(
              'div',
              { style: styles.actions },
              h(Btn, {
                variant: 'primary',
                label: tree.busy === 'commit' ? '安装中…' : '安装所选（' + String(skills.selection.length) + '）',
                disabled: tree.busy !== '' || skills.selection.length === 0,
                onClick: commitInstall,
              }),
              h(Btn, { label: '放弃计划', variant: 'small', disabled: tree.busy !== '', onClick: cancelInstall }),
            ),
          )
        }

        var assignBox = null
        if (tree.assign !== null) {
          var assignSource = treeSources.find(function (source) {
            return source.id === tree.assign.sourceId
          })
          var assignGroup = assignSource === undefined
            ? undefined
            : (assignSource.groups || []).find(function (group) {
                return group.id === tree.assign.groupId
              })
          var assignable = []
          if (assignSource !== undefined) {
            (assignSource.groups || []).forEach(function (group) {
              (group.skills || []).forEach(function (skill) {
                if (!assignable.some(function (item) { return item.folder === skill.folder })) assignable.push(skill)
              })
            })
          }
          assignBox = h(
            'div',
            { style: styles.row },
            h(
              'div',
              { style: styles.rowHead },
              h('span', { style: styles.rowTitle }, '加入分类：' + String(assignGroup === undefined ? '' : assignGroup.name)),
              h(Btn, {
                label: '关闭',
                variant: 'small',
                onClick: function () {
                  patchTree({ assign: null })
                },
              }),
            ),
            h('p', { style: styles.hint }, '勾选要放进这个分类的技能；一个技能只会属于一个分类，取消勾选即回到「未分类」。'),
            h(
              'div',
              { style: { display: 'flex', flexDirection: 'column', gap: '4px', maxHeight: '240px', overflow: 'auto' } },
              assignable.map(function (skill) {
                var checked = tree.assign.selection.indexOf(skill.folder) >= 0
                return h(
                  'label',
                  { key: String(skill.folder), style: styles.checkboxRow },
                  h('input', {
                    type: 'checkbox',
                    checked: checked,
                    onChange: function (event) {
                      var next = tree.assign.selection.slice()
                      var at = next.indexOf(skill.folder)
                      if (event.target.checked && at < 0) next.push(skill.folder)
                      if (!event.target.checked && at >= 0) next.splice(at, 1)
                      patchTree({ assign: Object.assign({}, tree.assign, { selection: next }) })
                    },
                  }),
                  h('span', { style: { minWidth: 0 } }, String(skill.name) + ' ', h('span', { style: styles.hint }, '· ' + String(skill.folder))),
                )
              }),
            ),
            h(
              'div',
              { style: styles.actions },
              h(Btn, {
                variant: 'primary',
                label: '保存分类',
                disabled: tree.busy !== '',
                onClick: function () {
                  saveAssign()
                },
              }),
              h(Btn, {
                label: '取消',
                disabled: tree.busy !== '',
                onClick: function () {
                  patchTree({ assign: null })
                },
              }),
            ),
          )
        }

        var renderSkillRow = function (source, skill) {
          var writable = source.writable === true
          return h(
            'div',
            { key: String(source.id) + ':' + String(skill.folder), style: styles.skillRow },
            h(
              'div',
              {
                style: { display: 'flex', alignItems: 'baseline', gap: '8px', minWidth: 0, flex: '1 1 auto', cursor: writable ? 'pointer' : 'default' },
                title: writable ? '查看详情' : undefined,
                onClick: writable
                  ? function () {
                      openDetail(skill.folder)
                    }
                  : undefined,
              },
              h('span', { style: Object.assign({}, styles.rowTitle, { flex: '0 0 auto' }) }, String(skill.name)),
              skill.description === '' ? null : h('span', { style: Object.assign({}, styles.hint, styles.clamp1, { minWidth: 0 }) }, String(skill.description)),
            ),
            h(
              'div',
              { style: { display: 'flex', alignItems: 'center', gap: '6px', flex: '0 0 auto' } },
              skill.enabledEditable !== true ? h('span', { style: styles.hint }, '只读') : null,
              writable
                ? h(IconBtn, {
                    glyph: '🗑',
                    danger: true,
                    ariaLabel: '卸载 ' + String(skill.name),
                    disabled: tree.busy !== '',
                    onClick: function () {
                      planUninstall(skill.folder)
                    },
                  })
                : null,
              skill.enabledEditable !== true
                ? null
                : h(Toggle, {
                    checked: skill.enabled === true,
                    disabled: tree.busy !== '',
                    label: '技能 ' + String(skill.name) + ' 启停',
                    onChange: function () {
                      toggleSkill(skill.folder, skill.enabled !== true)
                    },
                  }),
            ),
          )
        }

        var renderGroup = function (source, group) {
          var open = tree.openGroups[String(source.id) + ':' + group.id] === true
          var renameKey = String(source.id) + ':' + group.id
          var renaming = tree.edit !== null && tree.edit.kind === 'rename' && tree.edit.key === renameKey
          var confirming = tree.confirm === renameKey
          var groupSkills = group.visible === undefined ? group.skills || [] : group.visible
          return h(
            'div',
            { key: renameKey, style: styles.groupRow },
            h(
              'div',
              { style: styles.rowHead },
              h(
                'div',
                { style: { display: 'flex', alignItems: 'center', gap: '6px', minWidth: 0, flexWrap: 'wrap' } },
                h(Btn, {
                  label: open ? '▾' : '▸',
                  variant: 'small',
                  ariaLabel: '展开或收起 ' + String(group.name),
                  onClick: function () {
                    patchTree({ openGroups: Object.assign({}, tree.openGroups, { [renameKey]: !open }) })
                  },
                }),
                h('span', { style: styles.folderGlyph }, '📁'),
                renaming
                  ? h('input', {
                      style: Object.assign({}, styles.input, { width: '160px' }),
                      value: tree.edit.value,
                      autoFocus: true,
                      onChange: function (event) {
                        patchTree({ edit: Object.assign({}, tree.edit, { value: event.target.value }) })
                      },
                    })
                  : h('span', { style: styles.rowTitle }, String(group.name)),
                h('span', { style: styles.hint }, String(group.total) + ' 项 · ' + String(group.enabledCount) + '/' + String(group.total) + ' 启用'),
                group.cardOnly === true ? h(Pill, { label: '开关', value: '仅本卡', tone: 'muted' }) : null,
              ),
              h(
                'div',
                { style: styles.actions },
                renaming
                  ? h(Btn, { label: '保存', variant: 'small', disabled: tree.busy !== '', onClick: saveRename })
                  : h(IconBtn, {
                      glyph: '＋',
                      ariaLabel: '把技能加入 ' + String(group.name),
                      disabled: tree.busy !== '' || group.id === 'unassigned',
                      onClick: function () {
                        openAssign(source, group)
                      },
                    }),
                renaming
                  ? h(Btn, { label: '取消', variant: 'small', onClick: function () { patchTree({ edit: null }) } })
                  : h(IconBtn, {
                      glyph: '✎',
                      ariaLabel: '重命名 ' + String(group.name),
                      disabled: tree.busy !== '' || group.id === 'unassigned',
                      onClick: function () {
                        patchTree({ edit: { kind: 'rename', key: renameKey, sourceId: source.id, groupId: group.id, value: String(group.name) } })
                      },
                    }),
                confirming
                  ? h(Btn, { label: '确认删除分类', variant: 'danger', disabled: tree.busy !== '', onClick: function () { deleteGroup(source.id, group.id) } })
                  : h(IconBtn, {
                      glyph: '🗑',
                      danger: true,
                      ariaLabel: '删除分类 ' + String(group.name) + '（技能回到未分类）',
                      disabled: tree.busy !== '' || group.id === 'unassigned',
                      onClick: function () {
                        patchTree({ confirm: renameKey })
                        setNotice({ tone: 'warn', text: '删除分类只删除分组记录，里面的技能会回到「未分类」，文件不会被删除。再点一次确认。' })
                      },
                    }),
                group.enabledEditable === false
                  ? null
                  : h(Toggle, {
                      checked: group.enabled !== false,
                      disabled: tree.busy !== '',
                      label: '分类 ' + String(group.name) + ' 启停',
                      onChange: function () {
                        toggleGroup(source.id, group.id, group.enabled === false)
                      },
                    }),
              ),
            ),
            open
              ? h(
                  'div',
                  { style: styles.nested },
                  groupSkills.length === 0
                    ? h('p', { style: styles.hint }, group.id === 'unassigned' ? '没有未分类的技能。' : '这个分类还没有技能，点「＋」加入。')
                    : groupSkills.map(function (skill) {
                        return renderSkillRow(source, skill)
                      }),
                )
              : null,
          )
        }

        var dshSource = treeSources.find(function (src) {
          return src.writable === true
        })

        skillsTab = h(
          'div',
          { style: styles.root, key: 'skills' },

          h(ImportSection, {}),

          h(
            Section,
            {
              title: '技能文件夹',
              hint: '按软件来源分组；展开来源与分类查看技能。',
            },
            dshSource === undefined
              ? null
              : h(
                  'div',
                  { style: styles.statsBar },
                  h('span', { style: styles.stat }, h('span', { style: styles.statNum }, String(dshSource.total || 0)), h('span', { style: styles.hint }, '个技能')),
                  h('span', { style: styles.stat }, h('span', { style: styles.statNum }, String(dshSource.enabledCount || 0)), h('span', { style: styles.hint }, '个已启用')),
                  h('span', { style: styles.statLast }, h('span', { style: styles.statNum }, String((dshSource.total || 0) - (dshSource.enabledCount || 0))), h('span', { style: styles.hint }, '个已停用')),
                ),
            h(
              'div',
              { style: { display: 'flex', gap: '8px', alignItems: 'flex-end', flexWrap: 'wrap' } },
              h(
                'div',
                { style: { flex: '1 1 220px', minWidth: 0 } },
                h(Field, {
                  label: '搜索',
                  value: skills.search,
                  placeholder: '按名称、目录或描述筛选',
                  onChange: function (value) {
                    patchSkills({ search: value })
                  },
                }),
              ),
              h(Btn, {
                label: tree.status === 'loading' ? '刷新中…' : '刷新',
                variant: 'small',
                disabled: tree.status === 'loading',
                onClick: function () {
                  loadTree()
                  loadSkills()
                },
              }),
            ),
            tree.error === null ? null : h(Banner, { tone: 'bad' }, tree.error),
            tree.status === 'loading' && tree.data === null ? h('p', { style: styles.hint }, '正在读取技能来源…') : null,
            tree.status === 'ready' && treeSources.length === 0 ? h('p', { style: styles.hint }, '没有探测到任何技能来源。') : null,
            dshSource === undefined
              ? null
              : h(
                  'div',
                  { style: { display: 'flex', flexDirection: 'column', gap: '2px' } },
                  visibleGroupsOf(dshSource).map(function (group) {
                    return renderGroup(dshSource, group)
                  }),
                  tree.edit !== null && tree.edit.kind === 'create' && tree.edit.sourceId === dshSource.id
                    ? h(
                        'div',
                        { style: Object.assign({}, styles.row, { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', marginTop: '6px' }) },
                        h('input', {
                          style: Object.assign({}, styles.input, { width: '180px' }),
                          placeholder: '分类名称，例如 QQ-Skill',
                          value: tree.edit.value,
                          autoFocus: true,
                          onChange: function (event) {
                            patchTree({ edit: Object.assign({}, tree.edit, { value: event.target.value }) })
                          },
                        }),
                        h(Btn, { label: '创建分类', variant: 'primary', disabled: tree.busy !== '', onClick: createGroup }),
                        h(Btn, { label: '取消', onClick: function () { patchTree({ edit: null }) } }),
                      )
                    : h(
                        'div',
                        { style: { marginTop: '6px' } },
                        h(Btn, {
                          label: '＋ 新建分类',
                          variant: 'small',
                          disabled: tree.busy !== '',
                          onClick: function () {
                            patchTree({ edit: { kind: 'create', sourceId: dshSource.id, value: '' } })
                          },
                        }),
                      ),
                ),
            tree.data !== null && tree.data.note !== undefined ? h('p', { style: styles.hint }, String(tree.data.note)) : null,
          ),

          detailBox,
          uninstallBox,

          h(
            Section,
            {
              title: '从 Git 仓库安装',
              hint: '先克隆到隔离暂存目录并列出候选技能，确认后才写入 DSH 技能目录；不执行仓库里的任何脚本，符号链接不会跟随。仓库地址只接受 https:// 或 file://。',
            },
            h(
              'div',
              { style: styles.grid },
              h(Field, {
                label: '仓库地址',
                value: skills.installUrl,
                placeholder: 'https://github.com/<owner>/<repo>.git',
                onChange: function (value) {
                  patchSkills({ installUrl: value })
                },
              }),
            ),
            h(
              'div',
              { style: styles.actions },
              h(Btn, {
                variant: 'primary',
                label: skills.busy === 'plan' ? '拉取中…' : '拉取并预览',
                disabled: skills.busy !== '',
                onClick: prepareInstall,
              }),
            ),
            planBox,
          ),

          h(MarketSection, {
            capabilities: caps,
            onInstalled: function () {
              loadTree()
              loadSkills()
            },
          }),

          h(SyncResolveSection, {
            onResolved: function () {
              loadSkills()
            },
          }),
        )
      }

      var mcpTab = null
      if (tab === 'mcp') {
        var items = Array.isArray(mcp.items) ? mcp.items : []
        var bridgeBox = null
        if (mcp.status === 'missing') {
          bridgeBox = h(
            Banner,
            { tone: 'warn' },
            'MCP 管理当前不可用：没有探测到宿主 dsh-mcp-connector 的公开接口（' + MCP_BRIDGE + '）。' + (mcp.error === null ? '' : '原因：' + String(mcp.error)) + '。自定义 MCP Server 的权威位置仍是「设置 → 插件配置 → MCP 服务器配置」，本卡不会修改它的托管配置。',
          )
        }

        mcpTab = h(
          'div',
          { style: styles.root, key: 'mcp' },
          h(
            Section,
            {
              title: '我的连接',
              hint: '数据来自宿主 dsh-mcp-connector 插件（同一 origin 的公开接口）；本卡不保存任何 MCP 凭据，也不回显启动命令与密钥。',
              aside: h(Btn, { label: mcp.status === 'probe' ? '探测中…' : '重新探测', variant: 'small', disabled: mcp.busy !== '', onClick: probeMcp }),
            },
            bridgeBox,
            mcp.status === 'ok' && items.length === 0 ? h('p', { style: styles.hint }, '宿主还没有登记任何 MCP 连接。') : null,
            mcp.status === 'ok'
              ? h(
                  'div',
                  { style: { display: 'flex', flexDirection: 'column', gap: '8px' } },
                  items.map(function (item) {
                    var state = String(item.connectionState === undefined ? 'unknown' : item.connectionState)
                    var tools = mcp.tools[item.key]
                    return h(
                      'div',
                      { key: String(item.key), style: styles.row },
                      h(
                        'div',
                        { style: styles.rowHead },
                        h('span', { style: styles.rowTitle }, String(item.name === undefined ? item.key : item.name)),
                        h(
                          'div',
                          { style: styles.pills },
                          h(Pill, { label: '状态', value: MCP_STATE_LABELS[state] === undefined ? state : MCP_STATE_LABELS[state], tone: state === 'connected' ? 'ok' : state === 'disabled' ? 'muted' : 'warn' }),
                          h(Pill, { label: '传输', value: String(item.transport === undefined ? '—' : item.transport), tone: 'muted' }),
                          h(Pill, { label: '鉴权', value: String(item.authMode === undefined ? 'none' : item.authMode), tone: 'muted' }),
                          h(Pill, { label: '注入', value: String(item.injectionLabel === undefined ? '—' : item.injectionLabel), tone: 'muted' }),
                        ),
                      ),
                      h(
                        'p',
                        { style: styles.hint },
                        '范围：' + (item.scope === undefined || item.scope === null ? '未知' : String(item.scope.visibility === undefined ? JSON.stringify(item.scope) : item.scope.visibility)) + ' · 健康检查：' + formatIso(item.healthCheckedAt) + (item.lastError === null || item.lastError === undefined ? '' : ' · 最近错误：' + String(item.lastError)),
                      ),
                      h(
                        'div',
                        { style: styles.actions },
                        h(Btn, {
                          label: '健康检查',
                          variant: 'small',
                          disabled: mcp.busy !== '',
                          onClick: function () {
                            mcpAction('健康检查 ' + String(item.name), 'healthCheck', { connectorId: item.connectorId }).then(function () {
                              probeMcp()
                            })
                          },
                        }),
                        h(Btn, {
                          label: '工具列表',
                          variant: 'small',
                          disabled: mcp.busy !== '',
                          onClick: function () {
                            loadTools(item)
                          },
                        }),
                        h(Btn, {
                          label: item.enabled === false ? '启用' : '停用',
                          variant: 'small',
                          disabled: mcp.busy !== '',
                          onClick: function () {
                            mcpAction(item.enabled === false ? '启用连接' : '停用连接', 'setEnabled', { key: item.key, enabled: item.enabled === false }).then(function () {
                              probeMcp()
                            })
                          },
                        }),
                        h(Btn, {
                          label: '重连',
                          variant: 'small',
                          disabled: mcp.busy !== '',
                          onClick: function () {
                            mcpAction('重连', 'reconnect', { key: item.key }).then(function () {
                              probeMcp()
                            })
                          },
                        }),
                        mcp.confirm === item.key
                          ? h(Btn, {
                              label: '确认移除',
                              variant: 'danger',
                              disabled: mcp.busy !== '',
                              onClick: function () {
                                mcpAction('移除连接', 'disconnect', { key: item.key }).then(function () {
                                  patchMcp({ confirm: null })
                                  probeMcp()
                                })
                              },
                            })
                          : h(Btn, {
                              label: '移除连接…',
                              variant: 'small',
                              disabled: mcp.busy !== '',
                              onClick: function () {
                                patchMcp({ confirm: item.key })
                                setNotice({ tone: 'warn', text: '再次点击「确认移除」才会断开该连接定义。' })
                              },
                            }),
                      ),
                      tools === undefined
                        ? null
                        : h(
                            'div',
                            { style: styles.nested },
                            h('p', { style: styles.hint }, '工具缓存（' + formatTime(tools.at) + '）：' + (tools.items.length === 0 ? '空' : tools.items.map(function (tool) { return String(tool.name === undefined ? tool : tool.name) }).join('、'))),
                          ),
                    )
                  }),
                  h('p', { style: styles.hint }, '工具可见不等于业务可调用：连接状态与工具缓存分开显示。'),
                )
              : null,
          ),

          h(McpMarketSection, { onChanged: probeMcp }),
          h(McpCustomSection, { onChanged: probeMcp }),
          h(McpConfigSection, { items: items, onChanged: probeMcp }),
        )
      }

      return h(
        'div',
        { style: styles.root },
        header,
        tabBar,
        noticeBox,
        error === null ? null : h(Banner, { tone: 'bad' }, error),
        tab === 'connection' ? connectionTab : tab === 'skills' ? skillsTab : mcpTab,
      )
    }

    // A thrown render error must not take the settings page down with it, so the
    // card is wrapped in a minimal boundary that renders the message instead.
    function CardBoundary(props) {
      React.Component.call(this, props)
      this.state = { failure: null }
    }

    CardBoundary.prototype = Object.create(React.Component.prototype)
    CardBoundary.prototype.constructor = CardBoundary

    CardBoundary.getDerivedStateFromError = function (failure) {
      return { failure: failure }
    }

    CardBoundary.prototype.render = function () {
      if (this.state.failure !== null) {
        return h(
          'div',
          { style: Object.assign({}, styles.root) },
          h('div', { style: Object.assign({}, styles.banner, styles.bad) }, '云端记忆设置卡渲染失败：' + messageOf(this.state.failure)),
          h('p', { style: styles.hint }, '插件本身仍在运行，可改用 /dsh-brain 页面配置。'),
        )
      }
      return this.props.children
    }

    function apply(ctx) {
      var card = function () {
        return h(CardBoundary, null, h(SettingsCard, null))
      }

      var register = function (seat, options) {
        try {
          ctx.slots.inject(seat, function () {
            return ctx.slots.register(options, card)
          })
        } catch (failure) {
          if (typeof console !== 'undefined') console.warn('[dsh-brain] slot ' + seat + ' unavailable: ' + messageOf(failure))
        }
      }

      register('settings.section', {
        name: 'settings.section',
        id: 'dsh-brain',
        order: 100,
        label: function () {
          return '云端记忆'
        },
      })

      register('plugins.bundle.config', { name: 'plugins.bundle.config', key: 'dsh-brain' })
    }

    module.exports = { apply: apply, inject: inject, name: 'dsh-brain' }
    return module.exports
  },
})
