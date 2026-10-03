# T37/T38 UI 独立视觉复验报告

- 日期：2026-10-03
- 验证人：独立视觉验证 Agent（未参与 T37/T38 开发，全部数据本轮独立测量）
- 对象：浏览器 demo 模式（`ui/src/demo.ts` shim，语义与真实后端对齐）
- 环境：vite dev server `http://localhost:5183`，Playwright + chromium-headless-shell，视口 1280×800
- 纪律：只验证未改任何产品代码；临时脚本 `ui/recheck_*.cjs`（6 个，保留供复核）；截图 14 张存 `/tmp/recheck_*.png`

## 结论总览

| 组 | 内容 | 结论 |
|---|---|---|
| 1 | 回归复跑（R9 走查 + PV 修复验证） | **PASS**（7/7 + 10/10） |
| 2 | skeleton 首载实证 | **PASS**（4/4，此前验证缺口已补上） |
| 3 | 浅色 attach-hint pill 定性 | **PASS——非缺陷**（褪淡=过渡中间帧，settled 期 opacity 恒 1） |
| 4 | 三栏宽度 + placeholder 对比度 | **PASS**（8/8，对比度 6.5–7.0:1） |
| 5 | 双主题全屏证据 | **PASS**（8 张主证据 + 6 张辅助，全部到位） |
| 6 | 规格抽查（§五/§六） | **PASS**（9/9，1 处规格偏差备注） |

**总计 38 项断言全 PASS，0 FAIL，2 条备注**（§3 定性结论 + §6 一处与规格文案的偏差 + 1 条 `--dim` 辅助文字对比度数据，详见各组）。

---

## §1 回归复跑

脚本原样执行，全部通过，无环境性回归。

**`node t38_goal_walkthrough.cjs`（R9 走查）— 7/7 PASS**

```
ASSERT seed-goal: PASS            ASSERT saved-value: PASS
ASSERT save-toast: PASS           ASSERT cleared: PASS
ASSERT audit-goal_set: PASS       ASSERT clear-btn-gone: PASS
                                  ASSERT clear-audit-count>=2: PASS
```

**`node pv_fix_verify.cjs`（PV 修复验证）— 10/10 PASS**

```
PASS username-placeholder — 例：ops 或 root
PASS charset-select-fullrow — widths=[86,177]
PASS charset-label-hint — …远端编码（老设备中文乱码时选 GBK）
PASS gbk-badge — tags=[2]
PASS gbk-title — ops@192.168.99.9:22↵指纹：…↵编码：GBK（中文 Windows / 老旧设备）
PASS center-click-connects — tabs 3→4
PASS session-card-title — prod-1 · 已连接
PASS goal-autogrow — height 48→84
PASS goal-draft-persist — restored 93 chars
PASS clear-toast-wording — 任务目标已清除，Agent 简报同步移除
```

## §2 skeleton 首载实证（补上此前从未捕到帧的缺口）

**方法**：demo shim 的 `list_hosts` 是内存 Promise（无网络请求可延迟）。对 vite 编译产物 `/src/demo.ts` 做 serve 期路由改写，在 `case "list_hosts"` 后注入 `setTimeout 1100ms`（800–1500ms 区间内，等价真实后端 IPC 往返 + 磁盘读耗时窗）；磁盘产品代码零改动。

| 断言 | 结果 | 数字证据 |
|---|---|---|
| A1 骨架帧捕获 | PASS | 7 帧在场：t=411/641/846/1053/1176/1301/1425ms，`document.querySelectorAll(".skeleton").length=2`；截图 3 张 |
| A2 加载完成撤除 | PASS | t=1547ms 起 skeleton=0，同帧主机卡 4 张上屏 |
| A3 无残留 | PASS | 加载完 1s 后残留 0 |
| B1 reduced-motion 禁用 shimmer | PASS | `emulateMedia({reducedMotion:"reduce"})` 下 computed `animation: none/0s/1`（正常态为 `shimmer/1.4s`） |

**对照组（信息性）**：仅 CDP `Emulation.setCPUThrottlingRate` ×6、不注入延迟——t=223ms 捕到 1 帧（t=399ms 已消失），天然窗口约 176ms。即：skeleton 并非只在人工延迟下存在，但窗口极短，此前走查没捕到帧属正常；demo 模式下注入延迟是复现真实首载观感的必要手段。骨架为 2 条 44px 圆角占位（与主机列表行数无关的固定 2 条，规格 §5.6 未规定条数——存疑不成立，按规格字面为合规）。

截图：`/tmp/recheck_skeleton_{0,1,2}.png`（在场帧）、`/tmp/recheck_skeleton_reduced.png`（reduced-motion）。

## §3 浅色 attach-hint pill 定性：**非缺陷**（褪淡=过渡中间帧）

方法：`localStorage["ui.theme"]` 预置主题（挂载即用，与真实设置链路同效），接入 prod-1 触发 hint，`.attach-hint` 出现后每 300ms 采样 computed opacity 至 6.8s。CSS 动画 `attach-hint-fade 6s ease forwards`（0%,70%→opacity 1；100%→0），JS 6000ms 后移除元素。

| 主题 | settled 期（t=305–3942ms） | 淡出起点 | 元素移除 |
|---|---|---|---|
| **浅色**（data-chrome="light"） | **opacity 恒 1.000（n=11，min=max=1）** | 4244ms 起 0.985→0.718→0.377→0.171→0.062→0.0098 单调衰减 | 6057ms |
| 深色 | opacity 恒 1.000（n=11） | 4245ms 起（同曲线） | 6064ms |

**判定：真缺陷不成立。** 两主题曲线逐点一致；70% 关键帧理论淡出点 4200ms，实测 4244/4245ms（+45ms 采样相位差）；移除时刻 6057/6064ms 与 JS 6000ms 定时一致。此前捕到的「一帧褪淡」落在 4200–6000ms 设计内淡出窗，且浅色主题不存在稳定低透明度状态（settled 期全程 1.0）。留证：`/tmp/recheck_attachhint_light.png`（settled 期浅色第一帧）。

## §4 三栏宽度与 placeholder 对比度（独立复测）

**三栏**（视口 1280）：`grid-template-columns = 220px 780px 280px`；实测 `.layout > .col` rects = `[{220×800 @x=0}, {780×800 @x=220}, {280×800 @x=1000}]`。左 220 固定（±0px）、右 280 固定（±0px）、中栏弹性 780px——与规格 §4.1 完全一致。

**placeholder 对比度**（WCAG 相对亮度公式，AA 线 4.5；取 computed `::placeholder` color 对逐层 alpha 合成后的有效背景）：

| 元素 | 主题 | 前景 | 有效背景 | 对比度 | AA 4.5 |
|---|---|---|---|---|---|
| 任务目标 textarea | 深 | rgb(154,170,184) | #1c2433（panel2） | **6.53:1** | PASS |
| 命令框 input | 深 | rgb(154,170,184) | #1c2433（panel2） | **6.53:1** | PASS |
| 任务目标 textarea | 浅 | rgb(77,91,104) | #ffffff（panel2） | **6.97:1** | PASS |
| 命令框 input | 浅 | rgb(77,91,104) | #ffffff（panel2） | **6.97:1** | PASS |

与 styles.css:546 注释自述的「placeholder 用 --text-sub 实算 ≈6:1」吻合，本轮独立复测证实。

**辅助文字数据（备注，非断言）**：`.side-quiet`/时间线 dim 文（`--dim`）深色 3.69:1、浅色 4.33:1——均低于 4.5。styles.css:546-548 已明确披露该取舍（「--dim 只用于真正的辅助装饰信息」）；浅色 4.33 距 AA 仅差 0.17，若后续想把 dim 类文字全部拉进 AA，浅色 `--dim` 需再加深约一档。定性：已披露的设计取舍，不计缺陷。

## §5 双主题全屏证据（8 张主证据 + 6 张辅助，均 1280×800）

| 文件 | 内容 | 确认要点 |
|---|---|---|
| `/tmp/recheck_dark_hover.png` / `_light_hover.png` | 主机列表 hover 态 | prod-2 卡浮现 编辑/删除/连接 操作组，hover 底色 panel3 |
| `/tmp/recheck_dark_panorama.png` / `_light_panorama.png` | 会话三栏全景 | 终端输出 + 命令框 + 右栏任务目标/现场简报/操作记录三区齐全；amber「Agent 控制中」徽标在场 |
| `/tmp/recheck_dark_addhost.png` / `_light_addhost.png` | 添加主机表单 | 远端编码独占整行（select 实测 177px）+ GBK 提示完整可读 |
| `/tmp/recheck_dark_toast.png` / `_light_toast.png` | Toast 出现瞬间 | 右下角 `.toast.ok` 绿色条「任务目标已更新」在场 |
| `/tmp/recheck_skeleton_{0,1,2}.png`、`_reduced.png`、`/tmp/recheck_attachhint_light.png`、`/tmp/recheck_light_goalcrop.png` | §2/§3 辅助证据 | 见上各组 |

全景图内 textarea 实测值为种子目标「把 /tmp/old-build 清理掉并重新打包 dist 到 /tmp/build.tgz」（已用 DOM 读取复核；一次图像分析曾误读为后拍的临时文本，系分析伪影，非截图问题）。

## §6 规格抽查（docs/ui-redesign-spec.md §五/§六）

| 断言 | 结果 | 数字证据 |
|---|---|---|
| 操作组静止隐没 | PASS | 未 hover：`opacity=0` + `pointer-events=none` |
| 幽灵点击防护 | PASS | 未 hover 时操作组几何中心 `elementFromPoint` 命中 `DIV.host-line`（主区文本层，非按钮）；hover 后同点命中 `button.ghost`（编辑钮）——pointer-events 门双向正确 |
| 卡片中心不被拦截 | PASS | 卡宽 199px、操作组宽 92px 起于 x=111px；卡片几何中心 x≈99.5px 落在 main 区（`centerInsideMain=true`） |
| 操作组不占布局宽 | PASS | 绝对定位覆盖右侧（`position:absolute; right:6px`），不挤压主机名 |
| 徽标 amber 语义 | PASS | Agent 态 `.ctl-badge.agent` computed color `rgb(208,176,122)` === `--warn #d0b07a`，文案「Agent 控制中」 |
| 徽标 accent 语义 | PASS | 接管后 `.ctl-badge.human` color `rgb(61,157,168)` === `--accent #3d9da8`，文案「我控制中」 |
| 连接 loading ≤400ms | PASS | 点击→文案翻「连接中…」+按钮 disabled：**8.9–10.1ms**（两次运行，TOFU 门内挂起态测得） |
| 单连接互斥 | PASS | connecting 期间全部 `.host-connect-btn` disabled |
| 失败路径 | PASS（信息） | 拒绝指纹→conn-error 常驻横幅 + 主机卡失败提示（HostKeyRejected 路径） |

**规格偏差备注（1 处，不计 FAIL）**：规格 §六原文为「按钮文字改为**小 spinner +** “连接中...”」，实现为纯文字「连接中…」+ disabled（无 spinner）。语义等价（loading 有 ≤10ms 级即时反馈，远优于 400ms 要求），文字前无 spinner 属实现取舍；如需逐字对齐规格可后续补一个 12px 旋转图标。

## 复现

```bash
cd ui && npx vite --port 5183 &      # 等 http://localhost:5183 200
node t38_goal_walkthrough.cjs && node pv_fix_verify.cjs
node recheck_1_skeleton.cjs   # §2（含 list_hosts 1100ms 注入 + reduced-motion + CPU×6 对照）
node recheck_2_attachhint.cjs  # §3（双主题 300ms×23 采样）
node recheck_3_layout_contrast.cjs  # §4（三栏 + WCAG 计算）
node recheck_4_screenshots.cjs      # §5（8 张证据）
node recheck_5_spec.cjs             # §6（hover/徽标/loading）
node recheck_6_dimtext.cjs          # §4 备注（--dim 辅助文字对比度）
```
