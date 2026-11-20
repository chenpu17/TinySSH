// 100 GitHub #54：多标签横向滚动到头的视觉与几何稳定性。
// 旧实现只按 left/right 条件挂载箭头：平滑滚动到边界时箭头突然卸载，标签流宽度
// 随之变化并回钳 scrollLeft。溢出期间应始终保留双钮、到头侧禁用；渐隐只提示仍有
// 隐藏标签的方向。无溢出、移动端紧凑切换器均不走这套装饰。

const readState = (page) => page.evaluate(() => {
  const bar = document.querySelector(".tabbar");
  if (!bar) throw new Error("tabbar missing");
  const left = document.querySelector('button[aria-label="向左滚动标签"]');
  const right = document.querySelector('button[aria-label="向右滚动标签"]');
  const cs = getComputedStyle(bar);
  return {
    count: bar.querySelectorAll(".tab").length,
    scrollLeft: bar.scrollLeft,
    max: bar.scrollWidth - bar.clientWidth,
    width: bar.getBoundingClientRect().width,
    overflow: bar.dataset.overflow,
    canLeft: bar.dataset.canLeft,
    canRight: bar.dataset.canRight,
    mask: cs.maskImage || cs.webkitMaskImage,
    scrollPaddingLeft: cs.scrollPaddingLeft,
    leftExists: !!left,
    rightExists: !!right,
    leftDisabled: left?.disabled ?? null,
    rightDisabled: right?.disabled ?? null,
  };
});

const scrollTo = async (page, where) => {
  await page.evaluate((mode) => {
    const bar = document.querySelector(".tabbar");
    const max = bar.scrollWidth - bar.clientWidth;
    bar.scrollLeft = mode === "left" ? 0 : mode === "right" ? max : max / 2;
    bar.dispatchEvent(new Event("scroll", { bubbles: true }));
  }, where);
  await page.waitForTimeout(350);
};

const connectNewLocal = async (page, previous) => {
  const card = await page.$('.host-card:has(.host-name:text-is("本机"))');
  if (!card) throw new Error("本机主机卡不存在");
  await card.click({ button: "right" });
  await page.waitForSelector('.ctx-menu [role="menuitem"]');
  await page.evaluate(() => {
    const item = [...document.querySelectorAll('.ctx-menu [role="menuitem"]')]
      .find((el) => el.textContent?.trim() === "连接（新建会话）");
    if (!item) throw new Error("新建会话菜单项不存在");
    item.click();
  });
  await page.waitForFunction((n) => document.querySelectorAll(".tabbar .tab").length > n, previous, { timeout: 6000 });
  await page.waitForTimeout(300);
};

module.exports = {
  title: "多标签溢出：固定滚动入口、方向渐隐与到头无跳变（#54）",
  async run({ page, ck }) {
    const plain = await readState(page);
    ck.check("少量标签无溢出时不显示滚动钮", plain.overflow === "false" && !plain.leftExists && !plain.rightExists, JSON.stringify(plain));
    ck.check("无溢出时标签流不挂边缘遮罩", plain.mask === "none", plain.mask);

    // demo 预置 prod/staging 两签，再显式新开 8 个本机会话，真实走完整建连与标签渲染。
    for (let i = 0; i < 8; i++) {
      const n = await page.locator(".tabbar .tab").count();
      await connectNewLocal(page, n);
    }
    await page.waitForTimeout(800);
    const right = await readState(page);
    ck.check("十个标签形成真实横向溢出", right.count === 10 && right.overflow === "true" && right.max > 20, JSON.stringify(right));
    ck.check("最右端双钮仍在且右钮禁用、左钮可用",
      right.leftExists && right.rightExists && right.leftDisabled === false && right.rightDisabled === true, JSON.stringify(right));
    ck.check("最右端只保留左侧渐隐", right.canLeft === "true" && right.canRight === "false" && right.mask.includes("gradient"), JSON.stringify(right));
    ck.check("活动标签已滚到最右端", Math.abs(right.scrollLeft - right.max) <= 2, `${right.scrollLeft} / ${right.max}`);
    ck.check("溢出滚动为活动标签预留 24px 渐隐安全区", right.scrollPaddingLeft === "24px", right.scrollPaddingLeft);

    await scrollTo(page, "middle");
    const middle = await readState(page);
    ck.check("中间位置两枚滚动钮均可用且双向渐隐",
      middle.leftDisabled === false && middle.rightDisabled === false
      && middle.canLeft === "true" && middle.canRight === "true" && middle.mask.includes("gradient"), JSON.stringify(middle));
    ck.check("最右 → 中间标签流宽度不变", Math.abs(middle.width - right.width) <= 1, `${right.width} → ${middle.width}`);

    await scrollTo(page, "left");
    const left = await readState(page);
    ck.check("最左端双钮仍在且左钮禁用、右钮可用",
      left.leftExists && left.rightExists && left.leftDisabled === true && left.rightDisabled === false, JSON.stringify(left));
    ck.check("最左端只保留右侧渐隐", left.canLeft === "false" && left.canRight === "true" && left.mask.includes("gradient"), JSON.stringify(left));
    ck.check("中间 → 最左标签流宽度仍不变", Math.abs(left.width - middle.width) <= 1, `${middle.width} → ${left.width}`);

    await page.getByRole("button", { name: "向右滚动标签", exact: true }).click();
    await page.waitForTimeout(900);
    const moved = await readState(page);
    ck.check("最左端点击右钮仍能实际滚动", moved.scrollLeft > 20, `scrollLeft=${moved.scrollLeft}`);
    ck.check("点击滚动后双钮不卸载、宽度不跳",
      moved.leftExists && moved.rightExists && Math.abs(moved.width - left.width) <= 1, JSON.stringify(moved));
  },
};
