// 独立复验 §3：浅色主题 attach-hint pill 6s 生命周期 opacity 定量采样
// 判定「此前一帧褪淡」是过渡中间帧（settled 后 opacity=1 → 非缺陷）
// 还是浅色主题下稳定低透明度（settled opacity<1 → 真缺陷）。
// CSS：attach-hint-fade 6s ease forwards——0%,70% opacity 1；100% opacity 0；
// JS 侧 6000ms 后元素移除。70% 处 = 4200ms 开始淡出。
const { chromium } = require("playwright-core");
const EXE = "/Users/chenpu/Library/Caches/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-mac-arm64/chrome-headless-shell";
const BASE = "http://localhost:5183";

(async () => {
  const browser = await chromium.launch({ executablePath: EXE });
  const report = {};
  for (const theme of ["light", "dark"]) {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    await ctx.addInitScript((t) => { try { localStorage.setItem("ui.theme", t); } catch {} }, theme);
    const page = await ctx.newPage();
    await page.goto(BASE + "/", { waitUntil: "networkidle" });
    const chrome = await page.evaluate(() => document.documentElement.dataset.chrome);
    // 接入种子会话（首次 attach 触发 attachHint）
    await page.click('.tab:has-text("prod-1")');
    await page.waitForSelector(".attach-hint", { timeout: 8000 });
    const t0 = Date.now();
    const samples = [];
    while (Date.now() - t0 < 6800) {
      const s = await page.evaluate(() => {
        const el = document.querySelector(".attach-hint");
        if (!el) return null;
        return { opacity: getComputedStyle(el).opacity };
      });
      samples.push({ t: Date.now() - t0, ...s });
      await page.waitForTimeout(300);
    }
    // 浅色第一帧（settled 期）留证
    if (theme === "light") await page.screenshot({ path: "/tmp/recheck_attachhint_light.png" });
    const settled = samples.filter((s) => s.t >= 300 && s.t <= 3500 && s.opacity != null);
    const settledVals = settled.map((s) => Number(s.opacity));
    const settledMin = settledVals.length ? Math.min(...settledVals) : null;
    const settledMax = settledVals.length ? Math.max(...settledVals) : null;
    const firstFade = samples.find((s) => s.opacity != null && Number(s.opacity) < 0.99);
    const firstGone = samples.find((s) => s.opacity == null);
    const lastVals = samples.filter((s) => s.opacity != null).slice(-3).map((s) => `${s.t}ms:${s.opacity}`);
    report[theme] = {
      chrome, n: samples.length,
      settled: `${settledMin}–${settledMax}（n=${settledVals.length}）`,
      fadeOnset: firstFade ? `${firstFade.t}ms op=${firstFade.opacity}` : "未见",
      removedAt: firstGone ? `${firstGone.t}ms` : ">6800ms 仍在",
      tail: lastVals.join(" "),
      raw: samples.map((s) => `${s.t}:${s.opacity ?? "gone"}`).join(" "),
    };
    await ctx.close();
  }
  console.log(JSON.stringify(report, null, 2));
  await browser.close();
})().catch((e) => { console.error("RECHECK ERROR:", e); process.exit(1); });
