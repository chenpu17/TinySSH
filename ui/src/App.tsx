import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type RefObject } from "react";
import {
  invoke, MkChannel, inTauri, listen,
} from "./adapter/bridge";
import { errMsg, parseWireError } from "./adapter/errors";
import { MetricsBar } from "./metrics";
import { resolveAction, isMacPlatform, isWindowsPlatform } from "./actions";
import type { AppAction } from "./actions";
import {
  KEYMAP_ACTIONS, KEYMAP_SETTING,
  bindingOf, parseKeymap, parseKeymapReport, conflictOf, formatBinding, terminalReserved, exemptFromTerminal, defaultKeymap,
  type Binding, type KeyActionId,
} from "./keymap";
import { CommandPalette, type PaletteItem } from "./palette";
import {
  registerZoomHotkeys, onZoomChange, currentZoom,
  zoomIn, zoomOut, zoomReset,
} from "./zoom";
import { applyCheckpoint, createOutputFeed, setCursorDefault } from "./terminal/checkpoint";
import type { OutputFeed } from "./terminal/checkpoint";
import { terminalFocusTarget } from "./terminal/focus-report";
import { stripMotionOnlyMouseReports } from "./terminal/mouse-guard";
import { installMouseModeGuard, resetMouseReporting } from "./terminal/mouse-mode-guard";
import { repaintTerm } from "./terminal/repaint";
import { installAdaptiveSmoothScroll } from "./terminal/scroll";
import { installWheelBatch, displayIntervalMs } from "./terminal/wheel-batch";
import { isScrollbackFull, scrollBelow } from "./terminal/scrollback";
import { patchXtermImeGate } from "./terminal/xterm-ime-gate";
import {
  MAIN_KEY, defaultLayout, layoutRects, syncLayout, moveTile, resizeAt, equalizeAt, nodeAt, minExtent, dropZone, removeTile, treeHasKey,
  type PaneNode, type PaneTile, type PaneDivider, type DropZone,
} from "./terminal/pane-grid.mjs";
import { imePunctToAscii } from "./terminal/ime-punct.mjs";
import type {
  Host, HostDraft, HostMeta, RecentHost, SshConfigPreview, SshImportOutcome, SessionInfo, ApprovalItem, AuthDraft,
  PendingHostKey, PendingAuthPrompt, SessionBrief as Brief, AuditEvent,
  IdentityMeta, TakeoverReport, TransferHandle, DirEntryS, ForwardSpec, ForwardInfo,
  AttemptPhase, AttemptInfo, ErrorPayload, ConnectionEvent, CancelOutcome, SessionStateEvent,
  BeginConnectionOpts,
  TransferTask, CollisionDecision, SessionDetail, ShellCapability, CollabStatus, DisableImpact,
  McpStatus, AutonomyGrant, ActionRecord, RecordsQuery, RecordsRange, PasteHit, BlockInfo, TriggerRule,
  RestoreEntry, LocalShell, UpdateCheck, UpdaterInfo,
  HostPaneCombo, PaneLayoutNode,
  TmuxStatus,
  TmuxWallCell,
  TmuxWallFit,
  TmuxWallFitResult,
  TmuxWallRestoreItem,
  TmuxWallTarget,} from "./adapter/wire";
import { recordsRangeSince } from "./components/records-pane";
import { MonitorView, type MonitorCardHost } from "./components/monitor-view";
import { isMonitorPaused, setMonitorPaused as setStoreMonitorPaused, setMonEnabled, syncMonitorTargets } from "./monitor-store";
import {
  IconSliders, IconPlus, IconX, IconStop, IconPencil, IconTrash, IconStar,
  IconChevronUp, IconChevronDown, IconTerminal,
  IconArrowDown, IconUpload, IconDownload, IconInbox, IconSearch, IconLoader,
  IconFolder, IconRefresh, IconMaximize, IconMinimize,
  IconServer, IconBot, IconUsers, IconShuffle, IconRows, IconBlocks, IconGauge,
} from "./icons";

// macOS 标题栏融合（T33/R12）：Overlay 红绿灯悬浮在 44px 标题区上，.titlebar 留安全区。
// 只在原生模式加类——浏览器 demo 没有标题栏，留白反而是错的（走查可手动加类模拟）。
// native-mac 只标 macOS：84px 红绿灯安全区是 mac 专属（titleBarStyle Overlay 为
// mac-only 字段）。native-win 标 Windows：tauri.windows.conf.json decorations:false 后
// 应用标题行即唯一标题栏，右端 ─ □ ✕ 自绘窗口控件（双标题栏重设计）。
if (inTauri) {
  document.documentElement.classList.add("native-chrome");
  if (isMacPlatform()) document.documentElement.classList.add("native-mac");
  if (isWindowsPlatform()) document.documentElement.classList.add("native-win");
}
// 专注模式固定键的展示文案：macOS 的 F11 默认被系统「显示桌面」占用，需按 Fn+F11；
// Windows/Linux 直接 F11。凡面向用户的提示都走这里，别再写死「F11」。
const FOCUS_KEY_LABEL = isMacPlatform() ? "Fn+F11" : "F11";

// 终端 URL 裸单击的提示节流（5s 一次）：链接已下划线可辨，但远端可伪造输出诱导
// 点击，故未按修饰键只提示不打开；节流避免连点时刷屏。
let linkHintAt = 0;
import { getVersion } from "@tauri-apps/api/app";
import * as clipboard from "@tauri-apps/plugin-clipboard-manager";
import { isPermissionGranted, requestPermission, sendNotification } from "@tauri-apps/plugin-notification";
import { Terminal } from "@xterm/xterm";
import { SearchAddon } from "@xterm/addon-search";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { LigaturesAddon } from "@xterm/addon-ligatures";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { WebglAddon } from "@xterm/addon-webgl";
import { ImageAddon } from "@xterm/addon-image";
import { matchPaths, pathLinkProvider } from "./term-links";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { DragDropEvent } from "@tauri-apps/api/webview";
import "@xterm/xterm/css/xterm.css";
// 拆分①抽出的共享层：数据/工具/hooks（app-data）与自包含组件（components/*）
import {
  altMetaSequence, ApprovalRow, APPEARANCES, APP_VERSION, auditLabel, AUDIT_LABELS,
  byName, hostMatches, phaseText,
  ChromePalette, ctrlCharOf, dateLocale, epistemicLabel, exitText,
  FONT_DEFAULT, FONT_MAX, FONT_MIN, friendlyError, inputBlockedState,
  normApprovalStatus, PALETTES, PALETTE_DEFAULT, pathBasename,
  runBench, searchOptions, SETTING_AUTO_LOCAL, SETTING_FONT, SETTING_FONT_LEGACY, SETTING_LOCAL_SHELL, SETTING_PALETTE,
  SETTING_TERM_CURSOR_BLINK, SETTING_TERM_CURSOR_STYLE, SETTING_TERM_FONT_FAMILY,
  SETTING_TERM_LETTER_SPACING, SETTING_TERM_LIGATURES, SETTING_TERM_SCROLLBACK, SETTING_TERM_WHEEL_RATE,
  stateLabel, stampLocal, stopOutcomeText, isImeComposing,
  SPLIT_DEGRADE_BELOW, SPLIT_DEGRADE_BELOW_H, SPLIT_FRAC_MAX, SPLIT_FRAC_MIN,
  SPLIT_RECOVER_AT, SPLIT_RECOVER_AT_H, tauriListen, THEMES, ThemePreset,
  TransferCard, themeById, TZ_NOTE, useDialogFocus,
  TERM_FONT_DEFAULT, TERM_FONTS, termFontCss, TERM_LETTER_SPACING_DEFAULT, TERM_SCROLLBACK_DEFAULT,
  TERM_WHEEL_RATE_DEFAULT, parseTermWheelRate,
  type Appearance, type SettingsCat, type SplitDir, type SplitGroup, type SplitPanes, type TermCursorStyle, type TermWheelRate,
} from "./app-data";
import { localeNow, resolveInitialLocale, setLocale, SETTING_LOCALE, t, type Locale } from "./i18n";
import { WinControls } from "./components/window-controls";
import { QuickConnectForm } from "./components/quick-connect";
import { AddHostForm, addHostCredDirty } from "./components/add-host";
import { SshConfigImportPanel } from "./components/ssh-import";
import { SettingsPanel } from "./components/settings-panel";
import { ConfirmDialogs } from "./components/confirm-dialogs";
import { ActivityLogPanel } from "./components/activity-log-panel";
import { BlocksPanel } from "./components/blocks-panel";
import { Welcome } from "./components/welcome";
import { CtxMenus } from "./components/ctx-menus";
import { CollabApprovals, CollabDelegate } from "./components/collab-panel";
import { ConnDetail } from "./components/conn-detail";
import { Hostbar } from "./components/hostbar";
import { AgentView, EMBEDDED_AGENT_ID } from "./components/agent-view";
import { SessionToolbar } from "./components/session-toolbar";
import { TmuxQuick } from "./components/tmux-quick";
import { TmuxWall } from "./components/tmux-wall";
import { FilesPanel, SftpFileMenu, TransferQueueDrawer } from "./components/sftp-panel";
import { SelfMeterTitlebar } from "./self-meter";

// —— UX 八轮（性能）：轮询对账 bailout ——
// invoke 每轮返回全新对象，引用必不同：不拦截则整棵树每 3 秒空转一轮重渲染，
// 并级联触发标题 setTitle IPC、workspace 写链、applyPanes 遍历等下游 effect。
// 结构相同则复用 prev 引用，所有依赖 sessions/hosts/…的 useMemo/effect 全部静默。
function sameShape<T>(prev: T[], next: T[]): T[] {
  if (prev === next) return prev;
  if (prev.length !== next.length) return next;
  return JSON.stringify(prev) === JSON.stringify(next) ? prev : next;
}

// 稳定轮：对象版 bailout——brief/collab 的 3s 轮询曾每拍必换新引用，架空
// sameShape 的「数据没变整树静默」承诺（空闲时也全量重渲染）。
function sameJson<T>(prev: T, next: T): T {
  return prev !== null && JSON.stringify(prev) === JSON.stringify(next) ? prev : next;
}

// 审批高危命令形态（rm -rf/格式化/关机类……后端内置 deny 只拦最狠子集）：
// 模块级编译一次——原先在组件体内，每次渲染重建 RegExp
// 五轮架构：主机过滤/排序/相位文案已提升 app-data.ts（hostMatches/byName/phaseText），
// 宿主与 hostbar.tsx 共用同一口径。

// tmux 联动偏好键（恢复现场轮）：单键 JSON，见组件内 tmuxPrefs 注释。
const SETTING_TMUX_PREFS = "tmux.v1.prefs";

/** 标签条条目（一组一标签，Termius 式）：独立会话=一个标签；分屏组=一个组标签，
 *  成员不再单独占位。组标签落在该组最早成员在 sessions 中的位置——拖拽重排后
 *  组内成员被摊平成相邻项（见 reorderTabEntries），位置即为条目序。 */
type TabEntry =
  | { key: string; kind: "session"; session: SessionInfo }
  | { key: string; kind: "group"; group: SplitGroup; members: SessionInfo[] };

function deriveTabEntries(sessions: SessionInfo[], groups: SplitGroup[]): TabEntry[] {
  const bySid = new Map(sessions.map((s) => [s.id, s] as const));
  const groupOfSid = new Map<string, SplitGroup>();
  for (const g of groups) { groupOfSid.set(g.main, g); groupOfSid.set(g.second, g); }
  const seen = new Set<string>();
  const out: TabEntry[] = [];
  for (const s of sessions) {
    const g = groupOfSid.get(s.id);
    if (!g) { out.push({ key: `s:${s.id}`, kind: "session", session: s }); continue; }
    if (seen.has(g.id)) continue;
    seen.add(g.id);
    const members = [g.main, g.second]
      .map((id) => bySid.get(id))
      .filter((m): m is SessionInfo => !!m);
    out.push({ key: `g:${g.id}`, kind: "group", group: g, members });
  }
  return out;
}

/** 组标签状态点聚合：显式按会话状态排序——err > 已断开 > warn > ok > dim。
 *  不能沿用 stateLabel().cls 的档位：Disconnected 也归 dim，和「正常但无色」
 *  同档，一格断开 + 一格已连接时绿点反胜，组标签会把掉线藏起来。 */
const SESSION_STATE_RANK: Record<string, number> = {
  Degraded: 5, Reconnecting: 5,
  // Closed 与 Disconnected 同属「会话已死」：展示同为「已断开」，聚合不能输给绿点
  Disconnected: 4, Closed: 4,
  Reconfirming: 3,
  Connected: 2,
};
const sessionStateRank = (state: string): number => SESSION_STATE_RANK[state] ?? 0;

/** 组标签点击/键盘切换的落点会话：组内上次焦点成员，缺省 main。 */
function entryFocusSid(e: TabEntry, groupFocus: Map<string, string>): string {
  return e.kind === "session" ? e.session.id : groupFocus.get(e.group.id) ?? e.group.main;
}

/** tmux 面板格子实例（会话内附加交互通道的前端视图）。 */
type PaneTermEntry = {
  sid: string; paneId: number; name: string;
  term: Terminal; cell: HTMLDivElement; body: HTMLDivElement;
  zoomBtn: HTMLButtonElement; search: SearchAddon;
  webgl: WebglAddon | null; liga: LigaturesAddon | null; bornAt: number; alive: boolean; deadWarned: boolean;
};

// 窗格最大化/还原钮图标（imperative DOM 用；lucide maximize-2/minimize-2 同形——
// 与 React 侧 icons.tsx 的 IconMaximize/IconMinimize 保持一体）
const PANE_ZOOM_OFF_SVG = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/></svg>';
const PANE_ZOOM_ON_SVG = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 14 10 14 10 20"/><polyline points="20 10 14 10 14 4"/><line x1="14" y1="10" x2="21" y2="3"/><line x1="3" y1="21" x2="10" y2="14"/></svg>';
const PANE_SWAP_SVG = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h13"/><polyline points="14 4 17 7 14 10"/><path d="M20 17H7"/><polyline points="10 14 7 17 10 20"/></svg>';

/** 布局树叶子键原位改名（tmux 侧改名跟随）：树结构与占比不动，只换键——
 * 重命名不掉位置；from 不在树里是 no-op（该标签没拖过=自动平铺，无从改名）。 */
function renameTileKey(node: PaneNode | null | undefined, from: string, to: string): void {
  if (!node) return;
  if (node.kids) {
    for (const k of node.kids) renameTileKey(k, from, to);
    return;
  }
  if (node.key === from) node.key = to;
}

/** 面板格数上限（真实核心 handle.rs PANE_MAX / demo DEMO_PANE_MAX 同值）。 */
const PANE_MAX = 5;

/** 布局树形状校验（工作空间轮）：持久化读回/写入前双向把关——叶键非空串、w 为正
 * 有限数、容器必须 dir ∈ {row,col} 且至少两个孩子（容器无键，运行树如此）；非法
 * 整树弃用（恢复落自动平铺，几何仍正确）。就地返回 PaneNode 形（w 缺失按 1），
 * 不让脏数据进 paneLayoutRef。 */
function sanitizeLayoutTree(n: unknown): PaneNode | null {
  if (!n || typeof n !== "object") return null;
  const x = n as { key?: unknown; w?: unknown; dir?: unknown; kids?: unknown };
  const w = typeof x.w === "number" && Number.isFinite(x.w) && x.w > 0 ? x.w : 1;
  if (x.kids === undefined || x.kids === null) {
    if (typeof x.key !== "string" || !x.key) return null;
    if (x.dir !== undefined && x.dir !== null) return null;
    return { key: x.key, w };
  }
  if (!Array.isArray(x.kids) || x.kids.length < 2 || (x.dir !== "row" && x.dir !== "col")) return null;
  const kids: PaneNode[] = [];
  for (const k of x.kids) {
    const ok = sanitizeLayoutTree(k);
    if (!ok) return null;
    kids.push(ok);
  }
  return { dir: x.dir, w, kids };
}

/** 格子挂 WebGL 的上下文预算：浏览器每页活动 WebGL 上下文约 16 个，超出即强制
 * 丢弃最老的（往往是主终端，静默回落 DOM 渲染）——超额的格子直接走 DOM 渲染器。 */
const PANE_WEBGL_BUDGET = 12;

/** 终端正文最小对比度（WCAG AA 4.5:1）。xterm 会按**每个单元格实际前景/背景**
 * 动态修正前景亮度（DOM 与 WebGL 两个渲染器都实现了该能力），不改变缓冲区文本、
 * 也不依赖远端配置。主题轮审计：tmux 默认 `status-style bg=green,fg=black` 在浅色
 * 色板下仅约 1.05:1、深色色板 3.95–4.50:1；htop/dialog 一类「彩色底 + 黑字」同病。
 * 调色板本身已按「ANSI 彩字对终端底 ≥4.5」生成，因此普通输出不受影响。 */
const TERM_MIN_CONTRAST = 4.5;

/** 拖拽布局：单格最小像素（宽够 20 列、高够标题栏+数行；分隔条两侧各守此下限）。 */
const PANE_MIN_W = 180;
const PANE_MIN_H = 100;

/** 死格键入一次性告示（格子 onData 与窗口捕获层的 Ctrl/Alt 改投共用）。 */
function warnDeadPane(e: PaneTermEntry) {
  if (e.deadWarned) return;
  e.deadWarned = true;
  e.term.write(`\r\n\x1b[33m⚠ ${t("窗格已断开——键入未发送。")}\x1b[0m\r\n`);
}

/** tmux 前缀后一键的武装位（key = 主视图 sid 或格子 `sid:paneId`）。前缀之后的一键是
 * tmux 命令键不是文本，但中文输入法「中文标点」模式会把它提交成中文标点：Shift+4 → ￥、
 * " → “、: → ：、[ → 【……tmux 收到的是未绑定的键、静默丢弃——Ctrl+B $（改会话名）/
 * ,（改窗口名）/ "（上下分）/ :（命令行）/ [（复制模式）全都出不来（% 不变形，分屏照常）。
 * 窗口捕获层把 C-b 直发给 tmux 目标时武装，该目标下一份 onData 一次性消费并还原。 */
let tmuxPrefixArm: { key: string; at: number } | null = null;

/** 捕获层每次直发控制字符/Meta 序列后调用：C-b 发往 tmux 目标即武装，其余一律解除。 */
function armTmuxPrefix(key: string | null) {
  tmuxPrefixArm = key ? { key, at: performance.now() } : null;
}

/** 终端 onData 出口：本目标已武装则一次性消费——输入法标点还原成物理键位的 ASCII
 *（terminal/ime-punct.mjs），其余原样；前缀后 5s 未按键不再追认。dollar=消费的
 * 是前缀后的「$」（C-b $ 改会话名）：调用方据此补探针，让格子标题/主视图名牌在
 * 改名提交后秒级跟上（tmux 改名对前端没有事件，探针按不可变 session_id 对账）。 */
function takeTmuxPrefixKey(key: string, d: string): { keys: string; dollar: boolean } {
  const arm = tmuxPrefixArm;
  if (!arm) return { keys: d, dollar: false };
  // 一次性消费不看目标：前缀+命令键实践中紧邻，武装后改在别处打字=已离开，
  // 保留武装会让「回原目标打的第一键」被迟到还原
  tmuxPrefixArm = null;
  if (arm.key !== key || performance.now() - arm.at > 5000) return { keys: d, dollar: false };
  const keys = imePunctToAscii(d) ?? d;
  return { keys, dollar: keys === "$" };
}

/** C-b $ 之后的补探针时刻表：前缀 $ 只证明「改名框要弹」，提交（回车）时刻无从
 * 得知——按 2.5/7/20s 三连补，改名提交后最近一发命中即刷新，全程至多 3 次轻量
 * exec；同一目标重复按 $ 重排时刻表。 */
const tmuxProbeFollowTimers = new Map<string, number[]>();
function scheduleTmuxProbeFollow(sid: string) {
  const prev = tmuxProbeFollowTimers.get(sid);
  if (prev) for (const id of prev) clearTimeout(id);
  tmuxProbeFollowTimers.set(
    sid,
    [2500, 7000, 20000].map((ms, i) =>
      window.setTimeout(() => {
        tmuxProbeFollowHook?.(sid);
        if (i === 2) tmuxProbeFollowTimers.delete(sid); // 末发后清表（关会话后不再空开枪）
      }, ms),
    ),
  );
}
/** 组件侧挂钩（invoke tmux_probe + 刷新会话清单）；onData 闭包不追 stale 引用。 */
let tmuxProbeFollowHook: ((sid: string) => void) | null = null;

/** 格子缓冲尾部的 tmux 收尾提示（`[detached (from session x)]`、`[exited]`、
 * `can't find session` 等），供「窗格已结束」toast 交代原因；没有就返回 null。 */
function lastTmuxNotice(term: Terminal): string | null {
  const b = term.buffer.active;
  // 按逻辑行读：窄格子里 tmux 收尾行会软折行（isWrapped=本行是上一行的续行），
  // 只读物理末行会把「[detached (from session x)]」截成半句
  for (let end = b.length - 1, seen = 0; end >= 0 && seen < 12;) {
    let start = end;
    while (start > 0 && b.getLine(start)?.isWrapped) start--;
    let line = "";
    for (let i = start; i <= end; i++) line += b.getLine(i)?.translateToString(true) ?? "";
    end = start - 1;
    line = line.trim();
    if (!line) continue;
    seen++;
    if (/^\[(detached|exited|server exited|lost tty|terminated)/.test(line)
      || /can't find session|no server running|no sessions|session not found/i.test(line)) {
      return line.length > 120 ? line.slice(0, 120) + "…" : line;
    }
  }
  return null;
}

// 查找条选项（本轮）：区分大小写 / 全词 / 正则。会话内临时状态，关闭查找即复位。
type SearchPrefs = { caseSensitive: boolean; wholeWord: boolean; regex: boolean };
const SEARCH_PREFS_DEFAULT: SearchPrefs = { caseSensitive: false, wholeWord: false, regex: false };

export default function App() {

  const termRef = useRef<HTMLDivElement>(null);
  const xtermRef = useRef<Terminal | null>(null);
  const sidRef = useRef<string | null>(null);          // onData 闭包用 ref，避免 stale state
  const subscribedRef = useRef<Set<string>>(new Set()); // 每会话只订阅一次，防重复输出
  // 每会话一个独立 xterm 实例：切换会话 = 显示/隐藏，滚动历史与 vim 全屏状态原地保留
  // （P0 终端品质轮：webgl/liga 记住当前渲染器句柄——连字开关要在两者间热切换）
  const termsRef = useRef<Map<string, {
    term: Terminal; el: HTMLDivElement; search: SearchAddon; tag: HTMLDivElement;
    tagLabel: HTMLSpanElement; zoomBtn: HTMLButtonElement; detachBtn: HTMLButtonElement;
    splitMaxBtn: HTMLButtonElement; splitSwapBtn: HTMLButtonElement; splitExitBtn: HTMLButtonElement;
    scrim: HTMLDivElement; scrimState: HTMLElement; scrimHint: HTMLElement;
    scrimReconnect: HTMLButtonElement;
    feed: OutputFeed | null; webgl: WebglAddon | null; liga: LigaturesAddon | null;
  }>>(new Map());
  // tmux 面板（一标签多 tmux 会话）：格子 xterm 实例表，键 = `${sid}:${paneId}`。
  // 与 termsRef 同纪律：命令式 DOM 挂进 #term，React 不渲染这些层；随会话快照对账
  // 增删（bornAt 与 panesSnapAtRef 同为 performance.now()：快照请求晚于格子出生，
  // 缺席才算真缺席——乐观开格后才返回的在途旧快照不误杀，乱序到达同样成立）
  const paneTermsRef = useRef<Map<string, PaneTermEntry>>(new Map());
  // 「回滚已满」每会话只提示一次（P2）：调大/改小回滚行数时清空，允许重新提示。
  const scrollbackWarnRef = useRef<Set<string>>(new Set());
  // 分屏窗格遮罩的「重连」动作经 ref 取最新实现（makeTerm 早于 reconnectSession 声明）。
  const paneReconnectRef = useRef<(s: SessionInfo) => void>(() => {});
  // 全终端重画出口（字形图集自愈）：实现挂在字形自愈 effect 里；原生全屏
  // 进出（Tauri setFullscreen/绿灯/Esc）不走 DOM fullscreenchange，由窗口
  // resize 探针在检测到全屏态翻转时调用这里。
  const repaintAllRef = useRef<() => void>(() => {});
  // 每个标签最后一次落焦的子窗口（键 = "main" 或 `${sid}:${paneId}`）：切走再切回时
  // 恢复用户当时选中的 tmux 格子，而不是永远落回主视图（用户反馈：上次选定的
  // 子窗口会丢失）。focusin 事件维护，切标签的 focusSession 消费。
  const paneLastFocusRef = useRef<Map<string, string>>(new Map());
  const panesSnapAtRef = useRef(0);
  // ---- tmux 联动（恢复现场轮）----
  // 恢复动作经 ref 供 applyStateEvent 调用（该回调定义在组件顶部、函数体晚于
  // 恢复函数声明执行——deps 不引用即无 TDZ；同 dispatchRef 惯例）。
  const restoreTmuxRef = useRef<((s: SessionInfo, name?: string, auto?: boolean) => Promise<void>) | null>(null);
  const tmuxRestoringRef = useRef<Set<string>>(new Set()); // 在飞恢复去重（事件+轮询双路防重）
  const tmuxProbedRef = useRef<Set<string>>(new Set());    // 每会话只静默探测一次
  const tmuxPrefsRef = useRef<{ auto: Set<string>; last: Record<string, string>; declined: Record<string, number> }>({ auto: new Set(), last: {}, declined: {} });
  const [sid, setSid] = useState<string | null>(null);
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const sessionsRef = useRef<SessionInfo[]>([]);
  useEffect(() => { sessionsRef.current = sessions; applyPanesRef.current(); }, [sessions]);
  // R26（§6.4）：自动重连进行计数（session-state 事件驱动；null=无自动重连在途）
  const [autoReconn, setAutoReconn] = useState<{ sid: string; attempt: number; max: number } | null>(null);
  // 事件应用：会话状态即时更新（免 3s 轮询盲窗）+ 重连计数推进；
  // 终态（Reconfirming/Disconnected/Connected/Closed）清除本会话在途计数
  const applyStateEvent = useCallback((ev: SessionStateEvent) => {
    const prev = sessionsRef.current.find((x) => x.id === ev.session_id);
    setSessions((cur) => applyTabOrder(cur.map((s) => (s.id === ev.session_id ? { ...s, state: ev.state } : s))));
    setAutoReconn((cur) => {
      if (ev.state === "Reconnecting") {
        return { sid: ev.session_id, attempt: ev.attempt ?? 0, max: ev.max_attempts ?? 3 };
      }
      return cur?.sid === ev.session_id ? null : cur;
    });
    // tmux 联动：勾了「下次断线自动恢复现场」的主机，断线→重连成功即静默恢复
    //（真实域泵自动重连走这里——tauri 事件即时到达，prev 判定可靠；手动重连的
    // 确定性路径在 reconnectSession 内，demo 域 300ms 轮询的 prev 竞态由彼兜住）。
    // 延迟 1.2s 让重注入/启动命令先落定，capture-pane 才抓得到干净的目标窗格。
    if (ev.state === "Reconfirming" && prev && (prev.state === "Disconnected" || prev.state === "Reconnecting")
      && prev.kind === "ssh" && tmuxPrefsRef.current.auto.has(prev.host_id)
      && !tmuxRestoringRef.current.has(ev.session_id)) {
      window.setTimeout(() => {
        const s = sessionsRef.current.find((x) => x.id === ev.session_id);
        if (s) void restoreTmuxRef.current?.(s, undefined, true);
      }, 1200);
    }
  }, []);
  // 真实环境：session-state 事件（连接事件同款 transformCallback 通道）
  useEffect(() => {
    if (!inTauri) return;
    return tauriListen(listen<SessionStateEvent>("session-state", (e) => applyStateEvent(e.payload)));
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
  // 分屏（T19；本轮起每标签独立分组）：一个 SplitGroup = 一次两格分屏，组内保存
  // 方向/占比/组名/最大化态；一个 session 至多属于一个组。A|B、C|D 可共存，切标签
  // 只切「当前显示哪一组」，不替换任何窗格。state 与 ref 并行（ref 供 fitTerminal/
  // 指针回调读最新值）；所有写操作只经 commitSplitGroups。
  const [splitGroups, setSplitGroups] = useState<SplitGroup[]>([]);
  const splitGroupsRef = useRef<SplitGroup[]>([]);
  const splitGroupSeqRef = useRef(0);
  // 组标签点击时恢复「上次焦点格」——focusSession 是唯一写点；组解散/剪除时随 gid 回收
  const groupFocusRef = useRef<Map<string, string>>(new Map());
  const commitSplitGroups = useCallback((next: SplitGroup[]) => {
    splitGroupsRef.current = next;
    setSplitGroups(next);
  }, []);
  const groupOf = useCallback((sessionSid: string | null | undefined): SplitGroup | null => {
    if (!sessionSid) return null;
    return splitGroupsRef.current.find((g) => g.main === sessionSid || g.second === sessionSid) ?? null;
  }, []);
  const groupById = useCallback((gid: string): SplitGroup | null =>
    splitGroupsRef.current.find((g) => g.id === gid) ?? null, []);
  const slotOf = (g: SplitGroup, sessionSid: string): "main" | "second" | null =>
    g.main === sessionSid ? "main" : g.second === sessionSid ? "second" : null;
  const patchGroup = useCallback((gid: string, patch: Partial<Omit<SplitGroup, "id">>) => {
    if (!splitGroupsRef.current.some((g) => g.id === gid)) return;
    commitSplitGroups(splitGroupsRef.current.map((g) => (g.id === gid ? { ...g, ...patch } : g)));
  }, [commitSplitGroups]);
  // 建组前先把两个成员从各自旧组移出（跨组移动=旧组解散，其伴侣回单窗格）
  const createGroup = useCallback((main: string, second: string, dir: SplitDir, frac = 0.5): SplitGroup | null => {
    if (!main || !second || main === second) return null;
    const rest = splitGroupsRef.current.filter(
      (g) => !(g.main === main || g.second === main || g.main === second || g.second === second),
    );
    const g: SplitGroup = { id: `sg-${++splitGroupSeqRef.current}`, main, second, dir, frac, name: null, maximized: null };
    commitSplitGroups([...rest, g]);
    return g;
  }, [commitSplitGroups]);
  const dissolveGroup = useCallback((gid: string) => {
    if (!splitGroupsRef.current.some((g) => g.id === gid)) return;
    groupFocusRef.current.delete(gid);
    commitSplitGroups(splitGroupsRef.current.filter((g) => g.id !== gid));
  }, [commitSplitGroups]);
  const detachFromAllGroups = useCallback((sessionSid: string): SplitGroup | null => {
    const g = groupOf(sessionSid);
    if (!g) return null;
    groupFocusRef.current.delete(g.id);
    commitSplitGroups(splitGroupsRef.current.filter((x) => x.id !== g.id));
    return g;
  }, [commitSplitGroups, groupOf]);
  const pruneGroups = useCallback((dead: Set<string>) => {
    const next = splitGroupsRef.current.filter((g) => !dead.has(g.main) && !dead.has(g.second));
    if (next.length !== splitGroupsRef.current.length) {
      const alive = new Set(next.map((g) => g.id));
      for (const gid of groupFocusRef.current.keys()) if (!alive.has(gid)) groupFocusRef.current.delete(gid);
      commitSplitGroups(next);
    }
  }, [commitSplitGroups]);
  // 当前显示的组由活动会话派生；props/JSX 继续使用 SplitPanes 形状（SplitGroup 超集）
  const splitPanes = useMemo(
    () => (sid ? splitGroups.find((g) => g.main === sid || g.second === sid) ?? null : null),
    [splitGroups, sid],
  );
  // 标签条条目：独立会话一项、分屏组一项（Termius 式工作区）
  const tabEntries = useMemo(() => deriveTabEntries(sessions, splitGroups), [sessions, splitGroups]);
  // 切到某组时，方向选择器跟随该组自己的方向（各组独立旋转）；改名编辑态只属于
  // 发起它的组，切走即取消（否则输入框会冒在新组胶囊上、Enter 写回旧组）
  useEffect(() => {
    if (!splitPanes) {
      if (groupRenamingGidRef.current) finishGroupRename(null);
      return;
    }
    if (splitDirRef.current !== splitPanes.dir) {
      splitDirRef.current = splitPanes.dir;
      setSplitDir(splitPanes.dir);
    }
    if (groupRenamingGidRef.current && groupRenamingGidRef.current !== splitPanes.id) {
      // 切组=取消改名：顺带还原被临时撤下的最大化态并重估新组退化
      finishGroupRename(null);
    }
  }, [splitPanes?.id, splitPanes?.dir]);
  const [splitDir, setSplitDir] = useState<SplitDir>("lr");
  const splitDirRef = useRef<SplitDir>("lr");
  const splitFracRef = useRef(0.5);
  const paneDivRef = useRef<HTMLDivElement | null>(null);
  // 分屏组命名：groupRenaming 是编辑中的文本，gid 记在 ref 里（提交/取消都写回该组）。
  // 改名入口有两处：分割条胶囊（chip）与组标签双击（tab）——source 决定输入框渲染位置，
  // 防止两处 autoFocus 抢焦点、blur 误提交。
  const [groupRenaming, setGroupRenaming] = useState<string | null>(null);
  const groupRenamingGidRef = useRef<string | null>(null);
  const [groupRenamingGid, setGroupRenamingGid] = useState<string | null>(null);
  const [groupRenameSource, setGroupRenameSource] = useState<"tab" | "chip">("chip");
  // 改名从最大化态开始时临时撤下的槽位，结束后还原
  const groupRenameRestoreMaxRef = useRef<"main" | "second" | null>(null);
  // 命令式窗格按钮经 ref 取最新处理函数（makeTerm 早于这些 useCallback 声明）
  const splitPaneActionRef = useRef<{
    toggleMax: (sessionSid: string) => void;
    swap: (sessionSid: string) => void;
    exit: (sessionSid: string) => void;
  }>({ toggleMax: () => {}, swap: () => {}, exit: () => {} });
  // 把占比写进 #term 的 --split-frac（CSS 几何与分割条定位都吃这个变量）。
  // 参数省略=当前组；null=无组（写回 0.5）；number=拖拽中的即时值（松手才提交到组）
  const applySplitFrac = useCallback((g?: SplitGroup | null | number) => {
    const grp = typeof g === "number" ? null : g === undefined ? groupOf(sidRef.current) : g;
    const frac = typeof g === "number" ? g : grp?.frac ?? 0.5;
    splitFracRef.current = frac;
    const el = termRef.current;
    if (el) el.style.setProperty("--split-frac", frac.toFixed(4));
    paneDivRef.current?.setAttribute("aria-valuenow", String(Math.round(frac * 100)));
  }, [groupOf]);
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
  }, [measureTabbar]);
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
  // R35 §194：传输队列在工作区底部抽屉；后台事件只更新状态条计数，不自动展开
  const [queueOpen, setQueueOpen] = useState(false);
  // R33 §246：按路径下载入口移入文件面板（默认收起）
  const [byPathOpen, setByPathOpen] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  // 拖放落点预览：文件面板与终端区的目标目录不同（面板=正在浏览的目录），覆盖层
  // 文案必须跟着指针说真话；面板本身也给一圈虚线高亮。
  const [dragZone, setDragZone] = useState<"term" | "panel">("term");
  const [downloadPath, setDownloadPath] = useState("");
  // 远程文件浏览器（T41 FR-7；C4 R30 路径/元数据；R31 §348/§350 导航/选择/持久化）：
  // 浏览状态按 session ID 保存（切走快照、切回恢复——路径/选择/历史）；筛选/隐藏/排序为
  // 全局视图偏好不随会话走
  const [sftpPath, setSftpPath] = useState("");
  const [sftpPathInput, setSftpPathInput] = useState("");
  const [sftpEntries, setSftpEntries] = useState<DirEntryS[] | null>(null);
  const [sftpLoading, setSftpLoading] = useState(false);
  const [sftpErr, setSftpErr] = useState<string | null>(null);
  const [sftpSel, setSftpSel] = useState<Set<string>>(new Set());
  const [sftpHist, setSftpHist] = useState<string[]>([]);
  const [sftpFwd, setSftpFwd] = useState<string[]>([]);
  const [sftpCursor, setSftpCursor] = useState(-1);
  const sftpSavedRef = useRef<Map<string, { path: string; entries: DirEntryS[] | null; err: string | null; sel: string[]; hist: string[]; fwd: string[]; anchor: string | null }>>(new Map());
  const sftpPrevSidRef = useRef<string | null>(null);
  const sftpAnchorRef = useRef<string | null>(null);
  const sftpPathRef = useRef("");
  // 视图偏好（全局）：面包屑↔编辑路径框、名称筛选、显示隐藏项、排序键/方向
  const [sftpEditPath, setSftpEditPath] = useState(false);
  const [sftpFilter, setSftpFilter] = useState("");
  const [sftpShowHidden, setShowHidden] = useState(false);
  // 二十一轮：另存为模式（全局视图偏好）——开启后行内下载按钮/下载所选/手输路径/
  // 菜单「下载」都改为弹原生保存对话框；右键「另存为…」无条件直通，不受开关影响
  const [sftpSaveAs, setSftpSaveAs] = useState(false);
  const [sftpSort, setSftpSort] = useState<{ key: "name" | "size" | "mtime"; dir: 1 | -1 }>({ key: "name", dir: 1 });
  const [sftpMenu, setSftpMenu] = useState<{ name: string; x: number; y: number } | null>(null);
  const [sftpListW, setSftpListW] = useState(9999);
  // R33（§354/§356）上传下载入口：拖入终端的确认卡——目标会话在拖放开始时固定（§354
  // 「不随切标签转移」），目录输入预填可信 cwd（brief.cwd → 可见面板浏览目录；都无=
  // 空输入必填，不从不可见面板借用旧路径）
  const [pendingDrop, setPendingDrop] = useState<{ paths: string[]; sid: string } | null>(null);
  const [pendingDropDir, setPendingDropDir] = useState("");
  const [pendingDropErr, setPendingDropErr] = useState<string | null>(null);
  const dropConfirmBusyRef = useRef(false);
  const dropConfirmRef = useRef<HTMLDivElement | null>(null);
  // 上次下载目录（§356；blob transfers 域持久化，首次=null=核心落系统 Downloads）
  const downloadDirRef = useRef<string | null>(null);
  // 端口转发（T42 FR-8）：按 sid 归属；3s 轮询状态（断线→Failed 的变化要能看到）
  const [forwards, setForwards] = useState<ForwardInfo[]>([]);
  const [fwdKind, setFwdKind] = useState<"Local" | "Remote" | "Dynamic">("Local");
  const [fwdPort, setFwdPort] = useState("");
  // R40（§6.6）：监听地址是显式字段，默认回环 127.0.0.1
  const [fwdLAddr, setFwdLAddr] = useState("127.0.0.1");
  const [fwdHost, setFwdHost] = useState("");
  const [fwdTPort, setFwdTPort] = useState("");
  const [fwdBusy, setFwdBusy] = useState(false);
  // R40：非回环监听「必须主动选择」——勾选后才放行启动（暴露范围提示见表单）
  const [fwdExposeAck, setFwdExposeAck] = useState(false);
  // R40：字段级错误（§6.6「端口冲突关联到对应字段」）——就地高亮而非只弹通用提示
  const [fwdFieldErr, setFwdFieldErr] = useState<{ listen?: string; target?: string } | null>(null);
  // R40：停止等待核心结果——停止中集合 + 失败可重试（记最后错误供行内提示）
  const [fwdStopping, setFwdStopping] = useState<Set<string>>(new Set());
  const [fwdStopErr, setFwdStopErr] = useState<Record<string, string>>({});
  // R41（§6.6/S09）连接详情：独立可关闭对话框（不放右栏，避免与审批共用长滚动页）
  const [detail, setDetail] = useState<SessionDetail | null>(null);
  const [detailErr, setDetailErr] = useState<string | null>(null);
  const [detailSid, setDetailSid] = useState<string | null>(null);
  // R41（§6.6）活动记录：独立工作区视图，**自带**过滤/翻页状态（不再寄生协作面板）
  const [logScope, setLogScope] = useState<"current" | "all">("current");
  const [logActor, setLogActor] = useState<"" | "human" | "agent">("");
  const [logAction, setLogAction] = useState<string>("");
  const [logEvents, setLogEvents] = useState<AuditEvent[]>([]);
  const [logTotal, setLogTotal] = useState(0);
  const [logBusy, setLogBusy] = useState(false);
  const [logErr, setLogErr] = useState<string | null>(null);
  // R41（§6.6「保留主机/会话身份」）：会话关闭后即从 sessions 消失，但记录里仍要显示
  // 它**连接时**的身份——故累积 sid→主机名 的留痕表，只增不删；查不到时如实显示短 id。
  const [sessionIdent, setSessionIdent] = useState<Map<string, string>>(() => new Map());
  // R41（§6.6/S11）设置：左侧分类 + 右侧内容单对话框；凭据类目下的新建/删除**显式提交**
  const [settingsCat, setSettingsCat] = useState<SettingsCat>("appearance");
  const [credNewOpen, setCredNewOpen] = useState(false);
  const [credLabel, setCredLabel] = useState("");
  const [credPem, setCredPem] = useState("");
  const [credPass, setCredPass] = useState("");
  const [credBusy, setCredBusy] = useState(false);
  const [credNewErr, setCredNewErr] = useState<string | null>(null);
  const [credNewOk, setCredNewOk] = useState<IdentityMeta | null>(null);
  // §231「切分类遇未提交敏感表单时先处理草稿」：待切换的目标分类（非空即弹草稿确认）
  const [credDraftTo, setCredDraftTo] = useState<SettingsCat | null>(null);
  // Toast（精致化 §六/P3）：右下角轻通知；普通 2.6s 自动消失，带动作 8s（留出点击
  // 时间）；最多同屏 4 条。动作（0.10.0 轮）：下载完成 toast 附「打开所在文件夹」，
  // 不用为点定位先展开传输抽屉
  const [toasts, setToasts] = useState<{ id: number; kind: "ok" | "err" | "info"; text: string;
    action?: { label: string; title: string; run: () => void } }[]>([]);
  const toastSeq = useRef(0);
  const pushToast = useCallback((kind: "ok" | "err" | "info", text: string,
    action?: { label: string; title: string; run: () => void }) => {
    const id = ++toastSeq.current;
    // DEV 探针：toast 只有 2.6s 生命，满套 UI 负载下 evaluate 往返可能比这更久，
    // 只看 DOM 的断言会漏掉「已经出现过又消失」的 toast。留一份有限历史供 spec
    // 在事后判定；生产构建不挂。
    if (import.meta.env.DEV) {
      const probe = window as unknown as { __t_toasts?: Array<{ kind: string; text: string; at: number }> };
      probe.__t_toasts ??= [];
      probe.__t_toasts.push({ kind, text, at: Date.now() });
      if (probe.__t_toasts.length > 40) probe.__t_toasts.shift();
    }
    setToasts((cur) => [...cur.slice(-3), { id, kind, text, action }]);
    // 错误常常是长句（后端原文/shell 失败原因），2.6s 读不完且无法复制；给 6s
    // 并允许点 × 手动关闭（栈本身仍 pointer-events:none，不挡背后操作）。
    setTimeout(() => setToasts((cur) => cur.filter((t) => t.id !== id)), action ? 8000 : kind === "err" ? 6000 : 2600);
  }, []);
  // ⌘F 终端内搜索（T16）：SearchAddon 每会话一个实例，随会话保持高亮
  const [searchOpen, setSearchOpen] = useState(false);
  // 搜索所属会话：切标签/关标签时据此清旧高亮，关闭搜索时焦点也回到“发起搜索”的
  // 标签（tmux 格子记忆/放大态由 focusTermFor 恢复，不再固定主终端）。
  const searchSidRef = useRef<string | null>(null);
  // 查找目标：tmux 面板格聚焦时搜该格，而不是永远搜背后的主视图。键 =
  // "main" 或 `${sid}:${paneId}`；searchAddonRef 指向当前真正被搜的实例。
  const searchTargetKeyRef = useRef<string | null>(null);
  const searchAddonRef = useRef<SearchAddon | null>(null);
  // 首次接入提示（悬浮条，不占终端行——写进流会带偏 shell 光标视角）
  const [attachHint, setAttachHint] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<{ resultCount: number; resultIndex: number | undefined } | null>(null);
  // 查找条开关与非法正则态（本轮）：ref 与 state 同步，事件回调读到最新开关
  const [searchPrefs, setSearchPrefs] = useState<SearchPrefs>(SEARCH_PREFS_DEFAULT);
  const searchPrefsRef = useRef<SearchPrefs>(SEARCH_PREFS_DEFAULT);
  const [searchInvalid, setSearchInvalid] = useState(false);
  const searchInputRef = useRef<HTMLInputElement>(null);
  // R25 §318 粘贴保护：多行内容 + 远端未开 bracketed paste → 预览确认后才发送；
  // 开关持久化在 workspace blob（ui.v2.terminal.paste_guard，默认开）
  const [pasteGuard, setPasteGuard] = useState(true);
  const pasteGuardRef = useRef(true);
  // 十五轮：选中即复制（PuTTY/Xshell 惯例）——开关持久化在 workspace blob terminal 域（默认关）
  const [copyOnSelect, setCopyOnSelect] = useState(false);
  const copyOnSelectRef = useRef(false);
  // 十六轮：终端响铃（BEL）→ 系统通知开关（默认关；标签闪烁恒开）
  const [bellNotify, setBellNotify] = useState(false);
  const bellNotifyRef = useRef(false);
  const [bellSids, setBellSids] = useState<Set<string>>(new Set());
  const lastBellNotifRef = useRef<Map<string, number>>(new Map());
  // 块失败 toast 的每会话节流（系统通知的节流在 flashAndNotify 内建，两者独立）
  const lastFailToastRef = useRef<Map<string, number>>(new Map());
  // P2-c：OSC 52 写剪贴板策略（allow/ask/deny，默认 ask；workspace blob terminal 域）。
  // 远端程序可借转义序列改写本机剪贴板（tmux/ssh 远端复制回本地靠它），也是剪贴板
  // 投毒的入口——默认每次询问，读取（查询）一律拒绝。
  const [osc52Policy, setOsc52Policy] = useState<"allow" | "ask" | "deny">("ask");
  const osc52PolicyRef = useRef<"allow" | "ask" | "deny">("ask");
  // 写入前的询问卡（同刻新请求覆盖旧待决——last-wins，预览只展最新一条）
  const [osc52Queue, setOsc52Queue] = useState<{ sid: string; text: string; source?: string }[]>([]);
  // 只渲染队首：多个格子/主机同时请求时逐张处理（旧实现单槽，后到直接覆盖前一张，
  // 前一个远端请求的预览与裁决被静默吞掉）。上限 8 条——不允许远端无限堆卡。
  const osc52Ask = osc52Queue[0] ?? null;
  const shiftOsc52Ask = useCallback(() => setOsc52Queue((q) => q.slice(1)), []);
  const osc52AskRef = useRef<HTMLDivElement | null>(null);
  const [pasteConfirm, setPasteConfirm] = useState<{ sid: string; hostName: string; text: string; risk: PasteHit[]; multi: boolean; kind: "paste" | "rerun" | "wall"; paneKey?: string } | null>(null);
  // P0 终端品质轮：粘贴危险形态的**廉价预筛**——命中词根才过 Rust 扫描（判定唯一在
  // Rust：approval::scan_dangerous 的同一张内置 deny 表 + tree-sitter 逐段 + wrapper
  // 前缀；这里只决定「要不要问」，不做第二份规则）。漏筛=少一次提示，误筛=多一次 IPC。
  const PASTE_DANGER_PREFILTER = /\b(?:rm|dd|mkfs|wipefs|blkdiscard|shred|fdisk|cfdisk|sfdisk|sgdisk|parted|shutdown|reboot|halt|poweroff|chmod|systemctl|sudo|doas|nohup)\b|:\(\)/;
  // P2-a 广播输入（iTerm 同款）：勾选若干会话后，在当前会话打字的每个键序（onData
  // 字符、Ctrl 控制键、⌥ Meta 序列）同时复制发到勾选会话。扇出只是 UI 层多打几次
  // 既有 send_keys——每个目标走同一条 Human 路径（register_outgoing 记块、按各自主
  // 机字符集编码），归属天然正确，不新增后端面。勾选集=「额外目标」：当前会话无论
  // 勾选与否都接收（你打字总在它里面），勾选的含义是「切走后仍接收」。
  const [broadcastTargets, setBroadcastTargets] = useState<string[]>([]);
  const broadcastRef = useRef<string[]>([]);            // onData/Ctrl/⌥ 闭包读 ref，避免 stale state
  const [broadcastOpen, setBroadcastOpen] = useState(false);
  const broadcastPopRef = useRef<HTMLDivElement | null>(null);
  // 目标离线的一次性告示记（写入目标自己的终端，切过去能看见）；恢复可达即清除
  const bcastWarnedRef = useRef<Map<string, boolean>>(new Map());
  // 粘贴永不广播：term.paste 触发的 onData 携带整段内容，而危险/多行确认链都是单
  // 会话语义——统一「粘贴只进当前会话」，发粘贴期间压住扇出（paste→onData 同步，
  // 微任务复位即可）。块重跑走 send_keys 直发，不经 onData，天然不广播。
  const bcastSuppressRef = useRef(false);
  // 扇出实现挂在 ref 上：onData 闭包在 createTerm([]) 里定型，不能依赖后声明的 state
  const broadcastSendRef = useRef<(from: string, keys: string) => void>(() => {});
  useEffect(() => {
    broadcastSendRef.current = (from: string, keys: string) => {
      for (const bSid of broadcastRef.current) {
        if (bSid === from) continue;
        const st = sessionsRef.current.find((x) => x.id === bSid)?.state;
        if (!st || inputBlockedState(st)) {
          if (!bcastWarnedRef.current.get(bSid)) {
            bcastWarnedRef.current.set(bSid, true);
            termsRef.current.get(bSid)?.term.write(`\r\n\x1b[33m⚠ ${t("广播：该会话{0}——键入未发送。", !st ? t("已不存在") : t("离线/断线中"))}\x1b[0m\r\n`);
          }
          continue;
        }
        bcastWarnedRef.current.delete(bSid);
        void invoke("send_keys", { sid: bSid, keys }).catch(() => {});
      }
    };
  }, []);
  // P2-c：OSC 52 实际写入同样经 ref（makeTerm([]) 闭包只认 ref）。写成功给 toast——
  // 剪贴板被远端改写这件事必须让用户知道；失败如实报（WebView 权限/窗口无焦点都可能）。
  const osc52WriteRef = useRef<(sid: string, text: string) => void>(() => {});
  // P2-c：OSC 52 载荷消费（主终端与 tmux 面板格子同一策略）。载荷 `选择区;base64`：
  // `?` = 查询（读）一律拒绝（远端不得读本机剪贴板）；空载荷吞掉（不做「清空剪贴板」
  // 语义——同样是破坏面）；其余 base64 → UTF-8 解码后按策略 allow=直写、ask=询问卡、
  // deny=静默吞（与主流终端一致）。handler 须同步返回已消费，写入异步走 osc52WriteRef。
  // source = tmux 面板格子的会话名（询问卡标出是哪个格子要写——同标签多格时分得清）。
  const osc52ConsumeRef = useRef((sessionSid: string, data: string, source?: string): boolean => {
    try {
      let b64 = data.slice(data.indexOf(";") + 1).replace(/\s+/g, "");
      if (!b64 || b64 === "?") return true;
      // 稳定轮：载荷上限 256KB——恶意远端推数 MB 序列曾全量解码并驻留 state
      //（ask 卡预览截 400 字符，但解码串与「允许」时的写入全文无界）
      if (b64.length > 256 * 1024) return true;
      b64 = b64.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (b64.length % 4)) % 4);
      const text = new TextDecoder().decode(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)));
      if (osc52PolicyRef.current === "allow") osc52WriteRef.current(sessionSid, text);
      else if (osc52PolicyRef.current === "ask") {
        setOsc52Queue((q) => q.length >= 8 ? q : [...q, { sid: sessionSid, text, source }]);
      }
    } catch { /* 非法 base64：吞 */ }
    return true;
  });
  useEffect(() => {
    osc52WriteRef.current = (sid, text) => {
      const host = sessionsRef.current.find((x) => x.id === sid)?.host_name ?? t("该会话");
      // Promise.resolve 包裹（审查二轮 FE2-5）：无 clipboard API 环境（LAN http
      // 等非安全上下文）navigator.clipboard 为 undefined，?. 短路出 undefined 后
      // 外层 .then/.catch 即同步 TypeError——包一层让链路拿到 rejected promise
      Promise.resolve(inTauri ? clipboard.writeText(text) : navigator.clipboard?.writeText(text))
        .then(() => pushToast("info", t("远端已写入剪贴板（OSC 52）· {0}", host)))
        .catch(() => pushToast("err", t("OSC 52 写剪贴板失败 · {0}（权限拒绝或窗口无焦点）", host)));
    };
  }, [pushToast]);
  const toggleBroadcast = useCallback((t: string) => {
    setBroadcastTargets((cur) => {
      const next = cur.includes(t) ? cur.filter((x) => x !== t) : [...cur, t];
      broadcastRef.current = next;
      if (cur.includes(t)) bcastWarnedRef.current.delete(t);
      return next;
    });
  }, []);
  const clearBroadcast = useCallback(() => {
    broadcastRef.current = [];
    bcastWarnedRef.current.clear();
    setBroadcastTargets([]);
  }, []);
  // 会话关闭后从广播集剔除（告示记一并清理）；无变化不 setState
  useEffect(() => {
    const live = new Set(sessions.map((s) => s.id));
    const next = broadcastRef.current.filter((t) => live.has(t));
    if (next.length !== broadcastRef.current.length) {
      broadcastRef.current = next;
      setBroadcastTargets(next);
    }
    for (const k of [...bcastWarnedRef.current.keys()]) if (!live.has(k)) bcastWarnedRef.current.delete(k);
  }, [sessions]);
  // 浮层点外关闭（chip 在浮层外，点它交给自身 toggle，不能双触发）
  useEffect(() => {
    if (!broadcastOpen) return;
    const onDown = (ev: MouseEvent) => {
      const t = ev.target as Node;
      if (broadcastPopRef.current?.contains(t)) return;
      if (document.querySelector('[data-testid="sb-broadcast"]')?.contains(t)) return;
      setBroadcastOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [broadcastOpen]);

  // P2-b 输出触发器：设置卡读写（读失败如实给空表——卡内可重存修复；错误文案由保存路径给）
  const loadTriggers = useCallback(async (): Promise<TriggerRule[]> => {
    try { return (await invoke("read_triggers", {})) as TriggerRule[]; }
    catch { return []; }
  }, []);
  const saveTriggers = useCallback(
    (rules: TriggerRule[]) => invoke("save_triggers", { rules }) as Promise<TriggerRule[]>,
    [],
  );
  // 十一轮续：粘贴入口统一（⌘V 与终端右键共用）——bracketed paste 语义由 xterm 按远端
  // DECSET 2004 自适配（不补换行不代执行）；远端未开启时多行内容 = 换行立即执行——预览确认后才发。
  // P0 轮：命中内置危险形态（Rust 判定）同样先确认再发——即便远端开着 bracketed paste，
  // 贴进来的 `sudo rm -rf /` 也值得多看一眼（信任模型：人类自己也不盲贴）。
  const pasteTextInto = (term: Terminal, sessionSid: string, text: string, paneKey?: string) => {
    if (!text) return;
    // rev-r26 低-5：断线/重连期粘贴与键入同口径拦截（确认框照弹会误导——
    // 确认后字节仍被 onData 拦下）；⚠ 与 onData 告示同文。tmux 面板格子另看
    // 格子自身存活（掉线死亡的格子 onData 同样拦下）
    const pst = sessionsRef.current.find((x) => x.id === sessionSid)?.state;
    const paneDead = !!paneKey && paneTermsRef.current.get(paneKey)?.alive === false;
    if ((pst && inputBlockedState(pst)) || paneDead) {
      const why = paneDead ? t("窗格已断开") : pst === "Disconnected" ? t("会话已断开") : t("网络中断（自动重连中）");
      term.write(`\r\n\x1b[33m⚠ ${t("{0}——粘贴未发送。", why)}\x1b[0m\r\n`);
      return;
    }
    const multi = pasteGuardRef.current && /[\n\r]/.test(text) && !term.modes.bracketedPasteMode;
    const deliver = (risk: PasteHit[]) => {
      if (multi || risk.length) {
        const h = sessionsRef.current.find((x) => x.id === sessionSid);
        const paneName = paneKey ? paneTermsRef.current.get(paneKey)?.name : undefined;
        setPasteConfirm({
          sid: sessionSid,
          hostName: paneName ? `${h?.host_name ?? sessionSid.slice(0, 8)} · tmux:${paneName}` : (h?.host_name ?? sessionSid.slice(0, 8)),
          text,
          risk,
          multi,
          kind: "paste",
          paneKey,
        });
      } else {
        bcastSuppressRef.current = true;
        try { term.paste(text); } finally { queueMicrotask(() => { bcastSuppressRef.current = false; }); }
      }
    };
    if (pasteGuardRef.current && PASTE_DANGER_PREFILTER.test(text)) {
      invoke("scan_paste_danger", { text })
        .then((hits) => deliver(hits ?? []))
        .catch(() => deliver([])); // 扫描失败不阻断人类操作：退回多行确认口径
    } else {
      deliver([]);
    }
  };
  const pasteTextIntoRef = useRef(pasteTextInto);
  pasteTextIntoRef.current = pasteTextInto;
  // §7.4 弹窗 focus trap：带遮罩模态的容器 refs（hook 挂在组件顶层，active 随开合）
  const settingsPanelRef = useRef<HTMLDivElement | null>(null);
  // R41（§6.6/S09）：连接详情对话框（独立可关闭，焦点陷阱同其它对话框）
  const detailPanelRef = useRef<HTMLDivElement | null>(null);
  const closeConfirmRef = useRef<HTMLDivElement | null>(null);
  const delegateDlgRef = useRef<HTMLDivElement | null>(null);
  const quitConfirmRef = useRef<HTMLDivElement | null>(null);
  const delHostRef = useRef<HTMLDivElement | null>(null);
  const delIdentRef = useRef<HTMLDivElement | null>(null);
  const pasteConfirmRef = useRef<HTMLDivElement | null>(null);
  const dropCardRef = useRef<HTMLDivElement | null>(null);
  // 巡检补：TOFU 指纹 / 双因素 / 新建主机 / 快速连接四块 hk-mask 同为遮罩模态，
  // 此前没有焦点陷阱——Tab 会逃到遮罩后（可见性为零；zen-auto 藏条还会被
  // focus-within 意外拉出）。容器 ref 同上列，hook 见下方 useDialogFocus 区。
  const hkDlgRef = useRef<HTMLDivElement | null>(null);
  const authDlgRef = useRef<HTMLDivElement | null>(null);
  const addHostDlgRef = useRef<HTMLDivElement | null>(null);
  const quickDlgRef = useRef<HTMLDivElement | null>(null);
  // R25 §322 分屏建立：复用已有会话（菜单直选）。「预武装下一次新建」模式已退役
  // （十一轮 §6.3 修订：对象先存在、操作跟上来——新建会话先落标签，右键标签进分屏）
  const [splitMenu, setSplitMenu] = useState(false);
  const [tmuxMenu, setTmuxMenu] = useState(false);
  // tmux 会话大屏（监控墙）：绑定打开它的标签——换标签即关（快照拍的是那台
  // 主机，跨标签续放会拍错机器）。「进格子」复用 openTmuxPane 后收屏。
  const [tmuxWallSid, setTmuxWallSid] = useState<string | null>(null);
  const wallSession = sessions.find((x) => x.id === tmuxWallSid) ?? null;
  useEffect(() => { setTmuxWallSid(null); }, [sid]);

  // 十一轮：标签右键菜单——按状态显隐的会话操作（分屏/重连/复制连接/详情/关闭）
  const [tabMenu, setTabMenu] = useState<{ x: number; y: number; sid: string } | null>(null);
  // 十一轮续：右键通道补全——主机卡（连接/收藏/编辑/删除）与终端区（复制/粘贴/全选）
  const [hostMenu, setHostMenu] = useState<{ x: number; y: number; hostId: string } | null>(null);
  const [termMenu, setTermMenu] = useState<{ x: number; y: number; sid: string; hasSel: boolean; paneKey?: string } | null>(null);
  // 本轮：最近连接行右键菜单（连接/编辑主机/从最近连接隐藏/删除主机）
  const [recentMenu, setRecentMenu] = useState<{ x: number; y: number; hostId: string } | null>(null);
  // 十四轮：标签重命名——sid → 自定名（覆盖 host_name 展示；复制标签页后同名「本机×2」
  // 无法区分）。会话生命周期内有效（会话本就不跨重启存活），不入 vault。
  const [tabNames, setTabNames] = useState<Record<string, string>>({});
  // 会话增减不改 tabbar 盒子（RO 不触发）——单独补测一次，不再为此拆掉重建 observer。
  // 重命名（tabNames）同样只改标签宽高、不动容器盒子，必须并进依赖：否则「还有 N 个」
  // 箭头与边缘遮罩要等滚动或改窗宽才追上。
  useEffect(() => { measureTabbar(); }, [measureTabbar, sessions.length, tabNames]);
  const [renaming, setRenaming] = useState<{ sid: string; value: string } | null>(null);
  // 提交重命名：空串/纯空白 = 清除自定名回退 host_name（双击重命名与右键菜单共用）
  const commitTabRename = (sid: string, value: string) => {
    const v = value.trim();
    setTabNames((m) => {
      const next = { ...m };
      if (v) next[sid] = v; else delete next[sid];
      return next;
    });
    setRenaming(null);
  };
  // 分屏组重命名提交（键盘契约与标签重命名同款）：清空提交=退回自动命名。
  // gid 从 ref 取（编辑期间切换/解散组时 ref 会被清空，提交变成 no-op）。
  // 改名从最大化态发起时，胶囊所在的分割条被撤下——先临时还原两格，结束
  // （提交或取消）后把最大化态放回去；改名期间 checkSplitWidth 暂停，否则
  // 窄窗立即退化会把输入框连根卸载（焦点丢失、blur 误提交）。
  const finishGroupRename = (commit: string | null) => {
    const gid = groupRenamingGidRef.current;
    const restoreMax = groupRenameRestoreMaxRef.current;
    groupRenameRestoreMaxRef.current = null;
    if (gid && commit !== null) {
      const v = commit.trim();
      patchGroup(gid, { name: v ? v : null });
    }
    setGroupRenaming(null);
    setGroupRenamingGid(null);
    groupRenamingGidRef.current = null;
    if (gid && restoreMax) patchGroup(gid, { maximized: restoreMax });
    // 取消改名同样要重估退化：临时撤下的退化态不能一直留着
    checkSplitWidthRef.current();
    applyPanesRef.current();
    fitTerminal();
  };
  const beginGroupRename = (gid: string, initial: string, source: "tab" | "chip" = "chip") => {
    const g = groupById(gid);
    // 胶囊只存在于当前可视组；标签条改名可针对非活动组（输入框在标签内，无需先切组）
    if (!g || (source === "chip" && g.main !== sidRef.current && g.second !== sidRef.current)) return;
    // 最大化/退化态不渲染分割条与胶囊——先把布局还原，否则改名框无处出现且状态残留。
    // 标签条改名（source="tab"）不需要胶囊可见，跳过这次布局重排。
    groupRenameRestoreMaxRef.current = source === "chip" ? g.maximized : null;
    if (source === "chip" && (g.maximized || splitDegradedRef.current)) {
      if (g.maximized) patchGroup(gid, { maximized: null });
      splitDegradedRef.current = false;
      setSplitDegraded(false);
      applyPanesRef.current();
      fitTerminal();
    }
    groupRenamingGidRef.current = gid;
    setGroupRenamingGid(gid);
    setGroupRenameSource(source);
    setGroupRenaming(initial);
  };
  const commitGroupRename = (value: string) => finishGroupRename(value);
  const cancelGroupRename = () => finishGroupRename(null);
  // —— 十五轮：标签拖拽排序；拖拽组合分屏轮起改 pointer 自定义拖拽 ——
  // 会话期内的显示顺序事实源；list_sessions 整表刷新（连接/断开触发）后仍按此序渲染。
  // 不入 vault（会话本不跨重启）。⌘1-9 / ⌘⇧[] 读同一数组，快捷键序=所见序。
  // 弃 HTML5 DnD 的原因：wry 为 onDragDropEvent（文件拖入上传）在 WebView2 HWND 上
  // RevokeDragDrop+RegisterDragDrop 换掉了系统 IDropTarget，页内 dragstart 走 OS 拖放
  // 循环根本发不起来——真机拖不动的根因；pointer 事件不进该循环，三端行为一致。
  const tabOrderRef = useRef<string[]>([]);
  // 拖拽源按条目 key 记（组标签=g:<gid>，会话标签=s:<sid>）——组标签是整体，不再有成员标签
  const [tabDragKey, setTabDragKey] = useState<string | null>(null);
  const tabDragRef = useRef<{
    key: string; sid: string; startX: number; startY: number; pointerId: number;
    srcEl: HTMLElement; active: boolean;
  } | null>(null);
  // 拖后随至的 click 不当「激活标签」：时间戳而非布尔，避免残留吞掉下一次真实点击
  const dragClickSupUntilRef = useRef(0);
  const cancelTabDrag = useCallback(() => {
    const d = tabDragRef.current;
    if (!d) return;
    tabDragRef.current = null;
    try {
      if (d.srcEl.hasPointerCapture(d.pointerId)) d.srcEl.releasePointerCapture(d.pointerId);
    } catch { /* 指针已释放 */ }
    setTabDragKey(null);
    setTabDropHint(null);
    setTermDropHint(null);
    document.body.classList.remove("tab-dragging");
  }, []);
  // 元素级 pointerup 的兜底：拖动中源标签被关闭/卸载时事件可能不再投递，
  // 光标与落点遮罩会残留到下一次 Esc。window 冒泡阶段监听——正常路径元素处理器
  // 已先清掉 tabDragRef，这里只收拾异常收尾（不执行落点）。
  useEffect(() => {
    if (!tabDragKey) return;
    const onUp = (e: PointerEvent) => {
      const d = tabDragRef.current;
      if (d && d.pointerId === e.pointerId) cancelTabDrag();
    };
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    return () => {
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
  }, [tabDragKey, cancelTabDrag]);
  // 源会话被 UI 外路径关闭（Agent/MCP close_session）时立即收尾，不等指针事件
  useEffect(() => {
    const d = tabDragRef.current;
    if (d && !sessions.some((s) => s.id === d.sid)) cancelTabDrag();
  }, [sessions, cancelTabDrag]);
  // Esc 取消标签拖拽：capture 阶段拦下，避免同时关掉其它浮层
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || !tabDragRef.current?.active) return;
      e.preventDefault();
      e.stopPropagation();
      // 主 Esc 链同挂 window capture：同目标同阶段 stopPropagation 拦不住它
      e.stopImmediatePropagation();
      cancelTabDrag();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [cancelTabDrag]);
  const [tabDropHint, setTabDropHint] = useState<{ key: string; before: boolean } | null>(null);
  // 拖标签组合分屏：悬在 #term 上时的落点提示（l/r/t/b 象限；null=不在终端区）。
  // pointermove 高频触发——同值复用旧引用，避免整树重渲染（tabDropHint 同款守卫）
  const [termDropHint, setTermDropHint] = useState<"l" | "r" | "t" | "b" | null>(null);
  function applyTabOrder<T extends { id: string }>(list: T[]): T[] {
    const rank = tabOrderRef.current;
    if (!rank.length) return list;
    const pos = new Map(rank.map((id, i) => [id, i] as const));
    return [...list].sort((a, b) => (pos.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (pos.get(b.id) ?? Number.MAX_SAFE_INTEGER));
  }
  // 标签条目级重排：组标签整体移动；落下后把每组成员摊平成相邻 id 写回 tabOrderRef，
  // 下一次 deriveTabEntries 即按新条目序渲染（单标签场景与旧 reorderTabs 等价）。
  const reorderTabEntries = (fromKey: string, toKey: string, before: boolean) => {
    const entries = deriveTabEntries(sessionsRef.current, splitGroupsRef.current);
    const from = entries.findIndex((e) => e.key === fromKey);
    const to = entries.findIndex((e) => e.key === toKey);
    if (from < 0 || to < 0 || from === to) return;
    const [moved] = entries.splice(from, 1);
    let to2 = entries.findIndex((e) => e.key === toKey);
    if (!before) to2 += 1;
    entries.splice(to2, 0, moved);
    const ids: string[] = [];
    for (const e of entries) {
      if (e.kind === "session") ids.push(e.session.id);
      else for (const m of e.members) ids.push(m.id);
    }
    tabOrderRef.current = ids;
    setSessions(applyTabOrder(sessionsRef.current));
  };
  // R25 §185 宽度退化：每窗格至少 360 宽——空间不足时只呈现焦点窗格（另一个仍在
  // 当前分屏组中），加宽自动恢复；退化时显示一次可关闭的布局提示
  const [splitDegraded, setSplitDegraded] = useState(false);
  const splitDegradedRef = useRef(false);
  const [splitHintOpen, setSplitHintOpen] = useState(false);
  // §185「显示一次」：关闭后本会话内不再重现（rev-r25 M1：与 README 主张对齐）
  const splitHintDismissedRef = useRef(false);
  // 远程 OSC 0/2 标题（T16）：按会话记录，显示在终端头部
  const [oscTitles, setOscTitles] = useState<Record<string, string>>({});
  const [hosts, setHosts] = useState<Host[]>([]);
  const [hostsLoaded, setHostsLoaded] = useState(false);
  // list_hosts 最近一次失败（与 hostsLoaded 分开：失败也撤骨架，但主机栏给的是
  // 错误态 + 重试，而不是「还没有主机」的空态）
  const [hostsError, setHostsError] = useState(false);
  // 本地终端一等公民轮：本机 shell 探测清单（设置「本地 Shell」下拉 + 本机右键
  // 「用 … 新开」数据源）与默认选择 id（KV，空串=系统默认 $SHELL/PowerShell 回退）
  const [localShells, setLocalShells] = useState<LocalShell[]>([]);
  const [localShellId, setLocalShellId] = useState("");
  // 启动自动开本地终端（KV；默认开）：state 只服务设置面板回显；真正建连前
  // 在 auto-open effect 里直读 KV（与 shell 选择同口径，避开装载竞速）。
  const [autoLocal, setAutoLocal] = useState(true);
  // i18n 轮：界面语言（App state——变化触发全树重渲染，渲染期 t() 重读模块态；
  // 初值取 t() 模块初值（localStorage），真实域 KV 装载后以此为准覆盖。
  // changeLocale 在 persistSetting 声明之后——deps 数组渲染期求值，先声明会 TDZ）
  const [locale, setLocaleState] = useState<Locale>(localeNow);
  // R20（C8 消费）：收藏/最近元数据 + 标签筛选 chip
  const [hostMeta, setHostMeta] = useState<HostMeta[]>([]);
  const [recents, setRecents] = useState<RecentHost[]>([]);
  // 本轮：最近连接右键「从最近连接隐藏」——纯前端偏好（后端列表由 sessions 表
  // 派生，删行会伤会话历史语义）；重连该主机时自动恢复显示
  const [recentsHidden, setRecentsHidden] = useState<string[]>(() => {
    try { return JSON.parse(localStorage.getItem("ui.recentsHidden") ?? "[]") as string[]; } catch { return []; }
  });
  const setRecentHidden = (hostId: string, hidden: boolean) => {
    setRecentsHidden((prev) => {
      if (prev.includes(hostId) === hidden) return prev;
      const next = hidden ? [...prev, hostId] : prev.filter((x) => x !== hostId);
      try { localStorage.setItem("ui.recentsHidden", JSON.stringify(next)); } catch { /* 隐私模式忽略 */ }
      return next;
    });
    // 隐藏行立即消失且只能靠再连一次恢复——给一次可撤销的提示，误点有退路
    if (hidden) {
      pushToast("info", t("已从最近连接隐藏——重新连接该主机会自动恢复显示"), {
        label: t("撤销"), title: t("把它恢复到最近连接列表"), run: () => setRecentHidden(hostId, false),
      });
    }
  };
  const [tagFilter, setTagFilter] = useState<string | null>(null);
  const [approvals, setApprovals] = useState<ApprovalRow[]>([]);
  // ② 自主模式授权表（横幅）：非空即有 Agent 正在免逐条审批运行
  const [autonomy, setAutonomy] = useState<AutonomyGrant[]>([]);
  // ④ 记录审计时间线：打开设置「记录审计」分区或筛选变化时拉取（不进 3s 轮询——
  // 记录只在动作发生时增长，手动刷新 + 分区打开即拉已够）
  const [recordsRows, setRecordsRows] = useState<ActionRecord[] | null>(null);
  const [recordsFilter, setRecordsFilter] = useState<RecordsQuery>({ agentId: null, kind: null, limit: 200, range: "all", sessionId: null });
  const [recordsBusy, setRecordsBusy] = useState(false);
  const [recordsExportBusy, setRecordsExportBusy] = useState(false);
  // ⑥ 翻页：complete=true 表示最近一页不满页（已到底）；保留期（0=永久，启动读 vault）
  const [recordsComplete, setRecordsComplete] = useState(true);
  const [recordsMoreBusy, setRecordsMoreBusy] = useState(false);
  const [recordsRetention, setRecordsRetention] = useState(30);
  // ⑤ 自主模式传输免审 opt-in（vault 设置 collab.autonomy.transfers；默认关=逐条审批）
  const [transferAutonomy, setTransferAutonomy] = useState(false);
  // ⑧ 自主模式到期即时提示：轮询差分——上一轮在场、这一轮消失且非人工收回 → toast。
  // 人工收回在 toggle/kill 时登记进 KILLED，避免「点了急停还弹到期提示」的误报。
  const autonomyKnownRef = useRef<Set<string>>(new Set());
  const autonomyKilledRef = useRef<Set<string>>(new Set());
  const [brief, setBrief] = useState<Brief | null>(null);
  // 任务目标（R9：人类→Agent 委托留言）：draft 编辑中不被简报轮询覆盖，
  // 保存/清除后落盘（goalDirty 复位）再随简报同步；
  // T38-PV：未保存草稿按 sid 暂存（goalDrafts），切标签再切回不丢
  const [goalDraft, setGoalDraft] = useState("");
  const goalDirty = useRef(false);
  const goalDrafts = useRef<Map<string, string>>(new Map());
  const goalRef = useRef<HTMLTextAreaElement | null>(null);
  // 上一次渲染所对应的会话：必须用 state 而非 ref 参与「渲染期同步」比较。
  // ref 在渲染中写入后，若这次渲染被并发更新打断丢弃，goalDraft 的 setState 也
  // 一起丢，但 ref 已推进——下一次提交就成了「新 sid + 旧草稿」，H1 泄漏窗重现
  // （满载全量回归时 15-goal 逐帧采样偶发闪 1 帧）。state 比较在弃渲染后仍成立，
  // 会重新走一遍暂存/恢复。
  const [goalSid, setGoalSid] = useState<string | null>(null);
  // 简报 ref：拖拽上传回调里读当前 cwd（不进依赖数组，避免监听器随简报反复重订阅）
  const briefRef = useRef<Brief | null>(null);
  useEffect(() => { briefRef.current = brief; }, [brief]);
  // 控制权默认 Human（安全侧）：sessions 尚未加载/切到新会话时，不能沿用
  // 上一个会话的 Agent 状态去跳过「交给 Agent」确认条。
  const [owner, setOwner] = useState<"Human" | "Agent">("Human");
  const [mcp, setMcp] = useState<McpStatus>({ endpoint: "", agents: [] });
  // C9（R43）：协作启用生命周期（人类专属）。state=Enabled 才开放 Agent admission；
  // 新装默认 Disabled（无自动 MCP 监听），旧版升级保留 Enabled。generation 供停用封口对账。
  const [collab, setCollab] = useState<CollabStatus>({ state: "Disabled", generation: 0, configured_agents: 0, active_requests: 0, endpoint: "" });
  // 停用影响预览对话框（非空 = 已拉取影响并等待用户确认）
  const [disableImpact, setDisableImpact] = useState<DisableImpact | null>(null);
  const [collabBusy, setCollabBusy] = useState(false);
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
  // 相位中文 phaseText 已提升 app-data.ts（仅主机栏连接钮使用）
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
  // 十七轮「快速连接」：不存主机一次性建连（内存态，重启即失）
  const [showQuickConnect, setShowQuickConnect] = useState(false);
  // 快速连接在途：取消/✕/Esc 必须真的中止 attempt（此前只关弹窗，慢主机数秒后
  // 仍会冒出「已连接」标签）。draft 建连的真实 host id 是 quick-demo-NNNN /
  // quick-<uuid>，不能按 hostId 在 attempts 里查——记下 attempt_id 才能取消。
  const quickConnectingRef = useRef(false);
  const quickAttemptRef = useRef<string | null>(null);
  // 「提交后 begin_connection_draft 尚未应答就被关窗」的取消意图：应答回来再补取消
  const quickCancelRequestedRef = useRef(false);
  const noteQuickConnecting = useCallback((b: boolean) => { quickConnectingRef.current = b; }, []);
  // 建连同主机在途锁：connectingIds 要等 begin_connection 应答才更新，本机默认
  // new_session:true 又绕过核心幂等——双击本机卡/连接钮会在应答前发出两次建连。
  // 入口同步写、finally 清；只挡并发在途，串行两次点击（含用指定 shell 新开）不受影响。
  const pendingHostsRef = useRef<Set<string>>(new Set());
  // 十九轮：命令面板（⌘K / Ctrl+K / 工具栏按钮）
  const [paletteOpen, setPaletteOpen] = useState(false);
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
  // 活动栏轮：左侧栏第二个视图「Agent 对话」。与主机栏互斥（开一个关另一个，双写
  // localStorage），默认关（首次须从活动栏显式打开——演练外壳，别抢首屏）。宽度
  // 320–560（对话面板比主机栏宽），只走 localStorage（主机栏的 blob 域不带它，
  // 避免动 workspace schema；刷新恢复同效）。
  const [agentOpen, setAgentOpen] = useState(() => {
    try { return localStorage.getItem("ui.agentbar") === "1"; } catch { return false; }
  });
  // 编排者视图（Fleet 轮）：活动栏第三入口，跨会话派发任务。与主机栏/Agent 视图
  // 三向互斥（同一左栏），持久键 ui.fleetbar；对话键固定 "fleet"（与 Rust 侧
  // FLEET_KEY 对应），不随激活标签页切换。
  const [fleetOpen, setFleetOpen] = useState(() => {
    try { return localStorage.getItem("ui.fleetbar") === "1"; } catch { return false; }
  });
  // 监控大屏（大屏轮）：活动栏第四入口，多服务器资源监控（CPU/内存/网络 +
  // Ascend NPU）。同左栏互斥族（现四向），持久键 ui.monitorbar。呈现为盖住
  // 主区的整幅大屏（绝对定位覆盖层，终端不卸载），不再有侧栏宽度态。
  const [monitorOpen, setMonitorOpen] = useState(() => {
    try { return localStorage.getItem("ui.monitorbar") === "1"; } catch { return false; }
  });
  // 采样暂停（store 单例持真值，React 只镜像按钮态）：持久键与监控条的区分开，
  // 两个面板语义独立（监控条暂停≠面板暂停）
  const [monitorPaused, setMonitorPaused] = useState(isMonitorPaused);
  // 采集开关（开关轮）：通用/NPU 两路独立 opt-in，localStorage 持久——开了就
  // 后台持续采（关大屏不中断，store 的 syncMonitorTargets 自持链条），全关零
  // 开销。与 store 初值同源同读（都读 tinyssh.monGeneral/monNpu），双向一致
  const [monGeneral, setMonGeneral] = useState(() => {
    try { return localStorage.getItem("tinyssh.monGeneral") === "1"; } catch { return false; }
  });
  const [monNpu, setMonNpu] = useState(() => {
    try { return localStorage.getItem("tinyssh.monNpu") === "1"; } catch { return false; }
  });
  const [agentWidth, setAgentWidth] = useState(() => {
    try {
      const v = Number.parseInt(localStorage.getItem("ui.agentbar_w") ?? "", 10);
      return Number.isFinite(v) ? Math.min(560, Math.max(320, v)) : 420;
    } catch { return 420; }
  });
  const [hostQuery, setHostQuery] = useState("");
  // 五轮架构（逐键全树重渲染根治）：主机搜索改非受控 + 150ms 防抖——此前每键
  // setHostQuery 都触发整棵 App 树 reconcile。键入即时上屏（原生 DOM），过滤值
  // 150ms 后落地；Enter 直达读输入框实时值重算，不信渲染闭包里的滞后过滤结果。
  const hostSearchRef = useRef<HTMLInputElement | null>(null);
  const hostDebounceRef = useRef(0);
  useEffect(() => () => { if (hostDebounceRef.current) window.clearTimeout(hostDebounceRef.current); }, []);
  // 右侧任务面板：一次只呈现文件 / 协作 / 转发 / 活动记录之一（§4.3/§6.6），缺省关闭
  const [rightPanel, setRightPanel] = useState<null | "files" | "collab" | "forwards" | "log" | "blocks">(null);
  // 面板宽度（用户反馈固定 384 读文件/日志太窄）：左缘抓手拖动，320–560 档；
  // 落 localStorage（同 hostbar/agentbar 宽度的做法，workspace blob 只管开合）。
  const [taskPanelW, setTaskPanelW] = useState(() => {
    try {
      const v = Number.parseInt(localStorage.getItem("ui.taskpanel_w") ?? "", 10);
      return Number.isFinite(v) ? Math.min(560, Math.max(320, v)) : 384;
    } catch { return 384; }
  });
  const [toolsOpen, setToolsOpen] = useState(false);
  const [tabsMenuOpen, setTabsMenuOpen] = useState(false);
  // 专注模式小工具栏（用户反馈：连接现有主机与文件是最常用两件事）：
  // 会话工具栏与 .tabbar-admin 在专注态整体隐藏，这里用标签条右侧的紧凑入口补位。
  const [focusHostMenu, setFocusHostMenu] = useState(false);
  const [winW, setWinW] = useState(() => window.innerWidth);
  // 专注模式（F11）：标题栏/主机栏/会话工具栏/状态条全让位 + 系统级全屏，标签条
  // 变 overlay（藏态留 6px 抓手，hover/钉住态滑出）。初值读 localStorage 同步恢复
  // chrome 态（首帧无闪烁，同 zoom.ts 的理由——KV 异步会闪一帧满 chrome）；
  // 系统全屏由首帧 effect 补投。显隐全走 CSS：退出后各区域原样恢复，状态零破坏。
  const [focusMode, setFocusMode] = useState(() => {
    try { return localStorage.getItem("ui.focus") === "1"; } catch { return false; }
  });
  // 专注模式标签条形态（用户反馈二轮「能否保持常驻」）：默认常驻——标签条像常态一样
  // 在流内显示，多标签环境感知（很多用户习惯常驻）；可选自动隐藏（v1 行为：藏条 +
  // 顶缘迷你浮标）。localStorage 记档键 ui.zenStrip，与 zoom 同理首帧同步读。
  const [zenStripAuto, setZenStripAuto] = useState(() => {
    try { return localStorage.getItem("ui.zenStrip") === "auto"; } catch { return false; }
  });
  const setZenStrip = useCallback((auto: boolean) => {
    setZenStripAuto(auto);
    try { localStorage.setItem("ui.zenStrip", auto ? "auto" : "pin"); } catch { /* 隐私模式忽略 */ }
  }, []);
  const zenStripAutoRef = useRef(zenStripAuto);
  zenStripAutoRef.current = zenStripAuto;
  // 原生全屏态（专注模式的真实前提）：focusMode 会隐藏 44px 标题区，而 macOS
  // titleBarStyle=Overlay 的红绿灯是系统悬浮钮，不由 HTML 隐藏——专注态若没真正
  // 全屏（启动恢复被系统拒绝、用户从绿灯/Ctrl⌘F/Esc 退出全屏），三个圆钮会压在
  // 标签条/终端首行上。跟踪 isFullscreen：非全屏的专注态收回 chrome；过渡期由
  // focus-windowed 类给标签条留出 84px 红绿灯安全区（见 styles.css）。
  const [nativeFullscreen, setNativeFullscreen] = useState(false);
  const nativeFullscreenRef = useRef(false);
  const focusModeRef = useRef(focusMode);
  focusModeRef.current = focusMode;
  const focusFsIntentRef = useRef<{ at: number; want: boolean } | null>(null);
  const syncNativeFullscreen = useCallback((fs: boolean) => {
    if (nativeFullscreenRef.current === fs) return;
    nativeFullscreenRef.current = fs;
    setNativeFullscreen(fs);
  }, []);
  // R13 统一分发：keymap 解析（actions.ts）与执行分离；ref 持有最新执行器，
  // 捕获层 effect 与 xterm 键处理器都经它走同一条路。modal/主机栏开合同步 ref。
  const dispatchRef = useRef<(a: AppAction) => boolean>(() => false);
  const modalRef = useRef(false);
  // 排除「视图型覆盖层」（监控大屏 / tmux 墙）后的对话框模态：这两者是可被设置
  // 面板盖住的视图（55-58 家族刻意排在设置之下），不能挡住 rail 设置钮
  const dialogModalRef = useRef(false);
  const hostbarOpenRef = useRef(hostbarOpen);
  hostbarOpenRef.current = hostbarOpen;
  const hostbarWidthRef = useRef(hostbarWidth);
  hostbarWidthRef.current = hostbarWidth;
  const agentOpenRef = useRef(agentOpen);
  agentOpenRef.current = agentOpen;
  const agentWidthRef = useRef(agentWidth);
  agentWidthRef.current = agentWidth;

  // 专注模式切换（F11 / 标签条按钮 / 命令面板同一入口）：chrome 态同步落 localStorage；
  // 系统全屏走 Tauri setFullscreen（capability core:window:allow-set-fullscreen）。
  // invoke 失败回滚内存档位与落盘——窗口没动，回滚才有下次切换从真状态起算（同 zoom.ts）；
  // 典型失败面：dev 前端配旧二进制（无新 capability）。进入提示只给本运行第一次，
  // F11 连切不反复轰炸。demo（浏览器）不劫持 F11，面板/按钮只切 chrome 不动全屏。
  const focusHintShownRef = useRef(false);
  // 退出专注时紧凑菜单按钮会随 focusMode 卸载，焦点会落到 body；ref 间接引用
  // 下方的 focusTermFor，退出后把焦点还给该标签上次落焦的终端/格子。
  const focusTermForRef = useRef<(sid: string) => void>(() => {});
  const applyFocus = useCallback((on: boolean, announce = true, opts?: { syncWindow?: boolean }) => {
    // syncWindow=false：系统侧已经/正在离开全屏（绿灯、Esc、启动恢复失败），只收
    // chrome，不再反向调用 setFullscreen——否则会把用户刚退出的窗口又推进全屏。
    const syncWindow = opts?.syncWindow !== false;
    if (syncWindow) focusFsIntentRef.current = { at: performance.now(), want: on };
    setFocusMode(on);
    if (!on) {
      setFocusHostMenu(false); // 退出专注：紧凑连接菜单没有宿主了
      requestAnimationFrame(() => {
        const sid = sidRef.current;
        if (sid) focusTermForRef.current(sid);
      });
    }
    try { localStorage.setItem("ui.focus", on ? "1" : "0"); } catch { /* 隐私模式忽略 */ }
    if (!inTauri) {
      // 七轮 B7-5：demo 域 F11 归浏览器（native 门控），退出靠顶部「退出专注」钮——
      // 原提示只说不切全屏、不说怎么退，补一句出口（native 分支文案不变）
      if (announce) pushToast("info", on ? t("已进入专注模式（浏览器演示不切系统全屏）· 点右上角专注图标返回") : t("已退出专注模式"));
      return;
    }
    if (!syncWindow) return;
    getCurrentWindow().setFullscreen(on)
      .then(() => {
        // macOS 原生全屏是动画过渡：延迟探测校准真实态（onResized 的判定同基准）
        setTimeout(() => {
          void getCurrentWindow().isFullscreen()
            .then((fs) => syncNativeFullscreen(fs))
            .catch(() => {});
        }, 600);
        if (announce && on && !focusHintShownRef.current) {
          focusHintShownRef.current = true;
          pushToast("info", zenStripAutoRef.current
            ? t("专注模式：{0} 退出 · 鼠标移到顶部唤出标签", FOCUS_KEY_LABEL)
            : t("专注模式：{0} 退出 · 标签条常驻（{1} 可切自动隐藏）", FOCUS_KEY_LABEL, formatBinding(keymapRef.current.palette, isMacPlatform())));
        }
      })
      .catch((e) => {
        setFocusMode(!on);
        try { localStorage.setItem("ui.focus", on ? "0" : "1"); } catch { /* 忽略 */ }
        pushToast("err", t("专注模式切换失败：{0}", errMsg(e).slice(0, 80)));
      });
  }, [pushToast, syncNativeFullscreen]);

  // 原生全屏跟踪：专注模式的前提是全屏，但用户可用绿灯/Ctrl⌘F/Esc 在系统层退出。
  // 非全屏的专注态立即收回 chrome（红绿灯会压在标签条/终端上），而不是留下一个
  // 「专注模式但非全屏」的半态。刚发起切换的 2s 是系统动画/启动补投窗口，不据此
  // 回滚；Windows/Linux 无红绿灯，但同一语义（专注=全屏）一并成立。
  useEffect(() => {
    if (!inTauri) return;
    const win = getCurrentWindow();
    let alive = true;
    let un: (() => void) | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let lastFs: boolean | null = null;
    const probe = () => {
      void win.isFullscreen().then((fs) => {
        if (!alive) return;
        // 原生全屏进出（不是 DOM fullscreenchange）是字形图集自愈的可靠时机：
        // 系统层重排了图层，重画一次代价小、用户预期内。
        if (lastFs !== null && lastFs !== fs) repaintAllRef.current();
        lastFs = fs;
        syncNativeFullscreen(fs);
        if (fs || !focusModeRef.current) return;
        const intent = focusFsIntentRef.current;
        if (intent && performance.now() - intent.at < 2000) return;
        applyFocus(false, false, { syncWindow: false });
      }).catch(() => {});
    };
    // 拖窗/缩放期间 onResized 逐 tick 触发——300ms 防抖，语义同 WinControls。
    const probeSoon = () => { if (timer) clearTimeout(timer); timer = setTimeout(probe, 300); };
    probe();
    win.onResized(() => probeSoon())
      .then((f) => { un = () => { try { void f(); } catch { /* 已卸载 */ } }; })
      .catch(() => {});
    return () => { alive = false; un?.(); if (timer) clearTimeout(timer); };
  }, [applyFocus, syncNativeFullscreen]);

  // 启动恢复：chrome 态已由 useState 初值同步恢复；系统全屏在首帧后补投（invoke
  // 异步，可能闪一帧任务栏——与缩放首帧权衡同理）。恢复给一次性轻提示，用户重开
  // 窗口时不必回想「怎么退出去」。补投失败或系统拒绝全屏时必须回滚 chrome——否则
  // 会停在「专注模式但非全屏」，红绿灯直接压在标签条上（用户截图实测）。
  useEffect(() => {
    if (!inTauri) return;
    const win = getCurrentWindow();
    let on = false;
    try { on = localStorage.getItem("ui.focus") === "1"; } catch { /* 忽略 */ }
    if (!on) {
      void win.isFullscreen().then(syncNativeFullscreen).catch(() => {});
      return;
    }
    focusFsIntentRef.current = { at: performance.now(), want: true };
    const rollback = () => {
      setFocusMode(false);
      try { localStorage.setItem("ui.focus", "0"); } catch { /* 忽略 */ }
    };
    win.setFullscreen(true)
      .then(() => {
        // 系统可能忽略/延迟全屏请求：动画结束后复核，没进全屏就回滚 chrome。
        // 成功提示也放到复核之后，避免先报「已恢复」再报「已退出」自相矛盾。
        setTimeout(() => {
          void win.isFullscreen().then((fs) => {
            syncNativeFullscreen(fs);
            if (fs) {
              pushToast("info", t("已恢复专注模式 · {0} 退出", FOCUS_KEY_LABEL));
              return;
            }
            rollback();
            pushToast("info", t("未能恢复全屏，已退出专注模式"));
          }).catch(() => {
            // 探测失败（IPC 瞬断）不等于全屏失败：保持现状，按成功提示
            pushToast("info", t("已恢复专注模式 · F11 退出"));
          });
        }, 700);
      })
      .catch(() => {
        rollback();
        pushToast("err", t("未能恢复专注模式（系统全屏不可用）"));
      });
    // 仅首帧：focusMode 后续变化都走 applyFocus，此处不依赖它
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const refreshLists = useCallback(async () => {
    try {
      // UX 八轮：先取数后 setState——结构无变化时复用旧引用（sameShape），
      // 3s 轮询数据没变则整树与下游 effect 全部静默，不再每轮空转。
      // 七轮：六个查询原本串行 await（每 3s 六趟往返），彼此无依赖——并成一批，
      // 空闲空转从「六趟之和」压到「最慢一趟」；任一失败仍整体抛出（行为不变）
      const snapAt = performance.now();
      // 每个查询独立降级：审批/自主模式不能因为 list_sessions/list_hosts 的
      // 一次瞬时失败而整批不刷新——否则审批超时/已决后内联卡会长期停留。
      const [sessionsRaw, nextHosts, nextMeta, nextRecents, approvalsRaw, nextAutonomy] = await Promise.all([
        (invoke("list_sessions") as Promise<SessionInfo[]>).catch(() => null),
        (invoke("list_hosts") as Promise<Host[]>).catch(() => null),
        // R20：收藏/最近元数据（失败不阻断列表——空 meta 即全部视为未收藏）
        invoke("list_host_metadata").then((v) => v as HostMeta[]).catch(() => null),
        invoke("list_recent_hosts").then((v) => v as RecentHost[]).catch(() => null),
        (invoke("list_approvals", { pendingOnly: false }) as Promise<ApprovalItem[]>).catch(() => null),
        // ② 自主模式横幅数据（跟随 3s 轮询；到期由核心惰性清除，前端只显示剩余）
        (invoke("autonomy_list") as Promise<AutonomyGrant[]>).catch(() => null),
      ]);
      if (sessionsRaw) {
        const nextSessions = applyTabOrder(sessionsRaw);
        panesSnapAtRef.current = snapAt;
        setSessions((prev) => sameShape(prev, nextSessions));
      }
      if (nextHosts) {
        setHosts((prev) => sameShape(prev, nextHosts));
        setHostsError(false);
      } else {
        // 单查询降级：失败不阻断其他列表，但主机栏必须如实呈现错误态（可重试）
        setHostsError(true);
      }
      if (nextMeta) setHostMeta((prev) => sameShape(prev, nextMeta));
      if (nextRecents) setRecents((prev) => sameShape(prev, nextRecents));
      setHostsLoaded(true); // §5.6：首载完成后 skeleton 才撤
      if (approvalsRaw) {
        const nextApprovals = approvalsRaw.map((a): ApprovalRow => ({ ...a, status: normApprovalStatus(a.status) }));
        setApprovals((prev) => sameShape(prev, nextApprovals));
      }
      if (nextAutonomy) {
        // ⑧ 到期差分：消失且非人工收回 → 即时提示（横幅本身随 setAutonomy 3s 内消隐）
        for (const a of autonomyKnownRef.current) {
          if (!nextAutonomy.some((g) => g.agent_id === a) && !autonomyKilledRef.current.has(a)) {
            pushToast("info", t("{0} 的自主模式已到期，恢复逐条审批", a));
          }
        }
        for (const a of [...autonomyKilledRef.current]) {
          if (!nextAutonomy.some((g) => g.agent_id === a)) autonomyKilledRef.current.delete(a);
        }
        autonomyKnownRef.current = new Set(nextAutonomy.map((g) => g.agent_id));
        // 同款 bailout（找茬四轮 B4）：此前唯一漏网——autonomy_list 每 3s 反序列化
        // 新数组，引用恒变 → App 全树每 3s 必 diff（上方注释自述的「数据没变整树
        // 静默」被架空，墙开着时空闲态也持续烧 CPU）
        setAutonomy((prev) => sameShape(prev, nextAutonomy));
      }
    } catch {
      // 审核低-5：首载失败也必须撤骨架给出空态出口（否则永久骨架 + 未处理 rejection）；
      // 3s 轮询自愈，错误不逐条打扰（连接类失败另有常驻横幅）
      setHostsLoaded(true);
    }
  }, [pushToast]);
  const refreshListsRef = useRef(refreshLists);
  refreshListsRef.current = refreshLists;

  // R41（§6.6「保留主机/会话身份」）：累积 sid→主机名。会话关闭后从 sessions 消失，
  // 但它的记录还要能标出「当时是哪台主机」——故只增不删，查不到时如实显示短 id。
  useEffect(() => {
    setSessionIdent((prev) => {
      let next: Map<string, string> | null = null;
      for (const s of sessions) {
        if (!prev.has(s.id)) {
          if (!next) next = new Map(prev);
          next.set(s.id, s.host_name);
        }
      }
      return next ?? prev;
    });
  }, [sessions]);

  // R41（§6.6/S09）连接详情：**独立可关闭对话框**。取的是后端连接时身份快照，
  // 不按 host_id 回查现配置——主机改过名/改过址，详情仍显示连接当时的值（§6.1）。
  const openSessionDetail = useCallback(async (s: SessionInfo | null | undefined) => {
    const sid = s?.id ?? null;
    if (!sid) { setDetailErr(t("未接入会话——连接主机后可在「工具 → 连接详情」查看")); setDetail(null); setDetailSid(null); return; }
    setDetailSid(sid); setDetail(null); setDetailErr(null);
    try {
      const d = await invoke("session_detail", { sid });
      if (sidRef.current !== sid) return; // 过期响应丢弃，防跨会话串台
      setDetail(d);
    } catch (e) {
      if (sidRef.current !== sid) return;
      setDetailErr(friendlyError(e));
    }
  }, []);

  // R41（§6.6）活动记录：本视图**自带**查询（不寄生协作面板）。默认当前会话，
  // 可切全部；可筛人类/Agent 与事件类型；翻页走 seq 游标（连续，不重不漏）。
  const LOG_PAGE = 40;
  // 请求代次：切范围/筛选/会话会连发多条查询，响应可能乱序到达（原生 IPC 并发执行命令）。
  // 只认最后一次发出的那一代——否则先发后到的旧筛选结果会盖掉新筛选结果（rev-r41 低-4）。
  const logGenRef = useRef(0);
  const loadLog = useCallback(async (more: boolean) => {
    const gen = ++logGenRef.current;
    setLogBusy(true); setLogErr(null);
    try {
      const beforeSeq = more && logEvents.length > 0 ? logEvents[logEvents.length - 1].seq : null;
      const page = await invoke("audit_query", {
        sid: logScope === "current" ? (sidRef.current || null) : null,
        limit: LOG_PAGE,
        actorKind: logActor || null,
        action: logAction || null,
        beforeSeq,
      });
      if (gen !== logGenRef.current) return; // 过期响应丢弃（不 setState）
      setLogTotal(page.total);
      setLogEvents((prev) => (more ? [...prev, ...page.events] : page.events));
    } catch (e) {
      if (gen !== logGenRef.current) return;
      setLogErr(friendlyError(e));
      if (!more) { setLogEvents([]); setLogTotal(0); }
    } finally {
      if (gen === logGenRef.current) setLogBusy(false);
    }
  }, [logScope, logActor, logAction, logEvents]);

  // 面板打开 / 范围 / 筛选 / 当前会话变化 → 重取首页（切范围不叠加旧页，避免串台）。
  // 「当前会话」但无会话时不查：`sidRef.current` 为 null 时照常下发会**退化成全局查询**，
  // 而正文已渲染「未接入会话」空态——标题却按全局总数宣称「共 N 条」，两处自相矛盾
  // （rev-r41 低-2）。此处直接落空态并作废在途响应。
  useEffect(() => {
    if (rightPanel !== "log") return;
    if (logScope === "current" && !sid) {
      logGenRef.current++;
      setLogEvents([]); setLogTotal(0); setLogErr(null); setLogBusy(false);
      return;
    }
    void loadLog(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rightPanel, logScope, logActor, logAction, sid]);

  // ---- P1-b：命令块面板（FR-10 V2）。数据=read_blocks 最近 50 条（旧→新），
  // 打开/切会话取一次 + OSC 133 推送即时刷新（makeTerm parser handler →
  // blocksActivityRef）+ 5s 轮询兜底（无 shell 集成时唯一来源）+ 手动刷新；
  // 重跑走粘贴安全链（下方 rerunCommand）。 ----
  const [blocksList, setBlocksList] = useState<BlockInfo[]>([]);
  const [blocksBusy, setBlocksBusy] = useState(false);
  const [blocksErr, setBlocksErr] = useState<string | null>(null);
  const loadBlocks = useCallback(async () => {
    const s = sidRef.current;
    if (!s) { setBlocksList([]); setBlocksErr(null); return; }
    setBlocksBusy(true);
    try {
      const rows = await invoke("read_blocks", { sid: s, limit: 50 });
      if (sidRef.current !== s) return; // 已切会话：过期块列表不得覆盖新会话（重跑会以新 sid 发旧命令，必守）
      setBlocksList(rows ?? []);
      setBlocksErr(null);
    } catch (e) {
      if (sidRef.current !== s) return;
      setBlocksErr(String((e as { message?: string })?.message ?? e));
    } finally {
      if (sidRef.current === s) setBlocksBusy(false);
    }
  }, []);
  useEffect(() => {
    if (rightPanel !== "blocks") return;
    void loadBlocks();
    const t = setInterval(() => void loadBlocks(), 5000);
    return () => clearInterval(t);
  }, [rightPanel, sid, loadBlocks]);
  // OSC 133 标记直达（makeTerm parser handler 经 ref 中转，handler 不随面板状态
  // 重挂）：仅本会话焦点 + 面板打开 + term 在场时取数——块开/合瞬间上屏。
  const blocksActivityRef = useRef<(sid: string) => void>(() => {});
  useEffect(() => {
    blocksActivityRef.current = (bsid: string) => {
      if (rightPanel !== "blocks" || sidRef.current !== bsid) return;
      if (!termsRef.current.has(bsid)) return;
      void loadBlocks();
    };
  }, [rightPanel, loadBlocks]);
  // 最近失败块（blocks 数组内下标；exit 已知且非 0）——「跳到最近失败」的高亮与跳转目标
  const blocksFailIdx = blocksList.reduce(
    (acc, b, i) => (b.exit_code !== null && b.exit_code !== 0 ? i : acc), -1);
  // 块重跑：与粘贴同一条安全链（危险形态 Rust 扫描 + 多行确认），确认后 send_keys
  // 命令+\r——经核心 register_outgoing，块归因人类（不借 term.paste：bracketed paste
  // 会把 \r 包进粘贴体，bash 只插入不执行，等于没跑）。
  const rerunCommand = useCallback((sessionSid: string, cmd: string) => {
    if (!cmd) return;
    const pst = sessionsRef.current.find((x) => x.id === sessionSid)?.state;
    if (pst && inputBlockedState(pst)) {
      pushToast("err", pst === "Disconnected" ? t("会话已断开——重跑未发送") : t("网络中断（自动重连中）——重跑未发送"));
      return;
    }
    const multi = pasteGuardRef.current && /[\n\r]/.test(cmd);
    const deliver = (risk: PasteHit[]) => {
      if (multi || risk.length) {
        const h = sessionsRef.current.find((x) => x.id === sessionSid);
        setPasteConfirm({
          sid: sessionSid,
          hostName: h?.host_name ?? sessionSid.slice(0, 8),
          text: cmd,
          risk,
          multi,
          kind: "rerun",
        });
      } else {
        void invoke("send_keys", { sid: sessionSid, keys: cmd + "\r" })
          .catch(() => pushToast("err", t("重跑发送失败")));
      }
    };
    if (pasteGuardRef.current && PASTE_DANGER_PREFILTER.test(cmd)) {
      invoke("scan_paste_danger", { text: cmd })
        .then((hits) => deliver(hits ?? []))
        .catch(() => deliver([]));
    } else {
      deliver([]);
    }
  }, [pushToast]);
  const copyBlock = useCallback((text: string, what = "命令") => {
    try {
      const p = inTauri ? clipboard.writeText(text) : navigator.clipboard?.writeText(text);
      void Promise.resolve(p).catch(() => {});
    } catch { /* 演示环境无剪贴板：静默 */ }
    pushToast("ok", t("已复制{0}", t(what)));
  }, [pushToast]);
  // 块定位：search addon 文本搜索（best-effort）——FR-10 明示行号跨实现不对齐，
  // 不承诺精确滚动；同名命令命中搜索方向上最近一处（光标在底部=最近一次出现）。
  const locateBlock = useCallback((targetSid: string, cmd: string) => {
    const addon = termsRef.current.get(targetSid)?.search;
    if (!addon) { pushToast("info", t("终端未挂载——接入会话后再定位")); return; }
    addon.findPrevious(cmd, searchOptions());
  }, [pushToast]);

  // R41（§6.6/S11）设置 → 凭据：新建走**显式提交**（生成 / 粘贴私钥），与连接表单同后端。
  // 列表刷新复用既有 refreshIdentities（R21：面板打开与删除后共用）。
  const submitNewIdentity = useCallback(async (req: import("./adapter/wire").IdentityReq) => {
    setCredNewErr(null); setCredNewOk(null); setCredBusy(true);
    try {
      const meta = await invoke("create_identity", { req });
      setCredNewOk(meta);
      // 提交成功后销毁前端敏感字段（§269：明文不留在通用状态里）
      setCredPem(""); setCredPass("");
      // 落库成功才刷新列表（未提交/失败都不动列表，保持「显式提交」语义）
      try { setIdentities(await invoke("list_identities")); } catch { /* 列表降级保留旧值 */ }
    } catch (e) {
      setCredNewErr(friendlyError(e));
    } finally {
      setCredBusy(false);
    }
  }, []);

  // §231：凭据类目下若有未提交的敏感草稿，切分类前先让用户处置（丢弃 / 留下）
  const switchSettingsCat = useCallback((next: SettingsCat) => {
    if (next === "credentials") { setCredDraftTo(null); setSettingsCat(next); return; }
    const dirty = credPem.trim() !== "" || credPass.trim() !== "";
    if (settingsCat === "credentials" && dirty) { setCredDraftTo(next); return; }
    setCredDraftTo(null); setSettingsCat(next);
  }, [settingsCat, credPem, credPass]);

  // R42（§6.7）：从协作视图/首次委托对话框引导到「设置 → Agent 接入」——复用同一设置
  // 实例（§231「不叠加多个窗口」），并在返回后由用户**单独确认**转交。
  const openSettingsAt = useCallback((cat: SettingsCat) => {
    setCredDraftTo(null);
    setSettingsCat(cat);
    setShowSettings(true);
  }, []);

  const discardCredDraft = useCallback(() => {
    // 丢弃草稿 = 清空前端敏感字段（凭据库里没有半成品，取消不落库）
    setCredPem(""); setCredPass(""); setCredLabel(""); setCredNewErr(null);
    setSettingsCat(credDraftTo ?? "appearance");
    setCredDraftTo(null);
  }, [credDraftTo]);

  // R41（§6.6/S09）：连接详情是**独立可关闭对话框**——遮罩点击、✕、Esc 三条路都关它
  // （vis-r41 B4：此前只挂了遮罩与 ✕，Esc 链漏了这一层，与同轮新增的设置对话框行为不一致）。
  const closeDetail = useCallback(() => {
    setDetail(null); setDetailErr(null); setDetailSid(null);
  }, []);

  // R41（§231/§269）：关闭设置即销毁前端敏感草稿——凭据库里没有半成品。
  // 凭据守卫（六轮 D6-4 同族）：Esc/✕ 对未提交的私钥草稿做双击确认——第一次
  // 只提示，第二次才真清（设置凭据分区拦截卡的轻量版；纯浏览不拦）。
  const settingsCredGuardRef = useRef(false);
  // 一次性 Agent Token 与凭据草稿同族：Token 只在面板本地展示一次，关掉设置就再也
  // 拿不到（只能吊销重签）。面板上报「仍开着」，关闭路径先拦一次再放行。
  const settingsTokenPendingRef = useRef(false);
  const settingsTokenGuardRef = useRef(false);
  const noteIssuedTokenPending = useCallback((pending: boolean) => {
    settingsTokenPendingRef.current = pending;
  }, []);
  const closeSettings = useCallback(() => {
    if (settingsTokenPendingRef.current && !settingsTokenGuardRef.current) {
      settingsTokenGuardRef.current = true;
      escKeepFocusRef.current = true; // Esc 只提示不关：焦点留在对话框
      pushToast("info", t("Agent Token 仍只展示这一次——关闭设置后就无法再查看（可吊销重签）。再按一次 Esc 或 ✕ 确认放弃"));
      return;
    }
    if ((credPem.trim() !== "" || credPass.trim() !== "") && !settingsCredGuardRef.current) {
      settingsCredGuardRef.current = true;
      escKeepFocusRef.current = true;
      pushToast("info", t("凭据表单里有未提交的私钥内容——再按一次 Esc 或 ✕ 确认丢弃"));
      return;
    }
    settingsCredGuardRef.current = false;
    settingsTokenGuardRef.current = false;
    setCredPem(""); setCredPass(""); setCredLabel("");
    setCredNewErr(null); setCredNewOk(null); setCredNewOpen(false); setCredDraftTo(null);
    setShowSettings(false);
  }, [credPem, credPass, pushToast]);

  // 新建/编辑主机的关闭守卫（六轮 D6-4）：凭据草稿（密码/私钥/口令）非空时
  // 双击确认，纯连接信息直接关。Esc 链与 ✕/取消钮三口共用。
  const addHostGuardRef = useRef(false);
  // 表单在途保存：Esc/✕ 与「取消」钮同口径停手（upsert 已发出，关框撤不回，成功
  // 回调还会建连——否则「取消」实际是「保存并连接」）
  const addHostSavingRef = useRef(false);
  const onAddHostSavingChange = useCallback((v: boolean) => { addHostSavingRef.current = v; }, []);
  const closeAddHost = useCallback(() => {
    if (addHostSavingRef.current) {
      escKeepFocusRef.current = true;
      pushToast("info", t("正在保存——完成后会自动关闭；保存失败可再取消"));
      return;
    }
    if (addHostCredDirty.value && !addHostGuardRef.current) {
      addHostGuardRef.current = true;
      escKeepFocusRef.current = true;
      pushToast("info", t("表单里有未提交的凭据（密码/私钥/口令）——再按一次 Esc 或 ✕ 确认丢弃"));
      return;
    }
    addHostGuardRef.current = false;
    addHostCredDirty.value = false;
    setShowAddHost(false); setEditingHost(null); setPrefillEntry(null);
  }, [pushToast]);

  // 七轮（交付前审查）：守卫复位不只挂在 closeAddHost 上——成功保存、切到快速连接、
   // 导入面板等路径都直接 setShowAddHost(false)。表单一关就复位，避免下一次打开
   // 继承「已提示过一次」的状态、首按 Esc 静默丢凭据
  useEffect(() => {
    if (!showAddHost) addHostGuardRef.current = false;
  }, [showAddHost]);

  // 简报归属标记：brief 本身不带 sid，SFTP 首载链凭它判「brief 是不是当前会话的」——
  // 切会话后 refreshBrief 在途的窗口里 brief 还是上一个会话的，直接用会拿旧 cwd 起载
  const briefSidRef = useRef<string | null>(null);
  const refreshBrief = useCallback(async (s: string) => {
    try {
      const b = await invoke("session_brief", { sid: s });      if (sidRef.current !== s) return; // 审核H1：已切走会话的过期简报直接丢弃，防简报/任务目标跨会话串台
      briefSidRef.current = s; // 归属标记：SFTP 首载链凭它认简报是不是本会话的（brief 无 sid 字段）
      setBrief((prev) => sameJson(prev, b));
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
  // 草稿换装必须**渲染期同步**（官方 adjust-state-on-prop-change 模式）：effect 版
  // 先提交「新 sid + 旧草稿」再在 effect 里清——两拍之间必有一帧已画出的泄漏窗
  // 口，16ms 逐帧采样器（15-goal H1 断言）撞上就闪 1 帧；渲染期 setState 让同一
  // 次提交就带上正确草稿，窗口归零。比较基准用 goalSid（state），不用 ref：
  // 并发渲染被丢弃时 state 更新与比较基准同生共死，不会留下「sid 已换、草稿未换」
  // 的提交。
  {
    if (goalSid !== sid) {
      if (goalSid && goalDirty.current) goalDrafts.current.set(goalSid, goalDraft);
      const stashed = sid ? goalDrafts.current.get(sid) : undefined;
      if (stashed !== undefined) { goalDirty.current = true; setGoalDraft(stashed); }
      else { goalDirty.current = false; setGoalDraft(""); }
      setGoalSid(sid);
    }
  }
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
    const gv = clear ? "" : goalDraft.trim();
    try {
      await invoke("set_session_goal", { sid: target, goal: gv ? gv : null });
      goalDirty.current = false;
      goalDrafts.current.delete(target); // 已落盘，清掉该会话的暂存草稿
      if (clear) setGoalDraft("");
      pushToast("ok", gv ? t("任务目标已更新，Agent 读简报可见") : t("任务目标已清除，Agent 简报同步移除"));
      void refreshBrief(target);
      void refreshLists(); // goal_set 审计事件即时反映到列表/简报（活动记录面板自带刷新）
    } catch (e) {
      pushToast("err", friendlyError(e));
    }
  }, [goalDraft, refreshBrief, refreshLists, pushToast]);

  useEffect(() => {
    refreshLists();
    invoke("mcp_status").then(setMcp);
    invoke("collab_status").then((v) => setCollab((prev) => sameJson(prev, v))).catch(() => {});
    // 本地终端一等公民轮：探测清单 + 已选默认 shell（失败静默——下拉空、建连走默认解析）
    invoke("list_local_shells").then((v) => setLocalShells(v)).catch(() => {});
    invoke("get_setting", { key: SETTING_LOCAL_SHELL }).then((v) => setLocalShellId(v ?? "")).catch(() => {});
    invoke("get_setting", { key: SETTING_AUTO_LOCAL }).then((v) => setAutoLocal(v !== "0")).catch(() => {});
    invoke("bench_mode").then((b) => {
      if (b) runBench();
    });
  }, [refreshLists]);

  // 本地终端一等公民轮：启动即有一个可敲命令的本地终端（真实模式专属——demo 域
  // 豁免：55 个 spec 的初始态是「2 个演示会话+欢迎页」，自动开会全炸；真实链路
  // 由真机验证钉住）。仅一次；先内联读默认 shell（与上方 state 装载无序，读毕再连）。
  // SSH 恢复仍「点了才连」：恢复入口在欢迎页空态与 ⌘K 面板。
  // 只属于冷启动：F5/Ctrl+R 重载 WebView 时核心进程与会话都还在，前端却从头挂载——
  // 此前每重载一次就多开一个本机标签。以核心会话表为准（决策时现取，不吃 state
  // 装载时序）：已有任何未关闭会话即是重载续用，不开、回到重载前的标签；取不到按冷启动处理。
  // 重载前的活动标签记在 sessionStorage（随 WebView 会话存活、应用重启即清——冷启动
  // 不会误吃上次运行的值）。首拍 sid=null 是挂载初值不是用户离开标签，跳过不抹；
  // 欢迎页上重载则如实留在欢迎页。
  const [reloadSid] = useState<string | null>(() => {
    try { return sessionStorage.getItem("ui.activeSid"); } catch { return null; }
  });
  const sidPersistArmedRef = useRef(false);
  useEffect(() => {
    if (!sidPersistArmedRef.current) {
      sidPersistArmedRef.current = true;
      if (!sid) return;
    }
    try {
      if (sid) sessionStorage.setItem("ui.activeSid", sid);
      else sessionStorage.removeItem("ui.activeSid");
    } catch { /* 隐私模式忽略 */ }
  }, [sid]);
  const autoLocalRef = useRef(false);
  useEffect(() => {
    // 首载失败（hostsError）不武装：等重试成功、hosts 到位后再走自动开本地终端，
    // 否则 autoLocalRef 提前置位，之后即使列表恢复也不会再自动开
    if (!inTauri || !hostsLoaded || hostsError || autoLocalRef.current) return;
    autoLocalRef.current = true;
    void (async () => {
      try {
        const live = ((await invoke("list_sessions")) as SessionInfo[]).filter((s) => s.state !== "Closed");
        if (live.length > 0) {
          // 仍在册才回；装载期间用户已点了别的标签就不抢
          if (reloadSid && !sidRef.current && live.some((s) => s.id === reloadSid)) void attachSession(reloadSid);
          return;
        }
      } catch { /* 取不到按冷启动处理 */ }
      // 设置里关掉「启动时自动打开本地终端」就不再起本地 shell；直读 KV 而非
      // 吃 state——本 effect 与设置装载无序，shell 选择本来也直读 KV。
      try {
        const auto = (await invoke("get_setting", { key: SETTING_AUTO_LOCAL })) ?? "1";
        if (auto === "0") return;
      } catch { /* 读失败按默认开 */ }
      const lh = hosts.find((h) => h.id === "local");
      if (!lh) return;
      try {
        const chosen = (await invoke("get_setting", { key: SETTING_LOCAL_SHELL })) ?? "";
        if (chosen) setLocalShellId(chosen);
        // state 本拍不生效（闭包里 localShellId 还是旧值）——显式解析成 path 走
        // 第参传给 createSession，别让默认 shell 是否生效取决于 promise 竞速
        if (chosen) {
          const shells = localShells.length ? localShells : ((await invoke("list_local_shells")) as LocalShell[]);
          if (!localShells.length) setLocalShells(shells);
          const path = shells.find((s) => s.id === chosen)?.path;
          if (path) { void createSession(lh, false, undefined, path, false); return; }
        }
      } catch { /* 读失败走默认解析 */ }
      void createSession(lh, false, undefined, undefined, false);
    })();
    // createSession / attachSession 声明在后（TDZ：deps 数组渲染期求值不可引用）；effect
    // 体运行时已初始化，闭包捕获安全。autoLocalRef 保证仅首装执行一次。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hostsLoaded, hosts, hostsError]);

  // 列表轮询：会话状态（断线/重连/重确认）与审计时间线自动刷新
  useEffect(() => {
    const t = setInterval(() => {
      refreshLists();
      if (sidRef.current) refreshBrief(sidRef.current);
      // C9（R43）：协作状态与活动请求数随轮询对账（停用封口/重新启用由核心推进，
      // 多窗口或外部触发时 UI 须收敛）
      invoke("collab_status").then((v) => setCollab((prev) => sameJson(prev, v))).catch(() => {});
      // 终端尺寸对账：docker ps 等按 PTY 宽度排版，PTY 与 xterm 失配时表格折行错乱。
      // xterm（用户所见）为权威单向校正后端——任何一环丢掉的 resize 在 3s 内自动收敛。
      // 分屏（T19）时左右两个 pane 各自对账。
      const sp = groupOf(sidRef.current);
      const visiblePanes: string[] = sp ? [sp.main, sp.second] : sidRef.current ? [sidRef.current] : [];
      for (const p of visiblePanes) {
        const t = termsRef.current.get(p)?.term;
        if (!t) continue;
        // 五轮架构：pty_size 轻探针（只回 cols/rows 两个数）——此前误用 read_screen，
        // 每 pane 每 3s 序列化整屏网格只为比对宽高
        invoke("pty_size", { sid: p })
          .then((sz) => {
            if (sz[0] !== t.cols || sz[1] !== t.rows) {
              void invoke("resize", { sid: p, cols: t.cols, rows: t.rows }).catch(() => {});
            }
          })
          .catch(() => {});
      }
    }, 3000);
    return () => clearInterval(t);
  }, [refreshLists, refreshBrief]);

  // 审批事件推送（仅 Tauri 环境；纯浏览器 demo 模式无事件通道）。新审批到达的
  // 主动通知（找茬四轮 D1）：此前只刷列表——Agent 卡在等审批时用户可能长时间
  // 无感（标题栏 pill/rail 徽标在全屏终端打字时太小）。与 trigger-event 同待遇：
  // toast（带「去审批」动作）+ 标签铃；ApprovalEvent 线格式 = {"New"|"Updated": item}。
  useEffect(() => {
    if (!inTauri) return;
    return tauriListen(
      listen<{
        New?: { session_id: string; command: string };
        Updated?: { status?: string; command?: string };
      }>(
        "approval-event",
        (e) => {
          void refreshLists();
          const updated = e.payload?.Updated;
          if (updated && ["Timeout", "timeout"].includes(String(updated.status ?? ""))) {
            pushToast("info", t("审批已超时，命令未执行"));
          }
          const item = e.payload?.New;
          if (!item) return; // Updated=批准/拒绝/超时收尾；超时已单独提示
          pushToast("info", t("新的待审批：{0}", (item.command || "").slice(0, 60)), {
            label: t("去审批"),
            title: t("打开协作面板处理审批"),
            run: () => setRightPanel("collab"),
          });
          setBellSids((cur) => {
            if (cur.has(item.session_id)) return cur;
            const n = new Set(cur);
            n.add(item.session_id);
            return n;
          });
        },
      ),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshLists]);

  // P2-b 输出触发器命中：toast + 标签铃（send 动作的审批卡走 approval-event 既有链）。
  // demo 域无事件通道——命中路径由 Rust triggers_tests 钉住，UI 侧只管呈现。
  useEffect(() => {
    if (!inTauri) return;
    return tauriListen(
      listen<{ sid: string; rule_name: string; action: string; matched: string }>(
        "trigger-event",
        (e) => {
          const ev = e.payload;
          pushToast("info", t("触发器「{0}」命中：{1}", ev.rule_name, ev.matched.slice(0, 80)));
          setBellSids((cur) => {
            if (cur.has(ev.sid)) return cur;
            const n = new Set(cur);
            n.add(ev.sid);
            return n;
          });
        },
      ),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // R23（C1 消费）：connection-event 相位推进。真实环境走事件；demo 环境无事件
  // 通道，由下方轮询兜底（同一 settleAttempt 出口，语义一致）
  useEffect(() => {
    if (!inTauri) return;
    return tauriListen(
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
      }),
    );
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
    return tauriListen(
      listen<{ session_id: string; from_seq: number | null; subscription_id: string }>("resync", (e) => {
        termsRef.current.get(e.payload.session_id)?.feed?.onResyncEvent(e.payload.subscription_id);
      }),
    );
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
    const unHk = tauriListen(
      listen<PendingHostKey>("hostkey-event", (ev) => {
        const item = ev.payload;
        if (gateDecidedRef.current.has(item.id)) return; // 近期已决，不回弹
        setHostKeyQueue((q) => (q.some((x) => x.id === item.id) ? q : [...q, item]));
      }),
    );
    const unAp = tauriListen(
      listen<PendingAuthPrompt>("authprompt-event", (ev) => {
        const item = ev.payload;
        if (gateDecidedRef.current.has(item.id)) return;
        setAuthPromptQueue((q) => (q.some((x) => x.id === item.id) ? q : [...q, item]));
      }),
    );
    return () => { unHk(); unAp(); };
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

  // 字体轮：终端字体面预取 + 就绪后全量重绘。canvas/WebGL 字形图集按绘制时刻
  // 已加载的字体取字形——默认字体（Maple 1.7MB）晚于首帧就绪时，先画的 CJK/
  // 框线会以回退链/空白入册；预取把加载提前到建连之前，fonts.ready 后再对全部
  // 存活终端强制 refresh 一次（陈旧图集单元随之重烘焙）。
  useEffect(() => {
    if (typeof document === "undefined" || !document.fonts) return;
    void document.fonts.load('14px "Maple Mono CN Term"', "你好abc┌─0");
    void document.fonts.load('bold 14px "Maple Mono CN Term"', "你好abc┌─0");
    // JetBrains 是设置里可选的第二内置字体：同样预取，避免切字体后首个图集
    // 用回退字形烘焙（切字体的 option 变更会重建图集，但预取让首帧就正确）
    void document.fonts.load('14px "JetBrains Mono Term"', "abc┌─0");
    let cancelled = false;
    let refreshTimer = 0;
    const refreshTerm = (term: Terminal) => {
      try {
        // 强制一次 fontFamily option change：xterm 的 setter 对同值直接 return，
        // 直接回写同一字体栈**不会**触发 handleFontChange（旧实现因此没真正
        // 重建图集）。先追加一个同族 fallback 再还原，两次 setter 都实际变化，
        // 渲染器清空图集并重测 cell；warmup 时刻字体未就绪的框线/CJK 随之重烘焙。
        const fam = term.options.fontFamily;
        term.options.fontFamily = `${fam}, monospace`;
        term.options.fontFamily = fam;
        term.refresh(0, Math.max(0, term.rows - 1));
      } catch { /* 终端已释放 */ }
    };
    const refreshAll = () => {
      for (const [, e] of termsRef.current) refreshTerm(e.term);
      // 主视图之外，tmux 格子同样用 canvas/WebGL 图集：此前只刷新主终端，
      // 字体晚就绪时格子的框线/CJK 会停在回退字形（macOS 上观感发虚的主因之一）。
      for (const e of paneTermsRef.current.values()) refreshTerm(e.term);
    };
    // fonts.ready 只覆盖启动时刻；终端字体栈里的 CJK 兜底（MiSans VF 按
    // unicode-range 分片）会在输出新字时才按需加载——loadingdone 300ms 合帧
    // 重刷一次，避免「首见字形以回退字体入图集」的永久发虚；也避免 MiSans
    // 多分片连续加载时逐片全量重绘。
    const onFontsDone = () => {
      if (refreshTimer) return;
      refreshTimer = window.setTimeout(() => {
        refreshTimer = 0;
        if (!cancelled) refreshAll();
      }, 300);
    };
    if (typeof document.fonts.addEventListener === "function") {
      document.fonts.addEventListener("loadingdone", onFontsDone);
    }
    void document.fonts.ready.then(() => {
      if (!cancelled) refreshAll();
    });
    return () => {
      cancelled = true;
      if (refreshTimer) window.clearTimeout(refreshTimer);
      if (typeof document.fonts.removeEventListener === "function") {
        document.fonts.removeEventListener("loadingdone", onFontsDone);
      }
    };
    // termsRef 是稳定 Map：只挂一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 字形图集自愈（2026-11-09 实测：v0.11.6 长时间使用后终端文字变成别的字形，
  // 选择只临时恢复，退出 macOS 全屏才彻底恢复）。xterm 5.5 的 WebGL 字形图集在
  // 长时间高熵输出（CJK/框线/emoji 混排、多终端共享图集）后存在错位缺陷，上游
  // 6.0 重写图集后修复（已升级 6.0.0 + addon-webgl 0.19）；本兜底继续保留，覆盖
  // 上下文丢失/旧缓存等残余路径——在「窗口重新获得焦点 / 从隐藏变可见 / 原生全屏态
  // 翻转」这些用户愿意接受一次瞬时重画的时刻统一清图集并全屏重绘（原生全屏由窗口
  // resize 探针读 isFullscreen 判定——Tauri 的全屏不触发 DOM fullscreenchange）。
  // 合帧 120ms，避免 focus 与 visibilitychange 连续触发重复烘焙；右键「重绘终端
  // 画面」是随时可用的手动出口。
  useEffect(() => {
    if (typeof window === "undefined") return;
    let timer = 0;
    const repaintAll = () => {
      for (const [, e] of termsRef.current) repaintTerm(e.term, e.webgl);
      for (const e of paneTermsRef.current.values()) repaintTerm(e.term, e.webgl);
    };
    repaintAllRef.current = repaintAll;
    const repair = () => {
      if (document.visibilityState === "hidden" || timer) return;
      timer = window.setTimeout(() => {
        timer = 0;
        repaintAll();
      }, 120);
    };
    const onVisible = () => {
      if (document.visibilityState === "visible") repair();
    };
    window.addEventListener("focus", repair);
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("fullscreenchange", repair);
    return () => {
      if (timer) window.clearTimeout(timer);
      repaintAllRef.current = () => {};
      window.removeEventListener("focus", repair);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("fullscreenchange", repair);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // tmux 面板拖拽布局（2026-11-02）：按标签记的用户布局树——未拖过无条目（沿用自动平铺，
  // 与 paneGrid 同几何）；拖过之后新开的格子从最大格分一半、关掉的格子空间还给邻居。
  // 前端内存态：重连不丢（同 sid），格子全关/关标签即弃（格子本身也不跨重启）。
  const paneLayoutRef = useRef<Map<string, PaneNode>>(new Map());
  // C-b $ 补探针挂钩：探针回包后刷新会话清单（格子标题/主视图名牌随对账换新名）
  useEffect(() => {
    tmuxProbeFollowHook = (sid) => {
      void invoke("tmux_probe", { sid }).catch(() => { /* 探测失败保留旧清单 */ });
      void refreshListsRef.current();
    };
    return () => { tmuxProbeFollowHook = null; };
  }, []);
  // 最近一次排版结果（拖拽命中与像素换算用）：哪个标签、哪棵树、各格几何与分隔条
  const paneLayoutLastRef = useRef<{ sid: string; root: PaneNode; tiles: PaneTile[]; dividers: PaneDivider[] } | null>(null);
  const paneDivsRef = useRef<Map<string, HTMLDivElement>>(new Map());
  // 窗格最大化（保留格子外框）：{ sid, name } 单值——一次只放大一格；换标签不套用
  // （别的标签照常网格），切回自动恢复；格被关/掉线重建后不在清单即自然还原。
  // name=MAIN_KEY 表示主视图；tmux 会话名不允许 ":"，不会与 MAIN_KEY 冲突。
  const paneZoomRef = useRef<{ sid: string; name: string } | null>(null);
  // 建格监听里触发的重排走 ref（layoutTmuxPanes 定义在建格之后）
  const paneRelayoutRef = useRef<() => void>(() => {});
  // 最大化/还原只改 CSS 盒尺寸，xterm 不会自己跟——布局后必须显式 fit（主视图
  // resize PTY；格子 tmux_pane_resize），否则放大后留白、远端 TUI 仍按旧尺寸绘制。
  const paneFitRef = useRef<() => void>(() => {});
  // 工作空间落盘补写走 ref（writeWorkspaceSessions 定义在组件更后；排版/拖拽路径经此
  // 触发 1.5s 防抖写——布局树是 ref 态，不触发 sessions state，轮询回流盖不住拖拽）
  const wsSaveKickRef = useRef<() => void>(() => {});
  // 拖拽控制器走 ref：命令式 DOM 的监听在建格时挂一次，实现随渲染更新（读的全是 ref）。
  // 收尾一律带 pointerId：第二根指针（触摸/笔）的抬起不得结束第一根的拖动
  const tileDragApiRef = useRef<{
    down: (ev: PointerEvent, key: string, owner: string, src: HTMLElement, handle: HTMLElement) => void;
    move: (ev: PointerEvent) => void;
    finish: (apply: boolean, pointerId?: number) => void;
    /** 排版后核对：被拖的格子/名牌已不在（远端结束、换装、关标签）→ 取消拖动，不留残态 */
    sweep: () => void;
  }>({ down: () => {}, move: () => {}, finish: () => {}, sweep: () => {} });
  const paneDivApiRef = useRef<{
    down: (ev: PointerEvent, el: HTMLDivElement) => void;
    move: (ev: PointerEvent) => void;
    end: (pointerId?: number) => void;
    equalize: (el: HTMLDivElement) => void;
  }>({ down: () => {}, move: () => {}, end: () => {}, equalize: () => {} });
  /** 标题栏挂拖动：按住拖到别的格子——中央互换、四边对半分开（主视图名牌与格子标题栏同用）。
   * key 传 getter 时按下瞬间现取（格子名随 tmux 侧改名刷新，闭包不得钉死旧名）。 */
  const bindTileDrag = (handle: HTMLElement, key: string | (() => string), owner: string, src: HTMLElement) => {
    handle.addEventListener("pointerdown", (ev) => tileDragApiRef.current.down(ev, typeof key === "function" ? key() : key, owner, src, handle));
    handle.addEventListener("pointermove", (ev) => tileDragApiRef.current.move(ev));
    handle.addEventListener("pointerup", (ev) => tileDragApiRef.current.finish(true, ev.pointerId));
    handle.addEventListener("pointercancel", (ev) => tileDragApiRef.current.finish(false, ev.pointerId));
    handle.addEventListener("lostpointercapture", (ev) => tileDragApiRef.current.finish(false, ev.pointerId));
  };

  // 终端实例工厂：每个会话一个独立 xterm。
  const makeTerm = useCallback((sessionSid: string) => {
    const mount = termRef.current;
    if (!mount) return null;
    const el = document.createElement("div");
    el.className = "term-session";
    el.dataset.sid = sessionSid;
    mount.appendChild(el);
    // 分屏（T19）会话名牌：平时隐藏，进入分屏后由 applyPanes 填主机名并显示；
    // tmux 面板网格里它是主视图的标题栏，可抓着拖动换位。统一视图语义：所有
    // 窗格的 × 都只关闭当前视图——主视图的 × 只在挂着 tmux 时出现，点它 = 分离
    // tmux 回 shell（标签、tmux 会话、面板格子都不受影响）；不挂 tmux 的主视图
    // 没有可单独关闭的视图，故不显示 ×（关闭整个标签仍走标签上的 ×）。
    const tag = document.createElement("div");
    tag.className = "pane-tag";
    const tagLabel = document.createElement("span");
    tagLabel.className = "pane-tag-label";
    const zoomBtn = document.createElement("button");
    zoomBtn.className = "ghost icon-btn pane-tag-btn main-zoom-btn";
    zoomBtn.setAttribute("data-testid", "main-zoom");
    zoomBtn.title = t("最大化主视图（保留标题栏）");
    zoomBtn.setAttribute("aria-label", zoomBtn.title);
    zoomBtn.innerHTML = PANE_ZOOM_OFF_SVG;
    zoomBtn.addEventListener("click", (ev) => {
      ev.stopPropagation();
      const cur = paneZoomRef.current;
      const same = cur && cur.sid === sessionSid && cur.name === MAIN_KEY;
      paneZoomRef.current = same ? null : { sid: sessionSid, name: MAIN_KEY };
      paneRelayoutRef.current();
      paneFitRef.current();
      // 缩放会隐藏/显示格子并卸掉原落焦元素：布局后把焦点还给当前可见终端
      // （放大时即主视图，还原时按 paneLastFocus 记忆回落），键盘输入不丢一帧。
      focusTermForRef.current(sessionSid);
    });
    const detachBtn = document.createElement("button");
    detachBtn.className = "ghost icon-btn pane-tag-btn main-detach-btn";
    detachBtn.setAttribute("data-testid", "main-detach");
    detachBtn.title = t("关闭此 tmux 视图（回到 shell，tmux 会话继续运行）");
    detachBtn.setAttribute("aria-label", detachBtn.title);
    detachBtn.textContent = "×";
    detachBtn.addEventListener("click", (ev) => {
      ev.stopPropagation();
      const name = sessionsRef.current.find((x) => x.id === sessionSid)?.tmux_attached;
      if (!name) return; // 已分离（按钮应已收起）：幂等
      void (async () => {
        try {
          await invoke("tmux_detach", { sid: sessionSid });
          pushToast("ok", t("已从 tmux 分离：{0}（tmux 会话仍在远端运行）", name));
          void refreshListsRef.current();
          // 按钮随 tmux 视图卸载，焦点会掉到 body：明确还给主视图终端。
          requestAnimationFrame(() => focusTermForRef.current(sessionSid));
        } catch (e) {
          pushToast("err", t("分离 tmux 失败：{0}", errMsg(e)));
        }
      })();
    });
    tag.append(tagLabel, zoomBtn, detachBtn);
    // 分屏窗格的直接控制（Termius 式可见入口）：最大化/还原、交换、退出分屏。
    // 只在 .term-session.pane-* 下由 CSS 显示；动作经 ref 取最新处理函数。
    const splitMaxBtn = document.createElement("button");
    splitMaxBtn.className = "ghost icon-btn pane-tag-btn pane-split-btn pane-max-btn";
    splitMaxBtn.setAttribute("data-testid", "pane-max");
    splitMaxBtn.title = t("最大化此窗格");
    splitMaxBtn.setAttribute("aria-label", splitMaxBtn.title);
    splitMaxBtn.innerHTML = PANE_ZOOM_OFF_SVG;
    splitMaxBtn.addEventListener("click", (ev) => {
      ev.stopPropagation();
      splitPaneActionRef.current.toggleMax(sessionSid);
    });
    const splitSwapBtn = document.createElement("button");
    splitSwapBtn.className = "ghost icon-btn pane-tag-btn pane-split-btn pane-swap-btn";
    splitSwapBtn.setAttribute("data-testid", "pane-swap");
    splitSwapBtn.title = t("交换两个窗格");
    splitSwapBtn.setAttribute("aria-label", splitSwapBtn.title);
    splitSwapBtn.innerHTML = PANE_SWAP_SVG;
    splitSwapBtn.addEventListener("click", (ev) => {
      ev.stopPropagation();
      splitPaneActionRef.current.swap(sessionSid);
    });
    const splitExitBtn = document.createElement("button");
    splitExitBtn.className = "ghost icon-btn pane-tag-btn pane-split-btn pane-exit-btn";
    splitExitBtn.setAttribute("data-testid", "pane-exit");
    splitExitBtn.title = t("退出分屏（两个会话都保留）");
    splitExitBtn.setAttribute("aria-label", splitExitBtn.title);
    splitExitBtn.textContent = "×";
    splitExitBtn.addEventListener("click", (ev) => {
      ev.stopPropagation();
      splitPaneActionRef.current.exit(sessionSid);
    });
    tag.append(splitMaxBtn, splitSwapBtn, splitExitBtn);
    el.appendChild(tag);
    bindTileDrag(tag, MAIN_KEY, sessionSid, el);
    // 分屏窗格状态遮罩（每格独立）：只有本格掉线/重连中时蒙住本格，另一格保持可用。
    // 只在分屏槽位下由 CSS 显示；单窗格断线仍走全局 .dead-overlay（分屏场景不再渲染它）。
    const scrim = document.createElement("div");
    scrim.className = "pane-scrim";
    scrim.setAttribute("data-testid", "pane-state-scrim");
    scrim.dataset.state = "Connected";
    const scrimState = document.createElement("b");
    scrimState.className = "pane-scrim-state";
    const scrimHint = document.createElement("span");
    scrimHint.className = "pane-scrim-hint";
    const scrimActions = document.createElement("div");
    scrimActions.className = "pane-scrim-actions";
    const scrimReconnect = document.createElement("button");
    scrimReconnect.type = "button";
    scrimReconnect.setAttribute("data-testid", "pane-scrim-reconnect");
    scrimReconnect.textContent = t("重连");
    scrimReconnect.addEventListener("click", (ev) => {
      ev.stopPropagation();
      const s = sessionsRef.current.find((x) => x.id === sessionSid);
      if (s) paneReconnectRef.current(s);
    });
    const scrimExit = document.createElement("button");
    scrimExit.type = "button";
    scrimExit.className = "ghost";
    scrimExit.setAttribute("data-testid", "pane-scrim-exit");
    scrimExit.textContent = t("退出分屏");
    scrimExit.addEventListener("click", (ev) => {
      ev.stopPropagation();
      splitPaneActionRef.current.exit(sessionSid);
    });
    scrimActions.append(scrimReconnect, scrimExit);
    scrim.append(scrimState, scrimHint, scrimActions);
    el.appendChild(scrim);
    // allowProposedApi：SearchAddon（registerDecoration，⌘F 高亮计数）、
    // WebLinksAddon（registerLinkProvider）与 linkHandler（OSC 8 激活）均为 proposed API
    const term = new Terminal({
      // 字号/主题（路线图⑥）走 refs：makeTerm 早于偏好载入，载入后由 changeFontSize/
      // applyDerivedTerminal 对已有实例统一改 options 补齐（二十二轮起主题=派生缓存）。
      // P0 终端品质轮：外观五项（字体族/光标样式/闪烁/滚屏行数/字距）同走 refs，
      // 载入后由 applyTermPrefs 补齐存量实例。
      fontSize: fontRef.current, cursorBlink: termCursorBlinkRef.current,
      cursorStyle: termCursorStyleRef.current, scrollback: termScrollbackRef.current,
      letterSpacing: termLetterSpacingRef.current, allowProposedApi: true,
      // UX 二轮精修：xterm 默认字体是 courier-new（Windows 上观感老旧）；行高 1.15 给
      // 行间喘息感；滚轮 100ms 平滑滚动 + Alt 快滚；跨格字形重缩放防框线/符号断裂。
      // UX 六轮：首位内置全量 JetBrains Mono（"JetBrains Mono Term"，styles.css @font-face，
      // 1182 字形含框线/箭头/powerline）——全平台同一等宽字形，框线不再逐格回退系统字体；
      // SF Mono/Cascadia 仅作加载失败兜底。P0 轮起字体族可由用户选（含 Nerd Font 等）。
      fontFamily: termFontFamilyRef.current,
      lineHeight: 1.15,
      // 平滑滚屏（用户反馈 mac 上滚动不跟手）：Windows 滚轮是逐格跳变，100ms 补间
      // 让它顺滑；macOS 触控板给的是像素级连续 delta，xterm 的线性补间每个事件重启
      // 起点、松手后再滑 100ms，反而落后手指——本地终端（Terminal/iTerm/VS Code
      // 默认值 0）都是 1:1 直跟，故 mac 关掉平滑。
      smoothScrollDuration: isMacPlatform() ? 0 : 100,
      // xterm 6 起快滚修饰键固定为 Alt（fastScrollModifier 已移除），只留倍率。
      fastScrollSensitivity: 5,
      rescaleOverlappingGlyphs: true,
      // 字体轮目检（2026-10-23，Edge/WebView2 155 实测）：customGlyphs 的框线
      // 连排几何绘制在当前运行时缺格（`────` 连串只画部分格，JetBrains/Maple
      // 皆中招、HEAD 基线同样复现=环境级回归而非应用代码）。改走字体字形
      // （内置字体都带全量框线/块元素/powerline），格格有墨，横线略带字模侧距。
      customGlyphs: false,
      // tmux/彩色底 TUI 的对比度兜底（见 TERM_MIN_CONTRAST）：主题派生只保证
      // 「ANSI 彩字 × 终端底」，管不到程序自带的「彩底 × 黑字」。
      minimumContrastRatio: TERM_MIN_CONTRAST,
      theme: { ...derivedThemeRef.current.theme },
      // OSC 8 超链接激活（T16）：WebLinksAddon 只管裸 URL 正则检测，
      // OSC 8 由核心 linkHandler 路由（不设则核心弹 confirm 对话框）
      linkHandler: {
        activate: (_ev, uri) => {
          if (inTauri) void invoke("open_url", { url: uri }).catch(() => {});
          else window.open(uri, "_blank");
        },
      },
    });
    // macOS 中文输入法全角标点首击丢失（xterm 5.5.0 去重门缺陷，见 terminal/xterm-ime-gate.ts）
    patchXtermImeGate(term);
    // 远端 TUI 退出后残留鼠标上报：离开备用屏/回到提示符时自动关协议（KI-001 补强）
    installMouseModeGuard(term);
    term.open(el);
    // 原生菜单/系统粘贴落到 xterm textarea 时，xterm 自带的 DOM paste 监听会直接
    // triggerDataEvent → onData，绕过 pasteTextInto 的危险扫描、多行确认与广播抑制
    // （macOS NSMenu 的 ⌘V 在 WebView keydown 之前就被消费，自定义键处理器收不到）。
    // 在终端容器捕获阶段统一收口：preventDefault + 停传后走人类粘贴同一入口。
    el.addEventListener("paste", (ev) => {
      const e = ev as ClipboardEvent;
      const text = e.clipboardData?.getData("text/plain") ?? "";
      e.preventDefault();
      e.stopImmediatePropagation();
      if (text) pasteTextIntoRef.current(term, sessionSid, text);
    }, true);
    // 精确触摸板 1:1 直跟，经典滚轮保留 100ms 补间（见 terminal/scroll.ts）。
    installAdaptiveSmoothScroll(term, el, isMacPlatform() ? 0 : 100);
    // tmux/全屏 TUI 鼠标上报下的滚轮节流：报文按「设置 → 终端 → 滚轮上报频率」
    // 匀速下发（默认 60 次/秒，可跟随刷新率），甩动只保留最新方向/位置，避免远端
    // copy-mode 排队重绘越滚越滞后（见 terminal/wheel-batch.ts）。
    installWheelBatch(term, { intervalMs: wheelIntervalMs });
    // 「回到底部」浮钮（主终端）：普通屏 + 视口离开底部时出现，带剩余行数。
    // ALT 备用屏（全屏 TUI）没有可回的历史，不显示；tmux 格子另挂一份更小的。
    const scrollBottom = document.createElement("button");
    scrollBottom.type = "button";
    scrollBottom.className = "term-scroll-bottom";
    scrollBottom.setAttribute("data-testid", "term-scroll-bottom");
    scrollBottom.hidden = true;
    // 不抢终端焦点：按下即抹掉默认聚焦行为，click 仍会派发
    scrollBottom.addEventListener("pointerdown", (ev) => { ev.preventDefault(); ev.stopPropagation(); });
    scrollBottom.addEventListener("click", (ev) => {
      ev.stopPropagation();
      term.scrollToBottom();
    });
    el.appendChild(scrollBottom);
    let scrollBottomText = "";
    const syncScrollBottom = () => {
      const below = scrollBelow(term);
      if (below <= 0) { if (!scrollBottom.hidden) scrollBottom.hidden = true; return; }
      const label = t("↓ 回到底部（下方 {0} 行）", below);
      if (label !== scrollBottomText) { scrollBottomText = label; scrollBottom.textContent = label; }
      if (scrollBottom.hidden) scrollBottom.hidden = false;
    };
    term.onScroll(syncScrollBottom);
    // 回滚满提示（P2，仅主终端）：每会话一次；≥500ms 节流，避免逐帧判定。
    // tmux 格子不提示——远端自己管缓冲，说「本地回滚满」会撒谎。
    let lastScrollbackCheck = 0;
    term.onWriteParsed(() => {
      syncScrollBottom();
      const now = Date.now();
      if (now - lastScrollbackCheck < 500) return;
      lastScrollbackCheck = now;
      if (scrollbackWarnRef.current.has(sessionSid)) return;
      if (!isScrollbackFull(term)) return;
      scrollbackWarnRef.current.add(sessionSid);
      pushToast("info", t("终端回滚已满（{0} 行历史）：更早输出已丢弃；可在「设置 → 终端 → 回滚行数」调大上限", term.options.scrollback ?? 0));
    });
    // 扩展字符宽度（P0 终端品质轮）：CJK/emoji 宽度按 Unicode 11 表判定——xterm 内置
    // 表基于 Unicode 6，中文/emoji 混排会串格（宽字符占 1 列、ZWJ 序列拆散）。新版表
    // 严格更好，不设开关，恒开。
    term.loadAddon(new Unicode11Addon());
    term.unicode.activeVersion = "11";
    // 渲染器（P0 轮起二选一）：连字依赖 character joiner，仅 DOM 渲染器实现，与 WebGL
    // 合成互斥——连字开则不上 WebGL，关则维持 UX 八轮的 WebGL 优先：高吞吐输出（构建
    // 日志/大 cat）下 DOM 渲染器是首要 CPU 瓶颈；初始化失败（无 GPU/远程桌面）或运行中
    // 上下文丢失时释放 addon 自动回落 DOM 渲染器，主题热更与搜索装饰不受影响
    let webgl: WebglAddon | null = null;
    let liga: LigaturesAddon | null = null;
    if (termLigaRef.current) {
      liga = new LigaturesAddon();
      term.loadAddon(liga);
    } else {
      try {
        const w = new WebglAddon();
        w.onContextLoss(() => { try { w.dispose(); } catch { /* 已释放 */ } });
        term.loadAddon(w);
        webgl = w;
      } catch { webgl = null; /* DOM 渲染器兜底 */ }
    }
    // 终端内搜索（⌘F，T16）：每会话独立实例，高亮随会话保留
    const searchAddon = new SearchAddon();
    searchAddon.onDidChangeResults((r) => {
      // 只更新「当前正在搜的那个终端」的计数：面板格与主视图各有一个实例，
      // 不设门会让背后实例的回调把面板查找的 1/N 覆盖掉
      if (searchAddonRef.current === searchAddon) {
        setSearchResults({ resultCount: r.resultCount, resultIndex: r.resultIndex });
      }
    });
    term.loadAddon(searchAddon);
    // 链接识别（T16）：OSC8 超链接 + URL 自动检测；**带修饰键**的单击经 open_url
    // 打开（仅 http/https）。终端输出是远端可控内容，裸单击即拉起浏览器给了钓鱼面
    // （主流终端同为 Ctrl/Cmd+单击）；未按修饰键时给一次提示，不静默。
    term.loadAddon(new WebLinksAddon((ev, url) => {
      if (!(ev.metaKey || ev.ctrlKey)) {
        const now = Date.now();
        if (now - linkHintAt > 5000) {
          linkHintAt = now;
          pushToast("info", t("链接未打开：按住 {0} 再单击（终端输出可被远端伪造，避免误点）", isMacPlatform() ? "⌘" : "Ctrl"));
        }
        return;
      }
      if (inTauri) void invoke("open_url", { url }).catch(() => {});
      else window.open(url, "_blank");
    }));
    // 可点击路径（P2）：文件路径 + :line:col 识别为链接，点击复制原文——远端路径
    // 没法在本机打开，复制是最诚实有用的动作（本地会话同语义）；协议前缀让路给
    // 上一行的网页链接。toast 告知复制了什么。
    term.registerLinkProvider(pathLinkProvider(term, (text) => {
      Promise.resolve(inTauri ? clipboard.writeText(text) : navigator.clipboard?.writeText(text))
        .then(() => pushToast("ok", t("已复制路径 {0}", text)))
        .catch(() => pushToast("err", t("复制路径失败（权限拒绝或窗口无焦点）")));
    }));
    // 图片协议（P2）：sixel + iTerm2（OSC 1337）内嵌图渲染，恒开（ghostty/iTerm
    // 语义；ssh 里 cat 图片/带图工具直接可见）。默认存储上限内自动淘汰最旧图。
    const imgAddon = new ImageAddon();
    term.loadAddon(imgAddon);
    // 远程设置的标题（OSC 0/2，T16）：按会话记录，显示在终端头部。
    // 稳定轮：远端可高频刷标题（时钟/循环 printf）——150ms 合帧 + 同值跳过，
    // 不再逐条 setState 整树重渲染（OSC 133 标记同款去抖口径）
    let titlePending: string | null = null;
    let titleTimer: number | null = null;
    term.onTitleChange((t) => {
      if (!t) return;
      titlePending = t;
      if (titleTimer === null) {
        titleTimer = window.setTimeout(() => {
          titleTimer = null;
          const v = titlePending;
          titlePending = null;
          if (v) setOscTitles((prev) => (prev[sessionSid] === v ? prev : { ...prev, [sessionSid]: v }));
        }, 150);
      }
    });
    // 十五轮：选中即复制——划选非空立即写系统剪贴板（清选不写；PuTTY/Xshell 语义）。
    // onSelectionChange 是 IEvent<void>（xterm 5.5），选区内容回调里自取
    term.onSelectionChange(() => {
      if (!copyOnSelectRef.current) return;
      const sel = term.getSelection();
      if (!sel) return;
      Promise.resolve(inTauri ? clipboard.writeText(sel) : navigator.clipboard?.writeText(sel)).catch(() => {});
    });
    // 十六轮：BEL→标签闪烁（恒开，6s 自清）+ 系统通知（开关+窗口失焦门+每会话 10s 节流）。
    // 长命令完成的通用信号：用户切走窗口后远端任务结束/需要关注时主动提示。
    // P2-c：OSC 9（远端主动通知，iTerm2 惯例）走同一通路——闪烁恒开，通知同门同节流；
    // 策略即既有「响铃时系统通知」开关，不另立旋钮。
    let bellLit = false;
    const flashAndNotify = (body: string, suffix = "") => {
      // 稳定轮：BEL 风暴闸——已亮则跳过（远端循环 \007 曾每条造新 Set + 新
      // 6s timer 打满渲染）；亮/灭沿只在边沿各 setState 一次
      if (!bellLit) {
        bellLit = true;
        setBellSids((cur) => new Set(cur).add(sessionSid));
        setTimeout(() => {
          bellLit = false;
          setBellSids((cur) => { const n = new Set(cur); n.delete(sessionSid); return n; });
        }, 6000);
      }
      if (!bellNotifyRef.current || !inTauri) return;
      if (document.hasFocus()) return;
      const now = Date.now();
      if (now - (lastBellNotifRef.current.get(sessionSid) ?? 0) < 10_000) return;
      lastBellNotifRef.current.set(sessionSid, now);
      void (async () => {
        const host = sessionsRef.current.find((x) => x.id === sessionSid)?.host_name ?? t("该会话");
        try {
          let granted = await isPermissionGranted();
          if (!granted) granted = (await requestPermission()) === "granted";
          if (granted) sendNotification({ title: `🔔 ${host}${suffix}`, body });
        } catch { /* 通知失败静默——标签闪烁仍在 */ }
      })();
    };
    term.onBell(() => flashAndNotify(t("终端响铃（BEL）：远端可能有命令完成或需要关注"), t(" — 终端响铃")));
    term.parser.registerOscHandler(9, (data) => { flashAndNotify(data.slice(0, 200) || t("远端通知")); return true; });
    term.parser.registerOscHandler(52, (data) => osc52ConsumeRef.current(sessionSid, data));
    // P1-b 增量：OSC 133 shell 集成标记直达刷新。核心输出通道广播的是喂屏原始
    // 字节，133 原样到达 FE xterm（xterm 默认忽略）——在此注册 parser handler，
    // 块开/合（A/B/C/D）瞬间即可刷新块面板，未开面板时零取数。150ms 尾沿去抖
    // 合并 ConPTY 提示符重绘的 A/B 突发；无集成 shell 无 133，5s 轮询仍是兜底。
    let blocksMarkTimer: number | null = null;
    term.parser.registerOscHandler(133, (data) => {
      const parts = data.split(";");
      const kind = parts[0]?.trim();
      if (kind === "A" || kind === "B" || kind === "C" || kind === "D") {
        if (blocksMarkTimer === null) {
          blocksMarkTimer = window.setTimeout(() => {
            blocksMarkTimer = null;
            blocksActivityRef.current(sessionSid);
          }, 150);
        }
      }
      // 块失败通知：D 标记带退出码（`133;D;<code>`，FinalTerm/iTerm2 惯例）且非零
      // 时提示。标签闪烁恒开；系统通知走「响铃时系统通知」既有开关 + 窗口失焦门
      // + 节流（flashAndNotify 内建——与 OSC 9 同款策略，不另立旋钮）；当前会话
      // 不 toast（正看着终端，失败直接可见），后台会话才 toast 点名失败命令
      // （read_blocks 取最新块对账——D 广播前屏幕已吃进标记，块必已闭合；取不到
      // 或退出码对不上就只报退出码，不虚构命令）。每会话 10s 节流防失败循环刷屏。
      if (kind === "D") {
        const code = Number.parseInt(parts[1]?.trim() ?? "", 10);
        if (Number.isInteger(code) && code !== 0) {
          flashAndNotify(t("❌ 命令失败（exit {0}）", code), t(" — 命令失败"));
          if (sidRef.current !== sessionSid) {
            const now = Date.now();
            if (now - (lastFailToastRef.current.get(sessionSid) ?? 0) >= 10_000) {
              lastFailToastRef.current.set(sessionSid, now);
              void (async () => {
                let cmd = "";
                try {
                  const rows = await invoke("read_blocks", { sid: sessionSid, limit: 1 }) as BlockInfo[];
                  const hit = rows?.[rows.length - 1];
                  if (hit && hit.exit_code === code) cmd = hit.command;
                } catch { /* 取不到就只报退出码 */ }
                const host = sessionsRef.current.find((x) => x.id === sessionSid)?.host_name ?? t("该会话");
                pushToast("err", t("❌ {0} 命令失败（exit {1}）{2}", host, code, cmd ? `：${cmd}` : ""));
              })();
            }
          }
        }
      }
      return false; // 不消费：xterm 维持对 133 的默认忽略，后续行为不变
    });
    // dev 门控探针钩子（e2e/冒烟专用；release 构建不存在）：
    // 暴露 xterm 实例供注入脚本做全缓冲断言（B11 无丢字/重复）
    if (import.meta.env.DEV) {
      const w = window as unknown as { __t_terms?: Map<string, Terminal>; __t_liga?: Set<string>; __t_pathmatch?: typeof matchPaths; __t_img?: Map<string, ImageAddon> };
      w.__t_terms ??= new Map();
      w.__t_terms.set(sessionSid, term);
      // P0 轮：连字生效集合（character joiner 不进 options，无公开可读面——spec 断言用）
      w.__t_liga ??= new Set();
      if (liga) w.__t_liga.add(sessionSid); else w.__t_liga.delete(sessionSid);
      // 可点击路径（P2）：纯匹配器直测面
      w.__t_pathmatch = matchPaths;
      // 图片协议（P2）：addon 实例（getImageAtBufferCell 断言渲染发生）
      w.__t_img ??= new Map();
      w.__t_img.set(sessionSid, imgAddon);
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
          Promise.resolve(inTauri ? clipboard.writeText(sel) : navigator.clipboard?.writeText(sel))
            .catch(() => {});
          ev.preventDefault();
          return false;
        }
        return true; // 无选中 → xterm 原生 copy 事件
      }
      if (key === "v") {
        // R25 §318：粘贴语义收口在 pasteTextInto（终端右键「粘贴」同源）
        Promise.resolve(inTauri
          ? clipboard.readText().then((t) => pasteTextIntoRef.current(term, sessionSid, t))
          : navigator.clipboard?.readText().then((t) => pasteTextIntoRef.current(term, sessionSid, t))
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
          keymap: keymapRef.current,
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
      // 触摸板/鼠标悬停防护：远端开启 any-motion（1003）后，无按键移动会被
      // xterm 编码成 SGR/X10 报告；应用退出而模式未复位时，这些报告会原样进 PTY
      // 并被 shell 回显成满屏 `35;x;yM`。只丢弃无按键移动，点击/拖动/滚轮保留。
      // 普通屏里出现移动报告几乎必然是残留协议（真正需要 hover 的 TUI 都在备用屏）：
      // 顺手关掉协议，后续滚轮/点击不再继续灌报文（无 shell 集成的场景也能自愈）。
      const data = stripMotionOnlyMouseReports(d);
      if (data !== d && term.buffer.active.type === "normal") resetMouseReporting(term);
      if (!data) return;
      // 死会话/断线输入拦截（P2-7 + R26 §6.4）：PTY 已死（含自动重连中——通道
      // 不存在），键入只会静默进黑洞或排队给未来连接——明说，不假装
      const st = sessionsRef.current.find((x) => x.id === sessionSid)?.state;
      if (st && inputBlockedState(st)) {
        if (!deadWarned) {
          deadWarned = true;
          const why = st === "Disconnected" ? t("会话已断开") : t("网络中断（自动重连中）");
          term.write(`\r\n\x1b[33m⚠ ${t("{0}——键入未发送。", why)}\x1b[0m\r\n`);
        }
        return;
      }
      deadWarned = false;
      // 主视图 attach 了 tmux 时 C-b 同样武装（见 tmuxPrefixArm）：前缀后一键的输入法标点还原；
      // 消费的是 C-b $ → 改名框要弹，排补探针让名牌在改名提交后跟上
      const { keys, dollar } = takeTmuxPrefixKey(sessionSid, data);
      if (dollar) scheduleTmuxProbeFollow(sessionSid);
      invoke("send_keys", { sid: sessionSid, keys }).catch((e) => {
        term.write(`\r\n\x1b[31m✕ ${errMsg(e)}\x1b[0m\r\n`);
      });
      // 广播扇出（P2-a）：主发之后复制到勾选会话（目标逐会话过离线闸，见 broadcastSendRef）
      if (!bcastSuppressRef.current) broadcastSendRef.current(sessionSid, keys);
    });
    return {
      term, el, search: searchAddon, tag, tagLabel, zoomBtn, detachBtn,
      splitMaxBtn, splitSwapBtn, splitExitBtn,
      scrim, scrimState, scrimHint, scrimReconnect,
      feed: null as OutputFeed | null, webgl, liga,
    };
  }, []);

  // ---- tmux 面板（一标签多 tmux 会话）：格子 xterm 工厂 / 订阅 / 销毁 / 布局 ----
  // 主终端工厂的精简同构：字体/主题/光标/滚屏同走 refs；WebGL 按预算挂、上下文丢失
  // 回落 DOM；不挂搜索/路径链接，OSC 只挂 52（剪贴板写入策略与主终端同一套——tmux
  // 复制模式与 claude code 的复制都走它）。格子定位是「同时看」，深度操作切主视图。
  // 输入直写格子通道（tmux_pane_input），绝不经主会话 send_keys。
  const closeTmuxPaneRef = useRef<(sid: string, paneId: number) => Promise<void>>(async () => {});
  const paneClosedRef = useRef<Map<string, number>>(new Map());
  const makePaneTerm = useCallback((sid: string, paneId: number, name: string): PaneTermEntry | null => {
    const mount = termRef.current;
    if (!mount) return null;
    const cell = document.createElement("div");
    cell.className = "tmux-cell";
    cell.dataset.sid = sid;
    cell.dataset.paneId = String(paneId);
    cell.dataset.tmux = name;
    cell.setAttribute("data-testid", "tmux-cell");
    cell.style.display = "none";
    const head = document.createElement("div");
    head.className = "tmux-cell-head";
    const label = document.createElement("span");
    label.className = "tmux-cell-name mono";
    label.setAttribute("data-testid", "tmux-cell-name");
    label.textContent = name;
    const stateTag = document.createElement("span");
    stateTag.className = "tmux-cell-state";
    stateTag.textContent = t("已断开 · 重连后自动恢复");
    // 最大化/还原（用户拍板：在 × 左边；放大保留外框——标题栏常显，还原钮就在框上）
    const zoomBtn = document.createElement("button");
    zoomBtn.className = "ghost icon-btn tmux-cell-zoom";
    zoomBtn.setAttribute("data-testid", "tmux-cell-zoom");
    zoomBtn.title = t("最大化窗格（保留标题栏）");
    zoomBtn.setAttribute("aria-label", zoomBtn.title);
    zoomBtn.innerHTML = PANE_ZOOM_OFF_SVG;
    zoomBtn.addEventListener("click", (ev) => {
      ev.stopPropagation();
      const cur = paneZoomRef.current;
      const same = cur && cur.sid === sid && cur.name === entry.name;
      paneZoomRef.current = same ? null : { sid, name: entry.name };
      paneRelayoutRef.current();
      paneFitRef.current();
      // 同主视图缩放：还原后焦点回到该格（仍可见），放大时落在被放大的格上。
      focusTermForRef.current(sid);
    });
    const closeBtn = document.createElement("button");
    closeBtn.className = "ghost icon-btn tmux-cell-close";
    closeBtn.setAttribute("data-testid", "tmux-cell-close");
    closeBtn.title = t("关闭窗格（只断开此视图，tmux 会话继续运行）");
    closeBtn.setAttribute("aria-label", closeBtn.title);
    closeBtn.textContent = "×";
    head.append(label, stateTag, zoomBtn, closeBtn);
    const body = document.createElement("div");
    body.className = "tmux-cell-body";
    cell.append(head, body);
    mount.appendChild(cell);
    const term = new Terminal({
      fontSize: fontRef.current, cursorBlink: termCursorBlinkRef.current,
      cursorStyle: termCursorStyleRef.current, scrollback: termScrollbackRef.current,
      letterSpacing: termLetterSpacingRef.current, allowProposedApi: true,
      fontFamily: termFontFamilyRef.current, lineHeight: 1.15,
      smoothScrollDuration: isMacPlatform() ? 0 : 100,
      // xterm 6 起快滚修饰键固定为 Alt（fastScrollModifier 已移除），只留倍率。
      fastScrollSensitivity: 5,
      rescaleOverlappingGlyphs: true, customGlyphs: false,
      // 格子恒显示 tmux（默认样式就是彩底黑字），对比度兜底无条件开
      minimumContrastRatio: TERM_MIN_CONTRAST,
      theme: { ...derivedThemeRef.current.theme },
    });
    // tmux 格子与主终端同一输入法路径（原型已装则幂等跳过）
    patchXtermImeGate(term);
    // tmux 格子同样防残留上报（tmux 自身退出/崩溃时 1003 可能留着）
    installMouseModeGuard(term);
    term.open(body);
    // 与主终端同一收口：系统粘贴不得绕过 pasteTextInto（危险/多行确认、面板格子存活门）。
    body.addEventListener("paste", (ev) => {
      const e = ev as ClipboardEvent;
      const text = e.clipboardData?.getData("text/plain") ?? "";
      e.preventDefault();
      e.stopImmediatePropagation();
      if (text) pasteTextIntoRef.current(term, sid, text, key);
    }, true);
    installAdaptiveSmoothScroll(term, body, isMacPlatform() ? 0 : 100);
    // 面板格子与主终端同一滚轮节流路径（同一频率设置，tmux 鼠标上报时避免远端排重绘）
    installWheelBatch(term, { intervalMs: wheelIntervalMs });
    // 「回到底部」浮钮（tmux 格子，小号）：视口离开底部才出现。远端 copy-mode 由
    // tmux 接管视口——鼠标上报开着时滚轮直发远端，本地 viewportY 不动，故此处
    // 自然不出现（只看本地真滚过的场景，不谎报远端缓冲）。
    const scrollBottom = document.createElement("button");
    scrollBottom.type = "button";
    scrollBottom.className = "term-scroll-bottom pane";
    scrollBottom.setAttribute("data-testid", "pane-scroll-bottom");
    scrollBottom.hidden = true;
    scrollBottom.addEventListener("pointerdown", (ev) => { ev.preventDefault(); ev.stopPropagation(); });
    scrollBottom.addEventListener("click", (ev) => {
      ev.stopPropagation();
      term.scrollToBottom();
    });
    body.appendChild(scrollBottom);
    let scrollBottomText = "";
    const syncScrollBottom = () => {
      const below = scrollBelow(term);
      if (below <= 0) { if (!scrollBottom.hidden) scrollBottom.hidden = true; return; }
      const label = t("↓ 回到底部（下方 {0} 行）", below);
      if (label !== scrollBottomText) { scrollBottomText = label; scrollBottom.textContent = label; }
      if (scrollBottom.hidden) scrollBottom.hidden = false;
    };
    term.onScroll(syncScrollBottom);
    term.onWriteParsed(syncScrollBottom);
    term.loadAddon(new Unicode11Addon());
    term.unicode.activeVersion = "11";
    // 面板格也有查找（与主终端同款实例）：⌘F 聚焦哪格就搜哪格，不再只搜背后主视图
    const searchAddon = new SearchAddon();
    searchAddon.onDidChangeResults((r) => {
      if (searchAddonRef.current === searchAddon) {
        setSearchResults({ resultCount: r.resultCount, resultIndex: r.resultIndex });
      }
    });
    term.loadAddon(searchAddon);
    let webgl: WebglAddon | null = null;
    let liga: LigaturesAddon | null = null;
    const glInUse = [...termsRef.current.values()].filter((x) => x.webgl).length
      + [...paneTermsRef.current.values()].filter((x) => x.webgl).length;
    // 渲染器与主终端同构（找茬四轮 C3）：连字开=DOM+LigaturesAddon（joiner 仅
    // DOM 实现）、关=WebGL 优先按预算——此前格子恒挂 WebGL，用户开连字后主视图
    // 走 DOM、格子仍 WebGL，同一屏两种字形引擎（连字只对主视图生效）。
    if (termLigaRef.current) {
      try {
        liga = new LigaturesAddon();
        term.loadAddon(liga);
      } catch { liga = null; }
    } else if (glInUse < PANE_WEBGL_BUDGET) {
      try {
        const w = new WebglAddon();
        w.onContextLoss(() => { try { w.dispose(); } catch { /* 已释放 */ } });
        term.loadAddon(w);
        webgl = w;
      } catch { webgl = null; /* DOM 渲染器兜底 */ }
    }
    // 名字现取（改名跟随会把条目名换掉，闭包钉建格时参数=询问卡源标签停在旧名）
    term.parser.registerOscHandler(52, (data) => {
      const curName = paneTermsRef.current.get(`${sid}:${paneId}`)?.name ?? name;
      return osc52ConsumeRef.current(sid, data, curName);
    });
    term.loadAddon(new WebLinksAddon((_ev, url) => {
      if (inTauri) void invoke("open_url", { url }).catch(() => {});
      else window.open(url, "_blank");
    }));
    term.onSelectionChange(() => {
      if (!copyOnSelectRef.current) return;
      const sel = term.getSelection();
      if (!sel) return;
      Promise.resolve(inTauri ? clipboard.writeText(sel) : navigator.clipboard?.writeText(sel)).catch(() => {});
    });
    const key = `${sid}:${paneId}`;
    // 面板格同样接 BEL / OSC 9（与主终端同一套开关与失焦门）：此前只有主视图会
    // 闪标签/发通知，面板里跑的长命令结束完全无声。格子标题亮 6s 作为就地信号。
    let paneBellLit = false;
    const paneBell = (body: string) => {
      if (!paneBellLit) {
        paneBellLit = true;
        cell.classList.add("bell");
        setTimeout(() => { paneBellLit = false; cell.classList.remove("bell"); }, 6000);
      }
      if (!bellNotifyRef.current || !inTauri) return;
      if (document.hasFocus()) return;
      const now = Date.now();
      if (now - (lastBellNotifRef.current.get(key) ?? 0) < 10_000) return;
      lastBellNotifRef.current.set(key, now);
      void (async () => {
        const host = sessionsRef.current.find((x) => x.id === sid)?.host_name ?? t("该会话");
        try {
          let granted = await isPermissionGranted();
          if (!granted) granted = (await requestPermission()) === "granted";
          if (granted) sendNotification({ title: `🔔 ${host} · ${name}`, body });
        } catch { /* 通知失败静默——格子标题闪烁仍在 */ }
      })();
    };
    term.onBell(() => paneBell(t("终端响铃（BEL）：远端可能有命令完成或需要关注")));
    term.parser.registerOscHandler(9, (data) => { paneBell(data.slice(0, 200) || t("远端通知")); return true; });
    const entry: PaneTermEntry = { sid, paneId, name, term, cell, body, zoomBtn, search: searchAddon, webgl, liga, bornAt: performance.now(), alive: true, deadWarned: false };
    // ⌘ 组合（mac）：复制/粘贴/全选作用于本格，其余 ⌘ 不进格子通道（主终端同口径）
    term.attachCustomKeyEventHandler((ev) => {
      if (ev.type !== "keydown" || !ev.metaKey) return true;
      const k = ev.key.toLowerCase();
      if (k === "c") {
        if (!term.hasSelection()) return true;
        const sel = term.getSelection();
        Promise.resolve(inTauri ? clipboard.writeText(sel) : navigator.clipboard?.writeText(sel)).catch(() => {});
      } else if (k === "v") {
        Promise.resolve(inTauri ? clipboard.readText() : navigator.clipboard?.readText())
          .then((txt) => { if (txt) pasteTextIntoRef.current(term, sid, txt, key); })
          .catch(() => {});
      } else if (k === "a") {
        term.selectAll();
      }
      ev.preventDefault();
      ev.stopPropagation();
      return false;
    });
    term.onData((d) => {
      // 同主终端：丢弃触摸板/悬停产生的无按键移动报告，避免灌进 tmux 面板。
      // 普通屏里的移动报告按残留协议处理（关掉后续报文），备用屏的 TUI 不受影响。
      const data = stripMotionOnlyMouseReports(d);
      if (data !== d && term.buffer.active.type === "normal") resetMouseReporting(term);
      if (!data) return;
      if (!entry.alive) {
        warnDeadPane(entry);
        return;
      }
      entry.deadWarned = false;
      // 消费的是 C-b $ → 格子里改名框要弹：排补探针（标题随对账跟上）
      const { keys, dollar } = takeTmuxPrefixKey(key, data);
      if (dollar) scheduleTmuxProbeFollow(sid);
      invoke("tmux_pane_input", { sid, paneId, keys }).catch((e) => {
        term.write(`\r\n\x1b[31m✕ ${errMsg(e)}\x1b[0m\r\n`);
      });
    });
    closeBtn.addEventListener("click", (ev) => {
      ev.stopPropagation();
      void closeTmuxPaneRef.current(sid, paneId);
    });
    // 点格子标题栏即聚焦本格（按钮除外）；焦点格指示走 CSS :focus-within（主视图同判据）
    head.addEventListener("mousedown", (ev) => {
      if (ev.target === closeBtn || ev.target === zoomBtn) return;
      ev.preventDefault();
      term.focus();
    });
    head.title = t("拖动标题栏可移动位置：落在格子中央互换，落在边缘对半分开");
    bindTileDrag(head, () => entry.name, sid, cell);
    // 调试/取证钩子（曾仅 DEV 注册——真机 release 排障读不到表，改为无条件注册；
    // 两行 Map 开销，disposePane 同步删除）
    const w = window as unknown as { __t_pane_terms?: Map<string, Terminal>; __t_pane_layout?: Map<string, PaneNode> };
    w.__t_pane_terms ??= new Map();
    w.__t_pane_terms.set(key, term);
    w.__t_pane_layout = paneLayoutRef.current; // 工作空间轮：布局树取证（同一 Map 引用）
    return entry;
  }, []);

  // 被摘的格子握着焦点时记一笔：同名格随后在本标签重建（掉线重连原位换装）→ 排版后焦点
  // 交给新格，而不是留在兜底的主终端（用户以为还在原格里，接着打的字会进主视图）
  const paneFocusHandoffRef = useRef<{ sid: string; name: string; at: number } | null>(null);
  const disposePane = useCallback((key: string) => {
    const e = paneTermsRef.current.get(key);
    if (!e) return;
    const hadFocus = e.cell.contains(document.activeElement);
    paneTermsRef.current.delete(key);
    if (paneLastFocusRef.current.get(e.sid) === key) paneLastFocusRef.current.set(e.sid, "main");
    try { e.webgl?.dispose(); } catch { /* 已释放 */ }
    try { e.term.dispose(); } catch { /* 已释放 */ }
    e.cell.remove();
    // 被摘的格子握着焦点：元素移除不触发 focusout，焦点会悬空在 body（mac 原生 Ctrl
    // 拦截还会按残留的 pane_id 改投死格）——交还活动会话的主终端
    if (hadFocus && sidRef.current) {
      paneFocusHandoffRef.current = { sid: e.sid, name: e.name, at: Date.now() };
      termsRef.current.get(sidRef.current)?.term.focus();
    }
    (window as unknown as { __t_pane_terms?: Map<string, Terminal> }).__t_pane_terms?.delete(key);
  }, []);

  // 建格并订阅格子输出（单订阅者：订阅即接走核心侧积压——attach 首屏重绘随之到达）。
  // 通道回调先核对实例仍在册：格子已销毁后迟到的帧不得写进已 dispose 的终端。
  const ensurePaneTerm = useCallback(async (sid: string, paneId: number, name: string) => {
    const key = `${sid}:${paneId}`;
    if (paneTermsRef.current.has(key)) return;
    const made = makePaneTerm(sid, paneId, name);
    if (!made) return;
    paneTermsRef.current.set(key, made);
    const channel = MkChannel();
    channel.onmessage = (msg) => {
      if (paneTermsRef.current.get(key) !== made) return;
      // 流终结（核心已摘除此格：用户 exit / C-b d / 重建换装 / 会话关闭）：即刻对账
      // 而非干等 3s 快照；pane_id 永不复用，同键 5s 内不因在途旧快照重建
      if (msg === "eof") {
        paneClosedRef.current.set(key, Date.now());
        void refreshListsRef.current();
        return;
      }
      const bytes = msg instanceof Uint8Array ? msg : msg instanceof ArrayBuffer ? new Uint8Array(msg) : null;
      if (bytes) made.term.write(bytes);
    };
    try {
      await invoke("tmux_pane_subscribe", { sid, paneId, onEvent: channel });
    } catch {
      disposePane(key); // 格子已不在核心侧（快照滞后）：收掉，下一轮对账以真相为准
    }
  }, [makePaneTerm, disposePane]);

  // 分隔条（拖拽布局）：每条 = 布局树里某容器相邻两子节点的边界，命令式元素按「容器路径/
  // 下标」复用——拖动中树形不变、元素不重建，指针捕获不丢。静态分隔线仍由格子 1px 边框
  // 承担，条只是 8px 命中区，悬停/拖动时亮 accent。
  const syncPaneDividers = useCallback((dividers: PaneDivider[]) => {
    const mount = termRef.current;
    const live = paneDivsRef.current;
    const seen = new Set<string>();
    const pct = (x: number) => `${(x * 100).toFixed(4)}%`;
    for (const d of dividers) {
      const id = `${d.path.join(".")}/${d.index}`;
      seen.add(id);
      let el = live.get(id);
      if (!el) {
        const div = document.createElement("div");
        div.className = "tmux-div";
        div.setAttribute("data-testid", "tmux-div");
        div.setAttribute("role", "separator");
        div.addEventListener("pointerdown", (ev) => paneDivApiRef.current.down(ev, div));
        div.addEventListener("pointermove", (ev) => paneDivApiRef.current.move(ev));
        div.addEventListener("pointerup", (ev) => paneDivApiRef.current.end(ev.pointerId));
        div.addEventListener("pointercancel", (ev) => paneDivApiRef.current.end(ev.pointerId));
        div.addEventListener("lostpointercapture", (ev) => paneDivApiRef.current.end(ev.pointerId));
        div.addEventListener("dblclick", () => paneDivApiRef.current.equalize(div));
        mount?.appendChild(div);
        live.set(id, div);
        el = div;
      }
      el.dataset.path = d.path.join(".");
      el.dataset.index = String(d.index);
      el.dataset.dir = d.dir;
      el.classList.toggle("div-v", d.dir === "row");
      el.classList.toggle("div-h", d.dir === "col");
      el.setAttribute("aria-orientation", d.dir === "row" ? "vertical" : "horizontal");
      el.title = t("拖拽调整大小；双击均分");
      if (d.dir === "row") {
        el.style.left = `calc(${pct(d.x)} - 4px)`; el.style.top = pct(d.y);
        el.style.width = "8px"; el.style.height = pct(d.len);
      } else {
        el.style.top = `calc(${pct(d.y)} - 4px)`; el.style.left = pct(d.x);
        el.style.height = "8px"; el.style.width = pct(d.len);
      }
    }
    // 拖动中的条被删（远端结束/换装改了树形）：元素被移除时 lostpointercapture 派发到
    // document、元素自己的监听收不到——此处先收尾，不留 resize 光标与陈旧拖动态
    for (const [id, el] of live) {
      if (seen.has(id)) continue;
      if (el.classList.contains("dragging")) paneDivApiRef.current.end();
      el.remove();
      live.delete(id);
    }
  }, []);

  // 布局：活动会话（非分屏）有格子 → 主视图 + 格子按布局树平铺；否则清掉全部内联几何
  // （单 pane 的 inset:0 与分屏的类几何原样生效）。用户没拖过=自动平铺（defaultLayout，
  // 最大化钮换装：zoom 态钮=还原图标+文案，常态钮=最大化图标+文案。建格时默认
  // 常态；掉线换装重建的格子（新 DOM 默认态）与跨标签切换的对齐都在排版后由此统一刷
  const syncAllZoomBtns = () => {
    const z = paneZoomRef.current;
    const active = sidRef.current;
    const main = active ? termsRef.current.get(active) : null;
    if (main) {
      const on = z != null && z.sid === active && z.name === MAIN_KEY;
      const title = on ? t("还原主视图（回到网格）") : t("最大化主视图（保留标题栏）");
      if (main.zoomBtn.title !== title) main.zoomBtn.title = title;
      if (main.zoomBtn.getAttribute("aria-label") !== title) main.zoomBtn.setAttribute("aria-label", title);
      const svg = on ? PANE_ZOOM_ON_SVG : PANE_ZOOM_OFF_SVG;
      if (main.zoomBtn.innerHTML !== svg) main.zoomBtn.innerHTML = svg;
    }
    for (const e of paneTermsRef.current.values()) {
      const on = z != null && z.sid === e.sid && z.name === e.name;
      const title = on ? t("还原窗格（回到网格）") : t("最大化窗格（保留标题栏）");
      // 等值跳过（找茬四轮 B6）：innerHTML setter 无条件「删子树+重解析」、
      // textContent 同值也重建文本节点——拖分隔条的 pointermove 热路径每帧
      // layoutTmuxPanes 时，5 格满配=每帧 5 次 SVG 重解析纯 churn
      if (e.zoomBtn.title !== title) e.zoomBtn.title = title;
      if (e.zoomBtn.getAttribute("aria-label") !== title) e.zoomBtn.setAttribute("aria-label", title);
      const svg = on ? PANE_ZOOM_ON_SVG : PANE_ZOOM_OFF_SVG;
      if (e.zoomBtn.innerHTML !== svg) e.zoomBtn.innerHTML = svg;
    }
  };

  // 与 paneGrid 同几何：主视图在首、格子按快照顺序——核心愿望清单序，重建原位换装不挪位；
  // 乐观开格（快照未含）按出生序垫后）；拖过=该标签的布局树，先与在场格子对账。
  const layoutTmuxPanes = useCallback(() => {
    const mount = termRef.current;
    const active = sidRef.current;
    const cells: PaneTermEntry[] = [];
    if (active && !groupOf(active)) {
      const seen = new Set<string>();
      for (const p of sessionsRef.current.find((x) => x.id === active)?.panes ?? []) {
        const k = `${active}:${p.pane_id}`;
        const e = paneTermsRef.current.get(k);
        if (e) { cells.push(e); seen.add(k); }
      }
      const extra = [...paneTermsRef.current.entries()]
        .filter(([k, e]) => e.sid === active && !seen.has(k))
        .map(([, e]) => e)
        .sort((a, b) => a.bornAt - b.bornAt);
      cells.push(...extra);
    }
    const place = (el: HTMLElement, g: { left: number; top: number; width: number; height: number } | null) => {
      if (!g) { el.style.left = ""; el.style.top = ""; el.style.right = ""; el.style.bottom = ""; return; }
      el.style.left = `${(g.left * 100).toFixed(4)}%`;
      el.style.top = `${(g.top * 100).toFixed(4)}%`;
      el.style.right = `${((1 - g.left - g.width) * 100).toFixed(4)}%`;
      el.style.bottom = `${((1 - g.top - g.height) * 100).toFixed(4)}%`;
    };
    // 布局按 tmux 会话名认格：重建换装瞬间同名旧格可能尚未收掉——只排第一个（快照在册者在前）
    const byKey = new Map<string, PaneTermEntry>();
    for (const e of cells) if (!byKey.has(e.name)) byKey.set(e.name, e);
    const shown = new Set(byKey.values());
    for (const e of paneTermsRef.current.values()) if (!shown.has(e)) e.cell.style.display = "none";
    for (const [s, e] of termsRef.current) {
      if (s !== active || byKey.size === 0) place(e.el, null);
    }
    for (const s of [...paneLayoutRef.current.keys()]) {
      if (!sessionsRef.current.some((x) => x.id === s)) paneLayoutRef.current.delete(s);
    }
    mount?.classList.toggle("has-tmux-panes", byKey.size > 0);
    if (!mount || !active || byKey.size === 0) {
      // 格子全关 = 布局作废（下次开面板从自动平铺起）；分屏只是暂时藏起格子，布局留着
      if (active && !groupOf(active)) paneLayoutRef.current.delete(active);
      // 最大化残记就地清掉（无格可放大）；主视图 display 交还类规则（zoom 曾置 none）
      if (active && paneZoomRef.current?.sid === active) paneZoomRef.current = null;
      const m0 = active ? termsRef.current.get(active) : null;
      if (m0) m0.el.style.display = "";
      paneLayoutLastRef.current = null;
      syncPaneDividers([]);
      tileDragApiRef.current.sweep();
      syncAllZoomBtns();
      return;
    }
    const keys = [MAIN_KEY, ...byKey.keys()];
    let root = paneLayoutRef.current.get(active) ?? null;
    if (root) {
      const box = mount.getBoundingClientRect();
      root = syncLayout(root, keys, box.height > 0 ? box.width / box.height : 16 / 9);
      if (root) {
        paneLayoutRef.current.set(active, root);
        wsSaveKickRef.current(); // 拖拽/均分/分隔条都汇经此处（防抖在实现侧）
      }
    }
    root ??= defaultLayout(keys);
    if (!root) return;
    const { tiles, dividers } = layoutRects(root);
    paneLayoutLastRef.current = { sid: active, root, tiles, dividers };
    const main = termsRef.current.get(active);
    if (main) {
      // 主视图名牌：格子各有标题栏，主视图同样标出它看的是什么（tmux 会话或主机 shell）。
      // tmux-attached 只控制 × 的出现——不挂 tmux 时没有可单独关闭的视图。
      const cur = sessionsRef.current.find((x) => x.id === active);
      const tagText = cur?.tmux_attached ? `tmux:${cur.tmux_attached}` : (cur?.host_name ?? "");
      if (main.tagLabel.textContent !== tagText) main.tagLabel.textContent = tagText;
      main.tag.classList.toggle("tmux-attached", !!cur?.tmux_attached);
      const tagTitle = t("拖动标题栏可移动位置：落在格子中央互换，落在边缘对半分开");
      if (main.tag.title !== tagTitle) main.tag.title = tagTitle;
    }
    // 最大化分支（用户拍板：放大保留外框）：整幅只呈放大的那一格——主视图与兄弟
    // 格暂隐、分隔条撤收、布局树冻结（还原时重算）。zoom 残记（格被关/掉线重建后
    // 不在清单）就地清掉自然还原。还原钮就在格子/主视图标题栏上。
    const zoom = paneZoomRef.current;
    const zoomMain = !!zoom && zoom.sid === active && zoom.name === MAIN_KEY;
    const zoomEntry = zoom && zoom.sid === active && zoom.name !== MAIN_KEY
      ? (byKey.get(zoom.name) ?? null)
      : null;
    if (zoom && zoom.sid === active && !zoomMain && !byKey.has(zoom.name)) paneZoomRef.current = null;
    if (zoomMain) {
      if (main) {
        main.el.style.display = "";
        place(main.el, { left: 0, top: 0, width: 1, height: 1 });
      }
      for (const e of paneTermsRef.current.values()) e.cell.style.display = "none";
      syncPaneDividers([]);
      tileDragApiRef.current.sweep();
      paneLayoutLastRef.current = null;
      syncAllZoomBtns();
      return;
    }
    if (zoomEntry) {
      if (main) { place(main.el, null); main.el.style.display = "none"; }
      for (const e of paneTermsRef.current.values()) if (e !== zoomEntry) e.cell.style.display = "none";
      zoomEntry.cell.style.display = "flex";
      place(zoomEntry.cell, { left: 0, top: 0, width: 1, height: 1 });
      syncPaneDividers([]);
      tileDragApiRef.current.sweep();
      paneLayoutLastRef.current = null;
      syncAllZoomBtns();
      return;
    }
    if (main) main.el.style.display = "";
    for (const tl of tiles) {
      if (tl.key === MAIN_KEY) { if (main) place(main.el, tl); continue; }
      const e = byKey.get(tl.key);
      if (e) { e.cell.style.display = "flex"; place(e.cell, tl); }
    }
    syncPaneDividers(dividers);
    tileDragApiRef.current.sweep();
    syncAllZoomBtns();
    // 焦点交接：握焦点的格子被摘后同名格在本标签重建（掉线原位换装）→ 焦点给新格。
    // 只在焦点仍停在兜底的主终端时交接（用户已点去别处就不抢）；5s 内有效
    const ho = paneFocusHandoffRef.current;
    if (ho && (Date.now() - ho.at > 5000 || ho.sid !== active)) paneFocusHandoffRef.current = null;
    else if (ho) {
      const succ = byKey.get(ho.name);
      if (succ) {
        paneFocusHandoffRef.current = null;
        if (!document.activeElement || document.activeElement === document.body || main?.el.contains(document.activeElement)) succ.term.focus();
      }
    }
  }, [syncPaneDividers, groupOf]);
  // 最大化钮的 click 监听在建格时挂一次，重排实现随渲染更新（ref 间接层）
  paneRelayoutRef.current = layoutTmuxPanes;

  // 终端区域（含内容下方空白）点击即聚焦当前会话终端。
  // 搜索框/显示设置必须排除：两个浮层都挂在本容器里，点它们会冒泡到这里把焦点
  // 抢回终端——搜索词落进生产 shell（UX 走查实锤）、设置面板键盘连续操作失效。
  useEffect(() => {
    const wrap = termRef.current?.parentElement;
    if (!wrap) return;
    const onFocus = (ev: MouseEvent) => {
      const t = ev.target as HTMLElement | null;
      // tmux 面板格子自管焦点（xterm mousedown 聚焦本格）——不得被抢回主终端；面板分隔条
      // 同理（拖完/双击均分后的 click 冒泡到这里会把焦点从格子抢到主终端，接着打的字进错地方）
      if (t?.closest?.(".term-search, .term-settings, .dead-overlay, .tmux-cell, .tmux-div")) return;
      xtermRef.current?.focus();
    };
    wrap.addEventListener("click", onFocus);
    return () => wrap.removeEventListener("click", onFocus);
  }, []);


    // 窗口级 Ctrl+字符 接管（捕获阶段）：中文输入法在 WKWebView 的 textarea 里
    // 会吞掉 Ctrl+字母（进入拼音组合，keydown 以 229 告终），xterm 收不到控制键——
    // top/vim 因此停不下来。这里在捕获阶段自行编码控制字符直发后端，绕过 IME。
    // 真实输入控件（搜索框/表单）不劫持（保留其编辑语义）；方向键/F 键等长键值交给 xterm。
    useEffect(() => {
      const onKey = (ev: KeyboardEvent) => {
        // §7.4/native 同口径：只在「终端确实拥有焦点且无模态层」时转发控制字符。
        // 模态期（确认/指纹/双因素）一律放行——⌘W 开确认后焦点仍留终端，
        // Ctrl+C 不得再杀远端前台进程（rev-r13 中-1）；焦点在别处（按钮/输入框）
        // 也不转发，与 native 侧 note_terminal 门一致。
        if (modalRef.current) return;
        const ael = document.activeElement;
        if (!(ael && ael.classList.contains("xterm-helper-textarea"))) return;
        // tmux 面板格子焦点：控制字符/Meta 序列改投该格通道——主会话 send_keys 绝不
        // 代收（否则 Ctrl+C 打进主视图的前台进程）；格子掉线时吞掉不发
        const paneCell = (ael as HTMLElement).closest?.(".tmux-cell") as HTMLElement | null;
        const paneHit = paneCell ? (paneTermsRef.current.get(`${paneCell.dataset.sid}:${paneCell.dataset.paneId}`) ?? null) : null;
        const toPane = (keys: string) => {
          if (paneHit?.alive) void invoke("tmux_pane_input", { sid: paneHit.sid, paneId: paneHit.paneId, keys }).catch(() => {});
          else if (paneHit) warnDeadPane(paneHit);
        };
        // Option/Alt → Meta 序列（ESC 前缀）：readline 词跳转（⌥←/⌥→/⌥⌫）、
        // tmux M-键绑定。必须在捕获层拦截：⌥字母 在 WKWebView 会进文本输入系统
        // 变特殊字符（⌥b=∫），xterm 的 keydown 收不到。⌘/Ctrl+⌥ 归各自分支。
        if (ev.altKey && !ev.ctrlKey && !ev.metaKey) {
          const seq = altMetaSequence(ev.code, ev.shiftKey);
          if (!seq) return;
          ev.preventDefault();
          ev.stopPropagation();
          armTmuxPrefix(null); // Meta 序列本身就是前缀后的命令键（如 C-b M-1 排版）
          if (paneHit) { toPane(seq); return; }
          const s0 = sidRef.current;
          if (!s0 || (() => { const st = sessionsRef.current.find((x) => x.id === s0)?.state; return !st || inputBlockedState(st); })()) return;
          void invoke("send_keys", { sid: s0, keys: seq }).catch(() => {});
          broadcastSendRef.current(s0, seq);
          return;
        }
        if (ev.metaKey || ev.altKey) return;
        if (!ev.ctrlKey && !(ev.key === "Insert" && ev.shiftKey)) return;
        // Windows/Linux 键盘剪贴板：终端聚焦时 Ctrl+C/V 会先被本层编码成 \x03/\x16，
        // 键盘复制粘贴实际不可用。按 Windows Terminal 惯例接管：Ctrl+C 有选区复制、
        // 无选区仍是 SIGINT；Ctrl+V / Ctrl+Shift+V / Shift+Insert 走人类粘贴同一入口。
        if (!isMacPlatform() && !ev.metaKey && !ev.altKey) {
          const key = ev.key.toLowerCase();
          const focusedTerm = paneHit?.term ?? termsRef.current.get(sidRef.current ?? "")?.term;
          const paneKey = paneHit ? `${paneHit.sid}:${paneHit.paneId}` : undefined;
          const copy = () => {
            const sel = focusedTerm?.getSelection() ?? "";
            if (sel) {
              Promise.resolve(inTauri ? clipboard.writeText(sel) : navigator.clipboard?.writeText(sel)).catch(() => {});
              return true;
            }
            return false;
          };
          const paste = () => {
            const sid = paneHit?.sid ?? sidRef.current;
            if (!focusedTerm || !sid) return;
            Promise.resolve(inTauri ? clipboard.readText() : navigator.clipboard?.readText())
              .then((txt) => { if (txt) pasteTextIntoRef.current(focusedTerm, sid, txt, paneKey); })
              .catch(() => {});
          };
          const shiftInsert = ev.key === "Insert" && ev.shiftKey;
          if (shiftInsert || (ev.ctrlKey && key === "v")) {
            ev.preventDefault();
            ev.stopImmediatePropagation();
            paste();
            return;
          }
          const explicitCopy = ev.ctrlKey && ev.shiftKey && key === "c";
          if (explicitCopy || (ev.ctrlKey && !ev.shiftKey && key === "c")) {
            if (copy() || explicitCopy) {
              ev.preventDefault();
              ev.stopImmediatePropagation();
              return;
            }
            // Ctrl+C 无选区：继续走下面的 C0 编码（SIGINT）
          }
        }
        // Ctrl+1…9 是固定切标签键（actions.ts tab-switch）。数字不在可重绑键位表里，
        // 直发层不能把 Ctrl+2…8 编成 NUL/ESC/FS…/DEL 抢先吞掉；stopPropagation
        // （不 immediate）挡住 xterm 目标，同节点后注册的 action 层仍能切标签。
        if (!isMacPlatform() && !ev.shiftKey && !ev.altKey && /^[1-9]$/.test(ev.key)) {
          ev.preventDefault();
          ev.stopPropagation();
          return;
        }
        // 键位表豁免（键位配置轮）：组合被 ui.keymap.v1 占用即豁免——不再编码 C0
        // 直发 PTY，动作层（同节点后注册的监听器，stopPropagation 挡不住=正是目的）
        // 接手。bindingOf 以平台主修饰键判定：mac 真按 Ctrl 不豁免（⌘ 系才归应用），
        // Win/Linux Ctrl 命中即豁免；shift/alt 逐位精确比对，未绑定的 Ctrl+Shift+字
        // 母仍进 shell。ev.key 为主、ev.code 兜底（注入器/RDP 的 keydown 可能缺
        // scan code——直键三键轮实证过 code 空串打穿纯 code 匹配）。demo 不豁免：
        // Ctrl+D 保留 shell EOF，Ctrl+T/W 是浏览器保留键本就到不了这里。
        // 终端保留键（Win/Linux Ctrl+B = tmux 前缀）永不豁免，直达主视图/格子。
        // DEV 下 spec 可置 window.__t_keymapExempt=true 走同一豁免分支（release 剔除）——
        // 否则这条 Tauri-only 路径在 demo 里永远测不到（UI 套件全绿≠真机可键入）。
        if (inTauri || (import.meta.env.DEV && (window as unknown as { __t_keymapExempt?: boolean }).__t_keymapExempt === true)) {
          const evb = bindingOf(ev, isMacPlatform());
          if (evb && exemptFromTerminal(keymapRef.current, evb, isMacPlatform())) {
            ev.preventDefault();
            ev.stopPropagation();
            return;
          }
        }
        if (paneHit) {
          let pk: string | null = null;
          if (ev.key.length === 1) pk = ev.key;
          else if (ev.code?.startsWith("Key")) pk = ev.code.slice(3).toLowerCase();
          else if (ev.code === "BracketLeft") pk = "[";
          else if (ev.code === "BracketRight") pk = "]";
          else if (ev.code === "Backslash") pk = "\\";
          else if (ev.code === "Space") pk = " ";
          const pcc = pk ? ctrlCharOf(pk) : null;
          if (pcc === null) return;
          ev.preventDefault();
          ev.stopImmediatePropagation();
          toPane(pcc);
          // 格子恒是 tmux 客户端：C-b 即前缀，武装下一键的输入法标点还原
          armTmuxPrefix(pcc === "\x02" && paneHit.alive ? `${paneHit.sid}:${paneHit.paneId}` : null);
          return;
        }
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
        // stopImmediatePropagation：键已被终端消费（C0 直发 PTY），同节点的 action
        // 分发器不得再解析同一事件——stopPropagation 挡不住同节点监听，W4 以来
        // Windows 原生下 Ctrl+W/K/B/F 曾「进 shell 同时触发应用动作」双路径
        // （Ctrl+W = werase 还关标签、Ctrl+K = kill-line 还开命令面板）。
        // 死会话分支不在此列：吞的是直发，action 照常解析（Ctrl+W 关死标签是正道）。
        ev.stopImmediatePropagation();
        void invoke("send_keys", { sid: s, keys: cc }).catch(() => {});
        broadcastSendRef.current(s, cc);
        // 主视图只在确知 attach 了 tmux 时武装（手动敲的 tmux 无从得知，宁缺不错：
        // 非 tmux 下 C-b 是 readline 光标左移，紧随其后打的中文标点是真文本）
        armTmuxPrefix(cc === "\x02" && sessionsRef.current.find((x) => x.id === s)?.tmux_attached ? s : null);
      };
      window.addEventListener("keydown", onKey, { capture: true });
      return () => window.removeEventListener("keydown", onKey, { capture: true });
    }, []);

  // 终端聚焦状态上报 native 层：native Ctrl 键接管只在 xterm 聚焦时生效，
  // 搜索框等输入控件不受影响。tmux 面板焦点在格子 xterm 时连同 pane_id 上报——
  // native Ctrl 接管（mac IME 绕行）据此改投格子通道，不把 Ctrl+C 打进主视图。
  // 关闭模态后的补报也走这里（按实际 DOM 焦点推导），避免漏 pane_id。
  const noteTerminalFocus = useCallback((focused: boolean, el?: Element | null) => {
    const { sid, paneId } = terminalFocusTarget(el ?? document.activeElement, sidRef.current);
    void invoke("note_terminal", { sid, focused, paneId }).catch(() => {});
  }, []);
  useEffect(() => {
    const report = noteTerminalFocus;
    const onFocusIn = (e: FocusEvent) => {
      const t = e.target as HTMLElement | null;
      if (!t?.classList?.contains("xterm-helper-textarea")) return;
      // 记住焦点所在的子窗口：主视图 = "main"，tmux 格子 = `${sid}:${paneId}`。
      // 切标签时 focusSession 按此恢复，用户不会每次都被送回主视图。
      const cell = t.closest(".tmux-cell") as HTMLElement | null;
      if (cell?.dataset.sid && cell.dataset.paneId) {
        paneLastFocusRef.current.set(cell.dataset.sid, `${cell.dataset.sid}:${cell.dataset.paneId}`);
      } else {
        const sess = t.closest(".term-session") as HTMLElement | null;
        if (sess?.dataset.sid) paneLastFocusRef.current.set(sess.dataset.sid, "main");
      }
      report(true, t);
    };
    const onFocusOut = (e: FocusEvent) => {
      const t = e.target as HTMLElement | null;
      if (t?.classList?.contains("xterm-helper-textarea")) report(false, t);
    };
    // §7.4：WebView 整窗失焦/回焦对称同步——焦点不出 document 时 focusout 不触发，
    // native 层会以失焦状态继续拦截 ⌃字母；⌘Tab 切回时 focusin 同样不触发，
    // 需按当前 DOM 焦点补报（rev-r13 低-4）
    const xtermFocused = () => {
      const t = document.activeElement;
      return !!(t instanceof HTMLElement && t.classList.contains("xterm-helper-textarea"));
    };
    const onWinBlur = () => report(false, document.activeElement);
    const onWinFocus = () => { if (xtermFocused()) report(true, document.activeElement); };
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
  }, [noteTerminalFocus]);

  // 终端尺寸自适应 + PTY 对齐（backend resize）。按「可见 pane」逐个校准：
  // 单 pane = 活动会话全幅；分屏 = 左右各按自身元素盒子（半幅）计算——
  // 每个 pane 的 xterm 尺寸与其 PTY 一一对应。
  // 量取终端目标几何。xterm 5.5 无公开 dimensions 属性（fork API，恒 undefined →
  // fit 静默失效、xterm 恒停在构造默认 80×24，13px 时恰好与正确值重合而长期未暴露）——
  // cell 尺寸改经 _core 私有路径取（与官方 addon-fit 实现同源）。渲染器首帧未就绪返回
  // null，由调用方决定重试。padEl：被量盒子的内边距来源（.term-session 有留白 padding；
  // ensureSessionTerm 量的是 #term，须改传会话层元素扣掉同一组 padding）
  const fitDimsOf = useCallback((term: Terminal, el: HTMLElement, padEl?: HTMLElement): { cols: number; rows: number } | null => {
    const core = (term as unknown as { _core?: { _renderService?: { dimensions?: { css?: { cell?: { width?: number; height?: number } } } } } })._core;
    const dims = core?._renderService?.dimensions;
    const cw = dims?.css?.cell?.width;
    const ch = dims?.css?.cell?.height;
    if (!cw || !ch) return null;
    // clientWidth 含 padding：不扣会把 PTY 算宽 2×padding，attach 后二次校准引重排
    const ps = getComputedStyle(padEl ?? el);
    const padX = (parseFloat(ps.paddingLeft) || 0) + (parseFloat(ps.paddingRight) || 0);
    const padY = (parseFloat(ps.paddingTop) || 0) + (parseFloat(ps.paddingBottom) || 0);
    return {
      cols: Math.max(20, Math.min(400, Math.floor((el.clientWidth - padX) / cw))),
      rows: Math.max(6, Math.min(200, Math.floor((el.clientHeight - padY) / ch))),
    };
  }, []);
  const fitOne = useCallback(async (target: string) => {
    const entry = termsRef.current.get(target);
    if (!entry) return;
    const { term, el } = entry;
    // 隐藏中的会话（display:none）clientWidth 为 0：不按 0 尺寸校准
    if (el.clientWidth < 60 || el.clientHeight < 60) return;
    const dims = fitDimsOf(term, el);
    if (!dims) {
      // 渲染器首帧未就绪：9px 兜底会把列数算错（PTY 宽度随之错位，
      // docker ps 等按宽度排版的输出会折行错乱）——等一帧重测，最多 5 次
      const t = term as unknown as { __fitRetries?: number };
      t.__fitRetries = (t.__fitRetries ?? 0) + 1;
      if (t.__fitRetries <= 5) setTimeout(() => void fitOne(target), 120);
      return;
    }
    if (term.cols !== dims.cols || term.rows !== dims.rows) {
      term.resize(dims.cols, dims.rows);
      invoke("resize", { sid: target, cols: dims.cols, rows: dims.rows }).catch(() => {});
    }
  }, [fitDimsOf]);
  // tmux 面板格子：按格子正文盒子量（标题栏不占行），尺寸变化经 window_change 下发
  // （tmux client 按新尺寸重绘）。隐藏格子不量；渲染器未就绪重试同 fitOne。
  const fitPane = useCallback((e: PaneTermEntry) => {
    if (e.cell.style.display === "none" || e.body.clientWidth < 40 || e.body.clientHeight < 30) return;
    const dims = fitDimsOf(e.term, e.body);
    if (!dims) {
      const r = e.term as unknown as { __fitRetries?: number };
      r.__fitRetries = (r.__fitRetries ?? 0) + 1;
      if (r.__fitRetries <= 5) setTimeout(() => fitPane(e), 120);
      return;
    }
    if (e.term.cols !== dims.cols || e.term.rows !== dims.rows) {
      e.term.resize(dims.cols, dims.rows);
      if (e.alive) invoke("tmux_pane_resize", { sid: e.sid, paneId: e.paneId, cols: dims.cols, rows: dims.rows }).catch(() => {});
    }
  }, [fitDimsOf]);
  const fitTerminal = useCallback(() => {
    const sp = groupOf(sidRef.current);
    const targets = sp ? [sp.main, sp.second] : sidRef.current ? [sidRef.current] : [];
    for (const t of targets) void fitOne(t);
    for (const e of paneTermsRef.current.values()) fitPane(e);
  }, [fitOne, fitPane, groupOf]);
  // 缩放/最大化等命令式入口经 ref 取最新 fit（必须在 fitTerminal 声明之后赋值）
  paneFitRef.current = fitTerminal;
  useEffect(() => {
    const el = termRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const ro = new ResizeObserver(() => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => { checkSplitWidthRef.current(); fitTerminal(); }, 150);
    });
    ro.observe(el);
    return () => { if (timer) clearTimeout(timer); ro.disconnect(); };
  }, [fitTerminal]);
  // 分屏建立/退出/换副窗格时也重估宽度退化态
  useEffect(() => { checkSplitWidthRef.current(); }, [splitPanes]);

  // ---- 拖拽布局：分隔条调大小 / 标题栏换位（控制器经 ref 给命令式元素调用）----
  // 分隔条：按下记下容器像素盒与两侧最小占比（嵌套格按当前占比反推最小像素，见
  // minExtent），拖动即改两侧权重并重排，每 150ms 校准一次 PTY 几何、松手再校准终态
  // （分屏分割条同节奏）。
  const paneDivDragRef = useRef<{
    sid: string; path: number[]; index: number; dir: "row" | "col"; pointerId: number;
    origin: number; size: number; minA: number; minB: number; lastFit: number; el: HTMLDivElement;
    /** 按下点相对边界的偏移（像素）：按相对位移拖，单击 1px 抖动不让边界跳到指针处 */
    grab: number;
    /** 按下时的树形签名：拖动中开/关格改了树形 → path/index 可能指向别的边界，即刻收尾 */
    shape: string;
  } | null>(null);
  const layoutShape = (l: { tiles: PaneTile[]; dividers: PaneDivider[] }) =>
    `${l.tiles.map((x) => x.key).join("|")}#${l.dividers.map((d) => `${d.path.join(".")}/${d.index}`).join(",")}`;
  const endPaneDivDrag = () => {
    const dg = paneDivDragRef.current;
    if (!dg) return;
    paneDivDragRef.current = null;
    dg.el.classList.remove("dragging");
    try { if (dg.el.hasPointerCapture(dg.pointerId)) dg.el.releasePointerCapture(dg.pointerId); } catch { /* 已释放 */ }
    document.body.classList.remove("tile-resizing", "tile-resize-x", "tile-resize-y");
    fitTerminal();
  };
  paneDivApiRef.current = {
    down: (ev, el) => {
      if (ev.button !== 0 || paneDivDragRef.current) return;
      const last = paneLayoutLastRef.current;
      const mount = termRef.current;
      if (!last || !mount || last.sid !== sidRef.current) return;
      const path = el.dataset.path ? el.dataset.path.split(".").map(Number) : [];
      const index = Number(el.dataset.index);
      const d = last.dividers.find((x) => x.index === index && x.path.join(".") === path.join("."));
      const node = nodeAt(last.root, path);
      if (!d || !node?.kids) return;
      ev.preventDefault();
      const r = mount.getBoundingClientRect();
      const horiz = d.dir === "row";
      const size = horiz ? d.box.width * r.width : d.box.height * r.height;
      if (size <= 0) return;
      const axis = horiz ? "x" : "y";
      const origin = horiz ? r.left + d.box.left * r.width : r.top + d.box.top * r.height;
      const tw = node.kids.reduce((s, k) => s + k.w, 0) || 1;
      const cur = node.kids.slice(0, index + 1).reduce((s, k) => s + k.w, 0) / tw;
      el.setPointerCapture(ev.pointerId);
      paneDivDragRef.current = {
        sid: last.sid, path, index, dir: d.dir, pointerId: ev.pointerId,
        origin, size,
        minA: minExtent(node.kids[index], axis, PANE_MIN_W, PANE_MIN_H) / size,
        minB: minExtent(node.kids[index + 1], axis, PANE_MIN_W, PANE_MIN_H) / size,
        lastFit: 0, el,
        grab: (horiz ? ev.clientX : ev.clientY) - (origin + cur * size),
        shape: layoutShape(last),
      };
      el.classList.add("dragging");
      document.body.classList.add("tile-resizing", horiz ? "tile-resize-x" : "tile-resize-y");
    },
    move: (ev) => {
      const dg = paneDivDragRef.current;
      if (!dg || ev.pointerId !== dg.pointerId) return;
      // 抬起漏收（捕获已丢）/条已被删：不再按陈旧 origin/size 改布局
      if (!dg.el.isConnected || (ev.buttons & 1) === 0) { endPaneDivDrag(); return; }
      const base = paneLayoutLastRef.current;
      if (!base || base.sid !== dg.sid || sidRef.current !== dg.sid || layoutShape(base) !== dg.shape) { endPaneDivDrag(); return; }
      const pt = (dg.dir === "row" ? ev.clientX : ev.clientY) - dg.grab;
      const next = resizeAt(base.root, dg.path, dg.index, (pt - dg.origin) / dg.size, dg.minA, dg.minB);
      if (next !== base.root) {
        paneLayoutRef.current.set(dg.sid, next);
        layoutTmuxPanes();
      }
      const now = performance.now();
      if (now - dg.lastFit > 150) { dg.lastFit = now; fitTerminal(); }
    },
    end: (pointerId) => {
      const dg = paneDivDragRef.current;
      if (!dg || (pointerId !== undefined && pointerId !== dg.pointerId)) return;
      endPaneDivDrag();
    },
    equalize: (el) => {
      const last = paneLayoutLastRef.current;
      if (!last || last.sid !== sidRef.current) return;
      const next = equalizeAt(last.root, el.dataset.path ? el.dataset.path.split(".").map(Number) : []);
      if (JSON.stringify(next) === JSON.stringify(last.root)) return; // 已均分：不把自动平铺翻成自定义
      paneLayoutRef.current.set(last.sid, next);
      layoutTmuxPanes();
      fitTerminal();
    },
  };

  // 标题栏拖动：5px 阈值区分点击与拖动；过阈值后被拖格半透明、落点提示框预演「落下后
  // 被拖格的真实位置」（所见即所得）；松手应用，Esc/指针丢失取消。只在面板网格里生效。
  const tileDragRef = useRef<{
    sid: string; key: string; src: HTMLElement; handle: HTMLElement; pointerId: number;
    x0: number; y0: number; active: boolean; target: { key: string; zone: DropZone } | null; hint: HTMLDivElement | null;
  } | null>(null);
  const tileDragEsc = useRef((ev: KeyboardEvent) => {
    if (ev.key !== "Escape") return;
    ev.preventDefault();
    ev.stopImmediatePropagation();
    tileDragApiRef.current.finish(false);
  }).current;
  // 窗口级兜底：把手元素被移除（格子远端结束/关标签）后捕获已丢，抬起落不到把手上——
  // 窗口捕获阶段按 pointerId 收尾（把手自己的监听若也收到，finish 已是空操作）
  const tileDragWinUp = useRef((ev: PointerEvent) => {
    tileDragApiRef.current.finish(ev.type === "pointerup", ev.pointerId);
  }).current;
  tileDragApiRef.current = {
    down: (ev, key, owner, src, handle) => {
      if (ev.button !== 0 || tileDragRef.current) return;
      if ((ev.target as Element | null)?.closest?.("button")) return;
      const last = paneLayoutLastRef.current;
      if (!last || owner !== sidRef.current || last.sid !== owner || !last.tiles.some((x) => x.key === key)) return;
      handle.setPointerCapture(ev.pointerId);
      tileDragRef.current = {
        sid: owner, key, src, handle, pointerId: ev.pointerId,
        x0: ev.clientX, y0: ev.clientY, active: false, target: null, hint: null,
      };
      window.addEventListener("pointerup", tileDragWinUp, true);
      window.addEventListener("pointercancel", tileDragWinUp, true);
    },
    move: (ev) => {
      const dg = tileDragRef.current;
      if (!dg || ev.pointerId !== dg.pointerId) return;
      // 被拖的格子/名牌已不在，或抬起漏收：取消，不留半透明/提示框/grabbing 光标
      if (!dg.src.isConnected || !dg.handle.isConnected || (ev.buttons & 1) === 0) { tileDragApiRef.current.finish(false); return; }
      if (!dg.active) {
        if (Math.abs(ev.clientX - dg.x0) + Math.abs(ev.clientY - dg.y0) < 5) return;
        dg.active = true;
        document.body.classList.add("tile-dragging");
        dg.src.classList.add("tile-drag-src");
        const hint = document.createElement("div");
        hint.className = "tile-drop-hint";
        hint.setAttribute("data-testid", "tile-drop-hint");
        hint.style.display = "none";
        const zone = document.createElement("div");
        zone.className = "tdh-zone";
        const label = document.createElement("span");
        label.className = "tdh-label";
        zone.append(label);
        hint.append(zone);
        termRef.current?.appendChild(hint);
        dg.hint = hint;
        window.addEventListener("keydown", tileDragEsc, true);
      }
      const last = paneLayoutLastRef.current;
      const mount = termRef.current;
      if (!last || !mount || last.sid !== dg.sid || sidRef.current !== dg.sid) { tileDragApiRef.current.finish(false); return; }
      const r = mount.getBoundingClientRect();
      const fx = (ev.clientX - r.left) / r.width;
      const fy = (ev.clientY - r.top) / r.height;
      const hit = last.tiles.find((x) => fx >= x.left && fx < x.left + x.width && fy >= x.top && fy < x.top + x.height);
      dg.target = hit && hit.key !== dg.key
        ? { key: hit.key, zone: dropZone((fx - hit.left) / hit.width, (fy - hit.top) / hit.height) }
        : null;
      const hint = dg.hint;
      if (!hint) return;
      const after = dg.target
        ? layoutRects(moveTile(last.root, dg.key, dg.target.key, dg.target.zone)).tiles.find((x) => x.key === dg.key)
        : null;
      if (!dg.target || !after) { hint.style.display = "none"; delete hint.dataset.zone; return; }
      hint.dataset.zone = dg.target.zone;
      hint.style.left = `${(after.left * 100).toFixed(4)}%`;
      hint.style.top = `${(after.top * 100).toFixed(4)}%`;
      hint.style.width = `${(after.width * 100).toFixed(4)}%`;
      hint.style.height = `${(after.height * 100).toFixed(4)}%`;
      const label = hint.querySelector(".tdh-label");
      if (label) label.textContent = dg.target.zone === "center" ? t("交换位置") : "";
      hint.style.display = "block";
    },
    finish: (apply, pointerId) => {
      const dg = tileDragRef.current;
      if (!dg || (pointerId !== undefined && pointerId !== dg.pointerId)) return;
      tileDragRef.current = null;
      window.removeEventListener("keydown", tileDragEsc, true);
      window.removeEventListener("pointerup", tileDragWinUp, true);
      window.removeEventListener("pointercancel", tileDragWinUp, true);
      try { if (dg.handle.hasPointerCapture(dg.pointerId)) dg.handle.releasePointerCapture(dg.pointerId); } catch { /* 已释放 */ }
      dg.hint?.remove();
      dg.src.classList.remove("tile-drag-src");
      document.body.classList.remove("tile-dragging");
      if (!apply || !dg.active || !dg.target) return;
      const last = paneLayoutLastRef.current;
      if (!last || last.sid !== dg.sid) return;
      const next = moveTile(last.root, dg.key, dg.target.key, dg.target.zone);
      if (next === last.root) return;
      paneLayoutRef.current.set(dg.sid, next);
      layoutTmuxPanes();
      fitTerminal();
      setTimeout(() => fitTerminal(), 150);
    },
    sweep: () => {
      const dg = tileDragRef.current;
      if (!dg) return;
      const last = paneLayoutLastRef.current;
      if (!dg.src.isConnected || !dg.handle.isConnected || !last || last.sid !== dg.sid || !last.tiles.some((x) => x.key === dg.key)) {
        tileDragApiRef.current.finish(false);
      }
    },
  };
  // 右键「重置面板布局」：弃掉该标签的布局树，回到自动平铺（分屏期间格子都藏着，不出此项）
  const paneLayoutCustom = (s: string) => !groupOf(s) && paneLayoutRef.current.has(s);
  const resetPaneLayout = (s: string) => {
    if (!paneLayoutRef.current.delete(s)) return;
    layoutTmuxPanes();
    fitTerminal();
    setTimeout(() => fitTerminal(), 150);
  };

  // tmux 面板对账：会话快照（3s 轮询 + 开关格后的即时刷新 + 格子流终结即刷）是格子的
  // 唯一事实源。快照有、本地无 → 建格订阅；本地有、快照无 → 收格（快照请求早于格子
  // 出生则缺席不作数——乐观开格；刚关的格子 5s 内不因旧快照重建）；alive 变化 → 遮罩
  // 开合。同名新 pane_id = 重连原位换装。
  const mainTagSigRef = useRef<string | null>(null);
  useEffect(() => {
    const want = new Map<string, { sid: string; paneId: number; name: string; alive: boolean }>();
    for (const s of sessions) {
      // 连接一掉（300ms 状态事件即到）立即蒙灰：格子通道随连接同死，不等 3s 清单
      // 轮询带回 alive=false（Degraded/重连中的格子此前会亮着收不到字）
      const connOk = s.state === "Connected" || s.state === "Reconfirming";
      for (const p of s.panes ?? []) want.set(`${s.id}:${p.pane_id}`, { sid: s.id, paneId: p.pane_id, name: p.tmux_session, alive: p.alive && connOk });
    }
    const now = Date.now();
    for (const [k, at] of paneClosedRef.current) if (now - at > 5000) paneClosedRef.current.delete(k);
    // 主视图名牌即时换装：layout 只在格子开合/改名/拖拽时跑，attach/改名跟随不经过它——
    // 按签名比对直接重写名牌文本（attach 记录或主机名变了才写，3s 轮询空转零动作）
    const curActive = sessions.find((x) => x.id === sidRef.current);
    const tagSig = curActive ? `${curActive.tmux_attached ?? ""}|${curActive.host_name}` : null;
    if (tagSig !== mainTagSigRef.current) {
      mainTagSigRef.current = tagSig;
      const main = sidRef.current ? termsRef.current.get(sidRef.current) : null;
      if (main && curActive) {
        // 与 applyPanes 同一口径：非 Connected 态带状态后缀（简化版曾只写裸主机名，
        // 会把分屏焦点格刚刷上的「已断开/重连中…/已重连 · 待核实」覆盖掉）
        const stTail = curActive.state === "Connected" ? "" : ` · ${stateLabel(curActive.state).text}`;
        main.tagLabel.textContent = (curActive.tmux_attached ? `tmux:${curActive.tmux_attached}` : curActive.host_name) + stTail;
        main.tag.classList.toggle("tmux-attached", !!curActive.tmux_attached);
      }
    }
    let changed = false;
    for (const [k, e] of [...paneTermsRef.current.entries()]) {
      const w = want.get(k);
      if (!w) {
        if (panesSnapAtRef.current <= e.bornAt && sessions.some((x) => x.id === e.sid)) continue;
        // 远端结束（格内 exit / C-b d / 会话被 kill / 重连后已不存在）：格子消失要给个
        // 交代。会话仍在且快照里没有同名新格（排除重建换装与关标签）才提示，附 tmux 的
        // 收尾提示行；用户点 × 关格不走这里（closeTmuxPane 已先行收格并自带提示）
        const sess = sessions.find((x) => x.id === e.sid);
        if (sess && !(sess.panes ?? []).some((p) => p.tmux_session === e.name)) {
          const notice = lastTmuxNotice(e.term);
          pushToast("info", notice
            ? t("窗格已结束：{0} — {1}", e.name, notice)
            : t("窗格已结束：{0}（远端会话已退出、分离或不存在）", e.name));
        }
        disposePane(k);
        changed = true;
        continue;
      }
      if (e.name !== w.name) {
        // 改名跟随：核心按不可变 tmux session_id 对账后快照带回新名——格子标题/
        // 数据集/拖拽键全换，布局树叶子原位换键（重命名不掉位置）；主视图名牌随
        // 下方 layoutTmuxPanes 重写。键是名字（重建换装靠同名活口），id 在核心侧认。
        const old = e.name;
        e.name = w.name;
        e.cell.dataset.tmux = w.name;
        const lbl = e.cell.querySelector<HTMLElement>(".tmux-cell-name");
        if (lbl) lbl.textContent = w.name;
        const tree = paneLayoutRef.current.get(e.sid);
        if (tree && treeHasKey(tree, w.name)) {
          // 树里已有新名的 stale 叶（同快照「B 格结束 + A 改名成 B」常落一起）：
          // 先摘掉再换键——重复键 syncLayout 永不去重（两键都在 want），随开格繁殖
          const pruned = removeTile(tree, w.name);
          if (pruned) paneLayoutRef.current.set(e.sid, pruned);
          else paneLayoutRef.current.delete(e.sid); // 摘空=树作废回自动平铺（语义正确）
        }
        renameTileKey(paneLayoutRef.current.get(e.sid), old, w.name);
        changed = true;
      }
      if (e.alive !== w.alive) {
        e.alive = w.alive;
        if (w.alive) e.deadWarned = false;
        e.cell.classList.toggle("dead", !w.alive);
        changed = true;
      }
    }
    for (const [k, w] of want) {
      if (paneTermsRef.current.has(k) || paneClosedRef.current.has(k)) continue;
      changed = true;
      void ensurePaneTerm(w.sid, w.paneId, w.name).then(() => {
        const e = paneTermsRef.current.get(k);
        if (e && !w.alive) { e.alive = false; e.cell.classList.add("dead"); }
        layoutTmuxPanes();
        fitTerminal();
      });
    }
    if (changed) { layoutTmuxPanes(); fitTerminal(); }
  }, [sessions, ensurePaneTerm, disposePane, layoutTmuxPanes, fitTerminal, pushToast]);

  // 运行时切语言：格子标题栏是命令式 DOM（React 不重渲染），已建格子的文案在此重写
  useEffect(() => {
    for (const e of termsRef.current.values()) {
      const title = t("关闭此 tmux 视图（回到 shell，tmux 会话继续运行）");
      if (e.detachBtn.title !== title) {
        e.detachBtn.title = title;
        e.detachBtn.setAttribute("aria-label", title);
      }
    }
    for (const e of paneTermsRef.current.values()) {
      const st = e.cell.querySelector(".tmux-cell-state");
      if (st) st.textContent = t("已断开 · 重连后自动恢复");
      const cb = e.cell.querySelector<HTMLButtonElement>(".tmux-cell-close");
      if (cb) {
        cb.title = t("关闭窗格（只断开此视图，tmux 会话继续运行）");
        cb.setAttribute("aria-label", cb.title);
      }
      const hd = e.cell.querySelector<HTMLElement>(".tmux-cell-head");
      if (hd) hd.title = t("拖动标题栏可移动位置：落在格子中央互换，落在边缘对半分开");
    }
    layoutTmuxPanes(); // 分隔条与主视图名牌的提示文案随排版重写
    // 分屏窗格按钮（最大化/交换/退出）的 title/aria 也是命令式 DOM，随语言重写
    applyPanesRef.current();
  }, [locale, layoutTmuxPanes]);

  // —— 显示设置（路线图⑥）：字号/主题，vault 持久化（跨进程记忆）——
  // 状态供 UI 渲染；ref 供 makeTerm 闭包与快捷键读取（避开 stale closure）
  const [fontSize, setFontSize] = useState(FONT_DEFAULT);
  const [showSettings, setShowSettings] = useState(false);
  // 面板卸载即 Token 随本地态消失：守卫复位，下次打开不继承「已提示过一次」。
  useEffect(() => {
    if (!showSettings) {
      settingsTokenPendingRef.current = false;
      settingsTokenGuardRef.current = false;
    }
  }, [showSettings]);
  // T34：原生菜单「设置…⌘,」→ 打开显示设置面板；应用版本号（关于面板同源）
  const [appVersion, setAppVersion] = useState<string | null>(null);
  // 版本号轮：编译时间（build.rs 注入的编译期常量；演示域 demo 镜像回 null，
  // 关于卡略去「编译于」段）
  const [buildTime, setBuildTime] = useState<string | null>(null);
  // 发布轮：应用内版本检查（启动静默查一次 GitHub Release；有新版才 toast，
  // 关于卡常驻更新行）。任何失败折算 hasUpdate=false，静默不扰。
  const [updateInfo, setUpdateInfo] = useState<UpdateCheck | null>(null);
  // updater 轮：自动更新能力面（demo 域恒 null → 关于卡不出现按钮；?autoupdater
  // 场景例外）与安装 busy
  const [updaterCap, setUpdaterCap] = useState<UpdaterInfo | null>(null);
  const [updaterBusy, setUpdaterBusy] = useState(false);
  const autoUpdate = useCallback(() => {
    if (updaterBusy) return;
    setUpdaterBusy(true);
    // mac：安装完成 app.restart()，不返回；win：换身后受控重启，命令返回 Ok(true)；
    // Ok(false)=已是最新
    invoke("updater_install")
      .then((changed) => {
        setUpdaterBusy(false);
        if (!changed) pushToast("info", t("已是最新版本"));
      })
      .catch((e) => {
        setUpdaterBusy(false);
        pushToast("err", t("自动更新失败：{0}", friendlyError(e)));
      });
  }, [updaterBusy, pushToast]);
  // 本轮：手动检测更新——启动自动检测（上方 effect）之外随时可查；结果如实三态
  //（新版本 toast/已是最新带版本号/检测失败原因），结果写回 updateInfo 让更新行即时出现
  const [checkBusy, setCheckBusy] = useState(false);
  const checkUpdateNow = useCallback(() => {
    if (checkBusy) return;
    setCheckBusy(true);
    invoke("check_update")
      .then((u: UpdateCheck) => {
        // 检测失败不写回：启动检测已建立的更新行不因一次网络抖动被抹掉；
        // 成功路径（含干净无更新）照常写回，更新行即时出现/消失
        if (!u.error) setUpdateInfo(u);
        if (u.hasUpdate && u.latest) {
          pushToast("info", t("新版本 v{0} 已发布", u.latest), {
            label: t("打开发布页"), title: u.url ?? "",
            run: () => { if (u.url) invoke("open_url", { url: u.url }).catch(() => {}); },
          });
        } else if (u.error) {
          pushToast("err", u.error);
        } else {
          pushToast("ok", t("已是最新（v{0}）", u.current));
        }
      })
      .catch((e) => pushToast("err", friendlyError(e)))
      .finally(() => setCheckBusy(false));
  }, [checkBusy, pushToast]);
  // 发布轮：诊断包导出——固定落 <数据目录>/diagnostics/（无对话框），toast 带「打开所在文件夹」
  const [diagBusy, setDiagBusy] = useState(false);
  const exportDiagnostics = useCallback(() => {
    if (diagBusy) return;
    setDiagBusy(true);
    invoke("export_diagnostics")
      .then((p) => pushToast("ok", t("诊断包已导出（不含凭据与主机信息）"), {
        label: t("打开所在文件夹"), title: p,
        run: () => { invoke("reveal_path", { path: p }).catch(() => {}); },
      }))
      .catch((e) => pushToast("err", t("诊断包导出失败：{0}", friendlyError(e))))
      .finally(() => setDiagBusy(false));
  }, [diagBusy, pushToast]);
  useEffect(() => {
    if (!inTauri) return;
    // 走统一分发（R13 §7.2）：原生菜单加速器与键盘快捷键同一 action 语义
    const un = tauriListen(
      listen("menu-settings", () => { dispatchRef.current({ id: "settings" }); }),
    );
    // 原生「全选」⌘A：菜单已在 WebView 之前消费，按当前焦点分派。
    // 终端/格子 → xterm 缓冲全选；表单 → 输入框全选；其余交回 WebView。
    const unSelectAll = tauriListen(listen("menu-select-all", () => {
      const el = document.activeElement as HTMLElement | null;
      for (const e of [...termsRef.current.values(), ...paneTermsRef.current.values()]) {
        if (e.term.element?.contains(el)) { e.term.selectAll(); return; }
      }
      if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) { el.select(); return; }
      document.execCommand("selectAll");
    }));
    getVersion().then(setAppVersion).catch(() => {});
    invoke("get_build_time").then((t) => setBuildTime(t ?? null)).catch(() => {});
    return () => { un(); unSelectAll(); };
  }, []);
  // 发布轮/自更新轮：版本检查与能力面 demo 域也走镜像（桥层分流）——check_update
  // 默认恒 hasUpdate=false；?autoupdater 场景可达「有新版 + 可自动更新」整条 UI 链
  // （真实换身/重启只在 Tauri 域存在，demo 桩如实回「已是最新」）。
  useEffect(() => {
    invoke("updater_info").then(setUpdaterCap).catch(() => {});
    invoke("check_update").then((u) => {
      setUpdateInfo(u);
      if (u.hasUpdate && u.latest) {
        pushToast("info", t("新版本 v{0} 已发布", u.latest), {
          label: t("打开发布页"), title: u.url ?? "",
          run: () => { if (u.url) invoke("open_url", { url: u.url }).catch(() => {}); },
        });
      }
    }).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const fontRef = useRef(FONT_DEFAULT);
  // —— P0 终端品质轮：外观五项 + 连字（vault settings KV，demo 退 localStorage，与字号同工艺）——
  // 状态供设置面板回显；ref 供 makeTerm 闭包与即时应用函数读取（避开 stale closure）
  const [termFont, setTermFont] = useState(TERM_FONT_DEFAULT);
  const termFontFamilyRef = useRef(termFontCss(TERM_FONT_DEFAULT));
  const [termLiga, setTermLiga] = useState(false);
  const termLigaRef = useRef(false);
  const [termCursorStyle, setTermCursorStyle] = useState<TermCursorStyle>("block");
  const termCursorStyleRef = useRef<TermCursorStyle>("block");
  const [termCursorBlink, setTermCursorBlink] = useState(true);
  const termCursorBlinkRef = useRef(true);
  const [termScrollback, setTermScrollback] = useState(TERM_SCROLLBACK_DEFAULT);
  const termScrollbackRef = useRef(TERM_SCROLLBACK_DEFAULT);
  const [termLetterSpacing, setTermLetterSpacing] = useState(TERM_LETTER_SPACING_DEFAULT);
  const termLetterSpacingRef = useRef(TERM_LETTER_SPACING_DEFAULT);
  // 滚轮上报频率（KI-004）：state 供设置回显；ref 供 wheel-batch 的间隔提供者逐次
  // 读取——运行中改档无需重装补丁；「跟随刷新率」由 displayIntervalMs 实测（30–120Hz）。
  const [termWheelRate, setTermWheelRate] = useState<TermWheelRate>(TERM_WHEEL_RATE_DEFAULT);
  const termWheelRateRef = useRef<TermWheelRate>(TERM_WHEEL_RATE_DEFAULT);
  const wheelIntervalMs = useCallback(
    () => (termWheelRateRef.current === "auto" ? displayIntervalMs() : 1000 / termWheelRateRef.current),
    [],
  );
  // 二十二轮主题统一：终端配色恒由「色板×深浅」派生（无独立预设、无联动开关）。
  // derivedThemeRef 缓存最近一次派生结果，makeTerm 建实例时直接取用（早于启动
  // 派生到达时是深色基础派生值，启动尾部统一刷新一次）
  const derivedThemeRef = useRef<{ theme: Record<string, string> }>({
    theme: { ...THEMES[0].theme },
  });
  // R27：应用外观三态（跟随系统/深色/浅色）——深浅仍独立成档（§7.1/§244），
  // 事实源 = ui.v2.workspace blob 的 chrome 域（V5 迁移已为老用户写入映射值）
  const [appearance, setAppearance] = useState<Appearance>("system");
  const appearanceRef = useRef<Appearance>("system");
  // UX 五轮：整页缩放档位（事实源在 zoom.ts，这里只做设置下拉回显）
  const [zoomLevel, setZoomLevel] = useState(currentZoom);
  // 主题色板（data-theme，默认东京夜——无 CSS 块命中即继承 :root 石墨基底）
  const [palette, setPalette] = useState(PALETTE_DEFAULT);
  const paletteRef = useRef(PALETTE_DEFAULT);
  // 键位表（键位配置轮）：可重绑动作的当前表，缺省=默认表。ref 供 window 捕获层的
  // 两个监听器（注册于挂载期、闭包不换）与控制字符直发层读取；state 供设置面板回显
  const [keymap, setKeymap] = useState<Record<KeyActionId, Binding>>(() => parseKeymap(null, isMacPlatform()));
  const keymapRef = useRef(keymap);
  const applyKeymap = useCallback((km: Record<KeyActionId, Binding>) => {
    keymapRef.current = km;
    setKeymap(km);
  }, []);
  // 录入态：正在等待「按下新组合」的动作 id；录入期整体按模态层处理（其余 ⌘ 组合吞掉）
  const [keyCapture, setKeyCapture] = useState<KeyActionId | null>(null);
  const keyCaptureRef = useRef<KeyActionId | null>(null);
  keyCaptureRef.current = keyCapture;
  // C8 工作区偏好串行化链（hostbar/外观共用；声明提前供 changeAppearance 使用）
  const wsWriteChain = useRef<Promise<unknown>>(Promise.resolve());

  const applyChrome = useCallback((resolved: "dark" | "light") => {
    // CSS 变量层挂 documentElement（深浅遮罩/玻璃/阴影一起换）；Tauri 下原生窗口
    // 外观同步（Overlay 红绿灯深浅渲染）。镜像进 localStorage 供 index.html 首帧
    // 脚本在 CSS 生效前应用，杜绝浅色用户每次启动先闪一屏深色。
    document.documentElement.dataset.chrome = resolved;
    try { localStorage.setItem("ui.chrome", resolved); } catch { /* 隐私模式忽略 */ }
    if (inTauri) {
      void getCurrentWindow().setTheme(resolved === "dark" ? "dark" : "light").catch(() => {});
    }
  }, [inTauri]);

  const applyPalette = useCallback((id: string) => {
    document.documentElement.dataset.theme = id;
    try { localStorage.setItem("ui.palette", id); } catch { /* 隐私模式忽略 */ }
  }, []);

  // 主题切换脉冲（tiny-worker 同工艺）：仅切换瞬间挂 .theme-switching 开全量色彩
  // 过渡（styles.css），320ms 摘除——常驻全局 transition 会拖累一切交互
  const pulseChrome = useCallback(() => {
    const el = document.documentElement;
    el.classList.add("theme-switching");
    window.setTimeout(() => el.classList.remove("theme-switching"), 320);
  }, []);

  // 写失败必须出声：外观/键位/偏好都在这条通路，静默吞掉会让用户以为已保存，
  // 重启后才发现回到旧值。滑块逐帧写，提示按 5s 窗口去重。
  const settingWriteErrRef = useRef(false);
  const noteSettingWriteErr = useCallback((why: string) => {
    if (settingWriteErrRef.current) return;
    settingWriteErrRef.current = true;
    pushToast("err", t("设置未能保存：{0}", why));
    window.setTimeout(() => { settingWriteErrRef.current = false; }, 5000);
  }, [pushToast]);
  const persistSetting = useCallback((key: string, value: string) => {
    if (inTauri) void invoke("set_setting", { key, value }).catch((e) => noteSettingWriteErr(errMsg(e)));
    else try { localStorage.setItem(key, value); } catch { noteSettingWriteErr(t("浏览器存储不可用")); }
  }, [inTauri, noteSettingWriteErr]);

  // ---- tmux 联动偏好（恢复现场轮）：单键 JSON 双域持久化（真实域 vault KV，
  // demo 域 get/set_setting 同通路）----
  // auto = 勾了「下次断线自动恢复现场」的主机集；last = 每主机最后 attach 的
  // tmux 会话名（横幅单键直进）；declined = 点过「不用了」的主机时间戳（30 天
  // 内不再在断线横幅里教——教一次就够，反复出现是打扰）。
  const [tmuxPrefs, setTmuxPrefs] = useState<{ auto: Set<string>; last: Record<string, string>; declined: Record<string, number> }>({ auto: new Set(), last: {}, declined: {} });
  useEffect(() => { tmuxPrefsRef.current = tmuxPrefs; }, [tmuxPrefs]);
  useEffect(() => {
    const load = inTauri
      ? invoke("get_setting", { key: SETTING_TMUX_PREFS })
      : Promise.resolve((() => { try { return localStorage.getItem(SETTING_TMUX_PREFS); } catch { return null; } })());
    load.then((v) => {
      if (!v) return;
      try {
        const j = JSON.parse(v) as { auto?: string[]; last?: Record<string, string>; declined?: Record<string, number> };
        setTmuxPrefs({ auto: new Set(j.auto ?? []), last: j.last ?? {}, declined: j.declined ?? {} });
      } catch { /* 坏值按空偏好 */ }
    }).catch(() => {});
  }, [inTauri]);
  const updateTmuxPrefs = useCallback((fn: (p: { auto: Set<string>; last: Record<string, string>; declined: Record<string, number> }) => { auto: Set<string>; last: Record<string, string>; declined: Record<string, number> }) => {
    setTmuxPrefs((cur) => {
      const next = fn(cur);
      tmuxPrefsRef.current = next;
      const blob = JSON.stringify({ auto: [...next.auto], last: next.last, declined: next.declined });
      if (inTauri) void invoke("set_setting", { key: SETTING_TMUX_PREFS, value: blob }).catch(() => {});
      else try { localStorage.setItem(SETTING_TMUX_PREFS, blob); } catch { /* demo 尽力而为 */ }
      return next;
    });
  }, [inTauri]);

  // i18n 轮：切语言（设置面板唯一调用口）——写 t() 模块态 + App state 触发全树
  // 重渲染刷新读数 + 双域持久化（真实域 vault KV / demo 域 persistSetting 的 localStorage）
  const changeLocale = useCallback((l: Locale) => {
    setLocale(l);
    setLocaleState(l);
    persistSetting(SETTING_LOCALE, l);
  }, [persistSetting]);

  const changeFontSize = useCallback((n: number) => {
    const next = Math.max(FONT_MIN, Math.min(FONT_MAX, Math.round(n)));
    if (next === fontRef.current) return;
    fontRef.current = next;
    setFontSize(next);
    persistSetting(SETTING_FONT, String(next));
    // 已有会话即时改 options；隐藏会话的 PTY 宽高在重新激活时校准（attachSession 内 fitTerminal）
    for (const [, e] of termsRef.current) e.term.options.fontSize = next;
    for (const e of paneTermsRef.current.values()) e.term.options.fontSize = next;
    void fitTerminal();
    // 渲染器 cell 尺寸在下一帧才反映新字号：立即 fit 拿到旧尺寸会算出相同列数、
    // PTY 不跟随（走查实证 stty 恒 80 列）。延迟校准与 attachSession 的二次校准同理。
    setTimeout(() => void fitTerminal(), 150);
  }, [persistSetting, fitTerminal]);

  // P0 终端品质轮：外观五项即时应用到全部实例（新实例由 makeTerm 读 refs 继承）
  const applyTermPrefs = useCallback(() => {
    // 检查点重放的光标形状/闪烁同步取这里（避免 attach 把偏好冲回默认）
    setCursorDefault(termCursorStyleRef.current, termCursorBlinkRef.current);
    for (const [, e] of termsRef.current) {
      e.term.options.fontFamily = termFontFamilyRef.current;
      e.term.options.cursorStyle = termCursorStyleRef.current;
      e.term.options.cursorBlink = termCursorBlinkRef.current;
      e.term.options.scrollback = termScrollbackRef.current;
      e.term.options.letterSpacing = termLetterSpacingRef.current;
    }
    for (const e of paneTermsRef.current.values()) {
      e.term.options.fontFamily = termFontFamilyRef.current;
      e.term.options.cursorStyle = termCursorStyleRef.current;
      e.term.options.cursorBlink = termCursorBlinkRef.current;
      e.term.options.scrollback = termScrollbackRef.current;
      e.term.options.letterSpacing = termLetterSpacingRef.current;
    }
  }, []);
  // 影响 cell 度量的改动（字体族/字距）后重排 + 重算 PTY——与改字号同工艺：
  // 立即 fit 拿的是旧 cell 尺寸，150ms 后补一次（渲染器下一帧才反映新度量）
  const refitAfterMetrics = useCallback(() => {
    void fitTerminal();
    setTimeout(() => void fitTerminal(), 150);
  }, [fitTerminal]);
  const changeTermFont = useCallback((id: string) => {
    setTermFont(id);
    termFontFamilyRef.current = termFontCss(id);
    applyTermPrefs();
    refitAfterMetrics();
    persistSetting(SETTING_TERM_FONT_FAMILY, id);
  }, [applyTermPrefs, refitAfterMetrics, persistSetting]);
  const changeTermCursorStyle = useCallback((s: TermCursorStyle) => {
    setTermCursorStyle(s);
    termCursorStyleRef.current = s;
    applyTermPrefs();
    persistSetting(SETTING_TERM_CURSOR_STYLE, s);
  }, [applyTermPrefs, persistSetting]);
  const changeTermCursorBlink = useCallback((on: boolean) => {
    setTermCursorBlink(on);
    termCursorBlinkRef.current = on;
    applyTermPrefs();
    persistSetting(SETTING_TERM_CURSOR_BLINK, on ? "1" : "0");
  }, [applyTermPrefs, persistSetting]);
  const changeTermScrollback = useCallback((n: number) => {
    setTermScrollback(n);
    termScrollbackRef.current = n;
    // 上限变了：上一轮「已满」的结论作废，允许新上限再次提示
    scrollbackWarnRef.current.clear();
    applyTermPrefs();
    persistSetting(SETTING_TERM_SCROLLBACK, String(n));
  }, [applyTermPrefs, persistSetting]);
  const changeTermLetterSpacing = useCallback((n: number) => {
    setTermLetterSpacing(n);
    termLetterSpacingRef.current = n;
    applyTermPrefs();
    refitAfterMetrics();
    persistSetting(SETTING_TERM_LETTER_SPACING, String(n));
  }, [applyTermPrefs, refitAfterMetrics, persistSetting]);
  const changeTermWheelRate = useCallback((r: TermWheelRate) => {
    setTermWheelRate(r);
    termWheelRateRef.current = r;
    // 切到「跟随刷新率」立即起一轮实测，不必等用户先滚一下才准。
    if (r === "auto") displayIntervalMs();
    persistSetting(SETTING_TERM_WHEEL_RATE, String(r));
  }, [persistSetting]);
  // 连字开关（P0 轮）：真开/真关渲染器——开 = 释放 WebGL 换 DOM 渲染器（character
  // joiner 仅 DOM 实现）再载 LigaturesAddon；关 = 卸 addon、重挂 WebGL（失败回落 DOM）。
  // 逐实例热切换，不重建缓冲（滚动历史与在跑程序原地保留）；新建实例由 makeTerm 继承
  // （格子终端同构，找茬四轮 C3——热切换遍历双表，格子与主视图一起换装）。
  const applyLigatures = useCallback((on: boolean) => {
    const entries: Array<[string, { term: Terminal; webgl: WebglAddon | null; liga: LigaturesAddon | null }]> = [
      ...[...termsRef.current.entries()],
      ...[...paneTermsRef.current.entries()].map(([k, v]): [string, PaneTermEntry] => [`pane:${k}`, v]),
    ];
    for (const [key, e] of entries) {
      if (on) {
        if (e.webgl) { try { e.webgl.dispose(); } catch { /* 已释放 */ } e.webgl = null; }
        if (!e.liga) {
          const l = new LigaturesAddon();
          try { e.term.loadAddon(l); e.liga = l; } catch { /* 载入失败：维持无连字 */ }
        }
      } else {
        if (e.liga) { try { e.liga.dispose(); } catch { /* 已释放 */ } e.liga = null; }
        if (!e.webgl) {
          try {
            const w = new WebglAddon();
            w.onContextLoss(() => { try { w.dispose(); } catch { /* 已释放 */ } });
            e.term.loadAddon(w);
            e.webgl = w;
          } catch { /* DOM 渲染器兜底 */ }
        }
      }
      if (import.meta.env.DEV) {
        const probe = window as unknown as { __t_liga?: Set<string> };
        probe.__t_liga ??= new Set();
        if (e.liga) probe.__t_liga.add(key); else probe.__t_liga.delete(key);
      }
    }
  }, []);
  const changeTermLigatures = useCallback((on: boolean) => {
    setTermLiga(on);
    termLigaRef.current = on;
    applyLigatures(on);
    persistSetting(SETTING_TERM_LIGATURES, on ? "1" : "0");
  }, [applyLigatures, persistSetting]);

  // 二十二轮主题统一：色板联动终端的派生——终端底/前景/光标/选区取**当下生效的
  // chrome token**（data-theme×data-chrome 计算值，随色板与外观即时变化）；经
  // scratch 节点解析成 rgb()（token 声明值可能是 color-mix(...)，xterm 的 css 色
  // 解析器不认，必须用 resolved 值）。主题②轮起 ANSI 16 色按族取 --ansi-0..15
  // （styles.css 各族块写实色，ui/test/ansi-gen.mjs 生成、双审计独立复核）；
  // 某槽未声明时逐键回落深/浅基础预设（THEMES，本底做过 WCAG 校验）。
  // 派生结果写入 derivedThemeRef 供 makeTerm 取初值。
  const deriveTerminalTheme = useCallback((chrome: "dark" | "light") => {
    const resolveTokenColor = (name: string): string => {
      const scratch = document.createElement("span");
      scratch.style.color = `var(${name})`;
      document.body.appendChild(scratch);
      const v = getComputedStyle(scratch).color;
      scratch.remove();
      return v;
    };
    const base = themeById(chrome);
    const ANSI_KEYS = ["black", "red", "green", "yellow", "blue", "magenta", "cyan", "white",
      "brightBlack", "brightRed", "brightGreen", "brightYellow", "brightBlue", "brightMagenta", "brightCyan", "brightWhite"];
    const rootStyle = getComputedStyle(document.documentElement);
    const ansi: Record<string, string> = {};
    ANSI_KEYS.forEach((key, i) => {
      if (rootStyle.getPropertyValue(`--ansi-${i}`).trim()) ansi[key] = resolveTokenColor(`--ansi-${i}`);
    });
    return {
      theme: {
        ...base.theme,
        ...ansi,
        background: resolveTokenColor("--bg"),
        foreground: resolveTokenColor("--text"),
        cursor: resolveTokenColor("--accent"),
        cursorAccent: resolveTokenColor("--bg"),
        // 选区（可读性轮）：文字用加亮/压暗后的正文色、底用 accent 混终端底——
        // 浅色 22%（失焦 8%）、深色 30%（失焦 12%），34 态选中文字均 ≥4.5:1
        // （wcag-themes.mjs 门）；失焦底明显降级且与激活态可区分。
        selectionBackground: resolveTokenColor("--term-sel-bg"),
        selectionForeground: resolveTokenColor("--term-sel-fg"),
        selectionInactiveBackground: resolveTokenColor("--term-sel-inactive"),
      },
    };
  }, []);
  const applyDerivedTerminal = useCallback(() => {
    const { theme } = deriveTerminalTheme(document.documentElement.dataset.chrome === "light" ? "light" : "dark");
    derivedThemeRef.current = { theme: { ...theme } };
    for (const [, e] of termsRef.current) {
      e.term.options.theme = { ...theme };
    }
    for (const e of paneTermsRef.current.values()) {
      e.term.options.theme = { ...theme };
    }
  }, [deriveTerminalTheme]);

  // 外观应用（不落库）：system 按 prefers-color-scheme 现场解析；Tauri 原生窗口
  // system 态 setTheme(null) 归还系统跟随
  const applyAppearance = useCallback((a: Appearance) => {
    appearanceRef.current = a;
    setAppearance(a);
    applyChrome(a === "system" ? (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light") : a);
    if (inTauri) void getCurrentWindow().setTheme(a === "system" ? null : a).catch(() => {});
    // 二十二轮主题统一：外观变化（含启动 blob 重放）带动终端派生
    applyDerivedTerminal();
  }, [applyChrome, inTauri, applyDerivedTerminal]);

  // 外观落库（blob chrome 域，走串行化链防与 hostbar 写交错丢更新）
  const changeAppearance = useCallback((a: Appearance) => {
    applyAppearance(a);
    pulseChrome();
    wsWriteChain.current = wsWriteChain.current
      .then(() => invoke("get_workspace"))
      .then((ws) => invoke("set_workspace", { ws: { ...ws, chrome: a } }))
      .catch((e) => noteSettingWriteErr(errMsg(e)));
  }, [applyAppearance, pulseChrome, noteSettingWriteErr]);

  // 主题色板切换：即时预览 + KV 落库（demo=localStorage）；只改应用 chrome，不触碰终端
  const changePalette = useCallback((id: string) => {
    if (!PALETTES.some((p) => p.id === id) || id === paletteRef.current) return;
    paletteRef.current = id;
    setPalette(id);
    applyPalette(id);
    pulseChrome();
    persistSetting(SETTING_PALETTE, id);
    // 二十二轮主题统一：色板即主题——终端恒随派生
    applyDerivedTerminal();
  }, [applyPalette, pulseChrome, persistSetting, applyDerivedTerminal]);

  // 跟随系统：系统外观变化实时跟随（仅 system 态挂监听）
  useEffect(() => {
    if (appearance !== "system") return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => {
      applyChrome(mq.matches ? "dark" : "light");
      // 二十二轮主题统一：深浅翻转带动终端派生
      applyDerivedTerminal();
    };
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [appearance, applyChrome, applyDerivedTerminal]);

  // UX 五轮：整页缩放——Ctrl/⌘±0 键盘经 R13 keymap→dispatch→zoom.ts，滚轮在此注册。
  // useLayoutEffect：上次档位的恢复必须发生在首帧 paint 前（useEffect 会先画一帧 100%
  // 再跳变）；先订阅再注册，注册内同步恢复才能把档位刷进设置回显；注销必须接——
  // StrictMode dev 双跑，漏接 = 滚轮监听双注册（一档跳 0.2）
  useLayoutEffect(() => {
    const un = onZoomChange(setZoomLevel);
    const unreg = registerZoomHotkeys({ isTauri: inTauri, notify: pushToast });
    return () => { un(); unreg(); };
  }, [inTauri, pushToast]);

  // 键位表载入（两域共用）：存量自定义若让位给默认值（例：主机栏迁到 Ctrl+Shift+B 而该键
  // 已被别的动作占用）——一次性告知并回写解析结果，下次启动不再重复提示。
  const loadKeymap = useCallback((raw: string) => {
    const mac = isMacPlatform();
    const { map, lost } = parseKeymapReport(raw, mac);
    applyKeymap(map);
    if (lost.length === 0) return;
    persistSetting(KEYMAP_SETTING, JSON.stringify(map));
    const label = (id: KeyActionId) => t(KEYMAP_ACTIONS.find((a) => a.id === id)?.label ?? id);
    for (const l of lost) {
      pushToast("info", t("快捷键冲突：「{0}」原设 {1}，让给了「{2}」，已恢复为 {3}", label(l.id), formatBinding(l.was, mac), label(l.by), formatBinding(map[l.id], mac)),
        { label: t("去设置"), title: t("打开 设置 → 快捷键"), run: () => openSettingsAt("keys") });
    }
  }, [applyKeymap, persistSetting, pushToast, openSettingsAt]);

  // 启动载入偏好（Tauri=vault，浏览器=localStorage）；早于载入创建的实例一并补齐。
  // 二十二轮主题统一：只载字号/色板/外观三样，尾部统一派生终端一次——ui.theme /
  // ui.theme.follow 老 KV 不再读（历史值残留无害），终端配色由色板×深浅唯一决定。
  useEffect(() => {
    const applyFont = (f: number | null) => {
      if (f !== null && f >= FONT_MIN && f <= FONT_MAX) changeFontSize(f);
    };
    // R20 登记「chrome blob 消费归 R27」：外观事实源 = blob chrome 域（demo 同契约）
    const applyChromeBlob = (ws: { chrome?: string } | null) => {
      const c = ws?.chrome;
      if (c === "system" || c === "dark" || c === "light") applyAppearance(c);
    };
    // 主题色板启动载入（合法值才覆盖）；**缺省也必须显式写 data-theme**——不写
    // 属性时 CSS 落回 :root 石墨基底，出厂默认名存实亡（2026-10-27 切默认东京夜时实锤）
    const loadPalette = (v: string | null) => {
      if (v && PALETTES.some((p) => p.id === v) && v !== paletteRef.current) {
        paletteRef.current = v;
        setPalette(v);
      }
      applyPalette(paletteRef.current);
    };
    // P0 终端品质轮：外观五项 + 连字的取值（get 缺省 null；坏值逐键回落默认——
    // 键名/合法域见 app-data 的 SETTING_TERM_*/TERM_*）。载入后统一补齐存量实例
    // （首屏可能在偏好落定前就建了终端），连字开则逐实例切渲染器。
    const applyTermQuality = (get: (k: string) => string | null) => {
      const fid = get(SETTING_TERM_FONT_FAMILY);
      if (fid && TERM_FONTS.some((f) => f.id === fid)) {
        termFontFamilyRef.current = termFontCss(fid);
        setTermFont(fid);
      }
      const cs = get(SETTING_TERM_CURSOR_STYLE);
      if (cs === "block" || cs === "bar" || cs === "underline") {
        termCursorStyleRef.current = cs;
        setTermCursorStyle(cs);
      }
      const cb = get(SETTING_TERM_CURSOR_BLINK);
      if (cb !== null) {
        const on = cb !== "0";
        termCursorBlinkRef.current = on;
        setTermCursorBlink(on);
      }
      const sb = Number(get(SETTING_TERM_SCROLLBACK));
      if (Number.isFinite(sb) && sb >= 1000 && sb <= 1_000_000) {
        termScrollbackRef.current = sb;
        setTermScrollback(sb);
      }
      const ls = Number(get(SETTING_TERM_LETTER_SPACING));
      if (Number.isFinite(ls) && ls >= 0 && ls <= 4) {
        termLetterSpacingRef.current = ls;
        setTermLetterSpacing(ls);
      }
      // 滚轮上报频率：坏值/缺省回 60 次/秒；"auto" 等实测完成后由提供者自动取用
      const wr = parseTermWheelRate(get(SETTING_TERM_WHEEL_RATE));
      termWheelRateRef.current = wr;
      setTermWheelRate(wr);
      if (wr === "auto") displayIntervalMs();
      const lg = get(SETTING_TERM_LIGATURES);
      if (lg !== null) {
        const on = lg === "1";
        termLigaRef.current = on;
        setTermLiga(on);
      }
      applyTermPrefs();
      if (termLigaRef.current) applyLigatures(true);
    };
    if (!inTauri) {
      // 隐私模式（禁 Cookie/受限 WebView）下 localStorage 访问即抛 SecurityError——
      // demo 引导读偏好统一包 try（审查二轮 FE2-3；下方 applyTermQuality 同款既有
      // 实践），拿不到走各自默认值
      const safeGet = (k: string): string | null => { try { return localStorage.getItem(k); } catch { return null; } };
      const raw = Number(safeGet(SETTING_FONT) ?? safeGet(SETTING_FONT_LEGACY));
      applyFont(Number.isFinite(raw) && raw > 0 ? raw : null);
      loadPalette(safeGet(SETTING_PALETTE));
      // 键位表（键位配置轮）：demo 走 localStorage，坏串/缺省回落默认表
      const kmRaw = safeGet(KEYMAP_SETTING);
      if (kmRaw) loadKeymap(kmRaw);
      // ⑤ 传输免审 opt-in：demo 与 persistSetting 同走 localStorage
      setTransferAutonomy(safeGet("collab.autonomy.transfers") === "1");
      // ⑦ 记录保留期：demo 同走 localStorage（坏值回落 30 天）
      const rr = Number(safeGet("collab.records.retention_days") ?? "30");
      setRecordsRetention(Number.isFinite(rr) && rr >= 0 ? rr : 30);
      // P0 终端品质：同源 localStorage（persistSetting 的 demo 分支写入）
      applyTermQuality((k) => { try { return localStorage.getItem(k); } catch { return null; } });
      invoke("get_workspace")
        .then(applyChromeBlob)
        .catch(() => {})
        .then(() => applyDerivedTerminal());
      return;
    }
    const fontP = invoke("get_setting", { key: SETTING_FONT })
      .then((f) => (f === null ? invoke("get_setting", { key: SETTING_FONT_LEGACY }) : Promise.resolve(f)))
      .then((f) => applyFont(f === null ? null : Number(f)))
      .catch(() => {});
    const paletteP = invoke("get_setting", { key: SETTING_PALETTE }).then(loadPalette).catch(() => {});
    // i18n 轮：语言与字体/色板同通路（vault KV；demo 分支上面那段走 persistSetting 的
    // localStorage 落点，t() 模块初值已从 localStorage 读到）。KV 与初值不一致时以 KV 为准。
    // KV 无有效值=首次启动：跟随 OS 语言定初始界面语——只落模块态+localStorage 即时
    // 缓存，不写 KV：用户在设置里显式选择前保持「跟随系统」语义（OS 变则界面跟着变）。
    const localeP = invoke("get_setting", { key: SETTING_LOCALE })
      .then((v) => {
        if (v !== "en" && v !== "zh") {
          const l = resolveInitialLocale(null, navigator.languages?.length ? navigator.languages : [navigator.language]);
          if (localeNow() !== l) { setLocale(l); setLocaleState(l); }
          return;
        }
        if (localeNow() !== v) { setLocale(v); setLocaleState(v); }
      })
      .catch(() => {});
    const keymapP = invoke("get_setting", { key: KEYMAP_SETTING })
      .then((v) => { if (typeof v === "string" && v) loadKeymap(v); })
      .catch(() => {});
    const wsP = invoke("get_workspace").then(applyChromeBlob).catch(() => {});
    // P0 终端品质：六键一次并发回读（任一路失败回落该键默认，不拖累其余）；
    // 只在存量实例上补齐，不阻塞下面的主题派生
    void Promise.all(
      [
        SETTING_TERM_FONT_FAMILY, SETTING_TERM_LIGATURES, SETTING_TERM_CURSOR_STYLE,
        SETTING_TERM_CURSOR_BLINK, SETTING_TERM_SCROLLBACK, SETTING_TERM_LETTER_SPACING,
      ].map((k) =>
        invoke("get_setting", { key: k })
          .then((v) => [k, v === null ? null : String(v)] as const)
          .catch(() => [k, null] as const),
      ),
    ).then((pairs) => {
      const m = new Map(pairs);
      applyTermQuality((k) => m.get(k) ?? null);
    });
    // ⑤ 传输免审 opt-in 开关回读（vault 设置，默认关=传输逐条审批）
    invoke("get_setting", { key: "collab.autonomy.transfers" })
      .then((v) => setTransferAutonomy(v === "1"))
      .catch(() => {});
    // ⑦ 记录保留期回读（vault 设置，坏值回落 30 天；0=永久）
    invoke("get_setting", { key: "collab.records.retention_days" })
      .then((v) => {
        const n = Number(v ?? "30");
        setRecordsRetention(Number.isFinite(n) && n >= 0 ? n : 30);
      })
      .catch(() => {});
    // 字号/色板/外观三路都落定后派生一次（applyAppearance/loadPalette 内部亦有派生，
    // 这里兜底「全部缺省」的首次启动路径）
    void Promise.all([fontP, paletteP, wsP]).then(() => applyDerivedTerminal());
  }, [inTauri, changeFontSize, applyAppearance, applyPalette, applyDerivedTerminal, loadKeymap, applyTermPrefs, applyLigatures]);

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
          // 十五轮：选中即复制（缺省/未写入 = 关）
          if (ws.terminal.copy_on_select !== undefined) {
            copyOnSelectRef.current = ws.terminal.copy_on_select;
            setCopyOnSelect(ws.terminal.copy_on_select);
          }
          // 十六轮：响铃通知（缺省/未写入 = 关）
          if (ws.terminal.bell_notify !== undefined) {
            bellNotifyRef.current = ws.terminal.bell_notify;
            setBellNotify(ws.terminal.bell_notify);
          }
          // P2-c：OSC 52 写剪贴板策略（缺省/未知值 = ask）
          const o52 = ws.terminal.osc52;
          const pol = o52 === "allow" || o52 === "deny" ? o52 : "ask";
          osc52PolicyRef.current = pol;
          setOsc52Policy(pol);
        }
        // R33 §356：上次下载目录（缺省/null = 落系统 Downloads）
        if (ws.transfers?.download_dir) downloadDirRef.current = ws.transfers.download_dir;
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
  // R25 §318：粘贴保护开关——链式串行化写 terminal 域。
  // 十六轮重构：terminal 域写入收口到 writeTerminalPrefs（显式合并三键）——逐键各写
  // 一份字面量迟早再互踩（十五轮 changePasteGuard 整域替换抹掉 copy_on_select 即前科）
  const writeTerminalPrefs = useCallback((patch: Partial<{ paste_guard: boolean; copy_on_select: boolean; bell_notify: boolean; osc52: "allow" | "ask" | "deny" }>) => {
    wsWriteChain.current = wsWriteChain.current
      .then(() => invoke("get_workspace"))
      .then((ws) => invoke("set_workspace", { ws: { ...ws, terminal: {
        paste_guard: ws.terminal?.paste_guard ?? true,
        copy_on_select: ws.terminal?.copy_on_select ?? false,
        bell_notify: ws.terminal?.bell_notify ?? false,
        osc52: ws.terminal?.osc52 === "allow" || ws.terminal?.osc52 === "deny" ? ws.terminal.osc52 : "ask",
        ...patch,
      } } }))
      .catch((e) => noteSettingWriteErr(errMsg(e)));
  }, [noteSettingWriteErr]);
  const changePasteGuard = useCallback((pg: boolean) => {
    setPasteGuard(pg);
    pasteGuardRef.current = pg;
    writeTerminalPrefs({ paste_guard: pg });
  }, [writeTerminalPrefs]);
  // 本地终端一等公民轮补充：启动自动开本机终端可关（默认开）。关掉后冷启动
  // 不再起本地 shell——不用的本机终端（Windows Git Bash 为启动器+真 shell 两进程，
  // 提示符还会按仓库状态起 git）不必常驻；需要时从本机卡/快捷键手动开。
  const changeAutoLocal = useCallback((on: boolean) => {
    setAutoLocal(on);
    persistSetting(SETTING_AUTO_LOCAL, on ? "1" : "0");
  }, [persistSetting]);
  // 十五轮：选中即复制开关（默认关）
  const changeCopyOnSelect = useCallback((on: boolean) => {
    setCopyOnSelect(on);
    copyOnSelectRef.current = on;
    writeTerminalPrefs({ copy_on_select: on });
  }, [writeTerminalPrefs]);
  // 十六轮：响铃通知开关（默认关）
  const changeBellNotify = useCallback((on: boolean) => {
    setBellNotify(on);
    bellNotifyRef.current = on;
    writeTerminalPrefs({ bell_notify: on });
  }, [writeTerminalPrefs]);
  // P2-c：OSC 52 写剪贴板策略（默认 ask）
  const changeOsc52Policy = useCallback((v: "allow" | "ask" | "deny") => {
    setOsc52Policy(v);
    osc52PolicyRef.current = v;
    writeTerminalPrefs({ osc52: v });
  }, [writeTerminalPrefs]);

  // —— 十五轮：重连上次会话；工作空间轮：升级为全量组合记忆 ——
  // blob sessions 记「上次运行的画面」：last = 打开会话的主机清单（去重按标签序），
  // panes = 每台主机的 tmux 面板组合（格子会话名有序 + 布局树 + 主视图 attach）。
  // 只有本运行用户主动建连成功（createSession Ready → armed）才允许写：启动装载/
  // demo 预置会话不武装也不写（否则下次启动瞬间就用预置清单覆盖上次运行的记忆）。
  // 武装后随会话集合变化跟随写（含全关=空集）；拖布局/attach 这类不触发 sessions
  // 状态的变更由 scheduleWsSave 显式补写（1.5s 防抖）。运行期持续落盘 = 强杀/崩溃
  // 也保得住（对比 restore.v1 只在受控退出拍）。
  const [lastSessionHosts, setLastSessionHosts] = useState<string[]>([]);
  const [lastWorkspaceCombos, setLastWorkspaceCombos] = useState<HostPaneCombo[]>([]);
  const lastTrackArmedRef = useRef(false);
  // 本次运行是否出现过 SSH 会话：自动本机（默认启动行为）不能触发「上次会话」
  // 清单写空——否则默认配置下 prod 清单会被覆盖成 []，退出对话框承诺的一键恢复失效。
  const sshEverRef = useRef(false);
  const wsSaveTimerRef = useRef<number | null>(null);
  const writeWorkspaceSessions = useCallback(() => {
    if (!lastTrackArmedRef.current) return;
    const ids: string[] = [];
    const combos: HostPaneCombo[] = [];
    for (const s of sessionsRef.current) {
      // 本机也记（用户显式开的本地标签同样是「上次会话」）；但本次运行只有
      // 自动打开的本机、从没连过 SSH 时不写——那会把恢复清单挤成 ["local"]。
      if (s.kind === "ssh") sshEverRef.current = true;
      if (!ids.includes(s.host_id)) ids.push(s.host_id);
      // 面板组合只收 SSH 且真在用面板的会话：格子按快照序（=愿望清单序）取会话名
      if (s.kind !== "ssh") continue;
      const names: string[] = [];
      for (const p of s.panes ?? []) if (!names.includes(p.tmux_session)) names.push(p.tmux_session);
      // attach 与格子重名不成立（核心防呆保证），这里兜底过滤——两路视图撞车不变式
      const attached = s.tmux_attached && !names.includes(s.tmux_attached) ? s.tmux_attached : null;
      if (names.length === 0 && !attached) continue;
      combos.push({
        host_id: s.host_id,
        sessions: names.slice(0, PANE_MAX),
        attached,
        layout: sanitizeLayoutTree(paneLayoutRef.current.get(s.id) ?? null),
      });
    }
    // 本次运行从没连过 SSH（只有自动本机）：保留上次清单，不写空覆盖
    if (ids.length === 0 && !sshEverRef.current) return;
    wsWriteChain.current = wsWriteChain.current
      .then(() => invoke("get_workspace"))
      .then((ws) => invoke("set_workspace", { ws: { ...ws, sessions: { last: ids, panes: combos } } }))
      .catch(() => {});
  }, []);
  const scheduleWsSave = useCallback(() => {
    if (wsSaveTimerRef.current !== null) window.clearTimeout(wsSaveTimerRef.current);
    wsSaveTimerRef.current = window.setTimeout(() => { wsSaveTimerRef.current = null; writeWorkspaceSessions(); }, 1500);
  }, [writeWorkspaceSessions]);
  wsSaveKickRef.current = scheduleWsSave; // 排版/拖拽路径的 ref 间接层（wsSaveKickRef 声明在前）
  useEffect(() => { writeWorkspaceSessions(); }, [sessions, writeWorkspaceSessions]);
  // 欢迎页可见时读清单（回欢迎页也重读——与 armed 写入一致；主机已删的行由渲染侧过滤；
  // 组合一并读出，供「重连上次会话」全量恢复。按钮以 lastSessionHosts 非空才渲染，
  // 无需单独的就绪标记）
  useEffect(() => {
    if (sessions.length > 0) return;
    let dead = false;
    invoke("get_workspace")
      .then((ws) => {
        if (dead) return;
        const sp = (ws?.sessions ?? null) as { last?: string[]; panes?: HostPaneCombo[] } | null;
        setLastSessionHosts(sp?.last ?? []);
        setLastWorkspaceCombos(Array.isArray(sp?.panes) ? sp!.panes! : []);
      })
      .catch(() => {});
    return () => { dead = true; };
  }, [sessions.length]);
  // —— P3 会话现场恢复：欢迎页「恢复上次现场」数据源（退出快照，vault KV 加密）——
  const [restoreEntries, setRestoreEntries] = useState<RestoreEntry[]>([]);
  useEffect(() => {
    let dead = false;
    invoke("read_restore", {})
      .then((rs) => { if (!dead) setRestoreEntries(rs); })
      .catch(() => { if (!dead) setRestoreEntries([]); });
    return () => { dead = true; };
  }, []);
  const toggleHostbar = useCallback((open: boolean, focusSearch?: boolean) => {
    setHostbarOpen(open);
    // 键盘开栏即落焦点到搜索框（找茬四轮 D2）：此前只翻状态——有会话时 Tab 全被
    // xterm 吃掉（\t 直发 shell），纯键盘用户够不到主机列表（palette 能补「键盘连
    // 主机」、补不了「到达列表 UI」）。鼠标/rail 开栏不传本参不抢焦点（§6.3 焦点
    // 纪律）；焦点归还走 Esc/再按热键的既有链。
    if (open && focusSearch) {
      window.setTimeout(() => hostSearchRef.current?.focus(), 0);
    }
    // 活动栏轮：左栏视图互斥——展开主机栏即收起 Agent/编排/监控（双写各自持久键）
    if (open) {
      setAgentOpen(false);
      try { localStorage.setItem("ui.agentbar", "0"); } catch { /* 隐私模式忽略 */ }
      setFleetOpen(false);
      try { localStorage.setItem("ui.fleetbar", "0"); } catch { /* 隐私模式忽略 */ }
      setMonitorOpen(false);
      try { localStorage.setItem("ui.monitorbar", "0"); } catch { /* 隐私模式忽略 */ }
    }
    try { localStorage.setItem("ui.hostbar", open ? "1" : "0"); } catch { /* 隐私模式忽略 */ }
    persistHostbarPrefs(open, hostbarWidthRef.current);
  }, [persistHostbarPrefs]);
  // Agent 视图开关（活动栏 rail-agent / 命令面板同一入口）：与主机栏/编排/监控互斥。
  // 关闭也落盘——刷新后保持「上次关了」的意图。
  const toggleAgent = useCallback((open: boolean) => {
    setAgentOpen(open);
    try { localStorage.setItem("ui.agentbar", open ? "1" : "0"); } catch { /* 隐私模式忽略 */ }
    if (open) {
      setFleetOpen(false);
      try { localStorage.setItem("ui.fleetbar", "0"); } catch { /* 隐私模式忽略 */ }
      setMonitorOpen(false);
      try { localStorage.setItem("ui.monitorbar", "0"); } catch { /* 隐私模式忽略 */ }
      if (hostbarOpenRef.current) toggleHostbar(false);
    }
  }, [toggleHostbar]);
  // 编排者视图开关（Fleet 轮）：同款互斥族。
  const toggleFleet = useCallback((open: boolean) => {
    setFleetOpen(open);
    try { localStorage.setItem("ui.fleetbar", open ? "1" : "0"); } catch { /* 隐私模式忽略 */ }
    if (open) {
      setAgentOpen(false);
      try { localStorage.setItem("ui.agentbar", "0"); } catch { /* 隐私模式忽略 */ }
      setMonitorOpen(false);
      try { localStorage.setItem("ui.monitorbar", "0"); } catch { /* 隐私模式忽略 */ }
      if (hostbarOpenRef.current) toggleHostbar(false);
    }
  }, [toggleHostbar]);
  // 监控大屏开关（大屏轮）：同左栏互斥族（现四向）——开一个关其余，关闭
  // 也落盘（刷新后保持「上次关了」的意图，与 Agent/Fleet 一致）。
  const toggleMonitor = useCallback((open: boolean) => {
    setMonitorOpen(open);
    try { localStorage.setItem("ui.monitorbar", open ? "1" : "0"); } catch { /* 隐私模式忽略 */ }
    if (open) {
      setAgentOpen(false);
      try { localStorage.setItem("ui.agentbar", "0"); } catch { /* 隐私模式忽略 */ }
      setFleetOpen(false);
      try { localStorage.setItem("ui.fleetbar", "0"); } catch { /* 隐私模式忽略 */ }
      if (hostbarOpenRef.current) toggleHostbar(false);
    }
  }, [toggleHostbar]);
  const toggleMonitorPause = useCallback(() => {
    setMonitorPaused((p) => {
      const next = !p;
      setStoreMonitorPaused(next);
      try { localStorage.setItem("tinyssh.monitorPaused", next ? "1" : "0"); } catch { /* 隐私模式忽略 */ }
      return next;
    });
  }, []);
  // 采集开关 toggle（开关轮）：React 态落地后由 effect 推给 store（store 负责落
  // 盘与在存条目的差量收拾），这里只翻状态
  const toggleMonGeneral = useCallback(() => setMonGeneral((g) => !g), []);
  const toggleMonNpu = useCallback(() => setMonNpu((g) => !g), []);
  // 开关 → store：落盘 + 差量收拾（关掉的一路清历史/拆条目）。先推开关再同步
  // 目标（目标同步 effect 在 monitorCards 之后声明，同一次提交内按序执行）
  useEffect(() => {
    setMonEnabled({ general: monGeneral, npu: monNpu });
  }, [monGeneral, monNpu]);
  const gripDrag = useRef(false);
  const gripRaf = useRef(0);
  const gripDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    gripDrag.current = true;
  };
  const gripMove = (e: React.PointerEvent<HTMLDivElement>) => {
    // e.buttons 兜底 pointercancel/失焦后残留的拖拽态（rev-r12 LOW-4）；pointermove
    // 高频（>屏幕刷新率）——rAF 合帧 + 同值跳过，拖把手不再按事件频率整树重渲染
    if (!gripDrag.current || e.buttons === 0) return;
    if (gripRaf.current) return;
    const x = e.clientX;
    gripRaf.current = requestAnimationFrame(() => {
      gripRaf.current = 0;
      // 活动栏轮：左缘 44px 活动栏占位，抓手 x 要先扣掉才是主机栏宽
      const w = Math.min(300, Math.max(200, Math.round(x) - 44));
      setHostbarWidth((cur) => (cur === w ? cur : w));
    });
  };
  const gripUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!gripDrag.current) return;
    gripDrag.current = false;
    if (gripRaf.current) { cancelAnimationFrame(gripRaf.current); gripRaf.current = 0; }
    e.currentTarget.releasePointerCapture(e.pointerId);
    // 落盘用事件坐标重算而非渲染帧闭包值（分离事件序列下前者才是最新）
    const w = Math.min(300, Math.max(200, Math.round(e.clientX) - 44));
    setHostbarWidth(w);
    try { localStorage.setItem("ui.hostbar_w", String(w)); } catch { /* 隐私模式忽略 */ }
    persistHostbarPrefs(hostbarOpenRef.current, w);
  };
  // Agent 视图宽度抓手（活动栏轮）：同 hostbar 抓手的 rAF 合帧模式，宽度档 320–560。
  // x 起算点含活动栏 44px——抓手事件坐标直接对「抓手左缘 = 期望宽」自洽（与 hostbar
  // 不同：那边无活动栏时抓手 x 即宽）。此处 agentbar 在活动栏右侧，宽 = x - 44。
  const agGripDrag = useRef(false);
  const agGripRaf = useRef(0);
  const agGripDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    agGripDrag.current = true;
  };
  const agGripMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!agGripDrag.current || e.buttons === 0) return;
    if (agGripRaf.current) return;
    const x = e.clientX;
    agGripRaf.current = requestAnimationFrame(() => {
      agGripRaf.current = 0;
      const w = Math.min(560, Math.max(320, Math.round(x) - 44));
      setAgentWidth((cur) => (cur === w ? cur : w));
    });
  };
  const agGripUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!agGripDrag.current) return;
    agGripDrag.current = false;
    if (agGripRaf.current) { cancelAnimationFrame(agGripRaf.current); agGripRaf.current = 0; }
    e.currentTarget.releasePointerCapture(e.pointerId);
    const w = Math.min(560, Math.max(320, Math.round(e.clientX) - 44));
    setAgentWidth(w);
    try { localStorage.setItem("ui.agentbar_w", String(w)); } catch { /* 隐私模式忽略 */ }
  };
  const hostQueryN = hostQuery.trim().toLowerCase();
  // R20（§4.2 主机栏）：收藏置顶分组（有收藏→「收藏/其他主机」两组；无收藏→「全部主机」）、
  // 组内名称排序（byName 见 app-data）、标签 chip 筛选
  const metaById = new Map(hostMeta.map((m) => [m.host_id, m]));
  const isFav = (h: Host) => metaById.get(h.id)?.favorite === true;
  // 本地终端一等公民轮：本机从过滤链摘出——置顶「本机」节常驻，不受搜索/标签
  // 筛选影响（内置条目心智：永远在那，编辑/删除入口同轮移除）
  const localHost = hosts.find((h) => h.id === "local") ?? null;
  const poolHosts = hosts.filter((h) => h.id !== "local");
  // 是否有非本地会话在开——端口转发是 SSH 专属能力，纯本机（或空）时收起全部
  // 入口（rail/状态条/工具菜单/⌘K），点了才报错不如不摆（本机一等公民轮口径）。
  // ⌘K 恢复枢纽同用此条件：本地 PTY 标签不算「有会话」。
  const remoteOpen = sessions.some((s) => s.kind !== "local");
  const allTags = [...new Set(hosts.flatMap((h) => h.tags ?? []))].sort((a, b) => a.localeCompare(b, "zh"));
  // rev-r20 M1：活跃标签经编辑/删除在全部主机上消失后 chip 不再渲染，tagFilter 残留会
  // 让列表恒空且无清除入口——失效筛选自动失效
  const activeTag = tagFilter !== null && allTags.includes(tagFilter) ? tagFilter : null;
  const tagFiltered = activeTag ? poolHosts.filter((h) => (h.tags ?? []).includes(activeTag)) : poolHosts;
  // rev-r20 L1：无查询时 tagFiltered===hosts，原地 sort 会在渲染期改 state 数组——拷贝后排序
  const filteredHosts = [...(hostQueryN
    ? tagFiltered.filter((h) => hostMatches(h, hostQueryN))
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
  // 面板需求与实际面板宽一致（rev-r12 M1：此前按 320 算断点但面板钉死 384，
  // 终端实测可被压到 504 < 规范下限 560）；16px 回差双阈值防临界抖动。
  // 可拖宽后断点吃当前宽度——拖动越线会切完整视图，所以抓手同时把上限钳在
  // 「终端保底 560」，正常拖动只会停在边界，不触发整层切换。
  const panelNeed = taskPanelW;
  // 活动栏轮：availW 扣当前打开的左栏视图（主机栏或 Agent 视图，互斥不同时开）。
  // 大屏轮：监控改主区覆盖层（不挤占终端宽度），不再参与 availW 计算
  const availW = winW - (hostbarOpen ? hostbarWidth : agentOpen || fleetOpen ? agentWidth : 0);
  // 右侧活动栏 44px 常驻：终端可用宽 = availW - 面板 - 44，故拖宽上限随之收
  const tpMaxW = Math.max(320, Math.min(560, availW - 560 - 44));
  const tpGripDrag = useRef(false);
  const tpGripRaf = useRef(0);
  const tpGripDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    tpGripDrag.current = true;
  };
  const tpGripMove = (e: React.PointerEvent<HTMLDivElement>) => {
    // 与 hostbar/agentbar 抓手同款 rAF 合帧 + 同值跳过，拖动不按事件频率整树重渲染
    if (!tpGripDrag.current || e.buttons === 0) return;
    if (tpGripRaf.current) return;
    const x = e.clientX;
    tpGripRaf.current = requestAnimationFrame(() => {
      tpGripRaf.current = 0;
      // 面板贴右缘：右边界取实际盒子（它不随宽度变），宽度 = 右缘 - 指针 x
      const right = taskPanelRef.current?.getBoundingClientRect().right ?? window.innerWidth;
      const w = Math.min(tpMaxW, Math.max(320, Math.round(right - x)));
      setTaskPanelW((cur) => (cur === w ? cur : w));
    });
  };
  const tpGripUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!tpGripDrag.current) return;
    tpGripDrag.current = false;
    if (tpGripRaf.current) { cancelAnimationFrame(tpGripRaf.current); tpGripRaf.current = 0; }
    e.currentTarget.releasePointerCapture(e.pointerId);
    const right = taskPanelRef.current?.getBoundingClientRect().right ?? window.innerWidth;
    const w = Math.min(tpMaxW, Math.max(320, Math.round(right - e.clientX)));
    setTaskPanelW(w);
    try { localStorage.setItem("ui.taskpanel_w", String(w)); } catch { /* 隐私模式忽略 */ }
  };
  const [tpFull, setTpFull] = useState(false);
  useEffect(() => {
    if (rightPanel === null) { setTpFull(false); return; }
    // §186/§187（R12 登记归本轮）：双分屏时面板一律走中央完整视图——
    // 避免终端×2 + 面板形成三个窄工作区；关闭面板即恢复原分屏（分屏不拆）
    if (splitPanes) { setTpFull(true); return; }
    const th = 560 + panelNeed;
    if (availW < th - 16) setTpFull(true);
    else if (availW > th + 16) setTpFull(false);
  }, [availW, panelNeed, rightPanel, splitPanes]);
  const toolsRef = useRef<HTMLDivElement | null>(null);
  const tmuxMenuRef = useRef<HTMLDivElement | null>(null);
  const tabsMenuRef = useRef<HTMLDivElement | null>(null);
  const focusHostMenuRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!toolsOpen && !tabsMenuOpen && !tmuxMenu && !focusHostMenu) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (toolsOpen && !toolsRef.current?.contains(t)) setToolsOpen(false);
      if (tabsMenuOpen && !tabsMenuRef.current?.contains(t)) setTabsMenuOpen(false);
      if (tmuxMenu && !tmuxMenuRef.current?.contains(t)) setTmuxMenu(false);
      if (focusHostMenu && !focusHostMenuRef.current?.contains(t)) setFocusHostMenu(false);
    };
    window.addEventListener("mousedown", onDown, true);
    return () => window.removeEventListener("mousedown", onDown, true);
  }, [toolsOpen, tabsMenuOpen, tmuxMenu, focusHostMenu]);
  useEffect(() => {
    // resize 连发期间防抖 120ms（与终端 fit 防抖同节奏）：availW/tpFull 判定、
    // 文件菜单定位都不需要逐帧精度，不必按事件频率整树重渲染
    let t: ReturnType<typeof setTimeout> | undefined;
    const on = () => { if (t) clearTimeout(t); t = setTimeout(() => setWinW(window.innerWidth), 120); };
    window.addEventListener("resize", on);
    return () => { window.removeEventListener("resize", on); if (t) clearTimeout(t); };
  }, []);

  // Esc 关浮层（R13）：三个模态（确认/指纹/双因素）最优先——它们视觉上也最上层；
  // 其余非模态浮层按固定序（搜索→设置→菜单→表单），非严格开叠序（§7.3 未细化
  // 非模态次序，固定序与 R12 行为一致——rev-r13 低-3 如实登记）。指纹 Esc=取消
  // 连接、双因素 Esc=取消认证，与各自「取消」按钮同语义。ref 持有（闭包引用
  // 后文定义的处理器，无求值顺序问题）。
  // 聚焦某会话“上次落焦的子窗口”，返回实际聚焦的格子（主视图为 null）。
  // 单窗格优先恢复记忆格；zoom 态只认被放大的格（其余格子 display:none）；
  // 分屏、格已关、格已死、格不可见都回落主视图。focusSession 与关浮层共用，
  // 避免 restoreTermFocus 永远聚焦主终端把 paneLastFocusRef 覆盖成 main。
  const focusTermFor = useCallback((target: string): PaneTermEntry | null => {
    const entry = termsRef.current.get(target);
    if (!entry) return null;
    let restored: PaneTermEntry | null = null;
    if (!groupOf(target)) {
      const zoom = paneZoomRef.current;
      if (zoom?.sid === target && zoom.name === MAIN_KEY) {
        entry.term.focus();
        return null;
      }
      if (zoom?.sid === target) {
        restored = [...paneTermsRef.current.values()].find(
          (e) => e.sid === target && e.name === zoom.name && e.alive && e.cell.style.display !== "none",
        ) ?? null;
      }
      if (!restored) {
        const remembered = paneLastFocusRef.current.get(target);
        if (remembered && remembered !== "main") {
          const pane = paneTermsRef.current.get(remembered);
          if (pane && pane.alive && pane.cell.style.display !== "none") restored = pane;
        }
      }
    }
    if (restored) restored.term.focus();
    else entry.term.focus();
    return restored;
  }, [groupOf]);
  focusTermForRef.current = focusTermFor;

  // §7.4：关闭工具后恢复到其触发前的有效焦点——工具均从终端场景触发，恢复即
  // 聚焦活动终端/该标签上次落焦的格子（focusin 链会自动恢复 native Ctrl 上报）。
  const restoreTermFocus = () => {
    const sid = sidRef.current;
    if (!sid) return;
    focusTermFor(sid);
  };
  const escKeepFocusRef = useRef(false);
  const closeTopOverlayRef = useRef<() => boolean>(() => false);
  closeTopOverlayRef.current = (): boolean => {
    if (quitSummary) { void cancelQuit(); return true; }
    if (delegateDlg) { closeDelegate(); return true; }
    const ap = authPromptQueue[0];
    if (ap) { void answerAuthPrompt(ap.id, ""); return true; }
    const hk = hostKeyQueue[0];
    if (hk) { void decideHostKey(hk, false); return true; }
    // 在途确认（关闭中/删除中）不得用 Esc 假装取消：操作仍在核心继续，遮罩消失
    // 只会让人以为已取消——与「取消」钮一致保持禁用。
    if (confirm) { if (!confirmBusyRef.current) setConfirm(null); return true; }
    if (pasteConfirm) { setPasteConfirm(null); return true; }
    // P2-c：OSC 52 询问卡同属模态链——Esc 即拒绝（关卡不写剪贴板）
    if (osc52Ask) { shiftOsc52Ask(); return true; }
    // 拖拽上传确认卡同样是模态（全屏遮罩+焦点陷阱）——Esc 链此前漏出（审计 F5）
    if (pendingDrop) { setPendingDrop(null); return true; }
    // 命令面板是带遮罩模态、可叠开在非模态浮层之上——Esc 先关视觉顶层（R3-B-8）
    if (paletteOpen) { setPaletteOpen(false); return true; }
    // 设置遮罩层级高于搜索/大屏：可视顶层优先，不能让 Esc 先关被压在下面的搜索
    if (showSettings) { closeSettings(); return true; }
    // 大屏覆盖层/广播输入/传输抽屉：非模态但同属浮层链——纯键盘用户要有 Esc 出口
    if (tmuxWallSid) { setTmuxWallSid(null); return true; }
    if (monitorOpen) { toggleMonitor(false); return true; }
    if (broadcastOpen) { setBroadcastOpen(false); return true; }
    if (queueOpen) { setQueueOpen(false); return true; }
    if (detail || detailErr) { closeDetail(); return true; }
    if (tabMenu) { setTabMenu(null); return true; }
    if (hostMenu) { setHostMenu(null); return true; }
    if (termMenu) { setTermMenu(null); return true; }
    if (recentMenu) { setRecentMenu(null); return true; }
    if (splitMenu) { setSplitMenu(false); return true; }
    if (tmuxMenu) { setTmuxMenu(false); return true; }
    if (searchOpen) { closeSearch(); return true; }
    if (toolsOpen) { setToolsOpen(false); return true; }
    if (tabsMenuOpen) { setTabsMenuOpen(false); return true; }
    if (focusHostMenu) { setFocusHostMenu(false); return true; }
    if (showAddHost || editingHost) { closeAddHost(); return true; }
    if (showQuickConnect) { closeQuickConnect(); return true; } // UX2 走查：快速连接对话框的键盘出口（FE7 同族漏网）
    if (showImport) { setShowImport(false); return true; }
    if (showAgentHelp) { setShowAgentHelp(false); return true; }
    return false;
  };

  dispatchRef.current = (a: AppAction): boolean => {
    switch (a.id) {
      case "esc": {
        // 守卫型关闭（凭据草稿/一次性 Token）首次 Esc 只提示不关：此时不能把焦点
        // 还给终端，否则「对话框还在、输入框却失焦」，后续键入直接进远端 shell。
        escKeepFocusRef.current = false;
        const handled = closeTopOverlayRef.current();
        const keep = escKeepFocusRef.current;
        escKeepFocusRef.current = false;
        if (handled && !keep) restoreTermFocus();
        return handled;
      }
      case "search":
        if (!sidRef.current) return false; // 无活动会话不劫持（保持既有语义）
        openSearch();
        return true;
      case "zoom-in": zoomIn(); return true;
      case "zoom-out": zoomOut(); return true;
      case "zoom-reset": zoomReset(); return true;
      case "hostbar":
        // 键盘路径（Ctrl+Shift+B）：开栏即落焦点搜索框（D2）
        toggleHostbar(!hostbarOpenRef.current, !hostbarOpenRef.current);
        return true;
      case "palette":
        // ⌘K 命令面板（十九轮）：模态层不叠开（同 settings 门）；resolveAction
        // 已按模态门吞键，此处门是菜单加速器等不经解析器的入口的对齐
        if (modalRef.current) return false;
        setPaletteOpen(true);
        return true;
      case "settings":
        // 菜单加速器不经 resolveAction 的模态门（NSMenu 在 WebView 之前消费），
        // 这里补同一条 §7.3 规则：对话框打开时不叠开面板。监控大屏/tmux 墙是
        // 视图型覆盖层，设置面板本就在它们之上（rail 设置钮可点开），不算阻挡。
        if (dialogModalRef.current) return false;
        setShowSettings(true);
        return true;
      case "tab-switch": {
        // 一组一标签：⌘1-9 按可见标签（组=一格）跳转，组标签落到上次焦点成员
        const entries = deriveTabEntries(sessionsRef.current, splitGroupsRef.current);
        const e = entries[a.index];
        if (!e) return false;
        void attachSession(entryFocusSid(e, groupFocusRef.current)).catch((er) => pushToast("err", errMsg(er)));
        return true;
      }
      case "tab-cycle": {
        const entries = deriveTabEntries(sessionsRef.current, splitGroupsRef.current);
        if (!entries.length) return false;
        const cur = sidRef.current;
        let i0 = entries.findIndex((e) => (e.kind === "group"
          ? e.group.main === cur || e.group.second === cur
          : e.session.id === cur));
        if (i0 < 0) i0 = 0;
        const e = entries[(i0 + a.dir + entries.length) % entries.length];
        void attachSession(entryFocusSid(e, groupFocusRef.current)).catch((er) => pushToast("err", errMsg(er)));
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
      case "tab-new": {
        // 直键 Ctrl+T（UX 六轮）：镜像工具栏「新建连接」按钮。表单已改居中对话框
        // （用户反馈二轮）——主机栏不必展开、专注模式也不必退出（mask 可盖全屏）
        setShowAddHost(true);
        setShowImport(false);
        setShowQuickConnect(false);
        return true;
      }
      case "term-local": {
        // Ctrl+Shift+T（本地终端一等公民轮）：直连「本机」开本地 shell——
        // 与 ⌘K「打开本地终端」/置顶本机卡同路径（shell 默认选择在 createSession 单点）
        const lh = hosts.find((h) => h.id === "local");
        if (lh) void createSession(lh);
        return !!lh;
      }
      case "split-toggle": {
        // 直键 Ctrl+D（UX 六轮）：与工具栏分屏按钮同路径——已分屏先退（两会话都
        // 保留）；未分屏弹「会话选择」菜单（方向左右/上下在菜单内选择）
        if (splitPanes) void exitSplit();
        else setSplitMenu(true);
        return true;
      }
      case "focus-toggle":
        // F11 专注模式（固定键）：与标签条按钮/命令面板同走 applyFocus 单入口
        applyFocus(!focusMode);
        return true;
      default: return false;
    }
  };

  // 唯一的 ⌘ 组合捕获层（R13）：keymap 解析 + dispatchRef 执行。模态期解析器
  // 直接返回 null（除 Esc 交浮层链）——模态层不串输入。
  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      // 键位录入期整体让路（键位配置轮）：Esc 在这里会被当「关最上层浮层」把设置
      // 对话框关掉（closeTopOverlay 链含 showSettings）——录入期的 Esc 只该取消录入，
      // 由录入监听（注册序在其后）独家消费
      if (keyCaptureRef.current) return;
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
        keymap: keymapRef.current,
      });
      if (!a) return;
      // 大屏键入焦点（.tw-input，监控墙隐藏输入框）：键入不触发应用动作——
      // Ctrl+W 在 shell 里是 werase 不是关标签、Ctrl+F 是向历史搜索不是开查找
      // （与终端 textarea 的 W4 豁免同口径，监控墙轮）。仅 Esc 例外放行：
      // 浮层链优先（有浮层关浮层，无浮层 dispatch false 原样透传给键入通道）。
      // tmux 新建会话作曲行（.tmux-create-input）是整段全拦（含 Esc）：Esc 在
      // 这里是「取消作曲」，走 keymap 浮层链会连菜单一起关掉
      if (document.activeElement?.classList.contains("tmux-create-input")) return;
      if (a.id !== "esc" && document.activeElement?.classList.contains("tw-input")) return;
      // 墙键入态（.tw-input 聚焦）的 Esc 归会话：窗口捕获先于墙自己的 document
      // 监听，若在这里走浮层链会把墙关掉（Esc 送 vim 的语义当场丢失）。
      // 非键入态照旧交浮层链，由墙的 document 监听逐级退出。
      if (a.id === "esc" && document.activeElement?.classList.contains("tw-input")) return;
      if (dispatchRef.current(a)) {
        ev.preventDefault();
        ev.stopPropagation();
      }
    };
    window.addEventListener("keydown", onKey, { capture: true });
    return () => window.removeEventListener("keydown", onKey, { capture: true });
  }, []);

  // 分屏窗格按钮的状态（图标/文案）随组与最大化槽位同步；locale 切换也经同一处刷新
  const syncSplitPaneButtons = useCallback((e: {
    splitMaxBtn: HTMLButtonElement; splitSwapBtn: HTMLButtonElement; splitExitBtn: HTMLButtonElement;
  }, sessionSid: string, g: SplitGroup | null) => {
    const slot = g ? slotOf(g, sessionSid) : null;
    const maxOn = !!g && g.maximized === slot;
    e.splitMaxBtn.innerHTML = maxOn ? PANE_ZOOM_ON_SVG : PANE_ZOOM_OFF_SVG;
    e.splitMaxBtn.title = maxOn ? t("还原双窗格") : t("最大化此窗格");
    e.splitMaxBtn.setAttribute("aria-label", e.splitMaxBtn.title);
    e.splitSwapBtn.title = t("交换两个窗格");
    e.splitSwapBtn.setAttribute("aria-label", e.splitSwapBtn.title);
    e.splitExitBtn.title = t("退出分屏（两个会话都保留）");
    e.splitExitBtn.setAttribute("aria-label", e.splitExitBtn.title);
  }, []);

  // 由 splitGroups/sidRef 统一同步各终端层的显示类（display 归它管，React 不渲染这些层）：
  // 单 pane：活动会话 .active；分屏：只显示活动会话所在的组，主格=左半/上半（dir），
  // 副格=另一半，焦点 pane 加高亮与名牌。§185 退化态：只呈现焦点窗格全幅；最大化态：
  // 同组另一格 pane-hidden（仍留在标签中），分割条由 JSX 撤收。
  const applyPanes = useCallback(() => {
    const sp = groupOf(sidRef.current);
    const degraded = !!sp && !sp.maximized && splitDegradedRef.current;
    const clsMain = sp?.dir === "tb" ? "pane-top" : "pane-left";
    const clsSecond = sp?.dir === "tb" ? "pane-bottom" : "pane-right";
    // 每格遮罩按自身状态刷新：Reconfirming 仍可操作（不断言断开），其余非 Connected
    // 态蒙住本格；非聚焦格同样有，且只盖本格——不压暗另一格。
    const syncPaneScrim = (e: {
      el: HTMLDivElement; scrim: HTMLDivElement; scrimState: HTMLElement;
      scrimHint: HTMLElement; scrimReconnect: HTMLButtonElement;
    }, st: string | undefined, inPane: boolean) => {
      const state = st ?? "Disconnected";
      // 只有当前分屏槽位里的窗格才带 pane-dead：退出分屏后该会话回到单窗格，
      // 断线提示交还全局 .dead-overlay，别把陈旧标记留在 DOM 上
      e.el.classList.toggle("pane-dead", inPane && state !== "Connected" && state !== "Reconfirming");
      if (e.scrim.dataset.state !== state) e.scrim.dataset.state = state;
      const label = stateLabel(state).text;
      if (e.scrimState.textContent !== label) e.scrimState.textContent = label;
      const hint = state === "Reconnecting"
        ? t("正在重建连接；键入已拦截")
        : state === "Degraded"
          ? t("连接中断，正在自动重连；键入已拦截")
          : t("此窗格已断开；另一格不受影响");
      if (e.scrimHint.textContent !== hint) e.scrimHint.textContent = hint;
      const reconnectingNow = state === "Reconnecting";
      if (e.scrimReconnect.disabled !== reconnectingNow) e.scrimReconnect.disabled = reconnectingNow;
      const btnLabel = reconnectingNow ? t("重连中…") : t("重连");
      if (e.scrimReconnect.textContent !== btnLabel) e.scrimReconnect.textContent = btnLabel;
    };
    for (const [s, e] of termsRef.current) {
      e.el.classList.remove("active", "pane-left", "pane-right", "pane-top", "pane-bottom",
        "pane-focused", "pane-hidden", "pane-max");
      const ss = sessionsRef.current.find((x) => x.id === s);
      const slot = sp && !degraded ? slotOf(sp, s) : null;
      syncPaneScrim(e, ss?.state, !!slot);
      if (sp && !degraded) {
        if (slot) {
          e.el.classList.add(slot === "main" ? clsMain : clsSecond);
          if (sp.maximized) {
            if (sp.maximized === slot) e.el.classList.add("pane-max");
            else e.el.classList.add("pane-hidden");
          }
          // 名牌带非连接态后缀（找茬五轮 C-4，镜像 tmux-cell-state 语义）：分屏
          // 副格装着断开会话时正文是黑腔，此前名牌只有裸主机名——「黑屏像坏了」。
          // 文案统一取 stateLabel（Reconfirming=已重连 · 待核实，不再误标「重连中…」）
          const stTail = !ss || ss.state === "Connected" ? "" : ` · ${stateLabel(ss.state).text}`;
          e.tagLabel.textContent = (ss?.host_name ?? s.slice(0, 12)) + stTail;
          if (s === sidRef.current) e.el.classList.add("pane-focused");
          syncSplitPaneButtons(e, s, sp);
        }
      } else if (s === sidRef.current) {
        e.el.classList.add("active");
      }
    }
    // 组切换时把该组自己的占比写回 CSS（无组=0.5）；分割条 aria 同步。
    // 拖拽中不重置：state feed/切组触发的 applyPanes 会把逐帧 live frac 打回旧值
    if (!splitDragRef.current) applySplitFrac(sp);
    // tmux 面板格子：显示与几何随同一时机重算（切会话/进出分屏/快照变化）
    layoutTmuxPanes();
  }, [layoutTmuxPanes, groupOf, applySplitFrac, syncSplitPaneButtons]);

  // 分屏名牌跟随主机名：会话列表变化（新建/改名）后重刷，防新建会话名牌暂显 sid
  const applyPanesRef = useRef<() => void>(() => {});
  applyPanesRef.current = applyPanes;

  // §185 宽度退化（分屏⑥轮起按方向取度量）：左右双格各 <360 宽、上下双格各 <190 高
  // 即退化单窗格（恢复带 6px 迟滞防阈值抖动；竖排底限更宽松——行少尚可滚动，
  // 列太窄必折行）。最大化态不退化（单格全幅没有宽度问题）
  const checkSplitWidth = useCallback(() => {
    const el = termRef.current;
    if (!el) return;
    // 改名期间布局被临时还原（最大化/退化都撤下）：此处不重估，否则窄窗
    // 立即退化，分割条与输入框一起消失（blur 还会把半截文本提交掉）
    if (groupRenamingGidRef.current) return;
    const sp = groupOf(sidRef.current);
    const tb = sp?.dir === "tb";
    const m = tb ? el.clientHeight : el.clientWidth;
    const below = tb ? SPLIT_DEGRADE_BELOW_H : SPLIT_DEGRADE_BELOW;
    const recover = tb ? SPLIT_RECOVER_AT_H : SPLIT_RECOVER_AT;
    const next = !!sp && !sp.maximized && (splitDegradedRef.current ? m < recover : m < below);
    if (next !== splitDegradedRef.current) {
      splitDegradedRef.current = next;
      setSplitDegraded(next);
      if (next && !splitHintDismissedRef.current) setSplitHintOpen(true);
      applyPanes();
      fitTerminal();
    }
  }, [applyPanes, fitTerminal, groupOf]);
  const checkSplitWidthRef = useRef<() => void>(() => {});
  checkSplitWidthRef.current = checkSplitWidth;

  // 分割条拖拽（分屏⑥轮，补齐 Windows Terminal/iTerm2/tmux 的基本习惯）：主格占比
  // 0.2~0.8 夹取（任一侧都不小于可读下限），pointer capture 全程跟手；拖动中每 150ms
  // 校准一次 PTY 几何，松手才把占比提交到当前组。双击复位对半；Esc 取消回原值。
  const splitDragRef = useRef<{
    gid: string; dir: SplitDir; startFrac: number; startPt: number;
    total: number; lastFit: number; pointerId: number;
  } | null>(null);
  const onDivDown = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    const mount = termRef.current;
    const g = groupOf(sidRef.current);
    if (!mount || !g) return;
    const r = mount.getBoundingClientRect();
    e.currentTarget.setPointerCapture(e.pointerId);
    splitDragRef.current = {
      gid: g.id,
      dir: g.dir,
      startFrac: g.frac,
      startPt: g.dir === "tb" ? e.clientY : e.clientX,
      total: g.dir === "tb" ? r.height : r.width,
      lastFit: 0,
      pointerId: e.pointerId,
    };
    document.body.classList.add("split-dragging", g.dir === "tb" ? "split-drag-tb" : "split-drag-lr");
  }, [groupOf]);
  const onDivMove = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    const dg = splitDragRef.current;
    if (!dg || dg.pointerId !== e.pointerId || !(e.buttons & 1)) return;
    const pt = dg.dir === "tb" ? e.clientY : e.clientX;
    const frac = Math.min(SPLIT_FRAC_MAX, Math.max(SPLIT_FRAC_MIN, dg.startFrac + (pt - dg.startPt) / dg.total));
    if (frac !== splitFracRef.current) applySplitFrac(frac);
    const now = performance.now();
    if (now - dg.lastFit > 150) { dg.lastFit = now; fitTerminal(); }
  }, [applySplitFrac, fitTerminal]);
  // 结束拖拽：restore=true（Esc）=回到按下时的占比；否则提交当前值到组
  const endDivDrag = useCallback((restore = false, pointerId?: number) => {
    const dg = splitDragRef.current;
    if (!dg) return;
    // 第二根手指/另一指针抬起不能结束本次拖拽
    if (pointerId !== undefined && dg.pointerId !== pointerId) return;
    splitDragRef.current = null;
    document.body.classList.remove("split-dragging", "split-drag-lr", "split-drag-tb");
    const frac = restore ? dg.startFrac : splitFracRef.current;
    patchGroup(dg.gid, { frac });
    // 拖动期间可能已切到别的组：CSS 只回写活动组，别把旧组占比画到新组上
    applySplitFrac(groupOf(sidRef.current)?.id === dg.gid ? frac : undefined);
    fitTerminal();
  }, [patchGroup, applySplitFrac, fitTerminal, groupOf]);
  const onDivUp = useCallback((e: ReactPointerEvent<HTMLDivElement>) => endDivDrag(false, e.pointerId), [endDivDrag]);
  const onDivCancel = useCallback((e: ReactPointerEvent<HTMLDivElement>) => endDivDrag(false, e.pointerId), [endDivDrag]);
  const onDivLostCapture = useCallback((e: ReactPointerEvent<HTMLDivElement>) => endDivDrag(false, e.pointerId), [endDivDrag]);
  // Esc 取消分割条拖拽：恢复到按下时的占比（捕获阶段拦下，不关别的浮层）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || !splitDragRef.current) return;
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      endDivDrag(true);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [endDivDrag]);
  const resetSplitFrac = useCallback(() => {
    const g = groupOf(sidRef.current);
    if (!g) return;
    patchGroup(g.id, { frac: 0.5 });
    applySplitFrac(0.5);
    fitTerminal();
  }, [groupOf, patchGroup, applySplitFrac, fitTerminal]);
  // 键盘微调：delta=±0.02/±0.10；absolute 用于 Home/End
  const nudgeSplitFrac = useCallback((delta: number, absolute?: number) => {
    const g = groupOf(sidRef.current);
    if (!g) return;
    const next = Math.min(SPLIT_FRAC_MAX, Math.max(SPLIT_FRAC_MIN, absolute ?? g.frac + delta));
    if (Math.abs(next - g.frac) < 1e-6) return;
    patchGroup(g.id, { frac: next });
    applySplitFrac(next);
    fitTerminal();
  }, [groupOf, patchGroup, applySplitFrac, fitTerminal]);

  // 聚焦某会话（点标签/点 pane/⌘1-9 共用）：只挪焦点不动布局——分屏时点右 pane
  // 不会把终端内容左右对调。rev-r21 M1：应用内导航推进焦点代际（§6.3——慢建连
  // 期间切到别的会话，完成时不得抢回视图）
  const focusSession = useCallback((target: string) => {
    focusGenRef.current++;
    const entry = termsRef.current.get(target);
    if (!entry) return;
    // 最大化的是另一格时点它的标签：先还原两格。否则目标格仍是 display:none，
    // 标签高亮换了、屏幕没换，focus() 落不到可见终端上（键入无落点）。
    const g = groupOf(target);
    if (g) groupFocusRef.current.set(g.id, target);
    if (g?.maximized && (g.maximized === "main" ? g.main : g.second) !== target) {
      patchGroup(g.id, { maximized: null });
    }
    if (sidRef.current !== target) {
      setSid(target);
      sidRef.current = target;
      xtermRef.current = entry.term;
      refreshBrief(target);
      // 先按目标组的方向重估退化态（上一组的退化态不能带过来），再同步显示类
      checkSplitWidthRef.current();
      applyPanes();
    }
    // 恢复该标签上次落焦的子窗口（用户反馈：切走再切回总是回第一个/主视图）。
    const restored = focusTermFor(target);
    void invoke("note_terminal", { sid: target, focused: true, paneId: restored?.paneId ?? null }).catch(() => {});
  }, [applyPanes, refreshBrief, focusTermFor, groupOf, patchGroup]);

  // 点到哪个 pane 就聚焦哪个会话（事件委托挂在 #term 上，覆盖单 pane 与分屏）
  useEffect(() => {
    const mount = termRef.current;
    if (!mount) return;
    const onDown = (ev: MouseEvent) => {
      const pane = (ev.target as HTMLElement).closest?.(".term-session") as HTMLElement | null;
      const target = pane?.dataset.sid;
      if (target) {
        // 点主视图本身 = 明确选择主视图，别让上一次格子记忆把焦点抢回去
        paneLastFocusRef.current.set(target, "main");
        focusSession(target);
      }
    };
    mount.addEventListener("mousedown", onDown);
    return () => mount.removeEventListener("mousedown", onDown);
  }, [focusSession]);

  // 确保会话有终端实例并完成输出订阅（attachSession 与进入分屏共用；
  // MCP 建的会话可能从未被人类 attach 过，进分屏前也要先建）
  const ensureSessionTerm = useCallback(async (sessionSid: string): Promise<boolean> => {
    // 返回「本次是否新建了 term」：只有新建才可能发生 fit 缩行 reflow（毁损态），
    // realign 只对新建执行——纯焦点切换复用既有实例，强制对齐会拽走用户滚动位
    if (!termRef.current || termsRef.current.has(sessionSid)) return false;
    const made = makeTerm(sessionSid);
    if (!made) return false;
    termsRef.current.set(sessionSid, made);
    // 首渲染前把几何对齐到位（term + 核心 PTY 一次到位）：检查点直接按目标尺寸
    // 渲染，attach 后不再发生「已渲染内容」的重排——消灭登录横幅被 SIGWINCH 提示符
    // 重绘 + xterm/alacritty 双侧重排打碎的窗口（Windows 上每次登录复现的横幅错位；
    // R11「跨 resize 重放漂移」的可视形态：create_session 不带尺寸，PTY 以默认
    // 120×32 启动，attach 时的 resize 撞上仍在流式输出的 MOTD）。渲染器未就绪则
    // 短暂轮询；超时放弃走旧路径（订阅后由 fitTerminal 兜底，行为同旧版）。
      // 量常驻容器 #term 而非 .term-session：后者要等 focusSession 加 .active 才可见
      // （display:none 时 clientWidth=0），而激活后它铺满同一盒子，尺寸相同。
      // #term 自身无 padding，留白在 .term-session 上——padding 按会话层元素扣（padEl）
      const fitBox = termRef.current;
      for (let i = 0; i < 8; i++) {
        // 容器尚未布局（display:none / 首帧）：不按 0 尺寸对齐（会被钳到 20×6），
        // 直接走旧路径——订阅后由 fitTerminal 兜底
        if (!fitBox || fitBox.clientWidth < 60 || fitBox.clientHeight < 60) break;
        const dims = fitDimsOf(made.term, fitBox, made.el);
      if (dims) {
        if (made.term.cols !== dims.cols || made.term.rows !== dims.rows) {
          made.term.resize(dims.cols, dims.rows);
          // 等核心 resize 完成再订阅：之后检查点即目标几何；SIGWINCH 触发的提示符
          // 重绘字节要么已进检查点网格、要么按序落在网格光标处，不再有重排错位
          await invoke("resize", { sid: sessionSid, cols: dims.cols, rows: dims.rows }).catch(() => {});
        }
        break;
      }
      await new Promise((r) => setTimeout(r, 90));
    }
    // 输出订阅（每会话仅一次，C10）：subscribe 返回 {subscription_id, checkpoint,
    // start_seq}；检查点应用前的早到帧由 feed 暂存，应用后按序消费 seq > start_seq。
    const term = made.term;
    const feed = createOutputFeed({ term, sid: sessionSid });
    made.feed = feed;
    const channel = MkChannel() as { onmessage?: (msg: unknown) => void };
    channel.onmessage = (msg) => feed.onMessage(msg);
    // 先注册通道、后调 subscribe：注册起核心即缓存 live，检查点前的早到帧不丢
    let attach: Parameters<typeof feed.begin>[0];
    try {
      attach = await invoke("subscribe_output", { sid: sessionSid, onEvent: channel });
    } catch (err) {
      // 订阅失败自愈（审计 F1）：termsRef 已在本函数头部登记——不撤销的话后续
      // 重试在 has() 处早退，会话标签永远静默（黑屏无输出、无自愈入口）
      termsRef.current.delete(sessionSid);
      made.feed = null;
      try { made.term.dispose(); } catch { /* 已销毁则忽略 */ }
      made.el.remove();
      throw err;
    }
    feed.begin(attach);
    subscribedRef.current.add(sessionSid);
    // 首次接入提示改为不占终端行的悬浮条（自动淡出）：写进终端流会把 shell 的
    // 光标视角带偏——后续远端输出全部接在提示语之后渲染。
    setAttachHint(true);
    window.setTimeout(() => setAttachHint(false), 6000);
    return true;
  }, [makeTerm, fitDimsOf]);

  const attachSession = useCallback(async (newSid: string) => {
    // rev-r21 M1：attach 亦属用户导航（标签点击/完成落定共用入口）——推进焦点代际。
    // createSession 完成检查先于调用本函数，此处推进只影响后续完成者（并发双完成
    // 第二个自动转后台 toast，更合 §6.3）
    focusGenRef.current++;
    if (!termRef.current) return;
    const fresh = await ensureSessionTerm(newSid);
    // 每标签独立分屏：点标签只切「当前显示哪一组」，绝不替换任何窗格；
    // 目标会话属于哪组就显示哪组，不属于任何组就显示单窗格。
    focusSession(newSid);
    fitTerminal();
    // R3-C-1：checkpoint 按核心网格写入（预对齐量的是接入前 #term——欢迎页下无
    // 会话工具条，比激活态高约 68px≈3-4 行；且写入与 attach 链的 fit 存在竞速），
    // 后续 fit 缩行时 xterm 固定光标的视口相对位、把顶部内容推进 scrollback——
    // 光标悬到空区、视口停在空行段（矮窗口接入整屏空白、1366×768 首行卷出的根因）。
    // fit 收敛后对齐：视口滚到最后一个非空行（scrollToLine 钳到 scrollback 底——
    // 正常场景=滚底 no-op，毁损场景=对齐回内容尾）；光标悬在内容尾之下的空区时
    // 写绝对定位序列送回内容尾行尾，与核心 PTY 光标语义重新对齐（回显从提示符
    // 后继续而非悬空处）。400/700ms 补拍覆盖 350ms 二次 fit 的缩行与迟到的回放帧。
    // 行号口径（找茬四轮 C1，P1）：光标位置按**缓冲绝对行**（baseY+cursorY）度量
    // ——viewportY 随滚动位浮动，旧代码混算会在 scrollToLine 平滑滚动半途测错、
    // CUP 又写死「tail+1」当视口行（tail 是绝对行号），两拍全部空放：1366×768
    // 下检查点（32 行）按接入前高度预对齐、attach 后工具条压矮缩行 reflow 把
    // 光标钉在垫行，回显脱离提示符两行。CUP 是视口相对行，写时按 ydisp 现算。
    const realignAfterFit = () => {
      const term = termsRef.current.get(newSid)?.term;
      if (!term) return;
      const b = term.buffer.active;
      if (b.length === 0) return;
      let tail = b.length - 1;
      while (tail > 0 && !(b.getLine(tail)?.translateToString(true) ?? "").trim()) tail--;
      // 最小滚动：内容尾恰好入视口即可（scrollToLine 内部钳 scrollback 底——
      // 正常场景=滚底 no-op，毁损场景=整段内容回到可视区）
      term.scrollToLine(Math.max(0, tail - term.rows + 1));
      const cursorAbs = b.baseY + b.cursorY;
      if (cursorAbs > tail) {
        const curLine = b.getLine(cursorAbs);
        if (!curLine || !curLine.translateToString(true).trim()) {
          // 光标悬在内容尾之下的空区（缩行 reflow 所致）——送回内容尾行尾，
          // 与核心 PTY 光标语义重新对齐（后续回显从提示符后继续而非悬空处）
          const line = b.getLine(tail);
          const col = line ? line.translateToString(true).length : 0;
          const row = Math.max(1, tail - b.viewportY + 1);
          term.write(`\x1b[${row};${col + 1}H`);
        }
      }
      // 滚动/光标归位后渲染层可能滞留旧 scroll 锚（内容行不重绘、光标按旧位
      // 画）——整屏标脏强制重绘（幂等，正常场景无副作用）
      term.refresh(0, term.rows - 1);
    };
    // 门控（复审轮 P1）：realign 只对本次新建的 term 执行——fit 缩行 reflow 只
    // 发生在「检查点按接入前高度预对齐 + attach 后工具条压矮」的新建路径；焦点
    // 切换/重连复用实例（rows 未变、无 reflow），强制对齐会把用户上翻的阅读位
    // 拽回内容尾（R3-C-1 修复引入的回归，此处收口）
    if (fresh) {
      realignAfterFit();
      setTimeout(realignAfterFit, 400);
      setTimeout(realignAfterFit, 700);
    }
    // 布局与字体稳定后再校准一次（首次 fit 可能撞上渲染器尺寸未就绪）
    setTimeout(() => void fitTerminal(), 350);
  }, [ensureSessionTerm, focusSession, fitTerminal]);

  // 无激活会话：隐藏所有会话终端（实例保留，点击左侧会话即恢复），显示欢迎页
  const detach = useCallback(() => {
    commitSplitGroups([]);
    setGroupRenaming(null);
    setGroupRenamingGid(null);
    groupRenamingGidRef.current = null;
    setSid(null);
    sidRef.current = null;
    xtermRef.current = null;
    setBrief(null);
    void invoke("note_terminal", { sid: null, focused: false }).catch(() => {});
    for (const [, e] of termsRef.current) {
      e.el.classList.remove("active", "pane-left", "pane-right", "pane-top", "pane-bottom",
        "pane-focused", "pane-hidden", "pane-max");
    }
  }, [commitSplitGroups]);

  // 进入/调整分屏：把 target 放到副 pane（主 pane 与焦点不动）。dir 缺省沿用记住的
  // 上次方向（splitDirRef）。活动会话已有组时：target 是成员=同向 no-op/异向旋转；
  // 屏外 target=先溶解它自己的组，再替换副 pane。活动会话无组时新建组。
  const enterSplitWith = useCallback(async (target: string, dir?: SplitDir) => {
    const d = dir ?? splitDirRef.current;
    splitDirRef.current = d;
    setSplitDir(d);
    const g = groupOf(sidRef.current);
    const movedFrom = g && target !== g.main && target !== g.second
      ? detachFromAllGroups(target)
      : null;
    if (movedFrom) {
      const label = sessionsRef.current.find((x) => x.id === target)?.host_name ?? target.slice(0, 8);
      pushToast("info", t("已从原分屏移出 {0}，原分屏已解散", label));
    }
    if (g) {
      if (target === g.main || target === g.second) {
        if (d === g.dir) return; // 同向且成员不变：无操作
        patchGroup(g.id, { dir: d });
      } else {
        // 替换「另一格」：活动会话始终留在自己的槽位（焦点在副格时替换主格，
        // 否则被替换的正是当前会话，组还在但视图退回单窗格、看起来毫无反应）
        const focusSlot = sidRef.current === g.second ? "second" : "main";
        const otherSlot = focusSlot === "main" ? "second" : "main";
        const patch: Partial<Omit<SplitGroup, "id">> =
          otherSlot === "main" ? { main: target } : { second: target };
        // 显式方向（菜单里的左右/上下）要写进组；无参调用保持该组既有方向
        if (dir) patch.dir = d;
        // 最大化时被替换的可能是隐藏格：还原两格，让替换结果看得见
        if (g.maximized) patch.maximized = null;
        patchGroup(g.id, patch);
      }
    } else {
      if (!sidRef.current || target === sidRef.current) return;
      if (!createGroup(sidRef.current, target, d)) return;
    }
    await ensureSessionTerm(target);
    applySplitFrac();
    applyPanes();
    fitTerminal();
    checkSplitWidthRef.current();
    setTimeout(() => void fitTerminal(), 150);
    // 工具栏点击会把焦点留在按钮上——把焦点送回终端，打字不中断
    if (sidRef.current) focusSession(sidRef.current);
  }, [ensureSessionTerm, applySplitFrac, applyPanes, fitTerminal, focusSession,
    groupOf, detachFromAllGroups, patchGroup, createGroup]);

  // 退出分屏：只解散指定组（缺省=活动组），所有标签保留；活动组解散后幸存会话
  // 继续以单窗格显示，其它组不受影响。
  const exitSplit = useCallback((gid?: string) => {
    const g = gid ? groupById(gid) : groupOf(sidRef.current);
    if (!g) return;
    const wasActive = g.main === sidRef.current || g.second === sidRef.current;
    if (groupRenamingGidRef.current === g.id) {
      setGroupRenaming(null);
      setGroupRenamingGid(null);
      groupRenamingGidRef.current = null;
    }
    dissolveGroup(g.id);
    if (!wasActive) return;
    splitDegradedRef.current = false;
    setSplitDegraded(false);
    applyPanes();
    fitTerminal();
    checkSplitWidthRef.current();
    setTimeout(() => void fitTerminal(), 150);
    if (sidRef.current) focusSession(sidRef.current);
  }, [groupById, groupOf, dissolveGroup, applyPanes, fitTerminal, focusSession]);

  // 旋转指定组（右键菜单按被右键标签的组操作；可能是非活动组）
  const rotateSplitGroup = useCallback((gid: string, dir: SplitDir) => {
    const g = groupById(gid);
    if (!g || g.dir === dir) return;
    const active = g.main === sidRef.current || g.second === sidRef.current;
    // 全局方向记忆只代表活动组：旋转后台组不应劫持活动组的「分屏方向」选择器
    if (active) {
      splitDirRef.current = dir;
      setSplitDir(dir);
    }
    patchGroup(gid, { dir });
    if (active) {
      applySplitFrac();
      applyPanes();
      fitTerminal();
      checkSplitWidthRef.current();
      setTimeout(() => void fitTerminal(), 150);
    }
  }, [groupById, patchGroup, applySplitFrac, applyPanes, fitTerminal]);

  // 窗格按钮：最大化/还原（按槽位）、交换两格、退出本组（命令式 DOM 经 ref 调用）
  const toggleSplitMax = useCallback((sessionSid: string) => {
    const g = groupOf(sessionSid);
    if (!g) return;
    // 点到非活动格的控制钮（鼠标或键盘 Tab 到达）：先把该格变成活动会话，
    // 否则最大化把另一格藏起来后，焦点/标签高亮还留在隐藏终端上。
    if (sidRef.current !== sessionSid) focusSession(sessionSid);
    const slot = slotOf(g, sessionSid);
    if (!slot) return;
    const next = g.maximized === slot ? null : slot;
    patchGroup(g.id, { maximized: next });
    // 最大化没有退化问题；还原后由 checkSplitWidth 重新按宽度判定
    splitDegradedRef.current = false;
    setSplitDegraded(false);
    applyPanes();
    fitTerminal();
    checkSplitWidthRef.current();
    requestAnimationFrame(() => focusTermForRef.current(sessionSid));
    setTimeout(() => { fitTerminal(); focusTermForRef.current(sessionSid); }, 150);
  }, [groupOf, patchGroup, applyPanes, fitTerminal, focusSession]);

  const swapSplit = useCallback((sessionSid: string) => {
    const g = groupOf(sessionSid);
    if (!g) return;
    // 交换也是一种「指向该格」的操作：非活动格先激活，交换后焦点仍跟着这个会话。
    if (sidRef.current !== sessionSid) focusSession(sessionSid);
    // 最大化槽位跟着会话走：只换 main/second 会让被聚焦会话落进 pane-hidden，
    // 全屏换成另一格、焦点却指向隐藏终端（键入无落点）
    const maximized = g.maximized === "main" ? "second" : g.maximized === "second" ? "main" : null;
    patchGroup(g.id, { main: g.second, second: g.main, maximized });
    applyPanes();
    fitTerminal();
    setTimeout(() => {
      fitTerminal();
      focusTermForRef.current(sessionSid);
    }, 150);
  }, [groupOf, patchGroup, applyPanes, fitTerminal, focusSession]);

  splitPaneActionRef.current = {
    toggleMax: toggleSplitMax,
    swap: swapSplit,
    exit: (sessionSid: string) => {
      const g = groupOf(sessionSid);
      if (g) exitSplit(g.id);
    },
  };

  // 拖拽组合分屏（标签拖到终端区松手）：把 target 放到指定槽位（main=左/上，
  // second=右/下）。与 enterSplitWith 的差别：主格槽允许「被拖者当主格」（原焦点
  // 退副格），且落点格拿焦点——拖放是指向动作，焦点跟手。已分屏时落到另一格=
  // 替换（被拖者本在屏内即交换两格），落到自己格由调用方无操作。dir 仅建屏时生效。
  const placeInSplit = useCallback(async (target: string, slot: "main" | "second", dir?: SplitDir) => {
    const g = groupOf(sidRef.current);
    if (!g) {
      const focus = sidRef.current;
      if (!focus || focus === target) return; // 单会话无可组合对象
      const d = dir ?? splitDirRef.current;
      splitDirRef.current = d;
      setSplitDir(d);
      // 目标来自另一组时其原组同样解散——与「有组」分支同款如实提示
      const movedFrom = detachFromAllGroups(target);
      if (movedFrom) {
        const label = sessionsRef.current.find((x) => x.id === target)?.host_name ?? target.slice(0, 8);
        pushToast("info", t("已从原分屏移出 {0}，原分屏已解散", label));
      }
      const main = slot === "main" ? target : focus;
      const second = slot === "main" ? focus : target;
      if (!createGroup(main, second, d)) return;
    } else if (target === g.main || target === g.second) {
      if ((slot === "main") === (target === g.main)) return; // 落到自己所在格
      const maximized = g.maximized === "main" ? "second" : g.maximized === "second" ? "main" : null;
      patchGroup(g.id, { main: g.second, second: g.main, maximized }); // 交换两格
    } else {
      const movedFrom = detachFromAllGroups(target);
      if (movedFrom) {
        const label = sessionsRef.current.find((x) => x.id === target)?.host_name ?? target.slice(0, 8);
        pushToast("info", t("已从原分屏移出 {0}，原分屏已解散", label));
      }
      patchGroup(g.id, slot === "main" ? { main: target } : { second: target });
    }
    focusGenRef.current++; // 拖放同属用户导航（rev-r21 M1 焦点代际）
    await ensureSessionTerm(target);
    applySplitFrac();
    applyPanes();
    fitTerminal();
    checkSplitWidthRef.current();
    setTimeout(() => void fitTerminal(), 150);
    focusSession(target);
  }, [ensureSessionTerm, applySplitFrac, applyPanes, fitTerminal, focusSession,
    groupOf, detachFromAllGroups, patchGroup, createGroup]);

  // 拖拽组合分屏：指针命中的分屏格（已分屏时提示与落格都按真实窗格几何，不做死象限）。
  // 两格矩形贴合处（分割条覆盖的缝）按主格优先；最大化时另一格 display:none，矩形
  // 为 0 不会命中，自然落到可见格。
  const paneAtPoint = (x: number, y: number): "main" | "second" => {
    const sp = groupOf(sidRef.current);
    if (sp && termRef.current) {
      // 退化态只剩焦点窗格可见，pane-* 类已撤（矩形不可命中）：落格取「另一格」，
      // 保持当前看的会话不被替换；默认 main 会在焦点为副格时悄悄换掉隐藏主格。
      if (splitDegradedRef.current) {
        return sidRef.current === sp.second ? "main" : "second";
      }
      for (const slot of ["main", "second"] as const) {
        const el = termRef.current.querySelector(sp.dir === "tb"
          ? (slot === "main" ? ".pane-top" : ".pane-bottom")
          : (slot === "main" ? ".pane-left" : ".pane-right"));
        const r = el?.getBoundingClientRect();
        if (r && r.width > 0 && r.height > 0
          && x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return slot;
      }
    }
    return "main";
  };

  // 标签拖拽命中：指针下的目标条目（纵向 band 判定在调用方）；横向 ±3px 容差吃药丸缝隙。
  // 身份用 data-key（组标签=整体），data-sid 只是组标签的焦点成员，不能拿来判定来源。
  const tabAtPoint = (x: number, y: number): { key: string; before: boolean } | null => {
    for (const el of document.querySelectorAll(".tab")) {
      const r = el.getBoundingClientRect();
      if (y < r.top || y > r.bottom || x < r.left - 3 || x > r.right + 3) continue;
      const key = (el as HTMLElement).dataset.key;
      if (!key) continue;
      return { key, before: x < r.left + r.width / 2 };
    }
    return null;
  };

  // 拖拽松手裁决（一组一标签）：标签条内=按条目重排（组标签整体移动）；终端区=
  // 仅独立会话可建屏/换格，组标签拖进终端区无操作（成员没有自己的标签可拆）。
  const finishTabDrag = (drag: { key: string; sid: string }, x: number, y: number) => {
    const bar = tabbarRef.current?.getBoundingClientRect();
    const inStrip = !!bar && x >= bar.left && x <= bar.right && y >= bar.top && y <= bar.bottom;
    const tr = termRef.current?.getBoundingClientRect();
    const inTerm = !!tr && x >= tr.left && x <= tr.right && y >= tr.top && y <= tr.bottom;
    if (inStrip) {
      const hit = tabAtPoint(x, y);
      if (!hit || hit.key === drag.key) return; // 拖回自己的标签：无操作
      reorderTabEntries(drag.key, hit.key, hit.before);
      return;
    }
    if (drag.key.startsWith("g:")) return; // 组标签是工作区整体，不能落进终端区
    if (inTerm && sessionsRef.current.length >= 2 && tr) {
      const from = drag.sid;
      // 拖活动会话本身且无组：没有可组合对象（placeInSplit 的自我保护同款）
      if (from === sidRef.current && !groupOf(from)) return;
      const sp = groupOf(sidRef.current);
      let slot: "main" | "second";
      let dir: SplitDir | undefined;
      if (sp) {
        slot = paneAtPoint(x, y);
      } else {
        const dx = (x - (tr.left + tr.width / 2)) / tr.width;
        const dy = (y - (tr.top + tr.height / 2)) / tr.height;
        const horiz = Math.abs(dx) > Math.abs(dy);
        slot = (horiz ? dx < 0 : dy < 0) ? "main" : "second";
        dir = horiz ? "lr" : "tb";
      }
      void placeInSplit(from, slot, dir);
    }
  };

  // 关闭会话（标签 ×/⌘W/工具菜单共用，§6.4 统一「关闭会话」语义）：核心确认关闭
  // 后才 dispose；失败保留标签、画面与重试入口（§337）
  const disconnectSid = useCallback(async (id: string) => {
    let refocus = false;
    try {
      await invoke("close_session", { sid: id });
    } catch (e) {
      setConnError({ title: t("关闭会话失败"), detail: errMsg(e) + t("——标签与画面保留，可再次关闭重试") });
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
      paneLastFocusRef.current.delete(id);
      scrollbackWarnRef.current.delete(id);
      if (paneZoomRef.current?.sid === id) paneZoomRef.current = null;
    }
    // 只解散被关会话所在的那一组；幸存者回单窗格。其它组完全不受影响。
    const g = groupOf(id);
    if (g) {
      if (groupRenamingGidRef.current === g.id) {
        setGroupRenaming(null);
        setGroupRenamingGid(null);
        groupRenamingGidRef.current = null;
      }
      dissolveGroup(g.id);
      if (sidRef.current === id) {
        const survivor = g.main === id ? g.second : g.main;
        if (termsRef.current.has(survivor)) {
          // 走 focusSession 的统一激活语义（重估退化态、applyPanes、恢复子窗口记忆）：
          // 组已解散，原最大化态随组消失，不会留下指向隐藏格的焦点。
          focusSession(survivor);
          refocus = true;
        } else {
          detach();
        }
      }
    } else if (sidRef.current === id) {
      // 关的是焦点会话：激活右侧邻居、没有再找左侧（浏览器标签页惯例；六轮 D6-2
      // 此前恒落数组首个有 term 的=关中/右标签都跳最左）。termsRef 门控保留
      // （从未接入的标签没有实例，不算「还开着的会话」）。
      const order = sessionsRef.current;
      const idx = order.findIndex((s) => s.id === id);
      let next: (typeof order)[number] | undefined;
      for (let i = idx + 1; i < order.length && !next; i++) {
        if (order[i].id !== id && termsRef.current.has(order[i].id)) next = order[i];
      }
      for (let i = Math.min(idx, order.length) - 1; i >= 0 && !next; i--) {
        if (order[i].id !== id && termsRef.current.has(order[i].id)) next = order[i];
      }
      if (next) {
        // 同库激活语义：目标可能属于别的分屏组（多组共存），直接写 sid 会带着
        // 上一组的退化/最大化显示态过去。
        focusSession(next.id);
        refocus = true;
      } else {
        detach();
      }
    }
    applyPanes();
    fitTerminal();
    // 关掉活动标签后浏览器的焦点随被删元素落到 body——不还焦点的话下一次键盘
    // 输入进不了任何终端（用户必须先用鼠标点一下）。布局落定后再聚焦新活动会话，
    // 并按该标签的记忆恢复主视图/格子。
    if (refocus && sidRef.current) requestAnimationFrame(() => focusTermFor(sidRef.current!));
    refreshLists();
  }, [detach, applyPanes, fitTerminal, refreshLists, focusTermFor,
    groupOf, dissolveGroup, focusSession]);

  // 稳定轮：termsRef 对账——会话从后端消失（Agent 经 MCP close_session 等 UI 外
  // 关闭路径）时标签随 3s 轮询消失，但 xterm/WebGL 上下文/订阅/DOM 无人释放
  // （WebGL 上下文浏览器上限 ~16 个，只涨不跌直到新终端建不出渲染器）。守卫：
  // sessionIdent 只增不删且仅在轮询见过该 sid 后才有——刚建连还没进轮询的新会话
  // 不会被误杀。分屏成员被外部关闭则退分屏、焦点自动落存活会话（同款语义）。
  useEffect(() => {
    const alive = new Set(sessions.map((s) => s.id));
    const dead: string[] = [];
    for (const [id, entry] of [...termsRef.current]) {
      if (alive.has(id) || !sessionIdent.has(id)) continue;
      entry.feed?.dispose();
      entry.term.dispose();
      entry.el.remove();
      termsRef.current.delete(id);
      subscribedRef.current.delete(id);
      paneLastFocusRef.current.delete(id);
      if (paneZoomRef.current?.sid === id) paneZoomRef.current = null;
      dead.push(id);
    }
    if (!dead.length) return;
    const deadSet = new Set(dead);
    // 任何成员死亡 → 该组解散；幸存者（若也还活着）优先接管焦点
    const affected = splitGroupsRef.current.filter((g) => deadSet.has(g.main) || deadSet.has(g.second));
    const survivor = affected.flatMap((g) => [g.main, g.second]).find((id) => !deadSet.has(id)) ?? null;
    if (groupRenamingGidRef.current && affected.some((g) => g.id === groupRenamingGidRef.current)) {
      setGroupRenaming(null);
      setGroupRenamingGid(null);
      groupRenamingGidRef.current = null;
    }
    pruneGroups(deadSet);
    if (sidRef.current && deadSet.has(sidRef.current)) {
      const nextId = survivor && termsRef.current.has(survivor)
        ? survivor
        : sessionsRef.current.find((s) => !deadSet.has(s.id) && termsRef.current.has(s.id))?.id;
      // 幸存会话可能与其它活着的会话共组（多组共存）：按统一激活语义切换，
      // 顺带重估退化态并恢复该标签的子窗口焦点记忆。
      if (nextId && termsRef.current.has(nextId)) focusSession(nextId);
      else detach();
    }
    applyPanes();
    fitTerminal();
  }, [sessions, sessionIdent, detach, applyPanes, fitTerminal, focusSession, pruneGroups]);

  // 危险动作确认（P1-5/P1-4）：断开活会话、删除主机都先过弹层；死会话直接关（无需确认）
  const [confirm, setConfirm] = useState<
    { kind: "closeSession"; sid: string; hostName: string; paneCount: number } | { kind: "deleteHost"; id: string; name: string } | { kind: "deleteIdentity"; id: string; label: string } | null
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
  // R42（§6.7）首次委托/交还对话框的开合（其余状态与处理函数见委托段；此处仅为
  // 让下方 useDialogFocus 的 hook 序先于其处理函数声明而恒定）
  const [delegateDlg, setDelegateDlg] = useState(false);
  // §7.4 弹窗 focus trap（调用须在全部相关 state 声明之后；hook 序恒定）
  useDialogFocus(showSettings, settingsPanelRef);
  // R41 视觉复验 M2：草稿确认框消解时（「留下继续编辑」/「丢弃草稿并切换」）被点的按钮
  // 随之从 DOM 移除，焦点落回 body——`useDialogFocus` 的 keydown 挂在对话框上，此后 Tab
  // 不再冒泡到框内，陷阱失效、可 Tab 逃到背景。消解后把焦点收回框内（同干净打开的落点）。
  useEffect(() => {
    if (credDraftTo !== null) return;
    const box = settingsPanelRef.current;
    if (!showSettings || !box || box.contains(document.activeElement)) return;
    const first = Array.from(
      box.querySelectorAll<HTMLElement>("button, [href], input, select, textarea, [tabindex]:not([tabindex='-1'])"),
    ).filter((n) => !(n instanceof HTMLButtonElement && n.disabled) && n.offsetParent !== null)[0];
    first?.focus();
  }, [credDraftTo, showSettings]);
  useDialogFocus(!!detail || !!detailErr, detailPanelRef);
  useDialogFocus(confirm?.kind === "closeSession", closeConfirmRef);
  useDialogFocus(delegateDlg, delegateDlgRef);
  useDialogFocus(!!quitSummary, quitConfirmRef);
  useDialogFocus(confirm?.kind === "deleteHost", delHostRef);
  useDialogFocus(confirm?.kind === "deleteIdentity", delIdentRef);
  useDialogFocus(!!pasteConfirm, pasteConfirmRef);
  useDialogFocus(!!osc52Ask, osc52AskRef);
  useDialogFocus(!!pendingDrop, dropCardRef);
  useDialogFocus(hostKeyQueue.length > 0, hkDlgRef);
  useDialogFocus(authPromptQueue.length > 0, authDlgRef);
  useDialogFocus(showAddHost, addHostDlgRef);
  useDialogFocus(showQuickConnect, quickDlgRef);
  useEffect(() => {
    if (!inTauri) return;
    let alive = true;
    const un = tauriListen(
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
      }),
    );
    return () => { alive = false; un(); };
  }, [inTauri]);
  const [quitBusy, setQuitBusy] = useState(false);
  const quitBusyRef = useRef(false);
  const confirmQuit = async () => {
    if (!quitSummary || quitBusyRef.current) return;
    quitBusyRef.current = true;
    setQuitBusy(true);
    // 会话收口已下沉 quit_app（shutdown_all：close_session 同口径 + 卡住强制
    // 摘表的超时预算）——FE 逐个 close 曾可能被悬挂会话卡死在退出前一步。
    try { await invoke("quit_app"); } catch { /* demo 无此命令 */ }
    // 成功路径应用随即退出；失败/演示域到此复位，允许重试。
    quitBusyRef.current = false;
    setQuitBusy(false);
  };
  const cancelQuit = async () => {
    setQuitSummary(null);
    // 解除 Rust 侧关闭看护：用户只是犹豫，不是 webview 死亡（稳定轮兜底配套）
    try { await invoke("cancel_app_close"); } catch { /* demo 无此命令 */ }
  };
  // 模态层信号（R13 §7.3）：确认/指纹/双因素/退出汇总任一打开即 true——⌘ 组合全吞，Esc 交给浮层链。
  // 新建/快速连接（二轮拨壳成 hk-mask 全屏遮罩）与设置面板（pop-mask）同为遮罩模态，
  // 巡检补进列表：此前不在列——对话框开着 Ctrl+W/⌘1-9/F11 仍在遮罩后执行
  // （关标签/切标签/把窗口切全屏），Ctrl+T 还会把快速连接里已填的表单悄悄换成新建。
  const dialogModal = !!(paletteOpen || authPromptQueue.length > 0 || hostKeyQueue.length > 0 || confirm || quitSummary || pasteConfirm || osc52Ask || splitMenu || tmuxMenu || tabMenu || hostMenu || termMenu || recentMenu || pendingDrop || keyCapture
    || detail || detailErr || showAddHost || showQuickConnect || showSettings);
  const modal = !!(paletteOpen || authPromptQueue.length > 0 || hostKeyQueue.length > 0 || confirm || quitSummary || pasteConfirm || osc52Ask || splitMenu || tmuxMenu || tabMenu || hostMenu || termMenu || recentMenu || pendingDrop || keyCapture
    || detail || detailErr || showAddHost || showQuickConnect || showSettings
    // 大屏覆盖层与 tmux 墙是整幅视觉顶层：不收进模态门的话，Ctrl/⌘F 会在遮罩
    // 后面打开看不见的搜索框并抢焦，Ctrl/⌘W 还会在墙后面弹「关闭会话」确认。
    || monitorOpen || !!tmuxWallSid);
  modalRef.current = modal;
  dialogModalRef.current = dialogModal;

  // 键位录入（键位配置轮）：等待「按下新组合」期间吞掉一切键盘事件——Esc 取消、
  // lone modifier 等组合、其余组合校验后落表。capture 监听注册在两个既有监听之后，
  // 但它们都被模态门按住（resolveAction 模态返 null、直发层 modalRef 早退），此
  // 处理器是唯一消费者；preventDefault+stopImmediatePropagation 断掉 xterm 下传。
  useEffect(() => {
    if (!keyCapture) return;
    const onKey = (ev: KeyboardEvent) => {
      ev.preventDefault();
      ev.stopImmediatePropagation();
      if (ev.key === "Escape") { setKeyCapture(null); return; }
      const evb = bindingOf(ev, isMacPlatform());
      if (!evb) return; // lone modifier：等组合齐
      if (!evb.primary) { pushToast("err", t("快捷键需带 Ctrl（mac 为 ⌘）")); return; }
      if (evb.alt) { pushToast("err", t("Alt 组合暂不支持（终端里 Alt+字母 是 Meta 序列）")); return; }
      if (terminalReserved(evb, isMacPlatform())) {
        pushToast("err", t("{0} 留给终端（tmux 前缀键），请换一个组合", formatBinding(evb, false)));
        return;
      }
      const clash = conflictOf(keymapRef.current, keyCapture, evb);
      if (clash) {
        pushToast("err", t("与「{0}」冲突，先给后者换键", t(KEYMAP_ACTIONS.find((a) => a.id === clash)?.label ?? clash)));
        return;
      }
      const next = { ...keymapRef.current, [keyCapture]: evb };
      applyKeymap(next);
      persistSetting(KEYMAP_SETTING, JSON.stringify(next));
      pushToast("ok", t("已设为 {0}", formatBinding(evb, isMacPlatform())));
      setKeyCapture(null);
    };
    window.addEventListener("keydown", onKey, { capture: true });
    return () => window.removeEventListener("keydown", onKey, { capture: true });
  }, [keyCapture, applyKeymap, pushToast]);
  // 设置页单条「重置」：默认键已被别的动作改占 → 拒绝并说明（同录键器冲突口径）——
  // 不落出两条同键的表（动作分发只认先命中者，另一条静默失效，重载后还会被丢回默认）
  const resetKeyBinding = useCallback((id: KeyActionId) => {
    const def = defaultKeymap(isMacPlatform())[id];
    const clash = conflictOf(keymapRef.current, id, def);
    if (clash) {
      pushToast("err", t("与「{0}」冲突，先给后者换键", t(KEYMAP_ACTIONS.find((a) => a.id === clash)?.label ?? clash)));
      return;
    }
    const next = { ...keymapRef.current, [id]: def };
    applyKeymap(next);
    persistSetting(KEYMAP_SETTING, JSON.stringify(next));
  }, [applyKeymap, persistSetting, pushToast]);
  // §7.4：原生 Ctrl 拦截只在终端拥有焦点且无模态层时转发——模态打开即使终端仍持
  // DOM 焦点（弹层未 autofocus）也先停；关闭后按实际 DOM 焦点恢复上报。
  // 必须走 noteTerminalFocus 推导 pane_id：否则从 tmux 格子打开的确认/粘贴/OSC52
  // 卡关闭后 pane_id 被清空，macOS 原生 Ctrl+C 会改投主视图而不是当前格子。
  useEffect(() => {
    if (!inTauri) return;
    if (modal) {
      noteTerminalFocus(false);
      return;
    }
    const t = document.activeElement;
    if (t instanceof HTMLElement && t.classList.contains("xterm-helper-textarea")) {
      noteTerminalFocus(true, t);
    }
  }, [modal, inTauri, noteTerminalFocus]);
  const requestCloseSession = useCallback((s: SessionInfo) => {
    if (s.state === "Disconnected") { void disconnectSid(s.id); return; }
    setConfirm({ kind: "closeSession", sid: s.id, hostName: s.host_name, paneCount: s.panes?.length ?? 0 });
  }, [disconnectSid]);
  const deleteHost = async (id: string) => {
    try {
      await invoke("delete_host", { id });
      await refreshLists();
    } catch (e) {
      setConnError({ title: t("删除主机失败"), detail: friendlyError(e) });
    }
  };
  // 危险确认的在途守卫：慢后端/真实 SSH 下双击会重复 invoke，第二次在第一次成功
  // 后失败并弹「删除失败」，用户明明成功却以为出错。busy 期间二次点击直接丢弃。
  const [confirmBusy, setConfirmBusy] = useState(false);
  const confirmBusyRef = useRef(false);
  const confirmAction = async () => {
    if (!confirm || confirmBusyRef.current) return;
    confirmBusyRef.current = true;
    setConfirmBusy(true);
    try {
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
    } finally {
      confirmBusyRef.current = false;
      setConfirmBusy(false);
    }
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
  // Agent 接入状态在设置页开着时要跟着外部变化走：CLI 新签发的 Agent（帮助文案
  // 推荐 `tinyssh agent create`）此前要重启或手动关/开协作才出现在列表里，
  // 「已配置 1」与「暂无 Agent 接入」同屏打架、委托被误判未接入。
  useEffect(() => {
    if (!showSettings) return;
    let dead = false;
    const pull = () => {
      invoke("mcp_status")
        .then((v) => { if (!dead) setMcp(v); })
        .catch(() => { /* 面板继续用上一次投影 */ });
    };
    pull();
    const iv = window.setInterval(pull, 5000);
    return () => { dead = true; window.clearInterval(iv); };
  }, [showSettings]);

  // ⌘1–9 / ⌘W / ⌘⇧[] / Esc 已并入上方统一 action 分发（R13）

  // 查找执行统一入口（本轮）：非法正则时 addon 内部 new RegExp 会抛 SyntaxError——
  // 在此包住并转为输入框 aria-invalid +「正则无效」，绝不向 React 事件处理器外抛
  // （否则一次输入就把页面打崩）。清掉旧高亮与旧计数，避免界面与新查询自相矛盾。
  const runSearch = useCallback((query: string, dir: "next" | "prev" = "next") => {
    const addon = searchAddonRef.current;
    if (!addon) return;
    if (!query) {
      addon.clearDecorations();
      setSearchInvalid(false);
      return;
    }
    try {
      const opts = searchOptions(searchPrefsRef.current);
      if (dir === "prev") addon.findPrevious(query, opts);
      else addon.findNext(query, opts);
      setSearchInvalid(false);
    } catch {
      addon.clearDecorations();
      setSearchResults(null);
      setSearchInvalid(true);
    }
  }, []);

  // 切开关即重跑当前查询：addon 按 caseSensitive/regex/wholeWord 变化重算高亮与计数
  const toggleSearchPref = (key: keyof SearchPrefs) => {
    const next = { ...searchPrefsRef.current, [key]: !searchPrefsRef.current[key] };
    searchPrefsRef.current = next;
    setSearchPrefs(next);
    if (searchQuery) {
      // addon-search 0.16 的 findNext/findPrevious 先写 lastSearchOptions 再调
      // shouldUpdateHighlighting，选项变化永远比较不出去，高亮与计数会停在旧选项
      // （隔离复现：不区分大小写 3 处 → 切区分后仍报 3，实际选区已按新选项走）。
      // 先清掉缓存的查询词强制下一次查找全量重算；0.14 无此回归。
      try {
        searchAddonRef.current?.clearDecorations();
      } catch {
        /* addon 已释放 */
      }
      runSearch(searchQuery);
    } else setSearchInvalid(false);
  };

  // 打开搜索：目标跟随当前焦点——tmux 面板格聚焦则搜该格，否则主视图。
  // 右键菜单知道命中的 paneKey，直接传更可靠（焦点此时在菜单上）。
  const openSearch = useCallback((paneKey?: string) => {
    const owner = sidRef.current;
    if (!owner) return;
    const target = terminalFocusTarget(document.activeElement, owner);
    const key = paneKey
      ?? (target.paneId != null ? `${target.sid}:${target.paneId}` : "main");
    const addon = key === "main"
      ? termsRef.current.get(owner)?.search ?? null
      : paneTermsRef.current.get(key)?.search ?? null;
    searchSidRef.current = owner;
    // 目标格已关/未挂 addon：回落主视图，不要让查找框对着空气
    searchTargetKeyRef.current = addon ? key : "main";
    searchAddonRef.current = addon ?? termsRef.current.get(owner)?.search ?? null;
    setSearchOpen(true);
    setTimeout(() => searchInputRef.current?.focus(), 0);
  }, []);

  // 关闭搜索：清“发起搜索”那个会话的高亮，焦点还给该标签上次落焦的终端/格子
  // （tmux 格子聚焦或最大化时不再被拉回隐藏的主视图）。
  const closeSearch = useCallback(() => {
    setSearchOpen(false);
    // 关闭即清查询与计数：否则重开时输入框与「1/N」还停在上一轮的值，但高亮
    // 已被 clearDecorations 清掉，界面自相矛盾。
    setSearchQuery("");
    setSearchResults(null);
    // 查找条开关随关闭复位（会话内临时偏好，不落 vault）
    searchPrefsRef.current = SEARCH_PREFS_DEFAULT;
    setSearchPrefs(SEARCH_PREFS_DEFAULT);
    setSearchInvalid(false);
    // 清「实际被搜的那个终端」的高亮（主视图或面板格）
    searchAddonRef.current?.clearDecorations();
    searchAddonRef.current = null;
    searchTargetKeyRef.current = null;
    searchSidRef.current = null;
    const sid = sidRef.current;
    if (sid) focusTermForRef.current(sid);
    else xtermRef.current?.focus();
  }, []);

  // 切标签/关标签：搜索属于发起它的会话，不能让查询与高亮跟着跑到下一个会话
  // （否则搜索框留在屏幕上但已失焦，下一次键入直接进新 shell）。
  useEffect(() => {
    if (!searchOpen) return;
    if (searchSidRef.current && searchSidRef.current !== sid) closeSearch();
  }, [sid, searchOpen, closeSearch]);
  // 旧 Esc 浮层链已并入统一 action 分发（closeTopOverlayRef，R13）。
  // 输入控件语义：无浮层时 Esc 原样透传（搜索框自带关闭不变）；
  // 有浮层时浮层优先消费（§7.3）——与旧「INPUT/TEXTAREA 一律不劫持」相比，
  // 浮层开着时 Esc 不再被输入框吞掉。

  // macOS 窗口标题跟随当前会话主机（T16）；浏览器 demo 同步 document.title
  useEffect(() => {
    const cur = sessions.find((s) => s.id === sid);
    const title = cur ? `${cur.host_name} — TinySSH` : t("TinySSH — 人机协同 SSH 工作台");
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
    || toolsOpen || tabsMenuOpen || focusHostMenu || rightPanel !== null || !!confirm || !!pendingDrop;
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

  // 注册表 → 卡片（呈现态映射；R34 全量状态：提交窗口/待决/未知/跳过/中断各归其位）
  const taskToCard = useCallback((t: TransferTask): TransferCard => ({
    id: t.id,
    kind: t.kind,
    name: pathBasename(t.kind === "Upload" ? t.source : t.dest),
    remote: t.kind === "Upload" ? t.dest : t.source,
    local: t.kind === "Upload" ? t.source : t.dest,
    sid: t.session_id,
    status: t.status === "Succeeded" ? "done"
      : t.status === "Failed" ? "failed"
      : t.status === "Cancelled" ? "cancelled"
      : t.status === "Queued" ? "queued"
      : t.status === "Cancelling" ? "cancelling"
      : t.status === "Committing" ? "committing"
      : t.status === "AwaitingDecision" ? "awaiting"
      : t.status === "OutcomeUnknown" ? "unknown"
      : t.status === "Skipped" ? "skipped"
      : t.status === "Interrupted" ? "interrupted"
      : "running",
    bytes: t.bytes_done,
    total: t.total ?? null,
    error: t.error ?? undefined,
    rev: t.revision,
    prompt: t.decision_prompt
      ? {
          target_path: t.decision_prompt.target_path,
          reason: t.decision_prompt.reason,
          size: t.decision_prompt.target_stat?.size ?? null,
          mtime: t.decision_prompt.target_stat?.mtime ?? null,
        }
      : null,
  }), []);

  // 事件帧应用（id+revision 幂等；真实 id 之外的 pending- 占位不受影响）。
  // UX 八轮：传输进度事件高频（大文件期间每秒数十条），逐条 setState 即逐条整树
  // 重渲染——120ms 尾随合帧封顶 ~8 次/秒；决定走乐观锁（StaleDecision 自愈），
  // 百毫秒级显示延迟不伤正确性
  const transferBufRef = useRef<TransferTask[]>([]);
  const transferTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flushTransfers = useCallback(() => {
    transferTimerRef.current = null;
    const batch = transferBufRef.current;
    if (batch.length === 0) return;
    transferBufRef.current = [];
    setTransfers((cur) => {
      let next = cur;
      for (const t of batch) {
        const card = taskToCard(t);
        const i = next.findIndex((x) => x.id === card.id);
        if (i < 0) next = [card, ...next];
        else if (next[i] !== card) {
          if (next === cur) next = [...cur];
          next[i] = card;
        }
      }
      return next;
    });
  }, [taskToCard]);
  const applyTransferTask = useCallback((t: TransferTask) => {
    transferBufRef.current.push(t);
    if (transferTimerRef.current !== null) return;
    transferTimerRef.current = setTimeout(flushTransfers, 120);
  }, [flushTransfers]);

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

  // 冲突决策卡必须浮出（用户实测 mac：同文件第二次下载「没有响应」——真实链路是
  // 目标已存在 → 传输进 AwaitingDecision 决策卡〔跳过/覆盖〕，而决策卡只活在传输
  // 抽屉里，抽屉关着就什么提示都没有，300s 决策窗超时静默取消更显「没响应」）。
  // AwaitingDecision 是拦住传输等人裁决的阻塞问题，不属于 R35 §194「后台事件只
  // 更新计数不自动展开」的范围——那条管的是进度噪音；每张卡只自动展开一次。
  const decisionAutoOpenedRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    // 「看见即视为已提示」：抽屉开着时到达的卡同样入已见集合——否则用户关闭
    // 抽屉的第一次动作会被本 effect 立即顶回（多卡时要连关 N 次）
    if (decisionAutoOpenedRef.current.size > 200) {
      // 只清已终结卡：在决卡被误清会重新变 fresh 顶回抽屉
      const alive = new Set(transfers.filter((t) => t.status === "awaiting" && t.prompt).map((t) => t.id));
      for (const id of decisionAutoOpenedRef.current) if (!alive.has(id)) decisionAutoOpenedRef.current.delete(id);
    }
    const fresh = transfers.find((t) => t.status === "awaiting" && t.prompt && !decisionAutoOpenedRef.current.has(t.id));
    if (!fresh) return;
    decisionAutoOpenedRef.current.add(fresh.id);
    if (!queueOpen) setQueueOpen(true);
  }, [transfers, queueOpen]);

  // C6/R34：冲突决定提交（乐观锁 expect_revision=卡片所见 revision）。
  // StaleDecision/InvalidTransferState = 卡片已过期——刷新对账 + reject 留痕
  //（任务已推进时 reject 幂等 no-op，不会误伤在途待决卡）
  const decideCollision = useCallback(async (card: TransferCard, decision: CollisionDecision) => {
    if (!card.rev) return;
    try {
      await invoke("submit_collision_decision", { id: card.id, decision, expectRevision: card.rev });
      void refreshTransfers();
    } catch (e) {
      const kind = (e as { kind?: string })?.kind;
      if (kind === "stale_decision" || kind === "invalid_transfer_state") {
        pushToast("err", kind === "stale_decision" ? t("决定已过期（任务已推进），卡片已刷新") : t("任务状态已变化，卡片已刷新"));
        try { await invoke("reject_expired_decision", { id: card.id }); } catch { /* 幂等收尾 */ }
        void refreshTransfers();
      } else {
        pushToast("err", t("决定提交失败：{0}", friendlyError(e)));
      }
    }
  }, [pushToast, refreshTransfers]);

  // C6/R34：OutcomeUnknown 重新核实——只有 journal verified 证据能翻成功，
  // 否则保持未知（不自动重发/覆盖/清理）
  const verifyOutcome = useCallback(async (id: string) => {
    try {
      await invoke("verify_transfer_outcome", { id });
      void refreshTransfers();
    } catch (e) {
      pushToast("err", t("核实失败：{0}", friendlyError(e)));
    }
  }, [pushToast, refreshTransfers]);

  // C5/R35 §364：失败重试——创建新任务重新校验连接/源/冲突（不携带覆盖授权）；
  // OutcomeUnknown 结构化拒绝——通用重试绝不作为核实替代（§374）
  const retryTransfer = useCallback(async (id: string) => {
    try {
      await invoke("retry_transfer", { id });
      void refreshTransfers();
    } catch (e) {
      const kind = (e as { kind?: string })?.kind;
      pushToast("err", kind === "invalid_transfer_state"
        ? t("该任务不可重试：结果未知请先「重新核实」")
        : t("重试失败：{0}", friendlyError(e)));
    }
  }, [pushToast, refreshTransfers]);

  // R35 S08「定位」：下载=访达显示本地目标；上传=文件面板导航到目标目录
  //（仅目标会话=当前会话时；跨会话定位不静默改道）
  const locateTransfer = useCallback(async (card: TransferCard) => {
    if (card.kind === "Download") {
      try {
        await invoke("reveal_path", { path: card.local });
      } catch (e) {
        pushToast("err", t("定位失败：{0}", friendlyError(e)));
      }
      return;
    }
    if (card.sid && card.sid === sidRef.current) {
      setRightPanel("files");
      const dir = card.remote.replace(/\/[^/]*$/, "") || "/";
      void navigateTo(dir);
    } else {
      pushToast("err", t("目标在其他会话——切换到对应会话后可定位"));
    }
  }, [pushToast]);

  // 「立即打开」：系统默认程序打开下载完成的本地文件（与「定位」同源校验——
  // 后端只开已存在的路径；无关联扩展名由系统「打开方式」兜底，前端不预判扩展名）
  const openTransfer = useCallback(async (card: TransferCard) => {
    try {
      await invoke("open_path", { path: card.local });
    } catch (e) {
      pushToast("err", t("打开失败：{0}", friendlyError(e)));
    }
  }, [pushToast]);

  // 拖拽上传：目标目录优先取远程文件区正在浏览的目录（T41），否则现场简报 cwd。
  // 先挂 pending 卡占位，拿到真实 TransferHandle 后换 id（终态对账按真实 id 匹配审计）。
  // pending 卡 id 序号（R31）：同毫秒批量发起多张卡时防 id 碰撞
  // R33 §354：sid 可显式指定——确认卡路径下目标会话在拖放开始时固定，不取聚焦 sid
  const pendingSeqRef = useRef(0);
  const startUploads = useCallback(async (paths: string[], destDir?: string, sid?: string) => {
    const s = sid ?? sidRef.current;
    const cwd = destDir ?? (s ? briefRef.current?.cwd : undefined);
    for (const p of paths) {
      const name = pathBasename(p);
      const tempId = `pending-${Date.now()}-${++pendingSeqRef.current}-${name}`;
      if (!s) {
        upsertTransfer({ id: tempId, kind: "Upload", name, remote: "—", local: p, status: "failed", error: t("未接入会话——先连接并聚焦一台主机再拖入文件") });
        continue;
      }
      if (!cwd) {
        upsertTransfer({ id: tempId, kind: "Upload", name, remote: "—", local: p, status: "failed", error: t("无法确定远程目录（现场简报未就绪），未上传") });
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

  // R33 §356：下载目录落库（blob transfers 域，串行化链防交错丢更新；同值不重写）
  const persistDownloadDir = useCallback((dir: string) => {
    if (downloadDirRef.current === dir) return;
    downloadDirRef.current = dir;
    wsWriteChain.current = wsWriteChain.current
      .then(() => invoke("get_workspace"))
      .then((ws) => invoke("set_workspace", { ws: { ...ws, transfers: { download_dir: dir } } }))
      .catch(() => {});
  }, []);

  // 下载：远端绝对路径 → 本地。§356 目标=上次下载目录/同名文件（首次=null→核心落
  // 系统 Downloads）；另存为走原生保存对话框（取消=不建卡不传输），确认后记忆其目录。
  // 卡片显示完整本地目标（handle 回填的 h.local），不以文件名相同推断成功。
  // 二十一轮：另存为模式开启时（sftpSaveAs），除显式 saveAs:false 的路径外全部
  // 弹对话框——模式是入口级默认，右键「另存为…」（saveAs:true）不受影响。
  // 0.10.0 轮：批量下载（下载所选多选）由调用方先选好目录、经 opts.local 直给——
  // 一次目录选择器替代逐文件保存框，文件名沿用远端原名。
  const downloadRemote = useCallback(async (rp: string, opts?: { saveAs?: boolean; local?: string }) => {
    const s = sidRef.current;
    if (!s || !rp) return;
    const name = pathBasename(rp);
    const saveAs = opts?.saveAs ?? sftpSaveAs;
    let local: string | null = null;
    if (opts?.local) {
      local = opts.local;
      const dir = local.replace(/\/+$/, "").replace(/\/[^/]*$/, "");
      if (dir) persistDownloadDir(dir);
    } else if (saveAs) {
      try {
        const picked = await invoke("pick_save_file", { defaultName: name, defaultDir: downloadDirRef.current });
        if (!picked) return; // 用户取消——不发起传输
        local = picked;
        const dir = local.replace(/\/+$/, "").replace(/\/[^/]*$/, "");
        if (dir) persistDownloadDir(dir);
      } catch (e) {
        pushToast("err", t("另存为失败：{0}", friendlyError(e)));
        return;
      }
    } else if (downloadDirRef.current) {
      local = `${downloadDirRef.current.replace(/\/+$/, "")}/${name}`;
    }
    const tempId = `pending-dl-${Date.now()}-${++pendingSeqRef.current}`;
    upsertTransfer({ id: tempId, kind: "Download", name, remote: rp, local: local ?? "…", status: "running" });
    try {
      const h = await invoke("download_file", { sid: s, remote: rp, local });
      setTransfers((cur) => cur.map((c) => (c.id === tempId ? { ...c, id: h.id, remote: h.remote, local: h.local } : c)));
    } catch (e) {
      setTransfers((cur) => cur.map((c) => (c.id === tempId ? { ...c, status: "failed", error: friendlyError(e) } : c)));
    }
  }, [upsertTransfer, persistDownloadDir, pushToast, sftpSaveAs]);

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
  useEffect(() => { sftpPathRef.current = sftpPath; }, [sftpPath]);
  const loadDir = useCallback(async (p: string): Promise<boolean> => {
    const s = sidRef.current;
    if (!s || !p.trim()) return false;
    const gen = ++sftpGenRef.current;
    setSftpLoading(true); setSftpErr(null);
    try {
      const es = await invoke("sftp_list", { sid: s, path: p.trim() });
      if (sidRef.current !== s || sftpGenRef.current !== gen) return false; // 过期结果丢弃（H1/C02）
      setSftpEntries(es);
      if (sftpPathRef.current !== p.trim()) {
        // 换目录 = 换选择域：选择/光标随目录走，不跨目录保留（恢复面按会话快照承担）
        setSftpSel(new Set()); sftpAnchorRef.current = null; setSftpCursor(-1);
      }
      setSftpPath(p.trim());
      setSftpPathInput(p.trim());
      return true;
    } catch (e) {
      if (sidRef.current === s && sftpGenRef.current === gen) {
        setSftpErr(friendlyError(e));
        // 列表清空（审查二轮 UX2-10②）：错误条与旧目录列表同屏会被误读为当前
        // 目录内容——导航失败诚实清场；面包屑/路径不动（用户仍在原目录语境）
        setSftpEntries([]);
        setSftpSel(new Set()); sftpAnchorRef.current = null; setSftpCursor(-1);
      }
      return false;
    } finally {
      if (sidRef.current === s && sftpGenRef.current === gen) setSftpLoading(false);
    }
  }, []);

  // C4（§352）：手动路径导航先规范化（canonical path）再列目录——前端不猜路径，
  // 不存在/权限不足按后端可区别错误如实呈现。
  // R31：成功换路径记入「返回」栈并清「前进」栈（刷新/首载不走这里，不入栈）
  const navigateTo = useCallback(async (p: string): Promise<boolean> => {
    const s = sidRef.current;
    if (!s || !p.trim()) return false;
    const from = sftpPathRef.current;
    const genAtStart = sftpGenRef.current;
    try {
      const r = await invoke("sftp_resolve_path", { sid: s, path: p.trim() });
      if (sidRef.current !== s) return false;
      const ok = await loadDir(r.canonical);
      if (ok && r.canonical !== from && sidRef.current === s) {
        setSftpHist((h) => from ? [...h.slice(-49), from] : h);
        setSftpFwd([]);
      }
      return ok;
    } catch (e) {
      // rev-r30 中-1：迟到失败响应不得写入已切换会话的浏览器（与 loadDir 同纪律）；
      // rev-r31 低-6：补代际守卫——重叠导航下晚到的 resolve 错误不得挂到新路径横幅
      if (sidRef.current === s && sftpGenRef.current === genAtStart) {
        setSftpErr(friendlyError(e));
        // 同 loadDir（审查二轮 UX2-10②）：resolve 失败同样清列表，不给「错误条
        // + 旧目录内容」的误读同屏
        setSftpEntries([]);
        setSftpSel(new Set()); sftpAnchorRef.current = null; setSftpCursor(-1);
      }
      return false;
    }
  }, [loadDir]);

  // R31 §350 返回/前进：栈内存的是已访问 canonical 路径，直接 loadDir（不再入栈）。
  // rev-r31 低-3：目标已失效（被删/无权限）时栈不消耗、对侧不残留——回滚本次弹出
  const sftpGoBack = useCallback(async () => {
    if (!sftpHist.length) return;
    const s = sidRef.current;
    const target = sftpHist[sftpHist.length - 1];
    setSftpHist((h) => h.slice(0, -1));
    if (sftpPathRef.current) setSftpFwd((f) => [...f.slice(-49), sftpPathRef.current]);
    const okNav = await loadDir(target);
    if (!okNav && sidRef.current === s) {
      setSftpHist((h) => [...h, target]);
      setSftpFwd((f) => f.slice(0, -1));
    }
  }, [sftpHist, loadDir]);
  const sftpGoFwd = useCallback(async () => {
    if (!sftpFwd.length) return;
    const s = sidRef.current;
    const target = sftpFwd[sftpFwd.length - 1];
    setSftpFwd((f) => f.slice(0, -1));
    if (sftpPathRef.current) setSftpHist((h) => [...h.slice(-49), sftpPathRef.current]);
    const okNav = await loadDir(target);
    if (!okNav && sidRef.current === s) {
      setSftpFwd((f) => [...f, target]);
      setSftpHist((h) => h.slice(0, -1));
    }
  }, [sftpFwd, loadDir]);

  // C4：符号链接点击——stat 探明目标（is_dir 为跟随语义）再决定进入/下载；
  // 悬空链接 stat 的 canonical 为 null 但 is_dir 仍可得，失败如实报错不猜。
  // 双击/Enter 同语义（activate）；进目录走 navigateTo（入返回栈）
  const openSymlink = useCallback(async (e: DirEntryS) => {
    const s = sidRef.current;
    if (!s || !sftpPath) return;
    const full = `${sftpPath.replace(/\/+$/, "")}/${e.name}`;
    try {
      const st = await invoke("sftp_stat", { sid: s, path: full });
      if (sidRef.current !== s) return;
      if (st.is_dir) await navigateTo(full);
      else await downloadRemote(full);
    } catch (err) {
      if (sidRef.current === s) setSftpErr(friendlyError(err));
    }
  }, [sftpPath, navigateTo, downloadRemote]);

  // R31 §348 按会话保存浏览状态：切走存快照、切回恢复（路径/条目/错误/选择/历史）；
  // 无快照的新会话清空待命，§348 首载链照常。会话关闭由下方 prune 清快照。
  const sftpFirstSidRef = useRef<string | null>(null);
  useEffect(() => {
    const prev = sftpPrevSidRef.current;
    if (prev && prev !== sid) {
      sftpSavedRef.current.set(prev, {
        path: sftpPath, entries: sftpEntries, err: sftpErr,
        sel: [...sftpSel], hist: sftpHist, fwd: sftpFwd, anchor: sftpAnchorRef.current,
      });
    }
    sftpPrevSidRef.current = sid;
    // 作废在途响应：恢复快照后，旧会话晚到的 loadDir 不得覆盖恢复态
    //（gen 全局递增即可使 sid+gen 双守卫拒绝一切在途结果）
    sftpGenRef.current++;
    setSftpMenu(null);
    // 在途响应被作废时其 finally 不再清 loading——切会话统一复位，防骨架卡死
    setSftpLoading(false);
    const saved = sid ? sftpSavedRef.current.get(sid) : undefined;
    if (saved) {
      setSftpPath(saved.path); setSftpPathInput(saved.path); setSftpEntries(saved.entries);
      setSftpErr(saved.err); setSftpSel(new Set(saved.sel)); setSftpHist(saved.hist); setSftpFwd(saved.fwd);
      sftpAnchorRef.current = saved.anchor;
    } else {
      setSftpEntries(null); setSftpErr(null); setSftpSel(new Set()); setSftpHist([]); setSftpFwd([]);
      sftpAnchorRef.current = null;
      // rev-r31 低-5：无快照的新会话同样清路径——面包屑短暂显示上一会话路径是残留
      setSftpPath(""); setSftpPathInput("");
      // R3-B-3：新会话不持旧会话的 brief——否则新会话 brief 与旧会话字节级全等
      // 时 sameJson 返回旧引用、无重渲染，SFTP 首载链的 brief 门永不打开（列表
      // 静默空白）。置 null 后新 brief 到达必发生 null→对象引用变化，首载必跑。
      setBrief(null);
    }
    setSftpCursor(-1);
    sftpFirstSidRef.current = saved ? sid : null;
    // 快照读取只在切会话时刻发生——依赖刻意收窄（同既有 H1 纪律）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sid]);
  // 会话关闭：清该会话快照（不残留死会话浏览态）
  const sftpAliveKey = sessions.map((x) => x.id).join("\u0001");
  useEffect(() => {
    const alive = new Set(sftpAliveKey ? sftpAliveKey.split("\u0001") : []);
    for (const k of [...sftpSavedRef.current.keys()]) if (!alive.has(k)) sftpSavedRef.current.delete(k);
  }, [sftpAliveKey]);
  // §348 首次打开链：本次连接可信 cwd → SFTP 初始目录（resolve null）→ 手动输入。
  // brief 到达（cwd 可用性已知）才起链；每会话一次（有快照恢复的会话不再首载——
  // 恢复的位置优先），后续浏览位置不回跳。
  useEffect(() => {
    if (!sid || sftpFirstSidRef.current === sid || brief === null || briefSidRef.current !== sid) return;
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

  // R31 §350 显示列表：隐藏项过滤 + 名称筛选 + 排序（目录恒在前；
  // 未知大小/时间恒排后且不参与方向翻转——不以 0 冒充，§352）
  const sftpShown = useMemo(() => {
    if (!sftpEntries) return [] as DirEntryS[];
    const q = sftpFilter.trim().toLowerCase();
    const rows = sftpEntries.filter((e) => (sftpShowHidden || !e.name.startsWith(".")) && (!q || e.name.toLowerCase().includes(q)));
    const nameCmp = (a: DirEntryS, b: DirEntryS) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
    const dir = sftpSort.dir;
    const cmp = (a: DirEntryS, b: DirEntryS): number => {
      if (a.is_dir !== b.is_dir) return a.is_dir ? -1 : 1;
      if (sftpSort.key === "name") return dir * nameCmp(a, b);
      const av = sftpSort.key === "size" ? a.size : a.mtime;
      const bv = sftpSort.key === "size" ? b.size : b.mtime;
      if (av == null && bv == null) return nameCmp(a, b);
      if (av == null) return 1;
      if (bv == null) return -1;
      return dir * (av - bv) || nameCmp(a, b);
    };
    return rows.slice().sort(cmp);
  }, [sftpEntries, sftpFilter, sftpShowHidden, sftpSort]);
  useEffect(() => {
    setSftpCursor((c) => (sftpShown.length ? Math.min(c, sftpShown.length - 1) : -1));
  }, [sftpShown.length]);
  // R31 §350 选择：单击选中、⌘/Ctrl 切换、Shift 范围（锚点行）；多选下载只取文件，
  // 目录/特殊文件给明确信息（§350「目录下载给明确信息」——不静默跳过）
  const sftpRowClick = useCallback((e: DirEntryS, idx: number, ev: React.MouseEvent) => {
    if (ev.shiftKey && sftpAnchorRef.current) {
      const ai = sftpShown.findIndex((x) => x.name === sftpAnchorRef.current);
      const lo = ai < 0 ? idx : Math.min(ai, idx);
      const hi = ai < 0 ? idx : Math.max(ai, idx);
      setSftpSel(new Set(sftpShown.slice(lo, hi + 1).map((x) => x.name)));
    } else if (ev.metaKey || ev.ctrlKey) {
      setSftpSel((prev) => { const n = new Set(prev); if (n.has(e.name)) n.delete(e.name); else n.add(e.name); return n; });
      sftpAnchorRef.current = e.name;
    } else {
      setSftpSel(new Set([e.name]));
      sftpAnchorRef.current = e.name;
    }
    setSftpCursor(idx);
  }, [sftpShown]);
  const sftpActivate = useCallback((e: DirEntryS, at?: { x: number; y: number }) => {
    // Enter/双击激活：目录进入、链接探明（R30 语义）、文件弹可用动作（不直接执行 §350）
    if (e.is_dir) void navigateTo(`${sftpPathRef.current.replace(/\/+$/, "")}/${e.name}`);
    else if (e.kind === "symlink") void openSymlink(e);
    else if (at) setSftpMenu({ name: e.name, x: at.x, y: at.y });
  }, [navigateTo, openSymlink]);
  const sftpDownloadSelected = useCallback(async () => {
    const s = sidRef.current;
    if (!s || !sftpEntries || sftpSel.size === 0) return;
    const byName = new Map(sftpEntries.map((e) => [e.name, e]));
    const base = sftpPathRef.current.replace(/\/+$/, "");
    let skippedDirs = 0, skippedOther = 0;
    const targets: string[] = [];
    for (const n of sftpSel) {
      const e = byName.get(n);
      if (!e) continue;
      if (e.is_dir) skippedDirs++;
      else if (e.kind === "other") skippedOther++;
      else targets.push(`${base}/${n}`);
    }
    // 0.10.0 轮：另存为模式下批量（>1 个文件）只弹**一次目录选择器**——用户反馈
    // 「每个文件都要选保存太繁」。取消=整批不发起；单文件仍走逐文件另存（可改名）。
    // 模式关时维持既有语义：直接落上次下载目录，零对话框。
    let batchDir: string | null = null;
    if (sftpSaveAs && targets.length > 1) {
      try {
        batchDir = await invoke("pick_save_dir", { defaultDir: downloadDirRef.current });
      } catch (e) {
        pushToast("err", t("选择目录失败：{0}", friendlyError(e)));
        return;
      }
      if (!batchDir) return; // 用户取消——整批不发起
    }
    for (const t of targets) {
      await downloadRemote(t, batchDir ? { local: `${batchDir.replace(/\/+$/, "")}/${pathBasename(t)}` } : undefined);
    }
    if (skippedDirs > 0 || skippedOther > 0) {
      const parts: string[] = [];
      if (skippedDirs > 0) parts.push(t("{0} 个目录", skippedDirs));
      if (skippedOther > 0) parts.push(t("{0} 个特殊文件", skippedOther));
      pushToast("info", targets.length > 0
        ? t("已开始下载 {0} 个文件；{1}不支持直接下载", targets.length, parts.join(t("、")))
        : t("{0}不支持直接下载——请进入目录选择其中的文件", parts.join(t("、"))));
    }
  }, [sftpEntries, sftpSel, downloadRemote, pushToast, sftpSaveAs]);

  // R31 §350 键盘导航：列表容器获焦后方向键移动光标、Home/End 跳端、Enter 激活
  //（目录进入/文件动作菜单）、Space 切换选中；不与筛选输入抢键（各自 onKeyDown 独立）
  const sftpListRef = useRef<HTMLDivElement | null>(null);
  const sftpListKey = (ev: React.KeyboardEvent) => {
    const n = sftpShown.length;
    if (!n) return;
    const cur = sftpCursor;
    if (ev.key === "ArrowDown") { ev.preventDefault(); setSftpCursor(Math.min(n - 1, cur + 1)); }
    else if (ev.key === "ArrowUp") { ev.preventDefault(); setSftpCursor(Math.max(0, cur - 1)); }
    else if (ev.key === "Home") { ev.preventDefault(); setSftpCursor(0); }
    else if (ev.key === "End") { ev.preventDefault(); setSftpCursor(n - 1); }
    else if (ev.key === "Enter") {
      if (cur < 0 || cur >= n) return;
      ev.preventDefault();
      const el = sftpListRef.current?.querySelector<HTMLElement>(`[data-idx="${cur}"]`);
      const r = el?.getBoundingClientRect();
      sftpActivate(sftpShown[cur], r ? { x: r.left + 60, y: r.bottom + 2 } : undefined);
    } else if (ev.key === " ") {
      if (cur < 0 || cur >= n) return;
      ev.preventDefault();
      const name = sftpShown[cur].name;
      setSftpSel((prev) => { const x = new Set(prev); if (x.has(name)) x.delete(name); else x.add(name); return x; });
      sftpAnchorRef.current = name;
    }
  };
  useEffect(() => {
    if (sftpCursor < 0) return;
    sftpListRef.current?.querySelector(`[data-idx="${sftpCursor}"]`)?.scrollIntoView({ block: "nearest" });
  }, [sftpCursor]);
  // 面包屑溢出时滚到末端（当前目录可见）。vis-r31 低发现：窄窗载入时滚末端与面板
  // 宽度落定有一帧竞态（effect 跑在收窄前 no-op，此后无人重滚、当前段被裁）——
  // 滚动同时挂到宽度观察器，宽度落定/变化即重滚
  const sftpCrumbsRef = useRef<HTMLDivElement | null>(null);
  const sftpScrollCrumbs = useCallback(() => {
    const el = sftpCrumbsRef.current;
    if (el) el.scrollLeft = el.scrollWidth;
  }, []);
  useEffect(() => { sftpScrollCrumbs(); }, [sftpPath, sftpEditPath, sftpScrollCrumbs]);
  // 面板宽度跟随（§350 窄面板依次收起）：≤300 只留名称，≤340 收时间，其余全列
  const sftpWrapRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = sftpWrapRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => { setSftpListW(el.clientWidth); sftpScrollCrumbs(); });
    ro.observe(el);
    setSftpListW(el.clientWidth);
    return () => ro.disconnect();
  }, [rightPanel, sftpScrollCrumbs]);
  // 文件动作菜单（双击/Enter 文件→可用动作，不直接执行 §350）：点外/Esc 关；
  // rev-r31 低-7：打开即移焦入菜单（键盘 Enter 激活路径可达；Esc 即关）
  const sftpMenuRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!sftpMenu) return;
    // 记住打开前的焦点（列表行/文件格）：菜单卸载后还给原处。此前 Esc 关闭焦点
    // 落到 body，方向键/Enter 全断，用户要重新 Tab 一整圈回列表。
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    sftpMenuRef.current?.querySelector("button")?.focus();
    const onDown = (e: MouseEvent) => { if (!sftpMenuRef.current?.contains(e.target as Node)) setSftpMenu(null); };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setSftpMenu(null); };
    window.addEventListener("mousedown", onDown, true);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown, true);
      window.removeEventListener("keydown", onKey);
      if (opener && opener.isConnected) opener.focus({ preventScroll: true });
    };
  }, [sftpMenu]);

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
    const un = inTauri
      ? tauriListen(
          listen<{ session_id: string }>("forward-event", (e) => {
            if (e.payload?.session_id === sidRef.current) void refreshForwards();
          }),
        )
      : undefined;
    return () => { clearInterval(t); un?.(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sid]);

  // 回环判定（§6.6）：非回环监听显示暴露范围 + 必须主动勾选确认
  const isLoopbackAddr = (a: string): boolean => {
    const t = a.trim().toLowerCase();
    return t === "localhost" || t === "::1" || t === "0:0:0:0:0:0:0:1" || /^127(\.\d{1,3}){3}$/.test(t);
  };
  const addForward = async () => {
    const s = sidRef.current;
    if (!s) return;
    const p = parseInt(fwdPort, 10);
    const tp = parseInt(fwdTPort, 10);
    const laddr = fwdLAddr.trim();
    const next: { listen?: string; target?: string } = {};
    // 字段级校验（§6.6「端口冲突关联到对应字段」——就地高亮对应输入）
    if (!laddr) next.listen = t("监听地址不能为空（默认 127.0.0.1）");
    else if (!Number.isInteger(p) || p <= 0 || p > 65535) next.listen = t("监听端口必须是 1–65535 的数字");
    // 非回环「必须主动选择」：未勾选确认时阻止启动并说明暴露范围
    if (!next.listen && !isLoopbackAddr(laddr) && !fwdExposeAck) {
      next.listen = t("非回环监听 {0} 将对本机所在网络可见——请勾选「我确认暴露范围」后再启动", laddr);
    }
    if (fwdKind !== "Dynamic" && (!fwdHost.trim() || !Number.isInteger(tp) || tp <= 0 || tp > 65535)) {
      next.target = t("目标主机与端口（1–65535）都要填");
    }
    if (next.listen || next.target) { setFwdFieldErr(next); return; }
    setFwdFieldErr(null);
    const spec: ForwardSpec = fwdKind === "Dynamic"
      ? { Dynamic: { listen_addr: laddr, listen_port: p } }
      : fwdKind === "Remote"
        ? { Remote: { listen_addr: laddr, listen_port: p, target_host: fwdHost.trim(), target_port: tp } }
        : { Local: { listen_addr: laddr, listen_port: p, target_host: fwdHost.trim(), target_port: tp } };
    setFwdBusy(true);
    try {
      // 远程转发「请求被服务器拒绝」不抛错（条目保留为 Failed 可见可停）——
      // 按 refresh 后的实际状态决定提示（审核中-2：曾对 Failed 也绿「已启动」并清输入）
      const fid = await invoke("start_forward", { sid: s, spec });
      const fs2 = await refreshForwards();
      const st = fs2.find((f) => f.id === fid);
      if (st && st.state !== "Listening") {
        // 远端服务器拒绝（监听侧）——定位到监听字段，如实报出服务器原因
        setFwdFieldErr({ listen: t("远端拒绝监听 {0}:{1}：{2}", laddr, p, st.error ?? t("未知错误")) });
        return; // 输入保留，用户改端口/主机即可重试（finally 里复位 busy）
      }
      setFwdPort(""); setFwdHost(""); setFwdTPort("");
      pushToast("ok", fwdKind === "Local" ? t("本地转发已启动：{0}", `${laddr}:${p}`) : fwdKind === "Remote" ? t("远程转发已启动：远端 {0}", `${laddr}:${p}`) : t("SOCKS5 已启动：{0}", `${laddr}:${p}`));
    } catch (e) {
      // 结构化字段定位：核心 ForwardListenFailed{field} → 就地高亮；其余走通用提示
      const pe = parseWireError(e);
      if (pe.kind === "forward_listen_failed") {
        const field = (pe.detail as { field?: string } | undefined)?.field === "target" ? "target" : "listen";
        setFwdFieldErr({ [field]: friendlyError(e) } as { listen?: string; target?: string });
      } else {
        pushToast("err", t("转发启动失败：{0}", friendlyError(e)));
      }
      await refreshForwards();
    } finally {
      setFwdBusy(false);
    }
  };

  const stopForward = async (id: string) => {
    const s = sidRef.current;
    if (!s) return;
    setFwdStopping((prev) => new Set(prev).add(id));
    setFwdStopErr((prev) => { const n = { ...prev }; delete n[id]; return n; });
    try {
      // 停止等待核心结果（§6.6）：核心确认后行才消失；失败保留行 + 可重试
      await invoke("stop_forward", { sid: s, id });
      await refreshForwards();
    } catch (e) {
      setFwdStopErr((prev) => ({ ...prev, [id]: friendlyError(e) }));
    } finally {
      setFwdStopping((prev) => { const n = new Set(prev); n.delete(id); return n; });
    }
  };

  // C5（R32）传输对账（替代旧 800ms 审计猜测轮询——「完成/取消不靠审计猜测」）：
  // 真实环境 = transfer-event 即时推送 + 挂载时 list_transfers 全量对账；
  // demo = 800ms 轮询 list_transfers（模拟事件通道的双路镜像，session-state 同工艺）
  useEffect(() => {
    if (!inTauri) return;
    const un = tauriListen(
      listen<TransferTask>("transfer-event", (e) => applyTransferTask(e.payload)),
    );
    void refreshTransfers();
    return un;
  }, [inTauri, applyTransferTask, refreshTransfers]);
  useEffect(() => {
    if (inTauri) return;
    const t = setInterval(() => void refreshTransfers(), 800);
    return () => clearInterval(t);
  }, [inTauri, refreshTransfers]);

  // 传输终态 toast（§六）：running → done/failed 迁移时通知；卡片本身仍常显，
  // 即时失败（未接入会话等）有卡可见不重复 toast；取消是用户主动动作不打扰。
  // 下载完成附带「打开所在文件夹」（0.10.0 轮，用户需求）：同卡「定位」语义
  // （reveal_path 资源管理器 /select 选中文件），无有效本地路径（pending/… 占位）不给动作
  const prevTransferStatus = useRef<Map<string, string>>(new Map());
  useEffect(() => {
    for (const tv of transfers) {
      const prev = prevTransferStatus.current.get(tv.id);
      if (prev === "running" && tv.status === "done") {
        pushToast("ok", t("传输完成：{0}", tv.name),
          tv.kind === "Download" && !tv.local.startsWith("pending") && tv.local !== "…"
            ? { label: t("打开所在文件夹"), title: t("在文件管理器中显示下载的文件"), run: () => { void locateTransfer(tv); } }
            : undefined);
      }
      if (prev === "running" && tv.status === "failed") pushToast("err", t("传输失败：{0}——{1}", tv.name, tv.error ?? t("未知错误")));
      prevTransferStatus.current.set(tv.id, tv.status);
    }
  }, [transfers, pushToast, locateTransfer]);

  // R33 §354 拖放落点分区：文件面板落点=直接上传到正在浏览的目录（不确认）；
  // 其余落点（终端等）=目标确认卡。物理像素→逻辑像素后与面板实测矩形求交，
  // 面板分区仅在面板开着且显示文件页时存在。demo 域经 window.__demoDrop 走同一逻辑。
  // 面板开合/浏览路径经 ref 读取（探针实证 300ms 窗内 hook 重注册竞态——闭包捕获
  // 旧 rightPanel 会借到已关闭面板的路径，违 §354）——同源判别用 ref 不用闭包
  const taskPanelRef = useRef<HTMLElement | null>(null);
  const rightPanelRef = useRef<null | "files" | "collab" | "forwards" | "log" | "blocks">(null);
  useEffect(() => { rightPanelRef.current = rightPanel; }, [rightPanel]);
  const beginDropUploads = useCallback((paths: string[], pos?: { x: number; y: number }) => {
    if (!paths.length) return;
    const s = sidRef.current;
    if (!s) {
      // 失败卡躺在默认关闭的传输抽屉里，落地瞬间没有可见反馈——用户会以为已上传
      pushToast("err", t("没有活动会话——先连接主机，再拖文件上传"));
      void startUploads(paths, undefined);
      return;
    }
    const rp = rightPanelRef.current;
    let zone: "panel" | "term" = "term";
    if (pos && rp === "files") {
      const r = taskPanelRef.current?.getBoundingClientRect();
      if (r && pos.x >= r.left && pos.x <= r.right && pos.y >= r.top && pos.y <= r.bottom) zone = "panel";
    }
    if (zone === "panel") { void startUploads(paths, sftpPathRef.current || undefined, s); return; }
    // 可信目标=该会话 brief.cwd（shell 集成上报，与定位钮同源）；不可信而面板可见
    // 且正在浏览 → 以浏览目录预填；不可见面板旧路径一律不借用（§354）——面板关闭时
    // 即使曾浏览过也不预填，留空必填
    const prefill = briefRef.current?.cwd || (rp === "files" ? sftpPathRef.current : "") || "";
    setPendingDropDir(prefill);
    setPendingDropErr(null);
    setPendingDrop({ paths, sid: s });
  }, [startUploads, pushToast]);

  // 拖拽事件（Tauri drag-drop，浏览器演示模式无此通道）：enter/over 显示覆盖层，drop 分区
  useEffect(() => {
    if (!inTauri) return;
    let un: (() => void) | undefined;
    let dead = false;
    getCurrentWindow()
      .onDragDropEvent((ev: { payload: DragDropEvent }) => {
        const p = ev.payload;
        const zoneAt = (pos?: { x: number; y: number }): "term" | "panel" => {
          if (!pos || rightPanelRef.current !== "files") return "term";
          const r = taskPanelRef.current?.getBoundingClientRect();
          return r && pos.x >= r.left && pos.x <= r.right && pos.y >= r.top && pos.y <= r.bottom
            ? "panel" : "term";
        };
        if (p.type === "enter" || p.type === "over") {
          setDragOver(true);
          if ("position" in p && p.position) {
            const dpr = window.devicePixelRatio || 1;
            setDragZone(zoneAt({ x: p.position.x / dpr, y: p.position.y / dpr }));
          }
        } else if (p.type === "leave") setDragOver(false);
        else if (p.type === "drop") {
          setDragOver(false);
          // position 是物理像素（相对 webview 左上），CSS 矩形是逻辑像素——除以 dpr 再比
          const dpr = window.devicePixelRatio || 1;
          beginDropUploads(p.paths, { x: p.position.x / dpr, y: p.position.y / dpr });
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
  }, [beginDropUploads]);

  // demo 域拖放判别钩子：demo 无 OS 拖放通道，探针经 demo_drag_drop 预置路径+逻辑
  // 坐标，走与原生相同的分区/确认逻辑（坐标口径=逻辑像素，与 CSS 矩形同域）
  useEffect(() => {
    if (inTauri) return;
    (window as unknown as { __demoDrop?: (paths: string[], x?: number, y?: number) => void }).__demoDrop =
      (paths, x, y) => beginDropUploads(paths, x !== undefined && y !== undefined ? { x, y } : undefined);
    return () => { delete (window as unknown as { __demoDrop?: unknown }).__demoDrop; };
  }, [inTauri, beginDropUploads]);

  // 二十一轮：demo 域命令探针（__demoDrop 同族）——spec 预置 demo_pick_result 等
  // 判别钩子用；仅浏览器演示态存在，原生应用不暴露
  useEffect(() => {
    if (inTauri) return;
    (window as unknown as { __demoInvoke?: (cmd: string, args?: unknown) => Promise<unknown> }).__demoInvoke =
      (cmd, args) => (invoke as (c: string, a?: unknown) => Promise<unknown>)(cmd, args ?? {});
    return () => { delete (window as unknown as { __demoInvoke?: unknown }).__demoInvoke; };
  }, [inTauri]);

  // §354 切标签使未确认的目标选择失效——不静默改投另一主机；目标会话关闭同理
  useEffect(() => {
    if (!pendingDrop) return;
    if (pendingDrop.sid === sid) return;
    setPendingDrop(null);
    pushToast("err", t("上传已取消：目标会话已切换"));
  }, [sid, pendingDrop, pushToast]);

  // 确认卡提交：目录必填（无可信 cwd 时不预填），确认时刻仍按拖放开始固定的会话上传。
  // 输入目录先 sftp_resolve_path 归一（相对路径/.. 按服务端语义解析，与 navigateTo
  // 同工艺）；解析失败=目录不可用——卡保持打开如实报错，不猜不投（rev-r33 低-2）
  const confirmDropUpload = useCallback(async () => {
    const pd = pendingDrop;
    if (!pd || dropConfirmBusyRef.current) return;
    const dir = pendingDropDir.trim();
    if (!dir) return;
    dropConfirmBusyRef.current = true;
    setPendingDropErr(null);
    try {
      const r = await invoke("sftp_resolve_path", { sid: pd.sid, path: dir });
      setPendingDrop(null);
      void startUploads(pd.paths, r.canonical, pd.sid);
    } catch (e) {
      setPendingDropErr(friendlyError(e));
    } finally {
      dropConfirmBusyRef.current = false;
    }
  }, [pendingDrop, pendingDropDir, startUploads]);

  // R33 §353 文件面板「上传」：原生文件选择器（多选）；目标=正在浏览的目录；
  // 取消=不发起。浏览器 demo 域由 pick_upload_files mock 承接同一命令面。
  const pickAndUpload = useCallback(async () => {
    const s = sidRef.current;
    if (!s || !sftpPath) { pushToast("err", t("先连接主机并进入一个目录再上传")); return; }
    try {
      const paths = await invoke("pick_upload_files");
      if (!paths.length) return;
      void startUploads(paths, sftpPath, s);
    } catch (e) {
      pushToast("err", t("打开文件选择器失败：{0}", friendlyError(e)));
    }
  }, [sftpPath, startUploads, pushToast]);

  // 十八轮：会话日志开关——后端 pump tap 落盘（后台输出不漏），路径经 toast 呈现
  const toggleSessionLog = async (s: SessionInfo) => {
    try {
      const r = await invoke("set_session_logging", { sid: s.id, enabled: !s.logging }) as string | null;
      setSessions((cur) => cur.map((x) => (x.id === s.id ? { ...x, logging: !s.logging } : x)));
      if (r) pushToast("ok", t("已开始记录会话日志：{0}", r));
      else pushToast("info", t("已停止记录会话日志"));
    } catch (e) {
      pushToast("err", friendlyError(e));
    }
  };

  const openSessionLogFolder = async (sid: string) => {
    try {
      const p = await invoke("session_log_path", { sid }) as string | null;
      if (p) await invoke("reveal_path", { path: p });
      else pushToast("info", t("该会话未在记录日志"));
    } catch (e) {
      pushToast("err", friendlyError(e));
    }
  };

  const createSession = async (host: Host, intoSplit = false, draft?: HostDraft, localShellPath?: string, localNew = true) => {
    // 同主机并发建连闸（主机卡/连接钮共用）：在 begin_connection 应答前
    // connectingIds 仍是空的，双击会真的发两次 begin；本机 new_session 又绕过
    // 核心幂等，最终出现两个终端。锁按 hostId 粒度且只在本次调用生命周期内持有，
    // 不挡用户串行再点一次「用指定 shell 新开」。
    const lockId = host.id;
    if (pendingHostsRef.current.has(lockId)) return false;
    pendingHostsRef.current.add(lockId);
    // 本轮：任何建连路径都恢复「从最近连接隐藏」的主机——重新连了就是「最近」
    setRecentHidden(host.id, false);
    // §6.3：点击时刻的焦点代际——完成时代际未变且窗口前台才落终端焦点
    const gen0 = focusGenRef.current;
    setConnError(null);
    let attemptId: string | null = null;
    try {
      // R23（C1 消费）：begin_connection → attempt_id，终态经事件/轮询回回；
      // 门挂起期间主机卡可取消（§302 等待中可取消）。
      // 十七轮：draft 在场 = 快速连接——begin_connection_draft 注册内存态主机
      // 后走同一条 attempt 路径；真实 id 经 attempt 回带（门匹配/失败标记全用它）
      // 本地终端一等公民轮：本机建连带上所选 shell——显式 localShellPath 优先
      //（本机右键「用 … 新开」），否则按 KV 默认选择换算成路径；重连 respawn 复用。
      // 显式入口默认 new_session（「新开」语义绕过幂等合并——在途时第二次带不同
      // shell 的选择会被合并吞掉）；仅启动自动开传 false 保幂等。
      let opts: BeginConnectionOpts | undefined;
      if (host.id === "local" && !draft) {
        const chosen = localShellPath ?? (localShellId ? localShells.find((s) => s.id === localShellId)?.path : undefined);
        if (chosen || localNew) {
          opts = { ...(chosen ? { local_shell: chosen } : {}), ...(localNew ? { new_session: true } : {}) };
        }
      }
      // 新一次 draft 提交：清掉上一次关窗留下的取消意图（否则会误杀本次）
      if (draft) quickCancelRequestedRef.current = false;
      const a = await (draft
        ? invoke("begin_connection_draft", { draft, opts: {} })
        : invoke("begin_connection", { hostId: host.id, opts })) as AttemptInfo;
      if (draft && a.host_id) host = { ...host, id: a.host_id };
      attemptId = a.attempt_id;
      if (draft) {
        // 应答回来立刻记 attempt_id（不等到 settle）：✕/Esc 此刻起能真取消。
        quickAttemptRef.current = a.attempt_id;
        // 用户在 begin 应答前就关了弹窗：那时没有 attempt 可取消，补在这里
        if (quickCancelRequestedRef.current) {
          quickCancelRequestedRef.current = false;
          quickAttemptRef.current = null;
          void cancelAttempt(a.attempt_id);
          return false;
        }
      }
      settleAttempt(a);
      const final = await waitForAttempt(a.attempt_id);
      if (final.phase === "Ready" && final.session_id) {
        setLastFailed(null);
        // 十五轮：「重连上次会话」记忆的武装点——只有用户主动建连成功才置位；
        // 启动装载/demo 预置会话不得武装（否则 reload 即覆盖上次运行的清单）
        lastTrackArmedRef.current = true;
        await refreshLists();
        if (intoSplit) {
          // 十三轮：右键活动标签「复制标签页到右侧/下侧」——显式参数直达（无跨点击的
          // 挂起状态，非已退役的预武装模式）：这条连接就是副格，建好即进分屏
          await enterSplitWith(final.session_id);
          await attachSession(final.session_id);
          pushToast("ok", t("已连接 {0}（{1}侧分屏）", host.name, splitDirRef.current === "tb" ? t("下") : t("右")));
          return;
        }
        // rev-r21 M2：他主机门挂起中（用户注意力在其输入框，遮罩不持 DOM 焦）完成
        // 不抢焦——否则后续验证码 keystroke 误落已完成会话的远端 shell。本主机门在
        // attempt 终态前必已闭（应答先同步 splice 队列再 invoke），不受扰。
        // R21-L6 勘误闭环：gatesBusy 改按 host_id 精确匹配（wire 已补 host_id）
        // ProxyJump：跳板门卡的 host_id 是跳板主机——按 attempt 归属判定他机门
        //（attempt_id 缺失的旧事件回落 host_id 比对）
        // §6.3「窗口在前台」：真实失焦（他应用激活）期间完成不切视图不抢焦，
        // 只查 document.hidden 挡不住窗口级失焦（r23a 原生实证）
        const foreignGate = (x: { host_id?: string; attempt_id?: string | null }) =>
          x.attempt_id ? x.attempt_id !== attemptId : x.host_id !== host.id;
        const gatesBusy = hostKeyQueueRef.current.some(foreignGate)
          || authPromptQueueRef.current.some(foreignGate);
        if (focusGenRef.current === gen0 && !document.hidden && document.hasFocus() && !gatesBusy) {
          await attachSession(final.session_id);
          pushToast("ok", t("已连接 {0}", host.name));
        } else {
          // 后台完成：只更新标签态，不切视图不抢焦点（点击标签进入）
          pushToast("ok", t("已连接 {0}——点击标签进入", host.name));
        }
        // 返回值供快速连接表单决定是否关闭对话框（失败时保留已填内容重试）
        return true;
      } else if (final.phase === "Cancelled") {
        pushToast("info", t("已取消连接 {0}", host.name));
      } else if (final.phase === "CancelCloseFailed") {
        // 取消时已 Ready 且关闭失败：会话真实存在（无隐藏连接），如实告之从标签关闭
        await refreshLists();
        setConnError({
          title: t("取消 {0} 时会话已建立且关闭失败", host.name),
          detail: t("会话保留在标签栏——不再需要时请从标签 × 或 {0} 关闭", formatBinding(keymap["tab-close"], isMacPlatform())),
        });
      } else {
        // Failed：失败走 conn-error 常驻横幅（可行动文案），标签不建（attempt 未过门）
        // 七轮 A7-2：用户自己拒绝指纹（host_key_rejected）不是「地址/凭据有问题」——
        // 不标 lastFailed（卡上那句「检查地址与凭据后重试」会把人往死胡同引），
        // 文案改说「再连一次会重新询问」，重连即恢复
        const rejected = final.error?.kind === "host_key_rejected";
        if (!rejected) setLastFailed(host.id);
        const reason = final.error ? friendlyError({ kind: final.error.kind, message: final.error.message }) : t("未知原因");
        setConnError({
          title: t("连接 {0}（{1}@{2}:{3}）失败", host.name, host.username, host.address, host.port),
          detail: rejected
            ? reason + t("——这是你主动拒绝的结果；再次连接会重新出示指纹")
            : reason + t("——也可在主机卡上看到失败提示，修正后重试"),
        });
      }
    } catch (e) {
      // 同上：拒绝指纹走抛错路径时同样不污染「上次连接失败」标记
      const rejected = parseWireError(e).kind === "host_key_rejected";
      if (!rejected) setLastFailed(host.id);
      setConnError({
        title: t("连接 {0}（{1}@{2}:{3}）失败", host.name, host.username, host.address, host.port),
        detail: rejected
          ? friendlyError(e) + t("——这是你主动拒绝的结果；再次连接会重新出示指纹")
          : friendlyError(e) + t("——也可在主机卡上看到失败提示，修正后重试"),
      });
    } finally {
      pendingHostsRef.current.delete(lockId);
      if (draft && attemptId && quickAttemptRef.current === attemptId) quickAttemptRef.current = null;
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
    return false;
  };

  // —— P3 会话现场恢复：欢迎页一键入口。逐条目走既有建连全流程（TOFU/双因素
  // 原样把关，点了才连），新会话 term 挂载后先写恢复公告行、再 applyCheckpoint
  // 重放快照（历史进滚回、可视区/光标/模式复位）。主机已删或 20s 内未见新会话
  // 如实跳过并 toast；恢复完成后清空数据源（现场已被消费，陈旧快照不复活）。
  const restoreScenes = async (entries: RestoreEntry[]) => {
    if (restoringRef.current) return;
    restoringRef.current = true;
    let restored = 0;
    const skipped: string[] = [];
    // 部分成功不能把失败条目一起清掉：此前 restored>0 就 setRestoreEntries([])，
    // 一台连不上，另一台的现场入口也消失，失败条目本会话内再也无法重试。
    const failedEntries: RestoreEntry[] = [];
    try {
      for (const e of entries) {
        const host = hosts.find((x) => x.id === e.host_id);
        if (!host) { skipped.push(e.host_id); failedEntries.push(e); continue; }
        const before = new Set(sessionsRef.current.map((x) => x.id));
        void createSession(host);
        const sid = await new Promise<string | null>((resolve) => {
          const t0 = Date.now();
          const tick = () => {
            const fresh = sessionsRef.current.find((x) => !before.has(x.id) && x.host_id === e.host_id);
            if (fresh && termsRef.current.has(fresh.id)) return resolve(fresh.id);
            if (Date.now() - t0 > 20000) return resolve(null);
            setTimeout(tick, 250);
          };
          tick();
        });
        if (!sid) { skipped.push(host.name); failedEntries.push(e); continue; }
        const entry = termsRef.current.get(sid);
        if (!entry) { skipped.push(host.name); failedEntries.push(e); continue; }
        let when = e.saved_at;
        try { when = new Date(e.saved_at).toLocaleString(dateLocale()); } catch { /* 原样 */ }
        // 先重放再公告：applyCheckpoint 会重置缓冲（尺寸对齐+清屏），先写会被擦掉
        applyCheckpoint(entry.term, e.checkpoint);
        entry.term.write(`\r\n\x1b[2m—— ${t("已恢复上次会话现场（快照 {0}）", when)}——\x1b[0m\r\n`);
        // R3-C-1 同修：快照网格小于当前视口时 applyCheckpoint 缩行会把内容顶出可视区
        entry.term.scrollToBottom();
        restored++;
      }
    } finally {
      restoringRef.current = false;
    }
    if (restored > 0) pushToast("ok", t("已恢复 {0} 个会话现场", restored));
    if (skipped.length > 0) pushToast("err", t("{0} 个现场未恢复（主机已删或连接未就绪）：{1}——未恢复的条目仍保留在上次现场入口，可重试", skipped.length, skipped.join(t("、"))));
    // 只清成功消费的条目；失败的留着才能重试（全成功时 natural 清空）
    setRestoreEntries(failedEntries);
  };
  const restoringRef = useRef(false);

  // §302/§6.2：等待中可取消——终态经核心串行裁决，已取消只在核心确认后呈示。
  // 按 attemptId 取消（draft 建连的真实 attempt 无法用 hostId 反查），
  // 主机卡的 cancelConnect 与快速连接的 closeQuickConnect 共用这一个出口。
  const cancelAttempt = async (attemptId: string) => {
    try {
      const r = await invoke("cancel_connection", { attemptId }) as CancelOutcome;
      if (r.outcome === "already_ready") {
        // 成功已提交：核心已将刚建立的会话一并关闭（契约序列 1 无 session 遗留）——
        // 对账刷新标签；不存在隐藏连接
        await refreshLists();
        pushToast("info", t("取消时连接已完成——该会话已随之关闭"));
      } else if (r.outcome === "cancel_close_failed") {
        // 会话保留（关闭失败=恢复入口）：如实告之从标签关闭
        await refreshLists();
        setConnError({
          title: t("取消时会话已建立且关闭失败"),
          detail: t("会话保留在标签栏——不再需要时请从标签 × 或 {0} 再次关闭", formatBinding(keymap["tab-close"], isMacPlatform())),
        });
      }
      // cancelled / not_found：终态事件（或 demo 轮询）负责结算卡片与门
    } catch (e) {
      pushToast("err", friendlyError(e));
    }
  };
  const cancelConnect = async (hostId: string) => {
    const a = hostAttempt(hostId);
    if (!a) return;
    await cancelAttempt(a.attemptId);
  };

  // 快速连接关闭口（✕/取消/Esc 共用）：在途时先真取消 attempt，避免弹窗关了、
  // 数秒后仍建出标签并提示「已连接」。取消结果由核心终态与既有 toast 如实呈现。
  const closeQuickConnect = () => {
    quickConnectingRef.current = false;
    const aid = quickAttemptRef.current;
    if (aid) {
      quickAttemptRef.current = null;
      void cancelAttempt(aid);
    } else {
      // begin_connection_draft 尚未应答：先记取消意图，应答回来由 createSession 补取消
      quickCancelRequestedRef.current = true;
    }
    setShowQuickConnect(false);
  };

  // 断线会话一键重连：核心重建传输 + 重启泵 + 重注入；UI 订阅不变，输出自动恢复
  const [reconnecting, setReconnecting] = useState<string | null>(null);
  // 重连在途去重：右键菜单/标签列表/横幅可能在同一拍各发一次，核心对第二次返回
  // 「重连已在进行中」——UI 把它当失败弹红条，用户看到的是一次成功 + 一次假失败。
  const reconnectInFlightRef = useRef<Set<string>>(new Set());
  // R26（§6.4「可停止重试」）：核心旗标 ≤250ms 生效落 Disconnected；失败如实提示
  const stopRetry = async (s: SessionInfo) => {
    try {
      await invoke("stop_auto_reconnect", { sid: s.id });
      pushToast("info", t("已停止 {0} 的自动重连", s.host_name));
    } catch (e) { pushToast("err", friendlyError(e)); }
  };
  const reconnectSession = async (s: SessionInfo) => {
    // 双击/多入口同拍重入：第二发被核心以「重连已在进行中」拒绝，别把它当失败弹红
    if (reconnectInFlightRef.current.has(s.id)) return;
    reconnectInFlightRef.current.add(s.id);
    const gen0 = focusGenRef.current; // §6.3：重连完成不抢走用户期间转移的焦点
    setReconnecting(s.id);
    try {
      await invoke("reconnect_session", { sid: s.id });
      await refreshLists();
      const gatesBusy = hostKeyQueueRef.current.some((x) => x.host_id !== s.host_id)
        || authPromptQueueRef.current.some((x) => x.host_id !== s.host_id);
      if (focusGenRef.current === gen0 && !document.hidden && document.hasFocus() && !gatesBusy) {
        await attachSession(s.id);
        pushToast("ok", t("已重连 {0}", s.host_name));
      } else {
        pushToast("ok", t("已重连 {0}——点击标签进入", s.host_name));
      }
      // tmux 联动：勾了「下次自动」的主机，手动重连成功即静默恢复现场（确定性
      // 路径——demo 域 300ms 轮询会让事件钩子的 prev 判定错过窗口；真实域泵自动
      // 重连由 applyStateEvent 的事件钩子覆盖）。延迟 1.2s 等重注入/启动命令落定。
      if (s.kind === "ssh" && tmuxPrefsRef.current.auto.has(s.host_id)
        && !tmuxRestoringRef.current.has(s.id)) {
        window.setTimeout(() => {
          const sf = sessionsRef.current.find((x) => x.id === s.id);
          if (sf) void restoreTmuxRef.current?.(sf, undefined, true);
        }, 1200);
      }
    } catch (e) {
      setConnError({ title: t("重连 {0} 失败", s.host_name), detail: friendlyError(e) });
    } finally {
      reconnectInFlightRef.current.delete(s.id);
      setReconnecting(null);
    }
  };

  // 分屏窗格遮罩的「重连」按钮复用它（同一去重/错误提示路径，不新建重复会话）
  paneReconnectRef.current = (s) => { void reconnectSession(s); };

  // ---- tmux 联动（恢复现场轮）：对用户的唯一承诺是「远端现场，断线也丢不了」----
  // 恢复 = 重连全机器 + capture-pane 补史（写入本地 scrollback）+ 注入 attach，
  // 一个按钮一次点击。auto=true（勾了「下次自动」的断线重连）时静默进行，失败
  // 不打扰；核心侧注入带 2s 敲键守卫，绝不插队进用户正在输入的命令行。
  const [tmuxBusy, setTmuxBusy] = useState<string | null>(null);
  const attachTmux = (s: SessionInfo, name: string, windows: number, history: string | null, auto: boolean) => {
    const go = () => {
      invoke("tmux_attach", { sid: s.id, session: name, auto })
        .then(() => {
          updateTmuxPrefs((p) => ({ ...p, last: { ...p.last, [s.host_id]: name } }));
          pushToast("ok", t("已恢复现场（tmux {0} · {1} 个窗口）", name, String(windows)));
          // 七轮 A7-3：快接钮文案读 sessions[].tmux_attached，核心侧已置位但事件
          // 通道不带该字段——不主动对账就要等下一拍 3s 轮询，toast 与钮文案脱节
          // 最多 3s（实测 2.47s）。这里立刻拉一次列表（失败无害，轮询兜底）
          void refreshListsRef.current();
        })
        .catch((e) => { if (!auto) pushToast("err", friendlyError(e)); });
    };
    // 二段式：先补史再 attach——attach 后 tmux 立刻重绘整屏，必须先把近史写进
    // 本地 scrollback（capture-pane 行以 \n 分隔，xterm 需要 \r\n 防阶梯）。
    if (history && history.trim()) {
      const term = termsRef.current.get(s.id)?.term;
      if (term) {
        const body = "\r\n" + history.replace(/\r?\n/g, "\r\n");
        term.write(body.endsWith("\r\n") ? body : body + "\r\n", go);
        return;
      }
    }
    go();
  };
  const restoreTmuxScene = async (s: SessionInfo, name?: string, auto = false) => {
    if (tmuxRestoringRef.current.has(s.id)) return;
    tmuxRestoringRef.current.add(s.id);
    if (!auto) setTmuxBusy(s.id);
    try {
      const plan = await invoke("tmux_restore", { sid: s.id, session: name ?? null });
      if (plan.target) {
        attachTmux(s, plan.target.name, plan.target.windows, plan.history, auto);
      } else if (!auto && plan.sessions.length === 0) {
        // 目标已不在（会话被 kill/过期清单）：静默回退普通终端，如实说一句不弹错
        pushToast("info", t("远端会话已不在（可能已被关闭）——已回到普通终端"));
      }
    } catch (e) {
      if (!auto) pushToast("err", friendlyError(e));
    } finally {
      tmuxRestoringRef.current.delete(s.id);
      if (!auto) setTmuxBusy(null);
    }
  };
  restoreTmuxRef.current = restoreTmuxScene;

  // tmux 静默探测：SSH 会话首次活着的窗口里打一发（exec_fresh 独立通道零屏污
  // 染），结果进核心随 list_sessions 下发——断线横幅与 ⌘K 的数据源。失败不打扰，
  // 横幅降级为普通重连呈现；核心保留上次结果，断线后再探也拿不到新的。
  useEffect(() => {
    for (const s of sessions) {
      if (s.kind !== "ssh" || tmuxProbedRef.current.has(s.id)) continue;
      if (s.state !== "Connected" && s.state !== "Reconfirming") continue;
      tmuxProbedRef.current.add(s.id);
      // 坑 83：真实核心对 SSH 会话无条件回 Some(TmuxStatus)（未探测=available:false
      // 默认值）——判 `s.tmux` 真值会让静默探针在真域一次都不发（demo 未探测是
      // null，套件全绿纯属镜像语义差异）。必须判 available；每会话只探一次由
      // 上面的 probedRef 守卫（available=false 探过也不会重发）。
      if (s.tmux?.available) continue; // 核心已带可用清单（重连保留语义）
      invoke("tmux_probe", { sid: s.id })
        .then((st: TmuxStatus) => {
          setSessions((cur) => applyTabOrder(cur.map((x) => (x.id === s.id ? { ...x, tmux: st } : x))));
        })
        .catch(() => { /* 保持无清单态，横幅按无 tmux 呈现 */ });
    }
  }, [sessions]);

  // tmux 快接菜单（工具栏钮）：主动接入的唯一常驻入口。开菜单重探一发（静默探
  // 测每会话只打一发，清单可能陈旧；exec_fresh 独立通道零屏污染）；点选走恢复
  // 现场同链路（补史→attach/switch-client，prefs.last 同步记录）。
  const refreshTmuxList = (s: SessionInfo) => {
    invoke("tmux_probe", { sid: s.id })
      .then((st: TmuxStatus) => {
        setSessions((cur) => applyTabOrder(cur.map((x) => (x.id === s.id ? { ...x, tmux: st } : x))));
      })
      .catch(() => { /* 探测失败保留旧清单，不打扰 */ });
  };
  const pickTmuxSession = (s: SessionInfo, name: string) => {
    setTmuxMenu(false);
    void restoreTmuxScene(s, name);
  };
  // 面板中的会话一键切主视图（找茬四轮 D6）：收齐同名窗格再走既有接入链——此前
  // 菜单行 disabled+「先关窗格」，切回主视图要两跳。格是纯视图（detach 零损失可
  // 随时重开），收格后终态单视图，落在面板双向防呆（不许两路并存）允许侧。
  const promotePaneToMain = async (s: SessionInfo, name: string) => {
    setTmuxMenu(false);
    // 并行收格（找茬五轮 B-7）：串行 await 把 N 格 RTT 累加进关键路径，通道堵时
    // 点了菜单长时间无动作——与 closeTmuxPane 注释「界面不该陪着等」自相矛盾。
    // detach 先于接入的次序由 Promise.all 全 settle 后再接入保住；核心侧
    // tmux_pane_close 本轮起自带 3s 预算+后台补发（A-4），挂起面已收窄
    const closes: Promise<void>[] = [];
    for (const [, e] of [...paneTermsRef.current]) {
      if (e.sid === s.id && e.name === name) closes.push(closeTmuxPaneRef.current(e.sid, e.paneId));
    }
    await Promise.all(closes);
    void restoreTmuxScene(s, name);
  };

  // ---- 新建 tmux 会话（快接菜单作曲行）：远端 new-session -d，建好按目标落位 ----
  // 名字白名单/同名预检在 core；这里管 UX：成功=关作曲行+刷清单+走目标链路
  // （main=pickTmuxSession 既有 attach/switch 二段式；panel=openTmuxPaneCore 直接
  // 开格——建好即 attach 主视图的话「＋面板」对主视图会话是禁用的，新会话再也
  // 进不了面板）；失败=错误就地 role=alert，作曲行保持打开可改可重提。
  const [tmuxCreateOpen, setTmuxCreateOpen] = useState(false);
  const [tmuxCreateName, setTmuxCreateName] = useState("");
  const [tmuxCreateErr, setTmuxCreateErr] = useState<string | null>(null);
  const [tmuxCreateBusy, setTmuxCreateBusy] = useState(false);
  const [tmuxCreateTarget, setTmuxCreateTarget] = useState<"main" | "panel">("main");
  const submitTmuxCreate = async (s: SessionInfo) => {
    const name = tmuxCreateName.trim();
    if (!name || tmuxCreateBusy) return;
    // 面板目标先过防呆再建：建出孤儿会话（面板又进不去）比报错更糟。核心侧
    // 仍会兜底，这里只为「不建了就失败」把原因说在作曲行里
    if (tmuxCreateTarget === "panel") {
      if (groupOf(s.id)) { setTmuxCreateErr(t("分屏模式下不可并入面板——请先退出分屏")); return; }
      if ((s.panes ?? []).length >= PANE_MAX) {
        setTmuxCreateErr(t("面板已满（最多 {0} 个窗格）——请先关掉一个窗格，或改为接入主视图", "5"));
        return;
      }
    }
    setTmuxCreateBusy(true); setTmuxCreateErr(null);
    try {
      await invoke("tmux_session_create", { sid: s.id, name });
      setTmuxCreateOpen(false); setTmuxCreateName("");
      refreshTmuxList(s);
      if (tmuxCreateTarget === "panel") {
        setTmuxMenu(false);
        // 复用开格链（自带「已并入面板」toast / 聚焦新格 / 清单刷新 / 错误 toast）；
        // 建都建成了，开格失败不再弹第二条——清单里能看见它，重开菜单点「＋面板」即可
        void openTmuxPaneCore(s, name, false);
      } else {
        pickTmuxSession(s, name);
        pushToast("ok", t("已创建并接入 tmux 会话「{0}」", name));
      }
    } catch (e) {
      setTmuxCreateErr(friendlyError(e));
    } finally {
      setTmuxCreateBusy(false);
    }
  };
  // 菜单关（点选/开面板/点外）即弃作曲行残态——下次打开是干净的（目标回默认）
  useEffect(() => {
    if (!tmuxMenu) {
      setTmuxCreateOpen(false); setTmuxCreateName(""); setTmuxCreateErr(null);
      setTmuxCreateTarget("main");
    }
  }, [tmuxMenu]);

  // ---- tmux 面板（一标签多 tmux 会话）：开格 / 关格 ----
  // 开格核心：同连接附加交互通道跑 `tmux -u attach`（核心侧防呆：同会话两路视图、
  // 同名格、上限、存在性核验）。返回即乐观建格（不等 3s 快照），布局 + fit 后聚焦新格。
  // quiet=true（工作空间恢复）：不打扰——不弹 per-格 toast、不抢焦点；Gone（tmux
  // 会话已不在服务器）单独归类给调用方做汇总。核心把 Gone 落成 invalid_input +
  // 「tmux 会话不存在」文案（handle.rs pane_open_inner；demo 镜像同文案），消息
  // 判别是既有错误契约下最窄的可靠归位。
  const openTmuxPaneCore = async (s: SessionInfo, name: string, quiet = false): Promise<{ ok: boolean; gone: boolean }> => {
    if (groupOf(s.id)) {
      if (!quiet) pushToast("info", t("分屏模式下不可并入面板——请先退出分屏"));
      return { ok: false, gone: false };
    }
    try {
      const main = termsRef.current.get(s.id)?.term;
      const cols = main ? Math.max(20, Math.floor(main.cols / 2)) : 80;
      const rows = main ? Math.max(6, main.rows) : 24;
      const p = await invoke("tmux_pane_open", { sid: s.id, session: name, cols, rows });
      await ensurePaneTerm(s.id, p.pane_id, p.tmux_session);
      layoutTmuxPanes();
      fitTerminal();
      setTimeout(() => fitTerminal(), 150);
      if (!quiet) paneTermsRef.current.get(`${s.id}:${p.pane_id}`)?.term.focus(); // quiet 不抢焦点：活动标签会把用户正敲的键导进新格（恢复等待期用户已在主视图干活）
      if (!quiet) pushToast("ok", t("已并入面板：{0}", name));
      void refreshLists();
      return { ok: true, gone: false };
    } catch (e) {
      if (!quiet) { pushToast("err", errMsg(e)); return { ok: false, gone: false }; }
      const pe = parseWireError(e);
      return { ok: false, gone: pe.kind === "invalid_input" && pe.message.includes("不存在") };
    }
  };
  const openTmuxPane = (s: SessionInfo, name: string) => {
    setTmuxMenu(false);
    void openTmuxPaneCore(s, name, false);
  };

  // ---- 工作空间轮：重启级组合恢复 ——「重连上次会话」升级为全量恢复 ----
  // 逐台并行建连（restoreScenes 同款 tick 等待），连上即开格不等其他主机（一台
  // 关机的老机器不能拖累健康主机的格子干等 20s）；门（指纹/双因素）挂在本主机上
  // 时暂停计时——门按用户节奏走，20s 是给「连不上」的不是给「人在核对指纹」的。
  // Connected 后按保存序逐格开（openTmuxPaneCore quiet）→ 该主机格子全部就绪后
  // 一次性播种布局树（时序关键：边开边播种会被 syncLayout 反复摘未开键、空间还
  // 给兄弟，最终权重退化）→ 主视图 attach 静默恢复（restoreTmuxScene auto，复用
  // 2s 敲键守卫链）。任何一台/一格失败只跳过并汇总，不中断其他主机。
  const wsRestoreRef = useRef(false);
  const layoutLeafKeys = (n: PaneNode | null, acc: string[] = []): string[] => {
    if (!n) return acc;
    if (n.kids) { for (const k of n.kids) layoutLeafKeys(k, acc); return acc; }
    acc.push(n.key);
    return acc;
  };
  const restoreLastWorkspace = async () => {
    if (wsRestoreRef.current || restoringRef.current) return;
    wsRestoreRef.current = true;
    restoringRef.current = true; // 与「恢复上次现场」互斥（两条批量建连路径不得交叉）
    let hostsOk = 0, panesOk = 0;
    const hostsSkipped: string[] = [];
    const goneNames: string[] = [];
    const failedNames: string[] = [];
    try {
      const rows = lastSessionHosts
        .map((hid) => hosts.find((h) => h.id === hid))
        .filter((h): h is Host => !!h);
      if (rows.length === 0) return;
      const seeds = rows.map(async (host) => {
        const before = new Set(sessionsRef.current.map((x) => x.id));
        void createSession(host);
        const t0 = Date.now();
        let sf: SessionInfo | null = null;
        for (;;) {
          const fresh = sessionsRef.current.find((x) => !before.has(x.id) && x.host_id === host.id);
          if (fresh && fresh.state === "Connected") { sf = fresh; break; }
          if (fresh && fresh.state === "Closed") break;
          // 门按 host_id 归属（ProxyJump 跳板门是跳板 host_id，属罕见的漏计场景：
          // 跳板门挂起时照常计时，到点按未就绪跳过）；建连失败不建标签（attempt
          // 未过门），只能等满计时按「未就绪」跳过
          const gated = hostKeyQueueRef.current.some((g) => g.host_id === host.id)
            || authPromptQueueRef.current.some((g) => g.host_id === host.id);
          if (!gated && Date.now() - t0 > 20000) break;
          await new Promise((r) => setTimeout(r, 250));
        }
        if (!sf) { hostsSkipped.push(host.name); return; }
        hostsOk++;
        const combo = lastWorkspaceCombos.find((c) => c.host_id === host.id);
        if (!combo) return;
        // 顺序 await 开格（PANE_MAX 上限内）；后台标签的格子几何在切回该标签时
        // 由 layoutTmuxPanes 按播种树套用
        const opened: string[] = [];
        for (const name of combo.sessions.slice(0, PANE_MAX)) {
          const r = await openTmuxPaneCore(sf, name, true);
          if (r.ok) opened.push(name);
          else if (r.gone && !goneNames.includes(name)) goneNames.push(name);
          else if (!failedNames.includes(name)) failedNames.push(name);
        }
        panesOk += opened.length;
        // 播种布局：实开格子是保存树叶子（除主视图）的子集即套用——syncLayout 会
        // 摘掉没开成的键、权重在兄弟间重摊（全等才套用的旧条件会让一格 Gone 连坐
        // 整棵树落自动平铺，其余格子的自定义布局白白丢弃）
        const layout = sanitizeLayoutTree(combo.layout ?? null);
        const want = layout ? layoutLeafKeys(layout).filter((k) => k !== MAIN_KEY) : [];
        if (layout && want.length > 0 && opened.length > 0 && opened.every((k) => want.includes(k))) {
          paneLayoutRef.current.set(sf.id, layout);
          if (sidRef.current === sf.id) layoutTmuxPanes();
        }
        if (combo.attached && !sf.tmux_attached) {
          const sfn = sessionsRef.current.find((x) => x.id === sf.id);
          if (sfn) void restoreTmuxScene(sfn, combo.attached, true);
        }
      });
      await Promise.all(seeds);
    } finally {
      wsRestoreRef.current = false;
      restoringRef.current = false;
    }
    if (panesOk > 0) pushToast("ok", t("已恢复上次工作空间：{0} 个主机 · {1} 个 tmux 窗格", String(hostsOk), String(panesOk)));
    if (hostsSkipped.length > 0) {
      pushToast("err", t("{0} 个主机未恢复（20 秒内未连上，或停在指纹/双因素确认）：{1}", String(hostsSkipped.length), hostsSkipped.join(t("、"))));
    }
    if (goneNames.length > 0) {
      pushToast("err", t("{0} 个 tmux 会话已不在服务器，已跳过：{1}", String(goneNames.length), goneNames.join(t("、"))));
    }
    if (failedNames.length > 0) {
      pushToast("err", t("{0} 个 tmux 窗格未能并入面板：{1}", String(failedNames.length), failedNames.join(t("、"))));
    }
  };
  // 关格：只拆客户端通道（detach），tmux 会话与其中进程继续运行。先收格再通知核心——
  // 后端关通道可能卡在写锁上（远端停读时的写入），界面不该陪着等；核心侧已不存在
  // （掉线摘除/重建换装）同样照常收格。关闭时刻记入 paneClosedRef——在途的旧快照
  // 仍列着它时，对账 5s 内不重建（防关了又闪回）。
  const closeTmuxPane = async (sid: string, paneId: number) => {
    const key = `${sid}:${paneId}`;
    const e = paneTermsRef.current.get(key);
    // 正在搜这个格：先收查找框，别把 addon 指到已 dispose 的终端
    if (searchTargetKeyRef.current === key) closeSearch();
    paneClosedRef.current.set(key, Date.now());
    disposePane(key);
    layoutTmuxPanes();
    fitTerminal();
    setTimeout(() => fitTerminal(), 150);
    if (e) pushToast("ok", t("已关闭窗格：{0}（tmux 会话仍在运行）", e.name));
    // 只回到“记忆中的子窗口”：关的是未聚焦格时别把焦点从另一个格子抢回主视图
    if (sid === sidRef.current) focusTermFor(sid);
    try { await invoke("tmux_pane_close", { sid, paneId }); } catch { /* 已不在核心侧：照常收格 */ }
    void refreshLists();
  };
  closeTmuxPaneRef.current = closeTmuxPane;

  // 墙 props 稳定化（找茬四轮 B3 的 memo 前提）：内联闭包每渲染换引用 = TmuxWall
  // 的 memo 形同虚设，App 每 3s 的整树 diff 直接砸进墙的逐字符 ANSI 重算。deps 钉
  // wallSession（sameShape 复用旧引用——数据没变时回调引用稳定）；openTmuxPane 走
  // ref 斩断依赖链。
  const openTmuxPaneRef = useRef(openTmuxPane);
  openTmuxPaneRef.current = openTmuxPane;
  const wallFetchCells = useCallback(async (): Promise<Array<[string, TmuxWallCell]>> => {
    if (!wallSession) return [];
    // targets 在**请求发出时**定格并配好格键——回包与键成对，await 窗口
    // 内 3s 会话轮询改清单（杀/建/改名）也不会单拍错位
    const src = wallSession.tmux?.sessions ?? [];
    const cells = await invoke("tmux_wall_snapshot", {
      sid: wallSession.id,
      targets: src.map((x) => ({ id: x.id ?? "", name: x.name })),
    });
    return cells.map((c, i) => [src[i] ? (src[i].id || src[i].name) : "", c]);
  }, [wallSession]);
  const wallSendInput = useCallback(
    async (target: TmuxWallTarget, lit: string, keys: string[]): Promise<TmuxWallCell> =>
      invoke("tmux_wall_input", { sid: wallSession?.id ?? "", target, lit, keys }),
    [wallSession],
  );
  // 墙视图粘贴收口（与主终端同一张危险形态表）：墙走服务端 send-keys -l 字面
  // 通道，没有 bracketed paste——多行粘贴的每个换行都会被远端立即执行，因此
  // 换行一律先确认。确认后回调 accept 把文本送回墙的字面批量。
  const wallPasteAcceptRef = useRef<((text: string) => void) | null>(null);
  const requestWallPaste = useCallback((text: string, accept: (text: string) => void) => {
    if (!text) return;
    const deliver = (risk: PasteHit[]) => {
      const multi = /[\n\r]/.test(text);
      if (multi || risk.length) {
        wallPasteAcceptRef.current = accept;
        setPasteConfirm({
          sid: wallSession?.id ?? "",
          hostName: `${wallSession?.host_name ?? t("该会话")} · ${t("tmux 墙")}`,
          text,
          risk,
          multi,
          kind: "wall",
        });
      } else {
        accept(text);
      }
    };
    if (pasteGuardRef.current && PASTE_DANGER_PREFILTER.test(text)) {
      invoke("scan_paste_danger", { text })
        .then((hits) => deliver(hits ?? []))
        .catch(() => deliver([])); // 扫描失败不阻断人类操作：退回多行确认口径
    } else {
      deliver([]);
    }
  }, [wallSession]);
  // 确认框任何关闭路径（发送/取消/Esc/点遮罩）都丢弃待决 accept，防迟到确认
  // 把旧文本送进已变的墙。
  useEffect(() => {
    if (!pasteConfirm) wallPasteAcceptRef.current = null;
  }, [pasteConfirm]);
  // pane 贴格子：resize 成格子字符预算（守卫在核心；attach 客户端在场照样贴），
  // 返回每格原样回执供关墙恢复留存。失败静默——300ms 节拍的 pane_height 就是
  // 反馈环，contain 缩放兜底照常呈现。
  const wallFitPanes = useCallback(
    async (fits: TmuxWallFit[]): Promise<TmuxWallFitResult[]> => {
      if (!wallSession || !fits.length) return [];
      return await invoke("tmux_wall_fit", { sid: wallSession.id, fits });
    },
    [wallSession],
  );
  // 关墙恢复：sid 由墙组件 prop 钉死后随调用带回（组件卸载 cleanup 拿到的是
  // 最后提交渲染闭包的 prop，不受「关墙置空 wallSession」竞态影响），回调本身
  // 零依赖不换引用，也不会把 A 墙的迟到恢复串到 B 的连接上。
  const wallRestorePanes = useCallback(async (sid: string, items: TmuxWallRestoreItem[]) => {
    if (!sid || !items.length) return;
    await invoke("tmux_wall_fit_restore", { sid, items });
  }, []);
  const wallPromote = useCallback(
    (name: string) => {
      setTmuxWallSid(null);
      const s = wallSession;
      if (s) void openTmuxPaneRef.current(s, name);
    },
    [wallSession],
  );
  const wallClose = useCallback(() => setTmuxWallSid(null), []);

  const takeover = async () => {
    if (!sid) return;
    try {
      await invoke("set_control", { sid, owner: "Human", stopRunning: false });
      // 冻结后模型若还在流式生成，面板看起来「Agent 还在干活」也白烧 token：
      // 只停模型生成（工具已被冻结）；在跑的命令仍按「接管」承诺不中断。
      if (embeddedReady) void invoke("agent_cancel_model", { sid }).catch(() => {});
      await refreshLists();
      pushToast("info", t("已接管——Agent 冻结，终端归你"));
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
  // 内嵌 Agent 的轻量委托：Agent 视图发送门用（不走 MCP 协作对话框——控制权交托
  // 同一个核心 delegate_session，目标留空；返回 true=已交托，调用方继续发送）。
  const delegateEmbedded = async (): Promise<boolean> => {
    if (!sid) return false;
    try {
      await invoke("delegate_session", { sid, goal: null });
      await refreshLists();
      pushToast("info", t("已把会话交给内置 Agent——工具栏「接管」随时收回"));
      return true;
    } catch (e) {
      pushToast("err", friendlyError(e));
      return false;
    }
  };
  // 内嵌 agent 自主模式（人类授权，按 client_id 记账）：免逐条审批，deny 名单
  // 仍硬拦、传输仍逐条、审计 outcome=Autonomous 可辨；急停行（autonomy_list 变化）
  // 与此处同源——刷新后状态一致。ttl 传 null = 手动关闭才失效。
  const toggleEmbeddedAutonomy = async (enable: boolean) => {
    try {
      await invoke("set_autonomy", { agentId: EMBEDDED_AGENT_ID, enable, ttlMinutes: null });
      if (!enable) autonomyKilledRef.current.add(EMBEDDED_AGENT_ID);
      await refreshLists();
      enable
        ? pushToast("ok", t("已开启自主模式：命令免逐条审批（危险名单仍拦截、传输仍逐条、全量记录，急停条可撤回）"))
        : pushToast("info", t("已关闭自主模式：恢复逐条审批"));
    } catch (e) {
      pushToast("err", t("自主模式切换失败：{0}", errMsg(e)));
    }
  };
  // R42（§6.7）首次委托 / 交还：**显式提交**的同一个受控转换（核心 delegate_session）。
  // 取消对话框不改动控制权；核心成功返回才切 Agent-owned；任务目标可选（留空**不清除**
  // 既有目标——与「任务目标」栏的清除语义不同）。服务未启用时先引导设置接入，返回后
  // 仍须在此单独确认转交（不自动提交）。
  const [delegateGoal, setDelegateGoal] = useState("");
  const [delegateCap, setDelegateCap] = useState<ShellCapability | null>(null);
  const [delegateBusy, setDelegateBusy] = useState(false);
  const [delegateErr, setDelegateErr] = useState<string | null>(null);
  const openDelegate = () => {
    setDelegateGoal(brief?.goal ?? "");
    setDelegateErr(null);
    setDelegateCap(null);
    setDelegateDlg(true);
    if (sid) invoke("shell_capability", { sid }).then(setDelegateCap).catch(() => setDelegateCap(null));
  };
  const closeDelegate = () => {
    setDelegateDlg(false); setDelegateGoal(""); setDelegateErr(null); setDelegateBusy(false);
  };
  const submitDelegate = async () => {
    if (!sid || delegateBusy || (!collabConfigured && !embeddedReady)) return;
    setDelegateBusy(true); setDelegateErr(null);
    try {
      const g = delegateGoal.trim();
      await invoke("delegate_session", { sid, goal: g ? g : null });
      const wasAgent = !!current?.ever_agent_owned;
      closeDelegate();
      await refreshLists();
      void refreshBrief(sid);
      pushToast("info", wasAgent ? t("已交还 Agent——后续操作请求走审批") : t("已交给 Agent——后续操作请求走审批"));
    } catch (e) {
      setDelegateErr(friendlyError(e));
      setDelegateBusy(false);
    }
  };

  // C9（R43）协作启用生命周期（人类专属）。停用：先预览影响 → 用户确认 → 核心**原子**
  // 封 admission（立即拒绝新 Agent 请求，不等待逐个接管）并作废存量；重新启用须**显式**
  // 且核心确认旧停用已收敛（先前作废请求不复活）。失败保持封闭，UI 提供重试/查询。
  const openDisableDialog = async () => {
    if (collabBusy) return;
    setCollabBusy(true);
    try {
      setDisableImpact(await invoke("collab_disable_preview"));
    } catch (e) { pushToast("err", friendlyError(e)); }
    finally { setCollabBusy(false); }
  };
  const confirmDisable = async () => {
    if (collabBusy) return;
    setCollabBusy(true);
    try {
      const r = await invoke("collab_disable");
      setDisableImpact(null);
      setCollab(await invoke("collab_status"));
      setMcp(await invoke("mcp_status"));
      await refreshLists();
      pushToast("info", t("协作已停用——作废 {0} 个待审批、{1} 个 Agent 会话转回你控制", r.voided_approvals, r.converted_sessions));
    } catch (e) { pushToast("err", friendlyError(e)); }
    finally { setCollabBusy(false); }
  };
  const enableCollab = async () => {
    if (collabBusy) return;
    setCollabBusy(true);
    try {
      const st = await invoke("collab_enable");
      setCollab(st);
      setMcp(await invoke("mcp_status"));
      if (st && st.endpoint) pushToast("ok", t("协作已启用——MCP 端点运行中，可签发 Token 接入 Agent"));
      else pushToast("err", t("协作已启用，但 MCP 端点未运行——Agent 无法接入（请检查端口占用）"));
    } catch (e) { pushToast("err", friendlyError(e)); }
    finally { setCollabBusy(false); }
  };
  // C9（R43）：DisableFailed = 停用未收敛（admission 仍封闭）。重试 = 再跑一次停用收敛
  // （核心 collab_disable 从 DisableFailed 重新封口并收敛），收敛为 Disabled 后再启用。
  const retryDisableConvergence = async () => {
    if (collabBusy) return;
    setCollabBusy(true);
    try {
      const r = await invoke("collab_disable");
      setCollab(await invoke("collab_status"));
      setMcp(await invoke("mcp_status"));
      await refreshLists();
      pushToast("info", t("停用已收敛——作废 {0} 个待审批、{1} 个 Agent 会话转回你控制", r.voided_approvals, r.converted_sessions));
    } catch (e) { pushToast("err", friendlyError(e)); }
    finally { setCollabBusy(false); }
  };

  // rev-r47：Agent 生命周期（GUI 内签发/吊销，不再强制去 CLI）。签发返回 token
  //（仅此一次展示，由设置页弹层呈现）；成功后刷新 mcp_status 投影。
  const issueAgent = async (id: string, label: string, expiresDays: number | null): Promise<string> => {
    const token = await invoke("issue_agent", { id, label, expires_days: expiresDays });
    setMcp(await invoke("mcp_status"));
    return token;
  };
  const revokeAgent = async (id: string): Promise<void> => {
    await invoke("revoke_agent", { id });
    setMcp(await invoke("mcp_status"));
  };

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editedCmd, setEditedCmd] = useState("");
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [persistId, setPersistId] = useState<string | null>(null);
  const [persistPattern, setPersistPattern] = useState("");
  const approvalErrText = (err: unknown): string => {
    const msg = errMsg(err);
    // 双击批准/超时竞态：核心的错误原文是 "no pending approval with this id"，
    // 对用户没有意义——明确告知该审批已处理，并让列表刷新收卡。
    return /no pending approval|pending approval with this id/i.test(msg)
      ? t("该审批已处理或已超时——列表即将刷新")
      : msg;
  };
  const decide = async (id: string, decision: "approve" | "deny" | "edit", edited: string | null) => {
    // 并发作废（接管/关会话）会拒绝决定（审计 F3）：无 catch 时 unhandled
    // rejection + 编辑态卡死到下次轮询。失败如实上报、编辑态保留（卡片随轮询刷新）
    try {
      await invoke("decide_approval", { id, decision, edited });
    } catch (err) {
      pushToast("err", approvalErrText(err));
      void refreshLists();
      return;
    }
    setEditingId(null);
    setConfirmId(null);
    setPersistId(null);
    await refreshLists();
  };
  // 「批准并记住」（审批减摩擦①）：先写策略再批准。记忆失败不阻断批准——
  // 批准是人类显式意图，记忆只是增益；错误如实上报（如实降级为普通批准）。
  const rememberThenDecide = async (
    id: string,
    scope: { ttlMinutes: number } | { pattern: string },
  ) => {
    try {
      const patterns = await invoke("remember_approval", {
        id,
        ttlMinutes: "ttlMinutes" in scope ? scope.ttlMinutes : null,
        pattern: "pattern" in scope ? scope.pattern : null,
      });
      pushToast("ok", t("已记住：{0}", patterns.join("；")));
    } catch (err) {
      pushToast("err", t("记忆规则未写入：{0}", errMsg(err)));
    }
    await decide(id, "approve", null);
  };
  // ② 自主模式急停（横幅按钮）：立即收回该 Agent 的免审批授权
  const killAutonomy = useCallback(async (agentId: string) => {
    autonomyKilledRef.current.add(agentId); // ⑧ 人工收回：差分提示不再报「到期」
    try {
      await invoke("set_autonomy", { agentId, enable: false });
      pushToast("ok", t("已收回 {0} 的自主模式", agentId));
    } catch (err) {
      // 关闭失败：授权仍在，不能把「人工收回」记账留下（否则真正到期时
      // 差分提示会被误抑制）。
      autonomyKilledRef.current.delete(agentId);
      pushToast("err", errMsg(err));
    }
    await refreshLists();
  }, [pushToast, refreshLists]);
  // ② 自主模式开关（设置页）：enable + 可选 TTL（分钟）
  const toggleAutonomy = useCallback(async (agentId: string, enable: boolean, ttlMinutes: number | null) => {
    if (!enable) autonomyKilledRef.current.add(agentId); // ⑧ 人工关闭：不报「到期」
    try {
      await invoke("set_autonomy", { agentId, enable, ttlMinutes });
      pushToast("ok", enable ? t("已开启 {0} 自主模式", agentId) : t("已关闭 {0} 自主模式", agentId));
    } catch (err) {
      if (!enable) autonomyKilledRef.current.delete(agentId);
      pushToast("err", errMsg(err));
      return;
    }
    await refreshLists();
  }, [pushToast, refreshLists]);

  // ---- ④ 记录审计时间线（数据面；呈现见 components/records-pane.tsx）----
  // ⑨ range 只存档位，since 在拉取时刻换算（久置页面的「今天」边界不漂移）
  const recordsFilterPayload = useCallback(
    (f: RecordsQuery, until?: string | null) => ({ ...f, since: recordsRangeSince(f.range), until: until ?? null }),
    [],
  );
  const refreshRecords = useCallback(async (f: RecordsQuery) => {
    setRecordsBusy(true);
    try {
      const rows = (await invoke("query_records", { filter: recordsFilterPayload(f) })) as ActionRecord[];
      setRecordsRows(rows);
      setRecordsComplete(rows.length < f.limit);
    } catch {
      // 记录库读不出来（目录异常等）给空态而非报错弹窗——时间线是回看面，不阻塞设置
      setRecordsRows([]);
      setRecordsComplete(true);
    } finally {
      setRecordsBusy(false);
    }
  }, [recordsFilterPayload]);

  // ⑥ 「加载更早」：游标 = 已载最旧 ts − 1ms（核心 until 为 <= 含端点，同毫秒多条
  // 随游标一起翻走）；追加前按 seq 去重只是双击竞态兜底
  const loadMoreRecords = useCallback(async () => {
    const rows = recordsRows;
    if (!rows || rows.length === 0 || recordsMoreBusy) return;
    setRecordsMoreBusy(true);
    try {
      const until = new Date(new Date(rows[rows.length - 1].ts).getTime() - 1).toISOString();
      const batch = (await invoke("query_records", { filter: recordsFilterPayload(recordsFilter, until) })) as ActionRecord[];
      const seen = new Set(rows.map((r) => r.seq));
      setRecordsRows([...rows, ...batch.filter((r) => !seen.has(r.seq))]);
      setRecordsComplete(batch.length < recordsFilter.limit);
    } catch (err) {
      pushToast("err", t("加载更早失败：{0}", errMsg(err)));
    } finally {
      setRecordsMoreBusy(false);
    }
  }, [recordsRows, recordsFilter, recordsMoreBusy, recordsFilterPayload, pushToast]);

  // 打开「记录审计」分区或筛选变化即拉取；手动「刷新」按钮走同一入口
  useEffect(() => {
    if (settingsCat === "records") void refreshRecords(recordsFilter);
  }, [settingsCat, recordsFilter, refreshRecords]);

  const exportRecords = useCallback(async () => {
    setRecordsExportBusy(true);
    try {
      const r = (await invoke("export_records", { filter: recordsFilter })) as { count: number; path: string };
      pushToast("ok", t("已导出 {0} 条 → {1}", r.count, r.path));
    } catch (err) {
      pushToast("err", t("导出失败：{0}", errMsg(err)));
    } finally {
      setRecordsExportBusy(false);
    }
  }, [recordsFilter, pushToast]);

  // ---- ⑤ 自主模式传输免审 opt-in（vault 设置持久；重启保留，随时刻关）----
  const changeTransferAutonomy = useCallback((v: boolean) => {
    setTransferAutonomy(v);
    persistSetting("collab.autonomy.transfers", v ? "1" : "");
  }, [persistSetting]);

  // ---- ⑦ 记录保留期（vault 设置持久；超期清理发生在启动 open，重启后生效）----
  const changeRecordsRetention = useCallback((days: number) => {
    setRecordsRetention(days);
    persistSetting("collab.records.retention_days", String(days));
    pushToast("ok", t("记录保留期已保存，重启后生效"));
  }, [persistSetting, pushToast]);

  // 审批卡风险分级 approvalRisk 已随审批卡出仓 components/collab-panel.tsx（拆分⑤）

  // 控制权徽标
  useEffect(() => {
    const s = sessions.find((x) => x.id === sid);
    setOwner(s ? s.control_owner : "Human");
  }, [sessions, sid]);

  // 内嵌 Agent 就绪（已配模型服务）：委托/接管入口的第二把钥匙——此前这些入口
  // 全部门控 MCP 协作，内嵌 agent 无 MCP 配置时无法进入委托态（exec 一律
  // ControlTakenByHuman），第一公里断裂。demo（非 inTauri）恒 false，界面零变化。
  const [agentModelReady, setAgentModelReady] = useState(false);
  useEffect(() => {
    if (!inTauri) return;
    const load = () =>
      invoke("agent_model_get", {})
        .then((v) => setAgentModelReady(!!v))
        .catch(() => setAgentModelReady(false));
    load();
    window.addEventListener("agent-model-saved", load);
    return () => window.removeEventListener("agent-model-saved", load);
  }, []);
  const embeddedReady = inTauri && agentModelReady;

  // C9（R43）：admission 门只在 Enabled 开放——停用/停用中/停用失败一律按「未启用」对待
  //（失败保持封闭，不得回退为可用）。Disabling/DisableFailed 时主界面不出现空审批区。
  const collabEnabled = collab.state === "Enabled";
  const collabStateText = collab.state === "Enabled" ? t("协作已启用")
    : collab.state === "Disabling" ? t("停用中")
    : collab.state === "DisableFailed" ? t("停用失败（保持封闭）")
    : t("协作已停用");
  const hasAgents = collabEnabled && mcp.agents.length > 0;
  const current = sessions.find((x) => x.id === sid);
  // 后台会话断线必须出声：盯着 A 标签时 B 掉线此前无任何提示（重连横幅只属于
  // 当前会话），切过去才发现命令没跑。只在进入 Disconnected 的那一拍提示一次；
  // Degraded/Reconnecting 是自动重连的中间态，不打扰。
  const prevSessionStatesRef = useRef(new Map<string, string>());
  useEffect(() => {
    const prev = prevSessionStatesRef.current;
    const next = new Map<string, string>();
    const lost: string[] = [];
    for (const s of sessions) {
      next.set(s.id, s.state);
      const was = prev.get(s.id);
      if (was && was !== "Disconnected" && s.state === "Disconnected" && s.kind === "ssh" && s.id !== sidRef.current) {
        lost.push(s.host_name);
      }
    }
    prevSessionStatesRef.current = next;
    if (lost.length) pushToast("err", t("后台会话已断开：{0}", lost.join(t("、"))));
  }, [sessions, pushToast]);
  const pendingApprovals = approvals.filter((a) => a.status === "pending");
  const pendingCount = pendingApprovals.length;
  // 已处理的审批不再整卡展示，折叠为最近几条一行记录
  const resolvedApprovals = approvals.filter((a) => a.status !== "pending").slice(-3).reverse();
  // R42（§3.2/§6.7）：协作入口的两种触发——「有协作配置」常显入口；
  // 「有实际待审批或 Agent 控制活动」必须显示提醒（不因面板开关/入口偏好而隐藏）。
  // C9（R43）：停用后不再显示协作入口——重新启用走「设置 → Agent 接入」。
  const collabConfigured = collabEnabled && mcp.agents.length > 0;
  // 协作面可用性：内置 Agent（模型已接入）同样能走委托/审批，不能因为没登记
  // MCP Agent 就把整个协作面当成「未接入」藏起来——否则内置 Agent 的第一公里
  // 断裂（委托入口/审批区都不出现）。
  const agentSurfaceReady = collabConfigured || embeddedReady;
  // 控制权徽标：Agent 面可用才算「Agent 可接管」，否则按手动控制显示（不能让内置
  // Agent 就绪时仍显示「手动控制」）。
  const ownerCls = owner === "Human" ? "human" : agentSurfaceReady ? "agent" : "dim";
  const collabActive = collabEnabled && (pendingCount > 0 || sessions.some((s) => s.control_owner === "Agent"));
  // §3.2：跨会话审批按「主机 + 会话」明确分组——绝不只展示「当前主机」而误批其他会话。
  const approvalGroups = useMemo(() => {
    const bySid = new Map<string, { sess?: SessionInfo; items: ApprovalRow[] }>();
    for (const a of pendingApprovals) {
      let g = bySid.get(a.session_id);
      if (!g) { g = { sess: sessions.find((x) => x.id === a.session_id), items: [] }; bySid.set(a.session_id, g); }
      g.items.push(a);
    }
    return [...bySid.entries()]
      .map(([sidKey, g]) => ({ sid: sidKey, sess: g.sess, items: g.items }))
      .sort((x, y) => (x.sess?.host_name ?? "￿").localeCompare(y.sess?.host_name ?? "￿", "zh") || x.sid.localeCompare(y.sid));
  }, [pendingApprovals, sessions]);

  const currentHost = current ? hosts.find((h) => h.id === current.host_id) : undefined;
  // UX 五轮：默认编码 UTF-8 不再上状态条（没有 ssh client 关心默认编码；GBK 例外
  // 保留——乱码排查信号，编码自适应的入口仍在连接详情/主机编辑）
  const sbLeft = current
    ? `${currentHost?.address === "local" ? t("本地") : "SSH"}${currentHost?.charset === "gbk" ? " · GBK" : ""}`
    : t("未连接");
  // R35 状态条计数=进行中任务（排队/传输/提交/取消中/待决——§194 后台事件只更新计数）
  const runningTransfers = transfers.filter((t) => t.status === "running" || t.status === "queued" || t.status === "committing" || t.status === "cancelling" || t.status === "awaiting").length;
  // 冲突待裁决数（计数含 awaiting 但裸数字不引人——warn 色提醒「有卡在等人」）
  const awaitingTransfers = transfers.filter((t) => t.status === "awaiting").length;
  // §358 队列行须展示「主机/会话」——抽屉是窗口级（list_transfers 全量、跨会话），
  // 会话不再由所在面板隐含，故按 sid 回查主机名；会话已不在时回退短 id（如实不虚构）。
  const hostLabel = (sid?: string): string =>
    !sid ? "—" : sessions.find((s) => s.id === sid)?.host_name ?? sid.slice(0, 8);
  // tmux 联动二（Agent 分窗）：活动会话已 attach tmux 时给 agent 面板一行说明
  //（命令自动落远端专属窗口 tinyssh-agent——切过去可旁观、当前窗口不受打扰）。
  // fleet 编排者跨主机不落专窗，不显示。
  const activeTmuxAttached = sid
    ? sessions.find((s) => s.id === sid)?.tmux_attached ?? null
    : null;
  const tmuxAgentNote = !fleetOpen && activeTmuxAttached
    ? t("Agent 的命令会自动进远端专属 tmux 窗口（tinyssh-agent）执行——切过去即可旁观，当前窗口不受打扰。")
    : null;
  // 分屏组命名：自动名=两成员显示名相连，渲染期从成员实时推导（成员替换/
  // 交换自动名跟随）；组 name 非空=用户改过名，钉住不跟随。散伙即随组丢弃。
  const memberLabel = (id: string) =>
    tabNames[id] ?? sessions.find((x) => x.id === id)?.host_name ?? id;
  const splitGroupLabelOf = (g: SplitGroup) =>
    g.name ?? `${memberLabel(g.main)} + ${memberLabel(g.second)}`;
  const splitGroupLabel = splitPanes ? splitGroupLabelOf(splitPanes) : null;
  // R35 rev 中-1：重试必须在**在场会话**内重跑（核心 retry_transfer 按旧 session_id
  // 取会话；会话不持久化，重启恢复的 Interrupted 其会话必然已不在 → SessionNotFound）。
  // 故仅当原会话仍在时给「重试」钮，否则如实告知（不渲染必死的钮）；pending- 占位卡
  // 无真实 id 同理（rev 低-1）。
  const canRetry = (t: TransferCard): boolean =>
    !t.id.startsWith("pending-") && !!t.sid && sessions.some((s) => s.id === t.sid);

  // 十九轮：命令面板条目——按当前状态构建（会话/连接/当前会话操作/应用动作）。
  // 置于组件尾部：引用的 handler 全部已初始化（TDZ 敏感）。
  // 五轮架构审计：曾是 useMemo——但依赖里 createSession/toggleSessionLog/takeover
  // 等是每次渲染新建的普通函数，memo 从未命中，徒留 24 项依赖数组的维护负担与
  // 「已优化」的错觉；数组本身构建很便宜（几个循环），改为普通求值。
  const paletteItems = (() => {
    const items: PaletteItem[] = [];
    const active = sessions.find((x) => x.id === sid);
    const stLabel = (s: SessionInfo) => (s.id === sid ? t("当前") : s.state === "Connected" ? t("已连接") : s.state === "Disconnected" ? t("已断开") : s.state);
    for (const s of sessions) {
      items.push({
        id: "goto-" + s.id, group: t("会话"),
        title: t("切换到 {0}", tabNames[s.id] ?? s.host_name),
        hint: stLabel(s), keywords: s.host_name + " 切换",
        run: () => { void attachSession(s.id).catch((e) => pushToast("err", errMsg(e))); },
      });
    }
    if (hosts.some((h) => h.address === "local" || h.id === "local")) {
      items.push({
        id: "local-term", group: t("连接"), title: t("打开本地终端"), hint: t("本机 PTY"),
        run: () => { const lh = hosts.find((h) => h.id === "local"); if (lh) void createSession(lh); },
      });
    }
    // 本地终端一等公民轮：启动自动开本地终端占据首屏后，恢复枢纽收进面板常驻可达
    //（「点了才连」语义不变，TOFU/双因素照旧）。门控用组件级 remoteOpen——
    // 本地 PTY 标签不算「有会话」，否则自动开让空态恒假，恢复入口永不出现。
    if (!remoteOpen && restoreEntries.length > 0) {
      items.push({
        id: "restore-scene", group: t("连接"), title: t("恢复上次现场（{0}）", restoreEntries.length),
        hint: t("受控退出时的屏幕快照——恢复走完整建连流程"), keywords: "恢复 现场 快照 restore",
        run: () => { void restoreScenes(restoreEntries); },
      });
    }
    if (!remoteOpen && lastSessionHosts.length > 0) {
      const rowsH = lastSessionHosts.flatMap((hid) => hosts.find((h) => h.id === hid) ?? []);
      if (rowsH.length > 0) {
        const namesH = rowsH.map((h) => h.name).join(t("、"));
        items.push({
          id: "reconnect-last", group: t("连接"), title: t("重连上次会话（{0}）", rowsH.length),
          // 上次没用过 tmux 面板时不承诺窗格/布局恢复（如实）
          hint: lastWorkspaceCombos.length > 0 ? `${namesH} · ${t("含上次的 tmux 窗格与布局")}` : namesH,
          keywords: "重连 上次 会话 恢复 工作空间 reconnect workspace",
          run: () => { void restoreLastWorkspace(); },
        });
      }
    }
    for (const h of hosts) {
      if (h.id === "local") continue;
      items.push({
        id: "conn-" + h.id, group: t("连接"),
        title: t("连接 {0}", h.name),
        hint: `${h.username}@${h.address}:${h.port}`, keywords: h.address + " " + h.username + " 连接",
        run: () => { void createSession(h).catch((e) => pushToast("err", errMsg(e))); },
      });
    }
    items.push({
      id: "quick-connect", group: t("连接"), title: t("快速连接（不存主机，临时连接一次）"),
      keywords: "一次性 临时 connect",
      run: () => { setShowQuickConnect(true); setShowAddHost(false); setShowImport(false); },
    });
    if (active) {
      const menuHost = hosts.find((x) => x.id === active.host_id);
      if (menuHost) {
        items.push({
          id: "dup-tab", group: t("当前会话"), title: t("复制标签页（同主机新会话：{0}）", menuHost.name),
          run: () => { void createSession(menuHost); },
        });
      }
      items.push({
        id: "rename-tab", group: t("当前会话"), title: t("重命名标签…"),
        run: () => setRenaming({ sid: active.id, value: tabNames[active.id] ?? active.host_name }),
      });
      // 分屏入口（六轮 C6-3）：分屏已有工具栏/右键菜单/Ctrl+D 三条活入口，但 ⌘K
      // 自认「唯一全模式可达层」而分屏缺席=可发现性死角（搜「分屏/split」零结果，
      // 同量级的复制/重命名/关闭都在列）。
      // 七轮（交付前审查）：不再镜像已删的标签 hover 钮，而是镜像真实可执行的动作——
      // 已分屏且当前会话是成员时给「退出分屏」（此前列「放到右侧分屏」但
      // enterSplitWith 首行自指卫兵直接 return，面板关掉、界面零变化=静默 no-op，
      // 正是删标签钮的理由）；只有一个会话时也无可分对象，不列。
      if (splitPanes && (splitPanes.main === active.id || splitPanes.second === active.id)) {
        items.push({
          id: "split-exit", group: t("当前会话"), title: t("退出分屏（两个会话都保留）"),
          keywords: "分屏 split 退出 unsplit 左右 上下 并排",
          run: () => { void exitSplit(); },
        });
      } else if (sessions.length > 1) {
        items.push({
          id: "split-active", group: t("当前会话"),
          // 活动会话无组时选「分屏」必须让用户挑第二个会话——直接 enterSplitWith(active)
          // 是自指卫兵静默 no-op（旧实现的面板零变化）；打开会话选择菜单
          title: t("分屏（选择{0}侧会话）…", splitDir === "tb" ? t("下") : t("右")),
          keywords: "分屏 split 左右 上下 并排",
          run: () => { setSplitMenu(true); },
        });
      }
      // tmux 联动：当前主机有 tmux 会话清单时给按需切换入口——会话管理器的最终
      // 形态不是面板，是命令面板里几行按需出现的条目；无 tmux 时一个字都不多。
      const atmux = active.kind === "ssh" ? active.tmux : null;
      if (atmux?.available && atmux.sessions.length > 0
        && (active.state === "Connected" || active.state === "Reconfirming")) {
        for (const ms of atmux.sessions) {
          // 已在面板格子里的会话不能切进主视图（同一会话不做两路视图）：不列出，
          // 免得点了只换来一条防呆报错（快接钮菜单是禁用并写明原因）
          if ((active.panes ?? []).some((p) => p.tmux_session === ms.name)) continue;
          items.push({
            id: "tmux-" + ms.name, group: t("当前会话"),
            title: t("切换到 tmux 会话：{0}（{1} 窗口）", ms.name, String(ms.windows)),
            keywords: `tmux ${ms.name} attach 恢复 现场`,
            run: () => { void restoreTmuxScene(active, ms.name); },
          });
        }
      }
      items.push({
        id: "toggle-log", group: t("当前会话"),
        title: active.logging ? t("停止记录会话日志") : t("记录会话日志"),
        hint: t("输出落 data/logs"),
        run: () => { void toggleSessionLog(active); },
      });
      if (active.logging) {
        items.push({
          id: "open-log", group: t("当前会话"), title: t("打开日志文件夹"),
          run: () => { void openSessionLogFolder(active.id); },
        });
      }
      // 专注模式巡检补：session-toolbar/工具菜单整条隐藏后，下面这些动作此前
      // 只剩键盘路径或完全无入口（接管并停止、文件/转发面板）。⌘K 面板是唯一
      // 全模式可达层——专注下照样可用，入口在此补齐。
      items.push({
        id: "term-search", group: t("当前会话"), title: t("搜索终端内容"), hint: formatBinding(keymap.search, isMacPlatform()),
        keywords: "查找 search",
        run: () => { dispatchRef.current({ id: "search" }); },
      });
      items.push({
        id: "panel-files", group: t("当前会话"),
        title: rightPanel === "files" ? t("关闭文件面板") : t("打开文件面板"),
        keywords: "sftp 上传 下载 目录浏览",
        run: () => setRightPanel(rightPanel === "files" ? null : "files"),
      });
      if (remoteOpen) {
        items.push({
          id: "panel-forwards", group: t("当前会话"),
          title: rightPanel === "forwards" ? t("关闭端口转发面板") : t("打开端口转发面板"),
          keywords: "隧道 tunnel",
          run: () => setRightPanel(rightPanel === "forwards" ? null : "forwards"),
        });
      }
      items.push({
        id: "panel-blocks", group: t("当前会话"),
        title: rightPanel === "blocks" ? t("关闭命令块面板") : t("打开命令块面板"),
        keywords: "命令 块 blocks 历史 重跑",
        run: () => setRightPanel(rightPanel === "blocks" ? null : "blocks"),
      });
      // P2-a 广播输入：专注模式藏了状态栏，⌘K 是唯一全模式可达入口（巡检补入口同款）
      items.push({
        id: "panel-broadcast", group: t("当前会话"),
        title: broadcastTargets.length > 0 ? t("广播输入（已勾选 {0} 个会话）", broadcastTargets.length) : t("广播输入…"),
        keywords: "broadcast 多会话 同步键入 同发",
        run: () => setBroadcastOpen(true),
      });
      if ((hasAgents || embeddedReady) && owner === "Agent") {
        items.push({
          id: "takeover", group: t("当前会话"), title: t("接管（冻结 Agent，待审批作废）"),
          keywords: "控制权 takeover",
          run: () => { void takeover(); },
        });
        items.push({
          id: "takeover-stop", group: t("当前会话"), title: t("接管并停止任务（尝试停止正在运行的命令）"),
          danger: true, keywords: "控制权 停止 takeover",
          run: () => { void takeoverStop(); },
        });
      }
      if ((collabConfigured || embeddedReady) && owner === "Human") {
        items.push({
          id: "delegate", group: t("当前会话"),
          title: active.ever_agent_owned ? t("交还 Agent…") : t("交给 Agent…"),
          keywords: "委托 控制权 delegate",
          run: () => openDelegate(),
        });
      }
      items.push({
        id: "close-session", group: t("当前会话"), title: t("关闭会话（{0}）", tabNames[active.id] ?? active.host_name),
        danger: true, keywords: "关闭 断开",
        run: () => requestCloseSession(active),
      });
    }
    items.push({
      id: "open-settings", group: t("应用"), title: t("打开设置"), keywords: "偏好 字号 外观 编码",
      run: () => setShowSettings(true),
    });
    {
      const idx = APPEARANCES.findIndex((a) => a.id === appearance);
      const next = APPEARANCES[(idx + 1 + APPEARANCES.length) % APPEARANCES.length];
      items.push({
        id: "cycle-appearance", group: t("应用"),
        title: t("外观切换为「{0}」", t(next.label)), hint: t("跟随系统 / 深色 / 浅色 循环"),
        keywords: "主题 深浅 暗色 亮色",
        run: () => changeAppearance(next.id),
      });
    }
    items.push({
      id: "toggle-hostbar", group: t("应用"),
      title: hostbarOpen ? t("隐藏主机栏") : t("显示主机栏"), hint: formatBinding(keymap.hostbar, isMacPlatform()),
      run: () => toggleHostbar(!hostbarOpen),
    });
    items.push({
      id: "toggle-agent", group: t("应用"),
      title: agentOpen ? t("关闭 Agent 对话") : t("打开 Agent 对话（演练）"),
      hint: t("活动栏"), keywords: "agent ai 助手 对话 演练 内置",
      run: () => toggleAgent(!agentOpen),
    });
    items.push({
      id: "toggle-fleet", group: t("应用"),
      title: fleetOpen ? t("关闭跨主机编排") : t("打开跨主机编排（Fleet）"),
      hint: t("活动栏"), keywords: "fleet 编排 跨主机 批量 多机 派发",
      run: () => toggleFleet(!fleetOpen),
    });
    items.push({
      id: "toggle-monitor", group: t("应用"),
      title: monitorOpen ? t("关闭资源监控大屏") : t("打开资源监控大屏（多服务器 + Ascend NPU）"),
      hint: t("活动栏"), keywords: "监控 资源 cpu 内存 网络 npu ascend 仪表 监视 面板",
      run: () => toggleMonitor(!monitorOpen),
    });
    items.push({
      id: "toggle-focus", group: t("应用"),
      title: focusMode ? t("退出专注模式") : t("进入专注模式（界面全让位给终端）"),
      hint: FOCUS_KEY_LABEL, keywords: "全屏 zen focus 专注 沉浸 极简",
      run: () => applyFocus(!focusMode),
    });
    items.push({
      id: "toggle-zen-strip", group: t("应用"),
      title: zenStripAuto ? t("专注模式标签条：改为常驻") : t("专注模式标签条：改为自动隐藏"),
      hint: zenStripAuto ? t("当前：自动隐藏（顶缘浮标唤出）") : t("当前：常驻"),
      keywords: "标签 常驻 隐藏 自动 专注",
      run: () => { setZenStrip(!zenStripAuto); pushToast("ok", zenStripAuto ? t("专注模式标签条已改为常驻") : t("专注模式标签条已改为自动隐藏（顶缘浮标唤出）")); },
    });
    items.push({
      id: "import-sshconfig", group: t("应用"), title: t("导入 ~/.ssh/config"),
      run: () => { if (focusMode) applyFocus(false); if (!hostbarOpen) toggleHostbar(true); setShowImport(true); setShowAddHost(false); setEditingHost(null); setPrefillEntry(null); },
    });
    return items;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  })();


  // 专注模式（F11）标签条钉住态：焦点/重要事实在标签条上时不可藏——hover 依赖
  // 鼠标，这些态鼠标可能根本不在窗口（键盘流、后台响铃、断线横幅）。钉住时标签
  // 条回流到常规槽位（CSS .zen-pin），绝不悬浮遮盖断线/接管等 notice。
  // 空会话也钉（巡检补）：浮标要 sessions>0 才渲染，专注+自动隐藏+零标签时整条
  // 只剩 6px 抓手，「新建连接」钮无从发现——没有标签时条就留在眼前。
  // 标签右键菜单/分屏菜单也钉（巡检补）：.ctx-menu 44、.split-menu 43 都低于
  // 滑出条的 45——钉住回流 static 后整条落到 z41 遮罩之下，菜单不被压住。
  const zenPin = sessions.length === 0 || searchOpen || !!renaming || tabsMenuOpen || focusHostMenu || !!tabMenu || !!splitMenu || !!connError
    || pendingCount > 0 || bellSids.size > 0
    || (current != null && (
      current.state === "Degraded" || current.state === "Reconnecting"
      || current.state === "Disconnected" || current.state === "Reconfirming"
      || (hasAgents && owner === "Agent")
    ));

  // 监控大屏卡片数据（大屏轮）：按**服务器**去重——同一台机器的多条 SSH 连接
  // 合一张卡（×N 徽标），采样也只走一条通道（monitor-store 按键单例，多条连接
  // 对同一台机器各轮一遍 exec 是纯浪费）。键 = user@address:port（保存主机回查
  // 得到；快速连接的主机不在 hosts 里，退回 @主机名——同名去重，异名不去）。
  // Closed/Disconnected 不进大屏——已停采的机器不占卡片；Degraded/Reconnecting
  // 保留存在感。代言会话选代表：优先 Connected、再当前激活标签，稳定不抖动；
  // 代表关闭时同机其余会话自动顶上（store 重绑，历史曲线不断）。
  const monitorCards: MonitorCardHost[] = useMemo(() => {
    const keyOf = (s: SessionInfo): string => {
      const h = hosts.find((x) => x.id === s.host_id);
      return h ? `${h.username}@${h.address}:${h.port}` : `@${s.host_name}`;
    };
    const groups = new Map<string, SessionInfo[]>();
    for (const s of sessions) {
      // 本机监控轮：local 会话进大屏——probe_metrics 按 kind 分支原生采样，
      // 本地与远端都是终端，监控同权（键 user@local:0 天然一卡一机）。
      if ((s.kind !== "ssh" && s.kind !== "local") || s.state === "Closed" || s.state === "Disconnected") continue;
      const k = keyOf(s);
      const g = groups.get(k);
      if (g) g.push(s); else groups.set(k, [s]);
    }
    const rank = (s: SessionInfo): number => ((s.state === "Connected" ? 0 : 1) * 2 + (s.id === sid ? 0 : 1));
    return [...groups.entries()].map(([key, g]) => {
      const rep = [...g].sort((a, b) => rank(a) - rank(b))[0];
      return {
        key,
        sid: rep.id,
        hostName: rep.host_name,
        user: hosts.find((h) => h.id === rep.host_id)?.username,
        state: rep.state,
        active: g.some((s) => s.id === sid),
        dup: g.length,
        tabNames: g.map((s) => tabNames[s.id] ?? s.host_name),
      };
    });
  }, [sessions, hosts, sid, tabNames]);

  // 在连服务器 → store（开关轮）：条目生命周期的唯一入口。monitorCards 随会话
  // 清单（3s 轮询）重算，effect 跟着重跑——新连接自动开采、关掉的连接自动拆
  // 链；大屏关着也照跑（采集跟开关走，不跟面板走）。放在 monitorCards 声明后：
  // deps 数组内联求值，前置会 TDZ 炸
  useEffect(() => {
    syncMonitorTargets(monitorCards.map((c) => ({ key: c.key, sid: c.sid })));
  }, [monitorCards, monGeneral, monNpu]);

  return (
    <div className={"app-shell" + (focusMode ? " focus-mode" : "") + (focusMode && zenStripAuto ? " zen-auto" : "")
      + (focusMode && inTauri && isMacPlatform() && !nativeFullscreen ? " focus-windowed" : "")}>
      {/* 标题区 44（§4.2）：整行拖拽区；红绿灯安全区由 .native-chrome 留白；可交互控件不在拖拽链上 */}
      <header className="titlebar" data-tauri-drag-region>
        <div className="tb-left">
          <span className="app-title" data-tauri-drag-region>TinySSH</span>
          {/* 版本号轮：常驻版本标签（0.10.0 起挪到应用名右边，紧贴名称更直观；
              关于卡另有编译时间，悬停提示指引） */}
          <span className="ver-tag" data-tauri-drag-region
            title={t("TinySSH v{0}——编译时间见 设置 → 关于", appVersion ?? APP_VERSION)}>
            v{appVersion ?? APP_VERSION}
          </span>
          {/* 自身开销读数（监控条「本机」段迁此）：标题栏常显不依赖会话；纯读数留在拖拽链上 */}
          <SelfMeterTitlebar />
          {/* 主机栏收展只在左活动栏顶部的 rail-hosts 一处（用户反馈：标题栏收起钮 +
              折叠态浮动展开钮两处重复且占位），标题栏不再放收起钮 */}
          {(agentSurfaceReady || collabActive) && (
            <button className={"collab-badge" + (rightPanel === "collab" ? " ts-open" : "") + (collabActive ? " hot" : "")}
              data-testid="collab-entry"
              title={collabActive
                ? t("{0}——跨会话操作请逐条核对目标主机", pendingCount > 0 ? t("有 {0} 个待审批请求", pendingCount) : t("Agent 正在控制会话"))
                : t("协作：审批、任务目标与现场简报")}
              onClick={() => setRightPanel(rightPanel === "collab" ? null : "collab")}>
              {t("协作")}{pendingCount > 0 ? t(" · {0} 待审批", pendingCount) : collabActive ? t(" · Agent 活动中") : ""}
            </button>
          )}
        </div>
        <span style={{ flex: 1 }} data-tauri-drag-region />
        <div className="tb-right">
          {sid && (
            <span className={"ctl-badge " + ownerCls}
              title={t("「Agent 控制中」= Agent 可发起命令、经你审批执行；「我控制中」= 终端归你，Agent 冻结")}
            ><span className="ctl-dot" />{owner === "Human" ? t("我控制中") : agentSurfaceReady ? t("Agent 控制中") : t("手动控制")}</span>
          )}
        </div>
        {inTauri && isWindowsPlatform() && <WinControls />}
      </header>
      <div className="workspace">
        {autonomy.length > 0 && (
          /* ② 自主模式常驻横幅：醒目、随 3s 轮询刷新剩余时间、一键急停 */
          <div className="autonomy-banner" data-testid="autonomy-banner" role="alert"
            style={{ display: "flex", alignItems: "center", gap: 10, padding: "5px 12px",
              background: "var(--warn-bg, #4a3208)", color: "var(--warn, #ffb454)",
              borderBottom: "1px solid var(--warn, #ffb454)", fontSize: 12 }}>
            <b>{t("⚡ 自主模式运行中")}</b>
            {autonomy.map((g) => (
              <span key={g.agent_id} className="mono" data-testid={`autonomy-${g.agent_id}`}>
                {g.agent_id}
                {g.expires_at
                  ? t(" · 剩余 {0} 分", Math.max(0, Math.round((new Date(g.expires_at).getTime() - Date.now()) / 60000)))
                  : t(" · 手动关闭前有效")}
              </span>
            ))}
            <span className="dim" style={{ fontSize: 11 }}>{t("危险命令仍被拦截；传输仍需审批；全部动作有记录。")}</span>
            {autonomy.map((g) => (
              <button key={`k-${g.agent_id}`} className="danger" data-testid={`autonomy-kill-${g.agent_id}`}
                style={{ padding: "1px 10px", fontSize: 11 }}
                onClick={() => void killAutonomy(g.agent_id)}>{t("急停 {0}", g.agent_id)}</button>
            ))}
          </div>
        )}
        {/* 活动栏（活动栏轮）：左缘图标栏 = 侧栏视图入口。连接/Agent/编排三视图互斥
            （开一个关另一个），全关 = 纯终端；专注模式整体隐藏（.focus-mode CSS）。
            设置常驻第四图标（不占互斥位、钉栏底 = VSCode 惯例：视图入口在上、
            应用级动作在下）——设置钮原住主机栏，侧栏互斥+持久化后会有
            「找不到设置」的时刻；它不开任何侧栏，直开设置面板 */}
        <nav className="actrail" data-testid="actrail" aria-label={t("侧栏视图")}>
          {/* 主机栏收/展的唯一入口（用户反馈合并两处收展钮）：动态标题说明当前动作，
              开合态沿用 ts-open 点亮，与其余视图互斥位同一套语义 */}
          <button className={"rail-btn" + (hostbarOpen ? " ts-open" : "")} data-testid="rail-hosts"
            title={hostbarOpen ? t("收起主机栏（{0}）", formatBinding(keymap.hostbar, isMacPlatform())) : t("展开主机栏（{0}）", formatBinding(keymap.hostbar, isMacPlatform()))}
            aria-label={hostbarOpen ? t("收起主机栏") : t("展开主机栏")} aria-pressed={hostbarOpen} onClick={() => toggleHostbar(!hostbarOpen)}>
            <IconServer size={17} />
          </button>
          <button className={"rail-btn" + (agentOpen ? " ts-open" : "")} data-testid="rail-agent"
            title={t("Agent 对话（演练）")} aria-label={t("Agent 对话")} aria-pressed={agentOpen} onClick={() => toggleAgent(!agentOpen)}>
            <IconBot size={17} />
          </button>
          <button className={"rail-btn" + (fleetOpen ? " ts-open" : "")} data-testid="rail-fleet"
            title={t("跨主机编排（Fleet）：派发任务给各会话的执行 agent 并汇总")} aria-label={t("跨主机编排")} aria-pressed={fleetOpen}
            onClick={() => toggleFleet(!fleetOpen)}>
            <IconShuffle size={17} />
          </button>
          <button className={"rail-btn" + (monitorOpen ? " ts-open" : "")} data-testid="rail-monitor"
            title={t("资源监控大屏：多服务器 CPU/内存/网络 与 Ascend NPU{0}", monGeneral || monNpu ? t("（后台采集中）") : "")} aria-label={t("资源监控大屏")} aria-pressed={monitorOpen}
            onClick={() => toggleMonitor(!monitorOpen)}>
            <IconGauge size={17} />
            {/* 后台采集呼吸点（开关轮）：大屏关着也在采时给个环境提示 */}
            {(monGeneral || monNpu) && <span className="rail-live" data-testid="rail-monitor-live" aria-hidden="true" />}
          </button>
          <button className={"rail-btn rail-tail" + (showSettings ? " ts-open" : "")} data-testid="rail-settings"
            title={t("设置（外观 / 终端 / 凭据 / Agent）")} aria-label={t("设置")}
            onClick={() => dispatchRef.current({ id: "settings" })}>
            <IconSliders size={17} />
          </button>
        </nav>
        {hostbarOpen && (
          /* 主机栏（拆分⑤出仓 components/hostbar.tsx，零语义变更）：搜索防抖、
             标签筛选、收藏分组卡片、导入面板挂载点、设置钮与宽度抓手 */
          <Hostbar
            hostbarWidth={hostbarWidth} hosts={hosts} hostMeta={hostMeta}
            sessions={sessions} hostsLoaded={hostsLoaded} hostsError={hostsError}
            filteredHosts={filteredHosts} favHosts={favHosts} otherHosts={otherHosts}
            localHost={localHost} localShells={localShells}
            onLocalShell={(path) => { const lh = hosts.find((h) => h.id === "local"); if (lh) void createSession(lh, false, undefined, path); }}
            allTags={allTags} activeTag={activeTag}
            connectingIds={connectingIds} lastFailed={lastFailed}
            showImport={showImport} showAddHost={showAddHost} attempts={attempts}
            hostSearchRef={hostSearchRef} hostDebounceRef={hostDebounceRef}
            setHostQuery={setHostQuery}
            gripDrag={gripDrag} gripDown={gripDown} gripMove={gripMove} gripUp={gripUp}
            dispatchRef={dispatchRef}
            setTagFilter={setTagFilter} setShowImport={setShowImport}
            setShowAddHost={setShowAddHost} setEditingHost={setEditingHost}
            setPrefillEntry={setPrefillEntry} setHostMenu={setHostMenu} setConfirm={setConfirm}
            attachSession={attachSession} createSession={createSession}
            toggleFavorite={toggleFavorite} cancelConnect={cancelConnect}
            pushToast={pushToast} refreshLists={refreshLists}
          />
        )}
        {(agentOpen || fleetOpen) && (
          /* Agent 对话视图：双模式——真模型（inTauri + 已配置模型服务，Rust 侧
             agent-host 驱动，审批卡对账 pendingApprovals 内联呈现）或演练外壳。
             fleet 形态（Fleet 轮）：对话键固定 "fleet"（Rust FLEET_KEY），跨会话
             编排者——无委托门/控制权徽标（它不直接操作机器），其余交互同款 */
          <AgentView
            width={agentWidth} fleet={fleetOpen}
            sid={fleetOpen ? "fleet" : sid}
            hostLabel={fleetOpen ? t("跨主机编排") : hostLabel(sid ?? undefined)}
            tmuxNote={tmuxAgentNote}
            pending={pendingApprovals} onDecide={decide}
            owner={owner} onDelegate={delegateEmbedded}
            autonomyOn={autonomy.some((g) => g.agent_id === EMBEDDED_AGENT_ID)}
            onToggleAutonomy={toggleEmbeddedAutonomy}
            onOpenApprovals={() => setRightPanel("collab")}
            gripDrag={agGripDrag} gripDown={agGripDown} gripMove={agGripMove} gripUp={agGripUp}
            onClose={() => (fleetOpen ? toggleFleet(false) : toggleAgent(false))} pushToast={pushToast}
          />
        )}
        <main className="main">
        {monitorOpen && (
          /* 监控大屏（大屏轮 / 开关轮修订）：整幅主区覆盖层（main 已
             position:relative）——终端/标签条不卸载、会话照常收数，关闭即露出
             原视图。按服务器去重一卡一机；采样在 monitor-store 单例、由通用/
             NPU 两枚开关驱动后台持续采集——关大屏链条不停，重开历史直接在，
             全关零开销（未开启空态）；卡片头点击跳该机终端并收起大屏 */
          <MonitorView
            cards={monitorCards}
            swGeneral={monGeneral}
            swNpu={monNpu}
            paused={monitorPaused}
            onToggleGeneral={toggleMonGeneral}
            onToggleNpu={toggleMonNpu}
            onTogglePause={toggleMonitorPause}
            onOpenSession={(target) => { void attachSession(target); toggleMonitor(false); }}
            onClose={() => {
              toggleMonitor(false);
              // 关屏焦点回 rail（审查二轮 UX2-6③）：✕ 点击路径焦点落 body，纯键盘用户断链；
              // Esc 关闭路径走 restoreTermFocus 回终端，不经过这里
              document.querySelector<HTMLElement>('[data-testid="rail-monitor"]')?.focus();
            }}
          />
        )}
        {wallSession && wallSession.kind === "ssh" && wallSession.tmux?.available && (
          /* tmux 会话大屏（监控墙）：整幅主区覆盖层（MonitorView 同款位）。快照
             拍的是打开它的那台主机；「进格子」复用 openTmuxPane（面板链路：
             attach/改名跟随/愿望清单全复用）后收屏让位给工作台 */
          <TmuxWall
            hostName={wallSession.host_name}
            sid={wallSession.id}
            sessions={wallSession.tmux?.sessions ?? []}
            fetchCells={wallFetchCells}
            sendInput={wallSendInput}
            fitPanes={wallFitPanes}
            restorePanes={wallRestorePanes}
            requestPaste={requestWallPaste}
            onPromote={wallPromote}
            onClose={wallClose}
          />
        )}
        {/* 双接管按钮的语义说明不再常显（用户反馈：占一行没用处）——完整语义
            已在两钮的 title 悬停提示里（接管=冻结/待审批作废/跑着的不中断；
            接管并停止=再尝试停止/结果逐条显示），随用随看不占空间 */}
        {/* 重确认：§6.4 原文「已重连；旧现场待核实」——人类可继续操作，受限的是
            Agent 变更（有协作在场时点名「Agent 暂停」）；核实完成自动恢复 */}
        {current?.state === "Reconfirming" && (
          <div className="notice-bar warn">
            ⓘ {t("已重连；旧现场待核实——你可以继续操作")}{owner === "Agent" ? t("；Agent 已暂停（普通变更仍受限）") : ""}{t("。")}
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
                ⏳ {t("手动重连中——")}{current.host_name}{t("（最多 3 次尝试）")}
              </span>
            </div>
          ) : (
            <div className="notice-bar err">
              <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                ⛔ {t("网络中断——自动重连中")}{autoReconn?.sid === current.id && autoReconn.attempt > 0 ? t("（第 {0}/{1} 次）", autoReconn.attempt, autoReconn.max) : "…"}
              </span>
              <button className="danger" onClick={() => void stopRetry(current)}>{t("停止重试")}</button>
            </div>
          )
        )}
        {current?.state === "Disconnected" && (
          <div className="notice-bar err">
            <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              ⛔ {t("会话已断开——画面为断开前状态，键入已拦截")}
            </span>
            <button disabled={reconnecting !== null} onClick={() => void reconnectSession(current)}>
              {reconnecting === current.id ? t("重连中…") : t("重连恢复")}
            </button>
          </div>
        )}
        {/* 标签页（T19）：每个会话一签，状态点随连接状态变色；◫ 进/换分屏，✕ 关闭（⌘W） */}
        {/* 溢出结构（五人走查·林姐）：滚动钮与尾部控件钉在行内，不随标签流滚走
            ——此前「＋」在溢出时也一起消失 */}
        {/* 专注模式顶缘迷你浮标（tmux 状态条的最小形态）：藏条时唯一可见物——活动
            标签名 + 标签数，给多标签用户环境提示（首轮实测反馈：纯 6px 抓手在浅色
            主题下不可见，「上面还压着标签」无从得知）。放在 tabbar-row 之前：hover
            浮标经相邻选择器展开标签条，鼠标下移即被条自身 :hover 接管，无缝续期。
            zenPin（钉住回流 static）时不渲染——static 元素不吃 z-index，浮标会反过来
            盖在标签条上，而钉住态整条已在眼前，浮标纯属多余。 */}
        {focusMode && zenStripAuto && sessions.length > 0 && !zenPin && (
          <div className="zen-pill" aria-hidden="true">
            <IconChevronDown size={10} />
            {tabNames[sid ?? ""] ?? current?.host_name ?? "TinySSH"}
            {sessions.length > 1 ? ` · ${sessions.length}` : ""}
          </div>
        )}
        <div className={"tabbar-row" + (focusMode && zenStripAuto && zenPin ? " zen-pin" : "")}>
          {tabScroll.left && (
            <button className="tab-scroll" aria-label={t("向左滚动标签")}
              title={t("左侧还有 {0} 个会话被收起——点击展开（{1} 可循环切换）", tabScroll.hiddenL, isMacPlatform() ? "⌘⇧[" : "Ctrl+Shift+[")}
              onClick={() => scrollTabs(-1)}>‹</button>
          )}
          <div className="tabbar" ref={tabbarRef} onScroll={measureTabbar} role="tablist" aria-label={t("会话标签")}>
            {tabEntries.map((e, i) => {
              // 一组一标签：组标签 = 一个工作区；成员不再单独占位
              const entryKey = e.key;
              const group = e.kind === "group" ? e.group : null;
              const sess = e.kind === "session" ? e.session : null;
              const members = e.kind === "group" ? e.members : [e.session];
              const groupActive = !!group && !!sid && members.some((m) => m.id === sid);
              const active = group ? groupActive : sid === sess?.id;
              // 组标签的 data-sid/操作对象 = 当前焦点成员（点它就能回到该格）
              const rep = group
                ? (groupActive ? sid! : groupFocusRef.current.get(group.id) ?? group.main)
                : sess!.id;
              const repSession = members.find((m) => m.id === rep) ?? members[0];
              // 状态点：组取最差成员——按会话状态显式排（见 sessionStateRank），
              // 不按展示色档位：Disconnected 的 dim 会输给 Connected 的 ok。
              const worst = members.reduce<SessionInfo | null>(
                (a, b) => (!a || sessionStateRank(b.state) > sessionStateRank(a.state) ? b : a), null);
              // 已断开会话在组标签上提为 warn 档（dim 会看起来像「空闲」而不是「掉线」）
              const st = worst && (worst.state === "Disconnected" || worst.state === "Closed")
                ? { text: t("已断开"), cls: "warn" }
                : stateLabel(worst?.state ?? "");
              // 组标签逐成员报状态（「A 已连接 · B 已断开」）——只报最差会让用户
              // 不知道该处理哪一格
              const memberStatusText = group
                ? members.map((m) => `${tabNames[m.id] ?? m.host_name} ${stateLabel(m.state).text}`).join(" · ")
                : st.text;
              // 十四轮：标签自定名（复制标签页后同名标签的区分），无则回退主机名
              const label = group ? splitGroupLabelOf(group) : tabNames[sess!.id] ?? sess!.host_name;
              const bellLit = members.some((m) => bellSids.has(m.id));
              return (
                <div
                  key={e.key}
                  data-key={e.key}
                  data-sid={rep}
                  data-gid={group?.id}
                  className={"tab" + (active ? " tab-active" : "") + (group ? " tab-pane" : "")
                    + (bellLit ? " tab-bell" : "")
                    + (tabDragKey === e.key ? " tab-drag-src" : "")
                    + (tabDropHint?.key === e.key ? (tabDropHint.before ? " tab-drop-before" : " tab-drop-after") : "")}
                  onPointerDown={(ev) => {
                    // pointer 自定义拖拽（原因见 tabDragRef 注释）：仅左键且不在子控件
                    // （✕/重命名输入框）上才起拖；不 preventDefault——保住 click、
                    // 双击重命名、中键关闭
                    if (ev.button !== 0) return;
                    if (ev.target instanceof Element && ev.target.closest("button, input")) return;
                    dragClickSupUntilRef.current = 0;
                    tabDragRef.current = {
                      key: e.key, sid: rep, startX: ev.clientX, startY: ev.clientY,
                      pointerId: ev.pointerId, srcEl: ev.currentTarget, active: false,
                    };
                    ev.currentTarget.setPointerCapture(ev.pointerId);
                  }}
                  onPointerMove={(e) => {
                    const drag = tabDragRef.current;
                    if (!drag || drag.key !== entryKey || drag.pointerId !== e.pointerId) return;
                    if (!(e.buttons & 1)) { cancelTabDrag(); return; }
                    if (!drag.active) {
                      // 起拖要求「位移够大」且「指针已离开标签本体」：标签内部滑动
                      // 哪怕 20px 也只是普通点击，杜绝单击标签冒出分屏落点提示
                      const dx = e.clientX - drag.startX;
                      const dy = e.clientY - drag.startY;
                      if (Math.max(Math.abs(dx), Math.abs(dy)) < 6) return;
                      const r = drag.srcEl.getBoundingClientRect();
                      const pad = 4;
                      if (e.clientX >= r.left - pad && e.clientX <= r.right + pad
                        && e.clientY >= r.top - pad && e.clientY <= r.bottom + pad) return;
                      drag.active = true;
                      setTabDragKey(entryKey);
                      document.body.classList.add("tab-dragging");
                    }
                    // 悬停提示：标签条=插入位；终端区=组合分屏落格（已分屏按命中格）；
                    // 其余区域清空。同值复用旧引用，拖拽悬停不整树重渲染
                    const bar = tabbarRef.current?.getBoundingClientRect();
                    const tr = termRef.current?.getBoundingClientRect();
                    const inStrip = !!bar && e.clientX >= bar.left && e.clientX <= bar.right && e.clientY >= bar.top && e.clientY <= bar.bottom;
                    const inTerm = !!tr && e.clientX >= tr.left && e.clientX <= tr.right && e.clientY >= tr.top && e.clientY <= tr.bottom;
                    if (inStrip) {
                      const hit = tabAtPoint(e.clientX, e.clientY);
                      setTermDropHint((cur) => (cur ? null : cur));
                      // 组标签也可在条内重排——插入位提示与落点裁决一致
                      setTabDropHint((cur) => {
                        const next = hit && hit.key !== drag.key ? hit : null;
                        return next && cur?.key === next.key && cur?.before === next.before ? cur : next;
                      });
                    } else {
                      setTabDropHint((cur) => (cur ? null : cur));
                      // 组标签是工作区整体：不进终端区落格，无提示
                      if (!drag.key.startsWith("g:") && inTerm && sessionsRef.current.length >= 2 && tr) {
                        const sp = groupOf(sidRef.current);
                        let zone: "l" | "r" | "t" | "b";
                        if (sp) {
                          const hitSlot = paneAtPoint(e.clientX, e.clientY);
                          // 拖到自己所在格：没有可执行落点，不渲染提示
                          if (slotOf(sp, drag.sid) === hitSlot) {
                            setTermDropHint((cur) => (cur ? null : cur));
                            return;
                          }
                          zone = hitSlot === "main"
                            ? (sp.dir === "tb" ? "t" : "l")
                            : (sp.dir === "tb" ? "b" : "r");
                        } else {
                          // 拖的是活动会话本身且它没有组：没有可组合的对象
                          // （placeInSplit 会 no-op），不渲染落点提示——提示必须与
                          // 落点裁决一致
                          if (drag.sid === sidRef.current) {
                            setTermDropHint((cur) => (cur ? null : cur));
                            return;
                          }
                          const dx = (e.clientX - (tr.left + tr.width / 2)) / tr.width;
                          const dy = (e.clientY - (tr.top + tr.height / 2)) / tr.height;
                          zone = Math.abs(dx) > Math.abs(dy) ? (dx < 0 ? "l" : "r") : (dy < 0 ? "t" : "b");
                        }
                        setTermDropHint((cur) => (cur === zone ? cur : zone));
                      } else {
                        setTermDropHint((cur) => (cur ? null : cur));
                      }
                    }
                  }}
                  onPointerUp={(ev) => {
                    const drag = tabDragRef.current;
                    if (!drag || drag.key !== entryKey || drag.pointerId !== ev.pointerId) return;
                    const wasActive = drag.active;
                    const snap = { key: drag.key, sid: drag.sid };
                    cancelTabDrag();
                    if (!wasActive) return; // 未起拖=纯点击，click 事件照常激活
                    dragClickSupUntilRef.current = performance.now() + 300;
                    finishTabDrag(snap, ev.clientX, ev.clientY);
                  }}
                  onPointerCancel={(ev) => {
                    const d = tabDragRef.current;
                    if (d?.key === entryKey && d.pointerId === ev.pointerId) cancelTabDrag();
                  }}
                  onLostPointerCapture={(ev) => {
                    const d = tabDragRef.current;
                    if (d?.key === entryKey && d.pointerId === ev.pointerId) cancelTabDrag();
                  }}
                  title={`${label} · ${memberStatusText}${group ? ` · ${t("{0} 个窗格", members.length)}` : ""}${i < 9 ? ` · ${isMacPlatform() ? "⌘" : "Ctrl+"}${i + 1}` : ""}`}
                  aria-label={`${label}，${memberStatusText}${group ? t("，{0} 个窗格", members.length) : ""}${i < 9 ? t("，{0}{1}", isMacPlatform() ? "⌘" : "Ctrl+", i + 1) : ""}`}
                  tabIndex={0}
                  role="tab"
                  aria-selected={active}
                  onKeyDown={(ev) => {
                    // R20-H1 同款守卫（R27 tab-x 键盘化后必须）：子按钮上的
                    // Enter/Space 冒泡到标签处理器会 preventDefault 吞掉按钮默认点击、
                    // 误触 attachSession——只有标签本体直接按键才激活
                    if (ev.target !== ev.currentTarget) return;
                    if (ev.key === "Enter" || ev.key === " ") {
                      ev.preventDefault();
                      if (group && active) return; // 已激活组标签：保留当前焦点格
                      void attachSession(rep).catch((er) => pushToast("err", errMsg(er)));
                    }
                  }}
                  onClick={() => {
                    if (performance.now() < dragClickSupUntilRef.current) { dragClickSupUntilRef.current = 0; return; }
                    if (group && active) return; // 已激活组标签：保留当前焦点格
                    void attachSession(rep).catch((er) => pushToast("err", errMsg(er)));
                  }}
                  onMouseDown={(ev) => {
                    // 十四轮：中键关闭（浏览器/Windows Terminal 惯例），走与 ✕/右键
                    // 同一确认契约；组标签同 ✕ 语义——只关焦点成员并解散组，
                    // 另一会话保留为独立标签。preventDefault 压掉中键自动滚动
                    if (ev.button === 1) { ev.preventDefault(); ev.stopPropagation(); requestCloseSession(repSession); }
                  }}
                  onDoubleClick={(ev) => {
                    // 十四轮：双击重命名——只认标签本体/状态点/文字/角标，子按钮双击不误触。
                    // 组标签双击=改组名（与胶囊同一状态机，输入框渲染在标签条）。
                    const hit = ev.target as HTMLElement;
                    if (!(hit === ev.currentTarget || hit.classList.contains("tab-label") || hit.classList.contains("tab-dot") || hit.classList.contains("tab-count"))) return;
                    ev.stopPropagation();
                    if (group) beginGroupRename(group.id, splitGroupLabelOf(group), "tab");
                    else setRenaming({ sid: rep, value: tabNames[rep] ?? repSession.host_name });
                  }}
                  onContextMenu={(ev) => {
                    // 十一轮 §6.3 修订：右键标签弹会话操作菜单（按状态显隐）；右键不切换焦点标签
                    ev.preventDefault();
                    ev.stopPropagation();
                    setTabMenu({ x: ev.clientX, y: ev.clientY, sid: rep });
                  }}
                >
                  <span className={"tab-dot " + st.cls} aria-hidden="true" />
                  {group && groupRenaming !== null && groupRenamingGid === group.id && groupRenameSource === "tab" ? (
                    // 组标签行内改名（与分割条胶囊同一状态机；source=tab 时胶囊不渲染输入框）
                    <input
                      className="tab-rename"
                      value={groupRenaming}
                      autoFocus
                      onFocus={(ev) => ev.currentTarget.select()}
                      aria-label={t("重命名分屏组")}
                      onChange={(ev) => setGroupRenaming(ev.target.value)}
                      onClick={(ev) => ev.stopPropagation()}
                      onMouseDown={(ev) => ev.stopPropagation()}
                      onDoubleClick={(ev) => ev.stopPropagation()}
                      onKeyDown={(ev) => {
                        ev.stopPropagation();
                        if (ev.nativeEvent.isComposing || ev.keyCode === 229) return;
                        if (ev.key === "Enter") {
                          const tab = (ev.currentTarget as HTMLElement).closest<HTMLElement>(".tab");
                          queueMicrotask(() => tab?.focus());
                          commitGroupRename(groupRenaming);
                        } else if (ev.key === "Escape") cancelGroupRename();
                      }}
                      onBlur={() => commitGroupRename(groupRenaming)}
                    />
                  ) : !group && renaming?.sid === rep ? (
                    <input
                      className="tab-rename"
                      value={renaming?.value ?? ""}
                      autoFocus
                      onFocus={(ev) => ev.currentTarget.select()} // 预填全选（审查二轮 UX2-5）：此前直接键入变追加
                      aria-label={t("重命名标签")}
                      onChange={(ev) => setRenaming({ sid: rep, value: ev.target.value })}
                      onClick={(ev) => ev.stopPropagation()}
                      onMouseDown={(ev) => ev.stopPropagation()}
                      onDoubleClick={(ev) => ev.stopPropagation()}
                      onKeyDown={(ev) => {
                        // 编辑框内按键不冒泡（Enter/Space 会被标签 onKeyDown 抢成激活）
                        ev.stopPropagation();
                        // IME 组合期 Enter 是确认候选词，不提交重命名（§7.3 口径）
                        if (ev.nativeEvent.isComposing || ev.keyCode === 229) return;
                        if (ev.key === "Enter") {
                          // 提交后焦点回标签本体（找茬五轮 D-4）：改名框卸载即焦点
                          // 落 body——原地 Tab 重丢地址。微任务回焦在 React 卸载
                          // 输入框之前跑，会触发一次 blur 重提交（同值幂等无害）；
                          // Escape 分支不回焦——回焦引发的 blur 会把本应丢弃的编辑
                          // 提交掉（取消语义优先）
                          const tab = (ev.currentTarget as HTMLElement).closest<HTMLElement>(".tab");
                          queueMicrotask(() => tab?.focus());
                          commitTabRename(rep, renaming?.value ?? "");
                        } else if (ev.key === "Escape") setRenaming(null);
                      }}
                      onBlur={() => commitTabRename(rep, renaming?.value ?? "")}
                    />
                  ) : (
                    <span className="tab-label">{label}</span>
                  )}
                  {group && <span className="tab-count" aria-hidden="true">{members.length}</span>}
                  {/* R27（§7.4）：关闭改真按钮——键盘 Tab 可达、focus-visible 可见、
                      可访问名称不依赖 hover；命中区 ≥28 由 CSS ::after 透明扩展。
                      一组一标签：组标签的 ✕ 关闭当前焦点成员并解散组（另一会话以独立
                      标签继续）——title/aria 把「显示的是 A+B、关的只是焦点格」说全，
                      与可见文字不一致的旧「关闭会话」会让人以为整组都没了。
                      会话生命周期与确认契约沿用 requestCloseSession */}
                  <button
                    type="button"
                    className="tab-x"
                    title={group
                      ? t("关闭当前窗格会话「{0}」并退出分屏（另一会话保留为独立标签）", tabNames[rep] ?? repSession.host_name)
                      : t("关闭会话（{0}，活动会话先确认影响）", formatBinding(keymap["tab-close"], isMacPlatform()))}
                    aria-label={group
                      ? t("关闭当前窗格会话「{0}」并退出分屏（另一会话保留为独立标签）", tabNames[rep] ?? repSession.host_name)
                      : t("关闭会话 {0}", repSession.host_name)}
                    onClick={(ev) => { ev.stopPropagation(); requestCloseSession(repSession); }}
                  ><IconX size={11} /></button>
                </div>
              );
            })}
          </div>
          {tabScroll.right && (
            <button className="tab-scroll" aria-label={t("向右滚动标签")}
              title={t("右侧还有 {0} 个会话被收起——点击展开（{1} 可循环切换）", tabScroll.hiddenR, isMacPlatform() ? "⌘⇧]" : "Ctrl+Shift+]")}
              onClick={() => scrollTabs(1)}>›</button>
          )}
          {splitPanes && <button className="ghost" onClick={() => exitSplit()}
            title={splitGroupLabel ? t("退出分屏：解散「{0}」（两个会话都保留）", splitGroupLabel) : undefined}>{t("退出分屏")}</button>}
          {/* 十九轮：命令面板入口（⌘K / Ctrl+K 的可发现锚点）。快捷键是 native 域
              能力（demo 域 actions.ts 有 native 门），浏览器里不广告不存在的键 */}
          <button className="ghost icon-btn" title={inTauri ? t("命令面板（{0}）", formatBinding(keymap.palette, isMacPlatform())) : t("命令面板")} aria-label={t("命令面板")} data-testid="palette-open"
            onClick={() => setPaletteOpen(true)}><IconSearch size={14} /></button>
          {/* 专注模式小工具栏（用户反馈：连接现有配置主机与文件是最常用的两件事）。
              会话工具栏整条隐藏后，这两个入口在标签条补位；仍不进 .tabbar-admin，
              保持专注态的克制。连接菜单用 .tools-menu，随 zenPin 钉住标签条。 */}
          {focusMode && (
            <>
              <button className={"ghost icon-btn" + (rightPanel === "files" ? " ts-open" : "")}
                data-testid="focus-files"
                disabled={!sid}
                title={!sid ? t("先连接会话再打开文件面板") : rightPanel === "files" ? t("关闭文件面板") : t("打开文件面板")}
                aria-label={t("文件面板")} aria-pressed={rightPanel === "files"}
                onClick={() => setRightPanel(rightPanel === "files" ? null : "files")}><IconFolder size={14} /></button>
              <div className="st-tools" ref={focusHostMenuRef}>
                <button className="ghost" data-testid="focus-connect"
                  aria-haspopup="menu" aria-expanded={focusHostMenu}
                  title={t("从已保存主机新建连接")}
                  onClick={() => setFocusHostMenu(!focusHostMenu)}>
                  {t("连接")}<IconChevronDown size={12} />
                </button>
                {focusHostMenu && (
                  <div className="tools-menu tm-right" role="menu" data-testid="focus-connect-menu">
                    {hosts.length === 0 && (
                      <div className="dim" style={{ padding: "6px 10px" }}>{t("暂无已保存主机——退出专注模式后在主机栏添加")}</div>
                    )}
                    {[...hosts].sort(byName).map((h) => {
                      const mine = sessions.filter((s) => s.host_id === h.id);
                      return (
                        <button role="menuitem" key={h.id} data-testid={"focus-host-" + h.id}
                          className="focus-host-item"
                          title={h.id === "local" ? t("本地终端") : `${h.username}@${h.address}:${h.port}`}
                          disabled={connectingIds.has(h.id)}
                          onClick={() => {
                            setFocusHostMenu(false);
                            void createSession(h).catch((e) => pushToast("err", errMsg(e)));
                          }}>
                          <span className="tab-label">{h.name}</span>
                          <span className="mono focus-host-addr">{h.id === "local" ? t("本地") : `${h.username}@${h.address}`}</span>
                          {mine.length > 0 && <span className="auth-tag" title={t("已有 {0} 个会话", mine.length)}>● {mine.length}</span>}
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            </>
          )}
          {/* 专注模式（F11）：常态是 ⤢ 图标；专注下滑出条里另有文字钮，双入口同 applyFocus。
              协作/传输入口在此补位——专注下标题栏与状态条都藏了，而 §3 要求待审批等
              提醒必须可达（pendingCount>0 已让 zenPin 钉住标签条，入口就在眼前） */}
          {/* 接管双钮同样只在工具栏的话，专注+Agent 控制时想停下危险命令就得先退
              专注（巡检补）——zenPin 已保证此态标签条钉在眼前，入口放这里正好 */}
          {focusMode && sid && (hasAgents || embeddedReady) && owner === "Agent" && (
            <>
              <button className="warn" title={t("接管会话：Agent 冻结、待审批请求作废，终端归你。Agent 正在跑的命令不会被中断")}
                onClick={takeover}>{t("接管")}</button>
              <button className="ghost-danger" title={t("接管并额外尝试停止 Agent 正在运行的命令；停止结果逐条显示，未停下的会标红")}
                onClick={takeoverStop}>{t("接管并停止")}</button>
            </>
          )}
          {focusMode && agentSurfaceReady && (
            <button className={"ghost" + (rightPanel === "collab" ? " ts-open" : "")}
              title={t("协作：审批、任务目标与现场简报")}
              onClick={() => setRightPanel(rightPanel === "collab" ? null : "collab")}>
              {t("协作")}{pendingCount > 0 ? t(" · {0}", pendingCount) : ""}
            </button>
          )}
          {focusMode && runningTransfers > 0 && (
            <button className={"ghost" + (queueOpen ? " ts-open" : "") + (awaitingTransfers > 0 ? " attn" : "")}
              title={t("传输队列（底部抽屉）")}
              onClick={() => setQueueOpen(!queueOpen)}>{t("传输")} {runningTransfers}</button>
          )}
          {/* 专注模式保留 tmux 快接（用户反馈：管理入口不能因隐藏工具栏而消失）；
              退出专注已有右侧图标钮 + F11，不再重复放文字钮。 */}
          {focusMode && current && (
            <TmuxQuick
              current={current} sid={sid}
              tmuxMenu={tmuxMenu} setTmuxMenu={setTmuxMenu} tmuxMenuRef={tmuxMenuRef}
              onRefreshTmux={() => refreshTmuxList(current)}
              onPickTmux={(name) => pickTmuxSession(current, name)}
              onPromotePaneToMain={(name) => void promotePaneToMain(current, name)}
              onAddTmuxPane={(name) => void openTmuxPane(current, name)}
              onOpenWall={() => { setTmuxMenu(false); setTmuxWallSid(current.id); }}
              tmuxCreateOpen={tmuxCreateOpen} tmuxCreateName={tmuxCreateName}
              tmuxCreateErr={tmuxCreateErr} tmuxCreateBusy={tmuxCreateBusy}
              tmuxCreateTarget={tmuxCreateTarget} onTmuxCreateTarget={setTmuxCreateTarget}
              onTmuxCreateOpen={() => { setTmuxCreateOpen(true); setTmuxCreateTarget("main"); setTmuxCreateErr(null); }}
              onTmuxCreateCancel={() => { setTmuxCreateOpen(false); setTmuxCreateName(""); setTmuxCreateErr(null); }}
              onTmuxCreateName={setTmuxCreateName}
              onTmuxCreateSubmit={() => void submitTmuxCreate(current)}
              paneNames={(current.panes ?? []).map((p) => p.tmux_session)}
              paneCapReached={(current.panes ?? []).length >= PANE_MAX}
              splitActive={!!splitPanes}
            />
          )}
          <button className={"ghost icon-btn" + (focusMode ? " ts-open" : "")} data-testid="focus-toggle"
            title={focusMode ? t("退出专注模式（{0}）", FOCUS_KEY_LABEL)
              : zenStripAuto ? t("专注模式（{0}）：隐藏标题栏/主机栏/工具栏并系统全屏，标签条藏为顶缘浮标", FOCUS_KEY_LABEL)
              : t("专注模式（{0}）：隐藏标题栏/主机栏/工具栏并系统全屏，标签条保持常驻", FOCUS_KEY_LABEL)}
            aria-pressed={focusMode} aria-label={focusMode ? t("退出专注模式") : t("进入专注模式")}
            onClick={() => { setTmuxMenu(false); setTabsMenuOpen(false); applyFocus(!focusMode); }}>
            {focusMode ? <IconMinimize size={14} /> : <IconMaximize size={14} />}
          </button>
          <div className="st-tools tabbar-admin" ref={tabsMenuRef}>
            <button className="ghost tab-all" title={t("所有标签")} aria-haspopup="menu" aria-expanded={tabsMenuOpen}
              onClick={() => setTabsMenuOpen(!tabsMenuOpen)}>{t("标签列表")}<IconChevronDown size={12} /></button>
            {tabsMenuOpen && (
              <div className="tools-menu tm-right" role="menu">
                {sessions.length === 0 && <div className="dim" style={{ padding: "6px 10px" }}>{t("暂无会话")}</div>}
                {sessions.map((s) => {
                  const st = stateLabel(s.state);
                  return (
                    <div className={"tm-row" + (sid === s.id ? " tm-active" : "")} key={s.id}>
                      <button className="tm-main" role="menuitem"
                        onClick={() => { setTabsMenuOpen(false); void attachSession(s.id); }}>
                        <span className={"tab-dot " + st.cls} />
                        <span className="tab-label">{tabNames[s.id] ?? s.host_name}</span>
                        <span className={"mono " + st.cls} style={{ fontSize: 10, marginLeft: "auto" }}>{st.text}</span>
                      </button>
                      {s.state === "Disconnected" && (
                        <button className="tm-act" title={t("重连该会话")} disabled={reconnecting !== null}
                          onClick={() => { setTabsMenuOpen(false); reconnectSession(s); }}>{t("重连")}</button>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
          {/* 键位随键位表渲染（审查轮二同类修复漏网：此前写死 Ctrl+T，mac 上也显示 Ctrl）；
              tab-new 是 native 门动作，浏览器 demo 不广告不存在的键（同命令面板钮） */}
          <button className="ghost icon-btn tabbar-admin" title={inTauri ? t("新建连接（{0}）", formatBinding(keymap["tab-new"], isMacPlatform())) : t("新建连接")} aria-label={t("新建连接")} onClick={() => { setShowAddHost(!showAddHost); setShowImport(false); setShowQuickConnect(false); setPrefillEntry(null); }}><IconPlus size={14} /></button>
          {/* 十七轮：快速连接——不存主机一次性建连 */}
          <button className="ghost icon-btn tabbar-admin" title={t("快速连接（不保存主机，临时连接一次）")} aria-label={t("快速连接")} data-testid="quick-connect-open" onClick={() => { setShowQuickConnect(true); setShowAddHost(false); setShowImport(false); }}><IconTerminal size={14} /></button>
        </div>
        {connError && (
          <div className="conn-error">
            <div>
              <b>✕ {connError.title}</b>
              <div className="dim">{connError.detail}</div>
            </div>
            <button className="ghost" onClick={() => setConnError(null)}>{t("关闭")}</button>
          </div>
        )}
        {stopResult && (
          <div className="conn-error">
            <div>
              <b>⏸ {t("已接管 {0}——停止结果", stopResult.hostName)}</b>
              <div className="dim" style={{ marginTop: 4 }}>
                {stopResult.report.stopped.length === 0 && <div>· {t("正在运行的任务：无")}</div>}
                {stopResult.report.stopped.map(([id, out]) => {
                  const o = stopOutcomeText(out);
                  return <div key={id} className={o.bad ? "err" : ""}>· {id.slice(0, 12)} → {o.text}</div>;
                })}
                <div>· {t("作废的排队请求：{0} 条", stopResult.report.paused_queue.length)}</div>
                <div className={stopResult.report.frozen ? "" : "err"}>· {t("Agent 新请求")}{stopResult.report.frozen ? t("已冻结") : t("⚠ 未冻结")}</div>
                <div className="dim">{t("现场简报已更新（右栏）；交还 Agent 前它会保持暂停。")}</div>
              </div>
            </div>
            <button className="ghost" onClick={() => setStopResult(null)}>{t("知道了")}</button>
          </div>
        )}
        {/* R42/R23/P1 危险确认·委托对话框群（拆分③出仓 components/confirm-dialogs.tsx，零语义变更） */}
        <ConfirmDialogs
          delegateDlg={delegateDlg} current={current} closeDelegate={closeDelegate}
          delegateDlgRef={delegateDlgRef} currentHost={currentHost} delegateCap={delegateCap}
          collabConfigured={agentSurfaceReady} mcp={mcp}
          delegateGoal={delegateGoal} setDelegateGoal={setDelegateGoal}
          delegateErr={delegateErr} openSettingsAt={openSettingsAt}
          delegateBusy={delegateBusy} submitDelegate={submitDelegate}
          disableImpact={disableImpact} setDisableImpact={setDisableImpact}
          collabBusy={collabBusy} confirmDisable={confirmDisable}
          confirm={confirm} setConfirm={setConfirm}
          closeConfirmRef={closeConfirmRef} confirmImpact={confirmImpact} confirmAction={confirmAction}
          confirmBusy={confirmBusy} quitBusy={quitBusy}
          quitSummary={quitSummary} setQuitSummary={setQuitSummary}
          quitConfirmRef={quitConfirmRef} confirmQuit={confirmQuit} cancelQuit={cancelQuit}
          delHostRef={delHostRef} delIdentRef={delIdentRef}
        />
        {/* 会话工具栏 40（拆分⑤出仓 components/session-toolbar.tsx，零语义变更） */}
        {current && (
          <SessionToolbar
            current={current} sid={sid} oscTitles={oscTitles}
            hasAgents={hasAgents} owner={owner}
            embeddedReady={embeddedReady}
            searchOpen={searchOpen} splitMenu={splitMenu} splitPanes={splitPanes}
            keyHint={(id) => formatBinding(keymap[id], isMacPlatform())}
            toolsOpen={toolsOpen} toolsRef={toolsRef}
            dispatchRef={dispatchRef} setSplitMenu={setSplitMenu}
            setToolsOpen={setToolsOpen} setRightPanel={setRightPanel}
            exitSplit={exitSplit}
            takeover={takeover} takeoverStop={takeoverStop}
            openSessionDetail={openSessionDetail} toggleSessionLog={toggleSessionLog}
            requestCloseSession={requestCloseSession}
            broadcastArmed={broadcastTargets.length} openBroadcast={() => setBroadcastOpen(true)}
            canForward={remoteOpen}
            tmuxMenu={tmuxMenu} setTmuxMenu={setTmuxMenu} tmuxMenuRef={tmuxMenuRef}
            onPickTmux={(name) => pickTmuxSession(current, name)}
            onPromotePaneToMain={(name) => void promotePaneToMain(current, name)}
            onAddTmuxPane={(name) => void openTmuxPane(current, name)}
            onOpenWall={() => { setTmuxMenu(false); setTmuxWallSid(current.id); }}
            tmuxCreateOpen={tmuxCreateOpen} tmuxCreateName={tmuxCreateName}
            tmuxCreateErr={tmuxCreateErr} tmuxCreateBusy={tmuxCreateBusy}
            tmuxCreateTarget={tmuxCreateTarget} onTmuxCreateTarget={setTmuxCreateTarget}
            onTmuxCreateOpen={() => { setTmuxCreateOpen(true); setTmuxCreateTarget("main"); setTmuxCreateErr(null); }}
            onTmuxCreateCancel={() => { setTmuxCreateOpen(false); setTmuxCreateName(""); setTmuxCreateErr(null); }}
            onTmuxCreateName={setTmuxCreateName}
            onTmuxCreateSubmit={() => void submitTmuxCreate(current)}

            paneNames={(current.panes ?? []).map((p) => p.tmux_session)}
            paneCapReached={(current.panes ?? []).length >= PANE_MAX}
            splitActive={!!splitPanes}
            renderTmuxQuick={!focusMode}
            onRefreshTmux={() => refreshTmuxList(current)}
          />
        )}
        {hostKeyQueue.length > 0 && (() => {
          const hk = hostKeyQueue[0];
          return (
            <div className="hk-mask hk-top">
              <div className={"hk-dialog" + (hk.issue === "Changed" ? " hk-danger" : "")} ref={hkDlgRef}>
                {hk.issue === "Changed" ? (
                  <>
                    <div className="hk-title hk-warn">⚠ {t("主机指纹已变更")}</div>
                    <div>
                      {t("主机")} <b>{hk.host_name}</b>{t("（{0}:{1}）的指纹与此前信任的记录不一致。", hk.address, hk.port)}
                      {t("可能是服务器重装/换钥，也可能是")}<b className="hk-warn">{t("中间人攻击")}</b>{t("。请通过其他可信渠道核实后再继续。")}
                    </div>
                    <div className="hk-fp mono">{t("原指纹")}　{hk.previous_fingerprint}</div>
                    <div className="hk-fp mono">{t("新指纹")}　{hk.fingerprint}</div>
                    <div className="hk-actions">
                      <button className="danger" onClick={() => decideHostKey(hk, true)}>{t("我已核实，更新指纹并连接")}</button>
                      {/* data-autofocus（巡检补）：useDialogFocus 初始焦点落安全钮——
                          指纹变更框 Enter 的默认动作绝不能是「信任」 */}
                      <button className="ghost" data-autofocus onClick={() => decideHostKey(hk, false)}>{t("拒绝连接")}</button>
                    </div>
                  </>
                ) : (
                  <>
                    <div className="hk-title">{t("首次连接确认")}{hk.jump_note ? t("（{0}·跳板机）", hk.jump_note) : ""}</div>
                    <div>
                      {hk.jump_note
                        ? <>{t("经跳板连接目标前，须先信任跳板主机")} <b>{hk.host_name}</b>{t("（{0}:{1}）。请核对指纹后决定是否信任：", hk.address, hk.port)}</>
                        : <>{t("首次连接主机")} <b>{hk.host_name}</b>{t("（{0}:{1}）。请核对服务器指纹（可向管理员确认）后决定是否信任：", hk.address, hk.port)}</>}
                    </div>
                    <div className="hk-fp mono">{hk.fingerprint}</div>
                    <div className="hk-actions">
                      <button onClick={() => decideHostKey(hk, true)}>{t("信任并连接")}</button>
                      <button className="ghost" data-autofocus onClick={() => decideHostKey(hk, false)}>{t("取消")}</button>
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
            <div className="hk-mask hk-top">
              <div className="hk-dialog" ref={authDlgRef}>
                <div className="hk-title">{t("服务器请求认证输入（双因素）")}{ap.jump_note ? t("（{0}·跳板机）", ap.jump_note) : ""}</div>
                <div>
                  {t("主机")} <b>{ap.host_name}</b> {t("要求完成额外交互认证")}{ap.jump_note ? t("（目标连接须经此跳板转发）") : ""}{t("。请输入服务器要求的验证信息：")}
                </div>
                <div className="dim mono" style={{ margin: "6px 0", fontSize: 11 }}>{ap.prompt || ap.name || "verification"}</div>
                <input
                  type={ap.echo ? "text" : "password"}
                  value={authAnswer}
                  onChange={(e) => setAuthAnswer(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter" && !(e.nativeEvent.isComposing || e.keyCode === 229) && authAnswer.trim()) void answerAuthPrompt(ap.id, authAnswer); }}
                  placeholder={ap.echo ? t("输入验证码") : t("输入验证码（输入不回显）")}
                  autoFocus
                  style={{ width: "100%" }}
                />
                <div className="hk-actions">
                  <button disabled={!authAnswer.trim()} onClick={() => void answerAuthPrompt(ap.id, authAnswer)}>{t("提交验证")}</button>
                  <button className="ghost" onClick={() => void answerAuthPrompt(ap.id, "")}>{t("取消认证")}</button>
                </div>
                <div className="dim" style={{ marginTop: 6, fontSize: 11 }}>{t("取消将终止本次连接认证。密码本身已在连接时自动填入，无需重复输入。")}</div>
              </div>
            </div>
          );
        })()}
        {/* 新建/编辑主机对话框（用户反馈二轮）：主机栏 220px 太挤——居中 560px 大窗，
            字段一行三列呼吸展开；浮层链 Esc 可关，表单逻辑零改动仅拨壳 */}
        {showAddHost && (
          <div className="hk-mask" role="dialog" aria-modal="true" aria-label={editingHost ? t("编辑主机") : t("新建连接")} data-testid="add-host-dialog">
            <div className="hk-dialog add-host-dlg" ref={addHostDlgRef}>
              <div className="dlg-head">
                <b>{editingHost ? t("编辑主机") : t("新建连接")}</b>
                <button className="ghost icon-btn" aria-label={t("关闭")}
                  onClick={closeAddHost}><IconX size={14} /></button>
              </div>
              <AddHostForm
                editHost={editingHost}
                prefill={prefillEntry}
                hosts={hosts}
                onSavingChange={onAddHostSavingChange}
                onCancel={closeAddHost}
                onSaved={async (hid, wasEdit, connect = true) => {
                  // 七轮（交付前审查）：成功保存是「正常关闭」而非「丢弃草稿」——必须
                  // 一并复位守卫与脏旗标，否则下次打开表单会继承 true，第一次 Esc
                  // 直接静默关窗丢凭据（正是六轮 D6-4 要防的损失）
                  addHostGuardRef.current = false;
                  addHostCredDirty.value = false;
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
            </div>
          </div>
        )}
        {showQuickConnect && (
          <div className="hk-mask" role="dialog" aria-modal="true" aria-label={t("快速连接")} data-testid="quick-connect-dialog">
            <div className="hk-dialog add-host-dlg" ref={quickDlgRef}>
              <div className="dlg-head">
                <b>{t("快速连接")}</b>
                <button className="ghost icon-btn" aria-label={t("关闭")} onClick={closeQuickConnect}><IconX size={14} /></button>
              </div>
              <QuickConnectForm
                remoteError={connError ? `${connError.title}——${connError.detail}` : null}
                onBusyChange={noteQuickConnecting}
                onConnect={async (display, draft) => {
                  const ok = await createSession(display, false, draft);
                  if (ok) setShowQuickConnect(false);
                  return ok;
                }}
                onCancel={closeQuickConnect}
              />
            </div>
          </div>
        )}
        <div className="content">
        <div className="term-col">
        <div className="term-wrap">
          {!sid && (
            /* 欢迎页（拆分⑤出仓 components/welcome.tsx，零语义变更） */
            <Welcome
              sid={sid} sessions={sessions} hosts={hosts}
              lastSessionHosts={lastSessionHosts} recents={recents} recentsHidden={recentsHidden}
              restoreEntries={restoreEntries} onRestoreScene={(e) => void restoreScenes(e)}
              onReconnectLast={() => void restoreLastWorkspace()}
              hasWorkspacePanes={lastWorkspaceCombos.length > 0}
              focusMode={focusMode} hostbarOpen={hostbarOpen}
              createSession={createSession} applyFocus={applyFocus} toggleHostbar={toggleHostbar}
              setShowAddHost={setShowAddHost} setShowImport={setShowImport}
              setShowQuickConnect={setShowQuickConnect} setEditingHost={setEditingHost}
              setPrefillEntry={setPrefillEntry} setRecentMenu={setRecentMenu}
            />
          )}
          <div id="term" ref={termRef}
            onContextMenu={(e) => {
            // 十一轮续：终端区右键——复制/粘贴/全选作用于右键命中的窗格（分屏时各格独立）；
            // 未命中具体窗格回退焦点窗格。无终端实例（欢迎页）交给系统默认行为
            if (termsRef.current.size === 0) return;
            e.preventDefault();
            // tmux 面板格子：右键作用于命中的格子（复制/粘贴/全选/关闭窗格）
            const cellEl = (e.target as HTMLElement).closest?.(".tmux-cell") as HTMLElement | null;
            if (cellEl) {
              const pk = `${cellEl.dataset.sid}:${cellEl.dataset.paneId}`;
              const pe = paneTermsRef.current.get(pk);
              if (pe) setTermMenu({ x: e.clientX, y: e.clientY, sid: pe.sid, hasSel: pe.term.hasSelection(), paneKey: pk });
              return;
            }
            let target: string | null = null;
            for (const [s, en] of termsRef.current) {
              const r = en.el.getBoundingClientRect();
              if (e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom) { target = s; break; }
            }
            if (!target) {
              const focused = [...termsRef.current.entries()].find(([, en]) => en.el.classList.contains("active") || en.el.classList.contains("pane-focused"));
              target = focused?.[0] ?? sidRef.current ?? null;
            }
            if (!target) return;
            const en = termsRef.current.get(target);
            setTermMenu({ x: e.clientX, y: e.clientY, sid: target, hasSel: !!en?.term.hasSelection() });
          }}>
            {/* 分屏⑥轮：可拖拽分割条（退化态随窗格一起消失）。唯一 React 子节点——
                .term-session 层由 makeTerm 以 appendChild 挂入，互不干扰 */}
            {splitPanes && !splitDegraded && !splitPanes.maximized && (
              <div
                ref={paneDivRef}
                className={"pane-div " + (splitPanes.dir === "tb" ? "div-tb" : "div-lr")}
                data-testid="pane-div"
                role="separator"
                tabIndex={0}
                aria-orientation={splitPanes.dir === "tb" ? "horizontal" : "vertical"}
                aria-valuemin={Math.round(SPLIT_FRAC_MIN * 100)}
                aria-valuemax={Math.round(SPLIT_FRAC_MAX * 100)}
                aria-valuenow={Math.round(splitPanes.frac * 100)}
                aria-label={t("分屏分割条")}
                title={`${t("拖拽调整两格比例（20%~80%）；双击复位对半")} · ${t("方向键调整比例（Shift 加速；Home/End 到两端）")}`}
                onPointerDown={onDivDown}
                onPointerMove={onDivMove}
                onPointerUp={onDivUp}
                onPointerCancel={onDivCancel}
                onLostPointerCapture={onDivLostCapture}
                onDoubleClick={resetSplitFrac}
                onKeyDown={(e) => {
                  // 仅条身自身按键；胶囊/输入框的键盘事件各自处理
                  if (e.target !== e.currentTarget) return;
                  const step = e.shiftKey ? 0.1 : 0.02;
                  if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
                    e.preventDefault(); e.stopPropagation(); nudgeSplitFrac(-step);
                  } else if (e.key === "ArrowRight" || e.key === "ArrowDown") {
                    e.preventDefault(); e.stopPropagation(); nudgeSplitFrac(step);
                  } else if (e.key === "Home" || e.key === "End") {
                    e.preventDefault(); e.stopPropagation();
                    nudgeSplitFrac(0, e.key === "Home" ? SPLIT_FRAC_MIN : SPLIT_FRAC_MAX);
                  }
                }}
              >
                {/* 分屏组命名（本轮）：组名胶囊叠分割条中央——事件自持，抓胶囊=改名
                    （双击/Enter/F2），抓条身=拖比例/双击复位。自动名随成员，自定义
                    名钉住，散伙即弃。胶囊可 Tab 聚焦，方向键同样微调比例。
                    默认隐形（避免常显遮挡正文）：悬停分割条、键盘聚焦或拖拽时显形 */}
                <span className="div-group" data-testid="split-group-chip" tabIndex={0}
                  role="button"
                  title={t("分屏组：{0}（双击重命名）", splitGroupLabel ?? "")}
                  onPointerDown={(e) => e.stopPropagation()}
                  onDoubleClick={(e) => { e.stopPropagation(); beginGroupRename(splitPanes.id, splitGroupLabel ?? ""); }}
                  onKeyDown={(e) => {
                    if (e.target !== e.currentTarget) return;
                    if (e.key === "Enter" || e.key === "F2") {
                      e.preventDefault(); e.stopPropagation();
                      beginGroupRename(splitPanes.id, splitGroupLabel ?? "");
                      return;
                    }
                    if (e.key === "Escape" && groupRenaming !== null) {
                      e.preventDefault(); e.stopPropagation();
                      cancelGroupRename();
                      return;
                    }
                    const step = e.shiftKey ? 0.1 : 0.02;
                    if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
                      e.preventDefault(); e.stopPropagation(); nudgeSplitFrac(-step);
                    } else if (e.key === "ArrowRight" || e.key === "ArrowDown") {
                      e.preventDefault(); e.stopPropagation(); nudgeSplitFrac(step);
                    } else if (e.key === "Home" || e.key === "End") {
                      e.preventDefault(); e.stopPropagation();
                      nudgeSplitFrac(0, e.key === "Home" ? SPLIT_FRAC_MIN : SPLIT_FRAC_MAX);
                    }
                  }}
                >
                  {groupRenaming !== null && groupRenameSource === "chip" ? (
                    <input
                      className="split-group-rename"
                      value={groupRenaming}
                      autoFocus
                      onFocus={(e) => e.currentTarget.select()}
                      aria-label={t("重命名分屏组")}
                      onChange={(e) => setGroupRenaming(e.target.value)}
                      onClick={(e) => e.stopPropagation()}
                      onMouseDown={(e) => e.stopPropagation()}
                      onDoubleClick={(e) => e.stopPropagation()}
                      onKeyDown={(e) => {
                        // 编辑框内按键不冒泡（全局快捷键层会抢走 Enter/Escape）
                        e.stopPropagation();
                        // IME 组合期 Enter 是确认候选词，不提交重命名（§7.3 口径）
                        if (e.nativeEvent.isComposing || e.keyCode === 229) return;
                        if (e.key === "Enter") {
                          // 焦点回胶囊（找茬五轮 D-4，同标签改名）：只挂提交路径——
                          // 取消路径回焦引发 blur 会把本应丢弃的编辑提交掉（六轮 BR-5：
                          // 胶囊此前无 tabIndex 回焦是 no-op，补 tabIndex=-1 后 Escape
                          // 分支若也回焦正是潜伏雷，同标签路径口径只挂 Enter）
                          const chip = (e.currentTarget as HTMLElement).closest<HTMLElement>(".div-group");
                          queueMicrotask(() => chip?.focus());
                          commitGroupRename(groupRenaming);
                        } else if (e.key === "Escape") {
                          // 取消：清 gid 后再还原布局（blur 触发的提交成为 no-op），
                          // 窄窗重新按宽度退化
                          cancelGroupRename();
                        }
                      }}
                      onBlur={() => commitGroupRename(groupRenaming)}
                    />
                  ) : (
                    <span className="div-group-name"
                      onDoubleClick={(e) => { e.stopPropagation(); beginGroupRename(splitPanes.id, splitGroupLabel ?? ""); }}
                    >{splitGroupLabel}</span>
                  )}
                </span>
              </div>
            )}
            {/* 拖标签组合分屏：落点提示。高亮块 inset 吃 #term 的 --split-frac——
                已分屏时高亮恰为真实窗格几何，未分屏（默认 .5）即为半区 */}
            {termDropHint && (() => {
              const sp = splitPanes;
              // 一组一标签：拖拽源恒为独立会话（组成员没有自己的标签），不存在「交换两格」
              const side = sp?.dir === "tb"
                ? (termDropHint === "t" ? "上" : "下")
                : (termDropHint === "l" ? "左" : "右");
              const label = !sp
                ? t(`放到${side}侧分屏`)
                : sp.maximized
                  ? t("替换此格")
                  : t(`替换${side}格`);
              return (
                <div className="drag-split-hint" data-testid="drag-split-hint">
                  <div className={"dsh-zone zone-" + termDropHint + (sp?.maximized ? " single" : "")} />
                  <div className="dsh-label" data-testid="dsh-label">{label}</div>
                </div>
              );
            })()}
          </div>
          {current?.state === "Disconnected" && !splitPanes && (() => {
            // tmux 联动三态（恢复现场轮）：① 有最后 attach 记录或唯一会话 → 单键
            // 「恢复现场」；② 首次见 tmux（未教过）或多个会话 → 内联挑选列表；
            // ③ 无 tmux / 全不可知 → 原样「重连恢复」。教学只在最疼的时刻出现
            // 一次，点「仅重连/不用了」30 天内不再问。
            const tm = current.kind === "ssh" ? (current.tmux ?? null) : null;
            const last = tmuxPrefs.last[current.host_id];
            const declinedAt = tmuxPrefs.declined[current.host_id];
            // 「不用了」30 天内整体压掉 tmux 横幅（回到普通重连形态）——教学只在
            // 最疼的时刻出现一次；用户用过后（last 在）则永远不再算「教学」
            const suppressed = !last && !!declinedAt && Date.now() - declinedAt < 30 * 86400e3;
            const live = tm?.available && !suppressed ? tm.sessions : [];
            const teach = live.length > 0 && !last;
            const pick = (() => {
              if (last) {
                if (!live.length || live.some((x) => x.name === last)) return last;
                if (live.length === 1) return live[0].name;
                return null;
              }
              return live.length === 1 ? live[0].name : null;
            })();
            const autoOn = tmuxPrefs.auto.has(current.host_id);
            const reconnectOnly = () => {
              if (teach) updateTmuxPrefs((p) => ({ ...p, declined: { ...p.declined, [current.host_id]: Date.now() } }));
              void reconnectSession(current);
            };
            const liveNames = live.map((x) => x.name).join(t("、"));
            return (
              <div className="dead-overlay">
                <div className="dead-banner">
                  <div><b>⛔ {t("会话已断开")}</b></div>
                  {pick ? (
                    <>
                      <div className="dim" style={{ fontSize: 12, marginTop: 4 }}>
                        {teach
                          ? t("检测到远端有 tmux 会话在运行（{0}）——里面的程序没停。", liveNames)
                          : t("远端会话 {0} 仍在运行。", pick)}
                      </div>
                      <div className="row" style={{ marginTop: 10, flexWrap: "wrap", alignItems: "center" }}>
                        <button data-testid="tmux-restore-btn" disabled={tmuxBusy !== null || reconnecting !== null}
                          onClick={() => { void restoreTmuxScene(current, pick); }}>
                          {tmuxBusy === current.id ? t("正在恢复现场…") : t("恢复现场")}
                        </button>
                        <button data-testid="tmux-reconn-only-btn" disabled={reconnecting !== null} onClick={reconnectOnly}>
                          {t("仅重连")}
                        </button>
                        <label className="dim" style={{ fontSize: 11, display: "inline-flex", alignItems: "center", gap: 4 }}>
                          <input type="checkbox" checked={autoOn} data-testid="tmux-auto-chk"
                            onChange={(e) => updateTmuxPrefs((p) => {
                              const a = new Set(p.auto);
                              if (e.target.checked) a.add(current.host_id); else a.delete(current.host_id);
                              return { ...p, auto: a };
                            })} />
                          {t("下次断线自动恢复现场")}
                        </label>
                      </div>
                      <div className="dim" style={{ fontSize: 11, marginTop: 4 }}>
                        {t("重连后进入重确认——旧现场待核实，可继续操作")}
                      </div>
                    </>
                  ) : live.length > 1 ? (
                    <>
                      <div className="dim" style={{ fontSize: 12, marginTop: 4 }}>
                        {t("检测到远端有 tmux 会话在运行（{0}）——里面的程序没停。", liveNames)}
                      </div>
                      <div className="row" style={{ marginTop: 10, flexWrap: "wrap" }}>
                        {live.map((x) => (
                          <button key={x.name} data-testid={"tmux-pick-" + x.name}
                            disabled={tmuxBusy !== null || reconnecting !== null}
                            onClick={() => { void restoreTmuxScene(current, x.name); }}>
                            {tmuxBusy === current.id ? t("正在恢复现场…") : `${t("恢复现场")}：${x.name}`}
                          </button>
                        ))}
                        <button data-testid="tmux-reconn-only-btn" disabled={reconnecting !== null} onClick={reconnectOnly}>
                          {t("仅重连")}
                        </button>
                      </div>
                    </>
                  ) : (
                    <>
                      <div className="dim" style={{ fontSize: 12, marginTop: 4 }}>
                        {t("画面是断开前的最后状态；键入已拦截，不会发送。")}
                      </div>
                      <div className="row" style={{ marginTop: 10 }}>
                        <button disabled={reconnecting !== null} onClick={() => reconnectSession(current)}>
                          {reconnecting === current.id ? t("重连中…") : t("重连恢复")}
                        </button>
                        <span className="dim" style={{ fontSize: 11 }}>{t("重连后进入重确认——旧现场待核实，可继续操作")}</span>
                      </div>
                    </>
                  )}
                </div>
              </div>
            );
          })()}
          {dragOver && sid && (
            <div className="drop-overlay">
              <div className="drop-box">
                <div className="drop-icon"><IconDownload size={34} /></div>
                {/* 落点跟着指针：悬在文件面板上时目标是面板正在浏览的目录，不是 cwd */}
                <div>{t("松开上传到")} {dragZone === "panel"
                  ? (sftpPath || t("正在浏览的目录"))
                  : (brief?.cwd ?? t("远程主机"))}</div>
                <div className="dim" style={{ fontSize: 11, marginTop: 4 }}>{t("拖到文件面板则直接传到正在浏览的目录")}</div>
              </div>
            </div>
          )}
          {attachHint && sid && (
            <div className="attach-hint">
              {current && current.state !== "Connected" && current.state !== "Reconfirming"
                // 断开会话不谎报「已接入」（找茬五轮 C-4：断线后点进副格，提示
                // 胶囊仍说「已接入直接打字」，与红色断线横幅自相矛盾）
                ? t("会话未连接——用横幅上的「重连恢复」接入")
                : t("会话已接入——点击终端区直接打字")}
            </div>
          )}
          {searchOpen && sid && (
            <div className="term-search">
              <input
                ref={searchInputRef}
                autoFocus
                spellCheck={false}
                placeholder={t("搜索终端内容…")}
                value={searchQuery}
                aria-invalid={searchInvalid || undefined}
                title={searchInvalid ? t("正则表达式无效，请检查后再输入") : undefined}
                onChange={(e) => {
                  setSearchQuery(e.target.value);
                  runSearch(e.target.value);
                }}
                onKeyDown={(e) => {
                  e.stopPropagation();
                  // IME 候选词确认的 Enter 不是「下一个」（WKWebView 组合期仍上抛
                  // 真实 key 名）——与上传框/路径框同口径。
                  if (e.nativeEvent.isComposing || e.keyCode === 229) return;
                  if (e.key === "Escape") {
                    e.preventDefault();
                    closeSearch();
                    return;
                  }
                  if (e.key !== "Enter" || !searchQuery) return;
                  e.preventDefault();
                  runSearch(searchQuery, e.shiftKey ? "prev" : "next");
                }}
              />
              {/* 查找选项（本轮）：区分大小写 / 全词 / 正则，切换即重跑当前查询 */}
              {([
                { key: "caseSensitive", testid: "search-case", label: "Aa", title: t("区分大小写") },
                { key: "wholeWord", testid: "search-word", label: "ab", title: t("全词匹配") },
                { key: "regex", testid: "search-regex", label: ".*", title: t("正则表达式") },
              ] as const).map((o) => (
                <button key={o.key} type="button"
                  className={"ghost search-opt" + (searchPrefs[o.key] ? " on" : "")}
                  data-testid={o.testid} aria-pressed={searchPrefs[o.key]}
                  aria-label={o.title} title={o.title}
                  onClick={() => toggleSearchPref(o.key)}
                >{o.label}</button>
              ))}
              <span className="dim mono" style={{ whiteSpace: "nowrap" }}>
                {searchInvalid
                  ? t("正则无效")
                  : searchQuery && searchResults && searchResults.resultCount > 0
                    ? `${(searchResults.resultIndex ?? 0) + 1}/${searchResults.resultCount}`
                    : searchQuery
                      ? t("无结果")
                      : ""}
              </span>
              <button className="ghost" title={t("上一个（⇧⏎）")} aria-label={t("上一个搜索结果")} onClick={() => searchQuery && runSearch(searchQuery, "prev")}><IconChevronUp size={13} /></button>
              <button className="ghost" title={t("下一个（⏎）")} aria-label={t("下一个搜索结果")} onClick={() => searchQuery && runSearch(searchQuery, "next")}><IconChevronDown size={13} /></button>
              <button className="ghost" title={t("关闭（Esc）")} aria-label={t("关闭搜索")} onClick={closeSearch}><IconX size={12} /></button>
            </div>
          )}
          {/* 五个右键/弹出菜单 + 分屏退化提示（拆分⑤出仓 components/ctx-menus.tsx，
              零语义变更）：分屏选择、标签右键、主机卡右键、终端区右键、最近连接行右键 */}
          <CtxMenus
            sessions={sessions} sid={sid} hosts={hosts} hostMeta={hostMeta}
            connectingIds={connectingIds} splitPanes={splitPanes} tabNames={tabNames}
            groupOf={groupOf} splitGroupLabelOf={splitGroupLabelOf}
            rotateSplitGroup={rotateSplitGroup} beginGroupRename={beginGroupRename}
            autoReconn={autoReconn}
            localShells={localShells}
            onLocalShell={(path) => { const lh = hosts.find((h) => h.id === "local"); if (lh) void createSession(lh, false, undefined, path); }}
            splitMenu={splitMenu} setSplitMenu={setSplitMenu} enterSplitWith={enterSplitWith}
            splitDir={splitDir} setSplitDir={(d) => { splitDirRef.current = d; setSplitDir(d); }}
            tabMenu={tabMenu} setTabMenu={setTabMenu} exitSplit={exitSplit}
            stopRetry={stopRetry} reconnectSession={reconnectSession} setRenaming={setRenaming}
            toggleSessionLog={toggleSessionLog} openSessionLogFolder={openSessionLogFolder}
            openSessionDetail={openSessionDetail} requestCloseSession={requestCloseSession}
            hostMenu={hostMenu} setHostMenu={setHostMenu}
            recentMenu={recentMenu} setRecentMenu={setRecentMenu}
            createSession={createSession} toggleFavorite={toggleFavorite}
            setEditingHost={setEditingHost} setPrefillEntry={setPrefillEntry}
            setShowImport={setShowImport} setShowAddHost={setShowAddHost}
            setRecentHidden={setRecentHidden} setConfirm={setConfirm}
            termMenu={termMenu} setTermMenu={setTermMenu}
            termsRef={termsRef} pasteTextIntoRef={pasteTextIntoRef}
            paneTermsRef={paneTermsRef} closeTmuxPane={(sid, paneId) => closeTmuxPaneRef.current(sid, paneId)}
            paneLayoutCustom={paneLayoutCustom} resetPaneLayout={resetPaneLayout}
            onOpenSearch={openSearch} sidRef={sidRef}
            searchHint={formatBinding(keymap.search, isMacPlatform())}
            searchKeyshortcuts={`${isMacPlatform() ? "Meta" : "Control"}${keymap.search.shift ? "+Shift" : ""}${keymap.search.alt ? "+Alt" : ""}+${keymap.search.key.toUpperCase()}`}
            attachSession={attachSession}
            splitDegraded={splitDegraded} splitHintOpen={splitHintOpen}
            splitHintDismissedRef={splitHintDismissedRef} setSplitHintOpen={setSplitHintOpen}
            onCollapseHostbar={() => toggleHostbar(false)}
          />
          {pasteConfirm && (
            // rev-r25 H1：对话框必须是 confirm-mask 的子元素（flex 居中+同层叠上下文）——
            // 兄弟写法下 dialog 仍是 term-wrap 流内静态项且被 mask 盖住，鼠标点不中
            <div className="confirm-mask" onClick={() => setPasteConfirm(null)}>
              <div className="confirm-dialog paste-dialog" ref={pasteConfirmRef} role="dialog" aria-modal="true" aria-labelledby="dlg-paste-title" onClick={(e) => e.stopPropagation()}>
                <div className="hk-title" id="dlg-paste-title" data-testid="paste-dialog-title">
                  {pasteConfirm.risk.length
                    ? (pasteConfirm.kind === "rerun"
                      ? t("⚠ 危险命令重跑到 {0}？", pasteConfirm.hostName)
                      : t("⚠ 危险内容粘贴到 {0}？", pasteConfirm.hostName))
                    : (pasteConfirm.kind === "rerun"
                      ? t("重跑多行命令到 {0}？", pasteConfirm.hostName)
                      : t("粘贴多行内容到 {0}？", pasteConfirm.hostName))}
                </div>
                {pasteConfirm.risk.length ? (
                  <div>{pasteConfirm.kind === "rerun"
                    ? t("重跑命令命中危险形态（与 Agent 审批同一张内置规则表）——确认后重新执行，取消则不发送任何字节。")
                    : t("粘贴内容命中危险形态（与 Agent 审批同一张内置规则表）——确认后才会发送，取消则不发送任何字节。")}</div>
                ) : (
                  <div>{pasteConfirm.kind === "wall"
                    ? t("tmux 墙按字面逐字送达（无 bracketed paste）——换行会被远端立即执行。请确认内容；取消则不发送任何字节。")
                    : pasteConfirm.kind === "rerun"
                      ? t("命令含多行——重跑会按行依次执行。请确认；取消则不发送任何字节。")
                      : t("目标终端未开启 bracketed paste——换行会被远端立即执行。请确认内容；取消则不发送任何字节。")}</div>
                )}
                {pasteConfirm.risk.length > 0 && (
                  <ul className="paste-risk" data-testid="paste-risk-list">
                    {pasteConfirm.risk.map((h, i) => (
                      <li key={i}><b>{h.reason}</b><span className="mono dim">{h.segment}</span></li>
                    ))}
                  </ul>
                )}
                <pre className="paste-preview mono">{pasteConfirm.text.length > 2000
                  ? pasteConfirm.text.slice(0, 2000) + t("\n……（预览截断，共 {0} 字符）", pasteConfirm.text.length)
                  : pasteConfirm.text}</pre>
                <div className="hk-actions">
                  <button className="danger" data-testid="paste-send" onClick={() => {
                    if (pasteConfirm.kind === "wall") {
                      // 墙粘贴：确认后交给墙自己钉死的目标格送字面（墙在此期间
                      // 退出过键入态，accept 内会拉回），不碰主终端/广播。
                      const accept = wallPasteAcceptRef.current;
                      wallPasteAcceptRef.current = null;
                      accept?.(pasteConfirm.text);
                      setPasteConfirm(null);
                      return;
                    }
                    if (pasteConfirm.kind === "rerun") {
                      // 失败要出声：确认框期间会话恰好断开时，字节没发出去不能静默
                      // （与 blocks rerunCommand 直发路径同款 toast）
                      void invoke("send_keys", { sid: pasteConfirm.sid, keys: pasteConfirm.text + "\r" })
                        .catch(() => pushToast("err", t("重跑发送失败")));
                    } else {
                      // 确认后的危险粘贴同样只进当前会话（广播抑制，与安全粘贴同口径）；
                      // tmux 面板格子的粘贴落回发起的那一格（不是主视图）
                      bcastSuppressRef.current = true;
                      try {
                        const target = pasteConfirm.paneKey
                          ? paneTermsRef.current.get(pasteConfirm.paneKey)?.term
                          : termsRef.current.get(pasteConfirm.sid)?.term;
                        target?.paste(pasteConfirm.text);
                      }
                      finally { queueMicrotask(() => { bcastSuppressRef.current = false; }); }
                    }
                    setPasteConfirm(null);
                    restoreTermFocus();
                  }}>{pasteConfirm.kind === "rerun"
                    ? (pasteConfirm.risk.length ? t("仍然重跑") : t("重跑"))
                    : (pasteConfirm.risk.length ? t("仍然发送") : t("发送"))}</button>
                  <button className="ghost" data-autofocus onClick={() => setPasteConfirm(null)}>{t("取消")}</button>
                </div>
              </div>
            </div>
          )}
          {osc52Ask && (
            // P2-c：OSC 52 写剪贴板询问卡（与粘贴确认同工艺：confirm-mask 子元素、
            // Esc 链与模态门都在列）。允许=覆盖现有剪贴板并 toast 告知；拒绝=不写任何字节。
            // 多请求排队逐张裁决，队首标题右侧标出还有几张，避免「拒绝一张就消失」的错觉。
            <div className="confirm-mask" onClick={() => shiftOsc52Ask()}>
              <div className="confirm-dialog paste-dialog" ref={osc52AskRef} role="dialog" aria-modal="true" aria-labelledby="dlg-osc52-title" onClick={(e) => e.stopPropagation()}>
                <div className="hk-title" id="dlg-osc52-title" data-testid="osc52-dialog">
                  {t("远端请求写入剪贴板 ·")} {sessions.find((s) => s.id === osc52Ask.sid)?.host_name ?? t("该会话")}{osc52Ask.source ? ` · tmux:${osc52Ask.source}` : ""}
                  {osc52Queue.length > 1 && (
                    <span className="dim" style={{ marginLeft: 8 }}>{t("（另有 {0} 个请求排队）", osc52Queue.length - 1)}</span>
                  )}
                </div>
                <div>{t("远端程序通过 OSC 52 转义序列请求改写你本机的剪贴板——允许后现有内容会被覆盖，拒绝则不写入任何字节。「始终允许」本次照写且此后不再询问（设置→终端 可改回）。读取类请求（查询）一律拒绝，不经此卡。")}</div>
                <pre className="paste-preview mono" data-testid="osc52-preview">{osc52Ask.text.length > 400
                  ? osc52Ask.text.slice(0, 400) + t("……（预览截断，共 {0} 字符）", osc52Ask.text.length)
                  : osc52Ask.text}</pre>
                <div className="hk-actions">
                  <button className="danger" data-testid="osc52-allow" onClick={() => {
                    osc52WriteRef.current(osc52Ask.sid, osc52Ask.text);
                    shiftOsc52Ask();
                    if (osc52Queue.length === 1) restoreTermFocus();
                  }}>{t("允许写入")}</button>
                  {/* 用户反馈：选区每次都弹卡太严——一键把策略翻 allow（走既有持久化），此后直写 */}
                  <button className="ghost" data-testid="osc52-allow-forever" onClick={() => {
                    osc52WriteRef.current(osc52Ask.sid, osc52Ask.text);
                    changeOsc52Policy("allow");
                    // 队列里剩下的请求用户没看过预览，不替他们默认放行：清空即可，
                    // 此后新请求按 allow 直写（旧请求已被策略变更超越，不再补写）
                    setOsc52Queue([]);
                    restoreTermFocus();
                  }}>{t("始终允许")}</button>
                  <button className="ghost" data-autofocus data-testid="osc52-deny" onClick={() => { shiftOsc52Ask(); if (osc52Queue.length === 1) restoreTermFocus(); }}>{t("拒绝")}</button>
                </div>
              </div>
            </div>
          )}
          {pendingDrop && (
            // R33 §354 终端拖入确认：目标会话在拖放开始时固定（切标签即失效，见 effect）；
            // 目录输入预填可信 cwd（无可信不借用不可见面板路径）；确认=按固定会话上传
            <div className="confirm-mask" onClick={() => setPendingDrop(null)}>
              <div className="confirm-dialog" ref={dropCardRef} role="dialog" aria-modal="true" aria-labelledby="dlg-drop-title"
                onKeyDown={(e) => { if (e.key === "Escape") setPendingDrop(null); }}
                onClick={(e) => e.stopPropagation()}>
                <div className="hk-title" id="dlg-drop-title">
                  {t("上传到")} {sessionsRef.current.find((x) => x.id === pendingDrop.sid)?.host_name ?? t("该会话")}{t("：")}
                </div>
                <div className="row" style={{ gap: 6 }}>
                  <input
                    className="mono" data-testid="drop-dir-input" data-autofocus
                    style={{ flex: 1 }} aria-label={t("远端目标目录")}
                    placeholder={pendingDropDir ? "" : t("远端目录（绝对路径，必填）")}
                    value={pendingDropDir}
                    onChange={(e) => setPendingDropDir(e.target.value)}
                    onKeyDown={(e) => { if (isImeComposing(e)) return; if (e.key === "Enter" && pendingDropDir.trim()) confirmDropUpload(); }}
                  />
                </div>
                <div className="dim" style={{ marginTop: 6, fontSize: 12 }} data-testid="drop-files-line">
                  {t("{0} 个文件：", pendingDrop.paths.length)}{pendingDrop.paths.slice(0, 3).map((p) => pathBasename(p)).join(t("、"))}
                  {pendingDrop.paths.length > 3 ? t(" 等 {0} 个", pendingDrop.paths.length) : ""}
                </div>
                {!briefRef.current?.cwd && (
                  <div className="dim" style={{ marginTop: 4, fontSize: 12 }} data-testid="drop-no-cwd-hint">
                    {t("该会话无可信工作目录（shell 集成未上报 cwd）——请填写远端目录。")}
                  </div>
                )}
                {pendingDropErr && (
                  <div className="err" style={{ marginTop: 4, fontSize: 12 }} data-testid="drop-err">{pendingDropErr}</div>
                )}
                <div className="hk-actions">
                  <button className="ghost" onClick={() => setPendingDrop(null)}>{t("取消")}</button>
                  <button data-testid="drop-confirm" disabled={!pendingDropDir.trim()} onClick={confirmDropUpload}>{t("上传到此处")}</button>
                </div>
              </div>
            </div>
          )}
          {/* R41（§6.6/S09）连接详情：**独立可关闭对话框**（§193——不与审批共用长滚动页）。
              展示连接**当时**的身份快照（§6.1：主机配置此后被改/删都不影响），
              session ID 收在「技术详情」里可复制。 */}
          {/* 连接详情（拆分⑤出仓 components/conn-detail.tsx，零语义变更）：
              **独立可关闭对话框**（§193——不与审批共用长滚动页）。展示连接**当时**的
              身份快照（§6.1），session ID 收在「技术详情」里可复制。 */}
          <ConnDetail
            detail={detail} detailErr={detailErr} closeDetail={closeDetail}
            detailPanelRef={detailPanelRef} pushToast={pushToast}
          />
          {showSettings && (
            <SettingsPanel
              settingsCat={settingsCat}
              switchSettingsCat={switchSettingsCat}
              closeSettings={closeSettings}
              settingsPanelRef={settingsPanelRef}
              appVersion={appVersion}
              buildTime={buildTime}
              updateInfo={updateInfo}
              diagBusy={diagBusy}
              onExportDiagnostics={exportDiagnostics}
              updaterCap={updaterCap}
              updaterBusy={updaterBusy}
              onAutoUpdate={autoUpdate}
              checkBusy={checkBusy}
              onCheckUpdate={checkUpdateNow}
              autonomy={autonomy}
              onToggleAutonomy={toggleAutonomy}
              appearance={appearance}
              changeAppearance={changeAppearance}
              palette={palette}
              changePalette={changePalette}
              fontSize={fontSize}
              changeFontSize={changeFontSize}
              zoomLevel={zoomLevel}
              keymap={keymap}
              resetKeyBinding={resetKeyBinding}
              keyCapture={keyCapture}
              setKeyCapture={setKeyCapture}
              applyKeymap={applyKeymap}
              persistSetting={persistSetting}
              pasteGuard={pasteGuard}
              changePasteGuard={changePasteGuard}
              copyOnSelect={copyOnSelect}
              changeCopyOnSelect={changeCopyOnSelect}
              bellNotify={bellNotify}
              changeBellNotify={changeBellNotify}
              osc52Policy={osc52Policy}
              changeOsc52Policy={changeOsc52Policy}
              localShells={localShells}
              localShellId={localShellId}
              autoLocal={autoLocal}
              onChangeAutoLocal={changeAutoLocal}
              locale={locale} onChangeLocale={changeLocale}
              onChangeLocalShell={(id) => { setLocalShellId(id); persistSetting(SETTING_LOCAL_SHELL, id); }}
              termFont={termFont}
              onChangeTermFont={changeTermFont}
              termLigatures={termLiga}
              onChangeTermLigatures={changeTermLigatures}
              termCursorStyle={termCursorStyle}
              onChangeTermCursorStyle={changeTermCursorStyle}
              termCursorBlink={termCursorBlink}
              onChangeTermCursorBlink={changeTermCursorBlink}
              termScrollback={termScrollback}
              onChangeTermScrollback={changeTermScrollback}
              termLetterSpacing={termLetterSpacing}
              onChangeTermLetterSpacing={changeTermLetterSpacing}
              termWheelRate={termWheelRate}
              onChangeTermWheelRate={changeTermWheelRate}
              identities={identities}
              hosts={hosts}
              referencedIdentityIds={referencedIdentityIds}
              credNewOpen={credNewOpen}
              setCredNewOpen={setCredNewOpen}
              credNewErr={credNewErr}
              setCredNewErr={setCredNewErr}
              credNewOk={credNewOk}
              setCredNewOk={setCredNewOk}
              credLabel={credLabel}
              setCredLabel={setCredLabel}
              credPem={credPem}
              setCredPem={setCredPem}
              credPass={credPass}
              setCredPass={setCredPass}
              credBusy={credBusy}
              credErr={credErr}
              setCredErr={setCredErr}
              credDraftTo={credDraftTo}
              setCredDraftTo={setCredDraftTo}
              discardCredDraft={discardCredDraft}
              submitNewIdentity={submitNewIdentity}
              setConfirm={setConfirm}
              collab={collab}
              mcp={mcp}
              collabEnabled={collabEnabled}
              collabStateText={collabStateText}
              collabBusy={collabBusy}
              showAgentHelp={showAgentHelp}
              setShowAgentHelp={setShowAgentHelp}
              openDisableDialog={openDisableDialog}
              retryDisableConvergence={retryDisableConvergence}
              enableCollab={enableCollab}
              issueAgent={issueAgent}
              onIssuedTokenPending={noteIssuedTokenPending}
              revokeAgent={revokeAgent}
              recordsRows={recordsRows} recordsFilter={recordsFilter}
              recordsBusy={recordsBusy} recordsExportBusy={recordsExportBusy}
              onRecordsFilter={setRecordsFilter}
              onRecordsRefresh={() => void refreshRecords(recordsFilter)}
              onRecordsExport={() => void exportRecords()}
              recordsHasMore={!recordsComplete} recordsMoreBusy={recordsMoreBusy}
              onRecordsMore={() => void loadMoreRecords()}
              recordsSessionNames={sessionIdent}
              recordsRetention={recordsRetention} onChangeRecordsRetention={changeRecordsRetention}
              transferAutonomy={transferAutonomy} onChangeTransferAutonomy={changeTransferAutonomy}
              loadTriggers={loadTriggers} saveTriggers={saveTriggers}
            />
          )}
        </div>
        </div>{/* /term-col */}

        {/* 右侧任务面板（§4.3/§6.6）：一次只呈现文件 / 转发 / 协作 / 活动记录之一；窄窗改中央完整视图 */}
        {rightPanel && (
          <aside className={"task-panel" + (tpFull ? " tp-full" : "") + (dragOver && dragZone === "panel" ? " drop-target" : "")} aria-label={t("任务面板")} ref={taskPanelRef}
            style={tpFull ? undefined : { width: taskPanelW }}>
            {!tpFull && (
              <div className="tp-grip" role="separator" aria-orientation="vertical"
                aria-label={t("拖动调整面板宽度（320–560）")} title={t("拖动调整面板宽度")}
                onPointerDown={tpGripDown} onPointerMove={tpGripMove} onPointerUp={tpGripUp}
                onPointerCancel={() => { tpGripDrag.current = false; }} />
            )}
            <div className="tp-head">
              <b data-testid="tp-title">{rightPanel === "files" ? t("文件") : rightPanel === "forwards" ? t("端口转发") : rightPanel === "log" ? t("活动记录") : rightPanel === "blocks" ? t("命令块") : t("协作")}</b>
              {tpFull && <span className="dim" style={{ fontSize: 11 }}>{t("空间不足——完整视图，终端仍在运行")}</span>}
              {rightPanel === "collab" && pendingCount > 0 && <span className="badge agent">{t("{0} 待处理", pendingCount)}</span>}
              <span style={{ flex: 1 }} />
              <button className="ghost icon-btn" title={t("关闭面板（再次点「文件」/「工具」项亦可）")} aria-label={t("关闭任务面板")}
                data-testid="tp-close"
                onClick={() => setRightPanel(null)}><IconX size={14} /></button>
            </div>
            <div className="tp-scroll">
          {rightPanel === "collab" && (
            /* 审批区（拆分⑤出仓 components/collab-panel.tsx，零语义变更） */
            <CollabApprovals
              collabEnabled={collabEnabled || embeddedReady} collab={collab} collabStateText={collabStateText}
              collabConfigured={agentSurfaceReady} collabActive={collabActive}
              pendingCount={pendingCount} approvalGroups={approvalGroups}
              pendingApprovals={pendingApprovals} resolvedApprovals={resolvedApprovals}
              confirmId={confirmId} setConfirmId={setConfirmId}
              editingId={editingId} setEditingId={setEditingId}
              editedCmd={editedCmd} setEditedCmd={setEditedCmd}
              persistId={persistId} setPersistId={setPersistId}
              persistPattern={persistPattern} setPersistPattern={setPersistPattern}
              decide={decide} rememberThenDecide={rememberThenDecide} openSettingsAt={openSettingsAt}
            />
          )}
          {rightPanel === "files" && (
            <FilesPanel
              sid={sid} brief={brief}
              connected={!current || current.state === "Connected" || current.state === "Reconfirming"}
              sftpWrapRef={sftpWrapRef} sftpCrumbsRef={sftpCrumbsRef}
              sftpListRef={sftpListRef} sftpAnchorRef={sftpAnchorRef}
              sftpPath={sftpPath} sftpPathInput={sftpPathInput}
              sftpEntries={sftpEntries} sftpLoading={sftpLoading} sftpErr={sftpErr}
              sftpSel={sftpSel} sftpHist={sftpHist} sftpFwd={sftpFwd} sftpCursor={sftpCursor}
              sftpEditPath={sftpEditPath} sftpFilter={sftpFilter} sftpShowHidden={sftpShowHidden}
              sftpSaveAs={sftpSaveAs} sftpSort={sftpSort} sftpShown={sftpShown} sftpListW={sftpListW}
              byPathOpen={byPathOpen} downloadPath={downloadPath}
              setSftpSel={setSftpSel} setSftpEditPath={setSftpEditPath}
              setSftpPathInput={setSftpPathInput} setSftpFilter={setSftpFilter}
              setDownloadPath={setDownloadPath} setByPathOpen={setByPathOpen}
              setShowHidden={setShowHidden} setSftpSaveAs={setSftpSaveAs} setSftpSort={setSftpSort}
              sftpGoBack={sftpGoBack} sftpGoFwd={sftpGoFwd} navigateTo={navigateTo} loadDir={loadDir}
              pickAndUpload={pickAndUpload} startDownload={startDownload}
              sftpListKey={sftpListKey} sftpRowClick={sftpRowClick} sftpActivate={sftpActivate}
              sftpDownloadSelected={sftpDownloadSelected} downloadRemote={downloadRemote}
            />
          )}
          {rightPanel === "forwards" && (
            <>
          <div className="section">
            <h4>{t("端口转发")}</h4>
            {!sid ? (
              <div className="side-quiet">{t("连接 SSH 会话后可建本地 / 远程 / SOCKS5 转发，随会话断开自动失效、重连自动恢复。")}</div>
            ) : (
              <>
                {/* 表单（§6.6）：类型解释为人类语义、-L/-R/-D 作辅助；监听地址是显式
                    字段（默认 127.0.0.1）；目标标注从哪一端解析；字段级错误就地高亮。 */}
                <div className="row fwd-form">
                  <select value={fwdKind} onChange={(e) => { setFwdKind(e.target.value as "Local" | "Remote" | "Dynamic"); setFwdFieldErr(null); setFwdExposeAck(false); }} title={t("转发类型")}>
                    <option value="Local">{t("本地端口访问远端服务（-L）")}</option>
                    <option value="Remote">{t("远端端口访问本机服务（-R）")}</option>
                    <option value="Dynamic">{t("SOCKS5 代理（-D）")}</option>
                  </select>
                </div>
                {/* A 行：监听地址（显式字段）+ 监听端口 */}
                <div className="row fwd-form" style={{ marginTop: 4, alignItems: "flex-end" }}>
                  <div className="ah-field" style={{ flex: 1 }}>
                    <label>{t("监听地址")}{fwdKind === "Remote" ? t("（在远端服务器）") : t("（在本机）")}</label>
                    <input className="mono" value={fwdLAddr} placeholder="127.0.0.1"
                      onChange={(e) => { setFwdLAddr(e.target.value); setFwdExposeAck(false); setFwdFieldErr(null); }} />
                  </div>
                  <div className="ah-field" style={{ width: 88 }}>
                    <label>{fwdKind === "Remote" ? t("远端端口") : t("本地端口")}</label>
                    <input className="mono" value={fwdPort} placeholder="8080"
                      onChange={(e) => { setFwdPort(e.target.value); setFwdFieldErr(null); }} />
                  </div>
                </div>
                {fwdFieldErr?.listen && <div className="fwd-err" data-testid="fwd-err-listen">⚠ {fwdFieldErr.listen}</div>}
                {/* 非回环监听：显示暴露范围 + 必须主动勾选（§6.6） */}
                {!isLoopbackAddr(fwdLAddr) && (
                  <label className="fwd-expose" data-testid="fwd-expose">
                    <input type="checkbox" checked={fwdExposeAck} onChange={(e) => { setFwdExposeAck(e.target.checked); setFwdFieldErr(null); }} />
                    <span>{t("我确认暴露范围：监听")} <b>{fwdLAddr}</b> {t("将对本机所在网络的所有设备可见，任何能访问该地址的设备都可经此转发")}
                      {fwdKind === "Dynamic" ? t("（SOCKS5 无认证，等同开放代理）") : ""}。</span>
                  </label>
                )}
                {/* B 行：目标（仅 -L/-R），标注解析端 */}
                {fwdKind !== "Dynamic" && (
                  <div className="row fwd-form" style={{ marginTop: 4, alignItems: "flex-end" }}>
                    <div className="ah-field" style={{ flex: 1 }}>
                      <label>{fwdKind === "Remote" ? t("目标（本机侧解析）") : t("目标（远端侧解析）")}</label>
                      <input className="mono" value={fwdHost} placeholder={fwdKind === "Remote" ? t("回到本机·主机") : t("目标主机")}
                        onChange={(e) => { setFwdHost(e.target.value); setFwdFieldErr(null); }} />
                    </div>
                    <div className="ah-field" style={{ width: 76 }}>
                      <label>{t("端口")}</label>
                      <input className="mono" value={fwdTPort} placeholder="22"
                        onChange={(e) => { setFwdTPort(e.target.value); setFwdFieldErr(null); }} />
                    </div>
                  </div>
                )}
                {fwdFieldErr?.target && <div className="fwd-err" data-testid="fwd-err-target">⚠ {fwdFieldErr.target}</div>}
                <div className="row" style={{ marginTop: 6 }}>
                  <button disabled={fwdBusy} onClick={() => void addForward()}>{t("启动转发")}</button>
                  <span className="side-quiet" style={{ flex: 1 }}>
                    {fwdKind === "Local" ? t("本地端口访问远端服务：本机监听，流量经 SSH 到远端目标。")
                      : fwdKind === "Remote" ? t("远端端口访问本机服务：远端服务器监听，流量回程到本机目标。")
                      : t("SOCKS5 代理：本机监听无认证代理，目标由每次连接决定。")}
                  </span>
                </div>
                {forwards.length === 0 && <div className="side-quiet">{t("暂无转发。")}</div>}
                {forwards.map((f) => {
                  const k = "Local" in f.spec ? "Local" : "Remote" in f.spec ? "Remote" : "Dynamic";
                  const v = (f.spec as Record<string, { listen_addr?: string; listen_port: number; target_host?: string; target_port?: number }>)[k];
                  const laddr = v.listen_addr || "127.0.0.1";
                  // 人类可读路线（§6.6）；目标解析端在串内标注（Local 远端解析 / Remote 本机解析）
                  const fwdText = k === "Local" ? `${laddr}:${v.listen_port} → ${v.target_host}:${v.target_port}`
                    : k === "Remote" ? `${t("远端")} ${laddr}:${v.listen_port} → ${t("本机")} ${v.target_host}:${v.target_port}`
                    : `SOCKS5 ${laddr}:${v.listen_port}`;
                  // §6.6：监听成功与目标可达**分开显示**——不把「正在监听」表述为服务健康
                  const listenText = f.state === "Failed" ? t("监听失败") : t("监听中");
                  const healthText = f.state === "Listening" ? t("目标可达性未验证（首次连接时确认）")
                    : f.state === "Degraded" ? t("目标不可达：{0}", f.error ?? t("隧道/目标暂不可用（恢复后自动重连）"))
                    : `${f.error ?? t("未知错误")}`;
                  const stopping = fwdStopping.has(f.id);
                  const stopErr = fwdStopErr[f.id];
                  return (
                    <div className="card fwd-row" key={f.id} title={`${fwdText} · ${listenText} · ${healthText}`}>
                      <div className="row" style={{ alignItems: "center" }}>
                        <span className={"fwd-kind " + k.toLowerCase()}>{k === "Local" ? "-L" : k === "Remote" ? "-R" : "-D"}</span>
                        <div style={{ flex: 1, minWidth: 0 }} className="mono">
                          <div className="xfer-name">{fwdText}</div>
                        </div>
                        <span className={"fwd-state " + (f.state === "Listening" ? "listen" : f.state === "Degraded" ? "warn" : "err")}>{listenText}</span>
                        <button className="ghost" disabled={stopping}
                          title={stopErr ? t("上次停止失败：{0}——点击重试", stopErr) : t("停止转发（等待核心确认）")}
                          onClick={() => void stopForward(f.id)}>{stopping ? t("停止中…") : stopErr ? t("重试停止") : t("停止")}</button>
                      </div>
                      <div className={"mono xfer-sub" + (f.state === "Failed" ? " err" : f.state === "Degraded" ? " warn" : "")}>{healthText}</div>
                    </div>
                  );
                })}
              </>
            )}
          </div>

            </>
          )}
          {rightPanel === "blocks" && (
            /* P1-b（FR-10 V2）：命令块时间线——BlockIndex 的人类侧呈现；
               重跑/复制/定位的动作实现都在宿主（粘贴安全链、剪贴板、search addon） */
            <BlocksPanel
              sid={sid} blocks={blocksList} busy={blocksBusy} err={blocksErr} failIdx={blocksFailIdx}
              load={() => void loadBlocks()}
              rerun={(cmd) => { if (sid) rerunCommand(sid, cmd); }}
              copy={copyBlock}
              locate={(cmd) => { if (sid) locateBlock(sid, cmd); }}
            />
          )}
          {rightPanel === "log" && (
            <ActivityLogPanel
              logScope={logScope} setLogScope={setLogScope}
              logActor={logActor} setLogActor={setLogActor}
              logAction={logAction} setLogAction={setLogAction}
              sid={sid} logEvents={logEvents} logTotal={logTotal}
              logBusy={logBusy} logErr={logErr}
              sessionIdent={sessionIdent} loadLog={loadLog}
              openTimeline={() => openSettingsAt("records")}
            />
          )}
          {rightPanel === "collab" && (
            /* 委托/任务目标/现场简报（拆分⑤出仓 components/collab-panel.tsx，零语义变更） */
            <CollabDelegate
              sid={sid} current={current} owner={owner}
              collabEnabled={collabEnabled} collabConfigured={agentSurfaceReady}
              openDelegate={openDelegate} takeover={takeover} openSettingsAt={openSettingsAt}
              goalRef={goalRef} goalDraft={goalDraft} setGoalDraft={setGoalDraft}
              goalDirty={goalDirty} brief={brief} saveGoal={saveGoal}
            />
          )}
            </div>
          </aside>
        )}
        {/* 右缘图标栏（活动栏轮）：任务面板五视图的常驻入口，与左活动栏同视觉语言。
            只加入口不减：状态栏/工具栏既有开关原样保留（依赖它们的 spec 与肌肉记忆不动） */}
        <div className="rb-rail" data-testid="rb-rail" aria-label={t("任务面板视图")}>
          <button className={"rail-btn" + (rightPanel === "files" ? " ts-open" : "")} data-testid="rb-files"
            title={t("文件")} aria-label={t("文件面板")} aria-pressed={rightPanel === "files"}
            onClick={() => setRightPanel(rightPanel === "files" ? null : "files")}><IconFolder size={17} /></button>
          <button className={"rail-btn" + (rightPanel === "collab" ? " ts-open" : "")} data-testid="rb-collab"
            title={t("协作")} aria-label={t("协作面板")} aria-pressed={rightPanel === "collab"}
            onClick={() => setRightPanel(rightPanel === "collab" ? null : "collab")}>
            <IconUsers size={17} />
            {pendingCount > 0 && <span className="rail-badge">{pendingCount > 9 ? "9+" : pendingCount}</span>}
          </button>
          {remoteOpen && (
            <button className={"rail-btn" + (rightPanel === "forwards" ? " ts-open" : "")} data-testid="rb-forwards"
              title={t("端口转发")} aria-label={t("端口转发面板")} aria-pressed={rightPanel === "forwards"}
              onClick={() => setRightPanel(rightPanel === "forwards" ? null : "forwards")}><IconShuffle size={17} /></button>
          )}
          <button className={"rail-btn" + (rightPanel === "log" ? " ts-open" : "")} data-testid="rb-log"
            title={t("活动记录")} aria-label={t("活动记录面板")} aria-pressed={rightPanel === "log"}
            onClick={() => setRightPanel(rightPanel === "log" ? null : "log")}><IconRows size={17} /></button>
          <button className={"rail-btn" + (rightPanel === "blocks" ? " ts-open" : "")} data-testid="rb-blocks"
            title={t("命令块")} aria-label={t("命令块面板")} aria-pressed={rightPanel === "blocks"}
            onClick={() => setRightPanel(rightPanel === "blocks" ? null : "blocks")}><IconBlocks size={17} /></button>
        </div>
        </div>{/* /content */}

        {/* R35 S08 §194：传输队列=工作区底部抽屉，默认收起；后台事件只更新
            状态条计数不自动展开；抽屉关闭不影响任务（纯展示层）。展开不销毁
            终端实例（兄弟节点，无重挂）。 */}
        {queueOpen && (
          <TransferQueueDrawer
            transfers={transfers} queueOpen={queueOpen} setQueueOpen={setQueueOpen}
            sidRef={sidRef} hostLabel={hostLabel} canRetry={canRetry}
            decideCollision={decideCollision} verifyOutcome={verifyOutcome}
            locateTransfer={locateTransfer} retryTransfer={retryTransfer}
            openTransfer={openTransfer}
          />
        )}

        {/* 页脚状态条（用户反馈合并两栏）：原 28px 资源监控条 + 24px 状态条上下两行
            占掉终端高度，现合为一行——左侧 SSH/编码短标与远端资源采样（Fresh 独立
            通道直读 /proc，不进终端/审计），右侧广播/块/转发/传输入口。监控采样
            不可用（非 Linux 远端/连续失败）时 MetricsBar 整段自隐藏，状态条照常。
            key=sid：切签重置差分基线，避免跨主机算出假速率 */}
        <footer className="statusbar">
          <span className="mono sb-left">{sbLeft}</span>
          {sid && current && <span className="sb-div" aria-hidden="true" />}
          {sid && current && (
            <MetricsBar
              key={sid}
              sid={sid}
              kind={current.kind}
              user={hosts.find((h) => h.id === current.host_id)?.username}
              hostName={current.host_name}
            />
          )}
          <span className="sb-right">
            <button className={"sb-btn" + (broadcastTargets.length > 0 ? " ts-open" : "")} data-testid="sb-broadcast" title={t("广播输入：同一键入同时发到勾选的会话（点开选择目标）")} aria-pressed={broadcastOpen}
              onClick={() => setBroadcastOpen(!broadcastOpen)}>{t("广播")} <b>{broadcastTargets.length > 0 ? broadcastTargets.length : ""}</b></button>
            <button className={"sb-btn" + (rightPanel === "blocks" ? " ts-open" : "")} data-testid="sb-blocks" title={t("命令块：最近命令时间线（shell 集成 OSC 133）")} aria-pressed={rightPanel === "blocks"}
              onClick={() => setRightPanel(rightPanel === "blocks" ? null : "blocks")}>{t("块")} <b>{blocksList.length > 0 ? blocksList.length : ""}</b></button>
            {remoteOpen && <button className="sb-btn" title={t("端口转发")} onClick={() => setRightPanel(rightPanel === "forwards" ? null : "forwards")}>{t("转发")} <b>{forwards.length}</b></button>}
            <button className={"sb-btn" + (queueOpen ? " ts-open" : "") + (awaitingTransfers > 0 ? " attn" : "")} data-testid="sb-transfer" title={t("传输队列（底部抽屉；冲突待裁决时自动展开并高亮计数）")} aria-pressed={queueOpen}
              onClick={() => setQueueOpen(!queueOpen)}>{t("传输")} <b>{runningTransfers}</b> {queueOpen ? "⌃" : "⌄"}</button>
          </span>
        </footer>
        </main>
      </div>{/* /workspace */}

      {/* Toast（§六/P3）：右下角轻通知，普通 2.6s/带动作 8s 自动消失，不挡交互
          （栈 pointer-events:none，动作钮自身收回事件）。
          live 级别逐条给：err 用 assertive 立即播报，其余 polite（审核吹毛求疵-4） */}
      <div className="toast-stack">
        {toasts.map((tt) => {
          const act = tt.action;
          return (
            <div className={"toast " + tt.kind} key={tt.id} aria-live={tt.kind === "err" ? "assertive" : "polite"}>
              {tt.text}
              {act && (
                <button className="toast-act" data-testid="toast-action" title={act.title}
                  onClick={() => { act.run(); setToasts((cur) => cur.filter((x) => x.id !== tt.id)); }}>{act.label}</button>
              )}
              <button className="toast-x" title={t("关闭通知")} aria-label={t("关闭通知")}
                onClick={() => setToasts((cur) => cur.filter((x) => x.id !== tt.id))}>×</button>
            </div>
          );
        })}
      </div>
      {/* 十九轮：命令面板（⌘K）；Esc/遮罩关闭走浮层链与本组件内键盘 */}
      <CommandPalette open={paletteOpen} items={paletteItems} onClose={() => setPaletteOpen(false)} />

      {/* P2-a 广播输入目标浮层：状态栏 chip / 工具菜单 / ⌘K 打开；点外关闭 */}
      {broadcastOpen && (
        <div className="broadcast-pop" ref={broadcastPopRef} data-testid="broadcast-pop" role="dialog" aria-label={t("广播输入")}>
          <div className="bp-title">{t("广播输入")}</div>
          <div className="bp-note">{t("打字与 Ctrl/⌥ 控制键会同时发到勾选的会话；当前会话始终接收（勾选 = 切走后仍接收）。粘贴与块重跑只进当前会话，不广播。离线目标自动跳过并在其终端里告示。")}</div>
          {sessions.length === 0 ? (
            <div className="bp-empty" data-testid="broadcast-empty">{t("没有打开的会话。")}</div>
          ) : (
            <div className="bp-list">
              {sessions.map((s) => {
                const stl = stateLabel(s.state);
                return (
                  <label key={s.id} className="bp-row" data-testid="broadcast-row" data-sid={s.id} data-state={s.state}>
                    <input type="checkbox" data-testid="broadcast-check" checked={broadcastTargets.includes(s.id)}
                      onChange={() => toggleBroadcast(s.id)} />
                    <span className="bp-name">{tabNames[s.id] ?? s.host_name}{sid === s.id ? t("（当前）") : ""}</span>
                    {s.control_owner === "Agent" && (
                      <span className="bp-owner" title={t("该会话由 Agent 掌握——广播键入按人类输入记块，不会自动暂停 Agent")}>Agent</span>
                    )}
                    <span className={"bp-state " + stl.cls}>{stl.text}</span>
                  </label>
                );
              })}
            </div>
          )}
          <div className="bp-foot">
            <button className="ghost" data-testid="broadcast-clear" disabled={broadcastTargets.length === 0}
              onClick={clearBroadcast}>{t("全部取消")}</button>
            <button className="primary" data-testid="broadcast-close" onClick={() => setBroadcastOpen(false)}>{t("完成")}</button>
          </div>
        </div>
      )}
      {/* R31 §350 文件动作菜单：双击/Enter 文件弹出可用动作（不直接执行）；点外/Esc 关 */}
      {sftpMenu && (
        <SftpFileMenu
          sftpMenu={sftpMenu} sftpMenuRef={sftpMenuRef} winW={winW}
          sftpPathRef={sftpPathRef} setSftpMenu={setSftpMenu} downloadRemote={downloadRemote}
        />
      )}
    </div>
  );
}
