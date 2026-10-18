#!/usr/bin/env node
/**
 * 重启前自检 / 发布前自检。
 *
 * 模拟 DSH 启动时会做的事，逐项断言；任何一项 ❌ 就先别重启。
 *
 *   node scripts/preflight.mjs            # 自检本机开发环境
 *   node scripts/preflight.mjs --profile web
 *
 * 检查内容：
 *   1. 关键文件是否齐全
 *   2. package.json 合法、name 正确
 *   3. cordis.patch.yml 里 insert 的 id 与包名一致（最关键的一条）
 *   4. profile 的 package.json 合法
 *   5. 宿主插件 import + apply（路由数、工具数）
 *   6. 客户端 bundle 被求值两次不炸、只注册一次、注册 id 正确、能注册主面板
 */
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

/* ── 定位 ─────────────────────────────────────────────── */
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PLUGIN_DIR = resolve(SCRIPT_DIR, '..');

function argValue(flag, fallback) {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const PROFILE_NAME = argValue('--profile', 'desktop');
const DSH_HOME = process.env.DSH_HOME || join(homedir(), '.dsh');
const PROFILE_DIR = process.env.DSH_PROFILE_DIR || join(DSH_HOME, 'profiles', PROFILE_NAME);
const PATCH_YML = join(PROFILE_DIR, 'cordis.patch.yml');
const PROFILE_PKG = join(PROFILE_DIR, 'package.json');

let fail = 0;
const ok = (b) => (b ? '✅' : '❌');
const check = (label, cond, extra) => {
  console.log('  ' + ok(cond) + ' ' + label + (extra ? '  ' + extra : ''));
  if (!cond) fail += 1;
};
const section = (t) => console.log('\n== ' + t + ' ==');

console.log('插件目录 : ' + PLUGIN_DIR);
console.log('profile  : ' + PROFILE_DIR);

/* ── 1. 关键文件 ─────────────────────────────────────── */
section('1. 关键文件');
for (const f of ['lib/index.js', 'lib/client.js', 'lib/tools.js', 'lib/config.js', 'package.json', 'lib/paper.js']) {
  check(f, existsSync(join(PLUGIN_DIR, f)));
}

/* ── 2. package.json ────────────────────────────────── */
section('2. package.json');
let pkg = null;
try {
  pkg = JSON.parse(readFileSync(join(PLUGIN_DIR, 'package.json'), 'utf8'));
  check('JSON 合法', true);
  check('name 非空', typeof pkg.name === 'string' && pkg.name.length > 0, '(' + pkg.name + ')');
  check('dsh.client 已声明', !!(pkg.dsh && pkg.dsh.client), JSON.stringify(pkg.dsh && pkg.dsh.client));
} catch (e) {
  check('JSON 合法', false, String(e.message).slice(0, 120));
}

/* ── 3. patch.yml ───────────────────────────────────── */
section('3. cordis.patch.yml');
let yml = '';
try {
  yml = readFileSync(PATCH_YML, 'utf8');
  check('可读', true);
} catch (e) {
  check('可读', false, String(e.message).slice(0, 120));
}
if (yml) {
  const rows = [...yml.matchAll(/-\s*id:\s*([^\s]+)[\s\S]*?name:\s*([^\n]+)/g)]
    .map((m) => ({ id: m[1], name: m[2].trim().replace(/^["']|["']$/g, '') }))
    .filter((r) => resolve(r.name) === resolve(join(PLUGIN_DIR, 'lib', 'index.js')) || /ai-library/.test(r.id));
  check('找到本插件的 insert', rows.length >= 1, rows.length + ' 条');
  const row = rows[0] || {};
  /* 核心规则：插入 id 必须等于包名，否则客户端 bundle 永远拿不到 */
  check('insert id === package name', !!pkg && row.id === pkg.name, row.id + ' vs ' + (pkg && pkg.name));
  check('insert name 指向真实文件', !!row.name && existsSync(row.name), row.name || '');
  check('没有重复 insert', rows.length <= 1, '实际 ' + rows.length);
}

/* ── 4. profile package.json ────────────────────────── */
section('4. profile/package.json');
try {
  const p = JSON.parse(readFileSync(PROFILE_PKG, 'utf8'));
  check('JSON 合法', true);
  const bundles = (p.dsh && p.dsh.profile && p.dsh.profile.bundles) || [];
  check('bundles 是数组', Array.isArray(bundles), bundles.length + ' 项');
} catch (e) {
  check('JSON 合法', false, String(e.message).slice(0, 120));
}

/* ── 5. 宿主插件 ───────────────────────────────────── */
section('5. 宿主插件');
const routes = [];
const tools = new Map();
const ctx = new Proxy(
  {
    effect: (f) => f(),
    webServer: { register: (x) => (routes.push(x), () => {}) },
    tools: { register: (t) => tools.set(t.name, t) },
  },
  { get: (t, k) => t[k], set: (t, k, v) => ((t[k] = v), true), defineProperty: (t, k, d) => (Object.defineProperty(t, k, d), true) },
);
try {
  const host = await import('file://' + join(PLUGIN_DIR, 'lib', 'index.js').replace(/\\/g, '/') + '?preflight=' + Date.now());
  check('import 成功', true);
  check('导出 apply', typeof host.apply === 'function');
  check('apply 是同步函数', host.apply.constructor.name !== 'AsyncFunction');
  host.apply(ctx);
  check('apply 无异常', true);
  check('路由注册', routes.length >= 15, routes.length + ' 条');
  check('工具注册', tools.size >= 14, tools.size + ' 个');
  let contract = 0;
  for (const [, t] of tools) {
    if (t.output && t.output.schema && typeof t.output.render === 'function' && t.parameters) contract += 1;
  }
  check('工具契约完整', contract === tools.size, contract + '/' + tools.size);
} catch (e) {
  check('import + apply', false, String(e.message).slice(0, 200));
}

/* ── 6. 客户端 bundle：模拟求值两次 ─────────────────── */
section('6. 客户端 bundle（求值两次不炸）');
const src = readFileSync(join(PLUGIN_DIR, 'lib', 'client.js'), 'utf8');
const loads = [];
const fakeEl = () => ({
  style: {}, classList: { add() {}, remove() {} }, setAttribute() {}, appendChild() {}, removeChild() {},
  getBoundingClientRect: () => ({ x: 0, y: 0, width: 100, height: 100, top: 0, left: 0, right: 100, bottom: 100 }),
  querySelector: () => null, querySelectorAll: () => [], clientWidth: 100, clientHeight: 100, getContext: () => null,
  addEventListener() {}, removeEventListener() {},
});
globalThis.window = { __ModuleLoader__: { load: (d) => loads.push(d) }, addEventListener() {}, removeEventListener() {}, confirm: () => true, alert() {}, prompt: () => '' };
globalThis.document = {
  hidden: false, visibilityState: 'visible', createElement: fakeEl, head: { appendChild() {} }, body: fakeEl(),
  addEventListener() {}, removeEventListener() {}, querySelector: () => null, querySelectorAll: () => [], getElementById: () => null,
};
globalThis.localStorage = { getItem: () => null, setItem() {}, get length() { return 0; }, key: () => null };
globalThis.MutationObserver = class { observe() {} disconnect() {} };
globalThis.ResizeObserver = class { observe() {} disconnect() {} };
globalThis.requestAnimationFrame = () => 1;
globalThis.cancelAnimationFrame = () => {};
globalThis.performance = { now: () => 0 };
globalThis.matchMedia = () => ({ matches: false });
globalThis.innerWidth = 1400;
globalThis.innerHeight = 900;
globalThis.fetch = () => Promise.resolve({ ok: true, json: () => Promise.resolve({ items: [], groups: {}, buckets: [] }), text: () => Promise.resolve('') });

let threw = null;
try {
  const run = new Function('window', 'document', 'localStorage', 'fetch', src);
  run(globalThis.window, globalThis.document, globalThis.localStorage, globalThis.fetch);
  run(globalThis.window, globalThis.document, globalThis.localStorage, globalThis.fetch);
} catch (e) {
  threw = e;
}
check('求值两次不抛错', !threw, threw ? String(threw.message).slice(0, 160) : '');
check('只注册 1 次', loads.length === 1, '实际 ' + loads.length + ' 次');
check('注册 id === package name', !!pkg && (loads[0] || {}).id === pkg.name, (loads[0] || {}).id || '');

if (loads[0] && typeof loads[0].factory === 'function') {
  let idx = 0;
  const stores = [[]];
  const top = () => stores[stores.length - 1];
  const React = {
    createElement(type, props, ...children) {
      const flat = [];
      const push = (c) => { if (Array.isArray(c)) c.forEach(push); else if (c !== null && c !== undefined && c !== false) flat.push(c); };
      push(children);
      return { type, props: props || {}, children: flat };
    },
    useState(i) { const st = top(); const k = idx++; if (!(k in st)) st[k] = i; return [st[k], (v) => { st[k] = typeof v === 'function' ? v(st[k]) : v; }]; },
    useEffect() {}, useMemo(f) { return f(); }, useCallback(f) { return f; },
    useRef(i) { return { current: i === undefined ? null : i }; }, Fragment: 'FRAGMENT',
  };
  try {
    const mod = loads[0].factory(() => React);
    check('factory 返回模块', !!mod);
    let Panel = null;
    mod.apply({ slots: { inject: (n, fn) => fn(), register: (m, c) => { if (m && m.name === 'main') Panel = c; } }, layout: {} });
    check('apply 注册主面板', !!Panel);
  } catch (e) {
    check('factory + apply', false, String(e.message).slice(0, 160));
  }
}

console.log('\n' + (fail === 0 ? '🟢 全部通过，可以重启' : '🔴 有 ' + fail + ' 项没通过，先别重启'));
process.exit(fail === 0 ? 0 : 1);
