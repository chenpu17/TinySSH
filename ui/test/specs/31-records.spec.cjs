// 31 记录审计：设置新增「记录审计」分区（④ 记录与审计的 GUI 消费面）。
// demo 域样本覆盖三类动作与主要终态——时间线渲染、种类/来源筛选、明文导出反馈，
// 以及 ⑥「加载更早」翻页、⑦ 保留期选择面、⑨ 日期/会话筛选与行内主机标注。

const openSettings = async (page) => {
  await page.click(".hb-settings");
  await page.waitForTimeout(700);
};

/** 指定分区面板的可见文字（断言分区内容而非全局「有字」）。 */
const paneTextOf = (page, testid) => page.evaluate((t) => {
  const e = document.querySelector(`[data-testid=${t}]`);
  return e ? e.innerText.replace(/\n+/g, " | ") : "";
}, testid);

const toast = (page) => page.evaluate(() => {
  const t = document.querySelector(".toast");
  return t ? t.textContent : "";
});

module.exports = {
  title: "记录审计时间线",
  async run({ page, ck }) {
    await openSettings(page);
    await page.click("[data-testid=settings-cat-records]");
    await page.waitForTimeout(400);

    ck.check(
      "分区打开即拉取（时间线有样本行）",
      await page.evaluate(() => document.querySelectorAll("[data-testid=records-row]").length >= 5),
    );
    const t0 = await paneTextOf(page, "settings-pane-records");
    ck.check("三类动作徽标齐备", t0.includes("命令") && t0.includes("传输") && t0.includes("转发"), t0.slice(0, 200));
    ck.check("终态如实呈现（完成/拒绝/危险拦截）", t0.includes("✓ 完成") && t0.includes("⊘ 已拒绝") && t0.includes("⚠ 危险拦截"));
    ck.check("导出卡说明明文出口与保留期", t0.includes("records-export") && t0.includes("30 天"));

    // 种类筛选：只看传输
    await page.selectOption("[data-testid=records-kind-filter]", "transfer");
    await page.waitForTimeout(400);
    const rows = await page.evaluate(() =>
      [...document.querySelectorAll("[data-testid=records-row]")].map((e) => e.innerText.replace(/\n+/g, " ")));
    ck.check("筛选后只剩传输记录", rows.length === 1 && rows[0].includes("upload"), JSON.stringify(rows));

    // 来源筛选叠加：opencode 的传输仍是同一条
    await page.selectOption("[data-testid=records-agent-filter]", "opencode");
    await page.waitForTimeout(400);
    ck.check(
      "来源筛选叠加生效",
      await page.evaluate(() => document.querySelectorAll("[data-testid=records-row]").length === 1),
    );

    // 导出：demo 不落盘，但条数反馈必须如实
    await page.click("[data-testid=records-export]");
    await page.waitForTimeout(400);
    ck.check("导出反馈含条数", (await toast(page)).includes("已导出 1 条"), await toast(page));

    // ⑥ 翻页：样本共 250 条、下拉最小档 200——重置筛选后首拉即满页（200 行）出
    // 「加载更早」，翻一页到底（250 行）按钮撤下；全程真实 selectOption/click 交互
    await page.selectOption("[data-testid=records-kind-filter]", "");
    await page.selectOption("[data-testid=records-agent-filter]", "");
    await page.waitForTimeout(600);
    const snap = () => page.evaluate(() => ({
      rows: document.querySelectorAll("[data-testid=records-row]").length,
      more: !!document.querySelector("[data-testid=records-more]"),
    }));
    let s = await snap();
    ck.check("首拉满页 200 行且出「加载更早」", s.rows === 200 && s.more, JSON.stringify(s));
    await page.click("[data-testid=records-more]");
    await page.waitForTimeout(600);
    s = await snap();
    ck.check("翻页到底 250 行且按钮撤下", s.rows === 250 && !s.more, JSON.stringify(s));

    // ⑨ 日期筛选：近 24 小时砍掉 48h 远端桶（190 < 200 → 无翻页钮）
    await page.selectOption("[data-testid=records-range-filter]", "24h");
    await page.waitForTimeout(600);
    s = await snap();
    ck.check("近 24 小时剩 190 行且无翻页钮", s.rows === 190 && !s.more, JSON.stringify(s));

    // ⑨ 会话筛选 + 主机标注：demo 全部记录属 prod-1 会话——选中后行数不变
    //（过滤实现错误才会丢行）；行内主机标注可见
    await page.selectOption("[data-testid=records-session-filter]", "s-demo-0001");
    await page.waitForTimeout(600);
    ck.check(
      "会话筛选不丢行（全部记录属该会话）",
      await page.evaluate(() => document.querySelectorAll("[data-testid=records-row]").length) === 190,
    );
    const firstRow = await page.evaluate(() =>
      document.querySelector("[data-testid=records-row]")?.innerText ?? "");
    ck.check("行内标注主机 prod-1", firstRow.includes("prod-1"), firstRow);

    // ⑦ 保留期选择面在场（demo 不落盘，只验证选择与说明）
    ck.check("保留期选择在场", await page.evaluate(() => !!document.querySelector("[data-testid=records-retention]")));
  },
};
