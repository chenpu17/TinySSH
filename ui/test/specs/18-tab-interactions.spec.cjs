// 18 标签交互四件套（十四轮）：右键/双击重命名标签（行内编辑，空名恢复主机名）、
// 中键关闭走确认契约（含取消路径）、终端右键「查找…」（切命中窗格开搜索框）与「清屏」。
// Ctrl+Tab/Ctrl+Shift+Tab 是 native 门（浏览器 demo 不劫持），真机验证，不在本 spec。
const connect = async (page, name) => {
  const c = await page.$(`.host-card:has(.host-name:text-is("${name}"))`);
  await c.hover();
  await page.waitForTimeout(250);
  await (await c.$('button[title^="连接"]')).click();
  await page.waitForTimeout(1400);
};

const rightClickTab = async (page, namePart) => {
  await page.evaluate((t) => {
    const tab = [...document.querySelectorAll(".tab")].find((x) => x.textContent.includes(t));
    if (!tab) throw new Error("tab not found: " + t);
    tab.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 380, clientY: 130 }));
  }, namePart);
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

const tabCount = (page) =>
  page.evaluate(() => document.querySelectorAll(".tab").length);

const activeLabel = (page) =>
  page.evaluate(() => document.querySelector(".tab-active .tab-label")?.textContent ?? null);

const renameInput = (page) =>
  page.evaluate(() => document.querySelector(".tab-rename")?.value ?? null);

const dblClickActiveTab = async (page) => {
  await page.evaluate(() => {
    const tab = document.querySelector(".tab-active");
    if (!tab) throw new Error("no active tab");
    tab.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true }));
  });
  await page.waitForTimeout(350);
};

// __t_terms 从不清理（探针无卸载钩子）——中键关闭后死会话的 term 实例仍在 map 里。
// 断言/写入只认「挂在 DOM 上、有非零矩形」的活终端，否则标记会写进死实例造成假红。
const bufHas = (page, needle) =>
  page.evaluate((s) => {
    for (const t of window.__t_terms ? [...window.__t_terms.values()].filter((t) => {
      const el = t.element;
      return !!el && el.isConnected && el.getBoundingClientRect().height > 0;
    }) : []) {
      const b = t.buffer.active;
      for (let y = 0; y < b.length; y++) {
        if ((b.getLine(y)?.translateToString(true) ?? "").includes(s)) return true;
      }
    }
    return false;
  }, needle);

module.exports = {
  title: "标签重命名/中键关闭/终端查找与清屏",
  async run({ page, ck }) {
    // ── 清 demo 预置（prod-1/staging-1），连接两台拿稳定双标签 ──
    // Disconnected 会话无确认框直接关，确认按钮存在才点
    const closeViaMenu = async (namePart) => {
      await rightClickTab(page, namePart);
      await clickItem(page, "关闭会话");
      await page.waitForTimeout(500);
      await page.evaluate(() => {
        const b = [...document.querySelectorAll(".confirm-dialog button")].find((x) => x.textContent.trim() === "关闭会话");
        if (b) b.click();
      });
      await page.waitForTimeout(900);
    };
    await closeViaMenu("prod-1");
    await closeViaMenu("staging-1");
    await connect(page, "本机");
    await connect(page, "prod-1");
    const t0 = await tabCount(page);

    // ── 右键菜单有「重命名标签」，点开行内编辑框 ──
    const base = await activeLabel(page); // 后连接的 prod-1 自动激活
    await rightClickTab(page, "prod-1");
    let menu = await menuText(page);
    ck.check("标签右键菜单有「重命名标签」", !!menu && menu.includes("重命名标签"), menu || "(无菜单)");
    await clickItem(page, "重命名标签");
    ck.check("菜单项打开行内编辑框", (await renameInput(page)) !== null, "");
    ck.check("编辑框初值 = 当前显示名", (await renameInput(page)) === base, `value=${await renameInput(page)}`);

    // ── 改名回车生效；标签文字、悬停 title 跟随 ──
    await page.fill(".tab-rename", "网关A");
    await page.keyboard.press("Enter");
    await page.waitForTimeout(300);
    ck.check("改名后标签文字更新", (await activeLabel(page)) === "网关A", `label=${await activeLabel(page)}`);
    const ttl = await page.evaluate(() => document.querySelector(".tab-active")?.getAttribute("title") ?? "");
    ck.check("悬停 title 用新名", ttl.startsWith("网关A"), ttl);

    // ── Esc 取消编辑不改名 ──
    await dblClickActiveTab(page);
    ck.check("双击标签再进编辑框", (await renameInput(page)) === "网关A", `value=${await renameInput(page)}`);
    await page.fill(".tab-rename", "不该生效的名字");
    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);
    ck.check("Esc 取消编辑保留原名", (await activeLabel(page)) === "网关A", `label=${await activeLabel(page)}`);

    // ── 清空名称回车 = 恢复主机名 ──
    await dblClickActiveTab(page);
    await page.fill(".tab-rename", "");
    await page.keyboard.press("Enter");
    await page.waitForTimeout(300);
    ck.check("空名回车恢复主机名", (await activeLabel(page)) === base, `label=${await activeLabel(page)}`);

    // ── 中键关闭走确认契约：取消不关，确认才关 ──
    await page.evaluate(() => {
      const tab = [...document.querySelectorAll(".tab")].find((x) => !x.classList.contains("tab-active"));
      if (!tab) throw new Error("no non-active tab");
      tab.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 1, buttons: 4 }));
    });
    await page.waitForTimeout(400);
    const dlg = await page.evaluate(() => !!document.querySelector(".confirm-dialog"));
    ck.check("中键关闭弹确认框", dlg, "");
    await page.evaluate(() => {
      const b = [...document.querySelectorAll(".confirm-dialog button")].find((x) => x.textContent.trim() === "取消");
      if (b) b.click();
    });
    await page.waitForTimeout(400);
    ck.check("取消路径标签数不变", (await tabCount(page)) === t0, `${t0} → ${await tabCount(page)}`);
    await page.evaluate(() => {
      const tab = [...document.querySelectorAll(".tab")].find((x) => !x.classList.contains("tab-active"));
      tab.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 1, buttons: 4 }));
    });
    await page.waitForTimeout(400);
    await page.evaluate(() => {
      const b = [...document.querySelectorAll(".confirm-dialog button")].find((x) => x.textContent.trim() === "关闭会话");
      if (b) b.click();
    });
    await page.waitForTimeout(900);
    ck.check("确认后标签数 -1", (await tabCount(page)) === t0 - 1, `${t0} → ${await tabCount(page)}`);

    // ── 终端右键「查找…」：写入标记 → 打开搜索框 → 作用窗格 ──
    await page.evaluate(() => {
      const live = [...window.__t_terms.values()].filter((t) => {
        const el = t.element;
        return !!el && el.isConnected && el.getBoundingClientRect().height > 0;
      });
      if (!live.length) throw new Error("no live term");
      const t = live[0];
      for (let i = 0; i < 40; i++) t.write(`\r\nUX14 filler line ${i}`);
      t.write("\r\nUX14-MARKER\r\n");
    });
    await page.waitForTimeout(400);
    ck.check("写入标记后缓冲含标记", await bufHas(page, "UX14-MARKER"), "");
    await page.evaluate(() => {
      const el = document.querySelector("#term");
      const r = el.getBoundingClientRect();
      el.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: r.left + 300, clientY: r.top + 150 }));
    });
    await page.waitForTimeout(350);
    menu = await menuText(page);
    ck.check("终端右键有「查找…」「清屏」", !!menu && menu.includes("查找") && menu.includes("清屏"), menu || "(无菜单)");
    await clickItem(page, "查找");
    const searchOpen = await page.evaluate(() => !!document.querySelector(".term-search input"));
    ck.check("「查找…」打开搜索框", searchOpen, "");
    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);

    // ── 终端右键「清屏」：缓冲里的标记被清掉 ──
    await page.evaluate(() => {
      const el = document.querySelector("#term");
      const r = el.getBoundingClientRect();
      el.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: r.left + 300, clientY: r.top + 150 }));
    });
    await page.waitForTimeout(350);
    await clickItem(page, "清屏");
    await page.waitForTimeout(400);
    ck.check("「清屏」后缓冲不再含标记", !(await bufHas(page, "UX14-MARKER")), "");
  },
};
