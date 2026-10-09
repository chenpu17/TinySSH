// R34 旧码判别（基线 013dc58 :5184）：R34 六面全缺席应红——
// conflict-demo 不再待决（直走完成链）、三决策命令不存在、
// unknown-demo/interrupt-demo 落 Succeeded（无 OutcomeUnknown/Interrupted）、
// Skipped 状态不存在、demo shim 未实现 reject/verify。
const { chromium } = require('/Users/chenpu/node_modules/playwright');
const EXE = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const URL = process.env.PROBE_URL || 'http://localhost:5184/';
const results = [];
// 旧码预期：全部 FAIL（判别力 = 每项在新码 PASS、在旧码 FAIL）
const ok = (name, cond, detail = '') => { results.push({ name, pass: !!cond }); console.log((cond ? 'PASS ' : 'FAIL ') + name + (detail ? '  [' + detail + ']' : '')); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const TERMINAL_OLD = ['Succeeded', 'Failed', 'Cancelled', 'OutcomeUnknown'];

(async () => {
  const browser = await chromium.launch({ executablePath: EXE, headless: true });
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => { try { localStorage.clear(); } catch {} });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.host-card', { timeout: 10000 });
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
      return { kind: e && typeof e.kind === 'string' ? e.kind : null, message: String(e && e.message || e) };
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
  await page.evaluate(() => { [...document.querySelectorAll('.hk-mask button')].find((x) => x.textContent.includes('信任并连接'))?.click(); });
  await waitFor_(async () => (await demoInvoke('list_sessions')).find((x) => x.host_name.includes('prod-1') && x.state === 'Connected')?.id ?? null, 80);
  const sid = await demoInvoke('list_sessions').then((l) => {
    const mine = l.filter((x) => x.host_name.includes('prod-1') && x.state === 'Connected');
    return mine.sort((a, b) => (a.created_at < b.created_at ? 1 : -1))[0]?.id;
  });
  const mkUp = (tag) => demoInvoke('upload_file', { sid, local: `/Users/demo/Desktop/${tag}`, remote: `/var/log/nginx/${tag}` });
  const terminalOf = async (tid, tries = 60) => waitFor_(async () => {
    const r = (await demoInvoke('list_transfers')).find((t) => t.id === tid);
    return r && TERMINAL_OLD.includes(r.status) ? r : null;
  }, tries);

  // 1 conflict-demo：旧码无预检冲突 → 直走完成
  const t1 = await mkUp('old.conflict-demo');
  await sleep(800);
  const r1 = (await demoInvoke('list_transfers')).find((t) => t.id === t1.id);
  ok('OC1 conflict-demo stays AwaitingDecision (new-only)', !!r1 && r1.status === 'AwaitingDecision', JSON.stringify(r1 && { s: r1.status, p: r1.decision_prompt }));
  const rt1 = await terminalOf(t1.id, 30);
  ok('OC1b old-code completes conflict-demo without decision', !!rt1, rt1 && rt1.status);

  // 2-4 三决策命令：旧码 demo shim 未实现 → invalid_input「未实现该命令」
  const e2 = await demoInvokeErr('submit_collision_decision', { id: 'x', decision: 'skip', expectRevision: 1 });
  ok('OC2 submit_collision_decision reachable (new-only)', !!e2 && e2.kind !== 'invalid_input', JSON.stringify(e2));
  const e3 = await demoInvokeErr('reject_expired_decision', { id: 'x' });
  ok('OC3 reject_expired_decision reachable (new-only)', !!e3 && e3.kind !== 'invalid_input', JSON.stringify(e3));
  const e4 = await demoInvokeErr('verify_transfer_outcome', { id: 'x' });
  ok('OC4 verify_transfer_outcome reachable (new-only)', !!e4 && e4.kind !== 'invalid_input', JSON.stringify(e4));

  // 5 unknown-demo：旧码落 Succeeded（无 OutcomeUnknown 面）
  const t5 = await mkUp('old.unknown-demo');
  const r5 = await terminalOf(t5.id);
  ok('OC5 unknown-demo → OutcomeUnknown (new-only)', !!r5 && r5.status === 'OutcomeUnknown', r5 && r5.status);

  // 6 interrupt-demo：旧码无 Interrupted → Succeeded
  const t6 = await mkUp('old.interrupt-demo');
  const r6 = await terminalOf(t6.id);
  ok('OC6 interrupt-demo → Interrupted (new-only)', !!r6 && r6.status === 'Interrupted', r6 && r6.status);

  // 7 UI 冲突卡：旧码无 .xfer-conflict / 决策钮
  await page.evaluate(() => document.querySelector('.st-file')?.click());
  await sleep(1200);
  const ui = await page.evaluate(() => ({
    conflict: !!document.querySelector('.xfer-conflict'),
    skipBtn: !!document.querySelector('[data-testid="cf-skip"]'),
    reverifyBtn: !!document.querySelector('[data-testid="uo-reverify"]'),
    skippedText: [...document.querySelectorAll('.xfer-row .xfer-sub')].some((x) => x.textContent.includes('已跳过')),
    interruptedText: [...document.querySelectorAll('.xfer-row .xfer-sub')].some((x) => x.textContent.includes('已中断')),
  }));
  ok('OC7 UI conflict card present (new-only)', ui.conflict && ui.skipBtn && ui.reverifyBtn, JSON.stringify(ui));
  ok('OC7b UI Skipped/Interrupted labels (new-only)', ui.skippedText && ui.interruptedText);

  await browser.close();
  const fails = results.filter((r) => !r.pass).length;
  console.log(`\n旧码判别：${results.length - fails}/${results.length} PASS（期望全部 FAIL = 判别力成立；全部 PASS = 判别失败）`);
  process.exit(0);
})().catch((e) => { console.error('PROBE CRASH', e); process.exit(2); });
