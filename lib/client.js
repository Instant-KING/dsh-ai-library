/* ⚠️ 第一行就是信标：模块被求值就立刻上报，用来区分「client bundle 没被加载」和「加载了但后续崩」 */
try {
	fetch("/api/ai-library/log", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ stage: "bundle-eval", href: String(location.href).slice(0, 120) }),
	}).catch(() => {});
} catch {
	/* 信标失败不影响任何东西 */
}

/* ── 诊断：把注册本身也包起来，load() 抛错也能上报 ── */
function __beacon(stage, extra) {
	try {
		fetch("/api/ai-library/log", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ stage, ...(extra || {}) }),
		}).catch(() => {});
	} catch {
		/* 忽略 */
	}
}

/* ⚠️ 这个 bundle 会被求值不止一次（client-modules 复用缓存 + 文件 rev 变化），
   重复 register 同名模块会抛 duplicate factory registration 并把界面带崩。
   所以用全局标记做幂等，第二次直接跳过。 */
/* 幂等：按「模块 id」记账，而不是一个全局布尔。
   原因：改了包名（ai-library → dsh-ai-library）之后，旧布尔还留着 true，
   新 id 会被直接跳过 → 面板静默消失。按 id 记就能让新 id 正常注册一次。 */
const __AILIB_ID = "dsh-ai-library";
globalThis.__ailibRegisteredIds = globalThis.__ailibRegisteredIds || new Set();
if (globalThis.__ailibRegisteredIds.has(__AILIB_ID)) {
	__beacon("skip-duplicate-registration", { id: __AILIB_ID });
} else {
	globalThis.__ailibRegisteredIds.add(__AILIB_ID);

try {
window.__ModuleLoader__.load({
	id: __AILIB_ID,
	factory: (require) => {
		__beacon("factory-start");
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

﻿		/* ───────────── 渲染进程错误上报 ─────────────
		 * 界面崩了看不到控制台，所以把异常 POST 给宿主落盘。
		 * 宿主那边写 <数据根>/.cache/client.log。 */
		const LOG_ROUTE = "/api/ai-library/log";

		function reportClientError(stage, err) {
			try {
				const payload = {
					stage,
					msg: String((err && (err.message || err.reason || err)) || "unknown").slice(0, 600),
					stack: String((err && (err.stack || (err.reason && err.reason.stack))) || "").slice(0, 1200),
					href: String(location && location.href || "").slice(0, 200),
				};
				fetch(LOG_ROUTE, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) }).catch(() => {});
			} catch {
				/* 上报本身不许再抛 */
			}
		}

		window.addEventListener("error", (e) => reportClientError("window-error", e.error || e.message));
		window.addEventListener("unhandledrejection", (e) => reportClientError("unhandled-rejection", e));

		/* React 的渲染错误只走 console.error，拦下来一起上报 */
		const rawConsoleError = console.error.bind(console);
		console.error = (...args) => {
			try {
				reportClientError("console-error", args.map((a) => (a && a.stack) || String(a)).join(" "));
			} catch {
				/* 忽略 */
			}
			rawConsoleError(...args);
		};

		const React = require("react");
		const h = React.createElement;
		const { useState, useEffect, useMemo, useCallback, useRef } = React;

		const PANEL_ID = "ai.library";
		const PANEL_ORDER = 90;
		const ROUTE = "/api/ai-library";

		const KIND_LABEL = {
			sim: "仿真实验",
			paper: "论文",
			courseware: "课件教案",
			report: "实验报告",
			solution: "题解",
			plugin: "插件",
			prompt: "提示词",
			repo: "GitHub 项目",
			market: "插件市场",
			website: "网站",
			doc: "资料",
			homework: "作业",
			note: "笔记",
		};
		const KIND_ORDER = ["plugin", "prompt", "sim", "paper", "courseware", "report", "solution", "repo", "market", "website", "doc", "homework", "note"];

		const STATUS_LABEL = {
			installed: "已装",
			available: "了解",
			rejected: "不兼容",
			archived: "已弃用",
		};

		/* ────────────────────────── 样式 ────────────────────────── */
		const CSS = `
.ailib-shell{display:flex;height:100%;min-height:0;overflow:hidden;position:relative;isolation:isolate;
  /* 深色底 + 金色径向光晕 */
  color:#f2f0eb;
  background:
    radial-gradient(circle at 78% 10%, rgba(230,193,111,.08), transparent 26%),
    radial-gradient(circle at 18% 86%, rgba(255,240,188,.045), transparent 28%),
    #080909;
  --gold:230 193 111;--gold-line:rgba(230,193,111,.28);--gold-fill:rgba(230,193,111,.1)}
.ailib-shell ::selection{background:rgba(230,193,111,.28)}
/* 极光画布：与 .resource-aurora 同款定位，铺在最底层 */
.ailib-aurora-stage{position:absolute;inset:0;z-index:0;pointer-events:none;overflow:hidden}
/* 静态暖光打底（纯渐变，不模糊不动画） */
.ailib-aurora-box{position:absolute;inset:-22% -8%;z-index:1;pointer-events:none;opacity:.55}
.ailib-aurora{display:block;width:100%!important;height:100%!important}
.ailib-tree,.ailib-main,.ailib-preview{position:relative;z-index:2}

/* 左：分类栏 */
.ailib-tree{flex:0 0 196px;overflow:auto;padding:18px 12px 48px 18px;
  border-right:1px solid rgba(255,255,255,.1);background:rgba(255,255,255,.028);
  transition:flex-basis .3s cubic-bezier(.22,1,.36,1),padding .3s cubic-bezier(.22,1,.36,1),opacity .2s}
.ailib-shell[data-tree="0"] .ailib-tree{flex-basis:0;padding-left:0;padding-right:0;border-right:0;opacity:0;overflow:hidden}
.ailib-tree-top{display:flex;align-items:center;justify-content:space-between;gap:6px;margin:0 0 10px}
.ailib-tree-head{font-size:11px;letter-spacing:.12em;text-transform:uppercase;opacity:.42;margin:0;font-weight:900}
.ailib-tree-toggle{width:20px;height:20px;flex:none;display:inline-flex;align-items:center;justify-content:center;
  border:1px solid rgba(255,255,255,.12);border-radius:6px;background:transparent;color:inherit;
  font-size:11px;line-height:1;cursor:pointer;opacity:.6;padding:0}
.ailib-tree-toggle:hover{opacity:1;border-color:var(--gold-line);color:rgb(var(--gold))}
.ailib-node{display:flex;align-items:center;justify-content:space-between;gap:6px;width:100%;
  border:1px solid transparent;background:transparent;color:inherit;text-align:left;cursor:pointer;font:inherit;
  font-size:13px;padding:7px 10px;border-radius:8px;opacity:.82;
  transition:border-color 180ms ease,background 180ms ease,color 180ms ease,transform 180ms ease,box-shadow 180ms ease}
.ailib-node:hover,.ailib-node[data-on="1"]{
  border-color:var(--gold-line);
  background:linear-gradient(180deg,rgba(230,193,111,.16),rgba(230,193,111,.05));
  backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px);
  color:#fff0bc;opacity:1;
  box-shadow:0 0 22px rgba(230,193,111,.09),inset 0 1px 0 rgba(255,240,188,.14);
  transform:translateX(2px)}
.ailib-node[data-on="1"]{color:#e6c16f;font-weight:650}
.ailib-node b{font-weight:600}
.ailib-node em{font-style:normal;font-size:11px;opacity:.5;font-variant-numeric:tabular-nums}
.ailib-subs{margin:1px 0 8px 10px;padding-left:8px;border-left:1px solid rgba(255,255,255,.08)}
.ailib-bucket{margin-bottom:2px}
.ailib-bucket-row{display:flex;align-items:center;gap:1px}
.ailib-bucket-chev{width:18px;height:18px;flex:none;display:inline-flex;align-items:center;justify-content:center;
  border:0;background:transparent;color:inherit;opacity:.45;cursor:pointer;font-size:12px;line-height:1;padding:0;border-radius:4px}
.ailib-bucket-chev:hover{opacity:1;color:#e6c16f}
.ailib-subs-deep{margin-left:9px;padding-left:6px;border-left:1px solid rgba(255,255,255,.06)}
.ailib-subs-deep .ailib-sub{font-size:11.5px;opacity:.6}
.ailib-sub{display:flex;align-items:center;justify-content:space-between;gap:6px;width:100%;
  border:1px solid transparent;background:transparent;color:inherit;text-align:left;cursor:pointer;font:inherit;
  font-size:12.5px;padding:5px 9px;border-radius:7px;opacity:.68;
  transition:border-color 180ms ease,background 180ms ease,color 180ms ease,transform 180ms ease}
.ailib-sub:hover{border-color:rgba(230,193,111,.18);background:rgba(230,193,111,.06);opacity:1;transform:translateX(2px)}
.ailib-sub[data-on="1"]{border-color:var(--gold-line);
  background:linear-gradient(180deg,rgba(230,193,111,.14),rgba(230,193,111,.04));
  color:#e6c16f;opacity:1;font-weight:600}
.ailib-sub em{font-style:normal;font-size:11px;opacity:.5}

/* 左栏也带 MagicCard 的光标跟随描边光（对应 .workspace-nav-card 包 MagicCard） */
.ailib-node,.ailib-sub{position:relative;overflow:hidden;
  --glow-x:50%;--glow-y:50%;--glow-intensity:0;--glow-radius:150px;--glow-color:230, 193, 111}
.ailib-node > *,.ailib-sub > *{position:relative;z-index:2}
.ailib-node::after,.ailib-sub::after{position:absolute;inset:0;z-index:1;content:"";padding:1px;
  border-radius:inherit;pointer-events:none;
  background:radial-gradient(var(--glow-radius) circle at var(--glow-x) var(--glow-y),
    rgba(var(--glow-color),calc(var(--glow-intensity) * .9)) 0%,
    rgba(var(--glow-color),calc(var(--glow-intensity) * .35)) 36%,transparent 68%);
  -webkit-mask:linear-gradient(#fff 0 0) content-box,linear-gradient(#fff 0 0);
  -webkit-mask-composite:xor;
  mask:linear-gradient(#fff 0 0) content-box,linear-gradient(#fff 0 0);
  mask-composite:exclude}
.ailib-node::before,.ailib-sub::before{position:absolute;inset:0;z-index:0;content:"";pointer-events:none;
  background:radial-gradient(220px circle at var(--glow-x) var(--glow-y),
    rgba(var(--glow-color),calc(var(--glow-intensity) * .16)),transparent 64%)}
.ailib-main{flex:1;min-width:0;overflow:auto;padding:20px 22px 60px}
.ailib-head{display:flex;align-items:baseline;gap:12px;flex-wrap:wrap;margin-bottom:4px}
.ailib-title{font-size:20px;font-weight:660;margin:0;letter-spacing:-.01em}
.ailib-sub2{font-size:12px;opacity:.45}
.ailib-controls{display:flex;gap:9px;align-items:center;margin:14px 0 4px;flex-wrap:wrap}
.ailib-search{flex:1 1 260px;display:flex;align-items:center;gap:9px;height:40px;padding:0 14px;
  border:1px solid rgba(255,255,255,.12);border-radius:9px;background:rgba(255,255,255,.03);
  transition:border-color 180ms ease,box-shadow 180ms ease}
.ailib-search:focus-within{border-color:rgba(230,193,111,.45);box-shadow:0 0 18px rgba(230,193,111,.08)}
.ailib-search input{flex:1;border:0;outline:0;background:transparent;color:inherit;font:inherit;font-size:13.5px}
.ailib-chips{display:flex;gap:5px;flex-wrap:wrap}
.ailib-chip{border:1px solid rgba(255,255,255,.12);background:transparent;color:inherit;
  opacity:.7;border-radius:999px;padding:4px 11px;font:inherit;font-size:12px;cursor:pointer;
  transition:border-color 180ms ease,background 180ms ease,color 180ms ease}
.ailib-chip:hover{opacity:1;border-color:rgba(230,193,111,.42);color:#fff0bc}
.ailib-chip[data-on="1"]{background:rgba(230,193,111,.16);border-color:rgba(230,193,111,.45);color:#fff0bc;opacity:1}
.ailib-chip small{opacity:.6;margin-left:4px}
.ailib-grid{display:grid;gap:14px;margin-top:14px;
  /* 按可用宽度自适应：面板窄了自然变 2 列，不再硬塞 3 列把字挤成竖条 */
  grid-template-columns:repeat(auto-fill,minmax(238px,1fr));
  align-content:start}
/* 卡片：底色 + 光标跟随描边光 */
.ailib-card{position:relative;display:flex;flex-direction:column;gap:7px;padding:13px 14px;cursor:pointer;
  overflow:hidden;border:1px solid rgba(255,255,255,.1);border-radius:13px;
  background:rgba(255,255,255,.032);color:inherit;
  --glow-x:50%;--glow-y:50%;--glow-intensity:0;--glow-radius:260px;--glow-color:230, 193, 111;
  transform-style:preserve-3d;will-change:transform;
  content-visibility:auto;contain-intrinsic-size:auto 210px;
  animation:ailibCardIn .42s ease both;
  transition:transform .12s ease-out,border-color .18s ease,background .18s ease,box-shadow .18s ease}
.ailib-card::after{position:absolute;inset:0;z-index:6;content:"";padding:1px;border-radius:inherit;
  pointer-events:none;opacity:1;
  background:radial-gradient(var(--glow-radius) circle at var(--glow-x) var(--glow-y),
    rgba(var(--glow-color),calc(var(--glow-intensity) * .88)) 0%,
    rgba(var(--glow-color),calc(var(--glow-intensity) * .34)) 34%,transparent 64%);
  -webkit-mask:linear-gradient(#fff 0 0) content-box,linear-gradient(#fff 0 0);
  -webkit-mask-composite:xor;
  mask:linear-gradient(#fff 0 0) content-box,linear-gradient(#fff 0 0);
  mask-composite:exclude}
.ailib-card::before{position:absolute;inset:0;z-index:0;content:"";pointer-events:none;
  background:radial-gradient(360px circle at var(--glow-x) var(--glow-y),
    rgba(var(--glow-color),calc(var(--glow-intensity) * .13)),transparent 62%)}
.ailib-card > *{position:relative;z-index:2}
.ailib-card:hover{border-color:rgba(230,193,111,.4);box-shadow:0 14px 30px rgba(0,0,0,.28)}
.ailib-card:focus-visible{outline:2px solid rgba(230,193,111,.6);outline-offset:2px}
.ailib-card[data-on="1"]{border-color:rgba(230,193,111,.38);
  background:linear-gradient(180deg,rgba(230,193,111,.13),rgba(230,193,111,.04));
  box-shadow:0 0 26px rgba(230,193,111,.08),inset 0 1px 0 rgba(255,240,188,.12)}
.ailib-ripple{position:absolute;z-index:7;border-radius:50%;pointer-events:none;
  background:radial-gradient(circle, rgba(230,193,111,.34) 0%, rgba(230,193,111,.15) 30%, transparent 70%);
  animation:ailibRipple .78s cubic-bezier(.22,1,.36,1) forwards}
@keyframes ailibRipple{from{transform:scale(0);opacity:1}to{transform:scale(1);opacity:0}}
/* 粒子：照 MagicCard 的 magic-particle（4px 金色点 + 光晕，飘移+呼吸） */
.ailib-particle{position:absolute;z-index:8;width:4px;height:4px;border-radius:50%;pointer-events:none;
  background:rgba(230,193,111,1);box-shadow:0 0 8px rgba(230,193,111,.75);
  transition:opacity .3s ease;animation:ailibParticleDrift 2.4s ease-in-out infinite alternate}
@keyframes ailibParticleDrift{
  from{transform:translate3d(0,0,0) scale(1);opacity:1}
  to{transform:translate3d(var(--dx,0px),var(--dy,0px),0) scale(.55);opacity:.24}}
@keyframes ailibCardIn{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:none}}
@keyframes ailibFadeIn{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}
.ailib-card-top{display:flex;justify-content:space-between;align-items:center;gap:8px}
.ailib-src{font-size:10.5px;letter-spacing:.06em;text-transform:uppercase;opacity:.48}
.ailib-badge{font-size:10px;padding:2px 7px;border-radius:999px;white-space:nowrap}
.ailib-badge.installed{background:rgba(31,122,68,.14);color:#1f7a44}
.ailib-badge.available{background:rgba(230,193,111,.12);color:#e6c16f}
.ailib-badge.rejected{background:rgba(179,38,30,.13);color:#b3261e}
.ailib-badge.archived{background:rgba(120,130,130,.14);color:#6d7b7b}
.ailib-icon{width:27px;height:27px;border-radius:7px;display:grid;place-items:center;
  font-size:12px;font-weight:650;background:rgba(230,193,111,.12);color:#e6c16f}
.ailib-card h3{margin:0;font-size:15px;font-weight:640;line-height:1.32;word-break:normal;overflow-wrap:anywhere;
  display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.ailib-card p{margin:0;font-size:13px;line-height:1.55;opacity:.74;
  display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.ailib-meta{display:flex;gap:9px;flex-wrap:wrap;font-size:11.5px;opacity:.55}
.ailib-flows{display:flex;gap:4px;flex-wrap:wrap}
.ailib-flows span{font-size:10px;padding:1px 6px;border-radius:5px;background:rgba(230,193,111,.12);color:#e6c16f}
.ailib-tags{display:flex;gap:4px;flex-wrap:wrap;margin-top:auto}
.ailib-tags small{font-size:10.5px;padding:2px 7px;border-radius:999px;
  border:1px solid rgba(230,193,111,.18);opacity:.7}
.ailib-empty{text-align:center;padding:52px 0;font-size:12.5px;opacity:.5}
.ailib-error{margin-top:16px;padding:11px 13px;border-radius:9px;font-size:12.5px;
  background:rgba(179,38,30,.1);color:#b3261e}
.ailib-preview{flex:0 0 440px;overflow:auto;padding:20px 22px 60px;
  border-left:1px solid rgba(255,255,255,.1);animation:ailibFadeIn .28s ease both}
.ailib-preview-empty{margin-top:38vh;text-align:center;font-size:12.5px;opacity:.4;line-height:1.9}
.ailib-prev-head{display:flex;justify-content:space-between;align-items:flex-start;gap:10px;margin-bottom:10px}
.ailib-eyebrow{margin:0 0 5px;font-size:10px;letter-spacing:.06em;text-transform:uppercase;opacity:.45}
.ailib-prev-head h2{margin:0;font-size:20px;font-weight:680;line-height:1.3;word-break:break-word;letter-spacing:-.01em}
.ailib-prev-body{display:flex;flex-direction:column;gap:14px}
.ailib-lead{margin:0;font-size:13.5px;line-height:1.7;opacity:.84}
.ailib-field{display:flex;flex-direction:column;gap:5px}
.ailib-label{font-size:10.5px;letter-spacing:.06em;text-transform:uppercase;opacity:.48}
.ailib-kv{display:flex;gap:14px;flex-wrap:wrap;font-size:12px;opacity:.75}
.ailib-kv b{font-weight:600;opacity:1}
.ailib-cmd-row{display:flex;gap:7px}
.ailib-cmd{flex:1;margin:0;padding:8px 10px;border-radius:7px;font-size:11px;
  font-family:ui-monospace,Consolas,monospace;white-space:pre-wrap;word-break:break-all;
  background:rgba(120,130,130,.1);border:1px solid rgba(255,255,255,.12)}
.ailib-btn{border:1px solid rgba(255,255,255,.12);background:transparent;color:inherit;
  border-radius:7px;padding:0 10px;font:inherit;font-size:11.5px;cursor:pointer;white-space:nowrap;opacity:.78}
.ailib-btn:hover{opacity:1;border-color:rgba(230,193,111,.45);color:#fff0bc}
.ailib-notes{margin:0;padding-left:16px;font-size:12px;line-height:1.65;opacity:.78}
.ailib-notes li{margin-bottom:5px}
.ailib-link{color:#e6c16f;font-size:12px;word-break:break-all;text-decoration:none}
.ailib-link:hover{text-decoration:underline}
.ailib-media-wrap{height:460px;margin:2px 0 12px;border:1px solid rgba(255,255,255,.12);
  border-radius:10px;background:#0d1212;display:flex;align-items:center;justify-content:center;
  overflow:hidden;padding:8px;flex:0 0 auto}
.ailib-media{max-width:100%;max-height:100%;width:auto;height:auto;object-fit:contain;display:block;border-radius:4px}
.ailib-video-cover{width:100%;height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;
  gap:8px;border:0;background:transparent;color:rgba(242,240,235,.55);cursor:pointer;font:inherit;
  transition:color .18s ease}
.ailib-video-cover:hover{color:#fff0bc}
.ailib-play{width:56px;height:56px;display:grid;place-items:center;border-radius:50%;
  border:1px solid rgba(230,193,111,.45);background:rgba(230,193,111,.1);
  color:#e6c16f;font-size:20px;line-height:1;padding-left:3px;
  transition:transform .18s ease,box-shadow .18s ease,background .18s ease}
.ailib-video-cover:hover .ailib-play{transform:scale(1.08);background:rgba(230,193,111,.18);
  box-shadow:0 0 24px rgba(230,193,111,.25)}
.ailib-video-hint{font-size:12.5px}
.ailib-video-sub{font-size:10.5px;opacity:.55}
.ailib-shell[data-expanded="1"] .ailib-media-wrap{height:calc(100vh - 300px);min-height:420px}
.ailib-frame-wrap{height:300px;margin:2px 0 12px;border:1px solid rgba(255,255,255,.12);
  border-radius:10px;overflow:auto;background:#fff;position:relative;flex:0 0 auto}
.ailib-frame{width:100%;height:100%;border:0;display:block;background:#fff;transform-origin:0 0}
/* pdf.js 查看器 */
.ailib-pdf{display:flex;flex-direction:column;gap:6px;margin:2px 0 12px}
.ailib-pdf-bar{display:flex;align-items:center;gap:4px;flex-wrap:wrap}
.ailib-pdf-page{font-size:10.5px;opacity:.6;font-variant-numeric:tabular-nums;min-width:44px;text-align:center}
.ailib-pdf-spacer{flex:1}
.ailib-pdf-host{height:300px;overflow:auto;border:1px solid rgba(255,255,255,.12);
  border-radius:10px;background:#f2f4f4;display:flex;justify-content:center;padding:12px;position:relative}
.ailib-pdf-canvas{display:block;background:#fff;box-shadow:0 1px 4px rgba(0,0,0,.12);height:auto}
.ailib-shell[data-expanded="1"] .ailib-pdf-host{height:calc(100vh - 320px);min-height:420px}
.ailib-frames-bar{display:flex;justify-content:space-between;align-items:center;gap:8px;margin:0 0 8px}
.ailib-variants{display:flex;gap:4px;flex-wrap:wrap}
.ailib-icon-btn{width:24px;height:24px;display:inline-flex;align-items:center;justify-content:center;
  border:1px solid rgba(255,255,255,.12);background:transparent;color:inherit;
  border-radius:6px;cursor:pointer;opacity:.7;padding:0;flex:none}
.ailib-icon-btn:hover{opacity:1;border-color:rgba(230,193,111,.45);color:#fff0bc}

/* 展开预览：隐藏分类栏与卡片区，预览占满 */
.ailib-shell[data-expanded="1"] .ailib-tree,
.ailib-shell[data-expanded="1"] .ailib-main{display:none}
.ailib-shell[data-expanded="1"] .ailib-preview{flex:1;border-left:0;max-width:none}
.ailib-shell[data-expanded="1"] .ailib-frame-wrap{height:calc(100vh - 280px);min-height:420px}
.ailib-zoom-val{display:none}
.ailib-tr-note{font-size:10.5px;opacity:.55;max-width:46%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
/* 编辑 + 批量 */
.ailib-input{width:100%;box-sizing:border-box;border:1px solid rgba(255,255,255,.12);border-radius:8px;
  background:rgba(255,255,255,.03);color:inherit;font:inherit;font-size:12.5px;padding:7px 9px;
  transition:border-color 160ms ease}
.ailib-input:focus{outline:0;border-color:rgba(230,193,111,.45)}
.ailib-textarea{resize:vertical;line-height:1.5;font-family:inherit}
.ailib-editor-actions{display:flex;gap:8px;margin-top:14px;flex-wrap:wrap}
.ailib-danger{border-color:rgba(179,38,30,.5)!important;color:#e88!important}
.ailib-danger:hover{border-color:#b3261e!important;color:#ff9a92!important}
.ailib-chip-sub{font-size:10.5px;padding:2px 8px;border-radius:999px;border:1px solid rgba(255,255,255,.10);
  background:transparent;color:rgba(255,255,255,.5);cursor:pointer}
.ailib-chip-sub[data-on="1"]{border-color:rgba(230,193,111,.5);background:rgba(230,193,111,.12);color:#f2d791}
.ailib-chip-sub small{margin-left:4px;opacity:.6}
.ailib-conv{margin-bottom:2px}
.ailib-conv-row{display:flex;align-items:center;gap:2px}
.ailib-caret{width:16px;height:22px;flex:none;border:0;background:transparent;color:rgba(255,255,255,.4);
  cursor:pointer;font-size:10px;padding:0;border-radius:4px}
.ailib-caret:hover{color:#f2d791;background:rgba(230,193,111,.1)}
.ailib-sub-conv{flex:1;text-align:left}
.ailib-conv-kids{margin:2px 0 6px 14px;padding-left:8px;border-left:1px dashed rgba(255,255,255,.12)}
.ailib-kid-group{margin-bottom:4px}
.ailib-kid-label{font-size:10px;color:rgba(255,255,255,.32);margin:3px 0 2px}
.ailib-kid{display:flex;align-items:center;gap:6px;width:100%;padding:2px 8px;border-radius:6px;
  border:0;background:transparent;color:rgba(255,255,255,.62);font:inherit;font-size:11px;cursor:pointer;text-align:left}
.ailib-kid:hover{background:rgba(255,255,255,.05);color:#fff}
.ailib-kid[data-on="1"]{background:rgba(230,193,111,.12);color:#f2d791}
.ailib-kid em{margin-left:auto;font-style:normal;font-size:10px;opacity:.55}
.ailib-ask-mask{position:fixed;inset:0;z-index:60;background:rgba(0,0,0,.5);
  display:flex;align-items:center;justify-content:center;padding:24px}
.ailib-ask{width:min(420px,92vw);background:#161513;border:1px solid rgba(255,255,255,.12);border-radius:14px;
  padding:16px 16px 12px;box-shadow:0 18px 50px rgba(0,0,0,.5)}
.ailib-ask-title{font-size:13px;font-weight:600;color:#f2d791;margin-bottom:10px}
.ailib-sub-head{display:block;padding:8px 10px 3px;font-size:10.5px;letter-spacing:.06em;
  color:rgba(255,255,255,.38);text-transform:none}
.ailib-search{max-width:none}
.ailib-search input{height:38px;font-size:14px;padding:0 14px;border-radius:10px}
.ailib-repo{margin-top:14px;padding-top:12px;border-top:1px solid rgba(255,255,255,.08)}
.ailib-repo-shot{display:block;width:100%;border-radius:10px;border:1px solid rgba(255,255,255,.1);background:rgba(255,255,255,.03)}
.ailib-repo-loading{display:flex;align-items:center;justify-content:center;height:120px;font-size:12px;color:rgba(255,255,255,.4)}
.ailib-repo-meta{display:flex;gap:10px;align-items:center;margin-top:8px;font-size:11.5px;color:rgba(255,255,255,.55)}
.ailib-repo-meta b{color:#f2d791;font-weight:600}
.ailib-repo-desc{margin:6px 0 0;font-size:12px;line-height:1.55;color:rgba(255,255,255,.6)}
.ailib-repo-acts{display:flex;gap:8px;margin-top:10px}
.ailib-compat{font-size:10.5px;padding:2px 7px;border-radius:999px;border:1px solid transparent;white-space:nowrap}
.ailib-compat-ok{color:#8fe0a8;border-color:rgba(143,224,168,.35);background:rgba(143,224,168,.10)}
.ailib-compat-warn{color:#f0c36a;border-color:rgba(240,195,106,.4);background:rgba(240,195,106,.10)}
.ailib-compat-unknown{color:rgba(255,255,255,.45);border-color:rgba(255,255,255,.16)}
.ailib-card-head{display:flex;align-items:center;gap:9px;margin-bottom:8px}
.ailib-card-name{font-size:12.5px;font-weight:600;color:rgba(255,255,255,.9);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ailib-card-owner{font-size:10.5px;color:rgba(255,255,255,.42);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ailib-card-meta{display:flex;align-items:center;gap:12px;margin-top:8px;font-size:10.5px;color:rgba(255,255,255,.42)}
.ailib-card-date{margin-left:auto}
.ailib-mini-install{width:auto!important;padding:0 8px!important;border-color:rgba(230,193,111,.45)!important;
  color:#f2d791!important;opacity:.9!important;font-size:10px!important;letter-spacing:.02em}
.ailib-mini-install:hover{background:rgba(230,193,111,.16)!important;opacity:1!important}
.ailib-card-cat{margin-left:auto;font-size:10px;color:rgba(255,255,255,.4);
  border:1px solid rgba(255,255,255,.12);border-radius:999px;padding:1px 8px;white-space:nowrap}
.ailib-card-head{gap:10px;margin-bottom:10px}
.ailib-card-name{font-size:13.5px}
.ailib-card-owner{font-size:11px}
.ailib-card-meta{font-size:11px;margin-top:9px}
.ailib-card-cat{font-size:10.5px}
.ailib-card-cat + *{}
.ailib-paper-mask{position:fixed;inset:0;z-index:60;background:rgba(0,0,0,.55);display:flex;align-items:center;justify-content:center;padding:24px}
.ailib-paper{width:min(880px,100%);max-height:82vh;overflow:auto;border-radius:14px;padding:16px 16px 12px;
  background:#141310;border:1px solid rgba(230,193,111,.22);box-shadow:0 24px 70px rgba(0,0,0,.55)}
.ailib-paper-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:10px}
.ailib-paper-head b{font-size:14px;color:#f2d791}
.ailib-paper-keys{margin-bottom:10px;padding:10px;border:1px dashed rgba(255,255,255,.14);border-radius:10px}
.ailib-paper-srcs{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:10px}
.ailib-paper-src{font-size:11.5px;padding:5px 10px;border-radius:8px;cursor:pointer;
  border:1px solid rgba(255,255,255,.12);background:transparent;color:rgba(255,255,255,.6);transition:all .15s ease}
.ailib-paper-src[data-on="1"]{border-color:rgba(230,193,111,.55);background:rgba(230,193,111,.12);color:#f2d791}
.ailib-paper-src[data-disabled="1"]{opacity:.4;cursor:not-allowed}
.ailib-paper-search{display:flex;gap:8px;margin-bottom:10px}
.ailib-paper-list{display:flex;flex-direction:column;gap:10px}
.ailib-paper-item{padding:10px 12px;border-radius:10px;border:1px solid rgba(255,255,255,.08);background:rgba(255,255,255,.02)}
.ailib-paper-title{font-size:12.5px;line-height:1.5;color:rgba(255,255,255,.86)}
.ailib-paper-meta{margin-top:5px;font-size:11px;color:rgba(255,255,255,.45)}
.ailib-tree-add{margin:10px 6px 4px;width:calc(100% - 12px);padding:7px 8px;border:1px dashed rgba(255,255,255,.18);
  border-radius:8px;background:transparent;color:rgba(255,255,255,.55);font:inherit;font-size:11.5px;cursor:pointer;
  transition:border-color 160ms ease,color 160ms ease}
.ailib-tree-add:hover{border-color:rgba(230,193,111,.5);color:#f2d791}
.ailib-batch{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin:8px 0 2px;padding:8px 11px;
  border:1px solid rgba(230,193,111,.28);border-radius:9px;background:rgba(230,193,111,.08);font-size:12px}
.ailib-card-acts{display:flex;gap:3px;margin-left:auto;margin-right:6px}
.ailib-mini{width:19px;height:19px;display:inline-flex;align-items:center;justify-content:center;
  border:1px solid transparent;border-radius:5px;background:transparent;color:inherit;font-size:10.5px;
  line-height:1;cursor:pointer;opacity:0;padding:0;transition:opacity 160ms ease,border-color 160ms ease}
.ailib-card:hover .ailib-mini{opacity:.65}
.ailib-mini:hover{opacity:1!important;border-color:rgba(230,193,111,.45);color:#fff0bc}
.ailib-card[data-picked="1"]{border-color:rgba(111,193,230,.55);
  background:linear-gradient(180deg,rgba(111,193,230,.12),rgba(111,193,230,.03))}
.ailib-subs .ailib-sub:only-child{position:relative}
.ailib-frame-empty{height:100%;display:flex;align-items:center;justify-content:center;
  text-align:center;font-size:11.5px;line-height:1.7;opacity:.45;padding:0 18px;color:#5a6a6a}
.ailib-frame-note{font-size:10.5px;line-height:1.7;opacity:.5;margin:6px 0 8px;word-break:break-word}
.ailib-frame-note + .ailib-frame-note{margin-top:2px}
@media (max-width:560px){.ailib-card p{display:none}}
@media (max-width:1240px){
  .ailib-grid{grid-template-columns:repeat(2,minmax(0,1fr))}
  /* 三段都在时，先把左树收窄，把宽度让给卡片 */
  .ailib-tree{flex-basis:170px;padding:16px 10px 44px 14px}
  .ailib-preview{flex-basis:340px;padding:16px 14px 48px}
}
@media (max-width:1120px){
  /* 没选中条目时预览区自动收起；选中后展开（避免空预览占 300px） */
  .ailib-shell[data-sel="0"] .ailib-preview{flex-basis:0;padding-left:0;padding-right:0;border-left:0;opacity:0;overflow:hidden}
  .ailib-shell[data-sel="1"] .ailib-preview{flex-basis:300px}
}
@media (max-width:980px){
  .ailib-tree{flex-basis:150px}
  .ailib-shell[data-sel="1"] .ailib-preview{flex-basis:260px;padding:14px 12px 40px}
  .ailib-main{padding:16px 14px 48px}
}
@media (max-width:1080px){.ailib-preview{flex-basis:300px}.ailib-grid{grid-template-columns:repeat(2,minmax(0,1fr))}}
@media (max-width:880px){.ailib-preview{display:none}}
@media (max-width:760px){.ailib-tree{display:none}.ailib-grid{grid-template-columns:1fr}}
`;

		let styleInjected = false;

		function useStyleOnce() {
			useEffect(() => {
				if (styleInjected) return;
				styleInjected = true;
				const el = document.createElement("style");
				el.setAttribute("data-ai-library", "");
				el.textContent = CSS;
				document.head.appendChild(el);
			}, []);
		}

		/* ────────────────────────── 侧栏图标 ────────────────────────── */
		function PanelIcon(props) {
			const size = props.size || 16;
			const color = props.active
				? "#e6c16f"
				: "var(--dsw-alias-label-secondary,#5a6a6a)";
			return h(
				"svg",
				{ width: size, height: size, viewBox: "0 0 16 16", fill: "none", "aria-hidden": "true" },
				h("path", {
					d: "M2.5 3.2h4.1c.5 0 .9.4.9.9v8.7c0-.5-.4-.9-.9-.9H2.5V3.2Z",
					stroke: color,
					strokeWidth: 1.4,
					strokeLinejoin: "round",
				}),
				h("path", {
					d: "M13.5 3.2H9.4c-.5 0-.9.4-.9.9v8.7c0-.5.4-.9.9-.9h4.1V3.2Z",
					stroke: color,
					strokeWidth: 1.4,
					strokeLinejoin: "round",
				}),
			);
		}

		/* ────────────────────────── 小工具 ────────────────────────── */
		function initials(title) {
			const base = String(title || "?").replace(/^@[^/]+\//, "");
			return base.charAt(0).toUpperCase();
		}

		/**
		 * 判断一个预览源该用哪种渲染器。
		 * @param src - 预览地址。
		 * @returns "pdf" | "image" | "video" | "frame"
		 */
		/* ───────────── 迷你语法高亮（不依赖任何库）───────────── */

		/** 关键字表（JS/TS 为主，够用就行）。 */
		const HL_KEYWORDS = new Set(
			('import export from default const let var function return if else for while do switch case break continue ' +
				'class extends new typeof instanceof in of try catch finally throw async await yield delete void ' +
				'null undefined true false this super static get set interface type enum implements readonly public private ' +
				'def self None True False elif lambda pass with as raise').split(' '),
		);

		/**
		 * 把源码切成 {text, cls} 片段。
		 * 规则很土但够用：注释 → 字符串 → 数字 → 关键字 → 标签/属性 → 函数名 → 其他。
		 * @param code 源码文本
		 * @returns 片段数组
		 */
		function tokenizeCode(code) {
			const out = [];
			let i = 0;
			const push = (text, cls) => {
				if (!text) return;
				const last = out[out.length - 1];
				if (last && last.cls === cls) last.text += text;
				else out.push({ text, cls });
			};

			while (i < code.length) {
				const rest = code.slice(i);
				let m;

				/* 行注释 / 块注释 */
				if ((m = /^(\/\/[^\n]*|#[^\n]*|\/\*[\s\S]*?\*\/)/.exec(rest))) {
					push(m[1], 'cmt');
					i += m[1].length;
					continue;
				}
				/* 字符串（含模板串） */
				if ((m = /^('(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`)/.exec(rest))) {
					push(m[1], 'str');
					i += m[1].length;
					continue;
				}
				/* JSX / HTML 标签名 */
				if ((m = /^<\/?[A-Za-z][\w.:-]*/.exec(rest))) {
					push(m[0], 'tag');
					i += m[0].length;
					continue;
				}
				/* 数字 */
				if ((m = /^\b\d+(?:\.\d+)?\b/.exec(rest))) {
					push(m[0], 'num');
					i += m[0].length;
					continue;
				}
				/* 标识符 */
				if ((m = /^[A-Za-z_$][\w$]*/.exec(rest))) {
					const word = m[0];
					const after = rest.slice(word.length).replace(/^\s+/, '');
					const cls = HL_KEYWORDS.has(word) ? 'kw' : after.startsWith('(') ? 'fn' : 'id';
					push(word, cls);
					i += word.length;
					continue;
				}
				/* 其余（标点、空白） */
				push(code[i], 'punct');
				i += 1;
			}
			return out;
		}

		/** 高亮配色。 */
		const HL_STYLE = {
			cmt: { color: '#7c8a72', fontStyle: 'italic' },
			str: { color: '#c3d98a' },
			num: { color: '#d9a86a' },
			kw: { color: '#e6a1c4' },
			tag: { color: '#8fc4e8' },
			fn: { color: '#e6c16f' },
			id: { color: '#e8e6df' },
			punct: { color: '#9a978f' },
		};

		/**
		 * 源码查看器：拉文本 → 高亮 → <pre>。
		 * @param props.src 文件地址
		 */
		function CodeView({ src }) {
			const [text, setText] = React.useState("");
			const [err, setErr] = React.useState("");
			const [copied, setCopied] = React.useState(false);

			React.useEffect(() => {
				if (!src) return;
				let alive = true;
				setText("");
				setErr("");
				fetch(src, { cache: "no-store" })
					.then((r) => (r.ok ? r.text() : Promise.reject(new Error("HTTP " + r.status))))
					.then((t) => alive && setText(t))
					.catch((e) => alive && setErr(String((e && e.message) || e)));
				return () => {
					alive = false;
				};
			}, [src]);

			if (err) return h("div", { className: "ailib-frame-empty" }, "读取失败：" + err);
			if (!text) return h("div", { className: "ailib-frame-empty" }, "读取中…");

			const tokens = tokenizeCode(text);
			return h(
				"div",
				{ style: { position: "relative", height: "100%", background: "#121110", borderRadius: 8, overflow: "hidden" } },
				h(
					"button",
					{
						type: "button",
						onClick: () => {
							navigator.clipboard.writeText(text).then(
								() => {
									setCopied(true);
									setTimeout(() => setCopied(false), 1500);
								},
								() => {},
							);
						},
						style: {
							position: "absolute",
							top: 8,
							right: 10,
							zIndex: 2,
							fontSize: 10.5,
							padding: "3px 9px",
							borderRadius: 6,
							cursor: "pointer",
							border: "1px solid rgba(230,193,111,.4)",
							background: "rgba(20,19,17,.9)",
							color: "#f2d791",
						},
					},
					copied ? "已复制" : "复制",
				),
				h(
					"pre",
					{
						className: "ailib-code",
						style: {
							margin: 0,
							height: "100%",
							overflow: "auto",
							padding: "12px 14px",
							fontSize: 11.5,
							lineHeight: 1.65,
							background: "#121110",
							whiteSpace: "pre",
							tabSize: 2,
							fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
						},
					},
					tokens.map((tk, i) => h("span", { key: i, style: HL_STYLE[tk.cls] || null }, tk.text)),
				),
			);
		}

		/* ───────────── 补充查看器：音频 / 表格 / JSON / 字体 / 压缩包 ───────────── */

		/* ───────────── 3D 模型查看器（three.js，离线走 vendor）───────────── */

		/** three 相关模块只加载一次，缓存在全局。 */
		function loadThree() {
			const g = globalThis;
			if (g.__ailibThreeLib) return g.__ailibThreeLib;
			g.__ailibThreeLib = (async () => {
				const fetchText = async (path) => {
					const r = await fetch(path, { cache: "force-cache" });
					if (!r.ok) throw new Error("加载 " + path + " 失败：" + r.status);
					return r.text();
				};
				const toBlobUrl = (text) => URL.createObjectURL(new Blob([text], { type: "text/javascript" }));

				const threeUrl = toBlobUrl(await fetchText("/api/ai-library/vendor/three/three.module.min.js"));
				/* 把 GLTFLoader / OrbitControls 里的裸导入 'three' 换成 blob 地址（没有 import map 可用） */
				const patch = (src) => src.replace(/from\s+['"]three['"]/g, 'from "' + threeUrl + '"');
				const gltfUrl = toBlobUrl(patch(await fetchText("/api/ai-library/vendor/three/GLTFLoader.js")));
				const orbitUrl = toBlobUrl(patch(await fetchText("/api/ai-library/vendor/three/OrbitControls.js")));

				const THREE = await import(threeUrl);
				const { GLTFLoader } = await import(gltfUrl);
				const { OrbitControls } = await import(orbitUrl);
				return { THREE, GLTFLoader, OrbitControls };
			})();
			return g.__ailibThreeLib;
		}

		/**
		 * GLB / GLTF 查看器：自动居中、可拖拽旋转、滚轮缩放。
		 * @param props.src 模型地址
		 */
		function ModelView({ src }) {
			const hostRef = React.useRef(null);
			const [state, setState] = React.useState("loading");
			const [err, setErr] = React.useState("");

			React.useEffect(() => {
				let disposed = false;
				let renderer = null;
				let raf = 0;
				const host = hostRef.current;
				if (!src || !host) return;

				(async () => {
					try {
						const { THREE, GLTFLoader, OrbitControls } = await loadThree();
						if (disposed) return;

						const width = host.clientWidth || 600;
						const height = host.clientHeight || 420;

						renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
						renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
						renderer.setSize(width, height);
						host.appendChild(renderer.domElement);

						const scene = new THREE.Scene();
						const camera = new THREE.PerspectiveCamera(45, width / height, 0.01, 5000);
						camera.position.set(0, 1.2, 3);

						scene.add(new THREE.AmbientLight(0xffffff, 1.6));
						const key = new THREE.DirectionalLight(0xffffff, 2.2);
						key.position.set(3, 5, 4);
						scene.add(key);
						const fill = new THREE.DirectionalLight(0x88aaff, 0.7);
						fill.position.set(-4, 2, -3);
						scene.add(fill);

						const controls = new OrbitControls(camera, renderer.domElement);
						controls.enableDamping = true;
						controls.dampingFactor = 0.08;

						const loader = new GLTFLoader();
						loader.load(
							src,
							(gltf) => {
								if (disposed) return;
								const object = gltf.scene || gltf.scenes[0];
								const box = new THREE.Box3().setFromObject(object);
								const size = box.getSize(new THREE.Vector3()).length() || 1;
								const center = box.getCenter(new THREE.Vector3());
								object.position.sub(center);
								scene.add(object);
								camera.position.set(0, size * 0.35, size * 1.1);
								camera.near = size / 500;
								camera.far = size * 20;
								camera.updateProjectionMatrix();
								controls.target.set(0, 0, 0);
								controls.update();
								setState("ready");
							},
							undefined,
							(e) => {
								if (!disposed) {
									setErr("模型解析失败：" + String((e && e.message) || e));
									setState("error");
								}
							},
						);

						const tick = () => {
							raf = requestAnimationFrame(tick);
							controls.update();
							if (renderer) renderer.render(scene, camera);
						};
						tick();
					} catch (e) {
						if (!disposed) {
							setErr(String((e && e.message) || e));
							setState("error");
						}
					}
				})();

				return () => {
					disposed = true;
					if (raf) cancelAnimationFrame(raf);
					if (renderer) {
						renderer.dispose();
						const el = renderer.domElement;
						if (el && el.parentNode) el.parentNode.removeChild(el);
					}
				};
			}, [src]);

			return h(
				"div",
				{ style: { position: "relative", width: "100%", height: 420, background: "#16150f", borderRadius: 8, overflow: "hidden" } },
				h("div", { ref: hostRef, style: { width: "100%", height: "100%" } }),
				state === "loading" ? h("div", { className: "ailib-frame-empty" }, "加载模型…") : null,
				state === "error" ? h("div", { className: "ailib-frame-empty" }, err || "无法显示该模型") : null,
				state === "ready" ? h("div", { style: { position: "absolute", left: 10, bottom: 8, fontSize: 10.5, color: "rgba(255,255,255,.4)" } }, "拖拽旋转 · 滚轮缩放") : null,
			);
		}

		/** 音频播放器。 */
		function AudioView({ src }) {
			return h(
				"div",
				{ style: { padding: "28px 20px", width: "100%" } },
				h("div", { style: { fontSize: 11.5, color: "rgba(255,255,255,.45)", marginBottom: 10 } }, decodeURIComponent(String(src).split("/").pop() || "")),
				h("audio", { src, controls: true, style: { width: "100%" } }),
			);
		}

		/**
		 * 表格查看器（csv / tsv）：首行当表头，最多 300 行。
		 * @param props.src 文件地址
		 */
		function TableView({ src }) {
			const [rows, setRows] = React.useState([]);
			const [err, setErr] = React.useState("");
			React.useEffect(() => {
				if (!src) return;
				let alive = true;
				fetch(src, { cache: "no-store" })
					.then((r) => (r.ok ? r.text() : Promise.reject(new Error("HTTP " + r.status))))
					.then((text) => {
						if (!alive) return;
						const sep = /\.tsv/i.test(src) ? "\t" : ",";
						const lines = text.split(/\r?\n/).filter((l) => l.trim());
						const cells = lines.slice(0, 300).map((l) => {
							/* 简易 CSV：支持双引号包裹 */
							const out = [];
							let cur = "";
							let q = false;
							for (let i = 0; i < l.length; i += 1) {
								const c = l[i];
								if (q) {
									if (c === '"' && l[i + 1] === '"') {
										cur += '"';
										i += 1;
									} else if (c === '"') q = false;
									else cur += c;
								} else if (c === '"') q = true;
								else if (c === sep) {
									out.push(cur);
									cur = "";
								} else cur += c;
							}
							out.push(cur);
							return out;
						});
						setRows(cells);
					})
					.catch((e) => alive && setErr(String((e && e.message) || e)));
				return () => {
					alive = false;
				};
			}, [src]);

			if (err) return h("div", { className: "ailib-frame-empty" }, "读取失败：" + err);
			if (!rows.length) return h("div", { className: "ailib-frame-empty" }, "读取中…");
			const head = rows[0];
			return h(
				"div",
				{ style: { overflow: "auto", height: "100%", background: "#121110" } },
				h(
					"table",
					{ style: { borderCollapse: "collapse", fontSize: 11.5, width: "100%", color: "#e8e6df" } },
					h("thead", null, h("tr", null, head.map((c, i) => h("th", {
						key: i,
						style: { position: "sticky", top: 0, background: "#1b1a17", padding: "7px 10px", textAlign: "left", borderBottom: "1px solid rgba(230,193,111,.28)", fontWeight: 600, whiteSpace: "nowrap" },
					}, c)))),
					h("tbody", null, rows.slice(1).map((r, ri) => h("tr", { key: ri },
						r.map((c, ci) => h("td", {
							key: ci,
							style: { padding: "5px 10px", borderBottom: "1px solid rgba(255,255,255,.05)", whiteSpace: "nowrap" },
						}, c)),
					))),
				),
			);
		}

		/**
		 * JSON 树：对象/数组可折叠。
		 * @param props.src 文件地址
		 */
		function JsonView({ src }) {
			const [data, setData] = React.useState(undefined);
			const [err, setErr] = React.useState("");
			React.useEffect(() => {
				if (!src) return;
				let alive = true;
				fetch(src, { cache: "no-store" })
					.then((r) => (r.ok ? r.text() : Promise.reject(new Error("HTTP " + r.status))))
					.then((t) => alive && setData(JSON.parse(t)))
					.catch((e) => alive && setErr(String((e && e.message) || e)));
				return () => {
					alive = false;
				};
			}, [src]);

			const node = (v, key, depth) => {
				const keyEl = key === null ? null : h("span", { style: { color: "#8fc4e8" } }, String(key) + ": ");
				if (v === null) return h("div", { style: { marginLeft: depth * 12 } }, keyEl, h("span", { style: { color: "#d9a86a" } }, "null"));
				if (typeof v !== "object") {
					const color = typeof v === "string" ? "#c3d98a" : typeof v === "number" ? "#d9a86a" : "#e6a1c4";
					return h("div", { style: { marginLeft: depth * 12 } }, keyEl, h("span", { style: { color } }, typeof v === "string" ? JSON.stringify(v) : String(v)));
				}
				const isArr = Array.isArray(v);
				const entries = isArr ? v.map((x, i) => [i, x]) : Object.entries(v);
				return h(
					"details",
					{ style: { marginLeft: depth * 12 }, open: depth < 2 },
					h("summary", { style: { cursor: "pointer", color: "#9a978f" } }, keyEl, (isArr ? "[" : "{") + entries.length + (isArr ? "]" : "}")),
					entries.map(([k, val]) => h("div", { key: String(k) }, node(val, k, 0))),
				);
			};

			if (err) return h("div", { className: "ailib-frame-empty" }, "解析失败：" + err);
			if (data === undefined) return h("div", { className: "ailib-frame-empty" }, "读取中…");
			return h(
				"div",
				{ style: { overflow: "auto", height: "100%", padding: "12px 14px", background: "#121110", fontSize: 11.5, lineHeight: 1.7, color: "#e8e6df" } },
				node(data, null, 0),
			);
		}

		/**
		 * 字体预览：注入 @font-face，可以调字号和样例文字。
		 * @param props.src 字体文件地址
		 */
		function FontView({ src }) {
			const [family] = React.useState(() => "ailibFont_" + Math.random().toString(36).slice(2, 8));
			const [size, setSize] = React.useState(34);
			const [sample, setSample] = React.useState("永远相信美好的事情即将发生 Aa Bb 123");
			const [objectUrl, setObjectUrl] = React.useState("");
			const [err, setErr] = React.useState("");

			React.useEffect(() => {
				if (!src) return;
				let alive = true;
				let url = "";
				fetch(src)
					.then((r) => (r.ok ? r.blob() : Promise.reject(new Error("HTTP " + r.status))))
					.then((b) => {
						if (!alive) return;
						url = URL.createObjectURL(b);
						setObjectUrl(url);
						const style = document.createElement("style");
						style.id = "ailib-font-" + family;
						style.textContent = "@font-face{font-family:" + family + ";src:url(" + url + ");}";
						document.head.appendChild(style);
					})
					.catch((e) => alive && setErr(String((e && e.message) || e)));
				return () => {
					alive = false;
					const style = document.getElementById("ailib-font-" + family);
					if (style) style.remove();
					if (url) URL.revokeObjectURL(url);
				};
			}, [src, family]);

			return h(
				"div",
				{ style: { padding: "14px 16px", background: "#121110", height: "100%", overflow: "auto" } },
				err ? h("div", { style: { fontSize: 12, color: "#e08b8b" } }, err) : null,
				h("div", { style: { display: "flex", gap: 10, alignItems: "center", marginBottom: 12 } },
					h("span", { style: { fontSize: 11, color: "rgba(255,255,255,.4)" } }, "字号"),
					h("input", { type: "range", min: 12, max: 96, value: size, onChange: (e) => setSize(Number(e.target.value)) }),
					h("span", { style: { fontSize: 11, color: "rgba(255,255,255,.5)" } }, size + "px"),
				),
				h("input", {
					className: "ailib-input",
					value: sample,
					onChange: (e) => setSample(e.target.value),
					style: { marginBottom: 14, width: "100%" },
				}),
				h("div", { style: { fontFamily: objectUrl ? "'" + family + "', sans-serif" : "sans-serif", fontSize: size, lineHeight: 1.45, color: "#e8e6df", wordBreak: "break-word" } }, sample),
			);
		}

		/**
		 * 压缩包内容列表（宿主导出）。
		 * @param props.src 文件地址
		 */
		function ArchiveView({ src }) {
			const [entries, setEntries] = React.useState([]);
			const [err, setErr] = React.useState("");
			React.useEffect(() => {
				if (!src) return;
				let alive = true;
				fetch("/api/ai-library/archive?src=" + encodeURIComponent(src), { cache: "no-store" })
					.then((r) => r.json())
					.then((j) => {
						if (!alive) return;
						if (!j || j.ok !== true) throw new Error((j && j.message) || "读取失败");
						setEntries(j.entries || []);
					})
					.catch((e) => alive && setErr(String((e && e.message) || e)));
				return () => {
					alive = false;
				};
			}, [src]);

			if (err) return h("div", { className: "ailib-frame-empty" }, err);
			if (!entries.length) return h("div", { className: "ailib-frame-empty" }, "读取中…");
			return h(
				"div",
				{ style: { overflow: "auto", height: "100%", padding: "10px 14px", background: "#121110", fontSize: 11.5, color: "#cfcdc6" } },
				h("div", { style: { color: "rgba(255,255,255,.4)", marginBottom: 8 } }, entries.length + " 个条目"),
				entries.map((e, i) =>
					h(
						"div",
						{ key: i, style: { display: "flex", gap: 10, padding: "2px 0", borderBottom: "1px solid rgba(255,255,255,.04)" } },
						h("span", { style: { flex: 1, whiteSpace: "pre", overflow: "hidden", textOverflow: "ellipsis" } }, String(e.name)),
						h("span", { style: { color: "rgba(255,255,255,.35)", flex: "none" } }, e.size ? Math.round(e.size / 1024) + " KB" : ""),
					),
				),
			);
		}

		function mediaKind(src) {
			const s = String(src || "");
			if (/variant=(mono|dual)/.test(s) || /\.pdf($|[?#])/i.test(s)) return "pdf";
			if (/\.(png|jpe?g|gif|webp|svg|bmp|avif)($|[?#])/i.test(s)) return "image";
			if (/\.(mp4|webm|mov|m4v)($|[?#])/i.test(s)) return "video";
			if (/\.(mp3|wav|flac|m4a|ogg|aac)($|[?#])/i.test(s)) return "audio";
			if (/\.(csv|tsv)($|[?#])/i.test(s)) return "table";
			if (/\.json($|[?#])/i.test(s)) return "json";
			if (/\.(ttf|otf|woff2?)($|[?#])/i.test(s)) return "font";
			if (/\.(zip|tar|tgz|gz|bz2|xz|7z|rar)($|[?#])/i.test(s)) return "archive";
			if (/\.(glb|gltf)($|[?#])/i.test(s)) return "model";
			/* 代码按文本渲染，别丢给 iframe（会被当文档/触发下载） */
			if (/\.(jsx?|tsx?|mjs|css|scss|less|vue|svelte|py|sh|yml|yaml|toml|ini|xml|csv|log|txt)($|[?#])/i.test(s)) return "code";
			return "frame";
		}

		function matches(item, query) {
			if (!query) return true;
			const hay = [item.title, item.summary, item.source, item.version, item.fit, item.link]
				.concat(item.tags || [], item.tools || [], item.notes || [], item.files || [])
				.join(" ")
				.toLowerCase();
			return hay.indexOf(query) !== -1;
		}

		/* ────────────────────────── 默认页（没选中条目时）────────────────────────── */

		/**
		 * 默认页：不显示「选一张卡片」的空白，而是给几个入口 + 最近条目。
		 * @param props.items 全部条目
		 * @param props.onOpen 打开某条
		 * @param props.onPaper 打开论文检索弹层
		 */
		function HomePanel({ items, onOpen, onPaper, root }) {
			const papers = (items || []).filter((it) => /^(paper|solution|sim)$/.test(it.kind || "")).slice(0, 6);
			const market = (items || []).filter((it) => it.kind === "market").length;
			const total = (items || []).length;

			const stat = (label, value) =>
				h("div", { style: { padding: "10px 12px", borderRadius: 10, border: "1px solid rgba(255,255,255,.08)", background: "rgba(255,255,255,.02)", minWidth: 92 } },
					h("div", { style: { fontSize: 18, fontWeight: 600, color: "#f2d791" } }, String(value)),
					h("div", { style: { fontSize: 11, color: "rgba(255,255,255,.45)", marginTop: 2 } }, label),
				);

			return h(
				"div",
				{ style: { padding: "6px 2px" } },
				h("h2", { style: { margin: "4px 0 6px", fontSize: 18 } }, "资料馆"),
				h("p", { style: { margin: "0 0 16px", fontSize: 12.5, color: "rgba(255,255,255,.5)", lineHeight: 1.7 } },
					"左边选一个分类，或者从这里开始：", h("br"), "论文可以直接搜；本地产物丢进 items/ 再点「刷新」就能看到。",
				),
				h("div", { style: { display: "flex", gap: 8, marginBottom: 18 } },
					h("button", { className: "ailib-btn", type: "button", style: { padding: "8px 16px", fontSize: 12.5, borderColor: "rgba(230,193,111,.55)", color: "#f2d791" }, onClick: onPaper }, "论文检索 →"),
				),
				h("div", { style: { display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 20 } },
					stat("总条目", total),
					stat("论文类", (items || []).filter((it) => /^(paper|solution|sim)$/.test(it.kind || "")).length),
					stat("插件市场", market),
				),
				papers.length
					? h("div", null,
						h("div", { style: { fontSize: 11, letterSpacing: ".06em", textTransform: "uppercase", color: "rgba(255,255,255,.4)", marginBottom: 8 } }, "论文资料 · 最近"),
						papers.map((it) =>
							h("button", {
								key: it.id,
								type: "button",
								onClick: () => onOpen && onOpen(it),
								style: { display: "block", width: "100%", textAlign: "left", padding: "9px 11px", marginBottom: 6, borderRadius: 8, cursor: "pointer", border: "1px solid rgba(255,255,255,.08)", background: "rgba(255,255,255,.02)", color: "rgba(255,255,255,.82)", fontSize: 12 },
							},
								h("div", { style: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, it.title || it.id),
								h("div", { style: { fontSize: 10.5, color: "rgba(255,255,255,.4)", marginTop: 2 } }, [it.source, it.added].filter(Boolean).join(" · ")),
							),
						),
					)
					: null,
				root
					? h("div", { style: { marginTop: 16, paddingTop: 12, borderTop: "1px solid rgba(255,255,255,.07)", fontSize: 10.5, color: "rgba(255,255,255,.35)", wordBreak: "break-all" } }, "数据根：" + root)
					: null,
			);
		}

		/**
		 * 由 items + groups 表算出分类树。
		 * @param items - 全部条目。
		 * @param groups - id -> 子分类 映射表。
		 * @returns [{ kind, label, count, groups: [{ name, count }] }]
		 */
﻿		/* ───────────── 大类（左侧一级栏目）─────────────
		 * 大类不再写死：宿主从 buckets.json 下发，用户可在面板里新增/改名。
		 * 条目归属优先看 item.bucket，没有才回退到 kind 映射（兼容老数据）。
		 */
		/** 即使没有条目也常驻显示的大类（新装用户能看到「论文资料」该往哪放）。 */
		const ALWAYS_VISIBLE_BUCKETS = new Set(["paper"]);

		const FALLBACK_BUCKETS = [
			{ id: "market", label: "插件市场", kinds: ["market", "plugin"] },
			{ id: "local", label: "本地文件", kinds: ["prompt", "courseware", "report", "doc", "note", "homework", "website", "repo"] },
			{ id: "paper", label: "论文资料", kinds: ["paper", "solution", "sim"] },
			{ id: "other", label: "未归类", kinds: [] },
		];

		const BUCKET_ROUTE = "/api/ai-library/bucket";

		/**
		 * 由大类定义算出 kind → bucket 的回退映射。
		 * @param buckets 大类数组
		 * @returns { [kind]: bucketId }
		 */
		function kindBucketMap(buckets) {
			const map = {};
			for (const b of buckets || []) for (const k of b.kinds || []) map[k] = b.id;
			return map;
		}

		/**
		 * 某条数据属于哪个大类。
		 * @param item 条目
		 * @param map kind → bucket 映射
		 * @returns 大类 id
		 */
		function bucketOf(item, map) {
			if (item && item.bucket) return item.bucket;
			return map[item && item.kind] || "other";
		}


		/**
		 * 构建「大盘 → 类别 → 分组」三级树。
		 * @param items - 全部条目。
		 * @param groups - id → 分组名。
		 * @returns 树节点数组。
		 */
				/**
		 * 条目属于哪个「本地对话产物」项目。
		 * @param item 条目
		 * @param groups id → 分组表
		 * @returns 项目名
		 */
		/**
		 * 对话内部的「项目」：用于「按对话 › 按项目」这一层。
		 * 规则：条目自己的 group 与对话名不同就用它；否则从 notes 的来源路径里取父目录名
		 * （例如 E:/javaweb/Web技术与应用/实验二-HTML基础/... → 实验二-HTML基础）。
		 * @returns 项目名，推不出返回空串
		 */
		function subProjectOf(item, groups, convName) {
			const own = (groups && groups[item.id]) || item.group || "";
			if (own && own !== convName) return own;
			const notes = (item && item.notes) || [];
			for (const line of notes) {
				const m = /来源[：:]\s*(.+)$/.exec(String(line));
				if (!m) continue;
				const parts = m[1].replace(/\\/g, "/").split("/").filter(Boolean);
				if (parts.length < 2) continue;
				/* 优先取「实验/作业/单元/week」这类有意义的层，否则退回父目录 */
				const unit = parts.find((seg) => /实验|作业|练习|单元|章节|周次|week|lab|unit|homework|hw\d/i.test(seg));
				if (unit && unit !== convName) return unit;
				for (let k = parts.length - 2; k >= 0; k -= 1) {
					const seg = parts[k];
					if (!seg || seg === convName) continue;
					if (/^[A-Z]:$/i.test(seg) || /^(javaweb|Web技术与应用|users|desktop|documents|downloads)$/i.test(seg)) continue;
					return seg;
				}
			}
			return "";
		}

		function projectOf(item, groups) {
			if (item && item.project) return item.project;
			if (item && item.group) return item.group;
			const g = groups && groups[item && item.id];
			return g || "未分组";
		}

		/**
		 * 文件的格式（pptx / png / pdf / md…）。
		 * @param item 条目
		 * @returns 小写扩展名，推断不出返回 other
		 */
		function formatOf(item) {
			if (item && item.format) return String(item.format).toLowerCase();
			const cands = []
				.concat((item && item.files) || [], ((item && item.preview && item.preview.variants) || []).map((v) => (v && v.src) || ""))
				.filter(Boolean);
			for (const f of cands) {
				const m = /\.([a-z0-9]+)(?:[?#]|$)/i.exec(String(f));
				if (m) return m[1].toLowerCase();
			}
			return "other";
		}

		/**
		 * 条目来源：artifact（对话产物）/ web（网页）/ paper（论文）/ other。
		 * @param item 条目
		 * @returns 来源标识
		 */
		function originOf(item) {
			if (item && item.origin) return item.origin;
			if (item && item.kind === "paper") return "paper";
			if (item && item.kind === "website") return "web";
			return "other";
		}

		/** 两个虚拟大类（视图）的 id。 */
		const VB_ARTIFACTS = "__artifacts";
		const VB_FORMAT = "__format";

		/**
		 * 当前选中的大类 + 分组是否命中该条目。
		 * @param item 条目
		 * @param bucketId 大类 id
		 * @param groupName 分组名
		 * @param bucketMapKind kind → bucket 映射
		 * @param groups id → 分组表
		 * @returns 是否命中
		 */
		function matchSelection(item, bucketId, groupName, bucketMapKind, groups) {
			if (!bucketId) return !groupName || (groups[item.id] || item.group || "未分类") === groupName;
			if (bucketId === VB_ARTIFACTS) {
				if (originOf(item) !== "artifact") return false;
				if (!groupName) return true;
				if (groupName.startsWith("fmt:")) return formatOf(item) === groupName.slice(4);
				if (groupName.startsWith("conv:")) {
					const rest = groupName.slice(5);
					const sep = rest.indexOf("::");
					if (sep >= 0) {
						const conv = rest.slice(0, sep);
						const tail = rest.slice(sep + 2);
						if (projectOf(item, groups) !== conv) return false;
						if (tail.startsWith("fmt:")) return formatOf(item) === tail.slice(4);
						if (tail.startsWith("grp:")) return ((groups && groups[item.id]) || item.group || "未分组") === tail.slice(4);
						return formatOf(item) === tail;
					}
					return projectOf(item, groups) === rest;
				}
				return projectOf(item, groups) === groupName;
			}
			if (bucketOf(item, bucketMapKind) !== bucketId) return false;
			return !groupName || (groups[item.id] || item.group || "未分类") === groupName;
		}

		/**
		 * 统计分组。
		 * @param list 条目数组
		 * @param keyOf 取分组名的函数
		 * @returns [{ name, count }] 按数量降序
		 */
		function groupCount(list, keyOf) {
			const m = new Map();
			for (const it of list) {
				const k = keyOf(it) || "未分类";
				m.set(k, (m.get(k) || 0) + 1);
			}
			return Array.from(m.entries())
				.map(([name, count]) => ({ name, count }))
				.sort((a, b) => b.count - a.count || (a.name < b.name ? -1 : 1));
		}

		function buildTree(items, groups, buckets) {
			const byKind = new Map();
			for (const it of items) {
				let node = byKind.get(it.kind);
				if (!node) {
					node = { kind: it.kind, label: KIND_LABEL[it.kind] || it.kind, count: 0, subs: new Map() };
					byKind.set(it.kind, node);
				}
				node.count += 1;
				const g = (groups && groups[it.id]) || it.group || "未分类";
				node.subs.set(g, (node.subs.get(g) || 0) + 1);
			}

			const activeBuckets = (buckets && buckets.length ? buckets : FALLBACK_BUCKETS);
			const kbm = kindBucketMap(activeBuckets);
			const normal = activeBuckets.map((bucket) => {
				const kinds = KIND_ORDER.filter((k) => byKind.has(k) && bucketOf({ kind: k }, kbm) === bucket.id).map((k) => {
					const node = byKind.get(k);
					return {
						kind: node.kind,
						label: node.label,
						count: node.count,
						groups: Array.from(node.subs.entries())
							.map(([name, count]) => ({ name, count }))
							.sort((a, b) => b.count - a.count || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)),
					};
				});
				return {
					id: bucket.id,
					label: bucket.label,
					order: Number(bucket.order) || 50,
					count: kinds.reduce((sum, k) => sum + k.count, 0),
					kinds,
				};
			}).filter((b) => b.count > 0 || ALWAYS_VISIBLE_BUCKETS.has(b.id));

			/* 「本地对话产物」一个类，内部两段视图：按文件格式 / 按对话 */
			const artifactList = items.filter((it) => originOf(it) === "artifact");
			const byFormat = groupCount(artifactList, (it) => formatOf(it));
			const byConv = groupCount(artifactList, (it) => projectOf(it, groups));
			/* 每个对话下再按类型分一层（md / png / pptx…），避免「对话里所有类型混在一起」 */
			const convFormats = new Map();
			const convProjects = new Map();
			for (const it of artifactList) {
				const conv = projectOf(it, groups);
				const fmt = formatOf(it);
				if (!convFormats.has(conv)) convFormats.set(conv, new Map());
				convFormats.get(conv).set(fmt, (convFormats.get(conv).get(fmt) || 0) + 1);
				const proj = subProjectOf(it, groups, conv);
				if (proj) {
					if (!convProjects.has(conv)) convProjects.set(conv, new Map());
					convProjects.get(conv).set(proj, (convProjects.get(conv).get(proj) || 0) + 1);
				}
			}
			const sections = []
			if (byFormat.length) sections.push({ label: "按文件格式", groups: byFormat.map((g) => ({ ...g, key: "fmt:" + g.name })) })
			if (byConv.length)
				sections.push({
					label: "按对话",
					groups: byConv.map((g) => {
						const toList = (map, prefix) =>
							Array.from(map.entries())
								.map(([name, count]) => ({ name, count, key: "conv:" + g.name + "::" + prefix + ":" + name }))
								.sort((a, b) => b.count - a.count || (a.name < b.name ? -1 : 1));
						return {
							...g,
							key: "conv:" + g.name,
							children: [
								{ label: "按类型", items: toList(convFormats.get(g.name) || new Map(), "fmt") },
								{ label: "按项目", items: toList(convProjects.get(g.name) || new Map(), "grp") },
							].filter((sec) => sec.items.length > 0),
						};
					}),
				});
			const virtual = [
				{ id: VB_ARTIFACTS, label: "本地对话产物", count: artifactList.length, flat: true, sections },
			];
			/* 排序：插件市场第一、本地对话产物第二，其余按 order */
			const RANK = { market: 0, [VB_ARTIFACTS]: 1 };
			const rankOf = (b) => (b.id in RANK ? RANK[b.id] : 100 + (Number(b.order) || 50));
			return virtual.concat(normal).sort((a, b) => rankOf(a) - rankOf(b));
		}

		/* ────────────────────────── 光标跟随光 ────────────────────────── */

		/**
		 * 鼠标进入元素：把光标位置写进 CSS 变量（与 MagicCard 同一套机制）。
		 * @param e - React 鼠标事件。
		 */
		function glowMove(e) {
			const el = e.currentTarget;
			if (!el || !el.style) return;
			const r = el.getBoundingClientRect();
			el.style.setProperty("--glow-x", (((e.clientX - r.left) / r.width) * 100).toFixed(1) + "%");
			el.style.setProperty("--glow-y", (((e.clientY - r.top) / r.height) * 100).toFixed(1) + "%");
			el.style.setProperty("--glow-intensity", "1");
		}

		/**
		 * 鼠标离开元素：淡出光。
		 * @param e - React 鼠标事件。
		 */
		function glowLeave(e) {
			const el = e.currentTarget;
			if (el && el.style) el.style.setProperty("--glow-intensity", "0");
		}

		/* ────────────────────────── 卡片 ────────────────────────── */
		/* ───────────── 卡片头像（GitHub owner）───────────── */

		/**
		 * 从条目里猜 GitHub owner。
		 * @param item 条目
		 * @returns owner 名或空串
		 */
		function ownerOf(item) {
			if (!item) return "";
			const hay = [item.link, item.install, item.source].concat(item.notes || []).join(" ");
			const m = /github\.com\/([\w.-]+)\//i.exec(hay);
			return m ? m[1] : "";
		}

		/**
		 * 头像：fetch → blob（和预览图同一套路，绕开 img 的 CSP）。
		 * @param props.repo owner/name
		 */
		function Avatar({ repo, size }) {
			const [url, setUrl] = React.useState("");
			React.useEffect(() => {
				if (!repo) return;
				let alive = true;
				let objectUrl = "";
				fetch("/api/ai-library/avatar?repo=" + encodeURIComponent(repo))
					.then((r) => (r.ok ? r.blob() : Promise.reject(new Error("HTTP " + r.status))))
					.then((b) => {
						if (!alive) return;
						objectUrl = URL.createObjectURL(b);
						setUrl(objectUrl);
					})
					.catch(() => {});
				return () => {
					alive = false;
					if (objectUrl) URL.revokeObjectURL(objectUrl);
				};
			}, [repo]);
			const px = size || 28;
			return url
				? h("img", { src: url, style: { width: px, height: px, borderRadius: 8, objectFit: "cover", flex: "none" }, alt: repo })
				: h("div", { style: { width: px, height: px, borderRadius: 8, flex: "none", background: "rgba(255,255,255,.08)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 11, color: "rgba(255,255,255,.4)" } }, "D");
		}

		/**
		 * 从备注里抠 meta（★ 21 · fork 4 · issue 3）。
		 * @param item 条目
		 * @returns { stars, forks, issues } 或 null
		 */
		function repoMetaOf(item) {
			const text = (item && (item.notes || []).join(" ")) || "";
			const stars = /★\s*(\d+)/.exec(text);
			const forks = /fork\s*(\d+)/i.exec(text);
			const issues = /issue\s*(\d+)/i.exec(text);
			if (!stars && !forks && !issues) return null;
			return {
				stars: stars ? Number(stars[1]) : null,
				forks: forks ? Number(forks[1]) : null,
				issues: issues ? Number(issues[1]) : null,
			};
		}

		function Card({ item, active, onOpen, onEdit, onDelete, onPick, picked, group }) {
			const tools = (item.tools || []).slice(0, 2);
			const tags = (item.tags || []).slice(0, 3);
			const ref = React.useRef(null);

﻿			/* ── 照抄 MagicCard.tsx：光晕 + 倾斜 ±7° + 磁吸 2.5% + 粒子 + 涟漪 ── */
			const hovered = React.useRef(false);
			const timers = React.useRef([]);

			const killParticles = () => {
				timers.current.forEach((id) => clearTimeout(id));
				timers.current = [];
				const el = ref.current;
				if (!el) return;
				const dots = el.querySelectorAll(".ailib-particle");
				for (let i = 0; i < dots.length; i += 1) {
					const dot = dots[i];
					dot.style.opacity = "0";
					setTimeout(() => dot.remove(), 300);
				}
			};

			const spawnParticles = () => {
				const el = ref.current;
				if (!el) return;
				const r = el.getBoundingClientRect();
				for (let i = 0; i < 3; i += 1) {
					timers.current.push(
						setTimeout(() => {
							if (!hovered.current || !ref.current) return;
							const dot = document.createElement("div");
							dot.className = "ailib-particle";
							dot.style.left = Math.random() * r.width + "px";
							dot.style.top = Math.random() * r.height + "px";
							dot.style.setProperty("--dx", ((Math.random() - 0.5) * 96).toFixed(0) + "px");
							dot.style.setProperty("--dy", ((Math.random() - 0.5) * 96).toFixed(0) + "px");
							dot.style.animationDuration = (2 + Math.random() * 1.4).toFixed(2) + "s";
							ref.current.appendChild(dot);
						}, i * 90),
					);
				}
			};

			const onEnter = () => {
				hovered.current = true;
				spawnParticles();
			};

			const onMove = (e) => {
				const el = ref.current;
				if (!el) return;
				const r = el.getBoundingClientRect();
				const x = e.clientX - r.left;
				const y = e.clientY - r.top;
				const cx = r.width / 2;
				const cy = r.height / 2;
				el.style.setProperty("--glow-x", ((x / r.width) * 100).toFixed(1) + "%");
				el.style.setProperty("--glow-y", ((y / r.height) * 100).toFixed(1) + "%");
				el.style.setProperty("--glow-intensity", "1");
				el.style.transform =
					"perspective(1000px) rotateX(" + (((y - cy) / cy) * -7).toFixed(2) + "deg) rotateY(" +
					(((x - cx) / cx) * 7).toFixed(2) + "deg) translate(" + ((x - cx) * 0.025).toFixed(2) + "px," +
					((y - cy) * 0.025).toFixed(2) + "px)";
			};

			const onLeave = () => {
				hovered.current = false;
				killParticles();
				const el = ref.current;
				if (!el) return;
				el.style.transform = "";
				el.style.setProperty("--glow-intensity", "0");
			};

			const open = (e) => {
				const el = ref.current;
				if (el && e && typeof e.clientX === "number") {
					const r = el.getBoundingClientRect();
					const x = e.clientX - r.left;
					const y = e.clientY - r.top;
					const far = Math.max(
						Math.hypot(x, y),
						Math.hypot(x - r.width, y),
						Math.hypot(x, y - r.height),
						Math.hypot(x - r.width, y - r.height),
					);
					const dot = document.createElement("div");
					dot.className = "ailib-ripple";
					dot.style.width = far * 2 + "px";
					dot.style.height = far * 2 + "px";
					dot.style.left = x - far + "px";
					dot.style.top = y - far + "px";
					el.appendChild(dot);
					setTimeout(() => dot.remove(), 820);
				}
				onOpen(item);
			};

			return h(
				"article",
				{
					ref,
					className: "ailib-card",
					"data-on": active ? "1" : "0",
					"data-picked": picked ? "1" : "0",
					draggable: true,
					onDragStart: (e) => {
						try {
							e.dataTransfer.setData("text/plain", item.id);
							e.dataTransfer.effectAllowed = "move";
						} catch (err) {
							/* 忽略 */
						}
					},
					tabIndex: 0,
					role: "button",
					onMouseEnter: onEnter,
					onMouseMove: onMove,
					onMouseLeave: onLeave,
					onClick: open,
					onKeyDown: (e) => {
						if (e.key === "Enter" || e.key === " ") {
							e.preventDefault();
							onOpen(item);
						}
					},
				},
				h(
					"div",
					{ className: "ailib-card-head" },
					h(Avatar, { repo: ownerOf(item), size: 26 }),
					h(
						"div",
						{ style: { minWidth: 0, flex: 1 } },
						h("div", { className: "ailib-card-name" }, item.title || "(无标题)"),
						h("div", { className: "ailib-card-owner" }, ownerOf(item) || item.source || item.kind || ""),
					),
					group ? h("span", { className: "ailib-card-cat" }, group) : null,
				),
				h(
					"div",
					{ className: "ailib-card-top" },
					h("span", { className: "ailib-src" }, item.source || item.kind || ""),
					h(
						"span",
						{ className: "ailib-card-acts" },
						h(
							"button",
							{
								className: "ailib-mini",
								type: "button",
								title: "多选（也可 Ctrl+点击卡片）",
								onClick: (e) => {
									e.stopPropagation();
									if (onPick) onPick(item.id);
								},
							},
							picked ? "✓" : "＋",
						),
						h(
							"button",
							{
								className: "ailib-mini",
								type: "button",
								title: "编辑",
								onClick: (e) => {
									e.stopPropagation();
									if (onEdit) onEdit(item);
								},
							},
							"✎",
						),
						installTarget(item)
							? h(
									"button",
									{
										className: "ailib-mini",
										type: "button",
										title: "一键安装",
										onClick: (e) => {
											e.stopPropagation();
											installPlugin(item, onEdit ? () => {} : undefined);
										},
									},
									"⤓",
								)
							: null,
						h(
							"button",
							{
								className: "ailib-mini",
								type: "button",
								title: "删除",
								onClick: (e) => {
									e.stopPropagation();
									if (onDelete) onDelete(item);
								},
							},
							"🗑",
						),
					),
					h("span", { className: "ailib-badge " + (item.status || "") }, STATUS_LABEL[item.status] || item.status || ""),
				),
				h("div", { className: "ailib-icon" }, initials(item.title)),
				h("h3", null, item.title),
				h("p", null, item.summary || ""),
				(() => {
					const meta = repoMetaOf(item);
					const date = item.added || "";
					if (!meta && !date) return null;
					return h(
						"div",
						{ className: "ailib-card-meta" },
						meta && meta.stars !== null ? h("span", null, "★ " + meta.stars) : null,
						meta && meta.forks !== null ? h("span", null, "⑂ " + meta.forks) : null,
						meta && meta.issues !== null ? h("span", null, "⊙ " + meta.issues) : null,
						h("span", { className: "ailib-card-date" }, date),
					);
				})(),
				h(
					"div",
					{ className: "ailib-meta" },
					item.version ? h("span", null, "v" + item.version) : null,
					item.fit ? h("span", null, item.fit) : null,
				),
				tools.length ? h("div", { className: "ailib-flows" }, tools.map((t) => h("span", { key: t }, t))) : null,
				tags.length ? h("div", { className: "ailib-tags" }, tags.map((t) => h("small", { key: t }, t))) : null,
			);
		}

﻿		/* ────────────────────────── 极光背景 ──────────────────────────
		 * 与参考实现的 SoftAurora 同一套着色器/参数。
		 * 性能要点：rAF 里只写 uniform + drawArrays；尺寸交给 ResizeObserver。
		 * 绝不能在每帧读 clientWidth —— 那会触发同步重排，正是上一版卡顿的根因。
		 */
		const AURORA_VERT = `
attribute vec2 position;
void main(){ gl_Position = vec4(position, 0.0, 1.0); }
`;

		const AURORA_FRAG = `
precision highp float;
uniform float uTime;
uniform vec3 uResolution;
uniform float uSpeed;
uniform float uScale;
uniform float uBrightness;
uniform vec3 uColor1;
uniform vec3 uColor2;
uniform float uNoiseFreq;
uniform float uNoiseAmp;
uniform float uBandHeight;
uniform float uBandSpread;
uniform float uOctaveDecay;
uniform float uLayerOffset;
uniform float uColorSpeed;
uniform vec2 uOffset;
#define TAU 6.28318
vec3 gradientHash(vec3 p){
  p = vec3(dot(p, vec3(127.1,311.7,234.6)), dot(p, vec3(269.5,183.3,198.3)), dot(p, vec3(169.5,283.3,156.9)));
  vec3 h = fract(sin(p) * 43758.5453123);
  float phi = acos(2.0 * h.x - 1.0);
  float theta = TAU * h.y;
  return vec3(cos(theta) * sin(phi), sin(theta) * cos(phi), cos(phi));
}
float quinticSmooth(float t){ float t2 = t*t; float t3 = t*t2; return 6.0*t3*t2 - 15.0*t2*t2 + 10.0*t3; }
vec3 cosineGradient(float t, vec3 a, vec3 b, vec3 c, vec3 d){ return a + b * cos(TAU * (c * t + d)); }
float perlin3D(float amplitude, float frequency, float px, float py, float pz){
  float x = px * frequency; float y = py * frequency;
  float fx = floor(x); float fy = floor(y); float fz = floor(pz);
  float cx = ceil(x);  float cy = ceil(y);  float cz = ceil(pz);
  vec3 g000 = gradientHash(vec3(fx,fy,fz)); vec3 g100 = gradientHash(vec3(cx,fy,fz));
  vec3 g010 = gradientHash(vec3(fx,cy,fz)); vec3 g110 = gradientHash(vec3(cx,cy,fz));
  vec3 g001 = gradientHash(vec3(fx,fy,cz)); vec3 g101 = gradientHash(vec3(cx,fy,cz));
  vec3 g011 = gradientHash(vec3(fx,cy,cz)); vec3 g111 = gradientHash(vec3(cx,cy,cz));
  float d000 = dot(g000, vec3(x-fx,y-fy,pz-fz)); float d100 = dot(g100, vec3(x-cx,y-fy,pz-fz));
  float d010 = dot(g010, vec3(x-fx,y-cy,pz-fz)); float d110 = dot(g110, vec3(x-cx,y-cy,pz-fz));
  float d001 = dot(g001, vec3(x-fx,y-fy,pz-cz)); float d101 = dot(g101, vec3(x-cx,y-fy,pz-cz));
  float d011 = dot(g011, vec3(x-fx,y-cy,pz-cz)); float d111 = dot(g111, vec3(x-cx,y-cy,pz-cz));
  float sx = quinticSmooth(x-fx); float sy = quinticSmooth(y-fy); float sz = quinticSmooth(pz-fz);
  float lx00 = mix(d000,d100,sx); float lx10 = mix(d010,d110,sx);
  float lx01 = mix(d001,d101,sx); float lx11 = mix(d011,d111,sx);
  float ly0 = mix(lx00,lx10,sy); float ly1 = mix(lx01,lx11,sy);
  return amplitude * mix(ly0, ly1, sz);
}
float auroraGlow(float t){
  vec2 uv = gl_FragCoord.xy / uResolution.y + uOffset;
  float noiseVal = 0.0;
  float freq = uNoiseFreq;
  float amp = uNoiseAmp;
  vec2 samplePos = uv * uScale;
  for (float i = 0.0; i < 3.0; i += 1.0){
    noiseVal += perlin3D(amp, freq, samplePos.x, samplePos.y, t);
    amp *= uOctaveDecay;
    freq *= 2.0;
  }
  float yBand = uv.y * 10.0 - uBandHeight * 10.0;
  return 0.3 * max(exp(uBandSpread * (1.0 - 1.1 * abs(noiseVal + yBand))), 0.0);
}
void main(){
  vec2 uv = gl_FragCoord.xy / uResolution.xy;
  float t = uSpeed * 0.4 * uTime;
  vec3 col = vec3(0.0);
  col += 0.99 * auroraGlow(t) * cosineGradient(uv.x + uTime * uSpeed * 0.2 * uColorSpeed,
    vec3(0.5), vec3(0.5), vec3(1.0), vec3(0.3,0.20,0.20)) * uColor1;
  col += 0.99 * auroraGlow(t + uLayerOffset) * cosineGradient(uv.x + uTime * uSpeed * 0.1 * uColorSpeed,
    vec3(0.5), vec3(0.5), vec3(2.0,1.0,0.0), vec3(0.5,0.20,0.25)) * uColor2;
  col *= uBrightness;
  gl_FragColor = vec4(col, clamp(length(col), 0.0, 1.0));
}
`;

		/**
		 * 极光采样偏移（uv 单位，y 方向 1.0 = 画布高度）。
		 * 正值 = 图案向左/向下移动。想让光带居中就调这两个数。
		 */
		const AURORA_SHIFT = [0.0, 0.22];

		/** 十六进制颜色 → [r,g,b]（0..1）。 */
		function hexToVec3(hex) {
			const h = String(hex).replace("#", "");
			return [parseInt(h.slice(0, 2), 16) / 255, parseInt(h.slice(2, 4), 16) / 255, parseInt(h.slice(4, 6), 16) / 255];
		}

﻿		/** 极光背景：结构/参数照 SoftAurora + .workspace-page-aurora。 */
		function Aurora({ onStatus }) {
			const boxRef = React.useRef(null);
			const canvasRef = React.useRef(null);

			useEffect(() => {
				const canvas = canvasRef.current;
				const box = boxRef.current;
				if (!canvas || !box) return undefined;

				const gl = canvas.getContext("webgl", {
					alpha: true,
					premultipliedAlpha: false,
					antialias: false,
					depth: false,
					stencil: false,
					preserveDrawingBuffer: true,
				});
				if (!gl) {
					globalThis.__AILIB_AURORA__ = { ok: false, reason: "no-webgl" };
					return undefined;
				}
				gl.clearColor(0, 0, 0, 0);

				const compile = (type, code) => {
					const sh = gl.createShader(type);
					gl.shaderSource(sh, code);
					gl.compileShader(sh);
					if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
						globalThis.__AILIB_AURORA__ = { ok: false, reason: "shader: " + String(gl.getShaderInfoLog(sh) || "").slice(0, 120) };
						gl.deleteShader(sh);
						return null;
					}
					return sh;
				};
				const vs = compile(gl.VERTEX_SHADER, AURORA_VERT);
				const fs = compile(gl.FRAGMENT_SHADER, AURORA_FRAG);
				if (!vs || !fs) return undefined;

				const prog = gl.createProgram();
				gl.attachShader(prog, vs);
				gl.attachShader(prog, fs);
				gl.linkProgram(prog);
				if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
					globalThis.__AILIB_AURORA__ = { ok: false, reason: "link" };
					return undefined;
				}
				gl.useProgram(prog);

				const buf = gl.createBuffer();
				gl.bindBuffer(gl.ARRAY_BUFFER, buf);
				gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
				const loc = gl.getAttribLocation(prog, "position");
				gl.enableVertexAttribArray(loc);
				gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);

				const U = (name) => gl.getUniformLocation(prog, name);
				const uni = {
					time: U("uTime"), res: U("uResolution"), speed: U("uSpeed"), scale: U("uScale"),
					bright: U("uBrightness"), c1: U("uColor1"), c2: U("uColor2"), nf: U("uNoiseFreq"),
					na: U("uNoiseAmp"), bh: U("uBandHeight"), bs: U("uBandSpread"), od: U("uOctaveDecay"),
					lo: U("uLayerOffset"), cs: U("uColorSpeed"), off: U("uOffset"),
				};
				/* 参数照 CyberLiteracy.tsx 的 <SoftAurora/> */
				gl.uniform1f(uni.speed, 0.22);
				gl.uniform1f(uni.scale, 1.5);
				gl.uniform1f(uni.bright, 0.58);
				gl.uniform3fv(uni.c1, hexToVec3("#e6c16f"));
				gl.uniform3fv(uni.c2, hexToVec3("#fff0bc"));
				gl.uniform1f(uni.nf, 2.12);
				gl.uniform1f(uni.na, 0.84);
				gl.uniform1f(uni.bh, 0.48);
				gl.uniform1f(uni.bs, 0.82);
				gl.uniform1f(uni.od, 0.16);
				gl.uniform1f(uni.lo, 0.58);
				gl.uniform1f(uni.cs, 0.22);
				gl.uniform2f(uni.off, AURORA_SHIFT[0], AURORA_SHIFT[1]);

				const dpr = Math.min(window.devicePixelRatio || 1, 0.7);
				const applySize = () => {
					const w = Math.max(1, box.offsetWidth);
					const hgt = Math.max(1, box.offsetHeight);
					canvas.width = Math.max(1, Math.floor(w * dpr));
					canvas.height = Math.max(1, Math.floor(hgt * dpr));
					gl.viewport(0, 0, canvas.width, canvas.height);
					gl.uniform3f(uni.res, canvas.width, canvas.height, canvas.width / canvas.height);
				};
				applySize();
				const observer = typeof ResizeObserver !== "undefined" ? new ResizeObserver(applySize) : null;
				if (observer) observer.observe(box);
				window.addEventListener("resize", applySize);

				let raf = 0;
				const start = performance.now();
				const frame = (now) => {
					if (!document.hidden) {
						gl.clear(gl.COLOR_BUFFER_BIT);
						gl.uniform1f(uni.time, (now - start) / 1000);
						gl.drawArrays(gl.TRIANGLES, 0, 3);
					}
					raf = requestAnimationFrame(frame);
				};
				raf = requestAnimationFrame(frame);

				/* 自检：画完读回中心像素，全透明就说明这个环境画不出来，直接隐藏这一层 */
				const check = setTimeout(() => {
					try {
						const px = new Uint8Array(4 * 25);
						const cx = Math.max(0, Math.floor(canvas.width / 2) - 2);
						const cy = Math.max(0, Math.floor(canvas.height / 2) - 2);
						gl.readPixels(cx, cy, 5, 5, gl.RGBA, gl.UNSIGNED_BYTE, px);
						let maxAlpha = 0;
						for (let i = 3; i < px.length; i += 4) maxAlpha = Math.max(maxAlpha, px[i]);
						const status = maxAlpha === 0 ? "blank" : "ok " + canvas.width + "x" + canvas.height;
						globalThis.__AILIB_AURORA__ = { ok: maxAlpha > 0, reason: status };
						if (typeof onStatus === "function") onStatus(status);
					} catch (e) {
						/* readPixels 失败就当正常 */
					}
				}, 900);

				return () => {
					clearTimeout(check);
					cancelAnimationFrame(raf);
					if (observer) observer.disconnect();
					window.removeEventListener("resize", applySize);
					gl.deleteProgram(prog);
					gl.deleteShader(vs);
					gl.deleteShader(fs);
					gl.deleteBuffer(buf);
				};
			}, []);

			return h(
				"div",
				{ className: "ailib-aurora-stage", "aria-hidden": "true" },
				h(
					"div",
					{ className: "ailib-aurora-box", key: "box", ref: boxRef },
					h("canvas", { className: "ailib-aurora", ref: canvasRef }),
				),
			);
		}

		/* ────────────────────────── pdf.js 查看器 ──────────────────────────
		 * pdf.js 由插件自带（vendor/），宿主用 /api/ai-library/vendor/ 提供，
		 * 所以不需要构建、也不依赖任何外网 CDN。
		 */
		const VENDOR_BASE = "/api/ai-library/vendor/";
		let pdfjsPromise = null;

		/**
		 * 取一段 JS 源码文本。
		 * 桌面版的渲染源是 dsh-app://，但宿主把 /api/* 转发给了本地服务，
		 * 所以 fetch 是通的（而 import() 不通）。
		 * @param url - 相对地址。
		 * @returns 源码文本。
		 */
		async function fetchText(url) {
			const res = await fetch(url, { cache: "force-cache" });
			if (!res.ok) throw new Error("GET " + url + " -> HTTP " + res.status);
			return res.text();
		}

		/**
		 * 用 blob URL 导入一段 ESM 源码。
		 * @param code - 模块源码。
		 * @returns 模块命名空间。
		 */
		function importFromText(code) {
			const blob = new Blob([code], { type: "text/javascript" });
			const url = URL.createObjectURL(blob);
			return import(url).finally(function () {
				// 导入完成后即可回收
				setTimeout(function () {
					URL.revokeObjectURL(url);
				}, 0);
			});

		}

		/**
		 * 懒加载 pdf.js 并设定 worker。
		 *
		 * 两种加载路径：
		 *   1. 直接 import(相对地址) —— web profile（http 源）下可行
		 *   2. fetch 文本 → blob → import —— 桌面版（dsh-app 源）必须走这条
		 */
		function loadPdfjs() {
			if (!pdfjsPromise) {
				pdfjsPromise = (async function () {
					let mod;
					try {
						mod = await import(VENDOR_BASE + "pdf.min.mjs");
					} catch (e) {
						mod = await importFromText(await fetchText(VENDOR_BASE + "pdf.min.mjs"));
					}

					// worker：优先用 blob URL；同时把 worker 模块挂到 globalThis，
					// 这样即使 Worker 被 CSP 拦掉，pdf.js 也能退回主线程 fake worker。
					try {
						const workerCode = await fetchText(VENDOR_BASE + "pdf.worker.min.mjs");
						const workerUrl = URL.createObjectURL(new Blob([workerCode], { type: "text/javascript" }));
						mod.GlobalWorkerOptions.workerSrc = workerUrl;
						try {
							const workerMod = await import(workerUrl);
							if (workerMod && workerMod.WorkerMessageHandler) globalThis.pdfjsWorker = workerMod;
						} catch (e) {
							/* 挂不上也没关系，workerSrc 已经设好 */
						}
					} catch (e) {
						/* worker 取不到就只靠主线程 */
					}

					return mod;
				})();
			}
			return pdfjsPromise;
		}

		/**
		 * 用 canvas 渲染 PDF 的一页，带翻页与缩放。
		 * @param props.src - PDF 的 http 地址。
		 */
		function PdfView({ src }) {
			const hostRef = React.useRef(null);
			const canvasRef = React.useRef(null);
			const [doc, setDoc] = useState(null);
			const [page, setPage] = useState(1);
			const [scale, setScale] = useState(1.1);
			const [status, setStatus] = useState("loading");
			const [error, setError] = useState("");
			const [baseWidth, setBaseWidth] = useState(0);

			/* 载入文档 */
			useEffect(() => {
				let cancelled = false;
				let task = null;
				setStatus("loading");
				setError("");
				setDoc(null);
				setPage(1);

				loadPdfjs()
					.then((pdfjs) => {
						if (cancelled) return null;
						task = pdfjs.getDocument({
							url: src,
							cMapUrl: "/api/ai-library/vendor/cmaps/",
							cMapPacked: true,
							standardFontDataUrl: "/api/ai-library/vendor/standard_fonts/",
						});
						return task.promise;
					})
					.then((d) => {
						if (cancelled || !d) return null;
						setDoc(d);
						setStatus("ready");
						return d.getPage(1).then((p) => {
							if (!cancelled) setBaseWidth(p.getViewport({ scale: 1 }).width);
						});
					})
					.catch((e) => {
						if (cancelled) return;
						setError(String((e && e.message) || e));
						setStatus("error");
					});

				return () => {
					cancelled = true;
					try {
						task && task.destroy();
					} catch (e) {
						/* 卸载时销毁失败无所谓 */
					}
				};
			}, [src]);

			/* 渲染当前页 */
			useEffect(() => {
				if (!doc || !canvasRef.current) return;
				let cancelled = false;
				let renderTask = null;

				doc.getPage(page)
					.then((p) => {
						if (cancelled) return null;
						const viewport = p.getViewport({ scale });
						const canvas = canvasRef.current;
						const dpr = window.devicePixelRatio || 1;
						canvas.width = Math.floor(viewport.width * dpr);
						canvas.height = Math.floor(viewport.height * dpr);
						canvas.style.width = Math.floor(viewport.width) + "px";
						canvas.style.height = Math.floor(viewport.height) + "px";
						const ctx = canvas.getContext("2d");
						renderTask = p.render({
							canvasContext: ctx,
							viewport,
							transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : null,
						});
						return renderTask.promise;
					})
					.catch((e) => {
						if (cancelled) return;
						if (e && e.name === "RenderingCancelledException") return;
						setError(String((e && e.message) || e));
					});

				return () => {
					cancelled = true;
					try {
						renderTask && renderTask.cancel();
					} catch (e) {
						/* 忽略 */
					}
				};
			}, [doc, page, scale]);

			const total = doc ? doc.numPages : 0;

			const fitWidth = () => {
				const w = hostRef.current ? hostRef.current.clientWidth - 26 : 0;
				if (w > 0 && baseWidth > 0) setScale(Math.max(0.3, Math.min(4, Math.round((w / baseWidth) * 100) / 100)));
			};

			const bar = h(
				"div",
				{ className: "ailib-pdf-bar" },
				h("button", { className: "ailib-icon-btn", type: "button", title: "上一页", disabled: page <= 1, style: page <= 1 ? { opacity: 0.3 } : null, onClick: () => setPage((p) => Math.max(1, p - 1)) }, "‹"),
				h("span", { className: "ailib-pdf-page" }, page + " / " + (total || "…")),
				h("button", { className: "ailib-icon-btn", type: "button", title: "下一页", disabled: !total || page >= total, style: !total || page >= total ? { opacity: 0.3 } : null, onClick: () => setPage((p) => Math.min(total, p + 1)) }, "›"),
				h("span", { className: "ailib-pdf-spacer" }),
				h("button", { className: "ailib-btn", type: "button", onClick: fitWidth, title: "适应宽度" }, "适宽"),
				h("button", { className: "ailib-icon-btn", type: "button", title: "缩小", onClick: () => setScale((s) => Math.max(0.3, Math.round((s - 0.15) * 100) / 100)) }, "−"),
				h("span", { className: "ailib-pdf-page" }, Math.round(scale * 100) + "%"),
				h("button", { className: "ailib-icon-btn", type: "button", title: "放大", onClick: () => setScale((s) => Math.min(4, Math.round((s + 0.15) * 100) / 100)) }, "+"),
			);

			/* 自建查看器挂了就退回浏览器内置 PDF 视图，别让用户对着空白 */
			if (status === "error") {
				return h(
					"div",
					{ className: "ailib-pdf" },
					h("p", { className: "ailib-frame-note" }, "自建查看器加载失败（" + error + "），已回退到内置 PDF 视图"),
					h(
						"div",
						{ className: "ailib-frame-wrap" },
						h("iframe", { className: "ailib-frame", src, title: "PDF" }),
					),
				);
			}

			return h(
				"div",
				{ className: "ailib-pdf" },
				bar,
				h(
					"div",
					{ className: "ailib-pdf-host", ref: hostRef },
					status === "loading" ? h("div", { className: "ailib-frame-empty" }, "正在加载 PDF…") : null,
					h("canvas", { className: "ailib-pdf-canvas", ref: canvasRef }),
				),
			);
		}

		/* ────────────────────────── 右侧预览 ────────────────────────── */
		/* ───────────── 插件安装 / GitHub 预览 ───────────── */

		const INSTALL_ROUTE = "/api/ai-library/install";
		const REPO_ROUTE = "/api/ai-library/repo";

		/**
		 * 从条目的 install 字段里抠出要装的包名。
		 * @param item 条目
		 * @returns 包名或空串
		 */
		function installTarget(item) {
			const cmd = String((item && item.install) || "");
			const m = /\badd\s+([^\s#]+)/.exec(cmd);
			if (m) return m[1];
			if (item && /^(plugin|market)$/.test(item.kind) && item.title && /^[@\w.-]+$/.test(item.title)) return item.title;
			return "";
		}

		/**
		 * 仓库卡片的补充信息：版本 / 安装命令 / 标签 / 备注 / 链接。
		 * 之前整块替换预览时丢了这些，单独补一个组件。
		 * @param props.item 条目
		 */
		function RepoDetails({ item }) {
			const row = (label, value) =>
				value
					? h(
							"div",
							{ style: { display: "flex", gap: 8, marginTop: 8, fontSize: 11.5, lineHeight: 1.5 } },
							h("span", { style: { color: "rgba(255,255,255,.38)", flex: "none", minWidth: 62 } }, label),
							h("span", { style: { color: "rgba(255,255,255,.72)", wordBreak: "break-all" } }, value),
						)
					: null;

			const tags = (item && item.tags) || [];
			const notes = (item && item.notes) || [];
			return h(
				"div",
				{ style: { marginTop: 14, paddingTop: 12, borderTop: "1px solid rgba(255,255,255,.08)" } },
				row("版本", [item.version, item.fit ? "适配 " + item.fit : ""].filter(Boolean).join(" · ")),
				item.install
					? h(
							"div",
							{ style: { marginTop: 8 } },
							h("div", { style: { fontSize: 11.5, color: "rgba(255,255,255,.38)", marginBottom: 4 } }, "安装命令"),
							h(
								"code",
								{
									style: {
										display: "block",
										padding: "7px 9px",
										borderRadius: 8,
										background: "rgba(255,255,255,.04)",
										border: "1px solid rgba(255,255,255,.09)",
										fontSize: 11,
										wordBreak: "break-all",
										color: "rgba(255,255,255,.78)",
									},
								},
								item.install,
							),
						)
					: null,
				tags.length
					? h(
							"div",
							{ style: { marginTop: 10, display: "flex", flexWrap: "wrap", gap: 6 } },
							tags.slice(0, 8).map((t) =>
								h(
									"span",
									{
										key: t,
										style: {
											fontSize: 10.5,
											padding: "2px 8px",
											borderRadius: 999,
											border: "1px solid rgba(255,255,255,.12)",
											color: "rgba(255,255,255,.55)",
										},
									},
									t,
								),
							),
						)
					: null,
				notes.length
					? h(
							"div",
							{ style: { marginTop: 10 } },
							h("div", { style: { fontSize: 11.5, color: "rgba(255,255,255,.38)", marginBottom: 4 } }, "备注"),
							h(
								"ul",
								{ style: { margin: 0, paddingLeft: 16, fontSize: 11.5, lineHeight: 1.6, color: "rgba(255,255,255,.62)" } },
								notes.slice(0, 8).map((n, i) => h("li", { key: i }, n)),
							),
						)
					: null,
				item.link
					? h(
							"div",
							{ style: { marginTop: 10, fontSize: 11.5 } },
							h("span", { style: { color: "rgba(255,255,255,.38)" } }, "链接  "),
							h("a", { href: item.link, target: "_blank", rel: "noreferrer", style: { color: "#f2d791" } }, item.link),
						)
					: null,
			);
		}

		/**
		 * 一键安装。
		 * @param item 条目
		 * @param onDone 完成回调（用于刷新提示）
		 */
		async function installPlugin(item, onDone) {
			const name = installTarget(item);
			if (!name) {
				window.alert("这条没有可安装的包名（install 字段里没找到）");
				return;
			}
			if (!window.confirm("要安装 " + name + " 吗？\n会执行：dsh plugin --profile desktop add " + name + "\n装完需要重启 DSH 才生效。")) return;
			try {
				const res = await fetch(INSTALL_ROUTE, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ name }),
				});
				const json = await res.json();
				if (!json || json.ok !== true) throw new Error((json && json.message) || "安装失败");
				window.alert("✅ 已安装 " + name + "\n\n" + String(json.output || "").slice(-400) + "\n\n" + (json.note || "") + "\n\n重启 DSH 后生效。");
				if (onDone) onDone();
			} catch (e) {
				window.alert("❌ 安装失败：" + String((e && e.message) || e));
			}
		}

		/**
		 * GitHub 仓库预览：拿描述 / star / 社交预览图。
		 * @param props.item 条目
		 */
		function RepoPreview({ item }) {
			const [info, setInfo] = React.useState(null);
			const [err, setErr] = React.useState("");
			const [compat, setCompat] = React.useState(null);
			const [shotUrl, setShotUrl] = React.useState("");
			const repo = React.useMemo(() => {
				if (!item) return "";
				/* 不只认 link：install 命令、备注、文件路径里都可能带 GitHub 地址 */
				const hay = [item.link, item.install, item.summary, item.source]
					.concat(item.notes || [], item.files || [], ((item.preview && item.preview.variants) || []).map((v) => (v && v.src) || ""))
					.join(" ");
				const m = /github\.com\/([\w.-]+\/[\w.-]+)/i.exec(hay);
				return m ? m[1].replace(/\.git$/, "").replace(/[).,]+$/, "") : "";
			}, [item]);

			React.useEffect(() => {
				if (!repo) return;
				let alive = true;
				fetch(REPO_ROUTE + "?repo=" + encodeURIComponent(repo))
					.then((r) => r.json())
					.then((j) => {
						if (!alive) return;
						if (j && j.ok) setInfo(j);
						else setErr((j && j.message) || "拿不到仓库信息");
					})
					.catch(() => alive && setErr("网络错误"));
				return () => {
					alive = false;
				};
			}, [repo]);

			/* 预览图：渲染进程的 <img> 过不了 CSP，改成 fetch → blob → objectURL */
			React.useEffect(() => {
				if (!repo) return;
				let alive = true;
				let objectUrl = "";
				fetch("/api/ai-library/og?repo=" + encodeURIComponent(repo))
					.then((r) => (r.ok ? r.blob() : Promise.reject(new Error("HTTP " + r.status))))
					.then((blob) => {
						if (!alive) return;
						objectUrl = URL.createObjectURL(blob);
						setShotUrl(objectUrl);
					})
					.catch((e) => {
						if (alive) setErr("预览图加载失败：" + String((e && e.message) || e));
					});
				return () => {
					alive = false;
					if (objectUrl) URL.revokeObjectURL(objectUrl);
				};
			}, [repo]);

			/* 兼容性：顺便查一下这个包和当前 DSH 版本对不对付 */
			React.useEffect(() => {
				const name = installTarget(item);
				if (!name) return;
				let alive = true;
				fetch("/api/ai-library/compat?name=" + encodeURIComponent(name))
					.then((r) => r.json())
					.then((j) => alive && j && j.ok && setCompat(j))
					.catch(() => {});
				return () => {
					alive = false;
				};
			}, [item]);

			if (!repo) return null;
			/* ⚠️ 这里必须内联约束尺寸：图片是按原图大小渲染的，靠类名容易被面板布局撑破 */
			const shotStyle = { display: "block", width: "100%", maxWidth: "100%", height: "auto", maxHeight: 180, objectFit: "cover", borderRadius: 10, border: "1px solid rgba(255,255,255,.1)", background: "rgba(255,255,255,.03)" };
			const wrapStyle = { marginTop: 14, paddingTop: 12, borderTop: "1px solid rgba(255,255,255,.08)", maxWidth: "100%", overflow: "hidden" };

			return h(
				"div",
				{ className: "ailib-repo", style: wrapStyle },
				/* 用 <img> 而不是 iframe：iframe 里图片按原尺寸渲染会带滚动条、看着很小 */
				shotUrl
					? h("img", { className: "ailib-repo-shot", style: { ...shotStyle, maxHeight: "none" }, src: shotUrl, alt: repo })
					: h(
							"div",
							{
								className: "ailib-repo-shot ailib-repo-loading",
								style: { ...shotStyle, height: 150, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 12, color: "rgba(255,255,255,.4)" },
							},
							err || "加载预览图…",
						),
				h(
					"div",
					{ className: "ailib-repo-meta" },
					h("b", null, repo),
					h("span", null, "★ " + (info ? info.stars : "…")),
					info && info.language ? h("span", null, info.language) : null,
					compat
						? h(
								"span",
								{
									className: "ailib-compat ailib-compat-" + compat.verdict,
									title: (compat.reasons || []).join("\n") || "无版本依赖",
								},
								compat.verdict === "ok" ? "兼容 " + compat.dshVersion : compat.verdict === "warn" ? "需注意" : "未知版本",
							)
						: null,
				),
				info && info.description ? h("p", { className: "ailib-repo-desc" }, info.description) : null,
				h(
					"div",
					{ className: "ailib-repo-acts" },
					h("a", { className: "ailib-btn", href: "https://github.com/" + repo, target: "_blank", rel: "noreferrer" }, "打开 GitHub"),
					installTarget(item)
						? h(
								"button",
								{
									className: "ailib-btn ailib-btn-primary",
									type: "button",
									style: { padding: "8px 18px", fontSize: 12.5, fontWeight: 600, borderColor: "rgba(230,193,111,.6)", background: "rgba(230,193,111,.16)", color: "#f2d791" },
									onClick: () => installPlugin(item),
								},
								"一键安装 " + installTarget(item),
							)
						: null,
				),
			);
		}

		function Preview({ item, expanded, onToggleExpand, items, onOpen, onPaper, root }) {
			const [copied, setCopied] = useState(false);
			const [variant, setVariant] = useState(0);
			/* 翻译：额外的变体 + 进度 */
			const [extra, setExtra] = useState([]);
			const [tr, setTr] = useState({ phase: "idle", msg: "" });
			/* 视频默认不加载：点一下才挂 <video> */
			const [videoOn, setVideoOn] = useState(false);
			const [taskId, setTaskId] = useState("");

			useEffect(() => {
				setCopied(false);
				setVariant(0);
				setExtra([]);
				setTr({ phase: "idle", msg: "" });
				setTaskId("");
				setVideoOn(false);
			}, [item && item.id]);

			/* 切换变体时也要复位，避免上一个视频的开关串到这个变体 */
			useEffect(() => {
				setVideoOn(false);
			}, [variant]);

			/* 轮询翻译任务：状态字段原样透传，所以按常见取值判断 */
			useEffect(() => {
				if (!taskId) return undefined;
				let stopped = false;

				const tick = async () => {
					try {
						const res = await fetch("/api/ai-library/translate?task=" + encodeURIComponent(taskId), { cache: "no-store" });
						const json = await res.json();
						if (stopped) return;
						if (!json.ok) throw new Error(json.message || "查询失败");

						const raw = json.raw || {};
						const state = String(raw.state || raw.status || "").toLowerCase();
						const progress = raw.progress != null ? String(raw.progress) : "";

						if (/fail|error|cancel/.test(state)) {
							setTr({ phase: "error", msg: "翻译失败：" + (raw.message || state) });
							setTaskId("");
							return;
						}
						if (/complet|success|done|finish/.test(state)) {
							setExtra([
								{ label: "中文", src: "/api/ai-library/translate?task=" + encodeURIComponent(taskId) + "&variant=mono", pdf: true },
								{ label: "双语", src: "/api/ai-library/translate?task=" + encodeURIComponent(taskId) + "&variant=dual", pdf: true },
							]);
							/* 自动切到「中文」：它排在原有变体之后 */
							const base = item && item.preview && item.preview.variants
								? item.preview.variants.length
								: item && item.files && item.files.length
									? 1
									: item && item.link
										? 1
										: 0;
							setVariant(base);
							setTr({ phase: "done", msg: "翻译完成" });
							setTaskId("");
							return;
						}
						setTr({ phase: "running", msg: "翻译中" + (progress ? " · " + progress : "") + "…" });
					} catch (e) {
						if (stopped) return;
						setTr({ phase: "error", msg: String((e && e.message) || e) });
						setTaskId("");
					}
				};

				tick();
				const timer = setInterval(tick, 3000);
				return () => {
					stopped = true;
					clearInterval(timer);
				};
			}, [taskId]);

			if (!item) {
				return h(
					"aside",
					{ className: "ailib-preview" },
					h(
						"div",
						{ className: "ailib-prev-head" },
						h("div", null, h("p", { className: "ailib-eyebrow" }, "预览")),
						h(
							"button",
							{
								className: "ailib-icon-btn",
								type: "button",
								onClick: onToggleExpand,
								title: expanded ? "收起预览" : "展开预览",
								"aria-label": expanded ? "收起预览" : "展开预览",
							},
							"⤢",
						),
					),
					h(HomePanel, { items: items || [], onOpen, onPaper, root }),
				);
			}

			/* GitHub 仓库条目：只有「没有本地预览」时才整块换成仓库卡片。
			   有 variants 的（比如从仓库建库出来的组件）要正常显示预览框，否则看不到演示图。 */
			const localVariants = (item && item.preview && item.preview.variants) || [];
			const repoHay = [item.link, item.install, item.summary].concat(item.notes || []).join(" ");
			if (!localVariants.length && /github\.com/i.test(repoHay)) {
				return h(
					"aside",
					{ className: "ailib-preview" },
					h(RepoPreview, { item }),
					h(RepoDetails, { item }),
				);
			}

			const copy = () => {
				const text = item.install || "";
				const done = () => {
					setCopied(true);
					setTimeout(() => setCopied(false), 1400);
				};
				if (navigator.clipboard) navigator.clipboard.writeText(text).then(done, done);
				else done();
			};

			const parts = [];

			const kv = [];
			if (item.version) kv.push(h("span", { key: "v" }, "版本 ", h("b", null, item.version)));
			if (item.fit) kv.push(h("span", { key: "f" }, "适配 ", h("b", null, item.fit)));
			if (item.added) kv.push(h("span", { key: "a" }, "收录 ", h("b", null, item.added)));
			if (kv.length) parts.push(h("div", { className: "ailib-kv", key: "kv" }, kv));

			if (item.install) {
				parts.push(
					h(
						"div",
						{ className: "ailib-field", key: "cmd" },
						h("span", { className: "ailib-label" }, "安装命令"),
						h(
							"div",
							{ className: "ailib-cmd-row" },
							h("pre", { className: "ailib-cmd" }, item.install),
							h("button", { className: "ailib-btn", type: "button", onClick: copy }, copied ? "已复制" : "复制"),
						),
					),
				);
			}

			if ((item.tools || []).length) {
				parts.push(
					h(
						"div",
						{ className: "ailib-field", key: "tools" },
						h("span", { className: "ailib-label" }, "注入的能力"),
						h("div", { className: "ailib-flows" }, item.tools.map((t) => h("span", { key: t }, t))),
					),
				);
			}

			if ((item.tags || []).length) {
				parts.push(
					h(
						"div",
						{ className: "ailib-field", key: "tags" },
						h("span", { className: "ailib-label" }, "标签"),
						h("div", { className: "ailib-tags" }, item.tags.map((t) => h("small", { key: t }, t))),
					),
				);
			}

			if ((item.notes || []).length) {
				parts.push(
					h(
						"div",
						{ className: "ailib-field", key: "notes" },
						h("span", { className: "ailib-label" }, "备注 / 踩坑"),
						h("ul", { className: "ailib-notes" }, item.notes.map((n, i) => h("li", { key: i }, n))),
					),
				);
			}

			if ((item.files || []).length) {
				parts.push(
					h(
						"div",
						{ className: "ailib-field", key: "files" },
						h("span", { className: "ailib-label" }, "文件"),
						...item.files.map((f) => h("a", { className: "ailib-link", key: f, href: f, target: "_blank" }, f)),
					),
				);
			}

			if (item.link) {
				const href = /^https?:|^file:|^[A-Za-z]:[\\/]|^\.\.?\//.test(item.link) ? item.link : "https://" + item.link;
				parts.push(
					h(
						"div",
						{ className: "ailib-field", key: "link" },
						h("span", { className: "ailib-label" }, "链接"),
						h("a", { className: "ailib-link", href, target: "_blank", rel: "noreferrer" }, item.link),
					),
				);
			}

			/* ── 内嵌预览源 ──────────────────────────────────────────
			 * 优先用条目自带的 variants（项目解析器/翻译器的产物）：
			 *   原文 PDF / 解析文本 / 中文 / 双语
			 * 没有 variants 才退回 files[0] 或外链。
			 * 外链是否可嵌由对方站点决定 —— GitHub / 知乎 会发 X-Frame-Options，只显示空白。
			 */
			const baseVariants =
				item.preview && Array.isArray(item.preview.variants) && item.preview.variants.length
					? item.preview.variants
					: (item.files || []).length
						? [{ label: "文件", src: item.files[0] }]
						: item.link && /^https?:\/\//i.test(item.link)
							? [{ label: "网页", src: item.link }]
							: [];

			/* 翻译产出的变体接在后面 */
			const variants = baseVariants.concat(extra);
			const currentIndex = Math.min(variant, variants.length - 1);
			const current = variants[currentIndex];

			let frameSrc = null;
			if (current) {
				frameSrc = /^(https?:\/\/|\/api\/)/i.test(current.src)
					? current.src
					: "/api/ai-library/file?name=" + encodeURIComponent(String(current.src).replace(/^items[\\/]/, ""));
			}

			let frameNote = "";
			if (current && /^https?:\/\//i.test(current.src)) {
				frameNote = "外部站点若显示空白 = 对方禁止被内嵌，请点右上角新窗口打开";
			}

			const openHref = frameSrc;
			/* PDF 用自带 pdf.js；图片/视频用原生元素（自适应、可放大）；其余走 iframe */
			/* viewer 字段优先：写 entry 的人可以直接指定用哪种渲染器 */
			/* 判定顺序：条目级 viewer → 变体名（源码/代码）→ 扩展名。
			   变体名优先是为了兜住「路径没后缀 / 后缀被中间层改掉」的情况。 */
			const labelHint = current && /源码|代码|source|code/i.test(String(current.label || "")) && !/\.(mp4|webm|mov)$/i.test(String(current.src || "")) ? "code" : "";
			const media = (item && item.viewer) || labelHint || mediaKind(frameSrc);

			/* 非 PDF 的专用查看器：这里是唯一的派发点，别再在渲染链里散着判断 */
			const specialView =
				media === "code" && frameSrc
					? h(CodeView, { src: frameSrc })
					: media === "audio" && frameSrc
						? h(AudioView, { src: frameSrc })
						: media === "table" && frameSrc
							? h(TableView, { src: frameSrc })
							: media === "json" && frameSrc
								? h(JsonView, { src: frameSrc })
								: media === "font" && frameSrc
									? h(FontView, { src: frameSrc })
									: media === "archive" && frameSrc
										? h(ArchiveView, { src: frameSrc })
										: media === "model" && frameSrc
											? h(ModelView, { src: frameSrc })
											: null;
			const isPdf = media === "pdf";

			/* 只有本地 PDF 才给翻译按钮（译文服务只吃本地文件） */
			const canTranslate = isPdf && current && !/^https?:\/\//i.test(current.src) && !/variant=/.test(String(current.src));
			const busy = tr.phase === "submitting" || tr.phase === "running";

			const startTranslate = async () => {
				if (!current || busy) return;
				setTr({ phase: "submitting", msg: "正在提交…" });
				try {
					const res = await fetch("/api/ai-library/translate", {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({ src: current.src }),
					});
					const json = await res.json();
					if (!json.ok) throw new Error(json.message || "提交失败");
					setTr({ phase: "running", msg: "已提交，排队中…" });
					setTaskId(json.taskId);
				} catch (e) {
					setTr({ phase: "error", msg: String((e && e.message) || e) });
				}
			};

			const toolbar = frameSrc
				? h(
						"div",
						{ className: "ailib-frames-bar" },
						h(
							"div",
							{ className: "ailib-variants" },
							variants.length > 1
								? variants.map((v, i) =>
										h(
											"button",
											{
												key: v.label + i,
												type: "button",
												className: "ailib-chip",
												"data-on": i === Math.min(variant, variants.length - 1) ? "1" : "0",
												onClick: () => setVariant(i),
											},
											v.label,
										),
									)
								: null,
							canTranslate
								? h(
										"button",
										{
											className: "ailib-chip",
											type: "button",
											disabled: busy,
											title: "用本地 PDFMathTranslate 生成中文 / 双语 PDF",
											style: busy ? { opacity: 0.6 } : null,
											onClick: startTranslate,
										},
										busy ? "翻译中…" : "译中文",
									)
								: null,
						),
						tr.phase !== "idle" && tr.msg
							? h(
									"span",
									{
										className: "ailib-tr-note",
										style: tr.phase === "error" ? { color: "#b3261e" } : null,
										title: tr.msg,
									},
									tr.msg,
								)
							: null,
					)
				: null;

			/* 展开 / 收起：lucide maximize2 ↔ minimize2 的等价内联 SVG */
			const expandIcon = expanded
				? h(
						"svg",
						{ width: 15, height: 15, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round" },
						h("polyline", { points: "4 14 10 14 10 20" }),
						h("polyline", { points: "20 10 14 10 14 4" }),
						h("line", { x1: 14, y1: 10, x2: 21, y2: 3 }),
						h("line", { x1: 3, y1: 21, x2: 10, y2: 14 }),
					)
				: h(
						"svg",
						{ width: 15, height: 15, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round" },
						h("polyline", { points: "15 3 21 3 21 9" }),
						h("polyline", { points: "9 21 3 21 3 15" }),
						h("line", { x1: 21, y1: 3, x2: 14, y2: 10 }),
						h("line", { x1: 3, y1: 21, x2: 10, y2: 14 }),
					);

			const expandBtn = h(
				"button",
				{
					className: "ailib-icon-btn",
					type: "button",
					onClick: onToggleExpand,
					title: expanded ? "收起预览" : "展开预览",
					"aria-label": expanded ? "收起预览" : "展开预览",
				},
				expandIcon,
			);

			return h(
				"aside",
				{ className: "ailib-preview" },
					/* GitHub 仓库预览：放在预览面板最上面 */
					item &&
					/github\.com/i.test(
						[item.link, item.install, item.summary]
							.concat(item.notes || [], item.files || [])
							.join(" "),
					)
						? h(RepoPreview, { item })
						: null,
				h(
					"div",
					{ className: "ailib-prev-head" },
					h(
						"div",
						null,
						h("p", { className: "ailib-eyebrow" }, (KIND_LABEL[item.kind] || item.kind || "") + " · " + (item.source || "")),
						h("h2", null, item.title),
					),
					h(
						"div",
						{ style: { display: "flex", gap: "6px", alignItems: "center", flex: "none" } },
						h("span", { className: "ailib-badge " + (item.status || "") }, STATUS_LABEL[item.status] || item.status || ""),
						openHref
							? h(
									"a",
									{
										className: "ailib-btn",
										href: openHref,
										target: "_blank",
										rel: "noreferrer",
										title: "在新窗口打开",
										style: { textDecoration: "none", display: "inline-flex", alignItems: "center", height: "22px" },
									},
									"↗",
								)
							: null,
						expandBtn,
					),
				),
				toolbar,
				/* 多图画廊：同一条件里有多张图时，点缩略图切换 */
				media === "image" && variants.filter((v) => mediaKind(v.src || "") === "image").length > 1
					? h(
							"div",
							{ style: { display: "flex", gap: 6, marginBottom: 8, flexWrap: "wrap" } },
							variants.map((v, i) =>
								mediaKind(v.src || "") === "image"
									? h("img", {
											key: i,
											src: /^(https?:|\/api\/)/i.test(v.src) ? v.src : "/api/ai-library/file?name=" + encodeURIComponent(String(v.src).replace(/^items[\\/]/, "")),
											alt: v.label,
											onClick: () => setVariant(i),
											style: {
												width: 60,
												height: 42,
												objectFit: "cover",
												borderRadius: 6,
												cursor: "pointer",
												border: i === currentIndex ? "1px solid rgba(230,193,111,.85)" : "1px solid rgba(255,255,255,.12)",
												opacity: i === currentIndex ? 1 : 0.6,
											},
										})
									: null,
							),
						)
					: null,
				isPdf && frameSrc
					? h(PdfView, { src: frameSrc })
					: /* 专用查看器：必须排在 video 之前，否则「点过演示视频后 videoOn=true」会把源码也当视频播 */
						specialView
						? h(
								"div",
								{
									className: "ailib-media-wrap",
									style: { display: "block", height: "auto", minHeight: 360, padding: 0, background: "#121110", overflow: "hidden" },
								},
								specialView,
							)
						: media !== "frame" && frameSrc
						? h(
								"div",
								{ className: "ailib-media-wrap" },
								media === "image"
									? h("img", { className: "ailib-media", src: frameSrc, alt: item.title, loading: "lazy", decoding: "async" })
									: media === "video" && videoOn
										? h("video", { className: "ailib-media", src: frameSrc, controls: true, autoPlay: true, playsInline: true })
										: h(
												"button",
												{
													className: "ailib-video-cover",
													type: "button",
													onClick: () => setVideoOn(true),
													title: "点击加载视频（约几 MB，不点不下载）",
												},
												h("span", { className: "ailib-play" }, "▶"),
												h("span", { className: "ailib-video-hint" }, "点击加载视频"),
												h("span", { className: "ailib-video-sub" }, "不点不下载"),
											),
							)
						: h(
								"div",
								{ className: "ailib-frame-wrap" },
								frameSrc
									? media === "code"
										? h(CodeView, { src: frameSrc })
										: h("iframe", {
												className: "ailib-frame",
												src: frameSrc,
												title: item.title,
												loading: "lazy",
											})
									: h(
											"div",
											{ className: "ailib-frame-empty" },
											item.files ? "该文件类型不支持内嵌" : "没有可内嵌的文件或网址",
											h("br"),
											"详情见下方",
										),
						),
				frameNote ? h("p", { className: "ailib-frame-note" }, frameNote) : null,
				h("div", { className: "ailib-prev-body" }, h("p", { className: "ailib-lead" }, item.summary || ""), ...parts),
			);
		}

		/* ────────────────────────── 主面板 ────────────────────────── */
		function LibraryPanel() {
			useStyleOnce();
			const [state, setState] = useState({ phase: "loading", data: null, error: "" });
			const [query, setQuery] = useState("");
			const [bucket, setBucket] = useState("");
			const bucketMap = useMemo(() => {
				const list = (state && state.data && state.data.buckets) || [];
				return kindBucketMap(list.length ? list : FALLBACK_BUCKETS);
			}, [state]);
			const [openBuckets, setOpenBuckets] = useState({});
			const [limit, setLimit] = useState(60);
			const [kind, setKind] = useState("all");
			const [group, setGroup] = useState("");
			const [openConvs, setOpenConvs] = useState({});
			/* window.prompt 在 Electron 渲染进程里不存在，用自建输入弹窗代替 */
			const [askBox, setAskBox] = useState(null);
			const [status, setStatus] = useState("all");
			const [selected, setSelected] = useState(null);
			const [editor, setEditor] = useState(null);
			const [editBusy, setEditBusy] = useState(false);
			const [editError, setEditError] = useState("");
			const [picked, setPicked] = useState([]);
			const [paperOpen, setPaperOpen] = useState(false);
			const [expanded, setExpanded] = useState(false);
			const [treeOpen, setTreeOpen] = useState(true);
			const [auroraStatus, setAuroraStatus] = useState("");
			const [marketPhase, setMarketPhase] = useState("idle");
			const [updatePhase, setUpdatePhase] = useState("idle");
			const [updateNote, setUpdateNote] = useState("");
			const [marketNote, setMarketNote] = useState("");

			const load = useCallback(() => {
				setState({ phase: "loading", data: null, error: "" });
				fetch(ROUTE, { cache: "no-store" })
					.then((r) => r.json())
					.then((json) => {
						if (!json || json.ok !== true) throw new Error((json && json.message) || "加载失败");
						setState({ phase: "ready", data: json, error: "" });
					})
					.catch((err) => setState({ phase: "error", data: null, error: String((err && err.message) || err) }));
			}, []);

			useEffect(() => {
				load();
			}, [load]);

			/* 从插件市场拉目录：宿主侧走系统代理，拉完写 market-items.js，再重载数据 */
			const syncMarket = useCallback(() => {
				setMarketPhase("running");
				setMarketNote("正在从 api.dshmk.com 拉目录（可能需要几秒）…");
				fetch("/api/ai-library/market", { method: "POST", cache: "no-store" })
					.then((r) => r.json())
					.then((json) => {
						if (!json || json.ok !== true) throw new Error((json && json.message) || "同步失败");
						setMarketNote("已同步：" + json.total + " 个仓库，收录 " + json.kept + " 条");
						setMarketPhase("done");
						load();
					})
					.catch((err) => {
						setMarketNote("同步失败：" + String((err && err.message) || err));
						setMarketPhase("error");
					});
			}, [load]);

			/* 自更新：本地 git 目录走 pull，npm 安装则重装最新版 */
			const updateSelf = useCallback(() => {
				setUpdatePhase("running");
				setUpdateNote("正在检查更新…");
				fetch("/api/ai-library/update", { method: "POST", cache: "no-store" })
					.then((r) => r.json())
					.then((json) => {
						if (!json || json.ok !== true) throw new Error((json && json.message) || "更新失败");
						setUpdateNote(json.note || "已更新");
						setUpdatePhase(json.changed === false ? "done" : "done");
						if (json.changed) {
							/* 有新提交：提示重启，不自动刷新（client 代码可能变了） */
							setTimeout(() => window.alert("资料馆已更新到 " + json.after + "\n请重启 DSH 生效"), 300);
						}
					})
					.catch((err) => {
						setUpdateNote("更新失败：" + String((err && err.message) || err));
						setUpdatePhase("error");
					});
			}, []);

			const items = (state.data && state.data.items) || [];
			/* 市场为空时自动同步一次（新装用户不用手动点「同步市场」） */
			const autoMarketRef = React.useRef(false);
			React.useEffect(() => {
				if (autoMarketRef.current) return;
				/* 必须等首屏真的加载完；空库也要能触发（新装用户就是空库） */
				if (state.phase !== "ready") return;
				const marketCount = items.filter((it) => it.kind === "market").length;
				if (marketCount > 0) {
					autoMarketRef.current = true;
					return;
				}
				autoMarketRef.current = true;
				setMarketNote("首次使用，正在自动同步插件市场…");
				setMarketPhase("running");
				fetch("/api/ai-library/market", { method: "POST", cache: "no-store" })
					.then((r) => r.json())
					.then((json) => {
						if (!json || json.ok !== true) throw new Error((json && json.message) || "同步失败");
						setMarketNote("已自动同步：" + json.total + " 个仓库，收录 " + json.kept + " 条");
						setMarketPhase("done");
						load();
					})
					.catch((err) => {
						setMarketNote("自动同步失败（可手动点「同步市场」）：" + String((err && err.message) || err));
						setMarketPhase("error");
					});
			}, [state.phase, items.length]);
			const groups = (state.data && state.data.groups) || {};
			const buckets = (state.data && state.data.buckets) || [];
			const env = (state.data && state.data.env) || null;
			const updated = (state.data && state.data.updated) || "";

			const tree = useMemo(() => buildTree(items, groups, buckets), [items, groups, buckets]);

			const statusCounts = useMemo(() => {
				const out = {};
				for (const it of items) {
					if (!matchSelection(it, bucket, "", bucketMap, groups)) continue;
					if (kind !== "all" && it.kind !== kind) continue;
					if (group && (groups[it.id] || it.group || "未分类") !== group) continue;
					out[it.status] = (out[it.status] || 0) + 1;
				}
				return out;
			}, [items, groups, bucket, kind, group]);

			const visible = useMemo(() => {
				const q = query.trim().toLowerCase();
				return items.filter(
					(it) =>
						matchSelection(it, bucket, group, bucketMap, groups) &&
						(kind === "all" || it.kind === kind) &&
						(status === "all" || it.status === status) &&
						matches(it, q),
				);
			}, [items, groups, bucket, kind, group, status, query]);


﻿			/* 条件变化时回到首屏，避免残留大批已渲染卡片 */
			useEffect(() => {
				setLimit(60);
			}, [bucket, kind, group, status, query]);

			/* 逐帧追加，和外部提示词库的 renderProgressive(BATCH=60) 同一思路 */
			useEffect(() => {
				if (limit >= visible.length) return undefined;
				const raf = requestAnimationFrame(() => setLimit((cur) => Math.min(visible.length, cur + 60)));
				return () => cancelAnimationFrame(raf);
			}, [limit, visible.length]);

﻿			/* ── 编辑器与批量操作 ── */

			/**
			 * 打开编辑器。
			 * @param item 条目（新建时传空对象）
			 * @param isNew 是否新建
			 */
			function openEditor(item, isNew) {
				setEditError("");
				setEditor({ isNew: !!isNew, draft: itemToDraft(item || {}, groups[(item || {}).id]) });
			}

			/** 保存当前草稿。 */
			async function saveEditor() {
				if (!editor) return;
				setEditBusy(true);
				setEditError("");
				try {
					const original = editor.isNew ? null : (items.find((x) => x.id === editor.draft.id) || null);
					const payload = draftToItem(editor.draft, original);
					if (!payload.title) throw new Error("标题不能为空");
					await callItemRoute(editor.isNew ? "POST" : "PATCH", editor.isNew ? payload : { id: payload.id, patch: payload });
					setEditor(null);
					load();
				} catch (e) {
					setEditError(String((e && e.message) || e));
				} finally {
					setEditBusy(false);
				}
			}

			/**
			 * 删除一条（手写条目会被隐藏而非删除源文件）。
			 * @param item 条目
			 */
			async function removeItem(item) {
				if (!item) return;
				if (!window.confirm("确定删除「" + (item.title || item.id) + "」？\n（手写条目只会被隐藏，不会改 library.js）")) return;
				try {
					await callItemRoute("DELETE", { id: item.id });
					if (selected && selected.id === item.id) setSelected(null);
					if (editor && editor.draft.id === item.id) setEditor(null);
					setPicked((prev) => prev.filter((x) => x !== item.id));
					load();
				} catch (e) {
					window.alert("删除失败：" + String((e && e.message) || e));
				}
			}

			/**
			 * 切换多选。
			 * @param id 条目 id
			 */
			function togglePick(id) {
				setPicked((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
			}

			/**
			 * 把一条拖到某个分组。
			 * @param id 条目 id
			 * @param groupName 目标分组（空串 = 取消分组）
			 */
			/** 新建一个大类（左侧一级栏目）。 */
			/**
			 * 面板内文字输入（替代 window.prompt）。
			 * @param title 标题
			 * @param hint 占位提示
			 * @returns Promise<string|null> 取消返回 null
			 */
			const askText = (title, hint) =>
				new Promise((resolve) => setAskBox({ title, hint: hint || "", value: "", resolve }));

			async function addBucket() {
				const name = await askText("新增大类", "左侧一级栏目，例如：本学期 / 游戏项目 / 求职材料");
				if (!name || !name.trim()) return;
				try {
					const res = await fetch(BUCKET_ROUTE, {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({ label: name.trim() }),
					});
					const json = await res.json();
					if (!json || json.ok !== true) throw new Error((json && json.message) || "创建失败");
					load();
				} catch (e) {
					window.alert("新增大类失败：" + String((e && e.message) || e));
				}
			}

			/**
			 * 把条目拖进某个大类。
			 * @param id 条目 id
			 * @param bucketId 大类 id
			 */
			async function moveToBucket(id, bucketId) {
				try {
					await callItemRoute("PATCH", { id, patch: { bucket: bucketId } });
					load();
				} catch (e) {
					window.alert("移动失败：" + String((e && e.message) || e));
				}
			}

			async function moveToGroup(id, groupName) {
				try {
					await callItemRoute("PATCH", { id, patch: { group: groupName } });
					load();
				} catch (e) {
					window.alert("移动失败：" + String((e && e.message) || e));
				}
			}

			/** 批量改分组。 */
			async function batchGroup() {
				if (!picked.length) return;
				const name = await askText("批量改分组", "把这 " + picked.length + " 条移到哪个分组？（留空 = 未分类）");
				if (name === null) return;
				try {
					for (const id of picked) await callItemRoute("PATCH", { id, patch: { group: name.trim() } });
					setPicked([]);
					load();
				} catch (e) {
					window.alert("批量改分组失败：" + String((e && e.message) || e));
				}
			}

			/** 批量加标签。 */
			async function batchTag() {
				if (!picked.length) return;
				const name = await askText("批量加标签", "给这 " + picked.length + " 条加什么标签？");
				if (!name || !name.trim()) return;
				try {
					for (const id of picked) {
						const cur = items.find((x) => x.id === id);
						const tags = Array.from(new Set([...((cur && cur.tags) || []), name.trim()]));
						await callItemRoute("PATCH", { id, patch: { tags } });
					}
					setPicked([]);
					load();
				} catch (e) {
					window.alert("批量加标签失败：" + String((e && e.message) || e));
				}
			}

			/** 批量删除。 */
			async function batchDelete() {
				if (!picked.length) return;
				if (!window.confirm("删除选中的 " + picked.length + " 条？")) return;
				try {
					for (const id of picked) await callItemRoute("DELETE", { id });
					setPicked([]);
					if (selected && picked.includes(selected.id)) setSelected(null);
					load();
				} catch (e) {
					window.alert("批量删除失败：" + String((e && e.message) || e));
				}
			}

			const treeEl = h(
				"aside",
				{ className: "ailib-tree" },
				h(
					"div",
					{ className: "ailib-tree-top" },
					h("p", { className: "ailib-tree-head" }, "分类"),
					h(
						"button",
						{
							className: "ailib-tree-toggle",
							type: "button",
							title: "收起分类栏",
							"aria-label": "收起分类栏",
							onClick: () => setTreeOpen(false),
						},
						"«",
					),
				),
				h(
					"button",
					{
						className: "ailib-node",
						type: "button",
						"data-on": bucket === "" && kind === "all" ? "1" : "0",
						onMouseMove: glowMove,
						onMouseLeave: glowLeave,
						onClick: () => {
							setBucket("");
							setKind("all");
							setGroup("");
						},
					},
					h("b", null, "全部"),
					h("em", null, items.length),
				),
				tree.map((b) =>
					h(
						"div",
						{ key: b.id, className: "ailib-bucket" },
						h(
							"div",
							{ className: "ailib-bucket-row" },
							h(
								"button",
								{
									className: "ailib-bucket-chev",
									type: "button",
									title: openBuckets[b.id] === false ? "展开" : "收起",
									onClick: () => setOpenBuckets((prev) => ({ ...prev, [b.id]: prev[b.id] === false })),
								},
								openBuckets[b.id] === false ? "›" : "⌄",
							),
							h(
								"button",
								{
									className: "ailib-node",
									type: "button",
									"data-on": bucket === b.id && kind === "all" ? "1" : "0",
									onDragOver: (e) => {
										e.preventDefault();
										e.dataTransfer.dropEffect = "move";
									},
									onDrop: (e) => {
										e.preventDefault();
										const id = e.dataTransfer.getData("text/plain");
										if (id) moveToBucket(id, b.id);
									},
									onMouseMove: glowMove,
									onMouseLeave: glowLeave,
									onClick: () => {
										setBucket(b.id);
										setKind("all");
										setGroup("");
									},
								},
								h("b", null, b.label),
								h("em", null, b.count),
							),
						),
						openBuckets[b.id] === false
							? null
							: b.flat
								? h("div", { className: "ailib-subs" }, renderSections(b))
								: h(
									"div",
									{ className: "ailib-subs" },
									b.kinds.map((node) =>
										h(
											"div",
											{ key: node.kind },
											h(
												"button",
												{
													className: "ailib-sub",
													type: "button",
													"data-on": kind === node.kind && !group ? "1" : "0",
													onDragOver: (e) => {
														e.preventDefault();
													},
													onDrop: (e) => {
														e.preventDefault();
														const id = e.dataTransfer.getData("text/plain");
														if (id) moveToGroup(id, "");
													},
													onMouseMove: glowMove,
													onMouseLeave: glowLeave,
													onClick: () => {
														setBucket(b.id);
														setKind(node.kind);
														setGroup("");
													},
												},
												h("span", null, node.label),
												h("em", null, node.count),
											),
											node.groups.length > 1
												? h(
														"div",
														{ className: "ailib-subs ailib-subs-deep" },
														node.groups.map((g) =>
															h(
																"button",
																{
																	key: g.name,
																	className: "ailib-sub",
																	type: "button",
																	"data-on": kind === node.kind && group === g.name ? "1" : "0",
																	onDragOver: (e) => {
																		e.preventDefault();
																		e.dataTransfer.dropEffect = "move";
																	},
																	onDrop: (e) => {
																		e.preventDefault();
																		const id = e.dataTransfer.getData("text/plain");
																		if (id) moveToGroup(id, g.name);
																	},
																	onMouseMove: glowMove,
																	onMouseLeave: glowLeave,
																	onClick: () => {
																		setBucket(b.id);
																		setKind(node.kind);
																		setGroup(g.name);
																	},
																},
																h("span", null, g.name),
																h("em", null, g.count),
															),
														),
													)
												: null,
										),
									),
								),
					),
				),
				h(
					"button",
					{
						className: "ailib-tree-add",
						type: "button",
						title: "新增大类（左侧一级栏目）",
						onClick: addBucket,
					},
					"＋ 新增大类",
				),
			);

			const statusChips = [{ id: "all", label: "全部状态", count: null }].concat(
				Object.keys(STATUS_LABEL)
					.filter((s) => statusCounts[s])
					.map((s) => ({ id: s, label: STATUS_LABEL[s], count: statusCounts[s] })),
			);

			let body;
			if (state.phase === "loading") body = h("div", { className: "ailib-empty" }, "正在读取资料库…");
			else if (state.phase === "error") body = h("div", { className: "ailib-error" }, "读取失败：" + state.error);
			else if (visible.length === 0)
				body =
					bucket === "paper"
						? h(
								"div",
								{ className: "ailib-empty" },
								h("div", null, "论文资料还是空的"),
								h(
									"div",
									{ style: { marginTop: 10 } },
									h(
										"button",
										{
											className: "ailib-btn",
											type: "button",
											style: { padding: "8px 16px", fontSize: 12.5, borderColor: "rgba(230,193,111,.4)", color: "#f2d791" },
											onClick: () => setPaperOpen(true),
										},
										"搜论文",
									),
								),
								h("div", { style: { marginTop: 8, fontSize: 11.5, opacity: 0.6 } }, "十个源免 key 直连；Sciverse 可配 token"),
							)
						: h("div", { className: "ailib-empty" }, "没有匹配的条目");
			else
				body = h(
					"div",
					{ className: "ailib-grid" },
					visible.slice(0, limit).map((it) =>
						h(Card, {
							key: it.id,
							item: it,
							active: selected && selected.id === it.id,
							picked: picked.includes(it.id),
							group: (groups && groups[it.id]) || (it && it.group) || "",
							onOpen: (target) => {
								setSelected(target);
							},
							onEdit: (target) => openEditor(target, false),
							onDelete: (target) => removeItem(target),
							onPick: (id) => togglePick(id),
						}),
					),
				);

			const main = h(
				"section",
				{ className: "ailib-main" },
				h(
					"div",
					{ className: "ailib-head" },
					treeOpen
						? null
						: h(
								"button",
								{
									className: "ailib-tree-toggle",
									type: "button",
									title: "展开分类栏",
									"aria-label": "展开分类栏",
									onClick: () => setTreeOpen(true),
								},
								"»",
							),
					h("h1", { className: "ailib-title" }, "AI 图书馆", h("span", { style: { fontSize: 10, marginLeft: 8, color: "rgba(230,193,111,.75)", fontWeight: 400, verticalAlign: "middle" } }, "v3")),
					h(
						"span",
						{ className: "ailib-sub2" },
						(env
							? "DSH " + (env.dsh || "?") + " · " + (env.profile || "?") + (updated ? " · 更新 " + updated : "")
							: updated) + " · 极光 " + (auroraStatus || "…"),
					),
				),
				h(
					"div",
					{ className: "ailib-controls" },
					h(
						"label",
						{ className: "ailib-search" },
						h(
							"svg",
							{ width: 13, height: 13, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, opacity: 0.45 },
							h("circle", { cx: 11, cy: 11, r: 7 }),
							h("path", { d: "m20 20-3.5-3.5" }),
						),
						h("input", {
							type: "search",
							value: query,
							placeholder: "搜名称、功能、标签、工具、踩坑…",
							onChange: (e) => setQuery(e.target.value),
						}),
					),
					h(
						"div",
						{ className: "ailib-chips" },
						statusChips.map((c) =>
							h(
								"button",
								{
									key: c.id,
									type: "button",
									className: "ailib-chip",
									"data-on": status === c.id ? "1" : "0",
									onClick: () => setStatus(c.id),
								},
								c.label,
								c.count == null ? null : h("small", null, c.count),
							),
						),
					),
					h(
						"button",
						{
							className: "ailib-btn",
							type: "button",
							title: "新建一条（写进 user-items.json）",
							onClick: () => openEditor({}, true),
						},
						"＋ 新建",
					),
					h("button", { className: "ailib-btn", type: "button", onClick: load, title: "重新读取 library.js" }, "刷新"),
					h(
						"button",
						{
							className: "ailib-btn",
							type: "button",
							disabled: updatePhase === "running",
							style: updatePhase === "running" ? { opacity: 0.5 } : null,
							title: "检查并更新资料馆插件本身（本地 git pull / npm 重装）",
							onClick: updateSelf,
						},
						updatePhase === "running" ? "更新中…" : "更新",
					),
					h(
						"button",
						{
							className: "ailib-btn",
							type: "button",
							title: "按平台检索论文并入库",
							onClick: () => setPaperOpen(true),
						},
						"论文检索",
					),
					h(
						"button",
						{
							className: "ailib-btn",
							type: "button",
							disabled: marketPhase === "running",
							style: marketPhase === "running" ? { opacity: 0.5 } : null,
							title: "从 api.dshmk.com 拉插件市场目录（走系统代理）",
							onClick: syncMarket,
						},
						marketPhase === "running" ? "同步中…" : "同步市场",
					),
				),
				env && env.libraryError
					? h("p", { className: "ailib-frame-note" }, "⚠️ library.js 读取失败，已按空库显示：" + env.libraryError)
					: null,
				marketNote ? h("p", { className: "ailib-frame-note" }, marketNote) : null,
				updateNote ? h("p", { className: "ailib-frame-note" }, updateNote) : null,
				picked.length
					? h(
							"div",
							{ className: "ailib-batch" },
							h("span", null, "已选 " + picked.length + " 条"),
							h("button", { className: "ailib-btn", type: "button", onClick: batchGroup }, "改分组"),
							h("button", { className: "ailib-btn", type: "button", onClick: batchTag }, "加标签"),
							h("button", { className: "ailib-btn ailib-danger", type: "button", onClick: batchDelete }, "删除"),
							h("button", { className: "ailib-btn", type: "button", onClick: () => setPicked([]) }, "取消"),
						)
					: null,
				body,
				paperOpen ? h(PaperPanel, { onClose: () => setPaperOpen(false), onAdded: load }) : null,
			);

			/**
			 * 左侧「本地对话产物」的三级树：
			 * 大类 → 对话（可展开）→ 按类型 / 按项目 → 具体条目
			 * @param b 大类节点（flat + sections）
			 */
			function renderSections(b) {
				const pickGroup = (key) => {
					setBucket(b.id);
					setKind("all");
					setGroup(key);
				};
				const row = (key, name, count, cls) =>
					h(
						"button",
						{
							key,
							type: "button",
							className: cls,
							"data-on": bucket === b.id && group === key ? "1" : "0",
							onClick: () => pickGroup(key),
						},
						h("span", { className: cls ? undefined : null }, name),
						h("em", null, count),
					);

				return h(
					"div",
					{ className: "ailib-subs" },
					(b.sections || []).map((sec) =>
						h(
							"div",
							{ key: sec.label },
							h("span", { className: "ailib-sub-head" }, sec.label),
							(sec.groups || []).map((g) => {
								const open = openConvs[g.key] !== undefined ? !!openConvs[g.key] : bucket === b.id && group === g.key;
								return h(
									"div",
									{ key: g.key, className: "ailib-conv" },
									h(
										"div",
										{ className: "ailib-conv-row" },
										h(
											"button",
											{
												type: "button",
												className: "ailib-caret",
												title: open ? "收起" : "展开「" + g.name + "」的类型/项目",
												onClick: () => setOpenConvs((cur) => ({ ...cur, [g.key]: !cur[g.key] })),
											},
											open ? "▾" : "▸",
										),
										h(
											"button",
											{
												type: "button",
												className: "ailib-sub ailib-sub-conv",
												"data-on": bucket === b.id && group === g.key ? "1" : "0",
												onMouseMove: glowMove,
												onMouseLeave: glowLeave,
												onClick: () => {
													setOpenConvs((cur) => Object.assign({}, cur, { [g.key]: true }));
													pickGroup(g.key);
												},
											},
											h("span", null, g.name),
											h("em", null, g.count),
										),
									),
									open
										? h(
												"div",
												{ className: "ailib-conv-kids" },
												(g.children || []).map((sub) =>
													h(
														"div",
														{ key: sub.label, className: "ailib-kid-group" },
														h("div", { className: "ailib-kid-label" }, sub.label),
														sub.items.map((c) =>
															h(
																"button",
																{
																	key: c.key,
																	type: "button",
																	className: "ailib-kid",
																	"data-on": bucket === b.id && group === c.key ? "1" : "0",
																	onClick: () => pickGroup(c.key),
																},
																h("span", null, c.name),
																h("em", null, c.count),
															),
														),
													),
												),
											)
										: null,
								);
							}),
						),
					),
				);
			}

			return h(
				"div",
				{ className: "ailib-shell", "data-expanded": expanded ? "1" : "0", "data-tree": treeOpen ? "1" : "0", "data-sel": selected ? "1" : "0" },
				h(Aurora, { key: "aurora", onStatus: setAuroraStatus }),
				/* 面板内文字输入弹窗（Electron 没有 window.prompt） */
				askBox
					? h(
							"div",
							{
								className: "ailib-ask-mask",
								onClick: () => {
									askBox.resolve(null);
									setAskBox(null);
								},
							},
							h(
								"div",
								{ className: "ailib-ask", onClick: (e) => e.stopPropagation() },
								h("div", { className: "ailib-ask-title" }, askBox.title),
								h("input", {
									className: "ailib-input",
									autoFocus: true,
									placeholder: askBox.hint,
									value: askBox.value,
									onChange: (e) => setAskBox((cur) => (cur ? { ...cur, value: e.target.value } : cur)),
									onKeyDown: (e) => {
										if (e.key === "Enter") {
											askBox.resolve(askBox.value.trim());
											setAskBox(null);
										} else if (e.key === "Escape") {
											askBox.resolve(null);
											setAskBox(null);
										}
									},
								}),
								h(
									"div",
									{ className: "ailib-editor-actions" },
									h(
										"button",
										{
											className: "ailib-btn",
											type: "button",
											style: { borderColor: "rgba(230,193,111,.5)", color: "#f2d791" },
											onClick: () => {
												askBox.resolve(askBox.value.trim());
												setAskBox(null);
											},
										},
										"确定",
									),
									h(
										"button",
										{
											className: "ailib-btn",
											type: "button",
											onClick: () => {
												askBox.resolve(null);
												setAskBox(null);
											},
										},
										"取消",
									),
								),
							),
						)
					: null,
				treeEl,
				main,
				editor
					? h(ItemEditor, {
							draft: editor.draft,
							isNew: editor.isNew,
							busy: editBusy,
							error: editError,
							onChange: (key, value) => setEditor((cur) => (cur ? { ...cur, draft: { ...cur.draft, [key]: value } } : cur)),
							onSave: saveEditor,
							onCancel: () => {
								setEditor(null);
								setEditError("");
							},
							onDelete: () => removeItem(selected),
						})
					: h(Preview, { item: selected, expanded, onToggleExpand: () => setExpanded((v) => !v), items, onOpen: setSelected, onPaper: () => setPaperOpen(true), root: (env && env.root) || "" }),
			);
		}

﻿		/* ────────────────────────── 条目编辑（A） ────────────────────────── */

		const ITEM_ROUTE = "/api/ai-library/item";

		/**
		 * 调编辑路由。
		 * @param method HTTP 方法
		 * @param body 请求体
		 * @returns 响应 JSON
		 */
		async function callItemRoute(method, body) {
			const url = method === "DELETE" ? ITEM_ROUTE + "?id=" + encodeURIComponent(body.id) : ITEM_ROUTE;
			const res = await fetch(url, {
				method,
				headers: method === "DELETE" ? undefined : { "content-type": "application/json" },
				body: method === "DELETE" ? undefined : JSON.stringify(body),
			});
			const json = await res.json().catch(() => null);
			if (!json || json.ok !== true) throw new Error((json && json.message) || "请求失败");
			return json;
		}

		/** 新建条目用的空草稿。 */
		function emptyDraft() {
			return { id: "", title: "", kind: "doc", group: "", summary: "", tags: "", link: "", notes: "" };
		}

		/**
		 * 条目对象 ↔ 表单草稿。
		 * @param item 现有条目
		 * @param currentGroup 当前分组名
		 * @returns 草稿
		 */
		function itemToDraft(item, currentGroup) {
			return {
				id: item.id,
				title: item.title || "",
				kind: item.kind || "doc",
				group: currentGroup || item.group || "",
				summary: item.summary || "",
				tags: (item.tags || []).join(", "),
				link: item.link || "",
				notes: (item.notes || []).join("\n"),
			};
		}

		/**
		 * 草稿 → 提交体。
		 * @param draft 表单值
		 * @param original 原始条目（编辑时用来保留 preview/files 等字段）
		 * @returns 条目对象
		 */
		function draftToItem(draft, original) {
			const base = original ? { ...original } : {};
			return {
				...base,
				id: draft.id || "u-" + Date.now().toString(36),
				title: draft.title.trim(),
				kind: draft.kind,
				group: draft.group.trim(),
				summary: draft.summary.trim(),
				tags: draft.tags.split(",").map((s) => s.trim()).filter(Boolean),
				link: draft.link.trim(),
				notes: draft.notes.split("\n").map((s) => s.trim()).filter(Boolean),
			};
		}

		/**
		 * 编辑表单（替换右侧预览区）。
		 * @param props.draft 草稿
		 * @param props.isNew 是否新建
		 * @param props.onChange 改字段
		 * @param props.onSave 保存
		 * @param props.onCancel 取消
		 * @param props.onDelete 删除
		 * @param props.busy 提交中
		 * @param props.error 错误信息
		 */
		function ItemEditor({ draft, isNew, onChange, onSave, onCancel, onDelete, busy, error }) {
			const field = (label, key, opts) =>
				h(
					"label",
					{ className: "ailib-field" },
					h("span", { className: "ailib-label" }, label),
					opts && opts.multiline
						? h("textarea", {
								className: "ailib-input ailib-textarea",
								value: draft[key],
								rows: opts.rows || 3,
								onChange: (e) => onChange(key, e.target.value),
							})
						: opts && opts.select
							? h(
									"select",
									{ className: "ailib-input", value: draft[key], onChange: (e) => onChange(key, e.target.value) },
									Object.keys(KIND_LABEL).map((k) => h("option", { key: k, value: k }, KIND_LABEL[k])),
								)
							: h("input", {
									className: "ailib-input",
									value: draft[key],
									onChange: (e) => onChange(key, e.target.value),
									placeholder: opts && opts.placeholder,
								}),
				);

			return h(
				"aside",
				{ className: "ailib-preview" },
				h(
					"div",
					{ className: "ailib-prev-head" },
					h("div", null, h("p", { className: "ailib-eyebrow" }, isNew ? "新建条目" : "编辑条目")),
					h("span", { className: "ailib-sub2" }, draft.id || "（保存后生成 id）"),
				),
				error ? h("div", { className: "ailib-error" }, error) : null,
				field("标题", "title", { placeholder: "必填" }),
				field("类型", "kind", { select: true }),
				field("分组", "group", { placeholder: "例如：物理实验 / 开发" }),
				field("摘要", "summary", { multiline: true, rows: 3 }),
				field("标签", "tags", { placeholder: "逗号分隔" }),
				field("链接", "link", { placeholder: "https://…" }),
				field("备注", "notes", { multiline: true, rows: 4 }),
				h(
					"div",
					{ className: "ailib-editor-actions" },
					h("button", { className: "ailib-btn", type: "button", disabled: busy || !draft.title.trim(), onClick: onSave }, busy ? "保存中…" : "保存"),
					h("button", { className: "ailib-btn", type: "button", onClick: onCancel }, "取消"),
					isNew ? null : h("button", { className: "ailib-btn ailib-danger", type: "button", onClick: onDelete }, "删除"),
				),
			);
		}

		/* ───────────── 论文检索面板 ───────────── */

		const PAPER_ROUTE = "/api/ai-library/paper";
		const KEYS_ROUTE = "/api/ai-library/keys";

		/** 免 key 平台。 */
		const PAPER_FREE_SOURCES = [
			{ id: "auto", label: "全部平台" },
			{ id: "arxiv", label: "arXiv" },
			{ id: "openalex", label: "OpenAlex" },
			{ id: "crossref", label: "Crossref" },
			{ id: "doaj", label: "DOAJ" },
			{ id: "openaire", label: "OpenAIRE" },
			{ id: "inspire", label: "INSPIRE HEP" },
			{ id: "europepmc", label: "Europe PMC" },
			{ id: "zenodo", label: "Zenodo" },
			{ id: "hal", label: "HAL" },
			{ id: "datacite", label: "DataCite" },
		];

		/** 需要 key 的平台。 */
		/** 每个 key 的申请地址提示（面板占位符用）。 */
const KEY_HINTS = {
  sciverse: "sciverse.space 申请（语义检索必填）",
  ieee: "developer.ieee.org 申请",
  elsevier: "dev.elsevier.com 申请",
  springer: "dev.springernature.com 申请",
};

const PAPER_KEYED_SOURCES = [
			{ id: "ieee", label: "IEEE Xplore", key: "ieee" },
			{ id: "sciencedirect", label: "ScienceDirect", key: "elsevier" },
			{ id: "springer", label: "Springer", key: "springer" },
			{ id: "sciverse", label: "Sciverse", key: "sciverse" },
		];

		/**
		 * 论文检索面板（覆盖在资料馆上方）。
		 * @param props.onClose 关闭
		 * @param props.onAdded 入库成功后的回调（刷新列表）
		 */
		function PaperPanel({ onClose, onAdded }) {
			const [q, setQ] = useState("");
			const [source, setSource] = useState("auto");
			const [busy, setBusy] = useState(false);
			const [items, setItems] = useState([]);
			const [hits, setHits] = useState([]);
			const [paperMode, setPaperMode] = useState("meta");
			const [err, setErr] = useState("");
			const [keys, setKeys] = useState({});
			const [keyDraft, setKeyDraft] = useState({ ieee: "", springer: "", elsevier: "", sciverse: "" });
			const [showKeys, setShowKeys] = useState(false);
			const [added, setAdded] = useState({});

			React.useEffect(() => {
				fetch(KEYS_ROUTE, { cache: "no-store" })
					.then((r) => r.json())
					.then((j) => j && j.ok && setKeys(j.configured || {}))
					.catch(() => {});
			}, []);

			const run = async () => {
				const query = q.trim();
				if (!query) return;
				setBusy(true);
				setErr("");
				try {
					const url =
						PAPER_ROUTE +
						"?q=" + encodeURIComponent(query) +
						"&source=" + encodeURIComponent(source) +
						"&limit=12" +
						(paperMode === "semantic" ? "&mode=semantic" : "&mode=meta");
					const res = await fetch(url, { cache: "no-store" });
					const j = await res.json();
					if (!j || j.ok !== true) throw new Error((j && j.message) || "检索失败");
					if (j.mode === "semantic") {
						setHits(j.hits || []);
						setItems([]);
					} else {
						setItems(j.items || []);
						setHits([]);
					}
				} catch (e) {
					setErr(String((e && e.message) || e));
					setItems([]);
				} finally {
					setBusy(false);
				}
			};

			const saveKeys = async () => {
				try {
					const res = await fetch(KEYS_ROUTE, {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({ paperKeys: keyDraft }),
					});
					const j = await res.json();
					if (!j || j.ok !== true) throw new Error((j && j.message) || "保存失败");
					setKeys((prev) => ({
						sciverse: prev.sciverse || !!keyDraft.sciverse,
						ieee: prev.ieee || !!keyDraft.ieee,
						springer: prev.springer || !!keyDraft.springer,
						elsevier: prev.elsevier || !!keyDraft.elsevier,
					}));
					setShowKeys(false);
					window.alert("已保存，检索时立即生效（不用重启）");
				} catch (e) {
					window.alert("保存失败：" + String((e && e.message) || e));
				}
			};

			const pick = async (paper) => {
				try {
					const res = await fetch("/api/ai-library/item", {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({
							id: "paper-" + String(paper.doi || paper.id || paper.title).replace(/[^\w.-]+/g, "-").slice(0, 60),
							kind: "paper",
							title: paper.title || "(无标题)",
							summary: String(paper.summary || "").slice(0, 500),
							source: paper.source || "",
							link: paper.sourceUrl || (paper.doi ? "https://doi.org/" + paper.doi : ""),
							tags: (paper.tags || []).slice(0, 6),
							notes: [
								paper.doi ? "DOI: " + paper.doi : "",
								(paper.authors || []).length ? "作者: " + paper.authors.slice(0, 4).join(", ") : "",
								paper.publishedAt ? "发表: " + String(paper.publishedAt).slice(0, 10) : "",
							].filter(Boolean),
							group: "论文检索",
							origin: "paper",
							format: "pdf",
							project: "论文检索",
						}),
					});
					const j = await res.json();
					if (!j || j.ok !== true) throw new Error((j && j.message) || "入库失败");
					setAdded((prev) => ({ ...prev, [paper.id || paper.title]: true }));
					if (onAdded) onAdded();
				} catch (e) {
					window.alert("入库失败：" + String((e && e.message) || e));
				}
			};

			const chip = (s, keyed) => {
				const disabled = keyed && !keys[keyed];
				return h(
					"button",
					{
						key: s.id,
						type: "button",
						className: "ailib-paper-src",
						"data-on": source === s.id ? "1" : "0",
						"data-disabled": disabled ? "1" : "0",
						title: disabled ? "需要 key（点右上角「配置 key」）" : "按 " + s.label + " 检索",
						onClick: () => {
							if (disabled) return setShowKeys(true);
							setSource(s.id);
						},
					},
					s.label,
				);
			};

			return h(
				"div",
				{ className: "ailib-paper-mask", onClick: (e) => e.target === e.currentTarget && onClose() },
				h(
					"div",
					{ className: "ailib-paper" },
					h(
						"div",
						{ className: "ailib-paper-head" },
						h("b", null, "论文检索"),
						h(
							"div",
							{ style: { display: "flex", gap: 8 } },
							h("button", { className: "ailib-btn", type: "button", onClick: () => setShowKeys((v) => !v) }, "配置 key"),
							h("button", { className: "ailib-btn", type: "button", onClick: onClose }, "关闭"),
						),
					),
					showKeys
						? h(
								"div",
								{ className: "ailib-paper-keys" },
								["ieee", "elsevier", "springer", "sciverse"].map((k) =>
									h(
										"label",
										{ key: k, style: { display: "flex", gap: 8, alignItems: "center", marginBottom: 6 } },
										h("span", { style: { width: 96, fontSize: 11.5, color: "rgba(255,255,255,.45)" } }, k),
										h("input", {
											className: "ailib-input",
											type: "password",
											placeholder: keys[k]
    ? "已配置（留空则不覆盖）"
    : (KEY_HINTS[k] || "粘贴 key"),
											value: keyDraft[k],
											onChange: (e) => setKeyDraft((prev) => ({ ...prev, [k]: e.target.value })),
										}),
									),
								),
								h("button", { className: "ailib-btn", type: "button", onClick: saveKeys }, "保存 key"),
							)
						: null,
					/* 模式：元数据检索 / Sciverse 语义检索（RAG） */
					h(
						"div",
						{ style: { display: "flex", gap: 8, alignItems: "center", marginBottom: 10, flexWrap: "wrap" } },
						h("span", { style: { fontSize: 11, color: "rgba(255,255,255,.4)" } }, "模式"),
						h(
							"button",
							{
								type: "button",
								className: "ailib-paper-src",
								"data-on": paperMode === "meta" ? "1" : "0",
								onClick: () => setPaperMode("meta"),
								title: "按元数据检索（十源 + Sciverse），返回论文列表",
							},
							"元数据检索",
						),
						h(
							"button",
							{
								type: "button",
								className: "ailib-paper-src",
								"data-on": paperMode === "semantic" ? "1" : "0",
								onClick: () => setPaperMode("semantic"),
								title: "Sciverse 语义检索：问一个问题，返回相关原文片段（需要 sciverse key）",
							},
							"语义检索 (RAG)",
						),
						paperMode === "semantic" && !keys.sciverse
							? h("span", { style: { fontSize: 10.5, color: "#d9a86a" } }, "需要 sciverse key")
							: null,
					),
					h(
						"div",
						{ className: "ailib-paper-srcs" },
						PAPER_FREE_SOURCES.map((s) => chip(s)),
						PAPER_KEYED_SOURCES.map((s) => chip(s, s.key)),
					),
					h(
						"div",
						{ className: "ailib-paper-search" },
						h("input", {
							className: "ailib-input",
							placeholder: "关键词，例如 physics education / 谐振子",
							value: q,
							onChange: (e) => setQ(e.target.value),
							onKeyDown: (e) => e.key === "Enter" && run(),
						}),
						h("button", { className: "ailib-btn", type: "button", onClick: run, disabled: busy }, busy ? "检索中…" : "检索"),
					),
					err ? h("div", { className: "ailib-error" }, err) : null,
					/* 语义检索结果：按 chunk 展示（题目 + 片段 + 相似度） */
					paperMode === "semantic" && hits.length
						? h(
								"div",
								{ className: "ailib-paper-list" },
								hits.map((hit) =>
									h(
										"div",
										{ key: hit.id || hit.chunkId, className: "ailib-paper-item" },
										h("div", { className: "ailib-paper-title" }, hit.title || "(无标题)"),
										h(
											"div",
											{ className: "ailib-paper-meta" },
											"相似度 " + (hit.score ? hit.score.toFixed(3) : "-"),
											hit.pageNo ? " · 第 " + hit.pageNo + " 页" : "",
											hit.sourceType ? " · " + hit.sourceType : "",
										),
										hit.chunk
											? h(
													"div",
													{ style: { marginTop: 6, fontSize: 11.5, lineHeight: 1.7, color: "rgba(255,255,255,.66)", whiteSpace: "pre-wrap", maxHeight: 160, overflow: "auto" } },
													hit.chunk,
												)
											: null,
										h(
											"div",
											{ style: { display: "flex", gap: 8, marginTop: 8 } },
											h(
												"button",
												{
													className: "ailib-btn",
													type: "button",
													disabled: added[hit.id || hit.chunkId],
													onClick: () =>
														pick({
															id: hit.docId ? "paper-" + hit.docId.slice(0, 24) : "chunk-" + (hit.chunkId || ""),
															title: hit.title,
															summary: hit.chunk || hit.abstract || "",
															source: "Sciverse",
															sourceUrl: "",
															tags: ["Sciverse", "RAG"],
															notes: [
																"Sciverse doc_id: " + (hit.docId || "-"),
																"相似度: " + (hit.score || 0).toFixed(3),
																hit.pageNo ? "页码: " + hit.pageNo : "",
																"offset: " + (hit.offset || 0),
															].filter(Boolean),
														}),
												},
												added[hit.id || hit.chunkId] ? "已加入" : "加入资源库",
											),
											hit.docId
												? h(
														"a",
														{
															className: "ailib-btn",
															href: "/api/ai-library/paper/read?doc=" + encodeURIComponent(hit.docId) + "&offset=" + (hit.offset || 0) + "&limit=4096",
															target: "_blank",
															rel: "noreferrer",
														},
														"读原文",
													)
												: null,
										),
									),
								),
							)
						: null,
					h(
						"div",
						{ className: "ailib-paper-list", style: paperMode === "semantic" ? { display: "none" } : null },
						items.length === 0 && !busy
							? h("p", { style: { fontSize: 12, color: "rgba(255,255,255,.4)" } }, "选一个平台，输入关键词检索")
							: items.map((p) =>
									h(
										"div",
										{ key: p.id || p.title, className: "ailib-paper-item" },
										h("div", { className: "ailib-paper-title" }, p.title || "(无标题)"),
										h(
											"div",
											{ className: "ailib-paper-meta" },
											(p.authors || []).slice(0, 3).join(", ") || "(作者未知)",
											p.publishedAt ? " · " + String(p.publishedAt).slice(0, 4) : "",
											p.source ? " · " + p.source : "",
											p.doi ? " · DOI " + p.doi : "",
										),
										h(
											"div",
											{ style: { display: "flex", gap: 8, marginTop: 8 } },
											h(
												"button",
												{
													className: "ailib-btn",
													type: "button",
													disabled: added[p.id || p.title],
													onClick: () => pick(p),
												},
												added[p.id || p.title] ? "已加入" : "加入资源库",
											),
											p.sourceUrl
												? h("a", { className: "ailib-btn", href: p.sourceUrl, target: "_blank", rel: "noreferrer" }, "打开原文")
												: null,
											p.pdfUrl ? h("a", { className: "ailib-btn", href: p.pdfUrl, target: "_blank", rel: "noreferrer" }, "PDF") : null,
										),
									),
								),
					),
				),
			);
		}

		/* ────────────────────────── 注册 ────────────────────────── */
		const inject = ["slots", "layout"];

		let layoutApi = null;

		function apply(ctx) {
			layoutApi = ctx.layout;

			ctx.slots.inject("main", () => ctx.slots.register({ name: "main", key: PANEL_ID }, LibraryPanel));

			ctx.slots.inject("sidebar.panellist", () =>
				ctx.slots.register(
					{ name: "sidebar.panellist", id: PANEL_ID, order: PANEL_ORDER, label: "资料馆" },
					PanelIcon,
				),
			);
		}

		exports.PANEL_ID = PANEL_ID;
		exports.inject = inject;
		exports.apply = apply;
		return module.exports;
	},
});

__beacon("load-returned");
} catch (loadError) {
	/* 不 rethrow：吞掉只是这个插件不出现，界面还能用 */
	__beacon("load-threw", {
		msg: String((loadError && loadError.message) || loadError),
		stack: String((loadError && loadError.stack) || "").slice(0, 1200),
	});
}
}
