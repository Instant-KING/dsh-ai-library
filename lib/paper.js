/**
 * 论文多源检索（纯 Node，无外部依赖、不调用 Python）。
 *
 * 免 key 源：arxiv / openalex / crossref / doaj / openaire / inspire / europepmc / zenodo / hal / datacite
 * 需 key 源：ieee / elsevier(sciencedirect) / springer
 *
 * 所有结果统一成同一个结构：
 *   { id, title, authors[], publishedAt, source, doi, sourceUrl, pdfUrl, summary, tags[] }
 */

const UA = 'dsh-ai-library/0.3 (+https://github.com/Instant-KING/dsh-ai-library)';
const TIMEOUT = 20000;

/** 免 key 的源。 */
export const FREE_SOURCES = ['arxiv', 'openalex', 'crossref', 'doaj', 'openaire', 'inspire', 'europepmc', 'zenodo', 'hal', 'datacite'];
/** 需要 key 的源。 */
export const KEYED_SOURCES = ['ieee', 'elsevier', 'springer'];

/** 抓 JSON / 文本，带超时。 */
async function grab(url, opts) {
  const res = await fetch(url, {
    headers: { 'user-agent': UA, accept: 'application/json, text/xml, */*', ...(opts && opts.headers) },
    signal: AbortSignal.timeout(TIMEOUT),
  });
  if (!res.ok) throw new Error('HTTP ' + res.status + ' ' + url.slice(0, 80));
  return opts && opts.text ? await res.text() : await res.json();
}

/** 去 HTML 标签、压空白。 */
const plain = (s) =>
  String(s || '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&lt;[^&]*?&gt;/g, ' ')
    .replace(/&[a-z]+;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/** 取年份。 */
const year = (v) => {
  const m = /(\d{4})/.exec(String(v || ''));
  return m ? m[1] : '';
};

/* ────────────────────────── 免 key 源 ────────────────────────── */

async function arxiv(q, limit) {
  const url = 'http://export.arxiv.org/api/query?search_query=' + encodeURIComponent('all:"' + q + '"') + '&start=0&max_results=' + limit;
  const xml = await grab(url, { text: true });
  const out = [];
  for (const m of xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)) {
    const e = m[1];
    const pick = (tag) => {
      const r = new RegExp('<' + tag + '[^>]*>([\\s\\S]*?)</' + tag + '>').exec(e);
      return r ? plain(r[1]) : '';
    };
    const id = /<id>([\s\S]*?)<\/id>/.exec(e);
    const authors = [...e.matchAll(/<author>[\s\S]*?<name>([\s\S]*?)<\/name>/g)].map((x) => plain(x[1]));
    const pdf = /<link[^>]+title="pdf"[^>]+href="([^"]+)"/.exec(e);
    out.push({
      id: id ? id[1].replace(/^http[s]?:\/\/arxiv\.org\/abs\//, 'arxiv-') : 'arxiv-' + out.length,
      title: pick('title'),
      authors,
      publishedAt: pick('published').slice(0, 10),
      source: 'arXiv',
      doi: pick('arxiv:doi'),
      sourceUrl: id ? id[1].trim() : '',
      pdfUrl: pdf ? pdf[1] : '',
      summary: pick('summary').slice(0, 600),
      tags: (pick('arxiv:primary_category') || '').split(/\s+/).filter(Boolean).slice(0, 4),
    });
  }
  return out;
}

async function crossref(q, limit) {
  const url = 'https://api.crossref.org/works?query=' + encodeURIComponent(q) + '&rows=' + limit + '&select=DOI,title,author,issued,abstract,container-title,URL,link,subject';
  const j = await grab(url);
  return (j.message?.items || []).map((it, i) => ({
    id: 'crossref-' + (it.DOI || i),
    title: plain((it.title || [])[0]),
    authors: (it.author || []).map((a) => [a.given, a.family].filter(Boolean).join(' ')),
    publishedAt: year((it.issued && it.issued['date-parts'] && it.issued['date-parts'][0] || []).join('-')),
    source: 'Crossref',
    doi: it.DOI || '',
    sourceUrl: it.URL || (it.DOI ? 'https://doi.org/' + it.DOI : ''),
    pdfUrl: '',
    summary: plain(it.abstract).slice(0, 600),
    tags: (it.subject || []).slice(0, 4),
  }));
}

async function openalex(q, limit) {
  const url = 'https://api.openalex.org/works?search=' + encodeURIComponent(q) + '&per-page=' + limit;
  const j = await grab(url);
  return (j.results || []).map((it, i) => ({
    id: 'openalex-' + String(it.id || i).split('/').pop(),
    title: plain(it.title || it.display_name),
    authors: (it.authorships || []).map((a) => a.author && a.author.display_name).filter(Boolean),
    publishedAt: String(it.publication_year || ''),
    source: 'OpenAlex',
    doi: String(it.doi || '').replace(/^https?:\/\/doi\.org\//, ''),
    sourceUrl: it.doi || it.id || '',
    pdfUrl: (it.best_oa_location && it.best_oa_location.pdf_url) || '',
    summary: plain(it.abstract_inverted_index ? '' : '') || '',
    tags: (it.concepts || []).slice(0, 4).map((c) => c.display_name),
  }));
}

async function doaj(q, limit) {
  const url = 'https://doaj.org/api/search/articles/' + encodeURIComponent(q) + '?pageSize=' + limit;
  const j = await grab(url);
  return (j.results || []).map((r, i) => {
    const b = r.bibjson || {};
    return {
      id: 'doaj-' + (b.id || i),
      title: plain(b.title),
      authors: (b.author || []).map((a) => a.name).filter(Boolean),
      publishedAt: year(b.year),
      source: 'DOAJ',
      doi: (b.identifier || []).filter((x) => /doi/i.test(x.type || '')).map((x) => x.id)[0] || '',
      sourceUrl: (b.link || []).filter((l) => /fulltext/i.test(l.type || '')).map((l) => l.url)[0] || r.id || '',
      pdfUrl: '',
      summary: plain(b.abstract).slice(0, 600),
      tags: (b.keywords || []).slice(0, 4),
    };
  });
}

async function europepmc(q, limit) {
  const url = 'https://www.ebi.ac.uk/europepmc/webservices/rest/search?query=' + encodeURIComponent(q) + '&format=json&pageSize=' + limit;
  const j = await grab(url);
  const list = j.resultList?.result || [];
  return list.map((it, i) => ({
    id: 'epmc-' + (it.id || i),
    title: plain(it.title),
    authors: it.authorString ? String(it.authorString).split(/,\s*/) : [],
    publishedAt: String(it.pubYear || ''),
    source: 'Europe PMC',
    doi: it.doi || '',
    sourceUrl: it.doi ? 'https://doi.org/' + it.doi : 'https://europepmc.org/article/' + (it.source || 'MED') + '/' + it.id,
    pdfUrl: '',
    summary: plain(it.abstractText).slice(0, 600),
    tags: [],
  }));
}

async function zenodo(q, limit) {
  const url = 'https://zenodo.org/api/records?q=' + encodeURIComponent(q) + '&size=' + limit;
  const j = await grab(url);
  return (j.hits?.hits || []).map((h, i) => {
    const md = h.metadata || {};
    return {
      id: 'zenodo-' + (h.id || i),
      title: plain(md.title),
      authors: (md.creators || []).map((c) => c.name).filter(Boolean),
      publishedAt: year(md.publication_date),
      source: 'Zenodo',
      doi: md.doi || '',
      sourceUrl: md.doi ? 'https://doi.org/' + md.doi : h.links?.self || '',
      pdfUrl: '',
      summary: plain(md.description).slice(0, 600),
      tags: (md.keywords || []).slice(0, 4),
    };
  });
}

async function datacite(q, limit) {
  const url = 'https://api.datacite.org/dois?query=' + encodeURIComponent(q) + '&page[size]=' + Math.min(limit, 25);
  const j = await grab(url);
  return (j.data || []).map((d, i) => {
    const at = d.attributes || {};
    return {
      id: 'datacite-' + (at.doi || i),
      title: plain((at.titles || [])[0]?.title),
      authors: (at.creators || []).map((c) => c.name).filter(Boolean),
      publishedAt: year(at.publicationYear || at.published),
      source: 'DataCite',
      doi: at.doi || '',
      sourceUrl: at.url || (at.doi ? 'https://doi.org/' + at.doi : ''),
      pdfUrl: '',
      summary: plain((at.descriptions || [])[0]?.description).slice(0, 600),
      tags: (at.subjects || []).map((s) => s.subject).filter(Boolean).slice(0, 4),
    };
  });
}

async function inspire(q, limit) {
  const url = 'https://inspirehep.net/api/literature?q=' + encodeURIComponent(q) + '&size=' + limit + '&sort=mostrecent';
  const j = await grab(url);
  return (j.hits?.hits || []).map((h, i) => {
    const md = h.metadata || {};
    return {
      id: 'inspire-' + (md.control_number || i),
      title: plain((md.titles || [])[0]?.title),
      authors: (md.authors || []).map((a) => a.full_name).filter(Boolean),
      publishedAt: year((md.publication_info || [])[0]?.year || md.preprint_date),
      source: 'INSPIRE HEP',
      doi: (md.dois || [])[0]?.value || '',
      sourceUrl: md.control_number ? 'https://inspirehep.net/literature/' + md.control_number : '',
      pdfUrl: '',
      summary: plain((md.abstracts || [])[0]?.value).slice(0, 600),
      tags: (md.keywords || []).map((k) => k.value).filter(Boolean).slice(0, 4),
    };
  });
}

async function hal(q, limit) {
  const url = 'https://api.archives-ouvertes.fr/search/?q=' + encodeURIComponent(q) + '&rows=' + limit + '&fl=title_s,authFullName_s,producedDateY_i,doiId_s,uri_s,abstract_s,keyword_s';
  const j = await grab(url);
  return (j.response?.docs || []).map((d, i) => ({
    id: 'hal-' + (d.uri_s || i),
    title: plain((d.title_s || [])[0]),
    authors: d.authFullName_s || [],
    publishedAt: String(d.producedDateY_i || ''),
    source: 'HAL',
    doi: d.doiId_s || '',
    sourceUrl: d.uri_s || '',
    pdfUrl: '',
    summary: plain((d.abstract_s || [])[0]).slice(0, 600),
    tags: (d.keyword_s || []).slice(0, 4),
  }));
}

async function openaire(q, limit) {
  const url = 'https://api.openaire.eu/search/publications?keywords=' + encodeURIComponent(q) + '&size=' + limit + '&format=json';
  const j = await grab(url);
  const results = j.response?.results?.result || [];
  const list = Array.isArray(results) ? results : [results];
  return list.map((r, i) => {
    const md = r.metadata?.['oaf:entity']?.['oaf:result'] || {};
    const title = md.title && (md.title.$ || (Array.isArray(md.title) ? md.title[0]?.$ : ''));
    const creators = md.creator || [];
    return {
      id: 'openaire-' + i,
      title: plain(title),
      authors: (Array.isArray(creators) ? creators : [creators]).map((c) => c && (c.$ || c)).filter(Boolean).slice(0, 8),
      publishedAt: year(md.dateofacceptance?.$ || md.dateofacceptance),
      source: 'OpenAIRE',
      doi: '',
      sourceUrl: '',
      pdfUrl: '',
      summary: plain(md.description?.$ || md.description).slice(0, 600),
      tags: [],
    };
  }).filter((x) => x.title);
}

/* ────────────────────────── 需 key 源 ────────────────────────── */

async function ieee(q, limit, key) {
  const url = 'https://ieeexploreapi.ieee.org/api/v1/search/articles?querytext=' + encodeURIComponent(q) + '&max_records=' + limit + '&apikey=' + encodeURIComponent(key);
  const j = await grab(url);
  return (j.articles || []).map((a, i) => ({
    id: 'ieee-' + (a.article_number || i),
    title: plain(a.title),
    authors: (a.authors?.authors || []).map((x) => x.full_name).filter(Boolean),
    publishedAt: year(a.publication_year),
    source: 'IEEE Xplore',
    doi: a.doi || '',
    sourceUrl: a.html_url || '',
    pdfUrl: a.pdf_url || '',
    summary: plain(a.abstract).slice(0, 600),
    tags: (a.index_terms?.ieee_terms?.terms || []).slice(0, 4),
  }));
}

async function elsevier(q, limit, key) {
  const url = 'https://api.elsevier.com/content/search/sciencedirect?query=' + encodeURIComponent(q) + '&count=' + limit;
  const j = await grab(url, { headers: { 'X-ELS-APIKey': key, accept: 'application/json' } });
  const list = j['search-results']?.entry || [];
  return list.map((e, i) => ({
    id: 'els-' + (e['dc:identifier'] || i),
    title: plain(e['dc:title']),
    authors: (e.author || []).map((a) => a['$']).filter(Boolean),
    publishedAt: year(e['prism:coverDate']),
    source: 'ScienceDirect',
    doi: e['prism:doi'] || '',
    sourceUrl: e.link?.[0]?.['@href'] || '',
    pdfUrl: '',
    summary: '',
    tags: [],
  }));
}

async function springer(q, limit, key) {
  const url = 'https://api.springernature.com/meta/v2/json?q=' + encodeURIComponent(q) + '&p=' + limit + '&api_key=' + encodeURIComponent(key);
  const j = await grab(url);
  return (j.records || []).map((r, i) => ({
    id: 'springer-' + (r.doi || i),
    title: plain(r.title),
    authors: (r.creators || []).map((c) => c.name).filter(Boolean),
    publishedAt: year(r.publicationDate),
    source: 'Springer',
    doi: r.doi || '',
    sourceUrl: r.url?.[0]?.value || (r.doi ? 'https://doi.org/' + r.doi : ''),
    pdfUrl: '',
    summary: plain(r.abstract).slice(0, 600),
    tags: (r.subjects || []).map((s) => s).slice(0, 4),
  }));
}

/* ────────────────────────── 调度 ────────────────────────── */

const FREE_IMPL = {
  arxiv,
  openalex,
  crossref,
  doaj,
  europepmc,
  zenodo,
  datacite,
  inspire,
  hal,
  openaire,
};

const KEYED_IMPL = { ieee, elsevier, springer };

/** 'auto' 时并发查询的源（挑稳定、快的）。 */
const AUTO_SET = ['openalex', 'crossref', 'arxiv', 'doaj', 'europepmc'];

/**
 * 检索论文。
 * @param {object} opts
 * @param {string} opts.query 关键词
 * @param {string} [opts.source] auto 或具体源
 * @param {number} [opts.limit] 每源条数
 * @param {object} [opts.keys] { ieee, elsevier, springer }
 * @returns {Promise<{items: object[], errors: object[], usedSources: string[]}>}
 */
export async function searchPapers({ query, source = 'auto', limit = 8, keys = {} } = {}) {
  const q = String(query || '').trim();
  if (!q) return { items: [], errors: [], usedSources: [] };
  const n = Math.min(30, Math.max(1, Number(limit) || 8));

  let plan = [];
  if (source === 'auto') plan = AUTO_SET.slice();
  else if (FREE_IMPL[source]) plan = [source];
  else if (KEYED_IMPL[source]) plan = [source];
  else plan = AUTO_SET.slice();

  const errors = [];
  const usedSources = [];
  const tasks = plan.map(async (src) => {
    try {
      let items;
      if (KEYED_IMPL[src]) {
        const key = src === 'ieee' ? keys.ieee : src === 'elsevier' ? keys.elsevier : keys.springer;
        if (!key) {
          errors.push({ source: src, message: '未配置 key' });
          return [];
        }
        items = await KEYED_IMPL[src](q, n, key);
      } else {
        items = await FREE_IMPL[src](q, n);
      }
      usedSources.push(src);
      return items || [];
    } catch (e) {
      errors.push({ source: src, message: String((e && e.message) || e).slice(0, 120) });
      return [];
    }
  });

  const chunks = await Promise.all(tasks);

  /* 合并 + 去重（同一 doi 或同标题）
     auto 模式下每个源都取 n 条，合并后交错排列，避免某一源霸屏 */
  const seen = new Set();
  const merged = [];
  const maxLen = Math.max(0, ...chunks.map((c) => c.length));
  for (let i = 0; i < maxLen; i += 1) {
    for (const c of chunks) {
      const it = c[i];
      if (!it) continue;
      const key = (it.doi || '').toLowerCase() || plain(it.title).toLowerCase();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      merged.push(it);
      if (merged.length >= n * (plan.length > 1 ? 2 : 1)) break;
    }
  }

  return { items: merged.slice(0, n * (plan.length > 1 ? 2 : 1)), errors, usedSources };
}
