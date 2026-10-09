// vis-r42 独立视觉复验探针（不修改工作树；只读渲染 + 截图 + 证据）
const { chromium } = require('/Users/chenpu/node_modules/playwright');
const EXE = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const URL = process.env.PROBE_URL || 'http://localhost:5183/';
const OUT = '/Users/chenpu/workspace/claude-code/TinySSH/docs/acceptance/ux-r1/g4/2026-10-09-r42/';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ev = [];   // evidence log
const log = (k, v) => { ev.push({ k, v }); console.log('· ' + k + ' => ' + JSON.stringify(v)); };

(async () => {
  const browser = await chromium.launch({ executablePath: EXE, headless: true });

  // ============ 主场景（light，1280×800）============
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push(String(e)));
  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => { try { localStorage.clear(); } catch {} });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.host-card', { timeout: 10000 });
  await sleep(1000);

  const inv = (cmd, args) => page.evaluate(async ({ c, a }) => {
    const { invoke } = await import('/src/adapter/bridge.ts');
    return invoke(c, a);
  }, { c: cmd, a: args });
  const count = (s) => page.evaluate((x) => document.querySelectorAll(x).length, s);
  const txt = (s) => page.evaluate((x) => document.querySelector(x)?.textContent ?? null, s);
  const box = (s) => page.evaluate((x) => { const e = document.querySelector(x); if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; }, s);
  const clamp = (clip) => {
    if (!clip) return undefined;
    const vp = page.viewportSize();
    const x = Math.max(0, Math.min(clip.x, vp.width - 1));
    const y = Math.max(0, Math.min(clip.y, vp.height - 1));
    return { x, y, width: Math.max(1, Math.min(clip.width, vp.width - x)), height: Math.max(1, Math.min(clip.height, vp.height - y)) };
  };
  const shot = async (name, clip) => { await page.screenshot({ path: OUT + name, ...(clip ? { clip: clamp(clip) } : {}) }); console.log('  [shot] ' + name); };
  const clickSel = async (s, t = 3000) => { try { await page.click(s, { timeout: t }); return true; } catch { return false; } };
  const selectTab = async (n) => { await page.evaluate((x) => { [...document.querySelectorAll('.tab')].find((t) => t.textContent.includes(x))?.click(); }, n); await sleep(700); };
  const openCollab = async () => { await page.evaluate(() => document.querySelector('[data-testid="tools-collab"]')?.click()); await sleep(700); };
  const elFromPoint = (x, y) => page.evaluate(({ x, y }) => { const e = document.elementFromPoint(x, y); if (!e) return null; return { tag: e.tagName, cls: e.className, testid: e.getAttribute?.('data-testid') || null, inDlg: !!e.closest('[data-testid="delegate-dlg"]'), inPanel: !!e.closest('.task-panel'), text: (e.textContent || '').slice(0, 40) }; }, { x, y });

  // ---- A. 协作入口 ----
  await selectTab('prod-1');
  const A = await page.evaluate(() => {
    const b = document.querySelector('[data-testid="collab-entry"]');
    const cs = b ? getComputedStyle(b) : null;
    return {
      badgeExists: !!b, badgeText: b?.textContent ?? null, badgeCls: b?.className ?? null,
      badgeBg: cs?.backgroundColor, badgeColor: cs?.color,
      toolsCollab: !!document.querySelector('[data-testid="tools-collab"]'),
      toolbarBtns: [...document.querySelectorAll('.session-toolbar button')].map((x) => x.textContent.trim()),
    };
  });
  log('A1 collab-entry 徽标', A.badgeExists + ' | text=' + A.badgeText + ' | cls=' + A.badgeCls + ' | bg=' + A.badgeBg + ' color=' + A.badgeColor);
  log('A2 tools-collab 工具栏入口', A.toolsCollab);
  log('A3 会话工具栏按钮', A.toolbarBtns);
  const tb = await box('.titlebar');
  await shot('vis-r42-01-badge-hot-light.png', tb ? { x: 0, y: tb.y, width: 460, height: tb.h } : undefined);
  const st = await box('.session-toolbar');
  await shot('vis-r42-02-tools-collab-light.png', st ? { x: st.x, y: st.y, width: st.w, height: st.h } : undefined);

  // ---- B. 审批分组 + 可用目的 ----
  const sid2 = (await inv('list_sessions')).find((s) => s.host_name === 'staging-1').id;
  await inv('demo_inject_approval', { sid: sid2, command: 'systemctl restart nginx --now --no-block --preserve-env', target_summary: '服务管理' }).catch(() => null);
  await openCollab();
  await sleep(3600);
  const B = await page.evaluate(() => {
    const groups = [...document.querySelectorAll('[data-testid="ap-group"]')];
    const heads = [...document.querySelectorAll('.ap-group-head')].map((h) => h.textContent.replace(/\s+/g, ' ').trim());
    const purposes = [...document.querySelectorAll('[data-testid="ap-purpose"]')].map((p) => ({
      text: p.textContent.replace(/\s+/g, ' ').trim(),
      cls: p.className,
      color: getComputedStyle(p).color,
      missingSpanColor: (() => { const s = p.querySelector('.dim'); return s ? getComputedStyle(s).color : null; })(),
      w: p.getBoundingClientRect().width,
    }));
    const tsum = [...document.querySelectorAll('.tsum-chip')].map((c) => c.textContent.trim());
    return { groupCount: groups.length, heads, purposes, tsum };
  });
  log('B1 ap-group 组数', B.groupCount);
  log('B2 分组头', B.heads);
  log('B3 可用目的行', B.purposes);
  log('B4 破坏性提示 chip', B.tsum);
  await shot('vis-r42-03-approval-groups-light.png');
  // 缺失态像素证据：找「未提供」那张卡
  const miss = await page.evaluate(() => {
    const p = [...document.querySelectorAll('[data-testid="ap-purpose"]')].find((x) => /未提供/.test(x.textContent));
    if (!p) return null;
    const r = p.getBoundingClientRect();
    // 用 Range 量「未提供…」文本的实际渲染宽高（非零即确有可见文本）
    const span = p.querySelector('.dim');
    const range = document.createRange(); range.selectNodeContents(span);
    const rr = range.getBoundingClientRect();
    return { textW: rr.width, textH: rr.height, spanW: span.getBoundingClientRect().width, color: getComputedStyle(span).color, bg: getComputedStyle(p).backgroundColor };
  });
  log('B5 缺失态「未提供」文本渲染盒', miss);
  await page.evaluate(() => { const p = [...document.querySelectorAll('[data-testid="ap-purpose"]')].find((x) => /未提供/.test(x.textContent)); p?.scrollIntoView({ block: 'center' }); });
  await sleep(300);
  const mp = await page.evaluate(() => { const p = [...document.querySelectorAll('[data-testid="ap-purpose"]')].find((x) => /未提供/.test(x.textContent)); const r = p.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; });
  await shot('vis-r42-04-purpose-missing-light.png', mp ? { x: mp.x - 4, y: mp.y - 4, width: mp.w + 8, height: mp.h + 8 } : undefined);

  // ---- C. 首次委托对话框 ----
  // 连一台本机 → 人类持有 → 出现「交给 Agent…」
  await page.evaluate(() => {
    const card = [...document.querySelectorAll('.host-card')].find((c) => c.querySelector('.host-name')?.textContent.includes('本机'));
    card?.querySelector('.host-connect-btn')?.click();
  });
  await page.waitForSelector('.hk-mask', { timeout: 4000 }).catch(() => {});
  await page.evaluate(() => { [...document.querySelectorAll('.hk-mask button')].find((x) => x.textContent.includes('信任并连接'))?.click(); });
  let newSid = null;
  for (let i = 0; i < 60; i++) {
    const s = (await inv('list_sessions')).find((x) => x.host_name.includes('本机') && x.state === 'Connected' && x.control_owner === 'Human');
    if (s) { newSid = s.id; break; }
    await sleep(150);
  }
  log('C0 人类新建会话', newSid);
  await selectTab('本机');
  const btnLabel0 = await txt('[data-testid="delegate-open"]');
  log('C1 首次委托入口措辞', btnLabel0);
  await clickSel('[data-testid="delegate-open"]');
  await sleep(600);
  const C = await page.evaluate(() => {
    const d = document.querySelector('[data-testid="delegate-dlg"]');
    if (!d) return null;
    const facts = [...d.querySelectorAll('.dlg-facts .fact')].map((f) => f.textContent.replace(/\s+/g, ' ').trim());
    const ta = d.querySelector('textarea.goal-input');
    const btns = [...d.querySelectorAll('button')].map((b) => ({ t: b.textContent.trim(), testid: b.getAttribute('data-testid'), disabled: b.disabled }));
    const r = d.getBoundingClientRect();
    return { facts, hasTextarea: !!ta, taPlaceholder: ta?.placeholder ?? null, btns, rect: { cx: r.x + r.width / 2, cy: r.y + r.height / 2, x: r.x, y: r.y, w: r.width, h: r.height } };
  });
  log('C2 对话框事实四项', C ? C.facts : null);
  log('C3 任务目标输入 + 按钮', C ? { ta: C.hasTextarea, btns: C.btns } : null);
  // 层叠：对话框中心命中
  if (C) {
    const hit = await elFromPoint(C.rect.cx, C.rect.cy);
    log('C4 对话框中心 elementFromPoint', hit);
    // 面板右缘点（若面板在下方应命中 mask/dialog）
    const p = await box('.task-panel');
    if (p) { const hit2 = await elFromPoint(p.x + p.w - 12, p.y + 30); log('C5 面板右上区 elementFromPoint', hit2); }
  }
  await shot('vis-r42-05-delegate-dialog-light.png');

  // ---- D. 窄窗完整视图（先开面板再缩窗）----
  await page.evaluate(() => { document.querySelector('[data-testid="delegate-dlg"]') && [...document.querySelectorAll('[data-testid="delegate-dlg"] button')].find((b) => b.textContent.includes('取消'))?.click(); });
  await sleep(400);
  // 确保协作面板开着
  if ((await txt('[data-testid="tp-title"]')) !== '协作') { await openCollab(); }
  await page.setViewportSize({ width: 1024, height: 768 });
  await sleep(900);
  const D1 = await page.evaluate(() => {
    const panel = document.querySelector('.task-panel');
    const cmdEls = [...document.querySelectorAll('.collab-approvals .cmd')].map((e) => {
      const cs = getComputedStyle(e);
      return { text: e.textContent, ws: cs.whiteSpace, to: cs.textOverflow, wb: cs.wordBreak, sw: e.scrollWidth, cw: e.clientWidth, full: e.scrollWidth <= e.clientWidth + 1 };
    });
    const tlEls = [...document.querySelectorAll('.collab-approvals .tl-cmd-text')].map((e) => {
      const cs = getComputedStyle(e);
      return { text: e.textContent, ws: cs.whiteSpace, to: cs.textOverflow, sw: e.scrollWidth, cw: e.clientWidth, full: e.scrollWidth <= e.clientWidth + 1 };
    });
    return { tpFull: !!document.querySelector('.task-panel.tp-full'), panelW: panel?.getBoundingClientRect().width, cmdEls, tlEls };
  });
  log('D1 1024×768 tp-full', D1.tpFull + ' | panelW=' + D1.panelW);
  log('D1b 待审批卡 .cmd 长命令', D1.cmdEls);
  log('D1c 最近处理 .tl-cmd-text', D1.tlEls);
  await shot('vis-r42-06-narrow-1024-light.png');

  await page.setViewportSize({ width: 960, height: 600 });
  await sleep(900);
  const D2 = await page.evaluate(() => {
    const cmdEls = [...document.querySelectorAll('.collab-approvals .cmd')].map((e) => ({ text: e.textContent, ws: getComputedStyle(e).whiteSpace, full: e.scrollWidth <= e.clientWidth + 1 }));
    return { tpFull: !!document.querySelector('.task-panel.tp-full'), panelW: document.querySelector('.task-panel')?.getBoundingClientRect().width, cmdEls };
  });
  log('D2 960×600 tp-full', D2.tpFull + ' | panelW=' + D2.panelW);
  log('D2b .cmd 长命令完整可见', D2.cmdEls);
  await shot('vis-r42-07-narrow-960-light.png');

  // 层叠（tp-full 下对话框是否在最上层）
  await page.evaluate(() => { document.querySelector('[data-testid="tools-collab"]')?.click(); }); // 关面板
  await sleep(300);
  await selectTab('本机');
  await clickSel('[data-testid="delegate-open"]');
  await sleep(500);
  await page.evaluate(() => { document.querySelector('[data-testid="tools-collab"]')?.click(); }); // 重开面板
  await sleep(900);
  const D3 = await page.evaluate(() => {
    const d = document.querySelector('[data-testid="delegate-dlg"]');
    const panel = document.querySelector('.task-panel');
    if (!d) return { dlg: false };
    const r = d.getBoundingClientRect();
    const panelCs = panel ? getComputedStyle(panel) : null;
    return { dlg: true, tpFull: !!document.querySelector('.task-panel.tp-full'), dlgZ: getComputedStyle(d.closest('.confirm-mask')).zIndex, panelZ: panelCs?.zIndex, cx: r.x + r.width / 2, cy: r.y + 20 };
  });
  log('D3 tp-full 下对话框', D3);
  if (D3.dlg) {
    const hit = await elFromPoint(D3.cx, D3.cy);
    log('D3b 对话框顶条 elementFromPoint', hit);
    const p = await box('.task-panel');
    if (p) { const hit2 = await elFromPoint(p.x + p.w - 10, p.y + 40); log('D3c 面板区命中（应为 mask）', hit2); }
  }
  await shot('vis-r42-08-dialog-over-fullview-light.png');
  await page.setViewportSize({ width: 1280, height: 800 });
  await sleep(500);
  await page.evaluate(() => { document.querySelector('[data-testid="delegate-dlg"]') && [...document.querySelectorAll('[data-testid="delegate-dlg"] button')].find((b) => b.textContent.includes('取消'))?.click(); });
  await sleep(400);

  // ---- E. 深色主题 ----
  // 用设置 UI 切到深色
  await page.evaluate(() => document.querySelector('.hb-settings')?.click());
  await sleep(600);
  await page.evaluate(() => { [...document.querySelectorAll('.ts-appearance button')].find((b) => b.textContent.includes('深色'))?.click(); });
  await sleep(600);
  const E0 = await page.evaluate(() => ({ chrome: document.documentElement.getAttribute('data-chrome'), bodyBg: getComputedStyle(document.body).backgroundColor, appearanceBtns: [...document.querySelectorAll('.ts-appearance button')].map((b) => b.textContent + (b.getAttribute('aria-pressed') === 'true' ? '*' : '')) }));
  log('E0 切深色', E0);
  // 关设置
  await page.evaluate(() => { const s = [...document.querySelectorAll('button')].find((b) => b.getAttribute('aria-label') === '关闭设置' || b.textContent.trim() === '关闭'); s?.click(); });
  await page.keyboard.press('Escape');
  await sleep(600);
  // 打开协作面板（若有）
  await selectTab('prod-1');
  await openCollab();
  await sleep(1000);
  const E1 = await page.evaluate(() => {
    const b = document.querySelector('[data-testid="collab-entry"]');
    const cs = b ? getComputedStyle(b) : null;
    const miss = [...document.querySelectorAll('[data-testid="ap-purpose"]')].find((x) => /未提供/.test(x.textContent));
    return { badgeBg: cs?.backgroundColor, badgeColor: cs?.color, missingColor: miss ? getComputedStyle(miss.querySelector('.dim')).color : null };
  });
  log('E1 深色徽标/缺失态配色', E1);
  await shot('vis-r42-09-collab-dark.png');
  const tb2 = await box('.titlebar');
  await shot('vis-r42-10-badge-dark.png', tb2 ? { x: 0, y: tb2.y, width: 460, height: tb2.h } : undefined);

  log('Z 主场景 JS 异常', errs);
  await ctx.close();

  // ============ 新装未启用（?fresh）============
  const ctx2 = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page2 = await ctx2.newPage();
  const errs2 = [];
  page2.on('pageerror', (e) => errs2.push(String(e)));
  await page2.goto(URL + '?fresh', { waitUntil: 'domcontentloaded' });
  await page2.evaluate(() => { try { localStorage.clear(); } catch {} });
  await page2.reload({ waitUntil: 'domcontentloaded' });
  await page2.waitForSelector('.host-card', { timeout: 10000 });
  await sleep(1000);
  const count2 = (s) => page2.evaluate((x) => document.querySelectorAll(x).length, s);
  const txt2 = (s) => page2.evaluate((x) => document.querySelector(x)?.textContent ?? null, s);
  const shot2 = async (n, clip) => { await page2.screenshot({ path: OUT + n, ...(clip ? { clip } : {}) }); console.log('  [shot] ' + n); };
  const G1 = { collabEntry: await count2('[data-testid="collab-entry"]'), badgeText: await txt2('[data-testid="collab-entry"]') };
  log('G1 fresh 无协作徽标', G1);
  await page2.evaluate(() => { [...document.querySelectorAll('.tab')].find((t) => t.textContent.includes('prod-1'))?.click(); });
  await sleep(700);
  const G1b = { toolsCollab: await count2('[data-testid="tools-collab"]'), delegateOpen: await count2('[data-testid="delegate-open"]') };
  log('G1b fresh 工具栏', G1b);
  await page2.evaluate(() => document.querySelector('[data-testid="tools-collab"]')?.click());
  await sleep(700);
  const G2 = {
    unconfigured: await count2('[data-testid="collab-unconfigured"]'),
    apGroup: await count2('[data-testid="ap-group"]'),
    collabApprovals: await count2('.collab-approvals'),
    goalInput: await count2('.goal-input'),
    delegateOpen: await count2('[data-testid="delegate-open"]'),
    title: await txt2('[data-testid="tp-title"]'),
  };
  log('G2 fresh 协作面板', G2);
  await shot2('vis-r42-11-fresh-unconfigured.png');
  await page2.evaluate(() => document.querySelector('[data-testid="collab-open-settings"]')?.click());
  await sleep(800);
  const G3 = { agentEmpty: await count2('[data-testid="agent-empty"]'), agentList: await count2('[data-testid="agent-list"]'), agentEndpoint: await count2('[data-testid="agent-endpoint"]'), cat: await page2.evaluate(() => [...document.querySelectorAll('.settings-cats button, .st-cats button, [role="tab"]')].map((b) => b.textContent.trim())) };
  log('G3 fresh 设置→Agent 接入', G3);
  await shot2('vis-r42-12-fresh-agent-settings.png');
  log('Z2 fresh JS 异常', errs2);
  await ctx2.close();

  await browser.close();
  require('fs').writeFileSync(OUT + 'vis-r42-evidence.json', JSON.stringify(ev, null, 2));
  console.log('\n== done ==');
})().catch((e) => { console.log('PROBE EXCEPTION', e.stack || e); process.exitCode = 1; });
