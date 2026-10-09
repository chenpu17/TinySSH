// 04 端口转发：表单校验、启动、列表、停止（§6.6 / S09 / D01-D02）。

const openForwards = async (page) => {
  await page.click('.session-toolbar button:has-text("工具")');
  await page.waitForTimeout(350);
  await page.evaluate(() => [...document.querySelectorAll("button")].find((b) => b.textContent.trim() === "端口转发").click());
  await page.waitForTimeout(700);
};

const panelText = (page) => page.evaluate(() => document.querySelector(".task-panel").innerText.replace(/\n+/g, " | "));
const rows = (page) => page.evaluate(() => document.querySelectorAll(".task-panel .fwd-row, .task-panel li").length);
const errText = (page, tid) => page.evaluate((t) => (document.querySelector(`[data-testid=${t}]`) || {}).textContent || null, tid);

module.exports = {
  title: "端口转发表单与生命周期",
  async run({ page, ck }) {
    const card = await page.$('.host-card:has(.host-name:text-is("本机"))');
    await card.hover();
    await page.waitForTimeout(200);
    await (await card.$('button[title^="连接"]')).click();
    await page.waitForTimeout(1300);
    await openForwards(page);

    ck.check("空表初始为「暂无转发」", (await panelText(page)).includes("暂无转发"));
    ck.check("有 -L / -R / -D 三种类型", await page.evaluate(() => {
      const t = document.querySelector(".task-panel").innerText;
      return t.includes("-L") && t.includes("-R") && t.includes("-D");
    }));

    // 空提交 → 两条错误
    await page.evaluate(() => [...document.querySelectorAll(".task-panel button")].find((b) => b.textContent.includes("启动转发")).click());
    await page.waitForTimeout(400);
    ck.check("空提交报监听端口错（fwd-err-listen）", !!(await errText(page, "fwd-err-listen")), await errText(page, "fwd-err-listen"));
    ck.check("空提交报目标错（fwd-err-target）", !!(await errText(page, "fwd-err-target")), await errText(page, "fwd-err-target"));

    // 非法监听端口
    const inputs = await page.$$(".task-panel input");
    await inputs[1].fill("99999");
    await page.evaluate(() => [...document.querySelectorAll(".task-panel button")].find((b) => b.textContent.includes("启动转发")).click());
    await page.waitForTimeout(400);
    ck.check("监听端口 99999 被拒（1–65535）", (await errText(page, "fwd-err-listen") || "").includes("1–65535"), await errText(page, "fwd-err-listen"));

    // 合法提交
    await inputs[1].fill("8080");
    await inputs[2].fill("example.internal");
    await inputs[3].fill("80");
    await page.evaluate(() => [...document.querySelectorAll(".task-panel button")].find((b) => b.textContent.includes("启动转发")).click());
    await page.waitForTimeout(900);
    const after = await panelText(page);
    ck.check("合法提交后列表出现该转发", after.includes("8080") && after.includes("example.internal:80"), after.slice(-160));
    ck.check("转发显示「监听中」状态", after.includes("监听中"));
    ck.check("转发行有「停止」按钮", await page.evaluate(() => [...document.querySelectorAll(".task-panel button")].some((b) => b.textContent.trim() === "停止")));
    ck.check("校验错误在成功后清除", !(await errText(page, "fwd-err-listen")) && !(await errText(page, "fwd-err-target")));

    // 停止
    await page.evaluate(() => [...document.querySelectorAll(".task-panel button")].find((b) => b.textContent.trim() === "停止").click());
    await page.waitForTimeout(600);
    ck.check("停止后回到「暂无转发」", (await panelText(page)).includes("暂无转发"));
  },
};
