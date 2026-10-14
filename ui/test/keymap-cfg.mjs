// 键位配置（键位配置轮）模块单测：parseKeymap 校验回落、conflictOf、formatBinding、
// bindingOf（lone modifier / IME Process 键 code 兜底 / 数字与命名键拒收）。
// 直接 import src/keymap.ts（node --experimental-strip-types，零复制）。
// 用法：node --experimental-strip-types test/keymap-cfg.mjs （退出码非 0 = 有失败）
import { DEFAULT_KEYMAP, KEYMAP_ACTIONS, parseKeymap, conflictOf, formatBinding, bindingOf } from "../src/keymap.ts";

let fail = 0;
const expect = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fail++;
  console.log(`${ok ? "✓" : "✗"} ${name}${ok ? "" : `  got=${JSON.stringify(got)} want=${JSON.stringify(want)}`}`);
};

// ---- parseKeymap：默认表 / 合法覆盖 / 非法条目回落 / 冲突回落 ----
expect("空串→全默认", parseKeymap(""), DEFAULT_KEYMAP);
expect("null→全默认", parseKeymap(null), DEFAULT_KEYMAP);
expect("坏 JSON→全默认", parseKeymap("{oops"), DEFAULT_KEYMAP);
const reb = parseKeymap(JSON.stringify({ search: { key: "j", primary: true, shift: false, alt: false } }));
expect("合法覆盖 search→j", [reb.search.key, reb.palette.key], ["j", "k"]);
expect("覆盖只动目标动作（tab-new 仍 t）", reb["tab-new"].key, "t");
const bad = parseKeymap(JSON.stringify({
  search: { key: "1", primary: true, shift: false, alt: false },          // 数字拒收（撞 Ctrl+1-9）
  hostbar: { key: "j", primary: false, shift: false, alt: false },        // 无主修饰键拒收
  palette: { key: "p", primary: true, shift: false, alt: true },          // Alt 拒收
  "tab-new": { key: "zz", primary: true, shift: false, alt: false },      // 非单字符拒收
}));
expect("非法条目逐条回落默认", [bad.search.key, bad.hostbar.key, bad.palette.key, bad["tab-new"].key], ["f", "b", "k", "t"]);
const clash = parseKeymap(JSON.stringify({
  search: { key: "j", primary: true, shift: false, alt: false },
  palette: { key: "j", primary: true, shift: false, alt: false },         // 与 search 冲突→按表序 palette 在前保留，search 回落 f
}));
expect("持久化层冲突按表序保留、后到者回落", [clash.search.key, clash.palette.key], ["f", "j"]);

// ---- conflictOf ----
const m1 = parseKeymap(null);
expect("无冲突→null", conflictOf(m1, "search", { key: "j", primary: true, shift: false, alt: false }), null);
expect("撞 palette→palette", conflictOf(m1, "search", { key: "k", primary: true, shift: false, alt: false }), "palette");
expect("自己撞自己不算冲突", conflictOf(m1, "palette", { key: "k", primary: true, shift: false, alt: false }), null);

// ---- formatBinding ----
expect("Windows 形", formatBinding({ key: "t", primary: true, shift: false, alt: false }, false), "Ctrl+T");
expect("mac 形", formatBinding({ key: "t", primary: true, shift: false, alt: false }, true), "⌘T");
expect("mac Shift 形", formatBinding({ key: "j", primary: true, shift: true, alt: false }, true), "⌘⇧J");
expect("Windows Shift 形", formatBinding({ key: "j", primary: true, shift: true, alt: false }, false), "Ctrl+Shift+J");
expect("无主修饰键只显字母", formatBinding({ key: "x", primary: false, shift: false, alt: false }, false), "X");

// ---- bindingOf ----
const mac = false;
expect("lone modifier→null", bindingOf({ key: "Control", code: "ControlLeft", ctrlKey: true, metaKey: false, shiftKey: false, altKey: false }, mac), null);
expect("数字→null（不撞 Ctrl+1-9）", bindingOf({ key: "1", code: "Digit1", ctrlKey: true, metaKey: false, shiftKey: false, altKey: false }, mac), null);
expect("命名键→null", bindingOf({ key: "Tab", code: "Tab", ctrlKey: true, metaKey: false, shiftKey: false, altKey: false }, mac), null);
expect("字母+Ctrl→binding", bindingOf({ key: "j", code: "KeyJ", ctrlKey: true, metaKey: false, shiftKey: false, altKey: false }, mac), { key: "j", primary: true, shift: false, alt: false });
expect("IME Process 键按 code 兜底", bindingOf({ key: "Process", code: "KeyJ", ctrlKey: true, metaKey: false, shiftKey: false, altKey: false }, mac), { key: "j", primary: true, shift: false, alt: false });
expect("key 单字符不依赖 code（注入器缺 scan code 仍可录）", bindingOf({ key: "j", code: undefined, ctrlKey: true, metaKey: false, shiftKey: false, altKey: false }, mac), { key: "j", primary: true, shift: false, alt: false });
expect("命名键且无 code→null（安全拒收）", bindingOf({ key: "Process", code: undefined, ctrlKey: true, metaKey: false, shiftKey: false, altKey: false }, mac), null);
expect("mac 平台主修饰键=metaKey", bindingOf({ key: "t", code: "KeyT", ctrlKey: false, metaKey: true, shiftKey: false, altKey: false }, true), { key: "t", primary: true, shift: false, alt: false });
expect("mac 真 Ctrl 非主修饰", bindingOf({ key: "t", code: "KeyT", ctrlKey: true, metaKey: false, shiftKey: false, altKey: false }, true), { key: "t", primary: false, shift: false, alt: false });

// ---- 表完整性哨兵 ----
expect("六动作默认绑定互不冲突", KEYMAP_ACTIONS.filter(({ id }) => conflictOf(DEFAULT_KEYMAP, id, DEFAULT_KEYMAP[id])).map((x) => x.id), []);

console.log(fail === 0 ? "\n✓ keymap 模块全部通过" : `\n✗ ${fail} 项失败`);
process.exit(fail === 0 ? 0 : 1);
