// 自身开销监控（本轮）：tinyssh-app 进程级 CPU/内存上屏。数据源
// read_self_metrics（kernel32 GetProcessTimes/K32GetProcessMemoryInfo 直读，
// 不经审批/审计），CPU% 由相邻两次采样的进程时间差分得出（任务管理器
// 「进程 CPU」同口径：占全部逻辑核），首样无基线显示「—」。
// 展示位两处：设置→关于（常驻可达，详版）与标题栏左区（常显不依赖会话在场，
// 缩略版——原监控条「本机」段迁此，标题栏曝光比会话条件下的监控条更稳定）。
// 核心不可达/非 Windows（恒 null+0）→ 两个组件都整块隐藏
// ——摆一块永远「不可用」的牌子不如不摆。
import { useEffect, useState } from "react";
import { invoke } from "./adapter/bridge";

export interface SelfView {
  cpuPct: number | null;
  wsMb: number;
  commitMb: number;
  at: number; // 本次采样墙钟（毫秒），供「采样于」活性展示
}

/** 轮询钩子：核心不可达（demo 老桥/异常）保持 null = 调用方隐藏 */
export function useSelfMetrics(pollMs: number): SelfView | null {
  const [view, setView] = useState<SelfView | null>(null);
  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      try {
        const m = await invoke("read_self_metrics");
        if (stopped) return;
        if (m) setView({ cpuPct: m.cpu_pct, wsMb: m.ws_mb, commitMb: m.commit_mb, at: Date.now() });
      } catch { /* 桥不可用：静默保持空 */ }
      if (!stopped) timer = setTimeout(poll, pollMs);
    };
    void poll();
    return () => { stopped = true; if (timer) clearTimeout(timer); };
  }, [pollMs]);
  return view;
}

export const fmtCpuPct = (p: number | null): string =>
  p == null ? "—" : `${p >= 10 ? Math.round(p) : p.toFixed(1)}%`;

/** 关于卡片详版：CPU% + 工作集 + 提交 + 采样时刻（2s 周期） */
export function SelfMeterDetail() {
  const v = useSelfMetrics(2000);
  if (!v || (v.cpuPct == null && v.wsMb === 0)) return null;
  return (
    <div className="self-meter" data-testid="self-meter"
      style={{ marginTop: 10, paddingTop: 8, borderTop: "1px solid var(--border)" }}>
      <div style={{ display: "flex", gap: 14, alignItems: "baseline", flexWrap: "wrap" }}>
        <span style={{ color: "var(--dim)", fontSize: 12 }}>程序自身</span>
        <span style={{ fontVariantNumeric: "tabular-nums", fontSize: 12 }}
          title="本进程 CPU 占全部逻辑核的百分比（任务管理器同口径）">CPU {fmtCpuPct(v.cpuPct)}</span>
        <span style={{ fontVariantNumeric: "tabular-nums", fontSize: 12 }}
          title="工作集内存">内存 {v.wsMb} MB</span>
        <span className="dim" style={{ fontVariantNumeric: "tabular-nums", fontSize: 12 }}
          title="提交内存（独占提交字节）">提交 {v.commitMb} MB</span>
      </div>
      <div className="dim" style={{ fontSize: 11, marginTop: 2 }} data-testid="self-meter-at">
        采样于 {new Date(v.at).toTimeString().slice(0, 8)}
      </div>
    </div>
  );
}

/** 标题栏缩略版：本机进程 CPU% + 工作集（3s 周期）。挂在标题栏左区 app-title
 *  之后——常显、位置恒定（不随主机栏/协作徽章出现而移动）；纯读数，挂
 *  data-tauri-drag-region 保持整行可拖拽。核心不可达整块自隐藏。 */
export function SelfMeterTitlebar() {
  const v = useSelfMetrics(3000);
  if (!v || (v.cpuPct == null && v.wsMb === 0)) return null;
  return (
    <span className="tb-self" data-testid="self-chip" data-tauri-drag-region
      title="本程序（tinyssh-app）进程自身开销：CPU 占全部逻辑核百分比 · 工作集内存">
      <span>本机</span>
      <span className="tb-self-val">CPU {fmtCpuPct(v.cpuPct)}</span>
      <span className="tb-self-val">{v.wsMb} MB</span>
    </span>
  );
}
