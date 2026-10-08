// vis-r31 低发现处置判别：360 窄载时面包屑当前段须滚入视野（scrollLeft>0 或当前段右缘在容器内）。
const { chromium } = require('/Users/chenpu/node_modules/playwright');
const EXE = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  const browser = await chromium.launch({ executablePath: EXE, headless: true });
  const page = await (await browser.newContext({ viewport: { width: 360, height: 700 } })).newPage();
  await page.goto('http://localhost:5183/', { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => { try { localStorage.clear(); } catch {} });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.host-card');
  await sleep(400);
  await page.evaluate(() => {
    const t = [...document.querySelectorAll('[role="tab"]')].filter((x) => x.textContent.includes('prod-1'))[0];
    t?.click();
  });
  await sleep(700);
  await page.evaluate(() => document.querySelector('.st-file')?.click());
  await page.waitForSelector('[data-testid="sftp-crumbs"]', { timeout: 5000 });
  await sleep(1200);
  const r = await page.$eval('[data-testid="sftp-crumbs"]', (el) => {
    const cur = el.querySelector('.sftp-crumb.cur');
    const cr = cur.getBoundingClientRect();
    const er = el.getBoundingClientRect();
    return { sl: el.scrollLeft, sw: el.scrollWidth, cw: el.clientWidth, curVisible: cr.right <= er.right + 1 && cr.left >= er.left - 1 };
  });
  console.log(JSON.stringify(r));
  const pass = r.curVisible || r.sl > 0;
  console.log(pass ? 'PASS crumb current segment visible at narrow load' : 'FAIL current segment clipped');
  await browser.close();
  process.exit(pass ? 0 : 1);
})().catch((e) => { console.error('ERR', e); process.exit(2); });
