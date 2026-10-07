// vis-r14 独立视觉复验：零回归（vs R15 基线三宽度 + light）+ 终端垂直流程视觉状态（TOFU/连接 tab/工具菜单/确认弹窗/死会话 dim）+ 双主题 + 零 console 错误。
const { chromium } = require('/Users/chenpu/node_modules/playwright');
const BASE = '/Users/chenpu/workspace/claude-code/TinySSH/docs/acceptance/ux-r1/g1/2026-10-07-bbdd40c-r15-prefs/vis-shots';
const OUT = '/tmp/vis-r14-shots';
const URL = 'http://localhost:5183/';
const results = [];
const ok = (name, cond, detail = '') => { results.push({ name, pass: !!cond, detail }); console.log((cond ? 'PASS ' : 'FAIL ') + name + (detail ? '  [' + detail + ']' : '')); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
setTimeout(() => { console.error('VIS-WATCHDOG'); process.exit(3); }, 240000).unref();
const fs = require('fs');
const { execFileSync } = require('child_process');

(async () => {
  const browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push('PAGEERROR: ' + String(e).slice(0, 200)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('CONSOLE: ' + m.text().slice(0, 200)); });

  const box = async (sel) => { const el = await page.$(sel); if (!el) return null; const b = await el.boundingBox(); return b ? { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) } : null; };
  const shot = (n) => page.screenshot({ path: `${OUT}/${n}.png` });
  const tokens = () => page.evaluate(() => { const s = getComputedStyle(document.documentElement); return { panel: s.getPropertyValue('--panel').trim(), border: s.getPropertyValue('--border').trim(), chrome: document.documentElement.dataset.chrome }; });
  const hScroll = () => page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  const cmp = (name, baseFile, curFile) => {
    try {
      const ae = +execFileSync('compare', ['-metric', 'AE', '-fuzz', '3%', `${BASE}/${baseFile}`, `${OUT}/${curFile}`, `${OUT}/diff-${name}.png`], { stdio: ['pipe', 'pipe', 'pipe'], stderr: 'pipe' }).toString().trim() || 0;
      const st = fs.statSync(`${OUT}/${curFile}`);
      const total = 1280 * 800;
      return { ae, pct: +(ae / total * 100).toFixed(4), kb: Math.round(st.size / 1024) };
    } catch (e) { return { ae: +String(e.stderr || '').trim() || -1, raw: String(e.message).slice(0, 120) }; }
  };

  const R = {};

  // ---- 1. 零回归：干净首载三宽度 ----
  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(1200);
  R.geo1280 = { titlebar: await box('.titlebar'), hostbar: await box('.hostbar'), statusbar: await box('.statusbar'), welcome: !!(await page.$('.welcome')), hostCards: await page.$$eval('.host-card', (e) => e.length), hScroll: await hScroll(), tokens: await tokens() };
  await shot('w1280-dark');
  for (const [w, h, n] of [[1024, 768, 'w1024-dark'], [960, 600, 'w960-dark']]) {
    await page.setViewportSize({ width: w, height: h });
    await page.waitForTimeout(400);
    R['geo' + w] = { titlebar: await box('.titlebar'), hostbar: await box('.hostbar'), statusbar: await box('.statusbar'), welcome: !!(await page.$('.welcome')), hScroll: await hScroll() };
    await shot(n);
  }
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.waitForTimeout(400);
  R.cmp1280 = cmp('w1280-dark', 'w1280-dark.png', 'w1280-dark.png');
  R.cmp1024 = cmp('w1024-dark', 'w1024-dark.png', 'w1024-dark.png');
  R.cmp960 = cmp('w960-dark', 'w960-dark.png', 'w960-dark.png');
  ok('1a 首载 1280 几何 44/224/24 + 欢迎态', R.geo1280.titlebar?.h === 44 && R.geo1280.statusbar?.h === 24 && R.geo1280.hostbar?.w === 224 && R.geo1280.welcome && !R.geo1280.hScroll, JSON.stringify(R.geo1280));
  ok('1b 三宽度零横向破版', !R.geo1280.hScroll && !R.geo1024.hScroll && !R.geo960.hScroll, [R.geo1280.hScroll, R.geo1024.hScroll, R.geo960.hScroll].join(','));
  ok('1c vs R15 基线 1280 AE≈0', R.cmp1280.ae === 0, JSON.stringify(R.cmp1280));
  ok('1d vs R15 基线 1024 AE≈0', R.cmp1024.ae === 0, JSON.stringify(R.cmp1024));
  ok('1e vs R15 基线 960 AE≈0', R.cmp960.ae === 0, JSON.stringify(R.cmp960));

  // ---- 2. 双主题抽查（设置面板 UI 路径）----
  await page.click('.hb-settings'); await page.waitForTimeout(400);
  const opts = await page.$$('.ts-themes .ts-opt');
  await opts[1].click(); await page.waitForTimeout(500);
  R.light = { tokens: await tokens(), hScroll: await hScroll() };
  await page.keyboard.press('Escape'); await page.waitForTimeout(300);
  await shot('w1280-theme-light-welcome');
  R.cmpLight = cmp('w1280-theme-light', 'w1280-theme-light.png', 'w1280-theme-light-welcome.png');
  await page.click('.hb-settings'); await page.waitForTimeout(350);
  const opts2 = await page.$$('.ts-themes .ts-opt');
  await opts2[0].click(); await page.waitForTimeout(450);
  R.darkRestore = { tokens: await tokens() };
  await page.keyboard.press('Escape'); await page.waitForTimeout(250);
  R.darkClosed = (await page.$('.term-settings')) === null;
  ok('2a light/dark token 切换不破', R.light.tokens.chrome === 'light' && !R.light.hScroll && R.darkRestore.tokens.chrome === 'dark' && R.darkClosed, JSON.stringify({ light: R.light.tokens, dark: R.darkRestore.tokens }));

  // ---- 3. 垂直流程视觉状态 ----
  // 3a TOFU 弹窗
  const card = await page.$('.host-card:has-text("staging-1")');
  ok('3a-1 staging-1 卡片在位', !!card);
  await card.click();
  let tofu = true; try { await page.waitForSelector('.hk-mask', { timeout: 6000 }); } catch { tofu = false; }
  ok('3a-2 TOFU 弹窗出现', tofu);
  if (tofu) {
    R.tofu = {
      mask: await box('.hk-mask'),
      viewport: { w: 1280, h: 800 },
      centered: await page.$eval('.hk-mask', (el) => { const r = el.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }; }),
      btns: await page.$$eval('.hk-mask button', (els) => els.map((b) => b.textContent.trim())),
      hScroll: await hScroll(),
    };
    R.tofu.visual = R.tofu.centered.x >= 0 && R.tofu.centered.y >= 0 && R.tofu.centered.w > 0 && R.tofu.centered.x + R.tofu.centered.w <= 1281 && !R.tofu.hScroll;
    await shot('flow-a-tofu');
    ok('3a-3 TOFU 遮罩居中不破版', R.tofu.visual, JSON.stringify(R.tofu.centered) + ' btns=' + JSON.stringify(R.tofu.btns));
    await page.click('.hk-mask button:has-text("信任并连接")');
  }
  // 3b 连接后标签 + tab-dot.ok
  await page.waitForSelector('.tabbar .tab.tab-active', { timeout: 8000 });
  await sleep(700);
  R.tabConn = await page.evaluate(() => {
    const tabs = [...document.querySelectorAll('.tabbar .tab')];
    const active = tabs.find((t) => t.classList.contains('tab-active'));
    const dot = active?.querySelector('.tab-dot');
    const okRgb = getComputedStyle(document.documentElement).getPropertyValue('--ok').trim();
    const toRgb = (hex) => { const n = hex.replace('#', ''); const v = n.length === 3 ? n.split('').map((c) => c + c).join('') : n; return `rgb(${[0, 2, 4].map((i) => parseInt(v.slice(i, i + 2), 16)).join(', ')})`; };
    return {
      n: tabs.length, activeText: active?.textContent.trim().slice(0, 30),
      dotOk: dot?.classList.contains('ok'), dotClass: dot?.className,
      dotColor: dot ? getComputedStyle(dot).backgroundColor : null,
      dotMatchesOkVar: dot ? getComputedStyle(dot).backgroundColor === toRgb(okRgb) : null, okVar: okRgb,
      toolbar: !!document.querySelector('.session-toolbar'), xterm: !!document.querySelector('.xterm'),
    };
  });
  await shot('flow-b-connected');
  ok('3b 连接标签 tab-dot.ok 绿点 + 激活态 + 终端在位', R.tabConn.dotOk === true && R.tabConn.dotMatchesOkVar === true && R.tabConn.toolbar && R.tabConn.xterm, JSON.stringify(R.tabConn));
  ok('3b-2 dot 色=--ok token', !!R.tabConn.okVar, '--ok=' + R.tabConn.okVar + ' dot=' + R.tabConn.dotColor);
  // 3c 工具菜单
  await page.click('.session-toolbar button[aria-haspopup="menu"]');
  await sleep(350);
  R.menu = {
    items: await page.$$eval('[role="menuitem"]', (els) => els.map((e) => e.textContent.trim())),
    menuBox: await page.$eval('[role="menu"]', (el) => { const r = el.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }; }).catch(() => null),
    hScroll: await hScroll(),
  };
  await shot('flow-c-toolmenu');
  ok('3c 工具菜单展开含「关闭会话…」', R.menu.items.some((t) => t.includes('关闭会话')) && R.menu.menuBox && !R.menu.hScroll, JSON.stringify(R.menu.items));
  // 3d 确认弹窗
  await page.click('[role="menuitem"]:has-text("关闭会话")');
  await sleep(350);
  R.confirm = {
    mask: await page.$eval('.confirm-mask', (el) => { const r = el.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }; }).catch(() => null),
    dangerText: await page.$eval('.confirm-mask button.danger', (el) => el.textContent.trim()).catch(() => null),
    hScroll: await hScroll(),
  };
  await shot('flow-d-confirm');
  const c = R.confirm.mask;
  R.confirm.visual = !!c && c.x >= 0 && c.y >= 0 && c.w > 0 && c.x + c.w <= 1281 && !!R.confirm.dangerText && !R.confirm.hScroll;
  ok('3d 确认弹窗完整（danger 钮在位）', R.confirm.visual, JSON.stringify(R.confirm));
  // 3e 关闭 → dim 死会话保留
  await page.click('.confirm-mask button.danger');
  await sleep(800);
  R.dead = await page.evaluate(() => {
    const tabs = [...document.querySelectorAll('.tabbar .tab')];
    const st = tabs.find((t) => t.textContent.includes('staging'));
    const dot = st?.querySelector('.tab-dot');
    return {
      n: tabs.length, stText: st?.textContent.trim().slice(0, 30),
      dotDim: dot ? !dot.classList.contains('ok') : null, dotClass: dot?.className,
      dotColor: dot ? getComputedStyle(dot).backgroundColor : null,
      toolbarGone: !document.querySelector('.session-toolbar'), hScroll: document.documentElement.scrollWidth > window.innerWidth,
    };
  });
  await shot('flow-e-dead-tab');
  R.dimVar = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--dim').trim());
  ok('3e 关闭后 tab-dot 转 dim（死会话保留）+ 无破版', R.dead.dotDim === true && R.dead.n >= 1 && !R.dead.hScroll, JSON.stringify(R.dead));

  // ---- 4. 零错误 ----
  R.errors = errors;
  ok('4 零 console/page 错误', errors.length === 0, errors.slice(0, 3).join(' | '));

  fs.writeFileSync('/tmp/vis-r14-result.json', JSON.stringify(R, null, 1));
  await browser.close();
  const fails = results.filter((r) => !r.pass);
  console.log(fails.length ? 'VIS-FAIL ' + fails.length : 'VIS-ALL-PASS ' + results.length);
  process.exit(fails.length ? 1 : 0);
})().catch((e) => { console.error('FATAL', String(e).slice(0, 500)); process.exit(2); });
