// 75 统一视图语义：所有窗格的 × 都只关闭当前视图。
// - 主视图挂着 tmux 时显示 ×，点它 = 分离 tmux 回 shell；标签、tmux 会话、面板格子都不受影响。
// - 主视图没挂 tmux 时没有可单独关闭的视图，不显示 ×（关闭整个标签仍走标签上的 ×）。
// - 标签 × 才是关闭整个会话，确认框说明面板格子一并关闭视图、tmux 会话仍在远端运行。
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

const openQuick = async (page) => {
  await page.click('[data-testid="tmux-quick"] .tmux-quick-btn');
  await page.waitForSelector('[data-testid="tmux-quick-menu"]', { timeout: 5000 });
};

const openPane = async (page, name) => {
  await openQuick(page);
  await page.click(`[data-testid="tmux-pane-add-${name}"]`);
  await page.waitForTimeout(1500);
};

const waitToast = async (page, substr, timeout = 7000) => {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const hit = await page.evaluate((s) =>
      [...document.querySelectorAll(".toast")].some((t) => t.textContent?.includes(s)), substr);
    if (hit) return true;
    await page.waitForTimeout(120);
  }
  return false;
};

const poll = async (page, fn, timeout = 6000) => {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await page.evaluate(fn)) return true;
    await page.waitForTimeout(120);
  }
  return false;
};

const state = (page) => page.evaluate(() => {
  const main = document.querySelector(".term-session.active");
  const cell = document.querySelector('.tmux-cell[data-tmux="work"]');
  const term = document.getElementById("term");
  const mr = main?.getBoundingClientRect();
  const tr = term?.getBoundingClientRect();
  const zoom = document.querySelector('[data-testid="main-zoom"]');
  const detach = document.querySelector('[data-testid="main-detach"]');
  const cardOf = (el) => {
    if (!el) return null;
    const cs = getComputedStyle(el);
    return {
      border: cs.borderTopWidth, radius: cs.borderRadius, overflow: cs.overflow,
      clip: cs.backgroundClip, color: cs.borderTopColor,
    };
  };
  const head = cell?.querySelector(".tmux-cell-head");
  const body = cell?.querySelector(".tmux-cell-body");
  return {
    mainDisplay: main ? getComputedStyle(main).display : null,
    cellDisplay: cell ? cell.style.display : null,
    mainFull: !!mr && !!tr && Math.abs(mr.width - tr.width) < 2 && Math.abs(mr.height - tr.height) < 2,
    zoomTitle: zoom?.getAttribute("title") ?? null,
    detachVisible: !!detach && getComputedStyle(detach).display !== "none",
    detachTitle: detach?.getAttribute("title") ?? null,
    tagText: main?.querySelector(".pane-tag-label")?.textContent ?? null,
    tagAttached: main?.querySelector(".pane-tag")?.classList.contains("tmux-attached") ?? false,
    tabs: document.querySelectorAll(".tab").length,
    dialog: document.querySelector(".confirm-dialog")?.textContent ?? null,
    mainCard: cardOf(main),
    cellCard: cardOf(cell),
    cellHeadRadius: head ? getComputedStyle(head).borderRadius : null,
    cellBodyRadius: body ? getComputedStyle(body).borderRadius : null,
  };
});

module.exports = {
  title: "统一视图语义：主视图 × 只分离 tmux 回 shell，不关标签；不挂 tmux 时无 ×",
  async run({ page, ck }) {
    await page.waitForTimeout(1200);
    ck.check("切到 prod-1", await clickTab(page, "prod-1"), "");
    await page.evaluate((sid) =>
      window.__demoInvoke("demo_tmux_fixture", { sid, sessions: ["work", "logs"] }), "s-demo-0001");
    await openPane(page, "work");

    let s = await state(page);
    ck.check("主视图有放大钮", s.zoomTitle === "最大化主视图（保留标题栏）", JSON.stringify(s));
    ck.check("未挂 tmux 的主视图没有 ×（没有可单独关闭的视图）", !s.detachVisible && !s.tagAttached, JSON.stringify(s));
    ck.check("网格态主视图不是全幅、work 格子可见", !s.mainFull && s.cellDisplay === "flex", JSON.stringify(s));
    ck.check("主视图卡片化：3px 透明边框 + 10px 圆角",
      !!s.mainCard && s.mainCard.border === "3px" && s.mainCard.radius === "10px"
        && s.mainCard.overflow === "hidden" && s.mainCard.clip === "padding-box"
        && /rgba?\(0, 0, 0, 0\)|transparent/.test(s.mainCard.color),
      JSON.stringify(s.mainCard));
    ck.check("tmux 格子卡片化：3px 透明边框 + 10px 圆角，标题/正文内圆角 7px",
      !!s.cellCard && s.cellCard.border === "3px" && s.cellCard.radius === "10px"
        && s.cellCard.clip === "padding-box" && /rgba?\(0, 0, 0, 0\)|transparent/.test(s.cellCard.color)
        && s.cellHeadRadius === "7px 7px 0px 0px" && s.cellBodyRadius === "0px 0px 7px 7px",
      JSON.stringify({ cell: s.cellCard, head: s.cellHeadRadius, body: s.cellBodyRadius }));

    // 放大主视图：格子暂隐、主视图占满、钮换装还原
    await page.click('[data-testid="main-zoom"]');
    await page.waitForTimeout(500);
    s = await state(page);
    ck.check("放大后主视图全幅", s.mainFull, JSON.stringify(s));
    ck.check("放大后 work 格子暂隐", s.cellDisplay === "none", JSON.stringify(s));
    ck.check("放大后钮换装为还原", s.zoomTitle === "还原主视图（回到网格）", JSON.stringify(s));

    // 还原：格子回归、主视图回网格位
    await page.click('[data-testid="main-zoom"]');
    await page.waitForTimeout(500);
    s = await state(page);
    ck.check("还原后 work 格子回归", s.cellDisplay === "flex" && !s.mainFull, JSON.stringify(s));
    ck.check("还原后钮换回放大", s.zoomTitle === "最大化主视图（保留标题栏）", JSON.stringify(s));

    // 主视图 attach logs：× 出现，文案明确是「回到 shell」而不是关标签
    await openQuick(page);
    await page.click('[data-testid="tmux-quick-item-logs"]');
    ck.check("主视图 attach logs（恢复现场 toast）", await waitToast(page, "已恢复现场（tmux logs"), "");
    ck.check("attach 后名牌变 tmux:logs、× 出现", await poll(page, () =>
      document.querySelector(".term-session.active .pane-tag-label")?.textContent === "tmux:logs"
      && getComputedStyle(document.querySelector('[data-testid="main-detach"]')).display !== "none", 8000), "");
    s = await state(page);
    ck.check("主视图 × 标注只关此 tmux 视图、回到 shell",
      (s.detachTitle ?? "").includes("回到 shell") && (s.detachTitle ?? "").includes("tmux 会话继续运行"),
      JSON.stringify(s.detachTitle));

    // 点 ×：只分离 tmux 回 shell——标签还在、面板格子还在、tmux 会话没被杀
    const tabs0 = s.tabs;
    await page.click('[data-testid="main-detach"]');
    ck.check("分离 toast：tmux 会话仍在远端运行", await waitToast(page, "已从 tmux 分离：logs（tmux 会话仍在远端运行）"), "");
    ck.check("分离后名牌回主机名、× 收起", await poll(page, () => {
      const main = document.querySelector(".term-session.active");
      const detach = document.querySelector('[data-testid="main-detach"]');
      return main?.querySelector(".pane-tag-label")?.textContent === "prod-1"
        && !!detach && getComputedStyle(detach).display === "none"
        && !main?.querySelector(".pane-tag")?.classList.contains("tmux-attached");
    }, 8000), "");
    s = await state(page);
    ck.check("分离不关标签、不拆面板格子", s.tabs === tabs0 && s.cellDisplay === "flex", JSON.stringify(s));

    // 标签 × 才是关闭整个会话：确认框说明面板格子一并关闭视图、tmux 会话仍在远端
    await page.click(".tab-active .tab-x");
    await page.waitForTimeout(300);
    s = await state(page);
    ck.check("标签 × 打开关闭确认", !!s.dialog && s.dialog.includes("关闭与"), JSON.stringify(s.dialog));
    ck.check("确认框说明面板格子一并关闭视图", (s.dialog ?? "").includes("面板中的 1 个 tmux 格子会一并关闭视图"), JSON.stringify(s.dialog));
    ck.check("确认框说明 tmux 会话仍在远端运行", (s.dialog ?? "").includes("tmux 会话仍在远端运行"), JSON.stringify(s.dialog));

    // 取消：会话与格子原样保留
    await page.click(".confirm-dialog [data-autofocus]");
    await page.waitForTimeout(300);
    s = await state(page);
    ck.check("取消后确认框消失、标签与格子保留",
      !s.dialog && s.tabs === tabs0 && s.cellDisplay === "flex", JSON.stringify(s));
  },
};
