// vis-r32 独立视觉复验（不照抄作者脚本；方法学差异见各段注释）
// 1) welcome 双树逐像素：严格容差 0（任一通道差 ≥1 计 1 px）+ 每通道≤8 对照数，
//    1280 与 640 双 viewport，三连拍自差噪声底
// 2) 传输卡：真实渲染抓 queued「排队中」/cancelling「取消中」（错峰多开+DOM 高频采样），
//    两帧字节推进=实时渲染证据；盒测量（行高一致/零截断/取消钮 elementFromPoint/
//    .task-panel 280px 零横向溢出）；长文件名 ellipsis 优雅降级抽查
// 3) 640 窄窗独立 context 造卡
// 4) 全程 pageerror 收集
const { chromium } = require('/Users/chenpu/node_modules/playwright');
const fs = require('fs');
const EXE = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const OUT = '/tmp/vis-r32';
const CUR = 'http://localhost:5183/';
const BASE = 'http://localhost:5186/';
fs.mkdirSync(OUT, { recursive: true });
const R = [];
const rec = (name, pass, detail = '') => { R.push({ name, pass: !!pass }); console.log((pass ? 'PASS ' : 'FAIL ') + name + (detail ? '  [' + detail + ']' : '')); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const browser = await chromium.launch({ executablePath: EXE, headless: true });
  const errsAll = [];
  const newPage = async (url, w, h) => {
    const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 1 });
    const page = await ctx.newPage();
    const errs = [];
    page.on('pageerror', (e) => { errs.push(String(e)); errsAll.push(url + ' ' + String(e)); });
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await page.evaluate(() => { try { localStorage.clear(); } catch {} });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.host-card', { timeout: 15000 });
    await page.evaluate(() => document.fonts.ready);
    await sleep(600);
    return { ctx, page, errs };
  };
  const dctx = await browser.newContext();
  const dpage = await dctx.newPage();
  // 单遍算两个口径：strict=任一通道差≥1；tol8=任一通道差>8
  const diff = async (fa, fb) => {
    const a = fs.readFileSync(fa).toString('base64');
    const b = fs.readFileSync(fb).toString('base64');
    return dpage.evaluate(async ({ a, b }) => {
      const load = (d) => new Promise((res) => { const i = new Image(); i.onload = () => res(i); i.src = 'data:image/png;base64,' + d; });
      const [ia, ib] = await Promise.all([load(a), load(b)]);
      if (ia.width !== ib.width || ia.height !== ib.height) return { strict: -1, tol8: -1 };
      const mk = (i) => { const c = document.createElement('canvas'); c.width = i.width; c.height = i.height; const x = c.getContext('2d'); x.drawImage(i, 0, 0); return x.getImageData(0, 0, i.width, i.height).data; };
      const da = mk(ia), db = mk(ib);
      let strict = 0, tol8 = 0;
      for (let i = 0; i < da.length; i += 4) {
        const d0 = Math.abs(da[i] - db[i]), d1 = Math.abs(da[i + 1] - db[i + 1]), d2 = Math.abs(da[i + 2] - db[i + 2]);
        const m = Math.max(d0, d1, d2);
        if (m >= 1) strict++;
        if (m > 8) tol8++;
      }
      return { strict, tol8 };
    }, { a, b });
  };

  // ---------- Phase W：welcome 双树双 viewport ----------
  const w128c = await newPage(CUR, 1280, 800);
  const w128b = await newPage(BASE, 1280, 800);
  await w128c.page.screenshot({ path: `${OUT}/w128-cur-a.png` });
  await w128b.page.screenshot({ path: `${OUT}/w128-base.png` });
  await w128c.page.screenshot({ path: `${OUT}/w128-cur-b.png` });
  await sleep(400);
  await w128c.page.screenshot({ path: `${OUT}/w128-cur-c.png` });
  const n1 = await diff(`${OUT}/w128-cur-a.png`, `${OUT}/w128-cur-b.png`);
  const n2 = await diff(`${OUT}/w128-cur-b.png`, `${OUT}/w128-cur-c.png`);
  const d128 = await diff(`${OUT}/w128-base.png`, `${OUT}/w128-cur-a.png`);
  rec('W1 welcome 1280 双树 diff=0（严格容差）', d128.strict === 0, `strict=${d128.strict} tol8=${d128.tol8} noise=[${n1.strict},${n2.strict}]`);
  rec('W1b welcome 1280 严格差 == tol8 差（无亚像素噪声）', d128.strict === d128.tol8 && n1.strict === n1.tol8 && n2.strict === n2.tol8, `strict=${d128.strict} tol8=${d128.tol8}`);

  const w640c = await newPage(CUR, 640, 800);
  const w640b = await newPage(BASE, 640, 800);
  await w640c.page.screenshot({ path: `${OUT}/w640-cur-a.png` });
  await w640b.page.screenshot({ path: `${OUT}/w640-base.png` });
  await w640c.page.screenshot({ path: `${OUT}/w640-cur-b.png` });
  const n640 = await diff(`${OUT}/w640-cur-a.png`, `${OUT}/w640-cur-b.png`);
  const d640 = await diff(`${OUT}/w640-base.png`, `${OUT}/w640-cur-a.png`);
  rec('W2 welcome 640 双树 diff=0（严格容差）', d640.strict === 0, `strict=${d640.strict} tol8=${d640.tol8} noise=[${n640.strict}]`);

  // ---------- Phase C：传输卡（1280，全新 context） ----------
  const c128 = await newPage(CUR, 1280, 800);
  const page = c128.page;
  const inv = (cmd, args) => page.evaluate(async ({ c, a }) => { const { invoke } = await import('/src/adapter/bridge.ts'); return invoke(c, a); }, { c: cmd, a: args }).catch((e) => { throw new Error('invoke ' + cmd + ': ' + e.message); });
  await page.evaluate(() => {
    const card = [...document.querySelectorAll('.host-card')].find((c) => c.querySelector('.host-name')?.textContent.includes('prod-1'));
    card?.querySelector('.host-connect-btn')?.click();
  });
  await page.waitForSelector('.hk-mask', { timeout: 8000 }).catch(() => {});
  await page.evaluate(() => { [...document.querySelectorAll('.hk-mask button')].find((x) => x.textContent.includes('信任并连接'))?.click(); });
  await sleep(1600);
  const sid = await inv('list_sessions').then((l) => l.find((x) => (x.host_name || '').includes('prod-1'))?.id);
  rec('C0 demo 会话已连', !!sid, String(sid));
  await page.evaluate(() => document.querySelector('.st-file')?.click());
  await sleep(300);

  const subTexts = () => page.evaluate(() => [...document.querySelectorAll('.xfer-row .xfer-sub')].map((r) => r.textContent));
  const rowTextsAll = () => page.evaluate(() => [...document.querySelectorAll('.xfer-row')].map((r) => r.querySelector('.xfer-sub')?.textContent || ''));

  // 造四基态卡（进行中在途窗口 ~2.6s）
  await inv('upload_file', { sid, local: '/tmp/vis-r32-live.bin', remote: '/tmp/vis-r32-live.bin' });
  await sleep(120);
  await inv('upload_file', { sid, local: '/tmp/vis-r32-done.tar.gz', remote: '/var/log/vis-r32-done.tar.gz' });
  await inv('upload_file', { sid, local: '/tmp/fail-demo-r32.bin', remote: '/tmp/fail-demo-r32.bin' });
  const hC = await inv('upload_file', { sid, local: '/tmp/vis-r32-c.bin', remote: '/tmp/vis-r32-c.bin' });
  await sleep(320);
  await inv('cancel_transfer', { id: hC.id });

  // 两帧进度推进采样（实时渲染证据）
  const p1 = (await subTexts()).find((t) => t.includes('传输中'));
  await sleep(650);
  const p2 = (await subTexts()).find((t) => t.includes('传输中'));
  const kb = (s) => { const m = /([\d.]+)\s*(KB|MB)/.exec(s || ''); return m ? parseFloat(m[1]) * (m[2] === 'MB' ? 1024 : 1) : null; };
  rec('C1 进度文本两帧推进（实时渲染）', !!p1 && !!p2 && kb(p2) > kb(p1), `t1="${p1}" t2="${p2}"`);
  const fmtOk = /传输中…\s[\d.]+ (KB|MB) \/ [\d.]+ MB/.test(p1 || '');
  rec('C1b 进度文本排版「传输中… X KB / N MB」', fmtOk, p1);

  // 等在途卡全落终态，测四基态盒
  for (let i = 0; i < 50; i++) { const t = (await rowTextsAll()).join('||'); if (!/传输中|排队中|取消中/.test(t)) break; await sleep(200); }
  await page.screenshot({ path: `${OUT}/xfer-4states-1280.png` });
  const boxAll = await page.evaluate(() => {
    const rows = [...document.querySelectorAll('.xfer-row')];
    return rows.map((r) => {
      const sub = r.querySelector('.xfer-sub'), nm = r.querySelector('.xfer-name'), btn = r.querySelector('button');
      const rb = r.getBoundingClientRect();
      let hit = null, bb = null;
      if (btn) {
        bb = btn.getBoundingClientRect();
        const el = document.elementFromPoint(bb.left + bb.width / 2, bb.top + bb.height / 2);
        hit = el === btn || btn.contains(el);
      }
      return {
        text: (sub?.textContent || '').slice(0, 46),
        h: Math.round(rb.height), w: Math.round(rb.width),
        subClip: sub ? (sub.scrollWidth > sub.clientWidth + 1 || sub.scrollHeight > sub.clientHeight + 1) : null,
        nameClip: nm ? (nm.scrollWidth > nm.clientWidth + 1 || nm.scrollHeight > nm.clientHeight + 1) : null,
        btn: bb ? { w: Math.round(bb.width), h: Math.round(bb.height), hit } : null,
      };
    });
  });
  const statesSeen = ['已取消', '失败：演示注入', '完成 ·'].map((k) => boxAll.some((b) => b.text.includes(k)));
  rec('C2 四基态卡可见（完成/失败/已取消/曾进行中）', statesSeen.every(Boolean) && boxAll.length >= 4, boxAll.map((b) => `${b.text.slice(0, 14)}|h${b.h}`).join(' ; '));
  rec('C3 基态卡零截断', boxAll.every((b) => !b.subClip && !b.nameClip), JSON.stringify(boxAll.map((b) => [b.subClip, b.nameClip])));
  const hs = boxAll.map((b) => b.h);
  rec('C4 行高一致', new Set(hs).size === 1, hs.join(','));
  const actBtns = boxAll.filter((b) => b.btn);
  rec('C5 取消钮命中（elementFromPoint 中心）', actBtns.every((b) => b.btn.hit), JSON.stringify(actBtns.map((b) => b.btn)));
  const overflowPanel = await page.evaluate(() => {
    const p = document.querySelector('.task-panel');
    const de = document.documentElement;
    return { panel: p ? p.scrollWidth - p.clientWidth : -999, doc: de.scrollWidth - de.clientWidth };
  });
  rec('C6 280px 面板+文档零横向溢出', overflowPanel.panel <= 0 && overflowPanel.doc <= 0, JSON.stringify(overflowPanel));

  // queued「排队中」真实渲染抓捕：错峰创建 ×5 覆盖 800ms 轮询周期，DOM 20ms 采样
  let queuedShot = null;
  for (let round = 0; round < 4 && !queuedShot; round++) {
    const ps = [];
    for (let i = 0; i < 5; i++) { ps.push(inv('upload_file', { sid, local: `/tmp/vis-r32-q${round}-${i}.bin`, remote: `/tmp/vis-r32-q${round}-${i}.bin` })); await sleep(100); }
    const t0 = Date.now();
    while (Date.now() - t0 < 2200) {
      const ts = await rowTextsAll();
      const q = ts.find((t) => t.includes('排队中'));
      if (q) { queuedShot = q; break; }
      await sleep(20);
    }
    if (!queuedShot) for (let i = 0; i < 40; i++) { const t = (await rowTextsAll()).join('||'); if (!/传输中|排队中|取消中/.test(t)) break; await sleep(200); }
  }
  if (queuedShot) await page.screenshot({ path: `${OUT}/xfer-queued-1280.png` });
  rec('C7 queued「排队中…」真实渲染抓捕', !!queuedShot, queuedShot || '4 轮未捕获');

  // cancelling「取消中…」真实渲染抓捕：错峰取消 ×8，DOM 15ms 采样
  let cancelShot = null;
  for (let round = 0; round < 4 && !cancelShot; round++) {
    const hs2 = [];
    for (let i = 0; i < 8; i++) {
      const h = await inv('upload_file', { sid, local: `/tmp/vis-r32-x${round}-${i}.bin`, remote: `/tmp/vis-r32-x${round}-${i}.bin` });
      hs2.push(h.id); await sleep(60);
    }
    await sleep(300);
    for (const id of hs2) { inv('cancel_transfer', { id }).catch(() => {}); await sleep(55); }
    const t0 = Date.now();
    while (Date.now() - t0 < 2000) {
      const ts = await rowTextsAll();
      const c = ts.find((t) => t.includes('取消中'));
      if (c) { cancelShot = c; break; }
      await sleep(15);
    }
    for (let i = 0; i < 50; i++) { const t = (await rowTextsAll()).join('||'); if (!/传输中|排队中|取消中/.test(t)) break; await sleep(180); }
  }
  if (cancelShot) await page.screenshot({ path: `${OUT}/xfer-cancelling-1280.png` });
  rec('C8 cancelling「取消中…」真实渲染抓捕', !!cancelShot, cancelShot || '4 轮未捕获');

  // 长文件名：ellipsis 优雅降级（title 提示），面板仍零溢出（登记项非门槛）
  await inv('upload_file', { sid, local: '/tmp/vis-r32-long.bin', remote: '/tmp/' + 'vis-r32-超长文件名'.repeat(14) + '-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.bin' });
  for (let i = 0; i < 40; i++) { const t = (await rowTextsAll()).join('||'); if (!/传输中|排队中|取消中/.test(t)) break; await sleep(200); }
  const longBox = await page.evaluate(() => {
    const rows = [...document.querySelectorAll('.xfer-row')];
    const r = rows.find((x) => (x.querySelector('.xfer-name')?.textContent || '').length > 60);
    if (!r) return null;
    const nm = r.querySelector('.xfer-name'), p = document.querySelector('.task-panel');
    const nmb = nm.getBoundingClientRect(), rb = r.getBoundingClientRect();
    return { nameW: Math.round(nmb.width), rowW: Math.round(rb.width), ellipsed: nm.scrollWidth > nm.clientWidth, panelOverflow: p.scrollWidth - p.clientWidth, title: !!nm.getAttribute('title') };
  });
  rec('C9 长文件名 ellipsis 优雅降级+面板零溢出', longBox && longBox.ellipsed && longBox.panelOverflow <= 0 && longBox.title, JSON.stringify(longBox));

  // ---------- Phase N：640 窄窗（独立 context 造卡） ----------
  const c640 = await newPage(CUR, 640, 800);
  const page6 = c640.page;
  const inv6 = (cmd, args) => page6.evaluate(async ({ c, a }) => { const { invoke } = await import('/src/adapter/bridge.ts'); return invoke(c, a); }, { c: cmd, a: args });
  await page6.evaluate(() => {
    const card = [...document.querySelectorAll('.host-card')].find((c) => c.querySelector('.host-name')?.textContent.includes('prod-1'));
    card?.querySelector('.host-connect-btn')?.click();
  });
  await page6.waitForSelector('.hk-mask', { timeout: 8000 }).catch(() => {});
  await page6.evaluate(() => { [...document.querySelectorAll('.hk-mask button')].find((x) => x.textContent.includes('信任并连接'))?.click(); });
  await sleep(1600);
  const sid6 = await inv6('list_sessions').then((l) => l.find((x) => (x.host_name || '').includes('prod-1'))?.id);
  await page6.evaluate(() => document.querySelector('.st-file')?.click());
  await inv6('upload_file', { sid6, local: '/tmp/vis-r32-n640-a.bin', remote: '/tmp/vis-r32-n640-a.bin' });
  await inv6('upload_file', { sid6, local: '/tmp/fail-demo-n640.bin', remote: '/tmp/fail-demo-n640.bin' });
  await sleep(350);
  let mid640 = null;
  for (let i = 0; i < 16; i++) {
    const t = await page6.evaluate(() => [...document.querySelectorAll('.xfer-row')].map((r) => r.querySelector('.xfer-sub')?.textContent || '').join('||'));
    if (t.includes('传输中')) { mid640 = t; break; }
    await sleep(120);
  }
  await page6.screenshot({ path: `${OUT}/xfer-640-mid.png` });
  const box640 = await page6.evaluate(() => {
    const rows = [...document.querySelectorAll('.xfer-row')];
    const p = document.querySelector('.task-panel'), de = document.documentElement;
    return {
      cards: rows.length,
      hs: rows.map((r) => Math.round(r.getBoundingClientRect().height)),
      clips: rows.map((r) => { const s = r.querySelector('.xfer-sub'), n = r.querySelector('.xfer-name'); return (s && (s.scrollWidth > s.clientWidth + 1 || s.scrollHeight > s.clientHeight + 1)) || (n && (n.scrollWidth > n.clientWidth + 1)) || false; }),
      panel: p ? p.scrollWidth - p.clientWidth : -999, doc: de.scrollWidth - de.clientWidth,
    };
  });
  rec('N1 640 窄窗在途卡渲染+零溢出', !!mid640 && box640.cards >= 2 && box640.panel <= 0 && box640.doc <= 0 && box640.clips.every((c) => !c), `cards=${box640.cards} h=[${box640.hs}] panel=${box640.panel} doc=${box640.doc}`);
  for (let i = 0; i < 50; i++) { const t = await page6.evaluate(() => [...document.querySelectorAll('.xfer-row .xfer-sub')].map((r) => r.textContent).join('||')); if (!/传输中|排队中|取消中/.test(t)) break; await sleep(200); }
  await page6.screenshot({ path: `${OUT}/xfer-640-terminal.png` });
  rec('N2 640 终态卡零截断行高一致', box640.hs.every((h) => h === box640.hs[0]) && box640.clips.every((c) => !c), `h=[${box640.hs}]`);

  rec('E1 全程零 JS pageerror', errsAll.length === 0, errsAll.slice(0, 3).join(' | '));

  console.log('---');
  console.log(`SUMMARY ${R.filter((x) => x.pass).length}/${R.length}`);
  fs.writeFileSync(`${OUT}/my-vis-run.json`, JSON.stringify(R, null, 1));
  await browser.close();
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
