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
import * as clipboard from "@tauri-apps/plugin-clipboard-manager";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";

type Host = {
  id: string; name: string; address: string; port: number; username: string;
  auth_type: "Key" | "Password" | "KeyboardInteractive";
};
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
type IdentityMeta = { id: string; label: string; kind: string; fingerprint: string };

const epistemicClass = (s: string) =>
  s === "Confirmed" ? "tag-confirmed" : s === "NeedsRecheck" ? "tag-needsrecheck" : "tag-unobservable";

// 会话状态 → 中文标签 + 颜色类
const stateLabel = (s: string): { text: string; cls: string } => {
  switch (s) {
    case "Connected": return { text: "已连接", cls: "ok" };
    case "Degraded": return { text: "连接中断", cls: "err" };
    case "Reconnecting": return { text: "重连中…", cls: "err" };
    case "Reconfirming": return { text: "重确认（受限）", cls: "err" };
    default: return { text: "已断开", cls: "dim" };
  }
};

// 后端错误 → 用户能看懂的一句话（原始错误放次要行）
const friendlyError = (raw: string): string => {
  const r = raw.toLowerCase();
  if (r.includes("authfailed") || r.includes("authentication")) return "认证失败：用户名或密码/密钥不正确";
  if (r.includes("refused")) return "连接被拒绝：端口不对，或主机上的 SSH 服务没有运行";
  if (r.includes("timeout") || r.includes("timed out") || r.includes("unreachable"))
    return "连接超时：主机不可达（地址错误、网络不通或防火墙拦截）";
  if (r.includes("dns") || r.includes("name or service") || r.includes("nodename"))
    return "地址无法解析：请检查主机名/IP 是否写对";
  if (r.includes("keychain") || r.includes("master")) return "凭据库解锁失败：" + raw;
  return raw;
};

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

// Ctrl+单字符 → 控制字符（C0 集合，与真实终端一致）
const ctrlCharOf = (key: string): string | null => {
  const c = key.toLowerCase().charCodeAt(0);
  if (c >= 97 && c <= 122) return String.fromCharCode(c - 96); // a-z → \x01-\x1a
  const map: Record<string, string> = {
    "[": "\x1b", "]": "\x1d", "\\": "\x1c", " ": "\x00", "@": "\x00",
    "?": "\x1f", "/": "\x1f", "2": "\x00", "3": "\x1b", "4": "\x1c",
    "5": "\x1d", "6": "\x1e", "7": "\x1f", "8": "\x7f",
  };
  return map[key] ?? null;
};

export default function App() {

  const termRef = useRef<HTMLDivElement>(null);
  const xtermRef = useRef<Terminal | null>(null);
  const sidRef = useRef<string | null>(null);          // onData 闭包用 ref，避免 stale state
  const subscribedRef = useRef<Set<string>>(new Set()); // 每会话只订阅一次，防重复输出
  const [sid, setSid] = useState<string | null>(null);
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [hosts, setHosts] = useState<Host[]>([]);
  const [approvals, setApprovals] = useState<ApprovalItem[]>([]);
  const [brief, setBrief] = useState<Brief | null>(null);
  const [timeline, setTimeline] = useState<AuditEvent[]>([]);
  const [owner, setOwner] = useState<"Human" | "Agent">("Agent");
  const [mcp, setMcp] = useState<{ endpoint: string; agents: { id: string; label: string }[] }>({ endpoint: "", agents: [] });
  const [input, setInput] = useState("");
  // 连接状态机：null=空闲；连接中显示主机名；失败显示错误
  const [connecting, setConnecting] = useState<string | null>(null);
  const [connError, setConnError] = useState<{ title: string; detail: string } | null>(null);
  const [showAddHost, setShowAddHost] = useState(false);

  const refreshLists = useCallback(async () => {
    setSessions(await invoke<SessionInfo[]>("list_sessions"));
    setHosts(await invoke<Host[]>("list_hosts"));
    setApprovals(await invoke<ApprovalItem[]>("list_approvals", { pendingOnly: false }));
    const page = await invoke<{ events: AuditEvent[] }>("audit_query", { sid: null, limit: 30 });
    setTimeline(page.events);
  }, []);

  const refreshBrief = useCallback(async (s: string) => {
    try { setBrief(await invoke<Brief>("session_brief", { sid: s })); } catch { /* 会话已关 */ }
  }, []);

  useEffect(() => {
    refreshLists();
    invoke<{ endpoint: string; agents: { id: string; label: string }[] }>("mcp_status").then(setMcp);
    invoke<boolean>("bench_mode").then((b) => {
      if (b) runBench();
    });
  }, [refreshLists]);

  // 列表轮询：会话状态（断线/重连/重确认）与审计时间线自动刷新
  useEffect(() => {
    const t = setInterval(() => {
      refreshLists();
      if (sidRef.current) refreshBrief(sidRef.current);
    }, 3000);
    return () => clearInterval(t);
  }, [refreshLists, refreshBrief]);

  // 审批事件推送（仅 Tauri 环境；纯浏览器 demo 模式无事件通道）
  useEffect(() => {
    if (!inTauri) return;
    let un: (() => void) | undefined;
    listen("approval-event", () => refreshLists()).then((f) => (un = f));
    return () => un?.();
  }, [refreshLists]);

  const writeWelcome = useCallback((t: Terminal) => {
    t.reset();
    t.writeln("TinySSH — 人机协同 SSH 工作台");
    t.writeln("");
    t.writeln("  1. 左侧「添加主机」填入地址和密码（或粘贴私钥），保存后自动连接；");
    t.writeln("  2. 连接后点击黑色终端区域直接打字：Ctrl+C 中断程序、↑↓ 翻历史、Tab 补全；");
    t.writeln("  3. ⌘C/⌘V 复制粘贴；下方命令框可逐条执行，执行后焦点自动回到终端。");
    t.writeln("");
  }, []);

  // xterm 初始化：仅一次。onData 一律走 sidRef，杜绝 stale closure。
  useEffect(() => {
    if (!termRef.current || xtermRef.current) return;
    const term = new Terminal({ fontSize: 13, cursorBlink: true, scrollback: 5000, theme: { background: "#10141a" } });
    term.open(termRef.current);
    writeWelcome(term);
    // 键盘保真：Ctrl+C/D/L、方向键、Esc、Tab、F 键全部原样进 PTY；
    // 只拦 macOS ⌘ 组合（剪贴板/防误触），不干扰任何控制键。
    term.attachCustomKeyEventHandler((ev) => {
      if (ev.type !== "keydown") return true;
      if (!ev.metaKey) return true;
      const key = ev.key.toLowerCase();
      if (key === "c") {
        if (term.hasSelection()) {
          const sel = term.getSelection();
          // Tauri 原生剪贴板（无 WKWebView 授权气泡）；浏览器 demo 走 navigator
          (inTauri ? clipboard.writeText(sel) : navigator.clipboard?.writeText(sel))
            .catch(() => {});
          ev.preventDefault();
          return false;
        }
        return true; // 无选中 → xterm 原生 copy 事件
      }
      if (key === "v") {
        (inTauri
          ? clipboard.readText().then((t) => {
              if (t && sidRef.current) term.paste(t);
            })
          : navigator.clipboard?.readText().then((t) => {
              if (t && sidRef.current) term.paste(t);
            })
        ).catch(() => {});
        ev.preventDefault();
        return false;
      }
      if (key === "a") {
        term.selectAll();
        ev.preventDefault();
        return false;
      }
      // 其余 ⌘ 快捷键（⌘R 刷新等）不得进入终端
      ev.preventDefault();
      ev.stopPropagation();
      return false;
    });
    term.onData((d) => {
      const s = sidRef.current;
      if (!s) return;
      invoke("send_keys", { sid: s, keys: d }).catch((e) => {
        term.write(`\r\n\x1b[31m✕ ${String(e)}\x1b[0m\r\n`);
      });
    });
    // 终端区域（含内容下方空白）点击即聚焦，保证打字与控制键直达会话
    const wrap = termRef.current.parentElement;
    wrap?.addEventListener("click", () => term.focus());
    xtermRef.current = term;
  }, [writeWelcome]);

    // 窗口级 Ctrl+字符 接管（捕获阶段）：中文输入法在 WKWebView 的 textarea 里
    // 会吞掉 Ctrl+字母（进入拼音组合，keydown 以 229 告终），xterm 收不到控制键——
    // top/vim 因此停不下来。这里在捕获阶段自行编码控制字符直发后端，绕过 IME。
    // 命令框等真实输入控件不劫持（保留其编辑语义）；方向键/F 键等长键值交给 xterm。
    useEffect(() => {
      const onKey = (ev: KeyboardEvent) => {
        if (!ev.ctrlKey || ev.metaKey || ev.altKey) return;
        const t = ev.target as HTMLElement | null;
        if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA") &&
            !t.classList.contains("xterm-helper-textarea")) return;
        const s = sidRef.current;
        if (!s) return;
        // IME 组合期间 key 可能是 "Process"/keyCode 229 —— 用物理键位 ev.code 解码
        let key: string | null = null;
        if (ev.key.length === 1) key = ev.key;
        else if (ev.code?.startsWith("Key")) key = ev.code.slice(3).toLowerCase();
        else if (ev.code === "BracketLeft") key = "[";
        else if (ev.code === "BracketRight") key = "]";
        else if (ev.code === "Backslash") key = "\\";
        else if (ev.code === "Space") key = " ";
        if (!key) return;
        const cc = ctrlCharOf(key);
        if (cc === null) return;
        ev.preventDefault();
        ev.stopPropagation();
        void invoke("send_keys", { sid: s, keys: cc }).catch(() => {});
      };
      window.addEventListener("keydown", onKey, { capture: true });
      return () => window.removeEventListener("keydown", onKey, { capture: true });
    }, []);

    // 终端聚焦状态上报 native 层：native Ctrl 键接管只在 xterm 聚焦时生效，
    // 命令框等输入控件不受影响。
    useEffect(() => {
      const report = (focused: boolean) => {
        void invoke("note_terminal", { sid: sidRef.current, focused }).catch(() => {});
      };
      const onFocusIn = (e: FocusEvent) => {
        const t = e.target as HTMLElement | null;
        if (t?.classList?.contains("xterm-helper-textarea")) report(true);
      };
      const onFocusOut = (e: FocusEvent) => {
        const t = e.target as HTMLElement | null;
        if (t?.classList?.contains("xterm-helper-textarea")) report(false);
      };
      document.addEventListener("focusin", onFocusIn);
      document.addEventListener("focusout", onFocusOut);
      return () => {
        document.removeEventListener("focusin", onFocusIn);
        document.removeEventListener("focusout", onFocusOut);
      };
    }, []);

  // 终端尺寸自适应 + PTY 对齐（backend resize）
  const fitTerminal = useCallback(async () => {
    const term = xtermRef.current;
    if (!term || !termRef.current) return;
    const box = termRef.current.parentElement;
    if (!box) return;
    const dims = (term as unknown as { dimensions?: { css?: { cell?: { width?: number; height?: number } } } }).dimensions;
    const cw = dims?.css?.cell?.width ?? 9;
    const ch = dims?.css?.cell?.height ?? 16;
    const cols = Math.max(20, Math.min(400, Math.floor(box.clientWidth / cw)));
    const rows = Math.max(6, Math.min(200, Math.floor(box.clientHeight / ch)));
    if (term.cols !== cols || term.rows !== rows) {
      term.resize(cols, rows);
      const s = sidRef.current;
      if (s) invoke("resize", { sid: s, cols, rows }).catch(() => {});
    }
  }, []);
  useEffect(() => {
    const el = termRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const ro = new ResizeObserver(() => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => fitTerminal(), 150);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [fitTerminal]);

  const attachSession = useCallback(async (newSid: string) => {
    const term = xtermRef.current;
    if (!term) return;
    if (!subscribedRef.current.has(newSid)) {
      // 输出字节 → 字符串（有状态解码，处理 UTF-8 跨块分割）。
      // 不走 term.write(Uint8Array)：实测该二进制写路径在 WKWebView 下静默不渲染。
      const decoder = new TextDecoder();
      const channel = MkChannel() as { onmessage?: (msg: unknown) => void };
      channel.onmessage = (msg) => {
        if (msg instanceof ArrayBuffer || msg instanceof Uint8Array) {
          const u8 = msg instanceof Uint8Array ? msg : new Uint8Array(msg);
          term.write(decoder.decode(u8, { stream: true }));
        } else if (typeof msg === "string" && msg.includes("resync")) {
          invoke<{ text: string }>("read_screen", { sid: newSid }).then((snap) => {
            term.reset();
            term.write(snap.text);
          });
        }
      };
      await invoke("subscribe_output", { sid: newSid, onEvent: channel });
      subscribedRef.current.add(newSid);
    }
    const snap = await invoke<{ text: string }>("read_screen", { sid: newSid });
    term.reset();
    term.write(snap.text);
    term.write("\r\n\x1b[90m── 会话已接管到终端：点击此区域直接打字，或用下方命令框 ──\x1b[0m\r\n");
    setSid(newSid);
    sidRef.current = newSid;
    term.focus();
    void invoke("note_terminal", { sid: newSid, focused: true }).catch(() => {});
    fitTerminal();
    refreshBrief(newSid);
  }, [fitTerminal, refreshBrief]);

  const detach = useCallback(() => {
    setSid(null);
    sidRef.current = null;
    setBrief(null);
    void invoke("note_terminal", { sid: null, focused: false }).catch(() => {});
    if (xtermRef.current) writeWelcome(xtermRef.current);
  }, [writeWelcome]);

  const createSession = async (host: Host) => {
    setConnecting(host.name);
    setConnError(null);
    try {
      const newSid = await invoke<string>("create_session", { hostId: host.id });
      await refreshLists();
      await attachSession(newSid);
    } catch (e) {
      setConnError({
        title: `连接 ${host.name}（${host.username}@${host.address}:${host.port}）失败`,
        detail: friendlyError(String(e)),
      });
    } finally {
      setConnecting(null);
    }
  };

  const disconnect = async (s: SessionInfo) => {
    try {
      await invoke("close_session", { sid: s.id });
    } catch (e) {
      setConnError({ title: `断开 ${s.host_name} 失败`, detail: String(e) });
    }
    subscribedRef.current.delete(s.id);
    if (sidRef.current === s.id) detach();
    refreshLists();
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

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editedCmd, setEditedCmd] = useState("");
  const decide = async (id: string, decision: string, edited: string | null) => {
    await invoke("decide_approval", { id, decision, edited });
    setEditingId(null);
    await refreshLists();
  };

  // 控制权徽标
  useEffect(() => {
    const s = sessions.find((x) => x.id === sid);
    if (s) setOwner(s.control_owner);
  }, [sessions, sid]);

  const hasAgents = mcp.agents.length > 0;
  const current = sessions.find((x) => x.id === sid);
  const ownerBadge = owner === "Human" ? "人类控制" : hasAgents ? "Agent" : "手动";
  const ownerCls = owner === "Human" ? "human" : hasAgents ? "agent" : "dim";
  const pendingCount = approvals.filter((a) => a.status === "pending").length;

  return (
    <div className="layout">
      {/* 左：主机与会话 */}
      <div className="col">
        <div className="panel-title row">
          <span>主机 / 会话</span>
          <span style={{ flex: 1 }} />
          <button className="ghost" onClick={() => setShowAddHost(!showAddHost)}>
            {showAddHost ? "收起" : "＋ 添加主机"}
          </button>
        </div>
        <div className="scroll">
          {showAddHost && (
            <AddHostForm
              onAdded={async (hid) => {
                setShowAddHost(false);
                await refreshLists();
                const h = hosts.find((x) => x.id === hid);
                // list_hosts 刚刷新过，直接用返回值兜底
                const target = h ?? (await invoke<Host[]>("list_hosts")).find((x) => x.id === hid);
                if (target) createSession(target);
              }}
            />
          )}
          <div className="section">
            <h4>主机</h4>
            {hosts.map((h) => (
              <div className="card row" key={h.id}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div>{h.name} <span className="dim">{h.auth_type === "Key" ? "· 密钥" : "· 密码"}</span></div>
                  <div className="dim mono">{h.username}@{h.address}:{h.port}</div>
                </div>
                <button disabled={connecting !== null} onClick={() => createSession(h)}>
                  {connecting === h.name ? "连接中…" : "连接"}
                </button>
              </div>
            ))}
            {hosts.length === 0 && (
              <div className="dim">还没有主机。点上方「＋ 添加主机」填入地址和密码即可连接。</div>
            )}
          </div>
          <div className="section">
            <h4>会话</h4>
            {sessions.map((s) => {
              const st = stateLabel(s.state);
              return (
                <div className="card row" key={s.id}>
                  <div style={{ flex: 1, cursor: "pointer", minWidth: 0 }} onClick={() => attachSession(s.id)}>
                    <div>{s.host_name} <span className={"mono " + st.cls}>· {st.text}</span></div>
                    <div className="dim mono">{s.id.slice(0, 12)}</div>
                  </div>
                  <button className="ghost" onClick={() => disconnect(s)}>断开</button>
                </div>
              );
            })}
            {sessions.length === 0 && (
              <div className="dim">暂无会话。点主机右侧的「连接」建立会话。</div>
            )}
          </div>
          <div className="section">
            <h4>Agent 接入（MCP）</h4>
            {hasAgents ? (
              mcp.agents.map((a) => (
                <div className="fact" key={a.id}>
                  <span className="s">{a.label}</span> <span className="dim mono">{a.id}</span>
                </div>
              ))
            ) : (
              <div className="dim">暂无 Agent 接入。运行 <code>tinyssh serve</code> 并为 Agent 签发 Token 后，它的操作请求会出现在右侧审批队列。</div>
            )}
          </div>
        </div>
      </div>

      {/* 中：终端 */}
      <div className="col">
        <div className="panel-title row">
          <span>
            终端
            {current && (
              <span className="dim mono"> {current.host_name} · {sid!.slice(0, 12)} · </span>
            )}
            {current && <span className={stateLabel(current.state).cls}>{stateLabel(current.state).text}</span>}
          </span>
          <span style={{ flex: 1 }} />
          {sid && (
            <span className={"badge " + ownerCls}>控制权：{ownerBadge}</span>
          )}
          {sid && hasAgents && owner === "Agent" && (
            <>
              <button className="warn" onClick={takeover}>接管</button>
              <button className="danger" onClick={takeoverStop}>接管并停止任务</button>
            </>
          )}
          {sid && hasAgents && owner === "Human" && (
            <button onClick={handback}>交还 Agent</button>
          )}
        </div>
        {connError && (
          <div className="conn-error">
            <div>
              <b>✕ {connError.title}</b>
              <div className="dim">{connError.detail}</div>
            </div>
            <button className="ghost" onClick={() => setConnError(null)}>关闭</button>
          </div>
        )}
        <div className="term-wrap">
          <div id="term" ref={termRef} />
        </div>
        <div className="panel-title row">
          <input
            placeholder={
              current
                ? `在 ${current.host_name} 上执行命令——回车执行，Ctrl+C 中断终端里的前台程序`
                : "先在左侧连接一台主机，这里才能执行命令"
            }
            disabled={!sid}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={async (e) => {
              if (e.key.toLowerCase() === "c" && e.ctrlKey) {
                e.preventDefault();
                if (!input) {
                  // 空输入的 Ctrl+C = 中断终端里的前台程序（top/vim…），并回到终端
                  const s = sidRef.current;
                  if (s) await invoke("send_keys", { sid: s, keys: "\u0003" }).catch(() => {});
                  xtermRef.current?.focus();
                } else {
                  setInput("");
                }
                return;
              }
              if (e.key === "Enter" && input.trim() && sid) {
                const cmd = input;
                setInput("");
                xtermRef.current?.write(`\r\n\x1b[90m❯ ${cmd}\x1b[0m\r\n`);
                // 立即回焦终端（不等待执行完成：长驻命令 top/vim 也即时可中断）
                xtermRef.current?.focus();
                try {
                  await invoke("exec_human", { sid, command: cmd });
                } catch (err) {
                  xtermRef.current?.write(`\r\n\x1b[31m✕ ${String(err)}\x1b[0m\r\n`);
                }
              }
            }}
          />
          {sid && (
            <button
              className="ghost"
              title="向前台进程发送 SIGINT（等同 Ctrl+C），不依赖输入法状态"
              onClick={() => {
                const s = sidRef.current;
                if (s) void invoke("send_keys", { sid: s, keys: "\u0003" }).catch(() => {});
                xtermRef.current?.focus();
              }}
            >
              ⏹ 中断
            </button>
          )}
        </div>
      </div>

      {/* 右：审批 / 简报 / 时间线 */}
      <div className="col">
        <div className="panel-title">审批队列（{pendingCount} 待处理）</div>
        <div className="scroll">
          {approvals.map((a) => (
            <div className="card" key={a.id}>
              <div className="row">
                <span className="badge">{a.agent_id}</span>
                <span className="badge">{a.status === "pending" ? "待审批" : a.status === "approved" ? "已批准" : "已拒绝"}</span>
              </div>
              <div className="cmd" style={{ margin: "6px 0" }}>{a.command}</div>
              {a.segment_report.map((s, i) => (
                <div key={i} className="dim" style={{ fontSize: 11 }}>
                  · {s.segment} — {s.verdict}
                </div>
              ))}
              {a.status === "pending" && (
                editingId === a.id ? (
                  <div style={{ marginTop: 8 }}>
                    <textarea value={editedCmd} onChange={(e) => setEditedCmd(e.target.value)} rows={3} style={{ width: "100%" }} />
                    <div className="row" style={{ marginTop: 6 }}>
                      <button onClick={() => decide(a.id, "edit", editedCmd)} disabled={!editedCmd.trim() || editedCmd === a.command}>保存并批准</button>
                      <button className="ghost" onClick={() => setEditingId(null)}>取消</button>
                    </div>
                    <div className="dim" style={{ fontSize: 11, marginTop: 4 }}>改后批准会记录为人工编辑（审计留痕）。</div>
                  </div>
                ) : (
                  <div className="row" style={{ marginTop: 8 }}>
                    <button onClick={() => decide(a.id, "approve", null)}>批准</button>
                    <button className="ghost" onClick={() => { setEditingId(a.id); setEditedCmd(a.command); }}>编辑后批准</button>
                    <button className="danger" onClick={() => decide(a.id, "deny", null)}>拒绝</button>
                  </div>
                )
              )}
            </div>
          ))}
          {approvals.length === 0 && (
            <div className="dim">队列为空。Agent 通过 MCP 发起操作时，需要你审批的请求会出现在这里。</div>
          )}

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
                <div className="dim mono" style={{ fontSize: 10, marginTop: 4 }}>屏尾: {brief.screen_summary || "(空)"}</div>
              </div>
            ) : (
              <div className="dim">无会话。连接主机后这里显示当前目录、核实过的事实与运行中的任务。</div>
            )}
          </div>

          <div className="section">
            <h4>操作时间线（审计）</h4>
            {timeline.map((ev) => (
              <div className="fact" key={ev.seq}>
                <span className="dim mono">#{ev.seq} {ev.action}</span>{" "}
                <span className={ev.actor_kind === "agent" ? "" : "ok"}>
                  {ev.actor_kind === "human" ? "人类" : "Agent"}{ev.agent_id ? `:${ev.agent_id}` : ""}
                </span>
                {ev.command && <div className="mono dim">{ev.command}</div>}
              </div>
            ))}
            {timeline.length === 0 && <div className="dim">暂无记录。所有连接与命令都会留痕在这里。</div>}
          </div>
        </div>
      </div>
    </div>
  );
}

// 添加主机表单：密码直存；私钥先建身份再引用（vault 侧统一加密）
function AddHostForm({ onAdded }: { onAdded: (hostId: string) => void }) {
  const [name, setName] = useState("");
  const [address, setAddress] = useState("");
  const [port, setPort] = useState("22");
  const [username, setUsername] = useState("root");
  const [authMode, setAuthMode] = useState<"password" | "key">("password");
  const [password, setPassword] = useState("");
  const [pem, setPem] = useState("");
  const [passphrase, setPassphrase] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const submit = async () => {
    setErr(null);
    if (!name.trim() || !address.trim() || !username.trim()) {
      setErr("名称、地址、用户名都不能为空");
      return;
    }
    const p = parseInt(port, 10);
    if (!Number.isInteger(p) || p <= 0 || p > 65535) {
      setErr("端口必须是 1–65535 的数字");
      return;
    }
    setBusy(true);
    try {
      let auth: Record<string, unknown>;
      if (authMode === "password") {
        if (!password) { setErr("请输入密码"); setBusy(false); return; }
        auth = { Password: { password } };
      } else {
        if (!pem.includes("PRIVATE KEY")) { setErr("请粘贴 OpenSSH / PEM 格式的私钥内容"); setBusy(false); return; }
        const meta = await invoke<IdentityMeta>("create_identity", {
          req: { Import: { label: name.trim(), pem, passphrase: passphrase || null } },
        });
        auth = { Key: { identity_id: meta.id } };
      }
      const hid = await invoke<string>("upsert_host", {
        host: {
          id: null, name: name.trim(), address: address.trim(),
          port: p, username: username.trim(), auth, tags: [],
        },
      });
      setName(""); setAddress(""); setPort("22"); setPassword(""); setPem(""); setPassphrase("");
      onAdded(hid);
    } catch (e) {
      setErr(friendlyError(String(e)));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card add-host">
      <div className="row">
        <input placeholder="名称（如：我的服务器）" value={name} onChange={(e) => setName(e.target.value)} />
        <input placeholder="地址（IP 或域名）" value={address} onChange={(e) => setAddress(e.target.value)} style={{ flex: 2 }} />
        <input placeholder="端口" value={port} onChange={(e) => setPort(e.target.value)} style={{ flex: 1, minWidth: 64 }} />
      </div>
      <div className="row" style={{ marginTop: 6 }}>
        <input placeholder="用户名" value={username} onChange={(e) => setUsername(e.target.value)} />
        <select value={authMode} onChange={(e) => setAuthMode(e.target.value as "password" | "key")}>
          <option value="password">密码登录</option>
          <option value="key">私钥登录</option>
        </select>
      </div>
      {authMode === "password" ? (
        <input type="password" placeholder="密码" value={password} onChange={(e) => setPassword(e.target.value)}
          style={{ marginTop: 6 }} onKeyDown={(e) => e.key === "Enter" && submit()} />
      ) : (
        <>
          <textarea placeholder={"-----BEGIN OPENSSH PRIVATE KEY-----\n粘贴私钥内容…"} value={pem}
            onChange={(e) => setPem(e.target.value)} rows={4} style={{ marginTop: 6, width: "100%" }} />
          <input type="password" placeholder="私钥口令（无可留空）" value={passphrase}
            onChange={(e) => setPassphrase(e.target.value)} style={{ marginTop: 6 }} />
        </>
      )}
      {err && <div className="err" style={{ marginTop: 6 }}>✕ {err}</div>}
      <div className="row" style={{ marginTop: 8 }}>
        <button disabled={busy} onClick={submit}>{busy ? "保存中…" : "保存并连接"}</button>
        <span className="dim">凭据加密存入本机凭据库，不会明文落盘。</span>
      </div>
    </div>
  );
}
