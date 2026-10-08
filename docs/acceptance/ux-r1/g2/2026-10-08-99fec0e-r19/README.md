# UX-R1 G2 · R19 C1 建连尝试（commit 99fec0e 工作树，2026-10-08）

冻结契约：docs/ux/ux-r1-g0/r03-contracts.md C1（begin_connection / connection_status /
cancel_connection / connection-event；AttemptPhase 8 相位；DC1.1–DC1.6）。

## 变更面

- `crates/session-api/src/lib.rs`：AttemptId/AttemptPhase/AttemptInfo/BeginConnectionOpts/
  CancelOutcome/ConnectionEvent/ErrorPayload 类型 + trait 四方法 + subscribe_connections；
  PendingHostKey/PendingAuthPrompt/ApprovalItem 增 `attempt_id: Option`；
  `Error::wire_parts()` 单点 kind/detail 映射（tauri WireError 与 core payload 共用）。
- `crates/core-session/src/lib.rs`：attempt 注册表（attempts/merge_index 按 (host_id,
  actor-domain)）+ AttemptEntry（watch cancel 通道有内存）+ run_attempt（select 内层 vs
  取消兜底）+ 门卡（TOFU/2FA）attempt 参数化与相位发射 + 三方取消语义（提交前受理→
  Cancelled；已提交未投递窗口→AlreadyReady 关闭/CancelCloseFailed 保留；已投递/终态→
  NotFound）+ 跨域拒绝审计 cross_actor_cancel_denied + 审计五动作 +
  `#[cfg(test)]` AttemptTestHooks（pause_after_submit/arrived_after_submit/force_close_fail）。
- `crates/core-session/src/c1_tests.rs`（新）：8 契约测试——序列 1/2/3/4/5/6 +
  DC1.5 合并幂等与 new_session 绕过 + v1 create_session 兼容路径不受扰 +
  取消事件只以终态相位承载。
- `src-tauri/src/main.rs`：三命令桥 + connection-event 转发（BroadcastStream→window.emit）
  + WireError 去重到 wire_parts + r19 冒烟探针（dev 门控）。
- `ui/src/adapter/wire.ts` / `bridge.ts`：C1 wire 类型 + 三命令登记（FE 消费面归 R23/R26，
  本次不接线 App.tsx——点卡仍走 v1 create_session）。
- `ui/src/demo.ts`：C1 mock（同契约：合并/门相位/窗口取消任务侧收口；审计三动作
  connection_cancelled/connection_cancelled_closed/connection_failed——cancel_close_failed
  与 cross_actor_denied 在 demo 场景不适用故不实现；demo 的 connection_cancelled_closed
  审计不带 attempt_id/session_id 载荷，与核心的完整载荷有已知差异）；取消作废待决卡以
  splice+resolve 结算——与核心「受理即从 hk_pending/ap_pending 移除」一致）。

## 证据

### 1. 契约测试（cargo test，本机）

`cargo test -p core-session c1_tests` → 14 passed / 0 failed（8 契约序列 + 6 处置回归：
M1 待决卡清理/H2 幽灵清扫双分支/M3 并发 begin 幂等/M4 并发取消无假 CCF/DC1.4 审批卡
作废写回/Failed 终态与审计）。
`cargo test --workspace` → 32 套件全 ok、0 failed。
既有 flake 登记：vault c8_favorites_recents 偶发（同毫秒 created_at 平局致 recents 排序
不稳，5 复跑全过；vault 零改动，与 R19 无关）。

### 2. demo 探针（真实 Chromium 127.0.0.1:5183，:5183 vite demo 后端）

`demo-probe.js` → `demo-probe-result.txt`：21/21 PASS，零 JS 错误。
覆盖：模块同实例护栏、DC1.5 合并幂等 + new_session 绕过、TOFU TrustRequired 相位、
待决卡 attempt_id 联动（C1 wire）、受理取消 → Cancelled 无会话遗留 + 待决卡结算消失 +
二次取消 not_found、信任 → Ready 投递（session_id/Connected）、迟到取消 not_found 无副作用、
2FA ChallengeRequired + prompt attempt 联动 → 应答 Ready、create_session v1 兼容、
auth_failed → Failed+载荷、未知 attempt → session_not_found。

**不主张**：窗口竞态（序列 2/3 already_ready/CancelCloseFailed）在 demo 同步 mock 中
不可交错驱动（会话创建→Ready 投递间无 await 可打断），由第 1 项 c1_tests 钩子驱动覆盖。

### 3. 原生冒烟 r19d（release 终版二进制 + 隔离 DB + 共享 docker sshd；复验签前关闭 N1/N2 后终轮）

`beacon-r19d.txt`（TINYSSH_RUN_ID=r19d；TINYSSH_DB=/tmp/smoke-r19 隔离；
TINYSSH_MASTER_KEY=口令派生 env；AUTOCONNECT local；sshd root@127.0.0.1:2222 凭据与
仓库既有测试同约定）。全链：

- r19-host-ok：upsert_host 真路径建档（密码凭据核心加密落库）
- r19-merge-ok：同 (host, human) 活跃 attempt 二次 begin 同 attempt_id（DC1.5）
- r19-tofu-phase：connection_status 停在 TrustRequired（首连无指纹）
- r19-trust-ok：UI TOFU 卡「信任并连接」真路径放行
- r19-auth-phase:Authenticating → r19-ready-ok：Ready 终态携带 session_id、
  list_sessions Connected
- r19-late-cancel-ok：Ready 后取消 → not_found、会话存活（序列 4）
- r19-events:TrustRequired,Authenticating,Ready：**原生事件流实证**——探针经
  `__TAURI_INTERNALS__`（transformCallback + plugin:event|listen，与 @tauri-apps/api
  listen 同构）订阅 connection-event，三项相位事件齐备（推送面非仅拉取）
- r19-local-ok：local 无门快路径 begin→Ready + 迟到取消 not_found + close 回收
- r19-cancel-connecting-ok：不可达主机（10.255.255.1:2222）受理取消 → cancelled →
  终态 Cancelled 无 session_id、无会话遗留、二次取消 not_found（序列 1/6）
- r19-DONE；退出 pgrep -x tinyssh-app 零残留

**不主张**：窗口竞态（序列 2/3）依赖 create_session Ok→Ready 投递微窗，无注入手段不可
在原生驱动，由 c1_tests 钩子（pause_after_submit/force_close_fail）覆盖。跨域取消
（序列 5）在原生侧只能以 Human 调用，核心测试覆盖 Agent 域断言。

## 插曲（入档）

1. **提交点 session_id 缺失**（c1_tests 抓出）：run_attempt 提交点只置 submitted 未写
   session_id，窗口取消 ok_or(SessionNotFound) 失败。修复=提交点即携带（会话行已存在，
   状态如实反映）；顺带修正 force_close_fail 注入点——窗口 close 由 cancel 侧执行，
   任务侧分支在钩子驱动流中不可达，注入移至 cancel 侧 close 前。
2. **demo mock 幽灵待决卡**（demo 探针 D3 抓出）：取消作废只 resolve 未 splice。
   修复=splice+resolve 结算；随后核心侧 M1 处置对齐（作废即移除 hk_pending）。
3. **锁屏冻结**（r12 已知坑复现）：r19a 首轮走到 Authenticating 后屏幕锁定，
   WKWebView 页面 JS 冻结停摆；解锁后 r19b 复跑全绿。beacon 日志每轮清空。

## 视觉复验裁定

不适用：本任务 ui/ 变更仅 wire.ts（类型）/bridge.ts（命令登记）/demo.ts（mock 后端），
零渲染表面（无 App.tsx/CSS 变更，FE 消费面归 R23/R26）。与 G1 退出项（ui/ 零 diff）
同裁定口径。

## 独立审核 rev-r19 处置记录（初判不可签 → 处置后复验）

**高：**
- H1 投递点不复查 cancel_requested（终态可被改写、已投递会话被取消路径关闭）——修：
  run_attempt 投递点 re-lock 后增 `st.cancel_requested` 判定，取消受理后投递权让渡给
  取消侧结算；窗口取消侧结算后重锁覆盖在「受理即置位+结算权唯一」不变量下不可达
  Ready-改写交错。
- H2 取消 drop inner 时已过 sessions.insert → 幽灵会话泄漏——修：AttemptState 增
  `pending_sid`（inner insert 点即记入），run_attempt 取消结算经
  `settle_cancel_with_ghost` 清扫幽灵（关闭成功→审计 connection_cancelled_closed 后
  常规 Cancelled；关闭失败→CancelCloseFailed 会话保留语义一致）。提交点
  pending_sid 让位于 session_id 口径。

**中：**
- M1 取消作废 TOFU 卡残留 hk_pending（幽灵卡+decide 得 InvalidInput；三处注释/README
  失实）——修：作废循环补 hk_pending.remove（对称 ap 侧）；demo 注释/README 措辞更正。
  卡终结 UI 推送事件未加（FE 待决卡移除由 R23/R26 消费 attempt-Cancelled 事件收尾），
  登记。
- M2 connection_status/subscribe 跨域不可见缺失——修：status 增跨域
  Err(SessionNotFound)（与 cancel 同口径，测试断言）；subscribe_connections 事件广播为
  全局通道（approval-event 同款既有模式），按订阅域过滤需 ConnectionEvent 携带域或
  每订阅者过滤任务——归 R26 Agent 域接线时一并裁定，登记为已知豁免（当前仅 Human
  通道可创建 attempt，非现实暴露面）。
- M3 并发 begin 非原子 + 终态无条件 remove 误删——修：AttemptEntry 增 `term` 原子
  镜像（settle 统一置位，Release/Acquire），合并查询与登记收进同一 Std 锁临界区
  （tokio 锁不跨 Std 锁持有）；merge_remove 改按键比较移除。
- M4 并发双 cancel 产出假 CancelCloseFailed——修：cancel 受理增 cancel_requested
  预检（首个受理者拥有结算权，后续 NotFound）。
- M5 DC1.3 三点偏差（门超时不按 attempt 存续计时/超时无留痕/错误 kind 非 timeout）——
  部分修：门超时补 approval_voided 审计（reason=gate_timeout, gate=host_key|auth_prompt，
  复用 T44 留痕先例）；**勘误登记**：120s 按「每门各自计时」实现（attempt 级总预算可达
  240s+）与错误 kind 沿用 host_key_rejected+「确认超时」文案，归 R23 FE 消费错误面时
  统一裁定（或实现 attempt 级 deadline 或契约勘误），不在本轮无声偏差。
- M6 README 称 demo 审计「五动作」实为三——修：更正为三动作+载荷差异声明（见上）。

**低：**
- L1 attempts 表终态条目常驻——登记（契约「status 恒返回终态」与「无历史查询」的
  张力，现取常驻；单条 ~KB 级、量级=用户建连次数；容量上限/TTL 归后续契约勘误）。
- L2 噪音/失实注释——修：`let _ = cancel_tx` 死行删除；AttemptState 失实注释更正；
  `let err = take(); let _ = err` 改 `st.error = None`。
- L3 CancelCloseFailed 事件两处载荷不一致——修：cancel 侧补 Some(payload)（与
  run_attempt 侧同形）。
- L4 契约 freeze wire 注释 actor 自相矛盾（"agent" vs "agent:<client_id>"）——登记
  契约勘误建议（实现取向正确：合并键需要 client 域）。
- L5 begin 未知主机 InvalidInput vs v1 SessionNotFound——修：统一 SessionNotFound。

**处置过程副产真 bug（测试驱动抓出）：**
- 审批卡作废只改 `get().cloned()` 副本未写回内存表（save_approval 落库但
  center.items 恒 Pending，UI 列表/后续过滤器读过期状态）——同病两处：R19 cancel
  作废块 + T44 session-close 作废块（既有），均补 `get_mut` 写回（mark_status 同口径）。
- 写回初版引入 `if let` 守卫 MutexGuard 临时活到块尾的自死锁（2021 edition）——快照
  先落 let 化解，注释在案。

**处置后复验（rev-r19 二轮）：处置后可签**，复验报告归档 rev-r19-recheck.md。复验新发现
N1（中，pending_sid 写入/insert 顺序微窗）与 N2（低-中，Failed 半会话幽灵，v1 既有面）
均**签前关闭**：N1 写入移到 insert 前（两语句间无 await，窗口完全消除）；N2 attempt 路径
Failed 结算前清扫 pending_sid（v1 直调同面缺陷登记）。N3/N4（测试强度）/N5（合并 TOCTOU
自愈豁免）登记；H1 让渡分支/H2 端到端/窗口态并发 cancel/v1 幽灵面四条回归网缺口登记进
R23 FE 接线前置清单。**签前关闭 N1/N2 后终轮：** c1_tests 14/14、workspace 32 套件全绿、
demo 探针 21/21、原生冒烟 r19d 全链 r19-DONE 零残留。

## 审核登记

独立对抗审核 rev-r19 两轮：初判不可签（2 高/6 中/5 低）→ 全部处置 → 复验
「处置后可签」（报告归档 rev-r19-recheck.md）→ 签前关闭复验附条件 N1/N2 → 终轮 r19d
全绿。审核闭环。
