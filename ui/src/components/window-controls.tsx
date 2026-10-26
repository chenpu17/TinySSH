// Windows 自绘窗口控件（双标题栏重设计）：tauri.windows.conf.json decorations:false 后，
// 44px 应用标题行即唯一标题栏，右端 ─ □ ✕；最大化态经 onResized 跟踪（□/❐ 切换）。
// demo/浏览器不渲染（无原生窗口，调用只会静默失败）。
import { useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { t } from "../i18n";

// Windows 自绘窗口控件（双标题栏重设计）：tauri.windows.conf.json decorations:false 后，
// 44px 应用标题行即唯一标题栏，右端 ─ □ ✕；最大化态经 onResized 跟踪（□/❐ 切换）。
// demo/浏览器不渲染（无原生窗口，调用只会静默失败）。
export function WinControls() {
  const [maxed, setMaxed] = useState(false);
  useEffect(() => {
    const win = getCurrentWindow();
    let un: (() => void) | undefined;
    let alive = true;
    const probe = () => { win.isMaximized().then((v) => { if (alive) setMaxed(v); }).catch(() => {}); };
    // 拖拽窗口期间 onResized 逐 tick 触发 isMaximized IPC——200ms 防抖；挂载时仍立即探测
    let t: ReturnType<typeof setTimeout> | undefined;
    const probeSoon = () => { if (t) clearTimeout(t); t = setTimeout(probe, 200); };
    probe();
    win.onResized(() => probeSoon())
      .then((f) => { un = () => { try { void f(); } catch { /* 已卸载 */ } }; })
      .catch(() => {});
    return () => { alive = false; un?.(); if (t) clearTimeout(t); };
  }, []);
  return (
    <div className="win-controls" role="group" aria-label={t("窗口控制")} data-testid="win-controls">
      <button className="wc-btn" title={t("最小化")} aria-label={t("最小化窗口")}
        onClick={() => void getCurrentWindow().minimize()}>
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M0 5h10" stroke="currentColor" strokeWidth="1" /></svg>
      </button>
      <button className="wc-btn" title={maxed ? t("还原") : t("最大化")} aria-label={maxed ? t("还原窗口") : t("最大化窗口")}
        onClick={() => void getCurrentWindow().toggleMaximize()}>
        {maxed ? (
          <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
            <path d="M3 0.5h6.5V7" fill="none" stroke="currentColor" strokeWidth="1" />
            <rect x="0.5" y="3" width="6.5" height="6.5" fill="none" stroke="currentColor" strokeWidth="1" />
          </svg>
        ) : (
          <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
            <rect x="0.5" y="0.5" width="9" height="9" fill="none" stroke="currentColor" strokeWidth="1" />
          </svg>
        )}
      </button>
      <button className="wc-btn wc-close" title={t("关闭")} aria-label={t("关闭窗口")}
        onClick={() => void getCurrentWindow().close()}>
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M0 0l10 10M10 0L0 10" stroke="currentColor" strokeWidth="1" /></svg>
      </button>
    </div>
  );
}
