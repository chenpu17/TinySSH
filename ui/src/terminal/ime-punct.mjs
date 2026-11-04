// 输入法标点 → 物理键位 ASCII（tmux 前缀后一键专用，见 App.tsx tmuxPrefixArmRef）。
//
// 中文输入法「中文标点」模式会把标点键提交成全角/中文标点：Shift+4 → ￥、" → “”、
// : → ：、[ → 【……——tmux 前缀（C-b）之后的一键是命令键不是文本，收到这些字符等于
// 按了一个未绑定的键，Ctrl+B $（改会话名）/ ,（改窗口名）/ "（上下分）/ :（命令行）/
// [（复制模式）全部静默无反应；% 在中文标点下仍是 %，所以表现为「分屏好使、改名出不来」。
// 纯函数零依赖：命中返回 ASCII，未命中返回 null（调用方原样发送）。

const SPECIAL = new Map([
  ["￥", "$"], ["¥", "$"],
  ["“", '"'], ["”", '"'], ["‘", "'"], ["’", "'"],
  ["、", "\\"], ["。", "."],
  ["《", "<"], ["》", ">"], ["〈", "<"], ["〉", ">"],
  ["【", "["], ["】", "]"], ["「", "["], ["」", "]"], ["〔", "["], ["〕", "]"],
  ["……", "^"], ["…", "^"], ["——", "_"], ["—", "_"],
  ["·", "`"], ["\u3000", " "],
]);

/** @param {string} s @returns {string | null} */
export function imePunctToAscii(s) {
  const hit = SPECIAL.get(s);
  if (hit !== undefined) return hit;
  // 全角 ASCII 区（U+FF01–U+FF5E ↔ U+0021–U+007E，固定偏移）：！＂＃＄％…～ 与全角字母数字
  if (s.length === 1) {
    const c = s.charCodeAt(0);
    if (c >= 0xff01 && c <= 0xff5e) return String.fromCharCode(c - 0xfee0);
  }
  return null;
}
