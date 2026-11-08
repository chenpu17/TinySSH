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
// 上游 #6200 只覆盖「修饰键先到、input 早于字符 keydown」这一种顺序。部分第三方
// 输入法（以及 WKWebView 的其它版本）会把字符 keydown（keyCode=229）排在 input
// 之前：此时去重门被字符 keydown 武装。若 IME 已在 keydown 前把提交文本写进
// textarea，CompositionHelper 的延迟 diff 会是空操作，insertText 就是唯一送达
// 机会（这里临时放行）；若 textarea 在 keydown 后才变化，交给 CompositionHelper
// 发送，这里不插手，避免重复上屏。普通字符 keydown 之后的 input 仍走原去重逻辑。
//
// 搜狗等 macOS 第三方输入法还有一条不同的路径：keydown.key 是半角标点/数字，
// 真正的全角字符在 keypress.charCode 里。xterm 5.5.0 默认在 keydown 就按
// keydown.key 发数据，会先把半角送进 PTY（或把全角吞掉）。这里按上游 #6294
// 的方向，在 macOS 上把 ASCII 标点/数字延迟到 keypress，由 charCode 发送；
// 不 preventDefault（默认动作要留给 IME），只 stopPropagation 挡宿主快捷键。
//
// 延迟分支还留了一条 input 兜底：WKWebView 与某些 IME 组合下 keypress 可能
// 不派发（或 charCode=0），首击仍会丢——keypress 没送过时，放行浏览器默认写入
// 产生的 insertText（其 data 是全角/半角真值），保证「按一次出一个」。反过来，
// input 先送达后 keypress 才到的顺序也要防重：已由 input 送达的键记 delivered，
// 迟到 keypress 直接吞掉（否则同一键会发两次）。
//
// 回归：ui/test/specs/71-ime-punct-gate.spec.cjs（伪 core 语义 + 真实 xterm 事件序列）。

/** 只描述本补丁触达的 xterm core 内部面（私有 API，版本锁定 5.5.0）。 */
type KeyDownGateCore = {
  _keyDownSeen: boolean;
  _keyDown(ev: KeyboardEvent): boolean | undefined;
  _keyUp?(ev: KeyboardEvent): void;
  _keyPress?(ev: KeyboardEvent): boolean;
  _inputEvent?(ev: InputEvent): boolean;
  _keyDownHandled?: boolean;
  _keyPressHandled?: boolean;
  browser?: { isMac?: boolean };
  optionsService?: { rawOptions?: { screenReaderMode?: boolean } };
  _customKeyEventHandler?: (ev: KeyboardEvent) => boolean;
  _compositionHelper?: {
    isComposing?: boolean;
    _isSendingComposition?: boolean;
    _textarea?: HTMLTextAreaElement;
  };
  [LAST_KEYDOWN]?: LastKeyDown | null;
};

type LastKeyDown = {
  /** 单独按下的修饰键（Shift/Ctrl/Alt/Meta）：不产生文本。 */
  modifier: boolean;
  /** 组合键（keyCode 229 / Process / isComposing）：文本由 IME 提交。 */
  composition: boolean;
  /** keydown 当时 textarea 里的文本：判断 IME 是否已先写入、CompositionHelper 是否会补发。 */
  value: string;
  /** 本键由 macOS ASCII 标点延迟分支接管：真正送达在 keypress（或 input 兜底）。 */
  punct?: string;
  /** 延迟分支已由 input 兜底送达；迟到的 keypress 必须吞掉，避免同键发两次。 */
  delivered?: boolean;
};

const PATCHED = Symbol.for("tinyssh.xterm-ime-gate");
const LAST_KEYDOWN = Symbol.for("tinyssh.xterm-ime-last-keydown");

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

/** 组合键 keydown：文本由输入法提交，keydown 本身不产生可打印字符。 */
export function isCompositionKeydown(ev: KeyboardEvent): boolean {
  return ev.keyCode === 229 || ev.key === "Process" || ev.isComposing === true;
}

/** macOS 第三方输入法（搜狗等）的 ASCII 标点/数字：keydown.key 是半角，真正的
 * 全角字符在 keypress.charCode 里。返回 true 时调用方应把这一键交给 keypress，
 * 不要按 keydown.key 先发半角。 */
export function isMacImePunctuationKey(ev: KeyboardEvent): boolean {
  if (ev.ctrlKey || ev.altKey || ev.metaKey || ev.isComposing || ev.keyCode === 229) return false;
  if (!ev.key || ev.key.length !== 1) return false;
  const c = ev.key.charCodeAt(0);
  return (c >= 33 && c <= 64) || // ! through @（含数字）
    (c >= 91 && c <= 96) || // [ through `
    (c >= 123 && c <= 126); // { through ~
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
    // macOS 搜狗等第三方 IME：keydown.key 是半角标点/数字，真正的全角字符在
    // keypress.charCode 里。先把这一键交给 keypress，避免半角先上屏或首击被吞
    // （与上游 #6294 同向；仅 macOS、非组合态、非 screen reader）。
    if (
      this.browser?.isMac &&
      !this.optionsService?.rawOptions?.screenReaderMode &&
      isMacImePunctuationKey(ev)
    ) {
      // 尊重自定义 key handler：它若拒绝，交回原路径（原路径会再调一次并返回 false）。
      if (this._customKeyEventHandler && this._customKeyEventHandler(ev) === false) {
        return orig.call(this, ev);
      }
      const comp = this._compositionHelper;
      if (comp && (comp.isComposing || comp._isSendingComposition)) {
        return orig.call(this, ev);
      }
      // 保持原 _keyDown 的门状态：keydown 已见（input 去重），但这里不发数据；
      // keypress 的 charCode 才是 IME 文本。stopPropagation 只挡宿主快捷键冒泡，
      // 不 preventDefault——默认动作必须保留给 keypress/IME。
      this._keyDownSeen = true;
      this._keyDownHandled = false;
      this[LAST_KEYDOWN] = {
        modifier: false,
        composition: false,
        value: comp?._textarea?.value ?? "",
        punct: ev.key,
      };
      ev.stopPropagation();
      return true;
    }
    const modifier = isModifierOnlyKeydown(ev);
    this[LAST_KEYDOWN] = {
      modifier,
      composition: isCompositionKeydown(ev),
      value: this._compositionHelper?._textarea?.value ?? "",
    };
    if (!modifier) return orig.call(this, ev);
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
    // keyup 后上一次 keydown 不再代表当前按键：避免后续 input 误用旧状态。
    if (typeof proto._keyUp === "function") {
      const origKeyUp = proto._keyUp;
      proto._keyUp = function (this: KeyDownGateCore, ev: KeyboardEvent) {
        this[LAST_KEYDOWN] = null;
        return origKeyUp.call(this, ev);
      };
    }
    // 字符 keydown(229/Process) 先于 IME input 的顺序：若 IME 在 keydown 前已把
    // 提交文本写进 textarea，CompositionHelper 的延迟 diff 会是空操作，这一份
    // insertText 就是唯一送达机会——临时放行。若 textarea 在 keydown 后才变化，
    // 交给 CompositionHelper 的 diff 发送，这里不插手，避免重复上屏。
    // 另一条兜底：macOS ASCII 标点延迟分支本应等 keypress.charCode 送达，但
    // WKWebView + 部分 IME 组合下 keypress 可能根本不派发（或 charCode=0 被
    // keypress 提前 preventDefault 掉），此时浏览器默认动作已把字符写进 textarea，
    // input 就是唯一送达机会。keypress 已经送过（_keyPressHandled）时不重复放行。
    // 普通字符 keydown 之后的 input 仍走原门去重。
    if (typeof proto._inputEvent === "function") {
      const origInputEvent = proto._inputEvent;
      proto._inputEvent = function (this: KeyDownGateCore, ev: InputEvent) {
        const last = this[LAST_KEYDOWN];
        const comp = this._compositionHelper;
        const composing = !!(comp && (comp.isComposing || comp._isSendingComposition));
        const insert = ev.inputType === "insertText" && !!ev.data;
        if (this._keyDownSeen && insert && last?.punct && !composing && !this._keyPressHandled) {
          const textarea = comp?._textarea;
          last.punct = undefined;
          last.delivered = true;
          const seen = this._keyDownSeen;
          this._keyDownSeen = false;
          try {
            const r = origInputEvent.call(this, ev);
            // 迟到送达的字符已由 xterm 直接触发数据事件；清掉浏览器写入 textarea
            // 的残留，避免下一次组合的坐标（compositionPosition.start）被带偏。
            if (textarea) textarea.value = "";
            return r;
          } finally {
            this._keyDownSeen = seen;
          }
        }
        if (
          this._keyDownSeen &&
          insert &&
          last?.composition &&
          last.value.endsWith(ev.data!) &&
          !composing
        ) {
          const seen = this._keyDownSeen;
          this._keyDownSeen = false;
          try {
            return origInputEvent.call(this, ev);
          } finally {
            this._keyDownSeen = seen;
          }
        }
        return origInputEvent.call(this, ev);
      };
    }
    // 迟到 keypress：input 已把这一键送达（last.delivered），之后才到的 keypress
    // 不能再由 xterm 按 charCode 发一遍。吞掉它并 preventDefault，避免字符再被
    // 浏览器默认动作插进 textarea 留下残值。
    if (typeof proto._keyPress === "function") {
      const origKeyPress = proto._keyPress;
      proto._keyPress = function (this: KeyDownGateCore, ev: KeyboardEvent) {
        const last = this[LAST_KEYDOWN];
        if (last?.delivered) {
          last.delivered = false;
          ev.preventDefault();
          return false;
        }
        return origKeyPress.call(this, ev);
      };
    }
    Object.defineProperty(proto, PATCHED, { value: true, enumerable: false });
  } catch {
    // 未来 xterm 把方法/原型改成只读或结构不匹配：静默放弃补丁，终端照常工作
    try { proto._keyDown = orig; } catch { /* 原方法也写不回：保持现状 */ }
  }
}
