// dsh-cloud-memory client bundle.
//
// Hand-written on purpose: the host loads this file through `require` shims it
// provides itself (react / react/jsx-runtime), so no bundler is involved. The
// module wrapper below is the contract the web loader expects — `id` has to
// match the package name, otherwise the module graph registers a second copy.
window.__ModuleLoader__.load({
  id: 'dsh-cloud-memory',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports

    'use strict'

    var React = require('react')
    var h = React.createElement

    var STATUS_URL = '/cloud-memory/status'
    var CONFIG_URL = '/cloud-memory/config'
    var LOGIN_URL = '/cloud-memory/login'
    var TEST_URL = '/cloud-memory/test'
    var FLUSH_URL = '/cloud-memory/flush'
    var POLL_MS = 10000

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

    function messageOf(error) {
      if (error === null || error === undefined) return '未知错误'
      if (typeof error === 'string') return error
      return typeof error.message === 'string' ? error.message : String(error)
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

    function pickSettings(settings) {
      return {
        enabled: settings.enabled === true,
        baseUrl: String(settings.baseUrl === undefined ? '' : settings.baseUrl),
        clientId: String(settings.clientId === undefined ? '' : settings.clientId),
        requestTimeoutMs: String(settings.requestTimeoutMs === undefined ? 8000 : settings.requestTimeoutMs),
        defaultK: String(settings.defaultK === undefined ? 10 : settings.defaultK),
      }
    }

    function formatTime(value) {
      if (typeof value !== 'number' || value <= 0) return '—'
      var date = new Date(value)
      var pad = function (n) {
        return n < 10 ? '0' + String(n) : String(n)
      }
      return pad(date.getMonth() + 1) + '-' + pad(date.getDate()) + ' ' + pad(date.getHours()) + ':' + pad(date.getMinutes()) + ':' + pad(date.getSeconds())
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

    var styles = {
      root: {
        display: 'flex',
        flexDirection: 'column',
        gap: '18px',
        padding: '4px 2px 20px',
        fontSize: '13px',
        lineHeight: 1.55,
      },
      section: {
        display: 'flex',
        flexDirection: 'column',
        gap: '10px',
        border: '1px solid rgba(127,127,127,0.28)',
        borderRadius: '10px',
        padding: '14px 16px',
      },
      sectionTitle: {
        margin: 0,
        fontSize: '13px',
        fontWeight: 600,
        letterSpacing: '0.02em',
      },
      hint: {
        margin: 0,
        fontSize: '12px',
        opacity: 0.65,
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
        minWidth: '180px',
      },
      label: {
        fontSize: '12px',
        opacity: 0.75,
      },
      input: {
        font: 'inherit',
        fontSize: '13px',
        padding: '6px 9px',
        borderRadius: '7px',
        border: '1px solid rgba(127,127,127,0.4)',
        background: 'transparent',
        color: 'inherit',
        minWidth: 0,
      },
      checkboxRow: {
        display: 'flex',
        alignItems: 'center',
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
        padding: '6px 16px',
        borderRadius: '8px',
        border: '1px solid rgba(127,127,127,0.45)',
        background: 'transparent',
        color: 'inherit',
        cursor: 'pointer',
      },
      buttonPrimary: {
        font: 'inherit',
        fontSize: '13px',
        padding: '6px 16px',
        borderRadius: '8px',
        border: '1px solid rgba(37,99,235,0.6)',
        background: 'rgba(37,99,235,0.16)',
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
      },
      table: {
        width: '100%',
        borderCollapse: 'collapse',
        fontSize: '12px',
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
      },
      mono: {
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
        fontSize: '11.5px',
        wordBreak: 'break-all',
      },
      ok: { borderColor: 'rgba(22,163,74,0.55)', background: 'rgba(22,163,74,0.12)' },
      bad: { borderColor: 'rgba(220,38,38,0.55)', background: 'rgba(220,38,38,0.12)' },
      warn: { borderColor: 'rgba(217,119,6,0.55)', background: 'rgba(217,119,6,0.12)' },
      muted: {},
      banner: {
        padding: '8px 12px',
        borderRadius: '8px',
        fontSize: '12.5px',
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

    function CloudMemorySettingsCard() {
      var snapshotState = React.useState(null)
      var snapshot = snapshotState[0]
      var setSnapshot = snapshotState[1]

      var draftState = React.useState(null)
      var draft = draftState[0]
      var setDraft = draftState[1]

      var tokenState = React.useState({ activity: '', memory: '' })
      var tokenDraft = tokenState[0]
      var setTokenDraft = tokenState[1]

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

      var load = React.useCallback(
        function (keepDraft) {
          request(STATUS_URL)
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
        [setDraft, setError, setSnapshot],
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

      function patchDraft(patch) {
        setDraft(function (previous) {
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
          }
          if (tokenDraft.activity.trim() !== '') payload.activityToken = tokenDraft.activity.trim()
          if (tokenDraft.memory.trim() !== '') payload.memoryToken = tokenDraft.memory.trim()
          return request(CONFIG_URL, { method: 'PUT', body: JSON.stringify(payload) }).then(function (result) {
            if (result.status !== 200 || result.body === null || result.body.ok !== true) {
              var reason = result.body !== null && typeof result.body.error === 'string' ? result.body.error : statusText(result.status)
              throw new Error('保存失败：' + reason)
            }
            setTokenDraft({ activity: '', memory: '' })
            setNotice({ tone: 'ok', text: '已保存到本机配置文件。' })
            load(false)
          })
        })
      }

      function clearToken(which) {
        return run('clear-' + which, function () {
          var payload = which === 'activity' ? { clearActivityToken: true } : { clearMemoryToken: true }
          return request(CONFIG_URL, { method: 'PUT', body: JSON.stringify(payload) }).then(function (result) {
            if (result.status !== 200 || result.body === null || result.body.ok !== true) {
              throw new Error('清除令牌失败（HTTP ' + String(result.status) + '）')
            }
            setNotice({ tone: 'ok', text: '令牌已清除。' })
            load(false)
          })
        })
      }

      function test() {
        return run('test', function () {
          setTestResult(null)
          return request(TEST_URL, { method: 'POST', body: '{}' }).then(function (result) {
            if (result.status !== 200 || result.body === null || result.body.ok !== true) {
              throw new Error('测试失败（HTTP ' + String(result.status) + '）')
            }
            setTestResult(result.body)
          })
        })
      }

      function flush() {
        return run('flush', function () {
          return request(FLUSH_URL, { method: 'POST', body: '{}' }).then(function (result) {
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
          return request(LOGIN_URL, { method: 'POST', body: JSON.stringify(payload) }).then(function (result) {
            if (result.status !== 200 || result.body === null || result.body.ok !== true) {
              var reason = result.body !== null && typeof result.body.error === 'string' ? result.body.error : statusText(result.status)
              throw new Error('登录失败：' + reason)
            }
            // Drop the password the moment the exchange succeeded.
            setLoginDraft({ username: payload.username, password: '' })
            setLoginResult(result.body.login || null)
            setNotice({
              tone: result.body.login !== null && result.body.login !== undefined && result.body.login.partial === true ? 'warn' : 'ok',
              text: '登录成功，已自动写入两个令牌。',
            })
            setSnapshot(result.body)
            setDraft(pickSettings(result.body.settings))
          })
        })
      }

      if (error !== null && snapshot === null) {
        return h(
          'div',
          { style: styles.root },
          h('div', { style: Object.assign({}, styles.banner, styles.bad) }, error),
          h(
            'div',
            { style: styles.actions },
            h(
              'button',
              {
                style: styles.button,
                onClick: function () {
                  load(false)
                },
              },
              '重新加载',
            ),
          ),
        )
      }

      if (snapshot === null || draft === null) {
        return h('div', { style: styles.root }, h('p', { style: styles.hint }, '正在读取云端记忆插件状态…'))
      }

      var reporter = snapshot.reporter === undefined ? {} : snapshot.reporter
      var tokens = snapshot.tokens === undefined ? { activity: {}, memory: {} } : snapshot.tokens
      var recent = Array.isArray(reporter.recent) ? reporter.recent.slice(0, 6) : []
      var activityToken = tokens.activity === undefined ? {} : tokens.activity
      var memoryToken = tokens.memory === undefined ? {} : tokens.memory

      var banner = null
      if (notice !== null) {
        banner = h('div', { style: Object.assign({}, styles.banner, styles[notice.tone]) }, notice.text)
      }

      var testBox = null
      if (testResult !== null) {
        var activityTest = testResult.activity === undefined ? {} : testResult.activity
        var memoryTest = testResult.memory === undefined ? {} : testResult.memory
        testBox = h(
          'div',
          { style: { display: 'flex', flexDirection: 'column', gap: '6px' } },
          h(
            'div',
            { style: Object.assign({}, styles.banner, activityTest.ok === true ? styles.ok : styles.bad) },
            '活动上报权限：' + (activityTest.ok === true ? '可用 — ' : '不可用 — ') + String(activityTest.message === undefined ? '' : activityTest.message),
          ),
          h(
            'div',
            { style: Object.assign({}, styles.banner, memoryTest.ok === true ? styles.ok : styles.bad) },
            '记忆读写权限：' + (memoryTest.ok === true ? '可用 — ' : '不可用 — ') + String(memoryTest.message === undefined ? '' : memoryTest.message),
          ),
        )
      }

      return h(
        'div',
        { style: styles.root },

        h(
          'div',
          { style: styles.pills },
          h(Pill, { label: '已上报', value: reporter.recorded === undefined ? 0 : reporter.recorded, tone: 'ok' }),
          h(Pill, { label: '重复忽略', value: reporter.duplicate === undefined ? 0 : reporter.duplicate, tone: 'muted' }),
          h(Pill, { label: '失败', value: reporter.failed === undefined ? 0 : reporter.failed, tone: 'bad' }),
          h(Pill, { label: '待重试', value: reporter.queued === undefined ? 0 : reporter.queued, tone: 'warn' }),
          h(Pill, { label: '已跳过', value: reporter.skipped === undefined ? 0 : reporter.skipped, tone: 'muted' }),
        ),

        activityToken.configured !== true && memoryToken.configured !== true
          ? h(
              'div',
              { style: Object.assign({}, styles.banner, styles.warn) },
              '还没有配置令牌。先到云端面板「设置 → API 密钥」各建一个 activity:write 与 memory:write 密钥，把两个都粘到下面「访问令牌」两栏，再点「保存」。',
            )
          : null,

        banner,

        h(
          'div',
          { style: styles.section },
          h('h4', { style: styles.sectionTitle }, '连接'),
          h(
            'div',
            { style: styles.grid },
            h(Field, {
              label: '服务地址',
              value: draft.baseUrl,
              onChange: function (value) {
                patchDraft({ baseUrl: value })
              },
              hint: '留空或写错时会退回默认地址。',
            }),
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
              label: '默认检索条数',
              type: 'number',
              value: draft.defaultK,
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
              id: 'dsh-cloud-memory-enabled',
              onChange: function (event) {
                patchDraft({ enabled: event.target.checked })
              },
            }),
            h('label', { htmlFor: 'dsh-cloud-memory-enabled', style: styles.label }, '启用每轮活动上报（只上报时间戳、会话 id 与状态，不上传对话内容）'),
          ),
        ),

        h(
          'div',
          { style: styles.section },
          h('h4', { style: styles.sectionTitle }, '账号登录（推荐）'),
          h(
            'p',
            { style: styles.hint },
            '用云端面板的普通用户账号登录，插件会用一次性会话换取 activity:write 与 memory:write 两个令牌并写入本机。密码只在这一次请求里使用：不保存、不写日志、不回显，换取成功后立即从内存丢弃。',
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
              onChange: function (value) {
                setLoginDraft(function (previous) {
                  return Object.assign({}, previous, { password: value })
                })
              },
              hint: '成功后自动清空',
            }),
          ),
          h(
            'div',
            { style: styles.actions },
            h(
              'button',
              {
                style: styles.buttonPrimary,
                disabled: busy !== '',
                onClick: function () {
                  login()
                },
              },
              busy === 'login' ? '登录中…' : '登录并获取令牌',
            ),
            loginResult === null
              ? null
              : h(
                  'span',
                  { style: styles.hint },
                  '已登录：' +
                    String(loginResult.user !== null && loginResult.user !== undefined && loginResult.user.username !== undefined ? loginResult.user.username : '未知账号') +
                    (loginResult.warning === undefined || loginResult.warning === null ? '' : '（' + String(loginResult.warning) + '）'),
                ),
          ),
        ),

        h(
          'div',
          { style: styles.section },
          h('h4', { style: styles.sectionTitle }, '访问令牌'),
          h(
            'p',
            { style: styles.hint },
            '两个令牌各有独立权限：activity:write 只用于上报，memory:write 同时允许检索与写入。令牌只写入本机 ' +
              String(snapshot.settingsPath === undefined ? '配置文件' : snapshot.settingsPath) +
              '，不会进入会话上下文。',
          ),
          h(
            'div',
            { style: styles.grid },
            h(Field, {
              label: '活动上报令牌（activity:write）',
              type: 'password',
              value: tokenDraft.activity,
              placeholder: activityToken.configured === true ? '已配置 ' + String(activityToken.masked) + '，留空表示不修改' : '未配置',
              onChange: function (value) {
                setTokenDraft(function (previous) {
                  return Object.assign({}, previous, { activity: value })
                })
              },
              hint: activityToken.configured === true ? '当前：' + String(activityToken.masked) : undefined,
            }),
            h(Field, {
              label: '记忆读写令牌（memory:write）',
              type: 'password',
              value: tokenDraft.memory,
              placeholder: memoryToken.configured === true ? '已配置 ' + String(memoryToken.masked) + '，留空表示不修改' : '未配置',
              onChange: function (value) {
                setTokenDraft(function (previous) {
                  return Object.assign({}, previous, { memory: value })
                })
              },
              hint: memoryToken.configured === true ? '当前：' + String(memoryToken.masked) : undefined,
            }),
          ),
          h(
            'div',
            { style: styles.actions },
            h(
              'button',
              {
                style: styles.button,
                disabled: activityToken.configured !== true,
                onClick: function () {
                  clearToken('activity')
                },
              },
              '清除上报令牌',
            ),
            h(
              'button',
              {
                style: styles.button,
                disabled: memoryToken.configured !== true,
                onClick: function () {
                  clearToken('memory')
                },
              },
              '清除记忆令牌',
            ),
          ),
        ),

        h(
          'div',
          { style: styles.actions },
          h(
            'button',
            {
              style: styles.buttonPrimary,
              disabled: busy !== '',
              onClick: function () {
                save()
              },
            },
            busy === 'save' ? '保存中…' : '保存',
          ),
          h(
            'button',
            {
              style: styles.button,
              disabled: busy !== '',
              onClick: function () {
                test()
              },
            },
            busy === 'test' ? '测试中…' : '测试连接',
          ),
          h(
            'button',
            {
              style: styles.button,
              disabled: busy !== '' || reporter.queued === undefined || reporter.queued === 0,
              onClick: function () {
                flush()
              },
            },
            '重试上报队列',
          ),
        ),

        testBox,

        h(
          'div',
          { style: styles.section },
          h('h4', { style: styles.sectionTitle }, '最近上报'),
          recent.length === 0
            ? h('p', { style: styles.hint }, '还没有记录。发一条消息让它跑完一轮，这里就会出现一条。')
            : h(
                'table',
                { style: styles.table },
                h(
                  'thead',
                  null,
                  h(
                    'tr',
                    null,
                    h('th', { style: styles.th }, '时间'),
                    h('th', { style: styles.th }, '结果'),
                    h('th', { style: styles.th }, '状态'),
                    h('th', { style: styles.th }, 'turn_id'),
                  ),
                ),
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
                      h('td', { style: styles.td }, String(row.status === undefined ? '' : row.status)),
                      h('td', { style: Object.assign({}, styles.td, styles.mono) }, String(row.turnId === undefined ? '' : row.turnId)),
                    )
                  }),
                ),
              ),
          reporter.lastError === undefined
            ? null
            : h('p', { style: styles.hint }, '最近一次错误：' + String(reporter.lastError)),
        ),

        h('p', { style: styles.hint }, '配置保存在 ' + String(snapshot.settingsPath === undefined ? '本机配置文件' : snapshot.settingsPath) + '，页面地址 /cloud-memory 仍然可用。'),
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
          h('p', { style: styles.hint }, '插件本身仍在运行，可改用 /cloud-memory 页面配置。'),
        )
      }
      return this.props.children
    }

    function apply(ctx) {
      var card = function () {
        return h(CardBoundary, null, h(CloudMemorySettingsCard, null))
      }

      var register = function (seat, options) {
        try {
          ctx.slots.inject(seat, function () {
            return ctx.slots.register(options, card)
          })
        } catch (failure) {
          if (typeof console !== 'undefined') console.warn('[dsh-cloud-memory] slot ' + seat + ' unavailable: ' + messageOf(failure))
        }
      }

      register('settings.section', {
        name: 'settings.section',
        id: 'cloud-memory',
        order: 100,
        label: function () {
          return '云端记忆'
        },
      })

      register('plugins.bundle.config', { name: 'plugins.bundle.config', key: 'dsh-cloud-memory' })
    }

    module.exports = { apply: apply, inject: inject, name: 'dsh-cloud-memory' }
    return module.exports
  },
})
