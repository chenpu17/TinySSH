// R21 连接表单与认证 demo 探针（真实 Chromium + vite demo 后端，:5183）：
// A §280 并发连接解禁：otp-1 建连（TOFU/2FA 门挂起）期间其他主机连接钮不禁用；
// B §6.3 前台完成落焦点：门应答完成后自动 attach + 终端持焦；
// C/D §6.3 后台完成不抢焦点 + §306 echo 遮蔽：otp-2（echo=false）窗口 blur 后
//    完成只 toast 不切视图；otp-2 验证码输入 type=password；
// E 凭据基础管理全链：表单生成凭据 → 取消（未绑定不默默删除）→ 已有密钥绑定保存 →
//    使用中 → 引用检查拒删（列出主机）→ 删主机解绑 → 删除成功；
// F §265 名称自地址生成（可编辑）。
// 注意：本探针新增 demo 主机 otp-2（echo=false 演示）——r20 归档探针的 F1 计数断言
// （=== 26）按其提交时的树有效，重跑请以各任务提交时点的探针对应代码树为准。
const { chromium } = require('/Users/chenpu/node_modules/playwright');
const EXE = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const URL = 'http://localhost:5183/';
const results = [];
const ok = (name, cond, detail = '') => { results.push({ name, pass: !!cond, detail }); console.log((cond ? 'PASS ' : 'FAIL ') + name + (detail ? '  [' + detail + ']' : '')); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
setTimeout(() => { console.log(JSON.stringify(results)); console.error('PROBE-WATCHDOG'); process.exit(3); }, 180000).unref?.();

(async () => {
  const browser = await chromium.launch({ executablePath: EXE, headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const jsErrors = [];
  page.on('pageerror', (e) => jsErrors.push(String(e)));
  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => { try { localStorage.clear(); } catch {} });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.host-card', { timeout: 10000 });
  const sleepBridge = (ms) => sleep(ms); // demo 门挂起为 Promise，无需桥接 sleep

  const connectBtnState = (host) => page.evaluate((h) => {
    const card = [...document.querySelectorAll('.host-card')].find((c) => c.querySelector('.host-name')?.textContent.trim() === h);
    const b = card?.querySelector('.host-connect-btn');
    return b ? { disabled: b.disabled, text: b.textContent.trim() } : null;
  }, host);
  const activeTab = () => page.evaluate(() => document.querySelector('.tabbar .tab.tab-active')?.textContent.trim() ?? '');
  const termFocused = () => page.evaluate(() => String(document.activeElement?.className ?? '').includes('xterm-helper-textarea'));

  // ---- F 名称自地址生成（先做，独立表单生命周期） ----
  await page.click('button[aria-label="添加主机"]');
  await page.waitForSelector('.add-host', { timeout: 4000 });
  await page.fill('.add-host input[placeholder*="192.168"]', 'r21.autofill.test');
  await page.click('.add-host input[placeholder*="我的服务器"]'); // blur 地址 → 名称应由地址生成
  await sleep(120);
  const autoName = await page.$eval('.add-host input[placeholder*="我的服务器"]', (el) => el.value);
  ok('F1 名称自地址生成且可编辑', autoName === 'r21.autofill.test', autoName);
  await page.keyboard.press('Escape'); // 收起表单（取消不落主机配置）
  await sleep(200);

  // ---- A §280 并发解禁 + B 前台完成落焦点 ----
  //（连接钮在 hover 操作组内，与 r20 探针同款 DOM click 驱动）
  await page.hover('.host-card:has(.host-name:text-is("otp-1（演示 2FA）"))');
  await page.$eval('.host-card:has(.host-name:text-is("otp-1（演示 2FA）")) .host-connect-btn', (el) => el.click());
  await page.waitForSelector('.hk-mask', { timeout: 4000 });
  const otp1 = await connectBtnState('otp-1（演示 2FA）');
  const prod1 = await connectBtnState('prod-1');
  ok('A1 本主机连接中显示 连接中… 且按钮禁用', !!otp1 && otp1.disabled && otp1.text.includes('连接中'), JSON.stringify(otp1));
  ok('A2 其他主机连接钮不受扰（§280）', !!prod1 && !prod1.disabled && prod1.text === '连接', JSON.stringify(prod1));
  await page.click('.hk-mask button:not(.ghost)'); // 首见指纹：信任并连接
  await page.waitForSelector('.hk-mask', { timeout: 4000 }); // 2FA 门
  const prod1b = await connectBtnState('prod-1');
  ok('A3 2FA 门挂起期间其他主机仍可连接', !!prod1b && !prod1b.disabled, JSON.stringify(prod1b));
  // B：前台应答 → 自动 attach + 终端持焦
  await page.fill('.hk-mask input', '424242');
  await page.click('.hk-mask button:has-text("提交验证")');
  await page.waitForSelector('.hk-mask', { state: 'detached', timeout: 6000 }).catch(() => {});
  await sleep(400);
  const tabB = await activeTab();
  ok('B1 前台完成后原会话标签激活', tabB.includes('otp-1'), tabB);
  ok('B2 终端持焦（§6.3）', await termFocused());
  await sleepBridge(150);

  // ---- C/D echo 遮蔽 + 后台完成不抢焦点 ----
  await page.hover('.host-card:has(.host-name:text-is("otp-2（演示 2FA 隐）"))');
  await page.$eval('.host-card:has(.host-name:text-is("otp-2（演示 2FA 隐）")) .host-connect-btn', (el) => el.click());
  await page.waitForSelector('.hk-mask', { timeout: 4000 });
  await page.click('.hk-mask button:not(.ghost)'); // 信任 otp-2
  await page.waitForSelector('.hk-mask input[type="password"]', { timeout: 4000 }).catch(() => {});
  const echoInput = await page.$eval('.hk-mask input', (el) => ({ type: el.type, ph: el.placeholder }));
  ok('D1 echo=false 验证码输入遮蔽（§306）', echoInput.type === 'password' && echoInput.ph.includes('不回显'), JSON.stringify(echoInput));
  // C：用户意图转移（窗口 blur → 焦点代际推进）→ 完成只 toast 不切视图
  await page.evaluate(() => window.dispatchEvent(new Event('blur')));
  await sleep(150);
  const tabBefore = await activeTab();
  await page.fill('.hk-mask input', '007');
  await page.click('.hk-mask button:has-text("提交验证")');
  await page.waitForSelector('.hk-mask', { state: 'detached', timeout: 6000 }).catch(() => {});
  await sleep(500);
  const tabAfter = await activeTab();
  const toastText = await page.evaluate(() => [...document.querySelectorAll('.toast')].map((t) => t.textContent).join('|'));
  ok('C1 后台完成不切视图（§6.3）', tabAfter === tabBefore && !tabAfter.includes('otp-2'), JSON.stringify({ before: tabBefore, after: tabAfter }));
  ok('C2 后台完成有可寻 toast', toastText.includes('已连接 otp-2') && toastText.includes('点击标签进入'), toastText.slice(-120));
  // 点击标签进入（用户主动导航）
  await page.evaluate(() => {
    const t = [...document.querySelectorAll('.tabbar .tab')].find((x) => x.textContent.includes('otp-2'));
    if (t) t.click();
  });
  await sleep(400);
  ok('C3 点击标签进入后台完成的会话', (await activeTab()).includes('otp-2'), await activeTab());

  // ---- E 凭据基础管理全链 ----
  // E1 表单生成凭据 → 直接取消（收起表单）→ 设置里应「未绑定」且不默默删除（§267）
  await page.click('button[aria-label="添加主机"]');
  await page.waitForSelector('.add-host', { timeout: 4000 });
  await page.selectOption('.add-host select', 'key'); // 认证方式 = 私钥
  await page.click('.add-host button:has-text("生成新密钥")');
  await page.waitForSelector('.add-host .trust-row', { timeout: 6000 });
  ok('E1 生成凭据出示指纹确认（FR-2）', !!(await page.$('.add-host .trust-row .fp')));
  await page.keyboard.press('Escape'); // 取消表单——凭据独立存在
  await sleep(250);
  await page.click('.hb-settings');
  await page.waitForSelector('.term-settings', { timeout: 4000 });
  await page.waitForSelector('.cred-row', { timeout: 4000 });
  const credRows1 = await page.$$eval('.cred-row', (rows) => rows.map((r) => ({
    label: r.querySelector('.cred-label')?.textContent.trim(),
    badge: r.querySelector('.cred-bound, .cred-unbound')?.textContent.trim(),
  })));
  ok('E2 取消表单后凭据在库且标未绑定（§267）',
    credRows1.length === 1 && credRows1[0].badge === '未绑定', JSON.stringify(credRows1));
  const credLabel = credRows1[0]?.label ?? '';
  await page.click('.term-settings button[aria-label="关闭显示设置"]');
  await sleep(200);

  // E3 已有密钥选择器绑定保存（§265 已有密钥）→ 使用中
  await page.click('button[aria-label="添加主机"]');
  await page.waitForSelector('.add-host', { timeout: 4000 });
  await page.selectOption('.add-host select', 'key');
  await page.waitForSelector('.add-host select >> nth=1', { timeout: 4000 }).catch(() => {});
  const picked = await page.evaluate((lbl) => {
    const selects = document.querySelectorAll('.add-host select');
    const sel = selects[0]; // 已有密钥选择器（认证方式之后插入的第一个额外 select）
    for (const s of selects) {
      const opt = [...s.options].find((o) => o.textContent.includes(lbl.slice(0, 12)));
      if (opt) { s.value = opt.value; s.dispatchEvent(new Event('change', { bubbles: true })); return true; }
    }
    return false;
  }, credLabel);
  ok('E3 已有密钥选择器含未绑定凭据（§265）', !!picked);
  await page.fill('.add-host input[placeholder*="我的服务器"]', 'r21-keyhost');
  await page.fill('.add-host input[placeholder*="192.168"]', '10.9.9.9');
  await page.fill('.add-host input[placeholder*="ops 或 root"]', 'ops');
  await page.click('.add-host button:has-text("仅保存")');
  await page.waitForSelector('.add-host', { state: 'detached', timeout: 6000 }).catch(() => {});
  await sleep(400); // 3s 轮询前的乐观路径：hostMeta/hosts 由 refreshLists 立即刷新
  // 打开设置看 使用中
  await page.click('.hb-settings');
  await page.waitForSelector('.cred-row', { timeout: 4000 });
  const badgeNow = await page.$eval('.cred-row .cred-bound, .cred-row .cred-unbound', (el) => el.textContent.trim());
  ok('E4 绑定保存后凭据标使用中', badgeNow === '使用中', badgeNow);
  // E5 引用检查拒删并列出主机（§267）
  await page.click('.cred-row button[aria-label^="删除凭据"]');
  await page.waitForSelector('.confirm-dialog', { timeout: 4000 });
  await page.click('.confirm-dialog button:has-text("删除凭据")');
  await sleep(500);
  const credErr = await page.$eval('.term-settings .err', (el) => el.textContent).catch(() => '');
  ok('E5 引用检查拒删并列出主机名', credErr.includes('r21-keyhost'), credErr);
  await page.click('.term-settings button[aria-label="关闭显示设置"]');
  await sleep(200);
  // E6 删主机解绑
  await page.hover('.host-card:has(.host-name:text-is("r21-keyhost"))');
  await page.$eval('.host-card:has(.host-name:text-is("r21-keyhost")) .host-del', (el) => el.click());
  await page.waitForSelector('.confirm-dialog', { timeout: 4000 });
  await page.click('.confirm-dialog button:has-text("删除")');
  await sleep(600);
  await page.click('.hb-settings');
  await page.waitForSelector('.cred-row', { timeout: 4000 });
  const badgeAfter = await page.$eval('.cred-row .cred-bound, .cred-row .cred-unbound', (el) => el.textContent.trim());
  ok('E6 删主机后凭据回到未绑定', badgeAfter === '未绑定', badgeAfter);
  // E7 删除成功
  await page.click('.cred-row button[aria-label^="删除凭据"]');
  await page.waitForSelector('.confirm-dialog', { timeout: 4000 });
  await page.click('.confirm-dialog button:has-text("删除凭据")');
  await page.waitForSelector('.cred-row', { state: 'detached', timeout: 4000 }).catch(() => {});
  const credLeft = await page.$$eval('.cred-row', (r) => r.length);
  ok('E7 未绑定凭据删除成功', credLeft === 0, String(credLeft));
  await page.click('.term-settings button[aria-label="关闭显示设置"]');

  ok('Z1 零 JS 错误', jsErrors.length === 0, jsErrors.join('; ').slice(0, 200));

  await browser.close();
  const fails = results.filter((r) => !r.pass);
  console.log(fails.length === 0 ? 'r21-demo-ALL-PASS ' + results.length : 'r21-demo-FAILS=' + fails.length);
  process.exit(fails.length === 0 ? 0 : 1);
})().catch((e) => { console.error('PROBE-ERR', e); process.exit(2); });
