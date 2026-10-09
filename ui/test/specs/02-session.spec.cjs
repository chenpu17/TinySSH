// 02 会话与终端：连接、标签、会话工具栏、终端渲染、控制权徽标、状态条。

module.exports = {
  title: "会话建立与终端",
  async run({ page, ck }) {
    const card = await page.$('.host-card:has(.host-name:text-is("本机"))');
    ck.check("主机卡存在（本机）", !!card);
    await card.hover();
    await page.waitForTimeout(200);
    await (await card.$('button[title^="连接"]')).click();
    await page.waitForTimeout(1500);

    // 会话工具栏
    ck.check("出现会话工具栏 .session-toolbar", await page.evaluate(() => !!document.querySelector(".session-toolbar")));
    const tools = await page.$$eval(".session-toolbar button", (bs) =>
      bs.map((b) => (b.getAttribute("title") || b.textContent || "").trim()),
    );
    ck.check("工具栏含「交给 Agent…」（首次委托入口）", tools.some((t) => t.includes("交给 Agent")));
    ck.check("工具栏含搜索", tools.some((t) => t.includes("搜索终端内容")));
    ck.check("工具栏含分屏", tools.some((t) => t.includes("分屏")));
    ck.check("工具栏含协作入口", tools.some((t) => t.includes("协作")));
    ck.check("工具栏含文件入口", tools.some((t) => t.includes("文件")));
    ck.check("工具栏含工具菜单", tools.some((t) => t === "工具"));

    // 标签栏：新会话出现标签
    const tabs = await page.$$eval(".tabbar-row button", (bs) =>
      bs.map((b) => (b.getAttribute("title") || b.textContent || "").trim()),
    );
    ck.check("标签栏有「关闭会话」标签（新会话已建）", tabs.some((t) => t.includes("关闭会话")));
    ck.check("标签栏有「所有标签」菜单", tabs.some((t) => t.includes("所有标签")));

    // 终端：必须**可见**（非 0×0 幽灵）。vis-r45 实测多会话时 DOM 里第一个 .xterm
    // 属于非活动 .term-session，尺寸 0×0——只断言存在会被它满足，故按尺寸筛。
    const term = await page.evaluate(() => {
      const els = [...document.querySelectorAll(".xterm")];
      const boxes = els.map((e) => { const r = e.getBoundingClientRect(); return [Math.round(r.width), Math.round(r.height)]; });
      const vis = boxes.filter(([w, h]) => w > 0 && h > 0);
      return { total: els.length, vis, biggest: vis.sort((a, b) => b[0] * b[1] - a[0] * a[1])[0] || null };
    });
    ck.check("终端已渲染且可见（非 0×0 幽灵）",
      term.total >= 1 && term.vis.length >= 1 && term.biggest[0] > 400 && term.biggest[1] > 200,
      `.xterm 共 ${term.total} 个，非零尺寸 ${term.vis.length} 个，最大 ${JSON.stringify(term.biggest)}`);

    // 控制权徽标
    const badge = await page.evaluate(() => {
      const e = document.querySelector(".ctl-badge");
      return e ? e.textContent.trim() : null;
    });
    ck.check("控制权徽标显示「我控制中」", badge === "我控制中", `实得 ${badge}`);

    // 状态条
    const sb = await page.evaluate(() => document.querySelector(".statusbar").innerText.replace(/\s+/g, " ").trim());
    ck.check("状态条显示本地会话与编码", sb.includes("本地") && sb.includes("UTF-8"), `实得「${sb}」`);
    ck.check("状态条有转发/传输计数入口", sb.includes("转发") && sb.includes("传输"), `实得「${sb}」`);

    // 工具菜单四项
    await page.click('.session-toolbar button:has-text("工具")');
    await page.waitForTimeout(350);
    const menu = await page.evaluate(() =>
      [...document.querySelectorAll("button")].map((b) => b.textContent.trim()).filter((t) => ["连接详情…", "端口转发", "活动记录", "关闭会话…"].includes(t)),
    );
    ck.check("工具菜单含四项（连接详情/端口转发/活动记录/关闭会话）", menu.length === 4, `实得 ${menu.join(" / ")}`);
    await page.keyboard.press("Escape");
    await page.waitForTimeout(200);
  },
};
