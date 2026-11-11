// 内置 Agent 对话视图（活动栏轮外壳 + 接真模型轮双模式）。
// 会话隔离：对话按会话 sid 分键，跟随激活标签页（与块面板同款语义）。
// 双模式：
//  · 真模型（inTauri 且已配置模型服务）：agent_send/agent-event/agent_history/
//    agent_cancel 走 Rust 侧 agent-host（tiny-a 内核 + SessionManager 工具桥，
//    危险命令审批在 core-session 层自动继承；审批卡经 pendingApprovals 对账
//    agent_id=tinyssh-embedded 内联呈现，决策走既有 decide_approval 链）。
//  · 演练（浏览器 demo / 未配置）：agent-mock 脚本驱动，交互形态与真模式一致，
//    如实标注「演练」。
import { memo, useEffect, useRef, useState } from "react";
import type { PointerEvent } from "react";
import * as clipboard from "@tauri-apps/plugin-clipboard-manager";
import { inTauri, invoke, listen } from "../adapter/bridge";
import type { ApprovalRow } from "../app-data";
import { welcomeMd, mockScript } from "../agent-mock";
import { renderAgentMd } from "../mdview";
import { renderMermaidIn, rerenderMermaids } from "../mmd";
import { renderMathIn } from "../math";
import { localeNow, t } from "../i18n";
import { IconBot, IconLoader, IconPlus, IconX } from "../icons";
import { approvalRisk } from "./collab-panel";

type ToolStatus = "pending" | "running" | "ok" | "err" | "denied";

type AgentMsg =
  | { id: string; role: "user"; text: string }
  | { id: string; role: "assistant"; md: string; think: string; streaming: boolean }
  | {
      id: string; role: "tool"; tool: string; argsLabel: string;
      status: ToolStatus; output?: string;
    };

/** Rust 侧 HostEvent 的 wire 形状（serde tag=kind content=data）。 */
type AgentWireEvent = { kind: string; data?: unknown };
type AgentWire = { sid: string; event: AgentWireEvent };

export interface AgentViewProps {
  width: number;
  /** 当前会话 sid；欢迎页（无会话）为 null——显空态不可输入。编排形态固定 "fleet" */
  sid: string | null;
  /** 编排者形态（Fleet 轮）：对话键固定 "fleet"，无委托门/控制权徽标
      （编排者不直接操作机器），派发的目标对话仍按各自 sid 在会话 Agent 视图呈现 */
  fleet?: boolean;
  hostLabel: string;
  /** tmux 联动二（Agent 分窗）：会话已 attach tmux 时的一行说明
      （命令自动落远端专属窗口 tinyssh-agent）；null = 不显示 */
  tmuxNote?: string | null;
  /** 该会话的内嵌 agent 待审批（inline 批准/拒绝走既有 decide_approval 链） */
  pending: ApprovalRow[];
  onDecide: (id: string, decision: "approve" | "deny" | "edit", edited: string | null) => void;
  /** 会话控制权（"Human" | "Agent"）：真模式下发送门据此请求交托（夺权显式化） */
  owner: string;
  /** 轻量委托（核心 delegate_session，目标留空）；true=已交托 */
  onDelegate: () => Promise<boolean>;
  /** 内嵌 agent 自主模式（人类授权，deny 名单仍硬拦/传输仍逐条/全量记录可急停） */
  autonomyOn: boolean;
  onToggleAutonomy: (enable: boolean) => void;
  /** 编排视图的「有 N 个待审批」提示：点开协作面板（此前面板不可点，文案指向落空） */
  onOpenApprovals?: () => void;
  gripDrag: { current: boolean };
  gripDown: (e: PointerEvent<HTMLDivElement>) => void;
  gripMove: (e: PointerEvent<HTMLDivElement>) => void;
  gripUp: (e: PointerEvent<HTMLDivElement>) => void;
  onClose: () => void;
  pushToast: (kind: "ok" | "err" | "info", text: string) => void;
}

/** 演练节拍：每 90ms 追加 24 字符；批准后模拟执行 600ms。 */
const STREAM_CHARS = 24;
const STREAM_MS = 90;
const RUN_MS = 600;

/** 演练域对话仓（UX2 走查：面板关开不丢对话）：convs 是组件态，面板卸载即清——
 * 切标签保留、关面板即丢，用户无从预期。真模式历史由后端 agent_history 回放
 * 不进这里；这里只收演练域写入，重挂载时种子 effect 优先取回。上限 64 会话
 * （Map 保插入序，超出删最旧），防长开 demo 跨会话缓慢累积。 */
const MOCK_CONVS = new Map<string, AgentMsg[]>();

// 演练消息 id 用模块级单调计数：组件重挂载后 ref 归零会让新消息与恢复的旧
// 消息撞 key（React 复用/串改旧气泡）。
let mockMsgSeq = 0;

// 恢复消毒（R3-B-2）：卸载瞬间 persist 进仓的中间态无人收尾——streaming 光标
// 永闪、mermaid/公式渲染闸永久关闭、pending 审批按钮 no-op（pendingTool ref 随
// 卸载重置）。重开面板恢复时统一落终态：工具卡中断收尾、流式气泡截停。
const sanitizeMockMsgs = (msgs: AgentMsg[], interrupted: string): AgentMsg[] =>
  msgs.map((m) => {
    if (m.role === "tool" && (m.status === "pending" || m.status === "running"))
      return { ...m, status: "err" as const, output: interrupted };
    if (m.role === "assistant" && m.streaming) return { ...m, streaming: false };
    return m;
  });

/** 真模式：会话内嵌 agent 的审批对账身份（与 crates/agent-host AGENT_CLIENT_ID 对应） */
export const EMBEDDED_AGENT_ID = "tinyssh-embedded";

function closeStreaming(msgs: AgentMsg[]): AgentMsg[] {
  const last = msgs[msgs.length - 1];
  if (last && last.role === "assistant" && last.streaming) {
    const copy = [...msgs];
    copy[copy.length - 1] = { ...last, streaming: false };
    return copy;
  }
  return msgs;
}

/** 运行异常结束：把仍在转圈的工具卡收尾，避免 done/failed 后永久“运行中”。 */
function settleRunningTools(msgs: AgentMsg[], output: string): AgentMsg[] {
  let changed = false;
  const next = msgs.map((m) => {
    if (m.role === "tool" && m.status === "running") {
      changed = true;
      return { ...m, status: "err" as const, output };
    }
    return m;
  });
  return changed ? next : msgs;
}

/** 只有模型正常收口才静默；其余 stop_reason 必须给用户一个明确交代。 */
function stopReasonNotice(reason: string): string | null {
  if (reason === "end_turn" || reason === "stop" || reason === "stop_sequence") return null;
  if (reason === "cancelled") return t("已停止当前运行。");
  if (reason === "timeout") return t("运行超过时限，任务可能未完成。");
  if (reason === "stream_idle") return t("模型长时间没有输出，连接已中断（可能是推理等待过久或网络半开）。");
  if (reason === "stream_truncated") return t("流式响应被截断，回答可能不完整。");
  if (reason === "max_tokens") return t("输出达到模型上限，回答可能被截断。");
  if (reason === "max_turns_reached") return t("达到工具轮次上限，任务可能未完成。");
  if (reason === "budget_exceeded") return t("达到本次运行的 token 预算上限，任务可能未完成。");
  if (reason === "stuck_loop") return t("检测到重复操作，已自动停止。");
  return t("运行结束（{0}）。", reason);
}

function summarizeTool(name: string, input: Record<string, unknown> | undefined): string {
  const i = input ?? {};
  if (name === "exec") return String(i.command ?? "");
  if (name === "read_blocks") return `limit=${String(i.limit ?? 20)}`;
  if (name === "wait_output") return i.regex ? `/${String(i.regex)}/` : t("静默等待新输出");
  if (name === "upload") return `${String(i.local ?? "")} → ${String(i.remote ?? "")}`.slice(0, 90);
  if (name === "download") return `${String(i.remote ?? "")} → ${String(i.local ?? "")}`.slice(0, 90);
  if (name === "send_keys") {
    return String(i.keys ?? "")
      .replace(/\x1b/g, "\\x1b").replace(/\r/g, "\\r")
      .replace(/\n/g, "\\n").replace(/\t/g, "\\t")
      .slice(0, 60);
  }
  return "";
}

/** HostEvent → 消息流（历史重建与实时事件共用同一折叠逻辑）。 */
function applyAgentEvent(msgs: AgentMsg[], ev: AgentWireEvent, seq: { n: number }): AgentMsg[] {
  const uid = () => `r${++seq.n}`;
  const kind = ev.kind;
  const data = ev.data as never;
  switch (kind) {
    case "user":
      return [...msgs, { id: uid(), role: "user", text: String(data) }];
    case "text": {
      const delta = String(data ?? "");
      const last = msgs[msgs.length - 1];
      if (last && last.role === "assistant" && last.streaming) {
        const copy = [...msgs];
        copy[copy.length - 1] = { ...last, md: last.md + delta };
        return copy;
      }
      return [...msgs, { id: uid(), role: "assistant", md: delta, think: "", streaming: true }];
    }
    case "thinking": {
      const delta = String(data ?? "");
      const last = msgs[msgs.length - 1];
      if (last && last.role === "assistant" && last.streaming) {
        const copy = [...msgs];
        copy[copy.length - 1] = { ...last, think: last.think + delta };
        return copy;
      }
      return [...msgs, { id: uid(), role: "assistant", md: "", think: delta, streaming: true }];
    }
    case "tool_start": {
      const d = (data ?? {}) as { name?: string; input?: Record<string, unknown> };
      const name = String(d.name ?? "?");
      return [...closeStreaming(msgs), {
        id: uid(), role: "tool", tool: name, argsLabel: summarizeTool(name, d.input), status: "running",
      }];
    }
    case "tool_result": {
      const d = (data ?? {}) as { name?: string; is_error?: boolean; content?: string; display?: string };
      // 工具按模型给出的顺序串行执行（TinyAgent CallbackTool=Sequential），
      // 同名调用必须 FIFO 配对；从后往前找会把第一条结果写到第二张卡。
      const idx = msgs.findIndex((m) => m.role === "tool" && m.tool === (d.name ?? "?") && m.status === "running");
      if (idx < 0) return msgs;
      const copy = [...msgs];
      const m = copy[idx] as Extract<AgentMsg, { role: "tool" }>;
      copy[idx] = { ...m, status: d.is_error ? "err" : "ok", output: String(d.display ?? d.content ?? "") };
      return copy;
    }
    case "notice":
      return [...closeStreaming(msgs), { id: uid(), role: "assistant", md: `> ⚠ ${String(data ?? "")}`, think: "", streaming: false }];
    case "done": {
      const reason = String((data as { stop_reason?: string })?.stop_reason ?? "");
      const closed = settleRunningTools(closeStreaming(msgs), t("运行已结束，工具未返回结果"));
      // 旧转写/异常 wire 没有 reason 时按正常收口，避免历史回放冒出一条空提示。
      const notice = reason ? stopReasonNotice(reason) : null;
      return notice
        ? [...closed, { id: uid(), role: "assistant", md: `> ⚠ ${notice}`, think: "", streaming: false }]
        : closed;
    }
    case "failed": {
      const message = String((data as { message?: string })?.message ?? t("未知错误"));
      return [
        ...settleRunningTools(closeStreaming(msgs), message),
        { id: uid(), role: "assistant", md: `**${t("运行失败")}**：${message}`, think: "", streaming: false },
      ];
    }
    default:
      return msgs;
  }
}

/** assistant 消息独立 memo：props 全是基本量——历史消息在流式期间不再逐 delta
    重跑 renderAgentMd + hljs 全量高亮（每 delta × 全部历史消息曾是 O(总字节×事件数)
    的主线程热点；只有流式中那条会重渲染）。 */
const AssistantMsg = memo(function AssistantMsg({ md, think, streaming, lang }: { md: string; think: string; streaming: boolean; lang: string }) {
  return (
    <div className="msg-row assistant" data-lang={lang}>
      <div style={{ maxWidth: "100%", minWidth: 0 }}>
        {think && (
          <details className="ag-think">
            <summary>{t("思考过程")}</summary>
            <pre>{think}</pre>
          </details>
        )}
        <div className="md-block" data-testid="agent-md" dangerouslySetInnerHTML={{ __html: renderAgentMd(md, streaming) }} />
        {streaming && <span className="ag-cursor" aria-hidden="true" />}
      </div>
    </div>
  );
});

/** 内联高危审批二次确认臂的有效期（与协作面板同一根减速带、同一时长口径）：
 *  臂只活 5 秒——到期自动撤销并恢复按钮文案，单击不会放行；切会话/换卡/卸载
 *  都清计时器，避免一个早被遗忘的踏板在之后的手滑里被踩响。 */
export const INLINE_RISK_CONFIRM_TTL_MS = 5000;

/** 逐段判定摘要（一行可折叠）：把核心的 verdict 前缀折算成人类可扫的计数。
 *  「pending/其它」统一按需确认归并——UI 不自造判定等级，只做汇总呈现。 */
function segmentSummary(a: ApprovalRow): string {
  let allow = 0, need = 0, deny = 0;
  for (const s of a.segment_report) {
    if (s.verdict.startsWith("allow:")) allow++;
    else if (s.verdict.startsWith("deny:")) deny++;
    else need++;
  }
  const parts: string[] = [];
  if (allow) parts.push(t("{0} 允许", allow));
  if (need) parts.push(t("{0} 需确认", need));
  if (deny) parts.push(t("{0} 拦截", deny));
  return t("{0} 段判定：{1}", a.segment_report.length, parts.join(" · "));
}

export function AgentView({
  width, sid, fleet, hostLabel, tmuxNote, pending, onDecide, owner, onDelegate,
  autonomyOn, onToggleAutonomy, onOpenApprovals,
  gripDrag, gripDown, gripMove, gripUp, onClose, pushToast,
}: AgentViewProps) {
  const [convs, setConvs] = useState<Record<string, AgentMsg[]>>({});
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const [stopping, setStopping] = useState<Record<string, boolean>>({});
  // 内联审批的高危二次确认（与协作面板同一根减速带）：首次点击只表态，
  // 第二次才真的批准——对话流里最容易手滑点掉的一道闸。臂带 TTL，见下方 effect。
  const [inlineRiskConfirm, setInlineRiskConfirm] = useState<string | null>(null);
  const [inlineRiskLeft, setInlineRiskLeft] = useState(0);
  const [sending, setSending] = useState<Record<string, boolean>>({});
  // 草稿按会话隔离：共享一份时，在 A 会话输入一半切到 B，按 Enter 会把 A 的
  // 命令发到 B（SSH 场景下的真实错主机风险）。
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  // 夺权显式化：真模式下人类持有控制权时发送 → 先请求交托（确认条），不悄悄改控制权
  const [askDelegate, setAskDelegate] = useState(false);
  const [askText, setAskText] = useState("");
  const askSidRef = useRef<string | null>(null);
  const [delegateBusy, setDelegateBusy] = useState(false);
  // 自主模式两击确认（开启才需要；关闭单击即回）。arm 4s 无第二击自动回退
  const [autonomyArm, setAutonomyArm] = useState(false);
  const autonomyArmTimer = useRef(0);
  useEffect(() => () => { if (autonomyArmTimer.current) window.clearTimeout(autonomyArmTimer.current); }, []);
  const clickAutonomy = () => {
    if (autonomyOn) { setAutonomyArm(false); onToggleAutonomy(false); return; }
    if (autonomyArm) {
      if (autonomyArmTimer.current) window.clearTimeout(autonomyArmTimer.current);
      setAutonomyArm(false);
      onToggleAutonomy(true);
      return;
    }
    setAutonomyArm(true);
    autonomyArmTimer.current = window.setTimeout(() => setAutonomyArm(false), 4000);
  };
  // 真模式前提：inTauri 且已配置模型服务（null = 未配置/浏览器 demo）
  const [modelCfg, setModelCfg] = useState<{ provider?: string; model?: string } | null>(null);
  // 三态：Tauri 下先等 agent_model_get 落定，避免已配置模型时首帧闪一下
  // 「演练」外壳/脚本欢迎语；浏览器 demo 直接视为已落定（永远演练）。
  const [modelLoaded, setModelLoaded] = useState(!inTauri);
  const realMode = inTauri && modelLoaded && modelCfg !== null;
  const modelPending = inTauri && !modelLoaded;
  const alive = useRef(true);
  const timers = useRef<number[]>([]);
  const seq = useRef({ n: 0 });
  const nearBottomRef = useRef(true);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const pendingTool = useRef<{ k: string; id: string; script: ReturnType<typeof mockScript> } | null>(null);
  // 真模式装载过的会话（R3-B-10）：persist 不入演练仓、回演练时清场重播欢迎语
  const realModeSidsRef = useRef<Set<string>>(new Set());
  const key = sid ?? "";
  const draft = drafts[key] ?? "";
  const setDraft = (v: string) => setDrafts((cur) => ({ ...cur, [key]: v }));
  const msgs = convs[key] ?? [];

  const later = (fn: () => void, ms: number) => {
    const h = window.setTimeout(() => { if (alive.current) fn(); }, ms);
    timers.current.push(h);
  };
  const patch = (k: string, fn: (cur: AgentMsg[]) => AgentMsg[]) => {
    setConvs((cur) => ({ ...cur, [k]: fn(cur[k] ?? []) }));
  };
  const newId = () => `m${++mockMsgSeq}`;

  // 模型服务配置（真模式开关）：挂载拉取 + 设置卡保存后刷新
  useEffect(() => {
    if (!inTauri) return;
    let dead = false;
    const load = () => {
      invoke("agent_model_get", {})
        .then((v) => {
          if (dead) return;
          setModelCfg(v ?? null);
          setModelLoaded(true);
        })
        .catch(() => {
          if (dead) return;
          setModelCfg(null);
          setModelLoaded(true);
        });
    };
    load();
    window.addEventListener("agent-model-saved", load);
    return () => { dead = true; window.removeEventListener("agent-model-saved", load); };
  }, []);

  // 真模式：agent-event 订阅（任何会话的事件都收——后台会话也会推进）。
  // 稳定轮：120ms 合帧——真模型流式每秒可达百级 TextDelta，逐条 setState 曾把
  // 整树渲染打满（transfer 事件本就有 120ms 合帧，此处同口径）；done/failed
  // 终态即时落（先冲积压保顺序，busy 翻转不滞后）。
  const frameRef = useRef<{ evs: AgentWire[]; timer: number } | null>(null);
  // 历史回放期间的实时事件缓冲：history 响应会整体替换 conv，若期间直接
  // apply live 事件，快照之后的事件会被覆盖（丢消息/丢 done 导致 busy 永久
  // 为真）。缓冲到 history 落地后按序重放，保证「快照 + 增量」不重不漏。
  const historyPendingRef = useRef<Record<string, AgentWire[] | undefined>>({});
  useEffect(() => {
    if (!inTauri || !realMode) return;
    let un: (() => void) | null = null;
    let dead = false;
    const flush = () => {
      const buf = frameRef.current;
      if (!buf) return;
      frameRef.current = null;
      setConvs((cur) => {
        let next = cur;
        for (const wire of buf.evs) {
          next = { ...next, [wire.sid]: applyAgentEvent(next[wire.sid] ?? [], wire.event, seq.current) };
        }
        return next;
      });
    };
    listen("agent-event", (ev) => {
      const wire = (ev as unknown as { payload: AgentWire }).payload;
      if (!wire?.sid || !wire?.event) return;
      const pending = historyPendingRef.current[wire.sid];
      if (pending) {
        pending.push(wire);
        return;
      }
      if (wire.event.kind === "done" || wire.event.kind === "failed") {
        flush();
        setConvs((cur) => ({ ...cur, [wire.sid]: applyAgentEvent(cur[wire.sid] ?? [], wire.event, seq.current) }));
        setBusy((b) => ({ ...b, [wire.sid]: false }));
        setStopping((b) => ({ ...b, [wire.sid]: false }));
        return;
      }
      const buf = frameRef.current ?? { evs: [], timer: 0 };
      buf.evs.push(wire);
      if (!frameRef.current) {
        buf.timer = window.setTimeout(flush, 120);
        frameRef.current = buf;
      }
    }).then((u) => { if (dead) u(); else un = u; });
    return () => {
      dead = true; if (un) un();
      if (frameRef.current) { window.clearTimeout(frameRef.current.timer); frameRef.current = null; }
    };
  }, [realMode]);

  // 真模式：切会话拉转写重建（重挂载/切标签后对话完整回放）
  useEffect(() => {
    if (!inTauri || !realMode || !sid) return;
    let dead = false;
    historyPendingRef.current[sid] = [];
    invoke("agent_history", { sid })
      .then((hist) => {
        if (dead) {
          delete historyPendingRef.current[sid];
          return;
        }
        const buffered = historyPendingRef.current[sid] ?? [];
        delete historyPendingRef.current[sid];
        MOCK_CONVS.delete(sid); // 真模式历史接管：清演练残留（演练→真模型切换）
        realModeSidsRef.current.add(sid); // 标记来源：回演练时清场（见 persist 配对 effect）
        let m: AgentMsg[] = [];
        for (const ev of (hist ?? []) as AgentWireEvent[]) m = applyAgentEvent(m, ev, seq.current);
        // 快照之后到达的实时事件按序补放，不能被整体替换吞掉。
        for (const wire of buffered) m = applyAgentEvent(m, wire.event, seq.current);
        setConvs((cur) => ({ ...cur, [sid]: m }));
        const histEvents = (hist ?? []) as AgentWireEvent[];
        const lastKind = buffered.length
          ? buffered[buffered.length - 1].event.kind
          : (histEvents.length ? histEvents[histEvents.length - 1].kind : "");
        const running = lastKind !== "" && lastKind !== "done" && lastKind !== "failed";
        setBusy((b) => ({ ...b, [sid]: running }));
        if (!running) setStopping((b) => ({ ...b, [sid]: false }));
      })
      .catch(() => {
        // 历史拉取失败：至少把缓冲的实时事件落到当前会话，不让 UI 空白。
        const buffered = historyPendingRef.current[sid] ?? [];
        delete historyPendingRef.current[sid];
        if (!dead && buffered.length) {
          setConvs((cur) => {
            let next = cur;
            for (const wire of buffered) {
              next = { ...next, [sid]: applyAgentEvent(next[sid] ?? [], wire.event, seq.current) };
            }
            return next;
          });
        }
      });
    return () => {
      dead = true;
      delete historyPendingRef.current[sid];
    };
  }, [realMode, sid]);

  // 演练模式：首见会话种欢迎消息（fleet 形态用编排者专用欢迎语——它不是每会话
  // 独立对话；文案按界面语言分流）。关面板重开时优先取演练仓回放（UX2-3）。
  // 仓内容恢复时消毒：卸载瞬间 persist 的中间态（streaming 光标/running·pending
  // 工具卡）无人收尾——光标永闪、渲染闸永久关闭、审批按钮 no-op（R3-B-2）。
  useEffect(() => {
    if (realMode || modelPending || !sid) return;
    const welcome = welcomeMd(!!fleet);
    setConvs((cur) => (cur[sid] ? cur : { ...cur, [sid]: sanitizeMockMsgs(MOCK_CONVS.get(sid) ?? [{ id: `w-${sid}`, role: "assistant", md: welcome, think: "", streaming: false }], t("面板关闭时中断，未完成")) }));
  }, [sid, realMode, fleet, modelPending]);

  // 演练域对话写入仓（与种子 effect 配对）；真模式历史走 agent_history 回放，
  // 装载时把该会话的演练残留清掉（演练→真模型切换不串场）。
  // 真模式装载过的会话不入仓（R3-B-10）：真历史被 persist 进演练仓后，演练
  // 回复会续写在真实历史后面——回演练瞬间清掉该会话对话，重播欢迎语干净开始。
  useEffect(() => {
    if (realMode) return;
    for (const [k, v] of Object.entries(convs)) {
      if (v.length > 0 && !realModeSidsRef.current.has(k)) {
        // 先删后插刷新 Map 插入序：原实现只 set，已存在的键不更新顺序，
        // 超 64 会话时被淘汰的会是「最早创建」而非「最久未用」的会话。
        MOCK_CONVS.delete(k);
        MOCK_CONVS.set(k, v);
      }
    }
    if (MOCK_CONVS.size > 64) {
      for (const k of [...MOCK_CONVS.keys()].slice(0, MOCK_CONVS.size - 64)) MOCK_CONVS.delete(k);
    }
  }, [convs, realMode]);

  // 真模式→演练回切：清掉来自真模式装载的对话（种子 effect 重播欢迎语）
  useEffect(() => {
    if (realMode || realModeSidsRef.current.size === 0) return;
    const sids = [...realModeSidsRef.current];
    realModeSidsRef.current = new Set();
    const welcome = welcomeMd(!!fleet);
    setConvs((cur) => {
      let changed = false;
      const next = { ...cur };
      for (const s of sids) {
        if (next[s] === undefined) continue;
        // 清场即补种（R3-B-10 补口）：种子 effect 的 deps 未变不会重跑——当前
        // 打开的会话会停在零消息空面板。真模式会话不入仓，MOCK_CONVS 必无此
        // sid，补种即干净欢迎语（与种子 effect 同源同语义）
        next[s] = sanitizeMockMsgs([{ id: `w-${s}`, role: "assistant", md: welcome, think: "", streaming: false }], t("面板关闭时中断，未完成"));
        changed = true;
      }
      return changed ? next : cur;
    });
  }, [realMode, fleet]);

  // 卸载清计时器（演练流式/模拟执行的挂起回调不得写卸载后的 state）
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; timers.current.forEach(clearTimeout); timers.current = []; };
  }, []);

  // 切会话收起委托确认条（待发文本是上一个会话的语境）
  useEffect(() => {
    setAskDelegate(false);
    setAskText("");
    askSidRef.current = null;
  }, [sid]);

  // 新消息/流式增长 → 仅当用户原本就在底部附近才贴底；向上翻阅历史时不再
  // 被每个 delta 拽回底部（审批卡在视口下方时也会因 msgs 不变而不触发，见
  // inlineApproval 的独立提示）。
  useEffect(() => {
    const el = scrollRef.current;
    if (el && nearBottomRef.current) el.scrollTop = el.scrollHeight;
  }, [msgs]);

  // 真模式切换时清掉演练计时器/待审批 ref：否则脚本流式回调会在真实对话里
  // 追加一张假工具卡（甚至可点“批准执行”）。
  useEffect(() => {
    if (!realMode) return;
    timers.current.forEach(clearTimeout);
    timers.current = [];
    pendingTool.current = null;
  }, [realMode]);

  // mermaid/公式占位渲染：流式中保持源码原文（尾块每帧重建不值得反复渲染），
  // turn 末稳定后 rAF 一拍（等 innerHTML 落地）再批量渲染；data-done 占位防
  // 并发重渲染，库加载/语法失败诚实保持源码原文（见 mmd.ts/math.ts）
  useEffect(() => {
    if (msgs.some((m) => m.role === "assistant" && m.streaming)) return;
    const raf = requestAnimationFrame(() => {
      const el = scrollRef.current;
      if (!el) return;
      void renderMermaidIn(el);
      void renderMathIn(el);
    });
    return () => cancelAnimationFrame(raf);
  }, [msgs]);

  // 主题/深浅切换（palette data-theme × chrome data-chrome 双轴）→ 已渲染的
  // mermaid 图按新主题变量重画（公式是纯文本排版不受主题影响，无需重渲染）
  useEffect(() => {
    const obs = new MutationObserver(() => {
      const el = scrollRef.current;
      if (el) void rerenderMermaids(el);
    });
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "data-chrome"] });
    return () => obs.disconnect();
  }, []);

  /** 流式追加一条 assistant markdown，结束后回调（演练脚本链）。 */
  const streamMd = (k: string, full: string, after?: () => void) => {
    const id = newId();
    patch(k, (cur) => [...cur, { id, role: "assistant", md: "", think: "", streaming: true }]);
    let i = 0;
    const tick = () => {
      i = Math.min(full.length, i + STREAM_CHARS);
      patch(k, (cur) => cur.map((m) => (m.id === id && m.role === "assistant" ? { ...m, md: full.slice(0, i) } : m)));
      if (i < full.length) later(tick, STREAM_MS);
      else {
        patch(k, (cur) => cur.map((m) => (m.id === id && m.role === "assistant" ? { ...m, streaming: false } : m)));
        after?.();
      }
    };
    later(tick, STREAM_MS);
  };

  const setTool = (k: string, id: string, fields: Partial<Extract<AgentMsg, { role: "tool" }>>) => {
    patch(k, (cur) => cur.map((m) => (m.id === id && m.role === "tool" ? { ...m, ...fields } : m)));
  };

  const send = () => {
    const text = draft.trim();
    if (!text || !sid || modelPending) return;
    // 上一轮还在跑：不抢占/不丢草稿。发送按钮同样禁用（Rust 侧也会拒绝）。
    if (realMode && (!!busy[key] || !!sending[key])) return;
    // 演练域只维护一张待审批卡（pendingTool 单槽）：连续发送会让前一张卡
    // 永远停在待审批，批准时还会用错脚本。
    if (!realMode && pendingTool.current) {
      pushToast("info", t("先处理当前工具卡，再发送下一条"));
      return;
    }
    // 夺权显式化：真模式下会话还在人类手里 → 先请求交托（确认条），草稿保留。
    // 编排形态跳过——它不直接操作机器，目标会话的审批/控制权在目标侧独立生效。
    if (realMode && !fleet && owner !== "Agent") {
      setAskText(text);
      askSidRef.current = sid;
      setAskDelegate(true);
      return;
    }
    doSend(text);
  };

  const doSend = (text: string) => {
    if (!sid) return;
    const k = key;
    if (realMode) {
      // 用户气泡由 Rust 侧同步 emit 的 User 事件写入（单一写入方）——这里再乐观
      // 追加会与事件流各出一条（真机实测同文气泡×2）。只有 invoke 受理后才
      // 清草稿/置 busy：busy 拒绝或配置错误时保留原文，且不会把正在跑的停止钮
      // 误关掉。
      setSending((b) => ({ ...b, [k]: true }));
      invoke("agent_send", { sid, text })
        .then(() => {
          setDrafts((cur) => (cur[k] === text ? { ...cur, [k]: "" } : cur));
          setBusy((b) => ({ ...b, [k]: true }));
          setStopping((b) => ({ ...b, [k]: false }));
        })
        .catch((e) => {
          patch(k, (cur) => [...closeStreaming(cur), { id: newId(), role: "assistant", md: `**${t("发送失败")}**：${String(e)}`, think: "", streaming: false }]);
        })
        .finally(() => setSending((b) => ({ ...b, [k]: false })));
      return;
    }
    // 演练路径（脚本分岔见 agent-mock）
    setDrafts((cur) => ({ ...cur, [k]: "" }));
    patch(k, (cur) => [...cur, { id: newId(), role: "user", text }]);
    const script = mockScript(text);
    streamMd(k, script.intro, () => {
      const tid = newId();
      patch(k, (cur) => [...cur, { id: tid, role: "tool", tool: script.tool.tool, argsLabel: script.tool.argsLabel, status: "pending" }]);
      pendingTool.current = { k, id: tid, script };
    });
  };

  const confirmDelegate = async () => {
    if (delegateBusy) return;
    const askSid = askSidRef.current;
    if (!askSid) return;
    setDelegateBusy(true);
    const ok = await onDelegate();
    setDelegateBusy(false);
    // 等待期间切了会话/点了取消：不得把旧会话的草稿发出去。
    if (!ok || askSidRef.current !== askSid) return;
    const text = askText;
    setAskDelegate(false);
    setAskText("");
    askSidRef.current = null;
    doSend(text);
  };

  const stop = () => {
    if (!sid || stopping[key]) return;
    setStopping((b) => ({ ...b, [key]: true }));
    invoke("agent_cancel", { sid })
      .then((ok) => {
        if (!ok) {
          setStopping((b) => ({ ...b, [key]: false }));
          pushToast("info", t("当前没有在途运行"));
        }
      })
      .catch((e) => {
        setStopping((b) => ({ ...b, [key]: false }));
        pushToast("err", t("停止失败：{0}", String(e)));
      });
  };

  const approve = () => {
    const p = pendingTool.current;
    if (!p) return;
    pendingTool.current = null;
    setTool(p.k, p.id, { status: "running" });
    later(() => {
      setTool(p.k, p.id, { status: "ok", output: p.script.tool.output });
      streamMd(p.k, p.script.summary);
    }, RUN_MS);
  };
  const deny = () => {
    const p = pendingTool.current;
    if (!p) return;
    pendingTool.current = null;
    setTool(p.k, p.id, { status: "denied" });
    streamMd(p.k, p.script.denied);
  };

  // markdown 代码块 复制/展开 点击走容器事件代理（流式重建 DOM 不能直绑）
  const onScrollClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const el = e.target as HTMLElement;
    if (el.classList.contains("code-copy")) {
      // mermaid：渲染成功后 pre 已被 SVG 替换，源码从 data-mm 取（URL 编码形态）
      const mmWrap = el.closest(".mermaid-wrap") as HTMLElement | null;
      const text = mmWrap?.dataset.mm
        ? decodeURIComponent(mmWrap.dataset.mm)
        : el.closest(".md-code")?.querySelector("pre")?.textContent ?? "";
      // Promise.resolve 包裹（审查二轮 FE2-5）：无 clipboard API 环境下 ?. 短路出
      // undefined，外层 .catch 即同步 TypeError。成功/失败都如实提示——此前
      // 吞错后仍报「已复制」，用户粘贴时才发现剪贴板没变。
      Promise.resolve(inTauri ? clipboard.writeText(text) : navigator.clipboard?.writeText(text))
        .then(() => pushToast("ok", t("已复制代码")))
        .catch(() => pushToast("err", t("复制失败：剪贴板不可用")));
    } else if (el.classList.contains("code-expand")) {
      const box = el.closest(".md-code");
      if (box) {
        const collapsed = box.classList.toggle("code-collapsed");
        el.textContent = collapsed ? t("展开全部") : t("收起");
      }
    }
  };

  const busyNow = !!busy[key] && realMode;
  // 真模式内联审批：最近一张工具卡运行中 + 存在本会话内嵌 agent 的待审批 → 对账呈现
  //（exec/send_keys/upload/download 的审批都在 core-session 同一条链上）
  const inlineApproval = realMode && sid
    ? pending.find((p) => p.agent_id === EMBEDDED_AGENT_ID && p.session_id === sid)
    : undefined;
  // DEV 探针（仅浏览器演练域）：真模式内联审批卡无法在 demo 里自然出现（realMode
  // 门 = inTauri），spec 可注入一张与 ApprovalRow 同形的行来验证呈现与 TTL 臂。
  // 它只走同一段渲染、不进入 pending 列表；release 构建下此分支恒为 undefined。
  const devInlineApproval = import.meta.env.DEV
    ? (window as unknown as { __t_inlineApproval?: ApprovalRow }).__t_inlineApproval
    : undefined;
  const previewApproval = inlineApproval ?? (devInlineApproval && devInlineApproval.session_id === sid ? devInlineApproval : undefined);
  // 内联审批的 120 秒等待超时倒计时（核心口径）：只为呈现，按秒刷新；
  // 卡消失/切卡即停，不留下常驻 interval。
  const [inlineNow, setInlineNow] = useState(() => Date.now());
  useEffect(() => {
    if (!previewApproval) return;
    setInlineNow(Date.now());
    const timer = window.setInterval(() => setInlineNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [previewApproval?.id]);
  // 高危臂 TTL（唯一收口）：依赖是臂本身——重复 arm 换 id 先清旧计时；到期
  // 自动撤臂并恢复按钮文案；切会话（sid 变化）、换卡（id 不匹配）也走同一撤销。
  useEffect(() => {
    if (!inlineRiskConfirm) { setInlineRiskLeft(0); return; }
    const deadline = Date.now() + INLINE_RISK_CONFIRM_TTL_MS;
    setInlineRiskLeft(Math.ceil(INLINE_RISK_CONFIRM_TTL_MS / 1000));
    const tick = window.setInterval(() => {
      setInlineRiskLeft(Math.max(0, Math.ceil((deadline - Date.now()) / 1000)));
    }, 200);
    const expire = window.setTimeout(() => {
      setInlineRiskLeft(0);
      setInlineRiskConfirm(null); // 到期即撤：之后的第一击只重新 arm，不放行
    }, INLINE_RISK_CONFIRM_TTL_MS);
    return () => { window.clearInterval(tick); window.clearTimeout(expire); };
  }, [inlineRiskConfirm]);
  // 切会话收起臂（旧会话的第二次点击不得落到新会话的审批上）
  useEffect(() => { setInlineRiskConfirm(null); setInlineRiskLeft(0); }, [sid]);
  // 审批行被别处处理/超时消失或换成另一张卡 → 立即撤臂
  useEffect(() => {
    if (inlineRiskConfirm && inlineRiskConfirm !== previewApproval?.id) setInlineRiskConfirm(null);
  }, [inlineRiskConfirm, previewApproval?.id]);
  // 工具串行执行：审批只属于第一张 running 卡；此前每张同名 running 卡都渲染
  // 批准/拒绝，点错卡会把审批显示挂到错误的调用上。
  const firstRunningToolId = msgs.find((m) => m.role === "tool" && m.status === "running")?.id;

  const toolChip = (m: Extract<AgentMsg, { role: "tool" }>) => {
    switch (m.status) {
      case "pending": return <span className="tc-chip warn">{t("待审批")}</span>;
      case "running":
        return inlineApproval && ["exec", "send_keys", "upload", "download"].includes(m.tool)
          ? <span className="tc-chip warn">{t("待审批")}</span>
          : <span className="tc-chip info"><IconLoader size={11} className="spin" /> {t("运行中")}</span>;
      case "ok": return <span className="tc-chip ok">{t("完成")}</span>;
      case "err": return <span className="tc-chip err">{t("出错")}</span>;
      case "denied": return <span className="tc-chip dim">{t("已拒绝")}</span>;
    }
  };

  /** 内联审批的呈现（真模式卡与 DEV 预览共用同一段）：命令可读性提档、
   *  目的缺失显式警示、逐段判定可折叠、120s 超时实时倒计时、高危臂带剩余秒数。 */
  const inlineApprovalActions = (a: ApprovalRow) => {
    const risk = approvalRisk(a);
    const gated = !!risk && inlineRiskConfirm !== a.id;
    const born = Date.parse(a.created_at);
    const left = Number.isFinite(born) ? Math.max(0, 120 - Math.floor((inlineNow - born) / 1000)) : null;
    return (
      <>
        <div className="tc-actions">
          <div style={{ flex: 1, minWidth: 0 }}>
            {a.target_summary && (
              <div style={{ marginBottom: 4 }}>
                <span className="tsum-chip" title={t("命令本身的破坏性提示（核心判定）")}>{a.target_summary}</span>
              </div>
            )}
            <div className="mono" data-testid="agent-inline-cmd"
              style={{ fontSize: "calc(12px * var(--ui-font-scale))", color: "var(--text)", maxHeight: 80, overflow: "auto", whiteSpace: "pre-wrap", wordBreak: "break-all" }}>
              {a.command}
            </div>
            <div data-testid="agent-inline-purpose"
              style={{ fontSize: "calc(11px * var(--ui-font-scale))", marginTop: 3, color: a.purpose ? "var(--text-sub)" : "var(--warn)" }}>
              {t("目的：")}{a.purpose || t("未提供目的（Agent 未收到委托说明）")}
            </div>
            {a.segment_report.length > 0 && (
              <details data-testid="agent-inline-segs">
                <summary style={{ fontSize: "calc(11px * var(--ui-font-scale))", color: "var(--text-sub)", cursor: "pointer" }}>{segmentSummary(a)}</summary>
                {a.segment_report.map((s, i) => (
                  <div key={i} style={{ fontSize: "calc(11px * var(--ui-font-scale))", color: "var(--text-sub)" }}>· {s.segment} — {s.verdict}</div>
                ))}
              </details>
            )}
            {risk && (
              <div style={{ fontSize: "calc(11px * var(--ui-font-scale))", color: "var(--warn)" }}>⚠ {t("{0}——批准前请确认命令的全部效果。", risk)}</div>
            )}
            {left !== null ? (
              <div data-testid="agent-inline-countdown" style={{ fontSize: "calc(11px * var(--ui-font-scale))", color: "var(--warn-text)" }}>
                ⏳ {left > 0
                  ? t("剩余 {0} 秒后自动拒绝——命令不会执行", left)
                  : t("已超时，等待核心按拒绝结算…")}
              </div>
            ) : (
              <div style={{ fontSize: "calc(11px * var(--ui-font-scale))", color: "var(--warn-text)" }}>{t("120 秒内未处理将自动拒绝，命令不会执行")}</div>
            )}
          </div>
          <button className={gated ? "warn" : "primary"} data-testid="agent-approve-real"
            onClick={() => {
              if (gated) { setInlineRiskConfirm(a.id); return; }
              setInlineRiskConfirm(null);
              onDecide(a.id, "approve", null);
            }}>
            {!risk ? t("批准")
              : gated ? t("确认高危并批准")
                : inlineRiskLeft > 0 ? t("再次点击确认批准（剩余 {0} 秒）", inlineRiskLeft)
                  : t("再次点击确认批准")}
          </button>
          <button className="ghost" data-testid="agent-deny-real"
            onClick={() => { setInlineRiskConfirm(null); onDecide(a.id, "deny", null); }}>{t("拒绝")}</button>
        </div>
        {/* 完整裁决（分组/目标/逐段判定与记忆入口）在协作面板；对话流里只留一键去路 */}
        {onOpenApprovals && (
          <div style={{ padding: "0 10px 7px" }}>
            <button className="ghost" data-testid="agent-open-approvals" onClick={onOpenApprovals}>
              {t("在协作面板查看完整裁决")}
            </button>
          </div>
        )}
      </>
    );
  };

  const newConversation = () => {
    if (!sid) return;
    if (realMode) {
      // 真模式「新对话」= 清 FE 呈现（Rust 侧 agent 上下文仍在——如实提示，不冒充清空）
      setConvs((cur) => ({ ...cur, [key]: [] }));
      pushToast("info", t("已清空对话显示（模型上下文仍在，重启应用才彻底重置）"));
      return;
    }
    setConvs((cur) => ({ ...cur, [key]: [{ id: `w-${key}-${Date.now()}`, role: "assistant", md: welcomeMd(!!fleet), think: "", streaming: false }] }));
  };

  return (
    <>
      <aside className="agentbar" data-testid="agent-view" style={{ width }} aria-label={t("Agent 对话")}>
      <div className="ag-head">
        <IconBot size={15} />
        <b>Agent</b>
        {sid && <span className="ag-host" title={t("当前会话（对话按会话隔离）")}>{hostLabel}</span>}
        {realMode ? (
          <span className="ag-host" title={t("模型服务：{0}", modelCfg?.provider ?? "")}>{modelCfg?.model}</span>
        ) : modelPending ? (
          <span className="ag-host" title={t("正在读取模型服务配置…")}>{t("读取中…")}</span>
        ) : (
          <span className="ag-mock" title={t("当前为演练外壳：回复与工具卡是脚本数据，配置模型服务后自动切换为真实模型")}>{t("演练")}</span>
        )}
        {realMode && sid && !fleet && (
          <span
            className={"ag-own" + (owner === "Agent" ? " on" : "")}
            data-testid="agent-own"
            title={owner === "Agent"
              ? t("会话控制权已交给 Agent（工具栏「接管」随时收回）")
              : t("会话控制权在你手里——发送任务时会先请求交给 Agent")}
          >{owner === "Agent" ? t("已交给") : t("未交给")}</span>
        )}
        {realMode && sid && !fleet && (
          <button
            className={"ag-autonomy" + (autonomyOn ? " on" : "") + (autonomyArm ? " arm" : "")}
            data-testid="agent-autonomy"
            aria-pressed={autonomyOn}
            title={autonomyOn
              ? t("自主模式开启中：命令免逐条审批（危险名单仍硬拦、传输仍逐条、全量记录，上方急停条可随时撤回）。点击关闭")
              : autonomyArm
                ? t("再点一次确认开启自主模式（命令免逐条审批；危险名单仍硬拦、传输仍逐条、全量记录、可急停）")
                : t("自主模式：命令免逐条审批（危险名单仍硬拦、传输仍逐条、全量记录、可急停）。点击开启")}
            onClick={clickAutonomy}
          >{autonomyOn ? t("自主") : autonomyArm ? t("确认开启？") : t("自主")}</button>
        )}
        {fleet && (
          <span className="ag-own on" title={t("编排者不直接操作机器；派发目标的审批/控制权在目标会话独立生效")}>{t("编排")}</span>
        )}
        <span style={{ flex: 1 }} />
        {sid && (
          <button className="ghost icon-btn" title={t("新对话（清空当前会话的对话显示）")} aria-label={t("新对话")}
            data-testid="agent-new"
            onClick={newConversation}>
            <IconPlus size={14} />
          </button>
        )}
        <button className="ghost icon-btn" title={t("关闭 Agent 视图")} aria-label={t("关闭 Agent 视图")} onClick={onClose}><IconX size={14} /></button>
      </div>
      {sid ? (
        <>
          <div
            className="ag-scroll"
            ref={scrollRef}
            onClick={onScrollClick}
            onScroll={() => {
              const el = scrollRef.current;
              if (el) nearBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
            }}
          >
            {msgs.length === 0 && realMode && (
              <div className="ag-empty">
                {fleet
                  ? t("编排者就绪（模型 {0}）——下达跨主机任务，它会派发给各会话的执行 agent 并汇总结果。", modelCfg?.model ?? "")
                  : t("会话已就绪（模型 {0}）——直接下达任务。", modelCfg?.model ?? "")}
              </div>
            )}
            {msgs.map((m) => {
              if (m.role === "user") {
                return <div className="msg-row user" key={m.id}><div className="bubble-user">{m.text}</div></div>;
              }
              if (m.role === "assistant") {
                return <AssistantMsg key={m.id} md={m.md} think={m.think} streaming={m.streaming} lang={localeNow()} />;
              }
              const showApprove = m.status === "running" && m.id === firstRunningToolId && !!inlineApproval
                && ["exec", "send_keys", "upload", "download"].includes(m.tool);
              const showLocalButtons = !realMode && m.status === "pending";
              return (
                <div className={"tool-card tc-" + (m.status === "err" ? "err" : m.status)} key={m.id} data-testid="agent-tool">
                  <div className="tc-head">
                    <span className="tc-tool mono">{m.tool}</span>
                    <span className="tc-args mono" title={m.argsLabel}>{m.argsLabel}</span>
                    {toolChip(m)}
                  </div>
                  {(m.status === "ok" || m.status === "err") && m.output && <pre className="tc-out">{m.output}</pre>}
                  {showLocalButtons && (
                    <div className="tc-actions">
                      <button className="primary" data-testid="agent-approve" onClick={approve}>{t("批准执行")}</button>
                      <button className="ghost" data-testid="agent-deny" onClick={deny}>{t("拒绝")}</button>
                    </div>
                  )}
                  {showApprove && inlineApproval && inlineApprovalActions(inlineApproval)}
                </div>
              );
            })}
            {/* DEV 预览（仅演练域）：用注入的审批行渲染与真模式同一段内联卡，
                供 spec 验证呈现/TTL；不参与真实 decide 之外的任何语义。 */}
            {devInlineApproval && previewApproval === devInlineApproval && (
              <div className="tool-card tc-running" data-testid="agent-tool" data-dev-inline="1">
                <div className="tc-head">
                  <span className="tc-tool mono">exec</span>
                  <span className="tc-args mono" title={devInlineApproval.command}>{devInlineApproval.command}</span>
                  <span className="tc-chip warn">{t("待审批")}</span>
                </div>
                {inlineApprovalActions(devInlineApproval)}
              </div>
            )}
          </div>
          {askDelegate && (
            <div className="ag-delegate" data-testid="agent-delegate-strip">
              <span className="ag-delegate-text">
                {t("会话控制权在你手里——交给 Agent 后它才能在这台终端上干活（工具栏「接管」随时收回）。")}
              </span>
              <button className="primary" data-testid="agent-delegate-confirm" disabled={delegateBusy} onClick={confirmDelegate}>
                {delegateBusy ? t("交托中…") : t("交给并发送")}
              </button>
              <button className="ghost" onClick={() => { askSidRef.current = null; setAskDelegate(false); }}>{t("取消")}</button>
            </div>
          )}
          {fleet && pending.length > 0 && (
            onOpenApprovals ? (
              <button type="button" className="ag-tmux ag-link" data-testid="fleet-pending-hint"
                title={t("目标会话的审批在各自会话里独立生效；点此打开协作面板统一处理")}
                onClick={onOpenApprovals}>
                {t("有 {0} 个待审批动作——切到对应会话批准/拒绝，或打开协作面板统一处理", pending.length)}
              </button>
            ) : (
              <div className="ag-tmux" data-testid="fleet-pending-hint" title={t("目标会话的审批在各自会话里独立生效")}>
                {t("有 {0} 个待审批动作——切到对应会话批准/拒绝，或打开协作面板统一处理", pending.length)}
              </div>
            )
          )}
          {!fleet && tmuxNote && (
            /* tmux 联动二（Agent 分窗）：一行小字说明——命令自动落远端专属
               tmux 窗口，切过去可旁观（无设置项，语义不进任何面板） */
            <div className="ag-tmux" data-testid="agent-tmux-hint" title={tmuxNote}>
              {tmuxNote}
            </div>
          )}
          <div className="ag-composer">
            <textarea
              data-testid="agent-input"
              value={draft}
              rows={2}
              aria-label={fleet ? t("编排任务输入") : t("Agent 任务输入")}
              placeholder={fleet
                ? t("下达跨主机任务…（Enter 发送，Shift+Enter 换行）")
                : t("给 Agent 下达任务…（Enter 发送，Shift+Enter 换行）")}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                // IME 双查（§7.3 全仓口径；六轮 BF-3 此前唯独此处缺 229 补查——
                // WKWebView compositionend 后补发 Enter 的 keyCode 仍是 229）
                if (e.key === "Enter" && !e.shiftKey && !(e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229)) {
                  e.preventDefault();
                  if (!busyNow && !sending[key]) send();
                }
              }}
            />
            {busyNow && (
              <button className="ghost" data-testid="agent-stop" disabled={!!stopping[key]}
                title={t("请求停止当前运行（审批/长命令会在当前工具返回后生效）")} onClick={stop}>
                {stopping[key] ? t("停止中…") : t("停止")}
              </button>
            )}
            <button className="primary" data-testid="agent-send" disabled={!draft.trim() || busyNow || !!sending[key] || modelPending} onClick={send}>{t("发送")}</button>
          </div>
        </>
      ) : (
        <div className="ag-empty" data-testid="agent-no-session">
          <div className="ag-empty-card">
            <div className="ag-empty-mark" aria-hidden="true"><IconBot size={26} /></div>
            <div className="ag-empty-title">{t("连接主机，开始 Agent 协作")}</div>
            <div className="ag-empty-desc">{t("连接主机后开始与 Agent 对话。")} {t("先描述要检查或执行的任务，再在当前会话中继续。")}</div>
            <div className="ag-empty-points" aria-label={t("Agent 协作保障")}>
              <span>{t("危险操作需审批")}</span>
              <span>{t("随时接管终端")}</span>
              <span>{t("操作留痕可回看")}</span>
            </div>
          </div>
        </div>
      )}
      </aside>
      {/* 拖宽把手与 hostbar 同构：aside 的兄弟节点（.workspace 行内、贴面板右缘），
          命中区 7px；宽度 = clientX − 44（活动栏占位，见 App.tsx agGripUp） */}
      <div className="hb-grip" role="separator" aria-orientation="vertical"
        aria-label={t("拖动调整 Agent 视图宽度（320–560 px）")} title={t("拖动调整宽度（320–560 px）")}
        onPointerDown={gripDown} onPointerMove={gripMove} onPointerUp={gripUp}
        onPointerCancel={() => { gripDrag.current = false; }} />
    </>
  );
}
