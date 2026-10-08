// R32 demo 探针（C5 传输注册表）：契约面 + UI 卡片生命周期 + 取消/失败/未知取消。
// 域说明：demo 传输为页面内存域（真实核心落 transfer_journal），页面 reload 即清——
// 「UI 重挂可对账」的真实面由原生冒烟 r32c（journal 恢复）承担，本探针不主张。
const { chromium } = require('/Users/chenpu/node_modules/playwright');
const EXE = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const URL = process.env.PROBE_URL || 'http://localhost:5183/';
const results = [];
const ok = (name, cond, detail = '') => { results.push({ name, pass: !!cond }); console.log((cond ? 'PASS ' : 'FAIL ') + name + (detail ? '  [' + detail + ']' : '')); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const TERMINAL = ['Succeeded', 'Failed', 'Cancelled', 'OutcomeUnknown'];

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
  // 错误断言面：rejection 在页面内捕获归一（R30 工艺）
  const demoInvokeErr = (cmd, args) => page.evaluate(async ({ c, a }) => {
    try {
      const { invoke } = await import('/src/adapter/bridge.ts');
      await invoke(c, a);
      return null;
    } catch (e) {
      return { kind: e && typeof e.kind === 'string' ? e.kind : null, message: e && e.message ? String(e.message) : String(e) };
    }
  }, { c: cmd, a: args });
  const waitFor_ = async (fn, tries, gap = 150) => {
    for (let i = 0; i < tries; i++) { const v = await fn(); if (v) return v; await sleep(gap); }
    return null;
  };
  const waitTerminal = async (tid, tries = 60) => waitFor_(async () => {
    const list = await demoInvoke('list_transfers');
    const row = list.find((t) => t.id === tid);
    return row && TERMINAL.includes(row.status) ? row : null;
  }, tries);
  const revHistory = (tid) => page.evaluate(async (id) => window.__R32REV__ && window.__R32REV__[id] || null, tid);

  // 连接 prod-1（传输入口需要会话）
  await page.evaluate(() => {
    const card = [...document.querySelectorAll('.host-card')].find((c) => c.querySelector('.host-name')?.textContent.includes('prod-1'));
    card?.querySelector('.host-connect-btn')?.click();
  });
  await page.waitForSelector('.hk-mask', { timeout: 6000 }).catch(() => {});
  await page.evaluate(() => {
    [...document.querySelectorAll('.hk-mask button')].find((x) => x.textContent.includes('信任并连接'))?.click();
  });
  await waitFor_(async () => (await demoInvoke('list_sessions')).find((x) => x.host_name.includes('prod-1') && x.state === 'Connected')?.id ?? null, 80);
  const sid = await demoInvoke('list_sessions').then((l) => l.find((x) => x.host_name.includes('prod-1'))?.id);
  ok('A0 session connected', !!sid, String(sid));

  // ---- A. 契约面 ----
  const list0 = await demoInvoke('list_transfers');
  ok('A1 list_transfers returns array (initially empty)', Array.isArray(list0) && list0.length === 0, JSON.stringify(list0).slice(0, 60));

  const h = await demoInvoke('upload_file', { sid, local: '/tmp/demo-a.tar.gz', remote: '/var/log/demo-a.tar.gz' });
  ok('A2 upload returns TransferHandle shape', h && typeof h.id === 'string' && h.session_id === sid && h.kind === 'Upload' && h.local === '/tmp/demo-a.tar.gz' && h.remote === '/var/log/demo-a.tar.gz', JSON.stringify(h));

  const row0 = await demoInvoke('list_transfers').then((l) => l.find((t) => t.id === h.id));
  ok('A3 registered immediately (before I/O finishes)', row0 && (row0.status === 'Queued' || row0.status === 'Running') && row0.source === '/tmp/demo-a.tar.gz' && row0.dest === '/var/log/demo-a.tar.gz' && row0.revision >= 1 && row0.session_id === sid, JSON.stringify(row0));
  const revA = row0 ? row0.revision : -1;

  const done = await waitTerminal(h.id);
  ok('A4a terminal Succeeded with full bytes', done && done.status === 'Succeeded' && done.bytes_done === done.total && done.total >= 3 * 1024 * 1024, JSON.stringify(done));
  ok('A4b finished_at set + revision monotonic', done && typeof done.finished_at === 'number' && done.revision > revA, `rev ${revA}→${done && done.revision}`);

  const hf = await demoInvoke('upload_file', { sid, local: '/tmp/fail-demo.bin', remote: '/tmp/fail-demo.bin' });
  const doneF = await waitTerminal(hf.id);
  ok('A5 failure injection → Failed + real error', doneF && doneF.status === 'Failed' && (doneF.error || '').includes('演示注入'), JSON.stringify(doneF));

  const hd = await demoInvoke('download_file', { sid, remote: '/var/log/app.log', local: null });
  const doneD = await waitTerminal(hd.id);
  ok('A6 download kind/fields', doneD && doneD.status === 'Succeeded' && doneD.kind === 'Download' && doneD.source === '/var/log/app.log', JSON.stringify(doneD));

  // 取消：发起后立刻取消（3MB≈2.3s 在途，窗口充足）
  const hc = await demoInvoke('upload_file', { sid, local: '/tmp/demo-big.bin', remote: '/tmp/demo-big.bin' });
  await demoInvoke('cancel_transfer', { id: hc.id });
  const soon = await demoInvoke('list_transfers').then((l) => l.find((t) => t.id === hc.id));
  ok('A7a cancel → Cancelling|Cancelled immediately', soon && (soon.status === 'Cancelling' || soon.status === 'Cancelled'), JSON.stringify(soon));
  const doneC = await waitTerminal(hc.id);
  ok('A7b cancel terminal → Cancelled/已取消', doneC && doneC.status === 'Cancelled' && doneC.error === '已取消', JSON.stringify(doneC));
  // 终态幂等：重复取消不报错
  const idem = await demoInvokeErr('cancel_transfer', { id: hc.id });
  ok('A7c terminal cancel idempotent (no error)', idem === null, JSON.stringify(idem));

  const errU = await demoInvokeErr('cancel_transfer', { id: 't-nope' });
  ok('A8 cancel unknown → invalid_input', errU && errU.kind === 'invalid_input', JSON.stringify(errU));

  const listN = await demoInvoke('list_transfers');
  const mine = [h.id, hf.id, hd.id, hc.id].every((id) => listN.some((t) => t.id === id));
  ok('A9 registry holds all tasks (query is authority)', listN.length >= 4 && mine, `n=${listN.length}`);

  // revision 单调性长程观察：采样窗口内所有行 revision 只增不减
  const s1 = await demoInvoke('list_transfers');
  await sleep(600);
  const s2 = await demoInvoke('list_transfers');
  const mono = s1.every((a) => { const b = s2.find((x) => x.id === a.id); return !b || b.revision >= a.revision; });
  ok('A10 revision monotonic across samples', mono, JSON.stringify(s1.concat(s2).map((t) => `${t.id.slice(-4)}:${t.revision}`)));

  // ---- B. UI 卡片生命周期（800ms 轮询 list_transfers 双路镜像）----
  await page.evaluate(() => document.querySelector('.st-file')?.click());
  const cards = await waitFor_(async () => {
    const n = await page.evaluate(() => document.querySelectorAll('.xfer-row').length);
    return n >= 3 ? n : null;
  }, 30);
  ok('B1 transfer cards visible in files panel', !!cards, `n=${await page.evaluate(() => document.querySelectorAll('.xfer-row').length)}`);
  const txt = await page.evaluate(() => [...document.querySelectorAll('.xfer-row')].map((r) => r.textContent).join(' || '));
  ok('B2 done card text (完成 · N.N MB)', /完成 · \d+\.\d+ MB/.test(txt), txt.slice(0, 220));
  ok('B3 failed card text (失败：演示注入)', txt.includes('失败：演示注入'), txt.slice(0, 220));
  ok('B4 cancelled card text (已取消)', txt.includes('已取消'), txt.slice(0, 220));

  // B5 进行中卡：新发起 3MB 上传（≈2.3s 在途），800ms 轮询窗内必见「传输中」
  await demoInvoke('upload_file', { sid, local: '/tmp/demo-live.bin', remote: '/tmp/demo-live.bin' });
  const liveTxt = await waitFor_(async () => {
    const t = await page.evaluate(() => [...document.querySelectorAll('.xfer-row .xfer-sub')].map((r) => r.textContent).join(' || '));
    return t.includes('传输中') || t.includes('排队中') ? t : null;
  }, 20, 200);
  ok('B5 running card shows 传输中/排队中', !!liveTxt, (liveTxt || '').slice(0, 220));
  // B6 运行中卡取消钮可达
  const hasBtn = await page.evaluate(() => [...document.querySelectorAll('.xfer-row')].some((r) => r.querySelector('button')));
  ok('B6 running card has cancel button', hasBtn, '');
  // B7 等它跑完再核对终态卡（面板从运行态过渡到完成态）
  await waitFor_(async () => {
    const t = await page.evaluate(() => [...document.querySelectorAll('.xfer-row .xfer-sub')].map((r) => r.textContent).join(' || '));
    return (t.match(/传输中|排队中/g) || []).length === 0 ? t : null;
  }, 40, 200);
  const quietTxt = await page.evaluate(() => [...document.querySelectorAll('.xfer-row .xfer-sub')].map((r) => r.textContent).join(' || '));
  ok('B7 panel settles to terminal-only cards', !/传输中|排队中/.test(quietTxt), quietTxt.slice(0, 220));

  ok('Z zero js errors', jsErrors.length === 0, jsErrors.join('||').slice(0, 150));

  console.log('SUMMARY ' + results.filter((r) => r.pass).length + '/' + results.length);
  await browser.close();
  process.exit(results.every((r) => r.pass) ? 0 : 1);
})();
