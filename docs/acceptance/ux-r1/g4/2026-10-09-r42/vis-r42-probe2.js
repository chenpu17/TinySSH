// vis-r42 补充：深色面板 + 对比度实测 + 中宽（400px 常规面板）长命令
const { chromium } = require('/Users/chenpu/node_modules/playwright');
const EXE = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const URL = 'http://localhost:5183/';
const OUT = '/Users/chenpu/workspace/claude-code/TinySSH/docs/acceptance/ux-r1/g4/2026-10-09-r42/';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (k, v) => console.log('· ' + k + ' => ' + JSON.stringify(v));

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
  const shot = async (n) => { await page.screenshot({ path: OUT + n }); console.log('  [shot] ' + n); };

  // 注入跨会话审批，制造分组
  const sid2 = (await inv('list_sessions')).find((s) => s.host_name === 'staging-1').id;
  await inv('demo_inject_approval', { sid: sid2, command: 'systemctl restart nginx --now --no-block --preserve-env', target_summary: '服务管理' }).catch(() => null);
  await selectTab('prod-1');
  await page.evaluate(() => document.querySelector('[data-testid="tools-collab"]')?.click());
  await sleep(3600);

  const contrast = await page.evaluate(() => {
    const parse = (c) => c.match(/\d+(\.\d+)?/g).map(Number);
    const lum = ([r, g, b]) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
    const ratio = (a, b) => { const L1 = lum(parse(a)), L2 = lum(parse(b)); const hi = Math.max(L1, L2), lo = Math.min(L1, L2); return +(((hi + 0.05) / (lo + 0.05)).toFixed(2)); };
    const effBg = (el) => { let e = el; while (e) { const bg = getComputedStyle(e).backgroundColor; if (bg && bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent') return bg; e = e.parentElement; } return getComputedStyle(document.body).backgroundColor; };
    const m = (sel, label) => { const e = document.querySelector(sel); if (!e) return { label, missing: true }; const cs = getComputedStyle(e); return { label, fs: cs.fontSize, fw: cs.fontWeight, color: cs.color, bg: effBg(e), ratio: ratio(cs.color, effBg(e)) }; };
    const badge = document.querySelector('[data-testid="collab-entry"]');
    const bcs = badge ? getComputedStyle(badge) : null;
    const missing = [...document.querySelectorAll('[data-testid="ap-purpose"]')].find((x) => /未提供/.test(x.textContent));
    const mspan = missing?.querySelector('.dim');
    return {
      chrome: document.documentElement.getAttribute('data-chrome'),
      badge: bcs ? { text: badge.textContent, fs: bcs.fontSize, fw: bcs.fontWeight, color: bcs.color, bg: bcs.backgroundColor, ratio: ratio(bcs.color, bcs.backgroundColor), anim: bcs.animationName } : null,
      groupHead: m('.ap-group-head b', 'ap-group-head-b'),
      purposeMissing: mspan ? { fs: getComputedStyle(mspan).fontSize, color: getComputedStyle(mspan).color, bg: effBg(mspan), ratio: ratio(getComputedStyle(mspan).color, effBg(mspan)) } : null,
      tsum: m('.tsum-chip', 'tsum-chip'),
      cmd: m('.collab-approvals .cmd', 'cmd'),
    };
  });
  log('contrast(light)', contrast);

  // 常规 400px 面板下「最近处理」长命令是否省略号截断（信息项）
  const resolved = await page.evaluate(() => {
    const els = [...document.querySelectorAll('.collab-approvals .tl-cmd-text')].map((e) => ({ text: e.textContent, sw: e.scrollWidth, cw: e.clientWidth, to: getComputedStyle(e).textOverflow, ws: getComputedStyle(e).whiteSpace, clipped: e.scrollWidth > e.clientWidth + 1 }));
    return { tpFull: !!document.querySelector('.task-panel.tp-full'), els };
  });
  log('常规面板 最近处理命令', resolved);

  // 切深色
  await page.evaluate(() => document.querySelector('.hb-settings')?.click());
  await sleep(500);
  await page.evaluate(() => { [...document.querySelectorAll('.ts-appearance button')].find((b) => b.textContent.includes('深色'))?.click(); });
  await sleep(400);
  await page.keyboard.press('Escape');
  await sleep(500);
  const c2 = await page.evaluate(() => {
    const parse = (c) => c.match(/\d+(\.\d+)?/g).map(Number);
    const lum = ([r, g, b]) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
    const ratio = (a, b) => { const L1 = lum(parse(a)), L2 = lum(parse(b)); const hi = Math.max(L1, L2), lo = Math.min(L1, L2); return +(((hi + 0.05) / (lo + 0.05)).toFixed(2)); };
    const effBg = (el) => { let e = el; while (e) { const bg = getComputedStyle(e).backgroundColor; if (bg && bg !== 'rgba(0, 0, 0, 0)') return bg; e = e.parentElement; } return getComputedStyle(document.body).backgroundColor; };
    const badge = document.querySelector('[data-testid="collab-entry"]');
    const bcs = badge ? getComputedStyle(badge) : null;
    const missing = [...document.querySelectorAll('[data-testid="ap-purpose"]')].find((x) => /未提供/.test(x.textContent));
    const mspan = missing?.querySelector('.dim');
    return {
      chrome: document.documentElement.getAttribute('data-chrome'),
      badge: bcs ? { color: bcs.color, bg: bcs.backgroundColor, ratio: ratio(bcs.color, bcs.backgroundColor), fs: bcs.fontSize, fw: bcs.fontWeight } : null,
      purposeMissing: mspan ? { color: getComputedStyle(mspan).color, ratio: ratio(getComputedStyle(mspan).color, effBg(mspan)) } : null,
      hasGroups: document.querySelectorAll('[data-testid="ap-group"]').length,
    };
  });
  log('contrast(dark)', c2);
  await shot('vis-r42-09-collab-dark.png');
  const tb = await page.evaluate(() => { const r = document.querySelector('.titlebar').getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; });
  await page.screenshot({ path: OUT + 'vis-r42-10-badge-dark.png', clip: { x: 0, y: tb.y, width: 460, height: tb.h } });
  console.log('  [shot] vis-r42-10-badge-dark.png');
  log('Z errs', errs);
  await browser.close();
  console.log('== done ==');
})().catch((e) => { console.log('EXC', e.stack || e); process.exitCode = 1; });
