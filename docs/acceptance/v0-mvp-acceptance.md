# V0 MVP 工程验收报告

> 版本：v1.32 · 日期：2026-10-03 · 验收对象：V0 thin-slice MVP（[PRD v0.5 §10](../prd.md)、[L1 v0.5](../architecture/l1-component-design.md)、[validation-plan v0.4](../validation-plan.md)）
> 验收方式：自动化测试 + Spike 基准 + GUI 交互走查 + **独立 subagent 审计与复跑（v1.1 新增，见 §5）**；全部可复现（见 §7 复现指令）。

---

## 1. 交付物清单（对照 L1 §1 workspace）

| 模块 | 状态 | 说明 |
|---|---|---|
| `session-api` | ✅ | v1 冻结子集：SessionApi trait、全部契约类型（Actor/ExecOpts/TakeoverReport/SessionBrief/Epistemic/Error…）、ChannelHandle 通路抽象 |
| `term-core` | ✅ | alacritty 网格真源 + OSC 133/OSC 7 扫描器 + 命令块索引 + 无损环形缓冲 + Fresh 镜像回放 + exec 输出捕获 |
| `transport-ssh` | ✅ | russh 0.63：持久 shell channel（PTY）+ 同连接 Fresh 通道（env 注入、真实退出码）+ SFTP + TOFU 指纹记录 + 断线重连 |
| `transport-pty` | ✅ | portable-pty：本地 shell + OSC 133 集成注入（bash rcfile / zsh ZDOTDIR）+ Fresh 隐藏子进程 |
| `approval` | ✅ | tree-sitter-bash 逐段求值（解析失败保守报审；`systemctl status; reboot` 前缀绕过被拦）+ 内置危险模式（不可删除）+ allow/TTL 窗口 |
| `audit` | ✅ | SQLite（L1 §6 DDL）+ 哈希链（sha256 链式）+ 篡改检测测试 |
| `vault` | ✅ | 主密钥（keychain/argon2id/env 三级）+ XChaCha20-Poly1305 身份加密 + Agent Token（CSPRNG 32B、仅存哈希、常数时间比较）+ ed25519 生成/导入 + hosts/identities/agents/policies/sessions/approvals 持久化 |
| `core-session` | ✅ | SessionApi 实现：串行执行队列（QueueBusy 背压）、审批联动（120s 超时/ApproveEdited/作废唤醒）、接管契约（冻结+void+尽力停止+诚实标注）、交还契约、SessionBrief（三层认知状态）、重连状态机 + Reconfirming（白名单 + 核心自动判定） |
| `mcp-server` | ✅ | rmcp 3.4.1 streamable HTTP + per-client Bearer（逐请求解析，身份仅来自 Token）+ 13 工具 + annotations + isError 错误载荷；**仅依赖 session-api 契约**（`Arc<dyn SessionApi>` + Token 解析闭包，装配留壳层——L1 §1 依赖规则审计核实通过）。V0 承载形态：`tinyssh serve` 单进程装配 MCP+核心（人类经 CLI 审批）；GUI 进程内嵌核心但未承载 MCP 端点（见 §6.1 边界 7） |
| `shim` | ✅ | tinyssh-mcp：stdio ↔ HTTP 透明转发（180s 超时 > 审批 120s） |
| `cli` | ✅ | tinyssh：serve / agent / host（含 ~/.ssh/config 导入）/ session / approval / audit 人工侧全操作 |
| `src-tauri` + `ui` | ✅ | Tauri 2.12 薄壳 + React/xterm.js：三栏布局（主机/终端+控制权/审批+简报+时间线）、Raw 字节 IPC 通道、审批事件推送 |

## 2. 首个可运行验收场景（PRD §10 定稿原文）

> **旧请求待审批 → 人接管修改现场 → 交还 → 旧请求（含待审批卡片）失效 → Agent 核实后重新提交**

**结果：通过**（`crates/mcp-server/tests/e2e_acceptance.rs::acceptance_scenario_on_ssh`，目标 = 真实 OpenSSH 9.7 / Linux 容器，Agent 侧全程 rmcp MCP 客户端驱动）：

1. Agent `create_session`（远程）→ 审批卡片 → 人类批准 → 会话建立 ✅
2. Agent `exec "echo old_request_should_die"` → 待审批卡片（阻塞）✅
3. 人类 `set_control(Human)` → 接管报告 `frozen=true` ✅
4. Agent 阻塞调用返回 **`voided_by_handback`** 且载荷**附简报** ✅
5. 待审批卡片状态 = **`voided`**；对它再次 `decide_approval` → **被拒**（卡片不可再生效）✅
6. 控制权在人类期间 Agent `exec` → **`control_taken_by_human`** ✅
7. 人类修改现场（`mkdir /tmp/handoff-demo && cd && touch marker_from_human`，Human 短路审批）✅
8. 人类交还 → Agent `get_session_brief`：**cwd = /tmp/handoff-demo（Confirmed）** ✅
9. Agent 重新提交 `pwd && ls marker_from_human` → 人类批准 → 在新现场执行成功 ✅
10. 审计断言：旧请求**从未被执行** ✅

本地会话同构场景（`core-session/tests/core_local.rs`，无需容器）同样通过，并额外覆盖：
作废卡片不可再生效、控制权拒绝、交还后重提交、`QueueBusy{position}` 背压（第 9 条排队请求被拒）。

## 3. SPIKE 门限（L0 §8）

| Spike | 门限 | 实测 | 结论 |
|---|---|---|---|
| **SPIKE-1** IPC Channel 吞吐 | ≥10MB/s 持续 60s，含 resync 演练 | debug 构建 9.8MiB/s（发现 JSON 数字数组编码瓶颈）→ **改为 Raw 字节通道后 release 实测 1462.7 MB/s（92GB/60s，18 次 resync 演练）** | ✅（结论已固化为生产实现：`InvokeResponseBody::Raw`） |
| **SPIKE-2** russh×alacritty 保真 | 与 OpenSSH 参考流渲染一致；RSS 无泄漏 | `seq 1 50` 输出域与系统 OpenSSH+PTY 渲染逐行字节一致（50/50）；20MB 压力流量后 RSS 增长 704KB（门限 51200KB） | ✅ |
| **SPIKE-3** MCP 合规 | 13 工具 + annotations；错误语义表；120s 审批挂起不被客户端切断；exec P95<300ms | 工具清单与 `readOnlyHint`/`destructiveHint` 合规；`dangerous_pattern`/`approval_denied`/`control_taken_by_human`/`approval_timeout` 逐条断言；**挂起 120.00s 未被切断**；**P95 = 1.8ms** | ✅ |

## 4. 测试统计（全量 `cargo test --workspace`，v1.7 实测口径）

| 套件 | 数量 | 覆盖 |
|---|---|---|
| core_local（核心管线） | 11 | Shell 现场延续（cd 跨 exec）、Fresh 真实退出码+镜像回放、审批批准/拒绝、allow 规则免审、危险模式不可批准、**接管作废全链路（含作废卡片不得仍 pending）**、队列背压、**Ctrl+C 中断前台进程（v1.4：`send_keys("\x03")` → SIGINT → 块闭合 → shell 响应）**、**本地会话一键重连全链路（v1.7：死端→重连→重确认→核实恢复 + 未断开防呆）**、**meta 序列不进命令文本（v1.8：`\x1b` 前缀键入块不登记，简报无 'b' 残留）**、**主机指纹门三段式（v1.10：FirstSeen 信任入库 / 变更拒绝不改记录 / 变更放行更新，真实 sshd，e2e 守卫）** |
| handle 白名单单元回归 | 1 | **重确认白名单仅限单条简单命令（M1 回归：`pwd && evil` 等复合形态全部拒绝）** |
| term-core | 12 | 块生命周期（A/B/C/D）、Agent 键入归因、受管块、OSC 跨 feed、OSC7、快照、捕获、回放 |
| approval | 12 | 精确/前缀/正则、TTL 过期、复合命令逐段（绕过用例）、内置 deny 不可删、ApproveEdited 不可越 deny、解析失败保守报审、**命令替换强制报审（M2 回归）**、**deny 规则逐 agent（m3 回归）** |
| audit | 2 | 追加/查询/导出、**篡改检测** |
| vault | 14 | 加解密往返+篡改、Token 生命周期、主机口令加密存储、ed25519 生成与解密、**主机指纹 TOFU 往返（v1.10：无记录/入库/更新/未知主机拒绝）**、**UI 偏好 KV 往返（v1.11：未设置→None / upsert 覆盖 / 按 key 隔离 / 重开同库仍在）**、**ssh-config 解析器（v1.14：基本块/缺省回落/多模式拆分/`=`分隔与大小写/首值优先/注释与未知键/Match 块跳过/多 IdentityFile 取首/坏端口忽略——8 例）** |
| e2e_acceptance（真实 OpenSSH） | 5 | **首屏干净回归（v1.2：read_screen 不得含注入回显/scrollback）**、**首验收场景**、旅程 2（自动重连→Reconfirming：白名单外被拒、**复合白名单形态被拒（M1 回归）**、核实后自动恢复、cwd 事实 NeedsRecheck→核实 Confirmed、重连后为新 shell 不谎报现场延续）、**旅程 3（v1.7：docker stop 超自动重连窗口 → Disconnected 死端 → start → 手动重连 → 审计含 session_reconnect）**、**旅程 4（v1.7：键入一半脏状态断线重连——屏面无注入片段泄漏、残留块收尾、半截命令不执行，P1 §6-17 复现矩阵）** |
| protocol（SPIKE-3） | 1 | §3 表 |
| shell_integration（transport-pty） | 1 | 本地 zsh 集成 + 块 + OSC7 + Fresh 退出码 |
| **pty_reconnect（transport-pty，v1.7）** | 1 | **本地 PTY 重连：shell 退出死端 → reconnect 换新 shell、同一 broadcast 订阅不失效** |
| sshd_e2e（transport-ssh） | 3 | SSH 块 + cwd + Fresh env + SFTP 往返；**SFTP 下载中途取消（v1.13：真实 256MB 传输中触发取消 → Cancelled + 本地无完整文件）**；**ssh-agent 认证（v1.14：一次性独立 ssh-agent + 容器临时公钥 → Agent 认证建连 → exec 实证，收尾自动清理）** |
| **sshcfg_import（core-session，v1.14）** | 2 | **~/.ssh/config 导入内核链路：预览对账（通配符/Match 跳过、多模式拆分、身份有无标注、already_imported 对账）+ 勾选导入（IdentityFile→Key 身份落库、无凭据→Agent 零密钥、审计 host_upsert/identity_create）**；**导入的 Agent 主机经 SessionManager 全栈真实建连（一次性 ssh-agent + 容器公钥，指纹门应答器同构）** |
| spike2 | 1 | §3 表 |

**合计 66 个测试，0 失败（v1.14 本轮回归）。** 修复前基线由独立验证员复跑确认 41/41（见 §5.2）。共享 docker sshd 的测试以跨进程文件锁串行（`tinyssh_testbed::sshd_lock`），持锁后等待容器就绪（`await_sshd_ready`），消除重启时序 flake；全量回归须先编译后运行（见 §7），避免同机争抢 CPU 拉长会话首提示符延迟（§6.1-11）。**v1.11 勘误**：v1.10 的「53/53」中 e2e_acceptance 实为守卫缺省跳过（未计失败但未真实执行）——门禁应答缺口修复后，e2e 5 项自 v1.11 起真实跑过指纹门（§5.13 披露②）。v1.12 无 Rust 改动（T19 为纯 UI 轮），54/54 复跑全绿。v1.13 新增 sshd_e2e 取消测试（T20），55/55 全绿（e2e 守卫开启，0 跳过）。v1.14 新增 vault 解析器 8 例 + sshd_e2e agent 认证 + core-session 导入链路 2 例，66/66 全绿（e2e 守卫开启，0 跳过；T21 UI 视觉走查见 §5.16）。v1.19 新增 session-api wire 格式锁定测试 1 例（T26，见 §5.21）。**v1.21 勘误**：v1.15–v1.20 各轮回归命令漏带 `TINYSSH_E2E_SSHD=1`（守卫跳过被计成通过，T18 教训重演，见 §5.23 披露②）；本轮带守卫 `--no-fail-fast` 实测 **68/68（0 跳过）**= 67 + 1 kb 回落 e2e（路线图⑩ 2FA，§5.23），并顺带修复 journey3 并发超时（补重试兜底）与 spike2 参考密钥隐式环境依赖（测试内自举）。

## 5. 独立复核（v1.1 新增）

本版补充三项独立证据链：**独立 subagent 审计**（未参与开发的第三方视角，只读核查）、**独立测试复跑**、**浏览器视觉走查**。

### 5.1 独立契约与代码审计

判定 **pass-with-issues（0 blocker / 3 major / 10 minor）**，全部附 file:line 实据。七项指定断言中，L1 §1 依赖规则、Void 契约（四处作废返回附简报 + 作废卡片不可复活 + 排队启动前复查代际）、常量一致（120s / MAX_EXEC_QUEUE=8）、审计哈希链、MCP 13 工具清单均核实通过；人的主权与审批安全机制存在但各有缺口。处理结果：

| 发现 | 级别 | 处理 |
|---|---|---|
| **M1** 重确认白名单前缀匹配可绕过（`pwd && <任意命令>` 免审执行并退出重确认） | major | **已修**：白名单仅接受单条简单命令，复合/替换/重定向一律退出；新增单元回归 + journey2 复合拒绝断言 |
| **M2** 命令替换体是 deny/allow 双盲区（`echo $(reboot)` 可借 `echo *` TTL 免审执行） | major | **已修**：替换/解析失败 → 内容不可预判，强制报审（deny 仍优先、ApproveEdited 同口径）；新增回归测试 |
| **M3** "装配留壳层"与交付形态不符：GUI 进程未承载 MCP 端点，跨进程审批（GUI 批准 serve 进程卡片）不可达 | major | **如实披露为边界**（§6.1-7）：V0 承载形态为 `tinyssh serve` 单进程；GUI 跨进程审批留 V1 |
| m1 报告测试统计自相矛盾（41 vs 42） | minor | **已修**：本版改为实测口径（44） |
| m2 恒真断言（`assert!(!… \| \| true)`） | minor | **已修**：改为"作废卡片不得仍 pending"真断言 |
| m3 用户 deny 规则跨 agent 生效 | minor | **已修**：逐 agent 匹配 + 回归测试 |
| m4 审计哈希链未覆盖 approval_id | minor | **已修**：append 与 verify_chain 同步纳入 |
| m5 live_execs 异常路径泄漏（CancelOnDrop 空实现） | minor | **已修**：真实清理；run_shell 超时保留 running 属实语义（命令确实仍在远端跑，接管时如实上报） |
| m6 send_keys/transfer 缺 Reconfirming 门槛 | minor | **已修**：与 exec 同口径拒绝 |
| m7 read_screen 的 style 参数声明但丢弃 | minor | 披露为边界（§6.1-8） |
| m8 src-tauri 管理操作绕过门面直连 vault | minor | 披露为边界（§6.1-9） |
| m9 wait_approval 代际捕获竞态（可空等到 120s 超时而非即时作废） | minor | **已修**：登记后复查即时作废 |
| m10 create_session 审批卡不受接管作废（session_id 为空） | minor | 披露为口径边角（§6.1-10） |

### 5.2 独立测试复跑

独立验证员在全新进程重跑 `TINYSSH_E2E_SSHD=1 cargo test --workspace`：**41/41 通过**（修改前基线），三个关键测试逐项确认：`acceptance_scenario_on_ssh`（首验收场景）、`journey2_reconnect_reconfirm`、`spike3_protocol_compliance`（含 120s 审批挂起）。原始日志：[evidence/independent-test-run.log](evidence/independent-test-run.log)。复跑暴露 3 个并发 flake（empty-screen / script-not-done / cwd=null），根因定位为 pump 订阅竞态（见 §6.1-11），已修复并纳入最终回归。

### 5.3 GUI 视觉走查（浏览器黑盒，T1–T7）

演示模式（`ui/src/demo.ts`，与生产同 UI 代码路径）以浏览器自动化逐点走查，截图留档 [screenshots/](screenshots/)：

| 测试点 | 验证内容 | 证据 |
|---|---|---|
| T1 初始态 | 三栏布局 / 主机列表 / 控制权芯片 / 审批卡逐段报告 / 审计时间线 | [t1_initial_agent_owner.png](screenshots/t1_initial_agent_owner.png) |
| T2 绑定会话 | 终端回放 + 现场简报事实与三层认知状态（Confirmed/NeedsRecheck 色片） | [t2_session_attached_brief.png](screenshots/t2_session_attached_brief.png) |
| T3 人类命令 | 本地输入（短路审批）→ 终端实时回显 | [t3_human_exec.png](screenshots/t3_human_exec.png) |
| T4 接管 | 冻结提示 / 控制权→人类 / 会话徽标"人类控制" / 按钮切换 | [t4_takeover_human.png](screenshots/t4_takeover_human.png) |
| T5 交还 | 控制权→Agent / 提示语 / 终端完整保留接管-交还历史 | [t5_handback_agent.png](screenshots/t5_handback_agent.png) |
| T6 审批拒绝 | 卡片 denied / 待处理数归零 / 终端审批结果行 | [t6_approval_denied.png](screenshots/t6_approval_denied.png) |
| T7 审批批准 | 卡片 approved / 待处理数归零 / 终端审批结果行 | [t7_approval_approved.png](screenshots/t7_approval_approved.png) |
| T8 原生窗口 | **真实 Tauri/WKWebView 窗口**（屏幕录制授权后补验）：CLI 种入的主机出现在列表、审计时间线读真实 vault（`#1 host_upsert human`） | [native_window.png](screenshots/native_window.png) |

演示 shim 的简化见 §6.1-12；核心语义（作废/不可复活/重确认门槛）以自动化测试为准。SPIKE-1 基准随仓结果：[evidence/spike1-ipc-result.json](evidence/spike1-ipc-result.json)。

### 5.4 真实 app 走查（T9）与 GUI 可用性修复（v1.2）

**T9 是本轮新增的硬性 gate：必须在真实 Tauri app 里完成"真实 SSH 连接 → 真实 shell"，浏览器演示模式证据不再计入交互验收。**

动机：v1.1 的 T1–T8 暴露了验收盲区——视觉走查全部跑在 demo 假数据上，"点连接 → 真实 SSH 终端 → 打字"从未在真实 app 里被走过一次。用户实测反馈证实了这一点（见下）。本轮修复后以 CGEvent 注入点击完成真实走查：

| 步骤 | 内容 | 结果 | 证据 |
|---|---|---|---|
| T9-a 重建首屏 | 重启 app：添加主机入口、主机卡带认证类型、空状态引导文案、终端三步使用说明 | 通过 | [t9_native_rebuild_home.png](screenshots/t9_native_rebuild_home.png) |
| T9-b 真实 SSH | 原生窗口点击 e2e-sshd「连接」→ 真实 OpenSSH 容器会话建立：会话卡"已连接"、简报读到真实 cwd（/root）、审计 `#16 shell_integration_inject` / `#17 session_created`。该截图同时暴露了集成回显污染首屏（见下方修复清单） | 通过 | [t9_native_real_ssh_session.png](screenshots/t9_native_real_ssh_session.png) |

修复后首屏以回归测试 `create_session_screen_is_clean` 为准（原生截图在修复复验时因系统屏幕会话状态变化暂不可用；截图能力恢复后可按 §7 重拍）。

走查中发现并修复：

- **read_screen 混入 scrollback（根因级）**：`read_screen` 用的是含 scrollback 的整缓冲渲染；前端 attach 时把整个快照重灌进 xterm，把清屏后的干净画面重新覆盖成"MOTD + 集成回显"。修复：`read_screen` 改为可见屏渲染（`screen_only_text`）；语义回归测试 `create_session_screen_is_clean` 断言首屏既无注入回显也无 scrollback 泄漏。简报的 `screen_tail_summary` 取尾部语义不变。
- **集成注入回显污染首屏**：注入的 OSC133 集成命令被远端 PTY 回显。修复：注入行尾追加 `printf '\033[2J\033[H'` 清屏（shell 内建，不依赖外部 clear；Screen 与前端 xterm 均支持 2J）。
- **终端打字完全无效**：`term.onData` 闭包捕获首渲染时的 `sid=null` 且初始化 effect 不会重跑——打字从未送达。修复：onData 改走 `sidRef`。

**用户第二轮实测再暴露两个问题，均已在原生窗口用 CGEvent 全流程复现并修复（v1.3，c17b601）**：

- **实时输出流不渲染（根因级）**：Tauri Channel 投递的 ArrayBuffer 直接 `term.write()` 在 WKWebView 下静默不渲染；而字符串写路径（快照/横幅/回显）正常——表现为"命令后端执行成功（审计 exit 0）但终端永远无输出、无回显"。探针链定位：简报"屏尾"证明后端 Screen 有输出 → 标题"流:N/hex"证明 Channel 有投递且字节完好 → 终端无渲染，锁定前端二进制写路径。修复：Channel 字节经有状态 `TextDecoder` 解码为字符串再写（顺带处理 UTF-8 跨块分割）。修复后在原生窗口全流程复验：输入框执行 `ls` → 命令回显、输出、新提示符全部渲染，与后端 Screen 一致。
- **布局滚动**：`.layout`/`.col`/`.term-wrap` 补 `overflow:hidden`，grid 列宽改 `minmax`；窄窗口下列宽收缩而非溢出，页面不再滚动（Tauri 侧已有 minWidth 960）。
- UI 保留一个常驻诊断探针：简报「屏尾」（后端 Screen 末尾摘要；v1.4 移除标题「流:N」探针，流路一致性改由自动化走查承担）。

**GUI 可用性 P0 修复清单**（用户首轮实测反馈驱动，全部改动限于 `ui/`，核心层零改动）：

1. 添加主机表单（密码 / 私钥粘贴，接 `upsert_host` + `create_identity`）——此前唯一入口是 CLI；
2. 连接状态机：连接中禁用按钮、失败给出可读原因（认证失败/超时/拒绝对应中文提示+原始错误）、成功自动 attach 并聚焦；
3. 会话状态徽标（已连接/中断/重连中/重确认）+ 3s 轮询 + 断开按钮（接 `close_session`）；
4. 终端尺寸自适应 + PTY resize 对齐；
5. 文案清理：控制权无 Agent 时显示"手动"、MCP 面板空状态改为接入指引、命令框 placeholder 标明执行位置、审批"编辑后批准"改为卡片内联编辑（原 `window.prompt` 在 WKWebView 不可用）。
6. 测试统计更新为 **45 个自动化测试**（新增 `create_session_screen_is_clean`）。

演示模式 shim（demo.ts）同步扩展：支持 upsert_host/create_session 失败注入/close_session/resize，浏览器走查与真实 UI 保持同一代码路径。

### 5.5 标准终端交互（T10，v1.4 新增）

**动机**：用户第三轮实测反馈「top 后都不能 Ctrl+C 停止……不像一个正常的 ssh client」。基础终端交互（控制键、全屏程序、复制粘贴）是 SSH 客户端的底线能力，升级为 T10 gate。

**根因分析（四层证据链逐段排除）**：

1. **核心/传输层直通无误**（headless 回归 `send_keys_ctrl_c_interrupts_foreground_process`）：`send_keys("\x03")` → `LocalPtyChannel::write` 原样字节 → PTY ISIG → SIGINT 打断前台 `sleep 60` → shell 集成块闭合 → 后续 `exec` 正常返回。若中断失效该测试必以 ExecTimeout 失败。
2. **WebKit 引擎层按键映射无误**（Playwright WebKit + 应用同构建 `@xterm/xterm 5.5`，12/12）：Ctrl+C→`\x03`、Ctrl+D/L/Z、↑↓→`ESC[A/B`、Esc、Tab、Home/End 全部正确编码进 `onData`；裸 ⌘ 组合零输出（不会把 ⌘ 当 ESC 前缀发进 PTY）。
3. **第一层真因：焦点/affordance**——终端焦点丢失后控制键无处可去（焦点留在命令框时 Ctrl+C 是普通输入框里的无效按键），且旧 UI 无任何兜底 affordance。
4. **第二层真因（用户原生窗口实测发现）：中文输入法吞掉 Ctrl 组合键**。终端内注入真实 Ctrl+C 后 `top` 不退、弹出拼音候选窗；临时探针把 keydown 事件写进终端画面，抓到决定性证据：**`key="c" code=KeyC kc=229 ctrl=0 meta=0 alt=0 comp=1` + compositionstart**——搜狗输入法在 WKWebView 的 textarea 里把 Ctrl+字母送进拼音组合，事件到达 DOM 时 **ctrl 修饰标志已被剥除**（keyCode 恒为 229），任何 JS 层修复都无法区分「Ctrl+C」和「拼音组合里的 c」（若把 229 事件按 Ctrl+C 处理会毁掉中文输入）。这是 WebKit+CJK IME 的平台级缺口（WebView 类终端在 Safari 系内核上的通病）。

**修复清单（v1.4）**：

| # | 修复 | 位置 |
|---|---|---|
| 1 | **native 层 Ctrl 键接管（macOS，根因级）**：NSEvent local monitor 在 IME 之前看到原始事件（修饰键完整）；终端聚焦时按虚拟键码表编码 C0 控制字符（a-z/[]\/空格/2-8 等与真实终端同表）直发 `send_keys` 并**吞掉事件**（IME 与 WebKit 都不再看到）；⌘/⌥ 不劫持；block 体 catch_unwind 兜底（ObjC block 不能 unwind，panic 即放行事件绝不 abort） | src-tauri/main.rs |
| 2 | **聚焦状态上报**：xterm textarea focusin/focusout + attach/detach 经 `note_terminal` 命令同步给 native 层，命令框等输入控件不受劫持（保留 Ctrl+A/C 编辑语义） | App.tsx + main.rs |
| 3 | 键盘保真：`attachCustomKeyEventHandler` 只拦 ⌘ 组合（⌘C 复制选中/⌘V 粘贴/⌘A 全选，其余 ⌘ 吞掉防误触刷新），Ctrl 系/方向键/Esc/Tab/F 键原样进 PTY（非 macOS 平台兜底） | App.tsx |
| 4 | 命令框兜底：空输入时 Ctrl+C = 向会话发 `\x03` 中断前台程序；有输入时清空输入行（常规惯例）；exec 发送后**立即**回焦终端（不等执行完成，长驻命令也可即时中断） | App.tsx |
| 5 | 终端区域（含空白处）点击即聚焦；scrollback 5000；欢迎页写明控制键/⌘C⌘V 用法 | App.tsx |
| 6 | **⌘C/⌘V 剪贴板走 Tauri 原生插件**（tauri-plugin-clipboard-manager + capabilities 授权）——`navigator.clipboard.readText` 在 WKWebView 会弹"Paste"授权气泡，原生插件无气泡 | App.tsx + main.rs + capabilities |
| 7 | 移除「流:N」诊断探针；demo 模式 `listen()` 门控修复；~~连接即对齐 PTY 尺寸~~（**回滚**：create 后立即 resize 的 window-change 会打断远端注入回显时序，造成远程首屏残留，attach 时 fitTerminal 对齐已足够） | App.tsx |

**T10 走查矩阵**（原生窗口 CGEvent 注入，全部通过；最终构建复核后入档）：

| 步骤 | 内容 | 结果 | 证据 |
|---|---|---|---|
| T10-a | 本机会话：终端直接打字跑 `top`，全屏渲染正常（进程表/替代屏） | 通过 | [t10_a_local_top.png](screenshots/t10_a_local_top.png) |
| T10-b | 终端内真实 Ctrl+C → top 退出回提示符（无 IME 弹窗、无杂字符） | 通过 | [t10_b_native_ctrlc.png](screenshots/t10_b_native_ctrlc.png) |
| T10-c | `echo T10-OK-42` 输出正确；↑ 历史召回重跑 | 通过 | [t10_c_echo_history.png](screenshots/t10_c_echo_history.png) |
| T10-d | 命令框跑 `top`（审计 `top → exit 0`）→ 命令框空输入 Ctrl+C → top 退出（用户原始场景闭环） | 通过 | [t10_d_box_interrupt.png](screenshots/t10_d_box_interrupt.png) |
| T10-e | `vim /tmp/t10.txt` 全屏开 → 插入文本 → Esc → `:wq` 保存退出 → `cat` 验证内容 | 通过 | [t10_e_vim.png](screenshots/t10_e_vim.png) |
| T10-f | 远程 e2e-sshd（真实 OpenSSH）：连接 → busybox top → Ctrl+C → 退出回提示符 | 通过 | [t10_f_remote_top.png](screenshots/t10_f_remote_top.png) / [t10_f_remote_ctrlc.png](screenshots/t10_f_remote_ctrlc.png) |
| 复核 | 回滚早创建 resize 后以最终构建全流程重跑（top+Ctrl+C） | 通过 | [t10_final_regress.png](screenshots/t10_final_regress.png) |

**T10 判定：通过**（46 个自动化测试全绿 + 原生六步走查全过；四层根因链——核心字节路径、引擎按键映射、焦点 affordance、IME 平台缺口——均有独立证据与对应修复）。

### 5.6 多会话体验（T11，v1.5 新增）

**动机**：用户明确「更加关心用户的使用体验」。UX 优先级重排后的第一项：**会话切换丢滚动历史**——旧架构全局只有一个 xterm 实例，每次 attach 都 `term.reset()` + 重灌当前屏快照，在两个会话间来回切换会把各自的滚动历史全部抹掉；vim 等全屏程序状态同样丢失。多会话是「工作台」的基本场景，升级为 T11 gate。

**改造（仅前端，`ui/src/App.tsx` + `styles.css`，核心层零改动）**：

| # | 改动 | 说明 |
|---|---|---|
| 1 | **每会话一个独立 xterm 实例**（`termsRef` Map）：切换 = 显示/隐藏（`.term-session.active`），不做任何 reset/快照重灌——滚动历史、vim 备用屏、选中状态原地保留；输出订阅按会话常驻（隐藏的会话也在实时累积输出） | 根因级修复 |
| 2 | 首次接入才回填 `read_screen` 快照 + 接入横幅；此后切换不重灌 | 断点续接语义 |
| 3 | 断开/关闭会话时 dispose 对应实例；其余会话终端保留 | 资源管理 |
| 4 | 欢迎页由「写进终端」改为独立 HTML 层（无会话时显示，接入即隐藏），文案更新（多会话切换提示） | 渲染层 |
| 5 | **⌘1–9 快速切换到第 N 个会话**（捕获阶段拦截，终端聚焦时也生效）——终端应用标配 | 新功能 |
| 6 | 会话卡片键盘可达（`tabIndex` + Enter/Space 激活） | 无障碍 |
| 7 | dev harness：`TINYSSH_AUTOCONNECT=host_id[,host_id]` 启动即建会话（env 门控，走查用；与 TINYSSH_BENCH 同模式） | src-tauri/main.rs |

**T11 走查矩阵**（原生窗口，双会话 = 本机 PTY + 远程 e2e-sshd 真实 OpenSSH；接入经 ⌘1/⌘2 与键盘）：

| 步骤 | 内容 | 结果 | 证据 |
|---|---|---|---|
| T11-a | 欢迎页 HTML 化渲染 + 双会话列表（本机/e2e-sshd 均「已连接」） | 通过 | [t11_welcome.png](screenshots/t11_welcome.png) |
| T11-b | ⌘1 接入本机：快照回填 + 横幅；⌘V 粘贴执行 `echo T11-A-history-1/2 && uname -a`，输出与审计（命令 human → exit 0）正常 | 通过 | [t11_a_local_hist.png](screenshots/t11_a_local_hist.png) |
| T11-c | ⌘2 接入远程：busybox sh 提示符；粘贴执行 `echo T11-B-remote-1 && hostname`，输出正确 | 通过 | [t11_b_remote_hist.png](screenshots/t11_b_remote_hist.png) |
| T11-d | **切回 ⌘1**：A 的完整历史原样保留（命令行、两行输出、uname、提示符位置），命令框/简报跟随切回 | 通过 | [t11_c_switch_back_local.png](screenshots/t11_c_switch_back_local.png) |
| T11-e | **切回 ⌘2**：B 的历史同样保留（对称验证） | 通过 | [t11_d_switch_back_remote.png](screenshots/t11_d_switch_back_remote.png) |
| T11-f | A 内开 vim 全屏 → ⌘2 → ⌘1 往返：vim 欢迎屏/备用屏**原样保留**（旧架构必然丢失） | 通过 | [t11_e_vim.png](screenshots/t11_e_vim.png) / [t11_f_vim_kept.png](screenshots/t11_f_vim_kept.png) |
| T11-g | Esc + `:q!` 干净退出 vim，备用屏恢复、滚动历史无缺；`top` + 原生 Ctrl+C 中断回提示符（**T10 修复无回归**） | 通过 | [t11_g_ctrlc_regress.png](screenshots/t11_g_ctrlc_regress.png) |

Playwright WebKit（同一 UI 代码路径，demo 模式）复核：无页面错误、会话卡点击 → xterm 实例创建正常。

**T11 判定：通过**（46/46 回归全绿 + 原生走查矩阵全过）。走查期间的两个观察如实记录：合成鼠标事件对 WKWebView 几乎不送达（走查工具层限制，键盘注入正常；真实用户鼠标不受影响）→ 鼠标上报（htop/tmux 点击滚轮）列为待真人验证项（§6-16）；首轮走查曾观察到一次「静默重连重注入回显泄漏」（集成片段明文进屏，本轮复走未复现）→ 记 P1 待专项复现与修复（§6-17）。

### 5.7 右栏协作面板人话化（T12，v1.6 新增）

**动机**：用户第四轮实测反馈「右侧的侧边栏信息乱糟糟的，不像是给用户看的」。走查确认右栏实为开发调试视图：空审批队列占大段引导文案；现场简报重复渲染五条一模一样的「命令（human）[Confirmed] → exit 0」（命令文本为空）+ 屏尾调试 dump（内核线程名等杂讯）；操作时间线显示原始事件名（`session_created`/`shell_integration_inject`/`OSC133+OSC7`）与审计序号，无时间戳。

**根因修复（本轮唯一的后端改动）**：简报命令文本为空的根因是 `send_keys` 的 Human 分支直写 channel、未调 `register_outgoing`——B→C 键入捕获从不发生，人类键入的命令块 command 恒为空（Agent 分支反而有登记）。补上登记后，终端直接打字的命令文本进入简报与交接现场（`core-session/src/lib.rs`，1 处；46/46 回归全绿）。

**UI 改动清单**（`ui/src/App.tsx` + `styles.css`，信息架构重排）：

| 区块 | 旧（调试视图） | 新（用户视图） |
|---|---|---|
| 审批 | 恒占顶部的队列 + 空态大段文案；已处理卡整卡罗列 | 标题带「N 待处理」徽标；pending 卡保留完整操作；已处理折叠为「最近处理」小行（✓ 批准/✕ 拒绝 + 命令）；空态一行话 |
| 现场简报 | facts 逐条原文渲染（重复「命令（human）[Confirmed]」×6）+ 屏尾 dump | 人话重排：`当前目录 /root · 已核实`、`$ echo HI12 · 成功`（退出码翻成 成功/Ctrl+C 中断/退出码 N）、运行中/重确认警告着色、控制权一行；命令历史压到最近 2 条且清不出文本的行不显示；**屏尾调试 dump 移除**（§5.4 的常驻诊断探针至此全部下线，流路一致性由自动化走查承担） |
| 操作时间线（审计） | `#62 session_created 人类`、`OSC133+OSC7` 原始事件名 | 更名「操作记录」：每条一行 `HH:MM 我/Agent·opencode 连接主机/执行命令 <cmd>`；`shell_integration_inject` 内部管道事件不进用户视图（审计库原文仍可查）；未知动作原样回退 |

**T12 走查矩阵**（原生窗口 + demo 模式）：

| 步骤 | 内容 | 结果 | 证据 |
|---|---|---|---|
| T12-a | 原生：右栏三区重排（审批空态一行话 / 操作记录全中文带时间、无 OSC133 行） | 通过 | [t12_sidebar_native_local.png](screenshots/t12_sidebar_native_local.png) |
| T12-b | 原生：终端打字 `echo HI12` 执行 → 简报出现 `$ echo HI12 · 成功`（register_outgoing 修复端到端） | 通过 | [t12_sidebar_native_local.png](screenshots/t12_sidebar_native_local.png) |
| T12-c | 原生：e2e-sshd 会话简报 `当前目录 /root · 已核实`（无集成 ash 主机无命令块，属 §6-6 降级语义） | 通过 | [t12_sidebar_native_remote.png](screenshots/t12_sidebar_native_remote.png) |
| T12-d | demo（同 UI 代码路径）：pending 审批卡 + 「1 待处理」徽标 + 已处理折叠 + Agent 操作记录行 | 通过 | [t12_sidebar_demo.png](screenshots/t12_sidebar_demo.png) |

**T12 判定：通过**（46/46 回归全绿 + 走查矩阵全过）。走查工具层附带发现并修复：CGEvent 组合键（⌘N）只发字符键 down/up、从不发修饰键抬起——系统 ⌘ 态残留导致后续注入字符全部带 ⌘（⌘1/⌘2 误触发会话切换、其余字符被 ⌘ 处理器吞掉）；这正是 v1.5 走查中「焦点考古反复失准」的真因。助手脚本已改为组合键前后显式抬修饰键；该问题属走查工具层，产品无此问题（真实键盘修饰键由系统管理）。

### 5.8 断线一键重连闭环（T13，v1.7 新增）

**动机**：UX 路线图（§6-18）第①项。会话一旦断开（本地 shell 退出 / SSH 断线且自动重连 3 次失败）即成死端——pump 循环退出后无任何恢复路径，用户只能删会话从主机卡重连，滚动历史与会话身份全部丢弃。§6-13 记录的死端问题在本轮闭环解决。

**实现**（三层）：

| 层 | 改动 | 说明 |
|---|---|---|
| `transport-pty` | `reconnect()` 从 no-op 改为真重启 shell（spawn 逻辑重构为 `respawn()`） | 本地「重连」= 新 PTY + 新 shell 进程；**输出并入同一 broadcast**——重连后泵与 UI 既有订阅无需更换（单测 `transport-pty/tests/reconnect.rs` 固化该契约） |
| `term-core` | `reset_integration_tracking()`（saw_133 粘滞重置）+ `prompt_ready()`（B 标记就绪信号）+ 新增 `saw_prompt` 跟踪 | P1 §6-17 根因修复，见下 |
| `core-session` | `SessionManager::reconnect_session(sid)`：仅 Disconnected 可触发（Reconnecting 中防重入）→ 先订阅 → `channel.reconnect()` ≤3 次 → 失败回 Disconnected 并报错（可再试）→ 成功则 `reset_scene_after_reconnect()`（**残留 open block 强制收尾** + 集成标记重置 + cwd 降级）→ 重启 pump → SSH 走 `reinject_integration`（等 `prompt_ready`）/ 本地直接进 Reconfirming → 审计 `session_reconnect` | 重连是人的基础设施动作，**不在 SessionApi/MCP 面**（GUI 人类专用；Agent 重连语义留 V1）；SSH 原地重连保留 TOFU 指纹 |
| UI | Disconnected 会话卡「重连」按钮（重连中禁用防抖）→ 成功自动接入该会话；失败走友好错误横幅 | 操作记录新增「重连会话」中文标签；会话卡状态行 nowrap 防折行 |

**P1 §6-17 重连重注入回显泄漏——根因确认并修复**：`saw_133` 一旦置位永不重置，导致 ① 重注入的就绪等待形同虚设（旧连接的标记让等待立即放行，新 shell 未必就绪）；② 就绪信号选错了标记——片段清屏行的 **C 标记先于清屏字节**执行，只等 C 会截到清屏前的注入回显尾巴（v1.5 观察到的「集成片段明文进屏」与此吻合）。修复：重连成功先 `reset_integration_tracking()`（顺带强制收尾残留 open block——旧 shell 已死永不闭合，不收尾则后续 shell exec 全部等块空闲超时）；重注入等待改为 `prompt_ready()`（**B 标记** = 片段跑完、屏已清、提示符已出）。journey4 在**键入一半（未闭合引号）的脏状态**下重启容器复现验证：重连后屏面无注入片段明文、shell exec 立即可用、半截命令未被执行。

**附带修复**：bash 将 PS0/PS1 的 `\[`/`\]`（readline 忽略标记）展开为 `\x01`/`\x02` 随输出进入 exec 捕获——MCP/UI 消费者的输出头部带不可见噪音（既有问题，此前测试全用 contains 断言未暴露）；`run_shell` 输出清洗统一剥离。

**T13 走查矩阵**（原生窗口；本地 = PTY shell，远程 = e2e-sshd 真实 OpenSSH；断线均为真实发生非模拟）：

| 步骤 | 内容 | 结果 | 证据 |
|---|---|---|---|
| T13-a | 本机终端键入 `exit` → shell 真实退出 → 卡片 3s 内转「已断开」+「重连」按钮；简报 cwd 降级「需复核」 | 通过 | [t13_local_dead.png](screenshots/t13_local_dead.png) |
| T13-b | 点「重连」→ 卡片转「重确认（受限）」；新 shell 提示符出现且**滚动历史保留**；简报出现 `$ exit · 已结束（退出码未知）`（残留块诚实收尾）+「手动重连：重建连接」；操作记录「我 重连会话」 | 通过 | [t13_local_reconnected.png](screenshots/t13_local_reconnected.png) |
| T13-c | 新 shell 键入 `echo T13-LOCAL-RECONNECT-OK` → 输出正常（重连后现场可用） | 通过 | [t13_local_reconnected.png](screenshots/t13_local_reconnected.png) |
| T13-d | `docker stop tinyssh-e2e` → 自动重连 3 次失败 → 远程卡「已断开」+「重连」按钮（真死端） | 通过 | [t13_remote_dead.png](screenshots/t13_remote_dead.png) |
| T13-e | `docker start` 后点「重连」→ 「重确认（受限）」→ `echo T13-REMOTE-RECONNECT-OK && hostname` → 输出正常（容器主机名） | 通过 | [t13_remote_reconnected.png](screenshots/t13_remote_reconnected.png) |
| T13-f | 简报控制权行显示最新变迁「重连成功，进入重确认」（发现 UI 取最旧一条的显示缺陷并当场修复）；会话卡状态行 nowrap | 通过 | [t13_final_layout.png](screenshots/t13_final_layout.png) |

**自动化新增 4 项**（全量 50/50 绿）：`transport-pty/tests/reconnect.rs`（PTY 重连同 broadcast 契约）、`core_local::local_session_manual_reconnect`（死端→重连→重确认→核实恢复全链路 + 防呆：未断开不可重连）、`e2e_acceptance::journey3_manual_reconnect_after_hard_down`（docker stop 超过自动重连窗口 → Disconnected → start → 手动重连 → 审计断言；Drop guard 保证任何退出路径容器被拉起）、`journey4_reconnect_with_dirty_typing_state`（P1 复现矩阵，见上）。

**T13 判定：通过**（50/50 回归全绿 + 原生走查矩阵全过 + P1 §6-17 根因修复附复现实证）。如实披露：重连成功 ≠ 现场延续——本地/远程重连均为新 shell（显示历史 ≠ 现场），cwd/env 事实降级、进重确认门，与 PRD「显示历史 ≠ 现场延续」语义一致。

**v1.7 补充（用户实测反馈：终端输出表格排版错乱）**：用户发现 `docker ps` 输出折行错乱（列名/数据在词中间断行）。探针定位（`stty size` + 170 字符单线测宽 + `$COLUMNS` 对照）：resize 链路（窗口 → ResizeObserver → fitTerminal → PTY）本身通畅，失配属**某些时序下丢一次 resize 且无对账**（attach 首测撞上渲染器尺寸未就绪时用 9px 兜底值算错列数等）。修复三件：① fitTerminal 渲染器尺寸未就绪时等一帧重测（上限 5 次）替换静默兜底；② attach 后 350ms 二次校准（布局/字体稳定后）；③ **3s 轮询终端尺寸对账**——以 xterm（用户所见）为权威单向校正后端，任何一环丢掉的 resize 在 3s 内自动收敛。实测两档窗口宽度（1280→99 列、1512→106 列）PTY 均跟随，`$COLUMNS` 与 stty 一致。

### 5.9 Alt/Option 键支持（T14，v1.8 新增）

**动机**：UX 路线图（§6-18）第②项。macOS 终端惯例 Option=Meta（readline 词跳转、tmux M-键绑定），但此前 ⌥字母 被 WKWebView 文本输入系统转成特殊字符（⌥b=∫）直插终端，⌥方向键 发送修饰参数形式（`\x1b[1;3D`）readline 不识别——词跳转/删词/tmux meta 键全部不可用。

**实现**（UI 捕获层 + 一处后端过滤）：

| 层 | 改动 | 说明 |
|---|---|---|
| `ui/src/App.tsx` | window 捕获层新增 Option 分支（与既有 Ctrl 接管同层同模式）+ `altMetaSequence` 键位解码 | 拦截层选择有实证：先实现于 xterm `attachCustomKeyEventHandler`，⌥← 生效但 **⌥b/⌥f 失效**（⌥字母 进 WKWebView 文本输入系统，xterm 层 keydown 收不到，实测插入 ∫）——Ctrl 接管当初选 window 捕获层正是为此；挪层后全部生效。解码按物理键位 `ev.code`（⌥字母 的 `ev.key` 是特殊字符不能当目标）：⌥←/⌥→ → `\x1bb`/`\x1bf`（readline 词跳转）、⌥⌫ → `\x17`（werase 删词）、⌥⌦ → `\x1bd`、⌥↑/⌥↓ → `\x1b[1;3A/B`（tmux）、⌥字母/数字/常用符号 → ESC 前缀通用 meta（M-b/M-f/M-1-9…）；⌘+⌥、Ctrl+⌥ 不接管归原分支 |
| `core-session` | `send_keys` Human 分支：含 `\x1b` 的键入块只写 PTY、不做键入登记 | meta/导航序列不是命令文本——此前 `\x1bb` 裸 ESC 后的 'b' 残留进简报（实测 `$ echo … dddbZ`）；回归测试 `human_meta_sequence_not_registered_as_command_text` 固化 |

**T14 走查矩阵**（原生窗口；本地 = zsh PTY，远程 = e2e-sshd 真实 OpenSSH bash；CGEvent 注入 alt 修饰位；判据 = 补字符落点，不依赖光标闪烁相位）：

| 步骤 | 内容 | 结果 | 证据 |
|---|---|---|---|
| T14-a | 本机：`echo aaa bbb ccc ddd` → ⌥← ⌥← → Z ⏎ | 执行行 `echo aaa bbb Zccc ddd`（Z 落 ccc 词首，两次各回一词） | [t14_local_wordjump.png](screenshots/t14_local_wordjump.png) |
| T14-b | 本机：`echo kkk lll mmm` → ⌥b ⌥f → Z ⏎ | `kkk lll mmmZ`（回一词前进到词尾，通用 meta 生效） | [t14_local_meta_keys.png](screenshots/t14_local_meta_keys.png) |
| T14-c | 本机：`echo eee fff ggg` → ⌥⌫ → Z ⏎ | `eee fff Z`（werase 删一词） | [t14_local_werase.png](screenshots/t14_local_werase.png) |
| T14-d | Ctrl+C 回归：`sleep 30` ⏎ → Ctrl+C | `^C` 即回提示符（拦截层改动无回归） | [t14_local_ctrlc_regression.png](screenshots/t14_local_ctrlc_regression.png) |
| T14-e | e2e-sshd：`echo mmm nnn ooo` → ⌥← ⌥← → W ⏎ | `mmm Wnnn ooo`（SSH bash 词跳转端到端） | [t14_remote_wordjump.png](screenshots/t14_remote_wordjump.png) |
| T14-f | 简报命令文本：同款 ⌥← 操作 | `$ echo aaa bbb ccc dddZ · 成功`（'b' 杂讯消失；修复前同操作显示 `dddbZ`） | [t14_local_wordjump.png](screenshots/t14_local_wordjump.png) |

**T14 判定：通过**（51/51 回归全绿 + 走查矩阵全过）。如实披露：① Option-as-Meta 生效后 macOS 特殊字符（é/∫ 等）无法再经 ⌥字母 键入——与 Terminal.app「Use Option as Meta key」同语义，属终端惯例取舍；② 中文 IME 激活时 ⌥字母 行为未测（注入不经过 IME 组合，同 §6-14 边界）；③ tmux M-键未实测（容器无 tmux），通用 meta 转发由 ⌥b/⌥f 证实；④ 走查工具层附带发现：长跑多轮 HMR 的 app 实例 CGEvent 点击会失灵（键盘注入不受影响）——冷启动实例正常，属环境问题非产品缺陷。

### 5.10 鼠标上报实测（路线图③，v1.8 补充）

**背景**：§6-16 自 v1.5 起列为待真人验证项——T11 走查发现合成鼠标事件送不进 WKWebView，无原生证据。T14 轮发现**冷启动实例的 CGEvent 点击可达**（会话卡/终端聚焦点击均生效），原生验证得以完成。

**证据链**（链路：应用开 tracking（DECSET 1002+1006）→ xterm 编码 SGR → onData → send_keys → PTY → 应用响应）：

| 环节 | 验证方式 | 结果 |
|---|---|---|
| 端到端：点击 → vim 光标跳转 | 原生窗口 `vim -u NONE -c 'set mouse=a'`，CGEvent 点击 buffer 内 "charlie" 一词 → 光标跳到命中字符 → `rZ` 替换 → `:wq!` → `cat` | 文件变为 `alpha bravo chaZlie …`——**Z 恰好替换点击命中的字符**（[t15_vim_mouse_click.png](screenshots/t15_vim_mouse_click.png)） |
| 编码层：点击/滚轮 SGR 报文 | Playwright WebKit + **应用同一 xterm 构建**（T10 方法），DECSET 1002+1006 后 `page.mouse` 点击/滚轮，断言 onData | **4/4**：`\x1b[<0;12;4M`/`m`（按下/抬起）、`\x1b[<65;…M`/`\x1b[<64;…M`（滚轮下/上） |
| 投递层：真实输入 → WKWebView | 点击：CGEvent 点击可达（本轮多处实证）；滚轮：CGEvent 滚轮不送达——光标显式置于终端中央重试 + `:set mouse=`（关 vim 鼠标后 xterm 应滚 scrollback）双重确认仍不动 | 点击 ✓；滚轮注入不可达属**走查工具层限制**（真实滚轮由 macOS 平台投递），真人顺手确认即可 |

**判定：路线图③通过**（点击原生端到端实锤 + 滚轮编码层验证 + 投递层由平台保证）。如实披露：tmux/htop 场景未实测（容器无 tmux、macOS 无 htop），链路与 vim 同为字节通路。

**走查工具层新知**：「合成鼠标几乎不送达」（T11）细化——**点击在冷启动实例可达，滚轮（CGEventCreateScrollWheelEvent）始终不可达**；此前 vim 滚轮无反应即此（与 vim 编码无关，事件根本没进 WebView）。

### 5.11 ⌘F 搜索 / OSC8 链接 / 窗口标题（T16，v1.9 新增）

**动机**：UX 路线图（§6-18）第④项——终端搜索、链接识别、窗口标题是「正常 SSH client」的标配三件。

**实现**：

| 特性 | 改动 | 说明 |
|---|---|---|
| ⌘F 终端内搜索 | @xterm/addon-search 0.14 + 右上角悬浮搜索框（`ui/src/App.tsx` + `styles.css`） | ⌘F 打开、输入增量高亮、⏎/⇧⏎ 下一个/上一个、Esc 关闭回焦点、N/M 计数；活动匹配琥珀色、其余蓝灰 + overview ruler |
| OSC8/URL 链接 | @xterm/addon-web-links 0.11（裸 URL 正则）+ Terminal `linkHandler`（OSC 8 激活）+ 新 Tauri 命令 `open_url` | 链接虚线下划线渲染；点击经 `open <url>` 走系统默认浏览器；**scheme 白名单仅 http/https**（防 file:// 等被外部处理器利用） |
| 窗口标题 | `getCurrentWindow().setTitle("<主机> — TinySSH")` + xterm `onTitleChange` 进终端头部 | macOS 标题栏随会话切换；远程 OSC 0/2 标题显示为头部「标题」标签 |

**三处静默失效根因**（本轮流查逐一暴露并修复，均为集成层缺口）：
1. **allowProposedApi 未开**：SearchAddon（registerDecoration）与 WebLinksAddon（registerLinkProvider）都是 proposed API——不开则 addon 装载即抛错、全部静默失效（Playwright harness 暴露 `You must set the allowProposedApi option`）。
2. **OSC 8 激活缺 linkHandler**：xterm 5.5 核心自带 OSC 8 渲染（虚线下划线）与默认激活器，但不设 `linkHandler` 时点击走 `confirm()` 对话框；且 addon-web-links 0.11 是纯正则 URL 检测、**不处理 OSC 8**——两条路径须分别接线。
3. **窗口 setTitle 缺 capability**：Tauri 2 权限模型需 `core:window:allow-set-title`，缺失时 setTitle 静默 reject（Promise 被吞，标题恒为配置值）。

**T16 走查矩阵**（原生窗口 + Playwright WebKit 引擎层；视觉验证 = 每项特性截图逐项检查布局与样式后入档）：

| 步骤 | 内容 | 结果 | 证据 |
|---|---|---|---|
| T16-a | ⌘F 面板视觉：右上角悬浮、聚焦蓝框、↑↓✕ ghost 按钮、圆角阴影 | 通过（不遮内容主区，风格与设计语言一致） | [t16_search_panel.png](screenshots/t16_search_panel.png) |
| T16-b | 搜索高亮 + 计数：搜 "MARKER item 017" → 琥珀活动高亮 + 视口自动滚动 + 计数 1/1 | 通过 | [t16_search_match.png](screenshots/t16_search_match.png) |
| T16-c | 多匹配导航：搜 "MARKER"（31 处）→ ⏎ 19/31→20/31、⇧⏎ 回 19/31 | 通过 | [t16_search_panel.png](screenshots/t16_search_panel.png) |
| T16-d | 链接渲染：OSC 8 输出 "Open Dev Server" → 虚线下划线样式 | 通过 | [t16_osc8_link.png](screenshots/t16_osc8_link.png) |
| T16-e | 引擎层链接激活（Playwright + 应用同一构建 + 真实输入事件）：OSC 8 经 linkHandler、裸 URL 经 addon，handler 各收到正确 URL | 通过（2/2） | 走查记录 |
| T16-f | 原生端到端：点击 "Open Dev Server" → 系统默认浏览器打开 127.0.0.1:5183 | 通过 | [t16_osc8_browser_open.png](screenshots/t16_osc8_browser_open.png) |
| T16-g | 窗口标题随会话切换：attach e2e-sshd → "e2e-sshd — TinySSH"；⌘2 切本机 → "本机 — TinySSH" | 通过 | [t16_window_title_remote.png](screenshots/t16_window_title_remote.png) / [t16_window_title_local.png](screenshots/t16_window_title_local.png) |
| T16-h | 远程 OSC 标题：`printf '\033]0;my-remote-title\007'` → 头部出现「MY-REMOTE-TITLE」（panel-title 大写风格） | 通过 | 走查记录 |

**T16 判定：通过**（51/51 回归全绿 + 走查矩阵全过 + 每项视觉验证入档）。如实披露：① 链接安全依赖 scheme 白名单 + 浏览器侧常规防护，V0 不做域名警示（终端链接钓鱼属行业共性课题，V1 可加悬停域名预览）；② 搜索计数依赖 decorations——`onDidChangeResults` 仅在 decorations 启用时上报，不配则恒 0（会误显「无结果」），已在 `SEARCH_OPTS` 固化；③ 走查期间多次遇到「新实例 attach 后键盘暂死」环境级 flake（demo 模式同代码打字正常、DOM 输入活、后端 Ctrl 探针活，焦点探针显示 textarea 已聚焦——病灶疑在 WKWebView 键盘事件投递时序；T9–T15 真实人工使用未复现），以加长初始化等待规避，不阻塞验收。

### 5.12 主机指纹首连确认 + 变更警告（T17，v1.10 新增）

**动机**：UX 路线图（§6-18）第⑤项——TOFU（Trust On First Use）是 SSH 客户端的安全底线：旧实现仅进程内存 TOFU（重启即忘、无人工确认），首连静默信任任意指纹，指纹变更直接拒绝且无解释。

**实现**：

| 层 | 改动 | 说明 |
|---|---|---|
| vault 持久化 | `hosts.host_fingerprint` 列（**V2 迁移**，user_version 1→2）+ `host_fingerprint()` / `set_host_fingerprint()` | 信任记录跨进程/跨重启；仅在人类确认后写入 |
| transport-ssh | `HostKeyCheck` 改 **async** 回调（人类确认可跨秒级等待）；指纹格式改 `SHA256:...`（OpenSSH 标准形）；指纹不符路径也走回调（变更告警流程）；`establish` 解包 Api 错误原样透传 | russh `check_server_key` 每连接一次；无回调（测试）保持全接受/不符拒绝语义 |
| core-session | `host_key_gate`：vault 已信任且一致→静默放行；无记录→**FirstSeen 确认**；不一致→**Changed 红色告警**。待决表 + oneshot 决策通道 + 事件推送（仿审批中心）；放行后指纹入库 + 审计 `host_key_confirm_requested` / `host_key_decision` / `host_key_trusted` | 超时 120s（复用 DEFAULT_APPROVAL_TIMEOUT）；拒绝/超时 → `Error::HostKeyRejected`（经 russh 透传为 create_session 错误）；闭包只捕获 ApprovalCenter（避免回指 SessionManager 的循环引用） |
| Tauri 壳 | 命令 `pending_host_keys` / `decide_host_key` + `hostkey-event` 推送 | 与审批事件同模式 |
| UI | 固定遮罩弹窗：FirstSeen 显示指纹 + 「信任并连接/取消」；Changed 红边框 + 新旧指纹对照 + 中间人警示 + 「我已核实，更新指纹并连接（danger）/拒绝连接」 | 待决队列按到达顺序逐个出示；`pending_host_keys` 启动拉取 + 事件去重入队 |

**自动化测试**（cargo，全绿）：
- `tinyssh-vault`：`host_fingerprint_tofu_roundtrip`——新主机无记录、确认入库、可更新、未知主机拒绝。
- `core-session`（e2e 守卫 `TINYSSH_E2E_SSHD=1` + 真实 sshd）：`host_key_gate_first_seen_change_and_reject` 三段式——① 首连 FirstSeen → 信任 → 连接成功 + 指纹入库；② 预置不一致旧指纹 → Changed + previous_fingerprint 正确 → **拒绝** → `HostKeyRejected` 且信任记录不被改动；③ 再次连接 → 接受 → 连接成功 + 指纹更新为服务器真实值。

**T17 走查矩阵**（原生窗口 + CGEvent 注入；视觉验证 = 每步截图逐项检查后入档；执行于 v1.10 当日）：

| 步骤 | 内容 | 结果 | 证据 |
|---|---|---|---|
| T17-a | 首连确认弹窗视觉：FirstSeen 卡片居中遮罩、主机/地址、指纹 mono 块（与服务器实际指纹一致）、「信任并连接/取消」 | 通过 | [t17_fingerprint_first_seen.png](screenshots/t17_fingerprint_first_seen.png) |
| T17-b | 信任后连接成功：新会话卡「已连接」、终端 prompt 可用、审计链 confirm→decision→trusted 完整、指纹入库（`SHA256:wD4pZq…`） | 通过 | [t17_fingerprint_trusted.png](screenshots/t17_fingerprint_trusted.png) |
| T17-c | **跨进程持久化**：重启 app 后再连同一主机 → **无弹窗静默连接**，审计仅「连接主机」无 confirm_requested | 通过 | [t17_fingerprint_silent_reconnect.png](screenshots/t17_fingerprint_silent_reconnect.png) / [t17_fingerprint_restart_clean.png](screenshots/t17_fingerprint_restart_clean.png) |
| T17-d | 变更告警视觉（预置不一致旧指纹触发）：红色边框 + 「⚠ 主机指纹已变更」+ 原指纹/新指纹对照 + 中间人警示加粗 + danger/ghost 双按钮 | 通过 | [t17_fingerprint_changed.png](screenshots/t17_fingerprint_changed.png) |
| T17-e | 拒绝路径 ×2：首连「取消」与变更「拒绝连接」均 → 红色横幅「主机指纹验证失败（用户拒绝连接）」、审计 decision(deny) 落盘、**信任记录不被改动**（sqlite 核实）；另附带实证「确认超时」路径（弹窗无人应答 120s → 横幅「主机指纹验证失败（确认超时）」） | 通过 | [t17_fingerprint_rejected.png](screenshots/t17_fingerprint_rejected.png) / [t17_fingerprint_change_timeout.png](screenshots/t17_fingerprint_change_timeout.png) |
| T17-f | 「我已核实，更新指纹并连接」→ 连接成功、sqlite 核实指纹恢复为服务器真实值、新会话可用 | 通过 | [t17_fingerprint_change_accepted.png](screenshots/t17_fingerprint_change_accepted.png) |
| T17-g | 审计时间线：host_key_confirm_requested / host_key_decision / host_key_trusted 与「连接主机」交替出现，四轮确认（首连信任、首连拒绝、变更拒绝、变更放行）全部留痕 | 通过 | [t17_fingerprint_change_accepted.png](screenshots/t17_fingerprint_change_accepted.png)（右栏审计全景） |

**T17 判定：通过**（53/53 回归全绿 + 走查矩阵 7/7 + 每步视觉验证入档）。如实披露：① 首轮走查（v1.10 前夜）的一次「信任」决定由当时在场的用户点击完成，次日以清库重演 + 全脚本化 CGEvent 注入完成可复现验证（07:36–07:39 四轮确认全部自动化）；② 走查期间桌面两次自动/手动锁屏导致中断，收尾脚本在解锁窗口内一次性完成，不影响结论；③ 变更告警的「拒绝」语义为**不改信任记录**（与 OpenSSH 已知主机行为一致），服务器合法换钥需人工核实后放行；④ 并发建连的多个指纹待决会排队逐个出示（V0 无合并视图）；⑤ **v1.11 勘误**：当轮「53/53」中 e2e_acceptance 因守卫缺省未真实执行，指纹门在 MCP e2e 流程中的应答缺口由 v1.11 修复并复绿（§5.13 披露②）。

### 5.13 字号 / 主题设置（T18，v1.11 新增）

**动机**：UX 路线图（§6-18）第⑥项——字号与配色是终端日用最高频的个性化需求；旧实现字号硬编码 13、配色单一。

**实现**：

| 层 | 改动 | 说明 |
|---|---|---|
| vault 持久化 | `settings` KV 表（**V3 迁移**，user_version 2→3）+ `get_setting()` / `set_setting()`（upsert） | 偏好跨进程/跨重启（与 T17 指纹同语义）；空值/缺行读作 None |
| Tauri 壳 | 命令 `get_setting` / `set_setting` | 管理面直连 vault（§6.9 既有先例） |
| UI 字号 | 终端标题栏「Aa」入口 → 显示设置面板；字号 −/＋/重置 + 快捷键 ⌘= / ⌘− / ⌘0；范围 9–28 | 全部会话即时生效（`term.options.fontSize`）；激活会话立即重算并同步 PTY；隐藏会话重新激活时校准（attachSession fit）；浏览器演示模式退化为 localStorage |
| UI 主题 | 4 个内置配色预设：深色（默认）/ 浅色 / Solarized 深色 / Solarized 浅色（xterm ITheme 全量含 ANSI 16 色） | 主题只作用于终端区域；界面 chrome 维持深色（亮色 chrome 需全站变量适配，属 V1 范围，如实披露） |

**两处既有缺陷在本轮走查中暴露并修复**（诚实披露，均非 T18 改动引入）：

1. **fitTerminal 从未生效（历史缺陷，v1.11 修复）**：xterm.js 5.5 无公开 `dimensions` 属性（那是 fork 的 API，恒 `undefined`），fit 静默重试 5 次后放弃——xterm 恒停在构造默认 **80×24**，3s 对账看门狗再忠实地把 PTY 也同步成 80×24。长期未暴露是因为默认 13px 下 80×24 恰好 ≈ 该容器的正确值，一切看起来正常；字号一改（16px 应得 ~75 列）PTY 仍 80 列，本轮以 `stty size` 实证。修复：cell 尺寸改经 `_core._renderService.dimensions`（官方 addon-fit 同源私有路径）；修复后实测 13px=24×80、16px=35×75、19px=28×63，PTY 真实双向跟随。
2. **T17 指纹门在 MCP e2e 中无人应答（上轮遗留，v1.11 修复）**：`e2e_acceptance` 5 个测试经 MCP 建会话，测试内无 UI 应答指纹门 → 各挂 120s 超时全灭（总 601.86s ≈ 5×120s 串行）。v1.10 回归未设 `TINYSSH_E2E_SSHD=1`，e2e 静默跳过被计成通过，掩盖了该缺口（§4 勘误）。修复：测试侧 `auto_accept_host_keys` 后台任务轮询 `pending_host_keys` 并按人类身份接受——与真实 UI 流程同构（FirstSeen → 决定 → 信任入库 → 放行），**门禁本身无测试旁路**；修复后 e2e 5/5 真实跑过指纹门（56.9s）。

**T18 走查矩阵**（原生窗口 + CGEvent 注入；视觉验证 = 每步截图逐项检查后入档，主题选中态另以像素取样核验；执行于 v1.11 当日）：

| 步骤 | 内容 | 结果 | 证据 |
|---|---|---|---|
| T18-a | 设置面板视觉：标题栏「Aa」入口 → 悬浮面板（字号 −/值/＋/重置、主题 4 项带配色样本、当前项高亮、快捷键提示），点击面板外即关 | 通过 | [t18_settings_panel.png](screenshots/t18_settings_panel.png) |
| T18-b | 字号 13→16（＋×3）：终端即时增大，PTY 真实跟随——`stty size` 24 80 → **35 75**（行变多列变少，方向正确） | 通过 | [t18_font_up.png](screenshots/t18_font_up.png) |
| T18-c | 快捷键：⌘= 步进（16→17）→ ⌘0 重置回 13（面板数值与「重置」禁用态同步翻转） | 通过 | [t18_shortcut_reset.png](screenshots/t18_shortcut_reset.png) |
| T18-d | 主题 → 浅色：终端区即刻 #f7f7f2、文字对比清晰；选中态像素取样核验（选中按钮带青色高亮，其余透明）；chrome 维持深色（设计如此） | 通过 | [t18_theme_light.png](screenshots/t18_theme_light.png) |
| T18-e | **跨进程持久化**：重启 app（全新进程）→ 面板恢复上次字号（19）与主题、终端按其渲染；期间多次整页刷新亦从 vault 恢复（font_size=19 时 stty=28 63） | 通过 | [t18_persist_restart.png](screenshots/t18_persist_restart.png) |
| T18-f | 多会话一致：新建第 2 会话自动继承当前主题/字号；⌘2 切换后隐藏会话同样生效、滚动历史原样保留、激活即校准 | 通过 | [t18_multi_session.png](screenshots/t18_multi_session.png) |

**T18 判定：通过**（54/54 回归全绿 + 走查矩阵 6/6 + 每步视觉验证入档 + 两处既有缺陷修复）。如实披露：① 主题只作用于终端区域（chrome 亮色属 V1）；② 设置读写不入审计（UI 偏好非协作事实）；③ 演示模式（无 Tauri）偏好退化为 localStorage；④ 隐藏会话的 PTY 校准发生在重新激活时——隐藏期间其 PTY 短暂保持旧尺寸（无输入可达，无实际影响）。

### 5.14 标签页 / 分屏（T19，v1.12 新增）

**动机**：UX 路线图（§6-18）第⑦项——多会话并行的终端应用标配：标签页一屏一签、分屏对照两个会话（本地操作 + 远程观察等场景）。

**实现**（纯 UI 轮，无 Rust/vault 改动；`ui/src/App.tsx` + `styles.css` + `main.tsx`）：

| 特性 | 改动 | 说明 |
|---|---|---|
| 标签页 | 中栏顶部标签栏：每会话一签（状态点随连接状态变色 + 主机名 + ◫ 分屏按钮 + ✕ 关闭），活动标签 accent 高亮；工具栏「＋」打开添加主机表单 | 与左栏会话列表同源（`sessions` state）；标签 title 提示状态与 ⌘N |
| 分屏 | 会话标签 ◫ 把目标会话放进右侧副 pane（50/50 固定比例，1px 分隔线）；「退出分屏」按钮还原 | 布局（main/second）与焦点（sid）**解耦**——点右 pane 只挪焦点，终端内容不左右跳动；每 pane 一枚主机名标签 + 焦点 pane 细高亮圈 |
| 尺寸跟随 | `fitTerminal` 重构为按「可见 pane」逐个校准（`fitOne`：每个可见 xterm 按自身元素盒子计算 cols/rows 并同步各自 PTY）；3s 看门狗同改双 pane 对账 | 分屏进入/退出/调整后 PTY 即时跟随（走查 `stty size` 实证 45→91 双向）；隐藏会话不按 0 尺寸误校准；量具从 `.term-wrap`（含 padding）改为 pane 元素本身，消除 16px padding 高估 |
| 快捷键 | ⌘W 关闭当前会话标签（仅在有会话时拦截，无会话保留系统关窗行为）；⌘⇧] / ⌘⇧[ 标签循环切换 | window 捕获层，先于 makeTerm 的「⌘ 全拦截」；⇧] / ⇧[ 用物理键位 `ev.code` 判定（Shift 下 `ev.key` 是 }/{） |
| 焦点契约 | 分屏进出后焦点自动回终端；⌘W 关闭焦点会话后自动落到下一个还开着的会话（无会话才回欢迎页）；关焦点副 pane 焦点回落主 pane | 工具栏点击不再吞掉后续打字（修复②）；任何关闭路径都不会让 sid 指向死会话（修复③） |

**三处既有缺陷在本轮走查中暴露并修复**（诚实披露，均非 T19 改动引入）：

1. **`main.tsx` 双 `createRoot` 挂载两个 App 实例（历史缺陷，v1.12 修复）**：`createRoot(...).render(...)` 整块被复制了两份——两个 React 根同时挂载两个 `<App/>`，**所有 window 级 keydown 监听按实例数翻倍**（⌘W/⌘= ⌘F ⌘1-9 Ctrl+字符 全部双触发）。走查以审计实锤：一次 ⌘W 产生两条 `session_closed`（seq142/143，相隔 55ms，分别关掉 e2e-sshd 与本机——两实例焦点状态不同步所致）。修复为单 `createRoot`（附注释防回归）；修复后同场景一次 ⌘W 恰好一条 `session_closed`（seq147）。此前各轮 ⌘ 系快捷键的走查结论（如 ⌘= 步进）在「重复触发恰好幂等/未被察觉」的场合成立，自 v1.12 起单触发才真实成立。
2. **工具栏点击吞焦点（v1.12 修复）**：点击标签栏/分屏按钮后焦点留在按钮上，后续打字落空。修复：分屏进出后焦点自动回终端（`focusSession(sidRef.current)`）——修复后「退出分屏 → 不点终端直接打字」实测直达（echo OK9 落进终端）。
3. **关闭焦点所在副 pane → sid 指向死会话（v1.12 修复）**：disconnectSid 的 second-pane 分支未处理「关的正是焦点会话」，会退出分屏但留下无 pane 可显、头部指向已关会话的黑屏态。修复：焦点回落主 pane。

**T19 走查矩阵**（原生窗口 + CGEvent 注入；视觉验证 = 每步截图逐项检查后入档，标签高亮/状态点经像素取样核验；执行于 v1.12 当日）：

| 步骤 | 内容 | 结果 | 证据 |
|---|---|---|---|
| T19-a | 标签栏视觉：双会话两签（绿状态点 + 主机名 + ◫/✕），活动签 accent 边框；无会话时仅余「＋」 | 通过（活动签边框像素 (101,161,164)=accent，非活动签无 accent） | [t19_tabs.png](screenshots/t19_tabs.png) |
| T19-b | 点标签切换：本机 ↔ e2e-sshd，终端/头部/窗口标题/简报/命令框全部跟随；滚动历史原地保留 | 通过 | [t19_tab_switch.png](screenshots/t19_tab_switch.png) |
| T19-c | 分屏 PTY 实证：◫ 进分屏 → 左右 50/50（pane 名牌 + 焦点圈），两侧各跑 `stty size` → **L=38 45 / R=38 45**（真实减半） | 通过 | [t19_split_enter_stty.png](screenshots/t19_split_enter_stty.png) |
| T19-d | 焦点 pane 路由：点右 pane → 头部/命令框/简报跟随；命令框执行 `whoami` → 输出落在右 pane（本机），左 pane（e2e-sshd）不动，审计「执行命令 whoami」、简报「$ whoami · 成功」 | 通过 | [t19_split_command_focus.png](screenshots/t19_split_command_focus.png) |
| T19-e | 退出分屏：「退出分屏」→ 单 pane 全宽，`stty size` **38 91**（45→91 双向跟随）；关闭副 pane 标签 ✕ → 自动退分屏 | 通过 | [t19_split_exit_full.png](screenshots/t19_split_exit_full.png) / [t19_close_second_pane.png](screenshots/t19_close_second_pane.png) |
| T19-f | ⌘W 关闭焦点标签：恰好一条 session_closed（seq147）、焦点自动落到剩余会话、窗口保留；⌘⇧] / ⌘⇧[ 循环切换（⌘⇧[ 后打字目标随焦点移动） | 通过（修复前对照：双实例一次关两签，seq142/143） | [t19_cmd_w_close.png](screenshots/t19_cmd_w_close.png) / [t19_focus_restore.png](screenshots/t19_focus_restore.png) |

**T19 判定：通过**（54/54 回归全绿 + 走查矩阵 6/6 + 每步视觉验证入档 + 三处既有缺陷修复）。如实披露：① 分屏为固定 50/50 两 pane，无拖拽分割条、无纵向分屏、无 2+ pane（V1 按需）；② 分屏布局不持久化（会话本身不跨重启，随进程消散）；③ 分屏中 attach 第三个会话（标签/⌘1-9/左栏）语义为「替换左主 pane、副 pane 保留」；④ 副 pane 会话断线（Degraded）时标签点变红、可继续查看回显，重连走左栏「重连」；⑤ pane 名牌悬浮于内容左上角，可能遮住首行前几个字符（半透明底，tmux pane 标题同款取舍）。


### 5.15 文件传输：拖拽上传 / 下载 / 取消（T20，v1.13 新增）

**动机**：UX 路线图（§6-18）第⑧项——文件传输是远程工作的第二高频动作。核心层 SFTP（russh-sftp）与 Agent 侧 MCP upload/download 工具（必审）v0 即已就绪，本轮补齐**人**的入口：拖文件进终端即上传到当前目录、远端路径下载到本地、传输可视（卡片）可取消，全链路入审计。

**实现**：

| 层 | 改动 | 说明 |
|---|---|---|
| core-session | 审计 payload 增加 `transfer` id | transfer_done/failed/voided 均带 tid；human 与 Agent 传输同链路（Agent 仍必审），UI 按 id 对账终态 |
| Tauri 壳 | 命令 `upload_file` / `download_file` / `cancel_transfer` | 直通 SessionApi（人类直传不入审批）；download 的 local 省略时落 `~/Downloads/<远端文件名>` |
| UI 上传 | 拖文件进终端 → 覆盖层（accent 虚线框 +「⇩ 松开上传到 <cwd>」）→ drop 即传到**焦点会话当前目录**（现场简报 cwd） | Tauri drag-drop 事件（enter/over/drop/leave）；无会话 / cwd 未就绪时拒绝并给失败卡片（不猜路径） |
| UI 下载 | 右栏「传输」区：远端绝对路径 → 「下载」 | 保存到 `~/Downloads`（固定目录，V1 加保存对话框）；相对路径按 SFTP 语义解析（登录家目录），输入框提示写明绝对路径 |
| UI 卡片 | 每传输一卡：方向 ↑/↓ + 文件名 + 状态（传输中… / 完成 · 字节数 · 路径 / 失败原因 / 已取消）+ 运行中可 ✕ 取消 | 终态由审计按 transfer id 对账（仅在有进行中传输时 800ms 轮询）；时间线同步显示「传输完成/失败」 |

**T20 走查矩阵**（原生窗口；执行于 v1.13 当日；「松开上传到 /root」覆盖层、上传卡片、md5 对照、下载卡片均截图逐项视觉检查入档）：

| 步骤 | 内容 | 结果 | 证据 |
|---|---|---|---|
| T20-a | 拖拽覆盖层视觉：拖入时终端区显示 accent 虚线框 +「⇩ 松开上传到 /root」 | 通过 | [t20_drag_overlay.png](screenshots/t20_drag_overlay.png) |
| T20-b | 上传落盘：drop → 卡片「↑ t20_upload.txt · 完成 · 53 B · /root/t20_upload.txt」+ 时间线「传输完成」 | 通过 | [t20_upload_card.png](screenshots/t20_upload_card.png) |
| T20-c | 完整性：终端 `md5sum /root/t20_upload.txt` = 本地 md5 **811a56e9df8a4f584dc8fba923fc8dfc**，53 B 一致 | 通过 | [t20_upload_verify.png](screenshots/t20_upload_verify.png) |
| T20-d | 下载：远端造标记文件 → 传输区填 `/tmp/t20_remote.txt` → 下载 → 卡片「↓ · 完成 · 24 B · ~/Downloads/t20_remote.txt」；两端 sha1 一致（c704993c…）、24 B 一致 | 通过 | [t20_download_card_verify.png](screenshots/t20_download_card_verify.png) |
| T20-e | 取消：真实 SFTP 下载 256MB、200ms 传输中取消 → `Err(Cancelled)` + 本地无完整文件（Rust e2e `sftp_download_cancel_midway`；UI ✕ → `cancel_transfer` 为一行薄包装） | 通过 | cargo test（55/55 内） |
| T20-f | 审计链：transfer_done payload 含 transfer id + bytes（seq161/164）；时间线中文「传输完成 <远端路径>」 | 通过 | sqlite：`{"bytes":53,"transfer":"t-91ee…"}` |

**T20 判定：通过**（55/55 回归全绿 + 走查矩阵 6/6 + 每步视觉验证入档）。如实披露：

1. **OS 级拖拽投递环节为合成事件注入**（dev 构建 + `TINYSSH_TEST_DRAG=1` 双重门禁，release 无此代码）：走查机为双显示器 + 多桌面空间环境，Finder 窗口与桌面图标无法与 app 窗口脚本化同屏（窗口定位静默失效、Space 归属不可编程、桌面图标位置只读且被用户窗口遮挡；Finder 窗口排布、桌面 AX 定位、拖窗跨 Space、Mission Control 等路径穷尽未果）。事件之后整条链路（UI 处理器 → upload_file 命令 → core-session → russh-sftp → 远端落盘 → 审计）全部真实执行——与 T15 滚轮「引擎层验证」同款口径（§5.10）。**真人从访达拖一个文件进终端**列为顺手确认项。
2. **取消路径的 UI 点击走查主动中止**：走查中途检测到可见视图已切到用户正在使用的浏览器窗口（用户/其另一 agent 正在操作机器），为避免合成点击落入无关窗口立即停止全部 UI 注入——改以 Rust e2e 实测取消语义（T20-e）。顺手确认项：真人下载大文件时点 ✕。
3. 上传目标目录取自现场简报 cwd，简报未就绪（刚连接 <1s）时拒绝并提示，不猜路径。
4. 取消/失败可能在远端留下部分写入的文件（SFTP create 即建文件），不自动清理（与 scp 同语义）。
5. 传输为「进行中 → 终态」两态展示，无逐字节进度条（完成态显示字节数）；大文件进度 V1 优化。
6. 下载固定存 `~/Downloads`、无保存对话框；上传无文件选择器入口（拖拽为主）——均 V1 按需补。

### 5.16 ~/.ssh/config 导入与 ssh-agent（T21，v1.14 新增）

**动机**：UX 路线图（§6-18）第⑨项——已有 ~/.ssh/config 的用户不应手工重录主机；私钥已加载进本机 ssh-agent 的用户不应把私钥复制进任何应用。

**实现**（`session-api` 类型 + `vault` 解析器与存取 + `transport-ssh` Agent 认证 + `core-session` 导入组合 + `cli`/Tauri/UI 入口）：

| 特性 | 改动 | 说明 |
|---|---|---|
| ssh-agent 认证 | `AuthType::Agent` / `AuthDraft::Agent`；transport-ssh 新增认证分支：`AgentClient::connect_env()`（SSH_AUTH_SOCK）→ `request_identities()` → 逐 key `authenticate_publickey_with`（ssh 标准顺序尝试） | 私钥签名不出 agent，vault 对 Agent 主机**零密钥材料落库**（`host_secret` 对 Agent 直接短路）；agent 不可达 / 无已加载密钥 / 全部拒绝分别给出可读错误 |
| config 解析器 | `vault::sshcfg`（纯函数）：Host/HostName/User/Port/IdentityFile；`=` 或空白分隔、`#` 注释、关键字大小写不敏感、块内首值优先（ssh 语义）、多模式 `Host a b` 拆条目、通配符（*/?/!前缀）与 **Match 块整体跳过**（条件导入有误伤风险）、`~/` 展开、同名 Host 块去重 | 8 个单测；CLI 原一次性解析器（只认空白分隔、后值覆盖前值）废弃换用共享实现 |
| 导入组合 | `SessionManager::ssh_config_preview`（解析 + 与现有主机对账：同名或同 address+port+user 视为已导入）/ `ssh_config_import`（逐条出结果：有 IdentityFile 且可读 → 读私钥 `create_identity` 入 vault（Key）；无 → `AuthDraft::Agent`；单条失败不阻塞其余；加密私钥无口令解不开时明说，不静默降级） | 审计自动贯通（复用 `host_upsert` / `identity_create`）；导入主机带 `ssh-config` tag |
| GUI | 左栏「导入 ~/.ssh/config」按钮 → 面板：逐条勾选（已导入条目禁选）、`user@addr:port · 密钥/Agent` 来源标注、逐条导入结果；添加主机表单认证方式新增「SSH Agent」；主机列表 Agent 徽标 | 导入面板读缺省 `~/.ssh/config`（命令层支持 path 覆盖，UI 不暴露） |
| CLI | `host add --from-ssh-config` 换共享实现（预览→全量导入，逐条报错） | 与 GUI 同一内核路径 |

**验证状态**（v1.14 当日）：

- ✅ **自动化 66/66 全绿**（e2e 守卫开启 0 跳过）：vault 解析器 8 例、sshd_e2e agent 认证 1 例（一次性独立 ssh-agent + 容器临时公钥 → russh AgentClient 真实认证 → exec 实证 → 自动清理）、core-session 导入链路 2 例（预览对账 + 导入落库 + **导入的 Agent 主机经 SessionManager 全栈真实建连**）。
- ✅ **既有缺陷修复（测试基建）**：`await_sshd_ready` 原 TCP-only 探测在 `docker start` 后失真——docker 端口代理在容器内 sshd 真正监听前就接受 TCP（随后 reset），致 journey3 `Connection reset by peer` **在 HEAD 上稳定复现**（与 T21 改动无关，stash 验证）。修复为 TCP + **SSH banner 探测**，journey3 恢复全绿。
- ⛔→✅ **UI 视觉走查完成（跨两日，注入全程 HID 空闲 ≥75s 门禁）**：首轮启动 app 后发现**机器处于锁屏状态**，所有 UI 注入立即放弃（键盘注入有落入锁屏密码框的风险）；解锁后恢复执行，矩阵见下。

**T21 走查矩阵**（原生窗口；隔离 `HOME=/tmp/t21home` + 专属一次性 ssh-agent（`SSH_AUTH_SOCK` 独立于用户会话）+ e2e 容器临时公钥；每步截图逐项视觉检查入档）：

| 步骤 | 内容 | 结果 | 证据 |
|---|---|---|---|
| T21-a | 导入面板预览：左栏「导入 ~/.ssh/config」→ 面板恰列 2 个可导入条目（`e2e-agent · Agent` / `e2e-key · 密钥` 来源标注正确）；合成 config 中的通配符块与 Match 块条目**不可见**（解析器跳过的直观印证） | 通过 | [t21_a_import_preview.png](screenshots/t21_a_import_preview.png) |
| T21-b | 勾选导入：两行「✓ 已导入」；主机列表新增 `e2e-agent`（· Agent 徽标）与 `e2e-key`（密钥徽标）；DB 落库 e2e-agent auth=agent 零密钥、e2e-key 绑定 identity | 通过 | [t21_b_import_done.png](screenshots/t21_b_import_done.png) |
| T21-c | Agent 主机连接：点 `e2e-agent` 连接 → TOFU 首连确认弹窗 → 信任并连接 → 会话建立（容器提示符 `41600b72ba91` 上屏）；app 冷重启后再连 → 指纹已信任**直连无弹窗** | 通过 | [t21_c_agent_tofu_connect.png](screenshots/t21_c_agent_tofu_connect.png) / [t21_c_agent_reconnect.png](screenshots/t21_c_agent_reconnect.png) |
| T21-d | Key 主机（e2e-key）UI 建连：**未注入执行（披露①）**；导入侧（IdentityFile → vault 身份绑定 + 密钥徽标）已由 T21-b 截图与集成测试断言覆盖 | 部分覆盖（披露①） | [t21_b_import_done.png](screenshots/t21_b_import_done.png) + cargo test（66/66 内） |
| T21-e | 审计链：导入 `host_upsert`×2 + `identity_create`×1 → TOFU `host_key_confirm_requested` / `host_key_decision(FirstSeen,accept)` / `host_key_trusted` → 首连与重启直连的 `shell_integration_inject`+`session_created` 各一对（seq 1–13 连续无缺口） | 通过 | sqlite（$TINYSSH_DB） |

**T21 判定：通过**（66/66 回归全绿 + 走查矩阵 4 通过 / 1 部分覆盖，每步视觉证据入档）。如实披露：

1. **t21-c 连接后的 `whoami` 键入与 t21-d 的 UI 建连未注入完成**：恢复走查的注入窗口期用户回到电脑（另一 agent 会话在前台活跃），按「用户占用即中止一切 UI 注入」纪律放弃剩余键盘注入、不重试抢窗口。终端键入透传为 T10 起既有已验证功能（§5.5）；Agent 通道 `whoami=root` 已由 sshd_e2e agent 认证用例 exec 实证；密钥认证建连为 T9 起既有功能且 e2e-key 身份落库有集成测试断言。**真人点开 e2e-key 敲一条命令**列为顺手确认项。
2. 走查对象仅本机 local 会话 + e2e-sshd 容器（127.0.0.1:2222），未触碰任何真实主机；容器公钥带 `t21-walk-` 标记、一次性 agent 与隔离 HOME 用后清理（§7#17）。
3. 锁屏中止先例沉淀为流程规则：**锁屏 = 最硬中止条件**——注入前先截图确认屏幕非锁屏黑屏态，再过 HID 空闲门禁。

### 5.17 UX 走查修复第一批（v1.15，T22）

**动机**：2026-09-30 模拟用户 UX 走查（4 人格并行黑盒 + 主控代码甄别，[docs/ux/2026-09-30-simulated-ux-review.md](../ux/2026-09-30-simulated-ux-review.md)）甄别出真实问题 26 条（P1×5/P2×14/P3×7）；本批修复其第一批（PV 前必修的信任/安全项 5 条）。

**验证方式**：改动全部为渲染层（App.tsx），以浏览器 demo 模式走查——demo 与真实 app 共用同一渲染代码与 xterm 实例路径；headless Chrome + playwright，11 项断言全过 + 逐张截图目验入档。cargo 66/66 全绿（不触内核）。

| 项 | 修复 | 验证 | 证据 |
|---|---|---|---|
| P1-1 审批卡缺目标主机 | 卡头新增「目标：{主机名} · {sid 前 12 位}」（会话已关时明示「会话已不在列表」，title 悬浮完整 sid） | demo 卡渲染「目标：prod-1 · s-demo-0001」，主机名加粗 | [u1_approval_context.png](screenshots/u1_approval_context.png) |
| P1-2 ⌘F 搜索焦点抢占 | **根因更正**（走查报告原推断有误）：非 `#term` mousedown 委托，实为 `.term-wrap` 上的 **click** 监听（原 499-505 行）——`.term-search` 浮层正是其子元素，点击冒泡 → `xterm.focus()` 抢焦（⌘F autoFocus 路径无点击故正常）。修复：click 监听排除 `.term-search, .term-settings` | ⌘F → 点击输入框 → 键入 `ls -la`：字符留在输入框、终端零泄漏；Esc 关闭回焦终端（T16 回归）；点终端空白区仍聚焦终端（原功能回归）；**设置面板同根因一并修复**（点主题/字号不再被抢焦，键盘可连续操作） | [u1_search_focus.png](screenshots/u1_search_focus.png) |
| P1-3 危险命令批准无摩擦 | 风险分级两步批准：全段 pending（系统零正向信号）或命中高危形态（rm -rf/格式化/关机类正则）→ 首点变金色「再次点击确认批准」+ ⚠ 风险说明行；混合段卡片保持一键（避免对正常审批加摩擦——人工审批比例是观察指标不是成功指标）。deny 命中本就不出卡（内置危险模式直接拦，卡片上只会有 allow/pending 段） | demo 卡（两段全 pending）：首点 → 确认态；二点 → 决定生效、卡撤出待审队列 | [u1_approve_confirm.png](screenshots/u1_approve_confirm.png) |
| P2-2 首屏自相矛盾 | 空态文案按真实状态分流：有会话未接入 → 「已有 N 个会话未接入终端——点击上方标签或左侧会话卡继续」；无会话 → 引导连接/导入（「点标签即接入」原生已实现：tab onClick=attachSession；走查所报「点标签不接入」经 demo shim 比对判为 shim 伪影候选，待实机顺手复核） | demo 启动态显示「已有 2 个会话未接入终端…」，不再出现「暂无接入的会话」与左侧「已连接」打脸 | [u1_welcome_copy.png](screenshots/u1_welcome_copy.png) |
| P2-4 AGENT 接入区死胡同 | 常驻端点行（`mcp.endpoint`，空则「未启动」）；agent 行 id 与 label 不同时以「· id {id}」标注（消歧重名观感）；「接入新 Agent」展开三步指引：`tinyssh serve` → `tinyssh agent create <id> <名称>`（Token 仅展示一次）→ MCP URL + Bearer 配置片段（`userSelect: all` 可整段复制） | 展开后含 serve/create/Bearer 三要素与端点值 | [u1_agent_section.png](screenshots/u1_agent_section.png) |

**T22 判定：通过**（demo 渲染层 11/11 断言 + 截图目验；cargo 66/66 回归全绿）。如实披露：

1. **实机原生冒烟未执行（当日锁屏中止）**：启动前检查发现机器 LOCKED，按 §5.16 披露③ 的最硬中止条件放弃全部 UI 注入（不等待、不重试）。P1-2 抢焦机制为纯 DOM/click 层、与原生层无关，demo 证据已覆盖其行为；**真实 shell 上复验 P1-2 与审批卡实机渲染**列为下一原生走查窗口的顺手项（审批卡实机走查需 agent MCP rig 发起 exec 请求，与该项合并执行）。
2. 走查对象为 vite demo 模式（headless，无系统级键鼠注入），不涉及真实主机；实机冒烟同样仅限 e2e 容器（127.0.0.1:2222）。
3. 走查报告的 P1-2 根因推断（mousedown 委托）已在本节更正，报告 §2 同步勘误。

### 5.18 UX 走查修复第二批（v1.16，T23）

**动机**：UX 走查报告（§5.17 同源）第一批后的日用摩擦主干：P1-4/P1-5 + P2-1/3/5/6/7/8（[报告 §4 批次表](../ux/2026-09-30-simulated-ux-review.md)）。

**后端改动（本轮唯一内核项）**：`AuthDraft::None`（serde rename `"Keep"`）重定义为**编辑主机保持现有凭据**——UI 不持明文、编辑不能要求重输密码；vault `upsert_host` 对 Keep 且行已存在 → 保留原 auth_type/identity_id（identities 表密码行随 identity_id 不变原样保留），新建回落原占位行为（local 主机，`ensure_local_host` 不受影响）。`delete_host` 后端 v0 即有（软删+审计 `host_delete`），本轮补 UI 入口。

**验证方式**：同 §5.17（demo 渲染层 headless 断言 + 截图目验）；本轮 **20/20 断言**全过 + cargo **66/66 全绿**。

| 项 | 修复 | 验证 | 证据 |
|---|---|---|---|
| P1-4 主机无编辑删除 | 主机卡 hover 出 ✎/✕；✎ 打开表单编辑模式（预填 + 认证区禁用 + 「凭据保持不变（密码/密钥/Agent）」+ 后端 Keep 语义 + tags 原样回传）；✕ 确认弹层（「凭据与指纹记录一并移除…已建立的会话不受影响」）→ 软删 | 编辑改名 prod-1→prod-1-renamed 原位生效、主机数不变、不自动建连；删除确认 → prod-2 卡消失 | [u2_edit_form.png](screenshots/u2_edit_form.png) |
| P1-5 关已连接标签=静默断开 | 统一 `requestCloseSession`：活会话关标签（✕）/⌘W/会话卡「断开」均弹确认（「终端现场不可恢复——重连会是全新现场」）；死会话直接关 | ✕ → 弹层 → 取消仍已连接；✕ → 断开连接 → 卡变「· 已断开」 | [u2_close_confirm.png](screenshots/u2_close_confirm.png) |
| P2-1 键盘可达 | 标签 tabIndex=0 + role=tab + Enter/Space 切换；Esc 统一关闭浮层（搜索框/设置面板/添加主机/导入/Agent 指引；**xterm textarea 除外**——终端 Esc 是 vim 功能键，输入控件也不劫持） | Esc 关设置面板/表单；focus 标签 + Enter → attach | [u2_tab_keyboard.png](screenshots/../screenshots/u2_tab_keyboard.png)（未归档，见断言记录） |
| P2-3 表单三连 | 字段常驻标签（名称/地址/端口/用户名/认证方式）；地址格式校验（`^[a-zA-Z0-9._-]{1,253}$`，乱码不再一路存到「连接成功」）；切换认证方式清旧错误 | 乱码地址 → 红字「地址格式不对…」；切私钥登录 → 错误消失 | [u2_addr_invalid.png](screenshots/u2_addr_invalid.png) |
| P2-5 停止结果零披露 | `takeoverStop` 渲染 TakeoverReport：逐任务停止结果（Exited/Escalated/Unresponsive→「升级后仍未停止」标红）、作废排队数、冻结状态、简报指引 | 「⏸ 已接管 prod-1 —— 停止结果：x-demo-1f → 已停止（exit 0）· 作废排队 1 条 · 新请求已冻结」 | [u2_stop_result.png](screenshots/u2_stop_result.png) |
| P2-6 失败反馈断裂 | 主机卡新增失败态：连接中（按 host id）、失败后卡上红字「上次连接失败——检查地址与凭据后重试」（横幅保留并补指引） | 连 prod-2（演示失败）→ 卡红字出现 | [u2_edit_form.png](screenshots/u2_edit_form.png)（左栏同框） |
| P2-7 死会话无标注/输入黑洞 | 终端区死会话遮罩（「⛔ 会话已断开——画面是断开前的最后状态；键入已拦截」+「重连恢复」按钮 + 重确认提示）；输入拦截四路：xterm onData（限一次提示行）/ Option-Meta 层 / Ctrl 控制字符层 / 命令框（含 placeholder 诚实化、「中断」按钮） | attach 死会话 → 遮罩；键入 `ls` → 终端出现「⚠ 会话已断开——键入未发送」、无 ls 回显 | [u2_dead_overlay.png](screenshots/u2_dead_overlay.png) / [u2_dead_intercept.png](screenshots/u2_dead_intercept.png) |
| P2-8 死卡双按钮/状态词截断 | 会话卡 Disconnected 时只留「重连」（隐藏「断开」）；主机名 ellipsis 与状态词 flex:none 分离，「· 已断开」不再被吞 | 死卡 inner_text 含「· 已断开」且无「断开」按钮 | [u2_dead_card.png](screenshots/../screenshots/u2_dead_card.png)（见断言记录） |

**配套**：demo shim 对齐真实语义（`close_session` 保留卡片置 Disconnected——之前直接移除是 shim 伪影、`upsert_host` 支持 id 更新、`delete_host`、`set_control` 返回演示停止结果）。

**T23 判定：通过**（demo 渲染层 20/20 断言 + 截图目验；cargo 66/66 回归全绿）。如实披露：

1. **实机原生冒烟未执行（第二次锁屏中止）**：启动前检查 LOCKED，按最硬中止条件放弃 UI 注入（不等待不重试）。本轮新增输入拦截路径覆盖 xterm onData / Option / Ctrl / 命令框四路，均为 DOM/JS 层，demo 证据已覆盖行为；**native NSEvent 层（T10 Ctrl 接管）死会话时仍会直发死通道**（按键被吞无副作用，但无提示）——已知边界，随 P2-7 实机复验一并评估是否在 native 层加会话状态检查。
2. 编辑仅覆盖名称/地址/端口/用户名与删除；**认证凭据更换 = 删除后重添加**（明文不出 vault 的约束下，编辑改凭据需要「旧凭据验证」机制，V1 再议）。
3. `rm -rf` 类高危**编辑后批准**仍走 §5.17 的内置 deny 复检（后端既有，ApproveEdited 不可绕过），本轮未改动。

### 5.19 UX 走查修复第三批（v1.17，T24）—— 收尾批

**动机**：UX 走查报告批次表第三批（其余 P2 与全部 P3）。P2-13（断开无二次确认）已随 v1.16 修复（requestCloseSession 统一口），本批核对不重做。

**验证方式**：同 §5.17/§5.18（demo 渲染层 headless 断言 + 截图目验），**13/13 断言**全过；cargo **66/66 全绿**（本批零 Rust 改动）。

| 项 | 修复 | 验证 | 证据 |
|---|---|---|---|
| P2-10 简报三层认知无标识 | 命令行/控制权/注意行补 `已核实/需复核/未观测` 徽标（cwd 行 v0 即有）；控制权行加 tooltip（截断不再丢信息） | 简报卡 4 枚徽标（3 已核实 + 1 需复核） | [u3_brief_tags.png](screenshots/u3_brief_tags.png) |
| P2-11 传输「上方」指代 | 空态文案显式指「上方『下载远端文件』输入框」（传输面板自带下载输入框，走查员误指命令框——文案问题非结构问题） | 文案含「『下载远端文件』输入框」 | 断言记录 |
| P2-12 ＋ 残留不收回 | ＋ 与左栏「＋ 添加主机」均为 toggle（再点收起）；title 注明 | ＋ 开 → 再点 ＋ → 收起 | 断言记录 |
| P2-14 命令框无历史 | ↑ 召回上一条 / ↓ 后退 / 到底清空；连续重复不重复入栈；输入法组合期间不劫持 | df -h → whoami → ↑↑↓↓ 序列值逐断言 | [u3_history.png](screenshots/u3_history.png) |
| P3-1 uppercase 用户数据 | `.panel-title` 去 text-transform（中文标题本无变化，实际被大写失真的是内嵌的 host_name/sid）；.ts-label/.section h4/.side-sub 为纯固定标签保留 | 头部显示 `prod-1 · s-demo-0001` 原样 | [u3_header_case.png](screenshots/u3_header_case.png) |
| P3-2 favicon 404 | index.html 内联 SVG data URI（终端提示符造型），零额外请求 | link[rel=icon] href 为 data:image/svg+xml | 断言记录 |
| P3-3 两个「收起」 | 「收起表单」/「收起导入」带上下文 | 按钮文案断言 | [u3_form.png](screenshots/u3_form.png) |
| P3-4 时间戳口径 | 操作记录 HH:MM → **HH:MM:SS**，与现场简报/后端审计带秒一致 | 时间线行含 `\d{2}:\d{2}:\d{2}` | [u3_brief_tags.png](screenshots/u3_brief_tags.png) |
| P3-5 对比度 ≈3:1 | **实测证伪+补漏**：`--dim #8a97a8` 在 `--panel` 上实算 **5.70:1** 达标（走查报告 D 人格测量方法误伤，与主题对比度 2.6:1 证伪同型）；真凶是 **placeholder 无显式颜色走浏览器默认灰**——补 `input::placeholder { color: var(--dim) }` | getComputedStyle placeholder == rgb(138,151,168)；CR=5.70 断言 | 断言记录 |
| P3-6 浅色主题白色孤岛 | `#term` 圆角 8px + 投影 + overflow hidden（深浅主题通用，深色下不可见） | computed borderRadius==8px | 断言记录 |
| P3-7 用户名默认 root | 默认空（安全默认；必填校验已有） | 表单 username value=="" | [u3_form.png](screenshots/u3_form.png) |

**T24 判定：通过**（demo 渲染层 13/13 断言 + 截图目验；cargo 66/66 回归全绿）。如实披露：

1. **P3-4 未做部分**：状态词中英并存、标点全半角、分隔符「·—:」三套属**全量文案 sweep**（跨全部 UI 字符串），适合 PV 前一次专项 pass，本批仅做时间戳口径对齐；P2-13 已随 v1.16 修复。
2. 实机原生冒烟未执行（第三次锁屏中止，同 §5.17/§5.18 披露③纪律）；本批全为渲染/文案/样式层，无原生层交互面。

### 5.20 PV 备战三件套（v1.18，T25）

**动机**：validation-plan §6 是进入 V1 的唯一 gate，需要用户招募 6–8 名真人参与者（工程侧无法代劳）；工程可自主推进的是开测配套工具，目标是「招募完成即可开测」。

**交付物**（配套指针已挂入 [validation-plan](../../docs/validation-plan.md) 头部与 [README](../../README.md) 文档表）：

| 件 | 交付 | 验证 |
|---|---|---|
| 沙箱故障模板 | [scripts/pv_env.sh](../../scripts/pv_env.sh)——validation-plan §3「预置故障的隔离测试机」的工程实现：A/A′（crash-loop 两种根因：配置键格式 / 值尾随空格）、B/B′（定时备份失败两种根因：目标目录不符规范 / 源目录已下线）、C（复合任务：报表坏行中止 + 归档积压含人工判断项）；`reset/fault/check/solve` 四动作，含容器指纹守卫（拒绝操作非 alpine 沙箱或端口映射非 127.0.0.1:2222 的容器） | 5 个故障态 `check` 全 ✓；5 条参考解法容器内实测走通；`reset` 全量回归 ✓ |
| 分发构建 | [scripts/dist.sh](../../scripts/dist.sh)——vite build → `cargo tauri build` → 归档 `dist-pv/<日期>-<commit>/`（app.zip + dmg + SHA256SUMS + COMMIT），版本号 = commit | 实测产出 [dist-pv/20261001-fefb6e8/](../../dist-pv)（8.0M ×2；产物 gitignore） |
| 数据与分析 | [scripts/pv_analyze.py](../../scripts/pv_analyze.py)——§5 系统日志指标（按主持段窗口切分：审批请求/决策/延迟中位、接管/交还、exec 人/Agent、打断）+ §6 gate 判据矩阵（阈值随 N 计算）+ 三出口建议（**反模式优先**逻辑内置）+ `--verify-chain` 审计哈希链校验（与 crates/audit `append()` 逐字段一致）+ `--init-templates` 三张 CSV 模板 | 合成数据三段自测全过：①gate 达标路径（6 人样例判据逐项 ✓→「进入 V1」）②篡改检测（改一条 payload → 链校验退出码 2）③反模式优先路径（全批×1 → 否决偏好判据 →「调整交互再测」） |
| 主持手册 | [docs/pv/session-kit.md](../pv/session-kit.md)——一图流/画像卡/N 锁定与阈值预登记表（commit 即预登记）/知情同意要点/每场前清单/90 分钟流程脚本/S2 教学脚本（B′ 内嵌计划内接管→交还 = V0 验收场景复演）/任务卡（A–C 判据可编码）/当场与回访问卷/数据回收清单 | 走查：任务卡判据与 pv_env.sh 故障一一对应；流程时间轴与 validation-plan §4 三段式一致 |

**T25 判定：通过**（三件套全部实测；cargo **66/66** 回归全绿，本项零 Rust 改动）。如实披露与开发记录：

1. **pv_env.sh 开发中实测修掉的坑**（留给未来维护者）：busybox `pkill -x` 匹配完整 argv[0] 不做 basename 归一（打不中 `/usr/sbin/httpd`）；`pkill -f` 模式会自匹配注入脚本写入容器的文件内容（曾把注入 shell 自身杀掉 → `set -e` 静默退出，退出码 143）——杀旧实例改 PID 文件 + 锚定 argv[0] 的 `pkill -f "^/usr/sbin/httpd"`；macOS bash 3.2 下 `$var` 后紧跟全角字符会把多字节首字节并进变量名（`${var}` 定界）；docker 端口代理下 TCP 连通 ≠ sshd 就绪（banner 探测，本仓库第二次踩实）。另：alpine 的 `httpd` 在 busybox-extras 包，不装则 crash-loop 任务的服务永不起来自动通过。
2. **故障确定性修正**：B′ 首版用相对路径缺前导 `/`，cwd=/ 时恰好成功（非确定性）——改为指向已下线目录的确定性故障。
3. dist 产物未做 Apple 签名/公证：参与者首次打开需右键「打开」或 `xattr -cr`（手册 §4 已注明）。
4. **分析脚本不替代编码员**：自发采用（核心指标）以录屏编码为准，audit 数字仅佐证（脚本输出已标注「判定以编码为准」）；复述准确、反模式等录屏维度本就走人工编码 CSV。

### 5.21 全量文案 sweep + 审批状态契约断点（v1.19，T26）

**动机**：P3-4 未做部分（状态词中英并存、标点全半角、分隔符三套）按 §5.19 披露①列为 PV 前专项。全量盘点 228 行非注释中文文案后，标点与省略号已高度一致（全角，…；（）），真正的问题集中在状态词——并由此挖出一个**契约级 bug**。

**重大发现：真实 app 审批面板从未渲染过真卡**。后端 `ApprovalStatus` 无 serde rename（PascalCase，session-api v1 冻结契约），UI 却按小写 `"pending"` 过滤——真实数据永不匹配，待审批卡与「最近处理」在真实 app 恒空。demo shim 直接给小写，浏览器走查全部被掩住（**shim 伪影第三例，首次是契约级**；对照：SessionState/AuthType/Epistemic/TransferKind 的 UI 比较都写对了 PascalCase，唯独 ApprovalStatus 写成小写）。修复：**UI 侧入库归一化**（PascalCase→snake_case，session-api wire 契约一字不动）+ 新增 `approval_status_wire_format_is_pascal_case` 测试把契约形态钉死在代码里（防未来顺手 rename 静默改 MCP 协议）。

| 项 | 修复 | 验证 | 证据 |
|---|---|---|---|
| 审批状态契约断点 | `normApprovalStatus` 入库归一（list_approvals 映射）；demo shim 小写不受影响 | demo 9/9 断言；wire 锁定测试过 | [u4_approval_statuses.png](screenshots/u4_approval_statuses.png) |
| 「最近处理」状态词误报 | 原来非 approved 一律显示「✕ 拒绝」——**编辑后批准/超时/被接管作废全误报为拒绝**；改六态映射（✓ 批准 / ✓ 批准（编辑后）/ ✕ 拒绝 / ⏱ 超时未审 / ⊘ 已作废（接管），ok/err/dim 三色） | 编辑后批准→绿「✓ 批准（编辑后）」、拒绝→红「✕ 拒绝」、种子作废→灰「⊘ 已作废（接管）」逐断言 | 同上 |
| 分隔符统一（·—: 三套） | 规则：同级元数据=`·`（带空格）、引出解释/结果=`——`（无空格）、标签:值=全角`：`、窗口/欢迎标题=` — `（产品标题惯例，两处一致保留）、终端内 `──` 横幅=装饰保留 | 停止结果卡头 `已接管 prod-1——停止结果`（原 ` —— `）断言；操作记录 `Agent · opencode`（原 `Agent·opencode`）断言 | [u4_stop_header.png](screenshots/u4_stop_header.png) / [u4_audit_rows.png](screenshots/u4_audit_rows.png) |
| demo shim 种子扩充 | 补第二条 pending（走拒绝流）+ 一条 voided 已决样例（「最近处理」作废态可见）；decide 终端回显改中文（批准（编辑后）/拒绝） | 走查 ②③④ 断言 | 同上 |

**T26 判定：通过**（demo 渲染层 **9/9 断言** + 截图目验；cargo **67/67** 全绿，+1 wire 锁定测试）。如实披露：

1. **⏱ 超时未审标签未经走查**：demo 无超时自然产生路径，六态映射中该态仅代码覆盖；真实超时行为由 core_local 测试覆盖（审批超时 120s 语义）。
2. **本修复使 T22 的 P1-1/P1-3（审批卡目标行/两步批准）在真实 app 生效**——此前这些改动只被 demo 验证过（真实面板从不渲染）。真实 app 端到端审批面板复验（需 agent MCP rig）列入实机走查窗口顺手项。
3. 全量盘点的其余结论：标点全半角无问题、省略号统一 `…`、中文句内无半角标点残留——P3-4 的「三套分隔符」实际收敛为上述四条规则，无第三处需要改动。

### 5.22 demo shim 保真轮（v1.20，T27）

**动机**：UX 走查报告 + T22–T26 三轮暴露的 demo shim 伪影已误导走查三次（第三次为契约级，§5.21）——浏览器走查要继续作为 UI 回归证据链，shim 必须先与真实后端语义对齐。原 7 项伪影全部修复：

| 伪影（走查报告原述） | 修复 | 验证 |
|---|---|---|
| 全局单输出流 → 标签串台/分屏同播 | **按会话隔离**：每会话私有输出缓冲 + 订阅者（与真实 `subscribe_output { sid }` 同构）；`read_screen` 按会话回放 | exec 两个会话各自回显互不可见（④b/c） |
| set_control 不更新会话 → 接管 chip 不翻转、无交还 | set_control 更新该会话 `control_owner` + **作废其全部待审批**（真实契约）+ 审计 takeover/handback | chip 翻转人类控制↔Agent、两张 pending 变 ⊘ 已作废（①b/c/d、③a） |
| audit_query 固定种子 | 审计随操作动态追加（连接/断开/重连/审批/接管/交还/保存主机） | 操作记录实时出现新「接管会话/保存主机」行（②a、⑤c） |
| demoSeq 撞种子 id | 自增起点 100 避开种子区段 | 新会话 s-demo-0100（截图可见） |
| ssh_config_preview 未实现 → 导入面板裸 TypeError | preview（2 可导入 + 1 已导入对账）+ import（落主机列表 + 审计） | 面板 3 条、prod-1 禁选、导入后 web-1·密钥/db-1·Agent 落地（⑤a–d） |
| TOFU 不模拟 | **create_session 在指纹门内挂起等决定**（与真实后端同构，拒绝走 HostKeyRejected 原路径抛出）；配套 App 侧 demo 分支 500ms 轮询 pending_host_keys；本机 local 会话无指纹门 | prod-2 首连弹窗 → 拒绝 → 无新会话+主机卡失败 → 再连仍弹窗 → 信任 → 认证失败（⑥a–e，两段门全走通） |
| 未实现命令静默 null → 占位反馈缺失 | 未知命令显式 throw；传输类 throw（UI 卡片如实显示失败）；纯 native 类（note_terminal/open_url/get_setting/set_setting/bench_*）显式白名单 no-op | 代码审查（demo 模式无拖拽注入路径，披露①） |

**附带根因修复（shim 伪影的机制层）**：shim 三个 `list_*` 原来返回**同一个可变数组引用**——React setState 对相同引用跳过更新，这就是「接管后 chip 不翻转」的机制根因（真实后端每次 invoke 都是全新反序列化对象）。现 list_sessions/list_hosts/list_approvals 均返回新副本。

**T27 判定：通过**（本套件 **19/19 断言** + u4 套件回归 **9/9** + 截图目验 6 张；cargo **67/67** 全绿，本轮零 Rust 改动——App 侧仅 demo 分支轮询一处）。证据：[u5_takeover_flip](screenshots/u5_takeover_flip.png) / [u5_audit_dynamic](screenshots/u5_audit_dynamic.png) / [u5_session_isolation](screenshots/u5_session_isolation.png) / [u5_import](screenshots/u5_import.png) / [u5_tofu_firstseen](screenshots/u5_tofu_firstseen.png) / [u5_tofu_authfail](screenshots/u5_tofu_authfail.png)。如实披露：

1. **传输类（upload/download）在 demo 中显式失败**（诚实占位）：无头浏览器无拖拽注入路径，失败卡片路径未走查，由真实 app T20 原生走查覆盖。
2. **session_brief 仍为静态种子**（不随 demo 会话变化）——不在原 7 项清单内，简报三层结构由真实 app 原生走查（T12）覆盖；列为 shim 后续可选对齐项。
3. TOFU 的 Changed（指纹变更）分支未模拟（仅 FirstSeen）——Changed 的红色告警 UI 由 T17 原生走查覆盖。

### 5.23 2FA 键盘交互认证（v1.21，T29）—— 路线图⑩ 前半

**动机**：路线图⑩「键盘交互认证/2FA、GBK 编码」前半。2FA 服务器（OTP/双因素）普遍拒绝 password 方法、强制 keyboard-interactive 多轮提示——此前 `AuthType::KeyboardInteractive` 被别名到 `authenticate_password`，这类服务器一律认证失败。

**设计**（镜像 TOFU 指纹门的挂起模式）：

| 层 | 实现 |
|---|---|
| transport-ssh | `kb_loop`：`authenticate_keyboard_interactive_start/respond` 循环；应答策略 = **非回显且文本含 password/密码的提示自动填库内密码**（服务器要的正是表单里那个密码，省一次重复输入），其余提示（OTP/验证码）走 `kb_prompt_check` 人工门；`AuthType::Password` 被服务器拒绝时**自动回落 kb 循环**（2FA 服务器用现有密码主机即开即用）；无门且需人工 → ConnectFailed 明说不静默 |
| core-session | `auth_prompt_gate`（指纹门同构）：非密码提示 → `PendingAuthPrompt` 挂起（oneshot + broadcast + 审计 `auth_prompt_requested/answered`），120s 超时/取消 → None 终止认证 |
| session-api | `PendingAuthPrompt` 类型 + `pending_auth_prompts/answer_auth_prompt/subscribe_auth_prompts` 三方法（wire 新增，未动既有契约） |
| Tauri | 两条命令 + `authprompt-event` 事件桥（与 hostkey-event 同款） |
| UI | 模态对话框（指纹弹窗同款遮罩）：prompt 原文、echo 感知输入框、提交/取消（空=终止认证）、说明行「密码本身已在连接时自动填入」；demo shim 补 otp-1 主机场景（建连挂起等应答，与真实同构） |

**验证**：① **kb 回落 e2e**（+1，68 总数）——容器内起第二 sshd（`/usr/sbin/sshd.pam`，alpine 把 PAM 版装成独立二进制，普通 sshd 静默忽略 UsePAM 恒拒）强制 `PasswordAuthentication=no` + `KbdInteractiveAuthentication=yes`，Password 认证被拒 → 自动回落 kb → PAM 密码提示自动应答 → 认证成功 → shell 命令往返实证；② **demo 走查 8/8 断言**（[u6_2fa_dialog.png](screenshots/u6_2fa_dialog.png) 等 3 张）：指纹门先于 2FA 弹出（真实门序）、OTP 提示展示、echo 感知、空输入禁用提交、取消路径无会话、应答后会话建立；③ 全量回归 **68/68（e2e 守卫开启，0 跳过，--no-fail-fast）**。

**T29 判定：通过**。如实披露与顺带修复：

1. **真两轮提示（密码后追加 OTP）未对真实 2FA 服务器实测**——沙箱 PAM 只能造单轮密码提示；多轮循环路径与单轮完全同构（逐提示应答），人工门对话框已在 demo 层走查。GBK 编码（路线图⑩后半）未做，按需排期。
2. **回归守卫勘误（T18 教训第三度重演）**：v1.15–v1.19 各轮的「66/67 全绿」回归命令漏带 `TINYSSH_E2E_SSHD=1`，e2e 测试守卫跳过被计成通过——本轮带守卫跑出真实问题并修复：①journey3（docker stop/start 时序敏感）在套件并发下 60s 超时、单跑 9s 秒过，补同款两次尝试兜底（§6-11 家族）；②spike2 参考密钥的公钥是建容器时手工塞过一次的**隐式环境依赖**，pv_env 重建容器后必挂——测试内自举（密钥缺失自动生成 + 公钥自动注入容器）；③kb e2e 的 sshd.pam 与容器杀旧实例三处实测坑（busybox `pgrep -x` 匹配 argv[0] 而 sshd 监听进程 re-exec 后是长标题——/proc 全扫描 + 排除自身）。
3. `AuthType::KeyboardInteractive` 未在 UI 表单开放（CLI/导入路径可达）；对用户可见入口 = 密码主机遇到 2FA 服务器时自动回落 + 认证对话框。

### 5.24 真机冒烟（T28，v1.24 判定：通过）—— 真机全链路实证 + TOFU 门真机确证

**目标**：T22/T23 遗留实机复验（⌘F 搜索焦点、死会话 native Ctrl 层）+ 真机全链路冒烟（AUTOCONNECT 建连 → 指纹门确认 → 终端哨兵键入 → 死会话评估）。v1 轮 prod-1 误点事故与结构修复（TINYSSH_AUTOCONNECT dev 门禁零主机卡点击、位置点击仅限模态遮罩内与终端区、事后审计 DB 主机 id 断言）见 §5.23 披露与记忆档。

**v2 残留真机旁证（2026-10-01 22:27，无截图但审计确凿）**：

- AUTOCONNECT 目标经 DB 实查核验：`h-556e559b` = e2e-sshd（127.0.0.1:2222, root）；prod-1 = `h-53bf3bcb`（10.0.0.11）、腾讯广州 = `h-fc2edb62`（193.112.219.133），无混淆。
- 容器重建后**指纹 Changed 门在真实 app 如期触发**：审计 `host_key_confirm_requested`（新指纹 `SHA256:+plkpp…` ≠ 库内 `SHA256:wD4pZqe…`）。
- 脚本找不到窗口提前退场（当时误判为显示器休眠，真根因见下）后，**120s 超时路径干净走完**：报错「主机指纹验证失败（确认超时）」、app 存活不崩。

结论：指纹门「会弹、超时语义正确、不崩」已在真机成立。**待验四步**：确认点击→建会话、终端哨兵键入落盘、⌘F 焦点旁证（容器 history grep = 0）、死会话 native Ctrl 后 app 存活。

**03:48 / 03:50 / 06:31 三次自动触发（watcher 门禁全部正确执行，冒烟在窗口发现/锁屏处安全中止）**：

- 审计确证三次 TOFU 门均如期挂起（`host_key_confirm_requested` @ 22:27:35 / 03:48:59 / 03:50:10 / 06:31:21，指纹 `+plkpp…` 持续 ≠ 库内）——app + AUTOCONNECT + 指纹门在真机无人值守下反复正常工作。
- **「找不到窗口」真根因（v1.22 勘误）**：不是显示器休眠——03:50 整屏截图（709KB 有真实内容）显示屏幕醒着，**宿主 ZCode 全屏占据内屏**，冒烟 app 窗口落在其他 Space，而 `CGWindowList OnScreenOnly` 不列其他 Space 窗口。
- 06:31（v4）窗口发现机制验证成功：激活后第 0 次尝试即在主屏找到窗口，但运行 19s 后撞上 **10 分钟空闲自动锁屏**（用户 06:21 离机，06:31:39 到锁屏点）——「锁屏=最硬中止」如期执行，现场清理干净。

**v4/v5 修复与门禁强化**：①启动后显式激活 app（`open` + System Events frontmost）并在全窗口列表中发现（含其他 Space）；②**主屏守卫**——窗口 x<0（外屏禁触区）即移回主屏、移不动即中止；③**前台 app 断言**——每次注入前断言前台 = tinyssh（堵「用户空闲」门禁不覆盖「宿主 agent 在跑且全屏在前」的洞，防把键入打进宿主 UI）；④新会话 host_id DB 断言（非 e2e 目标即中止）；⑤watcher 修复退出码日志（`$(date)` 命令替换吞 `$?`）+ 单实例守卫 + 中止自动重试（≤5 次，专治自动锁屏竞态）。既有保障不变：触发条件「未锁屏 + idle≥75s」（**锁屏永不触发**，最硬中止）、每步注入前 idle 二次门禁（含自家注入排除与首步洞修复）、容器 banner 就绪探测 + cargo 测试互斥锁、收尾与异常路径统一 pkill 清理。

**08:12 / 08:16 / 08:19 最终三轮（按钮坐标修正 → 确认命中 → 全链通过）**：

- **08:12（v5）**：TOFU Changed 模态完整渲染获截图目验（原/新指纹并列、中间人攻击警告、「我已核实，更新指纹并连接 / 拒绝连接」双按钮）——但确认点击按旧公式落在模态空白（点击前后三张截图字节相同）；实测主按钮中心 = 窗口 (56.7%, 63.3%)。模态截图因冒烟脚本每轮清场未及归档，以审计链与后续截图右栏「操作记录」回放为证。
- **08:16（v6）**：确认点击命中——审计 08:16:45 连落 `host_key_decision → host_key_trusted → session_created`，**新会话 host_id 断言 OK（e2e 目标）**；同时发现 AUTOCONNECT 会话 UI 不自动挂终端（界面提示「已有 1 个会话未接入终端——点击上方标签」）→ 哨兵键入落空。修复 = 冒烟补「点会话标签接入终端」步骤。
- **08:19（v7，指纹已信任故无模态，直通全链）**：**全部断言通过**。

**v7 断言明细（日志 + 截图 + 审计三重证据）**：

1. **建会话**：AUTOCONNECT → `session_created` + host_id = e2e-sshd DB 断言 OK；
2. **终端接入**：点会话标签 → 标题栏「e2e-sshd — TinySSH」、会话卡「已连接」、真实容器提示符 `d45058837cfe:~#`、现场简报「当前目录 /root 已核实」（[t28_terminal_attached.png](screenshots/t28_terminal_attached.png)）；
3. **哨兵键入 PASS**：CGEvent 真实键入 `touch /tmp/t28-*.touch`，终端回显可见、容器内落盘核实（[t28_sentinel_search.png](screenshots/t28_sentinel_search.png)）；
4. **⌘F 搜索面板真机打开**：搜索框 + ↑↓× 导航可见（同图右上）——T16 真机旁证；
5. **死会话 → 自动重连 → 重确认（受限）→ native Ctrl+C → app 存活**：容器侧杀 sshd 会话 16 秒后会话自动重连并进入重确认（简报「重连成功，进入重确认」「普通动作被拒，仅内置只读核实」——T13+T23 语义真机复现），Ctrl+C 以 `^C` 回显、app 无崩溃（[t28_dead_reconnect_ctrl.png](screenshots/t28_dead_reconnect_ctrl.png)）。

**T28 判定：通过**。如实披露：

1. **⌘F 搜索焦点真机复验 = 不结论**：history 探针自身设计失效（`docker exec bash -lc history` 起全新 shell，内存历史不跨进程、恒返 0——探针 bug，非产品 bug），且截图中 webapp 既未出现在搜索框也未回显到终端。T22 搜索抢焦修复以 v1.15 浏览器级走查结论为准；真机复核需换探针（xterm 屏面捕获断言）后另测。
2. **TOFU FirstSeen 门真机路径未测**（真机只发生过 Changed——容器曾重建换钥匙）；Changed 确认路径已由 08:16 轮完整实证。如需复现模态：重建容器即再触发。
3. **AUTOCONNECT 会话不自动挂终端**为 dev 门禁的工具性缺口，非产品 bug——真实用户点主机卡建会话即接入终端（v1.2 起历轮真实 app 走查反复实证）。
4. **v1 prod-1 误点事故**（本节最大教训）完整记录见 §5.23 披露与记忆档；由此确立的门禁体系（建连零主机卡点击、注入前前台 app 断言、主屏守卫、host_id DB 断言、锁屏/idle 双门禁、watcher 重试）在全程 9 次自动触发中零违反。

### 5.25 模拟用户产品验证轮（T30，v1.25）—— PV 预演，非真人 gate

**性质与边界**：validation-plan §6 的 PV gate 需要**真人**参与者（复述准确、一周真实回用需真人真时间）；本轮以 6 个 subagent 人格在主持手册协议下完整预演（[报告](../pv/2026-10-02-simulated-pv/report.md)）。S1 基线走**真实沙箱**（pv_env 故障注入、真 shell 真修复、真实判据验收——6/6 成功：A 组等号空格 crash-loop、B 组 DEST_DIR 不符规范），S2/S3 走浏览器 demo（TOFU/2FA/审批三态/接管→交还语义为真，故障回显为模拟）；顺序按招募序交替、S1 以 flock 串行共享容器、参与者全程黑盒（不读源码），伪影甄别由编排者对照源码统一执行。

**Gate 矩阵（pv_analyze 实算，N=6）**：①完成全部任务 6/6 ✓ 但严格「偏好原型」1/6（5 人「看情况」且条件高度一致：批量/留痕/委派类任务用原型）✗；②复述准确 5/6 ✓（唯一不及格系 demo 静态简报伪影）；③一周回用（模拟意图）6/6 ✓；④新任务自发交接闭环 **6/6 ✓**（用法各异：政策亲读、批量抽查、危险命令手闸、破坏动作前核对——核心假设信号为正）；反模式：全批 0、回避交接 0、抱怨打断 1（轻度）。**出口建议（脚本）：调整交互再测**——与「先修留痕呈现再进真人轮」的改进方向一致。

**甄别后的真产品问题（9 项，已在真实源码定位）**：R1「编辑后批准」实际放行命令无处核对（edited 参数真实传递但 UI 不渲染，P1 级信号 3/6 独立命中）；R2 操作记录行无主机/会话维度（DB 有 session_id UI 不显示）；R3 双接管按钮无解释（3 人独立）；R4 取消 2FA 被映射成「用户名或密码不正确」（AuthFailed 一律同文案）；R5-R8 小项（placeholder 示例文案、⌘F 无可见入口、简报提示截断、主机名点击进编辑）；R9 设计项——人类→Agent 委托入口缺失（4/6 提出，V0 边界内，V1 候选「交接留言/目标栏」）。

**甄别出的 demo 伪影（不记产品账）**：简报静态串场（T27 已披露的残余）、终端打字不入审计（demo send_keys 不审计；真实 app T12 已实现人类命令捕获）、时间戳三时钟混排、及一例**实证证伪**的 P1 误报——「人工拒绝被接管改写为已作废」经 playwright 复现证明拒绝原样保留（[复现截图](screenshots/pv_deny_takeover.png)），误读由种子作废卡混排+时间倒挂诱导，归入呈现层改进。

**T30 判定：通过（作为预演）**——协议、任务卡、工具链、分析管道端到端可执行；产出高收敛且经甄别的发现集；真人 PV 的 gate 判定仍待招募后执行，本轮 R1-R4 建议为开测前修复项。

### 5.26 PV 发现修复轮：R1–R4 留痕呈现（T31，v1.26 判定：通过）

§5.25 的出口建议是「先修留痕呈现再进真人轮」——本轮将 R1–R4 全部修复（R5–R8 小项与 R9 设计项不在此轮）：

- **R1 编辑后批准的实际放行命令可核对**：core `decide_approval` 审计从 `{decision: Debug 串}`（command/session 双空）改为**带 session_id + 实际放行命令 + 小写 decision**（`approve`/`approve_edited`/`deny`；编辑后批准以 edited 文本入 command）；UI 时间轴标签区分「批准 / 批准（编辑后）/ 拒绝」并渲染命令，「最近处理」行对 approved_edited 显示 `edited_command`（实际放行文）而非原始请求。**配套发现并修复 pv_analyze 既有指标 bug**：`norm_decision` 的前缀表（approved/denied/edited）与 Debug 串（Approve/ApproveEdited("…")/Deny）一个都匹配不上——真实沙箱数据 approved/edited 桶恒为 0（T25 起潜伏，模拟轮未暴露因 demo shim 不带 payload）；已改显式映射兼容新旧两格式（8/8 断言）。
- **R2 操作记录带主机维度**：时间轴行按 `session_id → sessions.host_name` 映射渲染主机 chip（`approval_decision` 后端补齐 session_id，其余会话级事件 DB 原有）；边界如实披露：已关闭会话（从 manager 移除）的历史行映射不到主机，显示为无 chip。
- **R3 双接管按钮语义可读**：两按钮加 title 悬停解释 + Agent 持有控制权时顶栏下常显一行解释（`ctl-hint`：接管＝冻结 Agent、待审批作废，跑着的命令不中断 · 接管并停止任务＝再尝试停止）+ 控制权徽标 title。选轻量修法（不加确认步——紧急停止场景不宜加摩擦），真人轮复测。
- **R4 取消 2FA 不再误报凭据错误**：demo shim 取消路径原抛 `AuthFailed`（P06 实际看到的文案陷阱根源；真实产品本走 `ConnectFailed("…人工应答被取消")`）——改为与真实产品同串（补「或超时」使超时路径不被冤枉），`friendlyError` 新增规则渲染为「2FA 认证未完成：人工应答被取消或超时，连接已中止（凭据未被改动，可重新连接）」。

**走查（demo 渲染层断言 + 截图目验，全部通过）**：①R3——接入 prod-1 后 `.ctl-hint` 常显解释行 + 双按钮 title 断言 + 徽标（[r3_takeover_hint.png](screenshots/r3_takeover_hint.png)）；②R1+R2——第一张审批卡「编辑后批准」改写为去掉 `rm -rf` 段的命令并保存：最近处理行与操作记录新行均显示「批准（编辑后）+ 实际放行文 + 主机 chip」（[r1_edited_approval.png](screenshots/r1_edited_approval.png)）；③R4——otp-1 连接 → 指纹门（门序正确）→ OTP 提示 → 取消认证：错误框显示 2FA 文案而非「用户名或密码不正确」（[r4_cancel_2fa.png](screenshots/r4_cancel_2fa.png)）。demo shim 同步对齐（audit 带 session_id/payload_json、decide_approval 镜像真实 `mark_edited` 语义：原始请求保留 command、放行文入 edited_command、终端回显放行文）。

**回归**：cargo **68/68 全绿**（带 `TINYSSH_E2E_SSHD=1` 守卫，e2e_acceptance 5 项 81.7s 实跑未跳过）+ UI `tsc && vite build` 通过。

**T31 判定：通过**——R1–R4 修复项全部落地并走查；真人 PV 开测前的工程侧改进完成，R5–R8（小项）与 R9（V1 候选）留待 PV 后按需。

### 5.27 视觉 polish 轮（T32，v1.27 判定：通过）—— 专业观感补课，不动交互契约

T31 交付后对照专业 SSH 客户端（Termius/iTerm2/Warp）做了一轮视觉评估（demo 9 状态截图目验 + 真机窗口 + Dock 图标），结论：交互与信息设计已达专业水准，视觉完成度差一层皮——外观直接进真人轮会系统性污染偏好数据。本轮为**纯 UI 层 polish**（不动 core、不改交互语义）：

- **应用图标**：原 Dock 图标为纯色绿方块占位——重绘为 macOS squircle 深色底 + 青色描边终端窗 + 提示符与光标块（[icon.svg](../../src-tauri/icons/icon.svg)，sips+iconutil 生成全套 icns），`tauri.conf.json` bundle.icon 增列 icns。
- **线性图标体系**：新增 `ui/src/icons.tsx`（14 枚 lucide 风格 24×24 描边组件），替换全部「文字凑的假图标」：显示设置 Aa→sliders、标签页 ◫/✕→split/x、⏹ 中断→stop、＋/－/✕→plus/minus/x、主机卡 ✎/✕→pencil/trash、搜索 ↑↓✕→chevron/x、传输 ↑↓→upload/download、拖拽遮罩 ⇩→download。分界原则：**控件用图形、行文状态记号（✓/✕/⚠）保持文本**；title/aria-label 全保留。
- **交互反馈层**：全站按钮/输入/标签页统一 0.12s 过渡；primary/ghost/danger/warn/ghost-danger 五类 hover 提亮；`:focus-visible` 焦点样式（按钮 outline、输入框 border+ring）+ `prefers-reduced-motion` 降级。此前 styles.css 仅 5 条 :hover、零 transition、零焦点样式——「硬切」是内部工具感的最大来源。
- **顶栏按钮层级**：「接管并停止任务」从实心红降为描边 `ghost-danger`，与实心「接管」拉开主次——危险升级动作不应与主动作同等视觉权重（评估 P2-5）；R3 的常显解释行与 tooltip 原样保留不回退。
- **欢迎页空状态重设计**（评估 P2-6）：文本堆 → 居中品牌卡：终端图标 mark + 标题/副标题 + 连接/操作/多会话/传输四条标签引导（悬挂对齐）+「添加主机」「导入 ~/.ssh/config」快捷动作 + 未接入会话提示；顺带修复欢迎页被 `#term` 层遮挡不可交互的层级问题（补 z-index）。
- **细节**：~/.ssh/config 导入行重构为「名称行 + 等宽地址行」紧凑双行（原 checkbox 与名称视觉分离）；MCP 端点长 URL `word-break` 防撑破（评估 P2-8）。

**走查（demo 浏览器逐屏截图目验，全部通过）**：欢迎页空状态（[t32_welcome.png](screenshots/t32_welcome.png)）、会话态顶栏层级与全量图标（[t32_session_topbar.png](screenshots/t32_session_topbar.png)）、主机卡 hover 图标操作（[t32_host_ops_icons.png](screenshots/t32_host_ops_icons.png)）、设置面板（[t32_settings_icons.png](screenshots/t32_settings_icons.png)）、导入面板行布局（[t32_import_rows.png](screenshots/t32_import_rows.png)）；hover 提亮经鼠标悬停截图实证，focus-visible 与 ghost-danger 规则经 CSSOM 断言入库（4 条）、过渡 0.12s 计算样式生效。**披露**：IAB 走查环境真实键盘路径不可用（Tab 被 app 按键层拦截），焦点圈的真机目验列为日常顺手确认项。

**回归**：cargo **68/68 全绿**（带 `TINYSSH_E2E_SSHD=1` 守卫，e2e_acceptance 5 项 148.6s 实跑未跳过）+ UI `tsc && vite build` 通过。

**T32 判定：通过**——专业观感第一批（图标 / 图标体系 / 反馈层 / 按钮层级 / 空状态 / 细节）落地；评估中的 P1-4（原生标题栏集成）与 P2-7（浅色 chrome）单独排期，真机 Dock 图标观感列为顺手确认项。

### 5.28 标题栏融合与排版精致化轮（T33，v1.28 判定：通过）

T32 后复评确认「工程精致、产品精致还差一档」，粗陋感收敛到三个来源：①默认原生标题栏与自家顶栏双层皮（真机第一眼最大破绽，浏览器走查不可见）②主机卡 CJK 逐字腰斩、信息层级平 ③空态/主题选择器/间距标准不一。本轮全部处理：

- **P1-4 原生标题栏融合**：`tauri.conf.json` 窗口配置 `titleBarStyle: "Overlay"` + `hiddenTitle: true`（内容顶到窗口顶端、红绿灯悬浮在自家顶栏上、标题文字隐藏——T16 的动态窗口标题仍供 Mission Control/⌘Tab 使用）+ `theme: "Dark"` + `backgroundColor: "#10141a"`（原生菜单/滚动条走深色外观、启动无白闪）。左栏头（`.head-left`）为红绿灯落位预留 76px，且**仅原生模式生效**（`inTauri` 探测挂 `native-chrome` 类，浏览器 demo 不留白）；「导入 ~/.ssh/config」「添加主机」两个全文字按钮收成图标钮（IconUpload/IconPlus，开合态切 chevron，title/aria-label 全保留）腾出落位空间；三条 `panel-title` 头挂 `data-tauri-drag-region`（共 8 处：三条头 + 标题/留白 span）成拖拽区——标题文字 `user-select:none` + 箭头光标（标题栏语义），按钮点击不受影响。
- **主机卡信息层级与断行禁则**：主机名改 `host-name` 主行（粗体 + nowrap + ellipsis——修复 hover 出现操作钮时「prod-1 · 密/码」被挤压逐字腰斩）+ 认证方式降为 `auth-tag` 徽章（密钥/Agent/密码），行文「· 密码」退役；会话卡主机名复用同一规则。
- **空态拉齐**：icons.tsx 增至 17 枚（新增 IconInbox/IconClock）；审批 / 现场简报 / 操作记录三处空态统一 `.empty`（图标 + 一句话），与 T32 品牌化欢迎页同一语言。
- **主题选择器收紧**：四主题从竖排大按钮改 2×2 网格（面板 260→280px、色板 32×20→26×18、标签单行不折行），高度减半。
- **间距刻度**：三栏 `panel-title` 头统一 min-height；全站间距维持 4/8/12 网格，未引入新刻度。

**走查（demo 断言 12/12 + 截图 6 张 + 真机窗口被动验证）**：
- **demo 断言**：`native-chrome` 类仅原生模式存在（浏览器无）；`.head-left` padding 12px→（手动加类模拟）76px→还原 12px；拖拽区属性 8 处；`host-name` nowrap/ellipsis/粗体计算样式全对；`auth-tag` 4 枚文本正确且无「· 密码」行文残留；`.empty` 图标态在简报空态实证；主题网格 2 列；图标钮 aria-label 正确。
- **demo 截图**：整体欢迎页（[t33_welcome_full.png](screenshots/t33_welcome_full.png)）、红绿灯留白模拟（[t33_native_sim_topleft.png](screenshots/t33_native_sim_topleft.png)）、主题 2×2 单行（[t33_settings_themes.png](screenshots/t33_settings_themes.png)）、审批清空后「最近处理」态（[t33_approval_empty.png](screenshots/t33_approval_empty.png)——demo 种子含已处理历史，审批的字面空态在 demo 不可达，该空态以 CSSOM 规则 + 简报空态实证披露）、主机卡特写（[t33_host_cards.png](screenshots/t33_host_cards.png)——「prod-2（演示…」截断省略号即断行禁则生效）、会话态全景（[t33_session_view.png](screenshots/t33_session_view.png)）。
- **真机窗口（本轮主角）**：debug 构建真机启动——**红绿灯嵌进左栏头、双层皮标题栏消失**（全窗 [t33_native_titlebar_fused.png](screenshots/t33_native_titlebar_fused.png) + 特写 [t33_native_traffic_lights.png](screenshots/t33_native_traffic_lights.png)）；审批/简报空态在真实数据下同样呈现；hiddenTitle 与深色外观生效。**过程披露**：①首次无 env 启动触发钥匙串授权弹窗（§6.3 既有行为）且进程阻塞于 keyring 读取——终止该实例并将其弹窗点「拒绝」清理（不输入密码、不落钥匙串），复用回归同款 `TINYSSH_MASTER_KEY` 环境变量启动成功；②CGWindowList 对该 app 的辅助窗口报告失真，窗口 frame 以 AX API 为准（主屏 221,71 · 1280×800）；③全程零键鼠注入（HIDIdleTime 门禁检查通过），仅进程启动 + 窗口激活 + 只读截屏，验证后进程退出。
- **已知边界**：拖拽区的拖动/双击最大化是 Tauri 内建行为，未脚本验证（真机日常顺手确认）；窗口压到最小宽度 960 时左栏头 76px 留白会使图标钮换行（可用性优先的可接受降级）；浅色 chrome（P2-7）仍单独排期。

**回归**：cargo **68/68 全绿**（带 `TINYSSH_E2E_SSHD=1` 守卫实跑）+ UI `tsc && vite build` 通过。

**T33 判定：通过**——「精致化」最后一段（标题栏融合 + 排版细节）落地；真人 PV 前工程侧无已知观感负债。

### 5.29 专业外壳收尾与信任可查证轮（T34，v1.29 判定：通过）

T33 后继续向「专业、可信任」推进。评估定位三个残余信号：①macOS 菜单栏还是 Tauri 默认英文菜单（App/File/Edit/View/Window/Help）——每张截图都带着未完成感；②产品版本号仍为 0.1.0（关于面板露馅）；③TOFU 主机指纹只在首连/变更弹窗可见，信任建立后无处查证——「可信任」要求事后可查。本轮全部处理：

- **原生菜单栏定制**（main.rs `install_native_menu`）：替换默认菜单为 **TinySSH / 编辑 / 显示 / 窗口** 四组；预定义角色项**显式传中文标签**——真机首验发现本机系统语言为英文时不传标签会得到「About tinyssh-app / Hide / Quit」（app 名还取的是进程名），与中文子菜单标题混排，实修为全中文。「设置… ⌘,」为自定义项 → menu 事件 → 前端 `menu-settings` 打开显示设置面板；「关于 TinySSH」带版本号与中文 credits（安全声明：主机凭据与 Agent 令牌经本机钥匙串加密存储，协作与审计链完整留存于本机）。**有意不设**：「关闭窗口 ⌘W」（该键已被应用内标签页语义占用，避免双触发）与「重新加载」（整页刷新会杀死全部会话 UI 状态）；编辑菜单保留标准剪贴板角色（与原默认菜单行为等价，终端 ⌘C/⌘V 语义不回归）。菜单随系统语言动态本地化列 V1。
- **版本号 0.9.0**：workspace Cargo.toml / tauri.conf.json / package.json 三处 0.1.0→0.9.0（MVP 收口语义）；设置面板底部新增版本行（`getVersion()` 同源；浏览器 demo 显示「TinySSH · 浏览器演示模式」）。
- **信任可查证（指纹贯通）**：`Host.fingerprint: Option<String>` 字段 vault→session-api→UI/CLI 四层贯通（`list_hosts` SELECT 补 `host_fingerprint` 列，空串归一 None）。主机卡 tooltip 出示 `指纹：SHA256:…`（未建立则「首次连接时确认」）；主机编辑表单新增信任状态行——已信任显「✓ 主机指纹已信任（首次连接时确认）+ 指纹原文（可选中复制）」，未建立显「主机指纹尚未建立——首次连接时会出示并要求确认」；CLI `tinyssh host list` 增指纹列（`-` = 未建立）；core_local 的 TOFU 测试补「accept 后 `list_hosts` 携带指纹」断言（GUI/CLI 同源可查证进入自动化守卫）。demo 种子 prod-1 与其「已信任」演示语义一致地补指纹。

**走查（demo 断言 4/4 + 截图 2 张 + 真机门禁内最小注入）**：
- **demo 断言**：4 张主机卡 tooltip 指纹两态正确（prod-1 带指纹、其余「首次连接时确认」）；编辑 prod-1 信任行 ✓ 文案与指纹原文精确匹配；编辑「本机」信任行不出现且「尚未建立」提示在场；设置面板版本行「TinySSH · 浏览器演示模式」。截图：编辑表单信任行（[t34_host_trust_row.png](screenshots/t34_host_trust_row.png)）、设置面板版本行（[t34_settings_version.png](screenshots/t34_settings_version.png)）。
- **真机**：菜单栏实拍 ** TinySSH 编辑 显示 窗口**（[t34_menubar.png](screenshots/t34_menubar.png)，默认英文菜单消失）；AX 菜单结构断言全组通过（TinySSH 组=关于/设置…/隐藏/隐藏其他/全部显示/退出；编辑组=撤销/重做/剪切/拷贝/粘贴/全选；显示=全屏；窗口=最小化/缩放/前置全部；**无「关闭窗口 ⌘W」与「重新加载」**）。空闲门禁通过（523s/548s ≥75s）+ 前台断言下，共 **2 次菜单点击**（应用自身菜单栏项，零主机连接）：①点「设置…」→ app 日志 `[app] menu: settings requested` + 设置面板打开实拍、版本行 **TinySSH v0.9.0**（[t34_menu_settings_e2e.png](screenshots/t34_menu_settings_e2e.png)——原生菜单→事件→前端端到端实证）；②点「关于 TinySSH」→ 原生 About 面板实拍（[t34_about_panel.png](screenshots/t34_about_panel.png)：TinySSH · Version 0.9.0 · 中文安全声明）。
- **披露**：①About 面板图标为系统默认文件夹——debug 裸二进制运行无 bundle 目录，T32 的 icns 在 bundle 产物中生效；②编辑菜单尾部 AutoFill/听写/Emoji 为 macOS 向编辑菜单自动附加的系统标准项（专业 app 同款），非应用文案；③验证后进程退出，无孤儿弹窗残留（SecurityAgent 无进程）。

**回归**：cargo **68/68 全绿**（`TINYSSH_E2E_SSHD=1` 实跑，0 failed）+ UI `tsc && vite build` 通过。

**T34 判定：通过**——「专业」外壳收尾（原生中文菜单 + 版本口径）与「可信任」实质（信任建立后可查证）同轮落地；菜单随系统语言本地化与 About 图标 bundle 化列 V1 顺手项。

### 5.30 浅色 chrome 适配轮（T35，v1.30 判定：通过）—— P2-7 收口，主题选择器全量生效

视觉 polish 系列唯一遗留的单独排期项（§5.27 评估 P2-7 / §6.20 主题作用域边界）：终端主题自 v1.11 起有「浅色 / Solarized 浅色」，但界面外壳（三栏、弹窗、遮罩、阴影）恒为深色——选浅色终端即「白终端嵌黑壳」。本轮把 chrome 跟随终端主题，**深色现值逐字节不变**：

- **变量化收口**：styles.css 此前已高度变量化，剩余 20 处硬编码色全部收进变量——彩色底对比文字（`--on-accent/--on-danger/--on-warn`）、alpha 混合层（accent/danger 各 4 档 soft/ring/glow/line）、玻璃名牌（`--glass`）、遮罩（`--mask/--mask-plain/--scrim/--dead-scrim`）、阴影三档（`--shadow-soft/pop/dialog`）、欢迎页 mark 渐变（`--mark-grad`）、`--blue`。剩余裸色仅存在于三块调色板定义区（审计脚本复核）。
- **两套浅色调色板**：`[data-chrome="light"]`（配浅色终端：冷灰底 + 白卡片 + 深化青 #1f767c——原 accent 在浅底对比不足）与 `[data-chrome="solar-light"]`（配 Solarized 浅色：base2/base3 米色系 + Solarized 色相深化版）；accent/danger/ok/warn 全部深化到浅底 4.5:1 上下，彩色按钮文字换白/米白，遮罩/玻璃/阴影换浅色系。
- **联动**：`ThemePreset` 增 `chrome` 字段（dark/solar-dark→dark，light→light，solar-light→solar-light）；`changeTheme` 挂 `documentElement.dataset.chrome` 切 CSS 变量层，Tauri 下 `getCurrentWindow().setTheme()` 同步原生窗口外观（Overlay 红绿灯渲染、原生面板）——capabilities 补 `core:window:allow-set-theme`。偏好持久化沿用既有 `ui.theme` KV（跨重启恢复）。

**走查（demo 断言 + 截图 2 张 + 真机门禁内验证）**：
- **demo 断言**：深色基准（无 dataset 属性、body #10141a、accent #4fa3a5）→ 浅色（chrome=light、body #eaeef2、accent #1f767c、主机卡白底、主按钮白字、遮罩变量浅色系）→ Solarized 浅色（chrome=solar-light、body #eee8d5、accent #1a726b）→ **刷新后 localStorage 恢复 solar-light**（持久化路径）→ 切回深色**逐字节还原**（#10141a/#4fa3a5）。截图：[t35_light_chrome.png](screenshots/t35_light_chrome.png)、[t35_solar_light_chrome.png](screenshots/t35_solar_light_chrome.png)。
- **真机（临时 DB 隔离用户数据，门禁内 1 次键盘 + 1 次面板内点击）**：空闲 318s 门禁通过后 ⌘, 打开设置面板（**顺带真机实证 T34 菜单加速器端到端**）→ CGEvent 点击「浅色」→ **全窗翻浅、设置面板白色、选中态可见**（[t35_native_light.png](screenshots/t35_native_light.png)，原生窗口外观同步无报错）；杀进程重启同 DB → **直接以浅色启动**（vault 偏好加载 + 原生主题启动即生效）。过程披露：①⌘, 合成注入重置 HIDIdleTime（自家注入重置，等待 62s 复查 idle=88s 确认无用户活动后再注入）；②System Events `click at` 挂错命名空间报 -25208 未生效，改 CGEvent 鼠标事件投递成功（点击目标在设置面板内，遮罩兜底=关面板无副作用）；③验证用 `TINYSSH_DB` 临时库，用户真实 vault 未触碰，验证后进程退出、临时库删除。
- **已知边界**：`tauri.conf.json` 的 `backgroundColor "#10141a"` 与 `theme "Dark"` 仍是启动初值——浅色用户启动瞬间有一次深→浅闪烁（Tauri 不支持按偏好预置，V1 可在窗口创建前读 vault 解决）；chrome 跟随的是「终端主题」单一来源，无独立 chrome 主题选项（刻意简化，与编辑器配色一致的语义）。

**回归**：cargo **68/68 全绿**（`TINYSSH_E2E_SSHD=1` 实跑；Rust 零逻辑改动，仅 capabilities 加权限）+ UI `tsc && vite build` 通过。

**T35 判定：通过**——P2-7 收口，主题选择器四选一全部完整生效；视觉 polish 系列（T32/T33/T35）至此无遗留项。

### 5.31 真人上手验证与修复轮（T36，v1.31 判定：通过）

项目Owner本人按「真人验证清单」上手实测（2026-10-03），这是模拟 PV（§5.25）之后的首次真人走查。**实测通过的欠账项**：中文输入法组合输入上屏（§6.1-14 残余边界，真人确认正常）、真实键盘 Ctrl+C 中断、⌥词跳转/删词手感、窗口最大化/最小化（T33 拖拽区顺手项）、⌘=/⌘−/⌘0 字号。**实测揪出三个真缺陷，本轮全修**：

- **D1 密码主机全数「存储错误： decrypt failed」（D-高）**：连接腾讯广州报解密失败且审计零痕迹。根因链：①诊断实锤 vault 里三台密码主机的凭据 blob 全部由**开发期 `TINYSSH_MASTER_KEY` 封装**（临时库副本 + 07×32 解密全 Ok），而正式启动实例走钥匙串路径（§6.1-3 设计行为），密钥不同→`host_secret` 在指纹门之前即失败（「门前静默失败」，审计无痕是正确语义）；②9/28「曾连成」发生在 T17 指纹门上线前的旧构建（该会话审计只有 session_created 无任何 host_key 事件，且状态遗留 connected——旧二进制行为残留，非现存漏洞）；③服务器本身健康（TCP+系统 ssh 握手到认证层均通）。**修复**：a) `friendlyError` 对 decrypt 失败给出可行动文案（指明重输密码即可、多台同发=启动方式变更）；b) **编辑表单补「更换密码」栏**（T23 的 Keep 语义缺口——此前编辑态无任何凭据入口，换凭据只能删主机重加；现密码类主机编辑态出现「更换密码——留空保持原密码」，填写即经 `AuthDraft::Password` 重建加密 identity，留空保持原语义；密钥/Agent 主机维持原文案）。
- **D2 首屏三提示符错位、输入位置在中下方（D-高）**：attach 回放快照逐行写把光标推到屏底 + 「会话已接入」提示语直接写进终端流（带偏 shell 光标视角，后续输出全接在提示语后）+ 订阅先于快照回写（竞争窗口字节插队）。**修复**：①快照回写后按 `ScreenSnapshot.cursor_row/col` 用 CSI H 归位（resync 路径同修）；②提示语改为不占终端行的悬浮胶囊 `.attach-hint`（底部居中、6s 自动淡出、pointer-events 放行）；③先回放快照后订阅实时流。
- **D3 ⌘F 无响应（R6 现实版）**：搜索打开只挂终端焦点层，焦点在命令框等处时无响应且无可见入口。**修复**：⌘F 提升到全局捕获层（有活动会话即生效）+ 终端顶栏新增可见搜索钮（IconSearch，与显示设置钮同排）。

**走查（demo 断言 4 组 + 截图 3 张）**：接入演示会话——`.attach-hint` 胶囊在场且**不在** `.xterm-rows` 终端文本内、6s 后自动消失、终端首屏从顶部提示符开始且光标紧跟其后（[t36_attach_hint.png](screenshots/t36_attach_hint.png)）；顶栏搜索钮 1 枚、点击即开 `.term-search` 且输入框获得焦点（[t36_search_button.png](screenshots/t36_search_button.png)）；prod-1（密码主机）编辑表单含「更换密码」栏 + 留空保持文案 + 信任行指纹三要素（[t36_edit_password_field.png](screenshots/t36_edit_password_field.png)）。

**真机复验增记（v1.32，Owner 当日）**：①⌘F 全局键路径（焦点在命令框等任意处弹搜索）与②首屏光标归位（重连腾讯广州=一行提示符在顶部、光标紧跟其后）均复验通过；③**TOFU FirstSeen 真机链路顺带实证**——腾讯广州首连经真实 vault 走完整门链（host_key_confirm_requested → decision → trusted → 会话建立，审计全链可查），T28 披露的「FirstSeen 真机未测」销账。本轮 Rust 零改动（vault 本就支持 `AuthDraft::Password` 更新路径，纯 UI 补口）。

**已知边界新增（§6.1-27）**：开发期（带 `TINYSSH_MASTER_KEY`）实例与正式启动（钥匙串）实例的主密钥不同，前者加密的凭据后者读不开——报 decrypt failed 并指引重输；PV 分发构建统一走钥匙串路径，不受影响。

**回归**：cargo 全量带 `TINYSSH_E2E_SSHD=1` 守卫（Rust 零改动，确认无环境性回归）+ UI `tsc && vite build` 通过。

**T36 判定：通过**——首次真人上手即验证了「模拟 PV 不可替代」：三个缺陷全部来自真人直觉场景（换启动方式、首屏视觉、焦点直觉），均已修复并入守卫/走查。

### 5.32 UI 精致化改造（T37，v1.33 判定：通过）—— 对照设计规格文档全量落地

以 `docs/ui-redesign-spec.md`（诊断 → token → 组件 → 优先级 P0–P3 的完整规格）为蓝本的一轮纯视觉层改造，**Rust 契约与 Tauri command 零改动**（仅 `tauri.conf.json` 窗口 `backgroundColor` 同步新 `--bg` 防启动闪色）。规格诊断的三个系统性问题——Surface 层次不足（三面板色糊在一起）、所有动作等权重（每卡常显实心「连接」）、警告状态混排面包屑——逐项落地：

- **色彩 token**：`--bg/panel/panel2` 层次拉开（bg 加深至 `#0c1017` 让面板浮起），新增 `--panel3`（hover 提亮档）与 `--text-sub`（三级文字：text/text-sub/dim），accent 降饱和至 `#3d9da8`；浅色与 Solarized 浅色两套色板同步补齐新变量。**主动决策一处**：placeholder 未按规格用 `--dim`——新 dim 在面板实算仅 3.4:1，会把 T24 修过的 AA 对比打回不及格，改用 `--text-sub`（≈6:1），代码注释写明原因。
- **主机卡重设计**：去常显卡片壳改列表行（透明底融入侧栏），hover 浮 `--panel3` 背景 + 右侧操作组浮现。**落地修正一处规格未预见的问题**：操作组若占布局宽度，220px 侧栏里主机名被挤成「pr…」——改为绝对定位覆盖（衬 panel3 底防文字透出）+ `pointer-events:none` 防幽灵点击 + `:focus-within` 保键盘可达 + 连接中（disabled）常显。
- **Notice Bar 体系**：原 `ctl-hint` 接管说明行改 `.notice-bar.info`；新增 `Reconfirming` 受限态 `.notice-bar.warn`（⚠ 重确认中——普通操作暂停，仅允许只读核实命令），状态类信息不再与面包屑混排。
- **标签页 pill 化**、**操作记录 Timeline**（竖轨 + actor 圆点 + 时间戳/动作分行 + 命令 mono chip）、**现场简报 fact 块**（dashed 行改认知色轻底块 + epistemic-badge，旧 `epistemicClass`/`.tag-*` 死代码清除）、**主机列表首载 skeleton**（含 reduced-motion 降级，空态文案改为加载完成后才出现）。
- **§六 交互 + P3 Toast**：控制权徽标重设计（Agent 持有=amber `● Agent 控制中` 警示、我持有=accent `● 我控制中` 安定；「交还 Agent」降 ghost 拉开与接管的层级——「接管」保留 warn 实心，PV R3 定下的中断语义不改）；Toast 系统落地（右下角 2.6s 自消、ok/err/info 三色条、同屏至多 4 条、aria-live；接入点=连接/重连/接管/交还即时反馈 + 传输 `running→done/failed` 迁移侦测——ref 对比上一轮状态，避免 StrictMode 双发；连接失败保留 conn-error 常驻横幅不重复打扰）。
- **布局**：三栏定宽 220/弹性/280，左右栏铺 `--panel` 底色；分组标题去 uppercase 靠留白分组。**OSC 标题未按规格从顶栏移除**——T16 验收硬依赖头部显示远程标题，保留。

**走查（demo 截图 5 张 + 构建通过）**：初始列表态与 hover 浮现（[t37_dark_overview.png](screenshots/t37_dark_overview.png)、[t37_host_hover.png](screenshots/t37_host_hover.png)）、会话接入态（info notice-bar、pill tab、简报徽标、Timeline 实拍，[t37_session_dark.png](screenshots/t37_session_dark.png)）、浅色主题无断裂（[t37_light_chrome.png](screenshots/t37_light_chrome.png)）、接管后徽标翻转 + 交还 ghost 化 + 接管 toast 上屏（[t37_takeover_toast.png](screenshots/t37_takeover_toast.png)）。披露：warn 变体 notice-bar（Reconfirming）demo 无触发路径未实拍，样式与 info 同族仅换色。

**回归**：cargo 全量带 `TINYSSH_E2E_SSHD=1` 守卫（Rust 零改动，确认无环境性回归）+ UI `tsc && vite build` 通过。

**T37 判定：通过**——规格文档 P0–P3 + §六全部收口，「专业感」跃升的三处根因（层次/权重/警告淹没）均有对应落地与截图实证。

### 5.33 R5–R8 收尾 + R9 任务委托 + GBK 编码 + 模拟 PV 验证与修复轮（T38，v1.36 判定：通过）

三段交付 + 一轮模拟真人产品验证（4 人格 subagent 黑盒走查）+ 一轮发现修复，UX 路线图至此全部关闭。

**v1.34（R5/R7/R8 + R9）**：①R5–R8 走查遗留小项收口——添加主机表单名称/地址补「例：…」placeholder（R5）、现场简报长文本换行可读（R7）、主机卡主体大点击目标直连（R8，编辑/删除留在 hover 操作组）。②**R9 人类→Agent 任务委托入口**（原 V1 候选，提前落地）：`SessionHandle.goal`（随会话存亡的临时留言）经 `SessionBrief.goal` 下发，`set_session_goal` 为人类专属写口（Agent 只读），写操作审计 `goal_set` 留痕；MCP `get_session_brief` 描述引导「接管后先读 goal 了解人类委托意图」。UI 右栏新增「任务目标」区（传输与现场简报之间）：编辑中不被简报轮询覆盖（dirty ref）、保存按钮三态禁用（内容未变即禁）、清除按钮仅在有目标时出现、保存/清除即时 toast + 时间线留痕。demo shim 全语义对齐（种子会话 s-demo-0001 带种子留言）。走查 `ui/t38_goal_walkthrough.cjs` 7 断言全过（[t38_goal_seeded.png](screenshots/t38_goal_seeded.png)、[t38_goal_saved.png](screenshots/t38_goal_saved.png)）。

**v1.35（GBK 远端字节编码，路线图⑩后半）**：`Charset` 枚举（utf-8 默认 / gbk，兼容 gb2312/gb18030 别名解析）。**边界原则**：GBK 尾字节落在 ASCII 可打印区（「中」=D6 D0，D0='0'），原始字节直接喂 vt 解析会毁屏幕状态——故**解码在建连泵边界**（`spawn_pump` 内 `CharsetDecoder` 流式解码，跨块半字由 encoding_rs Decoder 保持，连接关闭 flush 残余）、**编码在写边界**（`channel.write` 前 `GBK.encode`），两边界之内核心与 UI 只见 UTF-8；`register_outgoing` 登记原文 UTF-8（屏幕所见是远端回显的解码结果，登记须与屏幕一致）。vault **V4 迁移** `hosts ADD COLUMN charset DEFAULT 'utf-8'`（V2 host_fingerprint 同款门禁顺序迁移）。UI 添加/编辑主机表单「远端编码」下拉 + demo shim 对齐。e2e `gbk_charset_roundtrip_over_ssh`（docker sshd 真双向）：收路径 `printf '\326\320…'` 断言屏幕含「中文日志」；发路径 `echo 现场笔记 | od` 断言 GBK 字节序落线——**如实披露**：容器 shell 为 UTF-8 locale，readline 会丢弃非法 UTF-8 尾字节（od 实测少尾字节系容器 locale 语义，非本端缺陷，真实 GBK locale 主机无此行为），断言口径取前 6 字节。

**v1.36（模拟 PV 验证轮 + 修复轮）**：4 人格 subagent（新手运维/交班专家/细节控/老系统维护者）按真实使用路径黑盒走查 demo（报告：[docs/pv/2026-10-03-simulated-pv/](../pv/2026-10-03-simulated-pv/)），结论：novice 5 PASS + 表单下拉 FAIL，handoff 7 PASS（R9 全链路闭环），polish 总体 PASS（三栏 220/780/280 实测、placeholder 对比度 6.53:1/6.97:1、toast 堆叠≤4 与 3.2s 自消、浅色无回归），gbk 核心 4 PASS（默认值/文案/持久化双向回填）。**揪出并已修 8 项**：

- **表单下拉压窄（novice FAIL，唯一 FAIL 项）**：220px 侧栏三字段挤一行，两下拉收起态只剩 55px（选中值显示「密」「UT」）——编码下拉改独占一行（177px 全文可读）+ label 自带场景提示「（老设备中文乱码时选 GBK）」+ 用户名补 placeholder「例：ops 或 root」（[t38_pv_form_before.png](screenshots/t38_pv_form_before.png) → [t38_pv_form_after.png](screenshots/t38_pv_form_after.png)）。
- **主机卡中心点击被悬浮操作组拦截（handoff Q1，疑似阻塞级）**：`.host-card-side` 覆盖宽约 102px，220px 卡的几何中心落在按钮上——操作组整体收紧（gap/padding）至 ~80px，中心点击不再被截获；修复后 Playwright 默认中心点击直接发起连接（走查实测 tabs 3→4）。
- **GBK 主机列表不可辨（gbk Q1，真实痛点）**：主机卡名称行新增 `GBK` 徽章（复用 auth-tag 样式），卡片 title 追加「编码：GBK（中文 Windows / 老旧设备）」行（[t38_pv_gbk_badge.png](screenshots/t38_pv_gbk_badge.png)）。
- **任务目标 textarea 固定 2 行不自增（handoff Q3）**：随内容自动增高（上限 150px 转内部滚动），长委托留言可整体通读（[t38_pv_goal_autogrow.png](screenshots/t38_pv_goal_autogrow.png)）。
- **未保存草稿切标签静默丢弃（handoff Q2）**：草稿按 sid 暂存 Map，切走再切回自动恢复；保存/清除落盘后清除对应暂存。
- **会话卡截断名无提示（novice Q4）**：会话卡补 title 悬浮提示（`主机名 · 状态`）。
- **清除 toast 文案（handoff Q4）**：补「Agent 简报同步移除」让交班人确信对方不会再看到旧留言。
- **编辑按钮 tooltip 列举缺「编码」（gbk Q3）**：补齐。

**如实披露不修（5 项）**：①toast 存续期短暂遮挡右栏底部（2.6s 自消，可接受取舍）；②浅色 attach-hint 疑似半透明帧（hover 渐隐过渡中间帧，非稳定态）；③skeleton 首载未能实证（demo 加载过快，验证缺口非缺陷）；④**会话内临时切编码不做**——编码在建连时绑定于泵的流式解码器状态，会话级热切换等价于换解码器中途换轨（已解码半字状态无法迁移），需要临时编码请改主机编码后重连（V1 按需评估会话级覆盖项）；⑤hover 时地址行尾部仍被操作组遮一部分（收窄后缓解；列表行密度取舍，地址全文可看卡片 title）。gbk Q4 之问（charset 落盘读回是否有 e2e 覆盖）：有——`gbk_charset_roundtrip_over_ssh` 经 vault upsert→list→create_session 读回链实证。

**走查（修复验证 10/10 断言 + 截图 9 张）**：`ui/pv_fix_verify.cjs`——用户名 placeholder、编码下拉独占行宽 177px、label 提示、GBK 徽章 + title 编码行、中心点击直连、会话卡 title、目标框自动增高 48→84px、草稿切签恢复 93 字、清除 toast 新文案全过。证据归档 [t38_pv_*.png](screenshots/)（表单前后对照/GBK 徽章/编辑回填/toast 堆叠/浅色会话/Timeline goal_set 留痕等）。

**回归**：cargo 全量带 `TINYSSH_E2E_SSHD=1` 守卫 EXIT=0 + UI `tsc && vite build` 通过（本轮修复为纯 UI 层，Rust 零改动）。

**T38 判定：通过**——UX 路线图⑩后半（GBK）落地即**路线图①–⑩全部关闭**；R9 把「人类→Agent 委托」从 V1 候选提前为可用能力；模拟 PV 四人组按真实路径走查的唯一 FAIL（表单下拉）与疑似阻塞项（中心点击拦截）均已修复并实证，残余 5 项如实披露。

### 5.34 独立审核与视觉复验轮（T39，v1.37 判定：通过）—— UI 重构的对抗性复核

T37/T38 的 UI 变更此前均为「作者自写自验」，本轮补上两个独立视角：**独立代码审核**（code-reviewer subagent，未参与编写，对抗性走查 `e8e8fa7^..HEAD` 全量 diff + demo shim 与真实后端逐字段比对，[报告](../ux/2026-10-03-t37-t38-code-review.md)）与**独立视觉复验**（全新 subagent，带测量复跑，[报告](../ux/2026-10-03-t37-t38-visual-recheck.md)）。审核结论「有条件通过」——挖出 **1 阻塞 + 1 高**，再次印证 §5.1 以来的规律：独立复核总能发现自证盲区。

- **B1（阻塞，已修）Charset 线格式三方断点**：`Charset` 用 `rename_all="lowercase"`，serde 对 `Utf8` 产出的线格式是 `"utf8"`（不插连字符），而 UI 每次保存主机都发 `"utf-8"`——真实 app 经 tauri serde 反序列化 HostDraft 必报 `unknown variant`，**保存任何主机（新建+编辑）必失败**；demo shim 恰好按 UI 口径放行掩住了它（demo.ts 头部警告的伪影类别，方向相反的实例）。Rust e2e 在 Rust 侧构造 HostDraft 绕过了 serde 边界，UI→tauri 这一层此前零覆盖。**修复**：显式逐变体 `rename = "utf-8"/"gbk"`（不用 kebab-case——serde 对 `Utf8` 数字边界分词存在 `utf8` 歧义风险），与 vault 列、UI select 三方对齐；**新增 wire 锁定测试** `charset_wire_format_matches_ui_and_vault`（按 UI upsert_host 实际载荷形态断言双向 + 缺省 + 拒收旧口径 `"utf8"`），挂在 T26 的 wire_format_tests 旁。真实 app GUI 三步走查（新建→读回→编辑回填）仍列顺手项——失败模式是纯 serde 线格式，已被锁定测试按 UI 载荷形态精确覆盖。
- **H1（高，已修）任务目标跨会话串台**：goalDraft/brief 无 sid 归属，切 A→B 时 A 的目标在 B 输入框停留一个轮询周期，随手保存即把 A 的委托写入 B（goal 是 Agent 执行依据，属安全相关写路径）；在飞简报迟到还会覆盖。**修复**两处：`refreshBrief` 落地前校验 `sidRef.current !== s` 即丢弃（顺带修好简报面板既有串台）；切会话无暂存草稿时立即清空输入框（绝不显示上一会话目标）。走查实证：切换后 100ms 内框值为空串、A 目标 47 字切回完好。
- **审核低危批（5 项已修）**：①GBK 徽章置主机名**之前**——原置行尾恰落入 hover 操作组覆盖区，准备连接的交互时刻反而不可见（bbox 实测 [20,52] vs 操作组 [111,203] 不相交）；②认知色淡底/描边 rgba 收进 token（`--warn/ok-soft`、`--warn-ring/line`、`--ok-line`、`--danger-faint`）并三套色板同定义——浅色下「认知色轻底块」从近乎不可见恢复为可辨（[t38_review_light_facts.png](screenshots/t38_review_light_facts.png)）；③goalDrafts 随会话关闭清理；④refreshLists 失败也撤骨架给出空态出口（原为永久骨架+未处理 rejection）；⑤takeover/handback/takeoverStop 失败 toast 补齐（会话刚死不再静默）。
- **对齐与打磨批**：demo `transitions` 机制对齐真实 `SessionHandle.transitions`（set_session_goal/set_control 推送与 core-session 逐字相同的变迁文案，简报「控制权」fact 改为最近 3 条动态生成——此前为静态单条，走查实证保存目标后简报即现「人类更新任务目标（Agent 读简报可见）」）；连接按钮 loading 补 12px spinner（规格 §六逐字对齐，reduced-motion 停转）；Timeline actor 配色从内联回类；err 级 toast 改 `aria-live=assertive`；死 CSS 清理（.label-* 四组、.notice-bar.danger、.badge.human/.dim 孤儿类）。
- **视觉复验收口**（38 项断言全 PASS）：**skeleton 首载首次实证**（请求延迟 1100ms 后 t=411–1425ms 捕 7 帧双骨架条、1547ms 撤除零残留、reduced-motion 停动画）——此前未捕到帧是窗口太短非功能缺失；**浅色 attach-hint「褪淡帧」定性为非缺陷**（双主题 23 点采样：settled 期 opacity 恒 1.000，褪淡发生在 4200–6000ms 设计内淡出窗）；三栏 220/780/280 与 placeholder 对比度独立复算一致；规格抽查 9/9（含幽灵点击双向命中测试、连接反馈 8.9–10.1ms）。**顺带收口**：浅色 `--dim` 加深一档（4.33→4.88:1，最浅底亦达 AA）、solar `--dim` 同步（3.64→4.85:1）——辅助说明也是要读的字。
- **披露不修**：saveGoal 失败文案走 friendlyError 兜底（SessionNotFound 等原始错误直出）；Reconfirming 警示条无 live region 播报（读屏用户不感知受限态切换，a11y 长尾）；传输卡片无清理入口（T20 既有）；prevTransferStatus 随 transfers 只增不减（同族既有行为）。

**走查（v1.37 验证 7/7 + 回归 17/17）**：`ui/v137_review_verify.cjs`（H1 切换清空/简报到达仍空/A 目标完好、goal 变迁进简报、GBK 徽章不遮挡且居名前、连接 spinner 捕捉）全过；`pv_fix_verify.cjs` 10/10 + `t38_goal_walkthrough.cjs` 7/7 回归无破坏。

**回归**：cargo 全量带 `TINYSSH_E2E_SSHD=1` 守卫 EXIT=0 + UI `tsc && vite build` 通过（Rust 改动仅 session-api Charset serde 属性与新增锁定测试）。

**T39 判定：通过**——独立审核的阻塞项（真实 app 主机保存必失败）与高危项（目标跨会话串写）均已根因修复并加锁定测试防回归；demo shim 语义保真度经逐字段比对后补齐 transitions 缺口；两份独立报告归档供追溯。

### 5.35 FR-2 密钥认证收尾（T40，v1.38 判定：通过）—— 生成 ed25519 / 指纹确认 / 文件导入

背景：对照 Termius 评估「是否已是专业可用的 SSH 客户端」时复核 FR-2，先前的「密钥认证缺失」判断被证伪——AddHostForm 自 v1.x 起就有 密码/私钥粘贴/Agent 三态选择器，`create_identity` 在真实 tauri 后端已注册（main.rs:52），vault 侧 `Generate` 亦有实现与单测。真实缺口收敛为三点，本轮全部收口：

- **生成 ed25519 入口**（PRD FR-2「导入 OpenSSH 格式 / 生成 ed25519 / 指纹确认」中间一项，后端就绪 UI 无入口）：私钥模式新增「生成新密钥（ed25519）」——零输入即可绑定，调 `create_identity { Generate: { label, kind: "Ed25519" } }`，vault 生成并加密落库，UI 只拿元数据（私钥永不出凭据库，FR-2「任何 API 不返回私钥明文」语义）。
- **指纹确认**（FR-2 第三项，此前 `create_identity` 回包的 `fingerprint` 被直接丢弃）：私钥绑定改为**先绑定后确认**流——粘贴/文件读入 →「导入并确认指纹」、或一键生成 → 出示 `SHA256:` 指纹 + 「已加密存入凭据库」确认行（复用 .trust-row/.fp 展示形态，与 TOFU/编辑表单指纹同款折行），保存时只引用 `identity_id`，明文与私钥都不随表单走。未绑定直接保存被拦截（「请先导入并确认指纹或生成新密钥」）。
- **从文件导入**：`label.file-btn` 包隐藏 `<input type="file">` + FileReader 回填 textarea——纯 Web 标准路径，浏览器 demo 与 Tauri WebView 行为一致，不引入 dialog 插件依赖；220px 侧栏内按钮纵排换行（实测无截断无重叠）。
- **demo 对账缺陷修复**（T39 独立审核方法论的直接复用——逐字段比对 shim 与真实语义）：`upsert_host` 新建路径此前**硬编码 `auth_type: "Password"`**，真实后端按 HostDraft.auth 推导——密钥/Agent 主机在浏览器走查里会顶错徽章。现按同一口径推导（`"Agent"`→Agent、`{Key:…}`→Key、`{Password:…}`→Password、`"Keep"`→保持原值）；`create_identity` shim 同步对齐 Generate/Import 语义（label/kind 随请求、指纹随序号唯一化）。
- **wire 锁定测试**：新增 `identity_and_auth_draft_wire_format_matches_ui`（挂 T26/T39 的 wire_format_tests 旁）——按 UI 实际载荷形态断言 `Generate`/`Import` 序列化、`"Agent"`/`{Key:{identity_id}}`/`"Keep"` 三态反序列化、`IdentityMeta` 回包（指纹确认直接依赖的字段），防 B1 类线格式漂移重演。

**走查（v1.38 验证 11/11）**：`ui/t40_keyauth_verify.cjs`——私钥模式三入口在场、无效粘贴拦截、文件导入回填（FileReader 异步等待后断言）、绑定后指纹行出示且 textarea 收起、Key 主机卡片徽章「密钥」（demo 修复实证，两张截图 [t40_key_flow.png](screenshots/t40_key_flow.png)）、生成路径零输入绑定、未绑定保存拦截、Agent 主机徽章「Agent」。表单态/绑定态截图目验无截断无重叠（[t40_key_form.png](screenshots/t40_key_form.png)、[t40_key_bound.png](screenshots/t40_key_bound.png)）。

**回归**：cargo 全量带 `TINYSSH_E2E_SSHD=1` 守卫 EXIT=0（30 套件 ok / 77 例，含新增 wire 锁）；`tsc && vite build` 通过（Rust 改动仅 session-api 新增测试）。

**披露**：①~~走查为浏览器 demo 路径~~（**当日增记销账，见下方真机冒烟**）；②「更换密钥」按钮重置绑定但已落库的旧 identity 不自动删除（凭据库累积，`delete_identity` 后端有门面、UI 无管理入口——与 §6-9 管理面分层同族，列 V1）；③编辑主机时认证方式不可改（v1.16 Keep 语义既定，提示删除重加）。

**真机冒烟增记（当日，销账披露①）**：新增 `TINYSSH_SMOKE` dev harness（main.rs，同 `TINYSSH_AUTOCONNECT` 模式默认关闭——页面就绪后 eval 注入驱动脚本，React 原生 setter 触发真实事件链，进度经本地 beacon 回传；工具与坑录 `scripts/native-smoke/`），在真实二进制上走完**密钥认证全链**：私钥导入 → 真实 `create_identity`（vault 加密落库，指纹 `SHA256:q0CW+rkj…` 与 `ssh-keygen -lf` 逐字一致）→ 指纹确认行 → 保存（auth_type=Key 持久化）→ TOFU FirstSeen 确认（审计 3 条：confirm_requested→decision→trusted）→ **密钥认证建连**（session_created kind=ssh，对 docker sshd 的 authorized_keys 预置）→ 终端键入 `whoami` 回显 `root`（[t40_native_whoami.png](screenshots/t40_native_whoami.png)）→ 重启后主机/密钥徽章/已信任指纹全部持久化（[t40_native_restart.png](screenshots/t40_native_restart.png)）。审计链 7 条完整（identity_create→host_upsert→TOFU×3→integration_inject→session_created）。冒烟中挖出并修复 harness 层三坑（注入脚本 timer 节流、page-load 早于 React 挂载的竞态、坐标基线漂移——详见 scripts/native-smoke/README.md，非产品缺陷）；**生成 ed25519 路径真机未单独 GUI 驱动**（与导入同一 `create_identity` 命令通道，wire 形态被锁定测试覆盖、vault 生成有单测）——如实披露。

### 5.36 SFTP 远程文件浏览器（T41，v1.39 判定：通过）—— FR-7 提前落地（用户指示）

背景：用户评估「是否已是专业 SSH 客户端（对标 Termius）」时指出 SFTP 属基本功能，指示冒烟后即做。PRD FR-7 原列 V2（双栏 GUI），本轮按 FR-7 主体落地**浏览器 + 既有传输管线复用**（队列与进度 T20 已有：传输卡片/取消/审计对账/toast），双栏式 GUI 与 mkdir/删除/重命名等管理操作仍留 V2。

- **Rust 全链**：`ChannelHandle::list_dir`（transport trait 新增）——SSH 走临时 SFTP 通道 readdir（与上传下载同模式，无持久会话生命周期负担），过滤 `.`/`..`、目录在前名称序、mtime 原样带回；本机 PTY 通路用 tokio read_dir 同语义实现（**本机会话的文件浏览器同样可用**）。core-session `sftp_list` 编排：人类专属、只读、不经审批不入审计（浏览非动作）；Agent 无此入口（MCP 无 list 工具，上传下载仍走必审口径）。src-tauri 一行 shim 命令注册。
- **UI「远程文件」区**（右栏，传输区上方）：路径框（回车跳转）+ 上一级 + 刷新；行 = 图标/名称/大小/日期，目录行点击进入，文件行 hover 出「下载」（复用 `download_file` → ~/Downloads）；**拖放目标升级**——远程文件区正浏览目录时，拖进窗口上传到该目录（否则维持 T20 的简报 cwd 语义）；首载目录 = 会话简报 cwd（到达后且未浏览过时自动加载，用户浏览位置不被 cwd 变化重置）；切会话清空（H1 同款 sid 归属纪律 + 过期结果丢弃守卫）。
- **demo shim**：演示文件树（与简报 cwd /var/log/nginx 对齐 + /root 树），wire 契约同口径（目录在前名称序）；传输仍如实报错（demo 无真实传输，卡片诚实失败——T20 既定口径）。
- **wire 锁定**：`dir_entry_wire_format_matches_ui` 锁 DirEntryS 四字段形态。

**走查（浏览器 demo 9/9）**：`ui/t41_sftp_verify.cjs`——首载简报 cwd、目录在前名称序、进入目录/路径更新、上一级、手输跳转、不存在路径报错、下载按钮→诚实失败卡；截图 [t41_sftp_browser.png](screenshots/t41_sftp_browser.png)。**真机实证**：`TINYSSH_SMOKE` harness 追加 SFTP 步骤（直调 internals invoke），真实 app 对容器 `/root` 返回 `n=2|D:.ssh,F:.bash_history`——目录识别与排序正确；终端选择器修正后 s8 全链可达。

**e2e**：`sftp_list_lists_dir_entries_sorted`（真 sshd）——远端造 `sub/ + a.txt + b.txt`，断言过滤 `./..`、目录在前名称序、size/mtime 真实、不存在路径报错。

**回归**：cargo 全量带 `TINYSSH_E2E_SSHD=1` 守卫 EXIT=0（**79 例**，含新增 e2e + wire 锁）+ `tsc && vite build` 通过。

**披露**：①真机的「远程文件」UI 面板未逐像素走查（真机实证走 internals 直调命令通道；UI 面板语义由浏览器走查 9/9 覆盖，同一 React 组件）——顺手项；②mkdir/删除/重命名/重命名确认、递归目录下载、双栏布局、远端容量信息留 V2（FR-7 边界）；③上传完成不自动刷新目录列表（手动「刷新」；传输完成事件驱动刷新列顺手项）；④大目录无分页/虚拟滚动（V2 性能口径，与审计浏览器同族边界）。


## 6. 已知边界（诚实清单）

1. **PV 用户研究未执行**：validation-plan §6 的 6–8 人产品验证 gate 需要真人参与者，不属于本次工程验收；工程侧前置条件（thin-slice 可用 + 三 Spike 门限 + 首验收场景）已全部就绪，PV 备战三件套亦已备齐（§5.20）。
2. **GUI 视觉验收方式**：v1.2 起 T9 为硬性 gate——真实 app 内以 CGEvent 注入点击完成"真实 SSH 连接"走查（§5.4）；浏览器演示模式仅覆盖原生窗口无法自动化的辅助路径。演示 shim 的简化项仍如实列于 §6.1-12。桌面真机人工验收命令见 §7。
3. **Keychain 首次访问**：无头环境运行需 `TINYSSH_MASTER_KEY` 覆盖（桌面正常使用会弹钥匙串授权，属预期）。
4. **Shell 模式输出流**：PTY 合并 stdout/stderr（ExecResult.stderr 为空，文档如实标注）；Fresh 模式有独立双流。
5. **env_summary**：V0 不追踪 env 变更（简报如实标注"printenv 核实"）。
6. **无集成主机自动降级 Fresh**（L1 规定），E2E 中 ash→bash 切换即此语义的演示。
7. **进程模型（M3）**：V0 承载形态为 `tinyssh serve` 单进程装配 MCP+核心（人类经 CLI `tinyssh approval` 审批）；GUI 进程内嵌核心与 UI 但未承载 MCP 端点，跨进程审批（GUI 批准 serve 进程的 Agent 卡片）不在 thin-slice 范围。首验收场景在同一进程 API 层完成（人类与 Agent 走同一 SessionApi）。V1 需把 MCP 端点装配进 GUI 进程或将审批状态外置。
8. **read_screen 的 style 参数**（L1 §4 text|ansi）：V0 声明但忽略，恒返回 text。
9. **src-tauri 管理操作直连 vault**（host/identity 管理面绕过 SessionApi 门面）——L1 §1 字面规则的已知偏离；协作面（exec/审批/简报）严格走门面，管理面分层留 V1 收口。
10. **create_session 审批卡不受接管作废**（卡片 session_id 为空，接管按会话匹配作废范围）——作废口径边角。
11. **并发回归 flake（根因已修复）**：多测试并发时偶发"空流 / 降级 Fresh / cwd 缺失 / spike2 script-not-done"。根因：pump 任务经 `tokio::spawn` 后才订阅输出广播，而建会话/重连的注入写入可能先于订阅被调度——远端首屏（含集成标记）落入无订阅者窗口被丢弃（broadcast 无接收者即丢）。修复：create_session 与重连路径均改为**先订阅、后注入**（`spawn_pump` 接受初始订阅；原 `on_transport_lost` 拆分为 `on_transport_reconnect` + `reinject_integration`）。独立探针实测传输+屏幕链路 5ms 内集成就绪；修复后两测试二进制 5/5 全过。集成等待窗口同时从 3–5s 放宽至 10s，sshd_e2e/spike2 整场景重试兜底。
12. **~~演示 shim 简化~~（v1.20 已对齐，§5.22）**：原 7 项伪影（输出串台/接管不翻 chip/审计静态/seq 撞号/导入未实现/TOFU 缺失/静默 null）全部修复并经 19 项断言走查；**浏览器走查证据自此计入交互证据链**（此前必须甄别 shim 伪影）。残余：session_brief 静态种子、传输类显式失败占位、TOFU 仅 FirstSeen（§5.22 披露①–③）。
13. **~~会话死端无自动感知~~（v1.7 已解决）**：v1.4 记录的「shell 退出/PTY EOF 后会话卡仍显示已连接」已由 pump 存活检测 + Disconnected 状态 + 一键重连闭环解决（§5.8）。断线瞬间正在键入的半截命令随旧 shell 丢弃（诚实语义：从未执行）；重连 = 新 shell，现场不延续。
14. **CJK 输入法残余边界**（v1.4）：Ctrl 系控制键已由 native 层接管（§5.5 修复#1），不再受输入法影响；但**普通字母键入**在中文输入法激活时仍走系统级拼音组合（macOS 标准行为，与 Terminal.app 一致——组合提交后 ASCII 进壳）；CGEvent 注入自动化下观察到粘贴后瞬时组合态导致键入丢失（注入时序问题，真实键盘未复现）。中文 IME 组合输入（组合输入中文上屏）属真实人工验证项。
15. **native Ctrl 接管的平台范围**：拦截器为 macOS 专属（NSEvent local monitor）；Windows/Linux WebView 的 Ctrl 组合不受此 IME 缺口影响（引擎层 12/12 已验证），JS 层 ⌘/Ctrl 处理保留为兜底。
16. **~~鼠标上报未实测~~（v1.8 已验证，路线图③关闭，§5.10）**：点击上报原生端到端实证（本机 vim mouse=a 点击指定单词 → 光标跳转 → `rZ` 替换命中字符落盘）；滚轮上报的 xterm.js SGR 编码经 WebKit 引擎层验证 4/4（与应用同一构建）。残留边界：真实滚轮手感未经真人确认（合成滚轮事件送不进 WKWebView，走查工具层限制已实证；真实输入投递由平台保证），tmux/htop 未实测（环境无此二者）——均为日常使用顺手确认项，不再阻塞路线图。
17. **~~重连重注入回显泄漏（P1）~~（v1.7 根因确认并修复）**：根因有二——`saw_133` 粘滞不重置（重注入就绪等待形同虚设）+ 就绪信号选错标记（C 先于清屏字节执行）。修复为重连后重置集成跟踪 + 等 B 标记（`prompt_ready`）+ 残留 open block 强制收尾；journey4 在键入一半的脏状态下容器重启复现验证通过（§5.8）。v1.5 观察到的一次性泄漏与该机制吻合，至此关闭。
18. **UX 路线图（v1.5 按使用体验重排，用户认可为准绳；v1.13 完成①–⑧）**：① ~~断线一键重连闭环~~（**v1.7 完成，§5.8**）② ~~Alt/Option 键（readline/tmux 词跳转）~~（**v1.8 完成，§5.9**）③ ~~鼠标上报实测~~（**v1.8 完成，§5.10**）④ ~~⌘F 搜索 / OSC8 链接 / 窗口标题~~（**v1.9 完成，§5.11**）⑤ ~~主机指纹首连确认 + 变更警告~~（**v1.10 完成，§5.12**）⑥ ~~字号/主题设置~~（**v1.11 完成，§5.13**）⑦ ~~标签页/分屏~~（**v1.12 完成，§5.14**）⑧ ~~SFTP 拖拽 / rz-sz~~（**v1.13 完成，§5.15**——SFTP 拖拽上传/下载/取消；rz-sz 不做：需远端装 lrzsz 且 ZMODEM 帧截获与终端流强耦合，SFTP 覆盖同场景且更稳）⑨ ~~.ssh/config 导入与 agent~~（**v1.14 完成，§5.16**——导入面板/来源标注/徽标/Agent 主机 TOFU 建连与重启直连 UI 走查通过；t21-d Key 主机 UI 建连与连接后键入因用户占用中止注入，既有功能由自动化覆盖并披露）**UX 走查修复第一批（v1.15 完成，§5.17）**——2026-09-30 模拟用户 UX 走查（[docs/ux/2026-09-30-simulated-ux-review.md](../ux/2026-09-30-simulated-ux-review.md)，26 条真实问题）第一批 5 项（审批卡目标上下文/搜索焦点抢占/危险批准摩擦/首屏矛盾文案/AGENT 接入区）已修复并走查；**第二批（v1.16 完成，§5.18）**——日用摩擦主干 8 项（主机编辑删除/关签确认/键盘可达/表单三连/停止披露/失败态/死会话遮罩拦截/死卡单按钮）已修复并走查；**第三批（v1.17 完成，§5.19）**——其余 P2 与全部 P3（简报认知徽标/传输指代/＋toggle/命令框历史/uppercase/favicon/收起消歧/时间戳口径/placeholder 对比度/终端圆角/用户名默认空），**走查报告 26 条真实问题全部关闭**（全量文案 sweep 除外，见 §5.19 披露①）⑩ 键盘交互认证/2FA、GBK 编码（**2FA 前半 v1.21 完成，§5.23**——Password 被拒自动回落 keyboard-interactive + OTP 提示人工应答门；GBK 后半按需排期）。**①–⑨ + ⑩前半完成**（⑩后半 GBK 于 v1.35 完成，§5.33——路线图①–⑩全部关闭）。**视觉 polish 第一批（v1.27 完成，§5.27）**——应用图标重绘 / 线性图标体系 / hover·focus·过渡反馈层 / 顶栏危险动作层级 / 欢迎页品牌化空状态；**标题栏融合与排版精致化（v1.28 完成，§5.28）**——Overlay 原生标题栏（红绿灯入左栏头 + 顶栏拖拽区 + 深色外观）、主机卡层级/断行禁则、空态拉齐、主题选择器收紧；**专业外壳与信任可查证（v1.29 完成，§5.29）**——原生全中文菜单栏（设置…⌘, 事件联动 / 关于带版本与安全声明 / 不设⌘W 与重新加载）、版本号 0.9.0 三处统一与设置面板版本行、TOFU 指纹可查证（主机卡 tooltip / 编辑表单信任行 / CLI 指纹列 / 测试守卫）；菜单随系统语言本地化列 V1；**浅色 chrome 适配（v1.30 完成，§5.30，P2-7 收口）**——chrome 跟随终端主题（浅色/Solarized 浅色调色板 + 原生窗口 setTheme 同步），视觉 polish 系列无遗留项；**UX 走查遗留与路线图⑩收口（v1.34–v1.35 完成，§5.33）**——R5/R7/R8 小项 + R9 人类→Agent 任务委托入口（goal 随简报下发/人类专属写口/goal_set 审计）+ **⑩后半 GBK 编码完成**（泵边界流式解码 + 写边界编码 + vault V4 charset 列 + 真 sshd 双向 e2e），**UX 路线图①–⑩至此全部关闭**。
19. **~~fitTerminal 静默失效（历史缺陷）~~（v1.11 已修复，§5.13）**：xterm 5.5 无公开 `dimensions`，fit 自 v1.x 起从未真正生效，xterm/PTY 恒为构造默认 80×24（13px 下恰好正确而长期未暴露，窗口 resize 的「跟随」实为看门狗把 PTY 锁到 80×24）。修复经 `_core._renderService.dimensions`（addon-fit 同源）后 PTY 真实随字号/窗口变化（实测 16px=35×75、19px=28×63）。此前各轮报告中「PTY 对齐」的验收结论在默认 13px 场景下成立，其他字号下的对齐自 v1.11 起才真实成立。
20. **~~主题作用域~~（v1.30 已解决，§5.30）**：原「终端配色预设只作用于终端区域，界面 chrome 恒为深色」——T35 起 chrome 跟随终端主题（浅色/Solarized 浅色各配一套 chrome 调色板，深色现值逐字节不变，原生窗口外观经 setTheme 同步）；残留：启动瞬间深→浅闪烁（backgroundColor 为静态初值）；设置（字号/主题）不入审计链（UI 偏好非协作事实，vault `settings` KV 可查）。
23. **拖拽投递的走查口径（v1.13）**：T20 的 OS 级拖拽事件（Finder→WKWebView NSDraggingSession 投递）在双屏+多 Space 环境无法脚本化驱动，走查以 dev 门禁合成事件注入覆盖该环节（§5.15 披露①），其余链路全部真实；真人拖拽列为顺手确认项。人类传输不经审批直接执行（审计留痕），与「Agent 传输必审」的 L1 §4 语义一致。
24. **传输边界（v1.13）**：上传目标=焦点会话简报 cwd（未就绪则拒绝）；下载固定 `~/Downloads`；无逐字节进度；取消/失败远端可能残留部分文件（与 scp 同语义）；Agent 传输走 MCP upload/download 工具且必审（v0 既有），与人类入口同链路同审计。
25. **sshd 就绪探测口径（v1.14 修复）**：`await_sshd_ready` 从 TCP-only 升级为 TCP + SSH banner 探测——docker 端口代理在容器内 sshd 监听前就接受 TCP（随后 reset），TCP-only 会让紧随 `docker start` 的测试稳定撞上 `Connection reset by peer`（journey3 在 HEAD 上复现，非 T21 引入，stash 验证）。
26. **Agent 认证边界（v1.14）**：Agent 主机 vault 零密钥落库；agent 不可达/无密钥/全拒绝分别可读报错；按 agent 加载顺序逐 key 尝试（ssh 标准行为），无按主机筛选 agent 密钥（IdentityFile→agent 密钥匹配 V1 按需）；加密私钥（有口令）不走自动导入，明说后手工。
21. **~~双 `createRoot` 挂载两个 App 实例（历史缺陷）~~（v1.12 已修复，§5.14）**：`main.tsx` 中 `createRoot(...).render(...)` 整块重复两份，两个 React 根并存——所有 window 级快捷键按实例数双触发（⌘W 一次关两签经审计 seq142/143 实锤；⌘=/⌘F/Ctrl+字符 同样双触发）。修复为单根后一次按键单触发。此前各轮 ⌘ 系快捷键走查结论在「双触发恰好幂等或未察觉」场合成立，自 v1.12 起单触发才真实成立。
22. **分屏边界（v1.12）**：固定 50/50 两 pane（无拖拽分割条/纵向分屏/多于两个 pane，V1 按需）；分屏布局不持久化（会话不跨重启）；分屏中 attach 第三会话 = 替换左主 pane；pane 名牌可能遮住首行前几个字符（半透明，tmux 同款取舍）。
27. **主密钥路径不一致（v1.31）**：带 `TINYSSH_MASTER_KEY` 的开发实例与正式启动（钥匙串）实例主密钥不同——前者写入的凭据后者读不开（`host_secret` 在指纹门前失败，报 decrypt failed）。 remediation：编辑主机重输密码（v1.31 编辑表单新增「更换密码」栏）即用当前密钥重封；PV 分发构建统一钥匙串路径不受影响。

## 7. 复现指令

```bash
# 0) 依赖：Rust 1.93+ / Node 24 / Docker（sshd 测试容器）
scripts/dev-sshd.sh          # 起 tinyssh-e2e 容器（127.0.0.1:2222，root/testpass）

# 1) 全量测试（先编译后运行——同机边编译边跑会拉长会话首提示符延迟，见 §6.1-11）
export TINYSSH_MASTER_KEY=$(python3 -c "print('07'*32)")
cargo test --workspace --no-run
TINYSSH_E2E_SSHD=1 cargo test --workspace

# 2) SPIKE-1（Tauri IPC 吞吐，release）
cargo build -p tinyssh-app --release && (cd ui && npm install && npm run build)
(cd ui && npx vite --port 5183 --host 127.0.0.1 &)   # debug/devUrl 需要；release 直跑可用 dist
TINYSSH_BENCH=1 ./target/release/tinyssh-app          # 60s 后写 /tmp/tinyssh-spike1.json 并退出

# 3) CLI 体验（人类侧）
TINYSSH_MASTER_KEY=... ./target/debug/tinyssh agent create opencode OpenCode
TINYSSH_MASTER_KEY=... ./target/debug/tinyssh host add prod-1 10.0.0.11 --username ops --password ***
TINYSSH_MASTER_KEY=... ./target/debug/tinyssh serve                   # MCP 端点 :8722
TINYSSH_MCP_URL=... TINYSSH_TOKEN=... tinyssh-mcp                     # Agent 侧 shim

# 4) GUI（桌面）
TINYSSH_MASTER_KEY=... ./target/release/tinyssh-app   # 或 cargo tauri dev

# 5) UI 视觉走查（浏览器演示模式，同 UI 代码路径）
cd ui && npx vite --port 5183 --host 127.0.0.1        # 打开 http://127.0.0.1:5183

# 6) T10 原生走查（§5.5 六步；已于 v1.4 执行通过，以下为复现步骤）
#    助手脚本模式（窗口定位/截图/点击/键盘，含 Ctrl 组合键）：python3 + pyobjc
#    a. 激活 tinyssh-app → 截图确认首屏（欢迎页含 Ctrl+C/⌘C⌘V 提示）
#    b. 点击「本机」卡片「连接」→ 截图确认提示符
#    c. 键入 top⏎ → 截图确认 top 全屏渲染（T10-a）
#    d. CGEvent ctrl+C（keycode 8 + ControlMask 设备无关位）→ 截图确认回到提示符（T10-b）
#    e. 键入 echo T10-OK-42⏎ → 截图确认输出；↑⏎ 重跑（T10-c）
#    f. 点击命令框键入 top⏎ → 命令框内 Ctrl+C → top 退出（T10-d）
#    g. 键入 vim /tmp/t10.txt⏎ → 插入文本 → Esc → :wq⏎ → cat /tmp/t10.txt 验证（T10-e）
#    h. 点击「e2e-sshd」卡片连接 → 重复 c/d（T10-f）

# 7) T11 原生走查（§5.6 七步；已于 v1.5 执行通过；会话建立用 dev harness）
#    TINYSSH_MASTER_KEY=... TINYSSH_AUTOCONNECT=local,<e2e-sshd-host-id> ./target/debug/tinyssh-app &
#    a. ⌘1 接入本机 → ⌘V 粘贴 echo T11-A-history-1 && echo T11-A-history-2 && uname -a ⏎（T11-b）
#    b. ⌘2 接入 e2e-sshd → ⌘V 粘贴 echo T11-B-remote-1 && hostname ⏎（T11-c）
#    c. ⌘1 / ⌘2 往返：双方滚动历史与提示符位置原样保留（T11-d/e）
#    d. A 内 vim ⏎ → ⌘2 → ⌘1 往返：vim 全屏界面原样保留（T11-f）
#    e. Esc → :q! 干净退出 → top ⏎ → Ctrl+C 中断回提示符（T10 修复无回归，T11-g）

# 8) T12 右栏人话化走查（§5.7 四步；已于 v1.6 执行通过）
#    a. 启动 app（同上 harness）→ 右栏三区：审批空态一行话 / 操作记录全中文带时间、无 OSC133 行（T12-a）
#    b. ⌘1 接入本机 → 终端打字 echo HI12 ⏎ → 右栏简报出现「$ echo HI12 · 成功」（T12-b）
#    c. ⌘1 切 e2e-sshd（列表首位）→ 简报「当前目录 /root · 已核实」（T12-c）
#    d. 浏览器开 127.0.0.1:5183（demo 模式）→ 接入演示会话 → 审批卡 + 徽标 + Agent 操作记录（T12-d）

# 9) T13 断线一键重连走查（§5.8 六步；已于 v1.7 执行通过）
#    a. ⌘2 接入本机 → 终端打字 exit ⏎ → 3s 内卡片「已断开」+「重连」按钮（T13-a）
#    b. 点「重连」→ 卡片「重确认（受限）」、新提示符出现、滚动历史保留（T13-b）
#    c. 键入 echo T13-LOCAL-RECONNECT-OK ⏎ → 输出正常（T13-c）
#    d. docker stop tinyssh-e2e → 等待自动重连 3 次失败（~20s）→ 远程卡「已断开」（T13-d）
#    e. docker start tinyssh-e2e → 点远程卡「重连」→ 「重确认（受限）」→
#       echo T13-REMOTE-RECONNECT-OK && hostname ⏎ → 输出正常（T13-e）
#    f. 右栏简报控制权行 = 最新变迁「重连成功，进入重确认」；操作记录两条「我 重连会话」（T13-f）

# 10) T14 Option/Alt 键走查（§5.9 六步；已于 v1.8 执行通过）
#    判据 = 补字符落点（词跳转后补一个字符再回车，看输出里字符落在哪个词）
#    a. 本机：echo aaa bbb ccc ddd → ⌥← ⌥← → Z ⏎ → 输出 aaa bbb Zccc ddd（T14-a）
#    b. 本机：echo kkk lll mmm → ⌥b ⌥f → Z ⏎ → 输出 kkk lll mmmZ（T14-b）
#    c. 本机：echo eee fff ggg → ⌥⌫ → Z ⏎ → 输出 eee fff Z（T14-c）
#    d. sleep 30 ⏎ → Ctrl+C → ^C 回提示符（T14-d 回归）
#    e. 接入 e2e-sshd → echo mmm nnn ooo → ⌥← ⌥← → W ⏎ → 输出 mmm Wnnn ooo（T14-e）
#    f. 右栏简报命令文本无 meta 残留（'b' 杂讯消失，T14-f）

# 11) T15 鼠标上报走查（§5.10；已于 v1.8 执行通过，路线图③关闭）
#    a. printf 'alpha bravo charlie delta echo foxtrot\n…' > /tmp/t14mouse.txt
#    b. 本机：vim -u NONE -c 'set mouse=a' /tmp/t14mouse.txt
#    c. CGEvent 点击 buffer 内 "charlie" → 光标跳到命中字符 → rZ → :wq!
#    d. cat /tmp/t14mouse.txt = "alpha bravo chaZlie …"（点击上报端到端实锤）
#    e. WebKit 引擎层（playwright + 应用同一 xterm 构建）：DECSET 1002+1006
#       → page.mouse 点击/滚轮 → onData 断言 SGR 4/4（按下/抬起/滚轮上/下）
#    f. 真人顺手项：htop/tmux 真实滚轮手感（合成滚轮注入不达 WebView，工具层限制）

# 12) T16 三特性走查（§5.11 八步；已于 v1.9 执行通过）
#    a. 本机终端 ⌘F → 搜索框出现（视觉）→ 键入查询 → 琥珀高亮 + N/M 计数（T16-a/b）
#    b. ⏎ / ⇧⏎ 上下一处导航、Esc 关闭回焦点（T16-c）
#    c. printf '\e]8;;http://127.0.0.1:5183/\e\\Open Dev Server\e]8;;\e\\' → 虚线下划线（T16-d）
#    d. 点击链接（合成注入需 hover 驻留 ≥0.8s）→ 默认浏览器打开 5183（T16-f）
#    e. ⌘1/⌘2 切换 → 标题栏 "e2e-sshd — TinySSH" ↔ "本机 — TinySSH"（T16-g）
#    f. printf '\033]0;my-remote-title\007' → 头部「MY-REMOTE-TITLE」（T16-h）
#    g. 引擎层（playwright + 应用同一构建）：linkHandler（OSC8）/linkProvider（裸 URL）双路径断言（T16-e）
#    注：.setTitle 需 capabilities 含 core:window:allow-set-title（缺失时静默失效）

# 13) T17 主机指纹门走查（§5.12 七步；已于 v1.10 执行通过，路线图⑤关闭）
#    a. sqlite3 ~/.tinyssh/tinyssh.db "UPDATE hosts SET host_fingerprint=NULL WHERE id='h-556e…';"
#       → 点击连接 → FirstSeen 确认弹窗（指纹 SHA256:… mono 块）
#    b. 「取消」→ 红色横幅「主机指纹验证失败（用户拒绝连接）」、记录仍 NULL
#    c. 再连 → 「信任并连接」→ 会话连接、host_fingerprint 入库、审计 trusted
#    d. 预置假旧指纹 → 连接 → 红色变更告警（原/新指纹对照 + 中间人警示）
#    e. 「拒绝连接」→ 横幅、记录不变；「我已核实，更新指纹并连接」→ 连接、记录恢复真实值
#    f. 重启 app → 再连 → 无弹窗静默连接（跨进程 TOFU），审计无新 confirm_requested
#    g. 无人应答 120s → 横幅「主机指纹验证失败（确认超时）」（超时路径附带实证）
#    注：门未放行时 create_session 挂起等待，审计持续追加 host_key_confirm_requested

# 14) T18 字号/主题走查（§5.13 六步；已于 v1.11 执行通过，路线图⑥关闭）
#    a. 终端标题栏「Aa」→ 显示设置面板（字号行 + 主题 4 项 + 当前项高亮）
#    b. ＋×3（13→16）→ 终端即时增大；stty size 24 80 → 35 75（PTY 真实跟随，v1.11 fit 修复后）
#    c. ⌘= 步进 → ⌘0 重置回 13（面板数值与重置禁用态同步）
#    d. 主题 → 浅色 → 终端区即刻 #f7f7f2；选中态像素取样核验；chrome 维持深色（设计如此）
#    e. 重启 app → 面板与终端恢复上次字号/主题（vault settings KV，user_version=3）
#       sqlite3 ~/.tinyssh/tinyssh.db "SELECT * FROM settings;"
#    f. 新建第 2 会话自动继承；⌘1/⌘2 切换 → 两会话同字号同主题、历史保留、激活即校准
#    注：fit 修复前（v1.10 及之前）字号/窗口变化不会改变 PTY（恒 80×24）

# 15) T19 标签页/分屏走查（§5.14 六步；已于 v1.12 执行通过，路线图⑦关闭）
#    a. 建两会话 → 中栏顶部两签（状态点 + 主机名 + ◫/✕），活动签 accent 边框（像素取样）
#    b. 点标签切换 → 终端/头部/窗口标题/简报/命令框跟随；历史原地保留（T19-b）
#    c. 点非活动签 ◫ → 50/50 分屏（pane 名牌 + 焦点圈）；两侧各 stty size = 38 45（T19-c）
#    d. 点右 pane → 头部/命令框跟随；命令框 whoami → 输出落右 pane、审计「执行命令」（T19-d）
#    e. 「退出分屏」→ 单 pane；stty size = 38 91（45→91 双向）；关副 pane ✕ → 自动退分屏（T19-e）
#    f. ⌘W → 恰好一条 session_closed（审计 seq 核对）、焦点自动落剩余会话、窗口保留；
#       ⌘⇧] / ⌘⇧[ 循环切换；退分屏后不点终端直接打字可达（焦点回落）（T19-f）
#    注：修复前对照——main.tsx 双 createRoot 时代一次 ⌘W = 两条 session_closed（seq142/143）

# 16) T20 文件传输走查（§5.15 六步；已于 v1.13 执行通过，路线图⑧关闭）
#    启动：TINYSSH_MASTER_KEY=... TINYSSH_TEST_DRAG=1 TINYSSH_AUTOCONNECT=<e2e-host-id> \
#           ./target/debug/tinyssh-app &（点击会话卡片接入终端；走查机双屏多 Space，
#           OS 级拖拽投递以 /tmp/t20_drag_* 触发器文件合成事件，见 §5.15 披露①）
#    a. printf '/tmp/t20_dragsrc/t20_upload.txt' > /tmp/t20_drag_enter；稍候 over →
#       终端区 accent 虚线框 +「⇩ 松开上传到 /root」（T20-a）
#    b. printf '<path>' > /tmp/t20_drag_drop → 卡片「↑ t20_upload.txt 完成 · 53 B」（T20-b）
#    c. 命令框 md5sum /root/t20_upload.txt → 与本地 md5 一致（811a56e9…）（T20-c）
#    d. 远端 printf 造标记文件 → 传输区填 /tmp/t20_remote.txt → 下载 → 卡片完成 24 B；
#       本地 ~/Downloads/t20_remote.txt 与远端 sha1 一致（T20-d）
#    e. 取消：cargo test -p transport-ssh --test sshd_e2e sftp_download_cancel_midway
#       （256MB 真实下载 200ms 取消 → Cancelled + 无完整文件；UI ✕ 为薄包装）（T20-e）
#    f. sqlite3 ~/.tinyssh/tinyssh.db "SELECT ... WHERE action LIKE 'transfer%'"
#       → transfer_done payload 含 transfer id + bytes；时间线「传输完成」（T20-f）
#    注：真人从访达拖文件进终端为顺手确认项（§5.15 披露①②）

# 17) T21 导入/agent 走查（§5.16 五步；**v1.14 已执行——4 通过 / 1 部分覆盖（披露①）**）
#    环境：HOME=/tmp/t21home（合成 config 4 条目已留存）TINYSSH_DB=/tmp/t21home/tinyssh.db \
#          TINYSSH_MASTER_KEY=... ./target/debug/tinyssh-app &
#    专属 agent：ssh-agent -a /tmp/t21home/agent.sock；SSH_AUTH_SOCK=… ssh-add /tmp/t21home/.ssh/id_agent；
#    容器公钥：cat /tmp/t21home/.ssh/id_{walk,agent}.pub | docker exec -i tinyssh-e2e 'sh -c …>>authorized_keys'
#    a. 左栏「导入 ~/.ssh/config」→ 面板可导入条目恰 2（e2e-agent·Agent / e2e-key·密钥；
#       通配符与 Match 块条目不可见）（T21-a ✓）
#    b. 勾选导入 → 逐条「✓ 已导入」；主机列表 e2e-agent·Agent / e2e-key·密钥（T21-b ✓）
#    c. 连接 e2e-agent → 指纹确认弹窗 → 信任并连接 → shell 提示符上屏；冷重启后再连直连无弹窗
#       （whoami=root 由 sshd_e2e agent 用例 exec 实证——UI 键入未注入，披露①）（T21-c ✓）
#    d. 连接 e2e-key → shell 可用（IdentityFile 私钥已入 vault）——**未注入执行**（披露①；
#       身份落库与绑定由集成测试 + T21-b 截图覆盖）（T21-d △）
#    e. sqlite3 $TINYSSH_DB 审计：host_upsert×2 + identity_create×1 + TOFU 决策 3 条 +
#       session 事件×4，seq 1–13 连续（T21-e ✓）
#    注：内核链路（预览对账/导入落库/Agent 全栈建连）已由 66 项回归中的 3 项新测试实证；
#    走查补的是纯 UI 层（面板渲染/勾选交互/Agent 表单选项/徽标）。收尾清理：
#    docker exec tinyssh-e2e sed -i '/t21-walk-/d' /root/.ssh/authorized_keys + kill agent + rm -rf /tmp/t21home

# 18) UX 修复第一批走查（§5.17；**v1.15 已执行——demo 渲染层 11/11 通过**）
#    cd ui && npm run dev -- --port 5183 --host 127.0.0.1
#    python3 /tmp/uxfix_walk.py   # playwright channel="chrome" headless；11 项断言 + 截图 /tmp/u1shots/
#    归档截图：docs/acceptance/screenshots/u1_*.png（5 张）
#    回归：TINYSSH_MASTER_KEY=$(python3 -c "print('07'*32)") cargo test   # 66/66
#    实机原生冒烟（真实 shell 复验 P1-2 + 审批卡实机渲染，需 agent MCP rig）：待下一走查窗口

# 19) UX 修复第二批走查（§5.18；**v1.16 已执行——demo 渲染层 20/20 通过**）
#    cd ui && npm run dev -- --port 5183 --host 127.0.0.1
#    python3 /tmp/uxfix2_walk.py   # playwright channel="chrome" headless；20 项断言 + 截图 /tmp/u2shots/
#    归档截图：docs/acceptance/screenshots/u2_*.png（8 张）
#    回归：TINYSSH_MASTER_KEY=$(python3 -c "print('07'*32)") cargo test   # 66/66
#    后端改动：AuthDraft::None→"Keep"（编辑保持凭据）+ vault upsert_host 保留分支
#    实机原生冒烟（P2-7 native Ctrl 层评估 + T22 遗留两项）：待下一走查窗口

# 20) UX 修复第三批走查（§5.19；**v1.17 已执行——demo 渲染层 13/13 通过**）
#    cd ui && npm run dev -- --port 5183 --host 127.0.0.1
#    python3 /tmp/uxfix3_walk.py   # playwright channel="chrome" headless；13 项断言 + 截图 /tmp/u3shots/
#    归档截图：docs/acceptance/screenshots/u3_*.png（4 张）
#    回归：TINYSSH_MASTER_KEY=$(python3 -c "print('07'*32)") cargo test   # 66/66（零 Rust 改动）

# 21) PV 备战三件套（§5.20；**v1.18 已执行——全部实测**）
#    scripts/pv_env.sh reset && scripts/pv_env.sh check all        # 沙箱重建 + 五故障就位校验
#    scripts/pv_env.sh solve A|A2|B|B2|C                           # 参考解法（仅主持人）
#    ./scripts/dist.sh                                             # 分发构建 → dist-pv/<日期>-<commit>/
#    python3 scripts/pv_analyze.py --init-templates --data-dir pv-data   # 生成编码/问卷 CSV 模板
#    python3 scripts/pv_analyze.py --n 6 --data-dir pv-data --verify-chain --verbose
#    #    （合成数据自测：gate 矩阵/篡改检测/反模式优先三段断言已在 §5.20 执行）
#    主持手册：docs/pv/session-kit.md（招募→预登记→执行→回收→分析全流程）

# 22) 全量文案 sweep + 审批契约断点（§5.21；**v1.19 已执行——demo 渲染层 9/9 通过**）
#    cd ui && npm run dev -- --port 5183 --host 127.0.0.1
#    python3 /tmp/u4copy_walk.py   # playwright channel="chrome" headless；9 项断言 + 截图 /tmp/u4shots/
#    归档截图：docs/acceptance/screenshots/u4_*.png（3 张）
#    回归：TINYSSH_MASTER_KEY=$(python3 -c "print('07'*32)") cargo test   # 67/67（+1 wire 锁定测试）

# 23) demo shim 保真走查（§5.22；**v1.20 已执行——本套件 19/19 + u4 回归 9/9 通过**）
#    cd ui && npm run dev -- --port 5183 --host 127.0.0.1
#    python3 /tmp/u5shim_walk.py   # 19 项断言（隔离/翻转/动态审计/导入/TOFU 两段门）+ 截图 /tmp/u5shots/
#    python3 /tmp/u4copy_walk.py   # u4 套件回归（shim 重写不破坏 T26 断言）
#    归档截图：docs/acceptance/screenshots/u5_*.png（6 张）
#    回归：TINYSSH_MASTER_KEY=$(python3 -c "print('07'*32)") cargo test   # 67/67（零 Rust 改动）

# 24) 2FA 键盘交互认证（§5.23；**v1.21 已执行——kb e2e + demo 8/8 通过**）
#    容器：scripts/dev-sshd.sh（v1.21 起映射 2223 + 预装 openssh-server-pam）
#    TINYSSH_MASTER_KEY=$(python3 -c "print('07'*32)") TINYSSH_E2E_SSHD=1 \
#      cargo test -p transport-ssh --test sshd_e2e ssh_keyboard_interactive_fallback
#    demo 走查：python3 /tmp/u6_2fa_walk.py（otp-1 主机：TOFU→OTP 双门序 8 断言）
#    全量（**必须带守卫**）：TINYSSH_MASTER_KEY=$(python3 -c "print('07'*32)") \
#      TINYSSH_E2E_SSHD=1 cargo test --no-fail-fast    # 68/68（0 跳过）

# 25) UI 精致化改造（§5.32；**v1.33 已执行——demo 截图 5 张目验通过**）
#    cd ui && npm run dev   # 5183 端口，浏览器 demo 模式自动启用
#    playwright headless 截图走查：初始列表/hover 浮现/会话态/浅色主题/接管 toast
#    归档截图：docs/acceptance/screenshots/t37_*.png（5 张）
#    回归：TINYSSH_MASTER_KEY=$(python3 -c "print('07'*32)") \
#      TINYSSH_E2E_SSHD=1 cargo test --no-fail-fast   # 零 Rust 改动

# 26) T38：R9 任务委托 + GBK 编码 + 模拟 PV 修复验证（§5.33；**v1.36 已执行**）
#    R9 走查：cd ui && npm run dev & node t38_goal_walkthrough.cjs   # 7 断言
#    GBK e2e（真 sshd 双向）：TINYSSH_MASTER_KEY=$(python3 -c "print('07'*32)") \
#      TINYSSH_E2E_SSHD=1 cargo test -p core-session --test core_local gbk_charset_roundtrip_over_ssh
#    PV 修复验证：node pv_fix_verify.cjs   # 10 断言（表单/徽章/中心点击/自动增高/草稿暂存/toast 文案）
#    归档截图：docs/acceptance/screenshots/t38_*.png（R9 2 张 + PV 9 张）
#    PV 报告：docs/pv/2026-10-03-simulated-pv/（novice/handoff/polish/gbk 四人格）
#    回归：TINYSSH_MASTER_KEY=$(python3 -c "print('07'*32)") \
#      TINYSSH_E2E_SSHD=1 cargo test --no-fail-fast

# 27) T39：独立审核与视觉复验（§5.34；**v1.37 已执行**）
#    审核报告：docs/ux/2026-10-03-t37-t38-code-review.md（B1 charset 线格式 + H1 目标串台）
#              docs/ux/2026-10-03-t37-t38-visual-recheck.md（38 断言 + skeleton/attach-hint 定性）
#    wire 锁定：cargo test -p session-api --lib wire_format   # Charset "utf-8"/"gbk" 双向
#    修复验证：cd ui && npm run dev & node v137_review_verify.cjs   # 7 断言
#    回归：TINYSSH_MASTER_KEY=$(python3 -c "print('07'*32)") \
#      TINYSSH_E2E_SSHD=1 cargo test --no-fail-fast

# 28) T40：FR-2 密钥认证收尾（§5.35；**v1.38 已执行**）
#    wire 锁定：cargo test -p session-api --lib wire_format   # IdentityReq/AuthDraft/IdentityMeta
#    走查：cd ui && npx vite --port 5183 & node t40_keyauth_verify.cjs   # 11 断言
#    真机冒烟：scripts/native-smoke/README.md（beacon.py + TINYSSH_SMOKE=1 cargo tauri dev
#      → beacon.log 到 s7 → ev.py 键入 whoami → 截图/DB/审计三重对账）
#    回归：TINYSSH_MASTER_KEY=$(python3 -c "print('07'*32)") \
#      TINYSSH_E2E_SSHD=1 cargo test --no-fail-fast

# 29) T41：SFTP 远程文件浏览器（§5.36；**v1.39 已执行**）
#    e2e（真 sshd）：cargo test -p transport-ssh --test sshd_e2e sftp_list
#    wire 锁定：cargo test -p session-api --lib wire_format   # DirEntryS
#    走查：cd ui && npx vite --port 5183 & node t41_sftp_verify.cjs   # 9 断言
#    真机：TINYSSH_SMOKE harness 尾段直调 sftp_list（beacon sftp|n=… 行）
#    回归：同 #28
```

## 8. 结论

**工程验收通过。** 文档（PRD/L0/L1 v0.5）定义的 V0 thin-slice——一个真实共享会话、Shell 模式现场延续、逐段审批、接管/交还契约（含旧请求与待审批卡片作废）、现场简报、可读操作记录、MCP 双前端对等——已实现并被 **55 个自动化测试**与 3 项 Spike 门限覆盖；**首个可运行验收场景在真实 OpenSSH/Linux 环境以 MCP Agent + 人类双前端端到端通过**。v1.1 补充的独立 subagent 审计（§5.1）发现的 2 个审批安全缺口（M1/M2）与 6 个次要缺口已全部修复并附回归测试，3 项如实披露为边界；独立复跑与浏览器视觉走查（§5.2/§5.3）补齐了第三方复现证据链。v1.2–v1.8 依用户实测反馈完成「正常 SSH client」改造：GUI 可用性三轮修复（§5.4）、标准终端交互 T10（§5.5，含 native 层 IME 缺口根因修复）、多会话切换体验 T11（§5.6，每会话独立终端 + ⌘1-9）、右栏协作面板人话化 T12（§5.7，含人类键入命令捕获缺失的后端根因修复）、断线一键重连闭环 T13（§5.8，含 P1 §6-17 重连回显泄漏的根因确认与修复、§6-13 死端问题关闭）、Alt/Option 键支持 T14（§5.9，window 捕获层 meta 转发 + 简报 meta 杂讯根因修复）、鼠标上报实测 T15（§5.10，路线图③关闭——点击原生端到端实锤 + 滚轮 WebKit 编码层验证）、终端搜索/链接/标题三件套 T16（§5.11，⌘F 搜索面板、OSC8+URL 双路径链接、窗口标题随会话与 OSC 跟随；三处集成层静默失效根因修复）、主机指纹首连确认 + 变更警告 T17（§5.12，vault 持久化 TOFU：FirstSeen 确认 / Changed 红色告警 / 拒绝与超时路径 / 跨进程静默放行，审计全程留痕）、字号/主题设置 T18（§5.13，vault settings KV 持久化 + 4 预设主题 + ⌘=/⌘−/⌘0；走查暴露并修复两处既有缺陷——fitTerminal 自实现以来从未生效（xterm 5.5 无公开 dimensions）与 T17 指纹门在 MCP e2e 中的应答缺口，§4 含勘误）、标签页/分屏 T19（§5.14，一屏一签 + ◫ 50/50 分屏 + ⌘W/⌘⇧[] 快捷键 + 布局与焦点解耦；走查暴露并修复三处既有缺陷——main.tsx 双 createRoot 致全部 window 级快捷键双触发（⌘W 一次关两签审计实锤）、工具栏点击吞焦点、关焦点副 pane 黑屏），并按使用体验重排 UX 路线图（§6-18）、文件传输 T20（§5.15，v1.13——SFTP 拖拽上传到会话当前目录 + 路径下载到 ~/Downloads + 传输卡片/取消 + 审计带 transfer id；走查含覆盖层/完整性/审计矩阵与真实取消 e2e），路线图①–⑧已完成。v1.14（T21，§5.16）：~/.ssh/config 导入（共享解析器 + 预览对账 + 勾选导入）与 ssh-agent 认证（AuthType::Agent，vault 零密钥落库，russh AgentClient 逐 key 签名）已实现并经 **66 项自动化测试全绿**（新增解析器 8 例、agent 认证 e2e、导入链路集成 2 例），顺带修复测试基建既有缺陷（await_sshd_ready TCP-only 探测在 docker 端口代理下失真，journey3 在 HEAD 稳定失败的根因）；UI 视觉走查跨两日完成（首轮锁屏中止，恢复后矩阵 4 通过/1 部分覆盖并如实披露，§5.16），**UX 路线图①–⑨全部关闭**。v1.15（T22，§5.17）：模拟用户 UX 走查（4 人格并行黑盒 + demo shim 甄别，[docs/ux/2026-09-30-simulated-ux-review.md](../ux/2026-09-30-simulated-ux-review.md)）产出真实问题 26 条，第一批信任/安全 5 项已修复并经 demo 渲染层 11 项断言走查——P1-2 搜索焦点抢占根因实为 `.term-wrap` click 监听冒泡（非走查报告原推断的 mousedown 委托，两处已勘误），设置面板同根因一并修复；实机原生冒烟因锁屏中止，列为下一走查窗口顺手项。v1.16（T23，§5.18）：UX 走查修复第二批 8 项——主机编辑/删除（AuthDraft "Keep" 语义：编辑不回传明文、凭据原样保留；delete_host 补 UI 入口+确认）、关已连接标签二次确认（✕/⌘W/断开三口统一）、标签键盘可达 + Esc 统一关浮层（xterm textarea 除外）、表单常驻标签/地址校验/切换清错、接管停止结果逐条披露（Unresponsive 标红）、主机卡连接失败态、死会话终端遮罩 + 四路输入拦截、死卡单按钮与状态词完整——demo 渲染层 **20/20 断言**+cargo **66/66 全绿**；实机原生冒烟再次因锁屏中止（native Ctrl 层死会话行为记为已知边界）。v1.17（T24，§5.19）：UX 走查修复第三批（简报三层认知徽标/传输指代/＋toggle/命令框 ↑ 历史/uppercase 用户数据/favicon/收起消歧/时间戳带秒/placeholder 对比度/终端圆角/用户名默认空）——demo 渲染层 **13/13 断言**+cargo **66/66 全绿**，**走查报告 26 条真实问题全部关闭**（P3-5 对比度实测证伪：--dim 实算 5.70:1 达标，真凶是 placeholder 浏览器默认灰；全量文案 sweep 除外）。v1.18（T25，§5.20）：PV 备战三件套——沙箱故障模板（A/A′/B/B′/C 五故障 + 参考解法全实测，容器指纹守卫）、分发构建（dist.sh 实测产出 dmg/app.zip 到 dist-pv/）、分析脚本（gate 判据矩阵随 N 计算 + 审计哈希链校验，合成数据三段自测全过）与主持手册（docs/pv/session-kit.md）——招募完成即可开测；下一关仍为 validation-plan 的产品验证 gate（需真人参与者）。v1.19（T26，§5.21）：全量文案 sweep——盘点 228 行用户可见文案后挖出**审批状态契约断点**（后端 ApprovalStatus 为 PascalCase、UI 按小写过滤，真实 app 审批面板从未渲染过真卡，demo shim 小写掩住）；修复 = UI 入库归一化 + 「最近处理」六态标签（原编辑后批准/超时/作废全误报「✕ 拒绝」）+ session-api wire 格式锁定测试；分隔符收敛四条规则（元数据 `·`、破折号 `——` 无空格、标签全角`：`、产品标题 ` — ` 惯例）。demo 9/9 断言 + cargo 67/67 全绿。v1.20（T27，§5.22）：demo shim 保真轮——原 7 项伪影全部修复（按会话隔离输出、接管翻 chip+作废、审计动态追加、config 导入、TOFU 挂起门、显式报错）并挖出机制根因（shim list_* 返回同一可变数组引用使 React setState 失效）；本套件 19/19 + u4 回归 9/9 + cargo 67/67 全绿，**浏览器走查证据自此计入交互证据链**。v1.21（T29，§5.23）：路线图⑩ 前半——2FA 键盘交互认证（Password 被拒自动回落 keyboard-interactive；密码类提示自动填库内密码、OTP 类提示挂起等人工应答，指纹门同构；kb 回落 e2e + demo 双门序走查 8/8）——**2FA 服务器用现有密码主机即开即用**；GBK 编码（⑩后半）按需排期。回归守卫勘误：v1.15–v1.20 回归漏带 e2e 守卫（跳过计成通过），本轮带守卫实测 68/68。v1.22–v1.24（T28，§5.24）：**真机冒烟通过**——历经 prod-1 误点事故（结构修复为 AUTOCONNECT 零主机卡点击 + 注入前前台断言 + 主屏守卫 + host_id DB 断言的门禁体系）与九次无人值守自动触发（watcher 严格「未锁屏+idle≥75s」门禁零违反），最终全链实证：TOFU Changed 门确认（截图目验模态 + decision/trusted 审计链）、AUTOCONNECT 建会话、终端哨兵真实键入容器内落盘、⌘F 搜索面板打开、死会话自动重连→重确认（受限）→native Ctrl+C 后 app 存活（T13/T23 真机复现）；如实披露：⌘F 焦点真机复验因探针自身失效记不结论（以 v1.15 浏览器走查为准）、TOFU FirstSeen 真机未测。v1.25（T30，§5.25）：**模拟用户 PV 预演**——6 个 subagent 人格按主持手册协议完整走查（S1 真沙箱真修复 6/6、S2/S3 demo 语义真回显假），gate 矩阵实算出口「调整交互再测」，核心假设信号为正（新任务自发交接 6/6）；甄别出 9 项真产品问题（留痕呈现三件套为主）与一例实证证伪的 P1 误报；真人 PV gate 仍待招募执行。v1.26（T31，§5.26）：**PV 发现修复轮 R1–R4**——编辑后批准的实际放行命令全链可核对（core 审计带 session_id+实际命令+小写 decision、UI 时间轴/最近处理双处渲染，配套修复 pv_analyze norm_decision 与 Debug 串不匹配致 approved/edited 恒 0 的既有指标 bug）、操作记录带主机 chip、双接管按钮加常显解释与悬停说明、取消 2FA 不再误报凭据错误（demo shim 同串对齐）；demo 走查 3 组断言+截图目验全过，cargo **68/68 带守卫全绿**；R5–R8 小项与 R9（V1 候选）留待 PV 后。v1.27（T32，§5.27）：**视觉 polish 轮**——对照专业 SSH 客户端评估后补观感课：应用图标重绘（纯色方块占位 → squircle 终端窗提示符）、lucide 风线性图标体系替换全部文字假图标、全站 hover/focus-visible/0.12s 过渡反馈层、顶栏「接管并停止任务」降描边拉开危险动作层级、欢迎页文本堆重设计为品牌化空状态（顺带修复被终端层遮挡不可点击的层级缺陷）、导入行紧凑重构；demo 逐屏截图走查 + cargo **68/68 带守卫全绿**；原生标题栏集成与浅色 chrome 单独排期。v1.28–v1.33（T33–T37，§5.28–§5.32）：外壳与观感系列收口——原生标题栏融合与排版精致化（T33）、专业外壳收尾与信任可查证（T34：全中文原生菜单/版本口径 0.9.0/指纹四层贯通）、浅色 chrome 适配（T35：P2-7 收口，主题四选一全量生效）、真人上手验证与修复（T36：D1 主密钥路径不一致/D2 首屏光标归位/D3 ⌘F 全局层三缺陷修复，v1.32 增记真机复验与 TOFU FirstSeen 真机链路销账）、UI 精致化改造（T37：对照 `docs/ui-redesign-spec.md` 落地 P0–P3——色彩 token 层次/主机卡列表化/Notice Bar 体系/pill 标签页/Timeline 操作记录/简报 fact 块/skeleton/Toast 系统，规格三诊断项全销账）。v1.34–v1.36（T38，§5.33）：UX 走查遗留 R5/R7/R8 收尾 + **R9 人类→Agent 任务委托入口**（原 V1 候选提前落地——goal 随 SessionBrief 下发、`set_session_goal` 人类专属写口、goal_set 审计留痕、MCP 简报描述引导 Agent 接管先读目标，demo shim 全语义对齐 + 走查 7 断言）+ **路线图⑩后半 GBK 编码**（Charset 枚举 + 泵边界流式解码/写边界编码两边界内纯 UTF-8 + vault V4 charset 列 + docker sshd 真双向 e2e，容器 UTF-8 locale 吞尾字节系环境语义如实披露）+ **模拟 PV 四人组验证轮**（新手/交班/细节控/老系统维护者 subagent 黑盒走查，报告 docs/pv/2026-10-03-simulated-pv/）——揪出唯一 FAIL（表单下拉压至 55px 收起态不可读）与疑似阻塞项（主机卡几何中心被悬浮操作组截获）等 8 项可修问题全部修复（编码下拉独占一行/操作组收窄/GBK 徽章+title/目标框自动增高/草稿按 sid 暂存/会话卡 title/toast 文案/tooltip 补编码），会话内临时切编码等 5 项如实披露不修；修复验证 10/10 断言 + 截图 9 张归档，cargo 带守卫全绿 + tsc/vite 通过，**UX 路线图①–⑩全部关闭**。v1.37（T39，§5.34）：**独立审核与视觉复验轮**——独立 subagent 代码审核（对抗性走查 T37/T38 全量 UI diff + demo shim 与真实后端逐字段比对）挖出**阻塞级 B1**：Charset serde 线格式 `"utf8"` 与 UI 发送的 `"utf-8"` 断裂，真实 app 保存任何主机必失败（demo shim 按错误口径放行恰好掩住）——修复为显式 `rename="utf-8"/"gbk"` 三方对齐并新增 wire 锁定测试按 UI 载荷形态断言；**高危 H1** 任务目标跨会话串台（A 的委托短暂显示在 B 输入框、随手保存即写入 B）——refreshBrief 过期丢弃 + 切换即清空双修；另修 GBK 徽章置名前（hover 交互时刻恒可见）、认知色淡底 token 化三色板（浅色下恢复可辨）、demo transitions 机制对齐、连接 spinner、浅/solar --dim 达 AA 等 5 低危 + 打磨批；独立视觉复验 38 断言全 PASS 并收口 skeleton 首载实证（7 帧）与浅色 attach-hint 定性（设计内淡出非缺陷）；v1.37 验证 7/7 + 回归 17/17 + cargo 带守卫 EXIT=0——独立复核再次证明「作者自证必有盲区」。v1.38（T40，§5.35）：**FR-2 密钥认证收尾**——对照 Termius 复核时证伪自家「密钥认证缺失」判断（三态选择器/后端/导入路径皆在），真实缺口收敛三点全收口：生成 ed25519 入口（vault 就绪 UI 无门）、指纹确认（回包指纹此前被丢弃，改先绑定后确认流）、私钥从文件导入（纯 Web file input，双端一致）；顺带以 T39 的逐字段比对法挖出并修复 demo `upsert_host` 硬编码 auth_type 的对账缺陷（密钥/Agent 主机浏览器徽章错误），新增 IdentityReq/AuthDraft/IdentityMeta wire 锁定测试；走查 11/11 + cargo 带守卫 77 例 EXIT=0。**当日真机冒烟增记**：新增 `TINYSSH_SMOKE` dev harness（eval 注入驱动 + beacon 回传，工具入库 scripts/native-smoke/），真实二进制走完密钥认证全链——导入→指纹确认（与 ssh-keygen 逐字一致）→保存→TOFU→密钥建连→`whoami`→root→重启持久化，审计 7 条完整，§5.35 披露①（真实 app 三步顺手项）销账；cargo 带守卫复跑 EXIT=0。v1.39（T41，§5.36）：**SFTP 远程文件浏览器（FR-7 提前落地，用户指示）**——`ChannelHandle::list_dir` 双通路实现（SSH 临时 SFTP 通道 / 本机 read_dir，目录在前名称序），`sftp_list` 人类只读编排（不经审批不入审计，Agent 无此入口），UI 右栏「远程文件」区（路径跳转/上一级/刷新/行内下载到 ~/Downloads/拖放目标升级到浏览目录/首载简报 cwd/sid 归属纪律）；复用 T20 传输管线（卡片/取消/审计/toast），新增真 sshd e2e + DirEntryS wire 锁 + 浏览器走查 9/9 + 真机 internals 直调实证（容器 /root 返回 2 条目目录识别正确）；cargo 带守卫 79 例 EXIT=0；mkdir/删除/双栏/递归下载留 V2 如实披露。
