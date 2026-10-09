const { chromium } = require('/Users/chenpu/node_modules/playwright');
const EXE = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const URL = process.env.PROBE_URL || 'http://localhost:5183/';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  const browser = await chromium.launch({ executablePath: EXE, headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push(String(e)));
  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => { try { localStorage.clear(); } catch {} });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.host-card', { timeout: 10000 });
  await sleep(1200);
  const info = await page.evaluate(() => {
    const q = (s) => document.querySelector(s);
    const cs = (s) => q(s) ? getComputedStyle(q(s)) : null;
    return {
      htmlChrome: document.documentElement.getAttribute('data-chrome') || document.documentElement.className,
      bodyBg: getComputedStyle(document.body).backgroundColor,
      collabEntry: !!q('[data-testid="collab-entry"]'),
      collabText: q('[data-testid="collab-entry"]')?.textContent,
      collabCls: q('[data-testid="collab-entry"]')?.className,
      collabBg: cs('[data-testid="collab-entry"]')?.backgroundColor,
      collabColor: cs('[data-testid="collab-entry"]')?.color,
      toolsCollab: !!q('[data-testid="tools-collab"]'),
      tabCount: document.querySelectorAll('.tab').length,
      tabs: [...document.querySelectorAll('.tab')].map(t => t.textContent.trim()),
      sessionToolbar: [...document.querySelectorAll('.session-toolbar button')].map(b => b.textContent.trim()),
      hasDelegateOpen: !!q('[data-testid="delegate-open"]'),
      hostCards: [...document.querySelectorAll('.host-card .host-name')].map(x => x.textContent),
      themeBtns: [...document.querySelectorAll('.ts-appearance button')].map(b => b.textContent),
    };
  });
  console.log(JSON.stringify(info, null, 2));
  console.log('ERRORS', errs);
  await page.screenshot({ path: '/tmp/r42-explore-default.png' });
  await browser.close();
})();
