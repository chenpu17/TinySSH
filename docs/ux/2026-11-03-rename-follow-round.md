# tmux 改名跟随轮（2026-11-03）

用户原话：「建议能探测出来，毕竟这个影响用户体验。另外最近修改内容比较多，你安排 subagent 再认真审核审核。」——前半句拍板兑现上一轮立案的「改名后界面不跟随」，后半句是全工作区审查指令（同日下午另批，见文末）。

## 一、病根

面板全链按 **tmux 会话名**认会话；tmux 侧改名（C-b $ / 别处 rename-session）后名字脱节，且对前端没有事件：

- 探针只报 `名|窗口|附着`，核心格子表（`TmuxPane.tmux_session`）、愿望清单、主视图 attach 记录全是按名记的；
- 格子标题/主视图名牌/快接菜单停在旧名；「＋面板」可对同一会话再开一格（按名去重失效）；重建按旧名 attach 判「会话不存在」摘格；探针把改名后的 attach 记录当残留清掉（按名找不到 → 主视图 C-b 前缀武装随之停用）。

**修法（上一轮已定，本轮落地）**：tmux `#{session_id}`（`$N`）改名不换——探针带 id，全链按 id 认、按名显示。

## 二、修复面

**核心（session-api / core-session）**

- `TmuxSession` 加 `id` 字段（极老 tmux 空串=退化按名认）；探针命令尾加 `#{session_id}`；解析从右取 4 段、id 加 `$数值` 形状闸（会话名含 `|` 不破、名叫 `tmux 5` 不吃成版本行）。
- `TmuxPane.tmux_session` 改锁保护 + `tmux_sid` 落账；`tmux_session_exists`（has-session）升级为 `tmux_session_resolve`（`display-message -p -t '<sel>:'` 取当下 id+名）。**坑 96**：第一版写成 `tmux ls -F … -t '<sel>'`——`list-sessions` 根本没有 `-t`（真机 exec 通道 stderr 实证 `unknown flag -t`；交互壳里「RC=0」的验证是回显行被当成输出的假证据）。尾冒号=会话当前窗格（坑 81 同因）。
- 开格解析出当下 id+名再 attach：rebuild 先按死条目记的 id 试（掉线期间被改名也原位跟上），id 失效回落按名；id 在手直接 `$N` attach（改名与开格竞态不开错对象）。
- `tmux_reconcile_names`（探针后跑，先于 attach 残留校正）：同 id 不同名 → 格子名/愿望清单/主视图 attach 记录原位刷新（保序）。**真机补**：纯主视图（不在任何格子的 attach）也要按 id 跟随——格子循环覆盖不到它，补直刷段（单测钉死）。
- `tmux_attach`：id 先落账（探针缓存缺了现解一次）；目标选择器 id 在手用 id；attach 预占/回滚带上 `tmux_attached_id`；锁序统一 `panes → wishlist → tmux_attached_id → tmux_attached`。
- attach 残留校正按 id 认（id 对上但零客户端才清；改名不再误清）。

**前端（App.tsx）**

- 对账 effect 加改名跟随：快照名 ≠ 格子名 → 标题/数据集/拖拽键全换 + **布局树叶子原位换键**（`renameTileKey`，重命名不掉位置）；`bindTileDrag` key 改 getter（按下瞬间现取，不钉死旧名）。
- **名牌即时换装**（真机揪出）：layout 只在格子开合/拖拽时跑，attach/改名不经过它——对账 effect 按签名比对直接重写名牌文本（3s 轮询空转零动作）。
- **C-b $ 补探针**：改名对前端没有事件，`takeTmuxPrefixKey` 消费到前缀后的 `$` 即排 2.5/7/20s 三连补探针（提交时刻无从得知，最近一发命中即刷新；同一目标重按重排）。
- demo 镜像：fixture 全带 id；格子改名提示符进 `renaming` 态，回车提交原子换 格子名/清单/attach 记录（真 tmux 提示符**预填旧名**，spec 据实断言）。

## 三、验证

- Rust：core-session **183/183**（新增 `tmux_reconcile_names_follows_rename_by_id`、`…_main_view_only_rename`、`pane_rebuild_follows_rename_by_dead_pane_id`，审查后又加连环改名/纪元闸/形状闸三个）；workspace lib 全绿。
- 变异 6/6 红：对账短路 / 重建去 id 解析 / 残留校正去 id 臂 / 前端标题不刷 / **连环改名二段式退回逐条 find**（审查后加）/ **纪元闸摘除**（审查后加）。
- UI：spec 63 **107/107**（+10：无前缀￥、还原、一次性、改名跟随×6、重名拒绝、预填提示符、helper 语义）；全套 **1067/1067**（README 双语 56 spec/1067 同步）；tsc 0；npm build ✓；release ✓。
- **真机**（release + 库副本 + 独立 WebView 目录 + CDP，腾讯-广州 tmux 3.4，用户实例未动）**15/15 ×2**（坑 97 修前修后各一轮，第二轮探针带真 `server_pid: 4075115`）：格内 C-b ￥ 改名 → tmux 在册新名；格子标题原位换新名（pane_id 不变）、核心清单/探针（新名+$0）秒级跟上；旧名格摘除；防呆跟 id 走（新名拒重开/旧名不存在）；主视图 attach 独立会话 → 名牌 `tmux:tspwt-m1` → 改名 → 名牌 `tmux:tspwt-main` 且 `tmux_attached` 不被误清；格子不受主视图改名影响。收尾 tspwt- 全杀、库副本删除、真实主库 sha256 前后一致（`253a197380…`；-shm/-wal 差异来自用户实例自身活动，隔离实例全程用副本）。
- 真机走查本身揪出并当场修掉 2 个产品 bug（纯主视图改名不跟随、名牌滞后于 attach），不是脚本问题。

## 三·五、三路 subagent 审查（用户点名「认真审核」，2026-11-03 当日）

**A 路 Rust / B 路前端 / C 路跨层契约+文档** 并行只读深审全部未提交改动。共产出 **P1×3、P2×10、P3×1**，逐条亲核：P1×3 全部采纳修复（变异红验证），P2 修 8 立案 2，P3 修 1。

**A 路 P1（Rust，均修 + 变异红 + 单测钉）**
1. **连环改名清单错绑**：格子 P1(a,$1)、P2(b,$2)，远端 b→c 且 a→b 同轮——逐条 `find(旧名)` 会把后处理格子命中先处理格子刚写入的清单条目，错绑后关格误删别人的项 → 死后不重建、格子静默丢失。修=改名对先收集、清单**二段式**替换（每条目至多消费一个改名对，顺序无关）；8 轮新 handle 覆盖 HashMap 两种顺序。
2. **tmux 服务器重启 id 重排错绑**：id 只在服务器一生内唯一，重启后从 $0 重排——旧 id 会**成功**解析成新纪元的别的会话（回落按名永不触发），重建绑错对象、清单被改写。修=探针/resolve 加服务器 pid（`TmuxSession.server_pid` + `TmuxPane.born_server_pid` + `tmux_attached_server_pid` 三处落账），消费 id 前比 pid，跨纪元回落按名/不动/清记录。**坑 97**：tmux format 的服务器 pid 变量是 `#{pid}`，**没有 `#{server_pid}`**——想当然的变量名在真机输出空串（未知变量输出空）、纪元闸静默失效（0=未知不拦，安全但零保护）；真机探针看到 `server_pid: 0` 顺藤摸瓜实证 `#{pid}`=4071322 后定稿。format 变量名必须实证，不能按语义猜。
**A 路 P2**：③开格/attach 防呆补 id 交叉查（名字差在「改名到下一次探针之间」可穿过两路视图防呆——panes 按 sid 查活格）；④attach 失败回滚临界区化（三字段同临界区恢复 + id/pid 双身份守卫，防并发第二次 attach 的预占被旧值覆盖）；⑤mock 支持 id 表（跳号/空段/怪形状）+ server_pid，补形状闸用例。

**B 路 P1（前端，修）**
6. **renameTileKey 撞 stale 键 → 布局树重复键永久繁殖**：同快照「B 格结束 + A 改名成 B」→ 树里 stale B 叶与新 B 叶并存，syncLayout 只摘 want 外的键（两个 B 都在 want）永不去重，审查员以真实模块实证三连跑翻倍。修=改名前 `treeHasKey` 查新名 stale 叶先 `removeTile`（摘空=树作废回自动平铺）；helper 进 pane-grid.mjs + d.mts + spec 0b 语义断言。**立案**：接线本身（改名分支摘 stale）无端到端自动化——demo 造不出「会话死+改名」同快照，helper 语义已钉，组合逻辑靠审查员实证+代码 review。
**B 路 P2**：⑦`tmuxProbeFollowTimers` 末发后清表（关会话后不再空开枪）；⑧`takeTmuxPrefixKey` 一次性消费不看目标（武装后改在别处打字=已离开，残留武装会迟到还原回原目标的第一键）；⑨demo renaming 补 Esc 取消。
**C 路 P2**：⑩demo 改名提示符**预填旧名**（真 tmux 同款，光标在尾——spec 同步改退格清行=真机用户路径，一次性断言改行尾 ￥）；⑪demo 重名拒绝（duplicate session，spec 加断言钉）；⑫spec 防呆标题改「demo 以原子改名等价模拟 id 对账」（不夸大机制）；⑬台账 +7 明细更正（D3 净增一次性×1＋D4 改名跟随×6）；⑭wire.ts `id`/`server_pid` 可选化（旧 core 组合 undefined，前端本就不消费）；P3 改回段 pollAsync 包断言。

**立案未修**：⑮attach 防呆的名字查在 id 缺失（极老 tmux）时无兜底交叉——退化按名是既定语义，记录在案；⑯真 fish/极老 tmux（<1.6 无 session_id）真机未实测，退化路径由单测与形状闸覆盖。

## 四、立案 / 观察

1. `tmux_attach` 对不存在的会话「发送成功即记录」——直调 API 挂错名字会留下附着记录（探针下一轮按 id/名都找不到会清掉，GUI 路径[快接菜单/⌘K]只列活会话打不到）；可在 attach 前做一次 resolve 核验，立案待拍板。
2. C-b $ 补探针是时刻表猜提交（2.5/7/20s）；用户改名后停顿超 20s 才回车则要等下一次 3s 轮询自然刷新（探针每 3s 本就跑，最终一致，只是标题即时性折扣）。
3. tmux 改名提示符预填旧名（光标在尾）——用户直接打字=追加；demo 已同款保真（审查轮③⑩⑪），这是 tmux 原生行为，只记录不代劳。

## 教训

1. **exec 通道验证别信交互壳**：`tmux ls -t` 在交互壳里「RC=0」是回显行被当输出的假证据（echo 的 $? 是上一条 echo 的）；独立通道实测 + stderr 原文才是证据（真机 `unknown flag -t` 一锤定音）。对照组的量法先验证量法本身（坑/教训同上轮「对照组先跑」同族）。
2. **坑 95（新）**：变异回滚绝不能 `git checkout --`——工作区是未提交多轮叠加区，checkout 把 handle.rs 当日全部改动（含此前审查修复批）连变异一起炸掉；靠幸存的 pane_tests（钉着批内每个行为）+ 会话里读过的原文 + 编译器当裁判重建了 handle.rs/lib.rs。**多行批量替换走 Write 落盘的 .cjs 补丁（CRLF 自适应），回滚=逆向补丁，大改前先留 stash 快照。**
3. **tmux 交互提示符的自动化**：改名提示符预填旧名；清行不能用 C-a/C-k（C-k 被应用捕获层截走开 ⌘K 面板——快捷键 inventory 里没有「 reserve 给 tmux 提示符」的概念），退格 ×40 是无冲突清法。
4. **主视图与格子是两个世界**：核心 reconcile 只遍历格子时，纯主视图 attach 是「链外」状态；对账面必须显式覆盖每个状态载体（格子表/清单/attach 记录），漏一个就漏一类场景（单测按场景写，不按函数写）。
