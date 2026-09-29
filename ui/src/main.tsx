import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./styles.css";

// 注意：createRoot 只能调用一次——此前这段代码被复制了两份，两个 React 根
// 同时挂载两个 <App/>，窗口级 keydown 监听随之翻倍（⌘W 一次关两个会话、
// ⌘= 一次步进两号）——T19 走查经审计 55ms 双 session_closed 实锤后修复。
ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
