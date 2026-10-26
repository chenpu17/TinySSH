// 确认·委托对话框群（App.tsx 拆分③）：首次委托/交还、协作停用影响预览、关闭会话、
// 退出应用、删除主机、删除凭据六个对话框，从 App.tsx 原样出仓——开合 state、各
// dialogRef、useDialogFocus 焦点陷阱与 confirmAction/confirmQuit/submitDelegate/
// confirmDisable 等动作全部留在宿主，本组件只收 props 呈现，零语义变更。
import { stateLabel, type SettingsCat } from "../app-data";
import { t } from "../i18n";
import type { DisableImpact, Host, SessionInfo, ShellCapability } from "../adapter/wire";

// 危险动作确认 union（即 App.tsx 中 confirm state 的内联类型注解，宿主保留原注解）
export type ConfirmState =
  | { kind: "closeSession"; sid: string; hostName: string }
  | { kind: "deleteHost"; id: string; name: string }
  | { kind: "deleteIdentity"; id: string; label: string };

interface ConfirmDialogsProps {
  // 委托 / 交还对话框
  delegateDlg: boolean;
  current: SessionInfo | undefined;
  closeDelegate: () => void;
  delegateDlgRef: { current: HTMLDivElement | null };
  currentHost: Host | undefined;
  delegateCap: ShellCapability | null;
  collabConfigured: boolean;
  mcp: { endpoint: string; agents: { id: string; label: string }[] };
  delegateGoal: string;
  setDelegateGoal: (v: string) => void;
  delegateErr: string | null;
  openSettingsAt: (cat: SettingsCat) => void;
  delegateBusy: boolean;
  submitDelegate: () => Promise<void>;
  // 停用协作影响预览
  disableImpact: DisableImpact | null;
  setDisableImpact: (v: DisableImpact | null) => void;
  collabBusy: boolean;
  confirmDisable: () => Promise<void>;
  // 危险确认族（关闭会话 / 退出 / 删主机 / 删凭据）
  confirm: ConfirmState | null;
  setConfirm: (c: ConfirmState | null) => void;
  closeConfirmRef: { current: HTMLDivElement | null };
  confirmImpact: { forwards: number } | null;
  confirmAction: () => Promise<void>;
  quitSummary: { sessions: SessionInfo[]; forwards: number } | null;
  setQuitSummary: (v: { sessions: SessionInfo[]; forwards: number } | null) => void;
  quitConfirmRef: { current: HTMLDivElement | null };
  confirmQuit: () => Promise<void>;
  cancelQuit: () => void | Promise<void>;
  delHostRef: { current: HTMLDivElement | null };
  delIdentRef: { current: HTMLDivElement | null };
}

export function ConfirmDialogs({
  delegateDlg, current, closeDelegate, delegateDlgRef, currentHost, delegateCap,
  collabConfigured, mcp, delegateGoal, setDelegateGoal, delegateErr, openSettingsAt,
  delegateBusy, submitDelegate, disableImpact, setDisableImpact, collabBusy, confirmDisable,
  confirm, setConfirm, closeConfirmRef, confirmImpact, confirmAction,
  quitSummary, setQuitSummary, quitConfirmRef, confirmQuit, cancelQuit, delHostRef, delIdentRef,
}: ConfirmDialogsProps) {
  return (
    <>
        {/* R42（§6.7）首次委托 / 交还对话框：主机、会话、能力、现有授权范围 → 明确提交。
            「现有授权范围」只陈述核心能保证的（逐条审批 + 控制权是角色），不承诺某一
            Agent 独占。服务未启用时提交钮禁用并引导设置接入，返回后仍须单独确认。 */}
        {delegateDlg && current && (
          <div className="confirm-mask" onClick={closeDelegate}>
            <div className="confirm-dialog delegate-dlg" role="dialog" aria-modal="true"
              ref={delegateDlgRef}
              aria-labelledby="dlg-delegate-title" data-testid="delegate-dlg" onClick={(e) => e.stopPropagation()}>
              <div className="hk-title" id="dlg-delegate-title">
                {current.ever_agent_owned ? t("交还 {0} 给 Agent？", current.host_name) : t("把 {0} 交给 Agent？", current.host_name)}
              </div>
              <div className="dim" style={{ fontSize: 12 }}>
                {t("Agent 持有控制权期间，它的每个操作仍逐条经你审批；你随时可以接管（接管会作废尚未开始的请求）。")}
              </div>
              <div className="dlg-facts">
                <div className="fact"><span className="dim">{t("主机")}</span> <b>{current.host_name}</b>{" "}
                  <span className="mono dim">{currentHost?.address && currentHost.address !== "local" ? `${currentHost.address}:${currentHost.port}` : t("本机")}</span></div>
                <div className="fact"><span className="dim">{t("会话")}</span> <span className="mono">{current.id.slice(0, 12)}</span>{" "}
                  <span className={"mono " + stateLabel(current.state).cls} style={{ fontSize: 11 }}>{stateLabel(current.state).text}</span></div>
                <div className="fact"><span className="dim">{t("能力")}</span>{" "}
                  {delegateCap === null ? <span className="dim">{t("查询中…")}</span>
                    : delegateCap.integration_present && delegateCap.prompt_ready
                      ? <span>{t("持久 Shell 可用——Agent 可在当前目录与环境执行")}</span>
                      : <span className="warn">{t("无持久 Shell——委托后 Agent 只能走 exec 模式（不继承当前目录/环境）")}</span>}</div>
                <div className="fact"><span className="dim">{t("现有授权范围")}</span>{" "}
                  {collabConfigured
                    ? <span>{t("已接入 {0}；所有操作逐条审批（控制权是角色，不承诺某一 Agent 独占）", mcp.agents.map((a) => a.label).join("、"))}</span>
                    : <span className="warn">{t("尚未登记任何 Agent")}</span>}</div>
              </div>
              <div className="ts-label" style={{ marginTop: 10 }}>{t("任务目标（可选）")}</div>
              <textarea className="goal-input" rows={2} value={delegateGoal}
                aria-label={t("任务目标（可选）")}
                placeholder={t("写给 Agent 的委托留言，例：把日志打包放到 /tmp 后交还给我")}
                onChange={(e) => setDelegateGoal(e.target.value)} />
              <div className="dim" style={{ fontSize: 11, marginTop: 4 }}>
                {t("留空也可以转交；留空不会清除会话上已有的目标。")}
              </div>
              {delegateErr && <div className="err" style={{ marginTop: 6, fontSize: 12 }} data-testid="delegate-err">✕ {delegateErr}</div>}
              {!collabConfigured && (
                <div className="side-quiet" data-testid="delegate-unconfigured">
                  {t("协作服务未启用——先到「设置 → Agent 接入」登记 Agent。返回后仍需在此单独确认转交。")}
                  <div style={{ marginTop: 6 }}>
                    <button className="ghost" data-testid="delegate-open-settings"
                      onClick={() => { closeDelegate(); openSettingsAt("agent"); }}>{t("打开设置 → Agent 接入")}</button>
                  </div>
                </div>
              )}
              <div className="hk-actions">
                <button data-testid="delegate-submit" disabled={!collabConfigured || delegateBusy}
                  onClick={() => void submitDelegate()}>
                  {delegateBusy ? t("提交中…") : current.ever_agent_owned ? t("交还 Agent") : t("交给 Agent")}
                </button>
                <button className="ghost" data-autofocus onClick={closeDelegate}>{t("取消")}</button>
              </div>
            </div>
          </div>
        )}
        {/* C9（R43）停用影响预览对话框：先预览 → 确认后核心原子封 admission。
            明确披露「运行中任务不自动终止」「重新启用不复活旧请求」，不承诺全清。 */}
        {disableImpact && (
          <div className="confirm-mask" onClick={() => setDisableImpact(null)}>
            <div className="confirm-dialog" role="dialog" aria-modal="true"
              aria-labelledby="dlg-disable-collab-title" data-testid="collab-disable-dlg" onClick={(e) => e.stopPropagation()}>
              <div className="hk-title" id="dlg-disable-collab-title">{t("停用协作？")}</div>
              <div className="dim" style={{ fontSize: 12 }}>
                {t("确认后立即封闭入口——新 Agent 请求一律被拒绝，不等待你逐个接管；已有请求在执行开始前核对停用代际，作废留痕，不会因旧审批决定继续执行。")}
              </div>
              <div className="dlg-facts">
                <div className="fact"><span className="dim">{t("受影响的 Agent 会话")}</span> <b data-testid="collab-impact-sessions">{disableImpact.agent_owned_sessions}</b>{" "}
                  <span className="dim">{t("（转为你的控制，不自动终止已开始的任务）")}</span></div>
                <div className="fact"><span className="dim">{t("待审批请求")}</span> <b data-testid="collab-impact-approvals">{disableImpact.pending_approvals}</b> <span className="dim">{t("（作废）")}</span></div>
                <div className="fact"><span className="dim">{t("已配置 Agent")}</span> <b data-testid="collab-impact-agents">{disableImpact.configured_agents}</b> <span className="dim">{t("（身份与 Token 保留）")}</span></div>
              </div>
              <div className="side-quiet">
                {t("运行中的 Agent 任务不会被自动终止；应用拥有的 MCP 端点随之停止（外部 shim 是独立进程，不受影响）。重新启用须显式操作，先前作废的请求不会复活。")}
              </div>
              <div className="hk-actions">
                <button data-testid="collab-disable-confirm" disabled={collabBusy} onClick={() => void confirmDisable()}>
                  {collabBusy ? t("停用中…") : t("确认停用")}
                </button>
                <button className="ghost" data-autofocus data-testid="collab-disable-cancel" onClick={() => setDisableImpact(null)}>{t("取消")}</button>
              </div>
            </div>
          </div>
        )}
        {confirm?.kind === "closeSession" && (
          <div className="confirm-mask" onClick={() => setConfirm(null)}>
            <div className="confirm-dialog" ref={closeConfirmRef} role="dialog" aria-modal="true" aria-labelledby="dlg-close-title" onClick={(e) => e.stopPropagation()}>
              {/* R23 §6.4/§342：入口统一命名「关闭会话」；影响行只说可查证的
                  （转发数），任务/传输状态未知时明确未知，不声称空闲 */}
              <div className="hk-title" id="dlg-close-title">{t("关闭与 {0} 的会话？", confirm.hostName)}</div>
              <div>{t("终端现场不可恢复——重连会是全新现场（记录保留）。")}</div>
              <div className="dim" style={{ marginTop: 6, fontSize: 12 }}>
                · {t("将受影响的转发：")}{confirmImpact ? (confirmImpact.forwards > 0 ? t("{0} 条（随会话关闭）", confirmImpact.forwards) : t("无")) : t("状态未知（查询失败）")}
                <br />· {t("正在运行的任务/传输：状态未知——如有重要作业请先确认")}
              </div>
              <div className="hk-actions">
                <button className="danger" onClick={confirmAction}>{t("关闭会话")}</button>
                <button className="ghost" data-autofocus onClick={() => setConfirm(null)}>{t("取消")}</button>
              </div>
            </div>
          </div>
        )}
        {quitSummary && (
          <div className="confirm-mask">
            <div className="confirm-dialog" ref={quitConfirmRef} role="dialog" aria-modal="true" aria-labelledby="dlg-quit-title" onClick={(e) => e.stopPropagation()}>
              <div className="hk-title" id="dlg-quit-title">{t("退出 TinySSH？")}</div>
              <div>
                {t("活动会话 {0} 个", quitSummary.sessions.length)}
                {quitSummary.sessions.length > 0 && (
                  <>（{quitSummary.sessions.map((s) => s.host_name).join("、")}）</>
                )}
                {t("，转发 {0} 条。", quitSummary.forwards)}
              </div>
              <div className="dim" style={{ marginTop: 6, fontSize: 12 }}>
                {t("正在运行的命令与传输会被终止；传输处于提交中/结果待核实时不代表已全部取消。")}
                {t("会话不跨启动保留——下次启动可在欢迎页「重连上次会话」一键恢复届时仍打开的主机。")}
              </div>
              <div className="hk-actions">
                <button className="danger" onClick={() => void confirmQuit()}>{t("结束会话并退出")}</button>
                <button className="ghost" data-autofocus onClick={() => void cancelQuit()}>{t("取消")}</button>
              </div>
            </div>
          </div>
        )}
        {confirm?.kind === "deleteHost" && (
          <div className="confirm-mask" onClick={() => setConfirm(null)}>
            <div className="confirm-dialog" ref={delHostRef} role="dialog" aria-modal="true" aria-labelledby="dlg-delhost-title" onClick={(e) => e.stopPropagation()}>
              <div className="hk-title" id="dlg-delhost-title">{t("删除主机 {0}？", confirm.name)}</div>
              <div>{t("凭据与指纹记录一并移除，之后无法再从它新建连接；已建立的会话不受影响。")}</div>
              <div className="hk-actions">
                <button className="danger" onClick={confirmAction}>{t("删除")}</button>
                <button className="ghost" data-autofocus onClick={() => setConfirm(null)}>{t("取消")}</button>
              </div>
            </div>
          </div>
        )}
        {confirm?.kind === "deleteIdentity" && (
          <div className="confirm-mask" onClick={() => setConfirm(null)}>
            <div className="confirm-dialog" ref={delIdentRef} role="dialog" aria-modal="true" aria-labelledby="dlg-delident-title" onClick={(e) => e.stopPropagation()}>
              <div className="hk-title" id="dlg-delident-title">{t("删除凭据 {0}？", confirm.label)}</div>
              <div>{t("仍被主机引用的凭据会被拒绝并列出主机；已保存的凭据独立存在，删除前请确认没有主机依赖它。")}</div>
              <div className="hk-actions">
                <button className="danger" onClick={confirmAction}>{t("删除凭据")}</button>
                <button className="ghost" data-autofocus onClick={() => setConfirm(null)}>{t("取消")}</button>
              </div>
            </div>
          </div>
        )}
    </>
  );
}
