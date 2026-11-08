// 十九轮：命令面板（⌘K / Ctrl+K）——应用内动作的键盘直达层。
// 条目由 App 按当前状态构建（sessions/hosts/外观等），本组件只管过滤、键盘
// 导航与分组渲染；执行 = onClose 后再 run（避免面板 DOM 残留时切焦点）。
import { useEffect, useMemo, useRef, useState } from "react";
import { t } from "./i18n";

export interface PaletteItem {
  id: string;
  title: string;
  /** 右侧弱化说明（快捷键提示 / 主机地址 / 会话状态等） */
  hint?: string;
  /** 分组标题（会话 / 连接 / 当前会话 / 应用），按首次出现排序 */
  group: string;
  /** 参与匹配的补充词（不放主标题的别名，如 host id、英文别名） */
  keywords?: string;
  danger?: boolean;
  run: () => void;
}

export function CommandPalette({ open, items, onClose }: {
  open: boolean;
  items: PaletteItem[];
  onClose: () => void;
}) {
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (open) {
      setQ("");
      setSel(0);
      setTimeout(() => inputRef.current?.focus(), 0);
    }
  }, [open]);

  const filtered = useMemo(() => {
    const s = q.trim().toLowerCase();
    if (!s) return items;
    return items.filter((it) =>
      (it.title + " " + (it.keywords ?? "") + " " + it.group).toLowerCase().includes(s));
  }, [items, q]);

  useEffect(() => { setSel(0); }, [q]);
  useEffect(() => {
    listRef.current?.querySelector('[data-sel="1"]')?.scrollIntoView({ block: "nearest" });
  }, [sel, filtered]);

  if (!open) return null;

  const run = (it: PaletteItem) => {
    onClose();
    // 关闭先行、执行延后：attachSession 等动作要落焦点到终端，面板不能在场
    setTimeout(() => it.run(), 0);
  };
  const onKeyDown = (e: React.KeyboardEvent) => {
    // IME 双查（§7.3 全仓口径，六轮 BF-4）：组合期方向键是候选词导航不能劫持、
    // Enter 是确认候选词不能直跑选中项（macOS WebKit 系组合期仍上抛真实 key 名）
    if (e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229) return;
    if (e.key === "ArrowDown") { e.preventDefault(); setSel((v) => Math.min(v + 1, filtered.length - 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setSel((v) => Math.max(v - 1, 0)); }
    else if (e.key === "Enter") {
      e.preventDefault();
      const it = filtered[sel];
      if (it) run(it);
    } else if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    }
  };
  // 焦点陷阱（审计 P2）：面板是 z-index 90 的视觉模态，但此前只有搜索框绑了
  // ↑↓/Enter/Esc——Tab 一次就把焦点送给背后的主机栏/标签，方向键与 Esc 全部失效。
  // 在面板根接住 Tab 循环；Esc 兜底（输入框未持焦时也能关）。
  const trapKey = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.defaultPrevented) return;
    if (e.key === "Escape") { e.preventDefault(); onClose(); return; }
    if (e.key !== "Tab") return;
    const root = e.currentTarget;
    const focusables = Array.from(root.querySelectorAll<HTMLElement>(
      'input, button:not(:disabled), [tabindex]:not([tabindex="-1"])',
    )).filter((el) => el.offsetParent !== null);
    if (focusables.length === 0) return;
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    const cur = document.activeElement as HTMLElement | null;
    if (!cur || !root.contains(cur)) { e.preventDefault(); first.focus(); return; }
    if (e.shiftKey && cur === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && cur === last) { e.preventDefault(); first.focus(); }
  };

  // 分组按首次出现排序；空结果给可行动文案
  const groups: { name: string; rows: { it: PaletteItem; i: number }[] }[] = [];
  filtered.forEach((it, i) => {
    let g = groups.find((x) => x.name === it.group);
    if (!g) { g = { name: it.group, rows: [] }; groups.push(g); }
    g.rows.push({ it, i });
  });

  return (
    <div className="palette-overlay" data-testid="palette-overlay"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="palette" role="dialog" aria-modal="true" aria-label={t("命令面板")} onKeyDown={trapKey}>
        <input
          ref={inputRef}
          className="palette-input"
          data-testid="palette-input"
          aria-label={t("命令面板搜索")}
          spellCheck={false}
          value={q}
          placeholder={t("搜索会话、主机与命令…（↑↓ 选择，Enter 执行，Esc 关闭）")}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={onKeyDown}
        />
        <div className="palette-list" ref={listRef}>
          {filtered.length === 0 && (
            <div className="dim" style={{ padding: "10px 12px" }}>{t("无匹配——试试会话名、主机地址或「设置」「快速连接」。")}</div>
          )}
          {groups.map((g) => (
            <div key={g.name}>
              <div className="palette-group">{g.name}</div>
              {g.rows.map(({ it, i }) => (
                <button
                  key={it.id}
                  className={"palette-item" + (i === sel ? " palette-sel" : "") + (it.danger ? " palette-danger" : "")}
                  data-sel={i === sel ? "1" : "0"}
                  data-testid={"palette-item-" + it.id}
                  onMouseEnter={() => setSel(i)}
                  onClick={() => run(it)}
                >
                  <span className="palette-title">{it.title}</span>
                  {it.hint && <span className="palette-hint">{it.hint}</span>}
                </button>
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
