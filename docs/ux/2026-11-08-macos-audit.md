# macOS 使用问题审计与修复（2026-11-08）

## 反馈

用户（macOS）：

1. 触摸板行为偶尔会变成某种「编码输入」（终端里冒出 `35;x;yM`、`ESC[M…` 一类文本）。
2. 输入符号时首击偶发丢失：`Shift+;` 的「：」、`Shift+/` 的「？」要连按两次才出，其他全角标点也有。
3. 专注模式（窗口没真正全屏）下，左上角红黄绿系统钮压住标签条/标签文字（附截图）。
4. 「也许 Windows 也有问题，只是用得少」——按跨平台同类风险一并审。

## 1. 触摸板「编码输入」

根因两层：

- 远端应用开启 any-motion（`1003`）后未复位（TUI 崩溃/被 kill、只发 `1049l` 不发 `1003l`），
  无按键移动报告经 `term.onData` 进 PTY 被 shell 回显。
- xterm 只实现 SGR（`1006`）与 X10 编码，不支持 `1005/1015`；只开 `1003` 未开 `1006`
  时用 **X10**（`ESC[M` + 3 字节），旧过滤只认 SGR，会整段漏过去。

修复：

- `ui/src/terminal/mouse-guard.ts`：SGR 与 X10 双编码过滤，只丢「无按键移动」
  （motion 位且无按钮、非滚轮、bit7 扩展键不误判），点击/拖动/滚轮原样保留。
- `ui/src/App.tsx`：正常屏收到被过滤报文时 `resetMouseReporting(term)`；主终端与
  tmux 格子同一处理；右键菜单保留「重置鼠标上报」手动兜底。

取舍：确实需要 hover 的 TUI 会失去 hover；运行中的备用屏 TUI 滚轮语义不变。

## 2. 输入法全角标点首击丢失

根因（xterm.js 5.5.0 私有去重门）：

- `_keyDownSeen` 在任意字符 keydown 即武装，`_inputEvent` 用它丢弃「keydown 已发过」的
  `insertText`。macOS IME 直接提交全角标点时，修饰键 keydown 先到，`input` 早于字符
  keydown → 首击被误去重；keyup 清门后第二次才通过。
- 搜狗等第三方 IME：`keydown.key` 是半角标点/数字，全角在 `keypress.charCode`。
- WKWebView 与部分 IME 组合下 `keypress` 可能不派发或 `charCode=0`。

修复（`ui/src/terminal/xterm-ime-gate.ts`，主终端与 tmux 格子均接入）：

- 修饰键单独 keydown 不武装也不清零（同上游 #6200）。
- 组合键 keydown 且 IME 已先写入 textarea 时放行 `insertText`（CompositionHelper 的
  diff 会是空操作）；textarea 后写入仍交给 CompositionHelper，避免重复。
- macOS 把 ASCII 标点/数字延迟到 `keypress.charCode`（同上游 #6294 方向），不再先发半角。
- `keypress` 缺席时的 `input` 兜底；`input` 已送达后迟到的 `keypress` 吞掉，保证
  「按一次只出一个」。升级到含 #6200 的 xterm 后可整体删除本模块。

## 3. 专注模式非全屏：红绿灯压标签

根因：专注 chrome（`ui.focus=1`）与系统全屏是两份状态。启动恢复
`setFullscreen(true).catch(() => {})` 吞掉失败；用户用绿灯/`Ctrl⌘F`/Esc 退出系统全屏后
`focusMode` 仍为 true——标题区已藏，系统红绿灯仍悬浮在左上。

修复（`ui/src/App.tsx` + `ui/src/styles.css`）：

- 跟踪 `isFullscreen`（启动探测 + `onResized` 300ms 防抖）。系统全屏丢失且无近 2s
  切换意图时，自动退出专注 chrome（不再反向推窗口回全屏）。
- 启动恢复 700ms 后复核：未进全屏则回滚 `setFocusMode(false)` + `ui.focus=0` 并提示。
- 过渡态 `.focus-mode.focus-windowed` 给标签行留 84px 红绿灯安全区（兜底，不停留）。
- capability 增加 `core:window:allow-is-fullscreen`。

语义定为「专注 = 全屏」；Windows/Linux 没有红绿灯，但同一不变量成立，代码一并生效。

## 其他审计发现（记录，未改行为）

- **`⌘Q` 可能绕过退出确认**：退出确认只挂 `WindowEvent::CloseRequested`（红钮/Alt+F4）；
  原生菜单的 `PredefinedMenuItem::quit` 走 NSApp 终止/`RunEvent::ExitRequested`，
  当前未注册该事件。真机确认后按 KI-011 方案补拦截，不在本轮直接改。

## 回归

- `70-mouse-guard`：SGR + X10 的移动/点击/拖动/滚轮/扩展键/混合文本。
- `71-ime-punct-gate`：伪 core 语义 + 真实 xterm 的 Shift/insertText、229 先到/后到、
  搜狗 keypress 全角、无 keypress 的 input 兜底、迟到 keypress 去重。
- `69-focus-tmux`：专注态 84px 安全区。
- `63-tmux-panel`：键位豁免探针改为仅 Win/Linux 断言——mac 主修饰键是 ⌘，默认表没有
  Ctrl 组合，`Ctrl+Shift+B` 本就该编成 `\x02` 直达 shell/tmux，按 Win 语义断言会把
  平台差异误报成回归（本机 macOS 全套跑出的唯一红灯即此，非产品回归）。

本机 macOS 全套：1285/1286 → 修 spec 平台断言后单跑 63 为 133/133。

## 真机待验

- 触摸板：退出 htop/vim 等 TUI 后滚轮恢复 scrollback，提示符不再出现 `35;...M`/`ESC[M`。
- Apple 拼音/注音 + 搜狗：`：？，。` 一次输入即出，无半角、无重复。
- 专注：F11 进入后点绿灯/`Ctrl⌘F` 退出，应自动回到带工具栏的窗口态，红绿灯不压标签；
  冷启动全屏不可用时应回滚并提示。
