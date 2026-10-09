# R42 验收证据（G4 三/五：协作入口、首次委托、审批、接管/交还/简报）

范围：`docs/ux/ssh-client-ux-refactor.md` §3.2 / §4.2 / §4.5 / §5（迁移表）/ §6.7 / §10.1 / §12；
交付行 99（验收）、197-215（D04/D05/D06/D11/E06）。基线：R41（HEAD `9e1df70`）。

## 本目录文件

| 文件 | 说明 |
|---|---|
| `r42-demo-probe.js` | R42 演示域探针（38 断言：入口 / 新装未启用 / 首次委托 / 审批分组与目的 / 接管交还 / 窄窗完整视图）。 |
| `reg-r41-probe.js` | R41 探针的 R42 回归版（含两处 §12 同步变更，见下）。 |
| `reg-r41.txt` | 回归实跑输出（对 :5183）。 |
| `oldcode-run1.txt` | 旧码判别力实跑（对 :5184 = R41 基线）。 |
| `rev-r42-findings.md` | 独立审核员（rev-r42）结论。 |
| `vis-r42-report.md` + `vis-r42-*.png` | 独立视觉复验（vis-r42），含处置后定向复验小节。 |
| `r42-driver.sh` + `smoke-run1-beacon-r42a.txt` / `smoke-run1-beacon-r42b.txt` | 原生冒烟（真核心 + 真 vault + 真 sshd 容器）驱动与逐阶段 beacon 归档。 |

## 实跑结论

- **R42 演示探针：38/38 PASS**（对 :5183，`r42-demo-probe.js`）。
- **R41 回归：46/46 PASS**（`reg-r41-probe.js`，对 :5183）。
- **旧码判别力：8/38**（对 :5184 R41 基线）——30 条判别性断言在旧码上失败；余 8 条为「断言缺席/无操作」类（`C8/G1/G3/G4/G5/Z/Z2/D4`），旧码因根本无对应实现而平凡满足，**不具判别力**，已如实登记。
- **原生冒烟：r42a / r42b 两阶段全绿**（`r42-driver.sh`，真 vault 无 Agent→签发落库→复用同库读回；真核心 `delegate_session`/`set_control`；真 sshd 容器）。r42a：无徽标/无委托入口/工具菜单精确枚举/一次性引导/设置空+真端点（`http://127.0.0.1:8722/mcp`）/真命令签发落库；r42b：徽标出现/对话框事实齐全（无持久 Shell 如实告知）/取消不改权/提交切 Agent 且真核心落 goal/工具栏转接管/接管收回 Human 并保留「曾被 Agent 持有」印记（措辞转「交还」）。
- Rust：`session-api` 12 通过；`core-session` 98 + 4 + 13 + 4 通过（含 `r42_tests` 5 项，新增 `r42_purpose_is_none_when_session_gone`）。

## §12：复用 R41 测试时的同步变更（对象/断言更新）

1. **`reg-r41-probe.js` H1**：§3.2 精确枚举后「工具」菜单不再有「审批与记录」项——改由会话工具栏「协作」按钮（`data-testid=tools-collab`）打开协作面板。断言对象同步更新，判定条件不变。
2. **`reg-r41-probe.js` I1**：设置新增「Agent 接入」分类（§5 迁移表：MCP 配置从协作面板迁入），分类数 4 → 5；新增 I1b 断言新分类可达。

## 关键实现（供复核对照）

- **core**：`session-api` 增 `ApprovalItem.purpose`（会话**当前**委托目标投影，`None`=明确缺失）、`SessionInfo.ever_agent_owned`；`core-session` `SessionHandle` 增 `ever_agent_owned` 原子位（`handback` 置真，接管不抹历史），`list_approvals` 读取时按会话当前 goal 投影 purpose；新增 `crates/core-session/src/r42_tests.rs`。
- **FE**：wire/bridge 增 `delegate_session` / `shell_capability` / `ShellCapability` / `purpose` / `ever_agent_owned`；demo 增 `delegate_session` / `shell_capability` / `issue_agent` / `demo_inject_approval` 与 `?fresh` 新装态；`App.tsx` 协作入口、分组审批、首次委托对话框、设置→Agent 接入；`styles.css` 新增协作样式与完整视图长命令覆盖。
- **§6.7 首条 / §5 迁移**：MCP 配置（端点/Token/接入说明）从协作面板移入「设置 → Agent 接入」；新装未启用协作时协作面板改一次性引导，主界面不出现空审批区/空白委托表单。
