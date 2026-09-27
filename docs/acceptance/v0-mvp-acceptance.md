# V0 MVP 工程验收报告

> 版本：v1.0 · 日期：2026-09-27 · 验收对象：V0 thin-slice MVP（[PRD v0.5 §10](../prd.md)、[L1 v0.5](../architecture/l1-component-design.md)、[validation-plan v0.3](../validation-plan.md)）
> 验收方式：自动化测试 + Spike 基准 + GUI 交互走查；全部可复现（见 §6 复现指令）。

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
| `mcp-server` | ✅ | rmcp 3.4.1 streamable HTTP + per-client Bearer（逐请求解析，身份仅来自 Token）+ 13 工具 + annotations + isError 错误载荷；**仅依赖 session-api 契约**（`Arc<dyn SessionApi>` + Token 解析闭包，装配留壳层——L1 §1 依赖规则验收通过） |
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

## 4. 测试统计（全量 `cargo test --workspace`）

| 套件 | 数量 | 覆盖 |
|---|---|---|
| core_local（核心管线） | 7 | Shell 现场延续（cd 跨 exec）、Fresh 真实退出码+镜像回放、审批批准/拒绝、allow 规则免审、危险模式不可批准、**接管作废全链路**、队列背压 |
| term-core | 12 | 块生命周期（A/B/C/D）、Agent 键入归因、受管块、OSC 跨 feed、OSC7、快照、捕获、回放 |
| approval | 11 | 精确/前缀/正则、TTL 过期、复合命令逐段（绕过用例）、内置 deny 不可删、ApproveEdited 不可越 deny、解析失败保守报审 |
| audit | 2 | 追加/查询/导出、**篡改检测** |
| vault | 4 | 加解密往返+篡改、Token 生命周期、主机口令加密存储、ed25519 生成与解密 |
| e2e_acceptance（真实 OpenSSH） | 2 | **首验收场景**、旅程 2（断线→重连→Reconfirming：白名单外被拒、核实后自动恢复、cwd 事实 NeedsRecheck→核实 Confirmed、重连后为新 shell 不谎报现场延续） |
| protocol（SPIKE-3） | 1 | §3 表 |
| shell_integration（transport-pty） | 1 | 本地 zsh 集成 + 块 + OSC7 + Fresh 退出码 |
| sshd_e2e（transport-ssh） | 1 | SSH 块 + cwd + Fresh env + SFTP 往返 |
| spike2 | 1 | §3 表 |

**合计 41 个测试（30 个套件），0 失败（连续两轮全量回归验证）。** 共享 docker sshd 的测试（含 docker restart 的旅程 2）以跨进程文件锁串行（`tinyssh_testbed::sshd_lock`），消除并行 flake。

## 5. 已知边界（诚实清单）

1. **PV 用户研究未执行**：validation-plan §6 的 6–8 人产品验证 gate 需要真人参与者，不属于本次工程验收；工程侧前置条件（thin-slice 可用 + 三 Spike 门限 + 首验收场景）已全部就绪。
2. **GUI 视觉验收方式**：本环境无法截取原生 WKWebView 窗口（无屏幕录制权限），Tauri 窗口可创建/可 eval/devUrl 正确（setup 日志）；UI 以同代码路径的浏览器演示模式（`ui/src/demo.ts`，明确标注）完成交互走查——接管/交还/批准/简报/时间线全部生效并有截图留档。真机验收命令见 §6。
3. **Keychain 首次访问**：无头环境运行需 `TINYSSH_MASTER_KEY` 覆盖（桌面正常使用会弹钥匙串授权，属预期）。
4. **Shell 模式输出流**：PTY 合并 stdout/stderr（ExecResult.stderr 为空，文档如实标注）；Fresh 模式有独立双流。
5. **env_summary**：V0 不追踪 env 变更（简报如实标注"printenv 核实"）。
6. **无集成主机自动降级 Fresh**（L1 规定），E2E 中 ash→bash 切换即此语义的演示。

## 6. 复现指令

```bash
# 0) 依赖：Rust 1.93+ / Node 24 / Docker（sshd 测试容器）
scripts/dev-sshd.sh          # 起 tinyssh-e2e 容器（127.0.0.1:2222，root/testpass）

# 1) 全量测试（含真实 OpenSSH e2e 与 SPIKE-2；SPIKE-3 含 120s 等待约 2.5 分钟）
export TINYSSH_MASTER_KEY=$(python3 -c "print('07'*32)")
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
```

## 7. 结论

**工程验收通过。** 文档（PRD/L0/L1 v0.5）定义的 V0 thin-slice——一个真实共享会话、Shell 模式现场延续、逐段审批、接管/交还契约（含旧请求与待审批卡片作废）、现场简报、可读操作记录、MCP 双前端对等——已实现并被 42 个自动化测试与 3 项 Spike 门限覆盖；**首个可运行验收场景在真实 OpenSSH/Linux 环境以 MCP Agent + 人类双前端端到端通过**。下一关为 validation-plan 的产品验证 gate（需真人参与者）。
