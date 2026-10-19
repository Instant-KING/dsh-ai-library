import { readFileSync } from 'node:fs';
const src = readFileSync('E:/ai-plugins/ai-library/lib/client.js', 'utf8');
const payload = {
  ok: true, groups: {}, buckets: [{ id: 'local', label: '本地文件', order: 2, kinds: ['website'] }],
  items: [{
    id: 'web-test', kind: 'website', title: '测试网页', summary: '一句话摘要',
    link: 'https://example.com/a', tags: [], notes: ['站点：Example'],
    web: { site: 'Example', date: '2026-08-13', score: 2.13, authority: 3 },
  }],
  env: { root: 'X:/t', office: true },
};
let def = null;
const fakeEl = () => ({ style:{}, classList:{add(){},remove(){}}, setAttribute(){}, appendChild(){}, removeChild(){}, getBoundingClientRect:()=>({x:0,y:0,width:10,height:10,top:0,left:0,right:10,bottom:10}), querySelector:()=>null, querySelectorAll:()=>[], clientWidth:10, clientHeight:10, getContext:()=>null, addEventListener(){}, removeEventListener(){} });
globalThis.window = { __ModuleLoader__:{ load:(d)=>(def=d) }, addEventListener(){}, removeEventListener(){}, devicePixelRatio:1, innerHeight:900 };
globalThis.document = { hidden:false, visibilityState:'visible', createElement:fakeEl, head:{appendChild(){}}, body:fakeEl(), addEventListener(){}, removeEventListener(){}, querySelector:()=>null, querySelectorAll:()=>[], getElementById:()=>null, documentElement:fakeEl() };
globalThis.localStorage = { getItem:()=>null, setItem(){}, length:0, key:()=>null };
globalThis.MutationObserver = class { observe(){} disconnect(){} };
globalThis.ResizeObserver = class { observe(){} disconnect(){} };
globalThis.requestAnimationFrame = ()=>1; globalThis.cancelAnimationFrame = ()=>{};
globalThis.performance = { now:()=>0 }; globalThis.matchMedia = ()=>({ matches:false });
globalThis.getComputedStyle = () => ({ getPropertyValue:()=>'' , backgroundColor:'rgb(12,12,14)' });
globalThis.innerWidth = 1400; globalThis.innerHeight = 900; globalThis.URL = globalThis.URL || {};
globalThis.fetch = () => Promise.resolve({ ok:true, json:()=>Promise.resolve(payload), text:()=>Promise.resolve('') });
new Function('window','document','localStorage','fetch', src)(globalThis.window, globalThis.document, globalThis.localStorage, globalThis.fetch);
let idx=0; const store=[]; const effects=[];
const React = { createElement(t,p,...c){ const f=[]; const push=x=>{if(Array.isArray(x))x.forEach(push);else if(x!==null&&x!==undefined&&x!==false)f.push(x);}; push(c); return {type:t,props:p||{},children:f}; },
  useState(i){const k=idx++;if(!(k in store))store[k]= typeof i==='function'? i(): i;return[store[k],v=>{store[k]=typeof v==='function'?v(store[k]):v;}];},
  useEffect(f){effects.push(f);}, useMemo(f){return f();}, useCallback(f){return f;}, useRef(i){return{current:i};}, Fragment:'F' };
const mod = def.factory(()=>React);
let Panel=null;
mod.apply({ slots:{ inject:(n,fn)=>fn(), register:(m,c)=>{ if(m&&m.name==='main') Panel=c; } }, layout:{} });
idx=0; effects.length=0; Panel({}); for (const f of effects){ try{f();}catch{} }
await new Promise(r=>setTimeout(r,120));
const texts=[]; const classes=[];
function walk(n){ if(Array.isArray(n)) return n.forEach(walk); if(typeof n==='string'){ texts.push(n); return; } if(!n||typeof n!=='object') return;
  if(typeof n.type==='function'){ const sv=idx; idx=0; let r=null; try{ r=n.type(n.props||{}); }catch(e){ console.log('  ❌', n.type.name, e.message); idx=sv; return; } idx=sv; return walk(r); }
  if(n.props && n.props.className) classes.push(String(n.props.className)); walk(n.children); }
idx=0; walk(Panel({}));
const j=texts.join('|');
for (const kw of ['测试网页','Example','2026-08-13','权 3','2.1']) console.log('  ' + (j.includes(kw)?'✅':'❌') + ' ' + kw);
console.log('  web-meta 容器:', classes.some(c => c.includes('ailib-web-meta')));
