import { useCallback, useEffect, useRef, useState } from "react";
import {
  invoke, MkChannel, inTauri, listen,
} from "./adapter/bridge";
import { errMsg } from "./adapter/errors";
import type {
  Host, SshConfigPreview, SshImportOutcome, SessionInfo, ApprovalItem, AuthDraft,
  PendingHostKey, PendingAuthPrompt, SessionBrief as Brief, AuditEvent,
  IdentityMeta, TakeoverReport, TransferHandle, DirEntryS, ForwardSpec, ForwardInfo,
} from "./adapter/wire";
import {
  IconSliders, IconPlus, IconMinus, IconX, IconSplit, IconStop, IconPencil, IconTrash,
  IconChevronUp, IconChevronDown, IconTerminal, IconArrowDown, IconUpload, IconDownload,
  IconInbox, IconClock, IconSearch, IconLoader, IconFolder, IconFile, IconRefresh,
} from "./icons";

// macOS 标题栏融合（T33）：Overlay 红绿灯悬浮在内容上，左栏头给红绿灯留位。
// 只在原生模式加类——浏览器 demo 没有标题栏，留白反而是错的（走查可手动加类模拟）。
if (inTauri) document.documentElement.classList.add("native-chrome");
import { getVersion } from "@tauri-apps/api/app";
import * as clipboard from "@tauri-apps/plugin-clipboard-manager";
import { Terminal } from "@xterm/xterm";
import { SearchAddon } from "@xterm/addon-search";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { DragDropEvent } from "@tauri-apps/api/webview";
import "@xterm/xterm/css/xterm.css";

// 传输卡片是 UI 呈现态（终态由审计事件对账），非 wire 类型
type TransferCard = {
  id: string; kind: "Upload" | "Download"; name: string; remote: string; local: string;
  status: "running" | "done" | "failed" | "cancelled"; bytes?: number; error?: string;
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
// 审批行入库后 status 已归一为小写——状态集合用 string（wire 的 ApprovalStatus 仅在桥边界）
type ApprovalRow = Omit<ApprovalItem, "status"> & { status: string };
// 最近处理（已决审批）六态标签：编辑后批准/超时/作废此前都被误显示成「✕ 拒绝」。
const approvalResolvedLabel: Record<string, { text: string; cls: string }> = {
  approved: { text: "✓ 批准", cls: "ok" },
  approved_edited: { text: "✓ 批准（编辑后）", cls: "ok" },
  denied: { text: "✕ 拒绝", cls: "err" },
  timeout: { text: "⏱ 超时未审", cls: "err" },
  voided: { text: "⊘ 已作废（接管/会话关闭）", cls: "dim" },
};

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

// 审计动作 → 中文描述（未知动作原样显示）。全仓 29 个动作对齐清点过
// （五人走查·阿紫：「我 forward_start」裸英文漏出）——新动作必须两边同步补。
const auditLabel = (a: string): string =>
  ({
    session_created: "连接主机",
    session_closed: "断开会话",
    session_reconnect: "重连会话",
    shell_integration_inject: "注入 Shell 集成",
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
    approval_voided: "作废审批",
    takeover: "接管会话",
    handback: "交还会话",
    transfer_done: "传输完成",
    transfer_voided: "传输作废",
    transfer_failed: "传输失败",
    forward_start: "启动端口转发",
    forward_stop: "停止端口转发",
    auth_prompt_requested: "请求认证输入",
    auth_prompt_answered: "应答认证输入",
    host_key_confirm_requested: "请求指纹确认",
    host_key_decision: "指纹确认决定",
    host_key_trusted: "信任主机指纹",
  })[a] ?? a;

// 审批决定行：payload.decision 区分批准/编辑后批准/拒绝（旧库存量是 Debug 串
// "ApproveEdited(\"…\")"，按小写前缀兼容），命令本身由后端 audit 直接给实际放行文（PV R1）。
// goal_set/approval_voided 同样读 payload 细分（五人走查：清除≠更新；作废要给原因）。
const decisionLabel = (ev: AuditEvent): string => {
  if (ev.action === "goal_set") return ev.payload_json?.cleared ? "清除任务目标" : "更新任务目标";
  if (ev.action === "approval_voided") {
    const r = ev.payload_json?.reason;
    return r === "takeover" ? "作废审批（接管）" : r === "session_closed" ? "作废审批（会话关闭）" : "作废审批";
  }
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
const friendlyError = (e: unknown): string => {
  const raw = errMsg(e);
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
  // 凭据 blob 解不开 = 主密钥换了（用户走查实锤：密码主机全部由带 TINYSSH_MASTER_KEY 的
  // 开发实例加密，正式启动（钥匙串路径）实例读不开，横幅直出 "存储错误: decrypt failed"）
  if (r.includes("decrypt"))
    return "凭据解密失败：本机主密钥与保存密码时不一致。编辑该主机重新输入密码并保存即可（会用当前密钥重新加密）；若多台主机同时如此，通常与应用启动方式变更有关";
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
// 浏览器演示模式退化为 localStorage。T35（P2-7）：界面 chrome 跟随终端主题——每个预设
// 声明 chrome 色板（dark/light/solar-light），changeTheme 挂 documentElement dataset
// 切换 CSS 变量层；Tauri 下原生窗口外观（Overlay 红绿灯深浅、原生面板）同步 setTheme。
const FONT_MIN = 9;
const FONT_MAX = 28;
const FONT_DEFAULT = 13;
const SETTING_FONT = "ui.font_size";
const SETTING_THEME = "ui.theme";

type ThemePreset = {
  id: string; label: string;
  chrome: "dark" | "light" | "solar-light";
  bg: string; fg: string; theme: Record<string, string>;
};
const THEMES: ThemePreset[] = [
  {
    id: "dark", label: "深色（默认）", chrome: "dark", bg: "#10141a", fg: "#d7dee8",
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
    id: "light", label: "浅色", chrome: "light", bg: "#f7f7f2", fg: "#2a3138",
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
    id: "solar-dark", label: "Solarized 深色", chrome: "dark", bg: "#002b36", fg: "#93a1a1",
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
    id: "solar-light", label: "Solarized 浅色", chrome: "solar-light", bg: "#fdf6e3", fg: "#657b83",
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

// 快照回放的光标归位：ScreenSnapshot 的 cursor_row/col 是 shell 视角的屏幕位置（0 基），
// 回放文本后用 CSI H 归位，xterm 光标才与远端一致（否则停在屏底）。
type ScreenSnap = { text: string; cursor_row: number; cursor_col: number };
const cursorRestore = (s: { cursor_row?: number; cursor_col?: number }) =>
  `\x1b[${(s.cursor_row ?? 0) + 1};${(s.cursor_col ?? 0) + 1}H`;

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
  // 标签栏溢出指示（五人走查·林姐：16 会话时 10 个标签静默不可见，无任何溢出
  // affordance——横向滚动条 overlay 不滚动不出现）。测左/右可滚 + 被裁标签数，
  // 两侧出现 ‹ › 滚动钮；激活标签切换（含 ⌘⇧]/[ 循环）自动滚入视野
  const tabbarRef = useRef<HTMLDivElement | null>(null);
  const [tabScroll, setTabScroll] = useState<{ left: boolean; right: boolean; hiddenL: number; hiddenR: number }>({ left: false, right: false, hiddenL: 0, hiddenR: 0 });
  const measureTabbar = useCallback(() => {
    const el = tabbarRef.current;
    if (!el) return;
    // 左右分开数：右钮只报右侧被收起的数量（混合计数会把左滚过的也算进「右侧还有 N」）。
    // 用 getBoundingClientRect 视觉真相法：.tabbar 是 position:static，tab 的 offsetLeft
    // 相对的是外层 offsetParent（含 tabbar 页面偏移），与 scrollLeft 相对量基准错位——
    // 首版据此计数系统性错（左恒少报/右恒多报），视觉核验员 6 状态实测全不符
    const bar = el.getBoundingClientRect();
    const cutR = (t: Element) => t.getBoundingClientRect().left > bar.right + 1;
    const cutL = (t: Element) => t.getBoundingClientRect().right < bar.left - 1;
    const left = el.scrollLeft > 1;
    const right = el.scrollWidth - el.clientWidth - el.scrollLeft > 1;
    const tabs = Array.from(el.querySelectorAll(".tab"));
    const hiddenL = tabs.filter(cutL).length;
    const hiddenR = tabs.filter(cutR).length;
    // 值不变则返回 prev 引用——平滑滚动期间每帧都触发 onScroll，不 bailout
    // 会让整个 App 树（单文件 2800+ 行）按帧重渲染
    setTabScroll((prev) =>
      prev.left === left && prev.right === right && prev.hiddenL === hiddenL && prev.hiddenR === hiddenR ? prev : { left, right, hiddenL, hiddenR });
  }, []);
  useEffect(() => {
    measureTabbar();
    const el = tabbarRef.current;
    if (!el) return;
    const ro = new ResizeObserver(measureTabbar);
    ro.observe(el);
    return () => ro.disconnect();
  }, [measureTabbar, sessions.length]);
  useEffect(() => {
    // 激活标签滚入视野（键盘循环切换时不再落到视野外）
    tabbarRef.current?.querySelector(".tab-active")?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [sid]);
  const scrollTabs = (dir: 1 | -1) => {
    const el = tabbarRef.current;
    if (el) el.scrollBy({ left: dir * el.clientWidth * 0.8, behavior: "smooth" });
  };
  // 文件传输（T20）：卡片列表驱动 UI；核心完成即写审计（payload 带 transfer id），
  // UI 轮询审计把 running 卡对账成 done/failed/cancelled
  const [transfers, setTransfers] = useState<TransferCard[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const [downloadPath, setDownloadPath] = useState("");
  // 远程文件浏览器（T41 FR-7）：路径/条目按 sid 归属，切会话重置（H1 同款纪律）
  const [sftpPath, setSftpPath] = useState("");
  const [sftpPathInput, setSftpPathInput] = useState("");
  const [sftpEntries, setSftpEntries] = useState<DirEntryS[] | null>(null);
  const [sftpLoading, setSftpLoading] = useState(false);
  const [sftpErr, setSftpErr] = useState<string | null>(null);
  // 端口转发（T42 FR-8）：按 sid 归属；3s 轮询状态（断线→Failed 的变化要能看到）
  const [forwards, setForwards] = useState<ForwardInfo[]>([]);
  const [fwdKind, setFwdKind] = useState<"Local" | "Remote" | "Dynamic">("Local");
  const [fwdPort, setFwdPort] = useState("");
  const [fwdHost, setFwdHost] = useState("");
  const [fwdTPort, setFwdTPort] = useState("");
  const [fwdBusy, setFwdBusy] = useState(false);
  // Toast（精致化 §六/P3）：右下角轻通知，2.6s 自动消失；最多同屏 4 条
  const [toasts, setToasts] = useState<{ id: number; kind: "ok" | "err" | "info"; text: string }[]>([]);
  const toastSeq = useRef(0);
  const pushToast = useCallback((kind: "ok" | "err" | "info", text: string) => {
    const id = ++toastSeq.current;
    setToasts((cur) => [...cur.slice(-3), { id, kind, text }]);
    setTimeout(() => setToasts((cur) => cur.filter((t) => t.id !== id)), 2600);
  }, []);
  // ⌘F 终端内搜索（T16）：SearchAddon 每会话一个实例，随会话保持高亮
  const [searchOpen, setSearchOpen] = useState(false);
  // 首次接入提示（悬浮条，不占终端行——写进流会带偏 shell 光标视角）
  const [attachHint, setAttachHint] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<{ resultCount: number; resultIndex: number | undefined } | null>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  // 远程 OSC 0/2 标题（T16）：按会话记录，显示在终端头部
  const [oscTitles, setOscTitles] = useState<Record<string, string>>({});
  const [hosts, setHosts] = useState<Host[]>([]);
  const [hostsLoaded, setHostsLoaded] = useState(false);
  const [approvals, setApprovals] = useState<ApprovalRow[]>([]);
  const [brief, setBrief] = useState<Brief | null>(null);
  // 任务目标（R9：人类→Agent 委托留言）：draft 编辑中不被简报轮询覆盖，
  // 保存/清除后落盘（goalDirty 复位）再随简报同步；
  // T38-PV：未保存草稿按 sid 暂存（goalDrafts），切标签再切回不丢
  const [goalDraft, setGoalDraft] = useState("");
  const goalDirty = useRef(false);
  const goalDrafts = useRef<Map<string, string>>(new Map());
  const goalRef = useRef<HTMLTextAreaElement | null>(null);
  const prevSidRef = useRef<string | null>(null);
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
    try {
      setSessions(await invoke("list_sessions"));
      setHosts(await invoke("list_hosts"));
      setHostsLoaded(true); // §5.6：首载完成后 skeleton 才撤
      setApprovals((await invoke("list_approvals", { pendingOnly: false }))
        .map((a): ApprovalRow => ({ ...a, status: normApprovalStatus(a.status) })));
      // 多取一些：集成注入等内部事件会被前端过滤，保证可见条数够看
      const page = await invoke("audit_query", { sid: null, limit: 60 });
      setTimeline(page.events);
    } catch {
      // 审核低-5：首载失败也必须撤骨架给出空态出口（否则永久骨架 + 未处理 rejection）；
      // 3s 轮询自愈，错误不逐条打扰（连接类失败另有常驻横幅）
      setHostsLoaded(true);
    }
  }, []);

  const refreshBrief = useCallback(async (s: string) => {
    try {
      const b = await invoke("session_brief", { sid: s });
      if (sidRef.current !== s) return; // 审核H1：已切走会话的过期简报直接丢弃，防简报/任务目标跨会话串台
      setBrief(b);
    } catch { /* 会话已关 */ }
  }, []);

  // 简报到达即同步目标输入框（编辑中不覆盖）
  useEffect(() => { if (!goalDirty.current) setGoalDraft(brief?.goal ?? ""); }, [brief]);
  // 切会话：把上一会话的未保存草稿按 sid 暂存；目标会话有暂存草稿则恢复，
  // 否则清空待本会话简报回填——绝不显示上一会话的目标（审核H1：A 的委托
  // 短暂出现在 B 的输入框里，被随手一存就把 A 的任务写进 B）
  useEffect(() => {
    const prev = prevSidRef.current;
    if (prev && prev !== sid && goalDirty.current) goalDrafts.current.set(prev, goalDraft);
    const stashed = sid ? goalDrafts.current.get(sid) : undefined;
    if (stashed !== undefined) { setGoalDraft(stashed); goalDirty.current = true; }
    else { goalDirty.current = false; setGoalDraft(""); }
    prevSidRef.current = sid;
    // 仅在 sid 变化时执行：goalDraft 取的是切换前渲染帧的旧会话草稿，正是要暂存的值
  }, [sid]);
  // 目标输入框随内容自动增高（上限 150px ≈ 7 行半，超出转内部滚动）
  useEffect(() => {
    const el = goalRef.current;
    if (el) { el.style.height = "auto"; el.style.height = Math.min(el.scrollHeight, 150) + "px"; }
  }, [goalDraft, sid]);
  // 会话关闭即清其暂存草稿（审核低-1：防 goalDrafts 无界滞留）
  useEffect(() => {
    const live = new Set(sessions.map((s) => s.id));
    for (const k of [...goalDrafts.current.keys()]) if (!live.has(k)) goalDrafts.current.delete(k);
  }, [sessions]);

  const saveGoal = useCallback(async (clear = false) => {
    const target = sidRef.current;
    if (!target) return;
    const t = clear ? "" : goalDraft.trim();
    try {
      await invoke("set_session_goal", { sid: target, goal: t ? t : null });
      goalDirty.current = false;
      goalDrafts.current.delete(target); // 已落盘，清掉该会话的暂存草稿
      if (clear) setGoalDraft("");
      pushToast("ok", t ? "任务目标已更新，Agent 读简报可见" : "任务目标已清除，Agent 简报同步移除");
      void refreshBrief(target);
      void refreshLists(); // goal_set 审计事件即时上时间线
    } catch (e) {
      pushToast("err", friendlyError(e));
    }
  }, [goalDraft, refreshBrief, refreshLists, pushToast]);

  useEffect(() => {
    refreshLists();
    invoke("mcp_status").then(setMcp);
    invoke("bench_mode").then((b) => {
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
        invoke("read_screen", { sid: p })
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
        invoke("pending_host_keys")
          .then((list) => setHostKeyQueue((q) => (q.length ? q : list)))
          .catch(() => {});
        invoke("pending_auth_prompts")
          .then((list) => setAuthPromptQueue((q) => (q.length ? q : list)))
          .catch(() => {});
      }, 500);
      return () => clearInterval(t);
    }
    invoke("pending_host_keys")
      .then((list) => setHostKeyQueue((q) => (q.length ? q : list)))
      .catch(() => {});
    invoke("pending_auth_prompts")
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
        term.write(`\r\n\x1b[31m✕ ${errMsg(e)}\x1b[0m\r\n`);
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
  // T34：原生菜单「设置…⌘,」→ 打开显示设置面板；应用版本号（关于面板同源）
  const [appVersion, setAppVersion] = useState<string | null>(null);
  useEffect(() => {
    if (!inTauri) return;
    let un: (() => void) | undefined;
    listen("menu-settings", () => setShowSettings(true)).then((f) => (un = f));
    getVersion().then(setAppVersion).catch(() => {});
    return () => un?.();
  }, []);
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
    // T35（P2-7）：chrome 跟随终端主题——CSS 变量层挂 documentElement（深浅遮罩/
    // 玻璃/阴影一起换）；Tauri 下原生窗口外观同步（Overlay 红绿灯深浅渲染）。
    document.documentElement.dataset.chrome = preset.chrome;
    if (inTauri) {
      void getCurrentWindow().setTheme(preset.chrome === "dark" ? "dark" : "light").catch(() => {});
    }
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
    invoke("get_setting", { key: SETTING_FONT })
      .then((f) => invoke("get_setting", { key: SETTING_THEME }).then((t) => {
        apply(f === null ? null : Number(f), t);
      }))
      .catch(() => {});
  }, [inTauri, changeFontSize, changeTheme]);

  // ⌘=/⌘− 字号步进、⌘0 重置；⌘F 全局打开终端搜索（用户走查实证：此前只挂终端焦点层，
  // 焦点在命令框/主机列表时 ⌘F 无响应且无可见入口——R6 现实版）。
  // 捕获层：终端聚焦时也生效，且先于 makeTerm 的「其余 ⌘ 全拦截」分支——
  // 此后事件即被终止，不会落进终端。
  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      if (!ev.metaKey || ev.ctrlKey || ev.altKey) return;
      const k = ev.key.toLowerCase();
      if (k === "f") {
        if (!sidRef.current) return; // 无活动会话不劫持
        ev.preventDefault();
        ev.stopPropagation();
        setSearchOpen(true);
        setTimeout(() => searchInputRef.current?.focus(), 0);
        return;
      }
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
        invoke("read_screen", { sid: sessionSid }).then((snap) => {
          term.reset();
          term.write(snap.text);
          term.write(cursorRestore(snap));
        });
      }
    };
    // 先回放快照、后订阅实时流：反之竞争窗口内到达的字节会插在快照前渲染，错乱首屏。
    // 仅首次接入回填当前屏（会话可能建立已久）；此后切走再切回不再重置——历史保留。
    // 写完必须把光标归位到 Screen 的真实位置（cursor_row/col）：逐行写快照会把光标
    // 推到屏底——「会话已接入」提示语与后续输出（含 attach 后 fit 触发的提示符重绘）
    // 全部落到中下方，且 xterm 光标从此与 shell 视角错位（用户走查实锤的三提示符首屏）。
    const snap = await invoke("read_screen", { sid: sessionSid });
    term.write(snap.text);
    term.write(cursorRestore(snap));
    await invoke("subscribe_output", { sid: sessionSid, onEvent: channel });
    subscribedRef.current.add(sessionSid);
    // 首次接入提示改为不占终端行的悬浮条（自动淡出）：写进终端流会把 shell 的
    // 光标视角带偏——后续远端输出全部接在提示语之后渲染。
    setAttachHint(true);
    window.setTimeout(() => setAttachHint(false), 6000);
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
      setConnError({ title: "断开会话失败", detail: errMsg(e) });
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
      setConnError({ title: "删除主机失败", detail: friendlyError(e) });
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

  // 拖拽上传：目标目录优先取远程文件区正在浏览的目录（T41），否则现场简报 cwd。
  // 先挂 pending 卡占位，拿到真实 TransferHandle 后换 id（终态对账按真实 id 匹配审计）。
  const startUploads = useCallback(async (paths: string[], destDir?: string) => {
    const s = sidRef.current;
    const cwd = destDir ?? (s ? briefRef.current?.cwd : undefined);
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
        const h = await invoke("upload_file", { sid: s, local: p, remote });
        setTransfers((cur) => cur.map((c) => (c.id === tempId ? { ...c, id: h.id, remote: h.remote, local: h.local } : c)));
      } catch (e) {
        setTransfers((cur) => cur.map((c) => (c.id === tempId ? { ...c, status: "failed", error: friendlyError(e) } : c)));
      }
    }
  }, [upsertTransfer]);

  // 下载：远端绝对路径 → 本地（local 省略时核心存 ~/Downloads/<文件名>）
  const downloadRemote = useCallback(async (rp: string) => {
    const s = sidRef.current;
    if (!s || !rp) return;
    const tempId = `pending-dl-${Date.now()}`;
    upsertTransfer({ id: tempId, kind: "Download", name: pathBasename(rp), remote: rp, local: "…", status: "running" });
    try {
      const h = await invoke("download_file", { sid: s, remote: rp, local: null });
      setTransfers((cur) => cur.map((c) => (c.id === tempId ? { ...c, id: h.id, remote: h.remote, local: h.local } : c)));
    } catch (e) {
      setTransfers((cur) => cur.map((c) => (c.id === tempId ? { ...c, status: "failed", error: friendlyError(e) } : c)));
    }
  }, [upsertTransfer]);

  const startDownload = async () => {
    const rp = downloadPath.trim();
    if (!rp) return;
    setDownloadPath("");
    await downloadRemote(rp);
  };

  // ---- 远程文件浏览器（T41 FR-7）----
  const loadDir = useCallback(async (p: string) => {
    const s = sidRef.current;
    if (!s || !p.trim()) return;
    setSftpLoading(true); setSftpErr(null);
    try {
      const es = await invoke("sftp_list", { sid: s, path: p.trim() });
      if (sidRef.current !== s) return; // 已切会话的过期结果直接丢弃（H1 纪律）
      setSftpEntries(es);
      setSftpPath(p.trim());
      setSftpPathInput(p.trim());
    } catch (e) {
      if (sidRef.current === s) setSftpErr(friendlyError(e));
    } finally {
      setSftpLoading(false);
    }
  }, []);

  // 切会话：浏览器清空待命；简报 cwd 到达且本会话尚未浏览过时自动首载
  useEffect(() => {
    setSftpEntries(null); setSftpErr(null);
    if (!sid) { setSftpPath(""); setSftpPathInput(""); }
    // 只随会话切换清空——简报 cwd 变化不重置用户正在浏览的位置
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sid]);
  useEffect(() => {
    const base = brief?.cwd;
    if (sid && base && sftpEntries === null && !sftpLoading && sftpErr === null) {
      void loadDir(base);
    }
  }, [sid, brief?.cwd, sftpEntries, sftpLoading, sftpErr, loadDir]);

  // ---- 端口转发（T42 FR-8）----
  const refreshForwards = useCallback(async (): Promise<ForwardInfo[]> => {
    const s = sidRef.current;
    if (!s) { setForwards([]); return []; }
    try {
      const fs2 = await invoke("list_forwards", { sid: s });
      if (sidRef.current === s) setForwards(fs2);
      return fs2;
    } catch { return []; /* 会话已关 */ }
  }, []);

  useEffect(() => {
    setForwards([]);
    if (!sid) return;
    void refreshForwards();
    const t = setInterval(() => void refreshForwards(), 3000);
    // T44 真机冒烟补口：转发状态事件驱动刷新（Agent 建的转发/Degraded 翻转即时
    // 可见）；3s 盲轮询保留为兜底——真机实测 WKWebView 会节流 timer，纯轮询在
    // 挂起场景丢数据面可见性。仅 Tauri 环境订阅（纯浏览器 demo 模式无事件通道，
    // 轮询走 invoke shim——与 approval-event 同款守卫纪律，审核 D1）
    let un: (() => void) | undefined;
    if (inTauri) {
      listen<{ session_id: string }>("forward-event", (e) => {
        if (e.payload?.session_id === sidRef.current) void refreshForwards();
      }).then((f) => (un = f));
    }
    return () => { clearInterval(t); un?.(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sid]);

  const addForward = async () => {
    const s = sidRef.current;
    if (!s) return;
    const p = parseInt(fwdPort, 10);
    const tp = parseInt(fwdTPort, 10);
    if (!Number.isInteger(p) || p <= 0 || p > 65535) { pushToast("err", "监听端口必须是 1–65535 的数字"); return; }
    if (fwdKind !== "Dynamic" && (!fwdHost.trim() || !Number.isInteger(tp) || tp <= 0 || tp > 65535)) {
      pushToast("err", "目标主机与端口（1–65535）都要填");
      return;
    }
    const spec: ForwardSpec = fwdKind === "Dynamic"
      ? { Dynamic: { listen_addr: "127.0.0.1", listen_port: p } }
      : fwdKind === "Remote"
        ? { Remote: { listen_addr: "", listen_port: p, target_host: fwdHost.trim(), target_port: tp } }
        : { Local: { listen_addr: "127.0.0.1", listen_port: p, target_host: fwdHost.trim(), target_port: tp } };
    setFwdBusy(true);
    try {
      // 远程转发「请求被服务器拒绝」不抛错（条目保留为 Failed 可见可停）——
      // 按 refresh 后的实际状态决定 toast（审核中-2：曾对 Failed 也绿「已启动」并清输入）
      const fid = await invoke("start_forward", { sid: s, spec });
      const fs2 = await refreshForwards();
      const st = fs2.find((f) => f.id === fid);
      if (st && st.state !== "Listening") {
        pushToast("err", `转发启动失败：${st.error ?? "未知错误"}`);
        return; // 输入保留，用户改端口/主机即可重试（finally 里复位 busy）
      }
      setFwdPort(""); setFwdHost(""); setFwdTPort("");
      pushToast("ok", fwdKind === "Local" ? `本地转发已启动：127.0.0.1:${p}` : fwdKind === "Remote" ? `远程转发已启动：远端 :${p}` : `SOCKS5 已启动：127.0.0.1:${p}`);
    } catch (e) {
      pushToast("err", `转发启动失败：${friendlyError(e)}`);
      await refreshForwards();
    } finally {
      setFwdBusy(false);
    }
  };

  const stopForward = async (id: string) => {
    const s = sidRef.current;
    if (!s) return;
    try {
      await invoke("stop_forward", { sid: s, id });
    } catch (e) {
      pushToast("err", `停止失败：${friendlyError(e)}`);
    }
    await refreshForwards();
  };

  // 传输终态对账：仅在有 running 卡时以 800ms 轮询审计；「已取消」= 核心 Cancelled 错误文案
  useEffect(() => {
    if (!transfers.some((t) => t.status === "running")) return;
    const t = setInterval(async () => {
      try {
        const page = await invoke("audit_query", { sid: null, limit: 30 });
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

  // 传输终态 toast（§六）：running → done/failed 迁移时通知；卡片本身仍常显，
  // 即时失败（未接入会话等）有卡可见不重复 toast；取消是用户主动动作不打扰
  const prevTransferStatus = useRef<Map<string, string>>(new Map());
  useEffect(() => {
    for (const t of transfers) {
      const prev = prevTransferStatus.current.get(t.id);
      if (prev === "running" && t.status === "done") pushToast("ok", `传输完成：${t.name}`);
      if (prev === "running" && t.status === "failed") pushToast("err", `传输失败：${t.name}——${t.error ?? "未知错误"}`);
      prevTransferStatus.current.set(t.id, t.status);
    }
  }, [transfers, pushToast]);

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
          // 远程文件区正浏览着目录时，拖放目标 = 该目录（T41）；否则现场简报 cwd
          const dest = sftpEntries !== null && sftpPath ? sftpPath : undefined;
          if (paths.length) void startUploads(paths, dest);
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
  }, [startUploads, sftpEntries, sftpPath]);

  const createSession = async (host: Host) => {    setConnecting(host.id);
    setConnError(null);
    try {
      const newSid = await invoke("create_session", { hostId: host.id });
      setLastFailed(null);
      await refreshLists();
      await attachSession(newSid);
      pushToast("ok", `已连接 ${host.name}`);
    } catch (e) {
      // 失败走 conn-error 常驻横幅（可行动文案），不重复 toast
      setLastFailed(host.id);
      setConnError({
        title: `连接 ${host.name}（${host.username}@${host.address}:${host.port}）失败`,
        detail: friendlyError(e) + "——也可在主机卡上看到失败提示，修正后重试",
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
      pushToast("ok", `已重连 ${s.host_name}`);
    } catch (e) {
      setConnError({ title: `重连 ${s.host_name} 失败`, detail: friendlyError(e) });
    } finally {
      setReconnecting(null);
    }
  };

  const takeover = async () => {
    if (!sid) return;
    try {
      await invoke("set_control", { sid, owner: "Human", stopRunning: false });
      await refreshLists();
      pushToast("info", "已接管——Agent 冻结，终端归你");
    } catch (e) { pushToast("err", friendlyError(e)); } // 审核低-7：会话刚死等失败不再静默
  };
  // 「接管并停止任务」逐条披露停止结果（PRD FR-6：不谎报——升级后仍未停止要标红）
  const [stopResult, setStopResult] = useState<{ hostName: string; report: TakeoverReport } | null>(null);
  const takeoverStop = async () => {
    if (!sid) return;
    try {
      const r = await invoke("set_control", { sid, owner: "Human", stopRunning: true });
      setStopResult({ hostName: sessions.find((x) => x.id === sid)?.host_name ?? "", report: r });
      await refreshLists();
    } catch (e) { pushToast("err", friendlyError(e)); }
  };
  const handback = async () => {
    if (!sid) return;
    try {
      await invoke("set_control", { sid, owner: "Agent" });
      await refreshLists();
      pushToast("info", "已交还 Agent——后续操作请求走审批");
    } catch (e) { pushToast("err", friendlyError(e)); }
  };

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editedCmd, setEditedCmd] = useState("");
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const decide = async (id: string, decision: "approve" | "deny" | "edit", edited: string | null) => {
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
  const approvalRisk = (a: ApprovalRow): string | null => {
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
        {/* T33：此行即标题栏——红绿灯落位（.head-left 左留白）、整行可拖拽；两个动作收成图标钮腾出空间 */}
        <div className="panel-title row head-left" data-tauri-drag-region>
          <span data-tauri-drag-region>主机 / 会话</span>
          <span style={{ flex: 1 }} data-tauri-drag-region />
          <button className="ghost icon-btn" title={showImport ? "收起导入" : "导入 ~/.ssh/config"} aria-label={showImport ? "收起导入" : "导入 ~/.ssh/config"}
            onClick={() => { setShowImport(!showImport); setShowAddHost(false); }}>
            {showImport ? <IconChevronUp size={14} /> : <IconUpload size={14} />}
          </button>
          <button className="ghost icon-btn" title={showAddHost ? "收起表单" : "添加主机"} aria-label={showAddHost ? "收起表单" : "添加主机"}
            onClick={() => { setShowAddHost(!showAddHost); setShowImport(false); setEditingHost(null); }}>
            {showAddHost ? <IconChevronUp size={14} /> : <IconPlus size={14} />}
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
              onSaved={async (hid, wasEdit, connect = true) => {
                setShowAddHost(false);
                setEditingHost(null);
                await refreshLists();
                if (wasEdit || !connect) return; // 编辑只改配置；仅保存不自动建连
                const h = hosts.find((x) => x.id === hid);
                // list_hosts 刚刷新过，直接用返回值兜底
                const target = h ?? (await invoke("list_hosts")).find((x) => x.id === hid);
                if (target) createSession(target);
              }}
            />
          )}
          <div className="section">
            <h4>主机</h4>
            {!hostsLoaded && (
              <>
                <div className="skeleton" />
                <div className="skeleton" />
              </>
            )}
            {hosts.map((h) => {
              // 该主机的现有会话（五人走查·林姐：误点已连主机静默开重复会话）。
              // 在线徽章 + 点击切到最近会话；显式另开走右侧「连接」钮
              const mine = sessions.filter((s) => s.host_id === h.id);
              const live = mine.filter((s) => s.state !== "Disconnected");
              const anyOnline = mine.some((s) => s.state === "Connected");
              // 最近会话按时间戳比较：chrono 秒级无小数、纳秒级带小数位，
              // 字符串字典序在「同一秒内混合精度」时会错序（'Z' > '.'）
              const latest = [...live].sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))[0];
              return (
              <div className="host-card" key={h.id}
                title={`${h.username}@${h.address}:${h.port}\n指纹：${h.fingerprint ?? "首次连接时确认"}\n编码：${h.charset === "gbk" ? "GBK（中文 Windows / 老旧设备）" : "UTF-8"}`}>
                {/* R8：高频动作（连接）拿主区大点击目标；编辑/删除在右侧 hover 操作组 */}
                <div className="host-card-main" style={{ cursor: connecting ? "default" : "pointer" }}
                  title={latest
                    ? `该主机已有会话——点击切换到最近会话，右侧「连接」可另开新会话\n${h.username}@${h.address}:${h.port}\n指纹：${h.fingerprint ?? "首次连接时确认"}\n编码：${h.charset === "gbk" ? "GBK（中文 Windows / 老设备）" : "UTF-8"}`
                    : undefined}
                  onClick={() => {
                    if (connecting) return;
                    if (latest) { void attachSession(latest.id); return; }
                    createSession(h);
                  }}>
                  {/* T33：名称为主行（截断禁则）、认证方式降为徽章——修复「密/码」被腰斩。
                      T38 审核：GBK 徽章置名前——行尾会落入 hover 操作组覆盖区，置尾恰在
                      准备连接的交互时刻不可见；置左恒可见 */}
                  <div className="host-line">
                    {h.charset === "gbk" && <span className="auth-tag" title="远端编码：GBK">GBK</span>}
                    {mine.length > 0 && (
                      <span className={"auth-tag live-tag" + (anyOnline ? " on" : "")}
                        title={`已有 ${mine.length} 个会话（存活 ${live.length}）——点击主行切换到最近会话`}>● {mine.length}</span>
                    )}
                    <span className="host-name">{h.name}</span>
                    <span className="auth-tag">{h.auth_type === "Key" ? "密钥" : h.auth_type === "Agent" ? "Agent" : "密码"}</span>
                  </div>
                  <div className="host-addr mono">{h.username}@{h.address}:{h.port}</div>
                  {lastFailed === h.id && connecting !== h.id && (
                    <div className="err host-fail">✕ 上次连接失败——检查地址与凭据后重试</div>
                  )}
                </div>
                <div className="host-card-side">
                  <div className="host-ops">
                    <button className="ghost" title="编辑主机（名称/地址/端口/用户名/编码，凭据保持不变）"
                      onClick={() => { setEditingHost(h); setShowImport(false); setShowAddHost(true); }}><IconPencil size={13} /></button>
                    <button className="ghost host-del" title="删除主机"
                      onClick={() => setConfirm({ kind: "deleteHost", id: h.id, name: h.name })}><IconTrash size={13} /></button>
                  </div>
                  <button className="host-connect-btn" disabled={connecting !== null} title="连接（新建会话）"
                    onClick={() => createSession(h)}>
                    {connecting === h.id ? <><IconLoader size={11} className="spin" /> 连接中…</> : "连接"}
                  </button>
                </div>
              </div>
              );
            })}
            {hostsLoaded && hosts.length === 0 && (
              <div className="dim">还没有主机。点右上角「＋」填入地址和密码即可连接。</div>
            )}
          </div>
          <div className="section">
            <h4>会话</h4>
            {sessions.map((s) => {
              const st = stateLabel(s.state);
              return (
                <div className="card row" key={s.id}>
                  <div style={{ flex: 1, cursor: "pointer", minWidth: 0 }} tabIndex={0}
                    title={`${s.host_name} · ${st.text}`}
                    onClick={() => attachSession(s.id)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); attachSession(s.id); }
                    }}>
                    <div style={{ display: "flex", gap: 4, minWidth: 0 }}>
                      <span className="host-name">{s.host_name}</span>
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
              <span className="mono" style={{ fontSize: 11, wordBreak: "break-all" }}>{mcp.endpoint || "未启动"}</span>
            </div>
            <button className="ghost" style={{ marginTop: 6 }} onClick={() => setShowAgentHelp(!showAgentHelp)}>
              {showAgentHelp ? "收起接入说明" : "接入新 Agent"}
            </button>
            {showAgentHelp && (
              <div className="dim" style={{ fontSize: 11, lineHeight: 1.9, marginTop: 6 }}>
                <div>1. MCP 端点已随本应用自动运行（地址如上，被占自动递增，无需另起 serve）；</div>
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
        <div className="panel-title row" data-tauri-drag-region>
          <span data-tauri-drag-region>
            终端
            {current && (
              <span className="dim mono"> {current.host_name} · {sid!.slice(0, 12)} · </span>
            )}
            {current && oscTitles[sid!] && (
              <span className="dim mono">「{oscTitles[sid!]}」 · </span>
            )}
            {current && <span className={stateLabel(current.state).cls}>{stateLabel(current.state).text}</span>}
          </span>
          <span style={{ flex: 1 }} data-tauri-drag-region />
          {sid && (
            <span
              className={"ctl-badge " + ownerCls}
              title="「Agent 控制中」= Agent 可发起命令、经你审批执行；「我控制中」= 终端归你，Agent 冻结"
            ><span className="ctl-dot" />{owner === "Human" ? "我控制中" : hasAgents ? "Agent 控制中" : "手动控制"}</span>
          )}
          {sid && hasAgents && owner === "Agent" && (
            <>
              <button
                className="warn"
                title="接管会话：Agent 冻结、待审批请求作废，终端归你操作。Agent 正在跑的命令不会被中断"
                onClick={takeover}
              >接管</button>
              <button
                className="ghost-danger"
                title="接管并额外尝试停止 Agent 正在运行的命令；停止结果逐条显示，未停下的会标红"
                onClick={takeoverStop}
              >接管并停止任务</button>
            </>
          )}
          {sid && hasAgents && owner === "Human" && (
            <button
              className="ghost"
              title="交还会话：Agent 恢复操作（后续请求重新走审批）。已作废的请求不会自动重发——Agent 会收到作废通知，由它决定是否重新提交"
              onClick={handback}
            >交还 Agent</button>
          )}
          {sid && (
            <button
              className={"ghost" + (searchOpen ? " ts-open" : "")}
              title="搜索终端内容（⌘F）"
              aria-label="搜索终端内容"
              onClick={() => { setSearchOpen(true); setTimeout(() => searchInputRef.current?.focus(), 0); }}
            ><IconSearch size={15} /></button>
          )}
          <button
            className={"ghost" + (showSettings ? " ts-open" : "")}
            title="显示设置（字号 / 主题）"
            aria-label="显示设置"
            onClick={() => setShowSettings(!showSettings)}
          ><IconSliders size={15} /></button>
        </div>
        {/* 双接管按钮语义说明（PV R3：3/6 参与者只能靠猜）：Agent 持有控制权时常显一行解释
            精致化 §5.2：状态/说明类信息走 Notice Bar，不与面包屑混排 */}
        {sid && hasAgents && owner === "Agent" && (
          <div className="notice-bar info">
            接管＝冻结 Agent、待审批作废，正在跑的命令不中断 · 接管并停止任务＝再尝试停止跑着的命令（结果逐条显示）
          </div>
        )}
        {/* 重确认（受限）：安全限制状态独占一行警示（§5.2），核实完成后自动恢复 */}
        {current?.state === "Reconfirming" && (
          <div className="notice-bar warn">
            ⚠ 重确认中（受限）— 普通操作暂停，仅允许只读核实命令。核实完成后自动恢复。
          </div>
        )}
        {/* 标签页（T19）：每个会话一签，状态点随连接状态变色；◫ 进/换分屏，✕ 关闭（⌘W） */}
        {/* 溢出结构（五人走查·林姐）：滚动钮与尾部控件钉在行内，不随标签流滚走
            ——此前「＋」在溢出时也一起消失 */}
        <div className="tabbar-row">
          {tabScroll.left && (
            <button className="tab-scroll" aria-label="向左滚动标签"
              title={`左侧还有 ${tabScroll.hiddenL} 个会话被收起——点击展开（⌘⇧[ 可循环切换）`}
              onClick={() => scrollTabs(-1)}>‹</button>
          )}
          <div className="tabbar" ref={tabbarRef} onScroll={measureTabbar}>
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
                  ><IconSplit size={12} /></span>
                  <span
                    className="tab-x"
                    title="断开会话（⌘W，连接中会先确认）"
                    onClick={(e) => { e.stopPropagation(); requestCloseSession(s); }}
                  ><IconX size={11} /></span>
                </div>
              );
            })}
          </div>
          {tabScroll.right && (
            <button className="tab-scroll" aria-label="向右滚动标签"
              title={`右侧还有 ${tabScroll.hiddenR} 个会话被收起——点击展开（⌘⇧] 可循环切换）`}
              onClick={() => scrollTabs(1)}>›</button>
          )}
          {splitPanes && <button className="ghost" onClick={exitSplit}>退出分屏</button>}
          <button className="ghost" title="新建连接（打开左侧「添加主机」表单，再点收起）" aria-label="新建连接" onClick={() => { setShowAddHost(!showAddHost); setShowImport(false); }}><IconPlus size={14} /></button>
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
              <div className="welcome-box">
                <div className="welcome-mark"><IconTerminal size={26} /></div>
                <div className="welcome-title">TinySSH<span className="welcome-sub">人机协同 SSH 工作台</span></div>
                <div className="welcome-steps">
                  <div><span className="ws-k">连接</span>左侧「添加主机」填入地址和密码（或粘贴私钥），保存后自动连接</div>
                  <div><span className="ws-k">操作</span>点击终端区直接打字：Ctrl+C 中断、↑↓ 历史、Tab 补全、⌘C/⌘V 复制粘贴</div>
                  <div><span className="ws-k">多会话</span>一屏一签，点标签切换、分屏对照，各自的滚动历史和 vim 界面都会保留</div>
                  <div><span className="ws-k">传输</span>拖文件进终端即上传到当前目录；下方命令框可逐条执行，焦点自动回终端</div>
                </div>
                <div className="welcome-actions">
                  <button onClick={() => { setShowAddHost(true); setShowImport(false); }}><IconPlus size={13} /> 添加主机</button>
                  <button className="ghost" onClick={() => { setShowImport(true); setShowAddHost(false); }}>导入 ~/.ssh/config</button>
                </div>
                <div className="dim welcome-note">
                  {sessions.length > 0
                    ? `已有 ${sessions.length} 个会话未接入终端——点击上方标签或左侧会话卡继续。`
                    : "暂无会话——从左侧连接主机开始，或导入 ~/.ssh/config。"}
                </div>
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
                <div className="drop-icon"><IconDownload size={34} /></div>
                <div>松开上传到 {brief?.cwd ?? "远程主机"}</div>
              </div>
            </div>
          )}
          {attachHint && sid && (
            <div className="attach-hint">会话已接入——点击终端区直接打字，或用下方命令框</div>
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
              <button className="ghost" title="上一个（⇧⏎）" onClick={() => searchQuery && termsRef.current.get(sidRef.current ?? "")?.search.findPrevious(searchQuery, SEARCH_OPTS)}><IconChevronUp size={13} /></button>
              <button className="ghost" title="下一个（⏎）" onClick={() => searchQuery && termsRef.current.get(sidRef.current ?? "")?.search.findNext(searchQuery, SEARCH_OPTS)}><IconChevronDown size={13} /></button>
              <button className="ghost" title="关闭（Esc）" onClick={closeSearch}><IconX size={12} /></button>
            </div>
          )}
          {showSettings && (
            <>
              <div className="pop-mask" onClick={() => setShowSettings(false)} />
              <div className="term-settings">
                <div className="row" style={{ marginBottom: 10 }}>
                  <b>显示设置</b>
                  <span style={{ flex: 1 }} />
                  <button className="ghost" title="关闭" aria-label="关闭显示设置" onClick={() => setShowSettings(false)}><IconX size={13} /></button>
                </div>
                <div className="ts-label">字号</div>
                <div className="row">
                  <button className="ghost" title="减小（⌘−）" aria-label="减小字号" disabled={fontSize <= FONT_MIN} onClick={() => changeFontSize(fontSize - 1)}><IconMinus size={13} /></button>
                  <span className="ts-val mono">{fontSize}</span>
                  <button className="ghost" title="增大（⌘=）" aria-label="增大字号" disabled={fontSize >= FONT_MAX} onClick={() => changeFontSize(fontSize + 1)}><IconPlus size={13} /></button>
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
                <div className="dim" style={{ marginTop: 6, fontSize: 11, borderTop: "1px solid var(--border)", paddingTop: 6 }}>
                  TinySSH {appVersion ? `v${appVersion}` : "· 浏览器演示模式"}
                </div>
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
                  xtermRef.current?.write(`\r\n\x1b[31m✕ ${errMsg(err)}\x1b[0m\r\n`);
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
              <IconStop size={12} /> 中断
            </button>
          )}
        </div>
      </div>

      {/* 右：审批 / 现场简报 / 操作记录 —— 给人看的协作面板，原始数据在 CLI/MCP 可查 */}
      <div className="col">
        <div className="panel-title row" data-tauri-drag-region>
          <span data-tauri-drag-region>审批</span>
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
                    {/* 可编辑性由后端声明（editable 字段）：转发/传输卡无法从编辑文本回解参数，不出编辑钮 */}
                    {a.editable && <button className="ghost" onClick={() => { setConfirmId(null); setEditingId(a.id); setEditedCmd(a.command); }}>编辑后批准</button>}
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
                  <div className="tl-action">
                    <span className={(approvalResolvedLabel[a.status] ?? { cls: "err" }).cls} style={{ fontSize: 11 }}>
                      {(approvalResolvedLabel[a.status] ?? { text: a.status }).text}
                    </span>{" "}
                    {/* 编辑后批准显示实际放行文，不是原始请求（PV R1） */}
                    <span className="tl-cmd-text">{a.edited_command || a.command}</span>
                  </div>
                </div>
              ))}
            </div>
          )}
          {pendingApprovals.length === 0 && resolvedApprovals.length === 0 && (
            <div className="empty"><IconInbox size={14} />暂无待审批请求。Agent 通过 MCP 发起操作时会出现在这里。</div>
          )}

          <div className="section">
            <h4>远程文件</h4>
            {!sid ? (
              <div className="side-quiet">连接会话后可浏览远端目录；文件拖进窗口即上传到正在浏览的目录。</div>
            ) : (
              <>
                <div className="row sftp-path">
                  <input
                    className="mono"
                    placeholder="远端目录（绝对路径，回车进入）"
                    value={sftpPathInput}
                    onChange={(e) => setSftpPathInput(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && void loadDir(sftpPathInput)}
                  />
                  <button
                    className="ghost"
                    title="上一级目录"
                    disabled={!sftpPath || sftpPath === "/"}
                    onClick={() => {
                      const p = sftpPath.replace(/\/+$/, "").split("/");
                      p.pop();
                      void loadDir(p.length ? p.join("/") || "/" : "/");
                    }}
                  ><IconChevronUp size={13} /></button>
                  <button
                    className="ghost"
                    title="刷新当前目录"
                    disabled={!sftpPath || sftpLoading}
                    onClick={() => void loadDir(sftpPath)}
                  ><IconRefresh size={13} /></button>
                </div>
                {sftpErr && <div className="err" style={{ marginTop: 6 }}>✕ {sftpErr}</div>}
                {sftpLoading && (
                  <div className="sftp-list" aria-busy="true">
                    {[0, 1, 2].map((i) => <div className="skeleton sftp-sk" key={i} style={{ width: `${90 - i * 18}%`, height: 18 }} />)}
                  </div>
                )}
                {!sftpLoading && sftpEntries && sftpEntries.length === 0 && (
                  <div className="side-quiet">空目录。</div>
                )}
                {!sftpLoading && sftpEntries && sftpEntries.length > 0 && (
                  <div className="sftp-list">
                    {sftpEntries.map((e) => (
                      <div className={"sftp-row" + (e.is_dir ? " dir" : "")} key={e.name}>
                        <span className="sftp-ico">{e.is_dir ? <IconFolder size={13} /> : <IconFile size={13} />}</span>
                        {e.is_dir ? (
                          <button
                            className="sftp-name mono"
                            title={`进入 ${e.name}`}
                            onClick={() => void loadDir(`${sftpPath.replace(/\/+$/, "")}/${e.name}`)}
                          >{e.name}</button>
                        ) : (
                          <span className="sftp-name mono" title={`${sftpPath.replace(/\/+$/, "")}/${e.name}`}>{e.name}</span>
                        )}
                        <span className="dim mono sftp-size">{e.is_dir ? "目录" : fmtBytes(e.size)}</span>
                        <span className="dim mono sftp-time">{e.mtime ? new Date(e.mtime * 1000).toLocaleDateString("zh-CN", { month: "numeric", day: "numeric" }) : "—"}</span>
                        {!e.is_dir && (
                          <button
                            className="ghost sftp-dl"
                            title="下载到「下载」文件夹"
                            onClick={() => void downloadRemote(`${sftpPath.replace(/\/+$/, "")}/${e.name}`)}
                          ><IconDownload size={12} />下载</button>
                        )}
                      </div>
                    ))}
                  </div>
                )}
                <div className="side-quiet">下载存到「下载」文件夹；文件拖进窗口上传到正在浏览的目录；进度见下方「传输」。</div>
              </>
            )}
          </div>

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
                <span className={"xfer-dir " + (t.kind === "Upload" ? "up" : "down")}>
                  {t.kind === "Upload" ? <IconUpload size={12} /> : <IconDownload size={12} />}
                </span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div className="xfer-name mono" title={t.name}>{t.name}</div>
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
            <h4>端口转发</h4>
            {!sid ? (
              <div className="side-quiet">连接 SSH 会话后可建本地 / 远程 / SOCKS5 转发，随会话断开自动失效、重连自动恢复。</div>
            ) : (
              <>
                {/* 两行布局（视觉复验 R1）：右栏 280px 下 5 控件单行必挤压——
                    A 行 = 类型 + 监听端口 + 启动；B 行 = 目标主机 + 端口（仅 -L/-R） */}
                <div className="row fwd-form">
                  <select value={fwdKind} onChange={(e) => setFwdKind(e.target.value as "Local" | "Remote" | "Dynamic")} title="转发类型">
                    <option value="Local">本地 -L</option>
                    <option value="Remote">远程 -R</option>
                    <option value="Dynamic">SOCKS5 -D</option>
                  </select>
                  <input className="mono" style={{ width: 74, flex: "none" }} placeholder={fwdKind === "Remote" ? "远端端口" : "本地端口"}
                    value={fwdPort} onChange={(e) => setFwdPort(e.target.value)} />
                  <button disabled={fwdBusy} onClick={() => void addForward()}>启动</button>
                </div>
                {fwdKind !== "Dynamic" && (
                  <div className="row fwd-form" style={{ marginTop: 4 }}>
                    <input className="mono" style={{ flex: 1, minWidth: 0 }} placeholder={fwdKind === "Remote" ? "回到本机·主机" : "目标主机"}
                      value={fwdHost} onChange={(e) => setFwdHost(e.target.value)} />
                    <input className="mono" style={{ width: 64, flex: "none" }} placeholder="端口"
                      value={fwdTPort} onChange={(e) => setFwdTPort(e.target.value)} />
                  </div>
                )}
                {forwards.length === 0 && <div className="side-quiet">暂无转发。</div>}
                {forwards.map((f) => {
                  const k = "Local" in f.spec ? "Local" : "Remote" in f.spec ? "Remote" : "Dynamic";
                  const v = (f.spec as Record<string, { listen_port: number; target_host?: string; target_port?: number }>)[k];
                  // 窄栏下长目标串会省略号截断——title 携带完整串（视觉审发现）；状态文案与 title 同源（T44 视觉审：Degraded 下 title 误报"失败"）
                  const fwdText = k === "Local" ? `127.0.0.1:${v.listen_port} → ${v.target_host}:${v.target_port}`
                    : k === "Remote" ? `远端 :${v.listen_port} → 本地 ${v.target_host}:${v.target_port}`
                    : `SOCKS5 127.0.0.1:${v.listen_port}`;
                  const stateText = f.state === "Listening" ? "监听中"
                    : f.state === "Degraded" ? `降级：${f.error ?? "隧道暂不可用（重连/目标恢复后自动恢复）"}`
                    : `失败：${f.error ?? "未知错误"}`;
                  return (
                    <div className="card row fwd-row" key={f.id} title={`${fwdText} · ${stateText}`}>
                      <span className={"fwd-kind " + k.toLowerCase()}>{k === "Local" ? "-L" : k === "Remote" ? "-R" : "-D"}</span>
                      <div style={{ flex: 1, minWidth: 0 }} className="mono">
                        <div className="xfer-name">{fwdText}</div>
                        <div className={"dim mono xfer-sub"}>{stateText}</div>
                      </div>
                      {f.state === "Listening"
                        ? <span className="ok" style={{ flex: "none" }}>✓</span>
                        : f.state === "Degraded"
                          ? <span className="warn" style={{ flex: "none" }}>⚠</span>
                          : <span className="err" style={{ flex: "none" }}>✕</span>}
                      <button className="ghost" title="停止转发" onClick={() => void stopForward(f.id)}>✕</button>
                    </div>
                  );
                })}
              </>
            )}
          </div>

          <div className="section">
            <h4>任务目标</h4>
            {sid ? (
              <>
                <textarea
                  ref={goalRef}
                  className="goal-input"
                  rows={2}
                  placeholder="写给 Agent 的委托留言，例：把日志打包放到 /tmp 后交还给我"
                  value={goalDraft}
                  onChange={(e) => { goalDirty.current = true; setGoalDraft(e.target.value); }}
                />
                <div className="row" style={{ gap: 6, marginTop: 6 }}>
                  <button
                    disabled={goalDraft.trim() === (brief?.goal ?? "")}
                    onClick={() => void saveGoal()}
                  >保存</button>
                  {(brief?.goal ?? "") !== "" && (
                    <button className="ghost" onClick={() => void saveGoal(true)}>清除</button>
                  )}
                </div>
                <div className="side-quiet">Agent 接管与读简报时会先看到这里；随会话结束自动消失。</div>
              </>
            ) : (
              <div className="side-quiet">连接会话后可给 Agent 留言委托任务。</div>
            )}
          </div>

          <div className="section">
            <h4>现场简报</h4>
            {brief ? <BriefCard brief={brief} /> : (
              <div className="empty"><IconTerminal size={14} />未接入会话。连接主机后显示当前目录与最近命令。</div>
            )}
          </div>

          <div className="section">
            <h4>操作记录</h4>
            {visibleTimeline.length > 0 ? visibleTimeline.map((ev) => {
              const host = ev.session_id ? sessions.find((x) => x.id === ev.session_id)?.host_name : undefined;
              return (
                <div className={`tl-row actor-${ev.actor_kind}`} key={ev.seq} title={`#${ev.seq} ${ev.action}${ev.command ? ` · ${ev.command}` : ""}`}>
                  <div className="tl-meta">{hhmm(ev.ts)}{host ? ` · ${host}` : ""}</div>
                  <div className="tl-action">
                    <span className="tl-actor">
                      {ev.actor_kind === "human" ? "我" : `Agent${ev.agent_id ? ` · ${ev.agent_id}` : ""}`}
                    </span>{" "}
                    {decisionLabel(ev)}
                    {ev.command && <>{" "}<span className="tl-cmd-text">{ev.command}</span></>}
                  </div>
                </div>
              );
            }) : <div className="empty"><IconClock size={14} />暂无记录。所有连接与命令都会留痕在这里。</div>}
          </div>
        </div>
      </div>

      {/* Toast（§六/P3）：右下角轻通知，2.6s 自动消失，不挡交互（pointer-events 放行）。
          live 级别逐条给：err 用 assertive 立即播报，其余 polite（审核吹毛求疵-4） */}
      <div className="toast-stack">
        {toasts.map((t) => <div className={"toast " + t.kind} key={t.id} aria-live={t.kind === "err" ? "assertive" : "polite"}>{t.text}</div>)}
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
  const epi = (s: string) => s.toLowerCase(); // Confirmed/NeedsRecheck/Unobservable → CSS 修饰类
  return (
    <div className="card">
      {cwd && (
        <div className={"brief-fact " + epi(cwd.status)}>
          <span className={"epistemic-badge " + epi(cwd.status)}>{epistemicLabel(cwd.status)}</span>
          <div className="bf-body">当前目录 <span className="mono">{cwd.detail}</span></div>
        </div>
      )}
      {brief.running.length > 0 && (
        <div className="brief-fact"><div className="bf-body err">运行中：{brief.running.join("、")}</div></div>
      )}
      {cmds.map((f, i) => {
        const { cmd, exit } = parseCmd(f.detail);
        if (!cmd) return null;
        return (
          <div className={"brief-fact " + epi(f.status)} key={i} title={cmd}>
            <span className={"epistemic-badge " + epi(f.status)}>{epistemicLabel(f.status)}</span>
            <div className="bf-body">
              <span className="mono cmd-inline">$ {cmd}</span>
              {exit && <span className="dim"> · {exit}</span>}
            </div>
          </div>
        );
      })}
      {notices.map((f, i) => (
        <div className={"brief-fact " + epi(f.status)} key={`n${i}`} title={f.detail}>
          <span className={"epistemic-badge " + epi(f.status)}>{epistemicLabel(f.status)}</span>
          <div className={"bf-body" + (f.status === "Unobservable" ? " err" : "")}>{f.detail}</div>
        </div>
      ))}
      {/* 控制权 fact 是系统核实事实；行会被截断，tooltip 给全文 */}
      {ctl && (
        <div className={"brief-fact " + epi(ctl.status)} title={ctl.detail}>
          <span className={"epistemic-badge " + epi(ctl.status)}>{epistemicLabel(ctl.status)}</span>
          <div className="bf-body dim">控制权：{ctl.detail}</div>
        </div>
      )}
    </div>
  );
}

// 添加主机表单：密码直存；私钥先建身份再引用（vault 侧统一加密）；Agent 只存引用
function AddHostForm({ onSaved, editHost }: { onSaved: (hostId: string, wasEdit: boolean, connect: boolean) => void; editHost?: Host | null }) {
  const editing = !!editHost;
  const [name, setName] = useState(editHost?.name ?? "");
  const [address, setAddress] = useState(editHost?.address ?? "");
  const [port, setPort] = useState(editHost ? String(editHost.port) : "22");
  const [username, setUsername] = useState(editHost?.username ?? "");
  const [authMode, setAuthMode] = useState<"password" | "key" | "agent">("password");
  const [charset, setCharset] = useState<"utf-8" | "gbk">(editHost?.charset ?? "utf-8");
  const [password, setPassword] = useState("");
  const [pem, setPem] = useState("");
  const [passphrase, setPassphrase] = useState("");
  // 私钥先绑定后确认（FR-2 指纹确认）：粘贴/文件/生成 → create_identity 落库 →
  // 出示指纹给用户核对，保存时只引用 identity_id——明文与私钥都不随表单走
  const [identity, setIdentity] = useState<IdentityMeta | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const keyLabel = () => `${username.trim() || "key"}@${address.trim() || name.trim() || "host"}`;

  // 粘贴/文件读入的私钥 → 凭据库身份；只回元数据，不出私钥明文
  const importPem = async () => {
    setErr(null);
    if (!pem.includes("PRIVATE KEY")) { setErr("请先粘贴 OpenSSH / PEM 格式的私钥内容，或「从文件导入…」"); return; }
    setBusy(true);
    try {
      const meta = await invoke("create_identity", {
        req: { Import: { label: keyLabel(), pem, passphrase: passphrase || null } },
      });
      setIdentity(meta);
    } catch (e) {
      setErr(friendlyError(e));
    } finally {
      setBusy(false);
    }
  };

  // FR-2 生成 ed25519：vault 侧生成并加密落库，UI 只拿指纹
  const genKey = async () => {
    setErr(null);
    setBusy(true);
    try {
      const meta = await invoke("create_identity", {
        req: { Generate: { label: keyLabel(), kind: "Ed25519" } },
      });
      setIdentity(meta);
    } catch (e) {
      setErr(friendlyError(e));
    } finally {
      setBusy(false);
    }
  };

  // connect=false 走「仅保存」：批量录入场景不被逐台自动连接绑架（五人走查·林姐/小王）
  const submit = async (connect = true) => {
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
      let auth: AuthDraft;
      if (editing) {
        // 编辑默认不回传凭据（UI 不持明文）：Keep 语义保持现有认证与密钥/密码；
        // 密码主机填写了新密码 = 更换凭据（vault 侧新建加密 identity 替换——
        // 主密钥不匹配/换密码场景的唯一入口，用户走查实锤需求）
        auth = password ? { Password: { password } } : "Keep";
      } else if (authMode === "password") {
        if (!password) { setErr("请输入密码"); setBusy(false); return; }
        auth = { Password: { password } };
      } else if (authMode === "agent") {
        auth = "Agent";
      } else {
        if (!identity) { setErr("请先「导入并确认指纹」或「生成新密钥」"); setBusy(false); return; }
        auth = { Key: { identity_id: identity.id } };
      }
      const hid = await invoke("upsert_host", {
        host: {
          id: editHost?.id ?? null, name: name.trim(), address: address.trim(),
          port: p, username: username.trim(), auth, tags: editHost?.tags ?? [],
          charset,
        },
      });
      if (!editing) { setName(""); setAddress(""); setPort("22"); setPem(""); setPassphrase(""); setIdentity(null); }
      setPassword(""); // 编辑更换密码后同样清空输入，不明文残留
      onSaved(hid, editing, connect);
    } catch (e) {
      setErr(friendlyError(e));
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
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="例：我的服务器" />
        </div>
        <div className="ah-field" style={{ flex: 2 }}>
          <label>地址（IP 或域名）</label>
          <input value={address} onChange={(e) => setAddress(e.target.value)} placeholder="例：192.168.1.10 或 server.example.com" style={{ minWidth: 0 }} />
        </div>
        <div className="ah-field" style={{ width: 76 }}>
          <label>端口</label>
          <input value={port} onChange={(e) => setPort(e.target.value)} />
        </div>
      </div>
      <div className="row" style={{ marginTop: 6, alignItems: "flex-end" }}>
        <div className="ah-field" style={{ flex: 1 }}>
          <label>用户名</label>
          <input value={username} onChange={(e) => setUsername(e.target.value)} placeholder="例：ops 或 root" />
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
      {/* T38-PV：220px 侧栏里三个字段挤一行会把下拉压到 55px（选中值只剩「密」「UT」），
          编码独占一行让选项说明全文可读 */}
      <div className="ah-field" style={{ marginTop: 6 }}>
        <label>远端编码（老设备中文乱码时选 GBK）</label>
        <select value={charset} onChange={(e) => setCharset(e.target.value as "utf-8" | "gbk")}>
          <option value="utf-8">UTF-8（默认）</option>
          <option value="gbk">GBK（中文 Windows / 老旧设备）</option>
        </select>
      </div>
      {editing ? (
        <>
          {editHost?.auth_type === "Password" ? (
            <>
              <input type="password" placeholder="更换密码——留空保持原密码" value={password}
                onChange={(e) => setPassword(e.target.value)}
                style={{ marginTop: 6 }} onKeyDown={(e) => e.key === "Enter" && submit()} />
              <div className="dim" style={{ marginTop: 4 }}>密码留空保持不变；填写即更换（用当前主密钥重新加密保存）。</div>
            </>
          ) : (
            <div className="dim" style={{ marginTop: 6 }}>认证凭据保持不变（{authLabel}）。如需更换凭据，删除该主机后重新添加。</div>
          )}
          {/* T34：信任可查证——编辑主机时出示 TOFU 信任状态与指纹原文 */}
          {editHost?.fingerprint ? (
            <div className="trust-row" style={{ marginTop: 6 }}>
              <span className="ok">✓ 主机指纹已信任（首次连接时确认）</span>
              <span className="mono fp">{editHost.fingerprint}</span>
            </div>
          ) : (
            <div className="dim" style={{ marginTop: 4 }}>主机指纹尚未建立——首次连接时会出示并要求确认。</div>
          )}
        </>
      ) : authMode === "password" ? (
        <input type="password" placeholder="密码" value={password} onChange={(e) => setPassword(e.target.value)}
          style={{ marginTop: 6 }} onKeyDown={(e) => e.key === "Enter" && submit()} />
      ) : authMode === "agent" ? (
        <div className="dim" style={{ marginTop: 6 }}>连接时由本机 ssh-agent 签名（需已 ssh-add），私钥不出 agent。</div>
      ) : identity ? (
        <>
          <div className="trust-row" style={{ marginTop: 6 }}>
            <span className="ok">✓ 密钥已加密存入凭据库（{identity.label}）</span>
            <span className="mono fp">指纹　{identity.fingerprint}</span>
          </div>
          <div className="dim" style={{ marginTop: 4 }}>保存后以此密钥登录；指纹用于核对凭据库里存的是哪把钥匙。</div>
          <button className="ghost" style={{ marginTop: 6 }} disabled={busy} onClick={() => setIdentity(null)}>
            更换密钥（重新粘贴 / 从文件导入 / 生成）
          </button>
        </>
      ) : (
        <>
          <div className="row" style={{ marginTop: 6, alignItems: "center" }}>
            <label className="file-btn">
              从文件导入…
              <input type="file" style={{ display: "none" }} accept=".pem,.key,id_ed25519,id_rsa,id_ecdsa"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (!f) return;
                  const r = new FileReader();
                  r.onload = () => setPem(String(r.result ?? ""));
                  r.readAsText(f);
                  e.target.value = ""; // 允许同一文件二次选择仍触发 onChange
                }} />
            </label>
            <button className="ghost" disabled={busy} onClick={genKey}>生成新密钥（ed25519）</button>
          </div>
          <textarea placeholder={"-----BEGIN OPENSSH PRIVATE KEY-----\n粘贴私钥内容，或点「从文件导入…」"} value={pem}
            onChange={(e) => setPem(e.target.value)} rows={4} style={{ marginTop: 6, width: "100%" }} />
          <div className="row" style={{ marginTop: 6, alignItems: "center" }}>
            <input type="password" placeholder="私钥口令（无可留空）" value={passphrase} style={{ flex: 1 }}
              onChange={(e) => setPassphrase(e.target.value)} onKeyDown={(e) => e.key === "Enter" && importPem()} />
            <button disabled={busy} onClick={importPem}>{busy ? "处理中…" : "导入并确认指纹"}</button>
          </div>
        </>
      )}
      {err && <div className="err" style={{ marginTop: 6 }}>✕ {err}</div>}
      <div className="row" style={{ marginTop: 8 }}>
        {editing ? (
          <button disabled={busy} onClick={() => submit()}>{busy ? "保存中…" : "保存修改"}</button>
        ) : (
          <>
            <button disabled={busy} onClick={() => submit()}>{busy ? "保存中…" : "保存并连接"}</button>
            <button className="ghost" disabled={busy} onClick={() => submit(false)}
              title="只保存配置不连接——批量录入主机时用">仅保存</button>
          </>
        )}
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
    invoke("ssh_config_preview", { path: null })
      .then((es) => {
        setEntries(es);
        setChecked(new Set(es.filter((e) => !e.already_imported).map((e) => e.name)));
      })
      .catch((e) => setErr(friendlyError(e)));
  }, []);

  const importChecked = async () => {
    setErr(null);
    if (checked.size === 0) { setErr("先勾选要导入的条目"); return; }
    setBusy(true);
    try {
      const outs = await invoke("ssh_config_import", {
        path: null, names: [...checked],
      });
      setOutcomes(outs);
      const okCount = outs.filter((o) => !o.error).length;
      if (okCount > 0) onDone();
    } catch (e) {
      setErr(friendlyError(e));
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
              <label key={e.name} className="sshcfg-row">
                <div className="row" style={{ alignItems: "flex-start", flexWrap: "nowrap" }}>
                  <input
                    type="checkbox"
                    style={{ width: "auto", marginTop: 2 }}
                    disabled={e.already_imported || (outcome !== undefined && !outcome.error)}
                    checked={checked.has(e.name) || (e.already_imported ?? false) || (outcome !== undefined && !outcome.error)}
                    onChange={(ev) => {
                      const next = new Set(checked);
                      if (ev.target.checked) next.add(e.name); else next.delete(e.name);
                      setChecked(next);
                    }}
                  />
                  <span style={{ flex: 1, minWidth: 0 }}>
                    <div>
                      {e.name}
                      {e.already_imported && <span className="dim"> · 已在主机列表</span>}
                      {outcome && !outcome.error && <span className="ok"> ✓ 已导入</span>}
                    </div>
                    <div className="dim mono" style={{ fontSize: 11 }}>
                      {e.username}@{e.address}:{e.port} · {e.has_identity ? "密钥" : "Agent"}
                    </div>
                    {outcome && outcome.error && <div className="err" style={{ fontSize: 11 }}>✕ {outcome.error}</div>}
                  </span>
                </div>
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
