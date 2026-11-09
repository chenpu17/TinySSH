// 76 每标签独立分屏组：A|B 与 C|D 共存、每组独立恢复（方向/占比/组名/最大化）、
// 跨组移动解散原组、关闭成员只解散所在组、tmux 面板互斥按会话判定。
const rightClickTabIdx = async (page, idx) => {
  await page.evaluate((i) => {
    const tab = document.querySelectorAll(".tab")[i];
    if (!tab) throw new Error("tab not found: " + i);
    tab.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 380, clientY: 130 }));
  }, idx);
  await page.waitForTimeout(350);
};

const clickItem = async (page, part) => {
  await page.evaluate((p) => {
    const b = [...document.querySelectorAll(".ctx-menu [role=menuitem]")].find((x) => x.textContent.includes(p));
    if (!b) throw new Error("menuitem not found: " + p);
    b.click();
  }, part);
  await page.waitForTimeout(500);
};

const activate = async (page, idx) => {
  await page.evaluate((i) => document.querySelectorAll(".tab")[i]?.click(), idx);
  await page.waitForTimeout(600);
};

const tabsInfo = (page) => page.evaluate(() =>
  [...document.querySelectorAll(".tab")].map((t) => ({
    sid: t.dataset.sid,
    text: t.querySelector(".tab-label")?.textContent ?? "",
    pane: t.classList.contains("tab-pane"),
    active: t.classList.contains("tab-active"),
  })));

const panes = (page) => page.evaluate(() => {
  const isPane = (e) => ["pane-left", "pane-right", "pane-top", "pane-bottom"].some((c) => e.classList.contains(c));
  return [...document.querySelectorAll(".term-session")]
    .filter((e) => e.dataset.sid && isPane(e))
    .map((e) => ({
      sid: e.dataset.sid,
      slot: e.classList.contains("pane-left") || e.classList.contains("pane-top") ? "main" : "second",
      max: e.classList.contains("pane-max"),
      hidden: e.classList.contains("pane-hidden"),
    }));
});

const view = (page) => page.evaluate(() => {
  const term = document.getElementById("term");
  const div = document.querySelector(".pane-div");
  return {
    dir: div ? (div.classList.contains("div-tb") ? "tb" : "lr") : null,
    frac: parseFloat(term?.style.getPropertyValue("--split-frac") ?? "NaN"),
    chip: document.querySelector('[data-testid="split-group-chip"] .div-group-name')?.textContent ?? null,
    max: document.querySelectorAll(".pane-max").length,
    hidden: document.querySelectorAll(".pane-hidden").length,
  };
});

const dragTab = async (page, idx, fx, fy, mode = "drop") => {
  const pos = await page.evaluate(({ i, x, y }) => {
    const tab = document.querySelectorAll(".tab")[i];
    if (!tab) throw new Error("tab not found: " + i);
    const s = tab.querySelector(".tab-label").getBoundingClientRect();
    const r = document.getElementById("term").getBoundingClientRect();
    return { sx: s.left + s.width / 2, sy: s.top + s.height / 2, tx: r.left + r.width * x, ty: r.top + r.height * y };
  }, { i: idx, x: fx, y: fy });
  await page.mouse.move(pos.sx, pos.sy);
  await page.mouse.down();
  await page.mouse.move((pos.sx + pos.tx) / 2, (pos.sy + pos.ty) / 2, { steps: 4 });
  await page.mouse.move(pos.tx, pos.ty, { steps: 4 });
  await page.waitForTimeout(150);
  if (mode === "over") return;
  await page.mouse.up();
  await page.waitForTimeout(600);
};

// 抓条身 20% 处（避开中央组名胶囊），拖到目标占比
const dragDiv = async (page, targetFrac) => {
  const d = await page.evaluate(() => {
    const el = document.querySelector(".pane-div");
    if (!el) throw new Error("divider not found");
    const r = el.getBoundingClientRect();
    const term = document.getElementById("term").getBoundingClientRect();
    const frac = parseFloat(document.getElementById("term").style.getPropertyValue("--split-frac") ?? "0.5");
    const lr = r.width < r.height;
    return {
      x: lr ? r.x + r.width / 2 : r.x + r.width * 0.2,
      y: lr ? r.y + r.height * 0.2 : r.y + r.height / 2,
      frac, total: lr ? term.width : term.height, lr,
    };
  });
  await page.mouse.move(d.x, d.y);
  await page.mouse.down();
  const delta = (targetFrac - d.frac) * d.total;
  await page.mouse.move(d.lr ? d.x + delta : d.x, d.lr ? d.y : d.y + delta, { steps: 6 });
  await page.mouse.up();
  await page.waitForTimeout(450);
};

const renameChip = async (page, name) => {
  const box = await page.evaluate(() => {
    const c = document.querySelector('[data-testid="split-group-chip"]');
    if (!c) throw new Error("chip not found");
    const r = c.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
  await page.mouse.dblclick(box.x, box.y);
  await page.waitForTimeout(250);
  await page.keyboard.type(name);
  await page.keyboard.press("Enter");
  await page.waitForTimeout(300);
};

const waitToast = async (page, substr, timeout = 6000) => {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const hit = await page.evaluate((s) =>
      [...document.querySelectorAll(".toast")].some((t) => t.textContent?.includes(s)), substr);
    if (hit) return true;
    await page.waitForTimeout(120);
  }
  return false;
};

module.exports = {
  title: "每标签独立分屏：多组共存、组内状态独立、跨组移动与关闭只影响本组",
  async run({ page, ck }) {
    // ── 准备 4 个会话：demo 预置 prod-1/staging-1 + 连接本机 + 复制本机标签 ──
    const card = await page.$('.host-card:has(.host-name:text-is("本机"))');
    await card.hover();
    await page.waitForTimeout(250);
    await (await card.$('button[title^="连接"]')).click();
    await page.waitForTimeout(1500);
    let tabs = await tabsInfo(page);
    const localIdx = tabs.length - 1;
    await rightClickTabIdx(page, localIdx);
    await clickItem(page, "复制标签页（同主机新会话）");
    await page.waitForTimeout(1200);
    tabs = await tabsInfo(page);
    ck.check("准备 4 个会话标签", tabs.length === 4, JSON.stringify(tabs));
    const [t0, t1, t2, t3] = tabs.map((t) => t.sid);

    // ── 1. A|B 与 C|D 共存：点第三个标签不替换任何窗格 ──
    await activate(page, 0);
    await dragTab(page, 1, 0.9, 0.5);
    let p = await panes(page);
    ck.check("A|B 建立", p.length === 2 && p.find((x) => x.sid === t0)?.slot === "main"
      && p.find((x) => x.sid === t1)?.slot === "second", JSON.stringify(p));

    await activate(page, 2);
    p = await panes(page);
    ck.check("点第三个标签只显示它自己（单窗格）", p.length === 0, JSON.stringify(p));
    tabs = await tabsInfo(page);
    ck.check("A|B 组成员标记仍在（未被替换）",
      tabs.find((t) => t.sid === t0)?.pane && tabs.find((t) => t.sid === t1)?.pane, JSON.stringify(tabs));

    await dragTab(page, 3, 0.9, 0.5);
    p = await panes(page);
    ck.check("C|D 建立且与 A|B 共存", p.length === 2 && p.find((x) => x.sid === t2)?.slot === "main"
      && p.find((x) => x.sid === t3)?.slot === "second", JSON.stringify(p));

    await activate(page, 0);
    p = await panes(page);
    ck.check("切回 A 恢复 A|B（C|D 不受影响）", p.length === 2 && p.find((x) => x.sid === t0)?.slot === "main"
      && p.find((x) => x.sid === t1)?.slot === "second", JSON.stringify(p));
    tabs = await tabsInfo(page);
    ck.check("C|D 组成员标记仍在", tabs.find((t) => t.sid === t2)?.pane && tabs.find((t) => t.sid === t3)?.pane,
      JSON.stringify(tabs));

    // ── 2. 每组独立恢复：占比 / 组名 / 方向 ──
    await dragDiv(page, 0.2);
    await renameChip(page, "生产组");
    await rightClickTabIdx(page, 0);
    await clickItem(page, "改为上下分屏");
    await page.waitForTimeout(500);
    let v = await view(page);
    ck.check("A|B 设为上下 + 0.2 + 生产组",
      v.dir === "tb" && Math.abs(v.frac - 0.2) < 0.02 && v.chip === "生产组", JSON.stringify(v));

    await activate(page, 2);
    v = await view(page);
    ck.check("切到 C|D：方向/占比/组名各自独立（左右、0.5、自动名）",
      v.dir === "lr" && Math.abs(v.frac - 0.5) < 0.02 && v.chip === "本机 + 本机", JSON.stringify(v));

    await activate(page, 0);
    v = await view(page);
    ck.check("切回 A|B：上下/0.2/生产组 全部原样恢复",
      v.dir === "tb" && Math.abs(v.frac - 0.2) < 0.02 && v.chip === "生产组", JSON.stringify(v));

    // ── 3. 最大化隔离：A|B 最大化后切到 C|D 不最大化，切回仍最大化 ──
    await page.evaluate(() => {
      const pane = [...document.querySelectorAll(".pane-top, .pane-bottom")].find((el) => getComputedStyle(el).display !== "none");
      pane?.querySelector('[data-testid="pane-max"]')?.click();
    });
    await page.waitForTimeout(500);
    v = await view(page);
    ck.check("A|B 最大化一格", v.max === 1 && v.hidden === 1 && v.dir === null, JSON.stringify(v));

    await activate(page, 2);
    v = await view(page);
    ck.check("切到 C|D：不受 A|B 最大化影响", v.max === 0 && v.hidden === 0 && v.dir === "lr", JSON.stringify(v));

    await activate(page, 0);
    v = await view(page);
    ck.check("切回 A|B：最大化态仍在", v.max === 1 && v.hidden === 1, JSON.stringify(v));
    await page.evaluate(() => document.querySelector(".pane-max [data-testid='pane-max']")?.click());
    await page.waitForTimeout(500);
    v = await view(page);
    ck.check("还原后 A|B 两格回归", v.max === 0 && v.hidden === 0 && v.dir === "tb", JSON.stringify(v));

    // ── 4. tmux 面板互斥按会话：退出 A|B（C|D 仍在），单窗格的 prod-1 仍能开面板 ──
    await rightClickTabIdx(page, 0);
    await clickItem(page, "退出分屏");
    await page.waitForTimeout(400);
    await activate(page, 0);
    await page.evaluate((sid) =>
      window.__demoInvoke("demo_tmux_fixture", { sid, sessions: ["work"] }), t0);
    await page.waitForTimeout(300);
    await page.click('[data-testid="tmux-quick"] .tmux-quick-btn');
    await page.waitForSelector('[data-testid="tmux-quick-menu"]', { timeout: 5000 });
    await page.click('[data-testid="tmux-pane-add-work"]');
    await page.waitForTimeout(1500);
    const cell = await page.evaluate(() => {
      const c = document.querySelector('.tmux-cell[data-tmux="work"]');
      return c ? { display: c.style.display, sid: c.dataset.sid } : null;
    });
    ck.check("存在其它分屏组时，单窗格标签仍能打开 tmux 面板",
      !!cell && cell.display === "flex" && cell.sid === t0, JSON.stringify(cell));

    // ── 5. 跨组移动：重建 A|B 后把 D（C|D 成员）拖进来 → C|D 解散、C 变单窗格 ──
    await dragTab(page, 1, 0.9, 0.5);
    p = await panes(page);
    ck.check("重建 A|B（prod-1 + staging-1）", p.length === 2
      && p.find((x) => x.sid === t0)?.slot === "main" && p.find((x) => x.sid === t1)?.slot === "second",
      JSON.stringify(p));
    // 分屏中的会话隐藏自己的 tmux 面板（按会话互斥，不误伤其它标签）
    const cellHidden = await page.evaluate(() => {
      const c = document.querySelector('.tmux-cell[data-tmux="work"]');
      return c ? c.style.display : null;
    });
    ck.check("prod-1 进入分屏后其 tmux 面板暂隐", cellHidden === "none", String(cellHidden));

    await dragTab(page, 3, 0.9, 0.5);
    ck.check("跨组移动 toast 说明原分屏解散", await waitToast(page, "已从原分屏移出"), "");
    p = await panes(page);
    ck.check("D 进入 A|B 副格，A|B 仍是两格",
      p.length === 2 && p.find((x) => x.sid === t0)?.slot === "main"
      && p.find((x) => x.sid === t3)?.slot === "second", JSON.stringify(p));
    tabs = await tabsInfo(page);
    ck.check("C 变单窗格（成员标记消失）、D 仍在分屏",
      !tabs.find((t) => t.sid === t2)?.pane && tabs.find((t) => t.sid === t3)?.pane, JSON.stringify(tabs));

    await activate(page, 2);
    p = await panes(page);
    ck.check("切到 C：单窗格", p.length === 0, JSON.stringify(p));

    // ── 6. 关闭组成员：只解散它所在的组，其它组不受影响 ──
    // 先重建第二组 {staging-1, 本机}（A|B 此时 = prod-1 + D，处于非活动态）
    await activate(page, 1);
    await dragTab(page, 2, 0.9, 0.5);
    p = await panes(page);
    ck.check("第二组 {staging-1, 本机} 建立", p.length === 2
      && p.find((x) => x.sid === t1)?.slot === "main" && p.find((x) => x.sid === t2)?.slot === "second",
      JSON.stringify(p));

    // 关闭 A|B 的成员 D（非活动标签）
    const dIdx = (await tabsInfo(page)).findIndex((t) => t.sid === t3);
    await rightClickTabIdx(page, dIdx);
    await clickItem(page, "关闭会话");
    await page.evaluate(() => {
      const b = [...document.querySelectorAll(".confirm-dialog button")].find((x) => x.textContent.trim() === "关闭会话");
      if (b) b.click();
    });
    await page.waitForTimeout(900);
    tabs = await tabsInfo(page);
    p = await panes(page);
    ck.check("关闭 A|B 成员：该组解散（A 变单窗格）",
      !tabs.find((t) => t.sid === t0)?.pane && tabs.length === 3, JSON.stringify(tabs));
    ck.check("其它组 {staging-1, 本机} 完全不受影响、仍是活动视图",
      p.length === 2 && p.find((x) => x.sid === t1)?.slot === "main"
      && p.find((x) => x.sid === t2)?.slot === "second", JSON.stringify(p));

    // ── 7. 关闭回落：另一个组的隐藏最大化格不得抢成活动会话 ──
    // 最大化 {staging-1, 本机} 的副格（本机），再切到单窗格 prod-1 后关闭它：
    // 回落若直接 setSid 本机，屏幕仍是最大化的本机，但活动标签/右键/⌘W 指向
    // 隐藏的 staging-1——统一走 focusSession 必须先还原两格并让焦点=可见格。
    await activate(page, 2);
    await page.evaluate((sid) => {
      const pane = [...document.querySelectorAll(".pane-left, .pane-right, .pane-top, .pane-bottom")]
        .find((el) => el.dataset.sid === sid);
      pane?.querySelector('[data-testid="pane-max"]')?.click();
    }, t2);
    await page.waitForTimeout(500);
    const maxBefore = await page.evaluate(() => document.querySelector(".pane-max")?.dataset.sid ?? null);
    ck.check("关闭回落前：本机副格处于最大化", maxBefore === t2, String(maxBefore));

    const t0Idx = (await tabsInfo(page)).findIndex((t) => t.sid === t0);
    await activate(page, t0Idx);
    const t0Idx2 = (await tabsInfo(page)).findIndex((t) => t.sid === t0);
    await rightClickTabIdx(page, t0Idx2);
    await clickItem(page, "关闭会话");
    await page.evaluate(() => {
      const b = [...document.querySelectorAll(".confirm-dialog button")].find((x) => x.textContent.trim() === "关闭会话");
      if (b) b.click();
    });
    await page.waitForTimeout(900);
    const fallback = await page.evaluate(() => {
      const active = document.querySelector(".tab.tab-active")?.dataset.sid ?? null;
      const focused = document.querySelector(".pane-focused");
      return {
        active,
        focused: focused?.dataset.sid ?? null,
        visible: !!focused && getComputedStyle(focused).display !== "none",
        panes: document.querySelectorAll(".pane-left, .pane-right, .pane-top, .pane-bottom").length,
      };
    });
    ck.check("关闭单窗格标签回落：活动标签=可见焦点终端（隐藏格不抢焦点）",
      !!fallback.active && fallback.active === fallback.focused && fallback.visible && fallback.panes === 2,
      JSON.stringify(fallback));
  },
};
