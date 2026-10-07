// R14 demo 探针：新工作区垂直流程（demo 后端同契约）——UI 连接 staging-1（TOFU 门）→
// 终端渲染 → send_keys/read_screen 输入输出闭环 → 双标签切换 → 工具菜单关闭确认流 →
// 会话 Disconnected + 标签回收；模块同一性护栏 + 零 JS 错误。
const { chromium } = require('/Users/chenpu/node_modules/playwright');
const EXE = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const URL = 'http://localhost:5183/';
const results = [];
const ok = (name, cond, detail = '') => { results.push({ name, pass: !!cond, detail }); console.log((cond ? 'PASS ' : 'FAIL ') + name + (detail ? '  [' + detail + ']' : '')); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
setTimeout(() => { console.log(JSON.stringify(results)); console.error('PROBE-WATCHDOG'); process.exit(3); }, 90000).unref?.();

(async () => {
  const browser = await chromium.launch({ executablePath: EXE, headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const jsErrors = [];
  page.on('pageerror', (e) => jsErrors.push(String(e)));

  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.host-card', { timeout: 8000 });
  const tabs0 = await page.$$eval('.tabbar .tab', (els) => els.length);

  // 1) UI 点卡建连 staging-1 → TOFU 信任
  const card = await page.$('.host-card:has-text("staging-1")');
  ok('D1 staging 卡片在位', !!card);
  await card.click();
  let up = true;
  try { await page.waitForSelector('.hk-mask', { timeout: 6000 }); } catch { up = false; }
  ok('D2 TOFU 门出现', up);
  if (up) {
    const trust = await page.$('.hk-mask button:has-text("信任并连接")');
    await trust.click();
  }
  // 2) 终端渲染（xterm 就绪 + 提示符内容）
  await page.waitForSelector('.tabbar .tab', { timeout: 8000 });
  await sleep(600);
  const termOk = await page.evaluate(async () => {
    const demo = await import('/src/demo.ts');
    const ss = await demo.invoke('list_sessions');
    const s = ss.find((x) => x.host_id === 'h-staging1' && x.state === 'Connected');
    if (!s) return null;
    const hasTerm = !!document.querySelector('.xterm');
    return { sid: s.id, hasTerm };
  });
  ok('D3 staging Connected + xterm 渲染', !!(termOk && termOk.hasTerm), JSON.stringify(termOk));
  // 3) 输入/输出闭环（invoke 级 send_keys + read_screen）
  const io = await page.evaluate(async () => {
    const demo = await import('/src/demo.ts');
    const ss = await demo.invoke('list_sessions');
    const s = ss.find((x) => x.host_id === 'h-staging1' && x.state === 'Connected');
    const MK = 'R14DEMOMARK';
    await demo.invoke('send_keys', { sid: s.id, keys: 'echo ' + MK + '\r' });
    await new Promise((r) => setTimeout(r, 400));
    const snap = await demo.invoke('read_screen', { sid: s.id });
    return { hit: snap.text.includes(MK), sid: s.id };
  });
  ok('D4 输入输出闭环（echo 标记回显）', io.hit === true, JSON.stringify(io));
  // 4) 双标签切换
  const tabSw = await page.evaluate(async () => {
    const tabs = () => [...document.querySelectorAll('.tabbar .tab')];
    if (tabs().length < 2) return { n: tabs().length };
    tabs()[0].click();
    await new Promise((r) => setTimeout(r, 350));
    const a0 = tabs()[0].classList.contains('tab-active');
    tabs()[1].click();
    await new Promise((r) => setTimeout(r, 350));
    const a1 = tabs()[1].classList.contains('tab-active');
    return { a0, a1 };
  });
  ok('D5 双标签切换激活态', tabSw.a0 === true && tabSw.a1 === true, JSON.stringify(tabSw));
  // 5) 关闭会话：先激活最新标签（新连的 Connected 会话——种子死会话不走确认流）
  await page.evaluate(() => {
    const tabs = [...document.querySelectorAll('.tabbar .tab')];
    tabs[tabs.length - 1].click();
  });
  await sleep(350);
  await page.click('.session-toolbar button[aria-haspopup="menu"]');
  await sleep(300);
  const closeItem = await page.$('[role="menuitem"]:has-text("关闭会话")');
  ok('D6 关闭菜单项在位', !!closeItem);
  if (closeItem) {
    await closeItem.click();
    await sleep(300);
    const danger = await page.$('.confirm-mask button.danger');
    ok('D7 关闭确认弹窗', !!danger);
    if (danger) {
      await danger.click();
      await sleep(600);
      const fin = await page.evaluate(async (sid) => {
        const demo = await import('/src/demo.ts');
        const ss = await demo.invoke('list_sessions');
        const s = ss.find((x) => x.id === sid);
        return { state: s ? s.state : 'gone', tabs: document.querySelectorAll('.tabbar .tab').length };
      }, io.sid);
      ok('D8 会话关闭（Disconnected/移除）', fin.state === 'Disconnected' || fin.state === 'gone', JSON.stringify(fin));
      // demo 后端保留死会话标签（tab-dot.dim 状态点，可经标签列表重连）；原生后端销毁回收——
      // 断言派生一致性：dim 状态点数 === Disconnected 会话数
      const cons = await page.evaluate(async () => {
        const demo = await import('/src/demo.ts');
        const ss = await demo.invoke('list_sessions');
        const dim = document.querySelectorAll('.tabbar .tab-dot.dim').length;
        return { dim, dead: ss.filter((s) => s.state === 'Disconnected').length };
      });
      ok('D9 标签状态点派生一致（dim===Disconnected 数）', cons.dim === cons.dead && cons.dead >= 1, JSON.stringify(cons));
    }
  }
  // 6) 模块同一性 + 零 JS 错误
  const ident = await page.evaluate(async () => {
    const demo = await import('/src/demo.ts');
    return (await demo.invoke('list_sessions')).length;
  });
  const tabsNow = await page.$$eval('.tabbar .tab', (els) => els.length);
  ok('D10 模块同一性（直调会话数≥UI 标签数，死会话不入标签）', ident >= tabsNow, 'direct=' + ident + ' tabs=' + tabsNow);
  ok('Z 零 JS 错误', jsErrors.length === 0, jsErrors.join(' | ').slice(0, 300));
  console.log(JSON.stringify(results));
  const fails = results.filter((r) => !r.pass);
  console.log(fails.length ? 'PROBE-FAIL ' + fails.length : 'PROBE-ALL-PASS ' + results.length);
  await browser.close();
  process.exit(fails.length ? 1 : 0);
})().catch((e) => { console.error('PROBE-ERROR', String(e).slice(0, 400)); process.exit(2); });
