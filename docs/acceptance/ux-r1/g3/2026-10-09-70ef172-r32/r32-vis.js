// R32 视觉复验（C5 传输卡片新面）：
// 1) 欢迎页双树逐像素（70ef172 基线 :5186 vs 当前 :5183，统一深色）= 未触碰面零回归；
// 2) 传输卡片盒测量（当前树 demo 域造卡：完成/失败/取消/进行中）：
//    文案零截断、取消钮真实命中（elementFromPoint）、面板零横向溢出、640 不破版；
// 3) 零 JS 错误。
const { chromium } = require('/Users/chenpu/node_modules/playwright');
const EXE = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const results = [];
const ok = (name, cond, detail = '') => { results.push({ name, pass: !!cond }); console.log((cond ? 'PASS ' : 'FAIL ') + name + (detail ? '  [' + detail + ']' : '')); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const OUT = '/tmp/r32-vis';
require('fs').mkdirSync(OUT, { recursive: true });

(async () => {
  const browser = await chromium.launch({ executablePath: EXE, headless: true });

  const newPage = async (url) => {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await ctx.newPage();
    const errs = [];
    page.on('pageerror', (e) => errs.push(String(e)));
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await page.evaluate(() => { try { localStorage.clear(); } catch {} });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.host-card', { timeout: 10000 });
    await sleep(500);
    return { ctx, page, errs };
  };
  const dctx = await browser.newContext();
  const dpage = await dctx.newPage();
  const pixelDiff = async (fA, fB) => {
    const fs = require('fs');
    const b64a = fs.readFileSync(fA).toString('base64');
    const b64b = fs.readFileSync(fB).toString('base64');
    return dpage.evaluate(async ({ a, b }) => {
      const load = (d) => new Promise((res) => { const i = new Image(); i.onload = () => res(i); i.src = 'data:image/png;base64,' + d; });
      const [ia, ib] = await Promise.all([load(a), load(b)]);
      if (ia.width !== ib.width || ia.height !== ib.height) return -1;
      const ca = document.createElement('canvas'); ca.width = ia.width; ca.height = ia.height;
      const cb = document.createElement('canvas'); cb.width = ib.width; cb.height = ib.height;
      const xa = ca.getContext('2d'); xa.drawImage(ia, 0, 0);
      const xb = cb.getContext('2d'); xb.drawImage(ib, 0, 0);
      const da = xa.getImageData(0, 0, ia.width, ia.height).data;
      const db = xb.getImageData(0, 0, ib.width, ib.height).data;
      let diff = 0;
      for (let i = 0; i < da.length; i += 4) {
        if (Math.abs(da[i] - db[i]) > 8 || Math.abs(da[i+1] - db[i+1]) > 8 || Math.abs(da[i+2] - db[i+2]) > 8) diff++;
      }
      return diff;
    }, { a: b64a, b: b64b });
  };

  // ---- 1) 欢迎页双树（未触碰面） ----
  const cur = await newPage('http://localhost:5183/');
  const base = await newPage('http://localhost:5186/');
  await cur.page.screenshot({ path: `${OUT}/welcome-cur.png` });
  await base.page.screenshot({ path: `${OUT}/welcome-base.png` });
  await cur.page.screenshot({ path: `${OUT}/welcome-cur2.png` });
  const noise = await pixelDiff(`${OUT}/welcome-cur.png`, `${OUT}/welcome-cur2.png`);
  const wd = await pixelDiff(`${OUT}/welcome-base.png`, `${OUT}/welcome-cur.png`);
  ok('V1 welcome diff within noise floor (untouched face)', wd <= Math.max(noise, 3), `diff_px=${wd} noise_floor=${noise}`);

  // ---- 2) 传输卡片盒测量（当前树） ----
  const page = cur.page;
  const demoInvoke = (cmd, args) => page.evaluate(async ({ c, a }) => {
    const { invoke } = await import('/src/adapter/bridge.ts');
    return invoke(c, a);
  }, { c: cmd, a: args });
  await page.evaluate(() => {
    const card = [...document.querySelectorAll('.host-card')].find((c) => c.querySelector('.host-name')?.textContent.includes('prod-1'));
    card?.querySelector('.host-connect-btn')?.click();
  });
  await page.waitForSelector('.hk-mask', { timeout: 6000 }).catch(() => {});
  await page.evaluate(() => {
    [...document.querySelectorAll('.hk-mask button')].find((x) => x.textContent.includes('信任并连接'))?.click();
  });
  await sleep(1500);
  const sid = await demoInvoke('list_sessions').then((l) => l.find((x) => x.host_name.includes('prod-1'))?.id);
  ok('V2 session connected', !!sid, String(sid));

  // 造四态卡：完成 / 失败 / 取消 / 进行中（先发起进行中的，再等三个终态）
  const hLive = await demoInvoke('upload_file', { sid, local: '/tmp/vis-live.bin', remote: '/tmp/vis-live.bin' });
  await demoInvoke('upload_file', { sid, local: '/tmp/vis-done.tar.gz', remote: '/var/log/vis-done.tar.gz' });
  await demoInvoke('upload_file', { sid, local: '/tmp/fail-demo.bin', remote: '/tmp/fail-demo.bin' });
  const hC = await demoInvoke('upload_file', { sid, local: '/tmp/vis-c.bin', remote: '/tmp/vis-c.bin' });
  await demoInvoke('cancel_transfer', { id: hC.id });
  await page.evaluate(() => document.querySelector('.st-file')?.click());
  // 等待：进行中卡仍为 传输中（在途窗口 ~2.3s）时测量
  let liveSeen = null;
  for (let i = 0; i < 20; i++) {
    const t = await page.evaluate(() => [...document.querySelectorAll('.xfer-row .xfer-sub')].map((r) => r.textContent).join(' || '));
    if (t.includes('传输中') || t.includes('排队中')) { liveSeen = t; break; }
    await sleep(150);
  }
  ok('V3 running card visible mid-flight (live state rendered)', !!liveSeen, (liveSeen || '').slice(0, 200));
  await page.screenshot({ path: `${OUT}/xfer-live.png` });
  const liveBox = await page.evaluate(() => {
    const row = [...document.querySelectorAll('.xfer-row')].find((r) => /传输中|排队中/.test(r.querySelector('.xfer-sub')?.textContent || ''));
    if (!row) return null;
    const sub = row.querySelector('.xfer-sub');
    const b = row.getBoundingClientRect();
    const btn = row.querySelector('button');
    const bb = btn ? btn.getBoundingClientRect() : null;
    let hit = null;
    if (btn) {
      const cx = bb.left + bb.width / 2, cy = bb.top + bb.height / 2;
      const el = document.elementFromPoint(cx, cy);
      hit = el === btn || btn.contains(el);
    }
    return {
      w: Math.round(b.width), h: Math.round(b.height),
      subClipped: sub ? sub.scrollHeight > sub.clientHeight + 1 : null,
      nameClipped: (() => { const n = row.querySelector('.xfer-name'); return n ? n.scrollWidth > n.clientWidth + 1 : false; })(),
      btnW: bb ? Math.round(bb.width) : null, btnH: bb ? Math.round(bb.height) : null,
      hit,
    };
  });
  ok('V4 live card no clipping + cancel button really hit', liveBox && !liveBox.subClipped && !liveBox.nameClipped && liveBox.hit === true, JSON.stringify(liveBox));
  // 等待全部到终态后测终态卡
  for (let i = 0; i < 40; i++) {
    const t = await page.evaluate(() => [...document.querySelectorAll('.xfer-row .xfer-sub')].map((r) => r.textContent).join(' || '));
    if (!/传输中|排队中/.test(t)) break;
    await sleep(200);
  }
  const boxes = await page.evaluate(() => {
    const rows = [...document.querySelectorAll('.xfer-row')];
    const l = document.querySelector('.side-panel, .panel, body');
    const clipped = rows.map((r) => {
      const sub = r.querySelector('.xfer-sub');
      const nm = r.querySelector('.xfer-name');
      return {
        text: (sub?.textContent || '').slice(0, 40),
        subClipped: sub ? sub.scrollHeight > sub.clientHeight + 1 : null,
        nameClipped: nm ? nm.scrollWidth > nm.clientWidth + 1 : false,
        h: Math.round(r.getBoundingClientRect().height),
      };
    });
    return clipped;
  });
  ok('V5 terminal cards no clipping (4 states)', boxes.length >= 4 && boxes.every((b) => !b.subClipped && !b.nameClipped), JSON.stringify(boxes));
  await page.screenshot({ path: `${OUT}/xfer-terminal.png` });
  const overflow = await page.evaluate(() => {
    const l = document.querySelector('.sftp-list') || document.querySelector('.section');
    return l ? l.scrollWidth - l.clientWidth : -1;
  });
  ok('V6 no horizontal overflow in panel', overflow <= 0, `overflow=${overflow}px`);

  // ---- 3) 640 窄窗不破版 ----
  const ctx2 = await browser.newContext({ viewport: { width: 640, height: 700 } });
  const p2 = await ctx2.newPage();
  const errs2 = [];
  p2.on('pageerror', (e) => errs2.push(String(e)));
  await p2.goto('http://localhost:5183/', { waitUntil: 'domcontentloaded' });
  await p2.evaluate(() => { try { localStorage.clear(); } catch {} });
  await p2.reload({ waitUntil: 'domcontentloaded' });
  await p2.waitForSelector('.host-card', { timeout: 10000 });
  await sleep(400);
  await p2.evaluate(() => {
    const card = [...document.querySelectorAll('.host-card')].find((c) => c.querySelector('.host-name')?.textContent.includes('prod-1'));
    card?.querySelector('.host-connect-btn')?.click();
  });
  await p2.waitForSelector('.hk-mask', { timeout: 6000 }).catch(() => {});
  await p2.evaluate(() => {
    [...document.querySelectorAll('.hk-mask button')].find((x) => x.textContent.includes('信任并连接'))?.click();
  });
  await sleep(1500);
  await p2.evaluate(() => document.querySelector('.st-file')?.click());
  // 独立 context = 独立 demo 实例：先造卡再测（同主树工艺）
  const sid2 = await p2.evaluate(async () => {
    const { invoke } = await import('/src/adapter/bridge.ts');
    return (await invoke('list_sessions')).find((x) => x.host_name.includes('prod-1'))?.id;
  });
  if (sid2) {
    await p2.evaluate(async (s) => {
      const { invoke } = await import('/src/adapter/bridge.ts');
      await invoke('upload_file', { sid: s, local: '/tmp/vis-n1.bin', remote: '/tmp/vis-n1.bin' });
      await invoke('upload_file', { sid: s, local: '/tmp/fail-demo.bin', remote: '/tmp/fail-demo2.bin' });
    }, sid2);
    await sleep(3500); // 等终态（3MB≈2.3s 在途 + 失败注入即刻）
  }
  await sleep(1200);
  const n640 = await p2.evaluate(() => ({
    cards: document.querySelectorAll('.xfer-row').length,
    overflow: (() => { const l = document.querySelector('.sftp-list') || document.querySelector('.section'); return l ? l.scrollWidth - l.clientWidth : -1; })(),
  }));
  ok('V7 640px narrow: cards render, no overflow', n640.cards >= 2 && n640.overflow <= 0, JSON.stringify(n640));
  await p2.screenshot({ path: `${OUT}/xfer-640.png` });

  ok('V8 zero js errors (cur)', cur.errs.length === 0 && errs2.length === 0, (cur.errs.concat(errs2)).join('||').slice(0, 150));

  console.log('SUMMARY ' + results.filter((r) => r.pass).length + '/' + results.length);
  await browser.close();
  process.exit(results.every((r) => r.pass) ? 0 : 1);
})();
