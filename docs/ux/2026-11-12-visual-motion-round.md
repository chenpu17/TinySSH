# 视觉品质轮：动效词汇 / 欢迎页入场 / 工具卡状态推进 / 曲线面积填充（2026-11-12）

用户原话：「你对整个软件的视觉品质提升有什么想法吗？」→「你来主导规划视觉效果优化与落地」。

## 一、诊断（先读代码再开方）

底子已经扎实：四级表面 token + color-mix 派生、34 态 WCAG 门、Inter+MiSans 双变量字体、
tabular-nums、统一描边图标、14 处 reduced-motion 守卫。剩余差距不在「配色/字体」而在**时间维度**：

| 现象 | 机理（实测代码） |
|---|---|
| 面板开合是瞬间跳变 | hostbar/agentbar/task-panel 条件挂载（App.tsx），无入场动画；终端布局一步到位 |
| 浮层只有纯透明度入场 | T32 决策「浮层统一 120ms 透明度、不改 transform」——对菜单/对话框正确，但命令面板这类键盘旗舰入口也一并被压平 |
| Agent 消息/工具卡/审批卡凭空出现 | `.msg-row`/`.tool-card`/`.collab-approvals .card` 无入场；工具卡 pending→running→ok/err 描边瞬间跳色 |
| 欢迎页整卡瞬现 | 品牌 mark/步骤/行动钮已有精致静态样式，但无入场编排 |
| 监控曲线是纯描边线 | Spark/Spark2 只有 polyline，无面积填充，仪表盘少一档仪器纵深 |

**明确不做**：终端渲染（WebView2 字形回归刚治过、term-core 唯一真源）；主题切换全局过渡
（已有 `.theme-switching` 320ms 脉冲，够用）；大面积模糊/重阴影（仪表性格 + #22 性能治理）；
面板宽度动画（会触发 xterm 连续 resize，与 #22 冲突）。

## 二、改法

1. **动效 token**（`:root`）：`--motion-in: 0.16s`、`--ease-out: cubic-bezier(0.2,0.8,0.2,1)`。
   只动 transform/opacity（合成器层，不触发重排）；eink 与系统「减少动态效果」的全局
   `!important` 门自动覆盖新动画，无需逐类补丁。
2. **面板入场**：`.hostbar`/`.agentbar` 左入（淡入 + translateX(-12px) 落位），`.task-panel`
   右入对称。动画随条件挂载播一次；拖宽/切面板内容不重挂载、不重播；动画结束 transform
   归 none，不留永久 fixed 包含块。全屏视图（`.mon-dash`/`.tmux-wall`）复用纯透明度入场。
3. **命令面板**：`.palette` 专属 `palette-in`（淡入 + 5px 下落 settle，140ms），同特异度靠后
   覆写通用 surface-enter；其余浮层维持 T32 纯透明度决策不动。
4. **卡片/消息入场**：`.msg-row`/`.tool-card`/`.collab-approvals .card` 统一 `rise-in`
   （淡入 + 6px 上升）。React 按 key 复用 DOM——流式更新、审批倒计时重渲染不重播。
5. **工具卡状态推进**：`.tool-card` 加 `transition: border-color .2s, opacity .2s`，
   pending→running→ok/err/denied 渐变而非跳色。
6. **欢迎页入场编排**：`.welcome-box > *` 依次 rise-in（0/50/100/150ms 延迟，backwards 填充），
   总时长 ≤390ms。只动直系子元素，卡片本体与布局不变。
7. **曲线面积填充**：Spark/Spark2 在折线下方加 polygon——与折线共用同一串采样点、底边闭合，
   零额外采样开销；填充色 `.mon-spark .area` = accent 12%（网络 ↑ 线 `.area.a2` = ok 10%），
   color-mix 随 34 态主题自动派生。

## 三、验证

- `npm run build`（tsc strict + vite）✅ 通过（6.67s）。
- `cargo test -p session-api --tests`✅ 全绿：version_consistency / command_parity / c3_contract / wire 格式。
  四源版本号同升 **0.12.13**（根 Cargo.toml `[workspace.package]` / tauri.conf.json / ui package.json /
  package-lock.json），Cargo.lock 14 个 workspace 成员随之更新（agent-host 自有版本 0.1.0 不动）。
- 规格静态核对：79-welcome-layout 重载后等 1100ms 再测 rect（入场 ≤390ms 已结束，transform 归 none）；
  03-panels 测 `.task-panel` **宽度**（translateX 不改宽度）；55-monitor 查 `.mon-spark.cpu polyline`
  点数（polygon 不影响 polyline）；Playwright 点击前自带「包围盒稳定」等待，自动吸收 ≤160ms 入场。
- tpFull 判定走 availW 宽度算术、不读面板 rect——入场 transform 不影响；抓手拖拽读 rect 仅在
  主动拖拽时发生，动画期内至多 12px 单帧偏差、下一事件即自纠。
- dev server（5183）已确认热更新到新 CSS。
- **未跑项（本会话 auto mode 拦 node/浏览器可执行）**：`node test/wcag-themes.mjs`、UI 全套 spec、
  截图目检。tag 触发的 release verify job 覆盖 Rust 门 + `npm run build`，但 WCAG/spec 属 ci.yml
  tier2（PR/手动）不在 tag 链上。本轮未改任何文本/背景色对（新增仅非色彩 token 与装饰性 SVG 填充），
  WCAG 门理论不受影响；建议在可跑环境补 `node test/wcag-themes.mjs` 与全套 spec（先杀 tinyssh-app）目检确认。

## 四、涉及文件

- `ui/src/styles.css`：动效 token、入场动效块、欢迎页编排、`.tool-card` 过渡、`.mon-spark .area`
- `ui/src/components/monitor-view.tsx`：Spark/Spark2 面积 polygon
- 无后端行为变更 → demo 域无需同步；无 command 变更，版本同升 0.12.13 → parity/consistency 门本地已跑通（见上）