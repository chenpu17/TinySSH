// 助力球（GitHub #40 / #45）：触控场景（手机本体 / 手机远程桌面控制电脑）没有
// 鼠标滚轮，标签条与工具栏又吃空间。右缘悬浮球点开一个动作面板：
//   上翻 / 下翻 / 回到底部 / 粘贴剪贴板（正常屏走 xterm 本地 scrollback；备用屏
//   tmux/vim 全屏合成触摸板滚轮事件，与用户触摸板同一通道，见 App 的 assistScroll；
//   粘贴与 ⌘V/右键同一收口 pasteTextInto，危险扫描/多行确认不旁路）
//   + 常用键排（Esc/Tab/^C/↑/↓ 与 Home/End/PgUp/PgDn/^B，经 App 的 sendMobileKey
//     走真实键序路径，方向键与 Home/End 跟随 DECCKM；点键后面板不收——连点刚需）
//   + 终端字号行（A− / A+，走设置同一条 changeFontSize 通道：全实例应用 + PTY 校准）
//   + 专注态唤出/收起标签与工具栏（#45「专注模式下标签按钮栏碍事」，移动端专属）。
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
import { useCallback, useEffect, useRef } from "react";
import type { PointerEvent as ReactPointerEvent, ReactNode } from "react";
import { t } from "../i18n";
import { IconChevronUp, IconChevronDown, IconArrowDown, IconRows, IconMinimize, IconCopy } from "../icons";

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

/** 触摸可用的「按下即保持焦点、抬起即执行」按钮。
 *  - pointerdown preventDefault：保住 xterm 焦点 / 软键盘。
 *  - pointerup（仅 touch，且按下也落在本钮）：触摸的激活入口。Chrome Android
 *    在 pointerdown 被 preventDefault 后**仍会**补一个 click（事件序列实测：
 *    pointerdown → pointerup → click），所以 click 侧必须去重，否则一次点按
 *    会把面板开了又关。
 *  - onClick：鼠标/键盘路径，以及没抑制住 click 的 WebView；刚由 pointerup
 *    激活过的 700ms 内忽略。
 *  - onDragMove/onDragEnd（可选，球位拖动用）：按下后累计位移 ≥DRAG_THRESHOLD
 *    进入拖动态——setPointerCapture 保住移出球体的 move 流、抑制激活（抬起不开
 *    面板），end 交外部落位；拖完的尾随 click（触摸补发 / 鼠标抬起）同样落在
 *    700ms 去重窗里被吃掉。
 */
function AssistButton({
  onActivate, className, children, role, pressed, onDragMove, onDragEnd, ...rest
}: {
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
}) {
  const down = useRef(false);
  const touchAt = useRef(0);
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
        // 鼠标/触控笔按下会紧跟自己的 click：清掉触摸去重窗口，别把鼠标点也吞了
        if (ev.pointerType !== "touch") touchAt.current = 0;
      }}
      onPointerMove={(ev: ReactPointerEvent) => {
        if (!onDragMove || !down.current || !dragFrom.current) return;
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
          // 拖完抑制随后的 click（触摸补发 / 鼠标抬起 click 同吃）：去重窗口
          touchAt.current = Date.now();
          onDragEnd?.(true);
          return;
        }
        dragFrom.current = null;
        if (ev.pointerType !== "touch" || !down.current) return;
        down.current = false;
        touchAt.current = Date.now();
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
      onClick={() => {
        if (Date.now() - touchAt.current < 700) return;
        onActivate();
      }}
    >
      {children}
    </button>
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
  onFontDelta: (d: number) => void;
  /** 粘贴本机剪贴板进当前落焦终端（App 的 assistPaste：pasteTextInto 收口）。 */
  onPaste: () => void;
}) {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const dragPos = useRef<{ x: number; y: number } | null>(null);

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

  // 持久化球位回放 + 越界纠正（视口比上次小时旧位置可能出界）：钳后若与存储
  // 值不同即回写（经 onMoveEnd 落 state + localStorage，值相等则 React 空转）。
  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    if (!pos) {
      wrap.style.left = "";
      wrap.style.top = "";
      wrap.style.right = "";
      wrap.style.bottom = "";
      wrap.classList.remove("assist-left");
      return;
    }
    const c = assistClamp(wrap, pos.x, pos.y);
    applyWrapPos(wrap, c.x, c.y);
    assistUpdateSide(wrap, c.x);
    if (c.x !== pos.x || c.y !== pos.y) onMoveEnd(c);
  }, [pos, onMoveEnd]);

  // 拖动起步：把当前几何折算成 left/top 坐标（默认锚是 right/bottom，没有现成
  // 坐标）；此后 move 直接改内联样式，不逐帧 setState。
  const onBallDragMove = useCallback((total: { dx: number; dy: number }) => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    if (!dragPos.current) {
      const parent = wrap.offsetParent as HTMLElement | null;
      if (!parent) return;
      const pr = parent.getBoundingClientRect();
      const wr = wrap.getBoundingClientRect();
      dragPos.current = { x: wr.left - pr.left, y: wr.top - pr.top };
    }
    const c = assistClamp(wrap, dragPos.current.x + total.dx, dragPos.current.y + total.dy);
    dragPos.current = c;
    applyWrapPos(wrap, c.x, c.y);
    assistUpdateSide(wrap, c.x);
  }, []);

  const onBallDragEnd = useCallback((dragged: boolean) => {
    const p = dragPos.current;
    dragPos.current = null;
    if (dragged && p) {
      onMoveEnd(p);
    } else if (p && pos) {
      // 拖动被系统打断（pointercancel）：恢复原锚定位
      const wrap = wrapRef.current;
      if (wrap) applyWrapPos(wrap, pos.x, pos.y);
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
      <div className="assist-ball-wrap" data-testid="assist-ball-wrap" ref={wrapRef}>
        {open && (
          <div className="assist-menu" role="menu" aria-label={t("快捷操作")} data-testid="assist-menu">
            {/* 滚动组：图标芯片 + 文案。正常屏走本地 scrollback，备用屏合成
                触摸板滚轮（见 App assistScroll）——两条路都与用户手势同通道。
                粘贴剪贴板与 ⌘V/右键同一收口（pasteTextInto 危险扫描），执行即收
                （可能弹多行确认框，面板要让位）。 */}
            <div className="assist-section">
              <AssistButton role="menuitem" className="assist-item assist-scroll"
                onActivate={run(onPageUp)}>
                <span className="assist-ico"><IconChevronUp /></span>
                <span className="assist-label">{t("上翻一页")}</span>
              </AssistButton>
              <AssistButton role="menuitem" className="assist-item assist-scroll"
                onActivate={run(onPageDown)}>
                <span className="assist-ico"><IconChevronDown /></span>
                <span className="assist-label">{t("下翻一页")}</span>
              </AssistButton>
              <AssistButton role="menuitem" className="assist-item assist-scroll"
                onActivate={run(onBottom)}>
                <span className="assist-ico"><IconArrowDown /></span>
                <span className="assist-label">{t("回到底部")}</span>
              </AssistButton>
              <AssistButton role="menuitem" className="assist-item assist-scroll"
                onActivate={run(onPaste)}>
                <span className="assist-ico"><IconCopy /></span>
                <span className="assist-label">{t("粘贴剪贴板")}</span>
              </AssistButton>
            </div>
            {/* 常用键排：触控场景没有键盘时的刚需（中断命令/补全/翻历史）。走
                sendMobileKey 的真实键序路径（死会话拦截、tmux 前缀武装、广播扇出、
                DECCKM 方向键与 Home/End）；点键后面板不收——历史上下翻常要连点。
                两行各五键（flex-wrap 自动换行）；^B 发真实 C-b，tmux 前缀武装在
                onData 同一条路上自然接管。键帽文案必须精确（spec 按 textContent
                全等匹配），图标一律走 CSS 不掺文本。 */}
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
              <AssistButton className="assist-item assist-key" title={t("tmux 前缀（Ctrl+B）")}
                onActivate={() => onKey("\x02")}>^B</AssistButton>
            </div>
            {/* 终端字号行：小屏（手机本体/远控）看 80 列吃力，±1 微调走设置同一条
                changeFontSize（全实例 options + PTY fit 校准 + 持久化）。不收面板
                （调字号要看着终端试）。 */}
            <div className="assist-fontrow" role="group" aria-label={t("终端字号")}>
              <span className="assist-font-label">{t("终端字号")} {fontSize}</span>
              <AssistButton className="assist-item assist-fontbtn" title={t("减小终端字号")}
                onActivate={() => onFontDelta(-1)}>A−</AssistButton>
              <AssistButton className="assist-item assist-fontbtn" title={t("增大终端字号")}
                onActivate={() => onFontDelta(1)}>A+</AssistButton>
            </div>
            {focusMode && (
              <div className="assist-section assist-focus">
                {chromeToggle && (
                  <AssistButton role="menuitem"
                    className={"assist-item assist-scroll" + (chromeOpen ? " ts-open" : "")}
                    pressed={chromeOpen}
                    onActivate={() => { onToggleChrome(); closeSoon(); }}>
                    <span className="assist-ico"><IconRows /></span>
                    <span className="assist-label">{chromeOpen ? t("收起标签与工具栏") : t("标签与工具栏")}</span>
                  </AssistButton>
                )}
                <AssistButton role="menuitem" className="assist-item assist-scroll"
                  onActivate={run(onExitFocus)}>
                  <span className="assist-ico"><IconMinimize /></span>
                  <span className="assist-label">{t("退出专注模式")}</span>
                </AssistButton>
              </div>
            )}
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
        >⇅</AssistButton>
      </div>
    </>
  );
}
