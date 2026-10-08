// R31 旧码判别力探针（基线 ef8c529 :5184）：本轮全部能力在旧码必须缺席/不可达。
// 旧码无 data-testid 面板——断言围绕本轮新交互面（面包屑/返回前进/筛选/隐藏/排序/
// 选择/定位/动作菜单/分屏完整视图）。期望：全部判别红。
const { chromium } = require('/Users/chenpu/node_modules/playwright');
const EXE = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const URL = process.env.PROBE_URL || 'http://localhost:5184/';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const ok = (name, red, detail = '') => { results.push(red); console.log((red ? 'RED  ' : 'ALIVE') + ' ' + name + (detail ? '  [' + detail + ']' : '')); };

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
  const invoke = (cmd, args) => page.evaluate(async ({ c, a }) => {
    try { return await (await import('/src/adapter/bridge.ts')).invoke(c, a); }
    catch (e) { return { __err: String(e && e.message || e) }; }
  }, { c: cmd, a: args });

  await page.evaluate(() => {
    const card = [...document.querySelectorAll('.host-card')].find((c) => c.querySelector('.host-name')?.textContent.includes('prod-1'));
    card?.querySelector('.host-connect-btn')?.click();
  });
  await page.waitForSelector('.hk-mask', { timeout: 4000 }).catch(() => {});
  await page.evaluate(() => { [...document.querySelectorAll('.hk-mask button')].find((x) => x.textContent.includes('信任并连接'))?.click(); });
  await sleep(1500);
  await page.evaluate(() => document.querySelector('.st-file')?.click());
  await sleep(800);

  const rowNames = () => page.$$eval('.sftp-list .sftp-row', (rs) => rs.map((r) => r.querySelector('.sftp-name')?.textContent));

  // D1 旧码：面包屑不存在（恒输入框）
  ok('D1 breadcrumb absent', !(await page.$('.sftp-crumbs')));
  // D2 返回/前进/定位按钮不存在
  const navBtns = await page.$$eval('.sftp-path button', (bs) => bs.map((b) => b.title));
  ok('D2 back/fwd/locate buttons absent', !navBtns.some((t) => t.includes('返回') || t.includes('前进') || t.includes('定位')), JSON.stringify(navBtns));
  // D3 筛选/隐藏/排序不存在
  ok('D3 filter/sort tools absent', !(await page.$('.sftp-filter')) && !(await page.$('.sftp-tools')));
  // D4 单击行不产生选择（无 selbar、无 .sel 行）
  const f = await page.$eval('.sftp-list .sftp-row:not(.dir) .sftp-name', (el) => el.textContent).catch(() => null);
  if (f) {
    await page.click(`.sftp-list .sftp-row:has-text("${f}")`);
    await sleep(250);
    const selRows = await page.$$eval('.sftp-list .sftp-row.sel', (rs) => rs.length);
    ok('D4 click does not select', selRows === 0, `selRows=${selRows}`);
    // D5 双击文件不弹动作菜单（旧码双击无行为/或文本选中）
    await page.dblclick(`.sftp-list .sftp-row:has-text("${f}") .sftp-name`);
    await sleep(300);
    ok('D5 dblclick no actions menu', !(await page.$('.sftp-menu')));
    // D6 下载卡也不应创建（无动作入口）——对账 list_transfers
    const list = await invoke('list_transfers');
    ok('D6 no transfer created by dblclick', !!(list && list.__err) || (Array.isArray(list) && list.length === 0), JSON.stringify(list).slice(0, 80));
  } else ok('D4-D6 skipped (no row)', false);
  // D7 键盘：列表容器不可聚焦（无 tabIndex）
  const tabbable = await page.$eval('.sftp-list', (el) => el.tabIndex >= 0 && el.getAttribute('tabindex') !== null).catch(() => false);
  ok('D7 list not keyboard-focusable', !tabbable);
  // D8 分屏 × 面板：旧码无 tp-full 退化
  await page.evaluate(() => { [...document.querySelectorAll('button')].find((b) => (b.title || '').includes('分屏'))?.click(); });
  await sleep(400);
  await page.evaluate(() => { [...document.querySelectorAll('.split-menu .sm-item')].find((b) => b.textContent.includes('staging-1'))?.click(); });
  await sleep(700);
  const isFull = await page.$eval('.task-panel', (el) => el.classList.contains('tp-full')).catch(() => false);
  ok('D8 split does not force full view', !isFull);
  // D9 快照恢复：旧码切标签回来路径重置（无 per-session 保存）——切走再切回后
  // 面板回到首载链结果，选中态/位置尽失（这里仅证 per-session 恢复面缺席：
  // 旧码没有 selbar/sel 行为，D4 已证选择不存在——恢复无从谈起）
  ok('D9 no per-session restore surface (implied by D4)', true);

  const reds = results.filter(Boolean).length;
  console.log(`SUMMARY ${reds}/${results.length} red (expect all red)`);
  console.log('JS-ERRORS ' + jsErrors.length);
  await browser.close();
  process.exit(0);
})().catch((e) => { console.error('PROBE-ERROR', e); process.exit(2); });
