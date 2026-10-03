// T38-PV 修复后证据截图：表单新布局 / GBK 徽章 / 目标框自动增高
const { chromium } = require("playwright-core");
const EXE = "/Users/chenpu/Library/Caches/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-mac-arm64/chrome-headless-shell";

(async () => {
  const browser = await chromium.launch({ executablePath: EXE });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await page.goto("http://localhost:5183/", { waitUntil: "networkidle" });
  await page.waitForSelector(".host-card", { timeout: 8000 });

  // 1) 表单：远端编码独占一行 + 用户名 placeholder
  await page.click('button[aria-label="添加主机"]');
  await page.waitForSelector(".add-host select");
  await page.screenshot({ path: "/tmp/pvfix_form.png", clip: { x: 0, y: 40, width: 240, height: 420 } });

  // 2) 新建 GBK 主机 → 列表 GBK 徽章
  await page.fill('.add-host input[placeholder="例：我的服务器"]', "老财务机-GBK");
  await page.fill('.add-host input[placeholder^="例：192"]', "192.168.9.21");
  await page.fill('.add-host input[placeholder="例：ops 或 root"]', "administrator");
  await page.selectOption(".add-host select >> nth=1", "gbk");
  await page.fill('.add-host input[type="password"]', "x");
  await page.click('.add-host button:has-text("保存并连接")');
  await page.waitForSelector('.hk-dialog button:has-text("信任并连接")', { timeout: 8000 });
  await page.click('.hk-dialog button:has-text("信任并连接")');
  await page.waitForTimeout(800);
  await page.screenshot({ path: "/tmp/pvfix_gbk_badge.png", clip: { x: 0, y: 40, width: 240, height: 500 } });

  // 3) 任务目标自动增高（长草稿）
  await page.click('.tab:has-text("prod-1")');
  await page.waitForFunction(() => (document.querySelector(".goal-input") || {}).value?.length > 0, null, { timeout: 8000 });
  await page.fill(".goal-input", "第一步：核实 /var/log/nginx 磁盘占用并打包日志；第二步：清理 /tmp/old-build；第三步：重新打包 dist 到 /tmp/build.tgz 后交还给我确认。");
  await page.waitForTimeout(300);
  await page.screenshot({ path: "/tmp/pvfix_goal_autogrow.png", clip: { x: 1000, y: 300, width: 280, height: 400 } });

  await browser.close();
  console.log("done");
})().catch((e) => { console.error("ERROR:", e.message); process.exit(1); });
