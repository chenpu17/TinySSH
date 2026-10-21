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

    // ── 切回主机栏：编排收起（三向互斥的另一半） ──
    await page.click('[data-testid="rail-hosts"]');
    await page.waitForTimeout(400);
    ck.check("点开连接：编排视图收起",
      !(await openCls("rail-fleet")) && (await openCls("rail-hosts")));
  },
};
