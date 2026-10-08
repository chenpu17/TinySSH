// vis-r21 零回归面探针（参数化 URL，5183 新端与 5184 基线端各跑一次，同操作序）：
//  W 欢迎页 ×2 连拍（噪声底）
//  A 添加主机表单（默认密码模式）元素 ×2
//  S 设置弹窗元素 ×2（记录 boundingBox——新端弹窗含新增凭据库区，区域 diff 取顶部 min(h)）
//  T 终端态（点 prod-1 标签激活 xterm）×2
// 全程收集 console error / pageerror（分端报告）。
const { chromium } = require('/Users/chenpu/node_modules/playwright');
const EXE = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const URL = process.argv[2];
const OUT = process.argv[3];
(async () => {
  const browser = await chromium.launch({ executablePath: EXE, headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const jsErrors = [];
  page.on('pageerror', (e) => jsErrors.push('pageerror: ' + String(e)));
  page.on('console', (m) => { if (m.type() === 'error') jsErrors.push('console: ' + m.text()); });
  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => { try { localStorage.clear(); } catch {} });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.host-card', { timeout: 10000 });
  await page.waitForTimeout(400);

  // W 欢迎页
  await page.screenshot({ path: OUT + 'welcome-1.png' });
  await page.screenshot({ path: OUT + 'welcome-2.png' });

  // A 添加主机表单（密码默认态）
  await page.click('button.icon-btn[aria-label="添加主机"]');
  await page.waitForSelector('.add-host', { timeout: 6000 });
  await page.waitForTimeout(200);
  const addBox = await (await page.$('.add-host')).boundingBox();
  const addEl = await page.$('.add-host');
  await addEl.screenshot({ path: OUT + 'addhost-1.png' });
  await addEl.screenshot({ path: OUT + 'addhost-2.png' });
  await page.click('button[aria-label="收起表单"]');
  await page.waitForTimeout(200);

  // S 设置弹窗
  await page.click('.hb-settings');
  await page.waitForSelector('.term-settings', { timeout: 6000 });
  await page.waitForTimeout(300);
  const setBox = await (await page.$('.term-settings')).boundingBox();
  const setEl = await page.$('.term-settings');
  await setEl.screenshot({ path: OUT + 'settings-1.png' });
  await setEl.screenshot({ path: OUT + 'settings-2.png' });
  await page.click('.pop-mask');
  await page.waitForTimeout(200);

  // T 终端态
  await page.click('.tabbar .tab:has-text("prod-1")');
  await page.waitForSelector('.xterm-screen', { timeout: 8000 });
  await page.waitForTimeout(500);
  await page.screenshot({ path: OUT + 'terminal-1.png' });
  await page.screenshot({ path: OUT + 'terminal-2.png' });

  console.log(JSON.stringify({ addBox, setBox, jsErrors }));
  await browser.close();
})().catch((e) => { console.error('PROBE-ERROR ' + String(e)); process.exit(2); });
