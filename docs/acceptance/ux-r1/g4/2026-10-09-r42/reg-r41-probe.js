// R41 demo 探针（活动记录、连接详情与凭据设置 §6.6 / §5 / S09-S11 / D01-D02）：
// 连接详情=独立可关闭对话框且展示**连接当时**的身份快照（主机改址后不漂）；session ID 可复制；
// 活动记录=独立工作区视图（不再寄生协作面板），默认当前会话可切全部、可筛人类/Agent 与事件类型、
// 时间含日期与时区、seq 游标翻页不重不漏、会话关闭后记录仍带主机/会话身份；
// 设置=左分类单对话框，凭据**显式提交**（不即时保存）、未绑定态、引用检查删除、切分类先处理草稿。
// 域说明：demo 无真实 SSH/监听，详情快照取自 demo 会话的 host_snapshot（真实面 = core r41_tests
// 的 SessionHandle 构造期 Host 副本 + 原生冒烟 r41a/b/c）。凭据落库语义 demo 与 vault 同口径。
const { chromium } = require('/Users/chenpu/node_modules/playwright');
const EXE = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const URL = process.env.PROBE_URL || 'http://localhost:5183/';
const results = [];
const ok = (name, cond, detail = '') => { results.push({ name, pass: !!cond }); console.log((cond ? 'PASS ' : 'FAIL ') + name + (detail ? '  [' + detail + ']' : '')); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
 try {
  const browser = await chromium.launch({ executablePath: EXE, headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, permissions: ['clipboard-read', 'clipboard-write'] });
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
  const waitFor_ = async (fn, tries, gap = 150) => {
    for (let i = 0; i < tries; i++) { const v = await fn(); if (v) return v; await sleep(gap); }
    return null;
  };
  const txt = (sel) => page.evaluate((s) => document.querySelector(s)?.textContent ?? null, sel);
  const count = (sel) => page.evaluate((s) => document.querySelectorAll(s).length, sel);
  const clickText = (sel, needle) => page.evaluate(({ s, n }) => {
    [...document.querySelectorAll(s)].find((x) => x.textContent.includes(n))?.click();
  }, { s: sel, n: needle });
  const clickSafe = async (sel, timeout = 3000) => { try { await page.click(sel, { timeout }); return true; } catch { return false; } };
  const selectSafe = async (sel, v, timeout = 3000) => { try { await page.selectOption(sel, v, { timeout }); return true; } catch { return false; } };
  const valSafe = (sel) => page.evaluate((s) => document.querySelector(s)?.value ?? '', sel);
  const attrSafe = (sel, a) => page.evaluate(({ s, a }) => document.querySelector(s)?.getAttribute(a) ?? null, { s: sel, a });
  const openTools = async (testid) => {
    await page.evaluate(() => { [...document.querySelectorAll('.st-tools button')].find((b) => b.textContent.includes('工具'))?.click(); });
    await sleep(220);
    const hit = await clickSafe(`[data-testid="${testid}"]`);
    await sleep(500);
    return hit;
  };
  const setNativeValue = (sel, value) => page.evaluate(({ sel, value }) => {
    const el = document.querySelector(sel);
    if (!el) return;
    const proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }, { sel, value });

  // ---- 准备：激活已存在的 prod-1 会话（demo 预置 s-demo-0001） ----
  await page.evaluate(() => { [...document.querySelectorAll('.tab')].find((t) => t.textContent.includes('prod-1'))?.click(); });
  await sleep(700);
  const sid = (await demoInvoke('list_sessions')).find((s) => s.host_name === 'prod-1').id;

  // ===== A. 连接详情：独立可关闭对话框 + 完整身份 =====
  const openedA = await openTools('tools-conn-detail');
  ok('A1 连接详情是独立对话框（工具菜单里有入口）', openedA && (await count('[data-testid="conn-detail"]')) === 1);
  const det = {
    host: await txt('[data-testid="cd-host"]'), user: await txt('[data-testid="cd-user"]'),
    addr: await txt('[data-testid="cd-addr"]'), port: await txt('[data-testid="cd-port"]'),
    auth: await txt('[data-testid="cd-auth"]'), fp: await txt('[data-testid="cd-fp"]'),
    cs: await txt('[data-testid="cd-charset"]'), created: await txt('[data-testid="cd-created"]'),
    sid: await txt('[data-testid="cd-sid"]'),
  };
  ok('A2 详情展示用户/地址/端口/认证类型/指纹/编码/创建时间',
    det.user === 'ops' && det.addr === '10.0.0.11' && det.port === '22' && det.auth === '密码'
    && !!det.fp && !!det.cs && !!det.created,
    JSON.stringify(det));
  ok('A3 创建时间含日期与时区说明', /\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/.test(det.created) && /UTC[+-]\d{2}:\d{2}/.test(det.created), det.created);
  ok('A4 技术详情里 session ID 可复制（显示完整 id + 复制钮）', det.sid === sid && (await count('[data-testid="cd-copy"]')) === 1, det.sid);
  await clickSafe('[data-testid="cd-copy"]');
  await sleep(300);
  const copied = await page.evaluate(() => navigator.clipboard.readText().catch(() => ''));
  ok('A5 复制到剪贴板的是会话 ID', copied === sid, String(copied));
  ok('A6 详情里不出现私钥/口令明文', !/PRIVATE KEY|passphrase|口令/.test(JSON.stringify(det)));
  await clickSafe('[data-testid="cd-close"]');
  await sleep(250);
  ok('A7 关闭按钮可独立关闭详情（不影响会话）', openedA && (await count('[data-testid="conn-detail"]')) === 0
    && (await demoInvoke('list_sessions')).some((s) => s.id === sid));
  // A8：Esc 也是「独立可关闭」的一条路（vis-r41 B4：此前 Esc 链漏了详情层）
  await openTools('tools-conn-detail');
  await sleep(400);
  const escOpen = (await count('[data-testid="conn-detail"]')) === 1;
  await page.keyboard.press('Escape');
  await sleep(350);
  ok('A8 Esc 可关闭详情（与设置对话框行为一致）', escOpen && (await count('[data-testid="conn-detail"]')) === 0);

  // ===== B. 详情是「连接当时」的快照：主机改址后不漂 =====
  const hosts0 = await demoInvoke('list_hosts');
  const h0 = hosts0.find((h) => h.name === 'prod-1');
  await demoInvoke('upsert_host', { host: { id: h0.id, name: 'prod-1-改名', address: '10.0.0.99', port: 2222, username: 'ops', auth: 'Keep', charset: 'utf-8' } });
  await sleep(300);
  await openTools('tools-conn-detail');
  const det2 = { host: await txt('[data-testid="cd-host"]'), addr: await txt('[data-testid="cd-addr"]'), port: await txt('[data-testid="cd-port"]') };
  ok('B1 主机改名/改址后，详情仍显示**连接时**的身份（§6.1）',
    det2.addr === '10.0.0.11' && det2.port === '22' && det2.host === 'prod-1',
    JSON.stringify(det2));
  await clickSafe('[data-testid="cd-close"]');
  await sleep(200);

  // ===== C. 活动记录：独立工作区视图，默认当前会话 =====
  await openTools('tools-activity');
  ok('C1 活动记录是右侧工作区视图（非对话框）', (await count('[data-testid="log-note"]')) === 1 && (await txt('[data-testid="tp-title"]')) === '活动记录');
  ok('C2 默认当前会话（段钮选中态）',
    (await attrSafe('[data-testid="log-scope-current"]', 'aria-pressed')) === 'true');
  const curN = await count('[data-testid="log-row"]');
  await clickSafe('[data-testid="log-scope-all"]');
  await sleep(600);
  const allN = await count('[data-testid="log-row"]');
  ok('C3 可切全部会话且是超集（记录不因切范围丢失）', allN >= curN && allN > 0, `当前=${curN} 全部=${allN}`);

  // ===== D. 筛选：人类/Agent 与事件类型 =====
  await clickSafe('[data-testid="log-scope-current"]');
  await sleep(500);
  await selectSafe('[data-testid="log-actor"]', 'agent');
  await sleep(600);
  const actors = await page.evaluate(() => [...document.querySelectorAll('[data-testid="log-row"]')].map((r) => r.dataset.actor));
  ok('D1 可筛 Agent（结果全为 agent）', actors.length > 0 && actors.every((a) => a === 'agent'), actors.join(','));
  await selectSafe('[data-testid="log-actor"]', 'human');
  await sleep(600);
  const actors2 = await page.evaluate(() => [...document.querySelectorAll('[data-testid="log-row"]')].map((r) => r.dataset.actor));
  ok('D2 可筛人类（结果全为 human）', actors2.length > 0 && actors2.every((a) => a === 'human'), actors2.join(','));
  await selectSafe('[data-testid="log-actor"]', '');
  await sleep(400);
  await selectSafe('[data-testid="log-action"]', 'exec');
  await sleep(600);
  const acts = await page.evaluate(() => [...document.querySelectorAll('[data-testid="log-row"]')].map((r) => r.dataset.action));
  ok('D3 可筛事件类型（结果全为 exec）', acts.length > 0 && acts.every((a) => a === 'exec'), acts.join(','));
  await selectSafe('[data-testid="log-action"]', '');
  await sleep(500);
  // D4（rev-r41 低-1）：候选下拉必须用与列表一致的中文名——`goal_set` 不在 AUDIT_LABELS 里，
  // 走 auditLabel 会回落成原始键名，用户无法把下拉项与列表里的「更新/清除任务目标」对上。
  const actOpts = await page.evaluate(() => [...document.querySelectorAll('[data-testid="log-action"] option')].map((o) => ({ v: o.value, t: o.textContent })));
  const gs = actOpts.find((o) => o.v === 'goal_set');
  ok('D4 事件类型下拉里 goal_set 有中文名（与列表口径一致）', !!gs && gs.t !== 'goal_set' && /任务目标/.test(gs.t), JSON.stringify(gs));

  // ===== E. 时间含日期与时区；保留主机/会话身份 =====
  const note = await txt('[data-testid="log-note"]');
  ok('E1 面板标注本机时区', /UTC[+-]\d{2}:\d{2}/.test(note || ''), note);
  const metas = await page.evaluate(() => [...document.querySelectorAll('[data-testid="log-row"] .tl-meta')].map((m) => m.textContent));
  ok('E2 每条时间含日期（YYYY-MM-DD）', metas.length > 0 && metas.every((m) => /\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/.test(m)), metas[0]);
  ok('E3 每条保留主机与会话身份', metas.length > 0 && metas.every((m) => m.includes('prod-1') && m.includes('s-demo-0001')), `${metas.length} 条 · ${metas[0] ?? '（无行）'}`);

  // ===== F. 记录连续：seq 游标翻页不重不漏（后端口径，同 demo 镜像） =====
  const page1 = await demoInvoke('audit_query', { sid: null, limit: 2 });
  const page2 = await demoInvoke('audit_query', { sid: null, limit: 2, beforeSeq: page1.events[page1.events.length - 1].seq });
  const seqs1 = page1.events.map((e) => e.seq), seqs2 = page2.events.map((e) => e.seq);
  ok('F1 游标翻页：第二页 seq 全部小于第一页末条', seqs2.length > 0 && seqs2.every((s) => s < seqs1[seqs1.length - 1]), `${seqs1} | ${seqs2}`);
  ok('F2 游标翻页：两页无重复', seqs1.every((s) => !seqs2.includes(s)), `${seqs1} | ${seqs2}`);
  ok('F3 total 是过滤后总数，不随翻页缩水', page1.total === page2.total && page1.total > 0, `${page1.total} vs ${page2.total}`);

  // ===== G. 会话关闭后记录仍在，且仍带主机身份 =====
  await clickSafe('[data-testid="log-scope-all"]');
  await sleep(600);
  const before = await count('[data-testid="log-row"]');
  await demoInvoke('close_session', { sid });
  await sleep(700);
  await clickSafe('[data-testid="log-refresh"]');
  await sleep(700);
  const after = await count('[data-testid="log-row"]');
  const metas2 = await page.evaluate(() => [...document.querySelectorAll('[data-testid="log-row"] .tl-meta')].map((m) => m.textContent));
  ok('G1 会话关闭后其记录仍可查（记录连续）', after >= before && metas2.some((m) => m.includes('s-demo-0001')), `前=${before} 后=${after}`);
  const closed = metas2.filter((m) => m.includes('s-demo-0001'));
  ok('G2 关闭后记录仍保留主机身份（不因会话消失而失名）',
    closed.length > 0 && closed.every((m) => m.includes('prod-1')), closed[0] ?? '（无该会话的行）');

  // ===== H. 活动记录不再寄生协作面板（§193） =====
  // 「工具」入口挂在 current 会话上——G 已关掉 prod-1，先切到仍在的 staging-1 再开菜单，
  // 否则菜单入口不在，断言会变成「菜单没开」而非「面板里没有操作记录」（假红）。
  await page.evaluate(() => { [...document.querySelectorAll('.tab')].find((t) => t.textContent.includes('staging-1'))?.click(); });
  await sleep(800);
  const toolsBtnReady = await waitFor_(() => page.evaluate(() => [...document.querySelectorAll('.st-tools button')].some((b) => b.textContent.includes('工具'))), 30);
  // R42 §12 变更：§3.2 精确枚举后「工具」菜单不再有「审批与记录」项——改由会话工具栏的
  // 「协作」按钮（data-testid=tools-collab）打开协作面板。断言对象同步更新，其余不变。
  await page.evaluate(() => document.querySelector('[data-testid="tools-collab"]')?.click());
  await sleep(800);
  const collabTitle = await txt('[data-testid="tp-title"]');
  const collab = await page.evaluate(() => document.querySelector('.task-panel')?.textContent ?? '');
  ok('H1 协作面板里不再有「操作记录」长滚动段', !!toolsBtnReady && collabTitle === '协作' && !collab.includes('操作记录'), `title=${collabTitle}`);

  // ===== M. 右栏完整视图态下，对话框必须仍在最上层（vis-r41 定向复验 B5） =====
  // 窄窗（≲1104px）下「工具→活动记录」把右栏转成**完整视图**（`.task-panel.tp-full` z-index:40）；
  // 对话框若停在 z-index:30 就被整块盖住——1024×768 实测 11/11 元素不可达，用户从菜单点
  // 「连接详情…」后屏幕上什么都看不到。修法：遮罩/对话框提到 41/42（仍低于确认框/toast）。
  await page.setViewportSize({ width: 1024, height: 768 });
  await sleep(600);
  await page.evaluate(() => { [...document.querySelectorAll('.st-tools button')].find((b) => b.textContent.includes('工具'))?.click(); });
  await sleep(250);
  await clickText('.tools-menu button', '活动记录');
  await sleep(900);
  const fullView = await page.evaluate(() => !!document.querySelector('.task-panel.tp-full'));
  await openTools('tools-conn-detail');
  await sleep(600);
  const hitTop = await page.evaluate(() => {
    const d = document.querySelector('[data-testid="conn-detail"]');
    if (!d) return null;
    const r = d.getBoundingClientRect();
    const el = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return { inDetail: !!el && d.contains(el), top: Math.round(r.top), w: Math.round(r.width) };
  });
  ok('M1 右栏完整视图态下连接详情仍可达（未被面板盖住）', fullView && !!hitTop && hitTop.inDetail,
    JSON.stringify({ fullView, hitTop }));
  // M2：遮罩也必须压住面板。否则对话框虽可见，**面板却仍可点**——模态形同虚设
  //（M1 只验对话框自身可达，单独把遮罩降回 29 时 M1 仍绿，故必须另立断言）。
  const maskBlocks = await page.evaluate(() => {
    const d = document.querySelector('[data-testid="conn-detail"]');
    const p = document.querySelector('.task-panel.tp-full');
    if (!d || !p) return null;
    const dr = d.getBoundingClientRect(), pr = p.getBoundingClientRect();
    const x = pr.left + 12, y = pr.bottom - 12; // 面板内、对话框外的取样点
    if (x >= dr.left && x <= dr.right && y >= dr.top && y <= dr.bottom) return { skipped: 'inside-dialog' };
    const el = document.elementFromPoint(x, y);
    const cls = el ? String(el.className) : null;
    return { x: Math.round(x), y: Math.round(y), cls, isMask: !!cls && cls.split(/\s+/).includes('pop-mask') };
  });
  ok('M2 遮罩压住完整视图面板（模态期间面板不可点）', !!maskBlocks && maskBlocks.isMask === true,
    JSON.stringify(maskBlocks));
  await page.keyboard.press('Escape');
  await sleep(350);

  // ===== N. 分屏菜单不被自己的遮罩吃掉（R41 代码复验 C-2） =====
  // `.split-menu` 与 `.pop-mask` 是**同父兄弟**：遮罩为修 B5 抬到 41 后，菜单若仍停在 30 就被
  // 自己的遮罩整块盖住——真鼠标点击落在遮罩上，菜单项永远点不到（分屏进不去）。
  // 断言必须用**命中身份**（elementFromPoint 落在菜单内）：只断言「菜单关闭」会与「点到遮罩
  // 也关闭」混淆而假绿。
  await page.evaluate(() => {
    [...document.querySelectorAll('button')].find((b) => (b.getAttribute('title') || '').includes('分屏'))?.click();
  });
  await sleep(350);
  const smHit = await page.evaluate(() => {
    const m = document.querySelector('.split-menu');
    if (!m) return { open: false };
    const item = m.querySelector('.sm-item');
    const r = item.getBoundingClientRect();
    const el = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    const z = (s) => { const e = document.querySelector(s); return e ? getComputedStyle(e).zIndex : null; };
    return {
      open: true, hitSelf: !!el && (el === item || item.contains(el)),
      hitCls: el ? String(el.className).slice(0, 40) : null,
      zMask: z('.pop-mask'), zMenu: z('.split-menu'), zPanel: z('.task-panel.tp-full'),
    };
  });
  ok('N1 分屏菜单项可被命中（未被自身遮罩盖住）', smHit.open && smHit.hitSelf, JSON.stringify(smHit));
  ok('N2 层叠序：遮罩 > 完整视图面板(40)；分屏菜单 > 遮罩',
    smHit.zPanel === '40' && Number(smHit.zMask) > 40 && Number(smHit.zMenu) > Number(smHit.zMask),
    JSON.stringify({ mask: smHit.zMask, menu: smHit.zMenu, panel: smHit.zPanel }));
  await page.keyboard.press('Escape');
  await sleep(300);

  await page.setViewportSize({ width: 1280, height: 800 });
  await sleep(500);

  // ===== L. 无会话 + 范围=当前会话：标题不得宣称条数（rev-r41 低-2） =====
  // 无会话时 `sidRef.current` 为 null，原实现照常下发会**退化成全局查询**：正文已渲染
  // 「未接入会话」空态，标题却按全局总数宣称「共 N 条」，两处自相矛盾。
  // 经 **UI** 关闭（标签 ✕ → 确认「关闭会话」），不走直调命令——直调不会清前端的 `sid`
  // 状态（`disconnectSid` 的 `setSid(null)` 只在 UI 路径跑），那会造出「会话已关但 sid 还挂着」
  // 的探针假象。真实用户路径必过 UI。
  await clickSafe('[data-testid="log-scope-current"]');
  for (let i = 0; i < 4; i++) {
    if ((await count('.tab-x')) === 0) break;
    await page.evaluate(() => document.querySelector('.tab-x')?.click());
    await sleep(400);
    if ((await count('.confirm-dialog')) > 0) { await clickText('.confirm-dialog button', '关闭会话'); }
    await sleep(900);
  }
  // 会话列表靠 3s 轮询回收（`refreshLists`）——等 React 状态跟上（标签清空）再断言。
  await waitFor_(() => page.evaluate(() => document.querySelectorAll('.tab').length === 0), 40, 250);
  await sleep(700);
  const lnote = await txt('[data-testid="log-note"]');
  const lrows = await count('[data-testid="log-row"]');
  const lnosess = await count('[data-testid="log-empty-nosession"]');
  ok('L1 无会话时标题不宣称条数（与空态一致）',
    !/共 \d+ 条/.test(lnote || '') && lrows === 0 && lnosess === 1,
    JSON.stringify({ note: lnote, rows: lrows, nosess: lnosess }));

  // ===== I. 设置：左分类 + 凭据显式提交 =====
  await clickSafe('.hb-settings');
  await sleep(400);
  ok('I1 设置是左分类 + 右内容的单对话框',
    (await count('.settings-nav button')) === 5 && (await count('.settings-body')) === 1);
  // R42 §12 变更：设置新增「Agent 接入」分类（§5 迁移表：MCP 配置从协作面板迁入），
  // 故分类数 4 → 5；补一条新分类可达性断言。
  await clickSafe('[data-testid="settings-cat-agent"]');
  await sleep(300);
  ok('I1b 设置含「Agent 接入」分类（R42 新增，MCP 配置迁入）', (await count('[data-testid="agent-endpoint"]')) === 1);
  await clickSafe('[data-testid="settings-cat-credentials"]');
  await sleep(400);
  ok('I2 凭据是独立分类', (await txt('[data-testid="cred-empty"]')) !== null || (await count('.cred-row')) > 0);
  const n0 = (await demoInvoke('list_identities')).length;
  await clickSafe('[data-testid="cred-new"]');
  await sleep(250);
  await setNativeValue('[data-testid="cred-new-label"]', 'r41-key');
  await sleep(150);
  const nMid = (await demoInvoke('list_identities')).length;
  ok('I3 填表本身不落库（不即时保存）', (await count('[data-testid="cred-new-form"]')) === 1 && nMid === n0, `form=${await count('[data-testid="cred-new-form"]')} ${n0} -> ${nMid}`);
  await clickSafe('[data-testid="cred-new-gen-ed"]');
  await sleep(700);
  const n1 = (await demoInvoke('list_identities')).length;
  ok('I4 点「生成」才显式提交落库', n1 === n0 + 1, `${n0} -> ${n1}`);
  ok('I5 提交后给出凭据名与指纹供确认', (await txt('[data-testid="cred-new-ok"]'))?.includes('r41-key') === true,
    await txt('[data-testid="cred-new-ok"]'));
  ok('I6 新凭据显示为「未绑定」', (await page.evaluate(() => [...document.querySelectorAll('.cred-row')].find((r) => r.textContent.includes('r41-key'))?.textContent ?? '')).includes('未绑定'));

  // ===== J. 草稿保护：切分类前先处理未提交的敏感表单 =====
  await setNativeValue('[data-testid="cred-new-pem"]', '-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----');
  await sleep(200);
  await clickSafe('[data-testid="settings-cat-appearance"]');
  await sleep(300);
  ok('J1 有未提交私钥草稿时切分类先拦下（未直接切走）',
    (await count('[data-testid="cred-draft"]')) === 1
    && (await attrSafe('[data-testid="settings-cat-credentials"]', 'aria-selected')) === 'true');
  await clickSafe('[data-testid="cred-draft-keep"]');
  await sleep(250);
  ok('J2 「留下继续编辑」保持草稿（仍可看到粘贴的私钥）',
    (await count('[data-testid="cred-draft"]')) === 0
    && (await valSafe('[data-testid="cred-new-pem"]')).includes('PRIVATE KEY'));
  await clickSafe('[data-testid="settings-cat-appearance"]');
  await sleep(250);
  await clickSafe('[data-testid="cred-draft-discard"]');
  await sleep(350);
  ok('J3 「丢弃草稿并切换」切到目标分类', (await count('[data-testid="settings-pane-appearance"]')) === 1);
  await clickSafe('[data-testid="settings-cat-credentials"]');
  await sleep(350);
  ok('J4 丢弃后草稿被清空（敏感字段不留存）', (await count('[data-testid="cred-new-form"]')) === 1 && (await valSafe('[data-testid="cred-new-pem"]')) === '');
  const nAfter = (await demoInvoke('list_identities')).length;
  ok('J5 丢弃草稿不会留下半成品凭据', (await count('[data-testid="cred-new-form"]')) === 1 && nAfter === n1, `${n1} -> ${nAfter}`);

  // ===== K. 引用检查：被主机引用的凭据不可删 =====
  const hosts = await demoInvoke('list_hosts');
  const target = (await demoInvoke('list_identities')).find((x) => x.label === 'r41-key');
  if (target) {
    await demoInvoke('upsert_host', { host: { id: null, name: 'r41-bound', address: '10.9.9.9', port: 22, username: 'ops', auth: { Key: { identity_id: target.id } }, charset: 'utf-8' } });
  }
  await sleep(400);
  await clickSafe('[data-testid="log-refresh"]').catch(() => {});
  await clickSafe('[data-testid="settings-close"]');
  await sleep(300);
  await clickSafe('.hb-settings');
  await sleep(500);
  await clickSafe('[data-testid="settings-cat-credentials"]');
  await sleep(500);
  const boundRow = await page.evaluate(() => [...document.querySelectorAll('.cred-row')].find((r) => r.textContent.includes('r41-key'))?.textContent ?? '');
  ok('K1 被引用凭据标为「使用中」并列出占用主机', !!target && boundRow.includes('使用中') && boundRow.includes('r41-bound'), boundRow || '（无该凭据行）');
  await page.evaluate(() => {
    const row = [...document.querySelectorAll('.cred-row')].find((r) => r.textContent.includes('r41-key'));
    row?.querySelector('.host-del')?.click();
  });
  await sleep(300);
  await clickText('.confirm-dialog button', '删除凭据');
  await sleep(700);
  ok('K2 删除被引用凭据被拒并说明占用主机',
    ((await txt('[data-testid="cred-err"]')) || '').includes('r41-bound'), await txt('[data-testid="cred-err"]'));
  ok('K3 拒绝后凭据仍在库里（不半删）', !!target && (await demoInvoke('list_identities')).some((x) => x.id === target.id));
  await clickSafe('[data-testid="settings-close"]');
  await sleep(250);

  // ===== Z. 零 JS 错误 =====
  ok('Z 全程零 JS 错误', jsErrors.length === 0, jsErrors.slice(0, 3).join(' | '));

  const pass = results.filter((r) => r.pass).length;
  console.log(`\n== R41 demo 探针 ${pass}/${results.length} ==`);
  await browser.close();
  process.exit(pass === results.length ? 0 : 1);
 } catch (e) {
  console.log('\n!! 探针中断：' + String(e).split('\n')[0]);
  console.log(`== R41 demo 探针（中断）${results.filter((r) => r.pass).length}/${results.length} ==`);
  process.exit(1);
 }
})();
