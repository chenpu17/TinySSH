const { chromium } = require('/Users/chenpu/node_modules/playwright');
(async () => {
  const browser = await chromium.launch({ headless: true, executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 200)); });
  page.on('pageerror', (e) => errors.push('PAGEERROR: ' + String(e).slice(0, 200)));
  const R = {};
  const shot = (n) => page.screenshot({ path: `/tmp/vis-r12-shots/${n}.png` });

  await page.goto('http://localhost:5183', { waitUntil: 'networkidle' });
  await page.waitForTimeout(1200);

  // 1) toast vs statusbar（连接成功路径）
  const card = await page.$('.host-card');
  await card.hover(); await page.waitForTimeout(250);
  await page.click('.host-card .host-connect-btn');
  await page.waitForTimeout(900);
  R.toast = await page.evaluate(() => {
    const t = document.querySelector('.toast'), s = document.querySelector('.statusbar'), stack = document.querySelector('.toast-stack');
    if (!t || !s) return { toast: !!t, statusbar: !!s };
    const a = t.getBoundingClientRect(), b = s.getBoundingClientRect();
    return { stackBottom: getComputedStyle(stack).bottom, toastTop: Math.round(a.top), toastBottom: Math.round(a.bottom), sbTop: Math.round(b.top), sbBottom: Math.round(b.bottom), verticalOverlapPx: Math.round(Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top)), gapPx: Math.round(b.top - a.bottom) };
  });
  await shot('20-recheck-toast');

  // 2) st-title 长名省略号（30 字 CJK 注入）
  R.stTitle = await page.evaluate(() => {
    const st = document.querySelector('.st-title');
    if (!st) return null;
    st.textContent = '一二三四五六七八九十'.repeat(3);
    const s = getComputedStyle(st), bar = document.querySelector('.session-toolbar');
    const o = { minW: s.minWidth, clientW: st.clientWidth, scrollW: st.scrollWidth, clipped: st.scrollWidth > st.clientWidth, textOverflow: s.textOverflow, overflow: s.overflow, whiteSpace: s.whiteSpace, toolbarH: Math.round(bar.getBoundingClientRect().height) };
    return o;
  });
  await page.waitForTimeout(120);
  await shot('21-recheck-sttitle');
  // 复原（React 重渲染会自动覆盖；等下一状态变化）
  await page.evaluate(() => { const st = document.querySelector('.st-title'); if (st) st.textContent = ''; });

  // 3) sb-left 超长合成文本
  R.sbLeft = await page.evaluate(() => {
    const sb = document.querySelector('.sb-left'), bar = document.querySelector('.statusbar');
    sb.textContent = '超'.repeat(220);
    const s = sb.getBoundingClientRect(), o = { whiteSpace: getComputedStyle(sb).whiteSpace, textOverflow: getComputedStyle(sb).textOverflow, boxH: Math.round(s.height), sbTop: Math.round(s.top), sbBottom: Math.round(s.bottom), barH: Math.round(bar.getBoundingClientRect().height), clipped: sb.scrollWidth > sb.clientWidth };
    sb.textContent = '本地 · UTF-8';
    return o;
  });

  // 4a) 1130×800 开文件面板 → 期望 tp-full（560+384=944；avail=906）
  await page.setViewportSize({ width: 1130, height: 800 });
  await page.waitForTimeout(350);
  await page.click('.st-file');
  await page.waitForTimeout(450);
  R.w1130 = { tpFull: await page.$eval('.task-panel', (el) => el.classList.contains('tp-full')) };
  await shot('22-recheck-1130-tpfull');
  // 4b) 回差：拉宽到 1130→1300 应回并排；1300 缩到 1120（avail 896<944）应变回 full
  await page.setViewportSize({ width: 1300, height: 800 });
  await page.waitForTimeout(350);
  R.w1300_side = await page.$eval('.task-panel', (el) => !el.classList.contains('tp-full'));
  await page.setViewportSize({ width: 1120, height: 800 });
  await page.waitForTimeout(350);
  R.w1120_full = await page.$eval('.task-panel', (el) => el.classList.contains('tp-full'));
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.waitForTimeout(350);
  R.w1280_side = await page.$eval('.task-panel', (el) => !el.classList.contains('tp-full'));
  await page.click('.tp-head button[aria-label="关闭任务面板"]');
  await page.waitForTimeout(200);

  // 5) Esc 关两菜单
  await page.click('.tab-all');
  await page.waitForTimeout(250);
  R.tabsMenuOpen = !!(await page.$('.tools-menu .tm-row'));
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);
  R.tabsMenuClosedByEsc = (await page.$('.tools-menu')) === null;
  await page.click('.session-toolbar .st-tools > button');
  await page.waitForTimeout(250);
  R.toolsMenuOpen = !!(await page.$('.tools-menu [role="menuitem"]'));
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);
  R.toolsMenuClosedByEsc = (await page.$('.tools-menu')) === null;

  R.errors = errors;
  console.log(JSON.stringify(R, null, 1));
  await browser.close();
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
