import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
// MiSans VF 先于 styles.css 注册 @font-face（uni-range 分片，浏览器按需取用）：
// 中文 UI 的字形主力——Windows 下中文回退微软雅黑是「土」观感的主因（UX 五轮），
// Latin 仍归 Inter，MiSans 只接 CJK 与 Inter 未覆盖的字形
import "./assets/fonts/misans/MiSansVF.min.css";
import "./styles.css";

// 注意：createRoot 只能调用一次——此前这段代码被复制了两份，两个 React 根
// 同时挂载两个 <App/>，窗口级 keydown 监听随之翻倍（⌘W 一次关两个会话、
// ⌘= 一次步进两号）——T19 走查经审计 55ms 双 session_closed 实锤后修复。
ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
