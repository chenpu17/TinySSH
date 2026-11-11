// 77 界面字号（KI-024）：设置 → 外观 → 字号与缩放里的「界面字号」档位。
// 只放大应用界面文字（连接管理/菜单/设置），不碰终端字号、也不做整窗缩放；
// 根变量 --ui-font-scale 由 main.tsx 在首帧前恢复（localStorage ui.ui_font_scale），
// reload 后档位与放大效果都要还在。
module.exports = {
  title: "界面字号：档位控件、根变量即时生效、终端字号不受影响、reload 保持",
  async run({ page, ck }) {
    await page.waitForTimeout(1200);

    const readScale = () => page.evaluate(() => {
      const host = document.querySelector(".host-card .host-name");
      return {
        root: getComputedStyle(document.documentElement).getPropertyValue("--ui-font-scale").trim(),
        body: getComputedStyle(document.body).fontSize,
        hostName: host ? getComputedStyle(host).fontSize : null,
        stored: localStorage.getItem("ui.ui_font_scale"),
      };
    });

    const before = await readScale();
    ck.check("默认 100%：根变量为 1、主机名 14px",
      before.root === "1" && before.hostName === "14px", JSON.stringify(before));

    // 先建一台终端：否则「终端字号不受影响」会是 null === null 的空断言
    const card = await page.$('.host-card:has(.host-name:text-is("本机"))');
    if (!card) throw new Error("本机主机卡不在场");
    await card.hover();
    await page.waitForTimeout(250);
    await (await card.$('button[title^="连接"]')).click();
    await page.waitForTimeout(1600);

    // 终端字号快照：界面字号不该动它
    const termFont = () => page.evaluate(() => {
      const t = [...(window.__t_terms?.values() ?? [])][0];
      return t ? t.options.fontSize : null;
    });
    const termFontBefore = await termFont();
    ck.check("建连后有终端实例（终端字号断言非空）", termFontBefore !== null, String(termFontBefore));

    await page.click(".hb-settings");
    await page.waitForTimeout(700);
    const ctl = await page.evaluate(() => {
      const s = document.querySelector('[data-testid="ui-font-scale-select"]');
      if (!s) return null;
      return { value: s.value, options: [...s.options].map((o) => o.value) };
    });
    ck.check("外观分类有界面字号控件（五档 0.8/0.9/1/1.1/1.25，默认 1）",
      !!ctl && ctl.value === "1"
        && JSON.stringify(ctl.options) === JSON.stringify(["0.8", "0.9", "1", "1.1", "1.25"]),
      JSON.stringify(ctl));

    await page.selectOption('[data-testid="ui-font-scale-select"]', "1.25");
    await page.waitForTimeout(400);
    const after = await readScale();
    ck.check("切 125%：根变量与界面字号即时放大（主机名 17.5px）",
      after.root === "1.25" && after.hostName === "17.5px"
        && parseFloat(after.body) > parseFloat(before.body),
      JSON.stringify(after));
    ck.eq("档位落盘（localStorage ui.ui_font_scale）", after.stored, "1.25");
    ck.eq("终端字号不受界面字号影响", await termFont(), termFontBefore);

    // 设置面板自身文字也随之放大（菜单/设置属于「应用界面」）
    const setGrows = await page.evaluate(() => {
      const navBtn = document.querySelector(".settings-nav button");
      const host = document.querySelector(".host-card .host-name");
      return !!navBtn && parseFloat(getComputedStyle(navBtn).fontSize) === 16.25
        && parseFloat(getComputedStyle(host).fontSize) === 17.5;
    });
    ck.check("设置导航等应用界面文字同步放大", setGrows, "");

    await page.evaluate(() => document.querySelector('[data-testid="settings-close"]')?.click());
    await page.waitForTimeout(300);

    await page.reload();
    await page.waitForTimeout(1500);
    const reloaded = await readScale();
    ck.check("reload 后 125% 档位与放大效果保持（首帧前恢复）",
      reloaded.root === "1.25" && reloaded.hostName === "17.5px" && reloaded.stored === "1.25",
      JSON.stringify(reloaded));
    await page.click(".hb-settings");
    await page.waitForTimeout(700);
    ck.eq("reload 后设置回显 125%",
      await page.evaluate(() => document.querySelector('[data-testid="ui-font-scale-select"]')?.value), "1.25");

    // 用户反馈 #17：最小只能 90% → 新增 80% 档（低分屏/小窗口再让出一档）
    await page.selectOption('[data-testid="ui-font-scale-select"]', "0.8");
    await page.waitForTimeout(400);
    const tiny = await readScale();
    ck.check("切 80%：根变量 0.8、主机名 11.2px、档位落盘",
      tiny.root === "0.8" && tiny.hostName === "11.2px" && tiny.stored === "0.8",
      JSON.stringify(tiny));

    // 还原 100%，避免留档影响后续手动运行
    await page.selectOption('[data-testid="ui-font-scale-select"]', "1");
    await page.waitForTimeout(300);
    ck.check("还原 100% 后根变量复位",
      (await readScale()).root === "1", "");
  },
};
