#!/usr/bin/env node
/**
 * release-prep: 发布前一次性整备（脱敏 + package.json 元数据 + LICENSE）。
 *
 *   node scripts/release-prep.mjs --dry-run   只报告将要改什么
 *   node scripts/release-prep.mjs             原地写入
 *
 * 幂等：重复执行不会有二次改动。必须在插件目录（含 package.json 那一层）执行。
 * 用 Node 而不是 PowerShell，避开发行策略限制，并且能把 package.json 写成无 BOM 的 UTF-8。
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const DRY = process.argv.includes('--dry-run')
const pkgPath = join(ROOT, 'package.json')

if (!existsSync(pkgPath)) throw new Error(`没有找到 ${pkgPath} —— 请在 dsh-plugin 目录里执行。`)
const changes = []
const write = (path, text, why) => {
  changes.push(`${why} → ${path.slice(ROOT.length + 1)}`)
  if (!DRY) writeFileSync(path, text, 'utf8')
}

/** 1. 脱敏：个人域名与本机路径。src 也要改，否则下次构建会把域名写回 lib。 */
const REDACTIONS = [
  ['https://mem.qyhhh.top/api/longmemory', 'https://your-memory-host/api/longmemory', '替换个人域名'],
  ['C:\\Users\\qyh15\\云端记忆系统\\dsh-plugin', 'D:\\path\\to\\dsh-plugin', '抹掉本机安装路径'],
  ['C:/Users/qyh15/云端记忆系统/dsh-plugin', 'D:/path/to/dsh-plugin', '抹掉 link 里的本机路径'],
  ['C:\\Users\\qyh15\\.dsh\\cloud-memory.json', '%USERPROFILE%\\.dsh\\cloud-memory.json', '抹掉令牌文件路径'],
]
for (const rel of ['cordis.patch.yml', 'README.md', 'lib/config.js', 'lib/page.js', 'src/config.ts', 'src/page.ts']) {
  const path = join(ROOT, rel)
  if (!existsSync(path)) continue
  let text = readFileSync(path, 'utf8')
  let touched = false
  for (const [from, to, why] of REDACTIONS) {
    if (!text.includes(from)) continue
    text = text.split(from).join(to)
    touched = true
    changes.push(`${why} → ${rel}`)
  }
  if (touched && !DRY) writeFileSync(path, text, 'utf8')
}

/** 2. package.json 元数据。 */
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
const before = JSON.stringify(pkg)
const add = []
if (pkg.name !== 'dsh-cloud-memory') throw new Error(`package.json 的 name 是 ${pkg.name}，疑似跑错目录，已中止。`)

if ('private' in pkg) {
  delete pkg.private
  add.push('去掉 private:true（npm 会直接拒绝发布）')
}
if (!pkg.publishConfig) {
  pkg.publishConfig = { registry: 'https://registry.npmjs.org/', access: 'public' }
  add.push('加 publishConfig（registry + access public）')
}
if (!pkg.keywords) {
  pkg.keywords = ['dsh', 'dsh-plugin', 'memory', 'cloud-memory', 'longmemory', 'agent']
  add.push('加 keywords')
}
if (!pkg.author) {
  pkg.author = 'dsh-cloud-memory contributors'
  add.push('加 author（中性署名，可换成你自己的名字与邮箱）')
}
pkg.scripts ??= {}
if (pkg.scripts.prepack !== 'tsc -p tsconfig.build.json') {
  pkg.scripts.prepack = 'tsc -p tsconfig.build.json'
  add.push('加 prepack 构建（保证 lib/ 与 src/ 同步）')
}
if (pkg.scripts.prepublishOnly !== 'node scripts/pack-guard.mjs') {
  pkg.scripts.prepublishOnly = 'node scripts/pack-guard.mjs'
  add.push('加 prepublishOnly 闸门（笔记/探测脚本/个人信息一律拦下）')
}
pkg.files ??= []
if (!pkg.files.includes('LICENSE')) {
  pkg.files.push('LICENSE')
  add.push('files 增加 LICENSE')
}
if (JSON.stringify(pkg) !== before) {
  write(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`, 'package.json 更新')
  changes.push(...add)
}

/** 3. LICENSE。 */
const licensePath = join(ROOT, 'LICENSE')
if (!existsSync(licensePath)) {
  write(
    licensePath,
    `MIT License

Copyright (c) 2026 dsh-cloud-memory contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
`,
    '新建 MIT LICENSE',
  )
}

/** 4. 报告。 */
if (!changes.length) {
  console.log('release-prep: 没有需要改动的内容 —— 已是发布就绪状态。')
} else {
  console.log(`release-prep: ${DRY ? '将改动' : '已改动'} ${changes.length} 项`)
  for (const c of changes) console.log(`  · ${c}`)
}
console.log('\n下一步：pnpm run build → node scripts/pack-guard.mjs → pnpm login → pnpm publish --access public --no-git-checks')
console.log('注意：发布不可撤销，0.1.0 一旦发布就不能再改同号。')
