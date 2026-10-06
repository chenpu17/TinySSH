# R03 前期调研：连接与协作契约现状与缺口（C1/C2/C3/C9/C10）

> 日期：2026-10-06 · 代码基线：`7c4502e` · 调研者：独立 subagent（实读 crates + src-tauri + cli 全量）
> 用途：供 R03 冻结 C1–C10 正式 wire/错误码/状态转移使用。每契约按「现状 → 增量 → 兼容影响 → 冻结待决点」组织。DCx.n 编号供主代理汇总拍板。

---

## C1 可追踪/可取消建连

### 现状

- 唯一建连入口 `SessionApi::create_session(ctx, CreateSessionReq) -> SessionId`（session-api/src/lib.rs:749）。调用方：Tauri `create_session` command（src-tauri/src/main.rs:93-99）、MCP 工具 `create_session`（mcp-server/src/lib.rs:269-282）、CLI `session ssh`（cli/src/main.rs:302）、GUI dev harness `TINYSSH_AUTOCONNECT`（src-tauri/src/main.rs:844-857）。
- **同步阻塞、不可取消**：TCP connect → TOFU 指纹门（core-session/src/lib.rs:229-278 `host_key_gate`，阻塞 oneshot，`DEFAULT_APPROVAL_TIMEOUT` 120s）→ 认证（transport-ssh/src/lib.rs:228-300；password 失败回落 `kb_loop` 多轮 keyboard-interactive，transport-ssh:433-475）→ PTY/shell 通道（transport-ssh:302-328）→ 返回 sid。之后同调用内注入集成并轮询等待最多 10s（core-session:531-551）。整条链无 CancellationToken、无阶段上报；`SshChannel::connect/establish`（transport-ssh:185-365）无取消参数。
- **无 attempt 对象**：失败即 Err 无痕（审计仅成功路径 `session_created` core-session:554；失败只有指纹/2FA 门的间接痕迹）。同主机重复点击 = 各自完整建连、各得一个会话，无合并。
- `SessionState`（session-api:511-519）= Connected/Degraded/Reconnecting/Disconnected/Reconfirming/Closed，无 Connecting/Authenticating/ChallengeRequired（设计主文 §6.2 已注明不可伪造为现有枚举）。
- 指纹门与 2FA 门的待决项 `PendingHostKey`/`PendingAuthPrompt`（session-api:247-275）**均无 attempt/session 归属**（`PendingAuthPrompt` 连 host_id 都没有，只有 host_name）。

### 增量（实现归属 R19）

- 新增 attempt 域：`begin_connection(host_id) -> attemptId`；attempt 状态机 Connecting/TrustRequired/Authenticating/ChallengeRequired/Ready/Failed/Cancelled（对齐设计 §6.2）；`connection_status(attemptId)`；`cancel_connection(attemptId)`；`connection_event` 订阅。`create_session` 原样保留兼容。
- transport 层：`establish` 拆阶段并接受 cancel token（russh 不可中断操作用 `select!` + 连接 drop 兜底）；指纹门/2FA 门挂 attemptId 并随 attempt 取消作废。
- 取消与成功并发由核心串行裁决：成功已提交 → 按关闭会话契约收尾，不留隐藏连接。
- 阶段事件供 UI 反馈（点击后 100ms 内反馈、笼统「正在连接」降级路径见设计 §6.2）。

### 兼容影响

- 旧调用方（MCP/CLI/旧 UI）继续走 `create_session`，行为不变；新 UI 走 attempt 路径，Ready 后取 sessionId。双轨并存至 G4 R45 清理。
- `PendingHostKey`/`PendingAuthPrompt` 若加 `attempt_id: Option<String>`：`#[serde(default)]` 保证旧载荷兼容（先例：`ApprovalItem.editable` session-api:221-223 及其 wire 测试）。
- 新错误：取消路径复用 `Error::Cancelled` 或新增 `ConnectionCancelled`（见 DC1.2）；`error_kind` 映射表（mcp-server:204-227）同步加分支。
- Agent 建远程会话必审逻辑（core-session:472-476）需决定在 attempt 模型的挂载时点（DC1.4）。

### 冻结待决点

- **DC1.1** attempt 终态后是否可查历史、保留多久；Ready→sessionId 交付后 attempt 记录与 session 的关联字段。
- **DC1.2** cancel 与成功竞态的 wire 表达：`cancel_connection` 返回值枚举（Cancelled / AlreadyReady{session_id}）；「按关闭会话契约处理」由核心自动关闭还是交 UI 确认。
- **DC1.3** 指纹/2FA 门 120s 超时是否改按 attempt 阶段计时；超时后 pending 卡清理 + 作废留痕口径（对齐 T44 `approval_voided` 审计先例 core-session:592-597）。
- **DC1.4** Agent 建会话审批在 attempt 生命周期的时点：审批等待算 attempt 的哪个状态；取消 attempt 是否作废其审批卡（应作废，机制复用接管/关闭的 voided 路径）。
- **DC1.5** 同主机连点合并（设计 §6.2）由核心（byHost 活跃 attempt 索引）还是 UI 判定；「显式新建会话」如何绕过合并。

---

## C2 人类会话初始控制权

### 现状

- `SessionHandle::new` 硬编码 `owner: AsyncMutex::new(ControlOwner::Agent)`（core-session/src/handle.rs:108）——**所有会话（含人类建的 local/ssh）初始 Agent-owned**。设计 §2.2 指认属实。
- `create_session(ctx)` 持有 Actor 但未据此设置 owner；`SessionHandle::new` 无 owner 参数。
- 控制权迁移仅有 `set_control`（仅人类可调，core-session:766-781 `InvalidActor` 门）：Human=takeover（handle.rs:648-735，代际 +1 作废未开始请求）、Agent=handback（handle.rs:738-750，要求当前 owner==Human）。
- 审计 `session_created`（core-session:554-556）payload 不含 owner。

### 增量（实现归属 R24）

- `SessionHandle::new` 增加 owner 入参（或 create_session 按 ctx 决定后传入）：`Actor::Human → ControlOwner::Human`；`Actor::Agent → Agent`（沿原规则）。构造期设置即原子，无「建完再接管」窗口。
- 审计 `session_created` payload 增加 `owner` 字段。
- 首次委托「交给 Agent」复用受控转换：建议独立 command（带 goal/确认载荷）内部调用既有 handback 路径，审计独立事件（见 DC2.2）；`SessionBrief.goal` 已可选（session-api:195-198），满足「任务目标可选」。

### 兼容影响

- **行为收紧（设计 D09 明确要求）**：人类建的会话不再 Agent-owned——旧测试/demo 若依赖「Agent 直接操作新会话」将得到 `ControlTakenByHuman`（handle.rs:338-340）。需 MCP 工具描述、契约测试、`docs/architecture` 同步更新。
- CLI `session ssh/local`（cli:295-302，人类身份）建的会话变 Human-owned：Agent 附加前需人类 `/handback`（cli:343-347 已有该命令）。
- wire 类型无变化（ControlOwner 枚举不变）；`SessionInfo.control_owner` 语义变化（新人类会话=Human）。

### 冻结待决点

- **DC2.1** dev harness `TINYSSH_AUTOCONNECT`（src-tauri:844-857，Human 身份）建的会话将变 Human-owned，走查脚本断言是否需要同步更新。
- **DC2.2** 首次委托的接口形态：复用 `set_control(Agent)` 还是新增 `delegate_session(sid, goal: Option<String>)`（内部走 handback、审计独立事件、要求显式确认）。R03 需拍板（倾向后者：设计 §6.7 要求「用户查看能力及现有授权范围后明确提交」，独立入口才能承载确认载荷）。

---

## C3 shell 集成选择与执行模式拒绝

### 现状

- **无条件注入 + 等待**：SSH create_session 无条件写入 `ssh_integration_snippet()`（core-session:531-542，审计 `shell_integration_inject`）并轮询 `shell_integration_present()` 最多 10s（core-session:546-551，200×50ms）；等待失败不阻断。重连路径 `reinject_integration`（handle.rs:799-818）同样无条件注入并等 `prompt_ready`。
- **静默降级（设计指认的 P1 缺口 TECH-02）**：`run_shell` 检测集成不可用即自动转 `run_fresh`（handle.rs:149-156，仅 tracing::info "no shell integration; degrade to Fresh"）——工作目录/环境语义被偷换，调用方无感。
- ExecMode wire：PascalCase `"Shell"`/`"Fresh"`，`Default = Shell`（session-api:53-60）。MCP exec 参数 `mode: Option<String>`，`"fresh"→Fresh`、**其余一切（含省略）→ Shell**（mcp-server:295-298）。Tauri `exec_human` 恒 `ExecOpts::default()`（src-tauri:244-250）；CLI 同（cli:351）。
- 能力检测：`shell_integration_present`（term-core/src/screen.rs:338，saw_133 计数，重连由 `reset_integration_tracking` 复位）、`prompt_ready`（screen.rs:345，B 标记重置型）。
- `Host`/`HostDraft` 无 shell_integration 设置字段（session-api:367-383、422-433）。

### 增量（实现归属 R24）

- host 级 `shell_integration` 设置（新普通主机默认关闭；显式启用才安装/注入）+ 只读能力查询（设置 ≠ 当前已检测成功；执行时仍重查，防查询与调用间能力变化）。
- `mode=Shell`（含省略）而 Shell 能力不可用：**任何用户命令副作用前**返回稳定错误 `ShellIntegrationUnavailable`（附可用能力信息）；禁止自动 Fresh、禁止事后提示。显式 `mode=Fresh` 才执行，走原授权/审批，UI 审批卡标注「不继承当前终端目录/环境」。
- create_session 与集成解耦：默认关闭后 SSH 建连不再注入/等待（直接满足性能门 P3「不等待 shell marker」）；启用时注入改后台、可观察。未启用集成的普通 SSH 重连不注入/不等 OSC（设计 §6.4、验收 B12）。

### 兼容影响

- **语义收紧，须版本/发布说明与旧客户端错误路径测试（设计 §10.2、验收 D09/D10）**：旧 Agent 在无集成主机上 exec（省略 mode）将从「静默 Fresh 结果」变为稳定错误。已具备 Shell 能力的主机与显式 Fresh 路径语义不变。
- `error_kind`（mcp-server:204-227）新增 `shell_integration_unavailable` 分支；MCP exec 工具描述更新；shim 纯透传（shim/src/main.rs 无 mode 逻辑）不受影响。
- `Host`/`HostDraft` 加字段用 `#[serde(default)]` 迁移旧载荷（Charset 先例 session-api:381-382、431-432）。
- 旧 UI `exec_human` 恒 Shell：新 UI 移除日常命令框后 exec_human 保留作协议/调试入口，无集成主机将如实报错（DC3.4）。
- 重连语义变化：`reinject_integration` 按 host 设置分支；`reset_scene_after_reconnect`（handle.rs:789-794）的 cwd 降级/块收尾逻辑与集成无关，保留。

### 冻结待决点

- **DC3.1** 错误 wire：`Error::ShellIntegrationUnavailable { available: CapabilityInfo }`；`CapabilityInfo` 字段集（integration_present/prompt_ready/host_setting）；error kind 名。
- **DC3.2** `host.shell_integration` 设置的值域：两态（Off/On）还是三态（含 Auto=沿用旧行为）？升级主机（C8 迁移）默认值按「保留原行为=On」还是按「运行时检测」重估（设计 §9 C3：迁移保留原有集成配置，运行时仍检测实际能力——倾向两态 + 运行时检测）。
- **DC3.3** 能力查询接口：`shell_capability(sid) -> CapabilityInfo`（任何 Actor 可查，只读）；重查点固定在 `run_shell` 入口（替换现 handle.rs:149-156 降级分支）。
- **DC3.4** Tauri `exec_human` 是否加 mode 参数供调试，或保持 Shell-only 如实报错。
- **DC3.5** 移除 create_session 内 10s 等待后的时序契约：会话 Ready 判据（transport shell 就绪即 Ready）；启用集成的会话「集成就绪」以独立事件/状态表达（Degraded 口径还是新字段）。

---

## C9 协作启用生命周期

### 现状

- **无生命周期**：MCP 端点装配即启动——GUI 进程内嵌（src-tauri:587-608，`spawn_endpoint(api, resolver, 8722)` bind 失败降级不 panic）；CLI `serve`（cli:183-205）。`spawn_endpoint`（mcp-server:579-592）**无 shutdown 句柄**，启动后无法停。
- admission = 纯 Token 解析：`auth_middleware`（mcp-server:594-613）只验 token 有效性，`actor_from_parts`（176-188）Token→Actor。无全局开关、无请求代际。
- 可复用的收敛机制先例：close_session 作废 pending 卡 + 唤醒等待方（core-session:578-603）；takeover 代际 +1 作废未开始请求（handle.rs:660-707）。
- Agent 身份存储：vault `create_agent/revoke_agent/resolve_token/list_agents`（src-tauri:388-395、cli:207-233）。shim 独立进程（shim/src/main.rs，stdio→HTTP 无状态转发，180s reqwest 超时）。
- Agent 入口全集（gate 必须全覆盖）：MCP 16 工具中全部写动作 create_session/exec/send_keys/upload/download/forward_start/forward_stop/close_session/cancel_exec + shim 透传的同一批调用。

### 增量（实现归属 R43）

- 生命周期状态机 Enabled/Disabling/Disabled/DisableFailed；确认停用 → 核心原子进入 Disabling → **统一 admission gate 立即拒绝所有新 Agent 请求**（覆盖无 session 的 create_session、已批准未执行、排队传输、在途 HTTP 中待启动动作；作废留痕）。
- 停用代际（类比 handle.generation）：在途请求执行开始前核对，不因旧审批决定继续执行。
- 收敛序列：重新枚举真实活动 → 用户逐项选择等待/尽力停止（逐项真实结果，复用 `StopOutcome` session-api:143-151）→ 已开始文件提交按 OutcomeUnknown（C6 范畴）→ 全部 Agent-owned 会话核心转 Human（不终止已开始任务，普通人类 SSH 保持）→ admission 已关 + 控制权收敛 + 应用端点停止 → Disabled。
- 失败：DisableFailed 且 admission 继续关闭，可重试；重新启用须显式操作并确认旧停用已收敛；先前作废不复活。外部 shim 不等待/不杀死，其调用被拒或端点不可用。
- 新装默认关闭、升级保留开启（C8/§10.1.6 迁移）。

### 兼容影响

- 全新状态机无旧调用方依赖；但升级路径必须保留「默认开启」行为，不能因重构撤销现有 Agent Token（设计 §10.1.6）。
- admission 拒绝的新错误 kind（如 `collaboration_disabled`）加入 mcp-server `error_kind`；shim 收到的应是结构化可解释拒绝而非裸 unreachable。
- `spawn_endpoint` 接口变更（返回 shutdown 句柄）——mcp-server pub API 变更，CLI serve 路径同步（CLI 无停用入口，不受行为影响）。
- GUI 端点面板（`mcp_status` src-tauri:399-405）需扩展生命周期状态展示。

### 冻结待决点

- **DC9.1** admission gate 挂载点：SessionManager 单点 wrapper vs 各 Agent 入口逐点查。需给出全覆盖检查清单（上面「Agent 入口全集」为底稿）；gate 检查必须在审批等待**之前**（先封入口再处理存量）。
- **DC9.2** 停用状态的存储与 wire：vault 设置键名（协作开关属核心配置，不入 `ui.v2.*`）；状态查询命令（Tauri + MCP 都可查？MCP 被停用时 Agent 查询本身被 gate 拒——状态查询应否豁免）；状态变迁事件（UI 推送通道复用 approvals 同款 broadcast？）。
- **DC9.3** Agent-owned → Human 批量转换的审计与简报：逐会话 `note_transition` + 独立审计事件（如 `collaboration_disabled_converted`）；转换不终止已开始任务的口径与 takeover「冻结不杀」一致。
- **DC9.4** DisableFailed 的失败原因查询与重试入口；admission 保持关闭期间 Agent 收到的错误 kind 与文案。
- **DC9.5** 「应用端点停止」的判定：axum serve graceful shutdown 的完成确认；`监听器关闭 ≠ gate 已生效`（设计 §9 C9）两层的确认顺序写进状态机。

---

## C10 输出订阅恢复与取消

### 现状

- 链路：transport broadcast(4096)（transport-ssh:187）→ `spawn_pump` 字符集解码后写屏并转发 `h.output_tx` broadcast(4096)（handle.rs:91、core-session:320-375）→ `OutputEvent::Raw{sid,data}` / `Resync{sid}`（session-api:559-564）→ Tauri `subscribe_output` command：Raw 以 `InvokeResponseBody::Raw` 原始字节直通（SPIKE-1 结论：JSON 数字数组慢一个量级）；Resync/Lagged → `window.emit("resync", sid)`（src-tauri:204-231）→ UI 收 resync 即 `read_screen` 全量重灌（App.tsx:1063-1064）。
- Lagged 双层检测：pump 侧（core-session:337-339）与 tauri 桥侧（src-tauri:223-225）。
- **attach 竞态**：UI 顺序为先 `read_screen` 再 `subscribe_output`（App.tsx:1076-1079）——快照与订阅起点之间的输出丢失；反过来先订阅则快照后有重复。无 seq/水位，丢/重不可判定。
- 无损缓冲基础设施已备：term-core `lossless` VecDeque（默认 cap 8MB，screen.rs:21/61/188-209）、`lossless_len`（screen.rs:363，**chunk 计数**）、`text_since(watermark)`（screen.rs:368）、`lossless_notify`；`wait_output` 已消费（core-session:736-757，用 `min` 防御 cap 淘汰后 watermark 失效）。**watermark=chunk 数非单调**，淘汰后语义漂移，作正式恢复协议需升级为单调 seq。
- **文档/实现矛盾**：`ScreenSnapshot.text` 注释「渲染后文本（含 scrollback）」（session-api:534），而 read_screen 实现用 `screen_only_text()`（core-session:656）——不含 scrollback。resync 后 UI 拿到的快照实际丢历史。
- 订阅清理：tauri 侧 task 在 channel send 失败时退出（src-tauri:216-218）；核心侧 receiver drop 即随 broadcast 清理；**无显式 unsubscribe**；会话关闭后 handle 从 sessions 移除（core-session:573）但订阅 task/`output_tx` 的释放时机无断言。

### 增量（实现归属 R11，FE/Core 共担）

- 事件带单调 seq（或字节水位）；subscribe 返回 {snapshot, start_seq}（或等价 attach 结构）；resync 恢复 = 从 lossless watermark 重放（保 scrollback 连续），非盲目全量快照；attach 无丢字/重复（验收 B11）。
- lossless watermark 升级为单调 seq（字节或事件序号），淘汰后旧 seq 请求返回明确「已淘汰需快照」。
- 前端 TerminalRegistry：每 session 单实例单订阅，切标签/面板不重订阅（设计 §8.2）；订阅清理可验证（性能门 P6）。

### 兼容影响

- `OutputEvent` 加字段：serde 默认对旧消费者兼容；但 **Tauri Raw 直通路径带不了 JSON 元数据**——seq 需二进制帧头或控制事件旁路（DC10.1，吞吐约束优先）。
- `subscribe_output` 返回值从 `()` 改为结构——Tauri command 接口变更，旧 UI 同步适配（旧 UI 也在同一 command 上）。
- `ScreenSnapshot.text` 的 scrollback 语义须裁决并对齐实现与文档（DC10.4）。
- MCP 侧 `read_screen`/`wait_output` 轮询语义不变（MCP 不订阅流）。

### 冻结待决点

- **DC10.1** seq 载体：Raw 帧前缀二进制头（改动 UI 解析）vs 独立 control 事件（时序对齐难）vs Tauri 事件旁路（SPIKE-1 吞吐结论限制主路径）。R03 须连同 B11 测试口径一起拍板。
- **DC10.2** attach 协议形态：改 `subscribe_output` 返回 {snapshot, start_seq}，还是拆 `subscribe`（拿 rx）+ `attach`（拿快照+seq）两步。
- **DC10.3** resync 恢复语义：lossless 重放（scrollback 连续）vs 全量快照重灌（现行为）；alt_screen 活跃时重放的降级（重放文本流不还原 alt screen 状态——可能仍需快照分支）。
- **DC10.4** `ScreenSnapshot.text` 是否含 scrollback：与实现（`screen_only_text` vs `snapshot_text`）二选一对齐，同步 demo shim 与契约测试。
- **DC10.5** 订阅清理断言：会话关闭/窗口关闭后核心 pump-桥任务退出与 `output_tx` 释放的可验证口径（P6「每存活会话至多一个输出订阅」的测量方法）。

---

## 待决点汇总（主代理拍板清单）

| 契约 | 待决点 | 风险 |
|---|---|---|
| C1 | DC1.1–DC1.5（attempt 生命周期/取消竞态/门超时/审批时点/合并归属） | 取消竞态是设计明示的可断言序列，冻结不闭合则 R19 无法开工 |
| C2 | DC2.1–DC2.2（autoconnect 断言/委托接口形态） | 低；行为收紧本身已由 D09 定死 |
| C3 | DC3.1–DC3.5（错误 wire/设置值域/能力查询/exec_human/Ready 时序） | 高——语义收紧+协议兼容说明是本轮登记的破坏性变更 |
| C9 | DC9.1–DC9.5（gate 挂载/状态 wire/转换审计/失败语义/端点确认） | 高——漏一个 Agent 入口即破停用语义 |
| C10 | DC10.1–DC10.5（seq 载体/attach 形态/resync 语义/scrollback 矛盾/清理断言） | 中——Raw 直通吞吐与 seq 元数据互斥，需实测取舍 |
