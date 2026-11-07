// 73 标签切换焦点记忆：一个有多个 tmux 子窗口的标签，用户点选哪个格子，
// 切走再切回就回到哪个格子；点主视图则记住主视图。此前每次切回都被 focusSession
// 送回主终端（用户反馈「上次选定的子窗口会丢失，总是选定第一个」）。
// 同时覆盖两条回归：
//   - 真实鼠标点格子（mousedown 冒泡到 #term 时不得把记忆重置成 main）
//   - 从菜单/浮层 Esc 返回后仍回到原格子（restoreTermFocus 曾固定聚焦主终端）
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

const focusState = (page) => page.evaluate(() => {
  const cells = [...document.querySelectorAll(".tmux-cell")];
  return {
    active: document.querySelector(".tab-active")?.textContent?.trim() ?? null,
    cells: cells.map((c) => ({
      name: c.dataset.tmux,
      visible: c.style.display !== "none",
      focused: c.contains(document.activeElement),
    })),
    mainFocused: !!document.activeElement?.closest?.(".term-session.active"),
  };
});

const openPane = async (page, name) => {
  await page.click('[data-testid="tmux-quick"] .tmux-quick-btn');
  // 菜单先出，清单可能还在刷新：等目标按钮实际出现（禁用态也等，click 会等可用）
  await page.waitForSelector(`[data-testid="tmux-pane-add-${name}"]`, { timeout: 8000 });
  await page.click(`[data-testid="tmux-pane-add-${name}"]`);
  await page.waitForTimeout(1500);
};

const clickAt = async (page, sel, fx, fy) => {
  const pt = await page.evaluate(({ s, x, y }) => {
    const el = document.querySelector(s);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.x + r.width * x, y: r.y + r.height * y };
  }, { s: sel, x: fx, y: fy });
  if (!pt) return false;
  await page.mouse.click(pt.x, pt.y);
  await page.waitForTimeout(350);
  return true;
};

module.exports = {
  title: "标签切换焦点记忆：多个 tmux 子窗口时切回恢复上次格子（主视图同样记住）",
  async run({ page, ck }) {
    await page.waitForTimeout(1200);

    // 焦点上报纯函数：格子内必须带 paneId，格子外回落活动会话
    const report = await page.evaluate(async () => {
      const mod = await import("/src/terminal/focus-report.ts");
      const cell = document.createElement("div");
      cell.className = "tmux-cell";
      cell.dataset.sid = "s1";
      cell.dataset.paneId = "7";
      const ta = document.createElement("textarea");
      cell.appendChild(ta);
      document.body.appendChild(cell);
      const inside = mod.terminalFocusTarget(ta, "fallback");
      const outside = mod.terminalFocusTarget(document.body, "fallback");
      cell.remove();
      return { inside, outside };
    });
    ck.check("焦点上报：格子内推导 sid/paneId",
      report.inside.sid === "s1" && report.inside.paneId === 7, JSON.stringify(report.inside));
    ck.check("焦点上报：格子外回落活动会话且 paneId 为空",
      report.outside.sid === "fallback" && report.outside.paneId === null, JSON.stringify(report.outside));

    // prod-1 出厂只有 work；补 logs 后开两个格子，验证「非第一个格子」
    ck.check("切到 prod-1", await clickTab(page, "prod-1"), "");
    await page.evaluate((sid) =>
      window.__demoInvoke("demo_tmux_fixture", { sid, sessions: ["work", "logs"] }), "s-demo-0001");
    await openPane(page, "work");
    await openPane(page, "logs");

    // 真实鼠标点第二个格子：焦点应落 logs，而不是被 #term 的 mousedown 重置成 main
    ck.check("真实鼠标点 logs 格子", await clickAt(page, '.tmux-cell[data-tmux="logs"] .tmux-cell-body', 0.5, 0.5), "");
    let s = await focusState(page);
    ck.check("logs 格子已开且持有焦点",
      s.cells.some((c) => c.name === "logs" && c.visible && c.focused), JSON.stringify(s));
    ck.check("work 格子未被误选", !s.cells.some((c) => c.name === "work" && c.focused), JSON.stringify(s));

    // 切到另一个标签再切回：焦点应回 logs 格子，而不是第一个 work/主视图
    ck.check("切到 staging-1", await clickTab(page, "staging-1"), "");
    ck.check("切回 prod-1", await clickTab(page, "prod-1"), "");
    await page.waitForTimeout(400);
    s = await focusState(page);
    ck.check("切回后焦点仍在 logs 格子",
      s.cells.some((c) => c.name === "logs" && c.visible && c.focused), JSON.stringify(s));
    ck.check("切回后主视图不抢焦点", !s.mainFocused, JSON.stringify(s));

    // 点第一个格子 work：记忆应更新为 work
    ck.check("真实鼠标点 work 格子", await clickAt(page, '.tmux-cell[data-tmux="work"] .tmux-cell-body', 0.5, 0.5), "");
    s = await focusState(page);
    ck.check("work 格子持有焦点",
      s.cells.some((c) => c.name === "work" && c.focused), JSON.stringify(s));

    // 从菜单 Esc 返回：restoreTermFocus 不得把焦点抢回主视图
    await page.click('[data-testid="tmux-quick"] .tmux-quick-btn');
    await page.waitForTimeout(250);
    await page.keyboard.press("Escape");
    await page.waitForTimeout(350);
    s = await focusState(page);
    ck.check("菜单 Esc 后焦点回到 work 格子",
      s.cells.some((c) => c.name === "work" && c.focused) && !s.mainFocused, JSON.stringify(s));

    ck.check("再切到 staging-1", await clickTab(page, "staging-1"), "");
    ck.check("再切回 prod-1", await clickTab(page, "prod-1"), "");
    await page.waitForTimeout(400);
    s = await focusState(page);
    ck.check("菜单 Esc 往返后仍记住 work 格子",
      s.cells.some((c) => c.name === "work" && c.visible && c.focused), JSON.stringify(s));

    // 点主视图 = 明确改选主视图；再切换往返应记住主视图
    ck.check("真实鼠标点主视图", await clickAt(page, ".term-session.active", 0.5, 0.6), "");
    s = await focusState(page);
    ck.check("点主视图后焦点在主视图", s.mainFocused, JSON.stringify(s));

    ck.check("第三次切到 staging-1", await clickTab(page, "staging-1"), "");
    ck.check("第三次切回 prod-1", await clickTab(page, "prod-1"), "");
    await page.waitForTimeout(400);
    s = await focusState(page);
    ck.check("切回后记住的是主视图", s.mainFocused && !s.cells.some((c) => c.focused), JSON.stringify(s));
  },
};
