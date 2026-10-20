// 内置 Agent 对话视图（活动栏轮）：左侧栏「agent」视图。每会话独立对话（键 = 会话
// sid，切换标签页即切换对话——与块面板同款 per-session 语义），当前为演练外壳：
// 回复与工具卡由 agent-mock 脚本驱动（无真实模型），交互形态与后续真模型一致——
// 流式 markdown → 工具审批卡（批准/拒绝分岔）→ 结果摘要。状态机与计时收敛在
// 本组件；会话数据不落盘（演练态，真模型轮随 agent-host 上后端）。
import { useEffect, useRef, useState } from "react";
import type { PointerEvent } from "react";
import * as clipboard from "@tauri-apps/plugin-clipboard-manager";
import { inTauri } from "../adapter/bridge";
import { WELCOME_MD, mockScript } from "../agent-mock";
import { renderAgentMd } from "../mdview";
import { IconBot, IconLoader, IconPlus, IconX } from "../icons";

type AgentMsg =
  | { id: string; role: "user"; text: string }
  | { id: string; role: "assistant"; md: string; streaming: boolean }
  | {
      id: string; role: "tool"; tool: string; argsLabel: string;
      status: "pending" | "running" | "ok" | "denied";
      exit?: number; output?: string;
    };

export interface AgentViewProps {
  width: number;
  /** 当前会话 sid；欢迎页（无会话）为 null——显空态不可输入 */
  sid: string | null;
  hostLabel: string;
  gripDrag: { current: boolean };
  gripDown: (e: PointerEvent<HTMLDivElement>) => void;
  gripMove: (e: PointerEvent<HTMLDivElement>) => void;
  gripUp: (e: PointerEvent<HTMLDivElement>) => void;
  onClose: () => void;
  pushToast: (kind: "ok" | "err" | "info", text: string) => void;
}

/** 流式节拍：每 90ms 追加 24 字符（CJK 逐段可见，节奏稳定便于测试等待） */
const STREAM_CHARS = 24;
const STREAM_MS = 90;
/** 批准后模拟执行的停顿时长 */
const RUN_MS = 600;

export function AgentView({
  width, sid, hostLabel, gripDrag, gripDown, gripMove, gripUp, onClose, pushToast,
}: AgentViewProps) {
  const [convs, setConvs] = useState<Record<string, AgentMsg[]>>({});
  const [draft, setDraft] = useState("");
  const alive = useRef(true);
  const timers = useRef<number[]>([]);
  const idSeq = useRef(0);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  // 待审批工具卡的续跑上下文（同一时刻至多一张待审批卡——演练脚本串行）
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

  // 首次见到某会话：种欢迎消息（演练声明）
  useEffect(() => {
    if (!sid) return;
    setConvs((cur) => (cur[sid] ? cur : { ...cur, [sid]: [{ id: `w-${sid}`, role: "assistant", md: WELCOME_MD, streaming: false }] }));
  }, [sid]);

  // 卸载清计时器（流式/模拟执行的挂起回调不得写卸载后的 state）
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; timers.current.forEach(clearTimeout); timers.current = []; };
  }, []);

  // 新消息/流式增长 → 贴底（演练视图不做「用户上翻即停」的精细策略，R1 从简）
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [msgs]);

  /** 流式追加一条 assistant markdown，结束后回调（链式驱动脚本下一步） */
  const streamMd = (k: string, full: string, after?: () => void) => {
    const id = newId();
    patch(k, (cur) => [...cur, { id, role: "assistant", md: "", streaming: true }]);
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
    const k = key;
    patch(k, (cur) => [...cur, { id: newId(), role: "user", text }]);
    const script = mockScript(text);
    streamMd(k, script.intro, () => {
      const tid = newId();
      patch(k, (cur) => [...cur, { id: tid, role: "tool", tool: script.tool.tool, argsLabel: script.tool.argsLabel, status: "pending" }]);
      // 批准/拒绝分支在 approve/deny 内续跑
      pendingTool.current = { k, id: tid, script };
    });
  };

  // 待审批工具卡的续跑上下文见上方 ref 声明（同一时刻至多一张待审批卡——演练脚本串行）

  const approve = () => {
    const p = pendingTool.current;
    if (!p) return;
    pendingTool.current = null;
    setTool(p.k, p.id, { status: "running" });
    later(() => {
      setTool(p.k, p.id, { status: "ok", exit: p.script.tool.exit, output: p.script.tool.output });
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

  // markdown 代码块 复制/展开 点击走容器事件代理（流式重建 DOM 不能直绑——tiny-worker 同款教训）
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

  const toolChip = (m: Extract<AgentMsg, { role: "tool" }>) => {
    switch (m.status) {
      case "pending": return <span className="tc-chip warn">待审批</span>;
      case "running": return <span className="tc-chip info"><IconLoader size={11} className="spin" /> 运行中</span>;
      case "ok": return <span className="tc-chip ok">完成 · exit {m.exit}</span>;
      case "denied": return <span className="tc-chip dim">已拒绝</span>;
    }
  };

  return (
    <>
      <aside className="agentbar" data-testid="agent-view" style={{ width }} aria-label="Agent 对话">
      <div className="ag-head">
        <IconBot size={15} />
        <b>Agent</b>
        {sid && <span className="ag-host" title="当前会话（对话按会话隔离）">{hostLabel}</span>}
        <span className="ag-mock" title="当前为演练外壳：回复与工具卡是脚本数据，真实模型接入在后续版本">演练</span>
        <span style={{ flex: 1 }} />
        {sid && (
          <button className="ghost icon-btn" title="新对话（清空当前会话的演练对话）" aria-label="新对话"
            data-testid="agent-new"
            onClick={() => setConvs((cur) => ({ ...cur, [key]: [{ id: `w-${key}-${Date.now()}`, role: "assistant", md: WELCOME_MD, streaming: false }] }))}>
            <IconPlus size={14} />
          </button>
        )}
        <button className="ghost icon-btn" title="关闭 Agent 视图" aria-label="关闭 Agent 视图" onClick={onClose}><IconX size={14} /></button>
      </div>
      {sid ? (
        <>
          <div className="ag-scroll" ref={scrollRef} onClick={onScrollClick}>
            {msgs.map((m) => {
              if (m.role === "user") {
                return <div className="msg-row user" key={m.id}><div className="bubble-user">{m.text}</div></div>;
              }
              if (m.role === "assistant") {
                return (
                  <div className="msg-row assistant" key={m.id}>
                    <div className="md-block" data-testid="agent-md" dangerouslySetInnerHTML={{ __html: renderAgentMd(m.md, m.streaming) }} />
                    {m.streaming && <span className="ag-cursor" aria-hidden="true" />}
                  </div>
                );
              }
              return (
                <div className={"tool-card tc-" + m.status} key={m.id} data-testid="agent-tool">
                  <div className="tc-head">
                    <span className="tc-tool mono">{m.tool}</span>
                    <span className="tc-args mono" title={m.argsLabel}>{m.argsLabel}</span>
                    {toolChip(m)}
                  </div>
                  {m.status === "ok" && m.output && <pre className="tc-out">{m.output}</pre>}
                  {m.status === "pending" && (
                    <div className="tc-actions">
                      <button className="primary" data-testid="agent-approve" onClick={approve}>批准执行</button>
                      <button className="ghost" data-testid="agent-deny" onClick={deny}>拒绝</button>
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
