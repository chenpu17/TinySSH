import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react";
import {
  invoke, MkChannel, inTauri, listen,
} from "./adapter/bridge";
import { errMsg, parseWireError } from "./adapter/errors";
import { MetricsBar } from "./metrics";
import { SelfMeterDetail } from "./self-meter";
import { resolveAction, isMacPlatform, isWindowsPlatform } from "./actions";
import type { AppAction } from "./actions";
import {
  DEFAULT_KEYMAP, KEYMAP_ACTIONS, KEYMAP_SETTING,
  bindingOf, parseKeymap, conflictOf, formatBinding, sameBinding,
  type Binding, type KeyActionId,
} from "./keymap";
import { CommandPalette, type PaletteItem } from "./palette";
import {
  registerZoomHotkeys, onZoomChange, currentZoom, setZoomScale,
  zoomIn, zoomOut, zoomReset, ZOOM_LEVELS,
} from "./zoom";
import { createOutputFeed } from "./terminal/checkpoint";
import type { OutputFeed } from "./terminal/checkpoint";
import type {
  Host, HostDraft, HostMeta, RecentHost, SshConfigPreview, SshImportOutcome, SessionInfo, ApprovalItem, AuthDraft,
  PendingHostKey, PendingAuthPrompt, SessionBrief as Brief, AuditEvent,
  IdentityMeta, TakeoverReport, TransferHandle, DirEntryS, ForwardSpec, ForwardInfo,
  AttemptPhase, AttemptInfo, ErrorPayload, ConnectionEvent, CancelOutcome, SessionStateEvent,
  TransferTask, CollisionDecision, SessionDetail, ShellCapability, CollabStatus, DisableImpact,
} from "./adapter/wire";
import {
  IconSliders, IconPlus, IconMinus, IconX, IconSplit, IconStop, IconPencil, IconTrash, IconStar,
  IconChevronUp, IconChevronDown, IconChevronLeft, IconChevronRight, IconTerminal,
  IconArrowDown, IconUpload, IconDownload, IconInbox, IconClock, IconSearch, IconLoader,
  IconFolder, IconFile, IconRefresh,
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
import { WebLinksAddon } from "@xterm/addon-web-links";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { DragDropEvent } from "@tauri-apps/api/webview";
import "@xterm/xterm/css/xterm.css";
// 拆分①抽出的共享层：数据/工具/hooks（app-data）与自包含组件（components/*）
import {
  altMetaSequence, ApprovalRow, approvalResolvedLabel, APPEARANCES, auditLabel, AUDIT_LABELS,
  ChromePalette, ctrlCharOf, decisionLabel, epistemicLabel, exitText, fmtBytes,
  FONT_DEFAULT, FONT_MAX, FONT_MIN, friendlyError, hhmm, inputBlockedState,
  LOG_ACTION_OPTIONS, normApprovalStatus, PALETTES, PALETTE_DEFAULT, pathBasename,
  runBench, SEARCH_OPTS, SETTING_FONT, SETTING_FONT_LEGACY, SETTING_PALETTE,
  settingsCatIcon, settingsCatLabel, SETTINGS_CATS, stateLabel, stampLocal, stopOutcomeText,
  SPLIT_DEGRADE_BELOW, SPLIT_PANE_MIN, SPLIT_RECOVER_AT, tauriListen, THEMES, ThemePreset,
  TransferCard, themeById, TZ_NOTE, useDialogFocus,
  type Appearance, type SettingsCat,
} from "./app-data";
import { WinControls } from "./components/window-controls";
import { BriefCard } from "./components/brief-card";
import { QuickConnectForm } from "./components/quick-connect";
import { AddHostForm } from "./components/add-host";
import { SshConfigImportPanel } from "./components/ssh-import";

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
    setSessions((cur) => applyTabOrder(cur.map((s) => (s.id === ev.session_id ? { ...s, state: ev.state } : s))));
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
  // 十五轮：选中即复制（PuTTY/Xshell 惯例）——开关持久化在 workspace blob terminal 域（默认关）
  const [copyOnSelect, setCopyOnSelect] = useState(false);
  const copyOnSelectRef = useRef(false);
  // 十六轮：终端响铃（BEL）→ 系统通知开关（默认关；标签闪烁恒开）
  const [bellNotify, setBellNotify] = useState(false);
  const bellNotifyRef = useRef(false);
  const [bellSids, setBellSids] = useState<Set<string>>(new Set());
  const lastBellNotifRef = useRef<Map<string, number>>(new Map());
  const [pasteConfirm, setPasteConfirm] = useState<{ sid: string; hostName: string; text: string } | null>(null);
  // 十一轮续：粘贴入口统一（⌘V 与终端右键共用）——bracketed paste 语义由 xterm 按远端
  // DECSET 2004 自适配（不补换行不代执行）；远端未开启时多行内容 = 换行立即执行——预览确认后才发
  const pasteTextInto = (term: Terminal, sessionSid: string, t: string) => {
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
  // —— 十五轮：标签拖拽排序 ——
  // 会话期内的显示顺序事实源；list_sessions 整表刷新（连接/断开触发）后仍按此序渲染。
  // 不入 vault（会话本不跨重启）。⌘1-9 / ⌘⇧[] 读同一数组，快捷键序=所见序。
  const tabOrderRef = useRef<string[]>([]);
  const dragSidRef = useRef<string | null>(null);
  const [tabDropHint, setTabDropHint] = useState<{ sid: string; before: boolean } | null>(null);
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
  const [mcp, setMcp] = useState<{ endpoint: string; agents: { id: string; label: string }[] }>({ endpoint: "", agents: [] });
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
  const [hostQuery, setHostQuery] = useState("");
  // 右侧任务面板：一次只呈现文件 / 协作 / 转发 / 活动记录之一（§4.3/§6.6），缺省关闭
  const [rightPanel, setRightPanel] = useState<null | "files" | "collab" | "forwards" | "log">(null);
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
      setSessions(applyTabOrder(await invoke("list_sessions")));
      setHosts(await invoke("list_hosts"));
      // R20：收藏/最近元数据（失败不阻断列表——空 meta 即全部视为未收藏）
      try { setHostMeta(await invoke("list_host_metadata")); } catch { /* 容忍 */ }
      try { setRecents(await invoke("list_recent_hosts")); } catch { /* 容忍 */ }
      setHostsLoaded(true); // §5.6：首载完成后 skeleton 才撤
      setApprovals((await invoke("list_approvals", { pendingOnly: false }))
        .map((a): ApprovalRow => ({ ...a, status: normApprovalStatus(a.status) })));
    } catch {
      // 审核低-5：首载失败也必须撤骨架给出空态出口（否则永久骨架 + 未处理 rejection）；
      // 3s 轮询自愈，错误不逐条打扰（连接类失败另有常驻横幅）
      setHostsLoaded(true);
    }
  }, []);

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
    if (!sid) { setDetailErr("未接入会话——连接主机后可在「工具 → 连接详情」查看"); setDetail(null); setDetailSid(null); return; }
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
      void refreshLists(); // goal_set 审计事件即时反映到列表/简报（活动记录面板自带刷新）
    } catch (e) {
      pushToast("err", friendlyError(e));
    }
  }, [goalDraft, refreshBrief, refreshLists, pushToast]);

  useEffect(() => {
    refreshLists();
    invoke("mcp_status").then(setMcp);
    invoke("collab_status").then(setCollab).catch(() => {});
    invoke("bench_mode").then((b) => {
      if (b) runBench();
    });
  }, [refreshLists]);

  // 列表轮询：会话状态（断线/重连/重确认）与审计时间线自动刷新
  useEffect(() => {
    const t = setInterval(() => {
      refreshLists();
      if (sidRef.current) refreshBrief(sidRef.current);
      // C9（R43）：协作状态与活动请求数随轮询对账（停用封口/重新启用由核心推进，
      // 多窗口或外部触发时 UI 须收敛）
      invoke("collab_status").then(setCollab).catch(() => {});
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
    return tauriListen(listen("approval-event", () => refreshLists()));
  }, [refreshLists]);

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
      // applyDerivedTerminal 对已有实例统一改 options 补齐（二十二轮起主题=派生缓存）
      fontSize: fontRef.current, cursorBlink: true, scrollback: 10000, allowProposedApi: true,
      // UX 二轮精修：xterm 默认字体是 courier-new（Windows 上观感老旧）；行高 1.15 给
      // 行间喘息感；滚轮 100ms 平滑滚动 + Alt 快滚；跨格字形重缩放防框线/符号断裂。
      // UX 六轮：首位内置全量 JetBrains Mono（"JetBrains Mono Term"，styles.css @font-face，
      // 1182 字形含框线/箭头/powerline）——全平台同一等宽字形，框线不再逐格回退系统字体；
      // SF Mono/Cascadia 仅作加载失败兜底
      fontFamily: '"JetBrains Mono Term", "SF Mono", "Cascadia Mono", Menlo, Consolas, "Courier New", monospace',
      lineHeight: 1.15,
      smoothScrollDuration: 100,
      fastScrollModifier: "alt", fastScrollSensitivity: 5,
      rescaleOverlappingGlyphs: true,
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
    // 远程设置的标题（OSC 0/2，T16）：按会话记录，显示在终端头部
    term.onTitleChange((t) => {
      if (t) setOscTitles((prev) => ({ ...prev, [sessionSid]: t }));
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
    // 长命令完成的通用信号：用户切走窗口后远端任务结束/需要关注时主动提示
    term.onBell(() => {
      setBellSids((cur) => new Set(cur).add(sessionSid));
      setTimeout(() => setBellSids((cur) => { const n = new Set(cur); n.delete(sessionSid); return n; }), 6000);
      if (!bellNotifyRef.current || !inTauri) return;
      if (document.hasFocus()) return;
      const now = Date.now();
      if (now - (lastBellNotifRef.current.get(sessionSid) ?? 0) < 10_000) return;
      lastBellNotifRef.current.set(sessionSid, now);
      void (async () => {
        const host = sessionsRef.current.find((x) => x.id === sessionSid)?.host_name ?? "会话";
        try {
          let granted = await isPermissionGranted();
          if (!granted) granted = (await requestPermission()) === "granted";
          if (granted) sendNotification({ title: `🔔 ${host} — 终端响铃`, body: "终端响铃（BEL）：远端可能有命令完成或需要关注" });
        } catch { /* 通知失败静默——标签闪烁仍在 */ }
      })();
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
    return () => ro.disconnect();
  }, [fitTerminal]);
  // 分屏建立/退出/换副窗格时也重估宽度退化态
  useEffect(() => { checkSplitWidthRef.current(); }, [splitPanes]);

  // —— 显示设置（路线图⑥）：字号/主题，vault 持久化（跨进程记忆）——
  // 状态供 UI 渲染；ref 供 makeTerm 闭包与快捷键读取（避开 stale closure）
  const [fontSize, setFontSize] = useState(FONT_DEFAULT);
  const [showSettings, setShowSettings] = useState(false);
  // T34：原生菜单「设置…⌘,」→ 打开显示设置面板；应用版本号（关于面板同源）
  const [appVersion, setAppVersion] = useState<string | null>(null);
  useEffect(() => {
    if (!inTauri) return;
    // 走统一分发（R13 §7.2）：原生菜单加速器与键盘快捷键同一 action 语义
    const un = tauriListen(
      listen("menu-settings", () => { dispatchRef.current({ id: "settings" }); }),
    );
    getVersion().then(setAppVersion).catch(() => {});
    return un;
  }, []);
  const fontRef = useRef(FONT_DEFAULT);
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
  // 主题色板（data-theme，默认石墨——无 CSS 块命中即继承 :root）
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
    // 主题色板启动载入（合法值才应用；缺省石墨，不写 data-theme 属性也成立）
    const loadPalette = (v: string | null) => {
      if (v && PALETTES.some((p) => p.id === v) && v !== paletteRef.current) {
        paletteRef.current = v;
        setPalette(v);
        applyPalette(v);
      }
    };
    if (!inTauri) {
      const raw = Number(localStorage.getItem(SETTING_FONT) ?? localStorage.getItem(SETTING_FONT_LEGACY));
      applyFont(Number.isFinite(raw) && raw > 0 ? raw : null);
      loadPalette(localStorage.getItem(SETTING_PALETTE));
      // 键位表（键位配置轮）：demo 走 localStorage，坏串/缺省回落默认表
      const kmRaw = localStorage.getItem(KEYMAP_SETTING);
      if (kmRaw) applyKeymap(parseKeymap(kmRaw));
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
    const keymapP = invoke("get_setting", { key: KEYMAP_SETTING })
      .then((v) => { if (typeof v === "string" && v) applyKeymap(parseKeymap(v)); })
      .catch(() => {});
    const wsP = invoke("get_workspace").then(applyChromeBlob).catch(() => {});
    // 字号/色板/外观三路都落定后派生一次（applyAppearance/loadPalette 内部亦有派生，
    // 这里兜底「全部缺省」的首次启动路径）
    void Promise.all([fontP, paletteP, wsP]).then(() => applyDerivedTerminal());
  }, [inTauri, changeFontSize, applyAppearance, applyPalette, applyDerivedTerminal, applyKeymap]);

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
  const writeTerminalPrefs = useCallback((patch: Partial<{ paste_guard: boolean; copy_on_select: boolean; bell_notify: boolean }>) => {
    wsWriteChain.current = wsWriteChain.current
      .then(() => invoke("get_workspace"))
      .then((ws) => invoke("set_workspace", { ws: { ...ws, terminal: {
        paste_guard: ws.terminal?.paste_guard ?? true,
        copy_on_select: ws.terminal?.copy_on_select ?? false,
        bell_notify: ws.terminal?.bell_notify ?? false,
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
  const panelNeed = rightPanel === "collab" || rightPanel === "forwards" || rightPanel === "log" ? 400 : 384;
  const availW = winW - (hostbarOpen ? hostbarWidth : 0);
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
    if (delegateDlg) { closeDelegate(); return true; }
    const ap = authPromptQueue[0];
    if (ap) { void answerAuthPrompt(ap.id, ""); return true; }
    const hk = hostKeyQueue[0];
    if (hk) { void decideHostKey(hk, false); return true; }
    if (confirm) { setConfirm(null); return true; }
    if (pasteConfirm) { setPasteConfirm(null); return true; }
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
        // 直键 Ctrl+T（UX 六轮）：镜像工具栏「新建连接」按钮——开主机栏添加表单；
        // 幂开不收起（键盘连按不闪烁），导入/快连两兄弟表单让位
        if (!hostbarOpenRef.current) toggleHostbar(true);
        setShowAddHost(true);
        setShowImport(false);
        setShowQuickConnect(false);
        return true;
      }
      case "split-toggle": {
        // 直键 Ctrl+D（UX 六轮）：与工具栏分屏按钮同路径——已分屏先退（两会话都
        // 保留）；未分屏弹「右侧会话选择」菜单（空态菜单自会说「暂无其他会话」）
        if (splitPanes) void exitSplit();
        else setSplitMenu(true);
        return true;
      }
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
  useDialogFocus(!!pendingDrop, dropCardRef);
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
    for (const s of quitSummary.sessions) {
      try { await invoke("close_session", { sid: s.id }); } catch { /* 尽力关闭；退出路径不受阻 */ }
    }
    try { await invoke("quit_app"); } catch { /* demo 无此命令 */ }
  };
  // 模态层信号（R13 §7.3）：确认/指纹/双因素/退出汇总任一打开即 true——⌘ 组合全吞，Esc 交给浮层链
  const modal = !!(paletteOpen || authPromptQueue.length > 0 || hostKeyQueue.length > 0 || confirm || quitSummary || pasteConfirm || splitMenu || tabMenu || hostMenu || termMenu || recentMenu || pendingDrop || keyCapture);
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
      if (!evb.primary) { pushToast("err", "快捷键需带 Ctrl（mac 为 ⌘）"); return; }
      if (evb.alt) { pushToast("err", "Alt 组合暂不支持（终端里 Alt+字母 是 Meta 序列）"); return; }
      const clash = conflictOf(keymapRef.current, keyCapture, evb);
      if (clash) {
        pushToast("err", `与「${KEYMAP_ACTIONS.find((a) => a.id === clash)?.label ?? clash}」冲突，先给后者换键`);
        return;
      }
      const next = { ...keymapRef.current, [keyCapture]: evb };
      applyKeymap(next);
      persistSetting(KEYMAP_SETTING, JSON.stringify(next));
      pushToast("ok", `已设为 ${formatBinding(evb, isMacPlatform())}`);
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
  // 输入控件语义：无浮层时 Esc 原样透传（搜索框自带关闭不变）；
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

  // C6/R34：冲突决定提交（乐观锁 expect_revision=卡片所见 revision）。
  // StaleDecision/InvalidTransferState = 卡片已过期——刷新对账 + reject 留痕
  //（任务已推进时 reject 幂等 no-op，不会误伤在途待决卡）
  const decideCollision = useCallback(async (t: TransferCard, decision: CollisionDecision) => {
    if (!t.rev) return;
    try {
      await invoke("submit_collision_decision", { id: t.id, decision, expectRevision: t.rev });
      void refreshTransfers();
    } catch (e) {
      const kind = (e as { kind?: string })?.kind;
      if (kind === "stale_decision" || kind === "invalid_transfer_state") {
        pushToast("err", kind === "stale_decision" ? "决定已过期（任务已推进），卡片已刷新" : "任务状态已变化，卡片已刷新");
        try { await invoke("reject_expired_decision", { id: t.id }); } catch { /* 幂等收尾 */ }
        void refreshTransfers();
      } else {
        pushToast("err", `决定提交失败：${friendlyError(e)}`);
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
      pushToast("err", `核实失败：${friendlyError(e)}`);
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
        ? "该任务不可重试：结果未知请先「重新核实」"
        : `重试失败：${friendlyError(e)}`);
    }
  }, [pushToast, refreshTransfers]);

  // R35 S08「定位」：下载=访达显示本地目标；上传=文件面板导航到目标目录
  //（仅目标会话=当前会话时；跨会话定位不静默改道）
  const locateTransfer = useCallback(async (t: TransferCard) => {
    if (t.kind === "Download") {
      try {
        await invoke("reveal_path", { path: t.local });
      } catch (e) {
        pushToast("err", `定位失败：${friendlyError(e)}`);
      }
      return;
    }
    if (t.sid && t.sid === sidRef.current) {
      setRightPanel("files");
      const dir = t.remote.replace(/\/[^/]*$/, "") || "/";
      void navigateTo(dir);
    } else {
      pushToast("err", "目标在其他会话——切换到对应会话后可定位");
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
  const downloadRemote = useCallback(async (rp: string, opts?: { saveAs?: boolean }) => {
    const s = sidRef.current;
    if (!s || !rp) return;
    const name = pathBasename(rp);
    const saveAs = opts?.saveAs ?? sftpSaveAs;
    let local: string | null = null;
    if (saveAs) {
      try {
        const picked = await invoke("pick_save_file", { defaultName: name, defaultDir: downloadDirRef.current });
        if (!picked) return; // 用户取消——不发起传输
        local = picked;
        const dir = local.replace(/\/+$/, "").replace(/\/[^/]*$/, "");
        if (dir) persistDownloadDir(dir);
      } catch (e) {
        pushToast("err", `另存为失败：${friendlyError(e)}`);
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
    for (const t of targets) await downloadRemote(t);
    if (skippedDirs > 0 || skippedOther > 0) {
      const parts: string[] = [];
      if (skippedDirs > 0) parts.push(`${skippedDirs} 个目录`);
      if (skippedOther > 0) parts.push(`${skippedOther} 个特殊文件`);
      pushToast("info", targets.length > 0
        ? `已开始下载 ${targets.length} 个文件；${parts.join("、")}不支持直接下载`
        : `${parts.join("、")}不支持直接下载——请进入目录选择其中的文件`);
    }
  }, [sftpEntries, sftpSel, downloadRemote, pushToast]);

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
    if (!laddr) next.listen = "监听地址不能为空（默认 127.0.0.1）";
    else if (!Number.isInteger(p) || p <= 0 || p > 65535) next.listen = "监听端口必须是 1–65535 的数字";
    // 非回环「必须主动选择」：未勾选确认时阻止启动并说明暴露范围
    if (!next.listen && !isLoopbackAddr(laddr) && !fwdExposeAck) {
      next.listen = `非回环监听 ${laddr} 将对本机所在网络可见——请勾选「我确认暴露范围」后再启动`;
    }
    if (fwdKind !== "Dynamic" && (!fwdHost.trim() || !Number.isInteger(tp) || tp <= 0 || tp > 65535)) {
      next.target = "目标主机与端口（1–65535）都要填";
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
        setFwdFieldErr({ listen: `远端拒绝监听 ${laddr}:${p}：${st.error ?? "未知错误"}` });
        return; // 输入保留，用户改端口/主机即可重试（finally 里复位 busy）
      }
      setFwdPort(""); setFwdHost(""); setFwdTPort("");
      pushToast("ok", fwdKind === "Local" ? `本地转发已启动：${laddr}:${p}` : fwdKind === "Remote" ? `远程转发已启动：远端 ${laddr}:${p}` : `SOCKS5 已启动：${laddr}:${p}`);
    } catch (e) {
      // 结构化字段定位：核心 ForwardListenFailed{field} → 就地高亮；其余走通用提示
      const pe = parseWireError(e);
      if (pe.kind === "forward_listen_failed") {
        const field = (pe.detail as { field?: string } | undefined)?.field === "target" ? "target" : "listen";
        setFwdFieldErr({ [field]: friendlyError(e) } as { listen?: string; target?: string });
      } else {
        pushToast("err", `转发启动失败：${friendlyError(e)}`);
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

  // R33 §354 拖放落点分区：文件面板落点=直接上传到正在浏览的目录（不确认）；
  // 其余落点（终端等）=目标确认卡。物理像素→逻辑像素后与面板实测矩形求交，
  // 面板分区仅在面板开着且显示文件页时存在。demo 域经 window.__demoDrop 走同一逻辑。
  // 面板开合/浏览路径经 ref 读取（探针实证 300ms 窗内 hook 重注册竞态——闭包捕获
  // 旧 rightPanel 会借到已关闭面板的路径，违 §354）——同源判别用 ref 不用闭包
  const taskPanelRef = useRef<HTMLElement | null>(null);
  const rightPanelRef = useRef<null | "files" | "collab" | "forwards" | "log">(null);
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
    pushToast("err", "上传已取消：目标会话已切换");
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
    if (!s || !sftpPath) { pushToast("err", "先连接主机并进入一个目录再上传"); return; }
    try {
      const paths = await invoke("pick_upload_files");
      if (!paths.length) return;
      void startUploads(paths, sftpPath, s);
    } catch (e) {
      pushToast("err", `打开文件选择器失败：${friendlyError(e)}`);
    }
  }, [sftpPath, startUploads, pushToast]);

  // 十八轮：会话日志开关——后端 pump tap 落盘（后台输出不漏），路径经 toast 呈现
  const toggleSessionLog = async (s: SessionInfo) => {
    try {
      const r = await invoke("set_session_logging", { sid: s.id, enabled: !s.logging }) as string | null;
      setSessions((cur) => cur.map((x) => (x.id === s.id ? { ...x, logging: !s.logging } : x)));
      if (r) pushToast("ok", `已开始记录会话日志：${r}`);
      else pushToast("info", "已停止记录会话日志");
    } catch (e) {
      pushToast("err", friendlyError(e));
    }
  };

  const openSessionLogFolder = async (sid: string) => {
    try {
      const p = await invoke("session_log_path", { sid }) as string | null;
      if (p) await invoke("reveal_path", { path: p });
      else pushToast("info", "该会话未在记录日志");
    } catch (e) {
      pushToast("err", friendlyError(e));
    }
  };

  const createSession = async (host: Host, intoSplit = false, draft?: HostDraft) => {
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
      const a = await (draft
        ? invoke("begin_connection_draft", { draft, opts: {} })
        : invoke("begin_connection", { hostId: host.id })) as AttemptInfo;
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
          // 十三轮：右键活动标签「复制标签页到右侧」——显式参数直达（无跨点击的挂起
          // 状态，非已退役的预武装模式）：这条连接就是右格，建好即进分屏
          await enterSplitWith(final.session_id);
          await attachSession(final.session_id);
          pushToast("ok", `已连接 ${host.name}（右侧分屏）`);
          return;
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
    if (!sid || delegateBusy || !collabConfigured) return;
    setDelegateBusy(true); setDelegateErr(null);
    try {
      const g = delegateGoal.trim();
      await invoke("delegate_session", { sid, goal: g ? g : null });
      const wasAgent = !!current?.ever_agent_owned;
      closeDelegate();
      await refreshLists();
      void refreshBrief(sid);
      pushToast("info", wasAgent ? "已交还 Agent——后续操作请求走审批" : "已交给 Agent——后续操作请求走审批");
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
      pushToast("info", `协作已停用——作废 ${r.voided_approvals} 个待审批、${r.converted_sessions} 个 Agent 会话转回你控制`);
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
      if (st && st.endpoint) pushToast("ok", "协作已启用——MCP 端点运行中，可签发 Token 接入 Agent");
      else pushToast("err", "协作已启用，但 MCP 端点未运行——Agent 无法接入（请检查端口占用）");
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
      pushToast("info", `停用已收敛——作废 ${r.voided_approvals} 个待审批、${r.converted_sessions} 个 Agent 会话转回你控制`);
    } catch (e) { pushToast("err", friendlyError(e)); }
    finally { setCollabBusy(false); }
  };

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editedCmd, setEditedCmd] = useState("");
  const [confirmId, setConfirmId] = useState<string | null>(null);
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

  // C9（R43）：admission 门只在 Enabled 开放——停用/停用中/停用失败一律按「未启用」对待
  //（失败保持封闭，不得回退为可用）。Disabling/DisableFailed 时主界面不出现空审批区。
  const collabEnabled = collab.state === "Enabled";
  const collabStateText = collab.state === "Enabled" ? "协作已启用"
    : collab.state === "Disabling" ? "停用中"
    : collab.state === "DisableFailed" ? "停用失败（保持封闭）"
    : "协作已停用";
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
  const approvalGroups = (() => {
    const bySid = new Map<string, { sess?: SessionInfo; items: ApprovalRow[] }>();
    for (const a of pendingApprovals) {
      let g = bySid.get(a.session_id);
      if (!g) { g = { sess: sessions.find((x) => x.id === a.session_id), items: [] }; bySid.set(a.session_id, g); }
      g.items.push(a);
    }
    return [...bySid.entries()]
      .map(([sidKey, g]) => ({ sid: sidKey, sess: g.sess, items: g.items }))
      .sort((x, y) => (x.sess?.host_name ?? "￿").localeCompare(y.sess?.host_name ?? "￿", "zh") || x.sid.localeCompare(y.sid));
  })();

  const currentHost = current ? hosts.find((h) => h.id === current.host_id) : undefined;
  // UX 五轮：默认编码 UTF-8 不再上状态条（没有 ssh client 关心默认编码；GBK 例外
  // 保留——乱码排查信号，编码自适应的入口仍在连接详情/主机编辑）
  const sbLeft = current
    ? `${currentHost?.address === "local" ? "本地" : "SSH"}${currentHost?.charset === "gbk" ? " · GBK" : ""}`
    : "未连接";
  // R35 状态条计数=进行中任务（排队/传输/提交/取消中/待决——§194 后台事件只更新计数）
  const runningTransfers = transfers.filter((t) => t.status === "running" || t.status === "queued" || t.status === "committing" || t.status === "cancelling" || t.status === "awaiting").length;
  // §358 队列行须展示「主机/会话」——抽屉是窗口级（list_transfers 全量、跨会话），
  // 会话不再由所在面板隐含，故按 sid 回查主机名；会话已不在时回退短 id（如实不虚构）。
  const hostLabel = (sid?: string): string =>
    !sid ? "—" : sessions.find((s) => s.id === sid)?.host_name ?? sid.slice(0, 8);
  // R35 rev 中-1：重试必须在**在场会话**内重跑（核心 retry_transfer 按旧 session_id
  // 取会话；会话不持久化，重启恢复的 Interrupted 其会话必然已不在 → SessionNotFound）。
  // 故仅当原会话仍在时给「重试」钮，否则如实告知（不渲染必死的钮）；pending- 占位卡
  // 无真实 id 同理（rev 低-1）。
  const canRetry = (t: TransferCard): boolean =>
    !t.id.startsWith("pending-") && !!t.sid && sessions.some((s) => s.id === t.sid);

  // 十九轮：命令面板条目——按当前状态构建（会话/连接/当前会话操作/应用动作）。
  // 置于组件尾部：引用的 handler 全部已初始化（useMemo 渲染期即执行，TDZ 敏感）。
  const paletteItems = useMemo<PaletteItem[]>(() => {
    const items: PaletteItem[] = [];
    const active = sessions.find((x) => x.id === sid);
    const stLabel = (s: SessionInfo) => (s.id === sid ? "当前" : s.state === "Connected" ? "已连接" : s.state === "Disconnected" ? "已断开" : s.state);
    for (const s of sessions) {
      items.push({
        id: "goto-" + s.id, group: "会话",
        title: `切换到 ${tabNames[s.id] ?? s.host_name}`,
        hint: stLabel(s), keywords: s.host_name + " 切换",
        run: () => { void attachSession(s.id).catch((e) => pushToast("err", errMsg(e))); },
      });
    }
    if (hosts.some((h) => h.address === "local" || h.id === "local")) {
      items.push({
        id: "local-term", group: "连接", title: "打开本地终端", hint: "本机 PTY",
        run: () => { const lh = hosts.find((h) => h.id === "local"); if (lh) void createSession(lh); },
      });
    }
    for (const h of hosts) {
      if (h.id === "local") continue;
      items.push({
        id: "conn-" + h.id, group: "连接",
        title: `连接 ${h.name}`,
        hint: `${h.username}@${h.address}:${h.port}`, keywords: h.address + " " + h.username + " 连接",
        run: () => { void createSession(h).catch((e) => pushToast("err", errMsg(e))); },
      });
    }
    items.push({
      id: "quick-connect", group: "连接", title: "快速连接（不存主机，临时连接一次）",
      keywords: "一次性 临时 connect",
      run: () => { if (!hostbarOpen) toggleHostbar(true); setShowQuickConnect(true); setShowAddHost(false); setShowImport(false); },
    });
    if (active) {
      const menuHost = hosts.find((x) => x.id === active.host_id);
      if (menuHost) {
        items.push({
          id: "dup-tab", group: "当前会话", title: `复制标签页（同主机新会话：${menuHost.name}）`,
          run: () => { void createSession(menuHost); },
        });
      }
      items.push({
        id: "rename-tab", group: "当前会话", title: "重命名标签…",
        run: () => setRenaming({ sid: active.id, value: tabNames[active.id] ?? active.host_name }),
      });
      items.push({
        id: "toggle-log", group: "当前会话",
        title: active.logging ? "停止记录会话日志" : "记录会话日志",
        hint: "输出落 data/logs",
        run: () => { void toggleSessionLog(active); },
      });
      if (active.logging) {
        items.push({
          id: "open-log", group: "当前会话", title: "打开日志文件夹",
          run: () => { void openSessionLogFolder(active.id); },
        });
      }
      items.push({
        id: "close-session", group: "当前会话", title: `关闭会话（${tabNames[active.id] ?? active.host_name}）`,
        danger: true, keywords: "关闭 断开",
        run: () => requestCloseSession(active),
      });
    }
    items.push({
      id: "open-settings", group: "应用", title: "打开设置", keywords: "偏好 字号 外观 编码",
      run: () => setShowSettings(true),
    });
    {
      const idx = APPEARANCES.findIndex((a) => a.id === appearance);
      const next = APPEARANCES[(idx + 1 + APPEARANCES.length) % APPEARANCES.length];
      items.push({
        id: "cycle-appearance", group: "应用",
        title: `外观切换为「${next.label}」`, hint: "跟随系统 / 深色 / 浅色 循环",
        keywords: "主题 深浅 暗色 亮色",
        run: () => changeAppearance(next.id),
      });
    }
    items.push({
      id: "toggle-hostbar", group: "应用",
      title: hostbarOpen ? "隐藏主机栏" : "显示主机栏", hint: "⌘B",
      run: () => toggleHostbar(!hostbarOpen),
    });
    items.push({
      id: "import-sshconfig", group: "应用", title: "导入 ~/.ssh/config",
      run: () => { if (!hostbarOpen) toggleHostbar(true); setShowImport(true); setShowAddHost(false); setEditingHost(null); setPrefillEntry(null); },
    });
    return items;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessions, sid, hosts, tabNames, appearance, hostbarOpen, attachSession, createSession, toggleSessionLog, openSessionLogFolder, requestCloseSession, changeAppearance, toggleHostbar]);

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
          {(collabConfigured || collabActive) && (
            <button className={"collab-badge" + (rightPanel === "collab" ? " ts-open" : "") + (collabActive ? " hot" : "")}
              data-testid="collab-entry"
              title={collabActive
                ? `${pendingCount > 0 ? `有 ${pendingCount} 个待审批请求` : "Agent 正在控制会话"}——跨会话操作请逐条核对目标主机`
                : "协作：审批、任务目标与现场简报"}
              onClick={() => setRightPanel(rightPanel === "collab" ? null : "collab")}>
              协作{pendingCount > 0 ? ` · ${pendingCount} 待审批` : collabActive ? " · Agent 活动中" : ""}
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
        {inTauri && isWindowsPlatform() && <WinControls />}
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
          {showQuickConnect && (
            <QuickConnectForm
              onConnect={(display, draft) => {
                setShowQuickConnect(false);
                void createSession(display, false, draft);
              }}
              onCancel={() => setShowQuickConnect(false)}
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
                if (latest) { void attachSession(latest.id).catch((e) => pushToast("err", errMsg(e))); return; }
                createSession(h);
              };
              return (
              <div className="host-card" key={h.id}
                tabIndex={0}
                onContextMenu={(e) => {
                  // 十一轮续：主机卡右键——连接/收藏/编辑/删除，与 hover 操作组同源同义
                  e.preventDefault();
                  e.stopPropagation();
                  setHostMenu({ x: e.clientX, y: e.clientY, hostId: h.id });
                }}
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
          <button className="hb-settings" title="设置（外观 / 终端 / 凭据）" aria-label="设置"
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
              // 十四轮：标签自定名（复制标签页后同名标签的区分），无则回退主机名
              const label = tabNames[s.id] ?? s.host_name;
              return (
                <div
                  key={s.id}
                  className={"tab" + (sid === s.id ? " tab-active" : "") + (inSplit ? " tab-pane" : "")
                    + (bellSids.has(s.id) ? " tab-bell" : "")
                    + (tabDropHint?.sid === s.id ? (tabDropHint.before ? " tab-drop-before" : " tab-drop-after") : "")}
                  draggable={renaming?.sid !== s.id}
                  onDragStart={(e) => {
                    // 十五轮：拖拽排序——dataTransfer 不置数据 Chromium 不发起拖拽
                    dragSidRef.current = s.id;
                    e.dataTransfer.effectAllowed = "move";
                    try { e.dataTransfer.setData("text/plain", s.id); } catch { /* 忽略 */ }
                  }}
                  onDragOver={(e) => {
                    if (!dragSidRef.current || dragSidRef.current === s.id) return;
                    e.preventDefault();
                    e.dataTransfer.dropEffect = "move";
                    const r = e.currentTarget.getBoundingClientRect();
                    setTabDropHint({ sid: s.id, before: e.clientX < r.left + r.width / 2 });
                  }}
                  onDragLeave={() => { setTabDropHint((cur) => (cur?.sid === s.id ? null : cur)); }}
                  onDrop={(e) => {
                    e.preventDefault();
                    const from = dragSidRef.current;
                    const r = e.currentTarget.getBoundingClientRect();
                    if (from && from !== s.id) reorderTabs(from, s.id, e.clientX < r.left + r.width / 2);
                    dragSidRef.current = null;
                    setTabDropHint(null);
                  }}
                  onDragEnd={() => { dragSidRef.current = null; setTabDropHint(null); }}
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
                  onClick={() => void attachSession(s.id).catch((e) => pushToast("err", errMsg(e)))}
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
                      aria-label="重命名标签"
                      onChange={(e) => setRenaming({ sid: s.id, value: e.target.value })}
                      onClick={(e) => e.stopPropagation()}
                      onMouseDown={(e) => e.stopPropagation()}
                      onDoubleClick={(e) => e.stopPropagation()}
                      onKeyDown={(e) => {
                        // 编辑框内按键不冒泡（Enter/Space 会被标签 onKeyDown 抢成激活）
                        e.stopPropagation();
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
                    title={splitPanes ? "放到右侧分屏" : s.id === sid ? "已在主视图" : "与当前会话分屏"}
                    aria-label={splitPanes ? `把 ${s.host_name} 放到右侧分屏` : s.id === sid ? `${s.host_name} 已在主视图` : `与 ${s.host_name} 分屏`}
                    onClick={(e) => { e.stopPropagation(); void enterSplitWith(s.id); }}
                  ><IconSplit size={12} /></button>
                  <button
                    type="button"
                    className="tab-x"
                    title="关闭会话（⌘/Ctrl+W，活动会话先确认影响）"
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
          {/* 十九轮：命令面板入口（⌘K / Ctrl+K 的可发现锚点） */}
          <button className="ghost" title="命令面板（Ctrl+K / ⌘K）" aria-label="命令面板" data-testid="palette-open"
            onClick={() => setPaletteOpen(true)}><IconSearch size={14} /></button>
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
          <button className="ghost" title="新建连接（Ctrl+T）" aria-label="新建连接" onClick={() => { if (!hostbarOpen) toggleHostbar(true); setShowAddHost(!showAddHost); setShowImport(false); setShowQuickConnect(false); }}><IconPlus size={14} /></button>
          {/* 十七轮：快速连接——不存主机一次性建连 */}
          <button className="ghost" title="快速连接（不保存主机，临时连接一次）" aria-label="快速连接" data-testid="quick-connect-open" onClick={() => { if (!hostbarOpen) toggleHostbar(true); setShowQuickConnect(true); setShowAddHost(false); setShowImport(false); }}><IconTerminal size={14} /></button>
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
        {/* R42（§6.7）首次委托 / 交还对话框：主机、会话、能力、现有授权范围 → 明确提交。
            「现有授权范围」只陈述核心能保证的（逐条审批 + 控制权是角色），不承诺某一
            Agent 独占。服务未启用时提交钮禁用并引导设置接入，返回后仍须单独确认。 */}
        {delegateDlg && current && (
          <div className="confirm-mask" onClick={closeDelegate}>
            <div className="confirm-dialog delegate-dlg" role="dialog" aria-modal="true"
              ref={delegateDlgRef}
              aria-labelledby="dlg-delegate-title" data-testid="delegate-dlg" onClick={(e) => e.stopPropagation()}>
              <div className="hk-title" id="dlg-delegate-title">
                {current.ever_agent_owned ? `交还 ${current.host_name} 给 Agent？` : `把 ${current.host_name} 交给 Agent？`}
              </div>
              <div className="dim" style={{ fontSize: 12 }}>
                Agent 持有控制权期间，它的每个操作仍逐条经你审批；你随时可以接管（接管会作废尚未开始的请求）。
              </div>
              <div className="dlg-facts">
                <div className="fact"><span className="dim">主机</span> <b>{current.host_name}</b>{" "}
                  <span className="mono dim">{currentHost?.address && currentHost.address !== "local" ? `${currentHost.address}:${currentHost.port}` : "本机"}</span></div>
                <div className="fact"><span className="dim">会话</span> <span className="mono">{current.id.slice(0, 12)}</span>{" "}
                  <span className={"mono " + stateLabel(current.state).cls} style={{ fontSize: 11 }}>{stateLabel(current.state).text}</span></div>
                <div className="fact"><span className="dim">能力</span>{" "}
                  {delegateCap === null ? <span className="dim">查询中…</span>
                    : delegateCap.integration_present && delegateCap.prompt_ready
                      ? <span>持久 Shell 可用——Agent 可在当前目录与环境执行</span>
                      : <span className="warn">无持久 Shell——委托后 Agent 只能走 exec 模式（不继承当前目录/环境）</span>}</div>
                <div className="fact"><span className="dim">现有授权范围</span>{" "}
                  {collabConfigured
                    ? <span>已接入 {mcp.agents.map((a) => a.label).join("、")}；所有操作逐条审批（控制权是角色，不承诺某一 Agent 独占）</span>
                    : <span className="warn">尚未登记任何 Agent</span>}</div>
              </div>
              <div className="ts-label" style={{ marginTop: 10 }}>任务目标（可选）</div>
              <textarea className="goal-input" rows={2} value={delegateGoal}
                aria-label="任务目标（可选）"
                placeholder="写给 Agent 的委托留言，例：把日志打包放到 /tmp 后交还给我"
                onChange={(e) => setDelegateGoal(e.target.value)} />
              <div className="dim" style={{ fontSize: 11, marginTop: 4 }}>
                留空也可以转交；留空不会清除会话上已有的目标。
              </div>
              {delegateErr && <div className="err" style={{ marginTop: 6, fontSize: 12 }} data-testid="delegate-err">✕ {delegateErr}</div>}
              {!collabConfigured && (
                <div className="side-quiet" data-testid="delegate-unconfigured">
                  协作服务未启用——先到「设置 → Agent 接入」登记 Agent。返回后仍需在此单独确认转交。
                  <div style={{ marginTop: 6 }}>
                    <button className="ghost" data-testid="delegate-open-settings"
                      onClick={() => { closeDelegate(); openSettingsAt("agent"); }}>打开设置 → Agent 接入</button>
                  </div>
                </div>
              )}
              <div className="hk-actions">
                <button data-testid="delegate-submit" disabled={!collabConfigured || delegateBusy}
                  onClick={() => void submitDelegate()}>
                  {delegateBusy ? "提交中…" : current.ever_agent_owned ? "交还 Agent" : "交给 Agent"}
                </button>
                <button className="ghost" data-autofocus onClick={closeDelegate}>取消</button>
              </div>
            </div>
          </div>
        )}
        {/* C9（R43）停用影响预览对话框：先预览 → 确认后核心原子封 admission。
            明确披露「运行中任务不自动终止」「重新启用不复活旧请求」，不承诺全清。 */}
        {disableImpact && (
          <div className="confirm-mask" onClick={() => setDisableImpact(null)}>
            <div className="confirm-dialog" role="dialog" aria-modal="true"
              aria-labelledby="dlg-disable-collab-title" data-testid="collab-disable-dlg" onClick={(e) => e.stopPropagation()}>
              <div className="hk-title" id="dlg-disable-collab-title">停用协作？</div>
              <div className="dim" style={{ fontSize: 12 }}>
                确认后立即封闭入口——新 Agent 请求一律被拒绝，不等待你逐个接管；已有请求在执行开始前核对停用代际，作废留痕，不会因旧审批决定继续执行。
              </div>
              <div className="dlg-facts">
                <div className="fact"><span className="dim">受影响的 Agent 会话</span> <b data-testid="collab-impact-sessions">{disableImpact.agent_owned_sessions}</b>{" "}
                  <span className="dim">（转为你的控制，不自动终止已开始的任务）</span></div>
                <div className="fact"><span className="dim">待审批请求</span> <b data-testid="collab-impact-approvals">{disableImpact.pending_approvals}</b> <span className="dim">（作废）</span></div>
                <div className="fact"><span className="dim">已配置 Agent</span> <b data-testid="collab-impact-agents">{disableImpact.configured_agents}</b> <span className="dim">（身份与 Token 保留）</span></div>
              </div>
              <div className="side-quiet">
                运行中的 Agent 任务不会被自动终止；应用拥有的 MCP 端点随之停止（外部 shim 是独立进程，不受影响）。重新启用须显式操作，先前作废的请求不会复活。
              </div>
              <div className="hk-actions">
                <button data-testid="collab-disable-confirm" disabled={collabBusy} onClick={() => void confirmDisable()}>
                  {collabBusy ? "停用中…" : "确认停用"}
                </button>
                <button className="ghost" data-autofocus data-testid="collab-disable-cancel" onClick={() => setDisableImpact(null)}>取消</button>
              </div>
            </div>
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
                会话不跨启动保留——下次启动可在欢迎页「重连上次会话」一键恢复届时仍打开的主机。
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
            {sid && collabConfigured && owner === "Human" && (
              <button
                className="ghost"
                data-testid="delegate-open"
                title={current?.ever_agent_owned
                  ? "交还会话：Agent 恢复操作（后续请求重新走审批）。已作废的请求不会自动重发——Agent 会收到作废通知，由它决定是否重新提交"
                  : "首次委托：把会话交给 Agent 执行。需在对话框中查看主机/会话/能力与现有授权范围后明确提交；取消不改动控制权"}
                onClick={() => openDelegate()}
              >{current?.ever_agent_owned ? "交还 Agent" : "交给 Agent…"}</button>
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
              title={splitPanes ? "退出分屏（Ctrl+D；会话保留不断开）" : "分屏（Ctrl+D）：在右侧显示已有会话，或在右侧新建会话"}
              aria-haspopup={splitPanes ? undefined : "menu"}
              aria-expanded={splitPanes ? undefined : splitMenu}
              aria-pressed={!!splitPanes}
              onClick={() => {
                if (splitPanes) { void exitSplit(); return; }
                setSplitMenu((v) => !v);
              }}
            ><IconSplit size={15} /></button>
            <button
              className={"ghost st-collab" + (rightPanel === "collab" ? " ts-open" : "")}
              data-testid="tools-collab"
              aria-pressed={rightPanel === "collab"}
              title="协作：审批、任务目标与现场简报（有 Agent 活动时必须可达）"
              onClick={() => setRightPanel(rightPanel === "collab" ? null : "collab")}
            ><IconInbox size={14} />协作</button>
            <button
              className={"ghost st-file" + (rightPanel === "files" ? " ts-open" : "")}
              aria-pressed={rightPanel === "files"}
              title="文件：远程目录浏览与传输"
              onClick={() => setRightPanel(rightPanel === "files" ? null : "files")}
            ><IconFolder size={14} />文件</button>
            <div className="st-tools" ref={toolsRef}>
              <button className="ghost" aria-haspopup="menu" aria-expanded={toolsOpen}
                onClick={() => setToolsOpen(!toolsOpen)}>工具<IconChevronDown size={12} /></button>
              {toolsOpen && (
                <div className="tools-menu" role="menu">
                  {/* §3.2：「连接工具」菜单只放连接详情、端口转发、活动记录、关闭会话；
                      协作是会话工作区下的**同级**入口（见工具栏「协作」钮），不塞进本菜单 */}
                  <button role="menuitem" data-testid="tools-conn-detail" onClick={() => { setToolsOpen(false); openSessionDetail(current); }}>连接详情…</button>
                  <button role="menuitem" onClick={() => { setRightPanel("forwards"); setToolsOpen(false); }}>端口转发</button>
                  {/* 十八轮：会话日志开关（工具菜单与标签右键同源同义） */}
                  <button role="menuitem" data-testid="tools-session-log" onClick={() => { setToolsOpen(false); void toggleSessionLog(current); }}>{current.logging ? "停止记录会话日志" : "记录会话日志"}</button>
                  <button role="menuitem" data-testid="tools-activity" onClick={() => { setRightPanel("log"); setToolsOpen(false); }}>活动记录</button>
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
                  <div><span className="ws-k">传输</span>拖文件进窗口上传：拖到文件面板直接传到正在浏览的目录，拖到终端先确认目标</div>
                </div>
                <div className="welcome-actions">
                  <button onClick={() => { if (!hostbarOpen) toggleHostbar(true); setShowAddHost(true); setShowImport(false); setShowQuickConnect(false); setEditingHost(null); setPrefillEntry(null); }}><IconPlus size={13} /> 添加主机</button>
                  <button className="ghost" onClick={() => { if (!hostbarOpen) toggleHostbar(true); setShowQuickConnect(true); setShowAddHost(false); setShowImport(false); }}><IconTerminal size={13} /> 快速连接</button>
                  <button className="ghost" onClick={() => { if (!hostbarOpen) toggleHostbar(true); setShowImport(true); setShowAddHost(false); }}>导入 ~/.ssh/config</button>
                  {hosts.some((h) => h.id === "local") && (
                    <button className="ghost" onClick={() => {
                      const lh = hosts.find((h) => h.id === "local");
                      if (lh) void createSession(lh);
                    }}><IconTerminal size={13} /> 打开本地终端</button>
                  )}
                </div>
                {/* 十五轮：重连上次会话——上次退出/刷新时仍打开的主机（去重有序），
                    一键全部重连（点了才连，不自动拨号）。主机已删的行整体过滤 */}
                {!sid && sessions.length === 0 && lastSessionHosts.length > 0 && (() => {
                  const rowsH = lastSessionHosts.flatMap((hid) => hosts.find((h) => h.id === hid) ?? []);
                  if (rowsH.length === 0) return null;
                  return (
                    <div className="welcome-recents" aria-label="上次会话">
                      <div className="wr-title">上次会话</div>
                      <button className="wr-row" data-testid="reconnect-last"
                        title={`重连 ${rowsH.map((h) => h.name).join("、")}`}
                        onClick={() => { for (const h of rowsH) void createSession(h); }}>
                        <span className="wr-name">⟳ 重连上次会话（{rowsH.length}）</span>
                        <span className="wr-addr">{rowsH.map((h) => h.name).join("、")}</span>
                        <span className="wr-go">连接</span>
                      </button>
                    </div>
                  );
                })()}
                {/* R20（§259）：已有主机但无会话 → 最近连接（后端派生、排除 local、上限 5）。
                    仅在欢迎页呈现（§261：避免每次连接使侧栏重排）；点击即建连。
                    rev-r20 L5：行全部失效（主机刚删的毫秒窗）时不渲染空标题块 */}
                {!sid && sessions.length === 0 && recents.length > 0 && (() => {
                  // 本轮：隐藏偏好先滤再截 5（隐藏行不占坑）；右键出操作菜单
                  const rows = recents
                    .filter((r) => !recentsHidden.includes(r.host_id))
                    .slice(0, 5)
                    .map((r) => {
                    const rh = hosts.find((x) => x.id === r.host_id);
                    if (!rh) return null;
                    return (
                      <button key={r.host_id} className="wr-row"
                        title={`连接 ${r.host_name}（${rh.username}@${rh.address}）；右键更多操作`}
                        onClick={() => void createSession(rh)}
                        onContextMenu={(e) => { e.preventDefault(); setRecentMenu({ x: e.clientX, y: e.clientY, hostId: r.host_id }); }}>
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
          <div id="term" ref={termRef} onContextMenu={(e) => {
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
          }} />
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
            <div className="attach-hint">会话已接入——点击终端区直接打字</div>
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
                <div className="dim" style={{ fontSize: 11, lineHeight: 1.6, padding: "6px 2px 0" }}>
                  新建的会话先落在标签栏——右键标签选「与当前会话分屏」即可。
                </div>
              </div>
            </>
          )}
          {/* 十一轮：标签右键菜单——对象先存在、操作跟上来。fixed 定位跟随指针并夹在
              视口内；遮罩点击/右键都关闭；会话关闭后菜单自动只剩遮罩（点掉即净） */}
          {tabMenu && (() => {
            const s = sessions.find((x) => x.id === tabMenu.sid);
            const mx = Math.min(tabMenu.x, window.innerWidth - 248);
            const my = Math.min(tabMenu.y, window.innerHeight - 236);
            const close = () => setTabMenu(null);
            const inSplit = !!s && (splitPanes?.main === s.id || splitPanes?.second === s.id);
            const menuHost = s ? hosts.find((h) => h.id === s.host_id) : undefined;
            return (
              <>
                <div className="pop-mask" onClick={close} onContextMenu={(e) => { e.preventDefault(); close(); }} />
                {s && (
                  <div className="ctx-menu" role="menu" aria-label={`会话操作：${s.host_name}`} style={{ left: mx, top: my }}>
                    {inSplit ? (
                      <button className="ghost sm-item" role="menuitem"
                        onClick={() => { close(); void exitSplit(); }}
                      >退出分屏（两个会话都保留）</button>
                    ) : s.id !== sid && !!sid ? (
                      <button className="ghost sm-item" role="menuitem"
                        onClick={() => { close(); void enterSplitWith(s.id); }}
                      >{splitPanes ? "放到右侧分屏（替换右格）" : "与当前会话分屏（放到右侧）"}</button>
                    ) : s.id === sid && sessions.some((x) => x.id !== s.id) ? (
                      // 十二轮：活动标签也得分屏（Xshell/Windows Terminal 惯例）——
                      // 第二格是谁交给既有「右侧会话选择」菜单，不在此复制会话列表
                      <button className="ghost sm-item" role="menuitem"
                        onClick={() => { close(); setSplitMenu(true); }}
                      >分屏（选择右侧会话）…</button>
                    ) : s.id === sid && menuHost ? (
                      // 十三轮：唯一会话也有分屏——复制本标签到右侧（新会话），Windows
                      // Terminal "Split Tab" 语义；显式参数直达，无预武装挂起态
                      <button className="ghost sm-item" role="menuitem"
                        title="新建一条同主机连接并放入右侧窗格（当前会话留在左侧）"
                        onClick={() => { close(); createSession(menuHost, true); }}
                      >分屏：复制标签页到右侧（新会话）</button>
                    ) : null}
                    {autoReconn?.sid === s.id ? (
                      <button className="ghost sm-item" role="menuitem"
                        onClick={() => { close(); void stopRetry(s); }}
                      >停止自动重连</button>
                    ) : s.state === "Disconnected" ? (
                      <button className="ghost sm-item" role="menuitem"
                        onClick={() => { close(); void reconnectSession(s); }}
                      >重连会话</button>
                    ) : null}
                    {menuHost && (
                      <button className="ghost sm-item" role="menuitem"
                        title="用同一台主机新建一条会话（现有会话不受影响）"
                        onClick={() => { close(); void createSession(menuHost); }}
                      >复制标签页（同主机新会话）</button>
                    )}
                    <button className="ghost sm-item" role="menuitem"
                      title="自定义标签显示名（清空恢复主机名）；也可双击标签"
                      onClick={() => { close(); setRenaming({ sid: s.id, value: tabNames[s.id] ?? s.host_name }); }}
                    >重命名标签…</button>
                    {/* 十八轮：会话日志——pump tap 落盘，开关态随 SessionInfo 下发不漂移 */}
                    <button className="ghost sm-item" role="menuitem" data-testid="ctx-session-log"
                      title="把该会话收到的全部输出记录到本地日志文件（data/logs 目录，追加写入）"
                      onClick={() => { close(); void toggleSessionLog(s); }}
                    >{s.logging ? "停止记录会话日志" : "记录会话日志"}</button>
                    {s.logging && (
                      <button className="ghost sm-item" role="menuitem" data-testid="ctx-session-log-open"
                        onClick={() => { close(); void openSessionLogFolder(s.id); }}
                      >打开日志文件夹</button>
                    )}
                    <div className="ctx-menu-sep" role="separator" />
                    <button className="ghost sm-item" role="menuitem"
                      onClick={() => { close(); void openSessionDetail(s); }}
                    >连接详情…</button>
                    <button className="ghost sm-item" role="menuitem"
                      onClick={() => { close(); requestCloseSession(s); }}
                    >关闭会话…</button>
                  </div>
                )}
              </>
            );
          })()}
          {/* 十一轮续：主机卡右键——与 hover 操作组同源同义（连接/收藏/编辑/删除） */}
          {hostMenu && (() => {
            const h = hosts.find((x) => x.id === hostMenu.hostId);
            const mx = Math.min(hostMenu.x, window.innerWidth - 248);
            const my = Math.min(hostMenu.y, window.innerHeight - 200);
            const close = () => setHostMenu(null);
            const fav = metaById.get(hostMenu.hostId)?.favorite === true;
            return (
              <>
                <div className="pop-mask" onClick={close} onContextMenu={(e) => { e.preventDefault(); close(); }} />
                {h && (
                  <div className="ctx-menu" role="menu" aria-label={`主机操作：${h.name}`} style={{ left: mx, top: my }}>
                    {!connectingIds.has(h.id) && (
                      <button className="ghost sm-item" role="menuitem"
                        onClick={() => { close(); createSession(h); }}
                      >连接（新建会话）</button>
                    )}
                    <button className="ghost sm-item" role="menuitem"
                      onClick={() => { close(); void toggleFavorite(h.id, !fav); }}
                    >{fav ? "取消收藏" : "收藏（置顶分组）"}</button>
                    <div className="ctx-menu-sep" role="separator" />
                    <button className="ghost sm-item" role="menuitem"
                      onClick={() => { close(); setEditingHost(h); setShowImport(false); setPrefillEntry(null); setShowAddHost(true); }}
                    >编辑主机…</button>
                    <button className="ghost sm-item" role="menuitem"
                      onClick={() => { close(); setConfirm({ kind: "deleteHost", id: h.id, name: h.name }); }}
                    >删除主机…</button>
                  </div>
                )}
              </>
            );
          })()}
          {/* 十一轮续：终端区右键——复制（仅选区在场）/粘贴/全选，作用于命中的窗格；
              粘贴语义收口在 pasteTextInto（⌘V 同源：bracketed paste + 多行确认契约） */}
          {termMenu && (() => {
            const en = termsRef.current.get(termMenu.sid);
            const mx = Math.min(termMenu.x, window.innerWidth - 200);
            const my = Math.min(termMenu.y, window.innerHeight - 236);
            const close = () => setTermMenu(null);
            return (
              <>
                <div className="pop-mask" onClick={close} onContextMenu={(e) => { e.preventDefault(); close(); }} />
                {en && (
                  <div className="ctx-menu" role="menu" aria-label="终端操作" style={{ left: mx, top: my }}>
                    {termMenu.hasSel && (
                      <button className="ghost sm-item" role="menuitem"
                        onClick={() => {
                          close();
                          const sel = en.term.getSelection();
                          if (sel) (inTauri ? clipboard.writeText(sel) : navigator.clipboard?.writeText(sel)).catch(() => {});
                        }}
                      >复制</button>
                    )}
                    <button className="ghost sm-item" role="menuitem"
                      onClick={() => {
                        close();
                        (inTauri
                          ? clipboard.readText().then((t) => pasteTextIntoRef.current(en.term, termMenu.sid, t))
                          : navigator.clipboard?.readText().then((t) => pasteTextIntoRef.current(en.term, termMenu.sid, t))
                        ).catch(() => {});
                      }}
                    >粘贴</button>
                    <button className="ghost sm-item" role="menuitem"
                      onClick={() => { close(); en.term.selectAll(); }}
                    >全选</button>
                    <div className="ctx-menu-sep" role="separator" />
                    <button className="ghost sm-item" role="menuitem"
                      onClick={() => {
                        close();
                        // 十四轮：查找作用于右键命中的窗格——非活动会话先切过去再开搜索框
                        // （分屏副格命中时同样成立）；切失败也开（断开现场仍可搜冻结缓冲）
                        const open = () => { setSearchOpen(true); setTimeout(() => searchInputRef.current?.focus(), 0); };
                        if (sidRef.current === termMenu.sid) open();
                        else void attachSession(termMenu.sid).then(open).catch(() => open());
                      }}
                    >查找…</button>
                    <button className="ghost sm-item" role="menuitem"
                      onClick={() => { close(); en.term.clear(); }}
                    >清屏</button>
                  </div>
                )}
              </>
            );
          })()}
          {/* 本轮：最近连接行右键——与主机卡菜单同源同义（连接/编辑/删除），
              加「从最近连接隐藏」（纯前端偏好；重连自动恢复，createSession 统一钩子） */}
          {recentMenu && (() => {
            const h = hosts.find((x) => x.id === recentMenu.hostId);
            const mx = Math.min(recentMenu.x, window.innerWidth - 248);
            const my = Math.min(recentMenu.y, window.innerHeight - 200);
            const close = () => setRecentMenu(null);
            return (
              <>
                <div className="pop-mask" onClick={close} onContextMenu={(e) => { e.preventDefault(); close(); }} />
                {h && (
                  <div className="ctx-menu" role="menu" aria-label={`最近连接操作：${h.name}`} style={{ left: mx, top: my }}>
                    <button className="ghost sm-item" role="menuitem"
                      onClick={() => { close(); void createSession(h); }}
                    >连接（新建会话）</button>
                    <button className="ghost sm-item" role="menuitem"
                      onClick={() => { close(); setEditingHost(h); setShowImport(false); setPrefillEntry(null); setShowAddHost(true); }}
                    >编辑主机…</button>
                    <button className="ghost sm-item" role="menuitem"
                      onClick={() => { close(); setRecentHidden(h.id, true); }}
                    >从最近连接隐藏</button>
                    <div className="ctx-menu-sep" role="separator" />
                    <button className="ghost sm-item" role="menuitem"
                      onClick={() => { close(); setConfirm({ kind: "deleteHost", id: h.id, name: h.name }); }}
                    >删除主机…</button>
                  </div>
                )}
              </>
            );
          })()}
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
          {pendingDrop && (
            // R33 §354 终端拖入确认：目标会话在拖放开始时固定（切标签即失效，见 effect）；
            // 目录输入预填可信 cwd（无可信不借用不可见面板路径）；确认=按固定会话上传
            <div className="confirm-mask" onClick={() => setPendingDrop(null)}>
              <div className="confirm-dialog" ref={dropCardRef} role="dialog" aria-modal="true" aria-labelledby="dlg-drop-title"
                onKeyDown={(e) => { if (e.key === "Escape") setPendingDrop(null); }}
                onClick={(e) => e.stopPropagation()}>
                <div className="hk-title" id="dlg-drop-title">
                  上传到 {sessionsRef.current.find((x) => x.id === pendingDrop.sid)?.host_name ?? "该会话"}：
                </div>
                <div className="row" style={{ gap: 6 }}>
                  <input
                    className="mono" data-testid="drop-dir-input" data-autofocus
                    style={{ flex: 1 }} aria-label="远端目标目录"
                    placeholder={pendingDropDir ? "" : "远端目录（绝对路径，必填）"}
                    value={pendingDropDir}
                    onChange={(e) => setPendingDropDir(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter" && pendingDropDir.trim()) confirmDropUpload(); }}
                  />
                </div>
                <div className="dim" style={{ marginTop: 6, fontSize: 12 }} data-testid="drop-files-line">
                  {pendingDrop.paths.length} 个文件：{pendingDrop.paths.slice(0, 3).map((p) => pathBasename(p)).join("、")}
                  {pendingDrop.paths.length > 3 ? ` 等 ${pendingDrop.paths.length} 个` : ""}
                </div>
                {!briefRef.current?.cwd && (
                  <div className="dim" style={{ marginTop: 4, fontSize: 12 }} data-testid="drop-no-cwd-hint">
                    该会话无可信工作目录（shell 集成未上报 cwd）——请填写远端目录。
                  </div>
                )}
                {pendingDropErr && (
                  <div className="err" style={{ marginTop: 4, fontSize: 12 }} data-testid="drop-err">{pendingDropErr}</div>
                )}
                <div className="hk-actions">
                  <button className="ghost" onClick={() => setPendingDrop(null)}>取消</button>
                  <button data-testid="drop-confirm" disabled={!pendingDropDir.trim()} onClick={confirmDropUpload}>上传到此处</button>
                </div>
              </div>
            </div>
          )}
          {/* R41（§6.6/S09）连接详情：**独立可关闭对话框**（§193——不与审批共用长滚动页）。
              展示连接**当时**的身份快照（§6.1：主机配置此后被改/删都不影响），
              session ID 收在「技术详情」里可复制。 */}
          {(detail || detailErr) && (() => {
            return (
              <>
                <div className="pop-mask" onClick={closeDetail} />
                <div className="term-settings conn-detail" ref={detailPanelRef} role="dialog" aria-modal="true"
                  aria-label="连接详情" data-testid="conn-detail">
                  <div className="cd-head">
                    <b>连接详情</b>
                    {detail && <span className={"chip " + stateLabel(detail.state).cls}>{stateLabel(detail.state).text}</span>}
                    {detail?.control_owner === "Agent" && <span className="badge agent">Agent 控制</span>}
                    <span style={{ flex: 1 }} />
                    <button className="ghost icon-btn" aria-label="关闭连接详情" data-testid="cd-close"
                      onClick={closeDetail}><IconX size={14} /></button>
                  </div>
                  {detailErr ? (
                    <div className="empty" data-testid="cd-err">{detailErr}</div>
                  ) : detail && (
                    <>
                      <div className="cd-grid">
                        <div className="cd-k">主机</div><div className="cd-v" data-testid="cd-host">{detail.host_name}</div>
                        <div className="cd-k">用户</div><div className="cd-v" data-testid="cd-user">{detail.username}</div>
                        <div className="cd-k">地址</div><div className="cd-v" data-testid="cd-addr">{detail.address}</div>
                        <div className="cd-k">端口</div><div className="cd-v" data-testid="cd-port">{detail.port}</div>
                        <div className="cd-k">认证类型</div><div className="cd-v" data-testid="cd-auth">
                          {detail.auth_type === "Key" ? "密钥" : detail.auth_type === "Agent" ? "SSH Agent"
                            : detail.auth_type === "KeyboardInteractive" ? "键盘交互" : "密码"}
                        </div>
                        <div className="cd-k">指纹</div><div className="cd-v cd-fp" data-testid="cd-fp">
                          {detail.fingerprint ?? <span className="dim">未记录（首次连接确认前）</span>}
                        </div>
                        <div className="cd-k">编码</div><div className="cd-v" data-testid="cd-charset">
                          {detail.charset === "gbk" ? "GBK" : "UTF-8"}
                        </div>
                        <div className="cd-k">创建时间</div><div className="cd-v" data-testid="cd-created">
                          {stampLocal(detail.created_at)}（{TZ_NOTE}）
                        </div>
                      </div>
                      <div className="cd-sec">
                        <h4>技术详情</h4>
                        <div className="cd-sidrow">
                          <span className="cd-k">会话 ID</span>
                          <code data-testid="cd-sid">{detail.id}</code>
                          <button className="ghost" data-testid="cd-copy"
                            onClick={() => {
                              (inTauri ? clipboard.writeText(detail.id) : navigator.clipboard?.writeText(detail.id))
                                .then(() => pushToast("ok", "会话 ID 已复制"))
                                .catch(() => pushToast("err", "复制失败——请手动选中复制"));
                            }}>复制</button>
                        </div>
                      </div>
                      <div className="dim cd-hint">
                        以上为连接时的身份快照——主机配置此后被修改或删除，都不影响这里显示的信息。
                      </div>
                    </>
                  )}
                </div>
              </>
            );
          })()}
          {showSettings && (
            <>
              <div className="pop-mask" onClick={closeSettings} />
              <div className="term-settings settings-wide" ref={settingsPanelRef} role="dialog" aria-modal="true" aria-label="设置">
                {/* 二十一轮：大气化——标题行带副题，导航带图标与一句话定位，内容卡片分区 */}
                <div className="settings-head">
                  <div className="settings-head-txt">
                    <b className="settings-title">设置</b>
                    <span className="settings-sub">外观、终端与凭据——预览即时生效，凭据显式提交</span>
                  </div>
                  <span style={{ flex: 1 }} />
                  <button className="ghost" title="关闭" aria-label="关闭设置" data-testid="settings-close" onClick={closeSettings}><IconX size={13} /></button>
                </div>
                {/* §231：单个对话框，左分类 + 右内容；外观/终端偏好即时预览，凭据显式提交 */}
                <div className="settings-body">
                  <nav className="settings-nav" role="tablist" aria-label="设置分类">
                    {SETTINGS_CATS.map(([id, label, desc]) => {
                      const Ic = settingsCatIcon[id];
                      return (
                        <button key={id} role="tab" data-testid={`settings-cat-${id}`}
                          aria-selected={settingsCat === id} className={settingsCat === id ? "on" : ""}
                          onClick={() => switchSettingsCat(id)}>
                          <span className="set-ic"><Ic size={15} /></span>
                          <span className="set-nav-txt">
                            <span>{label}</span>
                            <span className="set-nav-desc">{desc}</span>
                          </span>
                        </button>
                      );
                    })}
                  </nav>
                  <div className="settings-pane" role="tabpanel" data-testid={`settings-pane-${settingsCat}`}>
                {settingsCat === "appearance" && (<>
                {/* 二十二轮：卡片收紧 + 主题统一——外观两卡（应用外观/字号与缩放）；
                    终端配色不再单独成卡，由色板×深浅派生（ui.theme 双轨退役） */}
                <div className="set-card">
                  <h4>应用外观</h4>
                  <div className="set-desc">主题同时决定应用外壳与终端配色（底色/前景/光标/ANSI 16 色全部随当前色板与深浅派生，终端八色按族调相）；主按钮与指示件走鲜艳填充档（浅色下不再为可读性压暗）；「跟随系统」随系统深浅实时切换。</div>
                  <div className="row ts-appearance" role="group" aria-label="应用外观">
                    {APPEARANCES.map((a) => (
                      <button key={a.id} className={"ghost" + (appearance === a.id ? " ts-active" : "")}
                        aria-pressed={appearance === a.id}
                        onClick={() => changeAppearance(a.id)}>{a.label}</button>
                    ))}
                  </div>
                  <div className="ts-label" style={{ marginTop: 14 }}>主题</div>
                  <div className="ts-themes cols3" role="group" aria-label="主题">
                    {PALETTES.map((p) => (
                      <button
                        key={p.id}
                        data-testid={`chrome-palette-${p.id}`}
                        className={"ghost ts-opt" + (palette === p.id ? " ts-active" : "")}
                        aria-pressed={palette === p.id}
                        onClick={() => changePalette(p.id)}
                      >
                        <span className="ts-swatch" aria-hidden="true">
                          <i style={{ background: `linear-gradient(135deg, ${p.dot[1]}, ${p.dot[0]})` }} />
                          <i style={{ background: `linear-gradient(135deg, ${p.lite[1]}, ${p.lite[0]})` }} />
                        </span>
                        {p.label}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="set-card">
                  <h4>字号与缩放</h4>
                  <div className="set-desc">字号作用于全部终端；缩放作用于整个界面（webview）。</div>
                  <div className="row">
                    <button className="ghost" title="减小字号" aria-label="减小字号" disabled={fontSize <= FONT_MIN} onClick={() => changeFontSize(fontSize - 1)}><IconMinus size={13} /></button>
                    <span className="ts-val mono">{fontSize}</span>
                    <button className="ghost" title="增大字号" aria-label="增大字号" disabled={fontSize >= FONT_MAX} onClick={() => changeFontSize(fontSize + 1)}><IconPlus size={13} /></button>
                    <button className="ghost" disabled={fontSize === FONT_DEFAULT} onClick={() => changeFontSize(FONT_DEFAULT)}>重置</button>
                  </div>
                  {/* UX 五轮：整页缩放（参考 tiny-worker）——webview 缩放，浏览器 demo
                      不渲染（浏览器自带缩放；zoom.ts 亦不注册键盘/滚轮路径） */}
                  {inTauri && (<>
                  <div className="ts-label" style={{ marginTop: 12 }}>界面缩放</div>
                  <div className="row" style={{ marginTop: 4 }}>
                    <select value={zoomLevel} aria-label="界面缩放"
                      onChange={(e) => setZoomScale(Number(e.target.value))}>
                      {[...new Set([...ZOOM_LEVELS, zoomLevel])].sort((a, b) => a - b).map((z) => (
                        <option key={z} value={z}>{Math.round(z * 100)}%</option>
                      ))}
                    </select>
                    <button className="ghost" disabled={zoomLevel === 1} onClick={() => zoomReset()}>重置</button>
                  </div>
                  </>)}
                  <div className="dim" style={{ marginTop: 8, fontSize: 11 }}>界面缩放：Ctrl/⌘ + 放大 · − 缩小 · 0 复位 · Ctrl+滚轮（原生窗口生效）</div>
                </div>
                </>)}

                {settingsCat === "keys" && (<>
                {/* 键位配置轮：六个可重绑动作 + 固定键位说明。录入=点修改后按组合；
                    冲突拒绝、单条重置；表持久化 ui.keymap.v1（demo=localStorage） */}
                <div className="set-card">
                  <h4>应用快捷键</h4>
                  <div className="set-desc">点「修改」后按下新组合（Ctrl/⌘ + 字母，可加 Shift），Esc 取消。被占用的字母不再发往终端——同名 shell 控制键让位（如 Ctrl+D=分屏后，EOF 请用 exit）。Ctrl+1-9 切换标签 · Ctrl+Tab 循环 · Ctrl/⌘ ±/0 缩放 · Esc 关浮层为固定键位。</div>
                  <div className="km-rows" role="group" aria-label="快捷键绑定">
                    {KEYMAP_ACTIONS.map(({ id, label, desc }) => {
                      const capturing = keyCapture === id;
                      return (
                        <div className="km-row" key={id} data-testid={`keymap-row-${id}`}>
                          <span className="km-name">
                            <b>{label}</b>
                            <span className="set-item-desc">{desc}</span>
                          </span>
                          <span className="km-key mono" data-testid={`keymap-key-${id}`}>
                            {capturing ? "按下新组合…" : formatBinding(keymap[id], isMacPlatform())}
                          </span>
                          {capturing ? (
                            <button className="ghost" data-testid={`keymap-cancel-${id}`} onClick={() => setKeyCapture(null)}>取消</button>
                          ) : (
                            <>
                              <button className="ghost" data-testid={`keymap-edit-${id}`} onClick={() => setKeyCapture(id)}>修改</button>
                              <button className="ghost" data-testid={`keymap-reset-${id}`}
                                disabled={sameBinding(keymap[id], DEFAULT_KEYMAP[id])}
                                onClick={() => {
                                  const next = { ...keymapRef.current, [id]: DEFAULT_KEYMAP[id] };
                                  applyKeymap(next);
                                  persistSetting(KEYMAP_SETTING, JSON.stringify(next));
                                }}>重置</button>
                            </>
                          )}
                        </div>
                      );
                    })}
                  </div>
                  <div className="row" style={{ marginTop: 12 }}>
                    <button className="ghost" data-testid="keymap-reset-all"
                      disabled={KEYMAP_ACTIONS.every(({ id }) => sameBinding(keymap[id], DEFAULT_KEYMAP[id]))}
                      onClick={() => {
                        applyKeymap(parseKeymap(null));
                        persistSetting(KEYMAP_SETTING, JSON.stringify(parseKeymap(null)));
                      }}>全部恢复默认</button>
                  </div>
                </div>
                </>)}

                {settingsCat === "terminal" && (<>
                {/* 二十二轮：单卡三条紧凑设置行（set-item）——卡片不再一卡一开关铺空；
                    开关与测试锚点不变 */}
                <div className="set-card">
                  <h4>终端行为</h4>
                  <label className="set-item">
                    <input type="checkbox" checked={pasteGuard} onChange={(e) => changePasteGuard(e.target.checked)} />
                    <span className="set-item-txt">
                      <b>多行粘贴保护</b>
                      <span className="set-item-desc">内容含换行且远端未开启 bracketed paste 时，先预览确认再发送，防止把本地多行文本误当命令流灌进远端；关闭后立即发送。</span>
                    </span>
                  </label>
                  <label className="set-item">
                    <input type="checkbox" data-testid="cos-toggle" checked={copyOnSelect} onChange={(e) => changeCopyOnSelect(e.target.checked)} />
                    <span className="set-item-txt">
                      <b>选中即复制</b>
                      <span className="set-item-desc">划选终端文字立即写入系统剪贴板（PuTTY/Xshell 惯例，默认关）；关闭后用 ⌘C 或右键「复制」。</span>
                    </span>
                  </label>
                  <label className="set-item">
                    <input type="checkbox" data-testid="bell-toggle" checked={bellNotify} onChange={(e) => changeBellNotify(e.target.checked)} />
                    <span className="set-item-txt">
                      <b>终端响铃时系统通知</b>
                      <span className="set-item-desc">窗口不在前台时收到远端 BEL（如长命令完成）即发系统通知，每会话 10 秒至多一条；标签闪烁提醒恒开。</span>
                    </span>
                  </label>
                </div>
                </>)}

                {settingsCat === "credentials" && (<>
                {/* R41（§231/§238/§267）设置 → 凭据：创建/删除/授权使用**显式提交**
                    （不即时保存）；未绑定态明确；删除前检查引用，不破坏其他主机认证。 */}
                <div className="set-card">
                <div className="row" style={{ alignItems: "center" }}>
                  <h4 style={{ margin: 0 }}>凭据库</h4>
                  <span style={{ flex: 1 }} />
                  <button className="ghost" data-testid="cred-new"
                    onClick={() => { setCredNewOpen(!credNewOpen); setCredNewErr(null); setCredNewOk(null); }}>
                    {credNewOpen ? "收起" : "新建凭据…"}
                  </button>
                </div>
                {credErr && <div className="err" style={{ marginTop: 4, fontSize: 12 }} data-testid="cred-err">✕ {credErr}</div>}
                {credNewOpen && (
                  <div className="cred-new" data-testid="cred-new-form">
                    <label className="cred-field">名称
                      <input value={credLabel} data-testid="cred-new-label" placeholder="例如 prod-key"
                        onChange={(e) => setCredLabel(e.target.value)} />
                    </label>
                    <div className="row" style={{ marginTop: 6, gap: 6 }}>
                      <button className="ghost" disabled={credBusy} data-testid="cred-new-gen-ed"
                        onClick={() => void submitNewIdentity({ Generate: { label: credLabel.trim() || "新密钥", kind: "Ed25519" } })}>生成 Ed25519</button>
                      <button className="ghost" disabled={credBusy} data-testid="cred-new-gen-rsa"
                        onClick={() => void submitNewIdentity({ Generate: { label: credLabel.trim() || "新密钥", kind: "Rsa" } })}>生成 RSA</button>
                    </div>
                    <label className="cred-field" style={{ marginTop: 8 }}>粘贴私钥（OpenSSH / PEM）
                      <textarea value={credPem} data-testid="cred-new-pem" rows={4}
                        placeholder="-----BEGIN OPENSSH PRIVATE KEY-----" onChange={(e) => setCredPem(e.target.value)} />
                    </label>
                    <label className="cred-field">私钥口令（没有可留空）
                      <input type="password" value={credPass} data-testid="cred-new-pass" autoComplete="off"
                        onChange={(e) => setCredPass(e.target.value)} />
                    </label>
                    <div className="row" style={{ marginTop: 6, gap: 6 }}>
                      <button disabled={credBusy} data-testid="cred-new-import"
                        onClick={() => void submitNewIdentity({ Import: { label: credLabel.trim() || "导入密钥", pem: credPem, passphrase: credPass || null } })}>
                        {credBusy ? "处理中…" : "导入并保存"}
                      </button>
                      <button className="ghost" disabled={credBusy} data-testid="cred-new-cancel"
                        onClick={() => { setCredPem(""); setCredPass(""); setCredNewErr(null); setCredNewOpen(false); }}>取消</button>
                    </div>
                    <div className="dim" style={{ marginTop: 4, fontSize: 11 }}>
                      只有点「生成」或「导入并保存」才落库；取消或关闭对话框都不会留下半成品。
                    </div>
                    {credNewErr && <div className="err" style={{ marginTop: 4, fontSize: 12 }} data-testid="cred-new-err">✕ {credNewErr}</div>}
                    {credNewOk && (
                      <div className="ok" style={{ marginTop: 4, fontSize: 12 }} data-testid="cred-new-ok">
                        已保存「{credNewOk.label}」· 指纹 <span className="mono">{credNewOk.fingerprint}</span>
                      </div>
                    )}
                  </div>
                )}
                {credDraftTo && (
                  <div className="cred-draft" data-testid="cred-draft">
                    <div>凭据表单里还有未提交的私钥内容——切到「{settingsCatLabel(credDraftTo)}」会丢弃它。</div>
                    <div className="row" style={{ marginTop: 6, gap: 6 }}>
                      <button data-testid="cred-draft-discard" onClick={discardCredDraft}>丢弃草稿并切换</button>
                      <button className="ghost" data-testid="cred-draft-keep" onClick={() => setCredDraftTo(null)}>留下继续编辑</button>
                    </div>
                  </div>
                )}
                {identities.length === 0 ? (
                  <div className="dim cred-empty" style={{ marginTop: 4, fontSize: 12 }} data-testid="cred-empty">
                    还没有凭据——用上面的「新建凭据…」生成或导入私钥，也可以在连接表单里保存。
                  </div>
                ) : (
                  <div style={{ marginTop: 4 }}>
                    {identities.map((it) => {
                      const boundTo = hosts.filter((h) => h.identity_id === it.id).map((h) => h.name);
                      return (
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
                        {/* §267「授权使用」：绑定在主机表单里显式选择，这里如实列出占用者 */}
                        {boundTo.length > 0 && (
                          <div className="cred-uses" data-testid="cred-uses">用于：{boundTo.join("、")}（换绑请到对应主机的编辑表单）</div>
                        )}
                      </div>
                      );
                    })}
                    <div className="dim" style={{ marginTop: 4, fontSize: 11 }}>
                      删除前自动检查引用；指纹用于核对库里存的是哪把钥匙，不会出现在日志里。
                    </div>
                  </div>
                )}
                </div>
                </>)}

                {settingsCat === "agent" && (<>
                {/* R42（§5 迁移表/§6.7）：Agent 接入、端点、Token 从协作面板移入
                    「设置 → Agent 接入」——新装未启用协作时主界面不再出现 MCP 配置。
                    C9（R43）：本面板是协作**启用生命周期**的人类专属入口（启用/停用）。 */}
                <div className="set-card">
                <h4 style={{ margin: "0 0 6px" }}>Agent 接入（MCP）</h4>
                {/* §9：仅有登记身份 ≠ Agent 在线——「已配置」与「有活动请求」分别显示 */}
                <div className="fact" style={{ marginTop: 6 }} data-testid="collab-state-row">
                  <span className={"badge " + (collabEnabled ? "ok" : "err")} data-testid="collab-state">{collabStateText}</span>
                  <span className="dim" style={{ fontSize: 11 }} data-testid="collab-configured">已配置 {collab.configured_agents}</span>
                  <span className="dim" style={{ fontSize: 11 }} data-testid="collab-active">有活动请求 {collab.active_requests}</span>
                </div>
                {collabEnabled ? (<>
                <div style={{ fontSize: 12, lineHeight: 1.8 }}>
                  MCP 端点随本应用自动运行。为 Agent 签发 Token 后，它的操作请求会进入协作面板逐条审批。
                </div>
                {mcp.agents.length > 0 ? (
                  <div style={{ marginTop: 6 }} data-testid="agent-list">
                    {mcp.agents.map((a) => (
                      <div className="fact" key={a.id} data-testid="agent-row">
                        <span className="s">{a.label}</span>
                        {a.id !== a.label && <span className="dim mono" style={{ fontSize: 10 }}> · id {a.id}</span>}
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="dim" style={{ fontSize: 12, marginTop: 6 }} data-testid="agent-empty">
                    暂无 Agent 接入——按下方三步接入。
                  </div>
                )}
                <div className="fact" style={{ marginTop: 6 }}>
                  <span className="dim" style={{ fontSize: 11 }}>端点</span>{" "}
                  <span className="mono" style={{ fontSize: 11, wordBreak: "break-all" }} data-testid="agent-endpoint">{mcp.endpoint || "未启动"}</span>
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
                    <div>接入后，Agent 的操作请求会出现在协作面板的审批队列逐段裁决。</div>
                  </div>
                )}
                <div className="side-quiet" style={{ marginTop: 8 }}>
                  登记 Agent **不会**转移任何会话的控制权。要把某个会话交给 Agent，在会话工具栏或协作面板点「交给 Agent…」并明确确认。
                </div>
                {/* C9：停用先预览影响→确认后核心原子封 admission；此入口只对 Enabled 开放 */}
                <button className="ghost" style={{ marginTop: 8, color: "var(--danger)" }}
                  data-testid="collab-disable-btn" disabled={collabBusy}
                  onClick={() => void openDisableDialog()}>停用协作…</button>
                </>) : (<>
                {/* 停用/停用中/停用失败：MCP 端点未运行，不渲染接入配置（§6.7）。 */}
                <div style={{ fontSize: 12, lineHeight: 1.8 }} data-testid="collab-disabled-note">
                  {collab.state === "Disabling" ? "协作正在停用——新 Agent 请求已被拒绝，正在收敛存量。"
                    : collab.state === "DisableFailed" ? "上次停用未完全收敛（协作保持封闭，新 Agent 请求仍被拒绝）——请先「重试停用收敛」，收敛后才可重新启用。"
                    : "协作已停用——MCP 端点未运行，Agent 请求一律被拒绝。要使用协作请显式启用。"}
                </div>
                {mcp.agents.length > 0 && (
                  <div className="dim" style={{ fontSize: 11, marginTop: 6 }} data-testid="collab-kept-agents">
                    已配置的 Agent（Token 保留，重新启用后继续可用）：{mcp.agents.map((a) => a.label).join("、")}
                  </div>
                )}
                {collab.state === "DisableFailed" ? (
                  // 未收敛：只能重试停用（不得直接重新启用——核心会拒绝）
                  <button data-testid="collab-retry-disable-btn" style={{ marginTop: 8 }} disabled={collabBusy}
                    onClick={() => void retryDisableConvergence()}>
                    重试停用收敛
                  </button>
                ) : collab.state === "Disabling" ? null : (
                  <button data-testid="collab-enable-btn" style={{ marginTop: 8 }} disabled={collabBusy}
                    onClick={() => void enableCollab()}>
                    启用协作
                  </button>
                )}
                </>)}
                </div>
                </>)}

                {settingsCat === "about" && (<>
                <div className="set-card">
                <h4 style={{ margin: "0 0 8px" }}>关于</h4>
                <div style={{ fontSize: 12, lineHeight: 1.9 }}>
                  <div>TinySSH {appVersion ? `v${appVersion}` : "（浏览器演示模式）"}</div>
                  <div className="dim">本地优先的 SSH 客户端：终端、主机库与凭据都留在本机。</div>
                  <div className="dim">凭据以加密形式存于本机凭据库，界面与日志只显示指纹。</div>
                </div>
                {/* 自身开销监控（本轮）：本进程 CPU/内存 2s 实时采样；核心不可达时整块自隐藏 */}
                <SelfMeterDetail />
                </div>
                </>)}
                  </div>
                </div>
              </div>
            </>
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
          <aside className={"task-panel" + (tpFull ? " tp-full" : "")} aria-label="任务面板" ref={taskPanelRef}>
            <div className="tp-head">
              <b data-testid="tp-title">{rightPanel === "files" ? "文件" : rightPanel === "forwards" ? "端口转发" : rightPanel === "log" ? "活动记录" : "协作"}</b>
              {tpFull && <span className="dim" style={{ fontSize: 11 }}>空间不足——完整视图，终端仍在运行</span>}
              {rightPanel === "collab" && pendingCount > 0 && <span className="badge agent">{pendingCount} 待处理</span>}
              <span style={{ flex: 1 }} />
              <button className="ghost icon-btn" title="关闭面板（再次点「文件」/「工具」项亦可）" aria-label="关闭任务面板"
                data-testid="tp-close"
                onClick={() => setRightPanel(null)}><IconX size={14} /></button>
            </div>
            <div className="tp-scroll">
          {rightPanel === "collab" && (
            !collabEnabled ? (
              // C9（R43）：协作停用/停用中/停用失败时不出现空审批区——改为停用态指引。
              <div className="empty" data-testid="collab-disabled">
                <IconInbox size={14} />
                <div>
                  {collabStateText}。{collab.state === "Enabled" ? "" : "新 Agent 请求已被拒绝"}
                  {collab.state === "Disabling" ? "，正在收敛存量。" : "。"}
                  <div style={{ marginTop: 6 }}>
                    <button className="ghost" data-testid="collab-open-settings"
                      onClick={() => openSettingsAt("agent")}>打开设置 → Agent 接入</button>
                  </div>
                </div>
              </div>
            ) : !collabConfigured && !collabActive ? (
              // §6.7：新装未启用协作时不出现空审批区——改为一次性引导（不渲染空壳表单）
              <div className="empty" data-testid="collab-unconfigured">
                <IconInbox size={14} />
                <div>
                  协作未接入 Agent。到「设置 → Agent 接入」签发 Token 登记 Agent 后，这里会显示审批、任务目标与现场简报。
                  <div style={{ marginTop: 6 }}>
                    <button className="ghost" data-testid="collab-open-settings"
                      onClick={() => openSettingsAt("agent")}>打开设置 → Agent 接入</button>
                  </div>
                </div>
              </div>
            ) : (
            <>
          <div className="section">
            <h4>审批{pendingCount > 0 ? `（${pendingCount}）` : ""}</h4>
            {/* §3.2：跨会话待办按主机与会话分组——绝不只展示「当前主机」而误批其他会话 */}
            <div className="side-quiet">按目标主机与会话分组；跨会话操作请逐条核对来源。</div>
          </div>
          <div className="collab-approvals">
          {approvalGroups.map((g) => (
            <div className="ap-group" key={g.sid} data-testid="ap-group">
              <div className="ap-group-head">
                <b>{g.sess ? g.sess.host_name : "会话已不在列表"}</b>
                <span className="mono dim" title={g.sid}> · {g.sid.slice(0, 12)}</span>
                {g.sess && <span className={"mono " + stateLabel(g.sess.state).cls} style={{ fontSize: 10 }}>{stateLabel(g.sess.state).text}</span>}
                <span className="badge agent">{g.items.length} 待处理</span>
              </div>
              {g.items.map((a) => {
                const risk = approvalRisk(a);
                return (
                  <div className="card" key={a.id}>
                    <div className="row">
                      <span className="badge">Agent：{a.agent_id}</span>
                      {/* 破坏性提示由核心算出（target_summary），UI 不自猜 */}
                      {a.target_summary && <span className="tsum-chip" title="命令本身的破坏性提示（核心判定）">{a.target_summary}</span>}
                    </div>
                    {/* §6.7「可用目的」：会话当前委托目标的投影；无法获知时**明确缺失**，
                        不得留白让人误读为「无风险」 */}
                    <div className={"purpose-line" + (a.purpose ? "" : " missing")} data-testid="ap-purpose">
                      <span className="dim">目的</span>{" "}
                      {a.purpose ? <span>{a.purpose}</span> : <span className="dim">未提供（Agent 未收到委托说明）</span>}
                    </div>
                    {/* 目标上下文：多会话并存时 rm -rf 级裁决必须知道落在哪台机器 */}
                    <div className="dim" style={{ fontSize: 11, marginTop: 5 }} title={a.session_id}>
                      目标：{g.sess ? <b style={{ color: "var(--text)" }}>{g.sess.host_name}</b> : "会话已不在列表"}
                      <span className="mono"> · {a.session_id.slice(0, 12)}</span>
                      {g.sess?.state === "Disconnected" && " · 会话已断开"}
                      {a.session_busy && " · 会话正在交互程序中"}
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
            </div>
          ))}
          {pendingApprovals.length === 0 && (
            <div className="empty"><IconInbox size={14} />暂无待审批请求。Agent 通过 MCP 发起操作时会出现在这里。</div>
          )}
          {resolvedApprovals.length > 0 && (
            <div className="side-quiet">
              <div className="side-sub">最近处理</div>
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
          </div>

            </>
            )
          )}
          {rightPanel === "files" && (
            <>
          <div className="section" ref={sftpWrapRef}>
            <h4>远程文件</h4>
            {!sid ? (
              <div className="side-quiet">连接会话后可浏览远端目录；文件拖进窗口即上传到正在浏览的目录。</div>
            ) : (
              <>
                <div className="row sftp-nav">
                  <button className="ghost" title="返回上一位置" aria-label="返回" disabled={!sftpHist.length || sftpLoading}
                    onClick={() => void sftpGoBack()}><IconChevronLeft size={13} /></button>
                  <button className="ghost" title="前进" aria-label="前进" disabled={!sftpFwd.length || sftpLoading}
                    onClick={() => void sftpGoFwd()}><IconChevronRight size={13} /></button>
                  <button className="ghost" title="上一级目录" aria-label="上一级"
                    disabled={!sftpPath || sftpPath === "/"}
                    onClick={() => {
                      const p = sftpPath.replace(/\/+$/, "").split("/");
                      p.pop();
                      void navigateTo(p.length ? p.join("/") || "/" : "/");
                    }}
                  ><IconChevronUp size={13} /></button>
                  <button className="ghost" title="刷新当前目录" aria-label="刷新"
                    disabled={!sftpPath || sftpLoading} onClick={() => void loadDir(sftpPath)}
                  ><IconRefresh size={13} /></button>
                  <button className="ghost" title="定位到终端目录（显式定位；不执行 cd，不自动跟随 shell）" aria-label="定位到终端目录"
                    disabled={!brief?.cwd || sftpPath === brief.cwd}
                    onClick={() => brief?.cwd && void navigateTo(brief.cwd)}
                  ><IconTerminal size={13} /></button>
                  <button className="ghost" title="上传本地文件到当前目录（原生文件选择器，可多选）" aria-label="上传"
                    data-testid="sftp-upload-btn"
                    disabled={!sftpPath || sftpLoading}
                    onClick={() => void pickAndUpload()}
                  ><IconUpload size={13} /></button>
                  <button className={"ghost" + (byPathOpen ? " ts-open" : "")} title="按远端路径下载（保留 §246 入口）" aria-label="按路径下载"
                    data-testid="sftp-by-path-btn" aria-pressed={byPathOpen}
                    onClick={() => setByPathOpen(!byPathOpen)}
                  ><IconDownload size={13} /></button>
                  <span style={{ flex: 1 }} />
                  <button className={"ghost" + (sftpEditPath ? " ts-open" : "")} title={sftpEditPath ? "切换为面包屑" : "编辑路径框"}
                    aria-label="切换路径输入" aria-pressed={sftpEditPath}
                    onClick={() => { if (sftpEditPath) setSftpEditPath(false); else { setSftpPathInput(sftpPath); setSftpEditPath(true); } }}
                  ><IconPencil size={13} /></button>
                </div>
                {sftpEditPath ? (
                  <div className="row sftp-path">
                    <input
                      className="mono" autoFocus data-testid="sftp-path-input"
                      placeholder="远端目录（绝对路径，回车进入）"
                      value={sftpPathInput}
                      onChange={(e) => setSftpPathInput(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") void navigateTo(sftpPathInput).then((ok) => { if (ok) setSftpEditPath(false); });
                        else if (e.key === "Escape") { setSftpEditPath(false); setSftpPathInput(sftpPath); }
                      }}
                    />
                  </div>
                ) : (
                  <div className="sftp-crumbs" data-testid="sftp-crumbs" ref={sftpCrumbsRef} title={sftpPath || undefined}>
                    {sftpPath ? (() => {
                      const parts = sftpPath.replace(/\/+$/, "").split("/").filter(Boolean);
                      const segs: { label: string; path: string }[] = [{ label: "/", path: "/" }];
                      let acc = "";
                      for (const p of parts) { acc += "/" + p; segs.push({ label: p, path: acc }); }
                      return segs.map((s, i) => (
                        <span key={s.path} className="sftp-crumb-seg">
                          {i > 0 && <span className="dim">/</span>}
                          {i < segs.length - 1 ? (
                            <button className="sftp-crumb" title={`进入 ${s.path}`} onClick={() => void navigateTo(s.path)}>{s.label}</button>
                          ) : (
                            <span className="sftp-crumb cur" aria-current="location">{s.label}</span>
                          )}
                        </span>
                      ));
                    })() : <span className="dim">未浏览——点「定位到终端目录」或 ✎ 输入绝对路径</span>}
                  </div>
                )}
                <div className="row sftp-tools">
                  <input className="sftp-filter" placeholder="筛选名称" aria-label="按名称筛选"
                    value={sftpFilter} onChange={(e) => setSftpFilter(e.target.value)} />
                  <button className={"ghost" + (sftpShowHidden ? " ts-open" : "")} aria-pressed={sftpShowHidden}
                    title="显示隐藏项（. 开头）" onClick={() => setShowHidden((v) => !v)}>隐藏项</button>
                  <button className={"ghost" + (sftpSaveAs ? " ts-open" : "")} aria-pressed={sftpSaveAs}
                    data-testid="sftp-saveas-toggle"
                    title="另存为模式：下载时逐个弹出保存对话框选位置（对行内下载、下载所选、路径下载、菜单「下载」生效；右键「另存为…」不受影响）"
                    onClick={() => setSftpSaveAs((v) => !v)}>另存为</button>
                  {([["name", "名称"], ["size", "大小"], ["mtime", "时间"]] as const).map(([k, label]) => (
                    <button key={k} className={"ghost" + (sftpSort.key === k ? " ts-open" : "")} aria-pressed={sftpSort.key === k}
                      title={`按${label}排序${sftpSort.key === k ? (sftpSort.dir === 1 ? "（当前升序，点击改降序）" : "（当前降序，点击改升序）") : ""}`}
                      onClick={() => setSftpSort((s) => (s.key === k ? { key: k, dir: s.dir === 1 ? -1 : 1 } : { key: k, dir: 1 }))}
                    >{label}{sftpSort.key === k ? (sftpSort.dir === 1 ? "↑" : "↓") : ""}</button>
                  ))}
                </div>
                {byPathOpen && (
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
                {sftpErr && <div className="err" style={{ marginTop: 6 }}>✕ {sftpErr}</div>}
                {sftpLoading && (
                  <div className="sftp-list" aria-busy="true">
                    {[0, 1, 2].map((i) => <div className="skeleton sftp-sk" key={i} style={{ width: `${90 - i * 18}%`, height: 18 }} />)}
                  </div>
                )}
                {!sftpLoading && sftpEntries && sftpEntries.length === 0 && (
                  <div className="side-quiet">空目录。</div>
                )}
                {!sftpLoading && sftpEntries && sftpEntries.length > 0 && sftpShown.length === 0 && (
                  <div className="side-quiet">无匹配项（名称筛选或隐藏项过滤）。</div>
                )}
                {!sftpLoading && sftpShown.length > 0 && (
                  <div
                    className={"sftp-list" + (sftpListW <= 300 ? " cols-name-only" : sftpListW <= 340 ? " cols-no-time" : "")}
                    data-testid="sftp-list" ref={sftpListRef} tabIndex={0}
                    aria-label="文件列表（方向键移动，Enter 进入目录，Space 选中）"
                    onKeyDown={sftpListKey}
                  >
                    {sftpShown.map((e, i) => (
                      <div
                        key={e.name} data-idx={i} data-name={e.name}
                        className={"sftp-row" + (e.is_dir ? " dir" : "") + (sftpSel.has(e.name) ? " sel" : "") + (i === sftpCursor ? " cursor" : "")}
                        onClick={(ev) => sftpRowClick(e, i, ev)}
                        onDoubleClick={(ev) => sftpActivate(e, { x: ev.clientX, y: ev.clientY })}
                        title={e.is_dir ? "双击进入" : e.kind === "symlink" ? "双击按目标处理" : "双击查看可用动作"}
                      >
                        <span className="sftp-ico" title={e.kind === "symlink" ? "符号链接" : undefined}>
                          {e.kind === "symlink" ? "→" : e.is_dir ? <IconFolder size={13} /> : <IconFile size={13} />}
                        </span>
                        <span className="sftp-name mono" title={`${sftpPath.replace(/\/+$/, "")}/${e.name}`}>{e.name}</span>
                        <span className="dim mono sftp-size" title={e.size == null ? "大小未知" : `${e.size} 字节`}>
                          {e.is_dir ? "目录" : e.kind === "symlink" ? "链接" : e.size == null ? "—" : fmtBytes(e.size)}
                        </span>
                        <span className="dim mono sftp-time" title={e.mtime == null ? "修改时间未知" : new Date(e.mtime * 1000).toLocaleString("zh-CN")}>
                          {e.mtime == null ? "—" : new Date(e.mtime * 1000).toLocaleDateString("zh-CN", { month: "numeric", day: "numeric" })}
                        </span>
                        {!e.is_dir && (
                          <button
                            className="ghost sftp-dl"
                            title="下载（存上次下载目录，首次为「下载」文件夹；开「另存为」或菜单「另存为…」可选位置）"
                            onClick={(ev) => { ev.stopPropagation(); void downloadRemote(`${sftpPath.replace(/\/+$/, "")}/${e.name}`); }}
                          ><IconDownload size={12} />下载</button>
                        )}
                      </div>
                    ))}
                  </div>
                )}
                {/* 选择条在列表下方（R31）：上方插入会使列表下移、双击第二击落空 */}
                {sftpSel.size > 0 && (
                  <div className="row sftp-selbar" data-testid="sftp-selbar">
                    <span className="dim">已选 {sftpSel.size} 项</span>
                    <button className="ghost" data-testid="sftp-sel-download" disabled={sftpLoading}
                      onClick={() => void sftpDownloadSelected()}
                    ><IconDownload size={12} /> 下载所选</button>
                    <button className="ghost" title="清除选择" aria-label="清除选择"
                      onClick={() => { setSftpSel(new Set()); sftpAnchorRef.current = null; }}>✕</button>
                  </div>
                )}
                <div className="side-quiet">单击选中（⌘ 多选 / Shift 范围），双击进入目录或查看文件动作；下载存上次下载目录（首次为「下载」文件夹），开「另存为」可在每次下载时选位置；传输进度见底部队列（状态条「传输 N」展开）。</div>
              </>
            )}
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
                {/* 表单（§6.6）：类型解释为人类语义、-L/-R/-D 作辅助；监听地址是显式
                    字段（默认 127.0.0.1）；目标标注从哪一端解析；字段级错误就地高亮。 */}
                <div className="row fwd-form">
                  <select value={fwdKind} onChange={(e) => { setFwdKind(e.target.value as "Local" | "Remote" | "Dynamic"); setFwdFieldErr(null); setFwdExposeAck(false); }} title="转发类型">
                    <option value="Local">本地端口访问远端服务（-L）</option>
                    <option value="Remote">远端端口访问本机服务（-R）</option>
                    <option value="Dynamic">SOCKS5 代理（-D）</option>
                  </select>
                </div>
                {/* A 行：监听地址（显式字段）+ 监听端口 */}
                <div className="row fwd-form" style={{ marginTop: 4, alignItems: "flex-end" }}>
                  <div className="ah-field" style={{ flex: 1 }}>
                    <label>监听地址{fwdKind === "Remote" ? "（在远端服务器）" : "（在本机）"}</label>
                    <input className="mono" value={fwdLAddr} placeholder="127.0.0.1"
                      onChange={(e) => { setFwdLAddr(e.target.value); setFwdExposeAck(false); setFwdFieldErr(null); }} />
                  </div>
                  <div className="ah-field" style={{ width: 88 }}>
                    <label>{fwdKind === "Remote" ? "远端端口" : "本地端口"}</label>
                    <input className="mono" value={fwdPort} placeholder="端口"
                      onChange={(e) => { setFwdPort(e.target.value); setFwdFieldErr(null); }} />
                  </div>
                </div>
                {fwdFieldErr?.listen && <div className="fwd-err" data-testid="fwd-err-listen">⚠ {fwdFieldErr.listen}</div>}
                {/* 非回环监听：显示暴露范围 + 必须主动勾选（§6.6） */}
                {!isLoopbackAddr(fwdLAddr) && (
                  <label className="fwd-expose" data-testid="fwd-expose">
                    <input type="checkbox" checked={fwdExposeAck} onChange={(e) => { setFwdExposeAck(e.target.checked); setFwdFieldErr(null); }} />
                    <span>我确认暴露范围：监听 <b>{fwdLAddr}</b> 将对本机所在网络的所有设备可见，任何能访问该地址的设备都可经此转发
                      {fwdKind === "Dynamic" ? "（SOCKS5 无认证，等同开放代理）" : ""}。</span>
                  </label>
                )}
                {/* B 行：目标（仅 -L/-R），标注解析端 */}
                {fwdKind !== "Dynamic" && (
                  <div className="row fwd-form" style={{ marginTop: 4, alignItems: "flex-end" }}>
                    <div className="ah-field" style={{ flex: 1 }}>
                      <label>{fwdKind === "Remote" ? "目标（本机侧解析）" : "目标（远端侧解析）"}</label>
                      <input className="mono" value={fwdHost} placeholder={fwdKind === "Remote" ? "回到本机·主机" : "目标主机"}
                        onChange={(e) => { setFwdHost(e.target.value); setFwdFieldErr(null); }} />
                    </div>
                    <div className="ah-field" style={{ width: 76 }}>
                      <label>端口</label>
                      <input className="mono" value={fwdTPort} placeholder="端口"
                        onChange={(e) => { setFwdTPort(e.target.value); setFwdFieldErr(null); }} />
                    </div>
                  </div>
                )}
                {fwdFieldErr?.target && <div className="fwd-err" data-testid="fwd-err-target">⚠ {fwdFieldErr.target}</div>}
                <div className="row" style={{ marginTop: 6 }}>
                  <button disabled={fwdBusy} onClick={() => void addForward()}>启动转发</button>
                  <span className="side-quiet" style={{ flex: 1 }}>
                    {fwdKind === "Local" ? "本地端口访问远端服务：本机监听，流量经 SSH 到远端目标。"
                      : fwdKind === "Remote" ? "远端端口访问本机服务：远端服务器监听，流量回程到本机目标。"
                      : "SOCKS5 代理：本机监听无认证代理，目标由每次连接决定。"}
                  </span>
                </div>
                {forwards.length === 0 && <div className="side-quiet">暂无转发。</div>}
                {forwards.map((f) => {
                  const k = "Local" in f.spec ? "Local" : "Remote" in f.spec ? "Remote" : "Dynamic";
                  const v = (f.spec as Record<string, { listen_addr?: string; listen_port: number; target_host?: string; target_port?: number }>)[k];
                  const laddr = v.listen_addr || "127.0.0.1";
                  // 人类可读路线（§6.6）；目标解析端在串内标注（Local 远端解析 / Remote 本机解析）
                  const fwdText = k === "Local" ? `${laddr}:${v.listen_port} → ${v.target_host}:${v.target_port}`
                    : k === "Remote" ? `远端 ${laddr}:${v.listen_port} → 本机 ${v.target_host}:${v.target_port}`
                    : `SOCKS5 ${laddr}:${v.listen_port}`;
                  // §6.6：监听成功与目标可达**分开显示**——不把「正在监听」表述为服务健康
                  const listenText = f.state === "Failed" ? "监听失败" : "监听中";
                  const healthText = f.state === "Listening" ? "目标可达性未验证（首次连接时确认）"
                    : f.state === "Degraded" ? `目标不可达：${f.error ?? "隧道/目标暂不可用（恢复后自动重连）"}`
                    : `${f.error ?? "未知错误"}`;
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
                          title={stopErr ? `上次停止失败：${stopErr}——点击重试` : "停止转发（等待核心确认）"}
                          onClick={() => void stopForward(f.id)}>{stopping ? "停止中…" : stopErr ? "重试停止" : "停止"}</button>
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
          {rightPanel === "log" && (
            <>
              <div className="section">
                <div className="log-bar">
                  <div className="seg" role="group" aria-label="记录范围">
                    <button className={logScope === "current" ? "on" : ""} data-testid="log-scope-current"
                      aria-pressed={logScope === "current"} disabled={!sid}
                      title={sid ? "只看当前会话" : "未接入会话"}
                      onClick={() => setLogScope("current")}>当前会话</button>
                    <button className={logScope === "all" ? "on" : ""} data-testid="log-scope-all"
                      aria-pressed={logScope === "all"}
                      onClick={() => setLogScope("all")}>全部会话</button>
                  </div>
                  <span style={{ flex: 1 }} />
                  <button className="ghost icon-btn" title="刷新" aria-label="刷新活动记录"
                    data-testid="log-refresh" disabled={logBusy}
                    onClick={() => void loadLog(false)}><IconRefresh size={14} /></button>
                </div>
                <div className="log-filters">
                  <label>主体
                    <select value={logActor} data-testid="log-actor"
                      onChange={(e) => setLogActor(e.target.value as "" | "human" | "agent")}>
                      <option value="">全部</option>
                      <option value="human">人类</option>
                      <option value="agent">Agent</option>
                    </select>
                  </label>
                  <label>事件类型
                    <select value={logAction} data-testid="log-action"
                      onChange={(e) => setLogAction(e.target.value)}>
                      <option value="">全部</option>
                      {LOG_ACTION_OPTIONS.map((o) => <option key={o.v} value={o.v}>{o.label}</option>)}
                    </select>
                  </label>
                </div>
                <div className="log-note" data-testid="log-note">
                  本机时间（{TZ_NOTE}）· {logScope === "current" && !sid
                    ? "未接入会话，无可显示记录"
                    : `共 ${logTotal} 条${logScope === "current" ? "（当前会话）" : ""}`}
                </div>
              </div>
              <div className="section">
                {logErr ? (
                  <div className="empty" data-testid="log-err">{logErr}</div>
                ) : logScope === "current" && !sid ? (
                  <div className="empty" data-testid="log-empty-nosession"><IconTerminal size={14} />未接入会话——切到「全部会话」可查看历史记录。</div>
                ) : logEvents.length === 0 ? (
                  <div className="empty" data-testid="log-empty">
                    <IconClock size={14} />{logBusy ? "载入中…" : "暂无记录。所有连接与命令都会留痕在这里。"}
                  </div>
                ) : (
                  <>
                    {logEvents.map((ev) => {
                      const ident = ev.session_id ? sessionIdent.get(ev.session_id) : undefined;
                      // 短 id 只用于辨认（完整 id 在 title 里）——太短的 id 直接全显，别截成无信息量的前缀
                      const shortSid = ev.session_id ? (ev.session_id.length <= 12 ? ev.session_id : ev.session_id.slice(0, 8)) : "";
                      return (
                        <div className={`tl-row log-row actor-${ev.actor_kind}`} key={ev.seq} data-testid="log-row"
                          data-action={ev.action} data-actor={ev.actor_kind}
                          title={`#${ev.seq} ${ev.action}${ev.command ? ` · ${ev.command}` : ""}`}>
                          <div className="tl-meta">
                            {stampLocal(ev.ts)}
                            {ev.session_id && <> · {ident ?? <span className="log-sid">{shortSid}</span>}</>}
                            {ev.session_id && <span className="log-sid" title={ev.session_id}>（{shortSid}）</span>}
                          </div>
                          <div className="tl-action">
                            <span className="tl-actor">
                              {ev.actor_kind === "human" ? "我" : `Agent${ev.agent_id ? ` · ${ev.agent_id}` : ""}`}
                            </span>{" "}
                            {decisionLabel(ev)}
                            {ev.command && <>{" "}<span className="tl-cmd-text">{ev.command}</span></>}
                          </div>
                        </div>
                      );
                    })}
                    {logEvents.length < logTotal && (
                      <button className="ghost log-more" data-testid="log-more" disabled={logBusy}
                        onClick={() => void loadLog(true)}>
                        {logBusy ? "载入中…" : `加载更早（已显示 ${logEvents.length}/${logTotal}）`}
                      </button>
                    )}
                  </>
                )}
              </div>
            </>
          )}
          {rightPanel === "collab" && (
            <>
          {/* §6.7：委托是显式动作（首次委托对话框）。此处给入口与当前控制权事实；
              MCP 配置已迁至「设置 → Agent 接入」（§5 迁移表），面板不再重复。 */}
          <div className="section">
            <h4>委托</h4>
            {!sid ? (
              <div className="side-quiet">连接会话后可委托给 Agent。</div>
            ) : !collabConfigured ? (
              <>
                <div className="side-quiet">{collabEnabled ? "协作未接入 Agent，暂不能委托。先登记 Agent 接入。" : "协作已停用，暂不能委托。先到「设置 → Agent 接入」启用。"}</div>
                <button className="ghost" data-testid="collab-open-settings-delegate"
                  onClick={() => openSettingsAt("agent")}>打开设置 → Agent 接入</button>
              </>
            ) : current?.control_owner === "Agent" ? (
              <>
                <div className="side-quiet">本会话控制权在 Agent。要收回请用会话工具栏的「接管」——接管会立即冻结并作废未开始的请求。</div>
                {owner === "Human" && (
                  <button className="ghost" data-testid="takeover-from-panel"
                    onClick={() => void takeover()}>接管（仅冻结）</button>
                )}
              </>
            ) : (
              <>
                <div className="side-quiet">把控制权显式交给 Agent 后，它的操作请求才会进入上方审批队列。</div>
                <button data-testid="delegate-open-panel" onClick={openDelegate}>
                  {current?.ever_agent_owned ? "交还 Agent…" : "交给 Agent…"}
                </button>
              </>
            )}
          </div>

          {/* §6.7：任务目标仅在协作已启用且处于受控会话时呈现——人类普通 SSH 不展示空白委托表单 */}
          <div className="section">
            <h4>任务目标</h4>
            {!collabConfigured ? (
              <div className="side-quiet">协作未启用。任务目标用于向 Agent 说明委托意图。</div>
            ) : sid ? (
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
            </>
          )}
            </div>
          </aside>
        )}
        </div>{/* /content */}

        {/* R35 S08 §194：传输队列=工作区底部抽屉，默认收起；后台事件只更新
            状态条计数不自动展开；抽屉关闭不影响任务（纯展示层）。展开不销毁
            终端实例（兄弟节点，无重挂）。 */}
        {queueOpen && (
          <div className="queue-drawer" data-testid="queue-drawer" role="region" aria-label="传输队列">
            <div className="queue-head">
              <span className="queue-title">传输</span>
              <span className="queue-count">{transfers.length} 个任务</span>
              <span style={{ flex: 1 }} />
              <button className="ghost" data-testid="queue-collapse" aria-label="收起传输队列" onClick={() => setQueueOpen(false)}>收起 ⌄</button>
            </div>
            <div className="queue-body">
              {transfers.length === 0 && (
                <div className="side-quiet">暂无传输任务。把文件从访达拖进窗口：拖到文件面板直接上传到正在浏览的目录，拖到终端先确认目标。</div>
              )}
              {transfers.map((t) => (
                <div className="card row xfer-row" key={t.id} data-testid={"xfer-" + t.status}>
                  <span className={"xfer-dir " + (t.kind === "Upload" ? "up" : "down")}>
                    {t.kind === "Upload" ? <IconUpload size={12} /> : <IconDownload size={12} />}
                  </span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div className="row" style={{ gap: 8 }}>
                      <div className="xfer-name mono" title={t.name}>{t.name}</div>
                      <span className="xfer-host mono" title={`会话：${hostLabel(t.sid)}`}>{hostLabel(t.sid)}</span>
                      <span className="mono xfer-sub">
                        {t.status === "queued" && "排队中…"}
                        {t.status === "running" && (t.total != null && t.total > 0
                          ? `传输中… ${fmtBytes(t.bytes ?? 0)} / ${fmtBytes(t.total)}`
                          : `传输中… ${fmtBytes(t.bytes ?? 0)}${t.total == null ? "（总量未知）" : ""}`)}
                        {t.status === "committing" && "提交中…（字节传完不代表提交完成）"}
                        {t.status === "cancelling" && "取消中…"}
                        {t.status === "done" && `完成 · ${fmtBytes(t.bytes ?? 0)}`}
                        {t.status === "failed" && `失败：${t.error ?? "未知错误"}`}
                        {t.status === "cancelled" && "已取消"}
                        {t.status === "skipped" && "已跳过：同名目标未改动"}
                        {t.status === "interrupted" && `已中断：${t.error ?? "应用重启时传输中断"}`}
                        {t.status === "unknown" && `结果未知：${t.error ?? "发布应答丢失"}`}
                      </span>
                    </div>
                    {/* S08：完整 源 → 目标（方向语义：上传 本地→远端，下载 远端→本地） */}
                    <div className="mono xfer-sub" title={t.kind === "Upload" ? `${t.local} → ${t.remote}` : `${t.remote} → ${t.local}`}>
                      {t.kind === "Upload" ? `${t.local} → ${t.remote}` : `${t.remote} → ${t.local}`}
                    </div>
                    {t.status === "awaiting" && t.prompt && (
                      <div className="xfer-conflict">
                        <div className="mono xfer-sub">
                          {t.prompt.reason === "stat_changed_since_preflight" ? "目标在提交前已变化，需重新裁决：" : "目标已存在："}
                          <span className="mono" title={t.prompt.target_path}>{t.prompt.target_path}</span>
                          {t.prompt.size != null && ` · ${fmtBytes(t.prompt.size)}`}
                          {t.prompt.mtime != null && ` · ${new Date(t.prompt.mtime * 1000).toLocaleString()}`}
                        </div>
                        <div className="row" style={{ gap: 6, marginTop: 4 }}>
                          <button className="ghost" data-testid="cf-skip" onClick={() => { void decideCollision(t, "skip"); }}>跳过</button>
                          <button className="ghost" data-testid="cf-overwrite" title="外部进程可能改动目标且无法验证版本——覆盖发布将被阻止，原文件零改动" onClick={() => { void decideCollision(t, "overwrite"); }}>覆盖</button>
                          <button className="ghost" data-testid="cf-keepboth" onClick={() => { void decideCollision(t, "keepboth"); }}>两个都要</button>
                        </div>
                      </div>
                    )}
                    {t.status === "unknown" && (
                      <div className="row" style={{ gap: 6, marginTop: 4 }}>
                        <button className="ghost" data-testid="uo-reverify" onClick={() => { void verifyOutcome(t.id); }}>重新核实</button>
                        <span className="mono xfer-note">temp 与恢复资料保留；不自动重发</span>
                      </div>
                    )}
                  </div>
                  {/* S08 该状态允许的操作：进行中=取消；失败/取消/跳过/中断=重试（新任务
                      重新校验）；unknown 只有重新核实 + 查看目标（§374 界面须提供
                      「重新核实」「查看目标/记录」，通用重试绝不作为默认动作）；
                      完成=定位（下载访达显示本地目标 / 上传文件面板开目标目录） */}
                  <div className="row" style={{ gap: 2, flex: "none" }}>
                    {t.kind === "Download" && t.status === "done" && !t.local.startsWith("pending") && (
                      <button className="ghost" data-testid="xfer-locate" title="在访达中显示本地目标" onClick={() => void locateTransfer(t)}>定位</button>
                    )}
                    {t.kind === "Upload" && t.status === "done" && t.sid && t.sid === sidRef.current && (
                      <button className="ghost" data-testid="xfer-locate" title="在文件面板打开目标目录" onClick={() => void locateTransfer(t)}>定位</button>
                    )}
                    {t.status === "unknown" && (
                      <button className="ghost" data-testid="xfer-view-target" title="查看目标：核对目标当前状态（下载在访达显示本地目标 / 上传打开文件面板目标目录）——仅目标存在不能证明本任务成功，结果仍待核实" onClick={() => void locateTransfer(t)}>查看目标</button>
                    )}
                    {(t.status === "failed" || t.status === "cancelled" || t.status === "skipped" || t.status === "interrupted") && (
                      canRetry(t)
                        ? <button className="ghost" data-testid="xfer-retry" title="重试：创建新任务，重新校验连接、源文件与冲突" onClick={() => { void retryTransfer(t.id); }}>重试</button>
                        : <span className="xfer-note" data-testid="xfer-retry-unavailable" title="重试须在原会话内重跑（重新校验连接/源/冲突）；原会话已不在——请重连该主机后在文件面板重新发起">会话已不在</span>
                    )}
                    {t.status === "running" || t.status === "queued" || t.status === "cancelling" || t.status === "committing" || t.status === "awaiting" ? (
                      <button className="ghost" title="取消传输" onClick={() => { invoke("cancel_transfer", { id: t.id }).catch(() => {}); }}>✕</button>
                    ) : (
                      <span className={t.status === "done" ? "ok" : t.status === "cancelled" || t.status === "skipped" ? "dim" : "err"} style={{ flex: "none", width: 18, textAlign: "center" }}>
                        {t.status === "done" ? "✓" : t.status === "cancelled" || t.status === "skipped" ? "⊘" : "✕"}
                      </span>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* 页脚状态条 24（§4.2）：只放短状态与任务入口 */}
        <footer className="statusbar">
          <span className="mono sb-left">{sbLeft}</span>
          <span style={{ flex: 1 }} />
          <span className="sb-right">
            <button className="sb-btn" title="端口转发" onClick={() => setRightPanel(rightPanel === "forwards" ? null : "forwards")}>转发 <b>{forwards.length}</b></button>
            <button className={"sb-btn" + (queueOpen ? " ts-open" : "")} data-testid="sb-transfer" title="传输队列（底部抽屉；后台事件只更新计数不自动展开）" aria-pressed={queueOpen}
              onClick={() => setQueueOpen(!queueOpen)}>传输 <b>{runningTransfers}</b> {queueOpen ? "⌃" : "⌄"}</button>
          </span>
        </footer>
        </main>
      </div>{/* /workspace */}

      {/* Toast（§六/P3）：右下角轻通知，2.6s 自动消失，不挡交互（pointer-events 放行）。
          live 级别逐条给：err 用 assertive 立即播报，其余 polite（审核吹毛求疵-4） */}
      <div className="toast-stack">
        {toasts.map((t) => <div className={"toast " + t.kind} key={t.id} aria-live={t.kind === "err" ? "assertive" : "polite"}>{t.text}</div>)}
      </div>
      {/* 十九轮：命令面板（⌘K）；Esc/遮罩关闭走浮层链与本组件内键盘 */}
      <CommandPalette open={paletteOpen} items={paletteItems} onClose={() => setPaletteOpen(false)} />

      {/* R31 §350 文件动作菜单：双击/Enter 文件弹出可用动作（不直接执行）；点外/Esc 关 */}
      {sftpMenu && (
        <div
          className="sftp-menu" ref={sftpMenuRef} role="menu" data-testid="sftp-menu"
          aria-label={`${sftpMenu.name} 可用动作`}
          style={{ left: Math.max(6, Math.min(sftpMenu.x, winW - 160)), top: Math.min(sftpMenu.y, window.innerHeight - 84) }}
        >
          <div className="sftp-menu-title mono">{sftpMenu.name}</div>
          <button role="menuitem" data-testid="sftp-menu-download"
            onClick={() => { const n = sftpMenu.name; setSftpMenu(null); void downloadRemote(`${sftpPathRef.current.replace(/\/+$/, "")}/${n}`); }}
          ><IconDownload size={12} /> 下载</button>
          <button role="menuitem" data-testid="sftp-menu-saveas"
            onClick={() => { const n = sftpMenu.name; setSftpMenu(null); void downloadRemote(`${sftpPathRef.current.replace(/\/+$/, "")}/${n}`, { saveAs: true }); }}
          ><IconInbox size={12} /> 另存为…</button>
        </div>
      )}
    </div>
  );
}
