// 85 界面密度（用户反馈 #24）：非全屏矮窗里标题栏/标签栏/会话工具栏/状态条四条
// chrome 占纵向空间过多。设置 → 外观 → 界面密度新增「舒适 / 紧凑」两档：
// 紧凑档只压这四条的高度（44/34/32/26 → 32/28/28/22），入口一个不少，
// 根属性 data-density + CSS 变量 --chrome-*-h 即时生效，localStorage 首帧前恢复。
module.exports = {
  title: "界面密度：紧凑档压矮四条 chrome、入口不隐藏、reload 保持、可还原",
  async run({ page, ck }) {
    await page.waitForTimeout(1200);

    const read = () => page.evaluate(() => {
      const h = (sel) => {
        const el = document.querySelector(sel);
        return el ? Math.round(el.getBoundingClientRect().height) : null;
      };
      const visible = [".titlebar", ".tabbar-row", ".session-toolbar", ".statusbar"].every((sel) => {
        const el = document.querySelector(sel);
        return !!el && getComputedStyle(el).display !== "none" && el.getBoundingClientRect().height > 0;
      });
      return {
        title: h(".titlebar"),
        tabs: h(".tabbar-row"),
        toolbar: h(".session-toolbar"),
        status: h(".statusbar"),
        visible,
        density: document.documentElement.dataset.density ?? null,
        stored: localStorage.getItem("ui.ui_density"),
      };
    });

    // 先建一台终端，否则会话工具栏不会挂载
    const card = await page.$('.host-card:has(.host-name:text-is("本机"))');
    if (!card) throw new Error("本机主机卡不在场");
    await card.hover();
    await page.waitForTimeout(250);
    await (await card.$('button[title^="连接"]')).click();
    await page.waitForTimeout(1600);

    const before = await read();
    ck.check("默认舒适档：标题 44 / 标签 34 / 工具栏 32 / 状态条 26，四条都在",
      before.title === 44 && before.tabs === 34 && before.toolbar === 32 && before.status === 26
        && before.visible && before.density === null,
      JSON.stringify(before));

    // 矮窗实景基线：1280×560 下舒适档的终端可视高度
    const termHeight = async () => {
      await page.waitForTimeout(600);
      return page.evaluate(() => {
        const el = document.querySelector(".term-session.active");
        return el ? Math.round(el.getBoundingClientRect().height) : null;
      });
    };
    await page.setViewportSize({ width: 1280, height: 560 });
    const comfortTerm = await termHeight();
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.waitForTimeout(400);
    ck.check("舒适档 1280×560 终端区有高度（紧凑档对比基线）", comfortTerm !== null && comfortTerm > 100, String(comfortTerm));

    await page.click(".hb-settings");
    await page.waitForTimeout(700);
    const ctl = await page.evaluate(() => {
      const s = document.querySelector('[data-testid="ui-density-select"]');
      return s ? { value: s.value, options: [...s.options].map((o) => o.value) } : null;
    });
    ck.check("外观分类有界面密度控件（舒适/紧凑，默认舒适）",
      !!ctl && ctl.value === "comfortable"
        && JSON.stringify(ctl.options) === JSON.stringify(["comfortable", "compact"]),
      JSON.stringify(ctl));

    await page.selectOption('[data-testid="ui-density-select"]', "compact");
    await page.waitForTimeout(500);
    const compact = await read();
    ck.check("切紧凑档：四条压到 32 / 28 / 28 / 22，根属性与落盘同步",
      compact.title === 32 && compact.tabs === 28 && compact.toolbar === 28 && compact.status === 22
        && compact.density === "compact" && compact.stored === "compact",
      JSON.stringify(compact));
    ck.check("紧凑档不隐藏任何一条 chrome", compact.visible, JSON.stringify(compact));

    // 矮窗实景：1280×560 下终端可视高度应比舒适档多出约 26px（四条合计压缩量）
    await page.evaluate(() => document.querySelector('[data-testid="settings-close"]')?.click());
    await page.waitForTimeout(300);
    await page.setViewportSize({ width: 1280, height: 560 });
    const compactTerm = await termHeight();
    ck.check("紧凑档把省下的 26px 全部让给终端（1280×560 实测）",
      comfortTerm !== null && compactTerm !== null && compactTerm - comfortTerm >= 24,
      JSON.stringify({ comfortTerm, compactTerm }));
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.waitForTimeout(400);

    await page.reload();
    await page.waitForTimeout(1500);
    // demo 不恢复上一轮的连接；重连后会话工具栏才会重新挂载
    const card2 = await page.$('.host-card:has(.host-name:text-is("本机"))');
    if (!card2) throw new Error("reload 后本机主机卡不在场");
    await card2.hover();
    await page.waitForTimeout(250);
    await (await card2.$('button[title^="连接"]')).click();
    await page.waitForTimeout(1600);
    const reloaded = await read();
    ck.check("reload 后紧凑档与四条高度保持（首帧前恢复）",
      reloaded.title === 32 && reloaded.tabs === 28 && reloaded.toolbar === 28 && reloaded.status === 22
        && reloaded.density === "compact" && reloaded.stored === "compact",
      JSON.stringify(reloaded));

    await page.click(".hb-settings");
    await page.waitForTimeout(700);
    ck.eq("reload 后设置回显紧凑档",
      await page.evaluate(() => document.querySelector('[data-testid="ui-density-select"]')?.value), "compact");
    await page.selectOption('[data-testid="ui-density-select"]', "comfortable");
    await page.waitForTimeout(400);
    const restored = await read();
    ck.check("切回舒适档：四条恢复 44 / 34 / 32 / 26，根属性移除",
      restored.title === 44 && restored.tabs === 34 && restored.toolbar === 32 && restored.status === 26
        && restored.density === null && restored.stored === "comfortable",
      JSON.stringify(restored));
  },
};
