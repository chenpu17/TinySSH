// vis-r42 处置后定向复验：F1 徽标 hot 对比度 / F2 新增 .dim 提档 / F3 缺失态 warn
const { chromium } = require('/Users/chenpu/node_modules/playwright');
const EXE = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const URL = 'http://localhost:5183/';
const OUT = '/Users/chenpu/workspace/claude-code/TinySSH/docs/acceptance/ux-r1/g4/2026-10-09-r42/';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (k, v) => console.log('· ' + k + ' => ' + JSON.stringify(v));

const HELPERS = `
  const parse=(c)=>c.match(/[\\d.]+/g).map(Number);
  const lum=([r,g,b])=>{const f=(v)=>{v/=255;return v<=0.03928?v/12.92:Math.pow((v+0.055)/1.055,2.4);};return 0.2126*f(r)+0.7152*f(g)+0.0722*f(b);};
  const ratio=(a,b)=>{const L1=lum(parse(a)),L2=lum(parse(b));const hi=Math.max(L1,L2),lo=Math.min(L1,L2);return +(((hi+0.05)/(lo+0.05)).toFixed(2));};
  const effBg=(el)=>{let e=el;while(e){const bg=getComputedStyle(e).backgroundColor;if(bg&&bg!=='rgba(0, 0, 0, 0)')return bg;e=e.parentElement;}return getComputedStyle(document.body).backgroundColor;};
`;

(async () => {
  const browser = await chromium.launch({ executablePath: EXE, headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();
  const errs = []; page.on('pageerror', (e) => errs.push(String(e)));
  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => { try { localStorage.clear(); } catch {} });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.host-card', { timeout: 10000 });
  await sleep(1000);
  const inv = (cmd, args) => page.evaluate(async ({ c, a }) => { const { invoke } = await import('/src/adapter/bridge.ts'); return invoke(c, a); }, { c: cmd, a: args });
  const selectTab = async (n) => { await page.evaluate((x) => { [...document.querySelectorAll('.tab')].find((t) => t.textContent.includes(x))?.click(); }, n); await sleep(700); };
  const shot = async (n, clip) => { await page.screenshot({ path: OUT + n, ...(clip ? { clip } : {}) }); console.log('  [shot] ' + n); };

  // 注入跨会话审批（staging-1 无目标 → 缺失态；prod-1 有目标 → 有目的卡）
  const sid2 = (await inv('list_sessions')).find((s) => s.host_name === 'staging-1').id;
  await inv('demo_inject_approval', { sid: sid2, command: 'systemctl restart nginx --now --no-block --preserve-env', target_summary: '服务管理' }).catch(() => null);
  await selectTab('prod-1');
  await page.evaluate(() => document.querySelector('[data-testid="tools-collab"]')?.click());
  await sleep(3600);

  const measure = () => page.evaluate(`(() => { ${HELPERS}
    const badge=document.querySelector('[data-testid="collab-entry"]');
    const bcs=badge?getComputedStyle(badge):null;
    const purposes=[...document.querySelectorAll('[data-testid="ap-purpose"]')];
    const hasP=purposes.find(p=>!/未提供/.test(p.textContent));
    const missP=purposes.find(p=>/未提供/.test(p.textContent));
    const read=(p)=>{ if(!p) return null; const lab=p.querySelector('.dim'); const txt=[...p.querySelectorAll('span')].find(s=>s.className==='')||p.lastElementChild;
      return { labelColor: lab?getComputedStyle(lab).color:null, textColor: getComputedStyle(txt).color, bg: effBg(p) }; };
    const gheadDim=document.querySelector('.ap-group-head .dim');
    return {
      chrome: document.documentElement.getAttribute('data-chrome'),
      badge: bcs?{text:badge.textContent,fs:bcs.fontSize,fw:bcs.fontWeight,color:bcs.color,bg:bcs.backgroundColor,ratio:ratio(bcs.color,bcs.backgroundColor)}:null,
      hasPurpose: read(hasP), missing: read(missP),
      missTextRatio: missP?(()=>{const s=[...missP.querySelectorAll('span')].find(x=>/未提供/.test(x.textContent)); return s?ratio(getComputedStyle(s).color,effBg(missP)):null;})():null,
      groupHeadId: gheadDim?{color:getComputedStyle(gheadDim).color,ratio:ratio(getComputedStyle(gheadDim).color,effBg(gheadDim))}:null,
    };
  })()`);

  // ---- 浅色 ----
  const L = await measure();
  log('LIGHT 徽标hot', L.badge);
  log('LIGHT 有目的卡（标签/正文）', L.hasPurpose);
  log('LIGHT 缺失态（标签/正文）', L.missing);
  log('LIGHT 缺失文案 ratio', L.missTextRatio);
  log('LIGHT 分组头会话id', L.groupHeadId);
  const tb = await page.evaluate(() => { const r = document.querySelector('.titlebar').getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; });
  await shot('vis-r42-recheck-badge-hot-light.png', { x: 0, y: tb.y, width: 460, height: tb.height });
  await page.evaluate(() => { const p = [...document.querySelectorAll('[data-testid="ap-purpose"]')].find((x) => /未提供/.test(x.textContent)); p?.scrollIntoView({ block: 'center' }); });
  await sleep(300);
  const mp = await page.evaluate(() => { const p = [...document.querySelectorAll('[data-testid="ap-purpose"]')].find((x) => /未提供/.test(x.textContent)); const r = p.getBoundingClientRect(); return { x: r.x - 4, y: r.y - 4, width: r.width + 8, height: r.height + 8 }; });
  await shot('vis-r42-recheck-purpose-missing-light.png', mp);

  // ---- 切深色 ----
  await page.evaluate(() => document.querySelector('.hb-settings')?.click());
  await sleep(500);
  await page.evaluate(() => { [...document.querySelectorAll('.ts-appearance button')].find((b) => b.textContent.includes('深色'))?.click(); });
  await sleep(400);
  await page.keyboard.press('Escape');
  await sleep(600);
  const D = await measure();
  log('DARK 徽标hot', D.badge);
  log('DARK 有目的卡（标签/正文）', D.hasPurpose);
  log('DARK 缺失态（标签/正文）', D.missing);
  log('DARK 缺失文案 ratio', D.missTextRatio);
  log('DARK 分组头会话id', D.groupHeadId);
  const tb2 = await page.evaluate(() => { const r = document.querySelector('.titlebar').getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; });
  await shot('vis-r42-recheck-badge-hot-dark.png', { x: 0, y: tb2.y, width: 460, height: tb2.height });
  await page.evaluate(() => { const p = [...document.querySelectorAll('[data-testid="ap-purpose"]')].find((x) => /未提供/.test(x.textContent)); p?.scrollIntoView({ block: 'center' }); });
  await sleep(300);
  const mp2 = await page.evaluate(() => { const p = [...document.querySelectorAll('[data-testid="ap-purpose"]')].find((x) => /未提供/.test(x.textContent)); const r = p.getBoundingClientRect(); return { x: r.x - 4, y: r.y - 4, width: r.width + 8, height: r.height + 8 }; });
  await shot('vis-r42-recheck-purpose-missing-dark.png', mp2);
  await shot('vis-r42-recheck-groups-dark.png');
  log('Z errs', errs);
  await browser.close();
  console.log('== done ==');
})().catch((e) => { console.log('EXC', e.stack || e); process.exitCode = 1; });
