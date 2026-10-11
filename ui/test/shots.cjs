// 临时脚本：抓 UI 改版前后的对比截图（不入库）。
const fs = require("fs");
const { freshContext, openDemo, BASE } = require("./harness.cjs");

const OUT = process.env.SHOT_DIR || ".";
const prefix = process.env.SHOT_PREFIX || "shot";

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const ctx = await freshContext();
  const { page } = ctx;

  // 1) 全新安装欢迎页（?fresh 清空种子态）
  await page.goto(`${BASE}/?fresh`, { waitUntil: "networkidle" });
  await page.waitForSelector(".hostbar", { timeout: 10000 });
  await page.waitForTimeout(900);
  await page.screenshot({ path: `${OUT}/${prefix}-dark-welcome.png` });

  // 2) 常规首页（带种子会话）
  await page.goto(`${BASE}/`, { waitUntil: "networkidle" });
  await page.waitForSelector(".hostbar", { timeout: 10000 });
  await page.waitForTimeout(900);
  await page.screenshot({ path: `${OUT}/${prefix}-dark-main.png` });

  // 3) 选中 prod-1 会话（终端视图 + 右栏）
  await page.click('.tab .tab-label:text-is("prod-1")').catch(() => {});
  await page.waitForTimeout(700);
  await page.screenshot({ path: `${OUT}/${prefix}-dark-session.png` });

  // 4) 设置对话框
  await page.click(".hb-settings").catch(() => {});
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${OUT}/${prefix}-dark-settings.png` });
  await page.keyboard.press("Escape").catch(() => {});
  await page.mouse.click(700, 500).catch(() => {});
  await page.waitForTimeout(300);

  // 5) 浅色主题同视图
  await page.evaluate(() => { document.documentElement.dataset.chrome = "light"; });
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${OUT}/${prefix}-light-session.png` });

  await ctx.browser.close();
  console.log("shots done ->", OUT);
}

main().catch((e) => { console.error(e); process.exit(1); });
