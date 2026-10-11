// R13 统一 action 分发（§7.2「同一个 action 分发源」）：应用快捷键只有这一份 keymap——
// window 捕获层与 xterm 自定义键处理器都经 resolveAction 解析、App 的 dispatch 执行，
// 消除双绑定重复执行。⌘, 归原生菜单加速器（NSMenu 先于 WebView 消费），此处刻意不绑。
// 传输层不在此列：Ctrl/Alt 控制字符编码、xterm onData 是终端输入路径，非应用动作。
export type AppAction =
  | { id: "search" }
  | { id: "zoom-in" }
  | { id: "zoom-out" }
  | { id: "zoom-reset" }
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
  // 整页缩放（UX 五轮，参考 tiny-worker zoom.ts）：Ctrl（Win/Linux）或 ⌘（mac）
  // ±/0 归应用缩放；字号键退役（字号收进设置面板）。native 门——浏览器 demo 不劫持
  // （浏览器自带缩放，键盘语义归浏览器）；模态门同 ⌘ 组合规则；e.key 为主（跟随
  // 布局），e.code 兜底非拉丁布局（俄文等布局下 "=" 的 e.key 会错位，按物理键位
  // 识别）；不拦 Shift——Ctrl+Shift+=（字面 Plus）也是 Chrome 认的放大键。
  // 不吃 inForm 门：缩放与浏览器行为一致，输入框里也生效。
  if (ctx.native && !ctx.modal && !ev.altKey && (ev.metaKey || ev.ctrlKey)) {
    if (ev.key === "=" || ev.key === "+" || ev.code === "Equal" || ev.code === "NumpadAdd") return { id: "zoom-in" };
    if (ev.key === "-" || ev.code === "Minus" || ev.code === "NumpadSubtract") return { id: "zoom-out" };
    if (ev.key === "0" || ev.code === "Digit0" || ev.code === "Numpad0") return { id: "zoom-reset" };
  }
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
  if (ctx.native && ctx.hasActiveTab && k === "w") return { id: "tab-close" };
  if (ctx.native && ctx.hasSessions) {
    const n = Number.parseInt(ev.key, 10);
    if (n >= 1 && n <= 9) return { id: "tab-switch", index: n - 1 };
  }
  return null;
}
