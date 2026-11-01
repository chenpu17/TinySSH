# 找茬三轮审查与修复台账（2026-10-30）

用户指令：再安排多个 subagent 审核验证本项目，多发现问题与改进点（含视觉/UX），确认后落地并审核验证。三路串行派发（坑 62 并发限额=1）：A=Rust 后端、B=前端组件、C=视觉/UX 真机走查。审查基线=工作树未提交的四批改动（找茬一/二轮 + 下载覆盖轮 + tmux 快接钮轮，31 文件 +909/−195）+ 未深审角落。

## 产出与裁决总览

三路共 **20 条**：修复 **16**，立案 **4**。另修 1 处既有 clippy hard error。

### A 路：Rust 后端（5 条，4 修 + 1 立案）

| 编号 | 级别 | 裁决 | 摘要 |
|---|---|---|---|
| R3-A-1 | P1→修 | ✅ | **下载覆盖「复检臂」同轮落发布绕过 CAS**：recheck 的 Replace 臂批准后不回环，决策窗（生产 300s）内目标被外部改动不可检测——违反本轮自立的信任模型。修=Replace 臂 `continue` 回环重 stat，一致才落发布（与预检路径同编排；rounds≤16 防线兜住）。红绿验证：撤 continue 新用例红（卡3 不出现），恢复绿 |
| R3-A-2 | P2→修 | ✅ | **RenameTo 臂不清 `replace_approved`，覆盖授权泄漏到 keep-both**：预检批准覆盖→复检改选保留两者→发布走 replace 分支+审计误记 `transfer_overwrite_published`（keep-both 被记成破坏性覆盖）。修=两处 RenameTo 臂 `replace_approved = None`（授权只属于被批准的那份目标）。新增用例断言 keepboth 后无覆盖审计，红绿验证过 |
| R3-A-3 | P3→修 | ✅ | PTY respawn 代际推进 load+store 非原子（SSH 侧是 fetch_add）——并发 respawn 可发同号代际误杀新泵。当前调用面不可达（状态机互斥），防御性一行改 `fetch_add(1)+1` |
| R3-A-4 | P3→立案 | 📋 | audit hash 链字段无分隔符拼接存在换界歧义（("ab","c")≡("a","bc")）。防御水位未实质降低（无密钥 sha256 整链可重算）；修需链版本化+verify 双式兼容，单独立案 |
| R3-A-5 | P3→修 | ✅ | check_update 的 HTTP client 未挂跨 scheme 重定向策略（安装路径挂了）——https 端点 302 到 http 照跟。修=同挂 `no_downgrade_redirects()` 两通道一致 |

新增回归：`r34_overwrite_restat_after_decision`（三卡链：预检批准→复检 CAS 失败出卡→再批准→**必出第三卡**而非直落发布→skip 零覆盖）、`r34_overwrite_then_keepboth_no_overwrite_audit`（覆盖授权换道 keep-both 后审计零污染）。

**测试方法论收获（新坑）**：多卡链等待不能用「revision 推进」——submit 自身 +1 而卡面张贴不 bump，提交瞬间旧卡（rev+1、旧 prompt）即满足条件；唯一可靠判别是 **prompt 载荷（目标 stat）变化**。已沉淀为 `wait_card_with_size` helper。

### B 路：前端组件（10 条，9 修 + 1 跳过）

| 编号 | 级别 | 裁决 | 摘要 |
|---|---|---|---|
| R3-B-1 | P2→修 | ✅ | **决策卡自动浮出「顶回」**：effect 在抽屉开着时早退不标记，关闭动作被立即顶回（多卡连关 N 次）。修=「看见即视为已提示」（开着也入集合）+ size>200 只清已终结卡（在决卡误清会重新变 fresh） |
| R3-B-2 | P2→修 | ✅ | **MOCK_CONVS 恢复不消毒**：演练流式中关面板→重开恢复 streaming 光标永闪 + mermaid/公式渲染闸永久关闭 + pending 审批按钮 no-op（ref 已随卸载重置）。修=`sanitizeMockMsgs`（恢复时 streaming→false、pending/running 工具卡→err+「面板关闭时中断」） |
| R3-B-3 | P2→修 | ✅ | **同主机两会话 brief 全等→SFTP 首载死锁**：A→B 切换 brief 不清，B 的 brief 与 A 字节级全等时 sameJson 返回旧引用→无重渲染→首载 effect 永不触发（列表静默空白）。修=切会话无快照分支补 `setBrief(null)`（null→对象必换引用，首载必跑） |
| R3-B-4 | P3→修 | ✅ | MetricsBar 采样失败计数器成功不清零——「连续 3 次」实为终身累计 3 次，间歇抖动即永久隐藏监控条。修=成功分支 `fails = 0` |
| R3-B-5 | P3→修 | ✅ | collab-panel 停用态首句全角「。」仍是 JSX 裸字面量（FE2-7 只改了第二处）。修=`{t("。")}` |
| R3-B-6 | P3→修 | ✅ | blocks-panel 时钟硬编码 zh-CN 漏 dateLocale 收口 + app-data.hhmm 死代码。修=clockText 走 dateLocale()、hhmm 删除（无消费点、无 spec 引用） |
| R3-B-7 | P3→修 | ✅ | join("、") 分隔符 13 处不走 i18n（EN 模式人名列表中文顿号）+ welcome/App 两处 localeNow 三元内联。修=12 处 `join(t("、"))`（confirm-dialogs 既有口径）+ 两处 `dateLocale()`。**demo.ts:706 有意跳过**（demo 错误消息是中文模板整体，不属 t 体系） |
| R3-B-8 | P3→修 | ✅ | Esc 链顺序：palette（带遮罩模态）排在非模态浮层（大屏/广播/抽屉）之后——叠开时 Esc 先关底层。修=palette 判定挪到 osc52/拖拽卡之后、非模态浮层之前 |
| R3-B-9 | P3→修 | ✅ | monitor-view 会话状态徽标只翻「重连中」其余直出英文枚举。修=`stateLabel(c.state).text/.cls`（连带拿到语义色） |
| R3-B-10 | P3→修 | ✅ | **真模式→演练回切污染**：真历史被 persist 进演练仓、演练回复续写在真实历史后。修=装载时记 `realModeSidsRef`，persist 跳过+回演练瞬间清该会话对话（种子 effect 重播欢迎语干净开始） |

### C 路：视觉/UX 真机走查（5 条，3 修 + 2 立案）

| 编号 | 级别 | 裁决 | 摘要 |
|---|---|---|---|
| R3-C-1 | **P1→修** | ✅ | **矮窗口接入会话终端整屏空白/错位**（1366×768 起、1024×700 全空白、resize 不恢复）。诊断链见下节 |
| R3-C-2 | P3→立案 | 📋 | 设置弹层开着时首击活动栏只关弹层不切换面板（点外关闭消费首击=通用模式）+ rail hover 与激活态视觉同质。不修交互（标准模式），视觉打磨立案 |
| R3-C-3 | P3→修 | ✅ | EN 复数瑕疵（"1 servers"/"1 tasks"）+ 传输抽屉空态绑死 Finder。修=中性写法 "{0} server(s)"/"{0} task(s)" + "your file manager" |
| R3-C-4 | P3→立案 | 📋 | mermaid 节点纯黑观感（浅色面板下像黑洞）。**设计取向冲突**：mmd.ts 注释明确「节点=代码块外观（--bg 底）」是跟随代码块语言的有意设计；改面板色属设计拍板项，不擅自改 |
| R3-C-5 | P3→修 | ✅ | Fleet 头部 chip EN "Cross-host orchestration" 440px 截断。修=该键唯一消费点即 chip，EN 值改 "Cross-host" |

## R3-C-1 诊断与修复（本轮最大收获）

**现象**：接入既有会话后终端整屏空白（1024×700）或首行卷出（1366×768），buffer 有内容（光标悬空在正确列位）、拉大窗口不恢复。1440×900 正常。

**诊断链（探针实证）**：
1. buffer/term 状态 dump：700 档 term 84×24 但 buffer 28 行、vy=4——**视口在底但底部全空、实质内容全在 scrollback 顶**。
2. 量盒对账：欢迎页 #term h=576（会话工具条未渲染）vs 接入后 h=508（工具条压矮 68px≈3-4 行）。
3. 全链：预对齐（ensureSessionTerm 内、按 #term=576 fit）→ checkpoint 按核心网格（28 行）写入 → attach 后 fitTerminal 按激活态（24 行）**缩行** → xterm reflow 固定光标视口相对位、顶部内容推进 scrollback → 光标悬空、视口停空区。900 档 fit≥网格（涨行）无恙——所以只在矮窗口复现。
4. 渲染层还有第二拍：DOM 滚动/内容重绘滞留旧 scroll 锚（scrollToLine 后 buffer 语义已对、canvas 不跟）。

**修复**（attachSession + restoreScenes 双挂点 `realignAfterFit`）：
- 找 buffer 最后一个非空行 tail，`scrollToLine(max(0, tail - rows + 1))` **最小滚动**——scrollToLine 内部钳 scrollback 底：正常场景=滚底 no-op，毁损场景=整段内容回到可视区；
- 光标悬在内容尾之下空区时 write 绝对定位序列送回内容尾行尾（与核心 PTY 光标语义重新对齐，回显从提示符后继续）；
- `refresh(0, rows-1)` 整屏标脏强制重绘；
- 400ms 补拍覆盖 350ms 二次 fit 的缩行。

**验证**：700/768 两档探针——vy=0、光标(3,14)=提示符尾、内容四行全渲染。

**立案残尾**：headless WebGL 下 canvas 层 scroll 偏移滞后一拍（内容层偏移≈3 行、光标层按 buffer 直画，refresh/scrollLines 往返均不唤醒）——视觉呈现已正确、buffer/视口/光标语义全对齐；真机行为待复验，若复现立专轮进 xterm WebGL 内部。

## 顺带修：既有 clippy hard error

`core-session/tests/core_local.rs` 第 9 条探针 `for _ in 0..12` 全臂终止（注释说「等 200ms 重探」未实现）→ clippy `never_loop` **error**（挡 `--all-targets` 口径；CI 口径未覆盖）。对齐实际行为改写为单次 match，core_local 15/15 绿。

## 验证

| 项 | 结果 |
|---|---|
| tsc --noEmit | 0 错 |
| cargo fmt --all --check | 清 |
| clippy（exclude tinyssh-app --all-targets） | 0 error；告警均为既有（keepalive_rx/slice clone/records flatten 等） |
| workspace 测试（exclude tinyssh-app） | 全绿 0 failed（core-session r34 21/21 含 2 新用例、core_local 15/15） |
| UI 全套 | **914/914**（首轮 905/906 的 57-proxyjump 失败=负载 flake，单跑 13/13 绿+全套复跑全过，坑 66 同族） |
| vite build | 30.61s 绿（chunk 大小告警=既有） |
| R3-C-1 探针复验 | 1024×700 / 1366×768 内容完整可见、光标对齐提示符尾 |

## 立案清单（本轮新增）

1. audit hash 链分隔符/长度前缀拼接（R3-A-4）——需链版本化迁移
2. 设置弹层首击 + rail hover/active 视觉区分（R3-C-2）
3. mermaid 节点配色取向（R3-C-4）——待用户拍板
4. WebGL canvas 层 scroll 偏移残尾（R3-C-1 残尾）——真机复验后定
