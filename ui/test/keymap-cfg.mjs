// 键位配置（键位配置轮）模块单测：parseKeymap 校验回落、conflictOf、formatBinding、
// bindingOf（lone modifier / IME Process 键 code 兜底 / 数字与命名键拒收）。
// 直接 import src/keymap.ts（node --experimental-strip-types，零复制）。
// 用法：node --experimental-strip-types test/keymap-cfg.mjs （退出码非 0 = 有失败）
import {
  defaultKeymap, KEYMAP_ACTIONS, parseKeymap, parseKeymapReport, conflictOf, formatBinding, bindingOf, terminalReserved, exemptFromTerminal,
} from "../src/keymap.ts";

const WIN = defaultKeymap(false);
const MAC = defaultKeymap(true);

let fail = 0;
const expect = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fail++;
  console.log(`${ok ? "✓" : "✗"} ${name}${ok ? "" : `  got=${JSON.stringify(got)} want=${JSON.stringify(want)}`}`);
};

// ---- parseKeymap：默认表 / 合法覆盖 / 非法条目回落 / 冲突回落 ----
expect("空串→全默认", parseKeymap("", false), WIN);
expect("null→全默认", parseKeymap(null, false), WIN);
expect("坏 JSON→全默认", parseKeymap("{oops", false), WIN);
const reb = parseKeymap(JSON.stringify({ search: { key: "j", primary: true, shift: false, alt: false } }), false);
expect("合法覆盖 search→j", [reb.search.key, reb.palette.key], ["j", "k"]);
expect("覆盖只动目标动作（tab-new 仍 t）", reb["tab-new"].key, "t");
const bad = parseKeymap(JSON.stringify({
  search: { key: "1", primary: true, shift: false, alt: false },          // 数字拒收（撞 Ctrl+1-9）
  hostbar: { key: "j", primary: false, shift: false, alt: false },        // 无主修饰键拒收
  palette: { key: "p", primary: true, shift: false, alt: true },          // Alt 拒收
  "tab-new": { key: "zz", primary: true, shift: false, alt: false },      // 非单字符拒收
}), false);
expect("非法条目逐条回落默认", [bad.search.key, bad.hostbar.key, bad.palette.key, bad["tab-new"].key], ["f", "b", "k", "t"]);
const clash = parseKeymap(JSON.stringify({
  search: { key: "j", primary: true, shift: false, alt: false },
  palette: { key: "j", primary: true, shift: false, alt: false },         // 与 search 冲突→按表序 palette 在前保留，search 回落 f
}), false);
expect("持久化层冲突按表序保留、后到者回落", [clash.search.key, clash.palette.key], ["f", "j"]);

// ---- conflictOf ----
const m1 = parseKeymap(null, false);
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

// ---- tmux 前缀优先（Win/Linux 的 Ctrl+B 留给终端）----
const CTRL_B = { key: "b", primary: true, shift: false, alt: false };
const CTRL_SHIFT_B = { ...CTRL_B, shift: true };
expect("Win/Linux 默认主机栏=Ctrl+Shift+B", formatBinding(WIN.hostbar, false), "Ctrl+Shift+B");
expect("mac 默认主机栏仍 ⌘B", formatBinding(MAC.hostbar, true), "⌘B");
expect("Ctrl+B 在 Win/Linux 是终端保留键", terminalReserved(CTRL_B, false), true);
expect("mac 的 ⌘B 不是保留键", terminalReserved(CTRL_B, true), false);
expect("Ctrl+Shift+B 不是保留键", terminalReserved(CTRL_SHIFT_B, false), false);
// 旧版整表落盘（录键器 JSON.stringify 整个表）：hostbar 存着 Ctrl+B，用户另把 search 改成了 J
const legacy = parseKeymap(JSON.stringify({ ...MAC, search: { key: "j", primary: true, shift: false, alt: false } }), false);
expect("存量旧表 hostbar=Ctrl+B 载入迁移为 Ctrl+Shift+B，其余改绑保留",
  [formatBinding(legacy.hostbar, false), legacy.search.key], ["Ctrl+Shift+B", "j"]);
expect("任何动作改绑到 Ctrl+B 都回落默认", parseKeymap(JSON.stringify({ search: CTRL_B }), false).search.key, "f");
expect("mac 存量 ⌘B 原样保留", formatBinding(parseKeymap(JSON.stringify({ hostbar: CTRL_B }), true).hostbar, true), "⌘B");
expect("直发层：Ctrl+B 不豁免（直达主视图/格子）", exemptFromTerminal(WIN, CTRL_B, false), false);
expect("直发层：表里混进旧 Ctrl+B 也不豁免", exemptFromTerminal({ ...WIN, hostbar: CTRL_B }, CTRL_B, false), false);
expect("直发层：Ctrl+Shift+B 豁免（归主机栏）", exemptFromTerminal(WIN, CTRL_SHIFT_B, false), true);
expect("直发层：Ctrl+K 豁免（命令面板）", exemptFromTerminal(WIN, { key: "k", primary: true, shift: false, alt: false }, false), true);
expect("直发层：未绑定的 Ctrl+E 不豁免", exemptFromTerminal(WIN, { key: "e", primary: true, shift: false, alt: false }, false), false);

// ---- 两遍解析：冲突按终态判定（审查轮二 P2：旧实现与「尚未覆盖的默认值」逐条比较）----
const K = (key, shift = false) => ({ key, primary: true, shift, alt: false });
const fmtW = (b) => formatBinding(b, false);
const B1 = parseKeymapReport(JSON.stringify({ ...WIN, hostbar: K("h"), palette: CTRL_SHIFT_B }), false);
expect("主机栏已改 Ctrl+H、命令面板用 Ctrl+Shift+B：两条自定义都保留（表序在前也不被默认值误丢）",
  [fmtW(B1.map.hostbar), fmtW(B1.map.palette), B1.lost.length], ["Ctrl+H", "Ctrl+Shift+B", 0]);
const C1 = parseKeymapReport(JSON.stringify({ ...WIN, hostbar: K("h"), search: CTRL_SHIFT_B }), false);
expect("同上（表序在后）", [fmtW(C1.map.hostbar), fmtW(C1.map.search), C1.lost.length], ["Ctrl+H", "Ctrl+Shift+B", 0]);
const D1 = parseKeymapReport(JSON.stringify({ ...WIN, palette: K("f"), search: K("k") }), false);
expect("合法对调命令面板↔搜索：重载两条都保留", [fmtW(D1.map.palette), fmtW(D1.map.search), D1.lost.length], ["Ctrl+F", "Ctrl+K", 0]);
const A1 = parseKeymapReport(JSON.stringify({ ...WIN, hostbar: CTRL_B, search: CTRL_SHIFT_B }), false);
expect("存量 hostbar=Ctrl+B 迁到 Ctrl+Shift+B、该键被搜索占用：默认优先，搜索回默认并上报",
  [fmtW(A1.map.hostbar), fmtW(A1.map.search), A1.lost.map((l) => `${l.id}:${fmtW(l.was)}→${l.by}`)],
  ["Ctrl+Shift+B", "Ctrl+F", ["search:Ctrl+Shift+B→hostbar"]]);
const E1 = parseKeymapReport(JSON.stringify({ ...WIN, hostbar: CTRL_B, search: CTRL_SHIFT_B, palette: K("f") }), false);
expect("连锁让位：搜索回 Ctrl+F 又撞命令面板的自定义 Ctrl+F → 命令面板也回默认，两条都上报",
  [fmtW(E1.map.search), fmtW(E1.map.palette), E1.lost.map((l) => l.id).sort()], ["Ctrl+F", "Ctrl+K", ["palette", "search"]]);
expect("迁移本身（hostbar Ctrl+B→Ctrl+Shift+B）不算自定义丢失", parseKeymapReport(JSON.stringify({ ...WIN, hostbar: CTRL_B }), false).lost, []);
expect("parseKeymap 与 parseKeymapReport.map 同一结果", parseKeymap(JSON.stringify({ ...WIN, hostbar: CTRL_B, search: CTRL_SHIFT_B }), false), A1.map);
// 性质：任意存量表（含非法/保留/重复/缺项）解析后终态无冲突、不含保留键
{
  let seed = 7;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  const letters = "abcdefghijkt";
  let bad = 0;
  for (let i = 0; i < 3000; i++) {
    const obj = {};
    for (const { id } of KEYMAP_ACTIONS) {
      if (rnd() < 0.15) continue;
      obj[id] = { key: rnd() < 0.05 ? "1" : letters[Math.floor(rnd() * letters.length)], primary: rnd() < 0.95, shift: rnd() < 0.4, alt: rnd() < 0.05 };
    }
    for (const isMac of [false, true]) {
      const { map } = parseKeymapReport(JSON.stringify(obj), isMac);
      const clash = KEYMAP_ACTIONS.some(({ id }) => conflictOf(map, id, map[id]));
      const reserved = KEYMAP_ACTIONS.some(({ id }) => terminalReserved(map[id], isMac));
      if (clash || reserved) bad++;
    }
  }
  expect("性质：3000 张随机存量表 × 双平台，解析终态无冲突且不含保留键", bad, 0);
}

// ---- 表完整性哨兵 ----
for (const [name, m, isMac] of [["Win/Linux", WIN, false], ["mac", MAC, true]]) {
  expect(`${name} 七动作默认绑定互不冲突`, KEYMAP_ACTIONS.filter(({ id }) => conflictOf(m, id, m[id])).map((x) => x.id), []);
  expect(`${name} 默认表不含终端保留键`, KEYMAP_ACTIONS.filter(({ id }) => terminalReserved(m[id], isMac)).map((x) => x.id), []);
}

console.log(fail === 0 ? "\n✓ keymap 模块全部通过" : `\n✗ ${fail} 项失败`);
process.exit(fail === 0 ? 0 : 1);
