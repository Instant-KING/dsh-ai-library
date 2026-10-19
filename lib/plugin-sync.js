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
}

/** 已支持同步的插件（用于面板展示「能同步什么」）。 */
export const SUPPORTED = [
  { id: 'dsh-persona-dafeiyu', label: '大肥鱼人设', kind: 'persona' },
  { id: 'dsh-meme', label: '表情包图集', kind: 'meme-pack' },
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

/* ───────────────────────── 人设 ───────────────────────── */

/**
 * 同步大肥鱼插件的人设到资料馆。
 * @param {object} opts
 * @param {string} opts.itemsDir 资料馆 items 目录
 * @param {object} opts.store user-items 存储（items/groups）
 * @param {boolean} [opts.dryRun]
 * @returns {{ created:number, updated:number, items:Array, warnings:string[] }}
 */
export function syncPersonas({ itemsDir, store, dryRun = false } = {}) {
  const warnings = []
  const created = []
  const updated = []
  const file = join(homedir(), '.dsh', 'storages', 'dsh-persona-dafeiyu', 'personas.json')
  const data = existsSync(file) ? readJson(file) : null
  if (!data) {
    warnings.push('没有找到 dsh-persona-dafeiyu 的人设文件（' + file + '）')
    return { created: 0, updated: 0, items: [], warnings, authoritative: false }
  }

  const list = Array.isArray(data.personas) ? data.personas : []
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

    const isCurrent = id === currentId
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
      tags: ['人设', '大肥鱼插件'].concat(isCurrent ? ['当前启用'] : []),
      notes: [
        '插件：dsh-persona-dafeiyu',
        '人设 id：' + id,
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
