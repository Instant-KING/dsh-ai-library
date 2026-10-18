/**
 * 插件联动适配器（Adapter）。
 *
 * 目标：资料馆不直接依赖任何插件，而是通过「适配器」只读地发现它们的素材，
 * 未来再由插件自己注册能力（导出/安装/共享）——服务端还没落地，所以这里先把
 * 接口和状态占位留好。
 *
 * 适配器契约（v1）：
 *   {
 *     id: string                       唯一标识
 *     label: string                    中文名
 *     detect(): {                      只读探测，必须不抛错
 *       available: boolean             插件/数据是否在
 *       path?: string                  数据位置
 *       count?: number                 素材数量
 *       reason?: string                不可用原因
 *       pending?: string[]             还未实现的能力（例如 ['server']）
 *     }
 *     capabilities: {                  能力声明，全部可选
 *       localRead?: boolean            已实现：把素材只读索引进资料馆
 *       export?: boolean               计划：导出成 pack
 *       install?: boolean              计划：写入插件（需用户确认）
 *       share?: boolean                计划：依赖服务端的共享
 *     }
 *   }
 *
 * 第三方插件注册方式（宿主同进程）：
 *   import { registerAdapter } from 'dsh-ai-library/lib/adapters.js'
 *   registerAdapter({...})
 * 或者由资料馆在启动时扫描 globalThis.__AILIB_ADAPTERS__。
 */

import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** 契约版本；将来变更能力字段时递增。 */
export const ADAPTER_VERSION = 1;

/** 外部注册进来的适配器。 */
const registered = new Map();

/**
 * 注册一个适配器（供其它插件调用）。
 * @param adapter 见文件头契约
 */
export function registerAdapter(adapter) {
  if (!adapter || !adapter.id) throw new Error('adapter.id 必填');
  registered.set(String(adapter.id), adapter);
  return true;
}

/**
 * 列出已注册的适配器 id（调试用）。
 */
export function listRegistered() {
  return [...registered.keys()];
}

/** 目录里有多少个条目（不存在返回 -1）。 */
function countEntries(dir) {
  try {
    if (!existsSync(dir)) return -1;
    return readdirSync(dir).length;
  } catch {
    return -1;
  }
}

/** 文件是否存在且非空。 */
function fileOk(file) {
  try {
    return existsSync(file) && statSync(file).isFile() && statSync(file).size > 0;
  } catch {
    return false;
  }
}

/**
 * 构造内置适配器列表。
 * @param opts.home  DSH 主目录（通常是 ~/.dsh）
 * @param opts.libraryRoot 资料馆数据根
 */
export function buildBuiltinAdapters({ home, libraryRoot }) {
  const storages = join(home, 'storages');

  return [
    {
      id: 'meme',
      label: '表情包',
      capabilities: { localRead: false, export: true, install: true, share: true },
      detect() {
        const settings = join(home, 'dsh-expression.json');
        const packs = join(home, 'whale-bubble-imgs');
        const hasSettings = fileOk(settings);
        const n = countEntries(packs);
        if (!hasSettings && n <= 0) {
          return { available: false, reason: '还没配置图集目录', pending: ['server'] };
        }
        return {
          available: true,
          path: hasSettings ? settings : packs,
          count: Math.max(0, n),
          pending: ['server'],
        };
      },
    },
    {
      id: 'pet',
      label: '桌宠角色',
      capabilities: { localRead: false, export: true, install: true, share: true },
      detect() {
        const roles = join(home, 'whale-roles');
        const n = countEntries(roles);
        return {
          available: n > 0,
          path: roles,
          count: Math.max(0, n),
          reason: n > 0 ? '' : '还没有角色包（.dshpet）',
          pending: ['server'],
        };
      },
    },
    {
      id: 'skin',
      label: '主题皮肤',
      capabilities: { localRead: true, export: true, install: false, share: true },
      detect() {
        const storage = join(storages, 'dsh-dream-skin');
        const legacy = join(home, 'dsh-dream-skin.json');
        if (existsSync(storage)) return { available: true, path: storage, count: countEntries(storage) };
        if (fileOk(legacy)) return { available: true, path: legacy, count: 1 };
        return { available: false, reason: '没找到皮肤状态文件', pending: ['server'] };
      },
    },
    {
      id: 'persona',
      label: '人设',
      capabilities: { localRead: true, export: true, install: false, share: true },
      detect() {
        const file = join(storages, 'dsh-persona-dafeiyu', 'personas.json');
        return {
          available: fileOk(file),
          path: file,
          reason: fileOk(file) ? '' : '还没有人设文件',
          pending: ['server'],
        };
      },
    },
    {
      id: 'whale',
      label: '小鲸鱼挂件',
      capabilities: { localRead: true, export: false, install: false, share: false },
      detect() {
        const bubble = join(home, 'whale-bubble-imgs');
        const audio = join(home, 'whale-audio');
        const n = Math.max(0, countEntries(bubble)) + Math.max(0, countEntries(audio));
        return {
          available: n > 0,
          path: bubble,
          count: n,
          reason: n > 0 ? '' : '气泡图/语音目录还是空的',
        };
      },
    },
  ];
}

/**
 * 汇总：内置 + 外部的状态。
 * @returns { version, adapters: [{ id,label,capabilities,status }] }
 */
export function collectAdapters(opts) {
  const builtin = buildBuiltinAdapters(opts);
  const all = [...builtin, ...registered.values()];
  const adapters = all.map((adapter) => {
    let status;
    try {
      status = adapter.detect ? adapter.detect() : { available: false, reason: '没有 detect()' };
    } catch (error) {
      status = { available: false, reason: 'detect 抛错：' + String((error && error.message) || error).slice(0, 120) };
    }
    return {
      id: adapter.id,
      label: adapter.label || adapter.id,
      capabilities: adapter.capabilities || {},
      status,
    };
  });
  return { version: ADAPTER_VERSION, adapters };
}
