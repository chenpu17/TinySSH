// 监控大屏采样单例（开关轮重构）：采集生命周期**跟着开关走，不跟面板走**——
// App 把两枚采集开关（通用/NPU，见 setMonEnabled）和在连服务器清单
// （syncMonitorTargets）推进来，store 按服务器键（user@address:port）各维持
// 一条 3s setTimeout 链：大屏关了链条照跑，重开面板历史直接在（HISTORY 600
// ≈ 30 分钟）。开关全关 = 拆光条目，零后台开销——「统计费性能」的用户不打开
// 就完全不采（opt-in）。同一台机器的多条 SSH 连接合一条链只采一份（多条连接
// 对同一台机器轮询 exec 是纯浪费）；代言会话由 App 选出（优先 Connected、
// 再当前激活），会话关闭时换同机其余会话顶上（重绑不重置历史，曲线连续）。
// 基础指标走 read_host_metrics、复用 metrics.tsx 的解析/差分纯函数；NPU 走
// read_npu_metrics 同节奏，解析出 no-tool 即永久停 NPU 探测（该机无 npu-smi）。
// 语义与监控条对齐：失败断代（恢复后首样不差分）、连续 MAX_FAILS 次降级——
// 但**不消失**（监控条是整条隐藏，大屏要保留服务器存在感，卡片置灰可点「重试」）。
import { useCallback, useSyncExternalStore } from "react";
import { diffMetrics, parseMetricsSample, type MetricsRaw, type MetricsView } from "./metrics";
import { parseNpuInfo, type NpuParsed } from "./npu";
import { invoke } from "./adapter/bridge";

/** 采样周期（秒）：呈现层算时间轴用（折线窗口 ≈ 点数 × MON_POLL_SEC）。 */
export const MON_POLL_SEC = 3;
const POLL_MS = MON_POLL_SEC * 1000;
const MAX_FAILS = 3;
const NPU_MAX_FAILS = 3;
const HISTORY = 600; // 600 样本 ≈ 30 分钟折线（后台持续采集，深一点才看得出趋势）

export interface NpuProbeState {
  parsed: NpuParsed | null;                       // 最近一次成功解析（no-table 也算成功解析）
  tool: "unknown" | "present" | "absent";
  fails: number;
}

export interface MonSeries {
  key: string;                                    // 服务器键（user@address:port）
  sid: string;                                    // 当前代言会话（重绑随 App 选代表而变）
  view: MetricsView | null;                       // 最新呈现值（首样前 null）
  cpuHist: number[];                              // 折线历史（新样本尾插，定长裁剪）
  memHist: number[];
  rxHist: number[];
  txHist: number[];
  fails: number;                                  // 基础指标连续失败数
  degraded: boolean;                              // fails ≥ MAX_FAILS（卡片置灰可重试）
  unsupported: boolean;                           // 非 Linux 远端（解析缺 cpu 行）
  npu: NpuProbeState;
}

export interface MonEnabled {
  general: boolean;                               // 通用监控（CPU/内存/网络/磁盘）
  npu: boolean;                                   // NPU 监控（npu-smi）
}

interface Entry {
  key: string;
  sid: string;
  snap: MonSeries;                                // 不可变快照（useSyncExternalStore 契约）
  subs: Set<() => void>;
  timer?: ReturnType<typeof setTimeout>;
  inFlight: boolean;                              // 本拍探测在途（retry 重启链条的防双链闸）
  stopped: boolean;
  prevRaw: MetricsRaw | null;
  prevAt: number;
}

const entries = new Map<string, Entry>();

const lsBool = (k: string): boolean => {
  try { return localStorage.getItem(k) === "1"; } catch { return false; }
};
// 开关初值与 monitorPaused 同款：localStorage 恢复（重启后开关还在，采集随
// 会话建立自动续上）；App 的 React 态同源同读，双份一致。
let enabled: MonEnabled = { general: lsBool("tinyssh.monGeneral"), npu: lsBool("tinyssh.monNpu") };
let paused = lsBool("tinyssh.monitorPaused");

export function isMonitorPaused(): boolean {
  return paused;
}

export function setMonitorPaused(p: boolean): void {
  paused = p;
}

export function getMonEnabled(): MonEnabled {
  return { ...enabled };
}

/** 开关推进（App 的 toggle effect 调）：落盘 + 对在存条目做差量收拾——
 *  关基础清基础历史（陈旧值不冒充实时）、关 NPU 清 NPU 态、全关拆光条目。
 *  开某一路不需要动作：在跑的链下一拍自会按新旗标采；缺条目由 sync 补。 */
export function setMonEnabled(part: Partial<MonEnabled>): void {
  const next = { ...enabled, ...part };
  if (next.general === enabled.general && next.npu === enabled.npu) return;
  const was = enabled;
  enabled = next;
  try {
    localStorage.setItem("tinyssh.monGeneral", next.general ? "1" : "0");
    localStorage.setItem("tinyssh.monNpu", next.npu ? "1" : "0");
  } catch { /* 隐私模式忽略 */ }
  if (!next.general && !next.npu) {
    for (const e of [...entries.values()]) teardown(e);
    return;
  }
  for (const e of [...entries.values()]) {
    const patch: Partial<MonSeries> = {};
    if (was.general && !next.general) {
      e.prevRaw = null;
      patch.view = null;
      patch.cpuHist = []; patch.memHist = []; patch.rxHist = []; patch.txHist = [];
      patch.fails = 0; patch.degraded = false;
    }
    if (was.npu && !next.npu) patch.npu = freshNpu();
    if (Object.keys(patch).length) rebuild(e, patch);
  }
}

/** 在连服务器清单同步（App 在 monitorCards/开关变化时调）：开关开着时逐键确保
 *  条目在采、会话关掉的键拆条目（停链）。**条目生命周期的唯一入口**——不再
 *  跟着订阅者增减（旧版末个订阅者退场即拆链，大屏一关历史就没了）。 */
export function syncMonitorTargets(targets: { key: string; sid: string }[]): void {
  const want = new Set(targets.map((t) => t.key));
  for (const e of [...entries.values()]) {
    if (!want.has(e.key)) teardown(e);
  }
  if (!enabled.general && !enabled.npu) return;
  for (const t of targets) {
    const e = entries.get(t.key);
    if (!e) {
      const ne: Entry = {
        key: t.key, sid: t.sid, snap: freshSnap(t.key, t.sid),
        subs: new Set(), stopped: false, inFlight: false, prevRaw: null, prevAt: 0,
      };
      entries.set(t.key, ne);
      void poll(ne);
    } else {
      rebind(e, t.sid);
    }
  }
}

const freshNpu = (): NpuProbeState => ({ parsed: null, tool: "unknown", fails: 0 });

const freshSnap = (key: string, sid: string): MonSeries => ({
  key, sid, view: null, cpuHist: [], memHist: [], rxHist: [], txHist: [],
  fails: 0, degraded: false, unsupported: false, npu: freshNpu(),
});

const cap = (arr: number[]): number[] => (arr.length > HISTORY ? arr.slice(arr.length - HISTORY) : arr);

function rebuild(e: Entry, patch: Partial<MonSeries>): void {
  e.snap = { ...e.snap, ...patch };
  for (const cb of e.subs) cb();
}

/** 一拍探测（fetch+parse+rebuild）。unsupported 提前返回=确定性不可采，本拍
 *  到此为止（链条的调度在 poll 尾部，不受影响）。 */
async function tick(e: Entry): Promise<void> {
  if (!paused) {
    // ---- 基础指标（read_host_metrics，/proc 差分）----
    if (enabled.general) {
      try {
        const text = await invoke("read_host_metrics", { sid: e.sid });
        if (e.stopped) return;
        const cur = parseMetricsSample(text);
        if (!cur) {
          rebuild(e, { unsupported: true });
          return; // 非 Linux 远端：确定性不可采样，停轮（卡片保留「不支持」态）
        }
        const now = Date.now();
        const view = diffMetrics(cur, e.prevRaw, e.prevRaw ? (now - e.prevAt) / 1000 : 0);
        e.prevRaw = cur;
        e.prevAt = now;
        const cpuHist = view.cpuPct != null ? cap([...e.snap.cpuHist, view.cpuPct]) : e.snap.cpuHist;
        const memHist = cap([...e.snap.memHist, view.memPct]);
        const rxHist = view.rxRate != null ? cap([...e.snap.rxHist, view.rxRate]) : e.snap.rxHist;
        const txHist = view.txRate != null ? cap([...e.snap.txHist, view.txRate]) : e.snap.txHist;
        rebuild(e, { view, cpuHist, memHist, rxHist, txHist, fails: 0, degraded: false, unsupported: false });
      } catch {
        if (e.stopped) return;
        e.prevRaw = null; // 断代：恢复后首样不差分
        const fails = e.snap.fails + 1;
        rebuild(e, { fails, degraded: fails >= MAX_FAILS });
      }
    }
    // ---- NPU（read_npu_metrics，同节奏；absent 后不再打扰远端）----
    if (enabled.npu && e.snap.npu.tool !== "absent") {
      try {
        const ntext = await invoke("read_npu_metrics", { sid: e.sid });
        if (e.stopped) return;
        const parsed = parseNpuInfo(ntext);
        if (parsed.state === "no-tool") {
          rebuild(e, { npu: { parsed: null, tool: "absent", fails: 0 } });
        } else {
          rebuild(e, { npu: { parsed, tool: "present", fails: 0 } });
        }
      } catch {
        if (e.stopped) return;
        const fails = e.snap.npu.fails + 1;
        rebuild(e, {
          npu: fails >= NPU_MAX_FAILS ? { parsed: null, tool: "absent", fails: 0 } : { ...e.snap.npu, fails },
        });
      }
    }
  }
}

/** 采样链的一环：一拍探测 + 尾部自续。链条唯一性由 timer/inFlight 双闸保证
 *  （retryMonitor 只在两者皆空时重启，不会拍出双链）。 */
async function poll(e: Entry): Promise<void> {
  if (e.stopped || e.inFlight) return;
  e.inFlight = true;
  await tick(e);
  e.inFlight = false;
  if (!e.stopped) e.timer = setTimeout(() => void poll(e), POLL_MS);
}

/** 已有条目换代言会话：只换探测通道，历史/失败计数/停轮态全部保留。 */
function rebind(e: Entry, sid: string): void {
  if (e.sid === sid) return;
  e.sid = sid;
  rebuild(e, { sid });
}

function teardown(e: Entry): void {
  e.stopped = true;
  if (e.timer) clearTimeout(e.timer);
  entries.delete(e.key);
}

/** 大屏卡片「重试」：清失败计数与断代基线，下一拍立即恢复采样。unsupported
 *  拍会停在 tick 内（无后续），这里负责把链条重新起步（inFlight/timer 双闸
 *  防双链——探测在途时点了重试也只会清状态，链由本拍尾部自续）。 */
export function retryMonitor(key: string): void {
  const e = entries.get(key);
  if (!e) return;
  e.prevRaw = null;
  rebuild(e, { fails: 0, unsupported: false, npu: freshNpu() });
  if (!e.timer && !e.inFlight) void poll(e);
}

export function useMonitorSeries(key: string): MonSeries | null {
  // 订阅只挂回调不建条目（条目生命周期归 syncMonitorTargets/开关）：面板关闭
  // 时无人订阅、链条照样跑，重开面板快照已在。subscribe/snapshot 按 key memo
  // 化：内联闭包每次渲染换身份会让 uSES 每次提交重订阅 → 再触发渲染 = 无限
  // 循环炸整树（首跑 spec 55 实测过的坑）。
  const subscribe = useCallback((cb: () => void) => {
    const e = key ? entries.get(key) : undefined;
    if (!e) return () => {};
    e.subs.add(cb);
    return () => { e.subs.delete(cb); };
  }, [key]);
  const getSnapshot = useCallback(() => (key ? entries.get(key)?.snap ?? null : null), [key]);
  return useSyncExternalStore(subscribe, getSnapshot, () => null);
}
