# 找茬五轮（2026-11-05）：四路巡检 + 独立确认 + 18 条修复

基线 **11b56cd**（工作树干净）起轮；用户指令「subagent 到处看看多审核、测试：视觉体验/操作习惯/性能/可靠性，发现后独立确认再修，端到端+视觉验证」。

## 一、编队与产出

| 路 | 域 | 产出 | findings |
|---|---|---|---|
| A | Rust 性能/可靠性 | tmux wall fit/restore 全链 + 四轮修复面 + 自由漫游 | 4（P2×3 P3×1） |
| B | 前端 | tmux-wall 状态机 + 四轮 19 条修复面 + i18n/性能漫游 | 7（P2×3 P3×4） |
| C | 视觉截图 | 31 张截图目检（demo 域 harness，真鼠标） | 7（P2×1 P3×6） |
| D | 用户操作习惯 | 10 条动线全走通（真鼠标/真键盘，28 张截图） | 6（P2×2 P3×4） |

合计 **24 条 → 独立确认员逐条证伪：CONFIRMED 18（P2×9 P3×9）+ KEEP-AS-DESIGNED 5 + REFUTED 1**。确认员四次实质改判/精化：A-1 危害收窄（unset+客户端在场态被 UNSET 臂 recalculate_sizes 自愈）、A-2 机理修正（改名单独被 id 闸拦下，需叠几何变化；补同名销毁重建变体）、C-6 REFUTED（探针 scrollHeight==clientHeight 零溢出，1px 暗色边框被误读为裁切）、D-4 根因推进（useDialogFocus 的 prev 快照被 autoFocus 污染）。矮窗 768 C1 回归点在真实截图复验无恙。

## 二、修复 18 条（全部亲核落地）

### A 路（core）
- **A-1【P2】restore 把原尺寸钳进贴格预算域**：`tmux_wall_restore_cmd` 对 fit 回执的真实原尺寸套 `clamp(12,400)/clamp(5,200)`——4K/带鱼屏 >400 列的原窗口关墙恢复成 400 列。修=钳位域改 tmux 自身接受域 `1..=10000`（防注入只需纯数字，range 只防荒诞；tmux WINDOW_MAXIMUM=10000）。测试用例改 480×120 越界不钳。
- **A-3【P2】崩溃重开「一轮即还原」承诺是假的**：重开 fit 把残留的 manual+变形尺寸当原样抓回，关墙 restore 白名单臂**原样交还 manual**=残留永久化（tmux cmd-resize-window.c 实证 manual 下 -x/-y 照常生效，危害是「恢复不了」非「贴格失效」）。修=**回执 manual 一律解钉 UNSET**（本机制/崩溃残留钉的 manual 无从区分用户原意；unset 走 recalculate_sizes 自愈）；台账 §六假承诺划线更正。副作用：用户本就手动钉 manual 的窗口关墙转自动跟随（丢钉不丢布局）。
- **A-4【P3】单格关闭孤儿 channel**：`tmux_pane_close` 3s 预算弃尾时取消点可落在写锁/出向 mpsc（cap 100）挂起中，CHANNEL_CLOSE 未发而 russh 丢弃 Channel 不补发——「整条连接关闭兜底」只对 close_session 成立。修=超时弃尾转 `tokio::spawn` 后台补发（20s 与传输泵写停滞同界；重复 CLOSE 对已关通道无害）。

### B 路（前端）
- **B-1【P2】地址框 Enter 无条件覆盖已填名**：`nameFromAddr ?? name` 的 `??` 把非空空串当 nullish，编辑流回地址框改错字回车=主机被改名成地址（四轮 D4 的意图是「名称空才补」）。修=`name.trim() ? name : nameFromAddr ?? name` 与 onBlur 同口径。
- **B-2【P2】被守卫拒绝的 fit 记成已发，资格恢复后终身 letterbox**：单窗格守卫/0 尺寸格 resolve 整批但无回执，前端成功臂无差别记账；之后 pane 多变单而格子几何不变时签名闸永不再触发。修=记账仅限**拿到回执**的目标（results 按 id/name 反查）+ applyFit 增设未贴格 2s 温和重试臂（不走 400ms 防抖——会被 300ms 节拍饿死）。
- **B-3【P2】AltGr 字符全吞**：欧式布局第三层（Windows 恒报 ctrl+alt 双真）在三个特殊键分支+字面分支全落空，@ \ | ~ 静默蒸发（xterm 主视图对同形态显式放行=两处劈叉）。修=字面分支接 `getModifierState("AltGraph") || (ctrl&&alt)` 按字面发。
- **B-4【P3】EN 缺「键入送达失败」键**（11b56cd 只补了姊妹键）：EN 表补译。
- **B-5【P3】ansiToHtml 逐字符 3 连 regex**：改 span 攒满一次转义（&<> 转义逐字符上下文无关已证等价；实测 200×64 帧 5.15→0.79ms，6.5×）。
- **B-6【P3】发射闸按名键系**（A-2 同根因第三形态）：sig 纳入 id（`${id||name}:...`，同名销毁重建新 id 必变签名）。

### C 路（视觉）
- **C-1【P2】分屏 pane-tag 玻璃章片浮压终端首行**（tmux 网格轮修过主视图、普通分屏没跟上=同一缺陷两种待遇）。修=移植网格方案：分屏窗格 `padding-top:28px`（fitOne 的 padEl=el 自动扣行）+ 名牌升格 22px 通栏标题栏（pointer-events 维持 none 不新增交互面）。
- **C-3【P3】窄墙头 CJK 任意断字**（「tmux 会话/大屏」两行、「· 4」独占一行）。修=标题/计数 nowrap，提示语 min-width:0+ellipsis 吸收缩缩。
- **C-4【P3】断开会话分屏副格=纯黑腔无解释**（断线横幅只渲染激活会话；attach-hint 对断开会话谎报「已接入」）。修=名牌带非连接态后缀（镜像 tmux-cell-state：` · 已断开`/` · 重连中…`）+ attach-hint 按状态门控文案。

### D 路（操作习惯）
- **D-1【P2】双击放大落「无焦点键入态」死区**：双击选词骗过 refocusSoon 选区豁免→300ms 节拍换装清掉选区后无人再抢回，焦点永留 body；Esc 被墙捕获 `activeRef` 早退吞掉=死键、打字静默蒸发（放大钮路径正常=行为劈叉）。修=双击 handler 清选区+下一拍强制聚焦输入框。
- **D-2【P2】拖分屏成员回溢出标签条被 reinterpret 成重排**（条满无空白落点，教程语义「拖回=退分屏」静默变成重排+分屏保留+零反馈）。修=**拍板：分屏成员拖回标签条任意位置=退出分屏**（成员在条内重排本就语义模糊：先退再拖；非成员拖拽行为不变）。
- **D-3【P3】缺密码错误不聚焦密码框**（同表单其余五分支都有 ref 聚焦）。修=补 passwordRef。
- **D-4【P3】提交/按钮关浮层焦点落 body**（Esc 路径却恢复）。根因=useDialogFocus 的 prev 快照在 effect setup，React autoFocus 已把焦点搬进框内→prev=框内自己→关闭时已卸载恢复被跳过。修=模块级**焦点轨迹**（document 捕获 focusin 滚动记录，先于任何 autoFocus）+打开时取最后框外持有者；标签/组改名 Enter 提交后微任务回焦标签本体/胶囊（**Escape 不回焦**——回焦引发 blur 会把本应丢弃的编辑提交掉，取消语义优先）。
- **B-7【P3】一键切主视图 await 串接**：`promotePaneToMain` 改 `Promise.all` 并行收格（detach 先于接入的次序由全 settle 后接入保住；A-4 落地后核心关格自带 3s 预算+后台补发）。

### 维持设计（确认员裁定，不修）
- C-2 大屏无 NPU 卡底部留白=等高仪表盘取舍（demo 明确 NO_NPU 与真实后端对齐）。
- C-5 EN 演示数据中文=用户数据非 chrome（设置页有免责说明）。
- C-7 ⌘K 同名双行=数据驱动镜像标签栏（状态列已消歧）。
- D-5 墙盖标签条=与监控大屏同位同语义的全幅覆盖层拍板设计（CSS 注释明文层级，各有 ✕+Esc 出口）。
- D-6 断线键入 warn-once=R26 §6.4「明说不假装」既定取舍。

### REFUTED（关闭）
- C-6「2×2 大屏底行越出视口」：探针 `scrollHeight==clientHeight` 零溢出、末格 bottom=792 距底 8px padding，边框在 viewport 内完整画出——暗色 1px 边框低对比被误读为裁切。

## 三、回归与视觉验证

- **cargo workspace 单遍**（exclude tinyssh-app 口径）exit 0：core-session **192/192**（restore 形状测试改写：manual→UNSET、480×120 越界不钳、真 sh 往返无 `window-size manual`）；其余全绿。零新增 warning（8 条存量全在 records/term-core）。
- **tsc --noEmit** 0。
- **UI 全套单遍（Edge）1127/1127 一次过**（+1=spec30 新契约断言）；spec65 42/42、spec63 125/125、spec30 41/41（含「断开会话副格名牌带·已断开」新断言）。
- **视觉验证 16/16**（verify-r5-fix.cjs）+ 3 张截图目检：分屏双格标题栏（staging-1 · 已断开 后缀在场、首行 `ops@prod-1:~$ df -h` 完整可读）、双击放大焦点在输入框+Esc 链复活、900px 窄墙头单行+省略号。
- 台账更正：docs/ux/2026-11-04-wall-pane-fit-round.md §六「崩溃残留一轮即还原」划线证伪+修复记录。

## 四、本轮坑（新）

- **坑 100：`node test/specs/XX.spec.cjs` 直跑恒 exit 0 假绿——spec 是被 run.cjs 消费的模块，无自执行**；唯一有效入口=`run.cjs <过滤词>`（环境失败 exit 2 / 断言失败 exit 1 / 管道接 tail 会吃掉退出码）。本轮首批「定点六连绿」全部作废重跑。环境失败（TINYSSH_UI_CHROME 未设，browser.cjs 不含 Windows 浏览器发现）也走 exit 2，npm test 包装层把它报成 exit 0——**退出码必须看 runner 自己的汇总行，不能只看 shell exit**。
- 微任务回焦会触发受控 input 的 blur 提交链：Enter 提交路径回焦无害（同值幂等），**Escape 取消路径回焦会把丢弃的编辑提交掉**——取消语义优先，回焦只挂 Enter。

## 五、立案（未修，下轮随带）

- AltGr 真实欧式布局键盘未实测（Chromium 行为有 UI Events #147/MDN 佐证，机理 CONFIRMED；真键验证待有欧式物理键盘时补）。
- palette 叠墙的 Esc 逐层、⌘K 快捷键链路：demo 域 native 门不可测，真机域待验。
- IME 组合输入（墙键入/改名框）：headless 无法模拟，沿用四轮立案。
- D-2 语义拍板记录：分屏成员标签条内重排能力已让位给「拖回=退分屏」（需重排先退分屏）；若用户反馈要回重排语义，改回「命中标签=重排+可见反馈」成本低。
- useDialogFocus 焦点轨迹为全局滚动记录（上限 32）——极端连开 32+ 层弹层的轨迹污染未防（现实动线不可达，记录在案）。

## 六、证据脚本（未跟踪，随取随删）

ui/test/capture-r5{,b}.cjs（C 路截图）、walk-r5.cjs+walk-r5-probe{2,4,5}.cjs（D 路走查）、verify-r5b-ansi.cjs、verify-r5c-{crop,edge,wall-probe}.cjs、verify-r5d-*.cjs×4、verify-r5-fix.cjs（修复后视觉验证）；截图 ui/test/.shots/r5*（gitignored）。
