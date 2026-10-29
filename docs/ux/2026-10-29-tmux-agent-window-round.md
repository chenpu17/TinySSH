# tmux 联动二：Agent 分窗（2026-10-29）

## 一句话

会话 attach 进 tmux 后，agent 的命令自动落进远端**专属窗口 `tinyssh-agent`** 执行——
用户随时切过去旁观，当前窗口零污染，断线命令不死（tmux 服务端托管）。无设置项。

## 痛点与定位

恢复现场轮（R1）落地后，用户 attach 在 tmux 里：登录 shell 已被 tmux client 取代，
OSC 133 不再回流 → agent 的 Shell 模式 exec **必然**报 ShellIntegrationUnavailable，
模型只能退 Fresh（独立通道，完全不可见）。用户看不见 agent 在干什么，也不能旁观。

本轮补的就是这个洞：attach 的世界里 agent 执行从「不可见」变「可旁观」。

## 实现

### 后端（core-session）

- **分流**（handle.rs `exec_inner`）：`ExecMode::Shell` + ssh 会话 + `tmux_attached`
  非空 → `run_tmux_window`（原先这条路是死路：run_shell 的集成等待必然超时拒绝）。
  未 attach 的世界一行行为不变。
- **执行基座**（`run_tmux_window`）：
  - 建窗：`tmux kill-window -t '=sess:tinyssh-agent' 2>/dev/null; tmux new-window -d
    -t '=sess' -n tinyssh-agent 'sh -c …'`。`-d` 不切换用户视角（零打扰的核心）；
    先 kill 同名陈尸窗（崩溃遗留；exec_slot 串行保证不会误杀在跑的窗口）。
  - 包裹：`{ <cmd> 2>&1; echo "$?" > <rc>.tmp; } | tee <out>; mv <rc>.tmp <rc>`——
    ①`2>&1` 合流（窗口里看全量）；②`tee` 落盘副本供收割、窗格实时可见（旁观价值）；
    ③rc 经 .tmp 写、`mv` 在 tee 退出**之后**发生——`mv` 的原子出现即「输出已完整」
    的完成信号，无竞态窗口。
  - 轮询 400ms `test -f <rc>`；超时/cancel 都 `kill-window` 真终止再如实报错
    （超时谎报「已停」是 run_shell 明令禁止的）。
  - 收割：`printf 'RC='; cat <rc>; printf '\nOUT\n'; cat <out>; rm -f …`——协议头
    `RC=<i32>\nOUT\n` 保证输出任意字节（无尾换行/含同形分隔串）都不粘连
    （`split_once` 取首个分隔，rc 行只能是数字）。
  - 引号：`sh_single_quote` 单引号三段式（`'\''`），命令串穿过远端登录 shell +
    tmux 自身 `/bin/sh -c` 两层解析，`$`/反引号/双引号/换行原样保真。
  - **不镜像回放屏幕**：旁观靠 tmux 窗口本身，往用户当前窗口回放反而是污染
    （设计使然，非遗漏）。记录/审计照常（record_action 包全路径）。
  - 建窗失败（tmux 亡/attach 会话没了）→ 如实回到联动前语义
    `ShellIntegrationUnavailable`（工具表指引模型改走 fresh）。
- **read_screen 质变**（lib.rs trait impl）：attach 的会话 PTY 画面是 tmux client
  全屏 UI（状态栏/框线），对模型是噪音——改走 `capture-pane -p -t '=sess'` 抓
  attach 会话**当前窗格**净文本（用户此刻看到的现场去掉 tmux 铬件）；通道失败退回
  PTY 画面，不劣于联动前。
- **审批诚实**（`wait_approval` 加 `scene_note` 参数）：tmux 专窗执行卡面追加
  「【tmux：命令将进远端专属窗口（tinyssh-agent）执行，不延续当前终端现场】」
  （与 Fresh 的 C3 契约标注同款原则）。
- **契约**：`SessionInfo.tmux_attached: Option<String>`（serde default，attach 的
  tmux 会话名），list_sessions 随 tmux 一起下发。
- agent-host exec 工具描述补一句分窗语义（模型可见面）。

### 前端

- agent 面板一行小字提示（`agent-tmux-hint`，composer 上缘）：活动会话已 attach
  才显示；fleet 编排者不显示（跨主机不落专窗）。文案：「Agent 的命令会自动进远端
  专属 tmux 窗口（tinyssh-agent）执行——切过去即可旁观，当前窗口不受打扰。」
  EN 同步（i18n）。无设置项、无面板。
- demo 全镜像：`DemoSession.tmux_attached` 本就有（tmux_attach 写），list_sessions
  补下发。

### 纯函数单测（handle::tests）

- `sh_single_quote_is_layer_opaque`：$ / 反引号 / 嵌入单引号 / 空串。
- `tmux_window_shell_orders_rc_after_tee`：rc 的 mv 必须在 tee 之后（保序断言）。
- `split_tmux_exec_out_survives_hostile_output`：无尾换行 / 同形分隔串 / 负退出码 /
  垃圾文本。

### spec 62（10 断言）

SessionInfo.tmux_attached 下发、提示行随活动会话显隐、fleet 不显示、zh↔en 即时切换。
坑：步 0 必须清 `ui.agentbar` 等面板互斥持久键——上轮崩溃残留 `=1` 会让 reload 后
agent 面板自动开、rail 点击语义反转（toggle 成关闭）；关 agent 后主机栏不会自动
回来，要点 `rail-hosts`（四向互斥既有语义）。

## 验证

- `cargo test --workspace --exclude tinyssh-app` 全绿（本机 debug 剖面编
  tinyssh-app 必崩 0xc0000409，口径沿 CI tier1）。
- `cargo fmt --all` 清账；tsc 零错；vite build 绿。
- UI 全套含 spec 62 全绿。

## 边界与如实记录

- 真实远端 tmux 的实链路（建窗/tee/mv/kill-window/switch 时机）spec 62 只到 demo
  镜像层，真机走查待做（同 R1 attach/capture-pane）。
- agent 窗口用完即关（tmux 命令窗默认行为）：旁观窗口在命令结束时消失——
  keep-alive 窗（remain-on-exit）留观察后再说。
- Fresh 模式不受影响（显式语义不动）；send_keys/read_blocks/wait_output 语义不变
  （仍作用于 PTY 环——attach 会话上 agent 的输出通道是 ExecResult 本身）。
- Windows 远端：tmux 不存在 → available=false → 分流永不激活，零影响。
- 下一支柱（已规划）：tmux -CC 控制模式原生集成，远期独立 spike。

## 真机走查（同日补账，R1+R2 一起验，腾讯-广州 root@193.112.219.133 / tmux 3.4 / Ubuntu）

release 构建（custom-protocol）+ `TINYSSH_WEBVIEW_ARGS=--remote-debugging-port` CDP
驱动真 app，`exec_human`/`send_keys`/`tmux_probe`/`tmux_restore`/`tmux_attach`/
`read_screen` 全实链路。**走查先揪出三个真 bug（demo 镜像层全测不出），修完重走全绿**：

1. **坑 80（探针分隔符）**：tmux format **不展开 `\t`**——`tmux ls -F '…\t…'` 吐的是
   字面反斜杠 t（`cat -A` 可证），R1 探针按真 tab 分列 → 真实主机 `sessions:[]` 恒空。
   R1 单测喂的是真 tab = mock 假流假绿（坑 74 同类再现）。修：分隔符改 `|`
   （tmux 会话名只禁 `:` 与 `.`），解析同步，测试加「字面 `\t` 行不得解析」回归钉。
2. **坑 81（capture-pane 目标类别）**：tmux 目标解析按命令类别分家——attach/
   new-window 的 `=name`（session 类）一直没事，capture-pane 是 **pane 类**目标，
   `=name` 被当 pane 名直查必报 `can't find pane`。R1 补史与 R2 read_screen 同中。
   修：目标写 `=name:`（尾冒号 = 精确会话+当前窗格），真机逐一验证五种写法定案。
3. **read_screen 退出码**：capture 失败（exit 1 + 空 stdout）原样当空画面返回，
   不落 PTY 兜底——加 `Some(0)` 守卫。
4. **构建口径教训**：本地验证 exclude tinyssh-app（debug rustc 必崩）意味着
   src-tauri 的编译错误只有 release 构建能抓到——R1 落下的 `tmux_restore`
   E0308（`as_deref()` 传 `Option<&str>` 给 `Option<String>` 形参）在 workspace
   全绿下潜伏两天，首次 release 构建即炸。修掉；发版前 release 构建本就是必做步骤，
   这次证明它也是唯一的 app 编译门。

修复后走查 v2 全绿：probe 探到 `{walkthrough,1,0}`；restore 计划 target+补史
45 字节；attach 后 `tmux_attached="walkthrough"`；R2 专窗执行 ×3（输出/退出码回传、
无尾换行 RC=/OUT 协议、`cd /etc && pwd` 远端 shell 语义）；read_screen 抓到刚敲的
标记、无 tmux 铬件。清理：detach → kill-session，远端 `tmux ls` = no server running。
**如实注记**：清理脚本多写了 `tmux kill-server`（原则过宽，可能误杀同机其他 tmux
会话）——走查全程探针只见 walkthrough 一个会话、事后 `tmux ls` 无服务器在跑，
确认零误杀；此类清理以后只应 kill 自己的会话。断线横幅的「真实网络断开」触发
无法在用户真机上安全模拟（该腿仍由 spec 61 demo 覆盖）；「断开后 tmux 服务器
存活」已实证（close_session 重连后 `tmux ls` 会话健在）。
