const { chromium } = require('/Users/chenpu/node_modules/playwright');
const EXE = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
(async () => {
  const browser = await chromium.launch({ executablePath: EXE, headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await page.goto('http://localhost:5183/', { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => { try { localStorage.clear(); } catch {} });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.host-card', { timeout: 10000 });
  await page.evaluate(async () => {
    const bridge = await import('/src/adapter/bridge.ts');
    await bridge.invoke('create_identity', { req: { Generate: { label: 'vis-test', kind: 'Ed25519' } } });
  });
  await page.click('.hb-settings');
  await page.waitForSelector('.cred-row', { timeout: 6000 });
  const m = await page.evaluate(() => {
    const box = (sel) => { const el = document.querySelector(sel); if (!el) return null; const b = el.getBoundingClientRect(); return { x: +b.x.toFixed(1), w: +b.width.toFixed(1) }; };
    const row = document.querySelector('.cred-row').getBoundingClientRect();
    return {
      row: { x: +row.x.toFixed(1), w: +row.width.toFixed(1) },
      panel: (() => { const b = document.querySelector('.term-settings').getBoundingClientRect(); const cs = getComputedStyle(document.querySelector('.term-settings')); return { w: +b.width.toFixed(1), padL: cs.paddingLeft, padR: cs.paddingRight }; })(),
      label: box('.cred-label'), kind: box('.cred-kind'), fp: box('.cred-fp'), badge: box('.cred-unbound'), del: box('.cred-row button'),
      overlapKindFp: (() => { const k = document.querySelector('.cred-kind').getBoundingClientRect(); const f = document.querySelector('.cred-fp').getBoundingClientRect(); return k.right > f.left + 0.5; })(),
      labelW: document.querySelector('.cred-label').getBoundingClientRect().width,
    };
  });
  console.log(JSON.stringify(m, null, 1));
  await browser.close();
})().catch((e) => { console.error(String(e)); process.exit(2); });
