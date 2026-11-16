// 触屏浮条（移动端终端选区 / 链接点按）：一条 40dp 高的小横条 + 全屏遮罩。
// 与右键菜单同族——遮罩点击、Esc、Android 返回都关闭（关闭动作由 App 的
// 栈顶链负责，这里只负责渲染与定位）。
//
// 弹出时机是「长按计时器触发」或「点按链接的 mouseup」——手指还按着/刚抬起，
// 随后的合成 click 会打到刚出现的遮罩上把浮条关掉，调用方必须先
// `swallowClickOnce()`（见 touch.ts）。
import type { CSSProperties } from "react";
import { useLayoutEffect, useRef } from "react";
import { clampIntoView } from "./ctx-menus";

export interface TouchBarItem {
  label: string;
  onClick: () => void;
  testid?: string;
}

export interface TouchBarProps {
  x: number;
  y: number;
  items: TouchBarItem[];
  onClose: () => void;
  testid?: string;
}

export function TouchBar({ x, y, items, onClose, testid = "touch-bar" }: TouchBarProps) {
  const elRef = useRef<HTMLDivElement | null>(null);
  // 浮条会在同一实例里换页（选区页 → 更多页，按钮数与高度都变）：挂载时的回夹
  // 对第二页不生效，换页后必须按新尺寸再量一次，否则窄屏上第二行可能沉出视口。
  useLayoutEffect(() => { clampIntoView(elRef.current); }, [items]);
  // 先按「触点上方一指宽」估算落点，clampIntoView 再按实测宽高回夹视口
  const style: CSSProperties = {
    left: Math.max(6, Math.min(x - 60, window.innerWidth - 240)),
    top: Math.max(6, y - 58),
  };
  return (
    <>
      <div
        className="pop-mask"
        data-testid={testid + "-mask"}
        onClick={onClose}
        onContextMenu={(e) => { e.preventDefault(); onClose(); }}
      />
      <div className="touch-bar" role="menu" data-testid={testid} style={style} ref={(el) => { elRef.current = el; clampIntoView(el); }}>
        {items.map((it) => (
          <button
            key={it.label}
            role="menuitem"
            className="touch-bar-btn"
            data-testid={it.testid}
            onPointerDown={(e) => e.preventDefault() /* 不抢终端焦点、不收起软键盘 */}
            onClick={it.onClick}
          >{it.label}</button>
        ))}
      </div>
    </>
  );
}
