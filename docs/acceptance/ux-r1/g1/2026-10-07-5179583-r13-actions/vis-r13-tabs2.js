// vis-r13 补充探针：900 宽溢出态直接点击被截断的最右标签 → scrollIntoView 滚入视野对账。
// （R13 min-width 0→120 使 4 标签在 900 宽即溢出，此态为新可达态，须实测滚动行为。）
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
    await page.waitForTimeout(400);
  };

  await connectCard(0); await connectCard(2); await connectCard(3);
  R.tabCount = await page.$$eval('.tab', (els) => els.length);

  R.before = await page.evaluate(() => {
    const bar = document.querySelector('.tabbar');
    const tabs = [...bar.querySelectorAll('.tab')];
    const b = bar.getBoundingClientRect();
    return {
      scrollLeft: Math.round(bar.scrollLeft),
      overflowing: bar.scrollWidth > bar.clientWidth,
      tabs: tabs.map((t) => { const r = t.getBoundingClientRect(); return { label: t.querySelector('.tab-label')?.textContent, left: Math.round(r.left), right: Math.round(r.right), active: t.classList.contains('tab-active'), w: Math.round(r.width * 10) / 10 }; }),
      barRight: Math.round(b.right), barLeft: Math.round(b.left),
    };
  });

  // 直接点击最右（被截断）标签
  await page.evaluate(() => {
    const tabs = [...document.querySelectorAll('.tabbar .tab')];
    tabs[tabs.length - 1].click();
  });
  await page.waitForTimeout(600);

  R.after = await page.evaluate(() => {
    const bar = document.querySelector('.tabbar');
    const b = bar.getBoundingClientRect();
    const a = bar.querySelector('.tab-active');
    const r = a.getBoundingClientRect();
    return {
      activeLabel: a.querySelector('.tab-label')?.textContent,
      scrollLeft: Math.round(bar.scrollLeft),
      active: { left: Math.round(r.left), right: Math.round(r.right) },
      bar: { left: Math.round(b.left), right: Math.round(b.right) },
      fullyVisible: r.left >= b.left - 1 && r.right <= b.right + 1,
      scrollBtnL: !!document.querySelector('.tab-scroll[aria-label="向左滚动标签"]'),
      scrollBtnR: !!document.querySelector('.tab-scroll[aria-label="向右滚动标签"]'),
    };
  });
  R.pass = R.after.activeLabel === R.before.tabs[R.before.tabs.length - 1].label && R.after.fullyVisible && R.after.scrollLeft > 0;
  await shot('33b-tab-overflow-click-cut-rightmost');

  R.errors = errors;
  fs.writeFileSync(DIR + '/vis-r13-tabs2-result.json', JSON.stringify(R, null, 1));
  console.log(JSON.stringify(R, null, 1));
  await browser.close();
})().catch((e) => { console.error('PROBE_FAIL', e); process.exit(1); });
