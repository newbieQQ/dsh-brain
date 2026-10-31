#!/usr/bin/env node
/**
 * pack-guard: 发布前白名单 + 脱敏闸门。
 *
 * 在 `pnpm publish` 之前运行（已接进 `prepublishOnly`）：按 package.json 的
 * `files` 白名单解析出「真正会被打进 tarball 的文件」，然后
 *   1) 文件名黑名单：AGENTS.md / TODO.md / HANDOFF.md / PLAN.md / *.mjs / tsconfig* / pnpm-lock.yaml …
 *   2) 内容黑名单：个人域名、本机路径、用户名、令牌形状（cmt_… / _authToken）。
 * 任一条不满足就以 exit 1 中止发布。
 *
 * 纯 fs 实现：不 spawn 子进程，不读网络，不写任何文件。
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

const ROOT = process.cwd()
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))

/** 任何情况下都必须出现在包里的文件（npm 的 always-include 子集）。 */
const ALWAYS = ['package.json', 'README.md', 'LICENSE', 'LICENCE']

/** 文件名黑名单：笔记、规划、构建配置、探测脚本一律不进包。 */
const BANNED_NAMES = [
  /^AGENTS?\.md$/i,
  /^TODO\.md$/i,
  /^TASKS\.md$/i,
  /^HANDOFF\.md$/i,
  /^NOTES?\.md$/i,
  /PLAN\.md$/i,
  /\.mjs$/i,
  /^tsconfig.*\.json$/i,
  /^pnpm-lock\.yaml$/i,
  /^package-lock\.json$/i,
  /^\.npmrc$/i,
  /^\.env(\.|$)/i,
  /\.tgz$/i,
  /\.log$/i,
]

/** 内容黑名单：一旦命中就说明有东西会随包外发。 */
const BANNED_CONTENT = [
  [/mem\.qyhhh\.top/i, '个人域名 mem.qyhhh.top'],
  [/qyh15/i, '本机用户名 qyh15'],
  [/C:[\\/]Users[\\/](?!<user>)(?!%USERPROFILE%)/i, '本机绝对路径 C:\\Users\\…'],
  [/cmt_[A-Za-z0-9_-]{16,}/, '疑似活动令牌原文 cmt_…'],
  [/_authToken/i, 'npm 凭据字段 _authToken'],
]

const TEXT_EXT = /\.(json|md|js|mjs|cjs|ts|tsx|yml|yaml|css|html|txt)$/i
const SKIP_DIRS = new Set(['node_modules', '.git', '.pnpm-store', '.pnpm-cache'])

function walk(entry, out) {
  const abs = join(ROOT, entry)
  let st
  try {
    st = statSync(abs)
  } catch {
    return
  }
  if (st.isDirectory()) {
    for (const name of readdirSync(abs)) {
      if (SKIP_DIRS.has(name)) continue
      walk(join(entry, name), out)
    }
    return
  }
  out.push(entry)
}

/** 真正会进包的文件 = files 白名单展开 + always-include。 */
const files = new Set()
const collected = []
for (const entry of pkg.files ?? []) walk(entry.replace(/^\.\//, ''), collected)
for (const f of collected) files.add(f)
for (const f of ALWAYS) {
  try {
    if (statSync(join(ROOT, f)).isFile()) files.add(f)
  } catch {
    /* 不存在就算了 */
  }
}

const problems = []
for (const file of [...files].sort()) {
  const rel = relative(ROOT, join(ROOT, file)).split(sep).join('/')
  const base = rel.split('/').pop()
  for (const re of BANNED_NAMES) {
    if (re.test(base)) problems.push(`文件名命中黑名单 ${re} → ${rel}`)
  }
  if (!TEXT_EXT.test(rel)) continue
  const text = readFileSync(join(ROOT, rel), 'utf8')
  for (const [re, label] of BANNED_CONTENT) {
    const m = text.match(re)
    if (m) {
      const line = text.slice(0, m.index).split('\n').length
      problems.push(`${rel}:${line} 命中「${label}」→ ${m[0].slice(0, 60)}`)
    }
  }
}

const kb = ([...files].reduce((n, f) => n + statSync(join(ROOT, f)).size, 0) / 1024).toFixed(1)
console.log(`pack-guard: ${files.size} 个文件将被发布，共 ${kb} KB`)
for (const f of [...files].sort()) console.log(`  · ${f}`)

/** 信息项：目录里存在、但不进包的笔记与工程文件 —— 明确告知「已排除」，免得不放心。 */
const NOTEISH = [
  /^AGENTS?\.md$/i,
  /^TODO\.md$/i,
  /^TASKS\.md$/i,
  /^HANDOFF\.md$/i,
  /^NOTES?\.md$/i,
  /PLAN\.md$/i,
  /\.mjs$/i,
  /^tsconfig.*\.json$/i,
  /^pnpm-lock\.yaml$/i,
]
const excluded = []
;(function scan(dir) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue
    const abs = join(dir, name)
    const rel = relative(ROOT, abs).split(sep).join('/')
    if (statSync(abs).isDirectory()) {
      scan(abs)
      continue
    }
    if (files.has(rel)) continue
    if (NOTEISH.some((re) => re.test(name))) excluded.push(rel)
  }
})(ROOT)

if (excluded.length) {
  console.log(`\npack-guard: 以下 ${excluded.length} 个文件在目录里，但不会进包（笔记/工程文件，已排除）：`)
  for (const f of excluded.sort()) console.log(`  – ${f}`)
}

if (problems.length) {
  console.error(`\npack-guard: 发现 ${problems.length} 处不该外发的内容，已中止发布：`)
  for (const p of problems) console.error(`  ✗ ${p}`)
  process.exit(1)
}
console.log('\npack-guard: 白名单与脱敏检查通过')
