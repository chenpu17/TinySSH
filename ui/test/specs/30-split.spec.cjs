// 30 分屏交互（分屏⑥轮）：方向可选（左右/上下，记住上次选择）、分割条拖拽与双击复位、
// 分屏中旋转布局、退出恢复单窗格。拖拽组合轮：标签拖到终端区四象限建屏/换格；一组一标签
// （Termius 式）下组标签只重排、拖进终端区无操作，散组走右键「退出分屏」。demo 预置
// prod-1/staging-1 开箱即用，不依赖真连。
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

// 分割条上的取点：f=沿长轴的位置分数。组名胶囊叠在条身正中央（双击胶囊=改名），
// 拖拽/双击复位必须抓条身两侧（f≤0.2 / ≥0.8）避开胶囊——「点胶囊=改名、点条身=
// 拖比例/复位」是本轮定下的交互契约
const divPoint = (page, f) =>
  page.evaluate((frac) => {
    const d = document.querySelector(".pane-div");
    if (!d) return null;
    const r = d.getBoundingClientRect();
    const long = r.width >= r.height
      ? { total: r.width, axis: "x" } : { total: r.height, axis: "y" };
    const off = long.total * frac;
    return { x: r.x + (long.axis === "x" ? off : r.width / 2), y: r.y + (long.axis === "y" ? off : r.height / 2) };
  }, f);

// 方向记忆的观测点（七轮：标签上的分屏小钮已按用户意见删除，改从右键菜单文案读）——
// 分屏中菜单项「改为左右分屏」= 当前是上下；未分屏时「…（放到右侧）」= 记忆是左右。
// 读完点遮罩关菜单，免得挡住后续拖拽落点。
const tabMenuTexts = async (page, namePart) => {
  await rightClickTab(page, namePart);
  const texts = await page.evaluate(() =>
    [...document.querySelectorAll(".ctx-menu [role=menuitem]")].map((x) => x.textContent || ""));
  await page.evaluate(() => document.querySelectorAll(".pop-mask").forEach((m) => m.click()));
  await page.waitForTimeout(200);
  return texts;
};

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
    // 子窗口卡片化：3px 卡缝用「页面底」色（与卡片 --bg 拉开一档色差）= 两格间约
    // 6px 呼吸缝不再与子窗口同色，10px 圆角与终端外框同语言；外框几何仍由
    // --split-frac 决定（上面 g1 已验）。
    const cardStyle = await page.evaluate(() => {
      const el = document.querySelector(".pane-left, .pane-top");
      const cs = getComputedStyle(el);
      return {
        border: cs.borderTopWidth, radius: cs.borderRadius, overflow: cs.overflow,
        clip: cs.backgroundClip, color: cs.borderTopColor, bg: cs.backgroundColor,
      };
    });
    ck.check("分屏子窗口卡片化：3px 卡缝（页面底色差）+ 10px 圆角 + 卡片本体仍是终端底色",
      cardStyle.border === "3px" && cardStyle.radius === "10px" && cardStyle.overflow === "hidden"
        && cardStyle.clip === "padding-box"
        && !/rgba?\(0, 0, 0, 0\)|transparent/.test(cardStyle.color)
        && cardStyle.color !== cardStyle.bg,
      JSON.stringify(cardStyle));
    const divTb = await page.evaluate(() => !!document.querySelector('.pane-div[data-testid="pane-div"].div-tb'));
    ck.check("分割条出现且为竖向拖拽（div-tb）", divTb, "");
    const tbMenu = await tabMenuTexts(page, "staging-1");
    ck.check("方向记忆=上下（分屏中菜单项「改为左右分屏」）",
      tbMenu.some((x) => x.includes("改为左右分屏")), tbMenu.join(" | "));
    // 竖排两格各占一半（frac 必须真被写进 #term，缺失=null 直接红）
    ck.check("初始对半（frac 写入且两格等高）",
      g1.frac !== null && Math.abs(g1.frac - 0.5) < 0.02 && Math.abs((g1.main?.h ?? 0) - (g1.second?.h ?? 0)) <= 2,
      JSON.stringify(g1));

    // ── 拖拽分割条上移 12%：主格变矮、frac 减小（抓条身 f=0.2 段，避开中央胶囊）──
    const c1 = await divPoint(page, 0.2);
    const termH = await page.evaluate(() => document.getElementById("term").getBoundingClientRect().height);
    await page.mouse.move(c1.x, c1.y);
    await page.mouse.down();
    await page.mouse.move(c1.x, c1.y - termH * 0.12, { steps: 6 });
    await page.mouse.up();
    await page.waitForTimeout(400);
    const g2 = await paneGeom(page);
    ck.check("拖拽后占比减小（0.2≤frac<0.45）", g2.frac >= 0.2 - 1e-6 && g2.frac < 0.45, JSON.stringify(g2));
    ck.check("上格变矮、下格变高", g2.main.h < g1.main.h - 20 && g2.second.h > g1.second.h + 20, JSON.stringify(g2));

    // ── 双击复位对半（条身 f=0.8 段——正中央是组名胶囊，双击它=改名）──
    const c2 = await divPoint(page, 0.8);
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
    // 横排下拖拽夹取下限：向左猛拖 80% 宽 → frac 夹在 0.2（抓条身 f=0.2 段）
    const c3 = await divPoint(page, 0.2);
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
    // 方向记忆=上次使用的方向：旋转到左右已把它改写为 lr（与下次点击行为自洽）——
    // 退出后右键非活动标签，菜单项应写「放到右侧」
    const lrMenu = await tabMenuTexts(page, "staging-1");
    ck.check("旋转改写方向记忆（回到右侧）",
      lrMenu.some((x) => x.includes("放到右侧")), lrMenu.join(" | "));

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

    // 两格归属按名牌（host_name + 非连接态后缀）；hint 读落点提示层
    const paneNames = () => page.evaluate(() => {
      // 名牌=主机名 + 非连接态后缀「 · 已断开」（找茬五轮 C-4：黑腔格的状态指示）
      // ——身份比对剥后缀，后缀本身单独断言
      const name = (sel) => document.querySelector(sel)?.querySelector(".pane-tag-label")?.textContent?.replace(/ · (已断开|重连中…|连接中断|已重连 · 待核实)$/, "") ?? null;
      return {
        main: name(".pane-left, .pane-top"),
        second: name(".pane-right, .pane-bottom"),
        focused: name(".pane-focused"),
        hint: document.querySelector('[data-testid="drag-split-hint"] .dsh-zone')?.className ?? null,
      };
    });
    // C-4 契约：断开会话的副格名牌带状态后缀（黑腔不再无解释）
    const secondRaw = () => page.evaluate(() =>
      document.querySelector(".pane-right, .pane-bottom")?.querySelector(".pane-tag-label")?.textContent ?? null);

    // ① 未分屏：拖 staging-1 悬停右半 → 出 zone-r 提示；松手 = 进右副格、焦点跟落点
    await tabDrag("staging-1", 0.9, 0.5, "over");
    const h1 = await paneNames();
    ck.check("拖标签悬停终端区出象限提示（zone-r）", (h1.hint ?? "").includes("zone-r"), h1.hint ?? "无提示");
    ck.check("未分屏落点文案=放到右侧分屏",
      (await page.evaluate(() => document.querySelector('[data-testid="dsh-label"]')?.textContent ?? "")) === "放到右侧分屏", "");
    await page.mouse.up();
    await page.waitForTimeout(500);
    ck.check("拖右半建屏：双窗格", (await paneCount(page)) === 2, `panes=${await paneCount(page)}`);
    const p1 = await paneNames();
    ck.check("右半=副格（本机主 / staging-1 副）", p1.main === "本机" && p1.second === "staging-1", JSON.stringify(p1));
    ck.check("落点格拿焦点（staging-1）", p1.focused === "staging-1", JSON.stringify(p1));
    // C-4 后缀靠 React 渲染流进新挂的副格名牌——全套负载下固定 500ms 单发读会抖
    // （后缀迟到 = 假红，2026-11-06 全套实测）；轮询 5s 等它落定，恒缺仍红（契约不弱化）
    let suffixSeen = false;
    for (let i = 0; i < 32 && !suffixSeen; i++) {
      suffixSeen = (await secondRaw()) === "staging-1 · 已断开";
      if (!suffixSeen) await page.waitForTimeout(150);
    }
    ck.check("断开会话副格名牌带「· 已断开」后缀（找茬五轮 C-4）", suffixSeen, await secondRaw() ?? "无名牌");
    ck.check("drop 后提示已清", !await page.evaluate(() => !!document.querySelector('[data-testid="drag-split-hint"]')));

    // ② 一组一标签：组成员不再有独立标签——拖组标签进终端区无落点、无操作
    await tabDrag("本机", 0.9, 0.5, "over");
    ck.check("组标签悬停终端区：无落点提示",
      !await page.evaluate(() => !!document.querySelector('[data-testid="drag-split-hint"]')), "");
    await page.mouse.up();
    await page.waitForTimeout(400);
    const p2 = await paneNames();
    ck.check("组标签拖进终端区=无操作（两格与焦点不变）",
      p2.main === "本机" && p2.second === "staging-1" && p2.focused === "staging-1", JSON.stringify(p2));

    // ── 分屏组命名（本轮）：组=分屏对命名层——自动名=成员名相连、双击胶囊重命名、
    //    自定义名钉住（成员替换不跟随）、散伙弃名（重分屏回自动名）──
    //    每标签独立分屏后每组自带占比：本组由拖拽新建（默认 0.5），先把条身拖到
    //    0.2 作为「双击胶囊不改比例」的观测值（抓 f=0.8 段：f=0.2 段会被焦点会话的
    //    tmux「恢复现场」浮钮覆盖）
    const c4 = await divPoint(page, 0.8);
    const termW4 = await page.evaluate(() => document.getElementById("term").getBoundingClientRect().width);
    await page.mouse.move(c4.x, c4.y);
    await page.mouse.down();
    await page.mouse.move(c4.x - termW4 * 0.35, c4.y, { steps: 6 });
    await page.mouse.up();
    await page.waitForTimeout(400);
    const g5 = await paneGeom(page);
    ck.check("本组拖到 0.2（每组独立占比）", Math.abs(g5.frac - 0.2) < 0.02, JSON.stringify(g5));
    // 组名胶囊默认隐形（不遮挡终端正文），悬停分割条才显形
    await page.mouse.move(120, 500);
    await page.waitForTimeout(240);
    const chipOpacity = () => page.evaluate(() => {
      const c = document.querySelector('[data-testid="split-group-chip"]');
      return c ? getComputedStyle(c).opacity : null;
    });
    const opRest = await chipOpacity();
    ck.check("组名胶囊默认隐形（不遮挡正文）", opRest === "0", `opacity=${opRest}`);
    const hoverDiv = await divPoint(page, 0.5);
    await page.mouse.move(hoverDiv.x, hoverDiv.y);
    await page.waitForTimeout(240);
    const opHover = await chipOpacity();
    ck.check("悬停分割条时组名胶囊显形", opHover === "1", `opacity=${opHover}`);
    const chipText = () => page.evaluate(() =>
      document.querySelector('[data-testid="split-group-chip"] .div-group-name')?.textContent ?? null);
    ck.check("组名胶囊在场且为自动名（成员名相连）", (await chipText()) === "本机 + staging-1", (await chipText()) ?? "无胶囊");
    const chipBox = await page.evaluate(() => {
      const c = document.querySelector('[data-testid="split-group-chip"]');
      if (!c) return null;
      const r = c.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    });
    await page.mouse.dblclick(chipBox.x, chipBox.y);
    await page.waitForTimeout(300);
    ck.check("双击胶囊出改名框", !!(await page.evaluate(() => document.querySelector(".split-group-rename"))), "");
    await page.keyboard.type("生产组");
    await page.keyboard.press("Enter");
    await page.waitForTimeout(300);
    ck.check("回车提交自定义组名（生产组）", (await chipText()) === "生产组", (await chipText()) ?? "无胶囊");
    // 双击胶囊改名不触发分割条复位：frac 仍为本组刚拖到的 0.2
    const fracAfterRename = await page.evaluate(() =>
      parseFloat(document.getElementById("term")?.style.getPropertyValue("--split-frac") ?? "NaN"));
    ck.check("胶囊双击不触发条身复位（frac 保持 0.2）", Math.abs(fracAfterRename - 0.2) < 0.02, `frac=${fracAfterRename}`);

    // ④ 屏外会话（prod-1）拖到主格 = 替换主格，布局方向不动。
    //    落点取 x=0.1：上轮分割条测试把 frac 留在 0.2，主格只占左侧 20% 宽
    await tabDrag("prod-1", 0.1, 0.5, "drop");
    await page.waitForTimeout(500);
    const p4 = await paneNames();
    const dirStillLr = await page.evaluate(() => !!document.querySelector(".pane-div.div-lr"));
    ck.check("屏外会话拖到主格=替换主格", p4.main === "prod-1" && p4.second === "staging-1", JSON.stringify(p4));
    ck.check("替换不动布局方向（仍 div-lr）", dirStillLr, "");
    ck.check("替换后焦点在落点格（prod-1）", p4.focused === "prod-1", JSON.stringify(p4));
    ck.check("成员替换后自定义名钉住（仍生产组）", (await chipText()) === "生产组", (await chipText()) ?? "无胶囊");

    // ⑤ 标签条空白落点：非成员 no-op；组标签（一组一标签）拖空白也 no-op、组保留。
    //    退出分屏改走组标签右键「退出分屏」——组成员已没有独立标签可“拖出”
    const blank = await page.evaluate(() => {
      const bar = document.querySelector(".tabbar").getBoundingClientRect();
      const tabs = document.querySelectorAll(".tab");
      const last = tabs[tabs.length - 1].getBoundingClientRect();
      return { x: Math.min(last.right + 40, bar.right - 8), y: bar.top + bar.height / 2 };
    });
    const tabLabelPoint = (namePart) => page.evaluate((t) => {
      const tab = [...document.querySelectorAll(".tab")].find((el) => el.textContent.includes(t));
      const r = tab.querySelector(".tab-label").getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    }, namePart);
    // 此时组成员=prod-1 + staging-1（本机已在 ④ 被换出）——非成员拖空白不动任何组
    const srcNon = await tabLabelPoint("本机");
    await page.mouse.move(srcNon.x, srcNon.y);
    await page.mouse.down();
    await page.mouse.move(blank.x, blank.y, { steps: 6 });
    await page.waitForTimeout(120);
    await page.mouse.up();
    await page.waitForTimeout(500);
    ck.check("非成员拖到标签条空白=无操作（活动组保留）", (await paneCount(page)) === 2
      && !!(await page.evaluate(() => !!document.querySelector('[data-testid="split-group-chip"]'))), "");
    // 组标签已改名为「生产组」——按组名取它的文字中心（textContent 不含成员名）
    const src5 = await tabLabelPoint("生产组");
    await page.mouse.move(src5.x, src5.y);
    await page.mouse.down();
    await page.mouse.move(blank.x, blank.y, { steps: 6 });
    await page.waitForTimeout(120);
    await page.mouse.up();
    await page.waitForTimeout(500);
    ck.check("组标签拖到标签条空白=无操作（组保留、两格不变）", (await paneCount(page)) === 2
      && !!(await page.evaluate(() => !!document.querySelector('[data-testid="split-group-chip"]'))), "");

    // 显式退出分屏：组解散成两个独立标签
    await rightClickTab(page, "生产组");
    await clickItem(page, "退出分屏");
    await page.waitForTimeout(400);
    ck.check("退出分屏后两成员各自独立成标签", (await paneCount(page)) === 0
      && await page.evaluate(() => document.querySelectorAll(".tab").length) >= 2, "");
    ck.check("散伙后组名胶囊消失", !(await page.evaluate(() => !!document.querySelector('[data-testid="split-group-chip"]'))), "");

    // ── 重分屏：自定义名不复活，回自动名；右键菜单入口也能改名，Esc 取消 ──
    await tabDrag("staging-1", 0.9, 0.5, "drop");
    await page.waitForTimeout(500);
    ck.check("重分屏回自动名（旧自定义名已弃）", (await chipText()) === "prod-1 + staging-1", (await chipText()) ?? "无胶囊");
    await rightClickTab(page, "staging-1");
    ck.check("右键菜单有「重命名分组…」", await page.evaluate(() =>
      [...document.querySelectorAll(".ctx-menu [role=menuitem]")].some((x) => x.textContent.includes("重命名分组"))), "");
    await clickItem(page, "重命名分组");
    await page.waitForTimeout(300);
    // 组成员没有独立标签：右键组标签的改名框必须开在组标签行内（source=tab），
    // 不能还去等分割条胶囊上的 .split-group-rename（那条路径已移除）
    ck.check("菜单入口在组标签行内打开改名框（预填当前组名）",
      await page.evaluate(() => {
        const inp = document.querySelector(".tab .tab-rename");
        return !!inp && inp.value === "prod-1 + staging-1";
      }), "");
    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);
    ck.check("Esc 取消改名（回自动名显示）", (await chipText()) === "prod-1 + staging-1", (await chipText()) ?? "无胶囊");

    // ── 拖拽硬化：标签内小幅滑动不起拖；Esc 取消拖拽不落格；成员拖回自己标签不散组 ──
    const activeBefore = await page.evaluate(() => document.querySelector(".tab-active .tab-label")?.textContent ?? "");
    const jitter = await page.evaluate(() => {
      const tab = [...document.querySelectorAll(".tab")].find((el) => el.classList.contains("tab-active"));
      const r = tab.querySelector(".tab-label").getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    });
    await page.mouse.move(jitter.x, jitter.y);
    await page.mouse.down();
    await page.mouse.move(jitter.x + 20, jitter.y, { steps: 4 });
    await page.waitForTimeout(120);
    const jitterHint = await page.evaluate(() => !!document.querySelector('[data-testid="drag-split-hint"]'));
    await page.mouse.up();
    await page.waitForTimeout(400);
    ck.check("标签内部横向滑动 20px 不起拖（无落点提示、组不变）",
      !jitterHint && (await paneCount(page)) === 2
      && (await page.evaluate(() => document.querySelector(".tab-active .tab-label")?.textContent ?? "")) === activeBefore,
      `hint=${jitterHint} active=${activeBefore}`);

    // Esc 取消：悬停到替换格后按 Esc，再松手不得建屏/换格
    await tabDrag("本机", 0.9, 0.5, "over");
    ck.check("非成员落点文案=替换右格",
      (await page.evaluate(() => document.querySelector('[data-testid="dsh-label"]')?.textContent ?? "")) === "替换右格", "");
    await page.keyboard.press("Escape");
    await page.waitForTimeout(150);
    const escHint = await page.evaluate(() => !!document.querySelector('[data-testid="drag-split-hint"]'));
    await page.mouse.up();
    await page.waitForTimeout(400);
    const afterEsc = await paneNames();
    ck.check("Esc 取消拖拽：提示消失、组保持原状",
      !escHint && afterEsc.main === "prod-1" && afterEsc.second === "staging-1", JSON.stringify(afterEsc));

    // 组标签悬停到终端区 → 一组一标签下无可换/可拆语义，不出落点文案与提示
    await tabDrag("staging-1", 0.1, 0.5, "over");
    ck.check("组标签悬停终端区无落点文案",
      !(await page.evaluate(() => document.querySelector('[data-testid="dsh-label"]'))), "");
    ck.check("组标签悬停终端区无象限提示",
      !(await page.evaluate(() => !!document.querySelector('[data-testid="drag-split-hint"]'))), "");
    await page.keyboard.press("Escape");
    await page.mouse.up();
    await page.waitForTimeout(300);

    // 组标签拖出再拖回自身标签 = no-op，组保留
    const ownTab = await page.evaluate(() => {
      const tab = [...document.querySelectorAll(".tab")].find((el) => el.textContent.includes("staging-1"));
      const r = tab.querySelector(".tab-label").getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    });
    await page.mouse.move(ownTab.x, ownTab.y);
    await page.mouse.down();
    await page.mouse.move(ownTab.x, ownTab.y + 70, { steps: 4 }); // 进终端区起拖
    await page.mouse.move(ownTab.x, ownTab.y, { steps: 4 });       // 回到自己的标签
    await page.mouse.up();
    await page.waitForTimeout(500);
    ck.check("组标签拖回自身标签=no-op（组保留）", (await paneCount(page)) === 2
      && (await paneNames()).main === "prod-1", JSON.stringify(await paneNames()));

    // ── 窗格直接操作：最大化/还原、交换、退出 ──
    const clickPaneBtn = async (testid, sel = ".pane-left, .pane-right, .pane-top, .pane-bottom") =>
      page.evaluate(({ tid, s }) => {
        const pane = [...document.querySelectorAll(s)].find((el) => getComputedStyle(el).display !== "none");
        const b = pane?.querySelector(`[data-testid="${tid}"]`);
        if (!b) throw new Error("pane button not found: " + tid);
        b.click();
      }, { tid: testid, s: sel });
    await clickPaneBtn("pane-max");
    await page.waitForTimeout(500);
    const maxState = await page.evaluate(() => {
      const max = document.querySelector(".pane-max");
      const hidden = document.querySelector(".pane-hidden");
      const r = max?.getBoundingClientRect();
      const tr = document.getElementById("term")?.getBoundingClientRect();
      return {
        max: !!max, hidden: !!hidden,
        full: !!r && !!tr && Math.abs(r.width - tr.width) < 3 && Math.abs(r.height - tr.height) < 3,
        div: !!document.querySelector(".pane-div"),
        title: max?.querySelector('[data-testid="pane-max"]')?.getAttribute("title") ?? null,
      };
    });
    ck.check("pane-max 最大化：一格全幅、另一格 pane-hidden、分割条撤收",
      maxState.max && maxState.hidden && maxState.full && !maxState.div, JSON.stringify(maxState));
    ck.check("最大化钮换装为还原", maxState.title === "还原双窗格", maxState.title ?? "");
    await clickPaneBtn("pane-max");
    await page.waitForTimeout(500);
    ck.check("再点还原：两格回归、分割条回来", await page.evaluate(() =>
      !!document.querySelector(".pane-left") && !!document.querySelector(".pane-right")
      && !document.querySelector(".pane-max") && !!document.querySelector(".pane-div")), "");

    const beforeSwap = await paneNames();
    await clickPaneBtn("pane-swap");
    await page.waitForTimeout(500);
    const afterSwap = await paneNames();
    ck.check("pane-swap 交换两格", afterSwap.main === beforeSwap.second && afterSwap.second === beforeSwap.main,
      JSON.stringify({ beforeSwap, afterSwap }));

    // ── 窗格按钮键盘可达：在非活动格上按 Enter 最大化，活动会话必须先切过去 ──
    // 否则最大化把活动终端藏进 pane-hidden：标签高亮/⌘W/右键都指向隐藏会话
    const kbTarget = await page.evaluate(() => {
      const active = document.querySelector(".tab.tab-active")?.dataset.sid;
      const pane = [...document.querySelectorAll(".pane-left, .pane-right, .pane-top, .pane-bottom")]
        .find((el) => getComputedStyle(el).display !== "none" && el.dataset.sid !== active);
      const b = pane?.querySelector('[data-testid="pane-max"]');
      if (!b) throw new Error("non-active pane-max not found");
      b.focus();
      return { sid: pane.dataset.sid, focused: document.activeElement === b };
    });
    ck.check("非活动格的最大化钮可键盘聚焦", kbTarget.focused, JSON.stringify(kbTarget));
    await page.keyboard.press("Enter");
    await page.waitForTimeout(500);
    const kbState = await page.evaluate(() => ({
      active: document.querySelector(".tab.tab-active")?.dataset.sid ?? null,
      maxSid: document.querySelector(".pane-max")?.dataset.sid ?? null,
      focusedSid: document.querySelector(".pane-focused")?.dataset.sid ?? null,
    }));
    ck.check("Enter 最大化：活动会话切到该格、最大化格即焦点格",
      kbState.maxSid === kbTarget.sid && kbState.active === kbTarget.sid && kbState.focusedSid === kbTarget.sid,
      JSON.stringify({ kbTarget, kbState }));
    await page.evaluate(() => document.querySelector(".pane-max [data-testid='pane-max']")?.click());
    await page.waitForTimeout(500);

    // ── 分割条键盘：方向键 ±2%、Shift ±10%、Home/End 到两端 ──
    const focusDiv = () => page.evaluate(() => document.querySelector(".pane-div")?.focus());
    const fracNow = () => page.evaluate(() =>
      parseFloat(document.getElementById("term")?.style.getPropertyValue("--split-frac") ?? "NaN"));
    await focusDiv();
    await page.keyboard.press("ArrowRight");
    await page.waitForTimeout(150);
    const f1 = await fracNow();
    ck.check("分割条 ArrowRight +2%", Math.abs(f1 - 0.52) < 0.011, `frac=${f1}`);
    await page.keyboard.press("Shift+ArrowRight");
    await page.waitForTimeout(150);
    const f2 = await fracNow();
    ck.check("分割条 Shift+ArrowRight +10%", Math.abs(f2 - 0.62) < 0.011, `frac=${f2}`);
    await page.keyboard.press("Home");
    await page.waitForTimeout(150);
    const f3 = await fracNow();
    await page.keyboard.press("End");
    await page.waitForTimeout(150);
    const f4 = await fracNow();
    ck.check("分割条 Home/End 到两端（0.2/0.8）", Math.abs(f3 - 0.2) < 0.011 && Math.abs(f4 - 0.8) < 0.011,
      `home=${f3} end=${f4}`);

    // ── 组名胶囊键盘：Enter 进入改名，提交后名字更新 ──
    await page.evaluate(() => document.querySelector('[data-testid="split-group-chip"]')?.focus());
    await page.keyboard.press("Enter");
    await page.waitForTimeout(250);
    ck.check("胶囊 Enter 打开改名框", !!(await page.evaluate(() => document.querySelector(".split-group-rename"))), "");
    await page.keyboard.type("键盘组");
    await page.keyboard.press("Enter");
    await page.waitForTimeout(300);
    ck.check("胶囊键盘改名提交", (await chipText()) === "键盘组", (await chipText()) ?? "无胶囊");

    // ── pane-exit：退出本组，两个标签都保留 ──
    await clickPaneBtn("pane-exit");
    await page.waitForTimeout(500);
    ck.check("pane-exit 退出分屏且标签保留", (await paneCount(page)) === 0
      && await page.evaluate(() => document.querySelectorAll(".tab").length) >= 2, "");

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

    // ── 分屏掉线遮罩（本轮 C）：按窗格自身状态蒙住本格，另一格不受影响；
    //    全局 .dead-overlay 只在单窗口径出现；遮罩内「重连／退出分屏」走既有路径 ──
    // 重新连一台 prod-1（前面已关闭其标签），再与本机组成 A|B
    const prodCard = await page.$('.host-card:has(.host-name:text-is("prod-1"))');
    await prodCard.hover();
    await page.waitForTimeout(250);
    await (await prodCard.$('button[title^="连接"]')).click();
    await page.waitForTimeout(1500);
    await page.evaluate(() => {
      [...document.querySelectorAll(".tab")].find((t) => t.textContent.includes("本机"))?.click();
    });
    await page.waitForTimeout(600);
    await rightClickTab(page, "prod-1");
    await clickItem(page, "与当前会话分屏");
    await page.waitForTimeout(600);
    const pair = await page.evaluate(() => ({
      main: document.querySelector(".pane-left, .pane-top")?.dataset.sid ?? null,
      second: document.querySelector(".pane-right, .pane-bottom")?.dataset.sid ?? null,
    }));
    ck.check("C 场景：本机|prod-1 分屏就绪", !!pair.main && !!pair.second && pair.main !== pair.second, JSON.stringify(pair));
    const deadSid = pair.second;
    const liveSid = pair.main;

    await page.evaluate((sid) => window.__demoInvoke("demo_drop_session", { sid, recoverOnAttempt: 0 }), deadSid);
    const paneScrims = () => page.evaluate(() =>
      [...document.querySelectorAll(".pane-left, .pane-right, .pane-top, .pane-bottom")].map((el) => {
        const sc = el.querySelector('[data-testid="pane-state-scrim"]');
        return {
          sid: el.dataset.sid,
          dead: el.classList.contains("pane-dead"),
          state: sc?.dataset.state ?? null,
          display: sc ? getComputedStyle(sc).display : null,
          text: el.querySelector(".pane-scrim-state")?.textContent ?? "",
          focused: el.classList.contains("pane-focused"),
        };
      }));
    let scrims = [];
    for (let i = 0; i < 40; i++) {
      scrims = await paneScrims();
      if (scrims.find((x) => x.sid === deadSid)?.state === "Disconnected") break;
      await page.waitForTimeout(150);
    }
    const deadP = scrims.find((x) => x.sid === deadSid);
    const liveP = scrims.find((x) => x.sid === liveSid);
    ck.check("掉线格按自身状态显示遮罩（Disconnected/已断开）",
      !!deadP && deadP.dead && deadP.state === "Disconnected" && deadP.display === "flex"
        && deadP.text === "已断开", JSON.stringify(deadP));
    ck.check("健康格不被遮罩：无 pane-dead、遮罩不显示",
      !!liveP && !liveP.dead && liveP.state === "Connected" && liveP.display === "none",
      JSON.stringify(liveP));

    // 焦点切换走真实路径：mousedown 冒泡到 #term 的委托（focusSession），
    // 只调 textarea.focus() 不会切换 pane-focused
    const focusPane = (sid) => page.evaluate((id) => {
      document.querySelector(`.term-session[data-sid="${id}"]`)?.dispatchEvent(
        new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 }));
    }, sid);
    // 焦点落在死格：分屏中不得再渲染全局遮罩（否则会把两格一起蒙住）
    await focusPane(deadSid);
    await page.waitForTimeout(450);
    const focusedDead = await page.evaluate(() => ({
      focused: document.querySelector(".pane-focused")?.dataset.sid ?? null,
      overlay: !!document.querySelector(".dead-overlay"),
    }));
    ck.check("焦点死格时分屏内不渲染全局 .dead-overlay",
      focusedDead.focused === deadSid && !focusedDead.overlay,
      JSON.stringify({ deadSid, ...focusedDead }));
    // 再把焦点挪到健康格：死格变非焦点，遮罩仍只压它自己
    await focusPane(liveSid);
    await page.waitForTimeout(450);
    scrims = await paneScrims();
    const deadP2 = scrims.find((x) => x.sid === deadSid);
    const liveP2 = scrims.find((x) => x.sid === liveSid);
    ck.check("非焦点死格遮罩仍只压本格（健康格无遮罩、无全局叠层）",
      deadP2?.dead && deadP2.display === "flex" && liveP2?.focused && !liveP2.dead
        && liveP2.display === "none"
        && !(await page.evaluate(() => !!document.querySelector(".dead-overlay"))),
      JSON.stringify({ deadP2, liveP2 }));

    const scrimActions = await page.evaluate(() => {
      const dead = document.querySelector(".pane-dead");
      const r = dead?.querySelector('[data-testid="pane-scrim-reconnect"]');
      const x = dead?.querySelector('[data-testid="pane-scrim-exit"]');
      return { reconnect: !!r && !r.disabled, exit: !!x && !x.disabled, texts: [r?.textContent ?? "", x?.textContent ?? ""] };
    });
    ck.check("遮罩内「重连／退出分屏」可用",
      scrimActions.reconnect && scrimActions.exit
        && scrimActions.texts[0].includes("重连") && scrimActions.texts[1].includes("退出分屏"),
      JSON.stringify(scrimActions));

    // 点「重连」= 既有 reconnectSession：Reconnecting → Reconfirming，窗格遮罩撤除
    await page.evaluate(() => document.querySelector(".pane-dead [data-testid='pane-scrim-reconnect']")?.click());
    let reState = null;
    for (let i = 0; i < 40; i++) {
      reState = (await paneScrims()).find((x) => x.sid === deadSid);
      if (reState?.state === "Reconfirming") break;
      await page.waitForTimeout(120);
    }
    ck.check("遮罩「重连」走既有重连链并进入待核实（遮罩撤除）",
      reState?.state === "Reconfirming" && !reState.dead && reState.display === "none",
      JSON.stringify(reState));
    let recRaw = null;
    for (let i = 0; i < 20; i++) {
      recRaw = await secondRaw();
      if (recRaw?.includes("已重连 · 待核实")) break;
      await page.waitForTimeout(100);
    }
    ck.check("Reconfirming 名牌用真实状态文案（不再误标「重连中…」）",
      !!recRaw && recRaw.includes("已重连 · 待核实") && !recRaw.includes("重连中…"), recRaw ?? "无名牌");

    // 再断开一次，用遮罩「退出分屏」收尾：只解散本组，两个标签都保留
    await page.evaluate((sid) => window.__demoInvoke("demo_drop_session", { sid, recoverOnAttempt: 0 }), deadSid);
    let deadAgain = null;
    for (let i = 0; i < 40; i++) {
      deadAgain = (await paneScrims()).find((x) => x.sid === deadSid);
      if (deadAgain?.state === "Disconnected") break;
      await page.waitForTimeout(150);
    }
    await page.evaluate(() => document.querySelector(".pane-dead [data-testid='pane-scrim-exit']")?.click());
    await page.waitForTimeout(600);
    const exitState = await page.evaluate(() => ({
      panes: document.querySelectorAll(".pane-left, .pane-right, .pane-top, .pane-bottom").length,
      tabs: document.querySelectorAll(".tab").length,
      dead: !!document.querySelector(".pane-dead"),
    }));
    ck.check("遮罩「退出分屏」解散本组且两个标签保留",
      exitState.panes === 0 && exitState.tabs >= 2 && !exitState.dead,
      JSON.stringify({ deadAgain, ...exitState }));
  },
};
