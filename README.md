# TinySSH

> **当前设计方向（2026-10-06）**：优先完善面向开发者的 SSH 客户端体验——终端为主、文件按需打开，MCP 协作后续优化。[UX-R1 重构设计](docs/ux/ssh-client-ux-refactor.md)及[实施与验收计划](docs/ux/ssh-client-ux-refactor-delivery.md)已形成文档基线；G1–G4 已收官、G5 进行中，执行状态逐轮记录见[执行台账](docs/ux/ux-r1-execution-status.md)。既有工程结果见[历史验收报告](docs/acceptance/v0-mvp-acceptance.md)。

> 面向经常连接几台到十几台服务器、进行开发、部署和排障的开发者：连接省心、终端顺手、文件操作方便，需要时接入 Agent 协作。

## 开发

```bash
# 前端（demo 模式，纯浏览器可跑）
cd ui && npm install && npm run dev      # http://localhost:5183
npm test                                 # UI 套件（15 spec / 236 断言，headless）
npm run build                            # tsc + vite build

# 桌面应用（tauri dev；Rust 工作区）
cargo run -p tinyssh-app                 # 或 cargo tauri dev
cargo test --workspace                   # Rust 全量（-j 4 更稳，见下）

# e2e（需 docker sshd 容器：scripts/dev-sshd.sh）
TINYSSH_E2E_SSHD=1 cargo test --workspace
```

Windows 注意（实验性移植，分支 `ux/modernization`）：

- 跑 UI 测试需 `TINYSSH_UI_CHROME` 指向 Edge/Chrome（如 `C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe`）；本机无 docker 时 e2e 用例自动 skip。
- `cargo test --workspace` 默认并行可能触发编译期页面文件耗尽（os error 1455），用 `cargo test --workspace -j 4`。
- 快捷键在 Windows 上以 Ctrl 等价 ⌘（Ctrl+B 主机栏 / Ctrl+F 搜索 / Ctrl+W 关标签 / Ctrl+1–9 切换）。
- 终端品质：宽度表按 Unicode 11 判定（CJK/emoji 混排不串格）；设置 → 终端「终端外观」可调字体族（内置 JetBrains Mono 全量字形，亦可选 Nerd Font/Cascadia 等，按系统已装回落）、连字（开启即改用 DOM 渲染器——连字依赖 character joiner，与 GPU 合成互斥）、光标样式/闪烁、滚动历史行数与字距，改动即时生效。粘贴保护除多行确认外，命中危险形态（`rm -rf /`、`mkfs`、`dd` 覆写块设备等——与 Agent 审批同一张内置规则表）同样先确认再发送。
- 本地 shell 集成（命令块/现场延续）：bash / zsh / fish / powershell·pwsh 启动时自动注入 OSC 133/7（无需配置），Shell 模式 exec 与命令块在本机 Windows 会话同样可用；cmd、WSL（`wsl.exe`）、dash/ksh 等无 preexec 钩子的 shell 不注入，Shell 模式执行时**立即如实拒绝**（不静默降级），Fresh 模式不受影响。PowerShell 退出码取 `$?`/`$LASTEXITCODE` 混合映射（成功 0，失败优先原生命令退出码）；本地会话 cwd 按原生盘符路径呈现（`C:/…`）。
- 专注模式：F11 进出——标题栏/主机栏/工具栏/状态条全让位并系统全屏；标签条默认常驻（Ctrl+K 面板可切「自动隐藏」：藏为顶部 6px 抓手 + 顶缘浮标，扫上缘唤出）；状态记忆跨启动恢复。
- 新建/编辑主机与快速连接为居中大对话框（Ctrl+T / ⌘K）；侧栏不再塞表单。

## 文档

| 文档 | 内容 | 何时读 |
|---|---|---|
| [SSH 客户端体验重构设计（UX-R1）](docs/ux/ssh-client-ux-refactor.md) | 当前定位、功能去向、布局与流程、视觉参考、技术增量、迁移边界 | 本轮重构首先阅读 |
| [UX-R1 实施任务与验收矩阵](docs/ux/ssh-client-ux-refactor-delivery.md) | G0–G5 拆票、依赖、功能/性能/真人验收、交接证据 | 排期、开发与验收 |
| [UX-R1 独立审核与开工结论](docs/ux/2026-10-06-ux-r1-independent-review.md) | 三路独立审核、问题关闭记录、G0 开工与出口边界 | 开工交接与评审 |
| [PRD](docs/prd.md) | 愿景、设计理念（决策过滤器）、需求与验收标准、里程碑 | 任何功能取舍前 |
| [L0 总体设计](docs/architecture/l0-system-design.md) | 系统上下文、容器视图、技术选型、ADR、Spike 清单 | 动手写代码前 |
| [L1 模块设计](docs/architecture/l1-component-design.md) | crate 划分、SessionApi 接口、审批/凭据/MCP 设计、数据模型、威胁模型 | 实现各模块前 |
| [协作产品验证计划](docs/validation-plan.md) | Agent 交接的用户研究、观察指标、决策 gate | 评估协作价值；与客户端验收分开 |
| [PV 执行工具包](docs/pv/session-kit.md) | 主持手册、任务卡、问卷与阈值预登记模板；配套 [pv_env.sh](scripts/pv_env.sh)（沙箱故障模板）/[dist.sh](scripts/dist.sh)（分发构建）/[pv_analyze.py](scripts/pv_analyze.py)（分析与 gate 计算） | 招募参与者与开测前后 |

## 治理约定

1. **当前产品顺序与 UX 范围以 UX-R1 为准**：文档权威见重构设计 §0.1；旧 PRD 的 Agent 优先和完整客户端后移不再约束本轮。
2. **核心契约继续有效**：PRD/L0/L1 的终端真源、凭据、审批、接管与重确认语义继续遵守；UX-R1 明确列出的增量须完成契约与兼容验证。
3. **文档修订**：PRD / L0 / L1 的变更须更新对应文档的「修订记录」；**PRD 变更后，L0/L1 须在合并前同步评审一致性**；新的关键技术决策在 L0 §6 追加 ADR（触发标准：换库、跨 crate 契约变更、安全边界变更）。
4. **客户端与协作分别验收**：客户端重构按 UX-R1 实施计划验收；协作价值仍按 validation-plan 的真人 PV 验证。任一通过均不代表另一项通过，旧协作 PV 不再阻止本轮客户端体验建设。

## 状态

UX-R1 v1.1 为当前重构设计基线，PRD v0.7 登记方向与独立审核后的契约修订。三路独立静态审核及修订复核已完成，详见[审核报告](docs/ux/2026-10-06-ux-r1-independent-review.md)。现有客户端及协作能力作为迁移基础；可启动 G0，G0 退出需实际原型、wire/fixture 和基线证据，不能跳过直接全面进入 G1–G5。历史报告只证明其记录版本与条件下的结果，不作为本轮重构已完成的证据。

## 技术栈（概览）

Tauri v2 · Rust（tokio / russh ≥0.61 / portable-pty / alacritty_terminal / tree-sitter-bash）· React + xterm.js · SQLite · MCP（rmcp ≥2.0.0，streamable HTTP + stdio shim）

## Agent 接入（协作）

应用启用协作后在 `127.0.0.1`（默认 8722，被占递增）内嵌 MCP 端点，并提供**内置接入文档**：
`http://127.0.0.1:<port>/integration.md`（Markdown，含端点/认证/行为约定/实时工具目录；`/` 为人读页面）。
把该 URL 扔给任何能取网页的 Agent 即可自助对接。能力面：23 个工具（会话/exec/传输/转发/审计/执行记录）、
资源（`tinyssh://sessions` 等现场状态，可 `resources/subscribe` 收变化推送）与引导提示（`prompts/get`）。
Agent 侧所有动作（命令/传输/转发，含被拒的）进**结构化执行记录**：加密落盘、输出摘录脱敏、
保留 30 天（可在 设置 → 记录审计 调整），Agent 可 `query_records` 自查，人类在 设置 → 记录审计 时间线回看（种类/来源/会话/时间筛选、加载更早），
并可一键导出明文 JSONL（落 `records-export/`，导出留审计）。
接入步骤：设置 → Agent 接入 →
`tinyssh agent create <id> <名称>` 签发 Token（仅展示一次）→ Agent 侧按文档配置 HTTP 直连
或 stdio shim（`tinyssh-mcp`）。危险命令与 Agent 传输逐条人工审批
（审批卡支持「记住并批准」：30 分钟精确免审或写入持久放行规则；也可按 Agent
开启**自主模式**——免逐条审批运行，危险命令仍硬拦、全部动作进
执行记录，横幅常显一键急停，重启即失效；传输默认仍逐条审批，
可在 设置 → Agent 接入 显式改「自主模式下传输免审」，随时刻关）；所有操作进审计。
无头场景可用 `tinyssh serve` 起同款端点——注意它与 GUI 共享数据库但**不共享内存态**，
请分时使用（审批队列互不可见）。

