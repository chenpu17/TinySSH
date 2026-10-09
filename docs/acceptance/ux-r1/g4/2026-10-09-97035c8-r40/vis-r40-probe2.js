// vis-r40 补充复验：多视口盒测量、键盘激活（Enter/Space）、行内停止钮可达、更多节外回归、
// 以及暴露行缺陷在三个出货视口下的复现。
const { chromium } = require('/Users/chenpu/node_modules/playwright');
const fs = require('fs'); const path = require('path');
const EXE = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const URL = 'http://localhost:5183/';
const OUT = process.env.VIS_OUT || __dirname;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const ok = (n, c, d = '') => { results.push({ n, pass: !!c, d }); console.log((c ? 'PASS ' : 'FAIL ') + n + (d ? '  [' + d + ']' : '')); };

(async () => {
  const browser = await chromium.launch({ executablePath: EXE, headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, colorScheme: 'dark' });
  const page = await ctx.newPage();
  const jsErrors = [];
  page.on('pageerror', (e) => jsErrors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') jsErrors.push('console.error: ' + m.text()); });
  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => { try { localStorage.clear(); } catch {} });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.host-card', { timeout: 15000 });
  await sleep(500);
  await page.evaluate(() => {
    const c = [...document.querySelectorAll('.host-card')].find((x) => x.querySelector('.host-name')?.textContent.includes('prod-1'));
    c?.querySelector('.host-connect-btn')?.click();
  });
  await sleep(1500);
  const openForwards = async () => {
    await page.evaluate(() => { [...document.querySelectorAll('.st-tools button')].find((b) => b.textContent.includes('工具'))?.click(); });
    await sleep(200);
    await page.evaluate(() => { [...document.querySelectorAll('.tools-menu button')].find((b) => b.textContent.includes('端口转发'))?.click(); });
    await sleep(400);
  };
  await openForwards();

  const setVal = (idx, v) => page.evaluate(({ idx, v }) => {
    const ins = [...document.querySelectorAll('.task-panel .fwd-form input.mono')];
    if (!ins[idx]) return; const s = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    s.call(ins[idx], v); ins[idx].dispatchEvent(new Event('input', { bubbles: true }));
  }, { idx, v });
  const setAddr = (v) => page.evaluate((v) => {
    const el = document.querySelector('.task-panel .fwd-form input.mono');
    const s = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    s.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true }));
  }, v);
  const rowCount = () => page.$$eval('.fwd-row', (r) => r.length);

  // ---- 键盘激活：Enter 触发「启动转发」 ----
  await setAddr('127.0.0.1'); await sleep(80);
  await setVal(1, '8080'); await setVal(2, '10.0.0.31'); await setVal(3, '5432');
  await page.evaluate(() => { const b = [...document.querySelectorAll('.task-panel .section button')].find((x) => x.textContent.trim() === '启动转发'); b.setAttribute('data-vis', 'start'); });
  await page.locator('[data-vis="start"]').focus();
  await page.keyboard.press('Enter'); await sleep(500);
  ok('kbd Enter activates 启动转发 (creates row)', (await rowCount()) === 1, 'rows=' + (await rowCount()));

  // ---- 行内「停止」钮 Tab 可达 + 焦点可见 ----
  await page.locator('[data-vis="start"]').focus();
  await page.keyboard.press('Tab'); await sleep(120);
  const afterTab = await page.evaluate(() => {
    const a = document.activeElement; const cs = getComputedStyle(a);
    return { tag: a.tagName, text: (a.textContent || '').trim().slice(0, 8), cls: String(a.className).split(' ')[0],
      focusVisible: a.matches(':focus-visible'), outlineW: cs.outlineWidth, boxShadow: cs.boxShadow };
  });
  ok('kbd Tab reaches row 停止 button', afterTab.tag === 'BUTTON' && afterTab.text === '停止', JSON.stringify(afterTab));
  ok('row 停止 button has visible focus ring', (afterTab.outlineW && afterTab.outlineW !== '0px') || (afterTab.boxShadow && afterTab.boxShadow !== 'none'), JSON.stringify(afterTab));

  // ---- 键盘激活：Space 切换暴露勾选框 ----
  await setAddr('0.0.0.0'); await sleep(200);
  await page.locator('[data-testid="fwd-expose"] input').focus();
  const before = await page.$eval('[data-testid="fwd-expose"] input', (i) => i.checked);
  await page.keyboard.press('Space'); await sleep(150);
  const after = await page.$eval('[data-testid="fwd-expose"] input', (i) => i.checked);
  ok('kbd Space toggles exposure checkbox', before === false && after === true, `${before}->${after}`);

  // ---- 多视口盒测量（1440×900 / 1280×800 / 1024×768） ----
  const measureViewport = async (w, h) => {
    await page.setViewportSize({ width: w, height: h }); await sleep(400);
    return await page.evaluate(() => {
      const panel = document.querySelector('.task-panel');
      const sc = document.querySelector('.task-panel .tp-scroll');
      const pr = panel.getBoundingClientRect();
      const rows = [...document.querySelectorAll('.task-panel .section .fwd-form')].map((r) => { const b = r.getBoundingClientRect(); return { top: Math.round(b.top), bottom: Math.round(b.bottom), l: Math.round(b.left), r: Math.round(b.right) }; });
      let overlap = false; for (let i = 0; i < rows.length - 1; i++) if (rows[i].bottom > rows[i + 1].top + 1) overlap = true;
      // 表单控件是否越出面板右界
      const ctrls = [...document.querySelectorAll('.task-panel .fwd-form input, .task-panel .fwd-form select')].map((c) => { const b = c.getBoundingClientRect(); return { r: Math.round(b.right) }; });
      const ctrlOut = ctrls.some((c) => c.r > Math.round(pr.right) + 1);
      return { panelRight: Math.round(pr.right), scrollW: sc.scrollWidth, clientW: sc.clientWidth, hOverflow: sc.scrollWidth > sc.clientWidth + 1, overlap, ctrlOut, rowCount: rows.length };
    });
  };
  for (const [w, h] of [[1440, 900], [1280, 800], [1024, 768]]) {
    const m = await measureViewport(w, h);
    ok(`layout ${w}x${h}: no form row overlap`, !m.overlap, JSON.stringify(m));
    ok(`layout ${w}x${h}: no control past panel right`, !m.ctrlOut, `panelRight=${m.panelRight}`);
    ok(`layout ${w}x${h}: no horizontal overflow`, !m.hOverflow, `scrollW=${m.scrollW} clientW=${m.clientW}`);
  }

  // ---- 暴露行缺陷在三视口复现（span 是否在面板内） ----
  const exposeAt = async (w, h) => {
    await page.setViewportSize({ width: w, height: h }); await sleep(350);
    return await page.evaluate(() => {
      const label = document.querySelector('[data-testid="fwd-expose"]');
      if (!label) return { missing: true };
      const input = label.querySelector('input'); const span = label.querySelector('span');
      const panel = document.querySelector('.task-panel').getBoundingClientRect();
      const ib = input.getBoundingClientRect(); const sb = span.getBoundingClientRect();
      return { inputW: Math.round(ib.width), spanX: Math.round(sb.x), spanW: Math.round(sb.width),
        panelRight: Math.round(panel.right), spanInsidePanel: sb.x >= panel.left - 1 && sb.right <= panel.right + 1 };
    });
  };
  for (const [w, h] of [[1440, 900], [1280, 800], [1024, 768]]) {
    const e = await exposeAt(w, h);
    ok(`expose warning text visible ${w}x${h}`, e.spanInsidePanel === true, JSON.stringify(e));
  }

  // ---- 节外回归：传输抽屉 + 协作面板 ----
  await page.setViewportSize({ width: 1440, height: 900 }); await sleep(300);
  // 关闭转发面板 → 打开协作面板
  await page.evaluate(() => { [...document.querySelectorAll('.st-tools button')].find((b) => b.textContent.includes('工具'))?.click(); });
  await sleep(200);
  await page.evaluate(() => { [...document.querySelectorAll('.tools-menu button')].find((b) => b.textContent.includes('审批与记录'))?.click(); });
  await sleep(500);
  const collabOk = await page.evaluate(() => !!document.querySelector('.task-panel .section h4'));
  ok('regression: collab panel renders', collabOk);
  // 传输抽屉：状态条「传输」按钮
  const drawer = await page.evaluate(() => {
    const b = [...document.querySelectorAll('.statusbar button, .sb-btn')].find((x) => x.textContent.includes('传输'));
    if (b) { b.click(); return true; } return false;
  });
  await sleep(400);
  const drawerOk = await page.evaluate(() => !!document.querySelector('.queue-drawer, .queue-body'));
  ok('regression: transfer drawer toggles', drawerOk, 'clicked=' + drawer);

  ok('zero JS errors (probe2)', jsErrors.length === 0, jsErrors.slice(0, 3).join(' | '));

  fs.writeFileSync(path.join(OUT, 'vis-r40-probe2-results.json'), JSON.stringify(results, null, 2));
  console.log(`\n${results.filter((r) => r.pass).length}/${results.length}`);
  await browser.close();
  process.exit(0);
})().catch((e) => { console.error('CRASH', e); process.exit(2); });
