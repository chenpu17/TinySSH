# UX-R1 G3 · R32 核心传输注册表、进度、查询和事件（C5）—— 验收证据

基线：70ef172（R30）。日期：2026-10-09。

## 任务面

「核心传输注册表、进度、查询和事件 | deps R03 | 实现 C5」（§547/§560/§6.5；交付注记：UI 重挂可对账、事件 revision、提交前日志与提交未知恢复、不统一把重启项当失败）。本轮增量：

1. **契约面（session-api）**：`TransferStatus` 九态全量（Queued/Running/Committing/Succeeded/Failed/Cancelled/Cancelling/AwaitingDecision/OutcomeUnknown；R32 产生子集，Committing/AwaitingDecision/OutcomeUnknown 为 R33/R34 前向占位，`is_terminal` 判定 OutcomeUnknown=终态）+ `TransferTask{id,session_id,kind,source,dest,status,bytes_done,total:Option,revision,created_at,finished_at:Option,error:Option,retry_of:Option}`（§560 数据面；total 未知为 None 不伪造 §352；source/dest 与方向绑定）+ 新 trait 方法 `list_transfers`（全量快照创建倒序、任何 Actor 可查）+ wire 格式锁定测试（PascalCase status 与既有 UI 卡一致、前向状态可反序列化）。
2. **传输面（ChannelHandle trait）**：`upload`/`download` 增加 `progress: &(dyn Fn(u64, Option<u64>) + Send + Sync)` 参数——数据阶段周期回调（done/total 可未知），实现不依赖回调时序；transport-ssh（upload=本地文件 metadata、download=`sftp.metadata`）与 transport-pty（copy_file）逐块回调。
3. **journal（vault）**：`transfer_journal_insert/update/load_active/list`（V5 表 R15 已建，本轮消费）；state 列存 wire PascalCase、kind 列小写（schema CHECK），`journal_row_to_task` 单点映射；活动阶段面 = Queued/Running/Committing/Cancelling/AwaitingDecision；c5_transfer_journal_roundtrip 回环测试（终态退出恢复面/列映射/缺失行更新报错/创建倒序）。
4. **注册表（core-session）**：`SessionManager.transfers: HashMap<TransferId, TransferRegEntry{task,cancel,last_emit,last_journal}>` + `transfer_tx: broadcast(128)` + `transfer_register/apply/finish` 辅助（状态变化即时发帧、纯进度合并 ≥200ms≈5 次/秒/任务、journal 状态变化必写/纯进度 ≥1s）；`transfer()` 重写：**创建先注册（Queued 即注册表/journal/事件可见）再开始读写** → gen void=Cancelled「接管作废」不虚构字节 → Running → 通道 progress 闭包 → 终态 Succeeded/Cancelled「已取消」/Failed 真实错误文本（审计键 transfer_done/transfer_failed/transfer_voided 沿袭 + 新增 transfer_cancel 留痕）；`cancel_transfer` 改注册表寻址（终态幂等 Ok、未知 id 报错、Cancelling 先可见再置 token）；`list_transfers` 实现；**重启恢复**：`open()` 读 journal 活动行统一落 Failed「应用重启时传输中断」进注册表（本轮无提交阶段；Committing/OutcomeUnknown 处置随 R33/R34 启用——取向登记）。
5. **MCP**：`transfer_list` 只读工具（Agent 查询面：upload/download 返回 transfer_id 后对账状态与字节数，不靠猜）。
6. **tauri**：`list_transfers` 命令 + `transfer-event` 窗口转发（镜像 session-state 桥模式）+ r32 三阶段冒烟脚本。
7. **FE（App.tsx/wire/bridge）**：`TransferTask`/`TransferStatus` wire 类型 + `list_transfers` 桥命令；**审计猜测轮询移除**（旧 800ms audit_query 匹配 transfer_done/failed 文案 =「完成/取消不靠审计猜测」违例）改为：真实环境 `transfer-event` 事件即时推送 + 挂载时 `list_transfers` 全量对账（id+revision 幂等），demo 800ms 轮询 `list_transfers` 双路镜像（session-state 同工艺）；卡片状态机扩 queued/cancelling + 进度呈现「传输中… X KB / N MB」；pending- 占位卡保留至真实 handle 换 id。
8. **demo**：传输注册表模拟（创建即注册 → 150ms 分片推进 → Succeeded/Failed/Cancelled；fail-demo 文件名失败注入；cancel → Cancelling → 下一片 Cancelled；list_transfers/cancel_transfer 契约与核心一致含 unknown-id 报错）——旧「演示模式不提供真实 SFTP 传输」throw 移除（该 throw 正是旧码判别面）。

## 关键设计事实

- **事件可丢、查询是权威**（§547）：transfer_tx 为可丢 broadcast；UI 以 list_transfers 全量对账兜底（挂载时 + demo 轮询）；revision 单调（每 transfer_apply +1，从 1 起）支持 id+revision 幂等合并。
- **进度合并是设计行为**：状态变化即时发帧；纯进度 ≥200ms 才发事件、≥1s 才落 journal——r32_running_progress_frames 测试以 250ms 分片验证中间帧可见（40ms 分片全部被合并吞掉是预期）。
- **接管/关闭路径零改动**：SessionHandle.transfers（会话级 cancel 索引）沿用（take_control 逐个 cancel、close 拆通道），注册表挂同一 token 的观察面；传输循环返回 Cancelled/通道错误 → 注册表终态落账。
- **R32 无提交阶段**：数据传完即 Succeeded（§6.5「100% 字节只代表数据传完，不能代替提交完成」的 Committing 语义随 R33/R34 启用，枚举/表列/恢复面均已前向就位）。

## e2e

- **demo 探针**（真实 Chromium + vite :5183，r32-demo-probe.js）：**22/22 ×3 连续独立轮**（probe-run1/2/3.txt；run3=rev-r32 中-1 处置后复验）。A 契约 11（list 初始空/handle 形状/**创建先注册**（handle 返回即 Queued 可查）/**终态字节全量+finished_at+revision 单调**/fail-demo 注入 Failed/download kind/取消三段（Cancelling 即现→Cancelled 已取消→终态幂等）/unknown-id invalid_input/注册表全量持有/revision 跨采样单调）；B UI 7（卡片在面板可见/完成·N.N MB/失败：演示注入/已取消/**进行中卡「传输中/排队中」**/取消钮存在/面板收敛终态）；Z 零 JS 错。
- **旧码判别力实证**（基线 ddd9d60 worktree :5184，r32-oldcode-probe.js，oldcode-probe.txt）：**6/6 判别红**——list_transfers 命令不存在（shim 抛错）、upload/download 拒绝（「演示模式不提供真实 SFTP 传输」）、cancel_transfer 静默 no-op（旧「占位反馈」伪影同案）、UI 零传输卡能力。
- **原生冒烟**（release 二进制 + 隔离 DB + 口令 env + beacon + 真机 sshd 容器；驱动 r32-driver.sh 三阶段：r32a 主链 → r32b 400MB 在途 ≥4MB 打标后 kill -9 → r32c 同库同口令重启恢复）：**锁屏发现与处置见「执行插曲」§1**。
- **cargo 真机 e2e**（TINYSSH_E2E_SSHD=1，共享容器）：**7/7**（R30 面全绿 + 既有传输三测〔上传/下载/取消〕在新 progress 签名下真机通过）。
- **workspace**：**164/0**（全量干净复跑；+6 core-session r32_tests +1 vault c5_roundtrip；另 vault c8 并行偶发一例单跑+复跑全绿判登记 flake 家族）。tsc 0。
- **vis**：r32-vis.js **8/8**（vis-run.txt + vis-artifacts/）——welcome 双树（当前 vs 70ef172 :5186，统一深色）diff=0（容差=每通道 ≤8 滤 AA、通过线允许 max(噪声底,3)；终轮归档 PNG 字节级相同）；四态卡盒测量（进行中卡「传输中… 576.0 KB / 3.5 MB」进度文本实渲染、sub/name 零截断、取消钮 35×28 elementFromPoint 真命中、行高 60px 一致）；面板零横向溢出；640 窄窗卡渲染不破版；零 JS 错。

## 执行插曲（如实）

1. **锁屏中断与发现**：原生冒烟首轮契约面 9 项全过（registered/upload/remote-write/download/failed/progress-seen=39714816/cancel/cancel-unknown-ok）后 UI 阶段静默冻结——排查确认 **loginwindow 主窗口=「登录」（屏幕已锁）**，WKWebView 冻结页面 JS（tinyssh-e2e-needs-unlocked-screen 纪律同源）；驱动补 lock_state 闸（锁屏即明确退出并指引重跑）+ wait_mark 超时信息改 stderr（原 `>/dev/null` 吞超时消息致首轮误读为即时失败）。**待解锁后重跑 ×2 归档 beacon**。
2. **驱动遗漏 beacon.py**：首轮 exit「PHASE1 FAILED: beacon tail 无文件」——r30 工艺文件未随目录复制；补齐后契约面即通。
3. **journal 列映射错位**（r32_tests 抓出）：journal_row_to_task state 列索引写 6（实为 5），load_active 静默 Err 被恢复面 `Err(_) => {}` 吞成空表——修正列序；恢复面吞错保留（journal 不可读不炸启动）但测试断言使空表不可通过。
4. **初始 revision 0**：注册首帧 revision 从 1 起的契约由测试锁定（transfer() 初值修正）。
5. **OutcomeUnknown 终态性**：is_terminal=true（无后续自动迁移）但属恢复面（「提交结果未知」处置归 R33/R34）——wire 测试单独断言，不与 Committing/AwaitingDecision 的「非终态」同列。
6. **trait impl 边界**：transfer() 历史上在 `impl SessionManager`（非 trait impl）——新增 list_transfers 首次落在 inherent 块致 E0046，挪入 trait impl 修正（helpers 保持 inherent）。
7. **stub 签名 perl 误伤**：批量补 progress 参数时第二参数（_remote/_local）被吞、r32_tests 抓出 E0050；恢复。e2e 调用点同批补 `&|_,_|{}`。
8. **vault c8 并行偶发**：全量首轮 c8_favorites 一红，单跑即过+全量复跑零红——判并行负载 flake（R19/R24/R23/R25/R30 已登记同族）。

## 取向登记

- **FE 前向状态呈现口径**（rev-r32 低-3）：taskToCard 未消费 wire.transferTerminal——OutcomeUnknown（R32 不产生）会呈现为 running 卡带活取消钮（点击幂等 Ok 卡不动，无害）；Committing/AwaitingDecision 的卡片语义归 R33/R34 提交轮一并回收。
- **Committing/OutcomeUnknown 处置面未实现**：枚举/journal 状态机/恢复面查询已前向就位；「提交结果未知」重启恢复分支归 R33/R34（本轮统一 Failed「应用重启时传输中断」对提交前中断成立）。
- **demo 域重挂对账不可达**：demo 传输为页面内存域（与页面同生命周期），reload 即清——「UI 重挂可对账」的真实面由原生 r32c（journal 跨进程恢复）承担，demo 探针不主张。
- **注册表进程生命周期上限未设**：长会话千级任务内存可承受（TransferTask ~300B）；journal 是持久面、UI list_transfers 全量返回——上限/分页留待真实压力（登记）。
- **audit transfer_cancel 以 Human 记名**：cancel_transfer 入口未分辨 Actor（UI 面仅 Human 可达；MCP 无 cancel 工具）——后续若开 Agent 取消入口需补 ctx 透传。
- **事件通道不区分任务订阅**：全量广播（128 深度），MCP 侧不订阅（轮询 transfer_list 对账）；通道级过滤沿用 R19-M2 裁定。
- **demo 传输节奏为模拟值**（150ms/片）；真实节奏核心策略 = 原生冒烟 progress-seen 实测（39.7MB 在途快照）。

## 独立审核与视觉复验

### vis-r32（独立视觉复验）：**视觉可签**（零反向，作者 8 项主张全部成立）

独立方法学（自写脚本 /tmp/vis-r32/，未照抄作者）：welcome 双树 1280 严格容差 **0 px**（首跑 strict=8/噪声=8 复跑 0——跨实例栅格化 AA 噪声族同 R27/R30 登记；作者归档三张 welcome PNG 字节级相同）+ **640 双树 6 散点逐像素定位目检全落细描边字形/圆角 AA 边零结构差异**；四态卡行高 60×4 一致、零截断、取消钮 35×28 真命中、失败文本完整、**面板本体 280px 及文档级溢出 0**（补测作者只测 .sftp-list/.section）；**queued「排队中…」与 cancelling「取消中…」真实渲染抓捕成功**（错峰多开+DOM 15–20ms 高频采样，作者 vis 未触及；cancelling 窗 <150ms DOM 实证 PNG 落终态，时序局限登记）；进度实时性三帧跨轮询边界与 list_transfers bytes_done 精确对账（384.0KB=393216B）；640 窄窗零截断零溢出钮命中；全程 pageerror=0（含 30+ 重试 invoke 压力）。登记观察（非阻塞）：跨实例 AA 亚像素散点、toast 短暂遮盖底卡（两树同、设计内）、143 字符长文件名 ellipsis 优雅降级。

### rev-r32（独立代码审核）：**处置后可签**（初判 1 中 4 低；中项与低-1/低-2/低-4 已修，低-3 登记）

独立实证：diff 实读 16+1 文件；并发/锁纪律核查通过（registry 临界区短无跨 await 持锁、锁序恒 transfers→vault.conn 单向、cancel/finish 竞窗 is_terminal 守卫、takeover gen→Cancelled「接管作废」落账、事件锁外发）；复跑 workspace 164/0（两轮零 flake；164−7 sshd_e2e 门控跳过=157 实际执行=README 口径）+ tsc 0 + demo 探针 22/22 + 旧码判别 6/6 + 自设反证探针 11/11（并发 5 任务无串写/created_at 倒序/demo 取消留字节/终态后新任务不丢卡/Queued 窗取消不假成功/零 JS 错）。README 对账：**无过度主张**。

- **中-1（已修+复验）**：`transfer_finish` 非 Succeeded 终态无条件覆写 bytes_done=0——取消 39.7MB 在途后注册表/journal/MCP 对账面全读 0（与恢复路径「不抹账」纪律相悖，权威面对账拿到错数据）。修=仅 Succeeded 覆写字节（cancel/failed 保留在途进度）；r32_cancel/r32_failed 两测试补「部分字节保留」断言（初版断言时序不严被测试自身抓回：取消先于任何 progress 时字节本就 0，改为等 bytes>0 再取消）；tauri 冒烟 A7 断言同步强化（终态 bytes≥1MB）。
- **低-1（已修）**：r32_tests 恒真断言（is_none()||is_some()）改 `assert_eq!(row.total, None)` 锁定「创建时 total 未知」。
- **低-2（已修）**：取消竞窗毛刺——spawn 侧 Running 置位改仅 Queued→翻转（Cancelling 已置时不回跳；终态本就正确）。
- **低-3（登记，R33/R34 回收）**：FE taskToCard 未用 transferTerminal——OutcomeUnknown 前向状态会呈现为 running 卡带活取消钮（点取消幂等 Ok 卡不动）；R32 不产生该状态，提交语义轮次回收。
- **低-4（部分修+登记）**：demo list_transfers slice(0,50) 与核心全量不一致——已改全量；demo 多发 transfer_start 审计键（核心无）为演示域留痕细节，登记。

## 证据清单

- `r32-demo-probe.js` — demo 探针（22 断言；A 契约 11/B UI 7/杂 4）
- `probe-run1.txt` / `probe-run2.txt` — 当前树 22/22 ×2
- `r32-oldcode-probe.js` + `oldcode-probe.txt` — 基线 ddd9d60 判别力（6/6 红）
- `r32-driver.sh` — 原生三阶段驱动（r32a/r32b/r32c；锁屏闸）
- `r32-vis.js` + `vis-run.txt` + `vis-artifacts/` — 视觉复验（8/8；welcome 双树 + 四态卡盒测量 + 640 窄窗截图）
- `rev-r32-probe.js` + `rev-r32-r3.js` — rev-r32 自设反证探针（11/11 活体）
- `vis-r32-artifacts/` — vis-r32 独立复验脚本与截图（queued/cancelling 实捕 + 640 双树散点裁剪目检）
- `probe-run3.txt` — 中-1 处置后复验 22/22
- （待补）`beacon-r32a/b/c.txt` — 原生冒烟 ×2（等屏幕解锁）
