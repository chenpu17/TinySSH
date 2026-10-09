// 03 右侧任务面板：四视图互斥（文件 / 端口转发 / 活动记录 / 协作），标题与关闭。

const openTools = async (page, label) => {
  await page.click('.session-toolbar button:has-text("工具")');
  await page.waitForTimeout(350);
  await page.evaluate((l) => [...document.querySelectorAll("button")].find((b) => b.textContent.trim() === l).click(), label);
  await page.waitForTimeout(700);
};

const tpTitle = (page) => page.evaluate(() => (document.querySelector("[data-testid=tp-title]") || {}).textContent || null);
const panelCount = (page) => page.evaluate(() => document.querySelectorAll(".task-panel").length);

module.exports = {
  title: "任务面板四视图互斥",
  async run({ page, ck }) {
    const card = await page.$('.host-card:has(.host-name:text-is("本机"))');
    await card.hover();
    await page.waitForTimeout(200);
    await (await card.$('button[title^="连接"]')).click();
    await page.waitForTimeout(1300);

    ck.eq("初始无任务面板", await panelCount(page), 0);

    await page.click('.session-toolbar button[title^="文件"]');
    await page.waitForTimeout(800);
    ck.eq("文件视图标题", await tpTitle(page), "文件");

    await openTools(page, "端口转发");
    ck.eq("切到端口转发（同一面板换视图）", await tpTitle(page), "端口转发");
    ck.eq("面板仍只有一个", await panelCount(page), 1);

    await openTools(page, "活动记录");
    ck.eq("切到活动记录", await tpTitle(page), "活动记录");
    ck.eq("面板仍只有一个", await panelCount(page), 1);

    await page.click("[data-testid=tools-collab]");
    await page.waitForTimeout(700);
    ck.eq("切到协作", await tpTitle(page), "协作");
    ck.eq("面板仍只有一个", await panelCount(page), 1);

    await page.click("[data-testid=tp-close]");
    await page.waitForTimeout(400);
    ck.eq("关闭后无任务面板", await panelCount(page), 0);

    // 再次打开同一入口，确认关闭钮可反复用
    await page.click('.session-toolbar button[title^="文件"]');
    await page.waitForTimeout(700);
    ck.eq("可再次打开文件视图", await tpTitle(page), "文件");
    await page.click("[data-testid=tp-close]");
    await page.waitForTimeout(300);
    ck.eq("再次关闭成功", await panelCount(page), 0);
  },
};
