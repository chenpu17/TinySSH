// R31 视觉自检（文件面板新面）：
// V1 欢迎页双树逐像素（ef8c529 基线 :5184 vs 当前 :5183，统一深色）= 未触碰面零回归；
// V2 面板新面盒测量：导航行 6 钮零截断/面包屑盒/工具行/列表行零横向溢出；
// V3 选中态视觉：sel 行高亮 + selbar 盒测量 + 双击动作菜单盒测量；
// V4 分屏×面板 tp-full 截图 + 关面板恢复；
// V5 极窄窗列收起（时间列隐藏）不破版；
// V6 零 JS 错。
const { chromium } = require('/Users/chenpu/node_modules/playwright');
const EXE = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const results = [];
const ok = (name, cond, detail = '') => { results.push({ name, pass: !!cond }); console.log((cond ? 'PASS ' : 'FAIL ') + name + (detail ? '  [' + detail + ']' : '')); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const OUT = '/tmp/r31-vis';
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

  // V1 欢迎页双树
  const cur = await newPage('http://localhost:5183/');
  const base = await newPage('http://localhost:5184/');
  await cur.page.screenshot({ path: `${OUT}/welcome-cur.png` });
  await base.page.screenshot({ path: `${OUT}/welcome-base.png` });
  await cur.page.screenshot({ path: `${OUT}/welcome-cur2.png` });
  const noise = await pixelDiff(`${OUT}/welcome-cur.png`, `${OUT}/welcome-cur2.png`);
  const wd = await pixelDiff(`${OUT}/welcome-base.png`, `${OUT}/welcome-cur.png`);
  ok('V1 welcome diff within noise floor', wd <= Math.max(noise, 3), `diff_px=${wd} noise=${noise}`);

  // 面板新面
  const page = cur.page;
  await page.evaluate(() => {
    const card = [...document.querySelectorAll('.host-card')].find((c) => c.querySelector('.host-name')?.textContent.includes('prod-1'));
    card?.querySelector('.host-connect-btn')?.click();
  });
  await page.waitForSelector('.hk-mask', { timeout: 6000 }).catch(() => {});
  await page.evaluate(() => { [...document.querySelectorAll('.hk-mask button')].find((x) => x.textContent.includes('信任并连接'))?.click(); });
  await sleep(1500);
  await page.evaluate(() => document.querySelector('.st-file')?.click());
  await page.waitForSelector('[data-testid="sftp-list"]', { timeout: 5000 });
  await sleep(600);

  // V2 盒测量：导航行按钮完整、面包屑盒、工具行、行零溢出
  // clipped 用 Range 实测内容宽（::after 命中区扩展 inset-5px 会虚增 scrollWidth，R27 工艺伪影）
  const navBtns = await page.$$eval('.sftp-nav button', (bs) => bs.map((b) => {
    const rg = document.createRange(); rg.selectNodeContents(b);
    return { t: b.title || b.ariaLabel, w: b.offsetWidth, clipped: rg.getBoundingClientRect().width > b.clientWidth + 1 };
  }));
  ok('V2a nav buttons all visible & unclipped', navBtns.length === 6 && navBtns.every((b) => b.w >= 24 && !b.clipped), JSON.stringify(navBtns.map((b) => b.w)));
  const crumbsBox = await page.$eval('[data-testid="sftp-crumbs"]', (el) => ({ w: el.clientWidth, sw: el.scrollWidth, h: el.offsetHeight }));
  ok('V2b breadcrumb box renders', crumbsBox.h >= 24 && crumbsBox.w > 100, JSON.stringify(crumbsBox));
  const toolBtns = await page.$$eval('.sftp-tools button', (bs) => bs.map((b) => {
    const rg = document.createRange(); rg.selectNodeContents(b);
    return { t: b.textContent, clipped: rg.getBoundingClientRect().width > b.clientWidth + 1 };
  }));
  ok('V2c tools row unclipped', toolBtns.length === 4 && toolBtns.every((b) => !b.clipped), JSON.stringify(toolBtns));
  const overflow = await page.$eval('.task-panel', (el) => el.scrollWidth - el.clientWidth);
  ok('V2d panel no horizontal overflow', overflow <= 0, String(overflow));

  // V3 选中态 + 动作菜单
  await page.click('[data-testid="sftp-list"] .sftp-row[data-name="access.log"]');
  await page.keyboard.down('Meta');
  await page.click('[data-testid="sftp-list"] .sftp-row[data-name="error.log"]');
  await page.keyboard.up('Meta');
  await sleep(200);
  const sel = await page.$$eval('.sftp-list .sftp-row.sel', (rs) => rs.length);
  ok('V3a two rows highlighted', sel === 2, String(sel));
  const selBox = await page.$eval('[data-testid="sftp-selbar"]', (el) => ({ w: el.clientWidth, h: el.offsetHeight }));
  ok('V3b selbar box sane', selBox.w > 120 && selBox.h >= 24, JSON.stringify(selBox));
  await page.screenshot({ path: `${OUT}/panel-selected.png` });
  await page.dblclick('[data-testid="sftp-list"] .sftp-row[data-name="php-fpm.sock"] .sftp-name');
  await page.waitForSelector('[data-testid="sftp-menu"]', { timeout: 3000 });
  const menuBox = await page.$eval('[data-testid="sftp-menu"]', (el) => {
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height, inVp: r.x >= 0 && r.y >= 0 && r.right <= innerWidth && r.bottom <= innerHeight };
  });
  ok('V3c actions menu in viewport', menuBox.w > 100 && menuBox.inVp, JSON.stringify(menuBox));
  await page.keyboard.press('Escape');
  await sleep(150);

  // V4 分屏 × 面板 → tp-full
  await page.evaluate(() => { [...document.querySelectorAll('button')].find((b) => (b.title || '').includes('分屏'))?.click(); });
  await sleep(400);
  await page.evaluate(() => { [...document.querySelectorAll('.split-menu .sm-item')].find((b) => b.textContent.includes('staging-1'))?.click(); });
  await sleep(800);
  const isFull = await page.$eval('.task-panel', (el) => el.classList.contains('tp-full'));
  ok('V4a split forces full view', isFull);
  await page.screenshot({ path: `${OUT}/split-fullview.png` });
  const overflowFull = await page.$eval('.task-panel', (el) => el.scrollWidth - el.clientWidth);
  ok('V4b full view no overflow', overflowFull <= 0, String(overflowFull));
  await page.evaluate(() => document.querySelector('.tp-head button[aria-label="关闭任务面板"]')?.click());
  await sleep(300);
  const panes = await page.$$eval('.term-session.pane-left, .term-session.pane-right', (els) => els.length);
  ok('V4c split restored after close', panes === 2, String(panes));
  await page.evaluate(() => { [...document.querySelectorAll('button')].find((b) => (b.title || '').includes('退出分屏'))?.click(); });
  await sleep(300);

  // V5 极窄窗列收起（V4c 关过面板，重开）
  await page.evaluate(() => document.querySelector('.st-file')?.click());
  await page.waitForSelector('[data-testid="sftp-list"]', { timeout: 5000 });
  await sleep(400);
  await page.setViewportSize({ width: 360, height: 700 });
  await sleep(500);
  const timeHidden = await page.$eval('[data-testid="sftp-list"] .sftp-time', (el) => getComputedStyle(el).display === 'none');
  const nameVisible = await page.$eval('[data-testid="sftp-list"] .sftp-name', (el) => el.offsetWidth > 60);
  ok('V5a 360: time hidden, name readable', timeHidden && nameVisible);
  await page.screenshot({ path: `${OUT}/narrow-360.png` });
  await page.setViewportSize({ width: 1280, height: 800 });
  await sleep(400);

  ok('V6 zero JS errors', cur.errs.length === 0, cur.errs.slice(0, 2).join('|'));
  const pass = results.filter((x) => x.pass).length;
  console.log(`SUMMARY ${pass}/${results.length}`);
  await browser.close();
  process.exit(pass === results.length ? 0 : 1);
})().catch((e) => { console.error('PROBE-ERROR', e); process.exit(2); });
