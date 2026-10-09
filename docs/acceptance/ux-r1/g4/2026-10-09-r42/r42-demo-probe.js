// R42 demo 探针（协作入口、首次委托、审批分组/目的、接管/交还、窄窗完整视图 §3.2 / §4.2 / §6.7 / D06/D11）：
//  · 协作入口：有 Agent 配置或活动时 titlebar 提醒 + 工具栏入口；工具菜单按 §3.2 精确枚举（无「审批与记录」）；
//  · 新装未启用（?fresh）：主界面不出现空审批区/空白委托表单；协作面板改一次性引导；
//  · 首次委托显式：对话框展示主机/会话/能力/现有授权范围 → 明确提交才切 Agent-owned，取消不改 owner；
//  · 审批分组：跨会话按主机+会话分组（绝不只展示当前主机）；每卡「可用目的」为当前目标投影，缺失即明示；
//  · 接管/交还：接管冻结并作废未开始请求（作废不可复活）；曾被 Agent 持有 → 入口措辞为「交还」；
//  · 窄窗完整视图：右栏 tp-full 下长命令完整可见（不省略号）。
// 域说明：demo 无真实 SSH/MCP；真实面由 core r42_tests（控制权/目的投影/作废终结）与原生冒烟覆盖。
const { chromium } = require('/Users/chenpu/node_modules/playwright');
const EXE = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const URL = process.env.PROBE_URL || 'http://localhost:5183/';
const results = [];
const ok = (name, cond, detail = '') => { results.push({ name, pass: !!cond }); console.log((cond ? 'PASS ' : 'FAIL ') + name + (detail ? '  [' + detail + ']' : '')); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
 try {
  const browser = await chromium.launch({ executablePath: EXE, headless: true });

  // ================= 主场景（已配置 Agent + 预置活动）=================
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();
  const jsErrors = [];
  page.on('pageerror', (e) => jsErrors.push(String(e)));
  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => { try { localStorage.clear(); } catch {} });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.host-card', { timeout: 10000 });
  await sleep(400);

  // 注意：demo 态经页面内 import('/src/adapter/bridge.ts') 共享 App 实例；
  // 直接 import('/src/demo.ts') 会拿到另一实例（HMR 时间戳），探针不得走那条路。
  const demoInvoke = (cmd, args) => page.evaluate(async ({ c, a }) => {
    const { invoke } = await import('/src/adapter/bridge.ts');
    return invoke(c, a);
  }, { c: cmd, a: args });
  const count = (sel) => page.evaluate((s) => document.querySelectorAll(s).length, sel);
  const txt = (sel) => page.evaluate((s) => document.querySelector(s)?.textContent ?? null, sel);
  const attrSafe = (sel, a) => page.evaluate(({ s, a }) => document.querySelector(s)?.getAttribute(a) ?? null, { s: sel, a });
  const clickSafe = async (sel, timeout = 3000) => { try { await page.click(sel, { timeout }); return true; } catch { return false; } };
  const openTools = async (testid) => {
    await page.evaluate(() => { [...document.querySelectorAll('.st-tools button')].find((b) => b.textContent.includes('工具'))?.click(); });
    await sleep(220);
    const hit = await clickSafe(`[data-testid="${testid}"]`);
    await sleep(500);
    return hit;
  };
  const selectTab = async (needle) => {
    await page.evaluate((n) => { [...document.querySelectorAll('.tab')].find((t) => t.textContent.includes(n))?.click(); }, needle);
    await sleep(700);
  };
  // 连接一台主机（处理 TOFU 指纹窗）→ 返回该会话 id
  const connectHost = async (needle) => {
    await page.evaluate((n) => {
      const card = [...document.querySelectorAll('.host-card')].find((c) => c.querySelector('.host-name')?.textContent.includes(n));
      card?.querySelector('.host-connect-btn')?.click();
    }, needle);
    await page.waitForSelector('.hk-mask', { timeout: 4000 }).catch(() => {});
    await page.evaluate(() => {
      [...document.querySelectorAll('.hk-mask button')].find((x) => x.textContent.includes('信任并连接'))?.click();
    });
    for (let i = 0; i < 60; i++) {
      const s = (await demoInvoke('list_sessions')).find((x) => x.host_name.includes(needle) && x.state === 'Connected' && x.control_owner === 'Human');
      if (s) return s.id;
      await sleep(150);
    }
    return null;
  };

  // ---- A. 协作入口（§3.2） ----
  await selectTab('prod-1');
  ok('A1 有 Agent 配置/活动时 titlebar 显示协作提醒', (await count('[data-testid="collab-entry"]')) === 1);
  const badge = await txt('[data-testid="collab-entry"]');
  ok('A2 协作提醒含待审批计数', /协作 · \d+ 待审批/.test(badge || ''), badge);
  ok('A3 会话工具栏有协作入口', (await count('[data-testid="tools-collab"]')) === 1);
  await page.evaluate(() => { [...document.querySelectorAll('.st-tools button')].find((b) => b.textContent.includes('工具'))?.click(); });
  await sleep(220);
  const menuItems = await page.evaluate(() => [...document.querySelectorAll('.tools-menu button')].map((b) => b.textContent.trim()));
  await page.keyboard.press('Escape');
  await sleep(200);
  ok('A4 工具菜单按 §3.2 精确枚举（连接详情/端口转发/活动记录/关闭会话，无「审批与记录」）',
    menuItems.length === 4 && menuItems.some((t) => t.includes('连接详情')) && menuItems.some((t) => t.includes('端口转发'))
    && menuItems.some((t) => t.includes('活动记录')) && menuItems.some((t) => t.includes('关闭会话'))
    && !menuItems.some((t) => t.includes('审批与记录')), menuItems.join(' | '));

  // ---- B. 审批分组与「可用目的」（§3.2 / §6.7） ----
  // 往另一台（staging-1，goal=null）注入一张待审批，制造跨会话并存
  const sid2 = (await demoInvoke('list_sessions')).find((s) => s.host_name === 'staging-1').id;
  // 旧码（R41）无此 demo 钩子会抛——吞掉以便旧码跑完整套（判别力靠后续断言，非靠异常中断）
  await demoInvoke('demo_inject_approval', { sid: sid2, command: 'systemctl restart nginx', target_summary: '服务管理' }).catch(() => null);
  await clickSafe('[data-testid="tools-collab"]');
  await sleep(3600); // 等 3s 轮询把新审批拉进来
  ok('B1 协作面板已开', (await txt('[data-testid="tp-title"]')) === '协作');
  const groups = await count('[data-testid="ap-group"]');
  ok('B2 跨会话审批按主机+会话分组（≥2 组，不只当前主机）', groups >= 2, `组数=${groups}`);
  const heads = await page.evaluate(() => [...document.querySelectorAll('.ap-group-head')].map((h) => h.textContent));
  ok('B3 分组头含主机名与会话 id', heads.some((h) => h.includes('prod-1') && h.includes('s-demo-0001'))
    && heads.some((h) => h.includes('staging-1') && h.includes('s-demo-0002')), heads.join(' || '));
  ok('B4 每张卡都有「可用目的」行', (await count('[data-testid="ap-purpose"]')) >= 3);
  const purposes = await page.evaluate(() => [...document.querySelectorAll('[data-testid="ap-purpose"]')].map((p) => p.textContent));
  ok('B5 prod-1 卡的目的=会话当前目标（投影可见）',
    purposes.some((p) => p.includes('把 /tmp/old-build 清理掉')), purposes[0]);
  ok('B6 staging-1（无目标）卡的目的**明确缺失**（不留白误读为无风险）',
    purposes.some((p) => /未提供/.test(p)), purposes.find((p) => /未提供/.test(p)) || '（无缺失态）');
  ok('B7 卡片展示核心自算的破坏性提示（target_summary）', (await count('.tsum-chip')) >= 1);

  // ---- C. 首次委托显式（§6.7） ----
  const newSid = await connectHost('本机');
  ok('C0 人类新建会话初始为 Human 持有', !!newSid);
  await selectTab('本机');
  const btnLabel0 = await txt('[data-testid="delegate-open"]');
  ok('C1 首次委托入口措辞为「交给 Agent…」', /交给 Agent/.test(btnLabel0 || ''), btnLabel0);
  await clickSafe('[data-testid="delegate-open"]');
  await sleep(500);
  ok('C2 打开首次委托对话框', (await count('[data-testid="delegate-dlg"]')) === 1);
  const dlgTxt = await txt('[data-testid="delegate-dlg"]');
  ok('C3 对话框展示主机/会话/能力/现有授权范围四项事实',
    /主机/.test(dlgTxt) && /会话/.test(dlgTxt) && /能力/.test(dlgTxt) && /现有授权范围/.test(dlgTxt));
  ok('C4 能力如实告知：无持久 Shell（demo 未注入集成）', /无持久 Shell/.test(dlgTxt || ''), ((dlgTxt || '').match(/无持久 Shell[^<]*/) || [''])[0]);
  // 取消不改控制权
  await page.evaluate(() => { [...document.querySelectorAll('[data-testid="delegate-dlg"] button')].find((b) => b.textContent.includes('取消'))?.click(); });
  await sleep(400);
  ok('C5 取消对话框不改动控制权', (await demoInvoke('list_sessions')).find((s) => s.id === newSid)?.control_owner === 'Human');
  // 明确提交 → 切 Agent-owned
  await clickSafe('[data-testid="delegate-open"]');
  await sleep(400);
  await page.evaluate(() => {
    const ta = document.querySelector('[data-testid="delegate-dlg"] textarea');
    if (!ta) return;
    const proto = window.HTMLTextAreaElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(ta, '打包日志到 /tmp 后交还');
    ta.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await clickSafe('[data-testid="delegate-submit"]');
  await sleep(700);
  const afterDel = (await demoInvoke('list_sessions')).find((s) => s.id === newSid);
  ok('C6 明确提交后才切 Agent 持有（核心成功返回为准）', afterDel?.control_owner === 'Agent');
  const briefC = await demoInvoke('session_brief', { sid: newSid });
  ok('C7 委托时写的任务目标落库（Agent 读简报可见）', briefC?.goal === '打包日志到 /tmp 后交还', String(briefC?.goal));
  await sleep(3600); // 等 3s 轮询把 owner/ever_agent_owned 刷新到工具栏
  // 委托后控制权在 Agent：工具栏转为「接管」入口，不再显示委托钮（交还措辞见 D6，接管后才出现）
  const tkBtn = await page.evaluate(() => [...document.querySelectorAll('.session-toolbar button')].some((b) => b.textContent.trim() === '接管'));
  ok('C8 委托后工具栏转为「接管」入口（控制权已在 Agent）', tkBtn && (await count('[data-testid="delegate-open"]')) === 0);

  // ---- D. 接管作废旧请求 + 停止是独立动作（§6.7 / D06） ----
  await demoInvoke('demo_inject_approval', { sid: newSid, command: 'rm -rf /var/tmp/*', target_summary: '删除文件/目录' }).catch(() => null);
  await sleep(3600);
  const pend = async () => (await demoInvoke('list_approvals', { pendingOnly: false })).filter((a) => a.session_id === newSid && a.status === 'pending').length;
  const pendingBefore = await pend();
  ok('D1 注入的待审批进入该会话队列', pendingBefore >= 1, `待审批=${pendingBefore}`);
  // 接管（仅冻结，不停止运行中任务）
  await page.evaluate(() => {
    const b = [...document.querySelectorAll('.session-toolbar button')].find((x) => x.textContent.trim() === '接管');
    b?.click();
  });
  await sleep(900);
  const afterTk = (await demoInvoke('list_sessions')).find((s) => s.id === newSid);
  ok('D2 接管把控制权收回人类', afterTk?.control_owner === 'Human');
  ok('D3 接管不抹掉「曾被 Agent 持有」印记（措辞仍为交还）', afterTk?.ever_agent_owned === true);
  const stillPending = await pend();
  ok('D4 接管作废交接前未开始的请求（待审批清零）', stillPending === 0, `剩余=${stillPending}`);
  const voided = (await demoInvoke('list_approvals', { pendingOnly: false })).filter((a) => a.session_id === newSid && a.status === 'voided').length;
  ok('D5 作废留痕（卡片转 voided，不可复活）', voided >= 1, `作废=${voided}`);
  await sleep(3600);
  const btnLabel2 = await txt('[data-testid="delegate-open"]');
  ok('D6 接管后入口仍为「交还 Agent」（历史不因接管抹掉）', /交还 Agent/.test(btnLabel2 || ''), btnLabel2);

  // ---- E. 窄窗完整视图：长命令完整可见（§4.2） ----
  // 注入一条超长命令，直接对准规范对象（待审批卡的 .cmd / 原动作），避免只测代理元素
  const longCmd = 'tar czf /tmp/backup-' + 'x'.repeat(220) + '.tgz /var/log && find /var/log -name "*.gz" -mtime +7 -delete';
  const sidE = (await demoInvoke('list_sessions')).find((s) => s.host_name === 'prod-1')?.id || newSid;
  await demoInvoke('demo_inject_approval', { sid: sidE, command: longCmd, target_summary: '删除文件/目录' }).catch(() => null);
  await sleep(3600);
  await page.setViewportSize({ width: 1024, height: 768 });
  await sleep(700);
  // 确保协作面板处于打开态（B 段已开；此处幂等校正，避免误关）
  if ((await txt('[data-testid="tp-title"]')) !== '协作') { await clickSafe('[data-testid="tools-collab"]'); await sleep(700); }
  const fullView = await page.evaluate(() => !!document.querySelector('.task-panel.tp-full'));
  const longCmdFullyVisible = await page.evaluate(() => {
    const el = [...document.querySelectorAll('.collab-approvals .tl-cmd-text')]
      .find((e) => e.textContent.length > 20);
    if (!el) return { missing: true };
    const cs = getComputedStyle(el);
    return { ws: cs.whiteSpace, overflow: el.scrollWidth <= el.clientWidth + 1, clipped: cs.textOverflow };
  });
  // §4.2 规范对象：**待审批卡**的命令（.cmd）在完整视图下必须完整可见，不是省略号
  const pendingCmdVisible = await page.evaluate((cmd) => {
    const el = [...document.querySelectorAll('.collab-approvals .cmd')].find((e) => e.textContent === cmd);
    if (!el) return { missing: true };
    const cs = getComputedStyle(el);
    return { ws: cs.whiteSpace, wb: cs.wordBreak, fits: el.scrollWidth <= el.clientWidth + 1, clipped: cs.textOverflow, len: el.textContent.length };
  }, longCmd);
  ok('E1 窄窗下协作面板进入完整视图（tp-full）', fullView);
  ok('E2 完整视图下长命令不被省略号截断（可横向/纵向查看完整内容）',
    !longCmdFullyVisible.missing && longCmdFullyVisible.ws !== 'nowrap' && longCmdFullyVisible.clipped !== 'ellipsis',
    JSON.stringify(longCmdFullyVisible));
  ok('E2b 待审批卡的超长原动作在完整视图下完整可见（§4.2 规范对象，非代理元素）',
    !pendingCmdVisible.missing && pendingCmdVisible.fits && pendingCmdVisible.clipped !== 'ellipsis',
    JSON.stringify(pendingCmdVisible));
  await page.setViewportSize({ width: 1280, height: 800 });
  await sleep(500);

  ok('Z 主场景零 JS 异常', jsErrors.length === 0, jsErrors.join(' | '));
  await ctx.close();

  // ================= 新装未启用（§6.7 首条）=================
  const ctx2 = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page2 = await ctx2.newPage();
  const jsErrors2 = [];
  page2.on('pageerror', (e) => jsErrors2.push(String(e)));
  await page2.goto(URL + '?fresh', { waitUntil: 'domcontentloaded' });
  await page2.evaluate(() => { try { localStorage.clear(); } catch {} });
  await page2.reload({ waitUntil: 'domcontentloaded' });
  await page2.waitForSelector('.host-card', { timeout: 10000 });
  await sleep(500);
  const count2 = (s) => page2.evaluate((sel) => document.querySelectorAll(sel).length, s);
  const txt2 = (s) => page2.evaluate((sel) => document.querySelector(sel)?.textContent ?? null, s);

  // 新装：无 Agent 配置、无审批、无 Agent 活动
  ok('G1 新装未启用协作时无协作提醒徽标', (await count2('[data-testid="collab-entry"]')) === 0);
  await page2.evaluate(() => { [...document.querySelectorAll('.tab')].find((t) => t.textContent.includes('prod-1'))?.click(); });
  await sleep(700);
  // 从会话工具栏进协作面板 → 一次性引导（而非空审批区）
  await page2.evaluate(() => document.querySelector('[data-testid="tools-collab"]')?.click());
  await sleep(600);
  ok('G2 协作面板改为一次性引导（不渲染空壳）', (await count2('[data-testid="collab-unconfigured"]')) === 1);
  ok('G3 不出现空审批区（无分组、无待审批列表）', (await count2('[data-testid="ap-group"]')) === 0 && (await count2('.collab-approvals')) === 0);
  ok('G4 不出现空白委托表单（无任务目标输入框）', (await count2('.goal-input')) === 0);
  ok('G5 不出现首次委托入口（未配置不显示「交给 Agent」）', (await count2('[data-testid="delegate-open"]')) === 0);
  // 引导按钮跳到设置 → Agent 接入
  await page2.evaluate(() => document.querySelector('[data-testid="collab-open-settings"]')?.click());
  await sleep(700);
  const agentPane = await count2('[data-testid="agent-list"]');
  ok('G6 引导到「设置 → Agent 接入」且无已登记 Agent', (await count2('[data-testid="agent-empty"]')) === 1 && agentPane === 0);
  ok('G7 MCP 端点配置在设置里（不再出现在主界面协作面板）', (await count2('[data-testid="agent-endpoint"]')) === 1);
  ok('Z2 新装场景零 JS 异常', jsErrors2.length === 0, jsErrors2.join(' | '));
  await ctx2.close();

  await browser.close();
 } catch (e) {
  console.log('FAIL 探针异常：' + (e && e.stack ? e.stack : e));
  results.push({ name: '探针异常', pass: false });
 }
 const pass = results.filter((r) => r.pass).length;
 console.log(`\n== R42 demo 探针 ${pass}/${results.length} ==`);
 if (pass !== results.length) process.exitCode = 1;
})();
