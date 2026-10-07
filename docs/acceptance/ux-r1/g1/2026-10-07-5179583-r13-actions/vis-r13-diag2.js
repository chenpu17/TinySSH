// vis-r13 诊断 2：滚入不足根因验证 + 右滚按钮兜底 + R13 min-width 可达性反证。
const { chromium } = require('/Users/chenpu/node_modules/playwright');
const fs = require('fs');
const DIR = '/Users/chenpu/workspace/claude-code/TinySSH/docs/acceptance/ux-r1/g1/2026-10-07-5179583-r13-actions';
const SHOTS = DIR + '/vis-shots';

(async () => {
  const browser = await chromium.launch({
    headless: true,
    executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  });
  const page = await browser.newPage({ viewport: { width: 900, height: 600 } });
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 300)); });
  page.on('pageerror', (e) => errors.push('PAGEERROR: ' + String(e).slice(0, 300)));
  const R = {};
  const shot = (n) => page.screenshot({ path: `${SHOTS}/${n}.png` });

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
    await page.waitForTimeout(600);
  };

  const state = () => page.evaluate(() => {
    const bar = document.querySelector('.tabbar');
    const a = bar.querySelector('.tab-active');
    const r = a.getBoundingClientRect();
    const b = bar.getBoundingClientRect();
    return {
      scrollLeft: Math.round(bar.scrollLeft), clientW: bar.clientWidth, scrollW: bar.scrollWidth,
      btnL: !!document.querySelector('.tab-scroll[aria-label="向左滚动标签"]'),
      btnR: !!document.querySelector('.tab-scroll[aria-label="向右滚动标签"]'),
      active: { l: Math.round(r.left), r: Math.round(r.right) },
      bar: { l: Math.round(b.left), r: Math.round(b.right) },
      activeFullyVisible: r.left >= b.left - 1 && r.right <= b.right + 1,
    };
  });

  await connectCard(0); await connectCard(2); await connectCard(3);
  await page.waitForTimeout(800);
  R.S1_connectedSettled = await state();

  // 机制反证：临时撤掉 R13 min-width（模拟 R12 宽度行为）→ 同样 4 标签 900 宽是否仍溢出
  R.S2_counterfactual_R12width = await page.evaluate(() => {
    const st = document.createElement('style');
    st.id = 'vis-r13-cf';
    st.textContent = '.tab { min-width: 0 !important; max-width: 170px !important; }';
    document.head.appendChild(st);
    const bar = document.querySelector('.tabbar');
    const o = { scrollW: bar.scrollWidth, clientW: bar.clientWidth, overflowing: bar.scrollWidth > bar.clientWidth };
    document.getElementById('vis-r13-cf').remove();
    return o;
  });

  // 点最右（被截）标签 → 稳定态
  await page.evaluate(() => {
    const tabs = [...document.querySelectorAll('.tabbar .tab')];
    tabs[tabs.length - 1].click();
  });
  await page.waitForTimeout(1200);
  R.S3_afterClickCutTab = await state();
  await shot('33c-cut-tab-active-under-scrolled');

  // 兜底：点「向右滚动标签」按钮 → 应滚到完全可见
  await page.click('.tab-scroll[aria-label="向右滚动标签"]');
  await page.waitForTimeout(900);
  R.S4_afterScrollBtnR = await state();
  await shot('33d-scrollbtn-r-fixes-visibility');

  // 点「向左滚动标签」→ 回滚
  await page.click('.tab-scroll[aria-label="向左滚动标签"]');
  await page.waitForTimeout(900);
  R.S5_afterScrollBtnL = await state();

  // 规定路径（任务书）：菜单激活「最后一根非激活行」→ 滚入视野
  await page.click('.tab-all');
  await page.waitForTimeout(300);
  const rows = await page.$$('.tools-menu .tm-row');
  let target = null;
  for (let i = rows.length - 1; i >= 0; i--) {
    if (!(await rows[i].evaluate((e) => e.classList.contains('tm-active')))) { target = rows[i]; break; }
  }
  R.S6_menuClicked = await target.$eval('.tab-label', (e) => e.textContent);
  await (await target.$('.tm-main')).click();
  await page.waitForTimeout(1200);
  R.S6_menuPathState = await state();
  await shot('33e-menu-path-activated');

  R.errors = errors;
  fs.writeFileSync(DIR + '/vis-r13-diag2-result.json', JSON.stringify(R, null, 1));
  console.log(JSON.stringify(R, null, 1));
  await browser.close();
})().catch((e) => { console.error('PROBE_FAIL', e); process.exit(1); });
