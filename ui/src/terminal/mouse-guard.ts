// 触摸板/鼠标悬停防护。
//
// 背景：远端应用（TUI、tmux 插件等）可能开启 xterm 的 any-motion 鼠标模式
// （DECSET 1003）。开启后，触摸板只要移动就会产生无按键的移动报告；若应用
// 已退出而模式未复位（崩溃/被 kill/只发 1049l 不发 1003l），这些报告会经
// `term.onData` 原样 `send_keys` 到 shell，被 PTY 回显成满屏 `35;77;14M`。
//
// xterm 5.5 只支持两种报文编码，都要覆盖（此前只认 SGR，只开 1003 不开 1006
// 时仍是默认 X10 编码，移动报告会漏成乱码）：
//   SGR（1006）：ESC[<Cb;Cx;CyM/m
//   X10（1000-1003 默认）：ESC[M + (Cb+32)(Cx+32)(Cy+32)
// （1005/1015 编码 xterm 明确不支持，不会产生，故不解析。）
//
// 处理：只丢弃“移动 + 无按键 + 非滚轮”的报告，保留点击/拖动/滚轮，
// 因此 TUI 的正常鼠标操作不受影响；确实需要 hover 的应用会失去 hover，
// 这是为“提示符下触摸板不得产生输入”做的定向取舍。

const SGR_MOUSE = /\x1b\[<(\d+);\d+;\d+[Mm]/g;
const X10_MOUSE = /\x1b\[M([\x20-\xff])([\x20-\xff])([\x20-\xff])/g;

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
 * 不匹配的内容原样返回；没有鼠标报文时零分配快速返回。
 */
export function stripMotionOnlyMouseReports(data: string): string {
  if (!data.includes("\x1b[")) return data;
  let out = data.replace(SGR_MOUSE, (seq, cbStr: string) =>
    isMotionOnlyMouseReport(Number(cbStr)) ? "" : seq,
  );
  // X10 固定三字节且自带 ESC[M 前缀，不会与普通输入序列混淆。
  if (out.includes("\x1b[M")) {
    out = out.replace(X10_MOUSE, (seq, b: string) =>
      isMotionOnlyMouseReport(b.charCodeAt(0) - 32) ? "" : seq,
    );
  }
  return out;
}
