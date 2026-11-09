// 终端滚轮合帧（tmux / 全屏 TUI 的鼠标上报路径）。
//
// tmux attach、Claude Code 等全屏程序会开启 xterm 鼠标上报（1000/1006）。此时
// 每个滚轮事件由 xterm 编码成一条 SGR 报文（`ESC[<64;x;yM`）直接
// `triggerDataEvent`：一次 onData → 一次面板 IPC → 一次写 PTY。macOS 触摸板
// （含松手后的惯性）在几十毫秒里会连发多枚报文，远端 tmux copy-mode 每收到一枚
// 就滚 3 行并重绘整屏——报文一密集，滚动就发顿、远端渲染也跟不上。
//
// 这里按固定时间窗（24ms ≈ 40Hz）合并滚轮报文：同一窗口内的报文仍逐条交给
// xterm 编码（顺序、条数、每条的坐标都不变），只把结果拼成一个数据事件发出，
// 让 tmux 一次读入、一次重绘。点击/拖动/按键等非滚轮事件立即透传，不加延迟。
//
// 只适用于 SGR/X10 这类走 triggerDataEvent 的编码；DEFAULT 编码走
// triggerBinaryEvent，仍逐条发出（X10 滚轮场景很少）。主终端与 tmux 格子均接入。

/** 滚轮报文合并窗口：24ms≈40Hz，满帧滚动时最多每 1.5 帧发一次。 */
const WHEEL_COALESCE_MS = 24;

/** xterm CoreMouseButton.WHEEL / CoreMouseAction.UP|DOWN（版本锁定 5.5.0）。 */
const MOUSE_BUTTON_WHEEL = 4;
const MOUSE_ACTION_UP = 0;
const MOUSE_ACTION_DOWN = 1;

type CoreMouseEventLike = { button: number; action: number };

type WheelBatchCore = {
  coreMouseService?: {
    triggerMouseEvent?: (e: CoreMouseEventLike) => boolean;
    [PATCHED]?: true;
  };
  coreService?: {
    triggerDataEvent?: (data: string, wasUserInput?: boolean) => void;
  };
  /** flush 期间为 true：triggerDataEvent 只攒字符串，不发出去。 */
  [BATCHING]?: boolean;
  [BUFFER]?: string;
};

const PATCHED = Symbol.for("tinyssh.xterm-wheel-batch");
const BATCHING = Symbol.for("tinyssh.xterm-wheel-batch-active");
const BUFFER = Symbol.for("tinyssh.xterm-wheel-batch-buffer");

/**
 * 给 xterm 实例装滚轮合帧（幂等，按 core 实例装一次）。
 * 结构不匹配（xterm 升级改内部字段）时静默跳过，滚动行为回到原样。
 * 返回卸载函数（测试/销毁用），恢复原始方法并清掉未发出的报文。
 */
export function installWheelBatch(term: unknown): () => void {
  const core = (term as { _core?: WheelBatchCore })._core;
  const ms = core?.coreMouseService;
  const cs = core?.coreService;
  if (
    !core ||
    !ms ||
    typeof ms.triggerMouseEvent !== "function" ||
    !cs ||
    typeof cs.triggerDataEvent !== "function" ||
    ms[PATCHED]
  ) {
    return () => {};
  }
  const origTrigger = ms.triggerMouseEvent;
  const origSend = cs.triggerDataEvent;
  let pending: CoreMouseEventLike[] = [];
  let timer: ReturnType<typeof setTimeout> | null = null;

  const flush = () => {
    timer = null;
    if (!pending.length) return;
    const batch = pending;
    pending = [];
    core[BATCHING] = true;
    core[BUFFER] = "";
    try {
      for (const ev of batch) origTrigger.call(ms, ev);
    } finally {
      core[BATCHING] = false;
      const data = core[BUFFER] ?? "";
      core[BUFFER] = "";
      // 一次性发出：tmux 一次 read 收齐所有滚轮报文，只重绘一帧。
      if (data) origSend.call(cs, data, true);
    }
  };

  ms.triggerMouseEvent = function (this: unknown, e: CoreMouseEventLike) {
    if (e.button === MOUSE_BUTTON_WHEEL && (e.action === MOUSE_ACTION_UP || e.action === MOUSE_ACTION_DOWN)) {
      pending.push(e);
      if (timer === null) timer = setTimeout(flush, WHEEL_COALESCE_MS);
      // 调用方不关心滚轮的返回值（xterm 的 wheel 监听只做 cancel），先算已受理。
      return true;
    }
    // 非滚轮事件必须保持与已排队滚轮的先后顺序：先冲刷再透传。
    if (timer !== null) {
      clearTimeout(timer);
      flush();
    }
    return origTrigger.call(this, e);
  };

  cs.triggerDataEvent = function (this: unknown, data: string, wasUserInput?: boolean) {
    if (core[BATCHING]) {
      core[BUFFER] = (core[BUFFER] ?? "") + data;
      return;
    }
    return origSend.call(this, data, wasUserInput);
  };

  ms[PATCHED] = true;
  return () => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    pending = [];
    ms.triggerMouseEvent = origTrigger;
    cs.triggerDataEvent = origSend;
    delete ms[PATCHED];
  };
}
