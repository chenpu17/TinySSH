# R43（C9：新装启用、原子停用与旧 Agent 配置迁移）独立审核 findings

审核对象：未提交的 R43 工作树变更（基线 HEAD `cd7c0c7`）。
审核人：独立审核 subagent（作者自查不算数）。**未修改任何代码**（只读审核 + 独立复跑）。
判定基准：`docs/ux/ssh-client-ux-refactor.md` §9（C9 停用语义 562-568）/§6.7（391）/§10.1-6；交付表 R43 行 + D03/D08。

## 独立实测（不止读码）

| 命令 | 结果 |
|---|---|
| `cargo test -p core-session --lib r43` | **6 passed / 0 failed** |
| `cargo test -p core-session`（全 lib+集成） | 104 / 4 / 13 / 4 passed，0 failed |
| `cargo test -p tinyssh-vault c9_collab` | **1 passed**（V7 迁移新装/升级/幂等/显式优先） |
| `cargo test -p session-api` | 12 passed |
| `cargo test -p tinyssh-mcp-server` | 6 + 3 passed（protocol 走真实 `collab_enable` 开门） |
| `PROBE_URL=:5183 node r43-demo-probe.js`（当前码） | **51/51** |
| `PROBE_URL=:5184 node r43-demo-probe.js`（旧码 R41 基线） | 崩于未知命令（0/1）——判别力实证，非恒绿 |
| 原生 GUI 冒烟 | **未跑**：`CGSessionCopyCurrentScreenIsLocked`=**locked**（WKWebView 冻结闸），按规约不跑；且目录内无 beacon 归档 |

---

## 高严重度

无。

## 中严重度

### F1 停用不 void「排队/待启动」的 Agent 动作——D08「旧未启动请求作废」未达标
- 位置：`crates/core-session/src/lib.rs:1407-1419`（`convert_agent_sessions_to_human` 直接置 `owner=Human`，**不递增** `SessionHandle.generation`）；`crates/core-session/src/lib.rs:1369`（`void_all_pending` 只作废 `ApprovalStatus::Pending` 的**审批卡**）；`crates/core-session/src/lib.rs:33-45`（`CollabGate.generation` 全仓**无任何消费方**——从不与任何请求核对）；admission 仅在入口点：`lib.rs:1680`（exec 入口）、`2978-2982`（transfer 入口）。
- 缺陷陈述：停用的作废面只覆盖「审批卡（Pending）」与「控制权」，**不覆盖已在会话 exec 串行队列中等待、或已在传输队列中排队、且无需审批（AutoAllow / 已过策略）的动作**。会话级 `generation` 才是「执行开始前」唯一的作废核对点（`handle.rs:498/502/558`），而停用没有推进它；中心级 `CollabGate.generation` 只是记录、从不核对，故形同虚设。
- 失败场景（输入/状态 → 错误结果）：
  1. 会话 s 控制权=Agent，协作 Enabled。
  2. Agent 发长命令 A（占住 `exec_slot`，`handle.rs:499`）。
  3. Agent 再发**命中允许规则（AutoAllow）**的命令 B → B 进入 `exec_slot` 等待（`handle.rs:490-505`），此时 B **无审批卡**。
  4. 人类确认停用协作：`collab_disable` 作废 Pending 卡（B 没有）、把 owner 转 Human——**B 不在作废面**。
  5. A 结束、B 取得槽位：`handle.rs:502` 与 `558` 只比对会话 `generation`（未变）→ 放行；step 3 AutoAllow 不进审批 → **B 在停用（Disabling/Disabled）期间照常执行**，且 owner 已是 Human。
  - 传输同理：`transfer()` 仅在入口核对 admission（`lib.rs:2978`），已入队（`TransferStatus::Queued`，见 `r34_tests.rs:648`）的传输在停用后仍会获锁开跑——正是 §9 明文点名的「排队传输」。
- 期望（§9）："已有请求在执行开始前还须核对停用 generation，覆盖…排队传输及…待启动动作；它们作废留痕"。
- 最小复现/证据：代码路径如上（`convert_agent_sessions_to_human` 未触 `SessionHandle.generation`；`CollabGate.generation` 无读者）。对照既有机制：接管 `handle.rs:821` `generation.fetch_add(1)` 正是靠推进会话 `generation` 作废排队动作——停用应复用该机制（或让「开始前」核对点同时 `admit_agent()`），当前两处都缺。现有 r43 用例未覆盖「排队中动作」这一面（`r43_disable_seals_admission_voids_and_converts` 只放了一张 Pending 卡）。

### F2 「批准-编辑后」（ApproveEdited）缺 admission 复核——与 Approve 臂不对称
- 位置：`crates/core-session/src/handle.rs:704-716`（`Decision::Approve` 臂**新增**了停用复核）vs `handle.rs:723-733`（`Decision::ApproveEdited(c)` 臂**无**该复核）。
- 缺陷陈述：R43 只在「直接批准」臂加了「批准后、执行前复核 `admit_agent()`」；「编辑后批准」臂没有。UI 存在该入口（`ui/src/App.tsx:4702` 「保存并批准」→ `decision:"edit"`），故可达。
- 失败场景：Agent 请求需审批命令 X；人类点「保存并批准」把 X 改成 Y（`decide_approval` 投递 `ApproveEdited`，`lib.rs:2280`）；此间确认停用协作 → `wait_approval` 走 ApproveEdited 臂**不复核 admission** → 直接返回 `ApprovedEdited` → exec 继续执行（exec 仅在入口 `lib.rs:1680` 核对过、step 4 只比对会话 generation）。即「已批准未执行」在停用期间被执行，与 §9 相悖。
- 最小复现/证据：`handle.rs` 两臂对比；`r43_approved_request_after_disable_is_voided_not_executed` 只测了 `Decision::Approve` 臂，未覆盖 `ApproveEdited`。

## 低严重度

### F3 重新启用未要求 DisableFailed 已收敛 + UI「重试停用收敛 / 重新启用」按钮语义相反
- 位置：`crates/core-session/src/lib.rs:2548-2570`（`collab_enable` 只挡 `Disabling`，对 `DisableFailed` **直接置 Enabled**）；`ui/src/App.tsx` 停用态启用钮（`data-testid="collab-enable-btn"`）文案 `DisableFailed ? "重试停用收敛 / 重新启用" : "启用协作"`，其 `onClick` 只调 `collab_enable`。
- 缺陷陈述：`DisableFailed` 语义即「收敛失败」，§9 要求「由核心确认旧停用处理已收敛再重新开启 gate」；此处把「未收敛」当「可重开」。且 UI 把「重试停用收敛」与「重新启用」并到同一颗按钮，点击实际执行的是**重新启用**——用户想重试停用反而把协作打开了；UI 也没有任何「重试停用」入口（「允许重试处理」未落地）。
- 失败场景：端点停止失败 → `DisableFailed`；用户点「重试停用收敛 / 重新启用」→ 协作被**启用**（而非重试停用），与按钮一半文案相反。

### F4 声明 Disabled 前未确认端点实际停止；`collab_mark_disable_failed` 在应用侧是死代码
- 位置：`src-tauri/src/main.rs:765-776`（`h.stop()` 仅发停机信号，随后**不等待**即 `set_mcp_endpoint("")` + `collab_mark_endpoint_stopped` → Disabled）；`collab_mark_disable_failed`（`lib.rs:2527`）全仓**无应用侧调用方**。
- 缺陷陈述：§9「应用拥有的 MCP 端点已停止…被确认后，才显示 Disabled」「失败保持 Disabling/DisableFailed」。应用侧是「发信号即当已停」，无确认、无失败分支，故 `DisableFailed` 经产品路径**不可达**（仅测试可达）。axum 0.8.9 优雅停机确会在收到信号后 `drop(listener)`（`serve/mod.rs:296-297`）释放监听器，实践上端点会停；但「两层均需确认」的**确认**未实现，失败/异常时无兜底。
- 失败场景（窄）：运行时停滞/停机任务异常 → 监听器未释放，应用仍显示「已停用」并清空端点地址（状态与事实不符）。

### F5 重新启用若端点 bind 失败，仍报「协作已启用——MCP 端点运行中」成功提示
- 位置：`src-tauri/src/main.rs:780-800`（`collab_enable` 先把核心置 Enabled，再 spawn 端点；spawn 失败仅 `set_mcp_endpoint("")` 返回 `collab_status`=Enabled+空端点）；`ui/src/App.tsx` `enableCollab` 无条件 `pushToast("ok","协作已启用——MCP 端点运行中…")`。
- 失败场景：端口段 8722..8753 被占满 → 核心 Enabled（admission 开）但端点未起，UI 却提示「端点运行中」；且状态栏显示「已启用」而端点为空串，自相矛盾。

## 信息（不阻断）

### F6 `spawn_endpoint` 现仅测试在用；`mem::forget` 泄漏停机发送端
- 位置：`crates/mcp-server/src/lib.rs:721-731`。`spawn_endpoint` 的生产调用方（src-tauri）已全部改用 `spawn_endpoint_with_shutdown`；仅 `crates/mcp-server/tests/protocol.rs:238` 仍在用。`mem::forget(handle)` 使 `watch::Sender` 永不落地→端点不可停。当前无生产影响（CLI `serve` 自建 router、不走此函数），但该函数已无法停机，宜标注为 legacy/测试专用。

### F7 core-only Enabled 的 `collab_status.endpoint` 返回占位串
- 位置：`crates/core-session/src/lib.rs:179-181`（`mcp_endpoint` 默认值是人读占位串 `"…（被占递增；以端点装配方输出为准）"`）；`lib.rs:2454` Enabled 时直接返回它。真实 app 启动即 `set_mcp_endpoint` 覆盖，故仅影响无装配方的核心直用（测试/CLI）；`collab_status` 为人类专属，实际调用方只有 app，影响可忽略。

---

## 已核查且**无问题**的面（逐条给结论）

- **原子封 admission**：`collab_disable`（`lib.rs:2484-2515`）在**任何 await 之前**同步置 `state=Disabling` 并 `generation+=1`，随后才作废/转换——封口原子、不等待逐个接管。✓
- **`admit_agent` 单点且仅 Enabled 放行**：`lib.rs:1349-1353` `state==Enabled` 才 Ok；`Disabling/Disabled/DisableFailed` 一律 Err(`CollabDisabled`)。覆盖入口：`create_session`（`lib.rs:263`，含无 session 的 Agent 建会话）、`exec`（1680）、`send_keys`（1731）、`create_tunnel`（2153）、`control_tunnel`（2192）、`transfer`（2980，含 upload/download）。`sftp_list/resolve_path` 人类专属、`sftp_stat` 只读元数据——非动作面，不属 gate 范围。✓
- **作废留痕/唤醒**：`void_all_pending`（`lib.rs:1369-1405`）作废 Pending 卡、落库、审计 `approval_voided`、并 `decide` 通道投递 `DecisionMsg::Voided` 唤醒等待方（`handle.rs:740-743` → `VoidedByHandback`），不空等 120s；锁使用无自死锁（快照先落 `let`）。✓（仅作废面偏窄见 F1）
- **控制权收敛**：`convert_agent_sessions_to_human` 只改 owner、不终止运行中任务；`ever_agent_owned` 保留（`r43_disable_seals_admission_voids_and_converts` 断言）。✓
- **迁移 V7（§10.1-6）**：`crates/vault/src/lib.rs` `let default_enabled = if version == 0 { "0" } else { "1" }` + `INSERT OR IGNORE` + `user_version=7`；新装（version==0）默认关、升级默认开、幂等、显式偏好不被覆盖、**不吊销任何 Agent Token**。**独立复跑 `cargo test -p tinyssh-vault c9_collab` 通过**。✓
- **configured ≠ online**：`collab_status` 分别给 `configured_agents`（未撤销身份数）与 `active_requests`（待审批 + Agent 持有会话）；UI 分列 `collab-configured` / `collab-active`（demo 探针 B4/B5/B8/B9、原生 r43a-indicators-ok 均验）。✓
- **外部 stdio shim**：不作为 Disabled 条件、应用不 kill 它；停用期端点已停（连接被拒）**且** admission 关闭（`CollabDisabled`）双保险；MCP 工具表（`mcp-server/src/lib.rs` 341-630）**未**暴露 `collab_*`（人类专属，agent 调用被 `InvalidActor` 挡）。✓
- **测试可信度**：r43 6 用例实跑 6/6；红侧 RED-K12（`admit_agent` 放宽为 `!=Disabled`）→ 3/6 独红，证明非恒绿；旧码探针崩溃（0/1）vs 新码 51/51，判别力实证。既有测试改动（r24/r34/r40/core_local/protocol）**仅**为「新装默认关」显式开门（`CollabGate::new(true)` / `collab_enable`），**未删弱原断言**。✓
- **demo 与真实面发散**：demo 只建模 Enabled/Disabled 两态、停用即 Disabled——与真实 app 观测结果一致，未断言真实面不具备的行为。✓

## 结论

**不通过（需修复后复验）。** D03（新装无自动 MCP 监听、旧配置迁移保留、Token 不吊销）**达标**；但 D08「确认停用先原子封 admission，**旧未启动请求作废**…失败不解封、重新启用不复活旧动作」存在未达标项：

- 阻断项：**F1**（排队/待启动的 Agent 动作不被停用作废——`CollabGate.generation` 从不核对、会话 `generation` 未随停用推进）、**F2**（ApproveEdited 臂缺 admission 复核）。
- 建议一并处置：**F3**（DisableFailed 未收敛即重开 + 按钮语义相反）、**F4**（Disabled 未经端点停止确认；应用侧 `collab_mark_disable_failed` 死代码）。
- F5/F6/F7 为低/信息级，可随修。

修复方向建议：让停用复用既有会话级代际机制（`collab_disable` 对每个 Agent 持有会话推进 `SessionHandle.generation`，或在 exec/transfer 的「开始前」核对点补 `admit_agent()`），并把 F2 的复核补到 ApproveEdited 臂；`collab_enable` 增 `DisableFailed` 收敛前置；应用侧据 `EndpointHandle` 真实停机结果调 `collab_mark_endpoint_stopped` / `collab_mark_disable_failed`。

---

# 定向复核（第二轮，处置后）

范围：只复核 F1–F7 处置是否**真正闭合**、是否引入**新缺陷**（不重跑全量功能验收）。判定前已重取 `git status`/`diff --stat`/mtime：`handle.rs` 36、`lib.rs` 309（与处置记录一致，无并行作者改树；两文件 mtime 为本次审核自身 Edit 反向还原所致）。红侧还原一律 **Edit 反向改回**，未用 `cp` 整文件写回。

## 独立复跑（不采信处置记录）

| 命令 | 结果 |
|---|---|
| `cargo test -p core-session --lib r43` | **10 passed / 0 failed** |
| `cargo test --workspace` | **全绿，exit 0**（32 个 target 0 failed；protocol 含 120s 挂起通过） |
| `PROBE_URL=:5183 node r43-demo-probe.js` | **60/60** |
| `grep -rn "RED-K" ui/src crates src-tauri/src` | 无残留 |

## 逐条判定

| 编号 | 判定 | 依据（独立复核） |
|---|---|---|
| F1 | **闭合** | ①`convert_agent_sessions_to_human` 转换时 `h.generation.fetch_add(1, SeqCst)`（与接管同口径）；②exec「取槽后」「执行前」两处复核 admission（`admit_agent_actor`）。**独立变异实证双保险**：删除代际推进 → `r43_disable_advances_session_generation` 独红、排队用例仍绿；把 `admit_agent_actor` 置空 → 10/10 全绿（代际推进单独兜住）。两机制互为冗余，任一在位即作废排队 AutoAllow。 |
| F2 | **闭合** | `handle.rs` 复核块上提为共用前置块，`matches!(decision, Decide(Approve) \| Decide(ApproveEdited(_)))` 两臂均先 `admit_agent()`。**独立枚举 `Decision` 变体**：仅 `Approve / ApproveEdited(String) / Deny` 三变体，只有前两者会执行，无遗漏第三臂。独立变异（`matches!` 收窄为仅 `Approve`）→ 仅 `r43_approve_edited_after_disable_is_voided_not_executed` 独红，判别力确认。 |
| F3 | **闭合** | `collab_enable` 前置改为 `state != CollabState::Disabled → Err`（Disabling/DisableFailed 均拒，`lib.rs:2567`）；UI 停用态按钮三分：DisableFailed→`collab-retry-disable-btn`（重跑 `collab_disable`）、Disabling→无钮、Disabled→`collab-enable-btn`。独立复跑 `r43_enable_rejected_until_disable_converged` 绿。 |
| F4 | **闭合** | `EndpointHandle` 增 `stopped` 信号（`axum::serve` 返回后置真）+ `is_stopped()`/`wait_stopped()`；`collab_disable` 停后有界等待（5s）确认才 Disabled，超时保留句柄 + `collab_mark_disable_failed`（不再是死代码）。见焦点④。 |
| F5 | **闭合** | `collab_enable` 改为**先起端点再开 gate**：端点起不来即 Err 返回、核心保持停用；core 未收敛则回滚 `set_mcp_endpoint("")` + `drop(new_handle)`（drop 触发优雅停机）。见焦点③。 |
| F6 | **闭合（文档）** | `spawn_endpoint` 标注 legacy/测试专用，生产一律 `spawn_endpoint_with_shutdown`。 |
| F7 | **不处置可接受** | 留档为 core-only 直用限制；app 启动即 `set_mcp_endpoint` 覆盖，`collab_status` 人类专属且实际调用方只有 app。不影响 app 路径。 |

## 四个焦点问题的独立结论

**① F1 的「排队/未启动动作作废」在 AutoAllow（无审批卡）类上是否真成立** —— **成立**。
`r43_queued_auto_allow_exec_voided_by_disable` 占住 `exec_slot` 迫使一条命中允许规则的 exec 排队（无审批卡），排队期间停用 → 取槽后**作废**（断言 `Err(VoidedByHandback) | Err(CollabDisabled)`，Stub 通道若真执行会返回 stub 错，故可区分「作废」与「执行」）。我独立做两次单点变异确认它**不依赖单一机制**：删代际推进 → 该用例仍绿（执行前 admission 复核独立兜住）；置空 `admit_agent_actor` → 全绿（代际推进独立兜住）。故 AutoAllow 类被双重覆盖。

**② F2 两臂对称是否真对称（有无第三臂 Decision 变体漏掉）** —— **对称，无漏臂**。
`Decision` 仅 `Approve / ApproveEdited(String) / Deny`；执行路径只走 Approve 与 ApproveEdited。共用前置复核块以 `matches!(…, Decide(Approve) | Decide(ApproveEdited(_)))` 同时覆盖两臂。`create_session` 的 ApproveEdited 在核心侧被显式拒绝，无旁路。

**③ F5「先起端点再开 gate」失败回滚是否留半态** —— **可达路径无半态；存在一处不可达的潜在半态（记为 F8，低/不阻断）**。
- 可达路径（`need_start==true`，即从 UI 唯一可达的 Disabled 态发起）：起端点失败 → 直接 Err、核心保持停用，无半态；起端点成功但 core `collab_enable` 失败 → `set_mcp_endpoint("")` + `drop(new_handle)`，drop 掉唯一 `watch::Sender` → `rx.changed()` 返 Err → 优雅停机 → 端点确实停止。故不会出现「端点活着但 core 停用」。✓
- 潜在半态（F8）：`need_start==false`（句柄已在）且 core `collab_enable` 失败时，回滚只 `set_mcp_endpoint("")` 并 `drop(None)`（空操作）——**未停掉既有端点**，形成「端点仍活、地址已清、core 未启用」。**经当前 UI 不可达**：`need_start==false` 仅在「F4 超时后句柄放回」时为真，而该态 core=DisableFailed，UI 只给「重试停用收敛」钮（`collab_disable`）、不给「启用协作」钮；成功停用后句柄已被 take → 从 Disabled 发起时 `need_start` 恒为 true。故仅属潜在不一致。建议（非阻断）：回滚分支在 `need_start==false` 时也 take+drop 既有句柄，或不清地址。

**④ F4 超时保留句柄后，重试 `collab_disable` 是否真能收敛** —— **能收敛，非永久卡死**。
重试路径：core `collab_disable` 对 `DisableFailed`（`state != Disabled`）**照常执行**——重新置 Disabling、代际++、再作废/再转换（幂等重封）；应用侧 take 句柄 → `stop()`（幂等）→ `wait_stopped()`。关键：`wait_stopped()` 先查 `is_stopped()`，端点若已排空则**立即返回** → `set_mcp_endpoint("")` → `collab_mark_endpoint_stopped`（Disabling→Disabled）→ **收敛为 Disabled**。若仍未排空则再次 5s 超时 → 再置 DisableFailed、句柄再放回（无泄漏、幂等）。故随在飞请求完成即可收敛。
- 附带观察（信息，非缺陷）：`wait_stopped()` 等待的是 `axum::serve` **返回**，而 axum 优雅停机会等**全部连接排空**才返回——即它等的是「监听器释放 **且** 在飞连接收敛」，比「监听器释放」更严。故长命令（`with_json_response` 下请求挂起到 exec 完成）期间停用会停在 DisableFailed，UI 显示「停用失败」——但此时 admission 已封闭、监听器已释放，属**安全**且符合 §9「已接纳请求与控制权已收敛后才 Disabled」。`EndpointHandle` 文档注释「长流会话不阻塞监听器释放」就**监听器释放**而言为真，但需注意 `wait_stopped` 语义更严（等 serve 返回）。建议文档措辞澄清，非阻断。

## 新问题

- **F8（低/不阻断）**：见焦点③——`collab_enable` 的 `need_start==false` 失败回滚未停既有端点，留下「端点活/地址清」潜在不一致；经当前 UI 不可达（DisableFailed 只给重试钮）。仅登记，不阻断。
- 未发现其他新缺陷：`Decision` 变体无漏臂；停用/重启用/端点回滚路径经独立读码 + 变异核对无新红。

## 结论（第二轮）

**可签。** F1–F6 处置**真正闭合**（均经独立复跑 + 单点变异实证判别力，非仅采信记录），F7 不处置可接受；新增 F8 为**经 UI 不可达的低级潜在不一致**，建议随下次改动一并收紧，**不阻断**本轮。

- 独立实测：`r43` **10/10**、`cargo test --workspace` **全绿 exit 0**、demo 探针 **60/60**、无 RED-K 残留。
- 待人工确认（不在本次范围）：原生 GUI 冒烟 r43a/r43b 因屏幕锁定未跑，已登记。

---

# 极窄复核（第三轮，F8 处置后）

范围：只核 `collab_enable` 回滚分支的 F8 修复（`src-tauri/src/main.rs:833-841`）。判定前重取 diff：`main.rs` 393（较二轮 384 增 9 行 = 该修复），**其余 14 个文件 stat 逐字未变**，与「未改动其他文件」一致；`handle.rs`/`lib.rs` mtime 未变（无并行改树）。

修复后的失败分支：
```rust
if let Err(e) = state.api.collab_enable(&human()).await {
    state.api.set_mcp_endpoint(String::new());
    drop(new_handle);
    if let Some(h) = state.mcp_endpoint.lock().unwrap().take() {
        h.stop();
        drop(h);
    }
    return Err(WireError::from(e));
}
```

**三点逐一核**：

1. **唯一句柄 → drop 即停机：成立。** `EndpointHandle` 仅在一处构造（`mcp-server/src/lib.rs:798`），全仓**无任何 `.clone()`**（`grep EndpointHandle` 全部命中：类型定义 739/747/781/798 + `main.rs` 的字段 15、局部 `new_handle` 806、启动构造 1029）。存活句柄只存于 `AppState.mcp_endpoint`，`take()` 后互斥量置 `None`，`h` 即成该 `watch::Sender` 的**唯一**持有者；`drop(h)` 使 sender 计数归零 → serve 任务内 `rx.changed()` 返 `Err` → 触发优雅停机（与 `mcp-server/src/lib.rs:791` 注释一致）。`h.stop()` 先显式发 `true`，二者同效、冗余无害。
2. **无句柄外泄致 take+drop 不足：成立。** 同上 grep 证据——`EndpointHandle` 从不 Clone、不存入他处；`collab_disable` 的 `h`（769/778）与 `collab_enable` 的 `new_handle`（806/816/835/842）均为局部，唯一持久化点是 `AppState.mcp_endpoint`。故 take+drop 覆盖全部 sender。
3. **回滚后无死锁/无半态、下次启用不卡住：成立。** 回滚后 `mcp_endpoint == None` → 下次 `collab_enable` 走 `need_start==true` → `spawn_endpoint_with_shutdown` → `bind_increment(8722)`（`mcp-server/src/lib.rs:700-716`）在 8722..8753 内自动递增取空口；旧端点即使尚在释放监听器，新端点改绑下一端口，**不会卡住**（仅当 31 口全占才 Err，属既有约束）。回滚分支内 `h.stop()`/`drop(h)` 均为同步非阻塞、无 `.await`、无二次加同一 `std::sync::Mutex`，`if let` 暂存守卫跨越该体不构成死锁。

**独立复跑**：`cargo check -p tinyssh-app` → **Finished**（8 条既有 warning，0 error）。

**判定：F8 闭合，维持可签。** 未发现新问题；修复方向正确（「core 未启用 ⇒ 无应用端点运行」成为不变量，不再依赖「经 UI 不可达」豁免）。
