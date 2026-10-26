// 59 记录时间线可视化：明细列表上方内嵌会话泳道 SVG——x=时间、颜色=状态、
// 实心=Agent/空心=人类、半径=耗时（对数）；点击刻度滚动定位明细行并闪烁约 1.7s。
// 图直接吃当前筛选的 rows：筛选变化图与行同步。

const openSettings = async (page) => {
  await page.click(".hb-settings");
  await page.waitForTimeout(700);
};

const snap = (page) => page.evaluate(() => ({
  dots: document.querySelectorAll('[data-testid^="records-dot-"]').length,
  rows: document.querySelectorAll('[data-testid="records-row"]').length,
  lanes: document.querySelectorAll('[data-testid="records-lane"]').length,
  laneText: document.querySelector('[data-testid="records-lane"]')?.textContent ?? "",
  caption: document.querySelector('[data-testid="records-chart-caption"]')?.textContent ?? "",
  legend: document.querySelector('[data-testid="records-chart-legend"]')?.textContent ?? "",
  hollow: document.querySelectorAll('[data-testid^="records-dot-"][data-agent="0"]').length,
  filled: document.querySelectorAll('[data-testid^="records-dot-"][data-agent="1"]').length,
}));

module.exports = {
  title: "记录时间线可视化（泳道图）",
  async run({ page, ck }) {
    await openSettings(page);
    await page.click("[data-testid=settings-cat-records]");
    await page.waitForFunction(
      () => document.querySelectorAll('[data-testid="records-row"]').length >= 200,
      { timeout: 8000 },
    );

    // ── 全量视图：图与行同步、泳道/统计头/图例 ──
    const s = await snap(page);
    ck.check("泳道图与明细行同步渲染（200 刻度 = 200 行）",
      s.dots === s.rows && s.dots === 200, JSON.stringify({ dots: s.dots, rows: s.rows }));
    ck.check("统计头带条数（200 条）", s.caption.includes("200 条"), s.caption);
    ck.check("单会话单泳道", s.lanes === 1 && s.laneText.length > 0, s.laneText);
    ck.check("实心（Agent）与空心（人类）刻度并存",
      s.filled > 0 && s.hollow > 0, JSON.stringify({ filled: s.filled, hollow: s.hollow }));
    ck.check("图例含形状语义说明", s.legend.includes("实心 = Agent") && s.legend.includes("空心 = 人类"));

    // ── 点击刻度 → 定位明细行 + 闪烁，约 1.7s 自动退场 ──
    await page.evaluate(() =>
      document.querySelector('[data-testid="records-dot-2"]')
        ?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    await page.waitForFunction(
      () => document.getElementById("records-row-2")?.classList.contains("rec-row-flash"),
      { timeout: 3000 },
    );
    ck.check("点击空心人类刻度，对应明细行闪烁高亮", true);
    await page.waitForFunction(
      () => !document.getElementById("records-row-2")?.classList.contains("rec-row-flash"),
      { timeout: 4000 },
    );
    ck.check("闪烁约 1.7s 自动退场（不残留高亮）", true);

    // ── 筛选联动：种类=传输 → 图与行同步缩到 1 ──
    await page.selectOption("[data-testid=records-kind-filter]", "transfer");
    await page.waitForTimeout(500);
    const f = await snap(page);
    ck.check("筛选后图与行同步（1 刻度 = 1 行）", f.dots === 1 && f.rows === 1,
      JSON.stringify({ dots: f.dots, rows: f.rows }));
    ck.check("筛选后统计头更新（1 条）", f.caption.includes("1 条"), f.caption);
    ck.check("筛选后唯一刻度为实心（上传是 Agent 动作）",
      f.hollow === 0 && f.filled === 1, JSON.stringify({ filled: f.filled, hollow: f.hollow }));
  },
};
