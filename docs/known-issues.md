# 已知问题 / 待排期

> 记录用户反馈与开发中发现的非阻塞问题。修复后把「状态」改为已修复，并补验证方式。
> 最后更新：2026-11-07

| ID | 状态 | 现象 | 初步判断 | 下一步 |
|---|---|---|---|---|
| KI-001 | 已修复，待真机验证 | 触摸板移动/点击/滚轮会在终端里灌入 `35;x;yM`、`0;x;yM` 一类文本，滚轮也可能不再滚 scrollback | 远端应用开启 xterm any-motion（1003）/SGR（1006）后未复位（TUI 崩溃、被 kill，或只发 1049l 不发 1003l）；鼠标报文经 `term.onData` 进 PTY 被 shell 回显 | 双层修复：`terminal/mouse-guard.ts` 丢弃无按键移动报告；`terminal/mouse-mode-guard.ts` 在 DECRST 47/1047/1049（离开备用屏）与 OSC 133;A/D（提示符/命令结束）时本地关闭残留协议，主终端与 tmux 格子均接入；终端右键新增「重置鼠标上报」手动兜底。回归：`70-mouse-guard`、`72-mouse-mode-reset`。待 macOS/Windows 真机复测：TUI 退出后滚轮恢复 scrollback、提示符不再出现 `35;...M` |
| KI-002 | 已修复，待真机验证 | 会话已重连成功，标签状态仍显示小红球 | 重连成功进入 `Reconfirming`，但只有 `pwd/ps/which` 等白名单命令才会转 `Connected`；普通 `ls/cd` 永远不清红点，且转 `Connected` 时漏发状态事件。首版修复只覆盖命令框 `exec`，终端直接键入走 `send_keys` 仍不会退出 | 人类在终端回车提交命令（`send_keys`）、tmux 面板/墙视图提交、或命令框 `exec` 成功均算核实完成，统一走 `complete_reconfirm` 并补发 `Connected` 事件；`Reconfirming` 改为琥珀色「已重连 · 待核实」。demo 域已镜像同一状态机。回归：`human_terminal_enter_finishes_reconfirming_with_event`、`command_submit_only_on_enter_or_newline`、`68-reconfirm-sendkeys`。待真机验证：重连后键入 `ls` 回车，标签应即时变绿 |
| KI-003 | 已修复，待真机验证 | 创建 tmux 会话时名称不能使用中文 | 不是 tmux 限制；应用侧 `tmux_session_name_ok` 只允许 ASCII 字母/数字/下划线 | 放宽为 Unicode 字母/数字/中文 + `_`/`-`，保留首字符与 64 字节限制；demo 与输入提示同步。回归覆盖中文名的预检/创建命令形状与真实 `sh` 单引号还原。待验证：创建「工作」「项目-1」并 attach |
| KI-004 | 部分改进，待真机确认 | tmux 内上下滚动不顺滑，尤其 Claude 输出很多消息后 | Windows 精确触摸板给像素级连续小 delta，xterm 100ms 补间每个事件重启，落后手指；长 scrollback 会放大。tmux attach 处于 alternate screen，wheel 走鼠标报告/方向键，`smoothScrollDuration` 不参与——当前改动主要改善普通终端 scrollback | 新增 `terminal/scroll.ts`：触摸板小 delta 切 0（1:1 直跟），经典滚轮保留补间；主终端与 tmux 面板均接入。回归：`67-adaptive-scroll` 覆盖档位切换与卸载。若真机确认卡顿发生在 tmux copy-mode，下一步 profile copy-mode 重绘与 wheel 事件频率，单独设计合帧/节流 |
| KI-005 | 已修复，待真机验证 | 专注模式下 tmux 管理（折叠）入口不可用；标签列表/新建连接/退出专注文字钮在专注态冗余 | 专注模式用 `.focus-mode .session-toolbar { display:none }` 整条隐藏会话工具栏，tmux 快接钮随之消失 | 抽出 `components/tmux-quick.tsx`，专注态在标签条渲染同一快接菜单；隐藏 `.tabbar-admin`（标签列表/新建/快速连接）与「退出专注」文字钮，保留右上角专注图标/F11。回归：`69-focus-tmux`。待验证：F11 进专注后点 tmux 快接可切换/新建会话 |
| KI-006 | 已修复，待 macOS 真机验证 | macOS 中文输入法「中文标点」模式下，`Shift+;` 的「：」与 `Shift+/` 的「？」按一次不出现，要连按才出现；其他全角标点可能同样 | 非输入法/系统问题，是 xterm.js 5.5.0 的 `_keyDownSeen` 去重门：修饰键 Shift 的 keydown 先武装门，Safari/WKWebView 的 IME 直接提交 `insertText` 早于字符 keydown，首击被误去重；字符 keyup 清门后第二次才通过。上游已修（xtermjs/xterm.js#6200），但 6.0.0 尚未包含 | `terminal/xterm-ime-gate.ts` 在 core 原型上包 `_keyDown`：修饰键单独 keydown 不武装也不清零（保持组合态去重），主终端与 tmux 格子均接入。回归：`71-ime-punct-gate`（伪 core 语义 + 真实 xterm 的 Shift/insertText 序列）。待验证：macOS Apple 拼音/注音下「：」「？」「，」「。」等一次输入即出；若搜狗出现 ASCII 标点而非全角，则是另一条上游 #6294（keydown 提前发 ASCII、keypress 才带全角）待合入 |
| KI-007 | 已修复，待真机验证 | 专注模式下小工具栏缺少「从已保存主机新建连接」与「文件」两个高频入口：`.tabbar-admin` 与 `.session-toolbar` 都被隐藏，只能退出专注或走 ⌘K | 专注模式的可达层缺少连接选择器；文件虽有右缘 rail，但 rail 在专注态也整体隐藏 | 专注标签条右侧新增紧凑「连接」菜单（列出已保存主机，选中即 `createSession`；打开时 `zenPin` 钉住标签条，Esc/外点关闭）与文件面板钮（`aria-pressed` 跟随右栏）。回归：`69-focus-tmux`（文件面板打开、主机菜单新建标签）。待验证：真机 F11 后选主机建连、开关文件面板 |
| KI-008 | 已修复，待真机验证 | 一个标签里有多个 tmux 子窗口时，点选非第一个格子后切到别的标签再切回，焦点总被送回主视图（第一个） | `focusSession` 每次激活标签都无条件 `entry.term.focus()`；格子焦点只在 DOM 里，没有按标签记忆 | 新增 `paneLastFocusRef`（sid → `main`/`${sid}:${paneId}`）：xterm `focusin` 记录，切标签时若格子仍可见且存活则恢复，点主视图/关格/关会话回落主视图；`note_terminal` 同步带 `paneId`。回归：`73-focus-pane-memory`（切回恢复格子、点主视图后记住主视图） |
| KI-009 | 已修复，待真机验证 | 浅色主题 + tmux 默认配色对比度不足：tmux 默认 `status-style bg=green,fg=black`、`message/mode/copy-mode` 等也以 `fg=black` 压在彩色底上；浅色色板的 ANSI black 与彩色都为深色，实测约 1.04–1.07:1，状态栏/复制模式高亮几乎不可读 | tmux 默认主题假设深色终端（黑底亮彩）；应用浅色色板为满足正文对浅底 ≥4.5:1 必须同时压暗 black 与彩色，palette 内无法同时满足两向对比。深色色板该组合同样只有 3.95–4.54:1（Nord 最低），多数低于 AA | xterm 全终端（主终端 + tmux 格子）设 `minimumContrastRatio=4.5`：按单元格实际前景/背景动态修正，不写远端 tmux 配置、无恢复残留，手动起的 tmux/htop/dialog 同覆盖。另修自绘焦点格标题（`--accent-text` + 12% accent 底，32 态 ≥4.5）与死格正文（去掉 `opacity:.45`，只留 grayscale）。回归：`74-terminal-contrast`。设计与可选 tmux 配置片段见 `docs/ux/2026-11-07-theme-tmux-contrast.md`。待验证：浅色主题下 tmux 状态栏/复制模式高亮、htop/dialog 彩底黑字可读；会话大屏 ANSI→HTML 直出不在 xterm 兜底范围（普通彩字由调色板门保证） |

## 备注

- KI-001 的取舍：确实需要鼠标 hover 的 TUI 会失去 hover（点击/拖动/滚轮不受影响）；若后续有明确需求，再加「允许 any-motion」开关。残余：过滤发生在 `onData`，xterm 已先执行 `scrollOnUserInput`/清选区；本轮起退出备用屏/提示符会关掉残留协议，正常屏不再有报文，剩余风险仅限「运行中的普通屏 TUI + 无 shell 集成」——可用右键「重置鼠标上报」手动恢复。
- 备用屏（tmux/vim/less 等）内滚轮被 xterm 转成 Up/Down 是 alt-screen 语义（应用没有开启鼠标上报时用于应用内滚动）；在 tmux 提示符下它会表现为 shell 历史。要让 tmux 自己处理滚轮/复制模式，需远端 `set -g mouse on`。本修复只处理「TUI 退出后协议残留」造成的乱码与滚轮失效，不改变运行中 alt-screen 应用的滚轮语义。
- KI-003 的输入框 `maxLength=64` 按 UTF-16 字符计数，后端按 UTF-8 字节（64 字节）校验；22 个汉字会通过输入框但提交被拒，提示文案已说明中文开头规则，字节上限仍由提交校验兜底。
- 新问题请先记录现象、复现步骤、平台/版本，再排期；不要直接改行为。
