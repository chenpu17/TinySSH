// R20 主机栏/欢迎页 demo 探针（真实 Chromium + vite demo 后端，:5183）：
// A 多字段搜索（地址/名称缩写命中）；
// B 标签：bridge.invoke upsert tags → 卡片徽章 + 筛选 chip + chip 过滤；
// C 收藏：星标切换 → 「收藏/其他主机」分组（契约 §4.2）→ 取消回落「全部主机」；
// E 欢迎页（A01）：入口纯净（添加/导入/本地终端），无 MCP 空卡——必须在建会话前断言；
// F 20 主机场景（A02）：26 卡渲染 + 过滤响应 <50ms（页面内 rAF 计时）+ 长中文名/IPv6 不破版；
// G recents invoke 契约（排除 local / 上限 5 / 倒序）——必须在任何建会话前断言；
// D 键盘焦点（A02，最后执行）：Tab 可达主机卡（focus-visible）+ Enter 触发连接——会建会话，放最后防污染；
// Z 零 JS 错误。
// 注意（r15 已登记的 HMR ?t= 双实例坑，本轮实证）：页面动态 import('/src/demo.ts')
// 与应用模块图中的 demo（带 ?t= 戳）是两个实例——后端播种一律走
// import('/src/adapter/bridge.ts') 的 invoke（与应用同图同戳）。
// 登记：welcome-recents 块（§259 会话清空态）在 demo 不可达——demo 死会话标签
// 永驻（r14 双端语义分离在案），sessions.length===0 不可达；原生 r24a 冒烟未驱动
// 该面（登记落空即行更正），断言归 R23 前置清单随下一次原生冒烟补齐。
// rev-r20 处置增补：D4-D6 键盘冒泡守卫（H1）、D7 幽灵标签死态恢复（M1）。
const { chromium } = require('/Users/chenpu/node_modules/playwright');
const EXE = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const URL = 'http://localhost:5183/';
const results = [];
const ok = (name, cond, detail = '') => { results.push({ name, pass: !!cond, detail }); console.log((cond ? 'PASS ' : 'FAIL ') + name + (detail ? '  [' + detail + ']' : '')); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
setTimeout(() => { console.log(JSON.stringify(results)); console.error('PROBE-WATCHDOG'); process.exit(3); }, 150000).unref?.();

(async () => {
  const browser = await chromium.launch({ executablePath: EXE, headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const jsErrors = [];
  page.on('pageerror', (e) => jsErrors.push(String(e)));
  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => { try { localStorage.clear(); } catch {} });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.host-card', { timeout: 10000 });

  const visibleNames = () => page.$$eval('.host-card .host-name', (els) => els.map((e) => e.textContent.trim()));
  const setSearch = async (q) => {
    await page.$eval('.hb-search input', (el, v) => {
      const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      set.call(el, v);
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }, q);
  };

  // ---- A 多字段搜索 ----
  await setSearch('10.0.0.11');
  await page.waitForFunction(() => document.querySelectorAll('.host-card').length === 1, null, { timeout: 4000 }).catch(() => {});
  ok('A1 地址命中 10.0.0.11 → prod-1', JSON.stringify(await visibleNames()) === JSON.stringify(['prod-1']), JSON.stringify(await visibleNames()));
  await setSearch('otp');
  await page.waitForFunction(() => document.querySelectorAll('.host-card').length === 1, null, { timeout: 4000 }).catch(() => {});
  ok('A2 名称片段命中 otp-1', (await visibleNames())[0]?.startsWith('otp-1'), JSON.stringify(await visibleNames()));
  await setSearch('不存在的xyz');
  await page.waitForFunction(() => document.querySelector('.section .dim')?.textContent.includes('无匹配'), null, { timeout: 4000 }).catch(() => {});
  ok('A3 无结果保留查询且有添加入口', !!(await page.$('.section .dim')) && !!(await page.$('.section button.ghost')), 'no-match empty state');
  await setSearch('');

  // ---- B 标签 ----
  await page.evaluate(async () => {
    const bridge = await import('/src/adapter/bridge.ts');
    await bridge.invoke('upsert_host', { host: { id: null, name: 'r20-web', address: '10.0.0.50', port: 22, username: 'ops', auth: { Password: { password: 'x' } }, tags: ['生产', '成都'], charset: 'utf-8' } });
  });
  await page.waitForFunction(() => [...document.querySelectorAll('.host-card .host-name')].some((e) => e.textContent.trim() === 'r20-web'), null, { timeout: 8000 }).catch(() => {});
  const webCard = await page.$('.host-card:has(.host-name:text-is("r20-web"))');
  ok('B1 upsert tags 主机卡出现', !!webCard);
  const badges = webCard ? await webCard.$$eval('.host-tag', (els) => els.map((e) => e.textContent.trim())) : [];
  ok('B2 卡片标签徽章 生产/成都', JSON.stringify(badges) === JSON.stringify(['生产', '成都']), JSON.stringify(badges));
  await page.waitForSelector('.hb-tag', { timeout: 6000 }).catch(() => {});
  const chips = await page.$$eval('.hb-tag', (els) => els.map((e) => e.textContent.trim()));
  ok('B3 标签筛选 chip 出现', chips.includes('生产') && chips.includes('成都'), JSON.stringify(chips));
  await page.$eval('.hb-tag:text-is("生产")', (el) => el.click());
  await page.waitForFunction(() => document.querySelectorAll('.host-card').length === 1, null, { timeout: 4000 }).catch(() => {});
  ok('B4 chip 过滤只留 r20-web', JSON.stringify(await visibleNames()) === JSON.stringify(['r20-web']), JSON.stringify(await visibleNames()));
  await page.$eval('.hb-tag.on', (el) => el.click());
  await sleep(150);
  ok('B5 再点 chip 取消过滤', (await visibleNames()).length >= 6, String((await visibleNames()).length));

  // ---- C 收藏 ----
  const favCard = await page.$('.host-card:has(.host-name:text-is("prod-2（演示连接失败）"))');
  ok('C0 prod-2 卡在位', !!favCard);
  if (favCard) {
    await favCard.hover();
    await favCard.$eval('.fav-btn', (el) => el.click());
    await page.waitForFunction(() => [...document.querySelectorAll('.section h4')].some((h) => h.textContent === '收藏'), null, { timeout: 4000 }).catch(() => {});
    const heads = await page.$$eval('.section h4', (els) => els.map((e) => e.textContent));
    ok('C1 收藏分组出现（收藏+其他主机）', JSON.stringify(heads) === JSON.stringify(['收藏', '其他主机']), JSON.stringify(heads));
    const firstSection = await page.$('.section');
    const favNames2 = firstSection ? await firstSection.$$eval('.host-card .host-name', (els) => els.map((e) => e.textContent.trim())) : [];
    ok('C2 收藏组含 prod-2', favNames2.includes('prod-2（演示连接失败）'), JSON.stringify(favNames2));
    const pressed = firstSection ? await firstSection.$$eval('.fav-btn', (els) => els.map((e) => e.getAttribute('aria-pressed'))) : [];
    ok('C3 星标 aria-pressed=true', (pressed ?? []).includes('true'), JSON.stringify(pressed));
    await firstSection?.$eval('.fav-btn.on', (el) => el.click());
    await page.waitForFunction(() => {
      const hs = [...document.querySelectorAll('.section h4')];
      return hs.length === 1 && hs[0].textContent === '全部主机';
    }, null, { timeout: 4000 }).catch(() => {});
    const heads2 = await page.$$eval('.section h4', (els) => els.map((e) => e.textContent));
    ok('C4 取消收藏回落全部主机', JSON.stringify(heads2) === JSON.stringify(['全部主机']), JSON.stringify(heads2));
  }

  // ---- E 欢迎页（A01）——建会话前断言 ----
  const welcome = await page.$('.welcome');
  ok('E1 欢迎页在位（未激活会话即显示）', !!welcome);
  if (welcome) {
    const btns = await welcome.$$eval('button', (els) => els.map((e) => e.textContent.trim()));
    ok('E2 添加主机入口', btns.some((t) => t.includes('添加主机')), JSON.stringify(btns));
    ok('E3 导入入口', btns.some((t) => t.includes('导入')));
    ok('E4 本地终端入口（local 主机在册时）', btns.some((t) => t.includes('本地终端')), JSON.stringify(btns));
    ok('E5 无 MCP 空卡/假数据', !(await page.$('.welcome .collab-empty')) && !(await welcome.evaluate((el) => el.textContent.includes('MCP 教程'))));
  }

  // ---- F 20 主机场景（A02） ----
  await page.evaluate(async () => {
    const bridge = await import('/src/adapter/bridge.ts');
    for (let i = 1; i <= 20; i++) {
      await bridge.invoke('upsert_host', { host: { id: null, name: 'r20-load-' + String(i).padStart(2, '0'), address: '192.168.100.' + i, port: 22, username: 'ops', auth: { Password: { password: 'x' } }, tags: ['批量'], charset: 'utf-8' } });
    }
  });
  await page.waitForFunction(() => document.querySelectorAll('.host-card').length >= 26, null, { timeout: 10000 }).catch(() => {});
  const cardN = await page.$$eval('.host-card', (els) => els.length);
  ok('F1 26 主机全渲染（5 种子+1 web+20 批量）', cardN === 26, String(cardN));
  const latency = await page.evaluate(async () => {
    const input = document.querySelector('.hb-search input');
    const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    const t0 = performance.now();
    set.call(input, 'r20-load');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    return { ms: performance.now() - t0, n: document.querySelectorAll('.host-card').length };
  });
  ok('F2 过滤响应 <50ms 且命中 20', latency.n === 20 && latency.ms < 50, JSON.stringify(latency));
  await setSearch(''); // F3 前清查询，防长名主机被残留搜索词过滤
  await page.evaluate(async () => {
    const bridge = await import('/src/adapter/bridge.ts');
    await bridge.invoke('upsert_host', { host: { id: null, name: '超长名称测试——生产环境数据库主从同步与备份调度服务器（成都双流机房）A', address: '2001:db8::1', port: 22, username: 'operator-long', auth: { Password: { password: 'x' } }, tags: [], charset: 'utf-8' } });
  });
  await page.waitForFunction(() => [...document.querySelectorAll('.host-card .host-name')].some((e) => e.textContent.includes('超长名称')), null, { timeout: 8000 }).catch(() => {});
  const longOk = await page.evaluate(() => {
    const card = [...document.querySelectorAll('.host-card')].find((c) => c.textContent.includes('超长名称'));
    if (!card) return false;
    const r = card.getBoundingClientRect();
    return r.height > 0 && r.width < 400; // 卡片宽度受侧栏钳制（不撑破）
  });
  ok('F3 长中文名/IPv6 卡不破版', longOk);

  // ---- G recents invoke 契约（建会话前） ----
  const rec = await page.evaluate(async () => {
    const bridge = await import('/src/adapter/bridge.ts');
    return bridge.invoke('list_recent_hosts');
  });
  ok('G1 recents 排除 local 且 ≤5', Array.isArray(rec) && rec.length <= 5 && !rec.some((r) => r.host_id === 'local'), JSON.stringify(rec));

  // ---- D 键盘焦点（A02，最后执行——会建会话/触发门） ----
  await page.focus('.hb-search input');
  let focused = false;
  for (let i = 0; i < 40; i++) {
    await page.keyboard.press('Tab');
    const cls = await page.evaluate(() => document.activeElement?.className ?? '');
    if (String(cls).includes('host-card')) { focused = true; break; }
  }
  ok('D1 Tab 可达主机卡', focused);
  if (focused) {
    const outline = await page.evaluate(() => {
      const el = document.activeElement;
      const cs = getComputedStyle(el);
      return { style: cs.outlineStyle, width: cs.outlineWidth, matches: el.matches(':focus-visible') };
    });
    ok('D2 焦点可见（:focus-visible 外圈）', outline.matches && outline.style !== 'none' && parseFloat(outline.width) >= 2, JSON.stringify(outline));
    const tabs0 = await page.$$eval('.tabbar .tab', (els) => els.length);
    await page.keyboard.press('Enter');
    await sleep(800);
    const mask = await page.$('.hk-mask');
    const tabs1 = await page.$$eval('.tabbar .tab', (els) => els.length);
    ok('D3 Enter 触发连接（TOFU 门或建会话，二者之一）',
      !!mask || tabs1 > tabs0,
      JSON.stringify({ mask: !!mask, tabs0, tabs1 }));
    if (mask) { await page.keyboard.press('Escape'); await sleep(300); }
  }

  // ---- D+ rev-r20 处置回归 ----
  // D4/D5（H1）：星标钮聚焦按 Enter——修复前外层 onKeyDown 对冒泡 Enter 一律
  // preventDefault+activate()：吞掉按钮默认激活（收藏不翻转）且误建会话（标签 2→3，
  // rev 实证）；修复后 e.target!==e.currentTarget 早退，应翻转收藏、不建会话、不开门
  const dh = await page.evaluate(() => {
    const fav = document.querySelector('.host-card .fav-btn');
    if (!fav) return null;
    fav.focus();
    return {
      focused: document.activeElement === fav,
      pressed: fav.getAttribute('aria-pressed'),
      tabs: document.querySelectorAll('.tabbar .tab').length,
    };
  });
  await page.keyboard.press('Enter');
  await sleep(500);
  const dh2 = await page.evaluate(() => ({
    pressed: document.querySelector('.host-card .fav-btn')?.getAttribute('aria-pressed'),
    tabs: document.querySelectorAll('.tabbar .tab').length,
    mask: !!document.querySelector('.hk-mask'),
  }));
  ok('D4 rev-H1 星标钮 Enter 翻转收藏（按钮默认激活未被吞）',
    !!dh && dh.focused && dh2.pressed !== null && dh2.pressed !== dh.pressed,
    JSON.stringify({ focused: dh?.focused, before: dh?.pressed, after: dh2.pressed }));
  ok('D5 rev-H1 星标钮 Enter 不建会话不开门',
    !!dh && dh2.tabs === dh.tabs && !dh2.mask,
    JSON.stringify({ tabs0: dh?.tabs, tabs1: dh2.tabs, mask: dh2.mask }));

  // D6（H1 同路径）：编辑钮聚焦按 Enter——应打开编辑表单且不建会话
  const de = await page.evaluate(() => {
    const edit = document.querySelector('.host-card .host-ops button[title^="编辑主机"]');
    if (!edit) return null;
    edit.focus();
    return { focused: document.activeElement === edit, tabs: document.querySelectorAll('.tabbar .tab').length };
  });
  await page.keyboard.press('Enter');
  await sleep(400);
  const de2 = await page.evaluate(() => ({
    form: !!document.querySelector('.add-host'),
    tabs: document.querySelectorAll('.tabbar .tab').length,
    mask: !!document.querySelector('.hk-mask'),
  }));
  ok('D6 rev-H1 编辑钮 Enter 开表单不建会话',
    !!de && de.focused && de2.form && de2.tabs === de.tabs && !de2.mask,
    JSON.stringify({ focused: de?.focused, ...de2 }));
  await page.keyboard.press('Escape'); // 收起编辑表单，防污染 D7
  await sleep(250);

  // D7（M1）：chip 筛选激活 → 标签经编辑在全部主机上消失 → 列表应恢复而非恒空死态
  // （修复前 tagFilter 残留：chip 不渲染 + 列表恒空 + 无清除入口）
  await page.$eval('.hb-tag:text-is("生产")', (el) => el.click());
  await page.waitForFunction(() => document.querySelectorAll('.host-card').length === 1, null, { timeout: 4000 }).catch(() => {});
  ok('D7a 生产 chip 过滤生效（前置）', JSON.stringify(await visibleNames()) === JSON.stringify(['r20-web']), JSON.stringify(await visibleNames()));
  await page.evaluate(async () => {
    const bridge = await import('/src/adapter/bridge.ts');
    const hosts = await bridge.invoke('list_hosts');
    const h = hosts.find((x) => x.name === 'r20-web');
    await bridge.invoke('upsert_host', { host: { ...h, tags: [] } }); // 编辑路径清空标签
  });
  // UI 每 3s 轮询回读——等列表恢复而非固定 sleep
  await page.waitForFunction(() => document.querySelectorAll('.host-card').length >= 6, null, { timeout: 8000 }).catch(() => {});
  const d7 = await page.evaluate(() => ({
    cards: document.querySelectorAll('.host-card').length,
    chips: [...document.querySelectorAll('.hb-tag')].map((e) => e.textContent.trim()),
    noMatch: !!document.querySelector('.section .dim'),
  }));
  ok('D7 rev-M1 标签消失后列表自动恢复（无死态）',
    d7.cards >= 6 && !d7.chips.includes('生产') && !d7.noMatch,
    JSON.stringify(d7));

  ok('Z1 零 JS 错误', jsErrors.length === 0, jsErrors.join('; ').slice(0, 200));

  await browser.close();
  const fails = results.filter((r) => !r.pass);
  console.log(fails.length === 0 ? 'r20-demo-ALL-PASS ' + results.length : 'r20-demo-FAILS=' + fails.length);
  process.exit(fails.length === 0 ? 0 : 1);
})().catch((e) => { console.error('PROBE-ERR', e); process.exit(2); });
