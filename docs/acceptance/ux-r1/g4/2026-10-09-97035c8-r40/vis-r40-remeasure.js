// vis-r40 定向重测：把对比度测量严格限定在 .task-panel（端口转发面板）内，
// 修正首轮 .section h4 / .section button 误命中 hostbar「全部主机」的问题。
const { chromium } = require('/Users/chenpu/node_modules/playwright');
const fs = require('fs'); const path = require('path');
const EXE = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const URL = 'http://localhost:5183/';
const OUT = process.env.VIS_OUT || __dirname;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
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
    return { sel, color:cs.color, bg:bgStr, fontSize:fs, weight:cs.fontWeight, large, ratio:Math.round(ratio*100)/100, threshold:thr, pass: ratio+1e-9>=thr, text:(el.textContent||'').trim().slice(0,30) };
  }
}; true;`;

(async () => {
  const browser = await chromium.launch({ executablePath: EXE, headless: true });
  const out = [];
  for (const theme of ['dark', 'light']) {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, colorScheme: theme });
    const page = await ctx.newPage();
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
    await sleep(600);
    // 给「启动转发」按钮打标，供精确定位
    await page.evaluate(() => {
      const b = [...document.querySelectorAll('.task-panel .section button')].find((x) => x.textContent.trim() === '启动转发');
      if (b) b.setAttribute('data-vis', 'start');
    });
    // 触发监听字段错误
    await page.evaluate(() => {
      const ins = [...document.querySelectorAll('.task-panel .fwd-form input.mono')];
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(ins[1], ''); ins[1].dispatchEvent(new Event('input', { bubbles: true }));
    });
    await page.evaluate(() => { [...document.querySelectorAll('.task-panel [data-vis="start"]')][0]?.click(); });
    await sleep(250);
    // 触发暴露行
    await page.evaluate(() => {
      const el = document.querySelector('.task-panel .fwd-form input.mono');
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(el, '0.0.0.0'); el.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await sleep(250);

    const sels = [
      '.task-panel .section h4',                 // 面板标题「端口转发」
      '.task-panel .fwd-form select',
      '.task-panel .fwd-form input.mono',
      '.task-panel .ah-field label',             // 表单字段标签
      '.task-panel [data-vis="start"]',          // 启动转发按钮
      '.task-panel .side-quiet',                 // 启动钮旁的说明
      '.task-panel [data-testid="fwd-err-listen"]',
      '.task-panel [data-testid="fwd-expose"] span',
      '.task-panel [data-testid="fwd-expose"] input', // 勾选框本体
    ];
    for (const s of sels) {
      const m = await page.evaluate((x) => window.__vis.measure(x), s);
      if (!m.missing) { out.push({ theme, ...m }); }
      else out.push({ theme, sel: s, missing: true });
    }
    await ctx.close();
  }
  console.log('================ 定向重测（限定 .task-panel） ================');
  for (const c of out) {
    if (c.missing) { console.log(`MISS  [${c.theme}] ${c.sel}`); continue; }
    console.log(`${c.pass ? 'ok  ' : 'FAIL'} [${c.theme}] ${c.sel}  ratio=${c.ratio} (thr ${c.threshold}) fg=${c.color} bg=${c.bg} fs=${c.fontSize}  "${c.text}"`);
  }
  const fails = out.filter((c) => !c.missing && !c.pass);
  console.log(`\nFAIL count: ${fails.length}`);
  fs.writeFileSync(path.join(OUT, 'vis-r40-remeasure.json'), JSON.stringify(out, null, 2));
  await browser.close();
  process.exit(0);
})().catch((e) => { console.error('CRASH', e); process.exit(2); });
