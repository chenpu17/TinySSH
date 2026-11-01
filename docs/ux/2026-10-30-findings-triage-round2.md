# 找茬 triage 二轮：三路 subagent 换区审查 → 亲核 → 落地（2026-10-30）

用户指令同前轮（多审核验证、发现问题与改进点、经 subagent 确认后落地并审核验证）。基线：上轮 24 条修复未提交的工作树。流程：三路 subagent（Rust 后端深审 / 前端组件深审+上轮 diff 复核 / 视觉 UX 真浏览器走查，坑 62 串行派发）→ 逐条亲核 → 落地 → 全量验证。脚本/截图存 `.zcode/tmp/{fe-round2,ux-round2,shots-ux2}`（不入库）。

## 审查产出与裁决

### subagent A（Rust 后端，transport/vault/audit/MCP/审批链/生命周期）——6 条全实锤全修

| # | 级别 | 问题 | 修法 |
|---|------|------|------|
| R2-1 | P1 | **exec env 的键未校验未转义**：`env K='V' sh -c '<cmd>'` 中键原样拼进远端 shell 命令行（transport-ssh run_fresh）——MCP ExecReq.env 外部任填，键含 `$(…)`/反引号即命令替换（发生在 env 收到参数之前）、键为 `sh` 一类词改写执行结构；审批卡/审计只记 cmd 本体，**人批准 A、先执行 B**。上轮 S6 只修了值漏了键 | 键白名单 `[A-Za-z_][A-Za-z0-9_]*`，越界 `Error::InvalidInput` 拒绝 |
| R2-2 | P2 | **alive 标志跨连接代际共享**：旧输出泵临终 `store(false)`（EOF/Close）若落在新连接 establish 期间（russh disconnect 只投递不等待），新建康连接被判死 → pump 反复重连自翻搅，3 次上限永不触发；transport-pty respawn 同款（旧 ConPTY 读线程 teardown EOF 晚到 → 重连成功即误报 shell 退出） | `gen: Arc<AtomicU64>` 代际闸：establish/respawn 推进代际，泵/读线程死亡只在代际未变时写 false |
| R2-3 | P3 | -D SOCKS5 握手 `read_exact` 无超时：健康检查/误配探针连上不发字节 → 每连接挂死一个永不退出任务 | 调用点包 30s `tokio::time::timeout` |
| R2-4 | P3 | Remote 转发回程路由按**端口单键**索引：`-R 127.0.0.1:8080` 与 `-R 0.0.0.0:8080` 并存时后注册覆盖前者回程目标，入站接错且无从察觉 | `request_remote_checked` 注册前按条目查重（跳过自身 id——重连恢复不受影响），撞车报明确错误；库内既有同端口配置恢复时第二条转 Failed 可见不串台 |
| R2-5 | P3 | `upload` 先 `sftp.create`（TRUNC）远端、后开本地文件——顺序倒置，本地打不开会把远端清零（当前 stage_plan temp 编排掩盖了实害，契约层隐患） | 调序：先 `File::open(local)` 再 create |
| R2-6 | P3 | `pump_direct` 持 handle 锁跨无界 `channel_open_direct_tcpip` await：僵死网络下 close/stop_forward/exec 在该锁上排队（keepalive 兜底 ~10s，有界但钉死排队上限更对） | 通道开启包 15s timeout，超时按 `russh::Error::ConnectionTimeout` 走既有 Degraded 分支 |

### subagent B（前端组件 + 上轮 diff 复核）——10 条：P2×3 全修、P3×5 全修、存疑×2 立案

| # | 级别 | 问题 | 修法 |
|---|------|------|------|
| FE2-1 | P2 | t() 已包但 EN 表缺键 ×13（scan-t-keys 全量 1240 静态键 diff）：死会话横幅/重连钮/palette「连接 X」/aria 读中文/句尾全角「。」等 | i18n.ts +17 键（13 实缺 + 「。」 + 3 条无害透传不补：CPU/「 · {0}」/BEGIN 占位） |
| FE2-2 | P2 | self-meter 整块未接 i18n（标题栏 chip + 关于详版 EN 全中文）+ fmtUptime 裸中文单位（`t("运行 {0}", fmtUptime(…))` 包不住参数里的中文） | self-meter 逐串 t()；fmtUptime 加 `tr` 参数（渲染期传入 t，默认直通保纯函数调用方），metrics/monitor-view 调用点补传 |
| FE2-3 | P2 | App.tsx demo 引导块 5 处裸 `localStorage.getItem`——隐私模式启动 effect 抛 SecurityError 整树白屏（同块 applyTermQuality 早已包 try） | 本地 `safeGet` 统一包 try |
| FE2-4 | P3 | Esc 浮层链缺 `showQuickConnect`（FE7 同族漏网）：快速连接对话框无键盘出口 | 链中补一口 |
| FE2-5 | P3 | 剪贴板 `(inTauri ? … : navigator.clipboard?.writeText(x)).catch(…)` 7 处：`?.` 只短路由内链，外层 `.catch/.then` 挂在 undefined 上同步 TypeError（非安全上下文 demo 即炸）——含两处 readText 粘贴同款 | 全部 `Promise.resolve(...)` 包裹（copyBlock 既有模式） |
| FE2-6 | P3 | demo.ts 三处 localStorage 裸**写**（读全包了写没包） | 包 try（与 metrics togglePause 同口径） |
| FE2-7 | P3 | 标点级裸中文 ×3：collab「。」裸串 / activity-log `（{sid}）` / confirm-dialogs `（host、host）` | 并入 t()：「。」键（EN "."）、「（{0}）」键（既有）、join(t("、"))（既有） |
| FE2-8 | P3 | 时间戳 locale 跟系统不跟界面语言（上轮 FE10 只修了两处没扫尾）：records-pane ×4、settings-panel ×2 | `dateLocale()` 提为 app-data 共享导出（sftp-panel 本地实现一并收口），六处换用 |
| FE2-9 | P2 存疑 | monitor-store uSES 订阅先于条目创建 → noop 订阅首样延迟 ≤3s（App 高频重渲染兜底，无永久卡死观测） | **立案**：需断点/计时对比首样到达时刻再定 |
| FE2-10 | P3 存疑 | PromptSkillsCard blur 写与「清空」写无序竞态（旧值可能后落盘复活） | **立案**：需真机连点复现；修法方向=写前比对草稿 |

**上轮 diff 复核：14 文件逐一过，未发现上轮修复引入的回归**（quick-connect 顶部缺 `if (busy) return` 防御略弱——本轮顺手补上）。

### subagent C（视觉/UX 真浏览器走查，9 场景 95 截图真鼠标）——11 条：7 修、2 排除、2 立案

| # | 级别 | 问题 | 修法 |
|---|------|------|------|
| UX2-1 | P2 | 监控大屏采集开关 ON 态悬停 = 蓝底蓝字不可读：全局 `button:not(:disabled):hover`(0,2,1) 盖过 `.mon-sw.on`(0,2,0) 的 accent-soft——仓里 243/341/909 行已有三处同款陷阱前例 | `.mon-sw.on:hover` (0,3,0) 显式补背景/描边/文字色；真机 hover computed=accent-soft ✓ |
| UX2-2 | P2 | 新建主机表单重名/同址静默保存成功，主机栏出现两张一模一样的卡 | add-host 提交前查重（名称撞车一律拦；同地址+端口提示用既有条目；编辑排除自身），App 传 `hosts` prop；+2 i18n 键 |
| UX2-3 | P2 | Agent 面板关→开对话清空（切标签保留、关面板即丢，无从预期）；demo 域 convs 是组件态 | 演练域模块仓 `MOCK_CONVS`（上限 64 会话防累积）：种子 effect 优先取回、真模式 agent_history 装载时清演练残留（演练→真模型不串场）；真模式历史本由后端回放不受影响 |
| UX2-4 | P3 | 标签右键菜单键盘不可达（焦点不捕获、无箭头导航） | CtxMenus 加开菜单聚焦首项 + ↑↓ 循环移动（捕获段只拦方向键，Enter 原生激活、Esc 仍走浮层链）；真机 A1-A3 ✓ |
| UX2-5 | P3 | 重命名标签输入框预填不选中，直接键入变追加 | `onFocus select()` 全选（分屏组改名输入框早有同款——既有实践）；真机 A4 ✓ |
| UX2-6 | P3 | 表单校验 a11y 缺口：错误条无 role=alert、失败后焦点不跳出错字段；大屏 ✕ 关闭焦点落 body | add-host 四字段 ref + 各校验分支 focus + `role="alert"`；quick-connect 同款；大屏 onClose 焦点回 rail-monitor（Esc 路径走 restoreTermFocus 不变） |
| UX2-8 | P3 | EN 残留四类：调色板名 ×15（t() 已包纯缺键）/ palette「活动栏」hint 裸串 / Agent+Fleet 欢迎语整段 / 记录徽标（STATUS_LABEL 两处消费点漏 t()） | +15 调色板名键；hint 三处 t()；welcomeMd(fleet) 按界面语言分流（新增两段 EN 欢迎语）；徽标两处补 t()（键已在表） |
| UX2-9 | P3 | 980px+Agent 面板：会话工具栏「工具」钮被视口截断 11px（终端区被压到 ~477px 装不下按钮组） | `.session-toolbar` 改 `min-height:40px + flex-wrap:wrap`——装得下单行不变、装不下折行不裁切；computed ✓ |
| UX2-10 | P3 | SFTP：点列表空白不清选中；导航失败错误条与旧目录列表同屏易误读 | 容器 onClick target 判等清选中；loadDir/navigateTo 失败路径清 entries+选择（面包屑/路径不动） |
| UX2-7 | P3 | 互斥面板（Fleet/大屏/Agent）关闭后主机栏不恢复 | **立案不动**：四向互斥「关完要 rail-hosts 才回主机栏」是记忆在案的设计行为，改=产品拍板 + spec 面排查 |
| UX2-11 | P3 | 记录泳道密集刻度点不中 + 无悬停提示 | **半排除/立案**：`<title>` 悬停提示代码里一直在场（headless 不渲染原生 tooltip，agent 误报）；密集点击精度是 demo 200 条密度观感（上轮已立案观察），放大镜/滚轮展开另案 |

另：UX2-3 涉及真机 mock/持久边界已在 D1 探针验 demo 域行为；「CPU ——」差分窗、palette Ctrl+K demo 门控等前轮已知项未重复报。

## 落地清单（Rust 2 crate 8 处 + 前端 16 文件）

- crates/transport-ssh/src/lib.rs：env 键白名单 / alive 代际闸（字段+establish 推进+泵死亡守卫）/ SOCKS5 30s / 转发同口查重 / upload 调序 / pump_direct 15s
- crates/transport-pty/src/lib.rs：gen 代际闸（字段+respawn 推进+读线程死亡守卫）
- ui/src/i18n.ts：+34 EN 键（13 缺键 + 「。」 + fmtUptime ×3 + self-meter ×8 + 调色板 ×15 + 重名防呆 ×2 −「、」「（{0}）」复用既有）
- ui/src/App.tsx：demo 引导 safeGet ×5 / Esc 链 quick-connect / clipboard Promise.resolve ×4 / 大屏 onClose 焦点回 rail / add-host hosts prop / rename select / sftp loadDir+navigateTo 失败清场 / 「活动栏」hint ×3
- ui/src/agent-mock.ts：WELCOME_MD_EN/FLEET_WELCOME_MD_EN + welcomeMd(fleet) 分流
- ui/src/components/agent-view.tsx：MOCK_CONVS 演练仓三处接线 + welcomeMd 两个种子点 + clipboard
- ui/src/metrics.tsx：fmtUptime tr 参数 + 调用点
- ui/src/components/monitor-view.tsx：fmtUptime 调用点补 t
- ui/src/self-meter.tsx：t() 接线（chip + 详版）
- ui/src/components/add-host.tsx：重名/同址防呆 + 四字段 ref focus + role=alert
- ui/src/components/quick-connect.tsx：busy 顶部防重入 + role=alert
- ui/src/components/ctx-menus.tsx：菜单键盘导航（聚焦首项 + ↑↓ 循环）+ clipboard ×2
- ui/src/components/records-pane.tsx：徽标 t() ×2 + dateLocale ×4
- ui/src/components/settings-panel.tsx：dateLocale ×2
- ui/src/components/sftp-panel.tsx：dateLocale 收口 + 列表空白清选中
- ui/src/components/collab-panel.tsx / activity-log-panel.tsx / confirm-dialogs.tsx：标点 t() 三处
- ui/src/components/conn-detail.tsx：clipboard Promise.resolve
- ui/src/demo.ts：localStorage 裸写 ×3 包 try
- ui/src/app-data.ts：dateLocale 共享导出
- ui/src/styles.css：`.mon-sw.on:hover` 显式三色 + `.session-toolbar` min-height+wrap

## 立案未修（等拍板）

1. **env 进审批卡/审计可见面**（R2-1 深层）：键白名单已杀注入向量，但审批卡仍只记 cmd 本体——env 键值入审批摘要需动 core-session 审批面，另案。
2. **monitor-store uSES 首样延迟**（FE2-9 存疑）：需计时验证再定修法。
3. **PromptSkillsCard 写写竞态**（FE2-10 存疑）：需真机复现；方向=写前比对草稿。
4. **互斥面板关闭主机栏恢复**（UX2-7）：设计行为在案，改=产品拍板。
5. **泳道密集刻度放大镜**（UX2-11 余项）：title 已在场，精度问题随 demo 密度立案观察。

## 验证记录

- Rust：transport-ssh + transport-pty `cargo check` 绿；两箱 `cargo test` 绿；**workspace 全量 `cargo test --workspace --exclude tinyssh-app` exit 0**（与 UI 套件按 cargo×Playwright 纪律错峰）；fmt 首查两处格式差（env 键白名单表达式/socks5 超时缩进）已 `cargo fmt --all` 修正复查干净；clippy：本轮改动的 transport-ssh/pty 两箱 **0 新增**（命中 6 条均为既有：keepalive_rx dead_code ×2 / doc 缩进 ×3 / slice clone ×1；其余 crate 的告警（core-session 22 等）属未触碰的既有面）。
- 前端：tsc 0 错；vite build 绿（31.77s）；**UI 全套 909/909**（54 spec——含 60-i18n 16/16、55-monitor 50/50、30-split 40/40、61-tmux-restore 28/28，改动未伤任何既有断言）。
- 真机探针（demo 域真鼠标，`.zcode/tmp/ux-round2/verify-r2.cjs`）：**9/9 PASS**——A1 菜单聚焦首项 / A2 方向键移动 / A3 Esc 关菜单 / A4 重命名全选 / B1 重名拦截+role=alert / B2 同址拦截 / C1 快速连接 Esc / D1 演练对话关开保留 / E1 EN 调色板名。CSS 计算样式探针：session-toolbar wrap/40px ✓、mon-sw.on:hover=accent-soft 底 accent 字（修复前=accent 实底同色字）✓。
- 探针自身教训：demo 开机自带两个未接入会话标签（prod-1/staging-1），attach 绕 TOFU 门比走连接流程稳；demo 域 locale 走 KV `ui.v2.locale`（addInitScript 预置），无 ?locale= 参数；headless 不渲染原生 tooltip（坑 91）。
