// 首帧主题引导：index.html 在 CSS 前同步加载。外观/色板是 localStorage 镜像
// （App.tsx applyChrome/applyPalette 随每次变更写入），这里先挂 dataset，
// 避免浅色用户在设置异步读回前先看到一屏深色。CSP 禁内联脚本，故独立文件。
(function () {
  try {
    var chrome = localStorage.getItem("ui.chrome");
    if (chrome !== "light" && chrome !== "dark") {
      chrome = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
    }
    document.documentElement.dataset.chrome = chrome;
    var palette = localStorage.getItem("ui.palette");
    if (palette) document.documentElement.dataset.theme = palette;
  } catch (e) {
    /* 隐私模式/存储关闭：沿用 CSS 默认 */
  }
})();
