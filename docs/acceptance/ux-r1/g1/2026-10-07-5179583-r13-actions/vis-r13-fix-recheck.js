// vis-r13 复验（修复后）：① 900 宽直点被截最右标签（原 FAIL 场景）；
// ② resize 路径（1280→900 不点任何标签自动滚入）；③ 主机栏开合；④ 任务面板开合；
// ⑤ 滚动稳定期采样（防振荡/回调环）。归一 localStorage 后 reload。
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
  const shot = (n) => page.screenshot({ path: `${SHOTS}/${n}.png` });
  const state = () => page.evaluate(() => {
    const bar = document.querySelector('.tabbar');
    const a = bar.querySelector('.tab-active');
    const b = bar.getBoundingClientRect();
    const tabs = [...bar.querySelectorAll('.tab')].map((t) => {
      const r = t.getBoundingClientRect();
      return { label: (t.querySelector('.tab-label')?.textContent || '').slice(0, 12), l: Math.round(r.left), r: Math.round(r.right), act: t.classList.contains('tab-active') };
    });
    return {
      tabCount: tabs.length,
      scrollLeft: Math.round(bar.scrollLeft), clientW: bar.clientWidth, scrollW: bar.scrollWidth,
      btnL: !!document.querySelector('.tab-scroll[aria-label="向左滚动标签"]'),
      btnR: !!document.querySelector('.tab-scroll[aria-label="向右滚动标签"]'),
      active: a ? { l: Math.round(a.getBoundingClientRect().left), r: Math.round(a.getBoundingClientRect().right) } : null,
      bar: { l: Math.round(b.left), r: Math.round(b.right) },
      activeFullyVisible: a ? (a.getBoundingClientRect().left >= b.left - 1 && a.getBoundingClientRect().right <= b.right + 1) : null,
      tabs,
    };
  });

  await page.goto('http://localhost:5183', { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => {
    localStorage.setItem('ui.hostbar', '1');
    localStorage.setItem('ui.hostbar_w', '224');
    localStorage.setItem('ui.theme', 'dark');
    localStorage.removeItem('ui.font_size');
  });
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(1200);

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

  // ---------- ① 900 宽直点被截最右标签（原 FAIL：settled sl=33, 截 46px） ----------
  await page.setViewportSize({ width: 900, height: 600 });
  await page.waitForTimeout(350);
  await connectCard(0); await connectCard(2); await connectCard(3);
  await page.waitForTimeout(1500);
  R.A_afterConnects = await state();
  await page.evaluate(() => {
    const tabs = [...document.querySelectorAll('.tabbar .tab')];
    tabs[tabs.length - 1].click();
  });
  await page.waitForTimeout(1200);
  R.A_afterClickCutTab = await state();
  R.A_pass = R.A_afterClickCutTab.activeFullyVisible === true;
  await shot('45-fix-cut-tab-click-settled');

  // ①b 稳定期采样 2s（每 250ms）——scrollLeft 必须恒定（无振荡/回调环）
  R.A_stabilitySamples = [];
  for (let i = 0; i < 8; i++) {
    await page.waitForTimeout(250);
    R.A_stabilitySamples.push(await page.evaluate(() => Math.round(document.querySelector('.tabbar').scrollLeft)));
  }
  R.A_stable = new Set(R.A_stabilitySamples).size === 1;
  // × 钮可见性：活动标签右缘不得越过裁剪箱，且 .tab-x 中心在箱内
  R.A_xButtonVisible = await page.evaluate(() => {
    const bar = document.querySelector('.tabbar');
    const b = bar.getBoundingClientRect();
    const x = bar.querySelector('.tab-active .tab-x');
    if (!x) return { present: false };
    const r = x.getBoundingClientRect();
    return { present: true, xRight: Math.round(r.right), insideBar: r.right <= b.right + 1, fullyInside: r.left >= b.left - 1 && r.right <= b.right + 1 };
  });

  // ---------- ② resize 路径：1280 连会话→缩 900，不点标签自动滚入 ----------
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.waitForTimeout(500);
  await connectCard(4); // 第 5 根标签
  R.B_tabCount1280 = await page.$$eval('.tab', (els) => els.length);
  // 显式激活最右标签（此时 1280 全可见、无滚动）
  await page.evaluate(() => {
    const tabs = [...document.querySelectorAll('.tabbar .tab')];
    tabs[tabs.length - 1].click();
  });
  await page.waitForTimeout(800);
  R.B_beforeShrink = await state();
  await page.setViewportSize({ width: 900, height: 600 });
  // 不点任何标签，等 RO/补滚生效
  await page.waitForTimeout(1200);
  R.B_afterShrink900 = await state();
  R.B_pass = R.B_afterShrink900.activeFullyVisible === true;
  await shot('46-fix-resize-900-auto-scroll');

  // ---------- ③ 主机栏收起/展开（布局变化路径） ----------
  await page.keyboard.press('Meta+b');
  await page.waitForTimeout(900);
  R.C_hostbarCollapsed = await state();
  R.C_collapsed_pass = R.C_hostbarCollapsed.activeFullyVisible === true;
  await shot('47-fix-hostbar-collapsed');
  await page.keyboard.press('Meta+b');
  await page.waitForTimeout(900);
  R.C_hostbarReexpanded = await state();
  R.C_reexpand_pass = R.C_hostbarReexpanded.activeFullyVisible === true;
  await shot('48-fix-hostbar-reexpanded');

  // ---------- ④ 任务面板开合（布局变化路径，1280 侧挤） ----------
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.waitForTimeout(600);
  await page.click('.st-file');
  await page.waitForTimeout(900);
  R.D_panelOpen = { state: await state(), panel: await page.$eval('.task-panel', (el) => ({ w: Math.round(el.getBoundingClientRect().width), tpFull: el.classList.contains('tp-full') })).catch(() => null) };
  R.D_open_pass = R.D_panelOpen.state.activeFullyVisible === true;
  await shot('49-fix-panel-open');
  await page.click('.tp-head button[aria-label="关闭任务面板"]');
  await page.waitForTimeout(900);
  R.D_panelClosed = await state();
  R.D_close_pass = R.D_panelClosed.activeFullyVisible === true;

  R.errors = errors;
  fs.writeFileSync(DIR + '/vis-r13-fix-recheck-result.json', JSON.stringify(R, null, 1));
  console.log(JSON.stringify(R, null, 1));
  await browser.close();
})().catch((e) => { console.error('PROBE_FAIL', e); process.exit(1); });
