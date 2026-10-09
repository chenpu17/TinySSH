// R43 旧代码判别（对照 :5184 = R41 基线 9e1df70，C9 之前）：
// 证明 r43-demo-probe.js 的 C9 断言不是恒真——旧构建里 C9 命令与「新装默认停用」语义都不存在。
// 结果：旧构建上四个 C9 命令均为「未知命令」；?fresh 不具备停用闸（collab 面板无停用指引）。
const { chromium } = require('/Users/chenpu/node_modules/playwright');
const EXE = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const URL = process.env.PROBE_URL || 'http://localhost:5184/';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const browser = await chromium.launch({ executablePath: EXE, headless: true });
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.host-card', { timeout: 10000 });
  await sleep(500);
  const inv = (cmd, args) => page.evaluate(async ({ c, a }) => {
    const { invoke } = await import('/src/adapter/bridge.ts');
    try { return { ok: true, v: await invoke(c, a) }; }
    catch (e) { return { ok: false, e: String((e && e.message) || e).slice(0, 120) }; }
  }, { c: cmd, a: args });
  const cnt = (s) => page.evaluate((x) => document.querySelectorAll(x).length, s);

  for (const c of ['collab_status', 'collab_enable', 'collab_disable_preview', 'collab_disable']) {
    const r = await inv(c);
    console.log(`旧构建 ${c}: ${r.ok ? 'OK → ' + JSON.stringify(r.v).slice(0, 80) : 'ERR → ' + r.e}`);
  }
  // 旧构建 ?fresh：无停用闸
  await page.goto(URL + '?fresh', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.host-card', { timeout: 10000 });
  await sleep(600);
  const hasDisabledGuidance = await cnt('[data-testid="collab-disabled"]');
  const hasEnableBtn = await cnt('[data-testid="collab-enable-btn"]');
  const ms = await inv('mcp_status');
  console.log(`旧构建 ?fresh：collab-disabled 指引=${hasDisabledGuidance}，collab-enable-btn=${hasEnableBtn}，mcp 端点=${ms.ok ? JSON.stringify(ms.v.endpoint) : 'ERR'}`);
  await browser.close();
})();
