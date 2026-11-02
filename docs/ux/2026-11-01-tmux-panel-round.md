# tmux 面板轮：一个标签里并排看多个 tmux 会话（2026-11-01）

用户诉求（原话要点）：「标签窗口里面有多个 tmux 子窗口，这些子窗口是不同的 tmux 会话」——「我个人喜欢打开多个 claude code，每个都是一个 tmux 会话，我不希望一个 tmux 会话里面启动多个 claude code，不太好控制，会话挂了影响面也太大」。

产品定位：tmux 自身做不到（一个客户端同一时刻只看一个会话），iTerm2 的 tmux 集成仅 macOS。本轮给 Windows/Linux/mac 用户同一能力：**一条 SSH 连接、一次认证门，N 个 tmux 会话各占一格同屏实时**。

## 交互形态（寄生快接钮，界面零新概念）

- 会话工具栏的 tmux 快接钮菜单：每行 = 主项（切换主视图，原语义不变）+「＋面板」（并入本标签的格子网格）。
- 禁用原因写进 title：主视图正在看 / 已在面板中 / 分屏模式下不可并入（先退出分屏）/ 面板最多 5 个窗格。
- 网格：主视图 + 格子按 `paneGrid` 平铺（1→1、2→左右、3–4→2 列、5–6→3 列；末行不满则均分整行，tmux tiled 同观感）。主视图与格子都带 22px 标题栏（会话名；格子带 × 关闭）。
- 格子：独立 xterm（字体/主题/光标/滚屏跟随偏好热更），键入、粘贴（含多行与危险命令确认）、⌘C/V/A、Ctrl 控制字符全部投给该格的通道，主会话 `send_keys` 一字节不代收；格内右键 = 复制/粘贴/全选/关闭窗格。
- 关闭窗格 = 只拆客户端（detach 语义），**远端 tmux 会话与其中进程继续运行**（toast 明说）。
- 掉线：连接一断（300ms 状态事件）格子立即蒙灰，标题栏显示「已断开 · 重连后自动恢复」，旧画面保留；重连成功后**原位换装**（新 pane_id、顺序不变、尺寸沿用）。面板在场时断线横幅缩半宽居右，格子不被整盖。
- 远端结束（用户在格子里 `exit` / `C-b d` / 会话被 kill）→ 格子摘除，不会被强行拉回。

## 关键设计决定

1. **同连接附加交互 PTY 通道**：`ChannelHandle::open_interactive_channel(cmd, cols, rows)`（默认不支持；SSH 实现 = `channel_open_session` + `request_pty` + `exec`）。命令是通道引导期启动项，前台还没有交互程序——坑 84 的注入难题天然不沾，主 PTY 零字节扰动。
2. **`tmux -u attach -t '=名'`**：exec 通道是非交互 shell，LANG 可能缺失，tmux 会把宽字符画成 `_`（claude code 满屏 Unicode）；`-u` 强制 UTF-8。`=名` 走既有 `tmux_selector`（≥3.1 精确匹配）。
3. **输出两级缓冲**：transport 层引导期积压（订阅前字节，与广播同锁线性化，防「已订阅未取积压」空隙重复）+ core 层 `PaneMux` 单订阅者积压（前端格子订阅即接走，attach 首屏不丢）。面板是纯流视图：无屏幕、无重放环、无检查点。
4. **愿望清单 + 死亡分流**：`pane_wishlist` 是格子顺序与重建的唯一事实源。死亡时按远端是否发过 exit-status/exit-signal 分流：`exited` → 摘格摘清单；掉线 → 条目保留 `dead=true`（快照 alive=false）待重建。
5. **重建**：挂在 `reinject_integration` 尾（自动/手动重连两路都经过，且状态已过 Reconnecting），单格掉线且连接健康时也触发；串行锁内重读现状防双开；失败三分类——Transient（探测通道失败/掉线途中，保留）/Gone（`has-session` 确认不存在，摘除）/Fatal（撞主视图等，摘除）。`has-session` 三态：存在 / 确认不存在 / 无法判定，**无法判定绝不当不存在**。
6. **防呆矩阵（双向）**：同名格、撞主视图、未知会话、格数上限 5、非法名、未连接；反向——已在格子里的会话不能 attach 进主视图（同一会话不做两路视图：tmux 多客户端共享当前窗口，两格同步翻页让人看不懂）。
7. **面板与分屏互斥**：分屏模式下格子隐藏、「＋面板」禁用（几何体系不叠加）。
8. **mac 原生 Ctrl 拦截**：`note_terminal` 多报 `pane_id`，NSEvent 拦截改投格子通道（否则 macOS 中文输入法场景下格子里的 Ctrl+C 会打进主视图前台进程）。
9. **审计**：`tmux_pane_open`（含 rebuild 标记）/`tmux_pane_close`/`tmux_pane_ended`。

## 实现面

- session-api：`InteractiveChannel` trait（write/resize/subscribe_output/is_alive/exited/close）、`ChannelHandle::open_interactive_channel` 默认实现、`PaneInfo{pane_id,tmux_session,alive}`、`SessionInfo.panes`（serde default）。
- transport-ssh：`SshPaneChannel`（读泵、同锁积压、真 CHANNEL_CLOSE、exited 记录）。
- core-session：`TmuxPane`/`PaneMux`/`PaneOpenError`/`PANE_MAX`；`pane_open_inner`（新开/重建共用）、`spawn_pane_rebuild`、`spawn_pane_pump`（死亡分流 + 在册校验）、五个 `tmux_pane_*` 方法、`close_session` 收格、`tmux_attach` 反向防呆、`list_sessions` 按清单序产出。
- src-tauri：`tmux_pane_open/close/resize/input/subscribe` 五命令（订阅走 IPC Channel 原始字节直通）、`note_terminal` 加 pane_id、mac 拦截改投。
- 前端：`ui/src/terminal/pane-grid.mjs`（+ .d.mts，App 与 spec 共用）、App.tsx（格子工厂/订阅/销毁/布局/对账 effect/开关格/按键与焦点路由/粘贴落格/右键命中/热更循环）、session-toolbar（菜单行改造 + 4 个新 props）、ctx-menus（格内右键菜单）、wire/bridge 类型、demo 全镜像（含 `demo_tmux_fixture`/`demo_pane_exit` 演示专用命令）、i18n EN 16 条、styles（格子/标题栏/蒙灰/菜单行/横幅缩半宽；焦点用 outline——墨水屏铲阴影不受影响）。

## 自审揪出并修复（写完重读 + 测试 + 走查）

| # | 问题 | 修法 |
|---|---|---|
| 1 | 重建复用新开入口，被「清单已含此名」去重拦下——**重建永远失败** | `rebuild` 参数：重建不查重、不入清单、原位替换同名死条目 |
| 2 | 掉线途中 `has-session` 探测失败被当成「会话不存在」→ **一次断线清空愿望清单** | `has-session` 三态 + 失败三分类，只有确认不存在才摘 |
| 3 | 用户在格子里 `C-b d`/`exit` 后被立刻重新 attach——**关不掉** | transport 记 exit-status/exit-signal，core 按 exited 分流摘除 |
| 4 | 重建挂在 reconnect 成功瞬间，状态仍是 Reconnecting，被状态门拒 | 挪到 `reinject_integration` 尾；重建模式状态门放宽为「非断开/关闭」 |
| 5 | transport 积压补放与读泵无共用锁，空隙里的块会收两次 | 积压推入/广播/补放同锁线性化 |
| 6 | 关格只置旗标没发 CHANNEL_CLOSE，远端 tmux client 一直挂到断线 | `ChannelWriteHalf::close()` 真关闭 |
| 7 | 「用户结束」通知借状态事件发送，会把 Reconfirming 改写成 Connected | 删除该通知，前端靠 3s 快照对账 |
| 8 | 旧泵迟到的死亡处理按名字摘除，会误伤用户刚重开的同名新格 | 死亡处理先做在册校验（`Arc::ptr_eq`），不在册静默退出 |
| 9 | 断线横幅缩半宽的选择器写成后代，`.dead-overlay` 实为 `#term` 兄弟——**从不生效**（spec 63 计算样式断言抓出） | 改兄弟选择器 `~` |
| 10 | 主视图沿用分屏浮动名牌，压住首行文字（视觉走查） | 网格模式下名牌改 22px 标题栏，padding-top 让位（fit 自动扣除） |
| 11 | 掉线后格子要等 3s 清单轮询才蒙灰（视觉走查） | 有效存活 = 快照 alive ∧ 会话已连接（300ms 状态事件驱动） |

## 真机走查（2026-11-02，腾讯-广州 / tmux 3.4 / Ubuntu）

环境：release 构建（custom-protocol）+ **vault 库副本**（`TINYSSH_DB` 指向临时目录，主密钥照常取系统钥匙串；走查后副本删除，用户真实库零写入）+ `TINYSSH_WEBVIEW_ARGS=--remote-debugging-port` CDP 驱动真 app。该主机 shell 集成关闭，远端核验一律走主视图 `send_keys` + 读屏标记（标记由 shell 算术展开生成，命令回显里是 `$((…))` 原文，不会误配）。只碰自建的 `tspwt-*` 会话，走查前后核对其余会话清单原样（本次为空），收尾逐个 `kill-session`，不用 `kill-server`。

| 阶段 | 覆盖 | 结果 |
|---|---|---|
| 一 | 建连→静默探针 available→菜单「＋面板」开两格→远端客户端在线且 `client_utf8=1`（`-u` 生效）、TERM=xterm-256color→几何（A 右上半宽、B 末行整宽）与远端客户端尺寸同比例（48×10 / 98×10）→物理键入各进各的会话→格内物理 Ctrl+C 打断 `sleep 888`，主视图半截命令行完好 | 18/18 |
| 二 | 防呆三类→× 关格真 detach（远端客户端消失、会话仍在、5.5s 不闪回）→重开→**真实掉线**（守卫式 `kill -9` 本连接的 sshd 会话进程：父进程必须是 sshd 才动手）547ms 两格蒙灰→自动重连 1s 内原位重建（新 pane_id、同序、掉线前输出仍在、重建后可键入）→C-b d / exit 摘格→上限 5（核心开 5 格前端对账建出、第 6 格拒、菜单禁用写原因）→主视图防呆双向→关会话后远端零残留客户端 | 29 项 27 过 **2 红** |
| 三（修复后） | 防呆报错原文（同名/未知/反向/非法名）→摘格时延 C-b d ×3、exit ×3（含刚出生即结束）→掉线格子保留不被误摘→重建换装时延→主视图标题 `tmux:名`→关会话收格时延 | 17/17 |
| 注入探针 | 会话名 `x';touch /tmp/tspwt-pwned;'` 开格与 attach 均在拼命令前被拒，远端无落地文件 | 3/3 |

**走查揪出 2 处（demo 套件全绿测不出）并修复：**

1. **格子结束后迟迟不收（体感 6~9s）**：对账给**所有**格子按出生时刻算 6s 宽限（原意只护乐观开格），重建换装或新开不久的格子一结束，要挂到「出生 6s + 下一轮 3s 快照」。修：`refreshLists` 记快照**请求时刻**，格子出生改单调时钟 `performance.now()`——快照请求晚于格子出生，缺席才算真缺席；出生前发出的在途旧快照无论何时到达都不摘（乱序到达同样成立），比「按名单确认过就不再保护」更稳（后者会被乱序旧快照误杀）。
2. **只能干等 3s 轮询**：`tmux_pane_subscribe` 桥在核心侧流终结（格子被摘：用户结束 / 重建换装 / 会话关闭；pane_id 永不复用）时补发 JSON `"eof"`，前端收到即刻对账，同键 5s 内不因在途旧快照重建。掉线期的死格仍在核心册上、流不终结，格子照旧保留蒙灰。demo 四条结束路径（关格/远端结束/重建换装/关会话）同步发 `"eof"`。

修复后实测：C-b d 摘格 572–587ms、exit 摘格 581–687ms（含键入与远端 shell 退出），重建换装 109ms（旧路径最长等 3s），关会话收格 301ms。审计链与走查动作逐一对得上：`tmux_pane_open` 20（含 `rebuild:true` 4）、`tmux_pane_ended` 8、`tmux_pane_close` 1。

**走查实况记录（非本轮引入，待拍板）：物理 Ctrl+B 到不了 tmux。** Windows/Linux 默认键位表把 Ctrl+B 绑「主机栏」，终端聚焦时直发层按「被表占用即豁免」放行给动作层——格子里（以及主视图 attach tmux 时）按 Ctrl+B 是开关主机栏，tmux 前缀收不到，C-b d / C-b [ / C-b c 全部无法物理键入（macOS 是 ⌘B，不受影响）。溯源：10-14 直键三键轮登记的取向是「Ctrl+F/K/B 终端聚焦下仍归 shell」，同日键位配置轮（42c2657）把豁免从写死 T/W/D 推广为「表内全豁免」，默认表又含 K/B/F，取向随之翻转。走查里的 C-b d 用例因此改经格子通道直发 `\x02d` 验证核心语义。

## 验证矩阵

| 项 | 结果 |
|---|---|
| cargo fmt --check | ✓ |
| clippy 全工作区 | 0 error；**零新增警告**（警告行号逐条比对 30 个 diff hunk + 2 个新文件；首轮判出 4 条本轮新增已修） |
| cargo test --workspace --exclude tinyssh-app | 410 passed / 0 failed |
| 面板状态机单测 pane_tests | 7/7；**变异验证**：三个已修 bug 原样注回，对应用例全部转红 |
| cargo check -p tinyssh-app | ✓；走查修复后 release 构建 ✓、`cargo clippy -p tinyssh-app` 2 条存量警告（main.rs:1648/3251）均不在本轮 diff hunk 内 |
| tsc / vite build | 0 错 / 34.9s |
| 三主题校验器 | 32 态全过（新样式只用既有色板变量） |
| spec 63（新增） | 39/39（首跑抓出 #9；真机走查后 +2：远端结束 1.2s 内摘格、关会话 1.2s 内收格） |
| 变异验证（走查修复） | W1 对账退回「出生 6s 宽限」→「远端结束即刻摘除」确定性转红；W2 去掉流终结信号 → 摘格与关会话两条转红；源文件 finally 还原 |
| 全套 UI | **967/967 全绿**（55 spec；928 + spec 63 的 39 条，计数链自洽；30-split 40/40、61/62 tmux 无回归；走查修复后重跑） |
| 视觉走查（demo 截图） | 3 格 / 5 格 / 掉线即时蒙灰 / 墨水屏 / 菜单禁用态（截图存 `.zcode/tmp/pane-shots/`，不入库） |
| README 双语 | Highlights 新增「tmux 一等公民」条（恢复现场 + 面板 + Agent 分窗三合一，前两轮漏写一并补齐）；计数 54/928 → 55/967 共 4 处 |
| 真机走查（腾讯-广州） | 阶段一 18/18、阶段二 29 项 27 过 2 红（已修）、阶段三 17/17、注入探针 3/3（详见上节；截图存 `.zcode/tmp/pane-real/`，不入库） |

## 如实说明与立案

- **真 SSH + 真 tmux 已走查**（见「真机走查」节）。仍未覆盖：①**静默网络分区**（无 FIN、靠 keepalive 超时判死）——走查用服务端掐连接（TCP 立即关闭），格子走的是同一分支（通道结束且无 exit-status），差别只在判死延迟取决于 keepalive；②**真 claude code 多开体感**（走查用 bash/sleep 代替；ink 全屏重绘在窄格里的观感建议用户在 infer 系服务器上开 2–3 个 claude code 会话并格体感一次）。
- **mac 原生 Ctrl 改投**只在 release 工作流的 mac 构建里编译；本机缺 macOS 目标与 SDK，已逐行人工核对类型。
- **待拍板：tmux 情境下的 Ctrl+B**（见「真机走查」节末）。可选：①只在 tmux 情境（焦点在格子里，或主视图已 attach tmux）让物理 Ctrl+B 直发终端，其余场景主机栏快捷键不变（推荐：恰好覆盖 tmux 前缀，非 tmux 用户零变化）；②回到 10-14 取向，终端聚焦下 Ctrl+B/K/F 全归 shell（命令面板/搜索的键盘入口在 Windows 上随之变弱）；③维持现状，靠「设置 → 快捷键」自行改绑主机栏。
- 立案未做：格子拖拽换位/调比例；格子提升为主视图；布局跨重启记忆（愿望清单目前只活在会话内存里）；格子的 ⌘F 搜索与检查点/记录泳道；Agent 的 read_screen 看不到格子内容；tmux control mode（`-CC`）深度融合；同一会话被他机 attach 时的尺寸争用提示。

## 教训

1. **「重建」与「新开」共用入口时，守卫语义必须分开审**——去重/入清单/状态门三处在两种语义下答案都不同，本轮前 4 个 bug 全出在这里。写完状态机立刻自己重读一遍，比写完就跑测试更早发现问题。
2. **首跑全绿要做变异验证**：把修过的 bug 原样注回，确认对应用例真的会红（坑 74 同族的反面纪律）。
3. **判定脚本必须对「零输入」判失败**：execSync 在 Windows 走 cmd.exe，单引号 pathspec 被当字面量，「改动文件 0 个 → 零新增警告」是假绿；修正后真判出 4 条新增。
4. **长中文字符串经编辑参数传递偶发 U+FFFD 损坏**：锚点替换器在落盘前拒绝含 FFFD 的规格，本轮拦下 2 次；落盘后再全量扫一遍。
5. **CSS 结构假设只有计算样式断言能抓**：`.dead-overlay` 是 `#term` 的兄弟不是后代，后代选择器静默不生效，肉眼走查也容易漏。
6. **时限断言按用户体感定，不按实现能做到的上限定**：spec 63 原版「远端结束摘格」等 12s、注释还写着「含 6s 乐观宽限」——把迟钝写成了预期，demo 永远绿；真机走查一按 C-b d 就露馅。
7. **写「真机不可达」之前先查上一轮怎么做的**：初版台账称「本机无可自主使用的 tmux 远端」，而 10-29 两支柱正是用「release + 库副本/CDP + 腾讯-广州」走查的——同一通路这次揪出 2 处 demo 测不出的问题。
8. **宽限期别按出生计时**：保护乐观开格的正确判据是「这份快照是不是在格子出生之后才请求的」，而不是「格子还年轻」；后者会误伤所有刚由快照建出的格子（重建换装恰好全是）。
