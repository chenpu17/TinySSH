// 桌面壳整页缩放（UX 五轮，参考 tiny-worker zoom.ts）：Ctrl/⌘±/0 键盘走 R13 统一
// keymap（actions.ts），这里只负责档位状态、webview 落地与 Ctrl+滚轮。0.1 步进、
// 0.5–2.0 钳位、0.05 粒度取整（浮点累加 0.1 防漂；设置下拉的 125% 档不被舍走）。
// 前端自管的原因：WebView2 原生键盘缩放加速键实测不触发，mac 官方 polyfill 的内部
// 状态与宿主不同步且做不了持久化——统一走 set_webview_zoom（capability 已开）。
// 持久化刻意用 localStorage 同步记档而非 settings KV：缩放必须在首帧前恢复，
// KV 是异步读取，会闪一帧 100%（App 侧经 useLayoutEffect 注册兑现）；浏览器 demo
// 不注册（浏览器自带缩放，拦截只会破坏原生体验）。
import { invoke } from "@tauri-apps/api/core";

const ZOOM_KEY = "ui.zoom";
export const ZOOM_MIN = 0.5;
export const ZOOM_MAX = 2;
export const ZOOM_STEP = 0.1;
/** 设置下拉的档位（键盘/滚轮步进 0.1，档位值天然对齐 0.05 粒度） */
export const ZOOM_LEVELS = [0.85, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2];

let level = 1;
let tauri = false;
type Notify = (kind: "ok" | "err" | "info", text: string) => void;
let notify: Notify = () => {};
type ZoomListener = (n: number) => void;
const listeners = new Set<ZoomListener>();

/** 当前档位（设置下拉回显用） */
export function currentZoom(): number {
  return level;
}

export function clampZoom(n: number): number {
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(n * 20) / 20));
}

async function apply(next: number, announce: boolean) {
  const prev = level;
  // 同步落内存档位：连续滚轮事件从最新档起算（放 await 之后会让快速连滚吃旧值）
  level = clampZoom(next);
  try {
    if (tauri) await invoke("plugin:webview|set_webview_zoom", { value: level });
    // 持久化尽力而为：隐私模式/配额失败不回滚（webview 已在新档位，回滚才是幻影）
    try { localStorage.setItem(ZOOM_KEY, String(level)); } catch { /* demo 尽力而为 */ }
    for (const l of listeners) l(level);
    if (announce) notify("ok", `缩放 ${Math.round(level * 100)}%`);
  } catch (e) {
    // 回滚内存档位：invoke 失败 webview 根本没动，不回滚下次步进从错值起跳（连跳两档）；
    // 同步弹回订阅方——设置下拉是受控 select，不弹回会停在用户所选档直到下次重渲染
    level = prev;
    for (const l of listeners) l(level);
    notify("err", `缩放失败：${String(e).slice(0, 80)}`);
  }
}

export function zoomIn() { void apply(level + ZOOM_STEP, true); }
export function zoomOut() { void apply(level - ZOOM_STEP, true); }
export function zoomReset() { void apply(1, true); }

/** 直设档位（设置-界面缩放下拉用）：钳位 + 持久化 + 应用 + toast 提示 */
export function setZoomScale(n: number) { void apply(n, true); }

/** 档位变化订阅（设置下拉回显）；返回退订函数 */
export function onZoomChange(cb: ZoomListener): () => void {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}

/** 注册滚轮缩放并恢复上次档位（键盘路径归 R13 keymap，此处不挂 keydown 防双绑定）。
 *  滚轮用捕获阶段：终端视口的 wheel 已被 xterm 消费，冒泡层拦截不及；stopPropagation
 *  让 ctrl+滚轮只归缩放，不滚动回滚历史。
 *  返回注销函数——React StrictMode dev 下 effect mount→cleanup→remount，无清理会
 *  双注册（Ctrl+滚轮一档跳 0.2）。 */
export function registerZoomHotkeys(opts: { isTauri: boolean; notify: Notify }): () => void {
  tauri = opts.isTauri;
  notify = opts.notify;
  if (!tauri) return () => {};
  // 恢复上次缩放：合法且非 100% 才回放；非法值静默忽略；**invoke 成功才落内存档位**——
  // 失败（旧二进制无 capability、webview 初始化期）档位留在 100%，设置绝不显示
  // 到不了的幻影档；localStorage 保留（瞬时失败下次启动重试，成功即静默无感）
  const saved = Number(localStorage.getItem(ZOOM_KEY));
  if (Number.isFinite(saved) && saved > 0 && clampZoom(saved) === saved && saved !== 1) {
    void invoke("plugin:webview|set_webview_zoom", { value: clampZoom(saved) })
      .then(() => {
        level = clampZoom(saved);
        for (const l of listeners) l(level);
      })
      .catch(() => {});
  }
  let wheelRaf = 0;
  let wheelLatest: WheelEvent | null = null;
  const wheel = (e: WheelEvent) => {
    if (!e.ctrlKey) return;
    e.preventDefault();
    e.stopPropagation();
    // 滚轮是连续手势，不打 toast；事件频率可超屏幕刷新率——rAF 合帧每帧至多一档
    //（取手势内最后一个方向），已触边（0.5/2.0）同档早退，不再逐事件发 IPC
    wheelLatest = e;
    if (wheelRaf) return;
    wheelRaf = requestAnimationFrame(() => {
      wheelRaf = 0;
      const ev = wheelLatest;
      wheelLatest = null;
      if (!ev) return;
      const next = clampZoom(level + (ev.deltaY < 0 ? ZOOM_STEP : -ZOOM_STEP));
      if (next === level) return;
      void apply(next, false);
    });
  };
  window.addEventListener("wheel", wheel, { passive: false, capture: true });
  return () => {
    window.removeEventListener("wheel", wheel, { capture: true });
    if (wheelRaf) cancelAnimationFrame(wheelRaf);
    wheelRaf = 0;
    wheelLatest = null;
  };
}
