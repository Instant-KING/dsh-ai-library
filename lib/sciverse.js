/**
 * Sciverse 开放平台客户端（仅用 fetch，无依赖）。
 *
 *   POST /meta-search       结构化元数据检索（论文/作者/来源）
 *   POST /agentic-search    自然语言语义检索（RAG 用，返回 chunk）
 *   GET  /content           读原文切片（offset/limit 以 Unicode 码点计）
 *   POST /meta-paper-relations  引用 / 被引 / 相关工作
 *
 * 鉴权：Authorization: Bearer <SCIVERSE_API_TOKEN>
 * 文档：https://github.com/opendatalab/Sciverse-Agent-Tools
 */

const BASE = 'https://api.sciverse.space';
const UA = 'dsh-ai-library/0.3 (+https://github.com/Instant-KING/dsh-ai-library)';
const TIMEOUT = 30000;

/** 压空白 + 去标签。 */
const plain = (s) =>
  String(s || '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/** 统一请求。 */
async function call(path, { method = 'POST', key, body, query } = {}) {
  if (!key) throw new Error('未配置 Sciverse token（SCIVERSE_API_TOKEN）');
  let url = BASE + path;
  if (query && typeof query === 'object') {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== null) qs.set(k, String(v));
    url += '?' + qs.toString();
  }
  const res = await fetch(url, {
    method,
    headers: {
      authorization: 'Bearer ' + key,
      'user-agent': UA,
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(TIMEOUT),
  });
  if (!res.ok) {
    let detail = '';
    try {
      detail = (await res.text()).slice(0, 200);
    } catch {
      /* 忽略 */
    }
    throw new Error('Sciverse HTTP ' + res.status + (detail ? ' ' + detail : ''));
  }
  return await res.json();
}

/**
 * 结构化元数据检索（/meta-search）。
 * @param opts.key token
 * @param opts.query 关键词或布尔检索式
 * @param opts.limit 条数
 * @returns { ok, items, error? }
 */
export async function sciverseMeta({ key, query, limit = 8 } = {}) {
  const q = String(query || '').trim();
  if (!q) return { ok: false, error: 'query is required', items: [] };
  const n = Math.min(50, Math.max(1, Number(limit) || 8));
  try {
    const j = await call('/meta-search', { key, body: { collection: 'papers', query: q, page_size: n } });
    const items = (j.results || []).map((r, i) => {
      const authors = Array.isArray(r.author) ? r.author : r.author ? [r.author] : [];
      const keywords = Array.isArray(r.keywords) ? r.keywords : Array.isArray(r.subjects) ? r.subjects : [];
      return {
        id: 'sciverse-' + (r.unique_id || i),
        title: plain(r.title),
        authors: authors.slice(0, 8),
        publishedAt: String(r.publication_published_year || ''),
        source: 'Sciverse',
        doi: r.doi || '',
        sourceUrl: r.doi ? 'https://doi.org/' + r.doi : '',
        pdfUrl: '',
        summary: plain(r.abstract).slice(0, 600),
        tags: keywords.slice(0, 4),
        uniqueId: r.unique_id || '',
        docId: r.doc_id || '',
        venue: r.publication_venue_name_unified || '',
      };
    });
    return { ok: true, items, totalCount: j.total_count };
  } catch (error) {
    return { ok: false, error: String((error && error.message) || error).slice(0, 200), items: [] };
  }
}

/**
 * 自然语言语义检索（/agentic-search），返回相关 chunk。
 * @param opts.key token
 * @param opts.query 自然语言问题
 * @param opts.topK 条数（1-100）
 * @param opts.filters 结构化过滤（可选，宽松语义）
 * @returns { ok, hits, error? }
 */
export async function sciverseSemantic({ key, query, topK = 8, filters } = {}) {
  const q = String(query || '').trim();
  if (!q) return { ok: false, error: 'query is required', hits: [] };
  const n = Math.min(100, Math.max(1, Number(topK) || 8));
  try {
    const body = { query: q, top_k: n };
    if (filters && typeof filters === 'object') body.filters = filters;
    const j = await call('/agentic-search', { key, body });
    const hits = (j.hits || []).map((h, i) => ({
      id: h.chunk_id || 'chunk-' + i,
      chunkId: h.chunk_id || '',
      docId: h.doc_id || '',
      title: plain(h.title),
      abstract: plain(h.abstract).slice(0, 400),
      chunk: String(h.chunk || '').slice(0, 1200),
      score: Number(h.score) || 0,
      offset: Number(h.offset) || 0,
      pageNo: h.page_no || 0,
      sourceType: h.source_type || '',
    }));
    return { ok: true, hits };
  } catch (error) {
    return { ok: false, error: String((error && error.message) || error).slice(0, 200), hits: [] };
  }
}

/**
 * 读原文切片（/content）。
 * @param opts.key token
 * @param opts.docId 文档 id
 * @param opts.offset Unicode 码点偏移
 * @param opts.limit 长度
 * @returns { ok, text, nextOffset, more, error? }
 */
export async function sciverseReadContent({ key, docId, offset = 0, limit = 4096 } = {}) {
  if (!docId) return { ok: false, error: 'docId is required', text: '' };
  try {
    const j = await call('/content', {
      method: 'GET',
      key,
      query: { doc_id: docId, offset: Number(offset) || 0, limit: Number(limit) || 4096 },
    });
    return {
      ok: true,
      text: String(j.text || ''),
      nextOffset: Number(j.next_offset) || 0,
      more: !!j.more,
    };
  } catch (error) {
    return { ok: false, error: String((error && error.message) || error).slice(0, 200), text: '' };
  }
}
