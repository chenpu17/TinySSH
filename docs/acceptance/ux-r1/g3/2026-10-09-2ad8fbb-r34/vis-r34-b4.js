// vis-r34 探针 B4-final：逐卡滚动盒测量（每张卡独立 scrollIntoView 后测量，贴近用户滚动行为）
const { chromium } = require('/Users/chenpu/node_modules/playwright');
const EXE = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const OUT = '/tmp/vis-r34';
const results = [];
const ok = (name, cond, detail = '') => { results.push({ name, pass: !!cond }); console.log((cond ? 'PASS ' : 'FAIL ') + name + (detail ? '  [' + String(detail).slice(0, 500) + ']' : '')); };
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

  for (const w of [1280, 640]) {
    for (const theme of ['dark', 'light']) {
      const { ctx, page } = await mk(w, 800, theme);
      const { demoInvoke, sid } = await connect(page);
      await demoInvoke('upload_file', { sid, local: '/Users/demo/Desktop/g.conflict-demo', remote: '/var/log/nginx/g.conflict-demo' });
      await demoInvoke('upload_file', { sid, local: '/Users/demo/Desktop/g.unknown-demo', remote: '/var/log/nginx/g.unknown-demo' });
      await demoInvoke('upload_file', { sid, local: '/Users/demo/Desktop/g.interrupt-demo', remote: '/var/log/nginx/g.interrupt-demo' });
      await demoInvoke('upload_file', { sid, local: '/Users/demo/Desktop/g.fail-demo', remote: '/var/log/nginx/g.fail-demo' });
      await waitFor_(page, () => !!document.querySelector('.xfer-conflict') && !!document.querySelector('[data-testid="uo-reverify"]')
        && [...document.querySelectorAll('.xfer-row')].some((x) => x.textContent.includes('已中断'))
        && [...document.querySelectorAll('.xfer-row')].some((x) => x.textContent.includes('失败：演示注入')), 30);
      await sleep(300);
      // 逐卡滚动+独立测量
      const report = [];
      let allOk = true;
      const targets = [
        ['conflict', () => document.querySelector('.xfer-conflict')?.closest('.xfer-row')],
        ['unknown', () => document.querySelector('[data-testid="uo-reverify"]')?.closest('.xfer-row')],
        ['interrupted', () => [...document.querySelectorAll('.xfer-row')].find((x) => x.textContent.includes('已中断'))],
        ['failed', () => [...document.querySelectorAll('.xfer-row')].find((x) => x.textContent.includes('失败：演示注入'))],
      ];
      for (const [label] of targets) {
        await page.evaluate((lb) => {
          const pickFns = {
            conflict: () => document.querySelector('.xfer-conflict')?.closest('.xfer-row'),
            unknown: () => document.querySelector('[data-testid="uo-reverify"]')?.closest('.xfer-row'),
            interrupted: () => [...document.querySelectorAll('.xfer-row')].find((x) => x.textContent.includes('已中断')),
            failed: () => [...document.querySelectorAll('.xfer-row')].find((x) => x.textContent.includes('失败：演示注入')),
          };
          pickFns[lb]?.()?.scrollIntoView({ block: 'center' });
        }, label);
        await sleep(200);
        const m = await page.evaluate((lb) => {
          const vw = window.innerWidth, vh = window.innerHeight;
          const panel = document.querySelector('.task-panel');
          const pBox = panel.getBoundingClientRect();
          const sec = [...document.querySelectorAll('h4')].find((x) => x.textContent === '传输')?.parentElement;
          const pickFns = {
            conflict: () => document.querySelector('.xfer-conflict')?.closest('.xfer-row'),
            unknown: () => document.querySelector('[data-testid="uo-reverify"]')?.closest('.xfer-row'),
            interrupted: () => [...document.querySelectorAll('.xfer-row')].find((x) => x.textContent.includes('已中断')),
            failed: () => [...document.querySelectorAll('.xfer-row')].find((x) => x.textContent.includes('失败：演示注入')),
          };
          const row = pickFns[lb]();
          if (!row) return { missing: true };
          const r = row.getBoundingClientRect();
          const inVp = r.left >= -1 && r.top >= -1 && r.right <= vw + 1 && r.bottom <= vh + 1;
          const inPanel = r.left >= pBox.left - 1 && r.right <= pBox.right + 1 && r.top >= pBox.top - 1 && r.bottom <= pBox.bottom + 1;
          const btns = [...row.querySelectorAll('button')];
          const rB = (el) => { const b = el.getBoundingClientRect(); return { l: b.left, t: b.top, r: b.right, b: b.bottom, w: b.width, h: b.height }; };
          const hitOk = (el) => {
            const b = el.getBoundingClientRect();
            if (b.height >= 24 && b.width >= 24) return true;
            const st = getComputedStyle(el, '::after');
            return st.content === '""' && (b.height + 10 >= 24) && (b.width + 10 >= 24);
          };
          const overlap = (a, b) => !(a.r <= b.l || b.r <= a.l || a.b <= b.t || b.b <= a.t);
          const boxes = btns.map(rB);
          let ov = false;
          for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) if (overlap(boxes[i], boxes[j])) ov = true;
          const block = row.querySelector('.xfer-conflict');
          const sub = row.querySelector('.xfer-sub');
          return {
            missing: false,
            inVp, inPanel,
            btnN: btns.length,
            btnHit: btns.every(hitOk),
            btnOv: ov,
            blockInRow: block ? (rB(block).l >= r.left - 1 && rB(block).r <= r.right + 1) : null,
            subClip: sub ? sub.scrollHeight > sub.clientHeight + 2 : null,
            secOvf: sec ? sec.scrollWidth > sec.clientWidth + 1 : true,
            docOvf: document.documentElement.scrollWidth > document.documentElement.clientWidth,
            rowH: Math.round(r.height),
            btnSizes: boxes.map((b) => `${Math.round(b.w)}x${Math.round(b.h)}`),
          };
        }, label);
        const rowOk = !m.missing && m.inVp && m.inPanel && m.btnHit && !m.btnOv && !m.secOvf && !m.docOvf
          && m.subClip === false && (m.blockInRow !== false) && (label === 'conflict' ? m.btnN === 4 : true);
        report.push(`${label}:${rowOk ? 'OK' : 'BAD'}(${JSON.stringify(m)})`);
        if (!rowOk) allOk = false;
      }
      ok(`B1R ${w}/${theme} 逐卡盒测量`, allOk, report.join(' | '));
      // 冲突卡特写截图
      await page.evaluate(() => document.querySelector('.xfer-conflict')?.closest('.xfer-row')?.scrollIntoView({ block: 'center' }));
      await sleep(200);
      await page.screenshot({ path: `${OUT}/b4-conflict-${w}-${theme}.png` });
      await ctx.close();
    }
  }
  ok('B8 全程零 pageerror/console error', errsAll.length === 0, errsAll.join(' | ').slice(0, 300));
  const fails = results.filter((r) => !r.pass).length;
  console.log(`\n${results.length - fails}/${results.length} passed`);
  await browser.close();
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error('VIS-B4 CRASH', e); process.exit(2); });
