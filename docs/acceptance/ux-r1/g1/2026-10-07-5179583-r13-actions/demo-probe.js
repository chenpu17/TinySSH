// R13 统一 action 分发冒烟（demo 模式）：单一分发语义 + 输入约定（§7.2/§7.3/§7.4/§320）
// 断言口径：每键恰好一次执行（字号步进 ±1 为双执行探针）、模态层吞 ⌘、Esc 关最上层
// 浮层并恢复终端焦点、表单焦点 ⌘B 不劫持、IME 组合期不触发、标签 120–220+滚入视野。
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
  // localStorage 归一（rev-r12 LOW-5 同款）：防跨启动残留
  await page.goto('http://localhost:5183', { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => { localStorage.setItem('ui.hostbar', '1'); localStorage.setItem('ui.hostbar_w', '224'); });
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(800);

  const r = {};
  const box = async (sel) => {
    const el = await page.$(sel);
    if (!el) return null;
    const b = await el.boundingBox();
    return b ? { w: Math.round(b.width), h: Math.round(b.height) } : null;
  };
  const termRowH = () => page.$eval('.xterm-rows > div', (el) => Math.round(parseFloat(getComputedStyle(el).height)))
    .catch(() => null);

  // 连一个 demo 会话（R12 同款流程）
  const card = await page.$('.host-card');
  await card.hover();
  await page.waitForTimeout(200);
  await (await page.$('.host-connect-btn')).click();
  await page.waitForTimeout(1500);
  r.tabConnected = await box('.tabbar-row');
  // 点标签 attach（AUTOCONNECT 不自带 attach）
  await page.click('.tabbar .tab');
  await page.waitForTimeout(300);
  r.toolbar = await box('.session-toolbar');
  // 终端聚焦（⌘ 组合在终端焦点下响应）
  await page.mouse.click(700, 400);
  await page.waitForTimeout(200);

  // ---- A1 ⌘F：开搜索恰好一次 ----
  await page.keyboard.press('Meta+f');
  await page.waitForTimeout(250);
  r.searchOpens = await page.$eval('.term-search', (el) => getComputedStyle(el).display !== 'none').catch(() => false);
  r.searchInputFocused = await page.evaluate(() => !!document.activeElement?.closest('.term-search'));
  await page.keyboard.press('Escape');
  await page.waitForTimeout(250);
  r.searchEscClosed = await page.$eval('.term-search', (el) => getComputedStyle(el).display === 'none').catch(() => 'gone');
  r.searchEscFocusBack = await page.evaluate(() => document.activeElement?.classList.contains('xterm-helper-textarea'));

  // ---- A2 ⌘= 步进恰好 +1（双执行会 +2）----
  const h0 = await termRowH();
  await page.keyboard.press('Meta+=');
  await page.waitForTimeout(250);
  const h1 = await termRowH();
  r.fontUpDelta = h1 !== null && h0 !== null ? h1 - h0 : null;
  await page.keyboard.press('Meta+-');
  await page.waitForTimeout(250);
  const h2 = await termRowH();
  r.fontDownDelta = h2 - h1;
  await page.keyboard.press('Meta+0');
  await page.waitForTimeout(250);
  r.fontReset = (await termRowH()) === h0;

  // ---- A3 ⌘B 开合各一次 ----
  await page.keyboard.press('Meta+b');
  await page.waitForTimeout(250);
  r.cmdBCollapsed = (await page.$('.hostbar')) === null;
  await page.keyboard.press('Meta+b');
  await page.waitForTimeout(250);
  r.cmdBReopened = !!(await page.$('.hostbar'));

  // ---- B1 Esc 链：工具菜单关 + 终端焦点恢复 ----
  await page.click('.session-toolbar .st-tools > button');
  await page.waitForTimeout(200);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(250);
  r.toolsEscClosed = (await page.$('.tools-menu')) === null;
  r.toolsEscFocusBack = await page.evaluate(() => document.activeElement?.classList.contains('xterm-helper-textarea'));

  // ---- B2 Esc 链：设置面板 ----
  await page.click('.hb-settings');
  await page.waitForTimeout(250);
  r.settingsOpens = !!(await page.$('.term-settings'));
  await page.keyboard.press('Escape');
  await page.waitForTimeout(250);
  r.settingsEscClosed = (await page.$('.term-settings')) === null;

  // ---- B3 无浮层时输入框 Esc 透传（不关主机栏、无异常）----
  await page.fill('.hb-search input', 'demo');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);
  r.escInInputKeepsHostbar = !!(await page.$('.hostbar'));
  await page.fill('.hb-search input', '');

  // ---- C 模态层：确认弹窗吞 ⌘、Esc 关确认且不断连 ----
  const tabCountBefore = await page.$$eval('.tabbar .tab', (els) => els.length);
  await page.click('.session-toolbar .st-tools > button');
  await page.waitForTimeout(200);
  const items = await page.$$eval('.tools-menu [role="menuitem"]', (els) => els.map((e) => e.textContent.trim()));
  await page.click(`.tools-menu [role="menuitem"]:last-child`); // 关闭会话
  await page.waitForTimeout(300);
  r.confirmOpens = !!(await page.$('.confirm-dialog'));
  await page.keyboard.press('Meta+f');
  await page.waitForTimeout(250);
  r.modalSwallowsCmdF = !(await page.$eval('.term-search', (el) => getComputedStyle(el).display !== 'none').catch(() => false));
  const hM = await termRowH();
  await page.keyboard.press('Meta+=');
  await page.waitForTimeout(250);
  r.modalFontFrozen = (await termRowH()) === hM;
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  r.modalEscClosesConfirm = (await page.$('.confirm-dialog')) === null;
  const tabCountAfter = await page.$$eval('.tabbar .tab', (els) => els.length);
  r.confirmKeepSession = tabCountAfter === tabCountBefore;
  r.modalEscFocusBack = await page.evaluate(() => document.activeElement?.classList.contains('xterm-helper-textarea'));

  // ---- D IME 组合期不触发应用命令（§7.3）----
  await page.evaluate(() => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', metaKey: true, isComposing: true, bubbles: true }));
  });
  await page.waitForTimeout(250);
  r.imeComposingSwallowed = !(await page.$eval('.term-search', (el) => getComputedStyle(el).display !== 'none').catch(() => false));
  await page.evaluate(() => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', metaKey: true, keyCode: 229, bubbles: true }));
  });
  await page.waitForTimeout(250);
  r.keyCode229Swallowed = !(await page.$eval('.term-search', (el) => getComputedStyle(el).display !== 'none').catch(() => false));

  // ---- E 表单焦点 ⌘B 不劫持（§7.4）----
  await page.focus('.hb-search input');
  await page.keyboard.press('Meta+b');
  await page.waitForTimeout(250);
  r.inFormCmdBNoHijack = !!(await page.$('.hostbar'));
  // ⌘F 表单焦点仍全局可用（R6 走查语义保留）
  await page.keyboard.press('Meta+f');
  await page.waitForTimeout(250);
  r.inFormCmdFStillOpens = await page.$eval('.term-search', (el) => getComputedStyle(el).display !== 'none').catch(() => false);
  await page.keyboard.press('Escape');
  await page.mouse.click(700, 400);

  // ---- F 标签 §320：宽 120–220、活动标签滚入视野 ----
  r.tabWidths = await page.$$eval('.tabbar .tab', (els) => els.map((e) => Math.round(e.getBoundingClientRect().width)));
  r.tabWidthInRange = r.tabWidths.every((w) => w >= 120 && w <= 220);
  // 再连 5 台凑溢出，激活最后一根走「标签列表」菜单（不直接点标签，排除浏览器原生滚动干扰）
  // 第二台起 demo 会出示 TOFU 指纹确认——顺手当模态层探针：⌘ 吞掉、Esc=拒绝（§7.3）
  const cards = await page.$$('.host-card');
  let extra = 0;
  let tofuProbed = false;
  // 处理当前最上层待决弹层：2FA 填码提交 / 指纹信任；无弹层直接返回
  const clearMask = async () => {
    for (let k = 0; k < 6; k++) {
      if (!(await page.$('.hk-mask'))) return;
      const authInput = await page.$('.hk-mask input');
      if (authInput) {
        await authInput.fill('654321');
        await page.waitForTimeout(120);
        const btns = await page.$$('.hk-actions button');
        await btns[0].click(); // 提交验证
      } else {
        const btns = await page.$$('.hk-actions button');
        await btns[0].click(); // 信任并连接 / 我已核实
      }
      await page.waitForTimeout(900);
    }
  };
  for (const card of cards) {
    if (extra >= 5) break;
    const txt = await card.$eval('.host-main, .host-card', (el) => el.textContent).catch(() => '');
    const t = typeof txt === 'string' ? txt : '';
    if (t.includes('otp') || t.includes('10.0.0.12')) continue; // 2FA 演示机与恒失败机不凑数
    await clearMask();
    await card.hover();
    await page.waitForTimeout(120);
    const btn = await card.$('.host-connect-btn');
    if (!btn) continue;
    await btn.click();
    try { await page.waitForSelector('.hk-mask', { timeout: 4000 }); } catch { /* 无待决 */ }
    if (await page.$('.hk-mask')) {
      let rejected = false;
      if (!tofuProbed) {
        tofuProbed = true;
        await page.keyboard.press('Meta+f');
        await page.waitForTimeout(250);
        r.tofuModalSwallowsCmdF = !(await page.$eval('.term-search', (el) => getComputedStyle(el).display !== 'none').catch(() => false));
        await page.keyboard.press('Escape');
        await page.waitForTimeout(600);
        rejected = !(await page.$('.hk-mask'));
        r.tofuModalEscDismissed = rejected;
      }
      if (rejected) {
        // Esc=拒绝已终止本次建连（demo 抛 host_key_rejected）——重连同机并信任
        await card.hover();
        await page.waitForTimeout(150);
        await (await card.$('.host-connect-btn')).click();
        try { await page.waitForSelector('.hk-mask', { timeout: 4000 }); } catch {}
      }
      await clearMask();
    }
    await page.waitForTimeout(700);
    extra++;
  }
  r.extraSessions = extra;
  r.tofuProbed = tofuProbed;
  await page.setViewportSize({ width: 900, height: 800 });
  await page.waitForTimeout(400);
  const tbInfo = await page.$eval('.tabbar', (el) => ({ sw: el.scrollWidth, cw: el.clientWidth, sl: el.scrollLeft }));
  r.tabbarOverflow = tbInfo.sw > tbInfo.cw;
  if (r.tabbarOverflow) {
    await page.click('.tab-all'); // 标签列表菜单
    await page.waitForTimeout(250);
    // demo 连接会自动 attach（活动=最新）——点「非活动」的最后一根才是真实切签路径
    const rows = await page.$$('.tools-menu .tm-row');
    let target = rows.length - 1;
    for (let i = rows.length - 1; i >= 0; i--) {
      const cls = await rows[i].getAttribute('class');
      if (!cls.includes('tm-active')) { target = i; break; }
    }
    await rows[target].click();
    await page.waitForTimeout(400);
    const vis = await page.$eval('.tabbar', (el) => {
      const a = el.querySelector('.tab-active');
      if (!a) return null;
      const ab = a.getBoundingClientRect(); const eb = el.getBoundingClientRect();
      return { inView: ab.left >= eb.left - 1 && ab.right <= eb.right + 1, sl: el.scrollLeft };
    });
    r.activeTabScrolledIntoView = vis && vis.inView;
    r.scrollLeftAfterSwitch = vis ? vis.sl : null;
    r.tabWidthsAll = await page.$$eval('.tabbar .tab', (els) => els.map((e) => Math.round(e.getBoundingClientRect().width)));
    r.allInRange = r.tabWidthsAll.every((w) => w >= 120 && w <= 220);
    await page.keyboard.press('Escape');
  }
  await page.setViewportSize({ width: 1280, height: 800 });

  // ---- G 收尾：⌘W 在浏览器不劫持（原生语义保留给浏览器）----
  r.jsErrors = errors;
  console.log(JSON.stringify(r, null, 1));
  await page.screenshot({ path: '/tmp/r13-demo-shell.png' });
  await browser.close();
})().catch((e) => { console.error('PROBE_FAIL', e); process.exit(1); });
