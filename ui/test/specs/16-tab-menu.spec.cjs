// 16 标签右键菜单（十一轮 §6.3 修订）：状态显隐项（分屏/退出分屏/复制连接/详情/关闭）、
// Esc 与外点/右键关闭、预武装模式退役（对象先存在、操作跟上来）。
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

const paneCount = (page) =>
  page.evaluate(() => document.querySelectorAll(".pane-left, .pane-right, .pane-top, .pane-bottom").length);

const tabCount = (page) =>
  page.evaluate(() => document.querySelectorAll(".tab").length);

// 右键活动标签（不猜名字——demo 预置会话+后连自动激活）
const rightClickActiveTab = async (page) => {
  await page.evaluate(() => {
    const tab = document.querySelector(".tab-active");
    if (!tab) throw new Error("no active tab");
    tab.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 380, clientY: 130 }));
  });
  await page.waitForTimeout(350);
};

// 走右键菜单+确认契约关闭一个会话（用于清 demo 预置的 prod-1/staging-1；
// Disconnected 会话无确认框直接关，故确认按钮存在才点）
const closeViaMenu = async (page, namePart) => {
  await rightClickTab(page, namePart);
  await clickItem(page, "关闭会话");
  await page.waitForTimeout(500);
  await page.evaluate(() => {
    const b = [...document.querySelectorAll(".confirm-dialog button")].find((x) => x.textContent.trim() === "关闭会话");
    if (b) b.click();
  });
  await page.waitForTimeout(900);
};

module.exports = {
  title: "标签右键菜单与会话操作",
  async run({ page, ck }) {
    // ── 十三轮：唯一会话的分屏路径——先清掉 demo 预置的 prod-1/staging-1 ──
    await closeViaMenu(page, "prod-1");
    await closeViaMenu(page, "staging-1");
    await connect(page, "本机");
    ck.check("清预置后单会话", (await tabCount(page)) === 1, `tabs=${await tabCount(page)}`);
    await rightClickActiveTab(page);
    let menu = await menuText(page);
    ck.check("单会话活动标签有「复制标签页到右侧」", !!menu && menu.includes("复制标签页到右侧"), menu || "(无菜单)");
    ck.check("单会话无「选择右侧会话」（无可选项）", !!menu && !menu.includes("选择右侧会话"), "");
    await clickItem(page, "复制标签页到右侧");
    await page.waitForTimeout(1800);
    ck.check("复制到右侧建立双窗格", (await paneCount(page)) === 2, `panes=${await paneCount(page)}`);
    ck.check("分屏后标签数 +1", (await tabCount(page)) === 2, `tabs=${await tabCount(page)}`);
    // 收拾：退出分屏、关掉复制品，恢复干净状态给后续用例
    await rightClickActiveTab(page);
    await clickItem(page, "退出分屏");
    await page.waitForTimeout(400);
    await closeViaMenu(page, "本机");
    await closeViaMenu(page, "本机");

    await connect(page, "本机");
    await connect(page, "prod-1");
    const t0 = await tabCount(page);

    // ── 右键非当前标签：菜单出现，含分屏项，不含连接中无用的项 ──
    // （预置会话已清，后连的 prod-1 自动激活——「本机」恒为非当前标签）
    await rightClickTab(page, "本机");
    menu = await menuText(page);
    const menuOpen = await page.evaluate(() => !!document.querySelector(".ctx-menu"));
    ck.check("右键标签弹出菜单", menuOpen, menu || "(无菜单)");
    ck.check("非当前标签有「与当前会话分屏」", !!menu && menu.includes("与当前会话分屏"), "");
    ck.check("已连接会话不出现「重连会话」", !!menu && !menu.includes("重连会话"), "");
    ck.check("有「复制标签页」「连接详情」「关闭会话」", !!menu && menu.includes("复制标签页") && menu.includes("连接详情") && menu.includes("关闭会话"), "");

    // ── Esc 关闭菜单 ──
    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);
    ck.check("Esc 关闭右键菜单", (await menuText(page)) === null, "");

    // ── 右键遮罩处（菜单外）关闭 ──
    await rightClickTab(page, "本机");
    await page.mouse.click(700, 500);
    await page.waitForTimeout(300);
    ck.check("点击菜单外关闭", (await menuText(page)) === null, "");

    // ── 分屏动作：双窗格建立 ──
    await rightClickTab(page, "本机");
    await clickItem(page, "与当前会话分屏");
    await page.waitForTimeout(400);
    ck.check("分屏动作建立双窗格", (await paneCount(page)) === 2, `panes=${await paneCount(page)}`);

    // ── 分屏中的标签：菜单换「退出分屏」 ──
    await rightClickTab(page, "prod-1");
    menu = await menuText(page);
    ck.check("分屏中的标签有「退出分屏」", !!menu && menu.includes("退出分屏"), "");
    ck.check("分屏中的标签不再有「与当前会话分屏」", !!menu && !menu.includes("与当前会话分屏"), "");
    await clickItem(page, "退出分屏");
    await page.waitForTimeout(400);
    ck.check("退出分屏后窗格清空", (await paneCount(page)) === 0, `panes=${await paneCount(page)}`);

    // ── 十二轮：活动标签也有分屏入口（Xshell 惯例）——打开右侧会话选择菜单 ──
    // 注：demo 预置 prod-1/staging-1，后连接的会话自动激活——右键 .tab-active 不猜名字
    await page.evaluate(() => {
      const tab = document.querySelector(".tab-active");
      if (!tab) throw new Error("no active tab");
      tab.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 380, clientY: 130 }));
    });
    await page.waitForTimeout(350);
    menu = await menuText(page);
    ck.check("活动标签有「分屏（选择右侧会话）」", !!menu && menu.includes("选择右侧会话"), menu || "(无菜单)");
    await clickItem(page, "选择右侧会话");
    await page.waitForTimeout(400);
    const chooser = await page.evaluate(() => !!document.querySelector(".split-menu"));
    ck.check("打开右侧会话选择菜单", chooser, "");
    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);

    // ── 复制标签页：同主机新会话，标签数 +1 ──
    await rightClickTab(page, "本机");
    await clickItem(page, "复制标签页");
    await page.waitForTimeout(1800);
    ck.check("复制标签页新建一条会话", (await tabCount(page)) === t0 + 1, `${t0} → ${await tabCount(page)}`);

    // ── 关闭会话走现有确认契约（取消不关闭）──
    await rightClickTab(page, "本机");
    await clickItem(page, "关闭会话");
    await page.waitForTimeout(400);
    const dlg = await page.evaluate(() => !!document.querySelector(".confirm-dialog"));
    ck.check("关闭会话弹确认框", dlg, "");
    await page.evaluate(() => [...document.querySelectorAll(".confirm-dialog button")].find((b) => b.textContent.trim() === "取消").click());
    await page.waitForTimeout(400);
    ck.check("取消后标签数不变", (await tabCount(page)) === t0 + 1, "");
  },
};
