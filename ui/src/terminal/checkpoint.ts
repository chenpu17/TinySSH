// C10 输出订阅恢复（R11）前端侧：检查点应用、seq 帧解析、订阅水位状态机。
// 契约见 docs/ux/ux-r1-g0/r03-contracts.md §C10（水位包含末事件、丢弃 seq ≤ 水位、
// 订阅身份绑定、pending 溢出走恢复不静默丢字）。
import type { Terminal } from "@xterm/xterm";
import { invoke } from "../adapter/bridge";
import { CELL_FLAGS } from "../adapter/wire";
import type { AttachOutput, CellRun, ColorSpec, ScreenCheckpoint, SeqFrame } from "../adapter/wire";

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/** 光标首选项（P0 终端品质轮）：检查点重放时的形状/闪烁取**应用侧偏好**——核心快照
 *  只存形状、不存 blink 位（alacritty shape-only），也无法区分「远端设过 DECSCUSR」
 *  与「从未设过」；重放若硬编码默认，会把用户设的光标样式在每次 attach 时冲回方块。
 *  远端 live 流的 DECSCUSR 仍会自然覆盖（运行期程序的即时意图优先于偏好）。 */
let cursorDefault: { style: "block" | "underline" | "bar"; blink: boolean } = { style: "block", blink: true };
export function setCursorDefault(style: "block" | "underline" | "bar", blink: boolean): void {
  cursorDefault = { style, blink };
}

/** CellRun 序列 → SGR 文本（每 run 前重置再上属性）。 */
function runsSgr(runs: CellRun[]): string {
  let out = "";
  for (const r of runs) {
    if (!r.text) continue;
    out += "\x1b[0m";
    const codes: string[] = [];
    const color = (spec: ColorSpec, isFg: boolean) => {
      if ("Indexed" in spec) {
        const n = spec.Indexed;
        if (n < 8) codes.push(`${(isFg ? 30 : 40) + n}`);
        else if (n < 16) codes.push(`${(isFg ? 90 : 100) + (n - 8)}`);
        else codes.push(`${isFg ? 38 : 48};5;${n}`);
      } else {
        const [r, g, b] = spec.Rgb;
        codes.push(`${isFg ? 38 : 48};2;${r};${g};${b}`);
      }
    };
    if (r.fg) color(r.fg, true);
    if (r.bg) color(r.bg, false);
    const f = r.flags;
    if (f & CELL_FLAGS.DOUBLE_UNDERLINE) codes.push("21");
    else if (f & CELL_FLAGS.UNDERLINE) codes.push("4");
    if (f & CELL_FLAGS.BOLD) codes.push("1");
    if (f & CELL_FLAGS.DIM) codes.push("2");
    if (f & CELL_FLAGS.ITALIC) codes.push("3");
    if (f & CELL_FLAGS.STRIKEOUT) codes.push("9");
    if (f & CELL_FLAGS.INVERSE) codes.push("7");
    if (f & CELL_FLAGS.HIDDEN) codes.push("8");
    if (codes.length) out += `\x1b[${codes.join(";")}m`;
    out += r.text;
  }
  return out;
}

/** 检查点 → xterm 状态重建（DF10.4）。主缓冲流式写（历史自然进 scrollback），
 *  备用缓冲逐行定位写；随后恢复模式/光标。
 *  先把 xterm 尺寸对齐检查点网格（rev-r11 发现 3）：网格按核心 cols 串行化，
 *  尺寸失配时流式写会按错误列宽换行错位；恢复后由 fit/尺寸对账机制回用户视口。 */
export function applyCheckpoint(term: Terminal, ck: ScreenCheckpoint): void {
  // 主缓冲裁尾（六轮 C6-1）：网格尾部空行是「核心屏比内容高」的垫行，照单全收
  // 会把光标钉在垫行——attach 链的 fit 缩行 reflow 把顶部内容推进 scrollback，
  // 而 checkpoint 自带的 CUP 是活动屏相对寻址，数据行沉入 scrollback 后物理够
  // 不到（ybase=9、光标 abs12、回显与提示符脱钩、敲一键整块卷出视口的毁损态）。
  // 裁到「最后非空行与光标行的较大者」：内容/光标语义原样保留，垫行不落
  // buffer——写入行数 ≤ 任何后续视口行数后，fit 的缩/扩只是空行增删，零毁损
  // （xterm 缩行语义实测探针 ui/test/probe-c61-xterm.cjs 实验 C）。备用屏
  // （vim 等全屏 app）不裁：全屏语义逐行定位写依赖完整网格。
  const rawLines = ck.buffers[0].lines;
  let lines = rawLines;
  let rows = ck.rows;
  if (ck.active_buffer !== 1) {
    let last = rawLines.length - 1;
    const cy = clamp(ck.cursor.y, 0, Math.max(0, last));
    while (last > cy && !(rawLines[last]?.some((c) => c.text) ?? false)) last--;
    lines = rawLines.slice(0, last + 1);
    rows = Math.min(ck.rows, lines.length);
  }
  if (term.cols !== ck.cols || term.rows !== rows) {
    term.resize(ck.cols, rows);
  }
  const out: string[] = [];
  out.push("\x1b[!p"); // DECSTR 软复位（滚动区/原点/插入等回默认）
  out.push("\x1b[2J\x1b[3J"); // 清可视屏 + scrollback
  out.push("\x1b[?7l\x1b[?6l\x1b[H"); // 恢复期间关自动换行/原点，光标归位
  // 主缓冲（buffers[0]）：裁尾后的行流式写——行数 ≤ 屏行数时不触发 scrollback，
  // 写完光标自然贴在最后一行（CUP 再定位=同位幂等）
  out.push(lines.map(runsSgr).join("\r\n"));
  if (ck.active_buffer === 1) {
    out.push("\x1b[?1049h"); // 进备用屏（新清空），主缓冲原地保留
    const alt = ck.buffers[1].lines;
    for (let rIdx = 0; rIdx < Math.min(alt.length, ck.rows); rIdx++) {
      if (alt[rIdx].length === 0) continue;
      out.push(`\x1b[${rIdx + 1};1H${runsSgr(alt[rIdx])}`);
    }
  }
  out.push(ck.modes.autowrap ? "\x1b[?7h" : "\x1b[?7l");
  out.push(ck.modes.application_cursor ? "\x1b[?1h" : "\x1b[?1l");
  out.push(ck.modes.bracketed_paste ? "\x1b[?2004h" : "\x1b[?2004l");
  out.push(ck.modes.origin_mode ? "\x1b[?6h" : "\x1b[?6l");
  const x = clamp(ck.cursor.x, 0, Math.max(0, ck.cols - 1));
  const y = clamp(ck.cursor.y, 0, Math.max(0, ck.rows - 1));
  out.push(`\x1b[${y + 1};${x + 1}H`);
  out.push(ck.cursor.visible ? "\x1b[?25h" : "\x1b[?25l");
  // 光标形状/闪烁（P0 终端品质轮）：取应用侧偏好（见 setCursorDefault 注释）。
  // DECSCUSR：1/3/5 = 闪烁方块/下划线/竖线，2/4/6 = 稳定变体。
  const shape = cursorDefault.style === "underline" ? 3 : cursorDefault.style === "bar" ? 5 : 1;
  out.push(`\x1b[${shape + (cursorDefault.blink ? 0 : 1)} q`);
  term.write(out.join(""));
  term.scrollToBottom();
}

/** 通道帧 → (seq, payload)：8 字节 LE seq 帧头。
 *  纯算术拆分（禁用 |/<< 32 位运算——ToInt32 会在 seq ≥ 2³¹ 时产生负数，
 *  rev-r11 发现 2）。seq < 2^53 下 Number 精确。 */
export function parseSeqFrame(msg: Uint8Array): SeqFrame | null {
  if (msg.byteLength < 8) return null;
  const lo = msg[0] + msg[1] * 256 + msg[2] * 65536 + msg[3] * 16777216;
  const hi = msg[4] + msg[5] * 256 + msg[6] * 65536 + msg[7] * 16777216;
  return { seq: lo + hi * 4294967296, data: msg.subarray(8) };
}

export interface OutputFeed {
  /** 通道消息入口（MkChannel 的 onmessage 直连）。 */
  onMessage: (msg: unknown) => void;
  /** subscribe_output 返回后调用：应用检查点、定水位、冲暂存。 */
  begin: (attach: AttachOutput) => void;
  /** window "resync" 事件入口；旧订阅身份的事件被忽略（不影响新订阅）。 */
  onResyncEvent: (subscriptionId: string) => void;
  /** 显式退订（主清理路径）+ 停机。 */
  dispose: () => void;
  /** 背景合批节流（#22）：可见性变化时调用——若本订阅此刻可见，立即冲净积压输出，
   *  保证切回标签画面一字不差；不可见则不动（继续低频合批）。 */
  resume: () => void;
  readonly subscriptionId: () => string;
  readonly appliedSeq: () => number;
}

/** 背景合批节流器（#22）：不可见终端不逐帧写屏——逐帧写会让每个后台标签/格子持续
 *  解析+渲染（DOM 回填/WebGL 绘制），多标签齐刷输出时抢走可见终端的 CPU，滚动变卡。
 *  改为把输出攒成低频大批次（HOLD_MS 一次，或攒满 HOLD_CAP 立即冲，内存有界）；可见性
 *  恢复时 resume() 立即冲净，与逐帧直写逐字节等价（不丢、不乱序）。主终端 feed 与 tmux
 *  格子共用此单一真源。DEV 开关 __t_throttleOff 退回逐帧直写做 A/B 基线。 */
export interface OutputThrottle {
  write: (data: string | Uint8Array) => void;
  /** 可见性变化时调用：此刻可见则立即冲净积压。 */
  resume: () => void;
  /** 无条件冲净（收尾/等队列排空用，不看可见性）。 */
  flushNow: () => void;
  /** 丢弃积压（检查点取代旧屏时用）。 */
  clear: () => void;
  dispose: () => void;
}
export function createOutputThrottle(opts: { term: Terminal; isVisible?: () => boolean }): OutputThrottle {
  const { term } = opts;
  const isVisible = opts.isVisible ?? (() => true);
  const HOLD_MS = 500;
  const HOLD_CAP = 131072; // 字符/字节：超大爆发（构建日志）攒满即冲，避免无界积压
  let hold: Array<string | Uint8Array> = [];
  let holdSize = 0;
  let holdTimer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;
  const flushNow = () => {
    if (holdTimer) { clearTimeout(holdTimer); holdTimer = null; }
    if (hold.length) { const chunks = hold; hold = []; holdSize = 0; for (const c of chunks) term.write(c); }
  };
  const clear = () => { if (holdTimer) { clearTimeout(holdTimer); holdTimer = null; } hold = []; holdSize = 0; };
  return {
    write: (data) => {
      if (disposed) return;
      const off = import.meta.env.DEV && (window as unknown as { __t_throttleOff?: boolean }).__t_throttleOff;
      if (off || isVisible()) {
        if (hold.length) { hold.push(data); flushNow(); } // 先冲积压保序，再带上本帧
        else term.write(data);
      } else {
        hold.push(data);
        holdSize += typeof data === "string" ? data.length : data.byteLength;
        if (holdSize >= HOLD_CAP) { flushNow(); return; }
        if (!holdTimer) holdTimer = setTimeout(flushNow, HOLD_MS);
      }
    },
    resume: () => { if (!disposed && isVisible()) flushNow(); },
    flushNow,
    clear,
    dispose: () => { disposed = true; clear(); },
  };
}

export function createOutputFeed(opts: {
  term: Terminal;
  sid: string;
  pendingCap?: number;
  /** 可见性谓词（#22 背景节流）：读 live 焦点/分组。缺省恒可见（不节流）。 */
  isVisible?: () => boolean;
}): OutputFeed {
  const { term, sid } = opts;
  const cap = opts.pendingCap ?? 4096;
  const throttle = createOutputThrottle({ term, isVisible: opts.isVisible });
  let subId = "";
  let lastApplied = 0;
  let ready = false;
  let resyncing = false;
  let disposed = false;
  let decoder = new TextDecoder();
  let pending: SeqFrame[] = [];

  const apply = (f: SeqFrame) => {
    const text = decoder.decode(f.data, { stream: true });
    lastApplied = f.seq;
    throttle.write(text);
  };

  const drain = () => {
    // 游标推进 + 一次性 splice 出队：shift 每次整体前移，积压 N 帧时是 O(N²)
    // （大输出爆发 + 检查点未就绪的窗口里正是这种形态）。
    let n = 0;
    while (n < pending.length) {
      const f = pending[n];
      if (f.seq <= lastApplied) {
        n++;
        continue;
      }
      if (f.seq === lastApplied + 1) {
        n++;
        apply(f);
        continue;
      }
      break; // 缺口：交给 resync，不跨缺口推进
    }
    if (n > 0) pending.splice(0, n);
    if (pending.length > 0 && pending[0].seq > lastApplied + 1) void requestResync(false);
  };

  const requestResync = async (escalated: boolean) => {
    if (resyncing || !subId || disposed) return;
    resyncing = true;
    const before = lastApplied;
    try {
      // 每订阅仅一个恢复请求在途；期间 live 帧照常入 pending（先缓存）
      const fromSeq = ready && lastApplied > 0 && !escalated ? lastApplied : null;
      const r = await invoke("resync_output", { sid, subscriptionId: subId, fromSeq });
      if (r.kind === "replayed") {
        for (const ev of r.events) {
          if (ev.seq <= lastApplied) continue;
          if (ev.seq !== lastApplied + 1) break;
          apply(ev);
        }
      } else {
        applyCheckpoint(term, r.checkpoint);
        decoder = new TextDecoder(); // 检查点替换是解码流状态断点
        lastApplied = r.end_seq;
        throttle.clear(); // 检查点取代旧屏：积压的术前输出作废，不得再冲（会叠在已重建的屏上）
      }
    } catch {
      // 会话已关/订阅过期：收尾路径会清理，此处不再重试
    }
    resyncing = false;
    if (disposed) return; // 响应返回前已退订：不向已 dispose 的 term 写
    if (lastApplied === before && pending.length > 0 && pending[0].seq > lastApplied + 1) {
      // 无进展且缺口仍在：升级为检查点请求（一次性，避免同水位死循环）
      void requestResync(true);
      return;
    }
    drain();
  };

  return {
    onMessage: (msg) => {
      if (disposed) return;
      const u8 =
        msg instanceof Uint8Array ? msg : msg instanceof ArrayBuffer ? new Uint8Array(msg) : null;
      if (!u8) return;
      const f = parseSeqFrame(u8);
      if (!f) return;
      if (f.seq <= lastApplied) return; // 重复/旧帧丢弃（seq ≤ 水位）
      if (pending.length >= cap) return; // 溢出：不入暂存即成缺口 → gap 触发 resync，不静默丢字
      pending.push(f);
      if (ready) drain();
      // 未 ready：检查点应用前的早到帧只缓存（契约：注册起缓存 live）
    },
    begin: (attach) => {
      if (disposed) return;
      subId = attach.subscription_id;
      applyCheckpoint(term, attach.checkpoint);
      decoder = new TextDecoder();
      lastApplied = attach.start_seq;
      ready = true;
      drain();
    },
    onResyncEvent: (subscriptionId) => {
      if (subscriptionId !== subId || disposed) return;
      void requestResync(false);
    },
    dispose: () => {
      if (disposed) return;
      disposed = true;
      pending = [];
      throttle.dispose();
      if (subId) void invoke("unsubscribe_output", { sid, subscriptionId: subId }).catch(() => {});
    },
    resume: () => {
      if (!disposed) throttle.resume();
    },
    subscriptionId: () => subId,
    appliedSeq: () => lastApplied,
  };
}
