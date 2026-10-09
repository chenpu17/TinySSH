// vis-r41 独立视觉复验探针（R41：连接详情 / 活动记录 / 设置改版 §6.6 / §5 / S09-S11）
// 独立编写：不复用作者探针断言，只读产品代码。聚焦视觉面——WCAG AA 对比度（双主题、
// 真实上下文，含 hover/选中态）、盒测量与裁切、状态实捕、焦点陷阱与 Esc、叠印、回归。
// 域：demo（浏览器，无 Tauri）。不重启作者已开的 5183 服务器。
const { chromium } = require('/Users/chenpu/node_modules/playwright');
const fs = require('fs');
const path = require('path');
const EXE = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const URL = process.env.PROBE_URL || 'http://localhost:5183/';
const BASE = process.env.BASE_URL || 'http://localhost:5184/';
const OUT = process.env.VIS_OUT || __dirname;

const results = [];
const contrasts = [];
const boxes = [];
const log = (s) => console.log(s);
const ok = (name, cond, detail = '') => { results.push({ name, pass: !!cond, detail }); log((cond ? 'PASS ' : 'FAIL ') + name + (detail ? '  [' + detail + ']' : '')); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const count = (page, sel) => page.evaluate((s) => document.querySelectorAll(s).length, sel);
const txt = (page, sel) => page.evaluate((s) => document.querySelector(s)?.textContent ?? null, sel);
const openTools = async (page, testid) => {
  await page.evaluate(() => { [...document.querySelectorAll('.st-tools button')].find((b) => b.textContent.includes('工具'))?.click(); });
  await sleep(220);
  await page.click(`[data-testid="${testid}"]`).catch(() => {});
  await sleep(550);
};

// ---- 页内工具：对比度（祖先背景 alpha 合成）+ 裁切测量 ----
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
    return { sel, color:cs.color, bg:bgStr, fontSize:fs, weight:cs.fontWeight, large, ratio:Math.round(ratio*100)/100, threshold:thr, pass: ratio+1e-9>=thr, text:(el.textContent||'').trim().slice(0,26) };
  },
  clip(sel){ const el=document.querySelector(sel); if(!el) return {sel, missing:true};
    const r=el.getBoundingClientRect(); let clip={l:0,t:0,r:window.innerWidth,b:window.innerHeight};
    let n=el.parentElement;
    while(n && n!==document.documentElement){ const cs=getComputedStyle(n);
      if(cs.overflow!=='visible'||cs.overflowX!=='visible'||cs.overflowY!=='visible'){ const b=n.getBoundingClientRect();
        clip.l=Math.max(clip.l,b.left); clip.t=Math.max(clip.t,b.top); clip.r=Math.min(clip.r,b.right); clip.b=Math.min(clip.b,b.bottom); }
      n=n.parentElement; }
    const vw=Math.max(0,Math.min(r.right,clip.r)-Math.max(r.left,clip.l));
    const vh=Math.max(0,Math.min(r.bottom,clip.b)-Math.max(r.top,clip.t));
    return { sel, rect:{x:Math.round(r.x),y:Math.round(r.y),w:Math.round(r.width),h:Math.round(r.height)},
      clip:{l:Math.round(clip.l),t:Math.round(clip.t),r:Math.round(clip.r),b:Math.round(clip.b)},
      visW:Math.round(vw), visH:Math.round(vh), clippedW:Math.round(r.width-vw), clippedH:Math.round(r.height-vh),
      parent: el.parentElement? el.parentElement.tagName+'.'+String(el.parentElement.className).split(' ')[0]:null,
      parentOverflow: el.parentElement? getComputedStyle(el.parentElement).overflow:null,
      vw: window.innerWidth, vh: window.innerHeight };
  },
  // 对话框居中判定：与视口中心、与包含块中心的偏差
  center(sel){ const el=document.querySelector(sel); if(!el) return {sel,missing:true};
    const r=el.getBoundingClientRect(); const op=el.offsetParent;
    const ob=op?op.getBoundingClientRect():{left:0,top:0,width:window.innerWidth,height:window.innerHeight};
    const cx=r.left+r.width/2, cy=r.top+r.height/2;
    const vcx=window.innerWidth/2, vcy=window.innerHeight/2;
    const ocx=ob.left+ob.width/2, ocy=ob.top+ob.height/2;
    return { sel, cx:Math.round(cx), cy:Math.round(cy), vcx:Math.round(vcx), vcy:Math.round(vcy),
      ocx:Math.round(ocx), ocy:Math.round(ocy),
      dxViewport:Math.round(cx-vcx), dyViewport:Math.round(cy-vcy),
      dxContaining:Math.round(cx-ocx), dyContaining:Math.round(cy-ocy),
      offsetParent: op? op.tagName+'.'+String(op.className).split(' ')[0]:null,
      mask: (()=>{ const m=document.querySelector('.pop-mask'); if(!m) return null; const mb=m.getBoundingClientRect(); const cs=getComputedStyle(m); return {pos:cs.position, w:Math.round(mb.width), h:Math.round(mb.height)}; })() };
  }
};
true;
`;

(async () => {
  const browser = await chromium.launch({ executablePath: EXE, headless: true });

  const measure = (page, sel) => page.evaluate((s) => window.__vis.measure(s), sel);
  const clip = (page, sel) => page.evaluate((s) => window.__vis.clip(s), sel);
  const shot = (page, theme, slug) => page.screenshot({ path: path.join(OUT, `vis-r41-${theme}-${slug}.png`) }).catch(() => {});

  for (const theme of ['dark', 'light']) {
    log(`\n================ THEME: ${theme} ================`);
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, colorScheme: theme, permissions: ['clipboard-read', 'clipboard-write'] });
    const page = await ctx.newPage();
    const jsErrors = [];
    page.on('pageerror', (e) => jsErrors.push(String(e)));
    page.on('console', (m) => { if (m.type() === 'error') jsErrors.push('console.error: ' + m.text()); });
    await page.goto(URL, { waitUntil: 'domcontentloaded' });
    await page.evaluate(() => { try { localStorage.clear(); } catch {} });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.addInitScript(HELPERS);
    await page.evaluate(HELPERS);
    await page.waitForSelector('.host-card', { timeout: 15000 });
    await sleep(500);
    ok(`[${theme}] chrome resolves`, (await page.evaluate(() => document.documentElement.dataset.chrome)) === theme);

    const demoInvoke = (cmd, args) => page.evaluate(async ({ c, a }) => {
      const { invoke } = await import('/src/adapter/bridge.ts');
      return invoke(c, a);
    }, { c: cmd, a: args });
    const waitFor_ = async (fn, tries, gap = 150) => { for (let i = 0; i < tries; i++) { const v = await fn(); if (v) return v; await sleep(gap); } return null; };

    // 激活 demo 预置会话
    await page.evaluate(() => { [...document.querySelectorAll('.tab')].find((t) => t.textContent.includes('prod-1'))?.click(); });
    await sleep(700);
    const sid = (await demoInvoke('list_sessions')).find((s) => s.host_name === 'prod-1').id;

    // ============ 1. 连接详情：几何 + 对比度 + 状态 ============
    await openTools(page, 'tools-conn-detail');
    ok(`[${theme}] conn-detail opens`, (await count(page, '[data-testid="conn-detail"]')) === 1);
    const cbox = await page.evaluate(() => window.__vis.center('[data-testid="conn-detail"]'));
    boxes.push({ theme, vp: '1280x800', what: 'conn-detail-center', ...cbox });
    ok(`[${theme}] conn-detail horizontally centered in *containing block*`, Math.abs(cbox.dxContaining) <= 1, `dxContaining=${cbox.dxContaining}`);
    ok(`[${theme}] conn-detail vertically centered in *containing block*`, Math.abs(cbox.dyContaining) <= 1, `dyContaining=${cbox.dyContaining}`);
    // 视口居中（作者主张「居中对话框」）——记录偏差
    log(`  · conn-detail vs VIEWPORT center: dx=${cbox.dxViewport} dy=${cbox.dyViewport} (offsetParent=${cbox.offsetParent}, mask=${JSON.stringify(cbox.mask)})`);
    for (const s of ['[data-testid="conn-detail"] .cd-k', '[data-testid="conn-detail"] .cd-v', '.cd-fp', '.cd-hint', '.cd-sec h4', '.cd-sidrow code', '[data-testid="cd-copy"]', '.cd-head b']) {
      const m = await measure(page, s); if (!m.missing) contrasts.push({ theme, state: 'conn-detail', ...m });
    }
    await shot(page, theme, 'a-conn-detail');

    // 焦点陷阱 + Esc
    const inDialog = () => page.evaluate(() => {
      const d = document.querySelector('[data-testid="conn-detail"]');
      return { inside: !!d && d.contains(document.activeElement), tag: document.activeElement?.tagName, tid: document.activeElement?.getAttribute('data-testid') };
    });
    const focusSeq = [];
    for (let i = 0; i < 8; i++) { focusSeq.push(await inDialog()); await page.keyboard.press('Tab'); await sleep(50); }
    ok(`[${theme}] conn-detail focus trapped (initial focus inside)`, focusSeq[0].inside, JSON.stringify(focusSeq[0]));
    ok(`[${theme}] conn-detail Tab never escapes to background`, focusSeq.every((f) => f.inside), JSON.stringify(focusSeq.filter((f) => !f.inside).slice(0, 3)));
    // Esc
    await page.keyboard.press('Escape'); await sleep(350);
    const afterEsc = await count(page, '[data-testid="conn-detail"]');
    ok(`[${theme}] conn-detail closes on Esc`, afterEsc === 0, `still-open=${afterEsc}`);
    if (afterEsc !== 0) { await page.click('[data-testid="cd-close"]').catch(() => {}); await sleep(250); }
    // 关闭后焦点回到触发前
    ok(`[${theme}] conn-detail closes via ✕`, (await count(page, '[data-testid="conn-detail"]')) === 0);

    // ============ 2. 活动记录：几何 + 对比度 + 状态 ============
    await openTools(page, 'tools-activity');
    ok(`[${theme}] activity log view opens`, (await count(page, '[data-testid="log-note"]')) === 1);
    for (const s of ['[data-testid="log-row"] .tl-meta', '[data-testid="log-note"]', '.log-sid', '.log-filters label',
      '.seg button:not(.on)', '.seg button.on', '.tl-action', '.log-row .tl-cmd-text', '[data-testid="log-refresh"]']) {
      const m = await measure(page, s); if (!m.missing) contrasts.push({ theme, state: 'log', ...m });
    }
    // hover 态：范围段钮 / 设置导航钮
    await page.hover('.seg button:not(.on)').catch(() => {});
    await sleep(150);
    { const m = await measure(page, '.seg button:not(.on)'); if (!m.missing) contrasts.push({ theme, state: 'log-hover', ...m }); }
    await shot(page, theme, 'b-activity-log');

    const lbar = await clip(page, '.log-bar');
    const lfil = await clip(page, '.log-filters');
    boxes.push({ theme, vp: '1280x800', what: 'log-bar', ...lbar }, { theme, vp: '1280x800', what: 'log-filters', ...lfil });
    ok(`[${theme}] log-bar no overflow`, lbar.clippedW === 0 && lbar.clippedH === 0, JSON.stringify({ w: lbar.clippedW, h: lbar.clippedH }));
    ok(`[${theme}] log-filters no overflow`, lfil.clippedW === 0 && lfil.clippedH === 0, JSON.stringify({ w: lfil.clippedW, h: lfil.clippedH }));
    const fwrap = await page.evaluate(() => {
      const e = document.querySelector('.log-filters'); if (!e) return null;
      const labels = [...e.querySelectorAll('label')].map((l) => { const r = l.getBoundingClientRect(); return { t: Math.round(r.top), b: Math.round(r.bottom) }; });
      const rows = new Set(labels.map((l) => l.t));
      return { rows: rows.size, labels, scrollW: e.scrollWidth, clientW: e.clientWidth };
    });
    ok(`[${theme}] log-filters labels share one row at 1280 (no stray wrap)`, fwrap && fwrap.rows === 1, JSON.stringify(fwrap));
    // 空态：筛选到无结果
    await page.selectOption('[data-testid="log-action"]', 'host_key_trusted').catch(() => {});
    await sleep(600);
    const emptyShown = await count(page, '[data-testid="log-empty"]');
    ok(`[${theme}] filtered-to-empty shows empty state`, emptyShown === 1, `log-empty=${emptyShown}`);
    if (emptyShown) { const m = await measure(page, '[data-testid="log-empty"]'); contrasts.push({ theme, state: 'log-empty', ...m }); await shot(page, theme, 'c-log-empty'); }
    await page.selectOption('[data-testid="log-action"]', '').catch(() => {});
    await sleep(500);
    ok(`[${theme}] rows return after clearing filter`, (await count(page, '[data-testid="log-row"]')) > 0);
    // 未接入会话空态（cd-err / log-empty-nosession 在后续独立上下文测）

    // ============ 3. 设置：几何 + 对比度 + 状态 + 草稿 ============
    await page.click('.hb-settings');
    await sleep(500);
    ok(`[${theme}] settings dialog opens`, (await count(page, '.term-settings.settings-wide')) === 1);
    const sbox = await page.evaluate(() => window.__vis.center('.term-settings.settings-wide'));
    boxes.push({ theme, vp: '1280x800', what: 'settings-center', ...sbox });
    ok(`[${theme}] settings centered in containing block`, Math.abs(sbox.dxContaining) <= 1 && Math.abs(sbox.dyContaining) <= 1, JSON.stringify({ dx: sbox.dxContaining, dy: sbox.dyContaining }));
    log(`  · settings vs VIEWPORT center: dx=${sbox.dxViewport} dy=${sbox.dyViewport}`);
    const sclip = await clip(page, '.term-settings.settings-wide');
    ok(`[${theme}] settings not clipped`, sclip.clippedW === 0 && sclip.clippedH === 0, JSON.stringify({ w: sclip.clippedW, h: sclip.clippedH }));
    // 焦点陷阱（干净态：刚打开、未做其它交互）
    const sFocusClean = [];
    for (let i = 0; i < 8; i++) {
      sFocusClean.push(await page.evaluate(() => { const d = document.querySelector('.term-settings.settings-wide'); return { inside: !!d && d.contains(document.activeElement), tid: document.activeElement?.getAttribute('data-testid'), tag: document.activeElement?.tagName }; }));
      await page.keyboard.press('Tab'); await sleep(45);
    }
    ok(`[${theme}] settings initial focus inside dialog`, sFocusClean[0].inside, JSON.stringify(sFocusClean[0]));
    ok(`[${theme}] settings Tab never escapes (clean open)`, sFocusClean.every((f) => f.inside), JSON.stringify(sFocusClean.filter((f) => !f.inside)));
    for (const s of ['.settings-nav button:not(.on)', '.settings-nav button.on', '.ts-label', '.settings-pane']) {
      const m = await measure(page, s); if (!m.missing) contrasts.push({ theme, state: 'settings', ...m });
    }
    await page.hover('.settings-nav button:not(.on)').catch(() => {}); await sleep(150);
    { const m = await measure(page, '.settings-nav button:not(.on)'); if (!m.missing) contrasts.push({ theme, state: 'settings-hover', ...m }); }
    await shot(page, theme, 'd-settings-appearance');
    // 外观/终端分类内容完整（回归：280px→620px 后不裁）
    const appearanceContent = await page.evaluate(() => {
      const p = document.querySelector('[data-testid="settings-pane-appearance"]');
      if (!p) return null;
      const pr = p.getBoundingClientRect();
      const kids = [...p.children].map((c) => { const r = c.getBoundingClientRect(); return { cls: String(c.className).slice(0, 20), bottom: Math.round(r.bottom), cut: r.bottom > pr.bottom + 1 }; });
      return { paneH: Math.round(pr.height), paneScrollH: p.scrollHeight, paneClientH: p.clientHeight, kids, cutAny: kids.some((k) => k.cut) };
    });
    ok(`[${theme}] appearance pane content not cut`, appearanceContent && !appearanceContent.cutAny, JSON.stringify(appearanceContent));
    await page.click('[data-testid="settings-cat-terminal"]'); await sleep(350);
    const termPane = await clip(page, '[data-testid="settings-pane-terminal"]');
    ok(`[${theme}] terminal pane not cut`, termPane.clippedW === 0 && termPane.clippedH === 0, JSON.stringify({ w: termPane.clippedW, h: termPane.clippedH }));
    await shot(page, theme, 'e-settings-terminal');

    // 凭据分类：空态 / 新建表单 / 草稿
    await page.click('[data-testid="settings-cat-credentials"]'); await sleep(450);
    const credEmpty = await count(page, '[data-testid="cred-empty"]');
    ok(`[${theme}] credentials empty state present`, credEmpty === 1);
    if (credEmpty) { const m = await measure(page, '[data-testid="cred-empty"]'); contrasts.push({ theme, state: 'cred-empty', ...m }); }
    await page.click('[data-testid="cred-new"]').catch(() => {}); await sleep(300);
    ok(`[${theme}] cred new form expands`, (await count(page, '[data-testid="cred-new-form"]')) === 1);
    for (const s of ['[data-testid="cred-new-form"] .cred-field', '[data-testid="cred-new-form"] input', '[data-testid="cred-new-form"] button']) {
      const m = await measure(page, s); if (!m.missing) contrasts.push({ theme, state: 'cred-form', ...m });
    }
    await shot(page, theme, 'f-cred-form');
    // 草稿保护对话框
    await page.evaluate(() => {
      const el = document.querySelector('[data-testid="cred-new-pem"]');
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
      setter.call(el, '-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----');
      el.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await sleep(250);
    await page.click('[data-testid="settings-cat-appearance"]').catch(() => {}); await sleep(350);
    const draftShown = await count(page, '[data-testid="cred-draft"]');
    ok(`[${theme}] draft guard dialog appears on category switch`, draftShown === 1);
    if (draftShown) {
      const m = await measure(page, '[data-testid="cred-draft"]'); contrasts.push({ theme, state: 'cred-draft', ...m });
      const c = await clip(page, '[data-testid="cred-draft"]');
      ok(`[${theme}] draft guard not clipped`, c.clippedW === 0 && c.clippedH === 0, JSON.stringify({ w: c.clippedW, h: c.clippedH }));
      await shot(page, theme, 'g-cred-draft');
    }
    await page.click('[data-testid="cred-draft-keep"]').catch(() => {}); await sleep(250);
    // 焦点陷阱（动态移除后）：草稿框内的钮被移除，焦点落点
    const sFocus = [];
    for (let i = 0; i < 6; i++) {
      sFocus.push(await page.evaluate(() => { const d = document.querySelector('.term-settings.settings-wide'); return { inside: !!d && d.contains(document.activeElement), tid: document.activeElement?.getAttribute('data-testid'), tag: document.activeElement?.tagName }; }));
      await page.keyboard.press('Tab'); await sleep(45);
    }
    log(`  · settings focus after dynamic removal: ${JSON.stringify(sFocus)}`);
    ok(`[${theme}] settings Tab never escapes after draft resolved`, sFocus.every((f) => f.inside), JSON.stringify(sFocus.filter((f) => !f.inside)));
    await page.keyboard.press('Escape'); await sleep(400);
    const sAfterEsc = await count(page, '.term-settings.settings-wide');
    ok(`[${theme}] settings closes on Esc`, sAfterEsc === 0, `still-open=${sAfterEsc}`);
    if (sAfterEsc) { await page.click('[data-testid="settings-close"]').catch(() => {}); await sleep(250); }
    await page.click('[data-testid="cred-draft-discard"]').catch(() => {});

    // ============ 4. 叠印：对话框 vs toast / 队列抽屉 ============
    await openTools(page, 'tools-conn-detail');
    await page.evaluate(async () => {
      // 触发一次 toast（复制钮成功/失败都会 toast）
      const b = document.querySelector('[data-testid="cd-copy"]'); b?.click();
    });
    await sleep(400);
    const overlap = await page.evaluate(() => {
      const t = document.querySelector('.toast'); const d = document.querySelector('[data-testid="conn-detail"]');
      if (!t || !d) return { toast: !!t, dialog: !!d };
      const tr = t.getBoundingClientRect(), dr = d.getBoundingClientRect();
      const inter = !(tr.right < dr.left || tr.left > dr.right || tr.bottom < dr.top || tr.top > dr.bottom);
      const tz = getComputedStyle(t).zIndex, dz = getComputedStyle(d).zIndex;
      return { toast: true, dialog: true, intersects: inter, toastZ: tz, dialogZ: dz };
    });
    ok(`[${theme}] toast & conn-detail do not visually collide`, !overlap.intersects, JSON.stringify(overlap));
    await shot(page, theme, 'h-toast-overlap');
    await page.click('[data-testid="cd-close"]').catch(() => {}); await sleep(250);

    ok(`[${theme}] zero JS errors`, jsErrors.length === 0, jsErrors.slice(0, 3).join(' | '));
    await ctx.close();
  }

  // ============ 5. 几何：4 视口（居中/裁切）============
  log('\n================ GEOMETRY @ 4 VIEWPORTS (dark) ================');
  for (const vp of [{ width: 1440, height: 900 }, { width: 1280, height: 800 }, { width: 1024, height: 768 }, { width: 960, height: 600 }]) {
    const ctx = await browser.newContext({ viewport: vp, colorScheme: 'dark' });
    const page = await ctx.newPage();
    await page.goto(URL, { waitUntil: 'domcontentloaded' });
    await page.evaluate(() => { try { localStorage.clear(); } catch {} });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.addInitScript(HELPERS); await page.evaluate(HELPERS);
    await page.waitForSelector('.host-card', { timeout: 15000 }); await sleep(500);
    await page.evaluate(() => { [...document.querySelectorAll('.tab')].find((t) => t.textContent.includes('prod-1'))?.click(); });
    await sleep(600);
    const vpTag = `${vp.width}x${vp.height}`;
    log(`\n--- ${vpTag} ---`);
    // 连接详情
    await openTools(page, 'tools-conn-detail');
    const cd = await clip(page, '[data-testid="conn-detail"]');
    const cdC = await page.evaluate(() => window.__vis.center('[data-testid="conn-detail"]'));
    boxes.push({ theme: 'dark', vp: vpTag, what: 'conn-detail', ...cd });
    log(`  conn-detail rect=${JSON.stringify(cd.rect)} clippedW=${cd.clippedW} clippedH=${cd.clippedH} dxViewport=${cdC.dxViewport}`);
    ok(`[${vpTag}] conn-detail fully within viewport`, cd.clippedW === 0, `clippedW=${cd.clippedW}`);
    ok(`[${vpTag}] conn-detail not clipped by pane`, cd.clippedH === 0, `clippedH=${cd.clippedH} (rect.h=${cd.rect.h})`);
    const cdKids = await page.evaluate(() => {
      const d = document.querySelector('[data-testid="conn-detail"]');
      const tw = document.querySelector('.term-wrap').getBoundingClientRect();
      return [...d.children].map((c) => { const r = c.getBoundingClientRect(); return { cls: String(c.className).slice(0, 20), top: Math.round(r.top), bottom: Math.round(r.bottom), cutTop: Math.round(Math.max(0, tw.top - r.top)), cutBottom: Math.round(Math.max(0, r.bottom - tw.bottom)) }; });
    });
    log(`  conn-detail child clip: ${JSON.stringify(cdKids)}`);
    await page.screenshot({ path: path.join(OUT, `vis-r41-dark-geo-${vpTag}-condetail.png`) });
    await page.click('[data-testid="cd-close"]').catch(() => {}); await sleep(250);
    // 设置（含凭据表单展开——最高内容态）
    await page.click('.hb-settings'); await sleep(500);
    const st = await clip(page, '.term-settings.settings-wide');
    const stC = await page.evaluate(() => window.__vis.center('.term-settings.settings-wide'));
    boxes.push({ theme: 'dark', vp: vpTag, what: 'settings', ...st });
    log(`  settings rect=${JSON.stringify(st.rect)} clippedW=${st.clippedW} clippedH=${st.clippedH} dxViewport=${stC.dxViewport}`);
    ok(`[${vpTag}] settings not clipped`, st.clippedW === 0 && st.clippedH === 0, JSON.stringify({ w: st.clippedW, h: st.clippedH }));
    await page.click('[data-testid="settings-cat-credentials"]'); await sleep(400);
    await page.click('[data-testid="cred-new"]').catch(() => {}); await sleep(350);
    const stCred = await clip(page, '.term-settings.settings-wide');
    const paneClip = await clip(page, '.settings-pane');
    // 逐子元素裁切诊断：哪一段内容被切
    const credKids = await page.evaluate(() => {
      const d = document.querySelector('.term-settings.settings-wide');
      const tw = document.querySelector('.term-wrap').getBoundingClientRect();
      const walk = (root, depth) => [...root.children].flatMap((c) => {
        const r = c.getBoundingClientRect();
        const cut = r.top < tw.top - 0.5 || r.bottom > tw.bottom + 0.5;
        const self = cut ? [{ cls: String(c.className).slice(0, 24), top: Math.round(r.top), bottom: Math.round(r.bottom), cut: true, text: (c.textContent || '').trim().slice(0, 22) }] : [];
        return self.concat(depth < 3 ? walk(c, depth + 1) : []);
      });
      return { twTop: Math.round(tw.top), twBottom: Math.round(tw.bottom), cut: walk(d, 0) };
    });
    log(`  settings cred-form cut nodes: ${JSON.stringify(credKids)}`);
    log(`  settings(cred-form) rect=${JSON.stringify(stCred.rect)} clippedH=${stCred.clippedH} paneClippedH=${paneClip.clippedH} paneScroll=${JSON.stringify(await page.evaluate(() => { const e=document.querySelector('.settings-pane'); return e?[e.scrollHeight,e.clientHeight]:null; }))}`);
    ok(`[${vpTag}] settings cred-form not clipped by pane`, stCred.clippedH === 0, `clippedH=${stCred.clippedH}`);
    await page.screenshot({ path: path.join(OUT, `vis-r41-dark-geo-${vpTag}-settings.png`) });
    await page.click('[data-testid="settings-close"]').catch(() => {}); await sleep(250);
    // 活动记录
    await openTools(page, 'tools-activity');
    const lb = await clip(page, '.log-bar'); const lf = await clip(page, '.log-filters');
    const wrap = await page.evaluate(() => { const e=document.querySelector('.log-filters'); if(!e) return null; const rows=new Set([...e.querySelectorAll('label')].map(l=>Math.round(l.getBoundingClientRect().top))); return { rows: rows.size, scrollW: e.scrollWidth, clientW: e.clientWidth }; });
    log(`  log-bar clippedW=${lb.clippedW}  log-filters clippedW=${lf.clippedW} wrap=${JSON.stringify(wrap)}`);
    ok(`[${vpTag}] log-bar no overflow`, lb.clippedW === 0, `clippedW=${lb.clippedW}`);
    ok(`[${vpTag}] log-filters no horizontal overflow`, lf.clippedW === 0, `clippedW=${lf.clippedW}`);
    ok(`[${vpTag}] log-filters no stray wrap`, wrap && wrap.rows === 1, JSON.stringify(wrap));
    await page.screenshot({ path: path.join(OUT, `vis-r41-dark-geo-${vpTag}-log.png`) });
    // 队列抽屉并存（R35）——打开抽屉后开连接详情，量两者几何关系与遮挡
    await page.click('[data-testid="sb-transfer"]').catch(() => {});
    await sleep(350);
    const drawerOpen = await count(page, '[data-testid="queue-drawer"]');
    log(`  queue drawer open = ${drawerOpen}`);
    if (drawerOpen) {
      await openTools(page, 'tools-conn-detail');
      const ov = await page.evaluate(() => {
        const d = document.querySelector('.queue-drawer'), c = document.querySelector('[data-testid="conn-detail"]');
        if (!d || !c) return { missing: true };
        const dr = d.getBoundingClientRect(), cr = c.getBoundingClientRect();
        const inter = !(cr.right < dr.left || cr.left > dr.right || cr.bottom < dr.top || cr.top > dr.bottom);
        // 命中测试：抽屉中心点处最上层是谁
        const el = document.elementFromPoint(Math.round(dr.left + dr.width / 2), Math.round(dr.top + dr.height / 2));
        const top = el ? el.closest('[data-testid="conn-detail"]') ? 'conn-detail' : el.closest('[data-testid="queue-drawer"]') ? 'queue-drawer' : (el.className || el.tagName) : 'none';
        return { drawerRect: { x: Math.round(dr.x), y: Math.round(dr.y), w: Math.round(dr.width), h: Math.round(dr.height) },
          dialogRect: { x: Math.round(cr.x), y: Math.round(cr.y), w: Math.round(cr.width), h: Math.round(cr.height) }, intersects: inter, topAtDrawerCenter: String(top) };
      });
      log(`  drawer vs conn-detail: ${JSON.stringify(ov)}`);
      ok(`[${vpTag}] queue drawer & conn-detail: modal paints above (no reverse occlusion)`, !ov.missing && ov.topAtDrawerCenter !== 'queue-drawer', JSON.stringify(ov));
      await page.screenshot({ path: path.join(OUT, `vis-r41-dark-geo-${vpTag}-drawer.png`) });
      await page.click('[data-testid="cd-close"]').catch(() => {}); await sleep(250);
      await page.click('[data-testid="sb-transfer"]').catch(() => {}); await sleep(250);
    }
    await ctx.close();
  }

  // ============ 6. 状态：未接入会话（log-empty-nosession / 段钮禁用）============
  // 可达路径：会话头只在有 current 时渲染，故「无会话」不能直接开工具菜单——
  // 先接会话→开活动记录→用 UI 的「关闭会话…」流程断开（这条会真正清 sid）。
  log('\n================ NO-SESSION STATE (dark) ================');
  {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, colorScheme: 'dark' });
    const page = await ctx.newPage();
    await page.goto(URL, { waitUntil: 'domcontentloaded' });
    await page.evaluate(() => { try { localStorage.clear(); } catch {} });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.addInitScript(HELPERS); await page.evaluate(HELPERS);
    await page.waitForSelector('.host-card', { timeout: 15000 }); await sleep(500);
    // 先确认：无会话时没有「工具」菜单入口（会话头条件渲染）
    const menuReachable = await page.evaluate(() => !!document.querySelector('.st-tools button') && !document.querySelector('.welcome') === false);
    const welcomeShown = await page.evaluate(() => !!document.querySelector('.welcome'));
    log(`  no-session start: welcome=${welcomeShown}; tools menu reachable=${menuReachable}`);
    await page.evaluate(() => { [...document.querySelectorAll('.tab')].find((t) => t.textContent.includes('prod-1'))?.click(); });
    await sleep(700);
    await openTools(page, 'tools-activity');
    ok('[nosession] log panel open with session', (await count(page, '[data-testid="log-row"]')) > 0, `rows=${await count(page, '[data-testid="log-row"]')}`);
    // 用 UI 关闭会话
    await page.evaluate(() => { [...document.querySelectorAll('.st-tools button')].find((b) => b.textContent.includes('工具'))?.click(); });
    await sleep(250);
    await page.evaluate(() => { [...document.querySelectorAll('.tools-menu button')].find((b) => b.textContent.includes('关闭会话'))?.click(); });
    await sleep(400);
    await page.evaluate(() => { const b = [...document.querySelectorAll('.confirm-dialog button')].find((x) => /关闭会话/.test(x.textContent)); b?.click(); });
    await sleep(900);
    const noSess = await count(page, '[data-testid="log-empty-nosession"]');
    ok('[nosession] activity log shows no-session hint after disconnect', noSess === 1, `nosession=${noSess}`);
    if (noSess) { const m = await measure(page, '[data-testid="log-empty-nosession"]'); contrasts.push({ theme: 'dark', state: 'log-nosession', ...m }); await shot(page, 'dark', 'j-log-nosession'); }
    const curDisabled = await page.evaluate(() => document.querySelector('[data-testid="log-scope-current"]')?.disabled);
    ok('[nosession] current-scope button disabled when no session', curDisabled === true, String(curDisabled));
    // 切「全部会话」应能恢复记录（记录不随会话消失）
    await page.click('[data-testid="log-scope-all"]').catch(() => {}); await sleep(800);
    ok('[nosession] switching to all-scope restores rows', (await count(page, '[data-testid="log-row"]')) > 0, `rows=${await count(page, '[data-testid="log-row"]')}`);
    await ctx.close();
  }

  // ============ 7. 翻页钮（需 >40 条记录）：生成事件 ============
  log('\n================ LOG PAGING (dark) ================');
  {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, colorScheme: 'dark' });
    const page = await ctx.newPage();
    await page.goto(URL, { waitUntil: 'domcontentloaded' });
    await page.evaluate(() => { try { localStorage.clear(); } catch {} });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.addInitScript(HELPERS); await page.evaluate(HELPERS);
    await page.waitForSelector('.host-card', { timeout: 15000 }); await sleep(500);
    // 先接上会话，再生成事件（否则会话头不渲染、面板入口不可达）
    await page.evaluate(() => { [...document.querySelectorAll('.tab')].find((t) => t.textContent.includes('prod-1'))?.click(); });
    await sleep(700);
    // 生成 >40 条审计事件：连-断 25 次（prod-1 已信任，无门）
    const made = await page.evaluate(async () => {
      const { invoke } = await import('/src/adapter/bridge.ts');
      let n = 0;
      for (let i = 0; i < 25; i++) {
        try { const s = await invoke('create_session', { hostId: 'h-prod1' }); await invoke('close_session', { sid: s.id }); n++; } catch { /* skip */ }
      }
      const q = await invoke('audit_query', { sid: null, limit: 1 });
      return { cycles: n, total: q.total };
    });
    log(`  generated ${made.cycles} connect/disconnect cycles; audit total=${made.total}`);
    await sleep(400);
    await page.evaluate(() => { [...document.querySelectorAll('.tab')].find((t) => t.textContent.includes('prod-1'))?.click(); });
    await sleep(600);
    await openTools(page, 'tools-activity');
    await page.click('[data-testid="log-scope-all"]').catch(() => {}); await sleep(900);
    const rows = await count(page, '[data-testid="log-row"]');
    const more = await count(page, '[data-testid="log-more"]');
    log(`  rows=${rows} log-more=${more}`);
    ok('[paging] more-button appears when events exceed page size', more === 1, `rows=${rows} more=${more} total=${made.total}`);
    if (more) {
      const m = await measure(page, '[data-testid="log-more"]'); contrasts.push({ theme: 'dark', state: 'log-more', ...m });
      const before = rows;
      await page.click('[data-testid="log-more"]'); await sleep(900);
      const after = await count(page, '[data-testid="log-row"]');
      ok('[paging] more-button loads older events (count grows)', after > before, `${before} -> ${after}`);
      const stillMore = await count(page, '[data-testid="log-more"]');
      ok('[paging] more-button disappears at end of list', stillMore === 0, `still-more=${stillMore}`);
      await shot(page, 'dark', 'k-log-paging');
    }
    await ctx.close();
  }

  // ============ 8. 回归：基线 :5184 设置对话框内容对照 ============
  log('\n================ REGRESSION vs BASELINE :5184 ================');
  try {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, colorScheme: 'dark' });
    const page = await ctx.newPage();
    await page.goto(BASE, { waitUntil: 'domcontentloaded' });
    await page.evaluate(() => { try { localStorage.clear(); } catch {} });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.host-card', { timeout: 15000 }); await sleep(500);
    await page.click('.hb-settings'); await sleep(600);
    const baseInfo = await page.evaluate(() => {
      const el = document.querySelector('.term-settings');
      if (!el) return { missing: true };
      const r = el.getBoundingClientRect();
      return { rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
        hasNav: !!document.querySelector('.settings-nav'), hasWide: !!document.querySelector('.settings-wide'),
        text: (el.textContent || '').slice(0, 200) };
    });
    log(`  baseline settings: ${JSON.stringify(baseInfo)}`);
    ok('[baseline] baseline uses the old 280px right-top panel (not wide)', baseInfo.hasWide === false && baseInfo.rect.w <= 300, JSON.stringify({ w: baseInfo.rect.w, wide: baseInfo.hasWide }));
    await page.screenshot({ path: path.join(OUT, 'vis-r41-baseline-settings.png') });
    // 基线里设置是否包含「凭据」分类文本（对照 R41 的分类）
    ok('[baseline] baseline settings has credentials section text', /凭据/.test(baseInfo.text || ''), (baseInfo.text || '').slice(0, 80));
    await ctx.close();
  } catch (e) { log('  baseline probe failed: ' + String(e).split('\n')[0]); }

  // ---- 汇总 ----
  log('\n================ CONTRAST (WCAG AA) ================');
  const fails = contrasts.filter((c) => !c.pass);
  for (const c of contrasts) log(`${c.pass ? 'ok  ' : 'FAIL'} [${c.theme}/${c.state}] ${c.sel}  ratio=${c.ratio} (thr ${c.threshold})  fg=${c.color} bg=${c.bg} fs=${c.fontSize}`);
  log(`\ncontrast: ${contrasts.length - fails.length}/${contrasts.length} pass; ${fails.length} FAIL`);
  for (const f of fails) log(`  FAIL [${f.theme}/${f.state}] ${f.sel} ratio=${f.ratio} < ${f.threshold} (fg=${f.color} bg=${f.bg} fs=${f.fontSize})`);

  fs.writeFileSync(path.join(OUT, 'vis-r41-probe-raw.json'), JSON.stringify({ results, contrasts, boxes }, null, 2));
  log('\n================ SUMMARY ================');
  const failed = results.filter((r) => !r.pass);
  log(`checks: ${results.length - failed.length}/${results.length} pass`);
  for (const f of failed) log(`  FAIL ${f.name}  [${f.detail}]`);
  await browser.close();
})().catch((e) => { console.error('PROBE CRASH', e); process.exit(2); });
