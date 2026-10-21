// 54 富文本渲染轮：mdview 的 mermaid/KaTeX 懒加载管线（占位 → 动态 import →
// turn 末稳定后渲染）。演练摘要注入样本：mermaid 围栏渲染成 SVG（htmlLabels
// 关闭 + DOMPurify svg profile → 无 foreignObject）、行内公式渲染、块级 $$..
// $$ 与 ```math 围栏两种 display 形态、货币 $100 误判防线保持字面、mermaid
// 源码复制（渲染成功后 pre 已被 SVG 替换，从 data-mm 取）。
// 演练流式 24 字符/90ms，摘要含 31 行代码块约 7s；mermaid 动态 chunk 首次
// 加载（vite 依赖预构建）可能十几秒——断言等待从宽。

module.exports = {
  title: "富文本渲染：mermaid SVG、KaTeX 行内/块级/围栏、货币保持字面、图源复制",
  async run({ page, ck }) {
    const agentText = () => page.evaluate(() =>
      [...document.querySelectorAll('[data-testid="agent-md"]')].map((n) => n.textContent).join("\n"));

    // ── 激活 prod-1 + 打开 Agent 视图 → 发送 → 批准 → 摘要流式结束 ──
    await page.evaluate(() => {
      const tab = [...document.querySelectorAll(".tab")].find((t) => t.textContent?.includes("prod-1"));
      if (tab) tab.click();
    });
    await page.waitForTimeout(600);
    await page.click('[data-testid="rail-agent"]');
    await page.waitForTimeout(300);
    await page.fill('[data-testid="agent-input"]', "做一次巡检并画张架构图");
    await page.click('[data-testid="agent-send"]');
    await page.waitForFunction(
      () => document.querySelector('[data-testid="agent-tool"]')?.textContent?.includes("待审批") ?? false,
      null, { timeout: 8000 });
    await page.click('[data-testid="agent-approve"]');
    await page.waitForFunction(
      () => document.querySelector('[data-testid="agent-tool"]')?.textContent?.includes("完成") ?? false,
      null, { timeout: 8000 });
    await page.waitForFunction(() => !document.querySelector(".ag-cursor"), null, { timeout: 20000 });

    // ── mermaid：渲染成功态 .mm-ok + SVG 上屏 + 纯 SVG（无 foreignObject）──
    await page.waitForFunction(
      () => !!document.querySelector('[data-testid="agent-md"] .mermaid-wrap.mm-ok svg'),
      null, { timeout: 45000 });
    ck.check("mermaid 围栏渲染成 SVG（mm-ok）",
      await page.evaluate(() => !!document.querySelector('[data-testid="agent-md"] .mermaid-wrap.mm-ok svg')));
    ck.check("SVG 无 foreignObject（htmlLabels 关闭 + DOMPurify svg profile）",
      await page.evaluate(() => !document.querySelector('[data-testid="agent-md"] .mermaid-wrap svg foreignObject')));

    // ── KaTeX：行内 $..$ + 块级 $$..$$ + ```math 围栏（两种 display 形态）──
    ck.check("行内公式渲染（.math-inline.math-ok 含 .katex）",
      await page.evaluate(() => !!document.querySelector('[data-testid="agent-md"] .math-inline.math-ok .katex')));
    ck.check("块级公式两种形态都渲染（$$ 块 + math 围栏 = 2 个 .math-block.math-ok）",
      (await page.evaluate(() =>
        document.querySelectorAll('[data-testid="agent-md"] .math-block.math-ok').length)) === 2,
      await page.evaluate(() =>
        String(document.querySelectorAll('[data-testid="agent-md"] .math-block.math-ok').length)));

    // ── 误判防线：货币 $100 保持字面（未配对 → 不进 KaTeX）──
    ck.check("货币金额保持字面（$100/月 未被公式化）",
      (await agentText()).includes("$100/月"));

    // ── mermaid 源码复制：渲染成功后 pre 已被替换，从 data-mm 取 ──
    await page.click('[data-testid="agent-md"] .mermaid-wrap .code-copy');
    await page.waitForFunction(() => !!document.querySelector(".toast"), null, { timeout: 3000 });
    ck.check("mermaid 源码复制出 toast", true);
  },
};
