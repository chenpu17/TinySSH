# UX-R1 G3 · R30 路径、条目元数据与会话隔离（C4）—— 验收证据

基线：d9fa3eb（R27，G2 收官）。日期：2026-10-08。

## 任务面

「C4 实现：canonical path、未知字段、符号链接策略、过期响应保护」（§546/§352/§348；C02 验收：延迟注入 + UI）。本轮增量：

1. **契约面（session-api）**：`EntryKind`（dir|file|symlink|other）；`DirEntryS` 扩充 `kind: Option`（None=旧载荷升级兼容）+ `size/mtime → Option`（§352 未知不以 0 冒充，UI 显「—」）；新类型 `PathResolved{canonical}` / `EntryStat{canonical, kind, is_dir, size, mtime, symlink_target}`（kind/symlink_target=lstat 语义；is_dir/size/mtime=follow 跟随语义，follow 失败回落 lstat）；新 trait 方法 `sftp_resolve_path`（path=None → SFTP 初始目录 `canonicalize "."`）/ `sftp_stat`（只读、Human 浏览口径同 sftp_list）；错误变体 `SftpPathNotFound{path}` / `SftpPermissionDenied{path}`（wire kind `sftp_path_not_found`/`sftp_permission_denied`，单点映射 wire_parts + mcp error_kind/error_detail + FE WIRE_ERROR_KINDS 三端同表）；`Error::from_fs_err` 共用映射（NotFound/PermissionDenied → 专用变体）。
2. **传输面（transport-ssh）**：`sftp_channel()` 临时通道助手（guard+session 成对防并发 close 拆连接）；`resolve_path`=canonicalize；`stat_entry`=symlink_metadata(lstat)→read_link(仅 Symlink)→metadata(follow，失败回落 lstat)→canonicalize；`list_dir` 扩充 kind + Option size/mtime；`map_sftp_err` 状态码映射（NoSuchFile/PermissionDenied → 专用变体）。transport-pty 本地对等实现（canonicalize/symlink_metadata/read_link，本地浏览器同链路）。
3. **会话面（core-session）**：两入口 Human 浏览口径（Agent 拒绝，同 sftp_list）；r30_tests 3 判别（Agent 双拒/Human 转发+悬空链接形状+错误透传/未注册 SessionNotFound）。
4. **FE 浏览器（App.tsx）**：**C02 过期响应保护**——sftp 请求代际 ref（sid+gen 双判别，晚到旧响应丢弃不覆盖新路径不误清 loading）；**§348 首载链**——本次连接可信 cwd（brief.cwd）→ 失败回落 `resolve(null)` SFTP 初始目录 → 均不可用留错误与输入框（每会话一次，浏览位置不回跳）；**§352 呈现**——size/mtime null 显「—」；**符号链接**——行显「→」glyph +「链接」标签、名字按钮化，点击 `sftp_stat` 探明目标（is_dir follow 语义）→ 目录进入/文件下载，失败如实报错；**canonical 导航**——路径输入 Enter 先 `resolve` 归一再列目录（`../` 归一、前端不猜路径），不存在/权限按 kind 可读呈现。
5. **demo**：树扩充 kind/symlink（latest→archive、current→releases/v3 可进 + gone-link 悬空）/未知字段（php-fpm.sock size/mtime null）/拒绝路径 /var/private；`sftp_resolve_path`/`sftp_stat` mock（严格语义：不存在即拒）；**C02 判别钩子 `demo_sftp_slow{path,ms}`**（命中路径延迟应答）。

## 关键契约发现（真机实证，与初始设计不同）

- **OpenSSH realpath 宽容语义**：对不存在的末段**词法归一即成功**（不查存在性；悬空符号链接的 canonical=归一化目标路径）。「不存在」的可区别错误由 **list（read_dir）/stat（lstat）** 承担——二者必查存在。canonical=None 仅严格实现给出；服务端依赖，前端两态同待（EntryStat doc/wire.ts 注释已载）。cargo 真机 e2e 实证（`resolve('/tmp/t41_dir/definitely-missing')` 返回归一路径 → 断言两态可接受）。
- demo 的 resolve 选择**严格语义**（不存在即拒 sftp_path_not_found）与真机宽容语义并存：FE 对两态同路径处理（resolve 失败→错误；成功→list 阶段报错）——demo 探针 B9 与原生冒烟 missing-err-ok 分别覆盖两条触发路径。

## e2e

- **demo 探针**（真实 Chromium + vite :5183，r30-demo-probe.js）：**25/25 ×2 连续独立轮**（probe-run1/2.txt）。A 契约 8（resolve 初始目录/`..` 归一/missing→sftp_path_not_found/denied→sftp_permission_denied/stat symlink 三态〔可达 canonical+target、悬空 canonical=null、socket kind=other+双 null〕/list kind+null 字段）；B UI 11（首载链 cwd/canonical path 栏/「—」双格/→+链接+按钮/点击 symlink 进入跟随列表〔含 /root/current→v3 内容〕/`../` 输入归一后列目录/missing·denied 可读错误）；C C02 三（慢目录 1200ms 预置→快导航先落→**晚到响应不覆盖**〔path/rows 双断言〕+loading 清理〕；Z 零 JS 错。
- **旧码判别力两面实证**：
  - 基线 ddd9d60（worktree :5184，oldcode-probe-main.txt）：**10/25，15 判别红**——A1–A8 全红（命令不存在→null/invalid_input）、B4（无未知字段条目）、B5/B6/B8（无 symlink 条目）、**B7 输入 `/root/../root/deploy` 原样显示不归一**、B10 权限路径误报「目录不存在」（不可区别）。
  - 中间态（当前树仅摘代际守卫，worktree :5185，oldcode-probe-mid.txt）：**24/25，唯一红=C2**——晚到 `/root/logs` 覆盖 `/root/deploy`（path=/root/logs rows=app.log），实证 C02 断言判别力（新码 C2 守住 deploy）。
- **原生冒烟**（release 二进制 + 隔离 DB + 口令 env + beacon + 真机 sshd 容器；驱动 r30-driver.sh 每轮预置 /tmp/r30dir：sub/ a.txt=6B b.txt alink→a.txt slink→sub dangling→missing）：**r30a 全链 DONE ×2、零 FAIL、零 JS-ERROR/REJECT、进程零残留、容器测试树清理**（beacon-r30a.txt 为终轮）。invoke 契约面（resolve null→/root 初始目录、`/tmp/../tmp/r30dir`→归一、list/stat missing→sftp_path_not_found、list kind 三态、stat 文件 6B/canonical 精确、alink 跟随 size=6+canonical=目标、dangling target=missing+canonical 两态）+ UI 面（canonical 导航、行渲染 目录/链接/6 B、slink 点击进入〔保留请求路径、跟随列内容〕、missing 输入可读错误）。
- **cargo 真机 e2e**（TINYSSH_E2E_SSHD=1，共享容器）：**7/7**（sshd-e2e-run.txt）——list_dir kind+排序（目录先、链接与文件同名序）+missing→SftpPathNotFound；resolve `..` 归一/None 初始目录绝对/missing 两态；stat 文件/可达链接（follow size）/悬空（target 保留+canonical 两态）/missing→SftpPathNotFound。
- **workspace**：**156/0**（+3 core-session r30_tests；sshd_e2e 编译期同步新形状）。tsc 0。
- **vis**：r30-vis.js **9/9**（vis/r30-vis-run.txt + 截图）——welcome 双树（当前 vs 纯 R27 :5186，统一深色）diff=3px（跨 vite 实例亚像素，自差噪声底 0；R27 同面先例 3px）+ files 面盒测量（sock「—/—」、latest「→/链接」、无截断/零溢出、denied 错误 363×21 不截断、共享名行高对账 ±1px〔archive 26=26、access.log 31=31、error.log 30vs31 亚像素〕）、640 窄窗不破、零 JS 错。

## 执行插曲（如实）

1. **探针三处工艺**：demo 探针 rejection 须在页面内捕获归一（evaluate 外层 catch 拿不到 kind）；React 受控输入须原生 value setter（直赋被 tracker 去重丢 onChange——首轮 B7+ 全停在旧路径的根因）；原生冒烟 setInput 用 execCommand（WKWebView 同理，r26 已验证工艺）。
2. **原生冒烟两轮假失败**：(a) 驱动 cleanup 每轮删 /tmp/r30dir 而预置在驱动外——第二轮起 not_found；预置并入驱动。(b) `.st-file` 查找无等待（attach 异步过渡）偶发——加 waitFor(100) 并在失败信息带现场状态（tabs/cards/view）。修正后 ×2 DONE。
3. **smoke symlink 点击断言修正**：FE 保留请求路径（/tmp/r30dir/slink）列跟随内容——初始断言误写目标路径 /tmp/r30dir/sub；与 demo B8（/root/current）同语义。
4. **真机 realpath 宽容语义**（见上节）——初始「悬空→canonical=None」设计按 OpenSSH 实测修订为服务端依赖两态；smoke/e2e 断言同步。
5. **vis 基线选树**：初次用 ddd9d60（R26）作视觉基线 → welcome 全屏 diff（R27 新装默认跟随系统 vs 旧深色回落——R27 意图内差异非 R30 回归）；改纯 R27（d9fa3eb）worktree + 双树统一深色 emulate 后 3px。
6. **sshd_e2e 偶发**：并发轮 `ssh_shell_blocks_and_fresh` 报 no OSC 133（三试均败）——单独复跑即过、全套复跑 7/7，判环境抖动（与 R19/R24/R23/R25/R30-vault 已登记 flake 同族，该测试自带重试 3 次仍遇容器负载）。
7. **vault c8 并行偶发**：首次 workspace 全量跑 c8_favorites 失败（host id 不匹配）——单测 + 全 vault 套件两轮全绿，判并行负载 flake（同上家族），全量复跑 156/0。

## 取向登记

- **resolve-missing 语义服务端依赖**（OpenSSH 宽容 vs 严格实现）：错误映射保留（严格实现/其它服务器仍可能 NoSuchFile）；「不存在」判别主张落在 list/stat。
- **权限不足判别原生面不可达**：容器 sshd 以 root 跑，chmod 000 不产生 EACCES——原生冒烟无 permission 用例；kind 映射由单测（from_fs_err/r30_tests stub）+ demo 探针 A4/B10 承担。
- **§348 旧连接路径候选**：未做重连后恢复上次浏览位置（cwd 优先 + 初始目录兜底已覆盖主路径；恢复旧路径需再验证成本高于收益，登记）。
- **brief 未到达不首载**：会话在建连即死等场景浏览器静默待命（与 R15 既有行为一致）。
- **symlink→文件点击=下载**：stat 探明 is_dir=false 走下载（tar.gz 链接场景自然）；无独立「查看链接目标」信息面（symlink_target 已在 stat 载荷，UI 按需消费 title 提示）。
- demo resolve 严格语义（见关键契约发现节）。
- 原生终端内拖拽上传目标目录不受 C02 影响（上传 dest 取自 sftpPath 现值，非异步响应）。

## 独立审核与视觉复验

### rev-r30（独立代码审核）：**处置后可签**（初判 1 中 3 低；处置独立复验通过）

独立实证：diff 实读 13+1 文件逐条对账主张；sftp_channel guard 并发 close 阻塞核实（与 upload/list 同模式）；错误映射三端同表无遗漏；cargo 156/0（首轮 c1 时序窗 flake 单跑即过判登记家族，二轮零红）、tsc 0、真机 e2e 复跑 7/7；demo 探针复跑 25/25 ×2；旧码判别两面独立复现（基线 10/25 十五红逐条一致 / 中间态 24/25 唯一红=C2）；beacon 标记链与驱动逻辑吻合；README 无过度主张。反证探针作者 25 断言外自设 7 项活体全绿（三连导航最后发起者胜/错误后可恢复/symlink+手动导航竞态/空白输入早退/零 JS 错；初轮 2 红甄别为 rev 探针自身断言笔误）。

- **中-1（已修+复验）**：navigateTo/openSymlink 的 catch 缺 sid 判别——resolve/stat 迟到失败响应可把错误写入已切换会话的浏览器（与 loadDir/首载链纪律不一致；demo 域无法活体复现——resolve 同步返回无慢钩子，代码读核+同文件对照实证）。修=两处 catch 街 `sidRef.current === s` 判别（与 loadDir 同纪律）；处置后 tsc 0 + 探针 25/25 ×2 归档刷新。
- **低-1（已修）**：main.rs r26_smoke_script 签名行与 let base 合并（插入时格式噪声）——已分行。
- **低-2（登记）**：原生「×2 DONE」仅终轮 beacon 归档（README 已自注；第一轮无独立归档，过程主张）。
- **低-3（登记）**：openSymlink 成功路径 stat 在途期间手动导航后，迟到 loadDir 可夺位至链接目标——窗口=一次 stat RTT、语义可辩（用户刚点过链接）。

### vis-r30（独立视觉复验）：**视觉可签**（零反向，六条主张全部成立）

独立方法学：真实键盘输入路径栏 + 真实点击 symlink、三连拍自差、1280/1024/640 三 viewport、扩展行型（/root 悬空链接/长名）、严格容差 0 像素 diff。对账：welcome 双树 diff=0（1280/640 双 viewport，噪声底 0——比作者更严）；sock 双「—」+ latest「→/链接/BUTTON」；全行型零截断零溢出；denied 错误 363×20.9 完整；行高对账 ±1px（扩展 /root 共享 6 行全等）；640 不破版；零 JS 锞。登记观察 5 项（非阻塞）：O1 按钮名字居中 vs span 齐左=既有目录钮工艺延续（基线 archive 同样居中）；O2 路径栏显示访问路径非 canonical（列表内容已跟随）；O3 denied 时旧列表保留+错误并存；O4 基线/cur 错误分级措辞差异=C4 愦图改动；O5 error.log 1px 亚像素。独立证据 /tmp/vis-r30/。

## 证据清单

- `r30-demo-probe.js` — demo 探针（25 断言；含旧码必红判别 15 处 + C02 中间态判别）
- `probe-run1.txt` / `probe-run2.txt` — 当前树 25/25 ×2 stdout
- `oldcode-probe-main.txt` — 基线 ddd9d60 判别力（10/25，15 红）
- `oldcode-probe-mid.txt` — 中间态（摘代际守卫）C02 判别力（24/25，C2 红）
- `r30-driver.sh` + `beacon-r30a.txt` — 原生冒烟驱动 + 终轮 beacon（×2 DONE）
- `sshd-e2e-run.txt` — cargo 真机 e2e 7/7
- `r30-vis.js` + `vis/` — 视觉复验（9/9；welcome 双树 + files 面盒测量截图）
