// 17 主机栏与终端区右键菜单（十一轮续）：右键通道补全——主机卡（连接/收藏切换/编辑/删除）、
// 终端区（复制仅选区在场/粘贴/全选）；Esc 与外点关闭。
const rightClick = async (page, evaluateFn) => {
  await page.evaluate(evaluateFn);
  await page.waitForTimeout(350);
};

const menuText = (page) =>
  page.evaluate(() => {
    const m = document.querySelector(".ctx-menu");
    return m ? m.innerText.replace(/\n+/g, " | ") : null;
  });

const clickItem = async (page, part) => {
  await page.evaluate((p) => {
    const b = [...document.querySelectorAll(".ctx-menu [role=menuitem]")].find((x) => x.textContent.includes(p));
    if (!b) throw new Error("menuitem not found: " + p);
    b.click();
  }, part);
  await page.waitForTimeout(500);
};

module.exports = {
  title: "主机栏与终端区右键菜单",
  async run({ page, ck }) {
    // 连接「本机」拿一个活动终端
    const c = await page.$('.host-card:has(.host-name:text-is("本机"))');
    await c.hover();
    await page.waitForTimeout(250);
    await (await c.$('button[title^="连接"]')).click();
    await page.waitForTimeout(1500);

    // ── 主机卡右键：连接/收藏/编辑/删除 ──
    await rightClick(page, () => {
      const card = [...document.querySelectorAll(".host-card")].find((x) => x.textContent.includes("staging-1"));
      if (!card) throw new Error("host-card not found");
      card.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 90, clientY: 320 }));
    });
    let menu = await menuText(page);
    ck.check("主机卡右键弹菜单", (await page.evaluate(() => !!document.querySelector(".ctx-menu"))), menu || "(无)");
    ck.check("含「连接/收藏/编辑/删除」", !!menu && menu.includes("连接") && menu.includes("收藏") && menu.includes("编辑主机") && menu.includes("删除主机"), "");

    // 收藏切换：点收藏 → 重开菜单变「取消收藏」→ 再点恢复（不留状态给其他 spec）
    await clickItem(page, "收藏");
    await rightClick(page, () => {
      const card = [...document.querySelectorAll(".host-card")].find((x) => x.textContent.includes("staging-1"));
      card.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 90, clientY: 320 }));
    });
    menu = await menuText(page);
    ck.check("收藏后菜单变「取消收藏」", !!menu && menu.includes("取消收藏"), "");
    await clickItem(page, "取消收藏");

    // 编辑入口打开既有表单（取消关闭，不留痕）
    await rightClick(page, () => {
      const card = [...document.querySelectorAll(".host-card")].find((x) => x.textContent.includes("staging-1"));
      card.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 90, clientY: 320 }));
    });
    await clickItem(page, "编辑主机");
    await page.waitForTimeout(400);
    const form = await page.evaluate(() => !!document.querySelector(".host-form, .add-host, [role=dialog]"));
    ck.check("「编辑主机」打开表单浮层", form, "");
    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);

    // ── Esc 关闭主机菜单 ──
    await rightClick(page, () => {
      const card = [...document.querySelectorAll(".host-card")].find((x) => x.textContent.includes("staging-1"));
      card.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 90, clientY: 320 }));
    });
    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);
    ck.check("Esc 关闭主机菜单", (await menuText(page)) === null, "");

    // ── 终端区右键：无选区无「复制」，有「粘贴/全选」 ──
    await rightClick(page, () => {
      const t = document.querySelector("#term");
      const r = t.getBoundingClientRect();
      t.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: r.left + 300, clientY: r.top + 150 }));
    });
    menu = await menuText(page);
    ck.check("终端区右键弹菜单", (await page.evaluate(() => !!document.querySelector(".ctx-menu"))), menu || "(无)");
    ck.check("无选区时无「复制」项", !!menu && !menu.includes("复制"), "");
    ck.check("有「粘贴」「全选」", !!menu && menu.includes("粘贴") && menu.includes("全选"), "");

    // 程序化造选区（DEV 探针 __t_terms）→ 重开菜单出现「复制」
    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);
    await page.evaluate(() => {
      const terms = window.__t_terms;
      if (!terms) throw new Error("__t_terms probe missing (dev only)");
      for (const [, t] of terms) { t.select(0, 0, 12); break; }
    });
    await rightClick(page, () => {
      const t = document.querySelector("#term");
      const r = t.getBoundingClientRect();
      t.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: r.left + 300, clientY: r.top + 150 }));
    });
    menu = await menuText(page);
    ck.check("有选区时出现「复制」项", !!menu && menu.includes("复制"), "");

    // ── 快捷键提示（本轮）：只显示真实绑定，查找项由 keymap 真源派生 ──
    // 平台判定与 ui/src/actions.ts 的 isMacPlatform 同口径。
    const mac = await page.evaluate(() => /mac|iphone|ipad|ios/i.test(
      (navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || navigator.userAgent || ""));
    const hintOf = (part) =>
      page.evaluate((p) => {
        const b = [...document.querySelectorAll(".ctx-menu [role=menuitem]")].find((x) => x.textContent.includes(p));
        return b ? (b.querySelector(".sm-key")?.textContent ?? null) : "__missing__";
      }, part);
    const hSearch = await hintOf("查找");
    const hCopy = await hintOf("复制");
    const hPaste = await hintOf("粘贴");
    const hSelectAll = await hintOf("全选");
    const hClear = await hintOf("清屏");
    const hMouse = await hintOf("重置鼠标上报");
    const hRedraw = await hintOf("重绘终端画面");
    ck.check("查找项提示 = 当前平台 formatBinding", hSearch === (mac ? "⌘F" : "Ctrl+Shift+F"), `mac=${mac} hint=${hSearch}`);
    ck.check("复制项提示为真实绑定", hCopy === (mac ? "⌘C" : "Ctrl+Shift+C"), `mac=${mac} hint=${hCopy}`);
    ck.check("粘贴项提示为真实绑定", hPaste === (mac ? "⌘V" : "Ctrl+V"), `mac=${mac} hint=${hPaste}`);
    ck.check("全选提示仅 mac（Win/Linux 无绑定不显示）", mac ? hSelectAll === "⌘A" : hSelectAll === null, `mac=${mac} hint=${hSelectAll}`);
    ck.check("清屏无快捷键不显示提示", hClear === null, `hint=${hClear}`);
    ck.check("重置鼠标上报/重绘无快捷键不显示提示", hMouse === null && hRedraw === null, `mouse=${hMouse} redraw=${hRedraw}`);
    const searchAria = await page.evaluate(() => {
      const b = [...document.querySelectorAll(".ctx-menu [role=menuitem]")].find((x) => x.textContent.includes("查找"));
      return b ? b.getAttribute("aria-keyshortcuts") : null;
    });
    ck.check("查找项 aria-keyshortcuts 与平台绑定一致", searchAria === (mac ? "Meta+F" : "Control+Shift+F"), String(searchAria));

    // 点外关闭（用左侧空白坐标：菜单在终端右下方向，固定 700,500 会随菜单项增多落进菜单里）
    await page.mouse.click(20, 200);
    await page.waitForTimeout(300);
    ck.check("点击菜单外关闭", (await menuText(page)) === null, "");
  },
};
