// 67 KI-004：终端滚动平滑度自适应 + 鼠标上报滚轮节流。
// 精确触摸板给像素级连续小 delta，xterm 100ms 补间会逐事件重启、落后手指；
// 经典滚轮保留补间更顺。这里直接加载 dev 模块测量 installAdaptiveSmoothScroll
// 的档位切换，不依赖真实触摸板/SSH 会话。
// 滚轮部分覆盖：伪 core 验证排队/保序/卸载恢复/匀速与丢旧保新/运行中改档；
// 「跟随刷新率」实测间隔夹取；真实 xterm 开启 SGR 上报后同一任务连发 30 次滚轮，
// 只能匀速排空队列上限内的报文。

const connectHost = async (page, name) => {
  const card = await page.$(`.host-card:has(.host-name:text-is("${name}"))`);
  if (!card) throw new Error(`主机卡不在场：${name}`);
  await card.hover();
  await page.waitForTimeout(250);
  await (await card.$('button[title^="连接"]')).click();
  await page.waitForTimeout(1600);
};

module.exports = {
  title: "终端滚动：触摸板直跟/滚轮补间 + 鼠标上报滚轮节流",
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

    // ── 节流：伪 core 验证排队/保序语义 ──
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
    ck.eq("滚轮报文先排队、不同步发出", JSON.stringify(batch.beforeFlush), "[]");
    ck.eq("非滚轮事件先冲刷排队滚轮再透传（保序）",
      JSON.stringify(batch.afterClick), JSON.stringify(["R1R2R3", "R4"]));
    ck.eq("冲刷后不再重复发送排队滚轮",
      JSON.stringify(batch.afterFlush), JSON.stringify(["R1R2R3", "R4"]));
    ck.eq("卸载后滚轮恢复逐条发出",
      JSON.stringify(batch.afterOff), JSON.stringify(["R1R2R3", "R4", "R5"]));

    // ── 节流：用户输入必须排在排队滚轮之后（滚完马上打字不得乱序） ──
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
    ck.eq("滚轮先排队、不同步发出",
      JSON.stringify(order.queued), "[]");
    ck.eq("用户键入先冲刷排队滚轮再透传（保序）",
      JSON.stringify(order.afterKey), JSON.stringify(["W1W2", "K"]));
    ck.eq("冲刷后不再重复发送排队滚轮",
      JSON.stringify(order.afterWait), JSON.stringify(["W1W2", "K"]));

    // ── 节流：60Hz 匀速排空，甩动超出队列上限时丢旧保新 ──
    const paced = await page.evaluate(async () => {
      const mod = await import("/src/terminal/wheel-batch.ts");
      const data = [];
      const core = {
        coreService: { triggerDataEvent(d) { data.push(d); } },
        coreMouseService: {
          triggerMouseEvent(e) {
            // 事件自带序号：报文在发送时才编码，序号才能证明「丢旧保新」。
            core.coreService.triggerDataEvent(`R${e.id}`, true);
            return true;
          },
        },
      };
      const off = mod.installWheelBatch({ _core: core }, { intervalMs: 80, maxQueue: 4 });
      const ev = (id) => ({ button: 4, action: 0, id });
      for (let i = 1; i <= 10; i++) core.coreMouseService.triggerMouseEvent(ev(i));
      const sync = data.slice();
      await new Promise((resolve) => setTimeout(resolve, 50));
      const first = data.slice();
      await new Promise((resolve) => setTimeout(resolve, 400));
      const all = data.slice();
      off();
      return { sync, first, all };
    });
    ck.eq("滚轮报文不在同一任务内同步发出（交给匀速泵）",
      JSON.stringify(paced.sync), "[]");
    ck.eq("首条立即发出；甩动超出上限时丢最旧、保留最新方向",
      JSON.stringify(paced.first), JSON.stringify(["R7"]));
    ck.eq("队列按发送间隔匀速排空（4 条 = R7..R10）",
      JSON.stringify(paced.all), JSON.stringify(["R7", "R8", "R9", "R10"]));

    // ── 节流：间隔提供者可运行时改档（设置项），无需重装补丁 ──
    const adaptive = await page.evaluate(async () => {
      const mod = await import("/src/terminal/wheel-batch.ts");
      const data = [];
      let interval = 80;
      const core = {
        coreService: { triggerDataEvent(d) { data.push(d); } },
        coreMouseService: {
          triggerMouseEvent(e) { core.coreService.triggerDataEvent(`R${e.id}`, true); return true; },
        },
      };
      const off = mod.installWheelBatch({ _core: core }, { intervalMs: () => interval });
      for (let i = 1; i <= 5; i++) core.coreMouseService.triggerMouseEvent({ button: 4, action: 0, id: i });
      await new Promise((r) => setTimeout(r, 30));
      const slowPhase = data.slice();
      interval = 10; // 运行中改档（等价设置面板切到更高频率）
      await new Promise((r) => setTimeout(r, 200));
      const all = data.slice();
      off();
      return { slowPhase, all };
    });
    ck.eq("间隔提供者：首条立即发，80ms 档下 30ms 内只有 1 条",
      JSON.stringify(adaptive.slowPhase), JSON.stringify(["R1"]));
    ck.eq("间隔提供者：改档后按新间隔排空（200ms 内 5 条全部发出）",
      JSON.stringify(adaptive.all), JSON.stringify(["R1", "R2", "R3", "R4", "R5"]));

    // ── 跟随刷新率：rAF 实测帧间隔，夹在 30–120Hz（60Hz 环境≈16.7ms）──
    const refresh = await page.evaluate(async () => {
      const mod = await import("/src/terminal/wheel-batch.ts");
      const first = mod.displayIntervalMs();
      await new Promise((r) => setTimeout(r, 350));
      const measured = mod.displayIntervalMs();
      return { first, measured };
    });
    ck.check("跟随刷新率返回实测帧间隔（30–120Hz 夹取）",
      Number.isFinite(refresh.measured) && refresh.measured >= 1000 / 120 - 0.01 && refresh.measured <= 1000 / 30 + 0.01,
      JSON.stringify(refresh));

    // ── 节流：真实 xterm（开启 SGR 上报）同一任务 30 次滚轮 + 慢速 1:1 ──
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
      const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      term.write("\x1b[?1000h\x1b[?1006h"); // 模拟 tmux set -g mouse on
      await sleep(60);
      events.length = 0;
      // 清掉视口滚轮余量，并按行模式 delta 发：每次滚轮 = 1 条报文，结果确定。
      // xterm 6 会把 |deltaY|<50 的像素滚动当触控板打折 0.3，像素模式无法逐次对齐，
      // 行模式（DOM_DELTA_LINE）不折算、不折扣，两代语义一致。
      const core = term._core;
      const mouse = core.coreMouseService ?? core._mouseService;
      if (mouse) mouse._wheelPartialScroll = 0;
      else if (core.viewport) core.viewport._wheelPartialScroll = 0;
      const fire = () =>
        el.dispatchEvent(new WheelEvent("wheel", {
          deltaY: -1, deltaMode: 1, clientX: 500, clientY: 300, bubbles: true, cancelable: true,
        }));
      const reports = () => (events.join("").match(/\x1b\[<64;/g) || []).length;
      for (let i = 0; i < 30; i++) fire();
      const sync = reports();
      await sleep(60);
      const early = reports();
      await sleep(240);
      const burst = reports();
      // 慢速滚动（间隔远大于 16ms）：每次滚轮应立即 1:1 发出，不排队
      events.length = 0;
      const slow = [];
      for (let i = 0; i < 3; i++) {
        fire();
        await sleep(50);
        slow.push(reports());
      }
      term.write("\x1b[?1000l\x1b[?1006l");
      sub.dispose();
      return { sync, early, burst, slow };
    });
    ck.eq("真实 xterm：同一任务内连发滚轮不得同步写出", real.sync, 0);
    ck.eq("真实 xterm：节流泵已开始排空（60ms 内至少 1 条）", real.early >= 1, true);
    ck.eq("真实 xterm：甩动超出队列上限，只发最新 8 条", real.burst, 8);
    ck.eq("真实 xterm：慢速滚动仍逐条立即发出（1:1）",
      JSON.stringify(real.slow), JSON.stringify([1, 2, 3]));
  },
};
