// vis-r32 N 段补跑：640 窄窗传输卡
const { chromium } = require('/Users/chenpu/node_modules/playwright');
const fs = require('fs');
const EXE = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const OUT = '/tmp/vis-r32';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const browser = await chromium.launch({ executablePath: EXE, headless: true });
  const errs = [];
  const ctx = await browser.newContext({ viewport: { width: 640, height: 800 }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errs.push(String(e)));
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.goto('http://localhost:5183/', { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => { try { localStorage.clear(); } catch {} });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.host-card', { timeout: 15000 });
  await sleep(500);
  const inv = (cmd, args) => page.evaluate(async ({ c, a }) => { const { invoke } = await import('/src/adapter/bridge.ts'); return invoke(c, a); }, { c: cmd, a: args });
  const clicked = await page.evaluate(() => {
    const card = [...document.querySelectorAll('.host-card')].find((c) => c.querySelector('.host-name')?.textContent.includes('prod-1'));
    const btn = card?.querySelector('.host-connect-btn');
    if (!btn) return false;
    btn.click();
    return true;
  });
  console.log('connect clicked: ' + clicked);
  await page.waitForSelector('.hk-mask', { timeout: 8000 }).catch(() => {});
  await page.evaluate(() => { [...document.querySelectorAll('.hk-mask button')].find((x) => x.textContent.includes('信任并连接'))?.click(); });
  await sleep(1800);
  const sid = await inv('list_sessions').then((l) => l.find((x) => (x.host_name || '').includes('prod-1'))?.id).catch((e) => null);
  console.log('sid: ' + sid);
  if (!sid) { console.log('FAIL N1 connect'); process.exit(1); }
  await page.evaluate(() => document.querySelector('.st-file')?.click());
  await sleep(300);
  await inv('upload_file', { sid, local: '/tmp/vis-r32-n-a.bin', remote: '/tmp/vis-r32-n-a.bin' });
  await inv('upload_file', { sid, local: '/tmp/fail-demo-n.bin', remote: '/tmp/fail-demo-n.bin' });
  let mid = null;
  for (let i = 0; i < 20 && !mid; i++) {
    await sleep(120);
    mid = await page.evaluate(() => [...document.querySelectorAll('.xfer-row .xfer-sub')].map((r) => r.textContent).find((t) => t.includes('传输中') && /\d/.test(t)));
  }
  const box = await page.evaluate(() => {
    const rows = [...document.querySelectorAll('.xfer-row')];
    const p = document.querySelector('.task-panel'), de = document.documentElement;
    return {
      cards: rows.length,
      hs: rows.map((r) => Math.round(r.getBoundingClientRect().height)),
      clips: rows.map((r) => { const s = r.querySelector('.xfer-sub'), n = r.querySelector('.xfer-name'); return (s && (s.scrollWidth > s.clientWidth + 1 || s.scrollHeight > s.clientHeight + 1)) || (n && n.scrollWidth > n.clientWidth + 1) || false; }),
      panel: p ? p.scrollWidth - p.clientWidth : -999, doc: de.scrollWidth - de.clientWidth,
      btnHit: (() => { const b = document.querySelector('.xfer-row button'); if (!b) return null; const bb = b.getBoundingClientRect(); const el = document.elementFromPoint(bb.left + bb.width / 2, bb.top + bb.height / 2); return el === b || b.contains(el); })(),
    };
  });
  await page.screenshot({ path: `${OUT}/n640-mid.png` });
  console.log((mid && box.cards >= 2 && box.panel <= 0 && box.doc <= 0 && box.clips.every((c) => !c) && box.btnHit === true ? 'PASS' : 'FAIL') + ` N1 640 在途卡+零溢出+钮命中  ${JSON.stringify(box)} mid="${mid}"`);
  for (let i = 0; i < 50; i++) { const t = await page.evaluate(() => [...document.querySelectorAll('.xfer-row .xfer-sub')].map((r) => r.textContent).join('||')); if (!/传输中|排队中|取消中/.test(t)) break; await sleep(200); }
  const term = await page.evaluate(() => {
    const rows = [...document.querySelectorAll('.xfer-row')];
    return { hs: rows.map((r) => Math.round(r.getBoundingClientRect().height)), clips: rows.map((r) => { const s = r.querySelector('.xfer-sub'), n = r.querySelector('.xfer-name'); return (s && (s.scrollWidth > s.clientWidth + 1)) || (n && n.scrollWidth > n.clientWidth + 1) || false; }), texts: rows.map((r) => (r.querySelector('.xfer-sub')?.textContent || '').slice(0, 30)) };
  });
  await page.screenshot({ path: `${OUT}/n640-terminal.png` });
  console.log((term.hs.every((h) => h === term.hs[0]) && term.clips.every((c) => !c) ? 'PASS' : 'FAIL') + ` N2 640 终态零截断行高一致  h=[${term.hs}] texts=${JSON.stringify(term.texts)}`);
  console.log('pageerrors: ' + (errs.length ? errs.join(' | ') : '0'));
  await browser.close();
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
