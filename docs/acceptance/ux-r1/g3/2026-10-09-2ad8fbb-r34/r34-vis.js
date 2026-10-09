// R34 视觉自检（冲突/仲裁/恢复新面）：
// V1 欢迎页双树逐像素（013dc58 基线 :5184 vs 当前 :5183，统一深色）= 未触碰面零回归；
// V2 冲突卡盒测量：.xfer-conflict 块+三决策钮全在视口/面板内、零水平溢出、互不重叠、命中区≥24px；
// V3 unknown 卡（重新核实钮+保留说明）盒测量 + 截图；
// V4 Skipped/Interrupted/overwrite-Failed 终态行图标与文案呈现、面板零溢出；
// V5 冲突卡文字双主题对比度（深/浅）；
// V6 零 JS 错。
const { chromium } = require('/Users/chenpu/node_modules/playwright');
const EXE = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const results = [];
const ok = (name, cond, detail = '') => { results.push({ name, pass: !!cond }); console.log((cond ? 'PASS ' : 'FAIL ') + name + (detail ? '  [' + detail + ']' : '')); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const OUT = '/tmp/r34-vis';
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

  const errsAll = [];
  // V1 欢迎页双树
  const cur = await newPage('http://localhost:5183/');
  const base = await newPage('http://localhost:5184/');
  await cur.page.screenshot({ path: `${OUT}/welcome-cur.png` });
  await base.page.screenshot({ path: `${OUT}/welcome-base.png` });
  const diff1 = await pixelDiff(`${OUT}/welcome-cur.png`, `${OUT}/welcome-base.png`);
  ok('V1 welcome double-tree pixel diff = 0', diff1 === 0, String(diff1));
  await base.ctx.close();

  // 主页面：连接 prod-1 + 打开文件面板
  const page = cur.page;
  errsAll.push(...cur.errs);
  const demoInvoke = (cmd, args) => page.evaluate(async ({ c, a }) => {
    const { invoke } = await import('/src/adapter/bridge.ts');
    return invoke(c, a);
  }, { c: cmd, a: args });
  const waitFor_ = async (fn, tries, gap = 150) => {
    for (let i = 0; i < tries; i++) { const v = await fn(); if (v) return v; await sleep(gap); }
    return null;
  };
  await page.evaluate(() => {
    const card = [...document.querySelectorAll('.host-card')].find((c) => c.querySelector('.host-name')?.textContent.includes('prod-1'));
    card?.querySelector('.host-connect-btn')?.click();
  });
  await page.waitForSelector('.hk-mask', { timeout: 6000 }).catch(() => {});
  await page.evaluate(() => { [...document.querySelectorAll('.hk-mask button')].find((x) => x.textContent.includes('信任并连接'))?.click(); });
  await waitFor_(async () => (await demoInvoke('list_sessions')).find((x) => x.host_name.includes('prod-1') && x.state === 'Connected')?.id ?? null, 80);
  const sid = await demoInvoke('list_sessions').then((l) => {
    const mine = l.filter((x) => x.host_name.includes('prod-1') && x.state === 'Connected');
    return mine.sort((a, b) => (a.created_at < b.created_at ? 1 : -1))[0]?.id;
  });
  await page.evaluate(() => document.querySelector('.st-file')?.click());
  await waitFor_(async () => page.evaluate(() => !!document.querySelector('.xfer-row, .side-quiet')), 30);
  await sleep(500);
  const mkUp = (tag) => demoInvoke('upload_file', { sid, local: `/Users/demo/Desktop/${tag}`, remote: `/var/log/nginx/${tag}` });
  const panelBox = () => page.evaluate(() => {
    const sec = [...document.querySelectorAll('h4')].find((x) => x.textContent === '传输')?.parentElement;
    const r = sec.getBoundingClientRect();
    return { left: r.left, right: r.right, top: r.top, bottom: r.bottom };
  });

  // V2 冲突卡
  await mkUp('vis.conflict-demo');
  await waitFor_(async () => page.evaluate(() => !!document.querySelector('.xfer-conflict')), 20);
  await sleep(300);
  const v2 = await page.evaluate(() => {
    const vw = window.innerWidth, vh = window.innerHeight;
    const block = document.querySelector('.xfer-conflict');
    const row = block.closest('.xfer-row');
    const btns = [...block.querySelectorAll('button')];
    const rb = row.getBoundingClientRect(), bb = block.getBoundingClientRect();
    const boxes = btns.map((b) => { const r = b.getBoundingClientRect(); return { t: b.textContent.trim(), l: r.left, r: r.right, w: r.width, h: r.height }; });
    const inVp = (r) => r.left >= 0 && r.top >= 0 && r.right <= vw && r.bottom <= vh;
    const overlap = (a, b) => !(a.r <= b.l || b.r <= a.l);
    let ov = false;
    for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) if (overlap(boxes[i], boxes[j])) ov = true;
    const sec = [...document.querySelectorAll('h4')].find((x) => x.textContent === '传输')?.parentElement;
    const docOvf = document.documentElement.scrollWidth > document.documentElement.clientWidth;
    const secOvf = sec ? sec.scrollWidth > sec.clientWidth + 1 : true;
    return {
      blockInRow: rb.left <= bb.left && bb.right <= rb.right + 1,
      inVp: inVp(bb) && boxes.every((b) => inVp({ left: b.l, right: b.r, top: bb.top, bottom: bb.bottom })),
      hit: boxes.every((b) => b.h >= 24),
      overlapBtns: ov,
      btnCount: btns.length,
      docOvf, secOvf,
      text: block.textContent,
    };
  });
  ok('V2 conflict block inside card row & viewport', v2.blockInRow && v2.inVp, JSON.stringify(v2));
  ok('V2b three buttons, no overlap, hit ≥24px', v2.btnCount === 3 && !v2.overlapBtns && v2.hit, JSON.stringify({ n: v2.btnCount, ov: v2.overlapBtns }));
  ok('V2c no doc/section horizontal overflow', !v2.docOvf && !v2.secOvf);
  await page.evaluate(() => { document.querySelector('.xfer-conflict')?.closest('.xfer-row')?.scrollIntoView({ block: 'center' }); });
  await sleep(200);
  await page.screenshot({ path: `${OUT}/conflict-card.png` });

  // V3 unknown 卡
  await mkUp('vis.unknown-demo');
  await waitFor_(async () => page.evaluate(() => !!document.querySelector('[data-testid="uo-reverify"]')), 30);
  await sleep(300);
  const v3 = await page.evaluate(() => {
    const btn = document.querySelector('[data-testid="uo-reverify"]');
    const row = btn.closest('.xfer-row');
    const r = btn.getBoundingClientRect(), rr = row.getBoundingClientRect();
    const vw = window.innerWidth;
    return {
      inVp: r.left >= 0 && r.right <= vw && r.top >= 0 && r.bottom <= window.innerHeight,
      inRow: rr.left <= r.left && r.right <= rr.right + 1,
      w: r.width, h: r.height,
      note: row.textContent.includes('temp 与恢复资料保留'),
      unknownText: row.textContent.includes('结果未知：'),
    };
  });
  ok('V3 unknown card: button in viewport/row + note + label', v3.inVp && v3.inRow && v3.note && v3.unknownText, JSON.stringify(v3));
  await page.evaluate(() => { document.querySelector('[data-testid="uo-reverify"]')?.closest('.xfer-row')?.scrollIntoView({ block: 'center' }); });
  await sleep(200);
  await page.screenshot({ path: `${OUT}/unknown-card.png` });

  // V4 终态行（skip/overwrite-fail/interrupt）——按卡名定点点击（V2 卡仍待决）
  await mkUp('vis2.interrupt-demo');
  await mkUp('vis2.conflict-demo');
  await waitFor_(async () => page.evaluate(() => {
    const subs = [...document.querySelectorAll('.xfer-row .xfer-sub')].map((x) => x.textContent);
    return subs.some((t) => t.includes('已中断')) && subs.some((t) => t.includes('目标已存在'));
  }), 30);
  await sleep(400);
  const clickBtn = (name, tid) => page.evaluate(({ name, tid }) => {
    const r = [...document.querySelectorAll('.xfer-row')].find((x) => x.querySelector('.xfer-name')?.textContent === name);
    r?.querySelector(`[data-testid="${tid}"]`)?.click();
  }, { name, tid });
  await clickBtn('vis.conflict-demo', 'cf-skip');
  await waitFor_(async () => page.evaluate(() => [...document.querySelectorAll('.xfer-row .xfer-sub')].some((x) => x.textContent.includes('已跳过'))), 20);
  await clickBtn('vis2.conflict-demo', 'cf-overwrite');
  await waitFor_(async () => page.evaluate(() => [...document.querySelectorAll('.xfer-row .xfer-sub')].some((x) => x.textContent.includes('发布能力不足'))), 20);
  await sleep(300);
  const v4 = await page.evaluate(() => {
    const rows = [...document.querySelectorAll('.xfer-row')];
    const sec = [...document.querySelectorAll('h4')].find((x) => x.textContent === '传输')?.parentElement;
    const skipped = rows.find((x) => x.textContent.includes('已跳过'));
    const interrupted = rows.find((x) => x.textContent.includes('已中断'));
    const failed = rows.find((x) => x.textContent.includes('发布能力不足'));
    return {
      skippedDim: skipped ? !!skipped.querySelector('.dim') : false,
      interruptedErr: interrupted ? !!interrupted.querySelector('.err') : false,
      failedErr: failed ? !!failed.querySelector('.err') : false,
      secOvf: sec ? sec.scrollWidth > sec.clientWidth + 1 : true,
      docOvf: document.documentElement.scrollWidth > document.documentElement.clientWidth,
    };
  });
  ok('V4 terminal rows: skipped ⊘dim / interrupted ✕err / failed ✕err, no overflow',
    v4.skippedDim && v4.interruptedErr && v4.failedErr && !v4.secOvf && !v4.docOvf, JSON.stringify(v4));
  await page.screenshot({ path: `${OUT}/terminal-rows.png` });

  // V5 双主题对比度（冲突卡文字 vs 卡背景）——V4 已决全部卡，补一张待决卡
  await mkUp('vis3.conflict-demo');
  await waitFor_(async () => page.evaluate(() => !!document.querySelector('.xfer-conflict .xfer-sub')), 20);
  await sleep(300);
  const lum = (rgb) => {
    const [r, g, b] = rgb.match(/\d+/g).map(Number).map((v) => {
      const s = v / 255;
      return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const contrastOf = async (theme) => {
    await page.emulateMedia({ colorScheme: theme });
    await sleep(400);
    return page.evaluate(() => {
      const el = document.querySelector('.xfer-conflict .xfer-sub');
      const card = el.closest('.card');
      const fg = getComputedStyle(el).color;
      const bg = getComputedStyle(card).backgroundColor;
      const L = (c) => {
        const m = c.match(/\d+/g).map(Number);
        const f = (v) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4); };
        return 0.2126 * f(m[0]) + 0.7152 * f(m[1]) + 0.0722 * f(m[2]);
      };
      const [l1, l2] = [L(fg), L(bg)].sort((a, b) => b - a);
      return (l1 + 0.05) / (l2 + 0.05);
    });
  };
  const cd = await contrastOf('dark');
  const cl = await contrastOf('light');
  ok('V5 conflict text contrast dark ≥4.5', cd >= 4.5, cd.toFixed(2));
  ok('V5b conflict text contrast light ≥4.5', cl >= 4.5, cl.toFixed(2));
  await page.emulateMedia({ colorScheme: 'dark' });

  errsAll.push(...(await page.evaluate(() => window.__errs || [])));
  ok('V6 zero page errors', errsAll.length === 0, errsAll.join(' | ').slice(0, 300));
  const fails = results.filter((r) => !r.pass).length;
  console.log(`\n${results.length - fails}/${results.length} passed`);
  await browser.close();
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error('VIS CRASH', e); process.exit(2); });
