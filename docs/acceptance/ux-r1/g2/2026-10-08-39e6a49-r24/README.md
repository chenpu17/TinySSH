# UX-R1 G2 · R24 C2 Human 默认控制 + C3 Shell 集成探测（commit 39e6a49 工作树，2026-10-08）

冻结契约：docs/ux/ux-r1-g0/r03-contracts.md C2/C3 节 + DC2.1-DC2.2 + DC3.1-DC3.5。

## 变更面（crates/ + src-tauri/；ui/ 为并行 R20 任务不相交）

- `session-api`：Host/HostDraft.shell_integration（None=历史行/未设置，Some=显式）+
  IntegrationState（Disabled/Pending/Ready/Unavailable）+ ShellCapability +
  ShellIntegrationEvent + Error::ShellIntegrationUnavailable{available}（wire_parts 单点
  kind="shell_integration_unavailable"，tauri WireError 自动获得）+ trait 三方法。
- `vault`：V6 迁移（hosts 加列 + 存量 SSH 主机一次性置 1——与旧行为「无条件注入」一致，
  杜绝灰度期缺字段静默关闭；local/软删不动）+ upsert None=编辑保原值/新建 false +
  list 透传 + c3_v6 迁移测试。
- `core-session`：B01 owner 构造期确定（Actor::Agent→Agent 其余 Human，无「建完再夺」窗口）
  + session_created 审计 +owner；delegate_session（Human 专属 → 既有 handback 受控转换 +
  goal + 审计 session_delegated）；三注入点收敛 handle.inject_integration
  （host_setting!=Some(true) 或非 ssh → Disabled 不注入不等 OSC）+ 后台 watcher
  （≤10s → Ready/Unavailable + shell-integration-event，DC3.5 就绪独立表达）；
  run_shell 入口门（无集成 SSH 拒绝 ShellIntegrationUnavailable、local 有界 10s 重等后
  拒绝——**静默 Fresh 降级删除**，DC3.1）；Fresh 审批卡 target_summary 标注
  「不继承当前终端目录/环境」；local create_session 保留 10s 等集成（「返回即可键入」
  不变量——core_local human_meta 并发回归实证：先键入后集成的输入永久丢失）。
  r24_tests 4 项（B01 双域+审计 owner / delegate 语义与审计 / B12 拒绝与 Fresh 显式 /
  shell_capability 只读——DeadChannel stub 驱动门判定）。
- `cli`：session delegate 子命令（--goal）。
- `mcp-server`：ShellIntegrationUnavailable 错误映射。
- `src-tauri`：delegate_session/shell_capability 命令 + shell-integration-event 转发
  （同 conn-event 桥模式）+ r24 冒烟探针（dev 门控）。

## 契约取向（登记）

1. **MCP 不加 delegate 工具**：MCP token 恒 Agent 域，delegate 人类专属，加了必被拒；
   三端=session-api trait / tauri / CLI。
2. **local 建连保留 10s 等集成**（SSH 侧按契约后台化不等）：契约「不等 OSC」针对
   host_setting 治理的 SSH；local 注入在 PTY 启动同步完成，等待实为 shell 启动耗时。
3. **B01 落地语义**：人建会话 Human-owned，Agent exec 被既有 owner 锁出拒绝直到
   delegate；8 处既有测试按新契约补 delegate；e2e/gbk SSH 测试主机显式 Some(true)
   保全量注入语义（DC3.2 新建默认关）。
4. **Fresh 放行路径无 tauri 面**：exec_human 恒 Shell 模式——Fresh 由调用方显式指定
   （core r24_tests B12 覆盖），原生冒烟不主张。

## 证据

### 1. 测试

`cargo test --workspace` → 32 套件全绿、128 测试 0 失败（fork 与主线各独立复跑；
含 r24_tests 4 项、vault 17 含 V6 迁移、c1_tests 14 项不受扰）。

### 2. 原生冒烟 r24a（release 终版二进制 + 隔离 DB + 共享 docker sshd）

`beacon-r24a.txt`（TINYSSH_RUN_ID=r24a；TINYSSH_DB=/tmp/smoke-r24 隔离；
AUTOCONNECT local）。全链：

- r24-hosts-ok：双主机建档（r24-on 显式 shell_integration=true / r24-off 显式 false）
- A) r24-on：UI 点卡真路径建连（TOFU→密码）→ integration Ready（list_sessions 拉取面
  + shell-integration-event 推送面双证 r24-events:Ready）→ shell_capability 全真
  （integration_present/host_setting）→ exec_human（Shell 模式）成功
- B) r24-off：建连 → integration Disabled → shell_capability host_setting=false →
  exec_human 拒绝 kind=shell_integration_unavailable 且 available 载荷对账
  （host_setting=false、integration_present=false）——**静默降级删除后的拒绝路径原生实证**
- C) delegate_session（Human，附 goal）→ control_owner 翻 Agent + 审计 session_delegated
- D) B01：全部 session_created 审计 owner=Human（含 AUTOCONNECT local）
- r24-DONE；退出 pgrep 零残留

**不主张**：Fresh 模式放行（无 tauri 面，core B12 覆盖）；Disabled 会话断线重连的
B12 再注入口径（core 路径覆盖，原生未驱动）。

### 3. 视觉复验

不适用：本任务零 ui/ 渲染面变更（ui/ 四文件属并行 R20，其视觉复验独立进行）。

## 已知事项与登记

- vault c8_favorites 同毫秒平局 flake：既有（R19 已登记），与 R24 无关。
- AUTOCONNECT 会话 owner=Human 按 DC2.1（原生冒烟 D 段实证）。
- exec 静默 Fresh 降级删除后，旧脚本若依赖降级行为会显式报错——语义收紧属契约要求
  （C3），调用方须显式 Fresh 或开集成。

## 审核登记

rev-r24 独立对抗审核：**可签（0 高 / 0 中 / 6 低，全部登记不阻签）**。逐项核对
B01 三向量闭环（构造期 owner/AUTOCONNECT=Human/MCP=Agent/五处 Agent 锁出）、
DC3.1-3.5（DC3.2 保原值 SELECT+INSERT 同临界区无 TOCTOU；DC3.3 门直读屏面）、
watcher 收敛、run_shell 门（无漏网 run_fresh 调用点）、V6 链序与新库路径、delegate
语义（exec 串行不打断/goal 覆盖语义/二次移交拒绝）、r24_tests 四项均可红、范围干净
（ui/ 零 shell/delegate 字样）。

低危登记（后续轮次）：
- **L1 V6 迁移非原子**（execute_batch 两语句各自提交，进程中断窗可留 user_version=5
  +列已存在）——沿 V4 既有模式弱点非回归；归迁移统一加固轮（table_info 预检或入事务）。
- **L2 SessionInfo.integration 一次性判定漂移**（SSH watcher 10s 窗外迟到集成停在
  Unavailable、local 不翻转）——纯展示面，门与能力查询直读屏面不受影响；
  **R26 FE 消费时以 shell_capability 对账**。
- **L3 重连期双 watcher 竞写**（旧 watcher 晚到 Unavailable 可覆盖新 Ready）——展示面
  同 L2；加固取向=reinject 作废旧 watcher（代际号），归后续轮。
- **L4 Pending 窗口执行拒绝 + e2e 时序敏感**：Some(true) 主机 create 返回（Ready=通道
  建立）与集成落位间窗内 exec Shell 报 ShellIntegrationUnavailable（契约明定、载荷可
  区分「启用未落」）；e2e_acceptance 显式 Some(true) 依赖该窗闭合，登记潜在 flake 面。
  「审批卡先建后拒」体验归 R26/R42。
- **L5 命令框 Fresh 死端文案**：exec_human 恒 Shell、无 mode 参数（DC3.4 契约裁定），
  集成关闭主机经命令框报错文案待 FE 面补「可显式 Fresh」指引——归 R26/R42。
- **L6 杂项**：address='local' 字面判据与 ensure_local_host 一致（字面同址 SSH 主机漏，
  无真实场景）；软删行留 NULL 无复活路径；delegate 双审计 note 文案语义噪声。

**签前复跑（rev 建议）：** workspace 128 passed / 0 failed ×2 轮（含 c1_tests 14/14 +
r24_tests 4/4）——c1 flake 归因维持 R19 已登记敏感时序窗（R24 未引入新机制），未复现。
