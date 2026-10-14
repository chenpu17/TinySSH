// 键位配置（直键轮 2026-10-14）：快捷键解析唯一事实源仍是 actions.ts 的 resolveAction，
// 本模块只管「可重绑动作」的键位表——默认值、KV 序列化（ui.keymap.v1）、keydown 匹配、
// 冲突检测与展示格式。六个可配置动作都是「主修饰键（⌘/Ctrl）+ 单字母」形；
// Ctrl+1-9 切标签、Ctrl+Tab 循环、Ctrl/⌘±0 缩放、Esc 浮层链为固定键位不开放改绑
// （浏览器/系统惯例冲突面大；数字键与 1-9 切标签撞车，故字符限字母）。
// 存储平台中立：binding.primary 表示 ⌘（mac）或 Ctrl（Win/Linux），匹配时按平台解析。

export type KeyActionId =
  | "tab-new"
  | "tab-close"
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

export const DEFAULT_KEYMAP: Record<KeyActionId, Binding> = {
  "tab-new": { key: "t", primary: true, shift: false, alt: false },
  "tab-close": { key: "w", primary: true, shift: false, alt: false },
  "split-toggle": { key: "d", primary: true, shift: false, alt: false },
  palette: { key: "k", primary: true, shift: false, alt: false },
  hostbar: { key: "b", primary: true, shift: false, alt: false },
  search: { key: "f", primary: true, shift: false, alt: false },
};

export const KEYMAP_ACTIONS: { id: KeyActionId; label: string; desc: string }[] = [
  { id: "tab-new", label: "新建连接", desc: "打开主机栏添加表单" },
  { id: "tab-close", label: "关闭当前标签", desc: "活动会话先确认影响" },
  { id: "split-toggle", label: "分屏 / 退出分屏", desc: "未分屏时弹右侧会话选择" },
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

/** 解析持久化串（覆盖默认表）：逐条校验，非法/无主修饰键/带 Alt/与他条冲突的条目回落默认。 */
export function parseKeymap(raw: string | null | undefined): Record<KeyActionId, Binding> {
  const map: Record<KeyActionId, Binding> = { ...DEFAULT_KEYMAP };
  if (!raw) return map;
  try {
    const obj = JSON.parse(raw) as Record<string, Partial<Binding> | undefined>;
    for (const { id } of KEYMAP_ACTIONS) {
      const v = obj[id];
      if (!v || typeof v.key !== "string" || !KEY_RE.test(v.key)) continue;
      const b: Binding = { key: v.key, primary: v.primary === true, shift: v.shift === true, alt: v.alt === true };
      if (!b.primary || b.alt) continue;
      if (Object.values(map).some((x) => sameBinding(x, b))) continue;
      map[id] = b;
    }
  } catch {
    /* 坏串回落全默认 */
  }
  return map;
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
