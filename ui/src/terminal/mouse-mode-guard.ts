// 远端鼠标上报模式残留防护（KI-001 补强）。
//
// xterm 只会在应用主动发送 DECRST 1000/1002/1003 时关闭鼠标上报。全屏 TUI
// （claude/htop/vim/tmux…）崩溃、被 kill、或退出时只发 1049l 不发 1003l，
// 上报协议就会留在 ANY/SGR：之后 shell 提示符下的移动/点击/拖动/滚轮仍被
// 编码成 ESC[<35;x;yM / 0;x;yM / 32;x;yM / 65;x;yM 送进 PTY，被 readline
// 回显成满屏 `35;22;4M` 一类乱码；滚轮也不再滚 scrollback，而是继续发报文
// （部分应用里表现为方向键/历史）。
//
// 这里在三个时机本地清掉上报协议（只改 xterm 状态，不向 PTY 写字节）：
// 1. DECRST 47/1047/1049（离开备用屏）——全屏 TUI 退出的通用信号；
// 2. OSC 133;A/D（shell 集成提示符出现/命令结束）——普通缓冲内 TUI 的兜底；
// 3. 终端右键「重置鼠标上报」——没有 shell 集成、且 TUI 未走备用屏时的手动出口。
//
// 只关协议、不动 SGR 编码：应用下次只开协议不重发 1006 时仍沿用既有编码，
// 与 xterm 原生行为保持一致。移动报告过滤仍由 mouse-guard.ts 兜底。

import type { Terminal } from "@xterm/xterm";

type MouseCore = {
  coreMouseService?: {
    activeProtocol: string;
  };
};

/** 关闭当前终端的鼠标上报协议；返回是否真的从“开着”切到“关闭”。 */
export function resetMouseReporting(term: Terminal): boolean {
  const core = (term as unknown as { _core?: MouseCore })._core;
  const ms = core?.coreMouseService;
  if (!ms || ms.activeProtocol === "NONE") return false;
  // 与 xterm DECRST 1003/1002/1000/9 同效：setter 会触发 onProtocolChange，
  // 解绑 wheel/mousemove 监听并清掉 .enable-mouse-events，滚轮随即回到
  // viewport 滚动，点击/拖动回到文本选择。私有面升级成只读时安全降级。
  try {
    ms.activeProtocol = "NONE";
  } catch {
    return false;
  }
  return true;
}

const guarded = new WeakSet<object>();

/**
 * 给终端装上自动复位（同一实例只装一次）。
 * 返回的清理函数在终端 dispose 前调用；parser 句柄随终端销毁也会释放。
 */
export function installMouseModeGuard(term: Terminal): () => void {
  if (guarded.has(term)) return () => {};
  guarded.add(term);
  const csi = term.parser.registerCsiHandler({ prefix: "?", final: "l" }, (params) => {
    // 只认离开备用屏的 47/1047/1049；返回 false 让 xterm 继续完成缓冲切换
    const leavesAlt = params.some(
      (p) => typeof p === "number" && (p === 47 || p === 1047 || p === 1049),
    );
    if (leavesAlt) resetMouseReporting(term);
    return false;
  });
  // 注意：47/1047/1049 也可能是 TUI 内部的临时切换；本复位要求应用回到备用屏
  // 时自行重发鼠标开启。vim/tmux/htop 等实测都会重发，故按“离开即复位”处理。
  const osc = term.parser.registerOscHandler(133, (data) => {
    // A=提示符开始，D=命令结束；TUI 退出后下一条标记到达即清理残留协议。
    // 只认普通缓冲：备用屏里的 OSC 133 可能来自会转发它的多路复用器/应用，
    // 此时关协议会误伤仍在运行的 TUI（tmux 自己消费 133，不会透传）。
    if (term.buffer.active.type === "normal" && (data.startsWith("A") || data.startsWith("D"))) {
      resetMouseReporting(term);
    }
    return false;
  });
  return () => {
    csi.dispose();
    osc.dispose();
    guarded.delete(term);
  };
}
