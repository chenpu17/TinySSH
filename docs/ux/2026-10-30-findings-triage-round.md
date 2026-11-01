# 找茬 triage 轮：三路审查 → 亲核 → 落地（2026-10-30）

用户指令：「多审核与验证下本项目，多发现问题与改进点（也包括视觉、用户操作体验等等），经过 subagent 确认的问题与改进点，进行修改落地并审核验证。」

基线 v0.10.7（d90daec，工作树干净）。流程：动态视觉巡检（demo 26 态截图）→ 三路 subagent（视觉 / 前端 UX / Rust）→ 亲核每条发现（含存疑项真鼠标复核）→ 落地修复 → 全量验证。

## 审查产出与裁决

### subagent ①（视觉，26 张截图）

**确定 6 条，全修：**

| # | 级别 | 问题 | 修法 |
|---|------|------|------|
| V1 | P2 | 命令面板 tooltip 广告 Ctrl+K/⌘K，但 demo 域 actions.ts native 门拦下快捷键，Ctrl+K 进 PTY（截图光标下移一行实锤 ^K） | tooltip 按 inTauri 条件化：demo 域只说「命令面板」不广告键位（App.tsx） |
| V2 | P2 | Fleet 编排视图演练欢迎语照抄单会话版「这里是每会话独立的 Agent 对话」——与编排形态自相矛盾 | agent-mock.ts 新增 FLEET_WELCOME_MD（跨主机编排者措辞），agent-view 两个种子点按 fleet 分流 |
| V3 | P3 | 协作审批卡按钮多到换行时「拒绝」孤悬左端第二行 | 拒绝钮 `margin-left:auto` 钉右（破坏性动作与批准族分区） |
| V4 | P3 | 转发表单 placeholder 与 label 重复（「本地端口」+「端口」×2） | placeholder 改示例值 8080 / 22 |
| V5 | P3 | 命令块「输出✂」两字符挤在一起 | 「输出 ✂」加空格 |
| V6 | P3 | 980px 窄窗监控条隐藏指标后右侧死空白 | **立案不动**（正解=按剩余空间逐段回收，属 metrics.tsx 布局小改版） |

**存疑 5 条，复核后 4 条排除：**
- 「分屏菜单常驻 13 张截图不关」＝探针合成 `el.click()` 绕过命中测试的假象——真鼠标点外部验证**必关**（r3 截图）；分屏未发生也是探针漏点目标行（菜单是「方向分段+目标行」两段式，r2 实拍）。
- 「监控三张截图全同」＝探针用错 testid（实为 `mon-sw-general-big`），真点击后卡片立现（r10，cards=1）。
- 「大屏打不开 / 设置打不开」＝四向互斥把主机栏藏了，探针点空气。
- 「浅色主题失效」＝`dataset.chrome` 是过时 hack，现走设置→外观「应用外观」分段钮。
- 记录泳道 198 个完成点叠成实心绿带＝demo 数据密度观感，真实稀疏数据待验证，立案观察。
- 另发现：监控条 CPU/网络「——」非 bug——激活后首个差分窗（<3s）内无值，两次截图都恰好拍在窗内。

### subagent ②（前端 UX 逻辑）

**P1×2（真 bug，全修）：**
- **FE1** `loadBlocks` 无 sid 守卫：5s 轮询在途时切会话，旧会话块列表覆盖新会话展示，点「重跑」会把**旧会话的命令以新会话 sid 发进 PTY 执行**。同文件 refreshBrief/loadDir/refreshForwards 都有守卫唯它漏。修：await 后三处补 `sidRef.current !== s` 守卫。
- **FE2** SFTP 首载链吃过期 brief：切到无浏览快照的新会话时，`brief` 还是上一会话的（refreshBrief 在途），首载链拿**旧 cwd 对新会话**起载 `sftp_list`——面板停在错误目录或闪错。SessionBrief 无 sid 字段前端无从判别。修：`briefSidRef` 在 refreshBrief 成功时记归属，首载链门加 `briefSidRef.current === sid`。

**P2×3（全修）：**
- **FE3** `LOG_ACTION_OPTIONS` 模块 import 期调 t()（i18n 铁律唯一违例）：en 启动后切回中文，「事件类型」下拉恒英文。修：数组存原中文键，消费点本就 `t(o.label)`，渲染期解析；排序按中文原序不变。
- **FE4** 裸中文批次 ×9：退出分屏钮文本、专注浮条「接管/接管并停止」、标签分屏钮 title/aria、tab-x aria、「，在分屏中」「，⌘N」、标签滚动钮 title、palette 两组头「当前会话」、Fleet hostLabel「跨主机编排」。全 t() 化 + i18n.ts 补 13 条 EN 键（方向单字「下/右/上下/左右」复用 ctx-menus:140 既有实践，坑 67 排查过无冲突）。
- **FE5** metrics.tsx `togglePause` 的 `localStorage.setItem` 未包 try——读取路径专门防了 SecurityError，写路径漏防，隐私模式下点暂停钮即抛。修：包 try。

**P3×6（全修）：**
- **FE6** 标签列表菜单「重连」点击后菜单不关（同菜单其它钮都先关）——补 `setTabsMenuOpen(false)`。
- **FE7** Esc 浮层链缺监控大屏/广播输入/传输抽屉——纯键盘用户无出口。三处补进链（大屏→广播→抽屉，置于 palette 前）。
- **FE8** 「转手工表单」prefill 在 Esc 链与工具栏「＋」两条关闭/打开路径不清理，下次开新表单带陈旧 ssh-config 条目——两处补 `setPrefillEntry(null)`。
- **FE9** 确认框「仍然重跑」失败静默（`.catch(() => {})`）——补重跑失败 toast（复用既有键「重跑发送失败」）。
- **FE10** 恢复现场时间戳硬编码 `toLocaleString("zh-CN")` ×2（App.tsx 恢复公告 / welcome 上次现场）——改随 `localeNow()`。
- **FE11** 快速连接 `busy` 恒 false 纯装饰（setBusy 无调用），Enter+点击同帧可双发——submit 入口 `setBusy(true)`，同步异常复位并显错。

**存疑 3 条：**
- S1 真模式 agent_history 快照对 120ms 合帧窗口内实时事件的覆盖竞态——需真机配模型服务复现，立案。
- S2 迟到终态在 attemptFinalRef 的单条滞留——无行为影响，立案顺带。
- S3 demo 域 300ms 全量状态重放无同值短路——demo 域本质，真域按跃迁发射，立案观察。

### subagent ③（Rust，近四轮改动面）

**P1×1（真 bug，全修）：**
- **R1** **Windows 网速监控读的是单播包数不是字节数**：MIB_IFROW `phys_addr: [u8; 12]` 应为 `[u8; 8]`（SDK ifmib.h `MAXLEN_PHYSADDR == 8`，头文件注释自述「一直定义为 8」）——admin_status 起全部字段错位 +4：`in_octets` 实读 `dwInUcastPkts`、`out_octets` 实读 `dwOutUcastPkts`，网速列单位全错且量级差 4 倍+。三重实锤：SDK 头 + `offset_of!` 实测（Rust in_octets=556 vs C dwInOctets=552）+ 本机 PowerShell 直调 GetIfEntry 对照（InOctets 128M vs InUcastPkts 32M）。真机走查没抓到的原因：注释里「部分机器报 NON_OPERATIONAL」的观测本身就是错位读 dwLastChange 的伪观测——bug 制造了自己的不在场证明（坑 74 同族：FFI 无跨检静默假绿）。修：`[u8; 8]` + const 块钉死五个关键字段偏移（admin_status=540/oper_status=544/in_octets=552/out_octets=576/descr=604）+ 注释重写；「不按 oper_status 过滤」的决定保留但理由更正（坑 60 + 隧道 miniport 也有真流量）。

**P2×1（立案）：**
- **R2** `tmux_attached` 单向置位从不复核：用户 `C-b d` 手动脱离（或首次 attach 注入被前台程序吃掉——坑 84 立案场景的放大器）后，Agent Shell exec 持续静默分流进无人观看的 tmux 专窗。修法方向（立案）：分流前 `tmux list-clients -t =name:` 核对至少一个客户端在场，代价是每命令 +1 RTT 需实测；或探测 detach 键序列。本轮不动 exec 热路径。

**P3×5（修 4，1 条已接受）：**
- **R3** 探针解析对合法奇异会话名不健壮：名叫 `tmux 5` 的会话行被 `strip_prefix("tmux ")` 吃成版本行（会话凭空消失 + version 污染）；名含 `|` 整行丢弃。修：版本行加形状闸（无 `|`）；会话行**从右侧** `rsplitn(3)` 解析（窗口/附着恒为末两个数值段，名字任意内容都保真）。**纯解析器修法，探针命令/demo/spec 零扰动**。单测补两例敌意用例（`tmux 5`、`a|b`）。
- **R4** `open_url` scheme 白名单大小写敏感（RFC 3986 scheme 不分大小写）——改 `split_once("://")` + ascii_lowercase 比对，不引新依赖。
- **R5** 改道面加固两处：reqwest 客户端 redirect 策略禁跨 scheme（https→http 降级在 Policy 层停）；清单内 `entry.url` 载荷直链下载前过 `endpoint_override_allowed` 同款门（https 任意 / http 仅回环）。纵深防御——验签最终会拦，但不该走到那一步。
- **R6** `updater_install` 无后端重入门（防连点只靠前端）——`INSTALL_IN_FLIGHT` AtomicBool + RAII Drop 抬闸。
- **R7** tmux 专窗收割失败路径（通道死/协议不匹配）out/rc 文件对残留远端 /tmp——两失败分支补 `rm -f` 清尾。
- ~~R8~~ 改道模式「打开发布页」实为产物直链——便携轮已记录的**已接受风险**，不重复修。

**存疑 3 条（附验证方法，记录在案）：** GitHub API 匿名 60 次/时限流边界；fish 登录 shell 下 run_tmux_window 全链路无真机实测记录；tmux 会话名含换行的极端场景。

## 落地清单（17 处代码 + i18n 14 键）

- ui/src/App.tsx：loadBlocks 守卫 / briefSidRef+首载链门 / 退出分屏文本 / palette tooltip 条件化 / 接管双钮 / tab-split title+aria / tab-x aria / aria「，在分屏中」「，⌘N」 / tab-scroll title / palette 组头×2 / Fleet hostLabel / Esc 链三口 / prefill 清理×2 / 重连关菜单 / rerun 失败 toast / 恢复时间戳 / 转发表单 placeholder×2
- ui/src/app-data.ts：LOG_ACTION_OPTIONS 去 import 期 t()
- ui/src/metrics.tsx：togglePause try
- ui/src/components/welcome.tsx：时间戳 locale
- ui/src/components/quick-connect.tsx：busy 真生效
- ui/src/components/collab-panel.tsx：拒绝钉右
- ui/src/components/blocks-panel.tsx：输出 ✂ 空格
- ui/src/agent-mock.ts：FLEET_WELCOME_MD
- ui/src/components/agent-view.tsx：两个种子点 fleet 分流
- ui/src/i18n.ts：+14 EN 键
- crates/core-session/src/local_metrics.rs：MIB_IFROW [u8;8] + 偏移断言 + 注释
- crates/core-session/src/lib.rs：parse_tmux_probe 加固 + 单测 ×2 例
- crates/core-session/src/handle.rs：收割失败清尾 ×2
- src-tauri/src/main.rs：open_url scheme 大小写 / no_downgrade_redirects / entry.url 门 / INSTALL_IN_FLIGHT 重入闸

## 立案未修（等拍板）

1. **tmux_attached 复核**（R2）：list-clients 核对方向 + 每命令 +1 RTT 代价评估，或 detach 键序列探测。
2. **窄窗监控条死空白**（V6）：metrics.tsx 按剩余空间逐段回收。
3. **agent_history 合帧窗口竞态**（S1）：需真机模型服务复现。
4. attemptFinalRef 单条滞留（S2）/ demo 全量重放渲染（S3）/ 记录泳道 demo 密度观感 / GitHub 匿名限流注释 / fish 全链路真机实测——低优观察项。

## 验证记录

- Rust：workspace tests（exclude tinyssh-app）全绿 0 failed（48 目标）；tinyssh-app `cargo check --features custom-protocol` 绿（55s）；clippy 全仓 0 新增告警（两处命中均为既有代码：FILETIME:16 / tmux_selector map_or:4892）；fmt 清账；core-session 专项：tmux 4/4（含新敌意用例）、local_metrics 快照形状 1/1（偏移断言编译过=布局契约生效）。
- 前端：tsc 0 错；vite build 绿（44s）；**UI 全套 909/909**（54 spec，60 i18n 16/16、61 tmux-restore 28/28、55 monitor 50/50、30 split 40/40 全数过——改动未伤任何既有断言）。
- spec 断言面排查：ctx 菜单文案、spec 30 的「下」匹配（新 title「放到下侧分屏」仍含）、placeholder/aria 均无 spec 硬编码命中。
- 中途事故如实记录：首次全仓测试 E0786 invalid metadata（cargo 缓存损坏，与改动无关），`cargo clean -p rmcp -p tokio -p serde` 后重跑全绿。
