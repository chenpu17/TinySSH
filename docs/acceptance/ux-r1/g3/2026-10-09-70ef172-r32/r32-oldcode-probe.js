// R32 旧码判别探针（基线 ddd9d60，:5184）：C5 面在旧码上逐项缺失/报错。
// 每一项 = 新契约断言在旧码上必红（判别力证明）；全部红 = 基线无 C5 面。
const { chromium } = require('/Users/chenpu/node_modules/playwright');
const EXE = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const URL = process.env.PROBE_URL || 'http://localhost:5184/';
const results = [];
const ok = (name, cond, detail = '') => { results.push({ name, pass: !!cond }); console.log((cond ? 'PASS ' : 'FAIL ') + name + (detail ? '  [' + detail + ']' : '')); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const browser = await chromium.launch({ executablePath: EXE, headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();
  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => { try { localStorage.clear(); } catch {} });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.host-card', { timeout: 10000 });
  await sleep(400);

  // 安全壳：rejection 在页面内捕获归一（旧码未知命令 default 抛 apiError 对象）
  const safeInvoke = async (cmd, args) => page.evaluate(async ({ c, a }) => {
    try {
      const { invoke } = await import('/src/adapter/bridge.ts');
      return { ok: true, v: await invoke(c, a) };
    } catch (e) {
      return { ok: false, kind: e && typeof e.kind === 'string' ? e.kind : null, message: e && e.message ? String(e.message) : String(e) };
    }
  }, { c: cmd, a: args });
  const waitFor_ = async (fn, tries, gap = 150) => {
    for (let i = 0; i < tries; i++) { const v = await fn(); if (v) return v; await sleep(gap); }
    return null;
  };

  await page.evaluate(() => {
    const card = [...document.querySelectorAll('.host-card')].find((c) => c.querySelector('.host-name')?.textContent.includes('prod-1'));
    card?.querySelector('.host-connect-btn')?.click();
  });
  await page.waitForSelector('.hk-mask', { timeout: 6000 }).catch(() => {});
  await page.evaluate(() => {
    [...document.querySelectorAll('.hk-mask button')].find((x) => x.textContent.includes('信任并连接'))?.click();
  });
  const sid = await waitFor_(async () => {
    const r = await safeInvoke('list_sessions');
    return r.ok ? (r.v.find((x) => x.host_name.includes('prod-1') && x.state === 'Connected')?.id ?? null) : null;
  }, 80);
  ok('A0 session connected (baseline sanity)', !!sid, String(sid));

  // D1：list_transfers 命令面缺失（抛错=注册表查询不存在）
  const d1 = await safeInvoke('list_transfers');
  ok('D1 list_transfers absent on baseline', !d1.ok, d1.ok ? 'unexpectedly present: ' + JSON.stringify(d1.v).slice(0, 80) : d1.kind + '|' + d1.message.slice(0, 80));

  // D2：upload_file 拒绝（旧演示域无传输模拟）
  const d2 = await safeInvoke('upload_file', { sid, local: '/tmp/x.bin', remote: '/tmp/x.bin' });
  ok('D2 upload_file rejected on baseline', !d2.ok, d2.ok ? 'unexpectedly ok' : d2.kind + '|' + d2.message.slice(0, 80));

  // D3：download_file 拒绝
  const d3 = await safeInvoke('download_file', { sid, remote: '/var/log/app.log', local: null });
  ok('D3 download_file rejected on baseline', !d3.ok, d3.ok ? 'unexpectedly ok' : d3.kind + '|' + d3.message.slice(0, 80));

  // D4：cancel_transfer 旧码静默 null（与 note_terminal 同案「占位反馈」伪影——无任务可取消也不报错）
  const d4 = await safeInvoke('cancel_transfer', { id: 't-nope' });
  ok('D4 cancel_transfer silent no-op on baseline (no registry error)', d4.ok === true && d4.v === null, JSON.stringify(d4).slice(0, 80));

  // D5：UI 无传输卡片能力——打开文件面板（旧码 .st-file 存在 T41），无 xfer-row（无任务引擎）
  await page.evaluate(() => document.querySelector('.st-file')?.click());
  await sleep(800);
  const nCards = await page.evaluate(() => document.querySelectorAll('.xfer-row').length);
  ok('D5 no transfer cards on baseline (nothing can run)', nCards === 0, `n=${nCards}`);

  console.log('SUMMARY ' + results.filter((r) => r.pass).length + '/' + results.length);
  await browser.close();
  process.exit(results.every((r) => r.pass) ? 0 : 1);
})();
