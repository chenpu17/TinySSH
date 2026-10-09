const { chromium } = require('/Users/chenpu/node_modules/playwright');
const EXE = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const URL = process.env.PROBE_URL || 'http://localhost:5183/';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  const browser = await chromium.launch({ executablePath: EXE, headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();
  await page.goto(URL + '?fresh', { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => { try { localStorage.clear(); } catch {} });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.host-card', { timeout: 10000 });
  await sleep(1000);
  await page.evaluate(() => {
    const card = [...document.querySelectorAll('.host-card')].find((c) => c.querySelector('.host-name')?.textContent.includes('prod-1'));
    card?.querySelector('.host-connect-btn')?.click();
  });
  await page.waitForSelector('.hk-mask', { timeout: 4000 }).catch(() => {});
  await page.evaluate(() => { [...document.querySelectorAll('.hk-mask button')].find((x) => x.textContent.includes('信任并连接'))?.click(); });
  await sleep(800);
  await page.evaluate(() => document.querySelector('[data-testid="tools-collab"]')?.click());
  await sleep(900);

  const diag = await page.evaluate(() => {
    const panel = document.querySelector('.task-panel');
    const hits = [];
    const walk = (n) => { for (const c of n.childNodes) {
      if (c.nodeType === 3) { const t = (c.textContent || '').trim();
        if (t.includes('已核实')) { const p = c.parentElement; const cs = getComputedStyle(p);
          hits.push({ text: t.slice(0,30), tag: p.tagName, cls: p.className, color: cs.color,
            parentChain: (() => { const ch = []; let x = p; for (let i=0;i<6&&x;i++){ const s=getComputedStyle(x); ch.push({tag:x.tagName,cls:String(x.className).slice(0,40),bg:s.backgroundColor}); x=x.parentElement;} return ch; })() }); } }
      else if (c.nodeType === 1) walk(c); } };
    walk(panel);
    // 也全文档找一遍
    const all = [];
    const walk2 = (n) => { for (const c of n.childNodes) {
      if (c.nodeType === 3) { const t = (c.textContent || '').trim();
        if (t.includes('已核实')) { const p = c.parentElement; all.push({ text: t.slice(0,30), cls: String(p.className).slice(0,40), inPanel: !!p.closest('.task-panel') }); } }
      else if (c.nodeType === 1) walk2(c); } };
    walk2(document.body);
    return { inPanel: hits, docWide: all, panelHTMLHead: panel ? panel.innerHTML.slice(0, 300) : null };
  });
  console.log(JSON.stringify(diag, null, 2));

  // 深色下 .dim / ts-label 实际配色
  await page.evaluate(() => document.querySelector('.hb-settings')?.click());
  await sleep(500);
  await page.evaluate(() => { [...document.querySelectorAll('.ts-appearance button')].find((b) => b.textContent.includes('深色'))?.click(); });
  await sleep(400);
  await page.evaluate(() => document.querySelector('[data-testid="settings-cat-agent"]')?.click());
  await sleep(500);
  const dark = await page.evaluate(() => {
    const g = (s) => { const e = document.querySelector(s); if (!e) return null; const cs = getComputedStyle(e);
      return { color: cs.color, bg: cs.backgroundColor, fontSize: cs.fontSize, fontWeight: cs.fontWeight }; };
    return {
      chrome: document.documentElement.dataset.chrome,
      rootVars: (() => { const cs = getComputedStyle(document.documentElement);
        return { textSub: cs.getPropertyValue('--text-sub').trim(), dim: cs.getPropertyValue('--dim').trim(),
                 panel2: cs.getPropertyValue('--panel2').trim(), bg: cs.getPropertyValue('--bg').trim(), text: cs.getPropertyValue('--text').trim() }; })(),
      label: g('[data-testid="settings-pane-agent"] .ts-label'),
      note: g('[data-testid="collab-disabled-note"]'),
      enableBtn: g('[data-testid="collab-enable-btn"]'),
      paneBg: getComputedStyle(document.querySelector('[data-testid="settings-pane-agent"]')).backgroundColor,
    };
  });
  console.log('DARK ' + JSON.stringify(dark, null, 2));
  await browser.close();
})().catch((e) => { console.log('EX', e.stack); process.exitCode = 1; });
