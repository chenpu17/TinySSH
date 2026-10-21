// 50 活动栏（活动栏轮）：左缘图标栏（连接/Agent 两视图入口，互斥）、Agent 视图
// 开合与宽度持久化（localStorage ui.agentbar / ui.agentbar_w）、专注模式整体隐藏。
// 主机栏既有语义不动（⌘B/开关/宽度只改坐标口径：抓手 x −44 活动栏占位）。
// 富文本轮补：设置常驻第四图标（rail-settings，钉栏底、不占互斥位）——全关态
// 下设置面板仍可直开（此前全关态只剩 ⌘K 可达）。

module.exports = {
  title: "活动栏：视图切换互斥、Agent 视图宽度持久化、专注模式隐藏",
  async run({ page, ck }) {
    const vis = (sel) => page.evaluate((s) => {
      const el = document.querySelector(s);
      return !!el && el.getClientRects().length > 0;
    }, sel);

    // ── 活动栏在场，默认「连接」视图开（主机栏语义迁移）──
    ck.check("活动栏在场（rail-hosts + rail-agent）",
      (await page.$('[data-testid="rail-hosts"]')) && !!(await page.$('[data-testid="rail-agent"]')));
    ck.check("默认主机栏开（rail-hosts 点亮）",
      (await vis(".hostbar")) &&
      await page.evaluate(() => document.querySelector('[data-testid="rail-hosts"]')?.classList.contains("ts-open")));

    // ── 切到 Agent 视图：互斥（主机栏收起）+ 默认宽 420 + 开合落盘 ──
    await page.click('[data-testid="rail-agent"]');
    await page.waitForTimeout(300);
    ck.check("Agent 视图开（agent-view 在场、默认 420px）",
      (await vis('[data-testid="agent-view"]')) &&
      await page.evaluate(() => document.querySelector('[data-testid="agent-view"]')?.style.width === "420px"),
      await page.evaluate(() => document.querySelector('[data-testid="agent-view"]')?.style.width ?? "(无)"));
    ck.check("互斥：主机栏收起、rail-agent 点亮",
      !(await vis(".hostbar")) &&
      await page.evaluate(() => document.querySelector('[data-testid="rail-agent"]')?.classList.contains("ts-open")));
    ck.check("开合持久化：ui.agentbar=1 且 ui.hostbar=0",
      await page.evaluate(() => localStorage.getItem("ui.agentbar") === "1" && localStorage.getItem("ui.hostbar") === "0"));

    // ── 拖宽抓手到 x=524（= 44 活动栏 + 480）→ 宽 480 并落盘 ──
    const grip = await page.$('[data-testid="agent-view"] ~ .hb-grip');
    ck.check("Agent 抓手在场（agent-view 兄弟节点）", !!grip);
    const gb = await grip.boundingBox();
    await page.mouse.move(gb.x + 3, gb.y + 200);
    await page.mouse.down();
    await page.mouse.move(524, gb.y + 200, { steps: 6 });
    await page.mouse.up();
    await page.waitForTimeout(200);
    ck.check("拖宽生效：480px + ui.agentbar_w=480",
      await page.evaluate(() => document.querySelector('[data-testid="agent-view"]')?.style.width === "480px" &&
        localStorage.getItem("ui.agentbar_w") === "480"),
      await page.evaluate(() => localStorage.getItem("ui.agentbar_w") ?? "(未落盘)"));

    // ── 刷新恢复：视图开 + 宽度保持 ──
    await page.reload({ waitUntil: "networkidle" });
    await page.waitForTimeout(500);
    ck.check("刷新后 Agent 视图恢复（宽 480）",
      (await vis('[data-testid="agent-view"]')) &&
      await page.evaluate(() => document.querySelector('[data-testid="agent-view"]')?.style.width === "480px"));

    // ── 切回连接视图：主机栏回、Agent 收；再点一次全关（hb-expand 浮标回归）──
    await page.click('[data-testid="rail-hosts"]');
    await page.waitForTimeout(250);
    ck.check("切回连接视图：主机栏开、Agent 收",
      (await vis(".hostbar")) && !(await vis('[data-testid="agent-view"]')));
    await page.click('[data-testid="rail-hosts"]');
    await page.waitForTimeout(250);
    ck.check("再点全关：两视图都收、hb-expand 浮标在场",
      !(await vis(".hostbar")) && !(await vis('[data-testid="agent-view"]')) && !!(await page.$(".hb-expand")));

    // ── 设置常驻图标（不占互斥位）：全关态（此刻设置只剩 ⌘K 可达）直开面板 ──
    ck.check("rail-settings 在场且钉栏底（rail-tail）",
      await page.evaluate(() => {
        const b = document.querySelector('[data-testid="rail-settings"]');
        return !!b && b.classList.contains("rail-tail");
      }));
    await page.click('[data-testid="rail-settings"]');
    await page.waitForTimeout(250);
    ck.check("全关态点 rail-settings：设置面板直开 + 图标点亮",
      (await vis(".term-settings.settings-wide")) &&
      await page.evaluate(() => document.querySelector('[data-testid="rail-settings"]')?.classList.contains("ts-open")));
    await page.click('[data-testid="settings-close"]');
    await page.waitForTimeout(250);
    ck.check("关闭设置面板：点亮态清除、侧栏保持全关",
      !(await vis(".term-settings.settings-wide")) &&
      !await page.evaluate(() => document.querySelector('[data-testid="rail-settings"]')?.classList.contains("ts-open")) &&
      !(await vis(".hostbar")));

    // ── 专注模式：活动栏/Agent 栏/右缘栏整体隐藏（回现场再退出）──
    await page.click('[data-testid="rail-hosts"]');
    await page.click('[data-testid="rail-agent"]');
    await page.waitForTimeout(250);
    await page.click('[data-testid="focus-toggle"]');
    await page.waitForTimeout(300);
    const focusHidden = await page.evaluate(() => {
      const hide = (s) => {
        const el = document.querySelector(s);
        return !el || getComputedStyle(el).display === "none";
      };
      return hide(".actrail") && hide(".agentbar") && hide(".rb-rail");
    });
    ck.check("专注模式：actrail/agentbar/rb-rail 全隐藏", focusHidden);
    await page.click('[data-testid="focus-toggle"]');
    await page.waitForTimeout(300);
  },
};
