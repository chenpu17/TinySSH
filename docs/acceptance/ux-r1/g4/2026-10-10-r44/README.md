# R44 验收证据（G4 五/五：完整升级、UI 开关与回退演练）

范围：`docs/ux/ssh-client-ux-refactor.md` §10.2（开发与回退：`TINYSSH_UI_V2` 开关 /
脱敏迁移 fixture / schema 增量可检测 / 升级后不得用旧二进制写新库 / 导出备份与恢复 /
灰度期单实例写锁 / 新旧 UI 不各起一套 MCP 端点 / C3 语义收紧需版本说明与旧客户端错误
路径测试）；§10.1 item 1/3/4/6；交付验收项 **R44**（交付文档 line 101）与 **G4 退出条件**
（「迁移矩阵与原 MCP/CLI 契约回归通过」「MCP/CLI 能力可用」「移除开发期开关的时机与
release 候选构建一并记录」）。
基线：R43（HEAD `53cd4e6`）。

## 本目录文件

| 文件 | 说明 |
|---|---|
| `migration-matrix.txt` | 迁移矩阵实跑（`cargo test -p tinyssh-vault --test migration_matrix`，10 用例） |
| `contract-check.txt` | 旧 UI ↔ 当前核心命令契约核对（`scripts/check-old-ui-contract.py`） |
| `ui-switch-embed.txt` | `TINYSSH_UI_V2` 两方向构建内嵌资源判别 |
| `mcp-protocol.txt` | 原 MCP 协议回归（`cargo test -p tinyssh-mcp-server --test protocol`） |
| `cli-smoke.txt` | CLI 契约回归（真实二进制，含新 `vault` 子命令） |
| `redside-r44.txt` | 红侧变异记录（RED-M1…M6）+ 附带发现 |

## 实跑结论

- **迁移矩阵：10/10 PASS**。V1/V3/V4/V5/V6 五份脱敏 fixture 各自升到链尾 V7，逐项断言：
  ①升到链尾 ②**无损**（主键/含义保持；软删行不被清；`identities.secret_blob` **逐字节不变**、
  不重加密；Agent `token_hash` 保持；审计链 hash 保持）③**幂等**（重开版本与 blob 不变）
  ④**默认正确**（新装协作停用 / 升级保留旧默认开启；V6 存量 SSH 主机回填 `shell_integration=1`、
  local 与软删行不动；旧 `ui.theme` 映射且旧键保留；收藏/最近连接不虚构）。
- **升级后既有 Agent 仍可用**（§10.1-6 + G4「MCP/CLI 能力可用」）：V1 老库里用真实
  `token_hash()` 落库的 Agent，升级后 ①`resolve_token` 仍解析回同一身份（**不撤销既有
  Token**）②仍在 `list_agents` ③协作按升级默认**开启**。对照组：全新安装默认停用
  （防「恒真」）。**注**：③只断言 `collab_enabled()==true`，**未真起 MCP 端点**——
  「端点可用」是据「`src-tauri` 仅在 `collab_enabled` 时才 `spawn_endpoint`」的**推断**，
  非实跑（R44 审核 F4）。真起端点属原生域，见「未主张」。
- **Rust 单测**：`tinyssh-vault` lib **46 通过 / 0 失败**（32 基线 + R44 **14**：版本护栏
  拒绝且零写、**非 WAL 库拒绝时逐字节不变**、单实例写锁、`open_shared` 不取锁、备份往返+
  拒绝覆盖、**拒绝备份不存在的库**、拒绝更新版本备份、拒绝非 vault 备份、**拒绝残缺库且
  目标原样存活**、**覆盖前留安全副本**、**拒绝自我恢复**、**恢复前在副本上先迁移到链尾**、
  **恢复不碰来源侧车**、持锁时备份/恢复被拒）；`session-api` 集成 **3**（C3 旧客户端错误路径）；
  `tinyssh-mcp-server` protocol **3/3**（含 120s 审批挂起合规，121.01s）。
- **`cargo test --workspace`：34 个 test target 全绿，0 失败**（exit 0）。
- **CLI 契约回归**（`cli-smoke.txt`，真二进制、命令与参数分开传）：既有子命令族
  （`host list`/`identity list`/`agent create`/`agent allow`/`session brief`/`approval list`/
  `audit query`）各打一发真实调用，全部按预期响应（非 `--help` 列名）；新增 `vault
  version/backup/restore` 可用——备份**拒绝覆盖**既有文件、恢复**拒绝**非 vault 文件
  （缺核心表）与**更新版本**备份（`user_version=99`）、覆盖既有库前**打印安全副本路径**。
- **旧 UI 契约核对**：旧 UI（tag `old-ui-baseline-g0`）调用的 **20** 个命令 ⊆ 当前核心
  **74** 个注册命令；旧 UI 传入的 **22** 个参数键全部能对上核心参数（`contract-check.txt`）。
- **UI 开关**：`TINYSSH_UI_V2=0` 构建内嵌**旧** UI 资源、`=1` 内嵌**新** UI 资源，两方向
  互斥且同一二进制路径（核心不变）；写锁保证同一 vault 单实例，故新旧 UI 不各起一套端点
  （`ui-switch-embed.txt`）。
- **C3 语义收紧登记**：新增 `docs/ux/ux-r1-release-notes.md` 记录「Shell 不可用时执行前
  拒绝、禁止静默降级」的对外表现与稳定错误线格式；`crates/session-api/tests/c3_contract.rs`
  锁住 wire code 与载荷（区分「主机未启用」与「远端不支持」两种成因，不可混淆）。

## 关键实现（供复核对照）

### 存储层（vault）
- **版本护栏**：`pub const SCHEMA_VERSION: u32 = 7;`；`ensure_schema_supported()`（纯只读，
  只查 `PRAGMA user_version`）在 `open()` 里于**任何持久写之前**调用——**包括
  `PRAGMA journal_mode=WAL` 之前**。这一点是本轮独立审核的阻断项 F1 修出来的：
  `journal_mode=WAL` 不是内存设置，它改写库文件头并把库永久切成 WAL（对非 WAL 库实测
  文件 sha256 改变），原先「先设 WAL 再进护栏」会让旧程序在**拒绝打开之前**就改动了新库。
  现由 `r44_refusal_writes_no_bytes_even_on_non_wal_db` 断言：对一个**非 WAL** 的未来版本
  库，拒绝打开后**库文件逐字节不变**且 journal 模式不变（库旁仍会留一个 0 字节
  `<db>.lock`，见 F6——故主张严格限于「库文件」）。（原 `r44_newer_schema_is_refused_
  without_writing` 只比版本号与表清单，证不了这条——红侧 RED-M7 实证它在旧实现下仍绿。）
- **单实例写锁**：`VaultLock` 用 `flock(LOCK_EX|LOCK_NB)` 锁 `<db>.lock`（独立锁文件，
  不与 SQLite 自身的库文件锁混用）；`Vault::open` 取锁、`open_shared` 不取。锁随 fd 存活，
  进程崩溃由内核释放，无陈旧锁。
- **备份/恢复**（§10.2 退路）：`backup_to`（`VACUUM INTO` 一致性快照——WAL 模式下直接拷
  主文件会漏已提交内容；目标已存在即拒绝覆盖）；`restore_from` 校验来源是 **完整** TinySSH
  库（**V1 核心表全套** `hosts`/`identities`/`agents`/`policies`/`sessions`/`approvals` 在场，
  仅有一张 `hosts` 表**不算**）且版本不高于本程序 → **覆盖前先给既有目标库留安全副本**
  `<db>.pre-restore.bak`（同样用 `VACUUM INTO`，含 WAL 内容；**只保留最近一次**恢复前状态，
  连续恢复时前一份被覆盖——有意简化，二轮 §4 登记）→ 快照到临时文件 →
  `rename` 原子替换 → 清 `-wal`/`-shm`；`read_schema_version` 只读探测（**只用于用户自己的
  活动库**——见其文档注释：只读打开 WAL 库也会建侧车，故**绝不**拿它探测备份/只读来源）。
  **来源先整体拷到私有临时文件 `<db>.restore.src`（连 `-wal`/`-shm`）再从副本读**，并由
  `restore_from` **返回**来源版本供调用方报告——只读打开一个 WAL 库也会写 wal-index，直接
  在来源旁读会留侧车、在只读介质上失败（二轮 N-1 库层 + 三轮 N-1 CLI 层）。
  这两点是本轮独立审核的阻断项 F2 修出来的：审核员以真二进制复现「`vault restore` 指向
  一个恰好有 `hosts` 表的垃圾文件 → 真库 11 张表只剩 `hosts`、应用再也打不开、且无任何
  回退」。现由 `r44_restore_refuses_partial_vault_and_keeps_target`（拒绝且目标库原样存活）
  与 `r44_restore_keeps_pre_restore_backup`（副本内容=被覆盖掉的那份）锁住。

### CLI（crates/cli）
- 新增 `Cmd::Vault`（`backup`/`restore`/`version`）。**必须在 `SessionManager::open` 之前
  分派**——manager 一开就取写锁，同进程再取 flock 会失败（见 `vault_cmd` 上方注释）。
- `restore` **不**预探测原始 `from`（三轮 N-1 CLI 层）：来源版本由 `restore_from` 在私有
  副本上读出并**返回**，CLI 直接用返回值报告「版本 N → M」。

### 旧 UI 契约核对（scripts）
- `check-old-ui-contract.py`：静态比对旧 UI 源码的 `invoke("…")` 与核心 `generate_handler!`
  注册表 + `#[tauri::command]` 签名参数（camelCase↔snake_case 归一，排除注入参数）。
  **只主张命令名与参数名契约未破**，不主张旧 UI 一定跑得起来（形状变化看不出来）。
- `ui-switch.sh`：`TINYSSH_UI_V2=1/0` 选新/旧 UI，支持 `dev`/`build`/`ui-dist`；旧 UI 从
  tag `old-ui-baseline-g0` 的工作树按需准备。

## 红侧判别（`redside-r44.txt`）

| 编号 | 变异 | 结果 |
|---|---|---|
| RED-M1 | V7 默认恒 `"1"` | `r44_fresh_vs_upgrade_collab_default` 独红 |
| RED-M2 | V6 回填去掉 `address != 'local'` | `r44_v6_shell_integration_backfill_on_old_library` 红 |
| RED-M3 | 去掉版本护栏（`if false`） | `r44_newer_schema_is_refused_without_writing` 红 |
| RED-M4 | 写锁永不失败（`rc=0`） | `r44_single_instance_write_lock` + `r44_backup_and_restore_refused_while_locked` 红 |
| RED-M5 | 契约脚本：注册表移除 `close_session` | exit 1，列出缺失命令 |
| RED-M6 | 契约脚本：参数 `sid`→`session_id` | exit 1，报参数名对不上 |
| RED-M7 | `open()` 把 `journal_mode=WAL` 移回护栏**之前**（复现审核 F1） | `r44_refusal_writes_no_bytes_even_on_non_wal_db` **独红**（其余 9 绿，含原「零写」用例仍绿 → 证其判别力不足） |
| RED-M8 | `restore_from` 核心表校验置空（复现审核 F2） | `r44_restore_refuses_partial_vault_and_keeps_target` + `r44_restore_refuses_non_vault_backup` **红** |
| RED-M9 | `restore_from` 自我恢复守卫置空（复现审核 F7） | `r44_restore_refuses_same_file` **红** |
| RED-M10 | `backup_to` 库存在性守卫置空（复现审核 F8） | `r44_backup_refuses_missing_db` **红** |
| RED-M11 | `restore_from_snapshot` 直接从**来源**读（复现二轮 N-1） | `r44_restore_does_not_touch_source_sidecars` **红**（「不得在来源旁留下 -wal 侧车」，13 passed; 1 failed） |
| RED-M12 | CLI `VaultCmd::Restore` 把预探测 `read_schema_version(&from)` 加回（复现**三轮** N-1 CLI 半边） | 真二进制 `vault restore` 在来源旁**复现** `src.db-shm`/`src.db-wal`，只读目录恢复亦失败 |

全部 Edit 反向还原、无 `MUTANT` 残留；还原后 `cargo test -p tinyssh-vault` 复跑 **46+10 全绿**，
`cargo test --workspace --no-fail-fast` **34 target 全绿 exit 0**（255 passed）。

## 独立审核处置（rev-r44）

首轮**不可签**，两条高阻断均由审核员以**真二进制**复现（非读码推断）：

- **F1（高）** 版本护栏不在「任何写之前」——`journal_mode=WAL` 先于护栏执行，对非 WAL 的
  未来版本库实测文件 sha256 改变。**处置**：新增只读 `ensure_schema_supported()` 并在
  `open()` 中于设 WAL **之前**调用；新增非 WAL 库逐字节断言用例。RED-M7 实证新用例有判别力。
- **F2（高）** `restore_from` 只查 `hosts` 表即认定备份，指向「恰好有 hosts 表的垃圾文件」
  会不可逆销毁真库且无回退（审核员实测真库 11 张表 → 只剩 `hosts`、应用再也打不开）。
  **处置**：校验升级为 **V1 核心表全套**；**先在临时副本上试迁移到链尾再动目标库**
  （原先是「先覆盖、后验证」）；覆盖前**自动留 `<db>.pre-restore.bak` 安全副本**
  （`VACUUM INTO`，含 WAL 内容）；CLI 打印副本路径。RED-M8 实证。
- **F3（中）** `cli-smoke.txt` 是坏 harness——整条命令行被当单个 argv 传入（zsh 不按空格
  分词），7 条命令实际全报 `unrecognized subcommand`，而 README 却宣称「全在且可用」：
  **主张为真、引用的证据相反**。**处置**：改为命令与参数分开传、逐族真调用重跑
  （`cli-smoke.txt` 已重生成，见上）。
- **F4（中）** 「MCP 端点可用」是据 `collab_enabled()` 的**推断**而非实跑。**处置**：README
  措辞降级并显式标注为推断（见上）。
- **F5/F6（低）** 锁粒度是「每个 Vault 对象」而非「应用实例」；护栏拒绝后残留空 `.lock`。
  **处置**：均为**有意为之**——`flock` 独立 fd 互斥换「任何两个写者都不能同时持库」这条
  与进程边界无关的不变量；锁文件**不能** unlink（A 持锁时 B unlink → C 建同名新文件拿到
  独立锁 → 互斥破坏）。已在 `VaultLock` 文档注释里写明理由。
- **F7（低）** `restore_from(from == db_path)` 未被测。**处置**：加显式拒绝 + 用例
  `r44_restore_refuses_same_file`。
- **F8（低）** `backup_to` 对不存在的库会先建空库再备份。**处置**：改为拒绝 + 用例
  `r44_backup_refuses_missing_db`。
- **N-1（低，二轮发现 / 三轮补刀）** `restore_from` 直接以**只读**方式打开**来源**备份校验，
  而只读打开一个 WAL 库仍会写 `-shm`/`-wal` 侧车（wal-index），故会在来源旁留文件、在只读
  介质上失败。**二轮处置（库层）**：改为把来源（连同 `-wal`/`-shm`）拷到私有临时文件
  `<db>.restore.src` 再读，**绝不在来源旁写任何东西**，用后清理；新增用例
  `r44_restore_does_not_touch_source_sidecars`（RED-M11 实证）。**三轮复核指出只修了一半**：
  CLI 在 `restore_from` **之前**仍调 `read_schema_version(&from)`，同样只读打开原始来源 →
  真二进制 `vault restore` 仍漏侧车、只读介质上仍失败。**三轮处置（CLI 层）**：
  `restore_from` 改为**返回**在副本上读出的来源版本，CLI 删掉预探测、直接用返回值
  （RED-M12 实证；`cli-smoke.txt` D 节为真二进制证据）。
- 审核员另指出 README 原「一个字节都不写」的主张**不成立**——F1 修复后该主张对**库文件**
  成立（字节级用例背书）；但严格说拒绝时仍会在库旁留下一个 0 字节 `<db>.lock`（F6），
  故现统一表述为「**库文件逐字节不变**」，不主张「磁盘一个字节都不写」（证据不得超出主张）。
- 审核员确认 **F5 中的 `drop(m2)` 是正当修正**（对照 HEAD 原文核过：原测试确实在 `m2`
  存活时又开了一个 manager，那不是「重启」语义），**非掩盖缺陷**。
- **二轮判定：可签（0 阻断）**——F1/F2 以独立证据真正闭合（真二进制 sha256 / journal 模式
  对照；11 张表在拒绝后原样存活），F3/F4/F7/F8 闭合，F5/F6 为有意接受；二轮新提 **N-1**
  （低）已修并红侧实证（RED-M11）。
- **三轮（对冻结树 `79b2447` 定向复核）**：F1–F8 维持可签、workspace 复跑与作者逐项一致
  （34 target / 0 FAILED / exit 0 / 255 passed）、F2/F7 未回归；但判 **N-1 未闭合——库层修好、
  CLI 层仍泄漏**（真二进制实测）。**三轮处置**：CLI 删预探测、改由 `restore_from` 返回来源
  版本（RED-M12 实证）。
- **四轮（对冻结树 `fec3a1b` 定向复核）：可签（0 阻断）——N-1 两半均已闭合。** 审核员独立
  实证：D1 干净 WAL 来源恢复后来源旁**无** `-wal`/`-shm`；D2 只读目录（`chmod 555`）上的
  备份恢复 **exit=0 成功**；**双向变异**（CLI 预探测加回 → D1/D2 双双复现；库层 `open(from)`
  → `r44_restore_does_not_touch_source_sidecars` 独红）证判别力；F2/F7 未回归；workspace
  **34 target / 0 FAILED / exit 0 / 255 passed** 与作者逐项一致；`cli-smoke.txt` D 节与其实测
  吻合。其确认 `restore_from` 的 `Result<()>→Result<u32>` 为公开 API 变更，全仓调用方仅 CLI
  （已同步）+ 本 crate 测试，无遗漏。
- **「可签」最终适用范围 = 代码面 `fec3a1b`**：`crates/cli/src/main.rs` sha256
  `b07dbeb6…`、`crates/vault/src/lib.rs` sha256 `18f90764…`（审核员复核时的状态）。本提交
  在该树之上**仅追加文档**（`crates/` 逐字节不变），故该「可签」对最终提交同样成立。

## 附带发现与就地修正（非变异）

- 写锁在**既有测试** `r32_tests::r32_restart_recovery_marks_interrupted` 上暴露真实冲突：
  该用例模拟「进程重启」却未 drop 上一个 manager（`m2` 存活到函数结束），新锁下挡住后续
  `open`。**非锁之过**——「同一 vault 两个活着的 manager」正是 §10.2 要禁止的状态。修法：
  用例先 `drop(m2)`（恢复「顺序重启」本意），`crates/core-session/src/r32_tests.rs` 就地修正
  并注明。修后全 workspace 绿。**这是本轮唯一的既有测试改动**，提请审核员重点复核。

## 未主张 / 待人工确认

- **原生 GUI 冒烟 r44：已于 2026-10-10 08:1x 补跑**（屏幕当时已解锁）。旧 UI 在新核心上的
  **真实运行**已取证——旧三栏外壳读到新核心真主机行、渲染新核心 TOFU 指纹门、并跑通一条真实
  SSH 会话 `s-c63bfea4-6dc4-4f40-97de-907160c5c69a`（四张截图 + 审计链见
  `../2026-10-10-r45/native/`）。`tinyssh vault` 与 GUI 并发的真实交互亦已复验：**GUI 持写锁时
  CLI（含只读 `host list`）被拒、第二个 GUI 被拒、GUI 退出后 CLI 可写**——见
  `../2026-10-10-r45/native/write-lock-reverify.txt`。**仍待人工确认**的只剩原生选择器
  （NSOpenPanel，已登记为不可自动化）与窗口红绿灯像素级。
- 旧 UI 契约核对只到**名称/参数名**层面；参数与返回值的**形状**（结构体字段）变化未覆盖，
  须原生 e2e 复验。（补跑只证「旧 UI 能在新核心上跑通主链路」，不等于字段形状全覆盖。）
- **`ui-switch-embed.txt` 的哈希数字仅作者跑过**：独立审核员未重建二进制（未跑任何
  tauri/vite 构建），只做了「当前 `ui/dist` 与 `.worktrees/old-ui/ui/dist` 资源名」的一致性
  旁证。审核员另指出：第一次运行里对照用的新 UI JS 名（`index-7vi38ZWV.js`）是**过期名**
  （当前为 `index-DfV-LLQa.js`），故**该方向的 JS 键对比不构成同键比较**——CSS 同键对比
  （`index-O54pqTGs.css` 两次分别 0 / 1）仍成立，判别结论可接受。此处如实记录该限定。
- **`scripts/ui-switch.sh` 三模式（dev/build/ui-dist）未被独立复跑**；`cargo build --release`
  与 `tsc` 亦未由审核员复跑。
- R43 遗留的原生冒烟 r43a/r43b：**已于 2026-10-10 补跑，全绿**（r43a 12 标记 / r43b 4 标记，
  零重试零跳过）——见 `../2026-10-10-r45/native/README.md` 与 `beacon-r43{a,b}.txt`。
  补跑中修复了 **R43 驱动脚本自身**的两处缺陷（`src-tauri/src/main.rs`，非产品缺陷）。
- **开发期开关移除时机**：按 §10.2「非长期双模式」与 G4 退出条件，`TINYSSH_UI_V2` 与
  `.worktrees/old-ui` 在 **G5 发布候选构建**时移除（已登记于执行状态跟踪）。
