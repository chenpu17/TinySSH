// vis-r40 几何核查：非回环暴露确认行（.fwd-expose）的盒几何——验证警告文本是否可见。
const { chromium } = require('/Users/chenpu/node_modules/playwright');
const fs = require('fs'); const path = require('path');
const EXE = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const URL = 'http://localhost:5183/';
const OUT = process.env.VIS_OUT || __dirname;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  const browser = await chromium.launch({ executablePath: EXE, headless: true });
  const out = {};
  for (const theme of ['dark', 'light']) {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, colorScheme: theme });
    const page = await ctx.newPage();
    await page.goto(URL, { waitUntil: 'domcontentloaded' });
    await page.evaluate(() => { try { localStorage.clear(); } catch {} });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.host-card', { timeout: 15000 });
    await sleep(500);
    await page.evaluate(() => {
      const c = [...document.querySelectorAll('.host-card')].find((x) => x.querySelector('.host-name')?.textContent.includes('prod-1'));
      c?.querySelector('.host-connect-btn')?.click();
    });
    await sleep(1500);
    await page.evaluate(() => { [...document.querySelectorAll('.st-tools button')].find((b) => b.textContent.includes('工具'))?.click(); });
    await sleep(200);
    await page.evaluate(() => { [...document.querySelectorAll('.tools-menu button')].find((b) => b.textContent.includes('端口转发'))?.click(); });
    await sleep(600);
    await page.evaluate(() => {
      const el = document.querySelector('.task-panel .fwd-form input.mono');
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(el, '0.0.0.0'); el.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await sleep(300);
    const geo = await page.evaluate(() => {
      const box = (el) => { const r = el.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }; };
      const label = document.querySelector('[data-testid="fwd-expose"]');
      if (!label) return { missing: true };
      const input = label.querySelector('input');
      const span = label.querySelector('span');
      const panel = document.querySelector('.task-panel');
      const scroller = document.querySelector('.task-panel .tp-scroll');
      const cs = (el, p) => getComputedStyle(el)[p];
      const spanRects = [...span.getClientRects()].map((r) => ({ x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }));
      const spanRange = (() => { const rg = document.createRange(); rg.selectNodeContents(span); return [...rg.getClientRects()].map((r) => ({ x: Math.round(r.x), w: Math.round(r.width) })); })();
      return {
        label: { ...box(label), display: cs(label, 'display'), flexWrap: cs(label, 'flexWrap') },
        input: { ...box(input), width: cs(input, 'width'), flex: cs(input, 'flex'), appearance: cs(input, 'appearance') },
        span: { ...box(span), width: cs(span, 'width'), flex: cs(span, 'flex'), overflow: cs(span, 'overflow'), whiteSpace: cs(span, 'whiteSpace'), textLen: span.textContent.length },
        panel: box(panel), scroller: { ...box(scroller), scrollW: scroller.scrollWidth, clientW: scroller.clientWidth },
        spanRects, spanRange,
        spanVisibleWidth: spanRange.reduce((a, r) => a + r.width, 0),
        spanInsidePanel: spanRects.every((r) => r.x >= panel.getBoundingClientRect().x - 1 && r.x + r.w <= panel.getBoundingClientRect().right + 1),
      };
    });
    out[theme] = geo;
    console.log('=== ' + theme + ' ===');
    console.log(JSON.stringify(geo, null, 1));
    await ctx.close();
  }
  fs.writeFileSync(path.join(OUT, 'vis-r40-expose-geometry.json'), JSON.stringify(out, null, 2));
  await browser.close();
})().catch((e) => { console.error('CRASH', e); process.exit(2); });
