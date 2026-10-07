// vis-r15 独立视觉复验：零回归（R13 基线三宽度/双主题）+ R15 偏好 blob 行为外观 + 几何 + 零 console 错误。
const { chromium } = require('/Users/chenpu/node_modules/playwright');
const BASE = '/Users/chenpu/workspace/claude-code/TinySSH/docs/acceptance/ux-r1/g1/2026-10-07-5179583-r13-actions/vis-shots';
const OUT = '/tmp/vis-r15-shots';
const URL = 'http://localhost:5183/';
const results = [];
const ok = (name, cond, detail = '') => { results.push({ name, pass: !!cond, detail }); console.log((cond ? 'PASS ' : 'FAIL ') + name + (detail ? '  [' + detail + ']' : '')); };
setTimeout(() => { console.error('PROBE-WATCHDOG'); process.exit(3); }, 240000).unref();

(async () => {
  const browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push('PAGEERROR: ' + String(e).slice(0, 200)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('CONSOLE: ' + m.text().slice(0, 200)); });

  const R = {};
  const box = async (sel) => { const el = await page.$(sel); if (!el) return null; const b = await el.boundingBox(); return b ? { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) } : null; };
  const cs = (sel, props) => page.$eval(sel, (el, props) => { const s = getComputedStyle(el); const o = {}; for (const p of props) o[p] = s.getPropertyValue(p); return o; }, props).catch(() => null);
  const shot = (n) => page.screenshot({ path: `${OUT}/${n}.png` });
  const tokens = () => page.evaluate(() => { const s = getComputedStyle(document.documentElement); return { panel: s.getPropertyValue('--panel').trim(), border: s.getPropertyValue('--border').trim(), chrome: document.documentElement.dataset.chrome }; });
  const cleanReload = async () => { await page.goto(URL, { waitUntil: 'domcontentloaded' }); await page.evaluate(() => localStorage.clear()); await page.reload({ waitUntil: 'networkidle' }); await page.waitForTimeout(1200); };

  await cleanReload();

  // ---- 1. 零回归：干净首载三宽度 + 几何 ----
  R.welcome1280 = {
    titlebar: await box('.titlebar'), hostbar: await box('.hostbar'), statusbar: await box('.statusbar'),
    tabbarRow: await box('.tabbar-row'), welcome: !!(await page.$('.welcome')),
    hostCards: await page.$$eval('.host-card', (els) => els.length),
    hScroll: await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth),
    tokens: await tokens(),
  };
  await shot('w1280-dark');
  for (const [w, h, n] of [[1024, 768, 'w1024-dark'], [960, 600, 'w960-dark']]) {
    await page.setViewportSize({ width: w, height: h });
    await page.waitForTimeout(400);
    R['vp' + w] = {
      titlebar: await box('.titlebar'), hostbar: await box('.hostbar'), statusbar: await box('.statusbar'), main: await box('.main'),
      welcome: !!(await page.$('.welcome')),
      hScroll: await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth),
    };
    await shot(n);
    if (w === 1024) {
      await page.click('.sb-btn[title="文件与传输"]');
      await page.waitForTimeout(450);
      R.vp1024.filesTpFull = await page.$eval('.task-panel', (el) => el.classList.contains('tp-full')).catch(() => null);
      R.vp1024.panelBox = await box('.task-panel');
      await shot('w1024-files-tpfull');
      await page.click('.tp-head button[aria-label="关闭任务面板"]').catch(() => {});
      await page.waitForTimeout(250);
      R.vp1024.panelClosed = (await page.$('.task-panel')) === null;
    }
  }
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.waitForTimeout(400);
  ok('1a 首载 1280 几何 titlebar=44/statusbar=24/hostbar=224', R.welcome1280.titlebar?.h === 44 && R.welcome1280.statusbar?.h === 24 && R.welcome1280.hostbar?.w === 224 && R.welcome1280.hostbar?.x === 0, JSON.stringify(R.welcome1280));
  ok('1b 三宽度零横向破版', !R.welcome1280.hScroll && !R.vp1024.hScroll && !R.vp960.hScroll, [R.welcome1280.hScroll, R.vp1024.hScroll, R.vp960.hScroll].join(','));
  ok('1c 1024 面板 tp-full 开合', R.vp1024.filesTpFull === true && R.vp1024.panelClosed === true, JSON.stringify(R.vp1024));

  // ---- 2. 双主题（设置面板 UI 路径）----
  await page.click('.hb-settings'); await page.waitForTimeout(350);
  R.settingsOpen = !!(await page.$('.term-settings'));
  const opts = await page.$$('.ts-themes .ts-opt');
  await shot('w1280-theme-settings');
  await opts[1].click(); await page.waitForTimeout(450);
  R.light = { tokens: await tokens(), titlebarBg: (await cs('.titlebar', ['background-color']))['background-color'], statusbar: await cs('.statusbar', ['color']), hostbar: await cs('.hostbar', ['background-color']), hScroll: await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth) };
  await shot('w1280-theme-light');
  await opts[0].click(); await page.waitForTimeout(450);
  R.darkRestore = { tokens: await tokens() };
  await shot('w1280-theme-dark-restore');
  await page.keyboard.press('Escape'); await page.waitForTimeout(250);
  R.settingsClosedByEsc = (await page.$('.term-settings')) === null;
  ok('2a 设置面板开/浅色 token/light 背景变体', R.settingsOpen && R.light.tokens.chrome === 'light' && R.light.hScroll === false && R.darkRestore.tokens.chrome === 'dark', JSON.stringify({ light: R.light.tokens, dark: R.darkRestore.tokens }));
  ok('2b Esc 关设置面板', R.settingsClosedByEsc === true);

  // ---- 3a. blob hostbar open:false ----
  await page.evaluate(() => localStorage.setItem('ui.v2.workspace', JSON.stringify({ schema_version: 1, chrome: 'dark', hostbar: { open: false, width: 260 } })));
  await page.reload({ waitUntil: 'networkidle' }); await page.waitForTimeout(1000);
  R.blobCollapsed = {
    hostbar: (await page.$('.hostbar')) !== null,
    hbExpand: await box('.hb-expand'),
    main: await box('.main'), titlebar: await box('.titlebar'), statusbar: await box('.statusbar'),
    tokens: await tokens(),
    hScroll: await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth),
  };
  await shot('w1280-blob-collapsed');
  ok('3a blob open:false → hostbar 收起 + .hb-expand 在位 + 布局不破', R.blobCollapsed.hostbar === false && !!R.blobCollapsed.hbExpand && !R.blobCollapsed.hScroll, JSON.stringify(R.blobCollapsed));

  // ---- 3b. blob hostbar open:true width:250 ----
  await page.evaluate(() => localStorage.setItem('ui.v2.workspace', JSON.stringify({ schema_version: 1, chrome: 'dark', hostbar: { open: true, width: 250 } })));
  await page.reload({ waitUntil: 'networkidle' }); await page.waitForTimeout(1000);
  R.blob250 = {
    hostbar: await box('.hostbar'), hostCards: await page.$$eval('.host-card', (els) => els.length),
    main: await box('.main'), titlebar: await box('.titlebar'),
    cardRight: await page.evaluate(() => { const hb = document.querySelector('.hostbar'); const card = document.querySelector('.host-card'); if (!hb || !card) return null; const a = hb.getBoundingClientRect(), b = card.getBoundingClientRect(); return { hbRight: Math.round(a.right), cardRight: Math.round(b.right), cardFits: b.right <= a.right + 0.5 }; }),
    hScroll: await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth),
  };
  await shot('w1280-blob-250');
  ok('3b blob width:250 → 主机栏 250px + 卡片完整 + 右移布局', R.blob250.hostbar?.w === 250 && R.blob250.main?.x === 250 && R.blob250.cardRight?.cardFits && !R.blob250.hScroll, JSON.stringify(R.blob250));

  // ---- 3c. 宽度夹取 200–300 ----
  for (const [wIn, wClamp] of [[150, 200], [400, 300]]) {
    await page.evaluate((w) => localStorage.setItem('ui.v2.workspace', JSON.stringify({ schema_version: 1, chrome: 'dark', hostbar: { open: true, width: w } })), wIn);
    await page.reload({ waitUntil: 'networkidle' }); await page.waitForTimeout(900);
    const w = await page.$eval('.hostbar', (el) => Math.round(el.getBoundingClientRect().width)).catch(() => -1);
    ok(`3c 夹取 ${wIn} → ${wClamp}`, w === wClamp, String(w));
    await shot(`w1280-blob-clamp${wIn}`);
  }

  R.consoleErrors = errors;
  ok('5 零 console/page 错误', errors.length === 0, errors.slice(0, 3).join(' | '));
  fs_write(R);
  function fs_write(o) { require('fs').writeFileSync('/tmp/vis-r15-result.json', JSON.stringify(o, null, 1)); }
  await browser.close();
  console.log('DONE');
})().catch((e) => { console.error('FATAL', e); process.exit(2); });
