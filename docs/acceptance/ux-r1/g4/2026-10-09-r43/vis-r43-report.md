# R43（C9：新装启用、原子停用与旧 Agent 配置迁移）demo 域视觉复验报告

- 复验者：独立视觉复验 subagent（作者自查不算数）
- 日期：2026-10-09
- 仓库：`/Users/chenpu/workspace/claude-code/TinySSH`
- 域：**demo 域（浏览器演示模式）**，Vite dev server `http://localhost:5183/`（无头 Chrome + Playwright）
- 被验代码快照（复验期间两次取样一致，作者未并行改树）：
  - `ui/src/App.tsx` md5 `ddae99e281967cde27c3f21c445cfdf0`（mtime 2026-10-09 22:47:31）
  - `ui/src/demo.ts` md5 `a39baa945f4a984e4cd0ca6be3f35782`（mtime 2026-10-09 22:59:21）
  - `git diff -- ui/src/App.tsx ui/src/demo.ts` md5 `d5aec0d4f40a0f7fefc0b9d90bd14ec4`（R43 为**未提交工作树**，HEAD = cd7c0c7/R42）
- 探针：`vis-r43-probe.js`（复现命令：`node docs/acceptance/ux-r1/g4/2026-10-09-r43/vis-r43-probe.js`）
- 机器可读证据：`vis-r43-evidence.json`
- 辅助诊断脚本：`vis-r43-diag.js`（对比度助手假红定位，见「探针工艺」节）
- **补验（F3/F5 处置后新增的 DisableFailed 重试面）：见文末「补验：DisableFailed 重试面（F3/F5 处置后）」节**（快照 md5 已变更，`App.tsx c19baaee…` / `demo.ts 7732c43b…`）

## 0. 结论摘要

| # | 界面 | 判定 |
|---|---|---|
| 1 | 新装停用态 · 协作面板 | **所见 = 期望**（含 1 项低severity观察） |
| 2 | 新装停用态 · 设置 → Agent 接入 | **所见 = 期望** |
| 3 | 启用后 · 设置 → Agent 接入 | **所见 = 期望**（端点「精确形态」在 demo 域**未实证**，见 §3.2） |
| 4 | 停用预览对话框 | **所见 = 期望** |
| 5 | 停用后 · 设置 | **所见 = 期望** |
| 6 | 浅/深主题 × 1024/960 窄窗覆盖 | **所见 = 期望** |

**未发现任何阻断级或中等级缺陷**：零元素重叠、零裁切、零按钮不可达、零空壳渲染、四轮场景（浅色/深色/1024/960）**零 JS 异常**。

发现 4 项**低严重度**对比度/文案问题，其中 1 项为 R43 新增面（`停用协作…` 按钮浅色 3.91:1），其余 3 项为**沿袭既有的全局 `--dim` 令牌问题**（R35 视觉复验已登记）在 C9 新面上的延伸。

---

## 1. 新装停用态 · 协作面板

截图：`vis-r43-01-collab-disabled-fresh-light.png`、`vis-r43-06-collab-disabled-fresh-dark.png`

**场景**：`?fresh` + `localStorage.clear()` → 连 `prod-1`（协作面板入口在会话工具栏，无会话不可达）→ 点 `tools-collab`。

### 所见 = 期望

| 期望 | 实测（像素/几何证据） |
|---|---|
| `collab-disabled` 停用指引存在 | 计数 1；文本「协作已停用。新 Agent 请求已被拒绝。打开设置 → Agent 接入」；包围盒 `(907, 172, 363×73.4)` |
| **无**空审批区（无 `ap-group`） | `[data-testid="ap-group"]` = **0** |
| **无**审批列表容器 | `.collab-approvals` = **0** |
| **无**空白委托表单 | `.goal-input` = 0、`.task-panel textarea` = **0** |
| 无协作徽标 / 无委托入口 | `collab-entry` = 0、`delegate-open` = 0 |
| 面板不溢出/不裁切 | `.task-panel` scroll 383/383、652/652（`hClip=false, vClip=false`） |
| 指引内按钮可达 | `collab-open-settings` 包围盒 `(931, 206.4, 154×31)`，中心 `elementFromPoint` 命中自身（`hitTestid="collab-open-settings"`） |
| 同层无重叠 | `.tp-scroll` 子元素两两重叠扫描 = **[]** |
| 深色一致 | 深色同结构同计数，`data-chrome=dark` |

面板实际渲染的区块清单（`.tp-scroll` 内 `.section` 普查）：

```
委托      h=94.1  textarea=0 btn=1  「协作已停用，暂不能委托。先到「设置 → Agent 接入」启用。」
任务目标  h=63.1  textarea=0 btn=0  「协作未启用。任务目标用于向 Agent 说明委托意图。」
现场简报  h=151.5 textarea=0 btn=0  已核实 当前目录 /var/log/nginx；已核实 $ df -h · 成功；需复核 重连后进入重确认…
```

即：停用态面板**不是空的**，除指引外仍渲染 `委托/任务目标/现场简报` 三块（`App.tsx:5103` 的第二个 `rightPanel === "collab"` 分支是**无条件**渲染的）。这三块均为「说明文字 + 零输入控件」，**不构成空白委托表单**，符合 §6.7 的「不渲染空壳表单」要求。

### 观察 O-1（低）：同屏两个完全相同的「打开设置 → Agent 接入」按钮

- 证据：`dupButtons('.tp-scroll')` → `{"打开设置 → Agent 接入":[{"testid":"collab-open-settings","y":206.4,"x":931},{"testid":"collab-open-settings-delegate","y":308.5,"x":907}]}`
- 两个按钮文案、样式完全一致，纵向相距 102px，中间只隔一个「委托」小标题。
- **归属**：该重复在 HEAD(R42) 的「未接入 Agent」态**已存在**（`App.tsx@HEAD:4989` 与 block-1 的 `collab-open-settings` 并存）；R43 把 block-2 的文案改为按 `collabEnabled` 分支（`App.tsx:5111` diff `+` 行），从而把这一重复**扩展到停用态**。
- **严重度：低**（可用性冗余，非功能缺陷）。最小复现：`?fresh` → 连主机 → 开协作面板。

### 观察 O-2（低，沿袭）：浅色面板内最低对比度 4.03:1

- 证据：`panelMinContrast('.task-panel')` 浅色 = `{ratio: 4.03, text: "需复核"}`（`.epistemic-badge`，11px），深色 = `{ratio: 2.70, text: "成功"}`（现场简报卡内 `.dim` 文本）。
- 二者均属 R42 引入的现场简报组件，**非 R43 面**；深色根因为全局 `--dim`（见 §7）。

---

## 2. 新装停用态 · 设置 → Agent 接入

截图：`vis-r43-02-settings-disabled-fresh-light.png`、`vis-r43-07-settings-disabled-fresh-dark.png`、
`vis-r43-11-settings-disabled-narrow-1024-light.png`、`vis-r43-11-settings-disabled-narrow-960-light.png`

**入口工艺**：停用态面板有 `collab-open-settings`，点击直达；**完整面板态没有该入口**，须走主机栏 `.hb-settings` + `settings-cat-agent`（探针内两路都实现）。

### 所见 = 期望

| 期望 | 实测 |
|---|---|
| `collab-disabled-note` 文案 | 计数 1；「协作已停用——MCP 端点未运行，Agent 请求一律被拒绝。要使用协作请显式启用。」 |
| **无** MCP 端点 | `[data-testid="agent-endpoint"]` = **0** |
| **无**停用钮 | `[data-testid="collab-disable-btn"]` = **0** |
| **有**启用钮 | `[data-testid="collab-enable-btn"]` = 1，文案「启用协作」，中心命中自身（可达） |
| 无已配置 Agent 时**不**渲染 `collab-kept-agents` 空壳 | `[data-testid="collab-kept-agents"]` = **0**；`agent-list`=0、`agent-empty`=0 |
| 状态 chip | 「协作已停用」；浅色 `rgb(179,72,77)`/白底 4.91:1，深色 `rgb(208,122,122)`/`rgb(20,25,34)` 5.66:1 |
| 指标可见 | 「已配置 0」「有活动请求 0」 |
| 分类高亮 | `settings-cat-agent` `aria-selected="true"`、`class="on"`；`settings-pane-agent` 计数 1 |
| 面板完整落在视口内 | 1280: `(330, 283.5)–(950, 516.5)` fully=true；1024: `(202, 267.5)–(822, 500.5)` fully=true；960: `(170, 183.5)–(790, 416.5)` fully=true |
| 无裁切 / 无重叠 | `.settings-pane` scroll 498/498、170/170；`scanOverlap` = **[]**；`navVsPane` 交叠宽 **−12**（负值=无交叠） |
| 深色一致 | 同结构；chip 深色对比 5.66:1 |

窄窗下 `.settings-nav`（84px）与 `.settings-pane`（498px）并排，未挤压、未换行错位（见两张窄窗截图）。

---

## 3. 启用后 · 设置 → Agent 接入

截图：`vis-r43-03-settings-enabled-light.png`、`vis-r43-08-settings-enabled-dark.png`

### 所见 = 期望

| 期望 | 实测 |
|---|---|
| 状态 chip「协作已启用」 | 文本「协作已启用」；浅色 `rgb(46,125,50)`/白底 **4.73:1**，深色 `rgb(127,191,143)`/`rgb(20,25,34)` **8.18:1** |
| MCP 端点可见 | `agent-endpoint` = 1，文本 `http://127.0.0.1:8722/mcp（演示模式）`，包围盒 `(465.9, 408.4, 240.2×13)` |
| 「已配置 N」与「有活动请求 N」**分别**可见 | 两个独立 span：`collab-configured` `(512.7, 301.6, 44×16)`、`collab-active` `(556.6, 301.6, 66.2×16)`；**交叠宽 = 0**（`cfgVsActOverlap={w:0,h:16,area:0}`，即水平零交叠、各自独立） |
| 停用钮出现 | `collab-disable-btn` = 1，文案「停用协作…」，包围盒 `(439, 534.5, 86×31)`，中心命中自身（可达） |
| 启用钮消失 | `collab-enable-btn` = 0 |
| 无 Agent 时给空态说明 | `agent-empty` = 1（「暂无 Agent 接入——按下方三步接入。」） |
| 无裁切 / 无重叠 | `.settings-pane` scroll 498/498、294/294；`scanOverlap` = **[]** |

### 3.1 缺陷 D-1（低，**R43 新增面**）：`停用协作…` 按钮浅色对比度 3.91:1，低于 WCAG AA 4.5:1

- 证据：`paneMinContrast('[data-testid="settings-pane-agent"]')` 浅色 = `{ratio: 3.91, text: "停用协作…"}`
- 手工复核：按钮 `color: rgb(229, 72, 77)`（`App.tsx:4476` 的 `var(--err, #e5484d)`），所在面板 `.term-settings.settings-wide` 背景 `rgb(255,255,255)`（探针 `settingsZ.bg` 实测）→ `(1.05)/(0.2183+0.05) = 3.91`。深色同按钮为 `rgb(229,72,77)`/`rgb(28,36,51)`，约 5.0:1（合格）。
- 影响：12px 正文级按钮文字，浅色下未达 AA。
- **最小复现**：`?fresh` → 连主机 → 设置 → Agent 接入 → 启用协作 → 观察 `停用协作…`。
- 取向建议（不越本轮范围，仅登记）：与 R35 对 `--dim` 正文的处理同法，改走 `--text-sub` 或提高 `--err` 在浅底上的亮度。

### 3.2 端点「精确形态」在 demo 域**未实证**（如实声明）

任务要求「MCP 端点形态为 `http://127.0.0.1:<port>/mcp`」。实测渲染串为：

```
http://127.0.0.1:8722/mcp（演示模式）
```

- **匹配的部分**：`http://127.0.0.1:<port>/mcp` 前缀精确成立（端口 8722，`127.0.0.1` 字面量）。
- **未实证的部分**：demo 串带中文后缀「（演示模式）」，故 `^\d+$/mcp$` 的**精确尾界**在 demo 域**无法判定**。r43-demo-probe 亦以「前缀正则 + 注释声明」处理同一限制。
- 结论：**demo 域仅实证「端点出现且为 127.0.0.1:port/mcp 形态」，精确串形态属原生域，本报告不认领。**
- 附带：端点文本 Range 实测宽 240.2px < 面板 498px，**未截断**（该元素是 inline span，`clientWidth` 恒 0，探针改用 `Range.getBoundingClientRect` 度量）。

### 3.3 观察 O-3（低，沿袭 R42，非 R43 diff）：字面 markdown 星号泄漏进界面

- 实测文本（浅色/深色截图均可目视确认）：
  `登记 Agent **不会**转移任何会话的控制权。要把某个会话交给 Agent，在会话工具栏或协作面板点「交给 Agent…」并明确确认。`
- `**不会**` 的星号**原样渲染**给用户，未做强调。
- **归属核验**：该行在 `App.tsx:4473`，对应 diff 中为**上下文行（非 `+`）**；`git show HEAD:ui/src/App.tsx:4384` 同样含 `**不会**` → **R42 引入，R43 未新增也未修复**。
- 严重度：低（文案瑕疵）。最小复现：启用协作后「设置 → Agent 接入」面板末段。

---

## 4. 停用预览对话框（`collab-disable-dlg`）

截图：`vis-r43-04-disable-dlg-light.png`、`vis-r43-09-disable-dlg-dark.png`、
`vis-r43-12-disable-dlg-narrow-1024-light.png`、`vis-r43-12-disable-dlg-narrow-960-light.png`

**场景前置（制造非零事实）**：签发 1 个 Agent（`issue_agent` id `vis-r43-agent`）→ 注入 1 条待审批（`demo_inject_approval`）→ 委托 1 台会话（`delegate_session`）→ 前置计数实测「已配置 1 / 有活动请求 2」。

### 所见 = 期望

| 期望 | 实测 |
|---|---|
| 对话框出现 | `collab-disable-dlg` = 1，标题「停用协作？」 |
| 三项事实**可读** | `.dlg-facts .fact` 三项全文：<br>「受影响的 Agent 会话 **1** （转为你的控制，不自动终止已开始的任务）」<br>「待审批请求 **1** （作废）」<br>「已配置 Agent **1** （身份与 Token 保留）」 |
| 「Token 保留」措辞存在 | `hasTokenKeep = true`（命中「身份与 Token 保留」） |
| 取消与确认两钮 | `collab-disable-confirm`「确认停用」`(693, 540.7, 72×31)`、`collab-disable-cancel`「取消」`(773, 540.7, 50×31)`；两者 `hit=true`（中心命中自身，未被遮挡） |
| 不承诺全清（披露完备） | 正文含「运行中的 Agent 任务不会被自动终止；应用拥有的 MCP 端点随之停止（外部 shim 是独立进程，不受影响）。重新启用须显式操作，先前作废的请求不会复活。」 |
| 层级正确（盖过设置面板） | `.confirm-mask` `position:fixed; z-index:90`；`.term-settings.settings-wide` `z-index:42` → 遮罩在上 |
| 对话框完整落在视口内 | 1280: `(440, 213.3)–(840, 586.7)` fully=true<br>1024: `(312, 197.3)–(712, 570.7)` fully=true<br>**960×600**: `(280, 113.3)–(680, 486.7)` fully=true（400px 宽 < 960，高 373.3 < 600） |
| 无裁切 / 无重叠 | `dlgClip` scroll 398/398、371/371（`hClip=false, vClip=false`）；`scanOverlap('[data-testid="collab-disable-dlg"]')` = **[]**（浅/深/1024/960 四次全空） |
| 中心命中在对话框内 | `centerHit` 返回 `DIV`（非 mask）→ 对话框在最上层 |

### 观察 O-4（低，沿袭）：深色下对话框说明文字 3.01:1

- 证据：`dlgMinContrast` 深色 = `{ratio: 3.01, text: "确认后立即封闭入口——新 Agent 请求一律被拒绝，不等待你逐个接管；已有请求…"}`；浅色 = `{ratio: 5.25, text: "受影响的 Agent 会话"}`
- 根因：对话框正文 `App.tsx:3737` 用 `.dim`，深色 `--dim = #5d6f82` 落在 `--panel2 = #1c2433` 上 = 3.01:1（见 §7）。11–12px 正文级，未达 AA 4.5:1。
- 目视：文字可读但明显偏暗（见 `vis-r43-09-disable-dlg-dark.png`）。

---

## 5. 停用后 · 设置

截图：`vis-r43-05-settings-disabled-kept-light.png`、`vis-r43-10-settings-disabled-kept-dark.png`

### 所见 = 期望

| 期望 | 实测 |
|---|---|
| 状态 chip「协作已停用」 | 浅色 `rgb(179,72,77)`/白底 **4.91:1**；深色 `rgb(208,122,122)`/`rgb(20,25,34)` **5.66:1** |
| 端点消失 | `agent-endpoint` = **0** |
| `collab-kept-agents` 列出保留的 Agent | 计数 1；文本「已配置的 Agent（Token 保留，重新启用后继续可用）：**R43 视觉复验 Agent**」；包围盒 `(439, 416.2, 498×17)`，fully in viewport |
| 停用说明仍在 | 「协作已停用——MCP 端点未运行，Agent 请求一律被拒绝。要使用协作请显式启用。」 |
| 停用钮消失 / 启用钮回归 | `collab-disable-btn` = 0、`collab-enable-btn` = 1 |
| 指标一致 | 「已配置 1」「有活动请求 0」（停用后待审批作废、会话转 Human → 活动请求归 0） |
| 无裁切 / 无重叠 | `.settings-pane` scroll 498/498、170/170；`scanOverlap` = **[]** |
| 行为旁证（视觉外的界面反馈） | 右下 toast：「协作已停用——作废 1 个待审批、1 个 Agent 会话转回你控制」（截图内可见） |

对比度：浅色 `keptMinContrast` = 5.69:1（合格）；深色 = 3.01:1（同 §7 全局 `--dim` 问题）。

---

## 6. 主题与窄窗覆盖矩阵

| 界面 | 浅色 1280×800 | 深色 1280×800 | 1024×768 | 960×600 |
|---|---|---|---|---|
| 1 停用态协作面板 | ✅ 01 | ✅ 06 | — | — |
| 2 停用态设置 | ✅ 02 | ✅ 07 | ✅ 11-1024 | ✅ 11-960 |
| 3 启用后设置 | ✅ 03 | ✅ 08 | — | — |
| 4 停用预览对话框 | ✅ 04 | ✅ 09 | ✅ 12-1024 | ✅ 12-960 |
| 5 停用后设置 | ✅ 05 | ✅ 10 | — | — |

（窄窗覆盖按任务要求聚焦 4 与 2；1/3/5 在窄窗下与 2 同属设置/面板容器，未单独截。）

四轮场景 **零 JS 异常**：`L JS 异常 []`、`D JS 异常 []`、`N1024 JS 异常 []`、`N960 JS 异常 []`。

### 视觉缺陷专项排查（逐项结论）

| 检查项 | 结论 | 证据 |
|---|---|---|
| 元素重叠 | **无** | `.tp-scroll` / `.settings-pane-agent` / `collab-disable-dlg` 三处 `scanOverlap` 全为 `[]`；`.settings-nav` vs `.settings-pane` 交叠宽 −12（分离） |
| 裁切 | **无** | `.task-panel` 383/383·652/652、`.settings-pane` 498/498、`collab-disable-dlg` 398/398·371/371、`collab-disabled-note` 498/498 —— 全部 `hClip=false, vClip=false` |
| 文字截断 | **无** | 端点串 Range 实测 240.2px < 容器 498px；指引文本 Range 233.5×57.4 完全展开（`white-space:normal, overflow:visible`） |
| 空壳/留白 | **无空壳** | 停用态 `collab-kept-agents`=0（无 Agent 时不渲染）、审批容器=0；启用态无 Agent 时给 `agent-empty` 说明文字而非空列表 |
| 按钮不可达（被遮挡） | **无** | `collab-open-settings` / `collab-enable-btn` / `collab-disable-btn` / `collab-disable-confirm` / `collab-disable-cancel` 五处中心 `elementFromPoint` 全部命中自身 |
| 暗色对比度不足 | **有（低）** | 见 §7 |

---

## 7. 缺陷与观察清单（按严重度）

| ID | 严重度 | 归属 | 描述 | 最小复现 |
|---|---|---|---|---|
| D-1 | **低** | **R43 新增面** | `停用协作…` 按钮浅色 3.91:1 < AA 4.5（`--err` #e5484d on white） | `?fresh`→连主机→设置→Agent 接入→启用→看该按钮 |
| D-2 | **低** | 沿袭（全局令牌，R35 已登记） | 深色 `--dim`(#5d6f82) 落 `--panel2`(#1c2433) ≈ **3.01:1** < AA。C9 面上命中：`collab-kept-agents` 行、停用对话框正文、`.ts-label`「Agent 接入（MCP）」 | 深色下开「设置 → Agent 接入」（启用或停用态均可） |
| O-1 | 低 | 沿袭（R43 扩展到停用态） | 停用态面板同屏两个文案完全相同的「打开设置 → Agent 接入」按钮（y=206.4 与 y=308.5） | `?fresh`→连主机→开协作面板 |
| O-2 | 低 | 沿袭 R42 | 现场简报内 `.dim` 文本深色 2.70:1（"· 成功"）、浅色「需复核」徽标 4.03:1 | 开协作面板看「现场简报」卡 |
| O-3 | 低 | 沿袭 R42（非 R43 diff） | 字面 `**不会**` 星号原样渲染 | 设置→Agent 接入（启用态）末段 |

> 说明：D-2 的根因是**全局 `--dim` 令牌**而非 C9 逻辑。R35 视觉复验已就同一令牌登记「深色 --dim 正文 3.01–3.41 低于 AA」。本报告如实登记其**在 C9 新增面上的延伸**（`collab-kept-agents`、停用对话框正文），**不主张 C9 引入了新的令牌问题**。

---

## 8. 未实证 / 越界声明（如实）

1. **MCP 端点精确串形态未在 demo 域实证**（§3.2）：demo 渲染串含「（演示模式）」后缀，仅前缀 `http://127.0.0.1:8722/mcp` 成立。精确 `^\d+$/mcp$` 尾界属**原生域**，本报告不认领。
2. **demo 域无真实 SSH/MCP**：所有「端点停止/请求被拒」均为 demo 状态投影；真实面由 core `r43_tests` 与原生冒烟覆盖。
3. **窄窗仅覆盖 1024/960 的界面 4 与 2**（按任务范围）；未做 1/3/5 的窄窗截。
4. **未跑原生 GUI**（屏幕可能锁定，任务明令不跑）。
5. **对比度阈值为 WCAG AA（正常文本 4.5:1）**；未按 AAA 评估。徽标/标签等 11px 文本一律按正常文本口径判定。
6. 本次复验为**只读渲染**，未修改工作树；唯一新增文件是本目录下的探针/证据/报告（`docs/acceptance/ux-r1/g4/2026-10-09-r43/`，未跟踪）。

## 9. 探针工艺（本轮踩坑与修正，供后续复用）

1. **对比度助手必须做 alpha 合成**：首轮 `effBg` 取「第一个非透明背景」并忽略 alpha，把 `.brief-fact.confirmed` 的 `rgba(46,125,50,0.08)` 底当成纯色 (46,125,50)，与同色文字算出 **ratio=1.0 的假红**。修正为「祖先链背景按 alpha 自底向上合成」后，该处回到 4.03:1（真实值）。`vis-r43-diag.js` 记录了这次定位。
2. **inline 元素的 `clientWidth` 恒 0**：`agent-endpoint` 是 `<span>`，用 `scrollWidth/clientWidth` 判截断会得到 `0/0` 的无意义结果；改用 `Range.getBoundingClientRect()` 量实际文本宽。
3. **停用态面板入口在会话工具栏**：`tools-collab` 需先连一台主机才可达；停用态面板自带 `collab-open-settings`，完整面板态没有 → 须回落到 `.hb-settings` + `settings-cat-agent`（探针内两路并存）。
4. **停用态面板含第二个无条件 collab 分支**（`App.tsx:5103`）：只按 `[data-testid="collab-disabled"]` 断言会漏看 `委托/任务目标/现场简报` 三块，故补 `.section` 普查与同文案按钮去重扫描。
5. **`?fresh` 需先清 localStorage 再重载**：demo 的 `chrome` 外观落 `localStorage["ui.v2.workspace"]`，不清会把上一轮主题带进来。
6. **深色切换走 UI**（`.hb-settings` → `.ts-appearance` 的「深色」）而非直接写 localStorage，以保证验的是用户真实路径。

## 10. 证据文件清单

截图（14 张，均在 `docs/acceptance/ux-r1/g4/2026-10-09-r43/`）：

```
vis-r43-01-collab-disabled-fresh-light.png        vis-r43-06-collab-disabled-fresh-dark.png
vis-r43-02-settings-disabled-fresh-light.png      vis-r43-07-settings-disabled-fresh-dark.png
vis-r43-03-settings-enabled-light.png             vis-r43-08-settings-enabled-dark.png
vis-r43-04-disable-dlg-light.png                  vis-r43-09-disable-dlg-dark.png
vis-r43-05-settings-disabled-kept-light.png       vis-r43-10-settings-disabled-kept-dark.png
vis-r43-11-settings-disabled-narrow-1024-light.png vis-r43-11-settings-disabled-narrow-960-light.png
vis-r43-12-disable-dlg-narrow-1024-light.png      vis-r43-12-disable-dlg-narrow-960-light.png
```

其他：`vis-r43-probe.js`（探针）、`vis-r43-evidence.json`（机器可读证据）、`vis-r43-diag.js`（对比度假红定位辅助脚本）。

---

# 补验：DisableFailed 重试面（F3/F5 处置后）

- 触发：独立审核 F3/F5 处置在首轮复验之后改动了 UI（新增 `DisableFailed` 分支与「重试停用收敛」钮）
- **复验快照（对账用）**：
  - `ui/src/App.tsx` mtime **2026-10-09 23:19:17**，md5 **`c19baaee75501742ec1ee02c9a2503ca`**（首轮快照为 `ddae99e281967cde27c3f21c445cfdf0` @ 22:47:31）
  - `ui/src/demo.ts` mtime **2026-10-09 23:16:38**，md5 **`7732c43b1259c2a48e0ae84efc693d95`**（首轮为 `a39baa945f4a984e4cd0ca6be3f35782` @ 22:59:21）
  - `git diff -- ui/src/App.tsx ui/src/demo.ts` md5 `9a57ec32904e988ce7224865a362f045`
  - 复验期两次取样一致（探针前后各一次），作者未并行改树。
- 探针：`vis-r43-probe2.js`（复现：`node docs/acceptance/ux-r1/g4/2026-10-09-r43/vis-r43-probe2.js`）
- 证据：`vis-r43-evidence2.json`

**结论：新增面无阻断级/中等级缺陷；4 项补验全部「所见 = 期望」，另登记 1 项低severity文案重复（O-5）。四轮场景零 JS 异常。**

## B-1. `?disablefailed` 停用态 · 设置 → Agent 接入

截图：`vis-r43-13-disablefailed-light.png`（浅色）、`vis-r43-15-disablefailed-dark.png`（深色）

**场景**：`?disablefailed` + `localStorage.clear()` → 连 `prod-1` → 协作面板 → `collab-open-settings`。
（demo 默认已登记 1 个 Agent `opencode（演示）`，故 `collab-kept-agents` 行一并可见。）

### 所见 = 期望

| 期望 | 实测（浅色 / 深色） |
|---|---|
| 只出现「重试停用收敛」钮 | `collab-retry-disable-btn` = **1**，文案「重试停用收敛」；盒 `(439, 462.8, 96×29)`；中心 `elementFromPoint` 命中自身 |
| **不**出现「启用协作」钮 | `collab-enable-btn` = **0** / **0** |
| 不出现停用钮 | `collab-disable-btn` = **0** / **0** |
| 提示文案可读且指明先重试 | `collab-disabled-note` = 「上次停用未完全收敛（协作保持封闭，新 Agent 请求仍被拒绝）——请先「重试停用收敛」，收敛后才可重新启用。」；盒 `(439, 388.6, 498×43.2)`（2 行）；Range 文本宽 496.7px，容器 498px；`noteClip` scroll 498/498、43/43 → `hClip=false, vClip=false` |
| 无 MCP 端点 | `agent-endpoint` = **0** / **0** |
| 状态 chip | 「停用失败（保持封闭）」；浅色 `rgb(179,72,77)` 4.91:1，深色 `rgb(208,122,122)` 5.66:1 |
| 指标可见 | 「已配置 1」「有活动请求 4」 |
| Token 保留说明 | `collab-kept-agents` = 1：「已配置的 Agent（Token 保留，重新启用后继续可用）：opencode（演示）」 |
| 无重叠 / 无裁切 | `scanOverlap('[data-testid="settings-pane-agent"]')` = **[]**；`.settings-pane` 498/498·170/170；`.settings-nav` vs pane 交叠宽 **−12** |
| 面板完整落在视口内 | 浅/深均 `(330, 283.5)–(950, 516.5)`，`fully=true` |
| 按钮语义单一（无并存歧义） | `paneButtons` 全量清单 = **仅** `[{t:"重试停用收敛", testid:"collab-retry-disable-btn", hit:true}]` |

深色截图（`vis-r43-15`）目视确认：同结构、同单一按钮、chip 红字、说明两行、`--panel2` 深底配色一致。

## B-2. 窄窗 1024 / 960

截图：`vis-r43-16-disablefailed-narrow-1024-light.png`、`vis-r43-16-disablefailed-narrow-960-light.png`

| 视口 | 面板包围盒 | 完整在视口内 | 新钮盒 | 中心命中自身 | 文案裁切 |
|---|---|---|---|---|---|
| 1024×768 | `(202, 267.5)–(822, 500.5)` | ✅ `fully=true` | `(311, 446.8, 96×29)` | ✅ `hit=true` | `hClip=false, vClip=false`（498/498、43/43） |
| 960×600 | `(170, 183.5)–(790, 416.5)` | ✅ `fully=true` | `(279, 362.8, 96×29)` | ✅ `hit=true` | `hClip=false, vClip=false`（498/498、43/43） |

**所见 = 期望**：两视口下新钮与说明文案均不溢出、不裁切、不被遮挡（`paneOverlaps` = `[]`）。

> 紧度登记（非缺陷）：说明文案的最长行 496.7px 落在 498px 容器内，**余量仅 1.3px**。当前 `overflow-x: visible` 且无裁切；若日后字体度量或文案长度微调，该行可能溢出容器。建议后续把该行改为显式换行/放宽容器，避免贴边。

## B-3. 收敛后态（按钮语义切换）

截图：`vis-r43-14-after-retry-converged-light.png`

| 时点 | chip | 重试钮 | 启用钮 | 停用钮 | 端点 | kept-agents |
|---|---|---|---|---|---|---|
| 点击前 | 「停用失败（保持封闭）」 | 1 | 0 | 0 | 0 | 1 |
| 点「重试停用收敛」后 | **「协作已停用」** | **0** | **1**（「启用协作」，`hit=true`） | 0 | 0 | 1 |

- 反馈旁证（截图内可见 toast）：「停用已收敛——作废 2 个待审批、2 个 Agent 会话转回你控制」
- 说明文案随状态切换为「协作已停用——MCP 端点未运行，Agent 请求一律被拒绝。要使用协作请显式启用。」
- **所见 = 期望**：按钮语义在视觉上确实从「重试停用收敛」切换为「启用协作」，且同一时刻**不并存**两个钮。

## B-4. 对比度复查

| 元素 | 主题 | 前景 / 背景 | 对比度 | AA(4.5:1) |
|---|---|---|---|---|
| **新钮「重试停用收敛」** | 浅色 | `rgb(255,255,255)` / `rgb(31,118,124)` | **5.33:1** | ✅ 通过 |
| **新钮「重试停用收敛」** | 深色 | `rgb(11,21,22)` / `rgb(61,157,168)` | **5.81:1** | ✅ 通过 |
| 状态 chip「停用失败（保持封闭）」 | 浅色 | `rgb(179,72,77)` | 4.91:1 | ✅ |
| 状态 chip「停用失败（保持封闭）」 | 深色 | `rgb(208,122,122)` | 5.66:1 | ✅ |
| pane 内最低值 | 浅色 | — | 4.91:1 | ✅ |
| pane 内最低值 | 深色 | `--dim` `.ts-label`「Agent 接入（MCP）」 | **3.01:1** | ❌（= 既有 D-2，全局令牌，非本轮新增） |

**判定**：新钮是**实心主按钮**（`inline-flex` + 品牌底色），**不是**首轮 D-1 中 `停用协作…` 那种 ghost + `var(--err, #e5484d)` 的同族控件，因此**未继承 3.91:1 问题**，浅/深两主题均通过 AA。

**首轮 D-1 状态未变**：`停用协作…` 仍为 `color: var(--err, #e5484d)`（`App.tsx:4492-4494`），只在 `Enabled` 态渲染 → 浅色 **3.91:1 < AA** 的低severity问题**依然存在**，处置与否待你侧决定。本轮**无新增低对比度面**。

> **归属更正（第三轮）**：作者以「R43 之前就存在的同族控件」为由登记沿袭。经 git 实测，`collab-disable-btn` 在 HEAD(R42) **不存在**、由 **R43 新增**——它属 R43 新面而非沿袭面。结论与证据见 **B-9**。
> **状态更新（第四轮）**：作者采纳并按最小修法正名取色令牌（`var(--err, #e5484d)` → `var(--danger)`），复验浅 **5.32:1** / 深 **5.00:1** 均过 AA → **D-1 已闭合**，详见 **B-10**。（本段为第四轮修复前的现场记录，保留原文以供对照。）

## B-5. 新增观察

| ID | 严重度 | 描述 | 证据 | 最小复现 |
|---|---|---|---|---|
| O-5 | 低 | 协作面板停用态指引同句内重复「（保持封闭）」：`collabStateText` 已含该词，后缀分支在 `DisableFailed` 时又追加一次 → 渲染为「**停用失败（保持封闭）。新 Agent 请求已被拒绝（保持封闭）。**」 | `[data-testid="collab-disabled"]` 文本实测；`App.tsx:4653-4654`（`{collabStateText}。` + `DisableFailed ? "（保持封闭）。"`） | `?disablefailed` → 连主机 → 开协作面板（截图 `vis-r43-13` 面板顶部可见） |

仅 `DisableFailed` 态出现；`Disabled`/`Disabling` 态文案正常（首轮已验）。属文案重复，非功能缺陷。

> **状态更新（第三轮）：O-5 已闭合**——作者删除该后缀分支后，实测「保持封闭」出现次数 = **1**，整句通顺；详见 **B-8**。（上表为第三轮修复前的现场记录，保留原文以供对照。）

## B-6. 补验覆盖矩阵与异常

| 项 | 浅色 1280×800 | 深色 1280×800 | 1024×768 | 960×600 |
|---|---|---|---|---|
| B-1 停用失败态设置 | ✅ 13 | ✅ 15 | ✅ 16-1024 | ✅ 16-960 |
| B-3 收敛后态 | ✅ 14 | — | — | — |

四轮场景 **零 JS 异常**：`F 浅色 JS 异常 []`、`F 深色 JS 异常 []`、`F1024 JS 异常 []`、`F960 JS 异常 []`。

## B-7. 补验工艺踩坑（供复用）

1. **`.ts-appearance` 只在 `settingsCat === "appearance"` 时渲染**：切深色必须先点 `settings-cat-appearance`，否则 `querySelectorAll('.ts-appearance button')` 为空、静默不切换（首轮补验探针即因此把深色跑成了浅色，靠回读 `documentElement.dataset.chrome` 才抓到）。
2. **`tools-collab` 是开关不是「打开」**：面板已开时再点会**关掉**它，导致随后的 `collab-open-settings` 落空、整段取证返回 null。重开设置面板应走 `.hb-settings`（`case "settings"` 只置 `showSettings`，**不重置** `settingsCat`，故能停在 Agent 分类）。

## B-8. O-5 闭合（文案重复已修）

- **复验快照**：`ui/src/App.tsx` mtime **2026-10-09 23:40:03**，md5 **`2bfead79c3ab212f5c95f72e60670b6b`**（补验节快照为 `c19baaee…` @ 23:19:17；复验期两次取样一致）
- 探针：`vis-r43-probe3.js`（极窄复核，只读 DOM），证据 `vis-r43-evidence3.json`

**修复内容**（`App.tsx:4653-4654` 后缀分支删除 `DisableFailed ? "（保持封闭）。"`）：

```tsx
{collabStateText}。{collab.state === "Enabled" ? "" : "新 Agent 请求已被拒绝"}
{collab.state === "Disabling" ? "，正在收敛存量。" : "。"}
```

| 态 | `[data-testid="collab-disabled"]` textContent（实测） | 「保持封闭」出现次数 | 判定 |
|---|---|---|---|
| `DisableFailed`（`?disablefailed`） | 「停用失败（保持封闭）。新 Agent 请求已被拒绝。打开设置 → Agent 接入」 | **1**（原为 2） | **所见 = 期望**，整句通顺 |
| `Disabled`（`?fresh`） | 「协作已停用。新 Agent 请求已被拒绝。打开设置 → Agent 接入」 | 0 | **所见 = 期望**，未被破坏 |
| `Disabling` | — | — | **未实证**：`demo.ts` 全文无 `Disabling` 字样，该态在 demo 域**无复现路径**（真实面由 core `r43_tests` / 原生冒烟覆盖） |

**无新换行/溢出**（逐行几何实证）：

| 态 | 正文句 | 视觉行数 | 文本跨度 | 容器宽 | `overflow-x` | `scrollW/clientW` |
|---|---|---|---|---|---|---|
| `DisableFailed` | 「停用失败（保持封闭）。新 Agent 请求已被拒绝。」 | **1** | 266.1px | 266.1px（shrink-to-fit） | visible | 266/266 |
| `Disabled` | 「协作已停用。新 Agent 请求已被拒绝。」 | **1** | 211.5px | 211.5px | visible | 211/211 |

- 指引块整体包围盒 `(907, 172, 363×73.4)`，与修复前同态实测值**逐位一致**（未增长）。
- `.tp-scroll` `scrollW/clientW = 383/383`、`scrollHeight/clientHeight = 612/612` → `hClip=false, vClip=false`。
- 行数按「正文文本节点 client rects 的 y 值去重」计数（首轮我用 TreeWalker 只取到单个文本节点，会漏算跨行；此处改为遍历全部文本节点）。零 JS 异常。

**O-5 判定：已闭合。**

## B-9. D-1 归属更正（附证据）——它不是「R43 之前就存在的控件」

我方对「D-1 本轮不处置」的**结论**无异议（低severity、非阻断），但对其**理由**必须提出事实更正，因你方明确征询。

你方表述：「它是 R43 之前就存在的同族控件（`App.tsx:4492-4494` 本轮 diff 未触及），按项目惯例登记为沿袭既有问题」。

**实测证据（HEAD = cd7c0c7 / R42）**：

```
$ /usr/bin/git show HEAD:ui/src/App.tsx | grep -c "collab-disable-btn"   → 0
$ /usr/bin/git show HEAD:ui/src/App.tsx | grep -c "var(--err"            → 0
$ /usr/bin/git diff -- ui/src/App.tsx | grep -c "^+.*collab-disable-btn" → 1
```

R43 diff 中的 `+` 行（原文）：

```
+                <button className="ghost" style={{ marginTop: 8, color: "var(--err, #e5484d)" }}
+                  data-testid="collab-disable-btn" disabled={collabBusy}
+                  onClick={() => void openDisableDialog()}>停用协作…</button>
```

**结论**：
- `collab-disable-btn`（「停用协作…」）**在 HEAD(R42) 完全不存在**，由 **R43 新增**（`+` 行）。
- 因此 **D-1 是 R43 的「新增面」**，而非「沿袭既有控件」。「本轮 diff 未触及」仅对**最近的 O-5 修复轮**成立，对**R43 本轮**不成立。
- 沿袭的只是 `--err` 这个**令牌名**；但「把它用在浅底上的一个 ghost 按钮」这个决定是 R43 做出的。
  > **我方自更正（第四轮）**：本条原写「该令牌本身早于 R43」。经作者侧复核并由我复验（`getComputedStyle(document.documentElement).getPropertyValue('--err')` → `""`，`grep -rn 'var(--err' ui/src/` 修复后为空、修复前仅 `App.tsx:4492` 一处，`styles.css` 无 `--err` 定义）——`--err` **根本不存在**，是笔误；`var(--err, #e5484d)` 恒回退到硬编码 `#e5484d`。故准确说法是「沿袭的是**一个不存在的令牌名 + 其硬编码回退色**」。不影响本条归属结论。

**我方判断（供你侧决策，不主张阻断）**：
- D-1 严重度**低**（12px 按钮文字 3.91:1 vs AA 4.5:1），**不构成阻断**，不改变我 B-1..B-4 的「所见 = 期望」判定。
- 但若以「沿袭既有问题」为由豁免，则 R43 的**新增控件**将带着一处 AA 未达标进入主干；这与 R35 时对 `.xfer-sub`/`.queue-count`/`.side-quiet`/`.sb-btn` 由 `--dim` 改 `--text-sub` 达 AA 的处置口径不一致。
- 最小修法（一行，且已有本仓先例）：把该钮改为与「重试停用收敛」同族的**实心按钮**——后者浅色 5.33:1 / 深色 5.81:1 均通过 AA（见 B-4）；或仅调该处红色在浅底的亮度至 ≥4.5:1。
- 若你侧仍决定登记为已知项放行，我方建议在登记文字中改写为「R43 新增控件、浅色对比度 3.91:1 低于 AA、已评估为低severity放行」，以免与「R43 之前就存在」的表述冲突。

## B-10. D-1 闭合（取色令牌正名后，两主题实测均过 AA）

**处置**：`ui/src/App.tsx:4492` `color: "var(--err, #e5484d)"` → `color: "var(--danger)"`。改动文件仅 `ui/src/App.tsx`。

**复验快照**（本次取色基准）：`ui/src/App.tsx` md5 `2283032d3fc484080b210fd30e71d7a4` @ 2026-10-09 23:48:03；探针 `vis-r43-probe4.js`，证据 `vis-r43-evidence4.json`，截图 `vis-r43-17`（浅）/ `vis-r43-18`（深）。

**路径**：`?fresh` → 连 `prod-1` → 开协作面板（停用态）→「打开设置 → Agent 接入」→ 点 `collab-enable-btn`「启用协作」→ `collab-disable-btn`「停用协作…」出现（chip 「协作已启用」、端点 1）。深色：同一路径启用后再切深色（先 `settings-cat-appearance` 再回 `settings-cat-agent`，B-7 坑）。

| 主题 | 前景（computed） | 令牌 | 有效背景（alpha 合成后） | 对比度 | AA 4.5:1 |
|---|---|---|---|---|---|
| 浅色 | `rgb(179,72,77)` | `--danger` = `#b3484d` | `rgb(255,255,255)`（`--panel2`） | **5.32:1** | ✅ 通过 |
| 深色 | `rgb(208,122,122)` | `--danger` = `#d07a7a` | `rgb(28,36,51)`（`--panel2` `#1c2433`） | **5.00:1** | ✅ 通过 |

- 修复前浅色实测 **3.91:1**（`#e5484d` 硬编码回退），现 **5.32:1**——**D-1 已闭合**。
- `--err` 令牌复验：`getComputedStyle(document.documentElement).getPropertyValue('--err')` 两主题均返回 `""`，与 `styles.css` 无该定义一致 → 旧写法确为恒回退。
- **与你方预估的差异（如实登记）**：你预估深色 ≈ 5.7:1，实测 **5.00:1**（仍过 AA）。原因非令牌取值有误，而是**底色不同**：该钮是 ghost（`background: rgba(0,0,0,0)`），落在面板底 `--panel2` `#1c2433`（L≈0.0175）上；B-4 中 chip 的 5.66:1 按 `--panel` `#141922`（L≈0.0096）计算恰为 5.660，两者**同色令牌、不同背景层**，不可直接等同。故「与 B-4 chip 实测一致」不成立于数值层面。

**样式回归检查（无回归）**

| 项 | 实测（浅 / 深） |
|---|---|
| 仍是 ghost | `className = "ghost"`；`background = rgba(0,0,0,0)`；`display = inline-flex`；`cursor = pointer`；`padding = 6px 12px`；`border-radius = 6px`；`border-color` = 品牌青（浅 `rgb(31,118,124)` / 深 `rgb(61,157,168)`）——与首轮同族 |
| 可点（未被遮挡） | 中心 `elementFromPoint` → `BUTTON`，`data-testid = "collab-disable-btn"`，`hit.ok = true`（两主题同） |
| 不溢出 / 不裁切 | `scrollW/clientW = 84/84`、`scrollH/clientH = 29/29` → `hClip=false, vClip=false`；Range 文本宽 60px < 盒宽 86px；盒 `(439, 534.5, 86×31)` 两主题逐位相同；`.settings-pane` 498/498 · 294/294 无裁切 |
| 完整在视口内 | `fully=true`（`(439,534.5)–(525,565.5)`，1280×800） |
| JS 异常 | 浅色 `[]`、深色 `[]` |

目视（截图 `vis-r43-17` / `vis-r43-18`）确认：浅色下红字明显较修复前的亮红更暗、在白底上可读；深色下为鲑红字落在深蓝灰面板上，可读。两图按钮文字、边框、圆角与「接入新 Agent」主按钮并置时层级清晰，无错位或压字。

**判定：D-1 已闭合**（浅 5.32:1 / 深 5.00:1，两主题均 ≥ AA；无样式回归）。**覆盖范围如实声明**：仅覆盖 `Enabled` 态下 `collab-disable-btn` 的两主题取色与对比度，以及 ghost 族样式/可点性/溢出；未重跑其余清单项（O-5 已另行闭合于 B-8）。


