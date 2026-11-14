import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
// MiSans VF 先于 styles.css 注册 @font-face（uni-range 分片，浏览器按需取用）：
// 中文 UI 的字形主力——Windows 下中文回退微软雅黑是「土」观感的主因（UX 五轮），
// Latin 仍归 Inter，MiSans 只接 CJK 与 Inter 未覆盖的字形
import "./assets/fonts/misans/MiSansVF.min.css";
import "./styles.css";
import { applyUiFontScale, loadUiFontScale } from "./ui-scale";
import { applyUiDensity, loadUiDensity } from "./ui-density";

// 界面字号（KI-024）：必须在首帧前落到根变量——设置里改过档位时，晚一拍恢复
// 会先按 100% 画一帧再跳大，闪得明显。
applyUiFontScale(loadUiFontScale());
// 界面密度（#24）：同样首帧前恢复，避免舒适档画一帧再压矮。
applyUiDensity(loadUiDensity());

// 平台标记（移动端移植）：Android/iOS webview 上给 <html> 挂 data-platform。
// 样式与功能裁剪都读这个标记——v1 移动范围只保 SSH + tmux，Agent/跨主机编排/
// 资源监控/协作入口在移动端不出现；桌面（含浏览器 demo）完全不受影响。
const ua = navigator.userAgent;
const platform = /Android/i.test(ua) ? "android" : /iPhone|iPad|iPod/i.test(ua) ? "ios" : "";
if (platform) document.documentElement.dataset.platform = platform;

// 注意：createRoot 只能调用一次——此前这段代码被复制了两份，两个 React 根
// 同时挂载两个 <App/>，窗口级 keydown 监听随之翻倍（⌘W 一次关两个会话、
// ⌘= 一次步进两号）——T19 走查经审计 55ms 双 session_closed 实锤后修复。
ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
