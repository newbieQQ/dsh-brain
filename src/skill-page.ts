/**
 * The local skill management page (`GET /cloud-memory/skills`).
 *
 * A thin shell: the browser fetches the JSON inventory from
 * `/cloud-memory/skills/api` and renders it; every action is a small
 * JSON POST back to the same prefix. All skill data is inserted with
 * textContent, never as raw HTML.
 */
export function renderSkillsPage(options: { version: string }): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>技能管理 · 云端记忆插件</title>
<style>
  body { font-family: system-ui, -apple-system, "Segoe UI", sans-serif; margin: 0; background: #f6f7f9; color: #1c2333; }
  .wrap { max-width: 880px; margin: 0 auto; padding: 24px 16px 48px; }
  h1 { font-size: 20px; margin: 0 0 4px; }
  .sub { color: #5b6478; font-size: 13px; margin: 0 0 16px; }
  .card { background: #fff; border: 1px solid #e2e6ee; border-radius: 10px; padding: 16px; margin-bottom: 16px; }
  .card h2 { font-size: 15px; margin: 0 0 12px; }
  .row { display: flex; align-items: flex-start; gap: 12px; padding: 10px 0; border-top: 1px solid #eef1f6; }
  .row:first-of-type { border-top: none; }
  .grow { flex: 1; min-width: 0; }
  .name { font-weight: 600; font-size: 14px; }
  .desc { color: #5b6478; font-size: 13px; margin-top: 2px; word-break: break-word; }
  .badge { display: inline-block; font-size: 11px; padding: 1px 7px; border-radius: 999px; background: #eef1f6; color: #44506a; margin-left: 6px; vertical-align: 1px; }
  .badge.off { background: #fdecec; color: #9c2b2b; }
  .badge.cloud { background: #e7f0fe; color: #1c4fa0; }
  button { font-size: 13px; padding: 5px 12px; border-radius: 7px; border: 1px solid #c9d2e3; background: #fff; cursor: pointer; white-space: nowrap; }
  button:hover { background: #f0f3f9; }
  button.danger { border-color: #e3c2c2; color: #9c2b2b; }
  button.primary { background: #1c4fa0; border-color: #1c4fa0; color: #fff; }
  input[type="text"] { flex: 1; font-size: 13px; padding: 7px 10px; border: 1px solid #c9d2e3; border-radius: 7px; min-width: 0; }
  .flex { display: flex; gap: 8px; }
  .msg { font-size: 13px; min-height: 18px; margin-top: 8px; }
  .msg.err { color: #9c2b2b; }
  .empty { color: #8a93a6; font-size: 13px; padding: 8px 0; }
  a { color: #1c4fa0; }
</style>
</head>
<body>
<div class="wrap">
  <h1>技能管理</h1>
  <p class="sub">v${options.version} · 本机技能的列表、启停、安装；删除是真删、不可恢复（云端副本不受影响）。云端同步仍在后台自动进行。<a href="/cloud-memory">← 返回云端记忆设置</a></p>

  <section class="card">
    <h2>从 git 仓库安装</h2>
    <div class="flex">
      <input id="git-url" type="text" placeholder="https://github.com/作者/仓库">
      <button class="primary" id="install-btn">安装</button>
    </div>
    <div class="msg" id="install-msg"></div>
  </section>

  <section class="card">
    <h2>本机技能</h2>
    <div id="skills"></div>
    <div class="msg" id="skills-msg"></div>
  </section>
</div>
<script>
  const $ = (id) => document.getElementById(id);
  function badge(text, cls) {
    const span = document.createElement('span');
    span.className = 'badge' + (cls ? ' ' + cls : '');
    span.textContent = text;
    return span;
  }
  function button(text, cls, onClick) {
    const btn = document.createElement('button');
    if (cls) btn.className = cls;
    btn.textContent = text;
    btn.addEventListener('click', onClick);
    return btn;
  }
  async function post(path, body) {
    const response = await fetch('/cloud-memory/skills' + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.ok === false) throw new Error(data.error || ('HTTP ' + response.status));
    return data;
  }
  async function act(path, body, msgEl) {
    msgEl.textContent = '';
    msgEl.className = 'msg';
    try {
      await post(path, body);
      await load();
    } catch (error) {
      msgEl.textContent = error.message;
      msgEl.className = 'msg err';
    }
  }
  async function load() {
    const response = await fetch('/cloud-memory/skills/api');
    const data = await response.json();
    const skillsBox = $('skills');
    skillsBox.textContent = '';
    if (!data.skills || data.skills.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'empty';
      empty.textContent = '本机还没有技能。云端技能会在同步后自动出现，也可以从上面的仓库安装。';
      skillsBox.appendChild(empty);
    }
    for (const skill of data.skills || []) {
      const row = document.createElement('div');
      row.className = 'row';
      const grow = document.createElement('div');
      grow.className = 'grow';
      const name = document.createElement('div');
      name.className = 'name';
      name.textContent = skill.name;
      name.appendChild(badge(skill.origin === 'cloud' ? '云端' : skill.origin === 'uploaded' ? '本地 · 已传云端' : '本地', skill.origin === 'cloud' ? 'cloud' : ''));
      if (skill.revision) name.appendChild(badge('v' + skill.revision));
      if (!skill.enabled) name.appendChild(badge('已停用', 'off'));
      grow.appendChild(name);
      const desc = document.createElement('div');
      desc.className = 'desc';
      desc.textContent = skill.description || skill.folder;
      grow.appendChild(desc);
      row.appendChild(grow);
      const msg = $('skills-msg');
      row.appendChild(button(skill.enabled ? '停用' : '启用', '', () => act('/toggle', { folder: skill.folder, enabled: !skill.enabled }, msg)));
      row.appendChild(button('删除', 'danger', () => {
        if (window.confirm('真删「' + skill.name + '」？本地文件不可恢复（云端副本不受影响）。')) {
          void act('/remove', { folder: skill.folder }, msg);
        }
      }));
      skillsBox.appendChild(row);
    }
  }
  $('install-btn').addEventListener('click', async () => {
    const msg = $('install-msg');
    const url = $('git-url').value.trim();
    if (!url) { msg.textContent = '先填仓库地址。'; msg.className = 'msg err'; return; }
    msg.textContent = '正在克隆并安装…';
    msg.className = 'msg';
    try {
      const data = await post('/install', { url });
      const parts = [];
      if (data.installed && data.installed.length) parts.push('已安装：' + data.installed.join('、'));
      if (data.skipped && data.skipped.length) parts.push('跳过：' + data.skipped.map((s) => s.name).join('、'));
      msg.textContent = parts.join('；') || '没有装上任何技能。';
      $('git-url').value = '';
      await load();
    } catch (error) {
      msg.textContent = error.message;
      msg.className = 'msg err';
    }
  });
  load().catch((error) => { $('skills-msg').textContent = error.message; $('skills-msg').className = 'msg err'; });
</script>
</body>
</html>
`
}
