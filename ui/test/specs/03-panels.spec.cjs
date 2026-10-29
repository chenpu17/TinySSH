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

    // 宽度可拖（用户反馈固定 384 读文件/日志太窄）：左缘抓手拖动改宽，
    // 320–560 钳位，松手落 localStorage（下次启动恢复）
    const panelW = () => page.evaluate(() => Math.round(document.querySelector(".task-panel").getBoundingClientRect().width));
    const w0 = await panelW();
    const dragGrip = async (dx) => {
      const gb = await (await page.$(".tp-grip")).boundingBox();
      const y = gb.y + 60;
      await page.mouse.move(gb.x + gb.width / 2, y);
      await page.mouse.down();
      await page.mouse.move(gb.x + gb.width / 2 + dx, y, { steps: 10 });
      await page.mouse.up();
      await page.waitForTimeout(300);
      return panelW();
    };
    ck.eq("默认面板宽 384", w0, 384);
    const w1 = await dragGrip(-100);
    ck.check("拖左 100px 面板加宽（384→≈484）", Math.abs(w1 - (w0 + 100)) <= 3, `${w0}→${w1}`);
    const w2 = await dragGrip(-600);
    ck.check("拖到上限钳在 560", w2 === 560, String(w2));
    const w3 = await dragGrip(600);
    ck.check("拖到下限钳在 320", w3 === 320, String(w3));
    ck.eq("宽度落 localStorage", await page.evaluate(() => localStorage.getItem("ui.taskpanel_w")), "320");

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
