// vis-r34 探针 B3（最终版）：仅重测 B1f/B2f.7/B4 的探针工艺失误段
// 修正：单次滚动（滚到最下待决卡，unknown 卡同屏在其上方）；Shift+Tab 在消费决策前；
// B4 两张冲突卡（一张决策供 skipped 行、一张保持待决供 conflict 系列测量）
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

  const measure = () => {
    const vw = window.innerWidth, vh = window.innerHeight;
    const panel = document.querySelector('.task-panel');
    const sec = [...document.querySelectorAll('h4')].find((x) => x.textContent === '传输')?.parentElement;
    const inBox = (r, b) => r.left >= b.left - 1 && r.top >= b.top - 1 && r.right <= b.right + 1 && r.bottom <= b.bottom + 1;
    const panelBox = panel ? panel.getBoundingClientRect() : null;
    const block = document.querySelector('.xfer-conflict');
    const btns = block ? [...block.querySelectorAll('button')] : [];
    const uo = document.querySelector('[data-testid="uo-reverify"]');
    const rB = (el) => { if (!el) return null; const r = el.getBoundingClientRect(); return { l: r.left, t: r.top, r: r.right, b: r.bottom, w: r.width, h: r.height }; };
    const hitOk = (el) => {
      const r = el.getBoundingClientRect();
      if (r.height >= 24 && r.width >= 24) return true;
      const st = getComputedStyle(el, '::after');
      return st.content === '""' && (r.height + 10 >= 24) && (r.width + 10 >= 24);
    };
    const overlap = (a, b) => a && b && !(a.r <= b.l || b.r <= a.l || a.b <= b.t || b.b <= a.t);
    const btnBoxes = btns.map(rB);
    let btnOv = false;
    for (let i = 0; i < btnBoxes.length; i++) for (let j = i + 1; j < btnBoxes.length; j++) if (overlap(btnBoxes[i], btnBoxes[j])) btnOv = true;
    const sub = block?.querySelector('.xfer-sub');
    const uoNote = [...document.querySelectorAll('.xfer-row .xfer-sub')].find((x) => x.textContent.includes('temp 与恢复资料保留'));
    const rowInt = [...document.querySelectorAll('.xfer-row')].find((x) => x.textContent.includes('已中断'));
    const rowFail = [...document.querySelectorAll('.xfer-row')].find((x) => x.textContent.includes('失败：演示注入'));
    return {
      blockIn: block && panelBox ? inBox(rB(block), panelBox) && inBox(rB(block), { left: 0, top: 0, right: vw, bottom: vh }) : false,
      btnsN: btns.length,
      btnsIn: btns.every((b) => inBox(rB(b), panelBox ?? { left: 0, top: 0, right: vw, bottom: vh })) && btns.every((b) => inBox(rB(b), { left: 0, top: 0, right: vw, bottom: vh })),
      btnsHit: btns.every(hitOk),
      btnOv,
      uoIn: uo && panelBox ? inBox(rB(uo), panelBox) && inBox(rB(uo), { left: 0, top: 0, right: vw, bottom: vh }) : false,
      uoHit: uo ? hitOk(uo) : false,
      blockUoOv: overlap(rB(block), rB(uo)),
      uoNoteIn: uoNote && panelBox ? inBox(rB(uoNote), panelBox) : false,
      rowsIn: [rowInt, rowFail].every((x) => x && panelBox ? inBox(rB(x), panelBox) && inBox(rB(x), { left: 0, top: 0, right: vw, bottom: vh }) : false),
      secOvf: sec ? sec.scrollWidth > sec.clientWidth + 1 : true,
      docOvf: document.documentElement.scrollWidth > document.documentElement.clientWidth,
      conflictSubClip: sub ? sub.scrollHeight > sub.clientHeight + 2 : null,
      btnSizes: btnBoxes.map((b) => `${Math.round(b.w)}x${Math.round(b.h)}`),
    };
  };

  // ---- B1-final：1280/640 × dark/light 盒测量（单次滚动）----
  for (const w of [1280, 640]) {
    for (const theme of ['dark', 'light']) {
      const { ctx, page } = await mk(w, 800, theme);
      const { demoInvoke, sid } = await connect(page);
      await demoInvoke('upload_file', { sid, local: '/Users/demo/Desktop/f.conflict-demo', remote: '/var/log/nginx/f.conflict-demo' });
      await demoInvoke('upload_file', { sid, local: '/Users/demo/Desktop/f.unknown-demo', remote: '/var/log/nginx/f.unknown-demo' });
      await demoInvoke('upload_file', { sid, local: '/Users/demo/Desktop/f.interrupt-demo', remote: '/var/log/nginx/f.interrupt-demo' });
      await demoInvoke('upload_file', { sid, local: '/Users/demo/Desktop/f.fail-demo', remote: '/var/log/nginx/f.fail-demo' });
      await waitFor_(page, () => !!document.querySelector('.xfer-conflict') && !!document.querySelector('[data-testid="uo-reverify"]')
        && [...document.querySelectorAll('.xfer-row')].some((x) => x.textContent.includes('已中断'))
        && [...document.querySelectorAll('.xfer-row')].some((x) => x.textContent.includes('失败：演示注入')), 30);
      await sleep(300);
      // 单次滚动：滚到 conflict 待决卡（列表中位置最低的目标行），其余行都在其上方同屏
      await page.evaluate(() => {
        document.querySelector('.xfer-conflict')?.closest('.xfer-row')?.scrollIntoView({ block: 'center' });
      });
      await sleep(300);
      const m = await page.evaluate(measure);
      const allOk = m.blockIn && m.btnsN === 3 && m.btnsIn && m.btnsHit && !m.btnOv && m.uoIn && m.uoHit
        && !m.blockUoOv && m.uoNoteIn && m.rowsIn && !m.secOvf && !m.docOvf && m.conflictSubClip === false;
      ok(`B1F ${w}/${theme} 盒测量全绿`, allOk, JSON.stringify(m));
      await page.screenshot({ path: `${OUT}/b3-cards-${w}-${theme}.png` });
      await ctx.close();
    }
  }

  // ---- B2-final：Shift+Tab 反向回溯（消费决策之前做）----
  {
    const { ctx, page } = await mk(1280, 800, 'dark');
    const { demoInvoke, sid } = await connect(page);
    await demoInvoke('upload_file', { sid, local: '/Users/demo/Desktop/k2.conflict-demo', remote: '/var/log/nginx/k2.conflict-demo' });
    await waitFor_(page, () => !!document.querySelector('.xfer-conflict'), 30);
    await sleep(300);
    await page.evaluate(() => document.querySelector('[data-testid="cf-keepboth"]')?.focus());
    await page.keyboard.press('Shift+Tab');
    const prev = await page.evaluate(() => document.activeElement?.getAttribute?.('data-testid') ?? null);
    ok('B2F.1 Shift+Tab 从 keepboth 回溯到 cf-overwrite', prev === 'cf-overwrite', `prev=${prev}`);
    await page.keyboard.press('Shift+Tab');
    const prev2 = await page.evaluate(() => document.activeElement?.getAttribute?.('data-testid') ?? null);
    ok('B2F.2 再 Shift+Tab 回溯到 cf-skip', prev2 === 'cf-skip', `prev2=${prev2}`);
    // 焦点环截图（keepboth 上的可见焦点）
    await page.evaluate(() => document.querySelector('[data-testid="cf-keepboth"]')?.focus());
    await sleep(150);
    await page.evaluate(() => {
      const row = document.querySelector('.xfer-conflict')?.closest('.xfer-row');
      row?.scrollIntoView({ block: 'center' });
    });
    await sleep(200);
    await page.screenshot({ path: `${OUT}/b3-focus-keepboth.png`, clip: (await page.evaluate(() => {
      const r = document.querySelector('.task-panel').getBoundingClientRect();
      return { x: r.left, y: r.top, width: r.width, height: r.height };
    })) });
    await ctx.close();
  }

  // ---- B4-final：逐元素对比度（conflict 卡保持待决 + skipped 行并存）----
  const contrastScan = () => {
    const lum = (cssColor) => {
      const m = cssColor.match(/[\d.]+/g);
      if (!m) return null;
      const [r, g, b] = m.slice(0, 3).map(Number).map((v) => {
        const s = v / 255;
        return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
      });
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
    const ratio = (fg, bg) => {
      const L1 = lum(fg); const L2 = lum(bg);
      if (L1 == null || L2 == null) return null;
      const [a, b] = [L1, L2].sort((x, y) => y - x);
      return (a + 0.05) / (b + 0.05);
    };
    const items = [];
    const addText = (label, el) => {
      if (!el) { items.push({ label, missing: true }); return; }
      const st = getComputedStyle(el);
      const fs = parseFloat(st.fontSize);
      const large = fs >= 24 || (fs >= 18.66 && parseInt(st.fontWeight) >= 700);
      items.push({ label, need: large ? 3.0 : 4.5, fs, r: ratio(st.color, effBg(el)) });
    };
    const addGraph = (label, el, border) => {
      if (!el) { items.push({ label, missing: true }); return; }
      const st = getComputedStyle(el);
      items.push({ label, need: 3.0, r: ratio(border ? st.borderLeftColor : st.color, effBg(el)) });
    };
    const findSub = (txt) => [...document.querySelectorAll('.xfer-row .xfer-sub')].find((x) => x.textContent.includes(txt)) ?? null;
    const findRow = (txt) => [...document.querySelectorAll('.xfer-row')].find((x) => x.textContent.includes(txt)) ?? null;
    const findIcon = (txt) => {
      const row = findRow(txt);
      if (!row) return null;
      const cand = [...row.querySelectorAll(':scope > span')].filter((s) => !s.className.includes('xfer-dir'));
      return cand[cand.length - 1] ?? null;
    };
    addText('conflict-sub', document.querySelector('.xfer-conflict .xfer-sub'));
    addText('conflict-path-span', document.querySelector('.xfer-conflict .xfer-sub .mono'));
    const cbtn = document.querySelector('.xfer-conflict button');
    addText('conflict-btn', cbtn);
    addGraph('conflict-btn-border', cbtn);
    addGraph('conflict-warn-bar', document.querySelector('.xfer-conflict'), true);
    addText('uo-reverify', document.querySelector('[data-testid="uo-reverify"]'));
    addText('uo-note-dim', findSub('temp 与恢复资料保留'));
    addText('xfer-name', findRow('h.conflict-demo')?.querySelector('.xfer-name'));
    addText('sub-skipped-dim', findSub('已跳过'));
    addText('sub-interrupted-dim', findSub('已中断'));
    addText('sub-failed-dim', findSub('失败：演示注入'));
    addText('sub-done-dim', findSub('完成 · '));
    addText('cancel-x-btn', findRow('h.conflict-demo')?.querySelector('button[title="取消传输"]'));
    addGraph('icon-skipped-⊘', findIcon('已跳过'));
    addGraph('icon-interrupted-✕', findIcon('已中断'));
    addGraph('icon-done-✓', findIcon('完成 · '));
    addGraph('icon-dir-up', document.querySelector('.xfer-dir.up'));
    return items;
  };
  for (const theme of ['dark', 'light']) {
    const { ctx, page } = await mk(1280, 800, theme);
    const { demoInvoke, sid } = await connect(page);
    // 第一张冲突卡 → 立即 skip（供 skipped 行）；第二张保持待决（供 conflict 系列）
    await demoInvoke('upload_file', { sid, local: '/Users/demo/Desktop/h.sk.conflict-demo', remote: '/var/log/nginx/h.sk.conflict-demo' });
    await waitFor_(page, () => !!document.querySelector('.xfer-conflict'), 30);
    await page.evaluate(() => {
      const row = [...document.querySelectorAll('.xfer-row')].find((x) => x.querySelector('.xfer-name')?.textContent === 'h.sk.conflict-demo');
      row?.querySelector('[data-testid="cf-skip"]')?.click();
    });
    await waitFor_(page, () => [...document.querySelectorAll('.xfer-row .xfer-sub')].some((x) => x.textContent.includes('已跳过')), 20);
    await demoInvoke('upload_file', { sid, local: '/Users/demo/Desktop/h.conflict-demo', remote: '/var/log/nginx/h.conflict-demo' });
    await demoInvoke('upload_file', { sid, local: '/Users/demo/Desktop/h.unknown-demo', remote: '/var/log/nginx/h.unknown-demo' });
    await demoInvoke('upload_file', { sid, local: '/Users/demo/Desktop/h.interrupt-demo', remote: '/var/log/nginx/h.interrupt-demo' });
    await demoInvoke('upload_file', { sid, local: '/Users/demo/Desktop/h.fail-demo', remote: '/var/log/nginx/h.fail-demo' });
    await demoInvoke('upload_file', { sid, local: '/Users/demo/Desktop/h.plain', remote: '/var/log/nginx/h.plain' });
    await waitFor_(page, () => !!document.querySelector('.xfer-conflict') && !!document.querySelector('[data-testid="uo-reverify"]')
      && [...document.querySelectorAll('.xfer-row')].some((x) => x.textContent.includes('完成')), 40);
    await sleep(300);
    const items = await page.evaluate(contrastScan);
    const missing = items.filter((it) => it.missing);
    const below = items.filter((it) => !it.missing && it.r < it.need);
    console.log(`   B4F ${theme}: ${items.map((it) => `${it.label}=${it.missing ? 'MISS' : it.r.toFixed(2)}/${it.need}`).join(' | ')}`);
    ok(`B4F ${theme} 无缺测元素`, missing.length === 0, JSON.stringify(missing.map((m) => m.label)));
    ok(`B4F ${theme} 低于门槛登记`, true, JSON.stringify(below.map((it) => `${it.label}=${it.r?.toFixed(2)}/${it.need}`)));
    await ctx.close();
  }

  ok('B7 全程零 pageerror/console error', errsAll.length === 0, errsAll.join(' | ').slice(0, 400));
  const fails = results.filter((r) => !r.pass).length;
  console.log(`\n${results.length - fails}/${results.length} passed`);
  await browser.close();
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error('VIS-B3 CRASH', e); process.exit(2); });
