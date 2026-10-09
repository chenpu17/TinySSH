# R43 rev-r43 审核处置（作者侧）

审核报告：`rev-r43-findings.md`（首轮判定 **不通过**：阻断 F1/F2，建议 F3/F4，低/信息 F5/F6/F7）。
本文件逐条登记处置与证据，供审核员定向复核。**处置期作者改动已全部落树**（下方给出 file:line 与复跑结果）。

## 处置总览

| 编号 | 结论 | 处置 |
|---|---|---|
| F1（中·阻断） | **采纳并修复** | ①`convert_agent_sessions_to_human` 转换控制权时推进会话代际；②exec 执行开始前对 Agent 复核 admission（双保险） |
| F2（中·阻断） | **采纳并修复** | 批准后复核改为**两臂对称**（Approve + ApproveEdited 共用一个前置复核块） |
| F3（低） | **采纳并修复** | `collab_enable` 仅在 `Disabled` 才放行（Disabling/DisableFailed 均拒）；UI 拆分「重试停用收敛」与「启用协作」 |
| F4（低） | **采纳并修复** | `EndpointHandle::wait_stopped()`；应用侧确认停机后才置 Disabled，超时转 DisableFailed（`collab_mark_disable_failed` 不再是死代码） |
| F5（低） | **采纳并修复** | `collab_enable` 改为**先起端点再开 gate**；端点起不来即失败返回（核心保持停用），消除「已启用但端点未运行」矛盾态；UI toast 按返回状态如实 |
| F6（信息） | **采纳（文档）** | `spawn_endpoint` 标注 legacy/测试专用（无停机语义）；生产一律 `spawn_endpoint_with_shutdown` |
| F7（信息） | **不处置（已说明）** | core-only 占位端点串仅影响无装配方的核心直用（测试/CLI）；app 启动即 `set_mcp_endpoint` 覆盖，且 `collab_status` 为人类专属、实际调用方只有 app。留档不改 |
| F8（低·二轮新增） | **采纳并修复** | `collab_enable` 回滚分支在 `need_start==false` 时也 take 并停掉既有端点——使「core 未启用 ⇒ 无应用端点运行」成为**无条件**不变量（原仅覆盖本次新起的端点） |

## 逐条证据

### F1 停用须作废「排队/未启动」的 Agent 动作
- `crates/core-session/src/lib.rs` `convert_agent_sessions_to_human`：置 `Human` 的同时 `h.generation.fetch_add(1, SeqCst)`——与接管同口径。这是排队 exec（`handle.rs` exec 步骤 2/4）与排队传输（`lib.rs` transfer 闸前/闸后）在执行开始前**唯一**的代际判定点。
- `crates/core-session/src/handle.rs`：新增 `admit_agent_actor()`（仅 Agent 经协作门），并在 exec **取槽后**与**执行前（步骤 4）**各复核一次——排队等槽期间被停用即作废（连审批卡都不生成），且不受「停用→快速重启用」竞态影响。
- 回归护栏（新增）：
  - `r43_disable_advances_session_generation`——停用后会话代际必须前进。
  - `r43_queued_auto_allow_exec_voided_by_disable`——占住串行槽迫使 exec 排队 → 排队期间停用 → 取槽后必须作废（Stub 通道执行会返回 stub 错，故可区分「作废」与「执行」）。**该用例覆盖无需审批（AutoAllow）因而没有审批卡可作废的那一类**。
- 红侧：RED-K13（去掉代际推进）→ `r43_disable_advances_session_generation` 独红；`r43_queued_auto_allow_exec_voided_by_disable` 仍绿（被执行前 admission 复核独立兜住）——两机制互为双保险。

### F2 ApproveEdited 臂缺 admission 复核
- `crates/core-session/src/handle.rs`：把原先只覆盖 `Decision::Approve` 的复核块上提为**共用前置块**，`matches!(decision, Decide(Approve) | Decide(ApproveEdited(_)))` 均先复核 `admit_agent()`，失败即作废卡片并返回 `CollabDisabled`。
- 回归护栏：`r43_approve_edited_after_disable_is_voided_not_executed`（UI「保存并批准」可达路径）。
- 红侧：RED-K14（复核退回只覆盖 Approve）→ 该用例独红。

### F3 DisableFailed 未收敛即重开 + 按钮语义相反
- `crates/core-session/src/lib.rs` `collab_enable`：前置改为 `g.state != CollabState::Disabled → Err(InvalidInput("停用处理尚未收敛，无法重新启用"))`（Disabling 与 DisableFailed 均拒）。
- `ui/src/App.tsx`：停用态按钮按状态拆分——`DisableFailed` → `collab-retry-disable-btn`「重试停用收敛」（`collab_disable` 重跑收敛）；`Disabling` → 无按钮（收敛中）；`Disabled` → `collab-enable-btn`「启用协作」。文案同步：「请先『重试停用收敛』，收敛后才可重新启用」。
- 回归护栏：`r43_enable_rejected_until_disable_converged`（DisableFailed 拒绝重开 → 重试收敛 → Disabled → 方可启用）。
- demo 复现：新增 `?disablefailed`（demo 域复现 DisableFailed；`collab_enable` 同真实核心拒绝）；探针 F1–F9。
- 红侧：RED-K15（放宽为仅挡 Disabling）→ 该 core 用例独红；RED-K16（UI 不区分重试/启用）→ 探针 F5/F6/F7/F9 红。

### F4 Disabled 未经端点停止确认
- `crates/mcp-server/src/lib.rs`：`EndpointHandle` 增 `stopped` 信号（`axum::serve` 返回后置真）+ `is_stopped()`/`wait_stopped()`。
- `src-tauri/src/main.rs` `collab_disable`：`stop()` 后有界等待 `wait_stopped()`（5s）——确认才 `set_mcp_endpoint("")` + `collab_mark_endpoint_stopped` → Disabled；超时则**保留句柄**（供重试）+ `collab_mark_disable_failed` → DisableFailed，并返回可读错误（UI 提示「协作保持封闭，可重试」）。

### F5 启用成功提示与事实不符
- `src-tauri/src/main.rs` `collab_enable`：**先** `spawn_endpoint_with_shutdown`（失败即 `Err` 返回、核心保持停用；句柄 drop 触发优雅停机）→ **再** `collab_enable` 开 gate（未收敛则回滚端点并返回错误）。
- `ui/src/App.tsx` `enableCollab`：按返回的 `CollabStatus.endpoint` 决定 toast——有端点才说「端点运行中」，否则明确「端点未运行，Agent 无法接入」。

### F6/F7
- F6：`spawn_endpoint` 文档标注 legacy/测试专用（`mem::forget` 无停机语义）；生产调用方已是 `spawn_endpoint_with_shutdown`。
- F7：不处置，理由见上表。

### F8（二轮新增）`collab_enable` 回滚未停既有端点
- `src-tauri/src/main.rs` `collab_enable`：核心拒绝（未收敛）时的回滚分支，除 `set_mcp_endpoint("")` + `drop(new_handle)` 外，**再 take 既有句柄并停掉**（`h.stop()` + `drop(h)`；drop 最后一个 `watch::Sender` 亦触发优雅停机，见 `mcp-server/src/lib.rs:791` 注释）。原行为在 `need_start==false`（既有句柄来自一次超时未收敛的停用）时只清地址、留下「端点仍活、地址已清、core 未启用」——经当前 UI 不可达（DisableFailed 只给「重试停用收敛」钮），但语义上不该存在。修复后「core 未启用 ⇒ 无应用端点运行」为**无条件**不变量。
- 复跑：`cargo build --release -p tinyssh-app` Finished（仅既有 warning）。

## 复跑结果（处置后，供复核对账）

| 命令 | 结果 |
|---|---|
| `cargo test -p core-session --lib r43` | **10 passed / 0 failed**（原 6 + 新增 4：代际推进 / 排队 AutoAllow 作废 / ApproveEdited 作废 / DisableFailed 拒绝重开） |
| `cargo test --workspace` | **全绿**（core-session lib 108、vault 32、mcp-server 3 含 120s 挂起、session-api 12 等 32 个 target，0 failed） |
| `cargo build --release -p tinyssh-app` | Finished（仅既有 warning） |
| `npx vite build` | ✓ built |
| `r43-demo-probe.js`（:5183） | **60/60**（原 51 + 新增 F1–F9） |
| 红侧 | RED-K8/9/10/11/12（首轮）+ **RED-K13/14/15/16（处置后）**，全部 Edit 反向还原、无残留 |

## 未主张 / 待人工确认
- **原生 GUI 冒烟 r43a/r43b 未跑**：屏幕锁定（WKWebView 冻结闸），按规约登记为待用户解锁后重跑（`r43-driver.sh` 已就绪）。
- F7 保留为「core-only 直用」的已知限制（不影响 app 路径）。

## 附：视觉复验（vis-r43）发现的处置

| 编号 | 严重度 | 处置 |
|---|---|---|
| **O-5**（补验） | 低 | **采纳并修复**：`DisableFailed` 态停用指引文案重复「（保持封闭）」——`collabStateText` 已含该词，后缀分支又追加一次。`ui/src/App.tsx` 删去 `DisableFailed` 后缀分支，落回默认 `"。"`。修复后 `DisableFailed` →「停用失败（保持封闭）。新 Agent 请求已被拒绝。」（不重复）；`Disabling` / `Disabled` 文案不变。`npx tsc --noEmit` exit 0；`r43-demo-probe.js` 复跑 **60/60**。 |
| **D-1**（首轮） | 低 | **采纳并修复（作者归属更正）**：`停用协作…` 钮浅色对比度 3.91:1 < AA。作者初判「沿袭既有控件」——**该判断错误，已接受审核员更正**：`collab-disable-btn` 经 `git show HEAD:ui/src/App.tsx` 核验在 HEAD(R42) **不存在**，为 **R43 新增**；且 `var(--err, #e5484d)` 的令牌名是**笔误**（仓库只有 `--danger`，`--err` 恒回退硬编码红）。按 R35「`--dim` 系改 `--text-sub` 达 AA」的既有口径一并处置：`App.tsx:4492` `var(--err, #e5484d)` → `var(--danger)`（浅 `#b3484d` / 深 `#d07a7a`，与同 pane 的「停用失败（保持封闭）」chip 同色，实测浅 4.91 / 深 5.66 均过 AA）。`npx tsc --noEmit` exit 0；独立复验 **D-1 已闭合**（浅 **5.32:1** / 深 **5.00:1**，两主题均 ≥ AA；ghost 族样式/可点性/溢出无回归）。 |
