# 子窗口卡片化 + macOS 字体清晰度（2026-11-07）

## 背景

用户反馈两点：

1. macOS 上文字总觉得有点模糊，不确定是否错觉。
2. 分屏子窗口、tmux 面板子窗口能否加圆角，并在两格之间留一点空隙，视觉更舒服。

## 子窗口卡片化

统一「视图」语言继续延伸：标签内所有可见子窗口都是卡片。

- 分屏窗格（`.term-session.pane-*`）：3px 透明边框 + 10px 圆角。
- tmux 面板主视图（`#term.has-tmux-panes .term-session.active`）：同一套边框/圆角。
- tmux 格子（`.tmux-cell`）：同一套边框/圆角；标题栏上圆角 7px、正文下圆角 7px。
- tmux 大屏（`.tw-cell`）：圆角 10px + 裁剪（大屏网格本身已有 8px gap）。

透明边框不改变外框几何：分屏比例、布局树写入的 left/top/right/bottom、拖拽命中、
回归测试读到的 boundingRect 都与原来一致；边框区透出 `#term` 底色形成约 6px 的
呼吸缝。内容盒由 border-box 自动内缩，`fitDimsOf` 使用 `clientWidth`（已排除
border）量 PTY 列行，终端尺寸仍与可视区严格一致。

只靠透明边框不够：终端底色与 `#term` 底色同值时（浅色主题实测同为
`rgb(223,226,233)`），缝看不见。因此在内容盒边缘补 1px `--border` 实线
（`::before`，真 border，墨水屏铲阴影不受影响）；tmux 面板分隔条改为常显
1px `--border`（悬停/拖动再亮 accent）。这样视觉上是「卡片边 + 6px 缝 +
分隔线」，而不是一条单线。

焦点框同步内圆角 7px，避免直角框压在圆角卡片上。

## macOS 字体清晰度

无法在 Windows 开发机复现 macOS 观感，按低风险、可解释的方向处理：

- macOS 原生壳不再强制 `-webkit-font-smoothing: antialiased`（body 的全局规则保留
  给 Windows/Linux）。该属性在 macOS 上会把 14px/430 的正文压细、边缘发虚；
  回到系统默认更实。终端 WebGL 画布不受影响；DOM 渲染器（开启连字时）随 body
  回到系统平滑。
- 终端字体图集刷新覆盖到 tmux 格子：`fonts.ready` 与 `loadingdone`（300ms 合帧）
  时对主终端和全部格子回写字体栈并重绘，避免 Maple / CJK 兜底分片晚加载时
  「首见字形以回退字体入图集」造成的永久发虚。
- 预取 JetBrains Mono Term（设置里的第二内置终端字体），切换字体首帧即正确。

## 回归

- `30-split`：新增分屏子窗口 3px 透明边框 / 10px 圆角 / padding-box 断言。
- `75-main-view-controls`：新增主视图与 tmux 格子卡片化、标题/正文内圆角断言。
- 定向回归：30 / 63 / 65 / 75 全绿；全量 UI **67 specs / 1284 checks** 全绿。
- Rust 工作区本轮无代码改动（仅版本号与 UI/工作流）。

## 边界

- 圆角/空隙是固定视觉规格，不做用户可调项；分屏与面板共用 3px 边框。
- macOS 字体平滑只对原生壳生效；浏览器 demo 不添加 `native-mac` 类。
- 若 macOS 仍觉得模糊，需要区分 UI 文字与终端文字，并确认显示器是否为
  Retina / 系统缩放档位；这两类原因不在应用侧可完全消除。
