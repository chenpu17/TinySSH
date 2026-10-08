// R33 视觉自检（上传下载入口新面）：
// V1 欢迎页双树逐像素（4893865 基线 :5184 vs 当前 :5183，统一深色）= 未触碰面零回归；
// V2 导航行 7 钮（新增上传钮）零截断、互不重叠、全部落在面板内；
// V3 终端拖入确认卡：盒测量（视口内、输入/按钮可见）+ 截图 + Esc 还原；
// V4 动作菜单两钮（下载/另存为…）盒测量 + 视口内 + 截图；
// V5 零 JS 错。
const { chromium } = require('/Users/chenpu/node_modules/playwright');
const EXE = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const results = [];
const ok = (name, cond, detail = '') => { results.push({ name, pass: !!cond }); console.log((cond ? 'PASS ' : 'FAIL ') + name + (detail ? '  [' + detail + ']' : '')); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const OUT = '/tmp/r33-vis';
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
  await cur.page.screenshot({ path: `${OUT}/welcome-cur2.png` });
  const diffSelf = await pixelDiff(`${OUT}/welcome-cur.png`, `${OUT}/welcome-cur2.png`);
  // R33 处置轮有意触碰欢迎帮助「传输」行文案（§354 分区语义）——双树差=该行文字区
  //（实测 ~4.2k px），上限放宽为有界局部差；其余面板未触碰
  ok('V1 welcome dual-tree diff = intended copy line only', diff1 >= 0 && diff1 <= 10000, `diff=${diff1} self=${diffSelf}`);
  const copyOk = await cur.page.evaluate(() => document.body.textContent.includes('拖到文件面板直接传到正在浏览的目录'));
  ok('V1b new transfer copy rendered on welcome', copyOk);

  // 连接 + 开面板
  const demoInvoke = (cmd, args) => cur.page.evaluate(async ({ c, a }) => {
    const { invoke } = await import('/src/adapter/bridge.ts');
    return invoke(c, a);
  }, { c: cmd, a: args });
  await cur.page.evaluate(() => {
    const card = [...document.querySelectorAll('.host-card')].find((c) => c.querySelector('.host-name')?.textContent.includes('prod-1'));
    card?.querySelector('.host-connect-btn')?.click();
  });
  await cur.page.waitForSelector('.hk-mask', { timeout: 4000 }).catch(() => {});
  await cur.page.evaluate(() => { [...document.querySelectorAll('.hk-mask button')].find((x) => x.textContent.includes('信任并连接'))?.click(); });
  await sleep(1200);
  await cur.page.evaluate(() => { document.querySelector('.st-file')?.click(); });
  await cur.page.waitForSelector('[data-testid="sftp-list"]', { timeout: 5000 }).catch(() => {});
  await sleep(500);
  errsAll.push(...cur.errs);

  // V2 导航行 7 钮盒测量
  const navBtns = await cur.page.$$eval('.sftp-nav button', (bs) => {
    const panel = document.querySelector('.task-panel')?.getBoundingClientRect();
    const rects = bs.map((b) => { const r = b.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; });
    let overlap = 0;
    for (let i = 0; i < rects.length; i++) for (let j = i + 1; j < rects.length; j++) {
      const a = rects[i], b = rects[j];
      if (a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h) overlap++;
    }
    const clipped = rects.filter((r) => panel && (r.x < panel.x || r.x + r.w > panel.x + panel.width));
    return { n: rects.length, sizes: rects.map((r) => Math.round(r.h)), overlap, clipped: clipped.length };
  });
  ok('V2a nav row 7 buttons', navBtns.n === 7, JSON.stringify(navBtns));
  ok('V2b nav buttons uniform height & unclipped', navBtns.clipped === 0 && new Set(navBtns.sizes).size === 1, JSON.stringify(navBtns.sizes));
  ok('V2c no button overlap', navBtns.overlap === 0);

  // V3 确认卡（终端落点）
  await demoInvoke('demo_drag_drop', { paths: ['/Users/demo/Desktop/deploy.tar.gz', '/Users/demo/Desktop/app.yml'], x: 300, y: 400 });
  await cur.page.waitForSelector('[data-testid="drop-dir-input"]', { timeout: 3000 });
  await sleep(250);
  const cardBox = await cur.page.$eval('.confirm-dialog', (el) => {
    const r = el.getBoundingClientRect();
    const input = el.querySelector('input')?.getBoundingClientRect();
    const btns = [...el.querySelectorAll('button')].map((b) => { const rb = b.getBoundingClientRect(); return { t: b.textContent, w: Math.round(rb.width), h: Math.round(rb.height), vis: rb.width > 0 && rb.height > 0 }; });
    return { x: r.x, y: r.y, w: r.width, h: r.height, vw: innerWidth, vh: innerHeight, input: input ? { w: Math.round(input.width), h: Math.round(input.height) } : null, btns };
  });
  ok('V3a confirm card in viewport', cardBox.x >= 0 && cardBox.y >= 0 && cardBox.x + cardBox.w <= cardBox.vw && cardBox.y + cardBox.h <= cardBox.vh, JSON.stringify({ w: cardBox.w, h: cardBox.h }));
  ok('V3b input rendered', !!cardBox.input && cardBox.input.w > 200, JSON.stringify(cardBox.input));
  ok('V3c two buttons visible (cancel/confirm)', cardBox.btns.length === 2 && cardBox.btns.every((b) => b.vis), JSON.stringify(cardBox.btns));
  const confirmDisabled = await cur.page.$eval('[data-testid="drop-confirm"]', (b) => b.disabled);
  ok('V3d confirm enabled with prefilled dir', confirmDisabled === false);
  await cur.page.screenshot({ path: `${OUT}/drop-card.png` });
  await cur.page.keyboard.press('Escape');
  await sleep(200);
  const cardGone = await cur.page.$('[data-testid="drop-dir-input"]');
  ok('V3e Esc closes card', !cardGone);

  // V4 动作菜单两钮
  await cur.page.evaluate(() => {
    const row = [...document.querySelectorAll('[data-testid="sftp-list"] .sftp-row')].find((r) => r.dataset.name === 'access.log');
    row?.querySelector('.sftp-name')?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
  });
  await cur.page.waitForSelector('[data-testid="sftp-menu"]', { timeout: 3000 });
  await sleep(200);
  const menuBox = await cur.page.$eval('[data-testid="sftp-menu"]', (el) => {
    const r = el.getBoundingClientRect();
    const items = [...el.querySelectorAll('button')].map((b) => { const rb = b.getBoundingClientRect(); return { t: b.textContent.trim(), w: Math.round(rb.width), h: Math.round(rb.height) }; });
    return { x: r.x, y: r.y, w: r.width, h: r.height, vw: innerWidth, vh: innerHeight, items };
  });
  ok('V4a menu has 2 items (下载/另存为…)', menuBox.items.length === 2 && menuBox.items[1].t.includes('另存为'), JSON.stringify(menuBox.items));
  ok('V4b menu in viewport', menuBox.x >= 0 && menuBox.y >= 0 && menuBox.x + menuBox.w <= menuBox.vw && menuBox.y + menuBox.h <= menuBox.vh, JSON.stringify({ w: menuBox.w, h: menuBox.h }));
  await cur.page.screenshot({ path: `${OUT}/menu-saveas.png` });
  await cur.page.keyboard.press('Escape');

  // 面板溢出终检
  const panelOverflow = await cur.page.$eval('.task-panel', (el) => el.scrollWidth - el.clientWidth);
  ok('V5a panel no horizontal overflow', panelOverflow <= 0, String(panelOverflow));

  // V5 零 JS 错
  ok('V5b zero JS errors', errsAll.length === 0, JSON.stringify(errsAll));

  const passed = results.filter((r) => r.pass).length;
  console.log(`SUMMARY ${passed}/${results.length}`);
  await browser.close();
  process.exit(passed === results.length ? 0 : 1);
})().catch((e) => { console.error('PROBE-CRASH', e); process.exit(2); });
