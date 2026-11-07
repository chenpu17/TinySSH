// 从 DOM 焦点推导 note_terminal 的 sid/paneId。
//
// native Ctrl 接管（macOS）据此决定控制字符投给主会话还是 tmux 格子：
// 格子内的 xterm textarea → 该格的 sid/paneId；主视图或其它元素 → 当前活动
// 会话、paneId=null。抽成纯函数是为了让「关闭模态后按实际焦点补报」和
// 「focusin 上报」共用同一口径，避免某条路径漏掉 paneId 把 Ctrl+C 打回主视图。
export type TerminalFocusTarget = {
  sid: string | null;
  paneId: number | null;
};

export function terminalFocusTarget(el: Element | null, fallbackSid: string | null): TerminalFocusTarget {
  const cell = (el as HTMLElement | null)?.closest?.(".tmux-cell") as HTMLElement | null;
  if (!cell?.dataset.sid) return { sid: fallbackSid, paneId: null };
  const raw = cell.dataset.paneId;
  const paneId = raw != null && raw !== "" ? Number(raw) : NaN;
  return { sid: cell.dataset.sid, paneId: Number.isFinite(paneId) ? paneId : null };
}
