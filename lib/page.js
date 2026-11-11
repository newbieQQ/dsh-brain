/**
 * Standalone configuration page.
 *
 * This profile runs with the native settings surface disabled
 * (`ui-settings` is turned off in `cordis.patch.yml`), so the plugin ships its
 * own HTML page at `/dsh-brain`. It is deliberately dependency-free: no
 * bundler assets, no CDN, no fonts — one file the host web server can emit.
 *
 * The page renders tokens as masked values only; the plaintext never leaves
 * `$DSH_HOME/dsh-brain.json`.
 */
/** Escape a value for safe interpolation into HTML text/attributes. */
export function escapeHtml(value) {
    return value
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#39;');
}
/** Render the configuration page. */
export function renderConfigPage(options) {
    // The client script is plain ES2020 and avoids template literals so this
    // outer template stays readable.
    return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>DSH Brain · 云端记忆</title>
<style>
:root {
  color-scheme: light dark;
  --bg: #f4f5fa; --card: #ffffff; --ink: #191c22; --ink2: #5b6472; --ink3: #8a93a3;
  --line: #e4e7f0; --field: #fbfbfe; --field-line: #d8dce8;
  --brand: #6366f1; --brand2: #8b5cf6; --brand-ink: #4f46e5;
  --shadow: 0 1px 2px rgba(23, 25, 60, .04), 0 8px 24px -12px rgba(23, 25, 60, .12);
  --ok-bg: #e5f7ec; --ok: #177245; --bad-bg: #fdecec; --bad: #b3261e;
  --warn-bg: #fff4d6; --warn: #8a5a00; --sk-bg: #edf0f6; --sk: #55606d;
  --code-bg: #eef0f7; --track: #d5d9e6;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #101218; --card: #171a21; --ink: #e8eaf0; --ink2: #a3abb9; --ink3: #767f8f;
    --line: #262b36; --field: #12151c; --field-line: #313947;
    --brand-ink: #a5b4fc; --shadow: 0 1px 2px rgba(0,0,0,.4), 0 10px 28px -12px rgba(0,0,0,.5);
    --ok-bg: #123324; --ok: #4ade80; --bad-bg: #3d1a17; --bad: #f28b82;
    --warn-bg: #3a2f10; --warn: #fbbf24; --sk-bg: #232833; --sk: #9aa3af;
    --code-bg: #22262f; --track: #39415a;
  }
}
* { box-sizing: border-box; }
body {
  margin: 0; padding: 40px 24px 56px;
  font: 14px/1.65 -apple-system, "Segoe UI", "Microsoft YaHei", system-ui, sans-serif;
  color: var(--ink);
  background:
    radial-gradient(720px 300px at 12% -60px, rgba(99,102,241,.13), transparent 70%),
    radial-gradient(640px 280px at 88% -40px, rgba(139,92,246,.10), transparent 70%),
    var(--bg);
  background-attachment: fixed;
}
.wrap { max-width: 1020px; margin: 0 auto; }
a { color: var(--brand-ink); text-decoration: none; }
a:hover { text-decoration: underline; }

/* ---------- masthead ---------- */
.masthead { display: flex; align-items: center; gap: 16px; margin-bottom: 8px; }
.logo {
  width: 54px; height: 54px; border-radius: 16px; flex: none;
  display: flex; align-items: center; justify-content: center; font-size: 28px;
  background: linear-gradient(135deg, var(--brand), var(--brand2));
  box-shadow: 0 8px 20px -6px rgba(99,102,241,.55);
}
.masthead h1 { font-size: 24px; margin: 0; letter-spacing: .2px; line-height: 1.25; }
.masthead h1 .thin { font-weight: 500; color: var(--ink2); }
.ver {
  font-size: 11.5px; font-weight: 600; color: var(--brand-ink);
  background: color-mix(in srgb, var(--brand) 12%, transparent);
  padding: 2px 9px; border-radius: 999px; vertical-align: 3px; margin-left: 8px; white-space: nowrap;
}
.tagline { margin: 2px 0 0; color: var(--ink2); font-size: 13px; }
.mast-actions { margin-left: auto; flex: none; }
.btn-link {
  display: inline-flex; align-items: center; gap: 7px;
  padding: 9px 16px; border-radius: 999px; font-size: 13px; font-weight: 600;
  color: #fff; background: linear-gradient(135deg, var(--brand), var(--brand2));
  box-shadow: 0 6px 16px -6px rgba(99,102,241,.6);
}
.btn-link:hover { text-decoration: none; filter: brightness(1.06); }
.rule { height: 3px; border-radius: 3px; margin: 18px 0 22px;
  background: linear-gradient(90deg, var(--brand), var(--brand2), transparent 75%); opacity: .55; }

/* ---------- cards ---------- */
.card {
  background: var(--card); border: 1px solid var(--line); border-radius: 16px;
  padding: 22px 24px; margin-bottom: 16px; box-shadow: var(--shadow);
}
.card-head { display: flex; align-items: center; gap: 11px; margin-bottom: 16px; }
.chip {
  width: 32px; height: 32px; border-radius: 10px; flex: none; font-size: 16px;
  display: flex; align-items: center; justify-content: center;
  background: color-mix(in srgb, var(--brand) 12%, transparent);
}
.card-head h2 { font-size: 15px; margin: 0; font-weight: 650; letter-spacing: .2px; }
.card-head .desc { margin-left: auto; font-size: 12px; color: var(--ink3); text-align: right; }

/* ---------- forms ---------- */
.grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px 20px; }
@media (max-width: 720px) { .grid { grid-template-columns: 1fr; } }
label { display: block; font-size: 12.5px; font-weight: 600; color: var(--ink2); margin-bottom: 6px; }
input[type=text], input[type=password], input[type=number] {
  width: 100%; padding: 10px 12px; font: inherit; font-size: 13.5px;
  border: 1px solid var(--field-line); border-radius: 10px; background: var(--field); color: var(--ink);
  transition: border-color .15s ease, box-shadow .15s ease;
}
input:focus { outline: none; border-color: var(--brand); box-shadow: 0 0 0 3px color-mix(in srgb, var(--brand) 22%, transparent); }
.hint { font-size: 12px; color: var(--ink3); margin-top: 6px; }
.muted { color: var(--ink3); }
.row { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
.tip { margin-top: 14px; font-size: 12.5px; color: var(--ink2); }
code { font-family: ui-monospace, SFMono-Regular, Consolas, monospace; font-size: 12px; background: var(--code-bg); padding: 1px 6px; border-radius: 5px; }

/* ---------- toggles ---------- */
.toggles { margin-top: 18px; border-top: 1px dashed var(--line); padding-top: 6px; }
.toggle { display: flex; align-items: center; gap: 12px; padding: 10px 2px; cursor: pointer; margin: 0; }
.toggle input { position: absolute; opacity: 0; width: 0; height: 0; }
.toggle .track {
  width: 40px; height: 22px; border-radius: 999px; flex: none; position: relative;
  background: var(--track); transition: background .18s ease;
}
.toggle .track::after {
  content: ""; position: absolute; top: 3px; left: 3px; width: 16px; height: 16px; border-radius: 50%;
  background: #fff; box-shadow: 0 1px 3px rgba(0,0,0,.3); transition: transform .18s ease;
}
.toggle input:checked + .track { background: linear-gradient(135deg, var(--brand), var(--brand2)); }
.toggle input:checked + .track::after { transform: translateX(18px); }
.toggle input:focus-visible + .track { box-shadow: 0 0 0 3px color-mix(in srgb, var(--brand) 30%, transparent); }
.toggle .ttitle { display: block; font-size: 13.5px; font-weight: 600; color: var(--ink); }
.toggle .tdesc { display: block; font-size: 12px; color: var(--ink3); font-weight: 400; }
.inline-field { display: flex; align-items: center; gap: 12px; padding: 8px 2px 2px; }
.inline-field label { margin: 0; font-size: 13.5px; font-weight: 600; color: var(--ink); }
.inline-field input { max-width: 150px; }

/* ---------- buttons ---------- */
button {
  font: inherit; font-size: 13.5px; font-weight: 550; padding: 9px 18px; border-radius: 10px;
  border: 1px solid var(--field-line); background: var(--card); color: var(--ink); cursor: pointer;
  transition: all .15s ease;
}
button:hover { border-color: var(--brand); color: var(--brand-ink); transform: translateY(-1px); }
button.primary {
  background: linear-gradient(135deg, var(--brand), var(--brand2)); border: none; color: #fff;
  box-shadow: 0 6px 16px -6px rgba(99,102,241,.55); padding: 10px 20px;
}
button.primary:hover { color: #fff; filter: brightness(1.07); }
button:disabled { opacity: .55; cursor: default; transform: none; }

/* ---------- stats ---------- */
.stats { display: flex; flex-wrap: wrap; gap: 10px; }
.stat {
  flex: 1 1 118px; border: 1px solid var(--line); border-radius: 12px; padding: 12px 14px 10px;
  background: linear-gradient(180deg, color-mix(in srgb, var(--brand) 4%, transparent), transparent 65%);
  position: relative; overflow: hidden;
}
.stat::before { content: ""; position: absolute; top: 0; left: 0; right: 0; height: 3px;
  background: linear-gradient(90deg, var(--brand), var(--brand2)); opacity: .35; }
.stat:nth-child(3)::before, .stat:nth-child(7)::before { background: linear-gradient(90deg, #f59e0b, #ef4444); }
.stat .k { font-size: 11.5px; letter-spacing: .5px; color: var(--ink3); font-weight: 600; }
.stat .v { font-size: 21px; font-weight: 700; margin-top: 1px; font-variant-numeric: tabular-nums; }

/* ---------- pills / table ---------- */
.pill { display: inline-block; padding: 1.5px 9px; border-radius: 999px; font-size: 11.5px; font-weight: 600; }
.ok { background: var(--ok-bg); color: var(--ok); }
.bad { background: var(--bad-bg); color: var(--bad); }
.warn { background: var(--warn-bg); color: var(--warn); }
.sk { background: var(--sk-bg); color: var(--sk); }
.table-wrap { border: 1px solid var(--line); border-radius: 12px; overflow: hidden; }
table { width: 100%; border-collapse: collapse; font-size: 12.5px; }
th { text-align: left; font-size: 11px; letter-spacing: .6px; color: var(--ink3); font-weight: 600;
  padding: 9px 12px; background: color-mix(in srgb, var(--brand) 5%, transparent); }
td { padding: 8px 12px; border-top: 1px solid var(--line); vertical-align: top; }
tbody tr:hover td { background: color-mix(in srgb, var(--brand) 4%, transparent); }

.foot { text-align: center; color: var(--ink3); font-size: 12px; margin-top: 26px; }
.toast {
  position: fixed; left: 50%; bottom: 26px; transform: translateX(-50%);
  background: #1c1f23; color: #fff; padding: 11px 20px; border-radius: 999px;
  font-size: 13px; opacity: 0; pointer-events: none; transition: opacity .2s ease;
  max-width: 80vw; text-align: center; box-shadow: 0 12px 32px rgba(0,0,0,.3); z-index: 10;
}
.toast.show { opacity: .97; }
</style>
</head>
<body>
<div class="wrap">
  <header class="masthead">
    <div class="logo">🧠</div>
    <div>
      <h1>DSH Brain<span class="thin"> · 云端记忆</span><span class="ver">v${escapeHtml(options.version)}</span></h1>
      <p class="tagline">每轮结束上报活动计数 · 提供 memory_search / memory_read / memory_add 工具</p>
    </div>
    <div class="mast-actions">
      <a class="btn-link" href="/dsh-brain/skills">技能管理 →</a>
    </div>
  </header>
  <div class="rule"></div>

  <section class="card">
    <div class="card-head"><span class="chip">📊</span><h2>当前状态</h2><span class="desc">每 15 秒自动刷新</span></div>
    <div class="stats" id="stats"></div>
    <div class="tip" id="statDetail">加载中…</div>
  </section>

  <section class="card">
    <div class="card-head"><span class="chip">🔌</span><h2>连接配置</h2></div>
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
    <div class="toggles">
      <label class="toggle" for="enabled">
        <input id="enabled" type="checkbox" />
        <span class="track"></span>
        <span><span class="ttitle">启用插件</span><span class="tdesc">关闭后不上报、不提供工具</span></span>
      </label>
      <label class="toggle" for="summaryEnabled">
        <input id="summaryEnabled" type="checkbox" />
        <span class="track"></span>
        <span><span class="ttitle">轮次结束后自动生成待确认摘要</span><span class="tdesc">只进入待确认队列，确认后才写云端</span></span>
      </label>
      <div class="inline-field">
        <label for="summaryMaxChars">单轮摘要字数上限</label>
        <input id="summaryMaxChars" type="number" min="1000" max="16000" step="500" />
      </div>
    </div>
  </section>

  <section class="card">
    <div class="card-head"><span class="chip">🔑</span><h2>账号登录</h2><span class="desc">用账号一次性换取令牌，密码不保存</span></div>
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
    <div class="row" style="margin-top:16px">
      <button class="primary" id="login">登录并获取令牌</button>
    </div>
    <div class="tip">
      用云端面板的普通用户账号登录，插件会用一次性会话换取 <code>activity:write</code> 与 <code>memory:write</code> 两个令牌并写入本机。
      密码只在这一次请求里使用：不保存、不写日志、不回显，换取成功后立即从内存丢弃。
      管理员账号不能创建个人令牌，请用普通用户账号。
    </div>
  </section>

  <section class="card">
    <div class="card-head"><span class="chip">🎫</span><h2>访问令牌</h2><span class="desc">只存本机，页面只显示掩码</span></div>
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
      <div>
        <label for="summaryToken">对话摘要令牌（summary:write，可选）</label>
        <input id="summaryToken" type="password" spellcheck="false" autocomplete="off" placeholder="留空表示不修改" />
        <div class="hint" id="summaryTokenHint">用于 POST /activity/summary：只把已脱敏摘要送进待确认队列。</div>
      </div>
    </div>
    <div class="row" style="margin-top:16px">
      <button class="primary" id="save">保存配置</button>
      <button id="clearTokens">清除已存令牌</button>
    </div>
    <div class="tip">
      在面板「设置 → API 密钥」里各建一个 <code>activity:write</code> 与 <code>memory:write</code> 密钥（一个密钥只有一种权限，所以需要两个）。<br />
      令牌只写入本机 <code>${escapeHtml(options.settingsPath)}</code>（进程退出不丢），不会进入会话上下文、不会上传到云端、也不会出现在本页回显里。
    </div>
  </section>

  <section class="card">
    <div class="card-head"><span class="chip">🩺</span><h2>诊断</h2></div>
    <div class="row">
      <button id="test">测试连接</button>
      <button id="flush">重试上报队列</button>
      <button id="reload">刷新</button>
    </div>
    <div class="tip" id="testResult"></div>
  </section>

  <section class="card">
    <div class="card-head"><span class="chip">🕘</span><h2>最近上报</h2></div>
    <div class="table-wrap">
      <table>
        <thead>
          <tr><th>时间</th><th>状态</th><th>结果</th><th>HTTP</th><th>turn_id</th></tr>
        </thead>
        <tbody id="recent"><tr><td colspan="5" class="muted">暂无记录</td></tr></tbody>
      </table>
    </div>
  </section>

  <p class="foot">DSH Brain · 云端记忆插件 — 配置只保存在这台机器上</p>
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
    el('summaryEnabled').checked = settings.summaryEnabled === true;
    el('summaryMaxChars').value = settings.summaryMaxChars || '';

    el('activityTokenHint').innerHTML = '用于 POST /activity/turn。当前 ' +
      (tokens.activity && tokens.activity.configured
        ? pill('ok', '已配置 ' + tokens.activity.masked)
        : pill('bad', '未配置'));
    el('memoryTokenHint').innerHTML = '用于记忆检索、读取与写入工具。当前 ' +
      (tokens.memory && tokens.memory.configured
        ? pill('ok', '已配置 ' + tokens.memory.masked)
        : pill('bad', '未配置'));
    el('summaryTokenHint').innerHTML = '用于轮次结束后的自动摘要（只进待确认队列）。当前 ' +
      (tokens.summary && tokens.summary.configured
        ? pill('ok', '已配置 ' + tokens.summary.masked)
        : pill('sk', '未配置，自动摘要不会触发'));

    var stats = [
      ['上报成功', reporter.recorded || 0],
      ['重复忽略', reporter.duplicate || 0],
      ['失败', reporter.failed || 0],
      ['已跳过', reporter.skipped || 0],
      ['待重试', reporter.queued || 0],
      ['摘要待确认', reporter.summaryStaged || 0],
      ['摘要失败', reporter.summaryFailed || 0]
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
    return fetch('/dsh-brain/status', { headers: { accept: 'application/json' } })
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
      enabled: el('enabled').checked,
      summaryEnabled: el('summaryEnabled').checked,
      summaryMaxChars: Number(el('summaryMaxChars').value)
    };
    var activity = el('activityToken').value.trim();
    var memory = el('memoryToken').value.trim();
    var summary = el('summaryToken').value.trim();
    if (activity !== '') patch.activityToken = activity;
    if (memory !== '') patch.memoryToken = memory;
    if (summary !== '') patch.summaryToken = summary;
    fetch('/dsh-brain/config', {
      method: 'PUT',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(patch)
    }).then(function (res) { return res.json(); }).then(function (body) {
      if (!body || body.ok !== true) { toast('保存失败：' + ((body && body.error) || 'unknown')); return; }
      el('activityToken').value = '';
      el('memoryToken').value = '';
      el('summaryToken').value = '';
      render(body);
      toast('已保存');
    }).catch(function (error) { toast('保存失败：' + error.message); });
  }

  function test() {
    var node = el('testResult');
    node.textContent = '测试中…';
    fetch('/dsh-brain/test', { method: 'POST', headers: { accept: 'application/json' } })
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
    fetch('/dsh-brain/flush', { method: 'POST', headers: { accept: 'application/json' } })
      .then(function (res) { return res.json(); })
      .then(function (body) {
        if (!body || body.ok !== true) { toast('重试失败：' + ((body && body.error) || 'unknown')); return; }
        toast('已补发 ' + body.sent + ' 条，剩余 ' + body.remaining + ' 条');
        return load();
      })
      .catch(function (error) { toast('重试失败：' + error.message); });
  }

  function clearTokens() {
    fetch('/dsh-brain/config', {
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
    fetch('/dsh-brain/login', {
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
</html>`;
}
