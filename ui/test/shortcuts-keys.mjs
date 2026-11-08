// 直键三键（UX 六轮）keymap 单测：Ctrl+Shift+T 新建 / Ctrl+Shift+W 关标签 / Ctrl+Shift+D 分屏开关。
// 直接 import src/actions.ts（node --experimental-strip-types 类型擦除，零复制），
// 键对象用最小 shape——resolveAction 只读 isComposing/keyCode/key/code/修饰键五位。
// 用法：node --experimental-strip-types test/shortcuts-keys.mjs （退出码非 0 = 有失败）
import { resolveAction } from "../src/actions.ts";

// 平台钉死为 Win/Linux（Ctrl 为主修饰键）：isMacPlatform 调用期读 navigator——不钉的话在 mac
// 上跑会走 ⌘ 口径，Ctrl 用例全红、⌘ 用例假绿（审查轮二 P3；本单测未接 CI）
Object.defineProperty(globalThis, "navigator", { value: { platform: "Win32", userAgent: "node-test" }, configurable: true, writable: true });

let fail = 0;
const key = (over = {}) => ({
  key: "t", code: "KeyT", ctrlKey: true, metaKey: false, altKey: false,
  shiftKey: false, isComposing: false, keyCode: 0, ...over,
});
const ctx = (over = {}) => ({
  modal: false, native: true, inForm: false,
  hasSessions: true, hasActiveTab: true, ...over,
});
const expect = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fail++;
  console.log(`${ok ? "✓" : "✗"} ${name}${ok ? "" : `  got=${JSON.stringify(got)} want=${JSON.stringify(want)}`}`);
};

// ---- Win/Linux 默认表：应用动作走 Ctrl+Shift+字母，Ctrl+字母 留给 shell ----
// （Windows Terminal 惯例；Ctrl+T/D/W/K 分别是 transpose/shell EOF/werase/kill-line）
expect("原生 Ctrl+T 不归动作（还给 readline transpose）", resolveAction(key(), ctx()), null);
expect("demo Ctrl+T 不劫持（浏览器保留键）", resolveAction(key(), ctx({ native: false })), null);
expect("模态层 Ctrl+T 吞掉不执行", resolveAction(key(), ctx({ modal: true })), null);
expect("表单焦点 Ctrl+T 也不抢编辑键", resolveAction(key(), ctx({ inForm: true })), null);
expect("修复表 Ctrl+Shift+T → tab-new", resolveAction(key({ shiftKey: true, key: "T" }), ctx()), { id: "tab-new" });
expect("⌘T 在 Win/Linux 不是主修饰键组合（不劫持）", resolveAction(key({ ctrlKey: false, metaKey: true }), ctx()), null);
// 本地终端：Ctrl+Shift+L（T 让给新建连接，L=Local 记忆点）
expect("Ctrl+Shift+L → term-local", resolveAction(key({ shiftKey: true, key: "L", code: "KeyL" }), ctx()), { id: "term-local" });
expect("Alt+D 不归动作（Alt 走 Meta 序列）", resolveAction(key({ key: "d", code: "KeyD", altKey: true }), ctx()), null);

// ---- 分屏：Ctrl+Shift+D，需活动会话 ----
expect("原生 Ctrl+Shift+D → split-toggle", resolveAction(key({ key: "D", code: "KeyD", shiftKey: true }), ctx()), { id: "split-toggle" });
expect("无活动会话 Ctrl+Shift+D 不劫持", resolveAction(key({ key: "D", code: "KeyD", shiftKey: true }), ctx({ hasActiveTab: false })), null);

// ---- 关标签：Ctrl+Shift+W，无活动会话保留系统关窗 ----
expect("原生 Ctrl+Shift+W → tab-close", resolveAction(key({ key: "W", code: "KeyW", shiftKey: true }), ctx()), { id: "tab-close" });
expect("无活动会话 Ctrl+Shift+W 放行（保留系统关窗）", resolveAction(key({ key: "W", code: "KeyW", shiftKey: true }), ctx({ hasActiveTab: false })), null);

// ---- 既有键位回归哨兵（防本次改动波及）----
expect("Ctrl+Tab → 标签循环", resolveAction(key({ key: "Tab", code: "Tab" }), ctx()), { id: "tab-cycle", dir: 1 });
expect("Ctrl+1 → 跳标签一", resolveAction(key({ key: "1", code: "Digit1" }), ctx()), { id: "tab-switch", index: 0 });
expect("Ctrl+Shift+K → 命令面板", resolveAction(key({ key: "K", code: "KeyK", shiftKey: true }), ctx()), { id: "palette" });
expect("裸 Ctrl+K 归 shell（readline kill-line）", resolveAction(key({ key: "k", code: "KeyK" }), ctx()), null);
expect("Esc → 浮层链（无条件）", resolveAction(key({ key: "Escape", code: "Escape", ctrlKey: false }), ctx()), { id: "esc" });
expect("IME 组合期不解析", resolveAction(key({ isComposing: true }), ctx()), null);

// ---- tmux 前缀优先：Win/Linux 的 Ctrl+B 不归任何应用动作，主机栏改 Ctrl+Shift+B ----
expect("原生 Ctrl+B 不归动作（tmux 前缀直达终端）", resolveAction(key({ key: "b", code: "KeyB" }), ctx()), null);
expect("原生 Ctrl+Shift+B → 主机栏", resolveAction(key({ key: "B", code: "KeyB", shiftKey: true }), ctx()), { id: "hostbar" });
expect("表单焦点 Ctrl+Shift+B 不劫持（§7.4）", resolveAction(key({ key: "B", code: "KeyB", shiftKey: true }), ctx({ inForm: true })), null);

// ---- 键位表覆盖（键位配置轮）：resolveAction 按 ctx.keymap 解析 ----
const KM_REBIND = {
  ...{},
  "tab-new": { key: "t", primary: true, shift: false, alt: false },
  "tab-close": { key: "w", primary: true, shift: false, alt: false },
  "term-local": { key: "t", primary: true, shift: true, alt: false },
  "split-toggle": { key: "d", primary: true, shift: false, alt: false },
  palette: { key: "k", primary: true, shift: false, alt: false },
  hostbar: { key: "b", primary: true, shift: true, alt: false },
  search: { key: "j", primary: true, shift: false, alt: false }, // search 改绑 Ctrl+J
};
expect("改绑后 Ctrl+J → search", resolveAction(key({ key: "j", code: "KeyJ" }), ctx({ keymap: KM_REBIND })), { id: "search" });
expect("改绑后 Ctrl+F 不再是 search（还给 shell）", resolveAction(key({ key: "f", code: "KeyF" }), ctx({ keymap: KM_REBIND })), null);
const KM_SHIFT = {
  ...KM_REBIND,
  search: { key: "j", primary: true, shift: true, alt: false }, // search 改绑 Ctrl+Shift+J
};
expect("Shift 绑定生效（先于 shift 早退）", resolveAction(key({ key: "j", code: "KeyJ", shiftKey: true }), ctx({ keymap: KM_SHIFT })), { id: "search" });
expect("裸 Ctrl+J（未绑）归 shell", resolveAction(key({ key: "j", code: "KeyJ" }), ctx({ keymap: KM_SHIFT })), null);
expect("Ctrl+Shift+J 未绑时仍归 shell", resolveAction(key({ key: "j", code: "KeyJ", shiftKey: true }), ctx()), null);
expect("⌘J 同义改绑（mac 平台键）", resolveAction(key({ key: "j", code: "KeyJ", ctrlKey: false, metaKey: true }), ctx({ keymap: KM_REBIND })), { id: "search" });
expect("键位表门仍在：demo 改绑不生效", resolveAction(key({ key: "j", code: "KeyJ" }), ctx({ keymap: KM_REBIND, native: false })), null);

console.log(fail === 0 ? "\n✓ 快捷键 keymap 全部通过" : `\n✗ ${fail} 项失败`);
process.exit(fail === 0 ? 0 : 1);
