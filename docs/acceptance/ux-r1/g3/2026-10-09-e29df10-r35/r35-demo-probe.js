// R35 demo 探针（队列抽屉、失败重试、定位、按路径入口、目录限制、并发上限）：
// 抽屉只经用户展开（后台事件只更新计数）；重试创建新任务（retry_of）；OutcomeUnknown
// 无通用重试仅重新核实；完成下载有定位；目录明确不支持；每会话 2/全局 4 排队。
// 域说明：demo 传输为页面内存域，并发闸/fail/dir 由标记注入（真实面=core r35 单测 +
// 原生冒烟 r35 的并发与目录判别），本探针不主张核心语义。
const { chromium } = require('/Users/chenpu/node_modules/playwright');
const EXE = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const URL = process.env.PROBE_URL || 'http://localhost:5183/';
const results = [];
const ok = (name, cond, detail = '') => { results.push({ name, pass: !!cond }); console.log((cond ? 'PASS ' : 'FAIL ') + name + (detail ? '  [' + detail + ']' : '')); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const TERMINAL = ['Succeeded', 'Failed', 'Cancelled', 'OutcomeUnknown', 'Skipped', 'Interrupted'];

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
  const demoInvokeErr = (cmd, args) => page.evaluate(async ({ c, a }) => {
    try {
      const { invoke } = await import('/src/adapter/bridge.ts');
      await invoke(c, a);
      return null;
    } catch (e) {
      return {
        kind: e && typeof e.kind === 'string' ? e.kind : null,
        message: e && e.message ? String(e.message) : String(e),
        detail: e && e.detail !== undefined ? e.detail : null,
      };
    }
  }, { c: cmd, a: args });
  const waitFor_ = async (fn, tries, gap = 150) => {
    for (let i = 0; i < tries; i++) { const v = await fn(); if (v) return v; await sleep(gap); }
    return null;
  };
  const row = async (tid) => demoInvoke('list_transfers').then((l) => l.find((t) => t.id === tid) || null);
  const waitStatus = async (tid, status, tries = 80) => waitFor_(async () => {
    const r = await row(tid);
    return r && r.status === status ? r : null;
  }, tries);
  const drawerOpen = () => page.evaluate(() => !!document.querySelector('.queue-drawer'));
  const sbCount = () => page.evaluate(() => {
    const b = document.querySelector('[data-testid="sb-transfer"]');
    return b ? Number((b.querySelector('b')?.textContent || '0').trim()) : -1;
  });
  const cardByName = (name) => page.evaluate((n) => {
    const r = [...document.querySelectorAll('.xfer-row')].find((x) => x.querySelector('.xfer-name')?.textContent === n);
    if (!r) return null;
    return {
      text: r.textContent,
      sub: r.querySelector('.xfer-sub')?.textContent ?? null,
      host: r.querySelector('.xfer-host')?.textContent ?? null,
      retry: !!r.querySelector('[data-testid="xfer-retry"]'),
      retryUnavailable: !!r.querySelector('[data-testid="xfer-retry-unavailable"]'),
      locate: !!r.querySelector('[data-testid="xfer-locate"]'),
      viewTarget: !!r.querySelector('[data-testid="xfer-view-target"]'),
      reverify: !!r.querySelector('[data-testid="uo-reverify"]'),
      retryTitle: r.querySelector('[data-testid="xfer-retry"]')?.getAttribute('title') ?? null,
    };
  }, name);
  const waitCard = (name, pred, tries = 20) => waitFor_(() =>
    cardByName(name).then((c) => (c && (!pred || pred(c)) ? c : null)), tries);

  // 连接 prod-1（R31/R34 同案：取 created_at 最新 Connected 会话）
  await page.evaluate(() => {
    const card = [...document.querySelectorAll('.host-card')].find((c) => c.querySelector('.host-name')?.textContent.includes('prod-1'));
    card?.querySelector('.host-connect-btn')?.click();
  });
  await page.waitForSelector('.hk-mask', { timeout: 6000 }).catch(() => {});
  await page.evaluate(() => {
    [...document.querySelectorAll('.hk-mask button')].find((x) => x.textContent.includes('信任并连接'))?.click();
  });
  await waitFor_(async () => (await demoInvoke('list_sessions')).find((x) => x.host_name.includes('prod-1') && x.state === 'Connected')?.id ?? null, 80);
  const sid = await demoInvoke('list_sessions').then((l) => {
    const mine = l.filter((x) => x.host_name.includes('prod-1') && x.state === 'Connected');
    return mine.sort((a, b) => (a.created_at < b.created_at ? 1 : -1))[0]?.id;
  });
  ok('A0 session connected', !!sid, String(sid));
  await page.evaluate(() => document.querySelector('.st-file')?.click());
  await waitFor_(async () => page.evaluate(() => !!document.querySelector('.xfer-row, .side-quiet')), 30);
  await sleep(300);

  const mkUp = (tag) => demoInvoke('upload_file', { sid, local: `/Users/demo/Desktop/${tag}`, remote: `/var/log/nginx/${tag}` });
  const mkDown = (tag) => demoInvoke('download_file', { sid, remote: `/var/log/nginx/${tag}`, local: `/Users/demo/Downloads/${tag}` });

  // ---- A 队列抽屉：只经用户展开（后台事件只更新计数，不自动展开） ----
  const openA = await drawerOpen();
  ok('A1 drawer closed initially', !openA);
  await mkUp('bg.queue-demo');
  await waitFor_(async () => (await sbCount()) >= 1, 30);
  ok('A2 background transfer updates status-bar count', (await sbCount()) >= 1, String(await sbCount()));
  ok('A3 background event does NOT auto-expand drawer', !(await drawerOpen()));
  await page.evaluate(() => document.querySelector('[data-testid="sb-transfer"]')?.click());
  await waitFor_(async () => drawerOpen(), 20);
  ok('A4 user click opens drawer', await drawerOpen());
  const hasCollapse = await page.evaluate(() => !!document.querySelector('[data-testid="queue-collapse"]'));
  ok('A5 drawer has collapse control', hasCollapse);
  await page.evaluate(() => document.querySelector('[data-testid="queue-collapse"]')?.click());
  await waitFor_(async () => !(await drawerOpen()), 20);
  ok('A6 collapse closes drawer', !(await drawerOpen()));
  await page.evaluate(() => document.querySelector('[data-testid="sb-transfer"]')?.click()); // 重新展开供后续卡面断言
  await waitFor_(async () => drawerOpen(), 20);

  // ---- B 失败重试创建新任务 ----
  const tB = await mkUp('f.fail-demo');
  const rB = await waitStatus(tB.id, 'Failed');
  ok('B1 fail-demo → Failed', !!rB && !!rB.error, JSON.stringify(rB && { s: rB.status, e: rB.error }));
  const cB = await waitCard('f.fail-demo', (c) => c.retry);
  ok('B2 failed card shows 重试 (with revalidate note)', !!cB && cB.retry && !!cB.retryTitle && cB.retryTitle.includes('重新校验'),
    cB && cB.retryTitle);
  const beforeB = (await demoInvoke('list_transfers')).length;
  await page.evaluate(() => {
    const r = [...document.querySelectorAll('.xfer-row')].find((x) => x.querySelector('.xfer-name')?.textContent === 'f.fail-demo');
    r?.querySelector('[data-testid="xfer-retry"]')?.click();
  });
  const newB = await waitFor_(async () => {
    const l = await demoInvoke('list_transfers');
    return l.find((t) => t.retry_of === tB.id) || null;
  }, 30);
  ok('B3 retry creates NEW task with retry_of=old', !!newB && newB.id !== tB.id, JSON.stringify(newB && { id: newB.id, retry_of: newB.retry_of }));
  ok('B3b old task status unchanged (not revived)', (await row(tB.id)).status === 'Failed');
  ok('B3c transfer count grew by retry', (await demoInvoke('list_transfers')).length === beforeB + 1);
  ok('B4 row shows host/session (§358)', !!cB && cB.host === 'prod-1', cB && cB.host);

  // ---- C OutcomeUnknown 无通用重试，仅重新核实 ----
  const tC = await mkUp('big.unknown-demo');
  const rC = await waitStatus(tC.id, 'OutcomeUnknown');
  ok('C1 unknown-demo → OutcomeUnknown', !!rC, JSON.stringify(rC && { s: rC.status }));
  const cC = await waitCard('big.unknown-demo', (c) => c.reverify);
  ok('C2 unknown card has 重新核实 but NO generic 重试', !!cC && cC.reverify && !cC.retry, JSON.stringify(cC && { rv: cC.reverify, rt: cC.retry }));
  ok('C2b unknown card offers 查看目标 (§374)', !!cC && cC.viewTarget, JSON.stringify(cC && { vt: cC.viewTarget }));
  const eC = await demoInvokeErr('retry_transfer', { id: tC.id });
  ok('C3 retry_transfer on unknown → invalid_transfer_state', !!eC && eC.kind === 'invalid_transfer_state', JSON.stringify(eC));
  ok('C3b no new task created by refused retry',
    !(await demoInvoke('list_transfers')).some((t) => t.retry_of === tC.id));

  // ---- D 完成下载显示「定位」 ----
  const tD = await mkDown('plain-d.bin');
  const rD = await waitStatus(tD.id, 'Succeeded');
  ok('D1 download → Succeeded', !!rD, JSON.stringify(rD && { s: rD.status }));
  const cD = await waitCard('plain-d.bin', (c) => c.locate);
  ok('D2 done download card shows 定位', !!cD && cD.locate, JSON.stringify(cD && { loc: cD.locate, sub: cD.sub }));
  const errsBefore = jsErrors.length;
  await page.evaluate(() => {
    const r = [...document.querySelectorAll('.xfer-row')].find((x) => x.querySelector('.xfer-name')?.textContent === 'plain-d.bin');
    r?.querySelector('[data-testid="xfer-locate"]')?.click();
  });
  await sleep(300);
  ok('D3 clicking 定位 produces no JS error', jsErrors.length === errsBefore, jsErrors.slice(errsBefore).join(' | ').slice(0, 200));

  // ---- E 按路径下载入口（文件面板工具行开关） ----
  const hasByPathBtn = await page.evaluate(() => !!document.querySelector('[data-testid="sftp-by-path-btn"]'));
  ok('E1 files toolbar has 按路径下载 toggle', hasByPathBtn);
  const inputBefore = await page.evaluate(() => !!document.querySelector('.xfer-input'));
  await page.evaluate(() => document.querySelector('[data-testid="sftp-by-path-btn"]')?.click());
  const inputAfter = await waitFor_(async () => page.evaluate(() => !!document.querySelector('.xfer-input')), 20);
  ok('E2 toggle reveals path-download input', !inputBefore !== !inputAfter ? true : inputAfter === !inputBefore, `before=${inputBefore} after=${inputAfter}`);
  await page.evaluate(() => document.querySelector('[data-testid="sftp-by-path-btn"]')?.click());
  await waitFor_(async () => !(await page.evaluate(() => !!document.querySelector('.xfer-input'))), 20);
  ok('E3 toggle again hides input', !(await page.evaluate(() => !!document.querySelector('.xfer-input'))));

  // ---- F 目录明确不支持（源侧） ----
  const tF = await mkUp('mydir.dir-demo');
  const rF = await waitStatus(tF.id, 'Failed');
  ok('F1 dir-demo → Failed with 目录传输不支持', !!rF && !!rF.error && rF.error.includes('目录传输不支持'), rF && rF.error);
  ok('F1b zero bytes (source-side, no staging)', !!rF && rF.bytes_done === 0, String(rF && rF.bytes_done));

  // ---- G 并发上限：每会话 2 并行，其余排队 ----
  // 清场：取消并等所有在途任务终态
  for (const t of await demoInvoke('list_transfers')) {
    if (!TERMINAL.includes(t.status)) await demoInvoke('cancel_transfer', { id: t.id }).catch(() => {});
  }
  await waitFor_(async () => (await demoInvoke('list_transfers')).every((t) => TERMINAL.includes(t.status)), 60);
  const gids = [];
  for (let i = 0; i < 5; i++) gids.push((await mkUp(`g${i}.bin`)).id);
  await sleep(700);
  const gList = await demoInvoke('list_transfers');
  const gRunning = gList.filter((t) => gids.includes(t.id) && t.status === 'Running').length;
  const gQueued = gList.filter((t) => gids.includes(t.id) && t.status === 'Queued').length;
  ok('G1 per-session parallel ≤ 2', gRunning <= 2, `running=${gRunning}`);
  ok('G2 overflow stays Queued', gQueued >= 1, `queued=${gQueued}`);
  const gCardQ = await page.evaluate(() => [...document.querySelectorAll('.xfer-row')].some((x) => (x.querySelector('.xfer-sub')?.textContent || '').includes('排队中')));
  ok('G3 queued card shows 排队中…', gCardQ);
  // 放行：等待全部完成
  const gDone = await waitFor_(async () => {
    const l = await demoInvoke('list_transfers');
    return gids.every((id) => TERMINAL.includes(l.find((t) => t.id === id)?.status)) ? true : null;
  }, 120, 250);
  ok('G4 all queued eventually complete', !!gDone, JSON.stringify((await demoInvoke('list_transfers')).filter((t) => gids.includes(t.id)).map((t) => t.status)));

  // ---- H 原会话已不在：不给必然失败的死重试钮，改「会话已不在」说明（rev-r35 中-1） ----
  const cH0 = await waitCard('f.fail-demo', (c) => c.retry);
  ok('H1 前置：会话在时失败卡有重试钮', !!cH0 && cH0.retry && !cH0.retryUnavailable, JSON.stringify(cH0 && { rt: cH0.retry, ru: cH0.retryUnavailable }));
  // demo 种子里 prod-1 已有 s-demo-0001，本探针新建的是 s-demo-0101——两个 prod-1 标签，
  // aria-label 无法区分，故按 list_sessions 顺序取标签下标（标签按 sessions 顺序渲染）。
  const hIdx = (await demoInvoke('list_sessions')).map((s) => s.id).indexOf(sid);
  await page.evaluate((i) => {
    const xs = [...document.querySelectorAll('.tab-x')];
    xs[i]?.click();
  }, hIdx);
  await waitFor_(async () => page.evaluate(() => !!document.querySelector('.confirm-dialog')), 20);
  await page.evaluate(() => {
    [...document.querySelectorAll('.confirm-dialog button')].find((b) => b.textContent?.trim() === '关闭会话')?.click();
  });
  const goneH = await waitFor_(async () =>
    !(await demoInvoke('list_sessions')).some((s) => s.id === sid) ? true : null, 40);
  ok('H2 会话已关闭（sessions 内不再有该 sid）', !!goneH);
  const cH = await waitCard('f.fail-demo', (c) => c.retryUnavailable || c.retry);
  ok('H3 会话不在 → 不渲染重试钮，改给「会话已不在」说明', !!cH && !cH.retry && cH.retryUnavailable,
    JSON.stringify(cH && { rt: cH.retry, ru: cH.retryUnavailable, sub: cH.sub }));

  ok('Z zero page errors', jsErrors.length === 0, jsErrors.join(' | ').slice(0, 300));
  const fails = results.filter((r) => !r.pass).length;
  console.log(`\n${results.length - fails}/${results.length} passed`);
  await browser.close();
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error('PROBE CRASH', e); process.exit(2); });
