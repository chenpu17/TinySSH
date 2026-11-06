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
import { IconChevronDown, IconSearch, IconSplit } from "../icons";
import { TmuxQuick } from "./tmux-quick";

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
  /** 建好落在哪：主视图 attach（默认，旧行为）或直接开进面板窗格。面板目标是
   * 补断路——建好即接入主视图后，「＋面板」对主视图中的会话是禁用的（同一会话
   * 不做两路视图），此前无法把新会话直接放进面板 */
  tmuxCreateTarget: "main" | "panel";
  onTmuxCreateTarget: (v: "main" | "panel") => void;
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
  /** 专注模式里工具栏整条隐藏，快接钮移到标签条渲染——此时这里不再重复挂载 */
  renderTmuxQuick?: boolean;
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
  tmuxCreateTarget, onTmuxCreateTarget,
  onTmuxCreateOpen, onTmuxCreateCancel, onTmuxCreateName, onTmuxCreateSubmit,
  paneNames, paneCapReached, splitActive, renderTmuxQuick = true,
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
          专注模式下会话工具栏整条隐藏，快接钮移到标签条由 App 直接挂载，
          这里用 renderTmuxQuick=false 避免同一状态渲染两份菜单。 */}
      {renderTmuxQuick && (
        <TmuxQuick
          current={current} sid={sid}
          tmuxMenu={tmuxMenu} setTmuxMenu={setTmuxMenu} tmuxMenuRef={tmuxMenuRef}
          onRefreshTmux={onRefreshTmux} onPickTmux={onPickTmux}
          onPromotePaneToMain={onPromotePaneToMain} onAddTmuxPane={onAddTmuxPane}
          onOpenWall={onOpenWall}
          tmuxCreateOpen={tmuxCreateOpen} tmuxCreateName={tmuxCreateName}
          tmuxCreateErr={tmuxCreateErr} tmuxCreateBusy={tmuxCreateBusy}
          tmuxCreateTarget={tmuxCreateTarget} onTmuxCreateTarget={onTmuxCreateTarget}
          onTmuxCreateOpen={onTmuxCreateOpen} onTmuxCreateCancel={onTmuxCreateCancel}
          onTmuxCreateName={onTmuxCreateName} onTmuxCreateSubmit={onTmuxCreateSubmit}
          paneNames={paneNames} paneCapReached={paneCapReached} splitActive={splitActive}
        />
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
