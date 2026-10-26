// 记录审计时间线（④ 记录与审计的 GUI 消费面）：设置面板「记录审计」分区。
// 纯呈现组件——数据在宿主 App 拉取（打开分区/筛选变化/手动刷新），本组件只渲染。
// 记录本体在核心侧按天加密落盘、写入时已脱敏；这里的「导出」是唯一明文出口，
// 落点固定在核心 records-export/（不开放任意路径），导出动作留审计。

import { useEffect, useMemo, useState } from "react";
import type { ActionRecord, ActionRecordKind, RecordsQuery, RecordsRange } from "../adapter/wire";
import { t } from "../i18n";

/** ⑨ 时间范围档位 → since ISO（「今天」按本机零点；all=null 不过滤）。
 * 在拉取时刻换算，筛选态里只存档位，避免久置页面的边界漂移。 */
export function recordsRangeSince(range: RecordsRange): string | null {
  if (range === "all") return null;
  if (range === "today") {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d.toISOString();
  }
  const hours = range === "24h" ? 24 : range === "7d" ? 24 * 7 : 24 * 30;
  return new Date(Date.now() - hours * 3600e3).toISOString();
}

// KIND_LABEL/STATUS_LABEL 存中文原文（模块导入期禁 t()），消费点包裹翻译
const KIND_LABEL: Record<ActionRecordKind, string> = {
  exec: "命令",
  transfer: "传输",
  forward: "转发",
};

const STATUS_LABEL: Record<string, string> = {
  ok: "✓ 完成",
  error: "✕ 出错",
  denied: "⊘ 已拒绝",
  timeout: "⏱ 超时",
  cancelled: "⊘ 已取消",
  dangerous: "⚠ 危险拦截",
};

function statusCls(s: string): string {
  if (s === "ok") return "ok";
  if (s === "error" || s === "denied" || s === "dangerous") return "err";
  return "dim";
}

function fmtDur(ms: number | null): string {
  if (ms == null) return "";
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(ms < 10000 ? 1 : 0)}s`;
}

// ── 时间线可视化（任务时间线轮）：会话泳道 SVG——x=时间、颜色=状态、
// 实心=Agent/空心=人类、半径=耗时（对数）。纯呈现：直接吃当前筛选的 rows，
// 点击刻度滚动定位到明细行并闪烁。数据模型无任务 id，「任务视角」由
// 时间邻近 + 会话泳道承担，不造假分组。 ──

const STATUS_COLOR: Record<string, string> = {
  ok: "#3a9e5f",
  error: "#d64545",
  denied: "#e08a2e",
  timeout: "#c9a227",
  cancelled: "#8a8f98",
  dangerous: "#a01f1f",
};

const CHART_W = 640;
const LANE_H = 24;
const CHART_TOP = 10;
const CHART_PAD_X = 54;

function RecordsChart({ rows, sessionNames, onPick, flashSeq }: {
  rows: ActionRecord[];
  sessionNames: Map<string, string>;
  onPick: (seq: number) => void;
  flashSeq: number | null;
}) {
  const lanes = useMemo(
    () => [...new Set(rows.map((r) => r.session_id ?? "unknown"))],
    [rows],
  );
  const domain = useMemo(() => {
    const ts = rows.map((r) => +new Date(r.ts));
    const t0 = Math.min(...ts);
    const t1 = Math.max(...ts);
    // 窗口至少 1 分钟：单条/同刻记录不至于挤成一个点，单点落窗中央
    const span = Math.max(t1 - t0, 60e3);
    const lead = (span - (t1 - t0)) / 2;
    return { t0: t0 - lead, span };
  }, [rows]);
  const x = (t: string) =>
    CHART_PAD_X + ((+new Date(t) - domain.t0) / domain.span) * (CHART_W - CHART_PAD_X * 2);
  const rOf = (ms: number | null) =>
    ms == null ? 3.5 : 3.5 + 5.5 * Math.min(1, Math.log10(Math.max(ms, 10)) / 6);
  const H = CHART_TOP + lanes.length * LANE_H + 8;
  const laneLabel = (sid: string) =>
    sid === "unknown" ? t("未知会话") : sessionNames.get(sid) ?? sid.slice(0, 8);

  const stats = useMemo(() => {
    const c: Record<string, number> = {};
    for (const r of rows) c[r.status] = (c[r.status] ?? 0) + 1;
    return c;
  }, [rows]);
  const statsText = t("{0} 条 · ", rows.length) + Object.entries(stats)
    .map(([s, n]) => `${n} ${STATUS_LABEL[s] ? t(STATUS_LABEL[s]).replace(/^[^ ]+ /, "") : s}`)
    .join(" · ");

  return (
    <div style={{ marginTop: 10 }} data-testid="records-chart-wrap">
      <div className="dim" style={{ fontSize: 11, marginBottom: 4 }} data-testid="records-chart-caption">
        {statsText}
      </div>
      <svg className="rec-chart" data-testid="records-chart" viewBox={`0 0 ${CHART_W} ${H}`}
        width="100%" height={H} role="img" aria-label={t("动作时间线泳道图")}>
        {lanes.map((sid, i) => (
          <g key={sid}>
            {i > 0 && (
              <line className="rec-lane-sep" x1={0} x2={CHART_W}
                y1={CHART_TOP + i * LANE_H} y2={CHART_TOP + i * LANE_H} />
            )}
            <text className="rec-lane-label" x={6} y={CHART_TOP + i * LANE_H + LANE_H / 2 + 3.5}
              data-testid="records-lane">{laneLabel(sid)}</text>
          </g>
        ))}
        {rows.map((r) => {
          const cy = CHART_TOP + lanes.indexOf(r.session_id ?? "unknown") * LANE_H + LANE_H / 2;
          const agent = r.agent_id != null;
          const color = STATUS_COLOR[r.status] ?? "#8a8f98";
          return (
            <circle key={r.seq} data-testid={`records-dot-${r.seq}`} data-seq={r.seq}
              data-status={r.status} data-agent={agent ? "1" : "0"}
              cx={x(r.ts)} cy={cy} r={rOf(r.duration_ms)}
              fill={agent ? color : "none"} stroke={color} strokeWidth={1.6}
              className={flashSeq === r.seq ? "rec-dot-flash" : undefined}
              onClick={() => onPick(r.seq)}>
              <title>
                {`${new Date(r.ts).toLocaleString()}\n${t(KIND_LABEL[r.kind] ?? r.kind)} · ${agent ? t("Agent {0}", r.agent_id ?? "") : t("人类")}\n${r.summary}\n${STATUS_LABEL[r.status] ? t(STATUS_LABEL[r.status]) : r.status}${r.duration_ms != null ? ` · ${fmtDur(r.duration_ms)}` : ""}`}
              </title>
            </circle>
          );
        })}
        <text className="rec-axis-label" x={CHART_PAD_X} y={H - 1} textAnchor="start">
          {new Date(domain.t0).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}
        </text>
        <text className="rec-axis-label" x={CHART_W - CHART_PAD_X} y={H - 1} textAnchor="end">
          {new Date(domain.t0 + domain.span).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}
        </text>
      </svg>
      <div className="dim" style={{ fontSize: 10, marginTop: 3 }} data-testid="records-chart-legend">
        {[...new Set(rows.map((r) => r.status))].map((s) => (
          <span key={s} style={{ marginRight: 10 }}>
            <span style={{ color: STATUS_COLOR[s] ?? "#8a8f98" }}>●</span> {STATUS_LABEL[s] ?? s}
          </span>
        ))}
        <span> {t("实心 = Agent · 空心 = 人类 · 点大小 = 耗时 · 点击刻度定位明细")}</span>
      </div>
    </div>
  );
}

interface RecordsPaneProps {
  /** null = 首拉中；[] = 查询无结果 */
  rows: ActionRecord[] | null;
  busy: boolean;
  exportBusy: boolean;
  filter: RecordsQuery;
  /** 筛选下拉的 Agent 选项（来自 MCP 登记面） */
  agents: { id: string; label: string }[];
  /** ⑨ 会话 id → 主机名（R41 累积面，含已关会话）：会话筛选选项 + 行内主机标注 */
  sessionNames: Map<string, string>;
  onFilter: (next: RecordsQuery) => void;
  onRefresh: () => void;
  onExport: () => void;
  /** true = 最近一次拉取恰好满页（可能还有更早的），显示「加载更早」 */
  hasMore: boolean;
  moreBusy: boolean;
  onLoadMore: () => void;
  /** 记录保留天数（0=永久；启动时从 vault 读，改动重启后生效） */
  retention: number;
  onChangeRetention: (days: number) => void;
}

export function RecordsPane(props: RecordsPaneProps) {
  const { rows, busy, exportBusy, filter, agents, sessionNames, onFilter, onRefresh, onExport,
    hasMore, moreBusy, onLoadMore, retention, onChangeRetention } = props;
  // 摘录展开态（面板本地；按 seq 记，翻筛后自然失效无害）
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  // 时间线点击 → 定位明细行（闪烁约 1.6s 自动退场）
  const [flashSeq, setFlashSeq] = useState<number | null>(null);
  useEffect(() => {
    if (flashSeq == null) return;
    const t = setTimeout(() => setFlashSeq(null), 1700);
    return () => clearTimeout(t);
  }, [flashSeq]);
  const pickFromChart = (seq: number) => {
    setFlashSeq(seq);
    document.getElementById(`records-row-${seq}`)?.scrollIntoView({ block: "center", behavior: "smooth" });
  };
  const toggle = (seq: number) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(seq)) next.delete(seq);
      else next.add(seq);
      return next;
    });
  };

  return (
    <>
      <div className="set-card">
        <h4>{t("动作时间线")}</h4>
        <div className="set-desc">
          {t("Agent 与人类的命令 / 传输 / 转发动作都会记录在案（落盘即密文，输出摘录写入时已启发式擦除密钥）；Agent 只能经 MCP 查自己的记录，这里是人类的全量视角。与「协作面板 → 活动记录」的哈希链审计互补：审计面向追责，时间线面向回看。")}
        </div>
        <div className="row" style={{ gap: 6, marginTop: 8, flexWrap: "wrap", alignItems: "center" }}>
          <select
            style={{ fontSize: 11 }} aria-label={t("按种类筛选")} data-testid="records-kind-filter"
            value={filter.kind ?? ""}
            onChange={(e) => onFilter({ ...filter, kind: (e.target.value || null) as RecordsQuery["kind"] })}
          >
            <option value="">{t("全部种类")}</option>
            <option value="exec">{t("命令")}</option>
            <option value="transfer">{t("传输")}</option>
            <option value="forward">{t("转发")}</option>
          </select>
          <select
            style={{ fontSize: 11 }} aria-label={t("按来源筛选")} data-testid="records-agent-filter"
            value={filter.agentId ?? ""}
            onChange={(e) => onFilter({ ...filter, agentId: e.target.value || null })}
          >
            <option value="">{t("全部来源")}</option>
            {agents.map((a) => (
              <option key={a.id} value={a.id}>{a.label}</option>
            ))}
          </select>
          <select
            style={{ fontSize: 11 }} aria-label={t("按时间筛选")} data-testid="records-range-filter"
            value={filter.range}
            onChange={(e) => onFilter({ ...filter, range: e.target.value as RecordsQuery["range"] })}
          >
            <option value="all">{t("全部时间")}</option>
            <option value="today">{t("今天")}</option>
            <option value="24h">{t("近 24 小时")}</option>
            <option value="7d">{t("近 7 天")}</option>
            <option value="30d">{t("近 30 天")}</option>
          </select>
          <select
            style={{ fontSize: 11 }} aria-label={t("按会话筛选")} data-testid="records-session-filter"
            value={filter.sessionId ?? ""}
            onChange={(e) => onFilter({ ...filter, sessionId: e.target.value || null })}
          >
            <option value="">{t("全部会话")}</option>
            {[...sessionNames.entries()].map(([sid, label]) => (
              <option key={sid} value={sid}>{label}</option>
            ))}
          </select>
          <select
            style={{ fontSize: 11 }} aria-label={t("条数上限")} data-testid="records-limit-filter"
            value={String(filter.limit)}
            onChange={(e) => onFilter({ ...filter, limit: Number(e.target.value) || 200 })}
          >
            <option value="200">{t("最近 200 条")}</option>
            <option value="500">{t("最近 500 条")}</option>
            <option value="1000">{t("最近 1000 条")}</option>
          </select>
          <button className="ghost" style={{ fontSize: 11 }} disabled={busy} data-testid="records-refresh" onClick={onRefresh}>
            {t("刷新")}
          </button>
        </div>
        <div style={{ marginTop: 8 }} data-testid="records-timeline">
          {rows === null ? (
            <div className="dim" style={{ fontSize: 12, padding: "10px 0" }}>
              {busy ? t("加载中…") : t("打开本分区加载记录")}
            </div>
          ) : rows.length === 0 ? (
            <div className="dim" style={{ fontSize: 12, padding: "10px 0" }} data-testid="records-empty">
              {t("当前筛选下暂无记录——Agent 执行命令 / 传输文件后会出现在这里。")}
            </div>
          ) : (
            <>
              <RecordsChart rows={rows} sessionNames={sessionNames} onPick={pickFromChart} flashSeq={flashSeq} />
              {rows.map((r) => (
                <div key={r.seq} id={`records-row-${r.seq}`}
                  className={flashSeq === r.seq ? "rec-row-flash" : undefined}
                  data-testid="records-row" style={{ padding: "6px 0", borderBottom: "1px dashed var(--border)" }}>
                <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap", fontSize: 12 }}>
                  <span className="dim mono" style={{ fontSize: 11 }}>
                    {new Date(r.ts).toLocaleString(undefined, { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" })}
                  </span>
                  <span className="badge" style={{ fontSize: 10 }}>{t(KIND_LABEL[r.kind] ?? r.kind)}</span>
                  <span className="dim" style={{ fontSize: 11 }}>
                    {r.agent_id ? t("Agent {0}", r.agent_id) : t("人类")}
                  </span>
                  {/* ⑨ 主机标注（R41 累积面）：会话已关也能标出「当时在哪台主机」；
                      查不到如实显示短 id */}
                  {r.session_id && (
                    <span className="dim" style={{ fontSize: 11 }}>
                      · {sessionNames.get(r.session_id) ?? r.session_id.slice(0, 8)}
                    </span>
                  )}
                  <span className={"mono" /* 摘要可选中复制，命令/路径常被回看 */} style={{ fontSize: 11, userSelect: "text", wordBreak: "break-all", flex: "1 1 auto" }}>
                    {r.summary}
                  </span>
                  <span className={statusCls(r.status)} style={{ fontSize: 11 }}>{STATUS_LABEL[r.status] ?? r.status}</span>
                  {r.duration_ms != null && <span className="dim" style={{ fontSize: 10 }}>{fmtDur(r.duration_ms)}</span>}
                  {r.exit_code != null && r.exit_code !== 0 && <span className="err" style={{ fontSize: 10 }}>exit {r.exit_code}</span>}
                  {r.output_excerpt && (
                    <button className="ghost" style={{ fontSize: 10 }}
                      data-testid={`records-expand-${r.seq}`}
                      onClick={() => toggle(r.seq)}>
                      {expanded.has(r.seq) ? t("收起输出") : t("看输出")}
                    </button>
                  )}
                </div>
                {r.output_excerpt && expanded.has(r.seq) && (
                  <pre className="mono" style={{ fontSize: 10, whiteSpace: "pre-wrap", margin: "6px 0 0", padding: 8, border: "1px solid var(--border)", borderRadius: 6, maxHeight: 180, overflow: "auto", userSelect: "text" }}>
                    {r.output_excerpt}
                  </pre>
                )}
              </div>
            ))}
            </>
          )}
        </div>
        {/* ⑥ 「加载更早」：满页才显示（不满页=已到底）；游标 = 已载最旧 ts−1ms（宿主算） */}
        {rows !== null && rows.length > 0 && hasMore && (
          <button className="ghost" style={{ marginTop: 10 }} disabled={moreBusy}
            data-testid="records-more" onClick={onLoadMore}>
            {moreBusy ? t("加载中…") : t("加载更早")}
          </button>
        )}
      </div>
      <div className="set-card">
        <h4>{t("保留期")}</h4>
        <div className="set-desc">
          {t("超过保留期的记录在应用启动时自动清理（落盘即密文，清理即删除）；0 = 永久保留（记录库会随使用无界增长，慎选）。改动在重启后生效。")}
        </div>
        <select style={{ fontSize: 12, marginTop: 8 }} aria-label={t("记录保留期")} data-testid="records-retention"
          value={String(retention)}
          onChange={(e) => onChangeRetention(Number(e.target.value))}>
          <option value="30">{t("保留 30 天（默认）")}</option>
          <option value="90">{t("保留 90 天")}</option>
          <option value="365">{t("保留 365 天")}</option>
          <option value="0">{t("永久保留")}</option>
        </select>
      </div>
      <div className="set-card">
        <h4>{t("导出")}</h4>
        <div className="set-desc">
          {t("按当前筛选导出")}<strong>{t("明文")}</strong>{t(" JSONL（每行一条记录，含脱敏输出摘录），供离线分析 / 评测集使用。")}
          {t("导出是敏感动作：文件落在记录库隔壁的")} <code>records-export/</code>{t("（文件名带时间戳），并留审计。记录默认保留 30 天，到期自动清理。")}
        </div>
        <button className="ghost" style={{ marginTop: 8 }} disabled={exportBusy || !rows || rows.length === 0} data-testid="records-export" onClick={onExport}>
          {exportBusy ? t("导出中…") : t("导出当前筛选") + (rows ? t("（{0} 条）", rows.length) : "")}
        </button>
      </div>
    </>
  );
}
