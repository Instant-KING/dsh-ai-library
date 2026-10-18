# 插件联动与开放接口（适配器）

资料馆不硬依赖任何插件。它通过**适配器（Adapter）**只读地发现其它插件的素材；
将来的「导出 / 安装 / 共享」等能力由插件自己注册，服务端就绪后再接入。

契约版本：**v1**（`lib/adapters.js` 的 `ADAPTER_VERSION`）。

## 1. 适配器契约

```js
{
  id: 'meme',                       // 唯一标识
  label: '表情包',                   // 中文名
  capabilities: {                   // 能力声明（全部可选）
    localRead: true,                // 已实现：只读索引进资料馆
    export: false,                  // 计划：导出成 pack
    install: false,                 // 计划：写入插件（需用户确认）
    share: false                    // 计划：依赖服务端的共享
  },
  detect() {                        // 只读探测，必须不抛错
    return {
      available: true,
      path: 'C:/Users/xxx/.dsh/whale-roles',
      count: 3,
      reason: '',                   // 不可用时的说明
      pending: ['server']           // 还没实现的能力
    };
  }
}
```

## 2. 内置适配器（v0.3.31）

| id | 插件 | 探测位置 | 能力 |
|---|---|---|---|
| `meme` | dsh-meme（表情包） | `~/.dsh/meme-packs`（用户包）、`<插件>/memes`（内置包）、`~/.dsh/dsh-expression.json` | **已实现：列表 / 启用 / 停用 / 导入 / 删除 / 图片预览** |
| `pet` | dsh-bigfish（桌宠） | `~/.dsh/whale-roles`（`.dshpet` 角色包） | 只读 + 计划导出/安装/共享 |
| `skin` | dsh-dream-skin（皮肤） | `~/.dsh/storages/dsh-dream-skin`、`~/.dsh/dsh-dream-skin.json` | 只读 + 计划导出 |
| `persona` | dsh-persona-dafeiyu（人设） | `~/.dsh/storages/dsh-persona-dafeiyu/personas.json` | 只读 + 计划导出 |
| `whale` | dsh-whale-widget（挂件） | `~/.dsh/whale-bubble-imgs`、`~/.dsh/whale-audio` | 只读 |

> 目前**全部只读**：不写任何插件目录，不做任何自动修改。面板默认页底部会显示它们的状态。

## 3. 别的插件怎么注册

宿主同进程，直接 import：

```js
import { registerAdapter } from 'dsh-ai-library/lib/adapters.js'

registerAdapter({
  id: 'univer',
  label: 'Univer 表格',
  capabilities: { localRead: true },
  detect() {
    return { available: true, path: '...' }
  }
})
```

或者通过全局接口（无需 import）：

```js
globalThis.__AILIB_ADAPTERS__.register({ id, label, detect, capabilities })
globalThis.__AILIB_ADAPTERS__.collect()   // 查当前汇总
```

## 4. 数据出口

`GET /api/ai-library` 的响应里带：

```json
{
  "env": {
    "adapters": {
      "version": 1,
      "adapters": [
        { "id": "meme", "label": "表情包", "capabilities": {}, "status": { "available": false, "reason": "还没配置图集目录" } }
      ]
    }
  }
}
```

### 表情包图集（已实现）

```
GET  /api/ai-library/meme?action=list            列出图集（内置 + 用户）
GET  /api/ai-library/meme?action=images&id=xxx   列出图片（读 index.db）
GET  /api/ai-library/meme?action=image&id=xxx&path=memes/happy/a.png   代理图片
POST /api/ai-library/meme?action=enable          { id, mode: solo|add|remove } → 写 enabledPacks
POST /api/ai-library/meme?action=import          { path }  导入解压好的图集目录（需含 index.db）
POST /api/ai-library/meme?action=remove          { id }    只删用户包
```

面板：左侧「表情包图集」大类 → 选图集 → 主区显示封面/张数/图片网格；
按钮「启用这个图集」= 写 `~/.dsh/dsh-expression.json` 的 `enabledPacks`，表情包插件立即生效。

## 5. 设计约束

- **只读优先**：适配器默认只探测，不改别人数据
- **失败不传染**：`detect()` 抛错只让该适配器显示「不可用」，不影响面板
- **能力显式声明**：没写进 `capabilities` 的能力就是没有，不做隐式调用
- **服务端留白**：`pending: ['server']` 表示这块等共享服务落地再实现

## 6. 后续计划

1. `localRead` 真正落地：把表情包图集 / 宠物角色包 / 皮肤包索引成资料馆条目
2. pack 导出（`.dshpack`）与安装（写入插件目录，需用户二次确认）
3. 服务端：pack index + 共享图集/提示词包
