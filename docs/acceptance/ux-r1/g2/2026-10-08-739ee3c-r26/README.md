# UX-R1 G2 · R26 网络中断/有限重试/重确认/手动重连 —— 验收证据

基线：739ee3c（R25）。日期：2026-10-08。

## 任务面

§6.4 断线/重连契约全量。存量（R25 已就位）：dead-overlay 旧画面可选中复制（§330）、Disconnected 输入拦截、关闭失败保标签、Reconfirming 基础横幅。本轮增量：

1. **session-state 事件面（core）**：`SessionStateEvent {session_id, state, attempt, max_attempts, detail}`（session-api 新类型）+ ApprovalCenter `state_tx` broadcast + tauri `session-state` 转发——断线/重连/重确认即时推送，免 3s 列表轮询盲窗。
2. **自动重连可见化（core）**：`on_transport_reconnect` 全程发射（Degraded → Reconnecting{attempt≤3} → Reconfirming | Disconnected）；重试分片睡眠（8×250ms）使停止等待 ≤250ms；`retry_stop` 旗标 + `stop_auto_reconnect`（Human 面方法，不进 SessionApi/MCP；审计 `session_reconnect_stop`）——「显示实际重试次数，可停止重试」（§6.4）。
3. **connect 阶段有界超时（transport-ssh）**：`russh::client::connect` 包 10s 超时——docker 等端口代理在容器死后仍接受 TCP（无 RST），banner 等待可挂任意久，「有限重试」退化为单次悬挂；认证阶段不在窗内（2FA 等人应答不能限时）。
4. **FE 横幅组**：Degraded/Reconnecting →「⛔ 网络中断——自动重连中（第 N/3 次）+[停止重试]」；Disconnected →「⛔ 会话已断开……+[重连恢复]」（顶部短状态条提供重连，与 dead-overlay 双入口）；Reconfirming 文案按契约更正为「已重连；旧现场待核实——你可以继续操作」，owner=Agent 时补「Agent 已暂停（普通变更仍受限）」（旧文案「普通操作暂停，仅允许只读核实命令」违反 §6.4 人类可继续操作，一并修正）。
5. **输入不排队（§6.4）**：拦截条件从 Disconnected 扩到 Degraded/Reconnecting（通道死亡写必错，不排队给未来连接）——终端 onData ⚠ 告示、Ctrl 控制字符、⌥Meta 序列、命令框 Enter、SIGINT 钮五处同口径；命令框 placeholder 分态。
6. **R24-L5 指引**：命令框 exec 拒绝 `shell_integration_unavailable` 时终端补两行——「可在设置开启集成；或 CLI/MCP 显式 Fresh」（恒 Shell 模式无 UI Fresh 入口，不假装有）。
7. **§6.4 关闭已断开标签**：不询问断开确认直接移除（R23 既有路径，本轮回归网断言）。
8. **R23 沿袭闭环**：demo reconnect 可达——`demo_drop_session {recoverOnAttempt}` 断线模拟链（Degraded→3×Reconnecting→Reconfirming|Disconnected，节奏 400/700/350ms 对齐 300ms 轮询采样）+ demo `stop_auto_reconnect`/`session_state_feed`（C1 双路镜像：真实事件/demo 300ms 轮询）+ demo 集成关闭主机 `noint-1`（不注入审计 + exec 拒绝 available 载荷对齐核心形状）。

## e2e

- **demo 探针**（真实 Chromium + vite demo :5183，r26-demo-probe.js）：处置前 **21/21 ×2**；rev 处置后 **22/22 ×2**（增 B0 手动横幅判别）。A 自动重连计数横幅（max=3 全计程）→耗尽 dead-overlay+tab title 已断开+真键盘键入拦截（⚠ 且 'zz' 零入缓冲）；B 手动重连（B0 横幅分流判别）→Reconfirming 横幅（契约原文+Agent 暂停后缀）+真键盘键入直达；C 自动重连成功路径（计数至 2 后成功）+停止重试（首计后点停→提前 Disconnected，maxAfterStop=1）；D 断开标签直关（无确认框，标签 2→1，会话移除）；E 集成关闭主机（无注入审计+命令框 Shell 拒绝+Fresh 两行指引，noint 会话缓冲逐字）；Z 零 JS 错误。
- **原生冒烟**（真 sshd 容器 127.0.0.1:2222 + 隔离 DB + 口令 env，驱动 docker stop/start 协同）：**r26c 终轮（处置后构建）全链 DONE 零 FAIL 零 JS-ERROR/REJECT**。链：r26-a 建连 → 驱动停容器 → 自动重连计数横幅（第 2/3→3/3 原生实测）→ 耗尽 Disconnected + dead-overlay → 命令框拦截（connError「会话已断开/未发送」）→ 驱动启容器 → 手动重连 → Reconfirming 横幅 → 命令框 `echo post26ok` 直达远端（重确认期人类可操作）→ r26-b（集成显式关）命令框 Shell 拒绝 + Fresh 指引两行 → 再停容器 → 「停止重试」提前落 Disconnected → 断开标签直关无确认 → DONE。前置轮：r26a 前十一腿全绿、末腿 `.tab-close` 选择器笔误（探针 bug 非产品）；r26b 全链 DONE（处置前构建）；两轮日志均归档。进程零残留（pgrep 无 tinyssh-app）+ 容器还原。
- **workspace**：**151/0**（+5 r26_tests：自动重连事件全序列/停止旗标短路+审计/手动失败保 Disconnected/手动成功入 Reconfirming（B 标记放行不等满窗）/local 重连不注入；手装 handle+Stub 通道工艺）。tsc 0。
- **核心契约修复（发现于 r26_tests/冒烟）**：事件期望序修正（local/手动成功路径也发 Reconnecting{1,3}——每尝试前发射，次数数据面同源）；测试订阅先于动作（broadcast 只投订阅后事件）。

## 执行插曲（如实）

1. **connect 悬挂真缺陷**：首两轮冒烟自动重连卡死在单次 attempt——docker 停容器后其端口代理仍接受 TCP，russh banner 等待无超时挂 40s+。「有限重试」契约要求 attempt 有界 → transport-ssh connect 阶段 10s 超时（认证阶段除外）。修复后原生计数节奏 ≈10s/attempt、耗尽 ≈35s 内。
2. 原生冒烟三处驱动/脚本迭代：停止重试窗口 4s→12s（点击可落在 10s 连接相内，Disconnected 最迟 ≈10.3s）；重确认后键入证据从合成终端键入改命令框（合成 keydown 不触发 xterm onData——真键入证据归 demo 真键盘，原生只主张命令框路径）；`.tab-x` 类名勘误。
3. demo 探针四处工艺：种子库已有 prod-1 会话，探针新建重复会话致 drop 打在后台旧会话（横幅按设计只跟焦点会话）——drop 一律定位活动会话 sid；断言全部改按 sid 定界（first-match 会命中种子会话）；命令框 Enter 用合成 keydown（headless 焦点不稳，trusted 按键丢失）；E 段先等 `.tab-active` 落 noint 再发命令。
4. r26_tests 三处测试自身修正（非产品）：drain 数期望（成功路径 2 事件非 4）、停止测试订阅时序（watcher 订阅迟到漏首个事件→改主任务先订阅再跑重连）、local 断言（Reconnecting 前置事件存在）。

## 取向登记

- **重连边界标记**：Reconfirming 横幅即「新连接边界」的用户可见呈示；核心侧 reset_scene（残留 block 强制收尾/集成标记计数重置/cwd 事实降级）已由 R24 覆盖。不在滚动缓冲插入视觉分隔线（避免与终端内容混淆）。
- **Reconfirming 标签态文字**：「重确认（受限）」→「重确认」——受限的是 Agent 变更，人类可继续操作，标签不再误示人类受限。
- **输入拦截覆盖 Degraded/Reconnecting**：§6.4「禁止将输入排队留给未来连接」的 FE 面——断线重建期（通道死亡）与已断开同口径拦截。
- **事件通道裁定（R19-M2 闭环）**：connection-event/session-state/shell-integration-event 为 Human GUI 专属（tauri 窗口 emit），MCP 不订阅——通道级隔离即跨域过滤裁定；若未来 Agent 域需订阅，须事件载荷携带域再过滤（现在登记，不预留）。
- **R24-L2/L3 处置**：FE 零消费 IntegrationState 字段（漂移面零暴露）；集成能力呈示走错误载荷 available（E3）与 shell_capability 查询（R24 已有），不读一次性判定字段。
- **原生证据边界**：终端 onData 键入拦截与重确认期真键入=demo 真键盘（合成 keydown 不触发 xterm onData）；原生主张命令框路径（合成 keydown 可达应用级 handler）。
- §342 退出时传输恢复记录：传输子系统 G3/R32 范围，N/A 登记。
- demo 自动重连节奏为模拟值（400/700/350ms）；真实节奏由核心策略决定（原生实测 ≈10s/attempt，含 connect 超时上界）。

## 独立审核与视觉复验

### rev-r26（独立代码审核）：**终裁可签**（处置复验 10/10；初判处置后可签：0 高 1 中 6 低）

实读全部改动面 + r26_tests 判别力核验 + 独立判别探针（/tmp/rev-r26-probe.js 15/16 + probe2 聚焦版；R1 FAIL 为探针焦点错位非产品）：Reconnecting 期单行/多行粘贴零字节+⚠ 告示；Reconfirming 期粘贴/命令框人类直达+横幅契约原文含 Agent 暂停后缀；双会话并发计数 sid 归属不串台、终态无残留横幅；断开标签直关无确认；零 JS 错误。cargo test -p core-session 63/0（r26 5/5 对旧码必红判别成立）、tsc 0；retry_stop 生命周期核实（周期/手动入口复位，残留方向安全）。

- **中-1（真缺陷）已修**：手动重连冒用自动横幅——核心手动循环发同形 Reconnecting{N,3} 事件，FE 横幅一律呈示「自动重连中+停止重试」，但手动循环不读 retry_stop：点停止 toast 声称已停而循环照常（最坏 3×11s），假确认。**修 = FE 分流**（App.tsx 横幅块）：`reconnecting === current.id`（手动期）横幅独立呈示「⏳ 手动重连中——{host}（最多 3 次尝试）」无停止钮；停止钮只对真自动重连在位。demo `reconnect_session` mock 同步改异步镜像核心（Reconnecting 事件 + 800ms 完成窗，invoke 完成才算成功）。**判别探针 B0**：手动窗内断言横幅含「手动重连中」且不含「停止重试」——旧码该断言必红（只出自动+停止钮）。
- **低-5 已修**：⌘V 粘贴不查断线态——确认框照弹（确认后字节仍被 onData 拦）误导；putPaste 前置 inputBlockedState 检查，⚠「粘贴未发送」与 onData 告示同口径。
- **低-1 登记**：connect 10s 超时只包 TCP/banner；auth 有界=审批门 120s、PTY/shell 请求段无界——自动重连遇 2FA 时停止要等门解决才生效（§6.4 attempt 有界精神的剩余缺口，归传输加固轮）。
- **低-2/低-3 登记**：tauri 转发 Lagged 静默丢（计数可停旧值，3s 轮询兜底+横幅状态门控自愈）；refreshLists 整组替换 ms 窗可回滚事件补丁（既有模式，≤3s 自愈）。
- **低-4 登记**：demo stop_auto_reconnect 对非重连会话无条件落 Disconnected（核心为旗标 no-op）——demo 专属分歧，UI 探针不可达。
- **低-6 登记**：B12 重连面（ssh+集成关）仅 local 单测+代码核实，ssh-off 重连无自动化断言。

处置后回归：demo 探针 **22/22 ×2** 连续轮（含 B0 新判别）+ tsc 0 + ui/dist 重建 + release 重建（touch build.rs 强制资产重嵌）+ 原生 **r26c 全链 DONE 零 FAIL 零 JS-ERROR/REJECT**（真 sshd 全链：计数耗尽/命令框拦截/手动重连→Reconfirming/post26ok 直达/Fresh 指引/停止重试提前断开/断开标签直关）+ 进程零残留 + 容器还原。**rev-r26 处置复验终裁：可签**——修法实读成立（分流键=FE 自持 reconnecting sid 与事件形态解耦）、判别力核实（B0 窗旧码必红）、独立复验探针 /tmp/rev-r26-recheck.js 10/10（S1 自动路径无回归/S2 手动窗 9 帧采样零帧含停止钮/S3 Reconnecting 期单行+多行 ⌘V 零字节/S4 Reconfirming 期直达/S5 零 JS 错误）、核心 diff 与初审一致（retry_stop/CONNECT_PHASE_TIMEOUT 原样）、tsc 0 复跑；低-1/2/3/4/6 登记认可。

### vis-r26（独立视觉复验）：**视觉可签**（零回归零缺陷）

双树（基线 739ee3c worktree :5184 / 当前 :5183）逐像素：welcome/hostlist、addform、settings 三面 diff 全部锁定在 hostbar 侧栏 x18–204——R26 demo 种子新主机 noint-1 卡片插入（意图内，DOM 卡片序核对 base 6 卡 vs cur 7 卡仅多 noint-1）；表单/设置弹窗/welcome 主区零 diff，连拍自差噪声底 = 0。新面盒测量（DOM 实测）：自动重连横幅 1054×38 span 952px 无截断、停止重试 72×29 零相交且 elementFromPoint 真命中、计数「第 1/3 次」在位；Disconnected 顶条 + dead-banner 纵向间隙 128px 零相交零叠印（R21/R25 叠印前科无复发）；Reconfirming warn 条 1054×26.3 全文一行无截断（含「Agent 已暂停（普通变更仍受限）」后缀）；tab dot err/dim/ok 全对账；停止重试真实 mouse.click → 提前 Disconnected + toast；长名主机（52 字符）+640px 窄窗横幅 414×38 不破版、tab 220px ellipsis 无溢出；placeholder 四态在位；danger 三 token（--danger-soft/--danger/--danger-ring）探针归一化全等；全程零 JS 错误。取向登记：横幅文案不含主机名（长名截断风险转移至 tab/命令框 placeholder，均实测无溢出）。证据：vis/（base/cur 截图 + r26-vis-summary.json + 两份原始测量 JSON），基线 worktree /tmp/vis-r26-base 保留。
