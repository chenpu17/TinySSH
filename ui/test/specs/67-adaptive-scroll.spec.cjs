// 67 KI-004：终端滚动平滑度自适应 + 鼠标上报滚轮合帧。
// 精确触摸板给像素级连续小 delta，xterm 100ms 补间会逐事件重启、落后手指；
// 经典滚轮保留补间更顺。这里直接加载 dev 模块测量 installAdaptiveSmoothScroll
// 的档位切换，不依赖真实触摸板/SSH 会话。
// 合帧部分覆盖：伪 core 验证同窗拼批/非滚轮透传/卸载恢复；真实 xterm 开启
// SGR 上报后同帧连发 30 次滚轮，必须只产生一次 onData 且 18 条报文一条不少。

const connectHost = async (page, name) => {
  const card = await page.$(`.host-card:has(.host-name:text-is("${name}"))`);
  if (!card) throw new Error(`主机卡不在场：${name}`);
  await card.hover();
  await page.waitForTimeout(250);
  await (await card.$('button[title^="连接"]')).click();
  await page.waitForTimeout(1600);
};

module.exports = {
  title: "终端滚动：触摸板直跟/滚轮补间 + 鼠标上报滚轮合帧",
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

    // ── 合帧：伪 core 验证批处理语义 ──
    const batch = await page.evaluate(async () => {
      const mod = await import("/src/terminal/wheel-batch.ts");
      const data = [];
      const core = {
        coreService: { triggerDataEvent(d) { data.push(d); } },
        coreMouseService: {
          calls: 0,
          triggerMouseEvent(e) {
            this.calls++;
            core.coreService.triggerDataEvent(`R${this.calls}`, true);
            return true;
          },
        },
      };
      const off = mod.installWheelBatch({ _core: core });
      const ev = (button, action) => ({ button, action, col: 0, row: 0 });
      core.coreMouseService.triggerMouseEvent(ev(4, 0)); // 滚轮上
      core.coreMouseService.triggerMouseEvent(ev(4, 0));
      core.coreMouseService.triggerMouseEvent(ev(4, 1)); // 滚轮下
      const beforeFlush = data.slice();
      core.coreMouseService.triggerMouseEvent(ev(0, 1)); // 左键：不得排队
      const afterClick = data.slice();
      await new Promise((resolve) => setTimeout(resolve, 60));
      const afterFlush = data.slice();
      off();
      core.coreMouseService.triggerMouseEvent(ev(4, 0));
      await new Promise((resolve) => setTimeout(resolve, 60));
      const afterOff = data.slice();
      return { beforeFlush, afterClick, afterFlush, afterOff };
    });
    ck.eq("滚轮报文先攒批、不同步发出", JSON.stringify(batch.beforeFlush), "[]");
    ck.eq("非滚轮事件先冲刷排队滚轮再透传（保序）",
      JSON.stringify(batch.afterClick), JSON.stringify(["R1R2R3", "R4"]));
    ck.eq("同一时间窗滚轮拼成一个数据事件（顺序不变）",
      JSON.stringify(batch.afterFlush), JSON.stringify(["R1R2R3", "R4"]));
    ck.eq("卸载后滚轮恢复逐条发出",
      JSON.stringify(batch.afterOff), JSON.stringify(["R1R2R3", "R4", "R5"]));

    // ── 合帧：用户输入必须排在排队滚轮之后（滚完马上打字不得乱序） ──
    const order = await page.evaluate(async () => {
      const mod = await import("/src/terminal/wheel-batch.ts");
      const data = [];
      const core = {
        coreService: { triggerDataEvent(d) { data.push(d); } },
        coreMouseService: {
          calls: 0,
          triggerMouseEvent(e) {
            this.calls++;
            core.coreService.triggerDataEvent(`W${this.calls}`, true);
            return true;
          },
        },
      };
      const off = mod.installWheelBatch({ _core: core });
      const ev = (button, action) => ({ button, action, col: 0, row: 0 });
      core.coreMouseService.triggerMouseEvent(ev(4, 0));
      core.coreMouseService.triggerMouseEvent(ev(4, 0));
      const queued = data.slice();
      core.coreService.triggerDataEvent("K", true); // 窗口内用户键入
      const afterKey = data.slice();
      await new Promise((resolve) => setTimeout(resolve, 60));
      const afterWait = data.slice();
      off();
      return { queued, afterKey, afterWait };
    });
    ck.eq("滚轮先攒批、不同步发出",
      JSON.stringify(order.queued), "[]");
    ck.eq("用户键入先冲刷排队滚轮再透传（保序）",
      JSON.stringify(order.afterKey), JSON.stringify(["W1W2", "K"]));
    ck.eq("冲刷后窗口内不再重复发送滚轮",
      JSON.stringify(order.afterWait), JSON.stringify(["W1W2", "K"]));

    // ── 合帧：真实 xterm（开启 SGR 上报）同帧 30 次滚轮 ──
    await connectHost(page, "本机");
    const real = await page.evaluate(async () => {
      const entry = [...window.__t_terms.entries()].find(([, t]) => {
        const el = t.element;
        return el && el.isConnected && el.getBoundingClientRect().height > 0;
      });
      if (!entry) throw new Error("看不见终端实例");
      const term = entry[1];
      const el = term.element;
      const events = [];
      const sub = term.onData((d) => events.push(d));
      term.write("\x1b[?1000h\x1b[?1006h"); // 模拟 tmux set -g mouse on
      await new Promise((resolve) => setTimeout(resolve, 60));
      events.length = 0;
      // 清掉视口滚轮余量，并按整行 delta 发：30 次滚轮 = 30 条报文，结果确定
      const rowHeight = term._core.viewport?._currentRowHeight ?? 20;
      term._core.viewport._wheelPartialScroll = 0;
      for (let i = 0; i < 30; i++) {
        el.dispatchEvent(new WheelEvent("wheel", {
          deltaY: -rowHeight, deltaMode: 0, clientX: 500, clientY: 300, bubbles: true, cancelable: true,
        }));
      }
      await new Promise((resolve) => setTimeout(resolve, 80));
      const out = {
        events: events.length,
        reports: (events.join("").match(/\x1b\[<64;/g) || []).length,
      };
      term.write("\x1b[?1000l\x1b[?1006l");
      sub.dispose();
      return out;
    });
    ck.eq("真实 xterm：同帧 30 次滚轮合并为一次数据事件", real.events, 1);
    ck.eq("合帧不丢报文（30 条 SGR 滚轮全部保留）", real.reports, 30);
  },
};
