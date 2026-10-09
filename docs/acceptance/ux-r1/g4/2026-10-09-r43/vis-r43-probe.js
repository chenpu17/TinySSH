// vis-r43 独立视觉复验探针（C9：新装启用、原子停用与旧 Agent 配置迁移）
// 只读渲染 + 截图 + 像素/几何证据；不修改工作树。
// 覆盖：① 新装停用态协作面板 ② 新装停用态设置→Agent 接入 ③ 启用后设置 ④ 停用预览对话框
//       ⑤ 停用后设置；浅/深两主题 + 1024/960 窄窗。
const { chromium } = require('/Users/chenpu/node_modules/playwright');
const fs = require('fs');
const EXE = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const URL = process.env.PROBE_URL || 'http://localhost:5183/';
const OUT = '/Users/chenpu/workspace/claude-code/TinySSH/docs/acceptance/ux-r1/g4/2026-10-09-r43/';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ev = [];
const log = (k, v) => { ev.push({ k, v }); console.log('· ' + k + ' => ' + JSON.stringify(v)); };

// ---------- 页面内通用取证函数（序列化后注入） ----------
const HELPERS = `
window.__vis = {
  box: (s) => { const e = document.querySelector(s); if (!e) return null; const r = e.getBoundingClientRect();
    return { x: +r.x.toFixed(1), y: +r.y.toFixed(1), w: +r.width.toFixed(1), h: +r.height.toFixed(1) }; },
  text: (s) => { const e = document.querySelector(s); return e ? e.textContent.replace(/\\s+/g,' ').trim() : null; },
  count: (s) => document.querySelectorAll(s).length,
  style: (s) => { const e = document.querySelector(s); if (!e) return null; const cs = getComputedStyle(e);
    return { color: cs.color, bg: cs.backgroundColor, fontSize: cs.fontSize, zIndex: cs.zIndex, display: cs.display,
             overflow: cs.overflow, visibility: cs.visibility, opacity: cs.opacity, position: cs.position }; },
  // 有效背景：把祖先链上所有半透明背景按 alpha 自底向上合成（忽略 alpha 会把
  // 同色半透明底误算成 ratio=1 —— 见 vis-r43 首轮 .brief-fact confirmed 假红）
  effBg: (el) => { const layers = []; let n = el;
    while (n) { const bg = getComputedStyle(n).backgroundColor; const m = (bg || '').match(/[\\d.]+/g);
      if (m) { const a = m.length > 3 ? parseFloat(m[3]) : 1; if (a > 0) layers.push({ c: m.slice(0,3).map(Number), a }); }
      n = n.parentElement; }
    let out = [255, 255, 255];
    for (let i = layers.length - 1; i >= 0; i--) { const L = layers[i]; out = out.map((v, k) => L.c[k] * L.a + v * (1 - L.a)); }
    return 'rgb(' + out.map(Math.round).join(',') + ')'; },
  // 文本实际渲染宽度（对 inline 元素也有效，clientWidth 恒 0）
  textW: (s) => { const e = document.querySelector(s); if (!e) return null;
    const r = document.createRange(); r.selectNodeContents(e); const b = r.getBoundingClientRect();
    const cs = getComputedStyle(e);
    return { textW: +b.width.toFixed(1), textH: +b.height.toFixed(1), scrollW: e.scrollWidth, clientW: e.clientWidth,
             ws: cs.whiteSpace, to: cs.textOverflow, overflow: cs.overflowX }; },
  rgb: (s) => { const m = (s||'').match(/[\\d.]+/g); return m ? m.map(Number) : null; },
  lum: (c) => { const f = c.map((v) => { v = v/255; return v <= 0.03928 ? v/12.92 : Math.pow((v+0.055)/1.055, 2.4); });
    return 0.2126*f[0] + 0.7152*f[1] + 0.0722*f[2]; },
  // 对比度：文本色 vs 有效背景
  contrast: (s) => { const e = document.querySelector(s); if (!e) return null;
    const fg = window.__vis.rgb(getComputedStyle(e).color); const bg = window.__vis.rgb(window.__vis.effBg(e));
    if (!fg || !bg) return null; const L1 = window.__vis.lum(fg), L2 = window.__vis.lum(bg);
    const hi = Math.max(L1,L2), lo = Math.min(L1,L2); return +(((hi+0.05)/(lo+0.05)).toFixed(2)); },
  // 截断检测：scrollWidth/Height 超出 clientWidth/Height
  clipped: (s) => { const e = document.querySelector(s); if (!e) return null;
    return { sw: e.scrollWidth, cw: e.clientWidth, sh: e.scrollHeight, ch: e.clientHeight,
             hClip: e.scrollWidth > e.clientWidth + 1, vClip: e.scrollHeight > e.clientHeight + 1 }; },
  // 元素是否完全落在视口内
  inVp: (s) => { const e = document.querySelector(s); if (!e) return null; const r = e.getBoundingClientRect();
    return { fully: r.x >= -0.5 && r.y >= -0.5 && r.right <= innerWidth + 0.5 && r.bottom <= innerHeight + 0.5,
             l: +r.left.toFixed(1), t: +r.top.toFixed(1), r: +r.right.toFixed(1), b: +r.bottom.toFixed(1),
             vw: innerWidth, vh: innerHeight }; },
  // 元素中心是否可被自身命中（未被遮挡）
  hittable: (s) => { const e = document.querySelector(s); if (!e) return null; const r = e.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return { ok: false, why: 'zero-size' };
    const hit = document.elementFromPoint(r.x + r.width/2, r.y + r.height/2);
    return { ok: !!hit && (hit === e || e.contains(hit) || hit.contains(e)),
             hitTag: hit && hit.tagName, hitCls: hit && String(hit.className).slice(0,60),
             hitTestid: hit && hit.getAttribute && hit.getAttribute('data-testid') }; },
  // 两元素包围盒重叠面积（>0 即有交叠）
  overlap: (a, b) => { const ea = document.querySelector(a), eb = document.querySelector(b);
    if (!ea || !eb) return null; const A = ea.getBoundingClientRect(), B = eb.getBoundingClientRect();
    const w = Math.min(A.right, B.right) - Math.max(A.left, B.left);
    const h = Math.min(A.bottom, B.bottom) - Math.max(A.top, B.top);
    return { w: +w.toFixed(1), h: +h.toFixed(1), area: +(Math.max(0,w) * Math.max(0,h)).toFixed(1) }; },
  // 可见按钮按文案分组，返回重复出现的文案（>1 即同屏重复入口）
  dupButtons: (root) => { const r = document.querySelector(root); if (!r) return null;
    const map = {};
    for (const b of r.querySelectorAll('button')) { const cs = getComputedStyle(b); const bx = b.getBoundingClientRect();
      if (cs.display === 'none' || cs.visibility === 'hidden' || bx.width < 1) continue;
      const t = b.textContent.replace(/\\s+/g,' ').trim(); if (!t) continue;
      (map[t] = map[t] || []).push({ testid: b.getAttribute('data-testid'), y: +bx.y.toFixed(1), x: +bx.x.toFixed(1) }); }
    const dups = {}; for (const k in map) if (map[k].length > 1) dups[k] = map[k];
    return { total: r.querySelectorAll('button').length, dups }; },
  // 面板内可见 section 标题清单（判「空壳/多余区块」）
  sections: (root) => { const r = document.querySelector(root); if (!r) return null;
    return [...r.querySelectorAll('.section')].map((s) => { const h = s.querySelector('h4');
      const bx = s.getBoundingClientRect(); return { h: h ? h.textContent.trim() : null, text: s.textContent.replace(/\\s+/g,' ').trim().slice(0, 90),
        h_: +bx.height.toFixed(1), textarea: s.querySelectorAll('textarea').length, btn: s.querySelectorAll('button').length }; }); },
  // 同级可见子元素两两重叠扫描
  scanOverlap: (root) => { const r = document.querySelector(root); if (!r) return null;    const kids = [...r.children].filter((c) => { const cs = getComputedStyle(c); const b = c.getBoundingClientRect();
      return cs.display !== 'none' && cs.visibility !== 'hidden' && +cs.opacity > 0 && b.width > 0 && b.height > 0; });
    const out = [];
    for (let i = 0; i < kids.length; i++) for (let j = i+1; j < kids.length; j++) {
      const A = kids[i].getBoundingClientRect(), B = kids[j].getBoundingClientRect();
      const w = Math.min(A.right,B.right) - Math.max(A.left,B.left), h = Math.min(A.bottom,B.bottom) - Math.max(A.top,B.top);
      if (w > 1 && h > 1) out.push({ a: kids[i].className || kids[i].tagName, b: kids[j].className || kids[j].tagName,
        area: +(w*h).toFixed(1) }); }
    return out; },
  // 元素内所有可见文本节点的最小对比度
  minContrast: (root) => { const r = document.querySelector(root); if (!r) return null;
    let worst = { ratio: 99, text: '' };
    const walk = (n) => { for (const c of n.childNodes) {
      if (c.nodeType === 3) { const t = (c.textContent||'').trim(); if (t.length > 1 && c.parentElement) {
        const cs = getComputedStyle(c.parentElement); if (cs.visibility === 'hidden' || +cs.opacity === 0) continue;
        const fg = window.__vis.rgb(cs.color), bg = window.__vis.rgb(window.__vis.effBg(c.parentElement));
        if (fg && bg) { const L1 = window.__vis.lum(fg), L2 = window.__vis.lum(bg);
          const ratio = +(((Math.max(L1,L2)+0.05)/(Math.min(L1,L2)+0.05)).toFixed(2));
          if (ratio < worst.ratio) worst = { ratio, text: t.slice(0,40) }; } } }
      else if (c.nodeType === 1) walk(c); } };
    walk(r); return worst; },
};
`;

(async () => {
  const browser = await chromium.launch({ executablePath: EXE, headless: true });

  // ============================================================
  // 通用：跑一遍完整生命周期，按阶段截图 + 取证
  // ============================================================
  async function runLifecycle(page, tag, shots, opts = {}) {
    const count = (s) => page.evaluate((x) => document.querySelectorAll(x).length, s);
    const txt = (s) => page.evaluate((x) => document.querySelector(x)?.textContent?.replace(/\s+/g, ' ').trim() ?? null, s);
    const H = (fn, ...args) => page.evaluate(({ f, a }) => window.__vis[f](...a), { f: fn, a: args });
    const inv = (cmd, args) => page.evaluate(async ({ c, a }) => {
      const { invoke } = await import('/src/adapter/bridge.ts'); return invoke(c, a);
    }, { c: cmd, a: args });
    const clickSel = async (s, t = 3000) => { try { await page.click(s, { timeout: t }); return true; } catch { return false; } };
    const shot = async (name, clip) => { await page.screenshot({ path: OUT + name, ...(clip ? { clip } : {}) }); console.log('  [shot] ' + name); };

    const openCollab = async () => {
      if ((await txt('[data-testid="tp-title"]')) === '协作') return true;
      await clickSel('[data-testid="tools-collab"]'); await sleep(700);
      return (await txt('[data-testid="tp-title"]')) === '协作';
    };
    const openAgentSettings = async () => {
      if (await count('[data-testid="settings-cat-agent"]')) return true;
      await clickSel('[data-testid="collab-open-settings"]'); await sleep(500);
      if (!(await count('[data-testid="settings-cat-agent"]'))) {
        await clickSel('.hb-settings'); await sleep(400);
        await clickSel('[data-testid="settings-cat-agent"]');
      }
      await sleep(600);
      return (await count('[data-testid="settings-cat-agent"]')) > 0;
    };
    const connectHost = async (needle) => {
      await page.evaluate((n) => {
        const card = [...document.querySelectorAll('.host-card')].find((c) => c.querySelector('.host-name')?.textContent.includes(n));
        card?.querySelector('.host-connect-btn')?.click();
      }, needle);
      await page.waitForSelector('.hk-mask', { timeout: 4000 }).catch(() => {});
      await page.evaluate(() => { [...document.querySelectorAll('.hk-mask button')].find((x) => x.textContent.includes('信任并连接'))?.click(); });
      for (let i = 0; i < 60; i++) {
        const s = (await inv('list_sessions')).find((x) => x.host_name.includes(needle) && x.state === 'Connected');
        if (s) return s.id; await sleep(150);
      }
      return null;
    };

    // 切主题（通过设置 UI）
    if (opts.dark) {
      await clickSel('.hb-settings'); await sleep(500);
      await page.evaluate(() => { [...document.querySelectorAll('.ts-appearance button')].find((b) => b.textContent.includes('深色'))?.click(); });
      await sleep(500);
      await clickSel('[data-testid="settings-close"]'); await sleep(400);
      log(tag + ' 主题', await page.evaluate(() => document.documentElement.dataset.chrome));
    }

    const sid = await connectHost('prod-1');
    log(tag + ' 会话', sid);
    await sleep(400);

    // ---------- ① 新装停用态 · 协作面板 ----------
    await openCollab();
    const s1 = await page.evaluate(() => ({
      disabled: window.__vis.count('[data-testid="collab-disabled"]'),
      disabledText: window.__vis.text('[data-testid="collab-disabled"]'),
      apGroup: window.__vis.count('[data-testid="ap-group"]'),
      approvalsC: window.__vis.count('.collab-approvals'),
      goalInput: window.__vis.count('.goal-input'),
      delegateOpen: window.__vis.count('[data-testid="delegate-open"]'),
      collabEntry: window.__vis.count('[data-testid="collab-entry"]'),
      panelBox: window.__vis.box('.task-panel'),
      emptyBox: window.__vis.box('[data-testid="collab-disabled"]'),
      openSettingsBtn: window.__vis.count('[data-testid="collab-open-settings"]'),
      openSettingsBox: window.__vis.box('[data-testid="collab-open-settings"]'),
      openSettingsHit: window.__vis.hittable('[data-testid="collab-open-settings"]'),
      panelMinContrast: window.__vis.minContrast('.task-panel'),
      panelOverlaps: window.__vis.scanOverlap('.tp-scroll'),
      panelClip: window.__vis.clipped('.task-panel'),
      panelSections: window.__vis.sections('.tp-scroll'),
      panelDupBtns: window.__vis.dupButtons('.tp-scroll'),
      goalTextarea: window.__vis.count('.task-panel textarea'),
      emptyTextW: window.__vis.textW('[data-testid="collab-disabled"]'),
    }));
    log(tag + '-1 停用态协作面板', s1);
    await shot(shots.s1);

    // ---------- ② 新装停用态 · 设置 → Agent 接入 ----------
    await openAgentSettings();
    const s2 = await page.evaluate(() => ({
      pane: window.__vis.count('[data-testid="settings-pane-agent"]'),
      catOn: (() => { const b = document.querySelector('[data-testid="settings-cat-agent"]'); return b ? { sel: b.getAttribute('aria-selected'), cls: b.className } : null; })(),
      disabledNote: window.__vis.count('[data-testid="collab-disabled-note"]'),
      noteText: window.__vis.text('[data-testid="collab-disabled-note"]'),
      endpoint: window.__vis.count('[data-testid="agent-endpoint"]'),
      disableBtn: window.__vis.count('[data-testid="collab-disable-btn"]'),
      enableBtn: window.__vis.count('[data-testid="collab-enable-btn"]'),
      enableBtnText: window.__vis.text('[data-testid="collab-enable-btn"]'),
      keptAgents: window.__vis.count('[data-testid="collab-kept-agents"]'),
      agentList: window.__vis.count('[data-testid="agent-list"]'),
      agentEmpty: window.__vis.count('[data-testid="agent-empty"]'),
      stateChip: window.__vis.text('[data-testid="collab-state"]'),
      stateChipStyle: window.__vis.style('[data-testid="collab-state"]'),
      stateChipContrast: window.__vis.contrast('[data-testid="collab-state"]'),
      configured: window.__vis.text('[data-testid="collab-configured"]'),
      active: window.__vis.text('[data-testid="collab-active"]'),
      panelBox: window.__vis.box('.term-settings.settings-wide'),
      paneClip: window.__vis.clipped('.settings-pane'),
      enableHit: window.__vis.hittable('[data-testid="collab-enable-btn"]'),
      paneMinContrast: window.__vis.minContrast('[data-testid="settings-pane-agent"]'),
      paneOverlaps: window.__vis.scanOverlap('[data-testid="settings-pane-agent"]'),
      paneDupBtns: window.__vis.dupButtons('[data-testid="settings-pane-agent"]'),
      inVp: window.__vis.inVp('.term-settings.settings-wide'),
    }));
    log(tag + '-2 停用态设置', s2);
    await shot(shots.s2);

    // ---------- ③ 启用后 · 设置 → Agent 接入 ----------
    await clickSel('[data-testid="collab-enable-btn"]');
    await sleep(900);
    const s3 = await page.evaluate(() => ({
      stateChip: window.__vis.text('[data-testid="collab-state"]'),
      stateChipStyle: window.__vis.style('[data-testid="collab-state"]'),
      stateChipContrast: window.__vis.contrast('[data-testid="collab-state"]'),
      endpoint: window.__vis.count('[data-testid="agent-endpoint"]'),
      endpointText: window.__vis.text('[data-testid="agent-endpoint"]'),
      endpointBox: window.__vis.box('[data-testid="agent-endpoint"]'),
      endpointTextW: window.__vis.textW('[data-testid="agent-endpoint"]'),
      configured: window.__vis.text('[data-testid="collab-configured"]'),
      configuredBox: window.__vis.box('[data-testid="collab-configured"]'),
      active: window.__vis.text('[data-testid="collab-active"]'),
      activeBox: window.__vis.box('[data-testid="collab-active"]'),
      cfgVsActOverlap: window.__vis.overlap('[data-testid="collab-configured"]', '[data-testid="collab-active"]'),
      disableBtn: window.__vis.count('[data-testid="collab-disable-btn"]'),
      disableBtnText: window.__vis.text('[data-testid="collab-disable-btn"]'),
      disableBtnBox: window.__vis.box('[data-testid="collab-disable-btn"]'),
      disableBtnHit: window.__vis.hittable('[data-testid="collab-disable-btn"]'),
      enableBtn: window.__vis.count('[data-testid="collab-enable-btn"]'),
      agentEmpty: window.__vis.count('[data-testid="agent-empty"]'),
      paneClip: window.__vis.clipped('.settings-pane'),
      paneMinContrast: window.__vis.minContrast('[data-testid="settings-pane-agent"]'),
      paneOverlaps: window.__vis.scanOverlap('[data-testid="settings-pane-agent"]'),
    }));
    log(tag + '-3 启用后设置', s3);
    await shot(shots.s3);

    // ---------- ④ 停用预览对话框 ----------
    // 制造非零事实：签发 1 个 Agent + 委托 1 台会话 + 注入 1 条待审批
    await inv('issue_agent', { id: 'vis-r43-agent', label: 'R43 视觉复验 Agent' });
    const sid2 = await connectHost('staging-1');
    await inv('demo_inject_approval', { sid: sid2, command: 'systemctl restart nginx --now --no-block --preserve-env', target_summary: '服务管理' }).catch(() => null);
    await inv('delegate_session', { sid, goal: '视觉复验：打包日志到 /tmp' });
    await sleep(600);
    await clickSel('[data-testid="settings-close"]'); await sleep(400);
    await openAgentSettings(); await sleep(700);
    const before = await page.evaluate(() => ({ cfg: window.__vis.text('[data-testid="collab-configured"]'), act: window.__vis.text('[data-testid="collab-active"]') }));
    log(tag + '-4 前置计数', before);
    await clickSel('[data-testid="collab-disable-btn"]');
    await sleep(800);
    const s4 = await page.evaluate(() => {
      const d = document.querySelector('[data-testid="collab-disable-dlg"]');
      if (!d) return { dlg: false };
      const btns = [...d.querySelectorAll('button')].map((b) => ({ t: b.textContent.trim(), testid: b.getAttribute('data-testid'),
        box: (() => { const r = b.getBoundingClientRect(); return { x:+r.x.toFixed(1), y:+r.y.toFixed(1), w:+r.width.toFixed(1), h:+r.height.toFixed(1) }; })(),
        hit: (() => { const r = b.getBoundingClientRect(); const h = document.elementFromPoint(r.x+r.width/2, r.y+r.height/2);
          return !!h && (h === b || b.contains(h) || h.contains(b)); })() }));
      const facts = [...d.querySelectorAll('.dlg-facts .fact')].map((f) => f.textContent.replace(/\s+/g,' ').trim());
      return { dlg: true, title: window.__vis.text('.hk-title'), facts, btns,
        dlgText: d.textContent.replace(/\s+/g,' ').trim(),
        hasTokenKeep: /Token\s*保留|身份与 Token 保留/.test(d.textContent),
        impactSessions: window.__vis.text('[data-testid="collab-impact-sessions"]'),
        impactApprovals: window.__vis.text('[data-testid="collab-impact-approvals"]'),
        impactAgents: window.__vis.text('[data-testid="collab-impact-agents"]'),
        dlgBox: window.__vis.box('[data-testid="collab-disable-dlg"]'),
        dlgInVp: window.__vis.inVp('[data-testid="collab-disable-dlg"]'),
        dlgClip: window.__vis.clipped('[data-testid="collab-disable-dlg"]'),
        dlgMinContrast: window.__vis.minContrast('[data-testid="collab-disable-dlg"]'),
        dlgOverlaps: window.__vis.scanOverlap('[data-testid="collab-disable-dlg"]'),
        maskZ: window.__vis.style('.confirm-mask'),
        settingsZ: window.__vis.style('.term-settings.settings-wide'),
        centerHit: (() => { const r = d.getBoundingClientRect(); const h = document.elementFromPoint(r.x+r.width/2, r.y+r.height/2);
          return { tag: h && h.tagName, testid: h && h.getAttribute && h.getAttribute('data-testid') }; })(),
      };
    });
    log(tag + '-4 停用预览对话框', s4);
    await shot(shots.s4);

    // ---------- ⑤ 停用后 · 设置 ----------
    await clickSel('[data-testid="collab-disable-confirm"]');
    await sleep(1100);
    const s5 = await page.evaluate(() => ({
      stateChip: window.__vis.text('[data-testid="collab-state"]'),
      stateChipStyle: window.__vis.style('[data-testid="collab-state"]'),
      stateChipContrast: window.__vis.contrast('[data-testid="collab-state"]'),
      endpoint: window.__vis.count('[data-testid="agent-endpoint"]'),
      keptAgents: window.__vis.count('[data-testid="collab-kept-agents"]'),
      keptText: window.__vis.text('[data-testid="collab-kept-agents"]'),
      keptBox: window.__vis.box('[data-testid="collab-kept-agents"]'),
      keptInVp: window.__vis.inVp('[data-testid="collab-kept-agents"]'),
      keptMinContrast: window.__vis.minContrast('[data-testid="collab-kept-agents"]'),
      noteText: window.__vis.text('[data-testid="collab-disabled-note"]'),
      disableBtn: window.__vis.count('[data-testid="collab-disable-btn"]'),
      enableBtn: window.__vis.count('[data-testid="collab-enable-btn"]'),
      configured: window.__vis.text('[data-testid="collab-configured"]'),
      active: window.__vis.text('[data-testid="collab-active"]'),
      paneClip: window.__vis.clipped('.settings-pane'),
      paneMinContrast: window.__vis.minContrast('[data-testid="settings-pane-agent"]'),
      paneOverlaps: window.__vis.scanOverlap('[data-testid="settings-pane-agent"]'),
      collabState: null,
    }));
    log(tag + '-5 停用后设置', s5);
    await shot(shots.s5);

    return { s1, s2, s3, s4, s5 };
  }

  // ============ 主场景：浅色 1280×800 ============
  {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await ctx.newPage();
    const errs = [];
    page.on('pageerror', (e) => errs.push(String(e)));
    await page.goto(URL + '?fresh', { waitUntil: 'domcontentloaded' });
    await page.evaluate(() => { try { localStorage.clear(); } catch {} });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.addInitScript(HELPERS);
    await page.evaluate(HELPERS);
    await page.waitForSelector('.host-card', { timeout: 10000 });
    await sleep(1000);
    log('L 主题', await page.evaluate(() => document.documentElement.dataset.chrome));
    await runLifecycle(page, 'L', {
      s1: 'vis-r43-01-collab-disabled-fresh-light.png',
      s2: 'vis-r43-02-settings-disabled-fresh-light.png',
      s3: 'vis-r43-03-settings-enabled-light.png',
      s4: 'vis-r43-04-disable-dlg-light.png',
      s5: 'vis-r43-05-settings-disabled-kept-light.png',
    }, { dark: false });
    log('L JS 异常', errs);
    await ctx.close();
  }

  // ============ 深色 1280×800 ============
  {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await ctx.newPage();
    const errs = [];
    page.on('pageerror', (e) => errs.push(String(e)));
    await page.goto(URL + '?fresh', { waitUntil: 'domcontentloaded' });
    await page.evaluate(() => { try { localStorage.clear(); } catch {} });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.evaluate(HELPERS);
    await page.waitForSelector('.host-card', { timeout: 10000 });
    await sleep(1000);
    await runLifecycle(page, 'D', {
      s1: 'vis-r43-06-collab-disabled-fresh-dark.png',
      s2: 'vis-r43-07-settings-disabled-fresh-dark.png',
      s3: 'vis-r43-08-settings-enabled-dark.png',
      s4: 'vis-r43-09-disable-dlg-dark.png',
      s5: 'vis-r43-10-settings-disabled-kept-dark.png',
    }, { dark: true });
    log('D JS 异常', errs);
    await ctx.close();
  }

  // ============ 窄窗（浅色）1024 / 960 ============
  for (const vp of [{ w: 1024, h: 768, n: '1024' }, { w: 960, h: 600, n: '960' }]) {
    const ctx = await browser.newContext({ viewport: { width: vp.w, height: vp.h } });
    const page = await ctx.newPage();
    const errs = [];
    page.on('pageerror', (e) => errs.push(String(e)));
    await page.goto(URL + '?fresh', { waitUntil: 'domcontentloaded' });
    await page.evaluate(() => { try { localStorage.clear(); } catch {} });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.evaluate(HELPERS);
    await page.waitForSelector('.host-card', { timeout: 10000 });
    await sleep(1000);
    const H = (fn, ...args) => page.evaluate(({ f, a }) => window.__vis[f](...a), { f: fn, a: args });
    const inv = (cmd, args) => page.evaluate(async ({ c, a }) => {
      const { invoke } = await import('/src/adapter/bridge.ts'); return invoke(c, a);
    }, { c: cmd, a: args });
    const clickSel = async (s, t = 3000) => { try { await page.click(s, { timeout: t }); return true; } catch { return false; } };
    const shot = async (name) => { await page.screenshot({ path: OUT + name }); console.log('  [shot] ' + name); };
    const txt = (s) => page.evaluate((x) => document.querySelector(x)?.textContent?.replace(/\s+/g,' ').trim() ?? null, s);

    // 连主机
    await page.evaluate(() => {
      const card = [...document.querySelectorAll('.host-card')].find((c) => c.querySelector('.host-name')?.textContent.includes('prod-1'));
      card?.querySelector('.host-connect-btn')?.click();
    });
    await page.waitForSelector('.hk-mask', { timeout: 4000 }).catch(() => {});
    await page.evaluate(() => { [...document.querySelectorAll('.hk-mask button')].find((x) => x.textContent.includes('信任并连接'))?.click(); });
    let sid = null;
    for (let i = 0; i < 60; i++) { const s = (await inv('list_sessions')).find((x) => x.host_name.includes('prod-1') && x.state === 'Connected'); if (s) { sid = s.id; break; } await sleep(150); }
    await sleep(500);

    // ---- ② 停用态设置面板（窄窗）----
    await page.evaluate(() => document.querySelector('[data-testid="tools-collab"]')?.click());
    await sleep(700);
    await clickSel('[data-testid="collab-open-settings"]'); await sleep(800);
    const n2 = await page.evaluate(() => ({
      cat: window.__vis.count('[data-testid="settings-cat-agent"]'),
      paneBox: window.__vis.box('[data-testid="settings-pane-agent"]'),
      panelBox: window.__vis.box('.term-settings.settings-wide'),
      panelInVp: window.__vis.inVp('.term-settings.settings-wide'),
      noteClip: window.__vis.clipped('[data-testid="collab-disabled-note"]'),
      noteBox: window.__vis.box('[data-testid="collab-disabled-note"]'),
      enableBox: window.__vis.box('[data-testid="collab-enable-btn"]'),
      enableHit: window.__vis.hittable('[data-testid="collab-enable-btn"]'),
      paneClip: window.__vis.clipped('.settings-pane'),
      paneMinContrast: window.__vis.minContrast('[data-testid="settings-pane-agent"]'),
      paneOverlaps: window.__vis.scanOverlap('[data-testid="settings-pane-agent"]'),
      navBox: window.__vis.box('.settings-nav'),
      navVsPane: window.__vis.overlap('.settings-nav', '[data-testid="settings-pane-agent"]'),
    }));
    log('N' + vp.n + '-2 停用态设置', n2);
    await shot(`vis-r43-11-settings-disabled-narrow-${vp.n}-light.png`);

    // ---- ④ 停用预览对话框（窄窗）----
    await clickSel('[data-testid="collab-enable-btn"]'); await sleep(900);
    await inv('issue_agent', { id: 'vis-r43-agent', label: 'R43 视觉复验 Agent' });
    await inv('demo_inject_approval', { sid, command: 'systemctl restart nginx --now --no-block --preserve-env', target_summary: '服务管理' }).catch(() => null);
    await inv('delegate_session', { sid, goal: '视觉复验：打包日志到 /tmp' });
    await sleep(700);
    await clickSel('[data-testid="collab-disable-btn"]'); await sleep(900);
    const n4 = await page.evaluate(() => {
      const d = document.querySelector('[data-testid="collab-disable-dlg"]');
      if (!d) return { dlg: false };
      const btns = [...d.querySelectorAll('button')].map((b) => { const r = b.getBoundingClientRect();
        const h = document.elementFromPoint(r.x+r.width/2, r.y+r.height/2);
        return { t: b.textContent.trim(), testid: b.getAttribute('data-testid'), x:+r.x.toFixed(1), y:+r.y.toFixed(1), w:+r.width.toFixed(1), h:+r.height.toFixed(1),
                 hit: !!h && (h === b || b.contains(h) || h.contains(b)) }; });
      return { dlg: true, facts: [...d.querySelectorAll('.dlg-facts .fact')].map((f) => f.textContent.replace(/\s+/g,' ').trim()),
        btns, hasTokenKeep: /Token\s*保留/.test(d.textContent),
        dlgBox: window.__vis.box('[data-testid="collab-disable-dlg"]'),
        dlgInVp: window.__vis.inVp('[data-testid="collab-disable-dlg"]'),
        dlgClip: window.__vis.clipped('[data-testid="collab-disable-dlg"]'),
        dlgMinContrast: window.__vis.minContrast('[data-testid="collab-disable-dlg"]'),
        dlgOverlaps: window.__vis.scanOverlap('[data-testid="collab-disable-dlg"]') };
    });
    log('N' + vp.n + '-4 停用预览对话框', n4);
    await shot(`vis-r43-12-disable-dlg-narrow-${vp.n}-light.png`);
    log('N' + vp.n + ' JS 异常', errs);
    await ctx.close();
  }

  await browser.close();
  fs.writeFileSync(OUT + 'vis-r43-evidence.json', JSON.stringify(ev, null, 2));
  console.log('\n== done ==');
})().catch((e) => { console.log('PROBE EXCEPTION', e.stack || e); process.exitCode = 1; });
