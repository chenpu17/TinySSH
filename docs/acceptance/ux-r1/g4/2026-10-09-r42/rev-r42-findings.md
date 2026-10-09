# R42 独立复核（rev-r42）发现

- 复核对象：TinySSH UX-R1 R42「协作入口、首次委托、审批、接管/交还/简报」（G4 三/五）。
- 基线 HEAD：`9e1df70`（R41）。工作树 = R42 未提交改动。
- 复核者：rev-r42（独立，作者自查不计入）。
- 判定时间：2026-10-09 21:56 CST。

## 一、复核方法（可复现）

- **重取 diff/mtime**：`/usr/bin/git diff --stat` + 逐文件 diff；审核期间多次重取（见 §五 并行改动）。
- **独立跑 Rust 测试**（未复用作者结论）：
  - `cargo test -p session-api` → **12 passed / 0 failed**（含 `r42_purpose_and_ever_agent_owned_wire_compat`）。
  - `cargo test -p core-session` → lib **97 passed / 0 failed**（含 `r42_tests` 4 条），另有集成用例 4 + 13 + 4 全绿。
- **独立跑探针**（作者探针 + 我另写的针对性探针）：
  - `r42-demo-probe.js` @ `http://localhost:5183`（R42 工作树）→ **37/37**。
  - `r42-demo-probe.js` @ `http://localhost:5184`（R41 基线 worktree）→ **8/37**（判别力强；正向断言全红）。
  - `reg-r41-probe.js` @ `:5183` → **46/46**（H1 已改走 `tools-collab`、I1b 校验新增「Agent 接入」分类，符合 §12「复用旧测试须更新对象/断言」）。
  - `npx tsc --noEmit` → 干净；`cargo check -p tinyssh-app` → 通过。
- **红侧变异**（还原一律用 Edit 反向改回，未用 `cp` 整文件写回）：
  - core `handle.rs` handback 的 `ever_agent_owned.store(true)` → `store(false)`：`cargo test -p core-session r42` 中 `r42_ever_agent_owned_lifecycle` **FAILED**（“委托后 true”断言失败）；Edit 还原，`store(true)` 已确认恢复。
  - FE `App.tsx` 「可用目的」缺失分支 `未提供（Agent 未收到委托说明）` → `null`：`r42-demo-probe.js` **B6 FAIL**（无缺失态）；Edit 还原，该行已确认恢复。
  - 结论：Rust 用例与 demo 探针均**非常绿**，能识别对应机制被破坏。

## 二、结论

**R42 主张基本成立，未发现功能性缺陷（no functional defect）。** core 三处契约（`purpose` 投影、`ever_agent_owned` 生命周期、`list_approvals` 当前目标投影）与 FE（协作入口/分组/首次委托/接管/迁移）经独立验证与红侧变异均成立。发现 5 条**低/信息级**观察，均不影响规范符合性。

## 三、确认无问题（逐条，附独立证据）

| 规格点 | 结论 | 独立证据 |
|---|---|---|
| §3.2 跨会话审批按主机+会话分组，绝不只展示当前主机 | ✓ | 探针 B2（组数=2）、B3（分组头含 prod-1/s-demo-0001 与 staging-1/s-demo-0002）；`approvalGroups` 以 `session_id` 为键、按 `host_name` 排序，组头含主机名+会话 id+状态+条数 |
| §6.7「可用目的」缺失**明确显示缺失**（不留白、不自造语义） | ✓ | 探针 B6；缺失态文案「未提供（Agent 未收到委托说明）」+ `warn` 色。红侧变异证明该显示是被断言的机制 |
| §6.7 目的=会话**当前**目标投影（后补目标也可见） | ✓ | core `list_approvals` 按 `sessions[sid].goal` 实时投影；`r42_approval_purpose_projects_current_goal`（场景二）绿；demo `list_approvals` 同款 |
| §6.7 启用服务/登记 Agent **不转移** owner | ✓ | `r42_registering_agent_does_not_move_owner` 绿；demo `issue_agent` 不动 owner/ever_agent_owned |
| §6.7 首次委托**显式**、取消不改 owner、核心成功才切 Agent-owned | ✓ | 探针 C5（取消后 owner=Human）、C6（提交后 owner=Agent）；core `delegate_session` 仅 Human、内部走 handback；FE 无乐观改 owner |
| §6.7 任务目标可选、留空**不清除**既有目标 | ✓ | core `delegate_session` 仅 `Some(g)` 时写 goal；FE 传 `goal: g ? g : null`；探针 C7 目标落库 |
| §6.7 服务未启用先引导设置、返回后仍须单独确认 | ✓ | 未配置时委托入口不渲染；面板「委托」段引导「打开设置 → Agent 接入」；启用后须再次打开对话框并点提交（无自动提交） |
| §6.7 曾被 Agent 持有 → 措辞「交还 Agent」 | ✓ | 探针 C1（首次=「交给 Agent…」）、D6（接管后=「交还 Agent」）；`ever_agent_owned` 由 handback 置真、接管不抹历史（`r42_ever_agent_owned_lifecycle`） |
| §6.7 不展示「仅某一 Agent 独占」承诺 | ✓ | 对话框明示「控制权是角色，不承诺某一 Agent 独占」 |
| §6.7 接管默认只冻结（停止是独立动作） | ✓ | `ControlOpts::default().stop_running == StopPolicy::None`（`r42_takeover_default_freezes_only_and_voids_are_final`）；FE `takeover()` 传 `stopRunning:false`，`takeoverStop()` 才传 true |
| §6.7 接管作废交接前未开始请求；旧卡作废不可复活；交还不恢复旧队列 | ✓ | core 用例断言接管后 `frozen`、`stopped.is_empty()`、Agent 阻塞调用收 `VoidedByHandback`、旧卡 `Voided` 且再批准报错；探针 D4/D5 |
| §4.2 窄窗/双分屏退化 + 长命令完整可见 | ✓ | 探针 E1（tp-full）；`tpFull` 逻辑含 `if (splitPanes) setTpFull(true)` 与 `availW < 560+panelNeed-16` 回差；**独立复核**：注入 255 字符命令后待审批卡 `.cmd` 在 tp-full 下 `whiteSpace=normal / wordBreak=break-all / scrollWidth==clientWidth / 全文可见` |
| §5 迁移：新装主界面无空审批区/空白委托表单/MCP 配置 | ✓ | 探针 G1–G7（徽标不显、面板改一次性引导、无 `ap-group`/`collab-approvals`/`.goal-input`、引导至设置→Agent 接入、端点在设置） |
| §12 复用旧测试更新对象/断言 | ✓ | `reg-r41-probe.js` H1 改走 `tools-collab`、I1b 校验 `settings-cat-agent`；46/46 |

## 四、缺陷 / 观察（均为低/信息级）

### 4.1 [低] 未配置协作时「打开设置 → Agent 接入」按钮重复渲染两处
- 复现：`http://localhost:5183/?fresh` → 选中会话 → 点工具栏「协作」。
- 现象：`document.querySelectorAll('[data-testid="collab-open-settings"]').length === 2`，两处均可见（一次性引导块 + 「委托」段）。两按钮同动作（`openSettingsAt("agent")`），故**功能无害**；但 `data-testid` 不唯一（自动化取首个匹配）且引导文案重复。
- 证据：`/private/tmp/r42-struct-check.js` 输出 `openSettingsCount: 2, btnsVisible:[true,true]`。
- 建议：未配置时「委托」段不再重复渲染同一按钮，或改用不同 testid。

### 4.2 [低/信息] 委托对话框内「服务未启用先引导」分支为不可达死代码
- 复现：`delegate-dlg` 仅能由工具栏 `delegate-open` / 面板 `delegate-open-panel` 打开，二者均以 `collabConfigured` 为门；`collabConfigured === hasAgents`，UI 无「删除 Agent」入口，运行期不会由真翻假。
- 现象：`delegate-unconfigured` 块与 `delegate-submit` 的 `disabled={!collabConfigured||…}` 实际不可达；`submitDelegate` 的 `if (!collabConfigured) return` 亦然。
- 影响：无。§6.7「先引导设置接入」由面板「委托」段承担，需求仍满足；仅为冗余/死分支。
- 证据：App.tsx `openDelegate` 调用点（工具栏行 ~3766、面板行 ~5004）均在 `collabConfigured` 门内。

### 4.3 [信息] 探针 E2 断言的是代理元素而非规范所指的待审批卡
- `E2` 选择器 `.collab-approvals .tl-cmd-text` 命中的是「最近处理」折叠行（App.tsx:4616）与活动记录（:4963），**不是**待审批卡的 `.cmd`（:4563）。§4.2 的「原动作」指待审批卡命令。
- 独立复核补足：待审批卡 `.cmd` 因 `.card .cmd{word-break:break-all}` 本就换行完整可见（见 §三 证据）。故规范要求满足，但探针未直接覆盖规范对象。
- 建议：E2 增测 `.card .cmd`（长命令）在 tp-full 下不裁切。

### 4.4 [信息] 工具栏「协作」钮无条件渲染
- `tools-collab`（App.tsx:3795）只要有会话即渲染（含新装未配置）；titlebar 徽标 `collab-entry` 已正确按 `(collabConfigured || collabActive)` 门控。
- §3.2 为正向要求「有协作配置时显示协作入口」，非禁止未配置时出现；属轻微偏离，不判缺陷。
- 证据：`/private/tmp/r42-struct-check.js`（fresh 下 `tools-collab` 存在且可打开引导）。

### 4.5 [信息] core `list_approvals` 对「会话已不在表」的审批保留旧 purpose 快照
- `lib.rs` 投影处：`if let Some(g) = goals.get(&it.session_id) { out.purpose = g.clone(); }`——会话不在 `sessions` 表时落空，保留创建期快照，与注释「不拿旧快照冒充当前意图」字面不符。
- 无可见影响：会话关闭时其待审卡已被作废（非 pending），purpose 行仅在 pending 卡渲染。登记备查。

## 五、审核期间作者并行改动（注明）

- 初次 `git diff --stat`（约 21:43）为 **9 文件 / 563 insertions / 113 deletions**；判定时（21:56）为 **10 文件 / 772 insertions / 114 deletions**。**FE/core 9 文件逐文件 diffstat 与初读完全一致**（App 432、demo 94、styles 43、bridge 6、wire 19、handle 9、lib 24、session-api 48、c1_tests 1），未变。
- 新增改动仅在 `src-tauri/src/main.rs`，含两类：
  1. **已出货行为改动**：`mcp_status` 由「回原始 `vault.list_agents()` 三元组 `(id,label,revoked_at)`」改为投影 `{id,label}` 并**过滤已吊销**（`revoked.is_none()`）。核验：FE `McpStatus.agents:{id,label}[]`（wire.ts:450-452）与 `App` 内联类型一致 → 此为**契约对齐修复**（此前原生侧 `a.label` 为 undefined）；t43 原生冒烟只断言 `ms.endpoint`，不受影响；`tinyssh-app` 编译通过。**非缺陷**。
  2. **原生冒烟脚本**：新增 `r42_smoke_script`（r42a 新装未启用 / r42b 已登记复用同库），及 `main()` 中 `mode.starts_with("r42")` 分派。静态核对：脚本引用的 `settings-close`、`issue_agent`、`agent-empty/list/endpoint`、`settings-cat-agent`、`.goal-input` 等 testid/命令**均存在**，内部自洽（未运行原生，需解锁屏幕，留待原生冒烟）。
- 上述并行改动发生在复核期间；本报告以**重取时（21:56）的树**为准，且已确认未触及受审的 FE/core 9 文件。

## 六、假绿 / 证据超主张核查

- **未发现假绿**：基线 `:5184` 下探针 8/37（正向断言全红），红侧变异两处均致红 → 探针与 Rust 用例均具判别力。
- **证据与主张一致性**：作者 37/37、46/46、4 条 r42 用例均可独立复现。唯一需注意：探针 E2 的「长命令完整可见」覆盖对象是 `.tl-cmd-text` 而非待审批卡（§4.3）——主张「长命令完整可见」成立，但探针证据指向代理元素，属**证据未精确对准规范对象**（非超主张，因要求实际满足）。

---

## 七、处置后定向复核（rev-r42 第二轮，22:14 CST）

对协调者处置的**受影响的代码面**做定向复核。判定前重取 diff/mtime（见下）。

### 7.1 处置项 4.1（重复 testid）— 已修，确认
- 改动：`App.tsx:4990`「委托」段未配置分支按钮 `collab-open-settings` → `collab-open-settings-delegate`；`App.tsx:4520` 引导区按钮保持 `collab-open-settings`。
- 独立验证（`/private/tmp/r42-testid-check.js`，`?fresh`）：`querySelectorAll('[data-testid="collab-open-settings"]').length === 1`、`collab-open-settings-delegate` 亦为 1、两者均可见；点 `collab-open-settings-delegate` 正确打开「设置 → Agent 接入」（`settings-cat-agent` 出现且 `agent-empty` 恰 1）。**处置成立。**

### 7.2 处置项 4.5（purpose 快照）— 已修 + 加测试，确认（含独立红侧）
- 改动：`lib.rs:2104` 投影改为 `out.purpose = goals.get(&it.session_id).cloned().flatten();`——会话不在 `sessions` 表即 `None`（严格当前目标投影）。
- 新增 `r42_tests.rs::r42_purpose_is_none_when_session_gone`（会话在列表→投影为当前目标；从 `sessions` 移除→`None`）。
- 独立复跑：`cargo test -p core-session --lib r42` → **5 passed / 0 failed**（含新用例），符合期望。
- 独立红侧：将 `lib.rs:2104` 改回旧快照形式 `if let Some(g) = goals.get(...) { out.purpose = g.clone(); }` → 新用例 `r42_purpose_is_none_when_session_gone` **独红**（其余 4 条绿，`panicked at r42_tests.rs:182`）；Edit 反向还原（未用 `cp`），复跑 **5/5 绿**，`lib.rs:2104` 已确认为新形式。**处置成立且用例具判别力。**

### 7.3 处置项 4.3（E2 代理元素）— 已补强，确认
- 探针新增 `E2b`：注入 301 字符命令，断言 **`.collab-approvals .cmd`**（待审批卡原动作）在 tp-full 下 `fits && clipped !== 'ellipsis'`——直接对准 §4.2 规范对象。
- 独立复跑：`r42-demo-probe.js` @ `:5183` → **38/38**。E2b 实测 `{ws:"normal", wb:"break-all", fits:true, clipped:"clip", len:301}`。**处置成立**（E2 保留测「最近处理」行，E2b 覆盖规范对象，二者互补）。

### 7.4 处置项 4.2（对话框内不可达死分支）— 判定：可保留
- 协调者选择保留为纵深防御并登记于 README。复核认可：该分支无功能危害，且不违反任何规范条（§6.7「先引导设置」由面板「委托」段承担，实际可达）。保留为防御纵深**可接受**，无需删除。

### 7.5 处置项 4.4 — 维持（§3.2 正向要求），无异议。

### 7.6 第二轮并行改动（注明）
- 重取时（22:13:40）受审 **FE/core 9 文件 diffstat 与首轮一致**（App 432、demo 94、bridge 6、wire 19、handle 9、lib 24、session-api 48、c1_tests 1）；`styles.css` 由 vis-r42 的 F1/F2/F3（`--on-warn` 对比度、`--text-sub` 提档、缺失态回 warn）增至 49 行（**非本轮 1–3 处置内容，亦不影响上述验证**）。
- `src-tauri/src/main.rs` 继续并行增长（210→214，22:09:38，原生冒烟脚本），不影响本轮 1–3 项判定。

### 7.7 第二轮结论
**处置后可签（sign-off）。** 4.1、4.5、4.3 三项均经独立验证成立，4.5 的新用例具备独立判别力；4.2、4.4 的保留决定可接受。未发现新增缺陷。
