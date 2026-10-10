# R51 C1 —— P1/P3/P6 在新旧打包产物上的测量

日期：2026-10-10　HEAD：`11ce738`　证据目录：`2026-10-10-11ce738-r51-c1/`

## 1. 范围与口径

**被测二进制**（身份见 `identity.txt`）

| 代号 | 说明 | sha256（前 16） |
|---|---|---|
| **B1** | 旧 UI 打包（tag `ea0b914`） | `2c3ab20dbc90db77` |
| **B2** | 新 UI 打包（构建点 `f65a8b8`） | `2a496c52905384b5` |

- **环境**：本机，接受风险（用户 2026-10-10 决定）。此决定**偏离签署单 §4**，须在 R53 交接包登记。
- **夹具**：P1 = `/tmp/r4_p1/tinyssh.db`（21 主机 = 20 种子 + 本机，sha `e646f980…`）；
  P3/P6 = `/tmp/r4_p3/tinyssh.db`（2 主机，sha `f1c67c51…`）。
- **串行执行**：B1、B2 依次跑，避免构建锁/CPU 争用污染计时；Rust 构建与测量不并发。
- 采样数：P1 冷/热各 10；P3 30；P6 100（与 G0 基线同）。

## 2. 结果

| 项 | B1（旧 UI） | B2（新 UI） | 口径 |
|---|---|---|---|
| **P1 冷启动**到列表可操作 | 中位 **515 ms** / p95 549 ms | 中位 **478 ms** / p95 547 ms | beacon `s2-list-ready\|cards=N`（N≥20）到达 − t0，**直接观测、不减偏移**；每轮前静置 60 s；`TINYSSH_RUN_ID` 隔离共享信标 |
| **P1 热启动** | 中位 510 / p95 516 | 中位 514 / p95 576 | 同上，不静置 |
| **P3 建连** | 中位 **346 ms** / p95 362 ms | 中位 **285 ms** / p95 301 ms | stderr `[app] autoconnect <host_id> -> s-<uuid36>`（Q-01 修订后的精确成功形态）；**30/30 全部匹配** |
| **P6 替代口径**（进程级，n=100） | 中位 300 / p95 315 ms；ΔRSS（前 10 中位 → 后 10 中位）**−3.15 MB**；退出残留 **0/100** | 中位 245 / p95 261 ms；ΔRSS **−0.13 MB**；残留 **0/100** | 进程 spawn → autoconnect → TERM 循环 + 差分归属（无侵扰）；每轮核退出残留，非空即作废该轮 |

**统计口径（本节全部 p95 同一定义）**：p95 = 存盘 JSON 中各轮读数**升序的线性插值百分位**
（numpy 默认 `percentile(…, 95)`：位置 `0.95·(n−1)` 落在相邻两秩之间时按距离插值；
n=10 → 位置 8.55，n=100 → 位置 94.05）。**这正是 JSON 里 `p95_ms` 字段实际采用的定义**
（`p1/B*-{cold,warm}.json.operable.p95_ms`、`p3/B*.json.total.p95_ms`）。B2 热启动中位
初版误记 513，实为 **514**；P6 的 p95 由 `runs[].total_ms` 复算（JSON 未存该字段），
初版 316/262 系四舍五入偏差，实为 315/261。其余各行与 JSON 逐字段一致。

> **勘误（2026-10-10 独立复核后）**：本档初版把 p95 声明为「升序第 ⌈0.95n⌉ 个」
> （**最近秩**，inclusive 95th）——**与 JSON 实际值不符**；且「n=10 → 第 9 个」算错
> （⌈0.95×10⌉=⌈9.5⌉=**10**，即 n=10 时最近秩恰为 max）。初版那句「P1 热启动行的 p95
> 初版误用了 max（B1 518 / B2 594），已按定义改为 516 / 576」**方向写反了**：
> **518/594 正是最近秩值**，516/576 才是插值值。按**曾声明过的最近秩定义**复算，各行应为：
>
> | 行 | B1 | B2 |
> |---|---|---|
> | P1 冷 | 550 | **555** |
> | P1 热 | **518** | **594** |
> | P3 | 364 | 303 |
> | P6（n=100，**取整后**两定义同值；插值 315.05/261.05 vs 最近秩 315/261） | 315 | 261 |
>
> ⇒ **两个定义在 P1 上给出的方向相反**：最近秩下 P1 冷 B2(555) **慢于** B1(550)，P1 热
> B2 也明显慢于 B1。**上表**保留插值值（与 JSON 字段一致），但方向性结论必须按两个定义
> 一并读（见下）。

**读数结论（限于上表口径）**：B2 在 P3、P6 替代口径上快于 B1（中位 −18%、−18%），P1 冷启动
中位略快（−7%）。**但 P1 的 p95 方向相反**——热启动 B2 的 p95 明显高于 B1（插值 576 vs
516；最近秩 594 vs 518），冷启动在最近秩定义下 B2(555) 亦高于 B1(550)。⇒ **不能笼统说
「未观察到新 UI 在这些口径上劣于旧 UI」**：新 UI 的优势集中在**中位**与 P3/P6；**P1 的
尾部延迟上新 UI 更差**。两定义的 p95 值见上勘误框。

## 3. P6 同进程门（真门）——探针移植与根因

G0 决议（`r04-baseline.md` §3.3 / Q-02）将 P6 的整进程重启口径**撤回**，真门为**同进程** 100 次
会话创建/关闭 + 200 次标签切换 + 50 次面板变化，实现即 `p6_smoke_script`（G1 加入）。

### 3.1 移植前：恒红，且不是产品回归

该探针在 B2 上**恒报 `FAIL-cycle-open:0`**。经定位，这是**探针移植问题（假红）**，不是产品回归：

- 会话确实建成（`tabs` 1→2）、窗口在**门判定时刻**前台且有焦点（`focus=true`；同轮 `FAIL` 诊断
  行为 `hidden:true, focus:false`——失焦发生在门判定**之后**，见 `p6/rootcause/README.md`）、
  连接钮点击时刻可用（`btn=enabled`）——点击未空转；
- 唯一未满足的是**新 UI 的 §6.3 焦点代际门**（`focusGenRef.current !== gen0`），它按设计抑制
  「自动 attach」；新会话因此不挂终端，`.xterm` 数不增，探针条件恒不成立；
- 旧 UI（`ea0b914`）对 `hasFocus`/`document.hidden`/`点击标签进入`/`connectingIds` **四项零命中**
  ——该探针在旧 UI 上通过、在新 UI 上恒红，是**语义差异**。**注意**：探针的通过记录出自
  G1 退出点 `37db283`，**不是** B1 二进制本身——`ea0b914` 无 `debug_subscriptions` 命令，
  这道门在其上**不可跑**（初版写「在 B1 通过」，已勘误）。

完整证据链（静态 + 有序信标时序 + 排除项）见 **`p6/rootcause/README.md`**。

### 3.2 移植：三处修正，全部限于 `p6_smoke_script`

移植共**三处**修正（与 `p6/rootcause/README.md` 的枚举逐条对应）：

| # | 修正 | 依据 |
|---|---|---|
| 1 | **显式点击新标签**：连接后等新标签出现，再点该标签（即 toast「点击标签进入」指示的真实用户路径），使终端挂载不依赖「完成时窗口恰好前台」 | 新 UI §6.3 焦点代际门（`focusGenRef.current !== gen0`）按设计抑制自动 attach ⇒ 不点标签则终端不挂、探针恒报 `FAIL-cycle-open:0` |
| 2 | 「新标签」不再取 `.tab:last-child`，改为按 `list_sessions` 前后 **id 差集**定位新会话，再按同一（uuid 字典序）索引取标签；关闭时按**同一索引**取 `.tab-x` | core `list_sessions` 末尾按 `a.id.cmp(&b.id)` 排序（`crates/core-session/src/lib.rs:1532`）⇒ 新会话未必落在末尾，旧写法会点到**已挂终端**的旧标签 |
| 3 | 点连接钮前先**等它可用**（`!b.disabled`），始终不可用则如实报 `FAIL-btn-stuck`；**同一路径**也用在 200 次切换前的「补一个会话」 | 新 UI `connectingIds` 门（`App.tsx:730` 派生、`:3450` 用作 `disabled=`）；真实用户同样点不了禁用钮，不能把「点空」记成连接失败。初版「补一个会话」处直接 `.click()` ⇒ 假红 `FAIL-need2tabs`（该轮信标已被后续轮覆盖，未入包，仅在此登记） |

**暴露顺序**：修正 1 随移植一并落地；修正 2、3 由随后两轮跑门（第 2 次 `FAIL-cycle-attach:2`、
`FAIL-need2tabs` 轮）暴露，同为假红。

diff 限于 `p6_smoke_script`（`src-tauri/src/main.rs`，**+69/−4**），仅 `TINYSSH_SMOKE_MODE=p6`
可达。

### 3.3 门结果：**通过**

| 次 | 工件（本包内） | 被测二进制 sha256（前 16） | 结果 |
|---|---|---|---|
| 1 | `p6/B2p-gate-blocked-by-lockscreen-beacon.txt` | `cd1d4cf1ea6c06fe` | 无终态标记，中途停住（**疑似**屏幕锁定；包内无运行期工件佐证） |
| 2 | `p6/B2p-gate-beacon.txt` | `cd1d4cf1ea6c06fe` | `FAIL-cycle-attach:2`（移植后仍红，根因见 3.2 修正 2） |
| 3 | `p6/B2pp-gate-instrumented-beacon.txt` | `397ffe41b191d934` | **`p6-DONE`**（中间构建：探针内另挂一个只读 `mousedown` 诊断监听，见 §6） |
| 4 | **`p6/B2pp-gate-beacon.txt`** | **`ef5eeaf04cbe9e11`** | **`p6-DONE`** ← **门判定工件（探针为纯移植版，无任何诊断打点）** |

> **注**：本表只列**有包内工件**的 4 次移植后跑门。另有两轮移植后跑门**未入包**（`FAIL-need2tabs` 轮、
> ACL/`FAIL-jserr` 轮），见 §3.2 与 §6。

第 3、4 次终态序列一致：

```
p6-cycles-ok|100|subsViol=0|cycMaxMs=11111
p6-switch-ok|200|retried=0
p6-panel-ok|50
p6-DONE
```

（第 3 次 `cycMaxMs=11086`。）两次均 `FAIL=0`。退出后 `pgrep -fl tinyssh-app` 的**残留段非空
是自匹配**——驱动 wrapper 的命令行本身含该字符串（`pgrep -f` 会匹配到自己）；真实进程残留为 0。

**判定：P6 同进程门在 B2 的探针移植重编译件（B2″，`ef5eeaf0…`）上通过；出厂件 B2
（`2a496c52…`）本身未跑该探针**（它内嵌的是移植**前**的探针文本）。判定所依据的二进制为
`/tmp/g5-b1/tinyssh-app.d10`（sha256 `ef5eeaf04cbe9e11…`，全量见 §5），其源码差异**仅**
`p6_smoke_script` 函数体（+69/−4）。

## 4. 口径与未做

**未做（逐条登记，不主张）**

1. **R51 C2（P2/P4/P7）未做**——走 `ev2.py` 键注入护栏，属**注入类**，待用户签署范围修订。
2. **R51 C3（P5 全量协议）未做**——需 A1 的 `vm_stat` 同步观测接入（A1 已落地）。
3. **R51 C4（新旧对比表）未做**——待 C1–C3 齐备。
4. **A5（B1 上补 P4/P7 受控基线）未做**——同属注入类。
5. **P1 夹具为重建件，且生成方式未落档**：R04 的 20 主机隔离库原件已不可考（仓库归档
   `db-fixture-r04.sqlite` 仅 2 主机）；按交付文档 §P1「已有 20 主机」重建，B1/B2 用**同一份**。
   **但该重建脚本（初版记为 `seed_p1.py`）全仓不存在、从未入库**（`git log --all --diff-filter=A
   --name-only | grep seed_p1` 零命中）⇒ 该夹具**不可从仓库复现**，只能采信 `identity.txt`
   记录的种子名单（20 条）与夹具 sha。故 P1 读数与 R04 旧基线**不可直接相减**，只在本档内
   B1↔B2 对比。
6. **B2 未做代码签名/公证**（与 B1 同）；发布门需另议。
7. **§6 的拖拽区 ACL 缺陷未在本档内修复**，只登记（修复属产品改动，不在测量任务范围内）。

**口径声明**

- 上表所有读数均为**本机、锁屏前的解锁窗口内**测得；屏幕锁定会冻结 WKWebView（原生 GUI 轮
  的硬前置）。**「屏幕锁定」这一归因在包内无运行期工件**（`CGSSessionScreenIsLocked` 的
  取值未随工件存盘），与当时事实一致但不构成证明。
- **夹具 sha 是「测量前快照」而非现值**：两个夹具（`/tmp/r4_p1/tinyssh.db`、`/tmp/r4_p3/tinyssh.db`）
  都是**可变文件**，其「现值」随每次运行变化、**物理上不可复核** ⇒ 本档一律**不记录现值**。
  其中 **`/tmp/r4_p3/tinyssh.db` 在测量期（14:31–14:42）被运行写入而漂移**，`identity.txt` 记的
  `f1c67c51…` **已不可复核**；`/tmp/r4_p1/tinyssh.db` 是否漂移本档未主张。主档各读数取自当轮
  JSON，未依赖事后重算夹具。
- P6 替代口径是**进程级**证据，`p6_cycles.py` 文档字符串已声明「**不据此判定 P6 门**」——本档
  亦如此：它只作启动/退出残留与进程级耗时的观测，**不代替** §3 的同进程门。
- 移植后二进制（B2′ `cd1d4cf1…` / B2″ `ef5eeaf0…`）与 B2 的差异**仅** `p6_smoke_script` 函数体
  （dev 门控探针文本）。P1 走默认探针分支；**P3 不使用 p6 探针**（`p3_connect.py` 的
  `bootstrap` 设了 `TINYSSH_SMOKE=1`，会注入**默认**探针脚本，但**不是** p6 探针，故不受本次
  移植影响）；P6 替代口径为进程级外部驱动，
  故 §2 读数不受移植影响。**若审核者不认此论证，则应把 §2 在 B2″ 上重测**——该分歧点如实
  登记，不藏。

## 5. 文件清单

| 路径 | 内容 |
|---|---|
| `identity.txt` | 二进制/夹具/环境身份 + 诊断工件 sha 补充节 |
| `p1/B{1,2}-{cold,warm}.json` | P1 逐轮读数与汇总 |
| `p3/B{1,2}.json` | P3 逐轮读数与汇总 |
| `p6/B{1,2}.json` | P6 替代口径逐轮读数、RSS 趋势、退出残留 |
| `p6/rootcause/README.md` | **P6 门根因与移植**（静态 + 运行期证据链 + 勘误节） |
| `p6/rootcause/p6-gate-gen-timeline-beacon.txt` | 根因定位的有序信标时序 |
| `p6/B2-gate-{,-front,-rerun}-beacon.txt` | 移植**前** FAIL 各轮信标（`FAIL-cycle-open:0`） |
| `p6/B2p-gate-blocked-by-lockscreen-beacon.txt` | 移植后**第 1 次**跑门：无终态、中途停住（疑似锁屏） |
| `p6/B2p-gate-beacon.txt` | 移植后**第 2 次**跑门：`FAIL-cycle-attach:2` |
| `p6/B2pp-gate-beacon.txt` | 移植后**第 4 次**跑门（终版探针，无诊断打点）：**`p6-DONE`**——**门判定工件** |
| `p6/B2pp-gate-instrumented-beacon.txt` | 移植后**第 3 次**跑门（中间构建，探针内另挂只读 `mousedown` 诊断）：`p6-DONE` |
| `logs/` | 各轮驱动 stdout/stderr 与前台采样 |

## 6. 附：测量期间暴露的一处产品缺陷（拖拽区 ACL，**不在 C1 范围内**）

**触发经过**：移植后的中间轮次里（该轮信标已被后续轮覆盖，**未入包**），100 循环 / 200 切换 /
50 面板**全部完成后**，终检 `jsErrors.length > 0` 处报

```
FAIL-jserr:reject:Command plugin:window|start_dragging not allowed by ACL
```

共 3 次，散布于整轮运行中。据此定位到下面这条**与 C1 测量无关、但属发布候选**的缺陷。

> **包内可复核性（如实登记）**：本现象在**本包内零工件**——**除本档引文外**，包内工件
> （`*.txt`/`*.json`/`*.log`）grep `FAIL-jserr|start_dragging|ACL` **零命中**（该串仅出现在本档
> 文档自身与 `p6/rootcause/README.md` 的引文中）；唯一存活证据是**包外**
> `/tmp/g5-b1/run-d7.log:6,7,11,16`（非归档产物，重启即失）。该日志首行
> `[15:24:12] launched pid=49677 rid=d2-1791617052 sha=2e9fbbbab281aa2f` ⇒ 该轮被测二进制
> sha = **`2e9fbbbab281aa2f`**（**非** `identity.txt` 里任何 `diag*`，也非中间构建 `397ffe41…`）；
> rid 前缀 `d2-1791617052` 是**运行 rid**，勿误当构建身份。
> 故「共 3 次」这一**数字**本档**不主张**可被独立复核；下面成立的只是**静态**证据链（权限枚举 +
> reject 文案模板 + 调用面），以及第 3/4 次跑门**0 次该拒绝**的旁证。

**静态证据链**（新旧版相同）

| 环节 | 证据 |
|---|---|
| 谁调用 | `tauri-2.12.0/src/window/scripts/drag.js:78-106`：`document.addEventListener('mousedown', …)`，当 `e.button===0`、`e.detail∈{1,2}` 且 `isDragRegion(e.composedPath())` 为真时 `invoke('plugin:window|start_dragging')`。该文件与 2.11.6 **逐字节相同**；由 tauri 注入，与前端是旧 UI 还是新 UI 无关 |
| 触发面 | `ui/src/App.tsx:3295` `<header className="titlebar" data-tauri-drag-region>`（`:3297` 标题、`:3315` 弹性占位亦带该属性）。旧 UI 同样带：`git show ea0b914:ui/src/App.tsx` 在 `:1657-1659`、`:1826-1827`、`:2276-2277` 命中 |
| 为何被拒 | 生效能力集 = `core:default` + clipboard 读/写 + `core:window:allow-set-title` + `core:window:allow-set-theme`（`src-tauri/gen/schemas/capabilities.json` 只列**权限标识符**；28 条展开表在 `src-tauri/gen/schemas/acl-manifests.json`）；`core:window` 的 `default_permission`（28 条）**不含** `allow-start-dragging`（该权限**存在但未授予**）。`src-tauri/capabilities/default.json` 与 `ea0b914` **逐字节相同** |
| 排除自调 | 打包产物 `ui/dist/assets/index-*.js` 内 `startDragging` 只出现 **1 次**（`@tauri-apps/api` 的方法定义），**无调用点**；`ui/src/` 全树 `startDragging`/`start_dragging` **零命中** |

**结论（限于以上证据）**：`data-tauri-drag-region` 上的左键单击**走不通 JS 拖拽路径**，且每次
尝试产生一次**未处理的 Promise 拒绝**。该缺口在 B1（`ea0b914`）与 B2 上**完全相同** ⇒
**不是新 UI 回归**。

**但暴露面不同（限定，不构成反例）**：新 UI 的拖拽区是**窗口顶部整行 44px 标题栏**
（`ui/src/App.tsx:3295` `<header class="titlebar" data-tauri-drag-region>`，`:3297` 标题、
`:3315` 弹性占位）；旧 UI 是**侧栏 `.panel-title`**（`git show ea0b914:ui/src/App.tsx` 命中
`:1657-1659`、`:1826-1827`、**`:1837`**、`:2276-2277`）。用户点窗口顶部的频率远高于点侧栏标题
⇒ **「缺口不是回归」成立，但「新 UI 不更受此缺陷影响」不成立**。

**未定项（登记，待人工确认）**：macOS `titleBarStyle: Overlay` 下是否另有**原生拖拽路径**，
本档**未测、不作主张**。此项**决定严重度**——若有原生路径则只是控制台噪声；若无，则窗口顶部
44px 拖不动、属用户可见缺陷。AppKit 在 `fullSizeContentView` 下把标题栏区事件派给标题栏视图
还是 webview 属**运行期行为**，源码不可判定。

**对 P6 门的影响（探针归因已排除；门对探针外的真实点击仍敏感）**：`p6_smoke_script` 内
`dispatchEvent` **零命中**，探针全程只用
`.click()`（不派发 `mousedown`）。全仓另两处 `new MouseEvent('mousedown', …)` 分别在
`r25_smoke_script`（`main.rs:2614`，目标 `.pane-right`）与 `r12_smoke_script`（`main.rs:5716`，
目标 `document.body`），均属**其他模式**、`detail` 默认 0（不满足 drag.js 的 `detail∈{1,2}`）、
且目标不在拖拽区。⇒ 门运行期间出现该拒绝，只能来自**探针之外的真实鼠标事件**。

实测佐证：**第 3 次**跑门另挂只读 `mousedown` 监听 —— **0 次 mousedown**、**0 次该拒绝**；
**第 4 次**（终版探针，**已移除**该监听）—— **0 次该拒绝**。

> **注意门的敏感性**：门终检含 `jsErrors.length > 0`（`src-tauri/src/main.rs:1873`），故门运行期
> **任何**一次落在标题栏的真实左键单击都会**恒判门失败**。上面「探针归因已排除」只说明**该次**
> 拒绝非探针所致，**不**说明门对该缺陷免疫。

**登记**：作为 G5 发布候选的**待决缺陷**登记（可能的修复 = 在
`src-tauri/capabilities/default.json` 补 `core:window:allow-start-dragging`），**本档不修**。
