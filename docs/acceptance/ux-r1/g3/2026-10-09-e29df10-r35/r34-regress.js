// R34 demo 探针（C6 冲突/并发/提交仲裁与恢复）：冲突卡、三裁决、revision 守卫、
// recheck 两轮、OutcomeUnknown+重核、Skipped/Interrupted、待决取消、零 JS 错。
// 域说明：demo 传输为页面内存域，conflict/recheck/unknown/interrupt 由目标名
// 标记注入（真实面=原生冒烟 r34 的 C13 故障注入 + journal 恢复），本探针不主张。
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
  const waitStatus = async (tid, status, tries = 60) => waitFor_(async () => {
    const r = await row(tid);
    return r && r.status === status ? r : null;
  }, tries);

  // 连接 prod-1（R31 同案：取 created_at 最新 Connected 会话）
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
  await page.evaluate(() => document.querySelector('[data-testid="sb-transfer"]')?.click());
  await waitFor_(async () => page.evaluate(() => !!document.querySelector('.xfer-row, .side-quiet')), 30);
  await sleep(400);

  const mkUp = (tag) => demoInvoke('upload_file', {
    sid,
    local: `/Users/demo/Desktop/${tag}`,
    remote: `/var/log/nginx/${tag}`,
  });
  const cardByName = (name) => page.evaluate((n) => {
    const r = [...document.querySelectorAll('.xfer-row')].find((x) => x.querySelector('.xfer-name')?.textContent === n);
    if (!r) return null;
    return {
      text: r.textContent,
      conflict: !!r.querySelector('.xfer-conflict'),
      conflictText: r.querySelector('.xfer-conflict')?.textContent ?? null,
      skip: !!r.querySelector('[data-testid="cf-skip"]'),
      overwrite: !!r.querySelector('[data-testid="cf-overwrite"]'),
      keepboth: !!r.querySelector('[data-testid="cf-keepboth"]'),
      overwriteTitle: r.querySelector('[data-testid="cf-overwrite"]')?.getAttribute('title') ?? null,
      reverify: !!r.querySelector('[data-testid="uo-reverify"]'),
      keepNote: r.textContent.includes('temp 与恢复资料保留'),
      cancelX: !!r.querySelector('button[title="取消传输"]'),
      sub: r.querySelector('.xfer-sub')?.textContent ?? null,
    };
  }, name);

  // ---- A 冲突卡呈现（预检冲突，零字节传输） ----
  // UI 卡片走 800ms 轮询镜像（demo 域），断言一律轮询到渲染为止
  const waitCard = (name, pred, tries = 14) => waitFor_(() =>
    cardByName(name).then((c) => (c && (!pred || pred(c)) ? c : null)), tries);
  const tA = await mkUp('site.conflict-demo');
  const rA = await waitStatus(tA.id, 'AwaitingDecision');
  ok('A1 conflict-demo → AwaitingDecision (wire)', !!rA, JSON.stringify(rA && { s: rA.status, rev: rA.revision }));
  ok('A2 prompt structured (target_exists, stat 2048@1790000000)',
    !!rA && rA.decision_prompt && rA.decision_prompt.reason === 'target_exists'
    && rA.decision_prompt.target_path === '/var/log/nginx/site.conflict-demo'
    && rA.decision_prompt.target_stat && rA.decision_prompt.target_stat.size === 2048
    && rA.decision_prompt.target_stat.mtime === 1790000000,
    JSON.stringify(rA && rA.decision_prompt));
  ok('A3 zero bytes transferred (preflight before data phase)', !!rA && rA.bytes_done === 0, String(rA && rA.bytes_done));
  const cA = await waitCard('site.conflict-demo', (c) => c.conflict);
  ok('A4 UI conflict card: 目标已存在 + path + size', !!cA && cA.conflict && cA.conflictText.includes('目标已存在：') && cA.conflictText.includes('/var/log/nginx/site.conflict-demo') && cA.conflictText.includes('2.0 KB'),
    cA && cA.conflictText ? cA.conflictText.slice(0, 90) : String(cA));
  ok('A5 three decision buttons present', !!cA && cA.skip && cA.overwrite && cA.keepboth);
  ok('A6 overwrite button carries capability note', !!cA && !!cA.overwriteTitle && cA.overwriteTitle.includes('覆盖发布将被阻止') && cA.overwriteTitle.includes('零改动'),
    cA && cA.overwriteTitle);
  ok('A7 awaiting card shows cancel ✕ (non-terminal)', !!cA && cA.cancelX);

  // ---- B 三裁决 ----
  // B1 skip → Skipped（决策随任务留存，prompt 清空）
  await page.evaluate(() => {
    const r = [...document.querySelectorAll('.xfer-row')].find((x) => x.querySelector('.xfer-name')?.textContent === 'site.conflict-demo');
    r?.querySelector('[data-testid="cf-skip"]')?.click();
  });
  const rB1 = await waitStatus(tA.id, 'Skipped');
  ok('B1 skip → Skipped terminal', !!rB1, JSON.stringify(rB1 && { s: rB1.status, rev: rB1.revision }));
  ok('B1b decision retained + prompt cleared', !!rB1 && rB1.collision_decision === 'skip' && rB1.decision_prompt === null && rB1.finished_at != null,
    JSON.stringify(rB1 && { d: rB1.collision_decision, p: rB1.decision_prompt }));
  const cB1 = await waitCard('site.conflict-demo', (c) => !c.conflict && !!c.sub && c.sub.includes('已跳过'));
  ok('B1c card 已跳过文案 + ⊘ dim', !!cB1 && cB1.sub && cB1.sub.includes('已跳过：同名目标未改动') && !cB1.conflict,
    cB1 && cB1.sub);

  // B2 overwrite → ReplaceUnsupported Failed（原文件零改动=能力阻止）
  const tB2 = await mkUp('app.conflict-demo');
  await waitStatus(tB2.id, 'AwaitingDecision');
  await waitCard('app.conflict-demo', (c) => c.overwrite);
  await page.evaluate(() => {
    const r = [...document.querySelectorAll('.xfer-row')].find((x) => x.querySelector('.xfer-name')?.textContent === 'app.conflict-demo');
    r?.querySelector('[data-testid="cf-overwrite"]')?.click();
  });
  const rB2 = await waitStatus(tB2.id, 'Failed');
  ok('B2 overwrite → Failed (capability block)', !!rB2, JSON.stringify(rB2 && { s: rB2.status, e: rB2.error }));
  ok('B2b message = core ReplaceUnsupported wording', !!rB2 && !!rB2.error && rB2.error.includes('发布能力不足') && rB2.error.includes('target_version_constraint'),
    rB2 && rB2.error);

  // B3 keepboth → 新名发布 *.tinyssh-1.ext → Succeeded
  const tB3 = await mkUp('run.conflict-demo');
  await waitStatus(tB3.id, 'AwaitingDecision');
  await waitCard('run.conflict-demo', (c) => c.keepboth);
  await page.evaluate(() => {
    const r = [...document.querySelectorAll('.xfer-row')].find((x) => x.querySelector('.xfer-name')?.textContent === 'run.conflict-demo');
    r?.querySelector('[data-testid="cf-keepboth"]')?.click();
  });
  const rB3 = await waitStatus(tB3.id, 'Succeeded');
  ok('B3 keepboth → Succeeded under new name', !!rB3, JSON.stringify(rB3 && { s: rB3.status, d: rB3.dest }));
  ok('B3b dest renamed stem.tinyssh-1.ext (rsplit_once 语义同核心)', !!rB3 && rB3.dest === '/var/log/nginx/run.tinyssh-1.conflict-demo' && rB3.collision_decision === 'keepboth',
    rB3 && rB3.dest);

  // ---- C revision/状态守卫 + 待决取消/作废 ----
  const tC = await mkUp('guard.conflict-demo');
  await waitStatus(tC.id, 'AwaitingDecision');
  const revC = (await row(tC.id)).revision;
  const eStale = await demoInvokeErr('submit_collision_decision', { id: tC.id, decision: 'skip', expectRevision: revC + 5 });
  ok('C1 stale expect_revision → stale_decision w/ current_revision',
    !!eStale && eStale.kind === 'stale_decision' && eStale.detail && eStale.detail.current_revision === revC,
    JSON.stringify(eStale));
  ok('C1b task stays AwaitingDecision after stale', (await row(tC.id)).status === 'AwaitingDecision');
  const eBadState = await demoInvokeErr('submit_collision_decision', { id: tA.id, decision: 'skip', expectRevision: (await row(tA.id)).revision });
  ok('C2 submit on terminal → invalid_transfer_state', !!eBadState && eBadState.kind === 'invalid_transfer_state', JSON.stringify(eBadState));
  const eBadDec = await demoInvokeErr('submit_collision_decision', { id: tC.id, decision: 'nuke', expectRevision: revC });
  ok('C2b invalid decision value → invalid_input', !!eBadDec && eBadDec.kind === 'invalid_input', JSON.stringify(eBadDec));
  // 待决取消：直接落 Cancelled（无 Cancelling 挂链），prompt 清空
  await demoInvoke('cancel_transfer', { id: tC.id });
  const rC4 = await row(tC.id);
  ok('C4 cancel-on-awaiting → immediate Cancelled', !!rC4 && rC4.status === 'Cancelled' && rC4.decision_prompt === null && rC4.error === '已取消（冲突待决中）',
    JSON.stringify(rC4 && { s: rC4.status, e: rC4.error, rev: rC4.revision }));
  const eV = await demoInvokeErr('verify_transfer_outcome', { id: tA.id });
  ok('C5 verify on non-unknown → invalid_transfer_state', !!eV && eV.kind === 'invalid_transfer_state', JSON.stringify(eV));
  // 决策卡作废（reject_expired_decision）
  const tC6 = await mkUp('void.conflict-demo');
  await waitStatus(tC6.id, 'AwaitingDecision');
  await demoInvoke('reject_expired_decision', { id: tC6.id });
  const rC6 = await row(tC6.id);
  ok('C6 reject → Cancelled 决策卡已作废', !!rC6 && rC6.status === 'Cancelled' && rC6.error === '决策卡已作废',
    JSON.stringify(rC6 && { s: rC6.status, e: rC6.error }));
  const revBefore = rC6.revision;
  await demoInvoke('reject_expired_decision', { id: tC6.id });
  const rC6b = await row(tC6.id);
  ok('C6b second reject idempotent no-op', rC6b.status === 'Cancelled' && rC6b.revision === revBefore, `rev ${revBefore}→${rC6b.revision}`);

  // ---- D recheck 两轮（提交前目标已变化 → 二次裁决，原因可查） ----
  const tD = await mkUp('recheck.recheck-demo');
  await waitStatus(tD.id, 'AwaitingDecision');
  await waitCard('recheck.recheck-demo', (c) => c.keepboth);
  await page.evaluate(() => {
    const r = [...document.querySelectorAll('.xfer-row')].find((x) => x.querySelector('.xfer-name')?.textContent === 'recheck.recheck-demo');
    r?.querySelector('[data-testid="cf-keepboth"]')?.click();
  });
  const rD1 = await waitStatus(tD.id, 'AwaitingDecision', 30);
  ok('D1 keepboth round1 → re-await (stat_changed_since_preflight)',
    !!rD1 && rD1.decision_prompt && rD1.decision_prompt.reason === 'stat_changed_since_preflight'
    && rD1.decision_prompt.target_stat && rD1.decision_prompt.target_stat.size === 777,
    JSON.stringify(rD1 && rD1.decision_prompt));
  const cD1 = await waitCard('recheck.recheck-demo', (c) => c.conflict && c.conflictText.includes('需重新裁决'));
  ok('D1b card 重新裁决文案 + 更新后大小', !!cD1 && cD1.conflict && cD1.conflictText.includes('目标在提交前已变化，需重新裁决：') && cD1.conflictText.includes('777 B'),
    cD1 && cD1.conflictText ? cD1.conflictText.slice(0, 110) : String(cD1));
  await page.evaluate(() => {
    const r = [...document.querySelectorAll('.xfer-row')].find((x) => x.querySelector('.xfer-name')?.textContent === 'recheck.recheck-demo');
    r?.querySelector('[data-testid="cf-keepboth"]')?.click();
  });
  const rD2 = await waitStatus(tD.id, 'Succeeded');
  ok('D2 keepboth round2 → published new name', !!rD2 && rD2.dest === '/var/log/nginx/recheck.tinyssh-1.recheck-demo',
    rD2 && rD2.dest);

  // ---- E OutcomeUnknown + 重新核实 ----
  const tE = await mkUp('big.unknown-demo');
  const rE = await waitStatus(tE.id, 'OutcomeUnknown');
  ok('E1 unknown-demo → OutcomeUnknown terminal', !!rE, JSON.stringify(rE && { s: rE.status, e: rE.error }));
  ok('E1b message retains temp/资料', !!rE && !!rE.error && rE.error.includes('重新核实'), rE && rE.error);
  const cE = await waitCard('big.unknown-demo', (c) => c.reverify);
  ok('E2 UI unknown card: 结果未知 + 重新核实 + 保留说明',
    !!cE && cE.reverify && cE.keepNote && cE.sub && cE.sub.includes('结果未知：'),
    cE && cE.sub);
  const revE = (await row(tE.id)).revision;
  await page.evaluate(() => {
    const r = [...document.querySelectorAll('.xfer-row')].find((x) => x.querySelector('.xfer-name')?.textContent === 'big.unknown-demo');
    r?.querySelector('[data-testid="uo-reverify"]')?.click();
  });
  const rE3 = await waitStatus(tE.id, 'OutcomeUnknown', 20);
  const revE3 = (await row(tE.id)).revision;
  ok('E3 reverify keeps OutcomeUnknown + rev bump + refreshed note',
    !!rE3 && revE3 > revE && !!rE3.error && rE3.error.includes('无法确证'),
    JSON.stringify({ rev: revE + '→' + revE3, e: rE3 && rE3.error }));
  const revE4 = (await row(tE.id)).revision;
  await demoInvoke('cancel_transfer', { id: tE.id });
  const rE4 = await row(tE.id);
  ok('E4 cancel on OutcomeUnknown no-op', rE4.status === 'OutcomeUnknown' && rE4.revision === revE4, `rev ${revE4}→${rE4.revision}`);

  // ---- F 提交前中断 ----
  const tF = await mkUp('x.interrupt-demo');
  const rF = await waitStatus(tF.id, 'Interrupted');
  ok('F1 interrupt-demo → Interrupted terminal', !!rF && rF.error === '应用重启时传输中断',
    JSON.stringify(rF && { s: rF.status, e: rF.error }));
  const cF = await waitCard('x.interrupt-demo', (c) => !!c.sub && c.sub.includes('已中断'));
  ok('F2 card 已中断文案', !!cF && cF.sub && cF.sub.includes('已中断：'), cF && cF.sub);

  // ---- G 普通上传不受影响（R32 链路回归锚） ----
  const tG = await mkUp('plain-g.bin');
  const rG = await waitStatus(tG.id, 'Succeeded');
  ok('G1 plain upload still Succeeded', !!rG && rG.bytes_done === rG.total, JSON.stringify(rG && { b: rG.bytes_done, t: rG.total }));

  ok('Z zero page errors', jsErrors.length === 0, jsErrors.join(' | ').slice(0, 300));
  const fails = results.filter((r) => !r.pass).length;
  console.log(`\n${results.length - fails}/${results.length} passed`);
  await browser.close();
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error('PROBE CRASH', e); process.exit(2); });
