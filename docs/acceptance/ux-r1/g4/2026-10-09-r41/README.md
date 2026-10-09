# R41 | G4（活动记录、详情与凭据设置）——§6.6 尾 / S09-S11 / §193 / §231 / §238 / §267 / §269 / §307

- 轮次：R41（UX-R1 G4 第 2 轮）
- 基线 commit：`f6ea990`（R40 归档点；本轮改动**未提交**时的工作树）
- 证据目录：`docs/acceptance/ux-r1/g4/2026-10-09-r41/`
- 设计：`docs/ux/ssh-client-ux-refactor.md` §6.6（连接详情 / 活动记录 / 凭据设置）+ S09/S10/S11
  + §5 迁移表 + §193 / §231 / §238 / §267 / §269 / §307
- 验收（交付文档第 98 行）：**当前/全局过滤、完整身份、记录连续；凭据引用不损坏**

## 一、本轮实现面

### 契约（session-api）

- 新增 `SessionDetail`：连接详情 = **连接当时**的完整身份快照 + 会话运行时态。
  字段：`id / host_id / host_name / kind / state / control_owner / created_at / integration`
  + `address / port / username / auth_type / fingerprint / charset`。
  与 `SessionInfo` **分开**的理由写在类型注释里：地址/端口/用户/认证/指纹/编码都在 `Host` 上，
  而主机配置在会话存续期内可被编辑或删除（§6.1「删除配置不停止已存在会话，在活动标签保留
  连接时的主机信息」）——故建会话时对 `Host` 取快照，**不能**在查看时按 `host_id` 回查当前配置，
  否则会把「连接时的身份」换成「现在的配置」。
- `trait SessionApi` 增 `session_detail(ctx, sid)`（未注册会话 → `SessionNotFound`）。
- `AuditFilter` 增两字段：
  - `actor_kind: Option<String>`（`"human" | "agent"`）——§6.6「可筛人类/Agent」。
    与既有 `agent_id` **正交**：后者定位某个 Agent，前者只分两类；未知值不匹配任何行
    （如实返回空，不静默降级为「不过滤」）。
  - `before_seq: Option<i64>`——**翻页游标**（只取 `seq < before_seq`），不是过滤条件。
    offset 分页会在新事件入链后错位/重复，`seq` 是主键自增，游标才连续（§6.6「记录连续」）。
- 契约测试 `r41_session_detail_wire_format`：锁定 `state/control_owner/auth_type/charset/
  integration/created_at/fingerprint` 的线上形态（枚举串、`charset` 显式 rename `"utf-8"|"gbk"`、
  RFC3339 UTC）、`fingerprint: null` 如实（不虚构占位）、**旧载荷兼容**（无 `integration` 字段的
  载荷反序列化回落 `Disabled`）。改这些即 wire 变更，UI 与 demo shim 同步。

### 审计存储（tinyssh-audit）

- `AuditStore::query`：`actor_kind` 进动态参数化 WHERE；`before_seq` 走**独立于计数**的第二段
  WHERE——先按过滤条件 `COUNT(*)` 得 `total`，再加游标取当页。
  关键点：**`total` 报过滤后总数，不随翻页缩水**（否则界面「共 N 条」会一页页变小）。
- 新增单测 `seq_cursor_paging_is_continuous_and_total_is_stable`：全量分页 → 相邻两页不重不漏、
  `total` 稳定；**新事件入链后**按游标继续翻页仍不重复且 `total` 跟上；过滤器 + 游标组合时
  `total` 只反映过滤条件、游标不参与计数。

### 会话层（core-session）

- `SessionHandle` 增 `created_at`（构造期一次写入，之后不变）。**修一个既有缺陷**：
  `list_sessions` 此前填 `chrono::Utc::now()`——即「查询时刻」，每次轮询都变；详情里的
  「创建时间」因此是假值。R41 改为构造期快照，`list_sessions` 与 `session_detail` 同源。
- `session_detail` 实现：从注册表取 handle（`SessionNotFound` 兜底）→ 取运行时态 → 以 handle
  持有的构造期 `Host` 副本组装（不查主机库）。
- 注册 `r41_tests`（7 项）：
  `r41_detail_is_connection_time_snapshot` / `r41_detail_created_at_is_real_and_stable` /
  `r41_detail_unknown_session` / `r41_audit_scope_and_actor_kind_filter` /
  `r41_audit_seq_cursor_paging_is_continuous` / `r41_records_survive_session_close` /
  `r41_identity_delete_checks_host_refs`。

### MCP

- `error_kind` / `error_detail` 两个穷尽 match 增补（否则 E0004 非穷尽）。

### 前端（ui）

- **连接详情（§6.6 / S09 / §193）**：**独立可关闭对话框**（`data-testid="conn-detail"`），
  不放右栏——§193 明确不与审批共用长滚动页。展示连接**当时**身份（`cd-host/cd-addr/cd-port/
  cd-user/cd-auth/cd-fp/cd-charset/cd-created`）+ 技术详情区可复制会话 ID（`cd-sid` + `cd-copy`）。
  指纹为空时如实显示「未记录」（不虚构）。取数走 `session_detail`（后端快照），非按 `host_id`
  回查现配置——主机改过名/改过址/被删除，详情仍是连接当时的值（§6.1）。关闭三条路：遮罩、✕、Esc。
- **活动记录（§6.6）**：**可展开工作区视图**（右栏任务面板 `log` 态，窄窗转 `tp-full` 中央完整
  视图），**非对话框**、**不寄生协作面板**（自带查询与翻页状态）。
  - 范围：默认**当前会话**（`log-scope-current`），可切**全部**（`log-scope-all`）。
  - 筛选：人类/Agent（`log-actor`）与事件类型（`log-action`，候选 = `auditLabel` 全集 + `goal_set`，
    按中文名排序——`goal_set` 下拉显示「更新/清除任务目标」而非原始动作名）。
  - 时间戳含**日期**（与 hhmm 纯时刻分开，跨天可定位），标题带本机时区偏移说明（`log-note`）。
  - **保留主机/会话身份**：会话关闭后即从 `sessions` 消失，故前端累积 `sid → 主机名` 映射
    （`logMetas`），记录里缺映射时如实显示短 id，不虚构。
  - 翻页：「加载更早」按 `beforeSeq` **seq 游标**取下一页（连续、不重不漏），`total` 恒为过滤后总数。
  - 请求**代次**（`logGenRef`）：切范围/筛选/会话会连发多条查询，只认最后一次发出的那一代，
    过期响应直接丢弃——否则先发后到的旧筛选结果会盖掉新结果。
  - 「当前会话」但**无会话**时不发查询：`sid` 为 null 时照常下发会**退化成全局查询**，而正文已渲染
    「未接入会话」空态——标题却按全局总数宣称「共 N 条」，两处自相矛盾。故直接落空态并作废在途响应。
- **凭据设置（S11 / §231 / §238 / §267 / §269）**：设置改为**左分类 + 右内容单对话框**
  （`settings-close`；分类含外观 / 终端 / 凭据）。
  - 凭据类目下新建走**显式提交**（`cred-new` → `cred-new-form`：标签 + 生成 Ed25519/RSA 或粘贴私钥），
    提交成功后**销毁前端敏感字段**（§269：明文不留在通用状态里）。
  - 未绑定凭据有独立空态（`cred-empty`）；「授权使用」如实列出占用者（`cred-uses`，§267）。
  - **切分类遇未提交敏感草稿先处置**（§231）：`cred-draft` 确认框，两个出口——「留下继续编辑」
    （`cred-draft-keep`）与「丢弃草稿并切换」（`cred-draft-discard`）。
  - 关闭设置即销毁草稿——凭据库里没有半成品。
- **demo 镜像**：`session_detail` 取 `host_snapshot`（建会话时对主机取快照，与真实侧构造期副本同
  语义）；`audit_query` 同后端口径（sid / actor_kind / action 三过滤 + `beforeSeq` 游标，
  `total` 报过滤后总数）。`list_sessions` 补 `integration: "Disabled"`（demo 不做 shell 集成注入）。

### 原生冒烟（src-tauri）

- 新增 `r41_smoke_script`（`TINYSSH_SMOKE_MODE=r41a|r41b|r41c`，dev 门控）三阶段：
  - **r41a** 连接详情（连接时快照）：完整身份 / 日期时区 / 会话 ID 复制；**改主机库后仍是连接当时
    身份**；独立关闭详情不影响会话。
  - **r41b** 活动记录（真审计库）：工作区视图 / 当前-全部 / 类型与人类-Agent 筛选 / 游标翻页连续 /
    关闭后留痕带主机身份。
  - **r41c** 凭据设置（真 vault）：左分类单对话框 / 显式提交 / 未绑定态 / 草稿处置 /
    引用检查删除被拒。
- 应用 ↔ 驱动经 beacon 共享日志同步（`/tmp/smoke-r41/beacon-r41{a,b,c}.txt`，每阶段归档后清空）。

## 二、验证证据（见本目录各文件）

| 证据 | 文件 | 结果 |
|---|---|---|
| demo 探针 ×3 | `probe-run1/2/3.txt` | **45/45 ×3**（处置后重跑） |
| 旧码判别 | `oldcode-run1.txt` / `oldcode-run2.txt` | 基线 `f6ea990` worktree（:5184）**2/45 ×2**（两次红集完全一致，**43 项 R41 专属红**；仅 `A6`（详情不出现私钥明文）与 `Z`（零 JS 错）在基线上也通过） |
| 红侧判别（4 刀） | `redside-r41-fixes.txt` | 每刀**独红**：遮罩层级→M2+N2（43/45）；分屏菜单层级→N1+N2（42/45）；低-1→D4（44/45）；低-2→L1（44/45）。Edit 反向还原后 md5 逐字节一致 |
| workspace 测试 | `workspace-tests.txt` | 32 套件 **0 FAILED**（无 `TINYSSH_E2E_SSHD`：容器用例按设计跳过） |
| core-session lib | `workspace-tests.txt` | **93/0**（86 基线 + 7 项 r41_tests） |
| audit lib | `workspace-tests.txt` | **3/0**（2 基线 + 1 项游标翻页） |
| session-api | `workspace-tests.txt` | **11/11**（10 基线 + 1 项 `r41_session_detail_wire_format`） |
| 回归 R31/R32/R33/R34/R35/R40/竞态 | `reg-r31/r32/r33/r34/r35/r40/race.txt` | **48 / 22 / 36 / 35 / 34 / 23 / 6** 全绿 |
| 原生冒烟 ×3 | `smoke-run1/2/3-beacon-r41a/b/c.txt` | r41a/b/c **ALL PASS ×3**（三阶段 beacon 各 0 条 `FAIL`/`JS-ERROR`/`JS-REJECT`） |
| tsc | — | **0** |

**指纹对账**（审核/复验判定前重取，与本 README 一致）

- 产品码面（`crates` + `ui/src` + `src-tauri`，排除 `docs`）`git diff HEAD` md5 = **`bb3fa4ce193f59080b2630ba0e5e5e1d`**，11 文件 +1176/−76
- 全树 `git diff HEAD` md5 = **`81f27ce8a8fa7d480f79db49d73f1bf4`**，12 文件 +1178/−78
- 单文件：`ui/src/App.tsx` = `a53150588f3f6accd579636b015a5a40`；`ui/src/styles.css` = `c22384e21cdda239212c33e9230e9c34`
- 未跟踪：`crates/core-session/src/r41_tests.rs`、本证据目录

**回归口径的如实说明**：R32/R34 的**原始**探针（各自验收目录内）在当前树上必红——R35 已把传输卡
从文件面板移入工作区底部抽屉（§194），而那两个探针按「卡片在文件面板内」取样。故 R32/R34 的回归
证据用的是 R35 轮**适配过**的 `r32-regress.js` / `r34-regress.js`（存于 `g3/2026-10-09-e29df10-r35/`），
与 R35 归档同源、同数（22/22、35/35）。

**判别力口径的如实说明**

- **demo 探针**：R41 新增面 43 项在基线上全红（`oldcode-run*.txt` 两次同集），是主判别面。
- **红侧刀**：四把刀各自独红，且还原后 md5 与被审树逐字节一致（还原一律用 Edit 反向改回，未用
  `cp` 整文件写回）。
- **原生冒烟**：**结构性无法做红侧判别**——`r41_smoke_script` 本身就在 R41 diff 内，基线二进制没有
  该脚本（`TINYSSH_SMOKE_MODE=r41*` 无分支可走）。故原生冒烟的「绿」是**端到端可用性证据**，
  不是判别力证据；判别力由 demo 探针 + audit 单测 + r41 core 测试（依赖新 API）承担。
- **低-4（请求代次）**：demo 的 `invoke` 是**串行**的，无法制造乱序响应——该项**仅代码级**，
  探针无行为断言（如实登记，不充作已证）。

## 三、独立审核

### 三之一、代码审核（rev-r41）——首轮 **可签（0 阻断）**

首轮在指纹 `b1353211…` 上给出 **可签**，附 4 条低发现（低-1 ~ 低-4）。其独立复跑与独立红侧：

- 独立红侧（`session_detail` 快照语义）：把 `session_detail` 改为按 `host_id` 回查现配置 →
  **恰一项独红**；还原后复跑恢复。
- 独立新增审计游标用例（2 项通过后自行删除，未留痕于树）。
- 如实声明**未跑**：六套回归探针、旧码判别、原生冒烟、tsc 之外的全量 workspace（清单见其报告 §9）。
- §8.1 指出**作者侧探针 H1 为探针时序缺陷**（作者归档的运行实为 38/39）；§8.2 **主动撤回**其自身
  早前对 R34 回归的怀疑（原因是它当时用了 R35 之前的旧探针）。

发现清单与处置：

| 编号 | 严重度 | 发现 | 处置 |
|---|---|---|---|
| 低-1 | 低 | 活动记录「事件类型」下拉直接显示原始动作名 `goal_set`，与其余项的中文标签不一致，用户对不上自己筛的是哪一项 | **已闭合**：候选集 `Object.keys(AUDIT_LABELS) + "goal_set"`，`goal_set` 映射为「更新/清除任务目标」，整体按中文名排序；探针 D4 断言该 option 文本 ≠ `goal_set` 且含「任务目标」 |
| 低-2 | 低 | 「当前会话」范围下**无会话**时仍下发 `sid: null` 查询 → 退化为全局查询，正文渲染「未接入会话」空态而标题按全局总数宣称「共 N 条」，自相矛盾 | **已闭合**：`logScope === "current" && !sid` 时直接落空态、作废在途响应、不发查询；`log-note` 改述「未接入会话，无可显示记录」；探针 L1 断言 note 不含「共 N 条」、行数 0、`log-empty-nosession` 存在 |
| 低-3 | 低 | 客户端常量 `HIDDEN_AUDIT_ACTIONS` 隐藏 `shell_integration_inject`，与后端分页 `total` 口径不可调和（隐藏与「共 N 条」互相矛盾） | **已闭合（行为变更，见取向登记）**：删除该常量与寄生协作面板的 `timeline` 状态；活动记录成为**完整留痕视图**，`shell_integration_inject` 现会出现在记录中 |
| 低-4 | 低 | 切范围/筛选/会话会连发多条查询，响应可能乱序到达（原生 IPC 并发执行命令），先发后到的旧筛选结果会盖掉新结果 | **已闭合（代码级）**：`logGenRef` 请求代次，非当前代的响应直接丢弃（不 setState）；demo `invoke` 串行故**无行为断言** |

### 三之一（续）、处置后定向复验（rev-r41）——**不可签（首轮）→ 处置 → 二轮可签**

**首轮定向复验：不可签**，两个独立理由（复验期**发生第二次树移动**，其按纪律不对移动中的树出终裁，
两个状态分别记录）：

| 编号 | 严重度 | 发现 | 处置 |
|---|---|---|---|
| **C-1** | **阻断** | 交办指纹 `36f149dd…` 上 B5 已修（其红侧实验 20:01 前完成并核回 `52d2b426…`），但 **20:07:42 有一次来源不明的写入**把 `.pop-mask`/`.term-settings` 退回 HEAD 原值 **29/30**，注释却仍写「41/42」——代码与注释不一致，且作者探针 M1 在该状态实测红。写入来源双方均未能归因（rev-r41 侧已还原；vis-r41 的 recheck2 探针只写 `recheck2-raw.json`，不碰产品码） | **已闭合**：重新落为 41/42（并见 C-2 的追加修复） |
| **C-2** | **阻断** | 在 `36f149dd…` 的 41/42 修法下，`.split-menu`（z-index 30，与 `.pop-mask` **同父兄弟**）被抬到 41 的遮罩**整块盖死**——菜单项中心 hit-test 命中 `pop-mask`，**真鼠标点击**实测分屏从未进入；反向对照（29/30 状态）同一点 `hitSelf=true` 可正常选中 ⇒ 该破坏由本次改动引入 | **已闭合**：同族浮层一并抬到遮罩之上——`.split-menu` 30 → **43**（rev-r41 已用运行时注入独立验过 41/42/43 组合可行，现落成产品码） |

**其余 4 项在该指纹上已验绿并做了红侧判别**：低-1（下拉末项=「更新/清除任务目标」、无项回落原始键名；
摘掉映射 → 仅 1a/1b 红 ⇒ 列表渲染与下拉改名解耦）、低-2（经 UI 关闭全部会话后标题=「未接入会话，
无可显示记录」、行 0、`log-empty-nosession` 在；还原守卫 → 复现「共 10 条（当前会话）」且 rows=0）、
低-3（全仓无 `HIDDEN_AUDIT_ACTIONS`/`visibleTimeline`/`setTimeline` 定义；demo.ts 插桩实测面板关闭
7s 内 `audit_query=0` 而 `list_sessions=2`，开面板后 `audit_query=1`）、B5（`tp-full=40 < pop-mask=41
< term-settings=42`；1024×768 详情中心点命中对话框、2/2 可交互元素可达；改回 29/30 → 5b/5c/5d 独红）。
**低-4 仍如实标为「代码面确认、未实测」**（demo 域 invoke 串行）。

其本轮只跑 demo 域定向探针与 `tsc`；**未跑**：视觉对比度像素级测量与截图比对、原生冒烟 r41a/b/c、
原生 GUI 键盘/焦点走查、reg-r31/r32/r33/race、旧码判别、MCP 与 `src-tauri` 真实 IPC 往返。

**二轮定向复验（C-1 + C-2 处置后）：可签（无阻断项）**——判定指纹 = 本 README 的最终指纹
（`bb3fa4ce…` / `81f27ce8…` / `App.tsx a5315058…` / `styles.css c22384e2…`），取自工作树本身
（非隔离副本），本轮未再移动；其红侧改动已 Edit 反向还原并逐字节核对 md5。要点：

- **C-1 已闭合**：实测 `.pop-mask` 41 / `.term-settings` 42 / `.split-menu` 43，且**注释与代码一致**
  （无增补二中「注释说 41/42、代码是 29/30」的不一致）。
- **C-2 已闭合**：真鼠标点击菜单项，capture 期 target = `["ghost icon-btn","ghost sm-item"]`
  （**不是** `pop-mask`），按钮标题变为「退出分屏（会话保留不断开）」——确实进入分屏；红侧判别
  （Edit 把 `.split-menu` 改回 30）→ target 变为 `pop-mask`、未进分屏，仓库探针 **N1/N2 独红
  （42/44）**，改回 43 后还原 ⇒ 该修复是**承重的**。
- **M/N 四项它独立复现全部通过**：M1（`inDetail=true`）、**M2 它另写 9×9 网格独立交叉验证**——
  面板内、对话框外 39 个取样点 **39/39 全被 `.pop-mask` 接住、零泄漏**、N1（真鼠标点击 + capture
  target 对账）、N2（读码 + 计算样式）。仓库 `r41-demo-probe.js` 独立复跑 **45/45**。
  它明确认可 M2 是**必要补充**：「只降遮罩（29）时 M1 仍绿（对话框自身可达），但面板仍可点、
  模态形同虚设——M1 单条测不出该退化」。
- **它未采信 vis-r41 关于 `.split-menu 43 > .term-settings 42` 的纯推断**，另做独立可达性实证
  （`/tmp/r41-cooccur-probe.js` 6/6）：方向 A（设置打开→想开分屏菜单）分屏钮中心命中 `pop-mask`、
  真点击只关设置；**穷举 ⌘\、⌘⇧\、⌘2、⌘d、⌘⇧d 均不打开分屏菜单**，且全仓 keymap 无开分屏菜单的
  键盘路径；方向 B 同理（⌘, 被 `modal` 门控挡住，`modal` 含 `splitMenu`）。⇒ 二者**双向不可共存**，
  43 > 42 无任何可达后果，定性成立。
- **它给的备选（本轮未采纳）**：若想消掉这个语义疙瘩，存在**零成本重排**——把两者**互换**为
  `.split-menu` 42 / `.term-settings` 43（已用运行时注入实证 4/4：分屏仍可点、B5 仍成立、
  confirm(90) 仍压设置），即「模态高于常驻浮层」的语义可在不牺牲任何功能的前提下拿到。
  **本轮决定不改**：两位复验员均判非阻断且均建议本轮不动；改动会使两份已签署的判定同时失效，
  为纯语义收益再付一轮复验不划算。**登记为取向**（见「四」）。
- 其本轮未跑（沿用前文）：视觉对比度**像素级**测量与截图比对、原生冒烟 r41a/b/c、原生 GUI
  键盘/焦点走查、reg-r31/r32/r33/race、旧码判别、MCP 与 `src-tauri` 真实 IPC 往返；
  全部结论限于 demo 域探针 + 读码 + `tsc`。

### 三之二、视觉复验（vis-r41）首轮 → 处置 → 定向复验

**首轮结论：不可签**（98 项断言 / 92 通过；60 个对比度采样 / 8 处低于 AA）。
阻断 4 条（B1-B4）+ 中低 5 条（M1-M3、L1-L3），均在 `ui/src/styles.css` 与本轮新增面。

| 编号 | 严重度 | 问题 | 处置 |
|---|---|---|---|
| B1 | **高/阻断** | `.seg` 未选中钮（「全部会话」）悬停时被全局 `button:not(:disabled):hover`（特异度 0,2,1 > `.seg button` 0,1,1）改成亮 accent 底、文字仍 `--text-sub` → **1.07:1（深）/ 1.71:1（浅）**。作者给了 `.seg button.on` 与 `.settings-nav button:hover`，唯独漏 `.seg button:hover` | 新增 `.seg button:not(.on):not(:disabled):hover`（0,4,1）：`--panel3` 底 + `--text`；**显式排除 `.on`**，选中态仍由源码序更后的 `.seg button.on` 胜出 |
| B2 | 中-高 | 新元素 `.cd-hint` 深色用 `--dim` = **3.01:1**（浅 5.69 过）。同文件 `.log-row .tl-meta` 已专门改 `--text-sub`，同类新元素未遵循 | `.term-settings .cd-hint` 改 `--text-sub`（深 6.53 / 浅 6.97） |
| B3 | 中-高 | 设置→凭据空态 `cred-empty` 深色同为 `--dim` = **3.01:1** | `.term-settings .cred-empty` 改 `--text-sub`（深 6.53 / 浅 6.97） |
| B4 | 中 | 连接详情对话框 **Esc 不关闭**——Esc 浮层链无 detail 分支、`modalRef` 不含 detail；仅遮罩与 ✕ 可关。同轮新增的设置对话框 Esc 可关，两者不一致 | Esc 链在 `pasteConfirm` 之后、`splitMenu` 之前补 detail 分支，且只消费详情层、不落到关闭会话 |
| M1 | 中 | **960×600（出货最小窗）**设置对话框在「凭据」新建表单展开态被裁：`clippedH=84`，标题行 + ✕ 整条落在裁切线之上、完全不可见。根因：`position:absolute` + `top/left:50%` 相对 `.term-wrap` 居中，而 `max-height:calc(100vh - 80px)` 用的是**视口**高度 | 对话框改 `position:fixed` + `max-height:calc(100vh - 80px)`；复验四视口 `clippedH=clippedW=0`、head/close 均 inViewport+visible |
| M2 | 中 | 焦点陷阱在草稿确认框消解后失效：`useDialogFocus` 只在 `active` 变化（挂载沿）收焦点，点「留下继续编辑」后该按钮被移除 → 焦点落回 `body` → Tab 的 keydown 不再冒泡到 box，**Tab 逃逸到背景**（实测 6 次 Tab 全 outside，串到活动记录面板） | 新增 `useEffect([credDraftTo, showSettings])`：草稿消解且焦点出框时拉回框内首个可聚焦元素；复验两条消解路径 × 双主题 6/6 inside |
| M3 | 中-低 | `.conn-detail` / `.settings-wide` 用 `left/top:50% + translate(-50%,-50%)` 但 `position` 仍是 `.term-settings` 的 `absolute` → 含块是 `.term-wrap`（终端窗格）而非视口，与全视口遮罩不同心（右栏关时 **dx=+113px**；右栏开时反向 −79） | 同 M1 改 `position:fixed`；复验四视口 × 右栏关/开**八组 dx=dy=0**，`fixedContainingBlock()=[]` 独立证明无祖先拉回局部含块 |
| L1 | 低 | 连接详情在 960×600 上下各裁 4px（`cd-head` 顶、`cd-hint` 底） | 随 M1 的 `max-height` + fixed 一并归零（复验四视口 `clippedH=0`） |
| L2 | 低 | `.cred-new button.ghost`（生成 Ed25519 / RSA / 取消）用 `--accent` 于 `--panel3` 上：深 **4.35:1**（浅 4.52 擦线） | 新增 `--accent-text`（深 #46aab5 = 5.07:1；浅同 `--accent` = 4.52:1）并改用它 |
| L3 | 低（既有类 + 本轮新增使用点） | 活动记录空态 `log-empty` / `log-empty-nosession` 用全局 `.empty`（`--dim`，深 3.41）、设置 `.ts-label`（深 3.01）——**基线既有样式，非 R41 引入**，但本轮为其新增了使用点 | **如实登记，未改**（越本轮范围；浅色侧均通过） |

**首轮处置后 vis-r41 定向复验：7 项处置全部实测通过**

- B1 悬停 **9.96（深）/ 11.71（浅）**，且选中钮 bg 悬停前后逐字节相同（`.on` 未被顶掉）；
- B2/B3 **6.53 / 6.97**；B4 Esc → 详情计数 **0** 且 `list_sessions` 仍含该会话（未误关）；
- M1 四视口 `clippedH=clippedW=0`、`blocked=0/16`、标题行与 ✕ 均可见；
- M2 两条消解路径 × 双主题 **6/6 inside**；M3 八组 **dx=dy=0**；L1 归零；L2 深 5.07 / 浅 4.52。

**但复验另发现新阻断 B5** → 综合仍判 **不可签，唯一阻断 = B5**。

| 编号 | 严重度 | 问题 | 处置 |
|---|---|---|---|
| **B5** | **高/阻断** | 右栏面板进入**完整视图**态时 `.task-panel.tp-full` 的 z-index 是 40，而遮罩/对话框原为 29/30——窄窗下「工具→活动记录」把面板转成 `tp-full` 后，再开「连接详情」会被**整块盖住**（1024×768 实测 11/11 元素不可达，屏幕上只剩活动记录）。基线对照证明该层级关系**先于本轮存在**，但连接详情是 **R41 新增**且落在 R41 自己的主路径上 | **已闭合**：模态必须高于常驻面板——`.pop-mask` 29 → **41**、`.term-settings` 30 → **42**，仍低于 `.confirm-mask`(90) / toast(120) / `.tools-menu`(70) / 右键菜单(200)。探针新增 M 节（M1 详情中心点命中对话框；M2 遮罩压住面板）；红侧刀（遮罩回退 29）→ **M2 + N2 红**。**追加修复见 C-2**：同族浮层 `.split-menu` 一并抬到 43 |

**B5 处置后作者侧 sanity（非审核证据）**：探针 42/42 ×3；四视口 × 双主题截图
（`vis-r41-recheck2-*`）复核详情/设置在面板打开时可达、确认框与 toast 仍压在对话框之上。

**vis-r41 B5 定向复验（recheck2）：可签**——`vis-r41-recheck2-probe.js` **102/102 检查点全通过**，
判定指纹 `styles.css c22384e2…` / `App.tsx a5315058…` / 产品码面 `bb3fa4ce…`，**运行前后各取一次 md5
逐字节一致**。要点：

- **B5 主项已修复**：4 视口 × 2 入口顺序全绿。关键在于「对话框与面板**确实几何重叠**」——1024×768
  下 conn-detail 与面板横向重叠 `overlapW=430px`（对话框整幅压在面板上）、settings `596px`；960×600
  下 `430px` / `564px`。完全重叠下遮挡计数仍为 `0/11`、`0/16`。
- **层叠不倒退**：确认框(90) > 设置(42) > 遮罩(41) 的删除凭据链未变（`selfHit=true`）；
  toast(120) > 对话框(42) 且与对话框同处根层叠上下文（z 序比较有效），`.toast-stack` 仍
  `pointer-events:none`。
- **7 项处置回归全部仍通过**，数字与首轮逐项一致（B1 9.96/11.71 且选中态未被顶掉；B2/B3 6.53/6.97；
  L2 5.07/4.52；B4 Esc→0 且会话仍在；M1 四视口 `clippedH=0`；M2 6/6 ×2 路径；M3 四视口八组
  `dx=dy=0` 且 `fixedContainingBlock()=[]`）。对比度 14/14；四视口几何回归全绿；全程零 JS 错误。
- **`.split-menu` 层叠（本轮新增改动）由它独立验证**：用**真实鼠标点击**（非程序化 `.click()`，
  后者会绕过遮罩、不能作证据）点击菜单项，成功进入分屏（`aria-pressed: false → true`、菜单自动关闭、
  按钮 title 变为「退出分屏（会话保留不断开）」）；判别性反证用运行时注入
  `.split-menu{z-index:30!important}`（**不改工作树文件**）→ `blocked=2/2`（`by=pop-mask`）、
  真实点击 `Timeout 2500ms exceeded`、菜单仍开 ⇒ 分屏确实进不去。
- **B5 判别性独立复现**（同样用运行时注入，未改文件）：注入 29/30 后 1024×768 `blocked=11/11`
  （点 `cd-close` 被 `log-bar` 挡住）、960×600 `blocked=10/11`（点 `cd-host` 被 `tp-head` 挡住）；
  注入生效前置断言（`dlgZ=30 && panelZ=40`）两次运行均成立。
- **它主动更正了上一轮自己的探针缺陷**：上轮报 `.log-note` FAIL 是**它自己的探针口径问题**
  （先点 `log-refresh` 再跨两次 `evaluate` 读，读到陈旧值）；本轮改为同一次 `evaluate` 内同时读空态
  与文案，实测新文案确为「未接入会话，无可显示记录」且对比度未变（深 7.4 / 浅 6.44）。
- **它的取向登记（非阻断）**：`.split-menu`(43) 现高于 `.term-settings`(42)，即分屏菜单会画在设置
  对话框之上——实际不可达（设置打开时其遮罩挡住终端工具栏的分屏按钮），故非缺陷，但语义上
  「常驻浮层高于模态」略反直觉；它建议本轮不改（作者不动 `.task-panel.tp-full`(40) 的判断是对的，
  动它影响面更大）。**本轮采纳：不改。**
- 它如实声明**未做**：原生 Tauri 域未实证（CSS 同源，推断成立但未实测）；未跑作者全量 demo 探针；
  未重跑首轮 98 项，只跑本定向探针（102 检查点）+ 3 个诊断脚本。
- **树位移声明**：它先后见到三个 `styles.css` 版本（`52d2b426…` 任务版 / 作者红侧实验的
  `pop-mask 29` 版 / 判定的 `c22384e2…`），两次探针运行被作者的保存触发 Vite HMR 重载污染，
  据此**废弃那两次结果**，等树连续 20 次采样（约 140s）不变后重跑，并加了两道护栏（先断言注入
  确已生效，再断言判别结论）。

## 四、取向登记 / 已知边界

- **行为变更（低-3，刻意登记）**：删除 `HIDDEN_AUDIT_ACTIONS` 后，`shell_integration_inject` 事件
  **会**出现在活动记录中。客户端隐藏与后端分页 `total` 口径不可调和（隐藏了行却仍计入「共 N 条」），
  R41 选择让活动记录成为**完整留痕视图**，隐藏交给筛选器（用户可筛掉）。这是一次有意的取舍，
  非疏漏。
- **`created_at` 语义修正**：`list_sessions` 的 `created_at` 由「查询时刻」改为「会话真实创建时刻」。
  这是对既有缺陷的修正（此前每次轮询都在变），但**改变了既有字段的值语义**——任何依赖旧
  「总是 now」行为的调用方会看到不同值（仓库内无此类调用方）。
- **活动记录是右栏任务面板的一个态，不是独立路由**：与文件/转发/协作四者互斥（§4.3），窄窗转
  `tp-full` 中央完整视图。§6.6 要求「可展开工作区视图、非对话框」，本实现满足；但「展开」在窄窗
  下与「转完整视图」共用同一机制。
- **demo 与真实面的差距**：demo 无真实审计链（事件为内存列表，无 hash 链、无 vault），故
  `beforeSeq` 游标语义、`actor_kind` 过滤在 demo 域是**同口径模拟**；真实面由 `tinyssh-audit`
  单测 + `r41_tests` + 原生冒烟 r41b（真审计库）承担。
- **低-4 仅代码级**：demo `invoke` 串行，无法制造乱序响应，探针无行为断言。
- **视觉处置仅改 `ui/src/styles.css`**；B5 的层级调整方向为「模态单向高于常驻面板」，
  深/浅两色与其余层级（confirm-mask / toast / 菜单）均未回退。
- **原生冒烟无红侧判别**（见二、判别力口径）：`r41_smoke_script` 在 R41 diff 内，基线无该分支。
- **视觉复验的覆盖边界（vis-r41 如实声明）**：仅在 demo（浏览器）域复验，**未跑原生 Tauri 窗口内
  渲染**（CSS 同源但原生域未实证）；未测 Solarized 等其它终端配色主题（只测 dark/light chrome）；
  ≥1440 大窗 / 多显示器组合只抽测；toast 与设置对话框、活动记录面板的叠印未单独测（只测了
  conn-detail vs toast）；队列抽屉在**有真实传输任务**时未测（demo 无传输，仅验证模态压抽屉）。
  B5 定向复验轮**未重跑首轮 98 项**、未跑作者全量探针。
- **连接详情 `cd-err`（未接入会话空态）在 demo 中不可达**：工具菜单在无 `current` 会话时不渲染，
  而会话存在时 `openSessionDetail` 不会置错。该分支**未验证**（原生 r41a 覆盖了未知会话错误路径）。
- **B5 的既有面**：该层叠关系（`.task-panel.tp-full` z-index 40 > `.term-settings` 30）**先于 R41
  存在**——基线 `:5184` 在 1024×768 + 协作面板（tp-full）下旧 280px 设置对话框同样全不可达。
  本轮一并修复（模态提到 41/42），故**设置对话框的既有缺陷亦已闭合**；如实登记其并非 R41 引入。
- **C-2 是本轮自己引入又自己修掉的**：把 `.pop-mask` 抬到 41 后，与它**同父兄弟**的 `.split-menu`
  （原 30）被自己的遮罩盖死——这是 B5 修法的**副作用**，由代码复验发现（真鼠标点击实证），
  处置为 `.split-menu` 一并抬到 43。如实登记：若无这次复验，分屏入口会静默失效。
- **本轮最终层级表**（`ui/src/styles.css`）：`.task-panel.tp-full` 40 → `.pop-mask` **41** →
  `.term-settings`（连接详情 / 设置对话框）**42** → `.split-menu` **43** → `.tools-menu` 70 →
  `.confirm-mask` 90 → toast 120 → 右键菜单 200。规则：**凡与 `.pop-mask` 配对的浮层都必须高于遮罩**
  （本文件三处配对：分屏菜单、连接详情、设置），否则自己的遮罩吃掉自己的点击。
- **复验期的树移动**：本轮证据链上共发生**两次树移动**（一次 20:07:42 的 z-index 回退，来源未能
  归因；一次是随后的重新落盘）。两次均由作者在复验判定后重取指纹对账，最终指纹见「二」。
- **`.split-menu`(43) 高于 `.term-settings`(42)：登记为已接受的取向，非缺陷**。两位复验员独立实证
  「双向不可共存」（设置打开时其遮罩挡住终端工具栏的分屏按钮；分屏菜单打开时 ⌘, 被 `modal` 门控挡住；
  全仓无开分屏菜单的键盘路径），故 43 > 42 无任何可达后果。rev-r41 给出**零成本互换**备选
  （`.split-menu` 42 / `.term-settings` 43，运行时注入已实证 4/4 等价），本轮**未采纳**：两位均判
  非阻断并建议本轮不动，改动会使两份签署同时失效。**留给后续轮**（若做，用互换而非继续往上叠）。
- **M3 修复与 B5 的关系**：M3（改 `fixed` 居中）**未引入也未消除** B5——修复前 dialog 为 absolute、
  含块 = `.term-wrap`，tp-full 下同样被盖。
