// 设置面板（App.tsx 拆分②）：单实例八分类对话框（外观/快捷键/终端/输出触发器/凭据/Agent 接入/记录审计/关于）。
// 从 App.tsx 原样出仓——全部状态与动作仍归 App()（切分类草稿丢弃守卫、关闭即清草稿、
// useDialogFocus 焦点陷阱都留在宿主），本组件只收 props 呈现，零语义变更。
// 例外：P2-b 输出触发器卡的草稿态是**面板本地**（TriggersCard 内聚，关面板即弃），
// 与签发表单同工艺——设置类表单不该污染全局状态。
import { useEffect, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import {
  APP_VERSION,
  APPEARANCES, FONT_DEFAULT, FONT_MAX, FONT_MIN, PALETTES, SETTINGS_CATS,
  friendlyError,
  settingsCatIcon, settingsCatLabel,
  TERM_CURSOR_STYLES, TERM_FONTS, TERM_LETTER_SPACINGS, TERM_SCROLLBACKS,
  dateLocale,
  type Appearance, type SettingsCat, type TermCursorStyle,
} from "../app-data";
import {
  defaultKeymap, KEYMAP_ACTIONS, KEYMAP_SETTING, formatBinding, parseKeymap, sameBinding,
  type Binding, type KeyActionId,
} from "../keymap";
import { ZOOM_LEVELS, setZoomScale, zoomReset } from "../zoom";
import { isMacPlatform } from "../actions";
import { inTauri, invoke } from "../adapter/bridge";
import type { ActionRecord, AutonomyGrant, RecordsQuery, TriggerRule } from "../adapter/wire";
import type { CollabStatus, Host, IdentityMeta, IdentityReq, LocalShell, McpStatus, UpdateCheck, UpdaterInfo } from "../adapter/wire";
import { IconMinus, IconPlus, IconTrash, IconX } from "../icons";
import { SelfMeterDetail } from "../self-meter";
import { t, LOCALE_OPTIONS, type Locale } from "../i18n";
import { RecordsPane } from "./records-pane";
import { SecretInput } from "./secret-input";

// ── 设置草稿持久化（仅非机密字段）──────────────────────────────────────────
// 纪律：API Key、Token、密码、私钥**绝不**写入 localStorage/sessionStorage——机密
// 字段保持「关闭即丢」，重启后只能重填。这里只存 endpoint、模型名、provider、
// 凭据名称等非密钥输入；键名统一加前缀，读写失败（隐私模式/配额满）静默降级。
const DRAFT_KEY_PREFIX = "ui.settingsDraft.";

function readDraft(field: string): string | null {
  try { return localStorage.getItem(DRAFT_KEY_PREFIX + field); } catch { return null; }
}

function writeDraft(field: string, value: string): boolean {
  try {
    const key = DRAFT_KEY_PREFIX + field;
    if (value === "") localStorage.removeItem(key);
    else localStorage.setItem(key, value);
    return true;
  } catch { return false; } // 草稿持久化是可选项：失败不影响设置本身，由调用方提示
}

function clearDraft(...fields: string[]) {
  for (const field of fields) {
    try { localStorage.removeItem(DRAFT_KEY_PREFIX + field); } catch { /* 同上 */ }
  }
}

/** base_url 草稿落 Web Storage 前剥离潜在机密：兼容端点可能把 key 写进 userinfo
 *  或查询串。命中即返回空串（调用方写空=删除草稿），宁可下次重填也不明文持久化。 */
function draftUrlForStorage(raw: string): string {
  if (!raw) return "";
  try {
    const u = new URL(raw);
    if (u.username || u.password) return "";
    if (/(?:^|&)(?:api[_-]?key|key|token|secret|password|sig|signature)=/i.test(u.search.slice(1))) return "";
    return raw;
  } catch {
    return raw; // 尚未输完整的 URL：无可判定的机密语义
  }
}

/** 技能库未保存草稿（名称 + 正文，均非机密）；JSON 损坏时视为没有草稿。 */
function readSkillsDraft(): { name: string; body: string }[] | null {
  const raw = readDraft("agentSkills.draft");
  if (raw === null) return null;
  try {
    const arr = JSON.parse(raw) as unknown;
    if (!Array.isArray(arr)) return null;
    return arr
      .filter((s): s is Record<string, unknown> => !!s && typeof s === "object")
      .map((s) => ({ name: String(s.name ?? ""), body: String(s.body ?? "") }));
  } catch { return null; }
}

// ── 终端字体可用性检测（任务 1）────────────────────────────────────────────
// 选中字体族在本机不存在时，终端只会静默回退到字体栈后备，用户看不出「字体没装上」。
// 检测以 canvas measureText 宽度差异为准：同一段样例文本，装了字体与回退 generic
// 的宽度必然不同（monospace 同宽度的情况再以 serif 兜底复核，避免 Menlo 这类
// 「与系统 monospace 同度量」的误报）。document.fonts.check 只用于决定是否要显式
// load 内置 @font-face——系统字体可能 check 为 true 却实际量不出来，不能作准。
const FONT_PROBE_SENTINEL = "__tinyssh_font_probe_missing__";
const FONT_PROBE_SAMPLE = "mmmmmmmmmmlliWWW@#0123456789中文测试";
const FONT_PROBE_TOLERANCE = 0.5;

// 每个字体选项声明的「主字体」候选：任一存在即视为可用（如 Cascadia Mono / Code、
// SF Mono / Menlo / Monaco）。system = ui-monospace 通用关键字，恒可用，不检测。
const FONT_PROBE_FAMILIES: Record<string, string[]> = {
  maple: ["Maple Mono CN Term"],
  jetbrains: ["JetBrains Mono Term"],
  "jetbrains-nerd": ["JetBrainsMono Nerd Font", "JetBrainsMono NF"],
  cascadia: ["Cascadia Mono", "Cascadia Code"],
  consolas: ["Consolas"],
  menlo: ["SF Mono", "Menlo", "Monaco"],
  system: [],
};

let fontProbeCtx: CanvasRenderingContext2D | null | undefined;
function getFontProbeCtx(): CanvasRenderingContext2D | null {
  if (fontProbeCtx !== undefined) return fontProbeCtx;
  try { fontProbeCtx = document.createElement("canvas").getContext("2d"); }
  catch { fontProbeCtx = null; }
  return fontProbeCtx;
}

function cssFontFamily(name: string): string {
  return `"${name.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function measureFont(ctx: CanvasRenderingContext2D, familySpec: string): number {
  ctx.font = `72px ${familySpec}`;
  return ctx.measureText(FONT_PROBE_SAMPLE).width;
}

/** 单个字体族是否可用：与两种 generic 回退的宽度都无差异 → 视为未安装。 */
function fontFamilyAvailable(name: string): boolean {
  const ctx = getFontProbeCtx();
  if (!ctx) return true; // 量不了就不误报
  const quoted = cssFontFamily(name);
  // 哨兵：确认「不存在的字体 → 落到 generic」这条链路在当前环境成立；异常则不误报。
  const mono = measureFont(ctx, "monospace");
  if (Math.abs(measureFont(ctx, `${cssFontFamily(FONT_PROBE_SENTINEL)}, monospace`) - mono) > FONT_PROBE_TOLERANCE) {
    return true;
  }
  // monospace 同度量（如 macOS 选 Menlo）时，serif 回退仍会因等宽/比例字形而露差异。
  for (const generic of ["monospace", "serif"] as const) {
    const baseline = measureFont(ctx, generic);
    if (Math.abs(measureFont(ctx, `${quoted}, ${generic}`) - baseline) > FONT_PROBE_TOLERANCE) return true;
  }
  return false;
}

type FontProbeState = { fontId: string; missing: string[] };

/** 检测某字体选项：主字体候选全部缺失时返回候选名（用于就地提示）。 */
function probeTermFont(fontId: string): FontProbeState {
  const families = FONT_PROBE_FAMILIES[fontId] ?? [];
  if (families.length === 0) return { fontId, missing: [] };
  return { fontId, missing: families.some((f) => fontFamilyAvailable(f)) ? [] : families };
}

interface SettingsPanelProps {
  // 呈现框架
  settingsCat: SettingsCat;
  switchSettingsCat: (next: SettingsCat) => void;
  closeSettings: () => void;
  settingsPanelRef: { current: HTMLDivElement | null };
  appVersion: string | null;
  // i18n 轮：界面语言（宿主持有 state——变化触发全树重渲染刷新 t() 读数；持久化在宿主）
  locale: Locale;
  onChangeLocale: (l: Locale) => void;
  // 版本号轮：编译时间（build.rs 注入；演示域 null → 关于卡略去「编译于」段）
  buildTime: string | null;
  // 发布轮：版本检查结果（启动静默查一次；null=未返回或演示域未启用检查）
  updateInfo: UpdateCheck | null;
  // 发布轮：诊断包导出（动作在宿主，toast 带「打开所在文件夹」；本面板只呈现按钮）
  diagBusy: boolean;
  onExportDiagnostics: () => void;
  // updater 轮：自动更新能力面（demo 域 null；supported 只在 macOS+真公钥构建 true）
  updaterCap: UpdaterInfo | null;
  updaterBusy: boolean;
  onAutoUpdate: () => void;
  // 本轮：手动检测更新（启动自动检测之外的随时入口；结果 toast 三态如实）
  checkBusy: boolean;
  onCheckUpdate: () => void;
  // 外观与字号/缩放
  appearance: Appearance;
  changeAppearance: (a: Appearance) => void;
  palette: string;
  changePalette: (id: string) => void;
  fontSize: number;
  changeFontSize: (n: number) => void;
  zoomLevel: number;
  // 快捷键
  keymap: Record<KeyActionId, Binding>;
  /** 单条重置（宿主校验默认键是否已被别的动作占用，冲突则拒绝并提示） */
  resetKeyBinding: (id: KeyActionId) => void;
  keyCapture: KeyActionId | null;
  setKeyCapture: (v: KeyActionId | null) => void;
  applyKeymap: (km: Record<KeyActionId, Binding>) => void;
  persistSetting: (key: string, value: string) => void;
  // 终端行为
  pasteGuard: boolean;
  changePasteGuard: (v: boolean) => void;
  copyOnSelect: boolean;
  changeCopyOnSelect: (v: boolean) => void;
  bellNotify: boolean;
  changeBellNotify: (v: boolean) => void;
  // P2-c：OSC 52 写剪贴板策略（allow/ask/deny，默认 ask）
  osc52Policy: "allow" | "ask" | "deny";
  changeOsc52Policy: (v: "allow" | "ask" | "deny") => void;
  // 本地终端一等公民轮：本机默认 shell（id 空串=系统默认 $SHELL/PowerShell 回退）
  localShells: LocalShell[];
  localShellId: string;
  onChangeLocalShell: (id: string) => void;
  // 本地终端补充：启动自动打开（默认开；关掉后冷启动零本地 shell）
  autoLocal: boolean;
  onChangeAutoLocal: (on: boolean) => void;
  // P0 终端品质轮：外观五项 + 连字（状态与即时应用在宿主，本面板只呈现）
  termFont: string;
  onChangeTermFont: (id: string) => void;
  termLigatures: boolean;
  onChangeTermLigatures: (on: boolean) => void;
  termCursorStyle: TermCursorStyle;
  onChangeTermCursorStyle: (s: TermCursorStyle) => void;
  termCursorBlink: boolean;
  onChangeTermCursorBlink: (on: boolean) => void;
  termScrollback: number;
  onChangeTermScrollback: (n: number) => void;
  termLetterSpacing: number;
  onChangeTermLetterSpacing: (n: number) => void;
  // 凭据库（显式提交；草稿状态仍在宿主——切分类守卫与关闭清理都依赖它）
  identities: IdentityMeta[];
  hosts: Host[];
  referencedIdentityIds: Set<string>;
  credNewOpen: boolean;
  setCredNewOpen: (v: boolean) => void;
  credNewErr: string | null;
  setCredNewErr: (v: string | null) => void;
  credNewOk: IdentityMeta | null;
  setCredNewOk: (v: IdentityMeta | null) => void;
  credLabel: string;
  setCredLabel: (v: string) => void;
  credPem: string;
  setCredPem: (v: string) => void;
  credPass: string;
  setCredPass: (v: string) => void;
  credBusy: boolean;
  credErr: string | null;
  setCredErr: (v: string | null) => void;
  credDraftTo: SettingsCat | null;
  setCredDraftTo: (v: SettingsCat | null) => void;
  discardCredDraft: () => void;
  submitNewIdentity: (req: IdentityReq) => Promise<void>;
  setConfirm: (c: { kind: "deleteIdentity"; id: string; label: string } | null) => void;
  // Agent 接入
  collab: CollabStatus;
  mcp: McpStatus;
  // ② 自主模式：授权表 + 开关回调（宿主持有状态与调用）
  autonomy: AutonomyGrant[];
  onToggleAutonomy: (agentId: string, enable: boolean, ttlMinutes: number | null) => Promise<void>;
  collabEnabled: boolean;
  collabStateText: string;
  collabBusy: boolean;
  showAgentHelp: boolean;
  setShowAgentHelp: (v: boolean) => void;
  openDisableDialog: () => void;
  retryDisableConvergence: () => void;
  enableCollab: () => void;
  /** rev-r47：GUI 内签发 Token（返回值仅此一次展示）；expiresDays=null 永不过期 */
  issueAgent: (id: string, label: string, expiresDays: number | null) => Promise<string>;
  /** 未确认保存的一次性 Token 是否仍开着：宿主据此在关闭设置前拦一次（同凭据草稿守卫） */
  onIssuedTokenPending: (pending: boolean) => void;
  /** rev-r47：吊销 Agent（token 立即失效；已建会话控制权不受影响） */
  revokeAgent: (id: string) => Promise<void>;
  // ④ 记录审计：数据在宿主拉取（打开分区/筛选变化/刷新），本面板只呈现
  recordsRows: ActionRecord[] | null;
  recordsFilter: RecordsQuery;
  recordsBusy: boolean;
  recordsExportBusy: boolean;
  onRecordsFilter: (f: RecordsQuery) => void;
  onRecordsRefresh: () => void;
  onRecordsExport: () => void;
  /** ⑥ 翻页：true=最近一页满页（可能还有更早） */
  recordsHasMore: boolean;
  recordsMoreBusy: boolean;
  onRecordsMore: () => void;
  /** ⑨ 会话 id → 主机名（R41 累积面，含已关会话）：会话筛选 + 行内主机标注 */
  recordsSessionNames: Map<string, string>;
  /** ⑦ 记录保留天数（0=永久；改动重启后生效） */
  recordsRetention: number;
  onChangeRecordsRetention: (days: number) => void;
  // ⑤ 自主模式传输免审 opt-in（vault 设置持久；默认关=传输一律逐条审批）
  transferAutonomy: boolean;
  onChangeTransferAutonomy: (v: boolean) => void;
  /** P2-b 输出触发器：读（宿主包 invoke）/整卡保存（返回归一后的规则）。 */
  loadTriggers: () => Promise<TriggerRule[]>;
  saveTriggers: (rules: TriggerRule[]) => Promise<TriggerRule[]>;
}

export function SettingsPanel({
  settingsCat, switchSettingsCat, closeSettings, settingsPanelRef, appVersion, buildTime, locale, onChangeLocale,
  updateInfo, diagBusy, onExportDiagnostics, updaterCap, updaterBusy, onAutoUpdate, checkBusy, onCheckUpdate,
  appearance, changeAppearance, palette, changePalette, fontSize, changeFontSize, zoomLevel,
  keymap, resetKeyBinding, keyCapture, setKeyCapture, applyKeymap, persistSetting,
  pasteGuard, changePasteGuard, copyOnSelect, changeCopyOnSelect, bellNotify, changeBellNotify,
  osc52Policy, changeOsc52Policy,
  localShells, localShellId, onChangeLocalShell, autoLocal, onChangeAutoLocal,
  termFont, onChangeTermFont, termLigatures, onChangeTermLigatures,
  termCursorStyle, onChangeTermCursorStyle, termCursorBlink, onChangeTermCursorBlink,
  termScrollback, onChangeTermScrollback, termLetterSpacing, onChangeTermLetterSpacing,
  identities, hosts, referencedIdentityIds,
  credNewOpen, setCredNewOpen, credNewErr, setCredNewErr, credNewOk, setCredNewOk,
  credLabel, setCredLabel, credPem, setCredPem, credPass, setCredPass,
  credBusy, credErr, setCredErr, credDraftTo, setCredDraftTo, discardCredDraft, submitNewIdentity, setConfirm,
  collab, mcp, collabEnabled, collabStateText, collabBusy, showAgentHelp, setShowAgentHelp,
  openDisableDialog, retryDisableConvergence, enableCollab, issueAgent, onIssuedTokenPending, revokeAgent,
  autonomy, onToggleAutonomy,
  recordsRows, recordsFilter, recordsBusy, recordsExportBusy, onRecordsFilter, onRecordsRefresh, onRecordsExport,
  recordsHasMore, recordsMoreBusy, onRecordsMore, recordsSessionNames, recordsRetention, onChangeRecordsRetention,
  transferAutonomy, onChangeTransferAutonomy,
  loadTriggers, saveTriggers,
}: SettingsPanelProps) {
  // rev-r47：签发/吊销表单的**面板本地**临时态——关面板即弃（与宿主「关闭即清草稿」
  // 同语义；token 只在此刻的弹层展示一次，不进任何全局状态）。
  // 例外（任务 2）：id/名称/有效期都是非机密输入，跨关闭用 localStorage 草稿保留；
  // Token 本身仍然只在弹层展示一次，绝不落任何 Web Storage。
  const [agentForm, setAgentForm] = useState(() => {
    const expires = readDraft("agentIssue.expires");
    return {
      id: readDraft("agentIssue.id") ?? "",
      label: readDraft("agentIssue.label") ?? "",
      expires: expires === "1" || expires === "7" || expires === "30" ? expires : "",
    };
  });
  const [agentBusy, setAgentBusy] = useState(false);
  const [agentErr, setAgentErr] = useState<string | null>(null);
  const [issuedToken, setIssuedToken] = useState<{ id: string; token: string } | null>(null);
  const [tokenCopied, setTokenCopied] = useState(false);
  const [tokenCopyErr, setTokenCopyErr] = useState<string | null>(null);
  // 一次性 Token 是面板本地态：宿主不知道它的存在，关闭路径就无从拦截。
  // 显式上报「未确认保存」，让 closeSettings 在 Esc/✕/遮罩三条路上都能守一次。
  useEffect(() => {
    onIssuedTokenPending(!!issuedToken);
  }, [issuedToken, onIssuedTokenPending]);
  useEffect(() => { setTokenCopied(false); setTokenCopyErr(null); }, [issuedToken]);
  const [revokeArm, setRevokeArm] = useState<string | null>(null);
  // ② 自主模式：开启确认臂 + 每 Agent TTL 选择（面板本地临时态，与吊销臂同工艺）
  const [autonomyArm, setAutonomyArm] = useState<string | null>(null);
  // 确认臂 5 秒自动收回（与终端菜单的二次确认同工艺）：臂一直挂着，用户去倒杯水
  // 回来点一下「确认开启？」就进了自主模式——危险窗口不该无限期敞开。
  useEffect(() => {
    if (!autonomyArm) return;
    const timer = setTimeout(() => setAutonomyArm(null), 5000);
    return () => clearTimeout(timer);
  }, [autonomyArm]);
  const [autonomyTtl, setAutonomyTtl] = useState<Record<string, string>>({});
  // 终端字体可用性（任务 1）：只在终端分类可见时探测；结果按「字体 + 缺失集合」去重，
  // 防抖 150ms，并在 document.fonts.ready 后复核（内置 @font-face 可能异步加载）。
  const [fontProbe, setFontProbe] = useState<FontProbeState | null>(null);
  const [fontProbeNonce, setFontProbeNonce] = useState(0);
  const fontProbeSigRef = useRef("");
  useEffect(() => {
    if (settingsCat !== "terminal") return;
    let cancelled = false;
    const families = FONT_PROBE_FAMILIES[termFont] ?? [];
    const publish = () => {
      if (cancelled) return;
      const next = probeTermFont(termFont);
      const sig = `${next.fontId}:${next.missing.join("|")}`;
      if (sig === fontProbeSigRef.current) return; // 结果没变不触发渲染
      fontProbeSigRef.current = sig;
      setFontProbe(next);
    };
    const timer = setTimeout(() => {
      const fontSet = document.fonts;
      if (!fontSet) { publish(); return; }
      // 内置字体：check 为 false 时显式 load；系统字体 load 是即时 no-op。
      const loads = families
        .filter((f) => {
          try { return !fontSet.check(`12px ${cssFontFamily(f)}`); } catch { return false; }
        })
        .map((f) => fontSet.load(`12px ${cssFontFamily(f)}`).catch(() => [] as FontFace[]));
      // 等显式 load 与 document.fonts.ready 都落定再判决：内置字体未加载完就测会误报缺失。
      void Promise.all([...loads, fontSet.ready]).then(publish).catch(publish);
    }, 150);
    // 窗口聚焦回来时重测一次（用户可能刚在系统里装了字体，不必重开设置）。
    const onFocus = () => { if (!cancelled) publish(); };
    window.addEventListener("focus", onFocus);
    return () => {
      cancelled = true;
      clearTimeout(timer);
      window.removeEventListener("focus", onFocus);
    };
  }, [termFont, settingsCat, fontProbeNonce]);
  // 凭据表单只有「名称」是非机密字段：跨关闭保留草稿；私钥/口令保持「关闭即丢」，
  // 绝不写入 localStorage/sessionStorage（机密纪律）。表单重新展开且宿主内存态为空时
  // 回填一次——关闭设置时宿主会清空 credLabel，这里是恢复入口。
  useEffect(() => {
    if (!credNewOpen || credLabel !== "") return;
    const draft = readDraft("credential.label");
    if (draft) setCredLabel(draft);
    // 只跟随展开动作回填；credLabel 刻意不入依赖（否则用户手动清空会立刻被回填）。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [credNewOpen]);
  // 显式提交成功即清草稿（草稿使命结束；宿主的 credLabel 仍保持当前会话显示）。
  useEffect(() => {
    if (credNewOk) clearDraft("credential.label");
  }, [credNewOk]);

  const submitIssueAgent = async () => {
    if (agentBusy) return;
    const id = agentForm.id.trim();
    if (!id) { setAgentErr(t("请填写 Agent id（如 my-codex）")); return; }
    setAgentBusy(true);
    setAgentErr(null);
    try {
      const days = agentForm.expires ? Number(agentForm.expires) : null;
      const token = await issueAgent(id, agentForm.label.trim() || id, days);
      setIssuedToken({ id, token });
      setAgentForm({ id: "", label: "", expires: "" });
      clearDraft("agentIssue.id", "agentIssue.label", "agentIssue.expires");
    } catch (e) {
      setAgentErr(friendlyError(e));
    } finally {
      setAgentBusy(false);
    }
  };
  const doRevoke = async (id: string) => {
    setRevokeArm(null);
    // 吊销失败必须可见：此前空 catch 吞掉错误，Agent 行原样还在，用户以为已吊销
    try { await revokeAgent(id); } catch (e) { setAgentErr(friendlyError(e)); }
  };
  // 一次性 Token 复制：clipboard 可能不存在（非安全上下文/WebView 限制），
  // 可选链后的 .then 会直接抛 TypeError——此前 catch 空转，按钮毫无反应。
  const copyToken = async (text: string) => {
    try {
      if (!navigator.clipboard?.writeText) throw new Error("no clipboard");
      await navigator.clipboard.writeText(text);
      setTokenCopied(true);
      setTokenCopyErr(null);
    } catch {
      setTokenCopied(false);
      setTokenCopyErr(t("复制失败——请手动选中上方 Token 复制"));
    }
  };
  // 设置分类 tablist 键盘导航（WAI-ARIA tabs）：↑↓/←→ 循环、Home/End 首尾
  const onNavKey = (e: ReactKeyboardEvent<HTMLElement>) => {
    const forward = e.key === "ArrowDown" || e.key === "ArrowRight";
    const backward = e.key === "ArrowUp" || e.key === "ArrowLeft";
    if (!forward && !backward && e.key !== "Home" && e.key !== "End") return;
    e.preventDefault();
    const idx = SETTINGS_CATS.findIndex(([id]) => id === settingsCat);
    const next = e.key === "Home" ? 0
      : e.key === "End" ? SETTINGS_CATS.length - 1
      : (idx + (forward ? 1 : -1) + SETTINGS_CATS.length) % SETTINGS_CATS.length;
    const nextId = SETTINGS_CATS[next][0];
    switchSettingsCat(nextId);
    requestAnimationFrame(() => {
      document.querySelector<HTMLElement>(`[data-testid="settings-cat-${nextId}"]`)?.focus();
    });
  };
  return (
            <>
              <div className="pop-mask" onClick={closeSettings} />
              <div className="term-settings settings-wide" ref={settingsPanelRef} role="dialog" aria-modal="true" aria-label={t("设置")}>
                {/* 二十一轮：大气化——标题行带副题，导航带图标与一句话定位，内容卡片分区 */}
                <div className="settings-head">
                  <div className="settings-head-txt">
                    <b className="settings-title">{t("设置")}</b>
                    <span className="settings-sub">{t("外观、终端与凭据——预览即时生效，凭据显式提交")}</span>
                  </div>
                  <span style={{ flex: 1 }} />
                  <button className="ghost" title={t("关闭")} aria-label={t("关闭设置")} data-testid="settings-close" onClick={closeSettings}><IconX size={13} /></button>
                </div>
                {/* §231：单个对话框，左分类 + 右内容；外观/终端偏好即时预览，凭据显式提交 */}
                <div className="settings-body">
                  <nav className="settings-nav" role="tablist" aria-label={t("设置分类")} onKeyDown={onNavKey}>
                    {SETTINGS_CATS.map(([id, label, desc]) => {
                      const Ic = settingsCatIcon[id];
                      return (
                        <button key={id} role="tab" data-testid={`settings-cat-${id}`}
                          data-autofocus={settingsCat === id ? true : undefined}
                          aria-selected={settingsCat === id} className={settingsCat === id ? "on" : ""}
                          onClick={() => switchSettingsCat(id)}>
                          <span className="set-ic"><Ic size={15} /></span>
                          <span className="set-nav-txt">
                            <span>{t(label)}</span>
                            <span className="set-nav-desc">{t(desc)}</span>
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
                  <h4>{t("应用外观")}</h4>
                  <div className="set-desc">{t("主题同时决定应用外壳与终端配色（底色/前景/光标/ANSI 16 色全部随当前色板与深浅派生，终端八色按族调相）；主按钮与指示件走鲜艳填充档（浅色下不再为可读性压暗）；「跟随系统」随系统深浅实时切换。")}</div>
                  <div className="row ts-appearance" role="group" aria-label={t("应用外观")}>
                    {APPEARANCES.map((a) => (
                      <button key={a.id} className={"ghost" + (appearance === a.id ? " ts-active" : "")}
                        aria-pressed={appearance === a.id}
                        onClick={() => changeAppearance(a.id)}>{t(a.label)}</button>
                    ))}
                  </div>
                  <div className="ts-label" style={{ marginTop: 14 }}>{t("主题")}</div>
                  <div className="ts-themes cols3" role="group" aria-label={t("主题")}>
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
                        {t(p.label)}
                      </button>
                    ))}
                  </div>
                  {/* i18n 轮：界面语言（宿主持 state，切换即全树重渲染刷新 t() 读数；
                      双域持久化在宿主 persistSetting） */}
                  <div className="set-item" style={{ marginTop: 14 }}>
                    <span className="set-item-txt">
                      <b>{t("界面语言")}</b>
                      <span className="set-item-desc">{t("默认跟随系统语言，切换立即生效；未覆盖文案保持中文。")}</span>
                    </span>
                    <select className="set-item-ctl" data-testid="locale-select" aria-label={t("界面语言")}
                      value={locale} onChange={(e) => onChangeLocale(e.target.value as Locale)}>
                      {LOCALE_OPTIONS.map((o) => <option key={o.id} value={o.id}>{t(o.label)}</option>)}
                    </select>
                  </div>
                </div>
                <div className="set-card">
                  <h4>{t("字号与缩放")}</h4>
                  <div className="set-desc">{t("字号作用于全部终端；缩放作用于整个界面（webview）。")}</div>
                  <div className="row">
                    <button className="ghost" title={t("减小字号")} aria-label={t("减小字号")} disabled={fontSize <= FONT_MIN} onClick={() => changeFontSize(fontSize - 1)}><IconMinus size={13} /></button>
                    <span className="ts-val mono">{fontSize}</span>
                    <button className="ghost" title={t("增大字号")} aria-label={t("增大字号")} disabled={fontSize >= FONT_MAX} onClick={() => changeFontSize(fontSize + 1)}><IconPlus size={13} /></button>
                    <button className="ghost" disabled={fontSize === FONT_DEFAULT} onClick={() => changeFontSize(FONT_DEFAULT)}>{t("重置")}</button>
                  </div>
                  {/* UX 五轮：整页缩放（参考 tiny-worker）——webview 缩放，浏览器 demo
                      不渲染（浏览器自带缩放；zoom.ts 亦不注册键盘/滚轮路径） */}
                  {inTauri && (<>
                  <div className="ts-label" style={{ marginTop: 12 }}>{t("界面缩放")}</div>
                  <div className="row" style={{ marginTop: 4 }}>
                    <select value={zoomLevel} aria-label={t("界面缩放")}
                      onChange={(e) => setZoomScale(Number(e.target.value))}>
                      {[...new Set([...ZOOM_LEVELS, zoomLevel])].sort((a, b) => a - b).map((z) => (
                        <option key={z} value={z}>{Math.round(z * 100)}%</option>
                      ))}
                    </select>
                    <button className="ghost" disabled={zoomLevel === 1} onClick={() => zoomReset()}>{t("重置")}</button>
                  </div>
                  </>)}
                  <div className="dim" style={{ marginTop: 8, fontSize: 11 }}>{t("界面缩放：Ctrl/⌘ + 放大 · − 缩小 · 0 复位 · Ctrl+滚轮（原生窗口生效）")}</div>
                </div>
                </>)}

                {settingsCat === "keys" && (<>
                {/* 键位配置轮：六个可重绑动作 + 固定键位说明。录入=点修改后按组合；
                    冲突拒绝、单条重置；表持久化 ui.keymap.v1（demo=localStorage） */}
                <div className="set-card">
                  <h4>{t("应用快捷键")}</h4>
                  <div className="set-desc">{t(inTauri
                    ? "点「修改」后按下新组合（Ctrl/⌘ + 字母，可加 Shift），Esc 取消。被占用的字母不再发往终端——同名 shell 控制键让位（如 Ctrl+D=分屏后，EOF 请用 exit）；Ctrl+B 始终留给终端（tmux 前缀键），不可占用。固定键位：Ctrl+1-9 切换标签 · Ctrl+Tab 循环 · Ctrl/⌘ ±/0 缩放 · Esc 关浮层 · F11 专注模式。"
                    : "点「修改」后按下新组合（Ctrl/⌘ + 字母，可加 Shift），Esc 取消。被占用的字母不再发往终端——同名 shell 控制键让位（如 Ctrl+D=分屏后，EOF 请用 exit）；Ctrl+B 始终留给终端（tmux 前缀键），不可占用。固定键位：Esc 关浮层；Ctrl+1-9 切换标签 · Ctrl+Tab 循环 · Ctrl/⌘ ±/0 缩放 · F11 专注模式在桌面版生效（浏览器演示里归浏览器语义）。")}</div>
                  <div className="km-rows" role="group" aria-label={t("快捷键绑定")}>
                    {KEYMAP_ACTIONS.map(({ id, label, desc }) => {
                      const capturing = keyCapture === id;
                      return (
                        <div className="km-row" key={id} data-testid={`keymap-row-${id}`}>
                          <span className="km-name">
                            <b>{t(label)}</b>
                            <span className="set-item-desc">{t(desc)}</span>
                          </span>
                          <span className="km-key mono" data-testid={`keymap-key-${id}`}>
                            {capturing ? t("按下新组合…") : formatBinding(keymap[id], isMacPlatform())}
                          </span>
                          {capturing ? (
                            <button className="ghost" data-testid={`keymap-cancel-${id}`} onClick={() => setKeyCapture(null)}>{t("取消")}</button>
                          ) : (
                            <>
                              <button className="ghost" data-testid={`keymap-edit-${id}`} onClick={() => setKeyCapture(id)}>{t("修改")}</button>
                              <button className="ghost" data-testid={`keymap-reset-${id}`}
                                disabled={sameBinding(keymap[id], defaultKeymap(isMacPlatform())[id])}
                                onClick={() => resetKeyBinding(id)}>{t("重置")}</button>
                            </>
                          )}
                        </div>
                      );
                    })}
                  </div>
                  <div className="row" style={{ marginTop: 12 }}>
                    <button className="ghost" data-testid="keymap-reset-all"
                      disabled={KEYMAP_ACTIONS.every(({ id }) => sameBinding(keymap[id], defaultKeymap(isMacPlatform())[id]))}
                      onClick={() => {
                        applyKeymap(parseKeymap(null, isMacPlatform()));
                        persistSetting(KEYMAP_SETTING, JSON.stringify(parseKeymap(null, isMacPlatform())));
                      }}>{t("全部恢复默认")}</button>
                  </div>
                </div>
                </>)}

                {settingsCat === "terminal" && (<>
                {/* 二十二轮：单卡三条紧凑设置行（set-item）——卡片不再一卡一开关铺空；
                    开关与测试锚点不变 */}
                <div className="set-card">
                  <h4>{t("终端行为")}</h4>
                  <label className="set-item">
                    <input type="checkbox" checked={pasteGuard} onChange={(e) => changePasteGuard(e.target.checked)} />
                    <span className="set-item-txt">
                      <b>{t("多行粘贴保护")}</b>
                      <span className="set-item-desc">{t("内容含换行且远端未开启 bracketed paste 时，先预览确认再发送，防止把本地多行文本误当命令流灌进远端；内容命中危险形态（如 rm -rf /、mkfs、dd 覆写块设备——与 Agent 审批同一张内置规则表）时同样先确认。关闭后立即发送。")}</span>
                    </span>
                  </label>
                  <label className="set-item">
                    <input type="checkbox" data-testid="cos-toggle" checked={copyOnSelect} onChange={(e) => changeCopyOnSelect(e.target.checked)} />
                    <span className="set-item-txt">
                      <b>{t("选中即复制")}</b>
                      <span className="set-item-desc">{t("划选终端文字立即写入系统剪贴板（PuTTY/Xshell 惯例，默认关）；关闭后用 ⌘C 或右键「复制」。")}</span>
                    </span>
                  </label>
                  <label className="set-item">
                    <input type="checkbox" data-testid="bell-toggle" checked={bellNotify} onChange={(e) => changeBellNotify(e.target.checked)} />
                    <span className="set-item-txt">
                      <b>{t("终端响铃时系统通知")}</b>
                      <span className="set-item-desc">{t("窗口不在前台时收到远端 BEL（如长命令完成）即发系统通知，每会话 10 秒至多一条；标签闪烁提醒恒开。远端 OSC 9 主动通知、后台会话命令失败（shell 集成 OSC 133 退出码）走同一开关与节流。")}</span>
                    </span>
                  </label>
                  <div className="set-item">
                    <span className="set-item-txt">
                      <b>{t("远端写剪贴板（OSC 52）")}</b>
                      <span className="set-item-desc">{t("远端程序可用转义序列改写你本机剪贴板——tmux/ssh 里复制回本地靠它，也可能被用来投毒（悄悄替换你将要粘贴的内容）。读取类请求（查询）一律拒绝；写入按此策略执行，「拒绝」为静默丢弃。")}</span>
                    </span>
                    <select className="set-item-ctl" data-testid="osc52-select" aria-label={t("OSC 52 写剪贴板策略")}
                      value={osc52Policy} onChange={(e) => changeOsc52Policy(e.target.value as "allow" | "ask" | "deny")}>
                      <option value="ask">{t("每次询问（默认）")}</option>
                      <option value="allow">{t("允许")}</option>
                      <option value="deny">{t("拒绝")}</option>
                    </select>
                  </div>
                  {/* 本地终端一等公民轮：本机默认 shell——启动自动开的本地终端与本机卡
                      「连接」用此 shell；本机右键可临时用指定 shell 新开（不改默认） */}
                  <label className="set-item">
                    <input type="checkbox" data-testid="auto-local-toggle" checked={autoLocal}
                      onChange={(e) => onChangeAutoLocal(e.target.checked)} />
                    <span className="set-item-txt">
                      <b>{t("启动时自动打开本地终端")}</b>
                      <span className="set-item-desc">{t("冷启动后自动开一个本机终端（真实模式）；关闭后启动不再起本地 shell，需要时从「本机」卡、⌘K 或快捷键手动打开。")}</span>
                    </span>
                  </label>
                  <div className="set-item">
                    <span className="set-item-txt">
                      <b>{t("本地 Shell")}</b>
                      <span className="set-item-desc">{t("本地终端（含启动时自动打开的那个）使用的 shell。标注「无命令块」的 shell（cmd、WSL）无 shell 集成——命令块、现场延续与 Shell 模式执行不可用，如实降级为纯终端。")}</span>
                    </span>
                    <select className="set-item-ctl" data-testid="local-shell-select" aria-label={t("本地 Shell")}
                      value={localShellId} onChange={(e) => onChangeLocalShell(e.target.value)}>
                      <option value="">{t("系统默认（$SHELL / PowerShell）")}</option>
                      {localShells.map((s) => (
                        <option key={s.id} value={s.id}>{s.name}{s.integrable ? "" : t("（无命令块）")}</option>
                      ))}
                    </select>
                  </div>
                </div>
                {/* P0 终端品质轮：外观五项 + 连字——即时应用到全部终端（新实例继承） */}
                <div className="set-card">
                  <h4>{t("终端外观")}</h4>
                  <div className="set-desc">
                    {t("作用于全部终端，改动即时生效；字体族/字距改变字符度量，会重排版并按新尺寸校准远端 PTY。")}
                  </div>
                  <div className="set-item">
                    <span className="set-item-txt">
                      <b>{t("字体")}</b>
                      <span className="set-item-desc">{t("默认内置 Maple Mono 圆润中文等宽（中文输出对齐不落宋体）；JetBrains Mono 全量字形（框线/箭头/powerline）；其余选项按系统是否安装回落，中文一律垫 MiSans/雅黑。")}</span>
                    </span>
                    <select className="set-item-ctl" data-testid="term-font-select" aria-label={t("终端字体")}
                      value={termFont} onChange={(e) => onChangeTermFont(e.target.value)}>
                      {TERM_FONTS.map((f) => <option key={f.id} value={f.id}>{t(f.label)}</option>)}
                    </select>
                  </div>
                  {/* 字体缺失就地提示：不阻塞选择、不改已写入的值；只陈述检测事实 */}
                  {fontProbe && fontProbe.fontId === termFont && fontProbe.missing.length > 0 && (
                    <div className="set-item-desc" data-testid="term-font-missing" role="status"
                      style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: 6, color: "var(--warn-text)" }}>
                      <span>
                        {t("本机未检测到 {0}，终端将回退到字体栈中的后备等宽字体；安装该字体后点「重新检测」或重开设置即可刷新。",
                          fontProbe.missing.join(" / "))}
                      </span>
                      <button className="ghost" data-testid="term-font-recheck"
                        onClick={() => setFontProbeNonce((n) => n + 1)}>{t("重新检测")}</button>
                    </div>
                  )}
                  <label className="set-item">
                    <input type="checkbox" data-testid="term-liga-toggle" checked={termLigatures} onChange={(e) => onChangeTermLigatures(e.target.checked)} />
                    <span className="set-item-txt">
                      <b>{t("连字（ligatures）")}</b>
                      <span className="set-item-desc">{t("把 =&gt;、!=、&gt;= 等合成连字图形（字体需含连字字形）。开启即改用 DOM 渲染器（关闭 GPU 合成），高吞吐输出时 CPU 占用更高——默认关。")}</span>
                    </span>
                  </label>
                  <div className="set-item">
                    <span className="set-item-txt">
                      <b>{t("光标样式")}</b>
                      <span className="set-item-desc">{t("默认光标形状；vim 等程序可在其运行期自行覆盖。")}</span>
                    </span>
                    <select className="set-item-ctl" data-testid="term-cursor-select" aria-label={t("光标样式")}
                      value={termCursorStyle} onChange={(e) => onChangeTermCursorStyle(e.target.value as TermCursorStyle)}>
                      {TERM_CURSOR_STYLES.map((c) => <option key={c.id} value={c.id}>{t(c.label)}</option>)}
                    </select>
                  </div>
                  <label className="set-item">
                    <input type="checkbox" data-testid="term-cursor-blink-toggle" checked={termCursorBlink} onChange={(e) => onChangeTermCursorBlink(e.target.checked)} />
                    <span className="set-item-txt">
                      <b>{t("光标闪烁")}</b>
                      <span className="set-item-desc">{t("关闭后光标恒亮不闪。")}</span>
                    </span>
                  </label>
                  <div className="set-item">
                    <span className="set-item-txt">
                      <b>{t("滚动历史")}</b>
                      <span className="set-item-desc">{t("每会话回滚缓冲行数；越大越吃内存（长构建 / 大日志建议 5 万行以上）。")}</span>
                    </span>
                    <select className="set-item-ctl" data-testid="term-scrollback-select" aria-label={t("滚动历史行数")}
                      value={String(termScrollback)} onChange={(e) => onChangeTermScrollback(Number(e.target.value))}>
                      {TERM_SCROLLBACKS.map((n) => (
                        <option key={n} value={String(n)}>{n === 10000 ? t("10,000 行（默认）") : t("{0} 行", n.toLocaleString("en-US"))}</option>
                      ))}
                    </select>
                  </div>
                  <div className="set-item">
                    <span className="set-item-txt">
                      <b>{t("字距")}</b>
                      <span className="set-item-desc">{t("额外字符间距（px）；0 为字体原生度量。")}</span>
                    </span>
                    <select className="set-item-ctl" data-testid="term-spacing-select" aria-label={t("字符间距")}
                      value={String(termLetterSpacing)} onChange={(e) => onChangeTermLetterSpacing(Number(e.target.value))}>
                      {TERM_LETTER_SPACINGS.map((n) => <option key={n} value={String(n)}>{n === 0 ? t("0（默认）") : String(n)}</option>)}
                    </select>
                  </div>
                </div>
                </>)}

                {/* 草稿跨分类存活（审查轮 P2）：触发器卡是面板本地草稿态，切分类
                    若卸载组件，未保存的编辑静默蒸发。常挂 + 隐藏：组件不卸载，
                    切回来草稿还在；关设置仍按草稿语义丢弃。 */}
                <div style={{ display: settingsCat === "triggers" ? undefined : "none" }}>
                  <TriggersCard load={loadTriggers} save={saveTriggers} />
                </div>

                {settingsCat === "credentials" && (<>
                {/* R41（§231/§238/§267）设置 → 凭据：创建/删除/授权使用**显式提交**
                    （不即时保存）；未绑定态明确；删除前检查引用，不破坏其他主机认证。 */}
                <div className="set-card">
                <div className="row" style={{ alignItems: "center" }}>
                  <h4 style={{ margin: 0 }}>{t("凭据库")}</h4>
                  <span style={{ flex: 1 }} />
                  <button className="ghost" data-testid="cred-new"
                    onClick={() => { setCredNewOpen(!credNewOpen); setCredNewErr(null); setCredNewOk(null); }}>
                    {credNewOpen ? t("收起") : t("新建凭据…")}
                  </button>
                </div>
                {credErr && <div className="err" style={{ marginTop: 4, fontSize: 12 }} data-testid="cred-err">✕ {credErr}</div>}
                {credNewOpen && (
                  <div className="cred-new" data-testid="cred-new-form">
                    <label className="cred-field">{t("名称")}
                      <input value={credLabel} data-testid="cred-new-label" placeholder={t("例如 prod-key")}
                        onChange={(e) => {
                          setCredLabel(e.target.value);
                          writeDraft("credential.label", e.target.value);
                        }} />
                    </label>
                    <div className="row" style={{ marginTop: 6, gap: 6 }}>
                      <button className="ghost" disabled={credBusy} data-testid="cred-new-gen-ed"
                        onClick={() => void submitNewIdentity({ Generate: { label: credLabel.trim() || t("新密钥"), kind: "Ed25519" } })}>{t("生成 Ed25519")}</button>
                      <button className="ghost" disabled={credBusy} data-testid="cred-new-gen-rsa"
                        onClick={() => void submitNewIdentity({ Generate: { label: credLabel.trim() || t("新密钥"), kind: "Rsa" } })}>{t("生成 RSA")}</button>
                    </div>
                    <label className="cred-field" style={{ marginTop: 8 }}>{t("粘贴私钥（OpenSSH / PEM）")}
                      <textarea value={credPem} data-testid="cred-new-pem" rows={4}
                        placeholder="-----BEGIN OPENSSH PRIVATE KEY-----" onChange={(e) => setCredPem(e.target.value)} />
                    </label>
                    <label className="cred-field">{t("私钥口令（没有可留空）")}
                      <SecretInput value={credPass} data-testid="cred-new-pass" autoComplete="off"
                        onChange={(e) => setCredPass(e.target.value)} />
                    </label>
                    <div className="row" style={{ marginTop: 6, gap: 6 }}>
                      <button disabled={credBusy} data-testid="cred-new-import"
                        onClick={() => void submitNewIdentity({ Import: { label: credLabel.trim() || t("导入密钥"), pem: credPem, passphrase: credPass || null } })}>
                        {credBusy ? t("处理中…") : t("导入并保存")}
                      </button>
                      <button className="ghost" disabled={credBusy} data-testid="cred-new-cancel"
                        onClick={() => { setCredPem(""); setCredPass(""); setCredNewErr(null); setCredNewOpen(false); }}>{t("取消")}</button>
                    </div>
                    <div className="dim" style={{ marginTop: 4, fontSize: 11 }}>
                      {t("只有点「生成」或「导入并保存」才落库；取消或关闭对话框都不会留下半成品。")}
                    </div>
                    {credNewErr && <div className="err" style={{ marginTop: 4, fontSize: 12 }} data-testid="cred-new-err">✕ {credNewErr}</div>}
                    {credNewOk && (
                      <div className="ok" style={{ marginTop: 4, fontSize: 12 }} data-testid="cred-new-ok">
                        {t("已保存「{0}」·", credNewOk.label)} {t("指纹")} <span className="mono">{credNewOk.fingerprint}</span>
                      </div>
                    )}
                  </div>
                )}
                {credDraftTo && (
                  <div className="cred-draft" data-testid="cred-draft">
                    <div>{t("凭据表单里还有未提交的私钥内容——切到「{0}」会丢弃它。", settingsCatLabel(credDraftTo))}</div>
                    <div className="row" style={{ marginTop: 6, gap: 6 }}>
                      <button data-testid="cred-draft-discard" onClick={() => { clearDraft("credential.label"); discardCredDraft(); }}>{t("丢弃草稿并切换")}</button>
                      <button className="ghost" data-testid="cred-draft-keep" onClick={() => setCredDraftTo(null)}>{t("留下继续编辑")}</button>
                    </div>
                  </div>
                )}
                {identities.length === 0 ? (
                  <div className="dim cred-empty" style={{ marginTop: 4, fontSize: 12 }} data-testid="cred-empty">
                    {t("还没有凭据——用右上角的「新建凭据…」生成或导入私钥，也可以在连接表单里保存。")}
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
                            ? <span className="cred-bound">{t("使用中")}</span>
                            : <span className="cred-unbound" title={t("未被任何主机引用——保留在库中，可在表单里绑定")}>{t("未绑定")}</span>}
                          <button className="ghost host-del" title={t("删除凭据（被引用会被拒绝并列出主机）")}
                            aria-label={t("删除凭据 {0}", it.label)}
                            onClick={() => { setCredErr(null); setConfirm({ kind: "deleteIdentity", id: it.id, label: it.label }); }}>
                            <IconTrash size={12} />
                          </button>
                        </div>
                        <div className="cred-sub">
                          <span className="cred-kind">{it.kind === "Password" ? t("密码") : it.kind === "Rsa" ? t("RSA 密钥") : t("Ed25519 密钥")}</span>
                          <span className="mono cred-fp" title={it.fingerprint}>{it.fingerprint}</span>
                        </div>
                        {/* §267「授权使用」：绑定在主机表单里显式选择，这里如实列出占用者 */}
                        {boundTo.length > 0 && (
                          <div className="cred-uses" data-testid="cred-uses">{t("用于：{0}（换绑请到对应主机的编辑表单）", boundTo.join(t("、")))}</div>
                        )}
                      </div>
                      );
                    })}
                    <div className="dim" style={{ marginTop: 4, fontSize: 11 }}>
                      {t("删除前自动检查引用；指纹用于核对库里存的是哪把钥匙，不会出现在日志里。")}
                    </div>
                  </div>
                )}
                </div>
                </>)}

                {/* 模型/技能卡同款跨分类存活：切走只隐藏不卸载，未保存的表单
                    （模型服务、技能库草稿）在切回来时仍在。 */}
                <div style={{ display: settingsCat === "agent" ? undefined : "none" }}>
                  {/* 接真模型轮：内置 Agent 对话的模型服务（本卡草稿态面板本地） */}
                  <AgentModelCard />
                  {/* 提示词/技能资产化轮：附加提示词 + 技能库（改动即存 KV，面板本地） */}
                  <PromptSkillsCard />
                </div>

                {settingsCat === "agent" && (<>
                {/* R42（§5 迁移表/§6.7）：Agent 接入、端点、Token 从协作面板移入
                    「设置 → Agent 接入」——新装未启用协作时主界面不再出现 MCP 配置。
                    C9（R43）：本面板是协作**启用生命周期**的人类专属入口（启用/停用）。 */}
                <div className="set-card">
                <h4 style={{ margin: "0 0 6px" }}>{t("Agent 接入（MCP）")}</h4>
                {/* §9：仅有登记身份 ≠ Agent 在线——「已配置」与「有活动请求」分别显示 */}
                <div className="fact" style={{ marginTop: 6 }} data-testid="collab-state-row">
                  <span className={"badge " + (collabEnabled ? "ok" : "err")} data-testid="collab-state">{collabStateText}</span>
                  <span className="dim" style={{ fontSize: 11 }} data-testid="collab-configured">{t("已配置 {0}", collab.configured_agents)}</span>
                  <span className="dim" style={{ fontSize: 11 }} data-testid="collab-active">{t("有活动请求 {0}", collab.active_requests)}</span>
                </div>
                {collabEnabled ? (<>
                <div style={{ fontSize: 12, lineHeight: 1.8 }}>
                  {t("MCP 端点随本应用自动运行。为 Agent 签发 Token 后，它的操作请求会进入协作面板逐条审批。")}
                </div>
                {/* rev-r47：GUI 内签发——id/名称/有效期，token 仅在下方弹层展示一次 */}
                <div style={{ marginTop: 8, display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center" }} data-testid="agent-issue-form">
                  <input
                    className="mono" style={{ fontSize: 11, width: 130 }}
                    placeholder={t("id（如 my-codex）")} aria-label={t("Agent id")}
                    value={agentForm.id}
                    onChange={(e) => {
                      setAgentForm({ ...agentForm, id: e.target.value });
                      writeDraft("agentIssue.id", e.target.value);
                    }}
                  />
                  <input
                    style={{ fontSize: 11, width: 110 }}
                    placeholder={t("名称（可选）")} aria-label={t("Agent 名称")}
                    value={agentForm.label}
                    onChange={(e) => {
                      setAgentForm({ ...agentForm, label: e.target.value });
                      writeDraft("agentIssue.label", e.target.value);
                    }}
                  />
                  <select
                    style={{ fontSize: 11 }}
                    aria-label={t("Token 有效期")}
                    value={agentForm.expires}
                    onChange={(e) => {
                      setAgentForm({ ...agentForm, expires: e.target.value });
                      writeDraft("agentIssue.expires", e.target.value);
                    }}
                  >
                    <option value="">{t("永不过期")}</option>
                    <option value="30">{t("{0} 天有效", 30)}</option>
                    <option value="7">{t("{0} 天有效", 7)}</option>
                    <option value="1">{t("{0} 天有效", 1)}</option>
                  </select>
                  <button className="ghost" disabled={agentBusy} data-testid="agent-issue-btn" onClick={() => void submitIssueAgent()}>
                    {t("签发 Token")}
                  </button>
                </div>
                {agentErr && <div className="err" style={{ fontSize: 11, marginTop: 4 }}>{agentErr}</div>}
                {issuedToken && (
                  <div className="card" style={{ marginTop: 8, padding: 10, border: "1px solid var(--accent-glow)", borderRadius: 8 }} data-testid="agent-token-once">
                    <div style={{ fontSize: 12 }}><b>{t("Token 已签发（{0}）——仅此一次展示", issuedToken.id)}</b></div>
                    <pre className="mono" style={{ fontSize: 11, userSelect: "all", WebkitUserSelect: "all", whiteSpace: "pre-wrap", margin: "6px 0" }}>{issuedToken.token}</pre>
                    <div style={{ display: "flex", gap: 6 }}>
                      <button className="ghost" data-testid="agent-token-copy" onClick={() => void copyToken(issuedToken.token)}>{tokenCopied ? t("已复制") : t("复制 Token")}</button>
                      <button className="ghost" data-testid="agent-token-close" onClick={() => setIssuedToken(null)}>{t("我已保存，关闭")}</button>
                    </div>
                    <div className="dim" style={{ fontSize: 11, marginTop: 4 }}>{t("现在复制并填入 Agent 配置；关闭后无法再次查看（可吊销后重签）。")}</div>
                    {tokenCopyErr && <div className="err" role="alert" style={{ fontSize: 11, marginTop: 4 }}>{tokenCopyErr}</div>}
                  </div>
                )}
                {mcp.agents_detail && mcp.agents_detail.length > 0 ? (
                  <div style={{ marginTop: 6 }} data-testid="agent-list">
                    {mcp.agents_detail.map((a) => (
                      <div className="fact" key={a.id} data-testid="agent-row" style={{ display: "flex", alignItems: "center", gap: 6 }}>
                        <span className="s">{a.label}</span>
                        {a.id !== a.label && <span className="dim mono" style={{ fontSize: 10 }}> · id {a.id}</span>}
                        <span className="dim" style={{ fontSize: 10 }}>
                          {a.last_used_at
                            ? ` · ${t("最近使用 {0}", new Date(a.last_used_at).toLocaleString(dateLocale()))}`
                            : ` · ${t("从未使用")}`}
                          {a.expires_at ? ` · ${new Date(a.expires_at) <= new Date() ? t("已过期") : t("过期 {0}", new Date(a.expires_at).toLocaleDateString(dateLocale()))}` : ""}
                        </span>
                        <span style={{ flex: 1 }} />
                        {/* ② 自主模式开关：开启带 TTL 选择；危险形态命令仍被 deny 硬拦，
                            传输仍逐条审批；急停走横幅或这里关闭 */}
                        {(() => {
                          const grant = autonomy.find((g) => g.agent_id === a.id);
                          const ttlSel = autonomyTtl[a.id] ?? "30";
                          return grant ? (
                            <button className="warn" style={{ fontSize: 11 }} data-testid={`autonomy-off-${a.id}`}
                              title={t("立即收回该 Agent 的免逐条审批授权")}
                              onClick={() => void onToggleAutonomy(a.id, false, null)}>{t("关闭自主")}</button>
                          ) : (
                            <>
                              <select style={{ fontSize: 10 }} aria-label={t("自主模式时长")}
                                value={ttlSel}
                                onChange={(e) => setAutonomyTtl({ ...autonomyTtl, [a.id]: e.target.value })}>
                                <option value="30">{t("{0} 分钟", 30)}</option>
                                <option value="120">{t("{0} 小时", 2)}</option>
                                <option value="manual">{t("手动关闭")}</option>
                              </select>
                              {autonomyArm === a.id ? (
                                <button className="warn" style={{ fontSize: 11 }} data-testid={`autonomy-on-confirm-${a.id}`}
                                  title={t("开启后该 Agent 的命令不再逐条审批（危险命令仍拦截、全量记录）")}
                                  onClick={() => { setAutonomyArm(null); void onToggleAutonomy(a.id, true, ttlSel === "manual" ? null : Number(ttlSel)); }}>
                                  {t("确认开启？")}
                                </button>
                              ) : (
                                <button className="ghost" style={{ fontSize: 11 }} data-testid={`autonomy-on-${a.id}`}
                                  title={t("免逐条审批的自主运行（危险命令仍拦截、全量记录、可急停）")}
                                  onClick={() => setAutonomyArm(a.id)}>{t("自主模式")}</button>
                              )}
                            </>
                          );
                        })()}
                        {revokeArm === a.id ? (
                          <button className="ghost" style={{ color: "var(--danger)", fontSize: 11 }} data-testid="agent-revoke-confirm"
                            onClick={() => void doRevoke(a.id)}>{t("确认吊销？")}</button>
                        ) : (
                          <button className="ghost" style={{ fontSize: 11 }} data-testid="agent-revoke"
                            title={t("吊销后 token 立即失效（Agent 侧报 invalid_actor）")}
                            onClick={() => setRevokeArm(a.id)}>{t("吊销")}</button>
                        )}
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="dim" style={{ fontSize: 12, marginTop: 6 }} data-testid="agent-empty">
                    {t("暂无 Agent 接入——上方表单签发 Token 即完成登记。")}
                  </div>
                )}
                {/* ⑤ 传输免审 opt-in：全局一个开关（对全部 Agent 生效），默认最保守。
                    危险形态命令的 deny 硬拦不受影响；免审期间传输全部留审计+记录。 */}
                <div className="fact" style={{ marginTop: 6, display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                  <span className="dim" style={{ fontSize: 11 }}>{t("自主模式下的文件传输")}</span>
                  <button
                    className={"ghost" + (transferAutonomy ? " warn" : "")}
                    style={{ fontSize: 11 }}
                    data-testid="autonomy-transfers-toggle"
                    title={t("默认传输逐条审批（最保守）。打开后：自主模式在效期间的传输不再逐条弹卡——审计与记录照常，随时刻关。")}
                    onClick={() => onChangeTransferAutonomy(!transferAutonomy)}
                  >
                    {transferAutonomy ? t("免逐条审批（点击恢复审批）") : t("逐条审批（点击改免审）")}
                  </button>
                </div>
                <div className="fact" style={{ marginTop: 6 }}>
                  <span className="dim" style={{ fontSize: 11 }}>{t("端点")}</span>{" "}
                  <span className="mono" style={{ fontSize: 11, wordBreak: "break-all" }} data-testid="agent-endpoint">{mcp.endpoint || t("未启动")}</span>
                </div>
                {mcp.endpoint && (
                  <div className="fact" style={{ marginTop: 4 }}>
                    <span className="dim" style={{ fontSize: 11 }}>{t("接入文档")}</span>{" "}
                    <span className="mono" style={{ fontSize: 11, wordBreak: "break-all", userSelect: "all", WebkitUserSelect: "all" }} data-testid="agent-doc-url">
                      {new URL(mcp.endpoint).origin}/integration.md
                    </span>
                    <span className="dim" style={{ fontSize: 11 }}>{t("（把这个 URL 扔给 Agent，即可自助完成接入）")}</span>
                  </div>
                )}
                <button className="ghost" style={{ marginTop: 6 }} onClick={() => setShowAgentHelp(!showAgentHelp)}>
                  {showAgentHelp ? t("收起接入说明") : t("接入新 Agent")}
                </button>
                {showAgentHelp && (
                  <div className="dim" style={{ fontSize: 11, lineHeight: 1.9, marginTop: 6 }}>
                    <div>{t("1. MCP 端点已随本应用自动运行（地址如上，被占自动递增，无需另起 serve）；")}</div>
                    <div>{t("2. 用上方表单签发 Token（仅展示一次；也可 CLI ")}<code>tinyssh agent create &lt;id&gt; &lt;{t("名称")}&gt; --expires-days 30</code>{t("）；")}</div>
                    <div>{t("3. 在 Agent 的 MCP 配置里填入端点与 Token：")}</div>
                    <pre className="mono" style={{ fontSize: 10, whiteSpace: "pre-wrap", margin: "4px 0", userSelect: "all", WebkitUserSelect: "all" }}>
{`MCP URL: ${mcp.endpoint || "http://127.0.0.1:8722/mcp"}
Authorization: Bearer <TOKEN>`}
                    </pre>
                    <div>{t("或者更省事：把上面「接入文档」链接直接发给 Agent，它会按文档自助完成接入。只支持 stdio 的客户端用自带 shim（应用同目录）：")}</div>
                    <pre className="mono" style={{ fontSize: 10, whiteSpace: "pre-wrap", margin: "4px 0", userSelect: "all", WebkitUserSelect: "all" }}>
{`command: ${mcp.shim_path || t("(同应用目录 tinyssh-mcp)")}
env: TINYSSH_TOKEN=<TOKEN>  TINYSSH_MCP_URL=${mcp.endpoint || "http://127.0.0.1:8722/mcp"}`}
                    </pre>
                    <div>{t("接入后，Agent 的操作请求会出现在协作面板的审批队列逐段裁决。")}</div>
                  </div>
                )}
                <div className="side-quiet" style={{ marginTop: 8 }}>
                  {t("登记 Agent **不会**转移任何会话的控制权。要把某个会话交给 Agent，在协作面板（右缘 rail）点「交给 Agent…」并明确确认。")}
                </div>
                {/* C9：停用先预览影响→确认后核心原子封 admission；此入口只对 Enabled 开放 */}
                <button className="ghost" style={{ marginTop: 8, color: "var(--danger)" }}
                  data-testid="collab-disable-btn" disabled={collabBusy}
                  onClick={() => void openDisableDialog()}>{t("停用协作…")}</button>
                </>) : (<>
                {/* 停用/停用中/停用失败：MCP 端点未运行，不渲染接入配置（§6.7）。 */}
                <div style={{ fontSize: 12, lineHeight: 1.8 }} data-testid="collab-disabled-note">
                  {collab.state === "Disabling" ? t("协作正在停用——新 Agent 请求已被拒绝，正在收敛存量。")
                    : collab.state === "DisableFailed" ? t("上次停用未完全收敛（协作保持封闭，新 Agent 请求仍被拒绝）——请先「重试停用收敛」，收敛后才可重新启用。")
                    : t("协作已停用——MCP 端点未运行，Agent 请求一律被拒绝。要使用协作请显式启用。")}
                </div>
                {mcp.agents.length > 0 && (
                  <div className="dim" style={{ fontSize: 11, marginTop: 6 }} data-testid="collab-kept-agents">
                    {t("已配置的 Agent（Token 保留，重新启用后继续可用）：{0}", mcp.agents.map((a) => a.label).join(t("、")))}
                  </div>
                )}
                {collab.state === "DisableFailed" ? (
                  // 未收敛：只能重试停用（不得直接重新启用——核心会拒绝）
                  <button data-testid="collab-retry-disable-btn" style={{ marginTop: 8 }} disabled={collabBusy}
                    onClick={() => void retryDisableConvergence()}>
                    {t("重试停用收敛")}
                  </button>
                ) : collab.state === "Disabling" ? null : (
                  <button data-testid="collab-enable-btn" style={{ marginTop: 8 }} disabled={collabBusy}
                    onClick={() => void enableCollab()}>
                    {t("启用协作")}
                  </button>
                )}
                </>)}
                </div>
                </>)}

                {settingsCat === "records" && (
                  <RecordsPane
                    rows={recordsRows} busy={recordsBusy} exportBusy={recordsExportBusy}
                    filter={recordsFilter} agents={mcp.agents_detail ?? []}
                    onFilter={onRecordsFilter} onRefresh={onRecordsRefresh} onExport={onRecordsExport}
                    hasMore={recordsHasMore} moreBusy={recordsMoreBusy} onLoadMore={onRecordsMore}
                    sessionNames={recordsSessionNames}
                    retention={recordsRetention} onChangeRetention={onChangeRecordsRetention}
                  />
                )}

                {settingsCat === "about" && (<>
                <div className="set-card">
                <h4 style={{ margin: "0 0 8px" }}>{t("关于")}</h4>
                <div style={{ fontSize: 12, lineHeight: 1.9 }}>
                  {/* 版本号轮：编译时间随版本号同排展示（build.rs 编译期注入；演示域
                      无编译产物自动略去） */}
                  <div data-testid="about-version">
                    TinySSH v{appVersion ?? APP_VERSION}
                    {buildTime ? <span className="dim">{t("（{0} 编译）", buildTime)}</span> : null}
                    {inTauri ? "" : t("（浏览器演示模式）")}
                  </div>
                  <div data-testid="about-author">{t("作者：陈普")}</div>
                  <div className="dim">{t("本地优先的 SSH 客户端：终端、主机库与凭据都留在本机。")}</div>
                  <div className="dim">{t("凭据以加密形式存于本机凭据库，界面与日志只显示指纹。")}</div>
                  {/* 发布轮：有新版才出现的更新行（demo 域 check_update 恒 hasUpdate=false） */}
                  {updateInfo?.hasUpdate && updateInfo.latest ? (
                    <div data-testid="about-update" style={{ marginTop: 6 }}>
                      {t("新版本 {0} 已发布", `v${updateInfo.latest}`)}
                      <button className="ghost" data-testid="about-update-open" style={{ marginLeft: 8 }}
                        title={updateInfo.url ?? ""}
                        onClick={() => { if (updateInfo.url) invoke("open_url", { url: updateInfo.url }).catch(() => {}); }}>
                        {t("打开发布页")}
                      </button>
                      {/* updater 轮：只在可自动更新的构建出现（真公钥构建：mac
                          插件通道 / Windows 便携自替换通道；Linux 与未配签名的
                          构建走发布页——能力面如实，不摆无效按钮 */}
                      {updaterCap?.supported && (
                        <button className="ghost" data-testid="about-update-auto" style={{ marginLeft: 8 }}
                          disabled={updaterBusy} onClick={onAutoUpdate}>
                          {updaterBusy ? t("下载中…完成后自动重启") : t("自动更新（下载并重启）")}
                        </button>
                      )}
                    </div>
                  ) : null}
                  {/* 本轮：手动检测更新——启动自动检测之外的随时入口；结果三态如实
                      （新版本 toast/已是最新带版本号/失败原因），结果写回后上方更新
                      行即时出现 */}
                  <div style={{ marginTop: 6 }}>
                    <button className="ghost" data-testid="about-check-update"
                      disabled={checkBusy} onClick={onCheckUpdate}>
                      {checkBusy ? t("检测中…") : t("检测更新")}
                    </button>
                    <span className="dim" style={{ marginLeft: 8, fontSize: 11 }}>
                      {t("启动时也会自动检测一次")}
                    </span>
                  </div>
                  {/* 发布轮：诊断包导出（报障附件，Rust 侧从源头封死泄露通道） */}
                  <div style={{ marginTop: 6 }}>
                    <button className="ghost" data-testid="diag-export-btn" disabled={diagBusy} onClick={onExportDiagnostics}>
                      {diagBusy ? t("导出中…") : t("导出诊断包")}
                    </button>
                    <span className="dim" style={{ marginLeft: 8, fontSize: 11 }}>
                      {t("版本/平台/日志尾/审计条数——不含凭据与主机信息")}
                    </span>
                  </div>
                </div>
                {/* 自身开销监控（本轮）：本进程 CPU/内存 2s 实时采样；核心不可达时整块自隐藏 */}
                <SelfMeterDetail />
                </div>
                </>)}
                  </div>
                </div>
              </div>
            </>
  );
}

// ---- P2-b 输出触发器卡：草稿态**面板本地**（关面板即弃，与签发表单同工艺）。
// 载入一次；保存整卡提交，后端归一后回填（真实 id/冷却 clamp 以回显为准）。
const blankTrigger = (): TriggerRule => ({
  id: "", name: "", pattern: "", action: "Notify", keys: null, enabled: true, cooldown_secs: 60,
});

function TriggersCard({ load, save }: {
  load: () => Promise<TriggerRule[]>;
  save: (rules: TriggerRule[]) => Promise<TriggerRule[]>;
}) {
  const [rules, setRules] = useState<TriggerRule[] | null>(null); // null=载入中
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  // 读取失败 ≠ 没有规则：保存是整表替换，把失败画成空列表会让用户一点保存
  // 就把已存规则清空。失败态禁用保存，只给「重试」。
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  useEffect(() => {
    let dead = false;
    setRules(null);
    setLoadErr(null);
    load()
      .then((rs) => { if (!dead) setRules(rs); })
      .catch((e) => { if (!dead) { setLoadErr(friendlyError(e)); setRules([]); } });
    return () => { dead = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reloadKey]);
  if (loadErr) {
    return (
      <div className="set-card">
        <h4>{t("输出触发器")}</h4>
        <div className="err" data-testid="triggers-load-err">✕ {loadErr}</div>
        <div className="set-desc">{t("读取失败时禁止保存——整表保存会用空列表覆盖已存规则。")}</div>
        <button className="ghost" onClick={() => setReloadKey((k) => k + 1)}>{t("重试")}</button>
      </div>
    );
  }
  if (rules === null) {
    return (
      <div className="set-card">
        <h4>{t("输出触发器")}</h4>
        <div className="set-desc" data-testid="triggers-loading">{t("载入中…")}</div>
      </div>
    );
  }
  const doSave = async () => {
    if (busy) return;
    setBusy(true); setErr(null); setOk(null);
    try {
      const norm = await save(rules);
      setRules(norm);
      const sends = norm.filter((r) => r.action === "SendKeys").length;
      setOk(t("已保存 {0} 条（发送键序 {1} 条）。命中即生效；发送动作仍会建审批卡等你裁决。", norm.length, sends));
    } catch (e) {
      setErr(friendlyError(e));
    } finally {
      setBusy(false);
    }
  };
  const patch = (i: number, p: Partial<TriggerRule>) =>
    setRules((cur) => (cur ?? []).map((r, j) => (j === i ? { ...r, ...p } : r)));
  return (
    <div className="set-card">
      <h4>{t("输出触发器")}</h4>
      <div className="set-desc">
        {t("终端输出按完整行匹配正则（匹配前剥离颜色码；跨行不命中——如实边界）。命中「通知」= toast + 标签铃；命中「发送键序」= 建审批卡等你裁决，批准才会发送，绝不静默自动执行。键序支持转义：\\r 回车、\\n 换行、\\t 制表、\\\\ 反斜杠。同规则同会话受冷却节流（5–3600 秒）；最多 32 条。")}
      </div>
      {rules.length === 0 && (
        <div className="empty" data-testid="triggers-empty">{t("还没有规则——用「新增规则」建第一条。")}</div>
      )}
      {rules.map((r, i) => (
        <div className="trigger-row" data-testid="trigger-row" key={r.id || `new-${i}`}>
          <div className="trigger-line">
            <input className="trigger-in" data-testid="trigger-name" placeholder={t("规则名")} value={r.name}
              onChange={(e) => patch(i, { name: e.target.value })} />
            <label className="trigger-check">
              <input type="checkbox" data-testid="trigger-enabled" checked={r.enabled}
                onChange={(e) => patch(i, { enabled: e.target.checked })} />{t("启用")}
            </label>
            <button className="ghost icon-btn" data-testid="trigger-del" title={t("删除规则")} aria-label={t("删除规则 {0}", r.name || i + 1)}
              onClick={() => setRules((cur) => (cur ?? []).filter((_, j) => j !== i))}><IconTrash size={13} /></button>
          </div>
          <input className="trigger-in mono" data-testid="trigger-pattern" placeholder={t("正则（按行匹配，如 BUILD FAILED）")}
            value={r.pattern} onChange={(e) => patch(i, { pattern: e.target.value })} />
          <div className="trigger-line">
            <select className="trigger-in" data-testid="trigger-action" value={r.action} aria-label={t("触发动作")}
              onChange={(e) => patch(i, {
                action: e.target.value as TriggerRule["action"],
                keys: e.target.value === "Notify" ? null : (r.keys ?? ""),
              })}>
              <option value="Notify">{t("动作：通知（toast + 标签铃）")}</option>
              <option value="SendKeys">{t("动作：发送键序（需审批）")}</option>
            </select>
            {r.action === "SendKeys" && (
              <input className="trigger-in mono" data-testid="trigger-keys" placeholder={t("要发送的键序（如 y\\r）")}
                value={r.keys ?? ""} onChange={(e) => patch(i, { keys: e.target.value })} />
            )}
          </div>
        </div>
      ))}
      <div className="row" style={{ marginTop: 10 }}>
        <button className="ghost" data-testid="trigger-add" disabled={rules.length >= 32}
          onClick={() => setRules((cur) => [...(cur ?? []), blankTrigger()])}><IconPlus size={12} /> {t("新增规则")}</button>
        <span style={{ flex: 1 }} />
        <button className="primary" data-testid="trigger-save" disabled={busy} onClick={() => void doSave()}>
          {busy ? t("保存中…") : t("保存")}</button>
      </div>
      {err && <div className="err" style={{ fontSize: 12, marginTop: 6 }} data-testid="triggers-err" role="alert">✕ {err}</div>}
      {ok && <div className="dim" style={{ fontSize: 12, marginTop: 6 }} data-testid="triggers-ok" role="status">✓ {ok}</div>}
    </div>
  );
}

// ── 模型服务卡（接真模型轮）：内置 Agent 对话的 provider/base_url/model/api_key。
// 面板本地草稿态（与 TriggersCard 同工艺）；api_key 只写入 vault 密封 KV，永不明文
// 落盘/回显——只回 has_key 事实。保存后广播 agent-model-saved（Agent 视图即时切真模式）。
function AgentModelCard() {
  // 任务 2：provider/base_url/model 是非机密输入，跨关闭用 localStorage 草稿保留；
  // api_key 是机密——只写 vault 密封 KV，绝不读草稿、绝不落 Web Storage（关闭即丢）。
  const [provider, setProvider] = useState<"openai" | "anthropic">(() => {
    return readDraft("agentModel.provider") === "anthropic" ? "anthropic" : "openai";
  });
  const [baseUrl, setBaseUrl] = useState(() => readDraft("agentModel.baseUrl") ?? "");
  const [model, setModel] = useState(() => readDraft("agentModel.model") ?? "");
  const [apiKey, setApiKey] = useState("");
  const [hasKey, setHasKey] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  // 后端配置回包到达前用户已改过的字段：回包不得覆盖正在输入的内容。
  const modelTouchedRef = useRef({ provider: false, baseUrl: false, model: false });

  useEffect(() => {
    // 不分 demo/Tauri：demo 镜像（localStorage）也走同一条 invoke 读路径——
    // 回显在两个域行为一致；realMode 的域门只在 Agent 视图，不在这里。
    let dead = false;
    invoke("agent_model_get", {})
      .then((v) => {
        if (dead || !v) return;
        const c = v as { provider?: string; base_url?: string; model?: string; has_key?: boolean };
        // 有未提交草稿的字段以草稿为准（用户上次关设置前的编辑不该被已存配置盖掉）。
        if ((c.provider === "openai" || c.provider === "anthropic")
          && !modelTouchedRef.current.provider && readDraft("agentModel.provider") === null) {
          setProvider(c.provider);
        }
        if (!modelTouchedRef.current.baseUrl && readDraft("agentModel.baseUrl") === null) {
          setBaseUrl(c.base_url ?? "");
        }
        if (!modelTouchedRef.current.model && readDraft("agentModel.model") === null) {
          setModel(c.model ?? "");
        }
        setHasKey(c.has_key === true);
      })
      .catch(() => {});
    return () => { dead = true; };
  }, []);

  const save = () => {
    setBusy(true);
    setMsg(null);
    invoke("agent_model_set", {
      provider,
      baseUrl: baseUrl.trim() || null,
      model: model,
      apiKey: apiKey.trim() || null,
    })
      .then(() => {
        setHasKey(hasKey || apiKey.trim().length > 0);
        setApiKey("");
        // 显式保存成功 = 草稿使命结束；下次打开以已存配置为准。
        clearDraft("agentModel.provider", "agentModel.baseUrl", "agentModel.model");
        setMsg({
          kind: "ok",
          text: inTauri
            ? t("已保存（api_key 加密入库，不回显）")
            : t("已保存（演示域仅记录配置事实，不保存密钥，也不会切换真实模型）"),
        });
        window.dispatchEvent(new Event("agent-model-saved"));
      })
      .catch((e) => setMsg({ kind: "err", text: String(e) }))
      .finally(() => setBusy(false));
  };

  return (
    <div className="set-card" data-testid="agent-model-card">
      <h4 style={{ margin: "0 0 6px" }}>{t("模型服务（内置 Agent 对话）")}</h4>
      <div className="dim" style={{ fontSize: 11, lineHeight: 1.7 }}>
        {inTauri
          ? t("配置后左侧 Agent 视图从演练外壳切换为真实模型。agent 的 exec 等操作仍走本应用既有审批链（危险命令需人工批准）。")
          : t("演示域不会保存密钥，也不会切换真实模型；此卡仅用于预览表单。")}
      </div>
      <div style={{ marginTop: 8, display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center" }}>
        <select data-testid="agent-model-provider" style={{ fontSize: 12 }} value={provider}
          onChange={(e) => {
            const v = e.target.value as "openai" | "anthropic";
            modelTouchedRef.current.provider = true;
            setProvider(v);
            writeDraft("agentModel.provider", v);
          }} aria-label={t("provider 类型")}>
          <option value="openai">{t("OpenAI 兼容（GLM / DeepSeek / Qwen / Kimi…）")}</option>
          <option value="anthropic">Anthropic</option>
        </select>
        <input data-testid="agent-model-url" className="mono" style={{ fontSize: 11, width: 210 }}
          placeholder={t("base_url（可选，缺省官方端点）")} aria-label="base_url"
          value={baseUrl} onChange={(e) => {
            modelTouchedRef.current.baseUrl = true;
            setBaseUrl(e.target.value);
            writeDraft("agentModel.baseUrl", draftUrlForStorage(e.target.value));
          }} />
        <input data-testid="agent-model-name" className="mono" style={{ fontSize: 11, width: 150 }}
          placeholder={t("模型名（如 glm-4.7）")} aria-label={t("模型名（如 glm-4.7）")}
          value={model} onChange={(e) => {
            modelTouchedRef.current.model = true;
            setModel(e.target.value);
            writeDraft("agentModel.model", e.target.value);
          }} />
        <SecretInput data-testid="agent-model-key" className="mono" style={{ fontSize: 11, width: 190 }}
          placeholder={hasKey ? t("已配置（重填可更换）") : "api_key"}
          aria-label="api_key"
          value={apiKey} onChange={(e) => setApiKey(e.target.value)} />
        <button className="ghost" data-testid="agent-model-save" disabled={busy || !model.trim()} onClick={save}>{t("保存")}</button>
      </div>
      {msg && (
        <div className={msg.kind} style={{ fontSize: 11, marginTop: 5 }} data-testid="agent-model-msg" role="status">
          {msg.kind === "ok" ? "✓ " : "✕ "}{msg.text}
        </div>
      )}
    </div>
  );
}

// 提示词/技能资产化轮：内置 Agent 的用户附加提示词 + 技能库（面板本地，改动即存 KV）。
// KV 键：agent.prompt_extra / agent.fleet_prompt_extra / agent.skills（JSON 对象：名称→正文）。
// 真侧 Rust（AgentPromptAssets）同键读取；附加段超 8KB 截断保头，textarea maxLength 对齐约 2700 汉字。
// 技能库显式保存（草稿语义）；附加段 blur 即存 + 卸载兜底，关面板不丢最后一次编辑。
const AGENT_EXTRA_MAX_CHARS = 2700; // ≈ 8192 字节（CJK 每字 3 字节），真侧 clamp 同源
function PromptSkillsCard() {
  const [extra, setExtra] = useState("");
  const [fleetExtra, setFleetExtra] = useState("");
  // 任务 2：技能草稿（名称 + 正文，均非机密）跨关闭保留；上次未保存的编辑优先于
  // KV 已存内容（附加提示词本身 blur/卸载即存，不存在丢失，故不另存草稿）。
  const [skills, setSkills] = useState<{ name: string; body: string }[]>(() => readSkillsDraft() ?? []);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  // 用户已改过 / 打开时就带着草稿：KV 回包不得覆盖未保存的编辑。
  const skillsTouchedRef = useRef(false);
  // 只有「能解析的草稿」才算未保存编辑：损坏的 JSON 若也按草稿对待，KV 已存技能
  // 整场不加载（表现为空库），用户再点保存就用空表覆盖全部技能。损坏草稿就地清掉。
  const skillsDraftAtMountRef = useRef<boolean | undefined>(undefined);
  if (skillsDraftAtMountRef.current === undefined) {
    const draft = readSkillsDraft();
    skillsDraftAtMountRef.current = draft !== null;
    if (draft === null) clearDraft("agentSkills.draft");
  }
  // 按 key 记录「读取成功」：某个 key 读取失败时不能在卸载兜底里用初始 ""
  // 覆盖已存内容（此前 Promise.all(...catch) 无论成败都置 loaded，失败即清空）。
  const loadedRef = useRef({ extra: false, fleet: false });
  const draftRef = useRef({ extra: "", fleetExtra: "" });
  draftRef.current = { extra, fleetExtra };

  useEffect(() => {
    // 不分 demo/Tauri：demo 镜像（settings Map）也走同一条 invoke 读路径（AgentModelCard 同工艺）
    invoke("get_setting", { key: "agent.prompt_extra" })
      .then((v) => { setExtra(v ?? ""); loadedRef.current.extra = true; })
      .catch(() => {});
    invoke("get_setting", { key: "agent.fleet_prompt_extra" })
      .then((v) => { setFleetExtra(v ?? ""); loadedRef.current.fleet = true; })
      .catch(() => {});
    invoke("get_setting", { key: "agent.skills" }).then((v) => {
      // 有未保存草稿时以草稿为准（KV 已存内容不是用户此刻看到并继续编辑的东西）。
      if (skillsTouchedRef.current || skillsDraftAtMountRef.current) return;
      try {
        const m = v ? JSON.parse(v) : {};
        setSkills(Object.entries(m).map(([name, body]) => ({ name, body: String(body) })));
      } catch { /* 损坏视为空库（真侧同样容忍，不阻塞对话） */ }
    }).catch(() => {});
  }, []);

  // 卸载兜底：直接关面板/切分类未触发 blur 的最后一次编辑也不丢。
  // 只写「读取成功」的 key——读取失败的初始空串不得覆盖已存值。
  useEffect(() => () => {
    const d = draftRef.current;
    if (loadedRef.current.extra) {
      void invoke("set_setting", { key: "agent.prompt_extra", value: d.extra }).catch(() => {});
    }
    if (loadedRef.current.fleet) {
      void invoke("set_setting", { key: "agent.fleet_prompt_extra", value: d.fleetExtra }).catch(() => {});
    }
  }, []);

  const saveKV = (key: string, value: string) =>
    invoke("set_setting", { key, value });

  // 技能列表的唯一写入口：同步草稿，关设置后再次打开仍能看到未保存的编辑。
  const applySkills = (next: { name: string; body: string }[]) => {
    skillsTouchedRef.current = true;
    setSkills(next);
    if (!writeDraft("agentSkills.draft", JSON.stringify(next))) {
      setMsg({ kind: "err", text: t("草稿保存失败（存储空间不足或隐私模式）——关闭设置后未保存的编辑会丢失") });
    }
  };

  const saveSkills = async (list: { name: string; body: string }[]) => {
    setMsg(null);
    if (list.length > 32) {
      setMsg({ kind: "err", text: t("技能最多 32 条") });
      return false;
    }
    const names = list.map((s) => s.name.trim());
    if (names.some((n) => !n)) {
      setMsg({ kind: "err", text: t("技能名称不能为空") });
      return false;
    }
    if (new Set(names).size !== names.length) {
      setMsg({ kind: "err", text: t("技能名称重复") });
      return false;
    }
    try {
      await saveKV("agent.skills", JSON.stringify(Object.fromEntries(list.map((s, i) => [names[i], s.body]))));
      clearDraft("agentSkills.draft"); // 显式保存成功 = 草稿使命结束
      return true;
    } catch (e) {
      setMsg({ kind: "err", text: t("保存失败：{0}", String(e)) });
      return false;
    }
  };

  return (
    <div className="set-card" data-testid="agent-prompt-skills-card">
      <h4 style={{ margin: "0 0 6px" }}>{t("提示词与技能（内置 Agent）")}</h4>
      <div className="dim" style={{ fontSize: 11, lineHeight: 1.7 }}>
        {t("在内置系统提示词之上追加的组织/现场约定——不改内置安全铁律（审批/不虚构等），冲突时以铁律为准。会话助手与 Fleet 编排者各一段，保存后 agent 的下一条消息即生效。技能库供 agent 用 load_skill 工具按名加载。")}
      </div>
      <div style={{ marginTop: 8 }}>
        <div style={{ fontSize: 12, marginBottom: 3 }}>{t("会话助手附加提示词")}</div>
        <textarea data-testid="agent-prompt-extra" className="mono" style={{ width: "100%", fontSize: 11 }}
          rows={4} maxLength={AGENT_EXTRA_MAX_CHARS}
          placeholder={t("例如：生产库只读优先，改动先报备；机器统一 Ubuntu，用 apt 而非 yum。")}
          aria-label={t("会话助手附加提示词")} value={extra}
          onChange={(e) => setExtra(e.target.value)}
          onBlur={() => { void saveKV("agent.prompt_extra", extra).catch((e) => setMsg({ kind: "err", text: t("保存失败：{0}", String(e)) })); }} />
        <button className="ghost" style={{ marginTop: 2 }} data-testid="agent-prompt-extra-clear"
          onClick={() => { setExtra(""); void saveKV("agent.prompt_extra", "").catch((e) => setMsg({ kind: "err", text: t("保存失败：{0}", String(e)) })); }}>{t("清空")}</button>
      </div>
      <div style={{ marginTop: 6 }}>
        <div style={{ fontSize: 12, marginBottom: 3 }}>{t("Fleet 编排者附加提示词")}</div>
        <textarea data-testid="agent-fleet-prompt-extra" className="mono" style={{ width: "100%", fontSize: 11 }}
          rows={3} maxLength={AGENT_EXTRA_MAX_CHARS}
          placeholder={t("例如：汇总一律用表格；失败项单独列出并给复跑建议。")}
          aria-label={t("Fleet 编排者附加提示词")} value={fleetExtra}
          onChange={(e) => setFleetExtra(e.target.value)}
          onBlur={() => { void saveKV("agent.fleet_prompt_extra", fleetExtra).catch((e) => setMsg({ kind: "err", text: t("保存失败：{0}", String(e)) })); }} />
        <button className="ghost" style={{ marginTop: 2 }} data-testid="agent-fleet-prompt-extra-clear"
          onClick={() => { setFleetExtra(""); void saveKV("agent.fleet_prompt_extra", "").catch((e) => setMsg({ kind: "err", text: t("保存失败：{0}", String(e)) })); }}>{t("清空")}</button>
      </div>
      <div style={{ marginTop: 10 }}>
        <div style={{ fontSize: 12, marginBottom: 3 }}>{t("技能库（{0}/32）", skills.length)}</div>
        {skills.length === 0 && (
          <div className="dim" style={{ fontSize: 11 }} data-testid="agent-skills-empty">
            {t("暂无技能——添加后 agent 可用 load_skill 工具按名加载（名称 + 操作手册正文）。")}
          </div>
        )}
        {skills.map((s, i) => (
          <div key={i} style={{ marginTop: 6, borderTop: "1px solid var(--border)", paddingTop: 6 }}>
            <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
              <input data-testid={`skill-name-${i}`} className="mono" style={{ fontSize: 11, width: 180 }}
                maxLength={50} placeholder={t("技能名（如 nginx 排障）")} aria-label={t("技能 {0} 名称", i + 1)}
                value={s.name}
                onChange={(e) => applySkills(skills.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} />
              <button className="ghost" data-testid={`skill-del-${i}`} aria-label={t("删除技能 {0}", s.name || i + 1)}
                onClick={() => applySkills(skills.filter((_, j) => j !== i))}><IconTrash size={12} /></button>
            </div>
            <textarea data-testid={`skill-body-${i}`} className="mono" style={{ width: "100%", fontSize: 11, marginTop: 4 }}
              rows={4} maxLength={16000} placeholder={t("操作手册正文：步骤、验收标准、注意事项（agent 加载后照做）。")}
              aria-label={t("技能 {0} 正文", i + 1)} value={s.body}
              onChange={(e) => applySkills(skills.map((x, j) => (j === i ? { ...x, body: e.target.value } : x)))} />
          </div>
        ))}
        <div style={{ marginTop: 6, display: "flex", gap: 6 }}>
          <button className="ghost" data-testid="skill-add"
            onClick={() => applySkills([...skills, { name: "", body: "" }])}>{t("添加技能")}</button>
          <button className="ghost" data-testid="skill-save"
            onClick={() => {
              void saveSkills(skills).then((ok) => {
                if (ok) setMsg({ kind: "ok", text: t("已保存（{0} 条）", skills.length) });
              });
            }}>
            {t("保存技能库")}</button>
        </div>
      </div>
      {msg && (
        <div className={msg.kind} style={{ fontSize: 11, marginTop: 5 }} data-testid="agent-skills-msg" role="status">
          {msg.kind === "ok" ? "✓ " : "✕ "}{msg.text}
        </div>
      )}
    </div>
  );
}
