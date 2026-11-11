// 84 整体视觉连贯性：活动栏当前态与设置导航同族；浮层统一轻淡入。
// 只断言真实计算样式和几何稳定性，不引入跨平台像素基线。
module.exports = {
  title: "全局导航层次与浮层动效",
  async run({ page, ck }) {
    const railStyle = (testid) => page.locator(`[data-testid="${testid}"]`).evaluate((el) => {
      const probe = document.createElement("div");
      probe.style.color = "var(--accent-ring)";
      const accent = document.createElement("div");
      accent.style.color = "var(--accent)";
      document.body.append(probe, accent);
      const cs = getComputedStyle(el);
      const out = {
        border: cs.borderTopColor,
        ring: getComputedStyle(probe).color,
        shadow: cs.boxShadow,
        accent: getComputedStyle(accent).color,
      };
      probe.remove(); accent.remove();
      return out;
    });

    const hosts = await railStyle("rail-hosts");
    ck.check("左活动栏当前态使用与设置导航一致的 accent 细环",
      hosts.border === hosts.ring, JSON.stringify(hosts));
    ck.check("左活动栏朝内容侧有 2px 内侧当前标识",
      hosts.shadow.includes(hosts.accent) && hosts.shadow.includes("2px"), hosts.shadow);

    await page.evaluate(() => {
      [...document.querySelectorAll(".tab")].find((tab) => tab.textContent.trim().startsWith("prod-1"))?.click();
    });
    await page.waitForTimeout(600);
    await page.click('[data-testid="rb-files"]');
    await page.waitForFunction(() => document.querySelector('[data-testid="rb-files"]')?.classList.contains("ts-open"));
    await page.waitForTimeout(180); // 等 120ms 色彩/内标识过渡落定，不读中间帧
    const files = await railStyle("rb-files");
    ck.check("右活动栏复用同一套细环而非实心高亮",
      files.border === files.ring, JSON.stringify(files));
    ck.check("右活动栏当前标识朝左镜像且选中跟随面板",
      files.shadow.includes(files.accent) && files.shadow.includes("-2px"), files.shadow);
    await page.click('[data-testid="rb-files"]');

    await page.click('[data-testid="quick-connect-open"]');
    const quick = page.locator('[data-testid="quick-connect-dialog"]');
    await quick.waitFor({ state: "visible" });
    ck.check("对话框与菜单共用轻量 surface-enter 淡入",
      await quick.evaluate((el) => getComputedStyle(el).animationName === "surface-enter"));
    const before = await quick.boundingBox();
    await page.waitForTimeout(180);
    const after = await quick.boundingBox();
    ck.check("淡入只改变透明度，不引发布局位移",
      JSON.stringify(before) === JSON.stringify(after), JSON.stringify({ before, after }));
    await page.keyboard.press("Escape");

    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.click('[data-testid="quick-connect-open"]');
    await quick.waitFor({ state: "visible" });
    ck.check("减少动画模式下浮层直接呈现",
      await quick.evaluate((el) => getComputedStyle(el).animationName === "none"));
    await page.keyboard.press("Escape");

    await page.emulateMedia({ reducedMotion: "no-preference" });
    await page.evaluate(() => {
      document.documentElement.dataset.theme = "eink";
      document.documentElement.dataset.chrome = "light";
    });
    await page.click('[data-testid="rail-settings"]');
    const settings = page.locator(".settings-wide");
    await settings.waitFor({ state: "visible" });
    const eink = await settings.evaluate((el) => ({
      animation: getComputedStyle(el).animationName,
      shadow: getComputedStyle(el).boxShadow,
    }));
    const einkRail = await railStyle("rail-settings");
    ck.check("墨水屏保持无动画无灰雾阴影", eink.animation === "none" && eink.shadow === "none", JSON.stringify(eink));
    ck.check("墨水屏当前导航保留实色描边兜底", einkRail.border === einkRail.accent, JSON.stringify(einkRail));
  },
};
