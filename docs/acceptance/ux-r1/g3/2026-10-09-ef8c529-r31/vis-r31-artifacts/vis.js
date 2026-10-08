// vis-r31 独立视觉复验探针（rev:独立方法学，非作者脚本）
// 方法学：context 级 colorScheme=dark（走产品解析路径）、deviceScaleFactor=1、
// 像素 diff 在浏览器内 canvas ImageData 逐通道比较、噪声底=同树两次全新实例自差。
const { chromium } = require('/Users/chenpu/node_modules/playwright');
const fs = require('fs');

const OUT = '/tmp/vis-r31';
const CUR = 'http://localhost:5183/';
const BASE = 'http://localhost:5184/';
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

let pass = 0, fail = 0;
const P = (ok, label, extra) => { console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}${extra ? ' — ' + extra : ''}`); ok ? pass++ : fail++; };
const I = (label, extra) => console.log(`[INFO] ${label}${extra ? ' — ' + extra : ''}`);

const errors = []; // pageerror 收集（跨全部页面）

function watch(page, tag) {
  page.on('pageerror', (e) => errors.push({ tag, msg: String(e) }));
  page.on('console', (m) => { if (m.type() === 'error') errors.push({ tag, console: m.text() }); });
}

async function newPage(browser, url, vp) {
  const ctx = await browser.newContext({ colorScheme: 'dark', viewport: vp || { width: 1280, height: 800 }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  watch(page, url);
  await page.goto(url, { waitUntil: 'networkidle' });
  await page.waitForTimeout(700); // 字体/动画沉降
  return { ctx, page };
}

// 像素 diff：在空白页里用 canvas 比较（零额外依赖）
async function diffPngs(cmpPage, bufA, bufB) {
  const a = 'data:image/png;base64,' + bufA.toString('base64');
  const b = 'data:image/png;base64,' + bufB.toString('base64');
  return await cmpPage.evaluate(async ([a, b]) => {
    const load = (src) => new Promise((res, rej) => { const im = new Image(); im.onload = () => res(im); im.onerror = () => rej(new Error('img load fail')); im.src = src; });
    const [ia, ib] = await Promise.all([load(a), load(b)]);
    if (ia.width !== ib.width || ia.height !== ib.height) return { mismatch: `${ia.width}x${ia.height} vs ${ib.width}x${ib.height}` };
    const cv = document.createElement('canvas'); cv.width = ia.width; cv.height = ia.height;
    const cx = cv.getContext('2d', { willReadFrequently: true });
    const grab = (im) => { cx.clearRect(0, 0, cv.width, cv.height); cx.drawImage(im, 0, 0); return cx.getImageData(0, 0, cv.width, cv.height).data; };
    const da = grab(ia), db = grab(ib);
    let any = 0, vis = 0, maxD = 0, sum = 0;
    const hot = [];
    for (let i = 0; i < da.length; i += 4) {
      const d = Math.max(Math.abs(da[i] - db[i]), Math.abs(da[i + 1] - db[i + 1]), Math.abs(da[i + 2] - db[i + 2]));
      if (d > 0) { any++; sum += d; if (d > maxD) maxD = d; if (d > 8) { vis++; if (hot.length < 3) hot.push({ px: i >> 2, x: (i >> 2) % cv.width, y: Math.floor((i >> 2) / cv.width), d }); } }
    }
    return { w: cv.width, h: cv.height, total: (cv.width * cv.height), strictAny: any, visGt8: vis, maxD, meanD: any ? +(sum / any).toFixed(2) : 0, hot };
  }, [a, b]);
}

async function connectProd1(page) {
  // 主机卡中心被 hover 操作组（fav/edit/del/连接）覆盖（既有工艺，误触星标）——
  // 改走应用指引的「点击上方标签」附上路径
  await page.waitForSelector('.host-card', { timeout: 15000 });
  await page.waitForTimeout(1000);
  await page.locator('.tab', { hasText: 'prod-1' }).first().click();
  await page.waitForTimeout(500);
  const trust = page.locator('button:has-text("信任并连接")');
  if (await trust.count()) { await trust.first().click().catch(() => {}); await page.waitForTimeout(400); }
  await page.waitForSelector('.tab-active', { timeout: 10000 });
  await page.waitForTimeout(400);
}

async function openFilesPanel(page) {
  await page.locator('.st-file').click();
  await page.waitForSelector('.task-panel', { timeout: 5000 });
  // 首载链：brief → resolve → list（/var/log/nginx）
  await page.waitForSelector('.task-panel .sftp-row', { timeout: 12000 });
  await page.waitForTimeout(350);
}

const boxOf = (el) => { const r = el.getBoundingClientRect(); return { x: +r.x.toFixed(1), y: +r.y.toFixed(1), w: +r.width.toFixed(1), h: +r.height.toFixed(1) }; };

(async () => {
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  // 供像素 diff 用的空白页
  const cmpCtx = await browser.newContext();
  const cmpPage = await cmpCtx.newPage();

  // ============ Phase A：welcome 双树逐像素 ============
  console.log('== Phase A: welcome 零回归（1280, dark, dsf=1） ==');
  const A = await newPage(browser, CUR);
  const B1 = await newPage(browser, BASE);
  const B2 = await newPage(browser, BASE);
  const C1 = await newPage(browser, CUR);
  for (const { page } of [A, B1, B2, C1]) await page.waitForSelector('.welcome-box', { timeout: 15000 });
  await A.page.waitForTimeout(500); await B1.page.waitForTimeout(500); await B2.page.waitForTimeout(500); await C1.page.waitForTimeout(500);
  const shotA = await A.page.screenshot(); const shotB1 = await B1.page.screenshot(); const shotB2 = await B2.page.screenshot(); const shotA2 = await C1.page.screenshot();
  fs.writeFileSync(`${OUT}/a-5183.png`, shotA); fs.writeFileSync(`${OUT}/a-5184-r1.png`, shotB1); fs.writeFileSync(`${OUT}/a-5184-r2.png`, shotB2); fs.writeFileSync(`${OUT}/a-5183-r2.png`, shotA2);

  const nf = await diffPngs(cmpPage, shotB1, shotB2);
  P(nf.strictAny < 1000, 'A0 基线自差噪声底可忽略（<0.1% 像素）', `strictAny=${nf.strictAny}/${nf.total} visGt8=${nf.visGt8} maxD=${nf.maxD}`);
  const nfCur = await diffPngs(cmpPage, shotA, shotA2);
  I('当前树自差噪声底（5183 vs 5183）', `strictAny=${nfCur.strictAny} maxD=${nfCur.maxD}`);
  const dAB = await diffPngs(cmpPage, shotA, shotB1);
  P(!dAB.mismatch && dAB.strictAny <= nf.strictAny && dAB.maxD <= nf.maxD, 'A1 welcome 双树逐像素（判据=双树差落在同树自差噪声包络内）',
    dAB.mismatch ? `尺寸不一致 ${dAB.mismatch}` : `strictAny=${dAB.strictAny}/${dAB.total} maxD=${dAB.maxD}（噪声底 strictAny=${nf.strictAny} maxD=${nf.maxD}） hot=${JSON.stringify(dAB.hot)}`);
  await A.ctx.close(); await B1.ctx.close(); await B2.ctx.close(); await C1.ctx.close();

  // ============ Phase B：1280 侧板新面盒测量 ============
  console.log('== Phase B: 1280 侧板面板盒测量（真实点击链） ==');
  const S = await newPage(browser, CUR);
  await connectProd1(S.page);
  await openFilesPanel(S.page);

  const mB = await S.page.evaluate(() => {
    const q = (s) => document.querySelector(s);
    const qa = (s) => [...document.querySelectorAll(s)];
    const panel = q('.task-panel');
    const pr = panel.getBoundingClientRect();
    const navBtns = qa('.sftp-nav button').map((b) => { const r = b.getBoundingClientRect(); return { w: +r.width.toFixed(1), h: +r.height.toFixed(1), x: r.x, y: r.y, trunc: b.scrollWidth > b.clientWidth + 1, disabled: b.disabled }; });
    const crumbs = q('[data-testid="sftp-crumbs"]');
    const cr = crumbs ? crumbs.getBoundingClientRect() : null;
    const crSegs = qa('.sftp-crumb').map((c) => ({ t: c.textContent, cur: c.classList.contains('cur') }));
    const tools = qa('.sftp-tools input, .sftp-tools button').map((b) => { const r = b.getBoundingClientRect(); return { tag: b.tagName, t: (b.value || b.textContent || '').slice(0, 8), w: +r.width.toFixed(1), h: +r.height.toFixed(1), trunc: b.scrollWidth > b.clientWidth + 1 }; });
    const rows = qa('.task-panel .sftp-row').map((r) => +r.getBoundingClientRect().height.toFixed(1));
    const doc = document.documentElement;
    return {
      tpFull: panel.classList.contains('tp-full'),
      panel: { w: +pr.width.toFixed(1), x: +pr.x.toFixed(1) },
      navCount: navBtns.length, navBtns,
      navDisabled: navBtns.map((b) => b.disabled),
      crumbs: cr ? { w: +cr.width.toFixed(1), h: +cr.height.toFixed(1), scrollW: crumbs.scrollWidth, clientW: crumbs.clientWidth } : null,
      crSegs,
      toolsCount: tools.length, tools,
      rowCount: rows.length, rowH: rows,
      panelOverflowX: panel.scrollWidth > panel.clientWidth,
      secEl: q('.task-panel .section') ? { sw: q('.task-panel .section').scrollWidth, cw: q('.task-panel .section').clientWidth } : null,
      docOverflow: doc.scrollWidth > window.innerWidth,
      innerW: window.innerWidth,
    };
  });
  P(mB.tpFull === false, 'B1 1280 侧板形态=非 tp-full', `tp-full=${mB.tpFull}`);
  P(mB.navCount === 6, 'B2 导航行六钮齐', `count=${mB.navCount}`);
  const hs = mB.navBtns.map((b) => b.h);
  P(Math.max(...hs) - Math.min(...hs) <= 1, 'B3 六钮等高(±1px)', `hs=[${hs.join(',')}]`);
  P(mB.navBtns.every((b) => !b.trunc), 'B4 六钮零截断', `trunc=${mB.navBtns.filter((b) => b.trunc).length}`);
  P(mB.navBtns.every((b) => b.x >= mB.panel.x - 1 && b.x + b.w <= mB.panel.x + mB.panel.w + 1), 'B5 六钮均在面板内', `panel.x=${mB.panel.x} w=${mB.panel.w}`);
  I('B-obs 导航钮禁用态（返回/前进应为禁用——首载无历史）', JSON.stringify(mB.navDisabled));
  P(mB.crumbs && mB.crumbs.h >= 26 && mB.crumbs.h < 40, 'B6 面包屑盒完整', JSON.stringify(mB.crumbs));
  P(mB.crSegs.length >= 4 && mB.crSegs[mB.crSegs.length - 1].cur, 'B7 面包屑段=路径深度+当前段高亮', JSON.stringify(mB.crSegs));
  P(mB.toolsCount === 5, 'B8 工具行五控件（筛选+隐藏项+三排序）', `count=${mB.toolsCount}`);
  P(mB.tools.every((t) => !t.trunc), 'B9 工具行零截断', JSON.stringify(mB.tools));
  const tHs = mB.tools.slice(1).map((t) => t.h);
  P(Math.max(...tHs) - Math.min(...tHs) <= 1, 'B10 工具行四钮等高(±1px)', `hs=[${tHs.join(',')}]`);
  const rowHUniq = [...new Set(mB.rowH)];
  I('B11a 行高分布（记录用——严格一致性交由 B11 跨树同构判定）', `rowH=${[...new Set(mB.rowH)].join(',')} n=${mB.rowCount}`);
  // 跨树同构：同目录同名行与基线行高差 ≤2px（基线本就不均：26/31/30——随是否含下载钮而变）
  const B = await newPage(browser, BASE);
  await connectProd1(B.page);
  await openFilesPanel(B.page);
  const baseRows = await B.page.evaluate(() => Object.fromEntries([...document.querySelectorAll('.task-panel .sftp-row')].map((r) => [r.querySelector('.sftp-name')?.textContent, +r.getBoundingClientRect().height.toFixed(1)])));
  const curRows = await S.page.evaluate(() => Object.fromEntries([...document.querySelectorAll('.task-panel .sftp-row')].map((r) => [r.querySelector('.sftp-name')?.textContent, +r.getBoundingClientRect().height.toFixed(1)])));
  const common = Object.keys(curRows).filter((k) => k in baseRows);
  const deltas = common.map((k) => ({ k, d: +(curRows[k] - baseRows[k]).toFixed(1) }));
  P(common.length >= 2 && deltas.every((x) => Math.abs(x.d) <= 2), 'B11 行高与基线同构（同名行差 ≤2px）', `Δ=${JSON.stringify(deltas)}（基线自身 rowH 不均=${Object.values(baseRows).join('/')}——既有特征非本轮引入）`);
  await B.ctx.close();
  P(!mB.panelOverflowX && !mB.docOverflow, 'B12 面板与文档级零横向溢出', `panelOv=${mB.panelOverflowX} docOv=${mB.docOverflow} innerW=${mB.innerW}`);
  I('B-obs section scrollWidth/clientWidth', JSON.stringify(mB.secEl));
  const panelBox = await S.page.locator('.task-panel').boundingBox();
  await S.page.screenshot({ path: `${OUT}/b-panel-1280-full.png` });
  await S.page.screenshot({ path: `${OUT}/b-panel-clip.png`, clip: panelBox });

  // ============ Phase C：选中/选择条/菜单/键盘光标 ============
  console.log('== Phase C: 选中/菜单/键盘光标 ==');
  const rows = S.page.locator('[data-testid="sftp-list"] .sftp-row');
  const nRows = await rows.count();
  P(nRows >= 4, 'C0 列表行数充足', `n=${nRows}`);
  // 单击选中
  await rows.nth(0).click();
  await S.page.waitForTimeout(120);
  const sel1 = await S.page.evaluate(() => {
    const r = document.querySelectorAll('[data-testid="sftp-list"] .sftp-row');
    const sel = [...r].filter((x) => x.classList.contains('sel'));
    const plain = [...r].find((x) => !x.classList.contains('sel'));
    return { selN: sel.length, selBg: sel[0] ? getComputedStyle(sel[0]).backgroundColor : null, plainBg: plain ? getComputedStyle(plain).backgroundColor : null, cursorIdx: [...r].findIndex((x) => x.classList.contains('cursor')) };
  });
  P(sel1.selN === 1 && sel1.selBg !== sel1.plainBg, 'C1 单选高亮可见（背景色≠未选行）', `selN=${sel1.selN} sel=${sel1.selBg} plain=${sel1.plainBg}`);
  // ⌘ 多选
  await rows.nth(2).click({ modifiers: ['Meta'] });
  await S.page.waitForTimeout(120);
  const selbar = await S.page.evaluate(() => {
    const sb = document.querySelector('[data-testid="sftp-selbar"]');
    const sel = document.querySelectorAll('[data-testid="sftp-list"] .sftp-row.sel');
    if (!sb) return { sb: null, selN: sel.length };
    const r = sb.getBoundingClientRect();
    const btns = [...sb.querySelectorAll('button')].map((b) => { const br = b.getBoundingClientRect(); return { t: b.textContent.trim(), w: +br.width.toFixed(1), h: +br.height.toFixed(1) }; });
    return { sb: { text: sb.textContent.trim().slice(0, 24), x: +r.x.toFixed(1), y: +r.y.toFixed(1), w: +r.width.toFixed(1), h: +r.height.toFixed(1) }, selN: sel.length, btns };
  });
  P(selbar.selN === 2 && selbar.sb && /已选 2 项/.test(selbar.sb.text), 'C2 ⌘ 多选=2 且选择条文案', `selN=${selbar.selN} text=${selbar.sb && selbar.sb.text}`);
  if (selbar.sb) {
    P(selbar.sb.x >= 0 && selbar.sb.y >= 0 && selbar.sb.x + selbar.sb.w <= 1280 && selbar.sb.y + selbar.sb.h <= 800, 'C3 选择条完整在视口内', JSON.stringify(selbar.sb));
    P(selbar.btns.length === 2 && selbar.btns.every((b) => b.w >= 16 && b.h >= 16), 'C4 选择条钮可见完整（下载所选/✕）', JSON.stringify(selbar.btns));
  }
  await S.page.screenshot({ path: `${OUT}/c-sel-multi.png` });
  // Shift 范围选
  await rows.nth(0).click();
  await rows.nth(3).click({ modifiers: ['Shift'] });
  await S.page.waitForTimeout(120);
  const shiftN = await S.page.evaluate(() => document.querySelectorAll('[data-testid="sftp-list"] .sftp-row.sel').length);
  P(shiftN === 4, 'C5 Shift 范围选=4', `n=${shiftN}`);
  // 清除选择
  await S.page.locator('[data-testid="sftp-selbar"] button[aria-label="清除选择"]').click();
  await S.page.waitForTimeout(100);
  const afterClear = await S.page.evaluate(() => ({ sel: document.querySelectorAll('[data-testid="sftp-list"] .sftp-row.sel').length, bar: !!document.querySelector('[data-testid="sftp-selbar"]') }));
  P(afterClear.sel === 0 && !afterClear.bar, 'C6 清除选择后条消失', JSON.stringify(afterClear));
  // 双击文件→动作菜单（挑非目录非链接行）
  const fileIdx = await S.page.evaluate(() => {
    const rs = [...document.querySelectorAll('[data-testid="sftp-list"] .sftp-row')];
    return rs.findIndex((r) => !r.classList.contains('dir') && r.querySelector('.sftp-size')?.textContent !== '链接');
  });
  P(fileIdx >= 0, 'C7 存在可双击文件行', `idx=${fileIdx}`);
  const trg = await rows.nth(fileIdx).boundingBox();
  await rows.nth(fileIdx).dblclick();
  await S.page.waitForTimeout(150);
  const menu = await S.page.evaluate(() => {
    const mn = document.querySelector('[data-testid="sftp-menu"]');
    if (!mn) return null;
    const r = mn.getBoundingClientRect();
    return { x: +r.x.toFixed(1), y: +r.y.toFixed(1), w: +r.width.toFixed(1), h: +r.height.toFixed(1), title: mn.querySelector('.sftp-menu-title')?.textContent, btns: [...mn.querySelectorAll('button')].map((b) => b.textContent.trim()) };
  });
  P(!!menu, 'C8 双击文件弹动作菜单', menu ? `title=${menu.title} btns=${menu.btns.join('/')}` : '菜单未出现');
  if (menu) {
    P(menu.x >= 0 && menu.y >= 0 && menu.x + menu.w <= 1280 && menu.y + menu.h <= 800, 'C9 菜单不越视口', JSON.stringify(menu));
    const coverFrac = Math.max(0, Math.min(menu.y + menu.h, trg.y + trg.height) - Math.max(menu.y, trg.y)) * Math.max(0, Math.min(menu.x + menu.w, trg.x + trg.width) - Math.max(menu.x, trg.x)) / (trg.width * trg.height);
    I('C-obs 菜单与触发行重叠比（光标处弹出的 context-menu 语义）', `${(coverFrac * 100).toFixed(0)}%  trg=${JSON.stringify(trg)}`);
    await S.page.screenshot({ path: `${OUT}/c-menu.png` });
    // Esc 关
    await S.page.keyboard.press('Escape');
    await S.page.waitForTimeout(120);
    P(await S.page.locator('[data-testid="sftp-menu"]').count() === 0, 'C10 Esc 关菜单');
    // 点外关
    await rows.nth(fileIdx).dblclick(); await S.page.waitForTimeout(120);
    await S.page.mouse.click(300, 300); await S.page.waitForTimeout(120);
    P(await S.page.locator('[data-testid="sftp-menu"]').count() === 0, 'C11 点外关菜单');
  }
  // 键盘光标：点行 0（cursor=0）→ 焦点列表 → ArrowDown → cursor=1 outline 可见
  await rows.nth(0).click();
  await S.page.locator('[data-testid="sftp-list"]').focus();
  await S.page.keyboard.press('ArrowDown');
  await S.page.waitForTimeout(150);
  const cur = await S.page.evaluate(() => {
    const rs = [...document.querySelectorAll('[data-testid="sftp-list"] .sftp-row')];
    const i = rs.findIndex((x) => x.classList.contains('cursor'));
    if (i < 0) return null;
    const cs = getComputedStyle(rs[i]);
    return { idx: i, ow: cs.outlineWidth, os: cs.outlineStyle, oc: cs.outlineColor, dataIdx: rs[i].dataset.idx };
  });
  P(!!cur && cur.idx === 1 && cur.os !== 'none' && parseFloat(cur.ow) > 0, 'C12 键盘光标 outline 可见（ArrowDown 后 idx=1）', cur ? `idx=${cur.idx} ${cur.os} ${cur.ow} ${cur.oc} dataIdx=${cur.dataIdx}` : '无 cursor 行');
  const listBox = await S.page.locator('[data-testid="sftp-list"]').boundingBox();
  await S.page.screenshot({ path: `${OUT}/c-cursor.png`, clip: listBox });
  // Space 切换选中
  await S.page.keyboard.press('Space');
  await S.page.waitForTimeout(120);
  const spSel = await S.page.evaluate(() => ({ sel: document.querySelectorAll('[data-testid="sftp-list"] .sftp-row.sel').length, bar: document.querySelector('[data-testid="sftp-selbar"]')?.textContent.trim().slice(0, 12) }));
  P(spSel.sel >= 1 && !!spSel.bar, 'C13 Space 切换选中+选择条', JSON.stringify(spSel));
  // 排序钮：名称升→降——目录恒在前（排序规则），翻转要看文件区行序
  const namesBefore = await S.page.evaluate(() => [...document.querySelectorAll('[data-testid="sftp-list"] .sftp-row')].map((r) => ({ n: r.querySelector('.sftp-name')?.textContent, d: r.classList.contains('dir') })));
  await S.page.locator('.sftp-tools button', { hasText: '名称' }).click();
  await S.page.waitForTimeout(150);
  const sortState = await S.page.evaluate(() => {
    const btn = [...document.querySelectorAll('.sftp-tools button')].find((b) => b.textContent.includes('名称'));
    return { label: btn.textContent, pressed: btn.getAttribute('aria-pressed'), names: [...document.querySelectorAll('[data-testid="sftp-list"] .sftp-row')].map((r) => ({ n: r.querySelector('.sftp-name')?.textContent, d: r.classList.contains('dir') })) };
  });
  const filesBefore = namesBefore.filter((x) => !x.d).map((x) => x.n).join(',');
  const filesAfter = sortState.names.filter((x) => !x.d).map((x) => x.n).join(',');
  const dirsFirst = sortState.names.every((x, i, a) => !x.d || a.slice(i + 1).every((y) => !y.d));
  P(sortState.pressed === 'true' && sortState.label.includes('↓') && filesAfter !== filesBefore && filesAfter === filesBefore.split(',').reverse().join(',') && dirsFirst, 'C14 排序钮点击→降序+文件区翻转+目录恒在前', `files ${filesBefore} → ${filesAfter} dirsFirst=${dirsFirst}`);
  await S.page.locator('.sftp-tools button', { hasText: '名称' }).click(); // 还原升序
  await S.page.waitForTimeout(120);

  // ============ Phase D：分屏 × 面板 ============
  console.log('== Phase D: 分屏时面板 tp-full ==');
  // Phase C 结束时面板仍开——先关（.st-file 再点=关闭语义）
  await S.page.locator('button[aria-label="关闭任务面板"]').click();
  await S.page.waitForTimeout(300);
  await S.page.locator('button[title^="分屏"]').click();
  await S.page.waitForSelector('.split-menu', { timeout: 4000 });
  await S.page.locator('.split-menu .sm-item', { hasText: 'staging-1' }).click();
  await S.page.waitForTimeout(600);
  const panes = await S.page.evaluate(() => ({
    left: !!document.querySelector('.term-session.pane-left'),
    right: !!document.querySelector('.term-session.pane-right'),
  }));
  P(panes.left && panes.right, 'D1 分屏双窗格就位', JSON.stringify(panes));
  await S.page.locator('.st-file').click();
  await S.page.waitForSelector('.task-panel', { timeout: 5000 });
  await S.page.waitForTimeout(400);
  const dSt = await S.page.evaluate(() => {
    const tp = document.querySelector('.task-panel');
    const r = tp.getBoundingClientRect();
    const pl = document.querySelector('.term-session.pane-left')?.getBoundingClientRect();
    const prr = document.querySelector('.term-session.pane-right')?.getBoundingClientRect();
    return {
      tpFull: tp.classList.contains('tp-full'),
      hint: tp.querySelector('.tp-head')?.textContent.includes('完整视图'),
      panel: { x: +r.x.toFixed(1), w: +r.width.toFixed(1) },
      paneL: pl ? { w: +pl.width.toFixed(1), h: +pl.height.toFixed(1) } : null,
      paneR: prr ? { w: +prr.width.toFixed(1), h: +prr.height.toFixed(1) } : null,
      centerDelta: +Math.abs((r.x + r.width / 2) - window.innerWidth / 2).toFixed(1),
    };
  });
  P(dSt.tpFull, 'D2 分屏时面板=tp-full', `tp-full=${dSt.tpFull}`);
  P(dSt.hint, 'D3 tp-head 提示「完整视图，终端仍在运行」');
  P(dSt.paneL && dSt.paneL.w > 100 && dSt.paneL.h > 100 && dSt.paneR && dSt.paneR.w > 100 && dSt.paneR.h > 100, 'D4 双窗格仍在运行（盒尺寸非零）', JSON.stringify({ paneL: dSt.paneL, paneR: dSt.paneR }));
  const flushR = Math.abs(dSt.panel.x + dSt.panel.w - 1280) <= 2, covW = dSt.panel.w >= 1280 - 228 - 4;
  P(flushR && covW, 'D5 tp-full=覆盖内容区（inset:0 设计：右缘贴合+宽度≥内容区）', `panel.x=${dSt.panel.x} w=${dSt.panel.w} flushR=${flushR} covW=${covW}（非居中浮层——centerDelta=${dSt.centerDelta} 为设计预期）`);
  await S.page.screenshot({ path: `${OUT}/d-split-tpfull.png` });
  await S.page.locator('button[aria-label="关闭任务面板"]').click();
  await S.page.waitForTimeout(400);
  const dAfter = await S.page.evaluate(() => ({
    panel: !!document.querySelector('.task-panel'),
    left: !!document.querySelector('.term-session.pane-left'),
    right: !!document.querySelector('.term-session.pane-right'),
  }));
  P(!dAfter.panel && dAfter.left && dAfter.right, 'D6 关面板恢复分屏（双窗格保留）', JSON.stringify(dAfter));
  await S.page.screenshot({ path: `${OUT}/d-split-closed.png` });
  await S.ctx.close();

  // ============ Phase E：窄窗 640/360/320 + 选择保留 ============
  console.log('== Phase E: 窄窗不破版 + 选择保留 ==');
  const E = await newPage(browser, CUR, { width: 640, height: 800 });
  await connectProd1(E.page);
  await openFilesPanel(E.page);
  const chk = async (label) => {
    const st = await E.page.evaluate(() => {
      const tp = document.querySelector('.task-panel');
      const sec = tp?.querySelector('.section');
      const r = sec ? sec.getBoundingClientRect() : null;
      const list = document.querySelector('[data-testid="sftp-list"]');
      const doc = document.documentElement;
      const firstRow = document.querySelector('[data-testid="sftp-list"] .sftp-row');
      const nameEl = firstRow?.querySelector('.sftp-name');
      const timeVisible = firstRow ? getComputedStyle(firstRow.querySelector('.sftp-time')).display !== 'none' : null;
      const sizeVisible = firstRow ? getComputedStyle(firstRow.querySelector('.sftp-size')).display !== 'none' : null;
      return {
        tpFull: tp?.classList.contains('tp-full'),
        listW: sec ? sec.clientWidth : 0,
        listCls: list ? list.className : null,
        docOv: doc.scrollWidth > window.innerWidth + 1,
        nameW: nameEl ? +nameEl.getBoundingClientRect().width.toFixed(1) : 0,
        timeVisible, sizeVisible,
        selN: document.querySelectorAll('[data-testid="sftp-list"] .sftp-row.sel').length,
        barText: document.querySelector('[data-testid="sftp-selbar"]')?.textContent.trim().slice(0, 12) || null,
      };
    });
    I(label, JSON.stringify(st));
    return st;
  };
  const e640 = await chk('E-obs @640');
  P(!e640.docOv, 'E1 640 无横向滚动条');
  P(e640.nameW >= 60, 'E2 640 名称可读', `nameW=${e640.nameW}`);
  // 列收起规则与宽度一致性（≤300 只留名称 / ≤340 收时间 / 其余全列）
  const rule640 = e640.listW <= 300 ? !e640.sizeVisible && !e640.timeVisible : e640.listW <= 340 ? !e640.timeVisible : e640.timeVisible && e640.sizeVisible;
  P(rule640, 'E3 640 列收起规则与面板宽一致', `listW=${e640.listW} time=${e640.timeVisible} size=${e640.sizeVisible}`);
  // 选中 2 项 → 缩窗 → 保留
  const rowsE = E.page.locator('[data-testid="sftp-list"] .sftp-row');
  await rowsE.nth(0).click();
  await rowsE.nth(2).click({ modifiers: ['Meta'] });
  await E.page.waitForTimeout(120);
  await E.page.screenshot({ path: `${OUT}/e-640.png` });
  await E.page.setViewportSize({ width: 360, height: 800 });
  await E.page.waitForTimeout(500);
  const e360 = await chk('E-obs @360');
  P(!e360.docOv, 'E4 360 无横向滚动条');
  P(e360.selN === 2 && /已选 2 项/.test(e360.barText || ''), 'E5 缩至 360 选择保留（§4.2）', `selN=${e360.selN} bar=${e360.barText}`);
  P(e360.nameW >= 40, 'E6 360 名称可读', `nameW=${e360.nameW}`);
  const rule360 = e360.listW <= 300 ? !e360.sizeVisible && !e360.timeVisible : e360.listW <= 340 ? !e360.timeVisible : e360.timeVisible && e360.sizeVisible;
  P(rule360, 'E7 360 列收起规则与面板宽一致', `listW=${e360.listW} time=${e360.timeVisible} size=${e360.sizeVisible}`);
  await E.page.screenshot({ path: `${OUT}/e-360.png` });
  await E.page.setViewportSize({ width: 320, height: 800 });
  await E.page.waitForTimeout(500);
  const e320 = await chk('E-obs @320');
  P(!e320.docOv, 'E8 320 无横向滚动条');
  P(e320.selN === 2, 'E9 320 选择仍保留', `selN=${e320.selN}`);
  const rule320 = e320.listW <= 300 ? !e320.sizeVisible && !e320.timeVisible : e320.listW <= 340 ? !e320.timeVisible : true;
  P(rule320, 'E10 320 列收起规则与面板宽一致', `listW=${e320.listW} time=${e320.timeVisible} size=${e320.sizeVisible}`);
  await E.page.screenshot({ path: `${OUT}/e-320.png` });
  await E.ctx.close();

  // ============ Phase F：pageerror 汇总 ============
  console.log('== Phase F: 全程 pageerror ==');
  P(errors.filter((e) => e.msg).length === 0, 'F1 零 pageerror', JSON.stringify(errors.filter((e) => e.msg)));
  I('console.error 计数（信息性）', String(errors.filter((e) => e.console).length));
  for (const e of errors.filter((x) => x.console).slice(0, 5)) I('console.error 样例', e.console.slice(0, 160));

  await cmpCtx.close();
  await browser.close();
  console.log(`\n==== vis-r31 结果: ${pass} PASS / ${fail} FAIL ====`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('PROBE CRASH:', e); process.exit(2); });
