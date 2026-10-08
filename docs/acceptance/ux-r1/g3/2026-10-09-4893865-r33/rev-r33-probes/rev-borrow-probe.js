// rev-r33 scratch 实证：无可信 cwd（brief.cwd=null）时，终端落点确认卡的预填来源。
// 规格 §354：「没有可信 cwd 时先选远端目录，不从不可见文件面板借用旧路径」。
// 场景：浏览 /root/deploy 后关闭文件面板（路径不可见），拖入终端。
// 合规实现预填应为空；若预填=/root/deploy 即为「借用不可见面板旧路径」。
const { chromium } = require('/Users/chenpu/node_modules/playwright');
const EXE = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const URL = process.env.PROBE_URL || 'http://localhost:5185/';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const browser = await chromium.launch({ executablePath: EXE, headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();
  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => { try { localStorage.clear(); } catch {} });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.host-card', { timeout: 10000 });
  await sleep(400);
  const demoInvoke = (cmd, args) => page.evaluate(async ({ c, a }) => {
    const { invoke } = await import('/src/adapter/bridge.ts');
    return invoke(c, a);
  }, { c: cmd, a: args });
  const waitFor_ = async (fn, tries, gap = 150) => {
    for (let i = 0; i < tries; i++) { const v = await fn(); if (v) return v; await sleep(gap); }
    return null;
  };
  await page.evaluate(() => {
    const card = [...document.querySelectorAll('.host-card')].find((c) => c.querySelector('.host-name')?.textContent.includes('prod-1'));
    card?.querySelector('.host-connect-btn')?.click();
  });
  await page.waitForSelector('.hk-mask', { timeout: 4000 }).catch(() => {});
  await page.evaluate(() => {
    [...document.querySelectorAll('.hk-mask button')].find((x) => x.textContent.includes('信任并连接'))?.click();
  });
  await waitFor_(async () => (await demoInvoke('list_sessions')).some((x) => x.state === 'Connected'), 60);
  await page.evaluate(() => { document.querySelector('.st-file')?.click(); });
  await page.waitForSelector('[data-testid="sftp-list"]', { timeout: 5000 });
  await sleep(500);
  const firstPath = await page.$eval('[data-testid="sftp-crumbs"]', (e) => e.title).catch(() => '');
  await page.click('.sftp-nav button[aria-label="切换路径输入"]');
  await page.waitForSelector('[data-testid="sftp-path-input"]', { timeout: 3000 });
  await page.evaluate(() => {
    const el = document.querySelector('[data-testid="sftp-path-input"]');
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(el, '/root/deploy');
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.keyboard.press('Enter');
  await waitFor_(async () => (await page.$eval('[data-testid="sftp-crumbs"]', (e) => e.title).catch(() => '')) === '/root/deploy', 30);
  // 关闭文件面板（sftpPath 保留在状态里但路径不可见）
  await page.evaluate(() => { document.querySelector('.task-panel .tp-head button[aria-label="关闭任务面板"]')?.click(); });
  await sleep(300);
  await demoInvoke('demo_drag_drop', { paths: ['/Users/demo/Desktop/invisible-borrow.bin'], x: 300, y: 400 });
  const card = await waitFor_(async () => page.$('[data-testid="drop-dir-input"]'), 20);
  if (!card) { console.log('?? no confirm card'); await browser.close(); return; }
  const prefill = await card.evaluate((el) => el.value);
  const hint = await page.evaluate(() => [...document.querySelectorAll('.confirm-dialog .dim')].map((d) => d.textContent).join(' | '));
  if (prefill === '') {
    console.log('PASS no-borrow: prefill empty, user must type dir');
    console.log('  hint =', hint);
  } else {
    console.log('RED invisible-panel borrow: prefill =', JSON.stringify(prefill), '(panel closed, path not visible)');
    console.log('  hint =', hint);
  }
  await browser.close();
})().catch((e) => { console.error('PROBE-CRASH', e); process.exit(2); });
