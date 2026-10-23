// 监控大屏（大屏轮 / 开关轮修订）：多服务器资源监控——每台**服务器**一张卡
// （同机多条连接去重合一，×N 徽标标注连接数），CPU/内存环形仪表 + 网络折线 +
// 磁盘条 + Ascend NPU 每芯片指标，响应式网格铺满主区（绝对定位盖在终端上方，
// 终端不卸载、会话照常收数）。纯呈现组件（出仓约定：只收 props、零语义），
// 采样在 monitor-store 单例（按服务器键去重，开关驱动后台持续采集），开关/
// 互斥/回调留 App。折线/环形是内联 SVG（项目零图表库约定），颜色走主题 token。
// 开关语义：通用/NPU 两路独立 opt-in——都关时大屏是「未开启」空态（采集零
// 开销）；开了就持续采（关大屏不中断），哪路开着就呈现哪路的数据。
import { IconGauge, IconPause, IconPlay, IconX } from "../icons";
import { fmtGB, fmtRate, fmtUptime } from "../metrics";
import { useMonitorSeries, retryMonitor, MON_POLL_SEC, type MonSeries } from "../monitor-store";
import type { NpuChip } from "../npu";

/** 折线时间窗文案：点数 × 采样周期；<2 点还没画得出来，给「积累中」。 */
const fmtSpan = (points: number): string => {
  if (points < 2) return "积累中…";
  const sec = points * MON_POLL_SEC;
  return sec < 60 ? `近 ${sec} 秒` : `近 ${Math.max(1, Math.round(sec / 60))} 分钟`;
};

export interface MonitorCardHost {
  key: string;                   // 服务器键 user@address:port（去重与采样键）
  sid: string;                   // 代言会话（采样通道 + 跳转目标，App 选出）
  hostName: string;
  user?: string;                 // hosts 回查（连接详情快照口径的宽松替代，可缺省）
  state: string;                 // 代言会话状态（Connected/Reconnecting/…）
  active: boolean;               // 本服务器任一会话是当前激活标签
  dup: number;                   // 该服务器在连会话数（>1 显 ×N 徽标）
  tabNames: string[];            // 各连接标签名（×N 徽标 title 提示）
}

// ---- 小部件 ----

const Bar = ({ pct }: { pct: number | null }) => (
  <span className={"mon-bar" + (pct != null && pct >= 85 ? " hot" : "")}>
    <i style={{ width: `${pct == null ? 0 : Math.max(2, Math.min(100, pct))}%` }} />
  </span>
);

// 环形仪表（大屏主视觉）：SVG 圆环 stroke-dasharray 按百分比画弧，中心数字。
// 60 以下主题色、60–85 预警、≥85 危险（与 Bar 的 hot 阈值一致）。
const Ring = ({ pct, lab, sub, testid }: { pct: number | null; lab: string; sub?: string; testid: string }) => {
  const R = 26;
  const C = 2 * Math.PI * R;
  const p = pct == null ? 0 : Math.max(0, Math.min(100, pct));
  return (
    <div className={"mon-ring" + (pct != null && pct >= 85 ? " hot" : pct != null && pct >= 60 ? " warm" : "")}>
      <div className="mon-ring-dial">
        <svg width="64" height="64" viewBox="0 0 64 64" aria-hidden="true">
          <circle className="rbg" cx="32" cy="32" r={R} />
          <circle className="rfg" data-testid={testid}
            cx="32" cy="32" r={R} strokeLinecap="round"
            strokeDasharray={`${((p / 100) * C).toFixed(1)} ${C.toFixed(1)}`}
            transform="rotate(-90 32 32)" />
        </svg>
        <span className="mon-ring-num">{pct == null ? "—" : `${Math.round(pct)}%`}</span>
      </div>
      <span className="mon-ring-lab">{lab}</span>
      {sub != null && <span className="mon-ring-sub" title={sub}>{sub}</span>}
    </div>
  );
};

// 单线折线：空数据（<2 点）画空框，占位不跳动。fluid=横向铺满卡宽
//（viewBox 定形 + non-scaling-stroke 保描边粗细不随拉伸变糊）。
const Spark = ({ data, cls = "", w = 120, h = 24, fluid = false }: { data: number[]; cls?: string; w?: number; h?: number; fluid?: boolean }) => {
  let pts = "";
  if (data.length >= 2) {
    const max = Math.max(...data, 1);
    const min = Math.min(...data, 0);
    const span = max - min || 1;
    pts = data
      .map((v, i) =>
        `${((i / (data.length - 1)) * (w - 2) + 1).toFixed(1)},${(h - 2 - ((v - min) / span) * (h - 4)).toFixed(1)}`)
      .join(" ");
  }
  return (
    <svg className={"mon-spark " + cls} width={fluid ? "100%" : w} height={h}
      viewBox={`0 0 ${w} ${h}`} preserveAspectRatio={fluid ? "none" : undefined} aria-hidden="true">
      <polyline points={pts} fill="none" strokeWidth="1.5" vectorEffect={fluid ? "non-scaling-stroke" : undefined} />
    </svg>
  );
};

// 双线折线（网络 ↓/↑）：两条 polyline 同一 viewBox，颜色由 CSS 类区分。
// fluid=横向铺满（CSS 拉伸 + non-scaling-stroke）。
const Spark2 = ({ a, b, cls = "", w = 120, h = 24, fluid = false }: { a: number[]; b: number[]; cls?: string; w?: number; h?: number; fluid?: boolean }) => {
  const path = (data: number[]): string => {
    if (data.length < 2) return "";
    const max = Math.max(...data, ...a, ...b, 1);
    const min = Math.min(...data, ...a, ...b, 0);
    const span = max - min || 1;
    return data
      .map((v, i) =>
        `${((i / (data.length - 1)) * (w - 2) + 1).toFixed(1)},${(h - 2 - ((v - min) / span) * (h - 4)).toFixed(1)}`)
      .join(" ");
  };
  return (
    <svg className={"mon-spark " + cls} width={fluid ? "100%" : w} height={h}
      viewBox={`0 0 ${w} ${h}`} preserveAspectRatio={fluid ? "none" : undefined} aria-hidden="true">
      <polyline className="p1" points={path(a)} fill="none" strokeWidth="1.5" vectorEffect={fluid ? "non-scaling-stroke" : undefined} />
      <polyline className="p2" points={path(b)} fill="none" strokeWidth="1.5" vectorEffect={fluid ? "non-scaling-stroke" : undefined} />
    </svg>
  );
};

const healthCls = (h: string): string =>
  ["warning", "alarm", "critical"].includes(h.toLowerCase()) ? "bad" : h.toLowerCase() === "ok" ? "ok" : "dim";

const NpuChipRow = ({ chip }: { chip: NpuChip }) => (
  // 两行结构：上行型号/健康/功耗温度，下行 AICore 条 + HBM——窄卡下不挤爆
  <div className="mon-npu-chip" data-testid="mon-npu-chip">
    <div className="mon-npu-top">
      <span className="mon-npu-idx">NPU{chip.index}</span>
      <span className="mon-npu-name">{chip.name}</span>
      <span className={"mon-hbadge " + healthCls(chip.health)}>{chip.health}</span>
      <span className="mon-num" title="功耗 / 温度">{chip.powerW.toFixed(1)}W · {chip.tempC}°C</span>
    </div>
    <div className="mon-npu-usage">
      <span className="mon-lab" title="AICore / NPU 利用率（列名随 CANN 版本：AICore(%) 或 NPU Util(%)）">利用率</span>
      <Bar pct={chip.aicorePct} />
      <span className="mon-num">{chip.aicorePct}%</span>
      {chip.hbmTotalMB != null && chip.hbmTotalMB > 0 && (
        <span className="mon-num dim" title="HBM 显存 已用/总量">
          HBM {chip.hbmUsedMB}/{chip.hbmTotalMB} MB
        </span>
      )}
    </div>
  </div>
);

// ---- 服务器卡 ----

const MonCard = ({ c, swGeneral, swNpu, onOpenSession }: {
  c: MonitorCardHost;
  swGeneral: boolean;
  swNpu: boolean;
  onOpenSession: (sid: string) => void;
}) => {
  const s: MonSeries | null = useMonitorSeries(c.key);
  const v = s?.view ?? null;
  const connected = c.state === "Connected";
  const label = [c.user, c.hostName].filter(Boolean).join("@");
  // CPU 走势时间窗（点数 × 采样周期，<2 点「积累中」）
  const pts = s?.cpuHist.length ?? 0;
  const spanText = fmtSpan(pts);
  // NPU 区（swNpu 开着才有）：ok=芯片列表；no-table=表头未识别提示
  const npuBlk = swNpu && s && (
    <>
      {s.npu.parsed && s.npu.parsed.state === "ok" && (
        <div className="mon-npu" data-testid="mon-npu">
          <div className="mon-npu-head">Ascend NPU × {s.npu.parsed.chips.length}</div>
          {s.npu.parsed.chips.map((chip) => <NpuChipRow key={chip.index} chip={chip} />)}
        </div>
      )}
      {s.npu.parsed?.state === "no-table" && (
        <div className="mon-card-note bad" title={s.npu.parsed.detail}
          data-testid="mon-npu-unknown">检测到 npu-smi，但输出表头未识别（CANN 版本差异）</div>
      )}
    </>
  );
  const body = (() => {
    if (!swGeneral) {
      // 只开 NPU：基础区不采，给一句说明占位（数据语义不含糊）
      return (
        <>
          <div className="mon-card-note">通用监控未开启——CPU/内存/网络/磁盘不采样</div>
          {swNpu && !s?.npu.parsed && <div className="mon-card-note">等待 NPU 首样…</div>}
          {npuBlk}
        </>
      );
    }
    if (s?.unsupported) return <div className="mon-card-note">此主机不支持采样（非 Linux 远端）</div>;
    if (s?.degraded) return (
      <div className="mon-card-note bad">
        采样失败（连续 3 次）
        <button className="mon-retry" data-testid="mon-retry" onClick={() => retryMonitor(c.key)}>重试</button>
      </div>
    );
    if (!v) return <div className="mon-card-note">等待首样…</div>;
    return (
      <>
        <div className="mon-rings">
          <Ring pct={v.cpuPct} lab="CPU" testid="mon-ring-cpu"
            sub={v.load1 != null ? `load ${v.load1.toFixed(2)}` : undefined} />
          <Ring pct={v.memPct} lab="内存" testid="mon-ring-mem"
            sub={`${fmtGB(v.memUsedGB)} / ${fmtGB(v.memTotalGB)} GB`} />
        </div>
        <div className="mon-row" title={`网络收发速率（全部网卡合计；↓ 青 / ↑ 绿），与 CPU 走势同一时间窗（${fmtSpan(s?.cpuHist.length ?? 0)}）`}>
          <span className="mon-lab">网络</span>
          <Spark2 a={s?.rxHist ?? []} b={s?.txHist ?? []} cls="net" fluid w={160} h={22} />
          <span className="mon-num down">↓ {v.rxRate != null ? fmtRate(v.rxRate) : "—"}</span>
          <span className="mon-num up">↑ {v.txRate != null ? fmtRate(v.txRate) : "—"}</span>
        </div>
        <div className="mon-row" title="根分区用量 / 系统运行时长">
          <span className="mon-lab">磁盘</span>
          <Bar pct={v.diskPct} />
          <span className="mon-num">{v.diskPct != null ? `${v.diskPct}%` : "—"}</span>
          <span className="mon-num dim mon-up">运行 {fmtUptime(v.uptimeSec)}</span>
        </div>
        {/* CPU 走势（开关轮补标签+时间轴）：此前光秃一条线没名没轴，用户认不出
            是什么——头部补「CPU 走势」+ 时间窗（右端=现在）；折线随样本数增长，
            窗口文案如实反映已积累的时长而非满窗 30 分钟 */}
        <div className="mon-chart" data-testid="mon-chart-cpu">
          <div className="mon-chart-head">
            <span className="mon-lab" title="CPU 占有率历史">CPU 走势</span>
            <span className="mon-axis" data-testid="mon-axis-cpu"
              title={pts < 2
                ? `每 ${MON_POLL_SEC} 秒采样一拍，攒够 2 点开始画`
                : `折线左端为 ${spanText} 前，右端为刚刚（每 ${MON_POLL_SEC} 秒一拍）`}>
              {spanText === "积累中…" ? spanText : `${spanText} · 现在在最右`}
            </span>
          </div>
          <Spark data={s?.cpuHist ?? []} cls="cpu" fluid w={280} h={30} />
        </div>
        {npuBlk}
      </>
    );
  })();
  return (
    <div className={"mon-card" + (c.active ? " active" : "") + (s?.degraded ? " degraded" : "")}
      data-testid="mon-card" data-mon-key={c.key}>
      <button className="mon-card-head" title={`打开 ${label} 的终端`} onClick={() => onOpenSession(c.sid)}>
        <span className={"mon-dot" + (connected ? "" : " off")} />
        <span className="mon-card-name">{label}</span>
        {c.dup > 1 && (
          <span className="mon-dup" data-testid="mon-dup"
            title={`${c.dup} 条连接：${c.tabNames.join("、")}`}>×{c.dup}</span>
        )}
        {!connected && <span className="mon-state">{c.state === "Reconnecting" ? "重连中…" : c.state}</span>}
      </button>
      <div className="mon-card-body">{body}</div>
    </div>
  );
};

// ---- 大屏 ----

export function MonitorView({ cards, swGeneral, swNpu, paused, onToggleGeneral, onToggleNpu, onTogglePause, onOpenSession, onClose }: {
  cards: MonitorCardHost[];
  swGeneral: boolean;
  swNpu: boolean;
  paused: boolean;
  onToggleGeneral: () => void;
  onToggleNpu: () => void;
  onTogglePause: () => void;
  onOpenSession: (sid: string) => void;
  onClose: () => void;
}) {
  const conns = cards.reduce((n, c) => n + c.dup, 0);
  const collecting = swGeneral || swNpu;
  return (
    <section className="mon-dash" data-testid="monitor-view" role="region" aria-label="资源监控大屏">
      <div className="mon-dash-head">
        <IconGauge size={16} />
        <b>资源监控</b>
        <span className="mon-dash-sub" data-testid="monitor-count" title="已连接的服务器数 / SSH 连接数">
          {cards.length} 台服务器{conns !== cards.length ? ` · ${conns} 条连接` : ""}
        </span>
        {/* 采集开关（开关轮）：opt-in 双路，开了就后台持续采（关大屏不中断），
            全关零开销。扩展位——以后其它采集类功能照此加第四枚 */}
        <button className={"mon-sw" + (swGeneral ? " on" : "")} data-testid="mon-sw-general"
          aria-pressed={swGeneral} onClick={onToggleGeneral}
          title="通用监控：CPU/内存/网络/磁盘。打开后后台持续采样（每 3 秒一拍），关闭大屏不中断">
          <i className="mon-sw-knob" aria-hidden="true" />通用监控
        </button>
        <button className={"mon-sw" + (swNpu ? " on" : "")} data-testid="mon-sw-npu"
          aria-pressed={swNpu} onClick={onToggleNpu}
          title="NPU 监控：Ascend npu-smi 每芯片利用率/HBM/功耗温度。打开后后台持续采样，无 NPU 的机器探测一次后自动停">
          <i className="mon-sw-knob" aria-hidden="true" />NPU 监控
        </button>
        <span style={{ flex: 1 }} />
        <button className="mpause" data-testid="monitor-pause" aria-pressed={paused}
          title={paused ? "恢复采样（当前已暂停）" : "暂停采样（停止向远端发探测命令，已采历史保留）"}
          onClick={onTogglePause}>
          {paused ? <IconPlay size={12} /> : <IconPause size={12} />}
        </button>
        <button className="ghost icon-btn" data-testid="monitor-close" title="关闭监控大屏（回到终端；采集按开关继续）"
          aria-label="关闭监控大屏" onClick={onClose}>
          <IconX size={14} />
        </button>
      </div>
      {!collecting ? (
        // 未开启空态：两张大开关卡（hover 预演打开态）——「统计费性能」的顾虑
        // 在这里给出答案：不开就完全不采
        <div className="mon-offboard" data-testid="mon-empty">
          <div className="mon-off-title">监控未开启</div>
          <div className="mon-off-sub">
            {cards.length > 0
              ? <>已连接 <b>{cards.length}</b> 台服务器。打开下面的采集开关，卡片立即可见；数据在后台持续采集（每 3 秒一拍），<b>关掉大屏也不中断</b>，回来就能看到全程曲线。</>
              : <>这里会显示每台已连接 SSH 服务器的资源卡片（同一台机器的多条连接合并为一张卡）。先连接服务器，再打开采集开关。</>}
          </div>
          <div className="mon-off-sw">
            <button className="mon-swcard" data-testid="mon-sw-general-big" onClick={onToggleGeneral}>
              <span className="mon-swcard-txt">
                <b>通用监控</b>
                <span>CPU / 内存 / 网络 / 磁盘 / 负载，每 3 秒一拍</span>
              </span>
              <i className="mon-sw-visual" aria-hidden="true" />
            </button>
            <button className="mon-swcard" data-testid="mon-sw-npu-big" onClick={onToggleNpu}>
              <span className="mon-swcard-txt">
                <b>NPU 监控</b>
                <span>Ascend npu-smi：每芯片利用率 / HBM / 功耗温度</span>
              </span>
              <i className="mon-sw-visual" aria-hidden="true" />
            </button>
          </div>
          <div className="mon-off-note">采集只在开关打开时进行；随时关掉即停采并清空曲线，不留后台任务。</div>
        </div>
      ) : (
        <div className="mon-grid">
          {cards.length === 0 && (
            <div className="mon-empty">暂无已连接的 SSH 服务器——连接服务器后这里会出现资源卡片；同一台机器的多条连接会合并为一张卡。</div>
          )}
          {cards.map((c) => (
            <MonCard key={c.key} c={c} swGeneral={swGeneral} swNpu={swNpu} onOpenSession={onOpenSession} />
          ))}
        </div>
      )}
    </section>
  );
}
