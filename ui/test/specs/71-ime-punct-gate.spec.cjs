// 71 macOS 中文输入法全角标点首击（xterm _keyDownSeen 去重门；含组合键 keydown 229 先到）。
//
// 真实事件序列（WKWebView/Safari + Apple 拼音「中文标点」）：
//   keydown Shift（修饰键，旧版 xterm 在此武装去重门）
//   beforeinput/input data="："（IME 直接提交，早于字符 keydown）
//   keydown ";" keyCode=229（diff 兜底已无内容）、keyup ";"（清门）
// → 第一次「：」被 _inputEvent 丢弃，第二次按键才出现；「？」同理。
// 上游修复 #6200：修饰键单独 keydown 不武装 _keyDownSeen。这里验两层：
//   1) 伪 core：修饰键不武装、不清零，普通字符仍武装；
//   2) 真实 xterm：Shift + insertText 的「：」「？」各一次送达，且普通字符
//      keydown 后的同字符 insertText 仍被去重（不重复上屏）。
const liveSids = (page) =>
  page.evaluate(() => {
    const terms = window.__t_terms;
    if (!terms) return [];
    return [...terms.entries()]
      .filter(([, t]) => {
        const el = t.element;
        return !!el && el.isConnected && el.getBoundingClientRect().height > 0;
      })
      .map(([sid]) => sid);
  });

const connectHost = async (page, name) => {
  const card = await page.$(`.host-card:has(.host-name:text-is("${name}"))`);
  if (!card) throw new Error(`主机卡不在场：${name}`);
  await card.hover();
  await page.waitForTimeout(250);
  await (await card.$('button[title^="连接"]')).click();
  await page.waitForTimeout(1600);
};

module.exports = {
  title: "输入法全角标点首击：修饰键/组合键先到时不误吞 insertText",
  async run({ page, ck }) {
    // ── 1. 伪 core：补丁语义与上游 #6200 一致 ──
    const unit = await page.evaluate(async () => {
      const mod = await import("/src/terminal/xterm-ime-gate.ts");
      const mk = () => {
        const proto = {
          _keyDown() {
            this._keyDownSeen = true;
            return true;
          },
        };
        const core = Object.create(proto);
        core._keyDownSeen = false;
        const term = { _core: core };
        mod.patchXtermImeGate(term);
        return { term, core };
      };
      const ev = (keyCode, key) => ({ keyCode, key });
      const shift = mk();
      shift.core._keyDown(ev(16, "Shift"));
      const afterShift = shift.core._keyDownSeen;
      shift.core._keyDown(ev(65, "a"));
      const afterChar = shift.core._keyDownSeen;
      shift.core._keyDown(ev(16, "Shift"));
      const afterCharShift = shift.core._keyDownSeen;
      const meta = mk();
      meta.core._keyDown(ev(91, "Meta"));
      const afterMeta = meta.core._keyDownSeen;
      return {
        afterShift, afterChar, afterCharShift, afterMeta,
        shiftIsModifier: mod.isModifierOnlyKeydown(ev(16, "Shift")),
        charIsModifier: mod.isModifierOnlyKeydown(ev(65, "a")),
      };
    });
    ck.eq("修饰键 keydown 不武装去重门", unit.afterShift, false);
    ck.eq("普通字符 keydown 仍武装去重门", unit.afterChar, true);
    ck.eq("已武装时修饰键不清零（组合态去重保持）", unit.afterCharShift, true);
    ck.eq("Meta 键同样不武装去重门", unit.afterMeta, false);
    ck.check("修饰键判定只认修饰键", unit.shiftIsModifier && !unit.charIsModifier);

    // macOS 第三方 IME（搜狗等）：ASCII 标点/数字命中延迟到 keypress；字母/空格/
    // 修饰组合/组合键 229 不命中（避免误伤控制序列、Meta 序列与组合输入）。
    const punct = await page.evaluate(async () => {
      const mod = await import("/src/terminal/xterm-ime-gate.ts");
      const ev = (key, keyCode, extra = {}) => ({
        key, keyCode, ctrlKey: false, altKey: false, metaKey: false, isComposing: false, ...extra,
      });
      return {
        comma: mod.isMacImePunctuationKey(ev(",", 188)),
        bang: mod.isMacImePunctuationKey(ev("!", 49)),
        digit: mod.isMacImePunctuationKey(ev("1", 49)),
        bracket: mod.isMacImePunctuationKey(ev("[", 219)),
        letter: mod.isMacImePunctuationKey(ev("a", 65)),
        space: mod.isMacImePunctuationKey(ev(" ", 32)),
        ctrl: mod.isMacImePunctuationKey(ev(",", 188, { ctrlKey: true })),
        alt: mod.isMacImePunctuationKey(ev(",", 188, { altKey: true })),
        meta: mod.isMacImePunctuationKey(ev(",", 188, { metaKey: true })),
        composing: mod.isMacImePunctuationKey(ev(",", 188, { isComposing: true })),
        kc229: mod.isMacImePunctuationKey(ev(",", 229)),
      };
    });
    ck.check("macOS 第三方 IME 标点判定：ASCII 标点/数字命中",
      punct.comma && punct.bang && punct.digit && punct.bracket, JSON.stringify(punct));
    ck.check("macOS 第三方 IME 标点判定：字母/空格/修饰组合/229 不命中",
      !punct.letter && !punct.space && !punct.ctrl && !punct.alt && !punct.meta
        && !punct.composing && !punct.kc229, JSON.stringify(punct));

    // 未来 xterm 改掉 _keyDownSeen（改名/非布尔）时必须静默跳过，不能抛错
    const mismatch = await page.evaluate(async () => {
      const mod = await import("/src/terminal/xterm-ime-gate.ts");
      const proto = {
        _keyDown() { this._keyDownSeen = true; return true; },
      };
      const core = Object.create(proto);
      let threw = false;
      try { mod.patchXtermImeGate({ _core: core }); } catch { threw = true; }
      core._keyDown({ keyCode: 16, key: "Shift" });
      return {
        threw,
        seen: core._keyDownSeen,
        patched: proto[Symbol.for("tinyssh.xterm-ime-gate")] === true,
      };
    });
    ck.check("结构不匹配时安全跳过补丁", !mismatch.threw && mismatch.seen === true && !mismatch.patched,
      JSON.stringify(mismatch));

    // ── 2. 真实终端：Shift 按住时 IME 直接提交全角标点 ──
    await connectHost(page, "本机");
    const sids = await liveSids(page);
    ck.check("建连后有可见终端实例", sids.length >= 1, `sids=${JSON.stringify(sids)}`);
    const r = await page.evaluate(async (sid) => {
      const term = window.__t_terms.get(sid);
      const ta = term.textarea;
      if (!ta) throw new Error("xterm textarea 不在场");
      const out = [];
      term.onData((d) => out.push(d));
      const keydown = (key, code, keyCode, shiftKey = false) => {
        const ev = new KeyboardEvent("keydown", {
          key, code, shiftKey, bubbles: true, cancelable: true,
        });
        Object.defineProperty(ev, "keyCode", { get: () => keyCode });
        ta.dispatchEvent(ev);
      };
      const keyup = (key, code, keyCode) => {
        const ev = new KeyboardEvent("keyup", { key, code, bubbles: true, cancelable: true });
        Object.defineProperty(ev, "keyCode", { get: () => keyCode });
        ta.dispatchEvent(ev);
      };
      const keypress = (key, charCode, shiftKey = false) => {
        const ev = new KeyboardEvent("keypress", { key, shiftKey, bubbles: true, cancelable: true });
        Object.defineProperty(ev, "charCode", { get: () => charCode });
        Object.defineProperty(ev, "keyCode", { get: () => charCode });
        Object.defineProperty(ev, "which", { get: () => charCode });
        ta.dispatchEvent(ev);
      };
      const beforeinput = (data) => {
        ta.dispatchEvent(new InputEvent("beforeinput", {
          data, inputType: "insertText", composed: true, bubbles: true, cancelable: true,
        }));
      };
      const input = (data) => {
        // 真实 IME 在 input 前已把提交文本写进 textarea
        ta.value += data;
        ta.dispatchEvent(new InputEvent("input", {
          data, inputType: "insertText", composed: true, bubbles: true,
        }));
      };
      const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const run = async (fn) => {
        out.length = 0;
        ta.value = "";
        fn();
        // CompositionHelper 的 textarea diff 走 setTimeout(0)：等它跑完再取本案例
        await wait(40);
        return out.slice();
      };

      // Apple 拼音：input 早于字符 keydown（上游 #6200 场景）
      const apple = await run(() => {
        keydown("Shift", "ShiftLeft", 16, true);
        beforeinput("：");
        input("：");
        keydown("：", "Semicolon", 229, true);
        keyup(";", "Semicolon", 186);
        keyup("Shift", "ShiftLeft", 16);
      });
      // 部分第三方 IME：textarea 先写入，再 keydown 229，再 input
      const valueBefore = await run(() => {
        keydown("Shift", "ShiftLeft", 16, true);
        ta.value += "？";
        keydown("？", "Slash", 229, true);
        beforeinput("？");
        ta.dispatchEvent(new InputEvent("input", {
          data: "？", inputType: "insertText", composed: true, bubbles: true,
        }));
        keyup("？", "Slash", 191);
        keyup("Shift", "ShiftLeft", 16);
      });
      // 另一种顺序：keydown 229 时 textarea 还空，input 时才写入（CompositionHelper 补发）
      const valueAfter = await run(() => {
        keydown("Shift", "ShiftLeft", 16, true);
        keydown("？", "Slash", 229, true);
        beforeinput("？");
        input("？");
        keyup("？", "Slash", 191);
        keyup("Shift", "ShiftLeft", 16);
      });
      // 去重回归：普通字符 keydown 已发过，随后的同字符 insertText 不得重复
      const plain = await run(() => {
        keydown("a", "KeyA", 65);
        beforeinput("a");
        input("a");
        keyup("a", "KeyA", 65);
      });
      // Shift + ASCII 符号（非 IME）：keydown 已发过，input 不得重复
      const shiftedAscii = await run(() => {
        keydown("Shift", "ShiftLeft", 16, true);
        keydown("!", "Digit1", 49, true);
        beforeinput("!");
        input("!");
        keyup("!", "Digit1", 49);
        keyup("Shift", "ShiftLeft", 16);
      });
      // 搜狗等 macOS 第三方 IME：keydown 是半角，keypress.charCode 才是全角。
      // 在 Windows 浏览器里强制走 macOS 分支，验证「只发 keypress 的全角，不发半角」。
      const savedBrowser = term._core.browser;
      term._core.browser = { ...savedBrowser, isMac: true, isWindows: false };
      const sogouColon = await run(() => {
        keydown("Shift", "ShiftLeft", 16, true);
        keydown(";", "Semicolon", 186, true);
        keypress("：", 65306, true);
        beforeinput("：");
        input("：");
        keyup(";", "Semicolon", 186);
        keyup("Shift", "ShiftLeft", 16);
      });
      const sogouBang = await run(() => {
        keydown("Shift", "ShiftLeft", 16, true);
        keydown("!", "Digit1", 49, true);
        keypress("！", 65281, true);
        beforeinput("！");
        input("！");
        keyup("!", "Digit1", 49);
        keyup("Shift", "ShiftLeft", 16);
      });
      // macOS 英文标点：同样走 keypress，但 charCode 是 ASCII，只发一次
      const macAsciiBang = await run(() => {
        keydown("Shift", "ShiftLeft", 16, true);
        keydown("!", "Digit1", 49, true);
        keypress("!", 33, true);
        beforeinput("!");
        input("!");
        keyup("!", "Digit1", 49);
        keyup("Shift", "ShiftLeft", 16);
      });
      term._core.browser = savedBrowser;
      return { apple, valueBefore, valueAfter, plain, shiftedAscii, sogouColon, sogouBang, macAsciiBang };
    }, sids[0]);
    ck.eq("「：」按一次只送达一次", JSON.stringify(r.apple), JSON.stringify(["："]));
    ck.eq("「？」（textarea 先写入）按一次只送达一次", JSON.stringify(r.valueBefore), JSON.stringify(["？"]));
    ck.eq("「？」（textarea 后写入）只送达一次", JSON.stringify(r.valueAfter), JSON.stringify(["？"]));
    ck.eq("普通字符未被 insertText 重复上屏", JSON.stringify(r.plain), JSON.stringify(["a"]));
    ck.eq("Shift+ASCII 符号未被 insertText 重复上屏", JSON.stringify(r.shiftedAscii), JSON.stringify(["!"]));
    ck.eq("搜狗「：」只走 keypress 全角，不发半角 ;", JSON.stringify(r.sogouColon), JSON.stringify(["："]));
    ck.eq("搜狗「！」只走 keypress 全角，不发半角 !", JSON.stringify(r.sogouBang), JSON.stringify(["！"]));
    ck.eq("macOS 英文 Shift+1 走 keypress 仍只发一次 ASCII !", JSON.stringify(r.macAsciiBang), JSON.stringify(["!"]));
  },
};
