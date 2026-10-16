// 现场简报卡（人话版）：当前目录 / 运行中 / 最近命令 / 提示。
// 后端 facts 原样保留在 SessionBrief（MCP 侧），这里只做面向用户的重排：
// 命令历史压到最近两条、认知标签翻成中文、屏尾调试 dump 不再上屏。
import type { SessionBrief as Brief } from "../adapter/wire";
import { epistemicLabel, exitText } from "../app-data";


// 现场简报（人话版）：当前目录 / 运行中 / 最近命令 / 提示。
// 后端 facts 原样保留在 SessionBrief（MCP 侧），这里只做面向用户的重排：
// 命令历史压到最近两条、认知标签翻成中文、屏尾调试 dump 不再上屏。
export function BriefCard({ brief }: { brief: Brief }) {
  const cwd = brief.facts.find((f) => f.subject === "cwd");
  const cmds = brief.facts.filter((f) => f.subject.startsWith("命令")).slice(0, 2);
  // 控制权 fact 是最近 3 条变迁（旧→新）；这里展示最新一条
  const ctl = [...brief.facts].reverse().find((f) => f.subject === "控制权");
  const notices = brief.facts.filter((f) => f.subject === "运行中任务" || f.subject === "SSH 现场");
  // 命令 fact detail 为后端拼好的 "<cmd> → exit <n>"；cmd 是键入原始字节，
  // ↑ 召回历史等场景会带转义序列，清理后再展示（清完为空说明无法还原命令，不显示该行）
  const cleanCmd = (s: string): string =>
    s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").replace(/[\x00-\x1f\x7f]/g, "").trim();
  const parseCmd = (detail: string): { cmd: string; exit: string } => {
    const i = detail.lastIndexOf(" → exit ");
    if (i < 0) return { cmd: cleanCmd(detail), exit: "" };
    return { cmd: cleanCmd(detail.slice(0, i)), exit: exitText(detail.slice(i + 8)) };
  };
  const epi = (s: string) => s.toLowerCase(); // Confirmed/NeedsRecheck/Unobservable → CSS 修饰类
  return (
    <div className="card">
      {cwd && (
        <div className={"brief-fact " + epi(cwd.status)}>
          <span className={"epistemic-badge " + epi(cwd.status)}>{epistemicLabel(cwd.status)}</span>
          <div className="bf-body">当前目录 <span className="mono">{cwd.detail}</span></div>
        </div>
      )}
      {brief.running.length > 0 && (
        <div className="brief-fact"><div className="bf-body err">运行中：{brief.running.join("、")}</div></div>
      )}
      {cmds.map((f, i) => {
        const { cmd, exit } = parseCmd(f.detail);
        if (!cmd) return null;
        return (
          <div className={"brief-fact " + epi(f.status)} key={i} title={cmd}>
            <span className={"epistemic-badge " + epi(f.status)}>{epistemicLabel(f.status)}</span>
            <div className="bf-body">
              <span className="mono cmd-inline">$ {cmd}</span>
              {exit && <span className="dim"> · {exit}</span>}
            </div>
          </div>
        );
      })}
      {notices.map((f, i) => (
        <div className={"brief-fact " + epi(f.status)} key={`n${i}`} title={f.detail}>
          <span className={"epistemic-badge " + epi(f.status)}>{epistemicLabel(f.status)}</span>
          <div className={"bf-body" + (f.status === "Unobservable" ? " err" : "")}>{f.detail}</div>
        </div>
      ))}
      {/* 控制权 fact 是系统核实事实；行会被截断，tooltip 给全文 */}
      {ctl && (
        <div className={"brief-fact " + epi(ctl.status)} title={ctl.detail}>
          <span className={"epistemic-badge " + epi(ctl.status)}>{epistemicLabel(ctl.status)}</span>
          <div className="bf-body dim">控制权：{ctl.detail}</div>
        </div>
      )}
    </div>
  );
}
