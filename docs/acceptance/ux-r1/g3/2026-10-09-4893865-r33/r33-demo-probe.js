// R33 demo 探针（上传下载入口、原生选择器与拖拽目标 §353-356）：
// A 上传入口（面板「上传」钮 → pick_upload_files；取消不发；目标=正在浏览的目录）
// B 下载目标（另存为菜单项 → pick_save_file；上次下载目录记忆：plain 下载落上次目录；blob transfers 域持久化）
// C 拖放分区与确认卡（面板落点直传浏览目录；终端落点确认卡预填可信 cwd；
//   取消/Esc/清空禁用/切标签失效不静默改投；面板关闭时无面板分区）
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
  const rows = () => page.$$eval('[data-testid="sftp-list"] .sftp-row', (rs) => rs.map((r) => ({ name: r.dataset.name })));
  const crumbs = () => page.$eval('[data-testid="sftp-crumbs"]', (el) => el.title || '').catch(() => '');
  const openPanel = async () => {
    await page.evaluate(() => { document.querySelector('.st-file')?.click(); });
    await page.waitForSelector('[data-testid="sftp-list"]', { timeout: 5000 }).catch(() => {});
  };
  const dropCard = () => page.$('[data-testid="drop-dir-input"]');
  const toasts = () => page.$$eval('.toast', (ts) => ts.map((t) => t.textContent));
  const setNativeValue = (sel, value) => page.evaluate(({ sel, value }) => {
    const el = document.querySelector(sel);
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }, { sel, value });
  const dropAt = (paths, x, y) => demoInvoke('demo_drag_drop', { paths, x, y });

  // 连接 prod-1 + 打开文件面板（brief cwd=/var/log/nginx）
  // 注意（R31 同案）：demo connect 新建会话，list_sessions 轮询会先撞上种子
  // s-demo-000x——取 created_at 最新的 Connected 会话才是本次连接
  await connectHost('prod-1');
  const sidNew = await waitFor_(async () => {
    const l = await demoInvoke('list_sessions');
    const mine = l.filter((x) => x.host_name.includes('prod-1') && x.state === 'Connected');
    return mine.sort((a, b) => (a.created_at < b.created_at ? 1 : -1))[0]?.id ?? null;
  }, 20);
  ok('A0 session connected', !!sidNew, String(sidNew));
  await openPanel();
  await sleep(500);

  const baseCount = () => demoInvoke('list_transfers').then((l) => l.length);
  const n0 = await baseCount();

  // ---- A 上传入口 ----
  // A1 上传钮存在且可用
  const upBtnDisabled = await page.$eval('[data-testid="sftp-upload-btn"]', (b) => b.disabled).catch(() => null);
  ok('A1 upload button present & enabled', upBtnDisabled === false, String(upBtnDisabled));

  // A2 取消路径：pick 返回空 → 不建卡
  await demoInvoke('demo_pick_result', { paths: [] });
  await page.click('[data-testid="sftp-upload-btn"]');
  await sleep(400);
  ok('A2 cancel pick → no cards', (await baseCount()) === n0);

  // A3 默认桩选择 2 个文件 → 上传到正在浏览的目录（/var/log/nginx），目标会话=聚焦会话
  await demoInvoke('demo_pick_result', {});
  await page.click('[data-testid="sftp-upload-btn"]');
  const upTasks = await waitFor_(async () => {
    const l = await demoInvoke('list_transfers');
    const up = l.filter((t) => t.kind === 'Upload' && t.source.startsWith('/Users/demo/Desktop/'));
    return up.length >= 2 ? up : null;
  }, 30);
  ok('A3 picker default stub uploads 2 files', !!upTasks, JSON.stringify(upTasks?.map((t) => t.source)));
  ok('A3b upload dest = browsed dir + pinned sid', !!upTasks && upTasks.every((t) => t.dest === '/var/log/nginx/' + t.source.split('/').pop() && t.session_id === sidNew),
    JSON.stringify(upTasks?.map((t) => t.dest)));
  await waitFor_(async () => demoInvoke('list_transfers').then((l) => l.filter((t) => t.kind === 'Upload').every((t) => t.status === 'Succeeded' || t.status === 'Failed' || t.status === 'Cancelled')), 40);
  await sleep(200);

  // ---- B 下载目标（§356）----
  // 导航到 /root/deploy（与 cwd 不同的浏览目录，供分区判别）——用路径编辑框
  await page.click('.sftp-nav button[aria-label="切换路径输入"]');
  await page.waitForSelector('[data-testid="sftp-path-input"]', { timeout: 3000 });
  await setNativeValue('[data-testid="sftp-path-input"]', '/root/deploy');
  await page.keyboard.press('Enter');
  await waitFor_(async () => (await rows()).some((x) => x.name === 'app.yml'), 30);
  ok('B0 navigated to /root/deploy', (await crumbs()) === '/root/deploy', await crumbs());

  // B1 双击文件弹动作菜单 → 另存为… 存在
  await page.dblclick('[data-testid="sftp-list"] .sftp-row[data-name="app.yml"] .sftp-name');
  await page.waitForSelector('[data-testid="sftp-menu"]', { timeout: 3000 });
  const saveAsItem = await page.$('[data-testid="sftp-menu-saveas"]');
  ok('B1 actions menu has 另存为', !!saveAsItem);

  // B2 另存为默认桩（首次，无记忆）→ /Users/demo/Downloads/app.yml；blob 记忆该目录
  await saveAsItem.click();
  const dlTask = await waitFor_(async () => {
    const l = await demoInvoke('list_transfers');
    return l.find((t) => t.kind === 'Download' && t.source.endsWith('/app.yml')) ?? null;
  }, 30);
  ok('B2 saveAs default → Downloads full path', dlTask?.dest === '/Users/demo/Downloads/app.yml', String(dlTask?.dest));
  const blobDir1 = await waitFor_(async () => page.evaluate(() => {
    try { return JSON.parse(localStorage.getItem('ui.v2.workspace'))?.transfers?.download_dir ?? null; } catch { return null; }
  }), 20);
  ok('B2b blob transfers.download_dir persisted', blobDir1 === '/Users/demo/Downloads', String(blobDir1));

  // B3 另存为预置路径 → 完整本地目标 + 目录记忆更新
  await demoInvoke('demo_pick_result', { path: '/Users/demo/Desktop/keep-app.yml' });
  await page.dblclick('[data-testid="sftp-list"] .sftp-row[data-name="app.yml"] .sftp-name');
  await page.waitForSelector('[data-testid="sftp-menu-saveas"]', { timeout: 3000 });
  await page.click('[data-testid="sftp-menu-saveas"]');
  const dl2 = await waitFor_(async () => {
    const l = await demoInvoke('list_transfers');
    return l.find((t) => t.kind === 'Download' && t.dest === '/Users/demo/Desktop/keep-app.yml') ?? null;
  }, 30);
  ok('B3 saveAs picked path honored', !!dl2, String(dl2?.dest));
  const blobDir2 = await waitFor_(async () => page.evaluate(() => {
    try { return JSON.parse(localStorage.getItem('ui.v2.workspace'))?.transfers?.download_dir ?? null; } catch { return null; }
  }), 20);
  ok('B3b dir memory updated', blobDir2 === '/Users/demo/Desktop', String(blobDir2));

  // B4 普通下载（不另存为）→ 落上次下载目录
  await page.dblclick('[data-testid="sftp-list"] .sftp-row[data-name="release.sh"] .sftp-name');
  await page.waitForSelector('[data-testid="sftp-menu-download"]', { timeout: 3000 });
  await page.click('[data-testid="sftp-menu-download"]');
  const dl3 = await waitFor_(async () => {
    const l = await demoInvoke('list_transfers');
    return l.find((t) => t.kind === 'Download' && t.source.endsWith('/release.sh')) ?? null;
  }, 30);
  ok('B4 plain download lands in last dir', dl3?.dest === '/Users/demo/Desktop/release.sh', String(dl3?.dest));

  // B5（rev 低-1）另存为取消：demo_pick_result {path: ""} 表达取消 → 零副作用
  //（不建卡/不写 blob）且目录记忆保留
  await demoInvoke('demo_pick_result', { path: '' });
  const nDl = (await demoInvoke('list_transfers')).filter((t) => t.kind === 'Download').length;
  await page.dblclick('[data-testid="sftp-list"] .sftp-row[data-name="app.yml"] .sftp-name');
  await page.waitForSelector('[data-testid="sftp-menu-saveas"]', { timeout: 3000 });
  await page.click('[data-testid="sftp-menu-saveas"]');
  await sleep(400);
  const nDlAfter = (await demoInvoke('list_transfers')).filter((t) => t.kind === 'Download').length;
  const blobDir3 = await page.evaluate(() => {
    try { return JSON.parse(localStorage.getItem('ui.v2.workspace'))?.transfers?.download_dir ?? null; } catch { return null; }
  });
  ok('B5 saveAs cancel → zero side effects', nDlAfter === nDl && blobDir3 === '/Users/demo/Desktop',
    JSON.stringify({ nDl, nDlAfter, blobDir3 }));

  // B6 取消后普通下载仍落原记忆目录（记忆未被取消污染）
  await page.dblclick('[data-testid="sftp-list"] .sftp-row[data-name="app.yml"] .sftp-name');
  await page.waitForSelector('[data-testid="sftp-menu-download"]', { timeout: 3000 });
  await page.click('[data-testid="sftp-menu-download"]');
  const dl4 = await waitFor_(async () => {
    const l = await demoInvoke('list_transfers');
    return l.find((t) => t.kind === 'Download' && t.source.endsWith('/app.yml') && t.dest.startsWith('/Users/demo/Desktop/')) ?? null;
  }, 30);
  ok('B6 memory intact after cancel', !!dl4 && dl4.dest === '/Users/demo/Desktop/app.yml', String(dl4?.dest));
  await demoInvoke('demo_pick_result', {});
  await sleep(300);

  // ---- C 拖放分区与确认卡 ----
  // C1 终端落点（面板外坐标）→ 确认卡出现，预填可信 cwd
  await dropAt(['/Users/demo/Desktop/deploy.tar.gz'], 300, 400);
  let card = await waitFor_(async () => dropCard(), 20);
  ok('C1 terminal drop → confirm card', !!card);
  const prefill = card ? await card.evaluate((el) => el.value) : '';
  ok('C1b prefill = trusted cwd', prefill === '/var/log/nginx', prefill);
  const filesLine = await page.$eval('[data-testid="drop-files-line"]', (el) => el.textContent).catch(() => '');
  ok('C1c files line names the file', (filesLine || '').includes('deploy.tar.gz'), filesLine);

  // C2 确认 → 按固定会话上传到预填目录
  await page.click('[data-testid="drop-confirm"]');
  const dropTask = await waitFor_(async () => {
    const l = await demoInvoke('list_transfers');
    return l.find((t) => t.kind === 'Upload' && t.source.endsWith('deploy.tar.gz')) ?? null;
  }, 30);
  ok('C2 confirmed upload to prefilled dir', dropTask?.dest === '/var/log/nginx/deploy.tar.gz' && dropTask?.session_id === sidNew,
    JSON.stringify({ dest: dropTask?.dest, sid: dropTask?.session_id }));
  await waitFor_(async () => demoInvoke('list_transfers').then((l) => l.every((t) => ['Succeeded', 'Failed', 'Cancelled'].includes(t.status))), 40);
  await sleep(200);

  // C3 取消路径：确认卡取消 → 不上传
  const before = await baseCount();
  await dropAt(['/Users/demo/Desktop/x.bin'], 300, 400);
  await waitFor_(async () => dropCard(), 20);
  await page.evaluate(() => { [...document.querySelectorAll('.confirm-dialog button')].find((b) => b.textContent === '取消')?.click(); });
  await sleep(300);
  ok('C3 cancel → no upload', (await baseCount()) === before && !(await dropCard()));

  // C4 清空目录输入 → 确认禁用；Esc 关卡
  await dropAt(['/Users/demo/Desktop/y.bin'], 300, 400);
  await waitFor_(async () => dropCard(), 20);
  await setNativeValue('[data-testid="drop-dir-input"]', '');
  const confirmDisabled = await page.$eval('[data-testid="drop-confirm"]', (b) => b.disabled);
  ok('C4 empty dir → confirm disabled', confirmDisabled === true);
  await page.keyboard.press('Escape');
  await sleep(200);
  ok('C4b Esc closes card', !(await dropCard()));

  // C5 面板落点 → 直接上传到正在浏览的目录（/root/deploy），无确认卡
  const rect = await page.$eval('.task-panel', (el) => { const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; });
  await dropAt(['/Users/demo/Desktop/app.yml'], rect.x, rect.y);
  await sleep(300);
  const panelTask = await waitFor_(async () => {
    const l = await demoInvoke('list_transfers');
    return l.find((t) => t.kind === 'Upload' && t.source === '/Users/demo/Desktop/app.yml') ?? null;
  }, 30);
  ok('C5 panel drop → direct upload to browsed dir', !!panelTask && panelTask.dest === '/root/deploy/app.yml' && panelTask.session_id === sidNew,
    JSON.stringify({ dest: panelTask?.dest }));
  ok('C5b no confirm card on panel drop', !(await dropCard()));
  await waitFor_(async () => demoInvoke('list_transfers').then((l) => l.every((t) => ['Succeeded', 'Failed', 'Cancelled'].includes(t.status))), 40);
  await sleep(200);

  // C6 面板关闭时同坐标 → 无面板分区，走确认卡
  await page.evaluate(() => { document.querySelector('.task-panel .tp-head button[aria-label="关闭任务面板"]')?.click(); });
  await sleep(300);
  await dropAt(['/Users/demo/Desktop/z.bin'], rect.x, rect.y);
  await waitFor_(async () => dropCard(), 20);
  ok('C6 closed panel → same coords hit confirm card', !!(await dropCard()));
  await page.keyboard.press('Escape');
  await sleep(200);

  // C7 切标签使未确认目标失效（§354 不静默改投）：先重开面板聚焦原会话，drop 出卡，
  // 切到种子会话标签 → 卡消失 + 明确 toast；两会话均无 z.bin 上传任务
  await openPanel();
  await sleep(400);
  const nBeforeC7 = await baseCount();
  await dropAt(['/Users/demo/Desktop/z.bin'], 300, 400);
  await waitFor_(async () => dropCard(), 20);
  ok('C7 card open before switch', !!(await dropCard()));
  await page.evaluate(() => {
    const tab = [...document.querySelectorAll('.tab')].find((t) => t.textContent.includes('staging-1'));
    tab?.click();
  });
  const toastSeen = await waitFor_(async () => (await toasts()).some((t) => (t || '').includes('目标会话已切换')), 20);
  ok('C7b switch dismisses card + explicit toast', toastSeen && !(await dropCard()), JSON.stringify(await toasts()));
  await sleep(300);
  const c7tasks = await demoInvoke('list_transfers');
  ok('C7c no silent retarget upload', c7tasks.length === nBeforeC7 && !c7tasks.some((t) => t.source.endsWith('z.bin')),
    JSON.stringify(c7tasks.map((t) => t.source)));
  // 切回原会话标签（收尾状态卫生）
  await page.evaluate(() => {
    const tabs = [...document.querySelectorAll('.tab')];
    tabs.find((t) => t.textContent.includes('prod-1'))?.click();
  });
  await sleep(400);

  // C8（rev 低-2）确认卡目录先解析归一：不存在路径 → 卡保持打开 + 明确错误行 + 零上传；
  // 含 .. 的路径 → 按 canonical 上传
  const nBeforeC8 = await baseCount();
  await dropAt(['/Users/demo/Desktop/c8.bin'], 300, 400);
  await waitFor_(async () => dropCard(), 20);
  await setNativeValue('[data-testid="drop-dir-input"]', '/nope/missing');
  await page.click('[data-testid="drop-confirm"]');
  const errLine = await waitFor_(async () => page.$eval('[data-testid="drop-err"]', (el) => el.textContent).catch(() => null), 20);
  ok('C8 bad dir → card stays + explicit error', !!(await dropCard()) && (errLine || '').length > 0, String(errLine));
  ok('C8b no upload on failed resolve', (await baseCount()) === nBeforeC8);
  await setNativeValue('[data-testid="drop-dir-input"]', '/root/deploy/../deploy');
  await page.click('[data-testid="drop-confirm"]');
  const c8Task = await waitFor_(async () => {
    const l = await demoInvoke('list_transfers');
    return l.find((t) => t.kind === 'Upload' && t.source === '/Users/demo/Desktop/c8.bin') ?? null;
  }, 30);
  ok('C8c dotdot path canonicalized', !!c8Task && c8Task.dest === '/root/deploy/c8.bin', String(c8Task?.dest));
  await waitFor_(async () => demoInvoke('list_transfers').then((l) => l.every((t) => ['Succeeded', 'Failed', 'Cancelled'].includes(t.status))), 40);
  await sleep(200);

  // ---- D §354 不可见面板路径不借用（rev 中-1 判别；demo_brief_cwd 覆写 brief cwd）----
  // D0 前导航到 /root/deploy（≠ cwd）：此后「定位钮禁用」才是 brief.cwd=null 的无歧义
  // 信号（若 brief 仍是 /var/log/nginx 且浏览 /root/deploy，定位钮应为 enabled）
  await page.click('.sftp-nav button[aria-label="切换路径输入"]');
  await page.waitForSelector('[data-testid="sftp-path-input"]', { timeout: 3000 });
  await setNativeValue('[data-testid="sftp-path-input"]', '/root/deploy');
  await page.keyboard.press('Enter');
  await waitFor_(async () => (await crumbs()) === '/root/deploy' ? true : null, 30);
  ok('D0 panel browsing /root/deploy', (await crumbs()) === '/root/deploy', await crumbs());
  const locateBtn = () => page.$eval('.sftp-nav button[aria-label="定位到终端目录"]', (b) => b.disabled).catch(() => null);
  ok('D0b locate enabled (cwd=/var/log/nginx ≠ browsing)', (await locateBtn()) === false, String(await locateBtn()));
  await demoInvoke('demo_brief_cwd', { cwd: null });
  await waitFor_(async () => (await locateBtn()) === true ? true : null, 40);
  await dropAt(['/Users/demo/Desktop/d1.bin'], 300, 400);
  await waitFor_(async () => dropCard(), 20);
  let v = await (await dropCard()).evaluate((el) => el.value);
  ok('D1 visible panel path prefilled', v === '/root/deploy', v);
  await page.evaluate(() => { [...document.querySelectorAll('.confirm-dialog button')].find((b) => b.textContent === '取消')?.click(); });
  await sleep(200);
  // D2 面板关闭 + 无可信 cwd → 预填空 + 确认禁用 + 提示行出现（不借用不可见旧路径）
  await page.evaluate(() => { document.querySelector('.task-panel .tp-head button[aria-label="关闭任务面板"]')?.click(); });
  await sleep(300);
  await dropAt(['/Users/demo/Desktop/d2.bin'], 300, 400);
  await waitFor_(async () => dropCard(), 20);
  v = await (await dropCard()).evaluate((el) => el.value);
  const hintVisible = !!(await page.$('[data-testid="drop-no-cwd-hint"]'));
  const confirmDis2 = await page.$eval('[data-testid="drop-confirm"]', (b) => b.disabled);
  ok('D2 invisible panel path NOT borrowed', v === '' && hintVisible && confirmDis2 === true,
    JSON.stringify({ prefill: v, hintVisible, confirmDis2 }));
  await page.keyboard.press('Escape');
  await sleep(200);
  // D3 cwd 可信恢复（面板仍关）→ 预填=可信 cwd 本身；定位钮随 brief 恢复转 enabled
  await demoInvoke('demo_brief_cwd', { cwd: '/var/log' });
  await waitFor_(async () => (await locateBtn()) === false ? true : null, 40).catch(() => {});
  await dropAt(['/Users/demo/Desktop/d3.bin'], 300, 400);
  await waitFor_(async () => dropCard(), 20);
  v = await (await dropCard()).evaluate((el) => el.value);
  ok('D3 trusted cwd prefilled (panel closed)', v === '/var/log', v);
  await page.keyboard.press('Escape');
  await demoInvoke('demo_brief_cwd', {});
  await openPanel();
  await sleep(400);

  // ---- Z 零 JS 错 ----
  ok('Z zero JS errors', jsErrors.length === 0, JSON.stringify(jsErrors));

  const passed = results.filter((r) => r.pass).length;
  console.log(`SUMMARY ${passed}/${results.length}`);
  await browser.close();
  process.exit(passed === results.length ? 0 : 1);
})().catch((e) => { console.error('PROBE-CRASH', e); process.exit(2); });
