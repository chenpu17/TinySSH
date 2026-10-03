# 细节控视觉回归走查（T38 模拟真人验证 · polish）

- 走查时间：2026-10-03
- 环境：demo UI http://localhost:5183，Chromium headless，视口 1280x800
- 范围：T37 精致化成果回归 + T38 新增「任务目标」区，深色/浅色双主题
- 截图证据：`/tmp/pv_polish_*.png`（01–21）
- 走查脚本：`ui/pv_polish_walkthrough.cjs`、`ui/pv_polish_light.cjs`、`ui/pv_polish_light2.cjs`

## 走查结论

**总体 PASS**——T38「任务目标」新区与 T37 精致化体系融合良好，未发现视觉回归；深色/浅色双主题均无硬编码色事故。1 项疑问（skeleton 未能捕获）、2 条轻微瑕疵/建议，见末尾问题清单。

## 逐项核验

### 1. 初始列表态：hover 浮现 / 非 hover 干净 / skeleton —— PASS（skeleton 项为疑问）

- 非 hover：主机行干净，无任何操作按钮残留（证据 `pv_polish_02_list_initial.png`、`04_list_unhover.png`）。
- hover「本机」行：浮 panel3 背景 + 右侧操作组（编辑/删除/连接）浮现，层级清晰（证据 `03_list_hover.png`）；移开后恢复干净（`04`）。
- skeleton：demo 加载过快，`domcontentloaded` 时刻与加载完成后 `.skeleton` 计数均为 0，**未能捕获 skeleton 帧**；加载完成后确认无骨架残留。**结论：无回归证据，但本轮无法实证 skeleton 首载表现，存疑。**

### 2. 会话三栏 + 任务目标区层级 —— PASS

- 三栏实测宽度 `[220, 780, 280]`（`.layout > .col` 盒测量），与规格 220/弹性/280 完全一致。
- 右栏「任务目标」区标题样式（小号 dim 分组标题）与「传输」「现场简报」一致；区间距均匀；输入框白底（浅色）/panel2 系深色底，与底部命令输入框风格统一（证据 `05_session_dark.png`、`07_goal_placeholder.png`、`17_light_goal.png`）。
- 任务目标区位置在「传输」与「现场简报」之间，阅读动线自然。

### 3. 任务目标输入框：聚焦 / placeholder / 按钮层级 —— PASS

- 聚焦态：accent 色描边清晰可见（证据 `06_goal_focus_filled.png`、`08`）。
- placeholder 对比度（程序化实测 `getComputedStyle(::placeholder)` vs 输入框底色）：
  - 深色：`rgb(154,170,184)` on `rgb(28,36,51)`，**对比度 6.53:1**（> WCAG AA 4.5）
  - 浅色：`rgb(77,91,104)` on `rgb(255,255,255)`，**对比度 6.97:1**
  - 不存在「太浅看不见」问题（证据 `07_goal_placeholder.png`）。
- 按钮层级：「保存」实心 accent 主按钮，「清除」ghost 描边次按钮，层级拉开明确；仅在有已保存目标时出现「清除」（证据 `08_goal_buttons.png` 仅保存 / `10_toast_stacked.png` 保存+清除同框）。

### 4. Toast：接管 + 目标保存堆叠 + 自动消失 —— PASS

- 点「接管」：无确认弹窗，立即生效；顶部徽标由 amber「● Agent 控制中」翻转为 accent「● 我控制中」，「接管/接管并停止任务」收起为 ghost「交还 Agent」，层级符合 T37 补遗设计（证据 `09`）。
- 目标保存后同屏 3 条 toast（任务目标已清除 / 已接管 / 任务目标已更新）右下堆叠，未超过 4 条上限（证据 `10_toast_stacked.png`）。
- 自动消失实测：保存后 toast 计数 3 → 3.2s 后计数 0，消退干净无残留（证据 `11_toast_gone.png`）。
- 浅色主题 toast 白底深色字、左色条正常（证据 `19_light_toast.png`）。

### 5. 浅色主题适配 —— PASS

- 入口存在：顶栏「显示设置」（滑杆图标 aria-label）→ 弹层内 深色(默认)/浅色/Solarized 深色/Solarized 浅色 四格（证据 `13_settings_pop.png`）。
- 切浅色后 `data-chrome="light"` 生效：三栏背景、审批卡、任务目标区、现场简报 fact 块、Timeline、Notice Bar、toast 全部适配，**未发现白底白字类硬编码色事故**（证据 `16`–`21`）。
- 浅色下 placeholder 对比度 6.97:1（见第 3 项）。

### 6. 操作记录 Timeline —— PASS

- 竖轨 + actor 圆点对齐良好，人类（我）amber 圆点 / Agent 青色圆点区分清晰（证据 `12_timeline.png`、浅色 `18`）。
- 新增「我 更新任务目标」条目样式与其他条目完全一致：时间戳+会话 mono chip 一行、actor+动作一行、目标内容详情行截断省略号；实测出现 2 条（保存+清除各留痕），与审计预期一致。

### 7. 其他视觉瑕疵扫描 —— 见问题清单

未发现对齐/溢出/遮挡类硬伤。会话名「stagin…」截断为定宽侧栏预期行为；审批卡长命令折行正常。

## 给开发的问题清单

1. **（轻微）Toast 存续期遮挡右栏内容**：3 条 toast 堆叠时覆盖「现场简报」底部 fact 块与「操作记录」顶部（证据 `10`），虽 2.6s 自消可接受，但若用户正阅读简报会被打断——是否考虑 toast 出现时右栏内容自动避让，或将 toast 锚定在中栏右下？
2. **（疑问）浅色下终端区提示 pill 疑似半透明帧**：`21_light_list_hover.png` 中「会话已接入——点击终端区直接打字…」pill 呈明显褪淡状态（对比 `20` 同位置正常）。疑似 hover 渐隐过渡中间帧或浅色下该 pill 透明度规则异常，建议人工复核浅色主题该组件的 opacity/transition 规则。
3. **（验证缺口）skeleton 首载占位未能实证**：demo 数据加载过快，脚本两帧均未捕获 `.skeleton`。建议后续用 network throttle 或延迟 mock 验证首载骨架真实表现。
4. **（建议）Timeline 种子数据时间戳跨小时**（19:26 与 22:01 混排，证据 `12`）为演示种子数据所致、非 UI bug，但走查/演示时易引起困惑，可考虑种子时间戳统一化。
