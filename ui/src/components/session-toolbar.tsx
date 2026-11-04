// 会话工具栏 40（App.tsx 拆分⑤）：§4.1——活动会话才出现（欢迎页不放失效的终端
// 工具）。识别区（主机名/OSC 标题/状态）、接管双钮、搜索/分屏/tmux 快接（一级
// 特性 accent 显眼 + 新建会话作曲行）/工具菜单。协作/文件/委托入口已下线（右缘
// rb-rail 与 ⌘K 是常驻入口，用户反馈入口重复）。
import type { Dispatch, SetStateAction } from "react";
import type { AppAction } from "../actions";
import type { KeyActionId } from "../keymap";
import type { SessionInfo } from "../adapter/wire";
import { stateLabel } from "../app-data";
import { t } from "../i18n";
import type { SplitPanes } from "../app-data";
import {
  IconChevronDown, IconPlus, IconSearch, IconSplit, IconTerminal,
} from "../icons";

export interface SessionToolbarProps {
  current: SessionInfo;
  sid: string | null;
  /** 可重绑动作的当前键位展示（按钮 title 跟随键位表，不写死 ⌘F/Ctrl+D） */
  keyHint: (id: KeyActionId) => string;
  /** OSC 171 标题（会话内程序上报的窗口标题投影） */
  oscTitles: Record<string, string>;
  hasAgents: boolean;
  owner: string;
  /** 内嵌 Agent 已配模型服务：接管入口的第二把钥匙（无需 MCP 协作配置） */
  embeddedReady: boolean;
  searchOpen: boolean;
  splitMenu: boolean;
  splitPanes: SplitPanes | null;
  toolsOpen: boolean;
  toolsRef: { current: HTMLDivElement | null };
  dispatchRef: { current: (a: AppAction) => boolean };
  setSplitMenu: Dispatch<SetStateAction<boolean>>;
  setToolsOpen: (v: boolean) => void;
  /** 工具菜单内部切面板视图（端口转发/命令块/活动记录——协作/文件已走右缘 rail） */
  setRightPanel: (v: null | "files" | "collab" | "forwards" | "log" | "blocks") => void;
  exitSplit: () => void;
  takeover: () => Promise<void>;
  takeoverStop: () => Promise<void>;
  openSessionDetail: (s: SessionInfo | null | undefined) => Promise<void>;
  toggleSessionLog: (s: SessionInfo) => Promise<void>;
  requestCloseSession: (s: SessionInfo) => void;
  /** P2-a 广播输入：当前勾选数（>0 时菜单项带计数）与浮层打开动作 */
  broadcastArmed: number;
  openBroadcast: () => void;
  /** 本机监控轮：存在非本地会话才提供端口转发入口（纯本机时收起，能力无意义） */
  canForward: boolean;
  /** tmux 快接（恢复现场轮加映）：菜单开合与锚点；onRefreshTmux 开菜单时重探清单 */
  tmuxMenu: boolean;
  setTmuxMenu: Dispatch<SetStateAction<boolean>>;
  tmuxMenuRef: { current: HTMLDivElement | null };
  onPickTmux: (name: string) => void;
  /** 面板中的会话一键切主视图（找茬四轮 D6）：收齐同名窗格再走接入链——
   * 此前 disabled+title「先关窗格」，切回主视图要两跳。 */
  onPromotePaneToMain: (name: string) => void;
  onRefreshTmux: () => void;
  /** tmux 面板（一标签多 tmux 会话）：「＋面板」把该会话并入本标签的格子网格 */
  onAddTmuxPane: (name: string) => void;
  /** tmux 会话大屏（监控墙）：只读快照网格入口（快接菜单顶部，仅 SSH+有 tmux 时渲染） */
  onOpenWall: () => void;
  /** 新建 tmux 会话：菜单内作曲行（开/输名/提交/取消），busy 期间提交钮禁用 */
  tmuxCreateOpen: boolean;
  tmuxCreateName: string;
  tmuxCreateErr: string | null;
  tmuxCreateBusy: boolean;
  onTmuxCreateOpen: () => void;
  onTmuxCreateCancel: () => void;
  onTmuxCreateName: (v: string) => void;
  onTmuxCreateSubmit: () => void;

  /** 已在面板格子里的会话名（菜单标「面板中」，主视图切换与再并入均禁用） */
  paneNames: string[];
  /** 格数到顶（PANE_MAX）：「＋面板」禁用 */
  paneCapReached: boolean;
  /** 分屏中：「＋面板」禁用（面板与分屏互斥，先退出分屏） */
  splitActive: boolean;
}

export function SessionToolbar({
  current, sid, keyHint, oscTitles, hasAgents, owner, embeddedReady,
  searchOpen, splitMenu, splitPanes, toolsOpen, toolsRef,
  dispatchRef, setSplitMenu, setToolsOpen, setRightPanel,
  exitSplit, takeover, takeoverStop,
  openSessionDetail, toggleSessionLog, requestCloseSession,
  broadcastArmed, openBroadcast, canForward,
  tmuxMenu, setTmuxMenu, tmuxMenuRef, onPickTmux, onRefreshTmux,
  onAddTmuxPane, onOpenWall, onPromotePaneToMain,
  tmuxCreateOpen, tmuxCreateName, tmuxCreateErr, tmuxCreateBusy,
  onTmuxCreateOpen, onTmuxCreateCancel, onTmuxCreateName, onTmuxCreateSubmit,
  paneNames, paneCapReached, splitActive,
}: SessionToolbarProps) {
  // 工具菜单开合的收口（原内联 setToolsOpen(false) 同款）
  const closeTools = () => setToolsOpen(false);
  return (
    <div className="session-toolbar">
      <div className="st-ident">
        <span className="st-title mono" title={`${current.host_name} · ${sid!.slice(0, 12)}`}>
          {current.host_name}
          {oscTitles[sid!] ? ` · 「${oscTitles[sid!]}」` : ""}
        </span>
        <span className={"mono st-state " + stateLabel(current.state).cls}>{stateLabel(current.state).text}</span>
      </div>
      <span style={{ flex: 1 }} />
      {sid && (hasAgents || embeddedReady) && owner === "Agent" && (
        <>
          <button
            className="warn"
            title={t("接管会话：Agent 冻结、待审批请求作废，终端归你操作。Agent 正在跑的命令不会被中断")}
            onClick={takeover}
          >{t("接管")}</button>
          <button
            className="ghost-danger"
            title={t("接管并额外尝试停止 Agent 正在运行的命令；停止结果逐条显示，未停下的会标红")}
            onClick={takeoverStop}
          >{t("接管并停止任务")}</button>
        </>
      )}
      {sid && (
        <button
          className={"ghost icon-btn" + (searchOpen ? " ts-open" : "")}
          title={t("搜索终端内容（{0}）", keyHint("search"))}
          aria-label={t("搜索终端内容")}
          onClick={() => dispatchRef.current({ id: "search" })}
        ><IconSearch size={15} /></button>
      )}
      <button
        className={"ghost icon-btn" + (splitMenu ? " ts-open" : "")}
        title={splitPanes ? t("退出分屏（{0}；会话保留不断开）", keyHint("split-toggle")) : t("分屏（{0}）：在右侧/下侧显示已有会话（方向可在菜单选择）", keyHint("split-toggle"))}
        aria-haspopup={splitPanes ? undefined : "menu"}
        aria-expanded={splitPanes ? undefined : splitMenu}
        aria-pressed={!!splitPanes}
        onClick={() => {
          if (splitPanes) { void exitSplit(); return; }
          setSplitMenu((v) => !v);
        }}
      ><IconSplit size={15} /></button>
      {/* tmux 快接钮（恢复现场轮加映）：主动接入的唯一常驻入口——断线横幅只在
          最疼时刻出现，⌘K 要会背；这里给鼠标流一枚看得见的钮。仅 SSH 且探测到
          tmux 才渲染（无 tmux 的主机一个像素都不多）；点开重探清单防陈旧。
          tmux 是一级特性（用户原话「重要的功能，不够显眼」）：accent 描边让它在
          一排 ghost 里站出来，接入后标签变 tmux:名，状态一眼可读。 */}
      {sid && current.kind === "ssh" && current.tmux?.available && (
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
          ><IconTerminal size={14} />{current.tmux_attached ? `tmux:${current.tmux_attached}` : "tmux"}<IconChevronDown size={12} /></button>
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
                  成功后 App 侧刷新清单并直接接入（创建即进现场）。 */}
              {tmuxCreateOpen ? (
                <>
                  <div className="tmux-create-row" data-testid="tmux-create-row">
                    <input
                      className="tmux-create-input"
                      data-testid="tmux-create-input"
                      autoFocus
                      value={tmuxCreateName}
                      maxLength={64}
                      placeholder={t("会话名（字母/数字/下划线开头）")}
                      aria-label={t("新建 tmux 会话")}
                      aria-invalid={!!tmuxCreateErr}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") { e.preventDefault(); onTmuxCreateSubmit(); }
                        else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); onTmuxCreateCancel(); }
                      }}
                      onChange={(e) => onTmuxCreateName(e.target.value)}
                    />
                    <button
                      className="tmux-create-ok"
                      data-testid="tmux-create-ok"
                      disabled={tmuxCreateBusy || !tmuxCreateName.trim()}
                      title={t("创建并接入")}
                      onClick={onTmuxCreateSubmit}
                    >{t("创建")}</button>
                    <button
                      className="ghost"
                      data-testid="tmux-create-cancel"
                      title={t("取消")}
                      onClick={onTmuxCreateCancel}
                    >{t("取消")}</button>
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
                  title={t("新建 tmux 会话：在远端直接 tmux new-session（分离创建，不抢任何屏幕），建好即接入")}
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
      )}
      {/* 协作/文件按钮下线（用户反馈：入口重复——右缘 rb-rail 的 rb-collab/rb-files
          是常驻入口、⌘K 也有委托项；工具栏只留 tmux/搜索/分屏/工具）。 */}
      <div className="st-tools" ref={toolsRef}>
        <button className="ghost" aria-haspopup="menu" aria-expanded={toolsOpen}
          onClick={() => setToolsOpen(!toolsOpen)}>{t("工具")}<IconChevronDown size={12} /></button>
        {toolsOpen && (
          <div className="tools-menu" role="menu">
            {/* 「连接工具」菜单只放连接详情、端口转发、广播、日志开关、命令块、
                活动记录、关闭会话；协作/文件走右缘 rb-rail（工具栏按钮已下线） */}
            <button role="menuitem" data-testid="tools-conn-detail" onClick={() => { closeTools(); void openSessionDetail(current); }}>{t("连接详情…")}</button>
            {canForward && <button role="menuitem" onClick={() => { setRightPanel("forwards"); closeTools(); }}>{t("端口转发")}</button>}
            {/* P2-a 广播输入：浮层锚在状态栏右下（勾选目标、显示各会话状态） */}
            <button role="menuitem" data-testid="tools-broadcast" onClick={() => { closeTools(); openBroadcast(); }}>{t("广播输入…")}{broadcastArmed > 0 ? `（${broadcastArmed}）` : ""}</button>
            {/* 十八轮：会话日志开关（工具菜单与标签右键同源同义） */}
            <button role="menuitem" data-testid="tools-session-log" onClick={() => { closeTools(); void toggleSessionLog(current); }}>{current.logging ? t("停止记录会话日志") : t("记录会话日志")}</button>
            <button role="menuitem" data-testid="tools-blocks" onClick={() => { setRightPanel("blocks"); closeTools(); }}>{t("命令块")}</button>
            <button role="menuitem" data-testid="tools-activity" onClick={() => { setRightPanel("log"); closeTools(); }}>{t("活动记录")}</button>
            {/* 按钮美化轮：破坏性动作与上面的查看/开关类动作隔开（右键菜单同款分隔线） */}
            <div className="ctx-menu-sep" role="separator" />
            <button role="menuitem" className="tm-danger" onClick={() => { closeTools(); requestCloseSession(current); }}>{t("关闭会话…")}</button>
          </div>
        )}
      </div>
    </div>
  );
}
