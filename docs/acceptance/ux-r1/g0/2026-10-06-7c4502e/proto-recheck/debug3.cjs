'use strict';
const { chromium } = require('/Users/chenpu/node_modules/playwright');
const base = 'file:///Users/chenpu-code-placeholder';
(async () => {
  const b = 'file:///Users/chenpu/workspace/claude-code/TinySSH/docs/ux/ux-r1-g0/r01-prototype/index.html';
  const browser = await chromium.launch({ headless: true, executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  page.setDefaultTimeout(6000);
  await page.goto(b + '?rev=f2b#s=terminal');
  await page.click('[data-tab="s3"]');
  await page.click('#btn-split');
  await page.click('#pane-b');
  await page.hover('[data-tab="s1"]');
  await page.click('[data-tab-x="s1"]');
  const modalUp = await page.waitForFunction(() => !document.getElementById('overlay-root').hidden, null, { timeout: 4000 }).then(() => true, () => false);
  console.log('close-modal:', modalUp);
  if (modalUp) {
    await page.click('#cs-confirm');
    console.log('after close right pane session:', await page.evaluate(() => JSON.stringify({
      split: S.split, right: S.splitRight, paneBHidden: document.getElementById('pane-b').hidden,
      toolbar: document.getElementById('tb-ident-text').textContent,
      chip: document.getElementById('file-host-chip').textContent,
    })));
  }
  await page.screenshot({ path: '/tmp/rev-ux-shots/f2-after-close.png' });
  await browser.close();
})().catch(e => { console.error('FATAL', e.message); process.exit(1); });
