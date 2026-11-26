// 助力球（GitHub #40 / #45）：触控场景（手机本体 / 手机远程桌面控制电脑）没有
// 鼠标滚轮，标签条与工具栏又吃空间。右缘悬浮球点开一个动作面板：
//   上翻 / 下翻 / 回到底部 / 粘贴（正常屏走 xterm 本地 scrollback；备用屏
//   tmux/vim 全屏合成触摸板滚轮事件，与用户触摸板同一通道，见 App 的 assistScroll；
//   粘贴与 ⌘V/右键同一收口 pasteTextInto，危险扫描/多行确认不旁路）
//   + 常用键排（Esc/Tab/^C/↑/↓ 与 Home/End/PgUp/PgDn/^B，经 App 的 sendMobileKey
//     走真实键序路径，方向键与 Home/End 跟随 DECCKM；点键后面板不收——连点刚需）
//     右缘挂一枚竖向终端字号摇杆（上 A+ / 中间读数 / 下 A−，走设置同一条
//     changeFontSize 通道：全实例应用 + PTY 校准；同样不收面板）
//   + 专注态唤出/收起标签与工具栏（#45「专注模式下标签按钮栏碍事」，移动端专属）。
// 版式（样式见 styles.css 的 .assist-menu 一节）：命令格图标在上、文案在下，
// 竖屏一行四格（专注态第二行两枚宽格），横屏压成单行；连点区（键排 + 摇杆）在
// 命令格之下，宽横屏与命令格并成两行。面板在常规手机横竖屏完整铺开、不出滚动条
// （用户走查：移动端在弹出面板里上下滚动很难操作）；放不下时按实测余量逐级收紧
// （.ts-tight → .ts-mini 图标版），三档都放不下才留应急滚动。
// 移动平台常显；桌面端默认不渲染——手机远程桌面（ToDesk 等）注入的是鼠标事件，
// 无法可靠自动识别，改由设置「在桌面端显示助力球」确定性开启（持久化）。
//
// 三条纪律与辅助键条同源：
// 1. 按钮 pointerdown 一律 preventDefault——否则点击会把焦点从 xterm 的隐藏
//    textarea 拽走，软键盘立刻收起（面板动作后用户还要接着打字）。
//    例外：键盘已被返回键收起（`data-ime="0"`）而终端仍持焦点时，preventDefault
//    反而会让 Chrome 重新弹起键盘，此时放行默认行为（见 AssistButton）。
//    代价与细节：触摸上 preventDefault 可能抑制兼容 mouse 事件，也可能不抑制
//    （Chrome Android 实测仍补 click）；触摸激活统一走 pointerup，click 侧按
//    时间戳去重（见 AssistButton），两条路径都不会双跑。
// 2. 面板不是模态：点面板外（scrim）或 Esc 关闭，Esc 只关面板不冒到别处。
// 3. 滚动/专注/粘贴项收起要晚一拍（closeSoon）：Chrome Android 在 pointerup 之后
//    还会补一个 click。若面板在 pointerup 里立即卸载，这个 click 就穿过落到终端
//    画布上，xterm 拿下焦点、软键盘弹起——刚用面板翻了一屏，键盘立刻盖住半屏
//    （真机实测）。把卸载推迟到 click 之后，click 落在仍在的面板/遮罩上被吃掉。
//    常用键/字号键不收面板，无此问题。
//
// 拖动球位（四档功能轮）：球默认钉在右缘 bottom:96，远控时会挡 vim 行号 / diff
// 列。按下后累计位移 ≥6px 进入拖动态（阈值内松手仍是点按开面板），move 直接改
// wrap 内联样式（不逐帧 setState），抬起经 onMoveEnd 落 state + localStorage；
// 越界钳到父容器内，球落左半时面板改左对齐（assist-left），贴边吸附由钳制即得。
// 球尺寸三档走 --assist-ball-size（ui-scale.ts 同款 documentElement 变量），
// 设置 → 助力球卡选择，持久化 localStorage（设备级偏好，与 ui.assistBall 同域）。
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent, ReactNode } from "react";
import { t } from "../i18n";
import { IconAssist, IconChevronsUp, IconChevronsDown, IconArrowDownToLine, IconPanelTop, IconMinimize, IconClipboard } from "../icons";

/** 球径三档（px）：设置「助力球大小」选择，--assist-ball-size 落地。 */
export const ASSIST_BALL_SIZES = { s: 32, m: 40, l: 52 } as const;
export type AssistBallSize = keyof typeof ASSIST_BALL_SIZES;

/** 拖动阈值：累计位移超过它才算拖动（否则是点按）。触屏手指放上去自带几像素抖动。 */
const DRAG_THRESHOLD = 6;
/** 球贴边最小留白（父容器内钳制边界）。 */
const EDGE_MARGIN = 6;

/** 软键盘已收起（Android 推的 `data-ime="0"`）但 xterm 仍持焦点（用户按了
 *  返回键收键盘）：此时 pointerdown preventDefault 会让 Chrome 在下一次触摸
 *  把键盘重新弹起（真机实测）。放行默认行为，让按钮接管焦点、终端失焦。 */
function imeDismissedWithTerminalFocus(): boolean {
  if (document.documentElement.dataset.ime !== "0") return false;
  const ae = document.activeElement;
  return ae instanceof HTMLElement && ae.classList.contains("xterm-helper-textarea");
}

/** 球位钳到父容器内（含球径与留白）；offsetParent 缺失（未挂载）时原样返回。 */
function assistClamp(wrap: HTMLDivElement, x: number, y: number): { x: number; y: number } {
  const parent = wrap.offsetParent as HTMLElement | null;
  if (!parent) return { x, y };
  const ball = wrap.querySelector<HTMLElement>('[data-testid="assist-ball"]');
  const size = ball ? ball.offsetWidth : ASSIST_BALL_SIZES.m;
  const pr = parent.getBoundingClientRect();
  return {
    x: Math.max(EDGE_MARGIN, Math.min(pr.width - size - EDGE_MARGIN, x)),
    y: Math.max(EDGE_MARGIN, Math.min(pr.height - size - EDGE_MARGIN, y)),
  };
}

/** 球心落左半 → 面板左对齐（assist-left），否则右对齐（默认）。 */
function assistUpdateSide(wrap: HTMLDivElement, x: number): void {
  const parent = wrap.offsetParent as HTMLElement | null;
  if (!parent) return;
  const ball = wrap.querySelector<HTMLElement>('[data-testid="assist-ball"]');
  const size = ball ? ball.offsetWidth : ASSIST_BALL_SIZES.m;
  wrap.classList.toggle("assist-left", x + size / 2 < parent.getBoundingClientRect().width / 2);
}

/** 把球锚定为绝对 left/top（清掉 CSS 默认锚 right/bottom 的歧义：两者同设
 *  属过约束，靠 LTR 优先级「碰巧」忽略 right——不显式置 auto 太脆）。 */
function applyWrapPos(wrap: HTMLDivElement, x: number, y: number): void {
  wrap.style.left = `${x}px`;
  wrap.style.top = `${y}px`;
  wrap.style.right = "auto";
  wrap.style.bottom = "auto";
}

/** 清掉落位内联样式，回 CSS 默认锚（right/bottom）；左对齐类一并撤。 */
function clearWrapPos(wrap: HTMLDivElement): void {
  wrap.style.left = "";
  wrap.style.top = "";
  wrap.style.right = "";
  wrap.style.bottom = "";
  wrap.classList.remove("assist-left");
}

/** 触摸可用的「按下即保持焦点、抬起即执行」按钮。
 *  - pointerdown preventDefault：保住 xterm 焦点 / 软键盘。
 *  - pointerup（仅 touch，且按下也落在本钮）：触摸的激活入口。Chrome Android
 *    在 pointerdown 被 preventDefault 后**仍会**补一个 click（事件序列实测：
 *    pointerdown → pointerup → click），所以 click 侧必须去重，否则一次点按
 *    会把面板开了又关。去重按手势（gestureSpent，见下）：出过手的那段点按，
 *    尾随 click 不分早晚一律吃掉。
 *  - onClick：鼠标/键盘路径，以及没抑制住 click 的 WebView。键盘/辅助技术触发
 *    的 click 不带 pointerType，没有前置手势，不经手势闸，只受时间窗约束。
 *  - onDragMove/onDragEnd（可选，球位拖动用）：按下后累计位移 ≥DRAG_THRESHOLD
 *    进入拖动态——setPointerCapture 保住移出球体的 move 流、抑制激活（抬起不开
 *    面板），end 交外部落位；拖完的尾随 click（触摸补发 / 鼠标抬起）同样被
 *    gestureSpent 吃掉。
 */
// 当前这段点按手势是否已经出过手（触摸抬起即激活，或拖完落位）。浏览器在 pointerup
// 之后补发的 click 属于同一次点按——不管隔多久到都不该再执行一遍。光靠时间窗不够：
// 动作若触发长任务（Android WebView 实测：终端字号换一档，xterm 重建字形缓存把主
// 线程占住 600ms+），补发的 click 会被排到窗口过期之后才派发，一次点按就执行两遍
// （A+ 点一下跳两档）。pointerdown 置新，下一次真实点按重新放开；放模块级是因为
// 补发的 click 按坐标命中，布局在长任务里变了就可能落到别的助力按钮上。
let gestureSpent = false;
type AssistButtonProps = {
  onActivate: () => void;
  className?: string;
  children: ReactNode;
  role?: string;
  pressed?: boolean;
  onDragMove?: (total: { dx: number; dy: number }, ev: ReactPointerEvent) => void;
  onDragEnd?: (dragged: boolean) => void;
  [key: `data-${string}`]: string | undefined;
  title?: string;
  "aria-label"?: string;
  "aria-haspopup"?: "menu";
  "aria-expanded"?: boolean;
};

function AssistButton({
  onActivate, className, children, role, pressed, onDragMove, onDragEnd, ...rest
}: AssistButtonProps) {
  const down = useRef(false);
  const touchAt = useRef(0);
  // 拖完尾随 click 的独立去重窗（审核轮修复）：touch 的 700ms 窗是给「按下
  // 即激活」的手势补发 click 用的；拖完各 pointerType 都会由浏览器补一个
  // click（CDP 原生 mouse/pen 实锤同补），若复用 700ms 会把拖完快速再点
  // 的真实第二次点按也吞掉。拖完窗收窄到 150ms：同步补发 click 必落窗内，
  // 人手连点（拖到下次 down 通常 >200ms）不被误吞。
  const dragEndAt = useRef(0);
  const dragFrom = useRef<{ x: number; y: number } | null>(null);
  const dragging = useRef(false);
  return (
    <button
      type="button"
      role={role}
      aria-pressed={pressed}
      className={className}
      {...rest}
      onPointerDown={(ev: ReactPointerEvent) => {
        // 「键盘收起但终端仍持焦点」时不 preventDefault：否则 Chrome 会把键盘
        // 重新弹起，刚收起的键盘又盖住半屏（见 imeDismissedWithTerminalFocus）。
        if (!(ev.pointerType === "touch" && imeDismissedWithTerminalFocus())) ev.preventDefault();
        down.current = true;
        dragFrom.current = { x: ev.clientX, y: ev.clientY };
        dragging.current = false;
        // 新的一段点按手势：重新放开手势闸
        gestureSpent = false;
        // 鼠标/触控笔按下会紧跟自己的 click：清掉触摸去重窗口，别把鼠标点也吞了
        if (ev.pointerType !== "touch") touchAt.current = 0;
        // 新一段手势开始：拖完尾随窗也一并清（上一段的窗残留会吞掉这次的
        // 激活 click——比如拖完 100ms 内紧接按下再抬起，down 不该继承窗）。
        dragEndAt.current = 0;
      }}
      onPointerMove={(ev: ReactPointerEvent) => {
        if (!onDragMove || !down.current || !dragFrom.current) return;
        // 鼠标/笔 capture 失败（或没捕获成）又移出球外松手时会丢 pointerup：
        // 按钮早已松开却仍收到 move（无按键悬停），不清场就会从陈旧 dragFrom
        // 重算位移、无按压幽灵拖动（审核轮 review-pointer 护栏）。touch 有
        // 隐式捕获不受影响。
        if (ev.pointerType !== "touch" && ev.buttons === 0) {
          const wasDragging = dragging.current;
          down.current = false;
          dragFrom.current = null;
          dragging.current = false;
          if (wasDragging) onDragEnd?.(false);
          return;
        }
        const total = { dx: ev.clientX - dragFrom.current.x, dy: ev.clientY - dragFrom.current.y };
        if (!dragging.current) {
          if (Math.hypot(total.dx, total.dy) < DRAG_THRESHOLD) return;
          dragging.current = true;
          // 捕获后续 move 流（手指/指针移出小球也不丢）；失败不致命——面板仍能收
          try { ev.currentTarget.setPointerCapture(ev.pointerId); } catch { /* 忽略 */ }
        }
        onDragMove(total, ev);
      }}
      onPointerUp={(ev: ReactPointerEvent) => {
        if (dragging.current) {
          dragging.current = false;
          down.current = false;
          dragFrom.current = null;
          // 拖完抑制随后的 click：三种 pointerType 的浏览器都会在 up 后同步
          // 派发 click（touch 同任务补发，mouse/pen 也是——CDP 原生输入实锤），
          // 统一走 dragEndAt 的 150ms 尾随窗吃掉它；不挪用 touchAt——那个 700ms
          // 窗是给「按下即激活」的 touch 手势准备的，套到拖上会连坐吞连点。
          dragEndAt.current = Date.now();
          gestureSpent = true;
          onDragEnd?.(true);
          return;
        }
        dragFrom.current = null;
        if (ev.pointerType !== "touch" || !down.current) return;
        down.current = false;
        touchAt.current = Date.now();
        gestureSpent = true;
        onActivate();
      }}
      onPointerCancel={() => {
        down.current = false;
        dragFrom.current = null;
        if (dragging.current) {
          dragging.current = false;
          onDragEnd?.(false); // 拖动被系统打断：外层恢复原锚定位，不算落位
        }
      }}
      onClick={(ev) => {
        // 手势闸：本段点按已经出过手，尾随 click 不分早晚一律吃掉。键盘/辅助技术触发
        // 的 click 不带 pointerType、detail 为 0，不来自点按手势，放行到下面的时间窗。
        // 别拿 detail 单独区分：Chrome Android 触摸补发的 click detail 也是 0，
        // 真机上只有 pointerType 分得开两者（WebView 实测）。
        if (gestureSpent && ((ev.nativeEvent as MouseEvent & { pointerType?: string }).pointerType || ev.detail)) return;
        if (Date.now() - touchAt.current < 700) return;
        if (Date.now() - dragEndAt.current < 150) return;
        onActivate();
      }}
    >
      {children}
    </button>
  );
}

/** 命令格文案限字号（逐行，place 的第一步）：每次摆位前先把文案还原到期望字号，用实际
 *  字体量出每句文案的自然宽。整行文案都能在 ≥ 下限字号下排成单行时，给这一行统一一个
 *  「刚好放得下」的字号——行内不分大小，也省下一行高度；否则保持期望字号、按词折行，
 *  只对「最宽的词放不下」的格子再收一档，单词不从中间拆开。
 *  下限：纯中文行 68%（没有词间断点，折行会撑高格子，宁小勿折；再垫 9px 绝对值，
 *  界面字号调小时不缩成蚂蚁字）；含英文的行 80%（小字英文可读性掉得快），同样垫 9px。
 *  直接写内联 fontSize、不走 state——同 place 的纪律：绘制前同步量完，不开第二帧。
 *  必须在摘掉档位类之后调（见 place）：图标版的命令格没有左右内衬，带着上一轮的
 *  档位量，文案会按宽出 8px 的格子定字号——软键盘收起那一帧正好走「图标版 → 常规」。 */
function fitTileLabels(menu: HTMLElement) {
  const cv = document.createElement("canvas").getContext("2d");
  if (!cv) return;
  type Tile = { el: HTMLElement; em: number; word: number; inner: number; expected: number; latin: boolean };
  const els = [...menu.querySelectorAll<HTMLElement>(".assist-cmd")];
  for (const el of els) el.style.fontSize = "";   // 先全部还原再统一量，排版只强制一次
  const rows = new Map<number, Tile[]>();
  for (const el of els) {
    const label = el.querySelector<HTMLElement>(".assist-label");
    if (!label) continue;
    const cs = getComputedStyle(label);
    const box = getComputedStyle(el);
    const text = label.textContent ?? "";
    const expected = parseFloat(cs.fontSize);
    if (!(expected > 0)) continue;
    cv.font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
    // 以期望字号为 1em 的自然宽；留 2%——canvas 量宽与实际排版有零点几像素出入
    const em = (str: string) => (cv.measureText(str).width / expected) * 1.02;
    const { top, width } = el.getBoundingClientRect();   // 同一 flex 行的格子顶边相同
    const tile: Tile = {
      el, expected, em: em(text),
      word: Math.max(0, ...text.split(" ").map(em)),
      // 文案可用宽 = 格子 border-box 宽 − 左右内衬与描边（clientWidth 取整，这里要小数宽）
      inner: width - [box.paddingLeft, box.paddingRight, box.borderLeftWidth, box.borderRightWidth]
        .reduce((sum, v) => sum + parseFloat(v), 0),
      latin: /[A-Za-z]/.test(text),
    };
    const key = Math.round(top);
    rows.set(key, [...(rows.get(key) ?? []), tile]);
  }
  for (const row of rows.values()) {
    const head = row[0];
    const scale = head.expected / 12.5;                       // 界面字号倍率
    const fit = Math.min(...row.map((t) => t.inner / t.em));   // 整行排成单行的最大字号
    const floor = row.some((t) => t.latin) ? Math.max(9, 10 * scale) : Math.max(9, 8.5 * scale);
    if (fit >= Math.min(head.expected, floor)) {
      for (const t of row) t.el.style.fontSize = `${Math.min(head.expected, fit)}px`;
      continue;
    }
    for (const t of row) {
      const wordFit = t.inner / t.word;
      if (t.latin && wordFit < t.expected && wordFit >= Math.max(9, 9.5 * scale)) {
        t.el.style.fontSize = `${wordFit}px`;
      }
    }
  }
}

/** 命令格：图标在上、文案在下的按钮，其余 props 透传 AssistButton。文案字号由
 *  fitTileLabels 逐行实测后写在按钮的内联 style 上。 */
function AssistTile({ icon, label, className = "", ...rest }:
  Omit<AssistButtonProps, "className" | "children"> & {
    icon: ReactNode; label: string; className?: string;
  }) {
  return (
    <AssistButton {...rest} className={"assist-item assist-cmd" + (className ? " " + className : "")}>
      <span className="assist-ico">{icon}</span>
      <span className="assist-label">{label}</span>
    </AssistButton>
  );
}

export function AssistBall({
  open,
  onOpenChange,
  onPageUp,
  onPageDown,
  onBottom,
  onKey,
  focusMode,
  chromeToggle,
  chromeOpen,
  onToggleChrome,
  onExitFocus,
  pos,
  onMoveEnd,
  fontSize,
  ballPx,
  onFontDelta,
  onPaste,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onPageUp: () => void;
  onPageDown: () => void;
  onBottom: () => void;
  /** 常用键排（Esc/Tab/^C/↑/↓…）：投给当前落焦终端的真实键序（App 的 sendMobileKey）。 */
  onKey: (data: string) => void;
  /** 专注态才提供「标签与工具栏」与「退出专注」——普通态这两项本来就可见；
   *  「标签与工具栏」的唤出语义是移动端专属（桌面专注态 chrome 本就完整）。 */
  focusMode: boolean;
  /** 是否显示「标签与工具栏」项（移动端 true；桌面专注态只留「退出专注模式」）。 */
  chromeToggle: boolean;
  chromeOpen: boolean;
  onToggleChrome: () => void;
  onExitFocus: () => void;
  /** 球位（拖动落位后持久化）；null = 默认右缘 bottom:96（CSS 锚）。 */
  pos: { x: number; y: number } | null;
  onMoveEnd: (pos: { x: number; y: number }) => void;
  /** 当前会话终端字号（设置里已有全局档，这里做 ±1 微调，同一条通道）。 */
  fontSize: number;
  /** 当前球径（px，随设置档位变化）：进钳制/摆位 effect 依赖——换档后球变大
   *  可能贴边越界，须重钳（审核轮 review-contract 低-2）。 */
  ballPx: number;
  onFontDelta: (d: number) => void;
  /** 粘贴本机剪贴板进当前落焦终端（App 的 assistPaste：pasteTextInto 收口）。 */
  onPaste: () => void;
}) {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const dragPos = useRef<{ x: number; y: number } | null>(null);
  // 拖动起始基准（审核轮修复）：total 位移必须恒定加在它上面——若每帧把基准
  // 改写成上一个落点，匀速拖动会二次方跑偏（S+ΣTᵢ）。null = 非拖动态。
  const dragStart = useRef<{ x: number; y: number } | null>(null);
  // 拖动中 ResizeObserver 想重钳但不能动内联样式（会闪回存储位）：记下待
  // 落点，dragend 由 onBallDragEnd 补钳——比拖中触发即改更稳定（review-geo 中）。
  const pendingClamp = useRef(false);

  useEffect(() => {
    if (!open) return;
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key !== "Escape") return;
      ev.stopPropagation();
      onOpenChange(false);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open, onOpenChange]);

  // 动作后收面板：用户要的是「滚一下接着看/打字」，不是停在菜单里。
  // 但必须晚一拍再卸载（见文件头第 3 条），否则触摸的尾随 click 会落进终端。
  const closeTimer = useRef<number | null>(null);
  const closeSoon = useCallback(() => {
    if (closeTimer.current !== null) return;
    closeTimer.current = window.setTimeout(() => {
      closeTimer.current = null;
      onOpenChange(false);
    }, 0);
  }, [onOpenChange]);
  useEffect(() => () => {
    if (closeTimer.current !== null) window.clearTimeout(closeTimer.current);
  }, []);
  const run = (fn: () => void) => () => {
    fn();
    closeSoon();
  };

  // 持久化球位回放 + 越界纠正（审核轮修复版）：首渲染即按 pos 内联锚定（不闪），
  // 挂载后钳制越界；ResizeObserver 盯 workspace 容器——旋转/缩窗后重钳（横屏存
  // 的位转竖屏球会停在视口外点不到，review-pointer 中危）；ballPx 进依赖，换
  // 球径档同样重钳。钳后若与存储值不同即回写（值相等短路，无回写循环）。
  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    if (!pos) {
      clearWrapPos(wrap);
      return;
    }
    const clampAndApply = () => {
      // 拖动中跳过：wrap 内联样式此刻由 dragStart+total 实时驱动，回写存储
      // 位会让球瞬移回旧位一帧再被下一个 move 拉回（旋转/缩窗恰好落在拖中），
      // 且 onMoveEnd 会把还没松手的中间值写进 localStorage。记 pending 待落。
      if (dragStart.current) { pendingClamp.current = true; return; }
      const c = assistClamp(wrap, pos.x, pos.y);
      applyWrapPos(wrap, c.x, c.y);
      assistUpdateSide(wrap, c.x);
      if (c.x !== pos.x || c.y !== pos.y) onMoveEnd(c);
    };
    clampAndApply();
    const parent = wrap.offsetParent;
    const ro = parent ? new ResizeObserver(clampAndApply) : null;
    if (ro && parent) ro.observe(parent);
    return () => { ro?.disconnect(); };
  }, [pos, onMoveEnd, ballPx]);

  // 面板摆位：默认锚在球上方；自然高放不下时翻下，两侧都不够才保留
  // 最后的应急滚动。正常手机横竖屏面板是满铺网格（命令格 + 键排 + 摇杆，
  // 竖屏两段、宽横屏并成两行），常用键与字号都不靠滚动找，不依赖 56vh
  // 之类固定比例（旧版横屏 319px 内容被压进 200px，常用键全部藏住）。
  // wrap 仍恒等于球盒，开关面板不改变拖动/钳制几何。
  const [menuPlacement, setMenuPlacement] = useState<{ left: number; top: number; maxH: number | null }>({ left: 8, top: 8, maxH: null });
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const wrap = wrapRef.current;
      const menu = menuRef.current;
      if (!wrap || !menu) return;
      const br = wrap.getBoundingClientRect();
      const availAbove = br.top - 16;  // 视口上缘 8px 边距 + 8px 球板间隙
      const availBelow = window.innerHeight - br.bottom - 16;
      // 三档逐级收：常规版式两侧都放不下 → .ts-tight（目标 40→36、间距收一档）→
      // 仍放不下 → .ts-mini（命令格只剩图标，宽横屏并成单行）。软键盘挤压、横屏
      // 分屏半幅、小屏大字号专注态下先保「整板可见、不出滚动条」。先摘掉再量：上一次
      // 的档位不能当这一次的自然高；直接改 class 不走 state——本 effect 在绘制前同步
      // 量几遍，不开第二帧（键盘弹出/收起触发的 resize 同理，切档不闪）。
      const room = Math.max(availAbove, availBelow);
      menu.classList.remove("ts-tight", "ts-mini");
      fitTileLabels(menu);   // 摘完档位再定文案字号（可能改变命令格高度），然后量档位
      if (menu.scrollHeight > room) menu.classList.add("ts-tight");
      if (menu.scrollHeight > room) menu.classList.add("ts-mini");
      // 图标版在极窄视口里键帽会等比收到文案放不下：有任何一格横向溢出就放弃这一档，
      // 退回收紧档的应急滚动——收紧只降尺寸，不会比常规版式更高，所以档位只升不回退
      // 到这里为止。
      if (menu.classList.contains("ts-mini") &&
          [...menu.querySelectorAll<HTMLElement>(".assist-item")].some((el) => el.scrollWidth > el.clientWidth + 1)) {
        menu.classList.remove("ts-mini");
      }
      const want = menu.scrollHeight; // 内容自然高（scrollHeight 不受 max-height 钳制）
      const below = want > availAbove && (want <= availBelow || availBelow > availAbove);
      const maxH = want <= (below ? availBelow : availAbove) ? null
        : Math.max(0, below ? availBelow : availAbove);
      const height = Math.min(want, maxH ?? Number.POSITIVE_INFINITY);
      // fixed 坐标统一相对视口：球在左半就从球缘向右、右半就从球缘向左，
      // 两边都钳进 8px 安全边界；不受 workspace 宽度和左/右 CSS 锚百分比影响。
      const left = Math.max(8, Math.min(window.innerWidth - menu.offsetWidth - 8,
        wrap.classList.contains("assist-left") ? br.left : br.right - menu.offsetWidth));
      const top = Math.max(8, Math.min(window.innerHeight - height - 8,
        below ? br.bottom + 8 : br.top - height - 8));
      setMenuPlacement({ left, top, maxH });
    };
    place();
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
    // focusMode 进依赖：F11 是全局键、面板开着也能进/退专注——专注态多出
    // 两枚界面开关，命令格由一行变两行，scrollHeight 变了不重摆会按旧
    // maxH 裁顶。chromeOpen 同理：唤出工具栏后文案变「收起标签与工具栏」，
    // 125% 字号竖屏下折成两行、面板长高一截。
  }, [open, pos, ballPx, fontSize, focusMode, chromeOpen]);

  // 拖动起步：把当前几何折算成 left/top 坐标（默认锚是 right/bottom，没有现成
  // 坐标）；此后 move 直接改内联样式，不逐帧 setState。
  const onBallDragMove = useCallback((total: { dx: number; dy: number }) => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    if (!dragStart.current) {
      const parent = wrap.offsetParent as HTMLElement | null;
      if (!parent) return;
      const pr = parent.getBoundingClientRect();
      const wr = wrap.getBoundingClientRect();
      dragStart.current = { x: wr.left - pr.left, y: wr.top - pr.top };
    }
    // 累计位移必须恒定加在起始基准上——不能拿上一帧落点当新基准（审核轮
    // review-geo 高危：慢拖匀速时每帧重复累加整段 total，位置二次方跑偏；
    // 大位移直接钳边吸附掩盖了它，spec 靠小步慢拖才抓得到）。
    const c = assistClamp(wrap, dragStart.current.x + total.dx, dragStart.current.y + total.dy);
    dragPos.current = c;
    applyWrapPos(wrap, c.x, c.y);
    assistUpdateSide(wrap, c.x);
  }, []);

  const onBallDragEnd = useCallback((dragged: boolean) => {
    const p = dragPos.current;
    const start = dragStart.current;
    dragPos.current = null;
    dragStart.current = null;
    if (dragged && p) {
      // 拖中若因旋转/缩窗欠过一次重钳（pendingClamp），落点先按新边界补钳
      // 再回写——否则拖后 pos 仍带着旧坐标系的越界值进 localStorage。
      const wrap = wrapRef.current;
      const final = (pendingClamp.current && wrap) ? assistClamp(wrap, p.x, p.y) : p;
      pendingClamp.current = false;
      if (wrap) { applyWrapPos(wrap, final.x, final.y); assistUpdateSide(wrap, final.x); }
      onMoveEnd(final);
      return;
    }
    pendingClamp.current = false;
    if (p) {
      // 拖动被系统打断（pointercancel）/幽灵复位：还原锚定——有存储位回它；
      // 从未落过位（pos=null）清内联样式回 CSS 默认锚（审核轮 review-pointer 低-4）
      const wrap = wrapRef.current;
      if (!wrap) return;
      if (pos) applyWrapPos(wrap, pos.x, pos.y);
      else clearWrapPos(wrap);
    }
  }, [onMoveEnd, pos]);

  return (
    <>
      {open && (
        <div
          className="assist-scrim"
          data-testid="assist-scrim"
          onPointerDown={() => closeSoon()}
        />
      )}
      <div
        className="assist-ball-wrap"
        data-testid="assist-ball-wrap"
        ref={wrapRef}
        // 持久化球位首渲染即锚定（审核轮 review-contract 低-1：挂载后 effect 才
        // 落位会闪一帧默认锚；变量走 main.tsx 首帧前恢复，位置走这里）
        style={pos ? { left: pos.x, top: pos.y, right: "auto", bottom: "auto" } : undefined}
      >
        {open && (
          <div
            className="assist-menu"
            role="menu"
            aria-label={t("快捷操作")}
            data-testid="assist-menu"
            ref={menuRef}
            style={{ left: menuPlacement.left, top: menuPlacement.top,
              maxHeight: menuPlacement.maxH ?? undefined }}
          >
            {/* 命令格（点即执行，面板随即收起）：滚动三项 + 粘贴；专注态追加「标签与
                工具栏」与「退出专注」。图标在上、文案在下——比「图标 + 文案」横排省
                一半高度：竖屏四格一行（专注态第二行两枚宽格）、横屏单行。滚动：正常屏
                走本地 scrollback，备用屏合成触摸板滚轮（见 App assistScroll）——两条路
                都与用户手势同通道。粘贴与 ⌘V/右键同一收口（pasteTextInto 危险扫描），
                执行即收（可能弹多行确认框，面板要让位）。 */}
            <div className="assist-actions">
              <AssistTile role="menuitem" icon={<IconChevronsUp />} label={t("上翻一页")}
                onActivate={run(onPageUp)} />
              <AssistTile role="menuitem" icon={<IconChevronsDown />} label={t("下翻一页")}
                onActivate={run(onPageDown)} />
              <AssistTile role="menuitem" icon={<IconArrowDownToLine />} label={t("回到底部")}
                onActivate={run(onBottom)} />
              <AssistTile role="menuitem" icon={<IconClipboard />} label={t("粘贴")}
                onActivate={run(onPaste)} />
              {focusMode && (
                <>
                  {/* 两枚界面开关带 .assist-chrome：布局据此给它们更宽的位置（文案六
                      到八个字；竖屏占第二行半行宽，横屏单行按 1.3 倍权重要列宽） */}
                  {chromeToggle && (
                    <AssistTile role="menuitem" className={"assist-chrome" + (chromeOpen ? " ts-open" : "")}
                      icon={<IconPanelTop />} pressed={chromeOpen}
                      label={chromeOpen ? t("收起标签与工具栏") : t("标签与工具栏")}
                      onActivate={() => { onToggleChrome(); closeSoon(); }} />
                  )}
                  <AssistTile role="menuitem" className="assist-chrome" icon={<IconMinimize />}
                    label={t("退出专注模式")} onActivate={run(onExitFocus)} />
                </>
              )}
            </div>
            {/* 连点区（点了不收——翻历史、调字号都常要连点）：常用键排 + 字号摇杆。
                键排是触控场景没有键盘时的刚需（中断命令/补全/翻历史），走 sendMobileKey
                的真实键序路径（死会话拦截、tmux 前缀武装、广播扇出、DECCKM 方向键与
                Home/End）。摇杆贴在键排右缘、与键排等高：上 A+ / 中间读数 / 下 A−，
                不再独占一整行（旧版竖屏五行、横屏三行里，字号行只有两枚小钮，其余是空白）。
                竖屏两行各五键、宽横屏十键单行（网格列数见 CSS）；键帽文案必须精确
                （spec 按 textContent 全等匹配），图标一律走 CSS 不掺文本。 */}
            <div className="assist-deck">
              <div className="assist-keys" role="group" aria-label={t("常用键")}>
                <AssistButton className="assist-item assist-key" title="Esc"
                  onActivate={() => onKey("\x1b")}>Esc</AssistButton>
                <AssistButton className="assist-item assist-key" title="Tab"
                  onActivate={() => onKey("\t")}>Tab</AssistButton>
                <AssistButton className="assist-item assist-key assist-key-danger" title={t("中断（Ctrl+C）")}
                  onActivate={() => onKey("\x03")}>^C</AssistButton>
                <AssistButton className="assist-item assist-key" title="↑"
                  onActivate={() => onKey("\x1b[A")}>↑</AssistButton>
                <AssistButton className="assist-item assist-key" title="↓"
                  onActivate={() => onKey("\x1b[B")}>↓</AssistButton>
                <AssistButton className="assist-item assist-key" title={t("行首（Home）")}
                  onActivate={() => onKey("\x1b[H")}>Home</AssistButton>
                <AssistButton className="assist-item assist-key" title={t("行尾（End）")}
                  onActivate={() => onKey("\x1b[F")}>End</AssistButton>
                <AssistButton className="assist-item assist-key" title={t("上翻页键（PageUp）")}
                  onActivate={() => onKey("\x1b[5~")}>PgUp</AssistButton>
                <AssistButton className="assist-item assist-key" title={t("下翻页键（PageDown）")}
                  onActivate={() => onKey("\x1b[6~")}>PgDn</AssistButton>
                <AssistButton className="assist-item assist-key" title={t("tmux 前缀（Ctrl-b）")}
                  onActivate={() => onKey("\x02")}>^B</AssistButton>
              </div>
              {/* 终端字号摇杆：小屏（手机本体/远控）看 80 列吃力，±1 微调走设置同一条
                  changeFontSize（全实例应用 + PTY 校准 + 持久化）。不收面板（调字号要
                  看着终端试）。DOM 顺序自上而下：A+ / 读数 / A−，与竖向摇杆的视觉顺序、
                  键盘 Tab 顺序一致（窄屏降级横排时 CSS 反向成 A− 14 A+）。读数是装饰
                  （组标签已含字号），不响应指针——摇杆两半的命中区不被它切开。 */}
              <div className="assist-fontstep" role="group" aria-label={`${t("终端字号")} ${fontSize}`}>
                <AssistButton className="assist-item assist-fontbtn" title={t("增大终端字号")}
                  onActivate={() => onFontDelta(1)}>A+</AssistButton>
                <span className="assist-fontval" aria-hidden="true">{fontSize}</span>
                <AssistButton className="assist-item assist-fontbtn" title={t("减小终端字号")}
                  onActivate={() => onFontDelta(-1)}>A−</AssistButton>
              </div>
            </div>
          </div>
        )}
        <AssistButton
          className={"assist-ball" + (open ? " ts-open" : "")}
          data-testid="assist-ball"
          title={t("快捷操作：翻页 / 常用键 / 字号 / 标签与工具栏（可拖动换位）")}
          aria-label={t("快捷操作（助力球）")}
          aria-haspopup="menu"
          aria-expanded={open}
          onDragMove={onBallDragMove}
          onDragEnd={onBallDragEnd}
          onActivate={() => onOpenChange(!open)}
        ><IconAssist size={Math.round(ballPx * 0.58)} /></AssistButton>
      </div>
    </>
  );
}
