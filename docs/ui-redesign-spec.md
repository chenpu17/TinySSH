# TinySSH UI 精致化改造方案

> **历史方案（2026-10-06 起）**：本文件记录此前固定三栏布局的局部打磨，不再作为新重构的设计或验收依据。当前方案见 [UX-R1 SSH 客户端体验重构](ux/ssh-client-ux-refactor.md)。原有 token/组件仅在符合新方案时复用。

> 目标：达到 Termius 级别的专业感与信任感——不是改风格，而是通过清晰的视觉层级、精准的信息权重和一致的设计语言，让用户第一眼就觉得这是一个值得信任的工具。

---

## 一、诊断：当前问题根源

截图暴露了三个系统性问题，解决这三个问题，外观会产生质的变化：

**问题 1：Surface 层次不够**

`--bg`、`--panel`、`--panel2` 三个面板色相互之间亮度差过小（`#10141a` / `#171d26` / `#1d2530`），三列区域没有感知上的高低关系，只靠 `1px` 边框切割，整体"糊在一起"。

**问题 2：所有动作等权重**

每个主机卡上的「连接」按钮都是填充 accent 色，4 个主机 = 4 个同等抢眼的绿色按钮。用户不是同时想连所有主机——主要动作应该在 hover 时才显眼，静止状态下列表是"信息"，不是"一排按钮"。

**问题 3：警告状态被淹没**

「重确认（受限）」是一个安全限制状态，却以相同字重和颜色混在面包屑里，用户不会注意到它。状态类信息需要视觉分量，不能和导航混排。

---

## 二、色彩系统修订

当前 token 命名结构是对的，但取值需要调整。以下是深色主题的修订值：

```css
:root {
  /* Surface 层次——拉大 bg 与 panel 的感知差，形成明确的"容器在背景上"感 */
  --bg:      #0c1017;   /* 原 #10141a，加深约 3 个点，终端区显得更"沉" */
  --panel:   #141922;   /* 原 #171d26，左/右栏底色，与 bg 有明显区分 */
  --panel2:  #1c2433;   /* 原 #1d2530，卡片/输入框，在 panel 上浮起感 */
  --panel3:  #232d3d;   /* 新增：hover 状态的卡片，比 panel2 再亮一档 */
  --border:  #263040;   /* 原 #2a3442，略微收深，线条不要太跳 */

  /* Accent 从青绿微调为更沉稳的蓝绿——Termius 的主色调方向 */
  --accent:       #3d9da8;   /* 原 #4fa3a5，降饱和度约 10%，更沉稳 */
  --accent-hover: #4db0bb;
  --accent-soft:  rgba(61, 157, 168, 0.10);
  --accent-ring:  rgba(61, 157, 168, 0.20);

  /* 文字层次：三级，不要只有 text/dim */
  --text:     #d4dbe6;  /* 主文字，略降亮度（原 #d7dee8），柔和不刺眼 */
  --text-sub: #9aaab8;  /* 新增：副信息（IP、路径、时间戳），比 dim 亮 */
  --dim:      #5d6f82;  /* 原 #8a97a8，加深——用于真正的辅助信息，降噪 */
}
```

浅色主题无需大改，token 名称不变，已有的浅色值基本可用。

**为什么这样改**：`--bg` 加深后，左右面板在视觉上"浮"在背景上，形成 Termius 那种左栏是侧边容器、不是同一块平面的感觉。新增 `--panel3` 是 hover 状态的关键——卡片悬停时用它，不用再依赖透明度叠加，颜色更可预测。新增 `--text-sub` 解决了当前 IP/路径和主机名视觉等权重的问题。

---

## 三、字体与排版

当前 `font-size: 13px` 作为 base，13px 的中文在 macOS 上偏小且密，建议：

```css
body {
  font-size: 13.5px;          /* 中文 UI 在 macOS Retina 上更舒适的基准 */
  line-height: 1.55;           /* 稍松，降低密度感 */
  -webkit-font-smoothing: antialiased;
  letter-spacing: 0.01em;      /* 中英混排微调字距 */
}

/* 层级字号 */
.label-xs   { font-size: 10px; letter-spacing: 0.04em; color: var(--dim); }
.label-sm   { font-size: 11px; color: var(--text-sub); }
.label-base { font-size: 13px; }
.label-md   { font-size: 14px; font-weight: 600; color: var(--text); }
```

`.panel-title` 的 `11px uppercase` 去掉 `text-transform: uppercase`（中文全大写没有意义），改用 `letter-spacing: 0.06em` + `font-weight: 500` 维持分组感。

---

## 四、布局调整

### 4.1 三栏比例

```css
.layout {
  grid-template-columns:
    220px                    /* 左栏固定，不用 minmax——宽度确定性让布局更稳 */
    minmax(0, 1fr)           /* 中栏弹性 */
    280px;                   /* 右栏固定，原 minmax(230-320) 改固定减少跳动 */
}
```

### 4.2 左栏内边距

当前 `padding: 8px` 偏紧。调整为：

```css
.scroll { padding: 6px 10px; }  /* 横向稍宽，给主机名呼吸空间 */
```

### 4.3 左栏分组标题

「主机」「会话」「AGENT 接入（MCP）」三个分组标题当前都用 `.panel-title`，和顶栏同样的样式，没有区分。改为：

```css
.section-header {
  padding: 14px 10px 4px;
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.08em;
  color: var(--dim);
  /* 不加 border-bottom，用上方 padding 留白区隔，视觉更透气 */
}
```

---

## 五、组件逐一改造

### 5.1 主机卡片（最高频交互，改造优先级最高）

**目标**：静止状态是"信息列表"，hover 才是"可操作元素"。参考 Termius 的侧边主机列表。

**当前结构问题**：`连接` 按钮常显 accent 填充色，4 张卡就是 4 个抢眼的绿色块。

```css
/* 主机卡：去掉 border+rounded 的"卡片"外形，改为列表行样式 */
.host-card {
  padding: 8px 10px;
  border-radius: 8px;
  margin-bottom: 2px;          /* 原 8px，行间距收紧，更像列表 */
  border: none;                /* 去掉常显 border */
  background: transparent;     /* 常态透明——融入侧栏 */
  cursor: pointer;
  transition: background 0.12s ease;
}
.host-card:hover {
  background: var(--panel3);   /* hover 才出现背景 */
}
.host-card.active {            /* 当前已连接的 */
  background: var(--panel2);
  border-left: 2px solid var(--accent);
  padding-left: 8px;
}

/* 主机名：第一行，最大 */
.host-name {
  font-size: 13.5px;
  font-weight: 600;
  color: var(--text);
}

/* 用户名@地址：第二行，副信息色 */
.host-addr {
  font-size: 11px;
  color: var(--text-sub);
  margin-top: 1px;
}

/* 认证类型标签 */
.auth-tag {
  font-size: 10px;
  color: var(--dim);
  border: 1px solid var(--border);
  border-radius: 3px;
  padding: 0 4px;
  line-height: 16px;
}

/* 连接按钮：常态 ghost 小按钮，hover 卡片时才出现 */
.host-connect-btn {
  display: none;
  padding: 3px 8px;
  font-size: 11px;
  font-weight: 500;
  background: var(--accent-soft);
  color: var(--accent);
  border: 1px solid var(--accent-ring);
  border-radius: 5px;
}
.host-card:hover .host-connect-btn {
  display: inline-flex;
}
.host-card.active .host-connect-btn {
  display: inline-flex;
  color: var(--dim);
  border-color: var(--border);
  background: transparent;
}
```

**HTML 结构调整**（`App.tsx` 的主机卡片部分）：

```tsx
<div className={`host-card ${isConnected ? 'active' : ''}`}>
  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
    <div>
      <div className="host-name">{host.name}</div>
      <div className="host-addr">{host.username}@{host.address}:{host.port}</div>
    </div>
    <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
      <span className="auth-tag">{authLabel(host.auth_type)}</span>
      <button className="host-connect-btn">
        {isConnected ? '断开' : '连接'}
      </button>
    </div>
  </div>
</div>
```

编辑/删除操作（`.host-ops`）保持原有 hover 显现逻辑不变，改到右侧 `···` 图标触发的 inline menu 是 P2 优化。

---

### 5.2 顶栏（状态展示 + 安全警告）

**当前问题**：五项信息等权重堆在一行；「重确认（受限）」警告状态混在普通文字里。

**改造目标**：顶栏只承载两类信息——当前位置（主机名 + 会话 ID）和控制权状态。警告类状态单独一行 Notice Bar。

```css
.topbar {
  height: 30px;
  padding: 0 12px;
  display: flex;
  align-items: center;
  gap: 8px;
  border-bottom: 1px solid var(--border);
  background: var(--panel);
  flex: none;
}

/* Notice Bar：警告/受限/重确认状态独占一行 */
.notice-bar {
  padding: 4px 12px;
  font-size: 11.5px;
  display: flex;
  align-items: center;
  gap: 6px;
  border-bottom: 1px solid;
  flex: none;
}
.notice-bar.warn {
  background: rgba(208, 176, 122, 0.08);
  border-color: rgba(208, 176, 122, 0.25);
  color: var(--warn);
}
.notice-bar.danger {
  background: var(--danger-soft);
  border-color: var(--danger-line);
  color: var(--danger);
}
.notice-bar.info {
  background: var(--accent-soft);
  border-color: var(--accent-ring);
  color: var(--accent);
}
```

「重确认（受限）」状态对应的 `.ctl-hint` 改为 `.notice-bar.warn`，文案简化为：

```
⚠ 重确认中（受限）— 普通操作暂停，仅允许只读核实命令。核实完成后自动恢复。
```

顶栏主行保留：主机名、会话缩略 ID、连接类型图标、控制权（Human/Agent）badge。其余信息从顶栏移除。

---

### 5.3 标签页（Tab Bar）

当前 tab 形态（上圆角、无下边框）是浏览器风格，与终端工具的语感略有冲突。改为扁平 pill 样式：

```css
.tabbar {
  padding: 6px 10px;
  gap: 3px;
  border-bottom: 1px solid var(--border);
  background: var(--panel);
}
.tab {
  padding: 4px 10px;
  border-radius: 6px;
  border: none;
  background: transparent;
  color: var(--text-sub);
  font-size: 12px;
  gap: 5px;
}
.tab:hover {
  background: var(--panel2);
  color: var(--text);
}
.tab-active {
  background: var(--panel2);
  color: var(--text);
  box-shadow: 0 0 0 1px var(--border);
}
.tab-dot { width: 8px; height: 8px; }
```

---

### 5.4 右侧面板

**问题**：四个区块直接靠分割线叠加，无容器感；操作记录是纯文本行，扫不了。

```css
.side-section {
  padding: 10px 12px;
  border-bottom: 1px solid var(--border);
}
.side-section-title {
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.07em;
  color: var(--dim);
  margin-bottom: 8px;
  display: flex;
  align-items: center;
  gap: 6px;
}
.side-count {
  font-size: 10px;
  padding: 0 5px;
  border-radius: 999px;
  background: var(--accent-soft);
  color: var(--accent);
  line-height: 16px;
}

/* 操作记录 Timeline */
.tl-row {
  position: relative;
  padding: 4px 0 4px 20px;
  min-width: 0;
}
.tl-row::before {
  content: '';
  position: absolute;
  left: 7px; top: 0; bottom: 0;
  width: 1px;
  background: var(--border);
}
.tl-row::after {
  content: '';
  position: absolute;
  left: 3px; top: 9px;
  width: 9px; height: 9px;
  border-radius: 50%;
  border: 1.5px solid var(--panel);
}
.tl-row.actor-human::after  { background: var(--warn); }
.tl-row.actor-agent::after  { background: var(--accent); }
.tl-row.actor-system::after { background: var(--dim); }

.tl-meta {
  font-size: 10px;
  color: var(--dim);
  font-family: "SF Mono", Menlo, monospace;
  line-height: 1.2;
}
.tl-action {
  font-size: 12px;
  color: var(--text-sub);
  line-height: 1.4;
}
.tl-cmd-text {
  font-size: 11px;
  font-family: "SF Mono", Menlo, monospace;
  color: var(--text);
  background: var(--bg);
  padding: 1px 5px;
  border-radius: 3px;
  display: inline-block;
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
```

操作记录行的 JSX 改造（将 `actor_kind` 映射到圆点颜色，命令用 mono code 样式）：

```tsx
<div className={`tl-row actor-${event.actor_kind.toLowerCase()}`}>
  <div className="tl-meta">{formatTime(event.ts)}</div>
  <div className="tl-action">
    {event.actor_kind === 'Agent' && event.agent_id
      ? <span style={{ color: 'var(--accent)' }}>{shortAgentId(event.agent_id)}</span>
      : <span style={{ color: 'var(--warn)' }}>我</span>
    }
    {' '}{actionLabel(event.action)}
    {event.command && <span className="tl-cmd-text">{event.command}</span>}
  </div>
</div>
```

---

### 5.5 现场简报区块

三层认知状态（Confirmed/NeedsRecheck/Unobservable）是这个产品独有的信息，目前 `.brief-row` 用 dashed border 分割，认知状态 tag 字体太小。改造：

```css
.brief-fact {
  padding: 5px 8px;
  border-radius: 5px;
  margin-bottom: 3px;
  display: flex;
  gap: 6px;
  align-items: flex-start;
}
.brief-fact.confirmed    { background: rgba(127, 191, 143, 0.06); }
.brief-fact.needsrecheck { background: rgba(208, 176, 122, 0.08); }
.brief-fact.unobservable { background: rgba(208, 122, 122, 0.06); }

.epistemic-badge {
  flex: none;
  font-size: 10px;
  padding: 1px 5px;
  border-radius: 3px;
  font-weight: 600;
  margin-top: 1px;
}
.epistemic-badge.confirmed    { color: var(--ok);     border: 1px solid rgba(127,191,143,0.3); }
.epistemic-badge.needsrecheck { color: var(--warn);   border: 1px solid rgba(208,176,122,0.3); }
.epistemic-badge.unobservable { color: var(--danger); border: 1px solid var(--danger-line); }
```

---

### 5.6 空状态与加载状态

主机卡列表加载时用 Skeleton 占位，避免无响应感：

```css
.skeleton {
  background: linear-gradient(90deg,
    var(--panel2) 25%,
    var(--panel3) 50%,
    var(--panel2) 75%
  );
  background-size: 200% 100%;
  animation: shimmer 1.4s ease infinite;
  border-radius: 4px;
}
@keyframes shimmer {
  from { background-position: 200% 0; }
  to   { background-position: -200% 0; }
}
```

---

## 六、交互细节

**连接按钮动作反馈**：点击「连接」后，卡片进入 loading 状态——按钮文字改为小 spinner + "连接中..."，约 400ms 内要有响应。

**控制权切换**：「接管」/「交还」按钮是高频操作，当前 `.ctl-hint` 区域不够显眼。改为：
- Agent 持有时：顶栏右侧出现一个 amber 色 `● Agent 控制中` badge，旁边是「接管」primary 按钮
- Human 持有时：badge 变为 `● 我控制中`，「交还」按钮降为 ghost 样式

**Toast/Notification**：连接成功、连接失败、文件传输完成这类事件，用右下角 toast（2-3 秒自动消失），不要静默或仅 console 输出。这是 P2 新增组件。

---

## 七、改造优先级与分工建议

| 优先级 | 内容 | 涉及文件 | 估算工作量 |
|---|---|---|---|
| **P0** | 色彩 token 修订（Section 二）+ 字体基准（Section 三） | `styles.css` | 0.5 天 |
| **P0** | 主机卡片重设计（Section 5.1） | `styles.css` + `App.tsx` | 1 天 |
| **P1** | 顶栏 Notice Bar + 状态权重（Section 5.2） | `styles.css` + `App.tsx` | 0.5 天 |
| **P1** | Tab 样式改 pill（Section 5.3） | `styles.css` | 0.5 天 |
| **P1** | 操作记录 Timeline（Section 5.4） | `styles.css` + `App.tsx` | 1 天 |
| **P2** | 现场简报 fact 块（Section 5.5） | `styles.css` + `App.tsx` | 0.5 天 |
| **P2** | Skeleton 加载状态（Section 5.6） | `styles.css` + `App.tsx` | 0.5 天 |
| **P3** | Toast 系统 | 新建组件 | 1 天 |

P0 完成后已能显著改变第一印象；P0+P1 是完整的"专业感"跃升；P2/P3 是精致化的长尾。

---

## 八、设计约束（勿违反）

1. **不改功能逻辑**：本文档所有改动都是视觉层，Rust 侧契约和 Tauri command 均不涉及。
2. **token 优先**：不允许在组件里写 `color: #3d9da8` 这类 literal，必须引用 CSS 变量。
3. **不引入新依赖**：所有样式用现有 CSS 自定义属性 + 原生 CSS 解决，不引 Tailwind 或 CSS-in-JS。
4. **xterm.js 终端区不改**：`#term` 内部 xterm 渲染区域不做 UI 干预，只改 chrome（外框、padding、圆角）。
5. **深浅色主题同步**：每次修改 `:root` 都同步检查 `:root[data-chrome="light"]` 和 `:root[data-chrome="solar-light"]` 是否需要对应值。
