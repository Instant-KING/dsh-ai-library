/**
 * 资料馆的系统提示词片段。
 *
 * 目的：让 AI 在本机产出文件后**主动入库**，而不是等用户来问「刚才那个文件去哪了」。
 * 通过 ctx.inject(['systemPrompt'], …) 注册，不把 systemPrompt 写进顶层 inject
 * （写进去而服务不存在时，整个插件会停在 pending）。
 */

/**
 * 生成提示词正文（纯函数，便于测试）。
 * @param opts.root 数据根目录
 * @param opts.toolsEnabled 是否注册了工具
 * @returns 提示词文本
 */
export function buildLibraryPromptText({ root = '', toolsEnabled = true } = {}) {
  const lines = [
    '## 本机资料馆（ai-library）',
    '',
    '这台机器上有一个本地资料库，数据根：' + (root || '(默认 ~/ai-library)') + '。',
    '它的作用是收纳**本机产生的所有文件**：写的文档、生成的图片、做的 PPT、下载的论文、克隆的仓库。',
    '',
    '行为约定（重要）：',
    '1. 只要你在本机**新建或修改了文件**（md/txt/pdf/png/jpg/pptx/docx/xlsx/代码仓库等），在回话之前把它入库，不要让用户自己去找。',
    '2. 入库方式（按情况选）：',
    '   - 单个文件/目录批量 → `library_import`（origin 用 artifact）',
    '   - 只想收「上次扫描后新增/变化的文件」→ `library_autocapture`',
    '   - 克隆来的仓库 → `library_repo_build`（README + docs 自动建条目）',
    '   - 网页 → `library_save_url`；论文 → `library_paper_add`',
    '3. 先查重：入库前可以 `library_search` 看是否已有同名条目，避免堆重复。',
    '4. 记录信息要够用：标题、一句话摘要、来源（origin）、分组（group）、文件相对路径（files）。',
    '5. 不要把私密内容（密钥、token、`.env`、聊天记录）写进资料馆。',
    '',
    '用户问「刚才那个文件 / 那份报告 / 那个 PPT 在哪」时，先 `library_search`，不要重新扫盘。',
  ];
  if (!toolsEnabled) {
    lines.push('', '（当前 toolsEnabled=false，工具未注册：只能提示用户把文件放进数据根的 items/ 目录。）');
  }
  return lines.join('\n');
}

/** 提示词片段名（稳定，便于以后替换/移除）。 */
export const PROMPT_SECTION_NAME = 'ai-library';

/**
 * 注册系统提示词片段。
 * @param ctx Cordis 上下文
 * @param opts 传给 buildLibraryPromptText 的参数
 * @param opts.root 数据根
 * @param opts.toolsEnabled 工具开关
 * @param opts.order 排序（默认 160，紧跟人设之后）
 */
export function registerLibraryPrompt(ctx, opts = {}) {
  if (!ctx || typeof ctx.inject !== 'function') return false;
  try {
    ctx.inject(['systemPrompt'], (prompted) => {
      try {
        const service = prompted && typeof prompted.get === 'function' ? prompted.get('systemPrompt') : null;
        if (!service || typeof service.section !== 'function') return;
        service.section({
          name: PROMPT_SECTION_NAME,
          order: Number(opts.order) || 160,
          /* 用函数：数据根/开关以后变了，下一个请求立即生效 */
          text: () => buildLibraryPromptText({ root: opts.root, toolsEnabled: opts.toolsEnabled !== false }),
        });
      } catch {
        /* 注册失败不影响插件其它能力 */
      }
    });
    return true;
  } catch {
    return false;
  }
}
