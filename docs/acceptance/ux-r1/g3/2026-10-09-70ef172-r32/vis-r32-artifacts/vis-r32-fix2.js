// vis-r32 fix2: C1 三帧 900ms + 注册表交叉对账；640 差异区裁剪目检
const { chromium } = require('/Users/chenpu/node_modules/playwright');
const fs = require('fs');
const EXE = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const OUT = '/tmp/vis-r32';
const CUR = 'http://localhost:5183/';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const browser = await chromium.launch({ executablePath: EXE, headless: true });
  const dctx = await browser.newContext();
  const dpage = await dctx.newPage();

  // ---- 640 差异区裁剪 ----
  const crop = async (src, x, y, w, h, out) => {
    const b64 = fs.readFileSync(src).toString('base64');
    const data = await dpage.evaluate(async ({ b64, x, y, w, h }) => {
      const img = new Image();
      await new Promise((res) => { img.onload = res; img.src = 'data:image/png;base64,' + b64; });
      const c = document.createElement('canvas'); c.width = w * 4; c.height = h * 4;
      const g = c.getContext('2d'); g.imageSmoothingEnabled = false;
      g.drawImage(img, x, y, w, h, 0, 0, w * 4, h * 4);
      return c.toDataURL('image/png');
    }, { b64, x, y, w, h });
    fs.writeFileSync(out, Buffer.from(data.split(',')[1], 'base64'));
  };
  for (const [x, y, tag] of [[72, 10, 'a'], [517, 78, 'b'], [622, 738, 'c']]) {
    await crop(`${OUT}/L640-base.png`, Math.max(0, x - 50), Math.max(0, y - 30), 130, 80, `${OUT}/crop640-${tag}-base.png`);
    await crop(`${OUT}/L640-cur.png`, Math.max(0, x - 50), Math.max(0, y - 30), 130, 80, `${OUT}/crop640-${tag}-cur.png`);
  }

  // ---- C1 三帧 ----
  const errs = [];
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errs.push(String(e)));
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.goto(CUR, { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => { try { localStorage.clear(); } catch {} });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.host-card');
  const inv = (cmd, args) => page.evaluate(async ({ c, a }) => { const { invoke } = await import('/src/adapter/bridge.ts'); return invoke(c, a); }, { c: cmd, a: args });
  await page.evaluate(() => {
    [...document.querySelectorAll('.host-card')].find((c) => c.querySelector('.host-name')?.textContent.includes('prod-1'))?.querySelector('.host-connect-btn')?.click();
  });
  await page.waitForSelector('.hk-mask', { timeout: 8000 }).catch(() => {});
  await page.evaluate(() => { [...document.querySelectorAll('.hk-mask button')].find((x) => x.textContent.includes('信任并连接'))?.click(); });
  await sleep(1600);
  const sid = await inv('list_sessions').then((l) => l.find((x) => (x.host_name || '').includes('prod-1'))?.id);
  await page.evaluate(() => document.querySelector('.st-file')?.click());
  await sleep(300);

  const h = await inv('upload_file', { sid, local: '/tmp/vis-r32-f2.bin', remote: '/tmp/vis-r32-f2.bin' });
  const domText = () => page.evaluate(() => [...document.querySelectorAll('.xfer-row .xfer-sub')].map((r) => r.textContent).find((t) => t.includes('传输中') && /\d/.test(t)));
  let t1 = null;
  for (let i = 0; i < 30 && !t1; i++) { await sleep(100); t1 = await domText(); }
  const reg1 = await inv('list_transfers').then((l) => l.find((x) => x.id === h.id)?.bytes_done);
  await sleep(900);
  const t2 = await domText();
  const reg2 = await inv('list_transfers').then((l) => l.find((x) => x.id === h.id)?.bytes_done);
  await sleep(900);
  const t3 = await domText();
  const reg3 = await inv('list_transfers').then((l) => l.find((x) => x.id === h.id)?.bytes_done);
  const kb = (s) => { const m = /([\d.]+)\s*(KB|MB)/.exec(s || ''); return m ? parseFloat(m[1]) * (m[2] === 'MB' ? 1024 : 1) : null; };
  console.log(`frames: t1="${t1}" reg1=${reg1}`);
  console.log(`        t2="${t2}" reg2=${reg2}`);
  console.log(`        t3="${t3}" reg3=${reg3}`);
  const grew = kb(t2) > kb(t1) || kb(t3) > kb(t2);
  const regGrew = reg2 > reg1 && reg3 > reg2;
  const kbOk = t1 && t2 && Math.abs(kb(t1) - reg1 / 1024) < 300;
  console.log((grew && regGrew ? 'PASS' : 'FAIL') + ` C1v2 三帧推进(≥900ms 跨轮询边界) domGrew=${grew} regGrew=${regGrew}`);
  console.log((kbOk ? 'PASS' : 'FAIL') + ` C1v2b DOM 数字与注册表对账(±300KB 容轮询差)  dom=${kb(t1)}KB reg=${Math.round(reg1 / 1024)}KB`);
  console.log('pageerrors: ' + (errs.length ? errs.join(' | ') : '0'));
  await browser.close();
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
