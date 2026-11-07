// 71 macOS 中文输入法全角标点首击（xterm _keyDownSeen 去重门）。
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
  title: "输入法全角标点首击：修饰键不武装 xterm 去重门",
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
    const r = await page.evaluate((sid) => {
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
      const imeCommit = (data) => {
        ta.dispatchEvent(new InputEvent("input", {
          data, inputType: "insertText", composed: true, bubbles: true,
        }));
      };
      // Apple 拼音中文标点：Shift+; → ：，Shift+/ → ？
      keydown("Shift", "ShiftLeft", 16, true);
      imeCommit("：");
      keyup("Shift", "ShiftLeft", 16);
      keydown("Shift", "ShiftLeft", 16, true);
      imeCommit("？");
      keyup("Shift", "ShiftLeft", 16);
      // 去重回归：普通字符 keydown 已发过，随后的同字符 insertText 不得重复
      keydown("a", "KeyA", 65);
      imeCommit("a");
      keyup("a", "KeyA", 65);
      return out;
    }, sids[0]);
    ck.eq("「：」按一次只送达一次", r[0], "：");
    ck.eq("「？」按一次只送达一次", r[1], "？");
    ck.eq("普通字符未被 insertText 重复上屏", r[2], "a");
    ck.eq("总送达序列无缺失/重复", JSON.stringify(r), JSON.stringify(["：", "？", "a"]));
  },
};
