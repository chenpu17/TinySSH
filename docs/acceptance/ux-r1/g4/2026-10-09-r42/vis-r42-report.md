# vis-r42 独立视觉复验报告（R42：协作入口、首次委托、审批分组/目的、接管交还、窄窗完整视图）

- 复验对象：R42 工作树（`ui/src/App.tsx`、`styles.css`、`demo.ts` 等，未提交），demo 态跑在 http://localhost:5183/
- 复验者：独立视觉复验员（vis-r42），作者自查不计入
- 方法：headless Chromium（`/Applications/Google Chrome.app`，Playwright）真实渲染 + 截图 + 浏览器内 computed-style / 几何盒 / `elementFromPoint` / 对比度实测；**未修改工作树源码**，未要求退出用户浏览器
- 探针：`vis-r42-probe.js`、`vis-r42-probe2.js`（本目录），证据 JSON：`vis-r42-evidence.json`
- 环境事实：headless 默认 `prefers-color-scheme: light`，故主场景默认浅色；深色经「设置 → 外观 → 深色」实时切换（截图已核 `data-chrome=dark`）
- **树变更复核**：采样后 `ui/src/App.tsx` 于 22:00 被作者并行改动（`styles.css`/`demo.ts` 未变），已对当前树**重取 diff + 复跑对比度/分组探针**：`collab-badge.hot`、`.purpose-line`、`.ap-group-head`、`.tsum-chip` 相关代码与 CSS 均未变，实测数字逐项一致（徽标浅色 3.90、深色缺失态 3.01、分组数 2、缺失态浅色 5.69）。以下结论对当前树成立。

---

## 逐项复验

### 1. 协作入口（titlebar 徽标 hot 态 + 工具栏「协作」）
- **观测**：选中会话后 titlebar 出现 `[data-testid=collab-entry]`，文本 **「协作 · 3 待审批」**，`class="collab-badge hot"`，计算色 `bg=rgb(150,112,10)`（=浅色 `--warn`）、`color=rgb(234,238,242)`（=浅色 `--bg`），带 `animation: collab-pulse`。待审批计数随注入从 2→3 实时更新。工具栏 `[data-testid=tools-collab]`（图标+「协作」）存在且与「文件/工具」同级；`aria-pressed` 随面板开合翻转。
- **证据**：`vis-r42-01-badge-hot-light.png`（徽标裁切）、`vis-r42-02-tools-collab-light.png`（工具栏裁切）、`vis-r42-03-approval-groups-light.png`、`vis-r42-10-badge-dark.png`（深色徽标）
- **达标**：是（功能与可达性达标）。**附对比度存疑见下 F1。**

### 2. 审批分组（按主机+会话，多组并存）
- **观测**：向另一会话 `staging-1`（`s-demo-0002`，无目标）注入一张待审批后，等 ≥3s 轮询刷新，面板出现 **2 个 `[data-testid=ap-group]`**：
  - 组头 1：`prod-1 · s-demo-0001 已连接 2 待处理`
  - 组头 2：`staging-1 · s-demo-0002 已断开 1 待处理`
  组头含**主机名 + 会话 id + 连接态 + 待处理数**，两组视觉上以独立卡片块清晰分隔（组头 sticky）。
- **证据**：`vis-r42-03-approval-groups-light.png`、`vis-r42-06-narrow-1024-light.png`（完整视图下两组并存）
- **达标**：是

### 3. 「可用目的」（有目标显示目标；无目标**明确显示「未提供…」**）
- **观测**：3 张待审批卡各有一条 `[data-testid=ap-purpose]`。
  - `prod-1` 两张卡：`目的 把 /tmp/old-build 清理掉并重新打包 dist 到 /tmp/build.tgz`（会话当前 goal 投影）
  - `staging-1` 一张卡：`目的 未提供（Agent 未收到委托说明）`，`class="purpose-line missing"`
- **像素/几何证据**：缺失态文本用 Range 量得**渲染盒宽 23.28px × 高 16px（非零）**，即确有可见文本，非留白；截图清晰可读。
- **证据**：`vis-r42-04-purpose-missing-light.png`（缺失行裁切）、`vis-r42-03/05` 中同样可见
- **达标**：是（"明确显示"达标）。**附对比度存疑见下 F2、意图/实现偏差见 F3。**

### 4. 首次委托对话框（四项事实 + 目标可选 + 取消/提交 + 最上层可点）
- **观测**：连一台「本机」（人类新建会话 `s-demo-0101`，`control_owner=Human`）后，工具栏入口措辞 **「交给 Agent…」**；点开对话框 `[data-testid=delegate-dlg]`：
  - 标题「把 本机 交给 Agent？」
  - **主机** 本机 本机 / **会话** s-demo-0101 已连接 / **能力** 无持久 Shell——委托后 Agent 只能走 exec 模式（不继承当前目录/环境） / **现有授权范围** 已接入 opencode（演示）；所有操作逐条审批（控制权是角色，不承诺某一 Agent 独占）——四项事实齐全
  - **任务目标（可选）** `textarea.goal-input`，placeholder 提示；留空时提交钮仍可用（`delegate-submit` disabled=false）→ 可选成立
  - 按钮：`交给 Agent`（`delegate-submit`）+ `取消`
- **层叠（最上层可点）**：对话框中心 `elementFromPoint` → `inDlg:true`；面板右上区 `elementFromPoint` → 命中 `.confirm-mask`（非面板内容）→ 对话框在最上层。
- **证据**：`vis-r42-05-delegate-dialog-light.png`
- **达标**：是

### 5. 新装未启用（`?fresh`）
- **观测**：
  - titlebar **无协作徽标**（`collab-entry` 计数 0）；工具栏「协作」入口仍在（0 待审批，非 hot）
  - 打开协作面板 → 一次性引导 `[data-testid=collab-unconfigured]`：「协作未启用。到「设置 → Agent 接入」登记 Agent 后，这里会显示审批、任务目标与现场简报。」+「打开设置 → Agent 接入」
  - **无空审批区**：`ap-group`=0、`.collab-approvals`=0
  - **无空白任务目标表单**：`.goal-input`=0（「任务目标」区仅一行说明文案）；`delegate-open`=0
  - 设置 → Agent 接入：`agent-empty`=1「暂无 Agent 接入——按下方三步接入。」、`agent-endpoint`=1、`agent-list`=0
- **证据**：`vis-r42-11-fresh-unconfigured.png`、`vis-r42-12-fresh-agent-settings.png`
- **达标**：是（冗余观察见 F4）

### 6. 窄窗/分屏完整视图（1024×768 与 960×600）
- **观测**：两档下协作面板均进入 `.task-panel.tp-full`（面板宽 798px / 734px），顶部显示「空间不足——完整视图，终端仍在运行」。
  - 待审批卡长命令 `rm -rf /tmp/old-build && tar czf /tmp/build.tgz dist/`、`systemctl restart nginx --now --no-block --preserve-env`：`white-space:normal`、`text-overflow:clip`、`scrollWidth==clientWidth`（`full:true`）→ **完整可见，无省略号**
- **证据**：`vis-r42-06-narrow-1024-light.png`、`vis-r42-07-narrow-960-light.png`
- **达标**：是

### 7. 明暗两主题
- **观测**：浅色（主场景）与深色（经设置切换，`data-chrome=dark`、`body bg=rgb(12,16,23)`）各取关键截图；两组审批、目的行、缺失态、徽标在两主题下均可读。
- **证据**：浅色 `01/03/04/05/06/07/08`；深色 `09-collab-dark`、`10-badge-dark`
- **达标**：是（深色部分文本对比度存疑见 F2）

### 8. 层叠（完整视图下对话框/确认框在最上层）
- **观测**：tp-full 态（960×600）下委托对话框仍开：`confirm-mask` z-index=**90**、`.task-panel.tp-full` z-index=**40** → 对话框在面板之上。
  - 对话框顶条 `elementFromPoint` → 命中 `.hk-title`（`inDlg:true`）
  - 面板区某点 `elementFromPoint` → 命中 `.confirm-mask`（未被面板内容覆盖）
- **证据**：`vis-r42-08-dialog-over-fullview-light.png`（对话框叠在完整视图面板之上）
- **达标**：是

---

## 不达标 / 存疑项

> 说明：以下均为**对比度/实现一致性**类问题，功能与可达性均达标；无阻断级缺陷。

### F1（存疑·低）浅色主题 `.collab-badge.hot` 文本对比度 3.90:1 < AA 4.5
- 复现：浅色主题、有 Agent 活动/待审批 → titlebar 徽标变 hot。
- 证据：`[data-testid=collab-entry]` 计算 `color=rgb(234,238,242)`、`bg=rgb(150,112,10)`（11px/600），实测对比度 **3.90:1**。11px 粗体不属 WCAG「大字号」，AA 需 4.5:1。
- 根因：CSS 用 `color: var(--bg)`（浅色 `#eaeef2`）；若改用专为 warn 底设计的 `--on-warn`（浅色 `#ffffff`）可达 **4.56:1**。注：基态徽标（`--warn` 文字于 `--panel` 上 4.20:1）在 CSS 注释中已被作者标注「差 AA」，hot 态为其更低值。
- 截图：`vis-r42-01-badge-hot-light.png`

### F2（存疑·低）深色主题 `.purpose-line` / `.ap-group-head` 的 `.dim` 文本 3.01:1 < AA 4.5
- 复现：深色主题 → 协作面板「目的」标签行（含「未提供（Agent 未收到委托说明）」缺失文案）与会话 id 行。
- 证据：深色 `--dim=#5d6f82` → 计算色 `rgb(93,111,130)`，实测对比度 **3.01:1**（11.5px）。与仓库既有判据一致（`styles.css` 第 533/582 行注释：vis-r41 B2/B3 已认定「`.dim`（深色 3.01:1）不合格」并为此把 `.cd-hint`/空态提示改档）。
- 影响面：R42 **新增**元素中「目的」行与分组头会话 id 使用 `.dim`；缺失态「可见」达标（非留白），但深色下正文对比度低于 AA。浅色下同文本为 `--dim #5c6875` → 5.69:1（达标）。
- 截图：`vis-r42-09-collab-dark.png`

### F3（观察·低）缺失态「用 warn 醒目」的意图未落地
- `.purpose-line.missing { color: var(--warn); }` 的意图是让缺失态用警告色醒目（CSS 注释：「缺失态用 warn 提示，不留白」），但行内文本均为 `<span className="dim">`（「目的」标签与「未提供…」），`.dim{color:var(--dim)}` 覆盖了继承的 warn → 缺失行实际全部渲染为 `--dim` 灰，与「有目的」卡在**颜色上无区分**（仅靠文案区分）。
- 复现/证据：浅色缺失行计算色 `rgb(92,104,117)`（=--dim），非 `--warn rgb(150,112,10)`。
- 截图：`vis-r42-04-purpose-missing-light.png`

### F4（观察·非缺陷）fresh 面板两处「打开设置 → Agent 接入」
- fresh 协作面板同时渲染 `collab-unconfigured` 引导钮与「委托」区钮（均 `data-testid=collab-open-settings`），文案/去向相同，略冗余。非缺陷，登记为取向。

---

## 关键截图清单

| 文件 | 内容 |
| --- | --- |
| `vis-r42-01-badge-hot-light.png` | titlebar 协作徽标 hot 态（浅色，含待审批计数）|
| `vis-r42-02-tools-collab-light.png` | 会话工具栏「协作」入口 |
| `vis-r42-03-approval-groups-light.png` | 协作面板：按主机+会话分组（prod-1 / staging-1 两组）|
| `vis-r42-04-purpose-missing-light.png` | 「目的 未提供（Agent 未收到委托说明）」缺失态 |
| `vis-r42-05-delegate-dialog-light.png` | 首次委托对话框（四项事实 + 目标可选 + 取消/提交）|
| `vis-r42-06-narrow-1024-light.png` | 1024×768 完整视图（tp-full），长命令完整可见 |
| `vis-r42-07-narrow-960-light.png` | 960×600 完整视图，长命令完整可见 |
| `vis-r42-08-dialog-over-fullview-light.png` | 完整视图下委托对话框在最上层（层叠）|
| `vis-r42-09-collab-dark.png` | 深色主题协作面板（分组 + 目的行）|
| `vis-r42-10-badge-dark.png` | 深色主题协作徽标 |
| `vis-r42-11-fresh-unconfigured.png` | `?fresh`：无徽标 + 一次性引导 + 无空壳 |
| `vis-r42-12-fresh-agent-settings.png` | `?fresh`：设置→Agent 接入（无 Agent）|

---

## 结论

**8 项复验清单全部达标（功能与可达性）**：协作入口 hot 徽标与工具栏入口、审批按主机+会话分组（多组并存清晰）、可用目的缺失态明确显示（像素实证非留白）、首次委托对话框四项事实齐全且在最上层可点、新装未启用为一次性引导（无空壳）、窄窗 1024/960 完整视图长命令完整可见、明暗两主题、完整视图下层叠正确。

**无阻断级缺陷。** 登记 2 项**存疑（低）对比度**问题（F1 浅色 hot 徽标 3.90:1、F2 深色 `.dim` 正文 3.01:1）与 2 项观察（F3 缺失态 warn 意图未落地、F4 fresh 冗余入口），均非功能性、不影响本轮主张成立；F2 与仓库既有 vis-r41 判据同源，建议本轮顺带将新增「目的」行/分组头 id 由 `.dim` 提档至 `--text-sub`，F1 建议改 `--on-warn`。

---

## 处置后定向复验（F1/F2/F3）

- 触发：作者按 F1–F3 处置，工作树已改（`styles.css` 22:03、`App.tsx` 22:00），:5183 走 HMR 生效。
- 重取当前树 diff：`styles.css` 新增/改动为 `.collab-badge.hot{color:var(--on-warn)}`、`.ap-group-head .dim, .purpose-line .dim{color:var(--text-sub)}`、`.purpose-line.missing, .purpose-line.missing .dim{color:var(--warn)}`；`App.tsx` 仅委托段引导按钮 testid 由 `collab-open-settings` 改为 `collab-open-settings-delegate`（**顺带消除 F4 的重复 testid**）。
- 探针：`vis-r42-recheck.js`；截图 `vis-r42-recheck-*.png`。

### F1 —— `.collab-badge.hot` 正文色改 `--on-warn`
- **浅色**：`color=rgb(255,255,255)`、`bg=rgb(150,112,10)`（11px/600）→ **4.55:1** ≥ 4.5 **达标**（原 3.90）。
- **深色**：`color=rgb(42,36,16)`、`bg=rgb(208,176,122)` → **7.49:1** 达标。
- 证据：`vis-r42-recheck-badge-hot-light.png`、`vis-r42-recheck-badge-hot-dark.png`。

### F2 —— 新增文本提档 `--text-sub`（收窄到本轮新增元素）
- **深色分组头会话 id** `.ap-group-head .dim`：`rgb(154,170,184)`（=--text-sub）→ **7.40:1** ≥ 4.5 **达标**（原 3.01）。
- **深色「目的」行标签** `.purpose-line .dim`：`rgb(154,170,184)`（=--text-sub），与分组头同色同底 → 约 6.5–7.4:1 达标。
- 全局 `.dim` 未改（收窄生效）：仅新增元素被提档，其余 `.dim` 保持原值（未引入全局副作用）。
- 证据：`vis-r42-recheck-groups-dark.png`。

### F3 —— 缺失态内层 `.dim` 改为 `--warn`
- **浅色**：缺失卡「目的」标签与「未提供（Agent 未收到委托说明）」正文均为 `rgb(150,112,10)`（=--warn #96700a），正文对比度 **4.55:1** 达标；同一面板**有目的卡**为 `label=rgb(77,91,104)`（--text-sub）、`text=rgb(36,46,56)`（--text）→ **颜色可区分**（缺失=warn 金，有目的=次/正文灰）。
- **深色**：缺失卡标签与正文均为 `rgb(208,176,122)`（=--warn #d0b07a），正文对比度 **7.54:1** 达标；有目的卡为 `label=rgb(154,170,184)`、`text=rgb(212,219,230)` → 可区分。
- 证据：`vis-r42-recheck-purpose-missing-light.png`、`vis-r42-recheck-purpose-missing-dark.png`。

### 小结
- F1/F2/F3 **三项处置均独立复验达标**（对比度全部 ≥ AA 4.5，缺失态渲染色已为 `--warn` 且与有目的卡可区分）；**F4 顺带修复**（testid 去重）。
- 复验过程**未发现新问题**；零 JS 异常。原「8 项清单达标」结论维持，此前登记的 4 项存疑/观察**全部关闭**。
