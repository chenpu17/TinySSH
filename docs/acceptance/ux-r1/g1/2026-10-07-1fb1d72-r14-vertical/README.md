# R14（基础真实垂直流程）交付与验收记录

日期：2026-10-07 ｜ 基线：1fb1d72（R15） ｜ 原生冒烟终轮：r14c

## 任务契约

新工作区建立**本地**和**真实 SSH** 会话，输入/输出/切标签/关闭成功（G1 收口：证明新框架不是 demo-only）。本任务产品代码零改动（diff = src-tauri/src/main.rs 的 dev 门控探针 `r14_smoke_script` +130 行 + mode 分派 3 行），交付物即双环境端到端证据。

## 真实 SSH 目标

共享 docker sshd（127.0.0.1:2222，root / testpass——仓库既有测试约定凭据，core_local.rs/sshd_e2e.rs 同款 6 处，无真实凭据）。主机经 `upsert_host` wire 真路径创建（密码凭据核心加密落库 identities），TOFU 首连信任门走真实 pending→UI 确认流。

## 验证链

### 原生冒烟 r14c（release 终版二进制 + 隔离 DB + AUTOCONNECT=local）

[native-beacon.txt](native-beacon.txt) 链：`r14-open` → `r14-host-ok`（wire 建档）→ `r14-ssh-connected`（UI 点卡 → TOFU 信任 → 真实 sshd Connected）→ `r14-io-ok`（`send_keys` echo 标记 → `read_screen` 含标记）→ `r14-tabs-ok`（ssh↔local 双标签按主机名定位、双向激活）→ `r14-sub-live`（**close 前** debug_subscriptions 含该 sid——订阅存在性证明）→ `r14-close-ok`（工具菜单 → 关闭会话… → 确认「断开连接」→ 会话移除 + 标签回收）→ `r14-DONE` 零 FAIL，退出零残留（pgrep -x 干净）。

证据强度口径（证据纪律）：键盘注入走 `send_keys` invoke 级（CGEvent 注入受 P2 冻结协议约束，与 R13 menu-settings 同口径）；回显断言在**核心屏幕快照**（read_screen）级——原生侧未做 xterm DOM/像素级观测，xterm 渲染证据由 demo 探针 D3/D4 承担，跨端组合成立。**不主张**「原生 UI 显示回显」。

### demo 探针 11/11（[demo-probe-result.json](demo-probe-result.json)，dev server :5183）

TOFU 门出现 → Connected + xterm 渲染 → echo 标记回显闭环 → 双标签切换激活态 → 关闭菜单/确认弹窗 → 会话 Disconnected → `tab-dot.dim` 派生一致（dim 数 === Disconnected 会话数）→ 模块同一性护栏 → 零 JS 错误。demo 后端保留死会话标签（重连语义）、原生后端销毁回收——双端语义分离在探针注释明示，各自断言按端语义成立。

## 独立复核

### rev-r14（对抗审核）——处置后可签（1 中 5 低）

**已修复（脚本级，重编后 r14c 终轮复跑全绿）**：
- **中-1** `r14-subs-zero` 结构性恒真（close_session 先移除会话，debug_subscriptions 只遍历存活表——事后断言不可能失败，违反证据纪律）→ 改为 **close 前断言订阅存在**（`r14-sub-live`），删除事后恒真块，doc 注释同步更正。
- **低-1** tabs0 在主机卡出现后即取（AUTOCONNECT 标签晚渲染则得 0）→ 等 `waitFor` 首个标签后再取。
- **低-2** `await authInput.isVisible?.()` 死守卫（DOM 无此属性恒 !== false）→ 删除。
- **低-3** markSync 双 RUN 前缀（`r14a|r14a|...`）→ 调用点去前缀。
- **低-5** 标签切换固定 sleep(400) → `waitFor` tab-active。

**执行插曲（r14b 实证，已修复）**：AUTOCONNECT 时序抖动使会话列表序不稳定（r14b 中 ssh 先于 local 建档），索引式切标签把 tabs[1]（local）激活并误关——close 打错目标被 `FAIL-close` 断言抓住（信标如实暴露）。修复：标签按主机名定位（r14-sshd），关闭前显式回焦 ssh 标签。

**登记**：低-4 title 信标（FAIL-*/DONE）不带 RUN 前缀，跨轮归因依赖每轮清空信标日志纪律（r11-r15 既有协议）。

**核实无问题**：diff 范围仅 dev 探针；门控与 r11-r15 同 harness + 页级幂等护栏；选择器全部唯一核实；错误路径穷尽无静默通过；testpass 约定凭据无泄漏面；resize/C10 无需复测（产品代码与 R11/R12 验收时逐字节相同，引用既有证据有效）；demo D9 双端语义处理诚实无掩盖。

### vis-r14（视觉复验）——视觉可签（17/17）

- 零回归：干净首载三宽度 vs R15 基线，灰阶 raw 逐像素地面真值（Δ>7）：1280 差 3px=0.0003%（收起主机栏箭头钮 SVG 字形抗锯齿，与 R15↔R13 基线链记录同构）、1024 逐位相同（maxΔ=0）、960 maxΔ=1。几何 44/224/24、零横向破版。注：ImageMagick `compare` 对 1280 报 AE=196605 系工具异常值，已被 raw 逐像素 diff 推翻——后续轮次不单独依赖该工具。
- 垂直流程五态（[vis-shots/](vis-shots/)）：TOFU 遮罩居中完整（flow-a）、连接标签 tab-dot.ok 绿点 rgb(127,191,143) 与 --ok token 逐值相等（flow-b）、工具菜单三项定位正确（flow-c）、确认弹窗 danger「断开连接」完整（flow-d）、死会话标签 tab-dot 转 dim rgb(93,111,130)=--dim 且整页无破版（flow-e）。
- 双主题：light token panel/border/chrome 与 R15 存档逐字段相等，dark 还原正常。
- 零 console/page 错误（pageerror+console 双监听全程）。

## 登记

- `r14_smoke_script` 为 dev 门控探针，产品路径无关；TINYSSH_E2E_SSHD 未设门（探针自身依赖共享 sshd 存活，不可用时 FAIL-ssh-connected 响亮失败）。
- G1 退出项待办：P2、P6 同进程循环、P5 有效归属试点（受控环境）。
