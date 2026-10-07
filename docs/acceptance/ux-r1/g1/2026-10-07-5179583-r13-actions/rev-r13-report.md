# rev-r13 独立对抗审核报告——统一 action 分发/快捷键/焦点管理与原生菜单

> 审核人：rev-r13（独立复核，作者自查不算数）· 日期：2026-10-07
> 审核对象：commit `5179583`（R12 交付态）之上的工作区改动（`ui/src/actions.ts` 新增、`ui/src/App.tsx`、`ui/src/styles.css`、`src-tauri/src/main.rs`）
> 方法：git diff + 四文件全量实读（不只 diff）；对疑点跑 3 轮只读 Playwright 探针（真实 Chromium + dev server 5183，页面内插桩 `term.write`，未改任何产品代码、未提交）；证据目录逐文件核对（README.md / demo-probe.js / demo-probe-result.json / native-beacon.txt）

## 总结

架构方向正确且执行质量高：resolveAction 唯一 keymap + dispatchRef 执行 + 捕获层单点拦截，旧四组分散 effect 确认全部删除、无第二键监听残留（grep 全量核对：仅剩 Ctrl/Alt 传输层 776-823 与统一 ⌘ 层 1104-1127，两者键域不相交）；ref 每渲染重赋值，无 stale closure、无 TDZ（dispatchRef/closeTopOverlayRef 的箭头函数只闭包引用后文 const，调用发生在事件期）；demo 探针用真实键盘 + 终端聚焦验证了 fontUpDelta===1（真双执行探针）。

发现 1 中 6 低。中危一条有探针实证：**模态层打开期间键盘仍能进入终端会话**——R13 只给 native 侧加了模态门（note_terminal(false)），FE 侧的 Ctrl/Alt 编码层（与 native 拦截同效果同语义的镜像通道）没有加门，且该层连「终端是否拥有焦点」都不检查。其余为谓词缺口、§7.2 口径与证据纪律类低危。

---

## 发现

### 中-1 模态层打开期间，FE Ctrl/Alt 编码层仍把控制字符发进会话（且不检查终端焦点）

- **位置**：`ui/src/App.tsx:776-823`（窗口捕获层 Ctrl 分支 794-819、Alt 分支 781-793）；对照模态门仅作用于 native 上报 `ui/src/App.tsx:1331-1341`
- **实证**（探针 3，2026-10-07 dev server）：确认弹窗打开（工具菜单→关闭会话…）、活动终端 textarea 持 DOM 焦点（复现真实「⌘W 从终端开确认」状态——该路径焦点从不离开终端，弹窗无 autofocus），按 Ctrl+C → `term.write("\u0003")` 到达会话；普通字符 `y` 同样到达（后者属 R19/R23 focus-trap 登记范围的既有行为，非 R13 回归，但见下）。探针 2 另证：焦点在**非表单按钮**（`.st-file`）上按 Ctrl+C，`\x03` 照样进会话——该层的门只有「target 不是 INPUT/TEXTAREA」，既不查模态也不查终端焦点。
- **失败场景**：断开确认/TOFU 指纹弹窗打开（焦点仍在终端）→ 用户按 Ctrl+C（意图取消弹窗或中断眼前操作）→ `\x03` 发进仍在运行的远端会话，可能杀掉前台进程；⌥← 同理发 `\x1bb`。这直接违反 R13 验收标准「输入法、模态层、native Ctrl 不串输入」的字面：README 主张「模态打开即 note_terminal(false)」堵住了 native NSEvent 拦截，但 FE 编码层（为绕 WKWebView IME 吞 Ctrl 而建，正是 §7.4「原生 Ctrl」的 FE 半臂）同场景同效果地串。
- **建议修复**：Ctrl 分支与 Alt 分支入口加 `if (modalRef.current) return;`；顺带对齐 §7.4 的「终端确实拥有焦点」条件（如 activeElement 非 xterm textarea 时仅当 target 无表单语义才放行——现状按钮焦点也转发，与 native 侧 note_terminal 门不一致，属既有面，可与本条一并收口或明确登记）。普通字符经 xterm.onData 的模态期泄漏是 focus-trap 范围（R19/R23 已登记），不要求本轮修，但应在登记项写明「⌘W 开确认后焦点留在终端、打字即进会话」这一具体形态。

### 低-1 `inForm` 谓词漏 SELECT 等表单控件：⌘B 可在添加主机表单的下拉框焦点下劫持并连草稿一起销毁表单

- **位置**：`ui/src/App.tsx:1107-1110`（`ae.tagName === "INPUT" || ae.tagName === "TEXTAREA" || ae.isContentEditable`）；`ui/src/actions.ts:24` 注释同口径
- **失败场景**：用户在添加主机表单内 Tab 到「认证方式/远端编码」`<select>`（App.tsx:2958、2969）→ 按 ⌘B → inForm=false → 主机栏收起 → `aside` 卸载 → AddHostForm 连同已填名称/地址/密码草稿一起消失。§7.4 明文只写 ⌘B，但「表单编辑焦点下不劫持」的意图覆盖全部表单控件。
- **建议修复**：谓词加 `ae.tagName === "SELECT"`，或改用 `ae.closest("input, textarea, select, [contenteditable]")` 一类整体判定（注意继续排除 xterm textarea）。

### 低-2 §7.2「同一 action 分发源」口径不齐：三处 UI 直改 state 不经 dispatchRef

- **位置**：工具栏搜索钮 `ui/src/App.tsx:2067`（内联 `setSearchOpen(true)+focus`，与 dispatch "search" 分支重复）；主机栏设置钮 `1871-1874`（直 `setShowSettings(true)`，绕过 dispatch "settings" 的模态门）；设置面板关闭钮/遮罩 `2265`、`2270`（直 `setShowSettings(false)`，与 closeTopOverlay 分支重复）
- **失败场景**：当前无行为洞（三个模态遮罩均 `position:fixed; inset:0` z-index 90/100，模态期这些按钮物理不可达；非模态期直改与 dispatch 等价）。风险在未来漂移：dispatch 侧加的门/焦点恢复逻辑（本轮就加了 settings 模态门与 esc 的 restoreTermFocus）不会自动作用到这些副本。
- **建议修复**：三处改走 `dispatchRef.current({id:"search"})` / `{id:"settings"}`（settings 需要一个不受 modalRef 拒绝的语义或保持现状并在注释声明）；或至少在 README 把 §7.2 主张收窄为「键盘/菜单/搜索钮同源，其余按钮待并」。

### 低-3 Esc 链非模态段与视觉层级相反，注释/README「自顶向下关最上层浮层」表述不成立

- **位置**：`ui/src/App.tsx:1039-1053`（链序 authPrompt→hostKey→confirm→search→settings→tools→tabsMenu→…）；z-index 实况：search 10 < settings 30 < tools-menu 70（styles.css:477、487、248）
- **实证**（探针 1 P7）：搜索开 + 「标签列表」菜单后开（视觉在顶层），Esc 先关的是搜索。三个模态（confirm 90 / hk 100）排最前正确；其余按固定列表序而非开叠序/层级序。
- **失败场景**：用户先 ⌘F 开搜索、再点开工具菜单，按 Esc 预期关菜单，实际关了搜索。规范 §7.3「只有活动浮层消费它」未细化非模态浮层次序——语义模糊，非硬违反，但代码注释与 README 的「自顶向下」claim 与实际不符。
- **建议修复**：或将注释/README 措辞改为「模态优先，其余按固定序」；或非模态段改按最近打开序（记录 open 时间戳）。

### 低-4 window blur → note_terminal(false) 无对称恢复：切回窗口后 native 拦截保持关闭

- **位置**：`ui/src/App.tsx:839-842`（新增 onWinBlur）——没有 onWinFocus 对称上报；模态关闭路径 1331-1341 依赖 activeElement 判定，2FA 经「提交验证」按钮关闭（非 Esc）后 activeElement=body，同样不恢复 true
- **失败场景**：用户 ⌘Tab 切走再切回（焦点始终未离开 xterm textarea，无 focusin 触发）→ native 层仍记 false → 中文输入法组合期 Ctrl+C（WKWebView keydown 以 229 告终、JS 层收不到）在本窗内丢失，直到用户点击终端。规范只要求失焦报 false（已满足），回焦恢复是补全项。
- **建议修复**：`window.addEventListener("focus", onWinFocus)`——activeElement 为 xterm textarea 时 report(true)；2FA 按钮提交成功路径同样补一次按实焦点的上报。

### 低-5 r13 冒烟证据口径：beacon 单独不支撑「单一分发」全主张，且 T+15s emit 有竞态

- **位置**：`src-tauri/src/main.rs:1091-1252`（r13_smoke_script）、`937-948`（T+15s 线程）；对照 README 验收表
- **三点**：
  1. 原生冒烟的「⌘= 步进恰好 +1（双执行即 +2）」用 `document.body.dispatchEvent` 合成事件——target 是 body，**xterm 的 attachCustomKeyEventHandler 根本收不到该事件**，此断言只能证明 window 捕获层单次执行（多监听器残留），不能证明「捕获层 + xterm 兜底层」无双执行。该链路由 demo 探针补足（真实键盘、终端聚焦、`fontUpDelta: 1`）——两证据合并后结论成立，但 native-beacon 自身的表述口径偏大。
  2. 「⌘1/⌘2 精确切签（单一分发：激活态唯一）」——切签是幂等动作，激活态断言不构成分发次数证明（同上，由 demo 的 fontUpDelta 承担次数证明）。
  3. T+15s 定时 emit 与脚本进度存在竞态：本次 beacon 时间线 armed≈T+9s、emit T+15s、余量约 6s；若冷启动使脚本的确认弹窗段（modal-ok 之前）漂移到 T+15s 之后，emit 将落在模态期被 dispatch 的模态门拒绝 → `FAIL-menu-settings` 假阳性（脚本无重试、emit 只发一次）。
- **建议修复**：README 验收表如实拆分两环境各自证明了什么；冒烟侧把 emit 改为「armed 后再触发」（如脚本 armed 时经 beacon 通知，或 Rust 侧轮询信标），消除时间耦合。

### 低-6 IME 判定依赖逐事件标志，`ctx.composing` 为死参数；无 compositionstart/end 状态跟踪

- **位置**：`ui/src/actions.ts:32`（`ctx.composing || ev.isComposing || ev.keyCode === 229`）；两处调用点 `ui/src/App.tsx:721`、`1113` 均 `composing: false`
- **评估**：macOS 上 ⌘ 组合通常先提交组合文本再派发 keydown（isComposing=false），实际漏触发风险小；keyCode 229 + isComposing 双查已覆盖合成事件与真实 WKWebView 主路径，demo/native 双探针实证吞掉。`ActionCtx.composing` 从未被置 true——接口暗示有能力、实际是摆设，后来者可能误以为已有组合态跟踪。
- **建议修复**：删掉死参数，或补一个 document 级 compositionstart/compositionend 置位 ref（顺带覆盖 Safari 系 compositionend 前最后一帧 keydown isComposing=false 的边角）。

## 核对通过项（对抗后未发现缺陷）

- **双绑定残留**：旧 ⌘1–9 / ⌘W·⌘⇧[] / Esc 链 / ⌘F·⌘= 四组 effect 确认删除；全文件仅剩两个 window keydown 捕获层（Ctrl/Alt 传输层 776-823 与统一 ⌘ 层 1104-1127，键域不相交：前者 `!ctrlKey→return`、后者 `!metaKey→return`）+ JSX 各自的 Enter/方向键处理，无冲突。探针实测终端聚焦下 ⌘B 单次翻转（before/afterFirst/afterSecond = true/false/true）。
- **dispatch false 的透传不漏 ⌘ 字符进终端**：越界 ⌘N（dispatch false，不 preventDefault）到达 xterm 后由 733 行「其余 ⌘ 全拦」无条件 preventDefault 吞掉（探针 P6：writes 无新增；代码路径 732-735 审读一致）。无活动会话 ⌘F 在 demo 浏览器会透传出浏览器查找——已登记收紧项，非缺陷。
- **xterm ⌘F 兜底分支（715-731）实际不可达**：window 捕获层先于 target 以相同 ctx 解析，结果确定性相同——dispatch true 时 stopPropagation 使其收不到、false/null 时它重算同样结果。属防御性冗余而非双执行源（无害，注记：勿在未来把职责挂到它身上）。
- **模态门绕过路径**：⌘, 走 NSMenu（先于 WebView）→ emit → dispatch "settings" 的 `modalRef` 门已补（1074）；菜单项点击同路。原生菜单确认无 ⌘W/⌘T 加速器（main.rs:634 注释明示不设「关闭窗口 ⌘W」），不存在 NSMenu 与 FE ⌘ 动作的键盘层竞争。
- **Esc 链双执行/漏执行**：搜索框 input 自带 Esc 处理（2236-2242）因捕获层先行 stopPropagation 成为不可达备份，单路径执行；其余浮层无自持 Esc。链覆盖外的 rightPanel/connError/stopResult/dead-overlay 与旧行为一致（旧链同样不含），非回归。
- **restoreTermFocus 边界**：分屏聚焦 sidRef（焦点 pane）✓；死会话 termsRef 条目仍在、focus 成功、键入被既有死会话拦截 ✓；sidRef=null（欢迎页）no-op ✓。
- **模态门与 focusin/focusout 竞态**：模态打开瞬间若 xterm focusout → report(false)，与 modal effect 同向无冲突；Esc 关模态路径中 restoreTermFocus 的同步 focusin report(true) 先于 modal→false 的 effect，最终态正确。剩余竞态（模态期 Tab 进终端背后元素恢复上报）属 focus-trap（R19/R23 登记）。
- **resolveAction 键位假设**：`ev.key.toLowerCase()` 对 CapsLock/大写锁定稳健；⌘⇧[] 用 `ev.code` 物理键位——非美式布局**不会失效**（物理键恒存在，无需 Option 组合即可触发），比 ev.key 更稳，评估为正确选择（与 macOS 应用按物理位绑 ⌘⇧] 的惯例一致）。
- **标签 §320**：min-width:120/max-width:220（styles.css:433-435）+ `.tabbar` overflow-x:auto（421-424）+ 既有 [sid] 滚入视野 effect；demo 实测 7 标签全 120–220、900px 视口溢出横滚、切签后活动标签滚入（scrollLeft 325）。
- **styles.css**：仅 .tab 两值改动，无其他副作用；`.tab` flex:none 不收缩，窄窗走横滚符合规范。
- **main.rs**：r13 脚本注入维持 TINYSSH_SMOKE=1 + page_load 门控（dev harness，产品路径无关）；T+15s 线程 emit 在 app 关闭后返回 Err 被 `let _` 吞，安全。
- **beacon 复核**：`r13-opening → tabwidth(120,120) → tabs-ok → cmdw-ok → cmdf-ok → modal-ok → input-ok → armed-menu → r13-DONE`，零 FAIL、零 JS-ERROR/JS-REJECT，与脚本断言序列一致；demo-probe-result.json 26 项全 PASS、`jsErrors: []`。

## 裁决

**需修复后签。**

中-1（FE Ctrl/Alt 编码层缺模态门，探针实证模态期 `\x03` 进会话）是 R13 验收标准「模态层、native Ctrl 不串输入」范围内的真实缺口，修复量约两行（两个分支入口加 `modalRef.current` 检查）；处置后连同低危项（低-1 一并修，低-2/3/4/6 可修或登记，低-5 改证据口径表述）即可签。架构与既有纪律（单一 keymap、ref 反模式规避、证据双环境）质量高，无阻断性设计缺陷。

---

## 复验轮（2026-10-07，处置后复审）

方法：实读全部修复代码（App.tsx 790-877/1055-1059/1131-1154/1900/2095、actions.ts 全文、main.rs 940-958、README 处置表）+ 复跑探针 3 的等价场景并扩展（探针 5/6：模态期 Ctrl/Alt、无模态回归、按钮焦点新门、SELECT/⌘B、dispatch 化按钮、分屏焦点归属；探针 6 做路径归属决定性实验）。

### 逐项核验

| 项 | 代码 | 实证 | 结论 |
|---|---|---|---|
| 中-1 门本体 | App.tsx:800-802 两道门（modalRef / activeElement=xterm-helper-textarea）置于 Ctrl 与 Alt 分支共同入口，旧 target INPUT/TEXTAREA 判定确认删除 | 探针 6 Case B：模态 + 焦点移出终端 → Ctrl+C **零转发**（首轮探针 1 同场景曾发出 \x03）；探针 5 t3：模态期合成 ⌥← 零转发 | **该层修复有效** |
| 中-1 无回归 | — | t1/t2：无模态 + 终端持焦，Ctrl+C（\x03）与 ⌥←（\x1bb）照常进会话；t4：焦点在 .st-file 按钮时 Ctrl+C 不再转发（新门 §7.4 同口径，符合主张） | 通过 |
| 分屏/多终端 activeElement 正确性 | — | t8：双 pane 分屏，合成 mousedown 点右 pane 后 Ctrl+C 恰进右 pane 会话（rightSid=ctrlWentTo），左 pane 零写入；隐藏会话 textarea 不可聚焦，activeElement↔sidRef 由 focusSession 同步保证 | 通过，无新漏洞 |
| 低-1 | App.tsx:1138 谓词加 `SELECT`；actions.ts:22 注释同步 | t5：SELECT 焦点 ⌘B 主机栏与表单均保持；INPUT 焦点依旧豁免 | 通过 |
| 低-2 | 1900（hb-settings）与 2095（工具栏搜索钮）改走 dispatchRef | t6/t7：两钮经分发正常打开 | 通过 |
| 低-3 | 1055-1059 注释改为「三个模态最优先（视觉最上层），其余固定序非开叠序」 | 措辞与实测一致（首轮探针 1 P7 行为不变） | 通过 |
| 低-4 | App.tsx:861-868 加 window focus 对称上报（activeElement 为 xterm textarea 时补报 true） | 代码审读通过（headless 无法模拟系统级窗口切换，未实测——如实注明） | 通过（代码级） |
| 低-5 | main.rs:947-958 emit 改为 300ms 轮询 /tmp/t40_smoke/beacon.log 含 `r13-armed-menu`（URL 编码形式 `r13-armed-menu` 子串仍匹配）、90s 超时；README 验收表拆分口径（native 只证 window 层无重复监听，跨层单发由 demo fontUpDelta=1 承担） | 代码与 README 审读通过；轮询依赖「beacon 每轮清空」规程（记忆库既有纪律），日志未清时会在启动即 emit——脚本首页 r13fresh 归一会 reload，实际无害 | 通过 |
| 低-6 | ActionCtx.composing 删除，两调用点（737-743 / 1140-1146）同步为 5 字段；resolveAction:32 保留逐事件双查 | 通过 | 通过 |
| vis-r13 补滚修复（371-393） | 首滚 + 220ms 补滚 + RO 跟随容器宽度；scrollLeft 不改容器自身盒，无 RO 回调环 | 代码审读通过（vis-r13 自查探针已证两路径） | 通过 |

### 复验新发现

**中-1 处置的结果主张不成立（文档级，需更正）**：README 处置表称「⌘W 开确认后焦点留终端，Ctrl+C 不得再杀远端前台进程」——探针 6 Case A（复现该精确状态：确认弹窗开、活动终端持 DOM 焦点、真实 Ctrl+C）实测 `\x03` **仍进会话**。路径归属：JS 编码层已被门挡住（Case B 对照），残留走 **xterm 自身 keydown→onData→send_keys**（证据：该 'c' keydown 在 target 段被 stopPropagation，未冒泡至 document——xterm 消费特征；焦点移出终端即消失）。此路径与本轮登记的「模态期焦点留终端、打字即进会话」（R19/R23 focus trap）同机制同类——首轮报告已明示不要求本轮修代码——但**处置行的结果断言超出了实际修复效果**，违反证据纪律。两种收口任选：①更正 README 中-1 行与登记项为具体形态（「模态期终端持焦时 Ctrl+C/普通字符仍经 xterm onData 进会话，归 R23 focus trap」）；②若要真正达成原主张，在捕获层 modal 早退分支对 activeElement 为 xterm textarea 的按键 preventDefault+stopPropagation（约三行，Esc 除外）。

**低（登记段陈旧句）**：README「边界与登记」menu-settings 条仍写「由 Rust 侧 T+15s `app.emit` 补发」，与已改为 beacon 轮询触发的实现不符，需同步。

**登记项挑战结论**：①设置面板关闭钮/遮罩保留直改——合理（dispatch 无关闭动作语义，点击路径无需 Esc 链的焦点恢复，强行扩 action 面只增复杂度）；②非模态浮层动态开叠序不做——合理（§7.3 未细化，固定序=R12 行为，搜索+菜单同开先关搜索的 UX 怪点保留但量级低）；③demo 环境注记：模态期 JS 层不再 preventDefault ⌥箭头，demo 浏览器会触发 history-back 导航离开（仅演示环境，产品 WKWebView 无此绑定，无需处置）。

### 复验裁决

**可签（附一项文档级更正要求）**：代码层面 1 中 6 低全部处置有效、无回归、分屏焦点归属正确、零 JS 错误；唯一未收口的是 README 中-1 处置行「Ctrl+C 不得再杀远端前台进程」这句被探针证伪的结果主张（及登记段 T+15s 旧句）——按 ①更正口径或 ②补三行吞除任一收口后即可签署。
