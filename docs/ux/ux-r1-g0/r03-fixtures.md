# R03 配套：迁移/协议 Fixture 清单与测试预期（G0 签署项 4）

> 日期：2026-10-06 · 基线：`7c4502e` + [契约冻结草案](r03-contracts.md)（§12 可断言序列为其断言来源）
> 约定：本清单冻结**测试预期**；fixture 文件与实现随归属任务交付（交付 §1.1 允许实现后置、预期先行）。全部 fixture 脱敏，凭据字段用占位值。

## 1. 迁移类 fixture

| ID | 内容 | 预期（断言） | 归属 |
|---|---|---|---|
| FIX-M1 | 旧库样本：`ui.theme` 四值（dark/light/solar-dark/solar-light）× `ui.font_size` 边界值（9/28）× ≥3 主机（含 IPv6/长中文名）× 密钥凭据引用 × 指纹记录 × Agent 身份与 token × 审计 ≥50 条 | 迁移后：终端配色逐一保留、应用外观按 DF8.3 映射（dark/solar-dark→dark、light/solar-light→light）、字号保留、主机/凭据/指纹/Agent 原键不变、审计完整；重复启动三次幂等 | R15/R44 |
| FIX-M2 | 旧 Agent 配置库（已有 token、端点历史） | 升级后 `collaboration.enabled` 缺键 → 行为=开启（§10.1.6）；Token 可用、端点可连 | R43 |
| FIX-M3 | 新装库（空） | `collaboration.enabled=false`；无 MCP 监听；欢迎页空态 | R43 |
| FIX-M4 | 存量主机集（升级路径，无 `shell_integration` 键） | C8 迁移后全部显式 `Some(true)`；旧 UI（灰度期）upsert 缺字段不改变该值 | R24 |
| FIX-M5 | 升级中断样本：迁移事务中途 kill（V4→V5） | 再启动重跑迁移无重复行/丢行；`schemaVersion` 一致 | R44 |

## 2. 协议/兼容类 fixture

| ID | 内容 | 预期 | 归属 |
|---|---|---|---|
| FIX-P1 | 旧 MCP 调用方（mode 省略）× Shell 能力不可用主机 | `ShellIntegrationUnavailable{available}` 于副作用前；哨兵文件证明未执行 Fresh（D09） | R24 |
| FIX-P2 | 显式 `mode=Fresh` 请求（MCP/CLI/新 UI 三端） | 按原授权/审批执行；审批卡含「不继承」标注 | R24 |
| FIX-P3 | mock SFTP server（russh-sftp server 侧，进程内）：①吞 rename 应答+目标在/②吞 rename 应答+目标不在+temp 在/③吞 rename 应答+双不在/④延迟应答/⑤无 posix-rename 扩展表 + overwrite/⑥CREATE_NEW 声明期他方抢建 六变体 | ①复核证实已发布→Succeeded{verified} ②未发布→Failed{publish_unverified_target_absent} ③不可判定→OutcomeUnknown+temp 保留 ④延迟→同①-③按复核 ⑤`ReplaceUnsupported` 且目标 stat 前后一致（负例断言）⑥声明失败→不覆盖、按冲突处理 | R34 |
| FIX-P4 | 旧 UI 订阅消费（App.tsx 现行为）对 C10 新 wire 的适配样本 | 剥帧头、resync 对象解析、AttachOutput（checkpoint）消费；B11 seq 连续性断言通过；alt_screen 活跃 → checkpoint 分支重建备用缓冲 | R10/R11 |
| FIX-P5 | ssh config 样本：Include/Match/ProxyJump/通配符/证书/ServerAlive/无 User 条目 各一 | C7 分级清单逐条命中（blocking/warning/silent-ok）；directly_importable 与清单一致；重复导入默认 skip | R22 |
| FIX-P6 | 同目录响应乱序与跨会话串扰样本（延迟注入） | seq 比对拒绝晚到旧响应；会话隔离成立（C02） | R30/R31 |
| FIX-P7 | 连接取消竞态脚本化序列（§C1 六序列） | 六断言全过：认证中取消无遗留 / 竞态关闭成功→终态 Cancelled / **关闭失败→CancelCloseFailed 且会话保留可恢复** / Ready 投递后迟到取消 NotFound 无副作用 / 跨 Actor 取消拒绝留痕 / 重复取消 NotFound | R19 |
| FIX-P8 | C9 停用并发样本：Disabling 期间 create_session + 已批准未执行 + shim 在途；resolve 过期 generation；Wait 项超时 | 全拒 + 留痕；三层确认顺序断言；**Disabled 后 MCP status 端点不可达（预期断言）**；过期 generation → `StalePlan`；Wait 超时 → 该项 StopFailed{wait_timeout} 且整体 DisableFailed | R43 |
| FIX-P9 | 外部写竞争样本：预检后外部进程改写目标 | 复检 stat 不一致 → 显式 overwrite 亦按新冲突处理（人类重回 AwaitingDecision / Agent 返回 ConflictDetected）；无授权不覆盖（C07） | R34 |
| FIX-P9b | 决定提交样本：正确 revision 提交 / 过期 revision / Agent 任务提交 / reject 过期卡 | 生效 / `StaleDecision` / `InvalidTransferState` / reject 幂等 no-op + 审计 | R32 |
| FIX-P10 | 真机冒烟链（dev-sshd + beacon/ev.py）升级版：按新 UI 选择器重写 | T44 全链在新 UI 复现；旧三栏/命令框断言全部移除（G02） | R45 |

## 3. 交付方式

- FIX-M*：`tests/fixtures/` 下版本化 SQLite/JSON 样本 + 生成脚本（不提交真实凭据）。
- FIX-P1–P9：契约测试内嵌（cargo test），mock server 为测试专用 crate 模块。
- FIX-P10：`scripts/native-smoke/` 原地升级。
- 每项 fixture 在归属任务的验收证据包中给出运行记录；本清单的预期冻结自 G0 联合评审起生效。
