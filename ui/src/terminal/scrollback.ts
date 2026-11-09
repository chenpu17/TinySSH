/** 终端回滚缓冲的纯判定（主终端专用）：
 *  - `scrollBelow`：普通屏里视口下方还有多少行（= baseY - viewportY），供「回到底部」浮钮；
 *  - `isScrollbackFull`：normal buffer 的 baseY 已触到 options.scrollback——更早的输出被
 *    丢弃，是「回滚已满」提示的唯一判据。
 * tmux 格子的视口由远端接管（copy-mode 时本地 xterm 不滚），不参与这两个提示。 */
import type { Terminal } from "@xterm/xterm";

export function scrollBelow(term: Terminal): number {
  const b = term.buffer.active;
  if (b.type !== "normal") return 0;
  return Math.max(0, b.baseY - b.viewportY);
}

export function isScrollbackFull(term: Terminal): boolean {
  const b = term.buffer.active;
  const cap = term.options.scrollback ?? 0;
  return b.type === "normal" && cap > 0 && b.baseY >= cap;
}
