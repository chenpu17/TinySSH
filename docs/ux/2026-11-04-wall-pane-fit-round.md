# tmux 监控大屏：pane 贴格子（resize-window 适配）轮（2026-11-04）

> **真机改型（同日第二稿）**：初版「零客户端守卫」被真机证伪后拆除，改为
> 「attach 客户端在场照样贴 + 关墙原样恢复」。诊断与改型见 §六。

## 六、真机诊断与改型（2026-11-04 晚）

用户复验（截图）：htop 还是缩块沉底。CDP 附着真实例（release+custom-protocol+`TINYSSH_WEBVIEW_ARGS=--remote-debugging-port`）三步定位：

1. **hook invoke 落空**：打包后 `invoke` 在模块加载期就绑定了 `__TAURI_INTERNALS__.invoke` 的**函数引用**，事后替换钩不进（`__fitLog` 恒空）——二分要靠**裸调** `__origInvoke/invoke` 直接发命令，不能靠拦。
2. **裸调 `tmux_wall_fit` 返回 ok 但 pane 纹丝不动**（rows 恒 42）→ shell 里守卫拦了。
3. **往 axiom_plane shell 格敲诊断命令**（墙键入通道）：`list-clients` 实锤 **agent_bench-02 上恒有一个 189×43 的 attach 客户端**（主视图里的 attach——htop 当初就是这个尺寸），`list-panes`=1；手动 `resize-window` **有客户端在场照样 rc=0** 且窗口真的变 100×30。

**结论：初版守卫的「零客户端」假设对主场景（主视图 attach+大屏同看）恒假=fit 对用户关心的会话永远不生效。** 且抓到两个 tmux 语义硬事实：

- `resize-window -x -y` 把 **window-size 选项钉成 manual（粘住）**：此后窗口不再跟随 attach 客户端尺寸——不还原=用户布局永久变形；
- attached 客户端在场时 resize 照样成功，客户端画面随墙缩放（墙是全幅覆盖层，主视图在墙后面本来就看不见）。

**改型**：

- **守卫只留单窗格**（多窗格 workspace 是活布局，axiom_plane p=2 / tiny_agent p=2 真机在列）；零客户端闸拆除。
- **先取原样再 resize**（顺序坑：resize 后 show-options 取到的 manual 是新值）：`@@FIT|<下标>|<原宽>|<原高>|<原ws>` 帧回执，ws 由 `show-options ... | cut -d' ' -f2` 取（空=未设）；尺寸取不到（0）不回执=不恢复。名字不进帧（下标对齐 targets）=「| 碰撞免疫」。
- **`tmux_wall_fit_restore`**：关墙（组件卸载）把留存的尺寸+选项原样交还——`resize-window` 回原尺寸 + `set-window-option`（UNSET=unset；白名单 manual/latest/largest/smallest=原样；其他值 core 侧先映射 KEEP=只恢复尺寸不动选项，比 shell case 更早消毒）。前端 origRef **只首次留存**（后续再 fit 不覆盖——要还原的是进大屏之前的布局）。
- **关墙竞态**：墙卸载正是 `tmuxWallSid` 置空那次渲染，App 回调若闭包 `wallSession` 恒 no-op——恢复回调读 **sid keep-ref**（最后打开的大屏会话），身份钉死不随渲染换引用。
- 慢链路竞态：回包晚于卸载 → cleanup 已跑过恢复 → 迟到回执再补一发（幂等：同尺寸重复 resize+setopt 无害）。

**连带发现（复训）**：runner 的 `pollAsync` 恒返回布尔（探针吐数组只拿 true）——第一稿 F2 断言三连败正是它，机制当时就在发。

### 行为边界（改型后）

- 墙开着：目标会话 pane 被贴成格子形状（attach 端画面同步变形，墙盖住的主视图看不见；**外部终端若也 attach 同会话会跟着缩**——恢复机制兜底，已在交付说明披露）。
- 关墙：全部还原（尺寸+window-size 选项）；demo/spec 以 `__wall_restores` 断言。
- ~~崩溃/强杀残留：window-size 钉在 manual——下次开墙关墙一轮即还原（重开时 fit 再交还）~~
  **此承诺已被找茬五轮 A-3 证伪并修复**：重开 fit 把残留的 manual+变形尺寸当「原样」抓回，关墙 restore 白名单臂原样交还 manual=残留永久化，「一轮即还原」不存在。修复（2026-11-05）：restore 侧对回执 `manual` **一律解钉成 UNSET**——本机制/崩溃残留钉上的 manual 无从与用户原意区分，unset 让窗口重新按在场客户端重算（tmux `options_push_changes` 收尾必走 `recalculate_sizes`），才是可自愈终态；下一次开墙关墙一轮即真实还原。副作用：用户本就手动钉 manual 的窗口关墙后转为自动跟随（丢钉不丢布局，可接受）。

## 七、改型后验证

- core-session **192/192**（fit 形状/真 sh 往返/解析、restore 形状+真 sh 往返；stub display-message 按 `$*` 分流宽/高——`$3` 是 `-t` 不是 format）；workspace 48 目标 exit 0（**单遍**，复合命令双跑被自查掐掉——坑 66 自己也踩）；tsc 0。
- spec65 **41/41**（+4：关墙触发 `__wall_restores`、恢复项原样=fit 前尺寸、ghost 不恢复、恢复反馈环=夹具 rows 回 24——墙已关后直接 `__demoInvoke` 抓拍验证，不看 DOM）。
- UI 全套见附录；真机 CDP 实证见 §八。

## 八、真机实证（改型构建，全部通过）

CDP 附着改型构建（连接 → 开大屏）：

- **agent_bench-02（htop，attach 客户端在场）：59×25、scale(1.001)**——htop 表头/进程表/底栏全部满格原生渲染（改型前 scale 0.321 缩块沉底）；t-01 同款 52×25 scale(1.047)。
- **axiom_plane 多窗格（p=2）守卫按设计不动**（scale 0.793 contain 原样）；t-02（claude code，p=2）同款不动。
- **关墙 → 直接抓拍 bench rows=42 = 原样还原成功**（尺寸+window-size 选项交还）。
- 截图 `.shots/real-fit-v2-on.png`（htop 满格）/`real-fit-v2-closed.png`；诊断脚本五件验完已删。

诊断期间在用户 axiom_plane shell 历史里留了三条只读诊断命令（list-clients/list-windows/resize 实验+unset 清理），已如实披露；实验曾把 bench 窗口钉成 manual——验证轮的 unset 清理+关墙恢复机制已把它交还 unset。

用户对适配 v2 的真机复验（截图）：左边 tmux 子窗里跑的是 htop，「明显布局有问题，没有全屏」——htop 整块缩在格子下半部，顶上大片空白。

## 一、诊断

适配 v2 的 contain 双约束（`scale=min(宽预算/当前屏宽, 高预算/屏行数, 2.5)`）本身没算错——错在**问题无解**：

- htop 所在 pane 的尺寸是**别人留下的**（用户终端/我们的面板 attach 过，detach 后 tmux 窗口保持最后尺寸），比如 190×60 的宽屏形状；
- 墙格子接近方形（2 列网格 ≈660×650px）。内容宽高比 1.9 vs 格子宽高比 1.0，物理失衡；
- contain 只能 letterbox：按宽缩放（scale≈0.47），htop 缩成一小块，`bottom:0` 底锚定让它沉底，顶上露出 40 行空白历史——「布局有问题」的观感全部由此而来；
- cover（铺满裁边）会裁掉 htop 右侧近半列进程表，监控语义不可接受。

**渲染侧无解。唯一真解是让 pane 长成格子的形状**：tmux `resize-window -x cols -y rows`，TUI 收 SIGWINCH 自己重绘满格——contain 度量自然收敛到 scale≈1，字还更清晰（比缩放渲染锐利）。

## 二、修复

1. **协议**（session-api）：`TmuxWallFit { id, name, cols, rows }`——格子像素预算换算的字符尺寸。
2. **核心**（core-session）：
   - `tmux_wall_fit_cmd`：`set -- <选择器> <列> <行> …` 三元组传参（名字任意字符不破循环形状，sq 转义同抓取命令；列/行 `clamp(12..400 / 5..200)` 钳成纯数字=注入面归零）。**守卫双闸**：`list-clients` 零 attach 客户端（用户正在主视图/面板里用的会话绝不 reshape）+ `list-panes` 单窗格（多窗格 workspace 是用户的活布局）。老 tmux 无 resize-window 时 2>/dev/null 吞掉，contain 兜底照常。
   - `tmux_wall_fit` 入口：retain/判空/32 上限同快照口径；**结果不回传**——300ms 节拍的 pane_height 就是反馈环，失败被 contain 兜底吸收。
3. **前端**（tmux-wall.tsx）：
   - applyFit 循环里顺带收集每格字符预算（与 contain 同款预算反推，floor 保证 resize 后必然装进格子、scale≈1 不溢出）；签名（`名:列x行|…`）不变不重排——300ms 节拍每拍都跑 applyFit，无脑重排防抖会让计时器永远重置、fit 永不发射；
   - 400ms 防抖 + 差量去重（`sentFits` Map，失败也记账不重试）；solo 隐藏格（clientWidth=0）、离线格（cols=0）、极老 tmux（rows=0）跳过；
   - App.tsx `wallFitPanes` 回调（wallSession 依赖，同 wallSendInput 模式）。
4. **demo 镜像**：`tmux_wall_fit` case 记 `__wall_fits`（spec 断言请求形状）+ 把 wallRows 落进夹具=下一拍快照 rows 字段（pane_height 反馈环的镜像）；`demo_tmux_fixture` 重建夹具是全新对象，wallRows 天然清空。

## 三、测试

- core-session：`tmux_wall_fit_cmd_shape`（三元组/钳位/双守卫/空清单）+ `tmux_wall_fit_roundtrip_in_real_sh`（恶意名 `x'; touch /tmp/pwned; '` 经 sq → set -- 切分 → 变量间接 → 守卫 → resize 实参全程当字符串活着；守卫任一非零/非单格不落 resize——假 tmux 以 **shell 函数**注入，Windows 无 exec 位 PATH 垫片不可靠）。
- spec65 新增 F2 段：开屏触发 `__wall_fits` 增量、ghost 不发、钳位域（≥12×5）、pane_height 反馈环（fit 行数落进 `.tw-pre` data-rows）。

## 四、坑

1. **stub 语义=行数不是数值**：假 tmux 吐数字「0」本身就是 1 行，`wc -l` 读出 1 个客户端→守卫正确拦截、测试假失败。stub 必须吐 N 行（0 行=零客户端）。
2. **POSIX case 分支体不能少 `;;`**：拼串 harness 里 `echo 0; list-panes)` 是语法错误，分号叠行必须成对 `;;`。
3. **测试用例 id 非空时名字路径根本没走到**（id 优先于名）——恶意名往返测试必须 id 留空。
4. **StrictMode 下 `mountedRef` 三段式 effect 恒假**（本轮最大坑）：dev 的 effect 是「装→卸→再装」，既有 unmount cleanup 把标志打成 false 后**重挂没人拨回 true**——此后所有 mountedRef 守卫在 dev 域全死。节拍没挂守卫所以无人踩响；pane 贴格子挂了守卫就哑了（fireFit 永不执行、demo 里 `__wall_fits` 恒空）。修=setup 拨回 `mountedRef.current = true`（正典写法）。**连带修复：sendNow 补拍换装的 mountedRef 守卫此前在 dev 同样是死的**（一直被 300ms 节拍兜底掩盖）。
5. **runner 的 `pollAsync` 恒返回布尔**：探针返回数组也只能拿到 `true`——`Array.isArray(fitArr)` 恒假，机制明明在发、断言三连败（坑 74 族：探针自身口径先对齐）。

## 五、验证

- core-session：`tmux_wall_fit_cmd_shape` + `tmux_wall_fit_roundtrip_in_real_sh` 2/2（fmt 后复跑仍绿）；**cargo workspace --exclude tinyssh-app exit 0 全绿**；`cargo check -p tinyssh-app --features tinyssh-app/custom-protocol` 绿（7 警告=既有 records/vault 传递弃用）。
- tsc 0；**spec65 37/37 全绿**（新增 F2 段 3 断言：开屏触发 `__wall_fits` 增量、ghost 不发+钳位域、pane_height 反馈环）。
- 临时诊断 tmp-diag-fit*.cjs/探针已删（诊断三连：二分定位 demo case 通→组件没调→StrictMode 实锤 `timer fired, mounted= false`）。

## 附：行为边界

- fit 只在墙开着时发（组件卸载即停，差量去重不重试）；关墙不动 pane 尺寸（tmux 下次 attach 自然按客户端尺寸重同步）。
- 用户正在用的会话（主视图 attach / 面板格子 attach / 任何外部客户端）零 reshape——守卫在远端 shell 里逐格判。
- fit 后 300ms 节拍自动拿到新 pane_height，applyFit 收敛 scale≈1；布局再变（拖窗/分屏/放大）→ 新预算 → 差量再 fit。
## 九、提交前三路复审（2026-11-04 晚，串行 A/B/C）

对 2026-11-04 三轮（适配 v2/贴格子/键入串行链）独立审查。A 路（Rust，对照 tmux 3.2a 源码核验选项作用域）：注入面/帧协议防碰撞/shell 语义/ws 语义矩阵全过，0 P0-P2；B 路（前端）：React 正确性/XSS/类型对齐全过，1×P1+3×P2；C 路（视觉/契约）：几何数学边界/solo 切换/暗色 ANSI/台账逐数对账全过，1×P2。逐条亲核定夺：

**已修（随批）**：
- **B-P1 迟到恢复用第二回执 orig**（中间尺寸+manual——恰好重蹈「永久变形」）：late 兜底改从 origFitsRef 首次留存取（.then 留存循环先写）。亲核属实，触发面=改布局后 400ms 窗口内关墙。
- **A-P3-1 + C-P3 改名恢复落空**（restore 按旧名寻址被 2>/dev/null 吞=布局不还原；老 tmux 3.0 前缀误中别人会话）：FitResult/RestoreItem 带 id，恢复 id 优先寻址（tmux_wall_selector $数字形状闸既有）。
- **B-P2-2 keep-ref 跨连接竞态**（A 墙迟到恢复发到 B 连接）：App 级 keep-ref 删除，sid 改由墙组件 prop 钉死（卸载 cleanup 取最后提交渲染闭包值，不受关墙置空竞态影响），restorePanes(sid, items)。
- **B-P2-3 IME keyCode 229**（WKWebView compositionend 后补发 Enter 多发远端）：墙输入框补 `|| keyCode === 229`（主视图同款解码在案）。
- **C-P2 300ms 节拍无回归网**（退回 2s 照绿）：spec65 补「1s 窗 ≥2 拍」断言（2s 旧节拍必红；≥2 留在飞守卫余量）。
- **B-P2-1 部分采纳**：亲核「回到曾发尺寸不重发」不成立（sentFits 是覆盖语义）；真残余=「失败永不重试」——修为失败回滚 fitSigRef 让下一拍自然重试（成功才记账）。
- **A-P3-2 fit Dispatched 歧义态**：文案改「resize 可能已生效，此格关墙将无法恢复」——不谎报纯失败（input 同族处理）。
- **C-P3 demo 回执口径**：demo fit 回执改「本次 resize 前现值」（上次值），orig_ws 臂注释声明由核心真 sh 覆盖。
- **C-P3 台账悬空**：本段即补全套数——改型后 **1125/1125**（result.json 21:21），复审修复后再跑见 §十。

**立案不修（下轮随带）**：cellCols WIDE 漏 emoji/代理对（右溢 1-2 列被 shot 裁）；charW/lineH 探针不随主题失效（重开墙自愈）；>32 会话主机第 33+ 格静默空白；spec 64 卫生扫描器面缺墙钮族；离线格 cursor:text 可点入（errFlash 兜底）；Win/Linux 大屏键入无粘贴路径；solo 隐藏格不发 fit/首次留存不覆盖/迟到回执臂的 spec 化；fit 与 restore 的 core 侧排序保证（前端已缓解）。

## 十、复审修复后回归

- core-session **192/192**（fit/restore id 寻址断言入内）+ session-api 单包绿；fmt 清账；tsc 0。
- spec65 **42/42**（+1：300ms 节拍回归网）；UI 全套 **1126/1126**（result.json）。
