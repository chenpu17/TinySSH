# R15（C8 偏好与主机元数据）交付与验收记录

日期：2026-10-07 ｜ 基线：bbdd40c（R13） ｜ 原生冒烟终轮：r15l

## 交付范围

- **DF8.1 工作区偏好 blob**：`ui.v2.workspace` 单键 JSON（`{schema_version, chrome, hostbar}`）整取整存；`schema_version` 核心恒归一为 1；vault `workspace()` 损坏回落 Default（下次整存自愈）。
- **V5 迁移**：`host_metadata`（favorite/last_connected_at）+ `transfer_journal`（R32 消费）两表 + 一次性旧键迁移（`ui.theme`→chrome 映射 dark/solar-dark→dark、light/solar-light→light；`ui.font_size`→`ui.v2.terminal.font_size`；旧键保留；幂等标记=blob 键存在；unchecked_transaction 内）。迁移后 blob 以 `hostbar:null` 落键。
- **DF8.2 主机元数据**：`set_host_favorite`（未知主机 InvalidInput）、`list_host_metadata`、`touch_host_connection`（create_session 成功后打点）。
- **DF8.3**：chrome 字段存储（dark|light 镜像，R27 消费）。
- **DF8.4 凭据引用检查**：`delete_identity` 前查 `identity_host_refs`（存活主机），被引用 → `Error::IdentityInUse{host_names}`；三端映射一致（CLI 人话文案 / MCP `identity_in_use`+host_names detail / Tauri wire 同 kind）；`delete_host` 联动删 `host_metadata` 行。
- **DF8.5 最近连接**：`list_recent_hosts` sessions 派生（`kind != 'local'`、每主机 MAX(created_at)、倒序、上限 5、JOIN 存活主机无幽灵）。
- **FE（最小接线）**：bridge/wire C8 命令登记；App 启动读 blob（有值覆盖 localStorage 初值 / 无值一次性迁入 R12 的 `ui.hostbar`/`ui.hostbar_w`，旧键保留）；`persistHostbarPrefs` 读改写经 promise 链串行化（⌘B/拖宽连发按序落库）；Tauri 字号读取补旧键兜底；demo.ts 同契约 5 case（含坏 blob 回落、版本归一、local 排除、未知主机收藏 invalid_input）。
- **dev 探针**：`r15_smoke_script`（TINYSSH_SMOKE=1 + MODE=r15 门控）：单调步进（step 0→3）四段 reload 驱动 blob 真实持久化断言 + 收藏/打点/recents/字号键/schema 99→1。

## 验证链（四层，全绿）

| 层 | 内容 | 结果 |
|---|---|---|
| Rust | workspace 全量（vault 16 含 2 个 C8 迁移/级联测试、core-session `c8_prefs` 4：整取整存+版本归一/收藏+打点/引用检查+级联解锁/recents 空 local） | 全 PASS |
| demo 探针 | 16 项（[demo-probe-result.json](demo-probe-result.json)）：旧键一次性迁入（旧键保留/UI 跟随收起/展开钮在位）、blob 宽度 250 驱动、schema 99→1、收藏落位、未知主机 invalid_input、recents 初始序+UI 真连 staging 升首+排除 local+上限+形状、建连打点、零 JS 错误、模块同一性护栏（直调会话数=UI 标签数，防 HMR 双实例误判） | 16/16 PASS |
| 原生冒烟 | r15l（[native-beacon.txt](native-beacon.txt)，release 终版二进制+隔离 DB+本机会话）：归一 224/展开 →（reload）→ 断言持久化 → 写 260/收起（后端回读一致）→（reload）→ 断言收起态 → 写回 224 →（reload）→ blob-ok/收藏 fav-ok（AUTOCONNECT 真实建连打点轮询到位）/recents n=0（仅 local，排除正确）/字号键/99→1 → `r15-DONE` 零 FAIL，退出零残留 | 全链 DONE |
| CLI DF8.4 | [cli-identityinuse.txt](cli-identityinuse.txt)：被引用删除拒绝并列出主机名（exit=1）→ 主机软删解除引用后删除成功（exit=0）→ 列表空 | 三相 PASS |

## 独立复核

### rev-r15（对抗审核）——处置后可签（1 中 7 低）

**已修复（本轮代码）**：
- **M1** `touch_host_connection` 无条件 upsert 可在并发删除后复活幽灵 host_metadata 行（全库未开 PRAGMA foreign_keys）→ 改 `INSERT…SELECT…WHERE EXISTS(hosts 存活)`，与注释语义一致。
- **L2** `persistHostbarPrefs` 读改写两跳可交错（连发以陈宽覆盖）→ promise 链串行化；启动一次性迁入写并入同链。
- **L3** Tauri 字号读取无旧键兜底（降级→升级丢字号）→ `f===null` 时回读 `ui.font_size`。
- **L5** `set_workspace` 审计缺 hostbar 域 → detail 补 `"hostbar"`。
- **L6** 误改冻结轮（r12/r13）冒烟脚本 `waitFor`（`fn()`→`await fn()`，行为等价但未经复验）→ 已回滚，仅 r15 脚本保留 await 版。

**登记后续**：
- **L1** `delete_identity` 引用检查与删除两次取锁（TOCTOU 毫秒窗，单用户本地）→ 后续并入同事务。
- **L4** chrome 字段未钳制 dark|light（R27 消费前加边界校验）。
- **L7** 裸 `set_setting` 可直写保留键 `ui.v2.workspace` 绕过归一（纵深防御；坏值静默回落 Default 不炸）。

修复后复验：cargo test --workspace 全绿、tsc/构建通过、demo 探针 16/16 复跑 PASS、终版二进制原生冒烟 r15l 全链 DONE——处置未引入回归。

### vis-r15（视觉复验）——视觉可签（10/10 PASS）

- 零回归：1024/960/files-tpfull 与 R13 基线逐像素 0 差异；1280 欢迎态真实差异 3 像素（0.0003%，抗锯齿亚阈值）。
- 双主题：token/色值/字号档 6/6 逐字段等于 R13 存档；light 几何与 dark 全同、零横向滚动。
- R15 行为外观：blob `open:false` → hostbar 卸载+`.hb-expand` 在位不破版；`width:250` → hostbar 实宽 250、主机卡完整、main.x=252（250+2px 边框，与基线 224→226 同构——复验员探针一处断言写 250 系自误，数据判 PASS）；夹取 150→200、400→300 双向正确。
- 几何 44/224/40/24 与面板开合正常；全程零 console/page 错误。
- 注：处置修复（L2/L3 前端逻辑、M1/L5 后端、L6 探针脚本）均不触及视觉表面，vis 结论对终版有效。

## 登记（后续轮次）

- transfer_journal 表已建待 R32 传输台账消费。
- L1/L4/L7（见上）。
- recents/收藏暂无 UI 消费面（主机卡星标、最近连接列表属后续轮次）；本轮覆盖核心契约 + demo/原生 invoke 面。
