# UX-R1 G0 / R02 对比度记录（Token 初值）

- 数据来源：《ssh-client-ux-refactor.md》§7.2 Token 初值表，按 WCAG 2.x 相对亮度公式计算（(L1+0.05)/(L2+0.05)），未使用截图取色。
- 判定口径：正文与用户须阅读的说明 ≥4.5:1（WCAG AA 文本）；焦点指示与必要控件边界 ≥3:1（WCAG 1.4.11 非文本对比）。
- 终端 ANSI 调色板按规格独立验收，不在本记录范围。
- 计算脚本为一次性 Node 脚本（sRGB 分量线性化 → 0.2126/0.7152/0.0722 加权），复算可直接重跑同公式。

## 深色主题

| 组合 | 前景 | 背景 | 比值 | 判定 |
|---|---|---|---|---|
| 正文 / 画布 | text.primary #E5EAF0 | surface.canvas #10151C | 15.15 | ≥4.5 |
| 正文 / raised | text.primary #E5EAF0 | surface.raised #202A36 | 12.01 | ≥4.5 |
| 正文 / sidebar | text.primary #E5EAF0 | surface.sidebar #171E27 | 13.87 | ≥4.5 |
| 辅助文本 / 画布 | text.secondary #ADB9C8 | surface.canvas #10151C | 9.21 | ≥4.5 |
| 辅助文本 / raised | text.secondary #ADB9C8 | surface.raised #202A36 | 7.30 | ≥4.5 |
| 辅助文本 / sidebar | text.secondary #ADB9C8 | surface.sidebar #171E27 | 8.43 | ≥4.5 |
| accent 链接 / 画布 | accent.text #70D1BE | surface.canvas #10151C | 10.08 | ≥4.5 |
| accent 链接 / raised | accent.text #70D1BE | surface.raised #202A36 | 7.99 | ≥4.5 |
| onFill / fill | accent.onFill #10151C | accent.fill #70D1BE | 10.08 | ≥4.5 |
| success / 画布 | status.success #8ED5A4 | surface.canvas #10151C | 10.65 | ≥4.5 |
| success / raised | status.success #8ED5A4 | surface.raised #202A36 | 8.44 | ≥4.5 |
| warning / 画布 | status.warning #E7BF78 | surface.canvas #10151C | 10.58 | ≥4.5 |
| warning / raised | status.warning #E7BF78 | surface.raised #202A36 | 8.38 | ≥4.5 |
| danger / 画布 | status.danger #F29B9B | surface.canvas #10151C | 8.67 | ≥4.5 |
| danger / raised | status.danger #F29B9B | surface.raised #202A36 | 6.87 | ≥4.5 |
| focus.ring / 画布 | focus.ring #91BAFF | surface.canvas #10151C | 9.31 | ≥4.5（>3 达标） |
| focus.ring / raised | focus.ring #91BAFF | surface.raised #202A36 | 7.38 | ≥4.5 |
| 正文 / selected | text.primary #E5EAF0 | surface.selected #263A42 | 9.83 | ≥4.5 |
| accent / selected | accent.text #70D1BE | surface.selected #263A42 | 6.54 | ≥4.5 |

## 浅色主题

| 组合 | 前景 | 背景 | 比值 | 判定 |
|---|---|---|---|---|
| 正文 / 画布 | text.primary #1D2935 | surface.canvas #F3F5F7 | 13.52 | ≥4.5 |
| 正文 / raised | text.primary #1D2935 | surface.raised #FFFFFF | 14.78 | ≥4.5 |
| 正文 / sidebar | text.primary #1D2935 | surface.sidebar #EBEFF3 | 12.79 | ≥4.5 |
| 辅助文本 / 画布 | text.secondary #526172 | surface.canvas #F3F5F7 | 5.80 | ≥4.5 |
| 辅助文本 / raised | text.secondary #526172 | surface.raised #FFFFFF | 6.34 | ≥4.5 |
| 辅助文本 / sidebar | text.secondary #526172 | surface.sidebar #EBEFF3 | 5.49 | ≥4.5 |
| accent 链接 / 画布 | accent.text #176B59 | surface.canvas #F3F5F7 | 5.85 | ≥4.5 |
| accent 链接 / raised | accent.text #176B59 | surface.raised #FFFFFF | 6.40 | ≥4.5 |
| onFill / fill | accent.onFill #FFFFFF | accent.fill #176B59 | 6.40 | ≥4.5 |
| success / 画布 | status.success #26713C | surface.canvas #F3F5F7 | 5.47 | ≥4.5 |
| success / raised | status.success #26713C | surface.raised #FFFFFF | 5.98 | ≥4.5 |
| warning / 画布 | status.warning #85590D | surface.canvas #F3F5F7 | 5.60 | ≥4.5 |
| warning / raised | status.warning #85590D | surface.raised #FFFFFF | 6.12 | ≥4.5 |
| danger / 画布 | status.danger #AE343B | surface.canvas #F3F5F7 | 5.73 | ≥4.5 |
| danger / raised | status.danger #AE343B | surface.raised #FFFFFF | 6.26 | ≥4.5 |
| focus.ring / 画布 | focus.ring #245DB4 | surface.canvas #F3F5F7 | 5.82 | ≥4.5（>3 达标） |
| focus.ring / raised | focus.ring #245DB4 | surface.raised #FFFFFF | 6.36 | ≥4.5 |
| 正文 / selected | text.primary #1D2935 | surface.selected #DCEFEB | 12.38 | ≥4.5 |
| accent / selected | accent.text #176B59 | surface.selected #DCEFEB | 5.36 | ≥4.5 |

## 结论

任务要求的全部核心组合（正文、辅助文本、accent 链接、onFill/fill、success/warning/danger 文本、focus.ring，分别在画布与 raised 上）在两主题下均 ≥4.5:1，无正文级不达标组合。

## 不达标 / 风险组合与处置建议

| # | 组合 | 主题 | 比值 | 问题 | 建议 |
|---|---|---|---|---|---|
| 1 | 危险按钮白字 / danger 填充（`#FFFFFF` on `#F29B9B`，R01 原型 `.btn-danger` 现状） | 深色 | 2.11 | <3，按钮文字不达标 | 深色主题危险按钮文字改用 `accent.onFill`（#10151C on #F29B9B = 8.67，≥4.5）；浅色保持白字（6.26 达标）。建议实施时为 danger 填充定义专用 onDanger token，两主题分别取 #10151C / #FFFFFF |
| 2 | border.subtle 作为输入框边界（raised 上 1.40，画布上 1.76） | 深 / 浅 | 1.36–1.76 | <3，若边框是识别控件的唯一手段则违反 1.4.11 | 纯装饰分隔线可豁免；输入框属必要控件边界，建议新增 `border.input`（深色约 #4E5D70、浅色约 #97A5B2 一档，≥3）或实施时接受「label 定位 + focus ring 补偿」并记录该决策 |
| 3 | disabled 控件（opacity .45 混合后的实际前景） | 深 / 浅 | 2.59–3.64 | <4.5 | WCAG 1.4.3 对非活动 UI 组件豁免，可接受；记录实测值供评审知情，实施时保持 45% 不透明度口径统一，不得再降低 |

附注：disabled 混合值按前景 45% 叠加背景计算（主要按钮 onFill×45% 混入 fill；次要按钮 primary×45% 混入 raised）。

## 处置记录（2026-10-06，复验后闭合）

| # | 处置 |
|---|---|
| 1 | **已修**：`.btn-danger` 文字改 `var(--accent-onFill)`（两主题取值恰为建议的 #10151C/#FFFFFF：深色 8.67、浅色 6.26）。实施期可命名为专用 `onDanger` token，值不变 |
| 2 | **已修（新 token `border.input`）**：建议值复算不达标（#4E5D70 vs 画布 2.73、#97A5B2 vs raised 2.52），改用核算值——深色 `#64768C`（vs canvas 3.94 / vs raised 3.12）、浅色 `#7A8798`（vs canvas 3.34 / vs raised 3.65），均 ≥3。已入两主题变量并应用于 `.field input/select`；设计主文 §7.2 v1.2 同步登记 |
| 3 | 维持豁免，实施保持 45% 口径 |
