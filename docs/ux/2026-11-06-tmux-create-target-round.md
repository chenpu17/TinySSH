# 新建 tmux 会话：目标选择（接入主视图 / 直接开进面板）轮（2026-11-06）

用户原话：「我们能在选择 tmux 的折叠选择按钮上支持，创建新的 tmux 会话功能吗？」核实结论：**新建能力 2026-11-03 那轮就有了**（快接菜单顶部「＋ 新建 tmux 会话…」→ 作曲行 → 远端 `new-session -d`，随 v0.11.0 发布，spec 63 O 段钉死）。用户随后选定的是增强：**建好可选落位**。

## 一、为什么这不是锦上添花，是补断路

旧链路建好即 `pickTmuxSession`（attach 主视图）。而「＋面板」对主视图中的会话是**禁用**的——`addWhy = isMain ? "该会话正显示在主视图"`（同一会话不做两路视图的不变式）；面板也没有「把主视图会话收进格子」的反向动作（只有 `promotePaneToMain` 的反方向）。结果：**新建的会话永远进不了面板**，除非先切走主视图（界面上并无「脱离主视图」钮）。所以「开进面板」补的是一条真实不可达路径。

## 二、定案

作曲行保持一行输入 + 两枚单选胶囊（第二行）：`接入主视图`（默认=旧行为）/ `开进面板`。

- 鼠标点选不夺输入框焦点（`onMouseDown` 拦默认），选完仍可直接 Enter 提交。
- 禁用口径与「＋面板」同源：分屏互斥 → `分屏模式下不可并入面板——请先退出分屏`；格数到顶 → `面板最多 {0} 个窗格`，写进 title。
- 提交前先过防呆（分屏/格满）**再建**：建出孤儿会话（面板又进不去）比就地报错更糟。
- 面板目标成功走 `openTmuxPaneCore` 既有链（自带「已并入面板」toast、聚焦新格、清单刷新、错误 toast）；主视图目标保持原链路不变。
- 顺带补作曲行缺的 **IME 守卫**（`isComposing || keyCode 229` 直接 return）——此前组合期按 Enter 会提前提交再报「非法名」。

## 三、实现面

- **session-toolbar**：`tmuxCreateTarget` / `onTmuxCreateTarget` 两 prop；目标 radiogroup（`role=radio` + `aria-checked`，`data-testid=tmux-create-target-{main,panel}`）；提交钮 title 随目标切换；入口 title 补「建好可接入主视图或直接开进面板」。
- **App**：`tmuxCreateTarget` state（默认 main，菜单关闭即复位）；`submitTmuxCreate` 面板分支（先防呆后建，成功 `setTmuxMenu(false)` + `openTmuxPaneCore(s, name, false)`）。
- **styles**：`.tmux-create-target` 两枚等宽胶囊（26px 高、静息细描边 dim 字，选中 accent 描边 + accent-soft 底，沿用 `.ts-open` 语汇）。
- **i18n**：新键 7 条 + 入口 title 改写。
- **后端零改动**：`tmux_session_create` 与 `tmux_pane_open` 都已存在，demo 均已镜像。

## 四、验证

- tsc 0。
- spec 63 **134/134**（新段 P 六项：默认主视图选中 / 选「开进面板」后输入框仍聚焦 / IME 组合期 Enter 不提交 / 面板目标创建落格且主视图不被抢 / 清单标「面板中」/ 连建到 5 格后「开进面板」禁用且原因在 title）。spec 内的现场清理（`trimPanes`）是必需前提——本段之前面板已有格子，段内要从 ≤2 格起步才能连建 3 格到顶。
- 全套回归见交付记录。

## 五、教训

1. **「已有功能」也要问用户要什么**：功能存在不等于满足需求——用户看到的断点（建好进不了面板）在实现层是防呆不变式的另一面。
2. **spec 断言要连格数一起控**：胶囊禁用按 React 侧 `current.panes` 判，DOM 格子随 eof 立收、清单要等 3s 轮询——先 `poll` 到可用再点，否则 30s click 超时；且起步格数必须为「上限 − 本段要建的格数」。
