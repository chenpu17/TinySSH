# UX-R1 G3 · R33 上传下载入口、原生选择器与拖拽目标 —— 验收证据

基线：4893865（R31）。日期：2026-10-09。

## 任务面

「上传下载入口、原生选择器与拖拽目标 | FE/Core | deps R31/R32」（§354/§356）。本轮增量：

1. **§354 上传入口**：文件面板「上传」钮 → 原生文件选择器（tauri-plugin-dialog `pick_upload_files`，Rust 侧 spawn_blocking 包 blocking_* 调用；多选）；目标=正在浏览的目录；取消=零副作用不建卡。拖放落点分区：**文件面板落点=直接上传到正在浏览的目录（不确认）**；其余落点（终端等）=目标确认卡——分区按 Tauri drop `position`（物理像素）÷ devicePixelRatio 与面板实测矩形求交，面板分区仅在 `rightPanel==='files'` 时存在。
2. **§354 终端拖入确认卡**：「上传到 <host>：」+ 目录输入（预填可信 cwd=该会话 brief.cwd，与定位钮同源；不可信而面板可见且正在浏览 → 以浏览目录预填；**不可见面板旧路径一律不借用**——面板关闭时留空必填+明确提示行）+ N 个文件行 + 取消/上传到此处（空目录禁用）。目录输入先 `sftp_resolve_path` 归一（相对路径/`..` 按服务端语义解析，与 navigateTo 同工艺），失败=卡保持打开如实报错零上传。**目标会话在拖放开始时固定**：切标签/关会话即失效+明确 toast「上传已取消：目标会话已切换」，不静默改投另一主机。
3. **§356 下载入口**：本地目标默认**上次下载目录**（首次=null→核心落系统 Downloads；`download_file` local=完整文件路径）；「另存为…」动作菜单项 → 原生保存对话框（`pick_save_file`，取消=零副作用），确认后记忆其目录；按远端绝对路径下载保持（路径输入框/动作菜单/行级钮）。目录记忆落 `ui.v2.workspace` blob 新域 `transfers.download_dir`（session-api `Workspace`+`TransferPrefs`，serde default 兼容旧 blob；FE 经 wsWriteChain 串行化写，同值不重写）。卡片显示完整本地目标（handle 回填 h.local）。
4. **杂项**：导航行新增上传钮（::after inset -5px 命中扩展，R27 工艺）；空态/列表尾部/欢迎帮助三处文案随分区与目录记忆语义更新；demo 传输空态提示同步。

## 关键设计事实

- **可信目标层级**：brief.cwd（shell 集成上报）> 可见面板浏览目录 > 空（必填）。不可见面板路径不可作预填——demo 域经 `demo_brief_cwd` 判别钩子（覆写 session_brief cwd，null=模拟无集成）实证三分支。
- **drop 分区读 ref 不读闭包**：`rightPanelRef`/`sftpPathRef`/`briefRef`——处置排障中实证 useCallback 闭包在面板开合后存在捕获旧值的竞态类别（探针 D 节曾以歧义信号误判，信号修正后行为确认正确；ref 化按加固保留）。
- **demo 拖放判别钩子**：demo 无 OS 拖放通道，`demo_drag_drop {paths,x,y}`（逻辑像素）触发 App 注册的 `window.__demoDrop`，走与原生 onDragDropEvent 相同的 `beginDropUploads`（原生侧多做 position/dpr 换算）。
- **选择器命令 Rust 侧调用**：tauri-plugin-dialog 的 blocking_* 不得在主线程调——`tauri::async_runtime::spawn_blocking` 包裹；无 FE capability 项（Rust 侧 API）。

## e2e

- **demo 探针**（真实 Chromium + vite :5183，r33-demo-probe.js）：**36/36 ×3 连续独立轮**（probe-run1/2/3.txt）。A 上传入口 5（钮存在可用/取消零建卡/默认桩 2 文件上传/dest=浏览目录+固定会话）；B 下载目标 9（另存为菜单项/默认 Downloads 完整路径/blob 记忆/预置路径 honoring/记忆更新/普通下载落上次目录/**取消零副作用**/取消后记忆完好）；C 拖放分区与确认卡 13（终端落点出卡/预填可信 cwd/文件行/确认按固定会话上传/取消零上传/清空禁用/Esc 关/面板落点直传浏览目录无卡/面板关闭同坐标出卡/**切标签失效+明确 toast+不静默改投**/坏路径卡保持+明确错误行+零上传/`..` 归一上传）；D §354 不可见借用 6（浏览≠cwd 时定位钮 enabled 证明信号无歧义/覆写 null 后 disabled/**可见面板路径预填**/**不可见面板不借用：预填空+提示行+禁用**/可信恢复预填新值）；Z 零 JS 错。
- **旧码判别力实证**（基线 4893865 worktree :5184，r33-oldcode-probe.js，oldcode-probe.txt）：**8/8 判别红**——上传钮缺席/pick_upload_files 未实现/pick_save_file 未实现/动作菜单无另存为/window.__demoDrop 钩子未注册/demo_drag_drop 未实现（旧码浏览器域无任何可触发拖放路径）/下载恒系统 Downloads 无记忆/transfers blob 域缺席。
- **R31 回归**（当前树）：demo 探针 48/48 + 竞态判别 6/6（r31-regression.txt / r31-race-regression.txt）。
- **原生冒烟**（release 二进制 + 隔离 DB + 口令 env + beacon + 真机 sshd 容器；驱动 r33-driver.sh 单阶段 r33a ×2）：**待解锁补档**（定时闸解锁后跑 ×2 归档 beacon；锁屏同 tinyssh-e2e-needs-unlocked-screen 纪律）。r33a 链路：面板「上传」→ NSOpenPanel（驱动 GoTo+⌘A+Return 多选确认）→ 3 文件真上传容器全 Succeeded → 动作菜单「另存为…」→ NSSavePanel（驱动 GoTo+Return）→ 真落盘 + blob 目录记忆 → 普通下载落上次目录真落盘 → 双轮落盘/远端对账。**原生拖拽通道（Finder 拖入）无法诚实合成**——分区/确认卡行为判别归 demo 域（登记）。
- **workspace**：**165/0**（32 套件全绿；+1 session-api `workspace_transfers_field_wire_compat`：旧 blob 反序列化 transfers=None/新载荷 round-trip/域对象缺 download_dir 不虚构）。tsc 0。
- **vis 自检**：r33-vis.js **14/14 ×2**（vis-run1/2.txt + vis-artifacts/）——welcome 双树 diff=4226px=本轮有意触碰的帮助文案行（有界局部差+新文案渲染断言）、导航行 7 钮零截断零重叠、确认卡盒测量视口内/输入 366×28/双钮可见/Esc 还原、动作菜单两钮 132×91 视口内、面板零横向溢出、零 JS 错。

## 执行插曲（如实）

1. **探针连错会话（R31 同案再现）**：demo connect 新建会话，`list_sessions` 轮询先撞上种子 Connected 会话——本轮从探针 A0 起即取 created_at 最新 Connected 为目标会话（R31 教训入库生效）。
2. **demo_drag_drop 丢坐标**：首版 demo 钩子只转发 paths 未转发 x/y——面板分区判别全走终端分支（C5 红）。修=钩子透传坐标。
3. **D 节信号歧义（作者自查）**：覆写 brief.cwd 后以「定位钮 disabled」为传播信号——但浏览目录==旧 cwd 时该钮本就 disabled（`sftpPath === brief.cwd` 亦真），waitFor 立即假通过，D1–D3 全红且红因不可判别。修=D0 前先导航浏览到 ≠cwd 目录使信号无歧义（D0b 断言 enabled 基线），修后 36/36 且三分支行为与设计一致；曾并行把 beginDropUploads 改 ref 读取（闭包竞态类别加固），保留。
4. **rev-r33 中-1（预填借用不可见面板路径）**：初版 `prefill = brief.cwd || sftpPath` 无可见性门——会话无集成 + 曾浏览后面板关闭时预填旧路径，违 §354 且与卡内「无可信目录」提示自相矛盾。修=rp 门 + 判别面补齐（见 D 节）。

## 取向登记

- **原生拖拽通道不可自动化**：真实 Finder 拖入无法诚实合成——分区/确认卡判别归 demo 域（demo_drag_drop 与原生共用 beginDropUploads，坐标口径原生=物理/dpr、demo=逻辑直传）；原生冒烟只验选择器/传输链路真通道。
- **running 卡不显示完整本地目标**（rev 低-3 登记）：完成时刻显示完整 local（R32 既有卡面）；进行中显示「…」占位——§356「显示完整本地目标」在完成时刻满足，卡面增强归后续轮。
- **pick_save_file defaultDir 被删**：原生面板回落默认位置，用户可导航/取消，无数据风险；demo 域不可测。
- **zone=panel 且 sftpPath 空**（面板开着但首载失败/在途）：回落 brief.cwd 静默直传（窄窗+可信源+失败卡如实）——登记。
- **拖放监听重订阅窗**：drop effect 依赖 beginDropUploads（现为稳定引用）——导航期理论重订阅窗与旧码同模式，非本轮引入。
- **R32 低-3 边界**：Committing/AwaitingDecision/OutcomeUnknown FE 呈现归 R34——本轮零越界（rev 复核确认）。
- **welcome 帮助文案为有意触碰面**：welcome 双树 diff=4226px=该行文字区；其余 welcome 面零差异。
- **vault c8 flake**：本轮 workspace 首跑一例（recents 排序同时刻打点不稳定，crates/vault/src/lib.rs:1540）——单跑复绿，判既有 flake 家族（R30/R32 已登记）非本轮引入。

## 独立审核与视觉复验

### rev-r33（独立代码审核）：**处置后可签**（初判 1 中 4 低；中-1+低-1/2/4 已修，低-3 登记；处置复核=其独立探针在终态树复跑绿 + 作者判别面补齐）

独立实证：diff 逐行实读（703+/18-，与作者无并行混入对账一致）；tsc 0 + workspace 165/0（--no-fail-fast，含 c8 flake 复绿判定）+ demo 探针 26/26 ×2 + 旧码 8/8 + vis 13/13 自跑。**红侧判别两项（还原后 cmp 逐字节通过）**：摘 §354 sid 失效 effect → 探针 C7b 红；摘 zone rightPanel 门 → forwards 页同坐标拖放静默直传不可见面路径（自建探针实证）→ 还原绿。规格对账全过（§354/§356 + R30/R31/R27/R32 不破坏 + R34 边界零越界 + useDialogFocus 初始焦点合 rev-r27 中-1 纪律）。

- **中-1（已修+判别面补齐）**：确认卡预填借用不可见文件面板路径——初版 `prefill = brief.cwd || sftpPath` 无可见性门，与卡内「无可信目录」提示自相矛盾（其 scratch 副本探针 RED 实证；demo 域原不可达）。修=rp 门；demo 新增 `demo_brief_cwd` 覆写钩子使「无可信 cwd」分支可达，探针 D 节 6 断言三分支全绿。
- **低-1（已修）**：demo_pick_result "path" in args 语义（空串=模拟取消）；saveAs 取消零副作用由其独立 rev-saveas-cancel-probe 终态树复跑绿。
- **低-2（已修）**：确认卡目录先 sftp_resolve_path 归一，失败卡保持+错误行+零上传；`..` 归一上传。
- **低-3（登记）**：running 卡不显示完整本地目标（R32 既有卡面，完成时显示）。
- **低-4（已修）**：行级下载钮 title 与列表尾部 side-quiet 旧文案更新。
- **处置复核（终裁已回）**：rev-r33 终裁**可签**——处置复核全过（中-1 修法正确：App.tsx prefill 可见性门 + rightPanelRef 化，ref 化顺带消除导航期重订阅窗判合理加固；低-1/低-2/低-4 已修且判别面补齐）；独立复跑全绿（tsc 0、session-api 8/8 Rust 面零触碰、demo 探针 36/36 ×2、oldcode 8/8、vis 14/14）；**红侧第三刀对新增守卫**：摘 prefill 可见性门 → D2 精准独红（35/36，仅 D2 prefill 借用重现），还原 cmp 逐字节通过后回绿 36/36——新守卫判别力实锤。其探针归档 rev-r33-probes/。
- 注：终裁消息晚于主提交（013dc58）到达——提交时按当时状态如实登记「未回终裁」；终裁到达后本节修正，代码零改动。
- **登记不阻塞**：defaultDir 被删原生面板回落；zone=panel 且 sftpPath 空回落 brief.cwd 静默直传（窄窗+可信源+失败卡如实）；拖放监听重订阅理论窗（旧码同模式）；原生冒烟 r33a 驱动就绪待解锁（拖放分区原生通道不可合成判别归 demo 域成立）；vault c8 flake 判既有家族。

### vis-r33（独立视觉复验）：**视觉可签（含处置复验 14/14 全过）**（初判 27/27 两轮全绿零 pageerror 零 FAIL；观察 a–d 全非阻塞，c/d 已处置；终裁处置后视觉可签）

独立方法学（自写探针 /tmp/vis-r33/，Range 截断检测+盒测量+双口径像素 diff+elementFromPoint 命中实测，规避 ::after scrollWidth 伪影）：welcome 双树 strict=0（处置前）→ 处置后双树差有界于 welcome 步骤区（strict=5146，bbox 364×34=文案行，步骤区判定 true）+新文案渲染；导航行 7 钮 1280/640/360 全可见零截断零重叠+命中区右缘+3px 实测 7/7+上传钮真实点击接线；确认卡全链 400×161 视口内/输入 366×28/焦点环 3px/清空 disabled+opacity 0.40/Esc 焦点还原/两轮开关零残留/Enter 提交建卡；动作菜单两钮 132×91 焦点入首项（rev-r31 低-7 语义保持）；浅色对比度 15.07:1–21:1；**处置复验 recheck 14/14**（欢迎差有界+新文案+尾部文案+错误行深浅两色渲染零截断+深色对比度 15.07+提示行三分支）。截图归档 vis-r33-artifacts/（rc-card-err/hint 深×浅、recheck-report.json）。

## 证据清单

- `r33-demo-probe.js` — demo 探针（36 断言；A5/B9/C13/D6/Z1）
- `probe-run1.txt` / `probe-run2.txt` / `probe-run3.txt` — 当前树 36/36 ×3
- `r33-oldcode-probe.js` + `oldcode-probe.txt` — 基线 4893865 判别力（8/8 红）
- `r31-regression.txt` — R31 探针回归 48/48（当前树）
- `r31-race-regression.txt` — R31 竞态探针回归 6/6（当前树）
- `r33-vis.js` + `vis-run1.txt` / `vis-run2.txt` + `vis-artifacts/` — 视觉自检（14/14 ×2）
- `vis-r33-artifacts/` — vis-r33 独立复验脚本与处置复核报告（recheck-report.json 14/14 + 截图）
- `rev-r33-probes/` — rev-r33 独立红侧/判别探针（终态树复跑绿）
- `r33-driver.sh` — 原生冒烟驱动（r33a ×2；锁屏闸；NSPanel 键序守望者）
- `ws-full.txt` — workspace 165/0 全量（32 套件）
- （待补）`beacon-r33a-r1.txt` / `beacon-r33a-r2.txt` — 原生冒烟 ×2（等屏幕解锁，定时闸接管）
