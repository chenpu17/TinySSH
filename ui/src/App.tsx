import { useCallback, useEffect, useRef, useState } from "react";
import * as tauri from "@tauri-apps/api/core";
import * as demo from "./demo";

// 无 Tauri 环境（纯浏览器）走演示模式；Tauri 环境走真实核心
const inTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
const invoke: typeof tauri.invoke = (cmd, args?) =>
  inTauri
    ? tauri.invoke(cmd, args)
    : (demo.invoke(cmd, args as Record<string, unknown> | undefined) as never);
// Channel：Tauri 环境用真实现；浏览器演示模式用 shim
const MkChannel = () => (inTauri ? new tauri.Channel<unknown>() : new demo.ChannelShim());
import { listen } from "@tauri-apps/api/event";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";

type Host = { id: string; name: string; address: string; port: number; username: string };
type SessionInfo = {
  id: string; host_name: string; kind: string;
  state: string; control_owner: "Human" | "Agent";
};
type ApprovalItem = {
  id: string; session_id: string; agent_id: string; command: string;
  status: string; segment_report: { segment: string; verdict: string }[];
};
type Brief = {
  cwd: string | null; env_summary: string;
  facts: { subject: string; detail: string; status: string }[];
  running: string[]; pending_approvals: string[]; screen_summary: string;
};
type AuditEvent = {
  seq: number; ts: string; actor_kind: string; agent_id: string | null;
  action: string; command: string | null;
};

const epistemicClass = (s: string) =>
  s === "Confirmed" ? "tag-confirmed" : s === "NeedsRecheck" ? "tag-needsrecheck" : "tag-unobservable";

let benchStarted = false;
async function runBench() {
  if (benchStarted) return;
  benchStarted = true;
  const started = performance.now();
  let bytes = 0;
  let resyncs = 0;
  const channel = MkChannel() as { onmessage?: (msg: unknown) => void };
  channel.onmessage = (msg) => {
    if (msg instanceof ArrayBuffer || msg instanceof Uint8Array) {
      bytes += (msg as Uint8Array).byteLength;
      return;
    }
    let obj: Record<string, unknown> | null = null;
    if (typeof msg === "string") {
      try { obj = JSON.parse(msg); } catch { return; }
    } else if (typeof msg === "object" && msg !== null) {
      obj = msg as Record<string, unknown>;
    }
    if (!obj) return;
    if (obj.type === "resync") {
      resyncs += 1;
      invoke("read_screen", { sid: "bench" }).catch(() => {});
    } else if (obj.type === "done") {
      const seconds = Math.round((performance.now() - started) / 1000);
      invoke("bench_report", { bytes, resyncs, seconds });
    }
  };
  await invoke("bench_start", { onChunk: channel });
}

export default function App() {

  const termRef = useRef<HTMLDivElement>(null);
  const xtermRef = useRef<Terminal | null>(null);
  const [sid, setSid] = useState<string | null>(null);
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [hosts, setHosts] = useState<Host[]>([]);
  const [approvals, setApprovals] = useState<ApprovalItem[]>([]);
  const [brief, setBrief] = useState<Brief | null>(null);
  const [timeline, setTimeline] = useState<AuditEvent[]>([]);
  const [owner, setOwner] = useState<"Human" | "Agent">("Agent");
  const [input, setInput] = useState("");
  const [mcp, setMcp] = useState<string>("");

  const refreshLists = useCallback(async () => {
    setSessions(await invoke<SessionInfo[]>("list_sessions"));
    setHosts(await invoke<Host[]>("list_hosts"));
    setApprovals(await invoke<ApprovalItem[]>("list_approvals", { pendingOnly: false }));
    const page = await invoke<{ events: AuditEvent[] }>("audit_query", { sid: null, limit: 30 });
    setTimeline(page.events);
  }, []);

  useEffect(() => {
    refreshLists();
    invoke<{ endpoint: string }>("mcp_status").then((s) => setMcp(s.endpoint));
    invoke<boolean>("bench_mode").then((b) => {
      if (b) runBench();
    });
  }, [refreshLists]);

  // 审批事件推送
  useEffect(() => {
    let un: (() => void) | undefined;
    listen("approval-event", () => refreshLists()).then((f) => (un = f));
    return () => un?.();
  }, [refreshLists]);

  // xterm 初始化
  useEffect(() => {
    if (!termRef.current || xtermRef.current) return;
    const term = new Terminal({ fontSize: 13, rows: 30, cursorBlink: true, theme: { background: "#10141a" } });
    term.open(termRef.current);
    term.writeln("TinySSH — 人机协同 SSH（V0 thin-slice）");
    term.writeln("左侧选择主机建立会话；Agent 动作出现在审批面板；接管按钮随时冻结 Agent。");
    term.onData((d) => {
      if (sid) invoke("send_keys", { sid, keys: d }).catch(() => {});
    });
    xtermRef.current = term;
  }, [sid]);

  const attachSession = useCallback(async (newSid: string) => {
    const channel = MkChannel() as { onmessage?: (msg: unknown) => void };
    channel.onmessage = (msg) => {
      const t = xtermRef.current;
      if (!t) return;
      if (msg instanceof ArrayBuffer || msg instanceof Uint8Array) {
        t.write(msg as Uint8Array);
      } else if (typeof msg === "string" && msg.includes("resync")) {
        invoke<{ text: string }>("read_screen", { sid: newSid }).then((snap) => {
          t.reset();
          t.write(snap.text);
        });
      }
    };
    await invoke("subscribe_output", { sid: newSid, onEvent: channel });
    const snap = await invoke<{ text: string }>("read_screen", { sid: newSid });
    xtermRef.current?.reset();
    xtermRef.current?.write(snap.text);
    setSid(newSid);
    const b = await invoke<Brief>("session_brief", { sid: newSid });
    setBrief(b);
  }, []);

  const createSession = async (hostId: string) => {
    const newSid = await invoke<string>("create_session", { hostId });
    await refreshLists();
    await attachSession(newSid);
  };

  const takeover = async () => {
    if (!sid) return;
    await invoke("set_control", { sid, owner: "Human", stopRunning: false });
    await refreshLists();
  };
  const takeoverStop = async () => {
    if (!sid) return;
    await invoke("set_control", { sid, owner: "Human", stopRunning: true });
    await refreshLists();
  };
  const handback = async () => {
    if (!sid) return;
    await invoke("set_control", { sid, owner: "Agent" });
    await refreshLists();
  };

  const decide = async (id: string, decision: string) => {
    await invoke("decide_approval", { id, decision, edited: null });
    await refreshLists();
  };

  // 控制权徽标
  useEffect(() => {
    const s = sessions.find((x) => x.id === sid);
    if (s) setOwner(s.control_owner);
  }, [sessions, sid]);

  return (
    <div className="layout">
      {/* 左：主机与会话 */}
      <div className="col">
        <div className="panel-title">主机 / 会话</div>
        <div className="scroll">
          <div className="section">
            <h4>主机</h4>
            {hosts.map((h) => (
              <div className="card row" key={h.id}>
                <div style={{ flex: 1 }}>
                  <div>{h.name}</div>
                  <div className="dim">{h.username}@{h.address}</div>
                </div>
                <button onClick={() => createSession(h.id)}>连接</button>
              </div>
            ))}
          </div>
          <div className="section">
            <h4>会话</h4>
            {sessions.map((s) => (
              <div className="card row" key={s.id}>
                <div style={{ flex: 1, cursor: "pointer" }} onClick={() => attachSession(s.id)}>
                  <div>{s.host_name}</div>
                  <div className="dim mono">{s.id.slice(0, 12)}</div>
                </div>
                <span className={"badge " + (s.control_owner === "Human" ? "human" : "agent")}>
                  {s.control_owner === "Human" ? "人类控制" : "Agent"}
                </span>
              </div>
            ))}
            {sessions.length === 0 && <div className="dim">暂无会话</div>}
          </div>
          <div className="section">
            <h4>MCP 端点</h4>
            <div className="dim mono">{mcp}</div>
          </div>
        </div>
      </div>

      {/* 中：终端 */}
      <div className="col">
        <div className="panel-title row">
          <span>终端 {sid && <span className="mono dim">{sid.slice(0, 12)}</span>}</span>
          <span style={{ flex: 1 }} />
          <span className={"badge " + (owner === "Human" ? "human" : "agent")}>
            控制权：{owner === "Human" ? "人类" : "Agent"}
          </span>
          {owner === "Agent" ? (
            <>
              <button className="warn" onClick={takeover}>接管</button>
              <button className="danger" onClick={takeoverStop}>接管并停止任务</button>
            </>
          ) : (
            <button onClick={handback}>交还 Agent</button>
          )}
        </div>
        <div className="term-wrap">
          <div id="term" ref={termRef} />
        </div>
        <div className="panel-title row">
          <input
            placeholder="本地命令（人类身份，短路审批）——回车执行"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={async (e) => {
              if (e.key === "Enter" && input.trim() && sid) {
                const cmd = input;
                setInput("");
                try {
                  await invoke("exec_human", { sid, command: cmd });
                  xtermRef.current?.write("\r\n");
                } catch (err) {
                  xtermRef.current?.write(`\r\n\x1b[31m${err}\x1b[0m\r\n`);
                }
              }
            }}
          />
        </div>
      </div>

      {/* 右：审批 / 简报 / 时间线 */}
      <div className="col">
        <div className="panel-title">审批队列（{approvals.filter((a) => a.status === "pending").length} 待处理）</div>
        <div className="scroll">
          {approvals.map((a) => (
            <div className="card" key={a.id}>
              <div className="row">
                <span className="badge">{a.agent_id}</span>
                <span className="badge">{a.status}</span>
              </div>
              <div className="cmd" style={{ margin: "6px 0" }}>{a.command}</div>
              {a.segment_report.map((s, i) => (
                <div key={i} className="dim" style={{ fontSize: 11 }}>
                  · {s.segment} — {s.verdict}
                </div>
              ))}
              {a.status === "pending" && (
                <div className="row" style={{ marginTop: 8 }}>
                  <button onClick={() => decide(a.id, "approve")}>批准</button>
                  <button className="danger" onClick={() => decide(a.id, "deny")}>拒绝</button>
                </div>
              )}
            </div>
          ))}
          {approvals.length === 0 && <div className="dim">队列为空</div>}

          <div className="section">
            <h4>现场简报</h4>
            {brief ? (
              <div className="card">
                {brief.facts.map((f, i) => (
                  <div className="fact" key={i}>
                    <span className="s">{f.subject}</span>{" "}
                    <span className={"tag " + epistemicClass(f.status)}>[{f.status}]</span>
                    <div>{f.detail}</div>
                  </div>
                ))}
                {brief.running.length > 0 && (
                  <div className="err">运行中：{brief.running.join(", ")}</div>
                )}
              </div>
            ) : (
              <div className="dim">无会话</div>
            )}
          </div>

          <div className="section">
            <h4>操作时间线（审计）</h4>
            {timeline.map((ev) => (
              <div className="fact" key={ev.seq}>
                <span className="dim mono">#{ev.seq} {ev.action}</span>{" "}
                <span className={ev.actor_kind === "agent" ? "" : "ok"}>
                  {ev.actor_kind}{ev.agent_id ? `:${ev.agent_id}` : ""}
                </span>
                {ev.command && <div className="mono dim">{ev.command}</div>}
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
