// tmux 快接钮（会话工具栏与专注模式标签条共用）：主动接入远端 tmux 的唯一
// 常驻入口。抽成独立组件是为了让专注模式（会话工具栏隐藏）仍保留这个一级
// 功能，同时避免两处菜单状态/锚点各写一份。
import type { Dispatch, SetStateAction } from "react";
import type { SessionInfo } from "../adapter/wire";
import { t } from "../i18n";
import { IconChevronDown, IconPlus, IconTerminal } from "../icons";

export interface TmuxQuickProps {
  current: SessionInfo;
  sid: string | null;
  tmuxMenu: boolean;
  setTmuxMenu: Dispatch<SetStateAction<boolean>>;
  tmuxMenuRef: { current: HTMLDivElement | null };
  onRefreshTmux: () => void;
  onPickTmux: (name: string) => void;
  onPromotePaneToMain: (name: string) => void;
  onAddTmuxPane: (name: string) => void;
  onOpenWall: () => void;
  tmuxCreateOpen: boolean;
  tmuxCreateName: string;
  tmuxCreateErr: string | null;
  tmuxCreateBusy: boolean;
  tmuxCreateTarget: "main" | "panel";
  onTmuxCreateTarget: (v: "main" | "panel") => void;
  onTmuxCreateOpen: () => void;
  onTmuxCreateCancel: () => void;
  onTmuxCreateName: (v: string) => void;
  onTmuxCreateSubmit: () => void;
  paneNames: string[];
  paneCapReached: boolean;
  splitActive: boolean;
}

export function TmuxQuick({
  current, sid, tmuxMenu, setTmuxMenu, tmuxMenuRef, onRefreshTmux,
  onPickTmux, onPromotePaneToMain, onAddTmuxPane, onOpenWall,
  tmuxCreateOpen, tmuxCreateName, tmuxCreateErr, tmuxCreateBusy,
  tmuxCreateTarget, onTmuxCreateTarget,
  onTmuxCreateOpen, onTmuxCreateCancel, onTmuxCreateName, onTmuxCreateSubmit,
  paneNames, paneCapReached, splitActive,
}: TmuxQuickProps) {
  if (!sid || current.kind !== "ssh" || !current.tmux?.available) return null;
  // 作曲行「开进面板」的禁用原因：与「＋面板」同一套口径（分屏互斥/格数到顶），
  // 写进 title 不让人猜；禁用只是前端预判，真值仍由核心防呆兜底
  const createPanelWhy = splitActive ? t("分屏模式下不可并入面板——请先退出分屏")
    : paneCapReached ? t("面板最多 {0} 个窗格", "5")
    : null;
  return (
    <div className="st-tools" ref={tmuxMenuRef} data-testid="tmux-quick">
      <button
        className={"ghost tmux-quick-btn" + (tmuxMenu ? " ts-open" : "")}
        aria-haspopup="menu"
        aria-expanded={tmuxMenu}
        title={current.tmux_attached
          ? t("tmux：已接入 {0}——点开可切换到其他会话", current.tmux_attached)
          : t("接入 tmux 会话：列出远端在跑的 tmux 会话，点选即恢复现场")}
        onClick={() => {
          const next = !tmuxMenu;
          setTmuxMenu(next);
          if (next) onRefreshTmux();
        }}
      ><IconTerminal size={13} /><span className="tmux-quick-label">{current.tmux_attached ? `tmux:${current.tmux_attached}` : "tmux"}</span><IconChevronDown size={10} /></button>
      {tmuxMenu && (
        <div className="tools-menu tmux-quick-menu" role="menu" data-testid="tmux-quick-menu">
          {/* 会话大屏（监控墙）：全部会话快照网格（单击放大可直接键入）。挂在
              清单上方——它是「看全部」的一级动作，与逐个接入的清单项并存 */}
          {(current.tmux?.sessions ?? []).length > 0 && (
            <button
              role="menuitem"
              className="tmux-wall-entry"
              data-testid="tmux-wall-open"
              title={t("会话大屏：全部 tmux 会话的快照墙——单击小窗直接键入（服务端 send-keys）；深度操作「进格子」")}
              onClick={() => onOpenWall()}
            >{t("会话大屏…")}</button>
          )}

          {/* 新建 tmux 会话：远端 new-session -d，不必先去终端手敲。作曲行
              内嵌菜单（Enter 提交 / Esc 取消），错误就地 role=alert 展示；
              成功后 App 侧刷新清单并按目标接入主视图或直接开进面板。 */}
          {tmuxCreateOpen ? (
            <>
              <div className="tmux-create-row" data-testid="tmux-create-row">
                <input
                  className="tmux-create-input"
                  data-testid="tmux-create-input"
                  autoFocus
                  value={tmuxCreateName}
                  maxLength={64}
                  placeholder={t("会话名（字母/数字/中文/下划线开头）")}
                  aria-label={t("新建 tmux 会话")}
                  aria-invalid={!!tmuxCreateErr}
                  onKeyDown={(e) => {
                    // IME 组合期 Enter 是确认候选词，不提交（标签重命名/⌘K 同口径）
                    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
                    if (e.key === "Enter") { e.preventDefault(); onTmuxCreateSubmit(); }
                    else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); onTmuxCreateCancel(); }
                  }}
                  onChange={(e) => onTmuxCreateName(e.target.value)}
                />
                <button
                  className="tmux-create-ok"
                  data-testid="tmux-create-ok"
                  disabled={tmuxCreateBusy || !tmuxCreateName.trim()}
                  title={tmuxCreateTarget === "panel" ? t("创建并开进面板") : t("创建并接入")}
                  onClick={onTmuxCreateSubmit}
                >{t("创建")}</button>
                <button
                  className="ghost"
                  data-testid="tmux-create-cancel"
                  title={t("取消")}
                  onClick={onTmuxCreateCancel}
                >{t("取消")}</button>
              </div>
              {/* 目标单选（建好落在哪）：默认主视图=旧行为。鼠标点选不夺输入框
                  焦点（mousedown 拦默认），选完仍可直接 Enter 提交 */}
              <div
                className="tmux-create-target"
                role="radiogroup"
                aria-label={t("创建后显示在")}
                data-testid="tmux-create-target"
              >
                <button
                  role="radio"
                  aria-checked={tmuxCreateTarget === "main"}
                  data-testid="tmux-create-target-main"
                  className={tmuxCreateTarget === "main" ? "on" : undefined}
                  title={t("创建后接入主视图（当前行为）")}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => onTmuxCreateTarget("main")}
                >{t("接入主视图")}</button>
                <button
                  role="radio"
                  aria-checked={tmuxCreateTarget === "panel"}
                  data-testid="tmux-create-target-panel"
                  className={tmuxCreateTarget === "panel" ? "on" : undefined}
                  disabled={!!createPanelWhy}
                  title={createPanelWhy ?? t("创建后直接开进本标签的面板窗格（不占用主视图）")}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => onTmuxCreateTarget("panel")}
                >{t("开进面板")}</button>
              </div>
              {tmuxCreateErr && (
                <div className="tmux-create-err" role="alert" data-testid="tmux-create-err">{tmuxCreateErr}</div>
              )}
            </>
          ) : (
            <button
              role="menuitem"
              className="tmux-wall-entry"
              data-testid="tmux-create-open"
              title={t("新建 tmux 会话：在远端直接 tmux new-session（分离创建，不抢任何屏幕），建好可接入主视图或直接开进面板")}
              onClick={onTmuxCreateOpen}
            ><IconPlus size={14} />{t("新建 tmux 会话…")}</button>
          )}

          {(current.tmux?.sessions ?? []).map((ms) => {
            const isMain = current.tmux_attached === ms.name;
            const inPane = paneNames.includes(ms.name);
            // 「＋面板」：同一会话不做两路视图（主视图在看/已在格子里），分屏与
            // 面板互斥，格数到顶禁用——禁用原因写进 title，不让人猜
            const addWhy = isMain ? t("该会话正显示在主视图")
              : inPane ? t("该会话已在面板中")
              : splitActive ? t("分屏模式下不可并入面板——请先退出分屏")
              : paneCapReached ? t("面板最多 {0} 个窗格", "5")
              : null;
            return (
              <div className="tmux-quick-row" key={ms.name}>
                <button
                  role="menuitem"
                  data-testid={"tmux-quick-item-" + ms.name}
                  title={inPane ? t("从面板收格并切到主视图（只断开面板视图，tmux 会话继续运行）") : undefined}
                  onClick={() => (inPane ? onPromotePaneToMain(ms.name) : onPickTmux(ms.name))}
                >{t("{0}（{1} 窗口）", ms.name, String(ms.windows))}{isMain ? ` · ${t("当前")}` : inPane ? ` · ${t("面板中")}` : ""}</button>
                <button
                  role="menuitem"
                  className="tmux-pane-add"
                  data-testid={"tmux-pane-add-" + ms.name}
                  disabled={!!addWhy}
                  title={addWhy ?? t("并入面板：在本标签里与主视图并排显示该会话（独立通道，主视图不受影响）")}
                  onClick={() => onAddTmuxPane(ms.name)}
                >{t("＋面板")}</button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
