// 97 子视图外框（GitHub #48）：双子视图时 3px --view-seam 混入 10% 正文色，
// 在非焦点格外形成粗灰框；用户要求沿用单子视图的协调观感，只让外框略微可辨。
// 卡缝改为与终端 --bg 同色，1px --border 内描边与 accent 焦点环继续保留。
const SID = "s-demo-0001";

const openQuick = async (page) => {
  await page.evaluate(() => {
    if (!document.querySelector('[data-testid="tmux-quick-menu"]')) {
      document.querySelector('[data-testid="tmux-quick"] button')?.click();
    }
  });
  await page.waitForTimeout(400);
};

const stylesOf = (page) => page.evaluate(() => {
  const mount = document.getElementById("term");
  const probe = document.createElement("div");
  mount.appendChild(probe);
  probe.style.backgroundColor = "var(--bg)";
  const bg = getComputedStyle(probe).backgroundColor;
  probe.style.backgroundColor = "var(--view-seam)";
  const seam = getComputedStyle(probe).backgroundColor;
  probe.style.border = "1px solid var(--border)";
  const border = getComputedStyle(probe).borderTopColor;
  probe.style.color = "var(--accent)";
  const accent = getComputedStyle(probe).color;
  probe.remove();
  const cells = [...document.querySelectorAll(".tmux-cell")].filter((c) => c.style.display === "flex");
  const main = document.querySelector(".term-session.active");
  const cards = [...cells, ...(main ? [main] : [])].map((el) => {
    const s = getComputedStyle(el);
    const before = getComputedStyle(el, "::before");
    const after = getComputedStyle(el, "::after");
    return {
      name: el.dataset.tmux || "main",
      outerColor: s.borderTopColor,
      outerWidth: s.borderTopWidth,
      radius: s.borderTopLeftRadius,
      innerColor: before.borderTopColor,
      innerWidth: before.borderTopWidth,
      focus: el.matches(":focus-within"),
      focusColor: after.borderTopColor,
    };
  });
  return { bg, seam, border, accent, cells: cells.length, cards };
});

module.exports = {
  title: "子视图外框：单双格同语言，卡缝融背景且焦点环保留",
  async run({ page, ck }) {
    await page.waitForTimeout(900);
    await page.evaluate((sid) => window.__demoInvoke("demo_tmux_fixture", {
      sid, sessions: ["work", "logs", "build"],
    }), SID);
    await page.evaluate(() => {
      const tab = [...document.querySelectorAll(".tab")].find((x) => x.textContent?.includes("prod-1"));
      tab?.click();
    });
    await page.waitForTimeout(600);
    await openQuick(page);
    await page.click('[data-testid="tmux-pane-add-work"]');
    await page.waitForTimeout(1200);

    const one = await stylesOf(page);
    ck.check("一个子视图：格子与主视图均在场", one.cells === 1 && one.cards.length === 2, JSON.stringify(one.cards));
    ck.check("卡缝色与终端背景完全一致（不再混 10% 正文色）", one.seam === one.bg, `${one.seam} / ${one.bg}`);
    ck.check("一个子视图：3px 卡缝融入背景，不成粗灰框",
      one.cards.every((c) => c.outerColor === one.bg), JSON.stringify(one.cards));
    ck.check("一个子视图：1px 细描边仍保留",
      one.cards.every((c) => c.innerWidth === "1px" && c.innerColor === one.border), JSON.stringify(one.cards));
    ck.check("一个子视图：唯一焦点格保留 accent 环",
      one.cards.filter((c) => c.focus).length === 1
      && one.cards.find((c) => c.focus)?.focusColor === one.accent, JSON.stringify(one.cards));

    await openQuick(page);
    await page.click('[data-testid="tmux-pane-add-logs"]');
    await page.waitForTimeout(1200);
    const two = await stylesOf(page);
    ck.check("两个子视图：两格与主视图均在场", two.cells === 2 && two.cards.length === 3, JSON.stringify(two.cards));
    ck.check("两个子视图：所有非焦点/焦点格卡缝都与背景同底",
      two.seam === two.bg && two.cards.every((c) => c.outerColor === two.bg), JSON.stringify(two.cards));
    ck.check("两个子视图：细描边不随格数加粗或换色",
      two.cards.every((c) => c.innerWidth === "1px" && c.innerColor === two.border), JSON.stringify(two.cards));
    ck.check("两个子视图：仍只有唯一焦点格显示 accent 环",
      two.cards.filter((c) => c.focus).length === 1
      && two.cards.find((c) => c.focus)?.focusColor === two.accent, JSON.stringify(two.cards));
    ck.check("单双格几何语言一致（3px 卡缝 + 同圆角 + 1px 内描边）",
      [...one.cards, ...two.cards].every((c) => c.outerWidth === "3px" && c.radius === "10px" && c.innerWidth === "1px"),
      JSON.stringify({ one: one.cards, two: two.cards }));
  },
};
