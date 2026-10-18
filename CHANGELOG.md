# 更新日志

## 0.3.5 — 2026-10-18

### 新增

- **右侧默认页**：没选中任何条目时不再显示「选一张卡片」占位，而是一个入口页
  - 「论文检索 →」直达检索弹层
  - 统计卡：总条目 / 论文类 / 插件市场
  - 「论文资料 · 最近」列表（kind 为 paper / solution / sim 的最近 6 条，点开即看）

## 0.3.4 — 2026-10-18

### 第三轮审计

- **市场自动同步的 effect 依赖补全**：`[items.length]` → `[state.phase, items.length]`。之前空库在 phase 变 ready 时 items.length 仍是 0，依赖没变导致 effect 不重跑，新装用户依然不会自动同步。
- **`/keys`、`/log` 补 Origin 校验**：两个会写盘的接口也不再接受外部网页来源。
- **`~` 展开覆盖所有路径字段**：`libraryFile`、`itemsDir`、`cacheDir`、`motionDir`、`workspaceDir`、`watchDirs` 等，不再只有 `root`。
- **`library.js` 读取错误可见**：`/api/ai-library` 的 `env` 带上 `libraryError` / `configError`，面板顶部直接提示，不再只存进 `globalThis`。

## 0.3.3 — 2026-10-18

### 修复（第二轮审计）

- **空数据根不再 500**：首次运行自动创建 `root/` + `items/` + `library.js`（README 那句「自动建空库」现在是真的）
- `library.js` 损坏时退回空库并记录原因，不再让整个面板报错
- **市场自动同步条件修正**：`if (!items.length) return` → `state.phase === "ready"`（新装空库现在会触发）
- **`/archive` 改用 `safeTarget()`**：与 `/file` 同一套路径校验，堵住 `items-secret` 这类同前缀目录穿透
- **写操作与危险路由加 Origin 校验**：`/update`、`/install`、`/item`、`/bucket`、`/translate`、`/market` 拒绝外部网页来源（403）
- **配置层**：`root` 支持 `~` 展开；`config.json` 去 BOM 且解析失败不再静默；`watchDirs` 重复定义合并
- 清理：`paperServerDir` 死代码、`paper_bridge.py` 旧注释、`shell: true`、写死的 `--profile desktop`（改读 `DSH_PROFILE`）
- `apply()` 失败时输出到 `console.error` 并尝试 `ctx.logger`，不再只写 trace 文件
- preflight 新增 6b：空数据根冒烟（200 / 自动建库 / Origin 403），脚本 `scripts/smoke-empty-root.mjs`

## 0.3.2 — 2026-10-18

### 新增

- 面板工具栏「更新」按钮 + `POST /api/ai-library/update`
  - 本地目录安装（有 `.git`）→ `git pull --ff-only`，返回前后 commit 与是否变化
  - npm 安装 → 重装 `dsh-ai-library` 取最新版
  - 有更新时提示重启 DSH 生效
- `deriveDshCli()`：不再写死某台机器的 CLI 路径（环境变量 → 安装目录推断 → PATH）

## 0.3.1 — 2026-10-18

### 本次修复（两个真问题）

- **插件市场不再需要手动同步**
  - 宿主启动后 6 秒自动检查缓存，过期就后台拉一次（失败静默）
  - 面板首次打开若市场为空，自动触发一次同步并提示进度，用户不用点「同步市场」

- **论文检索不再依赖外部项目**（代码已迁移进插件）
  - 新增 `lib/paper.js`：纯 Node 实现十个免 key 源（arXiv / OpenAlex / Crossref / DOAJ / OpenAIRE / INSPIRE / Europe PMC / Zenodo / HAL / DataCite）+ 三个需 key 源（IEEE / ScienceDirect / Springer）
  - `/api/ai-library/paper` 路由与 `library_paper_search` 工具都改用它，**删除了 Python 依赖与 `paperServerDir` 配置**
  - auto 模式 5 源并发 + 去重，实测 1.5 秒返回 10 条；命中缓存 2 毫秒
  - 删除 `scripts/paper_bridge.py`（不再被引用）

## 0.3.0 — 2026-10-18

**预览器从 4 种扩到 11 种，资料馆从「只读面板」变成「可写入的底座」。**

### 新增预览器

- **代码查看器**：`.jsx .tsx .js .ts .css .scss .vue .svelte .py` 等，自写迷你语法高亮（注释 / 字符串 / 关键字 / 标签 / 数字 / 函数名），零依赖，右上角一键复制
- **3D 模型**：`.glb .gltf`，three.js 离线内置（`vendor/three`），自动居中、拖拽旋转、滚轮缩放
- **表格**：`.csv .tsv`，首行表头、粘性表头、支持引号转义、最多 300 行
- **JSON 树**：`.json`，可折叠，显示对象/数组条数
- **字体预览**：`.ttf .otf .woff .woff2`，字号滑杆 + 可编辑样例文字
- **压缩包目录**：`.zip .tar .gz .7z`，`tar -tf` 列内部文件（Windows 自带 bsdtar，能读 zip）
- **音频**：`.mp3 .wav .flac .m4a .ogg .aac`
- **多图画廊**：条目有多张图片变体时显示缩略条，点击切换

### 新增功能

- **论文多平台检索**：面板内弹层，11 个免 key 平台（arXiv / OpenAlex / Crossref / DOAJ / OpenAIRE / INSPIRE / Europe PMC / Zenodo / HAL / DataCite）+ 3 个需要 key 的平台，检索结果可一键「加入资源库」
- **多平台 key 配置**：弹层里直接填 IEEE / Elsevier / Springer 的 key，写入 `config.json`，检索时立即生效（不用重启）
- **检索缓存**：同一关键词 10 分钟内直接返回（DOAJ 冷启动 1.1 s → 命中缓存 3 ms）
- **从仓库建库**：新工具 `library_repo_build`，clone GitHub 仓库或扫本地目录，README + docs 自动建条目
- **写入口规范**：`INTEGRATION.md` 对外契约（字段表、路由表、渲染器规范、工具注册三条硬规则）
- **生态参考**：`ECOSYSTEM.md` 记录提示词库等参考项目

### 面板

- **卡片重设计**：GitHub 头像 + 标题 + 作者 + 分类徽标 + ★/⑂/⊙ + 日期
- **GitHub 仓库卡**：右侧预览区显示仓库社交预览图（宿主代理，绕 CSP）、star、语言、兼容性徽标、一键安装（按钮直接写出包名）
- **兼容性检查**：`/compat` 路由读本地已装版本或 npm registry，逐条 peer 比对，返回 `ok / warn / unknown`
- **大分类排序**：插件市场第一、本地对话产物第二，其余按 order

### 修复

- GitHub 仓库卡插错分支（落在空状态里，从未渲染）
- 渲染链把 `videoOn` 当持久开关，导致「源码」变体显示成视频播放器
- 代码查看器白底白字（改显式深色底）
- `tar -tvf` 把日期混进文件名（改 `tar -tf`）
- 压缩包路径校验在 Windows 下失效（反斜杠 vs 正斜杠）
- 全文搜索命中阈值太低，代码类条目搜不到

### 开发工具

- `scripts/preflight.mjs`：重启前自检（模拟 DSH 启动，六组断言，包括「客户端 bundle 求值两次不炸」和「insert id === 包名」）
- 因改名踩坑修复：幂等标记从全局布尔改成**按模块 id 记账**，否则改包名后新 id 会被永久跳过（面板静默消失）

### 兼容性

- DSH Desktop 0.2.1-rc.1 / Electron 44.7 / Node 24
- 依赖：无运行时依赖（pdf.js、three.js 均已 vendor）
- 可选：LibreOffice（Office 转 PDF）、PDFMathTranslate Docker（PDF 翻译）、上游 `paper_import.py`（论文检索）

---

## 0.2.0 — 2026-10-17

- 面板可用：分类树、卡片网格、右侧预览（pdf.js）
- 自动入库 / 批量导入 / PDF 翻译
- 13 个宿主工具
