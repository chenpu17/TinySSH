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
- 命令块面板（FR-10 V2）：shell 集成开启后每条命令自动成块——状态条「块」或 工具 → 命令块 打开，最近 50 块时间线（来源徽标 人类/Agent·客户端/回放、退出码、耗时），每块可复制命令、重跑（危险形态/多行与粘贴同一条确认链，确认后经人类键入归因成块）、按命令文本在终端定位（best-effort）、一键跳到最近失败。Agent 侧照旧经现场简报读取最近块。
- 广播输入（iTerm 同款）：状态条「广播」/ 工具 → 广播输入 / ⌘K「广播输入」勾选目标会话后，在当前会话打字（含 Ctrl 控制键与 ⌥ Meta 序列）同时发往所有勾选会话——每个目标各自走人类键入路径（按各自主机字符集编码、命令块照常成立）。离线/断线目标自动跳过并在其终端里一次性告示；Agent 在控的会话会标出（广播键入按人类输入记块，不自动暂停 Agent）。粘贴与块重跑只进当前会话（各有确认链），永不广播。
- 输出触发器：设置 → 输出触发器 配正则规则（按完整行匹配、剥离颜色码、跨行不命中；同规则同会话冷却节流 5–3600 秒，上限 32 条）。「通知」动作命中即 toast + 标签铃；「发送键序」动作命中后**建审批卡等人类裁决**（可编辑键序；键序支持 `\r` `\n` `\t` `\0` `\\` 转义，存原文发送前解码），批准才写通道，120 秒无人裁决自动作废——绝不静默自动执行。规则为人类专属（Agent 无读写 API）；命中全程审计（`trigger_fired` / `trigger_send*`），键序直写 PTY 不记命令块（归因不撒谎）。
- 远端写剪贴板策略（OSC 52）：远端程序可借转义序列改写本机剪贴板（tmux/ssh 远端复制回本地的惯用法），也是剪贴板投毒入口——策略三档「每次询问（默认）/ 允许 / 拒绝」，询问卡展示解码预览与来源会话，写入成功必 toast 告知；读取类请求（查询）一律拒绝；设置 → 终端 可改，随工作区偏好持久化。远端主动通知（OSC 9）走既有响铃通路：标签闪烁恒开，系统通知同「响铃时系统通知」开关与节流。
- 可点击路径：终端里的文件路径（POSIX 绝对 / Windows 盘符 / ./ ../ 相对 / 裸多段如 src/main.rs，含 `:line` 与 `:line:col` 后缀）自动识别为链接，点击复制原文并 toast 告知——远端路径没法在本机打开，复制是最诚实的动作；http(s) 与 `xxx://` 协议让路给网页链接，URL/转义串/域名词内部不误判，CJK 宽字符行内列号对齐。
- 图片协议：内置 `@xterm/addon-image`，终端直接渲染 sixel 与 iTerm2（OSC 1337）内嵌图片（ssh 里 cat 图片、带图工具输出直接可见）；支持 `width`/`height` 按单元格/像素/百分比声明尺寸，存储超限自动淘汰最旧图，恒开无需配置。
- 块输出文本与 MCP read_blocks：命令块现在带输出文本（OSC 133 标记跨度精确采集，C→D 主窗 + D→B 尾窗——ConPTY 整帧重绘也不串行；渲染后已剥 ANSI，超 8KB 保尾截断并如实标记）；块面板有输出的块给「输出」复制钮（截断标 ✂ 并在悬停披露）；MCP 新增只读工具 `read_blocks`（session_id + 可选 limit 1–200），Agent 与人类同权读取块命令与输出，无审批（审批链只管传输/执行）。块面板即时刷新：shell 集成（OSC 133）标记直达前端，块开/合瞬间上屏，5s 轮询降为无集成 shell 的兜底；后台会话命令失败（D 标记非零退出码）时标签闪烁 + toast 点名失败命令（聚焦会话不打扰），系统通知走「响铃时系统通知」既有开关。
- 会话现场恢复（P3）：受控退出时自动给每个会话拍屏幕快照（C10 检查点：滚回尾 300 行 + 可视区 + 光标 + 终端模式），与凭据同库加密存储；下次启动欢迎页「⏮ 恢复上次现场」一键重建会话并重放画面（公告行标注快照时刻）——恢复走完整建连流程（TOFU/双因素原样把关，不自动拨号）；主机已删的条目如实跳过。强杀/断电来不及快照，如实只覆盖受控退出。
- 专注模式：F11 进出——标题栏/主机栏/工具栏/状态条全让位并系统全屏；标签条默认常驻（Ctrl+K 面板可切「自动隐藏」：藏为顶部 6px 抓手 + 顶缘浮标，扫上缘唤出）；状态记忆跨启动恢复。
- 活动栏与内置 Agent 视图（接真模型）：左缘图标栏切换「连接 / Agent / 编排」三个侧栏视图（互斥，全关 = 纯终端），栏底另设常驻设置图标（不随侧栏互斥隐藏，直开设置面板）；Agent 对话按会话隔离（跟随激活标签页），markdown 流式渲染（tiny-worker 同款安全姿态：原始 HTML 一律转义、链接防钓鱼、代码块高亮 + 复制 + >26 行折叠；mermaid 图与 KaTeX 公式——行内 $..$、$$ 块、```math 围栏——占位 + 懒加载渲染，独立 chunk 不进主包，加载/语法失败诚实保持源码原文，货币 $100 有误判防线保持字面，mermaid 走 strict + DOMPurify svg profile 双重受控、主题切换自动重染色）、推理模型思考块可折叠、工具审批卡（批准/拒绝内联在对话里，决策走既有审批链）。设置 → Agent 配置「模型服务」（OpenAI 兼容覆盖 GLM/DeepSeek/Qwen/Kimi 或 Anthropic）后自动从演练外壳切真模型：内核是 tiny-agent-core（本机 tiny-a 仓库 path 依赖），工具为 exec / read_blocks / read_screen / wait_output + upload / download / transfer_status + send_keys 八件（文件传输缺省冲突即失败并结构化报目标 stat，确认后 skip/overwrite 重试；send_keys 驱动交互式程序，会话级授权一次审批；**传输必审**、危险键序与危险命令同一引擎），经 SessionManager 同一 agent actor 执行——审批、审计、夺权语义全自动继承，内嵌 agent 无任何绕过路径；api_key 加密入库（vault 密封 KV，永不回显/明文落盘）。控制权显式交托：会话在人类手里时发送任务先弹「委托并发送」确认（工具栏「接管」随时收回，无需配置 MCP 协作）；模型服务配置即解锁委托/接管入口。Agent 视图头部「自主」开关（两击确认）：免逐条审批的自主运行——危险名单仍硬拦、传输仍逐条、全量记录（审计可辨自主动作）、急停条随时撤回。**跨主机编排（Fleet）**：第三视图的编排者不直接操作任何机器——用 fleet_sessions/dispatch_task/wait_task 把自包含任务并行派发给各会话的执行 agent 并汇总结果，目标会话的审批/危险扫描/控制权独立生效、拒绝如实上报（组合派发不覆盖逐机约束）。会话串行对话、可停止、跨会话独立上下文；切换模型服务后对话记忆重置（如实提示）。右缘图标栏常驻任务面板五视图入口（状态栏/工具栏既有入口保留）。
- 资源监控大屏（活动栏第四视图，整幅覆盖层）：多服务器资源卡——每台**服务器**一张卡（同机多连接去重合一，×N 徽标）CPU/内存环形仪表 + 磁盘/网络折线 + 近 30 分钟历史（内联 SVG，随主题），支持 Ascend 服务器 NPU 监控（npu-smi 每芯片健康/功耗/温度/利用率/HBM；无 npu-smi 自动隐藏 NPU 区，「有工具但表头未识别」显式呈现便于真机校准）。**采集开关 opt-in**：通用监控与 NPU 监控两枚独立开关，默认全关零后台开销；打开后后台持续采样（每 3 秒，关大屏不中断），重开大屏历史直接在，开关态持久化。数据通路沿底部监控条先例：人类专属直连 Fresh 通道采样、不经审批/审计/终端回放；连续采样失败卡片置灰可重试，点击卡片头切换会话。底部监控条（活动会话资源条）继续独立工作，两者暂停互不影响。
- 新建/编辑主机与快速连接为居中大对话框（Ctrl+T / ⌘K）；侧栏不再塞表单。
- 传输队列：底部抽屉（状态条「传输」）管理上传/下载任务——进行中可取消，失败/取消/中断可重试（新任务重新校验连接/源/冲突），结果未知可「重新核实」；下载完成卡「定位」（资源管理器中显示文件）与「打开」（系统默认程序打开文件本身，无关联扩展名由系统「打开方式」兜底）。

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

