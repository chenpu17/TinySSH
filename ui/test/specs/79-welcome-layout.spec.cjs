// 79 欢迎页布局：矮窗口 / 125% 界面字号下的首屏完整性与可滚动性。
// 首轮（KI-028）修的是 flex 垂直居中把卡片顶部裁到负偏移、滚不回去；本轮再修两处
// 让最小窗口真的「一屏可用」：卡片宽度随 --ui-font-scale 缩放（125% 下 470→588，
// 正文换行减少），且 ≤700px 高的窗口收紧纵向留白、收起与标签条重复的底部状态句。
// 结果（实测）：960×600@100% 卡高 525→429、四钮全见；960×600@125% 637→487、
// 四钮全见；1200×640@125% 637→487，卡片整张进屏。
module.exports = {
  title: "欢迎页布局：矮窗口/125% 下首屏保住主行动钮，卡片顶部不被裁掉",
  async run({ page, ck, BASE }) {
    const open = async (w, h, scale) => {
      await page.setViewportSize({ width: w, height: h });
      await page.goto(`${BASE}/`, { waitUntil: "networkidle" });
      await page.evaluate((s) => localStorage.setItem("ui.ui_font_scale", String(s)), scale);
      await page.reload({ waitUntil: "networkidle" });
      await page.waitForTimeout(1100);
      return page.evaluate(() => {
        const w = document.querySelector(".welcome");
        const b = document.querySelector(".welcome-box");
        const k = document.querySelector(".welcome-mark");
        const r = (el) => { const x = el.getBoundingClientRect(); return { top: Math.round(x.top), bottom: Math.round(x.bottom), height: Math.round(x.height), width: Math.round(x.width) }; };
        return {
          vh: innerHeight,
          welcome: { ...r(w), scrollTop: w.scrollTop, scrollH: w.scrollHeight, clientH: w.clientHeight },
          box: r(b), mark: r(k),
          actions: [...document.querySelectorAll(".welcome-actions button")].map((x) => r(x)),
          note: getComputedStyle(document.querySelector(".welcome-note")).display,
          scaleVar: getComputedStyle(document.documentElement).getPropertyValue("--ui-font-scale").trim(),
        };
      });
    };

    // ── 最小窗口 + 最大字号：品牌标与四枚主行动钮都必须在首屏内 ──
    const min = await open(960, 600, 1.25);
    ck.check("960×600@125%：字号档已生效", min.scaleVar === "1.25", min.scaleVar);
    ck.check("960×600@125%：卡片顶部与品牌标完整可见",
      min.mark.top >= min.welcome.top && min.box.top >= min.welcome.top, JSON.stringify(min));
    ck.check("960×600@125%：四枚主行动钮全部落在可视区内（添加/快速/导入/本地终端）",
      min.actions.length === 4 && min.actions.every((a) => a.bottom <= min.welcome.bottom), JSON.stringify(min.actions));

    // 仍可滚到底再回顶（卡片底边不留永久不可达区域）
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
    ck.check("最小窗口：可滚到底且能滚回顶部",
      after.boxBottom <= after.welcomeBottom + 1 && after.topBack === 0, JSON.stringify(after));

    // ── 1200×640@125%：这一档应当整张卡片一屏放下（不再需要滚动） ──
    const mid = await open(1200, 640, 1.25);
    ck.check("1200×640@125%：卡片整张进入可视区（矮窗紧凑版生效）",
      mid.box.bottom <= mid.welcome.bottom + 1 && mid.welcome.scrollH <= mid.welcome.clientH + 1,
      JSON.stringify(mid));
    ck.check("1200×640@125%：矮窗收起底部状态句（与标签条信息重复）", mid.note === "none", mid.note);

    // ── 125% 下卡片宽度随字号同比放大（470→≈588），正文换行更少 ──
    const normal = await open(1440, 900, 1.25);
    ck.check("1440×900@125%：卡片宽度随界面字号缩放（>520px）",
      normal.box.width > 520, JSON.stringify(normal.box));
    ck.check("常规窗口：卡片仍垂直居中（上下留白相等）",
      Math.abs((normal.box.top - normal.welcome.top) - (normal.welcome.bottom - normal.box.bottom)) <= 2,
      JSON.stringify(normal));

    // ── 100% 常规窗口：宽度不放大，维持原设计节奏 ──
    const base = await open(1440, 900, 1);
    ck.check("100% 常规窗口：卡片宽度维持 470px",
      Math.abs(base.box.width - 470) <= 2, JSON.stringify(base.box));
  },
};
