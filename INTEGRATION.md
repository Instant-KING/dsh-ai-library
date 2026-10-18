# 写入口规范 · 让你的插件往资料馆写数据

> 资料馆本身**不产内容**，它是「收纳 + 检索」的底座。
> 任何插件 / Skill / 脚本，只要能往 `POST /api/ai-library/item` 写一条数据，
> 就自动获得：左侧分类树、卡片网格、右侧预览（含 pdf.js 阅读器）、全文搜索、AI 工具检索。

本文是给**插件作者**的接口契约。改这些字段前请先开 issue —— 它们对外承诺稳定。

---

## 一、最简单的用法

```js
await fetch('/api/ai-library/item', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    id: 'my-plugin-hello',          // 唯一，重复 POST 视为覆盖
    title: 'Hello 资料馆',
    kind: 'doc',
    summary: '一条最小可用的条目',
    group: '我的插件',
  }),
})
```

写入位置：`<数据根>/user-items.json`（**永远不改你的 `library.js`**）。

响应：

```json
{ "ok": true, "created": true, "item": { … } }
```

---

## 二、字段契约

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `id` | string | ✅ | 唯一标识。重复 POST 会覆盖同 id 的条目 |
| `title` | string | ✅ | 卡片标题 |
| `kind` | string | — | 类型，见下表。默认 `note` |
| `summary` | string | — | 摘要（卡片上显示，建议 ≤140 字） |
| `group` | string | — | 子分类，左栏第三级。不填归「未分类」 |
| `bucket` | string | — | 强制归到某个大类（一般不用，靠 kind 推断） |
| `origin` | `artifact` \| `web` \| `paper` \| `manual` | — | 来源。`artifact` 会进「本地对话产物」 |
| `format` | string | — | 文件格式（`pdf` / `png` / `pptx`…），进「按文件格式」视图 |
| `project` | string | — | 项目名，进「本地对话产物 › 按对话」 |
| `tags` | string[] | — | 标签，参与搜索 |
| `notes` | string[] | — | 备注行（条目详情里显示） |
| `link` | string | — | 外链。**GitHub 链接会自动显示仓库预览图 + star + 兼容性** |
| `install` | string | — | 安装命令。含 `add <包名>` 时卡片会出现「⤓ 一键安装」 |
| `files` | string[] | — | 相对 `items/` 的路径 |
| `preview` | object | — | 见下「预览变体」 |
| `version` / `fit` | string | — | 版本 / 适配的 DSH 版本 |

### kind 取值

```
paper  论文      plugin 插件      market 市场条目   repo GitHub 项目
prompt 提示词    doc    文档      website 网站      solution 题解
sim    仿真      courseware 课件  report 报告       note 笔记
```

未知 kind 会以原样显示，不会报错。

### 预览变体

```json
"preview": {
  "variants": [
    { "label": "原文", "src": "papers/abc.pdf" },
    { "label": "中文", "src": "papers/abc.zh.pdf" },
    { "label": "笔记", "src": "notes/abc.md" }
  ]
}
```

`src` 三种写法：

1. **相对路径**（推荐）：相对 `items/`，例如 `papers/abc.pdf`
2. **绝对 http(s) URL**：右侧会用 iframe 打开
3. **本插件提供的路由**：例如 `/api/my-plugin/asset?f=…`

按扩展名自动选渲染器：

| 扩展名 | 渲染 |
|---|---|
| `.pdf` | 内置 pdf.js（带页码、缩放、翻译按钮） |
| `.md` / `.markdown` | Markdown 渲染 |
| `.png/.jpg/.webp/.gif` | 图片 |
| `.pptx/.docx/.xlsx` | 本机 LibreOffice 转 PDF |
| `.mp4/.webm` | 视频（点击才加载） |
| 其他 | 直接下载 |

---

## 三、其他路由

| 路由 | 方法 | 作用 |
|---|---|---|
| `/api/ai-library` | GET | 全部条目 + 大类 + 分组表 |
| `/api/ai-library/item` | POST / PATCH / DELETE | 增 / 改 / 删 |
| `/api/ai-library/bucket` | POST / PATCH / DELETE | 大类增 / 改名 / 删 |
| `/api/ai-library/file` | GET | 取 `items/` 下的文件（`?name=`） |
| `/api/ai-library/repo` | GET | GitHub 仓库元信息（`?repo=owner/name`） |
| `/api/ai-library/og` | GET | GitHub 预览图（代理） |
| `/api/ai-library/avatar` | GET | GitHub 头像（代理） |
| `/api/ai-library/compat` | GET | 包与当前 DSH 的兼容性（`?name=`） |
| `/api/ai-library/paper` | GET | 论文检索（`?q=&source=&limit=`） |
| `/api/ai-library/keys` | GET / POST | 多平台 key 配置 |
| `/api/ai-library/translate` | GET / POST | PDFMathTranslate 代理 |

`PATCH` 的写法是 `{ id, patch: { … } }`，只改传入的字段。

---

## 四、给 AI 用的工具（宿主侧注册）

如果你的插件也想被 AI 直接调用：

```js
export const inject = ['webServer', 'tools']

export function apply(ctx) {
  ctx.tools.register({
    name: 'my_tool',
    description: '……',
    parameters: { type: 'object', properties: { q: { type: 'string' } } },
    output: {
      schema: { type: 'object', additionalProperties: true },
      // ⚠️ render 是必需的，而且它的返回值才是模型看到的内容
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args) {
      return { ok: true }      // 必须是「无损 JSON」：不能有 undefined / NaN / 函数
    },
  })
}
```

三条硬规则（都是踩过坑总结的）：

1. `apply` **必须同步**（返回 Promise 会让宿主启动失败）
2. `output.render` **必需**，缺了 register 直接抛 TypeError
3. `execute` 返回值必须能无损 JSON 往返

---

## 五、约定

1. **只写 `user-items.json`**，不要改别人的 `library.js`
2. **文件放 `items/` 下**，用相对路径引用；放外面面板打不开
3. **id 加前缀**（如 `myplugin-xxx`），避免和别人撞
4. **大文件先落盘再建条目**，别把 base64 塞进 JSON
5. **失败了要能重试**：POST 覆盖语义保证重试幂等

---


---

---

## 七、渲染器规范

预览区按 **`viewer` 字段 → 扩展名** 的顺序决定用哪个渲染器。
写条目时**建议显式给 `viewer`**，别让扩展名去猜（猜错过：`.jsx` 被当成文档、白底白字看不见）。

| `viewer` | 用于 | 说明 |
|---|---|---|
| `code` | 源码文件 | fetch 文本 → `<pre>` 深色底、等宽、可滚动 |
| `markdown` | `.md` | 渲染成排版好的文档 |
| `pdf` | `.pdf` | 内置 pdf.js（页码/缩放/翻译） |
| `image` | 图片 | 自适应缩放 |
| `video` | 视频 | 点击才加载，不自动下载 |
| `iframe` | 网页 / 其他 | 直接内嵌；对方禁嵌会空白 |
| `office` | docx/pptx/xlsx | 本机 LibreOffice 转 PDF |

示例：

```json
{
  "id": "rb-components-spotlightcard",
  "title": "SpotlightCard · 组件",
  "viewer": "code",
  "preview": { "variants": [
    { "label": "预览图", "src": "repos/x/public/preview.webp" },
    { "label": "源码",   "src": "repos/x/src/SpotlightCard.jsx" }
  ]}
}
```

**注意**：`viewer` 是**整个条目**的默认渲染器；如果不同变体需要不同渲染器（比如图像 + 源码），
不要设 `viewer`，靠扩展名自动判定即可（扩展名规则见上表）。

## 六、一个完整例子

把「某个目录下的 Markdown」变成资料馆条目：

```js
import { readdir, readFile } from 'node:fs/promises'

async function publish(dir) {
  for (const name of await readdir(dir)) {
    if (!name.endsWith('.md')) continue
    const text = await readFile(`${dir}/${name}`, 'utf8')
    const title = (text.match(/^#\s+(.+)$/m) || [])[1] || name.replace(/\.md$/, '')
    await fetch('http://127.0.0.1:<端口>/api/ai-library/item', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        id: 'mydocs-' + name.replace(/[^\w.-]+/g, '-'),
        title,
        kind: 'doc',
        summary: text.replace(/^#.*$/gm, '').trim().slice(0, 140),
        group: '我的文档',
        origin: 'artifact',
        format: 'md',
        files: ['mydocs/' + name],
        preview: { variants: [{ label: '正文', src: 'mydocs/' + name }] },
      }),
    })
  }
}
```

记得先把文件复制到 `<数据根>/items/mydocs/` 下。