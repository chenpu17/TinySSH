// 键位配置（直键轮 2026-10-14）：快捷键解析唯一事实源仍是 actions.ts 的 resolveAction，
// 本模块只管「可重绑动作」的键位表——默认值、KV 序列化（ui.keymap.v1）、keydown 匹配、
// 冲突检测与展示格式。七个可配置动作都是「主修饰键（⌘/Ctrl）+ 单字母」形；
// Ctrl+1-9 切标签、Ctrl+Tab 循环、Ctrl/⌘±0 缩放、F11 专注模式、Esc 浮层链为固定键位
// 不开放改绑
// （浏览器/系统惯例冲突面大；数字键与 1-9 切标签撞车，故字符限字母）。
// 存储平台中立：binding.primary 表示 ⌘（mac）或 Ctrl（Win/Linux），匹配时按平台解析。

export type KeyActionId =
  | "tab-new"
  | "tab-close"
  | "term-local"
  | "split-toggle"
  | "palette"
  | "hostbar"
  | "search";

export type Binding = {
  /** 主键字母（小写 a-z；数字与命名键不开放——数字撞 Ctrl+1-9 切标签） */
  key: string;
  /** 主修饰键：mac=⌘(metaKey)、Win/Linux=Ctrl(ctrlKey) */
  primary: boolean;
  shift: boolean;
  /** v1 不支持 Alt 组合：Alt+字母 在终端聚焦下被 Meta 序列转发层先截（⌥=readline 词跳转） */
  alt: boolean;
};

export const KEYMAP_SETTING = "ui.keymap.v1";

const BASE_KEYMAP: Record<KeyActionId, Binding> = {
  "tab-new": { key: "t", primary: true, shift: false, alt: false },
  "tab-close": { key: "w", primary: true, shift: false, alt: false },
  // 本地终端一等公民轮：Shift 区分「新建连接表单」（Ctrl+T）与「直接开本地终端」
  "term-local": { key: "t", primary: true, shift: true, alt: false },
  "split-toggle": { key: "d", primary: true, shift: false, alt: false },
  palette: { key: "k", primary: true, shift: false, alt: false },
  hostbar: { key: "b", primary: true, shift: false, alt: false },
  search: { key: "f", primary: true, shift: false, alt: false },
};

// tmux 前缀优先（2026-11-02 拍板：Ctrl+B 是 tmux 的关键按键，有冲突让其他动作改）。
// Win/Linux 的主修饰键就是 Ctrl：Ctrl+B 一旦在表内，控制字符直发层按表豁免，主视图与
// tmux 格子永远收不到 \x02。故 Win/Linux 主机栏默认改 Ctrl+Shift+B（Windows Terminal
// 惯例：应用动作走 Ctrl+Shift、Ctrl+字母 留给 shell），并把 Ctrl+B 列为终端保留键——
// 持久化旧表里的 Ctrl+B 载入即回落默认、录键器拒收。mac 主修饰键是 ⌘，⌘B 不动。
export function defaultKeymap(mac: boolean): Record<KeyActionId, Binding> {
  if (mac) return { ...BASE_KEYMAP };
  return { ...BASE_KEYMAP, hostbar: { key: "b", primary: true, shift: true, alt: false } };
}

/** 终端保留键：该组合不得进键位表（Win/Linux 的 Ctrl+B = tmux 默认前缀）。 */
export function terminalReserved(b: Binding, mac: boolean): boolean {
  return !mac && b.primary && !b.shift && !b.alt && b.key === "b";
}

/**
 * 控制字符直发层的豁免判定：组合被键位表占用 → 不编码 C0 直发终端、交给动作层。
 * 终端保留键无条件不豁免（表里混进旧值也不吞 tmux 前缀）。
 */
export function exemptFromTerminal(map: Record<KeyActionId, Binding>, b: Binding, mac: boolean): boolean {
  if (terminalReserved(b, mac)) return false;
  return Object.values(map).some((x) => sameBinding(x, b));
}

export const KEYMAP_ACTIONS: { id: KeyActionId; label: string; desc: string }[] = [
  { id: "tab-new", label: "新建连接", desc: "打开主机栏添加表单" },
  { id: "tab-close", label: "关闭当前标签", desc: "活动会话先确认影响" },
  { id: "term-local", label: "新建本地终端", desc: "直接连接「本机」开本地 shell" },
  { id: "split-toggle", label: "分屏 / 退出分屏", desc: "未分屏时弹会话选择（左右/上下方向）" },
  { id: "palette", label: "命令面板", desc: "命令与跳转" },
  { id: "hostbar", label: "主机栏开关", desc: "表单编辑焦点下不劫持" },
  { id: "search", label: "搜索终端内容", desc: "当前会话缓冲内查找" },
];

const LONE_MODIFIERS = new Set(["Control", "Shift", "Alt", "Meta"]);
const KEY_RE = /^[a-z]$/;

/**
 * keydown → Binding。不构成可记录组合返回 null：lone modifier（等待组合齐）、
 * 非单字符命名键、数字。IME 组合期 key 可能是 "Process"——按物理键位 ev.code 兜底
 * （KeyT→t；注入器/RDP 的 keydown 可能缺 scan code，code 不可用时自然返回 null）。
 */
export function bindingOf(
  ev: { key: string; code?: string; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean; altKey: boolean },
  mac: boolean,
): Binding | null {
  if (LONE_MODIFIERS.has(ev.key)) return null;
  let key: string | null = ev.key.length === 1 ? ev.key.toLowerCase() : null;
  if (!key && ev.code?.startsWith("Key")) key = ev.code.slice(3).toLowerCase();
  if (!key || !KEY_RE.test(key)) return null;
  return { key, primary: mac ? ev.metaKey : ev.ctrlKey, shift: ev.shiftKey, alt: ev.altKey };
}

export function sameBinding(a: Binding, b: Binding): boolean {
  return a.key === b.key && a.primary === b.primary && a.shift === b.shift && a.alt === b.alt;
}

/** 存量自定义因让位默认值被改回默认：哪个动作、原设什么、让给了谁（载入时一次性告知用）。 */
export type KeymapLost = { id: KeyActionId; was: Binding; by: KeyActionId };

/**
 * 解析持久化串（覆盖默认表）。两遍、按终态判冲突（与表序无关）：
 * ① 收存量里的合法自定义——非法/无主修饰键/带 Alt/终端保留键、或与表序在前的自定义撞键 → 丢；
 * ② 缺项与被丢项补默认；默认值与留下的自定义撞键时默认优先，该自定义回落它自己的默认
 *    （迭代到稳定：默认表自身无冲突，每轮至少少一个自定义，必收敛）。
 * 旧实现逐条与「尚未覆盖的默认值」比较：合法对调两个键、或主机栏已改别的键而另一动作
 * 用了主机栏的默认键，重载即被误丢。录键器整表落盘，旧版 Win/Linux 存量表里的 hostbar
 * 是 Ctrl+B——走保留键分支回落 Ctrl+Shift+B，即为迁移。
 */
export function parseKeymapReport(raw: string | null | undefined, mac: boolean): { map: Record<KeyActionId, Binding>; lost: KeymapLost[] } {
  const defaults = defaultKeymap(mac);
  if (!raw) return { map: defaults, lost: [] };
  let obj: Record<string, Partial<Binding> | undefined>;
  try {
    obj = JSON.parse(raw) as Record<string, Partial<Binding> | undefined>;
  } catch {
    return { map: defaults, lost: [] }; // 坏串回落全默认
  }
  if (!obj || typeof obj !== "object") return { map: defaults, lost: [] };
  const custom = new Map<KeyActionId, Binding>();
  for (const { id } of KEYMAP_ACTIONS) {
    const v = obj[id];
    if (!v || typeof v.key !== "string" || !KEY_RE.test(v.key)) continue;
    const b: Binding = { key: v.key, primary: v.primary === true, shift: v.shift === true, alt: v.alt === true };
    if (!b.primary || b.alt || terminalReserved(b, mac)) continue;
    if ([...custom.values()].some((x) => sameBinding(x, b))) continue;
    custom.set(id, b);
  }
  const lost: KeymapLost[] = [];
  for (let moved = true; moved;) {
    moved = false;
    for (const [id, b] of custom) {
      const by = KEYMAP_ACTIONS.find(({ id: o }) => o !== id && !custom.has(o) && sameBinding(defaults[o], b))?.id;
      if (!by) continue;
      custom.delete(id);
      if (!sameBinding(b, defaults[id])) lost.push({ id, was: b, by });
      moved = true;
    }
  }
  const map = { ...defaults };
  for (const [id, b] of custom) map[id] = b;
  return { map, lost };
}

export function parseKeymap(raw: string | null | undefined, mac: boolean): Record<KeyActionId, Binding> {
  return parseKeymapReport(raw, mac).map;
}

/** 该组合是否已被其它动作占用；返回占用者 id（无则 null）。 */
export function conflictOf(
  map: Record<KeyActionId, Binding>,
  self: KeyActionId,
  b: Binding,
): KeyActionId | null {
  for (const { id } of KEYMAP_ACTIONS) {
    if (id !== self && sameBinding(map[id], b)) return id;
  }
  return null;
}

/** 展示格式：mac ⌘⇧T / 其余 Ctrl+Shift+T（主修饰键恒在场）。 */
export function formatBinding(b: Binding, mac: boolean): string {
  if (!b.primary) return b.key.toUpperCase();
  if (mac) return `⌘${b.alt ? "⌥" : ""}${b.shift ? "⇧" : ""}${b.key.toUpperCase()}`;
  return `Ctrl+${b.alt ? "Alt+" : ""}${b.shift ? "Shift+" : ""}${b.key.toUpperCase()}`;
}
