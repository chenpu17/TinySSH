// 67 KI-004：终端滚动平滑度自适应。
// 精确触摸板给像素级连续小 delta，xterm 100ms 补间会逐事件重启、落后手指；
// 经典滚轮保留补间更顺。这里直接加载 dev 模块测量 installAdaptiveSmoothScroll
// 的档位切换，不依赖真实触摸板/SSH 会话。

module.exports = {
  title: "终端滚动：触摸板小 delta 直跟、经典滚轮保留补间",
  async run({ page, ck }) {
    const r = await page.evaluate(async () => {
      const mod = await import("/src/terminal/scroll.ts");
      const el = document.createElement("div");
      document.body.appendChild(el);
      const term = { options: { smoothScrollDuration: 100 } };
      const off = mod.installAdaptiveSmoothScroll(term, el, 100);
      const wheel = (deltaY, deltaMode = WheelEvent.DOM_DELTA_PIXEL) =>
        el.dispatchEvent(
          new WheelEvent("wheel", { deltaY, deltaMode, bubbles: true, cancelable: true }),
        );

      const out = {};
      wheel(3);
      out.fine = term.options.smoothScrollDuration;
      wheel(100);
      out.coarse = term.options.smoothScrollDuration;
      wheel(3);
      out.fineAgain = term.options.smoothScrollDuration;
      // 先切回补间档，再卸载监听：后续小 delta 不得再改写选项
      wheel(100);
      off();
      wheel(3);
      out.afterOff = term.options.smoothScrollDuration;
      el.remove();
      return out;
    });
    ck.eq("触摸板小像素 delta → 0（1:1 直跟）", r.fine, 0);
    ck.eq("经典滚轮 delta 100 → 保留 100ms 补间", r.coarse, 100);
    ck.eq("再次触摸板 → 回到 0", r.fineAgain, 0);
    ck.eq("卸载监听后不再改写选项", r.afterOff, 100);
  },
};
