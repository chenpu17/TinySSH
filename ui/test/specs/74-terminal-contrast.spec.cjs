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

    // 选区（可读性轮 B）：xterm 的 selectionForeground 覆盖选中单元格前景，运行时
    // 主题里三个选区键都须给出；选中文字对激活/失焦底都 ≥4.5，且两底可区分。
    const sel = await page.evaluate(() => {
      const t = [...(window.__t_terms?.values() ?? [])][0];
      if (!t) return null;
      const th = t.options.theme ?? {};
      const parse = (s) => {
        s = String(s ?? "");
        const m = s.match(/rgba?\(([^)]+)\)/);
        if (m) {
          const p = m[1].split(",").map(Number);
          return [p[0] / 255, p[1] / 255, p[2] / 255];
        }
        // Chrome 对 color-mix 的计算值序列化为 color(srgb r g b)（分量 0..1）
        const cm = s.match(/color\(srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)/);
        if (cm) return [Number(cm[1]), Number(cm[2]), Number(cm[3])];
        const hex = s.match(/#([\da-f]{6})/i);
        if (hex) return [0, 2, 4].map((i) => parseInt(hex[1].slice(i, i + 2), 16) / 255);
        return null;
      };
      const lum = (c) => {
        const [r, g, b] = c.map((v) => (v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)));
        return 0.2126 * r + 0.7152 * g + 0.0722 * b;
      };
      const ratio = (a, b) => {
        const l1 = lum(a), l2 = lum(b);
        return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
      };
      const fg = parse(th.selectionForeground);
      const act = parse(th.selectionBackground);
      const inact = parse(th.selectionInactiveBackground);
      const rgb = (c) => c.map((v) => Math.round(v * 255)).join(",");
      return {
        defined: !!(th.selectionBackground && th.selectionForeground && th.selectionInactiveBackground),
        activeRatio: fg && act ? ratio(fg, act) : null,
        inactiveRatio: fg && inact ? ratio(fg, inact) : null,
        active: act ? rgb(act) : null,
        inactive: inact ? rgb(inact) : null,
      };
    });
    ck.check("终端选区三键齐全（底/前景/失焦底）", !!sel && sel.defined, JSON.stringify(sel));
    ck.check("选中文字对激活选区底 ≥4.5:1",
      !!sel && sel.activeRatio !== null && sel.activeRatio >= 4.5,
      JSON.stringify(sel));
    ck.check("选中文字对失焦选区底 ≥4.5:1",
      !!sel && sel.inactiveRatio !== null && sel.inactiveRatio >= 4.5,
      JSON.stringify(sel));
    ck.check("失焦选区底与激活底可区分",
      !!sel && !!sel.active && !!sel.inactive && sel.active !== sel.inactive,
      JSON.stringify(sel));

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

    // tmux 格子同样有「回到底部」浮钮（小号，本地视口真滚上去才出现）
    const paneScroll = await page.evaluate(async () => {
      const t = [...(window.__t_pane_terms?.values() ?? [])][0];
      if (!t) return null;
      t.write(Array.from({ length: 120 }, (_, i) => `pane line ${i}`).join("\r\n") + "\r\n");
      await new Promise((r) => setTimeout(r, 450));
      t.scrollToTop();
      await new Promise((r) => setTimeout(r, 450));
      const btn = document.querySelector('[data-testid="pane-scroll-bottom"]');
      const out = { shown: !!btn && !btn.hidden, text: btn?.textContent ?? "" };
      btn?.click();
      await new Promise((r) => setTimeout(r, 450));
      return {
        ...out,
        atBottom: t.buffer.active.viewportY === t.buffer.active.baseY,
        hidden: btn?.hidden ?? null,
      };
    });
    ck.check("tmux 格子回底浮钮：滚上去出现、点击回底并隐藏",
      !!paneScroll && paneScroll.shown && paneScroll.text.includes("回到底部")
        && paneScroll.atBottom && paneScroll.hidden === true,
      JSON.stringify(paneScroll));

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
