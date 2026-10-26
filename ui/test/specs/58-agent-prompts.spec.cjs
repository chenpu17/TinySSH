// 58 提示词/技能资产化：设置 → Agent 的「提示词与技能」卡——附加段×2（blur/切分类即存，
// 切走再切回回显=持久化对账）+ 技能库 CRUD（显式保存 + 校验）。
// demo 域走 settings Map 镜像（get_setting/set_setting 契约同真侧 vault）。

const setVal = (page, sel, val) => page.evaluate(([s, v]) => {
  const el = document.querySelector(s);
  if (!el) throw new Error(`missing ${s}`);
  const proto = el.tagName === "TEXTAREA" ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value").set.call(el, v);
  el.dispatchEvent(new Event("input", { bubbles: true }));
}, [sel, val]);

const val = (page, sel) => page.evaluate((s) => document.querySelector(s)?.value ?? null, sel);

const clickCat = async (page, cat) => {
  await page.click(`[data-testid=settings-cat-${cat}]`);
  await page.waitForTimeout(400);
};

module.exports = {
  title: "Agent 提示词与技能（资产化）",
  async run({ page, ck }) {
    await page.click(".hb-settings");
    await page.waitForTimeout(700);
    await clickCat(page, "agent");

    // ── 卡面骨架 ──
    ck.check("Agent 分区有「提示词与技能」卡",
      await page.evaluate(() => !!document.querySelector('[data-testid="agent-prompt-skills-card"]')));
    ck.check("两个附加段 textarea 与技能库空态齐备",
      await page.evaluate(() =>
        !!document.querySelector('[data-testid="agent-prompt-extra"]')
        && !!document.querySelector('[data-testid="agent-fleet-prompt-extra"]')
        && !!document.querySelector('[data-testid="agent-skills-empty"]')));

    // ── 会话助手附加段：填 → 切走 → 切回，回显=已存 KV ──
    await setVal(page, '[data-testid="agent-prompt-extra"]', "生产库只读优先，改动先报备");
    await clickCat(page, "appearance");
    await clickCat(page, "agent");
    ck.check("会话助手附加段切分类往返后回显（blur/卸载兜底保存生效）",
      (await val(page, '[data-testid="agent-prompt-extra"]')) === "生产库只读优先，改动先报备",
      JSON.stringify(await val(page, '[data-testid="agent-prompt-extra"]')));

    // ── Fleet 附加段同款往返 ──
    await setVal(page, '[data-testid="agent-fleet-prompt-extra"]', "汇总一律用表格");
    await clickCat(page, "appearance");
    await clickCat(page, "agent");
    ck.check("Fleet 附加段切分类往返后回显",
      (await val(page, '[data-testid="agent-fleet-prompt-extra"]')) === "汇总一律用表格");

    // ── 清空按钮：清视图态 + 落 KV（往返验证） ──
    await page.click('[data-testid="agent-prompt-extra-clear"]');
    await clickCat(page, "appearance");
    await clickCat(page, "agent");
    ck.check("清空按钮落 KV（往返后为空串）",
      (await val(page, '[data-testid="agent-prompt-extra"]')) === "");

    // ── 技能库：添加 → 保存 → 往返回显 ──
    await page.click('[data-testid="skill-add"]');
    ck.check("添加技能出第一行（名称+正文）",
      await page.evaluate(() =>
        !!document.querySelector('[data-testid="skill-name-0"]')
        && !!document.querySelector('[data-testid="skill-body-0"]')));
    await setVal(page, '[data-testid="skill-name-0"]', "nginx 排障");
    await setVal(page, '[data-testid="skill-body-0"]', "先看 error.log 的 upstream 超时，再查端口与防火墙。");
    await page.click('[data-testid="skill-save"]');
    ck.check("保存技能库出成功消息（1 条）",
      await page.evaluate(() =>
        document.querySelector('[data-testid="agent-skills-msg"]')?.textContent.includes("已保存（1 条）")));
    await clickCat(page, "appearance");
    await clickCat(page, "agent");
    ck.check("技能往返后回显（KV JSON 持久化）",
      (await val(page, '[data-testid="skill-name-0"]')) === "nginx 排障"
      && (await val(page, '[data-testid="skill-body-0"]'))?.includes("upstream 超时"));
    ck.check("空态退场、计数 1/32",
      await page.evaluate(() =>
        !document.querySelector('[data-testid="agent-skills-empty"]')
        && document.querySelector('[data-testid="agent-prompt-skills-card"]').innerText.includes("技能库（1/32）")));

    // ── 校验：重名拒绝保存 ──
    await page.click('[data-testid="skill-add"]');
    await setVal(page, '[data-testid="skill-name-1"]', "nginx 排障");
    await page.click('[data-testid="skill-save"]');
    ck.check("重名保存被拒（错误消息）",
      await page.evaluate(() =>
        document.querySelector('[data-testid="agent-skills-msg"]')?.textContent.includes("技能名称重复")));

    // ── 删除 → 保存 → 往返回空态（重名场景留了两行，删两次清空） ──
    await page.click('[data-testid="skill-del-0"]');
    await page.click('[data-testid="skill-del-0"]');
    await page.click('[data-testid="skill-save"]');
    ck.check("删除后保存出成功消息（0 条）",
      await page.evaluate(() =>
        document.querySelector('[data-testid="agent-skills-msg"]')?.textContent.includes("已保存（0 条）")));
    await clickCat(page, "appearance");
    await clickCat(page, "agent");
    ck.check("删除往返后回空态（KV 已清）",
      await page.evaluate(() => !!document.querySelector('[data-testid="agent-skills-empty"]')));
  },
};
