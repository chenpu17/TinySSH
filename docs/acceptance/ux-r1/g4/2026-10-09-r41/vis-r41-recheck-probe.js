// vis-r41 处置后**定向复验**探针 v2（独立编写，只读产品代码；域 demo 5183）
// v2 修正 v1 的两处探针缺陷：
//   (a) clip() 对 position:fixed 误用祖先 overflow——fixed 的包含块是视口，祖先 overflow 不裁它
//       （除非祖先有 transform/filter/contain，已由 fixedContainingBlock() 实证为无）。v2 对 fixed 只按视口裁，
//       并补 hit-test（elementFromPoint 四角+中心）作为「真的可见」的独立口径。
//   (b) 关对话框改用 Esc（cd-close 在 tp-full 遮挡下点不到，那本身是缺陷不是探针问题）。
// 新增：右栏 tp-full 态下的层叠遮挡量化（诊断期发现，见 findings B5）。
const { chromium } = require('/Users/chenpu/node_modules/playwright');
const fs = require('fs');
const path = require('path');
const EXE = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const URL = process.env.PROBE_URL || 'http://localhost:5183/';
const OUT = process.env.VIS_OUT || __dirname;

const results = [];
const contrasts = [];
const boxes = [];
const occlusion = [];
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
    return { sel, color:cs.color, bg:bgStr, fontSize:fs, large, ratio:Math.round(ratio*100)/100, threshold:thr, pass: ratio+1e-9>=thr, text:(el.textContent||'').trim().slice(0,26), hovered: el.matches(':hover') };
  },
  // fixed 感知的裁切：fixed 元素只按视口裁（祖先 overflow 不适用，除非祖先建了包含块——由 fixedContainingBlock 排除）
  clip(sel){ const el=document.querySelector(sel); if(!el) return {sel, missing:true};
    const r=el.getBoundingClientRect(); const pos=getComputedStyle(el).position;
    const vw0=window.innerWidth, vh0=window.innerHeight;
    let clip={l:0,t:0,r:vw0,b:vh0};
    if(pos!=='fixed'){ let n=el.parentElement;
      while(n && n!==document.documentElement){ const cs=getComputedStyle(n);
        if(cs.overflow!=='visible'||cs.overflowX!=='visible'||cs.overflowY!=='visible'){ const b=n.getBoundingClientRect();
          clip.l=Math.max(clip.l,b.left); clip.t=Math.max(clip.t,b.top); clip.r=Math.min(clip.r,b.right); clip.b=Math.min(clip.b,b.bottom); }
        n=n.parentElement; } }
    const w=Math.max(0,Math.min(r.right,clip.r)-Math.max(r.left,clip.l));
    const h=Math.max(0,Math.min(r.bottom,clip.b)-Math.max(r.top,clip.t));
    // 可见性口径：元素中心是否由自身/后代接住（四角因 border-radius 会落到圆角外，不作为口径）。
    // 逐元素可达性另由 occl() 审计（每个交互元素中心点）。
    const t=document.elementFromPoint(r.left+r.width/2, r.top+r.height/2);
    const hitCenter = !!t && (el===t||el.contains(t));
    return { sel, rect:{x:Math.round(r.x),y:Math.round(r.y),w:Math.round(r.width),h:Math.round(r.height)},
      clippedW:Math.round(r.width-w), clippedH:Math.round(r.height-h), pos, vw:vw0, vh:vh0, hitCenter };
  },
  center(sel){ const el=document.querySelector(sel); if(!el) return {sel,missing:true};
    const r=el.getBoundingClientRect(); const cx=r.left+r.width/2, cy=r.top+r.height/2;
    return { sel, cx:Math.round(cx), cy:Math.round(cy),
      dxViewport:Math.round(cx-window.innerWidth/2), dyViewport:Math.round(cy-window.innerHeight/2),
      pos: getComputedStyle(el).position };
  },
  fixedContainingBlock(){ const bad=[]; let m=document.querySelector('.term-wrap');
    while(m && m!==document.documentElement){ const cs=getComputedStyle(m);
      if(cs.transform!=='none'||cs.filter!=='none'||cs.perspective!=='none'||cs.contain!=='none'||cs.willChange!=='auto') bad.push(String(m.className).split(' ')[0]);
      m=m.parentElement; }
    return bad; },
  // 遮挡审计：对话框内交互元素有几个被别的元素盖住（tp-full 面板 z40 > 对话框 z30）
  occl(dlgSel){ const dlg=document.querySelector(dlgSel); if(!dlg) return {missing:true};
    const panel=document.querySelector('.task-panel'); const pr=panel?.getBoundingClientRect(), dr=dlg.getBoundingClientRect();
    const els=[...dlg.querySelectorAll('button, input, textarea, select, [data-testid]')];
    const blocked=[];
    for(const e of els){ const b=e.getBoundingClientRect(); if(!b.width||!b.height) continue;
      const h=document.elementFromPoint(b.left+b.width/2, b.top+b.height/2);
      if(!(h&&(e===h||e.contains(h)||h.contains(e)))) blocked.push({ tid:e.getAttribute('data-testid')||String(e.className).slice(0,20), by:String(h?.className||h?.tagName).slice(0,28) }); }
    return { dialog:{x:Math.round(dr.x),y:Math.round(dr.y),w:Math.round(dr.width),h:Math.round(dr.height),z:getComputedStyle(dlg).zIndex},
      panel: pr? {cls:String(panel.className), x:Math.round(pr.x), w:Math.round(pr.width), z:getComputedStyle(panel).zIndex, pos:getComputedStyle(panel).position}:null,
      overlapW: pr? Math.round(Math.max(0,Math.min(dr.right,pr.right)-Math.max(dr.left,pr.left))):0,
      total: els.length, blockedN: blocked.length, sample: blocked.slice(0,6) }; }
};
true;
`;

(async () => {
  const browser = await chromium.launch({ executablePath: EXE, headless: true });
  const measure = (page, sel) => page.evaluate((s) => window.__vis.measure(s), sel);
  const clip = (page, sel) => page.evaluate((s) => window.__vis.clip(s), sel);
  const shot = (page, theme, slug) => page.screenshot({ path: path.join(OUT, `vis-r41-recheck-${theme}-${slug}.png`) }).catch(() => {});
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
    page.__errs = errs; return page;
  };
  const openTools = async (page, testid) => {
    await page.evaluate(() => { [...document.querySelectorAll('.st-tools button')].find((b) => b.textContent.includes('工具'))?.click(); });
    await sleep(250);
    try { await page.click(`[data-testid="${testid}"]`, { timeout: 3000 }); } catch { log(`    (openTools ${testid} 点击被拦——见遮挡项)`); }
    await sleep(600);
  };

  // ============ 主题循环：B1-B4 / M2 / L2 / B2 / B3 ============
  for (const theme of ['dark', 'light']) {
    log(`\n================ RECHECK THEME: ${theme} @1280x800 ================`);
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, colorScheme: theme });
    const page = await boot(ctx);
    const demoInvoke = (cmd, args) => page.evaluate(async ({ c, a }) => {
      const { invoke } = await import('/src/adapter/bridge.ts'); return invoke(c, a);
    }, { c: cmd, a: args });
    const sid = (await demoInvoke('list_sessions')).find((s) => s.host_name === 'prod-1').id;

    // ---- B2 .cd-hint ----
    await openTools(page, 'tools-conn-detail');
    const hint = await measure(page, '.cd-hint');
    contrasts.push({ theme, item: 'B2 .cd-hint', ...hint });
    ok(`[${theme}] B2 .cd-hint ≥ AA`, hint.pass, `ratio=${hint.ratio} thr=${hint.threshold} fg=${hint.color} bg=${hint.bg} fs=${hint.fontSize}`);
    // ---- B4 Esc ----
    await page.keyboard.press('Escape'); await sleep(400);
    const cdAfter = await count(page, '[data-testid="conn-detail"]');
    ok(`[${theme}] B4 Esc 后 conn-detail 计数为 0`, cdAfter === 0, `still-open=${cdAfter}`);
    const sess = (await demoInvoke('list_sessions')).find((s) => s.id === sid);
    ok(`[${theme}] B4 Esc 关详情不误关会话（list_sessions 仍含该会话）`, !!sess && sess.state === 'Connected', `sid=${sid} state=${sess?.state}`);
    await shot(page, theme, 'b4-after-esc');

    // ---- B1 .seg hover ----
    await openTools(page, 'tools-activity');
    ok(`[${theme}] 活动记录面板已开`, (await count(page, '[data-testid="log-note"]')) === 1);
    await page.hover('[data-testid="log-scope-all"]'); await sleep(250);
    const segHover = await measure(page, '[data-testid="log-scope-all"]');
    contrasts.push({ theme, item: 'B1 .seg 未选中钮 hover', ...segHover });
    ok(`[${theme}] B1 .seg 未选中钮悬停 ≥ AA`, segHover.pass, `ratio=${segHover.ratio} thr=${segHover.threshold} fg=${segHover.color} bg=${segHover.bg} hovered=${segHover.hovered}`);
    const onBefore = await measure(page, '[data-testid="log-scope-current"]');
    await page.hover('[data-testid="log-scope-current"]'); await sleep(250);
    const onHover = await measure(page, '[data-testid="log-scope-current"]');
    const onCls = await page.evaluate(() => document.querySelector('[data-testid="log-scope-current"]')?.className);
    contrasts.push({ theme, item: 'B1 .seg 选中钮 hover', ...onHover });
    ok(`[${theme}] B1 悬停选中钮不顶掉选中态（bg 不变且仍带 .on）`, onBefore.bg === onHover.bg && /(^|\s)on(\s|$)/.test(onCls || ''), `before=${onBefore.bg} hover=${onHover.bg} cls="${onCls}"`);
    ok(`[${theme}] B1 选中钮悬停仍 ≥ AA`, onHover.pass, `ratio=${onHover.ratio} fg=${onHover.color} bg=${onHover.bg}`);
    await shot(page, theme, 'b1-seg-hover');

    // ---- B3 / L2 ----
    await page.click('.hb-settings'); await sleep(500);
    await page.click('[data-testid="settings-cat-credentials"]'); await sleep(450);
    const ce = await measure(page, '[data-testid="cred-empty"]');
    contrasts.push({ theme, item: 'B3 cred-empty', ...ce });
    ok(`[${theme}] B3 cred-empty ≥ AA`, ce.pass, `ratio=${ce.ratio} thr=${ce.threshold} fg=${ce.color} bg=${ce.bg} fs=${ce.fontSize}`);
    await page.click('[data-testid="cred-new"]').catch(() => {}); await sleep(350);
    const gb = await measure(page, '.cred-new button.ghost');
    contrasts.push({ theme, item: 'L2 .cred-new button.ghost', ...gb });
    ok(`[${theme}] L2 cred-new ghost 按钮 ≥ AA`, gb.pass, `ratio=${gb.ratio} thr=${gb.threshold} fg=${gb.color} bg=${gb.bg} fs=${gb.fontSize}`);
    await shot(page, theme, 'b3-l2-cred');

    // ---- M2 草稿消解后焦点 ----
    const setPem = () => page.evaluate(() => {
      const el = document.querySelector('[data-testid="cred-new-pem"]'); if (!el) return;
      Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set.call(el, '-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----');
      el.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const tabSeq = async (n) => { const seq = [];
      for (let i = 0; i < n; i++) {
        seq.push(await page.evaluate(() => { const d = document.querySelector('.term-settings.settings-wide');
          return { inside: !!d && d.contains(document.activeElement), tag: document.activeElement?.tagName, tid: document.activeElement?.getAttribute('data-testid') || String(document.activeElement?.className || '').slice(0, 16) }; }));
        await page.keyboard.press('Tab'); await sleep(50); }
      return seq; };
    await setPem(); await sleep(200);
    await page.click('[data-testid="settings-cat-appearance"]').catch(() => {}); await sleep(400);
    ok(`[${theme}] M2 草稿拦截出现（路1）`, (await count(page, '[data-testid="cred-draft"]')) === 1);
    await page.click('[data-testid="cred-draft-keep"]').catch(() => {}); await sleep(400);
    const seq1 = await tabSeq(6);
    ok(`[${theme}] M2 路1「留下继续编辑」连续 Tab 焦点始终在对话框内`, seq1.every((s) => s.inside), JSON.stringify(seq1.map((s) => s.tid)));
    await page.click('[data-testid="settings-cat-credentials"]').catch(() => {}); await sleep(400);
    await page.click('[data-testid="cred-new"]').catch(() => {}); await sleep(300);
    await setPem(); await sleep(200);
    await page.click('[data-testid="settings-cat-appearance"]').catch(() => {}); await sleep(400);
    ok(`[${theme}] M2 草稿拦截出现（路2）`, (await count(page, '[data-testid="cred-draft"]')) === 1);
    await page.click('[data-testid="cred-draft-discard"]').catch(() => {}); await sleep(450);
    const seq2 = await tabSeq(6);
    ok(`[${theme}] M2 路2「丢弃草稿并切换」连续 Tab 焦点始终在对话框内`, seq2.every((s) => s.inside), JSON.stringify(seq2.map((s) => s.tid)));
    await shot(page, theme, 'm2-draft-focus');
    const cutApp = await page.evaluate(() => { const p = document.querySelector('[data-testid="settings-pane-appearance"]'); if (!p) return null;
      const pr = p.getBoundingClientRect(); return [...p.children].some((c) => c.getBoundingClientRect().bottom > pr.bottom + 1); });
    ok(`[${theme}] 回归：外观分类内容未被裁`, cutApp === false, String(cutApp));
    await page.keyboard.press('Escape'); await sleep(400);
    ok(`[${theme}] 全程零 JS 错误`, page.__errs.length === 0, page.__errs.slice(0, 2).join(' | '));
    await ctx.close();
  }

  // ============ M1 / M3：4 视口几何 ============
  log('\n================ M1/M3 GEOMETRY @ 4 VIEWPORTS (dark) ================');
  for (const vp of [{ width: 1440, height: 900 }, { width: 1280, height: 800 }, { width: 1024, height: 768 }, { width: 960, height: 600 }]) {
    const vpTag = `${vp.width}x${vp.height}`;
    log(`\n--- ${vpTag} ---`);
    const ctx = await browser.newContext({ viewport: vp, colorScheme: 'dark' });
    const page = await boot(ctx);
    // ===== 阶段一：右栏**关**（纯几何：M3 居中 + M1 凭据表单展开）=====
    // --- conn-detail ---
    await openTools(page, 'tools-conn-detail');
    const cd = await clip(page, '[data-testid="conn-detail"]');
    const cdC = await page.evaluate(() => window.__vis.center('[data-testid="conn-detail"]'));
    const cdOccl = await page.evaluate(() => window.__vis.occl('[data-testid="conn-detail"]'));
    boxes.push({ vp: vpTag, panel: 'closed', what: 'conn-detail', ...cd, ...cdC });
    log(`  [右栏关] conn-detail rect=${JSON.stringify(cd.rect)} pos=${cd.pos} clippedH=${cd.clippedH} clippedW=${cd.clippedW} hitCenter=${cd.hitCenter} dxV=${cdC.dxViewport} dyV=${cdC.dyViewport} blocked=${cdOccl.blockedN}/${cdOccl.total}`);
    ok(`[${vpTag}] M3 conn-detail 中心对**视口**中心 dx/dy=0（右栏关）`, Math.abs(cdC.dxViewport) <= 1 && Math.abs(cdC.dyViewport) <= 1, `dx=${cdC.dxViewport} dy=${cdC.dyViewport}`);
    ok(`[${vpTag}] conn-detail 不被裁且无遮挡（右栏关）`, cd.clippedH === 0 && cd.clippedW === 0 && cd.hitCenter && cdOccl.blockedN === 0, `clippedH=${cd.clippedH} clippedW=${cd.clippedW} hitCenter=${cd.hitCenter} blocked=${cdOccl.blockedN}/${cdOccl.total}`);
    await page.screenshot({ path: path.join(OUT, `vis-r41-recheck-dark-geo-${vpTag}-condetail.png`) });
    await page.keyboard.press('Escape'); await sleep(350);
    // --- 设置 + M1 凭据表单展开态 ---
    await page.click('.hb-settings'); await sleep(600);
    const st = await clip(page, '.term-settings.settings-wide');
    const stC = await page.evaluate(() => window.__vis.center('.term-settings.settings-wide'));
    const stO = await page.evaluate(() => window.__vis.occl('.term-settings.settings-wide'));
    boxes.push({ vp: vpTag, panel: 'closed', what: 'settings', ...st, ...stC });
    log(`  [右栏关] settings rect=${JSON.stringify(st.rect)} pos=${st.pos} clippedH=${st.clippedH} clippedW=${st.clippedW} hitCenter=${st.hitCenter} dxV=${stC.dxViewport} dyV=${stC.dyViewport} blocked=${stO.blockedN}/${stO.total}`);
    ok(`[${vpTag}] M3 settings 中心对**视口**中心 dx/dy=0（右栏关）`, Math.abs(stC.dxViewport) <= 1 && Math.abs(stC.dyViewport) <= 1, `dx=${stC.dxViewport} dy=${stC.dyViewport}`);
    ok(`[${vpTag}] settings 不被裁且无遮挡（右栏关）`, st.clippedH === 0 && st.clippedW === 0 && st.hitCenter && stO.blockedN === 0, `clippedH=${st.clippedH} clippedW=${st.clippedW} hitCenter=${st.hitCenter} blocked=${stO.blockedN}/${stO.total}`);
    await page.click('[data-testid="settings-cat-credentials"]'); await sleep(400);
    await page.click('[data-testid="cred-new"]').catch(() => {}); await sleep(400);
    const stCred = await clip(page, '.term-settings.settings-wide');
    const stCredOccl = await page.evaluate(() => window.__vis.occl('.term-settings.settings-wide'));
    const m1 = await page.evaluate(() => {
      const dlg = document.querySelector('.term-settings.settings-wide');
      const head = dlg?.querySelector('.row') || dlg?.firstElementChild;
      const close = document.querySelector('[data-testid="settings-close"]');
      const rb = head?.getBoundingClientRect(), cb = close?.getBoundingClientRect();
      const inVp = (r) => !!r && r.top >= -0.5 && r.bottom <= window.innerHeight + 0.5 && r.left >= -0.5 && r.right <= window.innerWidth + 0.5;
      const vis = (r) => !!r && r.bottom > 0 && r.top < window.innerHeight && r.right > 0 && r.left < window.innerWidth;
      return { headText: (head?.textContent || '').trim().slice(0, 12),
        headRect: rb ? { top: Math.round(rb.top), bottom: Math.round(rb.bottom) } : null,
        closeRect: cb ? { top: Math.round(cb.top), bottom: Math.round(cb.bottom), x: Math.round(cb.x) } : null,
        headInVp: inVp(rb), closeInVp: inVp(cb), headVis: vis(rb), closeVis: vis(cb),
        paneScroll: (() => { const p = dlg?.querySelector('.settings-pane'); return p ? { sh: p.scrollHeight, ch: p.clientHeight } : null; })(),
        vh: window.innerHeight };
    });
    log(`  [右栏关] M1 settings(凭据表单展开) rect=${JSON.stringify(stCred.rect)} clippedH=${stCred.clippedH} clippedW=${stCred.clippedW} hitCenter=${stCred.hitCenter} blocked=${stCredOccl.blockedN}/${stCredOccl.total}`);
    log(`     head="${m1.headText}" ${JSON.stringify(m1.headRect)} inVp=${m1.headInVp} vis=${m1.headVis} | close=${JSON.stringify(m1.closeRect)} inVp=${m1.closeInVp} vis=${m1.closeVis} | pane=${JSON.stringify(m1.paneScroll)}`);
    ok(`[${vpTag}] M1 设置标题行在视口内且可见（凭据表单展开）`, m1.headInVp && m1.headVis, `${JSON.stringify(m1.headRect)} inVp=${m1.headInVp}`);
    ok(`[${vpTag}] M1 settings-close(✕) 在视口内且可见`, m1.closeInVp && m1.closeVis, `${JSON.stringify(m1.closeRect)} inVp=${m1.closeInVp}`);
    ok(`[${vpTag}] M1 凭据表单展开态 clippedH=0 且无遮挡`, stCred.clippedH === 0 && stCred.clippedW === 0 && stCred.hitCenter && stCredOccl.blockedN === 0, `clippedH=${stCred.clippedH} clippedW=${stCred.clippedW} blocked=${stCredOccl.blockedN}/${stCredOccl.total}`);
    await page.screenshot({ path: path.join(OUT, `vis-r41-recheck-dark-geo-${vpTag}-settings.png`) });
    await page.keyboard.press('Escape'); await sleep(350);
    // ===== 阶段二：右栏**开**（M3 居中仍成立？+ 层叠遮挡）=====
    await openTools(page, 'tools-activity'); await sleep(300);
    await openTools(page, 'tools-conn-detail');
    const cdP = await page.evaluate(() => window.__vis.center('[data-testid="conn-detail"]'));
    const cdPO = await page.evaluate(() => window.__vis.occl('[data-testid="conn-detail"]'));
    boxes.push({ vp: vpTag, panel: 'open', what: 'conn-detail', ...cdP });
    occlusion.push({ vp: vpTag, what: 'conn-detail', ...cdPO });
    log(`  [右栏开] conn-detail dxV=${cdP.dxViewport} dyV=${cdP.dyViewport} | panel=${cdPO.panel?.cls} panelZ=${cdPO.panel?.z} dlgZ=${cdPO.dialog?.z} overlapW=${cdPO.overlapW} blocked=${cdPO.blockedN}/${cdPO.total}`);
    ok(`[${vpTag}] M3 conn-detail 中心对视口中心 dx/dy=0（右栏开）`, Math.abs(cdP.dxViewport) <= 1 && Math.abs(cdP.dyViewport) <= 1, `dx=${cdP.dxViewport} dy=${cdP.dyViewport}`);
    ok(`[${vpTag}] 右栏开时 conn-detail 全部交互元素可达（无层叠遮挡）`, cdPO.blockedN === 0, `blocked=${cdPO.blockedN}/${cdPO.total} panelZ=${cdPO.panel?.z} dlgZ=${cdPO.dialog?.z} ${JSON.stringify(cdPO.sample)}`);
    await page.screenshot({ path: path.join(OUT, `vis-r41-recheck-dark-geo-${vpTag}-condetail-panelopen.png`) });
    await page.keyboard.press('Escape'); await sleep(350);
    await page.click('.hb-settings').catch(() => {}); await sleep(600);
    const stP = await page.evaluate(() => window.__vis.center('.term-settings.settings-wide'));
    const stPO = await page.evaluate(() => window.__vis.occl('.term-settings.settings-wide'));
    occlusion.push({ vp: vpTag, what: 'settings', ...stPO });
    log(`  [右栏开] settings dxV=${stP.dxViewport} dyV=${stP.dyViewport} | blocked=${stPO.blockedN}/${stPO.total} overlapW=${stPO.overlapW}`);
    ok(`[${vpTag}] M3 settings 中心对视口中心 dx/dy=0（右栏开）`, Math.abs(stP.dxViewport) <= 1 && Math.abs(stP.dyViewport) <= 1, `dx=${stP.dxViewport} dy=${stP.dyViewport}`);
    ok(`[${vpTag}] 右栏开时 settings 全部交互元素可达（无层叠遮挡）`, stPO.blockedN === 0, `blocked=${stPO.blockedN}/${stPO.total} panelZ=${stPO.panel?.z} dlgZ=${stPO.dialog?.z} ${JSON.stringify(stPO.sample)}`);
    await page.screenshot({ path: path.join(OUT, `vis-r41-recheck-dark-geo-${vpTag}-settings-panelopen.png`) });
    await page.keyboard.press('Escape'); await sleep(300);
    // --- 回归：log-bar / log-filters ---
    const lb = await clip(page, '.log-bar'), lf = await clip(page, '.log-filters');
    const wrap = await page.evaluate(() => { const e = document.querySelector('.log-filters'); if (!e) return null;
      const rows = new Set([...e.querySelectorAll('label')].map((l) => Math.round(l.getBoundingClientRect().top)));
      return { rows: rows.size, scrollW: e.scrollWidth, clientW: e.clientWidth }; });
    ok(`[${vpTag}] 回归 log-bar 无横向溢出`, lb.clippedW === 0, `clippedW=${lb.clippedW}`);
    ok(`[${vpTag}] 回归 log-filters 无溢出/不折行`, lf.clippedW === 0 && wrap && wrap.rows === 1, `clippedW=${lf.clippedW} ${JSON.stringify(wrap)}`);
    ok(`[${vpTag}] 零 JS 错误`, page.__errs.length === 0, page.__errs.slice(0, 2).join(' | '));
    await ctx.close();
  }

  // ============ fixed 包含块健康检查 ============
  log('\n================ fixed containing-block sanity ================');
  {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, colorScheme: 'dark' });
    const page = await boot(ctx);
    const bad = await page.evaluate(() => window.__vis.fixedContainingBlock());
    log(`  .term-wrap 祖先中带 transform/filter/contain 的：${JSON.stringify(bad)}`);
    ok('无祖先建立 fixed 包含块（fixed 确为视口相对）', bad.length === 0, JSON.stringify(bad));
    await ctx.close();
  }

  // ============ 汇总 ============
  log('\n================ RECHECK CONTRAST ================');
  for (const c of contrasts) log(`${c.pass ? 'ok  ' : 'FAIL'} [${c.theme}] ${c.item}  ratio=${c.ratio} (thr ${c.threshold})  fg=${c.color} bg=${c.bg} fs=${c.fontSize}${c.hovered ? ' hovered' : ''}`);
  const cfails = contrasts.filter((c) => !c.pass);
  log(`contrast: ${contrasts.length - cfails.length}/${contrasts.length} pass`);
  log('\n================ OCCLUSION ================');
  for (const o of occlusion) log(`[${o.vp}] ${o.what}: panel=${o.panel?.cls} z=${o.panel?.z} vs dlg z=${o.dialog?.z} overlapW=${o.overlapW} blocked=${o.blockedN}/${o.total}`);
  fs.writeFileSync(path.join(OUT, 'vis-r41-recheck-raw.json'), JSON.stringify({ results, contrasts, boxes, occlusion }, null, 2));
  const failed = results.filter((r) => !r.pass);
  log(`\nchecks: ${results.length - failed.length}/${results.length} pass`);
  for (const f of failed) log(`  FAIL ${f.name}  [${f.detail}]`);
  await browser.close();
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error('PROBE CRASH', e); process.exit(2); });
