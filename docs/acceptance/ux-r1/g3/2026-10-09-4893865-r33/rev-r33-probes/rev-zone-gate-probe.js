// rev-r33 独立 mini 探针：右面板处于非文件页（端口转发）时，同坐标拖放必须走确认卡
//（zone 检测的 rightPanel==='files' 门）。红侧判别：摘门后此场景静默直传不可见面路径。
const { chromium } = require('/Users/chenpu/node_modules/playwright');
const EXE = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const URL = process.env.PROBE_URL || 'http://localhost:5183/';
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
  // 打开文件面板并导航（制造非 cwd 的 sftpPath）
  await page.evaluate(() => { document.querySelector('.st-file')?.click(); });
  await page.waitForSelector('[data-testid="sftp-list"]', { timeout: 5000 });
  await sleep(500);
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
  // 右面板切到端口转发页（面板仍挂载，非文件页）
  await page.evaluate(() => {
    [...document.querySelectorAll('.sb-btn')].find((b) => b.title === '端口转发')?.click();
  });
  await sleep(400);
  const rect = await page.$eval('.task-panel', (el) => { const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; });
  const n0 = (await demoInvoke('list_transfers')).length;
  await demoInvoke('demo_drag_drop', { paths: ['/Users/demo/Desktop/fwd-drop.bin'], x: rect.x, y: rect.y });
  await sleep(500);
  const card = await page.$('[data-testid="drop-dir-input"]');
  const uploads = (await demoInvoke('list_transfers')).filter((t) => t.kind === 'Upload' && t.source.endsWith('fwd-drop.bin'));
  if (card) {
    console.log('PASS forwards-drop -> confirm card (guarded)');
    console.log('  prefill =', await card.evaluate((el) => el.value));
  } else if (uploads.length) {
    console.log('RED forwards-drop -> SILENT upload, dest =', uploads[0].dest, '(panel zone leaked to forwards page)');
  } else {
    console.log('?? neither card nor upload');
  }
  await browser.close();
})().catch((e) => { console.error('PROBE-CRASH', e); process.exit(2); });
