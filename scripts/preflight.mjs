#!/usr/bin/env node
/**
 * 发布前 / 重启前自检。
 *
 *   node scripts/preflight.mjs          # 本机开发（额外检查 profile 的 patch.yml）
 *   node scripts/preflight.mjs --ci     # CI 模式（不依赖本机 profile，只查包本身）
 *   node scripts/preflight.mjs --profile web
 *
 * 任何一项 ❌ 就别发布 / 别重启。
 *
 * 检查项：
 *   1. 关键文件
 *   2. package.json + dsh.bundle.patch 契约（patch 存在、files 含它、insert name === 包名）
 *   3. 生产代码里没有调试探针
 *   4. 配置文件无 BOM、可解析
 *   5. 宿主插件 import + apply（路由/工具/契约）
 *   6. 客户端 bundle 求值两次不炸、只注册一次、id 正确、能注册主面板
 *   7. npm pack --dry-run：必含文件在、私有文件不在
 *   8. （仅本地）profile 的 patch.yml 与本插件 insert 一致
 */
import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir, tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PLUGIN_DIR = resolve(SCRIPT_DIR, '..');
const CI = process.argv.includes('--ci');

function argValue(flag, fallback) {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const PROFILE_NAME = argValue('--profile', 'desktop');
const DSH_HOME = process.env.DSH_HOME || join(homedir(), '.dsh');
const PROFILE_DIR = process.env.DSH_PROFILE_DIR || join(DSH_HOME, 'profiles', PROFILE_NAME);

let fail = 0;
const ok = (b) => (b ? '✅' : '❌');
const check = (label, cond, extra) => {
  console.log('  ' + ok(cond) + ' ' + label + (extra ? '  ' + extra : ''));
  if (!cond) fail += 1;
};
const section = (t) => console.log('\n== ' + t + ' ==');

console.log('模式    : ' + (CI ? 'CI（跳过本机 profile）' : '本地开发'));
console.log('插件目录: ' + PLUGIN_DIR);
if (!CI) console.log('profile : ' + PROFILE_DIR);

/* ── 1. 关键文件 ── */
section('1. 关键文件');
for (const f of ['lib/index.js', 'lib/client.js', 'lib/tools.js', 'lib/config.js', 'lib/paper.js', 'lib/plugin-record.js', 'lib/prompt.js', 'package.json', 'cordis.patch.yml']) {
  check(f, existsSync(join(PLUGIN_DIR, f)));
}

/* ── 2. package.json 与 bundle patch 契约 ── */
section('2. package.json / bundle patch');
let pkg = null;
try {
  pkg = JSON.parse(readFileSync(join(PLUGIN_DIR, 'package.json'), 'utf8'));
  check('JSON 合法', true);
  check('name 非空', typeof pkg.name === 'string' && pkg.name.length > 0, '(' + pkg.name + ')');
  check('dsh.client 已声明', !!(pkg.dsh && pkg.dsh.client), JSON.stringify(pkg.dsh && pkg.dsh.client));
  const patchRel = pkg.dsh && pkg.dsh.bundle && pkg.dsh.bundle.patch;
  check('声明 dsh.bundle.patch', !!patchRel, patchRel || '缺失（npm 装完不会挂载宿主插件）');
  if (patchRel) {
    const rel = String(patchRel).replace(/^\.\//, '');
    const patchPath = join(PLUGIN_DIR, rel);
    check('bundle.patch 指向真实文件', existsSync(patchPath), rel);
    check('files 包含该 patch', (pkg.files || []).some((f) => String(f).replace(/^\.\//, '') === rel), rel);
    if (existsSync(patchPath)) {
      const y = readFileSync(patchPath, 'utf8');
      const names = [...y.matchAll(/^\s*name:\s*([^\s#]+)/gm)].map((m) => m[1].replace(/^["']|["']$/g, ''));
      check('patch 的 name === 包名', names.length === 1 && names[0] === pkg.name, names.join(','));
    }
  }
} catch (e) {
  check('JSON 合法', false, String(e.message).slice(0, 120));
}

/* ── 3. 生产代码纯净度 ── */
section('3. 生产代码纯净度');
const clientSrc = existsSync(join(PLUGIN_DIR, 'lib/client.js')) ? readFileSync(join(PLUGIN_DIR, 'lib/client.js'), 'utf8') : '';
const indexSrc = existsSync(join(PLUGIN_DIR, 'lib/index.js')) ? readFileSync(join(PLUGIN_DIR, 'lib/index.js'), 'utf8') : '';
const toolsSrc = existsSync(join(PLUGIN_DIR, 'lib/tools.js')) ? readFileSync(join(PLUGIN_DIR, 'lib/tools.js'), 'utf8') : '';
const allSrc = clientSrc + indexSrc + toolsSrc;
/* 市场自动同步的 effect 依赖：只写 items.length 时，空库在 phase 变 ready 后不会重跑 */
check('市场自动同步 effect 依赖含 state.phase', clientSrc.includes('[state.phase, items.length]'));

for (const m of ['pet-probe', 'probePetWidget', 'bf-widget']) {
  check('无调试探针 "' + m + '"', !allSrc.includes(m));
}

/* ── 4. 配置文件 ── */
section('4. 配置文件');
for (const f of ['config.example.json', 'package.json']) {
  const p = join(PLUGIN_DIR, f);
  if (!existsSync(p)) continue;
  const buf = readFileSync(p);
  const hasBom = buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf;
  check(f + ' 无 BOM', !hasBom);
  try {
    JSON.parse(buf.toString('utf8').replace(/^\uFEFF/, ''));
    check(f + ' 可解析', true);
  } catch (e) {
    check(f + ' 可解析', false, String(e.message).slice(0, 80));
  }
}

/* ── 5. 宿主插件 ── */
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

/* ── 6. 客户端 bundle ── */
section('6. 客户端 bundle（求值两次不炸）');
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
  const run = new Function('window', 'document', 'localStorage', 'fetch', clientSrc);
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

/* ── 6b. 数据根冒烟（空库 + 损坏库）+ Origin 守卫 ── */
section('6b. 数据根 / Origin 校验');
{
  const smoke = join(SCRIPT_DIR, 'smoke-empty-root.mjs');
  const indexPath = join(PLUGIN_DIR, 'lib', 'index.js');
  const run = (extra) => {
    const out = execFileSync(process.execPath, [smoke, indexPath, ...(extra || [])], {
      encoding: 'utf8',
      timeout: 180000,
      maxBuffer: 16 * 1024 * 1024,
      env: { ...process.env },
    });
    const line = out.trim().split('\n').filter((l) => l.trim().startsWith('{')).pop() || '{}';
    return JSON.parse(line);
  };

  /* ① 空库 */
  try {
    const r = run([]);
    if (r.error) {
      check('空库冒烟', false, r.error);
    } else {
      check('空库 GET 不 500', r.getStatus === 200, 'HTTP ' + r.getStatus);
      check('空库返回 ok', r.ok === true);
      check('自动创建 library.js', r.libraryCreated === true, r.files || '');
      check('外部 Origin → /item 403', r.evilItem === 403, 'HTTP ' + r.evilItem);
      check('外部 Origin → /keys 403', r.evilKeys === 403, 'HTTP ' + r.evilKeys);
      check('外部 Origin → /log 403', r.evilLog === 403, 'HTTP ' + r.evilLog);
      check('本机 Origin 放行', r.localItem !== 403, 'HTTP ' + r.localItem);
    }
  } catch (e) {
    check('空库冒烟', false, String(e.message).split('\n')[0].slice(0, 140));
  }

  /* ② 损坏的 library.js 应降级为空库而不是 500 */
  try {
    const r = run(['--corrupt']);
    if (r.error) {
      check('损坏库冒烟', false, r.error);
    } else {
      check('损坏库 GET 仍 200', r.getStatus === 200, 'HTTP ' + r.getStatus);
      check('损坏库返回 ok', r.ok === true);
      check('损坏库带出 libraryError', !!r.libraryError, String(r.libraryError).slice(0, 60));
    }
  } catch (e) {
    check('损坏库冒烟', false, String(e.message).split('\n')[0].slice(0, 140));
  }
}

/* ── 6c. 安装记录（纯函数）── */
section('6c. 插件安装记录');
try {
  const mod = await import('file://' + join(PLUGIN_DIR, 'lib', 'plugin-record.js').replace(/\\/g, '/') + '?pf=' + Date.now());
  const entry = mod.buildPluginEntry({ name: 'dsh-fake', stdout: '+ dsh-fake@1.2.3', stderr: '', today: '2026-01-01' });
  check('生成条目（kind=plugin）', entry.kind === 'plugin');
  check('解析版本号', entry.version === '1.2.3', entry.version);
  check('安装命令含包名', String(entry.install).includes('dsh-fake'));
  const store = { items: [], groups: {} };
  mod.mergePluginEntry(store, entry);
  const again = mod.buildPluginEntry({ name: 'dsh-fake', stdout: '+ dsh-fake@1.2.4', today: '2026-01-02' });
  mod.mergePluginEntry(store, again);
  check('重复安装不堆条目', store.items.length === 1, '实际 ' + store.items.length);
  check('版本被更新', store.items[0].version === '1.2.4', store.items[0].version);
} catch (e) {
  check('安装记录纯函数', false, String(e.message).slice(0, 140));
}

/* ── 6d. 系统提示词片段 ── */
section('6d. 系统提示词片段');
try {
  const mod = await import('file://' + join(PLUGIN_DIR, 'lib', 'prompt.js').replace(/\\/g, '/') + '?pf=' + Date.now());
  let captured = null;
  const fake = {
    inject(deps, cb) {
      cb({ get: () => ({ section: (sec) => { captured = sec; } }) });
    },
  };
  const registered = mod.registerLibraryPrompt(fake, { root: '/tmp/示例库' });
  check('注册返回 true', registered === true);
  check('注册了 section', !!(captured && captured.name === 'ai-library'), captured ? captured.name : '(无)');
  const text = captured ? captured.text() : '';
  for (const kw of ['library_import', 'library_autocapture', 'library_search', '入库']) {
    check('提示词含 ' + kw, text.includes(kw));
  }
  check('service 缺失时不抛错', mod.registerLibraryPrompt({ inject: (d, cb) => cb({ get: () => null }) }, {}) === true);
} catch (e) {
  check('系统提示词片段', false, String(e.message).slice(0, 140));
}

/* ── 7. 打包清单 ── */
section('7. 打包清单（npm pack --dry-run）');
try {
  const npmCli = join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
  const out = execFileSync(process.execPath, [npmCli, 'pack', '--dry-run', '--json', '--ignore-scripts'], {
    cwd: PLUGIN_DIR,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  const json = JSON.parse(out.slice(out.indexOf('[')));
  const files = json[0].files.map((f) => f.path);
  console.log('  文件数 ' + files.length + ' | ' + (json[0].size / 1048576).toFixed(2) + ' MB');
  for (const must of ['lib/index.js', 'lib/client.js', 'lib/tools.js', 'lib/paper.js', 'cordis.patch.yml', 'package.json', 'README.md', 'config.example.json']) {
    check('tarball 含 ' + must, files.includes(must));
  }
  const banned = files.filter((f) => /^(items\/|\.cache\/|config\.json$|user-items\.json$|library\.js$|.*-items\.js$|\.probe-|\.blk|node_modules\/)/.test(f));
  check('tarball 不含私有/草稿文件', banned.length === 0, banned.slice(0, 4).join(', '));
} catch (e) {
  check('npm pack 可执行', false, String(e.message).split('\n')[0].slice(0, 120));
}

/* ── 8. 本机 profile（CI 跳过）── */
if (!CI) {
  section('8. 本机 profile');
  const PATCH_YML = join(PROFILE_DIR, 'cordis.patch.yml');
  const PROFILE_PKG = join(PROFILE_DIR, 'package.json');
  let yml = '';
  try {
    yml = readFileSync(PATCH_YML, 'utf8');
    check('patch.yml 可读', true);
  } catch (e) {
    check('patch.yml 可读', false, String(e.message).slice(0, 100));
  }
  if (yml) {
    const rows = [...yml.matchAll(/-\s*id:\s*([^\s]+)[\s\S]*?name:\s*([^\n]+)/g)]
      .map((m) => ({ id: m[1], name: m[2].trim().replace(/^["']|["']$/g, '') }))
      .filter((r) => resolve(r.name) === resolve(join(PLUGIN_DIR, 'lib', 'index.js')) || /ai-library/.test(r.id));
    check('找到本插件 insert', rows.length >= 1, rows.length + ' 条');
    check('没有重复 insert', rows.length <= 1, '实际 ' + rows.length);
    const row = rows[0] || {};
    check('insert 指向本插件', !!pkg && (row.name === pkg.name || resolve(row.name).startsWith(resolve(PLUGIN_DIR))), row.name || '');
  }
  try {
    const p = JSON.parse(readFileSync(PROFILE_PKG, 'utf8'));
    const bundles = (p.dsh && p.dsh.profile && p.dsh.profile.bundles) || [];
    check('profile package.json 合法', true, bundles.length + ' bundles');
  } catch (e) {
    check('profile package.json 合法', false, String(e.message).slice(0, 100));
  }
}

console.log('\n' + (fail === 0 ? '🟢 全部通过' : '🔴 有 ' + fail + ' 项没通过，先别发布/重启'));
process.exit(fail === 0 ? 0 : 1);
