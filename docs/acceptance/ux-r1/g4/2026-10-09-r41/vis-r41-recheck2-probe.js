// vis-r41 **B5 处置后定向复验**（recheck2）。独立编写，只读产品代码；域 demo 5183。
// 判定指纹：产品码面 diff md5=36f149dd68ce2243fa3dd5afa76d90f9 / styles.css=52d2b42698616438fd08dc67cec642a0
//           / App.tsx=a53150588f3f6accd579636b015a5a40
// 覆盖：① B5 主项（1024/960 tp-full 态 + 1440/1280 停靠态，两种入口顺序）② 层叠不倒退
//       ③ 7 项处置回归 ④ 几何回归 ⑤ .log-note 对比度与无会话新文案 ⑥ toast 绘制顺序像素实证 ⑦ .split-menu 层叠
const { chromium } = require('/Users/chenpu/node_modules/playwright');
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');
const EXE = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

// 最小 PNG 解码（IHDR + IDAT inflate + unfilter），用于「绘制顺序」的**像素实证**。
// 必要性：.toast-stack 是 pointer-events:none，elementFromPoint 永远照不到它，
// 而它在 960×600/1024×768 出货尺寸下与居中对话框无几何重叠，故 hit-test 口径无法证明 toast 在上。
function pngPixel(buf, x, y) {
  let off = 8, w = 0, h = 0, depth = 0, ctype = 0; const idat = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off); const type = buf.toString('ascii', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') { w = data.readUInt32BE(0); h = data.readUInt32BE(4); depth = data[8]; ctype = data[9]; }
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    off += 12 + len;
  }
  const ch = ctype === 6 ? 4 : ctype === 2 ? 3 : 1;
  const bpp = ch * (depth / 8);
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = w * bpp; const out = Buffer.alloc(h * stride);
  for (let r = 0; r < h; r++) {
    const f = raw[r * (stride + 1)];
    const line = raw.subarray(r * (stride + 1) + 1, r * (stride + 1) + 1 + stride);
    const prev = r ? out.subarray((r - 1) * stride, r * stride) : Buffer.alloc(stride);
    const cur = out.subarray(r * stride, (r + 1) * stride);
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? cur[i - bpp] : 0, b = prev[i], c = i >= bpp ? prev[i - bpp] : 0;
      let v = line[i];
      if (f === 1) v += a; else if (f === 2) v += b; else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); v += (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c); }
      cur[i] = v & 0xff;
    }
  }
  const i0 = y * stride + x * bpp;
  return { r: out[i0], g: out[i0 + 1], b: out[i0 + 2] };
}
const URL = process.env.PROBE_URL || 'http://localhost:5183/';
const OUT = process.env.VIS_OUT || __dirname;

const results = [], contrasts = [], occlRows = [], layering = [];
const log = (s) => console.log(s);
const ok = (name, cond, detail = '') => { results.push({ name, pass: !!cond, detail }); log((cond ? 'PASS ' : 'FAIL ') + name + (detail ? '  [' + detail + ']' : '')); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const count = (page, sel) => page.evaluate((s) => document.querySelectorAll(s).length, sel);

const HELPERS = `
window.__vis = {
  parse(s){ const m=String(s).match(/rgba?\\(([^)]+)\\)/); if(!m) return null; const p=m[1].split(',').map(Number); return {r:p[0],g:p[1],b:p[2],a:p[3]===undefined?1:p[3]}; },
  lum(c){ const f=(v)=>{ v/=255; return v<=0.03928? v/12.92 : Math.pow((v+0.055)/1.055,2.4); }; return 0.2126*f(c.r)+0.7152*f(c.g)+0.0722*f(c.b); },
  ratio(fg,bg){ const L1=Math.max(this.lum(fg),this.lum(bg)), L2=Math.min(this.lum(fg),this.lum(bg)); return (L1+0.05)/(L2+0.05); },
  effBg(el){ let chain=[], n=el; while(n){ chain.push(getComputedStyle(n).backgroundColor); n=n.parentElement; } let acc={r:255,g:255,b:255}; for(let i=chain.length-1;i>=0;i--){ const c=this.parse(chain[i]); if(!c) continue; acc={r:c.r*c.a+acc.r*(1-c.a), g:c.g*c.a+acc.g*(1-c.a), b:c.b*c.a+acc.b*(1-c.a)}; } return acc; },
  measure(sel){ const el=document.querySelector(sel); if(!el) return {sel, missing:true};
    const cs=getComputedStyle(el); const fg0=this.parse(cs.color); const bg=this.effBg(el);
    let fg={...fg0}; if(fg.a<1){ fg={ r:fg0.r*fg0.a+bg.r*(1-fg0.a), g:fg0.g*fg0.a+bg.g*(1-fg0.a), b:fg0.b*fg0.a+bg.b*(1-fg0.a) }; }
    const fs=parseFloat(cs.fontSize); const wnum=parseInt(cs.fontWeight,10)||400;
    const large = fs>=24 || (fs>=18.66 && wnum>=700);
    const ratio=this.ratio(fg,bg); const thr=large?3.0:4.5;
    const bgStr='rgb('+Math.round(bg.r)+', '+Math.round(bg.g)+', '+Math.round(bg.b)+')';
    return { sel, color:cs.color, bg:bgStr, fontSize:fs, large, ratio:Math.round(ratio*100)/100, threshold:thr, pass: ratio+1e-9>=thr, text:(el.textContent||'').trim().slice(0,60), hovered: el.matches(':hover') };
  },
  clip(sel){ const el=document.querySelector(sel); if(!el) return {sel, missing:true};
    const r=el.getBoundingClientRect(); const pos=getComputedStyle(el).position;
    let clip={l:0,t:0,r:window.innerWidth,b:window.innerHeight};
    if(pos!=='fixed'){ let n=el.parentElement;
      while(n && n!==document.documentElement){ const cs=getComputedStyle(n);
        if(cs.overflow!=='visible'||cs.overflowX!=='visible'||cs.overflowY!=='visible'){ const b=n.getBoundingClientRect();
          clip.l=Math.max(clip.l,b.left); clip.t=Math.max(clip.t,b.top); clip.r=Math.min(clip.r,b.right); clip.b=Math.min(clip.b,b.bottom); }
        n=n.parentElement; } }
    const w=Math.max(0,Math.min(r.right,clip.r)-Math.max(r.left,clip.l));
    const h=Math.max(0,Math.min(r.bottom,clip.b)-Math.max(r.top,clip.t));
    const t=document.elementFromPoint(r.left+r.width/2, r.top+r.height/2);
    return { sel, rect:{x:Math.round(r.x),y:Math.round(r.y),w:Math.round(r.width),h:Math.round(r.height)},
      clippedW:Math.round(r.width-w), clippedH:Math.round(r.height-h), pos, hitCenter: !!t&&(el===t||el.contains(t)) };
  },
  center(sel){ const el=document.querySelector(sel); if(!el) return {sel,missing:true};
    const r=el.getBoundingClientRect(); const cx=r.left+r.width/2, cy=r.top+r.height/2;
    return { sel, dxViewport:Math.round(cx-window.innerWidth/2), dyViewport:Math.round(cy-window.innerHeight/2), pos:getComputedStyle(el).position }; },
  fixedContainingBlock(){ const bad=[]; let m=document.querySelector('.term-wrap');
    while(m && m!==document.documentElement){ const cs=getComputedStyle(m);
      if(cs.transform!=='none'||cs.filter!=='none'||cs.perspective!=='none'||cs.contain!=='none'||cs.willChange!=='auto') bad.push(String(m.className).split(' ')[0]);
      m=m.parentElement; } return bad; },
  // 逐交互元素中心点可达性审计（recheck v2 口径）
  occl(dlgSel){ const dlg=document.querySelector(dlgSel); if(!dlg) return {missing:true};
    const panel=document.querySelector('.task-panel'); const pr=panel?.getBoundingClientRect(), dr=dlg.getBoundingClientRect();
    const els=[...dlg.querySelectorAll('button, input, textarea, select, [data-testid]')];
    const blocked=[];
    for(const e of els){ const b=e.getBoundingClientRect(); if(!b.width||!b.height) continue;
      const h=document.elementFromPoint(b.left+b.width/2, b.top+b.height/2);
      if(!(h&&(e===h||e.contains(h)||h.contains(e)))) blocked.push({ tid:e.getAttribute('data-testid')||String(e.className).slice(0,20), by:String(h?.className||h?.tagName).slice(0,28) }); }
    return { dialog:{x:Math.round(dr.x),y:Math.round(dr.y),w:Math.round(dr.width),h:Math.round(dr.height),z:getComputedStyle(dlg).zIndex},
      panel: pr? {cls:String(panel.className), x:Math.round(pr.x), w:Math.round(pr.width), z:getComputedStyle(panel).zIndex}:null,
      overlapW: pr? Math.round(Math.max(0,Math.min(dr.right,pr.right)-Math.max(dr.left,pr.left))):0,
      total: els.length, blockedN: blocked.length, sample: blocked.slice(0,6) }; },
  // 某元素中心的命中链（判断谁在最上面）
  topAt(sel){ const el=document.querySelector(sel); if(!el) return {missing:true};
    const b=el.getBoundingClientRect(); const h=document.elementFromPoint(b.left+b.width/2, b.top+b.height/2);
    return { sel, self: !!h&&(el===h||el.contains(h)||h.contains(el)),
      topTag: h?.tagName, topCls: String(h?.className||'').slice(0,36), topTid: h?.getAttribute?.('data-testid')||null,
      topZ: h? getComputedStyle(h).zIndex : null, rect:{x:Math.round(b.x),y:Math.round(b.y),w:Math.round(b.width),h:Math.round(b.height)} }; }
};
true;
`;

(async () => {
  const browser = await chromium.launch({ executablePath: EXE, headless: true });
  const boot = async (ctx) => {
    const page = await ctx.newPage();
    const errs = []; page.on('pageerror', (e) => errs.push(String(e)));
    await page.goto(URL, { waitUntil: 'domcontentloaded' });
    await page.evaluate(() => { try { localStorage.clear(); } catch {} });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.addInitScript(HELPERS); await page.evaluate(HELPERS);
    await page.waitForSelector('.host-card', { timeout: 15000 }); await sleep(500);
    await page.evaluate(() => { [...document.querySelectorAll('.tab')].find((t) => t.textContent.includes('prod-1'))?.click(); });
    await sleep(700);
    page.__errs = errs;
    page.__invoke = (cmd, args) => page.evaluate(async ({ c, a }) => {
      const { invoke } = await import('/src/adapter/bridge.ts'); return invoke(c, a);
    }, { c: cmd, a: args });
    return page;
  };
  const openTools = async (page, testid) => {
    await page.evaluate(() => { [...document.querySelectorAll('.st-tools button')].find((b) => b.textContent.includes('工具'))?.click(); });
    await sleep(250);
    try { await page.click(`[data-testid="${testid}"]`, { timeout: 3000 }); } catch { log(`    (openTools ${testid} 被拦)`); }
    await sleep(600);
  };
  const panelCls = (page) => page.evaluate(() => document.querySelector('.task-panel')?.className ?? null);

  // ================= ① B5 主项 + ④ 几何回归 =================
  log('\n================ ① B5 主项 @ 4 VIEWPORTS (dark) ================');
  for (const vp of [{ width: 1440, height: 900 }, { width: 1280, height: 800 }, { width: 1024, height: 768 }, { width: 960, height: 600 }]) {
    const vpTag = `${vp.width}x${vp.height}`;
    log(`\n--- ${vpTag} ---`);
    // ===== 入口 A：先开活动记录面板，再开对话框 =====
    let ctx = await browser.newContext({ viewport: vp, colorScheme: 'dark' });
    let page = await boot(ctx);
    await openTools(page, 'tools-activity'); await sleep(300);
    const pcls = await panelCls(page);
    const full = /tp-full/.test(pcls || '');
    log(`  入口A：面板态 = ${pcls}`);
    ok(`[${vpTag}] 入口A 活动记录面板在场`, !!pcls, String(pcls));
    await openTools(page, 'tools-conn-detail');
    const cdO = await page.evaluate(() => window.__vis.occl('[data-testid="conn-detail"]'));
    const cdC = await page.evaluate(() => window.__vis.center('[data-testid="conn-detail"]'));
    occlRows.push({ vp: vpTag, entry: 'panel→dialog', what: 'conn-detail', panelCls: pcls, ...cdO, ...cdC });
    log(`     conn-detail: dlgZ=${cdO.dialog?.z} panelZ=${cdO.panel?.z} overlapW=${cdO.overlapW} blocked=${cdO.blockedN}/${cdO.total} dxV=${cdC.dxViewport} dyV=${cdC.dyViewport}`);
    ok(`[${vpTag}] 入口A conn-detail 无遮挡（blocked=0）`, cdO.blockedN === 0, `blocked=${cdO.blockedN}/${cdO.total} dlgZ=${cdO.dialog?.z} panelZ=${cdO.panel?.z} ${JSON.stringify(cdO.sample)}`);
    ok(`[${vpTag}] 入口A conn-detail 居中 dx/dy=0`, Math.abs(cdC.dxViewport) <= 1 && Math.abs(cdC.dyViewport) <= 1, `dx=${cdC.dxViewport} dy=${cdC.dyViewport}`);
    await page.screenshot({ path: path.join(OUT, `vis-r41-recheck2-dark-${vpTag}-condetail-panelopen.png`) });
    await page.keyboard.press('Escape'); await sleep(350);
    await page.click('.hb-settings').catch(() => {}); await sleep(600);
    const stO = await page.evaluate(() => window.__vis.occl('.term-settings.settings-wide'));
    const stC = await page.evaluate(() => window.__vis.center('.term-settings.settings-wide'));
    occlRows.push({ vp: vpTag, entry: 'panel→dialog', what: 'settings', panelCls: pcls, ...stO, ...stC });
    log(`     settings: dlgZ=${stO.dialog?.z} panelZ=${stO.panel?.z} overlapW=${stO.overlapW} blocked=${stO.blockedN}/${stO.total} dxV=${stC.dxViewport} dyV=${stC.dyViewport}`);
    ok(`[${vpTag}] 入口A settings 无遮挡（blocked=0）`, stO.blockedN === 0, `blocked=${stO.blockedN}/${stO.total} dlgZ=${stO.dialog?.z} panelZ=${stO.panel?.z} ${JSON.stringify(stO.sample)}`);
    ok(`[${vpTag}] 入口A settings 居中 dx/dy=0`, Math.abs(stC.dxViewport) <= 1 && Math.abs(stC.dyViewport) <= 1, `dx=${stC.dxViewport} dy=${stC.dyViewport}`);
    await page.screenshot({ path: path.join(OUT, `vis-r41-recheck2-dark-${vpTag}-settings-panelopen.png`) });
    // 凭据表单展开态（更宽内容）也要无遮挡
    await page.click('[data-testid="settings-cat-credentials"]').catch(() => {}); await sleep(400);
    await page.click('[data-testid="cred-new"]').catch(() => {}); await sleep(400);
    const stCredO = await page.evaluate(() => window.__vis.occl('.term-settings.settings-wide'));
    const stCred = await page.evaluate(() => window.__vis.clip('.term-settings.settings-wide'));
    log(`     settings(凭据表单展开): clippedH=${stCred.clippedH} blocked=${stCredO.blockedN}/${stCredO.total}`);
    ok(`[${vpTag}] 入口A settings(凭据表单展开) 无裁切无遮挡`, stCred.clippedH === 0 && stCred.clippedW === 0 && stCredO.blockedN === 0, `clippedH=${stCred.clippedH} blocked=${stCredO.blockedN}/${stCredO.total}`);
    await page.screenshot({ path: path.join(OUT, `vis-r41-recheck2-dark-${vpTag}-settings-cred-panelopen.png`) });
    // 几何回归：log-bar / log-filters
    await page.keyboard.press('Escape'); await sleep(350);
    const lb = await page.evaluate(() => window.__vis.clip('.log-bar'));
    const lf = await page.evaluate(() => window.__vis.clip('.log-filters'));
    const wrap = await page.evaluate(() => { const e = document.querySelector('.log-filters'); if (!e) return null;
      const rows = new Set([...e.querySelectorAll('label')].map((l) => Math.round(l.getBoundingClientRect().top)));
      return { rows: rows.size, scrollW: e.scrollWidth, clientW: e.clientWidth }; });
    ok(`[${vpTag}] 回归 log-bar 无横向溢出`, lb.clippedW === 0, `clippedW=${lb.clippedW}`);
    ok(`[${vpTag}] 回归 log-filters 无溢出/不折行`, lf.clippedW === 0 && wrap && wrap.rows === 1, `clippedW=${lf.clippedW} ${JSON.stringify(wrap)}`);
    ok(`[${vpTag}] 入口A 零 JS 错误`, page.__errs.length === 0, page.__errs.slice(0, 2).join(' | '));
    await ctx.close();

    // ===== 入口 B：先开对话框，再开活动记录面板 =====
    ctx = await browser.newContext({ viewport: vp, colorScheme: 'dark' });
    page = await boot(ctx);
    await openTools(page, 'tools-conn-detail');
    const cdBefore = await page.evaluate(() => window.__vis.occl('[data-testid="conn-detail"]'));
    await openTools(page, 'tools-activity'); await sleep(400);
    const pclsB = await panelCls(page);
    const cdAfter = await page.evaluate(() => window.__vis.occl('[data-testid="conn-detail"]'));
    log(`  入口B：先开详情(blocked=${cdBefore.blockedN}/${cdBefore.total}) → 再开面板(${pclsB}) → blocked=${cdAfter.blockedN}/${cdAfter.total} dlgZ=${cdAfter.dialog?.z} panelZ=${cdAfter.panel?.z}`);
    ok(`[${vpTag}] 入口B 面板后开时 conn-detail 仍无遮挡`, cdAfter.blockedN === 0, `blocked=${cdAfter.blockedN}/${cdAfter.total} panelCls=${pclsB} dlgZ=${cdAfter.dialog?.z} panelZ=${cdAfter.panel?.z}`);
    occlRows.push({ vp: vpTag, entry: 'dialog→panel', what: 'conn-detail', panelCls: pclsB, ...cdAfter });
    await page.screenshot({ path: path.join(OUT, `vis-r41-recheck2-dark-${vpTag}-condetail-dialogfirst.png`) });
    ok(`[${vpTag}] 入口B 零 JS 错误`, page.__errs.length === 0, page.__errs.slice(0, 2).join(' | '));
    await ctx.close();
  }

  // ================= ② 层叠不倒退 @960x600（tp-full 态，最严）=================
  log('\n================ ② 层叠不倒退 @960x600 (dark) ================');
  {
    const ctx = await browser.newContext({ viewport: { width: 960, height: 600 }, colorScheme: 'dark' });
    const page = await boot(ctx);
    // --- 工具菜单在 tp-full 态下可达 ---
    await openTools(page, 'tools-activity'); await sleep(300);
    const pcls = await panelCls(page);
    await page.evaluate(() => { [...document.querySelectorAll('.st-tools button')].find((b) => b.textContent.includes('工具'))?.click(); });
    await sleep(300);
    const menu = await page.evaluate(() => window.__vis.topAt('[data-testid="tools-conn-detail"]'));
    layering.push({ what: 'tools-menu', panelCls: pcls, ...menu });
    ok('[960x600] tp-full 态下工具菜单项可达', menu.self === true, `panel=${pcls} top=${menu.topCls} z=${menu.topZ} self=${menu.self}`);
    await page.keyboard.press('Escape'); await sleep(300);
    // --- toast 层叠：叠 3 条以**制造与对话框的空间重叠**，再目视+几何对账 ---
    await openTools(page, 'tools-conn-detail');
    for (let i = 0; i < 3; i++) { await page.click('[data-testid="cd-copy"]').catch(() => {}); await sleep(320); }
    await sleep(300);
    const toastInfo = await page.evaluate(() => {
      const list = [...document.querySelectorAll('.toast')];
      const st = document.querySelector('.toast-stack'); const dlg = document.querySelector('[data-testid="conn-detail"]');
      if (!list.length || !dlg) return { missing: true };
      const r = dlg.getBoundingClientRect();
      const rects = list.map((t) => { const b = t.getBoundingClientRect();
        return { text: t.textContent, x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) }; });
      const ovArea = rects.reduce((acc, b) => acc + Math.max(0, Math.min(b.x + b.w, r.right) - Math.max(b.x, r.left)) * Math.max(0, Math.min(b.y + b.h, r.bottom) - Math.max(b.y, r.top)), 0);
      return { count: list.length, texts: list.map((t) => t.textContent), stackZ: getComputedStyle(st).zIndex,
        dlgZ: getComputedStyle(dlg).zIndex, stackPointerEvents: getComputedStyle(st).pointerEvents,
        toastBorderLeft: getComputedStyle(list[0]).borderLeftColor, toastBg: getComputedStyle(list[0]).backgroundColor,
        rects, dlgRect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
        overlapArea: Math.round(ovArea),
        // 两者是否同处根层叠上下文（决定 z 序比较是否有效）：向上找最近的建栈祖先
        sameStackRoot: (() => {
          const ctxOf = (el) => { let n = el.parentElement;
            while (n && n !== document.documentElement) { const cs = getComputedStyle(n);
              if (cs.transform !== 'none' || cs.filter !== 'none' || cs.perspective !== 'none' || cs.willChange !== 'auto'
                || cs.contain.includes('paint') || cs.contain.includes('layout') || cs.opacity !== '1'
                || (cs.position !== 'static' && cs.zIndex !== 'auto')) return n;
              n = n.parentElement; }
            return document.documentElement; };
          const a = ctxOf(st), b = ctxOf(dlg);
          return { toastRoot: a.className || a.tagName, dlgRoot: b.className || b.tagName, same: a === b }; })() };
    });
    layering.push({ what: 'toast-stack', ...toastInfo });
    log(`     toast×${toastInfo.count} stackZ=${toastInfo.stackZ} dlgZ=${toastInfo.dlgZ} pointer-events=${toastInfo.stackPointerEvents} 与对话框重叠面积=${toastInfo.overlapArea}px²`);
    log(`     toast rects=${JSON.stringify(toastInfo.rects)} dlgRect=${JSON.stringify(toastInfo.dlgRect)}`);
    log(`     层叠上下文根：toast=${toastInfo.sameStackRoot?.toastRoot} dlg=${toastInfo.sameStackRoot?.dlgRoot} same=${toastInfo.sameStackRoot?.same}`);
    ok('[960x600] toast 仍渲染且 z 序未被对话框越过（stackZ > dlgZ）',
      toastInfo.count >= 1 && Number(toastInfo.stackZ) > Number(toastInfo.dlgZ) && toastInfo.stackPointerEvents === 'none',
      `count=${toastInfo.count} stackZ=${toastInfo.stackZ} dlgZ=${toastInfo.dlgZ} pointer-events=${toastInfo.stackPointerEvents}`);
    ok('[960x600] toast 与对话框同处一根层叠上下文（z 序比较有效）', toastInfo.sameStackRoot?.same === true,
      JSON.stringify(toastInfo.sameStackRoot));
    log(`     注：960×600 下 toast(right:16px, w≈113) 与居中对话框无几何重叠（overlapArea=${toastInfo.overlapArea}px²），`);
    log(`         且 .toast-stack 为 pointer-events:none → hit-test 口径原理上照不到它。绘制顺序另见 ⑥ 像素实证。`);
    await page.screenshot({ path: path.join(OUT, 'vis-r41-recheck2-dark-toast-over-dialog.png') });
    await page.keyboard.press('Escape'); await sleep(350);
    // --- 确认框压在设置对话框之上（设置→凭据→删除被引用凭据）---
    await page.click('.hb-settings').catch(() => {}); await sleep(600);
    await page.click('[data-testid="settings-cat-credentials"]').catch(() => {}); await sleep(400);
    await page.click('[data-testid="cred-new"]').catch(() => {}); await sleep(300);
    await page.evaluate(() => {
      const el = document.querySelector('[data-testid="cred-new-label"]'); if (!el) return;
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(el, 'r41-b5-key');
      el.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await page.click('[data-testid="cred-new-gen-ed"]').catch(() => {}); await sleep(900);
    const idents = await page.__invoke('list_identities');
    const target = idents.find((x) => x.label === 'r41-b5-key');
    let confirmRes = { skipped: true };
    if (target) {
      await page.__invoke('upsert_host', { host: { id: null, name: 'r41-b5-bound', address: '10.9.9.9', port: 22, username: 'ops', auth: { Key: { identity_id: target.id } }, charset: 'utf-8' } });
      await sleep(400);
      await page.evaluate(() => { const row = [...document.querySelectorAll('.cred-row')].find((r) => r.textContent.includes('r41-b5-key')); row?.querySelector('.host-del')?.click(); });
      await sleep(500);
      confirmRes = await page.evaluate(() => {
        const dlg = document.querySelector('.term-settings.settings-wide');
        const btn = [...document.querySelectorAll('.confirm-dialog button')].find((b) => b.textContent.includes('删除凭据'));
        if (!btn) return { missing: true, confirmCount: document.querySelectorAll('.confirm-dialog').length };
        const b = btn.getBoundingClientRect();
        const h = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2);
        const mask = document.querySelector('.confirm-mask');
        return { confirmCount: document.querySelectorAll('.confirm-dialog').length,
          btnText: btn.textContent.trim(), selfHit: !!h && (btn === h || btn.contains(h) || h.contains(btn)),
          topCls: String(h?.className || '').slice(0, 30), topZ: getComputedStyle(h).zIndex,
          confirmMaskZ: mask ? getComputedStyle(mask).zIndex : null, settingsZ: dlg ? getComputedStyle(dlg).zIndex : null,
          popMaskZ: (() => { const p = document.querySelector('.pop-mask'); return p ? getComputedStyle(p).zIndex : null; })() };
      });
      layering.push({ what: 'confirm-over-settings', ...confirmRes });
      ok('[960x600] 确认框（删除被引用凭据）仍压在设置对话框之上', confirmRes.selfHit === true && Number(confirmRes.confirmMaskZ) > Number(confirmRes.settingsZ),
        `btn="${confirmRes.btnText}" selfHit=${confirmRes.selfHit} confirmMaskZ=${confirmRes.confirmMaskZ} settingsZ=${confirmRes.settingsZ} popMaskZ=${confirmRes.popMaskZ} top=${confirmRes.topCls}`);
      await page.screenshot({ path: path.join(OUT, 'vis-r41-recheck2-dark-confirm-over-settings.png') });
      await page.keyboard.press('Escape'); await sleep(300);
    } else { ok('[960x600] 确认框压在设置之上（前置：凭据创建成功）', false, '未能创建 r41-b5-key 凭据'); }
    ok('[960x600] 层叠轮零 JS 错误', page.__errs.length === 0, page.__errs.slice(0, 2).join(' | '));
    await ctx.close();
  }

  // ================= ③ 7 项处置回归（双主题 @1280x800）=================
  for (const theme of ['dark', 'light']) {
    log(`\n================ ③ 7 项回归 THEME: ${theme} @1280x800 ================`);
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, colorScheme: theme });
    const page = await boot(ctx);
    const sid = (await page.__invoke('list_sessions')).find((s) => s.host_name === 'prod-1').id;
    // B2
    await openTools(page, 'tools-conn-detail');
    const hint = await page.evaluate(() => window.__vis.measure('.cd-hint'));
    contrasts.push({ theme, item: 'B2 .cd-hint', ...hint });
    ok(`[${theme}] B2 .cd-hint ≥ AA`, hint.pass, `ratio=${hint.ratio} fg=${hint.color} bg=${hint.bg} fs=${hint.fontSize}`);
    // B4
    await page.keyboard.press('Escape'); await sleep(400);
    const cdAfter = await count(page, '[data-testid="conn-detail"]');
    const sess = (await page.__invoke('list_sessions')).find((s) => s.id === sid);
    ok(`[${theme}] B4 Esc 关详情（计数 0）且不误关会话`, cdAfter === 0 && !!sess && sess.state === 'Connected', `count=${cdAfter} sid=${sid} state=${sess?.state}`);
    // B1
    await openTools(page, 'tools-activity');
    await page.hover('[data-testid="log-scope-all"]'); await sleep(250);
    const segHover = await page.evaluate(() => window.__vis.measure('[data-testid="log-scope-all"]'));
    contrasts.push({ theme, item: 'B1 .seg 未选中钮 hover', ...segHover });
    ok(`[${theme}] B1 .seg 未选中钮悬停 ≥ AA`, segHover.pass, `ratio=${segHover.ratio} fg=${segHover.color} bg=${segHover.bg}`);
    const onBefore = await page.evaluate(() => window.__vis.measure('[data-testid="log-scope-current"]'));
    await page.hover('[data-testid="log-scope-current"]'); await sleep(250);
    const onHover = await page.evaluate(() => window.__vis.measure('[data-testid="log-scope-current"]'));
    const onCls = await page.evaluate(() => document.querySelector('[data-testid="log-scope-current"]')?.className);
    contrasts.push({ theme, item: 'B1 .seg 选中钮 hover', ...onHover });
    ok(`[${theme}] B1 悬停选中钮不顶掉选中态`, onBefore.bg === onHover.bg && /(^|\s)on(\s|$)/.test(onCls || ''), `before=${onBefore.bg} hover=${onHover.bg} cls="${onCls}"`);
    // .log-note 对比度（作者改了文案，类名/色未动）
    const noteM = await page.evaluate(() => window.__vis.measure('[data-testid="log-note"]'));
    contrasts.push({ theme, item: '.log-note', ...noteM });
    ok(`[${theme}] .log-note 对比度未变（≥AA）`, noteM.pass, `ratio=${noteM.ratio} fg=${noteM.color} bg=${noteM.bg}`);
    log(`     .log-note 文案 = "${noteM.text}"`);
    // B3 / L2
    await page.click('.hb-settings'); await sleep(500);
    await page.click('[data-testid="settings-cat-credentials"]'); await sleep(450);
    const ce = await page.evaluate(() => window.__vis.measure('[data-testid="cred-empty"]'));
    contrasts.push({ theme, item: 'B3 cred-empty', ...ce });
    ok(`[${theme}] B3 cred-empty ≥ AA`, ce.pass, `ratio=${ce.ratio} fg=${ce.color} bg=${ce.bg} fs=${ce.fontSize}`);
    await page.click('[data-testid="cred-new"]').catch(() => {}); await sleep(350);
    const gb = await page.evaluate(() => window.__vis.measure('.cred-new button.ghost'));
    contrasts.push({ theme, item: 'L2 .cred-new button.ghost', ...gb });
    ok(`[${theme}] L2 cred-new ghost ≥ AA`, gb.pass, `ratio=${gb.ratio} fg=${gb.color} bg=${gb.bg} fs=${gb.fontSize}`);
    // M2
    const setPem = () => page.evaluate(() => { const el = document.querySelector('[data-testid="cred-new-pem"]'); if (!el) return;
      Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set.call(el, '-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----');
      el.dispatchEvent(new Event('input', { bubbles: true })); });
    const tabSeq = async (n) => { const s = []; for (let i = 0; i < n; i++) {
      s.push(await page.evaluate(() => { const d = document.querySelector('.term-settings.settings-wide');
        return { inside: !!d && d.contains(document.activeElement), tid: document.activeElement?.getAttribute('data-testid') || String(document.activeElement?.className || '').slice(0, 14) }; }));
      await page.keyboard.press('Tab'); await sleep(50); } return s; };
    await setPem(); await sleep(200);
    await page.click('[data-testid="settings-cat-appearance"]').catch(() => {}); await sleep(400);
    ok(`[${theme}] M2 草稿拦截出现（路1）`, (await count(page, '[data-testid="cred-draft"]')) === 1);
    await page.click('[data-testid="cred-draft-keep"]').catch(() => {}); await sleep(400);
    const seq1 = await tabSeq(6);
    ok(`[${theme}] M2 路1「留下继续编辑」Tab 不逃逸`, seq1.every((s) => s.inside), JSON.stringify(seq1.map((s) => s.tid)));
    await page.click('[data-testid="settings-cat-credentials"]').catch(() => {}); await sleep(400);
    await page.click('[data-testid="cred-new"]').catch(() => {}); await sleep(300);
    await setPem(); await sleep(200);
    await page.click('[data-testid="settings-cat-appearance"]').catch(() => {}); await sleep(400);
    await page.click('[data-testid="cred-draft-discard"]').catch(() => {}); await sleep(450);
    const seq2 = await tabSeq(6);
    ok(`[${theme}] M2 路2「丢弃草稿并切换」Tab 不逃逸`, seq2.every((s) => s.inside), JSON.stringify(seq2.map((s) => s.tid)));
    const cutApp = await page.evaluate(() => { const p = document.querySelector('[data-testid="settings-pane-appearance"]'); if (!p) return null;
      const pr = p.getBoundingClientRect(); return [...p.children].some((c) => c.getBoundingClientRect().bottom > pr.bottom + 1); });
    ok(`[${theme}] 回归：外观分类内容未被裁`, cutApp === false, String(cutApp));
    await page.keyboard.press('Escape'); await sleep(400);
    // .log-note 无会话新文案（走**界面**关闭会话：工具菜单 →「关闭会话…」→ 确认框，
    // 这条链会真正清空前端 sid；demoInvoke('close_session') 只动后端，sid 不清）
    await page.evaluate(() => { [...document.querySelectorAll('.st-tools button')].find((b) => b.textContent.includes('工具'))?.click(); });
    await sleep(300);
    await page.evaluate(() => { [...document.querySelectorAll('.tools-menu button')].find((b) => b.textContent.includes('关闭会话'))?.click(); });
    await sleep(500);
    const confirmShown = await count(page, '.confirm-dialog');
    if (confirmShown) {
      await page.evaluate(() => { [...document.querySelectorAll('.confirm-dialog button')].find((b) => b.textContent.trim() === '关闭会话')?.click(); });
      await sleep(900);
    } else {
      await page.evaluate(() => { const b = [...document.querySelectorAll('.tab')].find((t) => t.textContent.includes('prod-1')); b?.querySelector('button[aria-label^="关闭会话"]')?.click(); });
      await sleep(900);
      await page.evaluate(() => { [...document.querySelectorAll('.confirm-dialog button')].find((b) => b.textContent.trim() === '关闭会话')?.click(); });
      await sleep(900);
    }
    const sidNow = await page.evaluate(() => document.querySelector('[data-testid="log-empty-nosession"]') ? null : 'still');
    log(`     关闭会话链：confirmShown=${confirmShown} log-empty-nosession 在场=${sidNow === null}`);
    // 同一次 evaluate 内同时读「无会话空态」与「.log-note 文案」，避免两次求值跨渲染读陈旧值
    await sleep(1200);
    const noteEmpty = await page.evaluate(() => {
      const el = document.querySelector('[data-testid="log-note"]');
      return { noSess: document.querySelectorAll('[data-testid="log-empty-nosession"]').length,
        rows: document.querySelectorAll('[data-testid="log-row"]').length,
        note: el ? el.textContent.trim() : null, m: window.__vis.measure('[data-testid="log-note"]') };
    });
    contrasts.push({ theme, item: '.log-note(无会话)', ...noteEmpty.m });
    log(`     无会话 .log-note 文案 = "${noteEmpty.note}" | log-empty-nosession=${noteEmpty.noSess} log-row=${noteEmpty.rows}`);
    ok(`[${theme}] .log-note 无会话文案与作者声明一致`, /未接入会话，无可显示记录/.test(noteEmpty.note || ''), noteEmpty.note || '');
    ok(`[${theme}] .log-note 无会话态对比度 ≥ AA`, noteEmpty.m.pass, `ratio=${noteEmpty.m.ratio} fg=${noteEmpty.m.color} bg=${noteEmpty.m.bg}`);
    ok(`[${theme}] 回归轮零 JS 错误`, page.__errs.length === 0, page.__errs.slice(0, 2).join(' | '));
    await ctx.close();
  }

  // ================= ④ M3 重测（z-index 变更后）=================
  log('\n================ ④ M3 重测（z-index 变更后，dark）=================');
  for (const vp of [{ width: 1440, height: 900 }, { width: 1280, height: 800 }, { width: 1024, height: 768 }, { width: 960, height: 600 }]) {
    const vpTag = `${vp.width}x${vp.height}`;
    const ctx = await browser.newContext({ viewport: vp, colorScheme: 'dark' });
    const page = await boot(ctx);
    await openTools(page, 'tools-conn-detail');
    const c1 = await page.evaluate(() => window.__vis.center('[data-testid="conn-detail"]'));
    await page.keyboard.press('Escape'); await sleep(350);
    await page.click('.hb-settings'); await sleep(500);
    const c2 = await page.evaluate(() => window.__vis.center('.term-settings.settings-wide'));
    const fb = await page.evaluate(() => window.__vis.fixedContainingBlock());
    ok(`[${vpTag}] M3 conn-detail/settings 对视口中心 dx/dy=0`, Math.abs(c1.dxViewport) <= 1 && Math.abs(c1.dyViewport) <= 1 && Math.abs(c2.dxViewport) <= 1 && Math.abs(c2.dyViewport) <= 1,
      `conn-detail dx=${c1.dxViewport} dy=${c1.dyViewport} | settings dx=${c2.dxViewport} dy=${c2.dyViewport}`);
    ok(`[${vpTag}] 无祖先建立 fixed 包含块`, fb.length === 0, JSON.stringify(fb));
    await ctx.close();
  }

  // ================= ⑥ toast 绘制顺序的像素实证 =================
  // 为什么必须走像素：.toast-stack 是 pointer-events:none（设计如此，不挡交互），
  // elementFromPoint 原理上永远照不到它；而它在 960×600 / 1024×768 出货尺寸下
  // 与居中对话框也没有几何重叠（toast 右贴边、对话框居中）。故用 680×560 的
  // **合成视口**（低于 tauri minWidth=960 出货下限，仅用于强制制造重叠）采样像素：
  // toast 左边框是 3px 的 --ok 绿条 rgb(127,191,143)，若 toast 绘制在对话框之上，
  // 重叠区内该点应采到绿；toast 自然消失后同一点应回落到对话框底色。
  log('\n================ ⑥ toast 绘制顺序像素实证（680x560 合成视口，强制重叠）=================');
  {
    const ctx = await browser.newContext({ viewport: { width: 680, height: 560 }, colorScheme: 'dark' });
    const page = await boot(ctx);
    await openTools(page, 'tools-conn-detail');
    for (let i = 0; i < 3; i++) { await page.click('[data-testid="cd-copy"]').catch(() => {}); await sleep(330); }
    await sleep(350);
    const g = await page.evaluate(() => {
      const list = [...document.querySelectorAll('.toast')];
      const dlg = document.querySelector('[data-testid="conn-detail"]');
      if (!list.length || !dlg) return { missing: true };
      const t = list[0].getBoundingClientRect(), r = dlg.getBoundingClientRect();
      return { n: list.length,
        toast: { x: Math.round(t.x), y: Math.round(t.y), w: Math.round(t.width), h: Math.round(t.height) },
        dlg: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
        borderLeftColor: getComputedStyle(list[0]).borderLeftColor };
    });
    if (g.missing) { ok('⑥ toast 像素实证前提（toast 与对话框同场）', false, JSON.stringify(g)); }
    else {
      const ovW = Math.max(0, Math.min(g.toast.x + g.toast.w, g.dlg.x + g.dlg.w) - Math.max(g.toast.x, g.dlg.x));
      const ovH = Math.max(0, Math.min(g.toast.y + g.toast.h, g.dlg.y + g.dlg.h) - Math.max(g.toast.y, g.dlg.y));
      const sx = Math.max(g.toast.x, g.dlg.x) + 1, sy = Math.max(g.toast.y, g.dlg.y) + Math.floor(ovH / 2);
      const cx = Math.round(g.dlg.x + g.dlg.w / 2);
      log(`     toast=${JSON.stringify(g.toast)} dlg=${JSON.stringify(g.dlg)} 重叠=${ovW}x${ovH}px 采样点=(${sx},${sy}) 对照点=(${cx},${sy})`);
      const pToast = pngPixel(await page.screenshot({ clip: { x: sx, y: sy, width: 1, height: 1 } }), 0, 0);
      const pCtrl = pngPixel(await page.screenshot({ clip: { x: cx, y: sy, width: 1, height: 1 } }), 0, 0);
      ok('⑥ 重叠区采样点采到 toast 左边框绿条（toast 绘制在对话框之上）',
        ovW > 0 && ovH > 0 && pToast.g > pToast.r && pToast.g > pToast.b && pToast.g > 100,
        `重叠=${ovW}x${ovH}px 采样=rgb(${pToast.r},${pToast.g},${pToast.b}) 期望≈${g.borderLeftColor}`);
      ok('⑥ 对照点（对话框中部同一 y）非绿（排除整屏染绿的假阳性）',
        !(pCtrl.g > pCtrl.r && pCtrl.g > pCtrl.b && pCtrl.g > 100), `对照=rgb(${pCtrl.r},${pCtrl.g},${pCtrl.b})`);
      await page.screenshot({ path: path.join(OUT, 'vis-r41-recheck2-dark-toast-pixelproof-680x560.png') });
      await page.waitForTimeout(3000); // toast 2.6s 自然消失
      const pAfter = pngPixel(await page.screenshot({ clip: { x: sx, y: sy, width: 1, height: 1 } }), 0, 0);
      ok('⑥ 判别性反证：toast 消失后同一点回落为非绿（对话框底色）',
        !(pAfter.g > pAfter.r && pAfter.g > pAfter.b && pAfter.g > 100),
        `消失后=rgb(${pAfter.r},${pAfter.g},${pAfter.b})`);
      layering.push({ what: 'toast-pixel-proof', ...g, overlap: `${ovW}x${ovH}`, sample: `(${sx},${sy})`,
        withToast: `rgb(${pToast.r},${pToast.g},${pToast.b})`, control: `rgb(${pCtrl.r},${pCtrl.g},${pCtrl.b})`,
        afterToastGone: `rgb(${pAfter.r},${pAfter.g},${pAfter.b})` });
    }
    await ctx.close();
  }

  // ================= ⑦ .split-menu 层叠（作者复核期新增改动面）=================
  // 背景：App.tsx:3881-3884 —— `.pop-mask` 与 `.split-menu` 是**同父兄弟**。
  // 把 `.pop-mask` 抬到 41（B5 修复）后，若 `.split-menu` 仍停在 30，则它自己的遮罩
  // 会盖住自己并吃掉点击 → 分屏永久进不去。作者随之把 `.split-menu` 30 → 43（styles.css:890）。
  // 本段独立验证该修复：结构（同父/同层叠上下文）、可达（逐项 elementFromPoint）、功能（真能进分屏），
  // 并做**浏览器内运行时注入**的判别性反证（把 z-index 压回 30 → 应转红），不触碰工作树文件。
  log('\n================ ⑦ .split-menu 层叠（含运行时注入判别）=================');
  {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, colorScheme: 'dark' });
    const page = await boot(ctx);
    // 开两个会话，使分屏菜单里有可点的「复用已有会话」项
    await page.evaluate(() => { [...document.querySelectorAll('.tab')].find((t) => t.textContent.includes('prod-1'))?.click(); });
    await sleep(700);
    await page.evaluate(() => { [...document.querySelectorAll('.tab')].find((t) => t.textContent.includes('staging-1'))?.click(); });
    await sleep(900);
    const openSplit = async () => {
      await page.evaluate(() => { const b = [...document.querySelectorAll('.session-toolbar button')].find((x) => /分屏/.test(x.title || '')); b?.click(); });
      await sleep(450);
    };
    const probeSplit = () => page.evaluate(() => {
      const m = document.querySelector('.split-menu'), k = document.querySelector('.pop-mask');
      if (!m || !k) return { missing: true, menu: !!m, mask: !!k };
      const ctxOf = (el) => { let n = el.parentElement;
        while (n && n !== document.documentElement) { const cs = getComputedStyle(n);
          if (cs.transform !== 'none' || cs.filter !== 'none' || cs.perspective !== 'none' || cs.willChange !== 'auto'
            || cs.contain.includes('paint') || cs.contain.includes('layout') || cs.opacity !== '1'
            || (cs.position !== 'static' && cs.zIndex !== 'auto')) return n;
          n = n.parentElement; }
        return document.documentElement; };
      return { missing: false, menuZ: getComputedStyle(m).zIndex, maskZ: getComputedStyle(k).zIndex,
        sameParent: m.parentElement === k.parentElement,
        sameStackRoot: ctxOf(m) === ctxOf(k),
        items: [...m.querySelectorAll('.sm-item')].map((b) => b.textContent.replace(/\s+/g, ' ').trim().slice(0, 24)),
        occ: window.__vis.occl('.split-menu') };
    });
    await openSplit();
    const g1 = await probeSplit();
    if (g1.missing) { ok('⑦ 分屏菜单可打开', false, JSON.stringify(g1)); }
    else {
      log(`     菜单项=${JSON.stringify(g1.items)}`);
      log(`     menuZ=${g1.menuZ} maskZ=${g1.maskZ} 同父=${g1.sameParent} 同层叠上下文=${g1.sameStackRoot}`);
      log(`     blocked=${g1.occ.blockedN}/${g1.occ.total} ${JSON.stringify(g1.occ.sample)}`);
      ok('⑦ .split-menu 与其遮罩同父（层叠关系需显式声明）', g1.sameParent === true && g1.sameStackRoot === true, `sameParent=${g1.sameParent} sameStackRoot=${g1.sameStackRoot}`);
      ok('⑦ .split-menu z 序高于自己的遮罩', Number(g1.menuZ) > Number(g1.maskZ), `menuZ=${g1.menuZ} maskZ=${g1.maskZ}`);
      ok('⑦ 分屏菜单项逐项可达（blocked=0）', g1.occ.blockedN === 0 && g1.occ.total > 0, `blocked=${g1.occ.blockedN}/${g1.occ.total}`);
      layering.push({ what: 'split-menu', ...g1, occ: undefined, blocked: `${g1.occ.blockedN}/${g1.occ.total}` });
    }
    await page.screenshot({ path: path.join(OUT, 'vis-r41-recheck2-dark-splitmenu.png') });
    // 功能实证（**真实鼠标点击**，Playwright 会做命中检测；程序化 .click() 会绕过遮罩，不可用作证据）
    const realClick = async () => {
      try { await page.click('.split-menu .sm-item', { timeout: 2500 }); return { ok: true }; }
      catch (e) { return { ok: false, err: String(e.message || e).split('\n')[0].slice(0, 110) }; }
    };
    const splitState = () => page.evaluate(() => {
      const b = [...document.querySelectorAll('.session-toolbar button')].find((x) => /分屏/.test(x.title || ''));
      return { pressed: b?.getAttribute('aria-pressed'), title: (b?.title || '').slice(0, 20), menuOpen: document.querySelectorAll('.split-menu').length };
    });
    const c1 = await realClick(); await sleep(1100);
    const s1 = await splitState();
    log(`     真实点击菜单项：${JSON.stringify(c1)} → aria-pressed=${s1.pressed} 菜单已关=${s1.menuOpen === 0} title="${s1.title}"`);
    ok('⑦ 真实鼠标点击菜单项可进入分屏（非程序化 click）', c1.ok === true && s1.pressed === 'true' && s1.menuOpen === 0,
      `click=${c1.ok} pressed=${s1.pressed} menuOpen=${s1.menuOpen}`);
    await page.screenshot({ path: path.join(OUT, 'vis-r41-recheck2-dark-split-entered.png') });
    // 退出分屏，回到可再次打开菜单的状态
    await page.evaluate(() => { const b = [...document.querySelectorAll('.session-toolbar button')].find((x) => /分屏/.test(x.title || '')); b?.click(); });
    await sleep(900);
    // 判别性反证：运行时把**修复前的一对**都钉住（遮罩 41 + 菜单 30），
    // 不能只压菜单——若工作树当前遮罩值不是 41，单压菜单会得不到判别。
    const tag = await page.addStyleTag({ content: '.pop-mask { z-index: 41 !important; } .split-menu { z-index: 30 !important; }' });
    await sleep(300);
    await openSplit();
    const g2 = await probeSplit();
    log(`     [注入 mask41/menu30] menuZ=${g2.menuZ} maskZ=${g2.maskZ} blocked=${g2.occ?.blockedN}/${g2.occ?.total} ${JSON.stringify(g2.occ?.sample)}`);
    ok('⑦ 判别性前置：注入后确为修复前组合（menuZ < maskZ）',
      !!g2.menuZ && Number(g2.menuZ) < Number(g2.maskZ), `menuZ=${g2.menuZ} maskZ=${g2.maskZ}`);
    ok('⑦ 判别性：z-index 压回 30 后菜单项被遮罩挡住（hit-test 口径）',
      !!g2.occ && g2.occ.blockedN > 0, `blocked=${g2.occ?.blockedN}/${g2.occ?.total}`);
    const c2 = await realClick(); await sleep(900);
    const s2 = await splitState();
    log(`     [注入 mask41/menu30] 真实点击：${JSON.stringify(c2)} → aria-pressed=${s2.pressed} 菜单仍开=${s2.menuOpen === 1}`);
    ok('⑦ 判别性：z-index 压回 30 后真实鼠标点击进不去分屏（功能级判别）',
      c2.ok === false && s2.pressed !== 'true', `click=${c2.ok} err=${c2.err || ''} pressed=${s2.pressed}`);
    await page.screenshot({ path: path.join(OUT, 'vis-r41-recheck2-dark-splitmenu-redside.png') });
    // 移除注入
    await tag.evaluate((el) => el.remove());
    await sleep(300);
    ok('⑦ 分屏轮零 JS 错误', page.__errs.length === 0, page.__errs.slice(0, 2).join(' | '));
    await ctx.close();
  }

  // ================= ⑧ B5 判别性（运行时注入复现修复前，不触碰工作树文件）=================
  // 作者给出的红侧判别是「把 .pop-mask/.term-settings 摘回 29/30 → M1 独红」。
  // 这里用 Playwright 运行时注入等价复现（避免在作者并行编辑期间改文件），并用
  // **真实鼠标点击**做功能级判别：修复前对话框被 tp-full 面板压住，点关闭钮必然超时。
  log('\n================ ⑧ B5 判别性（运行时注入 29/30 复现修复前）=================');
  for (const vp of [{ width: 1024, height: 768 }, { width: 960, height: 600 }]) {
    const vpTag = `${vp.width}x${vp.height}`;
    const ctx = await browser.newContext({ viewport: vp, colorScheme: 'dark' });
    const page = await boot(ctx);
    await openTools(page, 'tools-activity'); await sleep(300);
    await openTools(page, 'tools-conn-detail'); await sleep(300);
    const pcls = await panelCls(page);
    const green = await page.evaluate(() => window.__vis.occl('[data-testid="conn-detail"]'));
    const gClick = await page.click('[data-testid="cd-close"]', { timeout: 2500 }).then(() => ({ ok: true })).catch((e) => ({ ok: false, err: String(e.message).split('\n')[0].slice(0, 80) }));
    const gGone = await page.evaluate(() => document.querySelectorAll('[data-testid="conn-detail"]').length);
    log(`     [${vpTag}] 修复态：panel=${pcls} blocked=${green.blockedN}/${green.total} 真实点击关闭钮 ok=${gClick.ok} 对话框已关=${gGone === 0}`);
    ok(`⑧ [${vpTag}] 修复态下真实鼠标点击对话框关闭钮有效`, gClick.ok === true && gGone === 0, `ok=${gClick.ok} gone=${gGone} err=${gClick.err || ''}`);
    // 注入 = 修复前（pop-mask 29 / term-settings 30，均低于 tp-full 的 40）
    const tag = await page.addStyleTag({ content: '.pop-mask { z-index: 29 !important; } .term-settings { z-index: 30 !important; }' });
    await sleep(350);
    await openTools(page, 'tools-conn-detail'); await sleep(350);
    const red = await page.evaluate(() => window.__vis.occl('[data-testid="conn-detail"]'));
    ok(`⑧ [${vpTag}] 判别性前置：注入生效（dlgZ=30 且 panelZ=40）`,
      Number(red.dialog?.z) === 30 && Number(red.panel?.z) === 40,
      `dlgZ=${red.dialog?.z} panelZ=${red.panel?.z}（若不符多为作者并行保存触发 HMR 重载冲掉注入）`);
    // 点「确实被挡住」的那个元素（逐视口可能不同：960×600 下 cd-close 恰落在面板未覆盖处）
    const blockedTid = (red.sample || []).map((s) => s.tid).find((t) => /^[a-z][a-z0-9-]*$/.test(t || ''));
    const rClick = blockedTid
      ? await page.click(`[data-testid="${blockedTid}"]`, { timeout: 2500 }).then(() => ({ ok: true, tid: blockedTid })).catch((e) => ({ ok: false, tid: blockedTid, err: String(e.message).split('\n')[0].slice(0, 80) }))
      : { ok: null, tid: null };
    log(`     [${vpTag}] 修复前：blocked=${red.blockedN}/${red.total} 真实点击被挡元素 [${blockedTid}] ok=${rClick.ok} ${JSON.stringify(red.sample?.slice(0, 3))}`);
    ok(`⑧ [${vpTag}] 判别性：注入 29/30 后对话框被面板压住（blocked>0 且真实点击被挡元素失败）`,
      red.blockedN > 0 && rClick.ok === false, `blocked=${red.blockedN}/${red.total} clickOk=${rClick.ok} tid=${blockedTid}`);
    await page.screenshot({ path: path.join(OUT, `vis-r41-recheck2-dark-${vpTag}-b5-redside.png`) });
    await tag.evaluate((el) => el.remove());
    await ctx.close();
  }

  // ================= 汇总 =================
  log('\n================ CONTRAST ================');
  for (const c of contrasts) log(`${c.pass ? 'ok  ' : 'FAIL'} [${c.theme}] ${c.item}  ratio=${c.ratio} (thr ${c.threshold})  fg=${c.color} bg=${c.bg} fs=${c.fontSize}`);
  log(`contrast: ${contrasts.filter((c) => c.pass).length}/${contrasts.length} pass`);
  log('\n================ OCCLUSION ================');
  for (const o of occlRows) log(`[${o.vp}] ${o.entry} ${o.what}: panel=${o.panelCls} panelZ=${o.panel?.z} dlgZ=${o.dialog?.z} overlapW=${o.overlapW} blocked=${o.blockedN}/${o.total}`);
  fs.writeFileSync(path.join(OUT, 'vis-r41-recheck2-raw.json'), JSON.stringify({ results, contrasts, occlRows, layering }, null, 2));
  const failed = results.filter((r) => !r.pass);
  log(`\nchecks: ${results.length - failed.length}/${results.length} pass`);
  for (const f of failed) log(`  FAIL ${f.name}  [${f.detail}]`);
  await browser.close();
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error('PROBE CRASH', e); process.exit(2); });
