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
    ck.check("专注小工具栏：文件入口可见", await visible(page, '[data-testid="focus-files"]'), "");
    ck.check("专注小工具栏：连接现有主机入口可见", await visible(page, '[data-testid="focus-connect"]'), "");
    ck.check("tmux 快接在专注标签条可见", await visible(page, '[data-testid="tmux-quick"] .tmux-quick-btn'), "");
    // macOS Overlay 红绿灯是系统悬浮钮，专注态藏掉标题区后若窗口没真正全屏，
    // 三个圆钮会压住标签条。focus-windowed 必须给标签行留出与标题栏同宽的 84px
    // 安全区（demo 域手动补 native 类模拟；正常路径由 isFullscreen 跟踪收回 chrome）。
    const safe = await page.evaluate(() => {
      const html = document.documentElement;
      const shell = document.querySelector(".app-shell");
      if (!shell) return "";
      html.classList.add("native-chrome", "native-mac");
      shell.classList.add("focus-windowed");
      const row = document.querySelector(".tabbar-row");
      const pl = row ? getComputedStyle(row).paddingLeft : "";
      shell.classList.remove("focus-windowed");
      html.classList.remove("native-chrome", "native-mac");
      return pl;
    });
    ck.eq("专注但未全屏时标签条留出 macOS 红绿灯安全区", safe, "84px");
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

    // 文件面板入口（用户反馈：专注态最常用的两件事之一是文件）
    await page.click('[data-testid="focus-files"]');
    await page.waitForTimeout(400);
    ck.check("专注态文件面板可打开", await visible(page, ".task-panel"), "");
    ck.check("任务面板标题为「文件」", await page.evaluate(() =>
      document.querySelector('[data-testid="tp-title"]')?.textContent === "文件"), "");
    await page.click('[data-testid="tp-close"]');
    await page.waitForTimeout(200);

    // 连接现有配置主机（不是「添加主机」表单）：菜单列出主机，选中即新建会话
    const tabs0 = await page.evaluate(() => document.querySelectorAll(".tab").length);
    await page.click('[data-testid="focus-connect"]');
    ck.check("专注态连接菜单可打开", await visible(page, '[data-testid="focus-connect-menu"]'), "");
    ck.check("菜单列出已保存主机 prod-1", await visible(page, '[data-testid="focus-host-h-prod1"]'), "");
    // Esc 与外点都是菜单出口；关闭后菜单按钮仍在，可再次打开
    await page.keyboard.press("Escape");
    await page.waitForTimeout(250);
    ck.check("连接菜单 Esc 可关闭", !(await visible(page, '[data-testid="focus-connect-menu"]')), "");
    await page.click('[data-testid="focus-connect"]');
    await page.waitForTimeout(200);
    await page.mouse.click(20, 320);
    await page.waitForTimeout(250);
    ck.check("连接菜单外点可关闭", !(await visible(page, '[data-testid="focus-connect-menu"]')), "");
    await page.click('[data-testid="focus-connect"]');
    await page.waitForTimeout(200);
    await page.click('[data-testid="focus-host-h-prod1"]');
    const opened = await page.waitForFunction((n) => document.querySelectorAll(".tab").length > n, tabs0, { timeout: 6000 })
      .then(() => true).catch(() => false);
    ck.check("选主机后新建连接落成新标签", opened,
      await page.evaluate(() => `${document.querySelectorAll(".tab").length} 个标签`));

    // 退出专注：工具栏与工具栏内的 tmux 快接恢复
    await page.click('[data-testid="focus-toggle"]');
    await page.waitForTimeout(500);
    ck.check("退出专注后会话工具栏恢复", await visible(page, ".session-toolbar"), "");
    ck.check("退出后 tmux 快接回到工具栏", await visible(page, ".session-toolbar .tmux-quick-btn"), "");
  },
};
