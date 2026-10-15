// 29 双标题栏重设计（本轮）：Windows 自绘窗口控件只属于原生壳域。
// 浏览器 demo 无原生窗口——控件不得渲染（getCurrentWindow 调用只会静默失败），
// native-win 类不得添加（否则右缘 0 内边距的样式就位却无控件，视觉半吊子）。
// 原生域的真实性（点击行为/最大化态）由真机验收覆盖（PrintWindow 截图+无障碍树）。
module.exports = {
  title: "双标题栏：demo 域无自绘窗口控件、无 native-win 类",
  async run({ page, ck }) {
    await page.waitForSelector(".titlebar", { timeout: 6000 });
    const hasControls = await page.evaluate(
      () => !!document.querySelector('[data-testid="win-controls"]'),
    );
    ck.check("demo 无自绘窗口控件", !hasControls, String(hasControls));
    const hasWinCls = await page.evaluate(() =>
      document.documentElement.classList.contains("native-win"),
    );
    ck.check("demo 无 native-win 类", !hasWinCls, String(hasWinCls));
    const hasChromeCls = await page.evaluate(() =>
      document.documentElement.classList.contains("native-chrome"),
    );
    ck.check("demo 无 native-chrome 类", !hasChromeCls, String(hasChromeCls));
    // 标题行仍是 44px 拖拽区（两平台共用布局契约，p6 探针同款断言）
    const h = await page.evaluate(
      () => document.querySelector(".titlebar")?.getBoundingClientRect().height ?? 0,
    );
    ck.check("标题行高 44 不变", Math.abs(h - 44) <= 1, String(h));
  },
};
