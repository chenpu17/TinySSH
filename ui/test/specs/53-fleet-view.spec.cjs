// 53 编排者视图（Fleet 轮）：活动栏第三入口——跨主机编排对话（键固定 "fleet"，
// 不随标签页切换）。浏览器域只有演练外壳（真实派发需桌面端+已配模型服务）：
// 入口在场、三向互斥（开编排收主机栏/Agent 视图）、演练徽标+编排徽标、mock 流
// 完整跑通（发送→工具卡→批准分岔）、刷新恢复。真实派发面（dispatch_task 等）
// 是 Rust 侧 agent-host 单测覆盖（8/8），demo 域 agent_send 显式报错不变。

module.exports = {
  title: "编排者视图：第三入口、三向互斥、演练流、刷新恢复",
  async run({ page, ck }) {
    const vis = (sel) => page.evaluate((s) => {
      const el = document.querySelector(s);
      return !!el && el.getClientRects().length > 0;
    }, sel);
    const openCls = (tid) => page.evaluate((t) =>
      document.querySelector(`[data-testid=${t}]`)?.classList.contains("ts-open") ?? false, tid);

    ck.check("活动栏有第三入口（rail-fleet）", await vis('[data-testid="rail-fleet"]'));

    // ── 打开编排视图：互斥收起主机栏 + rail-fleet 点亮 ──
    //（无论前序 spec 留下什么状态：编排关着才点开）
    if (!(await openCls("rail-fleet"))) {
      await page.click('[data-testid="rail-fleet"]');
      await page.waitForTimeout(400);
    }
    ck.check("编排视图开：rail-fleet 点亮 + 视图可见",
      (await openCls("rail-fleet")) && (await vis('[data-testid="agent-view"]')));
    ck.check("三向互斥：主机栏收起（rail-hosts 熄灭）", !(await openCls("rail-hosts")));
    ck.check("编排标识：标题=跨主机编排 + 编排徽标在场",
      (await page.evaluate(() => document.querySelector(".ag-host")?.textContent ?? "")).includes("跨主机编排") &&
      (await page.evaluate(() => [...document.querySelectorAll(".ag-own")].some((n) => n.textContent === "编排"))),
      await page.evaluate(() => document.querySelector(".ag-host")?.textContent ?? "(无)"));
    ck.check("demo 域保持演练徽标（真实派发需桌面端）",
      (await page.evaluate(() => !!document.querySelector(".ag-mock"))));

    // ── 演练流在 fleet 键上完整跑通：发送 → 待审批 → 批准 → 完成 ──
    await page.fill('[data-testid="agent-input"]', "盘点所有机器的磁盘");
    await page.click('[data-testid="agent-send"]');
    await page.waitForFunction(() => document.querySelectorAll(".bubble-user").length >= 1, null, { timeout: 3000 });
    await page.waitForFunction(
      () => document.querySelector('[data-testid="agent-tool"]')?.textContent?.includes("待审批") ?? false,
      null, { timeout: 8000 });
    ck.check("派发指令进对话 + 工具卡待审批", true);
    await page.click('[data-testid="agent-approve"]');
    await page.waitForFunction(
      () => document.querySelector('[data-testid="agent-tool"]')?.textContent?.includes("完成") ?? false,
      null, { timeout: 8000 });
    ck.check("批准分岔到完成（演练脚本同一套）",
      (await page.evaluate(() => document.querySelector('[data-testid="agent-tool"] .tc-chip')?.textContent ?? "")).includes("完成"));

    // ── 刷新恢复：ui.fleetbar=1 → 编排视图仍开 ──
    await page.reload();
    await page.waitForTimeout(900);
    ck.check("刷新后编排视图保持打开",
      (await openCls("rail-fleet")) && (await vis('[data-testid="agent-view"]')));

    // ── 协作面板：高危审批二次确认臂带 TTL（P1）──
    // 编排视图的「有 N 个待审批」提示是进协作面板的既有入口（点击即开右侧面板）。
    await page.click('[data-testid="fleet-pending-hint"]');
    await page.waitForTimeout(600);
    ck.check("待审批提示打开协作面板",
      (await page.evaluate(() => document.querySelector('[data-testid="tp-title"]')?.textContent ?? "")) === "协作");

    // 演示种子的 a-demo-1（rm -rf）是高危卡：目的由会话当前委托目标投影而来。
    const apPurpose = await page.evaluate(() => {
      const line = [...document.querySelectorAll('[data-testid="ap-purpose"]')]
        .find((el) => el.closest(".card")?.querySelector(".cmd")?.textContent?.includes("rm -rf"));
      return line ? { missing: line.classList.contains("missing"), text: line.textContent ?? "" } : null;
    });
    ck.check("高危卡显示会话委托目的（上下文在场）",
      !!apPurpose && !apPurpose.missing && apPurpose.text.includes("清理掉"), JSON.stringify(apPurpose));

    /** 找高危卡（rm -rf）的批准类按钮并返回其文案；click=true 时顺带点它。 */
    const riskApprove = (click) => page.evaluate((doClick) => {
      const cards = [...document.querySelectorAll(".task-panel .card")];
      const card = cards.find((el) => el.querySelector(".cmd")?.textContent?.includes("rm -rf"));
      if (!card) return "(无卡)";
      const btn = [...card.querySelectorAll("button")].find((b) => {
        const s = b.textContent.trim();
        return s === "批准" || s.startsWith("再次点击确认批准");
      });
      if (!btn) return "(无按钮)";
      if (doClick) btn.click();
      return btn.textContent.trim();
    }, click);
    const apCardCount = () => page.evaluate(() =>
      [...document.querySelectorAll(".task-panel .card")].filter((el) => el.querySelector(".cmd")).length);

    const nBefore = await apCardCount();
    await riskApprove(true);
    await page.waitForTimeout(250);
    const armed = await riskApprove(false);
    ck.check("首次点击批准只 arm（按钮出现剩余秒数）",
      /再次点击确认批准（剩余 \d+ 秒）/.test(armed), armed);

    // 等过 TTL（5s）后单击不得放行：按钮回到「批准」、审批卡仍在。
    await page.waitForTimeout(5500);
    const afterTtl = await riskApprove(false);
    ck.check("TTL 到期撤销臂：按钮恢复「批准」", afterTtl === "批准", afterTtl);
    ck.check("TTL 到期后审批卡未被放行", (await apCardCount()) === nBefore, `${nBefore} → ${await apCardCount()}`);

    // TTL 内第二次点击才批准：卡数减一。
    await riskApprove(true);
    await page.waitForTimeout(200);
    await riskApprove(true);
    await page.waitForTimeout(900);
    ck.check("TTL 内第二次点击放行（审批卡减少）",
      (await apCardCount()) === nBefore - 1, `${nBefore} → ${await apCardCount()}`);

    // ── 切回主机栏：编排收起（三向互斥的另一半） ──
    await page.click('[data-testid="rail-hosts"]');
    await page.waitForTimeout(400);
    ck.check("点开连接：编排视图收起",
      !(await openCls("rail-fleet")) && (await openCls("rail-hosts")));
  },
};
