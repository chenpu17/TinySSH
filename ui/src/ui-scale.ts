// 界面字号（KI-024 口径②）：只放大应用界面文字——左侧连接管理、菜单、状态栏、
// 设置面板等都跟随；终端字号仍是独立设置（xterm options.fontSize），不受影响。
//
// 落地方式：CSS 变量 --ui-font-scale。styles.css 里全部 UI 的 font-size 都写成
// `calc(Npx * var(--ui-font-scale))`，改档只改一个变量，无需逐组件重渲染；图标/
// 内边距不缩放（图标按 px 由组件传入，保持与文字同一视觉档）。
//
// 持久化刻意走 localStorage 同步读写（与 zoom.ts 同因）：字号必须在首帧前恢复，
// KV 是异步读取，会先闪一帧 100%。浏览器 demo 与桌面壳同一通路。
const UI_FONT_SCALE_KEY = "ui.ui_font_scale";

/** 可选档位：与「界面缩放」的档位同刻度，避免两套百分比各说各话。 */
export const UI_FONT_SCALES = [0.9, 1, 1.1, 1.25] as const;
export type UiFontScale = (typeof UI_FONT_SCALES)[number];
export const UI_FONT_SCALE_DEFAULT: UiFontScale = 1;

/** 解析持久值：坏值/缺省回 100%；只认白名单档位。 */
export function parseUiFontScale(v: string | null | undefined): UiFontScale {
  const n = Number(v);
  return (UI_FONT_SCALES as readonly number[]).includes(n) ? (n as UiFontScale) : UI_FONT_SCALE_DEFAULT;
}

/** 把档位落到根变量（幂等；首帧前调用避免闪跳）。 */
export function applyUiFontScale(scale: UiFontScale): void {
  document.documentElement.style.setProperty("--ui-font-scale", String(scale));
}

/** 读持久档位（localStorage 不可用时回默认，不抛）。 */
export function loadUiFontScale(): UiFontScale {
  try {
    return parseUiFontScale(localStorage.getItem(UI_FONT_SCALE_KEY));
  } catch {
    return UI_FONT_SCALE_DEFAULT;
  }
}

/** 设置面板改档：落变量 + 落盘（写失败不回滚——界面已按新档渲染，回滚才是幻影）。 */
export function storeUiFontScale(scale: UiFontScale): void {
  applyUiFontScale(scale);
  try {
    localStorage.setItem(UI_FONT_SCALE_KEY, String(scale));
  } catch {
    /* 隐私模式/配额：尽力而为 */
  }
}
