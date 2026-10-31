/**
 * Standalone configuration page.
 *
 * This profile runs with the native settings surface disabled
 * (`ui-settings` is turned off in `cordis.patch.yml`), so the plugin ships its
 * own HTML page at `/cloud-memory`. It is deliberately dependency-free: no
 * bundler assets, no CDN, no fonts — one file the host web server can emit.
 *
 * The page renders tokens as masked values only; the plaintext never leaves
 * `$DSH_HOME/cloud-memory.json`.
 */

/** Escape a value for safe interpolation into HTML text/attributes. */
export function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

/** Render the configuration page. */
export function renderConfigPage(options: { version: string; settingsPath: string }): string {
  // The client script is plain ES2020 and avoids template literals so this
  // outer template stays readable.
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>云端记忆 · DSH 插件</title>
<style>
:root { color-scheme: light dark; }
* { box-sizing: border-box; }
body {
  margin: 0;
  padding: 32px 24px 64px;
  font: 14px/1.6 -apple-system, "Segoe UI", "Microsoft YaHei", system-ui, sans-serif;
  background: #f6f7f9;
  color: #1c1f23;
}
@media (prefers-color-scheme: dark) {
  body { background: #14161a; color: #e6e8eb; }
  .card { background: #1c1f24 !important; border-color: #2b303a !important; }
  input, select { background: #12141a !important; color: #e6e8eb !important; border-color: #333a45 !important; }
  th { color: #9aa3af !important; }
  tr + tr td { border-color: #262b33 !important; }
  .muted { color: #8b949e !important; }
  code { background: #22262d !important; }
}
.wrap { max-width: 980px; margin: 0 auto; }
h1 { font-size: 20px; margin: 0 0 4px; letter-spacing: .2px; }
h2 { font-size: 14px; margin: 0 0 14px; font-weight: 600; letter-spacing: .3px; }
.sub { margin: 0 0 24px; color: #5c6672; font-size: 13px; }
@media (prefers-color-scheme: dark) { .sub { color: #8b949e; } }
.card {
  background: #fff; border: 1px solid #e3e6ea; border-radius: 12px;
  padding: 20px 22px; margin-bottom: 18px;
}
.grid { display: grid; grid-template-columns: 1fr 1fr; gap: 14px 18px; }
@media (max-width: 720px) { .grid { grid-template-columns: 1fr; } }
label { display: block; font-size: 12px; font-weight: 600; color: #4a5361; margin-bottom: 6px; }
@media (prefers-color-scheme: dark) { label { color: #a7b0bb; } }
input[type=text], input[type=password], input[type=number] {
  width: 100%; padding: 9px 11px; font: inherit; font-size: 13px;
  border: 1px solid #d7dbe1; border-radius: 8px; background: #fdfdfe; color: inherit;
}
input:focus { outline: 2px solid #4b7bec33; border-color: #4b7bec; }
.hint { font-size: 12px; color: #6b7480; margin-top: 5px; }
.muted { color: #6b7480; }
.row { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
button {
  font: inherit; font-size: 13px; padding: 9px 16px; border-radius: 8px;
  border: 1px solid #d7dbe1; background: #fff; color: inherit; cursor: pointer;
  transition: background .15s ease, border-color .15s ease;
}
button:hover { background: #f2f4f7; }
button.primary { background: #2f6fed; border-color: #2f6fed; color: #fff; }
button.primary:hover { background: #255fd4; }
button:disabled { opacity: .55; cursor: default; }
.stats { display: flex; flex-wrap: wrap; gap: 10px; margin: 6px 0 2px; }
.stat { flex: 1 1 120px; border: 1px solid #e6e9ee; border-radius: 9px; padding: 10px 12px; }
@media (prefers-color-scheme: dark) { .stat { border-color: #2b303a; } }
.stat .k { font-size: 11px; letter-spacing: .4px; color: #6b7480; text-transform: uppercase; }
.stat .v { font-size: 18px; font-weight: 600; margin-top: 2px; }
table { width: 100%; border-collapse: collapse; font-size: 12.5px; }
th { text-align: left; font-size: 11px; letter-spacing: .4px; text-transform: uppercase; color: #6b7480; padding: 6px 8px; }
td { padding: 7px 8px; border-top: 1px solid #eef1f4; vertical-align: top; }
code { font-family: ui-monospace, SFMono-Regular, Consolas, monospace; font-size: 12px; background: #f1f3f6; padding: 1px 5px; border-radius: 4px; }
.pill { display: inline-block; padding: 1px 8px; border-radius: 999px; font-size: 11.5px; font-weight: 600; }
.ok { background: #e6f6ec; color: #1c7c43; }
.bad { background: #fdeaea; color: #b3261e; }
.warn { background: #fff5e0; color: #92600a; }
.sk { background: #eef1f5; color: #55606d; }
.tip { margin-top: 14px; font-size: 12px; color: #6b7480; }
.toast {
  position: fixed; left: 50%; bottom: 26px; transform: translateX(-50%);
  background: #1c1f23; color: #fff; padding: 10px 18px; border-radius: 999px;
  font-size: 13px; opacity: 0; pointer-events: none; transition: opacity .2s ease;
  max-width: 80vw; text-align: center;
}
.toast.show { opacity: .95; }
</style>
</head>
<body>
<div class="wrap">
  <h1>云端记忆 · DSH 插件</h1>
  <p class="sub">v${escapeHtml(options.version)} · 每轮结束上报活动计数 · 提供 memory_search / memory_read / memory_add 工具</p>

  <section class="card">
    <h2>当前状态</h2>
    <div class="stats" id="stats"></div>
    <div class="tip" id="statDetail">加载中…</div>
  </section>

  <section class="card">
    <h2>连接配置</h2>
    <div class="grid">
      <div>
        <label for="baseUrl">服务基址</label>
        <input id="baseUrl" type="text" spellcheck="false" placeholder="https://your-memory-host/api/longmemory" />
        <div class="hint">不带结尾斜杠，路径为 /api/longmemory。</div>
      </div>
      <div>
        <label for="clientId">客户端标识 client_id</label>
        <input id="clientId" type="text" spellcheck="false" placeholder="dsh-desktop" />
        <div class="hint">上报时附带，便于区分来源设备。</div>
      </div>
      <div>
        <label for="requestTimeoutMs">请求超时（毫秒）</label>
        <input id="requestTimeoutMs" type="number" min="1000" max="60000" step="500" />
      </div>
      <div>
        <label for="defaultK">默认检索条数</label>
        <input id="defaultK" type="number" min="1" max="100" />
      </div>
    </div>
    <div class="row" style="margin-top:14px">
      <label style="margin:0;display:flex;align-items:center;gap:8px;font-size:13px;font-weight:500">
        <input id="enabled" type="checkbox" style="width:auto" /> 启用插件（关闭后不上报、不提供工具）
      </label>
    </div>
  </section>

  <section class="card">
    <h2>账号登录</h2>
    <div class="grid">
      <div>
        <label for="username">用户名</label>
        <input id="username" type="text" spellcheck="false" autocomplete="username" placeholder="云端面板的账号" />
      </div>
      <div>
        <label for="password">密码</label>
        <input id="password" type="password" spellcheck="false" autocomplete="current-password" placeholder="只用于本次换取令牌" />
      </div>
    </div>
    <div class="row" style="margin-top:14px">
      <button class="primary" id="login">登录并获取令牌</button>
    </div>
    <div class="tip">
      用云端面板的普通用户账号登录，插件会用一次性会话换取 <code>activity:write</code> 与 <code>memory:write</code> 两个令牌并写入本机。
      密码只在这一次请求里使用：不保存、不写日志、不回显，换取成功后立即从内存丢弃。
      管理员账号不能创建个人令牌，请用普通用户账号。
    </div>
  </section>

  <section class="card">
    <h2>访问令牌</h2>
    <div class="grid">
      <div>
        <label for="activityToken">活动上报令牌（activity:write）</label>
        <input id="activityToken" type="password" spellcheck="false" autocomplete="off" placeholder="留空表示不修改" />
        <div class="hint" id="activityTokenHint">用于 POST /activity/turn。</div>
      </div>
      <div>
        <label for="memoryToken">记忆读写令牌（memory:write）</label>
        <input id="memoryToken" type="password" spellcheck="false" autocomplete="off" placeholder="留空表示不修改" />
        <div class="hint" id="memoryTokenHint">memory:write 同时允许读取，一个令牌即可覆盖检索与写入；只有 memory:read 时写入会被拒。</div>
      </div>
    </div>
    <div class="row" style="margin-top:14px">
      <button class="primary" id="save">保存配置</button>
      <button id="clearTokens">清除已存令牌</button>
    </div>
    <div class="tip">
      在面板「设置 → API 密钥」里各建一个 <code>activity:write</code> 与 <code>memory:write</code> 密钥（一个密钥只有一种权限，所以需要两个）。<br />
      令牌只写入本机 <code>${escapeHtml(options.settingsPath)}</code>（进程退出不丢），不会进入会话上下文、不会上传到云端、也不会出现在本页回显里。
    </div>
  </section>

  <section class="card">
    <h2>诊断</h2>
    <div class="row">
      <button id="test">测试连接</button>
      <button id="flush">重试上报队列</button>
      <button id="reload">刷新</button>
    </div>
    <div class="tip" id="testResult"></div>
  </section>

  <section class="card">
    <h2>最近上报</h2>
    <table>
      <thead>
        <tr><th>时间</th><th>状态</th><th>结果</th><th>HTTP</th><th>turn_id</th></tr>
      </thead>
      <tbody id="recent"><tr><td colspan="5" class="muted">暂无记录</td></tr></tbody>
    </table>
  </section>
</div>
<div class="toast" id="toast"></div>
<script>
(function () {
  'use strict';
  var state = { view: null };

  function el(id) { return document.getElementById(id); }

  function toast(text) {
    var node = el('toast');
    node.textContent = text;
    node.classList.add('show');
    clearTimeout(toast._timer);
    toast._timer = setTimeout(function () { node.classList.remove('show'); }, 2600);
  }

  function pill(kind, text) {
    return '<span class="pill ' + kind + '">' + text + '</span>';
  }

  function fmtTime(ms) {
    if (typeof ms !== 'number' || !isFinite(ms)) return '—';
    var d = new Date(ms);
    var pad = function (n) { return String(n).padStart(2, '0'); };
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' +
      pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
  }

  function render(view) {
    state.view = view;
    var settings = view.settings || {};
    var tokens = view.tokens || {};
    var reporter = view.reporter || {};

    el('baseUrl').value = settings.baseUrl || '';
    el('clientId').value = settings.clientId || '';
    el('requestTimeoutMs').value = settings.requestTimeoutMs || '';
    el('defaultK').value = settings.defaultK || '';
    el('enabled').checked = settings.enabled === true;

    el('activityTokenHint').innerHTML = '用于 POST /activity/turn。当前 ' +
      (tokens.activity && tokens.activity.configured
        ? pill('ok', '已配置 ' + tokens.activity.masked)
        : pill('bad', '未配置'));
    el('memoryTokenHint').innerHTML = '用于记忆检索、读取与写入工具。当前 ' +
      (tokens.memory && tokens.memory.configured
        ? pill('ok', '已配置 ' + tokens.memory.masked)
        : pill('bad', '未配置'));

    var stats = [
      ['上报成功', reporter.recorded || 0],
      ['重复忽略', reporter.duplicate || 0],
      ['失败', reporter.failed || 0],
      ['已跳过', reporter.skipped || 0],
      ['待重试', reporter.queued || 0]
    ];
    el('stats').innerHTML = stats.map(function (pair) {
      return '<div class="stat"><div class="k">' + pair[0] + '</div><div class="v">' + pair[1] + '</div></div>';
    }).join('');

    var detail = [];
    detail.push(settings.enabled ? pill('ok', '插件已启用') : pill('warn', '插件已禁用'));
    detail.push('最近一次成功上报：' + fmtTime(reporter.lastSentAt));
    if (reporter.lastError) detail.push(pill('bad', '最近错误：' + reporter.lastError));
    detail.push('配置文件：<code>' + (view.settingsPath || '') + '</code>');
    el('statDetail').innerHTML = detail.join(' · ');

    var recent = reporter.recent || [];
    if (recent.length === 0) {
      el('recent').innerHTML = '<tr><td colspan="5" class="muted">暂无记录</td></tr>';
      return;
    }
    el('recent').innerHTML = recent.slice(0, 12).map(function (row) {
      var outcome = row.outcome === 'recorded' ? pill('ok', '已记录')
        : row.outcome === 'duplicate' ? pill('sk', '重复')
        : row.outcome === 'queued' ? pill('warn', '待重试')
        : row.outcome === 'skipped' ? pill('sk', '跳过')
        : pill('bad', '失败');
      var status = row.status === 'completed' ? pill('ok', 'completed')
        : row.status === 'failed' ? pill('bad', 'failed')
        : pill('warn', String(row.status || '—'));
      var turn = String(row.turnId || '');
      if (turn.length > 46) turn = turn.slice(0, 46) + '…';
      var tip = row.error ? ' title="' + String(row.error).replace(/"/g, '&quot;') + '"' : '';
      return '<tr' + tip + '><td>' + fmtTime(row.at) + '</td><td>' + status + '</td><td>' + outcome +
        '</td><td>' + (row.httpStatus == null ? '—' : row.httpStatus) + '</td><td><code>' + turn + '</code></td></tr>';
    }).join('');
  }

  function load() {
    return fetch('/cloud-memory/status', { headers: { accept: 'application/json' } })
      .then(function (res) { return res.json(); })
      .then(function (body) {
        if (!body || body.ok !== true) throw new Error((body && body.error) || 'status failed');
        render(body);
      })
      .catch(function (error) { toast('读取状态失败：' + error.message); });
  }

  function save() {
    var patch = {
      baseUrl: el('baseUrl').value.trim(),
      clientId: el('clientId').value.trim(),
      requestTimeoutMs: Number(el('requestTimeoutMs').value),
      defaultK: Number(el('defaultK').value),
      enabled: el('enabled').checked
    };
    var activity = el('activityToken').value.trim();
    var memory = el('memoryToken').value.trim();
    if (activity !== '') patch.activityToken = activity;
    if (memory !== '') patch.memoryToken = memory;
    fetch('/cloud-memory/config', {
      method: 'PUT',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(patch)
    }).then(function (res) { return res.json(); }).then(function (body) {
      if (!body || body.ok !== true) { toast('保存失败：' + ((body && body.error) || 'unknown')); return; }
      el('activityToken').value = '';
      el('memoryToken').value = '';
      render(body);
      toast('已保存');
    }).catch(function (error) { toast('保存失败：' + error.message); });
  }

  function test() {
    var node = el('testResult');
    node.textContent = '测试中…';
    fetch('/cloud-memory/test', { method: 'POST', headers: { accept: 'application/json' } })
      .then(function (res) { return res.json(); })
      .then(function (body) {
        if (!body || body.ok !== true) { node.textContent = '测试失败：' + ((body && body.error) || 'unknown'); return; }
        var lines = [];
        lines.push((body.activity && body.activity.ok ? '✅ ' : '❌ ') + '活动令牌：' + (body.activity && body.activity.message));
        lines.push((body.memory && body.memory.ok ? '✅ ' : '❌ ') + '记忆令牌：' + (body.memory && body.memory.message));
        node.innerHTML = lines.join('<br />');
      })
      .catch(function (error) { node.textContent = '测试失败：' + error.message; });
  }

  function flush() {
    fetch('/cloud-memory/flush', { method: 'POST', headers: { accept: 'application/json' } })
      .then(function (res) { return res.json(); })
      .then(function (body) {
        if (!body || body.ok !== true) { toast('重试失败：' + ((body && body.error) || 'unknown')); return; }
        toast('已补发 ' + body.sent + ' 条，剩余 ' + body.remaining + ' 条');
        return load();
      })
      .catch(function (error) { toast('重试失败：' + error.message); });
  }

  function clearTokens() {
    fetch('/cloud-memory/config', {
      method: 'PUT',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ clearActivityToken: true, clearMemoryToken: true })
    }).then(function (res) { return res.json(); }).then(function (body) {
      if (!body || body.ok !== true) { toast('清除失败：' + ((body && body.error) || 'unknown')); return; }
      render(body);
      toast('已清除本地令牌');
    }).catch(function (error) { toast('清除失败：' + error.message); });
  }

  function login() {
    var username = el('username').value.trim();
    var password = el('password').value;
    if (username === '' || password === '') { toast('请填写用户名和密码'); return; }
    fetch('/cloud-memory/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ username: username, password: password })
    }).then(function (res) { return res.json(); }).then(function (body) {
      if (!body || body.ok !== true) { toast('登录失败：' + ((body && body.error) || 'unknown')); return; }
      el('password').value = '';
      render(body);
      var warning = body.login && body.login.warning ? '（' + body.login.warning + '）' : '';
      toast('登录成功，已自动写入两个令牌' + warning);
    }).catch(function (error) { toast('登录失败：' + error.message); });
  }

  el('save').addEventListener('click', save);
  el('login').addEventListener('click', login);
  el('test').addEventListener('click', test);
  el('flush').addEventListener('click', flush);
  el('clearTokens').addEventListener('click', clearTokens);
  el('reload').addEventListener('click', function () { load(); toast('已刷新'); });
  load();
  setInterval(load, 15000);
})();
</script>
</body>
</html>`
}
