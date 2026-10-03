// T38 审核修复批（v1.37）验证走查：
//  H1  任务目标跨会话串台：切到无目标会话，输入框必须立即清空（不得短暂显示 A 的目标）
//  低-8 goal 变迁进简报：保存目标后简报「控制权」fact 出现「人类更新任务目标（Agent 读简报可见）」
//  低-2 GBK 徽章置名前：hover 时徽章不被操作组遮挡（bbox 与 .host-card-side 不相交）
//  规格§六 连接 spinner：连接中按钮含 .spin 图标
const { chromium } = require("playwright-core");
const EXE = "/Users/chenpu/Library/Caches/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-mac-arm64/chrome-headless-shell";

(async () => {
  const browser = await chromium.launch({ executablePath: EXE });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const results = [];
  const check = (name, ok, detail = "") => { results.push(`${ok ? "PASS" : "FAIL"} ${name}${detail ? " — " + detail : ""}`); };

  await page.goto("http://localhost:5183/", { waitUntil: "networkidle" });
  await page.waitForSelector(".host-card", { timeout: 8000 });

  // ── H1：A（有目标）→ 新会话（无目标），切换瞬间目标框必须清空 ──
  await page.click('.tab:has-text("prod-1")');
  await page.waitForFunction(() => (document.querySelector(".goal-input") || {}).value?.length > 0, null, { timeout: 8000 });
  const aGoal = await page.$eval(".goal-input", (el) => el.value);
  // 新建一个会话（本机 localhost 主机，无目标）
  const before = await page.$$eval(".tab", (t) => t.length);
  await page.click('.host-card:has-text("本机") .host-card-main', { position: { x: 12, y: 12 } });
  await page.waitForFunction((n) => document.querySelectorAll(".tab").length > n, before, { timeout: 8000 });
  await page.waitForTimeout(100); // 切换后立刻采样——不给简报轮询回填的缓冲
  const bVal = await page.$eval(".goal-input", (el) => el.value);
  check("h1-goal-cleared-on-switch", bVal === "", `A 的目标 ${aGoal.length} 字；切换后新会话框值 ${JSON.stringify(bVal.slice(0, 20))}`);
  // 且随简报到达仍为空（B 无目标）
  await page.waitForTimeout(800);
  const bVal2 = await page.$eval(".goal-input", (el) => el.value);
  check("h1-goal-stays-empty", bVal2 === "", `简报到达后框值 ${JSON.stringify(bVal2.slice(0, 20))}`);

  // ── 低-8：在 B 保存目标 → 简报出现 goal 变迁 fact ──
  await page.fill(".goal-input", "审核批验证目标");
  await page.click('.section:has(h4:text("任务目标")) button:has-text("保存")');
  await page.waitForSelector('.toast:has-text("任务目标已更新")', { timeout: 5000 });
  await page.waitForFunction(() => {
    const els = [...document.querySelectorAll(".brief-fact")];
    return els.some((e) => e.textContent?.includes("人类更新任务目标"));
  }, null, { timeout: 8000 }).then(
    () => check("demo-goal-transition-in-brief", true),
    () => check("demo-goal-transition-in-brief", false, "简报控制权 fact 未出现 goal 变迁"),
  );

  // 切回 A：A 的目标还在（未受 B 操作影响）
  await page.click('.tab:has-text("prod-1")');
  await page.waitForTimeout(600);
  const aBack = await page.$eval(".goal-input", (el) => el.value);
  check("h1-a-goal-intact", aBack === aGoal, `${aBack.length} 字`);

  // ── 低-2：GBK 徽章 hover 不被遮挡 ──
  // 造一台 GBK 主机
  await page.click('button[aria-label="添加主机"]');
  await page.waitForSelector(".add-host select");
  await page.fill('.add-host input[placeholder="例：我的服务器"]', "审核-GBK");
  await page.fill('.add-host input[placeholder^="例：192"]', "192.168.77.7");
  await page.fill('.add-host input[placeholder="例：ops 或 root"]', "ops");
  await page.selectOption(".add-host select >> nth=1", "gbk");
  await page.fill('.add-host input[type="password"]', "x");
  await page.click('.add-host button:has-text("保存并连接")');
  await page.waitForSelector('.hk-dialog button:has-text("信任并连接")', { timeout: 8000 });
  await page.click('.hk-dialog button:has-text("信任并连接")');
  await page.waitForTimeout(600);
  const badgeVis = await page.$$eval(".host-card", (cards) => {
    const c = cards.find((x) => x.textContent.includes("审核-GBK"));
    if (!c) return { found: false };
    const badge = c.querySelector('.auth-tag[title="远端编码：GBK"]');
    const side = c.querySelector(".host-card-side");
    if (!badge || !side) return { found: true, badge: !!badge, side: !!side };
    const b = badge.getBoundingClientRect();
    const s = side.getBoundingClientRect();
    const overlap = !(b.right <= s.left || s.right <= b.left || b.bottom <= s.top || s.bottom <= b.top);
    return { found: true, badgeBox: [Math.round(b.x), Math.round(b.right)], sideBox: [Math.round(s.x), Math.round(s.right)], overlap };
  });
  check("gbk-badge-not-covered", badgeVis.found && badgeVis.overlap === false,
    JSON.stringify(badgeVis));
  // 徽章在名称之前（x 序）
  const orderOk = await page.$$eval(".host-card", (cards) => {
    const c = cards.find((x) => x.textContent.includes("审核-GBK"));
    const badge = c?.querySelector('.auth-tag[title="远端编码：GBK"]');
    const name = c?.querySelector(".host-name");
    return badge && name ? badge.getBoundingClientRect().x < name.getBoundingClientRect().x : false;
  });
  check("gbk-badge-before-name", orderOk);

  // ── 规格§六：连接中 spinner ──
  // hover 任一主机触发连接，捕捉 .host-connect-btn .spin 在场
  await page.hover('.host-card:has-text("prod-2")');
  let spinSeen = false;
  await page.click('.host-card:has-text("prod-2") .host-card-main', { position: { x: 12, y: 12 } }).catch(() => {});
  for (let i = 0; i < 20 && !spinSeen; i++) {
    spinSeen = await page.$(".host-connect-btn .spin") !== null;
    if (!spinSeen) await page.waitForTimeout(30);
  }
  check("connect-spinner", spinSeen, spinSeen ? "捕捉到 .spin" : "20 帧未捕捉（可能瞬时）");

  console.log(results.join("\n"));
  await browser.close();
})().catch((e) => { console.error("WALKTHROUGH ERROR:", e.message); process.exit(1); });
