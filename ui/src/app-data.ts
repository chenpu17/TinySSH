// App 级共享数据/工具层（App.tsx 拆分①）：呈现态类型、标签字典、格式化工具、
// 终端键入辅助、搜索/分屏/字号/色板常量与主题预设、tauri 订阅兜底与弹窗焦点
// 陷阱 hook。纯函数/常量为主（唯一带 React 的是 useDialogFocus）；不含组件。
// 新增标签必须与后端审计动作同步（见 AUDIT_LABELS 注）。
import { IconSliders, IconPencil, IconTerminal, IconStar, IconInbox, IconClock } from "./icons"; // settingsCatIcon 图标映射用（值引用，无 JSX）
import { useEffect, type RefObject } from "react";
import { invoke, MkChannel } from "./adapter/bridge";
import { errMsg, parseWireError } from "./adapter/errors";
import type { ApprovalItem, AuditEvent } from "./adapter/wire";

// 传输卡片是 UI 呈现态；C5（R32）起终态/进度来自任务注册表（list_transfers 查询
// + transfer-event 事件，revision 单调幂等），pending- 前缀占位卡在拿到真实
// TransferHandle 前保持本地 optimistic 呈现
export type TransferCard = {
  id: string; kind: "Upload" | "Download"; name: string; remote: string; local: string;
  status: "queued" | "running" | "committing" | "awaiting" | "unknown" | "cancelling" | "done" | "failed" | "cancelled" | "skipped" | "interrupted";
  bytes?: number; total?: number | null; error?: string;
  // C6/R34：待决卡载荷（expect_revision=rev；提示目标与原因）
  rev?: number;
  prompt?: { target_path: string; reason: string; size: number | null; mtime: number | null } | null;
  // R35：所属会话（上传「定位」只在目标会话=当前会话时可导航）
  sid?: string;
};
export function stopOutcomeText(v: unknown): { text: string; bad: boolean } {
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
export const normApprovalStatus = (s: string): string =>
  s.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
// 审批行入库后 status 已归一为小写——状态集合用 string（wire 的 ApprovalStatus 仅在桥边界）
export type ApprovalRow = Omit<ApprovalItem, "status"> & { status: string };
// R42（§6.6/S11）：设置对话框的分类（单实例，左分类 + 右内容）
// 二十一轮：分类加导航描述（大气化——图标 + 标签 + 一句话定位）
export type SettingsCat = "appearance" | "keys" | "terminal" | "credentials" | "agent" | "about";
export const SETTINGS_CATS: [SettingsCat, string, string][] = [
  ["appearance", "外观", "色板 · 字号 · 缩放"],
  ["keys", "快捷键", "新建 · 关签 · 分屏 · 面板"],
  ["terminal", "终端", "粘贴 · 复制 · 通知"],
  ["credentials", "凭据", "密钥与口令"],
  ["agent", "Agent 接入", "MCP 协作"],
  ["about", "关于", "版本与数据"],
];
export const settingsCatLabel = (c: SettingsCat): string => SETTINGS_CATS.find(([id]) => id === c)?.[1] ?? c;
export const settingsCatIcon: Record<SettingsCat, typeof IconSliders> = {
  appearance: IconSliders, keys: IconPencil, terminal: IconTerminal, credentials: IconStar,
  agent: IconInbox, about: IconClock,
};
// 最近处理（已决审批）六态标签：编辑后批准/超时/作废此前都被误显示成「✕ 拒绝」。
export const approvalResolvedLabel: Record<string, { text: string; cls: string }> = {
  approved: { text: "✓ 批准", cls: "ok" },
  approved_edited: { text: "✓ 批准（编辑后）", cls: "ok" },
  denied: { text: "✕ 拒绝", cls: "err" },
  timeout: { text: "⏱ 超时未审", cls: "err" },
  voided: { text: "⊘ 已作废（接管/会话关闭）", cls: "dim" },
};

// 认知状态 → 用户能看懂的标签
export const epistemicLabel = (s: string) =>
  s === "Confirmed" ? "已核实" : s === "NeedsRecheck" ? "需复核" : "未观测";

// 退出码 → 人话
export const exitText = (code: string): string =>
  code === "0" ? "成功" : code === "130" ? "Ctrl+C 中断" : code === "未知" ? "已结束（退出码未知）" : `退出码 ${code}`;

// 字节数 → 人话
export const fmtBytes = (n: number): string =>
  n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : n >= 1024 ? `${(n / 1024).toFixed(1)} KB` : `${n} B`;

// 路径取文件名（本地与远端同用；末尾斜杠已过滤）
export const pathBasename = (p: string): string => p.split("/").filter(Boolean).pop() ?? "file";

// 审计动作 → 中文描述（未知动作原样显示）。全仓 29 个动作对齐清点过
// （五人走查·阿紫：「我 forward_start」裸英文漏出）——新动作必须两边同步补。
// 单独导出成常量：活动记录的「事件类型」筛选项要枚举它（函数体的字面量取不到 keys）。
export const AUDIT_LABELS: Record<string, string> = {
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
    host_key_rejected: "拒绝主机指纹",
    // 审计 F8：以下与后端真实动作集对账补齐（此前 ~19 个动作在活动记录里裸英文、
    // 且「事件类型」筛选永远选不到）
    session_delegated: "委托会话",
    session_reconnect_stop: "停止重连",
    approval_timeout: "审批超时",
    collab_enabled: "启用协作",
    collab_disabled: "停用协作",
    collab_disable_failed: "停用协作失败",
    connection_failed: "连接失败",
    connection_cancelled: "取消连接",
    connection_cancelled_closed: "取消连接（会话已闭）",
    connection_cancel_close_failed: "取消连接收尾失败",
    forward_listen_failed: "转发监听失败",
    host_favorite: "收藏主机",
    auth_failed: "认证失败",
    upload: "上传文件",
    download: "下载文件",
    sftp_stat: "查看文件信息",
    transfer_cancel: "取消传输",
    transfer_retry: "重试传输",
    transfer_interrupted: "传输中断",
    transfer_list: "查看传输列表",
    transfer_decision: "传输冲突决定",
    transfer_decision_rejected: "冲突决定被拒",
    transfer_outcome_unknown: "传输结果未知",
    transfer_outcome_verified: "传输结果已核实",
    transfer_outcome_reverify: "传输结果复检",
    transfer_recovered_succeeded: "重启恢复传输完成",
    transfer_publish_blocked: "传输发布被阻",
    transfer_temp_clean_failed: "临时文件清理失败",
};
export const auditLabel = (a: string): string => AUDIT_LABELS[a] ?? a;

// 审批决定行：payload.decision 区分批准/编辑后批准/拒绝（旧库存量是 Debug 串
// "ApproveEdited(\"…\")"，按小写前缀兼容），命令本身由后端 audit 直接给实际放行文（PV R1）。
// goal_set/approval_voided 同样读 payload 细分（五人走查：清除≠更新；作废要给原因）。
export const decisionLabel = (ev: AuditEvent): string => {
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

// （原 `HIDDEN_AUDIT_ACTIONS` 客户端隐藏 `shell_integration_inject` 的常量随 R41 的
//  `timeline` 一并删除——活动记录是完整留痕视图，隐藏与后端分页 total 口径不可调和。
//  见本目录 README「取向登记」。）

// 审计时间戳 → HH:MM:SS（与现场简报/后端审计口径一致——之前无秒，和简报对不上）
export const hhmm = (ts: string): string => {
  const d = new Date(ts);
  return isNaN(d.getTime()) ? "" : d.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
};

// R41（§6.6）活动记录时间戳：含**日期**，与 hhmm 的纯时刻分开（详情/记录要能跨天定位）
export const stampLocal = (ts: string): string => {
  const d = new Date(ts);
  if (isNaN(d.getTime())) return "";
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
};

// 本机时区偏移说明（§6.6「时间含日期/时区说明」）——只算一次，随标题展示
export const TZ_NOTE = (() => {
  const off = -new Date().getTimezoneOffset();
  const sign = off >= 0 ? "+" : "-";
  const a = Math.abs(off);
  return `UTC${sign}${String(Math.floor(a / 60)).padStart(2, "0")}:${String(a % 60).padStart(2, "0")}`;
})();

// R41（§6.6）「可筛…事件类型」：固定候选（auditLabel 全集 + goal_set），按中文名排序。
// 不从结果集反推——否则一加动作过滤，候选就跟着塌缩。
// `goal_set` 不在 AUDIT_LABELS 里（它的中文名按 payload 细分，见 decisionLabel），
// 不能走 auditLabel 回落成原始键名——否则下拉显示 `goal_set` 而列表显示「更新任务目标」，
// 用户对不上自己筛的是哪一项（rev-r41 低-1）。此处给覆盖两种细分的合并名。
export const LOG_ACTION_OPTIONS: { v: string; label: string }[] = [...Object.keys(AUDIT_LABELS), "goal_set"]
  .map((v) => ({ v, label: v === "goal_set" ? "更新/清除任务目标" : auditLabel(v) }))
  .sort((x, y) => x.label.localeCompare(y.label, "zh-CN"));

// 会话状态 → 中文标签 + 颜色类
export const stateLabel = (s: string): { text: string; cls: string } => {
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
export const inputBlockedState = (st: string): boolean =>
  st === "Disconnected" || st === "Degraded" || st === "Reconnecting";

// tauri 事件订阅的退订竞态兜底（审计 F2）：listen 是异步的——effect cleanup 先于
// promise resolve 时 `un?.()` 拿到的还是 undefined，第一条订阅永久泄漏（StrictMode
// 双挂载必现双份事件；快速切标签的 forward-event 在生产同样触发）。同文件
// onDragDropEvent 早已用 dead 标志修正过同型，此处统一收口。
export function tauriListen(p: Promise<() => void>): () => void {
  let un: (() => void) | undefined;
  let dead = false;
  p.then((f) => {
    if (dead) f();
    else un = f;
  }).catch(() => {});
  return () => {
    dead = true;
    un?.();
  };
}

// §7.4：弹窗 focus trap——打开时焦点入框、Tab/Shift+Tab 循环不出框、关闭时焦点
// 还原到触发控件（VoiceOver/纯键盘用户的回位锚点）。只用于带遮罩的模态弹窗。
export function useDialogFocus(active: boolean, boxRef: RefObject<HTMLElement | null>) {
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
export const friendlyError = (e: unknown): string => {
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
export async function runBench() {
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
export const ctrlCharOf = (key: string): string | null => {
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
export const altMetaSequence = (code: string | undefined, shift: boolean): string | null => {
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
export const SEARCH_OPTS = {
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
export const SPLIT_PANE_MIN = 360;
export const SPLIT_DEGRADE_BELOW = SPLIT_PANE_MIN * 2;
export const SPLIT_RECOVER_AT = SPLIT_PANE_MIN * 2 + 6;

// 显示设置（路线图⑥）：字号范围与主题色板。偏好存 vault（settings KV，跨进程记忆），
// 浏览器演示模式退化为 localStorage。R27（§7.1/§244）：外观三态（跟随系统/深色/浅色，
// 新装默认跟随系统）走 ui.v2.workspace blob 的 chrome 域；二十二轮主题统一：主题色板
// 是唯一主题事实源，终端配色由色板×深浅派生（ui.theme/ui.theme.follow 双轨退役）；
// Tauri 下原生窗口外观（Overlay 红绿灯、原生面板）随外观同步。
export const FONT_MIN = 9;
export const FONT_MAX = 28;
// §7.2：终端默认字号 14px（用户可调，范围 9–28 保留；已存偏好优先于默认）
export const FONT_DEFAULT = 14;
// C8（R15）：字号迁到命名空间键；旧键 ui.font_size 由核心 V5 迁移写入新键后
// 保留不删（回退兼容），浏览器 demo 读新键缺失时回落旧键
export const SETTING_FONT = "ui.v2.terminal.font_size";
export const SETTING_FONT_LEGACY = "ui.font_size";
// 主题色板（2026-10-11）：统一主题族——既定应用 chrome，也经派生决定终端配色
// （二十二轮起单一事实源，ui.theme/ui.theme.follow 双轨退役）。
export const SETTING_PALETTE = "ui.palette";

export type Appearance = "system" | "dark" | "light";
export const APPEARANCES: { id: Appearance; label: string }[] = [
  { id: "system", label: "跟随系统" },
  { id: "dark", label: "深色" },
  { id: "light", label: "浅色" },
];

// 主题色板族：dot = [深色底, 深色 accent] 用于设置页色板芯片预览（亮态预览取同 accent）
// 主题④轮起芯片双面预览：dot=深色面 [底, accent]，lite=浅色面 [底, accent]——
// 拾色器如实呈现每族的深浅两副面孔（此前恒示深色面，浅色模式下选板全凭想象）
export type ChromePalette = { id: string; label: string; dot: [string, string]; lite: [string, string] };
export const PALETTES: ChromePalette[] = [
  { id: "graphite", label: "石墨", dot: ["#0a0e14", "#3ec3d3"], lite: ["#eef1f5", "#0a7280"] },
  { id: "ember", label: "暖烬", dot: ["#17171a", "#e07856"], lite: ["#f3f2f0", "#ad4726"] },
  { id: "ocean", label: "深海", dot: ["#0d1117", "#4c8dff"], lite: ["#eef2f7", "#2464ad"] },
  { id: "violet", label: "午夜", dot: ["#14111c", "#a78bfa"], lite: ["#f1f0fa", "#6553e8"] },
  { id: "noir", label: "鎏金", dot: ["#141210", "#c8a96e"], lite: ["#f1ede4", "#7d5a20"] },
  // 二十一轮扩四族（对表 Terminus 的主力板）：极光=翡翠薄荷 / 青瓷=黛青玉 /
  // 绯樱=樱粉玫瑰 / 曜石=钛银单色——色相与既有五族零重叠
  { id: "aurora", label: "极光", dot: ["#0e1712", "#46d7a5"], lite: ["#edf4ee", "#147a51"] },
  { id: "celadon", label: "青瓷", dot: ["#101917", "#7fd8c4"], lite: ["#edf3f1", "#0e7a66"] },
  { id: "sakura", label: "绯樱", dot: ["#1a1318", "#f0a8bc"], lite: ["#f7f0f3", "#b0486c"] },
  { id: "obsidian", label: "曜石", dot: ["#0f1013", "#cdd6e2"], lite: ["#f0f1f3", "#3c4654"] },
  // 主题③轮扩两族：霓虹=电光青×品红的夜航面板（唯一青→品红渐变族）/
  // 水墨=宣纸米白×朱砂印（唯一以亮色为身份的族，暗态转夜墨）
  { id: "neon", label: "霓虹", dot: ["#0a0a12", "#2fd6ec"], lite: ["#eef0f8", "#0b7291"] },
  { id: "ink", label: "水墨", dot: ["#161519", "#e06b4e"], lite: ["#f2efe7", "#b23a2e"] },
];
export const PALETTE_DEFAULT = "graphite";

// ANSI 16 色基础预设（主题②轮起降级为**回落档**——按族真值在 styles.css 的
// --ansi-0..15（ansi-gen.mjs 生成、双审计复核），仅某槽未声明时逐键回落到这里。
// 不再作为独立「终端配色」清单外显；Solarized 等第三方预设随双轨早已退役）
export type ThemePreset = {
  id: string; label: string;
  bg: string; fg: string; theme: Record<string, string>;
};
export const THEMES: ThemePreset[] = [
  {
    id: "dark", label: "深色 ANSI 基础", bg: "#0f141c", fg: "#d2dae6",
    theme: {
      foreground: "#d2dae6", background: "#0f141c",
      cursor: "#3ec3d3", cursorAccent: "#0f141c", selectionBackground: "#2a3f52",
      black: "#1c2532", red: "#e57773", green: "#72c795", yellow: "#e0af68",
      blue: "#82a7f0", magenta: "#bb9af7", cyan: "#3ec3d3", white: "#c8d3e0",
      brightBlack: "#5a6b80", brightRed: "#f0938f", brightGreen: "#96dcb0", brightYellow: "#ecc489",
      brightBlue: "#a3c0f7", brightMagenta: "#d3b5fa", brightCyan: "#7ddce8", brightWhite: "#eef2f8",
    },
  },
  {
    id: "light", label: "浅色 ANSI 基础", bg: "#f7f7f2", fg: "#2a3138",
    theme: {
      foreground: "#2a3138", background: "#f7f7f2",
      cursor: "#2a3138", cursorAccent: "#f7f7f2", selectionBackground: "#b9c6d4",
      black: "#2a3138", red: "#c4392f", green: "#2e7d32", yellow: "#a67c00",
      blue: "#1a5fb4", magenta: "#a1346b", cyan: "#1a7f8a", white: "#d0d0cc",
      brightBlack: "#6b7681", brightRed: "#e05545", brightGreen: "#46a353", brightYellow: "#c29300",
      brightBlue: "#3a7fd5", brightMagenta: "#c74d94", brightCyan: "#33a3b0", brightWhite: "#ffffff",
    },
  },
];
export const themeById = (id: string): ThemePreset => THEMES.find((t) => t.id === id) ?? THEMES[0];
