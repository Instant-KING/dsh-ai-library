/**
 * 插件资源同步：把已装插件里的「内容」变成资料馆条目。
 *
 * 现在支持：
 *   · dsh-persona-dafeiyu → ~/.dsh/storages/dsh-persona-dafeiyu/personas.json
 *       每个人设写一份 items/personas/<id>.md，条目 kind=persona（人设）
 *   · dsh-meme 的图集（builtin + ~/.dsh/meme-packs）
 *       每个图集一条 kind=meme-pack 记录，注明图集 id / 张数 / 位置
 *
 * 设计原则：
 *   - 幂等：按固定 id upsert，重复同步不产生重复条目
 *   - 只读源插件：绝不改插件自己的数据，只往资料馆写
 *   - 失败不抛：某个插件读不到就跳过，返回 warnings
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

/** 插件产物对应的资料馆 kind。 */
export const SYNC_KINDS = {
  persona: 'persona',
  memePack: 'meme-pack',
  usage: 'usage',
  pet: 'pet',
}

/** 已支持同步的插件（用于面板展示「能同步什么」）。 */
export const SUPPORTED = [
  { id: 'dsh-persona-dafeiyu', label: '人设', kind: 'persona' },
  { id: 'dsh-bigfish', label: '角色包', kind: 'pet' },
  { id: 'dsh-whale-widget', label: '鲸鱼图集', kind: 'whale-pack' },
]

function today() {
  return new Date().toISOString().slice(0, 10)
}

/** 读 JSON，失败返回 null。 */
function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

/** 取人设正文里的第一段普通文字，做摘要。 */
function firstLine(text, limit = 90) {
  const lines = String(text || '')
    .split('\n')
    .map((x) => x.trim())
  for (const line of lines) {
    if (!line) continue
    if (line.startsWith('#')) continue
    if (line.startsWith('>')) continue
    return line.slice(0, limit)
  }
  return ''
}

/**
 * 检测 profile 里装了哪些插件。
 * @param {object} opts
 * @param {string} [opts.profile] profile 名（默认取 DSH_PROFILE 或 desktop）
 * @returns {{ profile: string, bundles: string[], installed: Array<{name:string, version:string}> }}
 */
export function detectInstalledPlugins({ profile } = {}) {
  const name = String(profile || process.env.DSH_PROFILE || 'desktop')
  const dir = join(homedir(), '.dsh', 'profiles', name)
  const pkg = readJson(join(dir, 'package.json')) || {}
  const bundles = (pkg.dsh && pkg.dsh.profile && pkg.dsh.profile.bundles) || []
  const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) }
  const installed = []
  for (const [dep, range] of Object.entries(deps)) {
    const meta = readJson(join(dir, 'node_modules', dep, 'package.json'))
    if (!meta) continue
    installed.push({ name: dep, version: String(meta.version || ''), range: String(range || ''), inBundles: bundles.includes(dep) })
  }
  return { profile: name, bundles, installed }
}


/**
 * 从 dsh-persona-dafeiyu 的宿主代码里抽取**内置人设**。
 * 这些是硬编码在插件里的（大肥鱼 / 阿茶 / 听澜），不落 personas.json，
 * 所以要按源码结构解析：`const BUNDLED_X = \`...\`` + `BUILTIN_PERSONAS = [{ id, name, description, text: BUNDLED_X }]`。
 * @param {string} pluginDir
 * @returns {Array<{id:string,name:string,description:string,text:string,builtin:boolean}>}
 */
function extractBuiltinPersonas(pluginDir) {
  const out = []
  let src = ''
  try {
    src = readFileSync(join(pluginDir, 'lib', 'index.js'), 'utf8')
  } catch {
    return out
  }

  /* ① 收集 `const BUNDLED_X = \`...\`` 的正文 */
  const bundled = new Map()
  const reConst = /const (BUNDLED_[A-Z0-9_]+) = `/g
  let m
  while ((m = reConst.exec(src)) !== null) {
    const name = m[1]
    const start = m.index + m[0].length
    const end = src.indexOf('`', start)
    if (end < 0) continue
    bundled.set(name, src.slice(start, end))
  }

  /* ② 收集 BUILTIN_PERSONAS 数组项 */
  const arrStart = src.indexOf('BUILTIN_PERSONAS')
  if (arrStart < 0) return out
  const slice = src.slice(arrStart, arrStart + 40000)
  const reItem = /\{\s*id:\s*'([^']+)',\s*name:\s*'([^']+)',\s*description:\s*'([^']*)',\s*text:\s*(BUNDLED_[A-Z0-9_]+)/g
  let it
  while ((it = reItem.exec(slice)) !== null) {
    const [, id, name, description, constName] = it
    const text = bundled.get(constName) || ''
    if (!id || !text) continue
    out.push({ id, name, description, text, builtin: true })
  }
  return out
}

/* ───────────────────────── 人设 ───────────────────────── */

/**
 * 同步大肥鱼插件的人设到资料馆。
 * @param {object} opts
 * @param {string} opts.itemsDir 资料馆 items 目录
 * @param {object} opts.store user-items 存储（items/groups）
 * @param {boolean} [opts.dryRun]
 * @returns {{ created:number, updated:number, items:Array, warnings:string[] }}
 */
export function syncPersonas({ itemsDir, store, dryRun = false, dshHome, profile } = {}) {
  const home = dshHome || join(homedir(), '.dsh')
  const warnings = []
  const created = []
  const updated = []
  const file = join(home, 'storages', 'dsh-persona-dafeiyu', 'personas.json')
  const data = existsSync(file) ? readJson(file) : null
  if (!data) {
    warnings.push('没有找到 dsh-persona-dafeiyu 的人设文件（' + file + '）')
    return { created: 0, updated: 0, items: [], warnings, authoritative: false }
  }

  const userList = Array.isArray(data.personas) ? data.personas : []
  const pluginDir = join(home, 'profiles', String(profile || process.env.DSH_PROFILE || 'desktop'), 'node_modules', 'dsh-persona-dafeiyu')
  const builtins = extractBuiltinPersonas(pluginDir)
  const list = builtins.concat(
    userList.map((x) => ({ ...x, builtin: false })),
  )
  const currentId = String(data.current || '')
  const disabled = Array.isArray(data.disabled) ? data.disabled.map(String) : []
  if (!list.length) warnings.push('人设文件里没有条目')
  const authoritative = true

  for (const p of list) {
    const id = String(p && p.id || '').trim()
    const name = String(p && p.name || '').trim()
    const text = String(p && p.text || '')
    if (!id || !text) {
      warnings.push('跳过一条缺 id/text 的人设')
      continue
    }
    const rel = 'personas/' + id.replace(/[^\w.-]+/g, '_') + '.md'
    const abs = join(itemsDir, rel)

    if (!dryRun) {
      mkdirSync(join(itemsDir, 'personas'), { recursive: true })
      const header = '# 人设：' + (name || id) + '\n\n> 来源：dsh-persona-dafeiyu · ' + id + ' · ' + String(p.createdAt || '').slice(0, 10) + '\n\n'
      writeFileSync(abs, header + text + '\n', 'utf8')
    }

    const isCurrent = id === currentId || (p.builtin && currentId === id)
    const isDisabled = disabled.includes(id)
    const entryId = 'persona-' + id
    const entry = {
      id: entryId,
      kind: SYNC_KINDS.persona,
      status: 'available',
      title: name || id,
      summary: firstLine(text) || '（人设正文见文件）',
      source: 'dsh-persona-dafeiyu',
      group: '人设',
      tags: ['人设', p.builtin ? '内置' : '用户导入'].concat(isCurrent ? ['当前启用'] : []),
      notes: [
        '插件：dsh-persona-dafeiyu',
        '人设 id：' + id,
        p.builtin ? '内置人设（插件自带，不可删除）' : '用户导入人设',
        isCurrent ? '状态：当前启用' : isDisabled ? '状态：已停用' : '状态：未启用',
        '正文：' + text.length + ' 字符',
        p.createdAt ? '创建：' + String(p.createdAt).slice(0, 10) : '',
      ].filter(Boolean),
      files: [rel],
      added: today(),
    }

    const idx = (store.items || []).findIndex((x) => x.id === entryId)
    if (idx >= 0) {
      if (!dryRun) store.items[idx] = { ...store.items[idx], ...entry, added: store.items[idx].added || entry.added }
      updated.push(entryId)
    } else {
      if (!dryRun) store.items.push(entry)
      created.push(entryId)
    }
    if (entry.group) store.groups[entryId] = entry.group
  }

  return { created: created.length, updated: updated.length, items: created.concat(updated), warnings, authoritative, keepIds: list.map((x) => 'persona-' + String(x.id)) }
}

/**
 * 源插件里已经不存在的条目 → 标记 archived（不删，保留历史与备注）。
 * @param {object} opts
 * @param {object} opts.store
 * @param {string[]} opts.kinds 只处理这些 kind
 * @param {Set<string>} opts.keepIds 仍然存在的条目 id
 * @param {string} [opts.reason]
 * @param {boolean} [opts.dryRun]
 * @returns {number} 被标记的数量
 */
export function pruneSyncedEntries({ store, kinds = [], keepIds = new Set(), reason = '源插件里已不存在', dryRun = false } = {}) {
  let count = 0
  for (const item of store.items || []) {
    if (!kinds.includes(item.kind)) continue
    if (keepIds.has(item.id)) continue
    if (item.status === 'archived') continue
    if (!dryRun) {
      item.status = 'archived'
      item.notes = (item.notes || []).concat(reason + '（' + new Date().toISOString().slice(0, 10) + ' 同步检查）')
    }
    count += 1
  }
  return count
}

/* ─────────────────────── 表情包图集 ─────────────────────── */

/** 找 dsh-meme 插件根目录（profile node_modules 或全局）。 */
function findMemePluginRoot(profile, dshHome) {
  const home = dshHome || join(homedir(), '.dsh')
  const cands = [
    join(home, 'profiles', profile, 'node_modules', 'dsh-meme'),
    join(homedir(), '.dsh', 'profiles', 'desktop', 'node_modules', 'dsh-meme'),
  ]
  for (const c of cands) {
    if (existsSync(join(c, 'package.json'))) return c
  }
  return ''
}

/**
 * 同步表情包图集清单（只登记，不复制图片）。
 * @param {object} opts
 * @param {object} opts.store
 * @param {Array} [opts.packs] 已经解析好的图集列表（来自 meme-packs.js）
 * @param {string} [opts.profile]
 * @param {boolean} [opts.dryRun]
 */
export function syncMemePackEntries({ store, packs = [], profile, dshHome, dryRun = false } = {}) {
  const warnings = []
  const created = []
  const updated = []
  const root = findMemePluginRoot(profile || process.env.DSH_PROFILE || 'desktop', dshHome)
  if (!root) warnings.push('没有找到 dsh-meme 插件目录，跳过图集同步')

  for (const pack of Array.isArray(packs) ? packs : []) {
    const id = String(pack && pack.id || '').trim()
    if (!id) continue
    const entryId = 'meme-pack-' + id
    const entry = {
      id: entryId,
      kind: SYNC_KINDS.memePack,
      status: 'available',
      title: String(pack.name || id),
      summary:
        '表情包图集 · ' + (pack.count >= 0 ? pack.count + ' 张' : '张数未知') + (pack.enabled ? ' · 当前启用' : ''),
      source: 'dsh-meme',
      group: '表情包图集',
      meme: { id, enabled: Boolean(pack.enabled), count: pack.count >= 0 ? pack.count : -1 },
      tags: ['表情包', '图集'].concat(pack.enabled ? ['当前启用'] : []),
      notes: [
        '插件：dsh-meme',
        '图集 id：' + id,
        pack.dir ? '位置：' + pack.dir : '',
        pack.count >= 0 ? '张数：' + pack.count : '',
        '在面板左侧「表情包图集」里点一下即可切换启用',
      ].filter(Boolean),
      files: [],
      added: today(),
    }
    const idx = (store.items || []).findIndex((x) => x.id === entryId)
    if (idx >= 0) {
      if (!dryRun) store.items[idx] = { ...store.items[idx], ...entry, added: store.items[idx].added || entry.added }
      updated.push(entryId)
    } else {
      if (!dryRun) store.items.push(entry)
      created.push(entryId)
    }
    if (entry.group) store.groups[entryId] = entry.group
  }

  return {
    created: created.length,
    updated: updated.length,
    items: created.concat(updated),
    warnings,
    /* 列表为空时绝不裁剪：可能只是这次没读到（profile 路径不对 / 插件临时缺失） */
    authoritative: Boolean(root) && Array.isArray(packs) && packs.length > 0,
    keepIds: (Array.isArray(packs) ? packs : []).map((x) => 'meme-pack-' + String(x && x.id || '')).filter((x) => x !== 'meme-pack-'),
  }
}

/* ─────────────────────── 记账小鲸鱼（用量） ─────────────────────── */

/** 读 cost-meter 的 ledger.json（大账本），读不到返回 null。 */
function readLedger(dshHome) {
  try {
    const file = join(dshHome, 'storages', 'cost-meter', 'ledger.json')
    if (!existsSync(file)) return null
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

/** 读 whale-widget 的 .dshw-usage.json（小账本），读不到返回 null。 */
function readWhaleUsage(dshHome) {
  try {
    const file = join(dshHome, '.dshw-usage.json')
    if (!existsSync(file)) return null
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

function fmtMoney(v) {
  const n = Number(v)
  return Number.isFinite(n) ? '¥' + n.toFixed(2) : '¥?'
}

function fmtTokens(v) {
  const n = Number(v) || 0
  if (n >= 1e8) return (n / 1e8).toFixed(2) + ' 亿'
  if (n >= 1e4) return (n / 1e4).toFixed(1) + ' 万'
  return String(n)
}

/**
 * 把记账账本同步成「用量账本」条目（每月一条 + 一份 markdown 明细）。
 * 数据源优先 cost-meter（字段全），退回 whale 小账本。
 * @param {object} opts
 * @param {string} opts.itemsDir
 * @param {object} opts.store
 * @param {string} [opts.dshHome]
 * @param {boolean} [opts.dryRun]
 */
export function syncUsage({ itemsDir, store, dshHome, dryRun = false } = {}) {
  const home = dshHome || join(homedir(), '.dsh')
  const warnings = []
  const ledger = readLedger(home)
  const whale = readWhaleUsage(home)

  /** @type {Map<string, object>} 月份 → 天数组 */
  const months = new Map()
  let balance = null
  let todayCost = null

  if (ledger && ledger.days && typeof ledger.days === 'object') {
    for (const [day, rec] of Object.entries(ledger.days)) {
      if (!day || !rec) continue
      const month = day.slice(0, 7)
      if (!months.has(month)) months.set(month, [])
      months.get(month).push({
        day,
        cost: Number(rec.costCny != null ? rec.costCny : rec.cost) || 0,
        tokens:
          (Number(rec.input) || 0) + (Number(rec.output) || 0) + (Number(rec.cacheRead) || 0) + (Number(rec.cacheWrite) || 0),
        calls: Number(rec.calls) || 0,
        models: rec.byProviderModel ? Object.keys(rec.byProviderModel) : [],
      })
    }
    const ref = ledger.balanceRef
    if (ref && Number.isFinite(Number(ref.total))) balance = { total: Number(ref.total), cny: String(ref.currency || 'CNY') }
  } else if (whale) {
    warnings.push('没有 cost-meter 账本，退回 whale 小账本（字段较少）')
    const hist = whale.history || {}
    for (const [day, cost] of Object.entries(hist)) {
      const month = String(day).slice(0, 7)
      if (!months.has(month)) months.set(month, [])
      months.get(month).push({ day, cost: Number(cost) || 0, tokens: 0, calls: 0, models: [] })
    }
    if (Number.isFinite(Number(whale.lastBalance))) balance = { total: Number(whale.lastBalance), cny: 'CNY' }
    todayCost = Number(whale.todayUsage) || null
  } else {
    warnings.push('没有找到任何用量账本（cost-meter / whale-widget）')
    return { created: 0, updated: 0, items: [], warnings, authoritative: false, keepIds: [] }
  }

  const created = []
  const updated = []
  const keepIds = []

  for (const [month, days] of [...months.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    days.sort((a, b) => a.day.localeCompare(b.day))
    const totalCost = days.reduce((sum, d) => sum + d.cost, 0)
    const totalTokens = days.reduce((sum, d) => sum + d.tokens, 0)
    const totalCalls = days.reduce((sum, d) => sum + d.calls, 0)
    const activeDays = days.filter((d) => d.cost > 0).length
    const modelSet = new Set()
    for (const d of days) for (const m of d.models) modelSet.add(m)

    const entryId = 'usage-' + month
    keepIds.push(entryId)

    const rows = days
      .map((d) => '| ' + d.day + ' | ' + fmtMoney(d.cost) + ' | ' + fmtTokens(d.tokens) + ' | ' + (d.calls || '-') + ' |')
      .join('\n')
    const md = [
      '# ' + month + ' 用量账本',
      '',
      '> 来源：' + (ledger ? 'dsh-cost-meter（ledger.json）' : 'whale-widget（.dshw-usage.json）'),
      '',
      '- 合计：' + fmtMoney(totalCost),
      '- Token：' + fmtTokens(totalTokens),
      '- 调用：' + totalCalls + ' 次',
      '- 有消费天数：' + activeDays + ' / ' + days.length,
      balance ? '- 账本余额：' + fmtMoney(balance.total) + ' ' + balance.cny : '',
      todayCost != null ? '- 今日：' + fmtMoney(todayCost) : '',
      '',
      '| 日期 | 花费 | Token | 调用 |',
      '| --- | --- | --- | --- |',
      rows,
      '',
    ]
      .filter((x) => x !== '')
      .join('\n')

    const rel = 'usage/' + month + '.md'
    if (!dryRun) {
      mkdirSync(join(itemsDir, 'usage'), { recursive: true })
      writeFileSync(join(itemsDir, rel), md + '\n', 'utf8')
    }

    const entry = {
      id: entryId,
      kind: SYNC_KINDS.usage,
      status: 'available',
      title: month + ' 用量账本',
      summary: '合计 ' + fmtMoney(totalCost) + ' · ' + fmtTokens(totalTokens) + ' tokens · ' + totalCalls + ' 次调用',
      source: ledger ? 'dsh-cost-meter' : 'dsh-whale-widget',
      group: '用量账本',
      tags: ['用量', '记账'].concat(month === new Date().toISOString().slice(0, 7) ? ['本月'] : []),
      notes: [
        '数据源：' + (ledger ? 'cost-meter ledger.json' : 'whale .dshw-usage.json'),
        '账本余额：' + (balance ? fmtMoney(balance.total) + ' ' + balance.cny : '未知'),
        '有消费天数：' + activeDays + ' / ' + days.length,
        modelSet.size ? '涉及模型：' + [...modelSet].slice(0, 8).join('、') : '',
      ].filter(Boolean),
      files: [rel],
      added: today(),
    }

    const idx = (store.items || []).findIndex((x) => x.id === entryId)
    if (idx >= 0) {
      if (!dryRun) store.items[idx] = { ...store.items[idx], ...entry, added: store.items[idx].added || entry.added }
      updated.push(entryId)
    } else {
      if (!dryRun) store.items.push(entry)
      created.push(entryId)
    }
    if (entry.group) store.groups[entryId] = entry.group
  }

  return { created: created.length, updated: updated.length, items: created.concat(updated), warnings, authoritative: true, keepIds }
}

/* ─────────────────── 大肥鱼监工（角色包 / 宠物） ─────────────────── */

/**
 * 同步 bigfish 的角色包：内置 packs/* + 用户 ~/.dsh/pets/dsh-bigfish/*.dshpet
 * 只登记，不复制资源（包体可能很大）。
 */
export function syncCompanionPacks({ store, itemsDir, dshHome, profile, dryRun = false } = {}) {
  const home = dshHome || join(homedir(), '.dsh')
  const prof = profile || process.env.DSH_PROFILE || 'desktop'
  const warnings = []
  const created = []
  const updated = []
  const keepIds = []
  let found = false

  const pluginDir = join(home, 'profiles', prof, 'node_modules', 'dsh-bigfish')
  const packsDir = join(pluginDir, 'packs')
  if (existsSync(packsDir)) {
    found = true
    let names = []
    try {
      names = readdirSync(packsDir)
    } catch {
      names = []
    }
    for (const name of names) {
      const manifestFile = join(packsDir, name, 'manifest.json')
      if (!existsSync(manifestFile)) continue
      let m = null
      try {
        m = JSON.parse(readFileSync(manifestFile, 'utf8'))
      } catch {
        warnings.push('manifest 读不了：' + name)
        continue
      }
      const id = String(m.id || name)
      const entryId = 'pet-' + id
      keepIds.push(entryId)
      const scenes = Array.isArray(m.scenes) ? m.scenes.length : 0
      const assets = Array.isArray(m.assets) ? m.assets.length : 0

      /* 预览图：manifest 里的 assets → 包目录；再看 examples/*.png；最后 starter/thumbnail.png */
      const packDir = join(packsDir, name)
      let preview = ''
      for (const a of Array.isArray(m.assets) ? m.assets : []) {
        const cand = join(packDir, String(a))
        if (existsSync(cand) && /\.(png|webp|gif|jpg)$/i.test(cand)) { preview = cand; break }
      }
      if (!preview) {
        /* 只在包自带 pet-maker 素材里找；examples 是别的角色（机器人），不能拿来当封面 */
        for (const sub of ['skills/dsh-bigfish-pet-maker/assets/starter']) {
          const dir2 = join(pluginDir, sub)
          if (!existsSync(dir2)) continue
          let files2 = []
          try {
            files2 = readdirSync(dir2).filter((f) => /\.(png|webp|gif|jpg)$/i.test(f))
          } catch {
            files2 = []
          }
          const pick = files2.find((f) => /thumb/i.test(f)) || files2[0]
          if (pick) { preview = join(dir2, pick); break }
        }
      }
      const files = []
      if (preview) {
        const rel = 'pets/' + id.replace(/[^\w.-]+/g, '_') + '-cover' + (preview.match(/\.[a-z]+$/i) || ['.png'])[0]
        if (!dryRun) {
          try {
            mkdirSync(join(itemsDir, 'pets'), { recursive: true })
            writeFileSync(join(itemsDir, rel), readFileSync(preview))
            files.push(rel)
          } catch {
            /* 复制失败就算了，不影响登记 */
          }
        } else {
          files.push(rel)
        }
      }
      const entry = {
        id: entryId,
        kind: SYNC_KINDS.pet,
        status: 'available',
        title: id,
        summary: '角色包 ' + String(m.version || '') + ' · ' + scenes + ' 个场景 · ' + assets + ' 张素材',
        source: 'dsh-bigfish',
        group: '角色包',
        tags: ['角色包', '大肥鱼监工'].concat(name === 'classic' ? ['内置'] : []),
        notes: [
          '插件：dsh-bigfish',
          '包 id：' + id,
          'rig：' + String(m.rigId || ''),
          '位置：' + join(packsDir, name),
          preview ? '预览来自：' + preview : '（这个包没带预览图）',
          assets > 0 && !preview ? 'manifest 声明了 ' + assets + ' 张素材，但 npm 包里没有对应文件' : '',
        ].filter(Boolean),
        files,
        added: today(),
      }
      const idx = (store.items || []).findIndex((x) => x.id === entryId)
      if (idx >= 0) {
        if (!dryRun) store.items[idx] = { ...store.items[idx], ...entry, added: store.items[idx].added || entry.added }
        updated.push(entryId)
      } else {
        if (!dryRun) store.items.push(entry)
        created.push(entryId)
      }
      if (entry.group) store.groups[entryId] = entry.group
    }
  }

  const userDir = join(home, 'pets', 'dsh-bigfish')
  if (existsSync(userDir)) {
    found = true
    let files = []
    try {
      files = readdirSync(userDir).filter((f) => f.endsWith('.dshpet'))
    } catch {
      files = []
    }
    for (const f of files) {
      const base = f.replace(/\.dshpet$/, '')
      const entryId = 'pet-user-' + base
      keepIds.push(entryId)
      let size = 0
      try {
        size = statSync(join(userDir, f)).size
      } catch {
        size = 0
      }
      const entry = {
        id: entryId,
        kind: SYNC_KINDS.pet,
        status: 'available',
        title: base,
        summary: '用户角色包 · ' + Math.round(size / 1024) + ' KB',
        source: 'dsh-bigfish',
        group: '角色包',
        tags: ['角色包', '用户自制'],
        notes: ['插件：dsh-bigfish', '文件：' + join(userDir, f)],
        files: [],
        added: today(),
      }
      const idx = (store.items || []).findIndex((x) => x.id === entryId)
      if (idx >= 0) {
        if (!dryRun) store.items[idx] = { ...store.items[idx], ...entry, added: store.items[idx].added || entry.added }
        updated.push(entryId)
      } else {
        if (!dryRun) store.items.push(entry)
        created.push(entryId)
      }
      if (entry.group) store.groups[entryId] = entry.group
    }
  }

  if (!found) warnings.push('没有找到 dsh-bigfish 的 packs / pets 目录')

  return { created: created.length, updated: updated.length, items: created.concat(updated), warnings, authoritative: found && keepIds.length > 0, keepIds }
}

/* ─────────────── 鲸鱼挂件（可导入图集：角色 / 气泡图 / 音效） ─────────────── */

/**
 * 同步 dsh-whale-widget 的图集：
 *   · 内置 assets（角色图 / 气泡 gif / 音效）→ 一条「内置图集」记录 + 封面
 *   · 用户导入目录 ~/.dsh/whale-roles、whale-bubble-imgs、whale-audio → 每个目录一条
 * 只登记 + 复制一张封面，不复制全部素材。
 */
export function syncWhale({ store, itemsDir, dshHome, profile, dryRun = false } = {}) {
  const home = dshHome || join(homedir(), '.dsh')
  const prof = profile || process.env.DSH_PROFILE || 'desktop'
  const warnings = []
  const created = []
  const updated = []
  const keepIds = []
  let found = false

  const copyCover = (src, entryId) => {
    try {
      const ext = (src.match(/\.[a-z]+$/i) || ['.png'])[0]
      const rel = 'whale/' + entryId.replace(/[^\w.-]+/g, '_') + '-cover' + ext
      if (!dryRun) {
        mkdirSync(join(itemsDir, 'whale'), { recursive: true })
        writeFileSync(join(itemsDir, rel), readFileSync(src))
      }
      return rel
    } catch {
      return ''
    }
  }

  const upsert = (entry) => {
    keepIds.push(entry.id)
    const idx = (store.items || []).findIndex((x) => x.id === entry.id)
    if (idx >= 0) {
      if (!dryRun) store.items[idx] = { ...store.items[idx], ...entry, added: store.items[idx].added || entry.added }
      updated.push(entry.id)
    } else {
      if (!dryRun) store.items.push(entry)
      created.push(entry.id)
    }
    if (entry.group) store.groups[entry.id] = entry.group
  }

  /* 内置图集 */
  const assetsDir = join(home, 'profiles', prof, 'node_modules', 'dsh-whale-widget', 'assets')
  if (existsSync(assetsDir)) {
    found = true
    let files = []
    try {
      files = readdirSync(assetsDir)
    } catch {
      files = []
    }
    const imgs = files.filter((f) => /\.(png|gif|webp|jpg)$/i.test(f))
    const audios = files.filter((f) => /\.(wav|mp3)$/i.test(f))
    const roles = imgs.filter((f) => /^(D|DSniang|dsh)/i.test(f))
    const bubbles = imgs.filter((f) => /bubble/i.test(f))
    const cover = imgs.find((f) => /^DSniang1\./i.test(f)) || roles[0] || imgs[0] || ''
    const entryId = 'whale-builtin'
    upsert({
      id: entryId,
      kind: 'whale-pack',
      status: 'available',
      title: '鲸鱼内置图集',
      summary: [roles.length ? roles.length + ' 张角色图' : '', bubbles.length ? bubbles.length + ' 张气泡图' : '', audios.length ? audios.length + ' 个音效' : '']
        .filter(Boolean)
        .join(' · ') || '内置素材',
      source: 'dsh-whale-widget',
      group: '内置图集',
      tags: ['鲸鱼', '内置'],
      notes: ['插件：dsh-whale-widget', '位置：' + assetsDir, '可导入自己的图集到 ~/.dsh/whale-roles 与 ~/.dsh/whale-bubble-imgs'],
      files: cover ? [copyCover(join(assetsDir, cover), entryId)] : [],
      added: today(),
    })
  }

  /* 用户导入目录 */
  const userDirs = [
    { dir: 'whale-roles', label: '用户角色图', group: '用户导入' },
    { dir: 'whale-bubble-imgs', label: '用户气泡图', group: '用户导入' },
    { dir: 'whale-audio', label: '用户音效', group: '用户导入' },
  ]
  for (const spec of userDirs) {
    const dir = join(home, spec.dir)
    if (!existsSync(dir)) continue
    let files = []
    try {
      files = readdirSync(dir).filter((f) => !f.endsWith('.json'))
    } catch {
      files = []
    }
    if (!files.length) continue
    found = true
    const imgs = files.filter((f) => /\.(png|gif|webp|jpg)$/i.test(f))
    const entryId = 'whale-user-' + spec.dir
    upsert({
      id: entryId,
      kind: 'whale-pack',
      status: 'available',
      title: spec.label,
      summary: files.length + ' 个文件' + (imgs.length ? ' · 覆盖 ' + imgs.length + ' 张图' : ''),
      source: 'dsh-whale-widget',
      group: spec.group,
      tags: ['鲸鱼', '用户导入'],
      notes: ['插件：dsh-whale-widget', '目录：' + dir],
      files: imgs.length ? [copyCover(join(dir, imgs[0]), entryId)] : [],
      added: today(),
    })
  }

  if (!found) warnings.push('没有找到 dsh-whale-widget 的资产或导入目录')
  return { created: created.length, updated: updated.length, items: created.concat(updated), warnings, authoritative: found, keepIds }
}
