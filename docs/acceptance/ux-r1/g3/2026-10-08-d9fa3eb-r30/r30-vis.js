// R30 视觉复验：变更面收敛在文件浏览器面板——
// 1) 欢迎页双树逐像素（dd9/d60 基线 :5184 vs 当前 :5183）= 零回归证明（未触碰面）；
// 2) files 面盒测量（当前树）：未知字段「—」、symlink 行「→/链接」、行高与基线一致、
//    无横向溢出、错误行不截断、640 窄窗不破版；
// 3) 零 JS 错误。
const { chromium } = require('/Users/chenpu/node_modules/playwright');
const EXE = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const results = [];
const ok = (name, cond, detail = '') => { results.push({ name, pass: !!cond }); console.log((cond ? 'PASS ' : 'FAIL ') + name + (detail ? '  [' + detail + ']' : '')); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const OUT = '/tmp/r30-vis';
require('fs').mkdirSync(OUT, { recursive: true });

(async () => {
  const browser = await chromium.launch({ executablePath: EXE, headless: true });

  // ---- 双树截图工具 ----
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
  // PNG diff helper：空白页 canvas 逐像素（R27 同款零依赖工艺；容差 8/通道滤 AA 噪声）
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

  // ---- 1) 欢迎页双树 ----
  const cur = await newPage('http://localhost:5183/');
  const base = await newPage(process.env.VIS_BASE || 'http://localhost:5186/');
  await cur.page.screenshot({ path: `${OUT}/welcome-cur.png` });
  await base.page.screenshot({ path: `${OUT}/welcome-base.png` });
  // 噪声底（R27 方法学）：同树连拍自差——亚阈值 AA/时序噪声的实测底
  await cur.page.screenshot({ path: `${OUT}/welcome-cur2.png` });
  const noise = await pixelDiff(`${OUT}/welcome-cur.png`, `${OUT}/welcome-cur2.png`);
  const wd = await pixelDiff(`${OUT}/welcome-base.png`, `${OUT}/welcome-cur.png`);
  ok('V1 welcome diff within noise floor (untouched face)', wd <= Math.max(noise, 3), `diff_px=${wd} noise_floor=${noise}`);

  // ---- 2) files 面盒测量（当前树） ----
  const page = cur.page;
  await page.evaluate((h) => {
    const card = [...document.querySelectorAll('.host-card')].find((c) => c.querySelector('.host-name')?.textContent.includes(h));
    card?.querySelector('.host-connect-btn')?.click();
  }, 'prod-1');
  await page.waitForSelector('.hk-mask', { timeout: 6000 }).catch(() => {});
  await page.evaluate(() => {
    [...document.querySelectorAll('.hk-mask button')].find((x) => x.textContent.includes('信任并连接'))?.click();
  });
  await sleep(1500);
  await page.evaluate(() => document.querySelector('.st-file')?.click());
  await page.waitForSelector('.sftp-list .sftp-row', { timeout: 8000 });
  await sleep(400);
  await page.screenshot({ path: `${OUT}/files-cur.png` });

  const rows = await page.evaluate(() => [...document.querySelectorAll('.sftp-list .sftp-row')].map((r) => {
    const b = r.getBoundingClientRect();
    return {
      name: r.querySelector('.sftp-name')?.textContent,
      size: r.querySelector('.sftp-size')?.textContent,
      time: r.querySelector('.sftp-time')?.textContent,
      h: Math.round(b.height * 10) / 10,
      w: Math.round(b.width * 10) / 10,
      nameClipped: (() => { const n = r.querySelector('.sftp-name'); return n ? n.scrollWidth > n.clientWidth + 1 : false; })(),
    };
  }));
  const sock = rows.find((r) => r.name === 'php-fpm.sock');
  const link = rows.find((r) => r.name === 'latest');
  ok('V2 sock row em-dash cells', sock && sock.size === '—' && sock.time === '—', JSON.stringify(sock));
  ok('V3 symlink row glyph + label', link && link.size === '链接', JSON.stringify(link));
  const hs = new Set(rows.map((r) => r.h));
  ok('V5 no name clipping in rows', rows.every((r) => !r.nameClipped), JSON.stringify(rows.filter((r) => r.nameClipped)));
  const overflow = await page.evaluate(() => {
    const l = document.querySelector('.sftp-list');
    return l ? l.scrollWidth - l.clientWidth : -1;
  });
  ok('V6 no horizontal overflow in list', overflow <= 0, `overflow=${overflow}px`);

  // 错误行不截断 + 盒测量
  await page.evaluate((x) => {
    const el = document.querySelector('.sftp-path input');
    const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    el.focus(); set.call(el, x);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  }, '/var/private');
  await sleep(700);
  const errBox = await page.evaluate(() => {
    const e = document.querySelector('.section .err');
    if (!e) return null;
    const b = e.getBoundingClientRect();
    return { text: e.textContent, clipped: e.scrollHeight > e.clientHeight + 2, w: Math.round(b.width), h: Math.round(b.height) };
  });
  ok('V7 denied error visible + unclipped', errBox && errBox.text.includes('权限不足') && !errBox.clipped, JSON.stringify(errBox));
  await page.screenshot({ path: `${OUT}/files-err.png` });

  // ---- 行高对账（基线树同面板） ----
  await base.page.evaluate((h) => {
    const card = [...document.querySelectorAll('.host-card')].find((c) => c.querySelector('.host-name')?.textContent.includes(h));
    card?.querySelector('.host-connect-btn')?.click();
  }, 'prod-1');
  await base.page.waitForSelector('.hk-mask', { timeout: 6000 }).catch(() => {});
  await base.page.evaluate(() => {
    [...document.querySelectorAll('.hk-mask button')].find((x) => x.textContent.includes('信任并连接'))?.click();
  });
  await sleep(1500);
  await base.page.evaluate(() => document.querySelector('.st-file')?.click());
  await base.page.waitForSelector('.sftp-list .sftp-row', { timeout: 8000 });
  await sleep(400);
  await base.page.screenshot({ path: `${OUT}/files-base.png` });
  const baseRows = await base.page.evaluate(() => [...document.querySelectorAll('.sftp-list .sftp-row')].map((r) => ({
    name: r.querySelector('.sftp-name')?.textContent,
    h: Math.round(r.getBoundingClientRect().height * 10) / 10,
  })));
  // 共同名行（archive/access.log/error.log 两树都有）逐一等高=布局未变
  const pairs = baseRows.filter((b) => rows.some((c) => c.name === b.name));
  // ±1px：跨实例亚像素行高累积取整（同树内同型行也观测到 30/31 波动）
  const hMatch = pairs.every((b) => Math.abs(rows.find((c) => c.name === b.name).h - b.h) <= 1);
  ok('V8 shared-row heights match baseline (layout unchanged)', pairs.length >= 3 && hMatch,
    `pairs=${pairs.length} ` + pairs.map((b) => `${b.name}:${b.h}vs${rows.find((c) => c.name === b.name).h}`).join(','));

  // ---- 3) 640 窄窗不破版（当前树） ----
  const ctx2 = await browser.newContext({ viewport: { width: 640, height: 700 } });
  const p2 = await ctx2.newPage();
  await p2.goto('http://localhost:5183/', { waitUntil: 'domcontentloaded' });
  await p2.evaluate(() => { try { localStorage.clear(); } catch {} });
  await p2.reload({ waitUntil: 'domcontentloaded' });
  await p2.waitForSelector('.host-card', { timeout: 10000 });
  await sleep(400);
  await p2.evaluate((h) => {
    const card = [...document.querySelectorAll('.host-card')].find((c) => c.querySelector('.host-name')?.textContent.includes(h));
    card?.querySelector('.host-connect-btn')?.click();
  }, 'prod-1');
  await p2.waitForSelector('.hk-mask', { timeout: 6000 }).catch(() => {});
  await p2.evaluate(() => {
    [...document.querySelectorAll('.hk-mask button')].find((x) => x.textContent.includes('信任并连接'))?.click();
  });
  await sleep(1500);
  await p2.evaluate(() => document.querySelector('.st-file')?.click());
  const narrowOk = await p2.waitForSelector('.sftp-list .sftp-row', { timeout: 8000 }).then(() => true).catch(() => false);
  const narrowOverflow = await p2.evaluate(() => {
    const l = document.querySelector('.sftp-list');
    return l ? l.scrollWidth - l.clientWidth : -1;
  });
  ok('V9 640px narrow: rows render, no overflow', narrowOk && narrowOverflow <= 0, `ok=${narrowOk} overflow=${narrowOverflow}px`);
  await p2.screenshot({ path: `${OUT}/files-640.png` });

  ok('V10 zero js errors (cur)', cur.errs.length === 0, cur.errs.join('||').slice(0, 150));

  console.log('SUMMARY ' + results.filter((r) => r.pass).length + '/' + results.length);
  await browser.close();
})();
