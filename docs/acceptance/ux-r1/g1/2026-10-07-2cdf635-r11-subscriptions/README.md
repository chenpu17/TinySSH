# R11 TerminalRegistry 与订阅生命周期（C10 全链路）——交付与验收证据

> 日期：2026-10-07 · 代码基线：`2cdf635`（工作区交付态）· 依赖：R03 契约 + 签署 C10 勘误（水位包含末事件、丢弃 seq ≤ 水位、attach/resync/unsubscribe 绑定 subscription_id、复用既有 alacritty Term/VTE）
> 任务定义：交付文档 G1 表 R11——「TerminalRegistry 与订阅生命周期：按 session 单实例，明确 subscribe/unsubscribe/resync；覆盖 C10」
> 验收依据：C10 水位顺序断言 + DF10.1–DF10.5 + B11（snapshot/stream 边界高频输出无漏字/重复、resync 正确恢复）

## 交付面

| 模块 | 内容 |
|---|---|
| `crates/session-api/src/lib.rs` | C10 wire 冻结类型：`ScreenCheckpoint/BufferCheckpoint/CellRun/ColorSpec/CursorState/ScreenModes`（DF10.4 双缓冲契约，`buffers:[主,备]`+`active_buffer`）、`AttachOutput{subscription_id,checkpoint,start_seq}`（DF10.2）、`ResyncOutput`（serde tag=kind snake_case：replayed/checkpointed，DF10.3）、`SeqFrame`、`DebugSubscriptions`（P6 测量口）；`OutputEvent::Raw` 增 `seq`（每 session 单调字节事件序号）；`subscribe_output` 移出 trait（桥层专用，签名含 broadcast receiver 非 trait 载体） |
| `crates/term-core/src/screen.rs` | `Screen::checkpoint()`：从既有 alacritty Term 导出属性网格（CellRun 串行化，宽字符 spacer 省略、零宽字符并入、行尾默认属性空格裁剪、命名色归一 Indexed(0-15)/None、真彩 Rgb、SGR 属性位集含双下划线/删除线/反显/隐藏）；光标（grid→viewport 换算、Hidden 形状→visible=false、样式 block/underline/beam）；模式（autowrap/app_cursor/bracketed_paste/origin）。`replay_fresh` 返回实际 feed 字节（回放并入线性化点）。单元测试 5 项（文本+光标、颜色属性、alt 屏+模式、历史包含、宽字符） |
| `crates/core-session/src/handle.rs` | SessionHandle 增：`output_seq`（仅临界区内推进）、`last_ckpt_seq`（「检查点更近」判定）、`replay: ReplayRing`（8 MiB/8192 帧淘汰环，`covers_from` 连续性判定）、`subs: HashMap<sub_id, watch::Sender<bool>>`（订阅注册表+取消信号）；线性化点 `feed_output()` + 闭包变体 `feed_output_fn()`（feed→seq→入环→广播同临界区；**一切屏幕写入经此**——含 run_fresh 的 replay_fresh 回放，rev-r11 发现 1 修复） |
| `crates/core-session/src/lib.rs` | `subscribe_output_channel()`（注册订阅+原子捕获 checkpoint/水位，锁序 screen→replay 与 pump 一致）、`unsubscribe_output()`（幂等 no-op；会话已关亦 Ok；触发 watch 取消终结桥 task）、`resync_output()`（绑定订阅身份；None→检查点；Some(f)→恰等水位空重放/(f,cur] 连续重放/淘汰·alt_screen·检查点更近→检查点；过期 sub 拒绝且不改状态）、`debug_subscriptions()`；c10_tests 7 项（水位包含末事件、重放与恰等不重放、过期拒绝不回落新订阅、淘汰/alt 屏退检查点、检查点更近、静默会话存活至显式退订、环淘汰语义） |
| `src-tauri/src/main.rs` | `subscribe_output` 返回 AttachOutput；桥 task 绑定订阅身份：Raw 帧=8B LE seq 头+原始字节（DF10.1），Resync/Lagged→`window.emit("resync",{session_id,from_seq,subscription_id})`，send 失败/Closed→兜底退订，select 取消信号→显式退订即终结转发；新增 `unsubscribe_output`/`resync_output`/`debug_subscriptions` 三命令；R11 e2e 探针注入分支（TINYSSH_SMOKE_MODE=r11） |
| `crates/cli/src/main.rs` | subscribe_output_channel 三元组适配（cli 只跟进实时流，忽略 checkpoint/取消信号） |
| `ui/src/terminal/checkpoint.ts`（新） | `applyCheckpoint`（xterm 状态重建：DECST 软复位→清屏+scrollback→主缓冲流式写（历史自然入 scrollback）→备用屏逐行定位写→模式恢复→光标定位/可见性/样式）、`parseSeqFrame`（8B LE 剥头）、`createOutputFeed`（订阅水位状态机：checkpoint 前暂存早到帧、应用后丢弃 seq≤start_seq 仅按序消费、缺口/溢出→resync 不静默丢字、每订阅一个恢复请求在途、重放无进展升级检查点请求、旧订阅事件按身份忽略、dispose 显式退订） |
| `ui/src/App.tsx` | ensureSessionTerm 改道 AttachOutput（先注册通道后 subscribe——注册起缓存 live，消除旧 read_screen+subscribe 两步竞态）；window "resync" 监听补挂（修复基线断链，按 session_id+subscription_id 路由）；disconnectSid 显式退订（主清理路径）；dev 门控 `__t_terms` 探针钩子 |
| `ui/src/adapter/wire.ts`/`bridge.ts` | C10 DTO + `CELL_FLAGS` 位集契约常量；CmdMap 增 unsubscribe_output/resync_output/debug_subscriptions（45 命令），subscribe_output 返回型 AttachOutput |
| `ui/src/demo.ts` | demo 后端同契约：会话级 seq+重放环+订阅集合；live 帧 8B LE 头；subscribe 返回合成检查点；resync_output（淘汰→checkpointed 同真实口径）；unsubscribe/debug_subscriptions；close_session 清空订阅 |

## 验收对照（B11 + DF10）

| 断言 | 证据 |
|---|---|
| 水位包含末事件、丢弃 seq ≤ 水位 | core 单测 attach_watermark_includes_last_event / resync_replay_and_exactly_at_watermark；term-core checkpoint 测试 |
| seq 恰等于水位不重放 | resync(Some(cur)) → 空 Replayed（单测） |
| attach 返回前输出不丢字 | FE：先注册通道后 subscribe，早到帧暂存（checkpoint.ts onMessage 未 ready 分支）；e2e attach 后 3000 行对账 missing=0 |
| B11 无漏字/重复 | [e2e-beacon.txt](e2e-beacon.txt) 运行 B：3000 行高频输出全缓冲对账 begin=1/end=1/missing=0/dup=0/resync=0 |
| alt_screen 重建 | e2e r11-alt：备用屏检查点 active_buffer=1 且含标记；term-core checkpoint_alt_screen_and_modes；FE 1049h+逐行定位写 |
| 旧订阅晚到事件/退订不影响新订阅 | 过期 sub resync 拒绝（单测+e2e sub-bogus 拒绝）；FE onResyncEvent 按身份忽略 |
| 静默会话清理后计数归零 | 单测 silent_session_sub_persists_until_explicit_unsubscribe（stub 通道恒死，订阅存活至显式退订/会话关闭）；e2e r11-unsub left=0+重复退订幂等 |
| 显式退订主路径 + send 失败兜底 | unsubscribe watch 取消终结桥 task；send 失败/Closed→api.unsubscribe（main.rs 桥 task） |
| resync 正确恢复 | e2e r11-resync 响应形状（checkpointed/end_seq）；FE 状态机重放应用/检查点替换/解码器重建 |
| P6 测量口径 | debug_subscriptions（e2e：active=1 → 退订后 0） |

## 边界与登记

- **独立复核（rev-r11，2026-10-07）：需修复后签 → 修复后达成可签条件**。发现与处置：①严重——run_fresh 的 replay_fresh 回放绕过线性化点（屏幕已变但 seq/环不动，resync 空重放且不可自愈）→ **已修**：replay_fresh 返回实际 feed 字节，run_fresh 改走 `feed_output_fn`（回放与传输字节同一 seq/环/广播机制，含单测既有断言不回归）；②中——parseSeqFrame 用 32 位运算在 seq≥2³¹ 时 ToInt32 变负、此后全部输出静默丢弃 → **已修**：纯算术拆分；③中——applyCheckpoint 未对齐 xterm 与检查点 cols，失配时网格换行错位 → **已修**：恢复前 `term.resize(ck.cols, ck.rows)`，恢复后由既有 fit/尺寸对账回用户视口；④中——resize 不占 seq/不入环（wire 无 resize 事件，契约固有），resize 后 resync 重放旧尺寸字节按新尺寸重演、与核心 reflow 分叉直至下次检查点 → **登记**（随 C10 后续修订记录；缓解：FE 尺寸对账 3s 内触发 resize，缺口场景罕见）；⑤低——overflow 死变量、disposed 后写入、宏死分支、注释笔误 → 已清/已修。
- **非活动缓冲空形（登记偏差，非静默回退）**：alacritty 0.26 对非活动缓冲无公开只读访问器，`swap_alt` 双向均有破坏性副作用（reset_region/光标覆盖），无法无损导出双缓冲。本实现导出**活动缓冲**全量属性网格 + 非活动缓冲按行数空形；wire 契约 `[BufferCheckpoint;2]`+`active_buffer` 原样保留（前端恢复路径完备，上游加访问器即可补齐）。基线 read_screen 投影同只覆盖活动缓冲——无回归；vim/top 重建走的正是活动（备用）缓冲。若需全量双缓冲，须上游访问器或 term-core 维护 inactive 镜像，超 R11 范围，建议随 C10 后续修订记录。
- **title 恒 None**：alacritty 0.26 Term 不持有标题（OSC 0/2 未入核心状态）；wire 字段前向兼容保留，OSC 标题由 FE `onTitleChange` 承担（既有）。
- **检查点更近语义**：attach 即捕获检查点——attach 后任何 from<start_seq 的 resync 按契约字面走检查点路径（单测钉住）；FE 正常运行期 from≥start_seq，走重放路径。
- **FE scrollback 上限**：xterm scrollback=5000 < 核心 grid scrollback=10000，检查点流式写超出部分不进 FE 历史（可视屏状态无损）；基线 read_screen 文本回放同受此限。
- **UNDERCURL/DOTTED/DASHED** 归一为单下划线（xterm 标准 SGR 无对应；DOUBLE_UNDERLINE 保留 SGR 21）。
- **e2e 环境**：`TINYSSH_MASTER_PASSPHRASE` + 全新 DB + local 会话（本机 shell）——本轮二进制重编译导致 macOS 钥匙串对 t40 主机密钥重新弹授权（需用户登录密码，前轮运行被阻塞两次，均已终止实例；遗留 SecurityAgent 弹窗留待用户处置）。R11 探针不依赖钥匙串；t40 真机容器的同路径验证由 R10 e2e（6c8d4b3 归档）与后续受控复测覆盖。
- **测试套件钥匙串阻塞与护栏（本轮发现并修复）**：`SessionManager::open → Vault::open → master_key` 在无 env 时落 OS 钥匙串；重编译后测试二进制（ad-hoc 签名变化）对既有 "TinySSH"/"master-key" 条目的 ACL 失效，`cargo test` 在 `SecKeychainFindGenericPassword` 上被授权弹窗阻塞（sample 实证：卡死测试进程栈顶即该调用）。**修复**：所有 `SessionManager::open` 测试调用点（core-session lib c10_tests/core_local/sshcfg_import、mcp-server protocol/e2e_acceptance）补 env 护栏——未导出 `TINYSSH_MASTER_KEY` 时测试内自设（vault 解析序 env > 钥匙串，沿用 vault 自身单测先例）；`cargo test` 全程零钥匙串依赖、零 env 要求，导出值仍可覆盖。core-session 无 env 全绿（15+13+2）+ workspace 全量复核见提交。
- 探针 v1 的 FAIL-flood 为探针自身缺陷（PTY 回显命令行含标记子串致双计），产品路径 missing=0/dup=0/resync=0 在两轮运行中均成立；v2 改整行匹配后全绿。
- **独立复核**：
  - **rev-r11 对抗审核**：发现 1 严重 3 中 5 低，全部处置（见「边界与登记」首条）后达标（符合性清单全数确认：水位/恰等不重放/过期拒绝不回落/单恢复请求在途/锁序单向/三端 wire 对齐/桥 task 三退出路径统一清理）。
  - **vis-r11 视觉复验**：主列表页 vs R10 基线逐像素 **diffBytes=0**；attach 终端内容（df -h 块/表格对齐/CJK）、几何 computed style（.xterm 763x585、行高 15px、courier-new 13px）、双主题、console 零错误全 PASS。回归 2 项均已修复并探针复验：R1 恢复发 DECSCUSR steady 变体致光标停闪 → 改 blink 变体（1/3/5），`options.cursorBlink` 实测恢复 true；R2 demo 合成检查点光标 y=rows-1 悬浮空白行 → 改最后非空行行尾（实测 y=3=提示符行）。证据 /tmp/vis-r11-shots/（15 图 + walk.js）。
  - 修复后交付态二进制复跑 e2e 全链路（见下「修复后复跑」）。
