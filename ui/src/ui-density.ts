// 界面密度（用户反馈 #24）：非全屏时标题栏/标签栏/会话工具栏/状态条四层 chrome
// 在矮窗里占掉太多纵向空间。紧凑档只压缩这四条的固定高度与内边距，不改字号、
// 不改终端字号与整窗缩放，也不隐藏任何入口（专注模式仍是「全让给终端」的极端档）。
//
// 落地方式：根元素 data-density="compact" + CSS 变量 --chrome-*-h。与界面字号
// 同理走 localStorage 同步读写，首帧前恢复，避免先按舒适档画一帧再跳。
const UI_DENSITY_KEY = "ui.ui_density";

export const UI_DENSITIES = ["comfortable", "compact"] as const;
export type UiDensity = (typeof UI_DENSITIES)[number];
export const UI_DENSITY_DEFAULT: UiDensity = "comfortable";

/** 解析持久值：坏值/缺省回舒适档；只认白名单。 */
export function parseUiDensity(v: string | null | undefined): UiDensity {
  return (UI_DENSITIES as readonly string[]).includes(v ?? "") ? (v as UiDensity) : UI_DENSITY_DEFAULT;
}

/** 把档位落到根元素（幂等；首帧前调用避免闪跳）。舒适档移除属性，CSS 走默认值。 */
export function applyUiDensity(density: UiDensity): void {
  const root = document.documentElement;
  if (density === UI_DENSITY_DEFAULT) delete root.dataset.density;
  else root.dataset.density = density;
}

/** 读持久档位（localStorage 不可用时回默认，不抛）。 */
export function loadUiDensity(): UiDensity {
  try {
    return parseUiDensity(localStorage.getItem(UI_DENSITY_KEY));
  } catch {
    return UI_DENSITY_DEFAULT;
  }
}

/** 设置面板改档：落根属性 + 落盘（写失败不回滚——界面已按新档渲染）。 */
export function storeUiDensity(density: UiDensity): void {
  applyUiDensity(density);
  try {
    localStorage.setItem(UI_DENSITY_KEY, density);
  } catch {
    /* 隐私模式/配额：尽力而为 */
  }
}
