// T38 走查补 2：浅色 toast + 浅色列表（先关设置弹层）
const { chromium } = require("playwright-core");
const EXE = "/Users/chenpu/Library/Caches/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-mac-arm64/chrome-headless-shell";

(async () => {
  const browser = await chromium.launch({ executablePath: EXE });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const shot = (n) => page.screenshot({ path: `/tmp/pv_polish_${n}.png` });

  await page.goto("http://localhost:5183", { waitUntil: "networkidle" });
  await page.waitForSelector(".host-card", { timeout: 8000 });
  await page.locator(".tab", { hasText: "prod-1" }).first().click();
  await page.waitForSelector(".goal-input", { timeout: 8000 });
  await page.waitForTimeout(500);

  // 开设置 → 浅色 → 关闭弹层（点 X）
  await page.locator("button[aria-label='显示设置']").click();
  await page.locator(".ts-opt", { hasText: "Aa浅色" }).click();
  await page.locator("button[aria-label='关闭显示设置']").click();
  await page.waitForTimeout(400);
  console.log("data-chrome:", await page.evaluate(() => document.documentElement.dataset.chrome));

  // 浅色 toast：改目标保存
  await page.locator(".goal-input").fill("浅色主题 toast 验证");
  await page.locator("button", { hasText: /^保存$/ }).click();
  await page.waitForTimeout(250);
  await shot("19_light_toast");
  console.log("light toast count:", await page.locator(".toast").count());

  // 浅色列表态 + hover
  await page.waitForTimeout(3200);
  await shot("20_light_list");
  await page.locator(".host-card").first().hover();
  await page.waitForTimeout(300);
  await shot("21_light_list_hover");

  await browser.close();
  console.log("DONE");
})().catch((e) => { console.error("WALKTHROUGH ERROR:", e.message); process.exit(1); });
