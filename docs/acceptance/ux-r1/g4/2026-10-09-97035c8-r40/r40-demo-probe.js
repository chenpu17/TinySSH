// R40 demo 探针（端口转发表单、列表与生命周期 §6.6 / S09 / D01-D02）：
// 类型解释为人类语义（-L/-R/-D 辅助）；监听地址是显式字段（默认回环）；非回环需主动确认；
// 目标标注解析端；字段级错误（端口冲突/格式）就地高亮；监听成功与目标可达分开显示；
// 停止等待核心结果；关闭会话展示受影响转发数。
// 域说明：demo 转发为页面内存注册表（无真实监听），端口占用由 demo_forward_conflict 钩子
// 注入（真实面=transport-ssh sshd_e2e 的真流量 + 端口冲突字段错误 + core r40_tests）。
const { chromium } = require('/Users/chenpu/node_modules/playwright');
const EXE = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const URL = process.env.PROBE_URL || 'http://localhost:5183/';
const results = [];
const ok = (name, cond, detail = '') => { results.push({ name, pass: !!cond }); console.log((cond ? 'PASS ' : 'FAIL ') + name + (detail ? '  [' + detail + ']' : '')); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const browser = await chromium.launch({ executablePath: EXE, headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();
  const jsErrors = [];
  page.on('pageerror', (e) => jsErrors.push(String(e)));
  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => { try { localStorage.clear(); } catch {} });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.host-card', { timeout: 10000 });
  await sleep(400);

  const demoInvoke = (cmd, args) => page.evaluate(async ({ c, a }) => {
    const { invoke } = await import('/src/adapter/bridge.ts');
    return invoke(c, a);
  }, { c: cmd, a: args });
  const waitFor_ = async (fn, tries, gap = 150) => {
    for (let i = 0; i < tries; i++) { const v = await fn(); if (v) return v; await sleep(gap); }
    return null;
  };
  const connectHost = async (needle) => {
    await page.evaluate((n) => {
      const card = [...document.querySelectorAll('.host-card')].find((c) => c.querySelector('.host-name')?.textContent.includes(n));
      card?.querySelector('.host-connect-btn')?.click();
    }, needle);
    await page.waitForSelector('.hk-mask', { timeout: 4000 }).catch(() => {});
    await page.evaluate(() => {
      [...document.querySelectorAll('.hk-mask button')].find((x) => x.textContent.includes('信任并连接'))?.click();
    });
    return waitFor_(async () => (await demoInvoke('list_sessions')).find((x) => x.host_name.includes(needle) && x.state === 'Connected')?.id ?? null, 60);
  };
  const setNativeValue = (sel, value) => page.evaluate(({ sel, value }) => {
    const el = document.querySelector(sel);
    if (!el) return;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }, { sel, value });
  // 按下标设 .fwd-form input.mono（旧码表单结构不同→越界即跳过，不崩）
  const setIdx = (idx, value) => page.evaluate(({ idx, value }) => {
    const ins = [...document.querySelectorAll('.fwd-form input.mono')];
    if (!ins[idx]) return;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(ins[idx], value);
    ins[idx].dispatchEvent(new Event('input', { bubbles: true }));
  }, { idx, value });
  const setSelect = (sel, value) => page.evaluate(({ sel, value }) => {
    const el = document.querySelector(sel);
    if (!el) return;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set;
    setter.call(el, value);
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }, { sel, value });

  const openTools = () => page.evaluate(() => {
    [...document.querySelectorAll('.st-tools button')].find((b) => b.textContent.includes('工具'))?.click();
  });
  const openForwards = async () => {
    await openTools();
    await sleep(150);
    await page.evaluate(() => {
      [...document.querySelectorAll('.tools-menu button')].find((b) => b.textContent.includes('端口转发'))?.click();
    });
    return waitFor_(async () => page.evaluate(() => !!document.querySelector('.fwd-form')), 30);
  };
  const openCloseSession = async () => {
    await openTools();
    await sleep(150);
    await page.evaluate(() => {
      [...document.querySelectorAll('.tools-menu button')].find((b) => b.textContent.includes('关闭会话'))?.click();
    });
  };
  const fwdRows = () => page.$$eval('.fwd-row', (rs) => rs.map((r) => ({
    kind: r.querySelector('.fwd-kind')?.textContent || '',
    route: r.querySelector('.xfer-name')?.textContent || '',
    state: r.querySelector('.fwd-state')?.textContent || '',
    sub: r.querySelector('.xfer-sub')?.textContent || '',
    hasCheck: !!r.querySelector('.ok'),
  })));
  const fieldErr = (which) => page.$eval(`[data-testid="fwd-err-${which}"]`, (e) => e.textContent).catch(() => null);
  const startBtn = () => page.evaluate(() => {
    [...document.querySelectorAll('.section button')].find((b) => b.textContent.trim() === '启动转发')?.click();
  });

  // 连接 prod-1（demo connect 新建会话，取 created_at 最新 Connected）
  await connectHost('prod-1');
  const sidNew = await waitFor_(async () => {
    const l = await demoInvoke('list_sessions');
    const mine = l.filter((x) => x.host_name.includes('prod-1') && x.state === 'Connected');
    return mine.sort((a, b) => (a.created_at < b.created_at ? 1 : -1))[0]?.id ?? null;
  }, 20);
  ok('A0 session connected', !!sidNew, String(sidNew));

  // ---- A 表单（§6.6）----
  const opened = await openForwards();
  ok('A1 forwards panel opens', !!opened);
  // A2 类型 select 三项解释为人类语义（保留 -L/-R/-D 辅助）
  const opts = await page.$$eval('.fwd-form select option', (os) => os.map((o) => o.textContent));
  ok('A2 type options explain semantics', opts.length === 3
    && opts[0].includes('本地端口访问远端服务') && opts[0].includes('-L')
    && opts[1].includes('远端端口访问本机服务') && opts[1].includes('-R')
    && opts[2].includes('SOCKS5') && opts[2].includes('-D'), JSON.stringify(opts));
  // A3 监听地址是显式字段，默认回环 127.0.0.1
  const laddrVal = await page.$eval('.fwd-form input.mono', (i) => i.value).catch(() => null);
  ok('A3 listen address explicit, default loopback', laddrVal === '127.0.0.1', String(laddrVal));

  // A4 目标解析端标注随类型变化（-L=远端侧解析 / -R=本机侧解析）
  const labelL = await page.$$eval('.fwd-form label', (ls) => ls.map((l) => l.textContent));
  ok('A4a -L target labelled "远端侧解析"', labelL.some((t) => t.includes('目标（远端侧解析）')), JSON.stringify(labelL));
  await setSelect('.fwd-form select', 'Remote');
  await sleep(120);
  const labelR = await page.$$eval('.fwd-form label', (ls) => ls.map((l) => l.textContent));
  ok('A4b -R target labelled "本机侧解析"', labelR.some((t) => t.includes('目标（本机侧解析）')), JSON.stringify(labelR));
  await setSelect('.fwd-form select', 'Local');
  await sleep(120);

  // A5 空监听端口 → 字段级错误（监听字段），不建转发
  const n0 = (await demoInvoke('list_forwards', { sid: sidNew })).length;
  await setNativeValue('.fwd-form input.mono', '127.0.0.1'); // 地址
  await setIdx(1, ''); // 端口输入是第二个 input.mono
  await startBtn();
  await sleep(150);
  const eListen = await fieldErr('listen');
  ok('A5 empty listen port → field error on listen', !!eListen && eListen.includes('监听端口'), String(eListen));
  ok('A5b no forward created', (await demoInvoke('list_forwards', { sid: sidNew })).length === n0);

  // A6 空目标 → 字段级错误（目标字段）
  await setIdx(1, '8080');
  await startBtn();
  await sleep(150);
  const eTarget = await fieldErr('target');
  ok('A6 empty target → field error on target', !!eTarget && eTarget.includes('目标主机'), String(eTarget));

  // A7 非回环监听 → 暴露范围确认行；未勾选时启动被拦（字段错误含"暴露范围"）
  await setNativeValue('.fwd-form input.mono', '0.0.0.0');
  await sleep(120);
  const exposeVisible = await page.evaluate(() => !!document.querySelector('[data-testid="fwd-expose"]'));
  ok('A7a non-loopback shows exposure notice', exposeVisible);
  await startBtn();
  await sleep(150);
  const eExpose = await fieldErr('listen');
  ok('A7b start blocked until exposure confirmed', !!eExpose && eExpose.includes('暴露范围'), String(eExpose));
  // 勾选确认 → 可启动
  await page.evaluate(() => { document.querySelector('[data-testid="fwd-expose"] input')?.click(); });
  await sleep(120);

  // ---- B 启动 + 列表状态分离 ----
  await setNativeValue('.fwd-form input.mono', '127.0.0.1');
  await sleep(80);
  await setIdx(2, '10.0.0.31');
  await setIdx(3, '5432');
  await startBtn();
  const oneRow = await waitFor_(async () => { const r = await fwdRows(); return r.length === 1 ? r : null; }, 20);
  ok('B1 forward created in list', !!oneRow, JSON.stringify(oneRow));
  if (oneRow) {
    ok('B2 route human-readable', oneRow[0].route.includes('127.0.0.1:8080') && oneRow[0].route.includes('10.0.0.31:5432'), oneRow[0].route);
    ok('B3 listening vs reachable separated', oneRow[0].state === '监听中' && oneRow[0].sub.includes('目标可达性未验证'), oneRow[0].state + ' | ' + oneRow[0].sub);
    ok('B4 no health-implying checkmark', oneRow[0].hasCheck === false, String(oneRow[0].hasCheck));
    ok('B5 kind badge -L', oneRow[0].kind === '-L', oneRow[0].kind);
  }

  // ---- C 端口冲突 → 字段定位（demo_forward_conflict 钩子）----
  await demoInvoke('demo_forward_conflict', { ports: [9090] }).catch(() => {}); // 旧码无此钩子
  // 目标字段在 B 成功后已清空——重新填入，确保校验走到核心（而非 FE 目标空校验）
  await setIdx(1, '9090');
  await setIdx(2, '10.0.0.31');
  await setIdx(3, '5432');
  await startBtn();
  await sleep(200);
  const eConflict = await fieldErr('listen');
  ok('C1 port conflict → field error on listen', !!eConflict && eConflict.includes('占用'), String(eConflict));
  ok('C2 conflict creates no forward', (await fwdRows()).length === 1);
  await demoInvoke('demo_forward_conflict', { ports: [] }).catch(() => {});

  // ---- D SOCKS5 行（无目标）+ 停止 ----
  await setSelect('.fwd-form select', 'Dynamic');
  await sleep(120);
  await setIdx(1, '1080');
  await startBtn();
  const twoRows = await waitFor_(async () => { const r = await fwdRows(); return r.length === 2 ? r : null; }, 20);
  ok('D1 SOCKS5 row created', !!twoRows);
  if (twoRows) {
    const d = twoRows.find((r) => r.kind === '-D');
    ok('D2 SOCKS5 route has no target', !!d && d.route.includes('SOCKS5 127.0.0.1:1080') && !d.route.includes('→'), d ? d.route : 'none');
  }
  // 停止第一行 → 行消失（等待核心结果）
  await page.evaluate(() => {
    const rows = [...document.querySelectorAll('.fwd-row')];
    const b = rows[0] && [...rows[0].querySelectorAll('button')].find((x) => x.textContent.trim() === '停止');
    b?.click();
  });
  const oneAfterStop = await waitFor_(async () => { const r = await fwdRows(); return r.length === 1 ? r : null; }, 25);
  ok('D3 stop removes row (waits core result)', !!oneAfterStop && oneAfterStop[0].kind === '-D', JSON.stringify(oneAfterStop));

  // ---- E 关闭会话影响计数 ----
  await openCloseSession();
  const impact = await waitFor_(async () => page.$eval('.confirm-dialog', (d) => d.textContent).catch(() => null), 20);
  ok('E1 close-session shows affected forwards count', !!impact && impact.includes('转发') && impact.includes('1 条'), impact ? impact.slice(0, 120) : 'none');
  await page.evaluate(() => { document.querySelector('.confirm-mask')?.click(); });

  ok('Z zero JS errors', jsErrors.length === 0, jsErrors.slice(0, 3).join(' | '));
  const passed = results.filter((r) => r.pass).length;
  console.log(`\n${passed}/${results.length}`);
  await browser.close();
  process.exit(passed === results.length ? 0 : 1);
})().catch((e) => { console.error('PROBE CRASH', e); process.exit(2); });
