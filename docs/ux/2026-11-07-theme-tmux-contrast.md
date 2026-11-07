# 主题 × tmux 配色对比度修复（2026-11-07）

## 反馈

用户：「主题风格建议审核下，特别是我们支持 tmux 以后，有没有一些颜色搭配问题。」

## 审计口径

- 主题变量解析：`ui/test/theme-vars.mjs`（与 `wcag-themes` / `semantic-hues` 同一套继承链）。
- 覆盖 16 个色板 × 深/浅两态，共 32 个主题态。
- tmux 侧按 3.5 `options-table.c` 的默认样式实算：
  - `status-style bg=green,fg=black`
  - `message-style bg=yellow,fg=black`
  - `message-command-style bg=black,fg=yellow`
  - `mode-style` / `menu-selected-style` `bg=yellow,fg=black`
  - `copy-mode-match-style bg=cyan,fg=black`
  - `copy-mode-current-match-style bg=magenta,fg=black`
  - `copy-mode-mark-style bg=red,fg=black`
  - `window-status-activity-style reverse`

## 审计结果

| 场景 | 实算对比度 | 结论 |
|---|---|---|
| 浅色主题 × tmux 默认「彩底黑字」 | **1.04–1.07:1** | 状态栏、消息行、复制模式高亮基本不可读 |
| 深色主题 × 同一组默认样式 | **3.95–4.54:1** | 仅 `status-style bg=green,fg=black` 这一组就有 15/16 低于 AA 4.5:1（Nord 最低 3.95）；全部默认样式里个别组合可到 4.54 |
| 应用自绘 tmux 焦点格标题（旧：`--accent` on 14% accent 底） | 失败子集 4.13–4.50:1 | graphite/light 4.39、多个浅色板 4.13–4.18；深字浅底的 eink/light 等组合本就 ≥4.5，不在此失败区间 |
| 应用自绘死格正文（旧：`opacity:.45`） | 1.8–2.85:1 | 浅色主题最后一段输出很难读 |

根因：tmux 默认主题假设「深色终端 + 亮彩 + 黑字」。浅色色板为了正文对浅底
≥4.5:1，必须同时压暗 ANSI black 与彩色，`black on green/yellow/cyan` 必然接近
同亮度；**仅靠调整 16 色无法同时满足「彩字对浅底」和「黑字对彩底」两个方向**。

## 修复

### 1. xterm 最小对比度兜底（主终端 + tmux 格子）

`ui/src/App.tsx`：

```ts
const TERM_MIN_CONTRAST = 4.5;
// 两处 new Terminal({ ... }) 均设置
minimumContrastRatio: TERM_MIN_CONTRAST,
```

xterm 的 `minimumContrastRatio` 会按**每个单元格实际前景/背景**动态修正前景亮度
（DOM 与 WebGL 两个渲染器都实现了该能力，走 `ensureContrastRatio` + 对比度缓存）。
它只改渲染颜色，不改缓冲区文本，复制出来的内容仍是原样。

选择这个方案而不是「attach 时写远端 tmux 样式」：

- 不写远端配置，不需要 detach 恢复，没有多客户端/崩溃残留问题；
- 手动在 shell 里起的 tmux、htop、dialog、mc 等「彩底黑字」TUI 一并覆盖；
- 主题切换/任意 tmux 自定义配色都自适应，不依赖 tmux 版本。

实测（tokyo/light、DOM 渲染器，写 `\x1b[42;30m` / `\x1b[43;30m` / `\x1b[44;30m`）：

| 组合 | 修正后前景 | 结果 |
|---|---|---|
| 黑字 × 绿底 | `rgb(215,215,217)` | 可读（≥4.5:1） |
| 黑字 × 黄底 | `rgb(215,215,217)` | 可读 |
| 黑字 × 蓝底 | `rgb(215,215,217)` | 可读 |

调色板本身已按「ANSI 彩字对终端底 ≥4.5:1」生成，普通输出不受影响；显式 SGR dim
的单元格按半目标（2.25:1）修正，仍保留「暗一档」的语义。

范围说明：会话大屏（tmux wall）用 ANSI→HTML 直出，不走 xterm 的最小对比度；
其普通彩字对终端底由调色板门保证，但墙内「彩底黑字」内容（如 htop 快照）不在
本次兜底范围。

### 2. 自绘 tmux 焦点格标题

`ui/src/styles.css`：

```css
.tmux-cell:focus-within .tmux-cell-head,
#term.has-tmux-panes .term-session.active:focus-within .pane-tag {
  color: var(--accent-text);
  background: color-mix(in srgb, var(--accent) 12%, var(--panel));
}
```

`--accent-text` 是菜单 accent 软底同款正文档；底色从 14% 收到 12%。32 个主题态
全部 ≥4.5:1（graphite/light 从 4.39 提升到 4.51）。

### 3. 死格正文

`ui/src/styles.css`：

```css
.tmux-cell.dead .tmux-cell-body { filter: grayscale(0.85); }
```

去掉 `opacity:.45`。死格的身份由标题栏常显的「已断开 · 重连后自动恢复」状态字
+ 正文去色承担；保留最后一段输出可读，比重度蒙灰更有用。

## 可选：更干净的 tmux 状态栏

如果希望 tmux 状态栏融入终端底色（而不是依赖对比度修正把黑字提亮），可在远端
`~/.tmux.conf` 使用主题无关的配置：

```tmux
set -g status-style "bg=default,fg=default"
set -g window-status-current-style "reverse"
set -g message-style "reverse"
set -g message-command-style "reverse"
set -g mode-style "reverse"
set -g menu-selected-style "reverse"
set -g copy-mode-match-style "bg=default,fg=cyan"
set -g copy-mode-current-match-style "bg=default,fg=magenta"
set -g copy-mode-mark-style "bg=default,fg=red"
```

这是可选项；不配置也能靠应用侧的最小对比度兜底正常阅读。

## 回归

- 新增 `ui/test/specs/74-terminal-contrast.spec.cjs`：
  - 主终端 `minimumContrastRatio=4.5`；
  - tmux 格子 `minimumContrastRatio=4.5`；
  - 焦点格标题使用 `--accent-text`；
  - 死格正文 `opacity:1` + `grayscale`。
- `npm run build` 通过。
