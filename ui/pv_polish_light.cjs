// T38 走查补：浅色主题 + 三栏实测宽度
const { chromium } = require("playwright-core");
const EXE = "/Users/chenpu/Library/Caches/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-mac-arm64/chrome-headless-shell";
const OUT = "/tmp";

(async () => {
  const browser = await chromium.launch({ executablePath: EXE });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const shot = (n) => page.screenshot({ path: `${OUT}/pv_polish_${n}.png` });

  await page.goto("http://localhost:5183", { waitUntil: "networkidle" });
  await page.waitForSelector(".host-card", { timeout: 8000 });
  await page.waitForTimeout(400);

  // 三栏实测
  await page.locator(".tab", { hasText: "prod-1" }).first().click();
  await page.waitForSelector(".goal-input", { timeout: 8000 });
  await page.waitForTimeout(600);
  const widths = await page.evaluate(() => {
    const cols = [...document.querySelectorAll(".layout > .col")].map((c) => Math.round(c.getBoundingClientRect().width));
    return cols;
  });
  console.log("col widths (expect 220 / flex / 280):", JSON.stringify(widths));

  // 浅色主题
  await page.locator("button[aria-label='显示设置']").click();
  await page.waitForTimeout(300);
  const light = page.locator(".ts-opt", { hasText: "Aa浅色" });
  console.log("light option count:", await light.count());
  await light.click();
  await page.waitForTimeout(600);
  console.log("data-chrome:", await page.evaluate(() => document.documentElement.dataset.chrome));
  await shot("16_light_session");

  // 浅色下 placeholder 对比度数值
  const contrastL = await page.evaluate(() => {
    const el = document.querySelector(".goal-input");
    const ph = getComputedStyle(el, "::placeholder").color;
    const bg = getComputedStyle(el).backgroundColor;
    const lum = (c) => {
      const m = c.match(/[\d.]+/g).map(Number);
      const [r, g, b] = m.slice(0, 3).map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); });
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const L1 = lum(ph), L2 = lum(bg);
    return { ph, bg, ratio: Math.round(((Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05)) * 100) / 100 };
  });
  console.log("light placeholder contrast:", JSON.stringify(contrastL));

  // 浅色 goal 区特写（滚动到任务目标）
  await page.evaluate(() => document.querySelector(".goal-input")?.scrollIntoView({ block: "center" }));
  await page.waitForTimeout(300);
  await shot("17_light_goal");

  // 浅色 timeline
  await page.evaluate(() => {
    const els = document.querySelectorAll(".tl-row");
    if (els.length) els[els.length - 1].scrollIntoView({ block: "center" });
  });
  await page.waitForTimeout(300);
  await shot("18_light_timeline");

  // 浅色 toast：保存一次目标
  await page.locator(".goal-input").fill("浅色主题 toast 验证");
  await page.locator("button", { hasText: /^保存$/ }).click();
  await page.waitForTimeout(250);
  await shot("19_light_toast");

  // 回列表（浅色）
  await page.keyboard.press("Escape");
  await page.locator("button[aria-label='显示设置']").click(); // 关弹层
  await page.waitForTimeout(300);
  await shot("20_light_list");

  await browser.close();
  console.log("DONE");
})().catch((e) => { console.error("WALKTHROUGH ERROR:", e.message); process.exit(1); });
