// 101 macOS 单独按下 Cmd 偶发整页缩小：WKWebView 会把修饰键/触控板事件报告成
// metaKey + 非零 deltaY 的 wheel。旧 Ctrl 路径已因同类问题停用，Cmd 入口也收敛；
// 显式 Cmd±/0 与 Windows/Linux Ctrl+wheel 的既有语义不动。

module.exports = {
  title: "macOS Cmd 不触发滚轮缩放，显式键盘与其他平台缩放保留",
  async run({ page, ck }) {
    await page.evaluate(async () => { await import("/src/zoom.ts"); });

    const probe = (platform, init) => page.evaluate(async ({ platform, init }) => {
      const previousPlatform = Object.getOwnPropertyDescriptor(Navigator.prototype, "platform");
      const previousUaData = Object.getOwnPropertyDescriptor(Navigator.prototype, "userAgentData");
      Object.defineProperty(Navigator.prototype, "platform", { configurable: true, get: () => platform });
      Object.defineProperty(Navigator.prototype, "userAgentData", { configurable: true, get: () => undefined });
      try {
        const zoom = await import("/src/zoom.ts");
        const unregister = zoom.registerZoomHotkeys({
          isTauri: true, notify: () => {}, invoke: async () => undefined,
        });
        const ev = new WheelEvent("wheel", { ...init, bubbles: true, cancelable: true });
        window.dispatchEvent(ev);
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        unregister();
        return { level: zoom.currentZoom(), prevented: ev.defaultPrevented };
      } finally {
        if (previousPlatform) Object.defineProperty(Navigator.prototype, "platform", previousPlatform);
        if (previousUaData) Object.defineProperty(Navigator.prototype, "userAgentData", previousUaData);
      }
    }, { platform, init });

    // 先跑 mac：失败样本会在默认 100% 直接降档，不能再被后续用例的 reset 掩盖。
    for (const deltaY of [-12, 0.1, 120]) {
      const r = await probe("MacIntel", { metaKey: true, deltaY });
      ck.eq(`macOS metaKey wheel deltaY=${deltaY} 不改变缩放`, r.level, 1);
      ck.check(`macOS metaKey wheel deltaY=${deltaY} 不被应用吞掉`, !r.prevented);
    }
    const keyOnly = await probe("MacIntel", { metaKey: true, deltaY: 0 });
    ck.eq("macOS 零位移修饰键事件不改变缩放", keyOnly.level, 1);

    const down = await probe("Win32", { ctrlKey: true, deltaY: 120 });
    ck.eq("Windows/Linux Ctrl+wheel 仍缩小一档", down.level, 0.9);
    ck.check("Windows/Linux 已消费的缩放 wheel 仍阻止默认行为", down.prevented);
    const up = await probe("Win32", { ctrlKey: true, deltaY: -120 });
    ck.eq("Windows/Linux Ctrl+wheel 仍放大一档", up.level, 1);

    const keyboard = await page.evaluate(async () => {
      const { resolveAction } = await import("/src/actions.ts");
      const previous = Object.getOwnPropertyDescriptor(Navigator.prototype, "platform");
      Object.defineProperty(Navigator.prototype, "platform", { configurable: true, get: () => "MacIntel" });
      try {
        return ["=", "-", "0"].map((key) => resolveAction(new KeyboardEvent("keydown", { key, metaKey: true }), {
          modal: false, native: true, inForm: false, hasSessions: true, hasActiveTab: true,
        })?.id ?? null);
      } finally {
        if (previous) Object.defineProperty(Navigator.prototype, "platform", previous);
      }
    });
    ck.check("macOS Cmd + / - / 0 键盘缩放完整保留",
      JSON.stringify(keyboard) === JSON.stringify(["zoom-in", "zoom-out", "zoom-reset"]), JSON.stringify(keyboard));
  },
};
