// 活动记录面板（App.tsx 拆分③）：审计事件范围/筛选/列表，从 App.tsx 原样出仓——
// 范围与筛选 state、loadLog 查询/续页、sessionIdent 留痕表全部留在宿主，
// 本组件只收 props 呈现，零语义变更。
import { decisionLabel, LOG_ACTION_OPTIONS, stampLocal, TZ_NOTE } from "../app-data";
import { t } from "../i18n";
import type { AuditEvent } from "../adapter/wire";
import { IconClock, IconRefresh, IconTerminal } from "../icons";

interface ActivityLogPanelProps {
  // 范围与筛选（状态归宿主）
  logScope: "current" | "all";
  setLogScope: (v: "current" | "all") => void;
  logActor: "" | "human" | "agent";
  setLogActor: (v: "" | "human" | "agent") => void;
  logAction: string;
  setLogAction: (v: string) => void;
  // 数据与派生展示状态
  sid: string | null;
  logEvents: AuditEvent[];
  logTotal: number;
  logBusy: boolean;
  logErr: string | null;
  // sid → 主机名留痕表
  sessionIdent: Map<string, string>;
  // 动作：more=false 首页刷新，true 游标续页
  loadLog: (more: boolean) => Promise<void>;
}

export function ActivityLogPanel({
  logScope, setLogScope, logActor, setLogActor, logAction, setLogAction,
  sid, logEvents, logTotal, logBusy, logErr, sessionIdent, loadLog,
}: ActivityLogPanelProps) {
  return (
            <>
              <div className="section">
                <div className="log-bar">
                  <div className="seg" role="group" aria-label={t("记录范围")}>
                    <button className={logScope === "current" ? "on" : ""} data-testid="log-scope-current"
                      aria-pressed={logScope === "current"} disabled={!sid}
                      title={sid ? t("只看当前会话") : t("未接入会话")}
                      onClick={() => setLogScope("current")}>{t("当前会话")}</button>
                    <button className={logScope === "all" ? "on" : ""} data-testid="log-scope-all"
                      aria-pressed={logScope === "all"}
                      onClick={() => setLogScope("all")}>{t("全部会话")}</button>
                  </div>
                  <span style={{ flex: 1 }} />
                  <button className="ghost icon-btn" title={t("刷新")} aria-label={t("刷新活动记录")}
                    data-testid="log-refresh" disabled={logBusy}
                    onClick={() => void loadLog(false)}><IconRefresh size={14} /></button>
                </div>
                <div className="log-filters">
                  <label>{t("主体")}
                    <select value={logActor} data-testid="log-actor"
                      onChange={(e) => setLogActor(e.target.value as "" | "human" | "agent")}>
                      <option value="">{t("全部")}</option>
                      <option value="human">{t("人类")}</option>
                      <option value="agent">Agent</option>
                    </select>
                  </label>
                  <label>{t("事件类型")}
                    <select value={logAction} data-testid="log-action"
                      onChange={(e) => setLogAction(e.target.value)}>
                      <option value="">{t("全部")}</option>
                      {LOG_ACTION_OPTIONS.map((o) => <option key={o.v} value={o.v}>{t(o.label)}</option>)}
                    </select>
                  </label>
                </div>
                <div className="log-note" data-testid="log-note">
                  {t("本机时间（{0}）· {1}", TZ_NOTE, logScope === "current" && !sid
                    ? t("未接入会话，无可显示记录")
                    : `${t("共 {0} 条", logTotal)}${logScope === "current" ? t("（当前会话）") : ""}`)}
                </div>
              </div>
              <div className="section">
                {logErr ? (
                  <div className="empty" data-testid="log-err">{logErr}</div>
                ) : logScope === "current" && !sid ? (
                  <div className="empty" data-testid="log-empty-nosession"><IconTerminal size={14} />{t("未接入会话——切到「全部会话」可查看历史记录。")}</div>
                ) : logEvents.length === 0 ? (
                  <div className="empty" data-testid="log-empty">
                    <IconClock size={14} />{logBusy ? t("载入中…") : t("暂无记录。所有连接与命令都会留痕在这里。")}
                  </div>
                ) : (
                  <>
                    {logEvents.map((ev) => {
                      const ident = ev.session_id ? sessionIdent.get(ev.session_id) : undefined;
                      // 短 id 只用于辨认（完整 id 在 title 里）——太短的 id 直接全显，别截成无信息量的前缀
                      const shortSid = ev.session_id ? (ev.session_id.length <= 12 ? ev.session_id : ev.session_id.slice(0, 8)) : "";
                      return (
                        <div className={`tl-row log-row actor-${ev.actor_kind}`} key={ev.seq} data-testid="log-row"
                          data-action={ev.action} data-actor={ev.actor_kind}
                          title={`#${ev.seq} ${ev.action}${ev.command ? ` · ${ev.command}` : ""}`}>
                          <div className="tl-meta">
                            {stampLocal(ev.ts)}
                            {ev.session_id && <> · {ident ?? <span className="log-sid">{shortSid}</span>}</>}
                            {ev.session_id && <span className="log-sid" title={ev.session_id}>（{shortSid}）</span>}
                          </div>
                          <div className="tl-action">
                            <span className="tl-actor">
                              {ev.actor_kind === "human" ? t("我") : (ev.agent_id ? t("Agent · {0}", ev.agent_id) : "Agent")}
                            </span>{" "}
                            {decisionLabel(ev)}
                            {ev.command && <>{" "}<span className="tl-cmd-text">{ev.command}</span></>}
                          </div>
                        </div>
                      );
                    })}
                    {logEvents.length < logTotal && (
                      <button className="ghost log-more" data-testid="log-more" disabled={logBusy}
                        onClick={() => void loadLog(true)}>
                        {logBusy ? t("载入中…") : t("加载更早（已显示 {0}/{1}）", logEvents.length, logTotal)}
                      </button>
                    )}
                  </>
                )}
              </div>
            </>
  );
}
