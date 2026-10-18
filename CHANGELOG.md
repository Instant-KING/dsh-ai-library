# 更新日志

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
