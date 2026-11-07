// 74 终端配色对比度：tmux 默认 status-style 是 bg=green,fg=black，message/mode/
// copy-mode 等也把黑字压在彩色底上。浅色色板为了正文对浅底 ≥4.5:1 必须同时压暗
// black 与彩色，实测这组默认样式只有约 1.04–1.07:1；深色色板也仅 3.95–4.50:1。
// 修复不走远端 tmux 配置（多客户端/崩溃残留难恢复），而是给 xterm 设
// minimumContrastRatio=4.5：按每个单元格实际前景/背景动态修正，主终端与 tmux
// 格子同口径，手动起的 tmux/htop/dialog 也一并覆盖。
const clickTab = async (page, label) => {
  const ok = await page.evaluate((l) => {
    const tab = [...document.querySelectorAll(".tab")].find((t) => t.textContent?.includes(l));
    if (!tab) return false;
    tab.click();
    return true;
  }, label);
  await page.waitForTimeout(700);
  return ok;
};

module.exports = {
  title: "终端对比度兜底：tmux/彩色底 TUI 的最小对比度，自绘格子焦点与死格配色",
  async run({ page, ck }) {
    await page.waitForTimeout(1200);
    ck.check("切到 prod-1", await clickTab(page, "prod-1"), "");

    const mainRatios = await page.evaluate(() => {
      const m = window.__t_terms;
      return m ? [...m.entries()].map(([k, t]) => ({ key: k, ratio: t.options.minimumContrastRatio })) : null;
    });
    ck.check("主终端已设 minimumContrastRatio=4.5",
      Array.isArray(mainRatios) && mainRatios.length > 0 && mainRatios.every((x) => x.ratio === 4.5),
      JSON.stringify(mainRatios));

    // 开一个 tmux 格子：格子恒显示 tmux，对比度兜底必须同样生效
    await page.click('[data-testid="tmux-quick"] .tmux-quick-btn');
    await page.waitForTimeout(300);
    await page.click('[data-testid="tmux-pane-add-work"]');
    await page.waitForTimeout(1500);

    const paneRatios = await page.evaluate(() => {
      const m = window.__t_pane_terms;
      return m ? [...m.entries()].map(([k, t]) => ({ key: k, ratio: t.options.minimumContrastRatio })) : null;
    });
    ck.check("tmux 格子已设 minimumContrastRatio=4.5",
      Array.isArray(paneRatios) && paneRatios.length > 0 && paneRatios.every((x) => x.ratio === 4.5),
      JSON.stringify(paneRatios));

    // 焦点格标题：14% accent 底 + --accent 字在 graphite/light 只有 4.39:1；
    // 现改为 12% 底 + --accent-text（32 个色板×深浅组合全部 ≥4.5）
    const head = await page.evaluate(() => {
      const cell = document.querySelector(".tmux-cell");
      if (!cell) return null;
      cell.querySelector(".xterm-helper-textarea")?.focus();
      const h = cell.querySelector(".tmux-cell-head");
      if (!h) return null;
      const probe = document.createElement("span");
      probe.style.color = "var(--accent-text)";
      document.body.appendChild(probe);
      const accentText = getComputedStyle(probe).color;
      probe.style.color = "var(--panel)";
      const panel = getComputedStyle(probe).color;
      probe.remove();
      return {
        headColor: getComputedStyle(h).color, accentText, panel,
        bg: getComputedStyle(h).backgroundColor,
      };
    });
    ck.check("焦点格标题使用 --accent-text",
      !!head && head.headColor === head.accentText,
      JSON.stringify(head));
    ck.check("焦点格标题底色为 accent 混 panel（不是纯 panel/透明）",
      !!head && head.bg !== head.panel && head.bg !== "rgba(0, 0, 0, 0)",
      JSON.stringify(head));

    // 死格正文：此前 opacity:.45 把浅色主题输出压到 1.8–2.9:1；现只去色不降透明度
    const dead = await page.evaluate(() => {
      const cell = document.querySelector(".tmux-cell");
      const body = cell?.querySelector(".tmux-cell-body");
      if (!cell || !body) return null;
      cell.classList.add("dead");
      const cs = getComputedStyle(body);
      const out = { opacity: cs.opacity, filter: cs.filter };
      cell.classList.remove("dead");
      return out;
    });
    ck.check("死格正文不再整体降透明度", !!dead && dead.opacity === "1", JSON.stringify(dead));
    ck.check("死格正文保留去色提示", !!dead && dead.filter.includes("grayscale"), JSON.stringify(dead));
  },
};
