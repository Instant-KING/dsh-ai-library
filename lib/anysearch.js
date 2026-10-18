/**
 * AnySearch 网页检索（匿名可用，带 key 配额更高）。
 *
 *   POST https://api.anysearch.com/v1/search
 *   body: { query, num_results }
 *   返回: { code: 0, data: { results: [{ title, url, snippet, ... }] } }
 *
 * 它不是论文库——用来「找页面 / 找官方文档 / 找 PDF 落地页」，
 * 论文元数据仍走 lib/paper.js 的十个学术源。
 */

const BASE = 'https://api.anysearch.com';
const UA = 'dsh-ai-library/0.3 (+https://github.com/Instant-KING/dsh-ai-library)';
const TIMEOUT = 20000;

/**
 * 网页检索。
 * @param opts.query 关键词
 * @param opts.limit 条数（1-20）
 * @param opts.key 可选 API key（不填走匿名配额）
 * @returns { ok, results: [{title,url,snippet}], error? }
 */
export async function searchWeb({ query, limit = 8, key = '' } = {}) {
  const q = String(query || '').trim();
  if (!q) return { ok: false, error: 'query is required', results: [] };
  const n = Math.min(20, Math.max(1, Number(limit) || 8));
  const headers = { 'content-type': 'application/json', 'user-agent': UA };
  if (key) headers.authorization = 'Bearer ' + key;
  try {
    const res = await fetch(BASE + '/v1/search', {
      method: 'POST',
      headers,
      body: JSON.stringify({ query: q, num_results: n }),
      signal: AbortSignal.timeout(TIMEOUT),
    });
    if (!res.ok) {
      let detail = '';
      try { detail = (await res.text()).slice(0, 160); } catch { /* 忽略 */ }
      return { ok: false, error: 'HTTP ' + res.status + (detail ? ' ' + detail : ''), results: [] };
    }
    const json = await res.json();
    if (json && json.code !== 0) return { ok: false, error: String(json.message || 'code=' + json.code), results: [] };
    const list = (json && json.data && json.data.results) || [];
    const results = list.slice(0, n).map((r) => ({
      title: String(r.title || '').replace(/\s+/g, ' ').trim(),
      url: String(r.url || ''),
      snippet: String(r.snippet || r.description || '').replace(/\s+/g, ' ').trim().slice(0, 400),
    })).filter((r) => r.url);
    return { ok: true, results };
  } catch (error) {
    return { ok: false, error: String((error && error.message) || error).slice(0, 200), results: [] };
  }
}
