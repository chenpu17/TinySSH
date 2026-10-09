// R43 demo 探针（C9：新装启用、原子停用与旧 Agent 配置迁移；§9 line 551/562-568 / §6.7 line 391 / §10.1 item6；D03/D08）：
//  · 新装默认停用（D03）：全新态 collab_status=Disabled、collab 端点与 mcp 端点皆空、零已登记 Agent（无自动 MCP 监听）；
//    无协作徽标、无委托入口；协作面板 = 停用态指引（不渲染空审批区）；「设置 → Agent 接入」停用态无 MCP 配置/端点、仅启用钮。
//  · 显式启用：端点出现（真绑定形态）、状态转「已启用」；「已配置」与「有活动请求」分别显示（configured≠online）。
//  · 原子停用（D08）：预览事实齐备（受影响会话/待审批/已配置）且取消不改状态；确认停用 → 状态转「已停用」、端点清空、
//    Token/身份保留、Agent 会话转 Human 且保留「曾被 Agent 持有」印记；重新启用端点回来、旧会话不复活。
//  · 关协作面板不改变控制权（D08 首句）。
// 域说明：demo 无真实 SSH/MCP；真实面由 core r43_tests 与原生冒烟覆盖。demo 端点为演示串（非 127.0.0.1:port 精确形），
//          故此处用前缀正则；精确 `^\d+$/mcp$` 断言在原生冒烟。协作面板入口在会话工具栏（无会话时不可达）——
//          故本探针先连一台主机再断言面板/设置结构。
const { chromium } = require('/Users/chenpu/node_modules/playwright');
const EXE = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const BASE = process.env.PROBE_URL || 'http://localhost:5183/';
const results = [];
const ok = (name, cond, detail = '') => { results.push({ name, pass: !!cond }); console.log((cond ? 'PASS ' : 'FAIL ') + name + (detail ? '  [' + detail + ']' : '')); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
 let jsErrors = [];
 try {
  const browser = await chromium.launch({ executablePath: EXE, headless: true });

  // ================= 场景 A/B：?fresh 新装未启用 → 启用 → 委托 → 停用 → 重启用 =================
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => jsErrors.push(String(e)));
  await page.goto(BASE + '?fresh', { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => { try { localStorage.clear(); } catch {} });
  await page.goto(BASE + '?fresh', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.host-card', { timeout: 10000 });
  await sleep(500);

  const demoInvoke = (cmd, args) => page.evaluate(async ({ c, a }) => {
    const { invoke } = await import('/src/adapter/bridge.ts');
    return invoke(c, a);
  }, { c: cmd, a: args });
  const count = (sel) => page.evaluate((s) => document.querySelectorAll(s).length, sel);
  const txt = (sel) => page.evaluate((s) => document.querySelector(s)?.textContent ?? null, sel);
  const clickSafe = async (sel, timeout = 3000) => { try { await page.click(sel, { timeout }); return true; } catch { return false; } };
  const openCollab = async () => {
    if ((await txt('[data-testid="tp-title"]')) === '协作') return true;
    await clickSafe('[data-testid="tools-collab"]'); await sleep(450);
    return (await txt('[data-testid="tp-title"]')) === '协作';
  };
  const openAgentSettings = async () => {
    if (await count('[data-testid="settings-cat-agent"]')) return true;
    await openCollab();
    await clickSafe('[data-testid="collab-open-settings"]');
    if (!(await count('[data-testid="settings-cat-agent"]'))) {
      // 完整面板态没有「打开设置」入口 → 走主设置入口（主机栏设置钮）+ 切到 Agent 分类
      await clickSafe('.hb-settings'); await sleep(350);
      await clickSafe('[data-testid="settings-cat-agent"]');
    }
    await sleep(550);
    return (await count('[data-testid="settings-cat-agent"]')) > 0;
  };
  const waitTxt = async (sel, re, tries = 40) => {
    for (let i = 0; i < tries; i++) { const v = await txt(sel); if (v && re.test(v)) return v; await sleep(150); }
    return await txt(sel);
  };
  const EP_RE = /^http:\/\/127\.0\.0\.1:\d+\/mcp/;
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
      const s = (await demoInvoke('list_sessions')).find((x) => x.host_name.includes(needle) && x.state === 'Connected');
      if (s) return s.id;
      await sleep(150);
    }
    return null;
  };

  // ---- A. 新装默认停用（D03）----
  const cs0 = await demoInvoke('collab_status');
  ok('A1 新装 collab_status=Disabled', cs0 && cs0.state === 'Disabled', cs0 && cs0.state);
  ok('A2 新装 collab 端点为空（无自动 MCP 监听）', cs0 && cs0.endpoint === '', cs0 && cs0.endpoint);
  ok('A3 新装 configured_agents=0', cs0 && cs0.configured_agents === 0, cs0 && String(cs0.configured_agents));
  const ms0 = await demoInvoke('mcp_status');
  ok('A4 新装 mcp 端点为空', ms0 && ms0.endpoint === '', ms0 && ms0.endpoint);
  ok('A5 新装无已登记 Agent', ms0 && (ms0.agents || []).length === 0, ms0 && JSON.stringify(ms0.agents));
  ok('A6 新装无协作徽标', (await count('[data-testid="collab-entry"]')) === 0);
  ok('A7 新装无委托入口', (await count('[data-testid="delegate-open"]')) === 0);
  // 连一台主机（协作面板入口在会话工具栏）——不引入 Agent 配置/活动
  const sid = await connectHost('prod-1');
  ok('A8 连上真会话（面板入口可达）', !!sid, sid);
  if (!sid) throw new Error('no-session');
  await sleep(400);
  ok('A9 连接后仍无协作徽标（未配置且无活动）', (await count('[data-testid="collab-entry"]')) === 0);
  ok('A10 连接后仍无委托入口', (await count('[data-testid="delegate-open"]')) === 0);
  await openCollab();
  ok('A11 停用态协作面板 = 停用指引', (await count('[data-testid="collab-disabled"]')) === 1);
  ok('A12 停用态无空审批区（无分组）', (await count('[data-testid="ap-group"]')) === 0);
  ok('A13 停用态无审批列表容器', (await count('.collab-approvals')) === 0);
  await openAgentSettings();
  ok('A14 停用态设置显示停用说明', (await count('[data-testid="collab-disabled-note"]')) === 1);
  ok('A15 停用态不出现 MCP 端点', (await count('[data-testid="agent-endpoint"]')) === 0);
  ok('A16 停用态不出现停用钮', (await count('[data-testid="collab-disable-btn"]')) === 0);
  ok('A17 停用态出现启用钮', (await count('[data-testid="collab-enable-btn"]')) === 1);
  ok('A18 停用态无已配置 Agent 时不渲染 kept-agents 空壳', (await count('[data-testid="collab-kept-agents"]')) === 0);

  // ---- B. 显式启用 ----
  await clickSafe('[data-testid="collab-enable-btn"]');
  await sleep(700);
  const ep = await txt('[data-testid="agent-endpoint"]');
  ok('B1 启用后出现 MCP 端点（真绑定形态）', !!ep && EP_RE.test(ep.trim()), ep);
  ok('B2 启用后状态 chip=已启用', /已启用/.test(await txt('[data-testid="collab-state"]') || ''), await txt('[data-testid="collab-state"]'));
  ok('B3 启用后出现停用钮', (await count('[data-testid="collab-disable-btn"]')) === 1);
  ok('B4 已配置 0（未签发 Agent 时 configured 与 active 分别显示）', /已配置 0/.test(await txt('[data-testid="collab-configured"]') || ''), await txt('[data-testid="collab-configured"]'));
  ok('B5 有活动请求 0', /有活动请求 0/.test(await txt('[data-testid="collab-active"]') || ''), await txt('[data-testid="collab-active"]'));
  ok('B6 未配置 Agent 时仍无徽标', (await count('[data-testid="collab-entry"]')) === 0);
  // 签发 Agent（登记不改控制权）→ 徽标出现、configured=1、active 仍 0
  const tok = await demoInvoke('issue_agent', { id: 'r43-agent', label: 'R43 探针 Agent' });
  ok('B7 真命令签发 Agent 返回 Token', typeof tok === 'string' && tok.length > 8, String(tok).slice(0, 12));
  // collab.configured_agents 随 3s 轮询刷新——等待而非固定 sleep
  ok('B8 已配置 1（签发后）', /已配置 1/.test(await waitTxt('[data-testid="collab-configured"]', /已配置 1/) || ''), await txt('[data-testid="collab-configured"]'));
  ok('B9 有活动请求仍 0（configured≠online）', /有活动请求 0/.test(await txt('[data-testid="collab-active"]') || ''), await txt('[data-testid="collab-active"]'));
  ok('B10 有 Agent 配置后徽标出现', (await count('[data-testid="collab-entry"]')) === 1);
  await clickSafe('[data-testid="settings-close"]');
  await sleep(300);

  // ---- C. 关面板不改权 → 委托 → 有活动请求 ----
  const beforeOwner = (await demoInvoke('list_sessions')).find((x) => x.id === sid)?.control_owner;
  await openCollab();
  await clickSafe('[data-testid="tp-close"]');
  await sleep(300);
  const afterOwner = (await demoInvoke('list_sessions')).find((x) => x.id === sid)?.control_owner;
  ok('C1 关协作面板不改变控制权（D08 首句）', beforeOwner === afterOwner, `${beforeOwner}→${afterOwner}`);
  await demoInvoke('delegate_session', { sid, goal: '停用探针：打包日志到 /tmp' });
  await sleep(400);
  const afterDelegate = (await demoInvoke('list_sessions')).find((x) => x.id === sid);
  ok('C2 委托后 owner=Agent', afterDelegate && afterDelegate.control_owner === 'Agent', afterDelegate && afterDelegate.control_owner);
  await openAgentSettings();
  ok('C3 委托后「有活动请求 1」', /有活动请求 1/.test(await waitTxt('[data-testid="collab-active"]', /有活动请求 1/) || ''), await txt('[data-testid="collab-active"]'));

  // ---- D. 原子停用（D08）----
  await clickSafe('[data-testid="collab-disable-btn"]');
  await sleep(600);
  ok('D1 停用预览对话框出现', (await count('[data-testid="collab-disable-dlg"]')) === 1);
  const dlg = await txt('[data-testid="collab-disable-dlg"]') || '';
  ok('D2 预览事实齐全（主机/会话/待审批/已配置）', /主机|会话|待审批|已配置/.test(dlg));
  ok('D3 受影响 Agent 会话=1', (await txt('[data-testid="collab-impact-sessions"]')) === '1', await txt('[data-testid="collab-impact-sessions"]'));
  ok('D4 已配置 Agent=1（并注明 Token 保留）', (await txt('[data-testid="collab-impact-agents"]')) === '1', await txt('[data-testid="collab-impact-agents"]'));
  ok('D4b 待审批计数为数字', /^\d+$/.test((await txt('[data-testid="collab-impact-approvals"]')) || ''));
  await clickSafe('[data-testid="collab-disable-cancel"]');
  await sleep(400);
  ok('D5 取消停用不改状态', (await count('[data-testid="collab-disable-dlg"]')) === 0 && (await demoInvoke('collab_status')).state === 'Enabled');
  // 确认停用
  await clickSafe('[data-testid="collab-disable-btn"]');
  await sleep(400);
  await clickSafe('[data-testid="collab-disable-confirm"]');
  await sleep(800);
  const cs3 = await demoInvoke('collab_status');
  ok('D6 确认后状态=Disabled', cs3 && cs3.state === 'Disabled', cs3 && cs3.state);
  ok('D7 停用后 collab 端点清空', cs3 && cs3.endpoint === '', cs3 && cs3.endpoint);
  const ms2 = await demoInvoke('mcp_status');
  ok('D8 停用后 mcp 端点清空（端点停止）', ms2 && ms2.endpoint === '', ms2 && ms2.endpoint);
  ok('D9 停用后 Token/身份保留（Agent 未撤销）', ms2 && (ms2.agents || []).some((a) => a.id === 'r43-agent'), ms2 && JSON.stringify(ms2.agents));
  ok('D10 停用后状态 chip=已停用', /已停用/.test(await txt('[data-testid="collab-state"]') || ''), await txt('[data-testid="collab-state"]'));
  ok('D10b 停用后列出保留的 Agent（Token 保留说明）', (await count('[data-testid="collab-kept-agents"]')) === 1 && /R43 探针 Agent/.test(await txt('[data-testid="collab-kept-agents"]') || ''), await txt('[data-testid="collab-kept-agents"]'));
  const conv = (await demoInvoke('list_sessions')).find((x) => x.id === sid);
  ok('D11 Agent 会话转 Human', conv && conv.control_owner === 'Human', conv && conv.control_owner);
  ok('D12 转 Human 后保留「曾被 Agent 持有」印记', conv && conv.ever_agent_owned === true, conv && String(conv.ever_agent_owned));
  ok('D13 停用后无协作徽标', (await count('[data-testid="collab-entry"]')) === 0);

  // ---- E. 重新启用不复活旧动作 ----
  await clickSafe('[data-testid="collab-enable-btn"]');
  await sleep(800);
  const cs4 = await demoInvoke('collab_status');
  ok('E1 重新启用后状态=Enabled', cs4 && cs4.state === 'Enabled', cs4 && cs4.state);
  ok('E2 重新启用后端点回来', cs4 && EP_RE.test(cs4.endpoint || ''), cs4 && cs4.endpoint);
  const still = (await demoInvoke('list_sessions')).find((x) => x.id === sid);
  ok('E3 旧会话不复活为 Agent', still && still.control_owner === 'Human', still && still.control_owner);
  ok('E4 重新启用后徽标恢复（仍有已配置 Agent）', (await count('[data-testid="collab-entry"]')) === 1);

  // ---- F. 停用未收敛（DisableFailed）：只给「重试停用收敛」，不得直接重新启用（§9）----
  await page.goto(BASE + '?disablefailed', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.host-card', { timeout: 10000 });
  await sleep(500);
  const cs5 = await demoInvoke('collab_status');
  ok('F1 ?disablefailed → 状态 DisableFailed', cs5 && cs5.state === 'DisableFailed', cs5 && cs5.state);
  ok('F2 DisableFailed 端点为空（未运行）', cs5 && cs5.endpoint === '', cs5 && cs5.endpoint);
  await connectHost('prod-1');
  await openCollab();
  ok('F3 DisableFailed 面板 = 停用指引', (await count('[data-testid="collab-disabled"]')) === 1);
  await openAgentSettings();
  ok('F4 提示文案指明先「重试停用收敛」', /重试停用收敛/.test(await txt('[data-testid="collab-disabled-note"]') || ''), await txt('[data-testid="collab-disabled-note"]'));
  ok('F5 出现「重试停用收敛」钮', (await count('[data-testid="collab-retry-disable-btn"]')) === 1);
  ok('F6 未收敛时**不**出现「启用协作」钮', (await count('[data-testid="collab-enable-btn"]')) === 0);
  await clickSafe('[data-testid="collab-retry-disable-btn"]');
  ok('F7 重试后收敛为已停用', /已停用/.test(await waitTxt('[data-testid="collab-state"]', /已停用/) || ''), await txt('[data-testid="collab-state"]'));
  ok('F8 收敛后出现「启用协作」钮', (await count('[data-testid="collab-enable-btn"]')) === 1);
  await clickSafe('[data-testid="collab-enable-btn"]');
  ok('F9 收敛后可重新启用', /已启用/.test(await waitTxt('[data-testid="collab-state"]', /已启用/) || ''), await txt('[data-testid="collab-state"]'));

  ok('Z 主场景零 JS 异常', jsErrors.length === 0, jsErrors.slice(0, 2).join(' | '));
  await ctx.close();
  await browser.close();
 } catch (e) {
  ok('EXCEPTION', false, String(e && e.message || e).slice(0, 200));
 }

 const pass = results.filter((r) => r.pass).length;
 console.log(`\n== R43 demo 探针 ${pass}/${results.length} ==`);
 process.exit(pass === results.length ? 0 : 1);
})();
