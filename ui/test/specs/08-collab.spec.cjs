// 08 协作：入口徽标、审批列表与决定、首次委托对话框（§3.2 / §4.2 / §4.5 / §6.7）。

const panelText = (page) => page.evaluate(() => {
  const e = document.querySelector(".task-panel");
  return e ? e.innerText.replace(/\n+/g, " | ") : null;
});
const apCount = (page) => page.evaluate(() => document.querySelectorAll("[data-testid=ap-group]").length);
/** 一条审批 = 一个「拒绝」按钮（每张审批卡恰好一个）。 */
const apItems = (page) => page.evaluate(() => [...document.querySelectorAll(".task-panel button")].filter((b) => b.textContent.trim() === "拒绝").length);

module.exports = {
  title: "协作入口、审批与委托",
  async run({ page, ck }) {
    // 入口徽标在欢迎页就有（有实际待审批必须显示提醒）
    const entry = await page.evaluate(() => {
      const e = document.querySelector("[data-testid=collab-entry]");
      return e ? e.textContent.trim() : null;
    });
    ck.check("标题区有协作入口徽标", !!entry, entry || "");
    ck.check("徽标显示待审批数（2 待审批）", !!entry && entry.includes("待审批"), entry || "");

    const card = await page.$('.host-card:has(.host-name:text-is("本机"))');
    await card.hover();
    await page.waitForTimeout(200);
    await (await card.$('button[title^="连接"]')).click();
    await page.waitForTimeout(1300);

    await page.click("[data-testid=tools-collab]");
    await page.waitForTimeout(800);
    ck.eq("协作面板标题", await page.evaluate(() => (document.querySelector("[data-testid=tp-title]") || {}).textContent), "协作");

    const n0 = await apCount(page);
    ck.check("审批按主机/会话分组（≥1 组）", n0 >= 1, `实得 ${n0} 组`);
    const i0 = await apItems(page);
    ck.check("演示种子的 2 条待审批都在（2 张卡）", i0 === 2, `实得 ${i0} 张`);
    ck.check("审批卡显示目的（ap-purpose）", await page.evaluate(() => !!document.querySelector("[data-testid=ap-purpose]")));

    const t0 = await panelText(page);
    ck.check("面板含 Agent 名", !!t0 && t0.includes("Agent"), "");
    ck.check("面板含分段命令与规则判定", !!t0 && t0.includes("未命中任何允许规则"));
    ck.check("有「批准」按钮", await page.evaluate(() => [...document.querySelectorAll(".task-panel button")].some((b) => b.textContent.trim() === "批准")));
    ck.check("有「编辑后批准」按钮", await page.evaluate(() => [...document.querySelectorAll(".task-panel button")].some((b) => b.textContent.trim() === "编辑后批准")));
    ck.check("有「拒绝」按钮", await page.evaluate(() => [...document.querySelectorAll(".task-panel button")].some((b) => b.textContent.trim() === "拒绝")));

    // 拒绝一条 → 待处理数下降
    await page.evaluate(() => {
      const btns = [...document.querySelectorAll(".task-panel button")].filter((b) => b.textContent.trim() === "拒绝");
      btns[0].click();
    });
    await page.waitForTimeout(900);
    const i1 = await apItems(page);
    ck.check("拒绝一条后待审批卡减少", i1 === i0 - 1, `${i0} → ${i1}`);
    const badge = await page.evaluate(() => {
      const e = document.querySelector("[data-testid=collab-entry]");
      return e ? e.textContent.trim() : "";
    });
    ck.check("入口徽标随之更新（恰好剩 1 待审批）", badge.includes("1 待审批") && !badge.includes("2 待审批"), badge);

    // 首次委托对话框
    const del = await page.$("[data-testid=delegate-open]");
    ck.check("有「交给 Agent…」入口", !!del);
    if (del) {
      await del.click();
      await page.waitForTimeout(600);
      const hasDlg = await page.evaluate(() => !!document.querySelector("[data-testid=delegate-dlg]"));
      ck.check("打开首次委托对话框", hasDlg);
      if (hasDlg) {
        ck.check("对话框有提交钮（delegate-submit）", await page.evaluate(() => !!document.querySelector("[data-testid=delegate-submit]")));
        ck.check("对话框可取消（Escape 关闭）", await (async () => {
          await page.keyboard.press("Escape");
          await page.waitForTimeout(400);
          return page.evaluate(() => !document.querySelector("[data-testid=delegate-dlg]"));
        })());
      }
    }
  },
};
