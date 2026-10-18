/**
 * 表情包插件（dsh-meme）图集适配器 —— 让资料馆能读、换、传图集。
 *
 * 对方的数据模型（逆向所得）：
 *   图集包目录 = manifest.json（name/description/version 可选）+ index.db（SQLite，表 memes）
 *   版本内包   = <插件根>/memes/<id>
 *   用户包     = <packsDir>/<id>，packsDir 默认 ~/.dsh/meme-packs
 *   启用状态   = ~/.dsh/dsh-expression.json 的 enabledPacks（字符串数组）
 *
 * 约定：只读优先；写操作只有「启用/停用」和「导入/删除」两类，且都做路径校验。
 */

import { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync, statSync, cpSync, rmSync } from 'node:fs';
import { join, basename, resolve, sep } from 'node:path';
import { homedir } from 'node:os';

/** 与 dsh-meme 的 dshHome() 保持一致（支持 DSH_MEME_HOME 覆盖）。 */
function memeHome() {
  return String(process.env.DSH_MEME_HOME || '').trim() || homedir();
}

export function settingsPath() {
  return join(memeHome(), '.dsh', 'dsh-expression.json');
}

export function readSettings() {
  try {
    return JSON.parse(readFileSync(settingsPath(), 'utf8'));
  } catch {
    return {};
  }
}

/** 合并写设置（与插件行为一致：浅合并，缩进 2）。 */
export function patchSettings(patch) {
  const next = { ...readSettings(), ...(patch || {}) };
  mkdirSync(join(memeHome(), '.dsh'), { recursive: true });
  writeFileSync(settingsPath(), JSON.stringify(next, null, 2), 'utf8');
  return next;
}

/** 当前扫描目录。 */
export function packsDir() {
  const s = readSettings();
  return String(s.packsDir || '').trim() || join(memeHome(), '.dsh', 'meme-packs');
}

/** 已启用的图集 id 列表。 */
export function enabledPacks() {
  const s = readSettings();
  return Array.isArray(s.enabledPacks) ? s.enabledPacks.map(String) : [];
}

/**
 * 找 dsh-meme 插件根目录（内置图集在 <root>/memes 下）。
 * @param dshHome DSH 主目录
 * @param profile profile 名
 */
export function findMemePluginRoot(dshHome, profile = 'desktop') {
  const candidates = [
    join(dshHome, 'profiles', profile, 'node_modules', 'dsh-meme'),
    join(dshHome, 'node_modules', 'dsh-meme'),
  ];
  for (const c of candidates) {
    try {
      if (existsSync(join(c, 'package.json'))) return c;
    } catch {
      /* 忽略 */
    }
  }
  return '';
}

/** 读 SQLite 数量（不可用时返回 -1，不抛错）。 */
async function dbMeta(dir) {
  const dbFile = join(dir, 'index.db');
  if (!existsSync(dbFile)) return { count: -1, cover: '', images: null };
  try {
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(dbFile, { readOnly: true });
    let count = 0;
    let cover = '';
    try {
      count = Number(db.prepare('SELECT COUNT(*) AS n FROM memes').get().n) || 0;
      const row = db.prepare("SELECT path FROM memes ORDER BY (tag = 'happy') DESC, path ASC LIMIT 1").get();
      if (row && row.path) cover = String(row.path);
    } catch {
      /* 表结构不同就算了 */
    }
    db.close();
    return { count, cover, images: true };
  } catch {
    return { count: -1, cover: '', images: false };
  }
}

/** 目录里有没有图集该有的东西。 */
function looksLikePack(dir) {
  try {
    return statSync(dir).isDirectory() && existsSync(join(dir, 'index.db'));
  } catch {
    return false;
  }
}

function readManifest(dir) {
  try {
    const m = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
    return {
      name: m && m.name ? String(m.name) : '',
      description: m && m.description ? String(m.description) : '',
      version: m && m.version ? String(m.version) : '',
    };
  } catch {
    return { name: '', description: '', version: '' };
  }
}

/**
 * 列出所有图集。
 * @param opts.dshHome DSH 主目录
 * @param opts.profile profile 名
 */
export async function listPacks({ dshHome, profile }) {
  const enabled = new Set(enabledPacks());
  const userDir = packsDir();
  const pluginRoot = findMemePluginRoot(dshHome, profile);
  const builtinDir = pluginRoot ? join(pluginRoot, 'memes') : '';
  const out = [];
  const seen = new Set();

  const push = async (dir, id, source) => {
    if (!id || seen.has(id) || !looksLikePack(dir)) return;
    seen.add(id);
    const manifest = readManifest(dir);
    const meta = await dbMeta(dir);
    out.push({
      id,
      name: manifest.name || id,
      description: manifest.description,
      version: manifest.version,
      count: meta.count,
      cover: meta.cover,
      source,
      path: dir,
      enabled: enabled.has(id),
    });
  };

  /* 用户包：packsDir 下的一级目录，再加一层历史遗留布局 */
  const scanUser = async (parent, depth) => {
    if (!parent || !existsSync(parent) || depth > 1) return;
    if (looksLikePack(parent)) return push(parent, basename(parent), 'custom');
    let names = [];
    try {
      names = readdirSync(parent);
    } catch {
      return;
    }
    for (const name of names) {
      const dir = join(parent, name);
      if (looksLikePack(dir)) await push(dir, name, 'custom');
      else await scanUser(dir, depth + 1);
    }
  };
  await scanUser(userDir, 0);

  /* 内置包 */
  if (builtinDir && existsSync(builtinDir)) {
    let names = [];
    try {
      names = readdirSync(builtinDir);
    } catch {
      names = [];
    }
    for (const name of names) await push(join(builtinDir, name), name, 'builtin');
  }

  return { packs: out, enabled: [...enabled], packsDir: userDir, pluginRoot };
}

/**
 * 启用 / 停用。
 * @param opts.id 图集 id
 * @param opts.mode 'solo'（只留这个）| 'add' | 'remove'
 */
export function setEnabled({ id, mode = 'solo' }) {
  const cur = new Set(enabledPacks());
  if (mode === 'solo') {
    cur.clear();
    cur.add(id);
  } else if (mode === 'add') {
    cur.add(id);
  } else if (mode === 'remove') {
    cur.delete(id);
  }
  const list = [...cur];
  patchSettings({ enabledPacks: list });
  return list;
}

/** 读某个图集的图片清单（最多 limit 条）。 */
export async function listImages({ dshHome, profile, id, limit = 200 }) {
  const found = (await listPacks({ dshHome, profile })).packs.find((p) => p.id === id);
  if (!found) return { ok: false, message: '没有这个图集' };
  const dbFile = join(found.path, 'index.db');
  try {
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(dbFile, { readOnly: true });
    let rows = [];
    try {
      rows = db.prepare('SELECT path, tag FROM memes ORDER BY path ASC LIMIT ?').all(Math.min(500, Math.max(1, limit)));
    } catch {
      rows = [];
    }
    db.close();
    return {
      ok: true,
      pack: found,
      images: rows.map((r) => ({ path: String(r.path || ''), tag: String(r.tag || '') })),
    };
  } catch (error) {
    return { ok: false, message: '读 index.db 失败（需要 Node 内置 node:sqlite）：' + String((error && error.message) || error).slice(0, 120) };
  }
}

/**
 * 解析图集内图片的真实路径（防越界）。
 * @returns 绝对路径或空串
 */
export async function resolveImage({ dshHome, profile, id, rel }) {
  const found = (await listPacks({ dshHome, profile })).packs.find((p) => p.id === id);
  if (!found) return '';
  const base = resolve(found.path);
  const target = resolve(base, String(rel || '').replace(/^[\\/]+/, ''));
  if (!target.startsWith(base + sep)) return '';
  try {
    return statSync(target).isFile() ? target : '';
  } catch {
    return '';
  }
}

/**
 * 导入一个图集包（源目录必须已经含 index.db）。
 * @param opts.src 源目录（用户从别处解压出来的包）
 * @param opts.id 目标 id（默认取源目录名）
 */
export async function importPack({ dshHome, profile, src, id }) {
  const from = resolve(String(src || ''));
  if (!existsSync(from)) return { ok: false, message: '源目录不存在：' + from };
  if (!looksLikePack(from)) return { ok: false, message: '源目录不是图集包（缺 index.db）' };
  const targetId = String(id || basename(from)).replace(/[^\w.@-]+/g, '-');
  const to = join(packsDir(), targetId);
  if (existsSync(to)) return { ok: false, message: '已存在同名图集：' + targetId };
  mkdirSync(packsDir(), { recursive: true });
  cpSync(from, to, { recursive: true });
  return { ok: true, id: targetId, path: to };
}

/** 删除用户图集（只允许删 packsDir 子树里的，内置包拒绝）。 */
export function removePack({ id }) {
  const dir = join(packsDir(), String(id || ''));
  const base = resolve(packsDir());
  const target = resolve(dir);
  if (!target.startsWith(base + sep)) return { ok: false, message: '拒绝删除：路径越界' };
  if (!existsSync(target)) return { ok: false, message: '没有这个用户图集（内置包不能删）' };
  rmSync(target, { recursive: true, force: true });
  const cur = enabledPacks().filter((x) => x !== id);
  patchSettings({ enabledPacks: cur });
  return { ok: true };
}
