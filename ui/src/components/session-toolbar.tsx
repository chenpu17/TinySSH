// 会话工具栏 40（App.tsx 拆分⑤）：§4.1——活动会话才出现（欢迎页不放失效的终端
// 工具）。识别区（主机名/OSC 标题/状态）、接管双钮、委托入口、搜索/分屏/协作/
// 文件/工具菜单。从 App.tsx 原样出仓，本文件只收 props 呈现，零语义变更。
import type { Dispatch, SetStateAction } from "react";
import type { AppAction } from "../actions";
import type { SessionInfo } from "../adapter/wire";
import { stateLabel } from "../app-data";
import { t } from "../i18n";
import type { SplitPanes } from "../app-data";
import {
  IconChevronDown, IconFolder, IconInbox, IconSearch, IconSplit,
} from "../icons";

export interface SessionToolbarProps {
  current: SessionInfo;
  sid: string | null;
  /** OSC 171 标题（会话内程序上报的窗口标题投影） */
  oscTitles: Record<string, string>;
  hasAgents: boolean;
  owner: string;
  collabConfigured: boolean;
  /** 内嵌 Agent 已配模型服务：委托/接管入口的第二把钥匙（无需 MCP 协作配置） */
  embeddedReady: boolean;
  searchOpen: boolean;
  splitMenu: boolean;
  splitPanes: SplitPanes | null;
  rightPanel: null | "files" | "collab" | "forwards" | "log" | "blocks";
  toolsOpen: boolean;
  toolsRef: { current: HTMLDivElement | null };
  dispatchRef: { current: (a: AppAction) => boolean };
  setSplitMenu: Dispatch<SetStateAction<boolean>>;
  setRightPanel: (v: null | "files" | "collab" | "forwards" | "log" | "blocks") => void;
  setToolsOpen: (v: boolean) => void;
  exitSplit: () => void;
  openDelegate: () => void;
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
}

export function SessionToolbar({
  current, sid, oscTitles, hasAgents, owner, collabConfigured, embeddedReady,
  searchOpen, splitMenu, splitPanes, rightPanel, toolsOpen, toolsRef,
  dispatchRef, setSplitMenu, setRightPanel, setToolsOpen,
  exitSplit, openDelegate, takeover, takeoverStop,
  openSessionDetail, toggleSessionLog, requestCloseSession,
  broadcastArmed, openBroadcast, canForward,
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
      {sid && (collabConfigured || embeddedReady) && owner === "Human" && (
        <button
          className="ghost"
          data-testid="delegate-open"
          title={current?.ever_agent_owned
            ? t("交还会话：Agent 恢复操作（后续请求重新走审批）。已作废的请求不会自动重发——Agent 会收到作废通知，由它决定是否重新提交")
            : t("首次委托：把会话交给 Agent 执行。需在对话框中查看主机/会话/能力与现有授权范围后明确提交；取消不改动控制权")}
          onClick={() => openDelegate()}
        >{current?.ever_agent_owned ? t("交还 Agent") : t("交给 Agent…")}</button>
      )}
      {sid && (
        <button
          className={"ghost icon-btn" + (searchOpen ? " ts-open" : "")}
          title={t("搜索终端内容（⌘F）")}
          aria-label={t("搜索终端内容")}
          onClick={() => dispatchRef.current({ id: "search" })}
        ><IconSearch size={15} /></button>
      )}
      <button
        className={"ghost icon-btn" + (splitMenu ? " ts-open" : "")}
        title={splitPanes ? t("退出分屏（Ctrl+D；会话保留不断开）") : t("分屏（Ctrl+D）：在右侧/下侧显示已有会话（方向可在菜单选择）")}
        aria-haspopup={splitPanes ? undefined : "menu"}
        aria-expanded={splitPanes ? undefined : splitMenu}
        aria-pressed={!!splitPanes}
        onClick={() => {
          if (splitPanes) { void exitSplit(); return; }
          setSplitMenu((v) => !v);
        }}
      ><IconSplit size={15} /></button>
      <button
        className={"ghost st-collab" + (rightPanel === "collab" ? " ts-open" : "")}
        data-testid="tools-collab"
        aria-pressed={rightPanel === "collab"}
        title={t("协作：审批、任务目标与现场简报（有 Agent 活动时必须可达）")}
        onClick={() => setRightPanel(rightPanel === "collab" ? null : "collab")}
      ><IconInbox size={14} />{t("协作")}</button>
      <button
        className={"ghost st-file" + (rightPanel === "files" ? " ts-open" : "")}
        aria-pressed={rightPanel === "files"}
        title={t("文件：远程目录浏览与传输")}
        onClick={() => setRightPanel(rightPanel === "files" ? null : "files")}
      ><IconFolder size={14} />{t("文件")}</button>
      <div className="st-tools" ref={toolsRef}>
        <button className="ghost" aria-haspopup="menu" aria-expanded={toolsOpen}
          onClick={() => setToolsOpen(!toolsOpen)}>{t("工具")}<IconChevronDown size={12} /></button>
        {toolsOpen && (
          <div className="tools-menu" role="menu">
            {/* §3.2：「连接工具」菜单只放连接详情、端口转发、活动记录、关闭会话；
                协作是会话工作区下的**同级**入口（见工具栏「协作」钮），不塞进本菜单 */}
            <button role="menuitem" data-testid="tools-conn-detail" onClick={() => { closeTools(); void openSessionDetail(current); }}>{t("连接详情…")}</button>
            {canForward && <button role="menuitem" onClick={() => { setRightPanel("forwards"); closeTools(); }}>{t("端口转发")}</button>}
            {/* P2-a 广播输入：浮层锚在状态栏右下（勾选目标、显示各会话状态） */}
            <button role="menuitem" data-testid="tools-broadcast" onClick={() => { closeTools(); openBroadcast(); }}>{t("广播输入…")}{broadcastArmed > 0 ? `（${broadcastArmed}）` : ""}</button>
            {/* 十八轮：会话日志开关（工具菜单与标签右键同源同义） */}
            <button role="menuitem" data-testid="tools-session-log" onClick={() => { closeTools(); void toggleSessionLog(current); }}>{current.logging ? t("停止记录会话日志") : t("记录会话日志")}</button>
            <button role="menuitem" data-testid="tools-blocks" onClick={() => { setRightPanel("blocks"); closeTools(); }}>{t("命令块")}</button>
            <button role="menuitem" data-testid="tools-activity" onClick={() => { setRightPanel("log"); closeTools(); }}>{t("活动记录")}</button>
            <button role="menuitem" className="tm-danger" onClick={() => { closeTools(); requestCloseSession(current); }}>{t("关闭会话…")}</button>
          </div>
        )}
      </div>
    </div>
  );
}
