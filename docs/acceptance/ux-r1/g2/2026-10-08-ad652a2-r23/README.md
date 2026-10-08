# UX-R1 G2 · R23 连接/关闭/退出 UI 状态机集成 —— 验收证据

基线：ad652a2（R22）。日期：2026-10-08。

## 任务面

- **C1 消费**：`begin_connection` → attempt 注册表面（attempt_id/phase），real 端 `connection-event`（transformCallback 内部通道）+ demo 端 300ms `connection_status` 轮询双路结算（settleAttempt）；waitForAttempt 等待器 + attemptFinalRef 终态先到缓冲（事件先于 waiter 不丢）。
- **§280 保持**：connectingIds 由 attempts 派生（真相在 attempts），一主机在途他主机连接钮/卡片/光标不受扰。
- **§6.2 相位呈示**：phaseText 映射 Connecting→连接中…/TrustRequired→等待指纹确认/Authenticating→认证中…/else→等待验证码（不猜测）；§302 门挂起期卡上取消入口。
- **取消三分支**：Cancelled→已取消 toast+卡复位；AlreadyReady→核心已关会话（refreshLists+说明 toast）；CancelCloseFailed→会话保留（connError 引导从标签关闭）——无隐藏连接。
- **§6.3 完成落焦**：gen 代际 + `!document.hidden` + **`document.hasFocus()`（窗口前台）** + gatesBusy（按 host_id，R21-L6 勘误闭环）四条件全过才 attach+focus；否则 toast「已连接 X——点击标签进入」。真实失焦（他应用激活）只查 document.hidden 挡不住——r23a 首轮原生实证抓出后补 hasFocus。
- **门队列调和（真 bug 修复）**：旧码 `setHostKeyQueue((q)=>(q.length?q:list))` 只增不减——核心侧作废的门（取消/超时）遮罩永存。新 reconcileQueues 以核心权威 pending 列表双向调和 + gateDecidedRef 5s 防应答在途回弹。
- **§6.4 关闭契约**：入口统一「关闭会话」，确认框影响行只呈示可查证事实（转发数可查 confirmImpact ? N 条/无 ： 状态未知；任务/传输状态未知如实）；**关闭成功才 dispose**，失败保留标签/画面/重试入口。
- **退出契约**：Rust `CloseRequested` → prevent_close + emit `app-close-requested` → FE 退出摘要（活动会话 N 个（主机名…），转发 M 条 + 任务未知如实）→ 取消=prevent_close 已生效原地留用；结束会话并退出=全关 + `quit_app`（app.exit(0)）。驱动侧 osascript AXCloseButton 真实窗口关闭 ×2 + 进程零残留核验。
- **前置清单闭环**：R21-L6 gatesBusy 按 host_id（wire PendingAuthPrompt 补 host_id?）；R22 前置清单欢迎页添加主机清 editingHost/prefillEntry（不再劫持编辑模式）。
- **R19 回归网（rev-r19 前置清单）**：window_double_cancel_second_is_not_found_single_close / mid_connect_cancel_end_to_end_chain（事件含 Cancelled 且无 Ready——跃迁相位契约，非精确序列断言）/ window_concurrent_double_cancel_single_settlement（tokio::join 恰一 AlreadyReady）/ v1_record_failure_sweeps_half_session（force_record_fail hook + 半会话清扫，旧码必红）。

## e2e

- **demo 探针**（真实 Chromium + vite demo 后端 :5183，r23-demo-probe.js）：**16/16**。首轮 15/16（A3 相位推进断言超时——归因本轮 App.tsx HMR 热替换竞态，改动面（完成分支条件）与 A3（门相位呈示）无涉）；复跑两轮 **16/16**。覆盖：A 相位呈示+卡上取消+核心裁决；B 全链前台完成落焦；C gatesBusy host_id（他主机门挂起中 prod-1 完成不切视图+点击标签进入 toast+门应答后前台 attach）；D 关闭契约（两标签两会话+确认框影响行+成功移除）；E 欢迎页添加主机全新表单；F §280 不受扰；Z 零 JS 错误。
- **原生冒烟**（真 sshd vault + 隔离 DB + 口令 env，GUI tinyssh-app，beacon 协同）：**r23a/r23b 两轮全链 DONE 零 FAIL**（beacon-r23a.txt / beacon-r23b.txt）。链：相位呈示（等待指纹确认+卡上取消）→ 真实信任建连 attach（驱动先激活窗口）→ TOFU 取消→Cancelled+list_sessions 无隐藏会话 → **真实失焦**（驱动 osascript 激活 Finder 夺焦，document.hasFocus()===false 实证）→ gatesbusy 段（§280 他主机可点+r23-a 后台完成压制+toast）→ 信任 r23-b 完成不抢视图（失焦代际）→ 点标签进入 → 关闭契约（对话框文案+标签移除）→ 欢迎页 recents（r23-a/r23-b 在列）→ 退出：真窗口关闭 #1 → 摘要框（退出 TinySSH/活动会话/转发/结束会话并退出）→ 取消 → 真窗口关闭 #2 → 结束会话并退出 → 进程退出零残留（DRIVER|app-exited-clean）。
- **workspace**：146/0（c1_tests 18 含回归网 4 项）。

## 执行插曲（如实）

1. r23a 首轮 `FAIL-gatesbusy-switch`：脚本断言设计缺陷——r23-a 本就是活动标签（A2 attach 过），压制生效时视图理应原地不动；判别器改为 toast（压制分支标记）。
2. r23a 二轮 `FAIL-attach-a`：**真契约缺口**——§6.3「窗口在前台」实现只查 document.hidden；nohup 启动窗口无焦点，attach 被如实压制。补 `document.hasFocus()` 条件（createSession/reconnectSession 双路）。
3. r23a 二轮 `FAIL-blur-not-delivered`：首轮 blur-delivered 系假阳性（窗口从未激活，hasFocus 本就 false）；驱动补两步——启动后激活窗口（等价用户点进 app）+ blur-wait 标记后激活 Finder 夺焦。
4. r23a 三轮 `FAIL-recents:null`：gatesbusy 段压制的后台会话（r23-a #2）也渲染标签，E 段只关一个标签欢迎页不出；改循环全关。

## 取向登记

- 门遮罩决策钮（拒绝并取消）= 拒绝语义退出 attempt；卡上「取消」= 中性取消——两者语义分立。
- AlreadyReady 语义 = 核心已建会话且已随之关闭（R19 已实证），UI 只解释不留会话。
- 退出摘要对话框仅原生可达（app-close-requested 是 Tauri 窗口事件，demo 无此路径）——demo 探针不主张，原生 r23a/b 实证。
- demo close_session 实现为 Closed 语义（splice 会话行，§342 对齐真实核心）→ reconnect_session 在 demo 面不可达，重连入口消费归 R26。
- hasFocus 压制与 gen 压制并存：gen 管「期间焦点转移」（应用内导航/浮层/blur 沿），hasFocus 管「完成时窗口是否前台」——互补不冗余。

## 独立审核与视觉复验

### rev-r23（独立代码审核）：**可签**（0 高 0 中 8 低）

复跑：demo 探针 16/16（:5183 当前工作树）、workspace 146 与主张吻合（core-session 37/37 ×4 轮、vault 29/29、tsc 0）、beacon r23a/b 全链零 FAIL 判读成立。契约逐项核对通过（取消三分支对 core lib.rs:430-469/547-627、demo close 移除对核心 close_session remove、退出 ExitRequested 无绕回）。

处置台账：
- **L1 已修**：createSession 无操作三元 `phase: a.phase === "Ready" ? "Ready" : a.phase` → `settleAttempt(a)`（纯化简）。
- **L6 已修**：本 README mid_connect 主张措辞对齐测试断言（含 Cancelled 且无 Ready，非精确序列）。
- **L2 登记**：connection-event 先于 begin 应答的极窄竞态——settleAttempt 首行 host_id="" 覆写 attemptHostRef 瞬态失派生；核心合并同 attempt、waiter 单槽，自愈无数据破坏。
- **L3 登记**：gateDecidedRef 5s 窗——answer invoke 在途超 5s 门遮罩短暂回弹，落定后自消。
- **L4 登记 → 后续轮**：macOS Cmd+Q（ExitRequested）不经退出摘要直接退出；§340 首版契约只钉主窗口关闭路径。
- **L5 登记 → 传输轮**：§342 退出「持久化传输恢复记录」无查询面（无 list_transfers），文案如实标未知未越界。
- **L7 登记**：demo.ts TERMINAL 后冗余 Ready 条件；App.tsx 旧 only-grow 初始化 effect 与对账并存冗余。
- **L8 flake 登记（非本 diff 引入）**：c1 failed_attempt_carries_error_and_audit 时序窗（R24 已登记同窗）+ vault c8_favorites 同毫秒平局（R19 已登记）。

L1 处置后回归：tsc 0 + demo 探针 16/16（复验轮）。

### vis-r23（独立视觉复验）：**视觉可签**

双树（基线 worktree ad652a2 :5184 / 当前 :5183）逐像素：欢迎页、设置弹窗、A1 态 diff_px=0（噪声底连拍自差=0）；添加表单 diff_px=50 判 AA 噪声非回归（判定链四步：基线重拍自差 0 / outerHTML+rect+computed style 逐字符全同 / git diff 不含该钮 / JS click 无 hover 跨树 diff_px=0）。新增面盒测量：关闭确认框 400×176.5 居中、四子元素零相交零截断、影响行文案正确（高度差恰=影响行一行，预期 delta）；门挂起卡 w224 相位文本两行不截断+取消钮间距 4px 零相交、w280 单行+4px 零相交——R21 280px flex 叠印前科无复发；取消钮活体点击可用。全程零 JS 错误。N/A 登记：退出摘要对话框原生专属（app-close-requested），web 不主张，原生 r23a/b 覆盖。证据：vis/（base/+cur/+vis-r23-diff.txt 判定链+vis-r23-driverreport.json 盒数字）。
