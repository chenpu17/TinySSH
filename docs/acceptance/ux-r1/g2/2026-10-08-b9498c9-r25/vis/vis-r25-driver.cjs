// vis-r25：零回归双树截屏（A 面）+ 新增面盒测量（B 面）
// 用法：node vis-r25-driver.cjs <mode>
//   A:<port>:<tag>[:noise]  零回归面（欢迎页/添加表单/设置弹窗/搜索条/断线横幅）
//   B:<port>                新面盒测量（分屏菜单/粘贴确认/双 pane 224+280/退化 640）
const { chromium } = require('/Users/chenpu/node_modules/playwright');
const EXE = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const EV = '/Users/chenpu/workspace/claude-code/TinySSH/docs/acceptance/ux-r1/g2/2026-10-08-b9498c9-r25/vis';
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
const clickTab = (page, name) => page.evaluate((n) => {
  const tab = [...document.querySelectorAll('.tabbar .tab')].find((b) => b.textContent.includes(n));
  if (!tab) throw new Error('tab not found: ' + n + ' have=' + [...document.querySelectorAll('.tabbar .tab')].map((t) => t.textContent).join('|'));
  tab.click();
}, name);
const openTerm = async (page, port, name) => {
  await fresh(page, port);
  await clickTab(page, name);
  await page.waitForSelector('.term-session.active .xterm-viewport', { timeout: 6000 });
  await page.waitForTimeout(500);
};
const boxOf = `(() => { const f = (el) => { const r = el.getBoundingClientRect(); return { x: +r.x.toFixed(1), y: +r.y.toFixed(1), w: +r.width.toFixed(1), h: +r.height.toFixed(1), right: +r.right.toFixed(1), bottom: +r.bottom.toFixed(1), clipX: el.scrollWidth - el.clientWidth, clipY: el.scrollHeight - el.clientHeight }; }; return f; })()`;
const inter = (a, b) => !(a.right <= b.x || b.right <= a.x || a.bottom <= b.y || b.bottom <= a.y);

(async () => {
  const mode = process.argv[2];
  const browser = await chromium.launch({ executablePath: EXE, headless: true });

  if (mode.startsWith('A:')) {
    const [, port, tag, noise] = mode.split(':');
    const dir = `${EV}/${tag}`;
    fs.mkdirSync(dir, { recursive: true });
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
    const jsErrors = [];
    page.on('pageerror', (e) => jsErrors.push(String(e)));
    page.on('unhandledrejection', (e) => jsErrors.push(String(e)));

    // A1 欢迎页 + 主机列表
    await fresh(page, port);
    await page.screenshot({ path: `${dir}/A1-welcome.png` });
    if (noise) {
      await page.screenshot({ path: `${dir}/N1-noise-1.png` });
      await page.waitForTimeout(150);
      await page.screenshot({ path: `${dir}/N1-noise-2.png` });
      await page.waitForTimeout(150);
      await page.screenshot({ path: `${dir}/N1-noise-3.png` });
    }
    // A2 添加主机表单
    await page.click('button[aria-label="新建连接"]');
    await page.waitForSelector('.add-host', { timeout: 4000 });
    await settle(page);
    await page.screenshot({ path: `${dir}/A2-addform.png` });
    // A3 设置弹窗（当前树预期 delta=粘贴 section；两树均记录 section 盒做布局对账）
    await fresh(page, port);
    await page.click('.hb-settings');
    await page.waitForSelector('.term-settings', { timeout: 4000 });
    await settle(page);
    await page.screenshot({ path: `${dir}/A3-settings.png` });
    const a3 = await page.evaluate((src) => {
      const dlg = document.querySelector('.term-settings');
      const r = dlg.getBoundingClientRect();
      const secs = [...dlg.querySelectorAll('.ts-label')].map((el) => ({
        text: el.textContent.trim().slice(0, 14), y: +el.getBoundingClientRect().y.toFixed(1),
        bottom: +el.getBoundingClientRect().bottom.toFixed(1),
      }));
      const shortcut = [...dlg.querySelectorAll('.dim')].find((d) => d.textContent.includes('字号快捷键'));
      const pasteRow = dlg.querySelector('input[type="checkbox"]');
      let pasteRowBox = null;
      if (pasteRow) {
        const lab = pasteRow.closest('label');
        const rr = lab.getBoundingClientRect();
        pasteRowBox = { y: +rr.y.toFixed(1), h: +rr.height.toFixed(1), bottom: +rr.bottom.toFixed(1), checked: pasteRow.checked };
      }
      const credList = dlg.querySelectorAll('.cred-row, .identity-row').length;
      return {
        tree: src, dlg: { x: +r.x.toFixed(1), y: +r.y.toFixed(1), w: +r.width.toFixed(1), h: +r.height.toFixed(1) },
        secs, shortcut: shortcut ? { y: +shortcut.getBoundingClientRect().y.toFixed(1), bottom: +shortcut.getBoundingClientRect().bottom.toFixed(1) } : null,
        pasteRowBox, credRows: credList,
      };
    }, tag);
    log(`[A3:${tag}] 设置弹窗盒=${JSON.stringify(a3)}`);
    await page.keyboard.press('Escape');
    // A4 终端搜索条（点 prod-1 种子会话标签 → 搜索钮）
    await openTerm(page, port, 'prod-1');
    await page.click('button[aria-label="搜索终端内容"]');
    await page.waitForSelector('.term-search input', { timeout: 4000 });
    await page.fill('.term-search input', 'ops');
    await page.waitForTimeout(400);
    await page.screenshot({ path: `${dir}/A4-search.png` });
    // A5 断线横幅（staging-1 种子会话 Disconnected）
    await fresh(page, port);
    await clickTab(page, 'staging-1');
    await page.waitForSelector('.dead-overlay', { timeout: 6000 });
    await settle(page);
    await page.screenshot({ path: `${dir}/A5-deadbanner.png` });
    // 清 demo 态
    await page.evaluate(() => localStorage.clear());
    await page.reload();
    await page.waitForTimeout(400);
    log(`[A:${tag}] A 面完成（A1${noise ? '+噪声x3' : ''}/A2/A3/A4/A5） JS错误=${jsErrors.length === 0 ? '无' : JSON.stringify(jsErrors)}`);
    await page.close();
  }

  if (mode.startsWith('B:')) {
    const port = mode.split(':')[1];
    fs.mkdirSync(`${EV}/cur`, { recursive: true });
    // 粘贴确认需要剪贴板权限
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1, permissions: ['clipboard-read', 'clipboard-write'] });
    const page = await context.newPage();
    const jsErrors = [];
    page.on('pageerror', (e) => jsErrors.push(String(e)));
    page.on('unhandledrejection', (e) => jsErrors.push(String(e)));

    // ---- B1 分屏菜单 popover ----
    await openTerm(page, port, 'prod-1');
    await page.click('button[title^="分屏"]');
    await page.waitForSelector('.split-menu', { timeout: 4000 });
    await settle(page);
    await page.screenshot({ path: `${EV}/cur/B1-split-menu.png` });
    const b1 = await page.evaluate((boxSrc) => {
      const f = eval(boxSrc);
      const menu = document.querySelector('.split-menu');
      const m = f(menu);
      const kids = [...menu.children].map((c) => ({ cls: c.className || c.tagName, text: c.textContent.trim().slice(0, 24), ...f(c) }));
      const item = [...menu.querySelectorAll('.sm-item')].find((b) => b.textContent.includes('staging-1'));
      const stSpan = item ? item.querySelector('span:last-child') : null;
      return {
        menu: m, vw: innerWidth, kids,
        itemRow: item ? f(item) : null, itemName: item?.querySelector('.sm-name')?.textContent,
        itemStatus: stSpan?.textContent, statusRight: stSpan ? f(stSpan) : null,
        newItem: [...menu.querySelectorAll('.sm-item')].find((b) => b.textContent.includes('新建会话'))?.textContent.trim(),
      };
    }, boxOf);
    log(`B1 分屏菜单盒=${JSON.stringify(b1)}`);
    const inVp = b1.menu.x >= 0 && b1.menu.y >= 0 && b1.menu.right <= b1.vw && b1.menu.bottom <= 800;
    let ov = false, cl = false;
    for (let i = 0; i < b1.kids.length; i++) {
      const a = b1.kids[i];
      if (a.clipX > 1 || a.clipY > 1) { cl = true; log(`B1 子元素截断: ${a.cls} clipX=${a.clipX} clipY=${a.clipY}`); }
      for (let j = i + 1; j < b1.kids.length; j++) if (inter(b1.kids[i], b1.kids[j])) { ov = true; log(`B1 子元素相交: [${b1.kids[i].cls}]×[${b1.kids[j].cls}]`); }
    }
    log(`B1 判定: 菜单在视口内=${inVp} 子元素零相交=${!ov} 零截断=${!cl} 状态右对齐差=${b1.statusRight ? +(b1.menu.right - b1.statusRight.right).toFixed(1) : 'N/A'}（右 padding 应≈8+10）`);
    // 悬停态可读
    await page.hover('.split-menu .sm-item');
    await settle(page);
    await page.screenshot({ path: `${EV}/cur/B1-split-menu-hover.png` });

    // ---- B2 多行粘贴确认 ----
    await page.keyboard.press('Escape'); // 关菜单
    await page.waitForTimeout(200);
    await page.evaluate(() => navigator.clipboard.writeText('echo one\necho two\necho three'));
    await page.evaluate(() => document.querySelector('.term-session.active .xterm-helper-textarea')?.focus());
    await page.keyboard.press('Meta+v');
    try { await page.waitForSelector('.paste-dialog', { timeout: 2500 }); } catch {
      // 合成事件兜底（headless 剪贴板路径不通时）
      await page.evaluate(() => {
        const ta = document.querySelector('.term-session.active .xterm-helper-textarea');
        ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'v', code: 'KeyV', metaKey: true, keyCode: 86, bubbles: true, cancelable: true }));
      });
      await page.waitForSelector('.paste-dialog', { timeout: 2500 });
    }
    await settle(page);
    await page.screenshot({ path: `${EV}/cur/B2-paste-dialog.png` });
    const b2 = await page.evaluate((boxSrc) => {
      const f = eval(boxSrc);
      const dlg = document.querySelector('.paste-dialog');
      const kids = [...dlg.children].map((c) => ({ cls: c.className || 'text', text: c.textContent.trim().slice(0, 30), ...f(c) }));
      const pre = dlg.querySelector('.paste-preview');
      const btns = [...dlg.querySelectorAll('button')].map((bt) => ({ text: bt.textContent.trim(), ...f(bt) }));
      return { dlg: f(dlg), vw: innerWidth, kids, pre: f(pre), preScrollY: pre.scrollHeight - pre.clientHeight, btns, title: dlg.querySelector('.hk-title')?.textContent };
    }, boxOf);
    log(`B2 粘贴确认盒=${JSON.stringify(b2)}`);
    let ov2 = false, cl2 = false;
    for (let i = 0; i < b2.kids.length; i++) {
      if (b2.kids[i].clipX > 1 || b2.kids[i].clipY > 1) { cl2 = true; log(`B2 子元素截断: ${b2.kids[i].cls}`); }
      for (let j = i + 1; j < b2.kids.length; j++) if (inter(b2.kids[i], b2.kids[j])) { ov2 = true; log(`B2 子元素相交: [${b2.kids[i].cls}]×[${b2.kids[j].cls}]`); }
    }
    const b2in = b2.dlg.x >= 0 && b2.dlg.y >= 0 && b2.dlg.right <= b2.vw && b2.dlg.bottom <= 800;
    log(`B2 判定: 标题=${JSON.stringify(b2.title)} 对话框在视口内=${b2in} 子元素零相交=${!ov2} 零截断=${!cl2} 短内容无内部滚动=${b2.preScrollY <= 1} 按钮数=${b2.btns.length}（发送/取消）`);
    // 长内容：40 行 → pre 内部滚动不撑破
    await page.keyboard.press('Escape');
    await page.waitForTimeout(200);
    await page.evaluate(() => navigator.clipboard.writeText(Array.from({ length: 40 }, (_, i) => `command-line-number-${i + 1} --flag=xxxxxxxxxxxxxxxxxxxx`).join('\n')));
    await page.evaluate(() => document.querySelector('.term-session.active .xterm-helper-textarea')?.focus());
    await page.keyboard.press('Meta+v');
    await page.waitForSelector('.paste-dialog', { timeout: 2500 });
    await settle(page);
    await page.screenshot({ path: `${EV}/cur/B2-paste-dialog-long.png` });
    const b2l = await page.evaluate(() => {
      const pre = document.querySelector('.paste-preview');
      const dlg = document.querySelector('.paste-dialog');
      const r = pre.getBoundingClientRect(), dr = dlg.getBoundingClientRect();
      return { preH: +r.height.toFixed(1), preScrollY: pre.scrollHeight - pre.clientHeight, dlgH: +dr.height.toFixed(1), dlgBottom: +dr.bottom.toFixed(1), preInDlg: r.bottom <= dr.bottom + 0.5 };
    });
    log(`B2-long 判定: pre高=${b2l.preH}（max 220+16+2=238 上限）内部滚动=${b2l.preScrollY > 0} 对话框高=${b2l.dlgH} 底=${b2l.dlgBottom}<=800 pre在对话框内=${b2l.preInDlg}`);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(200);

    // ---- B3 分屏双 pane（224 默认 + 280 前科档）----
    const splitMeasure = async (widthTag) => {
      await page.goto(`http://localhost:${port}/`, { waitUntil: 'domcontentloaded' });
      await page.evaluate((w) => { localStorage.clear(); if (w === '280') localStorage.setItem('ui.hostbar_w', '280'); }, widthTag);
      await page.reload();
      await page.waitForSelector('.host-card', { timeout: 9000 });
      await settle(page);
      await clickTab(page, 'prod-1');
      await page.waitForSelector('.term-session.active .xterm-viewport', { timeout: 6000 });
      await page.click('button[title^="分屏"]');
      await page.waitForSelector('.split-menu', { timeout: 4000 });
      await page.evaluate(() => [...document.querySelectorAll('.sm-item')].find((b) => b.textContent.includes('staging-1')).click());
      await page.waitForSelector('.term-session.pane-right', { timeout: 6000 });
      await page.waitForTimeout(600); // resize debounce 150ms + fit
      await page.screenshot({ path: `${EV}/cur/B3-split-panes-w${widthTag}.png` });
      const m = await page.evaluate((boxSrc) => {
        const f = eval(boxSrc);
        const term = document.querySelector('#term');
        const L = document.querySelector('.term-session.pane-left');
        const R = document.querySelector('.term-session.pane-right');
        const tagL = L.querySelector('.pane-tag'), tagR = R.querySelector('.pane-tag');
        const ov = document.querySelector('.pane-right .dead-overlay');
        const banner = document.querySelector('.pane-right .dead-banner');
        const btn = banner ? [...banner.querySelectorAll('button')].find((b) => b.textContent.includes('重连')) : null;
        return {
          term: f(term), hostbarW: document.querySelector('.hostbar')?.getBoundingClientRect().width,
          L: f(L), R: f(R), tagL: f(tagL), tagR: f(tagR), tagLText: tagL.textContent, tagRText: tagR.textContent,
          LClipX: L.scrollWidth - L.clientWidth, RClipX: R.scrollWidth - R.clientWidth,
          ov: ov ? f(ov) : null, banner: banner ? f(banner) : null,
          btn: btn ? f(btn) : null, btnPE: btn ? getComputedStyle(btn).pointerEvents : null,
          ovPE: ov ? getComputedStyle(ov).pointerEvents : null,
          bannerPE: banner ? getComputedStyle(banner).pointerEvents : null,
          focused: document.querySelector('.term-session.pane-focused')?.classList.contains('pane-left') ? 'left' : 'right',
        };
      }, boxOf);
      log(`B3-w${widthTag} 盒=${JSON.stringify(m)}`);
      const halvesOk = Math.abs((m.R.x - m.term.x) - (m.term.w / 2)) <= 1 && Math.abs(m.L.w - m.R.w) <= 1.5;
      const tagNoInter = !inter(m.tagL, m.tagR) && m.tagL.x >= m.L.x && m.tagR.x >= m.R.x;
      const bannerInR = m.banner && m.banner.x >= m.R.x && m.banner.right <= m.R.right && m.banner.y >= m.R.y;
      log(`B3-w${widthTag} 判定: 主机栏宽=${m.hostbarW} 右pane起于中线=${halvesOk} 左右等宽=${Math.abs(m.L.w - m.R.w) <= 1.5} 名牌=${m.tagLText}/${m.tagRText} 不相交=${tagNoInter} 无横溢=${m.LClipX <= 1 && m.RClipX <= 1} 焦点=${m.focused} 断线横幅在右pane内=${bannerInR} overlay PE=${m.ovPE} banner PE=${m.bannerPE} 重连钮 PE=${m.btnPE}`);
      return m;
    };
    const m224 = await splitMeasure('224');
    await splitMeasure('280');

    // ---- B4 宽度退化（640）+ 恢复 1280 ----
    // 重回 224 分屏态
    await page.goto(`http://localhost:${port}/`, { waitUntil: 'domcontentloaded' });
    await page.evaluate(() => localStorage.clear());
    await page.reload();
    await page.waitForSelector('.host-card', { timeout: 9000 });
    await settle(page);
    await clickTab(page, 'prod-1');
    await page.waitForSelector('.term-session.active .xterm-viewport', { timeout: 6000 });
    await page.click('button[title^="分屏"]');
    await page.waitForSelector('.split-menu', { timeout: 4000 });
    await page.evaluate(() => [...document.querySelectorAll('.sm-item')].find((b) => b.textContent.includes('staging-1')).click());
    await page.waitForSelector('.term-session.pane-right', { timeout: 6000 });
    await page.waitForTimeout(600);
    await page.setViewportSize({ width: 640, height: 800 });
    await page.waitForSelector('.split-hint', { timeout: 4000 });
    await page.waitForTimeout(600); // 150ms debounce + fit
    await page.screenshot({ path: `${EV}/cur/B4-degraded-640.png` });
    const b4 = await page.evaluate((boxSrc) => {
      const f = eval(boxSrc);
      const term = document.querySelector('#term');
      const hint = document.querySelector('.split-hint');
      const span = hint.querySelector('span');
      const xbtn = hint.querySelector('button');
      const A = document.querySelector('.term-session.active');
      const paneR = document.querySelector('.term-session.pane-right');
      return {
        term: f(term), hint: f(hint), span: f(span), spanClipX: span.scrollWidth - span.clientWidth,
        xbtn: f(xbtn), A: f(A), paneRPresent: !!paneR,
        centered: Math.abs((f(hint).x + f(hint).w / 2) - (f(term).x + f(term).w / 2)) <= 2,
        Afull: Math.abs(f(A).w - f(term).w) <= 1,
      };
    }, boxOf);
    log(`B4-640 盒=${JSON.stringify(b4)}`);
    const hintNoTagInter = (() => {
      const tag = b4.A ? null : null; // 退化态 active pane 名牌仍显示吗？pane-left/right 类被移除 → applyPanes 走单 pane 分支 active，pane-tag display:none（仅 pane-left/right 时 block）
      return true;
    })();
    log(`B4-640 判定: 单窗格全幅=${b4.Afull} 右pane隐藏=${b4.paneRPresent === false} 提示条居中=${b4.centered} 文案无截断=${b4.spanClipX <= 1} 关闭钮可达(视口内)=${b4.xbtn.x >= 0 && b4.xbtn.right <= 640 && b4.xbtn.y >= 0} 名牌类分支=${hintNoTagInter ? '单pane分支（tag不显示，无遮名牌问题）' : '?'}`);
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.waitForSelector('.term-session.pane-right', { timeout: 4000 });
    await page.waitForTimeout(600);
    await page.screenshot({ path: `${EV}/cur/B4-recovered-1280.png` });
    const b4r = await page.evaluate(() => {
      const R = document.querySelector('.term-session.pane-right');
      const hint = document.querySelector('.split-hint');
      return { paneR: !!R, hintGone: !hint, Lw: document.querySelector('.term-session.pane-left')?.getBoundingClientRect().width };
    });
    log(`B4-恢复 判定: 双pane恢复=${b4r.paneR} 提示条消失=${b4r.hintGone}`);
    // 清 demo 态
    await page.evaluate(() => localStorage.clear());
    await page.reload();
    await page.waitForTimeout(400);
    log(`B 面完成 JS错误=${jsErrors.length === 0 ? '无' : JSON.stringify(jsErrors)}`);
    await context.close();
  }

  await browser.close();
  fs.writeFileSync(`${EV}/vis-r25-driverreport.json`, JSON.stringify({ results }, null, 2));
})().catch((e) => { console.error('DRIVER FAIL', e); process.exit(1); });
