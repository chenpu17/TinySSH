// 移动端辅助键条（仅 Android/iOS 渲染）：手机软键盘没有 Esc/Tab/方向键，也没有
// 独立的 Ctrl——tmux 前缀（C-b）、TUI 导航、shell 补全（Tab）在手机上原本完全
// 不可达。Ctrl 是「粘滞键」：点一下进入待按态，下一次软键盘敲字母转成控制码
// （C-c/C-b/C-r…），或直接点条上的 C-b/C-c 按钮；再点一次取消。
//
// 两条纪律：
// 1. 按钮一律 pointerdown preventDefault——否则点击会把焦点从 xterm 的隐藏 textarea
//    拽走，软键盘立刻收起，辅助键也就失去了「接着打字」的意义。
// 2. 粘滞 Ctrl 只拦截「焦点确实在终端里」的单个字符键，弹窗/设置输入框里打字不受
//    影响；带物理修饰键的组合不接管（交给既有 Ctrl/⌥ 上报链）。
import { useEffect, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { t } from "../i18n";

/** 软键盘字符 → 控制码（VT100 口径）。字母之外只收终端里真会用的几个符号。 */
function controlCode(ch: string): string | null {
  if (/^[a-z]$/i.test(ch)) return String.fromCharCode(ch.toUpperCase().charCodeAt(0) - 64);
  switch (ch) {
    case " ": return "\x00";
    case "[": return "\x1b";
    case "\\": return "\x1c";
    case "]": return "\x1d";
    case "^": return "\x1e";
    case "_": return "\x1f";
    case "?": return "\x7f";
    default: return null;
  }
}

/** 点击后要保持软键盘（不抢终端焦点）。 */
const keepFocus = (ev: ReactPointerEvent) => ev.preventDefault();

export function MobileKeyBar({ onKey }: { onKey: (data: string) => void }) {
  const [ctrl, setCtrl] = useState(false);
  const ctrlRef = useRef(false);
  ctrlRef.current = ctrl;

  // 粘滞 Ctrl：只在前端焦点位于 xterm 隐藏 textarea 时改写字母键。xterm 的 textarea
  // 是终端唯一可聚焦元素（主视图与 tmux 格子同构），类名稳定为 .xterm-helper-textarea。
  useEffect(() => {
    const onKeyDown = (ev: KeyboardEvent) => {
      if (!ctrlRef.current) return;
      if (ev.ctrlKey || ev.metaKey || ev.altKey) return;
      if (ev.isComposing || ev.key.length !== 1) return;
      const ae = document.activeElement;
      if (!(ae instanceof HTMLTextAreaElement) || !ae.closest(".xterm")) return;
      const code = controlCode(ev.key);
      if (code == null) return;
      // capture 阶段拦下：不能让 xterm 再把原字符送一遍
      ev.preventDefault();
      ev.stopPropagation();
      onKey(code);
      setCtrl(false);
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [onKey]);

  const send = (data: string) => onKey(data);
  return (
    <div className="mobile-keys" data-testid="mobile-keys" role="toolbar" aria-label={t("终端辅助键")}>
      <button type="button" className="mk-btn" title={t("Esc")} aria-label={t("Esc")}
        onPointerDown={keepFocus} onClick={() => send("\x1b")}>Esc</button>
      <button type="button" className="mk-btn" title={t("Tab（shell 补全）")} aria-label={t("Tab")}
        onPointerDown={keepFocus} onClick={() => send("\t")}>Tab</button>
      <button type="button" className={"mk-btn" + (ctrl ? " ts-open" : "")} aria-pressed={ctrl}
        title={t("Ctrl 粘滞键：点亮后按一个字母即发送 Ctrl+字母（再点取消）")} aria-label={t("Ctrl 粘滞键")}
        onPointerDown={keepFocus} onClick={() => setCtrl((v) => !v)}>Ctrl</button>
      <button type="button" className="mk-btn" title={t("tmux 前缀（Ctrl-b）")} aria-label={t("Ctrl-b")}
        onPointerDown={keepFocus} onClick={() => send("\x02")}>C-b</button>
      <button type="button" className="mk-btn" title={t("Ctrl-c（中断当前命令）")} aria-label={t("Ctrl-c")}
        onPointerDown={keepFocus} onClick={() => send("\x03")}>C-c</button>
      <span className="mk-gap" aria-hidden="true" />
      <button type="button" className="mk-btn" title={t("上")} aria-label={t("上方向键")}
        onPointerDown={keepFocus} onClick={() => send("\x1b[A")}>↑</button>
      <button type="button" className="mk-btn" title={t("下")} aria-label={t("下方向键")}
        onPointerDown={keepFocus} onClick={() => send("\x1b[B")}>↓</button>
      <button type="button" className="mk-btn" title={t("左")} aria-label={t("左方向键")}
        onPointerDown={keepFocus} onClick={() => send("\x1b[D")}>←</button>
      <button type="button" className="mk-btn" title={t("右")} aria-label={t("右方向键")}
        onPointerDown={keepFocus} onClick={() => send("\x1b[C")}>→</button>
    </div>
  );
}
