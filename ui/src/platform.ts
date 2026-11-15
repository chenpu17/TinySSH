// 平台判定（与 main.tsx 挂的 data-platform 同源）：移动端装配只在 Android/iOS
// webview 上生效，桌面窗口与浏览器 demo 一律算桌面。样式裁剪读 CSS 的
// :root[data-platform=...]，行为裁剪读这里。
export function isMobilePlatform(): boolean {
  const p = document.documentElement.dataset.platform;
  return p === "android" || p === "ios";
}
