const { chromium } = require('/Users/chenpu/node_modules/playwright');
(async () => {
  const browser = await chromium.launch({ headless: true, executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await page.goto('http://localhost:5183', { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => { localStorage.setItem('ui.hostbar', '1'); localStorage.setItem('ui.hostbar_w', '224'); });
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(800);
  const cards = await page.$$('.host-card');
  const clearMask = async () => {
    for (let k = 0; k < 6; k++) {
      if (!(await page.$('.hk-mask'))) return;
      const inp = await page.$('.hk-mask input');
      const btns = await page.$$('.hk-actions button');
      if (inp) { await inp.fill('654321'); await page.waitForTimeout(100); }
      await btns[0].click();
      await page.waitForTimeout(800);
    }
  };
  let n = 0;
  for (const card of cards) {
    if (n >= 6) break;
    const t = await card.evaluate((el) => el.textContent);
    if (t.includes('otp') || t.includes('10.0.0.12')) continue;
    await clearMask();
    await card.hover(); await page.waitForTimeout(100);
    const btn = await card.$('.host-connect-btn');
    if (!btn) continue;
    await btn.click();
    try { await page.waitForSelector('.hk-mask', { timeout: 3000 }); } catch {}
    await clearMask();
    await page.waitForTimeout(400);
    n++;
  }
  console.log('sessions:', n);
  await page.setViewportSize({ width: 900, height: 800 });
  await page.waitForTimeout(500);
  const state = () => page.evaluate(() => {
    const el = document.querySelector('.tabbar');
    const tabs = [...el.querySelectorAll('.tab')];
    const eb = el.getBoundingClientRect();
    const a = el.querySelector('.tab-active');
    return { sl: el.scrollLeft, activeIdx: tabs.findIndex((t) => t.classList.contains('tab-active')),
      cut: a ? Math.round(a.getBoundingClientRect().right - eb.right) : null,
      vis: a ? (a.getBoundingClientRect().left >= eb.left - 1 && a.getBoundingClientRect().right <= eb.right + 1) : null };
  });
  console.log('initial:', JSON.stringify(await state()));
  // 1) 点第一根（非活动、左侧）
  await page.evaluate(() => { document.querySelectorAll('.tabbar .tab')[0].click(); });
  await page.waitForTimeout(500);
  console.log('click-first:', JSON.stringify(await state()));
  // 2) 点最右被截的非活动标签
  await page.evaluate(() => {
    const el = document.querySelector('.tabbar');
    const tabs = [...el.querySelectorAll('.tab')];
    const eb = el.getBoundingClientRect();
    const t = [...tabs].reverse().find((t) => !t.classList.contains('tab-active') && t.getBoundingClientRect().right > eb.right + 1);
    if (t) t.click(); else console.log('no-cut-inactive');
  });
  await page.waitForTimeout(500);
  console.log('click-cut-right:', JSON.stringify(await state()));
  await browser.close();
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
