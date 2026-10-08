// R27 视觉复验驱动：双树（基线 ddd9d60 worktree :5184 / 当前 :5183）逐像素 +
// 新面盒测量 + 四终端配色独立呈现。零依赖：PNG 差异在空白页 canvas 里算。
// 零回归面（base/cur 同操作同外观 dark）：welcome+hostlist、addform。
// 新面（cur）：settings 外观 section、light 全页、四配色终端、tab 焦点环、640 窄窗。
const { chromium } = require('/Users/chenpu/node_modules/playwright');
const fs = require('fs');
const EXE = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const CUR = 'http://localhost:5183/';
const BASE = 'http://localhost:5184/';
const OUT = '/Users/chenpu/workspace/claude-code/TinySSH/docs/acceptance/ux-r1/g2/2026-10-08-ddd9d60-r27/vis';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  fs.mkdirSync(OUT + '/base', { recursive: true });
  fs.mkdirSync(OUT + '/cur', { recursive: true });
  const browser = await chromium.launch({ executablePath: EXE, headless: true });
  const summary = { meta: { date: '2026-10-08', baseline: 'ddd9d60(R26) worktree /tmp/vis-r27-base :5184', current: 'R27 uncommitted tree :5183', viewport: '1280x800 headless Chrome; 640x800 narrow', noise_floor: 'both-tree burst selfDiff on welcome' }, regression: {}, boxes: {}, notes: [] };

  // PNG diff helper：空白页 canvas 逐像素（RGBA 全等）
  const dctx = await browser.newContext();
  const dpage = await dctx.newPage();
  const diffPng = (b64a, b64b) => dpage.evaluate(async ({ a, b }) => {
    const load = (d) => new Promise((res) => { const i = new Image(); i.onload = () => res(i); i.src = 'data:image/png;base64,' + d; });
    const [ia, ib] = await Promise.all([load(a), load(b)]);
    if (ia.width !== ib.width || ia.height !== ib.height) return { sizeMismatch: [ia.width, ia.height, ib.width, ib.height] };
    const ca = document.createElement('canvas'); ca.width = ia.width; ca.height = ia.height;
    const cb = document.createElement('canvas'); cb.width = ib.width; cb.height = ib.height;
    const xa = ca.getContext('2d'); xa.drawImage(ia, 0, 0);
    const xb = cb.getContext('2d'); xb.drawImage(ib, 0, 0);
    const da = xa.getImageData(0, 0, ia.width, ia.height).data;
    const db = xb.getImageData(0, 0, ib.width, ib.height).data;
    let diff = 0, minX = 1e9, minY = 1e9, maxX = -1, maxY = -1;
    for (let y = 0; y < ia.height; y++) for (let x = 0; x < ia.width; x++) {
      const o = (y * ia.width + x) * 4;
      if (da[o] !== db[o] || da[o + 1] !== db[o + 1] || da[o + 2] !== db[o + 2] || da[o + 3] !== db[o + 3]) {
        diff++;
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (y < minY) minY = y; if (y > maxY) maxY = y;
      }
    }
    return { diffPx: diff, bbox: diff ? [minX, minY, maxX, maxY] : [0, 0, 0, 0] };
  }, { a: b64a, b: b64b });

  const openTree = async (url, opts = {}) => {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await ctx.newPage();
    if (opts.scheme) await page.emulateMedia({ colorScheme: opts.scheme });
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await page.evaluate(() => { try { localStorage.clear(); } catch {} });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.host-card', { timeout: 10000 });
    if (opts.forceDark) {
      // 一次性 evaluate 预置（不用 addInitScript：它会在后续每次导航重放，
      // 污染后面 system/light 镜头）；reload 后外观=dark 生效
      await page.evaluate(() => {
        localStorage.setItem('ui.v2.workspace', JSON.stringify({ schema_version: 1, chrome: 'dark', hostbar: null, terminal: null }));
      });
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.waitForSelector('.host-card', { timeout: 10000 });
    }
    await sleep(900);
    return { ctx, page };
  };
  const shot = (page, path) => page.screenshot({ path }).then(() => fs.readFileSync(path).toString('base64'));

  // ============ 零回归面：base vs cur（同外观 dark）============
  const B = await openTree(BASE);
  const C = await openTree(CUR, { forceDark: true });

  // welcome+hostlist
  const b1 = await shot(B.page, OUT + '/base/welcome.png');
  const c1 = await shot(C.page, OUT + '/cur/welcome.png');
  const selfB1 = await shot(B.page, OUT + '/base/welcome-self.png');
  summary.regression.welcome = { ...(await diffPng(b1, c1)), selfDiff: (await diffPng(b1, selfB1)).diffPx };
  // addform（点开添加主机表单）
  const openAdd = (page) => page.evaluate(() => {
    const btn = [...document.querySelectorAll('button')].find((b) => b.getAttribute('aria-label') === '添加主机' || b.textContent.trim() === '添加主机');
    btn?.click();
    return !!btn;
  });
  summary.boxes.addBtnFound = { base: await openAdd(B.page), cur: await openAdd(C.page) };
  await sleep(500);
  const b2 = await shot(B.page, OUT + '/base/addform.png');
  const c2 = await shot(C.page, OUT + '/cur/addform.png');
  summary.regression.addform = await diffPng(b2, c2);

  // ============ 新面（cur）============
  // settings dark：外观 section + 终端配色 + 字号默认
  await C.page.click('.hb-settings');
  await C.page.waitForSelector('.term-settings', { timeout: 4000 });
  await sleep(400);
  await shot(C.page, OUT + '/cur/settings-dark.png');
  summary.boxes.settingsDark = await C.page.evaluate(() => {
    const panel = document.querySelector('.term-settings');
    const pr = panel.getBoundingClientRect();
    const groups = [...panel.querySelectorAll('[role="group"]')].map((g) => {
      const r = g.getBoundingClientRect();
      const btns = [...g.querySelectorAll('button')].map((b) => { const br = b.getBoundingClientRect(); return [Math.round(br.x - pr.x), Math.round(br.y - pr.y), Math.round(br.width), Math.round(br.height)]; });
      return { label: g.getAttribute('aria-label'), rel: [Math.round(r.x - pr.x), Math.round(r.y - pr.y), Math.round(r.width), Math.round(r.height)], btns, overlap: btns.some((a, i) => btns.slice(i + 1).some((o) => a[0] < o[0] + o[2] && o[0] < a[0] + a[2] && a[1] < o[1] + o[3] && o[1] < a[1] + a[3])) };
    });
    const fontVal = panel.querySelector('.ts-val')?.textContent?.trim();
    const palette = [...panel.querySelectorAll('.ts-opt')].map((b) => { const r = b.getBoundingClientRect(); return [Math.round(r.x - pr.x), Math.round(r.y - pr.y), Math.round(r.width), Math.round(r.height)]; });
    return { panel: [Math.round(pr.width), Math.round(pr.height)], overflowX: panel.scrollWidth > panel.clientWidth + 1, fontVal, groups, palette };
  });
  // settings light（同一面板，切外观浅色）
  await C.page.evaluate(() => {
    const g = document.querySelector('[role="group"][aria-label="应用外观"]');
    [...g.querySelectorAll('button')].find((b) => b.textContent === '浅色')?.click();
  });
  await sleep(400);
  await shot(C.page, OUT + '/cur/settings-light.png');
  summary.boxes.settingsLightOverflow = await C.page.evaluate(() => {
    const panel = document.querySelector('.term-settings');
    return panel.scrollWidth > panel.clientWidth + 1;
  });
  await C.page.keyboard.press('Escape');
  await sleep(300);

  // 全页 light（system 解析路径：清存储 → reload → emulateMedia light）
  await C.page.evaluate(() => { try { localStorage.clear(); } catch {} });
  await C.page.emulateMedia({ colorScheme: 'light' });
  await C.page.reload({ waitUntil: 'domcontentloaded' });
  await C.page.waitForSelector('.host-card', { timeout: 10000 });
  await sleep(900);
  const sysChrome = await C.page.evaluate(() => document.documentElement.dataset.chrome ?? null);
  summary.boxes.systemLightChrome = sysChrome;
  await shot(C.page, OUT + '/cur/welcome-light-system.png');

  // tab 焦点环 + tab 视觉盒（dark 下建连 prod-1 → 键盘聚焦 tab-x）
  await C.page.emulateMedia({ colorScheme: 'dark' });
  await C.page.evaluate(() => {
    const card = [...document.querySelectorAll('.host-card')].find((c) => c.querySelector('.host-name')?.textContent.includes('prod-1'));
    card?.querySelector('.host-connect-btn')?.click();
  });
  await sleep(1800);
  const tabBoxes = await C.page.evaluate(() => {
    const tab = document.querySelector('.tabbar .tab');
    if (!tab) return null;
    const x = tab.querySelector('.tab-x'), sp = tab.querySelector('.tab-split');
    const r = (el) => { const b = el.getBoundingClientRect(); return [Math.round(b.width), Math.round(b.height)]; };
    return { tab: r(tab), tabX: r(x), tabSplit: r(sp) };
  });
  summary.boxes.tabControls = tabBoxes;
  await C.page.evaluate(() => {
    const t = [...document.querySelectorAll('.tabbar .tab')].find((x) => x.textContent.includes('prod-1'));
    t?.focus();
  });
  await sleep(200);
  await C.page.locator('.tabbar-row').screenshot({ path: OUT + '/cur/tabbar-focus.png' });

  // 四终端配色独立呈现（终端区截图两两不同 = ANSI 调色板独立可见）
  const palIds = [];
  for (const name of ['深色', '浅色', 'Solarized 深色', 'Solarized 浅色']) {
    await C.page.click('.hb-settings');
    await C.page.waitForSelector('.term-settings', { timeout: 4000 });
    await C.page.evaluate((n) => {
      [...document.querySelectorAll('.ts-opt')].find((b) => b.textContent.includes(n))?.click();
    }, name);
    await C.page.keyboard.press('Escape');
    await sleep(450);
    const p = OUT + '/cur/palette-' + name.replace(/\s+/g, '') + '.png';
    await C.page.locator('.term-session.active').screenshot({ path: p });
    palIds.push(fs.readFileSync(p).toString('base64'));
  }
  const palDiff = {};
  const palNames = ['dark', 'light', 'solar-dark', 'solar-light'];
  for (let i = 0; i < palIds.length; i++) for (let j = i + 1; j < palIds.length; j++) {
    palDiff[palNames[i] + '|' + palNames[j]] = (await diffPng(palIds[i], palIds[j])).diffPx;
  }
  summary.boxes.palettePairwiseDiffPx = palDiff;

  // 640 窄窗：settings dark 不破版
  await C.page.setViewportSize({ width: 640, height: 800 });
  await sleep(400);
  await C.page.click('.hb-settings');
  await C.page.waitForSelector('.term-settings', { timeout: 4000 });
  await sleep(300);
  summary.boxes.settings640 = await C.page.evaluate(() => {
    const panel = document.querySelector('.term-settings');
    const r = panel.getBoundingClientRect();
    return { w: Math.round(r.width), overflowX: panel.scrollWidth > panel.clientWidth + 1, inViewport: r.right <= 641 };
  });
  await C.page.screenshot({ path: OUT + '/cur/settings-640.png' });

  // 终止状态
  summary.notes.push('cur forceDark 面经一次性 evaluate 预置 blob chrome=dark + reload（方法学登记：base 无外观概念、默认 dark；等效状态对齐；后续 system/light 镜头前已清存储，不受预置影响）');
  fs.writeFileSync(OUT + '/r27-vis-summary.json', JSON.stringify(summary, null, 1));
  console.log(JSON.stringify(summary.regression, null, 1));
  console.log('BOXES ' + JSON.stringify(summary.boxes));
  await browser.close();
})();
