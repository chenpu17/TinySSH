// 30 分屏交互（分屏⑥轮）：方向可选（左右/上下，记住上次选择）、分割条拖拽与双击复位、
// 分屏中旋转布局、退出恢复单窗格。拖拽组合轮：标签拖到终端区四象限建屏/换格/交换、
// 拖到标签条空白退出分屏。demo 预置 prod-1/staging-1 开箱即用，不依赖真连。
const rightClickTab = async (page, namePart) => {
  await page.evaluate((t) => {
    const tab = [...document.querySelectorAll(".tab")].find((x) => x.textContent.includes(t));
    if (!tab) throw new Error("tab not found: " + t);
    tab.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 380, clientY: 130 }));
  }, namePart);
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

const paneCount = (page) =>
  page.evaluate(() => document.querySelectorAll(".pane-left, .pane-right, .pane-top, .pane-bottom").length);

// 主/副格几何 + #term 上的 --split-frac（拖拽条写入的真相源）
const paneGeom = (page) =>
  page.evaluate(() => {
    const g = (sel) => {
      const el = document.querySelector(sel);
      return el ? { w: Math.round(el.getBoundingClientRect().width), h: Math.round(el.getBoundingClientRect().height) } : null;
    };
    const f = document.getElementById("term")?.style.getPropertyValue("--split-frac");
    return { main: g(".pane-left, .pane-top"), second: g(".pane-right, .pane-bottom"), frac: f ? parseFloat(f) : null };
  });

const divCenter = (page) =>
  page.evaluate(() => {
    const d = document.querySelector(".pane-div");
    if (!d) return null;
    const r = d.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2, w: r.width, h: r.height };
  });

// staging-1 标签上的分屏钮文案（第一个标签可能是活动标签「已在主视图」，不可泛选）
const splitBtnTitleOfStaging = (page) =>
  page.evaluate(() => {
    const tab = [...document.querySelectorAll(".tab")].find((x) => x.textContent.includes("staging-1"));
    return tab?.querySelector(".tab-split")?.getAttribute("title") || "";
  });

module.exports = {
  title: "分屏方向选择、分割条拖拽与旋转",
  async run({ page, ck }) {
    // 工具栏只在有活动会话时出现——先连「本机」（staging-1 用 demo 预置标签当副格）
    const card = await page.$('.host-card:has(.host-name:text-is("本机"))');
    await card.hover();
    await page.waitForTimeout(250);
    await (await card.$('button[title^="连接"]')).click();
    await page.waitForTimeout(1500);

    // ── 分屏菜单：方向分段单选，默认左右 ──
    await page.evaluate(() => {
      const b = [...document.querySelectorAll(".session-toolbar button")].find((x) => (x.getAttribute("title") || "").includes("分屏"));
      if (!b) throw new Error("分屏钮 not found");
      b.click();
    });
    await page.waitForTimeout(350);
    const hasDir = await page.evaluate(() =>
      !!document.querySelector('[data-testid="split-dir-lr"]') && !!document.querySelector('[data-testid="split-dir-tb"]'));
    ck.check("分屏菜单有左右/上下方向选择", hasDir, "");
    let lbl = await page.evaluate(() => document.querySelector(".split-menu .ts-label")?.textContent || "");
    ck.check("默认方向为左右（文案「在右侧」）", lbl.includes("在右侧"), lbl);

    // 选上下：文案换「在下侧」（方向记住，供后续所有入口沿用）
    await page.evaluate(() => document.querySelector('[data-testid="split-dir-tb"]')?.click());
    await page.waitForTimeout(250);
    lbl = await page.evaluate(() => document.querySelector(".split-menu .ts-label")?.textContent || "");
    ck.check("选上下后文案换「在下侧」", lbl.includes("在下侧"), lbl);
    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);

    // ── 上下分屏建立：右键非当前标签（staging-1）→ 与当前会话分屏 ──
    await rightClickTab(page, "staging-1");
    await clickItem(page, "与当前会话分屏");
    await page.waitForTimeout(500);
    ck.check("上下分屏建立双窗格", (await paneCount(page)) === 2, `panes=${await paneCount(page)}`);
    const g1 = await paneGeom(page);
    ck.check("上主/下副两格齐全", !!g1.main && !!g1.second, JSON.stringify(g1));
    const divTb = await page.evaluate(() => !!document.querySelector('.pane-div[data-testid="pane-div"].div-tb'));
    ck.check("分割条出现且为竖向拖拽（div-tb）", divTb, "");
    const tabBtnTitle = await splitBtnTitleOfStaging(page);
    ck.check("标签分屏钮沿用记住的下侧", tabBtnTitle.includes("下"), tabBtnTitle);
    // 竖排两格各占一半（frac 必须真被写进 #term，缺失=null 直接红）
    ck.check("初始对半（frac 写入且两格等高）",
      g1.frac !== null && Math.abs(g1.frac - 0.5) < 0.02 && Math.abs((g1.main?.h ?? 0) - (g1.second?.h ?? 0)) <= 2,
      JSON.stringify(g1));

    // ── 拖拽分割条上移 12%：主格变矮、frac 减小 ──
    const c1 = await divCenter(page);
    const termH = await page.evaluate(() => document.getElementById("term").getBoundingClientRect().height);
    await page.mouse.move(c1.x, c1.y);
    await page.mouse.down();
    await page.mouse.move(c1.x, c1.y - termH * 0.12, { steps: 6 });
    await page.mouse.up();
    await page.waitForTimeout(400);
    const g2 = await paneGeom(page);
    ck.check("拖拽后占比减小（0.2≤frac<0.45）", g2.frac >= 0.2 - 1e-6 && g2.frac < 0.45, JSON.stringify(g2));
    ck.check("上格变矮、下格变高", g2.main.h < g1.main.h - 20 && g2.second.h > g1.second.h + 20, JSON.stringify(g2));

    // ── 双击复位对半 ──
    const c2 = await divCenter(page);
    await page.mouse.move(c2.x, c2.y);
    await page.mouse.dblclick(c2.x, c2.y);
    await page.waitForTimeout(300);
    const g3 = await paneGeom(page);
    ck.check("双击复位对半（|frac-0.5|<0.02）", Math.abs(g3.frac - 0.5) < 0.02, JSON.stringify(g3));

    // ── 分屏中旋转：右键分屏里的标签 → 改为左右分屏 ──
    await rightClickTab(page, "staging-1");
    await clickItem(page, "改为左右分屏");
    await page.waitForTimeout(400);
    const rot = await page.evaluate(() => ({
      left: !!document.querySelector(".pane-left"),
      right: !!document.querySelector(".pane-right"),
      top: !!document.querySelector(".pane-top"),
      bottom: !!document.querySelector(".pane-bottom"),
      divLr: !!document.querySelector(".pane-div.div-lr"),
    }));
    ck.check("旋转后变左右布局（分割条换向）", rot.left && rot.right && !rot.top && !rot.bottom && rot.divLr, JSON.stringify(rot));
    // 横排下拖拽夹取下限：向左猛拖 80% 宽 → frac 夹在 0.2
    const c3 = await divCenter(page);
    const termW = await page.evaluate(() => document.getElementById("term").getBoundingClientRect().width);
    await page.mouse.move(c3.x, c3.y);
    await page.mouse.down();
    await page.mouse.move(c3.x - termW * 0.8, c3.y, { steps: 6 });
    await page.mouse.up();
    await page.waitForTimeout(400);
    const g4 = await paneGeom(page);
    ck.check("横排拖拽夹取下限 0.2", Math.abs(g4.frac - 0.2) < 0.02, JSON.stringify(g4));

    // ── 退出分屏：窗格与分割条清空，方向记忆保留 ──
    await rightClickTab(page, "staging-1");
    await clickItem(page, "退出分屏");
    await page.waitForTimeout(400);
    ck.check("退出后窗格清空", (await paneCount(page)) === 0, `panes=${await paneCount(page)}`);
    const divGone = await page.evaluate(() => !document.querySelector(".pane-div"));
    ck.check("退出后分割条消失", divGone, "");
    // 方向记忆=上次使用的方向：旋转到左右已把它改写为 lr（与下次点击行为自洽）
    const tabBtn2 = await splitBtnTitleOfStaging(page);
    ck.check("旋转改写方向记忆（回到右侧）", tabBtn2.includes("右"), tabBtn2);

    // ── 拖拽组合分屏（拖标签到终端区，Windows Terminal 语义）──
    // 拖拽组合分屏轮起标签拖拽是 pointer 自定义拖拽（HTML5 DnD 在 WebView2 被 wry
    // 的 IDropTarget 接管根本发不起来）——playwright 真鼠标三端一致，demo 即测真路径。
    // mode "over"=按住拖到位不松（断言悬停提示）；"drop"=拖到位松手
    const tabDrag = async (namePart, fx, fy, mode = "drop") => {
      const pos = await page.evaluate(({ t, x, y }) => {
        const tab = [...document.querySelectorAll(".tab")].find((el) => el.textContent.includes(t));
        if (!tab) throw new Error("tab not found: " + t);
        // 抓标签文字中心（人手抓标签的自然位置，避开常显的分屏/关闭钮）
        const s = tab.querySelector(".tab-label").getBoundingClientRect();
        const el = document.getElementById("term");
        const r = el.getBoundingClientRect();
        return { sx: s.left + s.width / 2, sy: s.top + s.height / 2, tx: r.left + r.width * x, ty: r.top + r.height * y };
      }, { t: namePart, x: fx, y: fy });
      await page.mouse.move(pos.sx, pos.sy);
      await page.mouse.down();
      await page.mouse.move((pos.sx + pos.tx) / 2, (pos.sy + pos.ty) / 2, { steps: 4 });
      await page.mouse.move(pos.tx, pos.ty, { steps: 4 });
      await page.waitForTimeout(150);
      if (mode === "over") return;
      await page.mouse.up();
      await page.waitForTimeout(500);
    };

    // 两格归属按名牌（host_name）；hint 读落点提示层
    const paneNames = () => page.evaluate(() => {
      const name = (sel) => document.querySelector(sel)?.querySelector(".pane-tag")?.textContent ?? null;
      return {
        main: name(".pane-left, .pane-top"),
        second: name(".pane-right, .pane-bottom"),
        focused: name(".pane-focused"),
        hint: document.querySelector('[data-testid="drag-split-hint"] .dsh-zone')?.className ?? null,
      };
    });

    // ① 未分屏：拖 staging-1 悬停右半 → 出 zone-r 提示；松手 = 进右副格、焦点跟落点
    await tabDrag("staging-1", 0.9, 0.5, "over");
    const h1 = await paneNames();
    ck.check("拖标签悬停终端区出象限提示（zone-r）", (h1.hint ?? "").includes("zone-r"), h1.hint ?? "无提示");
    await page.mouse.up();
    await page.waitForTimeout(500);
    ck.check("拖右半建屏：双窗格", (await paneCount(page)) === 2, `panes=${await paneCount(page)}`);
    const p1 = await paneNames();
    ck.check("右半=副格（本机主 / staging-1 副）", p1.main === "本机" && p1.second === "staging-1", JSON.stringify(p1));
    ck.check("落点格拿焦点（staging-1）", p1.focused === "staging-1", JSON.stringify(p1));
    ck.check("drop 后提示已清", !await page.evaluate(() => !!document.querySelector('[data-testid="drag-split-hint"]')));

    // ② 已分屏：拖主格标签落到另一格 = 交换两格，焦点跟到落点格
    await tabDrag("本机", 0.9, 0.5, "drop");
    await page.waitForTimeout(500);
    const p2 = await paneNames();
    ck.check("主格标签拖到另一格=交换两格", p2.main === "staging-1" && p2.second === "本机", JSON.stringify(p2));
    ck.check("交换后焦点在落点格（本机）", p2.focused === "本机", JSON.stringify(p2));

    // ③ 落到自己所在格 = 无操作
    await tabDrag("本机", 0.9, 0.5, "drop");
    await page.waitForTimeout(400);
    const p3 = await paneNames();
    ck.check("落到自己所在格无操作", p3.main === "staging-1" && p3.second === "本机" && p3.focused === "本机", JSON.stringify(p3));

    // ④ 屏外会话（prod-1）拖到主格 = 替换主格，布局方向不动。
    //    落点取 x=0.1：上轮分割条测试把 frac 留在 0.2，主格只占左侧 20% 宽
    await tabDrag("prod-1", 0.1, 0.5, "drop");
    await page.waitForTimeout(500);
    const p4 = await paneNames();
    const dirStillLr = await page.evaluate(() => !!document.querySelector(".pane-div.div-lr"));
    ck.check("屏外会话拖到主格=替换主格", p4.main === "prod-1" && p4.second === "本机", JSON.stringify(p4));
    ck.check("替换不动布局方向（仍 div-lr）", dirStillLr, "");
    ck.check("替换后焦点在落点格（prod-1）", p4.focused === "prod-1", JSON.stringify(p4));

    // ⑤ 拖到标签条空白处（非任何标签上）= 退出分屏，两会话保留
    const blank = await page.evaluate(() => {
      const bar = document.querySelector(".tabbar").getBoundingClientRect();
      const tabs = document.querySelectorAll(".tab");
      const last = tabs[tabs.length - 1].getBoundingClientRect();
      return { x: Math.min(last.right + 40, bar.right - 8), y: bar.top + bar.height / 2 };
    });
    const src5 = await page.evaluate(() => {
      const tab = [...document.querySelectorAll(".tab")].find((el) => el.textContent.includes("staging-1"));
      const r = tab.querySelector(".tab-label").getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    });
    await page.mouse.move(src5.x, src5.y);
    await page.mouse.down();
    await page.mouse.move(blank.x, blank.y, { steps: 6 });
    await page.waitForTimeout(120);
    await page.mouse.up();
    await page.waitForTimeout(500);
    ck.check("拖到标签条空白=退出分屏且标签保留", (await paneCount(page)) === 0
      && await page.evaluate(() => document.querySelectorAll(".tab").length) >= 2);

    // ⑥ 单会话无可组合对象：悬停不出提示、drop 不建屏
    const closeTab = async (namePart) => {
      await rightClickTab(page, namePart);
      await clickItem(page, "关闭会话");
      await page.waitForTimeout(400);
      await page.evaluate(() => {
        const b = [...document.querySelectorAll(".confirm-dialog button")].find((x) => x.textContent.trim() === "关闭会话");
        if (b) b.click();
      });
      await page.waitForTimeout(600);
    };
    await closeTab("prod-1");
    await closeTab("staging-1");
    await tabDrag("本机", 0.9, 0.5, "over");
    ck.check("单会话拖终端区：无提示不建屏",
      !await page.evaluate(() => !!document.querySelector('[data-testid="drag-split-hint"]')) && (await paneCount(page)) === 0);
    await page.mouse.up();
    await page.waitForTimeout(300);
  },
};
