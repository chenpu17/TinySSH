const { chromium } = require('/Users/chenpu/node_modules/playwright');
const EXE = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const URL = 'http://localhost:5183/';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  const browser = await chromium.launch({ executablePath: EXE, headless: true });
  for (const theme of ['dark', 'light']) {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, colorScheme: theme });
    const page = await ctx.newPage();
    await page.goto(URL, { waitUntil: 'domcontentloaded' });
    await page.evaluate(() => { try { localStorage.clear(); } catch {} });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.host-card', { timeout: 15000 });
    await sleep(500);
    await page.evaluate(() => {
      const card = [...document.querySelectorAll('.host-card')].find((c) => c.querySelector('.host-name')?.textContent.includes('prod-1'));
      card?.querySelector('.host-connect-btn')?.click();
    });
    await sleep(1200);
    await page.evaluate(() => { [...document.querySelectorAll('.st-tools button')].find((b) => b.textContent.includes('工具'))?.click(); });
    await sleep(200);
    await page.evaluate(() => { [...document.querySelectorAll('.tools-menu button')].find((b) => b.textContent.includes('端口转发'))?.click(); });
    await sleep(600);

    const dbg = await page.evaluate(() => {
      const btn = document.querySelector('.section button');
      const chain = [];
      let n = btn; while (n && chain.length < 8) { const cs = getComputedStyle(n); chain.push(n.tagName + '.' + String(n.className).split(' ').slice(0,2).join('.') + ' bg=' + cs.backgroundColor); n = n.parentElement; }
      const secs = [...document.querySelectorAll('.section')].map((s) => s.querySelector('h4')?.textContent);
      return { btnHtml: btn ? btn.outerHTML.slice(0, 120) : null, btnBg: btn ? getComputedStyle(btn).backgroundColor : null, chain, sections: secs };
    });
    console.log('=== ' + theme + ' ===');
    console.log('first .section button:', dbg.btnHtml);
    console.log('  bg:', dbg.btnBg);
    console.log('  ancestor chain:', JSON.stringify(dbg.chain, null, 1));
    console.log('  .section h4 texts:', JSON.stringify(dbg.sections));
    await ctx.close();
  }
  await browser.close();
})().catch((e) => { console.error('CRASH', e); process.exit(2); });
