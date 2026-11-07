// macOS 中文输入法全角标点「首击丢失」修正。
//
// xterm.js 5.5.0 的 _keyDown 一进来就把 _keyDownSeen 置 true；_inputEvent 用
// `!ev.composed || !this._keyDownSeen` 给 IME 的 insertText 去重。macOS 的拼音/注音
// 输入法在「中文标点」模式下直接提交全角标点（Shift+; → ：、Shift+/ → ？）时，
// WebKit/WKWebView 的事件顺序是：按住 Shift 的修饰键 keydown 先到（武装去重门），
// 随后 beforeinput/input 直接提交字符（早于字符自身的 keydown）。于是第一次
// insertText 被误判为「keydown 已经发过」而丢弃；字符 keyup 又把门清零，第二次按
// 才通过——表现正是「：按一次不出，要连按两次；？同样」。
//
// 上游修复 xtermjs/xterm.js#6200（2026-10-28 合入 master）：修饰键单独 keydown 既
// 不武装也不解除 _keyDownSeen，保持进入前的状态（已处于组合态时仍继续去重）。
// 项目当前锁在 5.5.0，6.0.0 尚未包含该修复；这里在 core 原型上包一层，语义与上游
// 一致。升级到包含 #6200 的 xterm 后可删除本模块及 App 里的 patch 调用。
//
// 回归：ui/test/specs/71-ime-punct-gate.spec.cjs（伪 core 语义 + 真实 xterm 事件序列）。

/** 只描述本补丁触达的 xterm core 内部面（私有 API，版本锁定 5.5.0）。 */
type KeyDownGateCore = {
  _keyDownSeen: boolean;
  _keyDown(ev: KeyboardEvent): boolean | undefined;
};

const PATCHED = Symbol.for("tinyssh.xterm-ime-gate");

/** 与上游 #6200 同表：Shift/Ctrl/Alt + 左右 Meta/OS。 */
export function isModifierOnlyKeydown(ev: KeyboardEvent): boolean {
  return ev.keyCode === 16 || // Shift
    ev.keyCode === 17 || // Ctrl
    ev.keyCode === 18 || // Alt
    ev.keyCode === 91 || // Meta (Left)
    ev.keyCode === 92 || // Meta (Right)
    ev.keyCode === 93 || // Meta (Menu)
    ev.keyCode === 224 || // Meta (Firefox)
    ev.key === "Meta";
}

/**
 * 给 xterm 实例装上去重门修正（幂等，按 core 原型只装一次）。
 * 传入公开 Terminal 实例即可；内部通过 `_core` 找到真正处理 keydown 的 core。
 * 结构不匹配（未来升级改了内部字段）时静默跳过，不影响终端其它功能。
 */
export function patchXtermImeGate(term: unknown): void {
  const core = (term as { _core?: KeyDownGateCore })._core;
  if (!core || typeof core._keyDown !== "function" || typeof core._keyDownSeen !== "boolean") return;
  const proto = Object.getPrototypeOf(core) as (KeyDownGateCore & { [PATCHED]?: true }) | null;
  if (!proto || typeof proto._keyDown !== "function" || proto[PATCHED]) return;
  const orig = proto._keyDown;
  const patched = function (this: KeyDownGateCore, ev: KeyboardEvent) {
    if (!isModifierOnlyKeydown(ev)) return orig.call(this, ev);
    // 上游语义：修饰键 keydown 不改变去重门——进入前已武装（组合态）则保持武装。
    const seen = this._keyDownSeen;
    try {
      return orig.call(this, ev);
    } finally {
      this._keyDownSeen = seen;
    }
  };
  try {
    proto._keyDown = patched;
    Object.defineProperty(proto, PATCHED, { value: true, enumerable: false });
  } catch {
    // 未来 xterm 把方法/原型改成只读或结构不匹配：静默放弃补丁，终端照常工作
    try { proto._keyDown = orig; } catch { /* 原方法也写不回：保持现状 */ }
  }
}
