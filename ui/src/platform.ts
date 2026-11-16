import { useEffect, useState } from "react";

// 平台判定（与 main.tsx 挂的 data-platform 同源）：移动端装配只在 Android/iOS
// webview 上生效，桌面窗口与浏览器 demo 一律算桌面。样式裁剪读 CSS 的
// :root[data-platform=...]，行为裁剪读这里。
export function isMobilePlatform(): boolean {
  const p = document.documentElement.dataset.platform;
  return p === "android" || p === "ios";
}

// 外接键盘（USB/蓝牙/OTG，移动端装配）：原生侧探测到后给 <html> 挂 data-hwkb="1"，
// 插拔时改属性并（可选）发 tinyssh-hwkb 事件。有硬件键盘时辅助键条不渲染、连上后
// 自动聚焦终端（软键盘场景仍不抢焦点）。与 data-platform 同源：行为裁剪读这里。
export function isHardwareKeyboard(): boolean {
  return document.documentElement.dataset.hwkb === "1";
}

/** 原生探测结果落标记；false 时删除属性（=无硬件键盘，走软键盘路径）。 */
export function markHardwareKeyboard(present: boolean): void {
  if (present) document.documentElement.dataset.hwkb = "1";
  else delete document.documentElement.dataset.hwkb;
}

/** 订阅标记变化：属性（MutationObserver）与事件双监听——原生只推属性也能触发；
 *  事件早于挂载的情况由 isHardwareKeyboard 的初值兜住。返回取消函数。 */
export function subscribeHardwareKeyboard(onChange: (present: boolean) => void): () => void {
  const mo = new MutationObserver(() => onChange(isHardwareKeyboard()));
  mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-hwkb"] });
  const onEvent = () => onChange(isHardwareKeyboard());
  window.addEventListener("tinyssh-hwkb", onEvent);
  return () => {
    mo.disconnect();
    window.removeEventListener("tinyssh-hwkb", onEvent);
  };
}

/** App 用的响应式读数（React hook）。 */
export function useHardwareKeyboard(): boolean {
  const [present, setPresent] = useState(isHardwareKeyboard);
  useEffect(() => subscribeHardwareKeyboard(setPresent), []);
  return present;
}
