const { chromium } = require('/Users/chenpu/node_modules/playwright');
(async () => {
  const browser = await chromium.launch({ headless: true, executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
  const page = await browser.newPage({ viewport: { width: 720, height: 600 } });
  await page.goto('http://localhost:5183', { waitUntil: 'networkidle' });
  await page.waitForTimeout(1200);
  const card = await page.$('.host-card');
  await card.hover(); await page.waitForTimeout(250);
  await page.click('.host-card .host-connect-btn');
  await page.waitForTimeout(1200);
  const r = await page.evaluate(() => {
    const st = document.querySelector('.st-title');
    if (!st) return null;
    st.textContent = '一二三四五六七八九十'.repeat(3);
    const s = getComputedStyle(st), bar = document.querySelector('.session-toolbar');
    return { minW: s.minWidth, clientW: st.clientWidth, scrollW: st.scrollWidth, clipped: st.scrollWidth > st.clientWidth, textOverflow: s.textOverflow, overflow: s.overflow, toolbarH: Math.round(bar.getBoundingClientRect().height), barScrollW: bar.scrollWidth, barClientW: bar.clientWidth };
  });
  await page.waitForTimeout(120);
  await page.screenshot({ path: '/tmp/vis-r12-shots/23-recheck-sttitle-squeezed.png' });
  console.log(JSON.stringify(r));
  await browser.close();
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
