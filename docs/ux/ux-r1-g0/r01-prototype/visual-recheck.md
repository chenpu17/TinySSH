# R01 原型独立视觉复验（visual-recheck）

复验人：独立 subagent（非作者）。方法：headless Chrome 截图（deviceScaleFactor=2）+ 像素扫描 + iframe DOM 几何 dump（drive.html 可复跑）+ WCAG 对比度计算。基准：§4.2 尺寸表、§7.2 token 表。允许 ±2px。

## 1. 几何 — PASS（1 项备注）

| 项 | 规格 | 实测 | 结果 |
|---|---|---|---|
| 标题区 | 44 高 | 44.0（DOM+像素，1280/960/1024 一致） | PASS |
| 标签栏 / 会话工具栏 | 各 40 | 40.0 / 40.0 | PASS |
| 主机栏 | 224（可拖 200–300） | computed 224px；像素边界 223–224 | PASS |
| 文件面板 | 384 | x=896, w=384（像素 383.5） | PASS |
| 页脚状态条 | 24 | 24.0（776→800） | PASS |
| 终端区宽（1280） | ≥560 | 并排 644；纯终端 1028 | PASS |
| 1024×768 / 960×600 | 主机栏保留、无裁切 | 截图确认 | PASS |
| 活动抽屉 | 240 高，≤工作区 45% | CSS 240；运行时 JS=min(240, max(120, content×0.45))：1280 实测 185–208，960 实测 120 | 备注 |

备注：抽屉高度由 app.js:687 动态计算，满足 ≤45% 上限，但 1280 下实测 185 ≠ 当时 content×0.45=210，且不同时机结果不一致（185/208），说明设置后不随 content 变化重算；240 基准在 800 高视口下不可达。建议：content 变化时重算，或文档化「240 为上限、实际随窗口收缩」。

## 2. Token 静态核对 — PASS

styles.css 两个主题块 14 项 token 与 §7.2 逐项比对，28/28 一致，无偏差。

## 3. 对比度 — 2 FAIL

计算值（WCAG）：正文/画布 15.15/13.52；辅助/画布 9.21/5.80；主按钮字/底 10.08/6.40；强调/画布 10.08/5.85；错误字/画布 8.67/5.73；焦点环/画布 9.31/5.82；终端正文/底 14.01 —— 全部达标。
- **FAIL-A**：dark 主按钮类 `btn-danger` 白字/#F29B9B 底 = **2.11:1**（<4.5），实物为 conflict 对话框「替换」。修复：dark 下危险按钮文字改深色（如 #10151C，对比 >8）或加深底色。
- **FAIL-B（低）**：border.subtle 作输入框边界：dark 1.76 / light **1.36**（<3.0）。分区线可豁免，但表单输入框属必要控件边界。修复：输入框边框单独加深一档。

## 4. 交互走查 — 1 FAIL

- 连接中→已连接：**PASS**（terminal-connecting.png：build-runner 行橙点+「取消」按钮；稍后截图转绿点已连接；app.js:711 时序 1300ms）
- 标签切换：**PASS**（drive-tab.png：activeTab=2，内容随切）
- 抽屉展开/收起：**PASS**（drive-drawer.png：状态条按钮点击后 hidden）
- **FAIL-C：960 下 files 完整视图**。`mode-full` class 生效，但 term-area 未隐藏：左侧留 378px 空终端死区，file-panel 仅 354 宽；file-list 被压至 28px 高，5 行文件仅露出半行（drive-f960.png + files-dark-960.png）。narrow@1280 同样存在死区（narrow-dark-1280.png）。修复：mode-full 时对 term-area 设 display:none（或 flex:0），让文件面板独占中央工作区，符合 §4.2「完整视图」语义。
- README 自检「DOM 验证 mode-full」仅验证了 class，未验证布局结果——与本次实测矛盾点即在此。

## 5. 裁切检查 — PASS

14 张截图无窗口边缘裁切；960 下「返回终端/上传/下载/立即重连/信任并继续/替换/跳过/保留两份」均完整可达。conn-fail 标签横向滚动属 tabstrip 滚动设计。

## 6. light 主题终端深色 — PASS

像素实测 light 下 x=228 处即转 #0D131A 深色终端底；截图视觉确认主题解耦。

## 总评

原型达到 G0「可交互原型」标准：几何与 token 忠实于规格，三主视图 + 五异常态完整，连接/标签/抽屉/主题/断线重连链路均可演示。合入前须修复：**FAIL-C（mode-full 布局，影响窄窗核心场景可用性）**、**FAIL-A（危险按钮对比度）**；建议一并处理 FAIL-B 与抽屉高度备注。修复后仅需对 mode-full@960 与 conflict 对话框两项复验。

## 截图清单（screenshots/）

主截图：welcome-dark-1280 / welcome-light-1280 / terminal-dark-1280 / terminal-light-1280 / files-dark-1280 / files-light-1280 / terminal-dark-960 / terminal-dark-1024 / conn-fail-dark-1280 / disconnected-dark-1280 / fingerprint-dark-1280 / conflict-dark-1280 / narrow-dark-1280 / files-dark-960。
证据：terminal-connecting.png（连接中态）；drive-f1280 / drive-f960 / drive-t1280（DOM 几何 dump）；drive-tab / drive-drawer / drive-conn3 / drive-seq2（交互）；drive.html（可复跑的测量驱动页）。

---

# 复验 2026-10-06 二轮（定向：FAIL-A / FAIL-C / border-input）

方法同一轮（headless Chrome 2x + drive.html DOM dump + 截图取色）。

## FAIL-A 危险按钮对比度 — PASS

styles.css:126 `.btn-danger` 文字改 `var(--accent-onFill)`。conflict-dark-1280-r2.png 按钮区域取色：文字 #10151C / 底 #F29B9B，实测对比度 **8.67**（≥4.5）；light 侧 token 计算 #FFFFFF/#AE343B = 6.26。视觉上「替换」按钮文字清晰可辨。

## FAIL-C mode-full 完整视图 — PASS

styles.css:361 新增 `.content.mode-full .term-area { display: none }`。
- 960×600（drive-f960-r2）：term-area 0×0（隐藏）；file-panel x=228 **w=732 占满主区**；左侧无死区。file-list h=60（约 2 行 + 滚动；row0 行高 32 正常）。备注：960×600 垂直预算下列表天然有限（收起抽屉可得 ~180px 全见），属空间约束下的正常 flex 分配，非病态压缩。
- 1024×768 自动 mode-full（drive-f1024-r2）：file-panel w=796，file-list h=177，**5 行全部可见**；断点判定正确（792 < 224+560+320）。
- files-dark-960-r2.png 视觉确认：返回条 + 面板占满，无死区。

## border-input 新 token — PASS（无回归）

- token：dark #64768C / light #7A8798，应用于 .field input/select（styles.css:545）。
- 截图取色（drive-form-dark / drive-form-light，添加连接表单）：边界色与期望值逐像素一致；边界 vs 输入框底对比度 dark **3.94** / light **3.34**（≥3.0）；vs 弹窗 raised 底 3.12 / 3.65，全部达标。
- focus 态不受影响：首输入框自动聚焦显示 focus-ring（dark #91BAFF / light #245DB4），边界替换未破坏焦点可见性。

## 二轮结论

FAIL-A、FAIL-C 修复确认通过，border-input 达标且无回归。R01 视觉复验遗留清零，可提交 G0 联合评审。
二轮新增截图：conflict-dark-1280-r2 / files-dark-960-r2 / drive-f960-r2 / drive-f1024-r2 / drive-form-dark / drive-form-light。
