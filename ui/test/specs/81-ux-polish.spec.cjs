// 81 主机搜索与减少动画：高频筛选路径的一致性、快速恢复与系统动效偏好。
module.exports = {
  title: "主机搜索一致性与减少动画",
  async run({ page, ck }) {
    const hostCount = () => page.locator(".host-card").count();
    const search = page.locator(".hb-search input");

    await search.fill("prod");
    await page.waitForTimeout(250);
    ck.check("搜索 prod 后本机常驻、两台 prod 命中", await hostCount() === 3);
    await page.click('[data-testid="rail-hosts"]');
    await page.waitForTimeout(200);
    await page.click('[data-testid="rail-hosts"]');
    await page.waitForTimeout(250);
    ck.check("重开主机栏后搜索词与列表过滤保持一致",
      (await search.inputValue()) === "prod" && await hostCount() === 3,
      `输入框=${JSON.stringify(await search.inputValue())}，主机数=${await hostCount()}`);

    await search.fill("no-such-host");
    await page.waitForTimeout(250);
    ck.check("无匹配态提供一键清除筛选",
      await page.locator('[data-testid="host-clear-filters"]').isVisible());
    await page.click('[data-testid="host-clear-filters"]');
    await page.waitForTimeout(250);
    ck.check("一键清除后搜索词清空且七台主机恢复",
      (await search.inputValue()) === "" && await hostCount() === 7);

    await search.fill("staging");
    await page.waitForTimeout(200);
    ck.check("输入有内容时显示清除按钮", await page.locator('[data-testid="host-search-clear"]').isVisible());
    await page.click('[data-testid="host-search-clear"]');
    await page.waitForTimeout(250);
    ck.check("清除按钮恢复列表并把焦点留在搜索框",
      await hostCount() === 7 && await search.evaluate((el) => document.activeElement === el));

    await search.fill("prod");
    await page.waitForTimeout(200);
    await search.press("Escape");
    await page.waitForTimeout(250);
    ck.check("Escape 清空当前搜索且不改变主机栏开关",
      (await search.inputValue()) === "" && await hostCount() === 7 && await page.locator(".hostbar").isVisible());

    // 防抖尚未提交就快速重开：迟到的 hostQuery 更新也必须回显到新输入框。
    await search.fill("prod");
    await page.evaluate(() => {
      document.querySelector('[data-testid="rail-hosts"]').click();
    });
    await page.click('[data-testid="rail-hosts"]');
    await page.waitForTimeout(250);
    ck.check("防抖落地前快速重开仍保持搜索词与列表一致",
      (await search.inputValue()) === "prod" && await hostCount() === 3,
      `输入框=${JSON.stringify(await search.inputValue())}，主机数=${await hostCount()}`);
    await page.click('[data-testid="host-search-clear"]');
    await page.waitForTimeout(200);

    // 系统减少动画应覆盖所有装饰动画，而不只覆盖早期逐个补白的类。
    await page.emulateMedia({ reducedMotion: "reduce" });
    const motion = await page.evaluate(() => {
      const attach = document.createElement("div");
      attach.className = "attach-hint";
      const record = document.createElement("span");
      record.className = "rec-dot-flash";
      document.body.append(attach, record);
      const result = {
        attach: getComputedStyle(attach).animationName,
        record: getComputedStyle(record).animationName,
      };
      attach.remove(); record.remove();
      return result;
    });
    ck.check("减少动画下接入提示不再淡出", motion.attach === "none", motion.attach);
    ck.check("减少动画下记录新点不再闪烁", motion.record === "none", motion.record);
  },
};
