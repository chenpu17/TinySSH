// vis-r43 极窄复核：O-5 文案重复修复（协作面板停用态指引）
// 只读 DOM：读 [data-testid="collab-disabled"] 的 textContent + 行数/溢出几何。
const { chromium } = require('/Users/chenpu/node_modules/playwright');
const fs = require('fs');
const EXE = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const URL = process.env.PROBE_URL || 'http://localhost:5183/';
const OUT = '/Users/chenpu/workspace/claude-code/TinySSH/docs/acceptance/ux-r1/g4/2026-10-09-r43/';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ev = [];
const log = (k, v) => { ev.push({ k, v }); console.log('· ' + k + ' => ' + JSON.stringify(v)); };

(async () => {
  const browser = await chromium.launch({ executablePath: EXE, headless: true });

  // 打开指定 query 的页面 → 连主机 → 开协作面板 → 读指引文本与几何
  async function readPanel(page, query, tag) {
    await page.goto(URL + query, { waitUntil: 'domcontentloaded' });
    await page.evaluate(() => { try { localStorage.clear(); } catch {} });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.host-card', { timeout: 10000 });
    await sleep(900);
    await page.evaluate(() => {
      const c = [...document.querySelectorAll('.host-card')].find((x) => x.querySelector('.host-name')?.textContent.includes('prod-1'));
      c?.querySelector('.host-connect-btn')?.click();
    });
    await page.waitForSelector('.hk-mask', { timeout: 4000 }).catch(() => {});
    await page.evaluate(() => { [...document.querySelectorAll('.hk-mask button')].find((x) => x.textContent.includes('信任并连接'))?.click(); });
    await sleep(900);
    await page.evaluate(() => document.querySelector('[data-testid="tools-collab"]')?.click());
    await sleep(900);
    const r = await page.evaluate(() => {
      const el = document.querySelector('[data-testid="collab-disabled"]');
      if (!el) return { present: false };
      const raw = el.textContent;                       // 含子按钮文字
      const inner = el.querySelector('div > div');      // 指引正文（含按钮容器）
      const bodyText = inner ? inner.childNodes[0]?.textContent ?? '' : '';
      // 行数：用 Range 量正文文本节点的 client rects 数
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      let node = null;
      while (walker.nextNode()) { const t = walker.currentNode.textContent || '';
        if (t.includes('新 Agent 请求已被拒绝')) { node = walker.currentNode; break; } }
      let lineCount = null, textW = null, textH = null;
      if (node) { const rg = document.createRange(); rg.selectNodeContents(node);
        const rects = [...rg.getClientRects()].filter((x) => x.width > 0.5 && x.height > 0.5);
        lineCount = rects.length;
        textW = rects.length ? +Math.max(...rects.map((x) => x.width)).toFixed(1) : 0;
        textH = rects.length ? +Math.max(...rects.map((x) => x.height)).toFixed(1) : 0; }
      const b = el.getBoundingClientRect();
      const scroll = el.closest('.tp-scroll');
      return {
        present: true,
        text: raw.replace(/\s+/g, ' ').trim(),
        bodySentence: bodyText.replace(/\s+/g, ' ').trim(),
        keepClosedCount: (raw.match(/保持封闭/g) || []).length,
        lineCount, textW, textH,
        box: { x: +b.x.toFixed(1), y: +b.y.toFixed(1), w: +b.width.toFixed(1), h: +b.height.toFixed(1) },
        hClip: scroll ? scroll.scrollWidth > scroll.clientWidth + 1 : null,
        vClip: scroll ? scroll.scrollHeight > scroll.clientHeight + 1 : null,
        panelScroll: scroll ? { sw: scroll.scrollWidth, cw: scroll.clientWidth, sh: scroll.scrollHeight, ch: scroll.clientHeight } : null,
      };
    });
    log(tag + ' [' + query + ']', r);
    return r;
  }

  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();
  const errs = []; page.on('pageerror', (e) => errs.push(String(e)));

  await readPanel(page, '?disablefailed', 'O5-1 DisableFailed');
  await readPanel(page, '?fresh', 'O5-2 Disabled');

  // Disabling：demo 无该态复现路径（demo.ts 无 Disabling 字样），如实登记为未实证
  const disablingReachable = await page.evaluate(async () => {
    const { invoke } = await import('/src/adapter/bridge.ts');
    const s = await invoke('collab_status');
    return s && s.state;
  });
  log('O5-3 Disabling 复现性', { demo_collab_status_now: disablingReachable, note: 'demo.ts 无 Disabling 字样 → 该态在 demo 域不可达' });

  log('O5 JS 异常', errs);
  await ctx.close();
  await browser.close();
  fs.writeFileSync(OUT + 'vis-r43-evidence3.json', JSON.stringify(ev, null, 2));
  console.log('\n== done ==');
})().catch((e) => { console.log('PROBE EXCEPTION', e.stack || e); process.exitCode = 1; });
