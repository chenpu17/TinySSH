# P6 同进程门在 B2 上的探针移植（根因与移植）

## 结论（先主张）

`p6_smoke_script`（G1 加入、实现 P6 同进程门的探针）**不能原样移植到新 UI**：在 B2 上它
恒在第 0 轮报 `FAIL-cycle-open:0`。经定位，这是**探针移植问题（假红）**，不是产品回归：

- 会话确实建成（`tabs` 1→2）；
- 连接钮在点击时刻可用（`btn=enabled`）——**点击未空转**；
- 唯一未满足的是**新 UI 的 §6.3 焦点代际门**（`focusGenRef.current !== gen0`）。该门按
  设计抑制「自动 attach」，新会话因此不挂终端，`.xterm` 数不增，探针条件
  `tabs===tabs0+1 && xterm===xterm0+1` 恒不成立。
- 焦点读数**以门判定时刻为准**：`GATE` 行读作 `hid=false|foc=true`；同轮 `FAIL` 诊断
  （约 4.3 s 后）读作 `hidden=true|focus=false`——窗口在门判定**之后**失焦
  （`BLUR|gen=3` 亦在其后）。故「门判定时窗口前台」有据，「FAIL 时刻仍前台」**无据**。

旧 UI（tag `ea0b914`）**没有**这道门：`git show ea0b914:ui/src/App.tsx` 对
`hasFocus` / `document.hidden` / `点击标签进入` / `connectingIds` **四项零命中**；新 UI
四项皆有。该探针在旧 UI 上的通过记录见 G1 退出点 `37db283`
（`docs/acceptance/ux-r1/g1/2026-10-07-37db283-g1exit/beacon-p6.txt` 有 `p6-DONE`，
且该 commit 的 `App.tsx` 四项同样零命中）。**注意：B1 二进制（`ea0b914`）本身跑不了这道
门**——探针必调 `debug_subscriptions`，而 `ea0b914:src-tauri/src/main.rs` 对该命令零命中。
故正确表述是「旧 UI 通过、新 UI 恒红」，而非「在 B1 通过」。

**移植结果（后补）**：按新 UI 契约改写该探针（共三处修正，见「移植」一节）后，门在 B2″
（sha `ef5eeaf0…`）上**通过**——`p6-cycles-ok|100|subsViol=0`、`p6-switch-ok|200|retried=0`、
`p6-panel-ok|50`、`p6-DONE`。门判定工件见 `../B2pp-gate-beacon.txt`。

## 证据链

### 1) 静态（代码）

| 位置 | 内容 |
|---|---|
| `ui/src/App.tsx:3008`（新 UI） | `if (focusGenRef.current === gen0 && !document.hidden && document.hasFocus() && !gatesBusy) { await attachSession(final.session_id); … } else { pushToast("ok", \`已连接 …——点击标签进入\`); }` |
| `ui/src/App.tsx:1871` | `focusSession` 首行 `focusGenRef.current++` |
| `ui/src/App.tsx:1926` | `attachSession` 首行 `focusGenRef.current++`；其末段（:1938）再调 `focusSession` ⇒ 一次 attach **推进代际两次**，第二次在 `await ensureSessionTerm` 之后，属**异步** |
| `ui/src/App.tsx:3450` | 连接钮 `disabled={connectingIds.has(h.id)}`；`connectingIds` 由 `attempts` 派生（:730） |
| `git show ea0b914:ui/src/App.tsx` | 上述四项零命中 |
| `git show ea0b914:src-tauri/src/main.rs` | `debug_subscriptions` 零命中（⇒ 该探针在 B1 上不可跑） |

### 2) 运行期（仪器化构建；产品源码除打点外零改动，事后已还原）

> 本节的仪器化构建（`p6diag`/`diag2/3/4`）与下表读数**不在证据包内**——工件只存在于
> `/tmp`（`/tmp/g5-b1/tinyssh-app.diag*`，sha 见 `../identity.txt`），故**不能从包内复核**。
> 它们仅用于定位，不作为 C1 主张的依据。

`p6diag`（只做「基线 + 一次点击」，8s 采样）：

| 时刻 | tabs | .xterm | 按钮 | focus |
|---|---|---|---|---|
| baseline | 1 | 1 | enabled | true |
| +250ms | 1 | 1 | disabled | true |
| **+1000ms** | **2** | **2** | enabled | true |
| +8000ms | 2 | 2 | enabled | true |

⇒ 会话与终端在点击后约 1s 内齐备，**底层行为健康**。

带门打点的 `p6` 运行，有序信标（`p6/rootcause/p6-gate-gen-timeline-beacon.txt`）：

```
/t/p6-open
/t/AS|sid=s-da1b8e4a…|gen=1      ← 基线点击标签 → attachSession（gen 0→1）
/t/FS|target=s-da1b8e4a…|gen=2   ← attachSession 内部 focusSession（gen 1→2，异步）
/t/GATE|gen0=1|gen=2|hid=false|foc=true|busy=false|sid=s-68a29802…
/t/BLUR|gen=3                    ← 失焦在门判定之后
/t/FAIL-cycle-open:0:{"tabs":2,"xt":1,"t0":1,"x0":1,"btn":"enabled","hidden":true,"focus":false}
```

（上列 FAIL 行按原始工件 `p6-gate-gen-timeline-beacon.txt:57` 逐字段照录；该文件与本节
此前版本存在出入，已勘误——见文末「勘误」节。）

**机制**：探针为挂载 AUTOCONNECT 会话的终端，先 `click()` 首个标签 → 触发
`attachSession`，代际推进两次（一次同步、一次在 `await` 之后异步）。**异步那一跳**落在
探针随后（约 100ms 内）点击连接、`createSession` 已捕获 `gen0` **之后** ⇒ 完成时门判定
`gen !== gen0`（设计如此）⇒ 不 attach。

**已排除**：

- 点击**未**冒泡到主机卡的 `activate()`——该打点零命中；`onClick` 在 `.host-card-main`
  上，连接钮在其兄弟节点 `.host-card-side` 内（`:3409`/`:3437`）。
- 建连期间窗口**未**失焦——`BLUR` 打点在门判定**之后**才出现（gen=3）。
- 非「点击空转」——`GATE` 与 FAIL 诊断同时给出 `btn=enabled`，且 `tabs=2`。
- 非「终端挂载太慢」——`p6diag` 显示 +1000ms 已 `xt=2`，探针窗口为 5000ms。

## 移植

循环改为按新 UI 的**契约**执行：连接后先等新标签出现，再**显式点击该标签**（正是 toast
「点击标签进入」指示的真实用户路径）。**目的**：使终端挂载不依赖「连接完成时窗口恰好
前台」这一偶然条件。

diff 限于 `p6_smoke_script` 函数体（`src-tauri/src/main.rs`，**+69/−4**），仅
`TINYSSH_SMOKE_MODE=p6` 可达。**P1 走默认分支；P3 不使用 p6 探针（`p3_connect.py` 的 bootstrap
设了 `TINYSSH_SMOKE=1`，会注入默认探针脚本，但不是 p6 探针）；P6 替代口径为进程级
外部驱动**，故 B2 上这三项的读数不受本次移植影响。

移植共三处修正（第 2、3 处由后续跑门的假红暴露）：

1. **显式点击新标签**（上文）——消掉 `FAIL-cycle-open:0`。
2. **按 id 差集定位新标签**：`.tab:last-child` 不可靠，core `list_sessions` 末尾按
   `a.id.cmp(&b.id)` 排序（`crates/core-session/src/lib.rs:1532`），新会话可能落在首位/中间；
   旧写法会点到**已挂终端**的旧标签 ⇒ `FAIL-cycle-attach:i` 假红。改为
   「连接前后 `list_sessions` 的 id 差集 → 该 id 在排序后数组中的下标 → 取该下标标签」，
   关闭时按**同一索引**取 `.tab-x`。
3. **点连接钮前等它可用**：新 UI `connectingIds`（`App.tsx:730` 派生、`:3450` 用作 `disabled=`）
   在连接进行中禁用该主机的连接钮，`.click()` 被吞。真实用户同样点不了 ⇒ 探针先等
   `!b.disabled` 再点；若始终不可用则如实报 `FAIL-btn-stuck`（那才是真缺陷）。同一路径
   也用在 200 次切换前的「补一个会话」（初版此处直接 `.click()`，钮禁用时点空 ⇒ 假红
   `FAIL-need2tabs`）。

### 移植后实测

| 次 | 信标工件 | 被测二进制（前 16） | 结果 |
|---|---|---|---|
| 第 1 次 | `../B2p-gate-blocked-by-lockscreen-beacon.txt`（151 行） | `cd1d4cf1ea6c06fe` | 无终态标记，中途停住（**疑似**屏幕锁定，见下） |
| 第 2 次 | `../B2p-gate-beacon.txt`（80 行） | `cd1d4cf1ea6c06fe` | **`FAIL-cycle-attach:2:{"tabs":2,"xt":1,"t0":1,"x0":1,"hidden":false,"focus":false}`** |
| 第 3 次 | `../B2pp-gate-instrumented-beacon.txt` | `397ffe41b191d934` | **`p6-DONE`**（中间构建，另挂只读 `mousedown` 诊断） |
| 第 4 次 | **`../B2pp-gate-beacon.txt`** | **`ef5eeaf04cbe9e11`** | **`p6-DONE`** ← **门判定工件（终版探针，无诊断打点）** |

第 2 次的关键含义：`i=0`、`i=1` 两轮通过了（移植确实修掉了「`FAIL-cycle-open:0`」那条路），
但第 3 轮 `i=2` 在**显式点击新标签之后**终端仍未挂载（`xt` 停在 1）。该假红的根因即上表
修正 2（`.tab:last-child` 指向了已挂终端的旧标签）；修正后第 3、4 次均通过。

第 3、4 次终态序列一致（第 4 次）：

```
p6-cycles-ok|100|subsViol=0|cycMaxMs=11111
p6-switch-ok|200|retried=0
p6-panel-ok|50
p6-DONE
```

（第 3 次 `cycMaxMs=11086`。）两次均 `FAIL=0`，退出后 `pgrep -fl tinyssh-app` 的**残留段非空是
自匹配**（驱动 wrapper 命令行本身含该字符串），真实进程残留为 0。

⇒ **门结果：通过**（B2″，`p6_smoke_script` 移植版）。

## 未做 / 不主张

- 不主张 §6.3 焦点代际门本身有缺陷：本证据只说明**该探针**依赖旧版「无门」语义。
- 不主张 P1/P3/P6 替代口径需在移植后的 B2′/B2″ 上重测（依据见「diff 限于
  `p6_smoke_script`」一节；若审核者不认此论证，则应重测，本档如实登记该分歧点）。
- **门的通过只在「探针之外没有真实鼠标事件」的前提下取得**：终检含
  `jsErrors.length > 0` ⇒ 任何一次落在标题栏拖拽区的真实左键单击都会注入一条 ACL 拒绝
  而判门失败。第 3 次跑门另挂只读 `mousedown` 监听，**0 次 mousedown**；第 4 次（终版）
  **0 次该拒绝**。该缺陷本身见 `../README.md` §6，**不属本门**。
- **「屏幕锁定」的归因在包内无运行期工件**：卡死快照与正常快照同为「`/w/100` 堆积、
  无终态标记」，`CGSSessionScreenIsLocked` 的值未随工件存盘。该归因与当时事实一致，但
  **不构成运行期证明**，此处如实降级为「疑似」。
- 仪器化构建（`p6diag`/`diag2`/`diag3`/`diag4`）**不是** C1 的 B2 工件，仅用于定位；
  其 sha 与用途见 `../identity.txt` 补充节；**工件本身不在包内，不可从包内复核**。

## 勘误（本档自身）

1. **初版引证失实**：初版把 FAIL 诊断行引作 `hidden:false, focus:true`，并略去 `BLUR` 行。
   原始工件 `p6-gate-gen-timeline-beacon.txt:57` 实为 `"hidden":true,"focus":false`——**两个
   布尔字段均被反向**，且该文件里**不存在**任何 `focus:true` 的 FAIL 记录。已按原文照录。
   （由独立复核发现；机制结论不受影响，但属证据纪律违规，已改。）
2. **初版措辞失实**：「同一探针在 B1 通过」——B1（`ea0b914`）无 `debug_subscriptions`，
   该门在其上不可跑。已改为「旧 UI（G1 退出点 `37db283`）通过」。
3. **行号**：`:1939`→`:1938`、`:3451`→`:3450`。
4. **初版遗漏**：移植后第 2 次跑门的 `FAIL-cycle-attach:2` 未登记。已补。
5. **本节此前记「移植后实测：未通过」**，并据此写「C1 未闭合」。该状态**已过期**：三处修正
   （见「移植」一节）后第 3、4 次跑门均 `p6-DONE`，门**通过**。原「未通过」一节保留为
   第 1、2 次的历史记录，不删——它正是修正 2 的实证来源。
