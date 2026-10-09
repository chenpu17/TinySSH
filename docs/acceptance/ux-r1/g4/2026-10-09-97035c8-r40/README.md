# R40 | G4 首轮 —— 端口转发表单、列表与生命周期（§6.6 / S09 / D01-D02）

- 轮次：R40（UX-R1 G4 首轮）
- 基线 commit：`97035c8`（本轮改动**未提交**时的工作树）
- 证据目录：`docs/acceptance/ux-r1/g4/2026-10-09-97035c8-r40/`
- 设计：`docs/ux/ssh-client-ux-refactor.md` §6.6（端口转发表单/列表/生命周期）+ S09 + D01/D02

## 一、本轮实现面

### 契约（session-api）
- 新增 `Error::ForwardListenFailed { field, reason }`：转发监听建立失败，`field` 把错误
  定位到表单字段（`"listen"`=监听地址/端口，含端口占用与非法地址；`"target"`=目标侧），
  供 FE 就地高亮对应输入而非只弹通用提示（§6.6「端口冲突关联到对应字段」/D02）。
- `Error::wire_parts()` 单点映射：kind=`forward_listen_failed`，detail=`{field,reason}`。
- 契约测试 `wire_format_tests::forward_wire_format_matches_ui` 增补断言。

### 核心（transport-ssh）
- `validate_local_listen_addr` 由 T44 的「仅回环」**放宽为「仅拒空」**：§6.6 要求
  「监听地址是显式字段、默认回环；非回环**显示暴露范围并必须主动选择**」——「主动选择」
  由 FE 把关（默认 127.0.0.1 + 非回环警告 + 显式勾选），核心放行。
  既有测试 `local_listen_addr_loopback_only` → 重命名 `local_listen_addr_only_rejects_empty`。
- `start_forward` Local/Remote/Dynamic 三分支的端口非法/目标空/绑定失败统一改为
  `ForwardListenFailed{field:"listen"|"target"}`。

### 会话层（core-session）
- 注册 `r40_tests`（8 项）：人类直建/列表/停止 + 审计留痕、非回环放行、端口冲突字段定位、
  目标字段定位、停止未知 id 后重试、关闭会话影响计数、接管期 Agent 拒绝、未注册会话。

### MCP
- `error_kind`/`error_detail` 两个穷尽 match 增补新变体（否则 E0004 非穷尽）。

### 前端（ui）
- **表单（§6.6）**：类型 `<select>` 三项解释为人类语义（「本地端口访问远端服务（-L）」/
  「远端端口访问本机服务（-R）」/「SOCKS5 代理（-D）」）；监听地址是**显式字段**（默认
  127.0.0.1）；非回环时出现 `[data-testid="fwd-expose"]` 暴露范围确认行，**未勾选则拦截启动**；
  目标行标注解析端（-L「目标（远端侧解析）」/ -R「目标（本机侧解析）」）。
- **字段级错误**：`fwd-err-listen` / `fwd-err-target` 就地高亮；核心 `forward_listen_failed`
  经 `parseWireError` 按 `detail.field` 定位（其余走通用 toast）。
- **列表行**：人类可读路线（`127.0.0.1:8080 → 10.0.0.31:5432` / `远端 … → 本机 …` /
  `SOCKS5 …`）；「监听中/监听失败」chip 与「目标可达性未验证（首次连接时确认）」/「目标不可达：…」
  **分开显示**——不把「正在监听」表述为服务健康。
- **停止**：等待核心结果（`await stop_forward` 后 `refreshForwards`），失败保留行 + 「重试停止」。
- **关闭会话影响计数**：`list_forwards` 计数即影响面（既有 R23 面，本轮随转发列表延续）。
- **demo 镜像**：`start_forward` 同口径校验 + `forwardConflictPorts` 冲突注入 +
  `demo_forward_conflict` 钩子（demo 无真实监听，冲突以钩子模拟）。

### 原生冒烟（src-tauri）
- 新增 `r40_smoke_script`（`TINYSSH_SMOKE_MODE=r40a|r40b|r40c`，dev 门控）：UI 建转发
  （真监听、真隧道），外部驱动经 `127.0.0.1:<port>` 打**真流量**（容器 sshd banner）对账；
  应用↔驱动经 beacon 共享日志同步（应用 `/q` 轮询驱动写入的标记）。

## 二、验证证据（见本目录各文件）

| 证据 | 文件 | 结果 |
|---|---|---|
| demo 探针 ×3 | `probe-run1/2/3.txt` | 23/23 ×3（**处置后重跑** 23/23 ×3） |
| 旧码判别 | `oldcode-run.txt` / `oldcode-run2.txt` | 基线 97035c8 worktree（:5184）4/18 ×2（14 项 R40 专属红） |
| workspace 测试 | `workspace-tests.txt` | 32 套件 **0 FAILED**（无 `TINYSSH_E2E_SSHD`：容器用例按设计跳过） |
| core-session lib | — | **86/0**（78 基线 + 8 项 r40_tests；团队早前记 78 系笔误，审核更正） |
| session-api | — | **10/10**（本轮启用一条此前无 `#[test]`、从未运行过的转发 wire 契约测试，见审核低-1） |
| sshd e2e | `sshd-e2e.txt` | **7/7**（真机容器） |
| 回归 R31/R32/R33/R34/R35/竞态 | `reg-r31/r32/r33/r34/r35/race.txt` | 48/22/36/35/34/6 全绿（**处置后重跑**） |
| 原生冒烟 ×2 | `smoke-run1/2-beacon-r40a/b/c.txt` | r40a/b/c 全绿 ×2（处置后重建二进制） |
| tsc | — | 0 |

**两项既有环境问题（如实登记；均经基线对照证明与 R40 无关）**

1. **`core_local::gbk_charset_roundtrip_over_ssh` 在带 `TINYSSH_E2E_SSHD=1` 时稳定失败**
   （`ShellIntegrationUnavailable { integration_present:false, prompt_ready:false, host_setting:true }`，
   `core_local.rs:665` 的 `exec` 处，0.63s 即回）。根因：`run_shell`（`handle.rs:244`）对 SSH 会话
   在集成未就绪时**立即拒绝、不等待**，而集成注入是后台化的（`handle.rs:964/983`）——该用例
   `create_session` 返回后立刻 `exec`，本质是竞态。**基线对照**：把本轮全部改动 `git stash`
   后逐字同错（×2）；容器 bash 经 expect 实测**确会**发 OSC133（`^[]133;D;0^G`），故非容器能力缺失。
   **归档口径更正**（rev-r40b 独立指出并经作者复核）：R31/R33/R34 同日归档里该用例的 `ok`
   是**未设 `TINYSSH_E2E_SSHD` 的 skip-pass**（同批 `sshd_e2e` 收尾仅 2.21s = 7 项全 skip 的签名，
   真跑需 27–44s），**不是真跑通过**；仓库内不存在「设 env 且该用例真跑通过」的归档。
   故本轮如实结论仅为：**设 env 时该用例稳定失败，且该失败与 R40 无关**（基线逐字同错、
   R40 diff 未触及 shell 集成 / `run_shell` / `core_local.rs`）。作者做过的容器 restart /
   `dev-sshd.sh` 重建均未改变。**该失败不进入本轮结论。**
2. **`sshd_e2e::ssh_shell_blocks_and_fresh` 偶发**：独占运行 10 次失败 3 次（该用例源码自带
   「环境抖动兜底（共享容器偶发空流）」注释，作者已知其环境偶发）；对照 `git stash` 后 6 次全绿。
   与转发无关；R40 专属的 `forward_local_and_dynamic_roundtrip` 在全部运行中均通过。

**结论**：R40 自身面（core-session r40_tests 8/8、transport-ssh lib 3/3、session-api 10/10、
demo 探针 23/23 ×3、原生冒烟 ×2、六套回归全绿、tsc 0）全部为绿；上述两项为环境面既有问题，
以基线对照隔离。

## 三、独立审核

### 三之一、代码审核（rev-r40b）——**可签**

首任审核员 rev-r40 失联（两次催收无响应、磁盘无产物），改由 **rev-r40b** 在冻结树上独立重审
（树指纹 `styles.css` md5 `7da2c33460c5f7712c1792fea3239bae` / `git diff` md5
`236b8532670a496f3eb0086500251eb7`，与其自查一致；判定前重取一致）。

**独立复跑**：core-session lib 86/0（r40_tests 8/8 逐项）、workspace 32 套件 0 FAILED（**无 env**）、
tsc 0、demo 探针 23/23、sshd_e2e 7/7。**该审核员随后自查更正**：其首轮的「sshd_e2e 7/7 真机」实为
**未设 `TINYSSH_E2E_SSHD` 的 skip-pass**（其首轮未设 env），已主动撤回；**设 env 的真机 7/7**
由定向复验轮给出（见下）。首轮「workspace 32 套件 0 FAILED」同样是无 env 口径（容器用例全 skip），
与本 README 表格口径一致。
**红侧判别力**（变异→复跑→红→Edit 反向还原→md5 对账）：
① 摘除 FE 暴露闸 → 探针 A7b 独红 22/23；② demo 冲突分支 `field:"listen"→"target"` → C1 独红 22/23；
③ r40_tests stub 目标分支变异 → `r40_target_field_error` 独红 7/8；④ **生产** `transport-ssh`
目标分支 `"target"→"listen"` → **三层全绿、未检出**（= 发现中-1）。

发现清单与处置：

| 编号 | 严重度 | 发现 | 处置 |
|---|---|---|---|
| 中-1 | 中 | 生产 `start_forward` 的 `field:"target"` 映射**无判别性覆盖**：r40_tests 用的是测试内手写 stub，sshd_e2e 只覆盖 bind 失败（listen）。把生产 `"target"` 写错 → transport-ssh/core/sshd_e2e 三层全绿（变异 ④ 实证） | **已闭合**：sshd_e2e 的 `forward_local_and_dynamic_roundtrip` 增 3 条**走生产路径**的目标侧非法断言（Local 空目标 / Local 端口 0 / Remote 空目标） |
| 低-1 | 低 | `session-api::wire_format_tests::forward_wire_format_matches_ui` **缺 `#[test]`**，从未运行（先于本轮存在；编译告警 `never used` 即明证）。本轮新增的 `ForwardListenFailed` wire 断言落在有 `#[test]` 的 `c6_collision_wire_format` 里，故本轮面不受影响 | **已闭合**：补 `#[test]`，运行通过（session-api 9→10） |
| 低-2 | 低 | README 取向登记把本轮新增的 `.xfer-sub.warn` 误述为「R34 遗留未处置面」；实际其背景是 `.card`(`--panel2` 白)，`--warn` 4.55:1 过 AA，无缺陷 | **已闭合**：更正文档措辞 |
| 低-3 | 低 | 暴露确认勾选**不随监听地址编辑复位**（仅类型切换时复位）：对 `0.0.0.0` 勾选后改成另一非回环值仍可直接启动，§6.6「非回环须主动选择」在改址路径被弱化 | **已闭合**：监听地址 `onChange` 同时 `setFwdExposeAck(false)` |
| 低-4 | 低/观察 | Agent 经 MCP `forward_start` 的审批卡 `forward_desc` 含监听地址，但无 FE 那句显式暴露说明 | **登记备查**（可接受：地址可见，且 Agent 路径恒经逐段人工审批） |

**审核员对团队长点名方向的判断**：非回环闸仅 FE 把关**可接受**（唯一非 UI 调用方 MCP 恒
`Actor::Agent` 且经审批；CLI 无转发子命令；tauri 用 `Actor::Human` 即 FE 路径）——核心放行
非回环是必需的，否则 FE 无法透传用户显式选择；`validate_local_listen_addr` 放宽**非回归**
（仅两处调用，无其他依赖；安全姿态由「核心强制」变为「FE 强制 + Agent 审批」）；停止确实
`await` 核心结果；关闭会话影响计数与 `list_forwards` 同源；字段级错误四处契约一致（未知
`field` 降级为 `listen`，`reason` 恒非空）。

审核员如实声明未跑：六套回归探针、旧码判别、原生冒烟（不在其清单内，不背书）；视觉测量未复做。

### 三之一（续）、处置后定向复验（rev-r40b）——**维持可签**

- **中-1 闭合**：重复其变异 ④（生产 `lib.rs` 974/995 `"target"`→`"listen"`）→
  `forward_local_and_dynamic_roundtrip` **独红**（`sshd_e2e.rs:602` 断言捕获 `field:"listen"`），
  由「三层全绿未检出」变为「独红」；Edit 反向还原后 `lib.rs` md5 回 `409fca6b…`、
  代码面 diff md5 回 `dd59a6e4…`，再跑 e2e 7/7。
- **低-1 闭合**：`session-api` 10/10，`forward_wire_format_matches_ui ... ok` 可见。
- **低-3 闭合**：审核员自写探针 14/14 正反两面实证——`0.0.0.0` 勾选后改址 `192.168.1.5`
  → 勾选**复位**为 unchecked、启动再被拦、无转发创建；反向（`192.168.1.5`→`0.0.0.0`）同样复位。
- **低-2 闭合**（文档措辞）、**低-4** 登记未改。
- **环境归因的独立判断**：① gbk 竞态**成立**（机制核实一致）；但**纠正作者**——R33/R34 归档的
  `gbk ... ok` 是 **skip-pass**（同批 `sshd_e2e` 仅 2.21s = 全 skip 签名），**仓库内无设 env 真跑通过记录**，
  故「早前真跑通过、今日变快后判负」的因果叙事无据（本 README 已按此更正）。② `ssh_shell_blocks_and_fresh`
  偶发**成立**（其独占复跑 8 次败 3，与作者 10 次败 3 同量级）。
- 审核员声明：本轮为定向复验，未重跑全量 workspace / 六套回归 / 旧码判别 / 原生冒烟 / tsc
  （处置未动 TS 类型面，探针 Z 零 JS 错佐证）；未修改生产代码（唯一变异已 Edit 还原并 md5 对账）。

### 三之二、视觉复验（vis-r40）首轮 → 处置 → 定向复验

首轮结论 **不可签（blocking: F1）**，三项发现（均在 `ui/src/styles.css`，本轮新增面）：

| 编号 | 严重度 | 问题 | 处置 |
|---|---|---|---|
| F1 | 高/阻断 | 非回环暴露确认行的警告正文**完全不可见**：全局 `input, select { width:100% }`（styles.css:283）未被 `.fwd-expose input` 重置 `width`，勾选框被拉成整行宽（363px @1280），把同 flex 行的 `<span>` 推出面板右界（spanX 1283 > panelRight 1280），`.tp-scroll` scrollWidth 422 > clientWidth 383。§6.6 要求对暴露范围「主动确认」，而用户看不到自己在确认什么 | `.fwd-expose input` 补 `width:auto; padding:0` |
| F2 | 中 | 深色 `.section h4` / `.ah-field label` 用 `--dim` = 3.41:1，低于 AA 4.5（浅色 5.25 达标） | 二者改 `--text-sub`（深 7.40 / 浅 6.44） |
| F3 | 低/潜伏 | 浅色 `.fwd-expose` 正文 `--warn` #96700a 在 `--panel` #f4f6f8 上 4.20:1（原按 `--panel2` 白底调的），F1 修好后即暴露 | 新增 `--warn-text`（浅 #8a6409 = 4.96:1；深同 `--warn`）；`.fwd-expose` 与同族 `.fwd-state.warn` 改用它 |

同族潜伏面一并收口（越 F3 字面范围，如实登记）：`.fwd-kind.remote` 亦为「面板底 + `--warn`」，
浅色同为 4.20:1，一并改用 `--warn-text`（浅 4.20→4.96，深色不变）。

**作者侧 sanity（非审核证据）**：处置后 1440×900 / 1280×800 / 1024×768 × 双主题实测
勾选框 13px、警告 span 均在面板右界内、`.tp-scroll` 横向溢出 0；探针 23/23 ×3；六套回归全绿。
定论以 vis-r40 定向复验为准（见下）。

**vis-r40 定向复验结论：可签**（`vis-r40-recheck-findings.json`；38/38 checks pass、对比度 18/18 达标、
双主题 0 JS 报错；树指纹 styles.css `7da2c33460c5f7712c1792fea3239bae` / diff `236b8532670a496f3eb0086500251eb7`，
与其被审树逐字节一致）：

- F1 **closed**：勾选框实测 13px（原生尺寸）@ 三视口 × 双主题；警告 span 在面板右界内
  （1280×800 spanX=926 w=344 / panelRight=1280）；`.tp-scroll` scrollWidth == clientWidth
  （383=383、798=798，0 横向溢出）；点击警告文本可切换勾选框。
- F2 **closed**：深色 `.section h4` / `.ah-field label` = 7.40；浅色 6.44（阈 4.5）。
- F3 **closed**：浅色 `.fwd-expose` 正文 4.96、深色 8.54；深色无回退。
- 同族复验：`.fwd-kind.remote` 浅 5.37（原 4.20）、`.fwd-state.warn` 浅 5.37、`.listen` 6.97、
  `.err` 5.32；`.xfer-sub.warn` 未改（浅 4.55 恰在阈上，非本轮项）。
- 节外回归：文件面板 / 协作面板 / 传输抽屉双主题正常；浅色 `.section h4` 转 `--text-sub` 后更暗，
  但 10px + 字距 + 加粗仍明显弱于卡片正文 `--text`，层级不冲突（抽查 审批/任务目标/远程文件）。
- 如实声明未测：原生 Tauri 专属面（真实监听、真实 Degraded/Failed 行态，仍为 demo 域 +
  注入桩测色）；真实端口占用（仅钩子模拟）；`add-host` 等其它消费 `.ah-field label`/`.section h4`
  的全局改色面未逐一截图（抽查三面板）。

## 四、取向登记 / 已知边界

- demo 转发为页面内存注册表（无真实监听）；端口冲突由 `demo_forward_conflict` 钩子注入，
  真实面=transport-ssh sshd_e2e 的真流量 + 端口冲突字段错误 + core r40_tests。
- 非回环「主动选择」由 FE 把关，核心只拒空——MCP/Agent 直调 `start_forward` 传非回环地址
  时无 FE 把关（见独立审核结论）。
- 视觉处置仅改 `ui/src/styles.css`；F2 为全局共用样式（`.section h4` / `.ah-field label` 在
  各面板均生效），改动方向为对比度单向提升，深浅两色均未回退。
- `.xfer-sub.warn` / `.xfer-sub.err` 系**本轮 styles.css 新增**（非 R34 遗留面，审核低-2 更正），
  且仅被转发行健康文本使用（`App.tsx` 转发行状态）；转发行是 `.card`（浅色背景 `--panel2` #ffffff），
  `--warn #96700a` 在白底实算 4.55:1（AA 过，vis-r40 复测一致）。前述 4.20:1 是 `--panel` 上的数字，
  不适用于该处背景——故此处**非缺陷、无需处置**。
