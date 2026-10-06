'use strict';
const { chromium } = require('/Users/chenpu/node_modules/playwright');
const base = 'file:///Users/chenpu/workspace/claude-code/TinySSH/docs/ux/ux-r1-g0/r01-prototype/index.html';
(async () => {
  const browser = await chromium.launch({ headless: true, executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  page.setDefaultTimeout(6000);
  page.on('pageerror', e => console.log('PAGEERROR', e.message));
  const log = (...a) => console.log(...a);

  log('--- F2 debug ---');
  await page.goto(base + '?rev=f2#s=terminal');
  await page.click('[data-tab="s3"]').then(() => log('tab s3 ok'), e => log('tab s3 FAIL', e.message));
  await page.click('#btn-split').then(() => log('split ok'), e => log('split FAIL', e.message));
  await page.click('#pane-b').then(() => log('pane-b ok'), e => log('pane-b FAIL', e.message));
  log('state', await page.evaluate(() => JSON.stringify({ active: S.active, focus: S.paneFocus, right: S.splitRight, toolbar: document.getElementById('tb-ident-text').textContent })));
  await page.click('#btn-files').then(() => log('files ok'), e => log('files FAIL', e.message));
  log('chip', await page.textContent('#file-host-chip').catch(e => 'ERR ' + e.message));
  await page.click('#btn-upload').then(() => log('upload ok'), e => log('upload FAIL', e.message));
  log('task', await page.evaluate(() => { const t = S.drawer.tasks[S.drawer.tasks.length - 1]; return t ? t.to : 'none'; }));
  await page.screenshot({ path: '/tmp/rev-ux-shots/f2-debug.png' });
  await page.click('[data-tab-x="s1"]').then(() => log('tabx s1 ok'), e => log('tabx s1 FAIL', e.message));
  const modalUp = await page.waitForFunction(() => !document.getElementById('overlay-root').hidden, null, { timeout: 4000 }).then(() => true, () => false);
  log('close-modal visible:', modalUp);
  if (modalUp) {
    await page.click('#cs-confirm').then(() => log('confirm ok'), e => log('confirm FAIL', e.message));
    log('after close', await page.evaluate(() => JSON.stringify({ split: S.split, paneBHidden: document.getElementById('pane-b').hidden, toolbar: document.getElementById('tb-ident-text').textContent, chip: document.getElementById('file-host-chip').textContent })));
  }

  log('--- U5 debug ---');
  await page.goto(base + '?rev=u5#s=disconnected');
  await page.getByRole('button', { name: '立即重连', exact: true }).click();
  await page.waitForFunction(() => S.sessions.find(s => s.id === S.active).status === 'connected');
  await page.waitForTimeout(300);
  const bannerText = await page.textContent('#term-banner');
  log('bannerText =', JSON.stringify(bannerText));
  const bannerHidden = await page.evaluate(() => document.getElementById('term-banner').hidden);
  log('bannerHidden =', bannerHidden);
  const s = await page.evaluate(() => { const x = S.sessions.find(y => y.id === S.active); return JSON.stringify({ st: x.status, banner: x.banner && x.banner.title, stamp: !!x.reconnectStamp }); });
  log('session =', s);
  const active = await page.evaluate(() => S.active);
  await page.click('[data-tab-x="' + active + '"]');
  await page.waitForFunction(() => !document.getElementById('overlay-root').hidden);
  log('close dlg =', (await page.textContent('.modal')).slice(0, 120));
  await page.click('#cs-confirm');
  log('removed =', await page.evaluate((a) => !S.sessions.map(x => x.id).includes(a), active));
  await browser.close();
})().catch(e => { console.error('FATAL', e.message); process.exit(1); });
