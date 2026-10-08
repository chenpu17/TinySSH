# UX-R1 G2 · R27 外观/终端设置、字号、可访问性 —— 验收证据

基线：ddd9d60（R26）。日期：2026-10-08。

## 任务面

「明暗独立配色；旧主题迁移；键盘/VoiceOver 可达」（§7.1/§7.2/§7.4/§10.1.1/§244）。存量（R15/T35/R20 已就位）：字号范围 9–28 与 vault 持久化（旧键回落）、四终端配色预设、⌘=/⌘−/⌘0、V5 迁移（ui.theme→blob chrome 映射、ui.font_size→新键）、focus-visible/reduced-motion/主机卡键盘。本轮增量：

1. **应用外观三态（明暗独立配色）**：`system | dark | light` 新增——应用外观与终端配色解耦（§244「应用主题与终端配色解耦」落定）：外观事实源 = `ui.v2.workspace` blob chrome 域（`changeAppearance` 走 wsWriteChain 串行化落库防与 hostbar 写交错丢更新）；终端配色仍存 `ui.theme`（changeTheme 不再触碰 data-chrome/原生 setTheme）。新装默认「跟随系统」：FE 按 `prefers-color-scheme` 现场解析 + matchMedia change 监听实时跟随；Tauri 下原生窗口 setTheme 同步（system 态 setTheme(null) 归还系统）。设置面板重构：外观（应用）三态段钮（aria-pressed）+ 终端配色四预设 + 「应用外观与终端配色相互独立」说明行。solar-light 应用皮肤随解耦移除（死亡代码；Solarized 浅色终端配色在浅色应用皮肤下呈现——V5 迁移本就映射 solar-light→light）。
2. **旧主题迁移（消费闭环）**：V5 迁移修订（§10.1.1「只有新装才默认跟随系统」）——无旧键（新装）→ `chrome:"system"`（原实现回落 dark 违反该条）；有旧键保持映射（light/solar-light→light、dark/solar-dark/未知→dark）不突变。FE 启动消费 blob chrome（R20 登记「chrome blob/light 消费归 R27」闭环）；demo get_workspace 默认 chrome 同步改 system（同契约）。载入路径只应用不回写（applyAppearance/changeAppearance 分离，启动零额外落库）。
3. **键盘可达（§7.4）**：弹窗 focus trap（useDialogFocus：打开焦点入框、Tab/Shift+Tab 循环不出框、关闭焦点还原触发控件）应用于六个带遮罩模态——设置面板 + 关闭会话/退出/删主机/删凭据确认框 + 粘贴确认框（`role="dialog"`+`aria-modal`+`aria-labelledby`）；**初始焦点 `[data-autofocus]` 优先**（rev-r27 中-1：确认类模态 danger 钮居 DOM 首位，初始落首位=破坏动作预武装——五个确认框取消钮打标，破坏动作需一次显式 Tab 才可达）；AddHostForm/ImportPanel 为内联表单非模态，不入 trap 范围（取向登记）。标签关闭/分屏钮 span→真按钮（键盘 Tab 可达 + focus-visible）；配套 **R20-H1 同款守卫补入标签 onKeyDown**（探针抓出真缺陷：子按钮上的 Enter 冒泡被标签处理器 preventDefault 吞掉默认点击、误触 attachSession——连接会话键盘关不出确认框、断开标签键盘关不上）。tabbar `role="tablist"`、tab `aria-label`（主机名+状态+分屏+⌘序号）、tab-dot aria-hidden。
4. **可访问名称（§7.3/§7.4）**：搜索上一个/下一个/关闭钮补 aria-label；模态 role/aria 对账；确认框标题挂 id 供 aria-labelledby。VoiceOver 实机朗读域登记为人工域（DOM 可访问名自动化已覆盖，同 R52 IME 处置）。
5. **命中区（§7.2 图标点击区≥28×28）**：`::after` 透明扩展（inset -5px）应用于纯图标钮——tab-x/tab-split/host-del/term-search 三钮；无布局位移、无视觉变化（focus/hover 呈现仍在原盒）。
6. **focus.ring token（§7.2）**：`--focus` 独立键盘焦点环（深 #91baff / 浅 #245db4，与 accent 区分——accent 元素上焦点仍可辨），focus-visible outline 换用。
7. **终端默认字号 14px（§7.2）**：FONT_DEFAULT 13→14（新装默认；已存偏好优先；范围 9–28 保留）。

## e2e

- **demo 探针**（真实 Chromium + vite demo :5183，r27-demo-probe.js）：处置前 **37/37 ×2 连续独立轮**；rev-r27 处置后 **39/39 ×2**（增 C1b2/B4a2「初始焦点=取消钮」判别，输出归档 probe-run1/2.log）。A 外观（新装 system 按 prefers-color-scheme 解析 + 载入不回写 blob + emulateMedia 实时跟随 + 显式深浅覆盖系统 + blob 落库 + **解耦判别**：外观深色下切终端浅色预设 chrome 不动〔旧码必红〕+ reload 双键独立还原 + 字号默认 14〔旧码 13 必红〕+ 增大落库）；B trap 三面板（设置/关闭确认/粘贴确认：Tab 循环不出框 + role/aria-modal + 初始焦点=取消钮〔处置前落 danger 钮，rev-r27 初审实证〕+ Esc 焦点还原触发控件〔旧码必红〕）；C 标签键盘可达（tab-x Tab 可达〔旧码 span 必红〕→ 连接会话出确认框 → Esc 还原 tab-x）；D 断开标签键盘直关（无确认、按 sid 定界移除；种子库自带 prod-1 会话按主机名会误判——已定界）+ 命中区判别（tab-x 视觉盒右缘外 3px elementFromPoint 命中按钮本体，旧码 18px 盒该点=父 tab 必红）；E tab aria-label（主机+状态+⌘序号，恰好一个 aria-selected）/tablist/搜索钮 aria-label；Z 零 JS 错误。
- **旧码判别力**（基线 ddd9d60 worktree :5184）：主探针 A0/A0b/A1/A1b/A6/A2 六判别全红（chrome=null、blob=dark、无外观组、字号 13、emulate 不跟随）+ 新 UI 专属交互处预期崩溃；补充分探针 T1–T4 全红（tab-x 键盘不可达 span 时代、命中区 18px miss=父 tab、设置 Esc 无还原（active=body）、终端配色切换连动 chrome 翻 light）。归档 oldcode-probe-main.txt / oldcode-probe-t1t4.txt。
- **原生冒烟**（release 二进制 + 隔离 DB + 口令 env + beacon；无 sshd 依赖——纯 UI/偏好面）：**r27a 两阶段全链 DONE 零 FAIL 零 JS-ERROR/REJECT 进程零残留**。阶段1（新库）：新装 chrome0=dark=系统实测一致 → **驱动 osascript 真实切换 macOS 深浅**（demo 只能 emulate 的面，原生实证）→ WKWebView 实时跟随翻 light + matchMedia 自洽 → 设置面板三态/解耦（Solarized 深色预设下 chrome 保持 dark）/显式浅色/get_workspace blob chrome=light 对账/⌘= 字号 14→15。阶段2（驱动杀进程→DB 回卷 V4〔DROP COLUMN+version=4〕→重启 RUN_ID=r27a-p2）：**V5 迁移映射消费**——旧键 ui.theme=solar-light → chrome=light + 终端 Solarized 浅色 ts-active 在位 → 「跟随系统」归位（与 in-page matchMedia 自洽断言）。系统外观已还原（dark mode=true）。
- **workspace**：**152/0**（+1 vault c8_v5_migration_fresh_install_follows_system：全新库 chrome="system" + 字号新键不虚构；老键映射测试期望不变=solar-light→light 维持）。tsc 0。

## 执行插曲（如实）

1. **R20-H1 同族真缺陷（探针抓出）**：标签 onKeyDown 无 target 守卫——R27 把 tab-x/tab-split 键盘化后，子按钮上的 Enter/Space 冒泡到标签处理器被 `preventDefault` 吞掉默认点击、误触 attachSession（demo 探针 C1b/D1/B4 三处同根失败归因）。修=首行 `e.target !== e.currentTarget` 早退（R20 H1 同款工艺）。判别力分两层：基线 ddd9d60（span 时代）键盘路径整体不可达（T1 必红）；开发中间态（键盘化后、守卫前）则 Enter 误触 attach——连接会话不出确认框/断开标签不关（rev-r27 复核确认基线与中间态两面均红）。
2. 原生阶段2 首两轮崩：驱动 DB 回卷到 user_version=4/5 均触发 V6 `ALTER TABLE` 重复列 panic（V6 无幂等守卫；V5 幂等=blob 键但 version 变量一次性读取使 V6 必重放）——驱动改为完整回卷 V4 状态（DROP COLUMN + version=4；SCHEMA_V5 全 IF NOT EXISTS 安全重放）。产品迁移代码未改（回卷是测试工艺非产品路径；V6 无守卫登记为迁移加固候选）。
3. demo 探针四处工艺：合成 `.click()` 不移焦点致 trap「还原」断言无锚（改真实 page.click）；建连后 attach 异步夺焦（focusTabX 每步验证 activeElement 被夺则重试）；预设钮含色板 "Aa" 前缀（startsWith→includes）；种子库自带 prod-1 会话（断言按 sid/标签计数定界）。
4. vis 方法学：forceDark 用 addInitScript 会在每次导航重放、污染后续 system/light 镜头（首轮 systemLightChrome=dark 假象）——改一次性 evaluate 预置后重跑（=light 正）。

## 取向登记

- **solar-light 应用皮肤移除**：解耦后不可达（外观只有 system/dark/light）；Solarized 浅色终端配色在浅色皮肤下呈现，与 V5 迁移映射（solar-light→light）一致。
- **AddHostForm/ImportPanel 不入 focus trap**：内联表单非模态（无遮罩），trap 会阻断侧栏可达。
- **门挂卡（TOFU/2FA）不入 trap**：认证流焦点由 autoFocus 管理，trap 叠加有打扰连接风险；登记后续轮评估。
- **VoiceOver 实机朗读**为人工域：DOM 可访问名（aria-label/role/aria-modal/aria-selected）自动化全量覆盖，真机朗读归人工抽验（同 R52 IME 处置）。
- **启动外观闪变**：CSS :root 默认深色、blob 载入后应用——与 hostbar 同既有模式，未做预载脚本（登记）。
- **demo 自动重连节奏/集成关主机**沿用 R26 种子；本轮无新增种子（r27 无 sshd 依赖）。
- **V6 迁移无幂等守卫**（ALTER TABLE 直接执行）：常规路径（version 单调递增）不触发，仅测试回卷场景暴露——迁移加固候选登记，不在本轮扩权修复。
- 高频终端输出不触发 live region（仅 toast 用 aria-live，维持 R25 前状态）；xterm 自身可访问层未启用（登记：读屏终端内容依赖 xterm a11y addon，归后续可访问性轮）。

## 独立审核与视觉复验

### rev-r27（独立代码审核）：**复验终裁：可签**（初判处置后可签：0 高 1 中 6 低；处置独立复验全部通过）

独立实证：全量 diff 实读；:5183 探针复跑 37/37 全绿；基线 :5184 自设反证 A4'/C1' 及作者版 B2 全部旧码红（切终端浅色 data-chrome 翻 light=耦合实证、tab-x span 不可聚焦、Tab 循环后 Esc 焦点=body）；cargo 152/0、tsc 0；oldcode 档案/beacon 两阶段/vis summary 与 README 对账一致。六条主张全部成立、无过度主张：载入零回写（唯一 data-chrome 写点=applyChrome）、matchMedia 挂卸对称、V5 迁移对存量用户 version<5 短路零突变且老键映射测试未放宽、"system" 值 Rust 侧仅透传、标签守卫不误伤本体激活、命中区 ::after 在 tabbar 溢出边缘不触裁剪（tab 自身 10px padding 容纳 +5px）、--focus 双色充足、FONT_DEFAULT 14 已存偏好零影响。

- **中-1（处置后可签项）已修**：useDialogFocus 初始聚焦 focusables()[0]，而五个确认类模态（关闭会话/退出/删主机/删凭据/粘贴发送）danger 按钮全部 DOM 首位 → 弹窗打开即预武装破坏动作，纯键盘用户一次 Enter 即删主机/多行直发远端 shell/杀全会话（rev 于 :5183 实证 deleteHost activeElement=「删除」danger 钮；R27 前无 autofocus，属本轮新引入回退）。**修 = 钩子 `[data-autofocus]` 优先（取消钮打标，无标记回落首位）+ 探针 C1b2/B4a2「初始焦点=取消钮」判别两条**（处置前落 danger 钮必红）；处置后 39/39 ×2 归档。
- **低-1 登记**：关闭/删除流触发控件（tab-x）随子树卸载焦点还原落空（还原目标 isConnected 检查兜底为不落）。
- **低-2 登记**：tablist 无 aria-controls、键序偏离 APG tabs 模式（Tab 进出而非方向键）——现有交互简单、开销大于收益。
- **低-3 登记**：启动外观闪变（作者已登记，见取向）。
- **低-4 登记**：相邻钮 ::after ≤2px 重叠（双方皆真钮、点击语义均为按钮自身，无后果）。
- **低-5 登记**：changeAppearance 静默吞写失败（沿袭 persistSetting 尽力而为语义；blob 下次整存自愈）。
- **低-6 已闭环**：「37/37 ×2」当前树探针输出未归档——补归档 probe-run1/2.log（处置后 39/39 ×2 stdout）。
- 执行插曲措辞已按建议精确化（基线 span 时代键盘路径不可达 vs 开发中间态守卫前误触 attach，两面判别分述）。

**复验（处置后）**：修法核实（钩子 [data-autofocus] 优先 + isConnected 兜底，五取消钮打标，Rust/styles 零改动=视觉零足迹成立）；探针独立复跑 39/39 ×2 与归档一致，C1b2/B4a2 判别真实（处置前必红——初审实证过该行为）；tsc 0；补刀实证：deleteHost 初始焦点=取消钮、Enter 在取消钮只关框不删、设置面板回落首位与 Esc 还原不变、真实点击 host-del 全链（初始焦点取消→Esc 还原触发钮）成立。附带澄清（无新发现）：host-del 无 hover 时 elementFromPoint 返回 host-line——对照基线 :5184 逐点一致，是既有 hover 显现钮工艺（opacity:0+PE:none）非 R27 回归；hover/focus 显现后真实点击与 ::after 命中带 +3px 均实证生效，+5px 边界与相邻钮竞争归低-4 同类。

### vis-r27（独立视觉复验）：**视觉可签**（自写探针独立复测，作者 7 项主张全部复现、零反向）

方法学与作者不同：context 级 colorScheme 走产品 system 解析路径、严格+容差双计数像素 diff、真实 Tab 键行走。对账表：welcome 双树 diff=3px 与作者逐位一致且容差计数=0、自差噪声底 0（亚阈 AA 噪声判定成立）；addform 0px；面板 280×558、全 11 钮零相交零截断、字号 "14" 且 xterm 实渲染 14px；system 新装 light 解析 + live 双向实时跟随（作者只证单向）；四配色两两 548k px（自差噪声 ≤858）；tab-x/split 双树同 18×18、+3px 命中判别成立（base 命中父 tab）、focus 环 2px rgb(145,186,255) 三控件实测；浅色皮肤目验 4 张不破；pageerror/console 均 0。4 项登记不阻塞（split +3px 落相邻扩展盒、addform 0v2px 噪声内等）。报告 /tmp/vis-r27-report.md，独立证据 /tmp/vis-r27-independent/。

## 证据清单

- `r27-demo-probe.js` — demo 探针（39 断言；含旧码必红判别 8 处 + rev 处置判别 2 条）
- `probe-run1.txt` / `probe-run2.txt` — 处置后 39/39 ×2 stdout 归档（原 .log 后缀撞库级 *.log ignore，更名入库；app 运行日志沿 R26 惯例不入库）
- `oldcode-probe-main.txt` / `oldcode-probe-t1t4.txt` — 基线 ddd9d60 判别力实证（6 红 + 崩溃点 / T1–T4 全红）
- `r27-driver.sh` + `beacon-r27a.txt` + `app-r27a.log` + `app-r27a-p2.log` — 原生冒烟两阶段全链
- `r27-vis.js` + `vis/` — 双树逐像素（base/cur 截图 + r27-vis-summary.json）
