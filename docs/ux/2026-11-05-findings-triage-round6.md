# 找茬六轮（2026-11-05）：双轨巡检 + 独立确认 + 21 条修复

基线 **11b56cd + 五轮 9 文件未提交改动**起轮（本轮巡检面=「五轮 diff 复审 + 未走过区域自由漫游」双轨）；用户指令「再到处看看是否有问题」（找茬系列第六轮）。

## 一、编队与产出

| 路 | 域 | 产出 | findings |
|---|---|---|---|
| A | Rust 性能/可靠性 | 五轮 core diff 复审 + core-local/transport/records/audit/mcp/term-core 漫游 | 6（AR-2 P3 + AF-1 P2 + P3×4） |
| B | 前端 | 五轮 ui diff 逐 hunk 复审 + monitor-store/agent/palette/mdview/SFTP/settings 漫游 | 10（BF-2 P2 + P3×8 + BR-11 nit） |
| C | 视觉截图 | 57 张截图（主题三族×亮暗/窄矮窗/五轮回归/自由漫游，真鼠标） | 3（C6-1 P2 + P3×2） |
| D | 操作习惯 | 6 条动线全走通（主机/SFTP/设置/记录/多会话/快捷键，真鼠标真键盘） | 4（D6-1 P2 + P3×3） |

合计 **23 条 → 独立确认员逐路证伪：CONFIRMED 21（P2×4）+ REFUTED 1（BR-1）+ 半 KEEP 1（BF-5 之 MCP 示例条）+ AF-4 锁部分证伪**。确认员实质改判/机理纠错 10 处，最重三条：C6-1 真因=checkpoint CUP 活动屏相对寻址错位+写解析/fit 竞速（非「预对齐高度」）；BF-2 demo 域被 300ms 馈送掩蔽、prod（事件驱动+sameShape bailout）才露真容；D6-1 是五轮 D-4 回焦修复放大的既有浏览器行为（Enter 默认动作激活当下焦点=刚回焦的 opener）。A 路确认员用最小 tokio 探针实证「mpsc send 挂起中丢弃=消息丢失」（AR-2 承重点）。

## 二、修复 21 条（全部亲核落地）

### P2×4
- **AF-1【P2】SFTP upload 吞远端写失败→截断文件按成功发布**：russh-sftp 管线化写（write_all 即返 Ok，错误滞留 ack 队列只在 flush/close 浮出），收尾 `flush().ok()`+`drop` 把尾部配额/ENOSPC 失败吞成 `Ok(total)`。修=`sftp_step(file.close(), …)?`（close=排干 ack+发 CLOSE+等 status，自带 30s 僵死护栏）。机理修正：drop 是 close_nowait 发而不等（非不发）；窗口满时错误可中途冒出，被吞的是尾部/小文件失败。
- **BF-2【P2】useMonitorSeries 死订阅→监控卡「等待首样」假死**：卡片 effect（子先于父）先于 syncMonitorTargets 跑→订阅退化为永久 no-op→rebuild 通知落空，订阅身份恒定永不重挂。修=模块级 `pendingSubs` 暂挂（条目缺席时订阅暂存，条目创建时接线+立即补通知）。
- **C6-1【P2】矮窗接入光标/回显漂移**（1280×600 光标钉垫行 abs12、敲一键 vy 0→9 内容全卷出）：ensureSessionTerm 预对齐(116×23)→applyCheckpoint 强拉 120×32 写网格→fit 缩 19=垫行塌缩+scrollback 沉底，checkpoint CUP 是活动屏相对寻址够不到沉底数据行。修=**applyCheckpoint 主缓冲裁尾**（裁到最后非空行与光标行的较大者，垫行不落 buffer→写入行数≤任何后续视口→缩/扩只是空行增删零毁损；备用屏不裁）。**xterm 缩行语义探针实测**（probe-c61-xterm.cjs 实验 C/D）定形修复；修复后四档视口全绿（ybase=0、光标=内容尾=提示符、回显贴提示符）。R3-C-1「按核心网格写入」的列语义不变（裁尾不影响列对齐理由）。
- **D6-1【P2】Enter 提交成功对话框「闪关重开」**（新建/编辑/快速连接三处）：提交成功关浮层→useDialogFocus 回焦 opener→同一 Enter keydown 的默认动作（合成激活 click，detail=0）落在刚回焦的 opener 上。修=add-host/quick-connect 的 `enterKey` 封装加 `e.preventDefault()`（一处封装三表全治）。

### P3×16 + nit
- **AR-2**：`SshPaneChannel::close` 改 as_ref 先发 Close、成功才 take（russh close=有界 mpsc send，取消落在挂起 send 里时 take 先行会让弃尾补发臂 take=None 永 no-op——确认员 tokio 探针实证消息丢失）。
- **AF-3**：records query 整文件物化+解密在过滤前→**倒序块读 RevLines**（256KB 块+跨块 carry 拼接，峰值内存全文件→单块；新增 2 测试红绿抓出「CRLF 剥 \r 口径」「文件尾 \n 后空段多产行」双 bug 后修正）。
- **BF-1**：monitor-store unsupported 臂只 return 本拍、poll 尾部照续=对已判非 Linux 主机每 3s 一枚 exec 永不停→tick general 门加 `!e.snap.unsupported`（retry 清标志下一拍自恢复；注释三处矛盾一并理顺）。
- **BF-3**：agent-view Enter 缺 keyCode 229 双查（全仓八处齐全唯独此缺，WKWebView compositionend 后补发 Enter 即发送）→补双查。
- **BF-4**：palette 输入框无 IME 守卫（方向键劫持候选词导航+Enter 直跑）→onKeyDown 头部双查 return。
- **BF-5**：i18n 裸键 5 处（mdview 代码块头「文本/N 行/展开全部/复制代码」、mmd 占位头、zoom 缩放 toast〔prod-only〕、ver-tag title、MCP 示例中文兜底）→消费点包 t()+EN 键 ×7；MCP 示例条按确认员裁定只包中文兜底（协议模板不译）。
- **BF-6**：quick-connect 五校验分支只报错不聚焦（与 add-host 契约不对称）→补 5 ref 聚焦链。
- **BR-5**：分屏组改名「回焦胶囊」是 no-op（span 无 tabIndex）+ 潜伏雷（补 tabIndex 后 Escape 回焦 blur 会提交丢弃的编辑）→胶囊 `tabIndex={-1}`+回焦只挂 Enter（Escape 删回焦，镜像标签路径口径）。
- **BR-6**：分屏成员拖拽悬停提示（插入位药丸）与落点裁决（exitSplit）脱节→hint 判据加 `!dragIsMember`。
- **BR-11**：EN 提示「Reconnect」与按钮实文「Reconnect & restore」不符→改齐。
- **C6-2**：TOFU pending 态操作组盖主机名（side 201/207px=97% 卡宽，:has(disabled) 常显击穿 T38-PV 设计意图；chip 折两行）→pending（connectingIds 在场）隐藏 ☆✎🗑 三钮让位+`.host-connect-btn` nowrap 省略兜底。修复后 side 占比 76%、名字不被盖、chip 单行。
- **C6-3**：⌘K palette 缺「分屏」条目（可发现性死角：搜「分屏/split」零结果，同量级复制/重命名/关闭都在列；palette 原始清单早于分屏成为高频动作）→「当前会话」组补条目（语义镜像标签 hover 钮）。
- **D6-2**：关活动标签激活落最左（惯例=右邻）→disconnectSid 焦点分支改右邻优先、无则左邻（termsRef 门控保留；✕/中键/Ctrl+W/右键同路径全治）。
- **D6-3**：设置→快捷键卡固定键位文案与域行为不符（demo 域 Ctrl 系是浏览器保留键）+漏 F11→文案按 inTauri 分支双键+补 F11（沿用「工具栏 palette 钮不广告浏览器里不存在的键」先例）。
- **D6-4**：新建主机 Esc/✕ 静默丢凭据草稿（122 字符 PEM 一按即丢；对照凭据分区有拦截卡）→模块级 `addHostCredDirty` 脏旗标（表单 effect 上报）+App 层关闭链（Esc/✕/取消三口共用 closeAddHost）双击确认（第一次 toast 提示、第二次真关）；同族 closeSettings 静默清 credPem 一并纳入（Esc 关设置同款双击确认）。纯连接信息草稿直接关（确认员建议：全字段拦截=过度设计）。
- **AF-2/AF-4/AF-5 立案不修**：AF-2 Linux-only 同步 df（Windows 纯 FFI 无子进程）降 P4；AF-4「锁跨 await」被证伪（append 全同步无 await，std Mutex 是哈希链串行化必需设计=KEEP）残余仅 async 上同步 fsync+CLI 共库跨进程 busy 最坏 5s 降 P4；AF-5 面板直播无界缓冲确认成立但堆积点在 Tauri ChannelDataIpcQueue（无界 HashMap）+webview eval 队列**双层下游**（core 侧 unbounded mpsc 是透明层）——修=有界可丢+失步重挂模式，涉及前端遮罩新机制，立案下轮。

## 三、回归与验证

- **cargo workspace 单遍**（exclude tinyssh-app）exit 0 全绿；records **12/12**（含新增 rev_lines/query 顺序 2 测试）；**零新增 warning**（stash 对照基线 31=31）。
- **tsc --noEmit** 0。
- **UI 全套单遍（Edge）**：见 §五补录。
- **定点回绿**（verify-r6-fix.cjs 12 ok + 确认员脚本复用）：D6-4 双击确认、D6-1 不重开+保存、D6-2 右邻、C6-3 palette 分屏命中、BF-4 229 不执行、BF-5 EN title、C6-2（side 76%/名字可见/chip 单行）；BR-5 Enter 回焦+Escape 不提交（首轮跑回绿）；BF-3 与 BF-4 同型守卫+确认员合成探针（修复前 229-Enter 发送实锤）；C6-1 四档视口 ybase=0/光标贴提示符/回显落点正确。
- 过程坑：grep 管道吃 cargo 退出码（坑 100 同族，workspace 首跑 E0786 rmcp 坏档被 exit 0 掩盖——cargo clean -p rmcp 重跑全绿）；verify 脚本三环境坑（标签=活跃会话不赌 KV 残留/坑 97 连接钮 hover 才浮现/四向互斥开面板=hostbar 卸载）。

## 四、本轮坑（新）

- **坑 101：grep/管道接 cargo 会吃掉退出码+坏档假绿**——workspace 首跑 rmcp E0786（构建缓存坏档）混在输出里但任务 exit 0（grep 管道尾部状态）。重跑前 `cargo clean -p <坏档 crate>`，退出码与 FAILED 行都要人工看。
- xterm 缩行 reflow 的毁损根源是「写入行数>后续视口行数」的垫行塌缩+scrollback 推顶（CUP 活动屏相对寻址够不到沉底数据行）——**修复正解=写入行数钳到内容尾（裁尾）**，事后 realign 修不动（tail<ybase 时光标物理不可达）。
- demo 域标签=活跃会话（连接后才出现），验证脚本清 KV 后必须走「点主机卡连接钮造标签」（连接钮 hover 才浮现=坑 97，四向互斥开面板=hostbar 卸载）。

## 五、补录（全套+发布）

- **UI 全套单遍（Edge 5183）1127/1127 一次过**（exit 0；spec65 42/42、spec63 125/125、spec60 25/25）。
- **release 构建**（custom-protocol）4m35s exit 0（warning 8 条=存量口径 transport-ssh 1+core-session 7）；端口清零验证后重启应用 PID 20692 活过启动窗。
- **视觉验证 10 ok + 截图目检**（verify-r6-visual.cjs）：矮窗四档接入态截图（r6v-short-*.png，ybase=0/光标贴提示符行/敲键回显落点正确）、D6-1 提交后对话框不在场+主机卡出现（r6v-d61-after-enter.png）、TOFU pending 卡目检（r6v-tofu-pending.png：**r6vis 名字完整可见、☆✎🗑 三钮消失、「等待指纹确认」单行省略+取消钮**——探针 nameVisible=false 为 flex 盒宽点选取差异，以目检为准）。
- 过程补记：run.cjs 不自起 dev server（5183 须外部先起，环境失败 exit 2 提示语即说明）；视觉脚本清 KV 后新会话新 sid（`__t_terms` 取首个而非钉 s-demo-0001）。

## 六、立案（未修，下轮随带）

- AF-2【P4】Linux/BSD 本机监控 df 无超时（Windows 无此路径；修=spawn_blocking 或 killed 超时）。
- AF-4【P4】audit append 同步 fsync 在 async worker（CLI 共库跨进程 busy 最坏 5s；锁本身是哈希链必需设计 KEEP）。
- AF-5【P3】tmux 面板直播双层无界下游（Tauri ChannelDataIpcQueue+webview eval 队列，webview 冻结场景内存随输出增长；主终端对照=broadcast 4096+Lagged→resync。修法=有界可丢+失步重挂，涉及前端遮罩新机制）。
- BF-5 之 MCP 示例：协议/配置模板不译（半 KEEP，中文兜底已包）。
- D 路打磨注记（确认员/巡检员记录未立案）：主机分组无折叠、搜索框无 ✕ 清空、无「复制主机」、SFTP 无重命名/删除/复制路径/新建目录、重复标签文案相同难辨认、遮罩语义不一致（设置点遮罩即关 vs 新建主机不关）。
- 沿袭立案：五轮 §五 5 条 + 四轮立案段不重复。

## 七、证据脚本（未跟踪，随取随删）

ui/test/probe-c61-xterm.cjs（xterm 缩行语义实验）、probe-c61b-verify.cjs（矮窗四档回绿）、verify-r6-fix.cjs（定点回绿）、dbg-staging.cjs/dbg-tofu.cjs（环境 debug）；四路巡检/确认员脚本 walk-r6c*.cjs / walk-r6bc*.cjs / walk-r6cc*.cjs / walk-r6cd*.cjs；截图 ui/test/.shots/r6c*（gitignored）。
