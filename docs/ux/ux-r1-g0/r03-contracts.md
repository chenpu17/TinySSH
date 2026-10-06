# R03 契约冻结草案（C1–C10）

> 日期：2026-10-06 · 基线：`7c4502e` · 状态：**R03 草案（独立审核修订版）**，待 G0 联合评审签署后生效；签署前禁止按本文件实施。
> 独立审核记录（rev-r03，2026-10-06）：阻塞 0 / 高 4 / 中 1 / 低 3，**全部已修**——①TransferState 补 `Interrupted` + journal 全程落行与重启分类（§C5）；②`shell_integration` 改 `Option<bool>` + C8 显式迁移 true，杜绝灰度期静默关闭（§C3）；③subscribe_output 保留通道实签名 + 旧 UI 同 commit 适配登记归 R10（§C10）；④DF6.1 发布判定改 RawSftpSession 扩展表机制 + bak 预检（russh-sftp 2.4.0 实证：无 posix-rename API、Features pub(crate)）；⑤C6 注入缝点名 mock server（§12.3）；⑥demo shim 返回形变、⑦停用影响预览组合渲染。抽查 11 处 file:line 断言全部属实。
> 输入：[连接/协作缺口分析](r03-gap-connection-collab.md) · [文件/传输缺口分析](r03-gap-files-transfer.md) · 设计主文 §6/§9/§10。
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
                | Ready | Failed | Cancelled
AttemptInfo { attempt_id, host_id, phase, session_id: Option<String>,
              created_at, error: Option<ErrorPayload> }
CancelOutcome = Cancelled | AlreadyReady { session_id } | NotFound
```

### 状态机与竞态

- 状态转移仅核心可写；`Ready` 携带 `session_id`，此后 attempt 不再变化。
- **取消竞态可断言序列**（契约测试必须覆盖）：
  1. `begin → cancel（认证中）→ Cancelled`，无 session 遗留（sessions 表无该记录）。
  2. `begin → 核心已提交 session → cancel → AlreadyReady{sid}`；核心自动按关闭会话契约关闭 sid，审计 `connection_cancelled_closed{attempt_id, session_id}`；后续 `connection_status` 返回 `Cancelled`（终态改写：AlreadyReady 是 cancel 的返回值，不是 attempt 终态）。**UI 不再弹确认**。
  3. `begin → cancel → cancel → 第二次返回 NotFound`（attempt 已终态）。
- 指纹门/2FA 门：`PendingHostKey`/`PendingAuthPrompt` 增加 `attempt_id: Option<String>`（serde default）；门超时 120s 改按 attempt 存续计时，超时 → 作废 pending 卡（复用 T44 `approval_voided` 留痕先例）+ attempt=Failed{error: timeout}。
- Agent 建会话审批：attempt 显示笼统 `Connecting`；审批等待期间 `cancel_connection` 同步作废 pending 审批卡（复用 voided 路径）。
- 同主机合并：核心维护 byHost 活跃 attempt 索引；`begin_connection(host)` 且无 `new_session=true` 且该 host 有活跃 attempt → 返回既有 attempt_id（幂等）。`new_session=true` 绕过合并。
- attempt 终态不设查询历史接口；失败/取消以审计事件 `connection_failed` / `connection_cancelled` 留痕。

### 决议表

| # | 决定 |
|---|---|
| DC1.1 | 不做 attempt 历史查询；Ready 后 `attempt_id↔session_id` 经 Ready 事件与审计关联 |
| DC1.2 | CancelOutcome 三态如上；成功竞态由核心自动关闭，UI 显示「已取消」 |
| DC1.3 | 门超时按 attempt 计时（120s 不变），作废留痕 |
| DC1.4 | Agent 审批挂 attempt：Connecting 态呈现，取消即作废审批卡 |
| DC1.5 | 合并由核心判定，`new_session` 显式绕过 |

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
    错误：NotFound | PermissionDenied | SymlinkLoop（可解释文案）
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
事件：transfer-event（每事件带 revision）
  TransferEvent { task_id, revision, state, bytes_transferred, total_bytes: Option<u64>,
                  error: Option<ErrorPayload> }
TransferTask { task_id, session_id, conn_generation, direction, source, destination,
               state: TransferState, bytes_transferred, total_bytes: Option<u64>,
               revision, created_at, finished_at: Option<...>, error, retry_of: Option<TaskId>,
               collision_decision: Option<CollisionDecision> }
TransferState = Queued | AwaitingDecision | Running | Cancelling | Committing
              | Succeeded | Failed | Cancelled | OutcomeUnknown | Interrupted
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
| DF5.2 | vault `transfer_journal` 表（V5），不新开日志文件 |
| DF5.3 | 细粒度事件（逐任务带 revision） |
| DF5.4 | 200ms 时间主导节流 + 终态必发 |
| DF5.5 | cancel 幂等：终态任务返回其终态；Cancelling 中再取消返回 Cancelling |

## C6 冲突与提交（实现 R34；消费 R35）

### 冻结序列（可行性硬点 DF6.1）

```text
写入：同目录临时文件  .tinyssh-part-<task_id>-<name>
  → 全量写 + flush + close → stat 临时文件核对长度
  → 发布（按服务器能力，握手时探测 posix-rename@openssh.com）：
    a) 支持 posix-rename：rename(temp → target) 原子发布
    b) 不支持：替换= 双 rename（target→.tinyssh-bak-<task_id>-<name>，再 temp→target，
       失败回滚 bak→target）；文案明示「非原子，可能覆盖外部程序变更」
    c) b) 的 bak 名冲突或中途崩溃 → 恢复资料裁决；bak/temp 均为可识别标记文件
  → 任何「阻止发布」路径不得截断原目标
提交前：journal 落库（C5）→ 提交 → 终态
冲突询问：AwaitingDecision（仅人类路径）：
  skip / overwrite / keep-both（默认 skip；keep-both 命名 name.tinyssh-1.<ext> 递增）
```

- 预检→提交窗口复检：存在性 + size + mtime 三比对，变化 → 重回 AwaitingDecision（DF6.3）。
- 同目标锁键：canonical path（远端经 resolve；本地绝对路径）（DF6.4）。UI 文案口径：「客户端内同目标串行；其他程序不受限制，替换可能覆盖其变更」。
- 部分文件：确认未提交的失败/取消 → 删除本任务 temp；OutcomeUnknown → temp 与 bak 均保留；浏览器不过滤 `.tinyssh-*`（可见即可识别）（DF6.5）。
- **MCP/Agent 传输**（DF6.2）：`upload_file`/`download_file` MCP 工具新增可选参数 `collision: "skip"|"overwrite"|"fail"`，**缺省 fail**（结构化 `ConflictDetected` 错误返回目标 stat）；`overwrite` 在审批卡明示「将覆盖已存在目标」。Agent 路径永不进入 AwaitingDecision。

| # | 决定 |
|---|---|
| DF6.1 | **发布能力判定机制（按 russh-sftp 2.4.0 实际能力修订）**：crate 高层 `SftpSession` 不支持 posix-rename（无对应 API；`Features` 为 pub(crate) 且不含该项），探测**不走 extended 查询**——posix-rename 由服务器在 SSH_FXP_VERSION 扩展表中宣告。实现：发布路径使用 pub 导出的 `RawSftpSession`：`init()` 取版本与扩展表 → 解析 `posix-rename@openssh.com` 是否在列 → 支持则 `extended("posix-rename@openssh.com", …)` 手工序列化发布；不支持则走双 rename 降级。**双 rename 前先 stat bak 目标名**，已存在则换序号（防 clobber 型服务器吃掉旧 bak） |
| DF6.2 | MCP `collision` 参数，缺省 fail |
| DF6.3 | 存在性+size+mtime 三比对 |
| DF6.4 | 锁键 canonical path；外部进程边界写进 UI 文案 |
| DF6.5 | temp/bak 命名与保留规则如上 |

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
- 状态查询（DF9.2）：Tauri `collaboration_status() -> {state, generation}`；MCP `status` 工具**豁免 gate**（只读，返回 Disabled 说明，便于 Agent 理解拒绝原因）；状态变迁走新 broadcast 桥 `collaboration-event`。
- DisableFailed（DF9.4）：原因可查（同 command 返回）；admission 关闭期间错误 kind 与 Disabled 相同。
- 外部 shim：不等待/不杀死；其调用被 gate 拒或端点不可用。重新启用不作废前停用期的作废记录（不复活）。

| # | 决定 |
|---|---|
| DF9.1 | 单点 wrapper + 全量清单测试 |
| DF9.2 | settings 键 + 状态命令 + MCP status 豁免 + collaboration-event |
| DF9.3 | 逐会话转换 + 批量审计事件 |
| DF9.4 | 错误 kind 同 Disabled；原因可查 |
| DF9.5 | 三层确认顺序如上 |

## C10 输出订阅恢复（实现 R11，FE/Core 共担；消费 R14/R25/R45）

### 冻结 wire

```text
命令（现行实签名 subscribe_output(sid, on_event: Channel)，main.rs:204-208——保留通道参数）：
subscribe_output(sid, on_event: Channel) -> AttachOutput   // 返回值结构变更（原地升级）
  AttachOutput { snapshot: ScreenSnapshot, start_seq: u64 }
Raw 输出帧：<u64 LE seq（8 字节头）><payload 原始字节>    // UI 剥头取 seq
事件（window.emit）：resync { session_id, from_seq: Option<u64> }
  UI 收到后调 resync_output(sid, from_seq)：
    lossless 可重放 → { events: 重放字节, end_seq }（scrollback 连续）
    不可重放（淘汰/alt_screen 活跃）→ { snapshot, end_seq } 全量快照分支
ScreenSnapshot.text：**含 scrollback**（文档与实现对齐：read_screen 改用快照文本含历史；
  性能若超 P 门，R11 加显式参数分档——须重新登记）
调试：debug_subscriptions() -> { active_count, per_session: [...] }   // P6 测量口
```

**旧 UI 同 commit 适配（登记项，总则 2「三端」含旧 App.tsx）**：旧 `App.tsx:1055-1082` 的订阅消费同步改造——①Raw 分支剥 8 字节帧头后写 xterm（否则二进制头直入终端显示为乱码）；②resync 载荷由裸 sid 改对象解析；③AttachOutput 消费（替代先 read_screen 后 subscribe 的两步，顺带消除 attach 竞态）；④`resync` 补 listen（修复 Q1 断链）。旧 UI 此项改造归 R10（adapter 层先行），不推迟到 R45。

- seq 为核心侧每 session 单调递增字节事件序号（替代 chunk 计数 watermark 的语义漂移）。
- attach 原子性：subscribe 内部先取快照再取当前 seq，**同锁内完成**，消除「先 read_screen 后 subscribe」丢字竞态（B11 可断言：带 seq 连续性校验）。
- 订阅清理断言（DF10.5）：会话关闭 → 桥 task 退出（send 失败路径）+ `output_tx` drop；P6 以 `debug_subscriptions` 计数为测量口径（每存活会话 ≤1）。

| # | 决定 |
|---|---|
| DF10.1 | Raw 帧头 8 字节 seq（吞吐优先，SPIKE-1 结论） |
| DF10.2 | subscribe 单步返回 {snapshot, start_seq} |
| DF10.3 | resync 先 lossless 重放、不可则快照分支 |
| DF10.4 | text 含 scrollback（改实现对齐文档） |
| DF10.5 | debug_subscriptions 计数器为 P6 测量口径 |

## 11. 新增错误汇总（ADR-15 内容，R03 签署即生效）

| 变体 | kind | 契约 |
|---|---|---|
| `ShellIntegrationUnavailable { available }` | shell_integration_unavailable | C3 |
| `IdentityInUse { host_names }` | identity_in_use | C8 |
| `CollaborationDisabled` | collaboration_disabled | C9 |
| `ConflictDetected { target_stat }` | conflict_detected | C6（MCP fail 路径） |

`CancelOutcome`/`TransferState`/`AttemptPhase` 等为返回类型/状态枚举，不入 Error。

## 12. 可断言序列清单（契约测试的最小集）

1. C1 取消竞态 3 序列（§C1）。
2. C3 模式拒绝：无集成主机 → `exec(mode=Shell)` 副作用前错误 + 哨兵证明未执行 Fresh；显式 Fresh 按原授权执行（D09）。
3. C5/C6 提交未知：提交响应丢失注入 → OutcomeUnknown + journal 完整 + 拒绝同目标覆盖任务。**注入缝（C13）**：进程内 mock SFTP server（russh-sftp server 侧 API 起内存服务端），吞掉/延迟 rename 发布应答；不依赖真实网络故障。
4. C6 冲突：预检后外部变更注入 → 重回 AwaitingDecision；无授权不覆盖。
5. C9 停用：Disabling 期间并发 create_session / 已批准未执行 / shim 在途调用 → 全部被拒且留痕；Disabled 三层确认顺序。
6. C10 attach：snapshot+seq 同锁原子；Lagged 后 resync 重放连续（带 seq 校验）。
7. C2：人类 create_session → `SessionInfo.control_owner == Human`（原子性：无 Agent 窗口断言）。
8. C7：ProxyJump 条目 → blocking + directly_importable=false；重复导入默认 skip。

## 13. 遗留到 G1 前必须闭合的事项

- C5 事件对 UI 渲染频率的影响评估（10 任务并发 × 5/s）在 R32 实现时验证，超限则降级为粗粒度+强制对账（设计允许）。
- C10 `ScreenSnapshot.text` 含 scrollback 的性能实测（R11），超 P 门即触发分档参数回归本文件修订。
- DF9.1 的 Agent 写动作全集清单在 R43 实施时以 MCP 工具注册表为权威重新枚举并比对本清单。
