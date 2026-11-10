// 终端滚轮节流（tmux / 全屏 TUI 的鼠标上报路径）。
//
// tmux attach、Claude Code 等全屏程序会开启 xterm 鼠标上报（1000/1006）。此时
// 每个滚轮事件先经 `consumeWheelEvent` 按像素累积折算成「行」，再编码成一条
// SGR 报文（`ESC[<64;x;yM`）直接 `triggerDataEvent`：一次 onData → 一次面板
// IPC → 一次写 PTY。远端 tmux 每收到一条就滚固定行数（wheel 绑定默认 3~5 行）
// 并重绘；报文越密，远端越忙、屏幕滞后越深。macOS 触摸板惯性甩动峰值可达
// 100+ 条/秒，远超 60Hz 显示刷新——多出来的报文只会让远端排队重绘，视觉上
// 反而更顿（KI-004：对话轮次多、每行 SGR 更密时尤其明显）。
//
// 这里改成**匀速发送**：报文按到达顺序排队，每 `interval` 最多发一条（默认
// 16ms≈60Hz，与显示同拍；设置 → 终端里可选 30/60/90/120 次/秒或跟随显示刷新率），
// 首条立即发（慢速滚轮/单击滚轮零延迟），稳态下每条报文独占一帧。
// 甩动时队列超过 MAX_QUEUE 就丢最旧的——保留用户最新的方向与位置（反向甩动
// 也能及时生效），滞后上限约 128ms，停手后队列自然排空。点击/拖动/按键等
// 非滚轮事件立即冲刷全部排队报文再透传，顺序不变。
//
// 频率上限由「远端能消化多少」决定，不是本地渲染节拍：每条报文远端都要滚固定
// 3~5 行并重绘，频率翻倍就是远端工作量翻倍。默认 60 是保守值；本机/局域网 tmux
// 可调高，「跟随显示刷新率」按 rAF 实测帧间隔（夹在 30–120Hz），高刷屏上略更跟手。
//
// 不用「每 24ms 把窗口内所有报文拼成一次写入」：那只是减少 read/IPC 次数，
// 远端仍要逐条滚、逐条重绘，甩动时的总工作量并没下降；限速才能把远端从
// 「永远追赶」里拉出来。DEFAULT 编码走 triggerBinaryEvent，不在本补丁范围
// （X10 滚轮场景很少）。主终端与 tmux 格子均接入。

/** 滚轮报文默认发送间隔：16ms≈60Hz，与显示刷新同拍（设置可覆盖）。 */
const WHEEL_INTERVAL_MS = 16;

/** 排队上限：8 条≈128ms 的滞后。超出丢最旧，保证甩动时画面仍在跟手。 */
const WHEEL_MAX_QUEUE = 8;

/** 「跟随刷新率」的实测夹取范围：低于 30Hz 不跟（省远端也省得发得太稀），
 *  高于 120Hz 封顶（再高的显示刷新对远端 copy-mode 只是无效重绘）。 */
const REFRESH_HZ_MIN = 30;
const REFRESH_HZ_MAX = 120;
const REFRESH_HZ_DEFAULT = 60;
/** 一次测量取 10 帧（60Hz≈167ms）；5s 内不重复测量，显示器切换后最迟一轮生效。 */
const REFRESH_SAMPLES = 10;
const REFRESH_REMEASURE_MS = 5000;

let refreshHz = REFRESH_HZ_DEFAULT;
let refreshMeasuredAt = 0;
let refreshMeasuring = false;

/** 用 rAF 中线帧间隔实测显示刷新率；测量期间继续用上一次结果（首次为 60Hz）。 */
function measureRefresh(): void {
  if (refreshMeasuring || typeof requestAnimationFrame !== "function") return;
  const now = performance.now();
  if (now - refreshMeasuredAt < REFRESH_REMEASURE_MS) return;
  refreshMeasuring = true;
  refreshMeasuredAt = now; // 先记时刻：页面隐藏时 rAF 暂停，也不会每次调用都重开一轮
  const times: number[] = [];
  const tick = (ts: number) => {
    times.push(ts);
    if (times.length < REFRESH_SAMPLES) {
      requestAnimationFrame(tick);
      return;
    }
    refreshMeasuring = false;
    const deltas: number[] = [];
    for (let i = 1; i < times.length; i++) deltas.push(times[i] - times[i - 1]);
    deltas.sort((a, b) => a - b);
    const median = deltas[deltas.length >> 1];
    if (median > 0) {
      refreshHz = Math.min(REFRESH_HZ_MAX, Math.max(REFRESH_HZ_MIN, 1000 / median));
    }
  };
  requestAnimationFrame(tick);
}

/**
 * 「跟随刷新率」档的报文间隔（ms）：实测显示刷新率换算，夹在 30–120Hz。
 * 无 rAF（Node/测试桩）或页面隐藏时停在 60Hz 默认值。
 */
export function displayIntervalMs(): number {
  measureRefresh();
  return 1000 / refreshHz;
}

/** xterm CoreMouseButton.WHEEL / CoreMouseAction.UP|DOWN（5.5 与 6.0 取值一致）。 */
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

export interface WheelBatchOptions {
  /** 报文最小发送间隔（ms）；传函数则每次调度时读取（设置改档即时生效）。 */
  intervalMs?: number | (() => number);
  /** 排队上限（测试用）；默认 8 条。 */
  maxQueue?: number;
}

/**
 * 给 xterm 实例装滚轮节流（幂等，按 core 实例装一次）。
 * 结构不匹配（xterm 升级改内部字段）时静默跳过，滚动行为回到原样。
 * 返回卸载函数（测试/销毁用），恢复原始方法并清掉未发出的报文。
 */
export function installWheelBatch(term: unknown, opts: WheelBatchOptions = {}): () => void {
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
  // 每次调度都重新取间隔：设置里改档（含「跟随刷新率」实测值变化）无需重装。
  const resolveInterval = () => {
    const v = typeof opts.intervalMs === "function" ? opts.intervalMs() : (opts.intervalMs ?? WHEEL_INTERVAL_MS);
    return Number.isFinite(v) ? Math.max(0, v) : WHEEL_INTERVAL_MS;
  };
  const maxQueue = Math.max(1, opts.maxQueue ?? WHEEL_MAX_QUEUE);

  let pending: CoreMouseEventLike[] = [];
  let timer: ReturnType<typeof setTimeout> | null = null;
  let lastSend = 0;

  const clearTimer = () => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };

  /** 把一批报文交给 xterm 编码，拼成一个数据事件发出（顺序不变）。 */
  const sendBatch = (batch: CoreMouseEventLike[]) => {
    if (!batch.length) return;
    core[BATCHING] = true;
    core[BUFFER] = "";
    try {
      for (const ev of batch) origTrigger.call(ms, ev);
    } finally {
      core[BATCHING] = false;
      const data = core[BUFFER] ?? "";
      core[BUFFER] = "";
      if (data) origSend.call(cs, data, true);
    }
  };

  /** 立即发出全部排队报文（非滚轮事件/用户输入前的保序冲刷）。 */
  const flush = () => {
    clearTimer();
    if (!pending.length) return;
    const batch = pending;
    pending = [];
    lastSend = performance.now();
    sendBatch(batch);
  };

  /** 每条报文独占一个发送间隔；首条（队列空闲时）立即发。 */
  const pump = () => {
    timer = null;
    if (!pending.length) return;
    const now = performance.now();
    const wait = resolveInterval() - (now - lastSend);
    if (wait > 0) {
      timer = setTimeout(pump, wait);
      return;
    }
    const one = pending.shift()!;
    lastSend = now;
    sendBatch([one]);
    if (pending.length) timer = setTimeout(pump, resolveInterval());
  };

  const enqueue = (ev: CoreMouseEventLike) => {
    pending.push(ev);
    // 甩动超出预算：丢最旧的一条，保留用户最新方向/位置，滞后有上限。
    if (pending.length > maxQueue) pending.shift();
    if (timer === null) timer = setTimeout(pump, 0);
  };

  ms.triggerMouseEvent = function (this: unknown, e: CoreMouseEventLike) {
    if (e.button === MOUSE_BUTTON_WHEEL && (e.action === MOUSE_ACTION_UP || e.action === MOUSE_ACTION_DOWN)) {
      enqueue(e);
      // 调用方不关心滚轮的返回值（xterm 的 wheel 监听只做 cancel），先算已受理。
      return true;
    }
    // 非滚轮事件必须保持与已排队滚轮的先后顺序：先冲刷再透传。
    flush();
    return origTrigger.call(this, e);
  };

  cs.triggerDataEvent = function (this: unknown, data: string, wasUserInput?: boolean) {
    if (core[BATCHING]) {
      core[BUFFER] = (core[BUFFER] ?? "") + data;
      return;
    }
    // 用户输入（键入/粘贴）必须排在已排队的滚轮之后：否则「滚一下马上打字」时
    // 按键先到远端——tmux 复制模式里按键先退出、滞后的滚轮报文又把它拉回去。
    // 非用户输入的数据（终端应答等）不强制冲刷，避免无谓的排空。
    if (wasUserInput) flush();
    return origSend.call(this, data, wasUserInput);
  };

  ms[PATCHED] = true;
  return () => {
    clearTimer();
    pending = [];
    ms.triggerMouseEvent = origTrigger;
    cs.triggerDataEvent = origSend;
    delete ms[PATCHED];
  };
}
