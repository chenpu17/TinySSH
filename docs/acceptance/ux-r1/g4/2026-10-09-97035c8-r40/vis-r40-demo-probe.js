// vis-r40 独立视觉复验探针（端口转发表单/列表/生命周期 §6.6）
// 独立编写：不复用作者探针断言。聚焦视觉面——对比度(WCAG AA, 双主题)、盒测量/布局、
// 键盘可达+焦点可见、状态实捕、节外回归、零 JS 报错。
// 域：demo（浏览器，无 Tauri）。只读产品代码，不改 ui/src 或任何 Rust 文件。
const { chromium } = require('/Users/chenpu/node_modules/playwright');
const fs = require('fs');
const path = require('path');
const EXE = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const URL = process.env.PROBE_URL || 'http://localhost:5183/';
const OUT = process.env.VIS_OUT || __dirname;

const results = [];
const log = (s) => console.log(s);
const ok = (name, cond, detail = '') => { results.push({ name, pass: !!cond, detail }); log((cond ? 'PASS ' : 'FAIL ') + name + (detail ? '  [' + detail + ']' : '')); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const contrasts = [];
const boxes = [];

// ---- 页内工具：对比度测量（含祖先背景 alpha 合成）+ 盒测量 + 焦点样式 ----
const PAGE_HELPERS = `
window.__vis = {
  parse(s){ const m=String(s).match(/rgba?\\(([^)]+)\\)/); if(!m) return null; const p=m[1].split(',').map(Number); return {r:p[0],g:p[1],b:p[2],a:p[3]===undefined?1:p[3]}; },
  lum(c){ const f=(v)=>{ v/=255; return v<=0.03928? v/12.92 : Math.pow((v+0.055)/1.055,2.4); }; return 0.2126*f(c.r)+0.7152*f(c.g)+0.0722*f(c.b); },
  ratio(fg,bg){ const L1=Math.max(this.lum(fg),this.lum(bg)), L2=Math.min(this.lum(fg),this.lum(bg)); return (L1+0.05)/(L2+0.05); },
  effBg(el){ let chain=[], n=el; while(n){ chain.push(getComputedStyle(n).backgroundColor); n=n.parentElement; } let acc={r:255,g:255,b:255}; for(let i=chain.length-1;i>=0;i--){ const c=this.parse(chain[i]); if(!c) continue; acc={r:c.r*c.a+acc.r*(1-c.a), g:c.g*c.a+acc.g*(1-c.a), b:c.b*c.a+acc.b*(1-c.a)}; } return acc; },
  measure(sel){ const el=document.querySelector(sel); if(!el) return {sel, missing:true};
    const cs=getComputedStyle(el); const fg0=this.parse(cs.color); const bg=this.effBg(el);
    let fg={...fg0}; if(fg.a<1){ fg={ r:fg0.r*fg0.a+bg.r*(1-fg0.a), g:fg0.g*fg0.a+bg.g*(1-fg0.a), b:fg0.b*fg0.a+bg.b*(1-fg0.a) }; }
    const fs=parseFloat(cs.fontSize); const fw=cs.fontWeight; const wnum=parseInt(fw,10)||400;
    const large = fs>=24 || (fs>=18.66 && wnum>=700);
    const ratio=this.ratio(fg,bg); const thr=large?3.0:4.5;
    const bgStr='rgb('+Math.round(bg.r)+', '+Math.round(bg.g)+', '+Math.round(bg.b)+')';
    return { sel, color:cs.color, bg:bgStr, fontSize:fs, weight:fw, large, ratio:Math.round(ratio*100)/100, threshold:thr, pass: ratio+1e-9>=thr, text:(el.textContent||'').trim().slice(0,30) };
  }
};
true;
`;

(async () => {
  const browser = await chromium.launch({ executablePath: EXE, headless: true });
  const summary = {};

  for (const theme of ['dark', 'light']) {
    log('\n================ THEME: ' + theme + ' ================');
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, colorScheme: theme });
    const page = await ctx.newPage();
    const jsErrors = [];
    page.on('pageerror', (e) => jsErrors.push(String(e)));
    page.on('console', (m) => { if (m.type() === 'error') jsErrors.push('console.error: ' + m.text()); });
    await page.goto(URL, { waitUntil: 'domcontentloaded' });
    await page.evaluate(() => { try { localStorage.clear(); } catch {} });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.addInitScript(PAGE_HELPERS);
    await page.evaluate(PAGE_HELPERS);
    await page.waitForSelector('.host-card', { timeout: 15000 });
    await sleep(500);

    const chrome = await page.evaluate(() => document.documentElement.dataset.chrome);
    ok(`[${theme}] data-chrome resolves to ${theme}`, chrome === theme, 'got=' + chrome);

    const demoInvoke = (cmd, args) => page.evaluate(async ({ c, a }) => {
      const { invoke } = await import('/src/adapter/bridge.ts');
      return invoke(c, a);
    }, { c: cmd, a: args });
    const waitFor_ = async (fn, tries, gap = 150) => { for (let i = 0; i < tries; i++) { const v = await fn(); if (v) return v; await sleep(gap); } return null; };

    // 连接 prod-1（demo 种子信任，不弹指纹窗）
    await page.evaluate(() => {
      const card = [...document.querySelectorAll('.host-card')].find((c) => c.querySelector('.host-name')?.textContent.includes('prod-1'));
      card?.querySelector('.host-connect-btn')?.click();
    });
    await page.waitForSelector('.hk-mask', { timeout: 3000 }).catch(() => {});
    await page.evaluate(() => { [...document.querySelectorAll('.hk-mask button')].find((x) => x.textContent.includes('信任并连接'))?.click(); });
    const sidNew = await waitFor_(async () => {
      const l = await demoInvoke('list_sessions').catch(() => []);
      const mine = l.filter((x) => x.host_name.includes('prod-1') && x.state === 'Connected');
      return mine.sort((a, b) => (a.created_at < b.created_at ? 1 : -1))[0]?.id ?? null;
    }, 40);
    ok(`[${theme}] session connected`, !!sidNew, String(sidNew));

    // 打开 工具 → 端口转发
    const openForwards = async () => {
      await page.evaluate(() => { [...document.querySelectorAll('.st-tools button')].find((b) => b.textContent.includes('工具'))?.click(); });
      await sleep(180);
      await page.evaluate(() => { [...document.querySelectorAll('.tools-menu button')].find((b) => b.textContent.includes('端口转发'))?.click(); });
      return waitFor_(async () => page.evaluate(() => !!document.querySelector('.fwd-form')), 30);
    };
    const opened = await openForwards();
    ok(`[${theme}] forwards panel opens`, !!opened);

    const setVal = (idx, value) => page.evaluate(({ idx, value }) => {
      const ins = [...document.querySelectorAll('.fwd-form input.mono')];
      if (!ins[idx]) return;
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(ins[idx], value); ins[idx].dispatchEvent(new Event('input', { bubbles: true }));
    }, { idx, value });
    const setAddr = (value) => page.evaluate((value) => {
      const el = document.querySelector('.fwd-form input.mono');
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(el, value); el.dispatchEvent(new Event('input', { bubbles: true }));
    }, value);
    const setKind = (value) => page.evaluate((value) => {
      const el = document.querySelector('.fwd-form select');
      const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set;
      setter.call(el, value); el.dispatchEvent(new Event('change', { bubbles: true }));
    }, value);
    const startBtn = () => page.evaluate(() => { [...document.querySelectorAll('.section button')].find((b) => b.textContent.trim() === '启动转发')?.click(); });
    const panelShot = (name) => page.locator('.task-panel').screenshot({ path: path.join(OUT, `vis-r40-${theme}-${name}.png`) }).catch(() => {});
    const measure = (sel) => page.evaluate((s) => window.__vis.measure(s), sel);

    // ---------- (a) 默认表单 ----------
    const defaultLabels = await page.$$eval('.fwd-form label', (ls) => ls.map((l) => l.textContent));
    ok(`[${theme}] default form labels present`, defaultLabels.some((t) => t.includes('监听地址')), JSON.stringify(defaultLabels));
    const defAddr = await page.$eval('.fwd-form input.mono', (i) => i.value).catch(() => null);
    ok(`[${theme}] default listen addr = 127.0.0.1`, defAddr === '127.0.0.1', String(defAddr));
    await panelShot('a-default-form');

    // ---------- 对比度：默认可见元素（真实上下文） ----------
    const defSels = ['.section h4', '.fwd-form select', '.fwd-form input.mono', '.ah-field label', '.side-quiet', '.section button'];
    for (const s of defSels) { const m = await measure(s); if (!m.missing) contrasts.push({ theme, state: 'default', ...m }); }

    // ---------- 对比度：注入测量桩（warn/err 变体在真实 .card/--panel 上下文） ----------
    await page.evaluate(() => {
      const sec = document.querySelector('.section');
      const d = document.createElement('div'); d.id = '__vis_probe'; d.className = 'card';
      d.innerHTML = '<div class="row" style="align-items:center">' +
        '<span class="fwd-kind local">-L</span><span class="fwd-kind remote">-R</span><span class="fwd-kind dynamic">-D</span>' +
        '<span class="fwd-state listen">监听中</span><span class="fwd-state warn">降级</span><span class="fwd-state err">失败</span></div>' +
        '<div class="mono xfer-sub">健康行</div><div class="mono xfer-sub warn">健康行warn</div><div class="mono xfer-sub err">健康行err</div>' +
        '<div class="fwd-err">⚠ 错误行</div>' +
        '<div class="fwd-expose"><input type="checkbox"><span>我确认暴露范围</span></div>' +
        '<div class="side-quiet">说明行</div>';
      sec.appendChild(d);
    });
    const harnessSels = ['#__vis_probe .fwd-kind.local', '#__vis_probe .fwd-kind.remote', '#__vis_probe .fwd-kind.dynamic',
      '#__vis_probe .fwd-state.listen', '#__vis_probe .fwd-state.warn', '#__vis_probe .fwd-state.err',
      '#__vis_probe .xfer-sub', '#__vis_probe .xfer-sub.warn', '#__vis_probe .xfer-sub.err',
      '#__vis_probe .fwd-err', '#__vis_probe .fwd-expose span', '#__vis_probe .side-quiet'];
    for (const s of harnessSels) { const m = await measure(s); if (!m.missing) contrasts.push({ theme, state: 'harness', ...m }); }
    await page.evaluate(() => { document.getElementById('__vis_probe')?.remove(); });

    // ---------- (b) 空监听端口字段错误 ----------
    await setAddr('127.0.0.1'); await setVal(1, '');
    await startBtn(); await sleep(200);
    const errListen = await page.$eval('[data-testid="fwd-err-listen"]', (e) => e.textContent).catch(() => null);
    ok(`[${theme}] (b) empty listen port → field error`, !!errListen && errListen.includes('监听端口'), String(errListen));
    if (errListen) { const m = await measure('[data-testid="fwd-err-listen"]'); contrasts.push({ theme, state: 'err-listen', ...m }); }
    await panelShot('b-err-listen');

    // 空目标字段错误
    await setVal(1, '8080'); await startBtn(); await sleep(200);
    const errTarget = await page.$eval('[data-testid="fwd-err-target"]', (e) => e.textContent).catch(() => null);
    ok(`[${theme}] (b2) empty target → field error`, !!errTarget && errTarget.includes('目标主机'), String(errTarget));
    if (errTarget) { const m = await measure('[data-testid="fwd-err-target"]'); contrasts.push({ theme, state: 'err-target', ...m }); }
    await panelShot('b2-err-target');

    // ---------- (c) 非回环暴露确认行 ----------
    await setAddr('0.0.0.0'); await sleep(200);
    const exposeVisible = await page.evaluate(() => !!document.querySelector('[data-testid="fwd-expose"]'));
    ok(`[${theme}] (c) non-loopback shows exposure notice`, exposeVisible);
    const exposeTxt = await page.$eval('[data-testid="fwd-expose"]', (e) => e.textContent).catch(() => null);
    ok(`[${theme}] (c2) exposure text mentions 暴露范围`, !!exposeTxt && exposeTxt.includes('暴露范围'), (exposeTxt || '').slice(0, 60));
    if (exposeVisible) { const m = await measure('[data-testid="fwd-expose"] span'); contrasts.push({ theme, state: 'expose', ...m }); }
    await panelShot('c-expose-unchecked');
    // 未勾选时启动被拦
    await startBtn(); await sleep(200);
    const eExpose = await page.$eval('[data-testid="fwd-err-listen"]', (e) => e.textContent).catch(() => null);
    ok(`[${theme}] (c3) start blocked until exposure ack`, !!eExpose && eExpose.includes('暴露范围'), String(eExpose));
    await page.evaluate(() => { document.querySelector('[data-testid="fwd-expose"] input')?.click(); });
    await sleep(150);
    const ackChecked = await page.$eval('[data-testid="fwd-expose"] input', (i) => i.checked).catch(() => null);
    ok(`[${theme}] (c4) exposure ack toggles checked`, ackChecked === true, String(ackChecked));
    await panelShot('c2-expose-checked');

    // ---------- 键盘可达：暴露行在场时的完整 Tab 链 ----------
    await page.locator('.fwd-form select').focus();
    const tabChain = [];
    for (let i = 0; i < 9; i++) {
      const info = await page.evaluate(() => {
        const a = document.activeElement; if (!a) return null;
        const cs = getComputedStyle(a);
        return { tag: a.tagName, cls: a.className, type: a.type || '', text: (a.textContent || '').trim().slice(0, 12),
          outlineW: cs.outlineWidth, outlineColor: cs.outlineColor, boxShadow: cs.boxShadow,
          focusVisible: a.matches(':focus-visible') };
      });
      if (info) tabChain.push(info);
      await page.keyboard.press('Tab'); await sleep(60);
    }
    const tagSeq = tabChain.map((t) => t.tag + (t.type ? ':' + t.type : '') + (t.cls ? '.' + String(t.cls).split(' ')[0] : ''));
    const reachedSelect = tabChain.some((t) => t.tag === 'SELECT');
    const reachedCheckbox = tabChain.some((t) => t.tag === 'INPUT' && t.type === 'checkbox');
    const reachedStart = tabChain.some((t) => t.tag === 'BUTTON' && t.text.includes('启动转发'));
    ok(`[${theme}] kbd reaches select`, reachedSelect, tagSeq.join(' > '));
    ok(`[${theme}] kbd reaches exposure checkbox`, reachedCheckbox);
    ok(`[${theme}] kbd reaches 启动转发 button`, reachedStart);
    // 焦点可见：每个 Tab 停点都应有可见焦点指示
    const noFocus = tabChain.filter((t) => !(t.outlineW && t.outlineW !== '0px') && (!t.boxShadow || t.boxShadow === 'none'));
    ok(`[${theme}] every tab stop has visible focus indicator`, noFocus.length === 0, JSON.stringify(noFocus.map((t) => t.tag + '.' + String(t.cls).split(' ')[0])));

    // ---------- (d) 成功建一条 -L ----------
    await setAddr('127.0.0.1'); await sleep(100);
    await setKind('Local'); await sleep(100);
    await setVal(1, '8080'); await setVal(2, '10.0.0.31'); await setVal(3, '5432');
    await startBtn();
    const row1 = await waitFor_(async () => { const r = await page.$$eval('.fwd-row', (rs) => rs.length); return r === 1 ? r : null; }, 25);
    ok(`[${theme}] (d) -L forward row created`, row1 === 1);
    const dRow = await page.$$eval('.fwd-row', (rs) => rs.map((r) => ({
      kind: r.querySelector('.fwd-kind')?.textContent, route: r.querySelector('.xfer-name')?.textContent,
      state: r.querySelector('.fwd-state')?.textContent, sub: r.querySelector('.xfer-sub')?.textContent })));
    ok(`[${theme}] (d2) route human-readable`, dRow[0] && dRow[0].route.includes('127.0.0.1:8080') && dRow[0].route.includes('10.0.0.31:5432'), dRow[0] && dRow[0].route);
    ok(`[${theme}] (d3) listening vs reachable separated`, dRow[0] && dRow[0].state === '监听中' && dRow[0].sub.includes('目标可达性未验证'), dRow[0] ? dRow[0].state + ' | ' + dRow[0].sub : '');
    if (dRow[0]) {
      const mState = await measure('.fwd-row .fwd-state'); contrasts.push({ theme, state: 'row-listen-state', ...mState });
      const mSub = await measure('.fwd-row .xfer-sub'); contrasts.push({ theme, state: 'row-health', ...mSub });
      const mKind = await measure('.fwd-row .fwd-kind'); contrasts.push({ theme, state: 'row-kind', ...mKind });
      const mRoute = await measure('.fwd-row .xfer-name'); contrasts.push({ theme, state: 'row-route', ...mRoute });
      const mStop = await measure('.fwd-row button'); contrasts.push({ theme, state: 'row-stop-btn', ...mStop });
    }
    await panelShot('d-row-L');

    // ---------- (f) 端口冲突字段错误 ----------
    await demoInvoke('demo_forward_conflict', { ports: [9090] }).catch(() => {});
    await setVal(1, '9090'); await setVal(2, '10.0.0.31'); await setVal(3, '5432');
    await startBtn(); await sleep(250);
    const eConflict = await page.$eval('[data-testid="fwd-err-listen"]', (e) => e.textContent).catch(() => null);
    ok(`[${theme}] (f) port conflict → field error on listen`, !!eConflict && eConflict.includes('占用'), String(eConflict));
    await panelShot('f-conflict');
    await demoInvoke('demo_forward_conflict', { ports: [] }).catch(() => {});

    // ---------- (e) -D 行（无目标） ----------
    await setKind('Dynamic'); await sleep(120);
    const targetRowGone = await page.evaluate(() => !document.querySelector('.fwd-form input.mono[placeholder="目标主机"], .fwd-form input.mono[placeholder="回到本机·主机"]'));
    ok(`[${theme}] (e) -D hides target row`, targetRowGone);
    await setVal(1, '1080'); await startBtn();
    const row2 = await waitFor_(async () => { const r = await page.$$eval('.fwd-row', (rs) => rs.length); return r === 2 ? r : null; }, 25);
    ok(`[${theme}] (e2) -D row created`, row2 === 2);
    const dD = await page.$$eval('.fwd-row', (rs) => rs.map((r) => ({ kind: r.querySelector('.fwd-kind')?.textContent, route: r.querySelector('.xfer-name')?.textContent })));
    const dDr = dD.find((r) => r.kind === '-D');
    ok(`[${theme}] (e3) SOCKS5 route has no target`, !!dDr && dDr.route.includes('SOCKS5') && !dDr.route.includes('→'), dDr ? dDr.route : 'none');
    await panelShot('e-row-D');

    // ---------- 盒测量/布局（当前 1280x800） ----------
    const layout = await page.evaluate(() => {
      const tp = document.querySelector('.task-panel .tp-scroll');
      const rows = [...document.querySelectorAll('.section .fwd-form')].map((r) => { const b = r.getBoundingClientRect(); return { top: Math.round(b.top), bottom: Math.round(b.bottom), h: Math.round(b.height) }; });
      let overlap = false; for (let i = 0; i < rows.length - 1; i++) if (rows[i].bottom > rows[i + 1].top + 1) overlap = true;
      const names = [...document.querySelectorAll('.fwd-row .xfer-name')].map((n) => { const cs = getComputedStyle(n); return { textOverflow: cs.textOverflow, overflow: cs.overflow, whiteSpace: cs.whiteSpace }; });
      return { tpScrollW: tp.scrollWidth, tpClientW: tp.clientWidth, rows, overlap, names };
    });
    ok(`[${theme}] layout: no fwd-form row overlap`, !layout.overlap, JSON.stringify(layout.rows));
    ok(`[${theme}] layout: task panel no horizontal overflow`, layout.tpScrollW <= layout.tpClientW + 1, `scroll=${layout.tpScrollW} client=${layout.tpClientW}`);
    ok(`[${theme}] layout: route text truncatable`, layout.names.length > 0 && layout.names.every((n) => n.textOverflow === 'ellipsis' && n.overflow === 'hidden'), JSON.stringify(layout.names));
    boxes.push({ theme, viewport: '1280x800', ...layout });

    // 长路线不撑破行
    await setKind('Local'); await sleep(100);
    await setVal(2, 'a-very-long-remote-target-host-name.internal.example.corp'); await setVal(3, '54321');
    await setVal(1, '18080'); await startBtn();
    await waitFor_(async () => { const r = await page.$$eval('.fwd-row', (rs) => rs.length); return r === 3 ? r : null; }, 25);
    const longOk = await page.evaluate(() => {
      const rows = [...document.querySelectorAll('.fwd-row')];
      const r = rows[rows.length - 1]; if (!r) return null;
      const n = r.querySelector('.xfer-name'); const rb = r.getBoundingClientRect(); const nb = n.getBoundingClientRect();
      return { rowW: Math.round(rb.width), nameScroll: n.scrollWidth, nameClient: n.clientWidth, contained: nb.right <= rb.right + 1 };
    });
    ok(`[${theme}] long route contained in row`, longOk && longOk.contained, JSON.stringify(longOk));
    // 清掉这条长路线
    await page.evaluate(() => {
      const rows = [...document.querySelectorAll('.fwd-row')];
      const r = rows[rows.length - 1]; const b = r && [...r.querySelectorAll('button')].find((x) => x.textContent.trim() === '停止'); b?.click();
    });
    await waitFor_(async () => { const r = await page.$$eval('.fwd-row', (rs) => rs.length); return r === 2 ? r : null; }, 25);

    // ---------- 节外回归：文件面板 + 传输抽屉 + 工具菜单 ----------
    await page.evaluate(() => { [...document.querySelectorAll('.tools-menu button')].find((b) => b.textContent.includes('端口转发'))?.click(); }).catch(() => {});
    await sleep(100);
    await page.evaluate(() => { [...document.querySelectorAll('.st-file')][0]?.click(); });
    const filesOk = await waitFor_(async () => page.evaluate(() => !!document.querySelector('.sftp-path, .sftp-list, .sftp-crumbs')), 20);
    ok(`[${theme}] regression: file panel renders`, !!filesOk);
    await panelShot('reg-files');

    // ---------- 零 JS 报错 ----------
    ok(`[${theme}] zero JS errors`, jsErrors.length === 0, jsErrors.slice(0, 3).join(' | '));

    summary[theme] = { passed: results.filter((r) => r.pass).length, total: results.length, jsErrors: jsErrors.length };
    await ctx.close();
  }

  // 对比度汇总
  log('\n================ CONTRAST (WCAG AA) ================');
  const fails = contrasts.filter((c) => !c.pass);
  for (const c of contrasts) {
    log(`${c.pass ? 'ok  ' : 'FAIL'} [${c.theme}/${c.state}] ${c.sel}  ratio=${c.ratio} (thr ${c.threshold})  fg=${c.color} bg=${c.bg} fs=${c.fontSize}`);
  }
  log(`\ncontrast: ${contrasts.length - fails.length}/${contrasts.length} pass; ${fails.length} FAIL`);
  for (const f of fails) log(`  FAIL [${f.theme}/${f.state}] ${f.sel} ratio=${f.ratio} < ${f.threshold} (fg=${f.color} bg=${f.bg} fs=${f.fontSize})`);

  fs.writeFileSync(path.join(OUT, 'vis-r40-probe-results.json'), JSON.stringify({ results, contrasts, boxes, summary }, null, 2));
  log('\n================ SUMMARY ================');
  for (const t of Object.keys(summary)) log(`${t}: ${summary[t].passed}/${summary[t].total} checks, jsErrors=${summary[t].jsErrors}`);
  log(`total checks: ${results.filter((r) => r.pass).length}/${results.length}`);
  await browser.close();
  process.exit(results.every((r) => r.pass) && fails.length === 0 ? 0 : 1);
})().catch((e) => { console.error('PROBE CRASH', e); process.exit(2); });
