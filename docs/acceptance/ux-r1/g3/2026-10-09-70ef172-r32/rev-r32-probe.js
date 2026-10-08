// rev-r32 adversarial probes (independent of author's 22 assertions)
const { chromium } = require('/Users/chenpu/node_modules/playwright');
const EXE = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const URL = 'http://localhost:5183/';
let pass = 0, fail = 0;
const P = (name, ok, detail) => { console.log(`${ok ? 'PASS' : 'FAIL'} ${name} [${JSON.stringify(detail).slice(0, 300)}]`); ok ? pass++ : fail++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const browser = await chromium.launch({ executablePath: EXE, headless: true });
  const page = await browser.newPage();
  const jsErrors = [];
  page.on('pageerror', (e) => jsErrors.push(String(e.message).slice(0, 200)));
  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => { try { localStorage.clear(); } catch {} });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.host-card', { timeout: 10000 });
  await sleep(600);
  const inv = (cmd, args) => page.evaluate(async ({ c, a }) => {
    const { invoke } = await import('/src/adapter/bridge.ts');
    return invoke(c, a);
  }, { c: cmd, a: args });
  // connect demo session
  await page.evaluate(() => {
    const card = [...document.querySelectorAll('.host-card')].find((c) => c.textContent.includes('demo'));
    card?.querySelector('.host-connect-btn')?.click();
  });
  await page.waitForFunction(() => document.querySelector('.tabbar') !== null, { timeout: 15000 }).catch(() => {});
  await sleep(1500);

  // probe 1: 5 concurrent tasks — independence + sort order
  const handles = [];
  for (let i = 0; i < 5; i++) {
    handles.push(await inv('upload_file', { sid: null, local: `/tmp/rev5-${i}.bin`, remote: `/var/log/rev5-${i}.bin` }).catch((e) => ({ err: String(e) })));
  }
  // need real sid — retry with the connected session id
  const sess = await inv('list_sessions', {});
  const s0 = Array.isArray(sess) ? sess.find((x) => x.state === 'Connected') : null;
  for (let i = 0; i < 5; i++) {
    handles[i] = await inv('upload_file', { sid: s0.id, local: `/tmp/rev5-${i}.bin`, remote: `/var/log/rev5-${i}.bin` });
  }
  await sleep(400);
  let mid = await inv('list_transfers', {});
  const mine = mid.filter((t) => handles.some((h) => h && h.id === t.id));
  P('R1a all 5 registered', mine.length === 5, mine.map((t) => `${t.id}:${t.status}:${t.bytes_done}`));
  const badCross = mine.filter((t) => !t.source.startsWith('/tmp/rev5-') || !t.dest.startsWith('/var/log/rev5-'));
  P('R1b no source/dest cross-contamination', badCross.length === 0, badCross.map((t) => t.id));
  // wait all terminal
  let final = [];
  for (let i = 0; i < 60; i++) {
    final = (await inv('list_transfers', {})).filter((t) => handles.some((h) => h && h.id === t.id));
    if (final.length === 5 && final.every((t) => ['Succeeded', 'Failed', 'Cancelled'].includes(t.status))) break;
    await sleep(300);
  }
  P('R1c all 5 reach Succeeded independently', final.length === 5 && final.every((t) => t.status === 'Succeeded' && t.bytes_done === t.total), final.map((t) => `${t.id.slice(-2)}:${t.status}:${t.bytes_done}/${t.total}`));
  const sorted = [...final].sort((a, b) => b.created_at - a.created_at);
  const listAll = await inv('list_transfers', {});
  const idxOk = listAll.every((t, i, arr) => i === 0 || arr[i - 1].created_at >= t.created_at);
  P('R1d registry sorted created_at desc', idxOk, listAll.map((t) => t.created_at).slice(0, 8));

  // probe 2: cancel mid-flight preserves partial bytes (demo contract)
  const big = await inv('upload_file', { sid: (await inv('list_sessions', {})).find((x) => x.state === 'Connected').id, local: '/tmp/rev-cancel.bin', remote: '/var/log/rev-cancel.bin' });
  let snapshot = null;
  for (let i = 0; i < 40; i++) {
    const l = await inv('list_transfers', {});
    snapshot = l.find((t) => t.id === big.id);
    if (snapshot && snapshot.bytes_done > 500000) break;
    await sleep(100);
  }
  await inv('cancel_transfer', { id: big.id });
  let cancelled = null;
  for (let i = 0; i < 30; i++) {
    const l = await inv('list_transfers', {});
    cancelled = l.find((t) => t.id === big.id);
    if (cancelled && cancelled.status === 'Cancelled') break;
    await sleep(150);
  }
  P('R2a cancel mid-flight terminal Cancelled', cancelled && cancelled.status === 'Cancelled', cancelled && `${cancelled.bytes_done}/${cancelled.total}`);
  P('R2b partial bytes preserved (0 < done < total)', cancelled && cancelled.bytes_done > 0 && cancelled.bytes_done < cancelled.total, cancelled && `${cancelled.bytes_done}/${cancelled.total}`);

  // probe 3: after terminal settle, new task must not drop old cards (FE panel)
  await sleep(1200); // let demo 800ms poll reconcile
  const beforeCards = await page.evaluate(() => document.querySelectorAll('.xfer-row').length);
  const nl = await inv('list_transfers', {});
  P('R3a panel cards == registry size (reconciled)', beforeCards === nl.length, { cards: beforeCards, registry: nl.length });
  const s2 = (await inv('list_sessions', {})).find((x) => x.state === 'Connected').id;
  await inv('upload_file', { sid: s2, local: '/tmp/rev-new.bin', remote: '/var/log/rev-new.bin' });
  await sleep(2000);
  const listAfter = await inv('list_transfers', {});
  const cardsAfter = await page.evaluate(() => document.querySelectorAll('.xfer-row').length);
  P('R3b new task added, old cards retained', listAfter.length === nl.length + 1 && cardsAfter >= listAfter.length - 1, { registryBefore: nl.length, registryAfter: listAfter.length, cards: cardsAfter });
  const ids = await page.evaluate(() => [...document.querySelectorAll('.xfer-row .xfer-name')].map((e) => e.textContent));
  P('R3c old card names still visible', ids.some((n) => n && n.includes('demo-a')) || ids.length >= 5, ids);

  // probe 4: cancel during Queued window (before first step tick) — must never reach Succeeded
  const q = await inv('upload_file', { sid: s2, local: '/tmp/rev-q.bin', remote: '/var/log/rev-q.bin' });
  await inv('cancel_transfer', { id: q.id });
  let qf = null;
  for (let i = 0; i < 30; i++) {
    const l = await inv('list_transfers', {});
    qf = l.find((t) => t.id === q.id);
    if (qf && ['Cancelled', 'Succeeded'].includes(qf.status)) break;
    await sleep(100);
  }
  P('R4 queued-window cancel → Cancelled (never Succeeded)', qf && qf.status === 'Cancelled', qf && qf.status);

  P('Z zero js errors', jsErrors.length === 0, jsErrors);
  console.log(`SUMMARY ${pass}/${pass + fail}`);
  await browser.close();
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
