#!/usr/bin/env node
/**
 * 扫描本机已装插件，生成 README 里的「兼容的插件」表格。
 *
 * 用法：node scripts/gen-compat.mjs [--profile desktop] [--write]
 *   --write  直接改写 README.md 里 <!-- compat:start --> … <!-- compat:end --> 之间
 *            不加则只打印
 *
 * 判定「有联动」的标准：资料馆为它写了解析/同步逻辑，且本机能读到它的数据。
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os'
import { join } from 'node:path'

const args = process.argv.slice(2)
const write = args.includes('--write')
const profileArg = args.includes('--profile') ? args[args.indexOf('--profile') + 1] : (process.env.DSH_PROFILE || 'desktop')
const home = process.env.DSH_HOME || join(homedir(), '.dsh')
const profileDir = join(home, 'profiles', profileArg)
const repo = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')

const readJson = (p) => {
  try {
    return JSON.parse(readFileSync(p, 'utf8'))
  } catch {
    return null
  }
}
const countFiles = (dir, re) => {
  try {
    return readdirSync(dir).filter((f) => re.test(f)).length
  } catch {
    return 0
  }
}

const pkg = readJson(join(profileDir, 'package.json')) || {}
const bundles = (pkg.dsh && pkg.dsh.profile && pkg.dsh.profile.bundles) || []
const installed = (name) => bundles.includes(name) && existsSync(join(profileDir, 'node_modules', name, 'package.json'))
const versionOf = (name) => {
  const m = readJson(join(profileDir, 'node_modules', name, 'package.json'))
  return m ? String(m.version || '') : ''
}

const rows = []

/* dsh-persona-dafeiyu：人设 */
{
  const file = join(home, 'storages', 'dsh-persona-dafeiyu', 'personas.json')
  const data = readJson(file)
  const userPersonas = data && Array.isArray(data.personas) ? data.personas.length : 0
  let builtin = 0
  const src = join(profileDir, 'node_modules', 'dsh-persona-dafeiyu', 'lib', 'index.js')
  try {
    const text = readFileSync(src, 'utf8')
    const m = text.match(/BUILTIN_PERSONAS\s*=\s*\[([\s\S]*?)\n\]/)
    if (m) builtin = (m[1].match(/\{\s*id:/g) || []).length
  } catch {
    /* 忽略 */
  }
  const total = builtin + userPersonas
  rows.push({
    plugin: 'dsh-persona-dafeiyu',
    label: '人设',
    version: versionOf('dsh-persona-dafeiyu'),
    detail: total ? `内置 ${builtin} · 用户导入 ${userPersonas}` : '',
    ok: total > 0,
    note: total ? '' : '插件已装但没有可读的人设',
  })
}

/* dsh-meme：表情包图集 */
{
  const userDir = join(home, 'meme-packs')
  const pluginDir = join(profileDir, 'node_modules', 'dsh-meme')
  const builtinDir = join(pluginDir, 'memes')
  const userPacks = existsSync(userDir) ? readdirSync(userDir).length : 0
  const builtinPacks = existsSync(builtinDir) ? readdirSync(builtinDir).length : 0
  rows.push({
    plugin: 'dsh-meme',
    label: '表情包图集',
    version: versionOf('dsh-meme'),
    detail: `内置 ${builtinPacks} · 用户 ${userPacks}`,
    ok: builtinPacks + userPacks > 0,
    note: builtinPacks + userPacks ? '面板里可一键切换' : '',
  })
}

/* dsh-whale-widget：鲸鱼图集 / 音效 */
{
  const assets = join(profileDir, 'node_modules', 'dsh-whale-widget', 'assets')
  const imgs = countFiles(assets, /\.(png|gif|webp|jpg)$/i)
  const audios = countFiles(assets, /\.(wav|mp3)$/i)
  const userRoles = existsSync(join(home, 'whale-roles')) ? readdirSync(join(home, 'whale-roles')).length : 0
  const userBubbles = existsSync(join(home, 'whale-bubble-imgs')) ? readdirSync(join(home, 'whale-bubble-imgs')).length : 0
  rows.push({
    plugin: 'dsh-whale-widget',
    label: '鲸鱼图集',
    version: versionOf('dsh-whale-widget'),
    detail: `内置 ${imgs} 图 / ${audios} 音效 · 用户 ${userRoles + userBubbles}`,
    ok: imgs + audios + userRoles + userBubbles > 0,
    note: '插件没有切换接口，给「打开目录」',
  })
}

/* dsh-bigfish：角色包（包内素材缺失，只登记能看到 manifest 的） */
{
  const packsDir = join(profileDir, 'node_modules', 'dsh-bigfish', 'packs')
  const pets = existsSync(join(home, 'pets', 'dsh-bigfish')) ? readdirSync(join(home, 'pets', 'dsh-bigfish')).filter((f) => f.endsWith('.dshpet')).length : 0
  let manifests = 0
  try {
    manifests = readdirSync(packsDir).filter((d) => existsSync(join(packsDir, d, 'manifest.json'))).length
  } catch {
    manifests = 0
  }
  rows.push({
    plugin: 'dsh-bigfish',
    label: '角色包',
    version: versionOf('dsh-bigfish'),
    detail: manifests || pets ? `manifest ${manifests} · 用户角色 ${pets}` : '',
    ok: false,
    note: manifests ? '能读到 manifest，但 npm 包里缺素材图，暂未登记' : '',
  })
}

/* dsh-cost-meter：用量账本（只做说明，不建条目） */
{
  const ledger = join(home, 'storages', 'cost-meter', 'ledger.json')
  const ok = existsSync(ledger)
  rows.push({
    plugin: 'dsh-cost-meter',
    label: '用量账本',
    version: versionOf('dsh-cost-meter'),
    detail: ok ? 'ledger.json 可读' : '',
    ok: false,
    note: '按定位不做系统/账本管理，仅记录可读性',
  })
}

const table = [
  '| 插件 | 联动内容 | 版本 | 本机状态 | 说明 |',
  '| --- | --- | --- | --- | --- |',
  ...rows.map((r) => `| \`${r.plugin}\` | ${r.label} | ${r.version || '-'} | ${r.ok ? '✅ ' + r.detail : '— ' + (r.detail || '')} | ${r.note || ''} |`),
].join('\n')

const block = `<!-- compat:start -->\n### 兼容的插件（脚本生成，勿手改）\n\n${table}\n\n> 重新生成：\`node scripts/gen-compat.mjs --write\`\n<!-- compat:end -->`

console.log(`  扫描 profile: ${profileArg}`)
for (const r of rows) console.log(`   ${r.ok ? '✅' : '·'} ${r.plugin} — ${r.label} ${r.version || ''} ${r.detail}`)

if (write) {
  const readmePath = join(repo, 'README.md')
  const readme = readFileSync(readmePath, 'utf8')
  const start = readme.indexOf('<!-- compat:start -->')
  const end = readme.indexOf('<!-- compat:end -->')
  let next
  if (start >= 0 && end > start) {
    next = readme.slice(0, start) + block + readme.slice(end + '<!-- compat:end -->'.length)
  } else {
    next = readme.trimEnd() + '\n\n' + block + '\n'
  }
  writeFileSync(readmePath, next, 'utf8')
  console.log('  ✅ README 兼容表已更新')
}
