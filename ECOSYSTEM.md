# 生态与参考项目

> 写前端时不用从零想提示词——去这些库里扒一条，改改就能用。
> 本页分两类：**已接入**（本机挂载/可检索）和 **外部参考**（GitHub 上的同类项目）。

---

## 已接入

### MotionSites · 动效 UI 提示词库

- 仓库：<https://github.com/zhaosenlin12-creator/MotionSites>
- 规模：**317 条**动效驱动 UI 提示词 + 317 份完整 prompt 正文 + 193 张预览图 + 124 段循环视频
- 特点：离线优先、免登录、无第三方追踪、加载时不依赖外部 CDN
- 分类：Landing Page / Hero Section / SaaS / Agency / Dashboard / Travel / Features / CTA / 动效…
- 在本机的位置：`<motionDir>`（`config.json` 的 `motionDir` 指向它）
- 在资料馆里的样子：

```
📁 本地文件 › 提示词
   ├ Hero Section   73
   ├ Landing Page   49
   ├ SaaS           28
   …
```

每条卡片右侧能直接看提示词正文，全文搜索也能搜到（`library_search(mode="fulltext")`）。

**用它做什么**：要做一个落地页/英雄区/仪表盘时，先搜「dashboard」「hero」「pricing」，
把对应提示词拉出来当起点，比凭空写强得多。

---

## 外部参考

以下都是 GitHub 上的同类项目，按「拿来干什么」分类。
（星数、活跃度会变，用之前点进去看一眼现状。）

### 网站/UI 提示词合集

| 项目 | 是什么 | 拿来干什么 |
|---|---|---|
| [motionsites.ai](https://motionsites.ai/) | MotionSites 的商业版官方站 | 看付费提示词长什么样，找灵感（本库已收录免费的那批） |
| [bolt-new topic](https://github.com/topics/bolt-new) | 主题页，聚合了多个「AI web design prompts」仓库（有 470 条提示词的项目） | 想批量找落地页提示词时先扫这里 |
| [convertscout/awesome-ai-prompts](https://github.com/convertscout/awesome-ai-prompts) | 500+ Cursor rules / AI 编码提示词，覆盖 React、Next.js、Python、Django | 写代码时的 `.cursorrules` 和编码提示词 |

### 系统提示词拆解（学"它们是怎么写的"）

| 项目 | 是什么 | 拿来干什么 |
|---|---|---|
| [dontriskit/awesome-ai-system-prompts](https://github.com/dontriskit/awesome-ai-system-prompts) | 收集 v0 / Lovable / Claude Code / Windsurf / Manus 等产品的系统提示词 | 想知道 v0 怎么把一句话变成页面，就看它；改一改能变成自己的生成器提示词 |

### 通用提示工程

| 项目 | 是什么 |
|---|---|
| [promptslab/Awesome-Prompt-Engineering](https://github.com/promptslab/awesome-prompt-engineering) | 提示工程资料大全（论文、工具、模式） |
| [prompts-template topic](https://github.com/topics/prompts-template) | 主题页，聚合「给 AI 一个 prompt/skill 就能生成漂亮网页」的项目 |
| [wenhaomin/ChatGPT-PromptGenius](https://github.com/wenhaomin/ChatGPT-PromptGenius) | 按场景分层分类的中文提示词大全 |

---

## 怎么往这里加

1. 找到值得收藏的仓库 → 把链接发给我，或自己往资料馆里加一条（`kind: repo`，`group: 前端提示词`）
2. 想直接变成可检索的资料：用 `library_repo_build`（clone 下来，README + docs 全部建条目）
3. 提示词类仓库想全量入库：把它的 prompt 目录挂到 `motionDir`，或先拉到 `items/` 再 `library_import`

> 约定：**外部项目只记链接和用途，不复刻内容**（版权 + 体积都扛不住）。
