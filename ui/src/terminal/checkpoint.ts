// C10 输出订阅恢复（R11）前端侧：检查点应用、seq 帧解析、订阅水位状态机。
// 契约见 docs/ux/ux-r1-g0/r03-contracts.md §C10（水位包含末事件、丢弃 seq ≤ 水位、
// 订阅身份绑定、pending 溢出走恢复不静默丢字）。
import type { Terminal } from "@xterm/xterm";
import { invoke } from "../adapter/bridge";
import { CELL_FLAGS } from "../adapter/wire";
import type { AttachOutput, CellRun, ColorSpec, ScreenCheckpoint, SeqFrame } from "../adapter/wire";

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

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
  if (term.cols !== ck.cols || term.rows !== ck.rows) {
    term.resize(ck.cols, ck.rows);
  }
  const out: string[] = [];
  out.push("\x1b[!p"); // DECSTR 软复位（滚动区/原点/插入等回默认）
  out.push("\x1b[2J\x1b[3J"); // 清可视屏 + scrollback
  out.push("\x1b[?7l\x1b[?6l\x1b[H"); // 恢复期间关自动换行/原点，光标归位
  // 主缓冲（buffers[0]）：全网格行流式写——写满一屏后早期行自然滚入 scrollback
  out.push(ck.buffers[0].lines.map(runsSgr).join("\r\n"));
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
  // blink 变体（vis-r11 R1）：steady 变体会把 xterm cursorBlink 置 false——恢复后
  // 光标永久停闪，用户可见回归。核心侧不存 blink 位（alacritty shape-only），
  // 取 makeTerm 的 blink 默认观感；远端 DECSCUSR 经 live 流随后自然覆盖。
  const styleCode = ck.cursor.style === "underline" ? 3 : ck.cursor.style === "beam" ? 5 : 1;
  out.push(`\x1b[${styleCode} q`);
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
  readonly subscriptionId: () => string;
  readonly appliedSeq: () => number;
}

export function createOutputFeed(opts: {
  term: Terminal;
  sid: string;
  pendingCap?: number;
}): OutputFeed {
  const { term, sid } = opts;
  const cap = opts.pendingCap ?? 4096;
  let subId = "";
  let lastApplied = 0;
  let ready = false;
  let resyncing = false;
  let disposed = false;
  let decoder = new TextDecoder();
  let pending: SeqFrame[] = [];

  const apply = (f: SeqFrame) => {
    term.write(decoder.decode(f.data, { stream: true }));
    lastApplied = f.seq;
  };

  const drain = () => {
    while (pending.length > 0) {
      const f = pending[0];
      if (f.seq <= lastApplied) {
        pending.shift();
        continue;
      }
      if (f.seq === lastApplied + 1) {
        pending.shift();
        apply(f);
        continue;
      }
      break; // 缺口：交给 resync，不跨缺口推进
    }
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
      if (subId) void invoke("unsubscribe_output", { sid, subscriptionId: subId }).catch(() => {});
    },
    subscriptionId: () => subId,
    appliedSeq: () => lastApplied,
  };
}
