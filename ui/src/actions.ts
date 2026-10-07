// R13 统一 action 分发（§7.2「同一个 action 分发源」）：应用快捷键只有这一份 keymap——
// window 捕获层与 xterm 自定义键处理器都经 resolveAction 解析、App 的 dispatch 执行，
// 消除双绑定重复执行。⌘, 归原生菜单加速器（NSMenu 先于 WebView 消费），此处刻意不绑。
// 传输层不在此列：Ctrl/Alt 控制字符编码、xterm onData 是终端输入路径，非应用动作。
export type AppAction =
  | { id: "search" }
  | { id: "font-up" }
  | { id: "font-down" }
  | { id: "font-reset" }
  | { id: "hostbar" }
  | { id: "settings" }
  | { id: "tab-switch"; index: number }
  | { id: "tab-cycle"; dir: 1 | -1 }
  | { id: "tab-close" }
  | { id: "esc" };

export interface ActionCtx {
  /** 模态层打开（确认/指纹/双因素）：一切 ⌘ 组合吞掉不执行，Esc 由浮层链处理 */
  modal: boolean;
  /** 原生环境（⌘W/⌘1–9/⌘⇧[] 是应用内标签语义，浏览器里是保留键不劫持） */
  native: boolean;
  /** 焦点在表单输入控件（INPUT/TEXTAREA/SELECT，终端 textarea 除外）——§7.4：⌘B 等表单编辑焦点下不劫持 */
  inForm: boolean;
  hasSessions: boolean;
  hasActiveTab: boolean;
}

/** keymap 唯一事实源：返回 null = 不归应用动作（透传给终端/浏览器）。 */
export function resolveAction(ev: KeyboardEvent, ctx: ActionCtx): AppAction | null {
  // IME 组合期（§7.3 输入约定）：isComposing 与 keyCode 229（合成器改写的 keydown）
  // 双查逐事件判定，无跨事件组合态跟踪
  if (ev.isComposing || ev.keyCode === 229) return null;
  // Esc 无条件归浮层链：模态期由 closeTopOverlay 关最上层（确认=取消、指纹=拒绝、
  // 双因素=取消认证）；无浮层时 dispatch 返回 false 原样透传（输入框/终端不受影响）
  if (ev.key === "Escape") return { id: "esc" };
  if (!ev.metaKey || ev.ctrlKey || ev.altKey) return null;
  // 模态层打开：任何 ⌘ 组合都不执行（§7.3 模态层不串输入）
  if (ctx.modal) return null;
  if (ev.shiftKey) {
    // ⇧] / ⇧[ 用物理键位判定（Shift 下 ev.key 是 }/{）
    if (ctx.native && ctx.hasSessions) {
      if (ev.code === "BracketRight") return { id: "tab-cycle", dir: 1 };
      if (ev.code === "BracketLeft") return { id: "tab-cycle", dir: -1 };
    }
    return null;
  }
  const k = ev.key.toLowerCase();
  // §7.4：主机栏开关「表单编辑焦点下不劫持」——正在输入时 ⌘B 不吞
  if (k === "b" && !ctx.inForm) return { id: "hostbar" };
  if (k === "f") return { id: "search" };
  if (k === "=" || k === "+") return { id: "font-up" };
  if (k === "-") return { id: "font-down" };
  if (k === "0") return { id: "font-reset" };
  if (ctx.native && ctx.hasActiveTab && k === "w") return { id: "tab-close" };
  if (ctx.native && ctx.hasSessions) {
    const n = Number.parseInt(ev.key, 10);
    if (n >= 1 && n <= 9) return { id: "tab-switch", index: n - 1 };
  }
  return null;
}
