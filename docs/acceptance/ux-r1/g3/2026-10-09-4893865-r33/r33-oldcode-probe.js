// R33 旧码判别力实证（基线 4893865 = R31 终态，:5184）：
// 判别点 = R33 新面在旧码全部缺席或行为不同——
// O1 面板「上传」钮缺席；O2 pick_upload_files 命令未实现；
// O3 pick_save_file 命令未实现；O4 动作菜单无「另存为」项；
// O5 window.__demoDrop 拖放钩子未注册（demo_drag_drop 不可判别）；
// O6 旧拖放语义：旧码无确认卡——直接上传且目标=浏览目录/简报 cwd（无分区语义）；
// O7 下载无「上次目录」记忆：普通下载 dest=系统 Downloads（无 transfers blob 域）
const { chromium } = require('/Users/chenpu/node_modules/playwright');
const EXE = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const URL = process.env.PROBE_URL || 'http://localhost:5184/';
const results = [];
const ok = (name, cond, detail = '') => { results.push({ name, pass: !!cond }); console.log((cond ? 'PASS ' : 'FAIL ') + name + (detail ? '  [' + detail + ']' : '')); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const browser = await chromium.launch({ executablePath: EXE, headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();
  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => { try { localStorage.clear(); } catch {} });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.host-card', { timeout: 10000 });
  await sleep(400);

  const demoInvoke = (cmd, args) => page.evaluate(async ({ c, a }) => {
    const { invoke } = await import('/src/adapter/bridge.ts');
    return invoke(c, a);
  }, { c: cmd, a: args });
  const tryInvoke = (cmd, args) => page.evaluate(async ({ c, a }) => {
    const { invoke } = await import('/src/adapter/bridge.ts');
    try { await invoke(c, a); return 'ok'; } catch (e) {
      return typeof e === 'object' ? JSON.stringify(e) : String(e);
    }
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
  const openPanel = async () => {
    await page.evaluate(() => { document.querySelector('.st-file')?.click(); });
    await page.waitForSelector('[data-testid="sftp-list"]', { timeout: 5000 }).catch(() => {});
  };

  await connectHost('prod-1');
  await openPanel();
  await sleep(500);

  // O1 上传钮缺席
  const upBtn = await page.$('[data-testid="sftp-upload-btn"]');
  ok('O1 old code: no upload button', !upBtn);

  // O2 pick_upload_files 未实现
  const o2err = await tryInvoke('pick_upload_files');
  ok('O2 old code: pick_upload_files unimplemented', o2err.includes('未实现'), o2err.slice(0, 80));

  // O3 pick_save_file 未实现
  const o3err = await tryInvoke('pick_save_file', { defaultName: 'a.txt' });
  ok('O3 old code: pick_save_file unimplemented', o3err.includes('未实现'), o3err.slice(0, 80));

  // O4 动作菜单无另存为
  await page.evaluate(() => {
    const row = [...document.querySelectorAll('[data-testid="sftp-list"] .sftp-row')].find((r) => r.dataset.name === 'access.log');
    const nm = row?.querySelector('.sftp-name');
    nm?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
  });
  await page.waitForSelector('[data-testid="sftp-menu"]', { timeout: 3000 }).catch(() => {});
  const saveAs = await page.$('[data-testid="sftp-menu-saveas"]');
  ok('O4 old code: no save-as menu item', !saveAs);
  await page.keyboard.press('Escape');

  // O5 拖放钩子未注册
  const hasHook = await page.evaluate(() => typeof window.__demoDrop === 'function');
  ok('O5 old code: no __demoDrop hook', !hasHook);

  // O6 旧拖放语义：Tauri 通道浏览器域不存在——旧码没有任何可触发的拖放路径
  //（新码在 demo 域有 demo_drag_drop 判别钩子）→ demo_drag_drop 命令本身未实现
  const o6err = await tryInvoke('demo_drag_drop', { paths: ['/tmp/a.txt'], x: 300, y: 400 });
  ok('O6 old code: demo_drag_drop unimplemented (no drop path at all)', o6err.includes('未实现'), o6err.slice(0, 80));

  // O7 下载目标：旧码恒 null → 系统目录；无 transfers blob 域写入
  await page.evaluate(() => {
    const row = [...document.querySelectorAll('[data-testid="sftp-list"] .sftp-row')].find((r) => r.dataset.name === 'access.log');
    const btn = row?.querySelector('.sftp-dl');
    btn?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  const dl = await waitFor_(async () => {
    const l = await demoInvoke('list_transfers');
    return l.find((t) => t.kind === 'Download') ?? null;
  }, 30);
  ok('O7 old code: download dest = system Downloads (no last-dir memory)', !!dl && dl.dest === '~/Downloads/access.log', String(dl?.dest));
  const blobDomain = await page.evaluate(() => {
    try { return JSON.parse(localStorage.getItem('ui.v2.workspace'))?.transfers ?? 'absent'; } catch { return 'absent'; }
  });
  ok('O7b old code: no transfers blob domain', blobDomain === 'absent', String(blobDomain));

  const passed = results.filter((r) => r.pass).length;
  console.log(`SUMMARY ${passed}/${results.length}`);
  await browser.close();
  process.exit(passed === results.length ? 0 : 1);
})().catch((e) => { console.error('PROBE-CRASH', e); process.exit(2); });
