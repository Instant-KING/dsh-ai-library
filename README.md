# dsh-ai-library · 资料馆

> 仓库：<https://github.com/Instant-KING/dsh-ai-library> · npm：`dsh-ai-library`

把**本地多源资料库**渲染成 DeepSeek Harness 的原生面板：左侧三级分类树、中间卡片网格、右侧预览（自带 pdf.js 阅读器），支持条目编辑与拖拽分组。

- 自带 pdf.js **4.10.38**，不需要外网 CDN
- Markdown 现场渲染、Office 文件转 PDF 预览
- 拖拽卡片改分组、批量打标签、新建/编辑/删除条目
- 数据全部留在本地，插件本身不联网（除非你开启市场同步）

---

## 安装

三种方式，选一种（装完**重启 DSH**）：

```bash
# ① npm（推荐）
dsh plugin --profile desktop add dsh-ai-library

# ② 直接从 GitHub
dsh plugin --profile desktop add github:Instant-KING/dsh-ai-library

# ③ 本地目录（开发用，不装包）
# clone 后在 profile 的 cordis.patch.yml 里用绝对路径 insert：
#   - insert:
#       - id: dsh-ai-library
#         name: E:/path/to/dsh-ai-library/lib/index.js
```

装完第一次打开面板会自动建空库；把文件丢进 `~/ai-library/items/` 就能看到。

## 配置

插件目录下的 `config.json`（可不建，全部字段都有默认值）。参考 [config.example.json](config.example.json)。

| 字段 | 默认 | 说明 |
|---|---|---|
| `root` | `~/ai-library` | 数据根目录，其余路径从它推出 |
| `libraryFile` | `<root>/library.js` | 手写条目 |
| `projectFile` | `<root>/project-items.js` | 批量导入条目（可选） |
| `marketFile` | `<root>/market-items.js` | 市场同步产物（可选） |
| `githubFile` | `<root>/github-items.js` | GitHub 项目同步产物（可选） |
| `userItemsFile` | `<root>/user-items.json` | 面板编辑器写入的条目 |
| `itemsDir` | `<root>/items` | 文件根目录（只允许读这里） |
| `cacheDir` | `<root>/.cache` | 缓存 |
| `translateCache` | `<cache>/translate` | 翻译产物 |
| `marketCache` | `<cache>/market.json` | 市场原始目录缓存 |
| `vendorDir` | `<插件>/vendor` | 内置 pdf.js / three.js |
| `soffice` | 自动探测 | LibreOffice 可执行文件（Office 转 PDF） |
| `motionDir` | 空（关闭） | 外部只读挂载的提示词库 |
| `translateUrl` | `http://127.0.0.1:11008` | PDFMathTranslate 服务 |
| `workspaceDir` | 空 | 自动入库扫描的根目录 |
| `watchDirs` | `[]` | 自动入库监听的目录 |
| `autoCaptureOnBoot` | `false` | 启动后自动扫一次 watchDirs |
| `autoCaptureProject` | `自动入库` | 自动入库的分组名 |
| `autoCaptureDepth` | `2` | 自动入库递归深度 |
| `toolsEnabled` | `true` | 是否注册 14 个 AI 工具 |
| `marketUrl` | `https://api.dshmk.com/` | 插件市场源 |
| `marketEnabled` | `false` | 是否自动同步市场（默认关，开了启动后自动拉） |
| `marketLimit` | `300` | 市场最多收录条数 |
| `marketTtlMs` | 6 小时 | 市场缓存有效期 |
| `paperKeys` | `{}` | `{ ieee, elsevier, springer }`，论文检索用 |

所有路径字段都支持 `~`（会展开成用户主目录）。环境变量（优先级高于 config.json）：

```
AILIB_ROOT  AILIB_MOTION_DIR  AILIB_WORKSPACE  SOFFICE  PDFMATHTRANSLATE_URL
```

> 论文检索已内置（`lib/paper.js`，纯 Node），**不需要 Python**，也不需要外部项目。

## 数据格式

`library.js` 是普通 JS：

```js
window.LIBRARY = {
  title: '我的资料库',
  items: [
    {
      id: 'k-1',                 // 唯一，必填
      kind: 'paper',             // paper / plugin / doc / note …
      status: 'available',
      title: '一维谐振子',
      summary: '升降算符解法',
      source: 'arXiv',
      tags: ['量子力学'],
      notes: ['摘自2026-03讲座'],
      files: ['items/papers/harmonic.pdf'],   // 相对 items/
      preview: {
        variants: [
          { label: '原文', src: 'papers/harmonic.pdf' },
          { label: '笔记', src: 'notes/harmonic.md' },
        ],
      },
    },
  ],
  groups: {
    'k-1': '力学',               // id → 子分类，不写就落到「未分类」
  },
}
```

把文件丢进 `<root>/items/`，条目里写相对路径即可。

### 合并优先级

```
多个数据源按顺序合并，后写的覆盖先写的：

  外部挂载源  <  批量导入  <  市场同步  <  GitHub  <  library.js  <  user-items.json
```

`user-items.json` 优先级最高，所以**编辑器改的东西永远生效，但不会动你的 `library.js`**。

---

## 编辑

| 操作 | 入口 |
|---|---|
| 新建 | 面板右上「＋ 新建」 |
| 编辑 | 卡片右上 ✎ |
| 删除 | 卡片右上 🗑（手写条目会被**隐藏**，源文件不动） |
| 改分组 | 把卡片**拖到左栏分组行** |
| 多选 | 卡片右上 ＋，或 Ctrl + 点击卡片 |
| 批量 | 选中后顶部出现：改分组 / 加标签 / 删除 |

> 删 `user-items.json` 即可回到「只有 library.js」的原始状态。

---

## 给 AI 的工具

资料馆把这些能力**注册成工具**，AI 可以直接调用（不用翻文件）。共 14 个：

| 工具 | 类型 | 作用 |
|---|---|---|
| `library_search` | 只读 | 搜条目。`meta` 搜标题/摘要/标签/备注；`fulltext` 深入文件内容（md/代码/PDF），返回命中片段；支持 `group` 限定 |
| `library_get` | 只读 | 取一条的完整信息 + 文件是否存在 |
| `library_read` | 只读 | 抽文本：md/txt 直读，PDF 用自带 pdf.js（可按页） |
| `library_stats` | 只读 | 按类型/分组统计、有文件数、文本缓存状态 |
| `library_add` | 写入 | 新建条目（只写 `user-items.json`） |
| `library_update` | 写入 | 改字段（手写条目也能改，存为覆盖副本） |
| `library_save_url` | 写入 | 抓网页 → 存本地 md 快照 → 建条目 |
| `library_import` | 写入 | 把目录里的产物（pptx/docx/pdf/md/png/mp4…）批量入馆 |
| `library_autocapture` | 写入 | 增量入库：只收上次扫描后新增/变化的文件 |
| `library_repo_build` | 写入 | 从仓库建库：clone GitHub 或扫本地目录，README + docs 建条目 |
| `library_paper_search` | 检索 | 十源论文检索（内置实现，无需 Python） |
| `library_paper_add` | 写入 | 把检索结果存成 `kind: paper` 条目 |
| `library_translate` | 长任务 | 提交 PDF 给 PDFMathTranslate，立刻返回 jobId |
| `library_job` | 长任务 | 查任务进度 / 产物 |

## 路由

宿主注册的全部 HTTP 路由（前缀 `/api/ai-library`）：

| 路由 | 方法 | 作用 |
|---|---|---|
| `/api/ai-library` | GET | 全量条目 + 大类 + 分组表 |
| `/file` | GET | 取 `items/` 下的文件（`?name=`） |
| `/vendor` | GET | 内置 pdf.js / three.js |
| `/log` | POST | 渲染进程错误上报 |
| `/item` | POST/PATCH/DELETE | 条目增改删 |
| `/bucket` | POST/PATCH/DELETE | 大类增改删 |
| `/install` | POST | 一键安装插件（`dsh plugin add`） |
| `/update` | POST | 自更新：本地 git 目录 `pull`，npm 安装则重装最新版 |
| `/repo` | GET | GitHub 仓库元信息 |
| `/compat` | GET | 包与当前 DSH 的兼容性 |
| `/og` | GET | GitHub 社交预览图（代理） |
| `/avatar` | GET | GitHub 头像（代理） |
| `/archive` | GET | 压缩包内容列表 |
| `/paper` | GET | 论文检索（十源，内置） |
| `/keys` | GET/POST | 论文平台 key 配置 |
| `/translate` | GET/POST | PDFMathTranslate 代理 |
| `/market` | POST | 同步插件市场 |
| `/motion` | GET | 外部提示词库资源 |

## 可选环境

插件**开箱即用**，下面这些都是可选的增强，**没有也能正常跑**。

| 能力 | 依赖 | 装法 | 什么时候才需要 |
|---|---|---|---|
| **论文翻译（保留排版）** | Docker + [PDFMathTranslate](https://github.com/PDFMathTranslate/PDFMathTranslate) | 见下 | 要读英文论文、需要**双语对照的 PDF** 时 |
| Office → PDF 预览 | 本机 LibreOffice | 正常安装即可 | 要预览 pptx / docx / xlsx 时 |
| 插件市场同步 | 外网 | 默认关闭，`config.json` 里开 `marketEnabled` | 想同步市场目录时 |
| 外部提示词挂载 | 本地目录 | 配 `motionDir` | 你有别的提示词库想只读挂进来时 |

### 论文翻译（可选）

**翻译成 PDF 是本插件最有价值的能力之一**：它不是把文字抽出来翻，而是**保留原文档排版**，生成中文/双语 PDF，公式、图表、目录位置都不动。

但它依赖 Docker，体积不小（镜像几 GB），所以**不是必装项**：

```bash
# 1. 装 Docker Desktop 并确保正在运行
# 2. 拉 PDFMathTranslate
git clone https://github.com/PDFMathTranslate/PDFMathTranslate
cd PDFMathTranslate
# 3. 起服务（默认监听 11008）
docker compose up -d
```

起好之后，在面板里打开任意 PDF，右上角「译中文」按钮就会工作。

> 没装也能用：按钮会提示「翻译服务不可用」，其余功能完全不受影响。
>
> 服务地址可改：`config.json` 的 `translateUrl`，或环境变量 `PDFMATHTRANSLATE_URL`。

**译文缓存**在 `<root>/.cache/translate/`，同一篇论文不会重复翻译。

---

## 给插件作者

资料馆是「收纳 + 检索」的底座：**任何插件只要能往 `POST /api/ai-library/item` 写一条数据，就自动获得分类树、卡片、预览、全文搜索和 AI 工具检索。**

字段契约、预览变体、工具注册写法、约定 —— 见 [INTEGRATION.md](INTEGRATION.md)。产品定位见 [PRODUCT.md](PRODUCT.md)。

## 开发自检

改完代码、重启之前，先跑一遍预检（模拟 DSH 启动流程，逐项断言）：

```bash
node scripts/preflight.mjs
# 或者
npm run preflight
```

它会检查：

1. 关键文件是否齐全
2. `package.json` 合法、`name` 正确
3. **`cordis.patch.yml` 的 insert id 是否等于包名**（不一致会导致面板静默消失）
4. profile 的 `package.json` 合法
5. 宿主插件 import + apply（路由数、工具数、工具契约）
6. 客户端 bundle **被求值两次不炸**、只注册一次、注册 id 正确、能注册主面板

任何一项 ❌ 就别重启——省得触发 DSH 的「自动修复」把 profile 配置抹掉。

## 已知问题 / 踩过的坑

**1. 桌面版插件不能用 `import()` 加载相对路径**

渲染进程的源是 `dsh-app://`，`import('/api/...')` 会失败（`Failed to fetch dynamically imported module`）；但 `fetch()` 能用。所以加载 pdf.js 走的是 `fetch → Blob → import(blobUrl)`。

**2. pdf.js 只能用 4.x**

pdf.js 6 依赖 `Uint8Array.prototype.toHex`、`Map.prototype.getOrInsertComputed`（ES2025），Node 24 与常见 Electron 都没有 → 编译期就废。本插件锁定 4.10.38。

**3. 客户端插件必须自己声明 `module` / `exports`**

`window.__ModuleLoader__.load({ factory })` 里 **loader 不注入**这两个变量，必须自己写：

```js
var module = { exports: {} };
var exports = module.exports;
Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });
```

漏了会在模块求值阶段抛 `ReferenceError`，**整个界面起不来**。

**4. `ctx.config` 要声明 `inject: ['config']` 才能读**

未声明时访问会抛 `cannot get property "config" without inject`。

**5. Office 预览依赖本机 LibreOffice**

首次转 PDF 约 2 秒，之后命中缓存几十毫秒。没装 LibreOffice 时该功能静默降级为下载。

**6. 内嵌网页可能被对方拒绝**

带 `X-Frame-Options` / CSP 的站点（GitHub、知乎、DOI 等）在 iframe 里会空白，点击 `↗` 用新窗口打开。

---

## 开发

```
lib/
├─ index.js     宿主：8 条路由 + 数据合并 + 文件服务
├─ client.js    客户端：面板 UI + pdf.js 查看器 + 编辑器
└─ config.js    配置解析（路径全部从这里出）
vendor/         pdf.js 4.10.38 + 标准字体 + cmaps
```

改动生效方式：

| 改了什么 | 怎么生效 |
|---|---|
| `library.js` / `user-items.json` | 面板「刷新」 |
| `lib/client.js` / 样式 | 刷新页面 |
| `lib/index.js` / 新增路由 | **重启 DSH** |
| `config.json` | 重启 DSH |

本地自检（不用开 DSH）：

```bash
node .boot-check.mjs          # 客户端模块 boot + 面板渲染
```

---

## 许可

MIT（见 [LICENSE](LICENSE)）。

`vendor/` 下的 pdf.js 是 **Apache-2.0**，字体另有许可，详见 [NOTICE.md](NOTICE.md)。
