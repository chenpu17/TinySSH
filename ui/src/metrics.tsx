// 监控条（命令框退役轮）：命令框腾出的底部常驻条改为 FinalShell 式远端资源
// 采样条——CPU / 内存 / 网络速率 / 运行时长·负载 / 根分区用量。数据源
// read_host_metrics（核心直连 Fresh 通道执行固定 /proc 脚本：不进终端、不进
// 审计、不经审批），3s 周期采样，CPU% 与网速由相邻两次采样的计数器差分得出。
// 解析/差分/格式化全为纯函数（本文件导出，spec 可直接断言）；缺 /proc 的远端
// （BSD/macOS）与连续采样失败都整条隐藏——摆一条永远「—」的死条不如不摆。
import { useEffect, useRef, useState } from "react";
import { invoke } from "./adapter/bridge";
import { t } from "./i18n";
import { IconPause, IconPlay } from "./icons";

// ---- 采样解析（纯函数）----

export interface MetricsRaw {
  cpuTotal: number; cpuIdle: number;
  memTotalKB: number; memAvailKB: number;
  uptimeSec: number; load1: number;
  rxBytes: number; txBytes: number;
  diskPct: number | null;
}

const lineKB = (line: string): number => {
  const n = Number(line.split(":")[1]?.trim().split(/\s+/)[0]);
  return Number.isFinite(n) ? n : 0;
};

/** 解析一次采样输出。规则：缺 cpu 行（非 Linux / 脚本被拒）→ null = 整条隐藏。 */
export function parseMetricsSample(text: string): MetricsRaw | null {
  let cpuTotal = 0, cpuIdle = 0, seenCpu = false;
  let memTotalKB = 0, memAvailKB = 0;
  let uptimeSec = 0, load1 = 0;
  let rxBytes = 0, txBytes = 0;
  let diskPct: number | null = null;
  let inDf = false;
  for (const raw of text.split("\n")) {
    const line = raw.trimEnd();
    if (line.trim() === "==DF==") { inDf = true; continue; }
    if (inDf) {
      // df -kP 尾行：Filesystem blocks used avail %cap mount
      const m = line.match(/^\S+\s+\d+\s+\d+\s+\d+\s+(\d+)%\s+\S+$/);
      if (m) diskPct = Number(m[1]);
      continue;
    }
    if (line.startsWith("cpu ")) {
      // user nice system idle iowait irq softirq steal（首 8 列；idle 含 iowait）
      const v = line.trim().split(/\s+/).slice(1).map(Number).slice(0, 8);
      if (v.length === 8 && v.every(Number.isFinite)) {
        cpuTotal = v.reduce((a, b) => a + b, 0);
        cpuIdle = v[3] + v[4];
        seenCpu = true;
      }
    } else if (line.startsWith("MemTotal:")) memTotalKB = lineKB(line);
    else if (line.startsWith("MemAvailable:")) memAvailKB = lineKB(line);
    else if (/^\d+\.\d+\s+\d+\.\d+$/.test(line.trim())) uptimeSec = Number(line.trim().split(/\s+/)[0]);
    else if (/^[\d.]+\s+[\d.]+\s+[\d.]+\s+\d+\/\d+\s/.test(line.trim())) load1 = Number(line.trim().split(/\s+/)[0]);
    else {
      // /proc/net/dev 数据行（行首有缩进）：「eth0: rx_bytes packets … tx_bytes …」
      // （第 9 个数值起是 tx）。回环 lo 不计；多网卡求和（FinalShell 同口径）。
      const m = line.match(/^\s*(\S+):\s*((?:\d+\s+){8,16})/);
      if (m && m[1] !== "lo") {
        const nums = m[2].trim().split(/\s+/).map(Number);
        if (nums.length >= 9) { rxBytes += nums[0]; txBytes += nums[8]; }
      }
    }
  }
  if (!seenCpu || memTotalKB <= 0) return null;
  return { cpuTotal, cpuIdle, memTotalKB, memAvailKB, uptimeSec, load1, rxBytes, txBytes, diskPct };
}

// ---- 差分与呈现值（纯函数）----

export interface MetricsView {
  cpuPct: number | null;               // null = 首样未定（差分需两个采样）
  memUsedGB: number; memTotalGB: number; memPct: number;
  rxRate: number | null; txRate: number | null;  // bytes/s，null 同上
  uptimeSec: number; load1: number;
  diskPct: number | null;
}

export function diffMetrics(cur: MetricsRaw, prev: MetricsRaw | null, dtSec: number): MetricsView {
  const dTotal = prev ? cur.cpuTotal - prev.cpuTotal : 0;
  const dIdle = prev ? cur.cpuIdle - prev.cpuIdle : 0;
  const cpuPct = prev && dTotal > 0
    ? Math.min(100, Math.max(0, (1 - dIdle / dTotal) * 100))
    : null;
  const dt = prev && dtSec > 0 ? dtSec : 0;
  return {
    cpuPct,
    memUsedGB: (cur.memTotalKB - cur.memAvailKB) / 1048576,
    memTotalGB: cur.memTotalKB / 1048576,
    memPct: Math.min(100, ((cur.memTotalKB - cur.memAvailKB) / cur.memTotalKB) * 100),
    rxRate: dt > 0 ? Math.max(0, (cur.rxBytes - prev!.rxBytes) / dt) : null,
    txRate: dt > 0 ? Math.max(0, (cur.txBytes - prev!.txBytes) / dt) : null,
    uptimeSec: cur.uptimeSec,
    load1: cur.load1,
    diskPct: cur.diskPct,
  };
}

// ---- 格式化（纯函数）----

export function fmtGB(n: number): string {
  return n.toFixed(2);
}

export function fmtRate(bps: number): string {
  if (bps >= 1048576) return `${(bps / 1048576).toFixed(2)} MB/s`;
  if (bps >= 1024) return `${(bps / 1024).toFixed(1)} KB/s`;
  return `${Math.round(bps)} B/s`;
}

export function fmtUptime(sec: number): string {
  if (!Number.isFinite(sec) || sec < 60) return "刚刚";
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (d > 0) return `${d} 天 ${h} 小时`;
  if (h > 0) return `${h} 小时 ${m} 分`;
  return `${m} 分钟`;
}

// ---- 组件 ----

const POLL_MS = 3000;
const MAX_FAILS = 3;

const PctBar = ({ pct }: { pct: number | null }) => (
  <span className={"mbar" + (pct != null && pct >= 85 ? " hot" : "")}>
    <i style={{ width: `${pct == null ? 0 : Math.max(2, Math.min(100, pct))}%` }} />
  </span>
);

export function MetricsBar({ sid, kind, user, hostName }: {
  sid: string;
  kind: string;
  user?: string;
  hostName?: string;
}) {
  const isSsh = kind === "ssh" || kind === "local"; // 本机监控轮：local 走核心原生快照，与远端同权
  const [view, setView] = useState<MetricsView | null>(null);
  const [dead, setDead] = useState(false);          // 不支持/连续失败 → 整条隐藏
  const [paused, setPaused] = useState(() => {
    // localStorage 被禁用/企业策略拦时抛 SecurityError——渲染期抛错=整窗白屏
    try { return localStorage.getItem("tinyssh.metricsPaused") === "1"; } catch { return false; }
  });
  const prevRef = useRef<MetricsRaw | null>(null);  // 差分基线（上次采样）
  const prevAtRef = useRef(0);
  const pausedRef = useRef(paused);
  pausedRef.current = paused;

  useEffect(() => {
    if (!isSsh || dead) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let fails = 0;
    const poll = async () => {
      if (stopped) return;
      if (!pausedRef.current) {
        try {
          const text = await invoke("read_host_metrics", { sid });
          if (stopped) return;
          const cur = parseMetricsSample(text);
          if (!cur) { setDead(true); return; }      // 非 Linux 远端：静默隐藏
          const now = Date.now();
          const prev = prevRef.current;
          setView(diffMetrics(cur, prev, prev ? (now - prevAtRef.current) / 1000 : 0));
          prevRef.current = cur;
          prevAtRef.current = now;
        } catch {
          if (stopped) return;
          prevRef.current = null;                    // 断代：恢复后首样不差分
          fails += 1;
          if (fails >= MAX_FAILS) { setDead(true); return; }
        }
      }
      if (!stopped) timer = setTimeout(poll, POLL_MS);
    };
    void poll();
    return () => { stopped = true; if (timer) clearTimeout(timer); };
  }, [sid, isSsh, dead]);

  if (!isSsh || dead) return null;
  const togglePause = () => {
    setPaused((p) => {
      localStorage.setItem("tinyssh.metricsPaused", p ? "0" : "1");
      return !p;
    });
  };
  const v = view;
  return (
    <div className="metrics-bar" data-testid="metrics-bar" aria-label={t("主机资源监控")}>
      <span className="mhost" title={t("活动会话")}>{[user, hostName].filter(Boolean).join("@")}</span>
      <span className="mseg" title={v?.cpuPct != null ? t("CPU 使用率（负载 {0}）", v.load1.toFixed(2)) : t("CPU 使用率")}>
        <span className="mlabel">CPU</span>
        <PctBar pct={v?.cpuPct ?? null} />
        <span className="mval mnum">{v?.cpuPct != null ? `${Math.round(v.cpuPct)}%` : "—"}</span>
      </span>
      <span className="mseg" title={t("内存用量 / 总量")}>
        <span className="mlabel">{t("内存")}</span>
        <PctBar pct={v ? v.memPct : null} />
        <span className="mval mnum">{v ? `${fmtGB(v.memUsedGB)} / ${fmtGB(v.memTotalGB)} GB` : "—"}</span>
      </span>
      <span className="mseg" title={t("网络收发速率（全部网卡合计）")}>
        <span className="mlabel">{t("网络")}</span>
        <span className="mval mnum down">↓ {v?.rxRate != null ? fmtRate(v.rxRate) : "—"}</span>
        <span className="mval mnum up">↑ {v?.txRate != null ? fmtRate(v.txRate) : "—"}</span>
      </span>
      <span className="mseg" title={t("系统运行时长")}>
        <span className="mlabel">{t("运行")}</span>
        <span className="mval">{v ? fmtUptime(v.uptimeSec) : "—"}</span>
      </span>
      <span className="mseg" title={t("根分区用量")}>
        <span className="mlabel">{t("磁盘")}</span>
        <PctBar pct={v?.diskPct ?? null} />
        <span className="mval mnum">{v?.diskPct != null ? `${v.diskPct}%` : "—"}</span>
      </span>
      <span style={{ flex: 1 }} />
      <button className="mpause" data-testid="metrics-pause" onClick={togglePause}
        aria-pressed={paused}
        title={paused ? t("恢复资源采样（当前已暂停）") : t("暂停资源采样（停止向远端发探测命令）")}>
        {paused ? <IconPlay size={12} /> : <IconPause size={12} />}
      </button>
    </div>
  );
}
