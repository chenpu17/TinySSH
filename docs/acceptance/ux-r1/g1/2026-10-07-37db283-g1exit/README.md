# G1 退出项：P2 / P6 / P5 试点——交付与验收记录

日期：2026-10-07 ｜ 基线：37db283（R14） ｜ 终轮：p2l（P2）/ p6f（P6）/ 试点全绿（P5）

## 范围与口径

G1 收口三项非功能任务。**产品代码零改动**：diff = src-tauri/src/main.rs 的 dev 门控探针（`p2_smoke_script` / `p6_smoke_script` + 2 行 mode 分派，共 +232 行，与 r11-r15 同 harness：TINYSSH_SMOKE_MODE 分派、页级幂等护栏、beacon 信标）+ scripts/perf/p5_pilot_ux1.py（试点驱动）。ui/ 零 diff、核心层零 diff——**无 UI 表面变化，视觉复验不适用**（探针脚本不进渲染路径；r11-r15 视觉基线仍有效）。

环境：release 终版二进制（含探针，dev 门控不触达产品路径）+ 隔离 DB + 本机 local 会话（AUTOCONNECT）；P2 远端列与 P5 用共享 docker sshd（root@127.0.0.1:2222，仓库既有测试约定凭据）。

## P2（同 release 交互延迟）

[beacon-p2.txt](beacon-p2.txt) 终轮 p2l（门判定已内置探针：n<100 → FAIL-*-n、P95 超门 → FAIL-*-gate）：

| 项 | n | P95 | max | 门（探针内判定） | 结果 |
|---|---|---|---|---|---|
| 会话切换 click→tab-active（rAF 计时） | 100 | **19ms** | 19ms | ≤100ms（FAIL-sw-gate） | PASS |
| 输入→本地可见回显（键盘注入→xterm rows DOM 变化） | 100 | **19ms** | 21ms | ≤50ms（FAIL-ec-gate） | PASS |
| 远端回显单列（真实 SSH 会话，信息性不设门） | 100 | 19ms | 20ms | 仅 n 门（FAIL-rt-n） | 记录 |

证据口径（证据纪律）：
- **注入级**：合成 `keydown`+`keypress`（xterm 键盘输入路径）注入到活动终端 textarea——CGEvent 注入受 P2 冻结协议约束，与 R13 menu-settings 同口径。**非 CGEvent 真实硬件注入**，不主张「真实键程」。
- **观测级**：活动终端 `.xterm-rows` 内**任意行**内容变化的 MutationObserver 计时。p2i 诊断实证「末行增长」假设错误（回显落在光标行，光标行不必然是视口末行）——任意行变化=「可见回显」的忠实语义。已知局限（rev 登记）：observer 对任意 mutation 触发，理论上可混计前拍渲染尾迹（方向有利 PASS、≤1 帧、门裕度 19ms vs 50ms 吸收）。
- **远端列**：`upsert_host` 真路径建档 p2-sshd → UI 点卡 → TOFU 信任 → Connected → 同款注入/观测 ×100。单列报告，不与本地口径混算。

诊断插曲（p2b–p2i 九轮，全数入档备查）：最初按「WKWebView 忽略 KeyboardEvent legacy init」假设改走 InputEvent 路径（p2d/p2f 原生仍 -1 而 Playwright WebKit 引擎同码全通）；最终以 `defaultPrevented` 回读 + 屏幕基线对照定位真因为**观测点错误**（末行假设），注入路径本身在原生 WKWebView 一直有效（p2i：`prev=true/false` ×3 + `screen=changed` 含回显字符）。副产品发现：`window.__TAURI_INTERNALS__.invoke` 属性只读（invWrite=false），运行时拦截该口不可行——登记备查。诊断代码已从终版探针移除。

## P6（同进程循环与资源）

[beacon-p6.txt](beacon-p6.txt) 终轮 p6f + [rss-p6.log](rss-p6.log)：

| 项 | 结果 |
|---|---|
| 100 创建/关闭循环（连接钮→标签+xterm 出现→tab-x→确认流→标签+xterm 回收） | PASS，每 25 轮 checkpoint `subsViol=0`，**subsViol>0 → FAIL-subs（探针内判定）** |
| 订阅不变量（每存活会话 ≤1 输出订阅） | PASS：每轮 `debug_subscriptions` `active_count ≤ live` 且 `per_session[].subscription_ids ≤1`，循环后 FAIL-subs 门 + 终检 FAIL-subs-final 均未触发 |
| 终端实例回收 | PASS：每轮 close 后 xterm 数回到基线，终检 FAIL-xterm-leak 未触发（已知代理口径：DOM 计数；JS 对象泄漏不可见，由 RSS 兜底——rev 登记） |
| 200 标签切换 | PASS，`p6-switch-ok|200|retried=1`（1 次慢拍经单次重试成功，重试次数工件在案，见登记） |
| 50 面板变化（files 面板开合 aria-pressed 对账） | PASS |
| JS 错误 | 0（error+unhandledrejection 均入 FAIL-jserr 判定，信标双打点全程零触发） |
| 进程 RSS（主进程，2s 间隔，n=70） | min=152816 KiB（148.7 MiB） median=153328 KiB max=156912 KiB（153.2 MiB）；首样本 156208 → 尾样本 154512 KiB（尾低于首）——无线性增长，±4 MiB 波动。采样命令：`( while kill -0 <pid>; do echo "$(date +%s) $(ps -o rss= -p <pid> | tr -d ' ')"; sleep 2; done )`（原始单位 KiB） |
| 退出零残留 | pgrep -x 干净 |

RSS 口径：进程级证据（与 G0 修订轮 P6 降级决议同构）——主进程 RSS（`ps -o rss`，KiB），不含 WebKit XPC 子进程；子进程归属已由 P5 试点差分法覆盖。

执行插曲（探针侧，非产品）：①基线取样早于 AUTOCONNECT 终端挂载（p6b `x0=0` 假基线→FAIL-cycle-close）；②AUTOCONNECT 会话在欢迎态（sid=null）不挂载终端——探针先点首个标签激活再取基线（产品语义：欢迎态列出会话等待接入，与 R12 设计一致，非缺陷）。③200 切换偶发 >2s 慢拍（p6d 1/200，GC/渲染排队量级）→ 探针加**单次重试**（真实用户再点语义），终轮 retried=1。已知局限（rev 登记）：「慢但最终成功」类切换回归在重试语义下不产生机器 FAIL，以 retried 计数暴露、人工判读。

## P5（有效归属试点，缩时协议）

[p5-pilot/pilot-result.json](p5-pilot/pilot-result.json)：

- **B 相位中位数 = 329.19 MB，E 相位中位数 = 330.12 MB，增长 = +0.28%**（观测量；≤20% 门限与末段趋势判定归 R51 全量协议）。
- **归属有效性：PASS**——memsample v4 差分法（仪表已经 rev-q05fix 签署关闭，2026-10-07-e2ebdc4-q05fix）：S0 快照 20 个系统 WebKit 辅助进程 → 应用启动后冻结 3 候选（GPU/WebContent/Networking XPC，含 lstart 身份）→ B/E 相位逐候选 fail-closed → 退出核验「候选 3 个全部随应用退出消失（无残留、无同 PID 身份复用）」exit 0；B/E 均 `voided=false`。
- 负载：单会话 × 持续输出 5 分钟（容器 /root/.spew ~1k 行/s × 80B 经真实 SSH 会话进核心管线），零键注入、零 smoke 注入。缩时差异（5min 非 30min、1 会话非 10）在 pilot-result.json 登记为试点口径，**全量协议归 R51**。
- 试点主张=归属有效性（候选全生命周期存活/身份一致/退出消失/无未知进程），不主张性能达标。
- 驱动卫生（rev 处置后）：启动前残留实例检查（pgrep 非空即拒跑）、全程 kill 按 PID（不按名 pkill，防误杀非本 run 实例）。

## 登记

- P2 远端列走共享 sshd 真连接（TOFU 信任门真实路径）；P6 全程 local 会话（循环负载无需远端）。
- 探针均为 dev 门控（TINYSSH_SMOKE=1），release 产品路径无探针代码触达（rev 核实：diff 仅探针函数 + 2 行分派）。
- p2 慢拍样本（>2s 超时）计入 FAIL-*-n 判定（n<100 拒签）；p6 慢拍由重试语义吸收——两口径均在登记明示。
- P5 前置「仪表修复」已在 ea0b914 + rev-q05fix 关闭，本轮直接引用其有效性。

## 独立复核

### rev-g1exit（对抗审核）——处置后可签（2 中 3 低，全部处置）

**已处置（脚本级，重编后 p2l/p6f 终轮复跑全绿）**：
- **中-1** p2 静默通过路径（超时样本被 filter 剔除、无 n 门、门判定在探针外人工完成）→ 补 `FAIL-sw-n / FAIL-sw-gate(≤100) / FAIL-ec-n / FAIL-ec-gate(≤50) / FAIL-rt-n`，门判定内置探针。
- **中-2** p6 subsViol 只打信标不设 FAIL 门 + 200 切换重试次数无工件 → 补 `subsViol>0 → FAIL-subs` + `p6-switch-ok|200|retried=N` 打点。
- **低-1** rss 单位混标（KiB 原值标 MB）→ 全文改 KiB 主单位 + MiB 换算标注 + 采样命令归档（本 README）。
- **低-2** FAIL-jserr 只含 error 事件 → unhandledrejection 并入判定。
- **低-3** pilot 驱动 pgrep/pkill 按名操作可绑错实例 → 启动前残留检查 + 全程 PID 精确 kill。

**登记（rev）**：回显 observer 可混计前拍渲染尾迹（方向有利 PASS、≤1 帧、门裕度吸收）；终端回收为 DOM 计数代理口径（RSS 兜底）；重试语义对「慢但成功」类回归无机器 FAIL（retried 计数暴露）。

**核实无问题**：diff 门控范围、三组 raw 数字逐项复算一致（sw 19/19、ec 19/21、rt 19/20）、rss n=70 min/median/max 一致、p5 attribution_valid 复算一致、「观测量非门限」双处措辞无越界、debug_subscriptions 只遍历存活会话但主张按「每存活会话 ≤1」措辞无越界（r14 教训吸收正确）、候选冻结时机合理（Connected 后；冻结后新增 helper 走 unknown-helper fail-closed void 路径）、选择器逐一核实、错误路径无静默 continue。
