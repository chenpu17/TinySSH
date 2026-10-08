import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import {
  invoke, MkChannel, inTauri, listen,
} from "./adapter/bridge";
import { errMsg, parseWireError } from "./adapter/errors";
import { resolveAction } from "./actions";
import type { AppAction } from "./actions";
import { createOutputFeed } from "./terminal/checkpoint";
import type { OutputFeed } from "./terminal/checkpoint";
import type {
  Host, HostMeta, RecentHost, SshConfigPreview, SshImportOutcome, SessionInfo, ApprovalItem, AuthDraft,
  PendingHostKey, PendingAuthPrompt, SessionBrief as Brief, AuditEvent,
  IdentityMeta, TakeoverReport, TransferHandle, DirEntryS, ForwardSpec, ForwardInfo,
  AttemptPhase, AttemptInfo, ErrorPayload, ConnectionEvent, CancelOutcome, SessionStateEvent,
  TransferTask,
} from "./adapter/wire";
import {
  IconSliders, IconPlus, IconMinus, IconX, IconSplit, IconStop, IconPencil, IconTrash, IconStar,
  IconChevronUp, IconChevronDown, IconChevronLeft, IconChevronRight, IconTerminal,
  IconArrowDown, IconUpload, IconDownload, IconInbox, IconClock, IconSearch, IconLoader,
  IconFolder, IconFile, IconRefresh,
} from "./icons";

// macOS 标题栏融合（T33/R12）：Overlay 红绿灯悬浮在 44px 标题区上，.titlebar 留安全区。
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

// 传输卡片是 UI 呈现态；C5（R32）起终态/进度来自任务注册表（list_transfers 查询
// + transfer-event 事件，revision 单调幂等），pending- 前缀占位卡在拿到真实
// TransferHandle 前保持本地 optimistic 呈现
type TransferCard = {
  id: string; kind: "Upload" | "Download"; name: string; remote: string; local: string;
  status: "queued" | "running" | "cancelling" | "done" | "failed" | "cancelled"; bytes?: number; total?: number | null; error?: string;
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
    // §6.4：重确认期人类可继续操作（受限的是 Agent 变更）——标签不再写「受限」误导人
    case "Reconfirming": return { text: "重确认", cls: "err" };
    default: return { text: "已断开", cls: "dim" };
  }
};

// R26（§6.4「不缓冲输入」）：传输已断/重建中的会话一律拦截键入——
// Disconnected=核心拒绝；Degraded/Reconnecting=通道死亡（写必错），不排队给未来连接
const inputBlockedState = (st: string): boolean =>
  st === "Disconnected" || st === "Degraded" || st === "Reconnecting";

// §7.4：弹窗 focus trap——打开时焦点入框、Tab/Shift+Tab 循环不出框、关闭时焦点
// 还原到触发控件（VoiceOver/纯键盘用户的回位锚点）。只用于带遮罩的模态弹窗。
function useDialogFocus(active: boolean, boxRef: RefObject<HTMLElement | null>) {
  useEffect(() => {
    if (!active) return;
    const box = boxRef.current;
    if (!box) return;
    const prev = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const focusables = () =>
      Array.from(
        box.querySelectorAll<HTMLElement>("button, [href], input, select, textarea, [tabindex]:not([tabindex='-1'])"),
      ).filter((n) => !(n instanceof HTMLButtonElement && n.disabled) && n.offsetParent !== null);
    if (!box.contains(document.activeElement)) {
      // rev-r27 中-1：确认类模态的 danger 钮在 DOM 首位——初始焦点 [data-autofocus]
      // 优先（取消钮打标），不给破坏动作预武装；无标记回落首位
      (box.querySelector<HTMLElement>("[data-autofocus]") ?? focusables()[0])?.focus();
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Tab") return;
      const list = focusables();
      if (list.length === 0) return;
      const first = list[0];
      const last = list[list.length - 1];
      const inside = document.activeElement instanceof Node && box.contains(document.activeElement);
      if (e.shiftKey && (!inside || document.activeElement === first)) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && (!inside || document.activeElement === last)) { e.preventDefault(); first.focus(); }
    };
    box.addEventListener("keydown", onKey);
    return () => {
      box.removeEventListener("keydown", onKey);
      if (prev?.isConnected) prev.focus();
    };
  }, [active, boxRef]);
}

// 后端错误 → 用户能看懂的一句话（原始错误放次要行）
const friendlyError = (e: unknown): string => {
  const pe = parseWireError(e);
  // R21 凭据基础管理：引用检查拒删列出占用主机（§267 删除前检查引用）
  if (pe.kind === "identity_in_use") {
    const names = (pe.detail as { host_names?: string[] } | undefined)?.host_names ?? [];
    return names.length
      ? `凭据仍被 ${names.length} 台主机使用（${names.join("、")}）——请先为这些主机改绑凭据或删除主机`
      : "凭据仍被主机使用——请先解除引用后再删除";
  }
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

// §185 分屏窗格宽界：双窗格各不足 360 宽即退化单窗格；恢复带 6px 迟滞防抖
const SPLIT_PANE_MIN = 360;
const SPLIT_DEGRADE_BELOW = SPLIT_PANE_MIN * 2;
const SPLIT_RECOVER_AT = SPLIT_PANE_MIN * 2 + 6;

// 显示设置（路线图⑥）：字号范围与终端配色预设。偏好存 vault（settings KV，跨进程记忆），
// 浏览器演示模式退化为 localStorage。R27（§7.1/§244）：应用外观与终端配色解耦——
// 外观三态（跟随系统/深色/浅色，新装默认跟随系统）走 ui.v2.workspace blob 的 chrome 域，
// 终端配色四预设独立存 ui.theme；Tauri 下原生窗口外观（Overlay 红绿灯、原生面板）随外观同步。
const FONT_MIN = 9;
const FONT_MAX = 28;
// §7.2：终端默认字号 14px（用户可调，范围 9–28 保留；已存偏好优先于默认）
const FONT_DEFAULT = 14;
// C8（R15）：字号迁到命名空间键；旧键 ui.font_size 由核心 V5 迁移写入新键后
// 保留不删（回退兼容），浏览器 demo 读新键缺失时回落旧键
const SETTING_FONT = "ui.v2.terminal.font_size";
const SETTING_FONT_LEGACY = "ui.font_size";
const SETTING_THEME = "ui.theme";

type Appearance = "system" | "dark" | "light";
const APPEARANCES: { id: Appearance; label: string }[] = [
  { id: "system", label: "跟随系统" },
  { id: "dark", label: "深色" },
  { id: "light", label: "浅色" },
];

type ThemePreset = {
  id: string; label: string;
  bg: string; fg: string; theme: Record<string, string>;
};
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
  const termsRef = useRef<Map<string, { term: Terminal; el: HTMLDivElement; search: SearchAddon; tag: HTMLDivElement; feed: OutputFeed | null }>>(new Map());
  const [sid, setSid] = useState<string | null>(null);
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const sessionsRef = useRef<SessionInfo[]>([]);
  useEffect(() => { sessionsRef.current = sessions; applyPanesRef.current(); }, [sessions]);
  // R26（§6.4）：自动重连进行计数（session-state 事件驱动；null=无自动重连在途）
  const [autoReconn, setAutoReconn] = useState<{ sid: string; attempt: number; max: number } | null>(null);
  // 事件应用：会话状态即时更新（免 3s 轮询盲窗）+ 重连计数推进；
  // 终态（Reconfirming/Disconnected/Connected/Closed）清除本会话在途计数
  const applyStateEvent = useCallback((ev: SessionStateEvent) => {
    setSessions((cur) => cur.map((s) => (s.id === ev.session_id ? { ...s, state: ev.state } : s)));
    setAutoReconn((cur) => {
      if (ev.state === "Reconnecting") {
        return { sid: ev.session_id, attempt: ev.attempt ?? 0, max: ev.max_attempts ?? 3 };
      }
      return cur?.sid === ev.session_id ? null : cur;
    });
  }, []);
  // 真实环境：session-state 事件（连接事件同款 transformCallback 通道）
  useEffect(() => {
    if (!inTauri) return;
    let un: (() => void) | undefined;
    listen<SessionStateEvent>("session-state", (e) => applyStateEvent(e.payload)).then((f) => (un = f));
    return () => un?.();
  }, [applyStateEvent]);
  // demo 环境：300ms 轮询 session_state_feed（无事件通道的兜底，C1 同款双路镜像）
  useEffect(() => {
    if (inTauri) return;
    const t = setInterval(async () => {
      try {
        const evs = await invoke("session_state_feed") as SessionStateEvent[];
        for (const ev of evs) applyStateEvent(ev);
      } catch { /* 下轮再试 */ }
    }, 300);
    return () => clearInterval(t);
  }, [inTauri, applyStateEvent]);
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
    // 激活标签滚入视野（键盘循环切换时不再落到视野外）。两个补滚成因：
    // ① 滚动钮显隐（tabScroll 状态）翻转会改行内布局并回钳 scrollLeft，首滚可能
    //    被截——布局稳定后补滚一次（vis-r13：900 宽直点被截标签首滚 33/79）；
    // ② 溢出可能不经 sid 变化出现（窗口缩放/主机栏开合/任务面板开合把活动标签
    //    挤出视野）——ResizeObserver 跟随容器宽度变化补滚（scrollLeft 不影响
    //    容器自身盒子，无回调环）。
    const el = tabbarRef.current;
    if (!el) return;
    const scroll = () =>
      el.querySelector(".tab-active")?.scrollIntoView({ block: "nearest", inline: "nearest" });
    scroll();
    const t = setTimeout(scroll, 220);
    let ro: ResizeObserver | undefined;
    if (typeof ResizeObserver !== "undefined") {
      ro = new ResizeObserver(() => scroll());
      ro.observe(el);
    }
    return () => {
      clearTimeout(t);
      ro?.disconnect();
    };
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
  // R25 §318 粘贴保护：多行内容 + 远端未开 bracketed paste → 预览确认后才发送；
  // 开关持久化在 workspace blob（ui.v2.terminal.paste_guard，默认开）
  const [pasteGuard, setPasteGuard] = useState(true);
  const pasteGuardRef = useRef(true);
  const [pasteConfirm, setPasteConfirm] = useState<{ sid: string; hostName: string; text: string } | null>(null);
  // §7.4 弹窗 focus trap：带遮罩模态的容器 refs（hook 挂在组件顶层，active 随开合）
  const settingsPanelRef = useRef<HTMLDivElement | null>(null);
  const closeConfirmRef = useRef<HTMLDivElement | null>(null);
  const quitConfirmRef = useRef<HTMLDivElement | null>(null);
  const delHostRef = useRef<HTMLDivElement | null>(null);
  const delIdentRef = useRef<HTMLDivElement | null>(null);
  const pasteConfirmRef = useRef<HTMLDivElement | null>(null);
  // R25 §322 分屏建立双语义：复用已有会话（菜单直选）/ 新建会话（武装标记，下一次
  // 新建会话自动落右侧副 pane）
  const [splitMenu, setSplitMenu] = useState(false);
  const splitNewPendingRef = useRef(false);
  // R25 §185 宽度退化：每窗格至少 360 宽——空间不足时只呈现焦点窗格（另一个仍在
  // 标签中），加宽自动恢复；退化时显示一次可关闭的布局提示
  const [splitDegraded, setSplitDegraded] = useState(false);
  const splitDegradedRef = useRef(false);
  const [splitHintOpen, setSplitHintOpen] = useState(false);
  // §185「显示一次」：关闭后本会话内不再重现（rev-r25 M1：与 README 主张对齐）
  const splitHintDismissedRef = useRef(false);
  // 远程 OSC 0/2 标题（T16）：按会话记录，显示在终端头部
  const [oscTitles, setOscTitles] = useState<Record<string, string>>({});
  const [hosts, setHosts] = useState<Host[]>([]);
  const [hostsLoaded, setHostsLoaded] = useState(false);
  // R20（C8 消费）：收藏/最近元数据 + 标签筛选 chip
  const [hostMeta, setHostMeta] = useState<HostMeta[]>([]);
  const [recents, setRecents] = useState<RecentHost[]>([]);
  const [tagFilter, setTagFilter] = useState<string | null>(null);
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
  // R23（C1 消费）：attempt 真值表——begin_connection 返回 attempt_id，
  // 相位经 connection-event（真实）/connection_status 轮询（demo）推进；
  // §280 语义不变：connectingIds 由 attempt 派生（按主机隔离）
  const [attempts, setAttempts] = useState<Record<string, { attemptId: string; hostId: string; phase: AttemptPhase; error: ErrorPayload | null }>>({});
  const attemptsRef = useRef(attempts);
  attemptsRef.current = attempts;
  // attempt_id → host_id（ConnectionEvent 不带 host_id，begin_connection 应答补齐）
  const attemptHostRef = useRef<Map<string, string>>(new Map());
  // 终态事件先于 waiter 到达的缓冲 + 等待者登记（waitForAttempt）
  const attemptFinalRef = useRef<Map<string, AttemptInfo>>(new Map());
  const attemptWaitersRef = useRef<Map<string, (i: AttemptInfo) => void>>(new Map());
  const TERMINAL_PHASES: AttemptPhase[] = ["Ready", "Failed", "Cancelled", "CancelCloseFailed"];
  const settleAttempt = useCallback((info: AttemptInfo) => {
    attemptHostRef.current.set(info.attempt_id, info.host_id);
    if (TERMINAL_PHASES.includes(info.phase)) {
      attemptFinalRef.current.set(info.attempt_id, info);
      setAttempts((s) => {
        if (!(info.attempt_id in s)) return s;
        const n = { ...s };
        delete n[info.attempt_id];
        return n;
      });
      const w = attemptWaitersRef.current.get(info.attempt_id);
      if (w) {
        attemptWaitersRef.current.delete(info.attempt_id);
        attemptFinalRef.current.delete(info.attempt_id);
        w(info);
      }
    } else {
      setAttempts((s) => ({ ...s, [info.attempt_id]: { attemptId: info.attempt_id, hostId: info.host_id, phase: info.phase, error: info.error } }));
    }
  }, []);
  // §280：连接中按主机隔离（派生自 attempt，真实相位驱动）
  const connectingIds = useMemo(() => new Set(Object.values(attempts).map((a) => a.hostId)), [attempts]);
  const hostAttempt = (hostId: string) => Object.values(attempts).find((a) => a.hostId === hostId) ?? null;
  // 等待 attempt 终态：事件先行则吃缓冲，否则由事件/轮询路径唤醒
  const waitForAttempt = useCallback((attemptId: string) => new Promise<AttemptInfo>((resolve) => {
    const b = attemptFinalRef.current.get(attemptId);
    if (b) {
      attemptFinalRef.current.delete(attemptId);
      resolve(b);
      return;
    }
    attemptWaitersRef.current.set(attemptId, resolve);
  }), []);
  // 相位中文（§6.2：不得猜测——只呈示核心给出的阶段）
  const phaseText = (p: AttemptPhase) =>
    p === "Connecting" ? "连接中…" : p === "TrustRequired" ? "等待指纹确认" : p === "Authenticating" ? "认证中…" : "等待验证码";
  // R21（§6.3）：焦点代际——用户导航（attach/开浮层）或离开窗口都会推进；
  // 连接完成时仅当代际未变且窗口前台才落终端焦点，后台完成只更新标签态不抢焦点。
  // R23 消费 C1 事件后在此基础上深化（attempt 级 current-selection 判定）
  const focusGenRef = useRef(0);
  // R21 设置 → 凭据基础管理：凭据列表 + 引用检查删除
  const [identities, setIdentities] = useState<IdentityMeta[]>([]);
  const [credErr, setCredErr] = useState<string | null>(null);
  const [connError, setConnError] = useState<{ title: string; detail: string } | null>(null);
  const [hostKeyQueue, setHostKeyQueue] = useState<PendingHostKey[]>([]);
  const [showAddHost, setShowAddHost] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [showAgentHelp, setShowAgentHelp] = useState(false);
  const [editingHost, setEditingHost] = useState<Host | null>(null);
  // C7（DF7.4 转手工表单）：导入面板把不可直接导入的条目预填进连接表单（upsert_host，零新命令）
  const [prefillEntry, setPrefillEntry] = useState<SshConfigPreview | null>(null);
  const [lastFailed, setLastFailed] = useState<string | null>(null);
  // AppShell（R12→R15）：主机栏开关/宽度。初值仍读 localStorage（首帧同步），
  // blob（ui.v2.workspace）加载后覆盖为事实源——见下方 C8 工作区 effect
  const [hostbarOpen, setHostbarOpen] = useState(() => {
    try { return localStorage.getItem("ui.hostbar") !== "0"; } catch { return true; }
  });
  const [hostbarWidth, setHostbarWidth] = useState(() => {
    try {
      const v = Number.parseInt(localStorage.getItem("ui.hostbar_w") ?? "", 10);
      return Number.isFinite(v) ? Math.min(300, Math.max(200, v)) : 224;
    } catch { return 224; }
  });
  const [hostQuery, setHostQuery] = useState("");
  // 右侧任务面板：一次只呈现文件 / 协作 / 转发之一（§4.3），缺省关闭
  const [rightPanel, setRightPanel] = useState<null | "files" | "collab" | "forwards">(null);
  const [toolsOpen, setToolsOpen] = useState(false);
  const [tabsMenuOpen, setTabsMenuOpen] = useState(false);
  const [winW, setWinW] = useState(() => window.innerWidth);
  // R13 统一分发：keymap 解析（actions.ts）与执行分离；ref 持有最新执行器，
  // 捕获层 effect 与 xterm 键处理器都经它走同一条路。modal/主机栏开合同步 ref。
  const dispatchRef = useRef<(a: AppAction) => boolean>(() => false);
  const modalRef = useRef(false);
  const hostbarOpenRef = useRef(hostbarOpen);
  hostbarOpenRef.current = hostbarOpen;
  const hostbarWidthRef = useRef(hostbarWidth);
  hostbarWidthRef.current = hostbarWidth;

  const refreshLists = useCallback(async () => {
    try {
      setSessions(await invoke("list_sessions"));
      setHosts(await invoke("list_hosts"));
      // R20：收藏/最近元数据（失败不阻断列表——空 meta 即全部视为未收藏）
      try { setHostMeta(await invoke("list_host_metadata")); } catch { /* 容忍 */ }
      try { setRecents(await invoke("list_recent_hosts")); } catch { /* 容忍 */ }
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

  // R20：收藏切换——本地先翻（无闪烁），后端确认；失败回读真实状态
  const toggleFavorite = useCallback(async (hostId: string, next: boolean) => {
    setHostMeta((prev) => {
      const i = prev.findIndex((m) => m.host_id === hostId);
      if (i < 0) return [...prev, { host_id: hostId, favorite: next, last_connected_at: null }];
      const cp = [...prev];
      cp[i] = { ...cp[i], favorite: next };
      return cp;
    });
    try {
      await invoke("set_host_favorite", { hostId, favorite: next });
    } catch {
      void refreshLists(); // 持久化失败：回读，UI 不停留在假状态
    }
  }, [refreshLists]);

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

  // R23（C1 消费）：connection-event 相位推进。真实环境走事件；demo 环境无事件
  // 通道，由下方轮询兜底（同一 settleAttempt 出口，语义一致）
  useEffect(() => {
    if (!inTauri) return;
    let un: (() => void) | undefined;
    listen<ConnectionEvent>("connection-event", (e) => {
      const ev = e.payload;
      settleAttempt({
        attempt_id: ev.attempt_id,
        host_id: attemptHostRef.current.get(ev.attempt_id) ?? "",
        actor: "human",
        phase: ev.phase,
        session_id: ev.session_id,
        created_at: "",
        error: ev.error,
      });
    }).then((f) => (un = f));
    return () => un?.();
  }, [settleAttempt]);
  // demo 轮询：对每个在途 attempt 拉 connection_status 至终态（300ms）
  useEffect(() => {
    if (inTauri) return;
    const t = setInterval(async () => {
      for (const a of Object.values(attemptsRef.current)) {
        try {
          const info = (await invoke("connection_status", { attemptId: a.attemptId })) as AttemptInfo;
          settleAttempt(info);
        } catch {
          /* attempt 未知（已被结算）：下轮自然消失 */
        }
      }
    }, 300);
    return () => clearInterval(t);
  }, [inTauri, settleAttempt]);

  // C10 resync 事件（R11，修复基线断链）：核心 Lagged/Resync → window 推送，
  // 按 (session_id, subscription_id) 路由到对应终端的订阅水位状态机。
  useEffect(() => {
    if (!inTauri) return;
    let un: (() => void) | undefined;
    listen<{ session_id: string; from_seq: number | null; subscription_id: string }>("resync", (e) => {
      termsRef.current.get(e.payload.session_id)?.feed?.onResyncEvent(e.payload.subscription_id);
    }).then((f) => (un = f));
    return () => un?.();
  }, []);

  // 主机指纹待决（T17）：初始拉取 + 事件推送；弹窗按到达顺序逐个出示。
  // 浏览器 demo 无事件通道，用同一命令轮询兜底（TOFU shim 的挂起建连靠它发现）。
  // 2FA 认证提示（路线图⑩）同一套拉取/推送模式。
  const [authPromptQueue, setAuthPromptQueue] = useState<PendingAuthPrompt[]>([]);
  const [authAnswer, setAuthAnswer] = useState("");
  // rev-r21 M2：完成检查读队列实时镜像（createSession 闭包捕获的是点击帧旧值）
  const hostKeyQueueRef = useRef<PendingHostKey[]>([]);
  const authPromptQueueRef = useRef<PendingAuthPrompt[]>([]);
  useEffect(() => { hostKeyQueueRef.current = hostKeyQueue; }, [hostKeyQueue]);
  useEffect(() => { authPromptQueueRef.current = authPromptQueue; }, [authPromptQueue]);
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
      if (gateDecidedRef.current.has(item.id)) return; // 近期已决，不回弹
      setHostKeyQueue((q) => (q.some((x) => x.id === item.id) ? q : [...q, item]));
    }).then((f) => (un = f));
    listen<PendingAuthPrompt>("authprompt-event", (ev) => {
      const item = ev.payload;
      if (gateDecidedRef.current.has(item.id)) return;
      setAuthPromptQueue((q) => (q.some((x) => x.id === item.id) ? q : [...q, item]));
    }).then((f) => (un2 = f));
    return () => { un?.(); un2?.(); };
  }, []);
  // R23（对账式门队列）：核心侧作废（取消/超时→hk_pending/ap_pending 移除）后 FE
  // 必须消散遮罩——权威列表驱动增删双向对账；近期已决 id 短窗内不回弹（answer
  // invoke 在途窗口的竞态）。真实环境事件管快增、本对账管删；demo 环境全靠对账。
  const gateDecidedRef = useRef<Map<string, number>>(new Map());
  const reconcileQueues = useCallback(async () => {
    try {
      const [hk, ap] = await Promise.all([
        invoke("pending_host_keys") as Promise<PendingHostKey[]>,
        invoke("pending_auth_prompts") as Promise<PendingAuthPrompt[]>,
      ]);
      const now = Date.now();
      for (const [id, ts] of gateDecidedRef.current) if (now - ts > 5000) gateDecidedRef.current.delete(id);
      setHostKeyQueue((q) => {
        const ids = new Set(hk.map((x) => x.id));
        const kept = q.filter((x) => ids.has(x.id));
        const added = hk.filter((x) => !q.some((y) => y.id === x.id) && !gateDecidedRef.current.has(x.id));
        return kept.length === q.length && added.length === 0 ? q : [...kept, ...added];
      });
      setAuthPromptQueue((q) => {
        const ids = new Set(ap.map((x) => x.id));
        const kept = q.filter((x) => ids.has(x.id));
        const added = ap.filter((x) => !q.some((y) => y.id === x.id) && !gateDecidedRef.current.has(x.id));
        return kept.length === q.length && added.length === 0 ? q : [...kept, ...added];
      });
    } catch { /* 后端不可达：下轮再对账 */ }
  }, []);
  useEffect(() => {
    const t = setInterval(() => void reconcileQueues(), inTauri ? 1000 : 400);
    void reconcileQueues();
    return () => clearInterval(t);
  }, [inTauri, reconcileQueues]);
  const answerAuthPrompt = async (id: string, answer: string) => {
    gateDecidedRef.current.set(id, Date.now());
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
    // dev 门控探针钩子（e2e/冒烟专用；release 构建不存在）：
    // 暴露 xterm 实例供注入脚本做全缓冲断言（B11 无丢字/重复）
    if (import.meta.env.DEV) {
      const w = window as unknown as { __t_terms?: Map<string, Terminal> };
      w.__t_terms ??= new Map();
      w.__t_terms.set(sessionSid, term);
    }
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
        // R25 §318：bracketed paste 语义由 xterm 按远端 DECSET 2004 自适配（不补换行
        // 不代执行）；但远端未开启时多行内容 = 换行立即执行——预览确认后才发
        const putPaste = (t: string) => {
          if (!t) return;
          // rev-r26 低-5：断线/重连期粘贴与键入同口径拦截（确认框照弹会误导——
          // 确认后字节仍被 onData 拦下）；⚠ 与 onData 告示同文
          const pst = sessionsRef.current.find((x) => x.id === sessionSid)?.state;
          if (pst && inputBlockedState(pst)) {
            const why = pst === "Disconnected" ? "会话已断开" : "网络中断（自动重连中）";
            term.write(`\r\n\x1b[33m⚠ ${why}——粘贴未发送。\x1b[0m\r\n`);
            return;
          }
          if (pasteGuardRef.current && /[\n\r]/.test(t) && !term.modes.bracketedPasteMode) {
            const h = sessionsRef.current.find((x) => x.id === sessionSid);
            setPasteConfirm({ sid: sessionSid, hostName: h?.host_name ?? sessionSid.slice(0, 8), text: t });
          } else {
            term.paste(t);
          }
        };
        (inTauri
          ? clipboard.readText().then(putPaste)
          : navigator.clipboard?.readText().then(putPaste)
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
        // ⌘F 走统一 keymap（R13 §7.2 同一分发源）——window 捕获层已处理绝大多数
        // 场景，此处兜底同源解析。模态期 resolveAction 返回 null → 落到下方兜底吞掉。
        const a = resolveAction(ev, {
          modal: modalRef.current,
          native: inTauri,
          inForm: false, // 此处理器只在 xterm textarea 焦点下触达，不属表单焦点
          hasSessions: sessionsRef.current.length > 0,
          hasActiveTab: !!sidRef.current,
        });
        if (a && dispatchRef.current(a)) {
          ev.preventDefault();
          ev.stopPropagation();
          return false;
        }
      }
      // 其余 ⌘ 快捷键（⌘R 刷新等）不得进入终端
      ev.preventDefault();
      ev.stopPropagation();
      return false;
    });
    // onData 直接归属本会话：终端实例与会话一一对应，无 stale closure。
    let deadWarned = false;
    term.onData((d) => {
      // 死会话/断线输入拦截（P2-7 + R26 §6.4）：PTY 已死（含自动重连中——通道
      // 不存在），键入只会静默进黑洞或排队给未来连接——明说，不假装
      const st = sessionsRef.current.find((x) => x.id === sessionSid)?.state;
      if (st && inputBlockedState(st)) {
        if (!deadWarned) {
          deadWarned = true;
          const why = st === "Disconnected" ? "会话已断开" : "网络中断（自动重连中）";
          term.write(`\r\n\x1b[33m⚠ ${why}——键入未发送。\x1b[0m\r\n`);
        }
        return;
      }
      deadWarned = false;
      invoke("send_keys", { sid: sessionSid, keys: d }).catch((e) => {
        term.write(`\r\n\x1b[31m✕ ${errMsg(e)}\x1b[0m\r\n`);
      });
    });
    return { term, el, search: searchAddon, tag, feed: null as OutputFeed | null };
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
        // §7.4/native 同口径：只在「终端确实拥有焦点且无模态层」时转发控制字符。
        // 模态期（确认/指纹/双因素）一律放行——⌘W 开确认后焦点仍留终端，
        // Ctrl+C 不得再杀远端前台进程（rev-r13 中-1）；焦点在别处（按钮/输入框）
        // 也不转发，与 native 侧 note_terminal 门一致。
        if (modalRef.current) return;
        const ael = document.activeElement;
        if (!(ael && ael.classList.contains("xterm-helper-textarea"))) return;
        // Option/Alt → Meta 序列（ESC 前缀）：readline 词跳转（⌥←/⌥→/⌥⌫）、
        // tmux M-键绑定。必须在捕获层拦截：⌥字母 在 WKWebView 会进文本输入系统
        // 变特殊字符（⌥b=∫），xterm 的 keydown 收不到。⌘/Ctrl+⌥ 归各自分支。
        if (ev.altKey && !ev.ctrlKey && !ev.metaKey) {
          const seq = altMetaSequence(ev.code, ev.shiftKey);
          if (!seq) return;
          ev.preventDefault();
          ev.stopPropagation();
          const s0 = sidRef.current;
          if (!s0 || (() => { const st = sessionsRef.current.find((x) => x.id === s0)?.state; return !st || inputBlockedState(st); })()) return;
          void invoke("send_keys", { sid: s0, keys: seq }).catch(() => {});
          return;
        }
        if (!ev.ctrlKey || ev.metaKey || ev.altKey) return;
        const s = sidRef.current;
        if (!s) return;
        // 死会话/断线拦截：Ctrl 控制字符不进死通道（黑洞/排队）
        const scur = sessionsRef.current.find((x) => x.id === s)?.state;
        if (!scur || inputBlockedState(scur)) {
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
      // §7.4：WebView 整窗失焦/回焦对称同步——焦点不出 document 时 focusout 不触发，
      // native 层会以失焦状态继续拦截 ⌃字母；⌘Tab 切回时 focusin 同样不触发，
      // 需按当前 DOM 焦点补报（rev-r13 低-4）
      const xtermFocused = () => {
        const t = document.activeElement;
        return !!(t instanceof HTMLElement && t.classList.contains("xterm-helper-textarea"));
      };
      const onWinBlur = () => report(false);
      const onWinFocus = () => { if (xtermFocused()) report(true); };
      window.addEventListener("blur", onWinBlur);
      window.addEventListener("focus", onWinFocus);
      document.addEventListener("focusin", onFocusIn);
      document.addEventListener("focusout", onFocusOut);
      return () => {
        window.removeEventListener("blur", onWinBlur);
        window.removeEventListener("focus", onWinFocus);
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
      timer = setTimeout(() => { checkSplitWidthRef.current(); fitTerminal(); }, 150);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [fitTerminal]);
  // 分屏建立/退出/换副窗格时也重估宽度退化态
  useEffect(() => { checkSplitWidthRef.current(); }, [splitPanes]);

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
    // 走统一分发（R13 §7.2）：原生菜单加速器与键盘快捷键同一 action 语义
    listen("menu-settings", () => { dispatchRef.current({ id: "settings" }); }).then((f) => (un = f));
    getVersion().then(setAppVersion).catch(() => {});
    return () => un?.();
  }, []);
  const fontRef = useRef(FONT_DEFAULT);
  const themeRef = useRef("dark");
  // R27：应用外观三态（跟随系统/深色/浅色）——与终端配色解耦（§7.1/§244），
  // 事实源 = ui.v2.workspace blob 的 chrome 域（V5 迁移已为老用户写入映射值）
  const [appearance, setAppearance] = useState<Appearance>("system");
  const appearanceRef = useRef<Appearance>("system");
  // C8 工作区偏好串行化链（hostbar/外观共用；声明提前供 changeAppearance 使用）
  const wsWriteChain = useRef<Promise<unknown>>(Promise.resolve());

  const applyChrome = useCallback((resolved: "dark" | "light") => {
    // CSS 变量层挂 documentElement（深浅遮罩/玻璃/阴影一起换）；Tauri 下原生窗口
    // 外观同步（Overlay 红绿灯深浅渲染）
    document.documentElement.dataset.chrome = resolved;
    if (inTauri) {
      void getCurrentWindow().setTheme(resolved === "dark" ? "dark" : "light").catch(() => {});
    }
  }, [inTauri]);

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
    // R27 解耦：终端配色只改终端实例色板，不再触碰应用 chrome（data-chrome/setTheme）
    for (const [, e] of termsRef.current) e.term.options.theme = { ...preset.theme };
  }, [persistSetting]);

  // 外观应用（不落库）：system 按 prefers-color-scheme 现场解析；Tauri 原生窗口
  // system 态 setTheme(null) 归还系统跟随
  const applyAppearance = useCallback((a: Appearance) => {
    appearanceRef.current = a;
    setAppearance(a);
    applyChrome(a === "system" ? (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light") : a);
    if (inTauri) void getCurrentWindow().setTheme(a === "system" ? null : a).catch(() => {});
  }, [applyChrome, inTauri]);

  // 外观落库（blob chrome 域，走串行化链防与 hostbar 写交错丢更新）
  const changeAppearance = useCallback((a: Appearance) => {
    applyAppearance(a);
    wsWriteChain.current = wsWriteChain.current
      .then(() => invoke("get_workspace"))
      .then((ws) => invoke("set_workspace", { ws: { ...ws, chrome: a } }))
      .catch(() => {});
  }, [applyAppearance]);

  // 跟随系统：系统外观变化实时跟随（仅 system 态挂监听）
  useEffect(() => {
    if (appearance !== "system") return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => applyChrome(mq.matches ? "dark" : "light");
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [appearance, applyChrome]);

  // 启动载入偏好（Tauri=vault，浏览器=localStorage）；早于载入创建的实例一并补齐
  useEffect(() => {
    const apply = (f: number | null, t: string | null) => {
      if (f !== null && f >= FONT_MIN && f <= FONT_MAX) changeFontSize(f);
      if (t) changeTheme(t);
    };
    // R20 登记「chrome blob 消费归 R27」：外观事实源 = blob chrome 域（demo 同契约）
    const applyChromeBlob = (ws: { chrome?: string } | null) => {
      const c = ws?.chrome;
      if (c === "system" || c === "dark" || c === "light") applyAppearance(c);
    };
    if (!inTauri) {
      const raw = Number(localStorage.getItem(SETTING_FONT) ?? localStorage.getItem(SETTING_FONT_LEGACY));
      apply(Number.isFinite(raw) && raw > 0 ? raw : null, localStorage.getItem(SETTING_THEME));
      invoke("get_workspace").then(applyChromeBlob).catch(() => {});
      return;
    }
    invoke("get_setting", { key: SETTING_FONT })
      .then((f) => (f === null ? invoke("get_setting", { key: SETTING_FONT_LEGACY }) : Promise.resolve(f)))
      .then((f) => invoke("get_setting", { key: SETTING_THEME }).then((t) => {
        apply(f === null ? null : Number(f), t);
      }))
      .catch(() => {});
    invoke("get_workspace").then(applyChromeBlob).catch(() => {});
  }, [inTauri, changeFontSize, changeTheme, applyAppearance]);

  // ---- C8 工作区偏好（R15）：blob（ui.v2.workspace）为主机栏开合/宽度的事实源 ----
  // 整取整存（DF8.1）：写前读最新 blob 再覆盖 hostbar 域，不整读缓存陈值；
  // 链式串行化（rev-r15 L2）——⌘B 与拖宽连发时按序落库，避免两次读改写交错以陈宽覆盖。
  const persistHostbarPrefs = useCallback((open: boolean, width: number) => {
    wsWriteChain.current = wsWriteChain.current
      .then(() => invoke("get_workspace"))
      .then((ws) => invoke("set_workspace", { ws: { ...ws, hostbar: { open, width } } }))
      .catch(() => {});
  }, []);
  // 首载：blob 有值 → 覆盖 localStorage 初值；blob 无值（首次）→ 一次性迁入 R12
  // 的 localStorage 暂存（旧键保留不删，回退兼容）
  useEffect(() => {
    invoke("get_workspace")
      .then((ws) => {
        // R25 §318：终端偏好域（paste_guard 缺省/未写入 = 开）
        if (ws.terminal) {
          pasteGuardRef.current = ws.terminal.paste_guard;
          setPasteGuard(ws.terminal.paste_guard);
        }
        if (ws.hostbar) {
          setHostbarOpen(ws.hostbar.open);
          setHostbarWidth(Math.min(300, Math.max(200, ws.hostbar.width)));
          return;
        }
        let open = true;
        let width = 224;
        try {
          open = localStorage.getItem("ui.hostbar") !== "0";
          const v = Number.parseInt(localStorage.getItem("ui.hostbar_w") ?? "", 10);
          if (Number.isFinite(v)) width = Math.min(300, Math.max(200, v));
        } catch { /* 隐私模式忽略 */ }
        wsWriteChain.current = wsWriteChain.current
          .then(() => invoke("set_workspace", { ws: { ...ws, hostbar: { open, width } } }))
          .catch(() => {});
      })
      .catch(() => {});
  }, []);

  // 主机栏开合与拖宽（200–300，§4.2）；grip 用指针捕获，拖动即改宽、松手落盘
  //（落盘三处：localStorage 兼容留写 + C8 blob 事实源）
  // R25 §318：粘贴保护开关——同链式串行化写 terminal 域（默认开）
  const changePasteGuard = useCallback((pg: boolean) => {
    setPasteGuard(pg);
    pasteGuardRef.current = pg;
    wsWriteChain.current = wsWriteChain.current
      .then(() => invoke("get_workspace"))
      .then((ws) => invoke("set_workspace", { ws: { ...ws, terminal: { paste_guard: pg } } }))
      .catch(() => {});
  }, []);
  const toggleHostbar = useCallback((open: boolean) => {
    setHostbarOpen(open);
    try { localStorage.setItem("ui.hostbar", open ? "1" : "0"); } catch { /* 隐私模式忽略 */ }
    persistHostbarPrefs(open, hostbarWidthRef.current);
  }, [persistHostbarPrefs]);
  const gripDrag = useRef(false);
  const gripDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    gripDrag.current = true;
  };
  const gripMove = (e: React.PointerEvent<HTMLDivElement>) => {
    // e.buttons 兜底 pointercancel/失焦后残留的拖拽态（rev-r12 LOW-4）
    if (gripDrag.current && e.buttons !== 0) setHostbarWidth(Math.min(300, Math.max(200, Math.round(e.clientX))));
  };
  const gripUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!gripDrag.current) return;
    gripDrag.current = false;
    e.currentTarget.releasePointerCapture(e.pointerId);
    // 落盘用事件坐标重算而非渲染帧闭包值（分离事件序列下前者才是最新）
    const w = Math.min(300, Math.max(200, Math.round(e.clientX)));
    setHostbarWidth(w);
    try { localStorage.setItem("ui.hostbar_w", String(w)); } catch { /* 隐私模式忽略 */ }
    persistHostbarPrefs(hostbarOpenRef.current, w);
  };
  const hostQueryN = hostQuery.trim().toLowerCase();
  // R20（§4.2 主机栏）：收藏置顶分组（有收藏→「收藏/其他主机」两组；无收藏→「全部主机」）、
  // 组内名称排序（排序稳定：查询/收藏变化不抖动——sort 在过滤后一次性应用）、标签 chip 筛选
  const metaById = new Map(hostMeta.map((m) => [m.host_id, m]));
  const isFav = (h: Host) => metaById.get(h.id)?.favorite === true;
  const byName = (a: Host, b: Host) => a.name.localeCompare(b.name, "zh", { numeric: true });
  const allTags = [...new Set(hosts.flatMap((h) => h.tags ?? []))].sort((a, b) => a.localeCompare(b, "zh"));
  // rev-r20 M1：活跃标签经编辑/删除在全部主机上消失后 chip 不再渲染，tagFilter 残留会
  // 让列表恒空且无清除入口——失效筛选自动失效
  const activeTag = tagFilter !== null && allTags.includes(tagFilter) ? tagFilter : null;
  const tagFiltered = activeTag ? hosts.filter((h) => (h.tags ?? []).includes(activeTag)) : hosts;
  // rev-r20 L1：无查询时 tagFiltered===hosts，原地 sort 会在渲染期改 state 数组——拷贝后排序
  const filteredHosts = [...(hostQueryN
    ? tagFiltered.filter((h) =>
        [h.name, h.address, h.username, ...(h.tags ?? [])].some((v) => v.toLowerCase().includes(hostQueryN)))
    : tagFiltered
  )].sort(byName);
  const favHosts = filteredHosts.filter(isFav);
  const otherHosts = filteredHosts.filter((h) => !isFav(h));
  // R21 凭据基础管理：被引用凭据集（设置面板「使用中/未绑定」标记的 UI 对账面——
  // 核心删除侧仍有引用检查兜底，两侧口径同源 identity_id）
  const referencedIdentityIds = new Set(
    hosts.flatMap((h) => (h.identity_id ? [h.identity_id] : [])),
  );
  // 窄窗完整视图断点（§4.2）：可用宽度 < 主机栏 + 560 + 面板宽 → 面板改中央完整视图。
  // 面板需求与实际面板宽一致（files=384，rev-r12 M1：此前按 320 算断点但面板钉死 384，
  // 终端实测可被压到 504 < 规范下限 560）；16px 回差双阈值防临界抖动。
  const panelNeed = rightPanel === "collab" || rightPanel === "forwards" ? 400 : 384;
  const availW = winW - (hostbarOpen ? hostbarWidth : 0);
  const [tpFull, setTpFull] = useState(false);
  useEffect(() => {
    if (rightPanel === null) { setTpFull(false); return; }
    const th = 560 + panelNeed;
    if (availW < th - 16) setTpFull(true);
    else if (availW > th + 16) setTpFull(false);
  }, [availW, panelNeed, rightPanel]);
  const toolsRef = useRef<HTMLDivElement | null>(null);
  const tabsMenuRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!toolsOpen && !tabsMenuOpen) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (toolsOpen && !toolsRef.current?.contains(t)) setToolsOpen(false);
      if (tabsMenuOpen && !tabsMenuRef.current?.contains(t)) setTabsMenuOpen(false);
    };
    window.addEventListener("mousedown", onDown, true);
    return () => window.removeEventListener("mousedown", onDown, true);
  }, [toolsOpen, tabsMenuOpen]);
  useEffect(() => {
    const on = () => setWinW(window.innerWidth);
    window.addEventListener("resize", on);
    return () => window.removeEventListener("resize", on);
  }, []);

  // Esc 关浮层（R13）：三个模态（确认/指纹/双因素）最优先——它们视觉上也最上层；
  // 其余非模态浮层按固定序（搜索→设置→菜单→表单），非严格开叠序（§7.3 未细化
  // 非模态次序，固定序与 R12 行为一致——rev-r13 低-3 如实登记）。指纹 Esc=取消
  // 连接、双因素 Esc=取消认证，与各自「取消」按钮同语义。ref 持有（闭包引用
  // 后文定义的处理器，无求值顺序问题）。
  // §7.4：关闭工具后恢复到其触发前的有效焦点——工具均从终端场景触发，恢复即
  // 聚焦活动终端（focusin 链会自动恢复 native Ctrl 上报）。
  const restoreTermFocus = () => {
    const sid = sidRef.current;
    if (!sid) return;
    termsRef.current.get(sid)?.term.focus();
  };
  const closeTopOverlayRef = useRef<() => boolean>(() => false);
  closeTopOverlayRef.current = (): boolean => {
    if (quitSummary) { setQuitSummary(null); return true; }
    const ap = authPromptQueue[0];
    if (ap) { void answerAuthPrompt(ap.id, ""); return true; }
    const hk = hostKeyQueue[0];
    if (hk) { void decideHostKey(hk, false); return true; }
    if (confirm) { setConfirm(null); return true; }
    if (pasteConfirm) { setPasteConfirm(null); return true; }
    if (splitMenu) { setSplitMenu(false); return true; }
    if (searchOpen) { closeSearch(); return true; }
    if (showSettings) { setShowSettings(false); return true; }
    if (toolsOpen) { setToolsOpen(false); return true; }
    if (tabsMenuOpen) { setTabsMenuOpen(false); return true; }
    if (showAddHost || editingHost) { setShowAddHost(false); setEditingHost(null); return true; }
    if (showImport) { setShowImport(false); return true; }
    if (showAgentHelp) { setShowAgentHelp(false); return true; }
    return false;
  };

  dispatchRef.current = (a: AppAction): boolean => {
    switch (a.id) {
      case "esc": {
        const handled = closeTopOverlayRef.current();
        if (handled) restoreTermFocus();
        return handled;
      }
      case "search":
        if (!sidRef.current) return false; // 无活动会话不劫持（保持既有语义）
        setSearchOpen(true);
        setTimeout(() => searchInputRef.current?.focus(), 0);
        return true;
      case "font-up": changeFontSize(fontRef.current + 1); return true;
      case "font-down": changeFontSize(fontRef.current - 1); return true;
      case "font-reset": changeFontSize(FONT_DEFAULT); return true;
      case "hostbar": toggleHostbar(!hostbarOpenRef.current); return true;
      case "settings":
        // 菜单加速器不经 resolveAction 的模态门（NSMenu 在 WebView 之前消费），
        // 这里补同一条 §7.3 规则：模态层打开时不叠开面板
        if (modalRef.current) return false;
        setShowSettings(true);
        return true;
      case "tab-switch": {
        const t = sessionsRef.current[a.index];
        if (t) void attachSession(t.id);
        return !!t;
      }
      case "tab-cycle": {
        const ss = sessionsRef.current;
        if (!ss.length) return false;
        const i0 = Math.max(0, ss.findIndex((x) => x.id === sidRef.current));
        const target = ss[(i0 + a.dir + ss.length) % ss.length];
        if (target) void attachSession(target.id);
        return true;
      }
      case "tab-close": {
        const cur = sidRef.current;
        if (!cur) return false;
        const curSession = sessionsRef.current.find((x) => x.id === cur);
        if (curSession) requestCloseSession(curSession);
        else void disconnectSid(cur);
        return true;
      }
      default: return false;
    }
  };

  // 唯一的 ⌘ 组合捕获层（R13）：keymap 解析 + dispatchRef 执行。模态期解析器
  // 直接返回 null（除 Esc 交浮层链）——模态层不串输入。
  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      // §7.4：表单编辑焦点判定（终端 textarea 不算——终端里 ⌘ 组合照常响应）
      const ae = document.activeElement;
      const inForm = !!(ae instanceof HTMLElement &&
        (ae.tagName === "INPUT" || ae.tagName === "TEXTAREA" || ae.tagName === "SELECT" || ae.isContentEditable) &&
        !ae.classList.contains("xterm-helper-textarea"));
      const a = resolveAction(ev, {
        modal: modalRef.current,
        native: inTauri,
        inForm,
        hasSessions: sessionsRef.current.length > 0,
        hasActiveTab: !!sidRef.current,
      });
      if (!a) return;
      if (dispatchRef.current(a)) {
        ev.preventDefault();
        ev.stopPropagation();
      }
    };
    window.addEventListener("keydown", onKey, { capture: true });
    return () => window.removeEventListener("keydown", onKey, { capture: true });
  }, []);

  // 由 splitRef/sidRef 统一同步各终端层的显示类（display 归它管，React 不渲染这些层）：
  // 单 pane：活动会话 .active；分屏：main=左半、second=右半，焦点 pane 加高亮与名牌
  // §185 退化态：只呈现焦点窗格全幅（另一个仍在标签中），类同单 pane
  const applyPanes = useCallback(() => {
    const sp = splitRef.current;
    const degraded = !!sp && splitDegradedRef.current;
    for (const [s, e] of termsRef.current) {
      e.el.classList.remove("active", "pane-left", "pane-right", "pane-focused");
      if (sp && !degraded) {
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

  // 分屏名牌跟随主机名：会话列表变化（新建/改名）后重刷，防新建会话名牌暂显 sid
  const applyPanesRef = useRef<() => void>(() => {});
  applyPanesRef.current = applyPanes;

  // §185 宽度退化：双窗格各 <360 宽即退化单窗格（恢复带 6px 迟滞防阈值抖动）
  const checkSplitWidth = useCallback(() => {
    const el = termRef.current;
    if (!el) return;
    const w = el.clientWidth;
    const sp = splitRef.current;
    const next = !!sp && (splitDegradedRef.current ? w < SPLIT_RECOVER_AT : w < SPLIT_DEGRADE_BELOW);
    if (next !== splitDegradedRef.current) {
      splitDegradedRef.current = next;
      setSplitDegraded(next);
      if (next && !splitHintDismissedRef.current) setSplitHintOpen(true);
      applyPanes();
      fitTerminal();
    }
  }, [applyPanes, fitTerminal]);
  const checkSplitWidthRef = useRef<() => void>(() => {});
  checkSplitWidthRef.current = checkSplitWidth;

  // 聚焦某会话（点标签/点 pane/⌘1-9 共用）：只挪焦点不动布局——分屏时点右 pane
  // 不会把终端内容左右对调。rev-r21 M1：应用内导航推进焦点代际（§6.3——慢建连
  // 期间切到别的会话，完成时不得抢回视图）
  const focusSession = useCallback((target: string) => {
    focusGenRef.current++;
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
    // 输出订阅（每会话仅一次，C10）：subscribe 返回 {subscription_id, checkpoint,
    // start_seq}；检查点应用前的早到帧由 feed 暂存，应用后按序消费 seq > start_seq。
    const term = made.term;
    const feed = createOutputFeed({ term, sid: sessionSid });
    made.feed = feed;
    const channel = MkChannel() as { onmessage?: (msg: unknown) => void };
    channel.onmessage = (msg) => feed.onMessage(msg);
    // 先注册通道、后调 subscribe：注册起核心即缓存 live，检查点前的早到帧不丢
    const attach = await invoke("subscribe_output", { sid: sessionSid, onEvent: channel });
    feed.begin(attach);
    subscribedRef.current.add(sessionSid);
    // 首次接入提示改为不占终端行的悬浮条（自动淡出）：写进终端流会把 shell 的
    // 光标视角带偏——后续远端输出全部接在提示语之后渲染。
    setAttachHint(true);
    window.setTimeout(() => setAttachHint(false), 6000);
  }, [makeTerm]);

  const attachSession = useCallback(async (newSid: string) => {
    // rev-r21 M1：attach 亦属用户导航（标签点击/完成落定共用入口）——推进焦点代际。
    // createSession 完成检查先于调用本函数，此处推进只影响后续完成者（并发双完成
    // 第二个自动转后台 toast，更合 §6.3）
    focusGenRef.current++;
    if (!termRef.current) return;
    await ensureSessionTerm(newSid);
    // 分屏时 attach 未上屏的会话 = 替换焦点窗格（§322：标签选择替换焦点窗格，
    // 不动另一侧；焦点在副 pane 时替换副，否则替换主）
    const sp = splitRef.current;
    if (sp && newSid !== sp.main && newSid !== sp.second) {
      splitRef.current = sidRef.current === sp.second
        ? { main: sp.main, second: newSid }
        : { main: newSid, second: sp.second };
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
    checkSplitWidthRef.current();
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
    checkSplitWidthRef.current();
    setTimeout(() => void fitTerminal(), 150);
    if (sidRef.current) focusSession(sidRef.current);
  }, [applyPanes, fitTerminal, focusSession]);

  // 关闭会话（标签 ×/⌘W/工具菜单共用，§6.4 统一「关闭会话」语义）：核心确认关闭
  // 后才 dispose；失败保留标签、画面与重试入口（§337）
  const disconnectSid = useCallback(async (id: string) => {
    try {
      await invoke("close_session", { sid: id });
    } catch (e) {
      setConnError({ title: "关闭会话失败", detail: errMsg(e) + "——标签与画面保留，可再次关闭重试" });
      return; // §6.4 关闭失败：不 dispose、不动标签
    }
    subscribedRef.current.delete(id);
    const entry = termsRef.current.get(id);
    if (entry) {
      // 显式退订（C10 主清理路径；close_session 兜底自动清理）
      entry.feed?.dispose();
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
    { kind: "closeSession"; sid: string; hostName: string } | { kind: "deleteHost"; id: string; name: string } | { kind: "deleteIdentity"; id: string; label: string } | null
  >(null);
  // R23（§6.4 关闭活动会话）：确认框展示可查证影响（转发数可查；任务/传输未知如实标注）
  const [confirmImpact, setConfirmImpact] = useState<{ forwards: number } | null>(null);
  useEffect(() => {
    if (confirm?.kind !== "closeSession") { setConfirmImpact(null); return; }
    let alive = true;
    invoke("list_forwards", { sid: confirm.sid })
      .then((fs) => { if (alive) setConfirmImpact({ forwards: (fs as ForwardInfo[]).length }); })
      .catch(() => { if (alive) setConfirmImpact(null); });
    return () => { alive = false; };
  }, [confirm]);
  // R23（§6.4 退出应用）：主窗口关闭=请求退出 → 汇总确认；「结束会话并退出」关全部会话后退出
  const [quitSummary, setQuitSummary] = useState<{ sessions: SessionInfo[]; forwards: number } | null>(null);
  // §7.4 弹窗 focus trap（调用须在全部相关 state 声明之后；hook 序恒定）
  useDialogFocus(showSettings, settingsPanelRef);
  useDialogFocus(confirm?.kind === "closeSession", closeConfirmRef);
  useDialogFocus(!!quitSummary, quitConfirmRef);
  useDialogFocus(confirm?.kind === "deleteHost", delHostRef);
  useDialogFocus(confirm?.kind === "deleteIdentity", delIdentRef);
  useDialogFocus(!!pasteConfirm, pasteConfirmRef);
  useEffect(() => {
    if (!inTauri) return;
    let un: (() => void) | undefined;
    let alive = true;
    listen("app-close-requested", () => {
      (async () => {
        try {
          const ss = (await invoke("list_sessions")) as SessionInfo[];
          let fw = 0;
          for (const s of ss) {
            try { fw += ((await invoke("list_forwards", { sid: s.id })) as ForwardInfo[]).length; } catch { /* 单会话失败不阻塞汇总 */ }
          }
          if (alive) setQuitSummary({ sessions: ss, forwards: fw });
        } catch {
          if (alive) setQuitSummary({ sessions: [], forwards: 0 });
        }
      })();
    }).then((f) => (un = f));
    return () => { alive = false; un?.(); };
  }, [inTauri]);
  const confirmQuit = async () => {
    if (!quitSummary) return;
    for (const s of quitSummary.sessions) {
      try { await invoke("close_session", { sid: s.id }); } catch { /* 尽力关闭；退出路径不受阻 */ }
    }
    try { await invoke("quit_app"); } catch { /* demo 无此命令 */ }
  };
  // 模态层信号（R13 §7.3）：确认/指纹/双因素/退出汇总任一打开即 true——⌘ 组合全吞，Esc 交给浮层链
  const modal = !!(authPromptQueue.length > 0 || hostKeyQueue.length > 0 || confirm || quitSummary || pasteConfirm || splitMenu);
  modalRef.current = modal;
  // §7.4：原生 Ctrl 拦截只在终端拥有焦点且无模态层时转发——模态打开即使终端仍持
  // DOM 焦点（弹层未 autofocus）也先停；关闭后按实际 DOM 焦点恢复上报
  useEffect(() => {
    if (!inTauri) return;
    if (modal) {
      void invoke("note_terminal", { sid: sidRef.current, focused: false }).catch(() => {});
      return;
    }
    const t = document.activeElement;
    if (t instanceof HTMLElement && t.classList.contains("xterm-helper-textarea")) {
      void invoke("note_terminal", { sid: sidRef.current, focused: true }).catch(() => {});
    }
  }, [modal, inTauri]);
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
    else if (confirm.kind === "deleteHost") await deleteHost(confirm.id);
    else {
      // R21 凭据删除：核心引用检查兜底（IdentityInUse 列占用主机），前端不自行判定
      try {
        await invoke("delete_identity", { id: confirm.id });
        setCredErr(null);
      } catch (e) {
        setCredErr(friendlyError(e));
      }
      await refreshIdentities();
    }
    setConfirm(null);
  };

  // R21 设置 → 凭据基础管理：列表加载（面板打开时）与删除后刷新共用
  const refreshIdentities = useCallback(async () => {
    try {
      setIdentities(await invoke("list_identities"));
    } catch {
      /* 面板内展示面，失败下次打开重取 */
    }
  }, []);
  useEffect(() => {
    if (showSettings) { setCredErr(null); void refreshIdentities(); } // rev-r21 L1：开沿清残留错误
  }, [showSettings, refreshIdentities]);

  // ⌘1–9 / ⌘W / ⌘⇧[] / Esc 已并入上方统一 action 分发（R13）

  // 关闭搜索：清高亮、焦点回终端
  const closeSearch = useCallback(() => {
    setSearchOpen(false);
    const addon = termsRef.current.get(sidRef.current ?? "")?.search;
    addon?.clearDecorations();
    xtermRef.current?.focus();
  }, []);

  // 旧 Esc 浮层链已并入统一 action 分发（closeTopOverlayRef，R13）。
  // 输入控件语义：无浮层时 Esc 原样透传（命令框清空、搜索框自带关闭不变）；
  // 有浮层时浮层优先消费（§7.3）——与旧「INPUT/TEXTAREA 一律不劫持」相比，
  // 浮层开着时 Esc 不再被输入框吞掉。

  // macOS 窗口标题跟随当前会话主机（T16）；浏览器 demo 同步 document.title
  useEffect(() => {
    const cur = sessions.find((s) => s.id === sid);
    const title = cur ? `${cur.host_name} — TinySSH` : "TinySSH — 人机协同 SSH 工作台";
    document.title = title;
    if (inTauri) void getCurrentWindow().setTitle(title).catch(() => {});
  }, [sid, sessions]);

  // 指纹确认决定：本地先移除（后端决定即从待决表清掉）；挂起的 create_session 随决定继续或报错
  const decideHostKey = async (item: PendingHostKey, accept: boolean) => {
    gateDecidedRef.current.set(item.id, Date.now());
    setHostKeyQueue((q) => q.filter((x) => x.id !== item.id));
    try {
      await invoke("decide_host_key", { id: item.id, accept });
    } catch {
      /* 已超时/不存在，无需处理 */
    }
  };

  // R21（§6.3）：焦点代际推进——浮层「打开沿」推进（关闭不推进：用户刚回到当前
  // 会话属已知意图，此后完成的连接仍不得从当前会话抢焦点，代际已含开浮层那跳）。
  // 门卡（TOFU/2FA）不入列——它们属于连接自身流程，置位会误伤前台「信任后落终端」
  const overlayOpen = searchOpen || showSettings || showAddHost || showImport
    || toolsOpen || tabsMenuOpen || rightPanel !== null || !!confirm;
  const overlayPrevRef = useRef(overlayOpen);
  useEffect(() => {
    if (overlayOpen && !overlayPrevRef.current) focusGenRef.current++;
    overlayPrevRef.current = overlayOpen;
  }, [overlayOpen]);
  useEffect(() => {
    const onBlur = () => { focusGenRef.current++; };
    window.addEventListener("blur", onBlur);
    return () => window.removeEventListener("blur", onBlur);
  }, []);

  // ---- 文件传输（T20；C5 R32 注册表对账）----
  const upsertTransfer = useCallback((c: TransferCard) => {
    setTransfers((cur) => {
      const i = cur.findIndex((x) => x.id === c.id);
      if (i < 0) return [c, ...cur];
      const next = [...cur];
      next[i] = c;
      return next;
    });
  }, []);

  // 注册表 → 卡片（呈现态映射；Committing/AwaitingDecision/OutcomeUnknown 未知前向
  // 状态按进行中同待——不猜测终态）
  const taskToCard = useCallback((t: TransferTask): TransferCard => ({
    id: t.id,
    kind: t.kind,
    name: pathBasename(t.kind === "Upload" ? t.source : t.dest),
    remote: t.kind === "Upload" ? t.dest : t.source,
    local: t.kind === "Upload" ? t.source : t.dest,
    status: t.status === "Succeeded" ? "done"
      : t.status === "Failed" ? "failed"
      : t.status === "Cancelled" ? "cancelled"
      : t.status === "Queued" ? "queued"
      : t.status === "Cancelling" ? "cancelling"
      : "running",
    bytes: t.bytes_done,
    total: t.total ?? null,
    error: t.error ?? undefined,
  }), []);

  // 事件帧应用（id+revision 幂等；真实 id 之外的 pending- 占位不受影响）
  const applyTransferTask = useCallback((t: TransferTask) => {
    setTransfers((cur) => {
      const i = cur.findIndex((x) => x.id === t.id);
      const card = taskToCard(t);
      if (i < 0) return [card, ...cur];
      const next = [...cur];
      next[i] = card;
      return next;
    });
  }, [taskToCard]);

  // 注册表全量对账（UI 重挂/事件漏收兜底）：pending- 占位卡保留（尚未拿到真实 id）
  const refreshTransfers = useCallback(async () => {
    try {
      const list = await invoke("list_transfers") as TransferTask[];
      setTransfers((cur) => [
        ...cur.filter((c) => c.id.startsWith("pending-")),
        ...list.map(taskToCard),
      ]);
    } catch { /* 下轮再试 */ }
  }, [taskToCard]);

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

  // ---- 远程文件浏览器（T41 FR-7；C4 R30 路径/元数据/过期响应保护）----
  // C02 请求代际：同会话内快速连续导航（输入连击回车/父目录+刷新竞速）时，
  // 晚到的旧响应不得覆盖新路径——仅按 sid 判别不够（同会话内无 sid 变化），补代际
  const sftpGenRef = useRef(0);
  const loadDir = useCallback(async (p: string): Promise<boolean> => {
    const s = sidRef.current;
    if (!s || !p.trim()) return false;
    const gen = ++sftpGenRef.current;
    setSftpLoading(true); setSftpErr(null);
    try {
      const es = await invoke("sftp_list", { sid: s, path: p.trim() });
      if (sidRef.current !== s || sftpGenRef.current !== gen) return false; // 过期结果丢弃（H1/C02）
      setSftpEntries(es);
      setSftpPath(p.trim());
      setSftpPathInput(p.trim());
      return true;
    } catch (e) {
      if (sidRef.current === s && sftpGenRef.current === gen) setSftpErr(friendlyError(e));
      return false;
    } finally {
      if (sidRef.current === s && sftpGenRef.current === gen) setSftpLoading(false);
    }
  }, []);

  // C4（§352）：手动路径导航先规范化（canonical path）再列目录——前端不猜路径，
  // 不存在/权限不足按后端可区别错误如实呈现
  const navigateTo = useCallback(async (p: string) => {
    const s = sidRef.current;
    if (!s || !p.trim()) return;
    try {
      const r = await invoke("sftp_resolve_path", { sid: s, path: p.trim() });
      if (sidRef.current !== s) return;
      await loadDir(r.canonical);
    } catch (e) {
      // rev-r30 中-1：迟到失败响应不得写入已切换会话的浏览器（与 loadDir 同纪律）
      if (sidRef.current === s) setSftpErr(friendlyError(e));
    }
  }, [loadDir]);

  // C4：符号链接点击——stat 探明目标（is_dir 为跟随语义）再决定进入/下载；
  // 悬空链接 stat 的 canonical 为 null 但 is_dir 仍可得，失败如实报错不猜
  const openSymlink = useCallback(async (e: DirEntryS) => {
    const s = sidRef.current;
    if (!s || !sftpPath) return;
    const full = `${sftpPath.replace(/\/+$/, "")}/${e.name}`;
    try {
      const st = await invoke("sftp_stat", { sid: s, path: full });
      if (sidRef.current !== s) return;
      if (st.is_dir) await loadDir(full);
      else await downloadRemote(full);
    } catch (err) {
      if (sidRef.current === s) setSftpErr(friendlyError(err));
    }
  }, [sftpPath, loadDir, downloadRemote]);

  // 切会话：浏览器清空待命
  const sftpFirstSidRef = useRef<string | null>(null);
  useEffect(() => {
    sftpFirstSidRef.current = null;
    setSftpEntries(null); setSftpErr(null);
    if (!sid) { setSftpPath(""); setSftpPathInput(""); }
    // 只随会话切换清空——简报 cwd 变化不重置用户正在浏览的位置
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sid]);
  // §348 首次打开链：本次连接可信 cwd → SFTP 初始目录（resolve null）→ 手动输入。
  // brief 到达（cwd 可用性已知）才起链；每会话一次，后续浏览位置不回跳。
  useEffect(() => {
    if (!sid || sftpFirstSidRef.current === sid || brief === null) return;
    sftpFirstSidRef.current = sid;
    void (async () => {
      if (brief.cwd) {
        const ok = await loadDir(brief.cwd);
        if (ok || sidRef.current !== sid) return;
      }
      try {
        const r = await invoke("sftp_resolve_path", { sid, path: null });
        if (sidRef.current !== sid) return;
        await loadDir(r.canonical);
      } catch (e) {
        if (sidRef.current === sid) setSftpErr(friendlyError(e));
      }
    })();
  }, [sid, brief, loadDir]);

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

  // C5（R32）传输对账（替代旧 800ms 审计猜测轮询——「完成/取消不靠审计猜测」）：
  // 真实环境 = transfer-event 即时推送 + 挂载时 list_transfers 全量对账；
  // demo = 800ms 轮询 list_transfers（模拟事件通道的双路镜像，session-state 同工艺）
  useEffect(() => {
    if (!inTauri) return;
    let un: (() => void) | undefined;
    listen<TransferTask>("transfer-event", (e) => applyTransferTask(e.payload)).then((f) => (un = f));
    void refreshTransfers();
    return () => un?.();
  }, [inTauri, applyTransferTask, refreshTransfers]);
  useEffect(() => {
    if (inTauri) return;
    const t = setInterval(() => void refreshTransfers(), 800);
    return () => clearInterval(t);
  }, [inTauri, refreshTransfers]);

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

  const createSession = async (host: Host) => {
    // §6.3：点击时刻的焦点代际——完成时代际未变且窗口前台才落终端焦点
    const gen0 = focusGenRef.current;
    setConnError(null);
    let attemptId: string | null = null;
    try {
      // R23（C1 消费）：begin_connection → attempt_id，终态经事件/轮询回回；
      // 门挂起期间主机卡可取消（§302 等待中可取消）
      const a = await invoke("begin_connection", { hostId: host.id }) as AttemptInfo;
      attemptId = a.attempt_id;
      settleAttempt(a);
      const final = await waitForAttempt(a.attempt_id);
      if (final.phase === "Ready" && final.session_id) {
        setLastFailed(null);
        await refreshLists();
        // §322「在右侧新建会话」：武装标记下新建会话自动落右侧副 pane（当前会话留
        // 左主）。用户显式要求分屏 = 主动导航——不走 gen/焦点四条件（同切标签语义）。
        // rev-r25 L1：无当前会话（prevSid null）时武装承诺无法兑现——消费掉标记，
        // 不留到更晚的连接意外触发分屏
        const prevSid = sidRef.current;
        const armSplit = splitNewPendingRef.current && !!prevSid && prevSid !== final.session_id;
        if (splitNewPendingRef.current) {
          splitNewPendingRef.current = false;
          if (armSplit) {
            await enterSplitWith(final.session_id);
            await attachSession(final.session_id);
            pushToast("ok", `已连接 ${host.name}（右侧分屏）`);
            return;
          }
        }
        // rev-r21 M2：他主机门挂起中（用户注意力在其输入框，遮罩不持 DOM 焦）完成
        // 不抢焦——否则后续验证码 keystroke 误落已完成会话的远端 shell。本主机门在
        // attempt 终态前必已闭（应答先同步 splice 队列再 invoke），不受扰。
        // R21-L6 勘误闭环：gatesBusy 改按 host_id 精确匹配（wire 已补 host_id）
        // §6.3「窗口在前台」：真实失焦（他应用激活）期间完成不切视图不抢焦，
        // 只查 document.hidden 挡不住窗口级失焦（r23a 原生实证）
        const gatesBusy = hostKeyQueueRef.current.some((x) => x.host_id !== host.id)
          || authPromptQueueRef.current.some((x) => x.host_id !== host.id);
        if (focusGenRef.current === gen0 && !document.hidden && document.hasFocus() && !gatesBusy) {
          await attachSession(final.session_id);
          pushToast("ok", `已连接 ${host.name}`);
        } else {
          // 后台完成：只更新标签态，不切视图不抢焦点（点击标签进入）
          pushToast("ok", `已连接 ${host.name}——点击标签进入`);
        }
      } else if (final.phase === "Cancelled") {
        pushToast("info", `已取消连接 ${host.name}`);
      } else if (final.phase === "CancelCloseFailed") {
        // 取消时已 Ready 且关闭失败：会话真实存在（无隐藏连接），如实告之从标签关闭
        await refreshLists();
        setConnError({
          title: `取消 ${host.name} 时会话已建立且关闭失败`,
          detail: "会话保留在标签栏——不再需要时请从标签 × 或 ⌘W 关闭",
        });
      } else {
        // Failed：失败走 conn-error 常驻横幅（可行动文案），标签不建（attempt 未过门）
        setLastFailed(host.id);
        const reason = final.error ? friendlyError({ kind: final.error.kind, message: final.error.message }) : "未知原因";
        setConnError({
          title: `连接 ${host.name}（${host.username}@${host.address}:${host.port}）失败`,
          detail: reason + "——也可在主机卡上看到失败提示，修正后重试",
        });
      }
    } catch (e) {
      setLastFailed(host.id);
      setConnError({
        title: `连接 ${host.name}（${host.username}@${host.address}:${host.port}）失败`,
        detail: friendlyError(e) + "——也可在主机卡上看到失败提示，修正后重试",
      });
    } finally {
      if (attemptId) {
        attemptWaitersRef.current.delete(attemptId);
        attemptFinalRef.current.delete(attemptId);
        attemptHostRef.current.delete(attemptId);
        setAttempts((s) => {
          if (!(attemptId !== null && attemptId in s)) return s;
          const n = { ...s };
          delete n[attemptId];
          return n;
        });
      }
    }
  };

  // §302/§6.2：等待中可取消——终态经核心串行裁决，已取消只在核心确认后呈示
  const cancelConnect = async (hostId: string) => {
    const a = hostAttempt(hostId);
    if (!a) return;
    try {
      const r = await invoke("cancel_connection", { attemptId: a.attemptId }) as CancelOutcome;
      if (r.outcome === "already_ready") {
        // 成功已提交：核心已将刚建立的会话一并关闭（契约序列 1 无 session 遗留）——
        // 对账刷新标签；不存在隐藏连接
        await refreshLists();
        pushToast("info", "取消时连接已完成——该会话已随之关闭");
      } else if (r.outcome === "cancel_close_failed") {
        // 会话保留（关闭失败=恢复入口）：如实告之从标签关闭
        await refreshLists();
        setConnError({
          title: "取消时会话已建立且关闭失败",
          detail: "会话保留在标签栏——不再需要时请从标签 × 或 ⌘W 再次关闭",
        });
      }
      // cancelled / not_found：终态事件（或 demo 轮询）负责结算卡片与门
    } catch (e) {
      pushToast("err", friendlyError(e));
    }
  };

  // 断线会话一键重连：核心重建传输 + 重启泵 + 重注入；UI 订阅不变，输出自动恢复
  const [reconnecting, setReconnecting] = useState<string | null>(null);
  // R26（§6.4「可停止重试」）：核心旗标 ≤250ms 生效落 Disconnected；失败如实提示
  const stopRetry = async (s: SessionInfo) => {
    try {
      await invoke("stop_auto_reconnect", { sid: s.id });
      pushToast("info", `已停止 ${s.host_name} 的自动重连`);
    } catch (e) { pushToast("err", friendlyError(e)); }
  };
  const reconnectSession = async (s: SessionInfo) => {
    const gen0 = focusGenRef.current; // §6.3：重连完成不抢走用户期间转移的焦点
    setReconnecting(s.id);
    try {
      await invoke("reconnect_session", { sid: s.id });
      await refreshLists();
      const gatesBusy = hostKeyQueueRef.current.some((x) => x.host_id !== s.host_id)
        || authPromptQueueRef.current.some((x) => x.host_id !== s.host_id);
      if (focusGenRef.current === gen0 && !document.hidden && document.hasFocus() && !gatesBusy) {
        await attachSession(s.id);
        pushToast("ok", `已重连 ${s.host_name}`);
      } else {
        pushToast("ok", `已重连 ${s.host_name}——点击标签进入`);
      }
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

  const currentHost = current ? hosts.find((h) => h.id === current.host_id) : undefined;
  const sbLeft = current
    ? `${currentHost?.address === "local" ? "本地" : "SSH"} · ${currentHost?.charset === "gbk" ? "GBK" : "UTF-8"}`
    : "未连接";
  const runningTransfers = transfers.filter((t) => t.status === "running").length;

  return (
    <div className="app-shell">
      {/* 标题区 44（§4.2）：整行拖拽区；红绿灯安全区由 .native-chrome 留白；可交互控件不在拖拽链上 */}
      <header className="titlebar" data-tauri-drag-region>
        <div className="tb-left">
          <span className="app-title" data-tauri-drag-region>TinySSH</span>
          {hostbarOpen && (
            <button className="ghost icon-btn" title="收起主机栏（⌘B）" aria-label="收起主机栏"
              onClick={() => toggleHostbar(false)}>
              <IconChevronLeft size={15} />
            </button>
          )}
          {pendingCount > 0 && (
            <button className={"collab-badge" + (rightPanel === "collab" ? " ts-open" : "")}
              title={`有 ${pendingCount} 个待审批请求——跨会话操作请逐条核对目标主机`}
              onClick={() => setRightPanel(rightPanel === "collab" ? null : "collab")}>
              协作 · {pendingCount} 待审批
            </button>
          )}
        </div>
        <span style={{ flex: 1 }} data-tauri-drag-region />
        <div className="tb-right">
          {sid && (
            <span className={"ctl-badge " + ownerCls}
              title="「Agent 控制中」= Agent 可发起命令、经你审批执行；「我控制中」= 终端归你，Agent 冻结"
            ><span className="ctl-dot" />{owner === "Human" ? "我控制中" : hasAgents ? "Agent 控制中" : "手动控制"}</span>
          )}
        </div>
      </header>
      <div className="workspace">
        {hostbarOpen && (
          <>
            {/* 主机栏 224（可拖 200–300）：主机负责连接资源；会话只看标签（§3 信息结构） */}
            <aside className="hostbar" style={{ width: hostbarWidth }} aria-label="主机栏">
              <div className="hb-top">
                <div className="hb-search">
                  <IconSearch size={13} />
                  <input placeholder="搜索主机" aria-label="搜索主机（名称 / 地址 / 用户 / 标签）"
                    value={hostQuery} onChange={(e) => setHostQuery(e.target.value)} />
                </div>
                <button className="ghost icon-btn" title={showImport ? "收起导入" : "导入 ~/.ssh/config"} aria-label={showImport ? "收起导入" : "导入 ~/.ssh/config"}
                  onClick={() => { setShowImport(!showImport); setShowAddHost(false); }}>
                  {showImport ? <IconChevronUp size={14} /> : <IconUpload size={14} />}
                </button>
                <button className="ghost icon-btn" title={showAddHost ? "收起表单" : "添加主机"} aria-label={showAddHost ? "收起表单" : "添加主机"}
                  onClick={() => { setShowAddHost(!showAddHost); setShowImport(false); setEditingHost(null); setPrefillEntry(null); }}>
                  {showAddHost ? <IconChevronUp size={14} /> : <IconPlus size={14} />}
                </button>
              </div>
              {allTags.length > 0 && (
                <div className="hb-tags" role="group" aria-label="按标签筛选">
                  {allTags.map((t) => (
                    <button key={t} className={"hb-tag" + (activeTag === t ? " on" : "")} aria-pressed={activeTag === t}
                      title={activeTag === t ? `取消筛选「${t}」` : `只看带「${t}」标签的主机`}
                      onClick={() => setTagFilter(activeTag === t ? null : t)}>{t}</button>
                  ))}
                </div>
              )}
              <div className="hb-scroll">
          {showImport && (
            <SshConfigImportPanel
              onDone={refreshLists}
              onClose={() => setShowImport(false)}
              onManual={(e) => { setPrefillEntry(e); setEditingHost(null); setShowImport(false); setShowAddHost(true); }}
            />
          )}
          {showAddHost && (
            <AddHostForm
              editHost={editingHost}
              prefill={prefillEntry}
              onSaved={async (hid, wasEdit, connect = true) => {
                setShowAddHost(false);
                setEditingHost(null);
                setPrefillEntry(null);
                await refreshLists();
                if (wasEdit || !connect) return; // 编辑只改配置；仅保存不自动建连
                const h = hosts.find((x) => x.id === hid);
                // list_hosts 刚刷新过，直接用返回值兜底
                const target = h ?? (await invoke("list_hosts")).find((x) => x.id === hid);
                if (target) createSession(target);
              }}
            />
          )}
          {(() => {
            // R20（§4.2）：卡片渲染收敛为局部函数——收藏分组（收藏/其他主机/全部主机）
            // 复用同一卡片形态；组内名称序已在 filteredHosts 派生时排序
            const renderHostCard = (h: Host) => {
              // 该主机的现有会话（五人走查·林姐：误点已连主机静默开重复会话）。
              // 在线徽章 + 点击切到最近会话；显式另开走右侧「连接」钮
              const mine = sessions.filter((s) => s.host_id === h.id);
              const live = mine.filter((s) => s.state !== "Disconnected");
              const anyOnline = mine.some((s) => s.state === "Connected");
              // 最近会话按时间戳比较：chrono 秒级无小数、纳秒级带小数位，
              // 字符串字典序在「同一秒内混合精度」时会错序（'Z' > '.'）
              const latest = [...live].sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))[0];
              const fav = metaById.get(h.id)?.favorite === true;
              const activate = () => {
                if (connectingIds.has(h.id)) return; // §280：仅本主机连接中忽略，其他主机不受扰
                if (latest) { void attachSession(latest.id); return; }
                createSession(h);
              };
              return (
              <div className="host-card" key={h.id}
                tabIndex={0}
                role="button"
                aria-label={`主机 ${h.name}（${h.username}@${h.address}:${h.port}）${latest ? "——Enter 切换到最近会话" : "——Enter 连接"}`}
                onKeyDown={(e) => {
                  // rev-r20 H1：冒泡自内层按钮（星标/编辑/删除）的 Enter/Space 不劫持——
                  // 否则 preventDefault 吞掉按钮自身激活再误触 activate()
                  if (e.target !== e.currentTarget) return;
                  if (e.key === "Enter" || e.key === " ") { e.preventDefault(); activate(); }
                }}
                title={`${h.username}@${h.address}:${h.port}\n指纹：${h.fingerprint ?? "首次连接时确认"}\n编码：${h.charset === "gbk" ? "GBK（中文 Windows / 老旧设备）" : "UTF-8"}`}>
                {/* R8：高频动作（连接）拿主区大点击目标；编辑/删除在右侧 hover 操作组 */}
                <div className="host-card-main" style={{ cursor: connectingIds.has(h.id) ? "default" : "pointer" }}
                  title={latest
                    ? `该主机已有会话——点击切换到最近会话，右侧「连接」可另开新会话\n${h.username}@${h.address}:${h.port}\n指纹：${h.fingerprint ?? "首次连接时确认"}\n编码：${h.charset === "gbk" ? "GBK（中文 Windows / 老设备）" : "UTF-8"}`
                    : undefined}
                  onClick={activate}>
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
                  {(h.tags ?? []).length > 0 && (
                    <div className="host-tags">
                      {(h.tags ?? []).slice(0, 2).map((t) => <span key={t} className="host-tag">{t}</span>)}
                      {(h.tags ?? []).length > 2 && <span className="host-tag more">+{(h.tags ?? []).length - 2}</span>}
                    </div>
                  )}
                  {lastFailed === h.id && !connectingIds.has(h.id) && (
                    <div className="err host-fail">✕ 上次连接失败——检查地址与凭据后重试</div>
                  )}
                </div>
                  <div className="host-card-side">
                    <div className="host-ops">
                      <button className={"ghost fav-btn" + (fav ? " on" : "")} aria-pressed={fav}
                        title={fav ? "取消收藏（移出「收藏」分组）" : "收藏（置顶「收藏」分组）"}
                        onClick={(e) => { e.stopPropagation(); void toggleFavorite(h.id, !fav); }}><IconStar size={13} /></button>
                      <button className="ghost" title="编辑主机（名称/地址/端口/用户名/编码/标签，凭据保持不变）"
                        onClick={() => { setEditingHost(h); setShowImport(false); setPrefillEntry(null); setShowAddHost(true); }}><IconPencil size={13} /></button>
                      <button className="ghost host-del" title="删除主机"
                        onClick={() => setConfirm({ kind: "deleteHost", id: h.id, name: h.name })}><IconTrash size={13} /></button>
                    </div>
                    {/* R23（§302 等待中可取消）：attempt 在途显示核心相位 + 取消入口；
                        取消终态由核心串行裁决后呈示（cancelConnect 不自行改状态） */}
                    <div className="row" style={{ flexWrap: "nowrap", gap: 4 }}>
                      <button className="host-connect-btn" disabled={connectingIds.has(h.id)}
                        title="连接（新建会话）——其他主机的连接不受影响"
                        onClick={() => createSession(h)}>
                        {(() => {
                          const a = hostAttempt(h.id);
                          return a
                            ? <><IconLoader size={11} className="spin" /> {phaseText(a.phase)}</>
                            : "连接";
                        })()}
                      </button>
                      {hostAttempt(h.id) && (
                        <button className="ghost" style={{ width: "auto", flexShrink: 0 }}
                          title="取消本次连接（终态由核心裁决：已取消/已完成可见）"
                          onClick={(e) => { e.stopPropagation(); void cancelConnect(h.id); }}>取消</button>
                      )}
                    </div>
                  </div>
              </div>
              );
            };
            const skeletons = !hostsLoaded ? (<><div className="skeleton" /><div className="skeleton" /></>) : null;
            const emptyAll = hostsLoaded && hosts.length === 0 && (
              <div className="dim">还没有主机。点上方「＋」填入地址和密码即可连接。</div>
            );
            const noMatch = hostsLoaded && hosts.length > 0 && filteredHosts.length === 0 && (
              <>
                <div className="dim">无匹配主机——可清除搜索/标签筛选，或直接添加：</div>
                <button className="ghost" style={{ marginTop: 6 }}
                  onClick={() => { setShowImport(false); setEditingHost(null); setPrefillEntry(null); setShowAddHost(true); }}>
                  <IconPlus size={12} /> 添加主机
                </button>
              </>
            );
            const firstSection = (title: string, cards: Host[]) => (
              <div className="section">
                <h4>{title}</h4>
                {skeletons}
                {cards.map(renderHostCard)}
                {emptyAll}
                {noMatch}
              </div>
            );
            // 契约 §4.2：有收藏 → 「收藏」+「其他主机」两组；无收藏 → 「全部主机」单组。
            // 骨架/空态只随首组渲染一次；rev-r20 L2：全部可见主机均收藏时不渲染空「其他主机」节头
            if (favHosts.length > 0) {
              return (
                <>
                  {firstSection("收藏", favHosts)}
                  {otherHosts.length > 0 && (
                    <div className="section">
                      <h4>其他主机</h4>
                      {otherHosts.map(renderHostCard)}
                    </div>
                  )}
                </>
              );
            }
            return firstSection("全部主机", otherHosts);
          })()}
        </div>
        <div className="hb-bottom">
          <button className="hb-settings" title="显示设置（字号 / 主题）" aria-label="显示设置"
            onClick={() => dispatchRef.current({ id: "settings" })}>
            <IconSliders size={14} />设置
          </button>
        </div>
            </aside>
            <div className="hb-grip" role="separator" aria-orientation="vertical"
              aria-label="拖动调整主机栏宽度（200–300 px）" title="拖动调整宽度（200–300 px）"
              onPointerDown={gripDown} onPointerMove={gripMove} onPointerUp={gripUp}
              onPointerCancel={() => { gripDrag.current = false; }} />
          </>
        )}
        {!hostbarOpen && (
          <button className="ghost icon-btn hb-expand" title="展开主机栏（⌘B）" aria-label="展开主机栏"
            onClick={() => toggleHostbar(true)}>
            <IconChevronRight size={15} />
          </button>
        )}
        <main className="main">
        {/* 双接管按钮语义说明（PV R3：3/6 参与者只能靠猜）：Agent 持有控制权时常显一行解释
            精致化 §5.2：状态/说明类信息走 Notice Bar，不与面包屑混排 */}
        {sid && hasAgents && owner === "Agent" && (
          <div className="notice-bar info">
            接管＝冻结 Agent、待审批作废，正在跑的命令不中断 · 接管并停止任务＝再尝试停止跑着的命令（结果逐条显示）
          </div>
        )}
        {/* 重确认：§6.4 原文「已重连；旧现场待核实」——人类可继续操作，受限的是
            Agent 变更（有协作在场时点名「Agent 暂停」）；核实完成自动恢复 */}
        {current?.state === "Reconfirming" && (
          <div className="notice-bar warn">
            ⓘ 已重连；旧现场待核实——你可以继续操作{owner === "Agent" ? "；Agent 已暂停（普通变更仍受限）" : ""}。
          </div>
        )}
        {/* R26（§6.4）：网络断线自动重连——显示实际重试次数 + 可停止；
            Disconnected=顶部短状态条提供重连（dead-overlay 同动作双入口）。
            rev-r26 中-1：手动重连（reconnecting）期核心发同形 Reconnecting 事件，
            但手动循环不读停止旗标——此时横幅独立呈示「手动重连中」且无停止钮，
            不冒用自动语义（停止钮只对真自动重连在位） */}
        {current && (current.state === "Degraded" || current.state === "Reconnecting") && (
          reconnecting === current.id ? (
            <div className="notice-bar err">
              <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                ⏳ 手动重连中——{current.host_name}（最多 3 次尝试）
              </span>
            </div>
          ) : (
            <div className="notice-bar err">
              <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                ⛔ 网络中断——自动重连中{autoReconn?.sid === current.id && autoReconn.attempt > 0 ? `（第 ${autoReconn.attempt}/${autoReconn.max} 次）` : "…"}
              </span>
              <button className="danger" onClick={() => void stopRetry(current)}>停止重试</button>
            </div>
          )
        )}
        {current?.state === "Disconnected" && (
          <div className="notice-bar err">
            <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              ⛔ 会话已断开——画面为断开前状态，键入已拦截
            </span>
            <button disabled={reconnecting !== null} onClick={() => void reconnectSession(current)}>
              {reconnecting === current.id ? "重连中…" : "重连恢复"}
            </button>
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
          <div className="tabbar" ref={tabbarRef} onScroll={measureTabbar} role="tablist" aria-label="会话标签">
            {sessions.map((s, i) => {
              const st = stateLabel(s.state);
              const inSplit = splitPanes?.main === s.id || splitPanes?.second === s.id;
              return (
                <div
                  key={s.id}
                  className={"tab" + (sid === s.id ? " tab-active" : "") + (inSplit ? " tab-pane" : "")}
                  title={`${s.host_name} · ${st.text}${i < 9 ? ` · ⌘${i + 1}` : ""}`}
                  aria-label={`${s.host_name}，${st.text}${inSplit ? "，在分屏中" : ""}${i < 9 ? `，⌘${i + 1}` : ""}`}
                  tabIndex={0}
                  role="tab"
                  aria-selected={sid === s.id}
                  onKeyDown={(e) => {
                    // R20-H1 同款守卫（R27 tab-x/tab-split 键盘化后必须）：子按钮上的
                    // Enter/Space 冒泡到标签处理器会 preventDefault 吞掉按钮默认点击、
                    // 误触 attachSession——只有标签本体直接按键才激活
                    if (e.target !== e.currentTarget) return;
                    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); void attachSession(s.id); }
                  }}
                  onClick={() => attachSession(s.id)}
                >
                  <span className={"tab-dot " + st.cls} aria-hidden="true" />
                  <span className="tab-label">{s.host_name}</span>
                  {/* R27（§7.4）：关闭/分屏改真按钮——键盘 Tab 可达、focus-visible 可见、
                      可访问名称不依赖 hover；命中区 ≥28 由 CSS ::after 透明扩展 */}
                  <button
                    type="button"
                    className="tab-split"
                    title={splitPanes ? "放到右侧分屏" : s.id === sid ? "已在主视图" : "与当前会话分屏"}
                    aria-label={splitPanes ? `把 ${s.host_name} 放到右侧分屏` : s.id === sid ? `${s.host_name} 已在主视图` : `与 ${s.host_name} 分屏`}
                    onClick={(e) => { e.stopPropagation(); void enterSplitWith(s.id); }}
                  ><IconSplit size={12} /></button>
                  <button
                    type="button"
                    className="tab-x"
                    title="关闭会话（⌘W，活动会话先确认影响）"
                    aria-label={`关闭会话 ${s.host_name}`}
                    onClick={(e) => { e.stopPropagation(); requestCloseSession(s); }}
                  ><IconX size={11} /></button>
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
          <div className="st-tools" ref={tabsMenuRef}>
            <button className="ghost tab-all" title="所有标签" aria-haspopup="menu" aria-expanded={tabsMenuOpen}
              onClick={() => setTabsMenuOpen(!tabsMenuOpen)}>标签列表</button>
            {tabsMenuOpen && (
              <div className="tools-menu tm-right" role="menu">
                {sessions.length === 0 && <div className="dim" style={{ padding: "6px 10px" }}>暂无会话</div>}
                {sessions.map((s) => {
                  const st = stateLabel(s.state);
                  return (
                    <div className={"tm-row" + (sid === s.id ? " tm-active" : "")} key={s.id}>
                      <button className="tm-main" role="menuitem"
                        onClick={() => { setTabsMenuOpen(false); void attachSession(s.id); }}>
                        <span className={"tab-dot " + st.cls} />
                        <span className="tab-label">{s.host_name}</span>
                        <span className={"mono " + st.cls} style={{ fontSize: 10, marginLeft: "auto" }}>{st.text}</span>
                      </button>
                      {s.state === "Disconnected" && (
                        <button className="tm-act" title="重连该会话" disabled={reconnecting !== null}
                          onClick={() => { reconnectSession(s); }}>重连</button>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
          <button className="ghost" title="新建连接（打开主机栏「添加主机」表单，再点收起）" aria-label="新建连接" onClick={() => { if (!hostbarOpen) toggleHostbar(true); setShowAddHost(!showAddHost); setShowImport(false); }}><IconPlus size={14} /></button>
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
            <div className="confirm-dialog" ref={closeConfirmRef} role="dialog" aria-modal="true" aria-labelledby="dlg-close-title" onClick={(e) => e.stopPropagation()}>
              {/* R23 §6.4/§342：入口统一命名「关闭会话」；影响行只说可查证的
                  （转发数），任务/传输状态未知时明确未知，不声称空闲 */}
              <div className="hk-title" id="dlg-close-title">关闭与 {confirm.hostName} 的会话？</div>
              <div>终端现场不可恢复——重连会是全新现场（记录保留）。</div>
              <div className="dim" style={{ marginTop: 6, fontSize: 12 }}>
                · 将受影响的转发：{confirmImpact ? (confirmImpact.forwards > 0 ? `${confirmImpact.forwards} 条（随会话关闭）` : "无") : "状态未知（查询失败）"}
                <br />· 正在运行的任务/传输：状态未知——如有重要作业请先确认
              </div>
              <div className="hk-actions">
                <button className="danger" onClick={confirmAction}>关闭会话</button>
                <button className="ghost" data-autofocus onClick={() => setConfirm(null)}>取消</button>
              </div>
            </div>
          </div>
        )}
        {quitSummary && (
          <div className="confirm-mask">
            <div className="confirm-dialog" ref={quitConfirmRef} role="dialog" aria-modal="true" aria-labelledby="dlg-quit-title" onClick={(e) => e.stopPropagation()}>
              <div className="hk-title" id="dlg-quit-title">退出 TinySSH？</div>
              <div>
                活动会话 {quitSummary.sessions.length} 个
                {quitSummary.sessions.length > 0 && (
                  <>（{quitSummary.sessions.map((s) => s.host_name).join("、")}）</>
                )}
                ，转发 {quitSummary.forwards} 条。
              </div>
              <div className="dim" style={{ marginTop: 6, fontSize: 12 }}>
                正在运行的命令与传输会被终止；传输处于提交中/结果待核实时不代表已全部取消。
                下次启动不恢复会话，需手动重连。
              </div>
              <div className="hk-actions">
                <button className="danger" onClick={() => void confirmQuit()}>结束会话并退出</button>
                <button className="ghost" data-autofocus onClick={() => setQuitSummary(null)}>取消</button>
              </div>
            </div>
          </div>
        )}
        {confirm?.kind === "deleteHost" && (
          <div className="confirm-mask" onClick={() => setConfirm(null)}>
            <div className="confirm-dialog" ref={delHostRef} role="dialog" aria-modal="true" aria-labelledby="dlg-delhost-title" onClick={(e) => e.stopPropagation()}>
              <div className="hk-title" id="dlg-delhost-title">删除主机 {confirm.name}？</div>
              <div>凭据与指纹记录一并移除，之后无法再从它新建连接；已建立的会话不受影响。</div>
              <div className="hk-actions">
                <button className="danger" onClick={confirmAction}>删除</button>
                <button className="ghost" data-autofocus onClick={() => setConfirm(null)}>取消</button>
              </div>
            </div>
          </div>
        )}
        {confirm?.kind === "deleteIdentity" && (
          <div className="confirm-mask" onClick={() => setConfirm(null)}>
            <div className="confirm-dialog" ref={delIdentRef} role="dialog" aria-modal="true" aria-labelledby="dlg-delident-title" onClick={(e) => e.stopPropagation()}>
              <div className="hk-title" id="dlg-delident-title">删除凭据 {confirm.label}？</div>
              <div>仍被主机引用的凭据会被拒绝并列出主机；已保存的凭据独立存在，删除前请确认没有主机依赖它。</div>
              <div className="hk-actions">
                <button className="danger" onClick={confirmAction}>删除凭据</button>
                <button className="ghost" data-autofocus onClick={() => setConfirm(null)}>取消</button>
              </div>
            </div>
          </div>
        )}
        {/* 会话工具栏 40（§4.1）：活动会话才出现——欢迎页不放失效的终端工具 */}
        {current && (
          <div className="session-toolbar">
            <div className="st-ident">
              <span className="st-title mono" title={`${current.host_name} · ${sid!.slice(0, 12)}`}>
                {current.host_name}
                {oscTitles[sid!] ? ` · 「${oscTitles[sid!]}」` : ""}
              </span>
              <span className={"mono st-state " + stateLabel(current.state).cls}>{stateLabel(current.state).text}</span>
            </div>
            <span style={{ flex: 1 }} />
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
                className={"ghost icon-btn" + (searchOpen ? " ts-open" : "")}
                title="搜索终端内容（⌘F）"
                aria-label="搜索终端内容"
                onClick={() => dispatchRef.current({ id: "search" })}
              ><IconSearch size={15} /></button>
            )}
            <button
              className={"ghost icon-btn" + (splitMenu ? " ts-open" : "")}
              title={splitPanes ? "退出分屏（会话保留不断开）" : "分屏：在右侧显示已有会话，或在右侧新建会话"}
              aria-haspopup={splitPanes ? undefined : "menu"}
              aria-expanded={splitPanes ? undefined : splitMenu}
              aria-pressed={!!splitPanes}
              onClick={() => {
                if (splitPanes) { void exitSplit(); return; }
                setSplitMenu((v) => !v);
              }}
            ><IconSplit size={15} /></button>
            <button
              className={"st-file" + (rightPanel === "files" ? " ts-open" : "")}
              aria-pressed={rightPanel === "files"}
              title="文件：远程目录浏览与传输"
              onClick={() => setRightPanel(rightPanel === "files" ? null : "files")}
            ><IconFolder size={14} />文件</button>
            <div className="st-tools" ref={toolsRef}>
              <button className="ghost" aria-haspopup="menu" aria-expanded={toolsOpen}
                onClick={() => setToolsOpen(!toolsOpen)}>工具<IconChevronDown size={12} /></button>
              {toolsOpen && (
                <div className="tools-menu" role="menu">
                  <button role="menuitem" onClick={() => { setRightPanel("collab"); setToolsOpen(false); }}>审批与记录</button>
                  <button role="menuitem" onClick={() => { setRightPanel("forwards"); setToolsOpen(false); }}>端口转发</button>
                  <button role="menuitem" className="tm-danger" onClick={() => { setToolsOpen(false); requestCloseSession(current); }}>关闭会话…</button>
                </div>
              )}
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
        <div className="content">
        <div className="term-col">
        <div className="term-wrap">
          {!sid && (
            <div className="welcome">
              <div className="welcome-box">
                <div className="welcome-mark"><IconTerminal size={26} /></div>
                <div className="welcome-title">TinySSH<span className="welcome-sub">人机协同 SSH 工作台</span></div>
                <div className="welcome-steps">
                  <div><span className="ws-k">连接</span>主机栏「＋」填入地址和密码（或粘贴私钥），保存后自动连接</div>
                  <div><span className="ws-k">操作</span>点击终端区直接打字：Ctrl+C 中断、↑↓ 历史、Tab 补全、⌘C/⌘V 复制粘贴</div>
                  <div><span className="ws-k">多会话</span>一屏一签，点标签切换、分屏对照，各自的滚动历史和 vim 界面都会保留</div>
                  <div><span className="ws-k">传输</span>拖文件进终端即上传到当前目录；下方命令框可逐条执行，焦点自动回终端</div>
                </div>
                <div className="welcome-actions">
                  <button onClick={() => { if (!hostbarOpen) toggleHostbar(true); setShowAddHost(true); setShowImport(false); setEditingHost(null); setPrefillEntry(null); }}><IconPlus size={13} /> 添加主机</button>
                  <button className="ghost" onClick={() => { if (!hostbarOpen) toggleHostbar(true); setShowImport(true); setShowAddHost(false); }}>导入 ~/.ssh/config</button>
                  {hosts.some((h) => h.id === "local") && (
                    <button className="ghost" onClick={() => {
                      const lh = hosts.find((h) => h.id === "local");
                      if (lh) void createSession(lh);
                    }}><IconTerminal size={13} /> 打开本地终端</button>
                  )}
                </div>
                {/* R20（§259）：已有主机但无会话 → 最近连接（后端派生、排除 local、上限 5）。
                    仅在欢迎页呈现（§261：避免每次连接使侧栏重排）；点击即建连。
                    rev-r20 L5：行全部失效（主机刚删的毫秒窗）时不渲染空标题块 */}
                {!sid && sessions.length === 0 && recents.length > 0 && (() => {
                  const rows = recents.slice(0, 5).map((r) => {
                    const rh = hosts.find((x) => x.id === r.host_id);
                    if (!rh) return null;
                    return (
                      <button key={r.host_id} className="wr-row"
                        title={`连接 ${r.host_name}（${rh.username}@${rh.address}）`}
                        onClick={() => void createSession(rh)}>
                        <span className="wr-name">{r.host_name}</span>
                        <span className="wr-addr mono">{rh.username}@{rh.address}</span>
                        <span className="wr-go">连接</span>
                      </button>
                    );
                  }).filter(Boolean);
                  if (rows.length === 0) return null;
                  return (
                    <div className="welcome-recents" aria-label="最近连接">
                      <div className="wr-title">最近连接</div>
                      {rows}
                    </div>
                  );
                })()}
                <div className="dim welcome-note">
                  {sessions.length > 0
                    ? `已有 ${sessions.length} 个会话未接入终端——点击上方标签或「标签列表」继续。`
                    : "暂无会话——从主机栏连接主机开始，或导入 ~/.ssh/config。"}
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
                  <span className="dim" style={{ fontSize: 11 }}>重连后进入重确认——旧现场待核实，可继续操作</span>
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
              <button className="ghost" title="上一个（⇧⏎）" aria-label="上一个搜索结果" onClick={() => searchQuery && termsRef.current.get(sidRef.current ?? "")?.search.findPrevious(searchQuery, SEARCH_OPTS)}><IconChevronUp size={13} /></button>
              <button className="ghost" title="下一个（⏎）" aria-label="下一个搜索结果" onClick={() => searchQuery && termsRef.current.get(sidRef.current ?? "")?.search.findNext(searchQuery, SEARCH_OPTS)}><IconChevronDown size={13} /></button>
              <button className="ghost" title="关闭（Esc）" aria-label="关闭搜索" onClick={closeSearch}><IconX size={12} /></button>
            </div>
          )}
          {splitMenu && (
            <>
              <div className="pop-mask" onClick={() => setSplitMenu(false)} />
              <div className="split-menu" role="menu" aria-label="分屏">
                <div className="ts-label">在右侧显示已有会话<span className="dim">（复用现有连接，不新建）</span></div>
                {[...sessions].filter((s) => s.id !== sid).length === 0 && (
                  <div className="dim" style={{ fontSize: 12, padding: "2px 0 4px" }}>暂无其他会话</div>
                )}
                {[...sessions].filter((s) => s.id !== sid).map((s) => {
                  const st = stateLabel(s.state);
                  return (
                    <button key={s.id} className="ghost sm-item" role="menuitem"
                      onClick={() => { setSplitMenu(false); void enterSplitWith(s.id); }}>
                      <span className="sm-name">{s.host_name}</span>
                      <span className={"mono " + st.cls} style={{ fontSize: 10, marginLeft: "auto" }}>{st.text}</span>
                    </button>
                  );
                })}
                <div className="ts-label" style={{ marginTop: 8 }}>或</div>
                <button className="ghost sm-item" role="menuitem"
                  title="下一次新建的会话自动进入右侧分屏（当前会话留在左侧）"
                  onClick={() => {
                    splitNewPendingRef.current = true;
                    setSplitMenu(false);
                    pushToast("info", "已就绪：下一次新建的会话将进入右侧分屏——连接一台主机或打开本地终端即可");
                  }}
                >在右侧新建会话…</button>
              </div>
            </>
          )}
          {splitDegraded && splitHintOpen && (
            <div className="split-hint" role="status">
              <span>窗口宽度不足——分屏临时退化为单窗格，另一个会话仍在标签中；加宽窗口自动恢复。</span>
              <button className="ghost" aria-label="关闭提示" onClick={() => { splitHintDismissedRef.current = true; setSplitHintOpen(false); }}><IconX size={12} /></button>
            </div>
          )}
          {pasteConfirm && (
            // rev-r25 H1：对话框必须是 confirm-mask 的子元素（flex 居中+同层叠上下文）——
            // 兄弟写法下 dialog 仍是 term-wrap 流内静态项且被 mask 盖住，鼠标点不中
            <div className="confirm-mask" onClick={() => setPasteConfirm(null)}>
              <div className="confirm-dialog paste-dialog" ref={pasteConfirmRef} role="dialog" aria-modal="true" aria-labelledby="dlg-paste-title" onClick={(e) => e.stopPropagation()}>
                <div className="hk-title" id="dlg-paste-title">粘贴多行内容到 {pasteConfirm.hostName}？</div>
                <div>目标终端未开启 bracketed paste——换行会被远端立即执行。请确认内容；取消则不发送任何字节。</div>
                <pre className="paste-preview mono">{pasteConfirm.text.length > 2000
                  ? pasteConfirm.text.slice(0, 2000) + `\n……（预览截断，共 ${pasteConfirm.text.length} 字符）`
                  : pasteConfirm.text}</pre>
                <div className="hk-actions">
                  <button className="danger" onClick={() => {
                    termsRef.current.get(pasteConfirm.sid)?.term.paste(pasteConfirm.text);
                    setPasteConfirm(null);
                    restoreTermFocus();
                  }}>发送</button>
                  <button className="ghost" data-autofocus onClick={() => setPasteConfirm(null)}>取消</button>
                </div>
              </div>
            </div>
          )}
          {showSettings && (
            <>
              <div className="pop-mask" onClick={() => setShowSettings(false)} />
              <div className="term-settings" ref={settingsPanelRef} role="dialog" aria-modal="true" aria-label="显示设置">
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
                {/* R27（§7.1/§244）：应用外观与终端配色解耦——外观三态独立持久化
                    （blob chrome 域，新装默认跟随系统），终端配色只改终端 */}
                <div className="ts-label" style={{ marginTop: 10 }}>外观（应用）</div>
                <div className="row ts-appearance" role="group" aria-label="应用外观">
                  {APPEARANCES.map((a) => (
                    <button key={a.id} className={"ghost" + (appearance === a.id ? " ts-active" : "")}
                      aria-pressed={appearance === a.id}
                      onClick={() => changeAppearance(a.id)}>{a.label}</button>
                  ))}
                </div>
                <div className="ts-label" style={{ marginTop: 10 }}>终端配色</div>
                <div className="ts-themes" role="group" aria-label="终端配色">
                  {THEMES.map((t) => (
                    <button
                      key={t.id}
                      className={"ghost ts-opt" + (themeId === t.id ? " ts-active" : "")}
                      aria-pressed={themeId === t.id}
                      onClick={() => changeTheme(t.id)}
                    >
                      <span className="ts-swatch" style={{ background: t.bg, borderColor: t.fg, color: t.fg }}>Aa</span>
                      {t.label}
                    </button>
                  ))}
                </div>
                <div className="dim" style={{ marginTop: 6, fontSize: 11 }}>应用外观与终端配色相互独立；「跟随系统」随系统深浅实时切换。</div>
                <div className="dim" style={{ marginTop: 6, fontSize: 11 }}>字号快捷键：⌘= 增大 · ⌘− 减小 · ⌘0 重置</div>
                {/* R25 §318：多行粘贴保护开关——阈值（内容含换行）与行为在设置明确说明 */}
                <div className="ts-label" style={{ marginTop: 12 }}>粘贴</div>
                <label className="row" style={{ cursor: "pointer", alignItems: "flex-start", gap: 8 }}>
                  <input type="checkbox" checked={pasteGuard} onChange={(e) => changePasteGuard(e.target.checked)} style={{ marginTop: 3 }} />
                  <span style={{ fontSize: 12, lineHeight: 1.6 }}>
                    多行粘贴保护
                    <span className="dim" style={{ display: "block" }}>
                      粘贴内容含换行且远端未开启 bracketed paste 时，先预览确认再发送；关闭后立即发送。
                    </span>
                  </span>
                </label>
                {/* R21 凭据基础管理（§238/§267）：生成/导入在连接表单完成；此处列表 +
                    未绑定标记 + 引用检查删除——已保存凭据独立存在，取消表单不默默删除 */}
                <div className="ts-label" style={{ marginTop: 12 }}>凭据库</div>
                {credErr && <div className="err" style={{ marginTop: 4, fontSize: 12 }}>✕ {credErr}</div>}
                {identities.length === 0 ? (
                  <div className="dim" style={{ marginTop: 4, fontSize: 12 }}>
                    还没有凭据——私钥（生成/粘贴/文件导入）与密码都在连接表单里保存后进入这里。
                  </div>
                ) : (
                  <div style={{ marginTop: 4 }}>
                    {identities.map((it) => (
                      <div key={it.id} className="cred-row">
                        {/* vis-r21：280px 面板单行排不下（label 被挤零宽、kind 与指纹
                            叠印 37.7px）——改两行：首行 label+徽章+删除，次行 kind+指纹 */}
                        <div className="cred-top">
                          <span className="cred-label" title={it.label}>{it.label}</span>
                          {referencedIdentityIds.has(it.id)
                            ? <span className="cred-bound">使用中</span>
                            : <span className="cred-unbound" title="未被任何主机引用——保留在库中，可在表单里绑定">未绑定</span>}
                          <button className="ghost host-del" title="删除凭据（被引用会被拒绝并列出主机）"
                            aria-label={`删除凭据 ${it.label}`}
                            onClick={() => { setCredErr(null); setConfirm({ kind: "deleteIdentity", id: it.id, label: it.label }); }}>
                            <IconTrash size={12} />
                          </button>
                        </div>
                        <div className="cred-sub">
                          <span className="cred-kind">{it.kind === "Password" ? "密码" : it.kind === "Rsa" ? "RSA 密钥" : "Ed25519 密钥"}</span>
                          <span className="mono cred-fp" title={it.fingerprint}>{it.fingerprint}</span>
                        </div>
                      </div>
                    ))}
                    <div className="dim" style={{ marginTop: 4, fontSize: 11 }}>
                      删除前自动检查引用；指纹用于核对库里存的是哪把钥匙，不会出现在日志里。
                    </div>
                  </div>
                )}
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
                ? inputBlockedState(current.state)
                  ? current.state === "Disconnected"
                    ? "会话已断开——重连恢复后再执行命令"
                    : "网络中断，自动重连中——命令暂不发送"
                  : `在 ${current.host_name} 上执行命令——回车执行，Ctrl+C 中断终端里的前台程序`
                : "先在主机栏连接一台主机，这里才能执行命令"
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
                // 死会话/断线拦截（P2-7 + R26 §6.4）：命令不进死通道、不排队给未来连接
                const cst = sessionsRef.current.find((x) => x.id === sid)?.state;
                if (cst && inputBlockedState(cst)) {
                  setConnError({
                    title: cst === "Disconnected" ? "会话已断开" : "网络中断（自动重连中）",
                    detail: "命令未发送。重连恢复后再执行。",
                  });
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
                  // R24-L5（DC3.4）：命令框恒 Shell 模式——集成关闭主机的拒绝要给下一步：
                  // 开集成，或 CLI/MCP 显式 Fresh（UI 无 Fresh 入口，不假装有）
                  const pe = parseWireError(err);
                  if (pe.kind === "shell_integration_unavailable") {
                    xtermRef.current?.write("\x1b[33m  该主机未启用 shell 集成——命令框按 Shell 模式执行被拒。\x1b[0m\r\n\x1b[33m  可在设置开启该主机集成；或在 CLI/MCP 显式以 Fresh 模式执行（无现场，退出码可靠）。\x1b[0m\r\n");
                  }
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
                const st = s ? sessionsRef.current.find((x) => x.id === s)?.state : undefined;
                if (s && st && !inputBlockedState(st)) {
                  void invoke("send_keys", { sid: s, keys: "\u0003" }).catch(() => {});
                }
                xtermRef.current?.focus();
              }}
            >
              <IconStop size={12} /> 中断
            </button>
          )}
        </div>
        </div>{/* /term-col */}

        {/* 右侧任务面板（§4.3）：一次只呈现文件 / 转发 / 协作之一；窄窗改中央完整视图 */}
        {rightPanel && (
          <aside className={"task-panel" + (tpFull ? " tp-full" : "")} aria-label="任务面板">
            <div className="tp-head">
              <b>{rightPanel === "files" ? "文件与传输" : rightPanel === "forwards" ? "端口转发" : "协作"}</b>
              {tpFull && <span className="dim" style={{ fontSize: 11 }}>空间不足——完整视图，终端仍在运行</span>}
              {rightPanel === "collab" && pendingCount > 0 && <span className="badge agent">{pendingCount} 待处理</span>}
              <span style={{ flex: 1 }} />
              <button className="ghost icon-btn" title="关闭面板（再次点「文件」/「工具」项亦可）" aria-label="关闭任务面板"
                onClick={() => setRightPanel(null)}><IconX size={14} /></button>
            </div>
            <div className="tp-scroll">
          {rightPanel === "collab" && (
            <>
          <div className="section">
            <h4>审批</h4>
          </div>
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

            </>
          )}
          {rightPanel === "files" && (
            <>
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
                    onKeyDown={(e) => e.key === "Enter" && void navigateTo(sftpPathInput)}
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
                        <span className="sftp-ico" title={e.kind === "symlink" ? "符号链接" : undefined}>
                          {e.kind === "symlink" ? "→" : e.is_dir ? <IconFolder size={13} /> : <IconFile size={13} />}
                        </span>
                        {e.is_dir ? (
                          <button
                            className="sftp-name mono"
                            title={`进入 ${e.name}`}
                            onClick={() => void loadDir(`${sftpPath.replace(/\/+$/, "")}/${e.name}`)}
                          >{e.name}</button>
                        ) : e.kind === "symlink" ? (
                          <button
                            className="sftp-name mono"
                            title="符号链接：按目标处理（目录进入 / 文件下载）"
                            onClick={() => void openSymlink(e)}
                          >{e.name}</button>
                        ) : (
                          <span className="sftp-name mono" title={`${sftpPath.replace(/\/+$/, "")}/${e.name}`}>{e.name}</span>
                        )}
                        <span className="dim mono sftp-size">
                          {e.is_dir ? "目录" : e.kind === "symlink" ? "链接" : e.size == null ? "—" : fmtBytes(e.size)}
                        </span>
                        <span className="dim mono sftp-time">
                          {e.mtime == null ? "—" : new Date(e.mtime * 1000).toLocaleDateString("zh-CN", { month: "numeric", day: "numeric" })}
                        </span>
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
                    {t.status === "queued" && "排队中…"}
                    {t.status === "running" && `传输中…${t.bytes ? ` ${fmtBytes(t.bytes)}${t.total ? ` / ${fmtBytes(t.total)}` : ""}` : ""}`}
                    {t.status === "cancelling" && "取消中…"}
                    {t.status === "done" && `完成 · ${fmtBytes(t.bytes ?? 0)} · ${t.kind === "Upload" ? t.remote : t.local}`}
                    {t.status === "failed" && `失败：${t.error ?? "未知错误"}`}
                    {t.status === "cancelled" && "已取消"}
                  </div>
                </div>
                {t.status === "running" || t.status === "queued" || t.status === "cancelling" ? (
                  <button className="ghost" title="取消传输" onClick={() => { invoke("cancel_transfer", { id: t.id }).catch(() => {}); }}>✕</button>
                ) : (
                  <span className={t.status === "done" ? "ok" : "err"} style={{ flex: "none" }}>
                    {t.status === "done" ? "✓" : t.status === "cancelled" ? "⊘" : "✕"}
                  </span>
                )}
              </div>
            ))}
          </div>

            </>
          )}
          {rightPanel === "forwards" && (
            <>
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

            </>
          )}
          {rightPanel === "collab" && (
            <>
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
            </>
          )}
            </div>
          </aside>
        )}
        </div>{/* /content */}

        {/* 页脚状态条 24（§4.2）：只放短状态与任务入口 */}
        <footer className="statusbar">
          <span className="mono sb-left">{sbLeft}</span>
          <span style={{ flex: 1 }} />
          <span className="sb-right">
            <button className="sb-btn" title="端口转发" onClick={() => setRightPanel(rightPanel === "forwards" ? null : "forwards")}>转发 <b>{forwards.length}</b></button>
            <button className="sb-btn" title="文件与传输" onClick={() => setRightPanel(rightPanel === "files" ? null : "files")}>传输 <b>{runningTransfers}</b></button>
          </span>
        </footer>
        </main>
      </div>{/* /workspace */}

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
// prefill（C7/DF7.4）：导入面板「转手工表单」用预览载荷预填——upsert_host，零新命令
function AddHostForm({ onSaved, editHost, prefill }: { onSaved: (hostId: string, wasEdit: boolean, connect: boolean) => void; editHost?: Host | null; prefill?: SshConfigPreview | null }) {
  const editing = !!editHost;
  const [name, setName] = useState(editHost?.name ?? prefill?.name ?? "");
  const [address, setAddress] = useState(editHost?.address ?? prefill?.address ?? "");
  const [port, setPort] = useState(editHost ? String(editHost.port) : String(prefill?.port ?? 22));
  const [username, setUsername] = useState(editHost?.username ?? (prefill && !prefill.user_specified ? "" : prefill?.username ?? ""));
  const [authMode, setAuthMode] = useState<"password" | "key" | "agent">(
    editHost ? "password" : prefill ? (prefill.has_identity ? "key" : "agent") : "password");
  const [charset, setCharset] = useState<"utf-8" | "gbk">(editHost?.charset ?? "utf-8");
  const [tagsInput, setTagsInput] = useState((editHost?.tags ?? (prefill ? ["ssh-config"] : [])).join(","));
  const [password, setPassword] = useState("");
  const [pem, setPem] = useState("");
  const [passphrase, setPassphrase] = useState("");
  // 私钥先绑定后确认（FR-2 指纹确认）：粘贴/文件/生成 → create_identity 落库 →
  // 出示指纹给用户核对，保存时只引用 identity_id——明文与私钥都不随表单走
  const [identity, setIdentity] = useState<IdentityMeta | null>(null);
  // R21（§265「认证支持已有密钥」）：绑定凭据库里已有的（含取消表单后未绑定的）凭据
  const [pickedIdentity, setPickedIdentity] = useState<string>("");
  const [knownIdentities, setKnownIdentities] = useState<IdentityMeta[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    invoke("list_identities")
      .then((xs) => setKnownIdentities(xs.filter((x) => x.kind !== "Password")))
      .catch(() => { /* 选择器降级为空，仍可生成/导入 */ });
  }, []);

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
      setPickedIdentity(""); // 新导入的密钥接管当前表单（覆盖已有密钥选择）
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
      setPickedIdentity(""); // 新生成的密钥接管当前表单（覆盖已有密钥选择）
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
      } else if (pickedIdentity) {
        // R21：绑定凭据库已有密钥（含取消表单后未绑定的凭据——§267 不默默删除的消费面）
        auth = { Key: { identity_id: pickedIdentity } };
      } else {
        if (!identity) { setErr("请先「导入并确认指纹」「生成新密钥」或选择已有密钥"); setBusy(false); return; }
        auth = { Key: { identity_id: identity.id } };
      }
      // 标签（R20）：逗号分隔（中英文逗号皆可）→ 去重去空
      const tags = [...new Set(tagsInput.split(/[,，]/).map((x) => x.trim()).filter(Boolean))];
      const hid = await invoke("upsert_host", {
        host: {
          id: editHost?.id ?? null, name: name.trim(), address: address.trim(),
          port: p, username: username.trim(), auth, tags,
          charset,
        },
      });
      if (!editing) { setName(""); setAddress(""); setPort("22"); setPem(""); setPassphrase(""); setIdentity(null); setPickedIdentity(""); setTagsInput(""); }
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
      {prefill && !editing && (
        <div className="dim" style={{ fontSize: 11, marginBottom: 6 }}>
          预填自 ~/.ssh/config:{prefill.source_line}
          {prefill.unsupported.some((u) => u.level === "Blocking") && "（含不兼容指令，请核对后保存）"}
          {!prefill.user_specified && "（config 未指定用户，请补全）"}
        </div>
      )}
      <div className="row" style={{ alignItems: "flex-end" }}>
        <div className="ah-field" style={{ flex: 1 }}>
          <label>名称</label>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="例：我的服务器" />
        </div>
        <div className="ah-field" style={{ flex: 2 }}>
          <label>地址（IP 或域名）</label>
          <input value={address} onChange={(e) => setAddress(e.target.value)}
            onBlur={() => { if (!name.trim() && address.trim()) setName(address.trim()); }}
            placeholder="例：192.168.1.10 或 server.example.com" style={{ minWidth: 0 }} />
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
      {/* R20：标签（逗号分隔）——主机卡徽章显示，搜索与标签 chip 筛选可命中 */}
      <div className="ah-field" style={{ marginTop: 6 }}>
        <label>标签（可选，逗号分隔，如：生产, 成都）</label>
        <input value={tagsInput} onChange={(e) => setTagsInput(e.target.value)}
          placeholder="例：生产, 数据库" onKeyDown={(e) => e.key === "Enter" && submit()} />
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
      ) : (
        <>
          {/* R21（§265 已有密钥）：绑定凭据库既有凭据——取消表单后未绑定的凭据在此回收 */}
          {knownIdentities.length > 0 && !identity && (
            <div className="ah-field" style={{ marginTop: 6 }}>
              <label>已有密钥（凭据库）</label>
              <select value={pickedIdentity}
                onChange={(e) => { setErr(null); setPickedIdentity(e.target.value); }}>
                <option value="">新密钥（下方生成 / 导入）</option>
                {knownIdentities.map((k) => (
                  <option key={k.id} value={k.id}>{k.label} · {k.fingerprint.slice(0, 19)}…</option>
                ))}
              </select>
            </div>
          )}
          {!pickedIdentity && (identity ? (
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
          ))}
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

// ~/.ssh/config 导入面板（C7/R22）：分级诊断列（阻断/警告）+ 默认只勾可直接导入
// （DF7.5 无 User 不勾）+ 已导入条目显式覆盖 + 不可直接导入条目转手工表单（DF7.4）。
function SshConfigImportPanel({ onDone, onClose, onManual }: {
  onDone: () => void; onClose: () => void; onManual: (e: SshConfigPreview) => void;
}) {
  const [entries, setEntries] = useState<SshConfigPreview[] | null>(null);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [outcomes, setOutcomes] = useState<SshImportOutcome[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    invoke("ssh_config_preview", { path: null })
      .then((es) => {
        setEntries(es);
        // 默认勾选 = 可直接导入且未导入过（阻断项与重复项不进默认集）
        setChecked(new Set(es.filter((e) => e.directly_importable && !e.already_imported).map((e) => e.name)));
      })
      .catch((e) => setErr(friendlyError(e)));
  }, []);

  const importChecked = async () => {
    setErr(null);
    if (checked.size === 0) { setErr("先勾选要导入的条目"); return; }
    setBusy(true);
    try {
      // 显式覆盖（DF7.3）：勾中了已在主机列表的条目 → 整批 overwrite，重复者以既有 id 覆盖
      const overwrite = entries?.some((e) => e.already_imported && checked.has(e.name)) ?? false;
      const outs = await invoke("ssh_config_import", {
        path: null, names: [...checked], overwrite,
      });
      setOutcomes(outs);
      const okCount = outs.filter((o) => o.host_id).length;
      if (okCount > 0) onDone();
    } catch (e) {
      setErr(friendlyError(e));
    } finally {
      setBusy(false);
    }
  };

  const unsupportedNote = (e: SshConfigPreview) => (
    <>
      {e.unsupported.filter((u) => u.level === "Blocking").map((u) => (
        <div key={u.directive} className="err" style={{ fontSize: 11 }}>
          ✕ 阻断：{u.directive}（第 {u.line} 行）——不支持代理/证书，需手工处理
        </div>
      ))}
      {e.unsupported.filter((u) => u.level === "Warning").map((u) => (
        <div key={u.directive} className="dim" style={{ fontSize: 11 }}>
          · 未同步：{u.directive}（第 {u.line} 行，不影响连通）
        </div>
      ))}
      {!e.user_specified && (
        <div className="err" style={{ fontSize: 11 }}>✕ 未指定登录用户——补全后再导入</div>
      )}
    </>
  );

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
            const imported = outcome?.host_id != null;
            const blocked = !e.directly_importable;
            const skip = outcome?.skipped_reason ?? null;
            return (
              <label key={e.name} className="sshcfg-row">
                <div className="row" style={{ alignItems: "flex-start", flexWrap: "nowrap" }}>
                  <input
                    type="checkbox"
                    style={{ width: "auto", marginTop: 2 }}
                    disabled={blocked || imported}
                    checked={checked.has(e.name) || imported}
                    onChange={(ev) => {
                      const next = new Set(checked);
                      if (ev.target.checked) next.add(e.name); else next.delete(e.name);
                      setChecked(next);
                    }}
                  />
                  <span style={{ flex: 1, minWidth: 0 }}>
                    <div>
                      {e.name}
                      {e.already_imported && !imported && <span className="dim"> · 已在主机列表（勾选即覆盖）</span>}
                      {imported && <span className="ok"> ✓ 已导入</span>}
                    </div>
                    <div className="dim mono" style={{ fontSize: 11 }}>
                      ~/.ssh/config:{e.source_line} · {e.user_specified ? `${e.username}@${e.address}:${e.port}` : `@${e.address}:${e.port}`} · {e.has_identity ? "密钥" : "Agent"}
                    </div>
                    {!imported && unsupportedNote(e)}
                    {skip === "Duplicate" && <div className="dim" style={{ fontSize: 11 }}>↷ 跳过：重复（同名或同地址+端口+用户）。收起面板重新打开后勾选可覆盖</div>}
                    {skip === "Blocked" && <div className="err" style={{ fontSize: 11 }}>↷ 跳过：含阻断指令</div>}
                    {outcome && outcome.error && <div className="err" style={{ fontSize: 11 }}>✕ {outcome.error}</div>}
                  </span>
                  {blocked && !imported && (
                    <button className="ghost" style={{ width: "auto", fontSize: 11, flexShrink: 0 }}
                      onClick={(ev) => { ev.preventDefault(); onManual(e); }}>
                      转手工表单
                    </button>
                  )}
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
        <span className="dim">带 IdentityFile 的条目会读私钥入凭据库；没有的走本机 ssh-agent。勾选「已在主机列表」条目=显式覆盖（对该批内命中的重复项一并生效）。</span>
      </div>
    </div>
  );
}
