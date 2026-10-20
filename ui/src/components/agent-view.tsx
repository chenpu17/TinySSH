// 内置 Agent 对话视图（活动栏轮外壳 + 接真模型轮双模式）。
// 会话隔离：对话按会话 sid 分键，跟随激活标签页（与块面板同款语义）。
// 双模式：
//  · 真模型（inTauri 且已配置模型服务）：agent_send/agent-event/agent_history/
//    agent_cancel 走 Rust 侧 agent-host（tiny-a 内核 + SessionManager 工具桥，
//    危险命令审批在 core-session 层自动继承；审批卡经 pendingApprovals 对账
//    agent_id=tinyssh-embedded 内联呈现，决策走既有 decide_approval 链）。
//  · 演练（浏览器 demo / 未配置）：agent-mock 脚本驱动，交互形态与真模式一致，
//    如实标注「演练」。
import { useEffect, useRef, useState } from "react";
import type { PointerEvent } from "react";
import * as clipboard from "@tauri-apps/plugin-clipboard-manager";
import { inTauri, invoke, listen } from "../adapter/bridge";
import type { ApprovalRow } from "../app-data";
import { WELCOME_MD, mockScript } from "../agent-mock";
import { renderAgentMd } from "../mdview";
import { IconBot, IconLoader, IconPlus, IconX } from "../icons";

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
  /** 当前会话 sid；欢迎页（无会话）为 null——显空态不可输入 */
  sid: string | null;
  hostLabel: string;
  /** 该会话的内嵌 agent 待审批（inline 批准/拒绝走既有 decide_approval 链） */
  pending: ApprovalRow[];
  onDecide: (id: string, decision: "approve" | "deny" | "edit", edited: string | null) => void;
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
/** 真模式：会话内嵌 agent 的审批对账身份（与 crates/agent-host AGENT_CLIENT_ID 对应） */
const EMBEDDED_AGENT_ID = "tinyssh-embedded";

function closeStreaming(msgs: AgentMsg[]): AgentMsg[] {
  const last = msgs[msgs.length - 1];
  if (last && last.role === "assistant" && last.streaming) {
    const copy = [...msgs];
    copy[copy.length - 1] = { ...last, streaming: false };
    return copy;
  }
  return msgs;
}

function summarizeTool(name: string, input: Record<string, unknown> | undefined): string {
  const i = input ?? {};
  if (name === "exec") return String(i.command ?? "");
  if (name === "read_blocks") return `limit=${String(i.limit ?? 20)}`;
  if (name === "wait_output") return i.regex ? `/${String(i.regex)}/` : "静默等待新输出";
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
      const d = (data ?? {}) as { name?: string; is_error?: boolean; content?: string };
      const idx = [...msgs].reverse().findIndex((m) => m.role === "tool" && m.tool === (d.name ?? "?") && m.status === "running");
      if (idx < 0) return msgs;
      const real = msgs.length - 1 - idx;
      const copy = [...msgs];
      const m = copy[real] as Extract<AgentMsg, { role: "tool" }>;
      copy[real] = { ...m, status: d.is_error ? "err" : "ok", output: String(d.content ?? "") };
      return copy;
    }
    case "notice":
      return [...closeStreaming(msgs), { id: uid(), role: "assistant", md: `> ⚠ ${String(data ?? "")}`, think: "", streaming: false }];
    case "done":
      return closeStreaming(msgs);
    case "failed":
      return [...closeStreaming(msgs), { id: uid(), role: "assistant", md: `**运行失败**：${String((data as { message?: string })?.message ?? "未知错误")}`, think: "", streaming: false }];
    default:
      return msgs;
  }
}

export function AgentView({
  width, sid, hostLabel, pending, onDecide, gripDrag, gripDown, gripMove, gripUp, onClose, pushToast,
}: AgentViewProps) {
  const [convs, setConvs] = useState<Record<string, AgentMsg[]>>({});
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const [draft, setDraft] = useState("");
  // 真模式前提：inTauri 且已配置模型服务（null = 未配置/浏览器 demo）
  const [modelCfg, setModelCfg] = useState<{ provider?: string; model?: string } | null>(null);
  const realMode = inTauri && modelCfg !== null;
  const alive = useRef(true);
  const timers = useRef<number[]>([]);
  const idSeq = useRef(0);
  const seq = useRef({ n: 0 });
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const pendingTool = useRef<{ k: string; id: string; script: ReturnType<typeof mockScript> } | null>(null);
  const key = sid ?? "";
  const msgs = convs[key] ?? [];

  const later = (fn: () => void, ms: number) => {
    const h = window.setTimeout(() => { if (alive.current) fn(); }, ms);
    timers.current.push(h);
  };
  const patch = (k: string, fn: (cur: AgentMsg[]) => AgentMsg[]) => {
    setConvs((cur) => ({ ...cur, [k]: fn(cur[k] ?? []) }));
  };
  const newId = () => `m${++idSeq.current}`;

  // 模型服务配置（真模式开关）：挂载拉取 + 设置卡保存后刷新
  useEffect(() => {
    if (!inTauri) return;
    let dead = false;
    const load = () => {
      invoke("agent_model_get", {})
        .then((v) => { if (!dead) setModelCfg(v ?? null); })
        .catch(() => { if (!dead) setModelCfg(null); });
    };
    load();
    window.addEventListener("agent-model-saved", load);
    return () => { dead = true; window.removeEventListener("agent-model-saved", load); };
  }, []);

  // 真模式：agent-event 订阅（任何会话的事件都收——后台会话也会推进）
  useEffect(() => {
    if (!inTauri || !realMode) return;
    let un: (() => void) | null = null;
    let dead = false;
    listen("agent-event", (ev) => {
      const wire = (ev as unknown as { payload: AgentWire }).payload;
      if (!wire?.sid || !wire?.event) return;
      setConvs((cur) => ({
        ...cur,
        [wire.sid]: applyAgentEvent(cur[wire.sid] ?? [], wire.event, seq.current),
      }));
      if (wire.event.kind === "done" || wire.event.kind === "failed") {
        setBusy((b) => ({ ...b, [wire.sid]: false }));
      }
    }).then((u) => { if (dead) u(); else un = u; });
    return () => { dead = true; if (un) un(); };
  }, [realMode]);

  // 真模式：切会话拉转写重建（重挂载/切标签后对话完整回放）
  useEffect(() => {
    if (!inTauri || !realMode || !sid) return;
    let dead = false;
    invoke("agent_history", { sid })
      .then((hist) => {
        if (dead) return;
        let m: AgentMsg[] = [];
        for (const ev of hist ?? []) m = applyAgentEvent(m, ev, seq.current);
        setConvs((cur) => ({ ...cur, [sid]: m }));
        // 转写末尾不是 done/failed → 运行大概率还在途（重挂载期间的后台运行）
        const lastKind = hist && hist.length > 0 ? hist[hist.length - 1].kind : "";
        setBusy((b) => ({ ...b, [sid]: lastKind !== "" && lastKind !== "done" && lastKind !== "failed" }));
      })
      .catch(() => {});
    return () => { dead = true; };
  }, [realMode, sid]);

  // 演练模式：首见会话种欢迎消息
  useEffect(() => {
    if (realMode || !sid) return;
    setConvs((cur) => (cur[sid] ? cur : { ...cur, [sid]: [{ id: `w-${sid}`, role: "assistant", md: WELCOME_MD, think: "", streaming: false }] }));
  }, [sid, realMode]);

  // 卸载清计时器（演练流式/模拟执行的挂起回调不得写卸载后的 state）
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; timers.current.forEach(clearTimeout); timers.current = []; };
  }, []);

  // 新消息/流式增长 → 贴底
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [msgs]);

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
    if (!text || !sid) return;
    setDraft("");
    if (realMode) {
      patch(key, (cur) => [...cur, { id: newId(), role: "user", text }]);
      setBusy((b) => ({ ...b, [key]: true }));
      invoke("agent_send", { sid, text }).catch((e) => {
        patch(key, (cur) => [...closeStreaming(cur), { id: newId(), role: "assistant", md: `**发送失败**：${String(e)}`, think: "", streaming: false }]);
        setBusy((b) => ({ ...b, [key]: false }));
      });
      return;
    }
    // 演练路径（脚本分岔见 agent-mock）
    const k = key;
    patch(k, (cur) => [...cur, { id: newId(), role: "user", text }]);
    const script = mockScript(text);
    streamMd(k, script.intro, () => {
      const tid = newId();
      patch(k, (cur) => [...cur, { id: tid, role: "tool", tool: script.tool.tool, argsLabel: script.tool.argsLabel, status: "pending" }]);
      pendingTool.current = { k, id: tid, script };
    });
  };

  const stop = () => {
    if (!sid) return;
    invoke("agent_cancel", { sid }).catch(() => {});
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
    const t = e.target as HTMLElement;
    if (t.classList.contains("code-copy")) {
      const pre = t.closest(".md-code")?.querySelector("pre");
      const text = pre?.textContent ?? "";
      (inTauri ? clipboard.writeText(text) : navigator.clipboard?.writeText(text)).catch(() => {});
      pushToast("ok", "已复制代码");
    } else if (t.classList.contains("code-expand")) {
      const box = t.closest(".md-code");
      if (box) {
        const collapsed = box.classList.toggle("code-collapsed");
        t.textContent = collapsed ? "展开全部" : "收起";
      }
    }
  };

  const busyNow = !!busy[key] && realMode;
  // 真模式内联审批：最近一张 exec 卡运行中 + 存在本会话内嵌 agent 的待审批 → 对账呈现
  const inlineApproval = realMode && sid
    ? pending.find((p) => p.agent_id === EMBEDDED_AGENT_ID && p.session_id === sid)
    : undefined;

  const toolChip = (m: Extract<AgentMsg, { role: "tool" }>) => {
    switch (m.status) {
      case "pending": return <span className="tc-chip warn">待审批</span>;
      case "running":
        return inlineApproval && m.tool === "exec"
          ? <span className="tc-chip warn">待审批</span>
          : <span className="tc-chip info"><IconLoader size={11} className="spin" /> 运行中</span>;
      case "ok": return <span className="tc-chip ok">完成</span>;
      case "err": return <span className="tc-chip err">出错</span>;
      case "denied": return <span className="tc-chip dim">已拒绝</span>;
    }
  };

  const newConversation = () => {
    if (!sid) return;
    if (realMode) {
      // 真模式「新对话」= 清 FE 呈现（Rust 侧 agent 上下文仍在——如实提示，不冒充清空）
      setConvs((cur) => ({ ...cur, [key]: [] }));
      pushToast("info", "已清空对话显示（模型上下文仍在，重启应用才彻底重置）");
      return;
    }
    setConvs((cur) => ({ ...cur, [key]: [{ id: `w-${key}-${Date.now()}`, role: "assistant", md: WELCOME_MD, think: "", streaming: false }] }));
  };

  return (
    <>
      <aside className="agentbar" data-testid="agent-view" style={{ width }} aria-label="Agent 对话">
      <div className="ag-head">
        <IconBot size={15} />
        <b>Agent</b>
        {sid && <span className="ag-host" title="当前会话（对话按会话隔离）">{hostLabel}</span>}
        {realMode ? (
          <span className="ag-host" title={`模型服务：${modelCfg?.provider ?? ""}`}>{modelCfg?.model}</span>
        ) : (
          <span className="ag-mock" title="当前为演练外壳：回复与工具卡是脚本数据，配置模型服务后自动切换为真实模型">演练</span>
        )}
        <span style={{ flex: 1 }} />
        {sid && (
          <button className="ghost icon-btn" title="新对话（清空当前会话的对话显示）" aria-label="新对话"
            data-testid="agent-new"
            onClick={newConversation}>
            <IconPlus size={14} />
          </button>
        )}
        <button className="ghost icon-btn" title="关闭 Agent 视图" aria-label="关闭 Agent 视图" onClick={onClose}><IconX size={14} /></button>
      </div>
      {sid ? (
        <>
          <div className="ag-scroll" ref={scrollRef} onClick={onScrollClick}>
            {msgs.length === 0 && realMode && (
              <div className="ag-empty">会话已就绪（模型 {modelCfg?.model}）——直接下达任务。</div>
            )}
            {msgs.map((m) => {
              if (m.role === "user") {
                return <div className="msg-row user" key={m.id}><div className="bubble-user">{m.text}</div></div>;
              }
              if (m.role === "assistant") {
                return (
                  <div className="msg-row assistant" key={m.id}>
                    <div style={{ maxWidth: "100%", minWidth: 0 }}>
                      {m.think && (
                        <details className="ag-think">
                          <summary>思考过程</summary>
                          <pre>{m.think}</pre>
                        </details>
                      )}
                      <div className="md-block" data-testid="agent-md" dangerouslySetInnerHTML={{ __html: renderAgentMd(m.md, m.streaming) }} />
                      {m.streaming && <span className="ag-cursor" aria-hidden="true" />}
                    </div>
                  </div>
                );
              }
              const showApprove = m.status === "running" && !!inlineApproval && m.tool === "exec";
              const showLocalButtons = m.status === "pending";
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
                      <button className="primary" data-testid="agent-approve" onClick={approve}>批准执行</button>
                      <button className="ghost" data-testid="agent-deny" onClick={deny}>拒绝</button>
                    </div>
                  )}
                  {showApprove && inlineApproval && (
                    <div className="tc-actions">
                      <div className="dim" style={{ fontSize: 11, flex: 1, alignSelf: "center", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" }} title={inlineApproval.command}>{inlineApproval.command}</div>
                      <button className="primary" data-testid="agent-approve-real" onClick={() => onDecide(inlineApproval.id, "approve", null)}>批准</button>
                      <button className="ghost" data-testid="agent-deny-real" onClick={() => onDecide(inlineApproval.id, "deny", null)}>拒绝</button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
          <div className="ag-composer">
            <textarea
              data-testid="agent-input"
              value={draft}
              rows={2}
              placeholder="给 Agent 下达任务…（Enter 发送，Shift+Enter 换行）"
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  send();
                }
              }}
            />
            {busyNow && (
              <button className="ghost" data-testid="agent-stop" title="请求停止当前运行" onClick={stop}>停止</button>
            )}
            <button className="primary" data-testid="agent-send" disabled={!draft.trim()} onClick={send}>发送</button>
          </div>
        </>
      ) : (
        <div className="ag-empty">连接主机后开始与 Agent 对话。</div>
      )}
      </aside>
      {/* 拖宽把手与 hostbar 同构：aside 的兄弟节点（.workspace 行内、贴面板右缘），
          命中区 7px；宽度 = clientX − 44（活动栏占位，见 App.tsx agGripUp） */}
      <div className="hb-grip" role="separator" aria-orientation="vertical"
        aria-label="拖动调整 Agent 视图宽度（320–560 px）" title="拖动调整宽度（320–560 px）"
        onPointerDown={gripDown} onPointerMove={gripMove} onPointerUp={gripUp}
        onPointerCancel={() => { gripDrag.current = false; }} />
    </>
  );
}
