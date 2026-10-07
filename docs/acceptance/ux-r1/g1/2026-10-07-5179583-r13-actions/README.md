# R13 统一 action 分发/快捷键/焦点管理——交付与验收证据

> 日期：2026-10-07 · 代码基线：`5179583`（R12 交付态）之上的工作区改动 · 依赖：R12 AppShell / 既有 note_terminal 拦截层
> 任务定义：交付文档 G1 表 R13——「统一 action、快捷键、焦点管理与原生菜单｜单一分发；输入法、模态层、native Ctrl 不串输入」
> 设计依据：主设计文档 §7.2「同一个 action 分发源」/ §7.3 输入约定 / §7.4 快捷键与焦点 / §320 标签

## 交付面

| 项 | 内容 |
|---|---|
| 单一 keymap `ui/src/actions.ts` | `AppAction` 10 种动作 + `resolveAction` 唯一事实源：⌘F 搜索、⌘=/⌘−/⌘0 字号、⌘B 主机栏、⌘W 关签、⌘1–9 切签、⌘⇧[/⌘⇧] 循环（物理键位 ev.code）、Esc。浏览器（非 native）不绑 ⌘W/⌘1–9/⌘⇧[]（保留系统语义）。⌘, 刻意不绑——归 NSMenu 加速器（先于 WebView 消费，绑了会双执行） |
| 唯一分发 | App.tsx：window 捕获层（capture:true，解析→dispatchRef 执行→preventDefault+stopPropagation）+ xterm `attachCustomKeyEventHandler` ⌘F 分支改经同一 resolveAction 兜底（原硬编码 ⌘F 删除）+ `menu-settings` 原生菜单事件改走 `dispatchRef({id:"settings"})`。旧 ⌘1–9 / ⌘W·⌘⇧[] / Esc 链 / ⌘F·⌘= 四个分散 effect 全部删除，无第二绑定 |
| Esc 链（浮层消费） | 三个模态（确认/指纹/双因素）最优先——它们视觉上也最上层；其余非模态浮层按固定序（搜索→设置→工具菜单→标签列表→添加/编辑主机→导入→Agent 指引），非严格开叠序（§7.3 未细化非模态次序）。关闭后 `restoreTermFocus()` 回终端（§7.4「关闭工具后恢复有效焦点」）。无浮层时 dispatch 返回 false 原样透传——终端里 Esc 仍是 vim 功能键、输入框 Esc 不被吞 |
| 模态层不串输入 | `modal = 确认/指纹/双因素任一打开`：⌘ 组合全吞（resolveAction）；settings 分支补模态门（菜单加速器不经 resolveAction，NSMenu 先消费）；**native Ctrl 拦截模态期停发**——模态打开即 `note_terminal(focused:false)`，关闭后按实际 DOM 焦点恢复（§7.4「无模态层时转发」） |
| 输入法（§7.3） | resolveAction 首行：`composing || ev.isComposing || keyCode===229 → null`——组合期不触发应用命令 |
| 表单焦点（§7.4） | `inForm`（INPUT/TEXTAREA/contentEditable，xterm textarea 除外）：⌘B 表单编辑焦点下不劫持（规范明文）；⌘F 保持全局（R6 走查语义）；⌘1–9/⌘W 维持原全局行为 |
| WebView 失焦（§7.4） | window blur → `note_terminal(focused:false)`（此前只有 focusin/focusout，整窗失焦不触发 focusout 时 native 层会以持焦状态继续拦截 ⌃字母） |
| 标签 §320 | `.tab` min-width:120 / max-width:220（原 0/170）；活动标签滚入视野为既有 [sid] effect（tabbarRef.scrollIntoView），本轮实测确认满足规范；溢出横滚 + 「标签列表」菜单 R12 已有 |
| 传输层（不属 R13，保留） | Rust NSEvent 本地监视器 ⌃字母拦截（note_terminal 门控）+ FE ⌥→Meta 序列编码 + xterm onData send_keys——是终端输入路径，非应用动作 |

## 验收对照（R13 两标准）

| 标准 | 证据 |
|---|---|
| 单一分发 | demo 探针（真实 Chromium + 真实键盘、终端聚焦，[demo-probe-result.json](demo-probe-result.json)）：⌘F 单发开搜索、⌘= 步进恰好 +1（双绑定即 +2——次数证明）、⌘B 开合各一次、⌘1/⌘2/⌘⇧[/⌘⇧] 激活态唯一；native 冒烟（[native-beacon.txt](native-beacon.txt) `r13-DONE`）：合成事件达 window 捕获层，证该层无重复监听（r13-tabwidth → r13-tabs-ok → r13-cmdw-ok → r13-cmdf-ok → r13-modal-ok → r13-input-ok → armed→menu-settings → r13-DONE 零 FAIL），跨层单发证明由 demo 承担 |
| 输入法/模态层/native Ctrl 不串输入 | demo + native 双环境：IME `isComposing`/`keyCode 229` 合成键不触发；确认弹窗期 ⌘F 被吞、字号冻结（native Ctrl 同门 note_terminal(false)，原生冒烟含真实 NSEvent 拦截层运行）；TOFU 指纹弹窗期 ⌘F 被吞、Esc=拒绝；表单焦点 ⌘B 不劫持、无浮层时输入框 Esc 透传 |

## 独立复核与处置（rev-r13 + vis-r13，2026-10-07）

**rev-r13（对抗审核）：1 中 6 低，「需修复后签」→ 全部处置（[rev-r13-report.md](rev-r13-report.md)）**

| 项 | 处置 |
|---|---|
| 中-1 模态期 FE Ctrl/Alt 编码层仍发控制字符且不查焦点 | **已修**：该层入口加两道门——`modalRef.current` 时直接放行（⌘W 开确认后焦点留终端，Ctrl/Alt 编码层不再转发控制字符）；改按 §7.4「终端确实拥有焦点」同口径（activeElement 非 xterm textarea 即不转发，与 native 侧 note_terminal 门一致，原先的 target INPUT/TEXTAREA 判定由其取代）。**范围如实声明（rev-r13 复验探针证伪原表述后更正）**：模态期终端持 DOM 焦点时，经 xterm 自身 onData 的普通键入与 Ctrl+C 仍会进会话——这是弹窗 focus-trap 未实现的既有形态（首轮审核已登记归 R19/R23，本轮不动代码），修复只覆盖 Ctrl/Alt 编码层这条与 native 拦截同语义的镜像通道 |
| 低-1 inForm 漏 SELECT，⌘B 可毁添加主机表单草稿 | **已修**：谓词加 `SELECT` |
| 低-2 三处 UI 直改 state 不经 dispatchRef | **部分修**：工具栏搜索钮、主机栏设置钮改走 `dispatchRef`（§7.2 同源）；设置面板「关闭」钮/遮罩保留直改（dispatch 无对应关闭动作，Esc 链的焦点恢复语义不适用于点击关闭）——如实登记为口径注记 |
| 低-3 Esc 链「自顶向下」表述与实际不符 | **已修（措辞）**：注释/README 改为「三个模态最优先（视觉上也最上层），其余非模态按固定序，非严格开叠序」；按时间戳动态排序不做（§7.3 未细化非模态次序，固定序与 R12 行为一致） |
| 低-4 window blur 无对称 focus 恢复 | **已修**：加 `window focus` 监听，activeElement 为 xterm textarea 时补报 true（⌘Tab 切回不再保持拦截关闭态） |
| 低-5 冒烟证据口径偏大 + T+15s emit 竞态 | **已修**：①emit 改为轮询信标日志等脚本 `r13-armed-menu` 后触发（90s 超时），消除与冷启动进度的时间耦合；②验收表述拆分——native 冒烟合成事件只达 window 捕获层（证单层无重复监听），「捕获层+xterm 兜底层」双层的单发执行由 demo 探针真实键盘 fontUpDelta=1 承担；⌘1/⌘2 断言口径为激活态唯一（幂等动作不作次数证明，次数证明同上归 demo） |
| 低-6 ctx.composing 死参数 | **已修**：删除；resolveAction 保留逐事件 `ev.isComposing || keyCode===229` 双查，注释明示无跨事件组合态跟踪 |

**vis-r13（视觉复验）：零回归全过 + 1 FAIL（[vis-r13-results.json](vis-r13-results.json)）→ 已修**
- 零回归：欢迎页/会话视图/1024/960 几何与样式逐字段等于 R12 基线（44/224/40/40/24、面板 384、token、字号档），双主题正常，5 轮探针零 JS 错误；标签宽界 120–185.2∈[120,220]、30 字长名 220 夹取+省略号。
- FAIL（已修）：900 宽溢出态直点被截最右标签，scrollIntoView 只滚 33/79，活动标签仍截 46px——vis 实测 R12 基线同参数同样溢出（既有竞态，非 R13 引入）；因 §320 是 R13 验收项，本轮修复：补滚两成因——①滚动钮显隐翻转回钳 scrollLeft 后 220ms 补滚一次；②溢出可不经 sid 变化出现（窗口缩放/主机栏/面板开合），加 ResizeObserver 跟随 tabbar 宽度变化补滚（scrollLeft 不影响容器自身盒子，无回调环）。修复后自查探针（[vis-r13-tabscroll-fixcheck.js](vis-r13-tabscroll-fixcheck.js)）：直点被截标签 sl=128/cut=0/vis=true，resize 出现溢出后活动标签自动滚入（initial sl=128 vis=true），两条路径均过。

## 修复后全量复验（2026-10-07）

- demo 探针复跑（修复后 bundle）：26 项全 PASS、零 JS 错误（[demo-probe-result.json](demo-probe-result.json) 为修复后复跑值）。
- 原生冒烟复跑 ×3（r13b/r13c/r13d，最终轮 r13d 为终版二进制——dist 变更不触发 cargo 重编，已 touch 强制重编 16.97s 后再跑）：全链 `r13-DONE` 零 FAIL、退出零残留（[native-beacon.txt](native-beacon.txt) 为 r13d 终轮）。

## 边界与登记

- **⌘F 无活动会话时不打开搜索**（dispatch 侧 `!sidRef → false`）：旧行为是无会话也开搜索面板（悬空无意义）；R13 收紧为不劫持，与工具栏搜索钮仅在活动会话渲染一致。
- **menu-settings 的 FE 半链路实证**：原生冒烟由 Rust 侧轮询信标日志、待脚本 `r13-armed-menu` 后 `app.emit("menu-settings")` 补发（与 NSMenu 项命中同一 emit 点；rev-r13 低-5 处置——原 T+15s 定时 emit 与冷启动进度有竞态已改），脚本断言设置面板经统一分发打开 + Esc 关闭。NSMenu 菜单项与 ⌘, 键等价到 `on_menu_event` 的系统分发是 macOS 保证 + T34 既有交付，未在本轮 CGEvent 注入重验（受 P2 键注入冻结协议约束）。
- **合成键盘事件口径**：native 冒烟用页面内合成 KeyboardEvent（与 r12 同口径），检验 FE 分发链在真实 WKWebView 的行为；真实 CGEvent 注入受 P2 冻结协议（前台+在屏双核验）约束不在此列。
- **focus generation / 弹窗 focus trap**（§312 默认输入、§7.4「关闭恢复原触发控件」）：归 R19/R23 连接状态机与模态深规则——本轮交付的是工具关闭后的终端焦点恢复（trigger 前有效焦点的常见形态）。**具体残留形态（rev-r13 复验登记）**：⌘W 开断开确认后焦点留在终端，模态期打字/经 xterm 的 Ctrl+C 仍进会话；2FA 经「提交验证」按钮关闭后 activeElement=body，native 拦截保持关闭直到焦点回到终端——focus trap 落地时一并收口。
- **Option 组合键按终端设置映射**（§316）：依赖终端设置项，归 R27。
- modal 信号定义：确认/指纹/双因素三种队列非空。连接表单等非模态 UI 不设门（⌘1–9/⌘W 维持全局可用，规范仅对 ⌘B 明示表单豁免）。
- **› 滚动钮提示计数口径（vis-r13 复验登记，遗留小文案）**：`右侧还有 N 个会话被收起` 只数完全移出视野的标签，部分被截的不计——不影响几何与滚动行为，文案修正归 R25 标签交互。

## 运行环境

- demo 探针：Playwright + 真实 Chrome 1280×800，demo 后端（种子库），两轮全绿（复跑验证可重复），零 JS 错误。
- 原生冒烟：交付态 release 二进制（`cargo build --release`）+ 隔离 DB `/tmp/smoke/tinyssh.db` + 本机（local）会话真环境 + beacon 服务 127.0.0.1:15199，`TINYSSH_SMOKE_MODE=r13`，`r13-DONE`，退出零残留（pgrep 干净）。屏幕未锁（锁屏冻结 WKWebView 见 R12 登记）。
