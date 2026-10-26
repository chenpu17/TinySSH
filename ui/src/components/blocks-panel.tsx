// 命令块面板（P1-b，FR-10 V2）：BlockIndex 的人类侧呈现——最近命令块时间线，
// 每块带来源徽标（人类/Agent/回放）、退出码、耗时，支持复制命令、重跑（经宿主
// 粘贴安全链：危险形态/多行先确认）、定位（文本搜索，best-effort）。
// 数据经 read_blocks（最近 N 条旧→新），状态与动作全部归宿主，本组件只呈现。
import type { BlockInfo } from "../adapter/wire";
import { t } from "../i18n";
import { IconRefresh, IconTerminal } from "../icons";

/** source（BlockSource::describe()）→ 徽标文案与语义色类。 */
function sourceBadge(source: string): { label: string; cls: string; title: string } {
  if (source === "human") return { label: t("人类"), cls: "human", title: t("人类键盘输入") };
  if (source.startsWith("agent:")) return { label: t("Agent · {0}", source.slice(6)), cls: "agent", title: t("Agent（{0}）提交的命令", source.slice(6)) };
  if (source === "replay") return { label: t("回放"), cls: "replay", title: t("Fresh 结果镜像回放块") };
  if (source.startsWith("replay:")) return { label: t("回放 · {0}", source.slice(7)), cls: "replay", title: t("Fresh 结果镜像回放（{0}）", source.slice(7)) };
  return { label: source, cls: "replay", title: source };
}

/** 耗时文案：ms → 「320ms / 1.2s / 2m03s」；缺界（运行中/断线收尾）返回 null。 */
function durationText(start: string | null, end: string | null): string | null {
  if (!start || !end) return null;
  const ms = new Date(end).getTime() - new Date(start).getTime();
  if (!Number.isFinite(ms) || ms < 0) return null;
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`;
  return `${Math.floor(ms / 60_000)}m${String(Math.round((ms % 60_000) / 1000)).padStart(2, "0")}s`;
}

function clockText(ts: string | null): string {
  if (!ts) return "--:--:--";
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? "--:--:--"
    : d.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

interface BlocksPanelProps {
  sid: string | null;
  blocks: BlockInfo[];
  busy: boolean;
  err: string | null;
  /** 最近失败块的下标（blocks 数组内；无失败为 -1）——跳转后高亮 */
  failIdx: number;
  load: () => void;
  /** 重跑：宿主走粘贴安全链（危险/多行先确认），不在本组件直发 */
  rerun: (cmd: string) => void;
  /** 复制到剪贴板：what 用于 toast 区分（命令/输出） */
  copy: (text: string, what?: string) => void;
  /** 定位（文本搜索 best-effort；跨实现行号不对齐，不承诺精确滚动） */
  locate: (cmd: string) => void;
}

export function BlocksPanel({ sid, blocks, busy, err, failIdx, load, rerun, copy, locate }: BlocksPanelProps) {
  // 面板时间线：最新在上（与「看刚发生了什么」的阅读顺序一致）
  const rows = blocks.map((b, i) => ({ b, i })).reverse();
  return (
    <>
      <div className="section">
        <div className="log-bar">
          <span className="side-quiet" data-testid="blocks-note">
            {sid ? t("最近 {0} 块（旧→新取回）", blocks.length) : t("未接入会话")}
          </span>
          <span style={{ flex: 1 }} />
          <button className="ghost" data-testid="blocks-jump-fail" disabled={failIdx < 0}
            title={failIdx >= 0 ? t("跳到最近失败：{0}", blocks[failIdx].command.slice(0, 60)) : t("暂无失败块（exit ≠ 0）")}
            onClick={() => failIdx >= 0 && locate(blocks[failIdx].command)}>{t("跳到最近失败")}</button>
          <button className="ghost icon-btn" title={t("刷新")} aria-label={t("刷新命令块")}
            data-testid="blocks-refresh" disabled={busy}
            onClick={load}><IconRefresh size={14} /></button>
        </div>
      </div>
      <div className="section">
        {err ? (
          <div className="empty" data-testid="blocks-err">{err}</div>
        ) : !sid ? (
          <div className="empty" data-testid="blocks-empty-nosession"><IconTerminal size={14} />{t("未接入会话。")}</div>
        ) : rows.length === 0 ? (
          <div className="empty" data-testid="blocks-empty">
            <IconTerminal size={14} />{busy ? t("载入中…") : t("暂无命令块。shell 集成（OSC 133）开启后，每条命令自动成块。")}
          </div>
        ) : (
          rows.map(({ b, i }) => {
            const badge = sourceBadge(b.source);
            const dur = durationText(b.start, b.end);
            const ok = b.exit_code === null ? null : b.exit_code === 0;
            return (
              <div className={`tl-row block-row src-${badge.cls}${i === failIdx ? " blk-fail" : ""}`}
                key={`${b.start ?? "n"}-${i}`} data-testid="block-row"
                data-source={b.source} data-exit={b.exit_code === null ? "unknown" : String(b.exit_code)}
                title={`${b.command}${b.exit_code === null ? `\n${t("exit 未知")}` : `\nexit ${b.exit_code}`}${dur ? `\n${t("耗时 {0}", dur)}` : ""}${b.exec_id ? `\nexec ${b.exec_id}` : ""}`}>
                <div className="tl-meta">
                  <span className={`blk-src ${badge.cls}`}>{badge.label}</span>
                  <span>{clockText(b.end ?? b.start)}</span>
                  {dur && <span> · {dur}</span>}
                  {ok === false && <span className="blk-exit err">exit {b.exit_code}</span>}
                  {ok === true && <span className="blk-exit ok">✓ 0</span>}
                  {ok === null && <span className="blk-exit unknown">exit ?</span>}
                </div>
                <div className="tl-action blk-cmd mono">{b.command}</div>
                <div className="blk-acts">
                  <button className="ghost" data-testid="block-copy" title={t("复制命令")} onClick={() => copy(b.command)}>{t("复制")}</button>
                  {(b.output ?? "").length > 0 && (
                    <button className="ghost" data-testid="block-copy-output"
                      title={`${t("复制输出")}${b.output_truncated ? t("（超 8KB 已截断，保留尾部）") : ""}：${b.output!.slice(0, 120)}${b.output!.length > 120 ? "…" : ""}`}
                      onClick={() => copy(b.output!, t("输出"))}>{t("输出")}{b.output_truncated ? "✂" : ""}</button>
                  )}
                  <button className="ghost" data-testid="block-rerun" title={t("重跑（经粘贴安全链：危险/多行先确认）")}
                    onClick={() => rerun(b.command)}>{t("重跑")}</button>
                  <button className="ghost" data-testid="block-locate" title={t("在终端中定位（按命令文本搜索，同名命令取最近）")}
                    onClick={() => locate(b.command)}>{t("定位")}</button>
                </div>
              </div>
            );
          })
        )}
      </div>
    </>
  );
}
