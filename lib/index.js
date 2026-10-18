/**
 * ai-library · 宿主侧半边
 * ---------------------------------------------------------------------------
 * 两条路由：
 *
 *   GET /api/ai-library
 *       读 library.js，返回 { ok, items, groups, env, updated }。
 *
 *   GET /api/ai-library/file?name=<items 下的相对路径>
 *       把 items/ 里的文件喂给右侧 <iframe>。按扩展名分派：
 *         .md                → 现场渲染成 HTML
 *         .pptx/.docx/.xlsx… → 用本机 LibreOffice 转成 PDF（结果缓存）
 *         其余               → 按 MIME 直接流式返回（支持 Range）
 *
 * 为什么不在浏览器侧直接读文件：
 *   浏览器拿不到本地绝对路径（不是 http 服务根目录），file:// 又会被 CORS 拦。
 *
 * 为什么用 new Function 求值而不是 JSON.parse：
 *   library.js 是 `window.LIBRARY = {...}` 形式（为了同时能被 index.html 用 <script> 加载），
 *   里带注释，不是纯 JSON。用一个只含 window 的沙箱把它跑出来最省事。
 */

import { readFile, readdir, stat, mkdir, rename, writeFile } from 'node:fs/promises'
import { createReadStream, existsSync, writeFileSync as writeSync, appendFileSync, mkdirSync } from 'node:fs'
import { resolve, sep, extname, normalize, basename, join } from 'node:path'
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { CONFIG, PLUGIN_DIR } from './config.js'
import { searchPapers } from './paper.js'
import { sciverseSemantic, sciverseReadContent } from './sciverse.js'
import { buildPluginEntry, mergePluginEntry } from './plugin-record.js'
import { registerLibraryPrompt } from './prompt.js'
import { registerTools } from './tools.js'

const execFileAsync = promisify(execFile)

/** 数据路由。 */
const ROUTE = '/api/ai-library'
/** 文件路由。 */
const FILE_ROUTE = '/api/ai-library/file'
/** pdf.js 静态资源路由（插件自带的 vendor 文件）。 */
const VENDOR_ROUTE = '/api/ai-library/vendor'
/** 客户端错误上报路由（渲染进程出问题时写 .cache/client.log）。 */
const CLIENT_LOG_ROUTE = '/api/ai-library/log'
/** 条目编辑路由（新增 / 修改 / 删除，写入 user-items.json）。 */
const ITEM_ROUTE = '/api/ai-library/item'
/** 大类（左侧一级栏目）管理路由。 */
const BUCKET_ROUTE = '/api/ai-library/bucket'
/** 一键安装插件（走 dsh plugin add）。 */
const INSTALL_ROUTE = '/api/ai-library/install'
/** 自更新：git 拉取（本地目录安装）或 npm 重装（包安装）。 */
const UPDATE_ROUTE = '/api/ai-library/update'
/** GitHub 仓库信息（README 截图 / 描述 / star）。 */
const REPO_ROUTE = '/api/ai-library/repo'
/** 兼容性检查：读装了的包 or 查 npm，对比当前 DSH 版本。 */
const COMPAT_ROUTE = '/api/ai-library/compat'
/** GitHub 预览图代理：渲染进程拿不到外网图片，由宿主转发。 */
const OG_ROUTE = '/api/ai-library/og'
/** 论文检索（面板用）：GET ?q=&source=&limit= */
const PAPER_ROUTE = '/api/ai-library/paper'
/** 多平台 key 配置：GET 读取 / POST 保存 */
const KEYS_ROUTE = '/api/ai-library/keys'
/** 论文检索结果缓存（同一关键词 10 分钟内直接返回）。 */
const PAPER_CACHE_TTL = 10 * 60 * 1000
/** GitHub 用户头像代理（卡片用）。 */
const AVATAR_ROUTE = '/api/ai-library/avatar'
/** 压缩包内容列表（面板用）：GET ?src=<file 路由地址> */
const ARCHIVE_ROUTE = '/api/ai-library/archive'
/** key 名到 paper_import 环境变量的映射。 */
const KEY_ENV = { ieee: 'IEEE_XPLORE_API_KEY', springer: 'SPRINGER_API_KEY', elsevier: 'ELSEVIER_API_KEY', sciverse: 'SCIVERSE_API_TOKEN' }
/** 大类定义文件（用户可编辑，不存在则用默认）。 */
const BUCKETS_FILE = join(CONFIG.root, 'buckets.json').split(sep).join('/')
/** 默认大类：与旧版行为一致，老数据不用迁移。 */
const DEFAULT_BUCKETS = [
  { id: 'market', label: '插件市场', order: 1, kinds: ['market', 'plugin'] },
  { id: 'local', label: '本地文件', order: 2, kinds: ['prompt', 'courseware', 'report', 'doc', 'note', 'homework', 'website', 'repo'] },
  { id: 'paper', label: '论文资料', order: 3, kinds: ['paper', 'solution', 'sim'] },
  { id: 'other', label: '未归类', order: 9, kinds: [] },
]

/** 数据源。 */
const DEFAULT_PATH = CONFIG.libraryFile
/** 项目资料导入产物（由 import-project.mjs 生成，可为空）。 */
const PROJECT_PATH = CONFIG.projectFile
/** 文件根目录：只允许读这里面的东西。 */
const ITEMS_DIR = CONFIG.itemsDir
/** Office → PDF 的缓存目录。 */
const CACHE_DIR = CONFIG.cacheDir
/** 本机 LibreOffice（用于 pptx/docx/xlsx 预览）。 */
const SOFFICE = CONFIG.soffice
/** 插件自带的 pdf.js 构建产物目录。 */
const VENDOR_DIR = CONFIG.vendorDir
/** 翻译服务路由。 */
const TRANSLATE_ROUTE = '/api/ai-library/translate'
/** PDFMathTranslate 服务地址（可用环境变量 PDFMATHTRANSLATE_URL 覆盖）。 */
const TRANSLATE_URL = CONFIG.translateUrl
/** 译文缓存目录。 */
const TRANSLATE_CACHE = CONFIG.translateCache

/** 插件市场同步路由。 */
const MARKET_ROUTE = '/api/ai-library/market'
/** 插件市场 API。 */
const MARKET_URL = CONFIG.marketUrl
/** 目录原始缓存（避免每次重拉 9 MB）。 */
const MARKET_CACHE = CONFIG.marketCache
/** 转换后的图书馆条目（与 project-items.js 同机制）。 */
const MARKET_FILE = CONFIG.marketFile
/** 原始缓存有效期。 */
const MARKET_TTL_MS = CONFIG.marketTtlMs
/** 最多收录多少条（按 star 降序）。 */
const MARKET_LIMIT = CONFIG.marketLimit

/** GitHub 优秀项目（由 sync-github.mjs 生成）。 */
const GITHUB_FILE = CONFIG.githubFile

/** 编辑器写入的用户条目（新增 / 覆盖手写条目）。 */
const USER_ITEMS_FILE = CONFIG.userItemsFile

/** 外部提示词库目录（只读挂载，不复制文件）。 */
const MOTION_DIR = CONFIG.motionDir
/** 提示词库资源路由。 */
const MOTION_ROUTE = '/api/ai-library/motion'
/** 探针结果落盘位置。 */

/** 需要宿主提供本地 HTTP 服务。 */
export const inject = ['webServer', 'tools']

/** 扩展名 → MIME。 */
const MIME = {
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.bmp': 'image/bmp',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/html; charset=utf-8',
  '.markdown': 'text/html; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  /* 代码：按纯文本返回，面板里直接看源码（否则会变成下载） */
  '.css': 'text/plain; charset=utf-8',
  '.scss': 'text/plain; charset=utf-8',
  '.less': 'text/plain; charset=utf-8',
  '.js': 'text/plain; charset=utf-8',
  '.mjs': 'text/plain; charset=utf-8',
  '.jsx': 'text/plain; charset=utf-8',
  '.ts': 'text/plain; charset=utf-8',
  '.tsx': 'text/plain; charset=utf-8',
  '.vue': 'text/plain; charset=utf-8',
  '.svelte': 'text/plain; charset=utf-8',
  '.py': 'text/plain; charset=utf-8',
  '.sh': 'text/plain; charset=utf-8',
  '.yml': 'text/plain; charset=utf-8',
  '.yaml': 'text/plain; charset=utf-8',
  '.xml': 'text/plain; charset=utf-8',
  '.csv': 'text/plain; charset=utf-8',
  '.log': 'text/plain; charset=utf-8',
  '.ini': 'text/plain; charset=utf-8',
  '.toml': 'text/plain; charset=utf-8',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
}

/** 需要先转 PDF 才能预览的扩展名。 */
const OFFICE_EXT = new Set(['.pptx', '.ppt', '.docx', '.doc', '.xlsx', '.xls', '.odt', '.odp', '.ods'])

/**
 * 读盘并求值出 window.LIBRARY。
 * @param file - library.js 的绝对路径。
 * @returns 结构化数据。
 */
async function loadLibrary(file) {
  const source = await readFile(file, 'utf8')
  const sandbox = { window: {} }
  new Function('window', source)(sandbox.window)
  const data = sandbox.window.LIBRARY
  if (!data || typeof data !== 'object' || !Array.isArray(data.items)) {
    throw new Error('library.js 里没有 window.LIBRARY.items 数组')
  }
  return data
}

/**
 * 读一个 `window.<KEY> = {...}` 形式的数据文件（读不到就返回 null，不影响主数据）。
 * @param file - 绝对路径。
 * @param key - 挂在 window 上的键名。
 * @returns { items, groups, generatedAt } 或 null。
 */
async function loadExtra(file, key) {
  try {
    const source = await readFile(file, 'utf8')
    const sandbox = { window: {} }
    new Function('window', source)(sandbox.window)
    const data = sandbox.window[key]
    if (!data || !Array.isArray(data.items)) return null
    return data
  } catch {
    return null
  }
}

/**
 * 读用户条目（编辑器写入）。文件不存在就返回空结构。
 * @returns { items: [], groups: {} }
 */
async function loadUserItems() {
  try {
    const raw = await readFile(USER_ITEMS_FILE, 'utf8')
    const data = JSON.parse(raw)
    if (!data || !Array.isArray(data.items)) return { items: [], groups: {}, updatedAt: '' }
    return { items: data.items, groups: data.groups || {}, updatedAt: String(data.updatedAt || '') }
  } catch {
    return { items: [], groups: {} }
  }
}

/**
 * 原子写回用户条目（先写临时文件再 rename，断电不会写坏）。
 * @param data { items, groups }
 */
/**
 * 读大类定义（没有就用默认，并写一份出来方便用户改）。
 * @returns 大类数组
 */
async function loadBuckets() {
  try {
    const raw = await readFile(BUCKETS_FILE, 'utf8')
    const list = JSON.parse(raw)
    if (Array.isArray(list) && list.length) return list
  } catch {
    /* 首次运行 */
  }
  return DEFAULT_BUCKETS
}

/**
 * 原子写回大类定义。
 * @param list 大类数组
 */
async function saveBuckets(list) {
  const tmp = BUCKETS_FILE + '.tmp'
  await writeFile(tmp, JSON.stringify(list, null, 2), 'utf8')
  await rename(tmp, BUCKETS_FILE)
}

async function saveUserItems(data) {
  await mkdir(join(USER_ITEMS_FILE, '..'), { recursive: true })
  const tmp = USER_ITEMS_FILE + '.tmp'
  await writeFile(tmp, JSON.stringify({ version: 1, updatedAt: new Date().toISOString(), items: data.items, groups: data.groups || {} }, null, 2), 'utf8')
  await rename(tmp, USER_ITEMS_FILE)
}

/** 允许编辑的字段白名单（防止写入奇怪的东西）。 */
const EDITABLE_FIELDS = ['id', 'kind', 'status', 'title', 'summary', 'source', 'version', 'fit', 'tags', 'tools', 'install', 'link', 'notes', 'files', 'preview', 'group', 'added', 'hidden', 'bucket', 'origin', 'format', 'project']

/**
 * 把任意对象裁成安全条目。
 * @param input 原始对象
 * @returns 干净条目
 */
function sanitizeItem(input) {
  const out = {}
  for (const key of EDITABLE_FIELDS) {
    if (input[key] === undefined) continue
    out[key] = input[key]
  }
  if (typeof out.id === 'string') out.id = out.id.trim().slice(0, 120)
  if (typeof out.title === 'string') out.title = out.title.trim().slice(0, 200)
  if (typeof out.summary === 'string') out.summary = out.summary.trim().slice(0, 500)
  for (const key of ['tags', 'tools', 'notes', 'files']) {
    if (Array.isArray(out[key])) out[key] = out[key].filter((x) => typeof x === 'string').slice(0, 30)
  }
  return out
}

/**
 * 合并三个数据源：手写 → 项目导入 → 插件市场。
 * 优先级：手写 > 项目 > 市场（同 id 时先出现的覆盖）。
 * @returns 合并后的完整数据。
 */
/**
 * 数据根不存在时自动建一个空库（新用户第一次打开面板就能用）。
 * 只建目录 + 一个合法的 library.js，不覆盖任何已有文件。
 */
async function ensureLibrary() {
  const file = DEFAULT_PATH
  try {
    await stat(file)
    return false
  } catch {
    /* 文件不存在 → 建 */
  }
  try {
    await mkdir(CONFIG.root, { recursive: true })
    await mkdir(ITEMS_DIR, { recursive: true })
    await mkdir(CACHE_DIR, { recursive: true })
    const bootstrap = [
      '/**',
      ' * 资料馆的空库（首次运行自动生成）。',
      ' * 可以随便改：加条目、加分组都写在这里，或用面板的「＋ 新建」。',
      ' */',
      'window.LIBRARY = {',
      '  generatedAt: ' + JSON.stringify(new Date().toISOString()) + ',',
      '  items: [],',
      '  groups: {},',
      '};',
      '',
    ].join('\n')
    await writeFile(file, bootstrap, 'utf8')
    return true
  } catch (error) {
    /* 建不出来也不能让面板 500：退回内存里的空库 */
    console.warn('[ai-library] 无法创建空库：' + String((error && error.message) || error))
    return false
  }
}

async function loadAll() {
  await ensureLibrary()
  let base
  try {
    base = await loadLibrary(DEFAULT_PATH)
  } catch (error) {
    /* 文件坏了 / 没有 window.LIBRARY：不让整个面板 500，退回空库并记住原因 */
    console.warn('[ai-library] library.js 读取失败，已按空库处理：' + String((error && error.message) || error))
    globalThis.__ailibLibraryError = String((error && error.message) || error)
    base = { items: [], groups: {}, generatedAt: '' }
  }
  const project = await loadExtra(PROJECT_PATH, 'LIBRARY_PROJECT')
  const market = await loadExtra(MARKET_FILE, 'LIBRARY_MARKET')
  const github = await loadExtra(GITHUB_FILE, 'LIBRARY_GITHUB')
  const mine = await loadMyPrompts()
  const motion = await loadMotionSites()

  const user = await loadUserItems()

  const byId = new Map()
  for (const pack of [motion, mine, github, market, project]) {
    if (!pack || !Array.isArray(pack.items)) continue
    for (const it of pack.items) byId.set(it.id, it)
  }
  for (const it of base.items) byId.set(it.id, it)
  /* 用户编辑放最后 → 覆盖一切（包括手写条目） */
  for (const it of user.items) byId.set(it.id, it)
  /* hidden:true = 从视图里隐藏（不删源文件，手写条目也能"删"） */
  for (const it of user.items) if (it.hidden === true) byId.delete(it.id)

  const groups = {}
  for (const pack of [motion, mine, github, market, project]) if (pack && pack.groups) Object.assign(groups, pack.groups)
  Object.assign(groups, base.groups || {})
  Object.assign(groups, user.groups || {})
  /* 用户条目自带 group 字段时，也映射进 groups 表 */
  for (const it of user.items) if (it.group) groups[it.id] = it.group
  const buckets = await loadBuckets()

  return {
    ...base,
    buckets,
    /* 数据指纹：编辑器/工具写完它变化，客户端据此自动刷新 */
    rev: user.items.length + '@' + user.updatedAt + '+' + buckets.length,
    items: [...byId.values()],
    groups,
    sources: {
      hand: base.items.length,
      project: project && project.items ? project.items.length : 0,
      projectGeneratedAt: (project && project.generatedAt) || '',
      market: market && market.items ? market.items.length : 0,
      marketSyncedAt: (market && market.syncedAt) || '',
      github: github && github.items ? github.items.length : 0,
      mine: mine && mine.items ? mine.items.length : 0,
      motion: motion && motion.items ? motion.items.length : 0,
      user: user.items.length,
    },
  }
}

/**
 * 把请求里的 name 解析成 items 目录内的绝对路径。越界一律拒绝。
 * @param name - 查询参数里的相对路径。
 * @returns 绝对路径；非法时返回 null。
 */
function safeTarget(name) {
  if (typeof name !== 'string' || name.trim() === '') return null
  const cleaned = normalize(name).replace(/^([/\\])+/, '')
  if (cleaned.includes('..') || /^[A-Za-z]:/.test(cleaned)) return null
  const base = resolve(ITEMS_DIR)
  const target = resolve(base, cleaned)
  if (target !== base && !target.startsWith(base + sep)) return null
  return target
}

/**
 * 写一条纯文本响应。
 * @param res - Node 响应对象。
 * @param code - HTTP 状态码。
 * @param message - 正文。
 */
function text(res, code, message) {
  res.writeHead(code, { 'content-type': 'text/plain; charset=utf-8' })
  res.end(message)
}

/* ────────────────────── Markdown → HTML（够用即可） ────────────────────── */

/**
 * 转义 HTML 特殊字符。
 * @param s - 原文。
 * @returns 转义结果。
 */
function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/**
 * 行内标记：`code`、**粗**、*斜*、[文字](链接)。
 * @param s - 一行原文。
 * @returns HTML 片段。
 */
function inline(s) {
  return esc(s)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>')
}

/**
 * 极简 Markdown 渲染：标题 / 列表 / 引用 / 代码块 / 分隔线 / 段落。
 * 表格暂不处理（会退化成段落）。
 * @param source - Markdown 原文。
 * @returns 完整 HTML 文档。
 */
function mdToHtml(source) {
  const lines = source.replace(/\r\n?/g, '\n').split('\n')
  const out = []
  let i = 0
  let listType = null

  const closeList = () => {
    if (listType) {
      out.push(`</${listType}>`)
      listType = null
    }
  }

  while (i < lines.length) {
    const line = lines[i]

    // 代码块
    const fence = /^```\s*([\w-]*)\s*$/.exec(line)
    if (fence) {
      closeList()
      const lang = fence[1] || ''
      const buf = []
      i += 1
      while (i < lines.length && !/^```/.test(lines[i])) {
        buf.push(lines[i])
        i += 1
      }
      i += 1
      out.push(`<pre class="md-code"${lang ? ` data-lang="${esc(lang)}"` : ''}><code>${esc(buf.join('\n'))}</code></pre>`)
      continue
    }

    // 空行
    if (/^\s*$/.test(line)) {
      closeList()
      i += 1
      continue
    }

    // 分隔线
    if (/^\s*([-*_])\1{2,}\s*$/.test(line)) {
      closeList()
      out.push('<hr />')
      i += 1
      continue
    }

    // 标题
    const heading = /^(#{1,6})\s+(.*)$/.exec(line)
    if (heading) {
      closeList()
      const level = heading[1].length
      out.push(`<h${level}>${inline(heading[2].trim())}</h${level}>`)
      i += 1
      continue
    }

    // 引用（连续多行合并）
    if (/^>\s?/.test(line)) {
      closeList()
      const buf = []
      while (i < lines.length && /^>\s?/.test(lines[i])) {
        buf.push(lines[i].replace(/^>\s?/, ''))
        i += 1
      }
      out.push(`<blockquote>${buf.map((l) => `<p>${inline(l)}</p>`).join('')}</blockquote>`)
      continue
    }

    // 无序列表
    const ul = /^\s*[-*+]\s+(.*)$/.exec(line)
    if (ul) {
      if (listType !== 'ul') {
        closeList()
        listType = 'ul'
        out.push('<ul>')
      }
      out.push(`<li>${inline(ul[1])}</li>`)
      i += 1
      continue
    }

    // 有序列表
    const ol = /^\s*\d+[.)]\s+(.*)$/.exec(line)
    if (ol) {
      if (listType !== 'ol') {
        closeList()
        listType = 'ol'
        out.push('<ol>')
      }
      out.push(`<li>${inline(ol[1])}</li>`)
      i += 1
      continue
    }

    // 段落（连续非空行合并）
    closeList()
    const para = []
    while (
      i < lines.length &&
      !/^\s*$/.test(lines[i]) &&
      !/^```/.test(lines[i]) &&
      !/^#{1,6}\s+/.test(lines[i]) &&
      !/^>\s?/.test(lines[i]) &&
      !/^\s*[-*+]\s+/.test(lines[i]) &&
      !/^\s*\d+[.)]\s+/.test(lines[i])
    ) {
      para.push(lines[i])
      i += 1
    }
    out.push(`<p>${para.map(inline).join('<br />')}</p>`)
  }

  closeList()

  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Markdown</title>
<style>
  :root{color-scheme:light dark}
  body{margin:0;padding:22px 24px 60px;max-width:860px;
    font:14px/1.72 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;
    color:#1b2424;background:#fff;word-wrap:break-word}
  @media (prefers-color-scheme:dark){body{color:#e8eeee;background:#182020}
    .md-code{background:#111a1a!important}td,th{border-color:#2a3737!important}}
  h1,h2,h3,h4,h5,h6{line-height:1.35;margin:1.4em 0 .6em;font-weight:650}
  h1{font-size:1.6em;border-bottom:1px solid rgba(120,130,130,.25);padding-bottom:.3em}
  h2{font-size:1.3em;border-bottom:1px solid rgba(120,130,130,.18);padding-bottom:.25em}
  h3{font-size:1.12em}
  p{margin:.7em 0}
  a{color:#2a4e4e}
  @media (prefers-color-scheme:dark){a{color:#7fb3ad}}
  code{background:rgba(120,130,130,.14);padding:.12em .38em;border-radius:4px;
    font:.9em ui-monospace,Consolas,monospace}
  .md-code{background:#f4f6f6;padding:12px 14px;border-radius:8px;overflow:auto;
    border:1px solid rgba(120,130,130,.18)}
  .md-code code{background:none;padding:0;font-size:12.5px;line-height:1.6}
  blockquote{margin:.8em 0;padding:.2em 0 .2em 14px;border-left:3px solid rgba(42,78,78,.45);
    color:rgba(27,36,36,.72)}
  @media (prefers-color-scheme:dark){blockquote{color:rgba(232,238,238,.72)}}
  ul,ol{margin:.6em 0;padding-left:1.5em}
  li{margin:.28em 0}
  hr{border:0;border-top:1px solid rgba(120,130,130,.25);margin:1.6em 0}
</style></head><body>${out.join('\n')}</body></html>`
}

/* ────────────────────── Office → PDF（缓存） ────────────────────── */

/**
 * 把 Office 文件转成 PDF，结果按「路径 + mtime」缓存。
 * @param source - 源文件绝对路径。
 * @returns 生成的 PDF 绝对路径。
 */
async function convertToPdf(source) {
  const info = await stat(source)
  const key = createHash('sha1').update(source).digest('hex').slice(0, 10) + '-' + info.mtimeMs
  const cached = join(CACHE_DIR, key + '.pdf')
  if (existsSync(cached)) return cached

  await mkdir(CACHE_DIR, { recursive: true })

  // soffice 按输入文件名输出到 outdir，先让它写到缓存目录，再改名成带 hash 的缓存键。
  await execFileAsync(
    SOFFICE,
    ['--headless', '--norestore', '--convert-to', 'pdf', '--outdir', CACHE_DIR, source],
    { timeout: 180000, windowsHide: true },
  )

  const produced = join(CACHE_DIR, basename(source, extname(source)) + '.pdf')
  if (!existsSync(produced)) throw new Error('LibreOffice 转换未产出 PDF')
  await rename(produced, cached)
  return cached
}

/* ────────────────────── 响应工具 ────────────────────── */

/**
 * 解析 Range 头。
 * @param header - req.headers.range。
 * @param size - 文件字节数。
 * @returns { start, end } 或 null（整文件）。
 */
function parseRange(header, size) {
  if (typeof header !== 'string') return null
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
  if (!m) return null
  const hasStart = m[1] !== ''
  const hasEnd = m[2] !== ''
  if (!hasStart && !hasEnd) return null
  let start
  let end
  if (hasStart) {
    start = Number(m[1])
    end = hasEnd ? Number(m[2]) : size - 1
  } else {
    start = Math.max(0, size - Number(m[2]))
    end = size - 1
  }
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null
  if (start < 0 || end < start || start >= size) return null
  return { start, end: Math.min(end, size - 1) }
}

/**
 * 流式返回文件；支持 Range 与 HEAD。
 * @param req - Node 请求。
 * @param res - Node 响应。
 * @param target - 文件绝对路径。
 * @param type - MIME。
 * @param size - 字节数。
 */
function streamFile(req, res, target, type, size) {
  const range = parseRange(req.headers && req.headers.range, size)
  if (range === null) {
    res.writeHead(200, {
      'content-type': type,
      'content-length': size,
      'accept-ranges': 'bytes',
      'cache-control': 'no-cache',
    })
    if (req.method === 'HEAD') return res.end()
    createReadStream(target).pipe(res)
    return
  }
  res.writeHead(206, {
    'content-type': type,
    'content-length': range.end - range.start + 1,
    'content-range': `bytes ${range.start}-${range.end}/${size}`,
    'accept-ranges': 'bytes',
    'cache-control': 'no-cache',
  })
  if (req.method === 'HEAD') return res.end()
  createReadStream(target, { start: range.start, end: range.end }).pipe(res)
}

/* ────────────────────── 翻译（PDFMathTranslate） ────────────────────── */

/**
 * 读请求体并解析 JSON。
 * @param req - Node 请求。
 * @returns 解析后的对象。
 */
function readJsonBody(req) {
  return new Promise((resolveBody, rejectBody) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > 2 * 1024 * 1024) {
        rejectBody(new Error('请求体过大'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      try {
        resolveBody(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'))
      } catch (error) {
        rejectBody(error)
      }
    })
    req.on('error', rejectBody)
  })
}

/**
 * 手工拼 multipart（对齐 PDFMathTranslate 服务的 /v1/translate 契约：
 * data 段是 application/json，file 段是 application/pdf）。
 * @param pdfPath - 本地 PDF 路径。
 * @returns { body, contentType }
 */
function multipartPdf(pdfPath) {
  const boundary = '----ai-library-' + Date.now().toString(16) + Math.random().toString(16).slice(2)
  const options = JSON.stringify({ lang_in: 'en', lang_out: 'zh', service: 'google', thread: 2 })
  const head = Buffer.from(
    `--${boundary}\r\n` +
      'Content-Disposition: form-data; name="data"\r\n' +
      'Content-Type: application/json\r\n\r\n' +
      options +
      '\r\n' +
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="file"; filename="${basename(pdfPath)}"\r\n` +
      'Content-Type: application/pdf\r\n\r\n',
    'utf8',
  )
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8')
  return {
    head,
    tail,
    contentType: 'multipart/form-data; boundary=' + boundary,
    filePath: pdfPath,
  }
}

/**
 * 统一包一层的翻译服务请求：网络错误时给出人话。
 * @param path - 服务内路径。
 * @param options - fetch 选项。
 * @returns Response。
 */
async function serviceFetch(path, options) {
  try {
    return await fetch(TRANSLATE_URL + path, options)
  } catch (error) {
    throw new Error(
      '翻译服务连不上（' +
        TRANSLATE_URL +
        '）。先启动它（例如 docker compose up -d 起 PDFMathTranslate 服务）。',
    )
  }
}

/**
 * 提交翻译任务。
 * @param pdfPath - 本地 PDF。
 * @returns 服务返回的 JSON（含 id）。
 */
async function submitTranslation(pdfPath) {
  const { head, tail, contentType } = multipartPdf(pdfPath)
  const pdf = await readFile(pdfPath)
  const res = await serviceFetch('/v1/translate', {
    method: 'POST',
    headers: { 'content-type': contentType },
    body: Buffer.concat([head, pdf, tail]),
  })
  const text = await res.text()
  if (!res.ok) throw new Error('翻译服务返回 ' + res.status + '：' + text.slice(0, 200))
  return JSON.parse(text)
}

/**
 * 取任务状态。
 * @param taskId - 任务号。
 * @returns 服务返回的 JSON（原样透传，字段随服务版本变化）。
 */
async function translationStatus(taskId) {
  const res = await serviceFetch('/v1/translate/' + encodeURIComponent(taskId))
  const text = await res.text()
  if (!res.ok) throw new Error('翻译服务返回 ' + res.status + '：' + text.slice(0, 200))
  return JSON.parse(text)
}

/**
 * 下载译文并按任务号缓存。
 * @param taskId - 任务号。
 * @param variant - mono（中文）或 dual（双语）。
 * @returns 缓存后的本地路径。
 */
async function translationFile(taskId, variant) {
  if (variant !== 'mono' && variant !== 'dual') throw new Error('variant 只能是 mono 或 dual')
  const cached = join(TRANSLATE_CACHE, taskId + '-' + variant + '.pdf')
  if (existsSync(cached)) return cached

  const res = await serviceFetch('/v1/translate/' + encodeURIComponent(taskId) + '/' + variant, {
    signal: AbortSignal.timeout(180000),
  })
  if (!res.ok) throw new Error('取译文失败：HTTP ' + res.status)
  const buf = Buffer.from(await res.arrayBuffer())
  if (buf.subarray(0, 1024).indexOf('%PDF') === -1) throw new Error('译文不是有效 PDF')
  await mkdir(TRANSLATE_CACHE, { recursive: true })
  await writeFile(cached, buf)
  return cached
}

/* ────────────────────── 插件市场（api.dshmk.com） ────────────────────── */

/**
 * 探测代理。Node 的 fetch 不读系统代理，而 api.dshmk.com 在 Cloudflare 上，
 * 直连基本超时，所以优先环境变量，其次 Windows 注册表里的系统代理。
 * @returns 代理 URL，或空串表示直连。
 */
async function detectProxy() {
  const fromEnv =
    process.env.HTTPS_PROXY || process.env.https_proxy || process.env.ALL_PROXY || process.env.all_proxy || ''
  if (fromEnv) return fromEnv
  try {
    const { stdout } = await execFileAsync(
      'reg',
      ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'],
      { timeout: 5000 },
    )
    const enabled = /ProxyEnable\s+REG_DWORD\s+0x1/i.test(stdout)
    const server = /ProxyServer\s+REG_SZ\s+(\S+)/i.exec(stdout)
    if (enabled && server) {
      const value = server[1]
      return /^https?:\/\//i.test(value) ? value : 'http://' + value
    }
  } catch (error) {
    /* 读不到注册表就当没有代理 */
  }
  return ''
}

/**
 * 用 curl 把目录下载到缓存文件（curl 会正确处理代理与 TLS）。
 * @param url - 目标地址。
 * @param file - 输出文件。
 * @param proxy - 代理 URL。
 */
async function curlToFile(url, file, proxy) {
  const args = ['-sS', '--fail', '--max-time', '300', '-A', 'ai-library/0.1', '-o', file]
  if (proxy) args.push('-x', proxy)
  args.push(url)
  await execFileAsync('curl.exe', args, { timeout: 320000, windowsHide: true })
}

/**
 * 原始目录是否够新。
 * @param file - 缓存文件。
 * @returns 是否可用。
 */
async function cacheFresh(file) {
  try {
    const info = await stat(file)
    return Date.now() - info.mtimeMs < MARKET_TTL_MS
  } catch {
    return false
  }
}

/** 市场分类英文 → 中文。 */
const MARKET_CATEGORY = {
  development: '开发',
  'agent-session': '会话',
  data: '数据',
  security: '安全',
  ui: '界面',
  communication: '通信',
  operations: '运维',
  'model-mcp': '模型 / MCP',
  research: '研究',
  lifestyle: '生活',
}

/**
 * 把市场条目转成图书馆条目。
 * @param repo - 市场 API 里的一条仓库。
 * @param today - 收录日期。
 * @returns 图书馆条目。
 */
function marketRepoToItem(repo, today) {
  const candidates = repo && repo.install && Array.isArray(repo.install.candidates) ? repo.install.candidates : []
  const npm = candidates.find((c) => c && c.source === 'npm' && c.command) || candidates.find((c) => c && c.command)
  const category = MARKET_CATEGORY[repo.category] || repo.category || '未分类'
  return {
    id: 'm-' + String(repo.repositoryId || repo.id || repo.fullName).replace(/[^A-Za-z0-9._-]/g, '-').toLowerCase(),
    kind: 'market',
    status: 'available',
    title: repo.name || repo.fullName || '(未命名)',
    summary: String(repo.description || '').replace(/\s+/g, ' ').slice(0, 140),
    source: repo.fullName || '',
    version: '',
    fit: '',
    tags: Array.isArray(repo.topics) ? repo.topics.slice(0, 5) : [],
    tools: [],
    install: npm && npm.command ? npm.command : '',
    link: repo.url || (repo.fullName ? 'https://github.com/' + repo.fullName : ''),
    notes: [
      '★ ' + (repo.stars || 0) + ' · fork ' + (repo.forks || 0) + ' · issue ' + (repo.openIssues || 0),
      '分类：' + category,
      '验证：' + (repo.verified ? '通过' : '未验证'),
      repo.pushedAt ? '最近推送：' + String(repo.pushedAt).slice(0, 10) : '',
    ].filter(Boolean),
    group: category,
    added: today,
  }
}

/**
 * 同步插件市场：拉目录 → 转条目 → 写 market-items.js。
 * @param force - 是否忽略缓存。
 * @returns 摘要。
 */
async function syncMarket(force) {
  const fresh = !force && (await cacheFresh(MARKET_CACHE))
  if (!fresh) {
    await mkdir(CACHE_DIR, { recursive: true })
    const proxy = await detectProxy()
    await curlToFile(MARKET_URL, MARKET_CACHE, proxy)
  }

  const raw = await readFile(MARKET_CACHE, 'utf8')
  const catalog = JSON.parse(raw)
  const repos = Array.isArray(catalog.repositories) ? catalog.repositories : []
  if (repos.length === 0) throw new Error('市场目录里没有 repositories')

  const today = new Date().toISOString().slice(0, 10)
  const sorted = repos.slice().sort((a, b) => (b.stars || 0) - (a.stars || 0))
  const items = sorted.slice(0, MARKET_LIMIT).map((repo) => marketRepoToItem(repo, today))
  const groups = {}
  for (const item of items) groups[item.id] = item.group

  const payload = {
    source: 'api.dshmk.com',
    generatedAt: catalog.generatedAt || today,
    syncedAt: new Date().toISOString(),
    total: repos.length,
    items,
    groups,
  }
  await writeFile(MARKET_FILE, '/* 自动生成，勿手改。面板点「同步市场」重新生成。 */\n' + 'window.LIBRARY_MARKET = ' + JSON.stringify(payload, null, 1) + ';\n', 'utf8')

  return { total: repos.length, kept: items.length, generatedAt: payload.generatedAt }
}

/* ────────────────────── MotionSites 提示词库（只读挂载） ────────────────────── */

/**
 * 把 MotionSites 的 catalog-meta 转成图书馆条目。
 * 不复制任何文件：预览图和提示词都通过 /api/ai-library/motion 现读。
 * @returns { items, groups } 或 null（目录不存在时）。
 */
async function loadMotionSites() {
  try {
    const raw = await readFile(join(MOTION_DIR, 'data', 'catalog-meta.json'), 'utf8')
    const list = JSON.parse(raw)
    if (!Array.isArray(list)) return null

    /* 复刻站点的分类口径：topCategories = 按数量排序的前 9 个 category，其余归「其他」 */
    const catCount = new Map()
    for (const card of list) {
      const name = (card && card.category) || '未分类'
      catCount.set(name, (catCount.get(name) || 0) + 1)
    }
    const topNine = [...catCount.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 9)
      .map(([name]) => name)
    const topSet = new Set(topNine)

    const today = new Date().toISOString().slice(0, 10)
    const items = []
    /* id → 分组名，和 market-items.js 的结构保持一致，前端第二级树要用 */
    const groups = {}
    for (const card of list) {
      if (!card || !card.id) continue
      const variants = []
      const rel = String(card.local_rel || '')
      if (rel) {
        const isVideo = /\.(mp4|webm)$/i.test(rel)
        variants.push({ label: isVideo ? '预览视频' : '预览图', src: MOTION_ROUTE + '?path=' + encodeURIComponent(rel) })
      }
      if (existsSync(join(MOTION_DIR, 'data', 'catalog-text', card.id + '.txt'))) {
        variants.push({ label: '提示词', src: MOTION_ROUTE + '?path=' + encodeURIComponent('data/catalog-text/' + card.id + '.txt') })
      }

      items.push({
        id: 'ms-' + String(card.id).replace(/[^A-Za-z0-9._-]/g, '-').toLowerCase(),
        kind: 'prompt',
        status: 'available',
        title: card.title || card.id,
        summary: String(card.description || '').replace(/\s+/g, ' ').slice(0, 140),
        source: 'MotionSites',
        version: '',
        fit: card.type || '',
        tags: [card.category, card.is_free ? '免费' : '付费', card.local_kind].filter(Boolean),
        tools: [],
        install: '',
        link: '',
        notes: [
          '分类：' + (card.category || '未分类'),
          '类型：' + (card.type || '—'),
          '来源：' + (card.source_kind || '—'),
          card.is_free ? '免费' : '付费',
        ],
        preview: { variants },
        /* 前 9 个 category 单独成组，其余归「其他」——与站点的 topCategories 口径一致 */
        group: topSet.has(card.category) ? card.category : '其他',
        added: today,
      })
      groups[items[items.length - 1].id] = items[items.length - 1].group
    }
    return { items, groups }
  } catch (error) {
    return null
  }
}


﻿/**
 * 读 items/prompts/*.md 里的「我的提示词」。
 * 文件名以下划线开头的跳过（_TEMPLATE.md 就是模板）。
 * @returns { items, groups } 或 null。
 */
async function loadMyPrompts() {
  const dir = join(ITEMS_DIR, 'prompts')
  let names
  try {
    names = await readdir(dir)
  } catch (error) {
    return null
  }

  const items = []
  const groups = {}
  for (const name of names) {
    if (!name.toLowerCase().endsWith('.md') || name.startsWith('_')) continue
    let source
    try {
      source = await readFile(join(dir, name), 'utf8')
    } catch (error) {
      continue
    }

    /* --- 前置元信息 --- */
    let body = source
    const meta = {}
    const fm = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(source)
    if (fm) {
      body = source.slice(fm[0].length)
      for (const line of fm[1].split(/\r?\n/)) {
        const m = /^([A-Za-z_-]+)\s*:\s*(.*)$/.exec(line.trim())
        if (m) meta[m[1].toLowerCase()] = m[2].trim()
      }
    }

    const heading = /^#\s+(.+)$/m.exec(body)
    const title = meta.title || (heading ? heading[1].trim() : name.replace(/\.md$/i, ''))
    const rest = body
      .replace(/^---[\s\S]*?---\r?\n?/, '')
      .replace(/^#\s+.+$/m, '')
      .trim()
    const summary = meta.summary || rest.split(/\r?\n\r?\n/).find((p) => p.trim()) || ''
    const category = meta.category || '我的提示词'
    const tags = (meta.tags || '').split(',').map((t) => t.trim()).filter(Boolean)

    const id = 'my-' + name.replace(/\.md$/i, '').toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-')
    items.push({
      id,
      kind: 'prompt',
      status: 'available',
      title,
      summary: String(summary).replace(/\s+/g, ' ').slice(0, 150),
      source: '我的提示词',
      version: '',
      fit: '',
      tags,
      tools: [],
      install: '',
      link: '',
      notes: ['分类：' + category, '文件：items/prompts/' + name],
      preview: { variants: [{ label: '提示词', src: 'prompts/' + name }] },
      group: category,
      added: new Date().toISOString().slice(0, 10),
    })
    groups[id] = category
  }

  if (items.length === 0) return null
  return { items, groups }
}

/**
 * 注册路由。
 * @param ctx - Cordis 插件上下文。
 */
/**
 * 启动追踪：append 到 .cache/apply-trace.jsonl。
 * 带 pid / electron 标记，用来区分「真实应用启动」和「本地 node 垫片」。
 * @param stage 阶段名
 * @param extra 附加字段
 */
function trace(stage, extra) {
  try {
    mkdirSync(CONFIG.cacheDir, { recursive: true })
    const line = JSON.stringify({
      at: new Date().toISOString(),
      pid: process.pid,
      electron: process.versions.electron || null,
      stage,
      ...(extra || {}),
    })
    appendFileSync(CONFIG.cacheDir + '/apply-trace.jsonl', line + String.fromCharCode(10))
  } catch {
    /* 追踪失败不影响启动 */
  }
}

export function apply(ctx) {
  try {
    applyInner(ctx)

    /* 系统提示词：告诉 AI「本机产物要自动入库」（用 ctx.inject 拿服务，缺服务也不影响插件） */
    try {
      registerLibraryPrompt(ctx, { root: CONFIG.root, toolsEnabled: CONFIG.toolsEnabled !== false })
    } catch {
      /* 提示词注册失败不影响面板与工具 */
    }

    /* 启动后台自动同步插件市场：缓存过期就拉一次，用户不用手动点「同步市场」。
       延迟 6 秒，避开启动高峰；失败静默（下次打开面板还会手动兜底）。 */
    if (CONFIG.marketEnabled !== false) {
      const timer = setTimeout(() => {
        Promise.resolve()
          .then(() => syncMarket(false))
          .catch(() => {})
      }, 6000)
      if (timer && typeof timer.unref === 'function') timer.unref()
    }

    trace('apply-done')
  } catch (error) {
    /* 失败不能只留一行 trace：先输出到标准错误，再尝试宿主 logger（Cordis ctx 是 Proxy，读到未声明的会抛） */
    try {
      console.error('[ai-library] apply 失败：' + String((error && error.stack) || error))
    } catch {
      /* 忽略 */
    }
    try {
      if (ctx && typeof ctx.logger === 'object' && ctx.logger && typeof ctx.logger.error === 'function') {
        ctx.logger.error('[ai-library] apply 失败：' + String((error && error.message) || error))
      }
    } catch {
      /* inject 没声明 logger 时读它会抛，忽略 */
    }
    trace('apply-failed', { message: String((error && error.message) || error), stack: String((error && error.stack) || '').slice(0, 900) })
  }
}

/** 真正的 apply 主体（外面套了 try/catch，出错不会带崩应用）。 */
function applyInner(ctx) {
  /* ⚠️ 不要在这里读 ctx.tools：inject 里没有的服务，Cordis 的 Proxy 一碰就抛
     "cannot get property \"tools\" without inject"。 */
  trace('apply-enter', {
    hasTools: (() => {
      try {
        return !!ctx.tools
      } catch {
        return 'blocked'
      }
    })(),
    hasWebServer: !!(ctx && ctx.webServer),
    hasEffect: typeof (ctx && ctx.effect) === 'function',
    inject: ['webServer'],
    toolsEnabled: CONFIG.toolsEnabled !== false,
  })
  /* 工具只注册一次，且放在 effect 之外：effect 回调可能被重跑，
     重复 register 会抛「已注册」并把宿主带崩。 */
  if (CONFIG.toolsEnabled !== false) {
    registerTools(ctx, {
      CONFIG,
      loadAll,
      loadUserItems,
      saveUserItems,
      sanitizeItem,
      safeTarget,
      submitTranslation,
      translationStatus,
    })
  }

  ctx.effect(() => {
    const offData = ctx.webServer.register({
      kind: 'exact',
      path: ROUTE,
      async handler(req, res) {
        try {
          const data = await loadAll()
          res.writeHead(200, {
            'content-type': 'application/json; charset=utf-8',
            'cache-control': 'no-store',
          })
          /* 把读取失败原因也带出去，面板能提示（不再只塞进 globalThis） */
          res.end(JSON.stringify({
            ok: true,
            ...data,
            env: {
              ...(data.env || {}),
              root: CONFIG.root,
              accent: CONFIG.accent,
              itemsDir: CONFIG.itemsDir,
              libraryError: globalThis.__ailibLibraryError || '',
              configError: globalThis.__ailibConfigError || '',
            },
          }))
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify({ ok: false, message }))
        }
      },
    })

    const offFile = ctx.webServer.register({
      kind: 'exact',
      path: FILE_ROUTE,
      async handler(req, res) {
        let url
        try {
          url = new URL(req.url || '/', 'http://127.0.0.1')
        } catch {
          return text(res, 400, 'bad url')
        }

        let target = safeTarget(url.searchParams.get('name'))
        if (target === null) return text(res, 403, 'forbidden path')

        let info
        try {
          info = await stat(target)
        } catch {
          return text(res, 404, 'not found')
        }
        if (!info.isFile()) return text(res, 404, 'not a file')

        const ext = extname(target).toLowerCase()

        // Markdown：现场渲染成 HTML
        if (ext === '.md' || ext === '.markdown') {
          try {
            const html = mdToHtml(await readFile(target, 'utf8'))
            const body = Buffer.from(html, 'utf8')
            res.writeHead(200, {
              'content-type': 'text/html; charset=utf-8',
              'content-length': body.length,
              'cache-control': 'no-store',
            })
            return res.end(body)
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            return text(res, 500, 'markdown render failed: ' + message)
          }
        }

        // Office：转 PDF
        if (OFFICE_EXT.has(ext)) {
          try {
            target = await convertToPdf(target)
            info = await stat(target)
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            return text(res, 500, 'office 转换失败：' + message)
          }
          streamFile(req, res, target, 'application/pdf', info.size)
          return
        }

        // 其余：按 MIME 直接返回
        const type = MIME[ext] || 'application/octet-stream'
        streamFile(req, res, target, type, info.size)
      },
    })

    // pdf.js 静态资源：lib / worker / 标准字体 / cmaps，只读 vendor 目录
    const VENDOR_MIME = { '.mjs': 'text/javascript; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.ttf': 'font/ttf', '.bcmap': 'application/octet-stream' }
    const offVendor = ctx.webServer.register({
      kind: 'prefix',
      path: VENDOR_ROUTE,
      async handler(req, res) {
        let name
        try {
          name = decodeURIComponent(
            new URL(req.url || '/', 'http://127.0.0.1').pathname.slice(VENDOR_ROUTE.length).replace(/^\/+/, ''),
          )
        } catch {
          return text(res, 400, 'bad url')
        }
        const cleaned = normalize(name)
        if (cleaned === '' || cleaned.includes('..') || /^[A-Za-z]:/.test(cleaned)) {
          return text(res, 403, 'forbidden path')
        }

        const base = resolve(VENDOR_DIR)
        const target = resolve(base, cleaned)
        if (!target.startsWith(base + sep)) return text(res, 403, 'forbidden path')

        let info
        try {
          info = await stat(target)
        } catch {
          return text(res, 404, 'not found')
        }
        if (!info.isFile()) return text(res, 404, 'not found')

        res.writeHead(200, {
          'content-type': VENDOR_MIME[extname(target).toLowerCase()] || 'application/octet-stream',
          'content-length': info.size,
          // 版本固定，可以长缓存
          'cache-control': 'public, max-age=604800',
        })
        if (req.method === 'HEAD') return res.end()
        createReadStream(target).pipe(res)
      },
    })

    // 客户端错误上报：渲染进程把异常 POST 上来，落盘 .cache/client.log
    const offClientLog = ctx.webServer.register({
      kind: 'exact',
      path: CLIENT_LOG_ROUTE,
      async handler(req, res) {
        if (rejectForeign(req, res)) return
        const body = Buffer.from('{"ok":true}', 'utf8')
        try {
          if (req.method === 'POST') {
            const data = await readJsonBody(req)
            await mkdir(CACHE_DIR, { recursive: true })
            const line = JSON.stringify({ at: new Date().toISOString(), ...(data || {}) })
            const { appendFile, stat: st } = await import('node:fs/promises')
            const file = join(CACHE_DIR, 'client.log').split(sep).join('/')
            let size = 0
            try {
              size = (await st(file)).size
            } catch {
              size = 0
            }
            if (size > 256 * 1024) await writeFile(file, '', 'utf8')
            await appendFile(file, line + '\n', 'utf8')
          }
        } catch {
          /* 上报失败不影响任何功能 */
        }
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'content-length': body.length })
        res.end(body)
      },
    })

    // 大类管理：POST 新建 · PATCH 改名 · DELETE 删除
    const offBucket = ctx.webServer.register({
      kind: 'exact',
      path: BUCKET_ROUTE,
      async handler(req, res) {
        if (rejectForeign(req, res)) return
        const sendJson = (code, payload) => {
          const body = Buffer.from(JSON.stringify(payload), 'utf8')
          res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'content-length': body.length, 'cache-control': 'no-store' })
          res.end(body)
        }
        try {
          const list = await loadBuckets()
          if (req.method === 'POST') {
            const raw = await readJsonBody(req)
            const label = String((raw && raw.label) || '').trim()
            if (!label) return sendJson(400, { ok: false, message: '缺少名称' })
            const id = String((raw && raw.id) || '').trim() || 'b-' + Date.now().toString(36)
            if (list.some((b) => b.id === id)) return sendJson(409, { ok: false, message: '已存在同名 id' })
            if (list.some((b) => b.label === label)) return sendJson(409, { ok: false, message: '已存在同名大类' })
            const maxOrder = list.reduce((m, b) => Math.max(m, Number(b.order) || 0), 0)
            list.push({ id, label, order: maxOrder + 1, kinds: [] })
            await saveBuckets(list)
            return sendJson(200, { ok: true, bucket: list[list.length - 1] })
          }
          if (req.method === 'PATCH') {
            const raw = await readJsonBody(req)
            const id = String((raw && raw.id) || '').trim()
            const label = String((raw && raw.label) || '').trim()
            if (!id || !label) return sendJson(400, { ok: false, message: '缺少 id 或 label' })
            const hit = list.find((b) => b.id === id)
            if (!hit) return sendJson(404, { ok: false, message: '大类不存在' })
            hit.label = label
            await saveBuckets(list)
            return sendJson(200, { ok: true, bucket: hit })
          }
          if (req.method === 'DELETE') {
            let id = ''
            try {
              id = String(new URL(req.url || '/', 'http://127.0.0.1').searchParams.get('id') || '').trim()
            } catch {
              return sendJson(400, { ok: false, message: 'bad url' })
            }
            if (!id) return sendJson(400, { ok: false, message: '缺少 id' })
            if (id === 'other') return sendJson(400, { ok: false, message: '「未归类」不能删' })
            const next = list.filter((b) => b.id !== id)
            if (next.length === list.length) return sendJson(404, { ok: false, message: '大类不存在' })
            await saveBuckets(next)
            return sendJson(200, { ok: true })
          }
          return sendJson(405, { ok: false, message: '不支持的方法' })
        } catch (error) {
          return sendJson(502, { ok: false, message: error instanceof Error ? error.message : String(error) })
        }
      },
    })

    // 一键安装：POST { name, profile } → 跑 dsh plugin add
    /**
     * 只允许本机来源。
     * 注意：`<img>` / `<script>` 这类跨源加载不发 Origin，但有 Referer；
     * 所以两者都查，恶意页面既刷不了 /paper 配额，也拿不到数据。
     * dsh-app:// 与 127.0.0.1/localhost 放行；外部网页（Origin 是别人的域名）一律 403。
     * 没带 Origin 的请求（本进程内的 fetch、curl）放行。
     * @returns true 表示已拒绝并写好响应
     */
    function rejectForeign(req, res) {
      const origin = String((req.headers && (req.headers.origin || req.headers.referer)) || '')
      if (!origin) return false
      if (/^(dsh-app:|file:|app:)/i.test(origin)) return false
      if (/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?\/?$/i.test(origin)) return false
      const body = Buffer.from(JSON.stringify({ ok: false, message: '只接受本机请求（Origin 不被允许）' }), 'utf8')
      res.writeHead(403, { 'content-type': 'application/json; charset=utf-8', 'content-length': body.length })
      res.end(body)
      return true
    }

    /** Windows 命令行参数转义 */
    function quoteWinArg(value) {
      const s = String(value)
      if (!s) return '""'
      if (!/[\s"&|<>^()%!]/.test(s)) return s
      return '"' + s.replace(/"/g, '""') + '"'
    }

    /**
     * 跨平台执行外部命令。
     * Windows 上 execFile 直接跑 .cmd/.bat 会抛 spawn EINVAL（Node ≥ 20 的安全限制），
     * 必须经 cmd.exe /d /s /c。纯 .exe（git.exe 等）直接跑更安全。
     * @param cmd 可执行文件（可含 .cmd）
     * @param args 参数数组
     * @param opts execFile 选项
     */
    async function execCli(cmd, args, opts = {}) {
      const { execFile } = await import('node:child_process')
      const { promisify } = await import('node:util')
      const run = promisify(execFile)
      const isWin = process.platform === 'win32'
      if (!isWin) return run(cmd, args, opts)
      const bare = String(cmd)
      const hasExt = /\.[a-z0-9]+$/i.test(bare)
      /* 带扩展名的 .exe 直接跑；.cmd/.bat 或无扩展名（让 cmd 自己按 PATH 解析）走 cmd.exe */
      if (hasExt && !/\.(cmd|bat)$/i.test(bare)) return run(bare, args, opts)
      const line = [bare, ...args].map(quoteWinArg).join(' ')
      const comspec = process.env.ComSpec || 'C:\\Windows\\System32\\cmd.exe'
      return run(comspec, ['/d', '/s', '/c', '"' + line + '"'], {
        ...opts,
        windowsHide: true,
        windowsVerbatimArguments: true,
      })
    }

    /**
     * 找到 dsh CLI：环境变量 → 从安装目录推 → PATH。
     * @returns CLI 路径或命令名
     */
    function deriveDshCli() {
      try {
        const exeDir = join(process.execPath, '..')
        const cands = [
          join(exeDir, 'resources', 'runtime', 'cli', 'bin', 'dsh.cmd'),
          join(exeDir, 'resources', 'runtime', 'cli', 'bin', 'dsh'),
          join(exeDir, 'runtime', 'cli', 'bin', 'dsh.cmd'),
          join(exeDir, 'cli', 'bin', 'dsh.cmd'),
          join(homedir(), '.local', 'bin', 'dsh.cmd'),
          join(homedir(), '.local', 'bin', 'dsh'),
        ]
        for (const cand of cands) if (existsSync(cand)) return cand
      } catch {
        /* 忽略 */
      }
      return process.platform === 'win32' ? 'dsh.cmd' : 'dsh'
    }

    // 自更新：本地 git 目录就 pull；npm 安装的重装最新版
    const offUpdate = ctx.webServer.register({
      kind: 'exact',
      path: UPDATE_ROUTE,
      async handler(req, res) {
        if (rejectForeign(req, res)) return
        const sendJson = (code, payload) => {
          const body = Buffer.from(JSON.stringify(payload), 'utf8')
          res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'content-length': body.length, 'cache-control': 'no-store' })
          res.end(body)
        }
        if (req.method !== 'POST') return sendJson(405, { ok: false, message: '只支持 POST' })
        try {
          const { execFile } = await import('node:child_process')
          const { promisify } = await import('node:util')
          const execFileAsync = promisify(execFile)
          const gitDir = join(PLUGIN_DIR, '.git')

          /* ① 本地目录安装（开发环境）：git pull --ff-only */
          if (existsSync(gitDir)) {
            const before = (await execFileAsync('git', ['-C', PLUGIN_DIR, 'rev-parse', '--short', 'HEAD'], { timeout: 30000 })).stdout.trim()
            let output = ''
            try {
              const r = await execFileAsync('git', ['-C', PLUGIN_DIR, 'pull', '--ff-only'], { timeout: 120000, maxBuffer: 8 * 1024 * 1024 })
              output = String(r.stdout || '') + String(r.stderr || '')
            } catch (error) {
              return sendJson(502, {
                ok: false,
                mode: 'git',
                message: 'git pull 失败：' + String((error && (error.stderr || error.message)) || error).slice(-300),
              })
            }
            const after = (await execFileAsync('git', ['-C', PLUGIN_DIR, 'rev-parse', '--short', 'HEAD'], { timeout: 30000 })).stdout.trim()
            return sendJson(200, {
              ok: true,
              mode: 'git',
              changed: before !== after,
              before,
              after,
              output: output.slice(-800),
              note: before === after ? '已是最新版本' : '已更新到 ' + after + '，重启 DSH 生效',
            })
          }

          /* ② npm 安装的：重装拿最新版 */
          const cli = process.env.DSH_CLI || deriveDshCli()
          try {
            const r = await execCli(cli, ['plugin', '--profile', (process.env.DSH_PROFILE || 'desktop'), 'add', 'dsh-ai-library'], { timeout: 240000, maxBuffer: 8 * 1024 * 1024 })
            return sendJson(200, {
              ok: true,
              mode: 'npm',
              changed: null,
              output: String(r.stdout || '').slice(-800),
              note: '已重装 dsh-ai-library（最新版），重启 DSH 生效',
            })
          } catch (error) {
            return sendJson(502, {
              ok: false,
              mode: 'npm',
              message: '更新失败：' + String((error && (error.stderr || error.message)) || error).slice(-300),
            })
          }
        } catch (error) {
          return sendJson(502, { ok: false, message: String((error && error.message) || error).slice(-300) })
        }
      },
    })

        /**
     * 把「刚安装的插件」记进资料馆（user-items.json，kind: plugin）。
     * 同 id 的条目更新版本与备注，不重复堆。
     */
    async function recordInstalledPlugin(name, stdout, stderr) {
      const store = await loadUserItems()
      const entry = buildPluginEntry({
        name,
        stdout,
        stderr,
        profile: process.env.DSH_PROFILE || 'desktop',
      })
      const result = mergePluginEntry(store, entry)
      await saveUserItems(store)
      return result
    }

const offInstall = ctx.webServer.register({
      kind: 'exact',
      path: INSTALL_ROUTE,
      async handler(req, res) {
        if (rejectForeign(req, res)) return
        const sendJson = (code, payload) => {
          const body = Buffer.from(JSON.stringify(payload), 'utf8')
          res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'content-length': body.length, 'cache-control': 'no-store' })
          res.end(body)
        }
        if (req.method !== 'POST') return sendJson(405, { ok: false, message: '只支持 POST' })
        try {
          const raw = await readJsonBody(req)
          const name = String((raw && raw.name) || '').trim()
          if (!/^(@[\w.-]+\/)?[\w.-]+(@[\w.-]+)?$/.test(name)) return sendJson(400, { ok: false, message: '插件名不合法' })
          /* 不写死机器路径：优先 DSH_CLI，其次从当前可执行文件推安装目录，最后退回 PATH 里的 dsh */
          const cli = process.env.DSH_CLI || deriveDshCli()
          const { stdout, stderr } = await execCli(cli, ['plugin', '--profile', (process.env.DSH_PROFILE || 'desktop'), 'add', name], { timeout: 240000, maxBuffer: 8 * 1024 * 1024 })

          /* 按规矩：装完插件要记进资料馆（kind: plugin） */
          let recorded = null
          try {
            recorded = await recordInstalledPlugin(name, String(stdout || ''), String(stderr || ''))
          } catch (error) {
            recorded = { ok: false, message: String((error && error.message) || error).slice(0, 200) }
          }

          return sendJson(200, {
            ok: true,
            name,
            output: String(stdout || '').slice(-1200),
            warn: String(stderr || '').slice(-600),
            recorded,
            note: recorded && recorded.ok
              ? '已安装，并在资料馆里记录了一条（kind: plugin）'
              : '已安装，但自动记录资料馆失败：' + ((recorded && recorded.message) || '未知原因'),
          })
        } catch (error) {
          return sendJson(502, { ok: false, message: String((error && (error.stderr || error.message)) || error).slice(-800) })
        }
      },
    })

    // GitHub 仓库信息：GET ?repo=owner/name → 描述 / star / OG 预览图
    const offRepo = ctx.webServer.register({
      kind: 'exact',
      path: REPO_ROUTE,
      async handler(req, res) {
        const sendJson = (code, payload) => {
          const body = Buffer.from(JSON.stringify(payload), 'utf8')
          res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'content-length': body.length, 'cache-control': 'no-store' })
          res.end(body)
        }
        try {
          let repo = ''
          try {
            repo = String(new URL(req.url || '/', 'http://127.0.0.1').searchParams.get('repo') || '').trim()
          } catch {
            return sendJson(400, { ok: false, message: 'bad url' })
          }
          if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) return sendJson(400, { ok: false, message: 'repo 必须是 owner/name' })
          const cacheFile = join(CACHE_DIR, 'repo', repo.replace('/', '__') + '.json').split(sep).join('/')
          try {
            const cached = JSON.parse(await readFile(cacheFile, 'utf8'))
            if (Date.now() - Number(cached.at || 0) < 6 * 3600 * 1000) return sendJson(200, cached)
          } catch {
            /* 没缓存 */
          }
          const res2 = await fetch('https://api.github.com/repos/' + repo, {
            headers: { accept: 'application/vnd.github+json', 'user-agent': 'dsh-ai-library' },
          })
          if (!res2.ok) return sendJson(502, { ok: false, message: 'GitHub API ' + res2.status })
          const meta = await res2.json()
          const payload = {
            ok: true,
            at: Date.now(),
            repo,
            fullName: meta.full_name,
            description: meta.description || '',
            stars: meta.stargazers_count || 0,
            language: meta.language || '',
            topics: (meta.topics || []).slice(0, 8),
            homepage: meta.homepage || '',
            htmlUrl: meta.html_url || ('https://github.com/' + repo),
            /* GitHub 的社交预览图，就是仓库分享出去时那张图 */
            ogImage: 'https://opengraph.githubassets.com/1/' + repo,
            pushedAt: meta.pushed_at || '',
          }
          await mkdir(join(CACHE_DIR, 'repo'), { recursive: true })
          await writeFile(cacheFile, JSON.stringify(payload), 'utf8')
          return sendJson(200, payload)
        } catch (error) {
          return sendJson(502, { ok: false, message: error instanceof Error ? error.message : String(error) })
        }
      },
    })

    // 兼容性：GET ?name=xxx → 版本 / peer 要求 / 是否兼容当前 DSH
    const offCompat = ctx.webServer.register({
      kind: 'exact',
      path: COMPAT_ROUTE,
      async handler(req, res) {
        const sendJson = (code, payload) => {
          const body = Buffer.from(JSON.stringify(payload), 'utf8')
          res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'content-length': body.length, 'cache-control': 'no-store' })
          res.end(body)
        }
        try {
          let name = ''
          try {
            name = String(new URL(req.url || '/', 'http://127.0.0.1').searchParams.get('name') || '').trim()
          } catch {
            return sendJson(400, { ok: false, message: 'bad url' })
          }
          if (!name) return sendJson(400, { ok: false, message: '缺少 name' })

          /* 当前 DSH 版本：profile 里的 dsh-app-boot 或 DSH_PROFILE 目录里的任意 @deepseek-ai 包 */
          const profileDir = process.env.DSH_PROFILE_DIR || join(CONFIG.root, '..').split(sep).join('/')
          let dshVersion = process.env.DSH_VERSION || ''
          if (!dshVersion) {
            for (const probe of ['@deepseek-ai/dsh-tools', '@deepseek-ai/dsh-web-app', '@deepseek-ai/dsh-app-boot']) {
              for (const base of [join(process.env.DSH_PROFILE_DIR || '', 'node_modules', ...probe.split('/')), join(process.resourcesPath || '', 'app.asar', 'dsh', 'node_modules', ...probe.split('/')), join(process.resourcesPath || '', 'app.asar', 'node_modules', ...probe.split('/'))]) {
                try {
                  const j = JSON.parse(await readFile(join(base, 'package.json'), 'utf8'))
                  if (j.version) { dshVersion = String(j.version); break }
                } catch { /* 下一个 */ }
              }
              if (dshVersion) break
            }
          }
          if (!dshVersion) dshVersion = 'unknown'

          /* 已安装？ */
          let installed = null
          try {
            const pkgs = [
              join(process.env.DSH_PROFILE_DIR || '', 'node_modules', name, 'package.json'),
              join(process.env.DSH_PROFILE_DIR || '', 'node_modules', ...name.split('/'), 'package.json'),
            ]
            for (const f of pkgs) {
              try {
                const j = JSON.parse(await readFile(f, 'utf8'))
                installed = { version: String(j.version || ''), peers: j.peerDependencies || {} }
                break
              } catch { /* 下一个 */ }
            }
          } catch { /* 未安装 */ }

          /* 没装就查 npm（缓存 6h） */
          let npmMeta = null
          if (!installed) {
            const cacheFile = join(CACHE_DIR, 'compat', name.replace(/[/@]/g, '_') + '.json').split(sep).join('/')
            try {
              const cached = JSON.parse(await readFile(cacheFile, 'utf8'))
              if (Date.now() - Number(cached.at || 0) < 6 * 3600 * 1000) npmMeta = cached.data
            } catch { /* 无缓存 */ }
            if (!npmMeta) {
              const r = await fetch('https://registry.npmjs.org/' + name.replace('/', '%2F'), { headers: { 'user-agent': 'dsh-ai-library' } })
              if (r.ok) {
                const meta = await r.json()
                const latest = meta['dist-tags'] && meta['dist-tags'].latest
                const v = latest && meta.versions && meta.versions[latest]
                npmMeta = { version: latest || '', peers: (v && v.peerDependencies) || {} }
                await mkdir(join(CACHE_DIR, 'compat'), { recursive: true })
                await writeFile(cacheFile, JSON.stringify({ at: Date.now(), data: npmMeta }), 'utf8')
              }
            }
          }

          const target = installed || npmMeta || { version: '', peers: {} }
          const peers = target.peers || {}
          const dshPeers = Object.entries(peers).filter(([k]) => k.startsWith('@deepseek-ai/'))

          /* 每个 peer 用自己的版本号比：cordis 归 cordis，dsh-* 归 DSH */
          const num = (v) => String(v).split('.').map((x) => parseInt(x, 10) || 0)
          const reasons = []
          let verdict = 'unknown'

          if (!dshPeers.length) {
            verdict = 'ok'
            reasons.push('没有声明版本依赖，通常不挑版本')
          } else {
            let hit = 0
            let miss = 0
            for (const [dep, range] of dshPeers) {
              /* 读这个 peer 在本机实际装的版本 */
              let actual = ''
              const rel = ['node_modules', ...dep.split('/'), 'package.json']
              const candidates = [
                join(process.env.DSH_PROFILE_DIR || '', ...rel),
                join(process.resourcesPath || '', 'app.asar', ...rel),
                join(process.resourcesPath || '', 'app.asar', 'dsh', ...rel),
              ]
              for (const f of candidates) {
                try {
                  actual = String(JSON.parse(await readFile(f, 'utf8')).version || '')
                  if (actual) break
                } catch {
                  /* 下一个位置 */
                }
              }
              if (!actual && dep.startsWith('@deepseek-ai/dsh-')) actual = dshVersion
              if (!actual) {
                reasons.push(dep + ' 要求 ' + range + '（本机版本未知，无法判定）')
                continue
              }
              /* 简化版 semver：把范围里出现的所有版本号取最小/最大，再看本机是否落在区间内 */
              const triple = (v) => {
                const m = /(\d+)\.(\d+)\.(\d+)/.exec(String(v))
                return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null
              }
              const cmp = (a, b) => (a[0] - b[0]) || (a[1] - b[1]) || (a[2] - b[2])
              const cur = triple(actual)
              const all = [...String(range).matchAll(/(\d+)\.(\d+)\.(\d+)/g)].map((m) => [Number(m[1]), Number(m[2]), Number(m[3])])
              let ok = false
              if (!cur || !all.length) {
                reasons.push(dep + ' 要求 ' + range + '（版本无法比对）')
                continue
              }
              const lo = all[0]
              const hi = all[all.length - 1]
              ok = cmp(cur, lo) >= 0 && cmp(cur, hi) <= 0
              if (ok) {
                hit += 1
                reasons.push(dep + ' 要求 ' + range + '，本机 ' + actual + ' ✅')
              } else {
                miss += 1
                reasons.push(dep + ' 要求 ' + range + '，本机 ' + actual + ' ⚠️')
              }
            }
            if (!hit && !miss) verdict = 'unknown'
            else verdict = miss ? 'warn' : 'ok'
          }

          return sendJson(200, {
            ok: true,
            name,
            dshVersion,
            installed: !!installed,
            version: target.version || '',
            peers: dshPeers.reduce((acc, [k, v]) => ((acc[k] = v), acc), {}),
            verdict,
            reasons,
          })
        } catch (error) {
          return sendJson(502, { ok: false, message: error instanceof Error ? error.message : String(error) })
        }
      },
    })

    // 预览图代理：GET ?repo=owner/name → 返回 og 图片字节（宿主有网络，渲染进程没有）
    const offOg = ctx.webServer.register({
      kind: 'exact',
      path: OG_ROUTE,
      async handler(req, res) {
        try {
          let repo = ''
          try {
            repo = String(new URL(req.url || '/', 'http://127.0.0.1').searchParams.get('repo') || '').trim()
          } catch {
            res.writeHead(400)
            return res.end()
          }
          if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) {
            res.writeHead(400)
            return res.end()
          }
          const dir = join(CACHE_DIR, 'og').split(sep).join('/')
          const file = dir + '/' + repo.replace(/[/.]/g, '_') + '.png'
          let buf = null
          try {
            buf = await readFile(file)
          } catch {
            buf = null
          }
          if (!buf) {
            const r = await fetch('https://opengraph.githubassets.com/1/' + repo, { headers: { 'user-agent': 'dsh-ai-library' } })
            if (!r.ok) {
              res.writeHead(502)
              return res.end()
            }
            buf = Buffer.from(await r.arrayBuffer())
            try {
              await mkdir(dir, { recursive: true })
              await writeFile(file, buf)
            } catch {
              /* 缓存失败无所谓 */
            }
          }
          res.writeHead(200, {
            'content-type': 'image/png',
            'content-length': buf.length,
            'cache-control': 'public, max-age=21600',
          })
          res.end(buf)
        } catch {
          try {
            res.writeHead(500)
            res.end()
          } catch {
            /* 已经结束 */
          }
        }
      },
    })

    // 压缩包目录：GET ?src=/api/ai-library/file?name=xxx.zip → 用 tar -tf 列条目（Windows 自带 bsdtar，支持 zip）
    const offArchive = ctx.webServer.register({
      kind: 'exact',
      path: ARCHIVE_ROUTE,
      async handler(req, res) {
        const sendJson = (code, payload) => {
          const body = Buffer.from(JSON.stringify(payload), 'utf8')
          res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'content-length': body.length, 'cache-control': 'no-store' })
          res.end(body)
        }
        try {
          let src = ''
          try {
            src = String(new URL(req.url || '/', 'http://127.0.0.1').searchParams.get('src') || '').trim()
          } catch {
            return sendJson(400, { ok: false, message: 'bad url' })
          }
          const m = /[?&]name=([^&]+)/.exec(src)
          if (!m) return sendJson(400, { ok: false, message: '只支持本地文件（需要 name 参数）' })
          /* 和 /file 用同一个 safeTarget：resolve + 前缀 + 拦 ..，避免 items-secret 这类同前缀目录穿透 */
          const abs = safeTarget(decodeURIComponent(m[1]))
          if (!abs) return sendJson(400, { ok: false, message: '非法路径' })
          try {
            await stat(abs)
          } catch {
            return sendJson(404, { ok: false, message: '文件不存在' })
          }
          const { execFile } = await import('node:child_process')
          const { promisify } = await import('node:util')
          const execFileAsync = promisify(execFile)
          /* 只用 -tf 列名字（-tvf 的列在不同平台/编码下不稳定，会把日期混进名字） */
          let out = ''
          try {
            const r = await execFileAsync('tar', ['-tf', abs], { timeout: 20000, maxBuffer: 8 * 1024 * 1024 })
            out = r.stdout
          } catch (e1) {
            return sendJson(502, { ok: false, message: '无法读取压缩包：' + String((e1 && (e1.stderr || e1.message)) || e1).slice(-200) })
          }
          const entries = []
          for (const line of String(out).split(/\r?\n/)) {
            const name = line.trim()
            if (!name) continue
            entries.push({ name, dir: name.endsWith('/') })
            if (entries.length >= 800) break
          }
          return sendJson(200, { ok: true, count: entries.length, entries })
        } catch (error) {
          return sendJson(502, { ok: false, message: String((error && error.message) || error).slice(-300) })
        }
      },
    })

    // 头像代理：GET ?repo=owner/name → owner 头像（渲染进程拿不到外网图）
    const offAvatar = ctx.webServer.register({
      kind: 'exact',
      path: AVATAR_ROUTE,
      async handler(req, res) {
        try {
          let repo = ''
          try {
            repo = String(new URL(req.url || '/', 'http://127.0.0.1').searchParams.get('repo') || '').trim()
          } catch {
            res.writeHead(400)
            return res.end()
          }
          const owner = repo.split('/')[0]
          if (!/^[\w.-]+$/.test(owner)) {
            res.writeHead(400)
            return res.end()
          }
          const dir = join(CACHE_DIR, 'avatar').split(sep).join('/')
          const file = dir + '/' + owner + '.png'
          let buf = null
          try {
            buf = await readFile(file)
          } catch {
            buf = null
          }
          if (!buf) {
            const r = await fetch('https://github.com/' + owner + '.png?size=96', { headers: { 'user-agent': 'dsh-ai-library' } })
            if (!r.ok) {
              res.writeHead(404)
              return res.end()
            }
            buf = Buffer.from(await r.arrayBuffer())
            try {
              await mkdir(dir, { recursive: true })
              await writeFile(file, buf)
            } catch {
              /* 缓存失败无所谓 */
            }
          }
          res.writeHead(200, { 'content-type': 'image/png', 'content-length': buf.length, 'cache-control': 'public, max-age=86400' })
          res.end(buf)
        } catch {
          try {
            res.writeHead(500)
            res.end()
          } catch {
            /* 已结束 */
          }
        }
      },
    })

    // 论文检索：内置 lib/paper.js（纯 Node 十源并发），不依赖 Python 或外部项目
        // 读 Sciverse 原文切片：GET ?doc=<doc_id>&offset=0&limit=4096
    const offPaperRead = ctx.webServer.register({
      kind: 'exact',
      path: PAPER_ROUTE + '/read',
      async handler(req, res) {
        if (rejectForeign(req, res)) return
        const sendJson = (code, payload) => {
          const body = Buffer.from(JSON.stringify(payload), 'utf8')
          res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'content-length': body.length, 'cache-control': 'no-store' })
          res.end(body)
        }
        try {
          let url = null
          try {
            url = new URL(req.url || '/', 'http://127.0.0.1')
          } catch {
            return sendJson(400, { ok: false, message: 'bad url' })
          }
          const docId = String(url.searchParams.get('doc') || '').trim()
          if (!docId) return sendJson(400, { ok: false, message: '缺少 doc 参数' })
          const offset = Math.max(0, Number(url.searchParams.get('offset')) || 0)
          const limit = Math.min(20000, Math.max(200, Number(url.searchParams.get('limit')) || 4096))
          let keys = {}
          try {
            const raw = JSON.parse(await readFile(join(PLUGIN_DIR, 'config.json'), 'utf8'))
            keys = raw.paperKeys || {}
          } catch {
            keys = {}
          }
          if (!keys.sciverse) return sendJson(400, { ok: false, message: '读原文需要 Sciverse token' })
          const r = await sciverseReadContent({ key: keys.sciverse, docId, offset, limit })
          if (!r.ok) return sendJson(502, { ok: false, message: r.error || '读取失败' })
          return sendJson(200, { ok: true, docId, offset, text: r.text, nextOffset: r.nextOffset, more: r.more })
        } catch (error) {
          return sendJson(502, { ok: false, message: String((error && error.message) || error).slice(-300) })
        }
      },
    })

const offPaper = ctx.webServer.register({
      kind: 'exact',
      path: PAPER_ROUTE,
      async handler(req, res) {
        if (rejectForeign(req, res)) return
        const sendJson = (code, payload) => {
          const body = Buffer.from(JSON.stringify(payload), 'utf8')
          res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'content-length': body.length, 'cache-control': 'no-store' })
          res.end(body)
        }
        try {
          let url = null
          try {
            url = new URL(req.url || '/', 'http://127.0.0.1')
          } catch {
            return sendJson(400, { ok: false, message: 'bad url' })
          }
          const q = String(url.searchParams.get('q') || '').trim()
          if (!q) return sendJson(400, { ok: false, message: '缺少关键词' })
          const source = String(url.searchParams.get('source') || 'auto')
          const limit = Math.min(30, Math.max(1, Number(url.searchParams.get('limit')) || 8))
          /* 每次现读 config.json，这样面板里刚填的 key 立刻生效，不用重启 */
          let keys = {}
          try {
            const raw = JSON.parse(await readFile(join(PLUGIN_DIR, 'config.json'), 'utf8'))
            keys = raw.paperKeys || {}
          } catch {
            keys = {}
          }

          /* 缓存命中就直接返回（DOAJ 这类源单次要 4-5 秒） */
          const cacheKey = createHash('sha1').update(q.toLowerCase() + '|' + source + '|' + limit).digest('hex').slice(0, 16)
          const cacheFile = join(CACHE_DIR, 'paper', cacheKey + '.json').split(sep).join('/')
          try {
            const cached = JSON.parse(await readFile(cacheFile, 'utf8'))
            if (Date.now() - Number(cached.at || 0) < PAPER_CACHE_TTL) {
              return sendJson(200, { ok: true, query: q, source, count: (cached.items || []).length, items: cached.items || [], cached: true })
            }
          } catch {
            /* 没缓存 */
          }

          /* 纯 Node 实现：十源并发 + 去重，不依赖 Python / 外部项目 */
          /* mode=semantic：走 Sciverse 语义检索（RAG chunk），需要 sciverse token */
          const mode = String(url.searchParams.get('mode') || 'meta')
          if (mode === 'semantic') {
            if (!keys.sciverse) {
              return sendJson(400, { ok: false, message: '语义检索需要 Sciverse token，请在「配置 key」里填 sciverse' })
            }
            const r = await sciverseSemantic({ key: keys.sciverse, query: q, topK: limit })
            if (!r.ok) return sendJson(502, { ok: false, message: r.error || '语义检索失败' })
            return sendJson(200, {
              ok: true,
              mode: 'semantic',
              query: q,
              count: r.hits.length,
              hits: r.hits,
              cached: false,
            })
          }

          const result = await searchPapers({ query: q, source, limit, keys })
          const items = result.items || []
          try {
            await mkdir(join(CACHE_DIR, 'paper'), { recursive: true })
            await writeFile(cacheFile, JSON.stringify({ at: Date.now(), items }), 'utf8')
          } catch {
            /* 缓存失败无所谓 */
          }
          return sendJson(200, {
            ok: true,
            query: q,
            source,
            count: items.length,
            items,
            cached: false,
            usedSources: result.usedSources || [],
            errors: result.errors || [],
          })
        } catch (error) {
          return sendJson(502, { ok: false, message: String((error && (error.stderr || error.message)) || error).slice(-500) })
        }
      },
    })

    // 多平台 key：GET 看哪些已配置 / POST 保存到 config.json
    const offKeys = ctx.webServer.register({
      kind: 'exact',
      path: KEYS_ROUTE,
      async handler(req, res) {
        if (rejectForeign(req, res)) return
        const sendJson = (code, payload) => {
          const body = Buffer.from(JSON.stringify(payload), 'utf8')
          res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'content-length': body.length, 'cache-control': 'no-store' })
          res.end(body)
        }
        try {
          const cfgFile = join(PLUGIN_DIR, 'config.json')
          let cfg = {}
          try {
            cfg = JSON.parse(await readFile(cfgFile, 'utf8'))
          } catch {
            cfg = {}
          }
          if (req.method === 'GET') {
            const keys = cfg.paperKeys || {}
            return sendJson(200, {
              ok: true,
              configured: Object.fromEntries(Object.keys(KEY_ENV).map((k) => [k, !!keys[k]])),
            })
          }
          if (req.method === 'POST') {
            const body = await readJsonBody(req)
            const incoming = (body && body.paperKeys) || {}
            cfg.paperKeys = cfg.paperKeys || {}
            for (const k of Object.keys(KEY_ENV)) {
              if (typeof incoming[k] === 'string') cfg.paperKeys[k] = incoming[k].trim()
            }
            await writeFile(cfgFile, JSON.stringify(cfg, null, 2) + '\n', 'utf8')
            return sendJson(200, { ok: true, note: '已保存（检索时立即生效）' })
          }
          return sendJson(405, { ok: false, message: '只支持 GET / POST' })
        } catch (error) {
          return sendJson(502, { ok: false, message: error instanceof Error ? error.message : String(error) })
        }
      },
    })

    // 条目编辑：POST 新增/覆盖 · PATCH 改字段 · DELETE 删除（写 user-items.json）
    const offItem = ctx.webServer.register({
      kind: 'exact',
      path: ITEM_ROUTE,
      async handler(req, res) {
        if (rejectForeign(req, res)) return
        const sendJson = (code, payload) => {
          const body = Buffer.from(JSON.stringify(payload), 'utf8')
          res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'content-length': body.length, 'cache-control': 'no-store' })
          res.end(body)
        }
        try {
          if (req.method === 'POST') {
            const raw = await readJsonBody(req)
            const item = sanitizeItem(raw || {})
            if (!item.id) return sendJson(400, { ok: false, message: '缺少 id' })
            if (!item.title) return sendJson(400, { ok: false, message: '缺少标题' })
            const store = await loadUserItems()
            const idx = store.items.findIndex((x) => x.id === item.id)
            if (idx >= 0) store.items[idx] = { ...store.items[idx], ...item, hidden: false }
            else store.items.push({ ...item, added: item.added || new Date().toISOString().slice(0, 10) })
            if (item.group) store.groups[item.id] = item.group
            await saveUserItems(store)
            return sendJson(200, { ok: true, created: idx < 0, item: idx >= 0 ? store.items[idx] : store.items[store.items.length - 1] })
          }

          if (req.method === 'PATCH') {
            const raw = await readJsonBody(req)
            const id = String((raw && raw.id) || '').trim()
            if (!id) return sendJson(400, { ok: false, message: '缺少 id' })
            const patch = sanitizeItem((raw && raw.patch) || {})
            delete patch.id
            const store = await loadUserItems()
            let idx = store.items.findIndex((x) => x.id === id)
            if (idx < 0) {
              /* 第一次编辑手写条目：从当前合并视图复制一份，再改 */
              const all = await loadAll()
              const current = all.items.find((x) => x.id === id)
              if (!current) return sendJson(404, { ok: false, message: '条目不存在' })
              store.items.push({ ...sanitizeItem(current) })
              idx = store.items.length - 1
            }
            store.items[idx] = { ...store.items[idx], ...patch, id, hidden: false }
            if (patch.group) store.groups[id] = patch.group
            await saveUserItems(store)
            return sendJson(200, { ok: true, item: store.items[idx] })
          }

          if (req.method === 'DELETE') {
            let id = ''
            try {
              id = String(new URL(req.url || '/', 'http://127.0.0.1').searchParams.get('id') || '').trim()
            } catch {
              return sendJson(400, { ok: false, message: 'bad url' })
            }
            if (!id) return sendJson(400, { ok: false, message: '缺少 id' })
            const store = await loadUserItems()
            const inStore = store.items.some((x) => x.id === id)
            if (inStore) {
              store.items = store.items.filter((x) => x.id !== id)
              delete store.groups[id]
            } else {
              /* 不在用户库里 → 是手写/导入条目，写一条 hidden 隐掉 */
              const all = await loadAll()
              if (!all.items.some((x) => x.id === id)) return sendJson(404, { ok: false, message: '条目不存在' })
              store.items.push({ id, hidden: true, title: '(已隐藏)' })
            }
            await saveUserItems(store)
            return sendJson(200, { ok: true })
          }

          return sendJson(405, { ok: false, message: '不支持的方法' })
        } catch (error) {
          return sendJson(502, { ok: false, message: error instanceof Error ? error.message : String(error) })
        }
      },
    })

    // 桌宠探针：客户端 POST 测量结果 → 落盘；GET 读回
    
    // 翻译：POST 提交 / GET ?task= 查状态 / GET ?task=&variant= 取译文
    const offTranslate = ctx.webServer.register({
      kind: 'exact',
      path: TRANSLATE_ROUTE,
      async handler(req, res) {
        if (rejectForeign(req, res)) return
        const sendJson = (code, payload) => {
          const body = Buffer.from(JSON.stringify(payload), 'utf8')
          res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'content-length': body.length, 'cache-control': 'no-store' })
          res.end(body)
        }

        try {
          let url
          try {
            url = new URL(req.url || '/', 'http://127.0.0.1')
          } catch {
            return sendJson(400, { ok: false, message: 'bad url' })
          }

          // 1) 提交任务
          if (req.method === 'POST') {
            const body = await readJsonBody(req)
            /* 客户端传的是相对 library 根的路径（items/xxx.pdf），
               safeTarget 要的是相对 items/ 的路径，所以先剥掉前缀 */
            const raw = body && typeof body.src === 'string' ? body.src.replace(/^items[\\/]/, '') : body && body.src
            const target = safeTarget(raw)
            if (target === null) return sendJson(403, { ok: false, message: '非法文件路径' })
            const info = await stat(target).catch(() => null)
            if (info === null || !info.isFile()) return sendJson(404, { ok: false, message: '找不到该 PDF' })

            const submitted = await submitTranslation(target)
            const taskId = String(submitted.id || '').trim()
            if (!taskId) return sendJson(502, { ok: false, message: '翻译服务没有返回任务号', raw: submitted })
            return sendJson(200, { ok: true, taskId })
          }

          const taskId = String(url.searchParams.get('task') || '').trim()
          if (!taskId) return sendJson(400, { ok: false, message: '缺少 task 参数' })

          // 2) 取译文 PDF
          const variant = url.searchParams.get('variant')
          if (variant) {
            const file = await translationFile(taskId, variant)
            const info = await stat(file)
            return streamFile(req, res, file, 'application/pdf', info.size)
          }

          // 3) 查状态（原样透传）
          const status = await translationStatus(taskId)
          return sendJson(200, { ok: true, raw: status })
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          return sendJson(502, { ok: false, message })
        }
      },
    })

    // 插件市场：GET 看状态，POST 同步（拉目录 → 写 market-items.js）
    const offMarket = ctx.webServer.register({
      kind: 'exact',
      path: MARKET_ROUTE,
      async handler(req, res) {
        if (rejectForeign(req, res)) return
        const sendJson = (code, payload) => {
          const body = Buffer.from(JSON.stringify(payload), 'utf8')
          res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'content-length': body.length, 'cache-control': 'no-store' })
          res.end(body)
        }

        try {
          if (req.method === 'POST') {
            const result = await syncMarket(true)
            return sendJson(200, { ok: true, ...result })
          }
          const exists = existsSync(MARKET_FILE)
          let info = null
          try {
            info = await stat(MARKET_FILE)
          } catch {
            /* 没有就没有 */
          }
          return sendJson(200, {
            ok: true,
            synced: exists,
            syncedAt: info ? new Date(info.mtimeMs).toISOString() : '',
          })
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          return sendJson(502, { ok: false, message })
        }
      },
    })

    // MotionSites 只读资源：预览图/视频 直接流式，.txt 提示词渲染成 HTML
    const offMotion = ctx.webServer.register({
      kind: 'exact',
      path: MOTION_ROUTE,
      async handler(req, res) {
        let rel
        try {
          rel = new URL(req.url || '/', 'http://127.0.0.1').searchParams.get('path') || ''
        } catch {
          return text(res, 400, 'bad url')
        }
        const cleaned = normalize(decodeURIComponent(rel)).replace(/^([/\\])+/, '')
        if (cleaned === '' || cleaned.includes('..') || /^[A-Za-z]:/.test(cleaned)) return text(res, 403, 'forbidden path')

        const base = resolve(MOTION_DIR)
        const target = resolve(base, cleaned)
        if (!target.startsWith(base + sep)) return text(res, 403, 'forbidden path')

        let info
        try {
          info = await stat(target)
        } catch {
          return text(res, 404, 'not found')
        }
        if (!info.isFile()) return text(res, 404, 'not found')

        const ext = extname(target).toLowerCase()
        // 提示词文本：渲染成可读 HTML
        if (ext === '.txt' || ext === '.md') {
          try {
            const html = mdToHtml(await readFile(target, 'utf8'))
            const body = Buffer.from(html, 'utf8')
            res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-length': body.length, 'cache-control': 'no-cache' })
            return res.end(body)
          } catch (error) {
            return text(res, 500, 'render failed')
          }
        }

        streamFile(req, res, target, MIME[ext] || 'application/octet-stream', info.size)
      },
    })

    return () => {
      offData()
      offFile()
      offVendor()
      offTranslate()
      offMarket()
      offMotion()
      offItem()
      offBucket()
      offInstall()
      offUpdate()
      offRepo()
      offCompat()
      offOg()
      offPaper()
      offPaperRead()
      offAvatar()
      offArchive()
      offKeys()
      offClientLog()
    }
  })
}
