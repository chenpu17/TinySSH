// 触屏长按 → 右键菜单的移动端等价物。
//
// 一批操作（标签菜单、文件行菜单、最近连接菜单）在桌面只挂在 onContextMenu 上；
// 安卓 WebView 对普通元素长按不会派发 contextmenu，这些入口在手机上不可达。
// 这里用 pointer 事件自己识别长按（480ms、位移 10px 内），触发后吞掉随后的
// click，避免「长按弹菜单的同时顺手切换了标签 / 连上了主机」。
//
// 一个列表共用一个实例即可（同一时刻只有一个指针在长按）：down 时传入本行的
// 触发回调，元素与坐标都随事件带走，map 渲染的行不必各持一个 hook。
// 只在移动装配生效：桌面触屏笔电的触屏点按维持既有语义（鼠标事件不受影响）。
import { useRef } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { isMobilePlatform } from "./platform";

const LONG_PRESS_MS = 480;
const MOVE_CANCEL_PX = 10;

/** 长按触发后吞掉紧跟着的那一次 click（window 捕获阶段，压过 React 根上的委托）。
 *  终端的选区/链接浮条同样在手指还按着（或抬指当下）落地，也要走这一下。 */
export function swallowClickOnce() {
  const swallow = (ev: Event) => { ev.stopPropagation(); ev.preventDefault(); };
  window.addEventListener("click", swallow, true);
  window.setTimeout(() => window.removeEventListener("click", swallow, true), 600);
}

/** 终端屏内的触摸点按放行兼容鼠标事件（KI-132），应用装配时安装一次。
 *
 *  xterm 6.1 起终端触摸滚动改由内置手势层驱动：它在 document 上以非 passive 监听
 *  touchstart/touchmove/touchend，并取消默认行为来压掉浏览器原生滚动。点按被一并
 *  取消——touchstart/touchend 一旦取消，Chromium 就不再合成兼容鼠标事件（mousedown
 *  /mouseup/click），而 xterm 自己的聚焦、链接点按、单击清选区，以及「点终端区域即
 *  聚焦当前会话」都挂在这些鼠标事件上：手机上点终端不出软键盘、点链接没有浮条
 *  （6.0 没有手势层，这些都是好的）。
 *
 *  这里在 window 捕获阶段先于手势层拿到事件：触点全部落在终端屏（.xterm-screen）内
 *  的 touchstart/touchend，把它们的 preventDefault 换成空操作。手势层照常收到事件，
 *  触摸滚动不受影响（touchmove 不放行，仍由它取消）；只是点按的默认行为放行，浏览器
 *  照常合成鼠标事件。不能反过来拦掉 touch 事件——6.1 的终端滚动依赖手势层。
 *  不按平台设门：桌面触屏笔电上点终端同样被手势层取消。 */
export function installTermTouchTapCompat(): () => void {
  const inTermScreen = (target: EventTarget | null | undefined) =>
    target instanceof Element && target.closest(".xterm-screen") !== null;
  const passTap = (ev: TouchEvent) => {
    const touches = ev.type === "touchstart" ? ev.touches : ev.changedTouches;
    for (let i = 0; i < touches.length; i++) {
      if (!inTermScreen(touches.item(i)?.target)) return;
    }
    if (touches.length) ev.preventDefault = () => { /* 点按放行：见上 */ };
  };
  window.addEventListener("touchstart", passTap, { capture: true, passive: true });
  window.addEventListener("touchend", passTap, { capture: true, passive: true });
  return () => {
    window.removeEventListener("touchstart", passTap, true);
    window.removeEventListener("touchend", passTap, true);
  };
}

export type LongPress = {
  /** 在 onPointerDown 里调用；非触屏 / 非移动端直接忽略。 */
  down: (ev: ReactPointerEvent, onFire: () => void) => void;
  move: (ev: ReactPointerEvent) => void;
  up: (ev: ReactPointerEvent) => void;
  /** 长按已触发时返回 true——调用方在 click 开头据此直接 return。 */
  consumeClick: () => boolean;
};

export function useLongPress(): LongPress {
  const timerRef = useRef<number | null>(null);
  const originRef = useRef<{ x: number; y: number } | null>(null);
  const firedRef = useRef(false);

  const cancel = () => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    originRef.current = null;
  };

  const apiRef = useRef<LongPress | null>(null);
  if (apiRef.current === null) apiRef.current = {
    down(ev, onFire) {
      if (ev.pointerType !== "touch" || !isMobilePlatform()) return;
      cancel();
      firedRef.current = false;
      originRef.current = { x: ev.clientX, y: ev.clientY };
      // 接管指针：菜单 480ms 后在手指下方落地，若不 capture，抬手那一下的 click
      // 会打到刚出现的 .pop-mask 上把菜单立刻关掉（真机实测）。capture 后 click
      // 回到本行，由 consumeClick 吞掉；抬手/滚动取消时浏览器自动释放。
      try { ev.currentTarget.setPointerCapture(ev.pointerId); } catch { /* 指针已失效，忽略 */ }
      timerRef.current = window.setTimeout(() => {
        timerRef.current = null;
        firedRef.current = true;
        // 菜单落地时手指还按着，抬手那一下的 click 会打到新出现的 .pop-mask 上把
        // 菜单立刻关掉（真机实测：capture 到本元素也拦不住 click 的命中测试）。
        // 触发后 600ms 内捕获阶段吞掉一次 click，这一下就不再冒泡给 React。
        swallowClickOnce();
        onFire();
      }, LONG_PRESS_MS);
    },
    move(ev) {
      if (ev.pointerType !== "touch" || originRef.current === null) return;
      const dx = ev.clientX - originRef.current.x;
      const dy = ev.clientY - originRef.current.y;
      if (dx * dx + dy * dy > MOVE_CANCEL_PX * MOVE_CANCEL_PX) cancel();
    },
    up() {
      cancel();
    },
    consumeClick() {
      if (!firedRef.current) return false;
      firedRef.current = false;
      return true;
    },
  };
  return apiRef.current;
}
