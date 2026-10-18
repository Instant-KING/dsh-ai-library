#!/usr/bin/env node
/**
 * 数据根冒烟（两种模式）：
 *   正常模式：空目录当 AILIB_ROOT → 自动建库 / GET 200 / Origin 守卫
 *   --corrupt：写一个坏掉的 library.js → 应降级为空库 200，且 env.libraryError 有内容
 *
 * 用法：node scripts/smoke-empty-root.mjs [lib/index.js 路径] [--corrupt]
 * 输出：一行 JSON
 */
import { mkdtempSync, readdirSync, existsSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const args = process.argv.slice(2);
const corrupt = args.includes('--corrupt');
const indexPath = args.find((a) => !a.startsWith('--')) || new URL('../lib/index.js', import.meta.url).href;
const root = mkdtempSync(join(tmpdir(), 'ailib-smoke-'));
process.env.AILIB_ROOT = root;

if (corrupt) {
  /* 故意写坏：没有 window.LIBRARY.items */
  writeFileSync(join(root, 'library.js'), 'window.LIBRARY = { broken: true };', 'utf8');
}

try {
  const mod = await import('file://' + String(indexPath).replace(/\\/g, '/').replace(/^file:\/\//, '') + '?smoke=' + Date.now());
  const routes = [];
  mod.apply({ effect: (f) => f(), webServer: { register: (x) => (routes.push(x), () => {}) }, tools: { register: () => {} } });

  const call = async (path, method, headers) => {
    const r = routes.find((x) => x.path === path);
    if (!r) return { status: 0, json: null };
    const res = { body: '', status: 0, writeHead(c) { this.status = c; }, end(b) { if (b) this.body = b.toString(); } };
    await r.handler({ method, url: path, headers: headers || {} }, res);
    let json = null;
    try { json = JSON.parse(res.body); } catch { /* 非 JSON */ }
    return { status: res.status, json };
  };

  const evil = { origin: 'https://evil.example.com' };
  const g = await call('/api/ai-library', 'GET');
  const evilItem = await call('/api/ai-library/item', 'POST', evil);
  const evilKeys = await call('/api/ai-library/keys', 'POST', evil);
  const evilLog = await call('/api/ai-library/log', 'POST', evil);
  const localItem = await call('/api/ai-library/item', 'POST', { origin: 'dsh-app://app' });

  console.log(JSON.stringify({
    mode: corrupt ? 'corrupt' : 'empty',
    getStatus: g.status,
    ok: !!(g.json && g.json.ok),
    libraryCreated: existsSync(join(root, 'library.js')),
    files: readdirSync(root).join(','),
    libraryError: (g.json && g.json.env && g.json.env.libraryError) || '',
    evilItem: evilItem.status,
    evilKeys: evilKeys.status,
    evilLog: evilLog.status,
    localItem: localItem.status,
  }));
} catch (error) {
  console.log(JSON.stringify({ mode: corrupt ? 'corrupt' : 'empty', error: String((error && error.message) || error).slice(0, 200) }));
  process.exitCode = 1;
} finally {
  rmSync(root, { recursive: true, force: true });
}
