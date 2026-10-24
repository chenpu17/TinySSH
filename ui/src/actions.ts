// R13 统一 action 分发（§7.2「同一个 action 分发源」）：应用快捷键只有这一份 keymap——
// window 捕获层与 xterm 自定义键处理器都经 resolveAction 解析、App 的 dispatch 执行，
// 消除双绑定重复执行。⌘, 归原生菜单加速器（NSMenu 先于 WebView 消费），此处刻意不绑。
// 传输层不在此列：Ctrl/Alt 控制字符编码、xterm onData 是终端输入路径，非应用动作。
import { DEFAULT_KEYMAP, bindingOf, type Binding, type KeyActionId } from "./keymap.ts";

export type AppAction =
  | { id: "search" }
  | { id: "zoom-in" }
  | { id: "zoom-out" }
  | { id: "zoom-reset" }
  | { id: "hostbar" }
  | { id: "settings" }
  | { id: "palette" }
  | { id: "tab-switch"; index: number }
  | { id: "tab-cycle"; dir: 1 | -1 }
  | { id: "tab-close" }
  | { id: "tab-new" }
  | { id: "term-local" }
  | { id: "split-toggle" }
  | { id: "focus-toggle" }
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
  /** 可重绑动作的键位表（键位配置轮）：缺省用默认表；App 从 KV ui.keymap.v1 载入 */
  keymap?: Record<KeyActionId, Binding>;
}

/** 平台判定（审计 W4）：Ctrl 等价 ⌘ 的开关——macOS 用 metaKey（⌘），Win/Linux
 * 原生侧用 ctrlKey。UA-CH 优先，回退 platform/userAgent（开发环境足够）。 */
export function isMacPlatform(): boolean {
  const nav = navigator as Navigator & { userAgentData?: { platform?: string } };
  const p = nav.userAgentData?.platform ?? nav.platform ?? nav.userAgent ?? "";
  return /mac|iphone|ipad|ios/i.test(p);
}

/** Windows 判定（双标题栏重设计）：原生壳内用于显隐自绘窗口控件（─ □ ✕）。 */
export function isWindowsPlatform(): boolean {
  const nav = navigator as Navigator & { userAgentData?: { platform?: string } };
  const p = nav.userAgentData?.platform ?? nav.platform ?? nav.userAgent ?? "";
  return /win/i.test(p);
}

/** keymap 唯一事实源：返回 null = 不归应用动作（透传给终端/浏览器）。 */
export function resolveAction(ev: KeyboardEvent, ctx: ActionCtx): AppAction | null {
  // IME 组合期（§7.3 输入约定）：isComposing 与 keyCode 229（合成器改写的 keydown）
  // 双查逐事件判定，无跨事件组合态跟踪
  if (ev.isComposing || ev.keyCode === 229) return null;
  // Esc 无条件归浮层链：模态期由 closeTopOverlay 关最上层（确认=取消、指纹=拒绝、
  // 双因素=取消认证）；无浮层时 dispatch 返回 false 原样透传（输入框/终端不受影响）
  if (ev.key === "Escape") return { id: "esc" };
  // 专注模式（F11，固定键不开放改绑——命名键不进可重绑表，同缩放/Esc 的理由）：
  // native 门——浏览器 demo 的 F11 归浏览器原生全屏，不劫持；模态门同 ⌘ 组合规则，
  // 模态层打开时不切（返回 null 透传，此时焦点在模态层，无系统级副作用）。
  // window 捕获层先于 xterm 截下：preventDefault+stopPropagation 后事件到不了
  // 终端自定义键处理器，F11 不会作为输入序列发给远端。
  if (ev.key === "F11" && ctx.native && !ctx.modal) return { id: "focus-toggle" };
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
  // 非 mac 原生环境把 Ctrl 当作 ⌘ 等价键（审计 W4）：快捷键唯一事实源原先只认
  // metaKey，Windows/Linux 上（metaKey=Win 键且多为系统保留）整套快捷键死键。
  // 仅 native 生效——浏览器 demo 保持 metaKey-only（Ctrl 系归还浏览器行为，
  // 防与 Ctrl+F 查找/Ctrl+W 关标签的浏览器语义双响应）。
  const cmd = ev.metaKey || (!isMacPlatform() && ctx.native && ev.ctrlKey);
  if (!cmd || ev.altKey) return null;
  // 模态层打开：任何 ⌘/Ctrl 组合都不执行（§7.3 模态层不串输入）
  if (ctx.modal) return null;
  // Ctrl+Tab / Ctrl+Shift+Tab（十四轮）：Win/Linux 标签应用的通用循环惯例，
  // 与 ⌘⇧[/] 同一 action。须带修饰键判定（裸 Tab 归焦点导航），mac 的 ⌘Tab
  // 是系统 App 切换器收不到，不影响；浏览器 demo 保持 native 门不劫持。
  if (ev.key === "Tab" && ctx.native && ctx.hasSessions) {
    return { id: "tab-cycle", dir: ev.shiftKey ? -1 : 1 };
  }
  // 键位表匹配（键位配置轮）：可配置动作按 ui.keymap.v1 表解析，门控逐动作保留
  // （palette/tab-new/term-local/分屏关签 native 门；hostbar 表单焦点门；分屏关签需活动会话）。
  // 先于 shift 早退——表允许 Ctrl+Shift+字母 形组合。cmd 门已过滤平台主修饰键：
  // mac 真按 Ctrl 仍是 shell 键（cmd=metaKey 不成立）；demo 侧非平台 Ctrl 同理早退，
  // Ctrl+F 等归浏览器语义。默认表=直键三键轮基线：T 新建 / W 关签 / ⇧T 本地终端 /
  // D 分屏 / K 面板 / B 主机栏 / F 搜索；被表占用的字母在 App 控制字符直发层同步豁免。
  const evb = bindingOf(ev, isMacPlatform());
  if (evb) {
    const km = ctx.keymap ?? DEFAULT_KEYMAP;
    const hit = (id: KeyActionId) =>
      km[id].key === evb.key && km[id].shift === evb.shift && km[id].alt === evb.alt;
    if (hit("palette") && ctx.native) return { id: "palette" };
    if (hit("hostbar") && !ctx.inForm) return { id: "hostbar" };
    if (hit("search")) return { id: "search" };
    if (hit("tab-new") && ctx.native) return { id: "tab-new" };
    if (hit("term-local") && ctx.native) return { id: "term-local" };
    if (hit("split-toggle") && ctx.native && ctx.hasActiveTab) return { id: "split-toggle" };
    if (hit("tab-close") && ctx.native && ctx.hasActiveTab) return { id: "tab-close" };
  }
  if (ev.shiftKey) {
    // ⇧] / ⇧[ 用物理键位判定（Shift 下 ev.key 是 }/{）
    if (ctx.native && ctx.hasSessions) {
      if (ev.code === "BracketRight") return { id: "tab-cycle", dir: 1 };
      if (ev.code === "BracketLeft") return { id: "tab-cycle", dir: -1 };
    }
    return null;
  }
  if (ctx.native && ctx.hasSessions) {
    const n = Number.parseInt(ev.key, 10);
    if (n >= 1 && n <= 9) return { id: "tab-switch", index: n - 1 };
  }
  return null;
}
