// R23 C1 消费 + 关闭/退出契约 demo 探针（真实 Chromium + vite demo 后端，:5183）：
// A attempt 相位呈示与取消（§302 等待中可取消——TrustRequired/ChallengeRequired 相位
//    卡上取消，终态由核心裁决：Cancelled → 卡复位+已取消 toast，门卡消散）；
// B 全链前台完成落焦（TOFU+2FA → attach + 终端持焦）；
// C gatesBusy host_id（R21-L6 勘误闭环）：他主机 2FA 门挂起期间另一连接后台完成
//    不抢视图（toast 点击标签进入），门应答后前台完成正常 attach；
// D 关闭契约（§6.4）：确认框统一「关闭会话」+ 影响行（转发数可查/任务未知如实），
//    关闭成功标签移除；
// E 欢迎页添加主机清 editingHost（R22 前置清单：不再劫持为编辑模式）；
// F §280 保持：门挂起期间他主机连接钮不受扰。
const { chromium } = require('/Users/chenpu/node_modules/playwright');
const EXE = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const URL = 'http://localhost:5183/';
const results = [];
const ok = (name, cond, detail = '') => { results.push({ name, pass: !!cond, detail }); console.log((cond ? 'PASS ' : 'FAIL ') + name + (detail ? '  [' + detail + ']' : '')); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
setTimeout(() => { console.log(JSON.stringify(results)); console.error('PROBE-WATCHDOG'); process.exit(3); }, 240000).unref?.();

(async () => {
  const browser = await chromium.launch({ executablePath: EXE, headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const jsErrors = [];
  page.on('pageerror', (e) => jsErrors.push(String(e)));
  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => { try { localStorage.clear(); } catch {} });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.host-card', { timeout: 10000 });

  const cardBtnText = (host) => page.evaluate((h) => {
    const card = [...document.querySelectorAll('.host-card')].find((c) => c.querySelector('.host-name')?.textContent.trim() === h);
    return card?.querySelector('.host-connect-btn')?.textContent.trim() ?? null;
  }, host);
  const cardCancel = (host) => page.evaluate((h) => {
    const card = [...document.querySelectorAll('.host-card')].find((c) => c.querySelector('.host-name')?.textContent.trim() === h);
    const b = [...(card?.querySelectorAll('button') ?? [])].find((x) => x.textContent.trim() === '取消');
    if (!b) return null;
    b.click();
    return true;
  }, host);
  const clickConnect = (host) => page.evaluate((h) => {
    const card = [...document.querySelectorAll('.host-card')].find((c) => c.querySelector('.host-name')?.textContent.trim() === h);
    const b = card?.querySelector('.host-connect-btn');
    if (!b || b.disabled) return null;
    b.click();
    return true;
  }, host);
  const maskKind = () => page.evaluate(() => {
    const m = document.querySelector('.hk-mask');
    if (!m) return null;
    return m.textContent.includes('首次连接确认') ? 'tofu' : m.textContent.includes('双因素') ? '2fa' : 'other';
  });
  const toasts = () => page.evaluate(() => [...document.querySelectorAll('.toast')].map((t) => t.textContent).join('|'));
  const activeTab = () => page.evaluate(() => document.querySelector('.tabbar .tab.tab-active')?.textContent.trim() ?? '');
  const termFocused = () => page.evaluate(() => String(document.activeElement?.className ?? '').includes('xterm-helper-textarea'));

  // ---- A attempt 相位与取消（§302） ----
  await clickConnect('otp-1（演示 2FA）');
  await page.waitForSelector('.hk-mask', { timeout: 5000 });
  const p1 = await cardBtnText('otp-1（演示 2FA）');
  ok('A1 门挂起期按钮呈示核心相位（等待指纹确认）', p1 === '等待指纹确认', p1);
  const cancelVisible = await page.evaluate(() => {
    const card = [...document.querySelectorAll('.host-card')].find((c) => c.textContent.includes('otp-1'));
    return !!([...(card?.querySelectorAll('button') ?? [])].find((x) => x.textContent.trim() === '取消'));
  });
  ok('A2 attempt 在途卡上取消入口可见（§302）', cancelVisible);
  await page.click('.hk-mask button:not(.ghost)'); // 信任 → ChallengeRequired
  await page.waitForSelector('.hk-mask input', { timeout: 5000 }).catch(() => {});
  const p2 = await cardBtnText('otp-1（演示 2FA）');
  ok('A3 相位推进呈示（等待验证码）', p2 === '等待验证码', p2);
  await cardCancel('otp-1（演示 2FA）');
  await page.waitForFunction(() => !document.querySelector('.hk-mask'), { timeout: 5000 });
  await sleep(500); // demo 轮询结算（300ms）+ 卡复位
  const p3 = await cardBtnText('otp-1（演示 2FA）');
  const t1 = await toasts();
  ok('A4 取消后核心裁决呈示：卡复位 + 已取消 toast', p3 === '连接' && t1.includes('已取消连接'), `btn=${p3} toast=${t1.slice(-80)}`);

  // ---- B 全链前台完成落焦 ----
  await clickConnect('otp-1（演示 2FA）');
  await page.waitForSelector('.hk-mask', { timeout: 5000 });
  if ((await maskKind()) === 'tofu') { // A 段已信任则直入 2FA 门
    await page.click('.hk-mask button:not(.ghost)'); // 信任
    await page.waitForSelector('.hk-mask input', { timeout: 5000 });
  }
  await page.fill('.hk-mask input', '424242');
  await page.click('.hk-mask button:has-text("提交验证")');
  await page.waitForSelector('.hk-mask', { state: 'detached', timeout: 6000 }).catch(() => {});
  await sleep(500);
  const tabB = await activeTab();
  ok('B1 全链完成前台 attach（标签激活）', tabB.includes('otp-1'), tabB);
  ok('B2 终端持焦（§6.3）', await termFocused());

  // ---- C gatesBusy host_id：他主机门挂起期间另一连接后台完成不抢视图 ----
  await clickConnect('otp-1（演示 2FA）'); // 第二个会话（新 attempt，进入 2FA 门）
  await page.waitForSelector('.hk-mask', { timeout: 5000 });
  if ((await maskKind()) === 'tofu') {
    await page.click('.hk-mask button:not(.ghost)'); // 信任
    await page.waitForSelector('.hk-mask input', { timeout: 5000 });
  }
  const before = await activeTab();
  await clickConnect('prod-1'); // 无门快路径—— otp-1 2FA 门挂起中完成
  await sleep(900);
  const after = await activeTab();
  const tC = await toasts();
  ok('C1 他主机门挂起中 prod-1 完成不切视图', before.includes('otp-1') && !after.includes('prod-1'), `before=${before} after=${after}`);
  ok('C2 后台完成 toast 引导点标签进入', tC.includes('prod-1') && tC.includes('点击标签进入'), tC.slice(-100));
  // 门应答：otp-1 前台完成（gen 未变——门先于 prod-1 打开）→ attach
  await page.fill('.hk-mask input', '424242');
  await page.click('.hk-mask button:has-text("提交验证")');
  await page.waitForSelector('.hk-mask', { state: 'detached', timeout: 6000 }).catch(() => {});
  await sleep(600);
  const after2 = await activeTab();
  ok('C3 门应答后前台完成 attach（gatesBusy 按 host_id 精确判定）', after2.includes('otp-1'), after2);

  // ---- D 关闭契约（§6.4） ----
  const otpTabs = await page.evaluate(() => [...document.querySelectorAll('.tabbar .tab')].filter((t) => t.textContent.includes('otp-1')).length);
  ok('D1 两次连接两个标签（无隐藏连接）', otpTabs === 2, String(otpTabs));
  await page.evaluate(() => {
    const tabs = [...document.querySelectorAll('.tabbar .tab')].filter((t) => t.textContent.includes('otp-1'));
    tabs[0].querySelector('.tab-x')?.click();
  });
  await page.waitForSelector('.confirm-dialog', { timeout: 4000 });
  const dlg = await page.evaluate(() => document.querySelector('.confirm-dialog')?.textContent ?? '');
  ok('D2 确认框统一「关闭会话」命名 + 影响行', dlg.includes('关闭与') && dlg.includes('会话？') && dlg.includes('将受影响的转发') && dlg.includes('状态未知'), dlg.slice(0, 150));
  await page.click('.confirm-dialog button.danger');
  await sleep(500);
  const otpTabs2 = await page.evaluate(() => [...document.querySelectorAll('.tabbar .tab')].filter((t) => t.textContent.includes('otp-1')).length);
  ok('D3 关闭成功标签移除', otpTabs2 === 1, String(otpTabs2));

  // ---- E 欢迎页添加主机清 editingHost（R22 前置清单） ----
  // 关掉剩余标签回欢迎页
  await page.evaluate(() => {
    const tabs = [...document.querySelectorAll('.tabbar .tab')];
    for (const t of tabs) t.querySelector('.tab-x')?.click();
  });
  await sleep(600);
  // 逐个确认关闭
  for (let i = 0; i < 3; i++) {
    const dlgVisible = await page.evaluate(() => !!document.querySelector('.confirm-dialog'));
    if (dlgVisible) await page.click('.confirm-dialog button.danger');
    await sleep(400);
  }
  const welcomeVisible = await page.evaluate(() => !!document.querySelector('.welcome-actions'));
  ok('E1 全关后欢迎页呈现', welcomeVisible);
  // 编辑主机 → Escape → 欢迎页添加主机 → 应为新建模式
  await page.evaluate(() => {
    const card = [...document.querySelectorAll('.host-card')].find((c) => c.textContent.includes('prod-1'));
    card?.querySelector('button[title^="编辑主机"]')?.click();
  });
  await page.waitForSelector('.add-host', { timeout: 4000 });
  await page.keyboard.press('Escape');
  await sleep(250);
  await page.evaluate(() => {
    [...document.querySelectorAll('.welcome-actions button')].find((b) => b.textContent.includes('添加主机'))?.click();
  });
  await page.waitForSelector('.add-host', { timeout: 4000 });
  const formState = await page.evaluate(() => {
    const f = document.querySelector('.add-host');
    const name = f.querySelector('input')?.value ?? '';
    return { name, editLike: f.textContent.includes('指纹') || !!f.querySelector('.trust-row') };
  });
  ok('E2 欢迎页添加主机为全新表单（editingHost 已清）', formState.name === '' && !formState.editLike, JSON.stringify(formState));
  await page.keyboard.press('Escape');
  await sleep(200);

  // ---- F §280 保持 ----
  await clickConnect('otp-1（演示 2FA）');
  await page.waitForSelector('.hk-mask', { timeout: 5000 });
  const prodState = await page.evaluate(() => {
    const card = [...document.querySelectorAll('.host-card')].find((c) => c.textContent.includes('prod-1'));
    const b = card?.querySelector('.host-connect-btn');
    return b ? { disabled: b.disabled, text: b.textContent.trim() } : null;
  });
  ok('F1 门挂起期他主机连接钮不受扰（§280）', !!prodState && !prodState.disabled && prodState.text === '连接', JSON.stringify(prodState));
  await cardCancel('otp-1（演示 2FA）');
  await page.waitForFunction(() => !document.querySelector('.hk-mask'), { timeout: 5000 });
  await sleep(500);

  ok('Z1 零 JS 错误', jsErrors.length === 0, jsErrors.join(' | ').slice(0, 200));
  console.log('SUMMARY ' + results.filter((r) => r.pass).length + '/' + results.length);
  await browser.close();
  process.exit(results.every((r) => r.pass) ? 0 : 1);
})();
