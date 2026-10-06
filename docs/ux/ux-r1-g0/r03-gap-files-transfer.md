# R03 前期调研：C4–C8 契约现状与缺口（文件 / 传输 / 导入 / 偏好）

> 基线：`7c4502e` · 日期：2026-10-06 · 方法：实读 transport-ssh / core-session / vault / session-api / src-tauri / App.tsx 相关路径
> 用途：供 R03 冻结正式 wire/错误码/状态转移直接引用；结论只陈述源码事实与设计差距，不预设实现选型。
>  companion：连接/协作方向（C1/C2/C3/C9/C10）另文。

## C4 文件路径 / 冲突元数据

### 现状

- `list_dir` 每次调用新建临时 SFTP 通道（`crates/transport-ssh/src/lib.rs:771-810`：channel_open_session:774 → subsystem sftp:779 → `SftpSession::new`:782 → read_dir → close）。无持久 SFTP 会话，无 stat、无 realpath/canonical path、无符号链接区分。
- 条目类型 `DirEntryS { name, is_dir, size: u64, mtime: i64 }`（`crates/session-api/src/lib.rs:587-595`），注释明示「size 未知为 0；mtime 未知为 0」——**未知字段伪造零值是当前 wire 契约**，与设计 §6.5「未知大小/时间显示—，不伪造零值」直接冲突。该形态被 wire 测试锁定（`session-api/src/lib.rs:972-982` `dir_entry_wire_format_matches_ui`，UI/demo 三端依赖）。
- 无权限字段；`is_dir` 取自 `metadata().is_dir()`（transport-ssh:797），symlink 指向目录时语义取决于 russh_sftp 的 metadata 实现，未验证。
- 前端 `sftp_list` 调用（`ui/src/App.tsx:1388`）无 request generation——晚到的旧路径响应可覆盖新路径显示，设计 §6.5「目录响应只更新对应 session + path + request generation」无现状支撑。
- 上传目标目录从现场简报 cwd 推导（`App.tsx:1343-1351`，「无法确定远程目录（现场简报未就绪）」，remote 显示 `—`）——浏览路径与 shell cwd 未分离，无「SFTP 初始目录」回落。
- IPC 入口 `sftp_list`（`src-tauri/src/main.rs:153-155`），仅人类。

### 增量（设计 §9 C4）

`sftp_resolve_path`（canonical path，服务端返回或可解释错误）、`sftp_stat`；条目增加 kind（dir/file/symlink/other）、权限/不可读状态、size/mtime 可空；request generation 保护；首次打开的「本次连接可信 cwd / SFTP 初始目录 / 手输」回落链。

### 兼容影响

`DirEntryS` 是锁定 wire（测试 + UI + demo）。size/mtime 改可空 = 破坏性变更：需新结构或字段级 serde default + 版本协商，CLI/demo 同步；不能沿用「加字段就完事」——零值语义已被消费端依赖（目录 size=0 的展示逻辑）。

### 待决点

- DF4.1 `DirEntryS` v2 形态：扩展新结构（`DirEntryS2`）还是同结构字段改 Option + 各端同步升级？wire 兼容窗口如何给 CLI/demo？
- DF4.2 resolve_path 采用 SFTP realpath（SSH filexfer）还是 realpath+组件校验组合？服务端差异（symlink 循环、权限）的错误码映射。
- DF4.3 symlink 展示与跟随策略冻结（跟随打开 vs 明确标注不跟随）。
- DF4.4 前端 request generation 放 UI 层还是命令返回带 path+generation 由核心比对（后者可防 adapter 层竞态）？

## C5 核心持有传输任务

### 现状

- 有任务 ID：`TransferHandle { id, session_id, kind, local, remote }`（`session-api/src/lib.rs:570-577`）——仅身份，无状态、无进度、无时间字段。
- `transfer()`（`crates/core-session/src/lib.rs:1156-1239`）：Agent 传输必审（1172-1189，不可编辑批准 1188）；人类直传。**立即 spawn 执行（1203 注释「MVP 直接执行」）**：无队列、无并行上限、无同目标串行。
- 任务表 `h.transfers = HashMap<TransferId, CancellationToken>`（内存，仅活跃任务，1201）。无 `list_transfers`、无状态查询、无中途字节进度——**只有终态审计事件** `transfer_done{bytes}` / `transfer_failed{error}` / `transfer_voided`（1213-1234）。
- 前端终态对账：**轮询 `audit_query(limit 30)` 匹配 `payload_json.transfer`**（`App.tsx:1493-1508`，仅存在 running 卡时轮询）——设计 C5 完成条件「完成/取消不靠审计猜测」的直接冲突点；limit 30 在多任务并发时有事件挤出窗口风险。
- UI 卡片：pending 占位 tempId → 拿到 TransferHandle 后换真实 id（`App.tsx:1335-1354`）；无进度条数据源。
- 取消：`cancel_transfer`（main.rs:147；core-session:792-801）置 CancellationToken → upload/download 64KB 循环边界检查（transport-ssh:694-696 / 750-752）→ `Error::Cancelled` → 审计 transfer_failed。取消精度 = 64KB 块；部分写入残留无处理（见 C6）。
- 作废语义：spawn 时一次性比对会话 generation（1212），**开始后接管/交还不中断运行中传输**；`close_session` 不取消 transfers（全库仅 cancel_transfer 与 transfer() 触达 transfers 表）——会话关闭后任务随通道死掉变 transfer_failed(SessionClosed)，非显式取消。
- 无持久化：重启后活跃任务全消失，仅审计残留历史；无重启恢复分类（设计要求区分「提交前中断」与「OutcomeUnknown」）。

### 增量（设计 §9 C5 + C5 建议数据 + §6.5）

核心任务注册表：task ID、session ID、连接 generation、direction、source/destination、status（Queued→Running→Committing→Succeeded，冲突 AwaitingDecision，Cancelling/Failed/Cancelled/OutcomeUnknown）、bytesTransferred、totalBytes 可空、单调 revision、createdAt/finishedAt、error、retryOf；`list_transfers` + `transfer_event`（~5 次/秒合并）；提交前恢复资料持久化；重启按提交前/提交未知分类恢复。

### 兼容影响

新增命令/事件为主（additive）。风险点：①`cancel_transfer` 现对不存在 id 返回 `InvalidInput`——新语义下对已完成任务取消应幂等还是报错需冻结；②审计事件是否保留双写迁移期（现 UI 依赖审计轮询，R32 换轨前后 UI 双读）；③Agent 必审路径（wait_approval）与新队列状态（Queued 里等审批？）的状态机合并。

### 待决点

- DF5.1 注册表归属：SessionManager 全局表（支撑「窗口全局最多 4 并行」与跨面板存续）+ 会话归属字段，还是会话级？——建议全局，冻结时确认。
- DF5.2 重启恢复的持久化时机与载体：恢复资料（提交前日志）写 vault 新表还是独立日志文件？与 sessions 表 state 的关联。
- DF5.3 `transfer_event` 形态：粗粒度 Changed{session_id}（沿 ForwardEvent 模式，UI 全量拉）还是逐任务携带 revision？——ForwardEvent 模式（`session-api/src/lib.rs:307-310`）实现简单且已被 T44 验证，但 10 任务并发时全量拉频率需评估。
- DF5.4 事件节流「每秒约 5 次/任务」在传输 64KB 块循环内的采样点定义（读块计数 vs 字节阈值）。
- DF5.5 cancel_transfer 幂等语义与「Cancelling 中再取消」返回值。

## C6 传输冲突与提交

### 现状

- 上传 `sftp.create(remote)`（transport-ssh:684-687）——SFTP CREATE|TRUNC 语义，**直接截断远端目标**；无目标预检、无冲突询问、无临时文件、无发布步骤。
- 下载 `tokio::fs::File::create(local)`（transport-ssh:744-746）——直接截断本地目标。
- 下载缺省本地目标 `~/Downloads/<远端文件名>`（main.rs:131-137，文件名取远端路径 rsplit）——同名静默覆盖本地已有文件。
- 冲突、版本检查、Committing/OutcomeUnknown、提交窗口持久化、同目标串行、并行上限：**全部不存在**（transfer() 立即并发 spawn，core-session:1211）。
- 部分文件：取消/失败时已写字节留在目标原位（上传目标被截断后的残段、下载本地残段），无标识、无清理责任。
- cancel 与写入的竞态：cancel 检查在读写循环边界，最后一次 write_all 不可中断——「确认未提交时保证原目标未被替换」当前无法承诺（目标在 create 时即已被截断）。

### 增量（设计 §6.5 + §9 C6）

冲突预检（stat 目标 → 跳过/替换/保留两份，默认跳过）、决策后提交前复查、同目录临时文件 + 可验证发布（posix-rename 或 no-clobber 验证）、Committing/OutcomeUnknown + 提交前持久化恢复资料、取消与提交同一任务锁线性化、同目标串行、并行上限（每会话 2 / 全局 4）、外部进程边界声明（不承诺绝对 CAS）。

### 兼容影响

- **行为破坏性**：现有 upload/download 从「直接覆盖」变「冲突门」。Agent MCP 传输（必审）无法应答冲突询问——Agent 路径需预置策略或明确失败语义，R03 必须冻结（影响 MCP 工具描述）。
- 「保留两份」命名规则、临时文件前缀与清理责任是新 wire/文件系统可见行为。
- 能力依赖：OpenSSH sftp-server 的 `posix-rename@openssh.com` 扩展非普适；无该扩展时「替换」的安全降级路径（私有暂存 + 已验证 no-clobber 发布 or 阻止）必须冻结错误码。

### 待决点

- DF6.1 SFTP 写入与发布序列冻结：临时文件命名（同目录 `.name.tinyssh-part-<tid>`？）、flush/close→rename（posix-rename 探测）→失败降级链；**这是本轮最硬的可行性冻结点**。
- DF6.2 Agent（MCP）传输的冲突缺省策略：fail（推荐，返回结构化冲突错误）还是策略字段预置 skip/overwrite？MCP 工具 schema 是否新增 policy 参数。
- DF6.3 预检→提交窗口的目标复检粒度（stat size/mtime 比对 vs 只比对存在性）。
- DF6.4 同目标串行的锁键定义（canonical path?）与「外部进程不受锁」的 UI 文案口径。
- DF6.5 部分文件清理责任与「可识别」标记（临时文件即天然可识别？失败后保留供诊断还是立即删？）。

## C7 SSH config 导入诊断

### 现状

- 解析子集（`crates/vault/src/sshcfg.rs:41-113`）：仅 Host/HostName/User/Port/IdentityFile。通配符模式直接过滤（:60，无痕）；Match 块整体跳过无痕（:70-75）；**其余指令 `_ => {}` 纯静默**（:108）——Include、ProxyJump/ProxyCommand、证书、CanonicalizeHostname 等依赖完全不可见，与设计 §6.1/C7「未支持项给具体原因，不静默导入为可连接」直接冲突。
- 无来源行号（`SshConfigEntry` 无 line 字段）；Include 子文件不跟随。
- 预览去重：同名 OR 同 address+port+user → `already_imported` 标记（`core-session/src/lib.rs:1292-1299`，含 USER env 与 root 兜底的 username 规则 :1278-1283——无 User 条目静默导入为 root，属未登记行为决定）。
- **导入落库不复查去重**：`ssh_config_import` 对已导入条目照样 `upsert_host(id: None)`（:1360）——重复勾选静默再建一台主机，设计 §6.1「默认跳过，覆盖必须明确选择」不满足。
- IdentityFile 多值只取首个（sshcfg:100-107）；私钥读取失败/有口令已有明确错误（:1342-1349，passphrase 错误明说「手工导入」）。
- wire：`SshConfigPreview { name, address, port, username, has_identity, already_imported }`、`SshImportOutcome { name, host_id, error }`（session-api:458-475）——无 warnings/unsupported/blocking/来源行。

### 增量（设计 §9 C7 + §6.1）

解析层记录每条目 unsupported 指令清单 + 来源行号（含文件名）；预览增 warnings/unsupported/blocking 分级；「无法证明解析完整 → 默认不可勾选直连导入，可转手工表单预填」；导入端强制去重（默认跳过，覆盖须显式）。

### 兼容影响

`SshConfigPreview`/`SshImportOutcome` 增字段用 serde default 可保持旧调用方（CLI/旧 UI）可读——additive 友好。但 CLI 输出与 demo shim 需同步新字段语义；「不可直接导入」的条目在预览中的呈现（置灰/标注）是新 UI 行为，老 UI 忽略该字段时仍可能导入（迁移期 UI 与核心能力不一致窗口需说明）。

### 待决点

- DF7.1 unsupported 分级标准：哪些阻断（ProxyJump/ProxyCommand/Include/Match 依赖项/证书）、哪些仅警告（ServerAliveInterval 等无害项）、哪些静默忽略（正向清单）。直接决定验收 A09 判定。
- DF7.2 Include 是否跟随解析（读子文件并标注来源文件+行号）还是列为阻断依赖。
- DF7.3 导入端去重的「覆盖」操作 wire：现状 upsert_host 需 id——覆盖= 查重得 id 再 upsert，还是新参数？与 A08「默认不覆盖重复」对齐。
- DF7.4「转手工表单」通道：预览条目 → HostDraft 预填走现有 upsert_host 还是新增只读查询命令给 UI 组装。
- DF7.5 username 兜底规则冻结（USER env / root / 必填化）——现状 root 兜底是安全隐患面。

## C8 偏好 / 收藏 / 最近

### 现状

- 存储为扁平 KV：settings 表 `key TEXT PRIMARY KEY, value TEXT NOT NULL`（`crates/vault/src/db.rs:52-63` V3 迁移）；`get_setting/set_setting` 单键 upsert（`vault/src/lib.rs:374-398`）。无 schemaVersion、无命名空间版本、无多键事务原语（SQLite 单条 upsert 自身原子）。
- 现有键仅 `ui.font_size`、`ui.theme`（`App.tsx:318-319`，读写 :923/:967-968；测试 `vault/src/lib.rs:920-939`）。
- 迁移机制：`PRAGMA user_version` 顺序幂等迁移（vault lib.rs:35-72，现至 V4）——ui.v2 增量可直接扩展此机制，无需新框架。
- 无按 host 的 metadata（收藏/最近无处存）；hosts 表存在未使用列 `group_id`/`jump_host_id`（db.rs:5-8，list_hosts 不读）。
- 最近连接素材：sessions 表（db.rs:41-46，id/host_id/kind/state/created_at/closed_at）可验证生成「最近连接」——设计 §10.1.4 的「可验证会话历史」已有载体；断线重连不换 sid（created_at 为首建时间）。
- `delete_identity` 无引用检查（vault:576-581）——被主机引用的凭据可被删，hosts.identity_id 悬挂；设计 §6.1「删除前检查引用」不满足。`delete_host` 同样无 metadata/转发/会话联动定义。
- 持久化时机：UI 即时 set_setting（App.tsx:923）；无失败重试/可见化。

### 增量（设计 §9 C8 + §10.1）

`ui.v2.*` 键 + schemaVersion、事务迁移写标记幂等、按 host ID metadata（收藏/最近；新表 V5）、旧 `ui.theme`/`ui.font_size` 一次性映射（仅升级路径，新装跟随系统）、凭据删除引用检查、主机删除的 metadata 清理。

### 兼容影响

全 additive（新表/新键）；旧键保留不删（回退兼容：旧二进制仍读 ui.theme/ui.font_size）。风险点：①主题映射「旧主题 → 终端配色 + 应用外观」的具体映射表需 UX 冻结（旧 4 主题值枚举需从现 UI 确认）；②最近连接生成规则（上限、去重粒度、是否含 local 会话）决定欢迎页内容真实性；③凭据引用检查改变 delete_identity 现行为（现在总能删）——对 MCP/CLI 是否可见需确认（CLI 有无 delete_identity 入口）。

### 待决点

- DF8.1 ui.v2 形态：单键 JSON blob（`ui.v2.workspace` 整存整取，原子性好、并发写互踩）vs 分键（粒度细、无事务包裹）。建议 blob + schemaVersion 字段，冻结时确认。
- DF8.2 收藏/最近落点：hosts 表加列 vs 独立 host_metadata 表（建议独立表，hosts 表已有两列未用垃圾不扩散）。
- DF8.3 旧主题枚举与映射表：现 UI 的主题值全集（App.tsx 确认）→ 新 `ui.v2.appearance` + 终端配色组合。
- DF8.4 delete_identity 引用检查的行为与错误码（现 InvalidInput 语义复用 or 新 RefExists）；CLI/MCP 暴露面确认。
- DF8.5 最近连接生成：来源（sessions 表 closed/connected 状态过滤）、条数、local 会话是否计入。

## 跨契约备注（一句话级，展开归连接方向文档）

- 传输作废/接管边界（transfer() generation 单检）与 C9 停用收敛规则有交集——停用时运行中传输按 OutcomeUnknown 规则处理的要求（主文 C9）需与 DF5.1 注册表设计联审。
- Error 枚举为封闭枚举（session-api:678-719，注释「新增走 ADR」）——C4–C6 新错误码（ShellIntegrationUnavailable 属连接方向；此处如 ConflictDetected/OutcomeUnknown 相关）全部要走同一 ADR 流程。

## 待决点汇总（R03 冻结清单，本方向共 23 项）

| # | 一句话 | 建议优先级 |
|---|---|---|
| DF6.1 | SFTP 临时文件 + 发布序列与降级链 | 高（可行性硬点） |
| DF6.2 | Agent 传输冲突缺省策略与 MCP schema | 高 |
| DF5.1 | 传输注册表全局 vs 会话级 | 高 |
| DF5.2 | 提交前恢复资料持久化载体 | 高 |
| DF7.1 | unsupported 分级标准（阻断/警告/忽略清单） | 高 |
| DF4.1 | DirEntryS v2 wire 形态与兼容窗口 | 中 |
| DF5.3 | transfer_event 粗/细粒度 | 中 |
| DF7.3 | 导入端去重与覆盖 wire | 中 |
| DF8.1 | ui.v2 blob vs 分键 | 中 |
| DF8.2 | 收藏/最近存储落点 | 中 |
| DF4.4 | request generation 层级 | 中 |
| DF6.3 | 预检后复检粒度 | 中 |
| DF6.4 | 同目标锁键定义 | 中 |
| DF7.2 | Include 跟随策略 | 中 |
| DF8.3 | 旧主题映射表 | 中（UX 输入） |
| DF4.2/4.3 | resolve_path 协议与 symlink 策略 | 中 |
| DF5.5 | cancel 幂等语义 | 低 |
| DF6.5 | 部分文件清理责任 | 低 |
| DF7.4/7.5 | 手工表单通道 / username 兜底 | 低 |
| DF8.4/8.5 | 凭据引用错误码 / 最近生成规则 | 低 |
