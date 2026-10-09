# R35 队列抽屉、失败重试、批量文件与目录限制（G3 五/五）

基线：`e29df10`（R34 完成提交）。本轮 = R35「队列抽屉、失败重试、批量文件与目录限制」
（FE/Core，deps R33/R34）。验收依据 `docs/ux/ssh-client-ux-refactor.md` §194/§226(S08)/
§358/§364/§366/§374；交付排程 `ssh-client-ux-refactor-delivery.md` R35 行。

## 本轮范围

| 面 | 内容 |
| --- | --- |
| 并发闸 §366 | 每会话并行 2、窗口全局 4；其余保持 `Queued` 排队。闸在**同目标锁之前**获取（排队不占锁）。**先会话后全局**：全局许可只发给已持会话槽、即将开跑的任务，避免「全局许可被卡在会话槽上的任务白占」的队首阻塞。排队中取消/交接即时响应。 |
| 重试 §364 | `retry_transfer` 创建**新任务**（`retry_of`=旧 id），重新校验连接/源文件/冲突；不承诺断点续传；不自动重试已授权覆盖。仅 `Failed/Cancelled/Skipped/Interrupted` 可重试；`Running/Queued/Committing/AwaitingDecision` 等一律 `InvalidTransferState`。 |
| OutcomeUnknown §374 | 通用重试**硬拒绝**（`InvalidTransferState`）；界面提供「重新核实」与「查看目标」（核对目标当前状态——下载访达显示/上传开目标目录；明确「仅目标存在不能证明本任务成功」），**绝不把通用重试作为默认动作**。 |
| 目录限制 | 源侧判别（`ns_stat`）：上传源=本地、下载源=远端；`is_dir` → `Failed`「目录传输不支持：仅支持单文件（目录请先打包）」，零 staging。NotFound 同在此如实失败（优于后续含糊 IO 文案）。 |
| 队列抽屉 §194/§226/§358/§176 | 传输卡从文件面板移入**工作区底部抽屉**；状态条「传输 N」按钮开关。**后台事件只更新计数，不自动展开**；抽屉高 240、上限工作区 45%（§176）。每行显示方向/名称/**主机（会话）**/状态/完整 源→目标——§358 要求展示「主机/会话」，而抽屉是**窗口级**（`list_transfers` 全量、跨会话），会话不再由所在面板隐含，故按 `sid` 回查主机名（会话已不在时回退短 id，如实不虚构）。按状态给出操作：取消 ✕（在途/排队/提交中/待决）、重试（失败/取消/跳过/中断，**且原会话仍在**——否则改给「会话已不在」说明而非死按钮）、定位（完成下载=访达显示；完成上传=文件面板开目标目录）、**重新核实 + 查看目标**（仅 unknown，§374）。 |
| 按路径入口 §246 | 「按路径下载」保留，移入文件面板工具行开关（`sftp-by-path-btn`），不再常驻。 |
| 批量 | 批量上传（R33 原生多选）、批量下载「下载所选 (N)」（R31）沿用；本轮的「限制」=目录明确不支持 + 并行上限。 |

## 实现

### 契约/核心（session-api / core-session）

- `crates/session-api/src/lib.rs`：trait `retry_transfer(ctx, task_id) -> Result<TransferHandle>`。
- `crates/core-session/src/handle.rs`：`SessionHandle.xfer_gate_session: Arc<Semaphore>`；
  `TRANSFER_PER_SESSION = 2`、`TRANSFER_GLOBAL = 4`。
- `crates/core-session/src/lib.rs`：
  - `SessionManager.xfer_gate_global: Arc<Semaphore>(4)`（进程级窗口闸）。
  - `transfer()` 增 `retry_of` 形参；spawn 体：gen 复检 → **会话闸**（`select!` 取消）→
    **全局闸**（`select!` 取消）→ 闸后 gen 复检 → **源侧目录/NotFound 判别**（`ns_stat`，按
    `is_upload` 分流命名空间）→ `stage_plan` → 同目标锁（锁内 gen 复检）→ 预检/数据/发布/收尾。
    闸与锁均为 RAII guard（每条 return 路径自动释放）。
  - 新增 `SessionManager::retry_transfer`（固有）：校验状态 → 还原 `(local, remote, is_upload)`
    → 以 `Some(task_id)` 重新走 `transfer()`；审计 `transfer_retry`。
- `src-tauri/src/main.rs`：命令 `retry_transfer`、`reveal_path`（`open -R --`，不存在则
  `SftpPathNotFound`），注册进 `invoke_handler`。

### 前端（ui）

- `App.tsx`：`queueOpen`/`byPathOpen` 状态；状态条 `传输 N ⌄` 开关（`sb-transfer`）；
  底部抽屉（`queue-drawer`/`queue-collapse`）；行内 主机 chip（`.xfer-host`，§358）+ 取消/重试/
  定位/重新核实/**查看目标**（`xfer-view-target`，§374，unknown 态）；
  `hostLabel(sid)`（sessions 回查主机名，缺则短 id）；`canRetry(t)`（非 `pending-` 且 `sid`
  仍在 `sessions` 内）——`failed/cancelled/skipped/interrupted` 仅在有会话时给「重试」，
  否则给 `xfer-retry-unavailable`「会话已不在」说明（rev-r35 中-1：不渲染必然失败的死按钮）；
  `retryTransfer`
  （`invalid_transfer_state` → toast「结果未知请先重新核实」）、`locateTransfer`
  （下载=reveal_path；上传=当前会话则开文件面板导航，否则如实 toast）；文件面板工具行
  「按路径下载」开关（`sftp-by-path-btn`）承载原常驻输入行；面板标题 `文件与传输`→`文件`
  （传输已移入抽屉，rev-r35 低-3）；`TransferCard.sid`。
- `adapter/bridge.ts`：`retry_transfer`、`reveal_path` 命令映射。
- `demo.ts`：演示域同款 4/2 闸（`demoTransferSlotHolders`/`demoLaunchTransferSteps`，**同步首次
  尝试**=有槽即刻 Running）；`retry_transfer`（unknown 结构化拒绝、新任务 `retry_of`）；
  `reveal_path`（no-op，真实面=原生 `open -R`）；`dir-demo` 目录标记 → 如实失败。
- `styles.css`：`.queue-drawer/.queue-head/.queue-title/.queue-body/.xfer-note`；
  抽屉高度按 §176 取 `height: 240px; max-height: 45%`（`.main` 为 `flex:1` 定高容器，
  百分比可解析），`.queue-body` 配 `flex:1; min-height:0` 在定高内滚动（rev-r35 低-7）。

### 附带修复（越本轮范围，如实登记）

`crates/vault/src/lib.rs` 测试 `c8_favorites_recents_identity_refs_and_cascade` 是**先于本轮
存在**的偶发红（vault 源在本轮前零改动；本轮首次全量 `cargo test --workspace` 才暴露）：
`record_session` 用 `now_ms()`，连续四写常落同一毫秒，而 `list_recent_hosts` 的
`ORDER BY last_at DESC` 对并列无确定序。实测**修前 12 连跑红 2 次**（`h-8f9b650-…` vs
`h-a61fa35e-…`）。修法=仅测试内显式钉死 s-1..s-4 的 `created_at`（1000/2000/3000/4000），
**生产 SQL 未动**；**修后 25 连跑 0 红**。此项非 R35 功能，登记以供审核判定去留。

## 证据

### 单元（core-session，`--lib`）

`r35_tests`（10 项）：
- `r35_session_parallel_limit_and_queue`——同会话 3 任务：2 在途、第 3 Queued，放行后全成功
  **且 `bytes_done == T`**（G3 退出「文件结果不能只观察 UI 标签」：排队放行者真传满字节）。
- `r35_global_parallel_limit`——三会话 A×2/B×2/C×1：全局 4 在途、第 5 Queued，放行后全成功
  **且字节满**。
- `r35_queued_task_does_not_starve_global`——会话 A 排 3（2 在途+1 排队）、B 排 2：全局 4 全
  用于在途（A×2+B×2），排队任务不占全局，放行后全部成功且字节满。**红侧实证**：反转为
  global-first → 仅 3 在途即红。
- `r35_retry_creates_new_task`——失败 → 重试产新 id、`retry_of` 指向旧、旧行不改写；运行期切
  失败开关证「先败后成」=真正重跑。
- `r35_retry_revalidates_source`——源消失后重试以「源文件不存在」如实失败（重新校验）。
- `r35_retry_rechecks_collision`——重试重新预检冲突 → 再次决策卡（不自动沿用旧决定）。
- `r35_retry_refuses_outcome_unknown`——unknown 重试 → `InvalidTransferState`，零新任务。
- `r35_retry_refuses_running`——在途任务重试 → `InvalidTransferState`。
- `r35_directory_upload_rejected` / `r35_directory_download_rejected`——本地目录/远端目录源 →
  `Failed` + 目录文案，零字节。

`cargo test -p core-session --lib` = **78 passed**（r35 10 + r34 17 + r32 6 + 其余 45）。
（独立审核期的 `rev_r35_scratch` 探针模块——13 项，审核工件、不入提交——另计，已从本数剔除。）
**既有用例适配（夹具，生产语义未变）**：R35 源侧判别（源须存在且非目录）落在数据阶段之前，
故 `r32_tests`/`r34_tests` 的固定源路径相应补真实落盘（本地源）与 mock stat 登记（远端源，
下载走 `channel.stat_entry`）；`r34_same_target_serialized` 的 t3 由「不同目标可独立 Running」
改为「每会话第 3 位排队」——同目标串行与 R35 并发闸叠加自洽（断言文案同步如实化）。
`cargo test --workspace` = **32 个测试二进制全 `ok`、0 FAILED**（含 core_local 13、vault 31、
session-api 9 等；`workspace-tests.txt`）。
`cargo test -p transport-ssh --test sshd_e2e` = **7/7**（真机 sshd 容器 127.0.0.1:2222）。

### demo e2e（`r35-demo-probe.js`）

**34/34 ×3**（`probe-run1/2/3.txt`）。节次：A 抽屉只经用户展开（后台事件只更新计数，A2/A3）；
B 失败重试创建新任务（B3 `retry_of`；**B4 行显示主机/会话** `prod-1`，§358）；C unknown 无通用
重试、仅重新核实 + **查看目标**（C2/C2b/C3 结构化拒绝、零新任务）；D 完成下载显示定位
（D2/D3 点击无 JS 错）；E 按路径开关（E1/E2/E3）；F 目录明确不支持（F1/F1b 零字节）；
G 并发上限（G1 每会话 ≤2、G2 溢出排队、G3 排队中…文案、G4 全部最终完成）；
**H 原会话已不在**（H1 会话在时失败卡有重试钮 → 关会话 → H2 会话确已移除 → H3 卡面改
「会话已不在」说明、不再渲染必死重试钮，rev-r35 中-1）；Z 零 pageerror。

**H3 门判别力红侧**：摘掉 `canRetry` 的 `sessions.some((s) => s.id === t.sid)` 条件 → 仅 H3
独红（33/34）；`Edit` 摘行后 `cmp` 还原，App.tsx md5 与摘行前一致，复跑 34/34。

### 旧码判别（`oldcode-run.txt`）

基线 `e29df10` worktree（`/private/tmp/r35-old`，dev :5184）：**15/34 ×2**（`oldcode-run.txt`）。
19 项 R35 专属断言红：A2/A4/A5 抽屉、B2/B3/B3c 重试、**B4 主机/会话**、**C2b 查看目标**、
C3 重试命令、D2 定位、E1/E2 按路径开关、F1/F1b 目录、G1/G2 并发闸、G3 排队文案、
**H1/H3 重试门**。R32/R34 基线行为（A1/A3/A6/B1/C1/C2/D1/D3/E3/G4/H2/Z）保持绿。

> 注：**G3 在旧码上非确定**——旧码无闸，5 个不同目标并发全部立即 `Running`，「排队中」态
> 只在时序巧合下出现（本轮两次连跑均红；另一次历史运行 15/31 中 G3 绿）。新码由并发闸
> 保证 G3 必现（34/34 多轮稳定）。判别力成立。

### 回归（`reg-*.txt`）

传输卡移入底部抽屉是本轮 UI 重构（§194），故 R34/R32 探针加「打开抽屉」前置（`r34-regress.js`/
`r32-regress.js`，仅此一处 + R32 B1 标签如实化），语义断言不变：
- R34（打开抽屉后）**35/35**；R32 **22/22**；R33 **36/36**；R31 **48/48**；竞态 **6/6**。

### 视觉复验（vis-r35）

**初判：不可签**（1 中阻断 + 3 低）。独立 Playwright 实测（自有脚本/截图 `/tmp/vis-r35/`，
未采信作者数字）：

- **中-1（阻断）** 深色主题多处 `--dim` 正文低于 AA：行「源→目标」行 **3.01:1**、行状态行
  **3.01:1**、抽屉头「N 个任务」**3.41:1**、空态 `side-quiet` **3.41:1**（浅色同元素
  5.25–5.69 全通过）。与 R34 已定性修复的同类一致（`.xfer-note`/`.xfer-conflict` 改
  `--text-sub` 达 6.53）。
- **低-1** 状态条「传输/转发」钮静止态深色 3.41:1（先于 R35 存在，R35 传输钮继承）。
- **低-2** 状态条钮悬停深 **1.83:1** / 浅 3.37:1——通用 `button:not(:disabled):hover`
  （特异度 0,2,1）压过 `.sb-btn:hover`（0,2,0），文字落 `--accent-hover` 底近乎不可读
  （先于 R35 存在）。
- **低-3** toast 瞬态叠压抽屉末行（全局组件，非 R35）。
- 通过面（40+ 断言零 FAIL）：布局/盒测量（1280×800 / 900×700 / 640×600 + zoom 1.25/1.5/2）、
  状态→动作逐态 DOM 断言、键盘全链（focus-visible 环 + 无焦点陷阱）、后台事件不自动展开、
  定位三分支（下载/当前会话上传/跨会话上传）、终端节点跨开/合不重挂。

**处置（本轮）**：M1 四元素 + 低-1/低-2 全部由 `--dim` 改 `--text-sub`——依据 `styles.css:786`
既有约定「`--dim` 只用于真正的辅助装饰信息」+ R34 先例（信息性正文用次级文字色保 AA）。
- `styles.css`：`.xfer-sub` 增 `color: var(--text-sub)`（覆盖 行状态行 + 源→目标行 + 转发状态行）；
  新增 `.queue-count { color: var(--text-sub) }`；`.side-quiet` `--dim`→`--text-sub`；
  `.sb-btn` `--dim`→`--text-sub`；`.sb-btn:hover` → `button.sb-btn:not(:disabled):hover`
  （特异度 0,3,1 > 0,2,1，恢复作者原意的 panel2 悬停底）。
- `App.tsx`：抽屉头计数 `className="dim"` → `"queue-count"`；四处 `"dim mono xfer-sub"`
  → `"mono xfer-sub"`。
- 低-3 登记为非 R35 全局项（toast 组件，非本轮引入）。
- **处置后回归**：demo 探针 34/34；R34 35/35、R32 22/22、R33 36/36、R31 48/48、竞态 6/6
  （改色不动类名/行为，探针语义不变）；`tsc` 0。

**二轮处置（rev-r35 低-3/低-7 + §176）**：面板标题 `文件与传输`→`文件`；抽屉高度改
`height:240px; max-height:45%`（+ `.queue-body` `flex:1; min-height:0`）。作者实测（自有脚本
`/tmp/r35-selfcheck/drawer.js`、`cap.js`，仅供参考）：240px @ 1440×900/1280×800/1024×768/
960×600（占工作区 28.0/31.7/33.1/43.2%，均 ≤45%）；短窗上限精确生效 45.0%
（1280×520→214、×460→187、×400→160）；8 任务时 `.queue-body` client 199 / scroll 646。

**复验（vis-r35 二轮定向复验）：可签**（零新增缺陷）。独立重取 md5 与作者一致
（`App.tsx` `471c85fa…`、`styles.css` `aa0285d4…`）；自有脚本实测：抽屉 **46/47 PASS**——
240px @ 1440×900/1280×800/1024×768/960×600/1920×1080（占工作区
28.0/31.7/33.1/43.2/23.2%，均 ≤45%），短窗上限**精确 45.0%**
（1280×520→214.2 / ×460→187.2 / ×400→160.2），末行可达（`.queue-body` scrollHeight 726 >
client 199），zoom 1.25/1.5/2 均在视口内；**唯一 FAIL = 1280×400（termH=0）低于 tauri
`minHeight=600` 出货下限，声明越界**。标题「文件」PASS（单行、header 40px、12px/700 与
其他面板一致）。`xfer-retry-unavailable` **3/3**（对比度浅 6.97 / 深 6.53）。
回归：layout 15/15、states2 4/4、kb4 6/7（该 FAIL 为时序假红，另以 `kbcancel.js` 复证 2/2）、
locate 3/3、term 同节点不重挂、background-event 4/4。登记一项观察（**非缺陷**）：固定 240px
在仅 1 行时留 ~139px 尾部空白——稳定、可接受。


## 独立审核

**rev-r35（首轮）：不可签**（1 中 + 8 低）。唯一阻断=**树红**：工作树缺 session-first 闸顺序
（当时为 global-first，`r35_queued_task_does_not_starve_global` 红）而 README 已按
session-first 描述，树与文档不符；另发现审核期作者并行操作曾用 `cp` 整文件写回覆盖过该修复。
中-1：`retry_transfer` 对 `Interrupted` 的界面呈现（会话已不在时仍渲染必然失败的重试钮）。

**处置**：闸顺序已恢复 session-first（现 md5 `dfda3824…`，`cargo test -p core-session --lib`
= 78/0，含 `r35_queued_task_does_not_starve_global`）；中-1 由 FE `canRetry` 门处置（见「实现」）；
低-3/低-6/低-7 已修（见「实现」「视觉复验」）；低-2/低-5/低-8 显式登记为已知限制
（demo 重试镜像不重校验源/冲突——探针未覆盖故无假绿；闸在同目标锁/待决期间持有；
`OutcomeUnknown` 专用分支与 catch-all 等价故判别力弱）。

**rev-r35（二轮复认）：可签**。阻断项已解并经其独立复验：`lib.rs` md5 `dfda3824…` 与其自有
隔离修复**逐字节一致**；闸序 session(2740)→global(2751)；`rev_r35_scratch` 已移除；
`cargo test -p core-session --lib` 78/0（含 `r35_queued_task_does_not_starve_global`）；
红侧实证（反转 global-first 时仅 3 在途即红）。中-1 的 `canRetry` 由其自有探针
（`/tmp/rev35-canretry3.mjs`，经真实 UI）正反两面独立实证：会话在 →
`{"retry":true,"unavail":false}`；关会话后 → `{"retry":false,"unavail":true,"text":"会话已不在"}`，
0 pageerror。低项逐条复验（`文件` 在 `App.tsx:3952`；`open -R --` 证明可终止选项解析；
抽屉数值与作者一致）。vault 改动可接受：diff 仅在 `mod tests`、生产 SQL 未动、其独立 20/20 全绿。
**独立复跑**：core-session 78/0、workspace 32 二进制全 ok / 0 FAILED、demo 探针 r35 **31/31**
（其取用的探针副本早于作者 H 节）、r34 35/35、r32 22/22、r33 36/36、r31 48/48、竞态 6/6。
**如实声明未跑**：`sshd_e2e` 7/7（需真机 sshd 容器）、旧码判别（需 :5184 worktree）。
**树对账**：其记录的 tracked diff md5 `c1bacd5e…`（11 文件 +506/-120）= 当前**代码面** diff
（`git diff -- . ':(exclude)docs'`）**逐字节一致**——审核后仅 `docs/ux/ux-r1-execution-status.md`
有 +3/-2 文档改动，代码面零变动。
**rev-r35（补充复核，维持可签）**：就排队放行者的字节断言复核 `r35_tests.rs` md5 `33ff6f8a…`
（mtime 13:02:39）、`lib.rs` 未动、tracked diff 未变；追溯 `bytes_done` 为通道真实返回值、
仅在 `Succeeded` 写入（`transfer_apply` 内 `if status == TransferStatus::Succeeded` 守卫、
赋值 `t.bytes_done = bytes`，`lib.rs:2321-2322`；来源 `transfer_finish(&tid2, Succeeded,
staged_bytes, None)`，`lib.rs:3044`），且断言非空（目录拒绝用例断言 0）；
`r35_tests::` 10 项 ×3 全绿。（H 节所验的 `canRetry` 正反两面另由其上述自有探针独立实证，
非作者独证。）

**vis-r35（首轮）：不可签**（1 中阻断 + 3 低，见「视觉复验」）。
**vis-r35（二轮定向复验）：可签**（零新增缺陷；结论与数值见「视觉复验」末段）。
