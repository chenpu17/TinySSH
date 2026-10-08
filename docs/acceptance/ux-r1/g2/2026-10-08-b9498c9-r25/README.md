# UX-R1 G2 · R25 搜索/复制粘贴/多标签/双分屏 —— 验收证据

基线：b9498c9（R23）。日期：2026-10-08。

## 任务面（存量盘点 + 本轮增量）

存量已就位（T16/T19/R13 签核遗产，本轮回归网护住不回退）：终端搜索条（SearchAddon + decorations 计数 + ⇧⏎/⏎/Esc）、⌘C 选中复制/⌘V 粘贴/⌘A 全选、分屏脚手架（enterSplitWith/exitSplit/pane 点击换焦/名牌）、死会话输入拦截（§330 输入不排队如实告示）、IME isComposing/229 双查（R13）。

本轮增量：
1. **§318 多行粘贴保护**：粘贴内容含换行（阈值）且远端未开 bracketed paste → 预览确认框（目标主机名 + 内容预览（超 2000 字符截断显示、确认发全文）+ bracketed 说明；取消 = 零字节）。设置 → 粘贴 section 开关（默认开，说明文案含阈值与关闭后果）；持久化 `ui.v2.workspace.terminal.paste_guard`（session-api `TerminalPrefs` serde default + wire/demo 三端同契约；写链沿用 wsWriteChain 串行化）。xterm bracketed 语义保留（term.paste 按远端 DECSET 2004 自适配，不补换行不代执行）。
2. **§322 分屏建立双语义**：工具栏分屏钮 → 菜单——「在右侧显示已有会话（复用现有连接，不新建）」列其他会话 + 「在右侧新建会话…」武装标记（toast 说明），武装后下一次新建会话自动落右副 pane（当前会话留左主）。武装完成 = 用户显式意图，不经 §6.3 四条件（同切标签主动导航语义）。
3. **§322 契约修正——attach 替换焦点窗格**：旧实现恒替换左主 pane；按契约改为替换焦点所在 pane（焦点在副则换副，主不动）。
4. **§185 宽度退化**：双窗格各 <360 宽 → 退化单窗格（焦点窗格全幅，另一会话仍在标签）；恢复带 6px 迟滞防阈值抖动；退化时显示一次性可关闭布局提示（关闭后恢复不再打扰）。
5. **§330 断线旧画面可选中复制**：dead-overlay pointer-events:none（横幅 auto）——遮罩不再阻断终端选择，重连钮仍可达。
6. **名牌主机名重刷**：sessions 变化后 re-apply panes（防新建会话名牌暂显 sid）。
7. **R01 Esc 高亮残留闭环**：Esc 关闭搜索后匹配装饰清零（3→0；空容器为 addon 管理的不可见 DOM，非视觉残留）。

## e2e

- **demo 探针**（真实 Chromium + vite demo 后端 :5183，r25-demo-probe.js）：处置前 **26/26 ×2**；rev 处置后 **28/28 ×2**（增 B2 真实点击命中判别、C5c 二退不重现、C6 武装消费）。A 搜索全链（计数 1/2、Esc 关闭+焦点回终端、装饰零残留）；B 粘贴保护五路（多行确认框含主机+预览、取消零字节、**真实点击发送命中+全文达终端**、单行直发、DECSET 2004 后多行直发、设置关闭直发+开关落盘重开仍为关）；C 分屏七路（菜单双语义文案、复用入右主不动、焦点 pane 替换（mousedown 触发委托）、退出分屏四标签保留、武装自动落右+聚焦、640px 退化+提示+关闭+1280 恢复+提示不打扰+再退化不重现、全关后武装消费两次新建不分屏）；D 断线（横幅 pointer-events 对账、画面选中复制剪贴板实读）；E IME 组合期不误触发；F alt-screen（1049h 激活、搜索不漏主屏、命中计数、1049l 恢复+alt 清除——标记自备：重挂载 checkpoint 重建冲早期内容，R11 有界重放环）；Z 零 JS 错误。
- **原生冒烟**（真 sshd 127.0.0.1:2222 双机 + 隔离 DB + 口令 env，GUI tinyssh-app，beacon 协同）：**r25a/r25b 两轮全链 DONE 零 FAIL 零 JS-ERROR/REJECT**。链：双真机连接 → 分屏菜单复用（真 pane 左 r25-b/右 r25-a）→ pane mousedown 换焦（pane-focused 圈实落）→ 退出分屏两会话仍 Connected + 两标签在 → **真剪贴板**（驱动 pbcopy 分段换料：单行 `echo r25pastemark` 直发回显；多行两行远端 bracketed 直发无确认框——bracketed 开启 parity 原生实证）→ 退出链（真窗口关闭 ×2 → 摘要框 → 取消 → 确认结束会话并退出 → 进程零残留 DRIVER|app-exited-clean ×2）。
- **workspace**：146/0（首跑 1 红 `cancel_events_carry_terminal_phase_only` 事件空——单测复跑 ×4 + 全量复跑 146/0 全绿，R19/R24/R23 已登记同族 c1 时序窗 flake，本轮未动 core-session）。tsc 0。

## 执行插曲（如实）

1. 原生 alt-screen 段两轮受挫：docker Alpine 无 vim（prompt `~` 假阳性）；改 DECSET 1049 直发后 normal buffer 读数仍被重置（checkpoint/重放与 alt 交换互作）——该域 R11 已原生实证 alt 屏检查点，搜索作用域改由 demo F 段 term.write 直控覆盖（本 README 取向登记）。原生脚本删 B 段保留分屏/粘贴/退出。
2. 原生脚本分屏菜单复用项假设错（当前会话=后连的 r25-b，菜单列 r25-a）——FAIL-no-reuse-item 载荷直接示真值后修正。
3. 探针三处工艺修复：cardBtn 传参键名错（点击从未发生）；pane 焦点委托听 mousedown（JS .click() 不触发）；`buffer.active.type` 须在 write 解析后异步读。
4. H1 调试插曲（如实）：粘贴确认框处置期间一度误判「对话框周期杀死输入链」——实为调试脚本 tail-scan 读缓冲底部空白垫底行（demo checkpoint 合成光标在最后非空行，新内容写在其下方的既有序内），全缓冲扫描后证伪；产品输入/输出链全程无恙。教训已记：终端缓冲断言一律全缓冲扫描。

## 取向登记

- alt-screen 搜索作用域证据=demo F 段直控（原生面不可靠读数如实登记，不主张原生）。
- 粘贴保护确认路径（无 bracketed + 多行）=demo B1/B2；原生只证 bracketed 直发 parity（Alpine bash 默认开启）。
- 「在右侧新建会话」武装 = 显式意图直通（不经 §6.3 四条件），与「切标签主动导航可聚焦」同语义。
- 空装饰容器（.xterm-decoration-container）为 xterm addon 管理的不可见 DOM，关闭后持续存在不属残留。
- 退化提示一次性：关闭后恢复/再退化不再重现（会话内状态，不持久化）。
- §186 双分屏时文件完整视图：文件面板未实现（G3/R30），N/A 登记。
- 输入法/焦点/原生键盘：IME 合成期防误触发 demo E1 实证；真实 IME 人工域归 R52 真人验收。

## 独立审核与视觉复验

### rev-r25（独立代码审核）：初判**处置后可签**（1 高 1 中 4 低）

独立复跑：demo 探针 26/26 复证、workspace 146/0、tsc 0、beacon r25a/b 边界判读成立。核证通过面：⌘V 守卫闭包/模式取发送时刻/取消零字节/目标 sid 捕获+modal 吞 ⌘1-9 防切标、attach 焦点窗格替换（探针复证）、退化迟滞/恢复、wsWriteChain 全 4 写入点、Esc 链次序、dead-overlay 放行后真实双击选区+⌘C 剪贴板实读、armSplit finally 语义。

- **H1（高）已修**：粘贴确认框原为裸 `.pop-mask` + 兄弟位置的无定位 `.confirm-dialog`——对话框被自身遮罩盖住且不居中（elementFromPoint 命中遮罩），鼠标点不中按钮，唯一出路 Esc；且静态流内子项挤压终端（666px，还会使退化阈值失真）。作者探针 B1/B2 合成 `.click()` 绕过命中测试、原生冒烟 bracketed 开启从不打开该框——两面证据都照不到。**修 = 嵌套结构**（confirm-mask 为父 flex 居中 + dialog 子元素 stopPropagation，与 closeSession 确认框同构）。**判别探针升级**：B2 改真实 mouse.click 于发送钮中心——旧兄弟结构下该断言必红（实测复现：命中遮罩、框关零粘贴），修复后命中按钮+全文达终端。
- **M1（中·证据纪律）已修**：README「关闭后不再重现」与代码不符（每次退化都重开提示）——改代码对齐「§185 显示一次」：`splitHintDismissedRef` 关闭后本会话内不再重现；探针 C5c 补二退不重现判别。
- **L1 已修**：武装标记跨全关残留（全关回欢迎页→第 1 次新建不消费→第 2 次意外分屏，rev V3c 实证）——新建完成时总是消费标记，prevSid 无效则静默消费；探针 C6 补全关后两次新建均不分屏。
- **L2 登记**：退化阈值按容器宽计，1px 分隔线未入账（临界差 ≤1px/窗格）。
- **L3 登记**：splitMenu 入模态联合（菜单开着 ⌘W/⌘1-9 被吞）——与 toolsMenu/tabsMenu 非模态处理不一致，保守方向。
- **L4 登记**：ResizeObserver 150ms 去抖窗内双 pane 短暂 <360（既有设计）。

处置后回归：探针 **28/28 ×2** 连续轮（含 B2 真点击命中/C5c 二退不重现/C6 武装消费三新判别）+ tsc 0 + 原生 release 重建后 r25a 重跑全链 DONE 零 FAIL。**rev-r25 处置复验终裁：可签**——H1（嵌套结构 elementFromPoint 命中按钮、termW 1038 零挤压、真实点击/Esc/mask 三出口全通）/M1（关提示再退化不重现+退化行为正常）/L1（全关后两次新建不分屏旧码必红、无门主路径武装语义无回归）均独立实证通过；Rust 侧本轮零改动免复跑；残留 L2/L3/L4 均登记不阻签。复验脚本 /tmp/rev-r25-reverify.js、/tmp/rev-r25-l1.js、/tmp/rev-r25-l1b3.js。

### vis-r25（独立视觉复验）：**视觉可签**（1 低两轮处置闭环，零未决项）

双树（基线 worktree b9498c9 :5184 / 当前 :5183）逐像素：欢迎页/添加表单/断线横幅 diff_px=0；搜索条 153px 经连拍自差判光标闪烁噪声底；设置弹窗上部 170px 经四步甄别（双树自差 0/复拍点位相同/孤立 AA 单点/隐藏粘贴 section 后差 170→0 对照实验）= 弹窗高度变化光栅化副产品，盒锚点两树精确一致、凭据库位移 Δ132.8 恰等于粘贴 section 高度——预期 delta 成立。新增面盒测量：分屏菜单 260×129.1 零相交零截断；粘贴确认框长内容 pre 220 上限内部滚动不撑破；双 pane w224/w280 等宽 ≤1.5、名牌不相交——R21 280px 叠印无复发；640px 退化单窗格+提示条居中、恢复正常；断线横幅 PE 对账+A5 双树 diff=0 证 pointer-events 改动视觉零影响。

- **L1 已处置闭环**：640px 下提示条文案被单行 ellipsis 截断（恢复指引不可读）——处置一：改两行 clamp（-webkit-line-clamp:2）——postfix-1 复验：两行达成但 flex 容器收缩仍截末字；处置二（vis 代验证方案落地）：`.split-hint { width: min(86%, 480px) }` + `span { flex:1; min-width:0 }`——postfix-2 终验：hint 356×51.2、span 286×37.2 两行、spanClipX/Y=0 全文 39 字逐字完整、与关闭钮不相交、恢复无残留。
