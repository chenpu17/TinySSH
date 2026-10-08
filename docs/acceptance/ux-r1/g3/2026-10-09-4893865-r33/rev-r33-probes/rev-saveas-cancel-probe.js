// rev-r33 mini 探针：另存为「取消」路径零副作用（§356）。
// demo 桩约定：saveResult=""（空串非 null）= 模拟用户取消（pick_save_file 返回 ""）。
// 断言：取消后 (1) 不建 Download 卡 (2) blob transfers.download_dir 不变 (3) 后续普通
// 下载仍落原记忆目录（downloadDirRef 未被污染）。
const { chromium } = require('/Users/chenpu/node_modules/playwright');
const EXE = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const URL = process.env.PROBE_URL || 'http://localhost:5183/';
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
  await page.evaluate(() => {
    const card = [...document.querySelectorAll('.host-card')].find((c) => c.querySelector('.host-name')?.textContent.includes('prod-1'));
    card?.querySelector('.host-connect-btn')?.click();
  });
  await page.waitForSelector('.hk-mask', { timeout: 4000 }).catch(() => {});
  await page.evaluate(() => {
    [...document.querySelectorAll('.hk-mask button')].find((x) => x.textContent.includes('信任并连接'))?.click();
  });
  await waitFor_(async () => (await demoInvoke('list_sessions')).some((x) => x.state === 'Connected'), 60);
  await page.evaluate(() => { document.querySelector('.st-file')?.click(); });
  await page.waitForSelector('[data-testid="sftp-list"]', { timeout: 5000 });
  await sleep(500);
  const blobDir = () => page.evaluate(() => {
    try { return JSON.parse(localStorage.getItem('ui.v2.workspace'))?.transfers?.download_dir ?? null; } catch { return null; }
  });
  const n0 = (await demoInvoke('list_transfers')).length;

  // 第 1 步：先建立记忆目录（另存为预置 /Users/demo/Desktop/keep1.yml → 记忆 /Users/demo/Desktop）
  await demoInvoke('demo_pick_result', { path: '/Users/demo/Desktop/keep1.yml' });
  await page.dblclick('[data-testid="sftp-list"] .sftp-row[data-name="access.log"] .sftp-name').catch(() => {});
  // /var/log/nginx 种子行可能无 access.log——改用第一行文件
  let rowName = await page.evaluate(() => {
    const r = [...document.querySelectorAll('[data-testid="sftp-list"] .sftp-row')].find((x) => !x.className.includes('dir'));
    r?.querySelector('.sftp-name')?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    return r?.dataset.name ?? null;
  });
  await page.waitForSelector('[data-testid="sftp-menu-saveas"]', { timeout: 3000 });
  await page.click('[data-testid="sftp-menu-saveas"]');
  await waitFor_(async () => (await demoInvoke('list_transfers')).some((t) => t.kind === 'Download'), 30);
  const dir1 = await blobDir();
  const n1 = (await demoInvoke('list_transfers')).length;

  // 第 2 步：另存为取消（saveResult=""）→ 断言零副作用
  await demoInvoke('demo_pick_result', { path: '' });
  await page.evaluate(() => {
    const r = [...document.querySelectorAll('[data-testid="sftp-list"] .sftp-row')].find((x) => !x.className.includes('dir'));
    r?.querySelector('.sftp-name')?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
  });
  await page.waitForSelector('[data-testid="sftp-menu-saveas"]', { timeout: 3000 });
  await page.click('[data-testid="sftp-menu-saveas"]');
  await sleep(600);
  const n2 = (await demoInvoke('list_transfers')).length;
  const dir2 = await blobDir();
  const a1 = n2 === n1;
  const a2 = dir2 === dir1;

  // 第 3 步：普通下载仍落原记忆目录
  await demoInvoke('demo_pick_result', {});
  await page.evaluate(() => {
    const r = [...document.querySelectorAll('[data-testid="sftp-list"] .sftp-row')].find((x) => !x.className.includes('dir'));
    const dl = r?.querySelector('.sftp-dl');
    dl?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  const dl = await waitFor_(async () => {
    const l = await demoInvoke('list_transfers');
    return l.filter((t) => t.kind === 'Download').sort((a, b) => (a.created_at < b.created_at ? 1 : -1))[0] ?? null;
  }, 30);
  const a3 = !!dl && dl.dest.startsWith('/Users/demo/Desktop/');
  console.log(`saveAs-cancel: no-new-card=${a1} (${n1}->${n2}), blob-unchanged=${a2} (${dir1}), next-plain-lands-lastdir=${a3} (${dl?.dest})`);
  console.log(`first row used: ${rowName}`);
  console.log(`JS errors: ${JSON.stringify(jsErrors)}`);
  console.log((a1 && a2 && a3 && jsErrors.length === 0) ? 'PASS saveAs-cancel zero side effects' : 'FAIL saveAs-cancel side effects detected');
  await browser.close();
  process.exit((a1 && a2 && a3 && jsErrors.length === 0) ? 0 : 1);
})().catch((e) => { console.error('PROBE-CRASH', e); process.exit(2); });
