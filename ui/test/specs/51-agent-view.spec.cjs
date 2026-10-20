// 51 Agent 对话视图（活动栏轮）：演练外壳的完整交互形态——欢迎声明（如实标注演练）、
// 发送 → 流式回复 → 工具审批卡（拒绝分岔 / 批准分岔：运行中 → 完成 exit 0 + 输出 +
// markdown 摘要含代码块[>26 行折叠]与复制）、按会话隔离（切标签对话独立且保留）。
// 演练脚本节拍：流式 24 字符/90ms、模拟执行 600ms——断言等待从宽（≥6s）。

module.exports = {
  title: "Agent 对话视图：演练流、审批卡分岔、markdown 渲染、按会话隔离",
  async run({ page, ck }) {
    const vis = (sel) => page.evaluate((s) => {
      const el = document.querySelector(s);
      return !!el && el.getClientRects().length > 0;
    }, sel);
    const agentText = () => page.evaluate(() =>
      [...document.querySelectorAll('[data-testid="agent-md"]')].map((n) => n.textContent).join("\n"));
    const chip = () => page.evaluate(() =>
      document.querySelector('[data-testid="agent-tool"] .tc-chip')?.textContent ?? "(无卡)");

    // ── 激活 prod-1 + 打开 Agent 视图：欢迎消息在场（演练声明）──
    await page.evaluate(() => {
      const tab = [...document.querySelectorAll(".tab")].find((t) => t.textContent?.includes("prod-1"));
      if (tab) tab.click();
    });
    await page.waitForTimeout(600);
    await page.click('[data-testid="rail-agent"]');
    await page.waitForTimeout(300);
    ck.check("Agent 视图开且标注当前会话（prod-1）",
      (await vis('[data-testid="agent-view"]')) &&
      (await page.evaluate(() => document.querySelector(".ag-host")?.textContent ?? "")).includes("prod-1"),
      await page.evaluate(() => document.querySelector(".ag-host")?.textContent ?? "(无)"));
    ck.check("欢迎消息在场且如实标注演练",
      (await agentText()).includes("演练外壳"));

    // ── 发送 → 流式回复 → 工具卡停在「待审批」──
    await page.fill('[data-testid="agent-input"]', "检查 agent 服务状态");
    await page.click('[data-testid="agent-send"]');
    await page.waitForFunction(() => document.querySelectorAll(".bubble-user").length >= 1, null, { timeout: 3000 });
    await page.waitForFunction(
      () => document.querySelector('[data-testid="agent-tool"]')?.textContent?.includes("待审批") ?? false,
      null, { timeout: 8000 });
    ck.check("用户气泡 + 工具卡停在待审批（exec）",
      (await page.evaluate(() => document.querySelector('[data-testid="agent-tool"] .tc-tool')?.textContent)) === "exec" &&
      (await chip()).includes("待审批"), await chip());
    const cardBefore = await page.evaluate(() => document.querySelectorAll('[data-testid="agent-tool"]').length);

    // ── 拒绝分岔：卡变已拒绝 + 回应流式上屏 ──
    await page.click('[data-testid="agent-deny"]');
    await page.waitForFunction(
      () => document.querySelector('[data-testid="agent-tool"]')?.textContent?.includes("已拒绝") ?? false,
      null, { timeout: 3000 });
    await page.waitForFunction(
      () => [...document.querySelectorAll('[data-testid="agent-md"]')].some((n) => n.textContent?.includes("已取消")),
      null, { timeout: 8000 });
    ck.check("拒绝分岔：已拒绝 chip + 回应上屏", true);

    // ── 新对话清当前会话；再发送走批准分岔 ──
    await page.click('[data-testid="agent-new"]');
    await page.waitForTimeout(300);
    ck.check("新对话：工具卡清空、欢迎回来",
      (await page.evaluate(() => document.querySelectorAll('[data-testid="agent-tool"]').length)) === 0 &&
      (await agentText()).includes("演练外壳"));
    await page.fill('[data-testid="agent-input"]', "再查一次状态");
    await page.click('[data-testid="agent-send"]');
    await page.waitForFunction(
      () => document.querySelector('[data-testid="agent-tool"]')?.textContent?.includes("待审批") ?? false,
      null, { timeout: 8000 });

    // ── 批准分岔：运行中 → 完成 exit 0 + 输出 + markdown 摘要 ──
    await page.click('[data-testid="agent-approve"]');
    await page.waitForFunction(
      () => document.querySelector('[data-testid="agent-tool"]')?.textContent?.includes("完成 · exit 0") ?? false,
      null, { timeout: 8000 });
    ck.check("批准分岔：卡到完成 exit 0 + 输出上屏",
      (await page.evaluate(() => document.querySelector(".tc-out")?.textContent ?? "")).includes("active (running)"));
    await page.waitForFunction(
      () => [...document.querySelectorAll('[data-testid="agent-md"]')].some((n) => n.textContent?.includes("巡检结果")),
      null, { timeout: 10000 });
    // 流式结束（光标消失）才看折叠/表格——折叠只对稳定块生效（流式中的块不折叠）
    await page.waitForFunction(() => !document.querySelector(".ag-cursor"), null, { timeout: 10000 });
    ck.check("摘要 markdown 上屏（巡检结果标题 + 表格）",
      (await page.evaluate(() => !!document.querySelector('[data-testid="agent-md"] table'))));

    // ── 代码块渲染：>26 行稳定块折叠 + 展开钮 + 复制 toast ──
    ck.check("长代码块默认折叠（31 行 > 26）",
      await page.evaluate(() => !!document.querySelector('[data-testid="agent-md"] .md-code.code-collapsed')));
    await page.click('[data-testid="agent-md"] .code-expand');
    await page.waitForTimeout(150);
    ck.check("展开钮解除折叠",
      await page.evaluate(() => !document.querySelector('[data-testid="agent-md"] .md-code.code-collapsed')));
    await page.click('[data-testid="agent-md"] .code-copy');
    await page.waitForFunction(() => !!document.querySelector(".toast"), null, { timeout: 3000 });
    ck.check("复制代码出 toast", true);

    // ── 按会话隔离：切 staging-1 是另一段对话；切回 prod-1 现场保留 ──
    await page.evaluate(() => {
      const tab = [...document.querySelectorAll(".tab")].find((t) => t.textContent?.includes("staging-1"));
      if (tab) tab.click();
    });
    await page.waitForTimeout(600);
    ck.check("切到 staging-1：对话独立（新欢迎、无工具卡）",
      (await page.evaluate(() => document.querySelector(".ag-host")?.textContent ?? "")).includes("staging-1") &&
      (await page.evaluate(() => document.querySelectorAll('[data-testid="agent-tool"]').length)) === 0,
      await page.evaluate(() => document.querySelector(".ag-host")?.textContent ?? "(无)"));
    await page.evaluate(() => {
      const tab = [...document.querySelectorAll(".tab")].find((t) => t.textContent?.includes("prod-1"));
      if (tab) tab.click();
    });
    await page.waitForTimeout(600);
    const cardAfter = await page.evaluate(() => document.querySelectorAll('[data-testid="agent-tool"]').length);
    ck.check("切回 prod-1：对话现场保留（工具卡还在）", cardAfter === 1 && cardBefore === 1,
      `before=${cardBefore} after=${cardAfter}`);
  },
};
