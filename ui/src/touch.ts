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

/** 长按触发后吞掉紧跟着的那一次 click（window 捕获阶段，压过 React 根上的委托）。 */
function swallowNextClick() {
  const swallow = (ev: Event) => { ev.stopPropagation(); ev.preventDefault(); };
  window.addEventListener("click", swallow, true);
  window.setTimeout(() => window.removeEventListener("click", swallow, true), 600);
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
        swallowNextClick();
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
