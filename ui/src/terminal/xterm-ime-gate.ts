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
// 本项目已升级 xterm 6.0.0，但 6.0.0 的发布分支仍不含 #6200（_keyDown/_inputEvent
// 去重逻辑与 5.5.0 相同）；这里在 core 原型上包一层，语义与上游一致。升级到包含
// #6200 的 xterm 后可删除本模块及 App 里的 patch 调用。
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
// 真机上仍有一种「首击丢失」（2026-11-09 复报）：WKWebView 的 IME 提交是异步的，
// 字符 keydown（229）先到、input 后到。keydown 时 CompositionHelper 排队的 0ms
// 延迟 diff/flush 会先在「textarea 还没写入」的状态下跑空；随后 input 到达时
// `_keyDownSeen` 仍为 true，xterm 的 input 门按 composed 去重丢弃。旧兜底要求
// 「keydown 时 textarea 已含提交文本」（last.value.endsWith(data)）或
// 「不在 _isSendingComposition 期」，恰好都命中不了这条时序，于是首击消失；
// 字符 keyup 清门后第二次起才恢复正常。
//
// 现在把「最后一次送达机会」统一成一条：只要是 insertText / insertFromComposition、
// 本次 keydown 以来没有任何数据送达（逐实例 triggerDataEvent 计数未变）、keypress
// 也没送过、且不处于真实组合态（isComposing），就由这里放行一次 ev.data，并：
//   1) 撤销 keydown 排队的 composition flush（_isSendingComposition=false）；
//   2) 把 textarea 还原成 keydown 时的值——229 延迟 diff 的 oldValue 正是它，
//      还原后 diff 为空，不重复上屏、也不会因长度变短误发 DEL；
//   3) 记 delivered，迟到 keypress 吞掉。
// 真实组合（compositionstart/update/end、insertCompositionText）不进这条路径；
// compositionend 已先送达时计数已变，也不会二次上屏。
//
// 回归：ui/test/specs/71-ime-punct-gate.spec.cjs（伪 core 语义 + 真实 xterm 事件序列）。

/** 只描述本补丁触达的 xterm core 内部面（私有 API，按 5.5/6.0 锁定）。 */
type KeyDownGateCore = {
  _keyDownSeen: boolean;
  _keyDown(ev: KeyboardEvent): boolean | undefined;
  _keyUp?(ev: KeyboardEvent): void;
  _keyPress?(ev: KeyboardEvent): boolean;
  _inputEvent?(ev: InputEvent): boolean;
  _keyDownHandled?: boolean;
  _keyPressHandled?: boolean;
  _unprocessedDeadKey?: boolean;
  browser?: { isMac?: boolean };
  optionsService?: { rawOptions?: { screenReaderMode?: boolean } };
  coreService?: { triggerDataEvent?: (data: string, wasUserInput?: boolean) => void };
  _customKeyEventHandler?: (ev: KeyboardEvent) => boolean;
  _compositionHelper?: {
    isComposing?: boolean;
    _isSendingComposition?: boolean;
    _textarea?: HTMLTextAreaElement;
  };
  [LAST_KEYDOWN]?: LastKeyDown | null;
  /** 本实例已送达 PTY 的次数（包一层 coreService.triggerDataEvent 计数）。 */
  [DELIVERY_SEQ]?: number;
  [SEQ_PATCHED]?: true;
};

type LastKeyDown = {
  /** 单独按下的修饰键（Shift/Ctrl/Alt/Meta）：不产生文本。 */
  modifier: boolean;
  /** 组合键（keyCode 229 / Process / isComposing）：文本由 IME 提交。 */
  composition: boolean;
  /** keydown 当时 textarea 里的文本：判断 IME 是否已先写入、CompositionHelper 是否会补发。 */
  value: string;
  /** keydown 开始时的送达计数：之后若有人送过数据，input 就不得再兜底。 */
  seq: number;
  /** 本键已由 input 兜底送达；迟到的 keypress 必须吞掉，避免同键发两次。 */
  delivered?: boolean;
};

const PATCHED = Symbol.for("tinyssh.xterm-ime-gate");
const LAST_KEYDOWN = Symbol.for("tinyssh.xterm-ime-last-keydown");
const DELIVERY_SEQ = Symbol.for("tinyssh.xterm-ime-delivery-seq");
const SEQ_PATCHED = Symbol.for("tinyssh.xterm-ime-seq-patched");

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

/** 鼠标上报报文（SGR `<b;x;yM/m`、URXVT `b;x;yM`、X10 `ESC[M`+3 字节）：
 * 由 xterm 鼠标服务发出，不是键盘/IME 文本，不计入键入送达。 */
export function isMouseReport(data: string): boolean {
  return /^\x1b\[(?:<[\d;]+[Mm]|[\d;]+[Mm]|M)/.test(data);
}

/**
 * 给 xterm 实例装上去重门修正（幂等，按 core 原型只装一次）。
 * 传入公开 Terminal 实例即可；内部通过 `_core` 找到真正处理 keydown 的 core。
 * 结构不匹配（未来升级改了内部字段）时静默跳过，不影响终端其它功能。
 */
export function patchXtermImeGate(term: unknown): void {
  const core = (term as { _core?: KeyDownGateCore })._core;
  if (!core || typeof core._keyDown !== "function" || typeof core._keyDownSeen !== "boolean") return;
  // 送达计数是逐 core 实例的（coreService 每终端一个），必须在原型补丁的幂等
  // 早退之前装：第二个终端起原型已打补丁，但它的 coreService 还没包。
  try {
    const svc = core.coreService as
      | (NonNullable<KeyDownGateCore["coreService"]> & { [SEQ_PATCHED]?: true })
      | undefined;
    if (svc && typeof svc.triggerDataEvent === "function" && !svc[SEQ_PATCHED]) {
      const origTrigger = svc.triggerDataEvent;
      svc.triggerDataEvent = function (this: unknown, data: string, wasUserInput?: boolean) {
        // 鼠标上报（SGR/X10/URXVT 滚轮与点击报文）不是键入文本，不计入「本键已
        // 送达」：滚轮合帧可能在 keydown 与 IME input 之间送达一次，若计数，会把
        // IME 异步提交的唯一送达机会误判成已发而丢字（见 wheel-batch.ts）。
        if (!isMouseReport(data)) core[DELIVERY_SEQ] = (core[DELIVERY_SEQ] ?? 0) + 1;
        return origTrigger.call(this, data, wasUserInput);
      };
      svc[SEQ_PATCHED] = true;
      core[DELIVERY_SEQ] ??= 0;
    }
  } catch { /* 计数装不上：input 兜底不出手，去重门修正仍生效 */ }
  const proto = Object.getPrototypeOf(core) as (KeyDownGateCore & { [PATCHED]?: true }) | null;
  if (!proto || typeof proto._keyDown !== "function" || proto[PATCHED]) return;
  const orig = proto._keyDown;
  const patched = function (this: KeyDownGateCore, ev: KeyboardEvent) {
    const seq = this[DELIVERY_SEQ];
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
        seq: seq ?? 0,
      };
      ev.stopPropagation();
      return true;
    }
    const modifier = isModifierOnlyKeydown(ev);
    this[LAST_KEYDOWN] = {
      modifier,
      composition: isCompositionKeydown(ev),
      value: this._compositionHelper?._textarea?.value ?? "",
      seq: seq ?? 0,
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
    // IME 直接提交（insertText / insertFromComposition）在 xterm 的去重门里会被
    // `composed && _keyDownSeen` 丢弃。只要满足「本键 keydown 以来无人送达过」
    // （送达计数未变）、「keypress 没送过」、「不在真实组合态」，这份 input 就是
    // 唯一送达机会——放行一次。覆盖：
    //   · 修饰键先武装门、input 早于字符 keydown（上游 #6200 场景的兜底）；
    //   · 字符 keydown(229) 先到，CompositionHelper 的 0ms diff/flush 先跑空、
    //     提交文本随后才写进 textarea 并派发 input（WKWebView 异步提交，首击丢失）；
    //   · 搜狗等把全角放在 keypress、但 keypress 未派发或 charCode=0。
    // 放行时说清楚三件事：撤销已排队的 composition flush、把 textarea 还原成
    // keydown 时的值（229 diff 的 oldValue 就是它，diff 归零）、记 delivered 让
    // 迟到 keypress 被吞。真实组合（isComposing / insertCompositionText）不在此列。
    if (typeof proto._inputEvent === "function") {
      const origInputEvent = proto._inputEvent;
      proto._inputEvent = function (this: KeyDownGateCore, ev: InputEvent) {
        const last = this[LAST_KEYDOWN];
        const comp = this._compositionHelper;
        const insert = (ev.inputType === "insertText" || ev.inputType === "insertFromComposition") && !!ev.data;
        const composing = !!(comp && comp.isComposing);
        const seq = this[DELIVERY_SEQ];
        if (
          this._keyDownSeen &&
          insert &&
          last &&
          !last.delivered &&
          !composing &&
          !this._keyPressHandled &&
          !this.optionsService?.rawOptions?.screenReaderMode &&
          typeof seq === "number" &&
          seq === last.seq
        ) {
          const textarea = comp?._textarea;
          // 与 keydown 排队的 composition flush 抢跑：由 input 送达后撤销它，
          // 否则 0ms 后它还会按 textarea 再发一遍。
          if (comp && comp._isSendingComposition) comp._isSendingComposition = false;
          last.delivered = true;
          const seen = this._keyDownSeen;
          this._keyDownSeen = false;
          try {
            // 原门只认 insertText；insertFromComposition 由这里直接补一次数据事件，
            // 语义与其 insertText 分支一致（清 dead key 状态）。
            let r: boolean;
            if (ev.inputType === "insertText") {
              r = origInputEvent.call(this, ev);
            } else {
              this._unprocessedDeadKey = false;
              this.coreService?.triggerDataEvent?.(ev.data!, true);
              r = true;
            }
            // 还原 keydown 时的 textarea：229 延迟 diff 以该值为 oldValue，
            // 还原后 diff 为空——不重复上屏，也不会因长度变短误发 DEL。
            if (textarea) textarea.value = last.value;
            return r;
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
