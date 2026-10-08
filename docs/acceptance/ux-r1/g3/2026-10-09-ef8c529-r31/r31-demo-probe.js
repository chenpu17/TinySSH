// R31 demo 探针（文件面板、完整视图、导航与选择 §348/§350/§183-186）：
// A 导航（面包屑/编辑路径框/返回前进/上一级/刷新/定位终端目录）
// B 列表（隐藏项/名称筛选/排序：目录在前、未知值排后）
// C 选择与键盘（单击/⌘/Shift 多选、下载所选、目录明确信息、键盘方向键+Enter+Space、双击动作菜单）
// D 路径/选择恢复（切会话快照恢复、面板重开保持、缩小窗口不清除选择 §4.2）
// E 完整视图（窄窗 tp-full、分屏×面板退完整视图 §186、列依次收起）
// Z 零 JS 错
const { chromium } = require('/Users/chenpu/node_modules/playwright');
const EXE = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const URL = process.env.PROBE_URL || 'http://localhost:5183/';
const results = [];
const ok = (name, cond, detail = '') => { results.push({ name, pass: !!cond }); console.log((cond ? 'PASS ' : 'FAIL ') + name + (detail ? '  [' + detail + ']' : '')); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const browser = await chromium.launch({ executablePath: EXE, headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();
  const jsErrors = [];
  page.on('pageerror', (e) => jsErrors.push(String(e)));
  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => { try { localStorage.clear(); } catch {} });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.host-card', { timeout: 10000 });
  await sleep(400);

  const demoInvoke = (cmd, args) => page.evaluate(async ({ c, a }) => {
    const { invoke } = await import('/src/adapter/bridge.ts');
    return invoke(c, a);
  }, { c: cmd, a: args });
  const waitFor_ = async (fn, tries, gap = 150) => {
    for (let i = 0; i < tries; i++) { const v = await fn(); if (v) return v; await sleep(gap); }
    return null;
  };
  const connectHost = async (needle) => {
    await page.evaluate((n) => {
      const card = [...document.querySelectorAll('.host-card')].find((c) => c.querySelector('.host-name')?.textContent.includes(n));
      card?.querySelector('.host-connect-btn')?.click();
    }, needle);
    await page.waitForSelector('.hk-mask', { timeout: 4000 }).catch(() => {});
    await page.evaluate(() => {
      [...document.querySelectorAll('.hk-mask button')].find((x) => x.textContent.includes('信任并连接'))?.click();
    });
    return waitFor_(async () => (await demoInvoke('list_sessions')).find((x) => x.host_name.includes(needle) && x.state === 'Connected')?.id ?? null, 60);
  };
  const rows = () => page.$$eval('[data-testid="sftp-list"] .sftp-row', (rs) => rs.map((r) => ({ name: r.dataset.name, sel: r.classList.contains('sel'), cur: r.classList.contains('cursor') })));
  const crumbs = () => page.$eval('[data-testid="sftp-crumbs"]', (el) => el.title || '');
  const openPanel = async () => {
    await page.evaluate(() => { document.querySelector('.st-file')?.click(); });
    await page.waitForSelector('[data-testid="sftp-list"]', { timeout: 5000 }).catch(() => {});
  };

  // 连接 prod-1 + 打开文件面板
  const sidA = await connectHost('prod-1');
  ok('A0 session A connected', !!sidA, String(sidA));
  await openPanel();
  await sleep(500);

  // A1 首载（brief cwd=/var/log/nginx）+ 隐藏项默认不显示
  let r = await rows();
  ok('A1 first-load via brief cwd + hidden off', r.some((x) => x.name === 'access.log') && !r.some((x) => x.name === '.rotate.state'), JSON.stringify(r.map((x) => x.name)));

  // A2 面包屑分段
  let c = await crumbs();
  ok('A2 breadcrumb segments', c === '/var/log/nginx', c);

  // A3 双击目录进入（archive）
  await page.dblclick('[data-testid="sftp-list"] .sftp-row[data-name="archive"] .sftp-name');
  await waitFor_(async () => (await rows()).some((x) => x.name === 'access-202609.log.gz'), 30);
  r = await rows();
  ok('A3 dblclick dir enters', r.some((x) => x.name === 'access-202609.log.gz'), JSON.stringify(r.map((x) => x.name)));

  // A4 返回/前进/上一级
  await page.click('.sftp-nav button[aria-label="返回"]');
  await waitFor_(async () => (await rows()).some((x) => x.name === 'access.log'), 30);
  ok('A4a back to /var/log/nginx', (await crumbs()) === '/var/log/nginx', (await crumbs()));
  await page.click('.sftp-nav button[aria-label="前进"]');
  const fwdRows = await waitFor_(async () => (await rows()).some((x) => x.name === 'access-202609.log.gz'), 30);
  ok('A4b forward to archive', !!fwdRows, JSON.stringify((await rows()).map((x) => x.name)));
  await page.click('.sftp-nav button[aria-label="上一级"]');
  await waitFor_(async () => (await rows()).some((x) => x.name === 'access.log'), 30);
  ok('A4c up to /var/log/nginx', (await crumbs()) === '/var/log/nginx', (await crumbs()));

  // A5 编辑路径框切换：点 ✎ → 输入框出现（带当前路径）→ 改路径回车 → 导航且回到面包屑
  await page.click('.sftp-nav button[aria-label="切换路径输入"]');
  const editVisible = await page.$('[data-testid="sftp-path-input"]');
  ok('A5a edit toggle shows input', !!editVisible);
  await page.fill('[data-testid="sftp-path-input"]', '/root/deploy');
  await page.press('[data-testid="sftp-path-input"]', 'Enter');
  await waitFor_(async () => (await rows()).some((x) => x.name === 'release.sh'), 30);
  const crumbsBack = await page.$('[data-testid="sftp-crumbs"]');
  ok('A5b enter navigates + back to crumbs', !!crumbsBack && (await crumbs()) === '/root/deploy', (await crumbs()));

  // A6 面包屑点击前缀段
  await page.click('[data-testid="sftp-crumbs"] .sftp-crumb:text-is("root")');
  await waitFor_(async () => (await rows()).some((x) => x.name === 'deploy'), 30);
  ok('A6 crumb prefix click → /root', (await crumbs()) === '/root', (await crumbs()));

  // A7 定位到终端目录（brief cwd=/var/log/nginx）
  const locDisabledHere = await page.$eval('.sftp-nav button[aria-label="定位到终端目录"]', (b) => b.disabled);
  ok('A7a locate enabled when away from cwd', !locDisabledHere);
  await page.click('.sftp-nav button[aria-label="定位到终端目录"]');
  await waitFor_(async () => (await rows()).some((x) => x.name === 'access.log'), 30);
  ok('A7b locate → brief cwd', (await crumbs()) === '/var/log/nginx', (await crumbs()));
  const locDisabledThere = await page.$eval('.sftp-nav button[aria-label="定位到终端目录"]', (b) => b.disabled);
  ok('A7c locate disabled at cwd', locDisabledThere);

  // A8 刷新保持路径
  await page.click('.sftp-nav button[aria-label="刷新"]');
  await sleep(400);
  ok('A8 refresh keeps path', (await crumbs()) === '/var/log/nginx');

  // B1 显示隐藏项
  await page.click('.sftp-tools button[title="显示隐藏项（. 开头）"]');
  await waitFor_(async () => (await rows()).some((x) => x.name === '.rotate.state'), 20);
  ok('B1 hidden toggle shows dotfiles', (await rows()).some((x) => x.name === '.rotate.state'));
  await page.click('.sftp-tools button[title="显示隐藏项（. 开头）"]');
  await sleep(200);
  ok('B1b toggle off hides again', !(await rows()).some((x) => x.name === '.rotate.state'));

  // B2 名称筛选
  await page.fill('.sftp-filter', 'log');
  await sleep(200);
  r = await rows();
  ok('B2 filter narrows', r.length === 2 && r.every((x) => x.name.includes('log')), JSON.stringify(r.map((x) => x.name)));
  await page.fill('.sftp-filter', 'zzz');
  await sleep(200);
  const noMatch = await page.$$eval('.section .side-quiet', (els) => els.some((e) => e.textContent.includes('无匹配项')));
  ok('B3 filter no-match message', noMatch);
  await page.fill('.sftp-filter', '');
  await sleep(200);

  // B4-B6 排序（/root：目录在前；大小/时间 asc/desc；未知值排后）
  await page.click('.sftp-nav button[aria-label="切换路径输入"]');
  await page.fill('[data-testid="sftp-path-input"]', '/root');
  await page.press('[data-testid="sftp-path-input"]', 'Enter');
  await waitFor_(async () => (await rows()).some((x) => x.name === 'deploy'), 30);
  const names = () => rows().then((rs) => rs.map((x) => x.name));
  // 大小升序：目录组(deploy,logs,releases) → readme.md(312) < nginx.conf(2048) < backup(48M) → 链接 null 排后
  await page.click('.sftp-tools button:has-text("大小")');
  await sleep(200);
  let n = await names();
  ok('B4 size asc: dirs first, files by size, nulls last',
    JSON.stringify(n) === JSON.stringify(['deploy', 'logs', 'releases', 'readme.md', 'nginx.conf', 'backup-0930.tar.gz', 'current', 'gone-link']), JSON.stringify(n));
  await page.click('.sftp-tools button:has-text("大小")');
  await sleep(200);
  n = await names();
  ok('B5 size desc: dirs still first, files reversed',
    JSON.stringify(n) === JSON.stringify(['deploy', 'logs', 'releases', 'backup-0930.tar.gz', 'nginx.conf', 'readme.md', 'current', 'gone-link']), JSON.stringify(n));
  // 时间升序：文件 readme(…)→backup→nginx.conf
  await page.click('.sftp-tools button:has-text("时间")');
  await sleep(200);
  n = await names();
  ok('B6 mtime asc: dirs by mtime then files asc',
    JSON.stringify(n.slice(3)) === JSON.stringify(['readme.md', 'gone-link', 'backup-0930.tar.gz', 'nginx.conf', 'current']), JSON.stringify(n));
  await page.click('.sftp-tools button:has-text("名称")');
  await sleep(200);
  n = await names();
  ok('B7 name sort restores', n[0] === 'deploy' && n[3] === 'backup-0930.tar.gz', JSON.stringify(n));

  // C 选择：单击/⌘/Shift
  await page.click('[data-testid="sftp-list"] .sftp-row[data-name="nginx.conf"]');
  await sleep(120);
  let selbar = await page.$('[data-testid="sftp-selbar"]');
  ok('C1 click selects one', !!selbar && (await selbar.textContent()).includes('已选 1 项'));
  await page.keyboard.down('Meta');
  await page.click('[data-testid="sftp-list"] .sftp-row[data-name="readme.md"]');
  await page.keyboard.up('Meta');
  await sleep(120);
  selbar = await page.$('[data-testid="sftp-selbar"]');
  ok('C2 cmd-click adds', (await selbar.textContent()).includes('已选 2 项'), await selbar.textContent());
  // 多选下载（两个文件）→ 传输卡出现
  const before = (await demoInvoke('list_transfers')).length;
  await page.click('[data-testid="sftp-sel-download"]');
  await waitFor_(async () => (await demoInvoke('list_transfers')).length >= before + 2, 30);
  const after = (await demoInvoke('list_transfers')).length;
  ok('C3 multi-download creates 2 transfers', after >= before + 2, `${before}→${after}`);
  await sleep(300);
  // 目录进入选择 → 明确信息 toast
  await page.click('[data-testid="sftp-list"] .sftp-row[data-name="deploy"]');
  await page.keyboard.down('Meta');
  await page.click('[data-testid="sftp-list"] .sftp-row[data-name="logs"]');
  await page.keyboard.up('Meta');
  await sleep(120);
  await page.click('[data-testid="sftp-sel-download"]');
  await sleep(300);
  const toastText = await page.$$eval('.toast', (ts) => ts.map((t) => t.textContent).join('|'));
  ok('C4 dir download gives explicit info', toastText.includes('目录') && toastText.includes('不支持直接下载'), toastText);
  await page.click('.sftp-selbar button[aria-label="清除选择"]');
  await sleep(120);
  ok('C5 clear selection', !(await page.$('[data-testid="sftp-selbar"]')));

  // C6 键盘：聚焦列表 → 方向键光标 → Enter 进入目录 → Space 选中
  await page.focus('[data-testid="sftp-list"]');
  await page.keyboard.press('Home');
  await page.keyboard.press('ArrowDown');
  await sleep(120);
  r = await rows();
  ok('C6a arrows move cursor', r[1] && r[1].cur && !r[0].cur, JSON.stringify(r.map((x) => x.cur)));
  await page.keyboard.press('Enter');
  await waitFor_(async () => (await crumbs()) === '/root/logs', 30);
  ok('C6b Enter enters dir', (await crumbs()) === '/root/logs', (await crumbs()));
  await page.focus('[data-testid="sftp-list"]');
  await page.keyboard.press('Home');
  await page.keyboard.press('Space');
  await sleep(120);
  selbar = await page.$('[data-testid="sftp-selbar"]');
  ok('C6c Space toggles selection', !!selbar && (await selbar.textContent()).includes('已选 1 项'));
  await page.click('.sftp-selbar button[aria-label="清除选择"]');

  // C7 双击文件 → 动作菜单（不直接执行）→ 菜单下载
  const beforeMenu = (await demoInvoke('list_transfers')).length;
  await page.dblclick('[data-testid="sftp-list"] .sftp-row[data-name="app.log"] .sftp-name');
  await page.waitForSelector('[data-testid="sftp-menu"]', { timeout: 3000 }).catch(() => {});
  const menu = await page.$('[data-testid="sftp-menu"]');
  ok('C7a dblclick file shows actions menu', !!menu);
  const noExecYet = (await demoInvoke('list_transfers')).length === beforeMenu;
  ok('C7b dblclick does not execute directly', noExecYet);
  if (menu) {
    await page.click('[data-testid="sftp-menu-download"]');
    await waitFor_(async () => (await demoInvoke('list_transfers')).length > beforeMenu, 30);
    ok('C7c menu download creates transfer', (await demoInvoke('list_transfers')).length > beforeMenu);
    ok('C7d menu closed after action', !(await page.$('[data-testid="sftp-menu"]')));
  }
  // C7e Esc 关菜单
  await page.dblclick('[data-testid="sftp-list"] .sftp-row[data-name="error.log"] .sftp-name');
  await page.waitForSelector('[data-testid="sftp-menu"]', { timeout: 3000 }).catch(() => {});
  await page.keyboard.press('Escape');
  await sleep(150);
  ok('C7e Esc closes menu', !(await page.$('[data-testid="sftp-menu"]')));

  // D 路径/选择恢复：A 在 /root/deploy 选 1 项 → 切到会话 B → 切回 A 恢复
  await page.click('.sftp-nav button[aria-label="切换路径输入"]');
  await page.fill('[data-testid="sftp-path-input"]', '/root/deploy');
  await page.press('[data-testid="sftp-path-input"]', 'Enter');
  await waitFor_(async () => (await rows()).some((x) => x.name === 'release.sh'), 30);
  await page.click('[data-testid="sftp-list"] .sftp-row[data-name="release.sh"]');
  await sleep(120);
  // 恢复测试用种子会话（demo 每次连接新建会话，标签切换=同会话重挂）：
  // 附到种子 prod-1 标签 → 浏览并选择 → 切 staging-1 标签 → 切回恢复
  const clickTab = async (needle, idx = 0) => page.evaluate(({ n, i }) => {
    const ts = [...document.querySelectorAll('[role="tab"]')].filter((x) => x.textContent.includes(n));
    ts[i]?.click();
  }, { n: needle, i: idx });
  await clickTab('prod-1', 0);
  await sleep(800);
  // 种子 prod-1 首载链走自己的 brief cwd
  let rB = await rows();
  ok('D0 seeded session attached + fresh chain', rB.length > 0 && !rB.some((x) => x.name === 'release.sh'), JSON.stringify(rB.map((x) => x.name)));
  await page.click('.sftp-nav button[aria-label="切换路径输入"]');
  await page.fill('[data-testid="sftp-path-input"]', '/root/deploy');
  await page.press('[data-testid="sftp-path-input"]', 'Enter');
  await waitFor_(async () => (await rows()).some((x) => x.name === 'release.sh'), 30);
  await page.click('[data-testid="sftp-list"] .sftp-row[data-name="release.sh"]');
  await sleep(150);
  await clickTab('staging-1');
  await sleep(800);
  rB = await rows();
  ok('D1 staging session has own browser state', !rB.some((x) => x.name === 'release.sh'), JSON.stringify(rB.map((x) => x.name)));
  await clickTab('prod-1', 0);
  await sleep(600);
  r = await rows();
  ok('D2 switch back restores path+selection',
    r.some((x) => x.name === 'release.sh') && r.find((x) => x.name === 'release.sh')?.sel,
    JSON.stringify(r.map((x) => `${x.name}${x.sel ? '*' : ''}`)));

  // D3 面板关→开保持（§4.3 切换前保存视图状态）
  await page.evaluate(() => document.querySelector('.tp-head button[aria-label="关闭任务面板"]')?.click());
  await sleep(200);
  await page.evaluate(() => document.querySelector('.st-file')?.click());
  await sleep(400);
  r = await rows();
  ok('D3 panel close/reopen keeps state', r.some((x) => x.name === 'release.sh' && x.sel), JSON.stringify(r.map((x) => x.name)));

  // E 完整视图
  // E1 窄窗 → tp-full（1280 无分屏无 tpfull → 900 触发）
  await page.setViewportSize({ width: 900, height: 700 });
  await sleep(400);
  let isFull = await page.$eval('.task-panel', (el) => el.classList.contains('tp-full'));
  ok('E1 narrow window → full view', isFull);
  // E2 缩小窗口不清除选择（§4.2）
  ok('E2 selection survives resize', r.some((x) => x.name === 'release.sh' && x.sel) && !!(await page.$('[data-testid="sftp-selbar"]')));
  await page.setViewportSize({ width: 1280, height: 800 });
  await sleep(400);
  isFull = await page.$eval('.task-panel', (el) => el.classList.contains('tp-full'));
  ok('E3 widen restores side panel', !isFull);

  // E4 分屏 × 面板 → 完整视图（§186）；关闭面板恢复原分屏
  await page.click('.st-tools-split, .icon-btn[title*="分屏"]');
  await page.waitForSelector('.split-menu', { timeout: 3000 }).catch(() => {});
  await page.evaluate(() => {
    [...document.querySelectorAll('.split-menu .sm-item')].find((b) => b.textContent.includes('staging-1'))?.click();
  });
  await sleep(500);
  isFull = await page.$eval('.task-panel', (el) => el.classList.contains('tp-full'));
  ok('E4 split × panel → full view', isFull);
  // 分屏仍在（两窗格）
  const panes = await page.$$eval('.term-session.pane-left, .term-session.pane-right', (els) => els.length);
  ok('E5 split panes intact behind full view', panes === 2, String(panes));
  await page.evaluate(() => document.querySelector('.tp-head button[aria-label="关闭任务面板"]')?.click());
  await sleep(300);
  const panesAfter = await page.$$eval('.term-session.pane-left, .term-session.pane-right', (els) => els.length);
  ok('E6 close panel restores split', panesAfter === 2, String(panesAfter));
  // 退出分屏复原
  await page.evaluate(() => { [...document.querySelectorAll('button')].find((b) => (b.title || '').includes('退出分屏'))?.click(); });
  await sleep(300);

  // E7 窄窗列收起（§350 依次收起）：极窄窗口 tp-full 内容 ≤340 → 时间列隐藏
  await page.evaluate(() => document.querySelector('.st-file')?.click());
  await sleep(300);
  await page.setViewportSize({ width: 360, height: 700 });
  await sleep(500);
  const colMode = await page.$eval('[data-testid="sftp-list"]', (el) => el.className);
  const timeHidden = await page.$eval('[data-testid="sftp-list"] .sftp-time', (el) => getComputedStyle(el).display === 'none');
  ok('E7 narrow collapses time column first', timeHidden, colMode);
  await page.setViewportSize({ width: 300, height: 700 });
  await sleep(500);
  const sizeHidden = await page.$$eval('[data-testid="sftp-list"] .sftp-size', (els) => els.length === 0 || getComputedStyle(els[0]).display === 'none');
  ok('E8 narrower collapses size too', sizeHidden);
  await page.setViewportSize({ width: 1280, height: 800 });
  await sleep(300);

  // Z 零 JS 错
  ok('Z zero page errors', jsErrors.length === 0, jsErrors.slice(0, 3).join(' | '));

  const pass = results.filter((x) => x.pass).length;
  console.log(`SUMMARY ${pass}/${results.length}`);
  await browser.close();
  process.exit(pass === results.length ? 0 : 1);
})().catch((e) => { console.error('PROBE-ERROR', e); process.exit(2); });
