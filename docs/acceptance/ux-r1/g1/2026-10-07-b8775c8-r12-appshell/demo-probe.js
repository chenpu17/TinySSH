// R12 布局冒烟（demo 模式）：几何断言 + 交互（收起/拖宽/搜索/任务面板/状态条）
const { chromium } = require('/Users/chenpu/node_modules/playwright');

(async () => {
  const browser = await chromium.launch({
    headless: true,
    executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto('http://localhost:5183', { waitUntil: 'networkidle' });
  await page.waitForTimeout(800);

  const r = {};
  const box = async (sel) => {
    const el = await page.$(sel);
    if (!el) return null;
    const b = await el.boundingBox();
    return b ? { w: Math.round(b.width), h: Math.round(b.height) } : null;
  };
  r.titlebar = await box('.titlebar');
  r.hostbar = await box('.hostbar');
  r.statusbar = await box('.statusbar');
  r.dragRegion = await page.$eval('.titlebar', (el) => el.hasAttribute('data-tauri-drag-region'));
  r.sbLeft = await page.$eval('.sb-left', (el) => el.textContent.trim()).catch(() => null);
  r.welcome = !!(await page.$('.welcome'));

  // 搜索过滤
  await page.fill('.hb-search input', '不存在的主机xyz');
  await page.waitForTimeout(200);
  r.noMatch = (await page.$$eval('.host-card', (els) => els.length)) === 0;
  await page.fill('.hb-search input', '');
  await page.waitForTimeout(200);
  r.hostCards = await page.$$eval('.host-card', (els) => els.length);

  // 收起 / 展开
  await page.click('.tb-left button[aria-label="收起主机栏"]');
  await page.waitForTimeout(200);
  r.collapsed = (await page.$('.hostbar')) === null;
  r.expandBtn = !!(await page.$('.hb-expand'));
  await page.click('.hb-expand');
  await page.waitForTimeout(200);
  r.reopened = !!(await page.$('.hostbar'));

  // 拖宽把手：200–300 夹取
  const grip = await page.$('.hb-grip');
  if (grip) {
    const gb = await grip.boundingBox();
    await page.mouse.move(gb.x + 3, gb.y + 300);
    await page.mouse.down();
    await page.mouse.move(420, gb.y + 300, { steps: 5 });
    await page.mouse.up();
    await page.waitForTimeout(200);
    r.widthAfterDragTo420 = (await box('.hostbar')).w;
    const gb2 = await (await page.$('.hb-grip')).boundingBox();
    await page.mouse.move(gb2.x + 3, gb2.y + 300);
    await page.mouse.down();
    await page.mouse.move(100, gb2.y + 300, { steps: 5 });
    await page.mouse.up();
    await page.waitForTimeout(200);
    r.widthAfterDragTo100 = (await box('.hostbar')).w;
    const gb3 = await (await page.$('.hb-grip')).boundingBox();
    await page.mouse.move(gb3.x + 3, gb3.y + 300);
    await page.mouse.down();
    await page.mouse.move(226, gb3.y + 300, { steps: 5 });
    await page.mouse.up();
    await page.waitForTimeout(200);
    r.widthAfterDragTo226 = (await box('.hostbar')).w;
  }

  // 连一个 demo 会话 → 标签 + 会话工具栏 + 状态条
  const connBtn = await page.$('.host-connect-btn');
  if (connBtn) {
    await (await page.$('.host-card')).hover();
    await page.waitForTimeout(200);
    await connBtn.click();
    await page.waitForTimeout(1200);
    r.tab = await box('.tabbar-row');
    r.toolbar = await box('.session-toolbar');
    r.tabbarH = r.tab ? r.tab.h : null;
    r.toolbarH = r.toolbar ? r.toolbar.h : null;
    r.sbLeft2 = await page.$eval('.sb-left', (el) => el.textContent.trim()).catch(() => null);
    r.tabsMenuBtn = !!(await page.$('.tab-all'));
    await page.click('.tab-all');
    await page.waitForTimeout(200);
    r.tabsMenu = !!(await page.$('.tools-menu .tm-row'));
    // Esc 关闭标签列表菜单（rev-r12 LOW-2）
    await page.keyboard.press('Escape');
    await page.waitForTimeout(200);
    r.tabsMenuEscClosed = (await page.$('.tools-menu')) === null;
    await page.mouse.click(640, 400);
    await page.waitForTimeout(200);
    // 工具菜单
    const toolsBtn = await page.$('.session-toolbar .st-tools > button');
    await toolsBtn.click();
    await page.waitForTimeout(200);
    r.toolsMenu = await page.$$eval('.tools-menu [role="menuitem"]', (els) => els.map((e) => e.textContent.trim()));
    // Esc 关闭工具菜单（rev-r12 LOW-2）
    await page.keyboard.press('Escape');
    await page.waitForTimeout(200);
    r.toolsMenuEscClosed = (await page.$('.tools-menu')) === null;
    await page.click('.session-toolbar .st-tools > button');
    await page.waitForTimeout(200);
    await page.click('.tools-menu [role="menuitem"]:first-child');
    await page.waitForTimeout(300);
    r.taskPanel = await box('.task-panel');
    r.tpHead = await page.$eval('.tp-head b', (el) => el.textContent).catch(() => null);
    await page.click('.tp-head button[aria-label="关闭任务面板"]');
    await page.waitForTimeout(200);
    r.panelClosed = (await page.$('.task-panel')) === null;
  }

  // ⌘B
  await page.keyboard.press('Meta+b');
  await page.waitForTimeout(200);
  r.cmdBCollapsed = (await page.$('.hostbar')) === null;
  await page.keyboard.press('Meta+b');
  await page.waitForTimeout(200);
  r.cmdBReopened = !!(await page.$('.hostbar'));

  // 窄窗完整视图断点：960 宽 - 224 主机栏 < 896 → 面板应为 tp-full
  await page.setViewportSize({ width: 960, height: 600 });
  await page.waitForTimeout(300);
  const toolsBtn2 = await page.$('.session-toolbar .st-tools > button');
  if (toolsBtn2) {
    await toolsBtn2.click();
    await page.waitForTimeout(200);
    await page.click('.tools-menu [role="menuitem"]:first-child');
    await page.waitForTimeout(300);
    r.narrowFullView = await page.$eval('.task-panel', (el) => el.classList.contains('tp-full'));
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.waitForTimeout(300);
    r.backToSide = await page.$eval('.task-panel', (el) => !el.classList.contains('tp-full'));
    await page.click('.tp-head button[aria-label="关闭任务面板"]');
  }
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.waitForTimeout(300);

  // toast 与状态条不重叠（vis-r12 FAIL 项）：连接成功 toast 可能仍在
  const toastBox = await page.$eval('.toast-stack', (el) => { const b = el.getBoundingClientRect(); return { bottom: Math.round(b.bottom), h: Math.round(b.height) }; }).catch(() => null);
  const sbTop = await page.$eval('.statusbar', (el) => Math.round(el.getBoundingClientRect().top));
  r.toast = toastBox;
  r.statusbarTop = sbTop;
  r.toastOverlapsStatusbar = toastBox ? toastBox.bottom > sbTop && toastBox.h > 0 : null;

  // rev-r12 M1：1130 宽（avail=906，th=944）→ files 必须退完整视图，终端保 ≥560
  await page.setViewportSize({ width: 1130, height: 800 });
  await page.waitForTimeout(400);
  const fbtn = await page.$('.session-toolbar .st-file');
  if (fbtn) {
    await fbtn.click();
    await page.waitForTimeout(400);
    r.at1130FullView = await page.$eval('.task-panel', (el) => el.classList.contains('tp-full')).catch(() => 'no-panel');
    const termBox = await page.$eval('#term', (el) => Math.round(el.getBoundingClientRect().width)).catch(() => null);
    r.termWidthAt1130 = termBox;
    await page.click('.tp-head button[aria-label="关闭任务面板"]').catch(() => {});
  }
  await page.setViewportSize({ width: 1280, height: 800 });

  r.jsErrors = errors;
  console.log(JSON.stringify(r, null, 1));
  await page.screenshot({ path: '/tmp/r12-demo-shell.png' });
  await browser.close();
})().catch((e) => { console.error('PROBE_FAIL', e); process.exit(1); });
