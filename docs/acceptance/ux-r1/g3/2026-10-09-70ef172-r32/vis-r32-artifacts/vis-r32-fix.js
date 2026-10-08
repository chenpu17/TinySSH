// vis-r32 补充复验：diff 像素定位 + C1/C5/C9 修正
const { chromium } = require('/Users/chenpu/node_modules/playwright');
const fs = require('fs');
const EXE = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const OUT = '/tmp/vis-r32';
const CUR = 'http://localhost:5183/';
const BASE = 'http://localhost:5186/';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const browser = await chromium.launch({ executablePath: EXE, headless: true });
  const dctx = await browser.newContext();
  const dpage = await dctx.newPage();
  const newPage = async (url, w, h) => {
    const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 1 });
    const page = await ctx.newPage();
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await page.evaluate(() => { try { localStorage.clear(); } catch {} });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.host-card', { timeout: 15000 });
    await page.evaluate(() => document.fonts.ready);
    await sleep(600);
    return page;
  };
  // 返回 strict 差异像素簇（bbox+样本色对）
  const diffLocal = async (fa, fb, tag) => {
    const a = fs.readFileSync(fa).toString('base64');
    const b = fs.readFileSync(fb).toString('base64');
    const r = await dpage.evaluate(async ({ a, b }) => {
      const load = (d) => new Promise((res) => { const i = new Image(); i.onload = () => res(i); i.src = 'data:image/png;base64,' + d; });
      const [ia, ib] = await Promise.all([load(a), load(b)]);
      const mk = (i) => { const c = document.createElement('canvas'); c.width = i.width; c.height = i.height; const x = c.getContext('2d'); x.drawImage(i, 0, 0); return x.getImageData(0, 0, i.width, i.height).data; };
      const da = mk(ia), db = mk(ib);
      const px = [];
      for (let y = 0; y < ia.height; y++) for (let x = 0; x < ia.width; x++) {
        const i = (y * ia.width + x) * 4;
        const m = Math.max(Math.abs(da[i] - db[i]), Math.abs(da[i+1] - db[i+1]), Math.abs(da[i+2] - db[i+2]));
        if (m >= 1) px.push({ x, y, m, ca: [da[i], da[i+1], da[i+2]], cb: [db[i], db[i+1], db[i+2]] });
      }
      return px;
    }, { a, b });
    console.log(`[${tag}] diff_px=${r.length}`);
    for (const p of r.slice(0, 20)) console.log(`  (${p.x},${p.y}) maxΔ=${p.m} A=rgb(${p.ca}) B=rgb(${p.cb})`);
    // 簇 bbox
    if (r.length) {
      const xs = r.map((p) => p.x), ys = r.map((p) => p.y);
      console.log(`  bbox x:[${Math.min(...xs)},${Math.max(...xs)}] y:[${Math.min(...ys)},${Math.max(...ys)}]`);
    }
    return r;
  };

  // ---- W 定位（双 viewport，树间差 + 自差） ----
  const wc = await newPage(CUR, 1280, 800);
  const wb = await newPage(BASE, 1280, 800);
  await wc.screenshot({ path: `${OUT}/L128-cur.png` });
  await wb.screenshot({ path: `${OUT}/L128-base.png` });
  await wc.screenshot({ path: `${OUT}/L128-cur2.png` });
  const t128 = await diffLocal(`${OUT}/L128-base.png`, `${OUT}/L128-cur.png`, '1280 tree');
  const n128 = await diffLocal(`${OUT}/L128-cur.png`, `${OUT}/L128-cur2.png`, '1280 self');
  const wc6 = await newPage(CUR, 640, 800);
  const wb6 = await newPage(BASE, 640, 800);
  await wc6.screenshot({ path: `${OUT}/L640-cur.png` });
  await wb6.screenshot({ path: `${OUT}/L640-base.png` });
  const t640 = await diffLocal(`${OUT}/L640-base.png`, `${OUT}/L640-cur.png`, '640 tree');
  if (t640.length) {
    fs.writeFileSync(`${OUT}/crop.html`, `<body style="margin:0;background:#222">
      <img id="b" src="${OUT}/L640-base.png" style="position:absolute"><img id="c" src="${OUT}/L640-cur.png" style="position:absolute;opacity:0">
      <div style="position:fixed;top:0;left:0;color:#0f0;font:12px monospace">base</div></body>`);
  }

  // ---- C1/C5 修正：专职在途卡 ----
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

  // C1 修复：先造卡，等 800ms 轮询把真实卡渲染进 DOM，再取两帧
  await inv('upload_file', { sid, local: '/tmp/vis-r32-p1.bin', remote: '/tmp/vis-r32-p1.bin' });
  let t1 = null;
  for (let i = 0; i < 30 && !t1; i++) {
    await sleep(100);
    t1 = await page.evaluate(() => [...document.querySelectorAll('.xfer-row .xfer-sub')].map((r) => r.textContent).find((t) => t.includes('传输中') && /\d/.test(t)));
  }
  await sleep(650);
  const t2 = await page.evaluate(() => [...document.querySelectorAll('.xfer-row .xfer-sub')].map((r) => r.textContent).find((t) => t.includes('传输中') && /\d/.test(t)));
  const kb = (s) => { const m = /([\d.]+)\s*(KB|MB)/.exec(s || ''); return m ? parseFloat(m[1]) * (m[2] === 'MB' ? 1024 : 1) : null; };
  console.log((t1 && t2 && kb(t2) > kb(t1) ? 'PASS' : 'FAIL') + ` C1fix 两帧推进  t1="${t1}" t2="${t2}"`);
  console.log((/传输中…\s[\d.]+ (KB|MB) \/ [\d.]+ MB/.test(t1 || '') ? 'PASS' : 'FAIL') + ` C1bfix 排版  "${t1}"`);

  // C5 修复：在途窗口内对活卡按钮真实命中
  await inv('upload_file', { sid, local: '/tmp/vis-r32-p2.bin', remote: '/tmp/vis-r32-p2.bin' });
  let liveBox = null;
  for (let i = 0; i < 30 && !liveBox; i++) {
    await sleep(100);
    liveBox = await page.evaluate(() => {
      const row = [...document.querySelectorAll('.xfer-row')].find((r) => /传输中|排队中/.test(r.querySelector('.xfer-sub')?.textContent || ''));
      if (!row) return null;
      const btn = row.querySelector('button');
      if (!btn) return null;
      const bb = btn.getBoundingClientRect();
      const el = document.elementFromPoint(bb.left + bb.width / 2, bb.top + bb.height / 2);
      const sub = row.querySelector('.xfer-sub');
      return {
        hit: el === btn || btn.contains(el), hitEl: el ? (el.className || el.tagName) : null,
        btnW: Math.round(bb.width), btnH: Math.round(bb.height),
        rowH: Math.round(row.getBoundingClientRect().height),
        subClip: sub ? sub.scrollWidth > sub.clientWidth + 1 : null,
        nameClip: (() => { const n = row.querySelector('.xfer-name'); return n ? n.scrollWidth > n.clientWidth + 1 : false; })(),
      };
    });
  }
  console.log((liveBox && liveBox.hit && !liveBox.subClip && !liveBox.nameClip ? 'PASS' : 'FAIL') + ` C5fix 活卡取消钮命中+零截断  ${JSON.stringify(liveBox)}`);
  await page.screenshot({ path: `${OUT}/xfer-live-fix.png` });

  // C9 修复：Download 的 name=basename(dest=local) → 长名进 name 列
  const longName = 'vis-r32-' + '超长传输文件名测断'.repeat(12) + '-aaaaaaaaaaaaaaaaaaaaaa.bin';
  await inv('download_file', { sid, remote: '/var/log/src.tar.gz', local: '/tmp/' + longName });
  let longBox = null;
  for (let i = 0; i < 30 && !longBox; i++) {
    await sleep(150);
    longBox = await page.evaluate(() => {
      const rows = [...document.querySelectorAll('.xfer-row')];
      const r = rows.find((x) => (x.querySelector('.xfer-name')?.textContent || '').length > 80);
      if (!r) return null;
      const nm = r.querySelector('.xfer-name'), sub = r.querySelector('.xfer-sub'), p = document.querySelector('.task-panel'), de = document.documentElement;
      return {
        nameLen: nm.textContent.length, ellipsed: nm.scrollWidth > nm.clientWidth + 1,
        subClip: sub.scrollWidth > sub.clientWidth + 1,
        rowH: Math.round(r.getBoundingClientRect().height),
        panel: p.scrollWidth - p.clientWidth, doc: de.scrollWidth - de.clientWidth,
        title: !!nm.getAttribute('title'),
      };
    });
  }
  for (let i = 0; i < 40; i++) { const t = await page.evaluate(() => [...document.querySelectorAll('.xfer-row .xfer-sub')].map((r) => r.textContent).join('||')); if (!/传输中|排队中|取消中/.test(t)) break; await sleep(200); }
  console.log((longBox && longBox.ellipsed && longBox.title && longBox.panel <= 0 && longBox.doc <= 0 ? 'PASS' : 'FAIL') + ` C9fix 长名 ellipsis+零溢出  ${JSON.stringify(longBox)}`);
  await page.screenshot({ path: `${OUT}/xfer-longname.png` });
  console.log('pageerrors: ' + (errs.length ? errs.join(' | ') : '0'));
  await browser.close();
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
