# V0 MVP 工程验收报告

> 版本：v1.1 · 日期：2026-09-28 · 验收对象：V0 thin-slice MVP（[PRD v0.5 §10](../prd.md)、[L1 v0.5](../architecture/l1-component-design.md)、[validation-plan v0.3](../validation-plan.md)）
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

## 4. 测试统计（全量 `cargo test --workspace`，v1.2 实测口径）

| 套件 | 数量 | 覆盖 |
|---|---|---|
| core_local（核心管线） | 7 | Shell 现场延续（cd 跨 exec）、Fresh 真实退出码+镜像回放、审批批准/拒绝、allow 规则免审、危险模式不可批准、**接管作废全链路（含作废卡片不得仍 pending）**、队列背压 |
| handle 白名单单元回归 | 1 | **重确认白名单仅限单条简单命令（M1 回归：`pwd && evil` 等复合形态全部拒绝）** |
| term-core | 12 | 块生命周期（A/B/C/D）、Agent 键入归因、受管块、OSC 跨 feed、OSC7、快照、捕获、回放 |
| approval | 12 | 精确/前缀/正则、TTL 过期、复合命令逐段（绕过用例）、内置 deny 不可删、ApproveEdited 不可越 deny、解析失败保守报审、**命令替换强制报审（M2 回归）**、**deny 规则逐 agent（m3 回归）** |
| audit | 2 | 追加/查询/导出、**篡改检测** |
| vault | 4 | 加解密往返+篡改、Token 生命周期、主机口令加密存储、ed25519 生成与解密 |
| e2e_acceptance（真实 OpenSSH） | 3 | **首屏干净回归（v1.2：read_screen 不得含注入回显/scrollback）**、**首验收场景**、旅程 2（断线→重连→Reconfirming：白名单外被拒、**复合白名单形态被拒（M1 回归）**、核实后自动恢复、cwd 事实 NeedsRecheck→核实 Confirmed、重连后为新 shell 不谎报现场延续） |
| protocol（SPIKE-3） | 1 | §3 表 |
| shell_integration（transport-pty） | 1 | 本地 zsh 集成 + 块 + OSC7 + Fresh 退出码 |
| sshd_e2e（transport-ssh） | 1 | SSH 块 + cwd + Fresh env + SFTP 往返 |
| spike2 | 1 | §3 表 |

**合计 45 个测试，0 失败（v1.2 修复后最终回归）。** 修复前基线由独立验证员复跑确认 41/41（见 §5.2）。共享 docker sshd 的测试以跨进程文件锁串行（`tinyssh_testbed::sshd_lock`），持锁后等待容器就绪（`await_sshd_ready`），消除重启时序 flake；全量回归须先编译后运行（见 §7），避免同机争抢 CPU 拉长会话首提示符延迟（§6.1-11）。

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

**GUI 可用性 P0 修复清单**（用户实测反馈驱动，全部改动限于 `ui/`，核心层零改动）：

1. 添加主机表单（密码 / 私钥粘贴，接 `upsert_host` + `create_identity`）——此前唯一入口是 CLI；
2. 连接状态机：连接中禁用按钮、失败给出可读原因（认证失败/超时/拒绝对应中文提示+原始错误）、成功自动 attach 并聚焦；
3. 会话状态徽标（已连接/中断/重连中/重确认）+ 3s 轮询 + 断开按钮（接 `close_session`）；
4. 终端尺寸自适应 + PTY resize 对齐；
5. 文案清理：控制权无 Agent 时显示"手动"、MCP 面板空状态改为接入指引、命令框 placeholder 标明执行位置、审批"编辑后批准"改为卡片内联编辑（原 `window.prompt` 在 WKWebView 不可用）。
6. 测试统计更新为 **45 个自动化测试**（新增 `create_session_screen_is_clean`）。

演示模式 shim（demo.ts）同步扩展：支持 upsert_host/create_session 失败注入/close_session/resize，浏览器走查与真实 UI 保持同一代码路径。

## 6. 已知边界（诚实清单）

1. **PV 用户研究未执行**：validation-plan §6 的 6–8 人产品验证 gate 需要真人参与者，不属于本次工程验收；工程侧前置条件（thin-slice 可用 + 三 Spike 门限 + 首验收场景）已全部就绪。
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
12. **演示 shim 简化**（ui/src/demo.ts）：不模拟"接管自动作废演示卡片""段裁决随决策更新"；截图为 UI 走查证据，核心语义以自动化测试为准。

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
```

## 8. 结论

**工程验收通过。** 文档（PRD/L0/L1 v0.5）定义的 V0 thin-slice——一个真实共享会话、Shell 模式现场延续、逐段审批、接管/交还契约（含旧请求与待审批卡片作废）、现场简报、可读操作记录、MCP 双前端对等——已实现并被 **45 个自动化测试**与 3 项 Spike 门限覆盖；**首个可运行验收场景在真实 OpenSSH/Linux 环境以 MCP Agent + 人类双前端端到端通过**。v1.1 补充的独立 subagent 审计（§5.1）发现的 2 个审批安全缺口（M1/M2）与 6 个次要缺口已全部修复并附回归测试，3 项如实披露为边界；独立复跑与浏览器视觉走查（§5.2/§5.3）补齐了第三方复现证据链。下一关为 validation-plan 的产品验证 gate（需真人参与者）。
