// 06 活动记录：范围（当前/全部）、主体与事件类型筛选、刷新、行渲染（§6.6 尾 / S09-S11）。
//
// 断言口径（rev-r45 中-1 处置）：筛选必须**真的改变行集**，不能只断言「行数 ≤ 全部」。
// 行上带 `data-actor` / `data-action`，直接按属性核对**每一行**都属于所选类别——
// 这样把筛选改成空操作会立刻变红（rev-r45 的 M3 变异即打在此处）。

const openLog = async (page) => {
  await page.click('.session-toolbar button:has-text("工具")');
  await page.waitForTimeout(350);
  await page.evaluate(() => [...document.querySelectorAll("button")].find((b) => b.textContent.trim() === "活动记录").click());
  await page.waitForTimeout(800);
};

const rowCount = (page) => page.evaluate(() => document.querySelectorAll("[data-testid=log-row]").length);
/** 行上某个属性的取值列表（按渲染顺序）。 */
const rowAttrs = (page, attr) => page.evaluate(
  (a) => [...document.querySelectorAll("[data-testid=log-row]")].map((r) => r.getAttribute(a)),
  attr,
);
const selectedScope = (page) => page.evaluate(() => {
  const a = document.querySelector("[data-testid=log-scope-current]");
  const b = document.querySelector("[data-testid=log-scope-all]");
  return { current: a ? a.getAttribute("aria-pressed") : null, all: b ? b.getAttribute("aria-pressed") : null };
});

module.exports = {
  title: "活动记录筛选与刷新",
  async run({ page, ck }) {
    const card = await page.$('.host-card:has(.host-name:text-is("本机"))');
    await card.hover();
    await page.waitForTimeout(200);
    await (await card.$('button[title^="连接"]')).click();
    await page.waitForTimeout(1300);
    await openLog(page);

    ck.check("有范围切换（当前会话 / 全部会话）", await page.evaluate(() => !!document.querySelector("[data-testid=log-scope-current]") && !!document.querySelector("[data-testid=log-scope-all]")));
    ck.check("有主体筛选（log-actor）", await page.evaluate(() => !!document.querySelector("[data-testid=log-actor]")));
    ck.check("有事件类型筛选（log-action）", await page.evaluate(() => !!document.querySelector("[data-testid=log-action]")));
    ck.check("有刷新按钮（log-refresh）", await page.evaluate(() => !!document.querySelector("[data-testid=log-refresh]")));

    const cur = await selectedScope(page);
    ck.check("默认范围=当前会话", cur.current === "true" && cur.all !== "true", JSON.stringify(cur));

    const nCur = await rowCount(page);
    ck.check("当前会话有记录行", nCur >= 1, `实得 ${nCur} 行`);

    // ── 范围：全部会话必须**严格多于**当前会话（空操作会相等 → 红）──
    await page.click("[data-testid=log-scope-all]");
    await page.waitForTimeout(700);
    const afterAll = await selectedScope(page);
    ck.check("切换到全部会话后按钮态翻转", afterAll.all === "true", JSON.stringify(afterAll));
    const nAll = await rowCount(page);
    ck.check("全部会话行数严格多于当前会话（范围真的生效）", nAll > nCur, `全部 ${nAll} vs 当前 ${nCur}`);

    // ── 主体筛选：必须真的只剩 Agent 行 ──
    const actorOpts = await page.$$eval("[data-testid=log-actor] option", (os) => os.map((o) => o.textContent.trim()));
    ck.check("主体筛选含人类/Agent 选项", actorOpts.some((t) => t.includes("人类")) && actorOpts.some((t) => t.includes("Agent")), actorOpts.join(" / "));
    await page.selectOption("[data-testid=log-actor]", { label: actorOpts.find((t) => t.includes("Agent")) });
    await page.waitForTimeout(600);
    const nAgent = await rowCount(page);
    const agentActors = await rowAttrs(page, "data-actor");
    ck.check("筛 Agent 后行数减少（筛选真的生效）", nAgent >= 1 && nAgent < nAll, `Agent ${nAgent} vs 全部 ${nAll}`);
    ck.check("筛 Agent 后每行主体都是 agent", agentActors.length > 0 && agentActors.every((a) => a === "agent"), agentActors.join(","));

    // ── 事件类型筛选：同样按 data-action 逐行核对 ──
    const actOpts = await page.$$eval("[data-testid=log-action] option", (os) => os.map((o) => ({ v: o.value, t: o.textContent.trim() })));
    const execOpt = actOpts.find((o) => o.v === "exec");
    ck.check("事件类型含「执行命令」（value=exec）", !!execOpt, actOpts.slice(0, 5).map((o) => o.t).join(" / ") + " …");
    await page.selectOption("[data-testid=log-actor]", { index: 0 });
    await page.waitForTimeout(400);
    await page.selectOption("[data-testid=log-action]", "exec");
    await page.waitForTimeout(600);
    const nExec = await rowCount(page);
    const execActions = await rowAttrs(page, "data-action");
    ck.check("按事件类型筛后每行 action 都是 exec", nExec >= 1 && execActions.every((a) => a === "exec"), `${nExec} 行：${execActions.join(",")}`);
    ck.check("按事件类型筛后行数少于全部", nExec < nAll, `${nExec} vs ${nAll}`);

    // ── 刷新：重读后行集一致（比「行数≥1」强；但**未**断言新增事件可见，登记在映射表）──
    await page.selectOption("[data-testid=log-action]", { index: 0 });
    await page.waitForTimeout(500);
    const nBefore = await rowCount(page);
    await page.click("[data-testid=log-refresh]");
    await page.waitForTimeout(700);
    const nAfter = await rowCount(page);
    ck.check("刷新后行集不变（重读同一数据，未清空/未错乱）", nAfter === nBefore && nAfter >= 1, `前 ${nBefore} → 后 ${nAfter}`);

    // 切回当前会话
    await page.click("[data-testid=log-scope-current]");
    await page.waitForTimeout(600);
    const back = await selectedScope(page);
    ck.check("可切回当前会话范围", back.current === "true", JSON.stringify(back));
    const nBack = await rowCount(page);
    ck.check("切回后行数回到当前会话的量", nBack === nCur, `切回 ${nBack} vs 原 ${nCur}`);
  },
};
