# vis-r41 独立视觉复验报告（R41：连接详情 / 活动记录 / 设置改版）

- 复核者：vis-r41（独立 subagent；**自写探针** `vis-r41-demo-probe.js`，不复用作者 `r41-demo-probe.js` 的断言）
- 域：demo（`http://localhost:5183/`，serving 当前工作树 R41 代码）；基线对照 `http://localhost:5184/`（f6ea990）
- 日期：2026-10-09
- 工具：Playwright 1.57.0 + 独立 headless Chromium（未触碰用户浏览器应用，未重启作者服务器）
- 规模：**98 项断言 / 92 通过**；**60 个对比度采样（浅+深）/ 8 处低于 AA**；4 视口 × 2 主题
- 原始数据：`vis-r41-probe-raw.json`；结构化结论：`vis-r41-findings.json`

## 结论：**不可签**

阻断项 4 条（B1-B4）：1 处交互控件悬停对比度崩到 1.07:1、2 处 R41 新元素深色低于 AA、连接详情 Esc 不关闭。

---

## 阻断项

### B1（高）活动记录范围段钮悬停对比度 1.07:1 / 1.71:1
`.seg` 未选中钮（「全部会话」）悬停时，被全局规则 `button:not(:disabled):hover { background-color: var(--accent-hover) }` 改成亮 accent 底，文字仍是 `--text-sub`。

| 主题 | 前景 | 背景 | 比值 | 阈值 |
|---|---|---|---|---|
| dark | rgb(154,170,184) `--text-sub` | rgb(77,176,187) `--accent-hover` | **1.07** | 4.5 |
| light | rgb(77,91,104) `--text-sub` | rgb(42,138,144) `--accent-hover` | **1.71** | 4.5 |

静态态正常（dark 7.40 / light 6.44）。R41 新增 `.seg` 组件，作者给了 `.seg button.on` 选中态、也给了 `.settings-nav button:hover` 覆盖，**唯独漏了 `.seg button:hover`**——`button:not(:disabled):hover` 特异度 (0,2,1) 胜过 `.seg button` (0,1,1)，故全局规则生效。截图 `vis-r41-dark-log-hover-seg.png`（悬停后段钮成一坨亮青、字几乎看不见）。

### B2（中-高）连接详情 `.cd-hint` 深色 3.01:1
R41 新元素 `<div className="dim cd-hint">` 深色用 `--dim`：fg=rgb(93,111,130) / bg=rgb(28,36,51) `--panel2` / fs=11 → **3.01**（阈值 4.5）；浅色 5.69 通过。
作者在 styles.css 对 `.log-row .tl-meta` 专门写了「用 `--text-sub` 而非 `--dim`（AA）」的注释，同类新元素 `.cd-hint` 未遵循同一口径。

### B3（中-高）设置→凭据空态 `cred-empty` 深色 3.01:1
`<div className="dim" data-testid="cred-empty">`：fg=rgb(93,111,130) / bg=rgb(28,36,51) / fs=12 → **3.01**；浅色 5.69 通过。

### B4（中）连接详情对话框 Esc 不关闭
`App.tsx` 的 Esc 浮层链 `closeTopOverlayRef`（1685-1701 行）**没有 detail 分支**，`modalRef` 也不含 detail，故 Esc 落空。同轮新增的**设置**对话框 Esc 可关（`showSettings` 在链中）——两者行为不一致。
实测：dark/light 双主题按 Esc 后 `[data-testid="conn-detail"]` 仍在（still-open=1）；设置对话框 Esc 后为 0。仅遮罩点击与 ✕ 可关。

---

## 中 / 低问题

### M1（中）设置对话框在 960×600（出货最小窗）被裁，标题行 + ✕ 关闭钮完全不可见
`tauri.conf.json` `minWidth=960 / minHeight=600`。在 960×600 且「凭据」新建表单展开（最高内容态）时：
- dialog rect `y=108 h=432`，`clippedH=84`（`.term-wrap` 可视区 150..498，`overflow:hidden`）
- 裁切节点：`{"row", text:"设置", top:121, bottom:148}` 整行落在裁切线（150）之上 → **「设置」标题与 ✕ 关闭钮完全不可见**；`settings-body/nav/pane`(158..527)、`cred-new`(197..504)、底部提示(508..527) 被切。
- 1440×900 / 1280×800 / 1024×768 均不裁（clippedH=0）；960×600 默认「外观」分类也不裁（h=308 落在 150..498 内）。

根因：对话框 `position:absolute` + `top/left:50%` 相对 `.term-wrap` 居中，`max-height: calc(100vh - 80px)` 用的是视口高度而非包含块高度。截图 `vis-r41-dark-geo-960x600-settings.png`。

### M2（中）焦点陷阱在草稿确认框消解后失效，Tab 逃逸到背景
`useDialogFocus` 只在 `active` 变化（挂载沿）把焦点收进框、并在 box 上监听 keydown。点「留下继续编辑」后该按钮被移除 → 焦点落回 `body` → 之后 Tab 的 keydown 不再冒泡到 box → 陷阱不再拦截。
- 干净打开：初始焦点 `settings-close`（inside=true），连续 8 次 Tab 全 inside。
- 草稿消解后：连续 6 次 Tab 的 tag 序列 `BODY → INPUT → BUTTON → BUTTON → log-scope-current → log-scope-all`（全部 inside=false，逃到背景活动记录面板）。dark/light 同。

### M3（中-低）两个新对话框居中于终端窗格而非视口
`.conn-detail` / `.settings-wide` 用 `left/top:50% + translate(-50%,-50%)`，但 `position` 仍是 `.term-settings` 基线的 `absolute` → 包含块是 `.term-wrap`（终端窗格，主机栏 x=226 之后），不是视口。而遮罩 `.pop-mask` 是 `position:fixed;inset:0` 全视口。
- 相对包含块中心：dx=dy=0（完全居中）。
- 相对视口中心：**dx=+113px**（1440/1280/1024，右栏关闭时；dy=+24）。
- 右栏（活动记录/文件）打开时 `.term-wrap` 变窄、偏移反向：1280 右栏开时 settings `dxViewport=-79`。

视觉上对话框与全屏遮罩不同心、偏右。截图 `vis-r41-dark-geo-1440x900-condetail.png`。

### L1（低）连接详情在 960×600 上下各裁 4px
dialog `y=133 h=382`、`clippedH=34`；逐子：`cd-head top=146 cutTop=4`（标题顶部）、`cd-hint bottom=502 cutBottom=4`（末行）。1440/1280/1024 不裁。

### L2（低）凭据新建表单内 ghost 钮深色 4.35:1
`--accent` 文字于 `--panel3` 底（「生成 Ed25519」「生成 RSA」「取消」）：dark fg=rgb(61,157,168) bg=rgb(35,45,61) fs=12 → **4.35**（差 AA 一线）；light 4.52 通过（贴线）。

### L3（低，既有类 + 本轮新增使用点）
活动记录空态 `log-empty` / `log-empty-nosession` 用全局 `.empty` 类（`color:var(--dim)`）：dark 3.41；设置 `.ts-label` dark 3.01。二者为基线既有样式，**非 R41 引入**，但本轮为它们新增了使用点（新面板/新对话框），一并登记。浅色侧均通过。

---

## 达标项（抽样，均有实测数字）

- **几何**：活动记录 `.log-bar` / `.log-filters` 在 960/1024/1280/1440 四视口均 `clippedW=0`；`log-filters` 两 label 始终同一行（rows=1），`white-space:nowrap` 未撑破面板。连接详情/设置在 1440/1280/1024 均不裁。
- **对比度达标**：`.cd-k` 6.53/6.97、`.cd-v` 11.17/13.79、`.cd-sec h4` 6.53/6.97、`.cd-sidrow code` 9.96/11.71、`.cd-copy` 4.88/5.33、`.log-row .tl-meta` 7.40/6.44、`.log-note` 7.40/6.44、`.log-sid`、`.log-filters label`、`.seg .on` 11.08/11.17、`.log-refresh` 5.53/4.92、`.log-more` 5.53、**`.settings-nav` 静止 6.53/6.97 · 悬停 5.82/5.92 · 选中 9.70/12.05**、`.cred-field` 5.82/5.92、`.cred-draft` 9.61/12.19。
- **状态**：`log-empty`（筛选到无结果）实捕；`log-empty-nosession`（用 UI「关闭会话…」断开后）实捕且段钮 `disabled=true`、切「全部会话」恢复记录（7 条）；`log-more` 生成 79 条后出现（rows=40/79），点击 40→79，末页 more 消失；设置凭据空态 / 新建表单展开 / 草稿确认框（`cred-draft`）均实捕。
- **焦点**：连接详情与设置**干净打开**时初始焦点入框、连续 Tab 不逃逸。
- **叠印**：连接详情与 toast 不交叠；队列抽屉打开时 `.pop-mask` 在抽屉之上（`elementFromPoint` 命中 pop-mask），模态不被抽屉反压。
- **回归**：外观/终端分类内容在 620px 新对话框内完整可见未裁（`cutAny=false`）；对照 :5184 基线确认为旧 280px 右上角面板（`w=280, hasWide=false`），分类内容未丢。
- **零 JS 错误**（dark/light 各一轮）。

---

## 未验证（如实声明，未超出证据）

1. **连接详情「未接入会话」空态 `cd-err`**：demo 中**不可达**——工具菜单在无 `current` 会话时不渲染（会话头 `{current && ...}` 条件渲染），而会话存在时 `openSessionDetail` 不会置 `detailErr`。未验证。
2. **原生 Tauri 窗口内渲染**：本轮仅在 demo（浏览器）域复验，**未跑原生冒烟**；CSS 同源但原生域未实证。
3. Solarized 深色/浅色等其它终端配色主题未测（只测 dark/light chrome 两套）。
4. ≥1440 大窗 / 多显示器 / 右栏打开时的多组合几何只抽测。
5. toast 与设置对话框、活动记录面板的叠印未单独测（只测了 conn-detail vs toast）。
6. 队列抽屉在**有真实传输任务**时的形态未测（demo 无传输，抽屉为空态；仅验证了模态压抽屉）。

## 复现

```
cd /Users/chenpu/workspace/claude-code/TinySSH/docs/acceptance/ux-r1/g4/2026-10-09-r41
node vis-r41-demo-probe.js        # 需 :5183(工作树) 与 :5184(基线) 均在运行
```

---

# 处置后定向复验（vis-r41-recheck）

**触发**：作者按首轮 4 阻断 + 3 中危处置后，组长要求定向复验。**代码冻结**：`ui/src/styles.css` md5 `2793e94ad4dc15f6340d3116d6f24c17`、`ui/src/App.tsx` md5 `11fa631b1b9e351b9fbeaa7e86372f5a`，与处置声明一致，复验前后未变（`/usr/bin/git status` 对账）。

**探针**：独立新写 `vis-r41-recheck-probe.js`（不沿用作者探针），87 检查点 + 10 对比度样本，截图 24 张 `vis-r41-recheck-*.png`，原始数据 `vis-r41-recheck-raw.json`。

## 探针自省（两处首轮 recheck 探针缺陷，已修）

1. **`clip()` 对 `position:fixed` 误用祖先 overflow**：fixed 元素的包含块是视口，祖先 `overflow:hidden` **不裁它**。首版探针因此对 1280×800 右栏开时的 `.settings-wide` 误报 `clippedW=54`——经 hit-test 证伪：该 54px 只是 `.term-wrap`(overflow:hidden) 矩形与 fixed 对话框的**几何相交**，对话框右缘 `(948,400)` 命中自身。已由 `fixedContainingBlock()` 独立证明 `.term-wrap` 祖先链无 transform/filter/perspective/contain/willChange，故 fixed 确为视口相对。v2 对 fixed 只按视口裁，可见性改用「每个交互元素中心点 `elementFromPoint` 是否由自身/后代接住」审计（四角因 `border-radius` 落在圆角外，不作口径）。
   > 首轮 vis-r41 的 L1「960×600 被裁」结论建立在**当时** dialog 为 `position:absolute`（含块=`.term-wrap`）之上，该结论在当时成立；处置后改 fixed，裁切不再适用，本轮以 fixed 感知口径重测。
2. **关对话框改用 Esc**：`cd-close` 在 tp-full 遮挡下点不到——那本身是缺陷（见 B5），不是探针问题。

## 逐项实测（浅 + 深）

### B1 `.seg` 未选中钮悬停 —— 通过

| 主题 | fg | bg | 比值 | 阈值 |
|---|---|---|---|---|
| dark | `rgb(212, 219, 230)` | `rgb(35, 45, 61)` | **9.96:1** | 4.5 |
| light | `rgb(36, 46, 56)` | `rgb(232, 237, 242)` | **11.71:1** | 4.5 |

**悬停选中钮不顶掉选中态**（额外确认项）：`.on` 类保留，bg 悬停前后**逐字节相同**——

| 主题 | bg 悬停前 | bg 悬停后 | class | 选中态比值 |
|---|---|---|---|---|
| dark | `rgb(24, 38, 47)` | `rgb(24, 38, 47)` | `on` | 11.08:1 |
| light | `rgb(223, 233, 236)` | `rgb(223, 233, 236)` | `on` | 11.17:1 |

对照首轮 1.07/1.71:1：新规则 `.seg button:not(.on):not(:disabled):hover`(0,4,1) 以 `--panel3`+`--text` 覆盖全局 `button:not(:disabled):hover`(0,2,1)；且因显式排除 `.on`，选中钮仍由 `.seg button.on`（源码序更后）胜出，选中态未被顶掉。

### B2 `.cd-hint` —— 通过

| 主题 | fg | bg | 比值 | fs |
|---|---|---|---|---|
| dark | `rgb(154, 170, 184)` | `rgb(28, 36, 51)` | **6.53:1** | 11 |
| light | `rgb(77, 91, 104)` | `rgb(255, 255, 255)` | **6.97:1** | 11 |

### B3 `cred-empty` —— 通过

| 主题 | fg | bg | 比值 | fs | class |
|---|---|---|---|---|---|
| dark | `rgb(154, 170, 184)` | `rgb(28, 36, 51)` | **6.53:1** | 12 | `dim cred-empty` |
| light | `rgb(77, 91, 104)` | `rgb(255, 255, 255)` | **6.97:1** | 12 | `dim cred-empty` |

### L2 `.cred-new button.ghost` —— 通过（浅色余量极薄）

| 主题 | fg | bg | 比值 | fs |
|---|---|---|---|---|
| dark | `rgb(70, 170, 181)` | `rgb(35, 45, 61)` | **5.07:1** | 12 |
| light | `rgb(31, 118, 124)` | `rgb(232, 237, 242)` | **4.52:1** | 12 |

> **观察**：浅色 4.52:1 仅高出 AA 阈值 **0.02**（作者注释自述同值）。后续若动 `--accent-text` 浅色档需重测，任何微调都可能翻红。

### B4 Esc 关详情 + 不误关会话 —— 通过

| 主题 | Esc 后 `conn-detail` 计数 | `list_sessions` 仍含该会话 | sid / state |
|---|---|---|---|
| dark | **0** | 是 | `s-demo-0001` / `Connected` |
| light | **0** | 是 | `s-demo-0001` / `Connected` |

Esc 链在 `pasteConfirm` 之后、`splitMenu` 之前加了 `detail` 分支（App.tsx:1699），且只消费详情层、不落到关闭会话。

### M1 960×600 凭据新建表单展开态 —— 通过（四视口全绿）

**960×600（组长指定场景）**：对话框 `rect={x:170, y:84, w:620, h:432}`，`clippedH=0`、`clippedW=0`、遮挡 `0/16`。

| 元素 | `getBoundingClientRect` | 落在视口内 | 可见 |
|---|---|---|---|
| `设置` 标题行 | `top=97, bottom=124` | **true** | **true** |
| `settings-close` ✕ | `top=97, bottom=124, x=738` | **true** | **true** |

`.settings-pane` `scrollHeight=369 / clientHeight=369`（未溢出，无需滚动即完整可见）。

其余视口（凭据表单展开态）：1440×900 `rect={410,234,620,432}` head `247..274` close `x=978`；1280×800 `rect={330,184,620,432}` head `197..224` close `x=898`；1024×768 `rect={202,168,620,432}` head `181..208` close `x=770`。四者 `clippedH=clippedW=0`、`blocked=0/16`、head/close 均 inViewport+visible。

对照首轮 960×600 报 `clippedH=84` 且整条标题行 + ✕ 在裁切线之上：处置后 `max-height:calc(100vh - 80px)` + fixed 居中，四视口全部归零。

### M2 草稿消解后连续 Tab 焦点 —— 通过（两条路 × 双主题）

| 路径 | dark | light | Tab 序列（6 次） |
|---|---|---|---|
| 留下继续编辑 | 6/6 inside | 6/6 inside | `settings-close → cat-appearance → cat-terminal → cat-credentials → cat-about → cred-new` |
| 丢弃草稿并切换 | 6/6 inside | 6/6 inside | `settings-close → cat-appearance → cat-terminal → cat-credentials → cat-about → (ghost 按钮)` |

对照首轮：草稿对话框消解后焦点落到 `body`、keydown 不再冒泡到 box（**逃逸**）。处置后新增 `useEffect([credDraftTo, showSettings])`，在草稿消解且焦点出框时把焦点拉回框内首个可聚焦元素，两条消解路径均生效。

### M3 四视口 × 右栏关/开 居中 —— 通过（八组 dx=dy=0）

| 视口 | 右栏 | `.conn-detail` dx/dy | `.settings-wide` dx/dy |
|---|---|---|---|
| 1440×900 | 关 / 开 | 0 / 0 · 0 / 0 | 0 / 0 · 0 / 0 |
| 1280×800 | 关 / 开 | 0 / 0 · 0 / 0 | 0 / 0 · 0 / 0 |
| 1024×768 | 关 / 开 | 0 / 0 · 0 / 0 | 0 / 0 · 0 / 0 |
| 960×600 | 关 / 开 | 0 / 0 · 0 / 0 | 0 / 0 · 0 / 0 |

对照首轮 1440/1280/1024 右栏关时 `dx=+113px`（absolute 以 `.term-wrap` 为含块）。`fixedContainingBlock()=[]` 独立证明无祖先把它拉回局部含块。

## 几何相关回归 —— 全部通过

- `.log-bar` 横向溢出 `clippedW=0`（1440/1280/1024/960 四视口）；
- `.log-filters` 单行不折行、无溢出（`rows=1`，`scrollW==clientW`，四视口）；
- 外观分类内容未被裁（`cutAny=false`）；
- 连接详情 / 设置 在**右栏关**时四视口均 `clippedH=clippedW=0` 且无遮挡；
- 全程零 JS 错误（dark/light × 四视口共 6 轮）。

## 处置后新发现：B5（阻断）

**窗口宽 ≤ ~1104px（主机栏展开）且右栏面板进入完整视图态（`.task-panel.tp-full`，`z-index:40`）时，两个新对话框（`z-index:30`）被整块盖在面板之下。**

| 视口 | 面板 | conn-detail 不可达 | settings 不可达 | overlapW |
|---|---|---|---|---|
| 1440×900 | 停靠 `z=auto` | 0/11 | 0/8 | 0 |
| 1280×800 | 停靠 `z=auto` | 0/11 | 0/8 | 0（settings 54，但 30 > auto，仍全可达） |
| **1024×768** | **tp-full `z=40`** | **11/11** | **8/8** | 430 / 596 |
| **960×600** | **tp-full `z=40`** | **10/11** | **4/8** | 430 / 564 |

**用户路径完全现实**：1024×768 下 `工具 → 活动记录`（面板转完整视图）→ `工具 → 连接详情…`，屏幕上**什么都看不到**（`vis-r41-recheck-dark-geo-1024x768-condetail-panelopen.png` 整幅只剩活动记录）。

**根因**：`styles.css:192` `.task-panel.tp-full { position:absolute; inset:0; z-index:40 }` 高于 `styles.css:452` `.term-settings { z-index:30 }`。tp-full 断点见 `App.tsx:1648-1659`（`availW < 560 + panelNeed - 16`）。

**基线对照（重要，避免误归因）**：该层叠规则**先于 R41 存在**——基线 `:5184`(f6ea990) 在 1024×768 + 协作面板(tp-full) 下，旧 280px 设置对话框同样 `blocked=12/12`；1280×800 下基线 `blocked=0/12`。故：
- 设置对话框的该缺陷是**既有**的（R41 未修复，亦未加重）；
- **连接详情是 R41 新增的对话框**，继承了同一缺陷，且它与活动记录面板天然共存（同一「工具」菜单），因此在 R41 自己的主路径上可复现。

**与 M3 修复的关系**：M3 修复**未引入**该缺陷（修复前 dialog 为 absolute、含块=`.term-wrap`，tp-full 下同样被盖）；也**未消除**它。M3 本身八组 dx/dy=0 实测通过。

**建议**：对话框 `z-index` 提到 41+，或 tp-full 面板在对话框打开时让位。修复后需回归 1440/1280 停靠态与 1024/960 完整视图态。

## 结论

| 项 | 判定 |
|---|---|
| B1 `.seg` 悬停（含选中态不被顶掉） | **通过** |
| B2 `.cd-hint` | **通过** |
| B3 `cred-empty` | **通过** |
| L2 `.cred-new button.ghost` | **通过**（浅色 4.52 擦线，已登记观察） |
| B4 Esc 关详情 + 不误关会话 | **通过** |
| M1 960×600 标题行 / ✕ 在视口内、`clippedH=0` | **通过**（四视口全绿） |
| M2 两条消解路径 Tab 不逃逸 | **通过** |
| M3 四视口 × 右栏关/开 居中 dx/dy=0 | **通过** |
| 几何相关回归 | **通过** |

**7 项处置全部实测通过。但复验中新增发现阻断级 B5（tp-full 面板盖住对话框，连接详情在 1024×768 完全不可达）→ 综合判定：不可签，唯一阻断 = B5。**

若组长判定 B5 属既有层叠规则的独立任务（其设置对话框部分在基线 f6ea990 已复现），则仅就本轮 7 项处置而言为**可签**。

## 复现

```
cd /Users/chenpu/workspace/claude-code/TinySSH/docs/acceptance/ux-r1/g4/2026-10-09-r41
node vis-r41-recheck-probe.js     # 需 :5183(工作树) 运行；本定向复验不需要 :5184
```

## 本轮未做（如实声明）

- 未跑原生 Tauri 域冒烟；未跑作者的全量 demo 探针；未重跑首轮 98 项——只跑本定向探针（87 检查点）+ 两处诊断脚本。
- B5 仅在 Chrome headless demo 域实测；原生 Tauri 域未实证（CSS 同源，推断同样成立，但未实测）。

---

# B5 处置后定向复验（vis-r41-recheck2）

**终裁：可签。** 复验时工作树指纹：`ui/src/styles.css` = `c22384e21cdda239212c33e9230e9c34`、
`ui/src/App.tsx` = `a53150588f3f6accd579636b015a5a40`、产品码面 diff
`/usr/bin/git diff -- . ':(exclude)docs/ux/ux-r1-execution-status.md' | md5` = `bb3fa4ce193f59080b2630ba0e5e5e1d`
（11 文件 +1176/-74 → 实测 +1176/-76）。探针 `vis-r41-recheck2-probe.js`，**102/102 检查点全通过**，
原始数据 `vis-r41-recheck2-raw.json`，截图 `vis-r41-recheck2-*.png`。
运行前后各取一次 md5，**逐字节一致**（本轮判定确为对单一稳定版本）。

> **⚠ 组长的指纹已过期，且本轮树在我复验期间被并行改动过。** 详见文末「树位移与口径声明」——
> 我的判定以 `bb3fa4ce…` 为准；组长给的 `36f149dd…` 已被作者后续改动取代。

## 1. B5 主项：已修复（4 视口 × 2 入口顺序，全绿）

`工具 → 活动记录` 使右栏进入完整视图态（`.task-panel.tp-full` 在场，`panelZ=40`）后，
再开 `工具 → 连接详情…` / `设置`，**逐个交互元素中心点 `elementFromPoint` 均由对话框自身或后代接住**：

| 视口 | 面板态 | conn-detail | settings | settings(凭据表单展开) | 入口B（先开对话框后开面板） |
|---|---|---|---|---|---|
| 1440×900 | `task-panel`（z=auto） | 0/11 遮挡 | 0/16 | clippedH=0, 0/16 | 0/11 |
| 1280×800 | `task-panel`（z=auto） | 0/11 | 0/16 | clippedH=0, 0/16 | 0/11 |
| **1024×768** | **`task-panel tp-full`（z=40）** | **0/11** | **0/16** | **clippedH=0, 0/16** | **0/11** |
| **960×600** | **`task-panel tp-full`（z=40）** | **0/11** | **0/16** | **clippedH=0, 0/16** | **0/11** |

关键在于「对话框与面板**确实几何重叠**」——1024×768 下 conn-detail 与面板横向重叠 `overlapW=430px`
（即对话框整幅压在面板上）、settings `596px`；960×600 下 `430px` / `564px`。
在这种完全重叠下遮挡计数仍为 0，说明 `.term-settings`(42) 确实高于 `.task-panel.tp-full`(40)，
而不再是修复前的「面板把对话框整个盖住」。两种入口顺序（先面板后对话框 / 先对话框后面板）均无差异。
截图 `vis-r41-recheck2-dark-{1024x768,960x600}-{condetail,settings}-*.png` 可见完整对话框。

## 2. 层叠不倒退（全绿）

- **确认框仍压在设置之上**：设置 → 凭据 → 删除被引用凭据，`elementFromPoint` 命中确认框按钮
  （`btn="删除凭据"`, `selfHit=true`），`confirmMaskZ=90 > settingsZ=42 > popMaskZ=41`。这条链未变。
- **toast 仍在对话框之上**：`stackZ=120 > dlgZ=42`，且 `.toast-stack` 与对话框**同处根层叠上下文**
  （两者最近的建栈祖先均为 `HTML`），故 z 序比较有效；`.toast-stack` 仍为 `pointer-events:none`（不挡交互）。
- **工具菜单在 tp-full 态下仍可达**：`self=true`。
- 上下文/工具菜单不受 41/42 影响（`.tools-menu`=70、`.context-menu`=200 均未动）。

### toast 绘制顺序的像素实证（新增，`vis-r41-recheck2-probe.js` 第 ⑥ 段）

`.toast-stack` 是 `pointer-events:none`，`elementFromPoint` 原理上**永远照不到它**；且在 960×600 /
1024×768 出货尺寸下 toast（右贴边、宽 113px）与居中对话框**无几何重叠**（实测 `overlapArea=0px²`），
故 hit-test 口径无法证明「toast 在上」。改用**像素实证**：在 680×560 的**合成视口**（低于 tauri
`minWidth=960` 出货下限，仅用于强制制造重叠）下采样——

- 重叠区 `4×37px`，采样点 `(552,412)` = **`rgb(127,191,143)`**，正是 toast 左边框 `--ok` 绿条
  （`borderLeftColor: rgb(127, 191, 143)`）；
- 对照点（对话框中部同一 y）`(340,412)` = `rgb(28,36,51)`（对话框底色）——排除「整屏染绿」的假阳性；
- **判别性反证**：等 toast 自然消失（2.6s）后同一点回落为 `rgb(28,36,51)`。

三点合起来构成判别性证据：toast 确实绘制在对话框**之上**，且该绿来自 toast 而非背景。
截图 `vis-r41-recheck2-dark-toast-pixelproof-680x560.png`。

## 3. 已验 7 项回归：全部仍通过（数字与首轮逐项一致）

| 项 | dark | light |
|---|---|---|
| B1 `.seg` 未选中钮悬停 | **9.96:1** | **11.71:1** |
| B1 悬停选中钮不顶掉选中态 | `before=rgb(24,38,47)` = `hover`，`cls="on"` | `before=rgb(223,233,236)` = `hover` |
| B2 `.cd-hint` | **6.53:1** | **6.97:1** |
| B3 `cred-empty` | **6.53:1** | **6.97:1** |
| L2 `.cred-new button.ghost` | **5.07:1** | **4.52:1** |
| B4 Esc 关详情且不误关会话 | `count=0`，`sid=s-demo-0001 state=Connected` | 同 |
| M1 设置标题行/关闭钮不裁 | 4 视口 `clippedH=0` | — |
| M2 两条草稿路径 Tab 不逃逸 | 6/6 在框内 ×2 路径 | 6/6 ×2 |
| M3 对话框对视口中心 | 4 视口 `dx=0 dy=0`（8 组合） | — |

**M3 因 z-index 变更重点重测**：1440×900 / 1280×800 / 1024×768 / 960×600 四视口，
conn-detail 与 settings 对视口中心 `dx=0 dy=0` 全部成立，且 `fixedContainingBlock()` 返回 `[]`
（无祖先建立 fixed 包含块）——41/42/43 的改动未影响居中。
对比度样本 14/14 通过。

**几何回归**：4 视口下 `.log-bar` `clippedW=0`、`.log-filters` `clippedW=0` 且 `rows=1`（不折行，
`scrollW==clientW`）；外观分类内容未被裁（`false`）；**全部轮次零 JS 错误**。

## 4. `.log-note` 新文案与对比度（组长特别交办）

作者改动后无会话态文案确为 **「本机时间（UTC+08:00）· 未接入会话，无可显示记录」**——
dark 与 light 均实测一致，且同一 `evaluate` 内 `log-empty-nosession=1`、`log-row=0` 自洽。
对比度**未变**：dark `7.4:1`（fg `rgb(154,170,184)` / bg `rgb(20,25,34)`）、
light `6.44:1`（fg `rgb(77,91,104)` / bg `rgb(244,246,248)`），均 ≥ AA。

> 说明：上一轮（`vis-r41-recheck`）我曾报此项 FAIL。复核后确认是**我方探针缺陷**——
> 当时先点 `log-refresh` 再**跨两次 `evaluate`** 读 `.log-note`，读到了陈旧值。
> 本轮改为「关闭会话后等 1200ms，在**同一次** `evaluate` 内同时读空态与文案」，并另用诊断脚本
> 单独验证「点刷新是否会让文案回退」（结论：不会，A/B/C 三次采样文案稳定）。
> 此为探针口径修正，非产品缺陷。

## 5. `.split-menu` 层叠——作者在本轮复验期间**新增的改动**（我独立验证）

复验期间作者新增了一处改动（`styles.css` 注释署名「R41 代码复验 C-2」）：`.split-menu` `z-index: 30 → 43`。
理由成立且**必要**：`App.tsx:3881-3884` 显示 `.pop-mask` 与 `.split-menu` 是**同父兄弟**
（同一 fragment 内），把遮罩抬到 41 后，停在 30 的菜单会被自己的遮罩盖住并吃掉点击 → 分屏永久进不去。

我独立验证（`vis-r41-recheck2-probe.js` 第 ⑦ 段）：

- 结构：`sameParent=true`、`sameStackRoot=true`（两者最近的建栈祖先同为 `HTML`）；
- z 序：`menuZ=43 > maskZ=41`；
- 可达：菜单项逐项 `elementFromPoint` `blocked=0/2`；
- **功能级**：用**真实鼠标点击**（Playwright 命中检测，非程序化 `.click()`——后者会绕过遮罩、
  不能作证据）点击菜单项，成功进入分屏（`aria-pressed: false → true`，菜单自动关闭，
  按钮 title 变为「退出分屏（会话保留不断开）」）。

**判别性反证**（运行时注入 `.pop-mask{z-index:41!important} .split-menu{z-index:30!important}`，
**不改工作树文件**）：注入后 `menuZ=30 < maskZ=41`，`blocked=2/2`（`by=pop-mask`），
真实鼠标点击 `Timeout 2500ms exceeded`、`aria-pressed=false`、菜单仍开 —— 分屏确实进不去。
截图 `vis-r41-recheck2-dark-splitmenu.png` / `vis-r41-recheck2-dark-splitmenu-redside.png` /
`vis-r41-recheck2-dark-split-entered.png`。

## 6. B5 判别性独立复现（运行时注入，未改文件）

组长给的作者侧判别是「摘回 29/30 → M1 独红」。我用 Playwright 运行时注入等价复现
（作者当时正在并行编辑该文件，改文件会与其互相覆盖，故不触碰工作树）：

| 视口 | 修复态（41/42） | 注入 29/30 后（= 修复前） |
|---|---|---|
| 1024×768 | `blocked=0/11`，真实点击关闭钮成功 | **`blocked=11/11`**，点击 `cd-close` 失败（被 `log-bar` 挡住） |
| 960×600 | `blocked=0/11`，真实点击关闭钮成功 | **`blocked=10/11`**，点击 `cd-host` 失败（被 `tp-head` 挡住） |

注入生效前置断言（`dlgZ=30` 且 `panelZ=40`）在两次运行中均成立，故红侧结果可信。
截图 `vis-r41-recheck2-dark-{1024x768,960x600}-b5-redside.png`。

## 7. 树位移与口径声明（如实登记）

本轮复验期间工作树**被并行改动**，我先后见到三个 `styles.css` 版本：

| md5 | 内容 | 说明 |
|---|---|---|
| `52d2b426…` | pop-mask 41 / term-settings 42 | 组长下任务时的版本 |
| `3c8bd672…` | pop-mask **29** / split-menu 43 | 作者在跑**自己的红侧判别**（摘回 29） |
| **`c22384e2…`** | pop-mask 41 / term-settings 42 / **split-menu 43** | **本报告判定的版本** |

期间我两次完整探针运行**被作者的保存触发 Vite HMR 重载污染**（注入的 `<style>` 被冲掉、
应用状态被重置），表现为 ⑦/⑧ 判别项假红；我据此**废弃了那两次结果**，等树连续 20 次采样
（约 140s）不变后重跑，并加了两道护栏：注入后先断言注入确已生效（`menuZ<maskZ` / `dlgZ=30 && panelZ=40`），
再断言判别结论。最终运行前后 md5 逐字节一致，**102/102** 为有效结果。

我自己的红侧文件改动（曾把 `.pop-mask` 改 29、`.term-settings` 改 30）已被作者的保存覆盖；
已核验当前 `styles.css` 的 diff 中**无 `z-index: 29`/`30` 的残留新增行**，工作树中不含我的任何产品改动。

## 8. 取向与观察（非阻断）

- **`.split-menu`(43) 现在高于 `.term-settings`(42)**：即「分屏菜单」会画在「设置对话框」之上。
  实际不可达（设置打开时其遮罩挡住终端工具栏的分屏按钮），故非缺陷；但语义上「常驻浮层高于模态」
  略反直觉。若后续要让语义更整齐，可考虑把 `.pop-mask` 系列整体收进一个分层 token 体系，
  而不是逐处手调——**本轮不建议改**（作者选择不动 `.task-panel.tp-full`(40) 的判断是对的，
  动它影响面更大）。
- 我复核了「对话框被 tp-full 面板遮挡」这一现象在**基线 f6ea990** 上对**设置对话框**即已存在
  （首轮 `vis-r41-baseline-settings.png` + 基线遮挡脚本：1024×768 协作面板 tp-full 下 12/12 被挡）。
  本轮修复同时解决了新老两个对话框，覆盖面比 R41 自身引入的更多。
- 未做：原生 Tauri 域未实证（CSS 同源，推断同样成立但未实测）；未跑作者全量 demo 探针；
  未重跑首轮 98 项，只跑本定向探针（102 检查点）+ 3 个诊断脚本。

## 复现

```
cd /Users/chenpu/workspace/claude-code/TinySSH/docs/acceptance/ux-r1/g4/2026-10-09-r41
node vis-r41-recheck2-probe.js      # 需 :5183（工作树）运行；本定向复验不需要 :5184
```
