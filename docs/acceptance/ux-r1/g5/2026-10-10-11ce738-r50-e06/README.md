# R50 / E06 —— 窄窗长审批 / 双分屏协作「用完整视图」/ 通知不抢焦点 / 后台完成只提醒

日期：2026-10-10　HEAD：`11ce7389a26f96c22a8844bfad0b6090fe572a94`　证据目录：`2026-10-10-11ce738-r50-e06/`

## 1. 范围与判据

**行级要求**（交付文档 `docs/ux/ssh-client-ux-refactor-delivery.md:215`）：

> E06 ｜ 认证排队/后台 Ready、错误、传输、窄窗长审批和双分屏协作 ｜ **后台只提醒；协作空间不足使用完整视图，来源/操作可达；返回恢复分屏，通知不抢焦点或盖操作** ｜ 原生+视觉

本档覆盖该行的**浏览器域**（授权见执行状态表 `docs/ux/ux-r1-execution-status.md:74`：R50 行
「E02/E03/E05(reduced-motion)/E06 浏览器域可先行」）。该行验收层级为「**原生+视觉**」，
**本档不等于该行验收**——原生窗口轮与最终人眼判定不在本档（见 §5）。

**判据落到可测量**：

| 行级词 | 本档的测量口径 |
|---|---|
| 协作**空间不足使用完整视图** | 窄窗（640×800）与双分屏下，面板带 `.task-panel.tp-full`（`styles.css:205`）且显示提示「空间不足——完整视图，终端仍在运行」（`App.tsx:4639`） |
| **来源/操作可达** | 面板内每条审批卡的「批准/编辑后批准/拒绝」全部 `inViewport && sizeOk`（≥20×20），且面板/文档均无横向溢出 |
| **返回恢复分屏** | 关闭面板后 `.pane-left`/`.pane-right` 各仍为 1、退出分屏按钮仍在（分屏不拆） |
| **通知不抢焦点或盖操作** | toast 有 `aria-live`（`App.tsx:5317`：err=assertive，其余=polite）；出现后 `document.activeElement` **不是** toast；`.toast-stack` 为 `pointer-events:none`（不拦截指针） |
| **后台只提醒** | `document.hasFocus() === false` 时完成连接 ⇒ 走 `App.tsx:3011-3013` 后台分支：toast 含「点击标签进入」、**活动会话不变**（不切视图）；同一次连接动作在**前台**作对照（应切视图、无该文案） |

**不主张**：原生窗口下的通知/焦点行为、真人目视结论（见 §5）。

## 2. 方法（探针 `probe-e06-collab-narrow.cjs`）

四节 A/B/C/D，全部经真实 UI 操作；**夹具零播种**（用 demo 内置主机 `本机`/`prod-1` 与
demo 种子的 2 条待审批，`ui/src/demo.ts`）。所有断言读 DOM 几何 / computed style / 活动元素。

| 节 | 场景 | 视口 |
|---|---|---|
| A | 连 `本机` → 开协作面板（`[data-testid=tools-collab]`，`App.tsx:3894`）→ 量审批卡几何，**隔 600ms 复测一次**确认非瞬态 | 640×800 |
| B | 连 `本机` + `prod-1` → 分屏菜单选一项 → 开面板 → 关面板 | 1440×900 |
| C | 连 `本机` → 分屏菜单「在右侧新建会话…」（真实 `pushToast("info")`）→ 读 toast 语义与焦点 | 1440×900 |
| D | D1 失焦 / D2 前台对照，各在**独立上下文**跑一次同样的连接动作 | 1440×900 |

### D 节：怎么造「窗口不在前台」（探针内实测的配方）

`App.tsx:3008` 的判定条件是
`focusGenRef.current === gen0 && !document.hidden && document.hasFocus() && !gatesBusy`
——四个 conjunct 中，浏览器域可驱动的有**两条**：`document.hasFocus()`（本档驱动）与
`focusGenRef`（由 window `blur` 推进，`App.tsx:2224`）。但 `gen0` 在**点击时刻**取
（`App.tsx:2972`），故只有**落在点击之后**的 `blur` 才翻门，落在点击之前被 `gen0` 吸收。
本档 D1 的时间线确认点击后无 `blur` ⇒ 差异只可能来自 `document.hasFocus()`（独立复核者以
反向对照实验确认，见下）。实测（`/tmp/e06exp/exp2,4,5,6,7,9.cjs`）：

| 尝试 | `document.hasFocus()` | 结论 |
|---|---|---|
| 默认（headless） | `true` | 恒为前台 |
| `page2.bringToFront()` | 一次 `false`、一次 `true` | **不可靠，不采用** |
| CDP `Emulation.setFocusEmulationEnabled({enabled:false})`，**单页** | `true`（不变） | 无效 |
| **另开一页（只需存在，无需 bringToFront）+ 同一 CDP 调用** | **`false`（3/3 次）** | **采用** |
| 失焦后 `hover()`/`click()` | 回到 `true` | 指针事件会**把页面重新置前** |
| 失焦后 `page.evaluate(() => btn.click())` | 仍 `false` | 采用此触发方式 |

> **window blur 通道（独立复核补充，2026-10-10）**：本档初版称「唯一可由浏览器域驱动的是
> `document.hasFocus()`」，**不准确**——`window.dispatchEvent(new Event("blur"))` 落在点击与
> 完成之间时同样翻门走后台（此时 `hasFocus` 仍为 `true`）。独立复核者以反向对照证实：blur 在
> **点击之后** ⇒ 走后台；在**点击之前** ⇒ 仍前台（被点击时刻取的 `gen0` 吸收）。CDP 焦点仿真
> 本身**会同时触发 window blur**，故归因必须看事件时间线；本档 D1 恰因 blur 落在点击前而不受影响。

两点**实现选择**，如实登记：

1. **第二页是必需的**：单页时该 CDP 调用不改变 `hasFocus()`；本档在 D 节各上下文内开第二页
   （`page2` 仅 `goto` 一次，不 `bringToFront`）。
2. **连接动作用 `page.evaluate` 对真实连接按钮派发 `click()`**（`connectSynthetic`），
   **不经 Playwright 指针事件**——因为指针事件会重新置前、破坏失焦前提。命中的是同一个
   React `onClick` 处理器，只有触发方式不同。**为证明「差异来自焦点而非触发写法」，D 节
   跑两遍**：D1 失焦、D2 保持前台，其余完全相同。

CDP 焦点仿真是**覆盖 `document.hasFocus()` 这一读数**，不是真的让 OS 窗口失焦——
但 `document.hasFocus()` 正是产品代码所用的信号，故本档主张的是
**「给定该信号为假时，完成路径走后台分支」这一逻辑层结论**，不主张原生窗口行为（§5）。
`App.tsx:3004-3005` 的注释也正说明作者知道「只查 `document.hidden` 挡不住窗口级失焦」，
故显式加了 `document.hasFocus()`——本档驱动的就是这一条。

## 3. 结果

原始读数：`e06-raw.json`（含 `run.attempts` 与 `run.probeSha256`，见 §5.5）；探针 stderr
`e06-err.txt`（空 = 无页面异常，`notes[*].pageErrors` 亦全为空）。

### 3.1 A —— 窄窗（640×800）长审批

| 项 | 读数 | 判 |
|---|---|---|
| 面板走完整视图 | `panelTpFull true`；提示 = 「空间不足——完整视图，终端仍在运行」 | ✅ |
| 审批卡 | `groups 1`，共 **6** 个动作钮（批准 48×29 / 编辑后批准 86×31 / 拒绝 48×29，×2 组） | — |
| 可达性 | 6/6 `inViewport true` 且 `sizeOk true`（`allItemsReachable true`） | ✅ |
| 横向溢出 | 面板 `panelOverflowX false`；文档 `docOverflowX false` | ✅ |
| 面板几何 | `x 226, y 124, w 414, h 652`（视口 640×800）⇒ **占满内容区**（侧栏右侧，x 226→640），**非**视口居中 | — |
| 复测（+600ms） | 与首次读数**逐字段相同**（`geomStable`）⇒ 非瞬态 | ✅ |

截图：`narrow-approval.png`。

### 3.2 B —— 双分屏协作

| 项 | 读数 | 判 |
|---|---|---|
| 分屏前 | `panesBefore {left:0, right:0, active:1}` | — |
| 分屏后 | `panesAfter {left:1, right:1, focused:1, exitBtn:true}` | 两窗格成形 ✅ |
| 分屏下开面板 | `panelInSplit.tpFull true`，提示同 A（`App.tsx:1695`：`if (splitPanes) { setTpFull(true); return; }`） | 一律中央完整视图 ✅ |
| 关面板后 | `afterClosePanel {panelGone:true, left:1, right:1, exitBtn:true}` | **分屏不拆** ✅ |

截图：`split-two-panes.png`、`split-collab-tpfull.png`、`split-restored.png`。

> **分屏归属的算术闭合（独立复核补充，2026-10-10）**：`setTpFull` 有两条置位路径——`App.tsx:1695`
> 的 `if (splitPanes) { setTpFull(true); return; }`，与 `:1696-1698` 的宽度路径（`availW < th−16`
> 置 true、`availW > th+16` 置 false，`th = 560 + panelNeed`）。1440 宽下 `availW = 1440−226 = 1214`，
> `panelNeed`（collab）= 400 ⇒ `th+16 = 976`，`1214 > 976` ⇒ 宽度路径会置 **false**；而读数
> `panelInSplit.tpFull = true` ⇒ 只可能来自 `:1695` 的 `if (splitPanes)` ⇒ **分屏当时必在**。
> 故 `split-collab-tpfull.png` 背景看不到窗格**不影响**「分屏未拆」的结论（该结论另由
> `afterClosePanel` 读数与 `split-restored.png` 佐证）。

### 3.3 C —— 通知不抢焦点 / 不盖操作

触发：分屏菜单「在右侧新建会话…」→ 真实 `pushToast("info")`，文案
「已就绪：下一次新建的会话将进入右侧分屏——连接一台主机或打开本地终端即可」。

| 项 | 读数 | 判 |
|---|---|---|
| `aria-live` | `["polite"]`（kind=`info`；`App.tsx:5317` err 才用 assertive） | ✅ |
| 可聚焦性 | `toastTabIndex [-1]`（**不可** Tab 到） | ✅ |
| 不拦截指针 | `.toast-stack` `pointer-events: none`、`position: fixed` | ✅ 不盖操作 |
| 焦点未被夺 | 触发前 `activeElement` = `BUTTON.ghost.icon-btn.ts-open`；触发后 = `TEXTAREA.xterm-helper-textarea`（终端输入区）——**均非 toast**（`focusNotStolen true`） | ✅ |

> **口径**：触发前后 `activeElement` **变了**（BUTTON → TEXTAREA），但变化方向是「落进终端
> 输入区」而非「被 toast 夺走」——`focusNotStolen` 只断言「不是 toast」。该变化的成因
> （面板/终端自身的聚焦逻辑）**本档未归因**，如实登记。

截图：`notify-toast.png`。

### 3.4 D —— 后台完成只提醒（含前台对照）

两臂除焦点状态外**其余设置相同**（D1 另多一个惰性第二页与约 0.7s 时延；经独立复核以通道隔离
实验证明该第二页单独存在——不调 CDP——对本页 `hasFocus`/`blur`/状态零影响）：

| 臂 | `hasFocusBefore` | `hasFocusAfter` | `hiddenAfter` | toast 文案 | `activeAfter` | `activeUnchanged` |
|---|---|---|---|---|---|---|
| **D1 后台**（第二页 + CDP 关焦点） | `true` | **`false`** | `false` | 「已连接 prod-1——**点击标签进入**」 | **`本机`** | **`true`** |
| **D2 前台对照**（不关焦点） | `true` | `true` | `false` | 「已连接 prod-1」 | `prod-1` | `false` |

⇒ **差异完全由焦点状态解释**：失焦时走后台分支（`App.tsx:3011-3013`），只提醒、**不切视图**；
前台时走前台分支（`App.tsx:3009-3010`），切视图且无「点击标签进入」。两臂 `toastAriaLive`
均为 `polite`、`tabTexts` 均为 `[prod-1, staging-1, 本机, prod-1]`（会话确实建了，只是没切过去）。
`attachedCount` 两臂均为 `1`——**该字段不区分两臂**，本档不据它下任何结论。

截图：`background.png`、`foregroundControl.png`。

## 4. 发现

**本档未发现缺陷。** 四节判据全部满足（A 窄窗完整视图且操作可达、B 双分屏协作走完整视图且
关面板后分屏不拆、C 通知有 aria-live 且不抢焦点不盖操作、D 后台只提醒不切视图且前台对照
可区分）。

两处**观察**（不主张为缺陷，登记供发布前定夺）：

- **C 节触发通知时 `activeElement` 由 `BUTTON` 变为 `TEXTAREA`**：焦点落进终端输入区，
  不是被 toast 夺走（`focusNotStolen true`），但「通知出现瞬间终端输入区被聚焦」是否可接受，
  需人眼在原生窗口下判断（§5.2）。
- **D 节的 `document.hasFocus()` 由 CDP 焦点仿真驱动**，非真实 OS 失焦：本档只证产品在该
  信号为假时的分支行为（§2），真实窗口失焦属原生轮。
- **（视觉复验补充，2026-10-10）三处观感项**（均非判据失败，登记供发布前定夺）：
  1. **分屏名牌压住终端首行**：两窗格左上角各有一枚半透明 `.pane-tag`（`ui/src/styles.css:383`，
     `top:2px; left:8px`，`--glass` 底），正压在第一行提示符 `ops@prod-1:~$` 上，糊掉一截。
  2. **焦点标识弱于读数**：`pane-focused::after` 的 accent-glow（α=0.30）内阴影在像素上取不到、
     肉眼也看不出；人眼实际靠 `.pane-tag` 颜色差（青 ≈(63,136,141) vs 灰 ≈(115,125,136)）区分。
  3. **toast 骑在命令输入框上**：`notify-toast.png` 里 toast（x 1104–1426）覆盖输入框
     （x 239–1426）右侧约 **27%**；当时输入框为空、且 `.toast-stack` 为 `pointer-events:none`
     ⇒「不盖操作」**严格成立**，但视觉上确实骑在上面。
- **（视觉复验补充）`split-collab-tpfull.png` 不能自证分屏仍在**：该图终端区被面板完全盖死
  （背景里看不到窗格），「分屏未拆」由 `afterClosePanel` 读数与 `split-restored.png` 佐证，
  **不由该图**。

## 5. 口径与未做

1. **原生窗口未做**：E06 层级为「原生+视觉」。本档只在 headless Chromium 上测；
   **原生窗口下的通知焦点行为需真窗口人工观察**（真窗口失焦、系统通知中心、Dock 提醒等），
   本档**不主张**。
2. **`activeElement` 变化的归因未做**：见 §3.3 口径注。
3. **`gatesBusy` 那一支未行使**：`App.tsx:3006-3007` 的「他主机门挂起中完成不抢焦」是
   `hasFocus()` 之外的另一条后台路径。本档**未**行使它——探针实测（`/tmp/e06exp/exp3.cjs`）
   挂起指纹门时 `.hk-mask` **拦截指针事件**，无法再点另一台主机卡。该分支**如实登记为未覆盖**，
   留给原生轮或后续探针。
4. **审批卡只覆盖「几何可达」**：未点击「批准/拒绝」跑完整审批流（那是功能回归，非本行判据）；
   本档只证按钮在窄窗/分屏下仍在视口内且尺寸达标。
5. **单次干净自证**：归档目录在正式跑前清空（连 `.run-attempts` sidecar 一起删），故
   `e06-raw.json.run.attempts === 1` 即证明读数只来自一次运行；`run.probeSha256` 把读数钉死
   在当前那一版探针上（`probe-e06-collab-narrow.cjs` 的 sha256 全值）。
6. **探针自身的一处修正（历史陈述，不可从本包复算）**：初版 D 节只用 CDP 关焦点（无第二页）
   ⇒ `hasFocusAfter` 恒为 `true`，且用 `page2.bringToFront()` 亦不可靠；另 `attachedCount`
   误用 `.term.active`（真实类名是 `.term-session`，`App.tsx:1175`）故恒为 0。两处均已修正
   并重跑（见 §2 配方表与 §3.4）。**这段历史不能从包内产物复算**，只作「为什么当前读数值得信」
   的背景登记。
7. **注入/仿真边界**：本档的非「纯真实操作」共 **5 处**——(a) D 节 CDP 焦点仿真 1 处；
   (b) `evaluate` 派发 `click()` **4 处**（D 节连接动作 + B/C 节 3 处，探针 `163/186/218` 行）。
   D 节那处由 D2 对照臂证明不是差异来源；B/C 节 3 处经独立复核者用**真实指针复测**，结果
   **完全相同**（同 toast、同 panes）。初版只登记 2 处、漏记 B/C 的 3 处（独立复核指出）。
   若审核者要求「必须全部用真实指针事件」，B/C 三处可改；D 节那处**不可**（指针事件会重新置前），
   需转原生轮。
8. 探针在 `docs/` 下，`playwright-core` 装在 `ui/` 下，故用 `require.resolve(..., {paths})`
   显式解析；不依赖调用者 cwd。
