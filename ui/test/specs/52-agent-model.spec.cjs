// 52 模型服务卡（接真模型轮，演示镜像）：设置 → Agent 分类的「模型服务」卡——
// 配置录入/保存/回显/has_key 掩码、localStorage 持久化（演示域无 vault 密封，
// 且 key 本身不入镜像）、demo 域 realMode 门（配置了也保持演练徽标）。
// 真实侧 agent-host 全链由 Rust 测试钉住（scripted mock provider），此处只保 UI 面。

module.exports = {
  title: "模型服务卡：录入/保存/回显/掩码，demo 域保持演练",
  async run({ page, ck }) {
    const openSettings = async () => { await page.click(".hb-settings"); await page.waitForTimeout(700); };
    const closeSettings = async () => {
      await page.click('[data-testid="settings-close"]').catch(async () => {
        await page.keyboard.press("Escape");
      });
      await page.waitForTimeout(400);
    };

    try {
      await openSettings();
      await page.click('[data-testid="settings-cat-agent"]');
      await page.waitForTimeout(400);
      ck.check("Agent 分类有模型服务卡",
        await page.evaluate(() => !!document.querySelector('[data-testid="agent-model-card"]')));

      // 录入并保存（demo 镜像落 localStorage）
      await page.fill('[data-testid="agent-model-name"]', "glm-4.7");
      await page.fill('[data-testid="agent-model-key"]', "sk-demo-123");
      await page.click('[data-testid="agent-model-save"]');
      await page.waitForFunction(
        () => document.querySelector('[data-testid="agent-model-msg"]')?.textContent?.includes("已保存"),
        null, { timeout: 4000 });
      ck.check("保存成功提示（加密入库文案）", true);
      const stored = await page.evaluate(() => localStorage.getItem("ui.v2.agentModel") ?? "");
      ck.check("镜像含模型名与 has_key、不含 key 明文",
        stored.includes("glm-4.7") && stored.includes('"has_key":true') && !stored.includes("sk-demo-123"),
        stored);

      // 刷新回显：模型名保持、key 掩码为「已配置」
      await page.reload({ waitUntil: "networkidle" });
      await page.waitForTimeout(500);
      await openSettings();
      await page.click('[data-testid="settings-cat-agent"]');
      await page.waitForTimeout(400);
      const modelVal = await page.evaluate(() => document.querySelector('[data-testid="agent-model-name"]')?.value ?? "");
      const keyPh = await page.evaluate(() => document.querySelector('[data-testid="agent-model-key"]')?.placeholder ?? "");
      ck.check("刷新后回显：模型名保持 + key 显示已配置",
        modelVal === "glm-4.7" && keyPh.includes("已配置"), `${modelVal} / ${keyPh}`);
      await closeSettings();

      // demo 域 realMode 门：即便配置存在，Agent 视图仍是演练外壳
      await page.evaluate(() => {
        const tab = [...document.querySelectorAll(".tab")].find((t) => t.textContent?.includes("prod-1"));
        if (tab) tab.click();
      });
      await page.waitForTimeout(500);
      await page.click('[data-testid="rail-agent"]');
      await page.waitForTimeout(400);
      ck.check("demo 域保持演练徽标（realMode 门 = inTauri）",
        await page.evaluate(() => !!document.querySelector(".ag-mock")),
        await page.evaluate(() => document.querySelector(".ag-mock")?.textContent ?? "(无徽标)"));
    } finally {
      await page.evaluate(() => localStorage.removeItem("ui.v2.agentModel"));
    }
  },
};
