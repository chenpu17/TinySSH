// vis-r13 复验（修复后）补测：主机栏把手拖拽期间的滚动行为采样——
// 活动标签全程可见时 scrollLeft 应恒定（无 RO 抖动）；挤压到截断时应单调收敛不复振。
const { chromium } = require('/Users/chenpu/node_modules/playwright');
const fs = require('fs');
const DIR = '/Users/chenpu/workspace/claude-code/TinySSH/docs/acceptance/ux-r1/g1/2026-10-07-5179583-r13-actions';

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
  const snap = () => page.evaluate(() => {
    const bar = document.querySelector('.tabbar');
    const a = bar.querySelector('.tab-active');
    const b = bar.getBoundingClientRect();
    return {
      sl: Math.round(bar.scrollLeft),
      hbW: document.querySelector('.hostbar') ? Math.round(document.querySelector('.hostbar').getBoundingClientRect().width) : null,
      vis: a ? (a.getBoundingClientRect().left >= b.left - 1 && a.getBoundingClientRect().right <= b.right + 1) : null,
    };
  });

  await connectCard(0); await connectCard(2); await connectCard(3);
  await page.waitForTimeout(1000);

  // E1: 活动标签全程可见的缓慢拖拽（224→300→100→224），逐步采样
  const drag = async (toX, steps) => {
    const gb = await (await page.$('.hb-grip')).boundingBox();
    const fromX = gb.x + 3;
    const y = gb.y + 300;
    await page.mouse.move(fromX, y);
    await page.mouse.down();
    const samples = [];
    for (let i = 1; i <= steps; i++) {
      await page.mouse.move(fromX + (toX - fromX) * (i / steps), y, { steps: 2 });
      await page.waitForTimeout(60);
      samples.push(await snap());
    }
    await page.mouse.up();
    await page.waitForTimeout(600);
    samples.push(await snap());
    return samples;
  };
  R.E1_widen300 = await drag(300, 8);
  R.E1_narrow100 = await drag(100, 8);
  R.E1_back224 = await drag(226, 8);
  R.E1_final = await snap();
  // 判据：全程 vis 恒 true；sl 单段内不出现 >1 次方向往返（可见态应为恒值）
  const dirChanges = (arr) => {
    let c = 0, prev = 0;
    for (let i = 1; i < arr.length; i++) {
      const d = Math.sign(arr[i] - arr[i - 1]);
      if (d !== 0) { if (prev !== 0 && d !== prev) c++; prev = d; }
    }
    return c;
  };
  R.E1_slValues = {
    widen: R.E1_widen300.map((s) => s.sl), narrow: R.E1_narrow100.map((s) => s.sl), back: R.E1_back224.map((s) => s.sl),
  };
  R.E1_allVisible = [...R.E1_widen300, ...R.E1_narrow100, ...R.E1_back224].every((s) => s.vis === true);
  R.E1_noOscillation = dirChanges(R.E1_widen300.map((s) => s.sl)) <= 1
    && dirChanges(R.E1_narrow100.map((s) => s.sl)) <= 1
    && dirChanges(R.E1_back224.map((s) => s.sl)) <= 1;
  R.E1_widthRestored = R.E1_final.hbW === 224 || R.E1_final.hbW === 226;

  // E2: 挤压到截断态的拖拽（先造溢出：缩视口 900 → 5 标签）——拖拽中 RO 补滚应单调收敛
  await page.setViewportSize({ width: 900, height: 600 });
  await page.waitForTimeout(1200);
  R.E2_initial = await snap();
  const gb = await (await page.$('.hb-grip')).boundingBox();
  await page.mouse.move(gb.x + 3, gb.y + 300);
  await page.mouse.down();
  R.E2_during = [];
  for (const toX of [260, 240, 224]) {
    await page.mouse.move(toX, gb.y + 300, { steps: 4 });
    await page.waitForTimeout(80);
    R.E2_during.push(await snap());
  }
  await page.mouse.up();
  await page.waitForTimeout(900);
  R.E2_after = await snap();
  R.E2_convergedVisible = R.E2_after.vis === true;
  const sl2 = [...R.E2_during.map((s) => s.sl), R.E2_after.sl];
  R.E2_slSeries = sl2;
  R.E2_noMultiOscillation = dirChanges(sl2) <= 1;

  R.errors = errors;
  fs.writeFileSync(DIR + '/vis-r13-fix-grip-result.json', JSON.stringify(R, null, 1));
  console.log(JSON.stringify(R, null, 1));
  await browser.close();
})().catch((e) => { console.error('PROBE_FAIL', e); process.exit(1); });
