# R03 契约冻结草案（C1–C10）

> 日期：2026-10-06 · 基线：`7c4502e` · 状态：**R03 草案（G0 联审 C-01~C-04 修订版）**，待 G0 复审签署后生效；签署前禁止按本文件实施。
> 联审修订记录（2026-10-06，用户三路复审 C-01~C-04 + 五项产品裁决）：**C1** 重写——取消/Ready 交付线性化点（已提交未投递窗口才自动关闭）、关闭失败终态 `CancelCloseFailed`（会话保留+恢复入口，不误示已取消）、Ready 投递后迟到取消无副作用、合并键改 `(host_id, actor)` 身份绑定。**C6** 重写——唯一发布决策表（无双重命名降级/回滚，用户裁决删除；无 posix-rename 阻止替换 `ReplaceUnsupported`；新文件/keep-both 要求 CREATE_NEW+原子 rename 可靠 no-clobber；复检 stat 变化显式 overwrite 亦按新冲突）。**C5** 补——`submit_collision_decision`/`reject_expired_decision` 命令、decision_prompt.reason 字段、StaleDecision/InvalidTransferState。**C9** 补——enable/disable/disable_resolve 启停 wire、DisablingPlan 活动清单、disable_failure 原因字段、Disabled 后 MCP status 端点不可达属预期。**C10** 重写——恢复载体改 `ScreenCheckpoint`（双缓冲带属性网格，可重建 vim/top），live 帧 pending 暂存+去重水位，显式 `unsubscribe_output` 主清理路径（静默会话不依赖 send 失败）。
> 独立审核记录（rev-r03，2026-10-06）：阻塞 0 / 高 4 / 中 1 / 低 3，全部已修（详见 git 历史版本头）。抽查 11 处 file:line 断言全部属实。
> 独立复审记录（rev-r03b，2026-10-06，联审修订后二轮）：高 2 / 中 3 / 低 4，**全部已修**——H1 TransferState 补 `Skipped`；H2 发布应答丢失复核路径冻结（stat+temp 三分支：Succeeded{verified}/Failed/OutcomeUnknown），FIX-P3 扩为六变体；M1 sftp_resolve_path 三错误变体入 §11 ADR；M2 no-clobber 分支显式依赖 posix-rename（无扩展服务器新文件一并阻止）；M3 `DisablingResolveResult`+`StopOutcome` 类型与 Wait 超时/DisableFailed 语义、StalePlan 断言入 §12/FIX-P8；L1 `CancelOutcome::CancelCloseFailed` 命名统一；L2 审计事件清单补 `connection_cancelled_closed` 与各触发点；L3 复检约束收窄至发布路径（skip 不受影响）；L4 合并幂等断言入 §12-10。裁决 6 条对照：5 落实 + 决议 3「启用不转移控制权」补显式成文（§C9）。russh-sftp 能力断言经 rev-r03b 按 Cargo.lock 实际解析版本（3.0.0）源码逐条核实。
> 输入：[连接/协作缺口分析](r03-gap-connection-collab.md) · [文件/传输缺口分析](r03-gap-files-transfer.md) · 设计主文 §6/§9/§10 · 联审报告 [副本](../acceptance/ux-r1/g0/2026-10-06-7c4502e/review-round1/decision.md)（§2 裁决/§3 修正项；原件 /tmp/tinyssh-g0-decision-review/）。
> wire 命名约定：与现有一致——类型/枚举 PascalCase、字段 snake_case（Tauri serde 默认），事件名 kebab-case。所有 `#[serde(default)]` 标注处为旧载荷兼容点。

## 0. 跨契约总则

1. **错误 ADR**：`Error` 为封闭枚举（session-api:678-719），本轮新增变体一次走一个 ADR（本文件 §11），R03 签署即视为 ADR 评审记录。
2. **同仓三端**（Tauri UI / CLI / demo shim）与 session-api 同仓同发布，结构性 wire 变更（DirEntry、subscribe_output 返回值）**原地升级 + 同 commit 更新 wire 测试与三端消费**，不做双结构长期并存；`#[serde(default)]` 仅用于新增可选字段。
3. 事件对账总原则：事件只做及时更新；查询真源做初始加载与丢事件恢复；每个事件携带可对账键（attempt_id / task_id+revision / host_id）。

---

## C1 建连尝试（实现 R19；消费 R21/R23/R26）

### 冻结 wire

```text
命令：
  begin_connection(host_id: String, opts: BeginConnectionOpts) -> AttemptInfo
    BeginConnectionOpts { new_session: bool = false }
  connection_status(attempt_id: String) -> AttemptInfo
  cancel_connection(attempt_id: String) -> CancelOutcome
事件：connection-event（broadcast → window.emit，沿 approval-event 桥模式）
  ConnectionEvent { attempt_id, phase: AttemptPhase, session_id: Option<String>, error: Option<ErrorPayload> }
  AttemptPhase = Connecting | TrustRequired | Authenticating | ChallengeRequired
                | Ready | Failed | Cancelled | CancelCloseFailed
AttemptInfo { attempt_id, host_id, actor: String /* "human"|"agent" */, phase,
              session_id: Option<String>, created_at, error: Option<ErrorPayload> }
CancelOutcome = Cancelled | AlreadyReady { session_id } | CancelCloseFailed { session_id } | NotFound
```

### 状态机与竞态（C-01 修订版）

- 状态转移仅核心可写；attempt 终态 = `Ready | Failed | Cancelled | CancelCloseFailed`，终态后不再变化（`connection_status` 恒返回终态）。
- **交付线性化点**：核心内部 `create_session` 返回 `Ok(sid)` 即「已提交」；`Ready` 事件投递（emit）即「已投递」。取消与建连的竞态只在「已提交、未投递」窗口内产生自动关闭：
  - `cancel` 在提交前处理完 → `Cancelled`，无 session 遗留（sessions 表无该记录）。
  - `cancel` 在提交后、投递前处理完 → `AlreadyReady{sid}` 返回给调用方，同时核心**立即关闭该刚创建且从未投递的会话**：
    - 关闭成功 → attempt 终态 `Cancelled`（session_id 清空，关闭事实入审计 `connection_cancelled_closed{attempt_id, session_id}`）+ 事件 `Cancelled`，**UI 此时才显示「已取消」**（显示以终态事件为准，不以 CancelOutcome 返回值为准）。
    - 关闭失败 → attempt 终态 `CancelCloseFailed`（session_id 保留），事件 `CancelCloseFailed{session_id}`，审计 `connection_cancel_close_failed{attempt_id, session_id, error}`；**会话保留在会话列表（即恢复入口），UI 显示「取消未完成，会话已保留」，不得显示「已取消」**。
  - `cancel` 在 `Ready` 已投递后到达 → `NotFound`，**无任何副作用**：迟到取消不得关闭已投递（可能已投入使用）的会话。
- 关闭失败后的 attempt 已终态；再次 `cancel_connection` → `NotFound`。残留会话走正常会话生命周期（用户手动关闭，走会话关闭确认契约）。
- **可断言竞态序列**（契约测试必须覆盖）：
  1. `begin → cancel（认证中）→ Cancelled`，无 session 遗留。
  2. `begin → 已提交未投递 → cancel → AlreadyReady{sid} → 关闭成功 → 终态 Cancelled` + 审计 closed + 事件 Cancelled。
  3. `begin → 已提交未投递 → cancel → 关闭失败 → 终态 CancelCloseFailed{sid}`，会话保留可恢复；重复 cancel → NotFound。
  4. `begin → Ready 已投递 → cancel → NotFound`，会话不受影响。
  5. `begin(Agent) → cancel(Human 通道) → NotFound` + 审计 `cross_actor_cancel_denied{attempt_id, caller_actor}`（跨 Actor 不泄露存在性）。
  6. `begin → cancel → cancel → 第二次 NotFound`（attempt 已终态）。
- 指纹门/2FA 门：`PendingHostKey`/`PendingAuthPrompt` 增加 `attempt_id: Option<String>`（serde default）；门超时 120s 改按 attempt 存续计时，超时 → 作废 pending 卡（复用 T44 `approval_voided` 留痕先例）+ attempt=Failed{error: timeout}。
- Agent 建会话审批：attempt 显示笼统 `Connecting`；审批等待期间 `cancel_connection` 同步作废 pending 审批卡（复用 voided 路径）。
- **同主机合并（身份绑定，C-01）**：合并索引键 = `(host_id, actor)`；仅同一授权身份（同 Actor 类型的同一调用域——Human UI 命令通道按调用者身份、Agent 按其 Actor）且无 `new_session=true` 时返回既有 attempt_id（幂等）。Human 与 Agent 的 attempt 互不合并、互不可见、互不共享审批或取消权限。`new_session=true` 显式绕过合并。
- attempt 终态不设查询历史接口；审计留痕：`connection_failed`（门超时/建连失败）、`connection_cancelled`（**提交前取消路径**）、`connection_cancelled_closed`（竞态窗口自动关闭成功）、`connection_cancel_close_failed`（竞态关闭失败，会话保留）。

### 决议表

| # | 决定 |
|---|---|
| DC1.1 | 不做 attempt 历史查询；Ready 后 `attempt_id↔session_id` 经 Ready 事件与审计关联 |
| DC1.2 | CancelOutcome 四态；**自动关闭仅限「已提交未投递」窗口**；UI 显示「已取消」以核心确认关闭成功的终态事件为准；关闭失败 → `CancelCloseFailed`，会话保留 + 恢复入口，永不误示已取消 |
| DC1.3 | 门超时按 attempt 计时（120s 不变），作废留痕 |
| DC1.4 | Agent 审批挂 attempt：Connecting 态呈现，取消即作废审批卡 |
| DC1.5 | 合并键 `(host_id, actor)`：仅同 Actor 同主机幂等合并；跨身份不合并、不共享审批/取消权限；`new_session` 显式绕过 |
| DC1.6 | Ready 投递后取消一律 NotFound（无副作用），不设「Ready 后取消宽限期」 |

## C2 人类会话初始控制权（实现 R24；消费 R42）

- `SessionHandle::new` 增加 `owner: ControlOwner` 参数；`create_session(ctx)` 按 `ctx.actor()` 设置：`Actor::Human → Human`，`Actor::Agent → Agent`（沿原规则，含必审）。构造期设置，无「建完再接管」窗口；审计 `session_created` payload 增加 `owner`。
- 首次委托：新增 `delegate_session(sid, goal: Option<String>) -> ()`，内部走既有 handback 受控转换 + 独立审计事件 `session_delegated{sid, actor, goal_present}`；`SessionBrief.goal` 已可选。取消对话框不产生任何调用。

| # | 决定 |
|---|---|
| DC2.1 | smoke 脚本无 owner 断言（已核实 native-smoke/*.py），无脚本同步项；AUTOCONNECT 建的会话将变 Human-owned，R24 验收记录此差异 |
| DC2.2 | 独立 `delegate_session`，不复用裸 `set_control`（承载确认语义与审计） |

## C3 shell 集成与执行模式（实现 R24；消费 R26/R42/R45）

### 冻结 wire

```text
Host/HostDraft 增：shell_integration: Option<bool>（serde default → None）
  语义：None = 编辑时保持原值 / 新建时 false；Some(v) = 显式设置
  C8 迁移：一次性为全部存量 SSH 主机显式写 Some(true)（与旧行为「无条件注入」一致；
    运行时能力检测照旧）——杜绝灰度期旧 UI/CLI upsert 缺字段静默关闭已迁移主机
查询：shell_capability(sid) -> ShellCapability   // 只读，任何 Actor 可查
  ShellCapability { integration_present: bool, prompt_ready: bool, host_setting: bool }
错误：Error::ShellIntegrationUnavailable { available: ShellCapability }
  error_kind = "shell_integration_unavailable"
事件：shell-integration-event { session_id, state: IntegrationState }
  IntegrationState = Disabled | Pending | Ready | Unavailable
SessionInfo 增：integration: IntegrationState（serde default → Disabled）
```

### 语义（执行前拒绝，替代 handle.rs:149-156 静默降级）

- `run_shell` 入口重查能力（查询接口不可信任缓存）：`mode=Shell`（含省略）且 `!integration_present` → 副作用前返回 `ShellIntegrationUnavailable`；禁止自动 Fresh。
- 显式 `mode=Fresh` 按原授权/审批执行；审批卡标注「不继承当前终端目录/环境」。
- create_session 与注入解耦：`host_setting=false` 不注入不等 OSC（满足 P3）；`true` 时注入后台化，就绪经 `shell-integration-event` 表达；`Ready` 判据 = PTY/shell 通道建立，**不等集成**。
- 重连：`reinject_integration` 按 host_setting 分支；未启用集成的重连不注入/不等标记（B12）。

| # | 决定 |
|---|---|
| DC3.1 | 错误与能力字段如上 |
| DC3.2 | `Option<bool>`（None=编辑保原值/新建 false）；C8 迁移为存量主机显式写 true + 运行时检测 |
| DC3.3 | `shell_capability` 只读查询；执行时入口重查 |
| DC3.4 | `exec_human` 保持 Shell-only，不加 mode（调试 Fresh 走 MCP 显式模式）；无集成主机如实报错 |
| DC3.5 | Ready ≠ 集成就绪；集成就绪为独立事件 + SessionInfo 字段，Degraded 口径不变 |

## C4 路径与条目元数据（实现 R30；消费 R31/R33）

### 冻结 wire（原地升级，见总则 2）

```text
DirEntry { name: String, kind: EntryKind, size: Option<u64>, mtime: Option<i64>,
           permission_denied: bool = false }
EntryKind = Dir | File | Symlink | Other
新命令：
  sftp_resolve_path(sid, path: String) -> ResolvedPath { canonical: String }
    错误：PathNotFound | PermissionDenied | SymlinkLoop（可解释文案）
  sftp_stat(sid, path) -> DirEntry（不含 name 语义同上）
list_dir 响应增：{ path: String, seq: u64, entries: Vec<DirEntry> }
  seq = 每 session 单调递增的列表序号
```

- `sftp_list` 持久通道化：一 session 一条复用 SFTP channel（失败重建），消除每次开关通道开销（P4 相关）。
- symlink：默认**不自动跟随**进入；条目显示链接态 + 「打开目标位置」显式动作（DF4.3）。
- resolve_path = SFTP realpath + 结果组件校验，服务端差异映射为上述三错误（DF4.2）。

| # | 决定 |
|---|---|
| DF4.1 | 原结构改造（size/mtime → Option + kind），同 commit 更新 wire 测试（session-api:972-982）与消费端；**demo shim `sftp_list` 返回同步改为 `{path, seq, entries}` 包装形** |
| DF4.2 | realpath + 组件校验组合 |
| DF4.3 | 不自动跟随，显式打开目标 |
| DF4.4 | 核心返回带 session 级单调 seq，**UI 按 seq 丢弃晚到响应**（契约写明；核心不做丢弃，保持查询无状态） |

## C5 传输注册表（实现 R32；消费 R33/R35）

### 冻结 wire

```text
命令：
  list_transfers(filter: Option<{session_id}>) -> Vec<TransferTask>
  cancel_transfer(task_id) -> TransferState          // 幂等，见 DF5.5
  submit_collision_decision(task_id, decision: CollisionDecision, expect_revision: u64)
      -> TransferState                               // 仅人类 UI；仅任务处于 AwaitingDecision 可调用
      // expect_revision 乐观锁：revision 不匹配 → Error::StaleDecision（任务已推进/决定已过期）
      // 非法状态（如 Agent 任务、非 AwaitingDecision）→ Error::InvalidTransferState
  reject_expired_decision(task_id) -> ()             // 人类 UI 显式作废过期决策卡；
      // 幂等：任务不在 AwaitingDecision 时为 no-op；审计 transfer_decision_rejected{task_id, actor}
  // 说明：决定过期不需要 reject 也能继续——按 revision 防护自然拒绝；reject 用于 UI 收尾与留痕
事件：transfer-event（每事件带 revision）
  TransferEvent { task_id, revision, state, bytes_transferred, total_bytes: Option<u64>,
                  error: Option<ErrorPayload> }
TransferTask { task_id, session_id, conn_generation, direction, source, destination,
               state: TransferState, bytes_transferred, total_bytes: Option<u64>,
               revision, created_at, finished_at: Option<...>, error, retry_of: Option<TaskId>,
               collision_decision: Option<CollisionDecision>,
               decision_prompt: Option<{ target_path, target_stat, reason: String }> }
               // decision_prompt 仅 AwaitingDecision 态非空；reason 说明进入冲突的原因
               //（如 "target_exists" / "stat_changed_since_preflight"）——「原因可查」落字段（C-04）
TransferState = Queued | AwaitingDecision | Running | Cancelling | Committing
              | Succeeded | Failed | Cancelled | Skipped | OutcomeUnknown | Interrupted
              // Skipped：冲突决定 skip 的终态（复审 H1 补）
CollisionDecision = Skip | Overwrite | KeepBoth
```

- **注册表全局**（SessionManager 持有），任务带 session_id 归属；面板关闭不影响任务（C5 完成条件）。
- 事件节流：Running 态每任务 ≥200ms 合并发送 + 终态必发（DF5.4：时间主导）；遗漏靠 `list_transfers` 对账，revision 单调。
- Agent 必审与队列合并：`transfer()` 经审批期间任务呈 `Queued{awaiting_approval}`（审批作废 → `Failed{reason: approval_voided}`）。
- 并行上限：每 session 2、全局 4；同 canonical 目标串行（锁键见 DF6.4）；超限排队（Queued）。
- `close_session` 不再让传输随通道死掉：核心对运行中传输触发 Cancelling（会话已断则写入失败 → Failed{reason: session_closed}）；提交窗口内按 C6（OutcomeUnknown）。
- 持久化（V5 迁移）：vault 新表 `transfer_journal`（DF5.2）。**写入时机：任务创建即落行（含身份/源目标/决定），状态迁移即更新**——不仅限提交窗口。重启恢复分类：`state==Committing` → OutcomeUnknown（须有提交前恢复资料）；`state ∈ {Queued, Running, AwaitingDecision, Cancelling}` → **Interrupted**（可新建重试，retry_of 关联）；Succeeded/Failed/Cancelled 等终态行仅作历史。**无 journal 行的任务重启后不留存、不推断**。

| # | 决定 |
|---|---|
| DF5.1 | 全局注册表 + 会话归属字段 |
| DF5.2 | vault `transfer_journal` 表（V5），不新开日志文件；提交窗口行含 `verified` 标记（发布应答丢失复核路径的结论，见 C6） |
| DF5.3 | 细粒度事件（逐任务带 revision） |
| DF5.4 | 200ms 时间主导节流 + 终态必发 |
| DF5.5 | cancel 幂等：终态任务返回其终态；Cancelling 中再取消返回 Cancelling |

## C6 冲突与提交（实现 R34；消费 R35）

### 冻结序列与唯一发布决策表（C-02 修订版；用户裁决：无可靠原语一律阻止，不做双 rename 回滚）

```text
写入：同目录临时文件  .tinyssh-part-<task_id>-<name>
  → 全量写 + flush + close → stat 临时文件核对长度
  → 发布（唯一决策表，见下；探测机制 DF6.1）
  → 任何「阻止发布」路径不得截断/移动原目标；temp 删除并留审计
提交前：journal 落库（C5）→ 提交 → 终态
冲突询问：AwaitingDecision（**仅人类 UI 路径**；Agent 路径永不进入此状态）
  skip / overwrite / keep-both（默认 skip；keep-both 命名 name.tinyssh-1.<ext> 递增）
```

**唯一发布决策表**（提交窗口按此表执行，无其他发布路径）：

| 预检/复检 target 状态 | 决定 | 发布动作 | 能力不足时 |
|---|---|---|---|
| 不存在（新文件） | 任意（无需询问） | no-clobber 发布：`open(target, CREATE_NEW)` 声明占位（失败=他方已在窗口内创建 → 按冲突重新裁决）→ `rename(temp→target)` 覆盖自家占位完成发布。**能力依赖（复审 M2）：覆盖自家占位同样要求可覆盖已存在目标的原子 rename（= posix-rename 扩展）——未宣告该扩展的服务器，新文件/keep-both 一并阻止**（符合"否则阻止"裁决） | 无可靠 no-clobber 原语（CREATE_NEW 或原子 rename 不可用）→ **阻止发布** |
| 存在，决定 overwrite | 显式（人类裁决或 MCP 显式参数） | 仅当服务器宣告 `posix-rename@openssh.com`（RawSftpSession::init 版本扩展表）→ `rename(temp→target)` 原子替换 | 未宣告 → **阻止替换**：结构化 `ReplaceUnsupported{capability}`，原目标与 temp 均不动。**无双重命名降级、无 bak、无回滚方案**（用户裁决删除） |
| 存在，决定 keep-both | 人类裁决 | 换名 `name.tinyssh-N.ext` 后按「新文件」行发布（同样要求 no-clobber 原语） | 同「新文件」行 |
| 存在，决定 skip | 人类裁决/Agent 缺省 | 不发布，temp 删除，任务终态 Skipped | — |
| **提交时 stat 复检与预检不一致**（存在性+size+mtime 任一变化） | — | **一律按新冲突处理**（复审 L3 收窄：仅约束「将执行发布」的路径——overwrite / 新文件 / keep-both 最终名；**skip 不发布、无覆盖风险，不受复检影响**，Agent collision=skip 遇 stat 变化仍按 skip 终态 Skipped）：人类路径重回 AwaitingDecision；Agent 路径返回 `ConflictDetected`（**即使显式 overwrite**——显式请求只针对预检时所见那份，不得覆盖竞争中变化/新出现的文件） | — |

- **发布应答丢失复核路径（复审 H2 补冻结）**：rename 发布应答丢失（注入缝/网络故障）后核心必须复核，不臆断：
  1. `stat(target)` 且查 temp 是否仍在——target 在且 size 与提交前 temp stat 一致且 temp 已消失 → **已发布 → Succeeded**（journal 标 `verified`）；
  2. target 不在且 temp 在 → 未发布 → 任务 `Failed{reason: publish_unverified_target_absent}`（不自动重试发布；用户可新建重试，retry_of 关联）；
  3. target 不在且 temp 不在 / stat 失败或超时 → **OutcomeUnknown**（temp 保留规则仅适用于 temp 仍存的分支）。
- 同目标锁键：canonical path（远端经 resolve；本地绝对路径）（DF6.4）。UI 文案口径：「客户端内同目标串行；其他程序不受限制，替换可能覆盖其变更」。
- 部分文件：确认未提交的失败/取消 → 删除本任务 temp；OutcomeUnknown → temp 保留（无 bak 方案，不再有 bak 恢复资料；OutcomeUnknown 恢复仅依 journal 与 temp）；浏览器不过滤 `.tinyssh-*`（可见即可识别）（DF6.5）。
- **MCP/Agent 传输**（DF6.2）：`upload`/`download` MCP 工具（crates/mcp-server/src/lib.rs:429/:444，**非 upload_file/download_file**）新增可选参数 `collision: "skip"|"overwrite"|"fail"`，**缺省 fail**（结构化 `ConflictDetected` 错误返回目标 stat）；`overwrite` 在审批卡明示「将覆盖已存在目标」。Agent 路径永不进入 AwaitingDecision；冲突一律结构化错误返回。

| # | 决定 |
|---|---|
| DF6.1 | **探测机制**：crate 高层 `SftpSession` 不支持 posix-rename（无对应 API；`Features` 为 pub(crate)），探测经 `RawSftpSession::init()` 取 SSH_FXP_VERSION 扩展表判定。**发布能力分级**：原子替换能力 = 扩展表含 `posix-rename@openssh.com`；no-clobber 能力 = CREATE_NEW 语义 + 原子 rename。**唯一决策表如上——无双重命名降级路径**（用户裁决 2026-10-06：本轮不做双 rename + 失败回滚；无已验证原子替换能力即阻止 overwrite；新文件/keep-both 仅在可靠 no-clobber 可用时执行） |
| DF6.2 | MCP `collision` 参数，缺省 fail；工具名 `upload`/`download` |
| DF6.3 | 存在性+size+mtime 三比对；**复检不一致一律按新冲突处理，显式 overwrite 也不例外** |
| DF6.4 | 锁键 canonical path；外部进程边界写进 UI 文案 |
| DF6.5 | temp 命名与保留规则如上（OutcomeUnknown 仅保留 temp，无 bak） |

## C7 导入诊断（实现 R22；消费 R22 UI）

### 冻结分级清单（DF7.1）

| 级别 | 指令 | 效果 |
|---|---|---|
| 阻断（blocking） | ProxyJump / ProxyCommand / Include（V1 不跟随，DF7.2）/ Match 依赖段 / 证书类（@cert-authority、CertificateFile）/ 通配符 Host 模式继承 | 条目默认不可勾选直连导入；可「转手工表单」预填 |
| 警告（warning） | ServerAliveInterval / ServerAliveCountMax / Compression / ForwardAgent / ForwardX11 等连通性无关项 | 可导入；预览显示已忽略 |
| 忽略（silent-ok） | 注释、空行、AddressFamily 等无歧义项 | 不显示 |

### 冻结 wire

```text
SshConfigPreview 增（serde default）：
  source_file: String, source_line: u32,
  unsupported: Vec<{ directive, level: Blocking|Warning, line }>,
  directly_importable: bool        // = 无 blocking
SshImportOutcome 增：skipped_reason: Option<Duplicate|Blocked>
导入端：默认跳过重复（同名 OR address+port+user）；显式覆盖需 UI 传
  upsert_host(id: Some(既有id))（DF7.3：查重得 id，导入命令增 overwrite: bool=false）
「转手工表单」：UI 直接用预览载荷预填 HostDraft → upsert_host，不新增命令（DF7.4）
无 User 条目：不静默 root；预览标注「未指定用户」+ directly_importable=false，
  手工表单必填（DF7.5）
```

## C8 偏好与主机元数据（实现 R15；消费 R20/R27/R44）

- `ui.v2.workspace`：**单键 JSON blob** 含 `schemaVersion`（DF8.1）；整取整存原子写；不含秘密/终端输出/会话目标。
- V5 迁移（与 transfer_journal 同批）：新表 `host_metadata { host_id PK, favorite: bool, last_connected_at: Option, }`（DF8.2）。
- 旧键迁移（一次性，事务 + 标记，幂等）：
  `ui.theme` → 终端配色保留原四预设（dark/light/solar-dark/solar-light，含完整 ANSI 表，值不变），应用外观映射：dark→dark、solar-dark→dark、light→light、solar-light→light（DF8.3，主题枚举已核实 App.tsx:325-365）；`ui.font_size` → `ui.v2.terminal.font_size`。旧键保留不删（回退兼容）。
- 最近连接（DF8.5）：sessions 表派生——`host_id IS NOT NULL AND kind != 'local'`，每 host 取最近一次，按时间倒序上限 5；无记录则空，不虚构。
- `delete_identity` 引用检查（DF8.4）：被引用 → 新错误 `IdentityInUse { host_names: Vec<String> }`；CLI `identity delete` 同步该行为。
- `delete_host` 联动：删除 host_metadata 行；不删被引用凭据；不隐式关闭会话（§5 已定）。

| # | 决定 |
|---|---|
| DF8.1 | blob + schemaVersion |
| DF8.2 | 独立 host_metadata 表 |
| DF8.3 | 四预设映射如上 |
| DF8.4 | `IdentityInUse` 新错误 |
| DF8.5 | sessions 派生、排除 local、上限 5 |

## C9 协作启用生命周期（实现 R43；消费 R42/R44）

### 冻结状态机

```text
Enabled → (用户确认) → Disabling → Disabled
                ↘ DisableFailed（admission 仍关闭，可重试收敛）
Disabled → (显式重新启用，确认旧停用已收敛) → Enabled
```

- 开关存储：vault settings `collaboration.enabled`（核心配置，不入 ui.v2）。**新装默认 false；升级（无该键）默认 true**（§10.1.6）。停用确认框的「影响预览」不设独立 wire——由既有 `list_agents` + `list_sessions`（Agent-owned 过滤）+ `list_transfers` 组合渲染，核心不新增预览命令。
- admission gate（DF9.1）：SessionManager 单点 wrapper——`Actor::Agent` 的全部写方法入口统一检查 `collab_generation` 与状态；**检查先于审批等待**。全覆盖清单 = MCP 16 工具全部写动作（create_session/exec/send_keys/upload/download/forward_start/forward_stop/close_session/cancel_exec/set_session_goal/delegate…以实际枚举为准）+ shim 透传；契约测试每工具一条拒绝用例。
- 停用序列（可断言）：
  1. 确认 → 核心原子 Disabling：`collab_generation += 1`，gate 立即拒绝新请求（错误 kind `collaboration_disabled`），**覆盖无 session 的 create_session、已批准未执行、排队传输、在途 HTTP 中未启动动作**（执行开始前核对 generation，作废留痕）。
  2. 重新枚举真实活动 → 用户逐项 等待/尽力停止（`StopOutcome` 逐项真实结果）；已开始文件提交按 OutcomeUnknown。
  3. Agent-owned 会话逐个核心转 Human（不终止已开始任务；普通人类 SSH 不受影响）；批量审计事件 `collaboration_disabled_conversions{sessions:[…]}` + 逐会话 note_transition。
  4. 确认顺序（DF9.5）：gate 生效 → 已接纳请求收敛（活动归零/转换完成）→ axum graceful shutdown 完成 → Disabled。监听器关闭 ≠ gate 生效。
- 状态查询（DF9.2）：Tauri `collaboration_status() -> CollabStateInfo`；状态变迁走新 broadcast 桥 `collaboration-event`。**启停命令 wire（C-04 补齐）**：

```text
命令（Tauri，均要求 Human Actor）：
  collaboration_enable() -> CollabStateInfo
    // Disabled|DisableFailed → Enabled（重新启用前 UI 须确认旧停用已收敛，核心不重复校验作废记录）
  collaboration_disable() -> DisablingPlan
    // Enabled → Disabling：gate 立即生效（collab_generation += 1），返回重新枚举的真实活动清单
  collaboration_disable_resolve(generation: u64,
      items: Vec<{ id: String, action: Wait | StopBestEffort }>) -> DisablingResolveResult
    // 同步逐项执行（复审 M3）：
    //   Wait = 等其自然完成，单项超时 120s → 该项 outcome=StopFailed{reason:"wait_timeout"}，
    //          整体 → DisableFailed（admission 仍关闭）
    //   StopBestEffort = 尽力停止，结果如实（Stopped | AlreadyDone | StopFailed{reason}）
    // generation 不匹配 → Error::StalePlan
    // 全部项收敛（无 StopFailed）→ state=Disabled；任一失败 → state=DisableFailed
  collaboration_status() -> CollabStateInfo
CollabStateInfo { state: Enabled | Disabling | Disabled | DisableFailed, generation: u64,
                  disable_failure: Option<{ reason: String, detail: String }> }
DisablingResolveResult { state: CollabStateInfo,
                         outcomes: Vec<StopOutcome> }   // 每活动一项，逐项真实结果
StopOutcome { id: String, requested: Wait | StopBestEffort,
              result: Completed | Stopped | AlreadyDone | StopFailed { reason: String } }
DisablingPlan { generation: u64,
                activities: Vec<{ kind: Session | Agent | Transfer, id, description, stoppable: bool }> }
事件：collaboration-event { state, generation, disable_failure: Option<…> }
```

- MCP `status` 工具**豁免 gate**（只读，返回 Disabled 说明，便于 Agent 理解拒绝原因）——**仅监听器存活期间有效**；Disabled 完成三层确认（DF9.5）后 axum 已 graceful shutdown，**MCP status 端点不可达属于预期行为，不承诺停用后仍可查询**。Agent 判断协作状态以写动作的 `collaboration_disabled` 错误为准（Tauri 进程内的 `collaboration_status` 恒可用，但那是 Human 通道）。
- **启用不转移会话控制权（联审决议 3 显式化）**：`collaboration_enable` 仅改变 admission gate 与监听器状态；既有会话的 `control_owner` 不因启用/停用改变（C2 语义独立）；Agent 获得控制权只能经显式 `delegate_session`（另行确认+审计）。
- DisableFailed（DF9.4）：**原因可查落字段**——`CollabStateInfo.disable_failure.reason/detail`（C-04；「同 command 返回」指 resolve/status 调用同步携带）；admission 关闭期间错误 kind 与 Disabled 相同。
- 外部 shim：不等待/不杀死；其调用被 gate 拒或端点不可用。重新启用不作废前停用期的作废记录（不复活）。

| # | 决定 |
|---|---|
| DF9.1 | 单点 wrapper + 全量清单测试 |
| DF9.2 | settings 键 + 状态命令 + MCP status 豁免 + collaboration-event |
| DF9.3 | 逐会话转换 + 批量审计事件 |
| DF9.4 | 错误 kind 同 Disabled；原因可查 |
| DF9.5 | 三层确认顺序如上 |

## C10 输出订阅恢复（实现 R11，FE/Core 共担；消费 R14/R25/R45）

### 冻结 wire（C-03 修订版：终端恢复改「检查点 + 重放」，纯文本快照不再作为恢复载体）

```text
命令（现行实签名 subscribe_output(sid, on_event: Channel)，main.rs:204-208——保留通道参数）：
subscribe_output(sid, on_event: Channel) -> AttachOutput   // 返回值结构变更（原地升级）
  AttachOutput { checkpoint: ScreenCheckpoint, start_seq: u64 }
unsubscribe_output(sid) -> ()                              // 显式退订（C-04：静默会话清理主路径）
Raw 输出帧：<u64 LE seq（8 字节头）><payload 原始字节>    // UI 剥头取 seq
事件（window.emit）：resync { session_id, from_seq: Option<u64>, subscription_id }
  UI 收到后调 resync_output(sid, from_seq)：
    lossless 可重放 → { events: 重放字节, end_seq }（scrollback 连续）
    不可重放（淘汰/alt_screen 活跃/检查点更近）→ { checkpoint, end_seq } 检查点分支
调试：debug_subscriptions() -> { active_count, per_session: [...] }   // P6 测量口
ScreenSnapshot（纯文本）保留为调试/审计只读接口（read_screen），**不作为终端恢复载体**；
  其 text 含 scrollback 的对齐决议保留（文档与实现一致），但恢复路径一律走 ScreenCheckpoint。

ScreenCheckpoint {                        // 可重建渲染状态（C-03 核心决议）
  cols, rows,
  buffers: [BufferCheckpoint; 2],         // [主缓冲, 备用缓冲]，与 alt_screen 无关全量携带
  active_buffer: 0 | 1,
  cursor: { x, y, visible, style },
  modes: { autowrap, application_cursor, bracketed_paste, origin_mode, /* 实现时按 vte 支持面枚举 */ },
  title: Option<String>,
}
BufferCheckpoint { lines: Vec<CellRun> }  // 逐行「字符 + SGR 属性 run」串行化，可重建 vim/top 单元格属性
```

**checkpoint 生成**：核心侧屏幕模型（现 read_screen 的 ANSI 解析模型）升级为**带属性网格模型**（vte 语义：字符+前景/背景/粗斜体等 SGR run），checkpoint 由该模型序列化生成——不依赖前端 xterm，重启后无订阅者时亦可服务。模型升级范围与 P 门影响在 R11 实现时核对；若属性网格超预算，降级方案（SGR run 粒度加粗）须回本文件修订，不得静默退回纯文本。

**attach / resync 水位顺序（可断言）**：
1. `subscribe_output`：①注册 receiver（入订阅表，登记 subscription_id）→ ②**同锁内**生成 checkpoint + 截取当前 seq=S → ③自注册时刻起 live 帧进入有界 pending 暂存（seq < S 丢弃）→ ④返回 `{checkpoint, start_seq=S}` → ⑤返回后 pending 按 seq 单调去重投递，随后 live 直通。pending 溢出 → 订阅者置 Lagged，走 resync。
2. resync 重放/检查点分支同样返回 `end_seq`；UI 丢弃 `seq < end_seq` 的后续 live 帧（重复 seq 幂等丢弃）。
3. 断言用例补齐：attach 返回前已产生输出（pending 暂存不丢字）；alt_screen 活跃时 resync → checkpoint 分支重建备用缓冲与模式；重复 seq 不产生重复渲染。

**订阅清理断言（DF10.5 修订）**：
- 主路径：`unsubscribe_output(sid)` 显式退订（UI 关闭终端实例时必须调用）；`close_session` 自动清理全部该会话订阅。
- 兜底：桥 task send 失败（订阅端通道已关闭）→ 退出并清理——**仅覆盖有输出的会话**；静默会话不得依赖 send 失败路径，唯显式退订/会话关闭可清理（C-03）。
- P6 以 `debug_subscriptions` 计数为测量口径（每存活会话 ≤1；退订后归零）。

| # | 决定 |
|---|---|
| DF10.1 | Raw 帧头 8 字节 seq（吞吐优先，SPIKE-1 结论） |
| DF10.2 | subscribe 单步返回 `{checkpoint, start_seq}`；live 帧 pending 暂存 + 去重投递 |
| DF10.3 | resync 先 lossless 重放、不可则 checkpoint 分支；end_seq 水位去重 |
| DF10.4 | 终端恢复载体 = ScreenCheckpoint（双缓冲带属性网格）；纯文本 ScreenSnapshot 降级为调试/审计接口 |
| DF10.5 | 显式 unsubscribe_output 为主清理路径，send 失败为兜底；debug_subscriptions 计数器为 P6 测量口径 |

**旧 UI 同 commit 适配（登记项，总则 2「三端」含旧 App.tsx）**：旧 `App.tsx:1055-1082` 的订阅消费同步改造——①Raw 分支剥 8 字节帧头后写 xterm（否则二进制头直入终端显示为乱码）；②resync 载荷由裸 sid 改对象解析；③AttachOutput 消费（替代先 read_screen 后 subscribe 的两步，顺带消除 attach 竞态）；④`resync` 补 listen（修复 Q1 断链）。旧 UI 此项改造归 R10（adapter 层先行），不推迟到 R45。

- seq 为核心侧每 session 单调递增字节事件序号（替代 chunk 计数 watermark 的语义漂移）。

## 11. 新增错误汇总（ADR-15 内容，R03 签署即生效）

| 变体 | kind | 契约 |
|---|---|---|
| `ShellIntegrationUnavailable { available }` | shell_integration_unavailable | C3 |
| `IdentityInUse { host_names }` | identity_in_use | C8 |
| `CollaborationDisabled` | collaboration_disabled | C9 |
| `ConflictDetected { target_stat }` | conflict_detected | C6（MCP fail 路径） |
| `ReplaceUnsupported { capability }` | replace_unsupported | C6（无 posix-rename 阻止替换） |
| `StaleDecision { expect_revision }` | stale_decision | C5（决定乐观锁） |
| `InvalidTransferState { task_id, state }` | invalid_transfer_state | C5（非法状态下的决定提交） |
| `StalePlan { generation }` | stale_plan | C9（停用计划乐观锁） |
| `PathNotFound { path }` | path_not_found | C4（sftp_resolve_path） |
| `PermissionDenied { path }` | permission_denied | C4（sftp_resolve_path） |
| `SymlinkLoop { path }` | symlink_loop | C4（sftp_resolve_path） |

`CancelOutcome`/`TransferState`/`AttemptPhase`/`CollisionDecision` 等为返回类型/状态枚举，不入 Error。

## 12. 可断言序列清单（契约测试的最小集）

1. C1 取消竞态 6 序列（§C1：认证中取消、竞态关闭成功、**关闭失败保留会话**、Ready 后迟到取消无副作用、跨 Actor 拒绝、重复取消）。
2. C3 模式拒绝：无集成主机 → `exec(mode=Shell)` 副作用前错误 + 哨兵证明未执行 Fresh；显式 Fresh 按原授权执行（D09）。
3. C5/C6 提交未知：提交响应丢失注入 → 按复核路径分派（可证实已发布 → Succeeded{verified}；未发布 → Failed；不可判定 → OutcomeUnknown）+ journal 完整 + temp 保留规则 + 拒绝同目标覆盖任务。**注入缝（C13）**：进程内 mock SFTP server（russh-sftp server 侧 API 起内存服务端），吞掉/延迟 rename 发布应答；不依赖真实网络故障。
4. C6 冲突与发布决策表：①无 posix-rename 服务器 + overwrite → `ReplaceUnsupported` 且原目标字节不变（负例断言：目标 stat 前后一致）；②新文件 no-clobber：CREATE_NEW 声明失败（他方窗口内创建）→ 不覆盖、按冲突处理；③复检 stat 变化 → 显式 overwrite 亦返回 ConflictDetected。
5. C9 停用：Disabling 期间并发 create_session / 已批准未执行 / shim 在途调用 → 全部被拒且留痕；Disabled 三层确认顺序；**Disable 后 MCP status 端点不可达（预期断言）**；`disable_resolve` 过期 generation → `StalePlan`；Wait 项 120s 超时 → 该项 `StopFailed{wait_timeout}` 且整体 DisableFailed（admission 保持关闭）。
6. C10 attach：checkpoint+seq 同锁原子；pending 暂存不丢字；Lagged 后 resync 重放连续（带 seq 校验）；**alt_screen 活跃 → checkpoint 分支重建备用缓冲与终端模式；重复 seq 幂等**。
7. C2：人类 create_session → `SessionInfo.control_owner == Human`（原子性：无 Agent 窗口断言）。
8. C7：ProxyJump 条目 → blocking + directly_importable=false；重复导入默认 skip。
9. C5 决定提交：`submit_collision_decision` 正确路径生效；过期 revision → `StaleDecision`；Agent 任务提交决定 → `InvalidTransferState`；`reject_expired_decision` 幂等。
10. C1 合并幂等（复审 L4）：同 Actor 同主机重复 begin（无 new_session）→ 同一 attempt_id；Human/Agent 各自 begin 同主机 → 两个独立 attempt；`new_session=true` → 新 attempt。

## 13. 遗留到 G1 前必须闭合的事项

- C5 事件对 UI 渲染频率的影响评估（10 任务并发 × 5/s）在 R32 实现时验证，超限则降级为粗粒度+强制对账（设计允许）。
- C10 `ScreenSnapshot.text` 含 scrollback 的性能实测（R11），超 P 门即触发分档参数回归本文件修订。
- DF9.1 的 Agent 写动作全集清单在 R43 实施时以 MCP 工具注册表为权威重新枚举并比对本清单。
