// 助力球（GitHub #40 / #45）：触控场景（手机本体 / 手机远程桌面控制电脑）没有
// 鼠标滚轮，标签条与工具栏又吃空间。右缘悬浮球点开一个动作面板：
//   上翻 / 下翻 / 回到底部（正常屏走 xterm 本地 scrollback；备用屏 tmux/vim
//   全屏合成触摸板滚轮事件，与用户触摸板同一通道，见 App 的 assistScroll）
//   + 常用键排（Esc / Tab / ^C / ↑ / ↓，经 App 的 sendMobileKey 走真实键序路径，
//     方向键跟随 DECCKM；点键后面板不收——历史上下翻常要连点）
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
// 3. 滚动/专注项收起要晚一拍（closeSoon）：Chrome Android 在 pointerup 之后还会
//    补一个 click。若面板在 pointerup 里立即卸载，这个 click 就穿过落到终端画布上，
//    xterm 拿下焦点、软键盘弹起——刚用面板翻了一屏，键盘立刻盖住半屏（真机
//    实测）。把卸载推迟到 click 之后，click 落在仍在的面板/遮罩上被吃掉。
//    常用键不收面板，无此问题。
import { useEffect, useRef } from "react";
import type { PointerEvent as ReactPointerEvent, ReactNode } from "react";
import { t } from "../i18n";
import { IconChevronUp, IconChevronDown, IconArrowDown, IconRows, IconMinimize } from "../icons";

/** 软键盘已收起（Android 推的 `data-ime="0"`）但 xterm 仍持焦点（用户按了
 *  返回键收键盘）：此时 pointerdown preventDefault 会让 Chrome 在下一次触摸
 *  把键盘重新弹起（真机实测）。放行默认行为，让按钮接管焦点、终端失焦。 */
function imeDismissedWithTerminalFocus(): boolean {
  if (document.documentElement.dataset.ime !== "0") return false;
  const ae = document.activeElement;
  return ae instanceof HTMLElement && ae.classList.contains("xterm-helper-textarea");
}

/** 触摸可用的「按下即保持焦点、抬起即执行」按钮。
 *  - pointerdown preventDefault：保住 xterm 焦点 / 软键盘。
 *  - pointerup（仅 touch，且按下也落在本钮）：触摸的激活入口。Chrome Android
 *    在 pointerdown 被 preventDefault 后**仍会**补一个 click（事件序列实测：
 *    pointerdown → pointerup → click），所以 click 侧必须去重，否则一次点按
 *    会把面板开了又关。
 *  - onClick：鼠标/键盘路径，以及没抑制住 click 的 WebView；刚由 pointerup
 *    激活过的 700ms 内忽略。
 */
function AssistButton({
  onActivate, className, children, role, pressed, ...rest
}: {
  onActivate: () => void;
  className?: string;
  children: ReactNode;
  role?: string;
  pressed?: boolean;
  [key: `data-${string}`]: string | undefined;
  title?: string;
  "aria-label"?: string;
  "aria-haspopup"?: "menu";
  "aria-expanded"?: boolean;
}) {
  const down = useRef(false);
  const touchAt = useRef(0);
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
        // 鼠标/触控笔按下会紧跟自己的 click：清掉触摸去重窗口，别把鼠标点也吞了
        if (ev.pointerType !== "touch") touchAt.current = 0;
      }}
      onPointerUp={(ev: ReactPointerEvent) => {
        if (ev.pointerType !== "touch" || !down.current) return;
        down.current = false;
        touchAt.current = Date.now();
        onActivate();
      }}
      onPointerCancel={() => { down.current = false; }}
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
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onPageUp: () => void;
  onPageDown: () => void;
  onBottom: () => void;
  /** 常用键排（Esc/Tab/^C/↑/↓）：投给当前落焦终端的真实键序（App 的 sendMobileKey）。 */
  onKey: (data: string) => void;
  /** 专注态才提供「标签与工具栏」与「退出专注」——普通态这两项本来就可见；
   *  「标签与工具栏」的唤出语义是移动端专属（桌面专注态 chrome 本就完整）。 */
  focusMode: boolean;
  /** 是否显示「标签与工具栏」项（移动端 true；桌面专注态只留「退出专注模式」）。 */
  chromeToggle: boolean;
  chromeOpen: boolean;
  onToggleChrome: () => void;
  onExitFocus: () => void;
}) {
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
  const closeSoon = () => {
    if (closeTimer.current !== null) return;
    closeTimer.current = window.setTimeout(() => {
      closeTimer.current = null;
      onOpenChange(false);
    }, 0);
  };
  useEffect(() => () => {
    if (closeTimer.current !== null) window.clearTimeout(closeTimer.current);
  }, []);
  const run = (fn: () => void) => () => {
    fn();
    closeSoon();
  };

  return (
    <>
      {open && (
        <div
          className="assist-scrim"
          data-testid="assist-scrim"
          onPointerDown={() => closeSoon()}
        />
      )}
      <div className="assist-ball-wrap" data-testid="assist-ball-wrap">
        {open && (
          <div className="assist-menu" role="menu" aria-label={t("快捷操作")} data-testid="assist-menu">
            {/* 滚动组：图标芯片 + 文案。正常屏走本地 scrollback，备用屏合成
                触摸板滚轮（见 App assistScroll）——两条路都与用户手势同通道。 */}
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
            </div>
            {/* 常用键排：触控场景没有键盘时的刚需（中断命令/补全/翻历史）。走
                sendMobileKey 的真实键序路径（死会话拦截、tmux 前缀武装、广播扇出、
                DECCKM 方向键）；点键后面板不收——历史上下翻常要连点。键帽文案
                必须精确（spec 按 textContent 全等匹配），图标一律走 CSS 不掺文本。 */}
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
          title={t("快捷操作：翻页 / 常用键 / 标签与工具栏")}
          aria-label={t("快捷操作（助力球）")}
          aria-haspopup="menu"
          aria-expanded={open}
          onActivate={() => onOpenChange(!open)}
        >⇅</AssistButton>
      </div>
    </>
  );
}
