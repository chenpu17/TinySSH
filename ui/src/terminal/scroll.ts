// 终端滚动平滑度自适应。
//
// xterm 的 smoothScrollDuration 是全局补间：Windows 经典滚轮逐格跳变，100ms
// 补间更顺；但精确触摸板给的是像素级连续小 delta，每个事件都重启补间，松手
// 后还会继续滑，反而落后手指（与 macOS 触控板同一问题）。
//
// 这里在 wheel 捕获阶段按 delta 形态切换：小像素 delta = 触摸板 → 0（1:1 直跟）；
// 其余（经典滚轮）→ 调用方给的补间时长。每终端独立，不影响其它会话。

import type { Terminal } from "@xterm/xterm";

/** 精确触摸板的单次 delta 通常远小于经典滚轮（Windows 常见 100）。 */
const FINE_DELTA = 48;

export function installAdaptiveSmoothScroll(
  term: Terminal,
  target: HTMLElement,
  wheelSmoothMs: number,
): () => void {
  if (wheelSmoothMs <= 0) return () => {};
  let current = wheelSmoothMs;
  const onWheel = (e: WheelEvent) => {
    const fine =
      e.deltaMode === WheelEvent.DOM_DELTA_PIXEL && Math.abs(e.deltaY) < FINE_DELTA;
    const want = fine ? 0 : wheelSmoothMs;
    if (want !== current) {
      current = want;
      term.options.smoothScrollDuration = want;
    }
  };
  target.addEventListener("wheel", onWheel, { capture: true, passive: true });
  return () => target.removeEventListener("wheel", onWheel, { capture: true });
}
