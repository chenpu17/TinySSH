// vis-r43 补验探针（F3/F5 处置后新增面）：DisableFailed（停用未收敛）重试收敛面。
// 只读渲染 + 截图 + 像素/几何证据；不修改工作树。
// 覆盖：① `?disablefailed` 设置→Agent 接入（浅/深）② 窄窗 1024/960 该钮与文案
//       ③ 点「重试停用收敛」→ 收敛为「已停用」→ 出现「启用协作」 ④ 新钮对比度
const { chromium } = require('/Users/chenpu/node_modules/playwright');
const fs = require('fs');
const EXE = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const URL = process.env.PROBE_URL || 'http://localhost:5183/';
const OUT = '/Users/chenpu/workspace/claude-code/TinySSH/docs/acceptance/ux-r1/g4/2026-10-09-r43/';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ev = [];
const log = (k, v) => { ev.push({ k, v }); console.log('· ' + k + ' => ' + JSON.stringify(v)); };

const HELPERS = `
window.__vis = {
  box: (s) => { const e = document.querySelector(s); if (!e) return null; const r = e.getBoundingClientRect();
    return { x: +r.x.toFixed(1), y: +r.y.toFixed(1), w: +r.width.toFixed(1), h: +r.height.toFixed(1) }; },
  text: (s) => { const e = document.querySelector(s); return e ? e.textContent.replace(/\\s+/g,' ').trim() : null; },
  count: (s) => document.querySelectorAll(s).length,
  style: (s) => { const e = document.querySelector(s); if (!e) return null; const cs = getComputedStyle(e);
    return { color: cs.color, bg: cs.backgroundColor, fontSize: cs.fontSize, fontWeight: cs.fontWeight, display: cs.display }; },
  effBg: (el) => { const layers = []; let n = el;
    while (n) { const bg = getComputedStyle(n).backgroundColor; const m = (bg || '').match(/[\\d.]+/g);
      if (m) { const a = m.length > 3 ? parseFloat(m[3]) : 1; if (a > 0) layers.push({ c: m.slice(0,3).map(Number), a }); }
      n = n.parentElement; }
    let out = [255, 255, 255];
    for (let i = layers.length - 1; i >= 0; i--) { const L = layers[i]; out = out.map((v, k) => L.c[k] * L.a + v * (1 - L.a)); }
    return 'rgb(' + out.map(Math.round).join(',') + ')'; },
  rgb: (s) => { const m = (s||'').match(/[\\d.]+/g); return m ? m.slice(0,3).map(Number) : null; },
  lum: (c) => { const f = c.map((v) => { v = v/255; return v <= 0.03928 ? v/12.92 : Math.pow((v+0.055)/1.055, 2.4); });
    return 0.2126*f[0] + 0.7152*f[1] + 0.0722*f[2]; },
  contrast: (s) => { const e = document.querySelector(s); if (!e) return null;
    const fg = window.__vis.rgb(getComputedStyle(e).color); const bg = window.__vis.rgb(window.__vis.effBg(e));
    if (!fg || !bg) return null; const L1 = window.__vis.lum(fg), L2 = window.__vis.lum(bg);
    const hi = Math.max(L1,L2), lo = Math.min(L1,L2); return +(((hi+0.05)/(lo+0.05)).toFixed(2)); },
  clipped: (s) => { const e = document.querySelector(s); if (!e) return null;
    return { sw: e.scrollWidth, cw: e.clientWidth, sh: e.scrollHeight, ch: e.clientHeight,
             hClip: e.scrollWidth > e.clientWidth + 1, vClip: e.scrollHeight > e.clientHeight + 1 }; },
  inVp: (s) => { const e = document.querySelector(s); if (!e) return null; const r = e.getBoundingClientRect();
    return { fully: r.x >= -0.5 && r.y >= -0.5 && r.right <= innerWidth + 0.5 && r.bottom <= innerHeight + 0.5,
             l: +r.left.toFixed(1), t: +r.top.toFixed(1), r: +r.right.toFixed(1), b: +r.bottom.toFixed(1), vw: innerWidth, vh: innerHeight }; },
  hittable: (s) => { const e = document.querySelector(s); if (!e) return null; const r = e.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return { ok: false, why: 'zero-size' };
    const hit = document.elementFromPoint(r.x + r.width/2, r.y + r.height/2);
    return { ok: !!hit && (hit === e || e.contains(hit) || hit.contains(e)),
             hitTag: hit && hit.tagName, hitTestid: hit && hit.getAttribute && hit.getAttribute('data-testid') }; },
  overlap: (a, b) => { const ea = document.querySelector(a), eb = document.querySelector(b);
    if (!ea || !eb) return null; const A = ea.getBoundingClientRect(), B = eb.getBoundingClientRect();
    const w = Math.min(A.right, B.right) - Math.max(A.left, B.left);
    const h = Math.min(A.bottom, B.bottom) - Math.max(A.top, B.top);
    return { w: +w.toFixed(1), h: +h.toFixed(1), area: +(Math.max(0,w) * Math.max(0,h)).toFixed(1) }; },
  scanOverlap: (root) => { const r = document.querySelector(root); if (!r) return null;
    const kids = [...r.children].filter((c) => { const cs = getComputedStyle(c); const b = c.getBoundingClientRect();
      return cs.display !== 'none' && cs.visibility !== 'hidden' && +cs.opacity > 0 && b.width > 0 && b.height > 0; });
    const out = [];
    for (let i = 0; i < kids.length; i++) for (let j = i+1; j < kids.length; j++) {
      const A = kids[i].getBoundingClientRect(), B = kids[j].getBoundingClientRect();
      const w = Math.min(A.right,B.right) - Math.max(A.left,B.left), h = Math.min(A.bottom,B.bottom) - Math.max(A.top,B.top);
      if (w > 1 && h > 1) out.push({ a: kids[i].className || kids[i].tagName, b: kids[j].className || kids[j].tagName, area: +(w*h).toFixed(1) }); }
    return out; },
  minContrast: (root) => { const r = document.querySelector(root); if (!r) return null;
    let worst = { ratio: 99, text: '' };
    const walk = (n) => { for (const c of n.childNodes) {
      if (c.nodeType === 3) { const t = (c.textContent||'').trim(); if (t.length > 1 && c.parentElement) {
        const cs = getComputedStyle(c.parentElement); if (cs.visibility === 'hidden' || +cs.opacity === 0) continue;
        const fg = window.__vis.rgb(cs.color), bg = window.__vis.rgb(window.__vis.effBg(c.parentElement));
        if (fg && bg) { const L1 = window.__vis.lum(fg), L2 = window.__vis.lum(bg);
          const ratio = +(((Math.max(L1,L2)+0.05)/(Math.min(L1,L2)+0.05)).toFixed(2));
          if (ratio < worst.ratio) worst = { ratio, text: t.slice(0,40) }; } } }
      else if (c.nodeType === 1) walk(c); } };
    walk(r); return worst; },
  textW: (s) => { const e = document.querySelector(s); if (!e) return null;
    const r = document.createRange(); r.selectNodeContents(e); const b = r.getBoundingClientRect();
    const cs = getComputedStyle(e);
    return { textW: +b.width.toFixed(1), textH: +b.height.toFixed(1), scrollW: e.scrollWidth, clientW: e.clientWidth,
             ws: cs.whiteSpace, overflow: cs.overflowX }; },
  buttons: (root) => { const r = document.querySelector(root); if (!r) return null;
    return [...r.querySelectorAll('button')].filter((b) => { const cs = getComputedStyle(b); return cs.display !== 'none' && cs.visibility !== 'hidden'; })
      .map((b) => { const bx = b.getBoundingClientRect(); const h = document.elementFromPoint(bx.x + bx.width/2, bx.y + bx.height/2);
        return { t: b.textContent.replace(/\\s+/g,' ').trim(), testid: b.getAttribute('data-testid'),
          x: +bx.x.toFixed(1), y: +bx.y.toFixed(1), w: +bx.width.toFixed(1), h: +bx.height.toFixed(1),
          hit: !!h && (h === b || b.contains(h) || h.contains(b)) }; }); },
};
`;

(async () => {
  const browser = await chromium.launch({ executablePath: EXE, headless: true });

  // 打开 ?disablefailed 页 + 连主机 + 进「设置 → Agent 接入」
  async function openFailedSettings(page) {
    await page.goto(URL + '?disablefailed', { waitUntil: 'domcontentloaded' });
    await page.evaluate(() => { try { localStorage.clear(); } catch {} });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.evaluate(HELPERS);
    await page.waitForSelector('.host-card', { timeout: 10000 });
    await sleep(1000);
    await page.evaluate(() => {
      const c = [...document.querySelectorAll('.host-card')].find((x) => x.querySelector('.host-name')?.textContent.includes('prod-1'));
      c?.querySelector('.host-connect-btn')?.click();
    });
    await page.waitForSelector('.hk-mask', { timeout: 4000 }).catch(() => {});
    await page.evaluate(() => { [...document.querySelectorAll('.hk-mask button')].find((x) => x.textContent.includes('信任并连接'))?.click(); });
    await sleep(900);
    await page.evaluate(() => document.querySelector('[data-testid="tools-collab"]')?.click());
    await sleep(700);
    await page.evaluate(() => document.querySelector('[data-testid="collab-open-settings"]')?.click());
    await sleep(900);
  }
  const setDark = async (page) => {
    await page.evaluate(() => document.querySelector('[data-testid="settings-close"]')?.click());
    await sleep(300);
    await page.evaluate(() => document.querySelector('.hb-settings')?.click());
    await sleep(500);
    // 外观分类才渲染 .ts-appearance（settingsCat 停在 agent 时该控件不存在）
    await page.evaluate(() => document.querySelector('[data-testid="settings-cat-appearance"]')?.click());
    await sleep(400);
    await page.evaluate(() => { [...document.querySelectorAll('.ts-appearance button')].find((b) => b.textContent.includes('深色'))?.click(); });
    await sleep(450);
    await page.evaluate(() => document.querySelector('[data-testid="settings-cat-agent"]')?.click());
    await sleep(500);
  };
  const census = (page) => page.evaluate(() => ({
    stateChip: window.__vis.text('[data-testid="collab-state"]'),
    stateChipStyle: window.__vis.style('[data-testid="collab-state"]'),
    stateChipContrast: window.__vis.contrast('[data-testid="collab-state"]'),
    note: window.__vis.text('[data-testid="collab-disabled-note"]'),
    noteBox: window.__vis.box('[data-testid="collab-disabled-note"]'),
    noteTextW: window.__vis.textW('[data-testid="collab-disabled-note"]'),
    noteClip: window.__vis.clipped('[data-testid="collab-disabled-note"]'),
    retryBtn: window.__vis.count('[data-testid="collab-retry-disable-btn"]'),
    retryBtnText: window.__vis.text('[data-testid="collab-retry-disable-btn"]'),
    retryBtnBox: window.__vis.box('[data-testid="collab-retry-disable-btn"]'),
    retryBtnHit: window.__vis.hittable('[data-testid="collab-retry-disable-btn"]'),
    retryBtnStyle: window.__vis.style('[data-testid="collab-retry-disable-btn"]'),
    retryBtnContrast: window.__vis.contrast('[data-testid="collab-retry-disable-btn"]'),
    enableBtn: window.__vis.count('[data-testid="collab-enable-btn"]'),
    disableBtn: window.__vis.count('[data-testid="collab-disable-btn"]'),
    endpoint: window.__vis.count('[data-testid="agent-endpoint"]'),
    keptAgents: window.__vis.count('[data-testid="collab-kept-agents"]'),
    keptText: window.__vis.text('[data-testid="collab-kept-agents"]'),
    paneBox: window.__vis.box('[data-testid="settings-pane-agent"]'),
    panelBox: window.__vis.box('.term-settings.settings-wide'),
    panelInVp: window.__vis.inVp('.term-settings.settings-wide'),
    paneClip: window.__vis.clipped('.settings-pane'),
    paneMinContrast: window.__vis.minContrast('[data-testid="settings-pane-agent"]'),
    paneOverlaps: window.__vis.scanOverlap('[data-testid="settings-pane-agent"]'),
    paneButtons: window.__vis.buttons('[data-testid="settings-pane-agent"]'),
    navVsPane: window.__vis.overlap('.settings-nav', '[data-testid="settings-pane-agent"]'),
    panelSections: window.__vis.sections ? window.__vis.sections('.tp-scroll') : null,
  }));

  // ============ ① 浅色 1280×800 ============
  {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await ctx.newPage();
    const errs = []; page.on('pageerror', (e) => errs.push(String(e)));
    await openFailedSettings(page);
    log('F-浅色 主题', await page.evaluate(() => document.documentElement.dataset.chrome));
    const s1 = await census(page);
    log('F1 浅色 ?disablefailed 设置', s1);
    await page.screenshot({ path: OUT + 'vis-r43-13-disablefailed-light.png' });
    console.log('  [shot] vis-r43-13-disablefailed-light.png');

    // 面板侧（停用态指引文案）
    const panel = await page.evaluate(() => ({
      disabledText: window.__vis.text('[data-testid="collab-disabled"]'),
      apGroup: window.__vis.count('[data-testid="ap-group"]'),
      approvalsC: window.__vis.count('.collab-approvals'),
      goalTextarea: window.__vis.count('.task-panel textarea'),
    }));
    log('F1b 浅色 停用态协作面板', panel);

    // ============ ③ 收敛后态 ============
    // 关设置 → 用主机栏设置钮重开（settingsCat 仍停在 agent；勿点 tools-collab，会反向关掉面板）
    await page.evaluate(() => document.querySelector('[data-testid="settings-close"]')?.click());
    await sleep(300);
    await page.evaluate(() => document.querySelector('.hb-settings')?.click());
    await sleep(700);
    const before = await census(page);
    await page.evaluate(() => document.querySelector('[data-testid="collab-retry-disable-btn"]')?.click());
    await sleep(1200);
    const after = await page.evaluate(() => ({
      stateChip: window.__vis.text('[data-testid="collab-state"]'),
      retryBtn: window.__vis.count('[data-testid="collab-retry-disable-btn"]'),
      enableBtn: window.__vis.count('[data-testid="collab-enable-btn"]'),
      enableBtnText: window.__vis.text('[data-testid="collab-enable-btn"]'),
      enableBtnHit: window.__vis.hittable('[data-testid="collab-enable-btn"]'),
      disableBtn: window.__vis.count('[data-testid="collab-disable-btn"]'),
      endpoint: window.__vis.count('[data-testid="agent-endpoint"]'),
      note: window.__vis.text('[data-testid="collab-disabled-note"]'),
      keptAgents: window.__vis.count('[data-testid="collab-kept-agents"]'),
      keptText: window.__vis.text('[data-testid="collab-kept-agents"]'),
      toast: window.__vis.text('.toast') || null,
    }));
    log('F3 收敛前', { chip: before.stateChip, retry: before.retryBtn, enable: before.enableBtn, disable: before.disableBtn });
    log('F3 收敛后（点「重试停用收敛」）', after);
    await page.screenshot({ path: OUT + 'vis-r43-14-after-retry-converged-light.png' });
    console.log('  [shot] vis-r43-14-after-retry-converged-light.png');
    log('F 浅色 JS 异常', errs);
    await ctx.close();
  }

  // ============ ①深色 1280×800 ============
  {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await ctx.newPage();
    const errs = []; page.on('pageerror', (e) => errs.push(String(e)));
    await openFailedSettings(page);
    await setDark(page);
    log('F-深色 主题', await page.evaluate(() => document.documentElement.dataset.chrome));
    const s2 = await census(page);
    log('F2 深色 ?disablefailed 设置', s2);
    await page.screenshot({ path: OUT + 'vis-r43-15-disablefailed-dark.png' });
    console.log('  [shot] vis-r43-15-disablefailed-dark.png');
    log('F 深色 JS 异常', errs);
    await ctx.close();
  }

  // ============ ② 窄窗 1024 / 960 ============
  for (const vp of [{ w: 1024, h: 768, n: '1024' }, { w: 960, h: 600, n: '960' }]) {
    const ctx = await browser.newContext({ viewport: { width: vp.w, height: vp.h } });
    const page = await ctx.newPage();
    const errs = []; page.on('pageerror', (e) => errs.push(String(e)));
    await openFailedSettings(page);
    const s3 = await census(page);
    log('F' + vp.n + ' 窄窗 ?disablefailed 设置', s3);
    await page.screenshot({ path: OUT + `vis-r43-16-disablefailed-narrow-${vp.n}-light.png` });
    console.log(`  [shot] vis-r43-16-disablefailed-narrow-${vp.n}-light.png`);
    log('F' + vp.n + ' JS 异常', errs);
    await ctx.close();
  }

  await browser.close();
  fs.writeFileSync(OUT + 'vis-r43-evidence2.json', JSON.stringify(ev, null, 2));
  console.log('\n== done ==');
})().catch((e) => { console.log('PROBE EXCEPTION', e.stack || e); process.exitCode = 1; });
