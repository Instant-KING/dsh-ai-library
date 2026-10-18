/**
 * 「装完插件 → 记进资料馆」的纯逻辑（不碰文件系统，方便测试）。
 *
 * 规矩：每装/卸一个插件都要在资料馆留一条 kind:"plugin" 记录，
 * 写清名称、版本、安装命令、为什么装。这里只负责拼条目与合并。
 */

/**
 * 从安装输出里猜版本号。
 * @param stdout 命令输出
 * @param name 包名
 * @returns 版本字符串（猜不到返回空串）
 */
export function guessVersion(stdout, name) {
  const text = String(stdout || '');
  const escaped = String(name || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (escaped) {
    const m = new RegExp(escaped + '@(\\d+\\.\\d+\\.\\d+[\\w.-]*)').exec(text);
    if (m) return m[1];
  }
  const generic = /@(\d+\.\d+\.\d+[\w.-]*)/.exec(text);
  return generic ? generic[1] : '';
}

/**
 * 拼出一条插件记录。
 * @param opts.name 包名
 * @param opts.stdout 安装输出
 * @param opts.stderr 告警输出
 * @param opts.profile profile 名
 * @param opts.today YYYY-MM-DD（便于测试注入）
 * @returns 条目对象
 */
export function buildPluginEntry({ name, stdout = '', stderr = '', profile = 'desktop', today } = {}) {
  const version = guessVersion(stdout, name);
  const day = today || new Date().toISOString().slice(0, 10);
  const note = '由资料馆面板一键安装' + (version ? ' @' + version : '') + '（' + day + '）';
  const warn = String(stderr || '').trim()
    ? '安装告警：' + String(stderr).trim().split('\n').slice(-3).join(' ')
    : '';
  const pkg = String(name || '').trim();
  return {
    id: 'plugin-' + pkg.replace(/[^\w.-]+/g, '-'),
    kind: 'plugin',
    title: pkg,
    summary: '通过资料馆面板安装的插件' + (version ? '（' + version + '）' : ''),
    source: 'npm',
    version,
    tags: ['已安装', 'plugin'],
    notes: [note].concat(warn ? [warn] : []),
    install: 'dsh plugin --profile ' + profile + ' add ' + pkg,
    group: '已安装插件',
    origin: 'manual',
    added: day,
  };
}

/**
 * 把条目合并进 store（同 id 更新，不重复堆）。
 * @param store { items: [], groups: {} }
 * @param entry buildPluginEntry 的产物
 * @returns { ok, id, version, updated }
 */
export function mergePluginEntry(store, entry) {
  if (!store || !Array.isArray(store.items)) throw new Error('store.items 不是数组');
  store.groups = store.groups || {};
  const existing = store.items.find((it) => it.id === entry.id);
  const note = entry.notes[0];
  if (existing) {
    existing.kind = 'plugin';
    existing.version = entry.version || existing.version || '';
    existing.notes = Array.isArray(existing.notes) ? existing.notes : [];
    if (note && !existing.notes.includes(note)) existing.notes.unshift(note);
    existing.notes = existing.notes.slice(0, 12);
    existing.install = existing.install || entry.install;
    existing.group = existing.group || entry.group;
    store.groups[entry.id] = existing.group;
    return { ok: true, id: entry.id, version: existing.version, updated: true };
  }
  store.items.push(entry);
  store.groups[entry.id] = entry.group;
  return { ok: true, id: entry.id, version: entry.version, updated: false };
}
