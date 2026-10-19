/**
 * DeepSeek 官方「联网工具」两个接口的客户端 + 本地缓存。
 *
 *   POST https://api.deepseek.com/v1/tools/search   { query }  →  { results: [...] }
 *   POST https://api.deepseek.com/v1/tools/fetch    { url }    →  { content, title }
 *
 * 鉴权与 DeepSeek API 相同（Bearer）。key 按下面顺序找：
 *   1. config.json 的 webKeys.deepseek
 *   2. 环境变量 DEEPSEEK_API_KEY
 *   3. ~/.dsh/.credentials.yaml 里的 DEEPSEEK_API_KEY（DSH 桌面版登录取的）
 *
 * ⚠️ 实测（2026-10-19）踩到的三个坑，写在这里免得后人再踩：
 *
 *  1. **正文是「转义过的 markdown」**
 *     返回的 content 里标题是 `\# 标题`、句点是 `Node\.js`、括号是 `\(`。
 *     直接存盘，面板渲染出来是一堆反斜杠、标题也不成标题。必须先反转义（见 unescapeMd）。
 *     另外没有 ``` 代码围栏 —— 它是把原页面的 markdown 再转义了一层。
 *
 *  2. **部分站点抓不了**
 *     docs.docker.com、zh.wikipedia.org 都返回 404 `failed to fetch URL`。
 *     所以调用方要能降级（退回内置裸抓取 / 提示用户），不能当成致命错误。
 *
 *  3. **同一 URL 的返回完全一致**
 *     连抓两次 content 字节级相同 → 按 URL 缓存是安全的，这就是「提高缓存」的依据。
 *     缓存默认 24 小时，可被 force 参数绕过。
 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, mkdirSync, writeFileSync, readdirSync, statSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const BASE = 'https://api.deepseek.com'
const EP_SEARCH = '/v1/tools/search'
const EP_FETCH = '/v1/tools/fetch'

/** 缓存默认存活时间：24 小时。网页内容一天内基本不变，够用又不会太陈旧。 */
export const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000

/* ────────────────────────── key 解析 ────────────────────────── */

/**
 * 从 ~/.dsh/.credentials.yaml 抠 DEEPSEEK_API_KEY。
 * 只做极简解析（这个文件是扁平的 key: value），不引 yaml 依赖。
 */
function keyFromDshCredentials() {
  try {
    const file = join(homedir(), '.dsh', '.credentials.yaml')
    if (!existsSync(file)) return ''
    const txt = readFileSync(file, 'utf8')
    const m = txt.match(/DEEPSEEK_API_KEY\s*:\s*(\S+)/)
    if (!m) return ''
    return m[1].replace(/^["']|["']$/g, '').trim()
  } catch {
    return ''
  }
}

/**
 * 解析出可用的 key。
 * @param {object} [opts]
 * @param {string} [opts.configKey] config.json 里的 webKeys.deepseek
 * @returns {{ key: string, source: string }} source 便于排查（不会泄露 key 本身）
 */
export function resolveDeepseekKey(opts = {}) {
  const fromConfig = String(opts.configKey || '').trim()
  if (fromConfig) return { key: fromConfig, source: 'config' }
  const fromEnv = String(process.env.DEEPSEEK_API_KEY || '').trim()
  if (fromEnv) return { key: fromEnv, source: 'env' }
  const fromCred = keyFromDshCredentials()
  if (fromCred) return { key: fromCred, source: 'dsh-credentials' }
  return { key: '', source: 'none' }
}

/* ───────────────────── markdown 反转义 ───────────────────── */

/**
 * 把 DeepSeek 转义过的 markdown 还原。
 *
 * 它把 ASCII 标点前都加了反斜杠（`\.` `\-` `\#` `\(` `\!`），
 * 标准 markdown 里 `\X` 会渲染成字面 X，所以去反斜杠 = 还原。
 *
 * 已知代价：正文里本来就存在、且恰好是 ASCII 标点的反斜杠会被一起吃掉
 * （例如正则 `\d` 不受影响（d 不是标点），但 `\.` 会变 `.`）。
 * 对「存网页快照」这个用途，可读性比这点保真更重要。
 */
export function unescapeMd(s) {
  if (typeof s !== 'string' || !s) return s || ''
  // ASCII 标点区间：! " # $ % & ' ( ) * + , - . / : ; < = > ? @ [ \ ] ^ _ ` { | } ~
  return s.replace(/\\([!-/:-@[-`{-~])/g, '$1')
}

/* ───────────────────────── 缓存层 ───────────────────────── */

function cacheDir(cfg) {
  const dir = join(cfg.cacheDir || join(cfg.root || '.', '.cache'), 'web')
  mkdirSync(dir, { recursive: true })
  return dir
}

function cachePath(cfg, url) {
  const hash = createHash('sha1').update(url).digest('hex').slice(0, 16)
  return join(cacheDir(cfg), hash + '.json')
}

/**
 * 读缓存。
 * @returns {{ hit: boolean, entry?: object, ageMs?: number }}
 */
export function readCache(cfg, url, ttlMs = DEFAULT_TTL_MS) {
  try {
    const file = cachePath(cfg, url)
    if (!existsSync(file)) return { hit: false }
    const entry = JSON.parse(readFileSync(file, 'utf8'))
    if (!entry || entry.url !== url) return { hit: false }
    const ageMs = Date.now() - Number(entry.fetchedAt || 0)
    if (!(ageMs >= 0) || ageMs > ttlMs) return { hit: false, staleMs: ageMs }
    return { hit: true, entry, ageMs }
  } catch {
    return { hit: false }
  }
}

/** 写缓存（失败不抛，缓存是尽力而为）。 */
export function writeCache(cfg, url, payload) {
  try {
    const entry = {
      url,
      title: payload.title || '',
      content: payload.content || '',
      fetchedAt: Date.now(),
      bytes: (payload.content || '').length,
    }
    writeFileSync(cachePath(cfg, url), JSON.stringify(entry), 'utf8')
    return true
  } catch {
    return false
  }
}

/** 清空 / 统计网页缓存。 */
export function cacheStats(cfg) {
  try {
    const dir = cacheDir(cfg)
    const files = readdirSync(dir).filter((f) => f.endsWith('.json'))
    let bytes = 0
    let newest = 0
    for (const f of files) {
      try {
        const st = statSync(join(dir, f))
        bytes += st.size
        if (st.mtimeMs > newest) newest = st.mtimeMs
      } catch {
        /* 忽略 */
      }
    }
    return { dir, count: files.length, bytes, newest }
  } catch {
    return { dir: '', count: 0, bytes: 0, newest: 0 }
  }
}

export function clearCache(cfg) {
  try {
    const dir = cacheDir(cfg)
    let n = 0
    for (const f of readdirSync(dir)) {
      if (!f.endsWith('.json')) continue
      try {
        rmSync(join(dir, f))
        n++
      } catch {
        /* 忽略 */
      }
    }
    return n
  } catch {
    return 0
  }
}

/* ────────────────────────── 网络调用 ────────────────────────── */

async function postJson(path, body, key, timeoutMs = 30000) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetch(BASE + path, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer ' + key,
      },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    })
    const text = await res.text()
    let json = null
    try {
      json = JSON.parse(text)
    } catch {
      /* 非 JSON */
    }
    if (!res.ok || (json && json.error)) {
      const msg = (json && json.error && json.error.message) || ('HTTP ' + res.status)
      return { ok: false, status: res.status, error: msg, raw: text.slice(0, 400) }
    }
    return { ok: true, status: res.status, json }
  } catch (e) {
    return { ok: false, status: 0, error: String((e && e.message) || e) }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 抓单个网页 → markdown。
 *
 * @param {object} cfg   CONFIG（需要 cacheDir / root）
 * @param {string} url
 * @param {object} [opts]
 * @param {string} [opts.key]      已解析的 key；不给就自己解析
 * @param {boolean} [opts.force]   true = 跳过缓存强制刷新
 * @param {number} [opts.ttlMs]    缓存存活时间
 * @returns {Promise<{ok:boolean, title?:string, content?:string, cached?:boolean,
 *                    ageMs?:number, error?:string, notFetchable?:boolean}>}
 */
export async function dsFetch(cfg, url, opts = {}) {
  const target = String(url || '').trim()
  if (!/^https?:\/\//i.test(target)) return { ok: false, error: 'url must start with http(s)://' }

  /* 1. 缓存 */
  if (!opts.force) {
    const c = readCache(cfg, target, opts.ttlMs || DEFAULT_TTL_MS)
    if (c.hit) {
      return {
        ok: true,
        cached: true,
        ageMs: c.ageMs,
        title: c.entry.title,
        content: c.entry.content,
      }
    }
  }

  /* 2. key */
  const { key } = opts.key ? { key: opts.key } : resolveDeepseekKey(opts)
  if (!key) return { ok: false, error: 'no DeepSeek API key (webKeys.deepseek / DEEPSEEK_API_KEY / ~/.dsh/.credentials.yaml)' }

  /* 3. 请求 */
  const r = await postJson(EP_FETCH, { url: target }, key)
  if (!r.ok) {
    // 404 + failed to fetch URL = 该站点抓不了，调用方应降级
    const notFetchable = /failed to fetch URL/i.test(r.error || '')
    return { ok: false, error: r.error, notFetchable, status: r.status }
  }

  const content = unescapeMd(String((r.json && r.json.content) || ''))
  const title = String((r.json && r.json.title) || '').trim()
  if (!content) return { ok: false, error: 'empty content from fetch API' }

  writeCache(cfg, target, { title, content })
  return { ok: true, cached: false, title, content }
}

/**
 * 清理搜索结果的标题：有的结果是裸 HTML/代码文件，
 * title 里会带 `<h2 id="…">` 这类标签，直接显示很难看。
 */
function cleanTitle(s) {
  let t = String(s || '')
  // 去掉 HTML 标签
  t = t.replace(/<[^>]*>/g, ' ')
  // 常见实体
  t = t
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
  // 折叠空白
  t = t.replace(/\s+/g, ' ').trim()
  return t
}

/**
 * 搜索网页。
 *
 * 官方请求字段（见 API Reference）：
 *   query        必填，1~128 字符，支持搜索语法（site: / -site: / -词 / -"短语" / "短语" / lang: / after: / before:）
 *   count        返回条数 1~50，默认 10
 *   ori_question 触发搜索的原始问题，帮助理解意图，1~128 字符
 *   localization 优先本地化结果的 IP 地址
 *   need_content 是否在 content 里返回网页正文（默认 false → content 恒为空串）
 * 未知字段会被忽略 —— 所以别写 limit，要写 count。
 *
 * @param {object} cfg
 * @param {string} query
 * @param {object} [opts]
 * @param {number} [opts.count]        1~50，默认 10
 * @param {boolean} [opts.needContent] true 时每条带 content（正文），可省掉一次 Fetch
 * @param {string} [opts.oriQuestion]  原始问题
 * @param {string} [opts.localization] 本地化 IP
 * @param {number} [opts.limit]        兼容旧参数：等价于 count
 * @returns {Promise<{ok:boolean, results?:Array, error?:string}>}
 */
export async function dsSearch(cfg, query, opts = {}) {
  const q = String(query || '').trim()
  if (!q) return { ok: false, error: 'query is required' }
  if (q.length > 128) return { ok: false, error: 'query 超过 128 字符上限（官方限制）' }

  const { key } = opts.key ? { key: opts.key } : resolveDeepseekKey(opts)
  if (!key) return { ok: false, error: 'no DeepSeek API key (webKeys.deepseek / DEEPSEEK_API_KEY / ~/.dsh/.credentials.yaml)' }

  /* 组装请求体：只放官方认识的字段 */
  const body = { query: q }
  const want = Number(opts.count != null ? opts.count : opts.limit)
  body.count = Math.min(50, Math.max(1, Number.isFinite(want) && want > 0 ? Math.round(want) : 10))
  if (opts.needContent === true) body.need_content = true
  const oq = String(opts.oriQuestion || '').trim()
  if (oq) body.ori_question = oq.slice(0, 128)
  const loc = String(opts.localization || '').trim()
  if (loc) body.localization = loc

  const r = await postJson(EP_SEARCH, body, key)
  if (!r.ok) return { ok: false, error: r.error }

  const raw = (r.json && Array.isArray(r.json.results)) ? r.json.results : []
  const results = raw.map((x) => {
    const url = String(x.url || '').trim()
    let title = cleanTitle(x.title)
    // 有些结果（例如 raw.githubusercontent.com 的裸文件）没有可用 title，
    // 退化成「域名/末段路径」，否则卡片会是空标题或一串 HTML。
    if (!title && url) {
      try {
        const u = new URL(url)
        const last = decodeURIComponent(u.pathname.split('/').filter(Boolean).pop() || '')
        title = last ? u.hostname + '/' + last : u.hostname
      } catch {
        title = url
      }
    }
    const score = Number(x.rerank_score) || 0
    const authority = Number(x.authority)
    return {
      title,
      url,
      site: String(x.site_name || '').trim(),
      siteIcon: String(x.site_icon || '').trim(),
      date: String(x.date || '').trim(),
      // snippet ≈ 100~200 字，适合展示；summary ≈ 600~800 字，适合给模型读
      snippet: cleanTitle(String(x.snippet || '')).slice(0, 400),
      summary: cleanTitle(String(x.summary || '')).slice(0, 1600),
      // need_content=false 时官方恒返回空串，这里就留空
      content: x.content ? unescapeMd(String(x.content)) : '',
      // rerank_score 0~3，>=1.5 算优质；authority 0~4（-1 未知），>=3 极权威
      score,
      authority: Number.isFinite(authority) ? authority : -1,
      quality: score >= 1.5,
      authoritative: Number.isFinite(authority) && authority >= 3,
    }
  })
  return {
    ok: true,
    total: raw.length,
    requested: body.count,
    needContent: body.need_content === true,
    results,
  }
}
