// 内置 Agent 的演练脚本（活动栏轮，纯数据无状态）：真实模型接入前的对话外壳
// 数据面。每条用户消息走同一条脚本——开场流式文本 → exec 工具卡（停在「待审批」，
// 由用户批准/拒绝分岔）→ 摘要（markdown：标题/表格/长代码块/mermaid 图/公式，
// 覆盖渲染规则）。
// 明确标注「演练」不虚构真模型；状态机与计时在 agent-view.tsx。

export interface MockScript {
  /** 审批前开场白（流式 markdown） */
  intro: string;
  /** 工具卡：待审批的模拟 exec */
  tool: { tool: string; argsLabel: string; output: string; exit: number };
  /** 批准后的摘要（流式 markdown） */
  summary: string;
  /** 拒绝后的回应（流式 markdown） */
  denied: string;
}

const DEMO_OUTPUT = [
  "● tinyssh-agent.service - TinySSH Agent",
  "     Loaded: loaded (/lib/systemd/system/tinyssh-agent.service; enabled)",
  "     Active: active (running) since Mon 2026-10-20 09:12:04 CST; 3h 52min ago",
  "   Main PID: 8312 (tinyssh-agent)",
  "      Tasks: 6 (limit: 4915)",
  "     Memory: 18.4M",
  "        CPU: 12.394s",
  "     CGroup: /system.slice/tinyssh-agent.service",
  "             └─8312 /usr/local/bin/tinyssh-agent --config /etc/tinyssh/agent.json",
].join("\n");

// 30+ 行代码块：覆盖 mdview 的长代码折叠规则（>26 行稳定块默认收起）
const SUMMARY_CODE = [
  "#!/bin/sh",
  "# 演练：Agent 给出的巡检脚本（示例内容，非真实执行）",
  "set -eu",
  "",
  'echo "== 主机 =="',
  "hostname",
  "uptime",
  "",
  'echo "== 磁盘 =="',
  "df -h / /var",
  "",
  'echo "== 内存 =="',
  "free -m",
  "",
  'echo "== tinyssh-agent =="',
  "systemctl is-active tinyssh-agent",
  "systemctl show tinyssh-agent -p MainPID -p MemoryCurrent",
  "",
  'echo "== 最近失败任务 =="',
  "systemctl --failed --no-legend || true",
  "",
  'echo "== 端口监听 =="',
  "ss -tlnp | grep -E \':(22|8722)\\b\' || true",
  "",
  'echo "== 完成 =="',
  "date",
  "# 行 27",
  "# 行 28",
  "# 行 29",
  "# 行 30",
  "# 行 31",
].join("\n");

// 富文本摘要样本（渲染轮）：mermaid 图 + 行内/块级/围栏公式 + 货币误判样本——
// 覆盖 mmd.ts/math.ts 的占位渲染与 $..$ 配对纪律（金额保持字面）
const SUMMARY_MERMAID = [
  "flowchart LR",
  "  U[你] --> A{Agent}",
  "  A -->|批准| R[执行命令]",
  "  A -->|拒绝| C[取消]",
].join("\n");

export function mockScript(input: string): MockScript {
  const brief = input.trim().length > 24 ? input.trim().slice(0, 24) + "…" : input.trim();
  return {
    intro: [
      `收到：**${brief}**`,
      "",
      "我先看一下 `tinyssh-agent` 的运行状态，需要执行一条只读命令：",
      "",
      "- 读取服务状态（`systemctl status`）",
      "- 不改动任何配置",
    ].join("\n"),
    tool: {
      tool: "exec",
      argsLabel: "systemctl status tinyssh-agent",
      output: DEMO_OUTPUT,
      exit: 0,
    },
    summary: [
      "### 巡检结果",
      "",
      "服务运行正常，要点如下：",
      "",
      "| 项目 | 状态 |",
      "| --- | --- |",
      "| Active | active (running) |",
      "| 已运行 | 3h 52min |",
      "| 内存 | 18.4M |",
      "",
      "如需日常巡检，可以把下面的脚本挂到 cron：",
      "",
      "```bash",
      SUMMARY_CODE,
      "```",
      "",
      "### 架构与容量",
      "",
      "```mermaid",
      SUMMARY_MERMAID,
      "```",
      "",
      "内存占用约 $18.4\\text{ MiB}$，服务年化成本约 $100/月（这个金额保持字面不渲染）。",
      "",
      "可用率目标：",
      "",
      "$$",
      "\\text{可用率} = 1 - \\frac{\\text{故障时长}}{\\text{总时长}}",
      "$$",
      "",
      "```math",
      "E = mc^2",
      "```",
      "",
      "> 本回复由**演练外壳**生成，非真实模型——接入模型服务后这里将是真实的分析与建议。",
    ].join("\n"),
    denied: [
      "明白，已取消这条命令。",
      "",
      "我可以在不动服务的前提下改为纯只读检查（`systemctl is-active`），",
      "或者你把关心的点告诉我，我们换个方式看。",
    ].join("\n"),
  };
}

/** 首次打开某会话对话时的欢迎消息（演练声明，如实标注） */
export const WELCOME_MD = [
  "### 内置 Agent（演练外壳）",
  "",
  "这里是每会话独立的 Agent 对话。当前是**演练模式**：回复与工具卡都是脚本数据；",
  "在设置 →「Agent 接入」配置 API Key 并切到真模型后，同一套对话/审批/记录走真实执行。",
  "",
  "随便发一条消息，可以看到完整的交互形态：流式回复 → 工具审批卡（批准 / 拒绝）→ 结果摘要。",
].join("\n");
