# R43 验收证据（G4 四/五：新装启用、原子停用与旧 Agent 配置迁移，实现 C9）

范围：`docs/ux/ssh-client-ux-refactor.md` §9（C9 协作启停，line 545-575）/ §6.7（line 391，新装未启用时主界面不出现空审批区、任务目标、控制权教学、MCP 配置）/ §10.1 item 6（升级与新装判别）；
交付验收项 **D03**（新装无自动 MCP 监听；旧身份/Token/端点按迁移策略继续可用）与 **D08**（关面板不改变控制；确认停用先原子封 admission，旧未启动请求作废，已运行按策略收敛；应用端点停止且已接纳请求收敛后方可 Disabled，不等待外部 shim 退出，其调用仍不能执行；失败不解封、重新启用不复活旧动作）。
基线：R42（HEAD `cd7c0c7`）。

## 本目录文件

| 文件 | 说明 |
|---|---|
| `r43-demo-probe.js` | R43 演示域探针（**60 断言**：A 新装默认停用 / B 显式启用与 configured≠online / C 关面板不改权 / D 原子停用 / E 重启用不复活 / F 停用未收敛（DisableFailed）重试面 / Z 零 JS 异常）。 |
| `r43-driver.sh` | 原生冒烟驱动（真核心 + 真 vault + 真 sshd 容器；r43a 新装默认停用 + 原子停用，r43b 升级路径）。 |
| `oldcode-r43.js` + `oldcode-run1.txt` | 旧码判别力实跑（对 `:5184` = R42 基线）。 |
| `reg-r42-probe.js` + `reg-r42.txt` | R42 探针的 R43 回归版（含 G 节三处 §12 同步变更，见下）。 |
| `redside-r43.txt` | 红侧变异记录（RED-K8…K16，含处置后 F1/F2/F3 回归护栏）。 |
| `rev-r43-findings.md` | 独立审核员（rev-r43）首轮结论（**不通过**：阻断 F1/F2）。 |
| `rev-r43-disposition.md` | 作者侧逐条处置（F1–F7）+ 复跑对账。 |
| `vis-r43-report.md` + `vis-r43-*.png` | 独立视觉复验（vis-r43），含 F3/F5 处置后的补验小节。 |

## 实跑结论

- **R43 演示探针：60/60 PASS**（对 `:5183`，`r43-demo-probe.js`；含 F1–F9 停用未收敛重试面）。
- **R42 回归：38/38 PASS**（`reg-r42-probe.js`，对 `:5183`；G 节三处 §12 同步变更见下）。
- **旧码判别力：全部判别性断言在旧码上失败**（对 `:5184` = R42 基线）——`collab_status` / `collab_enable` / `collab_disable_preview` / `collab_disable` 四命令在旧 demo shim 上**根本不存在**（`ERR → 演示 shim 未实现该命令`）；`?fresh` 新装态在旧码上仍显示 MCP 端点 `http://127.0.0.1:8722/mcp（演示模式）`、零停用指引、零启用钮。即 R43 的 C9 面在旧码上完全不成立。
- **Rust**：`core-session` lib **108 通过 / 0 失败**（98 基线 + `r43_tests` **10** 项）；`vault` 32；`mcp-server` 3（含端点停机信号）；`session-api` 12；`cargo test --workspace` **全绿**。
- **构建**：`cargo build --release -p tinyssh-app` Finished（仅既有 warning）；`npx vite build` ✓ built。
- **原生冒烟 r43a / r43b：未跑（屏幕锁定，WKWebView 冻结闸）**——按规约登记为**待用户解锁后重跑**（`r43-driver.sh` 已就绪，前置：`tinyssh-e2e` 容器在跑）。本文件**不主张**任何原生域结论。
- **独立审核 rev-r43**：首轮 **不通过**（阻断 F1/F2）→ 处置（见 `rev-r43-disposition.md`）→ 二轮定向复核 **可签**（F1–F6 真正闭合，均经独立复跑 + 单点变异实证判别力；F7 不处置可接受；新增 F8 为经 UI 不可达的低级潜在不一致）→ **F8 已采纳修复** → 三轮极窄复核 **「F8 闭合，维持可签」**（独立核：`EndpointHandle` 全仓无 `clone`、唯一持久化点即 `AppState.mcp_endpoint`，故 `take`+`drop` 覆盖全部 sender；回滚后无死锁/无半态、下次启用经 `bind_increment` 自动递增端口不卡住；`cargo check -p tinyssh-app` Finished）。
- **独立视觉复验 vis-r43**：首轮 6 项清单达标（零阻断/零中级）→ F3/F5 处置后补验 4/4「所见 = 期望」（零 JS 异常）→ 补验发现 2 项低级问题**均已闭合**：**O-5**（`DisableFailed` 文案重复「（保持封闭）」）→ 删冗余后缀；**D-1**（新增 `停用协作…` 钮浅色对比度 3.91:1 < AA）→ 令牌名笔误 `var(--err, #e5484d)` 正名为 `var(--danger)`，复验浅 **5.32:1** / 深 **5.00:1** 均过 AA。**D-1 的归属经审核员以 `git show HEAD` 硬证据更正**：该控件是 **R43 新增**（非沿袭既有），作者已接受更正并按 R35 既有 AA 口径一并处置。详见 `vis-r43-report.md`。

## §12：复用 R42 测试时的同步变更（对象/断言更新）

R42 探针原样对 R43 树跑为 **35/38**（G2/G6/G7 红）。逐条核对后确认**三项均为 R43 契约取代 R42 新装面的预期变更，非回归**；`reg-r42-probe.js` 按下列同步后 **38/38**：

1. **G2**：`collab-unconfigured`（R42 一次性引导）→ `collab-disabled`（R43 停用指引）。R43 新装默认停用（D03），协作面板改「协作已停用」指引，结构 testid 随之更名；判定条件（不渲染空壳/空审批区）不变。
2. **G6**：`agent-empty`（R42 设置空态）→ `collab-disabled-note`（R43 设置停用说明）。设置侧停用态 testid 更名，判定不变。
3. **G7 断言反转**：R42 新装默认**开启**，故设置里**有** MCP 端点；R43 新装默认**停用**（D03「无自动 MCP 监听」），故设置里**无**端点。此即 R43 的**预期行为变更**，故断言由 `=== 1` 反转为 `=== 0`。

其余 35 项断言（入口/分组/目的/首次委托/接管交还/窄窗完整视图）对象与判定**逐字不变**，全部通过。

## 关键实现（供复核对照）

### 契约面（session-api）
- `CollabState` 四态 `Enabled / Disabling / Disabled / DisableFailed`；`CollabStatus`（含 `endpoint`、`configured_agents`、`active_requests`、`kept_agents`）；`CollabImpact`（停用预览事实：受影响会话 / 待审批 / 已配置 Agent）。
- `collab_status` / `collab_enable` / `collab_disable_preview` / `collab_disable` 四命令（`collab_status` 为**人类专属**）。

### 会话层（core-session）
- `ApprovalCenter` 持 `CollabGate { state, generation }`，`admit_agent()` 为**单点 admission 门**——**仅** `Enabled` 放行；`Disabling` / `DisableFailed` / `Disabled` 一律拒绝新 Agent 请求（C9 首句：不等待逐个接管才封入口）。
- `collab_disable`：**原子**进入 `Disabling` → 作废待审批（留痕）→ `convert_agent_sessions_to_human`（**同时推进每会话 `generation`**，与接管同口径）→ 收敛。
- `collab_enable`：**仅当 `state == Disabled`**（即旧停用处理已收敛）才放行；`Disabling`（收敛中）与 `DisableFailed`（收敛失败）均拒（`InvalidInput("停用处理尚未收敛，无法重新启用")`）。重开即 `generation += 1` 开新代际——**先前作废请求不复活**。
- `SessionHandle`：新增 `admit_agent_actor()`（人类不经此门——人类是主权者）；exec **取槽后**与**执行前（步骤 4）**各复核一次 admission——覆盖无 session 的 `create_session`、已批准未执行、排队传输及存活 HTTP/shim 调用中的待启动动作；`wait_approval` 在**批准（含 `ApproveEdited`）后、执行前**对称复核，失败即作废卡片（`ApprovalStatus::Voided`）并写回。
- `collab_mark_endpoint_stopped` / `collab_mark_disable_failed`：应用侧端点停机确认与失败回退（后者使 DisableFailed 可重试，非死代码）。
- `r43_tests.rs` **10 项**（均可红）：新装无端点且 gate 关闭 / 停用原子封 admission + 作废 + 转 Human / 已批准未执行作废 / **停用推进会话代际** / **排队 AutoAllow exec 被停用作废** / **ApproveEdited 后作废** / 停用失败 gate 保持关闭且可重试 / 状态分离 configured 与 active / 启用需收敛且不复活作废项 / **DisableFailed 拒绝重开**。

### 存储层（vault）
- **V7 迁移**：`let default_enabled = if version == 0 { "0" } else { "1" };` + `INSERT OR IGNORE INTO settings(key,value) VALUES('collab.enabled',?1)`；`user_version=7`。**新装默认停用**（version 0 → "0"）；**升级保留旧默认开启**（version ≥1 → "1"）——按既有 vault/schema 标记判别，**不**以「无 Agent 在线」判别（§10.1 item 6）；不因 UI 简化撤销既有 Agent Token。

### MCP 端点生命周期（mcp-server）
- `EndpointHandle` 增 `stopped` 信号（`axum::serve` 返回后置真）+ `is_stopped()` / `wait_stopped()`：**监听器关闭 ≠ 核心 gate 已生效**，两层均需确认（C9）。`spawn_endpoint` 标注 legacy/测试专用（无停机语义）。

### 应用层（src-tauri）
- `collab_disable`：`stop()` → 有界等待 `wait_stopped()`（5s）→ 确认才 `set_mcp_endpoint("")` + `collab_mark_endpoint_stopped` → Disabled；超时**保留句柄**（供重试）+ `collab_mark_disable_failed` → DisableFailed（**失败不解封**）。
- `collab_enable`：**先起端点再开 gate**（端点起不来即失败返回、核心保持停用；句柄 drop 触发优雅停机）；核心拒（未收敛）则回滚端点。

### 前端（ui）
- `App.tsx`：协作面板停用态 = 一次性停用指引（**不渲染空审批区/空白委托表单**，§6.7 line 391）；设置 → Agent 接入停用态无 MCP 配置/端点；状态 chip 四态；停用预览对话框（事实齐全 + 取消不改状态）；停用态按钮**按状态拆分**——`DisableFailed` → `collab-retry-disable-btn`「重试停用收敛」/ `Disabling` → 无钮（收敛中）/ `Disabled` → `collab-enable-btn`「启用协作」；`enableCollab` 按返回 `endpoint` **如实** toast。
- `demo.ts`：`collab_enabled` 默认停用；`?fresh` 新装态；`?disablefailed` 复现 DisableFailed（`collab_enable` 同真实核心拒绝）。

## 红侧判别（`redside-r43.txt`）

| 编号 | 变异 | 结果 |
|---|---|---|
| RED-K8 | 新装默认仍启用协作 | 43/51 |
| RED-K9 | 停用不封 admission | 45/51 |
| RED-K10 | 停用不把 Agent 会话转回 Human | 49/51 |
| RED-K11 | 停用即隐藏/撤销 Agent 身份（违反「Token 保留」） | 49/51 |
| RED-K12 | admission 门放宽（Disabling/DisableFailed 也放行） | r43 3/6 红 |
| RED-K13 | 停用不推进会话代际（F1 处置护栏） | r43 1/10 红 |
| RED-K14 | 批准后复核漏 ApproveEdited 臂（F2 处置护栏） | r43 1/10 红 |
| RED-K15 | 重新启用放宽为「仅挡 Disabling」（F3 处置护栏） | r43 1/10 红 |
| RED-K16 | DisableFailed 仍渲染「启用协作」钮（F3 UI 护栏） | 56/60 |

（二轮复核另由审核员独立变异实证 F1 双保险：删代际推进 → 代际用例独红而排队用例仍绿；置空 `admit_agent_actor` → 10/10 全绿——两机制互为冗余。）

全部 Edit 反向还原、无 `RED-K` 残留；还原后 `cargo test -p core-session --lib r43` 复跑 **10/10**、`r43-demo-probe.js` 复跑 **60/60**。

## 未主张 / 待人工确认

- **原生 GUI 冒烟 r43a / r43b 未跑**（屏幕锁定）；原生域的「真 vault V7 迁移 → 升级默认开启 + Agent 保留」「真核心原子停用 + 端点停机确认」**尚未实证**，登记为待用户解锁后重跑。
- 视觉复验首轮覆盖 F3/F5 改动**前**的 UI 快照；补验节覆盖新增 DisableFailed 面。
