# awesome-dsh-plugin 投稿文件

按 <https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/blob/main/contributing.md> 的要求，
投稿只需在对方仓库加**一个文件**：`data/plugins/Instant-KING__dsh-ai-library.yml`。

这里放的就是那份文件（内容可以直接复制过去）。

## 自检结果（2026-10-20）

| 要求 | 状态 |
| --- | --- |
| `package.json` 声明 `dsh.bundle` | ✅ `{ "bundle": { "patch": "./cordis.patch.yml" } }` |
| 仓库根有 `cordis.patch.yml` | ✅ `- insert: [{ id: dsh-ai-library, name: dsh-ai-library }]` |
| 真实可用的代码（非占位/纯 README） | ✅ 18 个工具、22 条宿主路由、客户端面板 |
| 仓库创建满 1 天 | ✅ 2026-10-18T04:44Z 创建 |
| 仓库带 `dsh-plugin` topic | ✅（另有 deepseek-harness / pdfjs / paper-search 等） |
| 描述属实（数字与 API 要和代码对得上） | ✅ 18 工具 / 22 路由均实测数过 |
| 选一个贴合的分类 | ✅ `tools`（维护者可改） |

## 提交步骤

```sh
# 1. fork + 克隆
gh repo fork awesome-dsh-plugin/awesome-dsh-plugin --clone
cd awesome-dsh-plugin

# 2. 放到 data/plugins/ 下（文件名固定为 <owner>__<repo>.yml）
cp <本文件> data/plugins/Instant-KING__dsh-ai-library.yml

# 3. 提交并开 PR
git checkout -b add-dsh-ai-library
git add data/plugins/Instant-KING__dsh-ai-library.yml
git commit -m "Add Instant-KING/dsh-ai-library"
git push -u origin add-dsh-ai-library
gh pr create --title "Add Instant-KING/dsh-ai-library" --body "Local library panel for DSH: searchable cards over local files/artifacts, PDF/Office/image preview, paper search, web archiving, plugin market tab, and synced plugin resources (personas, meme packs, whale assets)."
```

> ⚠️ 不要手改对方的 README —— 它们由 `data/plugins/*.yml` 生成。

## 可能的争议点（提前想好说法）

1. **是否算「聚合包」**：不是。它有自己的行为（索引、检索、预览、论文检索、网页收藏），不是只依赖别的插件。
2. **和 dshmarket 是否重复**：部分是（都有市场标签页），但资料馆的核心是本地资料索引；市场只是其中一个数据源，且已改为读同一份 `index.json`。
3. **描述里的数字**：写「18 tools / 22 routes」就必须对得上，评审会核对代码。
