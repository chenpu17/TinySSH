// R27 外观/终端设置/可访问性 探针（真实 Chromium + vite demo 后端 :5183）：
// A 外观三态（§7.1/§244 解耦）：新装默认跟随系统（prefers-color-scheme 实时解析）/
//   显式深浅覆盖系统/blob chrome 域持久化/终端配色切换不动应用 chrome（旧码必红判别）/reload 双键独立还原；
// A6 字号默认 14（§7.2，旧码 13 必红）+ 增大/重置落库；
// B 弹窗 focus trap（§7.4）：设置面板/关闭确认/粘贴确认 Tab 循环不出框、Esc 关闭焦点还原触发控件（旧码必红）；
// C 标签键盘可达（§7.4）：tab 内 Tab 到关闭钮（旧码 span 不可聚焦必红）→ 连接会话出确认框 → Esc 还原；
// D 命中区 ≥28×28（§7.2）：tab-x 视觉盒外 3px 命中按钮本体（旧码 18px 盒必 miss）；
// E 可访问名称：tab aria-label（主机+状态）、搜索钮 aria-label、tablist/dialog 语义；
// Z 零 JS 错误。
// 工艺：demo 态内存态 reload 即清；invoke 走页面内 import('/src/adapter/bridge.ts')；
// 焦点断言用真实 keyboard（Trusted）+ el.focus() 定位；系统深浅用 emulateMedia。
const { chromium } = require('/Users/chenpu/node_modules/playwright');
const EXE = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const URL = 'http://localhost:5183/';
const results = [];
const ok = (name, cond, detail = '') => { results.push({ name, pass: !!cond, detail }); console.log((cond ? 'PASS ' : 'FAIL ') + name + (detail ? '  [' + detail + ']' : '')); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
setTimeout(() => { console.log(JSON.stringify(results)); console.error('PROBE-WATCHDOG'); process.exit(3); }, 300000).unref?.();

(async () => {
  const browser = await chromium.launch({ executablePath: EXE, headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, permissions: ['clipboard-read', 'clipboard-write'] });
  const page = await ctx.newPage();
  const jsErrors = [];
  page.on('pageerror', (e) => jsErrors.push(String(e)));
  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => { try { localStorage.clear(); } catch {} });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.host-card', { timeout: 10000 });
  await sleep(400); // 等偏好载入 effect 落地（get_workspace 链）

  const chromeAttr = () => page.evaluate(() => document.documentElement.dataset.chrome ?? null);
  const appearancePressed = () => page.evaluate(() => {
    const g = document.querySelector('[role="group"][aria-label="应用外观"]');
    if (!g) return null;
    const on = [...g.querySelectorAll('button')].find((b) => b.getAttribute('aria-pressed') === 'true');
    return on?.textContent ?? null;
  });
  const blobChrome = () => page.evaluate(() => {
    try { const r = localStorage.getItem('ui.v2.workspace'); return r ? JSON.parse(r).chrome : null; } catch { return 'ERR'; }
  });
  const openSettings = async () => {
    // 真实点击（trusted）——焦点落在触发钮上，Esc 还原断言才有锚（合成 .click() 不移焦点）
    await page.click('.hb-settings');
    await page.waitForSelector('.term-settings', { timeout: 4000 });
  };
  const activeIn = (sel) => page.evaluate((s) => {
    const el = document.activeElement;
    return !!el && !!document.querySelector(s) && document.querySelector(s).contains(el);
  }, sel);
  const activeIs = (sel) => page.evaluate((s) => document.activeElement === document.querySelector(s), sel);
  const waitFor_ = async (fn, tries, gap = 120) => {
    for (let i = 0; i < tries; i++) { const v = await fn(); if (v) return v; await sleep(gap); }
    return null;
  };
  const demoInvoke = (cmd, args) => page.evaluate(async ({ c, a }) => {
    const { invoke } = await import('/src/adapter/bridge.ts');
    return invoke(c, a);
  }, { c: cmd, a: args });
  const sessState = async (needle) => {
    const list = await demoInvoke('list_sessions');
    return list.find((x) => x.host_name.includes(needle))?.state ?? 'none';
  };
  const connectHost = async (needle, trusted) => {
    await page.evaluate((h) => {
      const card = [...document.querySelectorAll('.host-card')].find((c) => c.querySelector('.host-name')?.textContent.includes(h));
      card?.querySelector('.host-connect-btn')?.click();
    }, needle);
    if (!trusted) {
      await page.waitForSelector('.hk-mask', { timeout: 6000 }).catch(() => {});
      await page.evaluate(() => {
        const b = [...document.querySelectorAll('.hk-mask button')].find((x) => x.textContent.includes('信任并连接'));
        b?.click();
      });
    }
    return waitFor_(async () => {
      const list = await demoInvoke('list_sessions');
      return list.find((x) => x.host_name.includes(needle) && x.state === 'Connected')?.id ?? null;
    }, 100);
  };
  const tabByHost = (needle) => page.evaluate((h) => {
    const t = [...document.querySelectorAll('.tabbar .tab')].find((x) => x.textContent.includes(h));
    return t ? true : false;
  }, needle);
  // 键盘走到目标标签的 tab-x：focus() 不激活会话；建连后 attach 异步夺焦——
  // 每步验证 activeElement，被夺焦则重试（轮询上限内拿不到即返回 null）
  const focusTabX = async (needle) => {
    for (let i = 0; i < 8; i++) {
      await page.evaluate((h) => {
        const t = [...document.querySelectorAll('.tabbar .tab')].find((x) => x.textContent.includes(h));
        t?.focus();
      }, needle);
      await sleep(120);
      const onTab = await page.evaluate((h) => {
        const ae = document.activeElement;
        return !!ae && ae.classList?.contains('tab') && ae.textContent.includes(h);
      }, needle);
      if (!onTab) continue;
      await page.keyboard.press('Tab');
      await sleep(80);
      await page.keyboard.press('Tab');
      await sleep(80);
      const onX = await page.evaluate(() => document.activeElement?.classList?.contains('tab-x') ?? false);
      if (onX) return true;
    }
    return false;
  };

  // ================= A: 外观三态（fresh 态优先做） =================
  // Playwright 默认 colorScheme=light → system 解析为 light；载入不回写（hostbar 迁移
  // 例外：demo 分支读 localStorage 后整存 blob——chrome 域原样透传 system，不产生 dark）
  const blob0 = await blobChrome();
  ok('A0 fresh: system resolves to light chrome', (await chromeAttr()) === 'light', 'chrome=' + (await chromeAttr()));
  ok('A0b fresh: blob chrome is system (no dark fallback)', blob0 === null || blob0 === 'system', 'blob=' + String(blob0));
  await openSettings();
  ok('A1 appearance group: system active', (await appearancePressed()) === '跟随系统', 'pressed=' + (await appearancePressed()));
  ok('A1b both groups present', await page.evaluate(() =>
    !!document.querySelector('[role="group"][aria-label="应用外观"]') && !!document.querySelector('[role="group"][aria-label="终端配色"]')));
  // A6 字号默认 14（§7.2；旧码 13 必红）
  const fontVal = await page.evaluate(() => document.querySelector('.ts-val')?.textContent?.trim() ?? null);
  ok('A6 default font 14', fontVal === '14', 'val=' + fontVal);

  // A2 跟随系统实时解析：emulate dark → chrome 翻 dark（matchMedia listener）
  await page.emulateMedia({ colorScheme: 'dark' });
  await sleep(250);
  ok('A2 system follows emulated dark', (await chromeAttr()) === 'dark', 'chrome=' + (await chromeAttr()));
  await page.emulateMedia({ colorScheme: 'light' });
  await sleep(250);

  // A3 显式浅色：覆盖系统（dark 模拟下仍 light）+ blob 落库
  await page.emulateMedia({ colorScheme: 'dark' });
  await sleep(150);
  await page.evaluate(() => {
    const g = document.querySelector('[role="group"][aria-label="应用外观"]');
    [...g.querySelectorAll('button')].find((b) => b.textContent === '浅色')?.click();
  });
  await sleep(300);
  ok('A3 explicit light overrides system-dark', (await chromeAttr()) === 'light', 'chrome=' + (await chromeAttr()));
  ok('A3b blob chrome=light persisted', (await blobChrome()) === 'light', 'blob=' + String(await blobChrome()));

  // A4 解耦判别（旧码必红）：外观=深色 下切终端配色「浅色」→ 应用 chrome 不动
  await page.evaluate(() => {
    const g = document.querySelector('[role="group"][aria-label="应用外观"]');
    [...g.querySelectorAll('button')].find((b) => b.textContent === '深色')?.click();
  });
  await sleep(200);
  await page.evaluate(() => {
    const g = document.querySelector('[role="group"][aria-label="终端配色"]');
    // 钮内含色板 span（"Aa"）+ 文本 → includes 匹配（startsWith 会被前缀挡住）
    [...g.querySelectorAll('button')].find((b) => b.textContent.includes('浅色'))?.click();
  });
  await sleep(200);
  ok('A4 palette switch does not touch app chrome', (await chromeAttr()) === 'dark', 'chrome=' + (await chromeAttr()));
  ok('A4b terminal palette applied', await page.evaluate(() =>
    [...document.querySelectorAll('.ts-opt')].some((b) => b.textContent.includes('浅色') && b.classList.contains('ts-active'))));

  // B1/B2（设置面板）：Tab 循环不出框 + Esc 焦点还原触发控件
  const nFocus = await page.evaluate(() =>
    document.querySelector('.term-settings').querySelectorAll('button, input, select, textarea, [tabindex]:not([tabindex="-1"])').length);
  for (let i = 0; i < nFocus + 2; i++) await page.keyboard.press('Tab');
  ok('B1 settings trap: Tab cycles inside', await activeIn('.term-settings'));
  ok('B2a dialog semantics (settings)', await page.evaluate(() => {
    const d = document.querySelector('.term-settings');
    return d.getAttribute('role') === 'dialog' && d.getAttribute('aria-modal') === 'true';
  }));
  await page.keyboard.press('Escape');
  await sleep(250);
  ok('B2 settings Esc restores opener focus', await activeIs('.hb-settings'), await page.evaluate(() => document.activeElement?.className ?? 'none'));

  // A5 reload 双键独立还原：外观=深色（blob）+ 终端配色=浅色（ui.theme）
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.host-card', { timeout: 10000 });
  await sleep(500);
  await openSettings();
  ok('A5 appearance restored dark after reload', (await appearancePressed()) === '深色' && (await chromeAttr()) === 'dark',
    'pressed=' + (await appearancePressed()) + ' chrome=' + (await chromeAttr()));
  ok('A5b terminal palette restored light', await page.evaluate(() =>
    [...document.querySelectorAll('.ts-opt')].some((b) => b.textContent.includes('浅色') && b.classList.contains('ts-active'))));

  // A6b 字号增大/重置（持久化）
  await page.evaluate(() => [...document.querySelectorAll('.term-settings button')].find((b) => b.getAttribute('aria-label') === '增大字号')?.click());
  await sleep(150);
  const fontUp = await page.evaluate(() => document.querySelector('.ts-val')?.textContent?.trim());
  const fontKey = await page.evaluate(() => localStorage.getItem('ui.v2.terminal.font_size'));
  ok('A6b font +1 → 15 persisted', fontUp === '15' && fontKey === '15', `val=${fontUp} key=${fontKey}`);
  await page.evaluate(() => [...document.querySelectorAll('.term-settings button')].find((b) => b.textContent === '重置')?.click());
  await sleep(100);
  await page.keyboard.press('Escape');
  await sleep(200);

  // ================= C/B3: 标签键盘可达 + 关闭确认 trap =================
  const sidP = await connectHost('prod-1', true);
  ok('C0a connect prod-1', !!sidP, await sessState('prod-1'));
  const sidN = await connectHost('noint-1', false);
  ok('C0b connect noint-1', !!sidN, await sessState('noint-1'));

  // E1 tab 可访问名称 + tablist 语义
  ok('E1 tablist role', await page.evaluate(() => document.querySelector('.tabbar')?.getAttribute('role') === 'tablist'));
  const tabA11y = await page.evaluate(() => {
    const tabs = [...document.querySelectorAll('.tabbar .tab')];
    return tabs.map((t) => ({ label: t.getAttribute('aria-label') ?? '', selected: t.getAttribute('aria-selected') }));
  });
  ok('E1b tab aria-label host+state', tabA11y.length >= 2 && tabA11y.every((t) => t.label.includes('，') && t.label.length > 3),
    JSON.stringify(tabA11y));
  ok('E1c exactly one aria-selected', tabA11y.filter((t) => t.selected === 'true').length === 1);

  // C1 键盘到 noint 标签关闭钮（focus() 不激活会话）→ Enter → 连接会话出确认框
  const c1reach = await focusTabX('noint-1');
  ok('C1a tab-x keyboard reachable', !!c1reach,
    'active=' + await page.evaluate(() => document.activeElement?.className ?? 'none'));
  await page.keyboard.press('Enter');
  const confirmUp = await page.waitForSelector('.confirm-dialog', { timeout: 4000 }).catch(() => null);
  ok('C1b connected session → close confirm', !!confirmUp);
  // rev-r27 中-1 判别：初始焦点=取消钮（旧实现 trap 落 DOM 首位=「关闭会话」danger 钮，
  // 弹窗一开即预武装——纯键盘一次 Enter 即断开；rev-r27 初审在处置前实证 activeElement=danger）
  ok('C1b2 initial focus on cancel (no danger prearm)', await page.evaluate(() => {
    const ae = document.activeElement;
    return !!ae && ae.tagName === 'BUTTON' && ae.textContent === '取消' && !!ae.closest('.confirm-dialog');
  }), 'active=' + await page.evaluate(() => document.activeElement?.textContent ?? 'none'));
  ok('B3a dialog semantics (confirm)', await page.evaluate(() => {
    const d = document.querySelector('.confirm-dialog');
    return d?.getAttribute('role') === 'dialog' && d.getAttribute('aria-modal') === 'true';
  }));
  // B3b Tab 循环不出框
  for (let i = 0; i < 5; i++) await page.keyboard.press('Tab');
  ok('B3b confirm trap: Tab cycles inside', await activeIn('.confirm-dialog'));
  // B3c Esc 关闭 → 焦点还原到 noint tab-x
  await page.keyboard.press('Escape');
  await sleep(250);
  ok('B3c confirm Esc restores tab-x focus', await page.evaluate(() => {
    const ae = document.activeElement;
    return !!ae && ae.classList?.contains('tab-x') && ae.closest('.tab')?.textContent.includes('noint-1');
  }), 'active=' + await page.evaluate(() => document.activeElement?.className ?? 'none'));

  // ================= D: 命中区 ≥28×28 + 断开标签键盘直关 =================
  // D1 键盘直关已断开标签（无确认）：drop prod-1 → Disconnected → 焦点其 tab-x → Enter
  await demoInvoke('demo_drop_session', { sid: sidP, recoverOnAttempt: 0 });
  const deadWait = await waitFor_(async () => (await sessState('prod-1')) === 'Disconnected', 60);
  ok('D0 prod-1 disconnected', !!deadWait);
  const d1reach = await focusTabX('prod-1');
  await page.keyboard.press('Enter');
  await sleep(600);
  const confirmD = await page.evaluate(() => !!document.querySelector('.confirm-dialog'));
  // 断言按 sid 定界（种子库自带一个 prod-1 会话——按主机名会命中种子）：
  // 本探针建的 sidP 从 list_sessions 消失 + prod-1 标签数 2→1
  const prodTabsAfter = await page.evaluate(() =>
    [...document.querySelectorAll('.tabbar .tab')].filter((x) => x.textContent.includes('prod-1')).length);
  ok('D1 dead tab keyboard close: no confirm, removed', !confirmD && prodTabsAfter === 1,
    `confirm=${confirmD} prodTabs=${prodTabsAfter}(seed+ours=2) reach=${d1reach}`);
  const listD = await demoInvoke('list_sessions');
  ok('D1b session removed by sid', !listD.some((x) => x.id === sidP));

  // D2 命中区判别：tab-x 视觉盒右缘外 3px 仍命中按钮本体（::after 扩展；旧码 18px 盒该点=父 tab 必红）
  const hit = await page.evaluate(() => {
    const btn = document.querySelector('.tabbar .tab .tab-x');
    const r = btn.getBoundingClientRect();
    const el = document.elementFromPoint(r.right + 3, r.top + r.height / 2);
    return { hit: el === btn, tag: el?.className ?? String(el) };
  });
  ok('D2 hit area extends beyond visual box', hit.hit, 'at-point=' + hit.tag);

  // ================= B4: 粘贴确认 trap（⌘V 多行 → 对话框 → Esc 还原） =================
  await page.evaluate(() => navigator.clipboard.writeText('l1\nl2'));
  let termFocused = false;
  for (let i = 0; i < 6 && !termFocused; i++) {
    await page.evaluate(() => document.querySelector('.term-session.active textarea')?.focus());
    await sleep(150);
    termFocused = await page.evaluate(() => document.activeElement?.classList?.contains('xterm-helper-textarea') ?? false);
  }
  ok('B4-pre terminal textarea focused', termFocused);
  await page.keyboard.press('Meta+V');
  const pasteUp = await page.waitForSelector('.paste-dialog', { timeout: 4000 }).catch(() => null);
  ok('B4a paste confirm via ⌘V multi-line', !!pasteUp);
  if (pasteUp) {
    ok('B4a2 paste initial focus on cancel', await page.evaluate(() => {
      const ae = document.activeElement;
      return !!ae && ae.textContent === '取消' && !!ae.closest('.paste-dialog');
    }), 'active=' + await page.evaluate(() => document.activeElement?.textContent ?? 'none'));
    ok('B4b dialog semantics (paste)', await page.evaluate(() => {
      const d = document.querySelector('.paste-dialog');
      return d?.getAttribute('role') === 'dialog' && d.getAttribute('aria-modal') === 'true';
    }));
    for (let i = 0; i < 5; i++) await page.keyboard.press('Tab');
    ok('B4c paste trap: Tab cycles inside', await activeIn('.paste-dialog'));
    await page.keyboard.press('Escape');
    await sleep(250);
    ok('B4d paste Esc restores terminal focus', await page.evaluate(() =>
      !!document.activeElement?.classList?.contains('xterm-helper-textarea')),
      'active=' + await page.evaluate(() => document.activeElement?.className ?? 'none'));
  }

  // ================= E2: 搜索钮可访问名称（⌘F 开搜索） =================
  await page.evaluate(() => document.dispatchEvent(
    new KeyboardEvent('keydown', { key: 'f', metaKey: true, bubbles: true, cancelable: true })));
  const searchUp = await page.waitForSelector('.term-search', { timeout: 3000 }).catch(() => null);
  if (searchUp) {
    const labels = await page.evaluate(() =>
      [...document.querySelectorAll('.term-search button')].map((b) => b.getAttribute('aria-label') ?? ''));
    ok('E2 search buttons have aria-labels', labels.length >= 3 && labels.every((l) => l.length > 0), JSON.stringify(labels));
    await page.keyboard.press('Escape');
  } else {
    ok('E2 search buttons have aria-labels', false, 'search did not open (Cmd+F synthetic)');
  }

  // ================= Z: 零 JS 错误 =================
  ok('Z0 zero js errors', jsErrors.length === 0, jsErrors.join('||').slice(0, 200));

  console.log('SUMMARY ' + results.filter((r) => r.pass).length + '/' + results.length);
  await browser.close();
})();
