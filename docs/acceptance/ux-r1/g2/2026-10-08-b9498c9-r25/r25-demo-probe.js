// R25 搜索/复制粘贴/多标签/双分屏 探针（真实 Chromium + vite demo 后端 :5183）：
// A 搜索全链（⌘F 入口/计数/Esc 关闭清高亮+焦点回终端——R01 Esc 残留闭环）；
// B §318 粘贴保护四路：多行+无 bracketed→确认框（取消零字节/发送达远端）、
//   单行直发、远端 DECSET 2004 后多行直发、设置关闭后直发（阈值=含换行）；
// C §322/§185/§324 分屏：菜单复用已有会话/标签选择替换焦点窗格（非恒主 pane）/
//   退出分屏不断开/「在右侧新建会话」武装自动落右/360 宽退化单窗格+一次性提示+加宽恢复；
// D §330 断线旧画面可选中复制（dead-overlay 不再阻断指针，横幅仍可点）；
// E §316 IME 组合期不触发应用命令。
const { chromium } = require('/Users/chenpu/node_modules/playwright');
const EXE = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const URL = 'http://localhost:5183/';
const results = [];
const ok = (name, cond, detail = '') => { results.push({ name, pass: !!cond, detail }); console.log((cond ? 'PASS ' : 'FAIL ') + name + (detail ? '  [' + detail + ']' : '')); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
setTimeout(() => { console.log(JSON.stringify(results)); console.error('PROBE-WATCHDOG'); process.exit(3); }, 300000).unref?.();

(async () => {
  const browser = await chromium.launch({ executablePath: EXE, headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, permissions: ['clipboard-read', 'clipboard-write'] });
  const page = await ctx.newPage();
  const jsErrors = [];
  page.on('pageerror', (e) => jsErrors.push(String(e)));
  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => { try { localStorage.clear(); } catch {} });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.host-card', { timeout: 10000 });

  const $ = (sel) => page.evaluate((s) => !!document.querySelector(s), sel);
  const clickTab = (name) => page.evaluate((h) => {
    const t = [...document.querySelectorAll('.tabbar .tab')].find((x) => x.textContent.includes(h));
    if (!t) return false;
    t.querySelector('.tab-label')?.click();
    return true;
  }, name);
  const cardBtn = (host, sel) => page.evaluate(({ h, s }) => {
    const card = [...document.querySelectorAll('.host-card')].find((c) => c.querySelector('.host-name')?.textContent.trim() === h);
    const b = card?.querySelector(s);
    if (!b || b.disabled) return null;
    b.click();
    return true;
  }, { h: host, s: sel });
  const maskKind = () => page.evaluate(() => {
    const m = document.querySelector('.hk-mask');
    if (!m) return null;
    return m.textContent.includes('首次连接确认') ? 'tofu' : m.textContent.includes('双因素') ? '2fa' : 'other';
  });
  const submit2fa = async () => {
    await page.waitForSelector('.hk-mask input', { timeout: 6000 });
    await page.fill('.hk-mask input', '424242');
    await page.click('.hk-mask button:has-text("提交验证")');
    await page.waitForSelector('.hk-mask', { state: 'detached', timeout: 6000 }).catch(() => {});
    await sleep(500);
  };
  const toasts = () => page.evaluate(() => [...document.querySelectorAll('.toast')].map((t) => t.textContent).join('|'));
  const paneTags = () => page.evaluate(() => ({
    left: document.querySelector('.pane-left .pane-tag')?.textContent ?? null,
    right: document.querySelector('.pane-right .pane-tag')?.textContent ?? null,
    activeCount: document.querySelectorAll('.term-session.active').length,
    paneLeft: !!document.querySelector('.pane-left'),
  }));
  const activeTerm = () => page.evaluate(() => {
    const w = window.__t_terms;
    if (!w) return null;
    const sessEl = (t) => t.element?.closest('.term-session');
    for (const [sid, t] of w) {
      const el = sessEl(t);
      if (el && (el.classList.contains('active') || el.classList.contains('pane-focused'))) {
        return { sid, modes: t.modes };
      }
    }
    return null;
  });
  const bufferHas = (needle) => page.evaluate((n) => {
    const w = window.__t_terms;
    if (!w) return null;
    for (const [, t] of w) {
      const b = t.buffer.active;
      let text = '';
      for (let i = 0; i < b.length; i++) text += b.getLine(i)?.translateToString(true) + '\n';
      if (text.includes(n)) return true;
    }
    return false;
  }, needle);
  const sendPasteKey = () => page.evaluate(() => {
    const ta = document.querySelector('.term-session.active textarea, .term-session.pane-focused textarea')
      ?? document.querySelector('.xterm textarea');
    ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'v', metaKey: true, bubbles: true, cancelable: true }));
  });
  const setClipboard = (t) => page.evaluate((x) => navigator.clipboard.writeText(x), t);
  const readClipboard = () => page.evaluate(() => navigator.clipboard.readText());
  const writeActiveTerm = (s) => page.evaluate((x) => {
    const w = window.__t_terms;
    if (!w) return false;
    for (const [, t] of w) {
      const el = t.element?.closest('.term-session');
      if (el && (el.classList.contains('active') || el.classList.contains('pane-focused'))) { t.write(x); return true; }
    }
    return false;
  }, s);

  // ---- 准备：prod-1（种子会话 A）attach + otp-1 连接（B）----
  await clickTab('prod-1');
  await sleep(600);
  await cardBtn('otp-1（演示 2FA）', '.host-connect-btn');
  await page.waitForSelector('.hk-mask', { timeout: 5000 });
  if ((await maskKind()) === 'tofu') {
    await page.click('.hk-mask button:not(.ghost)');
    await sleep(300);
  }
  await submit2fa();
  const tabsAfterPrep = await page.evaluate(() => document.querySelectorAll('.tabbar .tab').length);
  ok('P0 准备：两标签为 prod-1/staging-1 + otp-1', tabsAfterPrep === 3, String(tabsAfterPrep));

  // ---- A 搜索全链 ----
  await clickTab('prod-1');
  await sleep(500);
  await page.evaluate(() => {
    const w = window.__t_terms;
    for (const [, t] of w) {
      const el = t.element?.closest('.term-session');
      if (el && el.classList.contains('active')) { t.write('\r\nops@prod-1:~$ echo r25searchmark\r\nr25searchmark\r\nops@prod-1:~$ '); return; }
    }
  });
  await sleep(300);
  await page.evaluate(() => {
    const b = [...document.querySelectorAll('.session-toolbar button')].find((x) => x.getAttribute('aria-label') === '搜索终端内容');
    b?.click();
  });
  await page.waitForSelector('.term-search input', { timeout: 4000 });
  await page.fill('.term-search input', 'r25searchmark');
  await sleep(400);
  const counter = await page.evaluate(() => document.querySelector('.term-search .dim')?.textContent ?? '');
  ok('A1 搜索命中计数（decorations 开启）', /^\d+\/\d+$/.test(counter.trim()) && !counter.includes('无结果'), counter);
  const decoDuring = await page.evaluate(() => document.querySelectorAll('.xterm-decoration').length);
  await page.press('.term-search input', 'Escape');
  await sleep(300);
  const decoAfter = await page.evaluate(() => document.querySelectorAll('.xterm-decoration').length);
  const searchClosed = await page.evaluate(() => !document.querySelector('.term-search'));
  const focusBack = await page.evaluate(() => {
    const ae = document.activeElement;
    return !!ae && (ae.classList.contains('xterm-helper-textarea') || !!ae.closest('.xterm'));
  });
  ok('A2 Esc 关闭搜索条 + 焦点回终端', searchClosed && focusBack, `closed=${searchClosed} focus=${focusBack}`);
  ok('A3 高亮无残留（R01 闭环：匹配装饰随关闭清除；空容器为 addon 管理不可见残留）', decoDuring > 0 ? decoAfter === 0 : true, `during=${decoDuring} after=${decoAfter}`);

  // ---- B §318 粘贴保护 ----
  await clickTab('prod-1');
  await sleep(400);
  // B1 多行 + 无 bracketed → 确认框；取消 = 零字节
  await setClipboard('echo p1line1\necho p2line2');
  await sendPasteKey();
  await page.waitForSelector('.paste-dialog', { timeout: 4000 });
  const dlgText = await page.evaluate(() => document.querySelector('.paste-dialog')?.textContent ?? '');
  ok('B1a 多行粘贴确认框含目标主机与预览', dlgText.includes('prod-1') && dlgText.includes('p1line1') && dlgText.includes('bracketed'), dlgText.slice(0, 120));
  await page.evaluate(() => [...document.querySelectorAll('.paste-dialog button')].find((b) => b.textContent.trim() === '取消')?.click());
  await sleep(300);
  const b1gone = await page.evaluate(() => !document.querySelector('.paste-dialog'));
  const b1silent = await bufferHas('p1line1');
  ok('B1b 取消后零字节（终端无内容）', b1gone && b1silent === false, `gone=${b1gone} leaked=${b1silent}`);
  // B2 再粘贴 → 发送（真实鼠标点击：命中测试证明——rev-r25 H1 处置闭环，
  // 合成 .click() 绕过命中测试照不到遮罩盖按钮的缺陷）
  await sendPasteKey();
  await page.waitForSelector('.paste-dialog', { timeout: 4000 });
  const sendBB = await page.locator('.paste-dialog button:has-text("发送")').boundingBox();
  if (!sendBB) { ok('B2 确认后全文发送（回显达终端）', false, 'send-btn-not-found'); }
  else {
    await page.mouse.click(sendBB.x + sendBB.width / 2, sendBB.y + sendBB.height / 2);
    await sleep(300);
    const b2closed = await page.evaluate(() => !document.querySelector('.paste-dialog'));
    await sleep(500);
    ok('B2 真实点击发送命中（对话框关闭 + 全文达终端）', b2closed && await bufferHas('p1line1') && await bufferHas('p2line2'), `closed=${b2closed}`);
  }
  // B3 单行直发无对话框
  await setClipboard('echo singleok25');
  await sendPasteKey();
  await sleep(700);
  ok('B3 单行直发（无确认框）', await page.evaluate(() => !document.querySelector('.paste-dialog')) && await bufferHas('singleok25'));
  // B4 远端 DECSET 2004 → 多行直发
  await writeActiveTerm('\x1b[?2004h');
  await sleep(200);
  const bracketOn = await page.evaluate(() => { const a = window.__t_terms; for (const [, t] of a) { const el = t.element?.closest('.term-session'); if (el && el.classList.contains('active')) return t.modes.bracketedPasteMode; } return null; });
  await setClipboard('echo brline1\necho brline2');
  await sendPasteKey();
  await sleep(700);
  ok('B4 bracketed paste 开启后多行直发', bracketOn === true && await page.evaluate(() => !document.querySelector('.paste-dialog')) && await bufferHas('brline1'), `mode=${bracketOn}`);
  await writeActiveTerm('\x1b[?2004l');
  // B5 设置关闭保护 → 多行直发
  await page.evaluate(() => {
    const b = [...document.querySelectorAll('button')].find((x) => x.getAttribute('aria-label') === '显示设置');
    b?.click();
  });
  await page.waitForSelector('.term-settings', { timeout: 4000 });
  const cb = page.locator('.term-settings input[type=checkbox]');
  ok('B5a 设置含粘贴保护开关（默认开）', (await cb.isChecked()) === true);
  await cb.uncheck();
  await sleep(400);
  await page.press('.term-settings input', 'Escape');
  await sleep(200);
  await clickTab('prod-1');
  await sleep(300);
  await setClipboard('echo offline1\necho offline2');
  await sendPasteKey();
  await sleep(700);
  const b5noguard = await page.evaluate(() => !document.querySelector('.paste-dialog')) && await bufferHas('offline1');
  ok('B5b 关闭保护后多行直发（立即发送如实）', b5noguard);
  // 恢复开关（持久化副证：重开设置应仍为关→再开）
  await page.evaluate(() => {
    const b = [...document.querySelectorAll('button')].find((x) => x.getAttribute('aria-label') === '显示设置');
    b?.click();
  });
  await page.waitForSelector('.term-settings', { timeout: 4000 });
  ok('B5c 开关状态落盘（重开设置仍为关）', (await page.locator('.term-settings input[type=checkbox]').isChecked()) === false);
  await page.locator('.term-settings input[type=checkbox]').check();
  await page.press('.term-settings input', 'Escape');
  await sleep(200);

  // ---- C 分屏（§322/§185/§324）----
  await clickTab('prod-1');
  await sleep(400);
  // C1 菜单复用已有会话
  await page.evaluate(() => {
    const b = [...document.querySelectorAll('.session-toolbar button')].find((x) => (x.title ?? '').startsWith('分屏：'));
    b?.click();
  });
  await page.waitForSelector('.split-menu', { timeout: 4000 });
  const menuText = await page.evaluate(() => document.querySelector('.split-menu')?.textContent ?? '');
  ok('C1a 分屏菜单双语义（复用说明 + 新建入口）', menuText.includes('在右侧显示已有会话') && menuText.includes('复用') && menuText.includes('在右侧新建会话'), menuText.slice(0, 100));
  await page.evaluate(() => {
    const item = [...document.querySelectorAll('.split-menu .sm-item')].find((b) => b.textContent.includes('otp-1'));
    item?.click();
  });
  await sleep(600);
  const p1 = await paneTags();
  ok('C1b 复用已有会话入右副 pane（左主不动）', p1.left === 'prod-1' && p1.right.startsWith('otp-1') && !p1.activeCount, JSON.stringify(p1));
  // C2 标签选择替换焦点窗格（§322：非恒主 pane）
  await page.evaluate(() => document.querySelector('.pane-right')?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })));
  await sleep(400);
  const focusedRight = await page.evaluate(() => !!document.querySelector('.pane-right.pane-focused'));
  await cardBtn('otp-2（演示 2FA 隐）', '.host-connect-btn');
  await page.waitForSelector('.hk-mask', { timeout: 5000 }).catch(() => {});
  if (await page.$('.hk-mask')) {
    if ((await maskKind()) === 'tofu') { await page.click('.hk-mask button:not(.ghost)'); await sleep(300); }
    await submit2fa();
  }
  await sleep(600);
  const p2 = await paneTags();
  ok('C2 焦点在右 pane 时新建连接替换右 pane（左主保留）', focusedRight && p2.left === 'prod-1' && p2.right.startsWith('otp-2'), `focusRight=${focusedRight} ${JSON.stringify(p2)}`);
  // C3 退出分屏不断开会话（§324）
  await page.evaluate(() => {
    const b = [...document.querySelectorAll('.session-toolbar button')].find((x) => x.title === '退出分屏（会话保留不断开）');
    b?.click();
  });
  await sleep(500);
  const p3 = await paneTags();
  const tabs3 = await page.evaluate(() => document.querySelectorAll('.tabbar .tab').length);
  ok('C3 退出分屏：布局移除 + 全部会话标签保留', !p3.paneLeft && tabs3 === 4, `tabs=${tabs3}`);
  // C4 在右侧新建会话：武装 → 新建自动落右
  await page.evaluate(() => {
    const b = [...document.querySelectorAll('.session-toolbar button')].find((x) => (x.title ?? '').startsWith('分屏：'));
    b?.click();
  });
  await page.waitForSelector('.split-menu', { timeout: 4000 });
  await page.evaluate(() => {
    [...document.querySelectorAll('.split-menu .sm-item')].find((b) => b.textContent.includes('在右侧新建会话'))?.click();
  });
  await sleep(300);
  const armToast = await toasts();
  await cardBtn('otp-1（演示 2FA）', '.host-connect-btn');
  await page.waitForSelector('.hk-mask', { timeout: 5000 });
  if ((await maskKind()) === 'tofu') { await page.click('.hk-mask button:not(.ghost)'); await sleep(300); }
  await submit2fa();
  await sleep(600);
  const p4 = await paneTags();
  const t4 = await toasts();
  ok('C4 武装后新建会话自动落右侧分屏且聚焦', p4.left.startsWith('otp-2') && p4.right.startsWith('otp-1') && t4.includes('右侧分屏'), JSON.stringify(p4));
  // C5 §185 宽度退化：窄窗单窗格 + 提示；加宽恢复
  await page.setViewportSize({ width: 640, height: 800 });
  await sleep(500);
  const p5 = await paneTags();
  const hint = await page.evaluate(() => document.querySelector('.split-hint')?.textContent ?? null);
  ok('C5a 窄窗退化单窗格 + 一次性布局提示', p5.paneLeft === false && p5.activeCount === 1 && (hint ?? '').includes('退化'), `panes=${JSON.stringify(p5)} hint=${hint?.slice(0, 40)}`);
  await page.evaluate(() => document.querySelector('.split-hint button')?.click());
  await sleep(200);
  const hintClosed = await page.evaluate(() => !document.querySelector('.split-hint'));
  await page.setViewportSize({ width: 1280, height: 800 });
  await sleep(500);
  const p6 = await paneTags();
  const hintAfter = await page.evaluate(() => !!document.querySelector('.split-hint'));
  ok('C5b 加宽恢复双窗格；已关提示不打扰（§185 显示一次）', p6.paneLeft && p6.left.startsWith('otp-2') && p6.right.startsWith('otp-1') && hintClosed && !hintAfter, `hintClosed=${hintClosed} hintAfter=${hintAfter} ${JSON.stringify(p6)}`);
  // C5c 再退化：提示不重现（会话内一次——rev-r25 M1 处置闭环）
  await page.setViewportSize({ width: 640, height: 800 });
  await sleep(500);
  const p7 = await paneTags();
  const hint2nd = await page.evaluate(() => !!document.querySelector('.split-hint'));
  ok('C5c 关闭后再退化提示不重现（§185 显示一次）', p7.paneLeft === false && p7.activeCount === 1 && !hint2nd, `hint2nd=${hint2nd} ${JSON.stringify(p7)}`);
  await page.setViewportSize({ width: 1280, height: 800 });
  await sleep(500);

  // ---- D §330 断线旧画面可选中复制 ----
  await page.evaluate(() => {
    const b = [...document.querySelectorAll('.session-toolbar button')].find((x) => x.title === '退出分屏（会话保留不断开）');
    b?.click();
  });
  await sleep(400);
  await clickTab('staging-1');
  await sleep(600);
  const deadVisible = await page.evaluate(() => !!document.querySelector('.dead-overlay'));
  const peOverlay = await page.evaluate(() => getComputedStyle(document.querySelector('.dead-overlay')).pointerEvents);
  const peBanner = await page.evaluate(() => getComputedStyle(document.querySelector('.dead-banner')).pointerEvents);
  ok('D1 断线横幅在且不再阻断终端指针（画面可选中）', deadVisible && peOverlay === 'none' && peBanner === 'auto', `overlay=${peOverlay} banner=${peBanner}`);
  await page.evaluate(() => {
    const w = window.__t_terms;
    for (const [, t] of w) {
      const el = t.element?.closest('.term-session');
      if (el && el.classList.contains('active')) { t.write('deploy@staging-1:~$ echo hello-r25-select\r\n'); return; }
    }
  });
  await sleep(400);
  // 双击选中目标词（按行文本计算列位）→ ⌘C → 剪贴板
  const selBox = await page.evaluate(() => {
    const w = window.__t_terms;
    let term = null;
    for (const [, t] of w) { const el = t.element?.closest('.term-session'); if (el && el.classList.contains('active')) term = t; }
    const rowsRoot = document.querySelector('.term-session.active .xterm-rows');
    if (!rowsRoot || !term) return null;
    const rows = [...rowsRoot.children];
    for (let i = rows.length - 1; i >= 0; i--) {
      const txt = rows[i].textContent ?? '';
      const idx = txt.indexOf('hello-r25-select');
      if (idx < 0) continue;
      const r = rows[i].getBoundingClientRect();
      const cellW = r.width / term.cols;
      return { x: r.left + (idx + 4) * cellW, y: r.top + r.height / 2 };
    }
    return null;
  });
  const d2debug = selBox ? '' : await page.evaluate(() => {
    const rr = document.querySelector('.term-session.active .xterm-rows');
    const w = window.__t_terms;
    let buf = '';
    for (const [, t] of w) {
      const el = t.element?.closest('.term-session');
      if (el && el.classList.contains('active')) {
        const b = t.buffer.active;
        for (let i = 0; i < Math.min(b.length, 30); i++) buf += b.getLine(i)?.translateToString(true) + '|';
      }
    }
    return `rowsRoot=${!!rr} rows=${rr ? rr.children.length : -1} buf=${buf.slice(0, 150)}`;
  });
  if (!selBox) { ok('D2 断线画面选中复制（§330 旧画面可复制）', false, 'row-not-found ' + d2debug); }
  else {
    await page.mouse.dblclick(selBox.x, selBox.y);
    await sleep(200);
    const hasSel = await page.evaluate(() => { const a = window.__t_terms; for (const [, t] of a) { const el = t.element?.closest('.term-session'); if (el && el.classList.contains('active')) return t.hasSelection(); } return null; });
    await page.evaluate(() => {
      const ta = document.querySelector('.term-session.active textarea');
      ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'c', metaKey: true, bubbles: true, cancelable: true }));
    });
    await sleep(400);
    const clip = await readClipboard();
    ok('D2 断线画面选中复制（§330 旧画面可复制）', hasSel === true && clip.includes('hello-r25-select'), `sel=${hasSel} clip=${clip.slice(0, 40)}`);
  }

  // ---- E §316 IME 组合期不触发应用命令 ----
  await clickTab('prod-1');
  await sleep(400);
  const imeResult = await page.evaluate(() => {
    const ta = document.querySelector('.term-session.active textarea');
    const before = document.querySelector('.term-search') ?? null;
    ta.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: 'ni' }));
    ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'ni', keyCode: 229, bubbles: true, cancelable: true }));
    ta.dispatchEvent(new CompositionEvent('compositionupdate', { bubbles: true, data: '你' }));
    ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Process', keyCode: 229, bubbles: true, cancelable: true }));
    ta.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '你' }));
    const during = document.querySelector('.term-search');
    return { unchanged: (before === null) === (during === null), termFocused: document.activeElement === ta };
  });
  ok('E1 IME 组合期不触发应用命令（搜索未误开，焦点不丢）', imeResult.unchanged && imeResult.termFocused, JSON.stringify(imeResult));

  // ---- F alternate screen 搜索作用域（直控 DECSET 1049，无 PTY 回声噪声）----
  await clickTab('prod-1');
  await sleep(400);
  // 自带新鲜主屏标记（重挂载 checkpoint 重建会冲掉早期内容——R11 有界重放环）
  await page.evaluate(() => {
    const w = window.__t_terms;
    for (const [, t] of w) {
      const el = t.element?.closest('.term-session');
      if (el && el.classList.contains('active')) { t.write('\r\nnormark-f3\r\n' + '\x1b[?1049h' + 'altmark25-f1\r\n'); return; }
    }
  });
  await sleep(300);
  const f1type = await page.evaluate(() => {
    const w = window.__t_terms;
    for (const [, t] of w) {
      const el = t.element?.closest('.term-session');
      if (el && el.classList.contains('active')) return t.buffer.active.type;
    }
    return null;
  }) === 'alternate';
  await page.evaluate(() => {
    [...document.querySelectorAll('.session-toolbar button')].find((x) => x.getAttribute('aria-label') === '搜索终端内容')?.click();
  });
  await page.waitForSelector('.term-search input', { timeout: 4000 });
  await page.fill('.term-search input', 'normark-f3');
  await sleep(400);
  const f1noLeak = await page.evaluate(() => (document.querySelector('.term-search .dim')?.textContent ?? '').includes('无结果'));
  await page.fill('.term-search input', 'altmark25');
  await sleep(400);
  const f2hit = await page.evaluate(() => /^\d+\/\d+$/.test((document.querySelector('.term-search .dim')?.textContent ?? '').trim()) && !(document.querySelector('.term-search .dim')?.textContent ?? '').includes('无结果'));
  await page.press('.term-search input', 'Escape');
  await sleep(200);
  await page.evaluate(() => {
    const w = window.__t_terms;
    for (const [, t] of w) {
      const el = t.element?.closest('.term-session');
      if (el && el.classList.contains('active')) { t.write('\x1b[?1049l'); return; }
    }
  });
  await sleep(300);
  const f3 = await page.evaluate(() => {
    const w = window.__t_terms;
    for (const [, t] of w) {
      const el = t.element?.closest('.term-session');
      if (el && el.classList.contains('active')) return t.buffer.active.type;
    }
    return null;
  });
  let f3ok = f3 === 'normal';
  if (f3ok) {
    f3ok = await page.evaluate(() => {
      const w = window.__t_terms;
      for (const [, t] of w) {
        const el = t.element?.closest('.term-session');
        if (el && el.classList.contains('active')) {
          const b = t.buffer.active;
          let text = '';
          for (let i = 0; i < b.length; i++) text += b.getLine(i)?.translateToString(true) + '\n';
          return text.includes('normark-f3') && !text.includes('altmark25');
        }
      }
      return false;
    });
  }
  ok('F1 alt 屏激活且搜索不漏主屏（作用域=活动缓冲）', f1type && f1noLeak, `type=${f1type} noLeak=${f1noLeak}`);
  ok('F2 alt 屏内命中计数', f2hit);
  ok('F3 1049l 恢复主屏（标记仍在、alt 内容清除）', f3ok, `type=${f3}`);

  // ---- C6 rev-r25 L1：武装标记在无当前会话的连接上消费（不意外分屏）----
  await page.evaluate(() => {
    const b = [...document.querySelectorAll('.session-toolbar button')].find((x) => x.title === '退出分屏（会话保留不断开）');
    b?.click();
  });
  await sleep(400);
  await page.evaluate(() => {
    const b = [...document.querySelectorAll('.session-toolbar button')].find((x) => (x.title ?? '').startsWith('分屏：'));
    b?.click();
  });
  await page.waitForSelector('.split-menu', { timeout: 4000 });
  await page.evaluate(() => {
    [...document.querySelectorAll('.split-menu .sm-item')].find((b) => b.textContent.includes('在右侧新建会话'))?.click();
  });
  await sleep(200);
  // 全关所有标签（逐个 × + 确认）→ 欢迎页（武装标记留存、无会话）
  for (let i = 0; i < 8; i++) {
    const hasTab = await page.evaluate(() => !!document.querySelector('.tabbar .tab .tab-x'));
    if (!hasTab) break;
    await page.evaluate(() => document.querySelector('.tabbar .tab .tab-x')?.click());
    await page.waitForSelector('.confirm-dialog', { timeout: 4000 }).catch(() => {});
    await page.evaluate(() => [...document.querySelectorAll('.confirm-dialog button')].find((b) => b.textContent.trim() === '关闭会话')?.click());
    await sleep(400);
  }
  const welcomeBack = await page.evaluate(() => !!document.querySelector('.welcome-actions'));
  await cardBtn('prod-1', '.host-connect-btn');
  await sleep(1000);
  const c6a = await page.evaluate(() => !!document.querySelector('.pane-left'));
  await cardBtn('otp-1（演示 2FA）', '.host-connect-btn');
  await page.waitForSelector('.hk-mask', { timeout: 5000 });
  if ((await maskKind()) === 'tofu') { await page.click('.hk-mask button:not(.ghost)'); await sleep(300); }
  await submit2fa();
  await sleep(500);
  const c6b = await page.evaluate(() => !!document.querySelector('.pane-left'));
  ok('C6 武装标记在无当前会话时消费：两次新建均不意外分屏（rev-r25 L1 闭环）', welcomeBack && !c6a && !c6b, `welcome=${welcomeBack} split1=${c6a} split2=${c6b}`);

  ok('Z1 零 JS 错误', jsErrors.length === 0, jsErrors.join(' | ').slice(0, 200));
  console.log('SUMMARY ' + results.filter((r) => r.pass).length + '/' + results.length);
  await browser.close();
  process.exit(results.every((r) => r.pass) ? 0 : 1);
})();
