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
  bindingOf, parseKeymap, conflictOf, formatBinding, sameBinding,
  type Binding, type KeyActionId,
} from "./keymap";
import { CommandPalette, type PaletteItem } from "./palette";
import {
  registerZoomHotkeys, onZoomChange, currentZoom,
  zoomIn, zoomOut, zoomReset,
} from "./zoom";
import { applyCheckpoint, createOutputFeed, setCursorDefault } from "./terminal/checkpoint";
import type { OutputFeed } from "./terminal/checkpoint";
import type {
  Host, HostDraft, HostMeta, RecentHost, SshConfigPreview, SshImportOutcome, SessionInfo, ApprovalItem, AuthDraft,
  PendingHostKey, PendingAuthPrompt, SessionBrief as Brief, AuditEvent,
  IdentityMeta, TakeoverReport, TransferHandle, DirEntryS, ForwardSpec, ForwardInfo,
  AttemptPhase, AttemptInfo, ErrorPayload, ConnectionEvent, CancelOutcome, SessionStateEvent,
  BeginConnectionOpts,
  TransferTask, CollisionDecision, SessionDetail, ShellCapability, CollabStatus, DisableImpact,
  McpStatus, AutonomyGrant, ActionRecord, RecordsQuery, RecordsRange, PasteHit, BlockInfo, TriggerRule,
  RestoreEntry, LocalShell, UpdateCheck, UpdaterInfo,
  TmuxStatus,
} from "./adapter/wire";
import { recordsRangeSince } from "./components/records-pane";
import { MonitorView, type MonitorCardHost } from "./components/monitor-view";
import { isMonitorPaused, setMonitorPaused as setStoreMonitorPaused, setMonEnabled, syncMonitorTargets } from "./monitor-store";
import {
  IconSliders, IconPlus, IconX, IconSplit, IconStop, IconPencil, IconTrash, IconStar,
  IconChevronUp, IconChevronDown, IconChevronLeft, IconChevronRight, IconTerminal,
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
  ChromePalette, ctrlCharOf, epistemicLabel, exitText,
  FONT_DEFAULT, FONT_MAX, FONT_MIN, friendlyError, hhmm, inputBlockedState,
  normApprovalStatus, PALETTES, PALETTE_DEFAULT, pathBasename,
  runBench, SEARCH_OPTS, SETTING_FONT, SETTING_FONT_LEGACY, SETTING_LOCAL_SHELL, SETTING_PALETTE,
  SETTING_TERM_CURSOR_BLINK, SETTING_TERM_CURSOR_STYLE, SETTING_TERM_FONT_FAMILY,
  SETTING_TERM_LETTER_SPACING, SETTING_TERM_LIGATURES, SETTING_TERM_SCROLLBACK,
  stateLabel, stampLocal, stopOutcomeText,
  SPLIT_DEGRADE_BELOW, SPLIT_DEGRADE_BELOW_H, SPLIT_FRAC_MAX, SPLIT_FRAC_MIN,
  SPLIT_RECOVER_AT, SPLIT_RECOVER_AT_H, tauriListen, THEMES, ThemePreset,
  TransferCard, themeById, TZ_NOTE, useDialogFocus,
  TERM_FONT_DEFAULT, TERM_FONTS, termFontCss, TERM_LETTER_SPACING_DEFAULT, TERM_SCROLLBACK_DEFAULT,
  type Appearance, type SettingsCat, type SplitDir, type SplitPanes, type TermCursorStyle,
} from "./app-data";
import { localeNow, setLocale, SETTING_LOCALE, t, type Locale } from "./i18n";
import { WinControls } from "./components/window-controls";
import { QuickConnectForm } from "./components/quick-connect";
import { AddHostForm } from "./components/add-host";
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

export default function App() {

  const termRef = useRef<HTMLDivElement>(null);
  const xtermRef = useRef<Terminal | null>(null);
  const sidRef = useRef<string | null>(null);          // onData 闭包用 ref，避免 stale state
  const subscribedRef = useRef<Set<string>>(new Set()); // 每会话只订阅一次，防重复输出
  // 每会话一个独立 xterm 实例：切换会话 = 显示/隐藏，滚动历史与 vim 全屏状态原地保留
  // （P0 终端品质轮：webgl/liga 记住当前渲染器句柄——连字开关要在两者间热切换）
  const termsRef = useRef<Map<string, { term: Terminal; el: HTMLDivElement; search: SearchAddon; tag: HTMLDivElement; feed: OutputFeed | null; webgl: WebglAddon | null; liga: LigaturesAddon | null }>>(new Map());
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
  // 分屏（T19；分屏⑥轮起方向可选+可拖拽）：main=左主/上主 pane，second=右副/下副
  // pane，dir=布局方向；null=单 pane。布局（谁在哪格、方向、占比）与焦点（sid）解耦
  // ——分屏时点另一格只挪焦点，终端内容不跳动。ref 与 state 并行：fitTerminal/看门狗
  // 等回调内读 ref，避开 stale closure。splitDir 是「记住的上次方向」（app 运行期内），
  // 各入口不带显式方向时沿用；splitFrac 主格占比，拖拽条/双击复位写它
  const [splitPanes, setSplitPanes] = useState<SplitPanes | null>(null);
  const splitRef = useRef<SplitPanes | null>(null);
  const [splitDir, setSplitDir] = useState<SplitDir>("lr");
  const splitDirRef = useRef<SplitDir>("lr");
  const splitFracRef = useRef(0.5);
  // 把占比写进 #term 的 --split-frac（CSS 几何与分割条定位都吃这个变量）
  const applySplitFrac = useCallback(() => {
    const el = termRef.current;
    if (el) el.style.setProperty("--split-frac", splitFracRef.current.toFixed(4));
  }, []);
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
  // 会话增减不改 tabbar 盒子（RO 不触发）——单独补测一次，不再为此拆掉重建 observer
  useEffect(() => { measureTabbar(); }, [measureTabbar, sessions.length]);
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
    setToasts((cur) => [...cur.slice(-3), { id, kind, text, action }]);
    setTimeout(() => setToasts((cur) => cur.filter((t) => t.id !== id)), action ? 8000 : 2600);
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
  const [osc52Ask, setOsc52Ask] = useState<{ sid: string; text: string } | null>(null);
  const osc52AskRef = useRef<HTMLDivElement | null>(null);
  const [pasteConfirm, setPasteConfirm] = useState<{ sid: string; hostName: string; text: string; risk: PasteHit[]; multi: boolean; kind: "paste" | "rerun" } | null>(null);
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
  useEffect(() => {
    osc52WriteRef.current = (sid, text) => {
      const host = sessionsRef.current.find((x) => x.id === sid)?.host_name ?? t("该会话");
      (inTauri ? clipboard.writeText(text) : navigator.clipboard?.writeText(text))
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
  const pasteTextInto = (term: Terminal, sessionSid: string, text: string) => {
    if (!text) return;
    // rev-r26 低-5：断线/重连期粘贴与键入同口径拦截（确认框照弹会误导——
    // 确认后字节仍被 onData 拦下）；⚠ 与 onData 告示同文
    const pst = sessionsRef.current.find((x) => x.id === sessionSid)?.state;
    if (pst && inputBlockedState(pst)) {
      const why = pst === "Disconnected" ? t("会话已断开") : t("网络中断（自动重连中）");
      term.write(`\r\n\x1b[33m⚠ ${t("{0}——粘贴未发送。", why)}\x1b[0m\r\n`);
      return;
    }
    const multi = pasteGuardRef.current && /[\n\r]/.test(text) && !term.modes.bracketedPasteMode;
    const deliver = (risk: PasteHit[]) => {
      if (multi || risk.length) {
        const h = sessionsRef.current.find((x) => x.id === sessionSid);
        setPasteConfirm({
          sid: sessionSid,
          hostName: h?.host_name ?? sessionSid.slice(0, 8),
          text,
          risk,
          multi,
          kind: "paste",
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
  // 十一轮：标签右键菜单——按状态显隐的会话操作（分屏/重连/复制连接/详情/关闭）
  const [tabMenu, setTabMenu] = useState<{ x: number; y: number; sid: string } | null>(null);
  // 十一轮续：右键通道补全——主机卡（连接/收藏/编辑/删除）与终端区（复制/粘贴/全选）
  const [hostMenu, setHostMenu] = useState<{ x: number; y: number; hostId: string } | null>(null);
  const [termMenu, setTermMenu] = useState<{ x: number; y: number; sid: string; hasSel: boolean } | null>(null);
  // 本轮：最近连接行右键菜单（连接/编辑主机/从最近连接隐藏/删除主机）
  const [recentMenu, setRecentMenu] = useState<{ x: number; y: number; hostId: string } | null>(null);
  // 十四轮：标签重命名——sid → 自定名（覆盖 host_name 展示；复制标签页后同名「本机×2」
  // 无法区分）。会话生命周期内有效（会话本就不跨重启存活），不入 vault。
  const [tabNames, setTabNames] = useState<Record<string, string>>({});
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
  // —— 十五轮：标签拖拽排序；拖拽组合分屏轮起改 pointer 自定义拖拽 ——
  // 会话期内的显示顺序事实源；list_sessions 整表刷新（连接/断开触发）后仍按此序渲染。
  // 不入 vault（会话本不跨重启）。⌘1-9 / ⌘⇧[] 读同一数组，快捷键序=所见序。
  // 弃 HTML5 DnD 的原因：wry 为 onDragDropEvent（文件拖入上传）在 WebView2 HWND 上
  // RevokeDragDrop+RegisterDragDrop 换掉了系统 IDropTarget，页内 dragstart 走 OS 拖放
  // 循环根本发不起来——真机拖不动的根因；pointer 事件不进该循环，三端行为一致。
  const tabOrderRef = useRef<string[]>([]);
  const [tabDragSid, setTabDragSid] = useState<string | null>(null);
  const tabDragRef = useRef<{ sid: string; startX: number; startY: number; active: boolean } | null>(null);
  const dragClickSupRef = useRef(false); // 拖后随至的 click 不当「激活标签」
  const [tabDropHint, setTabDropHint] = useState<{ sid: string; before: boolean } | null>(null);
  // 拖标签组合分屏：悬在 #term 上时的落点提示（l/r/t/b 象限；null=不在终端区）。
  // pointermove 高频触发——同值复用旧引用，避免整树重渲染（tabDropHint 同款守卫）
  const [termDropHint, setTermDropHint] = useState<"l" | "r" | "t" | "b" | null>(null);
  function applyTabOrder<T extends { id: string }>(list: T[]): T[] {
    const rank = tabOrderRef.current;
    if (!rank.length) return list;
    const pos = new Map(rank.map((id, i) => [id, i] as const));
    return [...list].sort((a, b) => (pos.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (pos.get(b.id) ?? Number.MAX_SAFE_INTEGER));
  }
  const reorderTabs = (fromSid: string, toSid: string, before: boolean) => {
    const ids = sessionsRef.current.map((s) => s.id);
    const from = ids.indexOf(fromSid);
    const to = ids.indexOf(toSid);
    if (from < 0 || to < 0 || from === to) return;
    ids.splice(from, 1);
    let to2 = ids.indexOf(toSid);
    if (!before) to2 += 1;
    ids.splice(to2, 0, fromSid);
    tabOrderRef.current = ids;
    setSessions(applyTabOrder(sessionsRef.current));
  };
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
  // 本地终端一等公民轮：本机 shell 探测清单（设置「本地 Shell」下拉 + 本机右键
  // 「用 … 新开」数据源）与默认选择 id（KV，空串=系统默认 $SHELL/PowerShell 回退）
  const [localShells, setLocalShells] = useState<LocalShell[]>([]);
  const [localShellId, setLocalShellId] = useState("");
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
  const prevSidRef = useRef<string | null>(null);
  // 简报 ref：拖拽上传回调里读当前 cwd（不进依赖数组，避免监听器随简报反复重订阅）
  const briefRef = useRef<Brief | null>(null);
  useEffect(() => { briefRef.current = brief; }, [brief]);
  const [owner, setOwner] = useState<"Human" | "Agent">("Agent");
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
  const [toolsOpen, setToolsOpen] = useState(false);
  const [tabsMenuOpen, setTabsMenuOpen] = useState(false);
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
  // R13 统一分发：keymap 解析（actions.ts）与执行分离；ref 持有最新执行器，
  // 捕获层 effect 与 xterm 键处理器都经它走同一条路。modal/主机栏开合同步 ref。
  const dispatchRef = useRef<(a: AppAction) => boolean>(() => false);
  const modalRef = useRef(false);
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
  const applyFocus = useCallback((on: boolean, announce = true) => {
    setFocusMode(on);
    try { localStorage.setItem("ui.focus", on ? "1" : "0"); } catch { /* 隐私模式忽略 */ }
    if (!inTauri) {
      if (announce) pushToast("info", on ? t("已进入专注模式（浏览器演示不切系统全屏）") : t("已退出专注模式"));
      return;
    }
    getCurrentWindow().setFullscreen(on)
      .then(() => {
        if (announce && on && !focusHintShownRef.current) {
          focusHintShownRef.current = true;
          pushToast("info", zenStripAutoRef.current
            ? t("专注模式：F11 退出 · 鼠标移到顶部唤出标签")
            : t("专注模式：F11 退出 · 标签条常驻（Ctrl+K 可切自动隐藏）"));
        }
      })
      .catch((e) => {
        setFocusMode(!on);
        try { localStorage.setItem("ui.focus", on ? "0" : "1"); } catch { /* 忽略 */ }
        pushToast("err", t("专注模式切换失败：{0}", errMsg(e).slice(0, 80)));
      });
  }, [pushToast]);

  // 启动恢复：chrome 态已由 useState 初值同步恢复；系统全屏在首帧后补投（invoke
  // 异步，可能闪一帧任务栏——与缩放首帧权衡同理）。恢复给一次性轻提示，用户重开
  // 窗口时不必回想「怎么退出去」。
  useEffect(() => {
    if (!inTauri) return;
    let on = false;
    try { on = localStorage.getItem("ui.focus") === "1"; } catch { /* 忽略 */ }
    if (!on) return;
    getCurrentWindow().setFullscreen(true)
      .then(() => pushToast("info", t("已恢复专注模式 · F11 退出")))
      .catch(() => {});
    // 仅首帧：focusMode 后续变化都走 applyFocus，此处不依赖它
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const refreshLists = useCallback(async () => {
    try {
      // UX 八轮：先取数后 setState——结构无变化时复用旧引用（sameShape），
      // 3s 轮询数据没变则整树与下游 effect 全部静默，不再每轮空转
      const nextSessions = applyTabOrder((await invoke("list_sessions")) as SessionInfo[]);
      const nextHosts = (await invoke("list_hosts")) as Host[];
      // R20：收藏/最近元数据（失败不阻断列表——空 meta 即全部视为未收藏）
      const nextMeta = await invoke("list_host_metadata").then((v) => v as HostMeta[]).catch(() => null);
      const nextRecents = await invoke("list_recent_hosts").then((v) => v as RecentHost[]).catch(() => null);
      const nextApprovals = ((await invoke("list_approvals", { pendingOnly: false })) as ApprovalItem[])
        .map((a): ApprovalRow => ({ ...a, status: normApprovalStatus(a.status) }));
      // ② 自主模式横幅数据（跟随 3s 轮询；到期由核心惰性清除，前端只显示剩余）
      const nextAutonomy = (await invoke("autonomy_list")) as AutonomyGrant[];
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
      setSessions((prev) => sameShape(prev, nextSessions));
      setHosts((prev) => sameShape(prev, nextHosts));
      if (nextMeta) setHostMeta((prev) => sameShape(prev, nextMeta));
      if (nextRecents) setRecents((prev) => sameShape(prev, nextRecents));
      setHostsLoaded(true); // §5.6：首载完成后 skeleton 才撤
      setApprovals((prev) => sameShape(prev, nextApprovals));
      setAutonomy(nextAutonomy);
    } catch {
      // 审核低-5：首载失败也必须撤骨架给出空态出口（否则永久骨架 + 未处理 rejection）；
      // 3s 轮询自愈，错误不逐条打扰（连接类失败另有常驻横幅）
      setHostsLoaded(true);
    }
  }, [pushToast]);

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
      setBlocksList(rows ?? []);
      setBlocksErr(null);
    } catch (e) {
      setBlocksErr(String((e as { message?: string })?.message ?? e));
    } finally {
      setBlocksBusy(false);
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
    addon.findPrevious(cmd, SEARCH_OPTS);
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

  // R41（§231/§269）：关闭设置即销毁前端敏感草稿——凭据库里没有半成品
  const closeSettings = useCallback(() => {
    setCredPem(""); setCredPass(""); setCredLabel("");
    setCredNewErr(null); setCredNewOk(null); setCredNewOpen(false); setCredDraftTo(null);
    setShowSettings(false);
  }, []);

  const refreshBrief = useCallback(async (s: string) => {
    try {
      const b = await invoke("session_brief", { sid: s });      if (sidRef.current !== s) return; // 审核H1：已切走会话的过期简报直接丢弃，防简报/任务目标跨会话串台
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
  // 次提交就带上正确草稿，窗口归零
  {
    const prevSid = prevSidRef.current;
    if (prevSid !== sid) {
      if (prevSid && goalDirty.current) goalDrafts.current.set(prevSid, goalDraft);
      const stashed = sid ? goalDrafts.current.get(sid) : undefined;
      if (stashed !== undefined) { goalDirty.current = true; setGoalDraft(stashed); }
      else { goalDirty.current = false; setGoalDraft(""); }
      prevSidRef.current = sid;
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
    invoke("bench_mode").then((b) => {
      if (b) runBench();
    });
  }, [refreshLists]);

  // 本地终端一等公民轮：启动即有一个可敲命令的本地终端（真实模式专属——demo 域
  // 豁免：55 个 spec 的初始态是「2 个演示会话+欢迎页」，自动开会全炸；真实链路
  // 由真机验证钉住）。仅一次；先内联读默认 shell（与上方 state 装载无序，读毕再连）。
  // SSH 恢复仍「点了才连」：恢复入口在欢迎页空态与 ⌘K 面板。
  const autoLocalRef = useRef(false);
  useEffect(() => {
    if (!inTauri || !hostsLoaded || autoLocalRef.current) return;
    autoLocalRef.current = true;
    const lh = hosts.find((h) => h.id === "local");
    if (!lh) return;
    void (async () => {
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
    // createSession 声明在后（TDZ：deps 数组渲染期求值不可引用）；effect 体运行时
    // 已初始化，闭包捕获安全。autoLocalRef 保证仅首装执行一次。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hostsLoaded, hosts]);

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
      const sp = splitRef.current;
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

  // 审批事件推送（仅 Tauri 环境；纯浏览器 demo 模式无事件通道）
  useEffect(() => {
    if (!inTauri) return;
    return tauriListen(listen("approval-event", () => refreshLists()));
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
    let cancelled = false;
    void document.fonts.ready.then(() => {
      if (cancelled) return;
      for (const [, e] of termsRef.current) {
        try {
          // 回写字体栈触发 handleFontChange：warmup 时刻字体未就绪的图集
          // （含几何绘制的框线/块元素）随之整体重建，再强制全量重绘。
          e.term.options.fontFamily = termFontFamilyRef.current;
          e.term.refresh(0, Math.max(0, e.term.rows - 1));
        } catch { /* 终端已释放 */ }
      }
    });
    return () => { cancelled = true; };
    // termsRef 是稳定 Map：只挂一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
      smoothScrollDuration: 100,
      fastScrollModifier: "alt", fastScrollSensitivity: 5,
      rescaleOverlappingGlyphs: true,
      // 字体轮目检（2026-10-23，Edge/WebView2 155 实测）：customGlyphs 的框线
      // 连排几何绘制在当前运行时缺格（`────` 连串只画部分格，JetBrains/Maple
      // 皆中招、HEAD 基线同样复现=环境级回归而非应用代码）。改走字体字形
      // （内置字体都带全量框线/块元素/powerline），格格有墨，横线略带字模侧距。
      customGlyphs: false,
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
    term.open(el);
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
    // 会话层底色跟随当前派生主题：padding 留白框与画布同色，不渗 chrome 面板色
    el.style.background = derivedThemeRef.current.bg;
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
    // 可点击路径（P2）：文件路径 + :line:col 识别为链接，点击复制原文——远端路径
    // 没法在本机打开，复制是最诚实有用的动作（本地会话同语义）；协议前缀让路给
    // 上一行的网页链接。toast 告知复制了什么。
    term.registerLinkProvider(pathLinkProvider(term, (text) => {
      (inTauri ? clipboard.writeText(text) : navigator.clipboard?.writeText(text))
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
      (inTauri ? clipboard.writeText(sel) : navigator.clipboard?.writeText(sel)).catch(() => {});
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
    // P2-c：OSC 52 策略。载荷格式 `选择区;base64`：`?` = 查询（读）一律拒绝（远端
    // 不得读本机剪贴板）；空载荷吞掉（不做「清空剪贴板」语义——同样是破坏面）；
    // 其余 base64 → UTF-8 解码后按策略 allow=直写、ask=询问卡、deny=静默吞（与主流
    // 终端一致）。handler 必须同步返回已消费；实际写入异步走（裁决后经 osc52WriteRef）。
    term.parser.registerOscHandler(52, (data) => {
      try {
        let b64 = data.slice(data.indexOf(";") + 1).replace(/\s+/g, "");
        if (!b64 || b64 === "?") return true;
        // 稳定轮：载荷上限 256KB——恶意远端推数 MB 序列曾全量解码并驻留 state
        //（ask 卡预览截 400 字符，但解码串与「允许」时的写入全文无界）
        if (b64.length > 256 * 1024) return true;
        b64 = b64.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (b64.length % 4)) % 4);
        const text = new TextDecoder().decode(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)));
        if (osc52PolicyRef.current === "allow") osc52WriteRef.current(sessionSid, text);
        else if (osc52PolicyRef.current === "ask") setOsc52Ask({ sid: sessionSid, text });
      } catch { /* 非法 base64：吞 */ }
      return true;
    });
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
          (inTauri ? clipboard.writeText(sel) : navigator.clipboard?.writeText(sel))
            .catch(() => {});
          ev.preventDefault();
          return false;
        }
        return true; // 无选中 → xterm 原生 copy 事件
      }
      if (key === "v") {
        // R25 §318：粘贴语义收口在 pasteTextInto（终端右键「粘贴」同源）
        (inTauri
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
      invoke("send_keys", { sid: sessionSid, keys: d }).catch((e) => {
        term.write(`\r\n\x1b[31m✕ ${errMsg(e)}\x1b[0m\r\n`);
      });
      // 广播扇出（P2-a）：主发之后复制到勾选会话（目标逐会话过离线闸，见 broadcastSendRef）
      if (!bcastSuppressRef.current) broadcastSendRef.current(sessionSid, d);
    });
    return { term, el, search: searchAddon, tag, feed: null as OutputFeed | null, webgl, liga };
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
          broadcastSendRef.current(s0, seq);
          return;
        }
        if (!ev.ctrlKey || ev.metaKey || ev.altKey) return;
        // 键位表豁免（键位配置轮）：组合被 ui.keymap.v1 占用即豁免——不再编码 C0
        // 直发 PTY，动作层（同节点后注册的监听器，stopPropagation 挡不住=正是目的）
        // 接手。bindingOf 以平台主修饰键判定：mac 真按 Ctrl 不豁免（⌘ 系才归应用），
        // Win/Linux Ctrl 命中即豁免；shift/alt 逐位精确比对，未绑定的 Ctrl+Shift+字
        // 母仍进 shell。ev.key 为主、ev.code 兜底（注入器/RDP 的 keydown 可能缺
        // scan code——直键三键轮实证过 code 空串打穿纯 code 匹配）。demo 不豁免：
        // Ctrl+D 保留 shell EOF，Ctrl+T/W 是浏览器保留键本就到不了这里。
        if (inTauri) {
          const evb = bindingOf(ev, isMacPlatform());
          if (evb && Object.values(keymapRef.current).some((b) => sameBinding(b, evb))) {
            ev.preventDefault();
            ev.stopPropagation();
            return;
          }
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
      };
      window.addEventListener("keydown", onKey, { capture: true });
      return () => window.removeEventListener("keydown", onKey, { capture: true });
    }, []);

    // 终端聚焦状态上报 native 层：native Ctrl 键接管只在 xterm 聚焦时生效，
    // 搜索框等输入控件不受影响。
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
    return () => { if (timer) clearTimeout(timer); ro.disconnect(); };
  }, [fitTerminal]);
  // 分屏建立/退出/换副窗格时也重估宽度退化态
  useEffect(() => { checkSplitWidthRef.current(); }, [splitPanes]);

  // —— 显示设置（路线图⑥）：字号/主题，vault 持久化（跨进程记忆）——
  // 状态供 UI 渲染；ref 供 makeTerm 闭包与快捷键读取（避开 stale closure）
  const [fontSize, setFontSize] = useState(FONT_DEFAULT);
  const [showSettings, setShowSettings] = useState(false);
  // T34：原生菜单「设置…⌘,」→ 打开显示设置面板；应用版本号（关于面板同源）
  const [appVersion, setAppVersion] = useState<string | null>(null);
  // 版本号轮：编译时间（build.rs 注入的编译期常量；演示域 demo 镜像回 null，
  // 关于卡略去「编译于」段）
  const [buildTime, setBuildTime] = useState<string | null>(null);
  // 发布轮：应用内版本检查（启动静默查一次 GitHub Release；有新版才 toast，
  // 关于卡常驻更新行）。任何失败折算 hasUpdate=false，静默不扰。
  const [updateInfo, setUpdateInfo] = useState<UpdateCheck | null>(null);
  // updater 轮：自动更新能力面（demo 域恒 null → 关于卡不出现按钮）与安装 busy
  const [updaterCap, setUpdaterCap] = useState<UpdaterInfo | null>(null);
  const [updaterBusy, setUpdaterBusy] = useState(false);
  const autoUpdate = useCallback(() => {
    if (updaterBusy) return;
    setUpdaterBusy(true);
    // 成功路径：安装完成 app.restart()，不返回；Ok(false)=已是最新
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
    getVersion().then(setAppVersion).catch(() => {});
    invoke("get_build_time").then((t) => setBuildTime(t ?? null)).catch(() => {});
    // updater 轮：能力面（supported 只在 macOS+真公钥构建为 true）
    invoke("updater_info").then(setUpdaterCap).catch(() => {});
    // 发布轮：启动静默查一次更新；有新版才 toast（demo 域镜像恒 hasUpdate=false）
    invoke("check_update").then((u) => {
      setUpdateInfo(u);
      if (u.hasUpdate && u.latest) {
        pushToast("info", t("新版本 v{0} 已发布", u.latest), {
          label: t("打开发布页"), title: u.url ?? "",
          run: () => { if (u.url) invoke("open_url", { url: u.url }).catch(() => {}); },
        });
      }
    }).catch(() => {});
    return un;
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
  // 二十二轮主题统一：终端配色恒由「色板×深浅」派生（无独立预设、无联动开关）。
  // derivedThemeRef 缓存最近一次派生结果，makeTerm 建实例时直接取用（早于启动
  // 派生到达时是深色基础派生值，启动尾部统一刷新一次）
  const derivedThemeRef = useRef<{ bg: string; theme: Record<string, string> }>({
    bg: THEMES[0].bg,
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
  const [keymap, setKeymap] = useState<Record<KeyActionId, Binding>>(() => parseKeymap(null));
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
    // 外观同步（Overlay 红绿灯深浅渲染）
    document.documentElement.dataset.chrome = resolved;
    if (inTauri) {
      void getCurrentWindow().setTheme(resolved === "dark" ? "dark" : "light").catch(() => {});
    }
  }, [inTauri]);

  const applyPalette = useCallback((id: string) => {
    document.documentElement.dataset.theme = id;
  }, []);

  // 主题切换脉冲（tiny-worker 同工艺）：仅切换瞬间挂 .theme-switching 开全量色彩
  // 过渡（styles.css），320ms 摘除——常驻全局 transition 会拖累一切交互
  const pulseChrome = useCallback(() => {
    const el = document.documentElement;
    el.classList.add("theme-switching");
    window.setTimeout(() => el.classList.remove("theme-switching"), 320);
  }, []);

  const persistSetting = useCallback((key: string, value: string) => {
    if (inTauri) void invoke("set_setting", { key, value }).catch(() => {});
    else try { localStorage.setItem(key, value); } catch { /* demo 模式尽力而为 */ }
  }, [inTauri]);

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
  // 连字开关（P0 轮）：真开/真关渲染器——开 = 释放 WebGL 换 DOM 渲染器（character
  // joiner 仅 DOM 实现）再载 LigaturesAddon；关 = 卸 addon、重挂 WebGL（失败回落 DOM）。
  // 逐实例热切换，不重建缓冲（滚动历史与在跑程序原地保留）；新建实例由 makeTerm 继承。
  const applyLigatures = useCallback((on: boolean) => {
    for (const [key, e] of termsRef.current) {
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
      bg: resolveTokenColor("--bg"),
      theme: {
        ...base.theme,
        ...ansi,
        background: resolveTokenColor("--bg"),
        foreground: resolveTokenColor("--text"),
        cursor: resolveTokenColor("--accent"),
        cursorAccent: resolveTokenColor("--bg"),
        selectionBackground: resolveTokenColor("--accent-ring"),
      },
    };
  }, []);
  const applyDerivedTerminal = useCallback(() => {
    const { bg, theme } = deriveTerminalTheme(document.documentElement.dataset.chrome === "light" ? "light" : "dark");
    derivedThemeRef.current = { bg, theme: { ...theme } };
    for (const [, e] of termsRef.current) {
      e.term.options.theme = { ...theme };
      e.el.style.background = bg;
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
      .catch(() => {});
  }, [applyAppearance, pulseChrome]);

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
      const raw = Number(localStorage.getItem(SETTING_FONT) ?? localStorage.getItem(SETTING_FONT_LEGACY));
      applyFont(Number.isFinite(raw) && raw > 0 ? raw : null);
      loadPalette(localStorage.getItem(SETTING_PALETTE));
      // 键位表（键位配置轮）：demo 走 localStorage，坏串/缺省回落默认表
      const kmRaw = localStorage.getItem(KEYMAP_SETTING);
      if (kmRaw) applyKeymap(parseKeymap(kmRaw));
      // ⑤ 传输免审 opt-in：demo 与 persistSetting 同走 localStorage
      setTransferAutonomy(localStorage.getItem("collab.autonomy.transfers") === "1");
      // ⑦ 记录保留期：demo 同走 localStorage（坏值回落 30 天）
      const rr = Number(localStorage.getItem("collab.records.retention_days") ?? "30");
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
    const localeP = invoke("get_setting", { key: SETTING_LOCALE })
      .then((v) => {
        if (v === "en" || v === "zh") {
          if (localeNow() !== v) { setLocale(v); setLocaleState(v); }
        }
      })
      .catch(() => {});
    const keymapP = invoke("get_setting", { key: KEYMAP_SETTING })
      .then((v) => { if (typeof v === "string" && v) applyKeymap(parseKeymap(v)); })
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
  }, [inTauri, changeFontSize, applyAppearance, applyPalette, applyDerivedTerminal, applyKeymap, applyTermPrefs, applyLigatures]);

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
      .catch(() => {});
  }, []);
  const changePasteGuard = useCallback((pg: boolean) => {
    setPasteGuard(pg);
    pasteGuardRef.current = pg;
    writeTerminalPrefs({ paste_guard: pg });
  }, [writeTerminalPrefs]);
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

  // —— 十五轮：重连上次会话 ——
  // blob sessions.last 记「当前打开会话的主机清单」（去重有序）。只有本运行用户
  // 主动建连成功（createSession Ready → armed）才允许写：启动装载/demo 预置会话
  // 不武装也不写（否则下次启动瞬间就用预置清单覆盖上次运行的记忆）。武装后随
  // 会话集合变化跟随写（含全关=空集）。
  const [lastSessionHosts, setLastSessionHosts] = useState<string[]>([]);
  const lastTrackArmedRef = useRef(false);
  useEffect(() => {
    if (!lastTrackArmedRef.current) return;
    const ids = [...new Set(sessions.map((s) => s.host_id))];
    wsWriteChain.current = wsWriteChain.current
      .then(() => invoke("get_workspace"))
      .then((ws) => invoke("set_workspace", { ws: { ...ws, sessions: { last: ids } } }))
      .catch(() => {});
  }, [sessions]);
  // 欢迎页可见时读清单（回欢迎页也重读——与 armed 写入一致；主机已删的行由渲染侧过滤）
  useEffect(() => {
    if (sessions.length > 0) return;
    let dead = false;
    invoke("get_workspace")
      .then((ws) => { if (!dead) setLastSessionHosts(((ws?.sessions as { last?: string[] } | null)?.last ?? []) as string[]); })
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
  const toggleHostbar = useCallback((open: boolean) => {
    setHostbarOpen(open);
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
  // 面板需求与实际面板宽一致（files=384，rev-r12 M1：此前按 320 算断点但面板钉死 384，
  // 终端实测可被压到 504 < 规范下限 560）；16px 回差双阈值防临界抖动。
  const panelNeed = rightPanel === "collab" || rightPanel === "forwards" || rightPanel === "log" || rightPanel === "blocks" ? 400 : 384;
  // 活动栏轮：availW 扣当前打开的左栏视图（主机栏或 Agent 视图，互斥不同时开）。
  // 大屏轮：监控改主区覆盖层（不挤占终端宽度），不再参与 availW 计算
  const availW = winW - (hostbarOpen ? hostbarWidth : agentOpen || fleetOpen ? agentWidth : 0);
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
  // §7.4：关闭工具后恢复到其触发前的有效焦点——工具均从终端场景触发，恢复即
  // 聚焦活动终端（focusin 链会自动恢复 native Ctrl 上报）。
  const restoreTermFocus = () => {
    const sid = sidRef.current;
    if (!sid) return;
    termsRef.current.get(sid)?.term.focus();
  };
  const closeTopOverlayRef = useRef<() => boolean>(() => false);
  closeTopOverlayRef.current = (): boolean => {
    if (quitSummary) { void cancelQuit(); return true; }
    if (delegateDlg) { closeDelegate(); return true; }
    const ap = authPromptQueue[0];
    if (ap) { void answerAuthPrompt(ap.id, ""); return true; }
    const hk = hostKeyQueue[0];
    if (hk) { void decideHostKey(hk, false); return true; }
    if (confirm) { setConfirm(null); return true; }
    if (pasteConfirm) { setPasteConfirm(null); return true; }
    // P2-c：OSC 52 询问卡同属模态链——Esc 即拒绝（关卡不写剪贴板）
    if (osc52Ask) { setOsc52Ask(null); return true; }
    // 拖拽上传确认卡同样是模态（全屏遮罩+焦点陷阱）——Esc 链此前漏出（审计 F5）
    if (pendingDrop) { setPendingDrop(null); return true; }
    if (paletteOpen) { setPaletteOpen(false); return true; } // 十九轮：命令面板在浮层链内
    if (detail || detailErr) { closeDetail(); return true; }
    if (tabMenu) { setTabMenu(null); return true; }
    if (hostMenu) { setHostMenu(null); return true; }
    if (termMenu) { setTermMenu(null); return true; }
    if (recentMenu) { setRecentMenu(null); return true; }
    if (splitMenu) { setSplitMenu(false); return true; }
    if (searchOpen) { closeSearch(); return true; }
    if (showSettings) { closeSettings(); return true; }
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
      case "zoom-in": zoomIn(); return true;
      case "zoom-out": zoomOut(); return true;
      case "zoom-reset": zoomReset(); return true;
      case "hostbar": toggleHostbar(!hostbarOpenRef.current); return true;
      case "palette":
        // ⌘K 命令面板（十九轮）：模态层不叠开（同 settings 门）；resolveAction
        // 已按模态门吞键，此处门是菜单加速器等不经解析器的入口的对齐
        if (modalRef.current) return false;
        setPaletteOpen(true);
        return true;
      case "settings":
        // 菜单加速器不经 resolveAction 的模态门（NSMenu 在 WebView 之前消费），
        // 这里补同一条 §7.3 规则：模态层打开时不叠开面板
        if (modalRef.current) return false;
        setShowSettings(true);
        return true;
      case "tab-switch": {
        const t = sessionsRef.current[a.index];
        if (t) void attachSession(t.id).catch((e) => pushToast("err", errMsg(e)));
        return !!t;
      }
      case "tab-cycle": {
        const ss = sessionsRef.current;
        if (!ss.length) return false;
        const i0 = Math.max(0, ss.findIndex((x) => x.id === sidRef.current));
        const target = ss[(i0 + a.dir + ss.length) % ss.length];
        if (target) void attachSession(target.id).catch((e) => pushToast("err", errMsg(e)));
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
      if (dispatchRef.current(a)) {
        ev.preventDefault();
        ev.stopPropagation();
      }
    };
    window.addEventListener("keydown", onKey, { capture: true });
    return () => window.removeEventListener("keydown", onKey, { capture: true });
  }, []);

  // 由 splitRef/sidRef 统一同步各终端层的显示类（display 归它管，React 不渲染这些层）：
  // 单 pane：活动会话 .active；分屏：主格=左半/上半（dir），副格=另一半，焦点 pane 加
  // 高亮与名牌。§185 退化态：只呈现焦点窗格全幅（另一个仍在标签中），类同单 pane
  const applyPanes = useCallback(() => {
    const sp = splitRef.current;
    const degraded = !!sp && splitDegradedRef.current;
    const clsMain = sp?.dir === "tb" ? "pane-top" : "pane-left";
    const clsSecond = sp?.dir === "tb" ? "pane-bottom" : "pane-right";
    for (const [s, e] of termsRef.current) {
      e.el.classList.remove("active", "pane-left", "pane-right", "pane-top", "pane-bottom", "pane-focused");
      if (sp && !degraded) {
        if (s === sp.main || s === sp.second) {
          e.el.classList.add(s === sp.main ? clsMain : clsSecond);
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

  // §185 宽度退化（分屏⑥轮起按方向取度量）：左右双格各 <360 宽、上下双格各 <190 高
  // 即退化单窗格（恢复带 6px 迟滞防阈值抖动；竖排底限更宽松——行少尚可滚动，
  // 列太窄必折行）
  const checkSplitWidth = useCallback(() => {
    const el = termRef.current;
    if (!el) return;
    const sp = splitRef.current;
    const tb = sp?.dir === "tb";
    const m = tb ? el.clientHeight : el.clientWidth;
    const below = tb ? SPLIT_DEGRADE_BELOW_H : SPLIT_DEGRADE_BELOW;
    const recover = tb ? SPLIT_RECOVER_AT_H : SPLIT_RECOVER_AT;
    const next = !!sp && (splitDegradedRef.current ? m < recover : m < below);
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

  // 分割条拖拽（分屏⑥轮，补齐 Windows Terminal/iTerm2/tmux 的基本习惯）：主格占比
  // 0.2~0.8 夹取（任一侧都不小于可读下限），pointer capture 全程跟手；拖动中每 150ms
  // 校准一次 PTY 几何，松手再校准终态。双击复位对半。占比存内存（会话本就不跨重启）
  const splitDragRef = useRef<{ dir: SplitDir; startFrac: number; startPt: number; total: number; lastFit: number } | null>(null);
  const onDivDown = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    const mount = termRef.current;
    const sp = splitRef.current;
    if (!mount || !sp) return;
    const r = mount.getBoundingClientRect();
    e.currentTarget.setPointerCapture(e.pointerId);
    splitDragRef.current = {
      dir: sp.dir,
      startFrac: splitFracRef.current,
      startPt: sp.dir === "tb" ? e.clientY : e.clientX,
      total: sp.dir === "tb" ? r.height : r.width,
      lastFit: 0,
    };
    document.body.classList.add("split-dragging", sp.dir === "tb" ? "split-drag-tb" : "split-drag-lr");
  }, []);
  const onDivMove = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    const dg = splitDragRef.current;
    if (!dg) return;
    const pt = dg.dir === "tb" ? e.clientY : e.clientX;
    const frac = Math.min(SPLIT_FRAC_MAX, Math.max(SPLIT_FRAC_MIN, dg.startFrac + (pt - dg.startPt) / dg.total));
    if (frac !== splitFracRef.current) {
      splitFracRef.current = frac;
      applySplitFrac();
    }
    const now = performance.now();
    if (now - dg.lastFit > 150) { dg.lastFit = now; fitTerminal(); }
  }, [applySplitFrac, fitTerminal]);
  const onDivUp = useCallback(() => {
    if (!splitDragRef.current) return;
    splitDragRef.current = null;
    document.body.classList.remove("split-dragging", "split-drag-lr", "split-drag-tb");
    fitTerminal();
  }, [fitTerminal]);
  const resetSplitFrac = useCallback(() => {
    splitFracRef.current = 0.5;
    applySplitFrac();
    fitTerminal();
  }, [applySplitFrac, fitTerminal]);

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
  }, [makeTerm, fitDimsOf]);

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
        ? { ...sp, second: newSid }
        : { ...sp, main: newSid };
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
      e.el.classList.remove("active", "pane-left", "pane-right", "pane-top", "pane-bottom", "pane-focused");
    }
  }, []);

  // 进入/调整分屏（T19；分屏⑥轮起方向可选+可旋转）：把 target 放到副 pane（主 pane
  // 与焦点不动）。dir 缺省沿用记住的上次方向（splitDirRef）。已分屏时的语义：
  // 换向 = 旋转布局（tmux/Windows Terminal 习惯）；屏外 target = 替换副 pane；
  // 换向 + 屏外 target = 两者同时发生（「放到下侧」的直觉：新会话进下格）。
  // 占比不重置——退出再进、旋转都沿用上次拖出的比例。
  const enterSplitWith = useCallback(async (target: string, dir?: SplitDir) => {
    const d = dir ?? splitDirRef.current;
    splitDirRef.current = d;
    setSplitDir(d);
    const sp = splitRef.current;
    if (sp) {
      const second = target === sp.main || target === sp.second ? sp.second : target;
      if (d === sp.dir && second === sp.second) return; // 同向且副格不变：无操作
      splitRef.current = { main: sp.main, second, dir: d };
    } else {
      if (!sidRef.current || target === sidRef.current) return;
      splitRef.current = { main: sidRef.current, second: target, dir: d };
    }
    setSplitPanes(splitRef.current);
    await ensureSessionTerm(target);
    applySplitFrac();
    applyPanes();
    fitTerminal();
    checkSplitWidthRef.current();
    setTimeout(() => void fitTerminal(), 150);
    // 工具栏点击会把焦点留在按钮上——把焦点送回终端，打字不中断
    if (sidRef.current) focusSession(sidRef.current);
  }, [ensureSessionTerm, applySplitFrac, applyPanes, fitTerminal, focusSession]);

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

  // 拖拽组合分屏（标签拖到终端区松手）：把 target 放到指定槽位（main=左/上，
  // second=右/下）。与 enterSplitWith 的差别：主格槽允许「被拖者当主格」（原焦点
  // 退副格），且落点格拿焦点——拖放是指向动作，焦点跟手。已分屏时落到另一格=
  // 替换（被拖者本在屏内即交换两格），落到自己格由调用方无操作。dir 仅建屏时生效。
  const placeInSplit = useCallback(async (target: string, slot: "main" | "second", dir?: SplitDir) => {
    const sp = splitRef.current;
    if (!sp) {
      const focus = sidRef.current;
      if (!focus || focus === target) return; // 单会话无可组合对象
      const d = dir ?? splitDirRef.current;
      splitDirRef.current = d;
      setSplitDir(d);
      splitRef.current = slot === "main" ? { main: target, second: focus, dir: d } : { main: focus, second: target, dir: d };
    } else if (target === sp.main || target === sp.second) {
      if ((slot === "main") === (target === sp.main)) return; // 落到自己所在格
      splitRef.current = { ...sp, main: sp.second, second: sp.main }; // 交换两格
    } else {
      splitRef.current = slot === "main" ? { ...sp, main: target } : { ...sp, second: target };
    }
    setSplitPanes(splitRef.current);
    focusGenRef.current++; // 拖放同属用户导航（rev-r21 M1 焦点代际）
    await ensureSessionTerm(target);
    applySplitFrac();
    applyPanes();
    fitTerminal();
    checkSplitWidthRef.current();
    setTimeout(() => void fitTerminal(), 150);
    focusSession(target);
  }, [ensureSessionTerm, applySplitFrac, applyPanes, fitTerminal, focusSession]);

  // 拖拽组合分屏：指针命中的分屏格（已分屏时提示与落格都按真实窗格几何，不做死象限）。
  // 两格矩形贴合处（分割条覆盖的缝）按主格优先；未分屏时调用方不会走到
  const paneAtPoint = (x: number, y: number): "main" | "second" => {
    const sp = splitRef.current;
    if (sp && termRef.current) {
      for (const slot of ["main", "second"] as const) {
        const el = termRef.current.querySelector(sp.dir === "tb"
          ? (slot === "main" ? ".pane-top" : ".pane-bottom")
          : (slot === "main" ? ".pane-left" : ".pane-right"));
        const r = el?.getBoundingClientRect();
        if (r && x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return slot;
      }
    }
    return "main";
  };

  // 标签拖拽命中：指针下的目标标签（纵向 band 判定在调用方）；横向 ±3px 容差吃药丸缝隙
  const tabAtPoint = (x: number, y: number): { sid: string; before: boolean } | null => {
    for (const el of document.querySelectorAll(".tab")) {
      const r = el.getBoundingClientRect();
      if (y < r.top || y > r.bottom || x < r.left - 3 || x > r.right + 3) continue;
      const hitSid = (el as HTMLElement).dataset.sid;
      if (!hitSid) continue;
      return { sid: hitSid, before: x < r.left + r.width / 2 };
    }
    return null;
  };

  // 拖拽松手裁决：标签条药丸上=重排；终端区=组合分屏（未分屏按主轴象限定槽位与方向，
  // 已分屏按命中格）；标签条空白处=退出分屏（两会话保留）。都不满足=无操作
  const finishTabDrag = (from: string, x: number, y: number) => {
    const bar = tabbarRef.current?.getBoundingClientRect();
    const inStrip = !!bar && x >= bar.left && x <= bar.right && y >= bar.top && y <= bar.bottom;
    const tr = termRef.current?.getBoundingClientRect();
    const inTerm = !!tr && x >= tr.left && x <= tr.right && y >= tr.top && y <= tr.bottom;
    const hit = inStrip ? tabAtPoint(x, y) : null;
    if (hit && hit.sid !== from) {
      reorderTabs(from, hit.sid, hit.before);
    } else if (inTerm && sessionsRef.current.length >= 2 && tr) {
      const sp = splitRef.current;
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
    } else if (inStrip && !hit && splitRef.current) {
      exitSplit();
    }
  };

  // 关闭会话（标签 ×/⌘W/工具菜单共用，§6.4 统一「关闭会话」语义）：核心确认关闭
  // 后才 dispose；失败保留标签、画面与重试入口（§337）
  const disconnectSid = useCallback(async (id: string) => {
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
      dead.push(id);
    }
    if (!dead.length) return;
    const sp = splitRef.current;
    if (sp && (dead.includes(sp.main) || dead.includes(sp.second))) {
      const survivor = dead.includes(sp.main) ? sp.second : sp.main;
      splitRef.current = null;
      setSplitPanes(null);
      const next = termsRef.current.get(survivor);
      if (next && (sidRef.current === null || dead.includes(sidRef.current))) {
        setSid(survivor);
        sidRef.current = survivor;
        xtermRef.current = next.term;
        refreshBrief(survivor);
        void invoke("note_terminal", { sid: survivor, focused: true }).catch(() => {});
      }
    } else if (sidRef.current && dead.includes(sidRef.current)) {
      const next = sessionsRef.current.find((s) => !dead.includes(s.id) && termsRef.current.has(s.id));
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
  }, [sessions, sessionIdent, detach, applyPanes, fitTerminal, refreshBrief]);

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
  const confirmQuit = async () => {
    if (!quitSummary) return;
    // 会话收口已下沉 quit_app（shutdown_all：close_session 同口径 + 卡住强制
    // 摘表的超时预算）——FE 逐个 close 曾可能被悬挂会话卡死在退出前一步。
    try { await invoke("quit_app"); } catch { /* demo 无此命令 */ }
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
  const modal = !!(paletteOpen || authPromptQueue.length > 0 || hostKeyQueue.length > 0 || confirm || quitSummary || pasteConfirm || osc52Ask || splitMenu || tabMenu || hostMenu || termMenu || recentMenu || pendingDrop || keyCapture
    || showAddHost || showQuickConnect || showSettings);
  modalRef.current = modal;

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
      const clash = conflictOf(keymapRef.current, keyCapture, evb);
      if (clash) {
        pushToast("err", t("与「{0}」冲突，先给后者换键", KEYMAP_ACTIONS.find((a) => a.id === clash)?.label ?? clash));
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
      setConnError({ title: t("删除主机失败"), detail: friendlyError(e) });
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
    || toolsOpen || tabsMenuOpen || rightPanel !== null || !!confirm || !!pendingDrop;
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
      if (sidRef.current === s && sftpGenRef.current === gen) setSftpErr(friendlyError(e));
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
      if (sidRef.current === s && sftpGenRef.current === genAtStart) setSftpErr(friendlyError(e));
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
    sftpMenuRef.current?.querySelector("button")?.focus();
    const onDown = (e: MouseEvent) => { if (!sftpMenuRef.current?.contains(e.target as Node)) setSftpMenu(null); };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setSftpMenu(null); };
    window.addEventListener("mousedown", onDown, true);
    window.addEventListener("keydown", onKey);
    return () => { window.removeEventListener("mousedown", onDown, true); window.removeEventListener("keydown", onKey); };
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
    if (!s) { void startUploads(paths, undefined); return; } // 无会话保留既有失败卡语义
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
  }, [startUploads]);

  // 拖拽事件（Tauri drag-drop，浏览器演示模式无此通道）：enter/over 显示覆盖层，drop 分区
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
      const a = await (draft
        ? invoke("begin_connection_draft", { draft, opts: {} })
        : invoke("begin_connection", { hostId: host.id, opts })) as AttemptInfo;
      if (draft && a.host_id) host = { ...host, id: a.host_id };
      attemptId = a.attempt_id;
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
      } else if (final.phase === "Cancelled") {
        pushToast("info", t("已取消连接 {0}", host.name));
      } else if (final.phase === "CancelCloseFailed") {
        // 取消时已 Ready 且关闭失败：会话真实存在（无隐藏连接），如实告之从标签关闭
        await refreshLists();
        setConnError({
          title: t("取消 {0} 时会话已建立且关闭失败", host.name),
          detail: t("会话保留在标签栏——不再需要时请从标签 × 或 ⌘W 关闭"),
        });
      } else {
        // Failed：失败走 conn-error 常驻横幅（可行动文案），标签不建（attempt 未过门）
        setLastFailed(host.id);
        const reason = final.error ? friendlyError({ kind: final.error.kind, message: final.error.message }) : t("未知原因");
        setConnError({
          title: t("连接 {0}（{1}@{2}:{3}）失败", host.name, host.username, host.address, host.port),
          detail: reason + t("——也可在主机卡上看到失败提示，修正后重试"),
        });
      }
    } catch (e) {
      setLastFailed(host.id);
      setConnError({
        title: t("连接 {0}（{1}@{2}:{3}）失败", host.name, host.username, host.address, host.port),
        detail: friendlyError(e) + t("——也可在主机卡上看到失败提示，修正后重试"),
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

  // —— P3 会话现场恢复：欢迎页一键入口。逐条目走既有建连全流程（TOFU/双因素
  // 原样把关，点了才连），新会话 term 挂载后先写恢复公告行、再 applyCheckpoint
  // 重放快照（历史进滚回、可视区/光标/模式复位）。主机已删或 20s 内未见新会话
  // 如实跳过并 toast；恢复完成后清空数据源（现场已被消费，陈旧快照不复活）。
  const restoreScenes = async (entries: RestoreEntry[]) => {
    if (restoringRef.current) return;
    restoringRef.current = true;
    let restored = 0;
    const skipped: string[] = [];
    try {
      for (const e of entries) {
        const host = hosts.find((x) => x.id === e.host_id);
        if (!host) { skipped.push(e.host_id); continue; }
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
        if (!sid) { skipped.push(host.name); continue; }
        const entry = termsRef.current.get(sid);
        if (!entry) { skipped.push(host.name); continue; }
        let when = e.saved_at;
        try { when = new Date(e.saved_at).toLocaleString("zh-CN"); } catch { /* 原样 */ }
        // 先重放再公告：applyCheckpoint 会重置缓冲（尺寸对齐+清屏），先写会被擦掉
        applyCheckpoint(entry.term, e.checkpoint);
        entry.term.write(`\r\n\x1b[2m—— ${t("已恢复上次会话现场（快照 {0}）", when)}——\x1b[0m\r\n`);
        restored++;
      }
    } finally {
      restoringRef.current = false;
    }
    if (restored > 0) pushToast("ok", t("已恢复 {0} 个会话现场", restored));
    if (skipped.length > 0) pushToast("err", t("{0} 个现场未恢复（主机已删或连接未就绪）：{1}", skipped.length, skipped.join("、")));
    if (restored > 0) setRestoreEntries([]);
  };
  const restoringRef = useRef(false);

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
        pushToast("info", t("取消时连接已完成——该会话已随之关闭"));
      } else if (r.outcome === "cancel_close_failed") {
        // 会话保留（关闭失败=恢复入口）：如实告之从标签关闭
        await refreshLists();
        setConnError({
          title: t("取消时会话已建立且关闭失败"),
          detail: t("会话保留在标签栏——不再需要时请从标签 × 或 ⌘W 再次关闭"),
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
      pushToast("info", t("已停止 {0} 的自动重连", s.host_name));
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
      setReconnecting(null);
    }
  };

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
      if (s.tmux) continue; // 核心已带清单（重连保留语义）
      invoke("tmux_probe", { sid: s.id })
        .then((st: TmuxStatus) => {
          setSessions((cur) => applyTabOrder(cur.map((x) => (x.id === s.id ? { ...x, tmux: st } : x))));
        })
        .catch(() => { /* 保持无清单态，横幅按无 tmux 呈现 */ });
    }
  }, [sessions]);

  const takeover = async () => {
    if (!sid) return;
    try {
      await invoke("set_control", { sid, owner: "Human", stopRunning: false });
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
  const decide = async (id: string, decision: "approve" | "deny" | "edit", edited: string | null) => {
    // 并发作废（接管/关会话）会拒绝决定（审计 F3）：无 catch 时 unhandled
    // rejection + 编辑态卡死到下次轮询。失败如实上报、编辑态保留（卡片随轮询刷新）
    try {
      await invoke("decide_approval", { id, decision, edited });
    } catch (err) {
      pushToast("err", errMsg(err));
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
    if (s) setOwner(s.control_owner);
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
  const ownerCls = owner === "Human" ? "human" : hasAgents ? "agent" : "dim";
  const pendingApprovals = approvals.filter((a) => a.status === "pending");
  const pendingCount = pendingApprovals.length;
  // 已处理的审批不再整卡展示，折叠为最近几条一行记录
  const resolvedApprovals = approvals.filter((a) => a.status !== "pending").slice(-3).reverse();
  // R42（§3.2/§6.7）：协作入口的两种触发——「有协作配置」常显入口；
  // 「有实际待审批或 Agent 控制活动」必须显示提醒（不因面板开关/入口偏好而隐藏）。
  // C9（R43）：停用后不再显示协作入口——重新启用走「设置 → Agent 接入」。
  const collabConfigured = collabEnabled && mcp.agents.length > 0;
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
        items.push({
          id: "reconnect-last", group: t("连接"), title: t("重连上次会话（{0}）", rowsH.length),
          hint: rowsH.map((h) => h.name).join("、"), keywords: "重连 上次 会话 reconnect",
          run: () => { for (const h of rowsH) void createSession(h); },
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
      // tmux 联动：当前主机有 tmux 会话清单时给按需切换入口——会话管理器的最终
      // 形态不是面板，是命令面板里几行按需出现的条目；无 tmux 时一个字都不多。
      const atmux = active.kind === "ssh" ? active.tmux : null;
      if (atmux?.available && atmux.sessions.length > 0
        && (active.state === "Connected" || active.state === "Reconfirming")) {
        for (const ms of atmux.sessions) {
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
        id: "term-search", group: t("当前会话"), title: t("搜索终端内容"), hint: "⌘F",
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
        id: "panel-broadcast", group: "当前会话",
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
          id: "delegate", group: "当前会话",
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
      title: hostbarOpen ? t("隐藏主机栏") : t("显示主机栏"), hint: "⌘B",
      run: () => toggleHostbar(!hostbarOpen),
    });
    items.push({
      id: "toggle-agent", group: t("应用"),
      title: agentOpen ? t("关闭 Agent 对话") : t("打开 Agent 对话（演练）"),
      hint: "活动栏", keywords: "agent ai 助手 对话 演练 内置",
      run: () => toggleAgent(!agentOpen),
    });
    items.push({
      id: "toggle-fleet", group: t("应用"),
      title: fleetOpen ? t("关闭跨主机编排") : t("打开跨主机编排（Fleet）"),
      hint: "活动栏", keywords: "fleet 编排 跨主机 批量 多机 派发",
      run: () => toggleFleet(!fleetOpen),
    });
    items.push({
      id: "toggle-monitor", group: t("应用"),
      title: monitorOpen ? t("关闭资源监控大屏") : t("打开资源监控大屏（多服务器 + Ascend NPU）"),
      hint: "活动栏", keywords: "监控 资源 cpu 内存 网络 npu ascend 仪表 监视 面板",
      run: () => toggleMonitor(!monitorOpen),
    });
    items.push({
      id: "toggle-focus", group: t("应用"),
      title: focusMode ? t("退出专注模式") : t("进入专注模式（界面全让位给终端）"),
      hint: "F11", keywords: "全屏 zen focus 专注 沉浸 极简",
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
  const zenPin = sessions.length === 0 || searchOpen || !!renaming || tabsMenuOpen || !!tabMenu || !!splitMenu || !!connError
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
    <div className={"app-shell" + (focusMode ? " focus-mode" : "") + (focusMode && zenStripAuto ? " zen-auto" : "")}>
      {/* 标题区 44（§4.2）：整行拖拽区；红绿灯安全区由 .native-chrome 留白；可交互控件不在拖拽链上 */}
      <header className="titlebar" data-tauri-drag-region>
        <div className="tb-left">
          <span className="app-title" data-tauri-drag-region>TinySSH</span>
          {/* 版本号轮：常驻版本标签（0.10.0 起挪到应用名右边，紧贴名称更直观；
              关于卡另有编译时间，悬停提示指引） */}
          <span className="ver-tag" data-tauri-drag-region
            title={`TinySSH v${appVersion ?? APP_VERSION}——编译时间见 设置 → 关于`}>
            v{appVersion ?? APP_VERSION}
          </span>
          {/* 自身开销读数（监控条「本机」段迁此）：标题栏常显不依赖会话；纯读数留在拖拽链上 */}
          <SelfMeterTitlebar />
          {hostbarOpen && (
            <button className="ghost icon-btn" title={t("收起主机栏（⌘B）")} aria-label={t("收起主机栏")}
              onClick={() => toggleHostbar(false)}>
              <IconChevronLeft size={15} />
            </button>
          )}
          {(collabConfigured || collabActive) && (
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
            ><span className="ctl-dot" />{owner === "Human" ? t("我控制中") : hasAgents ? t("Agent 控制中") : t("手动控制")}</span>
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
          <button className={"rail-btn" + (hostbarOpen ? " ts-open" : "")} data-testid="rail-hosts"
            title={t("连接（⌘B）")} aria-pressed={hostbarOpen} onClick={() => toggleHostbar(!hostbarOpen)}>
            <IconServer size={17} />
          </button>
          <button className={"rail-btn" + (agentOpen ? " ts-open" : "")} data-testid="rail-agent"
            title={t("Agent 对话（演练）")} aria-pressed={agentOpen} onClick={() => toggleAgent(!agentOpen)}>
            <IconBot size={17} />
          </button>
          <button className={"rail-btn" + (fleetOpen ? " ts-open" : "")} data-testid="rail-fleet"
            title={t("跨主机编排（Fleet）：派发任务给各会话的执行 agent 并汇总")} aria-pressed={fleetOpen}
            onClick={() => toggleFleet(!fleetOpen)}>
            <IconShuffle size={17} />
          </button>
          <button className={"rail-btn" + (monitorOpen ? " ts-open" : "")} data-testid="rail-monitor"
            title={t("资源监控大屏：多服务器 CPU/内存/网络 与 Ascend NPU{0}", monGeneral || monNpu ? t("（后台采集中）") : "")} aria-pressed={monitorOpen}
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
            sessions={sessions} hostsLoaded={hostsLoaded}
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
        {!hostbarOpen && !agentOpen && !fleetOpen && !monitorOpen && (
          <button className="ghost icon-btn hb-expand" title={t("展开主机栏（⌘B）")} aria-label={t("展开主机栏")}
            onClick={() => toggleHostbar(true)}>
            <IconChevronRight size={15} />
          </button>
        )}
        {(agentOpen || fleetOpen) && (
          /* Agent 对话视图：双模式——真模型（inTauri + 已配置模型服务，Rust 侧
             agent-host 驱动，审批卡对账 pendingApprovals 内联呈现）或演练外壳。
             fleet 形态（Fleet 轮）：对话键固定 "fleet"（Rust FLEET_KEY），跨会话
             编排者——无委托门/控制权徽标（它不直接操作机器），其余交互同款 */
          <AgentView
            width={agentWidth} fleet={fleetOpen}
            sid={fleetOpen ? "fleet" : sid}
            hostLabel={fleetOpen ? "跨主机编排" : hostLabel(sid ?? undefined)}
            tmuxNote={tmuxAgentNote}
            pending={pendingApprovals} onDecide={decide}
            owner={owner} onDelegate={delegateEmbedded}
            autonomyOn={autonomy.some((g) => g.agent_id === EMBEDDED_AGENT_ID)}
            onToggleAutonomy={toggleEmbeddedAutonomy}
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
            onClose={() => toggleMonitor(false)}
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
              title={t("左侧还有 {0} 个会话被收起——点击展开（⌘⇧[ 可循环切换）", tabScroll.hiddenL)}
              onClick={() => scrollTabs(-1)}>‹</button>
          )}
          <div className="tabbar" ref={tabbarRef} onScroll={measureTabbar} role="tablist" aria-label={t("会话标签")}>
            {sessions.map((s, i) => {
              const st = stateLabel(s.state);
              const inSplit = splitPanes?.main === s.id || splitPanes?.second === s.id;
              // 十四轮：标签自定名（复制标签页后同名标签的区分），无则回退主机名
              const label = tabNames[s.id] ?? s.host_name;
              return (
                <div
                  key={s.id}
                  data-sid={s.id}
                  className={"tab" + (sid === s.id ? " tab-active" : "") + (inSplit ? " tab-pane" : "")
                    + (bellSids.has(s.id) ? " tab-bell" : "")
                    + (tabDragSid === s.id ? " tab-drag-src" : "")
                    + (tabDropHint?.sid === s.id ? (tabDropHint.before ? " tab-drop-before" : " tab-drop-after") : "")}
                  onPointerDown={(e) => {
                    // pointer 自定义拖拽（原因见 tabDragRef 注释）：仅左键且不在子控件
                    // （✕/分屏钮/重命名输入框）上才起拖；不 preventDefault——保住 click、
                    // 双击重命名、中键关闭
                    if (e.button !== 0) return;
                    if (e.target instanceof Element && e.target.closest("button, input")) return;
                    dragClickSupRef.current = false;
                    tabDragRef.current = { sid: s.id, startX: e.clientX, startY: e.clientY, active: false };
                    e.currentTarget.setPointerCapture(e.pointerId);
                  }}
                  onPointerMove={(e) => {
                    const drag = tabDragRef.current;
                    if (!drag || drag.sid !== s.id || !tabDragRef.current) return;
                    if (!drag.active) {
                      // 5px 阈值区分点击与拖拽（阈值前不动任何提示）
                      if (Math.abs(e.clientX - drag.startX) + Math.abs(e.clientY - drag.startY) < 5) return;
                      drag.active = true;
                      setTabDragSid(s.id);
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
                      setTabDropHint((cur) => {
                        const next = hit && hit.sid !== drag.sid ? hit : null;
                        return next && cur?.sid === next.sid && cur?.before === next.before ? cur : next;
                      });
                    } else {
                      setTabDropHint((cur) => (cur ? null : cur));
                      if (inTerm && sessionsRef.current.length >= 2 && tr) {
                        const sp = splitRef.current;
                        let zone: "l" | "r" | "t" | "b";
                        if (sp) {
                          zone = paneAtPoint(e.clientX, e.clientY) === "main"
                            ? (sp.dir === "tb" ? "t" : "l")
                            : (sp.dir === "tb" ? "b" : "r");
                        } else {
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
                  onPointerUp={(e) => {
                    const drag = tabDragRef.current;
                    tabDragRef.current = null;
                    document.body.classList.remove("tab-dragging");
                    if (!drag || drag.sid !== s.id) return;
                    if (!drag.active) return; // 未过阈值=纯点击，click 事件照常激活
                    setTabDragSid(null);
                    setTabDropHint(null);
                    setTermDropHint(null);
                    dragClickSupRef.current = true;
                    finishTabDrag(drag.sid, e.clientX, e.clientY);
                  }}
                  onPointerCancel={() => {
                    tabDragRef.current = null;
                    setTabDragSid(null);
                    setTabDropHint(null);
                    setTermDropHint(null);
                    document.body.classList.remove("tab-dragging");
                  }}
                  title={`${label} · ${st.text}${i < 9 ? ` · ⌘${i + 1}` : ""}`}
                  aria-label={`${label}，${st.text}${inSplit ? "，在分屏中" : ""}${i < 9 ? `，⌘${i + 1}` : ""}`}
                  tabIndex={0}
                  role="tab"
                  aria-selected={sid === s.id}
                  onKeyDown={(e) => {
                    // R20-H1 同款守卫（R27 tab-x/tab-split 键盘化后必须）：子按钮上的
                    // Enter/Space 冒泡到标签处理器会 preventDefault 吞掉按钮默认点击、
                    // 误触 attachSession——只有标签本体直接按键才激活
                    if (e.target !== e.currentTarget) return;
                    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); void attachSession(s.id).catch((er) => pushToast("err", errMsg(er))); }
                  }}
                  onClick={() => {
                    if (dragClickSupRef.current) { dragClickSupRef.current = false; return; }
                    void attachSession(s.id).catch((e) => pushToast("err", errMsg(e)));
                  }}
                  onMouseDown={(e) => {
                    // 十四轮：中键关闭（浏览器/Windows Terminal 惯例），走与 ✕/右键
                    // 同一确认契约；preventDefault 压掉中键自动滚动
                    if (e.button === 1) { e.preventDefault(); e.stopPropagation(); requestCloseSession(s); }
                  }}
                  onDoubleClick={(e) => {
                    // 十四轮：双击重命名——只认标签本体/状态点/文字，子按钮双击不误触
                    const t = e.target as HTMLElement;
                    if (!(t === e.currentTarget || t.classList.contains("tab-label") || t.classList.contains("tab-dot"))) return;
                    e.stopPropagation();
                    setRenaming({ sid: s.id, value: tabNames[s.id] ?? s.host_name });
                  }}
                  onContextMenu={(e) => {
                    // 十一轮 §6.3 修订：右键标签弹会话操作菜单（按状态显隐）；右键不切换焦点标签
                    e.preventDefault();
                    e.stopPropagation();
                    setTabMenu({ x: e.clientX, y: e.clientY, sid: s.id });
                  }}
                >
                  <span className={"tab-dot " + st.cls} aria-hidden="true" />
                  {renaming?.sid === s.id ? (
                    <input
                      className="tab-rename"
                      value={renaming.value}
                      autoFocus
                      aria-label={t("重命名标签")}
                      onChange={(e) => setRenaming({ sid: s.id, value: e.target.value })}
                      onClick={(e) => e.stopPropagation()}
                      onMouseDown={(e) => e.stopPropagation()}
                      onDoubleClick={(e) => e.stopPropagation()}
                      onKeyDown={(e) => {
                        // 编辑框内按键不冒泡（Enter/Space 会被标签 onKeyDown 抢成激活）
                        e.stopPropagation();
                        // IME 组合期 Enter 是确认候选词，不提交重命名（§7.3 口径）
                        if (e.nativeEvent.isComposing || e.keyCode === 229) return;
                        if (e.key === "Enter") commitTabRename(s.id, renaming.value);
                        else if (e.key === "Escape") setRenaming(null);
                      }}
                      onBlur={() => commitTabRename(s.id, renaming.value)}
                    />
                  ) : (
                    <span className="tab-label">{label}</span>
                  )}
                  {/* R27（§7.4）：关闭/分屏改真按钮——键盘 Tab 可达、focus-visible 可见、
                      可访问名称不依赖 hover；命中区 ≥28 由 CSS ::after 透明扩展 */}
                  <button
                    type="button"
                    className="tab-split"
                    title={splitPanes ? `放到${splitDir === "tb" ? "下" : "右"}侧分屏` : s.id === sid ? "已在主视图" : `与当前会话分屏（放到${splitDir === "tb" ? "下" : "右"}侧）`}
                    aria-label={splitPanes ? `把 ${s.host_name} 放到${splitDir === "tb" ? "下" : "右"}侧分屏` : s.id === sid ? `${s.host_name} 已在主视图` : `与 ${s.host_name} 分屏（${splitDir === "tb" ? "上下" : "左右"}）`}
                    onClick={(e) => { e.stopPropagation(); void enterSplitWith(s.id, splitDir); }}
                  ><IconSplit size={12} /></button>
                  <button
                    type="button"
                    className="tab-x"
                    title={t("关闭会话（⌘/Ctrl+W，活动会话先确认影响）")}
                    aria-label={`关闭会话 ${s.host_name}`}
                    onClick={(e) => { e.stopPropagation(); requestCloseSession(s); }}
                  ><IconX size={11} /></button>
                </div>
              );
            })}
          </div>
          {tabScroll.right && (
            <button className="tab-scroll" aria-label={t("向右滚动标签")}
              title={`右侧还有 ${tabScroll.hiddenR} 个会话被收起——点击展开（⌘⇧] 可循环切换）`}
              onClick={() => scrollTabs(1)}>›</button>
          )}
          {splitPanes && <button className="ghost" onClick={exitSplit}>退出分屏</button>}
          {/* 十九轮：命令面板入口（⌘K / Ctrl+K 的可发现锚点） */}
          <button className="ghost" title={t("命令面板（Ctrl+K / ⌘K）")} aria-label={t("命令面板")} data-testid="palette-open"
            onClick={() => setPaletteOpen(true)}><IconSearch size={14} /></button>
          {/* 专注模式（F11）：常态是 ⤢ 图标；专注下滑出条里另有文字钮，双入口同 applyFocus。
              协作/传输入口在此补位——专注下标题栏与状态条都藏了，而 §3 要求待审批等
              提醒必须可达（pendingCount>0 已让 zenPin 钉住标签条，入口就在眼前） */}
          {/* 接管双钮同样只在工具栏的话，专注+Agent 控制时想停下危险命令就得先退
              专注（巡检补）——zenPin 已保证此态标签条钉在眼前，入口放这里正好 */}
          {focusMode && sid && hasAgents && owner === "Agent" && (
            <>
              <button className="warn" title={t("接管会话：Agent 冻结、待审批请求作废，终端归你。Agent 正在跑的命令不会被中断")}
                onClick={takeover}>接管</button>
              <button className="ghost-danger" title={t("接管并额外尝试停止 Agent 正在运行的命令；停止结果逐条显示，未停下的会标红")}
                onClick={takeoverStop}>接管并停止</button>
            </>
          )}
          {focusMode && collabConfigured && (
            <button className={"ghost" + (rightPanel === "collab" ? " ts-open" : "")}
              title={t("协作：审批、任务目标与现场简报")}
              onClick={() => setRightPanel(rightPanel === "collab" ? null : "collab")}>
              {t("协作")}{pendingCount > 0 ? t(" · {0}", pendingCount) : ""}
            </button>
          )}
          {focusMode && runningTransfers > 0 && (
            <button className={"ghost" + (queueOpen ? " ts-open" : "")}
              title={t("传输队列（底部抽屉）")}
              onClick={() => setQueueOpen(!queueOpen)}>{t("传输")} {runningTransfers}</button>
          )}
          {focusMode && <button className="ghost" onClick={() => applyFocus(false)}>{t("退出专注")}</button>}
          <button className={"ghost icon-btn" + (focusMode ? " ts-open" : "")} data-testid="focus-toggle"
            title={focusMode ? t("退出专注模式（F11）")
              : zenStripAuto ? t("专注模式（F11）：隐藏标题栏/主机栏/工具栏并系统全屏，标签条藏为顶缘浮标")
              : t("专注模式（F11）：隐藏标题栏/主机栏/工具栏并系统全屏，标签条保持常驻")}
            aria-pressed={focusMode} aria-label={focusMode ? t("退出专注模式") : t("进入专注模式")}
            onClick={() => applyFocus(!focusMode)}>
            {focusMode ? <IconMinimize size={14} /> : <IconMaximize size={14} />}
          </button>
          <div className="st-tools" ref={tabsMenuRef}>
            <button className="ghost tab-all" title={t("所有标签")} aria-haspopup="menu" aria-expanded={tabsMenuOpen}
              onClick={() => setTabsMenuOpen(!tabsMenuOpen)}>{t("标签列表")}</button>
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
                        <span className="tab-label">{s.host_name}</span>
                        <span className={"mono " + st.cls} style={{ fontSize: 10, marginLeft: "auto" }}>{st.text}</span>
                      </button>
                      {s.state === "Disconnected" && (
                        <button className="tm-act" title={t("重连该会话")} disabled={reconnecting !== null}
                          onClick={() => { reconnectSession(s); }}>{t("重连")}</button>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
          <button className="ghost" title={t("新建连接（Ctrl+T）")} aria-label={t("新建连接")} onClick={() => { setShowAddHost(!showAddHost); setShowImport(false); setShowQuickConnect(false); }}><IconPlus size={14} /></button>
          {/* 十七轮：快速连接——不存主机一次性建连 */}
          <button className="ghost" title={t("快速连接（不保存主机，临时连接一次）")} aria-label={t("快速连接")} data-testid="quick-connect-open" onClick={() => { setShowQuickConnect(true); setShowAddHost(false); setShowImport(false); }}><IconTerminal size={14} /></button>
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
          collabConfigured={collabConfigured} mcp={mcp}
          delegateGoal={delegateGoal} setDelegateGoal={setDelegateGoal}
          delegateErr={delegateErr} openSettingsAt={openSettingsAt}
          delegateBusy={delegateBusy} submitDelegate={submitDelegate}
          disableImpact={disableImpact} setDisableImpact={setDisableImpact}
          collabBusy={collabBusy} confirmDisable={confirmDisable}
          confirm={confirm} setConfirm={setConfirm}
          closeConfirmRef={closeConfirmRef} confirmImpact={confirmImpact} confirmAction={confirmAction}
          quitSummary={quitSummary} setQuitSummary={setQuitSummary}
          quitConfirmRef={quitConfirmRef} confirmQuit={confirmQuit} cancelQuit={cancelQuit}
          delHostRef={delHostRef} delIdentRef={delIdentRef}
        />
        {/* 会话工具栏 40（拆分⑤出仓 components/session-toolbar.tsx，零语义变更） */}
        {current && (
          <SessionToolbar
            current={current} sid={sid} oscTitles={oscTitles}
            hasAgents={hasAgents} owner={owner} collabConfigured={collabConfigured}
            embeddedReady={embeddedReady}
            searchOpen={searchOpen} splitMenu={splitMenu} splitPanes={splitPanes}
            rightPanel={rightPanel} toolsOpen={toolsOpen} toolsRef={toolsRef}
            dispatchRef={dispatchRef} setSplitMenu={setSplitMenu}
            setRightPanel={setRightPanel} setToolsOpen={setToolsOpen}
            exitSplit={exitSplit} openDelegate={openDelegate}
            takeover={takeover} takeoverStop={takeoverStop}
            openSessionDetail={openSessionDetail} toggleSessionLog={toggleSessionLog}
            requestCloseSession={requestCloseSession}
            broadcastArmed={broadcastTargets.length} openBroadcast={() => setBroadcastOpen(true)}
            canForward={remoteOpen}
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
                  onClick={() => { setShowAddHost(false); setEditingHost(null); setPrefillEntry(null); }}><IconX size={14} /></button>
              </div>
              <AddHostForm
                editHost={editingHost}
                prefill={prefillEntry}
                onCancel={() => { setShowAddHost(false); setEditingHost(null); setPrefillEntry(null); }}
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
            </div>
          </div>
        )}
        {showQuickConnect && (
          <div className="hk-mask" role="dialog" aria-modal="true" aria-label={t("快速连接")} data-testid="quick-connect-dialog">
            <div className="hk-dialog add-host-dlg" ref={quickDlgRef}>
              <div className="dlg-head">
                <b>{t("快速连接")}</b>
                <button className="ghost icon-btn" aria-label={t("关闭")} onClick={() => setShowQuickConnect(false)}><IconX size={14} /></button>
              </div>
              <QuickConnectForm
                onConnect={(display, draft) => {
                  setShowQuickConnect(false);
                  void createSession(display, false, draft);
                }}
                onCancel={() => setShowQuickConnect(false)}
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
            {splitPanes && !splitDegraded && (
              <div
                className={"pane-div " + (splitPanes.dir === "tb" ? "div-tb" : "div-lr")}
                data-testid="pane-div"
                role="separator"
                aria-orientation={splitPanes.dir === "tb" ? "horizontal" : "vertical"}
                aria-label={t("分屏分割条")}
                title={t("拖拽调整两格比例（20%~80%）；双击复位对半")}
                onPointerDown={onDivDown}
                onPointerMove={onDivMove}
                onPointerUp={onDivUp}
                onPointerCancel={onDivUp}
                onDoubleClick={resetSplitFrac}
              />
            )}
            {/* 拖标签组合分屏：落点提示。高亮块 inset 吃 #term 的 --split-frac——
                已分屏时高亮恰为真实窗格几何，未分屏（默认 .5）即为半区 */}
            {termDropHint && (
              <div className="drag-split-hint" data-testid="drag-split-hint">
                <div className={"dsh-zone zone-" + termDropHint} />
              </div>
            )}
          </div>
          {current?.state === "Disconnected" && (() => {
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
            const liveNames = live.map((x) => x.name).join("、");
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
          {dragOver && (
            <div className="drop-overlay">
              <div className="drop-box">
                <div className="drop-icon"><IconDownload size={34} /></div>
                <div>{t("松开上传到")} {brief?.cwd ?? t("远程主机")}</div>
              </div>
            </div>
          )}
          {attachHint && sid && (
            <div className="attach-hint">{t("会话已接入——点击终端区直接打字")}</div>
          )}
          {searchOpen && sid && (
            <div className="term-search">
              <input
                ref={searchInputRef}
                autoFocus
                spellCheck={false}
                placeholder={t("搜索终端内容…")}
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
                    ? t("无结果")
                    : ""}
              </span>
              <button className="ghost" title={t("上一个（⇧⏎）")} aria-label={t("上一个搜索结果")} onClick={() => searchQuery && termsRef.current.get(sidRef.current ?? "")?.search.findPrevious(searchQuery, SEARCH_OPTS)}><IconChevronUp size={13} /></button>
              <button className="ghost" title={t("下一个（⏎）")} aria-label={t("下一个搜索结果")} onClick={() => searchQuery && termsRef.current.get(sidRef.current ?? "")?.search.findNext(searchQuery, SEARCH_OPTS)}><IconChevronDown size={13} /></button>
              <button className="ghost" title={t("关闭（Esc）")} aria-label={t("关闭搜索")} onClick={closeSearch}><IconX size={12} /></button>
            </div>
          )}
          {/* 五个右键/弹出菜单 + 分屏退化提示（拆分⑤出仓 components/ctx-menus.tsx，
              零语义变更）：分屏选择、标签右键、主机卡右键、终端区右键、最近连接行右键 */}
          <CtxMenus
            sessions={sessions} sid={sid} hosts={hosts} hostMeta={hostMeta}
            connectingIds={connectingIds} splitPanes={splitPanes} tabNames={tabNames}
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
            setSearchOpen={setSearchOpen} searchInputRef={searchInputRef} sidRef={sidRef}
            attachSession={attachSession}
            splitDegraded={splitDegraded} splitHintOpen={splitHintOpen}
            splitHintDismissedRef={splitHintDismissedRef} setSplitHintOpen={setSplitHintOpen}
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
                  <div>{pasteConfirm.kind === "rerun"
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
                    if (pasteConfirm.kind === "rerun") {
                      void invoke("send_keys", { sid: pasteConfirm.sid, keys: pasteConfirm.text + "\r" }).catch(() => {});
                    } else {
                      // 确认后的危险粘贴同样只进当前会话（广播抑制，与安全粘贴同口径）
                      bcastSuppressRef.current = true;
                      try { termsRef.current.get(pasteConfirm.sid)?.term.paste(pasteConfirm.text); }
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
            <div className="confirm-mask" onClick={() => setOsc52Ask(null)}>
              <div className="confirm-dialog paste-dialog" ref={osc52AskRef} role="dialog" aria-modal="true" aria-labelledby="dlg-osc52-title" onClick={(e) => e.stopPropagation()}>
                <div className="hk-title" id="dlg-osc52-title" data-testid="osc52-dialog">
                  {t("远端请求写入剪贴板 ·")} {sessions.find((s) => s.id === osc52Ask.sid)?.host_name ?? t("该会话")}
                </div>
                <div>{t("远端程序通过 OSC 52 转义序列请求改写你本机的剪贴板——允许后现有内容会被覆盖，拒绝则不写入任何字节。「始终允许」本次照写且此后不再询问（设置→终端 可改回）。读取类请求（查询）一律拒绝，不经此卡。")}</div>
                <pre className="paste-preview mono" data-testid="osc52-preview">{osc52Ask.text.length > 400
                  ? osc52Ask.text.slice(0, 400) + t("……（预览截断，共 {0} 字符）", osc52Ask.text.length)
                  : osc52Ask.text}</pre>
                <div className="hk-actions">
                  <button className="danger" data-testid="osc52-allow" onClick={() => {
                    osc52WriteRef.current(osc52Ask.sid, osc52Ask.text);
                    setOsc52Ask(null);
                    restoreTermFocus();
                  }}>{t("允许写入")}</button>
                  {/* 用户反馈：选区每次都弹卡太严——一键把策略翻 allow（走既有持久化），此后直写 */}
                  <button className="ghost" data-testid="osc52-allow-forever" onClick={() => {
                    osc52WriteRef.current(osc52Ask.sid, osc52Ask.text);
                    changeOsc52Policy("allow");
                    setOsc52Ask(null);
                    restoreTermFocus();
                  }}>{t("始终允许")}</button>
                  <button className="ghost" data-autofocus data-testid="osc52-deny" onClick={() => { setOsc52Ask(null); restoreTermFocus(); }}>{t("拒绝")}</button>
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
                    onKeyDown={(e) => { if (e.key === "Enter" && pendingDropDir.trim()) confirmDropUpload(); }}
                  />
                </div>
                <div className="dim" style={{ marginTop: 6, fontSize: 12 }} data-testid="drop-files-line">
                  {t("{0} 个文件：", pendingDrop.paths.length)}{pendingDrop.paths.slice(0, 3).map((p) => pathBasename(p)).join("、")}
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
              keymapRef={keymapRef}
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
        {/* 监控条（命令框退役轮）：命令框腾出的底部常驻条改为 FinalShell 式远端
            资源采样——Fresh 独立通道直读 /proc，不进终端、不进审计。本地会话与
            采样不可用（非 Linux 远端/连续失败）整条隐藏（MetricsBar 内部判定）。
            key=sid：切签重置差分基线，避免跨主机算出假速率 */}
        {sid && current && (
          <MetricsBar
            key={sid}
            sid={sid}
            kind={current.kind}
            user={hosts.find((h) => h.id === current.host_id)?.username}
            hostName={current.host_name}
          />
        )}
        </div>{/* /term-col */}

        {/* 右侧任务面板（§4.3/§6.6）：一次只呈现文件 / 转发 / 协作 / 活动记录之一；窄窗改中央完整视图 */}
        {rightPanel && (
          <aside className={"task-panel" + (tpFull ? " tp-full" : "")} aria-label={t("任务面板")} ref={taskPanelRef}>
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
              collabEnabled={collabEnabled} collab={collab} collabStateText={collabStateText}
              collabConfigured={collabConfigured} collabActive={collabActive}
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
                    <input className="mono" value={fwdPort} placeholder={t("端口")}
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
                      <input className="mono" value={fwdTPort} placeholder={t("端口")}
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
            />
          )}
          {rightPanel === "collab" && (
            /* 委托/任务目标/现场简报（拆分⑤出仓 components/collab-panel.tsx，零语义变更） */
            <CollabDelegate
              sid={sid} current={current} owner={owner}
              collabEnabled={collabEnabled} collabConfigured={collabConfigured}
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
            title={t("文件")} aria-pressed={rightPanel === "files"}
            onClick={() => setRightPanel(rightPanel === "files" ? null : "files")}><IconFolder size={17} /></button>
          <button className={"rail-btn" + (rightPanel === "collab" ? " ts-open" : "")} data-testid="rb-collab"
            title={t("协作")} aria-pressed={rightPanel === "collab"}
            onClick={() => setRightPanel(rightPanel === "collab" ? null : "collab")}>
            <IconUsers size={17} />
            {pendingCount > 0 && <span className="rail-badge">{pendingCount > 9 ? "9+" : pendingCount}</span>}
          </button>
          {remoteOpen && (
            <button className={"rail-btn" + (rightPanel === "forwards" ? " ts-open" : "")} data-testid="rb-forwards"
              title={t("端口转发")} aria-pressed={rightPanel === "forwards"}
              onClick={() => setRightPanel(rightPanel === "forwards" ? null : "forwards")}><IconShuffle size={17} /></button>
          )}
          <button className={"rail-btn" + (rightPanel === "log" ? " ts-open" : "")} data-testid="rb-log"
            title={t("活动记录")} aria-pressed={rightPanel === "log"}
            onClick={() => setRightPanel(rightPanel === "log" ? null : "log")}><IconRows size={17} /></button>
          <button className={"rail-btn" + (rightPanel === "blocks" ? " ts-open" : "")} data-testid="rb-blocks"
            title={t("命令块")} aria-pressed={rightPanel === "blocks"}
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

        {/* 页脚状态条 24（§4.2）：只放短状态与任务入口 */}
        <footer className="statusbar">
          <span className="mono sb-left">{sbLeft}</span>
          <span style={{ flex: 1 }} />
          <span className="sb-right">
            <button className={"sb-btn" + (broadcastTargets.length > 0 ? " ts-open" : "")} data-testid="sb-broadcast" title={t("广播输入：同一键入同时发到勾选的会话（点开选择目标）")} aria-pressed={broadcastOpen}
              onClick={() => setBroadcastOpen(!broadcastOpen)}>{t("广播")} <b>{broadcastTargets.length > 0 ? broadcastTargets.length : ""}</b></button>
            <button className={"sb-btn" + (rightPanel === "blocks" ? " ts-open" : "")} data-testid="sb-blocks" title={t("命令块：最近命令时间线（shell 集成 OSC 133）")} aria-pressed={rightPanel === "blocks"}
              onClick={() => setRightPanel(rightPanel === "blocks" ? null : "blocks")}>{t("块")} <b>{blocksList.length > 0 ? blocksList.length : ""}</b></button>
            {remoteOpen && <button className="sb-btn" title={t("端口转发")} onClick={() => setRightPanel(rightPanel === "forwards" ? null : "forwards")}>{t("转发")} <b>{forwards.length}</b></button>}
            <button className={"sb-btn" + (queueOpen ? " ts-open" : "")} data-testid="sb-transfer" title={t("传输队列（底部抽屉；后台事件只更新计数不自动展开）")} aria-pressed={queueOpen}
              onClick={() => setQueueOpen(!queueOpen)}>{t("传输")} <b>{runningTransfers}</b> {queueOpen ? "⌃" : "⌄"}</button>
          </span>
        </footer>
        </main>
      </div>{/* /workspace */}

      {/* Toast（§六/P3）：右下角轻通知，普通 2.6s/带动作 8s 自动消失，不挡交互
          （栈 pointer-events:none，动作钮自身收回事件）。
          live 级别逐条给：err 用 assertive 立即播报，其余 polite（审核吹毛求疵-4） */}
      <div className="toast-stack">
        {toasts.map((t) => {
          const act = t.action;
          return (
            <div className={"toast " + t.kind} key={t.id} aria-live={t.kind === "err" ? "assertive" : "polite"}>
              {t.text}
              {act && (
                <button className="toast-act" data-testid="toast-action" title={act.title}
                  onClick={() => { act.run(); setToasts((cur) => cur.filter((x) => x.id !== t.id)); }}>{act.label}</button>
              )}
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
