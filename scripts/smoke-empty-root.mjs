#!/usr/bin/env node
/**
 * 空数据根冒烟：用一个全新的空目录当 AILIB_ROOT，验证
 *   1. GET /api/ai-library 不 500
 *   2. 自动创建 library.js
 *   3. 外部 Origin 被 403 拒绝，本机 Origin 放行
 *
 * 用法：node scripts/smoke-empty-root.mjs [插件 lib/index.js 路径]
 * 输出：一行 JSON
 */
import { mkdtempSync, readdirSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const indexPath = process.argv[2] || new URL('../lib/index.js', import.meta.url).href;
const root = mkdtempSync(join(tmpdir(), 'ailib-empty-'));
process.env.AILIB_ROOT = root;

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

  const g = await call('/api/ai-library', 'GET');
  const evil = await call('/api/ai-library/item', 'POST', { origin: 'https://evil.example.com' });
  const local = await call('/api/ai-library/item', 'POST', { origin: 'dsh-app://app' });

  console.log(JSON.stringify({
    getStatus: g.status,
    ok: !!(g.json && g.json.ok),
    libraryCreated: existsSync(join(root, 'library.js')),
    files: readdirSync(root).join(','),
    evilStatus: evil.status,
    localStatus: local.status,
  }));
} catch (error) {
  console.log(JSON.stringify({ error: String((error && error.message) || error).slice(0, 200) }));
  process.exitCode = 1;
} finally {
  rmSync(root, { recursive: true, force: true });
}
