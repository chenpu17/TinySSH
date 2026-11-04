# 找茬四轮：四路 subagent 走查 ×2（审查+独立确认）＋修复（2026-11-04）

用户指令：「安排subagent到处看看多审核、测试，发现各类问题，包括视觉体验、用户操作习惯、性能、可靠性等问题，发现问题后需要独立subagent确认问题再修复，并做好端到端验证与视觉验证。」对工作树 9 轮未提交叠加（HEAD=3c2569c，diff +5077/−537）跑**四路**（A=Rust 性能/可靠性、B=前端性能/可靠性、C=视觉体验截图走查、D=用户操作习惯），串行（坑 62）；**每条 finding 由独立确认 subagent 证伪后才修**。

## 一、Findings 与裁决（确认员逐条证伪后）

### A 路（Rust 性能/可靠性）— 5 条全确认，5 条全修

- **[P2] 墙 2s tick 无在飞守卫 + exec「开通道/exec 写入」两段不受 8s deadline 管辖**：慢链路下 setInterval 叠出并发 fresh exec 通道（8s 上限稳态 ~4 条/会话）挤 sshd MaxSessions=10；重叠回包乱序时旧快照覆新帧。**cancel token 是死闸**——exec_fresh 的三处 cancel select 臂全员不可达（建而不用）。**修**：core `tmux_exec_raw` 把 token 接到同一 8s 预算（spawn 到点 cancel，前置段 Cancelled 快速失败，读环 deadline 臂不变）；前端 tick 加 in-flight ref（上一拍未回本拍跳过）。
- **[P3] 墙键入歧义失败无「结果未知」语义**：send-keys 与补拍是同一条远端命令，链路在 send-keys 后断开时报「送达失败」→ 用户重发即双发（传输管线有 OutcomeUnknown 先例）。**修**：`tmux_exec_raw` 返回三臂 `TmuxExecOut::{Done, Dispatched, NotDispatched}`（模块级 enum——坑 92 再犯：enum 不能进 impl 块）；墙输入 Dispatched 臂报「键入已发出但通道中断：结果未知，请以画面下一拍为准，勿立即重发」，前端透传后端文案。
- **[P3] EOF 宽限固定 2s，Close 迟到误判掉线→自动重建复活刚关的格子**（读泵超时与真 Close 共用 None 臂）。**修**：transport 读泵宽限超时**续期一拍**（eof_extends≤1，总 4s 自限）再判死，两拍仍无 Close 才按掉线收。
- **[P3] close_session 逐格串行 close，每格最多吃一次 20s 写停滞——5 格全卡关会话 ~100s**（Tauri 命令直 await）。**修**：并发收格（Arc<TmuxPane> 整体 move 进各自 spawn）+ 每格 `PANE_CLOSE_BUDGET=3s`（超时弃尾安全：close 先置 alive=false 泵即死，漏发 CHANNEL_CLOSE 由随后整条连接关闭兜底）；`tmux_pane_close` 单格同款预算。
- **[P3] `tmux_reconcile_attached` 5s fresh 窗对慢链路太窄：探针落「注入>5s、client 未注册」窗口误清记录且不自愈→二次明文注入**（与已立案「不复核」是相反失败向，新问题）。**修**：零客户端臂**双拍确认**（`tmux_attached_zero_arm`：第一拍只武装，第二拍仍零才清；中间见到客户端即解除；确定残留臂——会话没了/跨纪元——仍立即清；attach 成功即解除）。pane_tests 既有单拍清契约改写为双拍契约。

### B 路（前端性能/可靠性）— 7 条：5 确认 + 1 降级（机理纠正）+ 1 收窄；修 6、立案 1

- **[P1] 键入态「焦点自愈」无差别抢焦点**：任意 blur 后 0ms 把焦点抢回 1×1 隐形输入框——把用户在**外部输入面**（设置面板刻意设计成大屏开着可用）敲的每个字符静默发进远端 tmux 会话。确认员修正触发链：墙是 `.main` 全域覆盖层盖死工具栏，「作曲行」链不成立；**设置面板鼠标可达**（actrail 在 .main 外）实锤，且覆盖层可用浮层与「隐形框焦点自愈」之间没有任何焦点归属判据（与 Esc 豁免缺口同根）。**修**：refocusSoon 前查 `document.activeElement` 已落墙外即放弃；新增 active 态 `pointerdown/focusin` capture（焦点/点按落墙外即 deactivate+冲刷挂起字面）。**定点验证**：设置面板点开关→键入→active 收掉、tw-input 空、焦点留设置，全绿。
- **[P2] 墙键入管线没接 imePunctToAscii——确认员**降级 P3 并纠正机理**：墙是 send-keys 服务端注入零客户端，tmux 前缀表只对 attach 客户端的键生效，**send-keys 根本不武装前缀**——补 imePunctToAscii 无效。这是「墙设计上不存在前缀语义」（hint 已指深度操作「进格子」）。**处置：立案不修**（语义拍板项）。
- **[P2] TmuxWall 无 memo + ansiToHtml（逐字符 3 regex）每渲染全格重算 + tick 恒新 Map + Esc 监听随内联 onClose 每渲染 remove/add**。**修**：memo(TmuxWall) + WeakMap 按 cell 对象缓存 html（tick 已复用旧对象）+ setFrames 内容全等返回旧 Map + Esc 收 closeRef deps [] + App 侧 wallFetchCells/wallSendInput/wallPromote/wallClose useCallback（deps 钉 wallSession，openTmuxPane 走 ref）。
- **[P2] `setAutonomy(nextAutonomy)` 缺 bailout——refreshLists 唯一漏网，App 每 3s 无条件整树 diff**（同函数上方注释自述「数据没变整树静默」被架空）。**修**：一行 `sameShape`。
- **[P3] 墙整拍抓取失败静默冻结**（单格有 tw-off、键入有 errFlash，整拍级零反馈；断线后 `tmux?.available` 不翻 false 墙不卸载）。**修**：连败 3 拍置 stale 头部提示「画面已停更：通道不稳，正在重试」（testid tmux-wall-stale）。
- **[P3] layoutTmuxPanes 全量重写命令式 DOM**：innerHTML setter 无条件删子树重解析（同串也全量）、textContent 同值重建节点——分隔条 pointermove 每帧 N 格 SVG churn。**修**：zoomBtn.title/aria-label/innerHTML 与 main.tag.textContent/title 写前等值跳过。
- **[P3] 墙开着+作曲行聚焦按 Esc：关掉的是大屏不是取消作曲**（墙 document capture 先于 target 相位吞事件；App 守卫只放行不消费）。确认员收窄触发面=键盘路径（鼠标被 z-46 挡死）。**修**：墙 Esc 处理器开头同款豁免（activeElement 是墙外 INPUT/TEXTAREA 即 return）。

### C 路（视觉走查，60 张截图）— 2 实锤 + 1 代码备注，全确认；修 2、立案 1

- **[P1] 1366×768 接入后光标悬空、键入回显脱离提示符两行**（round3 realignAfterFit 修复未收住的回归）。确认员钉死机理：**度量混算**——`viewportY+cursorY` 应为 `baseY+cursorY`（ydisp 随滚动浮动，平滑滚动半途测错）；**CUP 写死 `tail+1` 当视口行**（tail 是绝对行号）；demo 检查点 32 行 vs 768 视口 27 行缩行 reflow 把光标钉在垫行、realign 两拍全空放。确认员用的公式本身也核过 xterm 源码（BufferApiView/DomRenderer）。**修**：度量改 `baseY+cursorY`、CUP 行号写时按 `tail - viewportY + 1` 现算、补拍加一拍 700ms（覆盖迟到回放帧）。**定点验证**：768 下 cursorAbs=3=tail、回显 `echo zfindings4-v1` 落提示符后（截图目检光标紧贴提示符行）。
- **[P2] tmux 快接菜单无 max-height/滚动：条目多时底部捅出视口**（768 高约 16-17 项触顶，溢出 127px，末项不可达；标签列表菜单同基类同病；对照组 .ctx-menu 有 JS 回夹）。**修**：`.tools-menu` 基类 `max-height: calc(100vh - 120px); overflow-y: auto; overscroll-behavior: contain`。**定点验证**：24 会话 fixture，bottom=770≤vh+2、overflow auto、滚动后末项可达（截图目检 24 项全在视口内）。
- **[P3 备注] makePaneTerm 恒挂 WebGL 不吃连字偏好**——连字开时主视图 DOM、格子 WebGL，同屏两种字形引擎。**修（顺手）**：makePaneTerm 与主终端同构（termLigaRef 开→LigaturesAddon、关→WebGL 预算）；applyLigatures 热切换遍历双表（格子一起换装）；PaneTermEntry 补 liga 字段。

### D 路（用户操作习惯）— 6 条事实全站住：确认 4 + 驳回定性 1 + 供拍板 1；修 5、维持 1

- **[P2] 新审批到达零主动通知**（approval-event 只 refreshLists；trigger-event 有 toast+铃双通道；被动件只有标题栏 pill/rail 徽标，全屏打字时太小；终端 BEL 失焦还有系统通知，审批反而没有）。**修**：approval-event 收 `New` 臂 → pushToast 带「去审批」action（开协作面板）+ setBellSids 标签铃；Updated（批准/拒绝收尾）不打扰。
- **[P2] 主机栏键盘断链**：Ctrl+Shift+B 开栏后焦点不动，Tab 被 xterm 吞（\t 直发 shell）——有会话时纯键盘够不到主机列表（palette 能补「键盘连主机」补不了「到达列表 UI」；demo 域该键是 native 门死键，**真机域成立**）。**修**：`toggleHostbar(open, focusSearch?)`——键盘动作开栏时 setTimeout 焦点落 hostSearchRef 搜索框；鼠标/rail 不传参不抢焦（§6.3 焦点纪律）。
- **[P3] docked 右缘面板 Esc 关不掉——确认员驳回「缺口」定性**：兜底件充分（✕/rail 再点/palette/标题栏徽标），「Esc 管浮层不管停靠」与 VS Code 惯例吻合，**维持现状不修**。
- **[P3] 新建/快速连接表单「地址」框 Enter 不提交**（其余 7 处都有；quick-connect 更糟——地址/端口/用户名全缺，地址恰是 autoFocus 首字段）。**修**：add-host 地址框 Enter=名称空则先以地址补名再提交（submit 加 nameFromAddr 参数，撞「名称不能为空」防呆的动线打通）；quick-connect 地址/端口/用户名补 enterKey（密码框同款收编）。**定点验证**：地址键入 10.1.2.3 回车→提交受理+名称自动补齐。
- **[P3] 大屏键入态无可见退出件**（solo 态 body 铺满无空白可点，代码注释自认「唯一退口」；hint 只教进入不教退出；键入态 Esc 直发会话=纯键盘用户无退出路）。**修**：active 格头加「完成」钮（accent 软底）+ hint 改「点「完成」或空白处退出键入」。
- **[P3] 面板中的会话切主视图要两跳（菜单行 disabled+title 解释）——供拍板，采纳一键化**：`onPromotePaneToMain` 收齐同名窗格再走 restoreTmuxScene（格是纯视图 detach 零损失，终态单视图落在双向防呆允许侧）；title 改「从面板收格并切到主视图」。**spec 63 更新到新契约**：主项可点断言 + 新增 J1.5 段（一键收格+主视图换装 tmux:work）。

## 二、验证

- **core-session 189/189**（含改写的 reconcile 双拍契约测试；`send_keys_ctrl_c` workspace 连跑假失败单跑绿=坑 66 同族）；cargo workspace 全绿。
- tsc 0；npm build ✓（41s）。
- **UI 全套复跑 1117 断言 1116 通过**：首轮 1099 断言 2 失败（63=spec 钉「inPane 主项禁用」旧行为，已更新到新契约+J1.5 段；61=负载 flake，单跑 28/28 绿）；复跑唯一失败 15-goal「草稿闪 1 帧」=已知逐帧采样负载 flake（采集开关轮修过真因，负载下偶发残余），单跑 29/29 全绿；63 复跑 125/125（含 D6 新契约 4 断言）。
- **定点视觉/交互验证 21/21**（ui/test/tmp-fix-verify.cjs）：V1 768 光标/回显对齐（缓冲绝对行 3=3+回显落提示符后）/V2 24 项菜单滚动（不捅视口+末项可达）/V3 完成退出件/V4 外部输入收键入态零泄漏/V5 地址回车提交。截图 4 张目检：fx-v1（光标紧贴提示符）、fx-v2（24 项全在视口）、fx-v3（完成钮 accent 软底+hint 新文案）、fx-v4。
- 踩坑记录：demo 域没有 `__TAURI_INTERNALS__`（那是 Tauri webview 的）——demo 钩子是 `__demoInvoke`；`demo_tmux_fixture` 需要已存在 sid（先连后预置）；demo 预置会话已 Connected 且带 tmux（激活预置 tab 比新连省 TOFU 门）；连接钮 hover 才浮现且 hover 必须落在拥有该钮的同一张卡（.host-line 拦截点击）。

## 三、教训

1. **周期任务的在飞守卫与超时的全覆盖是同一课**：setInterval 叠拍与 exec 前置段无界悬挂共享一个根因——「cancel token 建而不用」这类死闸不会在编译期暴露，review 时要专门问「这个 token/守卫真的会被触发吗」。
2. **确认员的价值不在盖章，在改判**：B 路焦点抢夺触发链被修正（作曲行不成立→设置面板实锤）、IME 修复机理被纠正（send-keys 不走键表，补接线无效）、F5 窗口太窄被定性为相反失败向、D 路 61 探针前提被推翻（demo 域死键）但结论在真机域成立——四路全部出现过「事实对、机理/链路错」的修正。
3. **修「确认过的问题」也要红绿对照**：spec 63 钉着「inPane 主项禁用」旧行为一测就红——改交互契约时同一轮必须扫它钉过的断言（特异度教训的 spec 版）。
4. **demo 域探针的可用面比文档窄**：__TAURI_INTERNALS__（仅 Tauri）、fixture 需要 sid、预置会话自带 tmux——定点脚本三次修正才跑通，先写最小诊断 dump（masks/sessions/tabs）再下断言，比猜选择器快。

## 四、立案（未修）

- 墙无前缀语义（B2 降级）：C-b+键在墙里不武装 tmux 前缀——设计语义缺口，hint 已指「进格子」；如要支持需前端做墙内前缀翻译，待拍板。
- 已知立案维持：tmux_attached 不复核（C-b d 脱离后 exec 静默进专窗）；live 前台程序首次 attach 明文注入；窄窗 <300px 死空间；WebGL 光标残尾（真机待验）等——见各轮台账。
