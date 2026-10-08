// vis-r23：零回归双树截屏 + 新增/变更面盒测量驱动
// 用法：node vis-r23-driver.cjs <mode>
//   mode = A:<port>:<tag>[:noise]   零回归面（欢迎页/主机列表/添加表单/设置弹窗）
//   mode = B:<port>                 新面盒测量（关闭确认框/门挂起主机卡 224+280）
const { chromium } = require('/Users/chenpu/node_modules/playwright');
const EXE = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const EV = '/Users/chenpu/workspace/claude-code/TinySSH/docs/acceptance/ux-r1/g2/2026-10-08-ad652a2-r23/vis';
const fs = require('fs');

const results = [];
const log = (s) => { results.push(s); console.log(s); };
const settle = async (page) => {
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  await page.waitForTimeout(300);
};
const fresh = async (page, port) => {
  await page.goto(`http://localhost:${port}/`, { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.waitForSelector('.host-card', { timeout: 9000 });
  await page.waitForSelector('.welcome', { timeout: 9000 });
  await settle(page);
};
const boxOf = (sel, root) => {
  const el = (root || document).querySelector(sel);
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { x: +r.x.toFixed(1), y: +r.y.toFixed(1), w: +r.width.toFixed(1), h: +r.height.toFixed(1),
    right: +r.right.toFixed(1), bottom: +r.bottom.toFixed(1),
    clipX: el.scrollWidth - el.clientWidth, clipY: el.scrollHeight - el.clientHeight };
};
const inter = (a, b) => a && b && !(a.right <= b.x || b.right <= a.x || a.bottom <= b.y || b.bottom <= a.y);

(async () => {
  const mode = process.argv[2];
  const browser = await chromium.launch({ executablePath: EXE, headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
  const jsErrors = [];
  page.on('pageerror', (e) => jsErrors.push(String(e)));
  page.on('unhandledrejection', (e) => jsErrors.push(String(e)));

  if (mode.startsWith('A:')) {
    const [, port, tag, noise] = mode.split(':');
    const dir = `${EV}/${tag}`;
    fs.mkdirSync(dir, { recursive: true });
    await fresh(page, port);
    await page.screenshot({ path: `${dir}/A1-welcome.png` });
    if (noise) {
      await page.screenshot({ path: `${dir}/N1-noise-1.png` });
      await page.waitForTimeout(150);
      await page.screenshot({ path: `${dir}/N1-noise-2.png` });
      await page.waitForTimeout(150);
      await page.screenshot({ path: `${dir}/N1-noise-3.png` });
    }
    // A2 添加主机表单静态布局（基线同名面）
    await page.click('button[aria-label="新建连接"]');
    await page.waitForSelector('.add-host', { timeout: 4000 });
    await settle(page);
    await page.screenshot({ path: `${dir}/A2-addform.png` });
    // A3 设置弹窗静态布局（R21 已签凭据面）
    await fresh(page, port);
    await page.click('.hb-settings');
    await page.waitForSelector('.term-settings', { timeout: 4000 });
    await settle(page);
    await page.screenshot({ path: `${dir}/A3-settings.png` });
    log(`[${tag}] A 面截屏完成（A1${noise ? '+噪声x3' : ''}/A2/A3）`);
  }

  if (mode.startsWith('B:')) {
    const port = mode.split(':')[1];
    fs.mkdirSync(`${EV}/cur`, { recursive: true });

    // ---- B1 关闭会话确认框 ----
    await fresh(page, port);
    const connectCard = async (name) => {
      await page.evaluate((n) => {
        const card = [...document.querySelectorAll('.host-card')].find((c) => c.textContent.includes(n));
        card.querySelector('.host-connect-btn').click();
      }, name);
    };
    await connectCard('prod-1');
    await page.waitForSelector('.tab', { timeout: 6000 });
    await page.waitForFunction(() => document.querySelector('.tab .tab-dot')?.className.includes('on') || document.querySelector('.tab .tab-dot')?.className.includes('Connected') || [...document.querySelectorAll('.tab')].some((t) => t.textContent.includes('prod-1')), { timeout: 6000 });
    await page.waitForTimeout(500);
    await page.click('.tab-x');
    await page.waitForSelector('.confirm-dialog', { timeout: 4000 });
    await page.waitForFunction(() => document.querySelector('.confirm-dialog .dim')?.textContent.includes('将受影响的转发：无') || document.querySelector('.confirm-dialog .dim')?.textContent.includes('状态未知'), { timeout: 4000 });
    await settle(page);
    await page.screenshot({ path: `${EV}/cur/B1-close-confirm.png` });
    const b1 = await page.evaluate(() => {
      const dlg = document.querySelector('.confirm-dialog');
      const kids = [...dlg.children].map((c) => { const r = c.getBoundingClientRect(); return { cls: c.className || 'text', x: +r.x.toFixed(1), y: +r.y.toFixed(1), w: +r.width.toFixed(1), h: +r.height.toFixed(1), right: +r.right.toFixed(1), bottom: +r.bottom.toFixed(1), clipX: c.scrollWidth - c.clientWidth, clipY: c.scrollHeight - c.clientHeight, text: c.textContent.trim().slice(0, 40) }; });
      const r = dlg.getBoundingClientRect();
      return { dlg: { x: +r.x.toFixed(1), y: +r.y.toFixed(1), w: +r.width.toFixed(1), h: +r.height.toFixed(1) }, vw: innerWidth, vh: innerHeight, kids,
        impactText: dlg.querySelector('.dim')?.textContent.trim() };
    });
    log('B1 确认框盒测量=' + JSON.stringify(b1));
    // 层级/相交判定
    const d = b1.dlg;
    log(`B1 判定: 对话框在视口内=${d.x >= 0 && d.y >= 0 && d.x + d.w <= b1.vw && d.y + d.h <= b1.vh}`);
    let overlap = false, clip = false;
    for (let i = 0; i < b1.kids.length; i++) {
      const a = b1.kids[i];
      if (a.clipX > 1 || a.clipY > 1) { clip = true; log(`B1 子元素截断: ${a.cls} clipX=${a.clipX} clipY=${a.clipY}`); }
      for (let j = i + 1; j < b1.kids.length; j++) {
        const b = b1.kids[j];
        if (!(a.right <= b.x || b.right <= a.x || a.bottom <= b.y || b.bottom <= a.y)) { overlap = true; log(`B1 子元素相交: [${a.cls}]×[${b.cls}]`); }
      }
    }
    log(`B1 判定: 子元素零相交=${!overlap} 零截断=${!clip}`);
    const danger = b1.kids.find((k) => k.cls.includes('hk-actions'));
    log(`B1 影响行文本=${JSON.stringify(b1.impactText)}`);
    await page.keyboard.press('Escape');
    await page.reload();

    // ---- B2 门挂起期主机卡（TOFU 遮罩在时）----
    const gateMeasure = async (widthTag) => {
      // 宽度注入须与 clear 同批先于 reload——先 clear 再 reload 会触发 workspace blob
      // 迁移把默认 224 落进 blob，后续 setItem 280 会被 blob 事实源覆盖
      await page.goto(`http://localhost:${port}/`, { waitUntil: 'domcontentloaded' });
      await page.evaluate((w) => { localStorage.clear(); if (w === '280') localStorage.setItem('ui.hostbar_w', '280'); }, widthTag);
      await page.reload();
      await page.waitForSelector('.host-card', { timeout: 9000 });
      await page.waitForSelector('.welcome', { timeout: 9000 });
      await settle(page);
      await connectCard('otp-1');
      await page.waitForSelector('.hk-mask', { timeout: 6000 });
      await page.waitForFunction(() => [...document.querySelectorAll('.host-connect-btn')].some((b) => b.textContent.includes('等待指纹确认')), { timeout: 6000 });
      await settle(page);
      await page.screenshot({ path: `${EV}/cur/B2-gate-card-w${widthTag}.png` });
      const m = await page.evaluate(() => {
        const card = [...document.querySelectorAll('.host-card')].find((c) => c.textContent.includes('otp-1'));
        const btn = card.querySelector('.host-connect-btn');
        const cancel = [...card.querySelectorAll('button')].find((b) => b.textContent.trim() === '取消');
        const row = btn.closest('.row') || btn.parentElement;
        const cr = card.getBoundingClientRect(), br = btn.getBoundingClientRect();
        const cbr = cancel.getBoundingClientRect(), rr = row.getBoundingClientRect();
        const b = { x: +br.x.toFixed(1), y: +br.y.toFixed(1), w: +br.width.toFixed(1), h: +br.height.toFixed(1), right: +br.right.toFixed(1) };
        const c = { x: +cbr.x.toFixed(1), y: +cbr.y.toFixed(1), w: +cbr.width.toFixed(1), h: +cbr.height.toFixed(1), right: +cbr.right.toFixed(1) };
        return {
          card: { w: +cr.width.toFixed(1), right: +cr.right.toFixed(1) },
          row: { w: +rr.width.toFixed(1), right: +rr.right.toFixed(1) },
          connect: b, cancel: c,
          phaseText: btn.textContent.trim(),
          btnClipX: btn.scrollWidth - btn.clientWidth,
          phaseSpanClipX: (() => { const s = btn.querySelector('span'); return s ? s.scrollWidth - s.clientWidth : 0; })(),
          btnInCard: br.right <= cr.right + 0.5 && br.x >= cr.x - 0.5,
          cancelInCard: cbr.right <= cr.right + 0.5 && cbr.x >= cr.x - 0.5,
          btnXCancelInter: !(br.right <= cbr.x || cbr.right <= br.x || br.bottom <= cbr.y || cbr.bottom <= br.y),
          hostbarW: document.querySelector('.hostbar')?.getBoundingClientRect().width,
        };
      });
      log(`B2-w${widthTag} 盒测量=` + JSON.stringify(m));
      log(`B2-w${widthTag} 判定: 相位文本=${JSON.stringify(m.phaseText)} 按钮无横溢=${m.btnClipX <= 1 && m.phaseSpanClipX <= 1} 连接钮在卡内=${m.btnInCard} 取消钮在卡内=${m.cancelInCard} 连接×取消相交=${m.btnXCancelInter}`);
      // 复位：点卡上取消（顺带验证取消入口活体可用），关掉可能残留的遮罩
      await page.evaluate(() => {
        const card = [...document.querySelectorAll('.host-card')].find((c) => c.textContent.includes('otp-1'));
        [...card.querySelectorAll('button')].find((b) => b.textContent.trim() === '取消').click();
      });
      await page.waitForTimeout(400);
      // 若 TOFU 遮罩仍在（取消不撤遮罩），拒绝该指纹以复位
      const mask = await page.$('.hk-mask');
      if (mask) {
        await page.evaluate(() => { [...document.querySelectorAll('.hk-dialog button')].find((b) => /拒绝|取消/.test(b.textContent)).click(); });
        await page.waitForTimeout(300);
      }
    };
    await gateMeasure('224');
    await gateMeasure('280');
    log(`JS 错误: ${jsErrors.length === 0 ? '无' : JSON.stringify(jsErrors)}`);
  }

  await browser.close();
  fs.writeFileSync(`${EV}/vis-r23-driverreport.json`, JSON.stringify({ results }, null, 2));
})().catch((e) => { console.error('DRIVER FAIL', e); process.exit(1); });
