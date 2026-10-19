/**
 * ai-library · 工具层
 * ---------------------------------------------------------------------------
 * 把资料馆从「给人看的 UI」变成「给 AI 用的工具箱」。
 *
 * 注册 9 个工具（由 index.js 的 apply 调用 registerTools）：
 *
 *   只读   library_search / library_get / library_read / library_stats
 *   写入   library_add / library_update / library_save_url
 *   长任务 library_translate / library_job
 *
 * 设计约束：
 *   - 写入一律走 user-items.json，**永不改 library.js**
 *   - 全文抽取带磁盘缓存（.cache/text/），同一文件只解析一次
 *   - 翻译这类长任务返回 jobId，不阻塞
 */
import { readFile, writeFile, mkdir, stat, readdir } from 'node:fs/promises'
import { existsSync, readFileSync } from 'node:fs'
import { resolve, join, extname, basename, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { PLUGIN_DIR } from './config.js'
import { searchPapers } from './paper.js'
import { searchWeb } from './anysearch.js'
import {
  dsFetch,
  dsSearch,
  cacheStats as webCacheStats,
  clearCache as webCacheClear,
  resolveDeepseekKey,
  unescapeMd,
} from './dsweb.js'

/** ESM 里拿同步 fs 用（require 在 ESM 中不存在）。 */
const require = createRequire(import.meta.url)

/** 可以直接当文本读的扩展名。 */
const TEXT_EXT = new Set(['.md', '.markdown', '.txt', '.json', '.csv', '.log', '.html', '.htm', '.xml', '.yaml', '.yml',
  /* 代码也算可检索文本（扒组件/提示词时很有用） */
  '.tsx', '.ts', '.jsx', '.js', '.mjs', '.css', '.scss', '.less', '.vue', '.svelte', '.py'])

/** 支持全文抽取的扩展名。 */
const FULLTEXT_EXT = new Set([...TEXT_EXT, '.pdf'])

/**
 * 注册全部工具。
 * @param ctx Cordis 上下文（需 inject: ['tools']）
 * @param deps 由 index.js 注入的内部能力
 */
export function registerTools(ctx, deps) {
  const { CONFIG, loadAll, loadUserItems, saveUserItems, sanitizeItem, safeTarget, submitTranslation, translationStatus } = deps
  const ITEMS_DIR = CONFIG.itemsDir
  const TEXT_CACHE = join(CONFIG.cacheDir, 'text')
  const JOB_DIR = join(CONFIG.cacheDir, 'jobs')

  /* ───────────────────────── 文本抽取 ───────────────────────── */

  let pdfjsPromise = null

  /**
   * 懒加载插件自带的 pdf.js（Node 里要手动指定 worker）。
   * @returns pdf.js 模块
   */
  function pdfjs() {
    if (!pdfjsPromise) {
      pdfjsPromise = (async () => {
        const vendor = CONFIG.vendorDir
        const url = pathToFileURL(vendor.endsWith(sep) ? vendor : vendor + '/').href
        const mod = await import(url + 'pdf.min.mjs')
        mod.GlobalWorkerOptions.workerSrc = url + 'pdf.worker.min.mjs'
        return mod
      })()
    }
    return pdfjsPromise
  }

  /**
   * 从文件里抠文本。
   * @param absPath 绝对路径
   * @param page 只取某一页（仅 PDF）
   * @returns 文本
   */
  async function extractText(absPath, page) {
    const ext = extname(absPath).toLowerCase()
    if (TEXT_EXT.has(ext)) return await readFile(absPath, 'utf8')
    if (ext !== '.pdf') return ''

    const mod = await pdfjs()
    const data = new Uint8Array(await readFile(absPath))
    const vendor = CONFIG.vendorDir
    const doc = await mod.getDocument({
      data,
      useWorkerFetch: false,
      isEvalSupported: false,
      standardFontDataUrl: vendor + '/standard_fonts/',
      cMapUrl: vendor + '/cmaps/',
      cMapPacked: true,
    }).promise

    try {
      const pages = page
        ? [Math.min(Math.max(1, Number(page) || 1), doc.numPages)]
        : Array.from({ length: doc.numPages }, (_, i) => i + 1)
      const out = []
      for (const n of pages) {
        const p = await doc.getPage(n)
        const tc = await p.getTextContent()
        out.push(tc.items.map((it) => it.str).join(' ').replace(/\s+/g, ' ').trim())
      }
      return out.join('\n\n')
    } finally {
      await doc.destroy().catch(() => {})
    }
  }

  /**
   * 带磁盘缓存的文本抽取（按 mtime + size 失效）。
   * @param absPath 绝对路径
   * @returns 文本
   */
  async function cachedText(absPath) {
    const info = await stat(absPath)
    const key = createHash('sha1').update(`${absPath}:${info.mtimeMs}:${info.size}`).digest('hex').slice(0, 20)
    const file = join(TEXT_CACHE, key + '.txt')
    try {
      return await readFile(file, 'utf8')
    } catch {
      /* 没缓存，现抽 */
    }
    const text = await extractText(absPath)
    await mkdir(TEXT_CACHE, { recursive: true })
    await writeFile(file, text, 'utf8')
    return text
  }

  /**
   * 把条目里写的相对路径解析成 items/ 下的绝对路径。
   * @param entry 例如 items/papers/x.pdf 或 papers/x.pdf
   * @returns 绝对路径或 null
   */
  function resolveItemFile(entry) {
    if (typeof entry !== 'string' || !entry) return null

    /* 变体里可能存的是路由 URL（外部挂载源用 ?path= 传相对路径），先把真实路径抠出来 */
    let rawSrc = entry
    const q = rawSrc.match(/[?&]path=([^&]+)/)
    if (q) {
      try {
        rawSrc = decodeURIComponent(q[1])
      } catch {
        rawSrc = q[1]
      }
    }
    const raw = rawSrc.replace(/^items[\\/]/, '')

    /* 先看 items/ 根 */
    const inside = (root, rel) => {
      const abs = resolve(root, rel)
      const base = resolve(root)
      if (abs !== base && !abs.startsWith(base + sep)) return null
      return existsSync(abs) ? abs : null
    }
    const inItems = inside(ITEMS_DIR, raw)
    if (inItems) return inItems

    /* 再试外部只读挂载源（提示词正文在那里） */
    if (CONFIG.motionDir) {
      const inMotion = inside(CONFIG.motionDir, raw)
      if (inMotion) return inMotion
    }
    return null
  }

  /**
   * 列出一个条目的候选文件（含 preview 变体）。
   * @param item 条目
   * @returns [{ label, path }]
   */
  function itemFileCandidates(item) {
    const out = []
    for (const v of (item.preview && item.preview.variants) || []) {
      if (v && v.src) {
        const abs = resolveItemFile(v.src)
        if (abs) out.push({ label: v.label || basename(abs), path: abs })
      }
    }
    for (const f of item.files || []) {
      const abs = resolveItemFile(f)
      if (abs && !out.some((x) => x.path === abs)) out.push({ label: basename(abs), path: abs })
    }
    return out
  }

  /* ───────────────────────── 元数据搜索 ───────────────────────── */

  /**
   * 条目元数据里是否含关键词。
   * @param item 条目
   * @param q 小写关键词
   * @returns 是否命中
   */
  function metaHit(item, q) {
    const hay = [item.title, item.summary, item.source, item.version, item.fit, item.link, item.id]
      .concat(item.tags || [], item.tools || [], item.notes || [], item.files || [])
      .join(' ')
      .toLowerCase()
    return hay.includes(q)
  }

  /**
   * 取命中片段。
   * @param text 全文
   * @param q 小写关键词
   * @param width 两侧宽度
   * @returns 片段
   */
  function snippetOf(text, q, width = 90) {
    const lower = text.toLowerCase()
    const i = lower.indexOf(q)
    if (i < 0) return ''
    const start = Math.max(0, i - width)
    const end = Math.min(text.length, i + q.length + width)
    return (start > 0 ? '…' : '') + text.slice(start, end).replace(/\s+/g, ' ') + (end < text.length ? '…' : '')
  }

  /* ───────────── 产物入库（扫描目录 → 批量建条目）───────────── */

  /** 扩展名 → 预览变体标签。 */
  const ARTIFACT_EXT = {
    '.png': '原图', '.jpg': '原图', '.jpeg': '原图', '.webp': '原图', '.gif': '原图', '.svg': '原图',
    '.pdf': '原文', '.md': '正文', '.markdown': '正文', '.txt': '正文',
    '.pptx': '幻灯片', '.ppt': '幻灯片', '.docx': '文档', '.doc': '文档', '.xlsx': '表格', '.xls': '表格',
    '.zip': '压缩包', '.mp4': '视频', '.webm': '视频',
  }

  /** 扫描时跳过的目录名。 */
  const SKIP_DIRS = new Set(['node_modules', '.git', '.cache', '.dsh', 'dist', 'build', '__pycache__', '.venv', 'venv'])

  /**
   * 递归收集目录下的可入库文件。
   * @param root 起始目录
   * @param depth 剩余深度
   * @param out 结果数组
   */
  async function collectFiles(root, depth, out) {
    if (depth < 0 || out.length >= 500) return
    let entries = []
    try {
      entries = await readdir(root, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      if (out.length >= 500) return
      const full = join(root, e.name)
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name) || e.name.startsWith('.')) continue
        await collectFiles(full, depth - 1, out)
      } else if (e.isFile()) {
        const ext = extname(e.name).toLowerCase()
        if (!ARTIFACT_EXT[ext]) continue
        if (e.name.startsWith('~') || e.name.startsWith('.')) continue
        out.push(full)
      }
    }
  }

  const toolImport = {
    name: 'library_import',
    description:
      'Import AI artifacts (pptx/docx/pdf/md/png/mp4...) from directories or files into the library. Copies files under items/artifacts/<project>/ (originals untouched) and creates one entry per file, grouped by project. Defaults to dryRun=true: first preview, then call again with dryRun=false to write.',
    parameters: {
      type: 'object',
      properties: {
        paths: { type: 'array', items: { type: 'string' }, description: 'Directories or files to scan (absolute paths recommended).' },
        project: { type: 'string', description: 'Sub-group name, usually one conversation or project, e.g. 对话-大肥鱼监工. Defaults to 对话产物 <date time>.' },
        origin: { type: 'string', enum: ['artifact', 'manual'], description: 'artifact (default) = counts as 本地对话产物; manual = only appears under 按文件格式.' },
        dryRun: { type: 'boolean', description: 'true = preview only (default). false = copy files and create entries.' },
        depth: { type: 'integer', description: 'Recursion depth, default 2.' },
        limit: { type: 'integer', description: 'Max files this call, default 100.' },
      },
      required: ['paths'],
    },
    isConcurrencySafe: () => false,
    async execute(args) {
      const raw = args || {}
      const paths = Array.isArray(raw.paths) ? raw.paths.filter((p) => typeof p === 'string' && p.trim()) : []
      if (!paths.length) return { ok: false, message: 'paths is required (array of directories or files)' }
      const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ')
      const project = String(raw.project || ('对话产物 ' + stamp)).trim() || '对话产物 ' + stamp
      const origin = raw.origin === 'manual' ? 'manual' : 'artifact'
      const dryRun = raw.dryRun !== false
      const depth = Math.min(6, Math.max(0, Number(raw.depth) || 2))
      const limit = Math.min(500, Math.max(1, Number(raw.limit) || 100))

      const targets = []
      for (const p of paths) {
        let info = null
        try {
          info = await stat(p)
        } catch {
          continue
        }
        if (info.isDirectory()) await collectFiles(p, depth, targets)
        else if (info.isFile() && ARTIFACT_EXT[extname(p).toLowerCase()]) targets.push(p)
      }
      const unique = [...new Set(targets)].slice(0, limit)
      if (!unique.length) {
        return { ok: true, dryRun, project, scanned: 0, added: 0, wouldAdd: 0, skipped: 0, files: [], note: '在给定路径里没找到可入库的文件' }
      }

      const slug = project.replace(/[^\w\u4e00-\u9fa5.-]+/g, '_').slice(0, 40)
      const store = await loadUserItems()
      const existing = new Set(store.items.map((x) => x.id))
      const files = []
      let added = 0
      let skipped = 0

      for (const src of unique) {
        let info = null
        try {
          info = await stat(src)
        } catch {
          skipped += 1
          continue
        }
        const base = basename(src)
        const ext = extname(base).toLowerCase()
        const rel = 'artifacts/' + slug + '/' + base
        const id = 'art-' + createHash('sha1').update(rel).digest('hex').slice(0, 10)

        if (existing.has(id)) {
          skipped += 1
          files.push({ id, skipped: true, name: base, reason: '已在库中' })
          continue
        }

        const label = ARTIFACT_EXT[ext] || '文件'
        const kind = ext === '.pptx' || ext === '.ppt' ? 'report' : 'doc'
        files.push({ id, skipped: false, name: base, bytes: info.size, src, rel, label })
        added += 1

        if (!dryRun) {
          try {
            await mkdir(join(ITEMS_DIR, 'artifacts', slug), { recursive: true })
            const { copyFile } = await import('node:fs/promises')
            await copyFile(src, join(ITEMS_DIR, rel))
          } catch (error) {
            files[files.length - 1].error = String((error && error.message) || error)
            added -= 1
            skipped += 1
            continue
          }
          store.items.push({
            id,
            kind,
            title: base.replace(/\.[^.]+$/, ''),
            summary: '产物导入：' + src,
            tags: [ext.replace('.', ''), project],
            notes: ['来源：' + src, '导入：' + new Date().toISOString().slice(0, 16).replace('T', ' ')],
            files: [rel],
            preview: { variants: [{ label, src: rel }] },
            group: project,
            /* 归属信息：大类视图靠这些字段自动聚合 */
            origin,
            format: ext.replace('.', ''),
            project,
            hidden: false,
            added: new Date().toISOString().slice(0, 10),
          })
          store.groups[id] = project
        }
      }

      if (!dryRun && added > 0) await saveUserItems(store)

      return {
        ok: true,
        dryRun,
        project,
        scanned: unique.length,
        added: dryRun ? 0 : files.filter((f) => !f.skipped && !f.error).length,
        wouldAdd: dryRun ? files.filter((f) => !f.skipped && !f.error).length : 0,
        skipped,
        targetDir: 'items/artifacts/' + slug + '/',
        files: files.slice(0, 30),
        note: dryRun ? '这是预览（dryRun）。确认后用 dryRun=false 真正写入。' : '已写入 user-items.json，面板刷新即可看到。',
      }
    },
  }

  /* 论文检索（内置 lib/paper.js，纯 Node） */

  /**
   * 调 Python 桥接层。
   * @param payload 传给 paper_bridge.py 的参数
   * @returns 解析后的 JSON
   */
  /**
 * 论文检索：纯 Node 实现（lib/paper.js），不依赖 Python 或外部项目。
 * 保持原来的返回结构 { ok, items } 以兼容调用方。
 */
  async function callPaperBridge(payload) {
    const query = String((payload && payload.query) || '').trim()
    if (!query) return { ok: false, error: 'query is required' }
    let keys = {}
    try {
      const raw = JSON.parse(readFileSync(join(PLUGIN_DIR, 'config.json'), 'utf8'))
      keys = raw.paperKeys || {}
    } catch {
      keys = {}
    }
    try {
      const r = await searchPapers({
        query,
        source: (payload && payload.source) || 'auto',
        limit: Math.min(30, Math.max(1, Number(payload && payload.limit) || 8)),
        keys,
      })
      return { ok: true, items: r.items || [], usedSources: r.usedSources || [], errors: r.errors || [] }
    } catch (error) {
      return { ok: false, error: String((error && error.message) || error).slice(0, 400) }
    }
  }

  /** 把多源返回的条目归一成统一字段。 */
  function normalizePaper(raw) {
    const p = raw || {}
    /* paper_import 的原始字段名：publishedAt / tags / sourceUrl / gradeLevel，不要用直觉猜 */
    const published = String(p.publishedAt || p.published || p.duration || '')
    const yearFromDate = published ? Number(published.slice(0, 4)) : 0
    let host = ''
    try {
      host = p.sourceUrl ? new URL(p.sourceUrl).hostname.replace(/^www\./, '') : ''
    } catch {
      host = ''
    }
    const idText = String(p.id || '')
    const arxivFromId = /^arxiv-/i.test(idText) ? idText.replace(/^arxiv-/i, '') : ''

    return {
      id: idText,
      title: String(p.title || '(无标题)'),
      titleOriginal: String(p.titleOriginal || p.title || ''),
      authors: Array.isArray(p.authors) ? p.authors.slice(0, 12) : [],
      year: Number(p.year) || (Number.isFinite(yearFromDate) && yearFromDate > 1900 ? yearFromDate : null),
      venue: String(p.journal || p.venue || p.publisher || host || ''),
      doi: String(p.doi || ''),
      arxivId: String(p.arxivId || p.arxiv_id || arxivFromId || ''),
      url: String(p.sourceUrl || p.url || p.link || ''),
      pdfUrl: String(p.pdfUrl || p.pdf_url || ''),
      abstract: String(p.summary || p.abstract || '').slice(0, 1500),
      source: String(p.source || p.provider || ''),
      grade: String(p.gradeLevel || p.grade || ''),
      category: String(p.category || ''),
      keywords: Array.isArray(p.tags) ? p.tags.slice(0, 8) : Array.isArray(p.keywords) ? p.keywords.slice(0, 8) : [],
      access: String(p.accessStatus || ''),
    }
  }

  const toolPaperSearch = {
    name: 'library_paper_search',
    description:
      'Search academic papers across many sources (arXiv, OpenAlex, Crossref, DOAJ, INSPIRE, Europe PMC, Zenodo, HAL, DataCite, OpenAIRE) using a built-in Node implementation (no Python, no external project). Returns normalized results (title/authors/year/doi/arxivId/pdfUrl/abstract). Call library_paper_add with one of the results to store it in the library.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Keywords or title. Chinese is translated by the pipeline.' },
        source: { type: 'string', description: 'arxiv / openalex / crossref / doaj / inspire / europepmc / zenodo / hal / datacite / openaire / auto. Default auto.' },
        limit: { type: 'integer', description: 'Max results, default 8.' },
        mode: { type: 'string', enum: ['keyword', 'author'], description: 'Search mode, default keyword.' },
      },
      required: ['query'],
    },
    isConcurrencySafe: () => true,
    async execute(args) {
      const raw = args || {}
      const query = String(raw.query || '').trim()
      if (!query) return { ok: false, message: 'query is required' }
      const res = await callPaperBridge({
        action: 'search',
        query,
        source: raw.source || 'auto',
        limit: Math.min(50, Math.max(1, Number(raw.limit) || 8)),
        mode: raw.mode === 'author' ? 'author' : 'keyword',
      })
      if (!res.ok) return { ok: false, message: res.error || '检索失败' }
      const items = (res.items || []).map(normalizePaper)
      return { ok: true, query, count: items.length, items, errors: res.errors || [] }
    },
  }

  const toolPaperAdd = {
    name: 'library_paper_add',
    description:
      'Store one paper (usually a result from library_paper_search) as a library entry: kind=paper, normalized fields, optional PDF download into items/papers/. Pass the whole paper object from the search result.',
    parameters: {
      type: 'object',
      properties: {
        paper: {
          type: 'object',
          description: 'The paper object returned by library_paper_search (title/authors/year/doi/arxivId/url/pdfUrl/abstract...).',
          additionalProperties: true,
        },
        group: { type: 'string', description: 'Sub-group, e.g. 物理教育 / 核物理.' },
        downloadPdf: { type: 'boolean', description: 'Try to download pdfUrl into items/papers/. Default false.' },
      },
      required: ['paper'],
    },
    async execute(args) {
      const raw = args || {}
      const p = normalizePaper(raw.paper)
      if (!p.title) return { ok: false, message: 'paper.title is required' }
      const key = p.doi || p.arxivId || p.id || p.url || p.title
      const id = 'paper-' + createHash('sha1').update(String(key)).digest('hex').slice(0, 12)

      const store = await loadUserItems()
      if (store.items.some((x) => x.id === id)) return { ok: true, id, duplicated: true, message: '这篇已经在库里了' }

      const files = []
      const variants = []
      if (raw.downloadPdf === true && /^https?:\/\//i.test(p.pdfUrl)) {
        try {
          const res = await fetch(p.pdfUrl, { headers: { 'user-agent': 'Mozilla/5.0 (dsh-ai-library)' } })
          if (res.ok) {
            const buf = Buffer.from(await res.arrayBuffer())
            if (buf.length > 1024) {
              const rel = 'papers/' + id + '.pdf'
              await mkdir(join(ITEMS_DIR, 'papers'), { recursive: true })
              await writeFile(join(ITEMS_DIR, rel), buf)
              files.push(rel)
              variants.push({ label: '原文 PDF', src: rel })
            }
          }
        } catch {
          /* 下载失败不影响登记 */
        }
      }
      if (p.url && !variants.some((v) => v.src === p.url)) variants.push({ label: '来源页面', src: p.url })

      const group = String(raw.group || p.category || '论文').trim() || '论文'
      const notes = []
      if (p.doi) notes.push('DOI: ' + p.doi)
      if (p.arxivId) notes.push('arXiv: ' + p.arxivId)
      if (p.venue) notes.push('来源: ' + p.venue)
      if (p.source) notes.push('检索自: ' + p.source)

      store.items.push({
        id,
        kind: 'paper',
        status: p.pdfUrl || files.length ? 'available' : 'catalog',
        title: p.title,
        summary: p.abstract,
        source: p.venue || p.source || '',
        version: p.year ? String(p.year) : '',
        fit: '',
        tags: [...(p.keywords || []), ...(p.authors || []).slice(0, 2)],
        tools: [],
        install: '',
        link: p.url || (p.doi ? 'https://doi.org/' + p.doi : ''),
        notes,
        files,
        preview: { variants },
        group,
        origin: 'paper',
        format: 'pdf',
        project: group,
        hidden: false,
        added: new Date().toISOString().slice(0, 10),
      })
      store.groups[id] = group
      await saveUserItems(store)
      return { ok: true, id, title: p.title, group, downloaded: files.length > 0 }
    },
  }

  /* ───────────── 自动入库（扫描监听目录，只收新文件）───────────── */

  /** 自动入库状态：上次扫描时间 + 已见文件。 */
  const CAPTURE_STATE = join(CONFIG.cacheDir, 'autocapture.json')

  /**
   * 读自动入库状态。
   * @returns { lastScanAt, seen }
   */
  async function readCaptureState() {
    try {
      const raw = JSON.parse(await readFile(CAPTURE_STATE, 'utf8'))
      return { lastScanAt: Number(raw.lastScanAt) || 0, seen: raw.seen || {} }
    } catch {
      return { lastScanAt: 0, seen: {} }
    }
  }

  const toolAutoCapture = {
    name: 'library_autocapture',
    description:
      'Auto-ingest: scan the configured watchDirs (or explicit paths) and import only files that appeared or changed since the last scan. Each run records a watermark in .cache/autocapture.json. Use library_import for a one-off batch; use this for routine "what did I just produce" capture.',
    parameters: {
      type: 'object',
      properties: {
        paths: { type: 'array', items: { type: 'string' }, description: 'Override watchDirs for this run.' },
        project: { type: 'string', description: 'Sub-group for captured files. Default 自动入库.' },
        dryRun: { type: 'boolean', description: 'Preview only. Default false (this tool really imports).' },
        minutes: { type: 'integer', description: 'Only files modified within the last N minutes (ignores watermark).' },
        depth: { type: 'integer', description: 'Recursion depth, default from config (2).' },
      },
    },
    isConcurrencySafe: () => false,
    async execute(args) {
      const raw = args || {}
      const dirs =
        Array.isArray(raw.paths) && raw.paths.length
          ? raw.paths
          : (Array.isArray(CONFIG.watchDirs) && CONFIG.watchDirs.length ? CONFIG.watchDirs : [CONFIG.workspaceDir])
      if (!Array.isArray(dirs) || !dirs.length) {
        return { ok: false, message: '没有可扫描的目录：config.json 里配 workspaceDir / watchDirs，或本次传 paths。' }
      }
      const stamp0 = new Date().toISOString().slice(0, 16).replace('T', ' ')
      const project = String(raw.project || ('对话 ' + stamp0)).trim()
      const depth = Math.min(6, Math.max(0, Number(raw.depth ?? CONFIG.autoCaptureDepth) || 2))
      const dryRun = raw.dryRun === true
      const state = await readCaptureState()
      /* 首次运行（没有水位）只收最近 24 小时，避免一上来把整个工作目录全导进来 */
      const firstRun = !state.lastScanAt
      const since = Number(raw.minutes) > 0
        ? Date.now() - Number(raw.minutes) * 60000
        : (firstRun ? Date.now() - 24 * 60 * 60000 : state.lastScanAt)

      /* 收集候选文件 */
      const all = []
      for (const d of dirs) {
        let info = null
        try {
          info = await stat(d)
        } catch {
          continue
        }
        if (info.isDirectory()) await collectFiles(d, depth, all)
        else if (info.isFile()) all.push(d)
      }

      /* 过滤：只保留比水位新的文件 */
      const fresh = []
      for (const f of all) {
        let info = null
        try {
          info = await stat(f)
        } catch {
          continue
        }
        const seenAt = Number(state.seen[f]) || 0
        if (info.mtimeMs > since && info.mtimeMs > seenAt) fresh.push({ path: f, mtime: info.mtimeMs, size: info.size })
      }

      if (!fresh.length) {
        if (!dryRun) {
          await mkdir(CONFIG.cacheDir, { recursive: true })
          await writeFile(CAPTURE_STATE, JSON.stringify({ lastScanAt: Date.now(), seen: state.seen }, null, 2), 'utf8')
        }
        return { ok: true, scanned: all.length, fresh: 0, added: 0, dryRun, note: '没有新文件' }
      }

      /* 复用 library_import 的逻辑 */
      const res = await toolImport.execute({
        paths: fresh.map((x) => x.path),
        project,
        dryRun,
        depth: 0,
        limit: 200,
      })

      if (!dryRun && res && res.ok) {
        const nextSeen = { ...state.seen }
        for (const f of fresh) nextSeen[f.path] = f.mtime
        /* 只保留最近 2000 条记录 */
        const keys = Object.keys(nextSeen)
        const trimmed = keys.length > 2000 ? Object.fromEntries(keys.slice(-2000).map((k) => [k, nextSeen[k]])) : nextSeen
        await mkdir(CONFIG.cacheDir, { recursive: true })
        await writeFile(CAPTURE_STATE, JSON.stringify({ lastScanAt: Date.now(), seen: trimmed }, null, 2), 'utf8')
      }

      return {
        ok: !!(res && res.ok),
        dryRun,
        project,
        scanned: all.length,
        fresh: fresh.length,
        added: res && res.added ? res.added : 0,
        wouldAdd: res && res.wouldAdd ? res.wouldAdd : 0,
        skipped: res && res.skipped ? res.skipped : 0,
        files: (res && res.files) || [],
        note: dryRun ? '预览（dryRun）' : '已入库并推进水位',
      }
    },
  }

  /* ───────────── 从仓库建库（clone → 扫描 → 建条目）───────────── */

  /**
   * 把一个仓库（远程或本地）变成一组资料馆条目。
   * - 远程：git clone --depth 1 到 items/repos/<slug>/
   * - 本地：直接扫
   * - README 建成「项目」条目；docs/**\/*.md 建成「文档」条目
   */
  const toolWebSearch = {
    name: 'library_web_search',
    description:
      'Search the public web and return structured results: title / url / snippet. Two providers: ' +
      '"deepseek" (DeepSeek official /v1/tools/search — reranked, carries authority + publish date, uses your DeepSeek API key) and ' +
      '"anysearch" (anonymous quota). Default provider=auto: DeepSeek when an API key is available, else AnySearch. ' +
      'Use it to find pages, official docs, or the landing page of a PDF before calling library_save_url. ' +
      'It is NOT a paper database — for papers use library_paper_search.',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description:
            'Keywords (1-128 chars). Supports DeepSeek search syntax, passed through as-is: ' +
            '`site:github.com`, `-site:example.com`, `-广告`, `-"exact phrase"`, `"exact phrase"`, ' +
            '`lang:zh,en`, `after:2025`, `before:2026-06-01`. Combinable.',
        },
        count: { type: 'integer', description: 'How many results to return, 1-50 (default 10).' },
        limit: { type: 'integer', description: 'Legacy alias of count.' },
        needContent: {
          type: 'boolean',
          description:
            'Ask the API to include each page body in `content` (default false = empty). ' +
            'Turning it on can save a separate fetch, but makes responses much larger.',
        },
        oriQuestion: {
          type: 'string',
          description: 'The original user question that triggered this search (helps intent; max 128 chars).',
        },
        provider: {
          type: 'string',
          enum: ['auto', 'deepseek', 'anysearch'],
          description: 'auto (default) picks deepseek when a key exists, else anysearch. count/needContent/oriQuestion only apply to deepseek.',
        },
      },
      required: ['query'],
    },
    isConcurrencySafe: () => true,
    async execute(args) {
      const raw = args || {}
      const query = String(raw.query || '').trim()
      if (!query) return { ok: false, message: 'query is required' }
      const limit = Math.min(50, Math.max(1, Number(raw.count != null ? raw.count : raw.limit) || 10))

      /* 读配置（每次现读，改了 config.json 不用重启） */
      let cfgFile = {}
      try {
        cfgFile = JSON.parse(readFileSync(join(PLUGIN_DIR, 'config.json'), 'utf8'))
      } catch {
        cfgFile = {}
      }
      const anyKey = String((cfgFile.paperKeys && cfgFile.paperKeys.anysearch) || '')
      const dsKey = String((cfgFile.webKeys && cfgFile.webKeys.deepseek) || '')
      const keyInfo = resolveDeepseekKey({ configKey: dsKey })

      const want = String(raw.provider || 'auto').toLowerCase()
      const useDeepseek = want === 'deepseek' || (want === 'auto' && Boolean(keyInfo.key))

      if (useDeepseek) {
        const r = await dsSearch({ cacheDir: CONFIG.cacheDir, root: CONFIG.root }, query, {
          count: limit,
          needContent: raw.needContent === true,
          oriQuestion: raw.oriQuestion,
          key: keyInfo.key,
        })
        if (!r.ok) {
          /* deepseek 失败且是 auto → 退回 anysearch，别让检索整个不可用 */
          if (want === 'auto') {
            const fallback = await searchWeb({ query, limit, key: anyKey })
            if (fallback.ok) {
              return {
                ok: true,
                query,
                provider: 'anysearch',
                note: 'deepseek search failed (' + r.error + '), fell back to anysearch',
                count: fallback.results.length,
                results: fallback.results,
              }
            }
          }
          return { ok: false, provider: 'deepseek', message: r.error || 'search failed' }
        }
        return {
          ok: true,
          query,
          provider: 'deepseek',
          keySource: keyInfo.source,
          requested: r.requested,
          returned: r.total,
          count: r.results.length,
          needContent: r.needContent,
          // 顺手给个「只看优质」的子集，省得调用方自己筛
          qualityCount: r.results.filter((x) => x.quality).length,
          results: r.results,
        }
      }

      const r = await searchWeb({ query, limit, key: anyKey })
      if (!r.ok) return { ok: false, provider: 'anysearch', message: r.error || 'search failed' }
      return { ok: true, query, provider: 'anysearch', count: r.results.length, results: r.results }
    },
  }

  /**
   * 把网页搜索结果直接变成资料馆条目。
   * - 默认 kind=website，卡片即「网页收藏」
   * - needBody=true 时用 DeepSeek Fetch 抓正文，写成 items/snapshots/<id>.md
   * - 按 URL 去重（库里已有同链接就跳过）
   */
  /**
   * URL 归一化（只用于去重与 id，不改变条目里展示的原始链接）。
   * - host 小写、去 http/https 差异之外只做最小改动
   * - 去掉 #片段（同一页面的锚点不该算两个）
   * - 去掉 utm_* / spm / ref / from 这类追踪参数
   * - 去掉尾部斜杠（根路径保留）
   * @param {string} raw
   * @returns {string}
   */
  function normalizeUrl(raw) {
    const s = String(raw || '').trim()
    if (!s) return ''
    try {
      const u = new URL(s)
      u.hash = ''
      u.hostname = u.hostname.toLowerCase()
      const drop = []
      for (const key of [...u.searchParams.keys()]) {
        if (/^(utm_|spm|ref|from|share_|fbclid|gclid|msclkid)/i.test(key)) drop.push(key)
      }
      for (const key of drop) u.searchParams.delete(key)
      let out = u.toString()
      // 尾部斜杠：只有 path 为 "/" 时保留
      if (u.pathname !== '/' && out.endsWith('/')) out = out.slice(0, -1)
      return out
    } catch {
      return s
    }
  }

  const toolWebCollect = {
    name: 'library_web_collect',
    description:
      'Search the web (DeepSeek official search by default) and SAVE the hits as structured website entries ' +
      '(kind="website", one card per page). Dedupes by URL against the existing library. ' +
      'With needBody=true it also fetches each page via DeepSeek Fetch and stores a markdown snapshot under items/snapshots/. ' +
      'Use this when the user says "把这些网页收进资料馆 / 收藏一下 / 存起来".',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search keywords (1-128 chars, supports DeepSeek search syntax).' },
        count: { type: 'integer', description: 'How many hits to consider, 1-20 (default 8).' },
        group: { type: 'string', description: 'Sub-group name in the left tree (default "网页收藏").' },
        minScore: { type: 'number', description: 'Only keep rerank_score >= this (0-3; 1.5 = high quality). Default 0.' },
        minAuthority: { type: 'integer', description: 'Only keep authority >= this (0-4; 3 = highly authoritative, -1 = unknown). Default -1.' },
        needBody: { type: 'boolean', description: 'Also fetch page bodies and store md snapshots (slower, one request per page). Default false.' },
        oriQuestion: { type: 'string', description: 'Original user question (helps intent, max 128 chars).' },
        dryRun: { type: 'boolean', description: 'Preview the entries without writing them. Default false.' },
      },
      required: ['query'],
    },
    isConcurrencySafe: () => false,
    async execute(args) {
      const raw = args || {}
      const query = String(raw.query || '').trim()
      if (!query) return { ok: false, message: 'query is required' }
      const want = Math.min(20, Math.max(1, Number(raw.count) || 8))
      const group = String(raw.group || '网页收藏').trim() || '网页收藏'
      const minScore = Number(raw.minScore) || 0
      const minAuthority = raw.minAuthority == null ? -1 : Number(raw.minAuthority)
      const needBody = raw.needBody === true
      const dryRun = raw.dryRun === true

      /* key：config.webKeys.deepseek > env > ~/.dsh/.credentials.yaml */
      let dsKey = ''
      try {
        const cfgFile = JSON.parse(readFileSync(join(PLUGIN_DIR, 'config.json'), 'utf8'))
        dsKey = String((cfgFile.webKeys && cfgFile.webKeys.deepseek) || '')
      } catch {
        dsKey = ''
      }
      const keyInfo = resolveDeepseekKey({ configKey: dsKey })
      if (!keyInfo.key) {
        return {
          ok: false,
          message: '没有 DeepSeek API key（webKeys.deepseek / DEEPSEEK_API_KEY / ~/.dsh/.credentials.yaml）',
          hint: '也可以在 config.json 里配 paperKeys.anysearch 走匿名检索，但那样没有 rerank_score/authority。',
        }
      }

      const r = await dsSearch({ cacheDir: CONFIG.cacheDir, root: CONFIG.root }, query, {
        count: want,
        oriQuestion: raw.oriQuestion,
        key: keyInfo.key,
      })
      if (!r.ok) return { ok: false, message: 'search failed: ' + (r.error || 'unknown') }

      const hits = (r.results || []).filter(
        (x) => x.url && x.score >= minScore && (minAuthority < 0 || (x.authority != null && x.authority >= minAuthority)),
      )
      if (!hits.length) {
        return { ok: true, query, scanned: (r.results || []).length, created: 0, skipped: 0, items: [], note: '过滤后没有命中（可降低 minScore / minAuthority）' }
      }

      /* 去重：库里已有同 URL 就跳过 */
      const store = await loadUserItems()
      const all = await loadAll()
      const known = new Set()
      for (const it of [...(all.items || []), ...store.items]) {
        if (it.link) known.add(normalizeUrl(it.link))
        if (it.url) known.add(normalizeUrl(it.url))
      }

      const created = []
      let skipped = 0
      const today = new Date().toISOString().slice(0, 10)

      for (const hit of hits) {
        const url = String(hit.url).trim()
        const norm = normalizeUrl(url)
        if (known.has(norm)) { skipped += 1; continue }
        const id = 'web-' + createHash('sha1').update(norm).digest('hex').slice(0, 10)

        const notes = [
          hit.site ? '站点：' + hit.site : '',
          hit.date ? '发布：' + String(hit.date).slice(0, 10) : '',
          '相关度 ' + hit.score.toFixed(2) + (hit.quality ? '（优质）' : ''),
          '权威 ' + (hit.authority >= 0 ? hit.authority : '未知') + (hit.authoritative ? '（极权威）' : ''),
          '检索词：' + query,
          '抓取：DeepSeek /v1/tools/search',
        ].filter(Boolean)

        const files = []
        if (needBody) {
          const f = await dsFetch(CONFIG, url, { key: keyInfo.key })
          if (f.ok && f.content) {
            const slug = (basename(new URL(url).pathname) || 'index').replace(/[^\w.-]+/g, '_').slice(0, 40)
            const rel = 'snapshots/' + id + '-' + slug + '.md'
            await mkdir(join(ITEMS_DIR, 'snapshots'), { recursive: true })
            await writeFile(join(ITEMS_DIR, rel), '# ' + (f.title || hit.title || url) + '\n\n> ' + url + '\n\n' + f.content, 'utf8')
            files.push(rel)
            notes.push('正文：' + f.content.length + ' 字符' + (f.cached ? '（缓存命中）' : ''))
          } else {
            notes.push('正文抓取失败：' + (f.error || 'unknown'))
          }
        }

        const item = sanitizeItem({
          id,
          kind: 'website',
          title: hit.title || url,
          summary: (hit.snippet || hit.summary || '').slice(0, 200),
          group,
          link: url,
          tags: [group].concat(hit.site ? [hit.site] : []).concat(hit.quality ? ['优质'] : []),
          notes,
          files,
          web: {
            site: hit.site || '',
            siteIcon: hit.siteIcon || '',
            date: hit.date || '',
            score: hit.score,
            authority: hit.authority,
            query,
            fetchedAt: new Date().toISOString(),
          },
          added: today,
        })

        if (!dryRun) {
          store.items.push({ ...item, hidden: false, added: item.added || today })
          if (item.group) store.groups[item.id] = item.group
        }
        created.push({ id: item.id, title: item.title, url, score: hit.score, authority: hit.authority, files })
      }

      if (!dryRun && created.length) await saveUserItems(store)

      return {
        ok: true,
        query,
        scanned: (r.results || []).length,
        created: created.length,
        skipped,
        dryRun,
        group,
        items: created,
      }
    },
  }

  const toolRepoBuild = {
    name: 'library_repo_build',
    description:
      'Build a library section from a repository: clone a GitHub repo (or scan a local path), then create one entry for the README and one per markdown file under docs/. Files stay inside items/repos/, so the panel can open them directly. Use this to turn a cloned repo into browsable, searchable library entries.',
    parameters: {
      type: 'object',
      properties: {
        repo: { type: 'string', description: 'owner/name, a git URL, or a local directory path.' },
        group: { type: 'string', description: 'Sub-group name. Default = repo name.' },
        clone: { type: 'boolean', description: 'Clone remote repos (default true). Ignored for local paths.' },
        maxFiles: { type: 'integer', description: 'Max markdown files to import (default 40).' },
        dryRun: { type: 'boolean', description: 'Preview only (default false).' },
      },
      required: ['repo'],
    },
    isConcurrencySafe: () => false,
    async execute(args) {
      const raw = args || {}
      const spec = String(raw.repo || '').trim()
      if (!spec) return { ok: false, message: 'repo is required' }
      const dryRun = raw.dryRun === true
      const maxFiles = Math.min(200, Math.max(1, Number(raw.maxFiles) || 40))

      const isLocal = /^[a-zA-Z]:[\\/]/.test(spec) || spec.startsWith('/') || spec.startsWith('.')
      const isGithub = /^[\w.-]+\/[\w.-]+$/.test(spec)
      const url = isLocal ? spec : isGithub ? 'https://github.com/' + spec + '.git' : spec
      const slug = String(isGithub ? spec.split('/')[1] : basename(spec.replace(/[\\/]+$/, '')) || 'repo')
        .replace(/[^\w.-]+/g, '-')
        .slice(0, 60)
      const group = String(raw.group || slug).trim() || slug

      /* 1) 远程 → clone */
      let root = resolve(spec)
      let cloned = false
      if (!isLocal && raw.clone !== false) {
        const dest = join(ITEMS_DIR, 'repos', slug)
        root = dest
        try {
          await stat(dest)
          cloned = false /* 已经存在，复用 */
        } catch {
          await mkdir(join(ITEMS_DIR, 'repos'), { recursive: true })
          if (!dryRun) {
            const { execFile } = await import('node:child_process')
            const { promisify } = await import('node:util')
            const execFileAsync = promisify(execFile)
            try {
              await execFileAsync('git', ['clone', '--depth', '1', url, dest], { timeout: 180000, maxBuffer: 8 * 1024 * 1024 })
              cloned = true
            } catch (error) {
              return { ok: false, message: 'git clone 失败：' + String((error && (error.stderr || error.message)) || error).slice(-400) }
            }
          }
        }
      }

      /* 2) 收集 md */
      const mdFiles = []
      const walk = async (dir, depth) => {
        if (depth < 0 || mdFiles.length >= maxFiles) return
        let entries = []
        try {
          entries = await readdir(dir, { withFileTypes: true })
        } catch {
          return
        }
        for (const e of entries) {
          if (mdFiles.length >= maxFiles) return
          if (e.name.startsWith('.') || SKIP_DIRS.has(e.name)) continue
          const full = join(dir, e.name)
          if (e.isDirectory()) await walk(full, depth - 1)
          else if (/\.(md|markdown)$/i.test(e.name)) mdFiles.push(full)
        }
      }
      if (!dryRun || isLocal) await walk(root, 3)

      /* 3) 建条目 */
      const store = await loadUserItems()
      const existing = new Set(store.items.map((x) => x.id))
      const relOf = (abs) => (abs.startsWith(ITEMS_DIR) ? abs.slice(ITEMS_DIR.length + 1) : null)
      const created = []
      let skipped = 0

      const addOne = async (abs, title, kind, isReadme) => {
        let rel = relOf(abs)
        if (!rel) {
          /* 本地目录在 items/ 之外：复制一份进来，否则面板打不开 */
          const relName = relative(root, abs).replace(/\\/g, '/')
          const target = 'repos/' + slug + '/' + (isReadme ? 'README.md' : 'docs/' + relName)
          rel = target
          if (!dryRun) {
            try {
              const { copyFile } = await import('node:fs/promises')
              const parts = target.split('/')
              parts.pop()
              await mkdir(join(ITEMS_DIR, ...parts), { recursive: true })
              await copyFile(abs, join(ITEMS_DIR, target))
            } catch (error) {
              skipped += 1
              return
            }
          }
        }
        const id = 'repo-' + createHash('sha1').update(rel).digest('hex').slice(0, 10)
        if (existing.has(id)) {
          skipped += 1
          return
        }
        const item = {
          id,
          kind,
          title,
          summary: isReadme ? '仓库 README：' + slug : slug + ' 的文档',
          tags: ['repo', slug, isReadme ? 'README' : 'docs'],
          notes: ['来自仓库 ' + slug, '文件：' + rel],
          files: [rel],
          preview: { variants: [{ label: '正文', src: rel }] },
          group,
          origin: 'artifact',
          format: 'md',
          project: group,
          hidden: false,
          added: new Date().toISOString().slice(0, 10),
        }
        store.items.push(item)
        store.groups[id] = group
        existing.add(id)
        created.push({ id, title, rel })
      }

      const readme = mdFiles.find((f) => /readme\.md$/i.test(f))
      if (readme) await addOne(readme, slug + ' · README', 'doc', true)
      for (const f of mdFiles) {
        if (f === readme) continue
        const name = relative(root, f).replace(/\\/g, '/')
        await addOne(f, name, 'doc', false)
      }

      if (!dryRun && created.length) await saveUserItems(store)

      return {
        ok: true,
        dryRun,
        repo: spec,
        cloned,
        root: relOf(root) || root,
        group,
        scanned: mdFiles.length,
        created: dryRun ? 0 : created.length,
        wouldCreate: dryRun ? created.length : 0,
        skipped,
        items: created.slice(0, 20),
        note: dryRun ? '预览（dryRun）。确认后用 dryRun=false 真正建库。' : '已写入 user-items.json，面板刷新可见。',
      }
    },
  }

  /* ───────────── render：决定模型看到什么 ─────────────
   * dsh-tools 强制要求 output.render 存在，且**它的返回值才是模型看到的内容**。
   * 所以这里逐个工具做成人能读的摘要，而不是丢一坨 JSON。 */
  const RENDER = {
    library_search: (v) => {
      if (!v || v.ok !== true) return '搜索失败：' + ((v && v.message) || '未知原因')
      if (!v.hits || !v.hits.length) return `没有命中「${v.query}」（${v.mode} 模式，扫描 ${v.scanned} 条）`
      const lines = v.hits.map((h, i) => {
        const where = (h.matchedIn || []).join(' / ')
        const head = `${i + 1}. ${h.title}  [${h.kind}${h.group ? ' · ' + h.group : ''}]  ${where}`
        return h.snippet ? head + `\n     « ${h.snippet} »` : head
      })
      return `命中 ${v.total} 条（扫描 ${v.scanned}，${v.mode}）：\n` + lines.join('\n')
    },

    library_get: (v) => {
      if (!v || v.ok !== true) return '取条目失败：' + ((v && v.message) || '')
      const it = v.item
      const lines = [
        `id: ${it.id}`,
        `标题: ${it.title || '(无)'}`,
        `类型: ${it.kind || '-'}   分组: ${v.group || '-'}   状态: ${it.status || '-'}`,
        it.summary ? `摘要: ${it.summary}` : '',
        (it.tags && it.tags.length) ? `标签: ${it.tags.join(', ')}` : '',
        (it.notes && it.notes.length) ? `备注:\n  - ${it.notes.join('\n  - ')}` : '',
        it.link ? `链接: ${it.link}` : '',
        (v.files && v.files.length) ? `文件:\n${v.files.map((f) => `  - [${f.status}] ${f.abs}`).join('\n')}` : '文件: (无)',
      ]
      return lines.filter(Boolean).join('\n')
    },

    library_read: (v) => {
      if (!v || v.ok !== true) return '读取失败：' + ((v && v.message) || '')
      const head = `《${v.title}》 文件 ${v.file}（${v.chars} 字${v.truncated ? '，已截断' : ''}）`
      return head + '\n\n' + v.text
    },

    library_stats: (v) => {
      if (!v || v.ok !== true) return '统计失败'
      const kinds = Object.entries(v.byKind || {}).map(([k, n]) => `${k}:${n}`).join('  ')
      const groups = Object.entries(v.byGroup || {}).slice(0, 12).map(([k, n]) => `${k}:${n}`).join('  ')
      return `共 ${v.total} 条，其中 ${v.withFiles} 条带文件\n类型：${kinds}\n分组（前 12）：${groups}\n文本缓存：${v.textCache.files} 个文件`
    },

    library_add: (v) => (v && v.ok ? `已新建条目 ${v.id}：${v.item.title}` : '新建失败：' + ((v && v.message) || '')),

    library_update: (v) => (v && v.ok ? `已更新 ${v.id}：${v.item.title}（分组 ${v.item.group || '-'}）` : '更新失败：' + ((v && v.message) || '')),

    library_save_url: (v) =>
      v && v.ok
        ? `已保存网页《${v.title}》\n条目 id: ${v.id}\n抓取方式: ${v.mode || 'builtin'}` +
          (v.cacheHit ? '（缓存命中，' + Math.round((v.cacheAgeMs || 0) / 60000) + ' 分钟前抓过）' : '') +
          `\n快照: ${v.savedSnapshot}\n正文 ${v.chars} 字` +
          (v.note ? '\n注意: ' + v.note : '')
        : '保存失败：' + ((v && v.message) || '') + (v && v.hint ? '\n提示: ' + v.hint : ''),

    library_import: (v) => {
      if (!v || v.ok !== true) return '导入失败：' + ((v && v.message) || '')
      const head = v.dryRun
        ? '预览：扫描 ' + v.scanned + ' 个文件，将导入 ' + v.wouldAdd + ' 个（跳过 ' + v.skipped + '）→ ' + v.targetDir
        : '已导入 ' + v.added + ' 个（跳过 ' + v.skipped + '）→ ' + v.targetDir
      const lines = (v.files || []).slice(0, 12).map((f) =>
        f.skipped ? '  - [跳过] ' + f.name : '  - ' + f.name + (f.bytes ? ' (' + Math.round(f.bytes / 1024) + ' KB)' : ''),
      )
      return [head, ...lines, v.note ? '  ' + v.note : ''].filter(Boolean).join(String.fromCharCode(10))
    },

    library_autocapture: (v) => {
      if (!v || v.ok !== true) return '自动入库失败：' + ((v && v.message) || '')
      const head = v.dryRun
        ? '预览：扫描 ' + v.scanned + ' 个，新增 ' + v.fresh + ' 个（将导入 ' + (v.wouldAdd || 0) + '）'
        : '自动入库：扫描 ' + v.scanned + ' 个，新增 ' + v.fresh + ' 个，导入 ' + (v.added || 0) + ' 个'
      const lines = (v.files || []).slice(0, 10).map((f) => '  - ' + f.name)
      return [head, ...lines, v.note ? '  ' + v.note : ''].filter(Boolean).join(String.fromCharCode(10))
    },

    library_web_search: (v) => {
      if (!v || v.ok !== true) return '网页检索失败：' + ((v && v.message) || '')
      const head = '命中 ' + v.count + ' 条（来源: ' + (v.provider || 'anysearch') + '）'
      const lines = (v.results || []).slice(0, 8).map((r) => {
        let extra = ''
        if (r.authority) extra += '  权威度 ' + r.authority
        if (r.date) extra += '  ' + String(r.date).slice(0, 10)
        if (r.site) extra += '  ' + r.site
        return '  - ' + r.title + extra + '\n    ' + r.url
      })
      return [head].concat(lines).concat(v.note ? ['  ' + v.note] : []).join(String.fromCharCode(10))
    },

    library_web_collect: (v) => {
      if (!v || v.ok !== true) return '收藏失败：' + ((v && v.message) || '')
      if (!v.created) return '没有新增（扫描 ' + (v.scanned || 0) + ' 条，都被过滤或已在库中）'
      const lines = (v.items || []).map((x, i) => (i + 1) + '. ' + x.title + String.fromCharCode(10) + '   ' + x.url + String.fromCharCode(10) + '   分数 ' + Number(x.score || 0).toFixed(2) + ' · 权威 ' + (x.authority >= 0 ? x.authority : '?') + (x.files && x.files.length ? ' · 已存正文' : ''))
      return (v.dryRun ? '预览（未写库）：将新增 ' : '已收藏 ') + v.created + ' 条到「' + v.group + '」' + (v.skipped ? '，跳过重复 ' + v.skipped + ' 条' : '') + String.fromCharCode(10) + lines.join(String.fromCharCode(10))
    },

    library_web_cache: (v) => {
      if (!v || v.ok !== true) return '缓存操作失败：' + ((v && v.message) || '')
      if (v.action === 'clear') return '已清空网页缓存：删除 ' + v.removed + ' 页'
      return (
        '网页缓存（DeepSeek Fetch）\n  目录: ' + v.dir + '\n  页数: ' + v.pages +
        '\n  占用: ' + v.kb + ' KB\n  最近: ' + (v.newestAt || '（空）') +
        '\n  有效期: ' + v.ttlHours + ' 小时'
      )
    },

    library_repo_build: (v) => {
      if (!v || v.ok !== true) return '建库失败：' + ((v && v.message) || '')
      const head = v.dryRun
        ? '预览：扫描 ' + v.scanned + ' 个 md，将建 ' + v.wouldCreate + ' 条（跳过 ' + v.skipped + '）→ ' + v.group
        : '已建库：' + v.created + ' 条（跳过 ' + v.skipped + '）→ ' + v.group
      const lines = (v.items || []).slice(0, 10).map((it) => '  - ' + it.title)
      return [head, ...lines, v.note ? '  ' + v.note : ''].filter(Boolean).join(String.fromCharCode(10))
    },

    library_paper_search: (v) => {
      if (!v || v.ok !== true) return '检索失败：' + ((v && v.message) || '')
      const errs = (v && v.errors) || []
      const isKeyErr = (e) => /key|token/i.test(String((e && e.message) || ''))
      const keyMissing = errs.filter(isKeyErr)
      const others = errs.filter((e) => !isKeyErr(e))
      const fmtErr = (list) => list.map((e) => '  · ' + e.source + '：' + e.message).join(String.fromCharCode(10))
      const keyHint = keyMissing.length
        ? '需要配置 key 才能查这些源（面板「论文检索 → 配置 key」）：' + String.fromCharCode(10) + fmtErr(keyMissing)
        : ''
      if (!v.items || !v.items.length) {
        const parts = ['没有检索到「' + v.query + '」相关论文']
        if (keyHint) parts.push(keyHint)
        if (others.length) parts.push('其余源报错：' + String.fromCharCode(10) + fmtErr(others))
        return parts.join(String.fromCharCode(10))
      }
      const lines = v.items.map((p, i) => (i + 1) + '. ' + p.title + '  [' + (p.source || '-') + (p.year ? ' · ' + p.year : '') + ']' + String.fromCharCode(10) + '     ' + (p.authors || []).slice(0, 3).join(', ') + (p.doi ? '  DOI ' + p.doi : '') + (p.pdfUrl ? '  [有 PDF]' : ''))
      const warn = (keyHint ? String.fromCharCode(10) + '注意：' + keyHint : '') + (others.length ? String.fromCharCode(10) + '其余源报错：' + String.fromCharCode(10) + fmtErr(others) : '')
      return '命中 ' + v.count + ' 篇：' + String.fromCharCode(10) + lines.join(String.fromCharCode(10)) + warn
    },

    library_paper_add: (v) => (v && v.ok
      ? (v.duplicated ? '已在库中：' + v.title : '已入库《' + v.title + '》\n  id: ' + v.id + '\n  分组: ' + v.group + (v.downloaded ? '\n  已下载 PDF' : ''))
      : '入库失败：' + ((v && v.message) || '')),

    library_translate: (v) =>
      v && v.ok ? `已提交翻译任务 ${v.jobId}（task ${v.taskId}）\n文件: ${v.file}\n用 library_job(jobId) 查进度。` : '提交失败：' + ((v && v.message) || ''),

    library_job: (v) => {
      if (!v || v.ok !== true) return '查询失败：' + ((v && v.message) || '')
      const list = v.job ? [v.job] : v.jobs || []
      if (!list.length) return '没有任务'
      return list.map((j) => `${j.jobId}  ${j.kind}  ${j.status}${j.stage ? ' (' + j.stage + ')' : ''}  条目 ${j.itemId || '-'}`).join('\n')
    },
  }

  /* ───────────────────────── 工具定义 ───────────────────────── */

  const toolSearch = {
    name: 'library_search',
    description:
      'Search the local library (资料馆). mode="meta" searches titles/summaries/tags/notes; mode="fulltext" also extracts and searches inside the actual files (md/txt/pdf) and returns a surrounding snippet. Use this instead of reading files yourself when the user asks what the library contains about a topic.',
    parameters: {
      type: 'object',
      properties: {
        q: { type: 'string', description: 'Keyword or phrase. Case-insensitive.' },
        mode: { type: 'string', enum: ['meta', 'fulltext'], description: 'meta = metadata only (fast). fulltext = also inside file contents (first call may take a few seconds while it builds the text cache). Default meta.' },
        kind: { type: 'string', description: 'Restrict to one kind (paper/plugin/doc/prompt/market/repo/...).' },
        group: { type: 'string', description: 'Restrict to one sub-group name.' },
        project: { type: 'string', description: 'Restrict to one conversation/project name (items with that project field).' },
        format: { type: 'string', description: 'Restrict to one file format (md / png / pdf / pptx / jsx / ...).' },
        limit: { type: 'integer', description: 'Max hits, 1-50. Default 10.' },
      },
      required: ['q'],
    },
    isConcurrencySafe: () => true,
    async execute(args) {
      const raw = args || {}
      const q = String(raw.q || '').trim().toLowerCase()
      if (!q) return { ok: false, message: 'empty query' }
      const mode = raw.mode === 'fulltext' ? 'fulltext' : 'meta'
      const limit = Math.min(50, Math.max(1, Number(raw.limit) || 10))

      const all = await loadAll()
      const groups = all.groups || {}
      let pool = all.items
      if (raw.kind) pool = pool.filter((it) => it.kind === raw.kind)
      if (raw.project) pool = pool.filter((it) => String((it.project || (groups && groups[it.id]) || it.group || '')).toLowerCase() === String(raw.project).toLowerCase())
      if (raw.format) pool = pool.filter((it) => String(it.format || '').toLowerCase() === String(raw.format).toLowerCase())
      if (raw.group) pool = pool.filter((it) => (groups[it.id] || it.group || '') === raw.group)

      const hits = []
      for (const it of pool) {
        const group = groups[it.id] || it.group || ''
        let matchedIn = []
        let snippet = ''
        if (metaHit(it, q)) matchedIn.push('meta')

        if (mode === 'fulltext') {
          for (const cand of itemFileCandidates(it)) {
            if (!FULLTEXT_EXT.has(extname(cand.path).toLowerCase())) continue
            let text = ''
            try {
              text = await cachedText(cand.path)
            } catch {
              continue
            }
            const snip = snippetOf(text, q)
            if (snip) {
              matchedIn.push('file:' + cand.label)
              if (!snippet) snippet = snip
              break
            }
          }
        }

        if (!matchedIn.length) continue
        hits.push({
          id: it.id,
          title: it.title || '(无标题)',
          kind: it.kind || '',
          group,
          summary: String(it.summary || '').slice(0, 150),
          tags: it.tags || [],
          matchedIn,
          snippet,
          score: matchedIn.length + (matchedIn.some((m) => m.startsWith('file:')) ? 1 : 0),
        })
        if (hits.length >= limit * 12) break
      }

      hits.sort((a, b) => b.score - a.score)
      return {
        ok: true,
        query: raw.q,
        mode,
        scanned: pool.length,
        total: hits.length,
        hits: hits.slice(0, limit),
        note: mode === 'meta' ? 'Only metadata was searched. Use mode="fulltext" to search inside files.' : undefined,
      }
    },
  }

  const toolGet = {
    name: 'library_get',
    description: 'Read one library entry in full: id, title, kind, group, tags, notes, file variants, and whether each file actually exists on disk.',
    parameters: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Entry id.' } },
      required: ['id'],
    },
    isConcurrencySafe: () => true,
    async execute(args) {
      const id = String((args && args.id) || '').trim()
      if (!id) return { ok: false, message: 'missing id' }
      const all = await loadAll()
      const item = all.items.find((x) => x.id === id)
      if (!item) return { ok: false, message: 'entry not found: ' + id, hint: 'Use library_search to find the right id.' }
      const files = itemFileCandidates(item).map((c) => {
        const info = existsSync(c.path) ? null : 'missing'
        return { label: c.label, abs: c.path, status: info || 'ok' }
      })
      return { ok: true, item, group: (all.groups || {})[item.id] || item.group || '', files }
    },
  }

  const toolRead = {
    name: 'library_read',
    description: 'Extract readable text from one library entry\'s file (markdown/txt directly, PDF via the bundled pdf.js). Use page= to read a single PDF page. Output is truncated to maxChars.',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Entry id.' },
        variant: { type: 'string', description: 'Optional variant label to pick a specific file (see library_get.files).' },
        page: { type: 'integer', description: 'PDF only: read just this 1-based page.' },
        maxChars: { type: 'integer', description: 'Truncate output, default 8000.' },
      },
      required: ['id'],
    },
    isConcurrencySafe: () => true,
    async execute(args) {
      const raw = args || {}
      const id = String(raw.id || '').trim()
      const maxChars = Math.min(60000, Math.max(500, Number(raw.maxChars) || 8000))
      const all = await loadAll()
      const item = all.items.find((x) => x.id === id)
      if (!item) return { ok: false, message: 'entry not found: ' + id }

      const cands = itemFileCandidates(item)
      /* 默认挑第一个「能读成文字」的文件，不要挑到 webp/mp4 这种 */
      const readable = cands.filter((c) => FULLTEXT_EXT.has(extname(c.path).toLowerCase()))
      if (!readable.length) {
        return {
          ok: false,
          message: 'this entry has no readable text file (variants: ' + cands.map((c) => c.label).join(', ') + ')',
          item: { id: item.id, title: item.title },
        }
      }
      const pick = raw.variant ? readable.find((c) => c.label === raw.variant) || readable[0] : readable[0]

      let text = ''
      try {
        text = raw.page ? await extractText(pick.path, raw.page) : await cachedText(pick.path)
      } catch (error) {
        return { ok: false, message: 'extract failed: ' + String(error && error.message) }
      }
      const truncated = text.length > maxChars
      return {
        ok: true,
        id: item.id,
        title: item.title,
        file: pick.path,
        variant: pick.label,
        chars: text.length,
        truncated,
        text: truncated ? text.slice(0, maxChars) : text,
      }
    },
  }

  const toolStats = {
    name: 'library_stats',
    description: 'Summarise the library: counts by kind and by group, how many entries have files, and the text-cache state.',
    parameters: { type: 'object', properties: {} },
    isConcurrencySafe: () => true,
    async execute() {
      const all = await loadAll()
      const byKind = {}
      const byGroup = {}
      let withFiles = 0
      for (const it of all.items) {
        byKind[it.kind || '(none)'] = (byKind[it.kind || '(none)'] || 0) + 1
        const g = (all.groups || {})[it.id] || it.group || '(未分类)'
        byGroup[g] = (byGroup[g] || 0) + 1
        if ((it.files && it.files.length) || (it.preview && it.preview.variants && it.preview.variants.length)) withFiles += 1
      }
      let cachedTexts = 0
      try {
        cachedTexts = (await readdir(TEXT_CACHE)).filter((f) => f.endsWith('.txt')).length
      } catch {
        cachedTexts = 0
      }
      return {
        ok: true,
        total: all.items.length,
        withFiles,
        sources: all.sources,
        byKind,
        byGroup: Object.fromEntries(Object.entries(byGroup).sort((a, b) => b[1] - a[1]).slice(0, 40)),
        textCache: { files: cachedTexts, dir: TEXT_CACHE },
        root: CONFIG.root,
      }
    },
  }

  const toolAdd = {
    name: 'library_add',
    description: 'Create a new library entry. Writes to user-items.json only — the hand-written library.js is never modified. id is optional (generated when omitted).',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Required.' },
        kind: { type: 'string', description: 'paper/plugin/doc/prompt/note/website/... Default note.' },
        group: { type: 'string', description: 'Sub-group name shown in the left tree.' },
        summary: { type: 'string', description: 'One or two sentences.' },
        tags: { type: 'array', items: { type: 'string' } },
        notes: { type: 'array', items: { type: 'string' } },
        link: { type: 'string' },
        files: { type: 'array', items: { type: 'string' }, description: 'Paths relative to the items/ dir, e.g. papers/x.pdf.' },
        id: { type: 'string' },
      },
      required: ['title'],
    },
    async execute(args) {
      const raw = args || {}
      const item = sanitizeItem({ ...raw, kind: raw.kind || 'note' })
      if (!item.title) return { ok: false, message: 'title is required' }
      if (!item.id) item.id = 'u-' + Date.now().toString(36)
      const store = await loadUserItems()
      const idx = store.items.findIndex((x) => x.id === item.id)
      if (idx >= 0) return { ok: false, message: 'id already exists: ' + item.id, hint: 'use library_update instead' }
      store.items.push({ ...item, hidden: false, added: item.added || new Date().toISOString().slice(0, 10) })
      if (item.group) store.groups[item.id] = item.group
      await saveUserItems(store)
      return { ok: true, id: item.id, item: store.items[store.items.length - 1] }
    },
  }

  const toolUpdate = {
    name: 'library_update',
    description: 'Update fields of an existing library entry (title/group/tags/summary/notes/link/files). Works for hand-written entries too: the change is stored as an override in user-items.json.',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Entry id.' },
        title: { type: 'string' },
        group: { type: 'string' },
        summary: { type: 'string' },
        tags: { type: 'array', items: { type: 'string' } },
        notes: { type: 'array', items: { type: 'string' } },
        link: { type: 'string' },
        kind: { type: 'string' },
      },
      required: ['id'],
    },
    async execute(args) {
      const raw = args || {}
      const id = String(raw.id || '').trim()
      if (!id) return { ok: false, message: 'missing id' }
      const patch = sanitizeItem({ ...raw, id: undefined })
      delete patch.id
      delete patch.hidden
      if (!Object.keys(patch).length) return { ok: false, message: 'nothing to update' }

      const store = await loadUserItems()
      let idx = store.items.findIndex((x) => x.id === id)
      if (idx < 0) {
        const all = await loadAll()
        const current = all.items.find((x) => x.id === id)
        if (!current) return { ok: false, message: 'entry not found: ' + id }
        store.items.push({ ...sanitizeItem(current) })
        idx = store.items.length - 1
      }
      store.items[idx] = { ...store.items[idx], ...patch, id, hidden: false }
      if (patch.group) store.groups[id] = patch.group
      await saveUserItems(store)
      return { ok: true, id, item: store.items[idx] }
    },
  }

  const toolSaveUrl = {
    name: 'library_save_url',
    description:
      'Save a web page as a library entry: writes a local markdown snapshot under items/snapshots/ and creates an entry that opens in the built-in viewer. ' +
      'Two fetch modes: (a) pass `markdown` (preferred) with text you already extracted via DSH web_fetch / read_page — cleaner, handles JS-rendered pages, keeps code blocks; ' +
      '(b) omit it and the tool does its own plain HTTP fetch + regex tag stripping (no JS execution, HTML-only pages work; JS-heavy pages leak script text).',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'http(s) URL.' },
        markdown: {
          type: 'string',
          description:
            'Pre-extracted page body (markdown or plain text). When given, the tool skips its own fetch and stores this verbatim. ' +
            'Use output of DSH read_page / web_fetch for accurate extraction of JS-rendered pages.',
        },
        title: { type: 'string', description: 'Override the title (otherwise taken from markdown H1, <title>, or the URL).' },
        summary: { type: 'string', description: 'Override the one-line summary shown on the card.' },
        via: {
          type: 'string',
          enum: ['auto', 'deepseek', 'builtin', 'external'],
          description:
            'How to get the page body. `external` = use the `markdown` argument (highest quality, e.g. from DSH read_page). ' +
            '`deepseek` = DeepSeek official /v1/tools/fetch (markdown, 24h disk cache, needs API key). ' +
            '`builtin` = plain HTTP fetch + regex strip (old behaviour). ' +
            '`auto` (default): external if markdown given, else deepseek if a key exists, falling back to builtin.',
        },
        refresh: {
          type: 'boolean',
          description: 'Bypass the DeepSeek fetch cache and re-download (default false).',
        },
        tags: { type: 'array', items: { type: 'string' } },
        group: { type: 'string', description: 'Sub-group, e.g. 参考网站.' },
        kind: { type: 'string', description: 'Default website.' },
      },
      required: ['url'],
    },
    async execute(args) {
      const raw = args || {}
      const url = String(raw.url || '').trim()
      if (!/^https?:\/\//i.test(url)) return { ok: false, message: 'url must start with http(s)://' }

      // 外部已抽取好正文时（DSH web_fetch / read_page），跳过自带抓取。
      // 目的：JS 渲染的页面用裸 fetch 只能拿到 <script> 外壳，正则剥标签后
      // 会把内联脚本源码混进快照（实测 docker docs 快照里出现
      // `document.firstElementChild.className = ...` 之类的片段）。
      const provided = typeof raw.markdown === 'string' ? raw.markdown.trim() : ''
      const fromExternal = provided.length > 0

      let html = ''
      let body = provided
      let externalTitle = ''
      let externalDesc = ''

      /* 抓取方式：external > deepseek > builtin（auto 按此顺序挑第一个可用的） */
      let via = String(raw.via || 'auto').toLowerCase()
      if (!['auto', 'deepseek', 'builtin', 'external'].includes(via)) via = 'auto'
      if (via === 'external' && !fromExternal) via = 'auto'

      let usedVia = 'builtin'
      let cacheHit = false
      let cacheAgeMs = null
      let fetchedTitle = ''
      let fallbackNote = ''

      if (fromExternal) {
        usedVia = 'external'
        const h1 = (provided.match(/^#\s+(.+)$/m) || [])[1]
        externalTitle = (h1 || '').trim()
        const lines = provided.split('\n').map((s) => s.trim())
        externalDesc =
          lines.find((s) => s && !s.startsWith('#') && !s.startsWith('-') && !s.startsWith('```')) || ''
        externalDesc = externalDesc.slice(0, 200)
      } else {
        /* 先试 DeepSeek 官方 Fetch（能拿到干净 markdown，且带磁盘缓存） */
        const wantDeepseek = via === 'deepseek' || via === 'auto'
        if (wantDeepseek) {
          let dsKey = ''
          try {
            const cfgFile = JSON.parse(readFileSync(join(PLUGIN_DIR, 'config.json'), 'utf8'))
            dsKey = String((cfgFile.webKeys && cfgFile.webKeys.deepseek) || '')
          } catch {
            dsKey = ''
          }
          const keyInfo = resolveDeepseekKey({ configKey: dsKey })
          if (keyInfo.key) {
            const r = await dsFetch(CONFIG, url, { key: keyInfo.key, force: raw.refresh === true })
            if (r.ok) {
              body = r.content
              fetchedTitle = r.title
              usedVia = 'deepseek'
              cacheHit = r.cached === true
              cacheAgeMs = typeof r.ageMs === 'number' ? r.ageMs : null
              externalDesc = body
                .split('\n')
                .map((s) => s.trim())
                .find((s) => s && !s.startsWith('#') && !s.startsWith('-') && !s.startsWith('```')) || ''
              externalDesc = unescapeMd(externalDesc).slice(0, 200)
            } else if (via === 'deepseek') {
              /* 明确要求 deepseek 时，失败就报错，不偷偷换路 */
              return {
                ok: false,
                message: 'DeepSeek fetch failed: ' + (r.error || 'unknown'),
                notFetchable: r.notFetchable === true,
                hint: r.notFetchable
                  ? '该站点 DeepSeek Fetch 抓不了（返回 failed to fetch URL）。可改用 via="builtin"，或先用 read_page 抽取再传 markdown。'
                  : undefined,
              }
            } else {
              fallbackNote = 'deepseek fetch failed (' + (r.error || 'unknown') + '), fell back to builtin'
            }
          }
        }

        /* 兜底：内置裸 HTTP 抓取。
           必须 try/catch —— 对方站点可能直接断连（ECONNRESET）、TLS 失败、
           或 DNS 解析不了，这些都会让 fetch() 抛异常而不是返回非 2xx。
           抛出去会让整个工具调用崩掉，所以统一转成可读的失败结果。 */
        if (!body) {
          try {
            const res = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0 (compatible; dsh-ai-library)' } })
            if (!res.ok) return { ok: false, via: 'builtin', message: 'HTTP ' + res.status }
            html = await res.text()
            usedVia = 'builtin'
          } catch (error) {
            const why = String((error && error.message) || error)
            return {
              ok: false,
              via: 'builtin',
              message: '内置抓取失败: ' + why,
              hint: '该站点拒绝了直连（或被网络中间设备重置）。可先用 DSH 的 read_page 抽取正文，再以 markdown 参数传入。',
            }
          }
        }
      }

      const pick = (re) => {
        const m = html.match(re)
        return m ? m[1].trim() : ''
      }
      const decode = (s) =>
        s
          .replace(/&lt;/g, '<')
          .replace(/&gt;/g, '>')
          .replace(/&quot;/g, '"')
          .replace(/&#39;/g, "'")
          .replace(/&nbsp;/g, ' ')
          .replace(/&amp;/g, '&')

      const title =
        String(raw.title || '').trim() ||
        (usedVia === 'builtin'
          ? decode(pick(/<title[^>]*>([\s\S]*?)<\/title>/i))
          : fetchedTitle || externalTitle) ||
        url

      const desc =
        String(raw.summary || '').trim() ||
        (usedVia === 'builtin'
          ? decode(
              pick(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)["']/i) ||
                pick(/<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']*)["']/i),
            )
          : externalDesc)

      if (usedVia === 'builtin') {
        body = html
          .replace(/<script[\s\S]*?<\/script>/gi, ' ')
          .replace(/<style[\s\S]*?<\/style>/gi, ' ')
          .replace(/<[^>]+>/g, ' ')
          .replace(/&[a-z#0-9]+;/gi, ' ')
          .replace(/[ \t\u00a0]+/g, ' ')
          .replace(/\n{3,}/g, '\n\n')
          .trim()
      }

      const MODE_LABEL = {
        external: '外部抽取（DSH read_page / web_fetch）',
        deepseek: 'DeepSeek 官方 Fetch（/v1/tools/fetch）' + (cacheHit ? '· 缓存命中' : '· 实时抓取'),
        builtin: '内置抓取（裸 HTTP + 正则剥标签）',
      }
      const mode = MODE_LABEL[usedVia] || usedVia

      const id = 'url-' + createHash('sha1').update(url).digest('hex').slice(0, 10)
      const slug = (basename(new URL(url).pathname) || 'index').replace(/[^\w.-]+/g, '_').slice(0, 40)
      const rel = 'snapshots/' + id + '-' + slug + '.md'
      const abs = join(ITEMS_DIR, rel)
      await mkdir(join(ITEMS_DIR, 'snapshots'), { recursive: true })
      await writeFile(abs, `# ${title}\n\n- 来源：${url}\n- 抓取：${new Date().toISOString()}\n- 方式：${mode}\n\n## 描述\n\n${desc || '(无)'}\n\n## 正文快照\n\n${body.slice(0, 60000)}\n`, 'utf8')

      const item = sanitizeItem({
        id,
        kind: raw.kind || 'website',
        title,
        summary: desc || body.slice(0, 160),
        link: url,
        tags: raw.tags || ['网页快照'],
        notes: [
          '抓取于 ' + new Date().toISOString().slice(0, 16).replace('T', ' '),
          '抓取方式：' + mode,
          '本地快照：' + rel,
        ],
        files: [rel],
        preview: { variants: [{ label: '快照', src: rel }] },
        group: raw.group || '',
      })
      const store = await loadUserItems()
      const idx = store.items.findIndex((x) => x.id === id)
      if (idx >= 0) store.items[idx] = { ...store.items[idx], ...item, hidden: false }
      else store.items.push({ ...item, hidden: false, added: new Date().toISOString().slice(0, 10) })
      if (item.group) store.groups[id] = item.group
      await saveUserItems(store)
      return {
        ok: true,
        id,
        title,
        mode: usedVia,
        cacheHit,
        cacheAgeMs,
        savedSnapshot: abs,
        chars: body.length,
        ...(fallbackNote ? { note: fallbackNote } : {}),
        item: store.items.find((x) => x.id === id),
      }
    },
  }

  const toolTranslate = {
    name: 'library_translate',
    description:
      'Submit a PDF from the library to the local PDFMathTranslate service (preserves the original layout) and return a jobId immediately. Poll with library_job. Requires the optional Docker service described in the README; when it is down this returns a clear error.',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Entry id whose file should be translated.' },
        variant: { type: 'string', description: 'Optional variant label to choose a specific file.' },
      },
      required: ['id'],
    },
    async execute(args) {
      const raw = args || {}
      const id = String(raw.id || '').trim()
      const all = await loadAll()
      const item = all.items.find((x) => x.id === id)
      if (!item) return { ok: false, message: 'entry not found: ' + id }
      const cands = itemFileCandidates(item).filter((c) => extname(c.path).toLowerCase() === '.pdf')
      if (!cands.length) return { ok: false, message: '这条没有 PDF 文件，无法翻译' }
      const pick = raw.variant ? cands.find((c) => c.label === raw.variant) || cands[0] : cands[0]

      let submitted
      try {
        submitted = await submitTranslation(pick.path)
      } catch (error) {
        return {
          ok: false,
          message: '翻译服务不可用：' + String((error && error.message) || error),
          hint: '需要 PDFMathTranslate 在本机运行（默认 ' + CONFIG.translateUrl + '），见 README「可选环境」。其余功能不受影响。',
        }
      }
      const taskId = String((submitted && submitted.id) || '').trim()
      if (!taskId) return { ok: false, message: '翻译服务没有返回任务号', raw: submitted }

      const jobId = 'tr-' + Date.now().toString(36)
      await mkdir(JOB_DIR, { recursive: true })
      const job = { jobId, kind: 'translate', itemId: id, file: pick.path, taskId, status: 'running', startedAt: new Date().toISOString() }
      await writeFile(join(JOB_DIR, jobId + '.json'), JSON.stringify(job, null, 2), 'utf8')
      return { ok: true, jobId, taskId, itemId: id, file: pick.path, note: '用 library_job 传 jobId 查进度。' }
    },
  }

  const toolJob = {
    name: 'library_job',
    description: 'Check one long-running job (or list all). For translate jobs it refreshes the status from the PDFMathTranslate service.',
    parameters: {
      type: 'object',
      properties: { jobId: { type: 'string', description: 'Omit to list all jobs.' } },
    },
    isConcurrencySafe: () => true,
    async execute(args) {
      let names = []
      try {
        names = (await readdir(JOB_DIR)).filter((f) => f.endsWith('.json'))
      } catch {
        return { ok: true, jobs: [] }
      }
      const wanted = args && args.jobId ? String(args.jobId) : ''

      const out = []
      for (const name of names.slice(-20)) {
        const file = join(JOB_DIR, name)
        let job = null
        try {
          job = JSON.parse(await readFile(file, 'utf8'))
        } catch {
          continue
        }
        if (wanted && job.jobId !== wanted) continue

        if (job.kind === 'translate' && job.status === 'running') {
          try {
            const status = await translationStatus(job.taskId)
            const stage = String((status && (status.status || status.state)) || '')
            const done = /success|done|finished|completed/i.test(stage)
            const failed = /fail|error|cancel/i.test(stage)
            job.status = done ? 'done' : failed ? 'failed' : 'running'
            job.stage = stage || 'unknown'
            job.progress = status && (status.progress ?? status.percent ?? null)
            if (done || failed) job.finishedAt = new Date().toISOString()
            await writeFile(file, JSON.stringify(job, null, 2), 'utf8')
          } catch (error) {
            job.status = 'unknown'
            job.error = String((error && error.message) || error)
          }
        }
        out.push(job)
      }
      if (wanted) return out.length ? { ok: true, job: out[0] } : { ok: false, message: 'job not found: ' + wanted }
      return { ok: true, jobs: out }
    },
  }

  /**
   * 把返回值洗成「无损 JSON」：去掉 undefined、NaN、Infinity、函数、symbol。
   * dsh-tools 会校验 execute 的返回值，出现 undefined 属性会报
   * "value is not lossless JSON"。
   * @param value 任意值
   * @returns 可安全 JSON 序列化的副本
   */
  function toLossless(value) {
    if (value === null || value === undefined) return null
    const t = typeof value
    if (t === 'string' || t === 'boolean') return value
    if (t === 'number') return Number.isFinite(value) ? value : null
    if (t === 'bigint') return String(value)
    if (t === 'function' || t === 'symbol') return null
    if (Array.isArray(value)) return value.map(toLossless)
    if (t === 'object') {
      const out = {}
      for (const [k, v] of Object.entries(value)) {
        if (v === undefined) continue
        out[k] = toLossless(v)
      }
      return out
    }
    return null
  }

  /* 网页缓存管理：看命中规模、清缓存。配合 library_save_url 的 via=deepseek 用。 */
  const toolWebCache = {
    name: 'library_web_cache',
    description:
      'Inspect or clear the on-disk cache of pages downloaded through DeepSeek /v1/tools/fetch. ' +
      'Cached pages are reused for 24h by library_save_url (pass refresh=true to bypass), so repeat saves cost no API call. ' +
      'Use action=stats to see count/size, action=clear to wipe it.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['stats', 'clear'], description: 'Default stats.' },
      },
    },
    isConcurrencySafe: () => false,
    async execute(args) {
      const action = String((args && args.action) || 'stats').toLowerCase()
      if (action === 'clear') {
        const n = webCacheClear(CONFIG)
        return { ok: true, action: 'clear', removed: n }
      }
      const s = webCacheStats(CONFIG)
      return {
        ok: true,
        action: 'stats',
        dir: s.dir,
        pages: s.count,
        bytes: s.bytes,
        kb: Math.round((s.bytes / 1024) * 10) / 10,
        newestAt: s.newest ? new Date(s.newest).toISOString() : null,
        ttlHours: 24,
      }
    },
  }

  const all = [toolSearch, toolGet, toolRead, toolStats, toolAdd, toolUpdate, toolSaveUrl, toolImport, toolAutoCapture, toolRepoBuild, toolWebSearch, toolWebCollect, toolWebCache, toolPaperSearch, toolPaperAdd, toolTranslate, toolJob]
  for (const tool of all) {
    /* dsh-tools 硬性要求：output 必须同时有 schema 和 render，
       否则 register 会抛 TypeError —— 之前 9 个工具全被拒就是缺 render。 */
    const render = RENDER[tool.name] || ((v) => JSON.stringify(v, null, 2))
    tool.output = {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: String(render(value) ?? '') }],
    }

    /* 包一层：所有返回值都洗成无损 JSON，否则 DSH 会拒绝（render 也会拿到干净值） */
    const originalExecute = tool.execute
    tool.execute = async (args, exec) => toLossless(await originalExecute(args, exec))
  }

  /* 一键关闭开关：config.json 里 "toolsEnabled": false */
  if (CONFIG.toolsEnabled === false) {
    console.log('[ai-library] toolsEnabled=false，跳过工具注册')
    return
  }

  /* 幂等：同一个 ctx 只注册一次（effect 重跑时会再调进来） */
  const flag = Symbol.for('dsh-ai-library.tools-registered')
  let already = false
  try {
    already = !!(ctx && ctx[flag])
  } catch {
    /* Proxy 可能拒绝读 Symbol，当作未注册 */
    already = false
  }
  if (already) return
  try {
    Object.defineProperty(ctx, flag, { value: true, configurable: true })
  } catch {
    /* 写入失败不影响注册（最多重复注册，外层有按名去重） */
  }

  try {
    const { appendFileSync: af, mkdirSync: mk } = require('node:fs')
    mk(CONFIG.cacheDir, { recursive: true })
    af(
      CONFIG.cacheDir + '/tools-trace.jsonl',
      JSON.stringify({ at: new Date().toISOString(), pid: process.pid, electron: process.versions.electron || null, hasCtx: !!ctx, hasTools: !!(ctx && ctx.tools), registerType: typeof (ctx && ctx.tools && ctx.tools.register) }) + String.fromCharCode(10),
    )
  } catch {}

  if (!ctx || !ctx.tools || typeof ctx.tools.register !== 'function') {
    console.warn('[ai-library] tools 服务不可用，跳过工具注册')
    return
  }

  const ok = []
  const failed = []
  /* 开机自动收一次（config.autoCaptureOnBoot 打开才跑，延迟 8 秒不挡启动） */
  if (CONFIG.autoCaptureOnBoot && Array.isArray(CONFIG.watchDirs) && CONFIG.watchDirs.length) {
    setTimeout(() => {
      try {
        toolAutoCapture.execute({}).then((r) => {
          console.log('[ai-library] 开机自动入库:', r && r.ok ? (r.added || 0) + ' 个新文件' : (r && r.message) || '失败')
        })
      } catch (error) {
        console.warn('[ai-library] 开机自动入库异常:', error && error.message)
      }
    }, 8000)
  }

  for (const tool of all) {
    try {
      ctx.tools.register(tool)
      ok.push(tool.name)
    } catch (error) {
      failed.push(tool.name + ': ' + String((error && error.message) || error))
    }
  }
  console.log('[ai-library] 工具注册成功 ' + ok.length + ' 个' + (failed.length ? '，失败 ' + failed.length + ' 个 → ' + failed.join(' | ') : ''))

  /* 落盘一份注册结果：工具/面板出问题时可以直接看这个文件（ESM 里没有 require） */
  try {
    const { writeFileSync: wf, mkdirSync: mk } = require('node:fs')
    mk(CONFIG.cacheDir, { recursive: true })
    wf(
      CONFIG.cacheDir + '/tools-registered.json',
      JSON.stringify({ at: new Date().toISOString(), pid: process.pid, electron: process.versions.electron || null, ok, failed, node: process.version }, null, 2),
      'utf8',
    )
  } catch (error) {
    console.warn('[ai-library] 写注册结果失败:', error && error.message)
  }
}
