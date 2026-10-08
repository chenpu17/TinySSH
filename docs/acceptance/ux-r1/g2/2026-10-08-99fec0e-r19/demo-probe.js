// R19 C1 建连尝试 demo 探针（真实 Chromium + vite demo 后端，与产品同一 invoke 通道）：
// A 模块同实例护栏（HMR ?t= 双实例误判防线，r15 同款）；
// B DC1.5 合并幂等（同 (host, actor) 活跃 attempt 同 id；new_session 绕过）；
// C TOFU 门相位 + 待决卡 attempt 联动（C1 wire：PendingHostKey.attempt_id）；
// D 受理取消（门卡结算）：Cancelled 无会话遗留、待决卡消失、二次取消 NotFound（序列 1/6）；
// E 信任 → Authenticating → Ready 投递（session_id 落位、会话 Connected、迟到取消 NotFound 序列 4）；
// F 2FA ChallengeRequired：待决 prompt attempt 联动 → 应答 → Ready；
// G create_session v1 兼容路径不受扰（会话照常建、无 attempt 语义依赖）；
// H 失败路径：auth_failed → Failed 相位 + error 载荷；
// I status 未知 attempt → session_not_found 形状。
// 窗口竞态（序列 2/3 already_ready/CancelCloseFailed）为真实核心异步微窗语义，
// demo 同步 mock 不可交错驱动——由 core-session c1_tests（钩子）+ 原生冒烟覆盖，此处不主张。
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
  await page.waitForSelector('.host-card', { timeout: 10000 });

  // ---- A 模块同实例 ----
  const mod = await page.evaluate(async () => {
    const m1 = await import('/src/demo.ts');
    const m2 = await import('/src/demo.ts');
    return { same: m1 === m2, isFn: typeof m1.invoke === 'function' };
  });
  ok('A1 demo 模块同实例', mod.same && mod.isFn, JSON.stringify(mod));

  // ---- B/C/D/E/F/G/H/I 契约面 ----
  const err = await page.evaluate(async () => {
    const out = {};
    try {
      const demo = await import('/src/demo.ts');
      const inv = demo.invoke;
      const waitPhase = async (aid, phases, tries = 60) => {
        for (let i = 0; i < tries; i++) {
          const st = await inv('connection_status', { attemptId: aid });
          if (phases.includes(st.phase)) return st;
          await new Promise((r) => setTimeout(r, 60));
        }
        return null;
      };

      // B 合并幂等（staging-1 未信任 → 活跃 attempt 停在门）
      out._step = 'B-begin';
      const a1 = await inv('begin_connection', { hostId: 'h-staging1', opts: {} });
      const a1b = await inv('begin_connection', { hostId: 'h-staging1', opts: {} });
      out.mergeSame = a1b.attempt_id === a1.attempt_id;
      const aNs = await inv('begin_connection', { hostId: 'h-staging1', opts: { new_session: true } });
      out.bypassDiff = aNs.attempt_id !== a1.attempt_id;

      out._step = 'C';
      // C TOFU 相位 + 待决卡 attempt 联动
      const stTo = await waitPhase(a1.attempt_id, ['TrustRequired']);
      out.tofuPhase = stTo && stTo.phase;
      const pks = await inv('pending_host_keys', {});
      out.pkLinked = pks.some((p) => p.attempt_id === a1.attempt_id);

      out._step = 'D';
      // D 受理取消：new_session 那条取消（同在门）
      const c1 = await inv('cancel_connection', { attemptId: aNs.attempt_id });
      out.cancelOutcome = c1 && c1.outcome;
      const stC = await waitPhase(aNs.attempt_id, ['Cancelled']);
      out.cancelledPhase = stC && stC.phase;
      out.cancelledNoSid = stC ? stC.session_id === null : null;
      await new Promise((r) => setTimeout(r, 150));
      const pks2 = await inv('pending_host_keys', {});
      out.pkResolved = !pks2.some((p) => p.attempt_id === aNs.attempt_id);
      const c2 = await inv('cancel_connection', { attemptId: aNs.attempt_id });
      out.secondCancel = c2 && c2.outcome;

      out._step = 'E';
      // E 信任 → Ready（decide_host_key 与 FE 掩膜同参真路径）
      const pk1 = pks.find((p) => p.attempt_id === a1.attempt_id);
      await inv('decide_host_key', { id: pk1.id, accept: true });
      const stAu = await waitPhase(a1.attempt_id, ['Authenticating', 'Ready']);
      out.authPhase = stAu && stAu.phase;
      const fin = await waitPhase(a1.attempt_id, ['Ready']);
      out.readySid = fin && fin.session_id;
      const sess = await inv('list_sessions', {});
      out.sessConnected = sess.some((s) => s.id === fin.session_id && s.state === 'Connected');
      const late = await inv('cancel_connection', { attemptId: a1.attempt_id });
      out.lateCancel = late && late.outcome;
      const sess2 = await inv('list_sessions', {});
      out.survives = sess2.some((s) => s.id === fin.session_id);

      out._step = 'F-begin';
      // F 2FA：otp-1 → TOFU 信任 → ChallengeRequired → 应答 → Ready
      const a3 = await inv('begin_connection', { hostId: 'h-otp1', opts: {} });
      const st3 = await waitPhase(a3.attempt_id, ['TrustRequired']);
      if (st3) {
        const pk3 = (await inv('pending_host_keys', {})).find((p) => p.attempt_id === a3.attempt_id);
        if (pk3) await inv('decide_host_key', { id: pk3.id, accept: true });
      }
      const st3c = await waitPhase(a3.attempt_id, ['ChallengeRequired', 'Ready']);
      out.challengePhase = st3c && st3c.phase;
      if (st3c && st3c.phase === 'ChallengeRequired') {
        const aps = await inv('pending_auth_prompts', {});
        out.apLinked = aps.some((p) => p.attempt_id === a3.attempt_id);
        const ap = aps.find((p) => p.attempt_id === a3.attempt_id);
        if (ap) await inv('answer_auth_prompt', { id: ap.id, answer: '123456' });
      }
      const fin3 = await waitPhase(a3.attempt_id, ['Ready', 'Failed']);
      out.otpReady = fin3 && fin3.phase;

      out._step = 'G';
      // G create_session v1 兼容
      const sid = await inv('create_session', { hostId: 'local' });
      out.compatSession = typeof sid === 'string' && sid.length > 0;

      out._step = 'H-begin';
      // H 失败路径（prod-2 认证失败：TOFU 先行 → 接受 → auth_failed）
      const a4 = await inv('begin_connection', { hostId: 'h-prod2', opts: {} });
      const st4 = await waitPhase(a4.attempt_id, ['TrustRequired']);
      if (st4) {
        const pk4 = (await inv('pending_host_keys', {})).find((p) => p.attempt_id === a4.attempt_id);
        if (pk4) await inv('decide_host_key', { id: pk4.id, accept: true });
      }
      const fin4 = await waitPhase(a4.attempt_id, ['Failed', 'Ready'], 80);
      out.failPhase = fin4 && fin4.phase;
      out.failKind = fin4 && fin4.error && fin4.error.kind;

      out._step = 'I';
      // I 未知 attempt → session_not_found
      try { await inv('connection_status', { attemptId: 'at-none' }); out.unknownStatus = 'no-error'; }
      catch (e) { out.unknownStatus = String((e && e.kind) || e).slice(0, 40); }

      // 清理：关掉本次创建的会话（E/F 的）
      const ss = await inv('list_sessions', {});
      for (const s of ss) if (String(s.id).startsWith('s-demo-')) await inv('close_session', { sid: s.id });
      window.__r19 = out;
      return null;
    } catch (e) {
      window.__r19 = out;
      return 'ERR@' + (out._step || '?') + ' ' + JSON.stringify(e && e.message !== undefined ? { kind: e.kind, message: e.message } : e, (_k, v) => (typeof v === 'object' && v !== null && !(v instanceof Error) ? v : String(v))).slice(0, 300);
    }
  });
  if (err) ok('契约面执行', false, err);
  else {
    const c = await page.evaluate(() => window.__r19);
    ok('B1 合并幂等同 id', c.mergeSame === true, JSON.stringify(c.mergeSame));
    ok('B2 new_session 绕过合并', c.bypassDiff === true, JSON.stringify(c.bypassDiff));
    ok('C1 TOFU 相位 TrustRequired', c.tofuPhase === 'TrustRequired', String(c.tofuPhase));
    ok('C2 待决卡携带 attempt_id', c.pkLinked === true, String(c.pkLinked));
    ok('D1 受理取消 → cancelled', c.cancelOutcome === 'cancelled', String(c.cancelOutcome));
    ok('D2 终态 Cancelled 无会话', c.cancelledPhase === 'Cancelled' && c.cancelledNoSid === true, JSON.stringify([c.cancelledPhase, c.cancelledNoSid]));
    ok('D3 待决卡已结算消失', c.pkResolved === true, String(c.pkResolved));
    ok('D4 二次取消 → not_found', c.secondCancel === 'not_found', String(c.secondCancel));
    ok('E1 信任后过认证段', c.authPhase === 'Authenticating' || c.authPhase === 'Ready', String(c.authPhase));
    ok('E2 Ready 投递带 session_id', !!c.readySid, String(c.readySid));
    ok('E3 会话 Connected', c.sessConnected === true, String(c.sessConnected));
    ok('E4 迟到取消 → not_found（序列 4）', c.lateCancel === 'not_found', String(c.lateCancel));
    ok('E5 迟到取消无副作用', c.survives === true, String(c.survives));
    ok('F1 2FA ChallengeRequired', c.challengePhase === 'ChallengeRequired' || c.otpReady === 'Ready', JSON.stringify([c.challengePhase, c.otpReady]));
    ok('F2 prompt 携带 attempt_id', c.apLinked === true, String(c.apLinked));
    ok('F3 应答后 Ready', c.otpReady === 'Ready', String(c.otpReady));
    ok('G1 create_session v1 兼容', c.compatSession === true, String(c.compatSession));
    ok('H1 auth_failed → Failed+载荷', c.failPhase === 'Failed' && c.failKind === 'auth_failed', JSON.stringify([c.failPhase, c.failKind]));
    ok('I1 未知 attempt session_not_found', c.unknownStatus === 'session_not_found', String(c.unknownStatus));
  }
  ok('Z1 零 JS 错误', jsErrors.length === 0, jsErrors.join('; ').slice(0, 200));

  await browser.close();
  const fails = results.filter((r) => !r.pass);
  console.log(fails.length === 0 ? 'r19-demo-ALL-PASS ' + results.length : 'r19-demo-FAILS=' + fails.length);
  process.exit(fails.length === 0 ? 0 : 1);
})().catch((e) => { console.error('PROBE-ERR', e); process.exit(2); });
