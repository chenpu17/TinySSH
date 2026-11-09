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

    // ── 批准分岔：运行中 → 完成 + 输出 + markdown 摘要 ──
    await page.click('[data-testid="agent-approve"]');
    await page.waitForFunction(
      () => document.querySelector('[data-testid="agent-tool"]')?.textContent?.includes("完成") ?? false,
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

    // ── 内联审批卡（真模式形态）的呈现 + 高危臂 TTL（P1）──
    // 真模式在浏览器域不可达（realMode 门 = inTauri）。DEV 探针注入一张与
    // ApprovalRow 同形的行（id 复用 demo 的 a-demo-1，决定仍走 demo 后端），
    // 走与真模式完全同一段渲染——只验证呈现与减速带，不改审批语义。
    await page.evaluate(() => {
      window.__t_inlineApproval = {
        id: "a-demo-1",
        session_id: "s-demo-0001",
        agent_id: "tinyssh-embedded",
        command: "rm -rf /tmp/old-build && tar czf /tmp/build.tgz dist/",
        edited_command: null,
        target_summary: "删除文件/目录",
        segment_report: [
          { segment: "rm -rf /tmp/old-build", verdict: "pending: 未命中任何允许规则" },
          { segment: "tar czf /tmp/build.tgz dist/", verdict: "pending: 未命中任何允许规则" },
        ],
        session_busy: false,
        editable: true,
        created_at: new Date().toISOString(),
        status: "pending",
        purpose: null,
      };
    });
    // 关开 Agent 视图触发重挂载（探针在渲染期读取）
    await page.click('button[aria-label="关闭 Agent 视图"]');
    await page.waitForTimeout(300);
    await page.click('[data-testid="rail-agent"]');
    await page.waitForTimeout(500);

    const inCard = (sel) => page.evaluate((s) => {
      const el = document.querySelector(`[data-dev-inline] ${s}`);
      return el ? el.textContent ?? "" : "(无)";
    }, sel);
    ck.check("内联卡命令在场（12px 正文色，不再 dim 11px）",
      (await inCard('[data-testid="agent-inline-cmd"]')).includes("rm -rf") &&
      (await page.evaluate(() => {
        const el = document.querySelector('[data-dev-inline] [data-testid="agent-inline-cmd"]');
        return el ? getComputedStyle(el).fontSize : "";
      })) === "12px");
    ck.check("内联卡目的缺失显式警示", (await inCard('[data-testid="agent-inline-purpose"]')).includes("未提供目的"));
    ck.check("内联卡目标摘要小标签在场", (await inCard(".tsum-chip")) === "删除文件/目录");
    ck.check("内联卡逐段判定摘要可折叠一行",
      (await inCard("details summary")).includes("2 段判定：2 需确认"));
    ck.check("内联卡超时提示为实时倒计时（剩余 N 秒）",
      /剩余 \d+ 秒后自动拒绝/.test(await inCard('[data-testid="agent-inline-countdown"]')));
    ck.check("内联卡有「在协作面板查看完整裁决」入口",
      await page.evaluate(() => !!document.querySelector('[data-dev-inline] [data-testid="agent-open-approvals"]')));

    const inlineApprove = () => page.evaluate(() =>
      document.querySelector('[data-dev-inline] [data-testid="agent-approve-real"]')?.textContent?.trim() ?? "(无)");
    const pendingBadge = () => page.evaluate(() =>
      document.querySelector('[data-testid="collab-entry"]')?.textContent?.trim() ?? "");
    const badgeBefore = await pendingBadge();

    ck.check("内联高危首次点击只 arm（按钮出现剩余秒数）",
      (await inlineApprove()) === "确认高危并批准");
    await page.click('[data-dev-inline] [data-testid="agent-approve-real"]');
    await page.waitForTimeout(250);
    const inlineArmed = await inlineApprove();
    ck.check("arm 后按钮带剩余秒数", /再次点击确认批准（剩余 \d+ 秒）/.test(inlineArmed), inlineArmed);

    // 等过 TTL（5s）后单击不得放行：按钮回到首击文案、待审批数不变。
    await page.waitForTimeout(5500);
    const inlineAfterTtl = await inlineApprove();
    ck.check("TTL 到期撤销臂：按钮恢复首击文案", inlineAfterTtl === "确认高危并批准", inlineAfterTtl);
    ck.check("TTL 到期后单击未放行（待审批数不变）",
      (await pendingBadge()) === badgeBefore, `${badgeBefore} → ${await pendingBadge()}`);

    // TTL 内第二次点击才批准：demo 后端按决策收卡，待审批数减一。
    await page.click('[data-dev-inline] [data-testid="agent-approve-real"]');
    await page.waitForTimeout(200);
    await page.click('[data-dev-inline] [data-testid="agent-approve-real"]');
    await page.waitForTimeout(900);
    ck.check("TTL 内第二次点击放行（待审批数减少）",
      badgeBefore.includes("2 待审批") && (await pendingBadge()).includes("1 待审批"),
      `${badgeBefore} → ${await pendingBadge()}`);

    // 完整裁决入口 → 打开协作面板
    await page.click('[data-dev-inline] [data-testid="agent-open-approvals"]');
    await page.waitForTimeout(500);
    ck.check("「在协作面板查看完整裁决」打开协作面板",
      (await page.evaluate(() => document.querySelector('[data-testid="tp-title"]')?.textContent ?? "")) === "协作");
  },
};
