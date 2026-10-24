// 01 应用外壳：标题区 / 主机栏 / 标签栏 / 状态条，以及**旧三栏布局确已不存在**。
//
// 本 spec 承接 R45 验收项「无旧常驻命令框/三栏断言」：把「旧三栏已移除」写成**正向断言**
// （`.layout` 不存在、左栏不再固定 220px），并只断言**当前**布局的数值（主机栏 224px、
// 拖动夹取 200–300）。旧脚本里的 `expect 220 / flex / 280` 属历史方案，不再作为依据。

module.exports = {
  title: "应用外壳与主机栏",
  async run({ page, ck }) {
    // ── 结构 ──
    const present = await page.evaluate((sels) => {
      const o = {};
      for (const s of sels) o[s] = !!document.querySelector(s);
      return o;
    }, [".app-shell", ".titlebar", ".hostbar", ".tabbar-row", ".statusbar", ".layout"]);

    for (const s of [".app-shell", ".titlebar", ".hostbar", ".tabbar-row", ".statusbar"]) {
      ck.check(`存在 ${s}`, present[s]);
    }
    ck.check("旧三栏容器 .layout 已不存在（R12 移除）", !present[".layout"]);

    // ── 当前布局数值 ──
    const w = await page.evaluate(() => Math.round(document.querySelector(".hostbar").getBoundingClientRect().width));
    ck.check("主机栏默认宽 224px（R12 规格）", Math.abs(w - 224) <= 1, `实得 ${w}px`);

    const bar = await page.evaluate(() => {
      const t = document.querySelector(".titlebar").getBoundingClientRect().height;
      const s = document.querySelector(".statusbar").getBoundingClientRect().height;
      return { t: Math.round(t), s: Math.round(s) };
    });
    ck.check("标题区 44px", Math.abs(bar.t - 44) <= 1, `实得 ${bar.t}px`);
    ck.check("状态条 24px", Math.abs(bar.s - 24) <= 1, `实得 ${bar.s}px`);

    // ── 主机列表 ──
    const hosts = await page.$$eval(".host-card .host-name", (els) => els.map((e) => e.textContent.trim()));
    ck.check("演示主机全部列出（7 台）", hosts.length === 7, `实得 ${hosts.length}：${hosts.join(" / ")}`);
    ck.check("含「本机」local", hosts.includes("本机"));
    ck.check("含 prod-1", hosts.includes("prod-1"));

    // ── 搜索过滤 ──
    // 本地终端一等公民轮：「本机」置顶节不过滤链——搜索 prod 时仍置顶在场，其余只剩 prod-*
    await page.fill(".hb-search input", "prod");
    await page.waitForTimeout(250);
    const filtered = await page.$$eval(".host-card .host-name", (els) => els.map((e) => e.textContent.trim()));
    ck.check("搜索 prod：本机置顶常驻 + 只剩 prod-* 两台", filtered.length === 3 && filtered[0] === "本机" && filtered.slice(1).every((n) => n.startsWith("prod-")), `实得 ${filtered.join(" / ")}`);
    await page.fill(".hb-search input", "");
    await page.waitForTimeout(250);
    const restored = await page.$$eval(".host-card", (e) => e.length);
    ck.check("清空搜索后恢复 7 台", restored === 7, `实得 ${restored}`);

    // ── 收起 / 展开（⌘B 钮）──
    await page.click('button[aria-label="收起主机栏"]');
    await page.waitForTimeout(250);
    let collapsed = await page.evaluate(() => ({
      hostbar: !!document.querySelector(".hostbar"),
      expand: !!document.querySelector(".hb-expand"),
    }));
    ck.check("收起后主机栏消失", !collapsed.hostbar);
    ck.check("收起后出现展开钮 .hb-expand", collapsed.expand);
    if (collapsed.expand) {
      await page.click(".hb-expand");
      await page.waitForTimeout(250);
      ck.check("展开钮可恢复主机栏", await page.evaluate(() => !!document.querySelector(".hostbar")));
    }

    // ── 拖动夹取 200–300 ──
    const grip = await page.$(".hb-grip");
    ck.check("存在拖宽把手 .hb-grip", !!grip);
    if (grip) {
      const box = await grip.boundingBox();
      // 猛拖到极左：应夹在下限 200
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.down();
      await page.mouse.move(40, box.y + box.height / 2, { steps: 8 });
      await page.mouse.up();
      await page.waitForTimeout(200);
      const lo = await page.evaluate(() => Math.round(document.querySelector(".hostbar").getBoundingClientRect().width));
      ck.between("向左猛拖夹在下限 200px", lo, 200, 200 + 1);

      // 猛拖到极右：应夹在上限 300
      const box2 = await (await page.$(".hb-grip")).boundingBox();
      await page.mouse.move(box2.x + box2.width / 2, box2.y + box2.height / 2);
      await page.mouse.down();
      await page.mouse.move(1100, box2.y + box2.height / 2, { steps: 8 });
      await page.mouse.up();
      await page.waitForTimeout(200);
      const hi = await page.evaluate(() => Math.round(document.querySelector(".hostbar").getBoundingClientRect().width));
      ck.between("向右猛拖夹在上限 300px", hi, 300 - 1, 300);
    }

    // ── 设置入口 ──
    ck.check("主机栏底部有设置入口 .hb-settings", await page.evaluate(() => !!document.querySelector(".hb-settings")));
  },
};
