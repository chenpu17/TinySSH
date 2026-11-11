// 82 整体视觉精修：交互层次、当前分类与 Agent 无会话空状态。
// 不做像素截图基线（字体/系统渲染易抖动），只锁定真实计算样式与信息结构。
module.exports = {
  title: "视觉层次与 Agent 空状态",
  async run({ page, ck }) {
    const card = page.locator('.host-card:has(.host-name:text-is("prod-1"))');
    const shadow = () => card.evaluate((el) => getComputedStyle(el).boxShadow);
    ck.check("主机卡静止时保持无边框的信息列表", await shadow() === "none", await shadow());
    await card.hover();
    await page.waitForTimeout(180);
    ck.check("主机悬停出现克制的内描边", await shadow() !== "none", await shadow());
    await page.mouse.move(700, 20);
    await page.waitForTimeout(180);
    ck.check("移出主机卡后恢复静止层次", await shadow() === "none", await shadow());

    await page.click('[data-testid="rail-agent"]');
    const empty = page.locator('[data-testid="agent-no-session"]');
    ck.check("无会话时显示结构化 Agent 空状态", await empty.isVisible());
    ck.check("空状态包含品牌标记、明确标题与原有连接引导",
      await empty.locator(".ag-empty-mark svg").isVisible() &&
      (await empty.locator(".ag-empty-title").textContent()) === "连接主机，开始 Agent 协作" &&
      (await empty.locator(".ag-empty-desc").textContent()).includes("连接主机后开始与 Agent 对话。"));
    ck.check("空状态展示审批、接管、留痕三项边界",
      await empty.locator(".ag-empty-points span").count() === 3);
    ck.check("无会话空状态不出现可输入的任务框",
      await page.locator('[data-testid="agent-input"]').count() === 0);
    const bounds = await empty.evaluate((el) => {
      const outer = el.getBoundingClientRect();
      const inner = el.querySelector(".ag-empty-card").getBoundingClientRect();
      return { outer: { top: outer.top, bottom: outer.bottom }, inner: { top: inner.top, bottom: inner.bottom } };
    });
    ck.check("空状态完整落在 Agent 面板可视区内",
      bounds.inner.top >= bounds.outer.top && bounds.inner.bottom <= bounds.outer.bottom, JSON.stringify(bounds));
    await page.click('[data-testid="rail-agent"]');

    await page.click('[data-testid="rail-settings"]');
    const activeStyle = () => page.locator(".settings-nav button.on").evaluate((el) => ({
      border: getComputedStyle(el).borderTopColor,
      shadow: getComputedStyle(el).boxShadow,
    }));
    const appearance = await activeStyle();
    ck.check("设置当前分类有 accent 描边与内侧标识",
      appearance.border !== "rgba(0, 0, 0, 0)" && appearance.shadow !== "none", JSON.stringify(appearance));
    await page.click('[data-testid="settings-cat-terminal"]');
    await page.waitForTimeout(180);
    ck.check("切换分类后视觉选中态跟随",
      await page.locator(".settings-nav button.on").getAttribute("data-testid") === "settings-cat-terminal" &&
      (await activeStyle()).shadow !== "none");
  },
};
