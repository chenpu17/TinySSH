// vis-r43 极窄复核（D-1 处置后）：`停用协作…` 钮取色令牌正名 var(--err,#e5484d) → var(--danger)。
// 只读渲染 + 截图 + 对比度/几何证据；不修改工作树。
// 覆盖：① ?fresh → 启用协作 → 设置→Agent 接入 的 collab-disable-btn（浅色取色+对比度）
//       ② 深色同量（先点 settings-cat-appearance，见 B-7 坑）
//       ③ 两主题是否均 ≥ 4.5:1  ④ 是否仍 ghost / 可点 / 不溢出
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
    return { cls: e.className, color: cs.color, bg: cs.backgroundColor, border: cs.borderColor,
             fontSize: cs.fontSize, fontWeight: cs.fontWeight, display: cs.display, cursor: cs.cursor,
             padding: cs.padding, borderRadius: cs.borderRadius }; },
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
    const hi = Math.max(L1,L2), lo = Math.min(L1,L2);
    return { ratio: +(((hi+0.05)/(lo+0.05)).toFixed(2)), fg: 'rgb('+fg.join(',')+')', bg: 'rgb('+bg.join(',')+')',
             aa: +(((hi+0.05)/(lo+0.05)) >= 4.5) }; },
  clipped: (s) => { const e = document.querySelector(s); if (!e) return null;
    return { sw: e.scrollWidth, cw: e.clientWidth, sh: e.scrollHeight, ch: e.clientHeight,
             hClip: e.scrollWidth > e.clientWidth + 1, vClip: e.scrollHeight > e.clientHeight + 1 }; },
  textW: (s) => { const e = document.querySelector(s); if (!e) return null;
    const r = document.createRange(); r.selectNodeContents(e); const b = r.getBoundingClientRect();
    const cs = getComputedStyle(e);
    return { textW: +b.width.toFixed(1), textH: +b.height.toFixed(1), scrollW: e.scrollWidth, clientW: e.clientWidth,
             ws: cs.whiteSpace, overflow: cs.overflowX }; },
  inVp: (s) => { const e = document.querySelector(s); if (!e) return null; const r = e.getBoundingClientRect();
    return { fully: r.x >= -0.5 && r.y >= -0.5 && r.right <= innerWidth + 0.5 && r.bottom <= innerHeight + 0.5,
             l: +r.left.toFixed(1), t: +r.top.toFixed(1), r: +r.right.toFixed(1), b: +r.bottom.toFixed(1), vw: innerWidth, vh: innerHeight }; },
  hittable: (s) => { const e = document.querySelector(s); if (!e) return null; const r = e.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return { ok: false, why: 'zero-size' };
    const hit = document.elementFromPoint(r.x + r.width/2, r.y + r.height/2);
    return { ok: !!hit && (hit === e || e.contains(hit) || hit.contains(e)),
             hitTag: hit && hit.tagName, hitTestid: hit && hit.getAttribute && hit.getAttribute('data-testid') }; },
  token: (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim(),
  tokenOn: (el, name) => getComputedStyle(el).getPropertyValue(name).trim(),
};
`;

(async () => {
  const browser = await chromium.launch({ executablePath: EXE, headless: true });

  // ?fresh → 连 prod-1 → 开协作面板（停用态指引）→ 点「打开设置 → Agent 接入」→ 点「启用协作」
  async function freshToEnabled(page) {
    await page.goto(URL + '?fresh', { waitUntil: 'domcontentloaded' });
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
    await sleep(800);
    await page.evaluate(() => document.querySelector('[data-testid="collab-open-settings"]')?.click());
    await sleep(900);
  }
  const setDark = async (page) => {
    await page.evaluate(() => document.querySelector('[data-testid="settings-cat-appearance"]')?.click());
    await sleep(400);
    await page.evaluate(() => { [...document.querySelectorAll('.ts-appearance button')].find((b) => b.textContent.includes('深色'))?.click(); });
    await sleep(450);
    await page.evaluate(() => document.querySelector('[data-testid="settings-cat-agent"]')?.click());
    await sleep(500);
  };
  const census = (page) => page.evaluate(() => ({
    theme: document.documentElement.dataset.chrome,
    tokDanger: window.__vis.token('--danger'),
    tokErr: window.__vis.token('--err'),
    enableBtn: window.__vis.count('[data-testid="collab-enable-btn"]'),
    disableBtn: window.__vis.count('[data-testid="collab-disable-btn"]'),
    stateChip: window.__vis.text('[data-testid="collab-state"]'),
    endpoint: window.__vis.count('[data-testid="agent-endpoint"]'),
    disableStyle: window.__vis.style('[data-testid="collab-disable-btn"]'),
    disableContrast: window.__vis.contrast('[data-testid="collab-disable-btn"]'),
    disableBox: window.__vis.box('[data-testid="collab-disable-btn"]'),
    disableTextW: window.__vis.textW('[data-testid="collab-disable-btn"]'),
    disableClip: window.__vis.clipped('[data-testid="collab-disable-btn"]'),
    disableHit: window.__vis.hittable('[data-testid="collab-disable-btn"]'),
    disableInVp: window.__vis.inVp('[data-testid="collab-disable-btn"]'),
    paneClip: window.__vis.clipped('.settings-pane'),
    paneBox: window.__vis.box('[data-testid="settings-pane-agent"]'),
  }));

  // ============ ① 浅色 ============
  {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await ctx.newPage();
    const errs = []; page.on('pageerror', (e) => errs.push(String(e)));
    await freshToEnabled(page);
    const pre = await page.evaluate(() => ({ enable: window.__vis.count('[data-testid="collab-enable-btn"]'),
      disable: window.__vis.count('[data-testid="collab-disable-btn"]') }));
    log('D1 启用前（?fresh 停用态）', pre);
    await page.evaluate(() => document.querySelector('[data-testid="collab-enable-btn"]')?.click());
    await sleep(1400);
    const s1 = await census(page);
    log('D1-浅色 1280×800（启用后）', s1);
    await page.screenshot({ path: OUT + 'vis-r43-17-disable-btn-token-light.png' });
    console.log('  [shot] vis-r43-17-disable-btn-token-light.png');
    log('D1 浅色 JS 异常', errs);
    await ctx.close();
  }

  // ============ ② 深色 ============
  {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await ctx.newPage();
    const errs = []; page.on('pageerror', (e) => errs.push(String(e)));
    await freshToEnabled(page);
    await page.evaluate(() => document.querySelector('[data-testid="collab-enable-btn"]')?.click());
    await sleep(1400);
    await setDark(page);
    const s2 = await census(page);
    log('D1-深色 1280×800（启用后）', s2);
    await page.screenshot({ path: OUT + 'vis-r43-18-disable-btn-token-dark.png' });
    console.log('  [shot] vis-r43-18-disable-btn-token-dark.png');
    log('D1 深色 JS 异常', errs);
    await ctx.close();
  }

  await browser.close();
  fs.writeFileSync(OUT + 'vis-r43-evidence4.json', JSON.stringify(ev, null, 2));
  console.log('\n== done ==');
})().catch((e) => { console.log('PROBE EXCEPTION', e.stack || e); process.exitCode = 1; });
