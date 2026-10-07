const { chromium } = require('/Users/chenpu/node_modules/playwright');
(async () => {
  const browser = await chromium.launch({
    executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true,
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e.message)));
  await page.goto('http://localhost:5183', { waitUntil: 'networkidle' });
  await page.waitForTimeout(1000);
  await page.locator('.card.row div[title]').first().click();
  await page.waitForTimeout(1200);
  const r = await page.evaluate(() => {
    const t = window.__t_terms.get('s-demo-0001');
    const buf = t.buffer.active;
    // 光标行（xterm 内部坐标）与 cursorBlink
    const cur = { x: buf.cursorX, y: buf.cursorY, blink: t.options.cursorBlink };
    // 提示符行（最后非空行）
    let lastNonEmpty = -1;
    for (let i = 0; i < buf.length; i++) {
      if ((buf.getLine(i)?.translateToString(true) || '').trim()) lastNonEmpty = i;
    }
    return { cur, lastNonEmpty };
  });
  console.log(JSON.stringify({ ...r, errors }));
  await browser.close();
  process.exit(r.cur.blink === true && r.cur.y === r.lastNonEmpty && errors.length === 0 ? 0 : 1);
})();
