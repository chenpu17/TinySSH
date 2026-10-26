// 协作面板内容（App.tsx 拆分⑤）：右侧任务面板的「审批」与「委托/任务目标/现场简报」
// 两块。从 App.tsx 原样出仓，本文件只收 props 呈现，零语义变更。
// 面板壳（tp-head/files/forwards/活动记录）仍留在宿主——四个面板的开关状态机在彼处。
import type { RefObject } from "react";
import type { CollabStatus, SessionInfo, SessionBrief as Brief } from "../adapter/wire";
import { approvalResolvedLabel, stateLabel, type ApprovalRow, type SettingsCat } from "../app-data";
import { t } from "../i18n";
import { IconInbox, IconTerminal } from "../icons";
import { BriefCard } from "./brief-card";

// 审批卡风险分级（审批减摩擦①后两档）：deny 命中根本不会出卡（内置危险模式直接拦）。
// ——高危形态（rm -rf/格式化/关机类）：唯一保留「二次确认」减速带的档；
// ——全段 pending（系统无法判定安全性）：降为**提示**不阻断单击——批准本身
//    就是刻意的第一次接触，重复摩擦由「批准并记住」消化。正则常驻模块顶层。
const DANGER_SHAPE_RE =
  /\brm\s+(?:-[a-zA-Z]+\s+)*-[a-z]*r[a-z]*f|\bmkfs\b|\bdd\b[^\n]*\bof=\/dev\/|\bshutdown\b|\breboot\b|\bpoweroff\b|\bhalt\b|\bwipefs\b|\bchmod\s+(?:-[a-zA-Z]+\s+)*777\s+\//;

function approvalRisk(a: ApprovalRow): string | null {
  if (DANGER_SHAPE_RE.test(a.command)) return t("命令包含高危形态（删除/格式化/关机类）");
  return null;
}

function approvalUncertainty(a: ApprovalRow): string | null {
  const segs = a.segment_report;
  if (segs.length > 0 && segs.every((s) => s.verdict.startsWith("pending:")))
    return t("所有分段均未命中允许规则（系统无法判定安全性）");
  return null;
}

/// 命令替换/解析失败的卡：内容不可预判，引擎对这类命令**跳过** allow/TTL——
/// 「记住」对未来无效果，不出记忆钮（如实告知，不出假按钮）。
function rememberEligible(a: ApprovalRow): boolean {
  return !a.segment_report.some((s) => s.verdict.includes("不可预判"));
}

export interface ApprovalGroup {
  sid: string;
  sess?: SessionInfo;
  items: ApprovalRow[];
}

interface CollabApprovalsProps {
  collabEnabled: boolean;
  collab: CollabStatus;
  collabStateText: string;
  collabConfigured: boolean;
  collabActive: boolean;
  pendingCount: number;
  approvalGroups: ApprovalGroup[];
  pendingApprovals: ApprovalRow[];
  resolvedApprovals: ApprovalRow[];
  confirmId: string | null;
  setConfirmId: (v: string | null) => void;
  editingId: string | null;
  setEditingId: (v: string | null) => void;
  editedCmd: string;
  setEditedCmd: (v: string) => void;
  persistId: string | null;
  setPersistId: (v: string | null) => void;
  persistPattern: string;
  setPersistPattern: (v: string) => void;
  decide: (id: string, decision: "approve" | "deny" | "edit", edited: string | null) => Promise<void>;
  rememberThenDecide: (
    id: string,
    scope: { ttlMinutes: number } | { pattern: string },
  ) => Promise<void>;
  openSettingsAt: (cat: SettingsCat) => void;
}

export function CollabApprovals({
  collabEnabled, collab, collabStateText, collabConfigured, collabActive,
  pendingCount, approvalGroups, pendingApprovals, resolvedApprovals,
  confirmId, setConfirmId, editingId, setEditingId, editedCmd, setEditedCmd,
  persistId, setPersistId, persistPattern, setPersistPattern,
  decide, rememberThenDecide, openSettingsAt,
}: CollabApprovalsProps) {
  return (
    !collabEnabled ? (
      // C9（R43）：协作停用/停用中/停用失败时不出现空审批区——改为停用态指引。
      <div className="empty" data-testid="collab-disabled">
        <IconInbox size={14} />
        <div>
          {collabStateText}。{collab.state === "Enabled" ? "" : t("新 Agent 请求已被拒绝")}
          {collab.state === "Disabling" ? t("，正在收敛存量。") : "。"}
          <div style={{ marginTop: 6 }}>
            <button className="ghost" data-testid="collab-open-settings"
              onClick={() => openSettingsAt("agent")}>{t("打开设置 → Agent 接入")}</button>
          </div>
        </div>
      </div>
    ) : !collabConfigured && !collabActive ? (
      // §6.7：新装未启用协作时不出现空审批区——改为一次性引导（不渲染空壳表单）
      <div className="empty" data-testid="collab-unconfigured">
        <IconInbox size={14} />
        <div>
          {t("协作未接入 Agent。到「设置 → Agent 接入」签发 Token 登记 Agent 后，这里会显示审批、任务目标与现场简报。")}
          <div style={{ marginTop: 6 }}>
            <button className="ghost" data-testid="collab-open-settings"
              onClick={() => openSettingsAt("agent")}>{t("打开设置 → Agent 接入")}</button>
          </div>
        </div>
      </div>
    ) : (
      <>
        <div className="section">
          <h4>{t("审批")}{pendingCount > 0 ? t("（{0}）", pendingCount) : ""}</h4>
          {/* §3.2：跨会话待办按主机与会话分组——绝不只展示「当前主机」而误批其他会话 */}
          <div className="side-quiet">{t("按目标主机与会话分组；跨会话操作请逐条核对来源。")}</div>
        </div>
        <div className="collab-approvals">
          {approvalGroups.map((g) => (
            <div className="ap-group" key={g.sid} data-testid="ap-group">
              <div className="ap-group-head">
                <b>{g.sess ? g.sess.host_name : t("会话已不在列表")}</b>
                <span className="mono dim" title={g.sid}> · {g.sid.slice(0, 12)}</span>
                {g.sess && <span className={"mono " + stateLabel(g.sess.state).cls} style={{ fontSize: 10 }}>{stateLabel(g.sess.state).text}</span>}
                <span className="badge agent">{t("{0} 待处理", g.items.length)}</span>
              </div>
              {g.items.map((a) => {
                const risk = approvalRisk(a);
                const uncertainty = approvalUncertainty(a);
                // 高危卡批准类按钮共享一次确认：首次点击只置 confirmId，卡上任意
                // 批准类按钮的第二次点击才执行（人已对这张卡表过态）
                const gated = risk !== null && confirmId !== a.id;
                const eligible = rememberEligible(a);
                return (
                  <div className="card" key={a.id}>
                    <div className="row">
                      <span className="badge">{t("Agent：{0}", a.agent_id)}</span>
                      {/* 破坏性提示由核心算出（target_summary），UI 不自猜 */}
                      {a.target_summary && <span className="tsum-chip" title={t("命令本身的破坏性提示（核心判定）")}>{a.target_summary}</span>}
                    </div>
                    {/* §6.7「可用目的」：会话当前委托目标的投影；无法获知时**明确缺失**，
                        不得留白让人误读为「无风险」 */}
                    <div className={"purpose-line" + (a.purpose ? "" : " missing")} data-testid="ap-purpose">
                      <span className="dim">{t("目的")}</span>{" "}
                      {a.purpose ? <span>{a.purpose}</span> : <span className="dim">{t("未提供（Agent 未收到委托说明）")}</span>}
                    </div>
                    {/* 目标上下文：多会话并存时 rm -rf 级裁决必须知道落在哪台机器 */}
                    <div className="dim" style={{ fontSize: 11, marginTop: 5 }} title={a.session_id}>
                      {t("目标：")}{g.sess ? <b style={{ color: "var(--text)" }}>{g.sess.host_name}</b> : t("会话已不在列表")}
                      <span className="mono"> · {a.session_id.slice(0, 12)}</span>
                      {g.sess?.state === "Disconnected" && t(" · 会话已断开")}
                      {a.session_busy && t(" · 会话正在交互程序中")}
                    </div>
                    <div className="cmd" style={{ margin: "6px 0" }}>{a.command}</div>
                    {a.segment_report.map((s, i) => (
                      <div key={i} className="dim" style={{ fontSize: 11 }}>
                        · {s.segment} — {s.verdict}
                      </div>
                    ))}
                    {risk && confirmId !== a.id && (
                      <div className="dim" style={{ fontSize: 11, marginTop: 6, color: "var(--warn)" }}>
                        ⚠ {t("{0}——批准前请确认命令的全部效果。", risk)}
                      </div>
                    )}
                    {uncertainty && (
                      <div className="dim" style={{ fontSize: 11, marginTop: 4 }}>
                        ⚠ {t("{0}——批准前请确认命令的全部效果。", uncertainty)}
                      </div>
                    )}
                    {editingId === a.id ? (
                      <div style={{ marginTop: 8 }}>
                        <textarea value={editedCmd} onChange={(e) => setEditedCmd(e.target.value)} rows={3} style={{ width: "100%" }} />
                        <div className="row" style={{ marginTop: 6 }}>
                          <button onClick={() => decide(a.id, "edit", editedCmd)} disabled={!editedCmd.trim() || editedCmd === a.command}>{t("保存并批准")}</button>
                          <button className="ghost" onClick={() => setEditingId(null)}>{t("取消")}</button>
                        </div>
                        <div className="dim" style={{ fontSize: 11, marginTop: 4 }}>{t("改后批准会记录为人工编辑（审计留痕）。")}</div>
                      </div>
                    ) : persistId === a.id ? (
                      // 持久放行编辑器：预填命令前缀（可编辑），写入该 Agent 的 allow 规则
                      <div style={{ marginTop: 8 }}>
                        <input
                          className="mono"
                          value={persistPattern}
                          onChange={(e) => setPersistPattern(e.target.value)}
                          style={{ width: "100%" }}
                        />
                        <div className="row" style={{ marginTop: 6 }}>
                          <button
                            disabled={!persistPattern.trim()}
                            onClick={() => {
                              if (gated) { setConfirmId(a.id); return; }
                              void rememberThenDecide(a.id, { pattern: persistPattern.trim() });
                            }}
                          >{gated ? t("再次点击确认") : t("保存规则并批准")}</button>
                          <button className="ghost" onClick={() => setPersistId(null)}>{t("取消")}</button>
                        </div>
                        <div className="dim" style={{ fontSize: 11, marginTop: 4 }}>
                          {t("前缀匹配（`*` 前为字面前缀），对该 Agent 永久生效，可到设置 → Agent 接入 管理；写入即审计留痕。")}
                        </div>
                      </div>
                    ) : (
                      <>
                        <div className="row" style={{ marginTop: 8 }}>
                          <button
                            className={confirmId === a.id ? "warn" : undefined}
                            title={risk ? t("高危形态请求：需二次确认") : undefined}
                            onClick={() => {
                              if (gated) { setConfirmId(a.id); return; }
                              void decide(a.id, "approve", null);
                            }}
                          >{confirmId === a.id ? t("再次点击确认批准") : t("批准")}</button>
                          {/* 「批准并记住」（审批减摩擦①）：TTL 精确记忆，到期自动失效；
                              高危卡同样吃二次确认闸门 */}
                          {eligible && (
                            <button className="ghost"
                              title={t("同命令 30 分钟内免审（逐段精确匹配，过期自动失效）")}
                              onClick={() => {
                                if (gated) { setConfirmId(a.id); return; }
                                void rememberThenDecide(a.id, { ttlMinutes: 30 });
                              }}
                            >{t("记住并批准")}</button>
                          )}
                          {/* 持久放行只对单段可解析命令开放：复合命令的前缀通配难一眼核对 */}
                          {eligible && a.segment_report.length <= 1 && (
                            <button className="ghost"
                              title={t("预填命令前缀（可编辑），写入该 Agent 的持久放行规则")}
                              onClick={() => {
                                setConfirmId(null); setPersistId(a.id);
                                setPersistPattern(((a.segment_report[0]?.segment ?? a.command).trim()) + " *");
                              }}
                            >{t("持久放行…")}</button>
                          )}
                          {/* 可编辑性由后端声明（editable 字段）：转发/传输卡无法从编辑文本回解参数，不出编辑钮 */}
                          {a.editable && <button className="ghost" onClick={() => { setConfirmId(null); setEditingId(a.id); setEditedCmd(a.command); }}>{t("编辑后批准")}</button>}
                          <button className="danger" onClick={() => void decide(a.id, "deny", null)}>{t("拒绝")}</button>
                        </div>
                        {!eligible && (
                          <div className="dim" style={{ fontSize: 11, marginTop: 4 }}>
                            {t("命令替换/解析失败：内容不可预判，无法记忆放行（每次都会重新送审）。")}
                          </div>
                        )}
                      </>
                    )}
                  </div>
                );
              })}
            </div>
          ))}
          {pendingApprovals.length === 0 && (
            <div className="empty"><IconInbox size={14} />{t("暂无待审批请求。Agent 通过 MCP 发起操作时会出现在这里。")}</div>
          )}
          {resolvedApprovals.length > 0 && (
            <div className="side-quiet">
              <div className="side-sub">{t("最近处理")}</div>
              {resolvedApprovals.map((a) => (
                <div className="tl-row" key={a.id} title={a.edited_command || a.command}>
                  <div className="tl-action">
                    <span className={(approvalResolvedLabel[a.status] ?? { cls: "err" }).cls} style={{ fontSize: 11 }}>
                      {t((approvalResolvedLabel[a.status] ?? { text: a.status }).text)}
                    </span>{" "}
                    {/* 编辑后批准显示实际放行文，不是原始请求（PV R1） */}
                    <span className="tl-cmd-text">{a.edited_command || a.command}</span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </>
    )
  );
}

interface CollabDelegateProps {
  sid: string | null;
  current: SessionInfo | null | undefined;
  owner: string;
  collabEnabled: boolean;
  collabConfigured: boolean;
  openDelegate: () => void;
  takeover: () => Promise<void>;
  openSettingsAt: (cat: SettingsCat) => void;
  goalRef: RefObject<HTMLTextAreaElement>;
  goalDraft: string;
  setGoalDraft: (v: string) => void;
  goalDirty: { current: boolean };
  brief: Brief | null;
  saveGoal: (clear?: boolean) => Promise<void>;
}

export function CollabDelegate({
  sid, current, owner, collabEnabled, collabConfigured,
  openDelegate, takeover, openSettingsAt,
  goalRef, goalDraft, setGoalDraft, goalDirty, brief, saveGoal,
}: CollabDelegateProps) {
  return (
    <>
      {/* §6.7：委托是显式动作（首次委托对话框）。此处给入口与当前控制权事实；
          MCP 配置已迁至「设置 → Agent 接入」（§5 迁移表），面板不再重复。 */}
      <div className="section">
        <h4>{t("委托")}</h4>
        {!sid ? (
          <div className="side-quiet">{t("连接会话后可委托给 Agent。")}</div>
        ) : !collabConfigured ? (
          <>
            <div className="side-quiet">{collabEnabled ? t("协作未接入 Agent，暂不能委托。先登记 Agent 接入。") : t("协作已停用，暂不能委托。先到「设置 → Agent 接入」启用。")}</div>
            <button className="ghost" data-testid="collab-open-settings-delegate"
              onClick={() => openSettingsAt("agent")}>{t("打开设置 → Agent 接入")}</button>
          </>
        ) : current?.control_owner === "Agent" ? (
          <>
            <div className="side-quiet">{t("本会话控制权在 Agent。要收回请用会话工具栏的「接管」——接管会立即冻结并作废未开始的请求。")}</div>
            {owner === "Human" && (
              <button className="ghost" data-testid="takeover-from-panel"
                onClick={() => void takeover()}>{t("接管（仅冻结）")}</button>
            )}
          </>
        ) : (
          <>
            <div className="side-quiet">{t("把控制权显式交给 Agent 后，它的操作请求才会进入上方审批队列。")}</div>
            <button data-testid="delegate-open-panel" onClick={openDelegate}>
              {current?.ever_agent_owned ? t("交还 Agent…") : t("交给 Agent…")}
            </button>
          </>
        )}
      </div>

      {/* §6.7：任务目标仅在协作已启用且处于受控会话时呈现——人类普通 SSH 不展示空白委托表单 */}
      <div className="section">
        <h4>{t("任务目标")}</h4>
        {!collabConfigured ? (
          <div className="side-quiet">{t("协作未启用。任务目标用于向 Agent 说明委托意图。")}</div>
        ) : sid ? (
          <>
            <textarea
              ref={goalRef}
              className="goal-input"
              rows={2}
              placeholder={t("写给 Agent 的委托留言，例：把日志打包放到 /tmp 后交还给我")}
              value={goalDraft}
              onChange={(e) => { goalDirty.current = true; setGoalDraft(e.target.value); }}
            />
            <div className="row" style={{ gap: 6, marginTop: 6 }}>
              <button
                disabled={goalDraft.trim() === (brief?.goal ?? "")}
                onClick={() => void saveGoal()}
              >{t("保存")}</button>
              {(brief?.goal ?? "") !== "" && (
                <button className="ghost" onClick={() => void saveGoal(true)}>{t("清除")}</button>
              )}
            </div>
            <div className="side-quiet">{t("Agent 接管与读简报时会先看到这里；随会话结束自动消失。")}</div>
          </>
        ) : (
          <div className="side-quiet">{t("连接会话后可给 Agent 留言委托任务。")}</div>
        )}
      </div>

      <div className="section">
        <h4>{t("现场简报")}</h4>
        {brief ? <BriefCard brief={brief} /> : (
          <div className="empty"><IconTerminal size={14} />{t("未接入会话。连接主机后显示当前目录与最近命令。")}</div>
        )}
      </div>
    </>
  );
}
