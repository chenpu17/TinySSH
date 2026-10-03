// 独立复验 §5：双主题全屏证据 ×8（主机 hover / 会话三栏全景 / 添加主机表单 / Toast 瞬间）
const { chromium } = require("playwright-core");
const EXE = "/Users/chenpu/Library/Caches/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-mac-arm64/chrome-headless-shell";
const BASE = "http://localhost:5183";

(async () => {
  const browser = await chromium.launch({ executablePath: EXE });
  for (const theme of ["dark", "light"]) {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    await ctx.addInitScript((t) => { try { localStorage.setItem("ui.theme", t); } catch {} }, theme);
    const page = await ctx.newPage();
    await page.goto(BASE + "/", { waitUntil: "networkidle" });
    await page.waitForSelector(".host-card");

    // 1) 主机列表 hover 态（hover prod-2 卡：操作组浮现）
    const card = page.locator('.host-card:has-text("prod-2")');
    await card.hover();
    await page.waitForTimeout(350); // 等 0.12s 过渡完成
    await page.screenshot({ path: `/tmp/recheck_${theme}_hover.png` });

    // 2) 会话三栏全景（含任务目标/现场简报/操作记录）
    await page.click('.tab:has-text("prod-1")');
    await page.waitForSelector(".goal-input");
    await page.waitForFunction(() => (document.querySelector(".goal-input") || {}).value?.length > 0, null, { timeout: 5000 });
    await page.waitForTimeout(600);
    await page.screenshot({ path: `/tmp/recheck_${theme}_panorama.png` });

    // 3) 添加主机表单（远端编码独占行）
    await page.click('button[aria-label="添加主机"]');
    await page.waitForSelector(".add-host select");
    await page.waitForTimeout(300);
    await page.screenshot({ path: `/tmp/recheck_${theme}_addhost.png` });
    await page.keyboard.press("Escape"); // 关表单（避免挡住后面 toast 场景）

    // 4) Toast 出现瞬间（保存任务目标触发）
    await page.waitForTimeout(300);
    await page.locator(".goal-input").fill("复验用临时目标——验证 toast 通道");
    await page.click('.section:has(h4:text("任务目标")) button:has-text("保存")');
    await page.waitForSelector(".toast.ok", { timeout: 4000 });
    await page.screenshot({ path: `/tmp/recheck_${theme}_toast.png` });
    await ctx.close();
    console.log(`${theme}: 4 shots done`);
  }
  await browser.close();
})().catch((e) => { console.error("RECHECK ERROR:", e); process.exit(1); });
