// 69 专注模式可用性：会话工具栏隐藏后，tmux 快接（管理）入口必须仍在标签条；
// 标签列表/新建连接/退出专注文字钮在专注态让位，退出用右上角专注图标/F11。

const visible = (page, sel) =>
  page.evaluate((s) => {
    const el = document.querySelector(s);
    if (!el) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && getComputedStyle(el).display !== "none";
  }, sel);

module.exports = {
  title: "专注模式：保留 tmux 管理入口，收起标签列表/新建连接/退出专注文字钮",
  async run({ page, ck }) {
    await page.waitForTimeout(1200);
    // 先固定到有 tmux fixture 的 prod-1（欢迎页无 current 时不渲染快接）
    await page.evaluate(() => {
      const tab = [...document.querySelectorAll(".tab")]
        .find((t) => (t.textContent ?? "").includes("prod-1"));
      tab?.click();
    });
    await page.waitForTimeout(700);
    // 进入专注（demo 只切 chrome，不切系统全屏）
    await page.click('[data-testid="focus-toggle"]');
    await page.waitForTimeout(500);
    ck.check("进入专注模式（app-shell.focus-mode）",
      await page.evaluate(() => document.querySelector(".app-shell")?.classList.contains("focus-mode") === true), "");
    ck.check("会话工具栏隐藏", !(await visible(page, ".session-toolbar")), "");
    ck.check("tmux 快接在专注标签条可见", await visible(page, '[data-testid="tmux-quick"] .tmux-quick-btn'), "");
    ck.check("标签列表/新建连接等管理入口在专注态隐藏",
      await page.evaluate(() => {
        const els = [...document.querySelectorAll(".tabbar-admin")];
        return els.length > 0 && els.every((e) => getComputedStyle(e).display === "none");
      }), "");
    ck.check("不再渲染「退出专注」文字钮",
      await page.evaluate(() => ![...document.querySelectorAll(".tabbar-row button")]
        .some((b) => (b.textContent ?? "").trim() === "退出专注")), "");

    // 快接菜单可打开且列出远端会话（tmux 管理功能真正可用，不只是图标在）
    await page.click('[data-testid="tmux-quick"] .tmux-quick-btn');
    ck.check("专注态 tmux 菜单可打开",
      await visible(page, '[data-testid="tmux-quick-menu"]'), "");
    ck.check("菜单列出 work 会话",
      await visible(page, '[data-testid="tmux-quick-item-work"]'), "");
    await page.click('[data-testid="tmux-quick"] .tmux-quick-btn');
    await page.waitForTimeout(200);

    // 退出专注：工具栏与工具栏内的 tmux 快接恢复
    await page.click('[data-testid="focus-toggle"]');
    await page.waitForTimeout(500);
    ck.check("退出专注后会话工具栏恢复", await visible(page, ".session-toolbar"), "");
    ck.check("退出后 tmux 快接回到工具栏", await visible(page, ".session-toolbar .tmux-quick-btn"), "");
  },
};
