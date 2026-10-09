// 探索探针：确认 R42 协作面板新结构渲染（分组/目的/委托/入口）——非归档口径
const { chromium } = require('/Users/chenpu/node_modules/playwright');
const EXE = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const URL = process.env.PROBE_URL || 'http://localhost:5183/';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  const browser = await chromium.launch({ executablePath: EXE, headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();
  const errs = []; page.on('pageerror', (e) => errs.push(String(e)));
  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => { try { localStorage.clear(); } catch {} });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.host-card', { timeout: 10000 });
  await sleep(500);
  const demoInvoke = (cmd, args) => page.evaluate(async ({ c, a }) => {
    const m = await import('/src/demo.ts'); return m.invoke(c, a);
  }, { c: cmd, a: args });
  const count = (sel) => page.evaluate((s) => document.querySelectorAll(s).length, sel);
  const txt = (sel) => page.evaluate((s) => document.querySelector(s)?.textContent ?? null, sel);

  await page.evaluate(() => { [...document.querySelectorAll('.tab')].find((t) => t.textContent.includes('prod-1'))?.click(); });
  await sleep(700);
  // 注入一张他机待审批（staging-1），验证跨会话分组
  const sid2 = (await demoInvoke('list_sessions')).find((s) => s.host_name === 'staging-1').id;
  await demoInvoke('demo_inject_approval', { sid: sid2, command: 'systemctl restart nginx' });
  await sleep(3600);
  await page.evaluate(() => { [...document.querySelectorAll('.st-tools button')].find((b) => b.textContent.includes('工具'))?.click(); });
  await sleep(200);
  console.log('tools menu items:', await page.evaluate(() => [...document.querySelectorAll('.tools-menu button')].map((b) => b.textContent)));
  await page.evaluate(() => document.querySelector('[data-testid="tools-collab"]')?.click());
  await sleep(600);
  console.log('collab-entry:', await count('[data-testid="collab-entry"]'));
  console.log('ap-group:', await count('[data-testid="ap-group"]'));
  console.log('ap-group heads:', await page.evaluate(() => [...document.querySelectorAll('.ap-group-head')].map((h) => h.textContent)));
  console.log('ap-purpose:', await page.evaluate(() => [...document.querySelectorAll('[data-testid="ap-purpose"]')].map((p) => p.textContent)));
  console.log('tsum-chip:', await count('.tsum-chip'));
  console.log('delegate-open-panel:', await count('[data-testid="delegate-open-panel"]'));
  console.log('collab-unconfigured:', await count('[data-testid="collab-unconfigured"]'));
  console.log('goal-input:', await count('.goal-input'));
  console.log('JS errors:', errs);
  await browser.close();
})();
