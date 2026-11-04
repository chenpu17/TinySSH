# tmux 监控大屏：快照适配窗口 + 键入保序（2026-11-04）

用户真机验证反馈：「tmux监控面板的显示与操作还是有些问题，显示是好像没有适应窗口大小，下面有些内容会被遮挡。操作有时候也输入有问题」。demo 域定点复现 + 修复 + 全量回归。

## 一、诊断（先复现后修）

### 显示：快照底部（最新内容）被裁

- **机理**：`.tw-pre` 顶部锚定（`inset:0`）+ 固定 11px 字号 + `.tw-shot` `overflow:hidden`。真实域抓取命令恒带 `-S -40`（40 行历史 + 当前屏 ≈ 64 行 ≈ 880px），2×2 网格格子（768 高）只容 ~22 行——**折叠线以下恰是最新屏/提示符**（截图实锤：work 格子在 history line 19 处齐切断）。demo fixture 行数少所以此前 spec/走查全绿=demo 形状掩盖真实形状（坑 74 同族：夹具必须复刻真实形状）。
- **宽度向**：80 列行 ≈ 544px，4×4 格子（1366 宽）≈ 259px——右半被裁。窄窗 4×4 实测 100 列行完全不可读。

### 键入：并发 send-keys 到达次序无保证

- demo 域功能全绿（进程内天然保序），但慢速打字每字符 >150ms 批窗 = 各自一发独立 exec（实测 3 字=3 发）；真机域这批 exec 并发在飞，**「ls」与「Enter」倒序 = 命令看似没跑**——用户「有时候输入有问题」的真机域解释。找茬四轮 A1 只给 tick 抓取加了在飞守卫，键入路径没有。

## 二、修复

1. **底部锚定**（styles.css `.tw-pre`）：`top:auto; bottom:0` + `transform-origin: left bottom`，溢出裁切交 `.tw-shot`——裁切只发生在顶部（最旧历史），最新屏/提示符恒贴底可见，终端语义与监控语义一致。`.tw-shot` 接管 `background: var(--bg)`（pre 改透明，底部锚定后上方留空区着色统一）。
2. **按宽适配**（tmux-wall.tsx）：`cellCols`（WeakMap 缓存，剥全部 CSI、CJK 记 2）+ `data-cols`；`applyFit` 用实测等宽字宽（首格 computed style 探针，量一次）算 `scale = min(格宽预算/自然宽度, cap)`——网格封顶 1（只缩不放，邻格字号一致）、solo 允许放大到 1.8（监控大屏「放大」铺满窗口）、下限 0.25。`useLayoutEffect`（paint 前写 transform，useEffect 时机在绘制后会闪未缩放帧）+ frames/sessions/solo/规格/stale 触发 + body 上的 ResizeObserver + window resize 兜底。
3. **键入串行链**（tmux-wall.tsx）：`sendChainRef` promise 链逐发；**目标在入队时刻钉死**（链内闭包不读 activeRef——队列执行时焦点可能已换格，迟到的字面必须落进它被敲下时的那格）；catch 在链内=链永不 reject 不堵死；errFlash 反馈不变。

## 三、验证

- 定点诊断（before/after 双跑，脚本已删）：网格 64 行快照末行可见（顶部裁历史）/solo scale(1.8) 末行「[输入中]」可见/窄窗 4×4 的 100 列行 scale(0.25) 右缘不裁/键入 echoOk+计数正常；截图 6 张目检（网格最新贴底、solo 填满、4×4 全格适配）。
- tsc 0；npm build ✓；**UI 全套 1117/1117 一次过**（spec63 125、spec65 33——spec 只读 `.tw-pre` 文本不钉几何，零扰动）。
- Rust 零改动。

## 四、教训

1. **demo 夹具形状必须复刻真实域形状**：真实 capture 恒带 40 行历史（≈64 行），demo 快照只有 3-4 行——裁切 bug 在 demo 里天然不可见。夹具该按「真实命令会吐什么」构造，不是按「演示什么好看」。
2. **fire-and-forget 的每一发都要问序**：tick 有在飞守卫不等于键入有序；并发写同一远端状态的通道，要么串行要么带序号。
