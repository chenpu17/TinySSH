// 78 主机身份稳定性（用户走查 2026-11-10 P1/P2）：
// 1) hover 操作组收成「更多 + 连接」两钮——224px 侧栏下已连接主机的名称不再被
//    徽章+按钮挤成 0px（100% 与 125% 界面字号都要完整可读）；
// 2) 文件列表的大小/时间列宽随界面字号缩放，125% 下「70.0 MB」不再折行。
const connect = async (page, name) => {
  const card = await page.$(`.host-card:has(.host-name:text-is("${name}"))`);
  if (!card) throw new Error("host card not found: " + name);
  await card.hover();
  await page.waitForTimeout(250);
  await (await card.$('button[title^="连接"]')).click();
  await page.waitForTimeout(1600);
};

const hoverProbe = (page, name) => page.evaluate((n) => {
  const card = [...document.querySelectorAll(".host-card")]
    .find((c) => c.querySelector(".host-name")?.textContent.trim() === n);
  if (!card) return null;
  const nameEl = card.querySelector(".host-name");
  const side = card.querySelector(".host-card-side");
  const nr = nameEl.getBoundingClientRect();
  const sr = side.getBoundingClientRect();
  return {
    nameText: nameEl.textContent.trim(),
    nameWidth: Math.round(nr.width),
    nameScroll: nameEl.scrollWidth,
    sideLeft: Math.round(sr.left),
    nameRight: Math.round(nr.right),
    sideButtons: [...side.querySelectorAll("button")].map((b) => b.getAttribute("title") ?? b.textContent.trim()),
    directOps: !!side.querySelector(".fav-btn, .host-del, [title^=\"编辑主机\"]"),
    more: !!side.querySelector(".host-more-btn"),
    sideOpacity: getComputedStyle(side).opacity,
  };
}, name);

module.exports = {
  title: "主机身份稳定：hover 名称可读（100%/125%）+ 文件大小列随字号缩放不折行",
  async run({ page, ck }) {
    await page.waitForTimeout(1200);
    // 已连接主机才有会话徽章——这正是走查复现「名称消失」的场景
    await connect(page, "prod-1");

    const h100 = await hoverProbe(page, "prod-1");
    ck.check("100%：hover 时操作组只留「更多 + 连接」",
      !!h100 && h100.sideOpacity === "1" && h100.more && !h100.directOps
        && h100.sideButtons.length === 2, JSON.stringify(h100));
    ck.check("100%：hover 时主机名完整可读（不再缩成 0px）",
      !!h100 && h100.nameWidth >= 40 && h100.nameScroll <= h100.nameWidth + 1
        && h100.nameRight <= h100.sideLeft,
      JSON.stringify(h100));

    // 「更多」菜单与右键同源：收藏/编辑/删除都在里面
    await page.evaluate(() => {
      const card = [...document.querySelectorAll(".host-card")]
        .find((c) => c.querySelector(".host-name")?.textContent.trim() === "prod-1");
      card.querySelector(".host-more-btn").click();
    });
    await page.waitForTimeout(300);
    const menuText = await page.evaluate(() => document.querySelector(".ctx-menu")?.innerText.replace(/\n+/g, " | ") ?? "");
    ck.check("「更多」菜单含收藏/编辑/删除",
      menuText.includes("收藏") && menuText.includes("编辑主机") && menuText.includes("删除主机"), menuText || "(无)");
    await page.evaluate(() => document.querySelector(".pop-mask")?.click());
    await page.waitForTimeout(250);

    // ── 125% 界面字号：同一场景名称仍完整 ──
    await page.click(".hb-settings");
    await page.waitForTimeout(700);
    await page.selectOption('[data-testid="ui-font-scale-select"]', "1.25");
    await page.waitForTimeout(400);
    await page.evaluate(() => document.querySelector('[data-testid="settings-close"]')?.click());
    await page.waitForTimeout(300);
    // 设置面板关掉后指针已离开主机卡——重新悬停再测（reserve 只在 hover 生效）
    await (await page.$('.host-card:has(.host-name:text-is("prod-1"))')).hover();
    await page.waitForTimeout(300);
    const h125 = await hoverProbe(page, "prod-1");
    ck.check("125%：hover 时主机名仍完整可读且不压到操作组",
      !!h125 && h125.sideOpacity === "1" && h125.nameWidth >= 50
        && h125.nameScroll <= h125.nameWidth + 1 && h125.nameRight <= h125.sideLeft,
      JSON.stringify(h125));

    // ── 文件列表：125% 下大小列不折行、行高一致 ──
    await connect(page, "本机");
    await page.click('[data-testid="rb-files"]');
    await page.waitForTimeout(900);
    const rows = await page.evaluate(() => {
      const list = [...document.querySelectorAll(".sftp-row")];
      const sizes = list.map((r) => {
        const el = r.querySelector(".sftp-size");
        return {
          text: el.textContent.trim(),
          lines: el.getClientRects().length,
          h: Math.round(r.getBoundingClientRect().height),
          fits: el.scrollWidth <= el.clientWidth + 1,
        };
      });
      return { n: list.length, sizes };
    });
    const heights = rows.sizes.map((s) => s.h);
    ck.check("文件行大小列 125% 下保持单行且不溢出",
      rows.n >= 4 && rows.sizes.every((s) => s.lines === 1 && s.fits),
      JSON.stringify(rows.sizes));
    ck.check("文件行高一致（不再出现 50px 折行行）",
      heights.length >= 4 && Math.max(...heights) - Math.min(...heights) <= 2,
      JSON.stringify(heights));
    ck.check("大小文本仍含 MB 单位（真实数据在列内）",
      rows.sizes.some((s) => /MB|KB|B/.test(s.text)), JSON.stringify(rows.sizes.map((s) => s.text)));
  },
};
