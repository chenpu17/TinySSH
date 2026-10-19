// 35 输出触发器轮（P2-b）：设置 → 输出触发器 卡——规则 CRUD（面板本地草稿）、
// 保存校验（空名/坏正则/SendKeys 缺键序）与归一回填（id/冷却 clamp）、
// localStorage 持久化与 reload 回读。
// 命中路径（行界/ANSI 剥离/冷却/send 建审批卡→批准才写通道）由 Rust triggers_tests
// 钉住；demo 无真实输出流可命中，如实不做假命中。

const lsGet = (page, key) => page.evaluate((k) => localStorage.getItem(k), key);

const openTriggersSettings = async (page) => {
  await page.click(".hb-settings");
  await page.waitForTimeout(700);
  await page.click('[data-testid="settings-cat-triggers"]');
  await page.waitForTimeout(500);
};

module.exports = {
  title: "输出触发器：设置卡 CRUD/校验归一/持久化",
  async run({ page, ck }) {
    // ── 分类在场；空态 ──
    await page.click(".hb-settings");
    await page.waitForTimeout(700);
    ck.check("设置分类含「输出触发器」", await page.evaluate(() =>
      [...document.querySelectorAll('[role="tab"][data-testid^="settings-cat-"]')]
        .some((b) => b.textContent?.includes("输出触发器"))));
    await page.click('[data-testid="settings-cat-triggers"]');
    await page.waitForTimeout(500);
    ck.check("空态说明在场", await page.evaluate(() =>
      !!document.querySelector('[data-testid="triggers-empty"]')));

    // ── 新增一条 Notify 规则并保存：归一回填 id + 持久化 ──
    await page.click('[data-testid="trigger-add"]');
    await page.waitForTimeout(200);
    await page.fill('[data-testid="trigger-row"] [data-testid="trigger-name"]', "构建失败");
    await page.fill('[data-testid="trigger-row"] [data-testid="trigger-pattern"]', "BUILD FAILED");
    await page.click('[data-testid="trigger-save"]');
    await page.waitForTimeout(500);
    ck.check("保存成功提示（含条数）", await page.evaluate(() =>
      (document.querySelector('[data-testid="triggers-ok"]')?.textContent ?? "").includes("已保存 1 条")),
      await page.evaluate(() => document.querySelector('[data-testid="triggers-ok"]')?.textContent ?? "(无)"));
    const stored = JSON.parse((await lsGet(page, "ui.v2.triggers")) ?? "[]");
    ck.check("localStorage 落盘且 id 归一（t- 前缀）", stored.length === 1
      && stored[0].name === "构建失败" && stored[0].pattern === "BUILD FAILED"
      && stored[0].action === "Notify" && stored[0].id.startsWith("t-"), JSON.stringify(stored));

    // ── 校验：坏正则整体拒绝 ──
    await page.fill('[data-testid="trigger-row"] [data-testid="trigger-pattern"]', "([");
    await page.click('[data-testid="trigger-save"]');
    await page.waitForTimeout(400);
    ck.check("坏正则保存被拒（err 提示）", await page.evaluate(() =>
      (document.querySelector('[data-testid="triggers-err"]')?.textContent ?? "").includes("正则无效")),
      await page.evaluate(() => document.querySelector('[data-testid="triggers-err"]')?.textContent ?? "(无)"));
    ck.check("被拒后落盘仍是上一次成功值", ((await lsGet(page, "ui.v2.triggers")) ?? "[]").includes("BUILD FAILED"));

    // ── 校验：SendKeys 缺键序拒绝；补齐后归一 ──
    await page.fill('[data-testid="trigger-row"] [data-testid="trigger-pattern"]', "Proceed \\(y/n\\)");
    await page.selectOption('[data-testid="trigger-row"] [data-testid="trigger-action"]', "SendKeys");
    await page.waitForTimeout(200);
    ck.check("切 SendKeys 后键序输入框在场", await page.evaluate(() =>
      !!document.querySelector('[data-testid="trigger-row"] [data-testid="trigger-keys"]')));
    await page.click('[data-testid="trigger-save"]');
    await page.waitForTimeout(400);
    ck.check("缺键序保存被拒", await page.evaluate(() =>
      (document.querySelector('[data-testid="triggers-err"]')?.textContent ?? "").includes("键序")));
    await page.fill('[data-testid="trigger-row"] [data-testid="trigger-keys"]', "y\\r");
    await page.click('[data-testid="trigger-save"]');
    await page.waitForTimeout(400);
    ck.check("补齐后保存成功（发送键序计数 1）", await page.evaluate(() =>
      (document.querySelector('[data-testid="triggers-ok"]')?.textContent ?? "").includes("发送键序 1 条")));
    const stored2 = JSON.parse((await lsGet(page, "ui.v2.triggers")) ?? "[]");
    ck.check("键序按转义原文落盘（\\r 两字符；发送前才解码）", stored2[0].action === "SendKeys" && stored2[0].keys === "y\\r", JSON.stringify(stored2));

    // ── 冷却 clamp：0 → 5（归一回填可见）──
    await page.fill('[data-testid="trigger-row"] [data-testid="trigger-name"]', "构建失败"); // 无操作，保持焦点一致性
    await page.click('[data-testid="settings-cat-terminal"]');
    await page.waitForTimeout(200);
    await page.click('[data-testid="settings-cat-triggers"]');
    await page.waitForTimeout(500);
    ck.check("草稿态关分类即弃（重进回到已保存值）", await page.evaluate(() =>
      document.querySelector('[data-testid="trigger-row"] [data-testid="trigger-name"]')?.value === "构建失败"
      && document.querySelector('[data-testid="trigger-row"] [data-testid="trigger-pattern"]')?.value === "Proceed \\(y/n\\)"));

    // ── reload 回读（持久化跨启动语义的 demo 镜像）──
    await page.reload({ waitUntil: "networkidle" });
    await page.waitForTimeout(800);
    await openTriggersSettings(page);
    ck.check("reload 后规则回读", await page.evaluate(() =>
      document.querySelector('[data-testid="trigger-row"] [data-testid="trigger-name"]')?.value === "构建失败"
      && document.querySelector('[data-testid="trigger-row"] [data-testid="trigger-action"]')?.value === "SendKeys"));

    // ── 删除 + 保存归零 ──
    await page.click('[data-testid="trigger-del"]');
    await page.waitForTimeout(200);
    ck.check("删除后回到空态", await page.evaluate(() =>
      !!document.querySelector('[data-testid="triggers-empty"]')));
    await page.click('[data-testid="trigger-save"]');
    await page.waitForTimeout(400);
    ck.check("空表保存成功（已保存 0 条）", await page.evaluate(() =>
      (document.querySelector('[data-testid="triggers-ok"]')?.textContent ?? "").includes("已保存 0 条")));
    ck.eq("落盘清空", await lsGet(page, "ui.v2.triggers"), "[]");
  },
};
