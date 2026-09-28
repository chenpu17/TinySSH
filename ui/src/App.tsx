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

// 认知状态 → 用户能看懂的标签
const epistemicLabel = (s: string) =>
  s === "Confirmed" ? "已核实" : s === "NeedsRecheck" ? "需复核" : "未观测";

// 退出码 → 人话
const exitText = (code: string): string =>
  code === "0" ? "成功" : code === "130" ? "Ctrl+C 中断" : code === "未知" ? "已结束（退出码未知）" : `退出码 ${code}`;

// 审计动作 → 中文描述（未知动作原样显示）
const auditLabel = (a: string): string =>
  ({
    session_created: "连接主机",
    session_closed: "断开会话",
    session_reconnect: "重连会话",
    host_upsert: "保存主机",
    host_delete: "删除主机",
    identity_create: "添加凭据",
    identity_delete: "删除凭据",
    exec: "执行命令",
    exec_cancel: "中断命令",
    exec_denied: "拦截危险命令",
    send_keys: "发送按键",
    approval_requested: "请求审批",
    approval_decision: "审批决定",
    approval_denied: "拒绝审批",
    takeover: "接管会话",
    handback: "交还会话",
    transfer_done: "任务完成",
    transfer_voided: "任务作废",
    transfer_failed: "任务失败",
  })[a] ?? a;

// 内部管道事件不进用户时间线（集成注入是建会话的固定噪音）
const HIDDEN_AUDIT_ACTIONS = new Set(["shell_integration_inject"]);

// 审计时间戳 → HH:MM
const hhmm = (ts: string): string => {
  const d = new Date(ts);
  return isNaN(d.getTime()) ? "" : d.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
};

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
  // 每会话一个独立 xterm 实例：切换会话 = 显示/隐藏，滚动历史与 vim 全屏状态原地保留
  const termsRef = useRef<Map<string, { term: Terminal; el: HTMLDivElement }>>(new Map());
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
    // 多取一些：集成注入等内部事件会被前端过滤，保证可见条数够看
    const page = await invoke<{ events: AuditEvent[] }>("audit_query", { sid: null, limit: 60 });
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
      // 终端尺寸对账：docker ps 等按 PTY 宽度排版，PTY 与 xterm 失配时表格折行错乱。
      // xterm（用户所见）为权威单向校正后端——任何一环丢掉的 resize 在 3s 内自动收敛。
      const term = xtermRef.current;
      const s = sidRef.current;
      if (term && s) {
        invoke<{ cols: number; rows: number }>("read_screen", { sid: s })
          .then((snap) => {
            if (snap.cols !== term.cols || snap.rows !== term.rows) {
              void invoke("resize", { sid: s, cols: term.cols, rows: term.rows }).catch(() => {});
            }
          })
          .catch(() => {});
      }
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

  // 终端实例工厂：每个会话一个独立 xterm。
  const makeTerm = useCallback((sessionSid: string) => {
    const mount = termRef.current;
    if (!mount) return null;
    const el = document.createElement("div");
    el.className = "term-session";
    mount.appendChild(el);
    const term = new Terminal({ fontSize: 13, cursorBlink: true, scrollback: 5000, theme: { background: "#10141a" } });
    term.open(el);
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
              if (t) term.paste(t);
            })
          : navigator.clipboard?.readText().then((t) => {
              if (t) term.paste(t);
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
    // onData 直接归属本会话：终端实例与会话一一对应，无 stale closure。
    term.onData((d) => {
      invoke("send_keys", { sid: sessionSid, keys: d }).catch((e) => {
        term.write(`\r\n\x1b[31m✕ ${String(e)}\x1b[0m\r\n`);
      });
    });
    return { term, el };
  }, []);

  // 终端区域（含内容下方空白）点击即聚焦当前会话终端
  useEffect(() => {
    const wrap = termRef.current?.parentElement;
    if (!wrap) return;
    const onFocus = () => xtermRef.current?.focus();
    wrap.addEventListener("click", onFocus);
    return () => wrap.removeEventListener("click", onFocus);
  }, []);

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
    const cw = dims?.css?.cell?.width;
    const ch = dims?.css?.cell?.height;
    if (!cw || !ch) {
      // 渲染器首帧未就绪：9px 兜底会把列数算错（PTY 宽度随之错位，
      // docker ps 等按宽度排版的输出会折行错乱）——等一帧重测，最多 5 次
      const t = term as unknown as { __fitRetries?: number };
      t.__fitRetries = (t.__fitRetries ?? 0) + 1;
      if (t.__fitRetries <= 5) setTimeout(() => void fitTerminal(), 120);
      return;
    }
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
    if (!termRef.current) return;
    let entry = termsRef.current.get(newSid);
    if (!entry) {
      const made = makeTerm(newSid);
      if (!made) return;
      entry = made;
      termsRef.current.set(newSid, made);
      // 输出订阅（每会话仅一次）：字节 → 字符串（有状态解码，处理 UTF-8 跨块分割）。
      // 不走 term.write(Uint8Array)：实测该二进制写路径在 WKWebView 下静默不渲染。
      const term = made.term;
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
      // 仅首次接入回填当前屏（会话可能建立已久）；此后切走再切回不再重置——历史保留
      const snap = await invoke<{ text: string }>("read_screen", { sid: newSid });
      term.write(snap.text);
      term.write("\r\n\x1b[90m── 会话已接入终端：点击此区域直接打字，或用下方命令框 ──\x1b[0m\r\n");
    } else if (sidRef.current === newSid) {
      entry.term.focus();
      return;
    }
    // 切换显示：其他会话终端原地隐藏（各自状态保留），显示目标会话
    for (const [s, e] of termsRef.current) e.el.classList.toggle("active", s === newSid);
    setSid(newSid);
    sidRef.current = newSid;
    xtermRef.current = entry.term;
    entry.term.focus();
    void invoke("note_terminal", { sid: newSid, focused: true }).catch(() => {});
    fitTerminal();
    // 布局与字体稳定后再校准一次（首次 fit 可能撞上渲染器尺寸未就绪）
    setTimeout(() => void fitTerminal(), 350);
    refreshBrief(newSid);
  }, [makeTerm, fitTerminal, refreshBrief]);

  // 无激活会话：隐藏所有会话终端（实例保留，点击左侧会话即恢复），显示欢迎页
  const detach = useCallback(() => {
    setSid(null);
    sidRef.current = null;
    xtermRef.current = null;
    setBrief(null);
    void invoke("note_terminal", { sid: null, focused: false }).catch(() => {});
    for (const [, e] of termsRef.current) e.el.classList.remove("active");
  }, []);

  // ⌘1–9 快速切换到第 N 个会话（终端应用标配）。捕获阶段拦截，终端聚焦时也生效。
  useEffect(() => {
    if (!inTauri) return;
    const onKey = (ev: KeyboardEvent) => {
      if (!ev.metaKey || ev.ctrlKey || ev.altKey) return;
      const n = parseInt(ev.key, 10);
      if (!n || n < 1 || n > 9) return;
      const target = sessions[n - 1];
      if (target) {
        ev.preventDefault();
        ev.stopPropagation();
        void attachSession(target.id);
      }
    };
    window.addEventListener("keydown", onKey, { capture: true });
    return () => window.removeEventListener("keydown", onKey, { capture: true });
  }, [attachSession, sessions]);

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
    // 销毁该会话的终端实例；其他会话终端保留
    const entry = termsRef.current.get(s.id);
    if (entry) {
      entry.term.dispose();
      entry.el.remove();
      termsRef.current.delete(s.id);
    }
    if (sidRef.current === s.id) detach();
    refreshLists();
  };

  // 断线会话一键重连：核心重建传输 + 重启泵 + 重注入；UI 订阅不变，输出自动恢复
  const [reconnecting, setReconnecting] = useState<string | null>(null);
  const reconnectSession = async (s: SessionInfo) => {
    setReconnecting(s.id);
    try {
      await invoke("reconnect_session", { sid: s.id });
      await refreshLists();
      await attachSession(s.id);
    } catch (e) {
      setConnError({ title: `重连 ${s.host_name} 失败`, detail: friendlyError(String(e)) });
    } finally {
      setReconnecting(null);
    }
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
  const pendingApprovals = approvals.filter((a) => a.status === "pending");
  const pendingCount = pendingApprovals.length;
  // 已处理的审批不再整卡展示，折叠为最近几条一行记录
  const resolvedApprovals = approvals.filter((a) => a.status !== "pending").slice(-3).reverse();
  const visibleTimeline = timeline.filter((ev) => !HIDDEN_AUDIT_ACTIONS.has(ev.action));

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
                  <div style={{ flex: 1, cursor: "pointer", minWidth: 0 }} tabIndex={0}
                    onClick={() => attachSession(s.id)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); attachSession(s.id); }
                    }}>
                    <div style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                      {s.host_name} <span className={"mono " + st.cls}>· {st.text}</span>
                    </div>
                    <div className="dim mono">{s.id.slice(0, 12)}</div>
                  </div>
                  {s.state === "Disconnected" && (
                    <button disabled={reconnecting !== null} onClick={() => reconnectSession(s)}>
                      {reconnecting === s.id ? "重连中…" : "重连"}
                    </button>
                  )}
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
          {!sid && (
            <div className="welcome">
              <div className="welcome-title">TinySSH — 人机协同 SSH 工作台</div>
              <div>1. 左侧「添加主机」填入地址和密码（或粘贴私钥），保存后自动连接；</div>
              <div>2. 连接后点击黑色终端区域直接打字：Ctrl+C 中断程序、↑↓ 翻历史、Tab 补全；</div>
              <div>3. 多个会话来回切换，各自的滚动历史和 vim 界面都会保留；</div>
              <div>4. ⌘C/⌘V 复制粘贴；下方命令框可逐条执行，执行后焦点自动回到终端。</div>
              <div className="dim" style={{ marginTop: 12 }}>暂无接入的会话——从左侧连接主机，或点击已有会话继续。</div>
            </div>
          )}
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

      {/* 右：审批 / 现场简报 / 操作记录 —— 给人看的协作面板，原始数据在 CLI/MCP 可查 */}
      <div className="col">
        <div className="panel-title row">
          <span>审批</span>
          {pendingCount > 0 && <span className="badge agent">{pendingCount} 待处理</span>}
        </div>
        <div className="scroll">
          {pendingApprovals.map((a) => (
            <div className="card" key={a.id}>
              <div className="row">
                <span className="badge">Agent：{a.agent_id}</span>
              </div>
              <div className="cmd" style={{ margin: "6px 0" }}>{a.command}</div>
              {a.segment_report.map((s, i) => (
                <div key={i} className="dim" style={{ fontSize: 11 }}>
                  · {s.segment} — {s.verdict}
                </div>
              ))}
              {editingId === a.id ? (
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
              )}
            </div>
          ))}
          {resolvedApprovals.length > 0 && (
            <div className="side-quiet">
              {pendingApprovals.length === 0 && <div className="side-sub">最近处理</div>}
              {resolvedApprovals.map((a) => (
                <div className="tl-row" key={a.id} title={a.command}>
                  <span className={a.status === "approved" ? "ok" : "err"} style={{ flex: "none", fontSize: 11 }}>
                    {a.status === "approved" ? "✓ 批准" : "✕ 拒绝"}
                  </span>
                  <span className="tl-cmd mono dim">{a.command}</span>
                </div>
              ))}
            </div>
          )}
          {pendingApprovals.length === 0 && resolvedApprovals.length === 0 && (
            <div className="side-quiet">暂无待审批请求。Agent 通过 MCP 发起操作时会出现在这里。</div>
          )}

          <div className="section">
            <h4>现场简报</h4>
            {brief ? <BriefCard brief={brief} /> : (
              <div className="side-quiet">未接入会话。连接主机后显示当前目录与最近命令。</div>
            )}
          </div>

          <div className="section">
            <h4>操作记录</h4>
            {visibleTimeline.length > 0 ? visibleTimeline.map((ev) => (
              <div className="tl-row" key={ev.seq} title={`#${ev.seq} ${ev.action}${ev.command ? ` · ${ev.command}` : ""}`}>
                <span className="tl-time">{hhmm(ev.ts)}</span>
                <span className={ev.actor_kind === "agent" ? "tl-agent" : "tl-human"}>
                  {ev.actor_kind === "human" ? "我" : `Agent${ev.agent_id ? `·${ev.agent_id}` : ""}`}
                </span>
                <span className="tl-what">{auditLabel(ev.action)}</span>
                {ev.command && <span className="tl-cmd mono dim">{ev.command}</span>}
              </div>
            )) : <div className="side-quiet">暂无记录。所有连接与命令都会留痕在这里。</div>}
          </div>
        </div>
      </div>
    </div>
  );
}

// 现场简报（人话版）：当前目录 / 运行中 / 最近命令 / 提示。
// 后端 facts 原样保留在 SessionBrief（MCP 侧），这里只做面向用户的重排：
// 命令历史压到最近两条、认知标签翻成中文、屏尾调试 dump 不再上屏。
function BriefCard({ brief }: { brief: Brief }) {
  const cwd = brief.facts.find((f) => f.subject === "cwd");
  const cmds = brief.facts.filter((f) => f.subject.startsWith("命令")).slice(0, 2);
  // 控制权 fact 是最近 3 条变迁（旧→新）；这里展示最新一条
  const ctl = [...brief.facts].reverse().find((f) => f.subject === "控制权");
  const notices = brief.facts.filter((f) => f.subject === "运行中任务" || f.subject === "SSH 现场");
  // 命令 fact detail 为后端拼好的 "<cmd> → exit <n>"；cmd 是键入原始字节，
  // ↑ 召回历史等场景会带转义序列，清理后再展示（清完为空说明无法还原命令，不显示该行）
  const cleanCmd = (s: string): string =>
    s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").replace(/[\x00-\x1f\x7f]/g, "").trim();
  const parseCmd = (detail: string): { cmd: string; exit: string } => {
    const i = detail.lastIndexOf(" → exit ");
    if (i < 0) return { cmd: cleanCmd(detail), exit: "" };
    return { cmd: cleanCmd(detail.slice(0, i)), exit: exitText(detail.slice(i + 8)) };
  };
  return (
    <div className="card">
      {cwd && (
        <div className="brief-row">
          当前目录 <span className="mono">{cwd.detail}</span>{" "}
          <span className={"tag " + epistemicClass(cwd.status)}>{epistemicLabel(cwd.status)}</span>
        </div>
      )}
      {brief.running.length > 0 && (
        <div className="brief-row err">运行中：{brief.running.join("、")}</div>
      )}
      {cmds.map((f, i) => {
        const { cmd, exit } = parseCmd(f.detail);
        if (!cmd) return null;
        return (
          <div className="brief-row" key={i} title={cmd}>
            <span className="mono cmd-inline">$ {cmd}</span>
            {exit && <span className="dim"> · {exit}</span>}
          </div>
        );
      })}
      {notices.map((f, i) => (
        <div className={"brief-row " + (f.status === "Unobservable" ? "err" : "warn-text")} key={`n${i}`}>
          {f.detail}
        </div>
      ))}
      {ctl && <div className="brief-row dim">控制权：{ctl.detail}</div>}
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
