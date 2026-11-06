// 触摸板/鼠标悬停防护。
//
// 背景：远端应用（TUI、tmux 插件等）可能开启 xterm 的 any-motion 鼠标模式
// （DECSET 1003）。开启后，触摸板只要移动就会产生无按键的 SGR 移动报告
// `ESC[<35;x;yM`；若应用已退出而模式未复位，这些报告会经 `term.onData`
// 原样 `send_keys` 到 shell，被 PTY 回显成满屏 `35;77;14M`。
//
// 处理：只丢弃“移动 + 无按键 + 非滚轮”的 SGR 报告，保留点击/拖动/滚轮，
// 因此 TUI 的正常鼠标操作不受影响；确实需要 hover 的应用会失去 hover，
// 这是为“提示符下触摸板不得产生输入”做的定向取舍。

const SGR_MOUSE = /\x1b\[<(\d+);\d+;\d+[Mm]/g;

/** 是否为“无按键的移动报告”（SGR Cb 低两位=3 表示无按键，bit5=移动，bit6=滚轮）。 */
export function isMotionOnlyMouseReport(cb: number): boolean {
  const motion = (cb & 32) !== 0;
  const wheel = (cb & 64) !== 0;
  // bit7=128 是扩展按键（AUX4/AUX8）；其低两位也可能是 3，不能当作无按键。
  const noButton = (cb & 3) === 3 && (cb & 128) === 0;
  return motion && !wheel && noButton;
}

/**
 * 从 xterm onData 的原始输入中剔除无按键移动报告。
 * 不匹配的内容原样返回；没有 SGR 序列时零分配快速返回。
 */
export function stripMotionOnlyMouseReports(data: string): string {
  if (!data.includes("\x1b[<")) return data;
  return data.replace(SGR_MOUSE, (seq, cbStr: string) =>
    isMotionOnlyMouseReport(Number(cbStr)) ? "" : seq,
  );
}
