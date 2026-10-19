# 更新日志

## 未发布

### 修复

- **客户端 bundle 二次求值会把整个面板带崩（`Identifier '__AILIB_ID' has already been declared`）**
  `lib/client.js` 是经典脚本，顶层 `const __AILIB_ID` 落在全局词法环境里。页面里再求值一次
  同一个 bundle（插件更新、HMR、加载失败重试都会走到）就抛 SyntaxError —— 而且第 33 行的
  「防重复注册」守卫在 `const` 之后，根本轮不到执行。
  现在整个 bundle 包进 IIFE，`__AILIB_ID` 变成函数作用域，二次求值安全。
- **preflight 的「求值两次不炸」永远测不出上面这个问题**
  原来用 `new Function(src)` 跑两遍，每次都开独立函数作用域，`const` 不会冲突。
  改用 `vm.runInThisContext(src)`，与浏览器里「两个 `<script>` 共享同一全局词法环境」一致；
  已验证旧代码在新测试下必定失败（❌ `Identifier '__AILIB_ID' has already been declared`）。
- **preflight 第 8 节不认「正规安装」**
  原先只检查 profile 补丁里的 insert 行；改用 `dsh plugin add` 装成组合包后 `rows[0]` 为空，
  `resolve(undefined)` 直接抛错。现在先看 profile 依赖 + `dsh.profile.bundles`，
  没有再回退到 insert 行检查。

### 新增

- **接入 DeepSeek 官方联网工具两个接口：`/v1/tools/search` 与 `/v1/tools/fetch`**
  新增 `lib/dsweb.js`（客户端 + 磁盘缓存 + markdown 反转义）。key 按
  `config.json 的 webKeys.deepseek` → `环境变量 DEEPSEEK_API_KEY` → `~/.dsh/.credentials.yaml` 顺序解析，
  桌面版登录后无需额外配置。

  - `library_web_search` 新增 `provider`：`auto`（默认，有 key 走 DeepSeek）/ `deepseek` / `anysearch`。
    DeepSeek 结果带 `authority`（权威度）、`date`（发布日期）、`rerank_score`，比匿名检索更能挑出可靠页面。
    DeepSeek 失败时 `auto` 会退回 AnySearch，不让检索整体不可用。
  - `library_save_url` 新增 `via`：`auto` / `deepseek` / `builtin` / `external`，以及 `refresh`（绕过缓存）。
    官方 Fetch 拿到的正文落 `<cacheDir>/web/<sha1>.json`，**默认 24 小时**；同 URL 二次入库不再发请求
    （实测 156ms → 21ms）。`via=deepseek` 遇到抓不了的站点会明确报错并给替代方案，
    `via=auto` 则自动降级到内置抓取。
  - 新增工具 `library_web_cache`（`stats` / `clear`）：看缓存页数与占用、清空缓存。

- **`library_save_url` 支持接收外部已抽取的正文（`markdown` 参数），与 DSH `read_page` / `web_fetch` 联动**
  内置抓取是裸 HTTP（`fetch()` + 正则剥标签），有两个短板：① 不执行 JS，SPA / 框架文档站只能拿到骨架；
  ② 只删得掉 `<script>…</script>` 块，写在属性或模板里的 JS 会漏进正文 ——
  实测抓 Docker 文档，快照里出现了 `document.firstElementChild.className = e.matches ? 'dark' : 'light';`
  这类片段。
  现在传 `markdown` 就**跳过自带抓取**，直接存外部抽取结果（DSH `read_page` 走 Firecrawl，跑 JS、
  输出干净 markdown、代码块完整）。同时新增 `title` / `summary` 覆盖参数。
  不传 `markdown`、不指定 `via` 时，行为与旧版最终一致（走到 builtin）。

### 修复

- **内置抓取遇到对方断连会直接抛异常，把整个工具调用带崩**
  `fetch()` 在对方 ECONNRESET / TLS 失败 / DNS 失败时是**抛异常**而不是返回非 2xx，
  而兜底分支没 try/catch。实测抓 docs.docker.com 落 builtin 时抛 `TypeError: fetch failed`
  （`ECONNRESET`）。现在统一转成 `{ ok:false, message, hint }` 的可读结果。

- **搜索结果标题里带 HTML 标签**
  部分结果指向裸 `.md` / `.rst` 文件，`title` 是页面里的一行 `<h2 id="f96eee…">`，
  直接显示就是一堆标签。现在统一剥标签、解实体、折叠空白；仍为空时退化成「域名/文件名」。

### 文档

- README 新增「联网：DeepSeek 官方 Search / Fetch + DSH 工具」一节：配 key 的三种来源、
  存网页的三条路（`markdown` / `via=deepseek` / 内置）、缓存策略与实测耗时、
  两个已知坑（正文是转义过的 markdown；部分站点抓不了）、检索侧的选型对照。
- README 工具表更新到 16 个（新增 `library_web_cache`），修正联网说明。
- `config.example.json` 增加 `webKeys.deepseek` 与说明。
- 系统提示词同步：明确「三条路按质量排序」，让 AI 知道有 `via=deepseek` 这条路，而不只依赖 `read_page`。
- CHANGELOG 修正早先「不传 markdown 时行为与旧版完全一致」的表述（现在默认会先试 DeepSeek Fetch）。

## 0.3.47 — 2026-10-20

### 修复：/open 打不开（按钮点了没反应）

根因：`/open` 只接受 `name`（相对 `items/` 的路径），用 `safeTarget(name)` 解析；
面板与鲸鱼按钮传的是**绝对路径** `path`，被解析成 `items/C:/Users/...` → 一律 404「找不到该文件」，
连「用系统程序打开」也一样打不开。

- `/open` 现在优先认 `path`（绝对路径，文件和目录都行），不存在才退回 `name` 的相对解析；
  路径不存在时返回 404 并带上解析后的绝对路径方便排查。
- 客户端 `openWithSystem()` 认绝对路径（`C:\…` / `/…` → 走 `path`，否则走 `name`）。
- `openLocalFile()`（Office「用系统程序打开」）把 `items/xxx` 拼上 `env.root` 变成绝对路径再请求。

### 实测（进程内直接调 handler）

- 目录 `C:/Users/instant/.dsh/whale-roles` → HTTP 200 `{ok:true, path}`
- 文件 `E:/ai-plugins/ai-library/README.md` → HTTP 200
- 不存在路径 → HTTP 404 `找不到该路径：C:\nope\nope`
- `spawn explorer.exe <dir>` 独立测试无报错（explorer 本来就 exit 1，不算失败）

## 0.3.46 — 2026-10-20

### 新增：插件拓展里的两个资源支持「一键替换 / 打开」

- **人设**：卡片新增 ⚡ 按钮 → `POST /api/dsh-persona-dafeiyu/mutate {action:"set-current", id}`，
  直接切到该人设（接口返回 `{ok,value}`，已实测 200）；条目新增 `persona.{id,builtin,current}` 字段。
- **鲸鱼图集**：该插件没有切换接口，改为 📂「打开目录」→ `POST /api/ai-library/open`，
  把图片丢进 `~/.dsh/whale-roles` / `whale-bubble-imgs` 就能被挂件用到；条目新增 `dir` 字段。
- `/open` 路由支持目录（原来只认文件，`isFile()` 判断去掉），Windows 交给资源管理器。
- `EDITABLE_FIELDS` 白名单补 `persona` / `dir`。

### 实测

- 同步：personas updated 4（persona 字段：大肥鱼 current=true，阿茶/听澜 builtin，拉弥亚 用户导入）· whale updated 1（dir 有值）
- 人设接口：`POST /api/dsh-persona-dafeiyu/mutate` → HTTP 200 `{ok:true, value:…}`

## 0.3.45 — 2026-10-20

### 修正：表情包图集是「并进去」，不是新建一张卡片

- 「插件拓展」里直接挂 `dsh-meme` 的**图集目录**（`插件拓展 → 表情包 · dsh-meme → 鲸鱼娘表情包 91 / 大肥鱼 24`），
  点进去还是原来的图片墙（启用这个图集 / 删除 / 导入图集），不再生成 `kind=meme-pack` 的单张卡片。
- 选中键沿用 `meme:<packId>`；`MemePanel` 的渲染条件加了「插件拓展里选中 meme: 开头的分组」。
- `LIB_CTL.openPack()` 现在跳到插件拓展里的对应图集。
- 停止同步 meme-pack 条目并清掉已有 2 条卡片；`插件拓展` 的计数把图集数量也算进去了。

### 人设（上一版已修，这里记录）

- 大肥鱼 / 阿茶 / 听澜 是插件源码里的内置人设，`extractBuiltinPersonas()` 解析后与用户导入的拉弥亚一起进库。

## 0.3.44 — 2026-10-20

### 修复 / 合并

- **内置人设补全**：`dsh-persona-dafeiyu` 的 大肥鱼 / 阿茶 / 听澜 是硬编码在宿主源码里的（`BUILTIN_PERSONAS` + `BUNDLED_*`），
  不在 `personas.json` 里，之前只同步到用户导入的「拉弥亚」。新增 `extractBuiltinPersonas()` 解析源码，现在 4 条人设都在库里，`大肥鱼` 带「当前启用」标签。
- **表情包图集并入插件拓展**：删掉左侧独立的「表情包图集」大类，图集作为 `插件拓展 → 表情包 · dsh-meme → 图集 → 具体图集`；
  卡片上新增 ⚡ 按钮（`POST /api/ai-library/meme?action=enable`）保留一键切换能力，条目新增 `meme.{id,enabled,count}` 字段。
- **角色包暂时下架**：`dsh-bigfish` 的 `bigfish-classic` 并不是「大肥鱼监工」（包内无素材，examples 里是别的角色，预览成了机器人），
  先停止登记并删掉该条目，等确认监工对应哪个插件再接。
- 封面策略收紧：只在包自带 `pet-maker/starter` 里找缩略图，不再拿 `examples/` 顶替。

### 实测

- 同步：personas created 3 / updated 1（大肥鱼·阿茶·听澜 + 拉弥亚）· memePacks created 2 · whalePack 1
- 渲染（展开后）：插件拓展 / 人设·dsh-persona-dafeiyu / 表情包·dsh-meme / 鲸鱼图集·dsh-whale-widget / 大肥鱼 / 阿茶 / 听澜 / 拉弥亚 / 鲸鱼娘表情包 全部 ✅

## 0.3.43 — 2026-10-20

### 重构：插件资源统一进「插件拓展」大类（三级）

- 左侧不再有「人设 / 图集档案 / 用量账本 / 角色包」四个平级大类，改成单个 **插件拓展**：
  `插件拓展 → 插件（人设·dsh-persona-dafeiyu / 角色包·dsh-bigfish / 鲸鱼图集·dsh-whale-widget…）→ 资源组 → 条目`
- `matchSelection` 支持键 `ext:<插件id>[::<资源组>][::<条目id>]`

### 删除

- 用量账本同步（`syncUsage`）连同 3 条旧条目与 `items/usage/` 一起删掉——记账小鲸鱼是 whale-widget，不是 cost-meter 账本
- 「图集档案」（`kind=meme-pack`）整块移除；表情包的一键切换仍在「表情包图集」

### 新增 / 修复

- `syncWhale()`：鲸鱼挂件图集 —— 内置 assets（角色图 / 气泡 gif / 音效）+ 用户导入目录 `~/.dsh/whale-roles`、`whale-bubble-imgs`、`whale-audio`，每条带封面
- 角色包封面：manifest 的 assets 在 npm 包里缺失，改为按 `starter/thumbnail.png` → `examples/*.png` 顺序找，**优先 8 KB 缩略图**（原来复制了 2.2 MB 示例图）

### 实测

- 清理：删 3 条（大肥鱼图集 / 2026-09 用量 / 2026-10 用量），条目 399 → 396
- 同步：personas updated 1 · pets updated 1 · whale created 1
- 预览：`pets/bigfish-classic-cover.png` 8 KB ✅ · `whale/whale-builtin-cover.png` 250 KB ✅ · `personas/*.md` ✅
- 渲染：展开后 插件拓展 / 人设·dsh-persona-dafeiyu / 角色包·dsh-bigfish / 鲸鱼图集·dsh-whale-widget / 拉弥亚 / bigfish-classic / 鲸鱼内置图集 全部出现

## 0.3.42 — 2026-10-20

### 新增：记账小鲸鱼 / 大肥鱼监工 同步

- `syncUsage()`：读 `~/.dsh/storages/cost-meter/ledger.json`（23 天账本，字段含 input/output/cacheRead/calls/costCny/byProviderModel），
  每月生成一条 `kind=usage` 条目 + `items/usage/<YYYY-MM>.md` 明细表；读不到 cost-meter 时退回 `~/.dsh/.dshw-usage.json`
- `syncCompanionPacks()`：读 `dsh-bigfish/packs/*/manifest.json`（内置角色包）与 `~/.dsh/pets/dsh-bigfish/*.dshpet`（用户自制），
  生成 `kind=pet` 条目（只登记，不复制素材）
- 左侧新增「用量账本」「角色包」两个视图；`KIND_LABEL` 补 `usage` / `pet`
- 同步与裁剪都并入 `syncPluginResources()`，路由与工具返回多 `usage` / `pets` 两块

### 实测

- 用量：2026-09 合计 ¥19.73 / 3.90 亿 tokens / 1422 次；2026-10 合计 ¥86.69 / 19.13 亿 tokens / 5228 次（md 明细已落盘）
- 角色包：`bigfish-classic` 0.5.2 · 6 场景 · 6 素材
- 渲染：用量账本 / 角色包 两个视图均可见

## 0.3.41 — 2026-10-20

### 改进：插件同步变成「自动跟随」

- 抽出 `syncPluginResources()`，启动首同步、`POST /plugins-sync`、**打开表情包图集列表**三处共用
  → 在 dsh-meme 的「发现」里装了新图集，下次面板拉图集列表就会自动登记进「图集档案」
- 新增 `pruneSyncedEntries()`：源插件里已卸载的图集 / 已删除的人设 → 标记 `archived` 并写备注（不删条目，保留历史）
- 安全护栏：图集列表为空 / 读不到插件目录时**绝不裁剪**（`authoritative` 要求目录存在且列表非空）

### 修复

- `listPacks()` 不传 `dshHome` 会抛 `path` undefined；工具与同步都补上（用 `DSH_HOME` 或 `~/.dsh`）
- **「未启用」被误标成「已归档」**：`status` 现在固定 `available`，启用状态只体现在 tags / notes 与 summary，
  `archived` 只表示「源插件里已经不存在」

### 实测

- 幽灵图集：`dryRun pruned.memePacks = 1`，真同步后标记 archived 并加备注
- 恢复：`大肥鱼` / `拉弥亚` 现在都是 `available`，重复同步 `created 0 / updated 1`（幂等）

## 0.3.40 — 2026-10-20

### 新增：插件资源同步（插件内容 → 资料馆条目）

- `lib/plugin-sync.js`：检测已装插件（读 profile package.json + node_modules），把人设与图集落成条目
  - `dsh-persona-dafeiyu` → `kind=persona`，正文写 `items/personas/<id>.md`，备注带 id / 状态 / 字数 / 创建时间
  - `dsh-meme` 图集 → `kind=meme-pack`，备注带图集 id / 位置 / 张数，提示可在「表情包图集」一键切换
- 新增路由 `GET/POST /api/ai-library/plugins-sync`（POST 支持 `?dryRun=1`）
- 新增工具 `library_plugin_sync`（工具数 17 → **18**），幂等：重复跑只更新
- 启动后 1.5s 静默同步一次（`autoSyncPlugins !== false` 时），失败只打日志不阻塞
- 左侧新增两个视图：**人设**、**图集档案**（`KIND_LABEL` 加 `persona` / `meme-pack`）

### 实测

- 路由：GET 识别 22 个已装插件；POST 同步 1 条人设 + 1 条图集记录；dryRun 不改库
- 条目：`persona-拉弥亚`（文件已落盘 `items/personas/custom-mvfi1dzw.md`）、`meme-pack-大肥鱼`（24 张）
- 渲染：折叠态可见「人设」「图集档案」，卡片显示拉弥亚 / 大肥鱼

## 0.3.39 — 2026-10-19

### 修复

- **网页卡片徽章不显示**：`sanitizeItem()` 的字段白名单漏了 `web`，收藏时写入的站点/日期/权威/相关度
  在落盘前就被裁掉了，卡片自然拿不到数据。白名单补 `web` 与 `url`。
- `library_web_collect` 命中**已有条目但缺 `web`** 时不再当作重复跳过，而是回填元数据（`enriched` 计数），
  已有老条目重跑一次同样的检索就能补上徽章数据。

### 实测

- 补写：查询 1 → 新建 0 / 补写 3；查询 2 → 新建 2 / 补写 1
- 落盘复查：6 条 website 全部带 `web`（站点 / 日期 / 权限 / 分数）
- 注意：宿主代码改动需**重启 DSH** 才会进 `/api/ai-library` 响应；客户端徽章需刷新页面

## 0.3.38 — 2026-10-19

### 左侧树优化

- 新增两个置顶视图：**收藏的网站**（`kind=website`，按域名分组）、**最近添加**（分「本地 / 外源」，各自按今天 / 近 3 天 / 近 7 天 / 更早分段）
- 排序：收藏的网站 → 最近添加 → 插件市场 → 本地对话产物 → 表情包图集 → 其余
- **左侧默认折叠**：进来只看到大类，点箭头才展开（折叠开关的默认语义一并修正）
- 每 5 分钟静默刷新一次（仅页面可见时），「最近添加」与时间分组保持新鲜；不会闪 loading

### 实测

- 折叠态：两个新大类可见、子分组隐藏
- 展开后：按域名 / GitHub / 知乎 / 外源 / 今天 / 更早 全部出现，无渲染错误

## 0.3.37 — 2026-10-19

### 改进

- **网页卡片视觉**：`kind=website` 的卡片多一行元信息 —— 站点名 / 发布日期 / 权威分（`权 3`，≥3 高亮）/
  相关度（`2.1`，≥1.5 高亮），数据来自 DeepSeek search 的 `site_name` / `date` / `authority` / `rerank_score`
- **URL 归一化去重**：`normalizeUrl()` 去 `#片段`、host 小写、去尾部斜杠、清 `utm_*`/`spm`/`ref`/`from` 等追踪参数；
  去重判断与条目 id 都用归一化后的 URL（展示仍用原始链接）

### 实测

- 归一化：`https://GitHub.com/a/b/?utm_source=x#readme` → `https://github.com/a/b`
- 去重：同一查询再收一次 → 新建 0 条、跳过 3 条
- 卡片渲染：站点名 / 日期 / `权 3` / `2.1` 全部出现在卡片上

## 0.3.36 — 2026-10-19

### 新增：DeepSeek 官方检索/抓取接入资料馆

- 新增 `lib/dsweb.js`：`/v1/tools/search` 与 `/v1/tools/fetch` 封装
  - `count`(1-50) / `need_content` / `ori_question` / `localization` 全部支持，搜索语法原样透传
  - 返回 `rerank_score` / `authority` / `date` / `site_name` / `summary` / `content`，派生出 `quality`(≥1.5) 与 `authoritative`(≥3)
  - fetch 的 markdown 会**反转义**（`\.`→`.`、`#`→`#`）；24h 磁盘缓存；`failed to fetch URL` 标记 `notFetchable` 供降级
  - key 解析链：`config.webKeys.deepseek` → `DEEPSEEK_API_KEY` → `~/.dsh/.credentials.yaml`
- `library_web_search` 加 `provider: auto|deepseek|anysearch`（auto 有 key 走 DeepSeek，失败自动退回 AnySearch）+ `count/needContent/oriQuestion`
- `library_save_url` 加 `via: auto|deepseek|builtin|external`（external > deepseek > builtin）
- **新增 `library_web_collect`**：搜索结果直接变成资料馆条目
  - `kind=website`，`web` 元数据带 site/date/score/authority/query/fetchedAt
  - `notes` 写站点、发布时间、相关度、权威分、检索词、抓取方式
  - `needBody=true` 时用 DeepSeek Fetch 抓正文，落 `items/snapshots/web-<hash>.md`
  - 按 URL 去重；支持 `minScore` / `minAuthority` 过滤与 `dryRun` 预览
- 新增 `library_web_cache`：查看/清理网页缓存
- 工具数 15 → **17**

### 实测

- search：`count=5` 真的返回 5 条（另一窗口测到「固定 10 条」是因为用了 `limit`，官方只认 `count`）
- fetch：21 685 字符，二次调用命中缓存（age=0s）
- collect：3 条网页入库，带正文快照，`library_search` 能检索到

## 0.3.35 — 2026-10-18

### 修复

- **「更新」按钮报「未找到 dsh CLI：命令为空」**：`deriveDshCli()` 只按 `process.execPath` 推安装目录，
  而桌面版的 execPath 不在安装根下，候选全落空。改为多来源解析（按可靠性排序）：
  1. `DSH_CLI` 环境变量
  2. `process.resourcesPath` + `runtime/cli/bin/dsh.cmd`（Electron 打包环境最稳）
  3. `process.argv` 里以 `runtime\bin` 结尾的项，反推 `../cli/bin/dsh.cmd`
  4. execPath 推安装目录（老路子保留）
  5. `%LOCALAPPDATA%\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd`
  6. `~/.local/bin/dsh.cmd` · 7. PATH 里的 `dsh`
- 找不到时不再抛「命令为空」，改为可操作提示（指向 `DSH_CLI`）
- `/update` 的 npm 分支改 `add dsh-ai-library@latest`（原来不带 @latest，`^0.3.x` 已满足时 pnpm 不会升级）
- `env.dshCli` 暴露解析结果，方便诊断
- 实测（模拟 Electron：`resourcesPath` + argv `runtime\bin`）：解析到真实 `dsh.cmd` 且文件存在

## 0.3.34 — 2026-10-18

### 变更：插件市场换数据源

- 新增 `lib/market-index.js`：解析 dshmarket / awesome-dsh-plugin 的 `index.json`（format 1）
- 市场源按顺序回退：`dshmarket.com` → `awesome-dsh-plugin.com` → 旧 `api.dshmk.com`
- 条目数量 **321 → 2953**（本次保留前 1200 条，默认上限从 300 提到 1200）
- 条目质量提升：带真实版本号、中文分类（开发与运行时 / UI 增强 / 记忆…）、正确的 `dsh plugin --profile desktop add <pkg>` 安装命令
- 缓存格式探测：`plugins[]`（新）与 `repositories[]`（旧）都认，坏数据自动换下一个源

## 0.3.33 — 2026-10-18

### 新增：对外开放服务 `ctx.aiLibrary`

- client 半 `ctx.provide("aiLibrary", service)`（照 dsh-better-sidebar 的 `ctx.betterSidebar` 模式）
- 方法：`openItem(id)` / `openBucket(bucketId, group?)` / `openPack(packId)` / `getEnv()`
- 面板未挂载时调用是空操作；老 Cordis 无 `provide` 自动跳过，面板不受影响
- 实测：provide 成功 / 未挂载调用不炸 / 无 provide 环境也不炸
- `ADAPTERS.md` 增加服务用法与 better-sidebar 对接计划

## 0.3.32 — 2026-10-18

### 新增：表情包图集管理（dsh-meme 联动）

- 新增 `lib/meme-packs.js`：读 `~/.dsh/meme-packs` + 插件内置 `memes/`，用 `node:sqlite` 读 `index.db` 的张数与封面
- 新路由 `/api/ai-library/meme`：list / images / image / enable / import / remove
- 左侧新增「表情包图集」大类（排在插件市场、本地对话产物之后）
- 主区 MemePanel：封面、张数、版本、图片网格；「启用这个图集」写 `enabledPacks`，表情包插件立即生效
- 导入：填解压目录路径（含 index.db）→ 复制进 `~/.dsh/meme-packs/<id>`；删除只允许用户包，路径校验防越界
- 实测：内置包 24 张 / images 正常 / 越界读取 404 / enable 写入设置 / remove 成功

## 0.3.31 — 2026-10-18

### 新增：插件联动适配器（预留开放接口）

- 新增 `lib/adapters.js`：适配器契约 v1（`detect()` + `capabilities`）
- 内置 5 个只读适配器：表情包 / 桌宠角色 / 主题皮肤 / 人设 / 小鲸鱼挂件；
  探测各自数据位置（`~/.dsh/...`），只读、不写入
- `GET /api/ai-library` 的 `env.adapters` 返回状态；面板默认页底部显示联动圆点
- 开放接口：`globalThis.__AILIB_ADAPTERS__.register/collect`，其它插件可注册自己的适配器
- 服务端相关能力统一标记 `pending: ['server']`，等共享服务落地再接
- 文档 `ADAPTERS.md`：契约、内置适配器、注册方式、设计约束

## 0.3.30 — 2026-10-18

### 修复

- **更新失败：dsh.cmd 不是内部或外部命令**：`cmd.exe` 只认 PATH，不会去 `~/.local/bin` 找。
  新增 `whichCommand()`：按 PATHEXT 在 PATH + `~/.local/bin` + `%APPDATA%\npm` 里搜真实路径，
  `deriveDshCli()` 和 `execCli()` 都先用它解析成绝对路径；解析不到给出可操作报错
  （提示设置 `DSH_CLI` 环境变量），不再是 cmd 的原始乱码。
- 去掉重复的「更新失败：更新失败：」前缀（后端与前端各加了一次）。

## 0.3.29 — 2026-10-18

### 修复

- 一键安装写入对话框失败时，**兜底复制的是真正能跑的命令**：`dsh plugin --profile desktop add <pkg>`
  （之前复制的是整段中文说明，粘到终端跑不了）
- 找不到聊天输入框的问题：候选范围扩大——`textarea`、`[contenteditable]`（含空值/plaintext-only）、
  `[role="textbox"]`，并递归进 shadow DOM；再加「当前聚焦元素」和带 composer/prompt 语义属性的兜底；
  选择策略从「面积最大」改为「高度 + 宽度 + 是否贴窗口底部」综合评分（聊天框贴底、搜索框靠上）。
- `sendToComposer()` 不再有写剪贴板的副作用，剪贴板只由调用方写一次。

## 0.3.28 — 2026-10-18

### 变更

- **「一键安装」不再由面板直接执行 `dsh plugin add`**：改成把一段安装指令写进 DSH 的聊天输入框并聚焦，
  由 AI 先做兼容性 / peer 依赖 / client bundle 声明检查再动手（避免装完 pending 或面板静默消失）。
  - 指令包含：查 dsh 与 peerDependencies 兼容性、检查 `exports` 与 patch id 一致性、装完记进资料馆、告知是否需重启
  - 找不到输入框时自动降级：复制到剪贴板 / 弹出指令全文
- 选输入框策略：取页面里面积最大的 textarea（避免写到侧栏搜索框）
- `/install` 路由保留（AI 或脚本可继续用），面板按钮不再走它

## 0.3.27 — 2026-10-18

### 修复

- **「一键安装」点击无反应**：`installPlugin()` 定义在组件**外**，却调用了组件内的 `askConfirm/notify`
  → 抛 `ReferenceError` 被 async 吞掉。新增模块级对话框桥 `DLG` + `uiConfirm/uiNotify`，
  组件挂载时把自己的实现注册进去；`installPlugin`、`Preview` 里的 `openLocalFile` 都改用它。

## 0.3.26 — 2026-10-18

### 修复（功能缺陷 7 条）

1. **Office 没装 LibreOffice → 500**：改为降级——ENOENT 时直接回原始文件（`Content-Disposition: attachment`），
   面板显示「用系统程序打开 / 下载」；新增 `env.office` 供前端判断，不再把错误塞进 iframe。
2. **论文检索缺 key 报「没有检索到」**：`library_paper_search` 返回值带上 `errors`，render 优先提示
   「需要配置 key 才能查这些源」；命中时也会附 warnings。
3. **`limit` 语义**：合并后按总数 `slice(0, n)`，与 README 一致。
4. **`/translate` 状态码**：缺 `src` → 400（原来 403「非法文件路径」）；找不到 PDF → 404；工具文案改中文。
5. **`/motion` 未配置**：403 → 404 且说明「未配置 motionDir，该功能未启用」。
6. **`/file?name=` 空参**：403 → 400「缺少 name 参数」。
7. **`library_repo_build` 相对路径**：字符串截断改 `path.relative()`，root 用 `resolve()` 归一化，不再截掉文件名前缀。

### 新增

- `POST /api/ai-library/open`：用系统默认程序打开本地文件（馆藏本来就是本机文件，比下载合理）。

## 0.3.25 — 2026-10-18

### 新增

- **跟随 DSH 明暗主题**：读 `body` 背景亮度判定 `light/dark`，输出 `data-theme`，
  暗色/亮色各一套调色板（`--ailib-fg` / `--ailib-bg` / `--ailib-surface`…），
  94 处 `rgba(255,255,255,α)` 全部改成由前景色派生，所以亮色下文字自动变深、不会白底白字。
- 主题切换实时跟随（1.2s 轮询 + MutationObserver）。
- **极光在亮色主题反色**：主色压暗 + `mix-blend-mode: multiply`，白底上呈现深色光晕；暗色仍为发光叠加。

## 0.3.24 — 2026-10-18

### 修复

- **侧栏图标选中后消失**：`PanelIcon` 在选中态用 `var(--ailib-accent)`，但这个变量定义在 `.ailib-shell` 上，
  侧栏图标不在它的子树里 → 变量未定义、`stroke` 无效、图标变透明。改为带完整回退链
  `var(--ailib-accent, var(--dsw-alias-brand-primary, #e6c16f))`。

## 0.3.23 — 2026-10-18

### 修复

- **更新失败：spawn EINVAL**：Windows 上 `execFile` 直接跑 `.cmd/.bat` 会被 Node ≥20 拒绝。
  新增 `execCli()`：`.exe` 直跑，`.cmd/.bat` 或无扩展名统一经 `cmd.exe /d /s /c`，并做参数转义。
  `/install`、`/update` 全部改用它；`deriveDshCli()` 增加多个候选路径（含 `~/.local/bin/dsh.cmd`）。
- **安装按钮像没反应**：Electron 环境下 `window.confirm/alert` 可能被静默禁用。
  改为面板内确认弹窗 + 底部轻提示（`askConfirm` / `notify`），14 处 alert、3 处 confirm 全部替换。

## 0.3.22 — 2026-10-18

### 主题

- 主色统一走 CSS 变量 `--ailib-accent`：`config.accent` → DSH 主题变量（`--dsw-alias-brand-primary` / `--dsw-static-deepseek-500`）→ 默认金色 `#e6c16f`
- 55 处 `rgba(230,193,111,α)`、9 处 `#e6c16f`、11 处 `#f2d791` 全改为 `color-mix()` / 变量派生，按钮尺寸与动效不变，只换色
- 极光背景（WebGL）主色跟随 `--ailib-accent`：读不到合法颜色时回退金色，并自动生成高光色
  - DSH 目前只在欢迎页作用域暴露 `--dsw-*` 设计 token，主界面没有全局主色变量；想完全一致就填 `accent: "#4176E6"`

## 0.3.21 — 2026-10-18

### 修复

- **「＋ 新增大类」点击无反应**：原实现用 `window.prompt`，而 Electron 渲染进程**不提供 prompt**（alert/confirm 有），
  调用直接抛错且被 async 吞掉 → 看起来像按钮没接事件。
- 改为面板内输入弹窗（`askText()` + `ailib-ask` 遮罩层）：支持 Enter 提交、Esc 取消、点遮罩取消。
- 同样修掉「批量改分组」「批量加标签」两处 `window.prompt`。

## 0.3.20 — 2026-10-18

### 新装体验

- **「论文资料」大类常驻显示**：即使一条论文都没有，左侧也会出现该大类（`ALWAYS_VISIBLE_BUCKETS`），
  新装用户一眼知道论文该往哪放，不用先配大类
- 论文大类为空时主区显示「论文资料还是空的」+「搜论文」按钮（以及免 key 说明），不再只显示「没有匹配的条目」

## 0.3.19 — 2026-10-18

### 界面

- 「本地对话产物」改成**真·三级树**：大类 → 对话（▸/▾ 可展开）→ 按类型 / 按项目 → 条目
  - 对话行可展开，子层用竖虚线缩进，条目是整行按钮（不再是一面墙的胶囊）
  - 点对话名 = 选中并展开；点 ▸/▾ 只展开/收起
  - 展开状态默认跟随当前选中项

## 0.3.18 — 2026-10-18

### 修复

- **面板空白（严重）**：上一版把「对话内子层」写在了 `g` 作用域外，渲染直接 `ReferenceError: g is not defined`，整块面板不显示。
  改为用 `React.Fragment` 把「对话按钮 + 两组子层」放在同一个 map 回调里，并删掉残留旧块。
- 「按项目」子层改为**从来源路径推导**：优先取含「实验 / 作业 / 单元 / week / lab」的目录名
  （例：`E:/javaweb/Web技术与应用/实验二-HTML基础/...` → `实验二-HTML基础`），不再因为 group 等于对话名而空着。
- 子层显示条件从「多于 1 项」放宽到「有 1 项即显示」，结构始终可见。

## 0.3.17 — 2026-10-18

### 修正分类层级

按需求把「本地对话产物」的层级改成：**按对话 → 对话内再分「按类型」和「按项目」**

- 每个对话下面两行子组：`按类型`（md/docx/pdf…）与 `按项目`（该对话内条目自己的 group）
- 选择键：`conv:<对话>::fmt:<类型>` / `conv:<对话>::grp:<项目>`（兼容旧的 `conv:<对话>::<类型>`）
- `library_search` 的 `project` / `format` 过滤保留，用于检索时缩范围

## 0.3.16 — 2026-10-18

### 分类与检索

- 「本地对话产物 › 按对话」下新增**类型子层**：每个对话展开后按 md / png / pptx / jsx… 分块，
  点一下只看「这个对话里的这类文件」（选择键 `conv:<对话>::<类型>`）
- `library_search` 新增 `project` / `format` 两个过滤参数：检索时直接缩小范围，少拉无关条目（省 token、提高缓存命中）

## 0.3.15 — 2026-10-18

### 安全 / 文案

- **`/paper`、`/paper/read` 补 Origin/Referer 校验**：之前这两个 GET 没守卫，恶意页面可以用
  `<img src="http://127.0.0.1:<port>/api/ai-library/paper?q=x">` 刷掉你配置的 Sciverse 配额并转发查询
  （`<img>` 不带 Origin，但有 Referer，所以两者都查）
- README：「插件本身不联网」改成「除主动检索 / 手动同步市场外不联网」——新加了论文检索与 AnySearch，原描述自相矛盾
- README：新增密钥说明（`paperKeys` 以明文存在插件目录，注意目录权限）

## 0.3.14 — 2026-10-18

### 文档

- README 新增「论文检索需要配哪些 key」：四个可选平台（Sciverse / IEEE / Elsevier / Springer）+ AnySearch 的申请地址、配置项、两种填法，并说明**语义检索（RAG）必须配 sciverse**
- `config.example.json` 的 `_keysNote` 写清每个 key 的来源
- `INTEGRATION.md` 路由表补充 `mode=semantic` 与 `/paper/read`
- 面板「配置 key」输入框的占位符改为提示申请地址（sciverse 标注「语义检索必填」）

## 0.3.13 — 2026-10-18

### 新增

- **Sciverse 语义检索（RAG）**：`POST /agentic-search`，返回原文 chunk
  - 论文弹层新增模式切换：「元数据检索」/「语义检索 (RAG)」（后者需要 sciverse key，未配置会提示）
  - 结果按 chunk 展示：标题 + 相似度 + 页码 + 片段正文；可「加入资源库」或「读原文」
- 新增 `lib/sciverse.js`：`sciverseMeta` / `sciverseSemantic` / `sciverseReadContent`
- 新路由 `GET /api/ai-library/paper/read?doc=&offset=&limit=`：读 Sciverse 原文切片（Unicode 码点偏移）
- preflight：关键文件加 `lib/sciverse.js`，路由下限 18

## 0.3.12 — 2026-10-18

### 新增数据源

- **Sciverse（MetaSearch）**：`POST https://api.sciverse.space/meta-search`，Bearer token（`SCIVERSE_API_TOKEN`）
  - 论文面板新增「Sciverse」按钮；key 在「配置 key」里填 `sciverse`
  - 返回 structured metadata（unique_id / doc_id / doi / venue / year / abstract）
- **AnySearch**：`POST https://api.anysearch.com/v1/search`，**匿名可用**（有免费配额，填 key 配额更高）
  - 新增工具 `library_web_search`：返回 title / url / snippet，用于找页面或 PDF 落地页后再 `library_save_url`
  - 可选 key 写在 `paperKeys.anysearch`
- 工具数 14 → **15**（`library_web_search`）

## 0.3.11 — 2026-10-18

### 布局调整（窄屏三段）

- 面板 `<1240px`：左树 196→170px、预览 440→340px，把宽度还给卡片
- 面板 `<1120px` 且**没选中条目**时，预览区自动折叠（不再空占 300px）；选中后展开到 300px
- 面板 `<980px`：左树 150px、预览 260px、主区内边距收紧
- shell 增加 `data-sel` 属性驱动上述折叠

## 0.3.10 — 2026-10-18

### 布局调整

- 卡片网格从「固定 3 列」改为 `repeat(auto-fill, minmax(238px, 1fr))`：面板窄了自动两列，不再把字挤成竖条
- 卡片标题禁止 CJK 逐字换行（`word-break: normal` + 两行截断 + 省略号）
- 提示行（「已是最新版本」「已同步…」）去掉负边距，改为 6px 上间距 + 1.7 行高，不再贴住按钮
- 卡片摘要不再按窗口宽度隐藏（只有面板极窄 <560px 才隐藏）

## 0.3.9 — 2026-10-18

### 新增

- **默认页显示数据根**：`/api/ai-library` 的 `env` 增加 `root` / `itemsDir`，右侧默认页底部显示「数据根：…」，用户知道库建在哪
- README 增加「大肥鱼会替你做这些」产品介绍：自动收纳 / 插件市场 / 前端组件（[react-bits](https://github.com/DavidHDev/react-bits)）/ 真实论文检索

## 0.3.8 — 2026-10-18

### 变更

- **默认数据根改为 `<用户下载目录>/ai-library`**（原来 `~/ai-library`）
  - 理由：用户天然把产物丢在下载目录，装完不用先教他改路径
  - 已有 `config.json` / `AILIB_ROOT` 的用户不受影响（优先级不变）
  - README、`config.example.json` 同步更新；新增 `_rootNote` 说明
- preflight 增加静态断言：默认根必须落在 Downloads 下

## 0.3.7 — 2026-10-18

### 新增

- **系统提示词片段**：装载后通过 `ctx.inject(['systemPrompt'], …)` 注册 `ai-library` section（order 160）
  - 明确要求：本机新建/修改的文件在回话前入库，不要让用户自己找
  - 分场景给出入库方式：`library_import` / `library_autocapture` / `library_repo_build` / `library_save_url` / `library_paper_add`
  - 要求先 `library_search` 查重；提醒不要把密钥等私密内容写进库
  - 文本是函数：数据根 / `toolsEnabled` 变化后下一个请求立即生效
  - 用 `ctx.inject` 而非顶层 `inject`，服务缺失时不会让插件停在 pending
- 新增 `lib/prompt.js`（`buildLibraryPromptText` / `registerLibraryPrompt`，可单测）
- preflight 新增 6d：提示词片段注册与内容断言

## 0.3.6 — 2026-10-18

### 新增

- **面板一键安装后自动记进资料馆**：装完写一条 `kind: plugin` 条目（名称、版本、安装命令、安装告警、日期，分组「已安装插件」）
  - 同包重复安装不会重复堆条目，只更新版本与备注
  - 安装提示里会显示「已在资料馆里记录了一条」
- 新增 `lib/plugin-record.js`：`guessVersion` / `buildPluginEntry` / `mergePluginEntry` 纯函数，便于测试
- preflight 新增 6c：安装记录纯函数单测（版本解析、去重、版本更新）

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
