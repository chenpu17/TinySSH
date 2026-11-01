# 下载覆盖轮：二次下载静默诊断 → 决策卡浮出 + 下载覆盖解冻（2026-10-30）

用户实测（mac）：「文件浏览中文件下载过一次以后，第二次下载就没有响应了？建议是提示用户是否覆盖这类的提醒，有时候覆盖是有价值的，毕竟文件可能更新了。」

## 诊断（静默的真实链路）

第二次下载并非无发起，而是走进了一个**用户看不见的阻塞态**：

1. 目标文件已存在 → 核心传输预检冲突（DF6.3 不白传字节）→ 人类任务进 `AwaitingDecision`，决策窗 300s（`DECISION_TTL`，core-session lib.rs）。
2. 跳过/覆盖/两个都要三颗裁决钮只渲染在**传输抽屉**（TransferQueueDrawer，条件挂载）里；抽屉关着就什么都不出现。R35 §194 的「后台事件只更新计数不自动展开」设计针对的是进度噪音，没给阻塞裁决留出口。
3. 状态条计数虽含 awaiting（runningTransfers 过滤器），但裸数字无任何注意色，用户无从察觉。
4. 300s 无人裁决 → 超时静默取消——观感即「点了下载，什么都没发生」。

更深层：就算用户找到了决策卡，「覆盖」钮也是**必失败**的——DF6.1 能力矩阵冻结把人类/Agent 的覆盖发布一律 `ReplaceUnsupported` 拒绝（理由：无目标版本约束原语）。提示存在但语义是谎的。

## 落地

### ① 决策卡必须浮出（修静默）
- App.tsx：`AwaitingDecision` 新卡首次出现 → 自动展开传输抽屉（每卡一次，`decisionAutoOpenedRef` 上限 200 防累积）。AwaitingDecision 是拦住传输等人裁决的阻塞问题，不属于「后台事件不自动展开」的范围——那条管进度噪音。
- 状态条 `sb-transfer` 与专注模式传输钮：awaiting>0 加 `attn` 注意色（warn 前景+panel2 hover 底，显式压过全局 button:hover 特异度——本仓第 5 处同款陷阱）；title 文案同步改「冲突待裁决时自动展开并高亮计数」（EN 键同步）。

### ② 下载覆盖解冻（DF6.1 下载面解冻；上传面维持冻结）
信任模型不降级的实现口径：
- **覆盖只针对批准所见那份**：决策卡展示目标 size/mtime（既有），人类点覆盖=批准替换**这份** stat 的文件。
- **提交窗复检 CAS**：publish 前重新 stat，与批准所见一致才替换发布；已变化（外部写入）→ 重新出卡裁决（既有 stat_changed_since_preflight 回环，16 轮上限不变）。
- **原子替换**：新增 session-api `local_publish_replace`（`fs::rename`——POSIX rename(2)/Windows MoveFileEx REPLACE_EXISTING 语义，无「目标已删新文件未落」中间窗）；失败（目标被占用等）走 Rejected 臂=确未提交重裁决。
- **破坏性动作留痕**：新增审计事件 `transfer_overwrite_published`（payload 带 target + approved_stat）。
- **上传面维持阻止**（ReplaceUnsupported 原样）：远端 SFTP v3 rename 目标存在即败、posix-rename@openssh.com 扩展不在 russh-sftp 3.0 面，无原子替换原语——诚实的能力线，不引入 remove+rename 的崩溃窗口。Agent 路径覆盖维持阻止（DF6.2 不变）。

代码：
- crates/session-api/src/lib.rs：`local_publish_replace(temp, target)`
- crates/core-session/src/lib.rs：`ResolveOutcome{Terminal,RenameTo,Replace}`（conflict_resolve 返回枚举化，模块级——enum 不能进 impl）+ 三处调用点（预检/复检/publish_raced）+ 复检 CAS 短路（`replace_approved == tstat` 直接落发布）+ 发布分支分派 + Committed 臂审计
- ui/src/demo.ts：镜像同构——Download 覆盖=按批准所见发布 Succeeded；Upload 维持阻止文案
- ui/src/components/sftp-panel.tsx：覆盖钮 tooltip 按方向分流（下载=「用远端这份文件替换本地同名文件…复核未变化」/上传=原文案）
- ui/src/App.tsx：自动展开 effect + awaitingTransfers + attn 类
- ui/src/styles.css：`.sb-btn.attn` / `.ghost.attn`
- ui/src/i18n.ts：+1 EN 键、title 键更新

### ③ 测试
- crates/core-session/src/r34_tests.rs：新增 `r34_download_overwrite_published`——铺底下载→本地改 14 字节→二次下载预检冲突（卡面 stat=真实 14 字节=批准锚点）→覆盖→Succeeded+本地被远端 T 字节替换+temp 随 rename 消失+审计含 target/approved_stat。既有 `r34_overwrite_blocked`（上传冻结）原样保持绿。
- ui/test/specs/05-files.spec.cjs：+5 断言（conflict-demo 注入）——抽屉自动展开/三钮在场/attn 注意色/覆盖翻完成态/再次下载再次浮出（复审轮勘误：skip 收尾是清理点击无断言，未计入；Esc 关抽屉前置与 skip 终态断言立案见 2026-11-01-commit-review-round）。

**测试踩坑**：Windows TEMP 目录用 8.3 短名（ADMINI~1），canonicalize（stage_plan dir）解析成长名（Administrator）——审计断言按路径全等比不过，改按分隔符归一后文件名后缀+approved_stat 语义对账。

## 验证

- Rust：core-session r34 套件 19/19（含新测试）；workspace 全量见下；clippy 计数与改动前一致（core-session 22 等全为既有，0 新增）；fmt 清账。
- 前端：tsc 0 错；**UI 全套 914/914**（54 spec，净增 5 断言）；vite build 绿。

## 立案/边界

- 上传覆盖解冻（需 russh-sftp posix-rename 扩展或服务器能力探测）——另案。
- 复检 CAS 的 stat 粒度（同 size+同 mtime 的亚秒级写入窗口）与既有 no-clobber 回环同水位，记录不另设防。
- mac 真机走查待用户复验（本轮验证在 Windows+demo 域全镜像，核心路径与平台无关——本地发布原语是 std::fs）。
