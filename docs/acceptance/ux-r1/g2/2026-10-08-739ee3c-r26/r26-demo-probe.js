// R26 断线/重试/重确认/重连 探针（真实 Chromium + vite demo 后端 :5183）：
// A §6.4 自动重连计数横幅（第 N/3 次）→ 耗尽 Disconnected + dead-overlay + 键入拦截（真键盘）；
// B 手动重连成功 → Reconfirming 横幅（已重连；旧现场待核实 + Agent 暂停后缀）+ 人类可键入；
// C 自动重连成功路径（recover=2 计数推进到 2 后成功）+ 停止重试（首计后点停 → 提前 Disconnected）；
// D 关闭已断开标签：不询问断开确认，标签与会话直接移除（§6.4）；
// E R24-L5：集成关闭主机——命令框 Shell 模式拒绝 + Fresh 指引两行（demo 无注入审计）；
// Z 零 JS 错误。
// 工艺：demo 态内存态 reload 即清；invoke 走页面内 import('/src/adapter/bridge.ts')；
// 终端缓冲断言一律全缓冲扫描；term 实例经 window.__t_terms（DEV only）。
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

  const demoInvoke = (cmd, args) => page.evaluate(async ({ c, a }) => {
    const { invoke } = await import('/src/adapter/bridge.ts');
    return invoke(c, a);
  }, { c: cmd, a: args });
  const errBar = () => page.evaluate(() => [...document.querySelectorAll('.notice-bar.err')].map((x) => x.textContent).join(' || '));
  const warnBar = () => page.evaluate(() => [...document.querySelectorAll('.notice-bar.warn')].map((x) => x.textContent).join(' || '));
  const hasDeadOverlay = () => page.evaluate(() => !!document.querySelector('.dead-overlay'));
  const sessState = async (name) => {
    const list = await demoInvoke('list_sessions');
    return list.find((x) => x.host_name === name)?.state ?? 'none';
  };
  const sessStateBySid = async (sid) => {
    const list = await demoInvoke('list_sessions');
    return list.find((x) => x.id === sid)?.state ?? 'none';
  };
  const tabCount = (needle) => page.evaluate((h) => [...document.querySelectorAll('.tabbar .tab')].filter((t) => t.textContent.includes(h)).length, needle);
  const tabTitle = (needle) => page.evaluate((h) => {
    const t = [...document.querySelectorAll('.tabbar .tab')].find((x) => x.textContent.includes(h));
    return t?.getAttribute('title') ?? '';
  }, needle);
  const bufferHas = (needle) => page.evaluate((n) => {
    const w = window.__t_terms;
    if (!w) return null;
    for (const [, t] of w) {
      const el = t.element?.closest('.term-session');
      if (!el || !el.classList.contains('active')) continue;
      const b = t.buffer.active;
      let text = '';
      for (let i = 0; i < b.length; i++) text += b.getLine(i)?.translateToString(true) + '\n';
      if (text.includes(n)) return true;
    }
    return false;
  }, needle);
  const bufferHasAllSid = (sid, needles) => page.evaluate(({ sid, ns }) => {
    const w = window.__t_terms;
    if (!w) return null;
    const t = w.get(sid);
    if (!t) return 'no-term';
    const b = t.buffer.active;
    let text = '';
    for (let i = 0; i < b.length; i++) text += b.getLine(i)?.translateToString(true) + '\n';
    const missing = ns.filter((n) => !text.includes(n));
    return missing.length === 0 ? 'all' : 'missing:' + missing.join(',') + '|' + text.slice(-200);
  }, { sid, ns: needles });
  const waitFor_ = async (fn, tries, gap = 120) => {
    for (let i = 0; i < tries; i++) { const v = await fn(); if (v) return v; await sleep(gap); }
    return null;
  };
  const drop = (sid, recover) => demoInvoke('demo_drop_session', { sid, recoverOnAttempt: recover });
  const anySid = async (name) => {
    const list = await demoInvoke('list_sessions');
    return list.find((x) => x.host_name === name)?.id ?? null;
  };
  // 活动会话 sid：横幅/拦截/dead-overlay 只跟焦点会话——drop 必须打在活动会话上
  const activeSid = () => page.evaluate(() => {
    const w = window.__t_terms;
    if (!w) return null;
    for (const [sid, t] of w) {
      const el = t.element?.closest('.term-session');
      if (el && el.classList.contains('active')) return sid;
    }
    return null;
  });

  // ---- 建连 prod-1（预信任）----
  await page.evaluate(() => {
    const card = [...document.querySelectorAll('.host-card')].find((c) => c.querySelector('.host-name')?.textContent.trim() === 'prod-1');
    card?.querySelector('.host-connect-btn')?.click();
  });
  const connOk = await waitFor_(async () => (await sessState('prod-1')) === 'Connected', 40);
  ok('A0 connect prod-1', !!connOk, await sessState('prod-1'));

  // ---- A: 自动重连计数 + 耗尽 Disconnected ----
  await drop(await activeSid(), 0);
  const bannerA = await waitFor_(async () => (await errBar()).includes('自动重连中'), 40);
  ok('A1 auto-reconn banner', !!bannerA, await errBar());
  let maxA = 0;
  let deadA = false;
  for (let i = 0; i < 120; i++) {
    const m = (await errBar()).match(/第 (\d+)\/(\d+) 次/);
    if (m) maxA = Math.max(maxA, Number(m[1]));
    if (await hasDeadOverlay()) { deadA = true; break; }
    await sleep(120);
  }
  ok('A2 attempt count visible (>=1)', maxA >= 1, 'max=' + maxA);
  ok('A3 exhausted → dead-overlay', deadA, (await errBar()).slice(0, 80));
  const deadSidA = await activeSid();
  ok('A4 session Disconnected', (await sessStateBySid(deadSidA)) === 'Disconnected');
  ok('A5 tab title 已断开', await page.evaluate((sid) => {
    const t = [...document.querySelectorAll('.tabbar .tab')].find((x) => x.getAttribute('data-sid') === sid || x.title.startsWith(sid) || x.textContent.includes('prod-1'));
    const tabs = [...document.querySelectorAll('.tabbar .tab')];
    const el = tabs.find((x) => (x.getAttribute('title') ?? '').includes('已断开') && x.textContent.includes('prod-1'));
    return tabs.some((x) => x === el);
  }, deadSidA), await tabTitle('prod-1'));
  // 键入拦截（真键盘）：⚠ 键入未发送，字符不进通道
  await page.evaluate(() => document.querySelector('.term-session.active textarea')?.focus());
  await page.keyboard.type('zz', { delay: 40 });
  const warned = await waitFor_(() => bufferHas('键入未发送'), 25);
  ok('A6 dead input intercepted (⚠+no queue)', !!warned && !(await bufferHas('zz')), 'warn=' + !!warned);

  // ---- B: 手动重连成功 → Reconfirming 横幅 + 人类可键入 ----
  await page.evaluate(() => {
    const b = [...document.querySelectorAll('.dead-overlay button')].find((x) => x.textContent.includes('重连恢复'));
    b?.click();
  });
  // rev-r26 中-1 判别：手动重连窗内横幅=「手动重连中」且无停止钮
  //（旧码冒用自动语义：显示「自动重连中+停止重试」而停止被静默忽略）
  const manualWin = await waitFor_(async () => {
    const bar = await errBar();
    return bar.includes('Reconnecting') || bar.includes('手动重连中') || bar.includes('自动重连中') ? bar : null;
  }, 30);
  let m1ok = false;
  for (let i = 0; i < 20; i++) {
    const bar = await errBar();
    if (bar.includes('手动重连中')) { m1ok = !bar.includes('停止重试'); break; }
    if ((await warnBar()).includes('已重连')) break; // 窗口错过（poll 粒度）
    await sleep(60);
  }
  ok('B0 manual reconnect banner distinct (no stop btn)', m1ok, (manualWin ?? '') + ' || ' + (await errBar()).slice(0, 60));
  const reconfB = await waitFor_(async () => (await warnBar()).includes('已重连；旧现场待核实'), 40);
  ok('B1 reconfirm banner', !!reconfB, await warnBar());
  ok('B2 Agent 暂停 suffix (owner=Agent)', (await warnBar()).includes('Agent 已暂停'));
  await page.evaluate(() => document.querySelector('.term-session.active textarea')?.focus());
  await page.keyboard.type('echo r26ok', { delay: 30 });
  await page.keyboard.press('Enter');
  const typedB = await waitFor_(() => bufferHas('r26ok'), 25);
  ok('B3 human can type during Reconfirming', !!typedB, 'typed=' + !!typedB);

  // ---- C1: 自动重连成功路径（recover=2）----
  await drop(await activeSid(), 2);
  const bannerC = await waitFor_(async () => (await errBar()).includes('自动重连中'), 40);
  ok('C1 auto-reconn banner again', !!bannerC);
  let maxC = 0;
  const reconfC = await waitFor_(async () => {
    const m = (await errBar()).match(/第 (\d+)\/3 次/);
    if (m) maxC = Math.max(maxC, Number(m[1]));
    return (await warnBar()).includes('已重连；旧现场待核实');
  }, 120);
  ok('C2 auto success → Reconfirming', !!reconfC, 'maxSeen=' + maxC);
  ok('C3 counter reached 2 before success', maxC >= 2, 'maxSeen=' + maxC);

  // ---- C2: 停止重试（首计出现即停 → 提前 Disconnected）----
  await drop(await activeSid(), 0);
  const firstC = await waitFor_(async () => ((await errBar()).match(/第 (\d+)\/3 次/))?.[1], 60);
  ok('C4 stop: banner first count', !!firstC);
  await page.evaluate(() => {
    const b = [...document.querySelectorAll('.notice-bar.err button')].find((x) => x.textContent.includes('停止重试'));
    b?.click();
  });
  let stopMax = 0;
  const stopSid = await activeSid();
  const stopDisc = await waitFor_(async () => {
    const m = (await errBar()).match(/第 (\d+)\/3 次/);
    if (m) stopMax = Math.max(stopMax, Number(m[1]));
    return (await sessStateBySid(stopSid)) === 'Disconnected' && (await hasDeadOverlay());
  }, 30);
  ok('C5 stopped → early Disconnected', !!stopDisc && stopMax <= 1, 'maxAfterStop=' + stopMax + ' disc=' + !!stopDisc);

  // ---- D: 断开标签直接关（无断开确认）----
  const deadSid = await activeSid();
  const before = await tabCount('prod-1');
  const dbg = await page.evaluate(() => {
    const tabs = [...document.querySelectorAll('.tabbar .tab')];
    const t = tabs.find((x) => (x.getAttribute('title') ?? '').includes('prod-1') && (x.getAttribute('title') ?? '').includes('已断开'));
    const found = t ? (t.getAttribute('title') ?? '?') : 'NOT-FOUND';
    t?.querySelector('.tab-x')?.click();
    return { found };
  });
  console.log('D-debug', JSON.stringify(dbg));
  await sleep(500);
  const confirmShown = await page.evaluate(() => !!document.querySelector('.confirm-dialog'));
  const after = await tabCount('prod-1');
  ok('D1 close dead tab: no confirm', before - after === 1 && !confirmShown, `before=${before} after=${after} confirm=${confirmShown}`);
  const list2 = await demoInvoke('list_sessions');
  ok('D2 session removed', !list2.some((x) => x.id === deadSid));

  // ---- E: 集成关闭主机——命令框拒绝 + Fresh 指引（R24-L5）----
  await page.evaluate(() => {
    const card = [...document.querySelectorAll('.host-card')].find((c) => c.querySelector('.host-name')?.textContent.includes('noint-1'));
    card?.querySelector('.host-connect-btn')?.click();
  });
  await page.waitForSelector('.hk-mask', { timeout: 6000 }).catch(() => {});
  await page.evaluate(() => {
    const b = [...document.querySelectorAll('.hk-mask button')].find((x) => x.textContent.includes('信任并连接'));
    b?.click();
  });
  const nointSess = await waitFor_(async () => (await demoInvoke('list_sessions')).find((x) => x.host_name.includes('noint-1') && x.state === 'Connected'), 100);
  ok('E1 connect noint-1', !!nointSess);
  const nointSid = nointSess?.id ?? null;
  const noInject = await demoInvoke('audit_query', { sid: null, limit: 60 });
  const injected = noInject.events?.some((e) => e.action === 'shell_integration_inject' && e.session_id === nointSid);
  ok('E2 no injection for integration-off host', !injected);
  // 命令框作用于活动会话（headless hasFocus 不保证 attach）——显式点标签进 noint
  await page.evaluate((h) => {
    const t = [...document.querySelectorAll('.tabbar .tab')].find((x) => x.textContent.includes(h));
    t?.querySelector('.tab-label')?.click();
  }, 'noint-1');
  const actNoint = await waitFor_(() => page.evaluate(() =>
    (document.querySelector('.tab-active')?.getAttribute('title') ?? '').includes('noint-1')), 60);
  if (!actNoint) console.log('WARN noint tab not active — cmd may hit wrong session');
  await page.fill('.panel-title input', 'echo hi');
  await page.evaluate(() => {
    document.querySelector('.panel-title input')?.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  });
  await sleep(300);
  const inputVal = await page.evaluate(() => document.querySelector('.panel-title input')?.value ?? 'NO-INPUT');
  const guide = await waitFor_(() => bufferHasAllSid(nointSid, ['shell 集成', 'Fresh']), 30);
  const anyBuf = await page.evaluate(() => {
    const w = window.__t_terms;
    const out = [];
    for (const [sid, t] of w) {
      const b = t.buffer.active;
      let text = '';
      for (let i = 0; i < b.length; i++) text += b.getLine(i)?.translateToString(true) + '\n';
      if (text.includes('shell 集成') || text.includes('echo hi') || text.includes('❯')) {
        out.push({ sid, g: text.includes('shell 集成'), cmd: text.includes('echo hi'), tail: text.slice(-90) });
      }
    }
    return { active: document.querySelector('.tab-active')?.getAttribute('title'), out };
  });
  ok('E3 Shell 拒绝 + Fresh 指引两行', guide === 'all' || anyBuf.out.some((x) => x.g),
    'inputVal=' + inputVal + ' sid-guide=' + String(guide).slice(-80) + ' probe=' + JSON.stringify(anyBuf));

  // ---- Z: 零 JS 错误 ----
  ok('Z0 zero js errors', jsErrors.length === 0, jsErrors.join('||').slice(0, 200));

  console.log('SUMMARY ' + results.filter((r) => r.pass).length + '/' + results.length);
  await browser.close();
})();
