// 11 标签与多会话：标签列表菜单、重连入口、分屏、关闭会话确认（§4.1 / §4.3 / §10.1）。

const connect = async (page, name) => {
  const c = await page.$(`.host-card:has(.host-name:text-is("${name}"))`);
  await c.hover();
  await page.waitForTimeout(250);
  await (await c.$('button[title^="连接"]')).click();
  await page.waitForTimeout(1400);
};

const clickTabbar = async (page, titlePart) => {
  await page.evaluate((t) => {
    const b = [...document.querySelectorAll(".tabbar-row button")].find((x) => (x.getAttribute("title") || "").includes(t));
    if (b) b.click();
  }, titlePart);
  await page.waitForTimeout(500);
};

module.exports = {
  title: "标签、重连、分屏与关闭会话",
  async run({ page, ck }) {
    await connect(page, "本机");
    await connect(page, "prod-1");
    const tabs = await page.$$eval(".tabbar-row button", (bs) => bs.map((b) => b.getAttribute("title") || b.textContent.trim()));
    ck.check("标签栏含「所有标签」菜单", tabs.some((t) => t.includes("所有标签")), "");
    ck.check("标签栏含「新建连接」", tabs.some((t) => t.includes("新建连接")), "");
    ck.check("两个会话各有关闭钮", tabs.filter((t) => t.includes("关闭会话")).length >= 2, `实得 ${tabs.filter((t) => t.includes("关闭会话")).length}`);

    // ── 标签列表菜单：含全部会话与死会话重连 ──
    await clickTabbar(page, "所有标签");
    const menu = await page.evaluate(() => [...document.querySelectorAll("[role=menu] *")].map((e) => e.textContent.trim()).join(" | "));
    ck.check("标签列表列出已连接会话", menu.includes("本机") && menu.includes("prod-1"), "");
    ck.check("标签列表标出「已断开」会话", menu.includes("已断开"), "");
    ck.check("死会话有「重连」入口", menu.includes("重连"), "");
    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);

    // ── 分屏菜单 ──
    await page.evaluate(() => {
      const b = [...document.querySelectorAll(".session-toolbar button")].find((x) => (x.getAttribute("title") || "").includes("分屏"));
      if (b) b.click();
    });
    await page.waitForTimeout(600);
    const split = await page.evaluate(() => [...document.querySelectorAll("[role=menu] *")].map((e) => e.textContent.trim()).join(" | "));
    ck.check("分屏菜单有「在右侧显示已有会话」", split.includes("在右侧显示已有会话"), "");
    ck.check("分屏菜单有「在右侧新建会话」", split.includes("在右侧新建会话"), "");
    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);

    // ── 关闭会话确认（含影响摘要）──
    await page.evaluate(() => [...document.querySelectorAll(".session-toolbar button")].find((b) => b.textContent.trim() === "工具").click());
    await page.waitForTimeout(400);
    await page.evaluate(() => [...document.querySelectorAll("button")].find((b) => b.textContent.trim() === "关闭会话…").click());
    await page.waitForTimeout(600);
    const dlg = await page.evaluate(() => {
      const d = document.querySelector(".confirm-dialog");
      return d ? d.innerText.replace(/\n+/g, " | ") : null;
    });
    ck.check("关闭会话弹确认框", !!dlg && dlg.includes("关闭与"), dlg || "(无)");
    ck.check("确认框说明现场不可恢复", !!dlg && dlg.includes("终端现场不可恢复"), "");
    ck.check("确认框列出受影响转发", !!dlg && dlg.includes("将受影响的转发"), "");
    ck.check("确认框列出运行中任务/传输", !!dlg && dlg.includes("正在运行的任务/传输"), "");

    // 取消 → 会话仍在
    await page.evaluate(() => [...document.querySelectorAll(".confirm-dialog button")].find((b) => b.textContent.trim() === "取消").click());
    await page.waitForTimeout(500);
    // 按**可见尺寸**判，不用存在性（vis-r45：多会话下 0×0 幽灵 .xterm 会满足存在性）
    const still = await page.evaluate(() => {
      const boxes = [...document.querySelectorAll(".xterm")].map((e) => { const r = e.getBoundingClientRect(); return [Math.round(r.width), Math.round(r.height)]; });
      return boxes.filter(([w, h]) => w > 0 && h > 0).length;
    });
    ck.check("取消后会话仍在（终端可见，非 0×0）", still >= 1, `可见 .xterm ${still} 个`);

    // 确认关闭 → 当前会话关闭
    await page.evaluate(() => [...document.querySelectorAll(".session-toolbar button")].find((b) => b.textContent.trim() === "工具").click());
    await page.waitForTimeout(400);
    await page.evaluate(() => [...document.querySelectorAll("button")].find((b) => b.textContent.trim() === "关闭会话…").click());
    await page.waitForTimeout(600);
    await page.evaluate(() => [...document.querySelectorAll(".confirm-dialog button")].find((b) => b.textContent.trim() === "关闭会话").click());
    await page.waitForTimeout(900);
    const tabsAfter = await page.$$eval(".tabbar-row button", (bs) => bs.map((b) => b.getAttribute("title") || b.textContent.trim()));
    ck.check("关闭后标签数减少", tabsAfter.filter((t) => t.includes("关闭会话")).length < tabs.filter((t) => t.includes("关闭会话")).length, `${tabs.filter((t) => t.includes("关闭会话")).length} → ${tabsAfter.filter((t) => t.includes("关闭会话")).length}`);
  },
};
