/**
 * ai-library · 配置解析
 * ---------------------------------------------------------------------------
 * 目标：插件代码里**不许再出现本机绝对路径**，全部从这里出。
 *
 * 优先级（从高到低）：
 *   1. 环境变量（AILIB_ROOT / SOFFICE / AILIB_MOTION_DIR / PDFMATHTRANSLATE_URL）
 *   2. 插件目录下的 config.json
 *   3. 内置默认值（开发机上就是原来那套路径，老用户升级无感）
 *
 * 发布给别人时，别人只要配 config.json 或设 AILIB_ROOT 就能用。
 */
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 插件根目录（lib/ 的上一层）。 */
export const PLUGIN_DIR = dirname(dirname(fileURLToPath(import.meta.url)))

/**
 * 读插件目录下的 config.json（读不到就空对象）。
 * @returns 用户配置
 */
function readUserConfig() {
  const file = join(PLUGIN_DIR, 'config.json')
  try {
    if (!existsSync(file)) return {}
    /* 去 BOM：Windows 记事本存出来的 config.json 常带 BOM，会整份解析失败 */
    const text = readFileSync(file, 'utf8').replace(/^\uFEFF/, '')
    return JSON.parse(text)
  } catch (error) {
    /* 不再静默：写错的配置要能看见，否则会被当成「全部默认值」 */
    globalThis.__ailibConfigError = String((error && error.message) || error)
    try {
      console.warn('[ai-library] config.json 解析失败，已回退默认值：' + globalThis.__ailibConfigError)
    } catch {
      /* 忽略 */
    }
    return {}
  }
}

/**
 * 探测 LibreOffice 常见安装位置。
 * @returns 可执行文件路径（找不到就给默认值，调用时再报错）
 */
function detectSoffice() {
  const candidates = [
    'C:/Program Files/LibreOffice/program/soffice.exe',
    'C:/Program Files (x86)/LibreOffice/program/soffice.exe',
    '/usr/bin/soffice',
    '/usr/local/bin/soffice',
    '/Applications/LibreOffice.app/Contents/MacOS/soffice',
  ]
  for (const p of candidates) {
    try {
      if (existsSync(p)) return p
    } catch {
      /* 继续找下一个 */
    }
  }
  return candidates[0]
}

/**
 * 解析完整配置。
 * @returns 配置对象
 */
export function resolveConfig() {
  const user = readUserConfig()

  /* 数据根目录：env > config.json > ~/ai-library（跨平台中性默认） */
  const fallbackRoot = join(homedir(), 'ai-library').split(sep).join('/')
  const root = String(process.env.AILIB_ROOT || user.root || fallbackRoot).replace(/[/\\]+$/, '')

  /** 拼一个相对 root 的绝对路径，统一用 / 分隔（Node 在 Windows 也认）。 */
  const under = (rel) => join(root, rel).split(sep).join('/')

  return {
    /* ── 数据根 ── */
    root,
    libraryFile: user.libraryFile || under('library.js'),
    projectFile: user.projectFile || under('project-items.js'),
    marketFile: user.marketFile || under('market-items.js'),
    githubFile: user.githubFile || under('github-items.js'),
    /** 编辑器写入的用户条目（新增 / 覆盖）。 */
    userItemsFile: user.userItemsFile || under('user-items.json'),
    itemsDir: user.itemsDir || under('items'),
    cacheDir: user.cacheDir || under('.cache'),
    translateCache: user.translateCache || under('.cache/translate'),
    marketCache: user.marketCache || under('.cache/market.json'),

    /* ── 插件自带 ── */
    vendorDir: join(PLUGIN_DIR, 'vendor').split(sep).join('/'),

    /* ── 外部依赖 ── */
    soffice: String(process.env.SOFFICE || user.soffice || detectSoffice()),
    /* 外部只读挂载源：默认空 = 关闭。填了才出现「提示词」那一类。 */
    motionDir: String(process.env.AILIB_MOTION_DIR || user.motionDir || ''),
    translateUrl: String(process.env.PDFMATHTRANSLATE_URL || user.translateUrl || 'http://127.0.0.1:11008').replace(/\/+$/, ''),

    /* 工作目录：自动入库默认扫这里（不配置就是进程 cwd） */
    workspaceDir: String(process.env.AILIB_WORKSPACE || user.workspaceDir || process.cwd()),

    /* 额外监听目录（空 = 只扫工作目录） */
    watchDirs: Array.isArray(user.watchDirs) ? user.watchDirs : [],
    autoCaptureOnBoot: user.autoCaptureOnBoot === true,
    autoCaptureProject: String(user.autoCaptureProject || '自动入库'),
    autoCaptureDepth: Number(user.autoCaptureDepth || 2),

    /* 论文检索：复用上游项目的 paper_import.py（标准库实现，多源检索） */

    /* 是否把资料馆注册成 AI 工具（关掉只是没有工具，面板照常） */
    toolsEnabled: user.toolsEnabled !== false,

    /* ── 可调参数 ── */
    marketUrl: user.marketUrl || 'https://api.dshmk.com/',
    /** 市场同步默认关闭，用户自己 config.json 里打开。 */
    marketEnabled: user.marketEnabled !== false && user.marketEnabled !== undefined,
    marketLimit: Number(user.marketLimit || 300),
    marketTtlMs: Number(user.marketTtlMs || 6 * 60 * 60 * 1000),
  }
}

/** 解析结果，模块加载时算一次。 */
/** 把 ~ 展开成用户主目录（Windows 上也能用）。 */
function expandHome(p) {
  const raw = String(p || '').trim()
  if (!raw) return raw
  if (raw === '~') return homedir()
  if (/^~[\\/]/.test(raw)) return join(homedir(), raw.slice(2))
  return raw
}

const __rawConfig = resolveConfig()
/* 统一展开 ~ —— 有些人会把 root 写成 "~/ai-library" */
/* 所有路径类字段统一展开 ~（不只是 root） */
const PATH_KEYS = [
  'root', 'libraryFile', 'projectFile', 'marketFile', 'githubFile', 'userItemsFile',
  'itemsDir', 'cacheDir', 'translateCache', 'marketCache', 'vendorDir',
  'motionDir', 'workspaceDir', 'soffice',
]
const __expanded = { ...__rawConfig }
for (const key of PATH_KEYS) {
  if (typeof __expanded[key] === "string") __expanded[key] = expandHome(__expanded[key])
}
if (Array.isArray(__expanded.watchDirs)) {
  __expanded.watchDirs = __expanded.watchDirs.map((x) => (typeof x === "string" ? expandHome(x) : x))
}
export const CONFIG = __expanded
