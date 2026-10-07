// R15 C8 偏好/元数据 demo 探针（真实 Chromium + vite demo 后端，与产品同一 invoke 通道）：
// A 旧键一次性迁入 blob（UI 跟随收起、旧键保留）；
// B blob 整取驱动 UI（跨 reload 宽度 250）；
// C demo 契约面（模块同实例直调）：schema 归一 99→1、收藏落位、未知主机拒绝、
//   recents 派生序（种子 prod>staging；UI 真实连一次 staging → 升首）/排除 local/上限/形状、
//   建连打点 last_connected_at、字号命名空间键；零 JS 错误。
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

  // ---- A 旧键一次性迁入 blob ----
  console.log('.. A 迁移');
  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => {
    localStorage.clear();
    localStorage.setItem('ui.hostbar', '0');
    localStorage.setItem('ui.hostbar_w', '260');
  });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => localStorage.getItem('ui.v2.workspace') !== null, null, { timeout: 8000 }).catch(() => {});
  const blob = await page.evaluate(() => { try { return JSON.parse(localStorage.getItem('ui.v2.workspace')); } catch { return null; } });
  ok('A1 迁移写 blob open=false', !!(blob && blob.hostbar && blob.hostbar.open === false), JSON.stringify(blob));
  ok('A2 迁移 width=260 且 schema=1', !!(blob && blob.hostbar && blob.hostbar.width === 260 && blob.schema_version === 1), JSON.stringify(blob));
  ok('A3 旧键保留', await page.evaluate(() => localStorage.getItem('ui.hostbar') === '0' && localStorage.getItem('ui.hostbar_w') === '260'));
  await page.waitForSelector('.hostbar', { state: 'detached', timeout: 4000 }).catch(() => {});
  ok('A4 hostbar 收起（UI 跟随迁移值）', (await page.$('.hostbar')) === null);
  ok('A5 可发现展开钮在位', !!(await page.$('.hb-expand')));

  // ---- B blob 整取驱动 UI（跨 reload）----
  console.log('.. B blob 驱动');
  await page.evaluate(() => localStorage.setItem('ui.v2.workspace', JSON.stringify({ schema_version: 1, chrome: 'dark', hostbar: { open: true, width: 250 } })));
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.hostbar', { timeout: 8000 }).catch(() => {});
  const w = await page.$eval('.hostbar', (el) => el.getBoundingClientRect().width).catch(() => -1);
  ok('B1 blob 宽度驱动 250', Math.round(w) === 250, String(w));

  // ---- C demo 契约面 ----
  console.log('.. C 契约');
  const cErr = await page.evaluate(async () => {
    const out = {};
    try {
      const demo = await import('/src/demo.ts');
      const inv = demo.invoke;
      const ws = await inv('set_workspace', { ws: { schema_version: 99, chrome: 'light', hostbar: { open: true, width: 250 } } });
      out.norm = ws.schema_version;
      await inv('set_host_favorite', { hostId: 'h-prod1', favorite: true });
      const meta = await inv('list_host_metadata');
      out.fav = (meta.find((m) => m.host_id === 'h-prod1') || {}).favorite;
      try { await inv('set_host_favorite', { hostId: 'h-none', favorite: true }); out.unknown = 'no-error'; }
      catch (e) { out.unknown = String((e && e.kind) || e).slice(0, 60); }
      const r0 = await inv('list_recent_hosts');
      out.r0 = r0.map((x) => x.host_name);
    } catch (e) { return 'ERR ' + String(e).slice(0, 200); }
    window.__r15 = out;
    return null;
  });
  if (cErr) ok('C 契约面执行', false, cErr);
  else {
    const c = await page.evaluate(() => window.__r15);
    ok('C1 schema 99→1 归一', c.norm === 1, String(c.norm));
    ok('C2 收藏落位 h-prod1', c.fav === true);
    ok('C3 未知主机拒绝 invalid_input', c.unknown === 'invalid_input', c.unknown);
    ok('C4 recents 初始序 [prod-1, staging-1]', JSON.stringify(c.r0) === JSON.stringify(['prod-1', 'staging-1']), JSON.stringify(c.r0));
  }

  // ---- D UI 真实连接 staging-1 → recents 升首 + 建连打点 ----
  console.log('.. D UI 连接');
  const card = await page.$('.host-card:has-text("staging-1")');
  ok('D0 staging 卡片在位', !!card);
  if (card) {
    await card.click();
    // TOFU 遮罩经 App 500ms 轮询渲染，须显式等待（此前 if(!mask) break 在其出现前即退出）
    let maskUp = true;
    try { await page.waitForSelector('.hk-mask', { timeout: 6000 }); } catch { maskUp = false; }
    if (maskUp) {
      for (let i = 0; i < 20; i++) {
        const authInput = await page.$('.hk-mask input[type="password"], .hk-mask input[type="text"]');
        if (authInput && (await authInput.isVisible().catch(() => false))) {
          await authInput.fill('654321');
          const submit = await page.$('.hk-mask button:has-text("提交验证")');
          if (submit) { await submit.click(); await sleep(400); continue; }
        }
        const trust = await page.$('.hk-mask button:has-text("信任并连接")');
        if (trust && (await trust.isVisible().catch(() => false))) { await trust.click(); await sleep(400); continue; }
        if (!(await page.$('.hk-mask'))) break;
        await sleep(400);
      }
    }
    // 等建连落位（recents 升首）再读
    for (let i = 0; i < 15; i++) {
      const probe = await page.evaluate(async () => (await (await import('/src/demo.ts')).invoke('list_recent_hosts')).map((x) => x.host_name));
      if (probe[0] === 'staging-1') break;
      await sleep(400);
    }
    const d = await page.evaluate(async () => {
      const demo = await import('/src/demo.ts');
      const r1 = await demo.invoke('list_recent_hosts');
      const meta2 = await demo.invoke('list_host_metadata');
      return {
        r1: r1.map((x) => x.host_name),
        cap: r1.length <= 5,
        noLocal: r1.every((x) => x.host_id !== 'local'),
        shape: r1.every((x) => x.host_id && x.host_name && x.connected_at),
        touch: (meta2.find((m) => m.host_id === 'h-staging1') || {}).last_connected_at != null,
      };
    });
    ok('D1 再连 staging-1 升首（最近性序）', d.r1[0] === 'staging-1', JSON.stringify(d.r1));
    ok('D2 上限≤5 / 排除 local / 形状齐', d.cap === true && d.noLocal === true && d.shape === true, JSON.stringify({ cap: d.cap, noLocal: d.noLocal, shape: d.shape }));
    ok('D3 建连打点 last_connected_at', d.touch === true);
    // 模块同一性护栏：直调读到的会话数必须与 App UI 标签数一致（HMR ?t= 双实例曾致误判）
    const tabs = await page.$$eval('.tabbar .tab', (els) => els.length).catch(() => -1);
    const sessN = await page.evaluate(async () => (await (await import('/src/demo.ts')).invoke('list_sessions')).length);
    ok('D4 模块同一性（直调会话数=UI 标签数）', sessN === tabs, 'tabs=' + tabs + ' direct=' + sessN);
  }

  // ---- 收尾：恢复演示域默认外观 + 零 JS 错误 ----
  await page.evaluate(async () => {
    const demo = await import('/src/demo.ts');
    await demo.invoke('set_workspace', { ws: { schema_version: 1, chrome: 'dark', hostbar: { open: true, width: 224 } } });
    localStorage.removeItem('ui.v2.terminal.font_size');
  }).catch(() => {});
  ok('Z 零 JS 错误', jsErrors.length === 0, jsErrors.join(' | ').slice(0, 300));
  console.log(JSON.stringify(results));
  const fails = results.filter((r) => !r.pass);
  console.log(fails.length ? 'PROBE-FAIL ' + fails.length : 'PROBE-ALL-PASS ' + results.length);
  await browser.close();
  process.exit(fails.length ? 1 : 0);
})().catch((e) => { console.error('PROBE-ERROR', String(e).slice(0, 400)); process.exit(2); });
