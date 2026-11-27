// 首帧主题引导：index.html 在 CSS 前同步加载。外观/色板是 localStorage 镜像
// （App.tsx applyChrome/applyPalette 随每次变更写入），这里先挂 dataset，
// 避免浅色用户在设置异步读回前先看到一屏深色。CSP 禁内联脚本，故独立文件。
(function () {
  var root = document.documentElement;
  // 出厂默认色板 = 东京夜（对应 app-data.ts 的 PALETTE_DEFAULT，改默认时两处同改）。
  // 先挂上再读存储：没有 data-theme 时 CSS 落回 :root 石墨基底，首次启动会先闪一帧
  // 石墨青、等 App 挂载才切成东京夜（KI-139）。
  root.dataset.theme = "tokyo";
  try {
    var chrome = localStorage.getItem("ui.chrome");
    if (chrome !== "light" && chrome !== "dark") {
      chrome = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
    }
    root.dataset.chrome = chrome;
    var palette = localStorage.getItem("ui.palette");
    if (palette) root.dataset.theme = palette;
  } catch (e) {
    /* 隐私模式/存储关闭：色板已是出厂默认，外观沿用 CSS 默认 */
  }
})();
