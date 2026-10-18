/**
 * 插件市场索引（dshmarket / awesome-dsh-plugin 的 index.json）。
 *
 * 格式（format: 1）：
 *   { format, title, description, metadata:{ categories }, plugins: [
 *       { name, title, description:{zh,en}, homepage, repository:{url},
 *         metadata:{ category, keywords, labels }, versions:[{ version, publishTimestamp }] } ] }
 *
 * 转成资料馆的 market 条目形状（与旧 api.dshmk.com 的转换结果保持一致）。
 */

/** 分类中文名（索引里带 metadata.categories，缺失时退回英文 key）。 */
function categoryLabel(catalog, key) {
  try {
    const def = catalog && catalog.metadata && catalog.metadata.categories && catalog.metadata.categories[key];
    if (def && def.title) return String(def.title.zh || def.title.en || key);
  } catch {
    /* 忽略 */
  }
  return String(key || '未分类');
}

/**
 * 把 dshmarket index.json 转成条目。
 * @param catalog 原始索引
 * @param opts.limit 最多保留多少条（按发布时间/版本新到旧）
 * @param opts.today 日期字符串，写进 added
 * @param opts.profile 安装命令里的 profile（默认 desktop）
 * @returns { items, groups, total, generatedAt, source }
 */
export function normalizeDshMarket(catalog, { limit = 3000, today = '', profile = 'desktop' } = {}) {
  const plugins = Array.isArray(catalog && catalog.plugins) ? catalog.plugins : [];
  const cats = (catalog && catalog.metadata && catalog.metadata.categories) || {};
  const date = today || new Date().toISOString().slice(0, 10);

  const rows = plugins
    .map((p) => {
      const versions = Array.isArray(p.versions) ? p.versions : [];
      const latest = versions.slice().sort((a, b) => (b.publishTimestamp || 0) - (a.publishTimestamp || 0))[0] || {};
      const name = String(p.name || '').trim();
      const desc = p.description || {};
      const zhDesc = String(desc.zh || desc.en || '').replace(/\s+/g, ' ').slice(0, 140);
      const repo = p.repository && (p.repository.url || p.repository);
      return {
        name,
        title: String(p.title || name || '(未命名)'),
        summary: zhDesc,
        version: String(latest.version || ''),
        at: Number(latest.publishTimestamp || 0),
        homepage: String(p.homepage || ''),
        repo: String(repo || ''),
        category: String((p.metadata && p.metadata.category) || ''),
        keywords: Array.isArray(p.metadata && p.metadata.keywords) ? p.metadata.keywords.slice(0, 5) : [],
        engines: latest.engines || {},
      };
    })
    .filter((r) => r.name);

  rows.sort((a, b) => b.at - a.at);

  const items = rows.slice(0, Math.max(1, limit)).map((r) => {
    const group = categoryLabel(catalog, r.category);
    const eng = r.engines && (r.engines.dsh || r.engines['@deepseek-ai/dsh']);
    return {
      id: 'm-' + r.name.replace(/[^A-Za-z0-9._-]/g, '-').toLowerCase(),
      kind: 'market',
      status: 'available',
      title: r.title,
      summary: r.summary,
      source: r.repo ? r.repo.replace(/^https?:\/\/github\.com\//, '') : r.name,
      version: r.version,
      fit: '',
      tags: [r.category].concat(r.keywords).filter(Boolean).slice(0, 5),
      tools: [],
      install: 'dsh plugin --profile ' + profile + ' add ' + r.name,
      link: r.homepage || r.repo || '',
      notes: [
        r.version ? '版本 ' + r.version : '',
        eng ? '要求 DSH ' + String(eng) : '',
        r.at ? '发布 ' + new Date(r.at * 1000).toISOString().slice(0, 10) : '',
        '包名 ' + r.name,
      ].filter(Boolean),
      group,
      added: date,
    };
  });

  const groups = {};
  for (const item of items) groups[item.id] = item.group;

  return {
    items,
    groups,
    total: rows.length,
    generatedAt: date,
    source: 'dshmarket.com / awesome-dsh-plugin.com',
    categories: Object.keys(cats).length,
  };
}
