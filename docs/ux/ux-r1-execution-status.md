# UX-R1 执行状态跟踪

> 基线：设计包 `7c4502e`（UX-R1 v1.1）· 执行者：Claude（FE/Core/UX 承担）+ 独立 QA；G0 由用户授权 Codex 代决策，R52/R53 真人验收与发布签署另行执行
> 任务定义权威：[实施任务与验收矩阵](ssh-client-ux-refactor-delivery.md)；本文件只记状态、证据路径与执行决议，不重复任务定义。
> 状态枚举：`待开始 / 实施中 / 待验收 / 通过 / 阻塞`。G0 已按阶段基线通过；G1 已授权、实施仍待开始。

## 0. 执行约定

- 每个实施类 R 任务（G1 起）收尾三件套：①真环境 e2e；②独立 code-reviewer subagent 对抗审核（实读代码 + 探针，file:line/严重级/失败场景）；③独立视觉复验 subagent（几何实测 + computed style + 双主题截图）。作者自查不算数。
- 同时运行的 subagent ≤6。
- 每任务一个 commit；阶段证据按交付文档 §6.2 存 `docs/acceptance/ux-r1/<gate>/<date-commit>/`，仅在真实运行后创建，不预填 PASS。
- G0 草稿与调研产物放 `docs/ux/ux-r1-g0/`；定稿评审后归档引用。
- 真人任务（R52）与 G5 发布签署仍由用户组织执行；G0 本轮按明确授权由 Codex 代决策，见签署单。模拟人格不计真人验收。

## 1. 阶段总览与顺序

| 阶段 | 任务顺序（按依赖） | 出口 |
|---|---|---|
| G0 | R04∥R00 → R03∥R01 → R02 → 联合评审 | 已按阶段基线通过；后续细节按签署单限定期限 |
| G1 | R10 → R11 → R12 → R13 → R15 → R14 | 新框架接真实核心；开关/resize 不破坏终端；非 demo-only |
| G2 | R19∥R24∥R20 → R21 → R22 → R23 → R25 → R26 → R27 | A、B 组验收通过；SSH 日常闭环 |
| G3 | R30 → R32∥R31 → R33 → R34 → R35 | C 组 + P4；真实文件摘要验证 |
| G4 | R40∥R41∥R42 → R43 → R44 → R45 | D、F、G 组；MCP/CLI 回归 |
| G5 | R50∥R51 → R52（用户组织真人）→ R53 | 交付 §4 全硬门 + §5 真人门 + 交接包 |

## 2. 任务状态

> **当前决定（2026-10-06）：G0 阶段基线签署通过，G1 已授权开工。** [签署单](ux-r1-g0/g0-signoff.md)为最新决定，覆盖修订包 `ea27b77` / `e2ebdc4` 及本次勘误；不是运行验收通过。
> 历史：首轮 G0 未通过，[原审记录](../acceptance/ux-r1/g0/2026-10-06-7c4502e/review-round1/decision.md)保留。三路团队修订报告见[关闭映射](ux-r1-g0/g0-review-closure.md)，本次复核新增事项按所属阶段收口。
> 五项产品决议继续有效：C1 有条件自动关闭、MCP 冲突缺省 fail、C9 新装默认关/升级保留、无可靠原子替换能力阻止替换、主文 v1.2 token。P5 压力观测已批准；受控测试授权限专用机或独立测试登录会话。

| ID | 状态 | 产出/证据 | 备注 |
|---|---|---|---|
| R00 范围冻结 | 通过（范围认可） | [盘点](ux-r1-g0/r00-feature-inventory.md) → [冻结单](ux-r1-g0/r00-scope-freeze.md)（§6.1 裁决记录已补） | 55 项功能全对应；14 项行为变更产品认可；五项决议已写入冻结单 |
| R01 三页面可交互原型 | 通过（阶段输入） | [原型](ux-r1-g0/r01-prototype/README.md) + [本次抽查](../acceptance/ux-r1/g0/2026-10-06-e2ebdc4-signoff/prototype-probe.json) | G1 相关流程可用；OutcomeUnknown 重试/丢弃未获批准，G3 前修正；Esc 高亮残留归 R25 |
| R02 token 与控件样例 | 通过（设计输入） | components.html/css + contrast-record | 视觉方向冻结，原生实现仍须 E 组验证 |
| R03 C1–C10 契约基线 | 通过（分阶段冻结） | [契约](ux-r1-g0/r03-contracts.md) + [fixture](ux-r1-g0/r03-fixtures.md) | C10 水位/订阅身份勘误即生效；C6 原语与证据 G3 前专项冻结；C9 实现验证归 G4 |
| R04 原生基线 | 通过（G0 交付接收；性能未全验收） | [采样结果](../acceptance/ux-r1/g0/2026-10-06-7c4502e/r04-baseline.md) + [本次采样器探针](../acceptance/ux-r1/g0/2026-10-06-e2ebdc4-signoff/memsample-probe.json) | P1/P3 仅混合构建条件下的旧版证据；P5 不可判且采样器待修；P6 同进程门未测；P2/P4/P7 延期按签署单收口 |

### G1–G5

G1 已获开工授权，R10–R15 仍记 `待开始`，由团队实际启动后更新。G2–G5 按前阶段出口进入；不再等待一次 G0 用户确认。

| ID | 状态 | 备注 |
|---|---|---|
| R10 adapter/DTO/错误映射 | **通过**（commit `6c8d4b3`） | 开工准备归档 `../acceptance/ux-r1/g1/2026-10-07-ea0b914-r10prep/`（旧版 tag old-ui-baseline-g0 + 构建/产物摘要 + DB fixture + release 补测清单）；实施证据 `../acceptance/ux-r1/g1/2026-10-07-7d70887-r10-adapter/` | WireError 结构化错误（15 变体 kind + ADR-15 前向）+ adapter 三件套（wire/errors/bridge，42 命令 CmdMap）+ App 全量改道 + demo 错误契约化；e2e：种子库 list-ready cards=21 + 真实库 autoconnect + 零 JS 错误；rev-r10 对抗审核通过 + vis-r10 视觉无回归（双通过，注记 4 项已收口） |
| R11 TerminalRegistry/订阅 | **通过**（证据 `../acceptance/ux-r1/g1/2026-10-07-2cdf635-r11-subscriptions/`） | C10 全链路：term-core ScreenCheckpoint 导出（复用 alacritty Term）+ core-session seq/重放环/订阅注册表/线性化点 + 桥 8B LE seq 帧/resync window 事件（补挂 FE 监听，修复基线断链）/三新命令 + FE createOutputFeed 水位状态机/applyCheckpoint 重建 + demo 同契约。e2e（交付态二进制，local 会话真环境）：3000 行洪泛全缓冲对账 missing=0/dup=0/resync=0、alt 屏检查点、过期订阅拒绝、显式退订归零幂等、退出零残留；term-core 17/17、core-session c10 7/7。独立复核：rev-r11（1 严重 3 中 5 低全部处置：replay_fresh 并入线性化点/parseSeqFrame 纯算术/applyCheckpoint 尺寸对齐/resize 漂移登记）+ vis-r11（vs R10 基线逐像素 0 差异；光标停闪/落错位 2 回归修复并探针复验）。登记：非活动缓冲空形（alacritty 0.26 无公开访问器）、title 恒 None、跨 resize 重放漂移、测试套件钥匙串护栏（SessionManager::open 各测试点未导出 TINYSSH_MASTER_KEY 时自设，cargo test 零钥匙串依赖——修复本轮 workspace 测试被授权弹窗阻塞） |
| R12 AppShell/主机栏/标签 | **通过**（证据 `../acceptance/ux-r1/g1/2026-10-07-b8775c8-r12-appshell/`） | 三栏 grid → AppShell（标题区 44 拖拽区+红绿灯安全区/主机栏 224 搜索+拖宽 200–300+⌘B 收起/标签栏 40+标签列表菜单/会话工具栏 40/右任务面板 files·collab·forwards 缺省关+窄窗完整视图双阈值滞回/状态条 24）；R11 订阅链路零改动；demo 探针 + 原生冒烟（r12-DONE：几何/⌘B/双会话/菜单/关闭确认流）双环境绿。独立复核双通过：rev-r12（2 中 6 低全处置：断点公式对齐面板宽 384+16px 回差滞回/分屏×面板登记 R25/R31/Esc 关菜单/grip 健壮性/探针 localStorage 归一等）+ vis-r12（几何 1280/1024/960 全过、token 一致、修复复验 4/4：toast 不压状态条/st-title·sb-left 截断）。登记：localStorage 暂存归 R15、分屏×面板退完整视图归 R25/R31、红绿灯像素级归 R50 |
| R13 action/快捷键/焦点 | **通过**（证据 `../acceptance/ux-r1/g1/2026-10-07-5179583-r13-actions/`） | 单一 keymap（actions.ts resolveAction）+ 唯一 window 捕获分发 + xterm 兜底同源 + menu-settings 走 dispatch，旧四组分散快捷键 effect 全删；Esc 链（三模态最优先）+ 关闭恢复终端焦点；模态层吞 ⌘ 且 native Ctrl 模态期停发（note_terminal 双向门）；IME isComposing/229 双查；⌘B 表单焦点不劫持（含 SELECT）；WebView 失焦/回焦对称上报；标签 §320 宽界 120–220 + 滚入视野补滚（滚动钮回钳 220ms 补滚 + ResizeObserver 覆盖布局成因）。e2e：demo 探针 26 项（⌘= 步进 ±1 单发证明/模态吞键/TOFU·确认弹窗/表单焦点/溢出滚入）+ 原生冒烟 r13-DONE（终版二进制，⌘1/⌘2/⌘⇧[]/⌘W 确认流/armed 轮询触发菜单事件）双环境零 JS 错误。独立复核双通过：rev-r13（1 中 6 低全处置后可签：模态期 Ctrl/Alt 编码层双门/SELECT/Esc 链措辞/window focus 对称/armed 触发消竞态/死参数删除；README 两处主张超实措辞已按探针证伪更正，模态期 xterm onData 普通键入仍进会话登记 R19/R23 focus-trap）+ vis-r13（零回归逐字段等于 R12 基线、标签宽界/双主题过；直点被截标签滚入不足 1 FAIL 修复后复验可签，2 秒 8 采样无振荡、拖拽无抖动）。登记：设置关闭钮直改不经 dispatch（无关闭动作）、Esc 非模态段固定序、› 钮计数只数完全移出、⌘F 无会话收紧不劫持 |
| R14 基础垂直流程 | **通过**（证据 `../acceptance/ux-r1/g1/2026-10-07-1fb1d72-r14-vertical/`） | 新工作区建立本地 + 真实 SSH（共享 docker sshd 127.0.0.1:2222）会话并走完垂直四要素：wire upsert_host 真路径建档（密码凭据加密落库）→ UI 点卡 → TOFU 首连信任门 → Connected → send_keys echo / read_screen 输入输出闭环 → local↔ssh 双标签切换（按主机名定位）→ 工具菜单关闭会话确认流 → 会话移除标签回收 + close 前订阅存在性证明（r14-sub-live）。产品代码零改动（diff 仅 dev 门控探针 r14_smoke_script），交付物即双环境端到端证据。e2e：原生冒烟 r14c 全链 r14-DONE 零 FAIL 退出零残留 + demo 探针 11/11（TOFU/xterm 渲染/回显/切换/确认关闭/tab-dot.dim 派生一致/模块同一性护栏/零 JS 错误）。证据口径：send_keys invoke 级（CGEvent 注入受 P2 冻结协议约束）、回显在核心屏快照级——xterm 渲染证据由 demo 承担，不主张「原生 UI 显示回显」。独立复核双通过：rev-r14（处置后可签：中-1 close 后 subs 断言结构性恒真——改 close 前订阅存在性断言并删恒真块；低-1 tabs0 竞态/低-2 死守卫/低-3 双前缀/低-5 固定 sleep 全修；低-4 title 信标无 RUN 前缀登记；执行插曲：AUTOCONNECT 时序抖动会话序翻转致索引式切标签误关 local——被 FAIL-close 如实抓住后改按主机名定位+关闭前回焦，r14c 终轮全绿）+ vis-r14（视觉可签 17/17：三宽度零回归——1280 差 3px 抗锯齿与基线链同构、1024 逐位相同、960 maxΔ=1；垂直五态 TOFU/连接/菜单/确认/死标签视觉完整 token 逐值相等；ImageMagick compare 1280 异常值被 raw 逐像素 diff 推翻，登记后续不单独依赖；双主题零 console 错误） |
| R15 偏好/元数据基础（C8） | **通过**（证据 `../acceptance/ux-r1/g1/2026-10-07-bbdd40c-r15-prefs/`） | DF8.1 `ui.v2.workspace` blob 整取整存（schemaVersion 核心归一、损坏回落 Default）+ V5 迁移（host_metadata + transfer_journal 两表、旧键一次性迁移 ui.theme→chrome/ui.font_size→ui.v2.terminal.font_size、旧键保留、幂等=blob 键存在、事务内）；DF8.2 收藏/打点（set_host_favorite 未知主机 InvalidInput、create_session 成功后 touch）；DF8.3 chrome 存储（R27 消费）；DF8.4 delete_identity 引用检查 IdentityInUse{host_names} 三端一致（CLI 人话文案/MCP/Tauri wire）+ delete_host 级联删元数据；DF8.5 recents sessions 派生（排除 local/MAX 倒序/上限 5/JOIN 存活）。FE 最小接线：blob 有值覆盖/无值一次性迁入 R12 localStorage、persistHostbarPrefs 链式串行化、字号旧键兜底；demo 同契约。e2e 四层：workspace 全量测试（vault 16+c8_prefs 4）+ demo 探针 16 项（迁入/blob 驱动 250/99→1/收藏/recents 序+升首+排除/打点/模块同一性护栏，零 JS 错误）+ 原生冒烟 r15l 全链 DONE（四段 reload blob 持久化 224↔260、AUTOCONNECT 打点、recents n=0 排除 local，退出零残留）+ CLI DF8.4 三相（拒绝列主机名→解除后删→列表空）。独立复核双通过：rev-r15（1 中 7 低处置后可签：M1 touch 幽灵行 WHERE EXISTS 修复、L2 读改写链串行化、L3 字号旧键兜底、L5 审计补 hostbar、L6 回滚冻结轮脚本误改；L1 TOCTOU/L4 chrome 钳制/L7 保留键直写登记）+ vis-r15（视觉可签 10/10：三宽度零回归逐像素 0 差异/双主题 token 逐字段=R13/blob 开合+250 宽+200–300 钳位/零 console 错误；一处探针断言自误 252=250+2px 边框数据判 PASS）。登记：transfer_journal 待 R32、收藏/recents UI 消费面属后续轮次 |
| G1 退出项 P2/P6/P5 | **通过**（证据 `../acceptance/ux-r1/g1/2026-10-07-37db283-g1exit/`） | **P2 交互延迟**（终轮 p2l，门判定内置探针）：会话切换 ×100 P95=19ms（门≤100）/输入→本地可见回显 ×100 P95=19ms（门≤50）/远端回显单列 ×100 19ms（真实 SSH，信息性不设门）——注入=合成 keydown+keypress（CGEvent 受 P2 冻结协议约束，R13 同口径），观测=xterm rows 任意行变化（p2i 诊断实证「末行增长」假设错误：回显落光标行；p2b–p2i 九轮诊断插曲入档，含 `__TAURI_INTERNALS__.invoke` 只读发现）。**P6 同进程循环**（终轮 p6f）：100 创建/关闭（每 25 轮 checkpoint subsViol=0，FAIL-subs 门内探针）+ 每轮 debug_subscriptions active_count≤live 且 per_session≤1 + xterm 回收终检 + 200 切换（retried=1 工件在案，单次重试=真实用户再点语义）+ 50 面板变化 + 零 JS 错误（error+rejection 双入判定）+ RSS n=70 152816–156912 KiB 尾低于首无线性增长 + 退出零残留；插曲：AUTOCONNECT 欢迎态（sid=null）终端不挂载→探针先激活再取基线（产品语义非缺陷）；基线早于挂载的 x0=0 假基线修正。**P5 归属试点**（缩时协议登记归 R51）：memsample v4 差分法 B=329.19MB→E=330.12MB 增长 +0.28%（观测量非门限），归属有效性 PASS（3 WebKit XPC 候选 lstart 身份冻结、B/E fail-closed、退出消失核验 exit 0；前置仪表修复 ea0b914+rev-q05fix 引用）；负载=单会话×5min /root/.spew 经真实 SSH 进核心管线零注入。产品代码零改动（diff 仅 p2/p6 dev 门控探针 + 2 行分派 + 试点驱动；ui/ 零 diff，无 UI 表面→视觉复验不适用）。独立复核：rev-g1exit（处置后可签，2 中 3 低全处置：p2 补 n 门+P95 门内置/p6 补 FAIL-subs+retried 打点/rss 单位改 KiB 主+命令归档/FAIL-jserr 并入 rejection/pilot 启动前残留检查+PID 精确 kill；登记：observer 前拍尾迹混计方向有利、DOM 计数为回收代理口径、重试语义对「慢但成功」无机器 FAIL） |
| R19 建连尝试核心（C1） | **通过**（证据 `../acceptance/ux-r1/g2/2026-10-08-99fec0e-r19/`） | C1 冻结契约全量：session-api 类型面（AttemptPhase 8 相位/AttemptInfo/CancelOutcome(tag=outcome)/ConnectionEvent/ErrorPayload）+ core attempt 注册表（(host_id, actor-domain) 合并、watch 取消通道有内存）+ run_attempt select 取消兜底 + 门卡（TOFU/2FA）attempt 联动与相位发射 + 三方取消（提交前受理 Cancelled/已提交未投递窗口 AlreadyReady 关闭·CancelCloseFailed 保留/已投递 NotFound）+ 跨域拒绝审计 + 审计五动作 + tauri 三命令桥 + connection-event 转发 + WireError 去重 wire_parts 单点 + FE wire/bridge 登记（消费面归 R23/R26，点卡仍 v1 create_session 兼容）+ demo 同契约 mock。测试 c1_tests 14 项（契约序列 1-6/DC1.5 幂等与绕过/v1 兼容/事件终态承载 + 处置回归 6 项）+ workspace 32 套件全绿 + demo 探针 21/21 + 原生冒烟 r19d 终轮全链 DONE 零残留（真 sshd：merge/TOFU/信任/认证/Ready/迟到取消/local 快路径/不可达受理取消+二次 NotFound；原生事件流经 __TAURI_INTERNALS__ 订阅实证三相位推送）。独立审核 rev-r19 两轮闭环：初判不可签（2 高 6 中 5 低）全部处置 → 复验「处置后可签」→ 签前关闭复验附条件 N1（pending_sid/insert 换序消微窗）与 N2（Failed 半会话清扫），N3-N5+四条回归网缺口登记归 R23 前置清单。处置明细：H1 投递点复查 cancel_requested 投递权让渡、H2 pending_sid 幽灵清扫（副产抓出审批卡作废不写回内存表真 bug 两处——R19 cancel 块与 T44 close 块）、M1 hk_pending 作废移除、M2 status 跨域不可见（subscribe 全局广播豁免登记归 R26）、M3 term 原子镜像+合并临界区+按键比较移除、M4 并发取消结算权唯一、M5 门超时审计补齐（deadline 语义勘误登记归 R23）、M6 措辞更正、L2/L3/L5 修、L1/L4 登记。视觉复验不适用（ui/ 仅 wire/bridge/demo 非渲染面）。插曲：锁屏冻结 r19a 中断（r12 已知坑）；vault c8_favorites 同毫秒平局 flake 与本任务无关登记 |
| R20 主机搜索/收藏/欢迎页 | 待开始 | |
| R21 连接表单与认证 | 待开始 | |
| R22 导入诊断（C7） | 待开始 | |
| R23 连接/关闭/退出状态机 | 待开始 | |
| R24 Human 默认控制 + C2/C3 | 待开始 | 核心语义收紧，含协议兼容说明 |
| R25 搜索/粘贴/多标签/分屏 | 待开始 | |
| R26 断线/重试/重确认/重连 | 待开始 | |
| R27 外观/终端设置/可访问性 | 待开始 | |
| R30 路径/元数据（C4） | 待开始 | |
| R31 文件面板/完整视图 | 待开始 | |
| R32 传输注册表（C5） | 待开始 | |
| R33 上传下载入口/拖拽 | 待开始 | |
| R34 冲突/提交仲裁（C6） | 待开始 | 与 R30/QA 在 G3 前先冻结原语、竞争模型和结果证据，再实施 |
| R35 队列抽屉/重试/限制 | 待开始 | |
| R40 转发表单/生命周期 | 待开始 | |
| R41 活动记录/凭据设置 | 待开始 | |
| R42 协作入口/首次委托/审批 | 待开始 | |
| R43 协作启停（C9） | 待开始 | |
| R44 升级/开关/回退演练 | 待开始 | |
| R45 旧 UI 清理/文档同步 | 待开始 | 含 ui/package.json test 入口整合 |
| R50 全场景视觉/原生回归 | 待开始 | |
| R51 release 性能门 P1–P7 | 待开始 | 实际打包前后端绝对门；旧/新版打包产物同环境对比；P5 全量含压力观测 |
| R52 真人任务与试用 | 待开始 | **用户组织**；6 人、SUS、7 天试用 |
| R53 发布审核与交接包 | 待开始 | 用户签署 |

## 3. 执行日志

| 日期 | 事项 |
|---|---|
| 2026-10-06 | 设计包基线提交 `7c4502e`；建立本跟踪文件；G0 启动：R00 功能盘点、R03 两路契约调研、R04 工具链验证并行开展 |
| 2026-10-06 | R00 盘点返回（55 功能/8 GAP/2 STALE/8 悬空，另发现 resync 断链现存缺陷）；R03 两路缺口分析返回（45 待决点）；R04 环境记录落盘 |
| 2026-10-06 | R00 冻结单与 R03 契约草案（含 45 决议、8 可断言序列、错误 ADR-15）定稿；两路独立审核启动 |
| 2026-10-06 | rev-r00 审核通过（1中3低已修，含 A10 点击模型补登记）；rev-r03 审核通过（4高1中3低已修：Interrupted 状态、Option<bool> 防灰度静默关闭、subscribe_output 实签名与旧 UI 适配归 R10、DF6.1 改 RawSftpSession 扩展表机制）；R00/R03 均达「可签」，待用户联合评审 |
| 2026-10-06 | R00/R03 提交 `2c766fe`；R01 原型交付并独立复验（几何 44/40/40/224/384/24 全过、token 28/28 一致）；R02 组件样例+对比度全表交付；2 FAIL 修复（危险按钮文字、mode-full 隐藏 term-area）+ 新 token border.input；设计主文升 v1.2（§7.2/§7.3，manifest SHA 过期已登记待联合评审覆盖）；R04 PID 归属实证 + P5 采样器 fail-closed 验证通过 |
| 2026-10-06 | R04 采样：P1 冷 760/P95 1304、热 788/P95 805；P3 30/30 中位 330/P95 349；P6 100 循环 ΔRSS 0.0MB（替代口径登记）；P5 试点 B 328.0→E 332.0MB 增长 1.2%（缩时登记，全量归 R51；E 段停止后 +2.4MB 阶跃已披露，按末段值 2.0%）。**独立对抗审核 9 项发现（1高5中3低）全部处置**：键注入护栏落地 keyguard.py（三延期脚本每次事件前前台+在屏双核验）；P1 口径 400→700ms 修正并从 s2_ms 全量重算（冷 460/P95 1004、热 488/P95 505）；P6 带退出核验重跑（Δ−1.06MB、残留 0/100）；memsample.py 重写差分 v2；cold_retry inclusive 重算并纳入引用；污染原值 2140/1856 回填注记；P5 冻结偏差登记。R04 文档+raw 归档提交。**P2 键注入事故**（frontmost 静默失败，CGEvent 可能落入用户应用约 6 分钟）：已披露用户、数据作废、全部键注入采样（P2/P4/P7）延期并冻结复测协议（每次键事件前前台+在屏双核验护栏）。P1 冷 #3/#4 孤儿信标污染已重跑替换并保留 replaced 注记。归属方法改差分法（浏览器保持运行约束） |
| 2026-10-06 | **G0 修订轮**（联审未通过响应）：三路并行修正后全部独立复审通过——A 原型九项修复 rev-ux 九项全 PASS+对抗探针无绕过；B 契约 C-01~C-04 rev-r03b 二轮全部处置；C 测量 Q-01~Q-06 rev-r04 两轮三验终裁决可签关闭（复审新增 2 项：memsample --s0 str/int 键类型失效、p2_echo 门限/分辨力声明，同轮修复并正/缺/无三路径独立复跑）。五项产品决议写入冻结单 §6.1 与契约条款。关闭映射：docs/ux/ux-r1-g0/g0-review-closure.md，待用户重审 G0 |
| 2026-10-07 | **G0 受托签署生效**：G0 阶段基线通过、G1 授权启动（签署单 g0-signoff.md，commit `bbd2341`）。随即执行签署指派项——Q-05 采样器修复（memsample v3→v4：键类型装载归一/应用 RSS 单计/同 PID 换身份复用检测，对应签署探针四项发现），纯数据正负探针 9/9 PASS（scripts/perf/memsample_selftest.py，证据 2026-10-07-e2ebdc4-q05fix）+ 独立复核通过（rev-q05fix 对抗复核裁决可签关闭：四缺陷实读验证 + 自写对抗探针 10/10 PASS；两条低危 fail-closed 注记随下次修订收口）。下一步按签署 §2：R10 开工准备 + G1 实施（第一重点：新工作区真实 SSH 垂直流程） |
| 2026-10-07 | **G1 启动**：R10 开工准备交付（旧版源码 tag `old-ui-baseline-g0`、构建/产物 SHA256、隔离 DB fixture、release 打包基线补测清单——签署 §2 期限项，commit `7d70887`）；R10 adapter 实施完成待验收：后端 WireError 结构化错误（36 处字符串拍平替换 + kind 契约测试）、FE adapter 三件套（42 命令 CmdMap 类型化）、App 全量改道、demo 错误同形；e2e 合成证据（种子库 21 卡渲染 + 真实容器 autoconnect + 零 JS 错误 + 退出零残留 + demo 浏览器走查零错误）；独立复核双通过：rev-r10 对抗审核通过（三标准 PASS + 4 低危注记全部收口）+ vis-r10 视觉无回归（逐像素零差异、双主题实测）。已提交 `6c8d4b3`，下一任务 R11 |
| 2026-10-07 | **R11 实施完成**：C10 全链路（term-core ScreenCheckpoint 导出 + core-session 线性化点/重放环/订阅注册表 + 桥 8B LE seq 帧/resync 事件/三新命令 + FE createOutputFeed 水位状态机/applyCheckpoint + demo 同契约）；e2e 真环境 3000 行洪泛对账 missing=0/dup=0/resync=0、alt 屏检查点、过期订阅拒绝、退订归零幂等、退出零残留；独立复核双通过：rev-r11（1 严重 3 中 5 低全部处置，replay_fresh 并入线性化点为关键修复）+ vis-r11（逐像素 0 差异，2 光标回归修复探针复验）。附带发现并修复测试套件钥匙串阻塞（测试点 env 自设主密钥，`cargo test` 零钥匙串依赖）；t40 容器同路径留待受控复测，遗留 SecurityAgent 弹窗待用户处置。下一任务 R12 |
| 2026-10-07 | **R12 实施完成**：AppShell 重构（标题区 44/主机栏 224/标签栏 40/会话工具栏 40/右任务面板/状态条 24），R11 订阅链路与全部既有用户路径保留（rev 逐路径核对）；demo 探针（几何/夹取/菜单/面板/断点滞回/零 JS 错误）+ 原生冒烟 r12-DONE 双环境绿；独立复核双通过：rev-r12（2 中 6 低全部处置后可签）+ vis-r12（修复复验 4/4 视觉可签）。执行插曲登记：屏幕锁定期间 WKWebView 冻结不可见窗口页面 JS 致原生冒烟三轮停摆（锁屏签名=CGWindowList 仅 loginwindow/SecurityAgent），解锁后补跑通过。下一任务 R13 |
| 2026-10-07 | **R13 实施完成**：统一 action 分发（actions.ts 单一 keymap + window 捕获层/xterm 兜底/原生菜单事件三条路径同源，旧 ⌘1–9/⌘W·⌘⇧[]/Esc 链/⌘F·⌘= 四组分散 effect 删除）；§7.3 输入约定（IME 双查/模态层吞 ⌘/Esc 浮层链+焦点恢复/⌘B 表单焦点豁免含 SELECT）；§7.4 焦点（native Ctrl 模态期停发 note_terminal 双向门、WebView 失焦/回焦对称、关闭工具恢复终端焦点）；§320 标签 120–220 + 滚入视野补滚（回钳 220ms + ResizeObserver）。e2e 双环境：demo 探针 26 项（⌘= ±1 单发证明/模态吞键/TOFU/表单焦点/溢出滚入，零 JS 错误）+ 原生冒烟 r13-DONE ×3（终版二进制 ⌘ 切签/⌘W 确认流/armed 轮询触发菜单事件，退出零残留；插曲：dist 变更不触发 cargo 重编，touch 强制重编后取终轮证据）。独立复核双通过：rev-r13（1 中 6 低全处置后可签，附条件 README 两处主张超实措辞已按探针证伪更正：模态期 xterm onData 普通键入仍进会话归 R19/R23 focus-trap）+ vis-r13（零回归逐字段=R12 基线；直点被截标签滚入不足 FAIL 修复后复验视觉可签，无振荡无抖动）。下一任务 R15 |
| 2026-10-07 | **R15 实施完成**：C8 偏好与主机元数据（DF8.1 blob 整取整存 + V5 迁移两表与旧键一次性迁移/DF8.2 收藏与建连打点/DF8.3 chrome 存储/DF8.4 引用检查三端一致 + 级联/DF8.5 recents 派生）；FE 最小接线（blob 覆盖/一次性迁入/写链串行化/字号旧键兜底）+ demo 同契约。e2e 四层全绿：workspace 测试（vault 16 + c8_prefs 4）、demo 探针 16 项（含 HMR 双实例误判教训——加模块同一性护栏，dev server 长跑后编辑文件会以 ?t= 时间戳分裂模块实例，直调读种子态假 FAIL）、原生冒烟 r15l（探针脚本三轮迭代：存在性标记被后段移除致段重跑/覆盖——改单调步进 step；beacon 标记与 reload 竞速丢包——段首 title/mark 改 await；AUTOCONNECT 晚至打点——轮询等待）、CLI DF8.4 三相。独立复核双通过：rev-r15（1 中 7 低：M1 touch 幽灵行 WHERE EXISTS、L2 链串行化、L3 旧键兜底、L5 审计补域、L6 回滚冻结脚本误改；L1/L4/L7 登记）+ vis-r15（视觉可签 10/10，零回归逐像素 0 差异）。下一任务 R14 |
| 2026-10-07 | **R14 实施完成（G1 五任务 R10–R15 全部闭环）**：基础真实垂直流程——产品代码零改动（diff 仅 dev 门控探针 r14_smoke_script +130 行），交付双环境端到端证据：原生冒烟 r14c（release 终版二进制 + 共享 docker sshd 127.0.0.1:2222：wire 建档→UI 点卡→TOFU 信任→Connected→send_keys/read_screen 回显闭环→双标签切换→关闭确认流→close 前订阅存在性证明，r14-DONE 零 FAIL 退出零残留）+ demo 探针 11/11。证据口径如实：send_keys invoke 级（CGEvent 受 P2 冻结协议约束）、回显核心屏快照级、xterm 渲染由 demo 承担。执行插曲二则：①AUTOCONNECT 时序抖动会话序翻转，索引式切标签误关 local——FAIL-close 如实暴露后改按主机名定位标签+关闭前回焦（r14b→r14c）；②rev-r14 抓出 close 后 subs 断言结构性恒真（debug_subscriptions 只遍历存活会话表）——改 close 前订阅存在性断言（证据纪律执行案例）。独立复核双通过：rev-r14（处置后可签，1 中 5 低全处置/登记）+ vis-r14（视觉可签 17/17，三宽度零回归；ImageMagick compare 异常值被 raw 逐像素地面真值推翻，登记）。**下一步：G1 退出项 P2 / P6 同进程循环 / P5 有效归属试点（受控环境），全过后 G1 出口** |

| 2026-10-08 | **R19（G2 首任务）实施完成**：C1 建连尝试冻结契约全量落地——attempt 注册表/三方取消语义/门卡联动/审计五动作/tauri 桥+事件转发/demo 同契约 mock；FE 消费面明确归 R23/R26（v1 create_session 点卡兼容不动）。证据：c1_tests 14 项 + workspace 32 套件 + demo 探针 21/21 + 原生冒烟 r19c 全链 DONE（含原生 connection-event 三相位推送实证）。独立审核 rev-r19 初判不可签（2 高 6 中 5 低）→ 全部处置（H1 投递权让渡/H2 幽灵清扫/M1-M4 语义修复/M5 部分修+勘误登记/L 级修+登记）→ 复验「处置后可签」→ 签前关闭附条件 N1/N2 → 终轮 r19d 全绿；处置过程副产抓出审批卡作废不写回内存表真 bug（同病 T44 close 块）并修复。视觉复验不适用（非渲染面）。下一任务 R24/R20 |

## 4. 决议与偏差记录

| 日期 | 决议 | 原因 |
|---|---|---|
| 2026-10-06 | G0 产物先落 `docs/ux/ux-r1-g0/` 草稿区，评审通过后不搬移、由本文件索引 | 避免双份文档漂移 |
| 2026-10-06 | R01/R02 用独立 HTML 原型（`ux-r1-g0/r01-prototype/`）实现，不动 `ui/` 真实代码 | G0 不改产品源码，双轨由 G1 R10 起以 `TINYSSH_UI_V2=1` 承接 |

| 2026-10-06 | **G0 重审签署通过，G1 已授权**；用户明确授权 Codex 代决策，见 [签署单](ux-r1-g0/g0-signoff.md) | G1 优先真实 SSH 垂直流程；C6/P4/P7 在 G3 入场前关闭，C9 运行验证归 G4；P5 采样器待修并在 G1 退出前完成有效试点；本次没有原生注入 |
