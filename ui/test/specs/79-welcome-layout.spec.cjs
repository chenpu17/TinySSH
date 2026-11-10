// 79 欢迎页布局：矮窗口 + 125% 界面字号时，内容高于视口也必须从顶部完整可达。
// 回归用户 2026-11-10 启动截图：欢迎卡比可视区高，flex 垂直居中把卡片顶部（品牌标）
// 裁到视口外，滚动只能向下、够不到顶部——像页面坏了。
module.exports = {
  title: "欢迎页布局：矮窗口/大字号下卡片顶部不被裁掉且可滚到底",
  async run({ page, ck, BASE }) {
    await page.setViewportSize({ width: 1200, height: 640 });
    await page.goto(`${BASE}/`, { waitUntil: "networkidle" });
    await page.evaluate(() => localStorage.setItem("ui.ui_font_scale", "1.25"));
    await page.reload({ waitUntil: "networkidle" });
    await page.waitForTimeout(1200);

    const m = await page.evaluate(() => {
      const w = document.querySelector(".welcome");
      const b = document.querySelector(".welcome-box");
      const k = document.querySelector(".welcome-mark");
      const r = (el) => { const x = el.getBoundingClientRect(); return { top: Math.round(x.top), bottom: Math.round(x.bottom), height: Math.round(x.height) }; };
      return {
        vh: innerHeight,
        welcome: { ...r(w), scrollTop: w.scrollTop, scrollH: w.scrollHeight, clientH: w.clientHeight },
        box: r(b), mark: r(k),
      };
    });
    ck.check("矮窗口 + 125%：欢迎卡比可视区高（场景成立）",
      m.box.height > m.welcome.clientH, JSON.stringify(m));
    ck.check("卡片顶部与品牌标完整可见（不再被垂直居中裁掉）",
      m.mark.top >= m.welcome.top && m.box.top >= m.welcome.top,
      JSON.stringify(m));
    ck.check("卡片底部超出可视区时容器可滚动",
      m.welcome.scrollH > m.welcome.clientH, JSON.stringify(m));

    // 滚到底：末行与卡片底边可达，且顶部仍可滚回
    const after = await page.evaluate(() => {
      const w = document.querySelector(".welcome");
      w.scrollTop = w.scrollHeight;
      const b = document.querySelector(".welcome-box").getBoundingClientRect();
      const wr = w.getBoundingClientRect();
      const r = { scrollTop: Math.round(w.scrollTop), boxBottom: Math.round(b.bottom), welcomeBottom: Math.round(wr.bottom) };
      w.scrollTop = 0;
      r.topBack = Math.round(w.scrollTop);
      return r;
    });
    ck.check("滚到底：卡片底边进入可视区且能滚回顶部",
      after.boxBottom <= after.welcomeBottom + 1 && after.scrollTop > 0 && after.topBack === 0,
      JSON.stringify(after));

    // 常规窗口仍垂直居中（auto 外边距在空间足够时等价原居中）
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.evaluate(() => localStorage.setItem("ui.ui_font_scale", "1"));
    await page.reload({ waitUntil: "networkidle" });
    await page.waitForTimeout(900);
    const centered = await page.evaluate(() => {
      const w = document.querySelector(".welcome");
      const b = document.querySelector(".welcome-box");
      const wr = w.getBoundingClientRect();
      const br = b.getBoundingClientRect();
      return {
        gapTop: Math.round(br.top - wr.top),
        gapBottom: Math.round(wr.bottom - br.bottom),
        scrollH: w.scrollHeight, clientH: w.clientHeight,
      };
    });
    ck.check("常规窗口：卡片仍垂直居中（上下留白相等）",
      Math.abs(centered.gapTop - centered.gapBottom) <= 2,
      JSON.stringify(centered));
  },
};
