// vis-r13 诊断：900 宽溢出态、点击最右标签前后的滚动真值对账（多次采样 + DOM 结构核验）。
const { chromium } = require('/Users/chenpu/node_modules/playwright');
const fs = require('fs');
const DIR = '/Users/chenpu/workspace/claude-code/TinySSH/docs/acceptance/ux-r1/g1/2026-10-07-5179583-r13-actions';

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

  const dump = (tag) => page.evaluate((tag) => {
    const bars = [...document.querySelectorAll('.tabbar')];
    return {
      tag,
      barCount: bars.length,
      bars: bars.map((bar) => {
        const b = bar.getBoundingClientRect();
        const tabs = [...bar.querySelectorAll('.tab')].map((t) => {
          const r = t.getBoundingClientRect();
          return { label: (t.querySelector('.tab-label')?.textContent || '').slice(0, 10), l: Math.round(r.left), r: Math.round(r.right), act: t.classList.contains('tab-active') };
        });
        const row = bar.parentElement.getBoundingClientRect();
        return {
          rect: { l: Math.round(b.left), r: Math.round(b.right), w: Math.round(b.width) },
          clientW: bar.clientWidth, scrollW: bar.scrollWidth, scrollLeft: Math.round(bar.scrollLeft),
          rowL: Math.round(row.left), rowR: Math.round(row.right),
          btnL: !!document.querySelector('.tab-scroll[aria-label="向左滚动标签"]'),
          btnR: !!document.querySelector('.tab-scroll[aria-label="向右滚动标签"]'),
          tabs,
        };
      }),
    };
  }, tag);

  await connectCard(0);
  R.after_c0 = await dump('after card0');
  await connectCard(2);
  R.after_c2 = await dump('after card2');
  await connectCard(3);
  R.after_c3 = await dump('after card3');
  await page.waitForTimeout(800);
  R.settled = await dump('settled+800ms');

  // 点击最右标签
  await page.evaluate(() => {
    const tabs = [...document.querySelectorAll('.tabbar .tab')];
    tabs[tabs.length - 1].click();
  });
  for (const ms of [50, 200, 600, 1200]) {
    await page.waitForTimeout(ms === 50 ? 50 : ms - (ms === 200 ? 50 : ms === 600 ? 200 : 600));
    R['click_' + ms + 'ms'] = await dump('t+' + ms + 'ms');
  }

  R.errors = errors;
  fs.writeFileSync(DIR + '/vis-r13-diag-result.json', JSON.stringify(R, null, 1));
  console.log(JSON.stringify({ settled: R.settled, click_1200ms: R.click_1200ms, barCount: R.after_c0.barCount, errors }, null, 1));
  await browser.close();
})().catch((e) => { console.error('PROBE_FAIL', e); process.exit(1); });
