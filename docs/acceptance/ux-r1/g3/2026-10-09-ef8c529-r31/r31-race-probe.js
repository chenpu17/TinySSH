// R31 竞态判别探针：会话切换必须作废在途 loadDir 响应——
// A 会话慢导航在途 → 切到 B → 切回 A（快照恢复）→ 晚到响应落地。
// 约定：恢复后的路径/条目 = 快照态，不被旧会话在途结果覆盖。
// 旧码（无 gen 作废）：晚到 /root 响应覆盖恢复态 → 本探针红。
const { chromium } = require('/Users/chenpu/node_modules/playwright');
const EXE = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const URL = process.env.PROBE_URL || 'http://localhost:5183/';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const browser = await chromium.launch({ executablePath: EXE, headless: true });
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
  const jsErrors = [];
  page.on('pageerror', (e) => jsErrors.push(String(e)));
  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => { try { localStorage.clear(); } catch {} });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.host-card', { timeout: 10000 });
  await sleep(400);
  const invoke = (cmd, args) => page.evaluate(async ({ c, a }) => (await import('/src/adapter/bridge.ts')).invoke(c, a), { c: cmd, a: args });
  const crumbs = () => page.$eval('[data-testid="sftp-crumbs"]', (el) => el.title || null).catch(() => null);
  let pass = 0, total = 0;
  const ok = (name, cond, detail = '') => { total++; if (cond) pass++; console.log((cond ? 'PASS ' : 'FAIL ') + name + (detail ? '  [' + detail + ']' : '')); };

  // 预访 staging-1 一次（建立其快照——这样第二次进入不再走首载链 loadDir，
  // 不会顺带递增请求代际；真正的作废只能来自切会话本身）
  await page.evaluate(() => {
    [...document.querySelectorAll('[role="tab"]')].filter((x) => x.textContent.includes('staging-1'))[0]?.click();
  });
  await sleep(900);
  await page.evaluate(() => {
    [...document.querySelectorAll('[role="tab"]')].filter((x) => x.textContent.includes('prod-1'))[0]?.click();
  });
  await sleep(700);

  // 附到种子 prod-1（会话 A）
  await page.evaluate(() => {
    const t = [...document.querySelectorAll('[role="tab"]')].filter((x) => x.textContent.includes('prod-1'))[0];
    t?.click();
  });
  await sleep(700);
  await page.evaluate(() => document.querySelector('.st-file')?.click());
  await page.waitForSelector('[data-testid="sftp-crumbs"]', { timeout: 5000 });
  await sleep(800); // 首载 /var/log/nginx
  ok('S1 A at first-load path', (await crumbs()) === '/var/log/nginx', await crumbs());

  // 预置 /root 慢响应 900ms；发起导航（在途）后立刻切到 staging-1 再切回
  await invoke('demo_sftp_slow', { path: '/root', ms: 2600 });
  await page.click('.sftp-nav button[aria-label="切换路径输入"]');
  await page.fill('[data-testid="sftp-path-input"]', '/root');
  await page.press('[data-testid="sftp-path-input"]', 'Enter');
  await sleep(80); // 导航已在途（慢响应未回）
  await page.evaluate(() => {
    [...document.querySelectorAll('[role="tab"]')].filter((x) => x.textContent.includes('staging-1'))[0]?.click();
  });
  await sleep(500); // B 面板（自己的状态）
  await page.evaluate(() => {
    [...document.querySelectorAll('[role="tab"]')].filter((x) => x.textContent.includes('prod-1'))[0]?.click();
  });
  await sleep(250); // 恢复快照（/var/log/nginx），慢响应尚未到期
  // 被作废的导航使编辑态留存（如实行为）——Esc 还原到当前路径再断言
  const editOpen = await page.$('[data-testid="sftp-path-input"]');
  if (editOpen) await page.press('[data-testid="sftp-path-input"]', 'Escape');
  await sleep(150);
  ok('S2 restored snapshot path (after Esc re-sync)', (await crumbs()) === '/var/log/nginx', await crumbs());
  await sleep(2800); // 慢响应此时落地——核心不变量：条目不得被覆盖为 /root 内容
  ok('S3 stale in-flight response discarded after restore', (await crumbs()) === '/var/log/nginx', await crumbs());
  const names = await page.$$eval('[data-testid="sftp-list"] .sftp-row', (rs) => rs.map((r) => r.dataset.name));
  ok('S3b entries still snapshot content (not /root)', names.includes('access.log') && !names.includes('nginx.conf'), names.join(','));
  const rowErr = await page.$$eval('.section .err', (els) => els.map((e) => e.textContent).join('|'));
  ok('S4 no error banner leaked from stale response', !rowErr.includes('不存在'), rowErr);
  ok('S5 zero JS errors', jsErrors.length === 0, jsErrors.slice(0, 2).join('|'));

  console.log(`SUMMARY ${pass}/${total}`);
  await browser.close();
  process.exit(pass === total ? 0 : 1);
})().catch((e) => { console.error('PROBE-ERROR', e); process.exit(2); });
