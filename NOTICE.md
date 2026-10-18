# 第三方组件声明

本插件（`dsh-ai-library`）自身的代码是 MIT。`vendor/` 下打包的第三方组件遵循各自许可，
**不受本插件 MIT 许可覆盖**。

## pdf.js

```
vendor/pdf.min.mjs
vendor/pdf.worker.min.mjs
vendor/cmaps/*
vendor/standard_fonts/*
```

- 来源：<https://github.com/mozilla/pdf.js>，版本 **4.10.38**
- 许可：**Apache License 2.0**
- 说明：为离线可用而随包分发，未作修改。

`vendor/standard_fonts/` 中还包含：

| 文件 | 许可 |
|---|---|
| `LICENSE_FOXIT` | Foxit 字体许可（随 pdf.js 分发） |
| `LICENSE_LIBERATION` | SIL Open Font License 1.1 |

## 依赖的外部服务（不随包分发）

这些是**可选**能力，插件不打包、不内置任何密钥：

| 能力 | 默认地址 | 说明 |
|---|---|---|
| PDF 翻译 | `http://127.0.0.1:11008` | 需要用户自行运行 [PDFMathTranslate](https://github.com/PDFMathTranslate/PDFMathTranslate) |
| 插件市场同步 | `https://api.dshmk.com/` | 默认关闭，需在 `config.json` 里开 `marketEnabled` |
| Office → PDF | 本机 LibreOffice | 需要用户自行安装，路径可配 |

## 不包含的内容

本仓库**不包含**任何用户数据：

- 资料条目内容（`library.js` 里的条目由用户自备）
- `items/` 下的文件
- `.cache/`（市场目录、译文、Office 转换缓存）
- `user-items.json`（编辑器写入的本地记录）
- `config.json`（含用户自己的路径）
