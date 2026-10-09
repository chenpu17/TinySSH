// vis-r34 定向复验：unknown 卡说明行 dim→.xfer-note(text-sub) 修复
// F1 对比度双主题（预期 6.53/6.97）
// F2 盒测量：white-space normal 换行后无溢出/与重核钮无叠印/钮 hit 保持
// F3 unknown 卡其余面无回归（重核钮/结果未知首行/图标 ✕err）
// F4 360 挤压容器内换行行为（wrap 不叠印不溢出）
const { chromium } = require('/Users/chenpu/node_modules/playwright');
const EXE = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const OUT = '/tmp/vis-r34';
const results = [];
const ok = (name, cond, detail = '') => { results.push({ name, pass: !!cond }); console.log((cond ? 'PASS ' : 'FAIL ') + name + (detail ? '  [' + String(detail).slice(0, 400) + ']' : '')); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const browser = await chromium.launch({ executablePath: EXE, headless: true });
  const errsAll = [];
  const mk = async (w, h, theme) => {
    const ctx = await browser.newContext({ viewport: { width: w, height: h } });
    const page = await ctx.newPage();
    page.on('pageerror', (e) => errsAll.push(`[${w}/${theme}] ${String(e)}`));
    page.on('console', (m) => { if (m.type() === 'error') errsAll.push(`[${w}/${theme} console] ${m.text()}`); });
    await page.emulateMedia({ colorScheme: theme });
    await page.goto('http://localhost:5183/', { waitUntil: 'domcontentloaded' });
    await page.evaluate(() => { try { localStorage.clear(); } catch {} });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.host-card', { timeout: 10000 });
    await sleep(600);
    return { ctx, page };
  };
  const connect = async (page) => {
    const demoInvoke = (cmd, args) => page.evaluate(async ({ c, a }) => {
      const { invoke } = await import('/src/adapter/bridge.ts');
      return invoke(c, a);
    }, { c: cmd, a: args });
    await page.evaluate(() => {
      const card = [...document.querySelectorAll('.host-card')].find((c) => c.querySelector('.host-name')?.textContent.includes('prod-1'));
      card?.querySelector('.host-connect-btn')?.click();
    });
    await page.waitForSelector('.hk-mask', { timeout: 6000 }).catch(() => {});
    await page.evaluate(() => { [...document.querySelectorAll('.hk-mask button')].find((x) => x.textContent.includes('信任并连接'))?.click(); });
    const sid = await (async () => {
      for (let i = 0; i < 80; i++) {
        const l = await demoInvoke('list_sessions');
        const mine = l.filter((x) => x.host_name.includes('prod-1') && x.state === 'Connected');
        const id = mine.sort((a, b) => (a.created_at < b.created_at ? 1 : -1))[0]?.id;
        if (id) return id;
        await sleep(150);
      }
      return null;
    })();
    await page.evaluate(() => document.querySelector('.st-file')?.click());
    await page.waitForSelector('.sftp-row', { timeout: 8000 }).catch(() => {});
    await sleep(500);
    return { demoInvoke, sid };
  };
  const waitFor_ = async (page, fn, tries, gap = 200) => {
    for (let i = 0; i < tries; i++) { const v = await page.evaluate(fn); if (v) return v; await sleep(gap); }
    return null;
  };

  for (const w of [1280, 640, 360]) {
    for (const theme of ['dark', 'light']) {
      const { ctx, page } = await mk(w, w === 360 ? 740 : 800, theme);
      const { demoInvoke, sid } = await connect(page);
      await demoInvoke('upload_file', { sid, local: '/Users/demo/Desktop/n.unknown-demo', remote: '/var/log/nginx/n.unknown-demo' });
      await waitFor_(page, () => !!document.querySelector('.xfer-note'), 30);
      await sleep(300);
      await page.evaluate(() => document.querySelector('.xfer-note')?.closest('.xfer-row')?.scrollIntoView({ block: 'center' }));
      await sleep(200);
      const m = await page.evaluate(() => {
        const lum = (css) => {
          const p = css.match(/[\d.]+/g);
          if (!p) return null;
          const [r, g, b] = p.slice(0, 3).map(Number).map((v) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4); });
          return 0.2126 * r + 0.7152 * g + 0.0722 * b;
        };
        const effBg = (el) => {
          let n = el;
          while (n && n !== document.documentElement) {
            const bg = getComputedStyle(n).backgroundColor;
            if (bg && !bg.includes('rgba(0, 0, 0, 0)') && !bg.includes('transparent')) return bg;
            n = n.parentElement;
          }
          return getComputedStyle(document.body).backgroundColor;
        };
        const note = document.querySelector('.xfer-note');
        const row = note?.closest('.xfer-row');
        if (!note || !row) return { missing: true };
        const st = getComputedStyle(note);
        const bg = effBg(note);
        const [l1, l2] = [lum(st.color), lum(bg)].sort((a, b) => b - a);
        const panel = document.querySelector('.task-panel');
        const pBox = panel.getBoundingClientRect();
        const r = note.getBoundingClientRect();
        const btn = row.querySelector('[data-testid="uo-reverify"]');
        const bR = btn.getBoundingClientRect();
        const rowR = row.getBoundingClientRect();
        const vw = window.innerWidth, vh = window.innerHeight;
        const overlap = !(bR.right <= r.left || r.right <= bR.left || bR.bottom <= r.top || r.bottom <= bR.top);
        const sec = [...document.querySelectorAll('h4')].find((x) => x.textContent === '传输')?.parentElement;
        return {
          cls: note.className,
          ratio: +((l1 + 0.05) / (l2 + 0.05)).toFixed(2),
          fg: st.color,
          whiteSpace: st.whiteSpace,
          fontSize: st.fontSize,
          inVp: r.left >= -1 && r.top >= -1 && r.right <= vw + 1 && r.bottom <= vh + 1,
          inPanel: r.left >= pBox.left - 1 && r.right <= pBox.right + 1 && r.top >= pBox.top - 1 && r.bottom <= pBox.bottom + 1,
          inRow: r.left >= rowR.left - 1 && r.right <= rowR.right + 1,
          overlapBtn: overlap,
          noteH: Math.round(r.height),
          btnHit: bR.height >= 24 || (getComputedStyle(btn, '::after').content === '""' && bR.height + 10 >= 24),
          btnTxt: btn.textContent.trim(),
          // 其余面无回归
          unknownLine: [...document.querySelectorAll('.xfer-row .xfer-sub')].some((x) => x.textContent.includes('结果未知：')),
          iconErr: (() => {
            const cand = [...row.querySelectorAll(':scope > span')].filter((s) => !s.className.includes('xfer-dir'));
            const t = cand[cand.length - 1];
            return t ? t.textContent === '✕' && t.className.includes('err') : false;
          })(),
          secOvf: sec ? sec.scrollWidth > sec.clientWidth + 1 : true,
          docOvf: document.documentElement.scrollWidth > document.documentElement.clientWidth,
          text: note.textContent,
        };
      });
      const expect = theme === 'dark' ? 6.53 : 6.97;
      const ratioOk = m.ratio !== undefined && Math.abs(m.ratio - expect) < 0.05;
      const faceOk = !m.missing && ratioOk && m.whiteSpace === 'normal' && m.fontSize === '11px'
        && m.inVp && m.inPanel && m.inRow && !m.overlapBtn && m.btnHit && m.unknownLine && m.iconErr
        && !m.secOvf && !m.docOvf;
      ok(`F ${w}/${theme} xfer-note 修复面`, faceOk, JSON.stringify(m));
      await page.screenshot({ path: `${OUT}/fix-note-${w}-${theme}.png` });
      await ctx.close();
    }
  }
  ok('F-Z 全程零 pageerror/console error', errsAll.length === 0, errsAll.join(' | ').slice(0, 300));
  const fails = results.filter((r) => !r.pass).length;
  console.log(`\n${results.length - fails}/${results.length} passed`);
  await browser.close();
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error('FIX CRASH', e); process.exit(2); });
