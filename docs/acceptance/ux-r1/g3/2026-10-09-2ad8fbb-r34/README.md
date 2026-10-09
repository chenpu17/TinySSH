# R34 证据包：冲突、同目标并发、提交/取消仲裁与恢复（C6 实现；C13 故障注入）

基线 2ad8fbb（R33 修正提交）。日期 2026-10-09。

## 契约实现面
- **session-api**：TransferStatus +Skipped/Interrupted（终态）；CollisionDecision（skip/overwrite/keepboth 小写 wire）；DecisionPrompt{target_path,target_stat,reason}（reason=target_exists|stat_changed_since_preflight，原因可查落字段 C-04）；TransferTask +collision_decision/decision_prompt（serde default 兼容旧载荷）；Error +ConflictDetected/ReplaceUnsupported/StaleDecision/InvalidTransferState（wire_parts 四表）；trait +publish_hardlink→PublishOutcome 四值（Committed/Unsupported/Rejected/Ambiguous）+remove_file；upload/download +collision 参数；submit_collision_decision/reject_expired_decision/verify_transfer_outcome 三方法。wire 锁定测试（keepboth="keepboth" 等）。
- **DF6.1 能力矩阵冻结**：原子不覆盖发布=hardlink(temp→target)——远端 SFTP `hardlink@openssh.com`（init 声明探明，Ok(false)=未声明）；本地 std::fs::hard_link。覆盖发布需目标版本约束（CAS）——SFTP v3+OpenSSH 扩展与 macOS 原语均不提供 → **overwrite 一律 ReplaceUnsupported{capability:"target_version_constraint"} 阻止**，不双改名/bak/回滚（契约「无可靠原语一律阻止」）。
- **core-session**：canonical stage_plan（temp `.tinyssh-part-<tid>-<name>` 同目录）→ **同目标锁**（DF6.4，"r:"/"l:"+canonical path，持至终态，排队者保 Queued）→ **预检在数据阶段前**（冲突不传字节）→ temp 长度核对 → Committing → **复检**（存在+size+mtime；不一致=新冲突 reason=stat_changed_since_preflight，重裁决）→ publish → journal verified=true（证据先行 DF5.2）→ temp 清 → Succeeded；keepboth 发布名≠请求名时 **任务 dest 回写实际发布路径**（账实相符）。取消线性化点=publish 本身（提交窗口检查点+暂停窗后二次检查点）。Ambiguous→OutcomeUnknown（temp 保留、journal 保持 Committing/verified=false 编码驻留活动集）；仅 journal verified 证据可翻成功（大小/temp 消失单独不足）；不自动重发/覆盖/清理。决策：仅人类+AwaitingDecision+expect_revision 乐观锁（StaleDecision 带当前 revision）；rx 关闭→Cancelled（取消/作废两文案）。重启恢复分类：Committing+verified→Succeeded{verified}；Committing→OutcomeUnknown；其余活动行→Interrupted（R32 的 Failed 修正）；本地 temp 确未提交才清；远端 temp 登记不清。sftp_stat 放行 Agent（MCP 冲突预检面）+审计。
- **命名空间拆分（rev-r34 高-1 处置）**：上传计划路径=远端（通道 SFTP 语义）、下载计划路径=本地 canonical——本地 FS 操作一律不经通道。单语义源=session_api::local_stat_entry/local_publish_hardlink/local_remove_file；transport-pty 的 stat_entry/publish_hardlink/remove_file 委托同源（本地语义唯一实现）；core 经 ns_stat/ns_publish/ns_remove(is_upload) 按通路分流（7 处调用点：预检 stat/temp 核对/recheck/Rejected 后探查/发布/注入发布/temp 清理）。C13 丢响应注入仅上传通路（本地 syscall 完成即有确定结果，无「应答丢失」形态）。
- **fault.rs（C13 注入，QA 专用）**：TINYSSH_FAULT_DROP_LINK_RESPONSE=1（core 分离续跑 publish 请求——服务端真实提交、应答弃收→Ambiguous）；TINYSSH_FAULT_COMMIT_PAUSE=pre_publish|post_verified（90s 暂停窗；TINYSSH_FAULT_PAUSE_MS 单测可调）；fault_inject 审计落点。
- **vault**：journal 写 collision_decision+verified；update COALESCE 保形；load_active/get。
- **MCP**：upload/download +collision 参数（fail=预检 sftp_stat→ConflictDetected 结构化错误；skip/overwrite 直传）；wait_transfer_preflight 轮询≤4.5s 结构化返回；transfer_list（R32）。
- **FE**：冲突卡（目标路径/大小/时间/reason 前缀两态文案/三决策钮/覆盖钮能力注记 title）；unknown 卡（重新核实+「temp 与恢复资料保留；不自动重发」）；skipped/interrupted/committing 呈现；stale→toast+reject 留痕+刷新；待决/提交窗取消 ✕ 扩展。`.xfer-conflict` 文字用 --text-sub（dim 深档 3.01 不达 AA，修后深 6.53/浅 6.97）。
- **tauri**：submit_collision_decision/reject_expired_decision/verify_transfer_outcome 三命令（人类门）；**JS 层实参 camelCase（expectRevision）——expect_revision 会被 tauri 静默丢弃致 missing key（本轮真机抓出）**。

## 测试
- r34_tests 17 项（core-session 68/68，处置后终树复跑）：happy/三裁决/stale+状态守卫/keepboth 新名+dest 回写/overwrite 阻止/agent 三径+human 拒/复检竞态新冲突/publish 竞态 Rejected→重裁决/Rejected-absent 失败/publish 后取消幂等（Succeeded 胜）/待决取消/丢响应 OutcomeUnknown+复核保持未知/数据失败清 temp/同目标串行（锁+排队+冲突连贯）/重启恢复四分类+temp 清理边界/作废幂等/**r34_download_local_fs_namespace**（真本地 FS 三段：普通下载落盘真实文件+temp 清/预检读到真实本地 stat（512B 判别值，mock stat map 无此条目）→skip 后字节不变/keepboth 真实新名 `.tinyssh-1` 落盘+dest 回写；mock 通道 `ensure_remote` 命名空间严格守卫——`/local/` 前缀路径进通道即 panic。红侧对称性判别：临时把 ns_stat 下载分支改回通道调用 → 该测试红（temp 核对 NotFound），Edit 还原后 68/68）。
- vault 31/31（c5 扩展：collision roundtrip、verified 标志、get）；session-api 9/9。

## e2e 证据（本目录）
- `r34-demo-probe.js`（终树版）：35/35（probe-final2.txt = 高-1/文案/unknown-note 修复后终树复跑；独立复核 rev-r34 以同版探针复现 35/35）。run1/2/3/probe-final 为处置前过程轮（对应修订前树），留作过程记录。demo 注入标记：conflict-demo/recheck-demo/unknown-demo/interrupt-demo 目标名。
- `r34-oldcode-probe.js` + oldcode-run：基线 013dc58 :5184 **8/9 红**（OC1 conflict 待决/三决策命令不存在/unknown+interrupt 旧码落 Succeeded/UI 冲突卡与决策钮/新文案全缺席；OC1b PASS=有意记录旧行为「无决策直完」）。
- `r34-vis.js`（终树版）+ vis-run2：9/9（welcome 双树逐像素 0；冲突卡盒测量零溢出零重叠命中≥24；unknown 卡盒测量；终态行图标；双主题对比度 6.53/6.97；零 JS 错）+ **独立 vis-r34 全套**（runB3/runB4+vis-r34-b*.js：17 元素×双主题逐元素对比度、盒测量 1280/640×深浅+zoom 1.25/1.5、360 挤压对判基线一致、键盘全链 Tab 序/焦点环/Enter、十态真实渲染抓捕、节外回归逐像素 0）+ runFix.txt+vis-r34-fix.js（unknown-note 修复定向复验 7/7：深 6.53/浅 6.97、360 换行 4 行零叠印）。
- 回归（处置后终树）：R33 36/36（r33g.txt）、R32 22/22（r32g.txt）、R31 48/48（r31g.txt）、竞态 6/6（raceg.txt）；处置前轮 r33f/r32f/r31f/racef 同绿留档。
- workspace：ws-postfix.txt（高-1 处置后全量复跑全绿，core-session 68/68 含新测试；vault 31/31、session-api 9/9）；ws-final/ws-full 为处置前轮。tsc 0（unknown-note 修复后）。
- 真机：sshd_e2e 7/7 ×3（首轮 1 失败未捕获名，复跑 ×3 全绿判瞬态）；spike2 1/1。
- **原生冒烟（C13+真机 sshd 容器）** `r34-driver.sh` + smoke-run1/2/3/4.log + beacon-r34{a,b,c2,d2,e}.txt + tinyssh.db（run4 轮 journal 对账，WAL 已并档：download Skipped/Succeeded 两新例+OutcomeUnknown ×2+verified Succeeded+Cancelled 全在场）：run1/2=处置前树 ×2 全绿（主链上传五裁决/丢响应 OutcomeUnknown+容器实证 unk.txt 已提交 262144+temp 保留/r34c post_verified kill -9→重启 Succeeded{verified}/r34d pre_publish kill -9→重启 OutcomeUnknown（ux.txt 不存在+temp 保留）/r34e 暂停窗取消→Cancelled（cc.txt 不存在+temp 清））；**run3/4=处置后树 ×2 全绿**，r34a 增 SSH 下载经核心编排两例（新文件下载→Succeeded+宿主落盘 262144 对账；本地同名冲突→预检读真实本地 stat 512B→skip→原文件 md5 原样——rev-r34 高-1 要求的三例补齐）。执行插曲：driver 首跑即崩=多字节全角括号紧贴 `$EXIST_LOCAL_MD5` 致 bash 3.2 变量名合并（已登记工艺陷阱复发），`${}` 加固后复跑。
- mcp 真机 e2e：3/6 过（acceptance_scenario/create_session/journey5）；journey2/3/4 红=**基线 013dc58 同红**（ShellIntegrationUnavailable integration_present=false，容器 shell 集成域预存问题，非本轮引入；mcp-e2e-baseline-journey2.txt 判别证据）。

## 执行插曲（真缺陷与工艺）
1. **tauri JS 实参 camelCase**：App 传 expect_revision → 命令收不到（missing required key expectRevision）→ 决策点击静默失败。真机三级判别（el.click 不达→MouseEvent→直调命令面）抓出。bridge/demo/探针三端同步修。
2. **取消线性化缺口**：取消检查点只在暂停前——90s 暂停窗内取消会在暂停后继续 publish（「取消」后目标仍被写）。补暂停后二次检查点（线性化点=publish 本身）；r34e 原生实证。
3. **keepboth dest 不回写**：core 发布新名后任务 dest 仍指旧目标（demo 域曾以改名掩盖）。核心成功路径回写实际发布路径 + 测试锁定。
4. **vault c8_favorites flake**（预存家族）：本轮 workspace 首轮命中一次（recents 排序），单跑/复跑全绿；family 沿袭登记，非本轮引入（R32 已登记）。
5. 驱动三工艺：bash 3.2 多字节紧贴 `$var` 解析成新变量名（×$V2、中文括号）——`${}` 加固/回显 ASCII；函数前缀赋值不导出给 env 孙进程——export；已开面板二次点击=关闭——幂等开面板（ts-open 门）。app 窗口遮挡致 DOM 未渲染——启动后置前（r33 同款）。**陷阱复发**：新增下载对账行 `$EXIST_LOCAL_MD5` 后紧贴全角右括号，首跑即 unbound variable 崩溃——`${}` 修复后复跑。
6. `覆盖` 文案两域不一致（demo 自撰 vs core ReplaceUnsupported）——统一为 core 文案「发布能力不足，已阻止（原目标未改动）: target_version_constraint」。
7. **高-1 命名空间错位（rev-r34 真机实证，本轮最大缺陷）**：SSH 通路下载经 core 编排 100% 失败——temp 长度核对/预检/复检/发布/temp 清理对本地路径调用通道 stat_entry/publish_hardlink/remove_file（远端 SFTP 语义）→ 恒 NotFound → 一律 Failed「temp 长度核对不符」；同根因致下载预检失效（本地已有同名文件永不进 AwaitingDecision）——R33 已验收的下载能力回归。**全证据链为何不可见**：demo=内存域模拟、r34 单测 mock stat 上传下载对称（假对称）、原生冒烟脚本零 download 调用、sshd_e2e 直调 transport 层不经 core 编排——四层各有盲区，真机跨层组合才暴露。处置：命名空间拆分（契约面节）+ 单测真本地 FS+mock 严格守卫+红侧判别+冒烟补下载两例（本目录 smoke-run3/4）。
8. unknown 卡说明行 `.dim` 深色 3.01<AA（vis-r34 独立发现，同轮冲突块已修 text-sub 漏此行=轮内工艺不一致）——改 `xfer-note` 类（text-sub），定向复验 7/7 关闭。

## 独立审核处置
- **rev-r34**：初判不可签（1 高 1 中 5 低）→ **终审复认可签**（处置后终树独立复认，非采信通报）。高-1（SSH 下载命名空间错位，真机 100% 实证，见插曲 7）——处置=命名空间拆分+单测守卫+红侧判别（ns_stat 下载分支临时改回通道 → 新测试红 r34_tests.rs:374 → 还原 68/68）+冒烟 r34a 补 SSH 下载经核心编排两例（run3/4 全绿，三例要求=上传既有+下载+本地同名冲突）；**其复认真机三段 ALL PASS**（重建 scratch 探针直连容器 sshd：上传 Succeeded/下载新目录 Succeeded+内容对账+temp 清/本地同名 512B 判别→AwaitingDecision→skip 原样/keepboth 新名落盘+dest 回写——原高-1 失败签名完全消除）+ **红侧第四刀**（自己摘 ns 分流→新测试红且失败信息恰为原高-1 签名「temp 长度核对不符」→还原绿）；中-1（归档工件为修订前旧版）——处置=终树版全部重归档（probe-final2/r33g/r32g/r31g/raceg/ws-postfix/beacon ×5/driver/smoke-run3/4/vis 独立套+runFix），README 逐文件标注树状态；低-1 vault flake（预存家族）；低-2 审批卡文案（已修=能力如实措辞「将被能力阻止：传输不提供目标版本约束，原文件零改动」）；红侧累计四刀判别力成立（摘同目标锁/摘 verified 门槛/摘 expect_revision/摘 ns 分流各自即红，Edit 精确还原 diff 哈希逐次对账一致，终态树哈希 20de9d0e 与复认基线一致）；其独立复跑（处置后树）demo 35/35、R33 36/36、竞态 6/6、core-session 68/68、vault 31/31、tsc 0。
- **vis-r34**：终裁可签（处置后定向复验维持，原中低项关闭）。独立方法学：17 元素×双主题逐元素对比度、盒测量 1280/640×深浅+zoom 1.25/1.5+360 挤压基线对判、键盘全链（Tab 序/焦点环/Enter/Shift+Tab/不陷卡）、十态真实渲染抓捕（含 queued 25ms 监听/cancelling 中间态/reason 两态前缀）、节外回归逐像素 0、welcome 双树 6 组 0、零 pageerror。发现处置：unknown 卡说明行对比度（已修，见插曲 8）；低两项沿袭登记（见取向登记）。

## 取向登记
- **原生冒烟补档闸修正（R33/R32/R31 键序冒烟仍挂起）**：解锁判据不充分——ToDesk 远程桌面会话中 loginwindow 不在但用户正主动工作，键序型冒烟（System Events keystroke）会打进用户活动窗口（本轮 R33 补档首轮 FAIL-pick-no-upload 即此因，诊断截屏已即时删除不入证据）。补档需加空闲判据或等用户显式空闲；R34 自身冒烟为纯 DOM 注入不外溢，已完成 ×2 不受影响。
- 原生 UI 决策按钮点击路径在本轮冒烟未独立实证（以命令面直调对账核心行为；UI 点击路径=demo 域 35/35 已证+vis 复验）。同域先例：r32a UI 阶段冻结未归档。
- mcp e2e journey2/3/4 预存红（容器 shell 集成域）：归容器/环境轮处置，非传输域。
- 远端 temp 清理对 Interrupted/OutcomeUnknown 沿袭登记（需通道存活；重启后通道不在）。
- 注册表 target_locks map 不收缩（以不同路径数为上界）；同目标并发=排队 Queued+冲突连贯裁决。
- fault env 进程级全局——单测不设（会污染并行测试），注入窗由冒烟独立进程覆盖。
- demo 域 unknown 重核仅刷新（无绑定证据可合成）；真实面=原生 r34b/d。
- sftp_stat 放行 Agent：MCP fail 预检所需；审计 action="sftp_stat" 归因。
- 首轮 sshd_e2e 1 失败未捕获名（复跑 ×3 全绿）：瞬态判登记。
- （rev 低-3）submit_collision_decision 在 tx.send 失败竞窗下，任务已带 collision_decision=Some+revision+1 后才返回 StaleDecision——终态 Cancelled 可能带决策残留（装饰性，不影响状态机）。
- （rev 低-4）transfer_await_decision 的 decision_tx 设置晚于 transfer_apply 一临界区，与取消有理论竞窗（select! 立即收口，无假接受路径）。
- （rev 观察）摘除「复检」不被 r34_recheck_race_new_conflict 判别——publish_raced 回退路径同终态同 reason，复检为冗余防线非缺陷，保留。
- （vis 低）终态行文字容器 dim 深色 3.01:1（R32 已签容器，R34 新文案「已跳过/已中断」沿用；后续轮统一 text-sub）；⊘ 图标 3.01 vs 图形 3.0 门槛余量 0.007。
- （vis 观察）unknown 首行 error 文案 ellipsis 无 title 兜底（丢失段=冗余指引，同 R31 fwd-row 案）；committing「提交中…」demo 域不可达（demo 模拟无提交阶段），真实面=原生 r34c/r34e 暂停窗。
