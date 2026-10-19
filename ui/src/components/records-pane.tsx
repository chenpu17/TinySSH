// 记录审计时间线（④ 记录与审计的 GUI 消费面）：设置面板「记录审计」分区。
// 纯呈现组件——数据在宿主 App 拉取（打开分区/筛选变化/手动刷新），本组件只渲染。
// 记录本体在核心侧按天加密落盘、写入时已脱敏；这里的「导出」是唯一明文出口，
// 落点固定在核心 records-export/（不开放任意路径），导出动作留审计。

import { useState } from "react";
import type { ActionRecord, ActionRecordKind, RecordsQuery } from "../adapter/wire";

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

interface RecordsPaneProps {
  /** null = 首拉中；[] = 查询无结果 */
  rows: ActionRecord[] | null;
  busy: boolean;
  exportBusy: boolean;
  filter: RecordsQuery;
  /** 筛选下拉的 Agent 选项（来自 MCP 登记面） */
  agents: { id: string; label: string }[];
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
  const { rows, busy, exportBusy, filter, agents, onFilter, onRefresh, onExport,
    hasMore, moreBusy, onLoadMore, retention, onChangeRetention } = props;
  // 摘录展开态（面板本地；按 seq 记，翻筛后自然失效无害）
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
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
        <h4>动作时间线</h4>
        <div className="set-desc">
          Agent 与人类的命令 / 传输 / 转发动作都会记录在案（落盘即密文，输出摘录写入时已启发式擦除密钥）；
          Agent 只能经 MCP 查自己的记录，这里是人类的全量视角。与「协作面板 → 活动记录」的哈希链审计互补：审计面向追责，时间线面向回看。
        </div>
        <div className="row" style={{ gap: 6, marginTop: 8, flexWrap: "wrap", alignItems: "center" }}>
          <select
            style={{ fontSize: 11 }} aria-label="按种类筛选" data-testid="records-kind-filter"
            value={filter.kind ?? ""}
            onChange={(e) => onFilter({ ...filter, kind: (e.target.value || null) as RecordsQuery["kind"] })}
          >
            <option value="">全部种类</option>
            <option value="exec">命令</option>
            <option value="transfer">传输</option>
            <option value="forward">转发</option>
          </select>
          <select
            style={{ fontSize: 11 }} aria-label="按来源筛选" data-testid="records-agent-filter"
            value={filter.agentId ?? ""}
            onChange={(e) => onFilter({ ...filter, agentId: e.target.value || null })}
          >
            <option value="">全部来源</option>
            {agents.map((a) => (
              <option key={a.id} value={a.id}>{a.label}</option>
            ))}
          </select>
          <select
            style={{ fontSize: 11 }} aria-label="条数上限" data-testid="records-limit-filter"
            value={String(filter.limit)}
            onChange={(e) => onFilter({ ...filter, limit: Number(e.target.value) || 200 })}
          >
            <option value="200">最近 200 条</option>
            <option value="500">最近 500 条</option>
            <option value="1000">最近 1000 条</option>
          </select>
          <button className="ghost" style={{ fontSize: 11 }} disabled={busy} data-testid="records-refresh" onClick={onRefresh}>
            刷新
          </button>
        </div>
        <div style={{ marginTop: 8 }} data-testid="records-timeline">
          {rows === null ? (
            <div className="dim" style={{ fontSize: 12, padding: "10px 0" }}>
              {busy ? "加载中…" : "打开本分区加载记录"}
            </div>
          ) : rows.length === 0 ? (
            <div className="dim" style={{ fontSize: 12, padding: "10px 0" }} data-testid="records-empty">
              当前筛选下暂无记录——Agent 执行命令 / 传输文件后会出现在这里。
            </div>
          ) : (
            rows.map((r) => (
              <div key={r.seq} data-testid="records-row" style={{ padding: "6px 0", borderBottom: "1px dashed var(--border)" }}>
                <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap", fontSize: 12 }}>
                  <span className="dim mono" style={{ fontSize: 11 }}>
                    {new Date(r.ts).toLocaleString(undefined, { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" })}
                  </span>
                  <span className="badge" style={{ fontSize: 10 }}>{KIND_LABEL[r.kind] ?? r.kind}</span>
                  <span className="dim" style={{ fontSize: 11 }}>
                    {r.agent_id ? `Agent ${r.agent_id}` : "人类"}
                  </span>
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
                      {expanded.has(r.seq) ? "收起输出" : "看输出"}
                    </button>
                  )}
                </div>
                {r.output_excerpt && expanded.has(r.seq) && (
                  <pre className="mono" style={{ fontSize: 10, whiteSpace: "pre-wrap", margin: "6px 0 0", padding: 8, border: "1px solid var(--border)", borderRadius: 6, maxHeight: 180, overflow: "auto", userSelect: "text" }}>
                    {r.output_excerpt}
                  </pre>
                )}
              </div>
            ))
          )}
        </div>
        {/* ⑥ 「加载更早」：满页才显示（不满页=已到底）；游标 = 已载最旧 ts−1ms（宿主算） */}
        {rows !== null && rows.length > 0 && hasMore && (
          <button className="ghost" style={{ marginTop: 10 }} disabled={moreBusy}
            data-testid="records-more" onClick={onLoadMore}>
            {moreBusy ? "加载中…" : "加载更早"}
          </button>
        )}
      </div>
      <div className="set-card">
        <h4>保留期</h4>
        <div className="set-desc">
          超过保留期的记录在应用启动时自动清理（落盘即密文，清理即删除）；0 = 永久保留（记录库会随使用无界增长，慎选）。改动在重启后生效。
        </div>
        <select style={{ fontSize: 12, marginTop: 8 }} aria-label="记录保留期" data-testid="records-retention"
          value={String(retention)}
          onChange={(e) => onChangeRetention(Number(e.target.value))}>
          <option value="30">保留 30 天（默认）</option>
          <option value="90">保留 90 天</option>
          <option value="365">保留 365 天</option>
          <option value="0">永久保留</option>
        </select>
      </div>
      <div className="set-card">
        <h4>导出</h4>
        <div className="set-desc">
          按当前筛选导出<strong>明文</strong> JSONL（每行一条记录，含脱敏输出摘录），供离线分析 / 评测集使用。
          导出是敏感动作：文件落在记录库隔壁的 <code>records-export/</code>（文件名带时间戳），并留审计。记录默认保留 30 天，到期自动清理。
        </div>
        <button className="ghost" style={{ marginTop: 8 }} disabled={exportBusy || !rows || rows.length === 0} data-testid="records-export" onClick={onExport}>
          {exportBusy ? "导出中…" : `导出当前筛选${rows ? `（${rows.length} 条）` : ""}`}
        </button>
      </div>
    </>
  );
}
