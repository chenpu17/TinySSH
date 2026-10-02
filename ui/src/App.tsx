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
import { SearchAddon } from "@xterm/addon-search";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { DragDropEvent } from "@tauri-apps/api/webview";
import "@xterm/xterm/css/xterm.css";

type Host = {
  id: string; name: string; address: string; port: number; username: string;
  auth_type: "Key" | "Password" | "KeyboardInteractive" | "Agent";
  tags: string[];
};
type SshConfigPreview = {
  name: string; address: string; port: number; username: string;
  has_identity: boolean; already_imported: boolean;
};
type SshImportOutcome = { name: string; host_id: string | null; error: string | null };
type SessionInfo = {
  id: string; host_name: string; kind: string;
  state: string; control_owner: "Human" | "Agent";
};
type ApprovalItem = {
  id: string; session_id: string; agent_id: string; command: string;
  edited_command?: string | null;
  status: string; segment_report: { segment: string; verdict: string }[];
};
type PendingHostKey = {
  id: string; host_id: string; host_name: string; address: string; port: number;
  issue: "FirstSeen" | "Changed"; fingerprint: string; previous_fingerprint: string | null;
  created_at: string;
};
type PendingAuthPrompt = {
  id: string; host_name: string; name: string; instructions: string;
  prompt: string; echo: boolean; created_at: string;
};
type Brief = {
  cwd: string | null; env_summary: string;
  facts: { subject: string; detail: string; status: string }[];
  running: string[]; pending_approvals: string[]; screen_summary: string;
};
type AuditEvent = {
  seq: number; ts: string; actor_kind: string; agent_id: string | null;
  action: string; command: string | null;
  session_id?: string | null;
  payload_json?: { decision?: string } | null;
};
type IdentityMeta = { id: string; label: string; kind: string; fingerprint: string };
// 接管返回（PRD FR-6：停止结果逐条显示，不谎报）。StopOutcome serde 为
// externally tagged：{"Exited":3} / "Escalated" / "Unresponsive"。
type TakeoverReport = {
  frozen: boolean; paused_queue: string[]; stopped: [string, unknown][]; brief?: unknown;
};
function stopOutcomeText(v: unknown): { text: string; bad: boolean } {
  if (v && typeof v === "object" && "Exited" in (v as Record<string, unknown>))
    return { text: `已停止（exit ${(v as { Exited: number }).Exited}）`, bad: false };
  if (v === "Unresponsive") return { text: "升级后仍未停止", bad: true };
  if (v === "Escalated") return { text: "升级后停止", bad: false };
  return { text: String(v), bad: false };
}
// 审批状态契约：后端 ApprovalStatus 是 PascalCase（session-api v1 冻结契约，serde 无
// rename_all——"Pending"/"ApprovedEdited"…）；UI 统一在入库时归一为 snake_case 再比较。
// demo shim 直接给小写，归一后两者一致。（此前 UI 按小写过滤，真实 app 的审批面板
// 从未匹配过任何状态——文案 sweep 实锤的契约断点。）
const normApprovalStatus = (s: string): string =>
  s.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
// 最近处理（已决审批）六态标签：编辑后批准/超时/作废此前都被误显示成「✕ 拒绝」。
const approvalResolvedLabel: Record<string, { text: string; cls: string }> = {
  approved: { text: "✓ 批准", cls: "ok" },
  approved_edited: { text: "✓ 批准（编辑后）", cls: "ok" },
  denied: { text: "✕ 拒绝", cls: "err" },
  timeout: { text: "⏱ 超时未审", cls: "err" },
  voided: { text: "⊘ 已作废（接管）", cls: "dim" },
};
// 文件传输（T20）：核心返回的句柄 + UI 卡片状态（终态由审计事件按 id 对账）
type TransferHandle = { id: string; session_id: string; kind: "Upload" | "Download"; local: string; remote: string };
type TransferCard = {
  id: string; kind: "Upload" | "Download"; name: string; remote: string; local: string;
  status: "running" | "done" | "failed" | "cancelled"; bytes?: number; error?: string;
};

const epistemicClass = (s: string) =>
  s === "Confirmed" ? "tag-confirmed" : s === "NeedsRecheck" ? "tag-needsrecheck" : "tag-unobservable";

// 认知状态 → 用户能看懂的标签
const epistemicLabel = (s: string) =>
  s === "Confirmed" ? "已核实" : s === "NeedsRecheck" ? "需复核" : "未观测";

// 退出码 → 人话
const exitText = (code: string): string =>
  code === "0" ? "成功" : code === "130" ? "Ctrl+C 中断" : code === "未知" ? "已结束（退出码未知）" : `退出码 ${code}`;

// 字节数 → 人话
const fmtBytes = (n: number): string =>
  n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : n >= 1024 ? `${(n / 1024).toFixed(1)} KB` : `${n} B`;

// 路径取文件名（本地与远端同用；末尾斜杠已过滤）
const pathBasename = (p: string): string => p.split("/").filter(Boolean).pop() ?? "file";

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
    transfer_done: "传输完成",
    transfer_voided: "传输作废",
    transfer_failed: "传输失败",
  })[a] ?? a;

// 审批决定行：payload.decision 区分批准/编辑后批准/拒绝（旧库存量是 Debug 串
// "ApproveEdited(\"…\")"，按小写前缀兼容），命令本身由后端 audit 直接给实际放行文（PV R1）
const decisionLabel = (ev: AuditEvent): string => {
  if (ev.action !== "approval_decision") return auditLabel(ev.action);
  const d = (ev.payload_json?.decision ?? "").toLowerCase();
  if (d.startsWith("approve_edited") || d.startsWith("approveedited")) return "批准（编辑后）";
  if (d.startsWith("deny")) return "拒绝";
  if (d.startsWith("approve")) return "批准";
  return auditLabel(ev.action);
};

// 内部管道事件不进用户时间线（集成注入是建会话的固定噪音）
const HIDDEN_AUDIT_ACTIONS = new Set(["shell_integration_inject"]);

// 审计时间戳 → HH:MM:SS（与现场简报/后端审计口径一致——之前无秒，和简报对不上）
const hhmm = (ts: string): string => {
  const d = new Date(ts);
  return isNaN(d.getTime()) ? "" : d.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
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
  // 取消 2FA 走 ConnectFailed（含「人工应答被取消」），不是凭据错误——
  // 顺序须在 authfailed 判定之后、兜底之前，避免把「取消认证」引向改密码（PV R4）
  if (r.includes("人工应答被取消")) return "2FA 认证未完成：人工应答被取消或超时，连接已中止（凭据未被改动，可重新连接）";
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

// Option/Alt → Meta 序列（ESC 前缀）。返回 null 表示不接管（交给 xterm 原生处理）。
// 方向键发 \x1bb/\x1bf 而非修饰参数形式（\x1b[1;3D）——readline/zsh 的词跳转直接可用。
// 用物理键位 ev.code 解码：macOS 下 ⌥字母 的 ev.key 是特殊字符（⌥b=∫），不能当 meta 目标。
const altMetaSequence = (code: string | undefined, shift: boolean): string | null => {
  switch (code) {
    case "ArrowLeft": return "\x1bb";    // backward-word（⌥← 词跳转）
    case "ArrowRight": return "\x1bf";   // forward-word（⌥→ 词跳转）
    case "ArrowUp": return "\x1b[1;3A";  // tmux M-Up
    case "ArrowDown": return "\x1b[1;3B";
    case "Backspace": return "\x17";     // werase = backward-kill-word
    case "Delete": return "\x1bd";       // kill-word（前向删词）
    case "Enter": return "\x1b\r";
  }
  let c: string | null = null;
  if (code?.startsWith("Key")) c = code.slice(3).toLowerCase();
  else if (code?.startsWith("Digit")) c = code.slice(5);
  else if (code === "BracketLeft") c = "[";
  else if (code === "BracketRight") c = "]";
  else if (code === "Backslash") c = "\\";
  else if (code === "Minus") c = "-";
  else if (code === "Equal") c = "=";
  else if (code === "Comma") c = ",";
  else if (code === "Period") c = ".";
  else if (code === "Slash") c = "/";
  else if (code === "Semicolon") c = ";";
  else if (code === "Quote") c = "'";
  else if (code === "Space") c = " ";
  if (c === null) return null;
  return "\x1b" + (shift ? c.toUpperCase() : c);
};

// ⌘F 搜索配置（T16）：decorations 必须开启——onDidChangeResults 的计数仅在
// decorations 启用时上报（不配则恒 0，UI 会误显「无结果」）
const SEARCH_OPTS = {
  caseSensitive: false,
  decorations: {
    matchBackground: "#3d4d63",
    matchBorder: "#4a5a70",
    matchOverviewRuler: "#55616e",
    activeMatchBackground: "#8a6d2f",
    activeMatchBorder: "#d0b07a",
    activeMatchColorOverviewRuler: "#d0b07a",
  },
};

// 显示设置（路线图⑥）：字号范围与终端配色预设。偏好存 vault（settings KV，跨进程记忆），
// 浏览器演示模式退化为 localStorage。界面 chrome 维持深色不变——亮色 chrome 需全站变量
// 适配，属 V1 范围；此处主题只作用于终端区域（与多数客户端「编辑器配色独立」一致）。
const FONT_MIN = 9;
const FONT_MAX = 28;
const FONT_DEFAULT = 13;
const SETTING_FONT = "ui.font_size";
const SETTING_THEME = "ui.theme";

type ThemePreset = { id: string; label: string; bg: string; fg: string; theme: Record<string, string> };
const THEMES: ThemePreset[] = [
  {
    id: "dark", label: "深色（默认）", bg: "#10141a", fg: "#d7dee8",
    theme: {
      foreground: "#d7dee8", background: "#10141a",
      cursor: "#d7dee8", cursorAccent: "#10141a", selectionBackground: "#4a5a70",
      black: "#2a3442", red: "#d07a7a", green: "#7fbf8f", yellow: "#d0b07a",
      blue: "#6da3d8", magenta: "#c08ac0", cyan: "#5fb3b5", white: "#c8d0da",
      brightBlack: "#8a97a8", brightRed: "#e69595", brightGreen: "#9dd4aa", brightYellow: "#e3c795",
      brightBlue: "#8fbde8", brightMagenta: "#d8a8d8", brightCyan: "#8ecfd1", brightWhite: "#f0f4f8",
    },
  },
  {
    id: "light", label: "浅色", bg: "#f7f7f2", fg: "#2a3138",
    theme: {
      foreground: "#2a3138", background: "#f7f7f2",
      cursor: "#2a3138", cursorAccent: "#f7f7f2", selectionBackground: "#b9c6d4",
      black: "#2a3138", red: "#c4392f", green: "#2e7d32", yellow: "#a67c00",
      blue: "#1a5fb4", magenta: "#a1346b", cyan: "#1a7f8a", white: "#d0d0cc",
      brightBlack: "#6b7681", brightRed: "#e05545", brightGreen: "#46a353", brightYellow: "#c29300",
      brightBlue: "#3a7fd5", brightMagenta: "#c74d94", brightCyan: "#33a3b0", brightWhite: "#ffffff",
    },
  },
  {
    id: "solar-dark", label: "Solarized 深色", bg: "#002b36", fg: "#93a1a1",
    theme: {
      foreground: "#93a1a1", background: "#002b36",
      cursor: "#839496", cursorAccent: "#002b36", selectionBackground: "#073642",
      black: "#073642", red: "#dc322f", green: "#859900", yellow: "#b58900",
      blue: "#268bd2", magenta: "#d33682", cyan: "#2aa198", white: "#eee8d5",
      brightBlack: "#586e75", brightRed: "#cb4b16", brightGreen: "#586e75", brightYellow: "#657b83",
      brightBlue: "#839496", brightMagenta: "#6c71c4", brightCyan: "#93a1a1", brightWhite: "#fdf6e3",
    },
  },
  {
    id: "solar-light", label: "Solarized 浅色", bg: "#fdf6e3", fg: "#657b83",
    theme: {
      foreground: "#657b83", background: "#fdf6e3",
      cursor: "#586e75", cursorAccent: "#fdf6e3", selectionBackground: "#eee8d5",
      black: "#073642", red: "#dc322f", green: "#859900", yellow: "#b58900",
      blue: "#268bd2", magenta: "#d33682", cyan: "#2aa198", white: "#eee8d5",
      brightBlack: "#586e75", brightRed: "#cb4b16", brightGreen: "#586e75", brightYellow: "#657b83",
      brightBlue: "#839496", brightMagenta: "#6c71c4", brightCyan: "#93a1a1", brightWhite: "#fdf6e3",
    },
  },
];
const themeById = (id: string): ThemePreset => THEMES.find((t) => t.id === id) ?? THEMES[0];

export default function App() {

  const termRef = useRef<HTMLDivElement>(null);
  const xtermRef = useRef<Terminal | null>(null);
  const sidRef = useRef<string | null>(null);          // onData 闭包用 ref，避免 stale state
  const subscribedRef = useRef<Set<string>>(new Set()); // 每会话只订阅一次，防重复输出
  // 每会话一个独立 xterm 实例：切换会话 = 显示/隐藏，滚动历史与 vim 全屏状态原地保留
  const termsRef = useRef<Map<string, { term: Terminal; el: HTMLDivElement; search: SearchAddon; tag: HTMLDivElement }>>(new Map());
  const [sid, setSid] = useState<string | null>(null);
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const sessionsRef = useRef<SessionInfo[]>([]);
  useEffect(() => { sessionsRef.current = sessions; }, [sessions]);
  // 分屏（T19）：main=左主 pane，second=右副 pane；null=单 pane。布局（谁在左谁在右）
  // 与焦点（sid）解耦——分屏时点右 pane 只挪焦点，终端内容不左右跳动。
  // ref 与 state 并行：fitTerminal/看门狗等回调内读 ref，避开 stale closure。
  const [splitPanes, setSplitPanes] = useState<{ main: string; second: string } | null>(null);
  const splitRef = useRef<{ main: string; second: string } | null>(null);
  // 文件传输（T20）：卡片列表驱动 UI；核心完成即写审计（payload 带 transfer id），
  // UI 轮询审计把 running 卡对账成 done/failed/cancelled
  const [transfers, setTransfers] = useState<TransferCard[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const [downloadPath, setDownloadPath] = useState("");
  // ⌘F 终端内搜索（T16）：SearchAddon 每会话一个实例，随会话保持高亮
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<{ resultCount: number; resultIndex: number | undefined } | null>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  // 远程 OSC 0/2 标题（T16）：按会话记录，显示在终端头部
  const [oscTitles, setOscTitles] = useState<Record<string, string>>({});
  const [hosts, setHosts] = useState<Host[]>([]);
  const [approvals, setApprovals] = useState<ApprovalItem[]>([]);
  const [brief, setBrief] = useState<Brief | null>(null);
  // 简报 ref：拖拽上传回调里读当前 cwd（不进依赖数组，避免监听器随简报反复重订阅）
  const briefRef = useRef<Brief | null>(null);
  useEffect(() => { briefRef.current = brief; }, [brief]);
  const [timeline, setTimeline] = useState<AuditEvent[]>([]);
  const [owner, setOwner] = useState<"Human" | "Agent">("Agent");
  const [mcp, setMcp] = useState<{ endpoint: string; agents: { id: string; label: string }[] }>({ endpoint: "", agents: [] });
  const [input, setInput] = useState("");
  // 命令框历史（P2-14）：↑ 召回上一条、↓ 后退；连续重复不重复入栈
  const [cmdHistory, setCmdHistory] = useState<string[]>([]);
  const cmdHistIdx = useRef<number>(-1);
  // 连接状态机：null=空闲；连接中显示主机名；失败显示错误
  const [connecting, setConnecting] = useState<string | null>(null);
  const [connError, setConnError] = useState<{ title: string; detail: string } | null>(null);
  const [hostKeyQueue, setHostKeyQueue] = useState<PendingHostKey[]>([]);
  const [showAddHost, setShowAddHost] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [showAgentHelp, setShowAgentHelp] = useState(false);
  const [editingHost, setEditingHost] = useState<Host | null>(null);
  const [lastFailed, setLastFailed] = useState<string | null>(null);

  const refreshLists = useCallback(async () => {
    setSessions(await invoke<SessionInfo[]>("list_sessions"));
    setHosts(await invoke<Host[]>("list_hosts"));
    setApprovals((await invoke<ApprovalItem[]>("list_approvals", { pendingOnly: false }))
      .map((a) => ({ ...a, status: normApprovalStatus(a.status) })));
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
      // 分屏（T19）时左右两个 pane 各自对账。
      const sp = splitRef.current;
      const visiblePanes: string[] = sp ? [sp.main, sp.second] : sidRef.current ? [sidRef.current] : [];
      for (const p of visiblePanes) {
        const t = termsRef.current.get(p)?.term;
        if (!t) continue;
        invoke<{ cols: number; rows: number }>("read_screen", { sid: p })
          .then((snap) => {
            if (snap.cols !== t.cols || snap.rows !== t.rows) {
              void invoke("resize", { sid: p, cols: t.cols, rows: t.rows }).catch(() => {});
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

  // 主机指纹待决（T17）：初始拉取 + 事件推送；弹窗按到达顺序逐个出示。
  // 浏览器 demo 无事件通道，用同一命令轮询兜底（TOFU shim 的挂起建连靠它发现）。
  // 2FA 认证提示（路线图⑩）同一套拉取/推送模式。
  const [authPromptQueue, setAuthPromptQueue] = useState<PendingAuthPrompt[]>([]);
  const [authAnswer, setAuthAnswer] = useState("");
  useEffect(() => {
    if (!inTauri) {
      const t = setInterval(() => {
        invoke<PendingHostKey[]>("pending_host_keys")
          .then((list) => setHostKeyQueue((q) => (q.length ? q : list)))
          .catch(() => {});
        invoke<PendingAuthPrompt[]>("pending_auth_prompts")
          .then((list) => setAuthPromptQueue((q) => (q.length ? q : list)))
          .catch(() => {});
      }, 500);
      return () => clearInterval(t);
    }
    invoke<PendingHostKey[]>("pending_host_keys")
      .then((list) => setHostKeyQueue((q) => (q.length ? q : list)))
      .catch(() => {});
    invoke<PendingAuthPrompt[]>("pending_auth_prompts")
      .then((list) => setAuthPromptQueue((q) => (q.length ? q : list)))
      .catch(() => {});
    let un: (() => void) | undefined;
    let un2: (() => void) | undefined;
    listen<PendingHostKey>("hostkey-event", (ev) => {
      const item = ev.payload;
      setHostKeyQueue((q) => (q.some((x) => x.id === item.id) ? q : [...q, item]));
    }).then((f) => (un = f));
    listen<PendingAuthPrompt>("authprompt-event", (ev) => {
      const item = ev.payload;
      setAuthPromptQueue((q) => (q.some((x) => x.id === item.id) ? q : [...q, item]));
    }).then((f) => (un2 = f));
    return () => { un?.(); un2?.(); };
  }, []);
  const answerAuthPrompt = async (id: string, answer: string) => {
    setAuthPromptQueue((q) => q.filter((x) => x.id !== id));
    setAuthAnswer("");
    try { await invoke("answer_auth_prompt", { id, answer }); } catch { /* 已超时/不存在 */ }
  };

  // 终端实例工厂：每个会话一个独立 xterm。
  const makeTerm = useCallback((sessionSid: string) => {
    const mount = termRef.current;
    if (!mount) return null;
    const el = document.createElement("div");
    el.className = "term-session";
    el.dataset.sid = sessionSid;
    mount.appendChild(el);
    // 分屏（T19）会话名牌：平时隐藏，进入分屏后由 applyPanes 填主机名并显示
    const tag = document.createElement("div");
    tag.className = "pane-tag";
    el.appendChild(tag);
    // allowProposedApi：SearchAddon（registerDecoration，⌘F 高亮计数）、
    // WebLinksAddon（registerLinkProvider）与 linkHandler（OSC 8 激活）均为 proposed API
    const term = new Terminal({
      // 字号/主题（路线图⑥）走 refs：makeTerm 早于偏好载入，载入后由 changeFontSize/changeTheme
      // 对已有实例统一改 options 补齐
      fontSize: fontRef.current, cursorBlink: true, scrollback: 5000, allowProposedApi: true,
      theme: { ...themeById(themeRef.current).theme },
      // OSC 8 超链接激活（T16）：WebLinksAddon 只管裸 URL 正则检测，
      // OSC 8 由核心 linkHandler 路由（不设则核心弹 confirm 对话框）
      linkHandler: {
        activate: (_ev, uri) => {
          if (inTauri) void invoke("open_url", { url: uri }).catch(() => {});
          else window.open(uri, "_blank");
        },
      },
    });
    term.open(el);
    // 终端内搜索（⌘F，T16）：每会话独立实例，高亮随会话保留
    const searchAddon = new SearchAddon();
    searchAddon.onDidChangeResults((r) => {
      setSearchResults({ resultCount: r.resultCount, resultIndex: r.resultIndex });
    });
    term.loadAddon(searchAddon);
    // 链接识别（T16）：OSC8 超链接 + URL 自动检测；点击经 open_url 打开（仅 http/https）
    term.loadAddon(new WebLinksAddon((_ev, url) => {
      if (inTauri) void invoke("open_url", { url }).catch(() => {});
      else window.open(url, "_blank");
    }));
    // 远程设置的标题（OSC 0/2，T16）：按会话记录，显示在终端头部
    term.onTitleChange((t) => {
      if (t) setOscTitles((prev) => ({ ...prev, [sessionSid]: t }));
    });
    // 键盘保真：Ctrl+C/D/L、方向键、Esc、Tab、F 键全部原样进 PTY；
    // 只拦 macOS ⌘ 组合（剪贴板/防误触），不干扰任何控制键。
    // Option/Alt 的 Meta 转发在 window 捕获层做（见下方 onKey）——WKWebView 里
    // ⌥字母 会进文本输入系统变特殊字符（⌥b=∫），xterm 层的 keydown 收不到。
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
      if (key === "f") {
        // ⌘F 打开终端内搜索（T16）
        setSearchOpen(true);
        setTimeout(() => searchInputRef.current?.focus(), 0);
        ev.preventDefault();
        ev.stopPropagation();
        return false;
      }
      // 其余 ⌘ 快捷键（⌘R 刷新等）不得进入终端
      ev.preventDefault();
      ev.stopPropagation();
      return false;
    });
    // onData 直接归属本会话：终端实例与会话一一对应，无 stale closure。
    let deadWarned = false;
    term.onData((d) => {
      // 死会话输入拦截（P2-7）：PTY 已死，键入只会静默进黑洞——明说，不假装
      if (sessionsRef.current.find((x) => x.id === sessionSid)?.state === "Disconnected") {
        if (!deadWarned) {
          deadWarned = true;
          term.write("\r\n\x1b[33m⚠ 会话已断开——键入未发送。从左侧会话卡「重连」恢复。\x1b[0m\r\n");
        }
        return;
      }
      deadWarned = false;
      invoke("send_keys", { sid: sessionSid, keys: d }).catch((e) => {
        term.write(`\r\n\x1b[31m✕ ${String(e)}\x1b[0m\r\n`);
      });
    });
    return { term, el, search: searchAddon, tag };
  }, []);

  // 终端区域（含内容下方空白）点击即聚焦当前会话终端。
  // 搜索框/显示设置必须排除：两个浮层都挂在本容器里，点它们会冒泡到这里把焦点
  // 抢回终端——搜索词落进生产 shell（UX 走查实锤）、设置面板键盘连续操作失效。
  useEffect(() => {
    const wrap = termRef.current?.parentElement;
    if (!wrap) return;
    const onFocus = (ev: MouseEvent) => {
      const t = ev.target as HTMLElement | null;
      if (t?.closest?.(".term-search, .term-settings, .dead-overlay")) return;
      xtermRef.current?.focus();
    };
    wrap.addEventListener("click", onFocus);
    return () => wrap.removeEventListener("click", onFocus);
  }, []);


    // 窗口级 Ctrl+字符 接管（捕获阶段）：中文输入法在 WKWebView 的 textarea 里
    // 会吞掉 Ctrl+字母（进入拼音组合，keydown 以 229 告终），xterm 收不到控制键——
    // top/vim 因此停不下来。这里在捕获阶段自行编码控制字符直发后端，绕过 IME。
    // 命令框等真实输入控件不劫持（保留其编辑语义）；方向键/F 键等长键值交给 xterm。
    useEffect(() => {
      const onKey = (ev: KeyboardEvent) => {
        // Option/Alt → Meta 序列（ESC 前缀）：readline 词跳转（⌥←/⌥→/⌥⌫）、
        // tmux M-键绑定。必须在捕获层拦截：⌥字母 在 WKWebView 会进文本输入系统
        // 变特殊字符（⌥b=∫），xterm 的 keydown 收不到。⌘/Ctrl+⌥ 归各自分支。
        if (ev.altKey && !ev.ctrlKey && !ev.metaKey) {
          const t = ev.target as HTMLElement | null;
          if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA") &&
              !t.classList.contains("xterm-helper-textarea")) return;
          const seq = altMetaSequence(ev.code, ev.shiftKey);
          if (!seq) return;
          ev.preventDefault();
          ev.stopPropagation();
          const s0 = sidRef.current;
          if (!s0 || sessionsRef.current.find((x) => x.id === s0)?.state === "Disconnected") return;
          void invoke("send_keys", { sid: s0, keys: seq }).catch(() => {});
          return;
        }
        if (!ev.ctrlKey || ev.metaKey || ev.altKey) return;
        const t = ev.target as HTMLElement | null;
        if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA") &&
            !t.classList.contains("xterm-helper-textarea")) return;
        const s = sidRef.current;
        if (!s) return;
        // 死会话拦截：Ctrl 控制字符不进死通道（黑洞）
        if (sessionsRef.current.find((x) => x.id === s)?.state === "Disconnected") {
          ev.preventDefault();
          ev.stopPropagation();
          return;
        }
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

  // 终端尺寸自适应 + PTY 对齐（backend resize）。按「可见 pane」逐个校准：
  // 单 pane = 活动会话全幅；分屏 = 左右各按自身元素盒子（半幅）计算——
  // 每个 pane 的 xterm 尺寸与其 PTY 一一对应。
  const fitOne = useCallback(async (target: string) => {
    const entry = termsRef.current.get(target);
    if (!entry) return;
    const { term, el } = entry;
    // 隐藏中的会话（display:none）clientWidth 为 0：不按 0 尺寸校准
    if (el.clientWidth < 60 || el.clientHeight < 60) return;
    // xterm 5.5 无公开 dimensions 属性（fork API，恒 undefined → fit 静默失效、
    // xterm 恒停在构造默认 80×24，13px 时恰好与正确值重合而长期未暴露）——
    // cell 尺寸改经 _core 私有路径取（与官方 addon-fit 实现同源）
    const core = (term as unknown as { _core?: { _renderService?: { dimensions?: { css?: { cell?: { width?: number; height?: number } } } } } })._core;
    const dims = core?._renderService?.dimensions;
    const cw = dims?.css?.cell?.width;
    const ch = dims?.css?.cell?.height;
    if (!cw || !ch) {
      // 渲染器首帧未就绪：9px 兜底会把列数算错（PTY 宽度随之错位，
      // docker ps 等按宽度排版的输出会折行错乱）——等一帧重测，最多 5 次
      const t = term as unknown as { __fitRetries?: number };
      t.__fitRetries = (t.__fitRetries ?? 0) + 1;
      if (t.__fitRetries <= 5) setTimeout(() => void fitOne(target), 120);
      return;
    }
    const cols = Math.max(20, Math.min(400, Math.floor(el.clientWidth / cw)));
    const rows = Math.max(6, Math.min(200, Math.floor(el.clientHeight / ch)));
    if (term.cols !== cols || term.rows !== rows) {
      term.resize(cols, rows);
      invoke("resize", { sid: target, cols, rows }).catch(() => {});
    }
  }, []);
  const fitTerminal = useCallback(() => {
    const sp = splitRef.current;
    const targets = sp ? [sp.main, sp.second] : sidRef.current ? [sidRef.current] : [];
    for (const t of targets) void fitOne(t);
  }, [fitOne]);
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

  // —— 显示设置（路线图⑥）：字号/主题，vault 持久化（跨进程记忆）——
  // 状态供 UI 渲染；ref 供 makeTerm 闭包与快捷键读取（避开 stale closure）
  const [fontSize, setFontSize] = useState(FONT_DEFAULT);
  const [themeId, setThemeId] = useState("dark");
  const [showSettings, setShowSettings] = useState(false);
  const fontRef = useRef(FONT_DEFAULT);
  const themeRef = useRef("dark");

  const persistSetting = useCallback((key: string, value: string) => {
    if (inTauri) void invoke("set_setting", { key, value }).catch(() => {});
    else try { localStorage.setItem(key, value); } catch { /* demo 模式尽力而为 */ }
  }, [inTauri]);

  const changeFontSize = useCallback((n: number) => {
    const next = Math.max(FONT_MIN, Math.min(FONT_MAX, Math.round(n)));
    if (next === fontRef.current) return;
    fontRef.current = next;
    setFontSize(next);
    persistSetting(SETTING_FONT, String(next));
    // 已有会话即时改 options；隐藏会话的 PTY 宽高在重新激活时校准（attachSession 内 fitTerminal）
    for (const [, e] of termsRef.current) e.term.options.fontSize = next;
    void fitTerminal();
    // 渲染器 cell 尺寸在下一帧才反映新字号：立即 fit 拿到旧尺寸会算出相同列数、
    // PTY 不跟随（走查实证 stty 恒 80 列）。延迟校准与 attachSession 的二次校准同理。
    setTimeout(() => void fitTerminal(), 150);
  }, [persistSetting, fitTerminal]);

  const changeTheme = useCallback((id: string) => {
    const preset = themeById(id);
    if (preset.id !== id) return;
    themeRef.current = id;
    setThemeId(id);
    persistSetting(SETTING_THEME, id);
    for (const [, e] of termsRef.current) e.term.options.theme = { ...preset.theme };
  }, [persistSetting]);

  // 启动载入偏好（Tauri=vault，浏览器=localStorage）；早于载入创建的实例一并补齐
  useEffect(() => {
    const apply = (f: number | null, t: string | null) => {
      if (f !== null && f >= FONT_MIN && f <= FONT_MAX) changeFontSize(f);
      if (t) changeTheme(t);
    };
    if (!inTauri) {
      const raw = Number(localStorage.getItem(SETTING_FONT));
      apply(Number.isFinite(raw) && raw > 0 ? raw : null, localStorage.getItem(SETTING_THEME));
      return;
    }
    invoke<string | null>("get_setting", { key: SETTING_FONT })
      .then((f) => invoke<string | null>("get_setting", { key: SETTING_THEME }).then((t) => {
        apply(f === null ? null : Number(f), t);
      }))
      .catch(() => {});
  }, [inTauri, changeFontSize, changeTheme]);

  // ⌘=/⌘− 字号步进、⌘0 重置。捕获层：终端聚焦时也生效，且先于 makeTerm 的
  // 「其余 ⌘ 全拦截」分支——此后事件即被终止，不会落进终端。
  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      if (!ev.metaKey || ev.ctrlKey || ev.altKey) return;
      const k = ev.key.toLowerCase();
      if (k !== "=" && k !== "+" && k !== "-" && k !== "0") return;
      ev.preventDefault();
      ev.stopPropagation();
      if (k === "0") changeFontSize(FONT_DEFAULT);
      else changeFontSize(fontRef.current + (k === "-" ? -1 : 1));
    };
    window.addEventListener("keydown", onKey, { capture: true });
    return () => window.removeEventListener("keydown", onKey, { capture: true });
  }, [changeFontSize]);

  // 由 splitRef/sidRef 统一同步各终端层的显示类（display 归它管，React 不渲染这些层）：
  // 单 pane：活动会话 .active；分屏：main=左半、second=右半，焦点 pane 加高亮与名牌
  const applyPanes = useCallback(() => {
    const sp = splitRef.current;
    for (const [s, e] of termsRef.current) {
      e.el.classList.remove("active", "pane-left", "pane-right", "pane-focused");
      if (sp) {
        if (s === sp.main || s === sp.second) {
          e.el.classList.add(s === sp.main ? "pane-left" : "pane-right");
          e.tag.textContent = sessionsRef.current.find((x) => x.id === s)?.host_name ?? s.slice(0, 12);
          if (s === sidRef.current) e.el.classList.add("pane-focused");
        }
      } else if (s === sidRef.current) {
        e.el.classList.add("active");
      }
    }
  }, []);

  // 聚焦某会话（点标签/点 pane/⌘1-9 共用）：只挪焦点不动布局——分屏时点右 pane
  // 不会把终端内容左右对调
  const focusSession = useCallback((target: string) => {
    const entry = termsRef.current.get(target);
    if (!entry) return;
    if (sidRef.current !== target) {
      setSid(target);
      sidRef.current = target;
      xtermRef.current = entry.term;
      refreshBrief(target);
      applyPanes();
    }
    entry.term.focus();
    void invoke("note_terminal", { sid: target, focused: true }).catch(() => {});
  }, [applyPanes, refreshBrief]);

  // 点到哪个 pane 就聚焦哪个会话（事件委托挂在 #term 上，覆盖单 pane 与分屏）
  useEffect(() => {
    const mount = termRef.current;
    if (!mount) return;
    const onDown = (ev: MouseEvent) => {
      const pane = (ev.target as HTMLElement).closest?.(".term-session") as HTMLElement | null;
      const target = pane?.dataset.sid;
      if (target) focusSession(target);
    };
    mount.addEventListener("mousedown", onDown);
    return () => mount.removeEventListener("mousedown", onDown);
  }, [focusSession]);

  // 确保会话有终端实例并完成输出订阅（attachSession 与进入分屏共用；
  // MCP 建的会话可能从未被人类 attach 过，进分屏前也要先建）
  const ensureSessionTerm = useCallback(async (sessionSid: string) => {
    if (!termRef.current || termsRef.current.has(sessionSid)) return;
    const made = makeTerm(sessionSid);
    if (!made) return;
    termsRef.current.set(sessionSid, made);
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
        invoke<{ text: string }>("read_screen", { sid: sessionSid }).then((snap) => {
          term.reset();
          term.write(snap.text);
        });
      }
    };
    await invoke("subscribe_output", { sid: sessionSid, onEvent: channel });
    subscribedRef.current.add(sessionSid);
    // 仅首次接入回填当前屏（会话可能建立已久）；此后切走再切回不再重置——历史保留
    const snap = await invoke<{ text: string }>("read_screen", { sid: sessionSid });
    term.write(snap.text);
    term.write("\r\n\x1b[90m── 会话已接入终端：点击此区域直接打字，或用下方命令框 ──\x1b[0m\r\n");
  }, [makeTerm]);

  const attachSession = useCallback(async (newSid: string) => {
    if (!termRef.current) return;
    await ensureSessionTerm(newSid);
    // 分屏时 attach 未上屏的会话 = 替换左主 pane（副 pane 保留）
    const sp = splitRef.current;
    if (sp && newSid !== sp.main && newSid !== sp.second) {
      splitRef.current = { ...sp, main: newSid };
      setSplitPanes(splitRef.current);
    }
    focusSession(newSid);
    fitTerminal();
    // 布局与字体稳定后再校准一次（首次 fit 可能撞上渲染器尺寸未就绪）
    setTimeout(() => void fitTerminal(), 350);
  }, [ensureSessionTerm, focusSession, fitTerminal]);

  // 无激活会话：隐藏所有会话终端（实例保留，点击左侧会话即恢复），显示欢迎页
  const detach = useCallback(() => {
    splitRef.current = null;
    setSplitPanes(null);
    setSid(null);
    sidRef.current = null;
    xtermRef.current = null;
    setBrief(null);
    void invoke("note_terminal", { sid: null, focused: false }).catch(() => {});
    for (const [, e] of termsRef.current) {
      e.el.classList.remove("active", "pane-left", "pane-right", "pane-focused");
    }
  }, []);

  // 进入/调整分屏（T19）：把 target 放到右副 pane（已在分屏中则替换副 pane）。
  // 主 pane 与焦点不动；50/50 固定比例（V0 不做拖拽分割条）。
  const enterSplitWith = useCallback(async (target: string) => {
    const sp = splitRef.current;
    if (sp) {
      if (target === sp.main || target === sp.second) return;
      splitRef.current = { ...sp, second: target };
    } else {
      if (!sidRef.current || target === sidRef.current) return;
      splitRef.current = { main: sidRef.current, second: target };
    }
    setSplitPanes(splitRef.current);
    await ensureSessionTerm(target);
    applyPanes();
    fitTerminal();
    setTimeout(() => void fitTerminal(), 150);
    // 工具栏点击会把焦点留在按钮上——把焦点送回终端，打字不中断
    if (sidRef.current) focusSession(sidRef.current);
  }, [ensureSessionTerm, applyPanes, fitTerminal, focusSession]);

  const exitSplit = useCallback(() => {
    if (!splitRef.current) return;
    splitRef.current = null;
    setSplitPanes(null);
    applyPanes();
    fitTerminal();
    setTimeout(() => void fitTerminal(), 150);
    if (sidRef.current) focusSession(sidRef.current);
  }, [applyPanes, fitTerminal, focusSession]);

  // 关闭会话（左栏「断开」/标签 ×/⌘W 共用）：销毁终端实例；分屏期间副 pane 关 =
  // 退出分屏（焦点不动），主 pane 关 = 副 pane 升为主
  const disconnectSid = useCallback(async (id: string) => {
    try {
      await invoke("close_session", { sid: id });
    } catch (e) {
      setConnError({ title: "断开会话失败", detail: String(e) });
    }
    subscribedRef.current.delete(id);
    const entry = termsRef.current.get(id);
    if (entry) {
      entry.term.dispose();
      entry.el.remove();
      termsRef.current.delete(id);
    }
    const sp = splitRef.current;
    if (sp?.second === id) {
      splitRef.current = null;
      setSplitPanes(null);
      // 关的正是焦点所在的副 pane：焦点回落主 pane（否则 sid 指向死会话、全屏黑）
      if (sidRef.current === id) {
        const next = termsRef.current.get(sp.main);
        if (next) {
          setSid(sp.main);
          sidRef.current = sp.main;
          xtermRef.current = next.term;
          refreshBrief(sp.main);
          void invoke("note_terminal", { sid: sp.main, focused: true }).catch(() => {});
        } else {
          detach();
        }
      }
    } else if (sp?.main === id) {
      splitRef.current = null;
      setSplitPanes(null);
      const next = termsRef.current.get(sp.second);
      if (next) {
        setSid(sp.second);
        sidRef.current = sp.second;
        xtermRef.current = next.term;
        refreshBrief(sp.second);
        void invoke("note_terminal", { sid: sp.second, focused: true }).catch(() => {});
      }
    } else if (sidRef.current === id) {
      // 关的是焦点会话：自动落到下一个还开着的会话（标签页应用惯例），没有才回欢迎页
      const next = sessionsRef.current.find((s) => s.id !== id && termsRef.current.has(s.id));
      if (next) {
        setSid(next.id);
        sidRef.current = next.id;
        xtermRef.current = termsRef.current.get(next.id)!.term;
        refreshBrief(next.id);
        void invoke("note_terminal", { sid: next.id, focused: true }).catch(() => {});
      } else {
        detach();
      }
    }
    applyPanes();
    fitTerminal();
    refreshLists();
  }, [detach, applyPanes, fitTerminal, refreshLists, refreshBrief]);

  // 危险动作确认（P1-5/P1-4）：断开活会话、删除主机都先过弹层；死会话直接关（无需确认）
  const [confirm, setConfirm] = useState<
    { kind: "closeSession"; sid: string; hostName: string } | { kind: "deleteHost"; id: string; name: string } | null
  >(null);
  const requestCloseSession = useCallback((s: SessionInfo) => {
    if (s.state === "Disconnected") { void disconnectSid(s.id); return; }
    setConfirm({ kind: "closeSession", sid: s.id, hostName: s.host_name });
  }, [disconnectSid]);
  const deleteHost = async (id: string) => {
    try {
      await invoke("delete_host", { id });
      await refreshLists();
    } catch (e) {
      setConnError({ title: "删除主机失败", detail: friendlyError(String(e)) });
    }
  };
  const confirmAction = async () => {
    if (!confirm) return;
    if (confirm.kind === "closeSession") await disconnectSid(confirm.sid);
    else await deleteHost(confirm.id);
    setConfirm(null);
  };

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

  // ⌘W 关闭当前会话标签、⌘⇧] / ⌘⇧[ 标签循环切换（T19）。捕获层：终端聚焦时也
  // 生效，且先于 makeTerm 的「其余 ⌘ 全拦截」。⌘W 只在开着会话时拦截（无会话保留
  // 系统默认关窗行为）；⇧] / ⇧[ 用物理键位 ev.code 判定（Shift 下 ev.key 是 }/{）。
  useEffect(() => {
    if (!inTauri) return;
    const onKey = (ev: KeyboardEvent) => {
      if (!ev.metaKey || ev.ctrlKey || ev.altKey) return;
      if (ev.shiftKey && (ev.code === "BracketRight" || ev.code === "BracketLeft")) {
        if (!sessions.length) return;
        ev.preventDefault();
        ev.stopPropagation();
        const i0 = Math.max(0, sessions.findIndex((x) => x.id === sidRef.current));
        const dir = ev.code === "BracketRight" ? 1 : -1;
        const target = sessions[(i0 + dir + sessions.length) % sessions.length];
        if (target) void attachSession(target.id);
        return;
      }
      if (ev.shiftKey || ev.key.toLowerCase() !== "w") return;
      const cur = sidRef.current;
      if (!cur) return;
      ev.preventDefault();
      ev.stopPropagation();
      const curSession = sessions.find((x) => x.id === cur);
      if (curSession) requestCloseSession(curSession);
      else void disconnectSid(cur);
    };
    window.addEventListener("keydown", onKey, { capture: true });
    return () => window.removeEventListener("keydown", onKey, { capture: true });
  }, [attachSession, disconnectSid, requestCloseSession, sessions]);

  // 关闭搜索：清高亮、焦点回终端
  const closeSearch = useCallback(() => {
    setSearchOpen(false);
    const addon = termsRef.current.get(sidRef.current ?? "")?.search;
    addon?.clearDecorations();
    xtermRef.current?.focus();
  }, []);

  // Esc 统一关闭浮层（P2-1）：搜索框/设置面板/添加主机/导入/Agent 指引。
  // 输入控件不劫持（命令框 Esc 有自己的语义；搜索框 input 自带 Esc 关闭）；
  // xterm 的 textarea 除外——终端里 Esc 是 vim 等程序的功能键，绝不能全局拦截。
  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key !== "Escape") return;
      const t = ev.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA") &&
          !t.classList.contains("xterm-helper-textarea")) return;
      if (searchOpen) { closeSearch(); return; }
      if (showSettings) { setShowSettings(false); return; }
      if (showAddHost || editingHost) { setShowAddHost(false); setEditingHost(null); return; }
      if (showImport) { setShowImport(false); return; }
      if (showAgentHelp) { setShowAgentHelp(false); return; }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [searchOpen, showSettings, showAddHost, showImport, showAgentHelp, editingHost, closeSearch]);

  // macOS 窗口标题跟随当前会话主机（T16）；浏览器 demo 同步 document.title
  useEffect(() => {
    const cur = sessions.find((s) => s.id === sid);
    const title = cur ? `${cur.host_name} — TinySSH` : "TinySSH — 人机协同 SSH 工作台";
    document.title = title;
    if (inTauri) void getCurrentWindow().setTitle(title).catch(() => {});
  }, [sid, sessions]);

  // 指纹确认决定：本地先移除（后端决定即从待决表清掉）；挂起的 create_session 随决定继续或报错
  const decideHostKey = async (item: PendingHostKey, accept: boolean) => {
    setHostKeyQueue((q) => q.filter((x) => x.id !== item.id));
    try {
      await invoke("decide_host_key", { id: item.id, accept });
    } catch {
      /* 已超时/不存在，无需处理 */
    }
  };

  // ---- 文件传输（T20）----
  const upsertTransfer = useCallback((c: TransferCard) => {
    setTransfers((cur) => {
      const i = cur.findIndex((x) => x.id === c.id);
      if (i < 0) return [c, ...cur];
      const next = [...cur];
      next[i] = c;
      return next;
    });
  }, []);

  // 拖拽上传：落到焦点会话的当前目录（现场简报 cwd）。先挂 pending 卡占位，
  // 拿到真实 TransferHandle 后换 id（终态对账按真实 id 匹配审计）。
  const startUploads = useCallback(async (paths: string[]) => {
    const s = sidRef.current;
    const cwd = s ? briefRef.current?.cwd : undefined;
    for (const p of paths) {
      const name = pathBasename(p);
      const tempId = `pending-${Date.now()}-${name}`;
      if (!s) {
        upsertTransfer({ id: tempId, kind: "Upload", name, remote: "—", local: p, status: "failed", error: "未接入会话——先连接并聚焦一台主机再拖入文件" });
        continue;
      }
      if (!cwd) {
        upsertTransfer({ id: tempId, kind: "Upload", name, remote: "—", local: p, status: "failed", error: "无法确定远程目录（现场简报未就绪），未上传" });
        continue;
      }
      const remote = `${cwd.replace(/\/+$/, "")}/${name}`;
      upsertTransfer({ id: tempId, kind: "Upload", name, remote, local: p, status: "running" });
      try {
        const h = await invoke<TransferHandle>("upload_file", { sid: s, local: p, remote });
        setTransfers((cur) => cur.map((c) => (c.id === tempId ? { ...c, id: h.id, remote: h.remote, local: h.local } : c)));
      } catch (e) {
        setTransfers((cur) => cur.map((c) => (c.id === tempId ? { ...c, status: "failed", error: friendlyError(String(e)) } : c)));
      }
    }
  }, [upsertTransfer]);

  // 下载：远端绝对路径 → 本地（local 省略时核心存 ~/Downloads/<文件名>）
  const startDownload = async () => {
    const s = sidRef.current;
    const rp = downloadPath.trim();
    if (!s || !rp) return;
    const tempId = `pending-dl-${Date.now()}`;
    upsertTransfer({ id: tempId, kind: "Download", name: pathBasename(rp), remote: rp, local: "…", status: "running" });
    setDownloadPath("");
    try {
      const h = await invoke<TransferHandle>("download_file", { sid: s, remote: rp, local: null });
      setTransfers((cur) => cur.map((c) => (c.id === tempId ? { ...c, id: h.id, remote: h.remote, local: h.local } : c)));
    } catch (e) {
      setTransfers((cur) => cur.map((c) => (c.id === tempId ? { ...c, status: "failed", error: friendlyError(String(e)) } : c)));
    }
  };

  // 传输终态对账：仅在有 running 卡时以 800ms 轮询审计；「已取消」= 核心 Cancelled 错误文案
  useEffect(() => {
    if (!transfers.some((t) => t.status === "running")) return;
    const t = setInterval(async () => {
      try {
        const page = await invoke<{ events: (AuditEvent & { payload_json?: { transfer?: string; bytes?: number; error?: string } })[] }>("audit_query", { sid: null, limit: 30 });
        setTransfers((cur) => cur.map((c) => {
          if (c.status !== "running") return c;
          const ev = page.events.find((e) => e.payload_json?.transfer === c.id && (e.action === "transfer_done" || e.action === "transfer_failed"));
          if (!ev) return c;
          if (ev.action === "transfer_done") return { ...c, status: "done" as const, bytes: ev.payload_json?.bytes };
          const err = ev.payload_json?.error ?? "传输失败";
          return { ...c, status: err.includes("取消") ? ("cancelled" as const) : ("failed" as const), error: err };
        }));
      } catch { /* 轮询失败忽略，下轮再试 */ }
    }, 800);
    return () => clearInterval(t);
  }, [transfers]);

  // 拖拽事件（Tauri drag-drop，浏览器演示模式无此通道）：enter/over 显示覆盖层，drop 上传
  useEffect(() => {
    if (!inTauri) return;
    let un: (() => void) | undefined;
    let dead = false;
    getCurrentWindow()
      .onDragDropEvent((ev: { payload: DragDropEvent }) => {
        const p = ev.payload;
        if (p.type === "enter" || p.type === "over") setDragOver(true);
        else if (p.type === "leave") setDragOver(false);
        else if (p.type === "drop") {
          setDragOver(false);
          const paths = (p as { paths?: string[] }).paths ?? [];
          if (paths.length) void startUploads(paths);
        }
      })
      .then((f: () => void) => {
        if (dead) f();
        else un = f;
      });
    return () => {
      dead = true;
      un?.();
    };
  }, [startUploads]);

  const createSession = async (host: Host) => {    setConnecting(host.id);
    setConnError(null);
    try {
      const newSid = await invoke<string>("create_session", { hostId: host.id });
      setLastFailed(null);
      await refreshLists();
      await attachSession(newSid);
    } catch (e) {
      setLastFailed(host.id);
      setConnError({
        title: `连接 ${host.name}（${host.username}@${host.address}:${host.port}）失败`,
        detail: friendlyError(String(e)) + "——也可在主机卡上看到失败提示，修正后重试",
      });
    } finally {
      setConnecting(null);
    }
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
  // 「接管并停止任务」逐条披露停止结果（PRD FR-6：不谎报——升级后仍未停止要标红）
  const [stopResult, setStopResult] = useState<{ hostName: string; report: TakeoverReport } | null>(null);
  const takeoverStop = async () => {
    if (!sid) return;
    const r = await invoke<TakeoverReport>("set_control", { sid, owner: "Human", stopRunning: true });
    setStopResult({ hostName: sessions.find((x) => x.id === sid)?.host_name ?? "", report: r });
    await refreshLists();
  };
  const handback = async () => {
    if (!sid) return;
    await invoke("set_control", { sid, owner: "Agent" });
    await refreshLists();
  };

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editedCmd, setEditedCmd] = useState("");
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const decide = async (id: string, decision: string, edited: string | null) => {
    await invoke("decide_approval", { id, decision, edited });
    setEditingId(null);
    setConfirmId(null);
    await refreshLists();
  };

  // 审批卡风险分级：deny 命中根本不会出卡（内置危险模式直接拦），出卡的都至少
  // 有一段待审。需要人为减速带的两种形态——① 全段 pending：系统零正向信号，
  // 完全不知道安不安全；② 命中高危命令形态（rm -rf/格式化/关机类，后端内置
  // deny 只拦了其中最狠的子集，如 rm -rf /tmp 仍会出卡）。
  const DANGER_SHAPE_RE =
    /\brm\s+(?:-[a-zA-Z]+\s+)*-[a-z]*r[a-z]*f|\bmkfs\b|\bdd\b[^\n]*\bof=\/dev\/|\bshutdown\b|\breboot\b|\bpoweroff\b|\bhalt\b|\bwipefs\b|\bchmod\s+(?:-[a-zA-Z]+\s+)*777\s+\//;
  const approvalRisk = (a: ApprovalItem): string | null => {
    const segs = a.segment_report;
    if (segs.length > 0 && segs.every((s) => s.verdict.startsWith("pending:")))
      return "所有分段均未命中任何允许规则（系统无法判定安全性）";
    if (DANGER_SHAPE_RE.test(a.command)) return "命令包含高危形态（删除/格式化/关机类）";
    return null;
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
          <button className="ghost" onClick={() => { setShowImport(!showImport); setShowAddHost(false); }}>
            {showImport ? "收起导入" : "导入 ~/.ssh/config"}
          </button>
          <button className="ghost" onClick={() => { setShowAddHost(!showAddHost); setShowImport(false); setEditingHost(null); }}>
            {showAddHost ? "收起表单" : "＋ 添加主机"}
          </button>
        </div>
        <div className="scroll">
          {showImport && (
            <SshConfigImportPanel
              onDone={refreshLists}
              onClose={() => setShowImport(false)}
            />
          )}
          {showAddHost && (
            <AddHostForm
              editHost={editingHost}
              onSaved={async (hid, wasEdit) => {
                setShowAddHost(false);
                setEditingHost(null);
                await refreshLists();
                if (wasEdit) return; // 编辑只改配置，不自动建连
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
              <div className="card row host-card" key={h.id}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div>{h.name} <span className="dim">{h.auth_type === "Key" ? "· 密钥" : h.auth_type === "Agent" ? "· Agent" : "· 密码"}</span></div>
                  <div className="dim mono">{h.username}@{h.address}:{h.port}</div>
                  {lastFailed === h.id && connecting !== h.id && (
                    <div className="err" style={{ fontSize: 11, marginTop: 2 }}>✕ 上次连接失败——检查地址与凭据后重试</div>
                  )}
                </div>
                <div className="host-ops">
                  <button className="ghost" title="编辑主机（名称/地址/端口/用户名，凭据保持不变）"
                    onClick={() => { setEditingHost(h); setShowImport(false); setShowAddHost(true); }}>✎</button>
                  <button className="ghost host-del" title="删除主机"
                    onClick={() => setConfirm({ kind: "deleteHost", id: h.id, name: h.name })}>✕</button>
                </div>
                <button disabled={connecting !== null} onClick={() => createSession(h)}>
                  {connecting === h.id ? "连接中…" : "连接"}
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
                    <div style={{ display: "flex", gap: 4, minWidth: 0 }}>
                      <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{s.host_name}</span>
                      <span className={"mono " + st.cls} style={{ flex: "none" }}>· {st.text}</span>
                    </div>
                    <div className="dim mono">{s.id.slice(0, 12)}</div>
                  </div>
                  {s.state === "Disconnected" && (
                    <button disabled={reconnecting !== null} onClick={() => reconnectSession(s)}>
                      {reconnecting === s.id ? "重连中…" : "重连"}
                    </button>
                  )}
                  {s.state !== "Disconnected" && (
                    <button className="ghost" onClick={() => requestCloseSession(s)}>断开</button>
                  )}
                </div>
              );
            })}
            {sessions.length === 0 && (
              <div className="dim">暂无会话。点主机右侧的「连接」建立会话。</div>
            )}
          </div>
          <div className="section">
            <h4>Agent 接入（MCP）</h4>
            {mcp.agents.map((a) => (
              <div className="fact" key={a.id}>
                <span className="s">{a.label}</span>
                {a.id !== a.label && <span className="dim mono" style={{ fontSize: 10 }}> · id {a.id}</span>}
              </div>
            ))}
            <div className="fact">
              <span className="dim" style={{ fontSize: 11 }}>端点</span>{" "}
              <span className="mono" style={{ fontSize: 11 }}>{mcp.endpoint || "未启动"}</span>
            </div>
            <button className="ghost" style={{ marginTop: 6 }} onClick={() => setShowAgentHelp(!showAgentHelp)}>
              {showAgentHelp ? "收起接入说明" : "接入新 Agent"}
            </button>
            {showAgentHelp && (
              <div className="dim" style={{ fontSize: 11, lineHeight: 1.9, marginTop: 6 }}>
                <div>1. 终端运行 <code>tinyssh serve</code>（默认端口 8722，被占自动递增）；</div>
                <div>2. 为 Agent 签发 Token（仅展示一次）：<code>tinyssh agent create &lt;id&gt; &lt;名称&gt;</code>；</div>
                <div>3. 在 Agent 的 MCP 配置里填入端点与 Token：</div>
                <pre className="mono" style={{ fontSize: 10, whiteSpace: "pre-wrap", margin: "4px 0", userSelect: "all" }}>
{`MCP URL: ${mcp.endpoint || "http://127.0.0.1:8722/mcp"}
Authorization: Bearer <TOKEN>`}
                </pre>
                <div>接入后，Agent 的操作请求会出现在右侧审批队列逐段裁决。</div>
              </div>
            )}
            {!hasAgents && (
              <div className="dim" style={{ fontSize: 11, marginTop: 4 }}>暂无 Agent 接入——点上方「接入新 Agent」查看三步接入。</div>
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
            {current && oscTitles[sid!] && (
              <span className="dim mono">「{oscTitles[sid!]}」 · </span>
            )}
            {current && <span className={stateLabel(current.state).cls}>{stateLabel(current.state).text}</span>}
          </span>
          <span style={{ flex: 1 }} />
          {sid && (
            <span
              className={"badge " + ownerCls}
              title="「Agent」= Agent 可发起命令、经你审批执行；「人类控制」= 终端归你，Agent 冻结"
            >控制权：{ownerBadge}</span>
          )}
          {sid && hasAgents && owner === "Agent" && (
            <>
              <button
                className="warn"
                title="接管会话：Agent 冻结、待审批请求作废，终端归你操作。Agent 正在跑的命令不会被中断"
                onClick={takeover}
              >接管</button>
              <button
                className="danger"
                title="接管并额外尝试停止 Agent 正在运行的命令；停止结果逐条显示，未停下的会标红"
                onClick={takeoverStop}
              >接管并停止任务</button>
            </>
          )}
          {sid && hasAgents && owner === "Human" && (
            <button onClick={handback}>交还 Agent</button>
          )}
          <button
            className={"ghost" + (showSettings ? " ts-open" : "")}
            title="显示设置（字号 / 主题）"
            onClick={() => setShowSettings(!showSettings)}
          >Aa</button>
        </div>
        {/* 双接管按钮语义说明（PV R3：3/6 参与者只能靠猜）：Agent 持有控制权时常显一行解释 */}
        {sid && hasAgents && owner === "Agent" && (
          <div className="ctl-hint">
            接管＝冻结 Agent、待审批作废，正在跑的命令不中断 · 接管并停止任务＝再尝试停止跑着的命令（结果逐条显示）
          </div>
        )}
        {/* 标签页（T19）：每个会话一签，状态点随连接状态变色；◫ 进/换分屏，✕ 关闭（⌘W） */}
        <div className="tabbar">
          {sessions.map((s, i) => {
            const st = stateLabel(s.state);
            const inSplit = splitPanes?.main === s.id || splitPanes?.second === s.id;
            return (
              <div
                key={s.id}
                className={"tab" + (sid === s.id ? " tab-active" : "") + (inSplit ? " tab-pane" : "")}
                title={`${s.host_name} · ${st.text}${i < 9 ? ` · ⌘${i + 1}` : ""}`}
                tabIndex={0}
                role="tab"
                aria-selected={sid === s.id}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") { e.preventDefault(); void attachSession(s.id); }
                }}
                onClick={() => attachSession(s.id)}
              >
                <span className={"tab-dot " + st.cls} />
                <span className="tab-label">{s.host_name}</span>
                <span
                  className="tab-split"
                  title={splitPanes ? "放到右侧分屏" : s.id === sid ? "已在主视图" : "与当前会话分屏"}
                  onClick={(e) => { e.stopPropagation(); void enterSplitWith(s.id); }}
                >◫</span>
                <span
                  className="tab-x"
                  title="断开会话（⌘W，连接中会先确认）"
                  onClick={(e) => { e.stopPropagation(); requestCloseSession(s); }}
                >✕</span>
              </div>
            );
          })}
          <span style={{ flex: 1 }} />
          {splitPanes && <button className="ghost" onClick={exitSplit}>退出分屏</button>}
          <button className="ghost" title="新建连接（打开左侧「添加主机」表单，再点收起）" onClick={() => { setShowAddHost(!showAddHost); setShowImport(false); }}>＋</button>
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
        {stopResult && (
          <div className="conn-error">
            <div>
              <b>⏸ 已接管 {stopResult.hostName}——停止结果</b>
              <div className="dim" style={{ marginTop: 4 }}>
                {stopResult.report.stopped.length === 0 && <div>· 正在运行的任务：无</div>}
                {stopResult.report.stopped.map(([id, out]) => {
                  const o = stopOutcomeText(out);
                  return <div key={id} className={o.bad ? "err" : ""}>· {id.slice(0, 12)} → {o.text}</div>;
                })}
                <div>· 作废的排队请求：{stopResult.report.paused_queue.length} 条</div>
                <div className={stopResult.report.frozen ? "" : "err"}>· Agent 新请求{stopResult.report.frozen ? "已冻结" : "⚠ 未冻结"}</div>
                <div className="dim">现场简报已更新（右栏）；交还 Agent 前它会保持暂停。</div>
              </div>
            </div>
            <button className="ghost" onClick={() => setStopResult(null)}>知道了</button>
          </div>
        )}
        {confirm?.kind === "closeSession" && (
          <div className="confirm-mask" onClick={() => setConfirm(null)}>
            <div className="confirm-dialog" onClick={(e) => e.stopPropagation()}>
              <div className="hk-title">断开与 {confirm.hostName} 的连接？</div>
              <div>终端现场不可恢复——重连会是全新现场（记录保留）。</div>
              <div className="hk-actions">
                <button className="danger" onClick={confirmAction}>断开连接</button>
                <button className="ghost" onClick={() => setConfirm(null)}>取消</button>
              </div>
            </div>
          </div>
        )}
        {confirm?.kind === "deleteHost" && (
          <div className="confirm-mask" onClick={() => setConfirm(null)}>
            <div className="confirm-dialog" onClick={(e) => e.stopPropagation()}>
              <div className="hk-title">删除主机 {confirm.name}？</div>
              <div>凭据与指纹记录一并移除，之后无法再从它新建连接；已建立的会话不受影响。</div>
              <div className="hk-actions">
                <button className="danger" onClick={confirmAction}>删除</button>
                <button className="ghost" onClick={() => setConfirm(null)}>取消</button>
              </div>
            </div>
          </div>
        )}
        {hostKeyQueue.length > 0 && (() => {
          const hk = hostKeyQueue[0];
          return (
            <div className="hk-mask">
              <div className={"hk-dialog" + (hk.issue === "Changed" ? " hk-danger" : "")}>
                {hk.issue === "Changed" ? (
                  <>
                    <div className="hk-title hk-warn">⚠ 主机指纹已变更</div>
                    <div>
                      主机 <b>{hk.host_name}</b>（{hk.address}:{hk.port}）的指纹与此前信任的记录不一致。
                      可能是服务器重装/换钥，也可能是<b className="hk-warn">中间人攻击</b>。请通过其他可信渠道核实后再继续。
                    </div>
                    <div className="hk-fp mono">原指纹　{hk.previous_fingerprint}</div>
                    <div className="hk-fp mono">新指纹　{hk.fingerprint}</div>
                    <div className="hk-actions">
                      <button className="danger" onClick={() => decideHostKey(hk, true)}>我已核实，更新指纹并连接</button>
                      <button className="ghost" onClick={() => decideHostKey(hk, false)}>拒绝连接</button>
                    </div>
                  </>
                ) : (
                  <>
                    <div className="hk-title">首次连接确认</div>
                    <div>
                      首次连接主机 <b>{hk.host_name}</b>（{hk.address}:{hk.port}）。
                      请核对服务器指纹（可向管理员确认）后决定是否信任：
                    </div>
                    <div className="hk-fp mono">{hk.fingerprint}</div>
                    <div className="hk-actions">
                      <button onClick={() => decideHostKey(hk, true)}>信任并连接</button>
                      <button className="ghost" onClick={() => decideHostKey(hk, false)}>取消</button>
                    </div>
                  </>
                )}
              </div>
            </div>
          );
        })()}
        {authPromptQueue.length > 0 && (() => {
          const ap = authPromptQueue[0];
          return (
            <div className="hk-mask">
              <div className="hk-dialog">
                <div className="hk-title">服务器请求认证输入（双因素）</div>
                <div>
                  主机 <b>{ap.host_name}</b> 要求完成额外交互认证。请输入服务器要求的验证信息：
                </div>
                <div className="dim mono" style={{ margin: "6px 0", fontSize: 11 }}>{ap.prompt || ap.name || "verification"}</div>
                <input
                  type={ap.echo ? "text" : "password"}
                  value={authAnswer}
                  onChange={(e) => setAuthAnswer(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter" && authAnswer.trim()) void answerAuthPrompt(ap.id, authAnswer); }}
                  placeholder={ap.echo ? "输入验证码" : "输入验证码（输入不回显）"}
                  autoFocus
                  style={{ width: "100%" }}
                />
                <div className="hk-actions">
                  <button disabled={!authAnswer.trim()} onClick={() => void answerAuthPrompt(ap.id, authAnswer)}>提交验证</button>
                  <button className="ghost" onClick={() => void answerAuthPrompt(ap.id, "")}>取消认证</button>
                </div>
                <div className="dim" style={{ marginTop: 6, fontSize: 11 }}>取消将终止本次连接认证。密码本身已在连接时自动填入，无需重复输入。</div>
              </div>
            </div>
          );
        })()}
        <div className="term-wrap">
          {!sid && (
            <div className="welcome">
              <div className="welcome-title">TinySSH — 人机协同 SSH 工作台</div>
              <div>1. 左侧「添加主机」填入地址和密码（或粘贴私钥），保存后自动连接；</div>
              <div>2. 连接后点击黑色终端区域直接打字：Ctrl+C 中断程序、↑↓ 翻历史、Tab 补全；</div>
              <div>3. 多会话一屏一签，点标签切换、◫ 分屏对照两个会话，各自的滚动历史和 vim 界面都会保留；</div>
              <div>4. ⌘C/⌘V 复制粘贴；拖文件进终端即上传到当前目录；下方命令框可逐条执行，执行后焦点自动回到终端。</div>
              <div className="dim" style={{ marginTop: 12 }}>
                {sessions.length > 0
                  ? `已有 ${sessions.length} 个会话未接入终端——点击上方标签或左侧会话卡继续。`
                  : "暂无会话——从左侧连接主机开始，或导入 ~/.ssh/config。"}
              </div>
            </div>
          )}
          <div id="term" ref={termRef} />
          {current?.state === "Disconnected" && (
            <div className="dead-overlay">
              <div className="dead-banner">
                <div><b>⛔ 会话已断开</b></div>
                <div className="dim" style={{ fontSize: 12, marginTop: 4 }}>
                  画面是断开前的最后状态；键入已拦截，不会发送。
                </div>
                <div className="row" style={{ marginTop: 10 }}>
                  <button disabled={reconnecting !== null} onClick={() => reconnectSession(current)}>
                    {reconnecting === current.id ? "重连中…" : "重连恢复"}
                  </button>
                  <span className="dim" style={{ fontSize: 11 }}>重连后进入重确认（仅内置只读白名单可用）</span>
                </div>
              </div>
            </div>
          )}
          {dragOver && (
            <div className="drop-overlay">
              <div className="drop-box">
                <div className="drop-icon">⇩</div>
                <div>松开上传到 {brief?.cwd ?? "远程主机"}</div>
              </div>
            </div>
          )}
          {searchOpen && sid && (
            <div className="term-search">
              <input
                ref={searchInputRef}
                autoFocus
                placeholder="搜索终端内容…"
                value={searchQuery}
                onChange={(e) => {
                  setSearchQuery(e.target.value);
                  const addon = termsRef.current.get(sidRef.current ?? "")?.search;
                  if (!addon) return;
                  if (e.target.value) void addon.findNext(e.target.value, SEARCH_OPTS);
                  else addon.clearDecorations();
                }}
                onKeyDown={(e) => {
                  e.stopPropagation();
                  if (e.key === "Escape") {
                    e.preventDefault();
                    closeSearch();
                    return;
                  }
                  if (e.key !== "Enter" || !searchQuery) return;
                  e.preventDefault();
                  const addon = termsRef.current.get(sidRef.current ?? "")?.search;
                  if (!addon) return;
                  if (e.shiftKey) addon.findPrevious(searchQuery, SEARCH_OPTS);
                  else addon.findNext(searchQuery, SEARCH_OPTS);
                }}
              />
              <span className="dim mono" style={{ whiteSpace: "nowrap" }}>
                {searchQuery && searchResults && searchResults.resultCount > 0
                  ? `${(searchResults.resultIndex ?? 0) + 1}/${searchResults.resultCount}`
                  : searchQuery
                    ? "无结果"
                    : ""}
              </span>
              <button className="ghost" title="上一个（⇧⏎）" onClick={() => searchQuery && termsRef.current.get(sidRef.current ?? "")?.search.findPrevious(searchQuery, SEARCH_OPTS)}>↑</button>
              <button className="ghost" title="下一个（⏎）" onClick={() => searchQuery && termsRef.current.get(sidRef.current ?? "")?.search.findNext(searchQuery, SEARCH_OPTS)}>↓</button>
              <button className="ghost" title="关闭（Esc）" onClick={closeSearch}>✕</button>
            </div>
          )}
          {showSettings && (
            <>
              <div className="pop-mask" onClick={() => setShowSettings(false)} />
              <div className="term-settings">
                <div className="row" style={{ marginBottom: 10 }}>
                  <b>显示设置</b>
                  <span style={{ flex: 1 }} />
                  <button className="ghost" title="关闭" onClick={() => setShowSettings(false)}>✕</button>
                </div>
                <div className="ts-label">字号</div>
                <div className="row">
                  <button className="ghost" title="减小（⌘−）" disabled={fontSize <= FONT_MIN} onClick={() => changeFontSize(fontSize - 1)}>−</button>
                  <span className="ts-val mono">{fontSize}</span>
                  <button className="ghost" title="增大（⌘=）" disabled={fontSize >= FONT_MAX} onClick={() => changeFontSize(fontSize + 1)}>＋</button>
                  <button className="ghost" disabled={fontSize === FONT_DEFAULT} onClick={() => changeFontSize(FONT_DEFAULT)}>重置</button>
                </div>
                <div className="ts-label" style={{ marginTop: 10 }}>主题</div>
                <div className="ts-themes">
                  {THEMES.map((t) => (
                    <button
                      key={t.id}
                      className={"ghost ts-opt" + (themeId === t.id ? " ts-active" : "")}
                      onClick={() => changeTheme(t.id)}
                    >
                      <span className="ts-swatch" style={{ background: t.bg, borderColor: t.fg, color: t.fg }}>Aa</span>
                      {t.label}
                    </button>
                  ))}
                </div>
                <div className="dim" style={{ marginTop: 10, fontSize: 11 }}>字号快捷键：⌘= 增大 · ⌘− 减小 · ⌘0 重置</div>
                              </div>
            </>
          )}
        </div>
        <div className="panel-title row">
          <input
            placeholder={
              current
                ? current.state === "Disconnected"
                  ? "会话已断开——从左侧会话卡「重连」恢复后再执行命令"
                  : `在 ${current.host_name} 上执行命令——回车执行，Ctrl+C 中断终端里的前台程序`
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
                  cmdHistIdx.current = -1;
                }
                return;
              }
              // ↑/↓ 历史召回（P2-14）；输入法组合期间不劫持
              if ((e.key === "ArrowUp" || e.key === "ArrowDown") && !e.altKey && !e.metaKey && !e.ctrlKey &&
                  !(e.nativeEvent as KeyboardEvent).isComposing && cmdHistory.length > 0) {
                e.preventDefault();
                const last = cmdHistory.length - 1;
                if (e.key === "ArrowUp") {
                  const next = cmdHistIdx.current < 0 ? last : Math.max(0, cmdHistIdx.current - 1);
                  cmdHistIdx.current = next;
                  setInput(cmdHistory[next]);
                } else {
                  if (cmdHistIdx.current < 0 || cmdHistIdx.current >= last) {
                    cmdHistIdx.current = -1;
                    setInput("");
                  } else {
                    cmdHistIdx.current += 1;
                    setInput(cmdHistory[cmdHistIdx.current]);
                  }
                }
                return;
              }
              if (e.key === "Enter" && input.trim() && sid) {
                // 死会话拦截（P2-7）：命令不进死通道，明说去哪恢复
                if (sessionsRef.current.find((x) => x.id === sid)?.state === "Disconnected") {
                  setConnError({ title: "会话已断开", detail: "命令未发送。从左侧会话卡「重连」恢复后再执行。" });
                  return;
                }
                const cmd = input;
                setCmdHistory((h) => (h[h.length - 1] === cmd ? h : [...h, cmd]));
                cmdHistIdx.current = -1;
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
                if (s && sessionsRef.current.find((x) => x.id === s)?.state !== "Disconnected") {
                  void invoke("send_keys", { sid: s, keys: "\u0003" }).catch(() => {});
                }
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
          {pendingApprovals.map((a) => {
            const sess = sessions.find((x) => x.id === a.session_id);
            const risk = approvalRisk(a);
            return (
              <div className="card" key={a.id}>
                <div className="row">
                  <span className="badge">Agent：{a.agent_id}</span>
                </div>
                {/* 目标上下文：多会话并存时 rm -rf 级裁决必须知道落在哪台机器 */}
                <div className="dim" style={{ fontSize: 11, marginTop: 5 }} title={a.session_id}>
                  目标：{sess ? <b style={{ color: "var(--text)" }}>{sess.host_name}</b> : "会话已不在列表"}
                  <span className="mono"> · {a.session_id.slice(0, 12)}</span>
                  {sess?.state === "Disconnected" && " · 会话已断开"}
                </div>
                <div className="cmd" style={{ margin: "6px 0" }}>{a.command}</div>
                {a.segment_report.map((s, i) => (
                  <div key={i} className="dim" style={{ fontSize: 11 }}>
                    · {s.segment} — {s.verdict}
                  </div>
                ))}
                {risk && confirmId !== a.id && (
                  <div className="dim" style={{ fontSize: 11, marginTop: 6, color: "var(--warn)" }}>
                    ⚠ {risk}——批准前请确认命令的全部效果。
                  </div>
                )}
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
                    <button
                      className={confirmId === a.id ? "warn" : undefined}
                      title={risk ? "高危/未知安全性的请求：需二次确认" : undefined}
                      onClick={() => {
                        if (risk && confirmId !== a.id) { setConfirmId(a.id); return; }
                        void decide(a.id, "approve", null);
                      }}
                    >{confirmId === a.id ? "再次点击确认批准" : "批准"}</button>
                    <button className="ghost" onClick={() => { setConfirmId(null); setEditingId(a.id); setEditedCmd(a.command); }}>编辑后批准</button>
                    <button className="danger" onClick={() => void decide(a.id, "deny", null)}>拒绝</button>
                  </div>
                )}
              </div>
            );
          })}
          {resolvedApprovals.length > 0 && (
            <div className="side-quiet">
              {pendingApprovals.length === 0 && <div className="side-sub">最近处理</div>}
              {resolvedApprovals.map((a) => (
                <div className="tl-row" key={a.id} title={a.edited_command || a.command}>
                  <span className={(approvalResolvedLabel[a.status] ?? { cls: "err" }).cls} style={{ flex: "none", fontSize: 11 }}>
                    {(approvalResolvedLabel[a.status] ?? { text: a.status }).text}
                  </span>
                  {/* 编辑后批准显示实际放行文，不是原始请求（PV R1） */}
                  <span className="tl-cmd mono dim">{a.edited_command || a.command}</span>
                </div>
              ))}
            </div>
          )}
          {pendingApprovals.length === 0 && resolvedApprovals.length === 0 && (
            <div className="side-quiet">暂无待审批请求。Agent 通过 MCP 发起操作时会出现在这里。</div>
          )}

          <div className="section">
            <h4>传输</h4>
            {inTauri && (
              <div className="row xfer-input">
                <input
                  placeholder="下载远端文件（绝对路径，回车或点「下载」）"
                  value={downloadPath}
                  onChange={(e) => setDownloadPath(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && void startDownload()}
                />
                <button disabled={!sid || !downloadPath.trim()} onClick={() => void startDownload()}>下载</button>
              </div>
            )}
            {transfers.length === 0 && (
                <div className="side-quiet">把文件从访达拖进终端即上传到当前目录；下载在上方「下载远端文件」输入框填绝对路径（存到「下载」文件夹）。</div>
            )}
            {transfers.map((t) => (
              <div className="card row xfer-row" key={t.id}>
                <span className={"xfer-dir " + (t.kind === "Upload" ? "up" : "down")}>{t.kind === "Upload" ? "↑" : "↓"}</span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div className="xfer-name mono">{t.name}</div>
                  <div className="dim mono xfer-sub">
                    {t.status === "running" && "传输中…"}
                    {t.status === "done" && `完成 · ${fmtBytes(t.bytes ?? 0)} · ${t.kind === "Upload" ? t.remote : t.local}`}
                    {t.status === "failed" && `失败：${t.error ?? "未知错误"}`}
                    {t.status === "cancelled" && "已取消"}
                  </div>
                </div>
                {t.status === "running" ? (
                  <button className="ghost" title="取消传输" onClick={() => { invoke("cancel_transfer", { id: t.id }).catch(() => {}); }}>✕</button>
                ) : (
                  <span className={t.status === "done" ? "ok" : "err"} style={{ flex: "none" }}>
                    {t.status === "done" ? "✓" : t.status === "cancelled" ? "⊘" : "✕"}
                  </span>
                )}
              </div>
            ))}
          </div>

          <div className="section">
            <h4>现场简报</h4>
            {brief ? <BriefCard brief={brief} /> : (
              <div className="side-quiet">未接入会话。连接主机后显示当前目录与最近命令。</div>
            )}
          </div>

          <div className="section">
            <h4>操作记录</h4>
            {visibleTimeline.length > 0 ? visibleTimeline.map((ev) => {
              const host = ev.session_id ? sessions.find((x) => x.id === ev.session_id)?.host_name : undefined;
              return (
                <div className="tl-row" key={ev.seq} title={`#${ev.seq} ${ev.action}${ev.command ? ` · ${ev.command}` : ""}`}>
                  <span className="tl-time">{hhmm(ev.ts)}</span>
                  <span className={ev.actor_kind === "agent" ? "tl-agent" : "tl-human"}>
                    {ev.actor_kind === "human" ? "我" : `Agent${ev.agent_id ? ` · ${ev.agent_id}` : ""}`}
                  </span>
                  {host && <span className="tl-host">{host}</span>}
                  <span className="tl-what">{decisionLabel(ev)}</span>
                  {ev.command && <span className="tl-cmd mono dim">{ev.command}</span>}
                </div>
              );
            }) : <div className="side-quiet">暂无记录。所有连接与命令都会留痕在这里。</div>}
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
            <span className={"tag " + epistemicClass(f.status)}>{epistemicLabel(f.status)}</span>
          </div>
        );
      })}
      {notices.map((f, i) => (
        <div className={"brief-row " + (f.status === "Unobservable" ? "err" : "warn-text")} key={`n${i}`} title={f.detail}>
          {f.detail}
          <span className={"tag " + epistemicClass(f.status)}>{epistemicLabel(f.status)}</span>
        </div>
      ))}
      {/* 控制权 fact 是系统核实事实；行会被截断，tooltip 给全文 */}
      {ctl && (
        <div className="brief-row dim" title={ctl.detail}>
          控制权：{ctl.detail}
          <span className={"tag " + epistemicClass(ctl.status)}>{epistemicLabel(ctl.status)}</span>
        </div>
      )}
    </div>
  );
}

// 添加主机表单：密码直存；私钥先建身份再引用（vault 侧统一加密）；Agent 只存引用
function AddHostForm({ onSaved, editHost }: { onSaved: (hostId: string, wasEdit: boolean) => void; editHost?: Host | null }) {
  const editing = !!editHost;
  const [name, setName] = useState(editHost?.name ?? "");
  const [address, setAddress] = useState(editHost?.address ?? "");
  const [port, setPort] = useState(editHost ? String(editHost.port) : "22");
  const [username, setUsername] = useState(editHost?.username ?? "");
  const [authMode, setAuthMode] = useState<"password" | "key" | "agent">("password");
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
    // 地址格式校验（P2-3）：IP 或域名，不带协议/端口/路径——之前的乱码地址能一路存到「连接成功」
    if (!/^[a-zA-Z0-9._-]{1,253}$/.test(address.trim())) {
      setErr("地址格式不对——应为 IP 或域名（如 192.168.1.10 或 server.example.com），不带端口与协议");
      return;
    }
    const p = parseInt(port, 10);
    if (!Number.isInteger(p) || p <= 0 || p > 65535) {
      setErr("端口必须是 1–65535 的数字");
      return;
    }
    setBusy(true);
    try {
      let auth: Record<string, unknown> | string;
      if (editing) {
        // 编辑不回传凭据（UI 不持明文）：后端 Keep 语义保持现有认证与密钥/密码
        auth = "Keep";
      } else if (authMode === "password") {
        if (!password) { setErr("请输入密码"); setBusy(false); return; }
        auth = { Password: { password } };
      } else if (authMode === "agent") {
        auth = "Agent";
      } else {
        if (!pem.includes("PRIVATE KEY")) { setErr("请粘贴 OpenSSH / PEM 格式的私钥内容"); setBusy(false); return; }
        const meta = await invoke<IdentityMeta>("create_identity", {
          req: { Import: { label: name.trim(), pem, passphrase: passphrase || null } },
        });
        auth = { Key: { identity_id: meta.id } };
      }
      const hid = await invoke<string>("upsert_host", {
        host: {
          id: editHost?.id ?? null, name: name.trim(), address: address.trim(),
          port: p, username: username.trim(), auth, tags: editHost?.tags ?? [],
        },
      });
      if (!editing) { setName(""); setAddress(""); setPort("22"); setPassword(""); setPem(""); setPassphrase(""); }
      onSaved(hid, editing);
    } catch (e) {
      setErr(friendlyError(String(e)));
    } finally {
      setBusy(false);
    }
  };

  const authLabel = editHost?.auth_type === "Key" ? "密钥" : editHost?.auth_type === "Agent" ? "SSH Agent" : "密码";

  return (
    <div className="card add-host">
      <div className="row" style={{ alignItems: "flex-end" }}>
        <div className="ah-field" style={{ flex: 1 }}>
          <label>名称</label>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="如：我的服务器" />
        </div>
        <div className="ah-field" style={{ flex: 2 }}>
          <label>地址（IP 或域名）</label>
          <input value={address} onChange={(e) => setAddress(e.target.value)} placeholder="192.168.1.10 或 server.example.com" style={{ minWidth: 0 }} />
        </div>
        <div className="ah-field" style={{ width: 76 }}>
          <label>端口</label>
          <input value={port} onChange={(e) => setPort(e.target.value)} />
        </div>
      </div>
      <div className="row" style={{ marginTop: 6, alignItems: "flex-end" }}>
        <div className="ah-field" style={{ flex: 1 }}>
          <label>用户名</label>
          <input value={username} onChange={(e) => setUsername(e.target.value)} />
        </div>
        <div className="ah-field" style={{ flex: 1 }}>
          <label>认证方式</label>
          <select value={authMode} disabled={editing} onChange={(e) => { setErr(null); setAuthMode(e.target.value as "password" | "key" | "agent"); }}>
            <option value="password">密码登录</option>
            <option value="key">私钥登录</option>
            <option value="agent">SSH Agent</option>
          </select>
        </div>
      </div>
      {editing ? (
        <div className="dim" style={{ marginTop: 6 }}>认证凭据保持不变（{authLabel}）。如需更换凭据，删除该主机后重新添加。</div>
      ) : authMode === "password" ? (
        <input type="password" placeholder="密码" value={password} onChange={(e) => setPassword(e.target.value)}
          style={{ marginTop: 6 }} onKeyDown={(e) => e.key === "Enter" && submit()} />
      ) : authMode === "agent" ? (
        <div className="dim" style={{ marginTop: 6 }}>连接时由本机 ssh-agent 签名（需已 ssh-add），私钥不出 agent。</div>
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
        <button disabled={busy} onClick={submit}>{busy ? "保存中…" : editing ? "保存修改" : "保存并连接"}</button>
        <span className="dim">凭据加密存入本机凭据库，不会明文落盘。</span>
      </div>
    </div>
  );
}

// ~/.ssh/config 导入面板：预览勾选 → 逐条导入（有 IdentityFile 建身份，否则走 ssh-agent）
function SshConfigImportPanel({ onDone, onClose }: { onDone: () => void; onClose: () => void }) {
  const [entries, setEntries] = useState<SshConfigPreview[] | null>(null);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [outcomes, setOutcomes] = useState<SshImportOutcome[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    invoke<SshConfigPreview[]>("ssh_config_preview", { path: null })
      .then((es) => {
        setEntries(es);
        setChecked(new Set(es.filter((e) => !e.already_imported).map((e) => e.name)));
      })
      .catch((e) => setErr(friendlyError(String(e))));
  }, []);

  const importChecked = async () => {
    setErr(null);
    if (checked.size === 0) { setErr("先勾选要导入的条目"); return; }
    setBusy(true);
    try {
      const outs = await invoke<SshImportOutcome[]>("ssh_config_import", {
        path: null, names: [...checked],
      });
      setOutcomes(outs);
      const okCount = outs.filter((o) => !o.error).length;
      if (okCount > 0) onDone();
    } catch (e) {
      setErr(friendlyError(String(e)));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card add-host">
      <div className="row">
        <strong>从 ~/.ssh/config 导入</strong>
        <span style={{ flex: 1 }} />
        <button className="ghost" onClick={onClose}>收起</button>
      </div>
      {err && <div className="err" style={{ marginTop: 6 }}>✕ {err}</div>}
      {entries === null && !err && <div className="dim" style={{ marginTop: 6 }}>读取中…</div>}
      {entries !== null && entries.length === 0 && (
        <div className="dim" style={{ marginTop: 6 }}>~/.ssh/config 里没有可导入的条目（通配符与 Match 块会跳过）。</div>
      )}
      {entries !== null && entries.length > 0 && (
        <div style={{ marginTop: 6 }}>
          {entries.map((e) => {
            const outcome = outcomes?.find((o) => o.name === e.name);
            return (
              <label key={e.name} className="row sshcfg-row">
                <input
                  type="checkbox"
                  disabled={e.already_imported || (outcome !== undefined && !outcome.error)}
                  checked={checked.has(e.name) || (e.already_imported ?? false) || (outcome !== undefined && !outcome.error)}
                  onChange={(ev) => {
                    const next = new Set(checked);
                    if (ev.target.checked) next.add(e.name); else next.delete(e.name);
                    setChecked(next);
                  }}
                />
                <span style={{ flex: 1, minWidth: 0 }}>
                  {e.name} <span className="dim mono">{e.username}@{e.address}:{e.port}</span>
                  {" "}<span className="dim">{e.has_identity ? "· 密钥" : "· Agent"}</span>
                  {outcome && !outcome.error && <span className="ok"> ✓ 已导入</span>}
                  {outcome && outcome.error && <div className="err">✕ {outcome.error}</div>}
                </span>
                {e.already_imported && <span className="dim">已在主机列表</span>}
              </label>
            );
          })}
        </div>
      )}
      <div className="row" style={{ marginTop: 8 }}>
        <button disabled={busy || entries === null} onClick={importChecked}>
          {busy ? "导入中…" : "导入选中"}
        </button>
        <span className="dim">带 IdentityFile 的条目会读私钥入凭据库；没有的走本机 ssh-agent。</span>
      </div>
    </div>
  );
}
