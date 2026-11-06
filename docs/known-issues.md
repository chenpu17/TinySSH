# 已知问题 / 待排期

> 记录用户反馈与开发中发现的非阻塞问题。修复后把「状态」改为已修复，并补验证方式。
> 最后更新：2026-11-06

| ID | 状态 | 现象 | 初步判断 | 下一步 |
|---|---|---|---|---|
| KI-001 | 已修复，待真机验证 | 触摸板移动会在终端里灌入 `35;x;yM` 一类文本 | 远端应用开启 xterm any-motion（1003）后未复位；无按键移动被编码成 SGR 报告，经 `term.onData` 原样进 PTY 并被 shell 回显 | 已在 `ui/src/terminal/mouse-guard.ts` 丢弃无按键移动报告（保留点击/拖动/滚轮），主终端与 tmux 面板均接入；待 Windows 触摸板复测 |
| KI-002 | 已修复，待真机验证 | 会话已重连成功，标签状态仍显示小红球 | 重连成功进入 `Reconfirming`，但只有 `pwd/ps/which` 等白名单命令才会转 `Connected`；普通 `ls/cd` 永远不清红点，且转 `Connected` 时漏发状态事件。首版修复只覆盖命令框 `exec`，终端直接键入走 `send_keys` 仍不会退出 | 人类在终端回车提交命令（`send_keys`）、tmux 面板/墙视图提交、或命令框 `exec` 成功均算核实完成，统一走 `complete_reconfirm` 并补发 `Connected` 事件；`Reconfirming` 改为琥珀色「已重连 · 待核实」。demo 域已镜像同一状态机。回归：`human_terminal_enter_finishes_reconfirming_with_event`、`command_submit_only_on_enter_or_newline`、`68-reconfirm-sendkeys`。待真机验证：重连后键入 `ls` 回车，标签应即时变绿 |
| KI-003 | 已修复，待真机验证 | 创建 tmux 会话时名称不能使用中文 | 不是 tmux 限制；应用侧 `tmux_session_name_ok` 只允许 ASCII 字母/数字/下划线 | 放宽为 Unicode 字母/数字/中文 + `_`/`-`，保留首字符与 64 字节限制；demo 与输入提示同步。回归覆盖中文名的预检/创建命令形状与真实 `sh` 单引号还原。待验证：创建「工作」「项目-1」并 attach |
| KI-004 | 部分改进，待真机确认 | tmux 内上下滚动不顺滑，尤其 Claude 输出很多消息后 | Windows 精确触摸板给像素级连续小 delta，xterm 100ms 补间每个事件重启，落后手指；长 scrollback 会放大。tmux attach 处于 alternate screen，wheel 走鼠标报告/方向键，`smoothScrollDuration` 不参与——当前改动主要改善普通终端 scrollback | 新增 `terminal/scroll.ts`：触摸板小 delta 切 0（1:1 直跟），经典滚轮保留补间；主终端与 tmux 面板均接入。回归：`67-adaptive-scroll` 覆盖档位切换与卸载。若真机确认卡顿发生在 tmux copy-mode，下一步 profile copy-mode 重绘与 wheel 事件频率，单独设计合帧/节流 |
| KI-005 | 已修复，待真机验证 | 专注模式下 tmux 管理（折叠）入口不可用；标签列表/新建连接/退出专注文字钮在专注态冗余 | 专注模式用 `.focus-mode .session-toolbar { display:none }` 整条隐藏会话工具栏，tmux 快接钮随之消失 | 抽出 `components/tmux-quick.tsx`，专注态在标签条渲染同一快接菜单；隐藏 `.tabbar-admin`（标签列表/新建/快速连接）与「退出专注」文字钮，保留右上角专注图标/F11。回归：`69-focus-tmux`。待验证：F11 进专注后点 tmux 快接可切换/新建会话 |

## 备注

- KI-001 的取舍：确实需要鼠标 hover 的 TUI 会失去 hover（点击/拖动/滚轮不受影响）；若后续有明确需求，再加「允许 any-motion」开关。残余：过滤发生在 `onData`，xterm 已先执行 `scrollOnUserInput`/清选区；远端 1003 残留时触摸板仍可能把画面拉回底部或清掉选区，彻底修需在 `mousemove` 捕获阶段截断，待真机确认影响面。
- KI-003 的输入框 `maxLength=64` 按 UTF-16 字符计数，后端按 UTF-8 字节（64 字节）校验；22 个汉字会通过输入框但提交被拒，提示文案已说明中文开头规则，字节上限仍由提交校验兜底。
- 新问题请先记录现象、复现步骤、平台/版本，再排期；不要直接改行为。
