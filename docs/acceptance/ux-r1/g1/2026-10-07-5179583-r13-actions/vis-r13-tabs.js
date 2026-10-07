// vis-r13 独立复验 脚本 2/2：R13 专项——标签宽界 [120,220]、长名省略号、900 宽溢出滚入、
// Esc 逐层关浮层零残留、⌘F 搜索焦点、模态期 ⌘ 吞掉。归一 localStorage 后 reload。
const { chromium } = require('/Users/chenpu/node_modules/playwright');
const fs = require('fs');
const DIR = '/Users/chenpu/workspace/claude-code/TinySSH/docs/acceptance/ux-r1/g1/2026-10-07-5179583-r13-actions';
const SHOTS = DIR + '/vis-shots';

(async () => {
  const browser = await chromium.launch({
    headless: true,
    executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 300)); });
  page.on('pageerror', (e) => errors.push('PAGEERROR: ' + String(e).slice(0, 300)));
  const R = {};
  const box = async (sel) => {
    const el = await page.$(sel);
    if (!el) return null;
    const b = await el.boundingBox();
    return b ? { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) } : null;
  };
  const shot = (n) => page.screenshot({ path: `${SHOTS}/${n}.png` });
  const step = async (name, fn) => { try { await fn(); } catch (e) { R['ERR_' + name] = String(e).slice(0, 250); } };
  // 连接一台主机（处理指纹确认/双因素弹层），返回是否出现新标签由调用方对账
  const connectCard = async (idx) => {
    const cards = await page.$$('.host-card');
    await cards[idx].hover(); await page.waitForTimeout(250);
    await (await cards[idx].$('.host-connect-btn')).click();
    await page.waitForTimeout(900);
    for (let i = 0; i < 3 && (await page.$('.hk-mask')); i++) {
      const inp = await page.$('.hk-mask input');
      if (inp) { await inp.fill('123456'); await page.waitForTimeout(150); }
      await page.click('.hk-actions button');
      await page.waitForTimeout(1300);
    }
    await page.waitForTimeout(400);
  };
  const tabReport = () => page.$$eval('.tab', (els) => els.map((e) => {
    const r = e.getBoundingClientRect();
    const l = e.querySelector('.tab-label');
    return {
      label: (l?.textContent || '').slice(0, 14),
      w: Math.round(r.width * 10) / 10,
      inBounds: r.width >= 119.5 && r.width <= 220.5,
      clipped: l ? l.scrollWidth > l.clientWidth : null,
      ellipsis: l ? getComputedStyle(l).textOverflow : null,
      active: e.classList.contains('tab-active'),
    };
  }));

  await page.goto('http://localhost:5183', { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => {
    localStorage.setItem('ui.hostbar', '1');
    localStorage.setItem('ui.hostbar_w', '224');
    localStorage.setItem('ui.theme', 'dark');
    localStorage.removeItem('ui.font_size');
  });
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(1200);

  // ---------- 1. 连 3+ 会话，量每根 .tab 宽 ∈ [120,220] ----------
  await step('tabs3', async () => {
    await connectCard(0); // prod-1（演示种子：连一台会带出 staging-1/本机 共 3 根标签）
    R.s1_tabCount = await page.$$eval('.tab', (els) => els.length);
    await connectCard(2);
    await connectCard(3);
    R.X_tabWidths = await tabReport();
    R.X_tabbarRow = await box('.tabbar-row');
    R.X_allInBounds = R.X_tabWidths.every((t) => t.inBounds);
    await shot('30-tabs-multi-widths');
  });

  // ---------- 2. 长主机名：截断省略号 + 宽夹到 220 ----------
  await step('longlabel', async () => {
    R.E_long = await page.evaluate(() => {
      const cjk = '一二三四五六七八九十'.repeat(3);
      const lbl = document.querySelector('.tab .tab-label');
      const before = lbl.closest('.tab').getBoundingClientRect().width;
      lbl.textContent = cjk;
      const tab = lbl.closest('.tab');
      const row = document.querySelector('.tabbar-row');
      const s = getComputedStyle(lbl);
      const r = tab.getBoundingClientRect();
      return {
        wBefore: Math.round(before * 10) / 10,
        tabW: Math.round(r.width * 10) / 10,
        tabMaxW: getComputedStyle(tab).maxWidth,
        labelClientW: lbl.clientWidth, labelScrollW: lbl.scrollWidth,
        clipped: lbl.scrollWidth > lbl.clientWidth,
        textOverflow: s.textOverflow, whiteSpace: s.whiteSpace, overflow: s.overflow,
        rowH: Math.round(row.getBoundingClientRect().height),
        labelH: Math.round(lbl.getBoundingClientRect().height),
      };
    });
    await page.waitForTimeout(150);
    await shot('31-tab-longlabel-ellipsis');
    // 复原：reload（demo 会话随之消失，后续步骤重连）
  });

  // ---------- 3. 900 宽溢出：标签收起 + 右钮 + 激活最右滚入 ----------
  await step('overflow900', async () => {
    await page.reload({ waitUntil: 'networkidle' });
    await page.waitForTimeout(1200);
    // 重连到 5+ 根标签（连 3 台卡）
    await connectCard(0); await connectCard(2); await connectCard(3);
    R.O_tabCount1280 = await page.$$eval('.tab', (els) => els.length);
    await page.setViewportSize({ width: 900, height: 600 });
    await page.waitForTimeout(450);
    R.O_overflow = await page.evaluate(() => {
      const bar = document.querySelector('.tabbar');
      return {
        scrollW: bar.scrollWidth, clientW: bar.clientWidth,
        overflowing: bar.scrollWidth > bar.clientWidth,
        scrollBtnL: !!document.querySelector('.tab-scroll[aria-label="向左滚动标签"]'),
        scrollBtnR: !!document.querySelector('.tab-scroll[aria-label="向右滚动标签"]'),
        scrollBtnRTitle: document.querySelector('.tab-scroll[aria-label="向右滚动标签"]')?.getAttribute('title') || null,
      };
    });
    R.O_widths900 = await tabReport();
    await shot('32-tab-overflow-900');
    // 打开「标签列表」，点最后一根非激活行
    await page.click('.tab-all');
    await page.waitForTimeout(300);
    R.O_menuRows = await page.$$eval('.tools-menu .tm-row', (els) => els.map((e) => ({
      label: e.querySelector('.tab-label')?.textContent, active: e.classList.contains('tm-active'),
    })));
    const rows = await page.$$('.tools-menu .tm-row');
    let target = null;
    for (let i = rows.length - 1; i >= 0; i--) {
      if (!(await rows[i].evaluate((e) => e.classList.contains('tm-active')))) { target = rows[i]; break; }
    }
    if (target) {
      R.O_clickedLabel = await target.$eval('.tab-label', (e) => e.textContent);
      await (await target.$('.tm-main')).click();
      await page.waitForTimeout(500);
    }
    // 活动标签滚入视野对账：.tab-active 矩形落在 .tabbar 可视矩形内
    R.O_activeInView = await page.evaluate(() => {
      const bar = document.querySelector('.tabbar');
      const b = bar.getBoundingClientRect();
      const a = bar.querySelector('.tab-active');
      if (!a) return { activeTab: false };
      const r = a.getBoundingClientRect();
      return {
        activeTab: true,
        bar: { left: Math.round(b.left), right: Math.round(b.right) },
        active: { left: Math.round(r.left), right: Math.round(r.right) },
        fullyVisible: r.left >= b.left - 1 && r.right <= b.right + 1,
        scrollLeft: Math.round(bar.scrollLeft),
        scrollBtnL: !!document.querySelector('.tab-scroll[aria-label="向左滚动标签"]'),
        scrollBtnR: !!document.querySelector('.tab-scroll[aria-label="向右滚动标签"]'),
      };
    });
    await shot('33-tab-overflow-activated-right');
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.waitForTimeout(350);
  });

  // ---------- 4. Esc 逐层关浮层零残留（工具菜单/设置/确认弹窗）+ ⌘F 搜索 ----------
  const geom = async () => ({
    tabbarRow: await box('.tabbar-row'), sessionToolbar: await box('.session-toolbar'),
    statusbar: await box('.statusbar'),
  });
  await step('escChain', async () => {
    R.G_before = await geom();
    // a) 工具菜单
    await page.click('.session-toolbar .st-tools > button');
    await page.waitForTimeout(250);
    R.G_toolsOpen = !!(await page.$('.tools-menu [role="menuitem"]'));
    await shot('34-tools-menu-open');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(250);
    R.G_toolsClosedByEsc = (await page.$('.tools-menu')) === null;
    R.G_afterTools = await geom();
    await shot('35-esc-tools-closed');
    // b) 设置面板
    await page.click('.hb-settings');
    await page.waitForTimeout(250);
    R.G_settingsOpen = !!(await page.$('.term-settings'));
    await shot('36-settings-open');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(250);
    R.G_settingsClosedByEsc = (await page.$('.term-settings')) === null;
    await shot('37-esc-settings-closed');
    // c) 确认弹窗 + 模态期 ⌘F 必须不串
    const tabs = await page.$$('.tab');
    const act = tabs.find(async (t) => await t.evaluate((e) => e.classList.contains('tab-active'))) || tabs[0];
    await act.hover(); await page.waitForTimeout(200);
    await (await act.$('.tab-x')).click({ force: true });
    await page.waitForTimeout(350);
    R.G_confirmOpen = !!(await page.$('.confirm-dialog'));
    R.G_confirmTitle = await page.$eval('.confirm-dialog .hk-title', (el) => el.textContent).catch(() => null);
    await shot('38-confirm-open');
    await page.keyboard.press('Meta+f'); // 模态期 ⌘ 组合应被吞
    await page.waitForTimeout(300);
    R.G_cmdFWhileModal_noSearch = (await page.$('.term-search')) === null;
    await page.keyboard.press('Escape');
    await page.waitForTimeout(250);
    R.G_confirmClosedByEsc = (await page.$('.confirm-dialog')) === null;
    R.G_tabCountAfterConfirmEsc = await page.$$eval('.tab', (els) => els.length);
    await shot('39-esc-confirm-closed');
    // d) ⌘F 搜索：开、焦点、Esc 关、焦点回终端
    await page.keyboard.press('Meta+f');
    await page.waitForTimeout(350);
    R.G_searchOpen = !!(await page.$('.term-search'));
    R.G_searchFocus = await page.evaluate(() => {
      const ae = document.activeElement;
      const inp = document.querySelector('.term-search input');
      return {
        isInput: ae === inp,
        placeholder: inp?.placeholder || null,
        caretVisible: ae === inp,
        outline: ae === inp ? getComputedStyle(inp).outlineStyle : null,
        boxShadow: ae === inp ? getComputedStyle(inp).boxShadow.slice(0, 80) : null,
        borderColor: ae === inp ? getComputedStyle(inp).borderColor : null,
      };
    });
    await shot('40-cmdf-search-focus');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(250);
    R.G_searchClosedByEsc = (await page.$('.term-search')) === null;
    R.G_focusBackToTerm = await page.evaluate(() => {
      const ae = document.activeElement;
      return { cls: ae ? (ae.className || ae.tagName).toString().slice(0, 40) : null, isXterm: ae?.classList?.contains('xterm-helper-textarea') === true };
    });
    R.G_afterSearch = await geom();
    await shot('41-esc-search-closed');
    // 零残留：Esc 链前后几何逐项相等
    R.G_geomUnchanged = JSON.stringify(R.G_before) === JSON.stringify(R.G_afterSearch);
  });

  R.errors = errors;
  fs.writeFileSync(DIR + '/vis-r13-tabs-result.json', JSON.stringify(R, null, 1));
  console.log(JSON.stringify(R, null, 1));
  await browser.close();
})().catch((e) => { console.error('PROBE_FAIL', e); process.exit(1); });
