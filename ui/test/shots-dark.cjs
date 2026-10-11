const { freshContext, openDemo, BASE } = require("D:/workspace/tiny-ssh/ui/test/harness.cjs");
(async () => {
  const ctx = await freshContext();
  const { page } = ctx;
  await page.goto(`${BASE}/`, { waitUntil: "networkidle" });
  await page.waitForSelector(".hostbar", { timeout: 10000 });
  await page.evaluate(() => { document.documentElement.dataset.chrome = "dark"; });
  await page.waitForTimeout(400);
  await page.click('.tab .tab-label:text-is("prod-1")').catch(() => {});
  await page.waitForTimeout(700);
  await page.screenshot({ path: process.env.SHOT_OUT || "D:/workspace/tiny-ssh/.ux-shots/dark-session.png" });
  await ctx.browser.close();
  console.log("done");
})().catch((e) => { console.error(e); process.exit(1); });
