// vis-r40 定向复验（F1/F2/F3 处置后）：只验三项修复 + 必要节外回归。
// 树指纹已核对：styles.css md5 7da2c33460c5f7712c1792fea3239bae / git diff md5 236b8532670a496f3eb0086500251eb7。
const { chromium } = require('/Users/chenpu/node_modules/playwright');
const fs = require('fs'); const path = require('path');
const EXE = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const URL = 'http://localhost:5183/';
const OUT = process.env.VIS_OUT || __dirname;
const results = [];
const ok = (n, c, d = '') => { results.push({ n, pass: !!c, d }); console.log((c ? 'PASS ' : 'FAIL ') + n + (d ? '  [' + d + ']' : '')); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const contrasts = [];
const HELP = `
window.__vis = {
  parse(s){ const m=String(s).match(/rgba?\\(([^)]+)\\)/); if(!m) return null; const p=m[1].split(',').map(Number); return {r:p[0],g:p[1],b:p[2],a:p[3]===undefined?1:p[3]}; },
  lum(c){ const f=(v)=>{ v/=255; return v<=0.03928? v/12.92 : Math.pow((v+0.055)/1.055,2.4); }; return 0.2126*f(c.r)+0.7152*f(c.g)+0.0722*f(c.b); },
  ratio(fg,bg){ const L1=Math.max(this.lum(fg),this.lum(bg)), L2=Math.min(this.lum(fg),this.lum(bg)); return (L1+0.05)/(L2+0.05); },
  effBg(el){ let chain=[], n=el; while(n){ chain.push(getComputedStyle(n).backgroundColor); n=n.parentElement; } let acc={r:255,g:255,b:255}; for(let i=chain.length-1;i>=0;i--){ const c=this.parse(chain[i]); if(!c) continue; acc={r:c.r*c.a+acc.r*(1-c.a), g:c.g*c.a+acc.g*(1-c.a), b:c.b*c.a+acc.b*(1-c.a)}; } return acc; },
  measure(sel){ const el=document.querySelector(sel); if(!el) return {sel, missing:true};
    const cs=getComputedStyle(el); const fg0=this.parse(cs.color); const bg=this.effBg(el);
    let fg={...fg0}; if(fg.a<1){ fg={ r:fg0.r*fg0.a+bg.r*(1-fg0.a), g:fg0.g*fg0.a+bg.g*(1-fg0.a), b:fg0.b*fg0.a+bg.b*(1-fg0.a) }; }
    const fs=parseFloat(cs.fontSize); const wnum=parseInt(cs.fontWeight,10)||400;
    const large = fs>=24 || (fs>=18.66 && wnum>=700);
    const ratio=this.ratio(fg,bg); const thr=large?3.0:4.5;
    const bgStr='rgb('+Math.round(bg.r)+', '+Math.round(bg.g)+', '+Math.round(bg.b)+')';
    return { sel, color:cs.color, bg:bgStr, fontSize:fs, large, ratio:Math.round(ratio*100)/100, threshold:thr, pass: ratio+1e-9>=thr, text:(el.textContent||'').trim().slice(0,24) };
  }
}; true;`;

(async () => {
  const browser = await chromium.launch({ executablePath: EXE, headless: true });
  for (const theme of ['dark', 'light']) {
    console.log('\n================ THEME: ' + theme + ' ================');
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, colorScheme: theme });
    const page = await ctx.newPage();
    const jsErrors = [];
    page.on('pageerror', (e) => jsErrors.push(String(e)));
    page.on('console', (m) => { if (m.type() === 'error') jsErrors.push('console.error: ' + m.text()); });
    await page.goto(URL, { waitUntil: 'domcontentloaded' });
    await page.evaluate(() => { try { localStorage.clear(); } catch {} });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.evaluate(HELP);
    await page.waitForSelector('.host-card', { timeout: 15000 });
    await sleep(500);
    await page.evaluate(() => {
      const c = [...document.querySelectorAll('.host-card')].find((x) => x.querySelector('.host-name')?.textContent.includes('prod-1'));
      c?.querySelector('.host-connect-btn')?.click();
    });
    await sleep(1500);
    await page.evaluate(() => { [...document.querySelectorAll('.st-tools button')].find((b) => b.textContent.includes('工具'))?.click(); });
    await sleep(200);
    await page.evaluate(() => { [...document.querySelectorAll('.tools-menu button')].find((b) => b.textContent.includes('端口转发'))?.click(); });
    await sleep(500);

    const setAddr = (v) => page.evaluate((v) => {
      const el = document.querySelector('.task-panel .fwd-form input.mono');
      const s = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      s.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true }));
    }, v);
    const shot = (n) => page.locator('.task-panel').screenshot({ path: path.join(OUT, `vis-r40-recheck-${theme}-${n}.png`) }).catch(() => {});
    const measure = (s) => page.evaluate((x) => window.__vis.measure(x), s);

    // ---------- F1：非回环暴露行几何（三视口 × 双主题） ----------
    await setAddr('0.0.0.0'); await sleep(300);
    const f1 = async (w, h) => {
      await page.setViewportSize({ width: w, height: h }); await sleep(350);
      return await page.evaluate(() => {
        const label = document.querySelector('[data-testid="fwd-expose"]');
        if (!label) return { missing: true };
        const input = label.querySelector('input'); const span = label.querySelector('span');
        const panel = document.querySelector('.task-panel').getBoundingClientRect();
        const sc = document.querySelector('.task-panel .tp-scroll');
        const ib = input.getBoundingClientRect(); const sb = span.getBoundingClientRect();
        return { inputW: Math.round(ib.width), inputH: Math.round(ib.height),
          spanX: Math.round(sb.x), spanW: Math.round(sb.width), spanH: Math.round(sb.height),
          panelRight: Math.round(panel.right),
          spanInsidePanel: sb.x >= panel.left - 1 && sb.right <= panel.right + 1 && sb.width > 60,
          scrollW: sc.scrollWidth, clientW: sc.clientWidth, noHOverflow: sc.scrollWidth <= sc.clientWidth + 1 };
      });
    };
    for (const [w, h] of [[1440, 900], [1280, 800], [1024, 768]]) {
      const g = await f1(w, h);
      ok(`F1 ${w}x${h}: checkbox native width (~13px, not full row)`, g.inputW >= 8 && g.inputW <= 24, `inputW=${g.inputW}`);
      ok(`F1 ${w}x${h}: warning span inside panel & wide`, g.spanInsidePanel === true, `spanX=${g.spanX} spanW=${g.spanW} panelRight=${g.panelRight}`);
      ok(`F1 ${w}x${h}: no horizontal overflow`, g.noHOverflow === true, `scrollW=${g.scrollW} clientW=${g.clientW}`);
    }
    // 截图（暴露行已可见）
    await page.setViewportSize({ width: 1280, height: 800 }); await sleep(300);
    await shot('expose');
    // 文本点击可切换（label 包裹 → 现在文字可见也应可点）
    const toggled = await page.evaluate(() => {
      const span = document.querySelector('[data-testid="fwd-expose"] span');
      const before = document.querySelector('[data-testid="fwd-expose"] input').checked;
      span.click();
      const after = document.querySelector('[data-testid="fwd-expose"] input').checked;
      return { before, after };
    });
    ok(`F1: clicking warning text toggles checkbox (label works)`, toggled.before !== toggled.after, JSON.stringify(toggled));

    // ---------- F3：暴露正文对比度（浅色 --panel 应 ≥4.5；深色不回退） ----------
    const mExpose = await measure('[data-testid="fwd-expose"] span');
    contrasts.push({ theme, item: 'fwd-expose span', ...mExpose });
    ok(`F3 [${theme}]: .fwd-expose span ≥4.5`, mExpose.pass === true, `ratio=${mExpose.ratio} fg=${mExpose.color} bg=${mExpose.bg}`);

    // ---------- F2：.section h4 / .ah-field label 对比度 ----------
    const mH4 = await measure('.task-panel .section h4');
    const mLbl = await measure('.task-panel .ah-field label');
    contrasts.push({ theme, item: 'section h4', ...mH4 });
    contrasts.push({ theme, item: 'ah-field label', ...mLbl });
    ok(`F2 [${theme}]: .section h4 ≥4.5`, mH4.pass === true, `ratio=${mH4.ratio} fg=${mH4.color} bg=${mH4.bg}`);
    ok(`F2 [${theme}]: .ah-field label ≥4.5`, mLbl.pass === true, `ratio=${mLbl.ratio} fg=${mLbl.color} bg=${mLbl.bg}`);

    // ---------- 同族改动面：.fwd-state.warn / .fwd-kind.remote（桩注入真实 .card 上下文） ----------
    await page.evaluate(() => {
      const sec = document.querySelector('.task-panel .section');
      const d = document.createElement('div'); d.id = '__vis_probe'; d.className = 'card';
      d.innerHTML = '<div class="row" style="align-items:center">' +
        '<span class="fwd-kind remote">-R</span><span class="fwd-kind local">-L</span><span class="fwd-kind dynamic">-D</span>' +
        '<span class="fwd-state warn">降级</span><span class="fwd-state listen">监听中</span><span class="fwd-state err">失败</span></div>' +
        '<div class="mono xfer-sub warn">健康行warn</div>';
      sec.appendChild(d);
    });
    for (const s of ['#__vis_probe .fwd-kind.remote', '#__vis_probe .fwd-state.warn', '#__vis_probe .fwd-kind.local', '#__vis_probe .fwd-kind.dynamic', '#__vis_probe .fwd-state.err', '#__vis_probe .xfer-sub.warn']) {
      const m = await measure(s); if (!m.missing) contrasts.push({ theme, item: s.replace('#__vis_probe ', ''), ...m });
    }
    await page.evaluate(() => { document.getElementById('__vis_probe')?.remove(); });
    const mRemote = contrasts.find((c) => c.theme === theme && c.item === '.fwd-kind.remote');
    const mWarn = contrasts.find((c) => c.theme === theme && c.item === '.fwd-state.warn');
    ok(`同族 [${theme}]: .fwd-kind.remote ≥4.5`, mRemote && mRemote.pass, mRemote ? `ratio=${mRemote.ratio}` : '');
    ok(`同族 [${theme}]: .fwd-state.warn ≥4.5`, mWarn && mWarn.pass, mWarn ? `ratio=${mWarn.ratio}` : '');

    // ---------- 节外回归：文件面板 / 协作面板 / 传输抽屉 ----------
    await page.evaluate(() => { [...document.querySelectorAll('.tools-menu button')].find((b) => b.textContent.includes('端口转发'))?.click(); }).catch(() => {});
    await sleep(120);
    await page.evaluate(() => { [...document.querySelectorAll('.st-file')][0]?.click(); });
    const filesOk = await page.waitForFunction(() => !!document.querySelector('.sftp-path, .sftp-list, .sftp-crumbs'), { timeout: 8000 }).then(() => true).catch(() => false);
    ok(`节外 [${theme}]: file panel renders`, filesOk);
    await page.locator('.task-panel').screenshot({ path: path.join(OUT, `vis-r40-recheck-${theme}-reg-files.png`) }).catch(() => {});
    await page.evaluate(() => { [...document.querySelectorAll('.st-tools button')].find((b) => b.textContent.includes('工具'))?.click(); });
    await sleep(180);
    await page.evaluate(() => { [...document.querySelectorAll('.tools-menu button')].find((b) => b.textContent.includes('审批与记录'))?.click(); });
    await sleep(450);
    const collabOk = await page.evaluate(() => !!document.querySelector('.task-panel .section h4'));
    ok(`节外 [${theme}]: collab panel renders`, collabOk);
    await page.locator('.task-panel').screenshot({ path: path.join(OUT, `vis-r40-recheck-${theme}-reg-collab.png`) }).catch(() => {});
    const drawerOk = await page.evaluate(() => { const b = [...document.querySelectorAll('.statusbar button, .sb-btn')].find((x) => x.textContent.includes('传输')); if (b) { b.click(); return true; } return false; });
    await sleep(350);
    ok(`节外 [${theme}]: transfer drawer toggles`, await page.evaluate(() => !!document.querySelector('.queue-drawer, .queue-body')), 'clicked=' + drawerOk);

    ok(`零 JS 报错 [${theme}]`, jsErrors.length === 0, jsErrors.slice(0, 3).join(' | '));
    await ctx.close();
  }

  console.log('\n================ 对比度明细（复验） ================');
  for (const c of contrasts) console.log(`${c.pass ? 'ok  ' : 'FAIL'} [${c.theme}] ${c.item}  ratio=${c.ratio} (thr ${c.threshold}) fg=${c.color} bg=${c.bg}`);
  const cfails = contrasts.filter((c) => !c.pass);
  console.log(`\ncontrast: ${contrasts.length - cfails.length}/${contrasts.length} pass`);
  for (const f of cfails) console.log(`  FAIL [${f.theme}] ${f.item} ratio=${f.ratio} < ${f.threshold}`);

  fs.writeFileSync(path.join(OUT, 'vis-r40-recheck-results.json'), JSON.stringify({ results, contrasts }, null, 2));
  console.log(`\n${results.filter((r) => r.pass).length}/${results.length} checks`);
  await browser.close();
  process.exit(0);
})().catch((e) => { console.error('CRASH', e); process.exit(2); });
