// T38-PV 修复验证走查：验证本轮 5 项修复
//  1) 表单：用户名 placeholder + 远端编码独占一行且完整可读（收起态显示全文）
//  2) 主机卡：悬浮操作组收窄后，卡片几何中心点击不被拦截（Playwright 默认中心点击即连接）
//  3) 主机卡：GBK 徽章 + title 编码行（新建 GBK 主机后）
//  4) 会话卡：截断名有 title 悬浮提示
//  5) 任务目标：textarea 自动增高 + 未保存草稿切标签不丢 + 清除 toast 新文案
const { chromium } = require("playwright-core");
const EXE = "/Users/chenpu/Library/Caches/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-mac-arm64/chrome-headless-shell";

(async () => {
  const browser = await chromium.launch({ executablePath: EXE });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const results = [];
  const check = (name, ok, detail = "") => { results.push(`${ok ? "PASS" : "FAIL"} ${name}${detail ? " — " + detail : ""}`); };

  await page.goto("http://localhost:5183/", { waitUntil: "networkidle" });
  await page.waitForSelector(".host-card", { timeout: 8000 });

  // ── 1) 表单布局 ──
  await page.click('button[aria-label="添加主机"]');
  await page.waitForSelector(".add-host select");
  const userPh = await page.$eval('.add-host .ah-field:nth-child(1) > .ah-field input, .add-host input[placeholder="例：ops 或 root"]', (el) => el.placeholder).catch(() => null);
  check("username-placeholder", userPh === "例：ops 或 root", userPh);
  const selects = await page.$$eval(".add-host select", (els) => els.map((e) => Math.round(e.getBoundingClientRect().width)));
  // 两个 select：认证方式（行内 ~85px+）、远端编码（独占一行应 >150px）
  check("charset-select-fullrow", selects.length === 2 && selects[1] > 150, `widths=${JSON.stringify(selects)}`);
  const charsetLabel = await page.$$eval(".add-host .ah-field label", (els) => els.map((e) => e.textContent).join("|"));
  check("charset-label-hint", charsetLabel.includes("老设备中文乱码时选 GBK"), charsetLabel);

  // ── 3) 新建 GBK 主机 → 徽章 + title ──
  await page.fill('.add-host input[placeholder="例：我的服务器"]', "pv-gbk-机");
  await page.fill('.add-host input[placeholder^="例：192"]', "192.168.99.9");
  await page.fill('.add-host input[placeholder="例：ops 或 root"]', "ops");
  await page.selectOption(".add-host select >> nth=1", "gbk");
  await page.fill('.add-host input[type="password"]', "x");
  await page.click('.add-host button:has-text("保存并连接")');
  // TOFU 弹窗
  await page.waitForSelector('.hk-dialog button:has-text("信任并连接")', { timeout: 8000 });
  await page.click('.hk-dialog button:has-text("信任并连接")');
  await page.waitForTimeout(600);
  const gbkBadge = await page.$$eval(".host-card", (cards) =>
    cards.filter((c) => c.textContent.includes("pv-gbk-机")).map((c) => c.querySelectorAll(".auth-tag").length));
  check("gbk-badge", gbkBadge.length === 1 && gbkBadge[0] >= 2, `tags=${JSON.stringify(gbkBadge)}`);
  const gbkTitle = await page.$$eval(".host-card", (cards) =>
    (cards.find((c) => c.textContent.includes("pv-gbk-机")) || {}).title || "");
  check("gbk-title", gbkTitle.includes("编码：GBK"), gbkTitle.replace(/\n/g, "↵"));

  // ── 2) 中心点击不被悬浮组拦截 ──
  // hover 出新主机卡片后直接对 host-card-main 做默认（几何中心）点击，应成功发起连接
  const card = await page.$('.host-card:has-text("prod-1")');
  await card.hover();
  await page.waitForTimeout(300);
  const before = await page.$$eval(".tab", (t) => t.length);
  // 默认 click() 点几何中心——修复前此处会被 svg 拦截超时
  await page.click('.host-card:has-text("prod-1") .host-card-main', { timeout: 5000 });
  await page.waitForTimeout(1200);
  const after = await page.$$eval(".tab", (t) => t.length);
  check("center-click-connects", after > before, `tabs ${before}→${after}`);

  // ── 4) 会话卡 title ──
  const sessTitle = await page.$eval('.section:has(h4:text("会话")) [tabindex="0"]', (el) => el.title).catch(() => null);
  check("session-card-title", !!sessTitle && sessTitle.includes("·"), sessTitle);

  // ── 5) 任务目标：自动增高 + 草稿暂存 + 清除 toast 文案 ──
  // 接入种子会话 s-demo-0001（有种子 goal）
  await page.click('.tab:has-text("prod-1")');
  await page.waitForFunction(() => (document.querySelector(".goal-input") || {}).value?.length > 0, null, { timeout: 8000 });
  const h0 = await page.$eval(".goal-input", (el) => el.getBoundingClientRect().height);
  // 写入长草稿（~120 字，多行）
  const longGoal = "第一步：核实 /var/log/nginx 磁盘占用并打包日志；第二步：清理 /tmp/old-build；第三步：重新打包 dist 到 /tmp/build.tgz 后交还给我确认。";
  await page.fill(".goal-input", longGoal);
  await page.waitForTimeout(200);
  const h1 = await page.$eval(".goal-input", (el) => el.getBoundingClientRect().height);
  check("goal-autogrow", h1 > h0 + 15, `height ${Math.round(h0)}→${Math.round(h1)}`);
  // 不切走保存，直接切到另一个标签再切回——草稿应恢复
  const tabs = await page.$$(".tab");
  await tabs[tabs.length - 1].click();
  await page.waitForTimeout(400);
  await page.click('.tab:has-text("prod-1")');
  await page.waitForTimeout(600);
  const restored = await page.$eval(".goal-input", (el) => el.value);
  check("goal-draft-persist", restored === longGoal, `restored ${restored.length} chars`);
  // 保存（让目标落盘），再清除 → 检查 toast 文案
  await page.click('.section:has(h4:text("任务目标")) button:has-text("保存")');
  await page.waitForSelector('.toast:has-text("任务目标已更新")', { timeout: 5000 });
  await page.click('.section:has(h4:text("任务目标")) button:has-text("清除")');
  const clearToast = await page.waitForSelector('.toast:has-text("任务目标已清除")', { timeout: 5000 }).then((el) => el.textContent());
  check("clear-toast-wording", clearToast.includes("Agent 简报同步移除"), clearToast);

  await page.screenshot({ path: "/tmp/pvfix_01_form.png", clip: { x: 0, y: 0, width: 320, height: 800 } }).catch(() => {});
  console.log(results.join("\n"));
  await browser.close();
})().catch((e) => { console.error("WALKTHROUGH ERROR:", e.message); process.exit(1); });
