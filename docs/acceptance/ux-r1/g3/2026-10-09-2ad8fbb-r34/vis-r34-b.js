// vis-r34 探针 B（独立方法学，作者未覆盖面）：
// B1 盒测量矩阵 1280/640/360 × dark/light：冲突卡/unknown 卡/终态行
//    视口内、面板内、零溢出、命中≥24、零叠印、截断检测、360 tp-full 断言
// B2 键盘：Tab 可达三决策钮（序 skip→overwrite→keepboth）、焦点环可见、Enter 触发、
//    焦点不陷卡、✕ 取消钮可达、uo-reverify Enter
// B3 缩放 1.25/1.5：盒测量重跑 + 截图（px 布局根字号无效——用 zoom 近似浏览器缩放，登记方法学）
// B4 逐元素对比度双主题：文字 4.5 / 图形 3.0，有效背景沿祖先链解析
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
  const seedCards = async (demoInvoke, sid) => {
    const mkUp = (local, remote) => demoInvoke('upload_file', { sid, local, remote });
    await mkUp(`/Users/demo/Desktop/b.conflict-demo`, '/var/log/nginx/b.conflict-demo');
    await mkUp(`/Users/demo/Desktop/b.unknown-demo`, '/var/log/nginx/b.unknown-demo');
    await mkUp(`/Users/demo/Desktop/b.interrupt-demo`, '/var/log/nginx/b.interrupt-demo');
    await mkUp(`/Users/demo/Desktop/b.fail-demo`, '/var/log/nginx/b.fail-demo');
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
    const rowOf = (sel) => document.querySelector(sel)?.closest('.xfer-row');
    const block = document.querySelector('.xfer-conflict');
    const rowC = rowOf('.xfer-conflict');
    const btns = block ? [...block.querySelectorAll('button')] : [];
    const uo = document.querySelector('[data-testid="uo-reverify"]');
    const rowU = uo?.closest('.xfer-row');
    const rowInt = [...document.querySelectorAll('.xfer-row')].find((x) => x.textContent.includes('已中断'));
    const rowFail = [...document.querySelectorAll('.xfer-row')].find((x) => x.textContent.includes('失败：演示注入'));
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
    const clipV = sub ? { sh: sub.scrollHeight, ch: sub.clientHeight } : null;
    const nameEl = rowC?.querySelector('.xfer-name');
    const nameEll = nameEl ? { scrollW: nameEl.scrollWidth, clientW: nameEl.clientWidth, hasTitle: !!nameEl.getAttribute('title') } : null;
    const uoNote = rowU ? [...rowU.querySelectorAll('.xfer-sub')].find((x) => x.textContent.includes('temp 与恢复资料保留')) : null;
    const uoNoteM = uoNote ? rB(uoNote) : null;
    return {
      tpFull: panel?.classList.contains('tp-full') ?? false,
      panelW: panelBox ? Math.round(panelBox.width) : null,
      blockIn: block && panelBox ? inBox(rB(block), panelBox) && inBox(rB(block), { left: 0, top: 0, right: vw, bottom: vh }) : false,
      btnsN: btns.length,
      btnsIn: btns.every((b) => inBox(rB(b), panelBox ?? { left: 0, top: 0, right: vw, bottom: vh })) && btns.every((b) => inBox(rB(b), { left: 0, top: 0, right: vw, bottom: vh })),
      btnsHit: btns.every(hitOk),
      btnOv,
      uoIn: uo && panelBox ? inBox(rB(uo), panelBox) && inBox(rB(uo), { left: 0, top: 0, right: vw, bottom: vh }) : false,
      uoHit: uo ? hitOk(uo) : false,
      blockUoOv: overlap(rB(block), rB(uo)),
      uoNoteClip: uoNoteM ? uoNoteM.r > vw + 1 || uoNoteM.b < 0 : null,
      rowsIn: [rowInt, rowFail].every((x) => x && panelBox ? inBox(rB(x), panelBox) : false),
      secOvf: sec ? sec.scrollWidth > sec.clientWidth + 1 : true,
      docOvf: document.documentElement.scrollWidth > document.documentElement.clientWidth,
      conflictSubClip: clipV ? clipV.sh > clipV.ch + 2 : null,
      nameEll,
      btnSizes: btnBoxes.map((b) => `${Math.round(b.w)}x${Math.round(b.h)}`),
    };
  };

  // ---- B1 盒测量矩阵 ----
  for (const w of [1280, 640, 360]) {
    for (const theme of ['dark', 'light']) {
      const { ctx, page } = await mk(w, w === 360 ? 740 : 800, theme);
      const { demoInvoke, sid } = await connect(page);
      await seedCards(demoInvoke, sid);
      const ready = await waitFor_(page, () => !!document.querySelector('.xfer-conflict')
        && !!document.querySelector('[data-testid="uo-reverify"]')
        && [...document.querySelectorAll('.xfer-row')].some((x) => x.textContent.includes('已中断'))
        && [...document.querySelectorAll('.xfer-row')].some((x) => x.textContent.includes('失败：演示注入')), 30);
      if (!ready) { ok(`B1 ${w}/${theme} cards ready`, false, 'timeout'); await ctx.close(); continue; }
      await sleep(300);
      await page.evaluate(() => {
        const tp = document.querySelector('.task-panel');
        tp?.scrollTo(0, 0);
      });
      const m = await page.evaluate(measure);
      const allOk = m.blockIn && m.btnsN === 3 && m.btnsIn && m.btnsHit && !m.btnOv && m.uoIn && m.uoHit
        && !m.blockUoOv && !m.secOvf && !m.docOvf && m.rowsIn && m.conflictSubClip === false;
      ok(`B1 ${w}/${theme} 冲突卡+unknown+终态 盒测量`, allOk, JSON.stringify(m));
      const tpExpect = w === 360 ? true : false;
      ok(`B1 ${w}/${theme} tp-full 断言(${w===360?'应为全宽':'应为侧栏'})`, m.tpFull === tpExpect, `tpFull=${m.tpFull} panelW=${m.panelW}`);
      await page.screenshot({ path: `${OUT}/b-cards-${w}-${theme}.png` });
      await ctx.close();
    }
  }

  // ---- B2 键盘可达性（1280 dark）----
  {
    const { ctx, page } = await mk(1280, 800, 'dark');
    const { demoInvoke, sid } = await connect(page);
    await demoInvoke('upload_file', { sid, local: '/Users/demo/Desktop/k.conflict-demo', remote: '/var/log/nginx/k.conflict-demo' });
    await demoInvoke('upload_file', { sid, local: '/Users/demo/Desktop/k.unknown-demo', remote: '/var/log/nginx/k.unknown-demo' });
    await waitFor_(page, () => !!document.querySelector('.xfer-conflict') && !!document.querySelector('[data-testid="uo-reverify"]'), 30);
    await sleep(300);
    // 从文档起点连 Tab，记录 focus 轨迹直到 keepboth
    const trail = await page.evaluate(async () => {
      const seq = [];
      const tids = ['cf-skip', 'cf-overwrite', 'cf-keepboth', 'uo-reverify'];
      const target = (el) => el?.getAttribute('data-testid') ?? (el?.tagName ?? '') + (el?.getAttribute('title') ? `[${el.getAttribute('title')}]` : '');
      document.body.focus();
      for (let i = 0; i < 120; i++) {
        const ev = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true });
        document.activeElement?.dispatchEvent(ev);
        // 真实 Tab 由浏览器处理——playwright 键盘走 page.keyboard，这里用 forward 不可行，改标记退出
        break;
      }
      return seq;
    });
    // Tab 序列用 playwright 键盘真实驱动
    const seq = [];
    let found = { skip: -1, over: -1, keep: -1, uo: -1, cancelBtn: -1 };
    for (let i = 0; i < 120; i++) {
      await page.keyboard.press('Tab');
      const cur = await page.evaluate(() => {
        const el = document.activeElement;
        return { tid: el?.getAttribute?.('data-testid') ?? null, title: el?.getAttribute?.('title') ?? null, tag: el?.tagName ?? '' };
      });
      seq.push(cur.tid ?? cur.title ?? cur.tag);
      if (cur.tid === 'cf-skip' && found.skip < 0) found.skip = i;
      if (cur.tid === 'cf-overwrite') found.over = i;
      if (cur.tid === 'cf-keepboth') found.keep = i;
      if (cur.tid === 'uo-reverify') found.uo = i;
      if (cur.title === '取消传输') found.cancelBtn = i;
      if (found.skip >= 0 && found.over >= 0 && found.keep >= 0 && found.uo >= 0 && found.cancelBtn >= 0) break;
      if (i > 60 && found.skip >= 0 && found.keep >= 0) break;
    }
    ok('B2.1 Tab 可达三决策钮且顺序 skip→overwrite→keepboth',
      found.skip >= 0 && found.over === found.skip + 1 && found.keep === found.skip + 2, JSON.stringify({ found, seq: seq.slice(0, 30) }));
    // 焦点环：focus cf-skip 上断言 outline/box-shadow
    const ring = await page.evaluate(() => {
      const el = document.querySelector('[data-testid="cf-skip"]');
      el?.focus();
      const st = getComputedStyle(el);
      return {
        focused: document.activeElement === el,
        outlineW: st.outlineStyle !== 'none' ? st.outlineWidth : '0',
        outlineColor: st.outlineColor,
        shadow: st.boxShadow !== 'none' ? st.boxShadow.slice(0, 80) : '',
      };
    });
    const ringVisible = ring.focused && (parseFloat(ring.outlineW) > 0 || ring.shadow.length > 4);
    ok('B2.2 cf-skip 键盘焦点环可见', ringVisible, JSON.stringify(ring));
    await page.evaluate(() => { [...document.querySelectorAll('.xfer-conflict button')].find((b) => b.dataset.testid === 'cf-skip')?.focus(); });
    await page.screenshot({ path: `${OUT}/b-focus-ring.png` });
    // Enter 触发 skip → skipped
    await page.evaluate(() => document.querySelector('[data-testid="cf-skip"]')?.focus());
    await page.keyboard.press('Enter');
    const skippedAfterEnter = await waitFor_(page, () => [...document.querySelectorAll('.xfer-row .xfer-sub')].some((x) => x.textContent.includes('已跳过')), 20);
    ok('B2.3 Enter 在 cf-skip 触发跳过', !!skippedAfterEnter);
    // 覆盖钮 title 能力注记（键盘/读屏可达的注记属性在）
    const owTitle = await page.evaluate(() => document.querySelector('[data-testid="cf-overwrite"]')?.getAttribute('title') ?? '');
    ok('B2.4 cf-overwrite title 能力注记存在', owTitle.includes('覆盖发布将被阻止') && owTitle.includes('原文件零改动'), owTitle);
    // uo-reverify Enter 触发（demo 重核=刷新保持 unknown，断言无异常且卡仍在）
    await page.evaluate(() => document.querySelector('[data-testid="uo-reverify"]')?.focus());
    await page.keyboard.press('Enter');
    await sleep(500);
    const uoStill = await page.evaluate(() => !!document.querySelector('[data-testid="uo-reverify"]'));
    ok('B2.5 Enter 在 uo-reverify 触发（重核后卡保持）', uoStill);
    // 焦点不陷卡：keepboth Tab 后能离开冲突卡（到达后续元素）
    await page.evaluate(() => {
      const row = [...document.querySelectorAll('.xfer-row')].find((x) => x.querySelector('.xfer-conflict'));
      row?.querySelector('[data-testid="cf-keepboth"]')?.focus();
    });
    await page.keyboard.press('Tab');
    const afterKeep = await page.evaluate(() => {
      const el = document.activeElement;
      const inCard = !!el?.closest?.('.xfer-conflict');
      return { tag: el?.tagName, inCard, tid: el?.getAttribute?.('data-testid') ?? null };
    });
    ok('B2.6 焦点可离开冲突卡（非陷阱）', !afterKeep.inCard, JSON.stringify(afterKeep));
    // ✕ 取消钮 Tab 可达已在 found.cancelBtn 记录
    ok('B2.7 待决/运行卡 ✕ 取消钮 Tab 可达', found.cancelBtn >= 0, `idx=${found.cancelBtn}`);
    await page.screenshot({ path: `${OUT}/b-keyboard-1280-dark.png` });
    await ctx.close();
  }

  // ---- B3 缩放 1.25/1.5（1280 dark）----
  for (const zoom of [1.25, 1.5]) {
    const { ctx, page } = await mk(1280, 800, 'dark');
    const { demoInvoke, sid } = await connect(page);
    await seedCards(demoInvoke, sid);
    await waitFor_(page, () => !!document.querySelector('.xfer-conflict') && !!document.querySelector('[data-testid="uo-reverify"]'), 30);
    await sleep(300);
    await page.evaluate((z) => { document.documentElement.style.zoom = String(z); }, zoom);
    await sleep(400);
    const m = await page.evaluate(measure);
    const allOk = m.blockIn && m.btnsN === 3 && m.btnsIn && m.btnsHit && !m.btnOv && m.uoIn && m.uoHit
      && !m.blockUoOv && !m.secOvf && !m.docOvf && m.conflictSubClip === false;
    ok(`B3 zoom=${zoom} 盒测量`, allOk, JSON.stringify(m));
    await page.screenshot({ path: `${OUT}/b-zoom-${zoom}.png` });
    await page.evaluate(() => { document.documentElement.style.zoom = ''; });
    await ctx.close();
  }

  // ---- B4 逐元素对比度（1280 双主题）----
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
      const [l1, l2] = [lum(fg), lum(bg)].sort((a, b) => b - a);
      return (l1 + 0.05) / (l2 + 0.05);
    };
    const pick = (sel, filter) => {
      let el = sel === '@sub' ? document.querySelector('.xfer-conflict .xfer-sub') : document.querySelector(sel);
      if (filter && el) el = [...document.querySelectorAll(sel)].find(filter) ?? el;
      return el;
    };
    const items = [];
    const addText = (label, el) => {
      if (!el) { items.push({ label, missing: true }); return; }
      const st = getComputedStyle(el);
      const fs = parseFloat(st.fontSize);
      const bold = parseInt(st.fontWeight) >= 700;
      const large = fs >= 24 || (fs >= 18.66 && bold);
      items.push({ label, kind: 'text', need: large ? 3.0 : 4.5, fs, fw: st.fontWeight, r: ratio(st.color, effBg(el)), fg: st.color, bg: effBg(el) });
    };
    const addGraph = (label, el, useBorder) => {
      if (!el) { items.push({ label, missing: true }); return; }
      const st = getComputedStyle(el);
      const c = useBorder ? st.borderLeftColor : st.color;
      items.push({ label, kind: 'graph', need: 3.0, r: ratio(c, effBg(el)), fg: c, bg: effBg(el) });
    };
    addText('conflict-sub(冲突块说明)', document.querySelector('.xfer-conflict .xfer-sub'));
    addText('conflict-path(块内路径 span)', document.querySelector('.xfer-conflict .xfer-sub .mono'));
    const cbtn = document.querySelector('.xfer-conflict button');
    addText('conflict-btn(决策钮文字)', cbtn);
    addGraph('conflict-btn-border(钮边框)', cbtn);
    addGraph('conflict-border-left(warn 竖线)', document.querySelector('.xfer-conflict'), true);
    addText('uo-reverify(重核钮文字)', document.querySelector('[data-testid="uo-reverify"]'));
    addText('uo-note(保留说明 dim)', [...document.querySelectorAll('.xfer-row .xfer-sub')].find((x) => x.textContent.includes('temp 与恢复资料保留')));
    addText('xfer-name(卡名)', rowOfName('b.conflict-demo', '.xfer-name'));
    addText('sub-skipped(已跳过 dim)', findSub('已跳过'));
    addText('sub-interrupted(已中断 dim)', findSub('已中断'));
    addText('sub-failed(失败 dim)', findSub('失败：演示注入'));
    addText('cancel-btn(✕ 取消钮)', rowOfName('b.conflict-demo', 'button[title="取消传输"]'));
    addGraph('icon-skipped(⊘ dim)', findIcon('已跳过'));
    addGraph('icon-interrupted(✕ err)', findIcon('已中断'));
    addGraph('icon-done(✓ ok)', [...document.querySelectorAll('.xfer-row')].filter((x) => x.textContent.includes('完成'))[0] ? [...[...document.querySelectorAll('.xfer-row')].find((x) => x.textContent.includes('完成')).querySelectorAll(':scope > span')].filter((s) => !s.className.includes('xfer-dir')).pop() : null);
    addGraph('icon-dir-up(↑ ok)', document.querySelector('.xfer-dir.up'));
    function rowOfName(name, sel) {
      const row = [...document.querySelectorAll('.xfer-row')].find((x) => x.querySelector('.xfer-name')?.textContent === name);
      return row?.querySelector(sel) ?? null;
    }
    function findSub(txt) { return [...document.querySelectorAll('.xfer-row .xfer-sub')].find((x) => x.textContent.includes(txt)) ?? null; }
    function findIcon(txt) {
      const row = [...document.querySelectorAll('.xfer-row')].find((x) => x.textContent.includes(txt));
      if (!row) return null;
      const cand = [...row.querySelectorAll(':scope > span')].filter((s) => !s.className.includes('xfer-dir'));
      return cand[cand.length - 1] ?? null;
    }
    return items;
  };
  for (const theme of ['dark', 'light']) {
    const { ctx, page } = await mk(1280, 800, theme);
    const { demoInvoke, sid } = await connect(page);
    await seedCards(demoInvoke, sid);
    await waitFor_(page, () => !!document.querySelector('.xfer-conflict') && !!document.querySelector('[data-testid="uo-reverify"]'), 30);
    // 等 done 行出现（图标 ✓ 用）
    await waitFor_(page, () => [...document.querySelectorAll('.xfer-row .xfer-sub')].some((x) => x.textContent.includes('完成')), 40);
    await sleep(300);
    const items = await page.evaluate(contrastScan);
    const fails = items.filter((it) => it.missing || it.r < it.need);
    ok(`B4 ${theme} 全要素对比度`, fails.length === 0, JSON.stringify({ fails, all: items.map((it) => `${it.label}=${it.r ? it.r.toFixed(2) : 'NA'}/${it.need}${it.missing ? ' MISSING' : ''}`) }));
    console.log(`   B4 ${theme} 明细: ${items.map((it) => `${it.label}=${it.r ? it.r.toFixed(2) : 'NA'}(需${it.need})`).join(' | ')}`);
    await ctx.close();
  }

  ok('B5 全程零 pageerror/console error', errsAll.length === 0, errsAll.join(' | ').slice(0, 400));
  const fails = results.filter((r) => !r.pass).length;
  console.log(`\n${results.length - fails}/${results.length} passed`);
  await browser.close();
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error('VIS-B CRASH', e); process.exit(2); });
