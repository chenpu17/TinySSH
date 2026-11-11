// 83 对话框与表单一致性：说明/操作分层，操作区统一右对齐。
// 不断言像素截图基线，只锁定计算样式、按钮顺序与真实布局边界。
module.exports = {
  title: "对话框与表单一致性",
  async run({ page, ck }) {
    const actionStyle = (locator) => locator.evaluate((el) => ({
      justify: getComputedStyle(el).justifyContent,
      borderWidth: getComputedStyle(el).borderTopWidth,
      borderStyle: getComputedStyle(el).borderTopStyle,
    }));
    const rightEdge = async (footer, lastButton) => {
      const [footerBox, buttonBox] = await Promise.all([footer.boundingBox(), lastButton.boundingBox()]);
      return !!footerBox && !!buttonBox && Math.abs((footerBox.x + footerBox.width) - (buttonBox.x + buttonBox.width)) <= 1;
    };

    await page.locator(".welcome-actions button", { hasText: "添加主机" }).click();
    const addDialog = page.locator('[data-testid="add-host-dialog"]');
    const addFooter = page.locator('[data-testid="add-host-actions"]');
    await addDialog.waitFor({ state: "visible" });
    const addStyle = await actionStyle(addFooter);
    ck.check("新建连接操作区右对齐并与字段区分层",
      addStyle.justify === "flex-end" && addStyle.borderWidth === "1px" && addStyle.borderStyle === "solid",
      JSON.stringify(addStyle));
    ck.check("新建连接保留主按钮、仅保存、取消的既有顺序",
      JSON.stringify(await addFooter.locator("button").allTextContents()) === JSON.stringify(["保存并连接", "仅保存", "取消"]));
    ck.check("安全说明位于操作按钮之前，不再挤在按钮尾端",
      await addFooter.locator(".form-note").evaluate((el) =>
        el.compareDocumentPosition(el.parentElement.querySelector("button")) & Node.DOCUMENT_POSITION_FOLLOWING));
    ck.check("新建连接最后一个操作按钮贴合操作区右缘",
      await rightEdge(addFooter, addFooter.locator("button").last()));
    const addLayout = await addFooter.evaluate((el) => {
      const note = el.querySelector(".form-note").getBoundingClientRect();
      const first = el.querySelector("button").getBoundingClientRect();
      const overlap = note.left < first.right && note.right > first.left && note.top < first.bottom && note.bottom > first.top;
      return { overlap, dialogOverflow: el.closest(".add-host-dlg").scrollWidth - el.closest(".add-host-dlg").clientWidth };
    });
    ck.check("安全说明与按钮不重叠，对话框无横向溢出", !addLayout.overlap && addLayout.dialogOverflow <= 1, JSON.stringify(addLayout));
    await page.keyboard.press("Escape");

    await page.locator(".welcome-actions button", { hasText: "快速连接" }).click();
    const quickDialog = page.locator('[data-testid="quick-connect-dialog"]');
    const quickFooter = page.locator('[data-testid="quick-connect-actions"]');
    await quickDialog.waitFor({ state: "visible" });
    const quickStyle = await actionStyle(quickFooter);
    ck.check("快速连接与新建连接共用右对齐操作区",
      quickStyle.justify === "flex-end" && quickStyle.borderWidth === "1px" && quickStyle.borderStyle === "solid",
      JSON.stringify(quickStyle));
    ck.check("快速连接保留连接、取消的既有顺序与入口",
      JSON.stringify(await quickFooter.locator("button").allTextContents()) === JSON.stringify(["连接", "取消"]) &&
      await quickFooter.locator('[data-testid="quick-connect-go"]').isVisible() &&
      await quickFooter.locator('[data-testid="quick-connect-cancel"]').isVisible());
    ck.check("快速连接取消钮贴合操作区右缘", await rightEdge(quickFooter, quickFooter.locator("button").last()));

    await page.setViewportSize({ width: 520, height: 720 });
    await page.evaluate(() => document.documentElement.style.setProperty("--ui-font-scale", "1.25"));
    await page.waitForTimeout(180);
    const compact = await quickFooter.evaluate((el) => {
      const dialog = el.closest(".add-host-dlg");
      const outer = dialog.getBoundingClientRect();
      const buttons = [...el.querySelectorAll("button")].map((button) => {
        const r = button.getBoundingClientRect();
        return { left: r.left, right: r.right, top: r.top, bottom: r.bottom };
      });
      return {
        overflow: dialog.scrollWidth - dialog.clientWidth,
        buttonsInside: buttons.every((r) => r.left >= outer.left && r.right <= outer.right && r.top >= outer.top && r.bottom <= outer.bottom),
      };
    });
    ck.check("窄窗与 125% 字号下操作按钮仍完整可达且无横向溢出",
      compact.overflow <= 1 && compact.buttonsInside, JSON.stringify(compact));
  },
};
